// R5: the rules pass (spec §34.9 R5). Everything the machine can settle by itself, settled; everything it
// cannot, written down as facts for the model's `state` (§34.3).
//
// The split matters. The rules pass is the only thing that runs when the router is off, when the deadline
// passes, when the gateway is down and when the agent is in shadow mode -- which is every agent, to begin
// with (§34.6). So the hard rules here are not a pre-filter for the model: they are the product, and the
// model is the part that is allowed to be missing.
//
// Facts that need the journal or the span table are *not* this crate's job: they need SQLite, a connection
// and a 10-second cache, all of which live in the core (§38.1). They arrive through the [`Facts`] trait.

use crate::Verdict;
use crate::normalize::{Action, Kind, inside};
use crate::rules::CompiledRules;
use crate::scope::Scope;
use crate::sig::Sig;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The §34.3 `facts` block, with the field names the gateway and the prompt already use. Nothing else goes
/// in: the state stays under 800 tokens and holds paths, commands and names, never file contents.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ActionFacts {
    pub paths_outside_brief: Vec<String>,
    pub in_journal: bool,
    pub same_action_failed_recently: u32,
    /// §34.4 row 2's other half. Not sent to the model -- it is about the session, not the action -- but it
    /// is a fact the verdict function needs, so it rides here rather than in a second struct.
    #[serde(skip_serializing_if = "is_zero")]
    pub recent_denies: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// What the router needs to know that only the journal and the span table can answer (§34.9 R5).
///
/// It is a trait because this crate must not open a database: the core owns `desk.db`, the writer task and
/// the 10-second cache in front of `in_journal`. A fake implementation lives below so the tests can set any
/// history they like without a file on disk.
pub trait Facts {
    /// Has this exact action been seen before in this project's journal? A first-time action is the one
    /// worth asking about.
    fn in_journal(&self, sig: &Sig) -> bool;
    /// How many times the same signature failed in the last 5 minutes with the same output hash. Non-zero
    /// is the loop brake in §34.4 row 4.
    fn same_action_failed_recently(&self, sig: &Sig) -> u32;
    /// Denies in this session in the last 2 minutes (§34.4 row 2).
    fn recent_denies(&self) -> u32;
    /// Hosts and recipient domains this project has used before. A new one is worth a question (§34.2); one
    /// that merely *looks* like one of these is worth a stop (§34.4 row 1).
    fn known_hosts(&self) -> Vec<String> {
        Vec::new()
    }
}

/// A [`Facts`] with nothing in it: a brand new project, no journal, no history. Also the honest answer when
/// the core cannot reach its database -- no history is better than invented history.
#[derive(Debug, Clone, Default)]
pub struct NoFacts;

impl Facts for NoFacts {
    fn in_journal(&self, _sig: &Sig) -> bool {
        false
    }
    fn same_action_failed_recently(&self, _sig: &Sig) -> u32 {
        0
    }
    fn recent_denies(&self) -> u32 {
        0
    }
}

/// The test double. Public because the integration tests in `tests/` need it and because it documents, in
/// code, exactly what the core has to provide.
#[derive(Debug, Clone, Default)]
pub struct FakeFacts {
    pub journal: Vec<Sig>,
    pub failures: HashMap<Sig, u32>,
    pub denies: u32,
    pub hosts: Vec<String>,
}

impl Facts for FakeFacts {
    fn in_journal(&self, sig: &Sig) -> bool {
        self.journal.contains(sig)
    }
    fn same_action_failed_recently(&self, sig: &Sig) -> u32 {
        self.failures.get(sig).copied().unwrap_or(0)
    }
    fn recent_denies(&self) -> u32 {
        self.denies
    }
    fn known_hosts(&self) -> Vec<String> {
        self.hosts.clone()
    }
}

/// What the rules alone concluded. `decided: None` means "nothing here is certain; ask the model, then the
/// user". It is never "allow".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuleOutcome {
    pub decided: Option<Verdict>,
    /// Which rule fired, for the decisions table and for the test assertions: `deny_list`, `protected_path`,
    /// `outside_brief`, `look_alike_recipient`, `ask_list`, `private_window`, `always_ask_name`,
    /// `allow_list`, or empty.
    pub rule: String,
    /// Written for the agent to read (§34.9 R8).
    pub reason: String,
    pub facts: ActionFacts,
    /// Hard to undo without a save point, as far as the rules can tell. This is what makes the no-model
    /// fallback "ask" rather than "allow" (§34.8).
    pub destructive: bool,
}

