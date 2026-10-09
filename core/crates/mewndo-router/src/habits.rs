// R11: habits (spec §34.7, §34.9 R11). Mewndo counts identical answers per agent, project and normalized
// action, and after three it offers to stop asking.
//
// This is the only learning about the user that Mewndo does by default, and it stays on the device (§34.7).
// Which is why it is a plain counter and nothing more: no weights, no decay, no model. Three identical
// answers, one card, the user's own words on it, and a rule they can see and delete.
//
// ponytail: DEFERRED -- §34.9 R11's second half. Accepting a habit should append the action to `[allow]` or
// `[deny]` in `%APPDATA%\Mewndo\rules.toml` with `toml_edit`, keeping the user's formatting and adding a
// `# habit <date>` comment. `accept` below holds the rule in memory instead, so a habit survives the session
// but not a restart, and `Settings → Habits` has nothing to list yet. The reason it is deferred and not
// faked: `toml_edit` is a second TOML parser to add to the workspace, and a half-written rules.toml is worse
// than no habit at all -- the write needs the core's temp-file-then-rename path (plot.md rule 4), which this
// crate cannot reach. `pending()` exposes what would be written.

use crate::Verdict;
use crate::sig::{Sig, hex};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// §34.7: three.
pub const THRESHOLD: u32 = 3;

/// One counted answer: agent kind, project, normalized action, answer.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HabitKey {
    pub agent_kind: String,
    pub project: String,
    pub sig: Sig,
    pub answer: Verdict,
}

impl std::hash::Hash for Verdict {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        (*self as u8).hash(state);
    }
}

/// The card §34.7 describes: "Always allow `npm test` in shop?" with 1 yes · 2 no · 3 never ask.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HabitRequest {
    pub text: String,
    pub options: [String; 3],
    pub agent_kind: String,
    pub project: String,
    pub sig: Sig,
    pub answer: Verdict,
    /// The command as the user will read it on the card, and as it would be written into `rules.toml`.
    pub command_norm: String,
}

/// The counts and the accepted rules. Owned by the core; one per device.
#[derive(Debug, Clone, Default)]
pub struct Habits {
    counts: HashMap<HabitKey, u32>,
    rules: HashMap<(String, String, Sig), Verdict>,
    /// What would have been appended to the user's rules.toml, until the write lands.
    pending: Vec<HabitRequest>,
    /// Actions the user said "never ask" about, so the card is not offered again.
    muted: Vec<(String, String, Sig)>,
}

impl Habits {
    /// Count one answer. Returns the card to show when this is the third identical answer, and only then --
    /// at four the user has already been asked and said no, and asking again is nagging.
    ///
    /// `answer` is the *user's* answer, not a verdict Mewndo reached on its own: a habit is learned from the
    /// Inbox, not from the rules (§34.7). The caller passes `Verdict::Allow` when the user approved and
    /// `Verdict::Deny` when they refused.
    pub fn record(
        &mut self,
        agent_kind: &str,
        project: &str,
        sig: Sig,
        answer: Verdict,
        command_norm: &str,
    ) -> Option<HabitRequest> {
        let key = HabitKey {
            agent_kind: agent_kind.to_string(),
            project: project.to_string(),
            sig,
            answer,
        };
        let count = self.counts.entry(key).or_insert(0);
        *count += 1;
        if *count != THRESHOLD {
            return None;
        }
        let rule_key = (agent_kind.to_string(), project.to_string(), sig);
        if self.muted.contains(&rule_key) || self.rules.contains_key(&rule_key) {
            return None;
        }
        let verb = if answer.allows() { "allow" } else { "deny" };
        let what = if command_norm.is_empty() {
            hex(&sig)
        } else {
            command_norm.to_string()
        };
        Some(HabitRequest {
            text: format!("Always {verb} `{what}` in {project}?"),
            options: ["yes".into(), "no".into(), "never ask".into()],
            agent_kind: agent_kind.to_string(),
            project: project.to_string(),
            sig,
            answer,
            command_norm: what,
        })
    }

    /// The user pressed yes. The rule applies from now on and is what `decide`'s `habits` argument carries.
    pub fn accept(&mut self, request: &HabitRequest) {
        self.rules.insert(
            (request.agent_kind.clone(), request.project.clone(), request.sig),
            request.answer,
        );
        self.pending.push(request.clone());
    }

    /// The user pressed "never ask": no rule, and no card for this action again.
    pub fn mute(&mut self, request: &HabitRequest) {
        self.muted.push((
            request.agent_kind.clone(),
            request.project.clone(),
            request.sig,
        ));
    }

    /// The standing answer for this action, for `decide(.., habits)`.
    pub fn rule_for(&self, agent_kind: &str, project: &str, sig: &Sig) -> Option<Verdict> {
        self.rules
            .get(&(agent_kind.to_string(), project.to_string(), *sig))
            .copied()
    }

    /// Accepted habits that still have to reach the user's rules.toml. Settings → Habits will list these
    /// once the write lands; until then it is the honest answer to "what has Mewndo learned?".
    pub fn pending(&self) -> &[HabitRequest] {
        &self.pending
    }

    pub fn count(&self, agent_kind: &str, project: &str, sig: Sig, answer: Verdict) -> u32 {
        self.counts
            .get(&HabitKey {
                agent_kind: agent_kind.to_string(),
                project: project.to_string(),
                sig,
                answer,
            })
            .copied()
            .unwrap_or(0)
    }
}
