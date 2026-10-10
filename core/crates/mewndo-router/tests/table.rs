// The §34.4 table, one test per row, from the JSON fixtures in tests/fixtures (spec §34.9 R8: "one unit
// test per row using JSON fixtures in core/crates/mewndo-router/tests/fixtures/").
//
// The fixtures are the readable half of this file: each one names its row, says why the row exists, and
// gives the exact inputs and the exact expected decision. A change to a threshold in decide.rs shows up here
// as one named row failing, which is the point -- §34.4 is a safety table, and "the behaviour changed
// slightly" is not an acceptable way to find out.
//
// Beyond the seven rows there are six `extra_` fixtures for the things the table implies but does not list:
// that a hard rule beats a confident model (the §34.9 pitfall, tested explicitly), that row 4 needs its
// evidence, that no model opinion is never an allow, that a confident deny is a deny, that a habit beats the
// model, and that shadow mode changes the outcome back to the rules'.

use mewndo_router::answers::{Answer, Answers};
use mewndo_router::decide::decide;
use mewndo_router::facts::RuleOutcome;
use mewndo_router::{Backend, ChoiceVerdict, Mode, Verdict};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct Fixture {
    row: String,
    name: String,
    #[allow(dead_code)]
    why: String,
    /// Stated in every fixture on purpose: a fixture that forgot its mode would silently be a shadow-mode
    /// fixture, and shadow mode ignores the model.
    mode: Mode,
    #[serde(default)]
    habit: Option<Verdict>,
    rules: RuleOutcome,
    #[serde(default)]
    answers: Option<BTreeMap<String, Answer>>,
    #[serde(default)]
    backend: Option<Backend>,
    expect: Expect,
}

#[derive(Debug, Deserialize)]
struct Expect {
    verdict: Verdict,
    #[serde(default)]
    rule: Option<String>,
    #[serde(default)]
    backend: Option<Backend>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    reason_contains: Option<String>,
    #[serde(default)]
    shadow: Option<bool>,
    #[serde(default)]
    model_verdict: Option<ChoiceVerdict>,
}

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Load one fixture, run `decide` on it, and check every field the fixture named.
fn run(file: &str) -> Fixture {
    let path = dir().join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let f: Fixture = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{file}: {e}"));
    let answers = f
        .answers
        .clone()
        .map(|by_id| Answers::new(f.backend.unwrap_or(Backend::WorkersAi), by_id));
    let d = decide(&f.rules, answers.as_ref(), f.mode, f.habit);
    let what = format!("§34.4 row {} ({}) [{file}]", f.row, f.name);
    assert_eq!(d.verdict, f.expect.verdict, "{what}: verdict");
    if let Some(rule) = &f.expect.rule {
        assert_eq!(&d.rule, rule, "{what}: rule");
    }
    if let Some(backend) = f.expect.backend {
        assert_eq!(d.backend, backend, "{what}: backend");
    }
    if let Some(c) = f.expect.confidence {
        assert!(
            (d.confidence - c).abs() < 1e-9,
            "{what}: confidence {} != {c}",
            d.confidence
        );
    }
    if let Some(text) = &f.expect.reason_contains {
        assert!(
            d.reason.contains(text.as_str()),
            "{what}: reason is {:?}",
            d.reason
        );
    }
    if let Some(shadow) = f.expect.shadow {
        assert_eq!(d.shadow, shadow, "{what}: shadow flag");
    }
    // The model's verdict is recorded whatever happens, in both modes: the Agents tab's agreement rate is
    // the only thing that lets a user decide when to switch an agent to active (§34.6).
    assert_eq!(
        d.model_verdict, f.expect.model_verdict,
        "{what}: recorded model verdict"
    );
    f
}

// --- one test per row ------------------------------------------------------------------------------------

#[test]
fn row_1_a_hard_rule_decides_and_the_model_is_not_consulted() {
    run("row1_hard_rule_beats_the_model.json");
    run("extra_model_never_overrides_a_hard_rule.json");
}

#[test]
fn row_2_brake() {
    run("row2_brake_from_the_model.json");
    run("row2_brake_from_three_denies.json");
}

#[test]
fn row_3_in_scope_below_point_three_asks() {
    run("row3_out_of_scope.json");
}

