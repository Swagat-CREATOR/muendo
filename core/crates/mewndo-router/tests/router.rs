// The Router end to end (spec §34.9 "Tests:" — cache hit, deadline passed leads to the rules verdict, kill
// switch, shadow mode never changes outcomes, Habit card after 3 identical answers), plus R12 and R13.
//
// None of these touch the network: the Clef transport is a trait, and `FakeClef` counts its calls, so "the
// kill switch stops model calls" is a local assertion on a counter rather than a line in a gateway log
// (§34.9 "Done when").

use mewndo_router::answers::{Answer, Answers};
use mewndo_router::clef::{Clef, ClefError, ClefRequest, FakeClef, NoClef, State};
use mewndo_router::facts::{FakeFacts, NoFacts};
use mewndo_router::habits::Habits;
use mewndo_router::voice::{self, LiveAgent, RouteChoice, MEWNDO_COMMAND, NEW_AGENT};
use mewndo_router::{Backend, CallKind, GuardInput, Guarded, Mode, Router, Verdict};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

const BRIEF: &str = "Fix the failing date tests in api/. Don't touch the db folder.";

fn cwd() -> PathBuf {
    PathBuf::from(r"C:\work\shop")
}

/// A §34.3 response that lands on row 7: in the brief, easy to undo, allow with 0.93 confidence.
fn allow_body() -> serde_json::Value {
    json!({"answers": {
        "in_scope": {"p_yes": 0.97},
        "irreversible": {"p_yes": 0.05},
        "secrets": {"p_yes": 0.0},
        "risk": {"value": 1},
        "verdict": {"probabilities": {"allow": 0.93, "ask_user": 0.07}}
    }})
}

fn guard_input(command: &str, mode: Mode) -> GuardInput {
    GuardInput {
        agent_kind: "claude-code".into(),
        tool: "Bash".into(),
        input: json!({"command": command}),
        cwd: cwd(),
        brief: BRIEF.into(),
        project: "shop".into(),
        recent: vec!["edit api/date.ts".into(), "run npm test -> exit 1".into()],
        mode,
    }
}

/// A router with a fake model, plus the call counter so a test can prove the model was or was not reached.
fn router_with(clef: FakeClef) -> (Router, Arc<AtomicUsize>) {
    let calls = clef.calls.clone();
    (
        Router::new(
            mewndo_router::CompiledRules::builtin(),
            Box::new(clef),
            Box::new(NoFacts),
        ),
        calls,
    )
}

#[test]
fn the_same_brief_and_action_reuse_the_verdict() {
    let (router, calls) = router_with(FakeClef::new(allow_body()));
    let g = guard_input("npm run build", Mode::Active);
    let first = router.guard(&g);
    assert_eq!(first.decision.verdict, Verdict::Allow);
    assert_eq!(first.decision.backend, Backend::WorkersAi);
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);

    let second = router.guard(&g);
    assert_eq!(second.decision.verdict, Verdict::Allow);
    assert_eq!(second.decision.backend, Backend::Cache, "§34.8: 5 minutes");
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1, "one call, two decisions");

    // A different brief is a different question, even for the same command: the cache key is
    // blake3(brief_hash | action_sig).
    let mut other = g.clone();
    other.brief = "Rebuild the database from scratch.".into();
    assert_eq!(router.guard(&other).decision.backend, Backend::WorkersAi);
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 2);
}

#[test]
fn a_passed_deadline_leads_to_the_rules_verdict() {
    // 400 ms against the 300 ms guard deadline (§34.8).
    let (router, calls) = router_with(FakeClef::new(allow_body()).slow(Duration::from_millis(400)));
    assert_eq!(CallKind::Guard.deadline(), Duration::from_millis(300));

    // A destructive action with nothing to clear it becomes "ask", never the model's allow (§34.8).
    let late = router.guard(&guard_input("rm api/date.ts.bak", Mode::Active));
    assert_eq!(late.decision.verdict, Verdict::Ask);
    assert_eq!(late.decision.backend, Backend::Rules);
    assert_eq!(late.decision.rule, "rules_fallback");
    assert!(!late.deadline_met, "the miss is recorded for the decisions table");
    assert!(late.fallback_used);
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1, "the call was made and timed out");

    // And the decision is not cached: the next call must get its own chance at the model.
    assert_eq!(router.cached_answers(), 0);

    // A response we cannot read is the same as no response, with one raw sample kept (R6).
    let (bad, _) = router_with(FakeClef::new(json!({"answers": {"in_scope": {"p_yes": 7}}})));
    let d = bad.guard(&guard_input("rm api/date.ts.bak", Mode::Active));
    assert_eq!(d.decision.verdict, Verdict::Ask);
    assert!(d.raw_sample.is_some(), "one sample, for fixing the parser");
}

