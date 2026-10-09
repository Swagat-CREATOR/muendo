// R6 (the answer half): the five answers one Clef call brings back (spec §34.3, §34.9 R6).
//
// The shapes here are the ones the gateway already produces -- cloud/gateway/src/gateway.js,
// `parseClefAnswers` -- and the field names are copied from it on purpose: `p_yes` for a noul, `value` for a
// score, `choice` / `probabilities` / `confidence` for a choice. If the two drift apart, every model answer
// silently becomes a fallback, which is safe but useless, so the parse here mirrors the gateway's rules line
// for line, including the ones that look fussy:
//
//   * a probability outside 0..1 (with 1% slack for a model that prints 1.000001) is a shape we do not
//     understand, not a number to clamp;
//   * a score outside the question's own scale means the model used a different scale, so "risk 0.8" from a
//     1..5 question must never be read as "risk 1";
//   * a choice without a distribution is not enough to act on, because §34.4 branches on its confidence;
//   * the probabilities may not sum to 1 (§34.9 "Pitfalls"), so they are floored at 0 and renormalized.
//
// And the rule that matters most: a missing or unparsable answer is *no model opinion*. It falls back to the
// rules (§34.8). It is never an allow. That is why `parse_answers` returns `Result` and why `Answers`'
// getters return `Option` -- there is no default anywhere in this file.

use crate::{Backend, ChoiceVerdict};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionType {
    Noul,
    Choice,
    Score,
}

/// One question in the §34.3 batch. One call carries all five.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: QuestionType,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scale: Vec<f64>,
}

impl Question {
    pub fn noul(id: &str, text: &str) -> Question {
        Question { id: id.into(), kind: QuestionType::Noul, text: text.into(), options: vec![], scale: vec![] }
    }
    pub fn score(id: &str, text: &str) -> Question {
        Question {
            id: id.into(),
            kind: QuestionType::Score,
            text: text.into(),
            options: vec![],
            scale: vec![1.0, 2.0, 3.0, 4.0, 5.0],
        }
    }
    pub fn choice(id: &str, text: &str, options: Vec<String>) -> Question {
        Question { id: id.into(), kind: QuestionType::Choice, text: text.into(), options, scale: vec![] }
    }
}

/// One answer. Untagged because that is what the gateway sends: the question's own type says which arm to
/// expect, and the arms cannot be confused with each other (a choice has three required fields, a noul has
/// `p_yes`, a score has `value`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Answer {
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
    Noul {
        p_yes: f64,
    },
    Score {
        value: f64,
    },
}

/// Every answer from one call, plus where they came from. `backend` rides along because §34.4 logs it on the
/// decision and because the kill-switch test asserts on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Answers {
    pub backend: Backend,
    pub by_id: BTreeMap<String, Answer>,
}

impl Answers {
    pub fn new(backend: Backend, by_id: BTreeMap<String, Answer>) -> Answers {
        Answers { backend, by_id }
    }

    /// P(yes) for a noul question, or None when the model did not answer it or answered it as something
    /// else. None means no opinion, and every caller in decide.rs treats it that way.
    pub fn noul(&self, id: &str) -> Option<f64> {
        match self.by_id.get(id) {
            Some(Answer::Noul { p_yes }) => Some(*p_yes),
            _ => None,
        }
    }

    pub fn score(&self, id: &str) -> Option<f64> {
        match self.by_id.get(id) {
            Some(Answer::Score { value }) => Some(*value),
            _ => None,
        }
    }

    /// The chosen option and its confidence. A choice the router does not recognize (a model inventing a
    /// seventh verdict) is None, not a guess.
    pub fn choice(&self, id: &str) -> Option<(ChoiceVerdict, f64)> {
        match self.by_id.get(id) {
            Some(Answer::Choice { choice, confidence, .. }) => {
                ChoiceVerdict::parse(choice).map(|c| (c, *confidence))
            }
            _ => None,
        }
    }
}

