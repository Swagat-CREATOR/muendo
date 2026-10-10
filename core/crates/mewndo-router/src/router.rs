// The Router itself: the thing the agent handlers call (spec §34.9, "Where it plugs into Mewndo").
//
//   PreToolUse, Cursor before*, the computer-use proxy  ->  router.guard(..)
//   PermissionRequest and Notification                  ->  router.triage(..)
//   the talk box                                        ->  router.route(..)
//   the Inbox                                           ->  router.habits.record(..)
//
// The order inside `guard` is the §34.9 "Speed rules", in the order they are written there: rules before the
// model, cache before the network, one call per action with every question batched.
//
//   1. normalize and sign the action                  microseconds
//   2. the rules pass                                 microseconds, and often the whole answer
//   3. the cache                                      a hash lookup; 5 minutes (§34.8)
//   4. the kill switch                                an atomic read, before any model call (R10)
//   5. one Clef call with all five questions          deadline 300 ms (§34.8)
//   6. decide()                                       pure (R8)
//
// Steps 5 and 6 are the only ones that can be skipped, and skipping them never turns an ask into an allow.

use crate::answers::{Answers, guard_questions};
use crate::cache::TtlCache;
use crate::clef::{Clef, ClefError, ClefRequest, NoClef, State};
use crate::decide::{Decision, decide};
use crate::facts::{Facts, NoFacts, RuleOutcome, rules_pass};
use crate::habits::Habits;
use crate::normalize::{Action, normalize};
use crate::rules::CompiledRules;
use crate::scope::Scope;
use crate::sig::{Sig, cache_key, hex, text_hash};
use crate::voice::{LiveAgent, RouteResult};
use crate::{Backend, CallKind, Mode, Verdict};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Everything one guard call needs to know, from the hook and from v0's settings and brief helper.
#[derive(Debug, Clone, Default)]
pub struct GuardInput {
    pub agent_kind: String,
    pub tool: String,
    pub input: Value,
    pub cwd: PathBuf,
    pub brief: String,
    pub project: String,
    /// The last three things the agent did (§34.9 "Speed rules").
    pub recent: Vec<String>,
    pub mode: Mode,
}

/// A decision plus what it cost. §34.4 logs all of this in `decisions`.
#[derive(Debug, Clone, PartialEq)]
pub struct Guarded {
    pub decision: Decision,
    pub action: Action,
    pub sig: Sig,
    pub scope: Scope,
    pub rule_outcome: RuleOutcome,
    pub latency_ms: u64,
    pub deadline_met: bool,
    pub fallback_used: bool,
    /// Set when a response could not be parsed: one raw sample, kept for fixing the parser (R6).
    pub raw_sample: Option<String>,
}

pub struct Router {
    pub rules: CompiledRules,
    pub habits: Mutex<Habits>,
    cache: TtlCache<Answers>,
    /// R10. One per Router, and the app holds one Router, which is what "global" means here. Keeping it off
    /// a `static` is what lets two tests disagree about the switch at the same time without flaking.
    enabled: AtomicBool,
    clef: Box<dyn Clef + Send + Sync>,
    facts: Box<dyn Facts + Send + Sync>,
}

impl Default for Router {
    fn default() -> Router {
        Router::new(
            CompiledRules::builtin(),
            Box::new(NoClef),
            Box::new(NoFacts),
        )
    }
}

impl Router {
    pub fn new(
        rules: CompiledRules,
        clef: Box<dyn Clef + Send + Sync>,
        facts: Box<dyn Facts + Send + Sync>,
    ) -> Router {
        Router {
            rules,
            habits: Mutex::new(Habits::default()),
            cache: TtlCache::default(),
            enabled: AtomicBool::new(true),
            clef,
            facts,
        }
    }

