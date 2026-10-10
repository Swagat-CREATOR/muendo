// R8: the verdict function (spec §34.9 R8). The §34.4 table, in order, as one pure function.
//
// Pure means: no clock, no network, no database, no globals. Everything it needs has already been gathered
// -- the rules pass, the model's answers, the agent's mode, the user's habit -- so the whole of §34.4 can be
// tested from JSON fixtures, one per row, and a change to a threshold shows up as a failing row rather than
// as a different outcome in production three weeks later.
//
// §34.4, first match wins:
//
//   1. a hard rule matches                               deny or ask; the model isn't consulted
//   2. verdict = brake with confidence >= 0.8,           brake (the session is frozen, §24)
//      or 3 denies in 2 minutes
//   3. in_scope P(yes) < 0.3                             ask
//   4. skip_duplicate, and the same command failed       deny with a reason (the loop brake)
//      in the last 5 minutes with the same output hash
//   5. irreversible P(yes) > 0.5 and in scope            save point, then allow
//   6. verdict confidence < 0.6                          ask
//   7. otherwise                                         allow
//
// Three things the table does not spell out, decided here and marked in the code:
//
//  * Where habits sit. §34.7's habit is the user's own standing answer, so it outranks anything the model
//    says -- but not a hard rule and not the brake. It is checked between rows 2 and 3.
//  * What "and in scope" means in row 5. Row 3 has already sent everything below P(yes) 0.3 to the user, so
//    row 5's clause describes what is left rather than adding a second threshold. A save point before an
//    irreversible action is also the cheap mistake to make.
//  * What row 7 does with a confident `deny` or `ask_user`. Taken literally, "otherwise allow" would turn a
//    confident model deny into an allow, which cannot be the intent of a row that exists to catch the
//    ordinary case. Row 7 honours the model's own confident choice; when that choice is `allow` -- the
//    ordinary case, and what the row 7 fixture asserts -- the answer is allow.
//
// And the rule above all of them (§34.6): the model can never override a hard rule, in either mode. Row 1
// returns before `answers` is so much as read, and `model_answers` below is None in shadow mode.

use crate::answers::Answers;
use crate::facts::RuleOutcome;
use crate::{Backend, ChoiceVerdict, Mode, Verdict};
use serde::{Deserialize, Serialize};

/// One decision, as it is logged in `decisions` (§38.6) and as the hook acts on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    pub verdict: Verdict,
    /// Written for the agent to read: what happened and what to do instead.
    pub reason: String,
    /// How sure the thing that decided was. Rules are 1.0 -- they are not guessing.
    pub confidence: f64,
    pub backend: Backend,
    /// Which rule or which §34.4 row decided. The decisions table groups by this.
    pub rule: String,
    /// The model answered but was not used (§34.6 shadow mode).
    pub shadow: bool,
    /// What the model would have said, stored either way so the Agents tab can show the agreement rate.
    pub model_verdict: Option<ChoiceVerdict>,
}

impl Decision {
    fn new(
        verdict: Verdict,
        rule: &str,
        reason: impl Into<String>,
        confidence: f64,
        backend: Backend,
    ) -> Decision {
        Decision {
            verdict,
            reason: reason.into(),
            confidence,
            backend,
            rule: rule.to_string(),
            shadow: false,
            model_verdict: None,
        }
    }
}