impl RuleOutcome {
    /// A hard rule in the §34.4 row 1 sense: one that stops or pauses the action and is not up for
    /// discussion. An allow-list hit is a decision too, but it is not a *hard* rule -- it must still lose to
    /// the brake.
    pub fn hard(&self) -> bool {
        matches!(self.decided, Some(Verdict::Deny) | Some(Verdict::Ask) | Some(Verdict::Brake))
    }
}

/// §34.9 R5. Applies the rule rows of §34.4 in order and collects the facts for the model.
///
/// Order inside the hard rules, strictest first, so the reason the agent reads is the most serious one:
///   1. the deny list            a disk format is never a question
///   2. protected paths          .env, *.pem, the v0 protected folders, in either direction
///   3. outside the brief        a write, delete or move the brief does not cover
///   4. look-alike recipient     an address one character away from one this project has used
///   5. the ask list             force-push, hard reset, publish, curl | sh
///   6. computer use             a private window, or a control named Send / Pay / Delete
///   7. the allow list           git status and friends: decided, no model call
pub fn rules_pass(
    rules: &CompiledRules,
    action: &Action,
    scope: &Scope,
    facts: &dyn Facts,
    sig: &Sig,
) -> RuleOutcome {
    let outside: Vec<String> = action
        .paths
        .iter()
        .filter(|p| scope.outside(p))
        .cloned()
        .collect();
    let out = RuleOutcome {
        facts: ActionFacts {
            paths_outside_brief: outside.clone(),
            in_journal: facts.in_journal(sig),
            same_action_failed_recently: facts.same_action_failed_recently(sig),
            recent_denies: facts.recent_denies(),
        },
        destructive: action.kind.destructive(),
        ..RuleOutcome::default()
    };

    if let Some(phrase) = rules.deny_hit(&action.command_norm) {
        return out.decide(
            Verdict::Deny,
            "deny_list",
            format!(
                "Mewndo: `{phrase}` is on the never list -- it destroys data that no save point can bring \
                 back. This will not run. Tell the user what you were trying to do."
            ),
        );
    }
    if let Some(path) = action.paths.iter().find(|p| rules.protected(p).is_some()) {
        return out.decide(
            Verdict::Deny,
            "protected_path",
            format!(
                "Mewndo: {path} is a protected file. Agents never read or change secrets or the user's \
                 protected folders. Ask the user to do it, or to give you only what the task needs."
            ),
        );
    }
    // A read that stays inside the brief is not the router's business (§34.2: "It never runs for reads"),
    // but a *write* outside it is the §34.3 example and the reason the brief exists.
    if !outside.is_empty() && matches!(action.kind, Kind::Write | Kind::Delete | Kind::Move) {
        let where_ = short_name(&outside[0], scope);
        return out.decide(
            Verdict::Deny,
            "outside_brief",
            format!("Mewndo: {where_} is outside your brief. Ask the user if this is needed."),
        );
    }
    if let Some((bad, like)) = look_alike(&action.recipients, &facts.known_hosts()) {
        return out.decide(
            Verdict::Ask,
            "look_alike_recipient",
            format!(
                "Mewndo: {bad} is one character away from {like}, which this project does use. The user has \
                 to confirm this address before anything is sent."
            ),
        );
    }
    if let Some(phrase) = rules.ask_hit(&action.command_norm) {
        return out.decide(
            Verdict::Ask,
            "ask_list",
            format!("Mewndo: `{phrase}` can destroy work git cannot bring back. Waiting for the user."),
        );
    }
    if action.kind == Kind::Computer {
        if let Some(window) = rules.private_window(&action.command_norm) {
            return out.decide(
                Verdict::Deny,
                "private_window",
                format!(
                    "Mewndo: that window looks like {window}. Mewndo never clicks in banking, password or \
                     Mewndo windows. Ask the user to do this themselves."
                ),
            );
        }
        if let Some(name) = rules.always_ask_name(&action.command_norm) {
            return out.decide(
                Verdict::Ask,
                "always_ask_name",
                format!("Mewndo: \"{name}\" always needs the user. Waiting for an answer."),
            );
        }
    }
    if let Some(phrase) = rules.allow_hit(&action.command_norm) {
        return out.decide(
            Verdict::Allow,
            "allow_list",
            format!("`{phrase}` is on the allow list."),
        );
    }
    out
}

impl RuleOutcome {
    fn decide(mut self, verdict: Verdict, rule: &str, reason: String) -> RuleOutcome {
        self.decided = Some(verdict);
        self.rule = rule.to_string();
        self.reason = reason;
        self
    }
}

