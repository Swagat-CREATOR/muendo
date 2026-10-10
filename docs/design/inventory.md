# Design inventory (D1)

Every screen and feature the desktop app has today, where it lives now, and where it goes in the new design
(`mewndo-app-design.md`, kept by the user in Downloads). Nothing is deleted: anything without a screen of its own
goes to Settings → Advanced or Labs. Walked from the code on 10 Oct 2026 (`apps/desktop/app/`, `renderer/`,
`engine/`, the core and the cloud workers).

| # | Feature or screen | Where it is now (window, file) | In the spec? | Where it goes (design section) | Keep, merge or hide |
|---|---|---|---|---|---|
| 1 | First run: welcome, pick folders, start at login | Main window `#setup`, `renderer/index.html`, `app.js` | v0 | §10 First run (steps 1, 2, 4) | Merge into the 5-step first run |
| 2 | Protected folders list with add, pause, stop protecting | Main window sidebar, `#folders`, `#add-folder` | v0 | §8.7 Protected folders | Keep |
| 3 | Storage summary and history budget | Main window `#storage-summary`; Settings → Storage `#budget` | v0 Step 7 | §8.7 storage bar; budget in Settings → Protection | Keep |
| 4 | Save points per folder, make one by hand with a label | Main window folder view `#savepoints`, `#create-sp` | v0 | §8.4 Timeline (rows); "Save point" button on §8.7 | Merge |
| 5 | Diff since a save point, choose files, undo in place or restore to a separate folder | Main window `#diff-view`, `#undo-in-place`, `#restore-separate` | v0 | §8.4 Timeline: See changes and the restore plan sheet | Keep both restore choices in the sheet |
| 6 | Recent restores, undo the undo | Main window `#restores` | v0 | §8.4 Timeline (restores as rows, before-undo save points) | Merge |
| 7 | Confirm dialog before any restore or unprotect | Main window `#confirm`, `#unprotect` | v0 | §8.4 restore plan sheet; §8.7 Remove warning | Keep |
| 8 | One-key undo window | `renderer/undo.html` (Alt+Shift+Z) | v0 | Restyle with tokens; same window | Keep |
| 9 | Brief helper (write what the agent may touch) | `renderer/brief.html` (Alt+Shift+B) | spec §24.2 | Restyle; reachable from Agents detail and the panel | Keep |
| 10 | Brief safety rules editor | Main window `#rules-dialog`; Settings → Brief safety rules | spec §24.2 | Settings → Agents ("Safety rules for briefs") | Keep |
| 11 | "What Mewndo can and can't undo" page | `renderer/limits.html`, tray, Settings | spec §28.10 | Settings → Data and privacy, plus Help link in About | Keep |
| 12 | Connect Claude Code, Codex, Cursor hooks (preview, status, repair) | Main window `#claude-hooks`, `#hooks-dialog` | v0 Step 11, spec §22 | §10 step 3; Settings → Agents; Agents "Connect agents" | Keep |
| 13 | Hook or shortcut problem banners | Main window `#hook-problem`, `#shortcut-problem` | v0 | §12 states ("Not connected" chip, inline errors) | Merge |
| 14 | Core status ("Core: running") | Main window `#core-status` | v1 P1.1 | Settings → Advanced ("Background service") | Hide behind Advanced |
| 15 | Restore engine choice (Rust, shadow, v0) | Settings → General `#engine` | own addition (P1.7) | Settings → Advanced ("Restore engine") | Hide behind Advanced |
| 16 | Guard fails open toggle | Settings → General `#guard-fail-open` | own addition | Settings → Advanced ("If the safety check can't run") | Hide behind Advanced |
| 17 | Burst alert thresholds (deleted, changed) | Settings → Burst alerts | v0 | Settings → Protection ("Mass-change alert") | Keep |
| 18 | Burst alert toast with Undo | Notification + bar alert | v0 | §11.6 toast (pounce cat), one action Undo | Keep |
| 19 | Pause protection for 1 hour | Tray, main window `#pause` | v0 | Tray; §8.7 Pause; pill face badge state | Keep |
| 20 | Start at login | First run, Settings | v0 | Settings → General | Keep |
| 21 | Custom agent process names | Settings → AI agents `#add-agent` | own addition | Settings → Advanced ("Other agents to watch") | Hide behind Advanced |
| 22 | Open data folder, open log, data folder path | Settings → General | v0 | Settings → Advanced ("Logs folder", "Data folder") | Hide behind Advanced |
| 23 | Reset all settings | Settings → Reset | v0 | Settings → Data and privacy | Keep |
| 24 | Keyboard shortcuts with Test | Settings → Keyboard shortcuts | v0 Step 13 | Settings → General; §10 step 4 | Keep |
| 25 | Tray menu (open, save point, brief, settings, limits, undo last, pause, show bar, resume braked agent, quit) | `main.js` `updateTray` | v0 | Tray, restyled icon (§4.3); same items | Keep |
| 26 | The bar (pill): protection badge, agent dots, mic, panel arrow, hover row with shortcuts | `renderer/bar.html`, `bar.js`, `bar.css` | spec §23.7 | §11.1 pill, §11.2 dock | Keep, restyle |
| 27 | Ticker of today's changes (−deleted ~changed +created), tap for diff, hold to undo the burst | Bar `#ticker` | own addition (§23.7 expanded) | §11.1 hover row ticker | Keep |
| 28 | Brake from the bar | Bar `#brake` | spec §24 | §11.1 hover row; cards footer; agent list ✕ | Keep |
| 29 | Voice commands from the bar mic (Windows speech) | Bar mic, `app/speech.js`, `engine/voice.js` | spec §23.3 | §11.1 mic; Talk (§11.4) | Keep |
| 30 | "Did you mean" ask card for voice | Bar `#ask` | own addition | §11.3 card style, Mewndo as the agent | Keep |
| 31 | Drift card: resume with corrected brief, let it, stop | Bar `#card` | spec §23.4 | §11.3 Drift card (pounce cat) | Keep |
| 32 | Held actions as chips (approve, cancel, cancel all) | Bar `#chips` | spec §23.4 holds | §11.3 Hold cards in the stack | Merge into cards |
| 33 | Panel: Agents and Connections tabs, per-agent bubbles | Bar `#box` | spec §23.8 | §11.5 panel (Inbox · Agents · Connections · Skills) | Keep |
| 34 | Resume with a Continue card (Claude SessionStart, Codex AGENTS.md, Cursor rule, clipboard) | `engine/continue-card.js`, tray Resume | spec §24.5 | Agents detail "Resume"; tray | Keep |
| 35 | Agent Inbox cards (permission, question, done, drift, receipt) with 2 s grace | `renderer/cards.html`, `app/desk/*` | spec §33 | §11.3 cards; §8.2 Inbox screen | Keep, restyle |
| 36 | Talk box | `renderer/talk.html` | spec §33.5 | §11.4 Talk box | Keep, restyle |
| 37 | Lanes window (placeholder) | `renderer/lanes.html` | spec §33.7 | §8.3 Agent detail lane | Keep |
| 38 | Inbox and Talk keys (Ctrl+Shift+F11, F12) | `main.js` `startDesk` | spec §33.3 | Settings → General shortcuts | Keep |
| 39 | "Rules only mode" note | Bar `#rules-only` | own addition (budget priorities) | §12 Rules only state: loaf cat, pill tooltip, toast once a day, Safety check settings | Merge |
| 40 | Undo from a card through the usual confirmation | `main.js` `undoToSavePoint` | spec §33.4 | §11.3 Done card "Undo this turn"; §8.2 "Undo after this" | Keep |
| 41 | Local MCP server for agents (save point, changes, request delete, project card) | `core` `mcp.rs`, `engine/mewndo.js` | spec §22.3 | Settings → Agents ("Mewndo tools for agents"), Agents chip "MCP" | Keep |
| 42 | Hosted MCP and hub for cloud agents | `cloud/gateway` (`/mcp`, `/hub`) | spec §37.6 K6–K7 | §8.3 Agents "In the cloud" group; §11.12 | Keep |
| 43 | Decision gateway budget, settings table, judge codes | `cloud/gateway` | spec §37 | Settings → Safety check (budget, reset time); Settings → Account (invite code) | Keep |
| 44 | Gmail send guard and Heal; Drive and Notion heal | `cloud/gmail`, `cloud/drive`, `cloud/notion` | spec §25, §28 | §8.5 Connections | Keep |
| 45 | Flight Recorder ledger and verifier | `core` `ledger.rs`, `tools/ledger-verify` | spec §30 | Settings → Labs ("Tamper-proof activity record"), off by default | Hide behind Labs |
| 46 | Receipts (claims vs evidence) | `core/crates/mewndo-trace` | spec §35 | §11.3 Done card receipt line; §8.4 row second line | Keep |
| 47 | Habits (always allow after 3 answers) | `mewndo-router` habits | spec §34.7 | Settings → Habits; Agents detail | Keep (the card is not shown yet) |
| 48 | Learning (shadow) and Active mode per agent | `mewndo-router` | spec §34.6 | §8.3 Safety check segmented control | Keep |
| 49 | Guarded computer use and Show Me | not built (`mewndo-computer` has only the driver pin) | spec §36 | §8.6 Skills; Settings → Computer use | Placeholder until built |
| 50 | Low disk warning | Engine warning, notification | own addition | §12 Error state, toast | Keep |
| 51 | Process freeze and end (brake by freezing) | `core` `process.rs` | spec §24 | Brake button (freezes), Settings → Advanced ("Brake freezes the process") | Keep |

## Appendix A: own additions

| Addition | One-line description | Lives in |
|---|---|---|
| Restore engine choice | Which engine restores files: the fast new one, both side by side, or the original | Settings → Advanced |
| Guard fails open | If the safety check itself can't run, let the agent carry on rather than block it | Settings → Advanced |
| Other agents to watch | Extra program names Mewndo treats as AI agents | Settings → Advanced |
| Background service status | Whether Mewndo's background service is running | Settings → Advanced |
| Change ticker | Today's deleted, changed and created counts on the pill; tap to see them, hold to undo a burst | Pill hover row |
| "Did you mean" voice card | When a voice command is unclear, Mewndo offers its best guesses | Cards, as a card from Mewndo |
| Rules only mode note | The daily safety-check budget is used up, so local rules decide until it resets | Pill tooltip, Safety check settings, a daily toast |
| Tamper-proof activity record | A signed log of what agents did, for later proof | Settings → Labs |
| Low disk warning | Mewndo warns before it runs out of room to keep versions | Toast and Protected folders |