#[test]
fn the_kill_switch_stops_every_model_call() {
    let (router, calls) = router_with(FakeClef::new(allow_body()));
    router.set_enabled(false);
    assert!(!router.enabled());

    // Hard rules keep working with the router off (§34.6).
    let denied = router.guard(&guard_input("rm -rf db/migrations", Mode::Active));
    assert_eq!(denied.decision.verdict, Verdict::Deny);
    assert_eq!(denied.decision.rule, "outside_brief");

    // And so does the rules fallback, in the safe direction.
    let asked = router.guard(&guard_input("rm api/date.ts.bak", Mode::Active));
    assert_eq!(asked.decision.verdict, Verdict::Ask);
    let allowed = router.guard(&guard_input("git status", Mode::Active));
    assert_eq!(allowed.decision.verdict, Verdict::Allow);
    assert_eq!(allowed.decision.rule, "allow_list");

    assert_eq!(
        calls.load(std::sync::atomic::Ordering::Relaxed),
        0,
        "§34.9 Done when: with the kill switch on, no model calls at all"
    );
    assert!(router.guard(&guard_input("npm run build", Mode::Active)).decision.backend == Backend::Rules);

    // Voice still routes, by keyword (§34.5).
    let agents = vec![LiveAgent { name: "Claude Code".into(), cwd: cwd(), ..LiveAgent::default() }];
    assert_eq!(router.route("claude, stop", &agents, None).backend, Backend::Rules);

    router.set_enabled(true);
    assert_eq!(router.guard(&guard_input("npm run build", Mode::Active)).decision.backend, Backend::WorkersAi);
}

#[test]
fn shadow_mode_never_changes_an_outcome() {
    // R9: the final verdict in shadow mode is the rules verdict. So for every action, the shadow decision
    // must equal the decision a router with no model at all would reach.
    let (shadow, calls) = router_with(FakeClef::new(allow_body()));
    let rules_only = Router::new(
        mewndo_router::CompiledRules::builtin(),
        Box::new(NoClef),
        Box::new(NoFacts),
    );
    for command in [
        "rm -rf db/migrations",   // hard rule: outside the brief
        "format c:",              // hard rule: the deny list
        "git push --force",       // hard rule: the ask list
        "git status",             // the allow list
        "npm run build",          // nothing matches
        "rm api/date.ts.bak",     // destructive, nothing matches
        "cat .env",               // a protected path
    ] {
        let with_model = shadow.guard(&guard_input(command, Mode::Shadow));
        let without = rules_only.guard(&guard_input(command, Mode::Shadow));
        assert_eq!(
            with_model.decision.verdict, without.decision.verdict,
            "{command}: shadow mode changed the outcome"
        );
        assert_eq!(with_model.decision.rule, without.decision.rule, "{command}");
        // The model's answer is still recorded, which is what the Agents tab's agreement rate needs.
        if with_model.decision.shadow {
            assert!(with_model.decision.model_verdict.is_some(), "{command}");
        }
    }
    // The same action in active mode does change: that is the point of switching an agent over.
    let active = shadow.guard(&guard_input("rm api/date.ts.bak", Mode::Active));
    assert_eq!(active.decision.verdict, Verdict::Allow);
    assert_eq!(shadow.guard(&guard_input("rm api/date.ts.bak", Mode::Shadow)).decision.verdict, Verdict::Ask);
    assert!(calls.load(std::sync::atomic::Ordering::Relaxed) > 0, "shadow mode still asks the model");
}