/// `db/migrations` rather than `c:/work/shop/db/migrations`: the agent reads this, and the §34.4 example
/// reason says "db/".
fn short_name(path: &str, scope: &Scope) -> String {
    for root in scope.allowed.iter().chain(&scope.forbidden) {
        if let Some(rel) = path.strip_prefix(root).map(|r| r.trim_start_matches('/'))
            && !rel.is_empty()
        {
            return rel.to_string();
        }
        if inside(path, root) {
            return path.to_string();
        }
    }
    path.to_string()
}

/// A recipient domain one or two edits away from a domain the project already uses, but not equal to it:
/// `shop-pay.cam` next to `shop-pay.com` (§34.4 row 1, "look-alike recipient domain").
///
/// Honest limits (§28.10): it only knows domains this project has sent to before, so the very first mail to
/// a new partner is not protected by it, and a well-chosen different name (`shop-billing.com`) is not a
/// look-alike at all. It catches the typo-squat, which is the attack that actually happens.
fn look_alike(recipients: &[String], known: &[String]) -> Option<(String, String)> {
    let domains: Vec<&str> = known
        .iter()
        .filter_map(|h| h.rsplit('@').next())
        .filter(|h| h.contains('.'))
        .collect();
    for r in recipients {
        let Some(domain) = r.rsplit('@').next().filter(|d| d.contains('.')) else {
            continue;
        };
        if domains.contains(&domain) {
            continue;
        }
        for k in &domains {
            // Short domains are too easy to be "one edit" from each other by accident.
            if domain.len() >= 5 && edit_distance_at_most(domain, k, 2) {
                return Some((r.clone(), (*k).to_string()));
            }
        }
    }
    None
}

/// True when `a` and `b` are at most `max` single-character edits apart. Bounded on purpose: it returns
/// early rather than filling a full table, because this runs on the hook path.
fn edit_distance_at_most(a: &str, b: &str, max: usize) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        let mut best = cur[0];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
            best = best.min(cur[j + 1]);
        }
        if best > max {
            return false;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()] <= max && prev[b.len()] > 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize;
    use serde_json::json;
    use std::path::Path;

    fn cwd() -> &'static Path {
        Path::new("C:/work/shop")
    }

    fn pass(command: &str, brief: &str, facts: &dyn Facts) -> RuleOutcome {
        let action = normalize("claude-code", "Bash", &json!({"command": command}), cwd());
        let scope = Scope::from_brief(brief, cwd());
        let sig = action.signature("claude-code");
        rules_pass(&CompiledRules::builtin(), &action, &scope, facts, &sig)
    }

    #[test]
    fn the_spec_example_denies_a_delete_outside_the_brief() {
        let out = pass(
            "rm -rf db/migrations",
            "Fix the failing date tests in api/. Don't touch the db folder.",
            &NoFacts,
        );
        assert_eq!(out.decided, Some(Verdict::Deny));
        assert_eq!(out.rule, "outside_brief");
        assert_eq!(out.reason, "Mewndo: db/migrations is outside your brief. Ask the user if this is needed.");
        assert_eq!(out.facts.paths_outside_brief, vec!["c:/work/shop/db/migrations".to_string()]);
    }

    #[test]
    fn hard_rules_fire_in_order() {
        assert_eq!(pass("format c:", "", &NoFacts).rule, "deny_list");
        assert_eq!(pass("cat .env", "", &NoFacts).rule, "protected_path");
        assert_eq!(pass("git push --force", "", &NoFacts).rule, "ask_list");
        assert_eq!(pass("git status", "", &NoFacts).rule, "allow_list");
        assert_eq!(pass("npm run build", "", &NoFacts).decided, None, "rules do not know");
    }

    #[test]
    fn a_look_alike_recipient_needs_the_user() {
        let facts = FakeFacts { hosts: vec!["shop-pay.com".into()], ..FakeFacts::default() };
        let action = normalize(
            "claude-code",
            "mcp__gmail__send",
            &json!({"to": "billing@shop-pay.cam", "subject": "invoice"}),
            cwd(),
        );
        let sig = action.signature("claude-code");
        let out = rules_pass(&CompiledRules::builtin(), &action, &Scope::cwd(cwd()), &facts, &sig);
        assert_eq!((out.decided, out.rule.as_str()), (Some(Verdict::Ask), "look_alike_recipient"));
        // The address the project really uses is not a look-alike of itself.
        let good = normalize(
            "claude-code",
            "mcp__gmail__send",
            &json!({"to": "billing@shop-pay.com"}),
            cwd(),
        );
        let out = rules_pass(&CompiledRules::builtin(), &good, &Scope::cwd(cwd()), &facts, &good.signature("c"));
        assert_eq!(out.decided, None);
    }
}