/// §34.4. `answers` is whatever came back from Clef, or None when there was nothing usable: the router is
/// off, the deadline passed, the gateway fell back, the response did not parse. `habits` is the user's
/// standing answer for this action signature, already looked up (§34.7); None when there is none.
pub fn decide(
    rules: &RuleOutcome,
    answers: Option<&Answers>,
    mode: Mode,
    habits: Option<Verdict>,
) -> Decision {
    // Shadow mode: the model answered, the answer is recorded, and nothing it says is used (§34.6, R9).
    // This single line is the whole of shadow mode, which is why it cannot be forgotten in one branch.
    let model = match mode {
        Mode::Active => answers,
        Mode::Shadow => None,
    };
    let model_verdict = answers.and_then(|a| a.choice("verdict")).map(|(c, _)| c);
    let shadow = mode == Mode::Shadow && answers.is_some();
    let finish = |mut d: Decision| {
        d.shadow = shadow;
        d.model_verdict = model_verdict;
        d
    };
    let backend = model.map(|a| a.backend).unwrap_or(Backend::Rules);
    let choice = model.and_then(|a| a.choice("verdict"));

    // --- row 1: a hard rule matches ---------------------------------------------------------------------
    // Before anything is read out of `answers`. A model that wants to allow a disk format does not get a
    // say, and there is no code path by which it could.
    if rules.hard()
        && let Some(verdict) = rules.decided
    {
        return finish(Decision::new(
            verdict,
            &rules.rule,
            rules.reason.clone(),
            1.0,
            Backend::Rules,
        ));
    }

    // --- row 2: brake -----------------------------------------------------------------------------------
    // Two ways in. The model's is gated on `model`, so shadow mode cannot freeze a session; the session's
    // own deny count is not, because counting is not a model opinion.
    if let Some((ChoiceVerdict::Brake, confidence)) = choice
        && confidence >= 0.8
    {
        return finish(Decision::new(
            Verdict::Brake,
            "row2_brake",
            "Mewndo: this session is going somewhere it should not. Frozen until the user looks at it.",
            confidence,
            backend,
        ));
    }
    if rules.facts.recent_denies >= 3 {
        return finish(Decision::new(
            Verdict::Brake,
            "row2_three_denies",
            "Mewndo: three actions were refused in the last two minutes. The session is frozen -- tell the \
             user what you are trying to do.",
            1.0,
            Backend::Rules,
        ));
    }

    // The allow list (§34.9 R1): decided, but softer than a hard rule, so it sits after the brake.
    if rules.decided == Some(Verdict::Allow) {
        return finish(Decision::new(
            Verdict::Allow,
            &rules.rule,
            rules.reason.clone(),
            1.0,
            Backend::Rules,
        ));
    }

    // --- habits (§34.7) ---------------------------------------------------------------------------------
    // The user has already answered this exact action three times. Their answer beats the model's guess.
    if let Some(verdict) = habits {
        return finish(Decision::new(
            verdict,
            "habit",
            "Your habit for this action in this project (Settings → Habits).",
            1.0,
            Backend::Habit,
        ));
    }

    // --- no model opinion -------------------------------------------------------------------------------
    // Router off, deadline passed, unparsable answer, or shadow mode. §34.8: the rules decide, and a
    // destructive action becomes "ask". Never an allow that the rules did not themselves reach.
    let Some(answers) = model else {
        return finish(if rules.destructive {
            Decision::new(
                Verdict::Ask,
                "rules_fallback",
                "Mewndo: this changes or removes files and nothing has cleared it. Waiting for the user.",
                1.0,
                Backend::Rules,
            )
        } else {
            Decision::new(
                Verdict::Allow,
                "rules_fallback",
                "No rule matched.",
                1.0,
                Backend::Rules,
            )
        });
    };

    // --- row 3: out of scope ----------------------------------------------------------------------------
    let in_scope = answers.noul("in_scope");
    if let Some(p) = in_scope
        && p < 0.3
    {
        return finish(Decision::new(
            Verdict::Ask,
            "row3_out_of_scope",
            "Mewndo: this does not look like part of the brief. Waiting for the user to confirm it.",
            1.0 - p,
            backend,
        ));
    }

    // --- row 4: the loop brake --------------------------------------------------------------------------
    // The model says this is the same thing again, and the span table agrees it already failed with the same
    // output. Running it a third time wastes the user's tokens and their time.
    if let Some((ChoiceVerdict::SkipDuplicate, confidence)) = choice
        && rules.facts.same_action_failed_recently > 0
    {
        return finish(Decision::new(
            Verdict::Deny,
            "row4_skip_duplicate",
            "Mewndo: same command failed twice with the same error. Change approach.",
            confidence,
            backend,
        ));
    }

    // --- row 5: save point, then allow ------------------------------------------------------------------
    if let Some(p) = answers.noul("irreversible")
        && p > 0.5
        && in_scope.is_none_or(|s| s >= 0.3)
    {
        return finish(Decision::new(
            Verdict::SavepointThenAllow,
            "row5_irreversible",
            "Mewndo: hard to undo, so a save point is written first. Go ahead after that.",
            p,
            backend,
        ));
    }

    // --- row 6: the model is not sure -------------------------------------------------------------------
    // A missing or unrecognized verdict lands here too: no confidence at all is less than 0.6.
    let confidence = choice.map(|(_, c)| c).unwrap_or(0.0);
    if confidence < 0.6 {
        return finish(Decision::new(
            Verdict::Ask,
            "row6_low_confidence",
            "Mewndo: not sure enough about this one. Waiting for the user.",
            confidence,
            backend,
        ));
    }

    // --- row 7: otherwise -------------------------------------------------------------------------------
    // The model is confident. Honour what it chose; `allow` is the ordinary case and the one §34.4 names.
    let (chosen, _) = choice.expect("confidence >= 0.6 means there is a choice");
    let (verdict, reason) = match chosen {
        ChoiceVerdict::Allow => (Verdict::Allow, "Inside the brief and nothing to undo."),
        ChoiceVerdict::SavepointThenAllow => (
            Verdict::SavepointThenAllow,
            "Mewndo: a save point is written first. Go ahead after that.",
        ),
        ChoiceVerdict::SkipDuplicate => (
            // Row 4 did not fire, so nothing recorded this failing before: there is nothing to skip, and a
            // skip without evidence is not a reason to stop work.
            Verdict::Allow,
            "Looks like a repeat, but nothing recorded it failing. Going ahead.",
        ),
        ChoiceVerdict::AskUser => (
            Verdict::Ask,
            "Mewndo: this one needs the user. Waiting for an answer.",
        ),
        ChoiceVerdict::Deny => (
            Verdict::Deny,
            "Mewndo: this was refused. Tell the user what you were trying to do and why.",
        ),
        // A brake the model was not sure enough about (row 2 wanted 0.8) is a question, never an allow.
        ChoiceVerdict::Brake => (
            Verdict::Ask,
            "Mewndo: this looked serious enough to stop for. Waiting for the user.",
        ),
    };
    finish(Decision::new(
        verdict,
        "row7_model_verdict",
        reason,
        confidence,
        backend,
    ))
}