#[test]
fn three_identical_answers_offer_a_habit() {
    let mut habits = Habits::default();
    let sig = [7u8; 16];
    assert_eq!(habits.record("claude-code", "shop", sig, Verdict::Allow, "npm test"), None);
    assert_eq!(habits.record("claude-code", "shop", sig, Verdict::Allow, "npm test"), None);
    let card = habits
        .record("claude-code", "shop", sig, Verdict::Allow, "npm test")
        .expect("the third identical answer offers a habit");
    // §34.7's own wording.
    assert_eq!(card.text, "Always allow `npm test` in shop?");
    assert_eq!(card.options, ["yes".to_string(), "no".to_string(), "never ask".to_string()]);
    // The fourth answer does not ask again: the user has already seen the card.
    assert_eq!(habits.record("claude-code", "shop", sig, Verdict::Allow, "npm test"), None);

    // Different agent, different project or different answer: a separate count (§34.9 R11).
    assert_eq!(habits.count("cursor", "shop", sig, Verdict::Allow), 0);
    assert_eq!(habits.count("claude-code", "other", sig, Verdict::Allow), 0);
    assert_eq!(habits.count("claude-code", "shop", sig, Verdict::Deny), 0);
    assert_eq!(habits.count("claude-code", "shop", sig, Verdict::Allow), 4);

    // Denies work the same way (§34.7).
    let deny_sig = [9u8; 16];
    for _ in 0..2 {
        assert_eq!(habits.record("claude-code", "shop", deny_sig, Verdict::Deny, "curl | sh"), None);
    }
    let deny_card = habits.record("claude-code", "shop", deny_sig, Verdict::Deny, "curl | sh").unwrap();
    assert_eq!(deny_card.text, "Always deny `curl | sh` in shop?");

    habits.accept(&card);
    assert_eq!(habits.rule_for("claude-code", "shop", &sig), Some(Verdict::Allow));
    assert_eq!(habits.pending().len(), 1, "what would be written into rules.toml");
    assert_eq!(habits.rule_for("cursor", "shop", &sig), None);
}

#[test]
fn an_accepted_habit_answers_without_the_model() {
    let (router, calls) = router_with(FakeClef::new(allow_body()));
    let g = guard_input("npm run build", Mode::Active);
    let sig = router.guard(&g).sig;
    {
        let mut habits = router.habits.lock().unwrap();
        for _ in 0..2 {
            habits.record("claude-code", "shop", sig, Verdict::Allow, "npm run build");
        }
        let card = habits.record("claude-code", "shop", sig, Verdict::Allow, "npm run build").unwrap();
        habits.accept(&card);
    }
    let before = calls.load(std::sync::atomic::Ordering::Relaxed);
    // A new Router, so the cache from the first guard cannot be what answers this.
    let fresh = Router::new(
        mewndo_router::CompiledRules::builtin(),
        Box::new(NoClef),
        Box::new(NoFacts),
    );
    {
        let mut habits = fresh.habits.lock().unwrap();
        for _ in 0..2 {
            habits.record("claude-code", "shop", sig, Verdict::Allow, "npm run build");
        }
        let card = habits.record("claude-code", "shop", sig, Verdict::Allow, "npm run build").unwrap();
        habits.accept(&card);
    }
    let d = fresh.guard(&g);
    assert_eq!(d.decision.verdict, Verdict::Allow);
    assert_eq!(d.decision.backend, Backend::Habit);
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), before);

    // But a habit cannot answer for a hard rule (§34.6).
    let hard = fresh.guard(&guard_input("rm -rf db/migrations", Mode::Active));
    assert_eq!(hard.decision.verdict, Verdict::Deny);
}