/// Why a response could not be used, plus one raw sample to keep (§34.9 R6: "If the shape is unknown, treat
/// it as a fallback and save one raw sample"). One sample, not every sample: this is for fixing the parser,
/// not for collecting the user's traffic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fallback {
    pub reason: String,
    pub raw_sample: String,
}

const SAMPLE_LIMIT: usize = 400;

fn fallback(reason: impl Into<String>, raw: &Value) -> Fallback {
    let mut sample = raw.to_string();
    if sample.len() > SAMPLE_LIMIT {
        sample.truncate(SAMPLE_LIMIT);
    }
    Fallback { reason: reason.into(), raw_sample: sample }
}

/// The §34.3 guard batch: one call, five answers.
pub fn guard_questions() -> Vec<Question> {
    vec![
        Question::noul("in_scope", "Is this action part of what the brief asks?"),
        Question::noul("irreversible", "Would this action be hard to undo without a backup?"),
        Question::noul("secrets", "Does this action read, send or expose passwords, keys or tokens?"),
        Question::score("risk", "How risky is this action for the user's data?"),
        Question::choice(
            "verdict",
            "What should happen next?",
            ChoiceVerdict::ALL.iter().map(|c| c.as_str().to_string()).collect(),
        ),
    ]
}

/// Mirror of the gateway's `indexAnswers`: a map keyed by question id, or a list of `{id, ...}`, with or
/// without an `answers` wrapper. Anything else indexes to nothing and becomes a fallback.
fn index(raw: &Value) -> BTreeMap<String, &Value> {
    let body = raw.get("answers").unwrap_or(raw);
    let mut found = BTreeMap::new();
    if let Some(list) = body.as_array() {
        for a in list {
            if let Some(id) = a.get("id").and_then(Value::as_str) {
                found.insert(id.to_string(), a);
            }
        }
    } else if let Some(obj) = body.as_object() {
        for (id, a) in obj {
            found.insert(id.clone(), a);
        }
    }
    found
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.trim().parse().ok()).filter(|n| n.is_finite())
}

/// `p_yes ?? prob ?? the bare value`, in 0..1 with the gateway's 1% slack.
fn probability(got: &Value) -> Option<f64> {
    let v = got.get("p_yes").or_else(|| got.get("prob")).unwrap_or(got);
    let n = number(v)?;
    if !(-0.01..=1.01).contains(&n) {
        return None;
    }
    Some(n.clamp(0.0, 1.0))
}

/// A score on the question's own scale, kept continuous because §34.5 only ever compares it ("risk ≤ 2").
fn on_scale(scale: &[f64], got: &Value) -> Option<f64> {
    let v = got.get("value").or_else(|| got.get("score")).unwrap_or(got);
    let n = number(v)?;
    let low = scale.iter().copied().fold(f64::INFINITY, f64::min);
    let high = scale.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (low..=high).contains(&n).then_some(n)
}

/// The gateway's `choiceAnswer`: floor the probabilities at 0, require a positive sum, renormalize, and take
/// the largest as the choice. Flooring only -- clamping at 1 would erase the ratios.
fn choice_answer(options: &[String], got: &Value) -> Option<Answer> {
    let probs = got.get("probabilities").or_else(|| got.get("probs"))?.as_object()?;
    let mut out: BTreeMap<String, f64> = BTreeMap::new();
    let mut sum = 0.0;
    for o in options {
        let v = probs.get(o).and_then(number).unwrap_or(0.0).max(0.0);
        out.insert(o.clone(), v);
        sum += v;
    }
    if sum <= 0.0 {
        return None;
    }
    let mut choice = options.first()?.clone();
    for o in options {
        let scaled = out[o] / sum;
        out.insert(o.clone(), scaled);
        if scaled > out[&choice] {
            choice = o.clone();
        }
    }
    let confidence = out[&choice];
    Some(Answer::Choice { choice, probabilities: out, confidence })
}

