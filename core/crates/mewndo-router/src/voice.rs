// R12: voice routing (spec §34.5, §34.9 R12). The user says something into the talk box; this decides which
// agent it was for.
//
// Deadline 400 ms (§34.8). Past it, the keyword fallback: substring matching over agent names, aliases and
// folder names. §34.9 R12 names Aho-Corasick for that; a person has a handful of agents open, so the fallback
// is a nested loop over maybe thirty short strings -- nanoseconds, and no automaton to build on every
// keystroke.
//
// Honest limits (§28.10): the fallback is substring matching, so it finds "shop" in "shopping" and knows
// nothing about what the user meant. It returns the top two (§34.5: "otherwise the top two by keyword
// match") and the UI shows them as chips, because a wrong guess that the user can see and correct is the only
// safe kind.

use crate::answers::{Answers, Question};
use crate::{Backend, ChoiceVerdict};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// An agent the user could be talking to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LiveAgent {
    pub id: String,
    /// "Claude Code", "Cursor".
    pub name: String,
    /// Other things the user calls it: "claude", "cc", "the rust one".
    pub aliases: Vec<String>,
    pub cwd: PathBuf,
    /// The last line it printed, for the option label.
    pub last_line: String,
}

impl LiveAgent {
    /// The folder name, which is what people actually say ("the shop repo"). Split on both separators
    /// rather than with `Path::file_name`, because a Windows path handed to a Linux build (the tests, and
    /// WSL) has no separators as far as `Path` is concerned, and the label would be the whole path.
    pub fn folder(&self) -> String {
        self.cwd
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_string()
    }

    /// "<Agent> · <cwd folder> · last: <last line, up to 40 chars>" (§34.9 R12).
    pub fn label(&self) -> String {
        let mut last: String = self.last_line.split_whitespace().collect::<Vec<_>>().join(" ");
        if last.chars().count() > 40 {
            last = last.chars().take(40).collect();
        }
        if last.is_empty() {
            format!("{} · {}", self.name, self.folder())
        } else {
            format!("{} · {} · last: {}", self.name, self.folder(), last)
        }
    }
}

/// Where the talk box text goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteChoice {
    /// Index into the agent list that was passed in.
    Agent(usize),
    /// "Mewndo command": undo, stop, resume (§23.3).
    MewndoCommand,
    /// "Start a new agent".
    NewAgent,
}

pub const MEWNDO_COMMAND: &str = "Mewndo command";
pub const NEW_AGENT: &str = "Start a new agent";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteResult {
    pub choice: RouteChoice,
    pub confidence: f64,
    pub backend: Backend,
    /// The second-best guess, so the UI can offer a chip instead of being wrong in silence.
    pub runner_up: Option<RouteChoice>,
    /// The `noul` answer: this was an instruction to Mewndo itself.
    pub to_mewndo: Option<f64>,
}

/// The options, in order: one per live agent, then "Mewndo command", then "Start a new agent" (§34.9 R12).
pub fn options(agents: &[LiveAgent]) -> Vec<String> {
    let mut out: Vec<String> = agents.iter().map(LiveAgent::label).collect();
    out.push(MEWNDO_COMMAND.to_string());
    out.push(NEW_AGENT.to_string());
    out
}

/// The two questions, in one call (§34.9 R12).
pub fn questions(agents: &[LiveAgent]) -> Vec<Question> {
    vec![
        Question::choice("route", "Who is this for?", options(agents)),
        Question::noul(
            "to_mewndo",
            "Is this an instruction to Mewndo itself (undo, stop, resume)?",
        ),
    ]
}

/// Words that mean Mewndo itself, for the fallback. Short list on purpose: these are the §23.3 intents, and
/// a word that is also ordinary English ("stop") only counts when nothing names an agent.
const MEWNDO_WORDS: [&str; 10] = [
    "mewndo", "undo", "roll back", "rollback", "restore", "save point", "savepoint", "router off", "resume",
    "stop",
];