#[test]
fn row_4_skip_duplicate_with_a_recent_identical_failure_denies() {
    run("row4_skip_duplicate.json");
    run("extra_row4_needs_evidence.json");
}

#[test]
fn row_5_irreversible_in_scope_gets_a_save_point_first() {
    run("row5_irreversible_gets_a_savepoint.json");
}

#[test]
fn row_6_low_confidence_asks() {
    run("row6_low_confidence.json");
}

#[test]
fn row_7_otherwise_allows() {
    run("row7_otherwise_allow.json");
    run("extra_row7_confident_deny.json");
}

// --- what the table implies ------------------------------------------------------------------------------

#[test]
fn a_habit_beats_the_model_and_a_missing_answer_is_never_an_allow() {
    run("extra_habit_beats_the_model.json");
    run("extra_no_model_opinion_is_never_an_allow.json");
}

#[test]
fn shadow_mode_falls_back_to_the_rules_verdict() {
    run("extra_shadow_mode_ignores_the_model.json");
}

/// Every fixture on disk is exercised. Without this, a fixture could be added, be wrong, and never run.
#[test]
fn every_fixture_in_the_folder_passes() {
    let mut found = 0;
    for entry in std::fs::read_dir(dir()).expect("fixtures folder") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        run(path.file_name().unwrap().to_str().unwrap());
        found += 1;
    }
    assert!(
        found >= 14,
        "expected the seven rows plus the extras, found {found}"
    );
}

/// The thresholds are boundaries, and a boundary is where an off-by-one lives. §34.4 says "confidence >= 0.8"
/// for the brake, "< 0.3" for in_scope, "> 0.5" for irreversible and "< 0.6" for the verdict: so 0.8 brakes,
/// 0.3 does not ask, 0.5 gets no save point and 0.6 is confident enough.
#[test]
fn the_thresholds_are_exactly_where_the_table_puts_them() {
    let rules = RuleOutcome {
        destructive: true,
        ..RuleOutcome::default()
    };
    let answers = |in_scope: f64, irreversible: f64, choice: ChoiceVerdict, confidence: f64| {
        let mut by_id = BTreeMap::new();
        by_id.insert("in_scope".to_string(), Answer::Noul { p_yes: in_scope });
        by_id.insert(
            "irreversible".to_string(),
            Answer::Noul {
                p_yes: irreversible,
            },
        );
        by_id.insert(
            "verdict".to_string(),
            Answer::Choice {
                choice: choice.as_str().to_string(),
                probabilities: BTreeMap::new(),
                confidence,
            },
        );
        Answers::new(Backend::WorkersAi, by_id)
    };
    let v = |a: &Answers| decide(&rules, Some(a), Mode::Active, None).verdict;

    assert_eq!(
        v(&answers(0.9, 0.0, ChoiceVerdict::Brake, 0.8)),
        Verdict::Brake,
        ">= 0.8"
    );
    assert_ne!(
        v(&answers(0.9, 0.0, ChoiceVerdict::Brake, 0.79)),
        Verdict::Brake,
        "< 0.8 is not a brake"
    );
    assert_eq!(
        v(&answers(0.29, 0.0, ChoiceVerdict::Allow, 0.9)),
        Verdict::Ask,
        "< 0.3"
    );
    assert_ne!(
        v(&answers(0.3, 0.0, ChoiceVerdict::Allow, 0.9)),
        Verdict::Ask,
        "0.3 is in scope"
    );
    assert_eq!(
        v(&answers(0.9, 0.51, ChoiceVerdict::Allow, 0.9)),
        Verdict::SavepointThenAllow,
        "> 0.5"
    );
    assert_eq!(
        v(&answers(0.9, 0.5, ChoiceVerdict::Allow, 0.9)),
        Verdict::Allow,
        "0.5 exactly is not"
    );
    assert_eq!(
        v(&answers(0.9, 0.0, ChoiceVerdict::Allow, 0.59)),
        Verdict::Ask,
        "< 0.6"
    );
    assert_eq!(
        v(&answers(0.9, 0.0, ChoiceVerdict::Allow, 0.6)),
        Verdict::Allow,
        "0.6 is sure enough"
    );
}
