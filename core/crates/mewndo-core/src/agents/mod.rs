//! One handler per agent kind. Each file turns that agent's hook events into Mewndo's own
//! actions - a trace, a span, a Router call, an Inbox card - and prints what the agent
//! expects to read back (spec §33.10 Parts C and F).
//!
//! The split is deliberate: §33.10 Part F says a schema that differs from Claude's is mapped
//! in that agent's own file and nowhere else, so one agent changing its hook format can never
//! reach another's handler.
pub mod claude;
pub mod codex;
pub mod cursor;
