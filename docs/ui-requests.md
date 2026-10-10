# UI requests

Data the core and app logic already send, waiting for a look from the UI session. Each entry: what to show, which
field carries it, and which states exist. Nothing here is styled.

## Habit card (spec §34.7)

- **Arrives as** an `inbox.card` with `kind: "habit"`, the same stack as the other Inbox cards
  (`apps/desktop/app/desk/cards.js`; `describe(card)` returns the fields below).
- **Show**: `title` — the question, e.g. "Always allow `npm test` in shop?" (the backticks mark the command);
  `lines` — two lines saying it was the same answer 3 times and that yes writes it to rules.toml for every project
  after a restart; `hints` — `['1 yes', '2 no', '3 never ask']`. `agentId` is the agent kind (`claude`, `codex`,
  `cursor`), not a running agent, so there is no lane or agent row to link to. `risk` is always 0.
- **Keys**: 1 yes, 2 no, 3 never ask, with the usual 2 s grace and Esc to take it back. No U (nothing to undo) and no
  Space/V (there is nothing to type), although a spoken "yes"/"no"/"never ask" sent as `text` is accepted.
- **States**: `open` → `answering` (grace bar) → `sent` → gone on `inbox.release`. It never expires on its own; it
  stays until answered or dismissed with E (dismissing answers nothing, and the core keeps offering it to a
  reconnecting app until it is answered).
- Currently it renders with whatever the renderer does for an unknown kind; it needs its own quiet look, lower key
  than a Permission card, since no agent is waiting on it.