/// Score every option by how much of the text names it. Returns the best and the runner-up: §34.5's "top two
/// by keyword match".
pub fn keyword_fallback(text: &str, agents: &[LiveAgent]) -> (RouteChoice, Option<RouteChoice>, f64) {
    let said = text.to_lowercase();
    let mut scored: Vec<(usize, RouteChoice)> = Vec::new();
    for (i, a) in agents.iter().enumerate() {
        let mut score = 0usize;
        // A longer match is a better match: "claude code" beats "code".
        for word in std::iter::once(a.name.to_lowercase())
            .chain(a.aliases.iter().map(|s| s.to_lowercase()))
            .chain(std::iter::once(a.folder().to_lowercase()))
        {
            if !word.is_empty() && said.contains(&word) {
                score += word.len();
            }
        }
        if score > 0 {
            scored.push((score, RouteChoice::Agent(i)));
        }
    }
    let mewndo: usize = MEWNDO_WORDS
        .iter()
        .filter(|w| said.contains(**w))
        .map(|w| w.len())
        .max()
        .unwrap_or(0);
    if mewndo > 0 {
        scored.push((mewndo, RouteChoice::MewndoCommand));
    }
    if said.contains("new agent") || said.contains("start a new") || said.contains("open a new") {
        scored.push((20, RouteChoice::NewAgent));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    match scored.len() {
        0 => (
            // Nothing matched anything. The only honest default is the single live agent, or "Mewndo
            // command" when there is not exactly one -- never a guess between two agents.
            if agents.len() == 1 {
                RouteChoice::Agent(0)
            } else {
                RouteChoice::MewndoCommand
            },
            None,
            0.0,
        ),
        1 => (scored[0].1.clone(), None, 1.0),
        _ => {
            let total = (scored[0].0 + scored[1].0) as f64;
            (
                scored[0].1.clone(),
                Some(scored[1].1.clone()),
                scored[0].0 as f64 / total,
            )
        }
    }
}

/// Turn the model's answers into a route, with the keyword fallback for anything missing. `answers` is None
/// when the deadline passed or the router is off.
pub fn route(text: &str, agents: &[LiveAgent], answers: Option<&Answers>) -> RouteResult {
    let labels = options(agents);
    let to_mewndo = answers.and_then(|a| a.noul("to_mewndo"));
    // The choice question's options are labels, not verdicts, so it is read straight out of `by_id` rather
    // than through `Answers::choice`, which only knows the §34.3 verdict vocabulary.
    let picked = answers.and_then(|a| match a.by_id.get("route") {
        Some(crate::answers::Answer::Choice { choice, confidence, .. }) => {
            labels.iter().position(|l| l == choice).map(|i| (i, *confidence))
        }
        _ => None,
    });
    match picked {
        Some((i, confidence)) if confidence >= 0.6 => {
            let choice = if i < agents.len() {
                RouteChoice::Agent(i)
            } else if labels[i] == MEWNDO_COMMAND {
                RouteChoice::MewndoCommand
            } else {
                RouteChoice::NewAgent
            };
            RouteResult {
                choice,
                confidence,
                backend: answers.map(|a| a.backend).unwrap_or(Backend::Rules),
                runner_up: keyword_fallback(text, agents).1,
                to_mewndo,
            }
        }
        // No answer, or one the model was not sure of: chips, not a guess (§34.5).
        _ => {
            let (choice, runner_up, confidence) = keyword_fallback(text, agents);
            RouteResult { choice, confidence, backend: Backend::Rules, runner_up, to_mewndo }
        }
    }
}

/// The voice kill switch (§34.9 R10): "router off" said out loud. Recognized here rather than in the intent
/// model, because the one command that must work when the model is wrong is the one that turns it off.
pub fn says_router_off(text: &str) -> Option<bool> {
    let said = text.to_lowercase();
    if said.contains("router off") || said.contains("turn off the router") {
        Some(false)
    } else if said.contains("router on") || said.contains("turn on the router") {
        Some(true)
    } else {
        None
    }
}

/// Unused here, but kept next to the choice vocabulary it mirrors so the two cannot drift.
const _: Option<ChoiceVerdict> = None;