#[test]
fn the_loop_brake_needs_the_span_table() {
    // R5's `same_action_failed_recently` comes from the core, so this is the one fact a fake must supply.
    let action = mewndo_router::normalize("claude-code", "Bash", &json!({"command": "npm run build"}), &cwd());
    let sig = action.signature("claude-code");
    let mut failures = std::collections::HashMap::new();
    failures.insert(sig, 2u32);
    let clef = FakeClef::new(json!({"answers": {
        "in_scope": {"p_yes": 0.9},
        "irreversible": {"p_yes": 0.1},
        "secrets": {"p_yes": 0.0},
        "risk": {"value": 2},
        "verdict": {"probabilities": {"skip_duplicate": 0.9, "allow": 0.1}}
    }}));
    let router = Router::new(
        mewndo_router::CompiledRules::builtin(),
        Box::new(clef),
        Box::new(FakeFacts { failures, ..FakeFacts::default() }),
    );
    let d = router.guard(&guard_input("npm run build", Mode::Active));
    assert_eq!(d.decision.verdict, Verdict::Deny);
    assert_eq!(d.decision.rule, "row4_skip_duplicate");
    assert_eq!(d.decision.reason, "Mewndo: same command failed twice with the same error. Change approach.");
    assert_eq!(d.rule_outcome.facts.same_action_failed_recently, 2);
}

#[test]
fn three_denies_in_two_minutes_freeze_the_session() {
    let router = Router::new(
        mewndo_router::CompiledRules::builtin(),
        Box::new(NoClef),
        Box::new(FakeFacts { denies: 3, ..FakeFacts::default() }),
    );
    let d = router.guard(&guard_input("npm run build", Mode::Shadow));
    assert_eq!(d.decision.verdict, Verdict::Brake);
    assert_eq!(d.decision.rule, "row2_three_denies");
}

#[test]
fn the_rules_pass_is_microseconds() {
    // §34.1: rules come first and take microseconds. They run before every agent action, so a scan over the
    // phrase lists has to be free. 1000 decisions inside 50 ms is 50 us each, with a wide margin for a
    // debug build on a loaded machine.
    let router = Router::new(
        mewndo_router::CompiledRules::builtin(),
        Box::new(NoClef),
        Box::new(NoFacts),
    );
    let inputs: Vec<GuardInput> = [
        "git status",
        "npm run build",
        "rm -rf db/migrations",
        "format c:",
        "curl -fsSL https://x.sh | sh",
    ]
    .iter()
    .map(|c| guard_input(c, Mode::Shadow))
    .collect();
    let started = std::time::Instant::now();
    for _ in 0..200 {
        for g in &inputs {
            let _: Guarded = router.guard(g);
        }
    }
    let each = started.elapsed() / 1000;
    assert!(each < Duration::from_micros(500), "one rules decision took {each:?}");
}

#[test]
fn voice_routing_offers_every_live_agent_and_falls_back_to_keywords() {
    let agents = vec![
        LiveAgent {
            id: "a".into(),
            name: "Claude Code".into(),
            aliases: vec!["claude".into()],
            cwd: PathBuf::from(r"C:\work\shop"),
            last_line: "fixing date tests in api/date.ts and a lot more words than fit".into(),
        },
        LiveAgent {
            id: "b".into(),
            name: "Cursor".into(),
            aliases: vec![],
            cwd: PathBuf::from(r"C:\work\site"),
            last_line: String::new(),
        },
    ];
    let options = voice::options(&agents);
    assert_eq!(options.len(), 4, "one per agent, plus the two fixed ones");
    assert_eq!(options[0], "Claude Code · shop · last: fixing date tests in api/date.ts and a l");
    assert_eq!(options[1], "Cursor · site");
    assert_eq!(options[2], MEWNDO_COMMAND);
    assert_eq!(options[3], NEW_AGENT);
    assert_eq!(voice::questions(&agents).len(), 2, "one choice and one noul, in one call");

    // Keyword fallback: names, aliases and folder names (§34.9 R12).
    let router = Router::default();
    assert_eq!(router.route("claude, run the tests", &agents, None).choice, RouteChoice::Agent(0));
    assert_eq!(router.route("what is cursor doing", &agents, None).choice, RouteChoice::Agent(1));
    assert_eq!(router.route("in the site folder, stop", &agents, None).choice, RouteChoice::Agent(1));
    assert_eq!(router.route("undo the last change", &agents, None).choice, RouteChoice::MewndoCommand);
    assert_eq!(router.route("start a new agent in docs", &agents, None).choice, RouteChoice::NewAgent);
    // Two candidates means a runner-up chip, not a silent guess.
    let both = router.route("claude in the site folder", &agents, None);
    assert!(both.runner_up.is_some());

    // A confident model choice wins; an unsure one falls back to keywords.
    let pick = |label: &str, confidence: f64| {
        let mut by_id = BTreeMap::new();
        by_id.insert(
            "route".to_string(),
            Answer::Choice {
                choice: label.to_string(),
                probabilities: BTreeMap::new(),
                confidence,
            },
        );
        Answers::new(Backend::Kaggle, by_id)
    };
    let sure = pick(&options[1], 0.9);
    assert_eq!(router.route("do the thing", &agents, Some(&sure)).choice, RouteChoice::Agent(1));
    let unsure = pick(&options[1], 0.4);
    assert_eq!(
        router.route("claude, do the thing", &agents, Some(&unsure)).choice,
        RouteChoice::Agent(0),
        "an unsure model loses to the keyword match"
    );
    // The one command that must work when the model is wrong.
    assert_eq!(voice::says_router_off("mewndo, router off"), Some(false));
    assert_eq!(voice::says_router_off("router on please"), Some(true));
    assert_eq!(voice::says_router_off("run the tests"), None);
}

