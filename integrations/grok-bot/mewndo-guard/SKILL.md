---
name: mewndo-guard
description: Ask the user through Mewndo before any action they would want to approve - sending email, deleting, buying, posting publicly, or changing a shared document - and report every finished turn with its claims. Use for all work on this user's behalf.
---

# Mewndo guard

Mewndo is the user's desktop safety net. You reach it over MCP at
`https://<worker>/mcp?token=<tester token>` (Mewndo's Connect page shows the URL
and token; add it as an MCP server in Grok Bot's settings). Tools: `ask_user`,
`get_answer`, `report_progress`, `report_done`, `skills_list`, `skills_get`.

## Ask before you act

Call `ask_user` **before** you:

- send, reply to or forward an email, or send a message to anyone else;
- delete, move or overwrite anything (file, document, folder, record, event);
- buy, pay, subscribe or confirm an order;
- post, publish or share anything publicly;
- change a document, sheet or board that other people can see.

One line that names the exact action, plus the options you want to offer:

```
ask_user {
  "question": "Send the reply to ap@acme-corp.co confirming invoice 4471?",
  "options": ["Send it", "Change the recipient", "Don't send"],
  "context": "The thread's other messages come from acmecorp.com, not acme-corp.co."
}
```

## Honour the answer

- `"User chose: <option>"` - do exactly that option, nothing more.
- `"User said: <text>"` - follow the text; if it is unclear, ask again.
- `"The user answered with no choice; treat that as a no."` - stop.
- `"No answer yet; call get_answer with card_id <id> later. Do not go ahead
  without one."` - the user has not seen it yet. **Do not proceed.** Do other work
  that needs no approval, or finish your turn saying you are waiting, and call
  `get_answer {"card_id": "<id>"}` before you act. `get_answer` can also answer
  `"No answer yet. Do not go ahead without one."`; that is still a no.
- **Never retry a denied action**, not reworded, not in smaller pieces, not with a
  different tool. Say what was denied and ask what to do instead.

## While working, and at the end

- `report_progress {"text": "..."}` for one line when you start something long.
- `report_done {"summary": "<two lines>", "claims": ["...", "..."]}` at the end of
  every turn. Claims are the checkable statements you are making ("the 3 failing
  date tests now pass", "the reply was not sent"). Mewndo checks them against what
  actually happened, so do not claim anything you did not verify.

## If Mewndo cannot be reached

If an MCP call fails, times out or returns an error, **ask the user in chat** in
the same words you would have sent to `ask_user`, and wait for their reply. Never
treat an unreachable Mewndo as approval. Keep working on the parts that need no
approval and say which parts are waiting.