    /// R10, the kill switch: "Router off" in the pill menu, `router off` said out loud, or Settings. Hard
    /// rules, journaling and the Inbox keep working; only model calls stop (§34.6).
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// §34.9's `router.guard(action)`.
    pub fn guard(&self, g: &GuardInput) -> Guarded {
        let started = Instant::now();
        let action = normalize(&g.agent_kind, &g.tool, &g.input, &g.cwd);
        let scope = Scope::from_brief(&g.brief, &g.cwd);
        let sig = action.signature(&g.agent_kind);
        let rule_outcome = rules_pass(&self.rules, &action, &scope, self.facts.as_ref(), &sig);
        let key = cache_key(&text_hash(&g.brief), &sig);

        let finish = |decision: Decision,
                      deadline_met: bool,
                      fallback_used: bool,
                      raw_sample: Option<String>| Guarded {
            decision,
            action: action.clone(),
            sig,
            scope: scope.clone(),
            rule_outcome: rule_outcome.clone(),
            latency_ms: started.elapsed().as_millis() as u64,
            deadline_met,
            fallback_used,
            raw_sample,
        };

        // A hard rule is the whole answer and must not be cached away or wait on a network call: it is the
        // one case where the agent gets an answer in microseconds every time.
        if rule_outcome.hard() {
            return finish(decide(&rule_outcome, None, g.mode, None), true, false, None);
        }

        let habit = self
            .habits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .rule_for(&g.agent_kind, &g.project, &sig);

        // The cache is in front of the network, so it is checked after the rules and before the switch.
        // What comes back is the model's answers, not a finished decision, so `decide` still runs with this
        // agent's current mode and this user's current habits (see cache.rs).
        let deadline = CallKind::Guard.deadline();
        let (answers, deadline_met, fallback_used, raw_sample, fresh) =
            if let Some(mut cached) = self.cache.get(&key) {
                cached.backend = Backend::Cache;
                (Some(cached), true, false, None, false)
            } else if !self.enabled() {
                // R10: checked before any model call, and before the request is even built.
                (None, true, true, None, false)
            } else {
                let request = self.guard_request(g, &action, &rule_outcome, &sig);
                match self.clef.ask(&request, deadline) {
                    Ok((backend, by_id)) => {
                        (Some(Answers::new(backend, by_id)), true, false, None, true)
                    }
                    Err(ClefError::Deadline) => (None, false, true, None, false),
                    Err(ClefError::Unavailable(_)) => (None, true, true, None, false),
                    Err(ClefError::Shape(f)) => (None, true, true, Some(f.raw_sample), false),
                }
            };

        // Only answers that cost a network call are worth keeping: a rules answer is already microseconds,
        // and caching one would hide a rules change until the TTL ran out.
        if fresh && let Some(a) = &answers {
            self.cache.put(key, a.clone());
        }
        let decision = decide(&rule_outcome, answers.as_ref(), g.mode, habit);
        finish(decision, deadline_met, fallback_used, raw_sample)
    }

    /// The §34.3 request body. The state is kept small here, not at the gateway: at most the last three
    /// actions, at most 20 paths, the command already cut at 300 characters by the normalizer.
    fn guard_request(
        &self,
        g: &GuardInput,
        action: &Action,
        rule_outcome: &RuleOutcome,
        sig: &Sig,
    ) -> ClefRequest {
        let mut paths = action.paths.clone();
        paths.truncate(20);
        let recent: Vec<String> = g.recent.iter().rev().take(3).rev().cloned().collect();
        ClefRequest {
            state: State {
                brief: g.brief.clone(),
                agent: g.agent_kind.clone(),
                cwd: g.cwd.to_string_lossy().to_string(),
                recent,
                action: json!({
                    "tool": g.tool,
                    "kind": action.kind.as_str(),
                    "command": action.command_norm,
                    "paths": paths,
                    "hosts": action.hosts,
                    "recipients": action.recipients,
                }),
                facts: serde_json::to_value(&rule_outcome.facts).unwrap_or(Value::Null),
            },
            questions: guard_questions(),
            kind: CallKind::Guard,
            sig: hex(sig),
        }
    }

    /// §34.9's `router.triage(text)`. The text is not sent anywhere by this crate -- the caller builds the
    /// request -- so this is the answer half: read the answers, or fall back to a normal card.
    pub fn triage(&self, answers: Option<&Answers>) -> crate::triage::Triage {
        crate::triage::triage(answers)
    }

    /// §34.9's `router.route(text, agents)`.
    pub fn route(
        &self,
        text: &str,
        agents: &[LiveAgent],
        answers: Option<&Answers>,
    ) -> RouteResult {
        // The router being off must not stop the talk box working; it falls back to keyword matching.
        let answers = if self.enabled() { answers } else { None };
        crate::voice::route(text, agents, answers)
    }

    /// §34.9's `router.habits.record(...)`, with the lock taken for the caller.
    pub fn record_answer(
        &self,
        agent_kind: &str,
        project: &str,
        sig: Sig,
        answer: Verdict,
        command_norm: &str,
    ) -> Option<crate::habits::HabitRequest> {
        self.habits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .record(agent_kind, project, sig, answer, command_norm)
    }

    /// For the harness that prints the median and 95th-percentile guard time (§34.9 "Done when").
    pub fn cached_answers(&self) -> usize {
        self.cache.len()
    }

    pub fn deadline(&self, kind: CallKind) -> Duration {
        kind.deadline()
    }
}