/// Parse a whole response. All or nothing, exactly like the gateway: one missing or unreadable answer makes
/// the whole call a fallback, because a half-answered §34.4 table is a table whose rows disagree about what
/// the model said.
pub fn parse_answers(questions: &[Question], raw: &Value) -> Result<BTreeMap<String, Answer>, Fallback> {
    if raw.get("fallback").and_then(Value::as_bool) == Some(true) {
        return Err(fallback("gateway reported a fallback", raw));
    }
    let by_id = index(raw);
    let mut answers = BTreeMap::new();
    for q in questions {
        let Some(got) = by_id.get(&q.id) else {
            return Err(fallback(format!("no answer for {}", q.id), raw));
        };
        if got.is_null() || got.as_str() == Some("") {
            return Err(fallback(format!("no answer for {}", q.id), raw));
        }
        let parsed = match q.kind {
            QuestionType::Noul => probability(got).map(|p_yes| Answer::Noul { p_yes }),
            QuestionType::Score => on_scale(&q.scale, got).map(|value| Answer::Score { value }),
            QuestionType::Choice => choice_answer(&q.options, got),
        };
        match parsed {
            Some(a) => {
                answers.insert(q.id.clone(), a);
            }
            None => return Err(fallback(format!("{}: unusable answer", q.id), raw)),
        }
    }
    Ok(answers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body() -> Value {
        json!({"answers": {
            "in_scope": {"p_yes": 0.9},
            "irreversible": {"p_yes": 0.2},
            "secrets": {"p_yes": 0.0},
            "risk": {"value": 2},
            "verdict": {"probabilities": {"allow": 7.0, "ask_user": 3.0}}
        }})
    }

    #[test]
    fn parses_the_gateway_shape() {
        let qs = guard_questions();
        let a = Answers::new(Backend::WorkersAi, parse_answers(&qs, &body()).unwrap());
        assert_eq!(a.noul("in_scope"), Some(0.9));
        assert_eq!(a.score("risk"), Some(2.0));
        let (choice, confidence) = a.choice("verdict").unwrap();
        assert_eq!(choice, ChoiceVerdict::Allow);
        assert!((confidence - 0.7).abs() < 1e-9, "probabilities are renormalized: {confidence}");
    }

    #[test]
    fn a_list_with_ids_and_a_bare_map_both_work() {
        let qs = vec![Question::noul("in_scope", "?")];
        assert!(parse_answers(&qs, &json!([{"id": "in_scope", "p_yes": 0.4}])).is_ok());
        assert!(parse_answers(&qs, &json!({"in_scope": 0.4})).is_ok(), "a bare number");
    }

    #[test]
    fn anything_unreadable_is_a_fallback_and_never_an_answer() {
        let qs = guard_questions();
        for bad in [
            json!({}),
            json!({"fallback": true}),
            json!("hello"),
            json!({"answers": {"in_scope": {"p_yes": 7}}}),
            json!({"answers": {"in_scope": {"p_yes": "x"}}}),
        ] {
            assert!(parse_answers(&qs, &bad).is_err(), "{bad}");
        }
        // A score on the wrong scale is unusable, not "risk 1".
        let risk = vec![Question::score("risk", "?")];
        assert!(parse_answers(&risk, &json!({"risk": {"value": 0.8}})).is_err());
        // A choice with no distribution is not enough to act on.
        let v = vec![Question::choice("verdict", "?", vec!["allow".into(), "deny".into()])];
        assert!(parse_answers(&v, &json!({"verdict": {"choice": "allow"}})).is_err());
        assert!(parse_answers(&v, &json!({"verdict": {"probabilities": {"allow": 0}}})).is_err());
    }

    #[test]
    fn an_unknown_option_is_no_opinion() {
        let qs = vec![Question::choice("verdict", "?", vec!["teleport".into(), "allow".into()])];
        let parsed = parse_answers(&qs, &json!({"verdict": {"probabilities": {"teleport": 1.0}}})).unwrap();
        let a = Answers::new(Backend::WorkersAi, parsed);
        assert_eq!(a.choice("verdict"), None, "a verdict the router does not know is not a verdict");
    }
}