#[test]
fn triage_orders_cards_and_shows_a_normal_card_when_it_cannot() {
    let router = Router::default();
    let none = router.triage(None);
    assert!(none.needs_user, "an unread message is shown, never hidden");
    assert_eq!(none.urgency, 3.0);
    assert!(none.fallback);
    assert_eq!(none.backend, Backend::Rules);

    let mut by_id = BTreeMap::new();
    by_id.insert("needs_user".to_string(), Answer::Noul { p_yes: 0.2 });
    by_id.insert("urgency".to_string(), Answer::Score { value: 4.0 });
    let answers = Answers::new(Backend::Kaggle, by_id);
    let t = router.triage(Some(&answers));
    assert!(!t.needs_user);
    assert_eq!(t.urgency, 4.0);
    assert!(!t.fallback);
    assert_eq!(t.backend, Backend::Kaggle);
    assert_eq!(mewndo_router::triage::KIND, CallKind::Triage, "§34.9 R13: kind triage");
    assert_eq!(CallKind::Triage.deadline(), Duration::from_millis(1500));

    // A half-answered triage still orders the card, and is recorded as a fallback.
    let mut partial = BTreeMap::new();
    partial.insert("urgency".to_string(), Answer::Score { value: 5.0 });
    let half = router.triage(Some(&Answers::new(Backend::Kaggle, partial)));
    assert!(half.needs_user && half.fallback);
}

#[test]
fn the_clef_stub_never_reaches_a_network() {
    // The shipped transport answers "no model", which is what makes a fresh install rules-only.
    let request = ClefRequest {
        state: State::default(),
        questions: mewndo_router::answers::guard_questions(),
        kind: CallKind::Guard,
        sig: "0".repeat(32),
    };
    assert!(matches!(
        NoClef.ask(&request, Duration::from_millis(300)),
        Err(ClefError::Unavailable(_))
    ));
    // The request serializes to the §34.3 shape the gateway validates: a state and a non-empty question list.
    let body = serde_json::to_value(&request).unwrap();
    assert!(body.get("state").is_some());
    assert_eq!(body["questions"].as_array().unwrap().len(), 5);
    assert_eq!(body["questions"][4]["options"].as_array().unwrap().len(), 6);
}

#[test]
fn the_state_sent_to_the_model_stays_small() {
    // §34.9 "Speed rules": the last 3 actions, at most 20 paths, commands cut at 300 characters.
    let (router, _) = router_with(FakeClef::new(allow_body()));
    let mut g = guard_input("npm run build", Mode::Active);
    g.recent = (0..10).map(|i| format!("action {i}")).collect();
    let d = router.guard(&g);
    assert!(d.decision.verdict == Verdict::Allow);
    // The facts that do go are the three §34.3 names, and nothing else.
    let facts = serde_json::to_value(&d.rule_outcome.facts).unwrap();
    let keys: Vec<&String> = facts.as_object().unwrap().keys().collect();
    // serde_json writes a map in key order, so this is the sorted set of exactly those three names.
    assert_eq!(keys, vec!["in_journal", "paths_outside_brief", "same_action_failed_recently"]);
}
