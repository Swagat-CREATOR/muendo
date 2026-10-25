// The Agent Desk, joined up (spec §33.10 Part E and Part H, §38.3). This is the piece that was missing: the
// modules beside it were written but nothing called them.
//
// It runs in Electron's main process and holds no Electron of its own, so tests drive it with a fake event source
// and fake windows. What it does:
//   core events in  -> cards.js works out what the stack looks like -> the cards window is told to redraw;
//   user keys in    -> cards.js says what that key means for that card -> an `inbox.answer` goes to the core;
//   Talk text in    -> `route.request` to the core -> routing.js says how to deliver what comes back;
//   lane events in  -> lanes.js keeps the lane list -> the lanes window is told to redraw, and gets the bytes;
//   lanes window in -> lanes.js turns start, reply, brake, resize, keystrokes and close into core messages.
//
// §38.3's rule, which shapes all of it: the renderer only displays core events and sends user answers. Every
// decision lives in the core. So nothing here invents a card, an option or a target: the core's `inbox.card` says
// what a card offers, the core's `route.result` says where text goes, and this file only works out how to get it
// there and what to redraw. The one thing it owns is the keyboard, because a key press is not a decision.
const { createCards, keyAction, describe, MIC_HINT } = require('./cards');
const { decide, deliver, chipLabels, resultText, onlyAgent } = require('./routing');
const { createLanes, laneOfAgent, programFor } = require('./lanes');

const MESSAGE_DEADLINE_MS = 6_000; // agent.message: the core answers at once, delivered or queued; silence is reported
const HOLD_EVERY_MS = 10_000; // inbox.hold at most this often per card

// client: app/desk/core-client.js (or a fake). ui: app/desk/windows.js's return (or a fake), minus the windows.
// focus: app/desk/focus.js. commands(command, plan): Mewndo's own commands, which main.js runs through the v0
// confirmation UI of §23.3. problem(message): how the app tells the user something it could not do.
// onAgents(agents): the dock and the layout follow the agent count (§33.1). offerLane({ title, body, options,
// program }): asks "Open a lane" or "Not now" for an agent the Talk box could not reach (Part H).
// dictation(): true when Mewndo's own mic works (app/speech.js), so V on a card records instead of showing the Wispr
// Flow hint. schedule/cancel: setTimeout/clearTimeout, injected in tests, for the `agent.message` deadline.
// sizeTalk(tall): the Talk box needs room for a typing offer's preview (true), or is one line again (false).
// quiet(card): true while Do not disturb keeps this card from popping up (app/quiet.js); it still joins the stack.
// arrived(card): a card the stack didn't have before, e.g. for the card sound.
function createDesk({
  client, ui, focus, log, cards = createCards(), lanes = createLanes({ client }),
  commands = () => {}, problem = () => {}, onAgents = () => {}, onBudget = () => {}, offerLane = null,
  dictation = () => false, schedule = setTimeout, cancel = clearTimeout, messageDeadlineMs = MESSAGE_DEADLINE_MS,
  sizeTalk = () => {}, quiet = () => false, arrived = () => {},
} = {}) {
  const agents = new Map(); // agent_id -> the last agent.status for it
  const laneAgents = new Map(); // lane_id -> agent_id, from agent.status, for Part H's first delivery row
  let answerMode = false; // the Inbox key was pressed: the cards window has focus and the card keys work
  let textFor = null; // { cardId, via, hint } while a text box is open on a card
  let talking = null; // { text, via, chips } while the Talk box waits for, or acts on, a route.result
  const pending = new Map(); // agent_id -> { name, text, via, timer, offerId } while an agent.message or agent.type waits
  let offer = null; // { offerId, agentId, name } while the Talk box asks "Type it" or "Cancel" for an idle agent
  const holds = new Map(); // card_id -> when inbox.hold was last sent for it
  let unsubscribe = [];

  const list = () => [...agents.values()];
  // Every lane the Talk box can deliver to: the running lanes the core reported, and any lane an agent.status named.
  const laneList = () => {
    const running = lanes.list().filter((l) => l.running).map((l) => ({ laneId: l.laneId, agentId: laneAgents.get(l.laneId) ?? null }));
    const named = [...laneAgents.entries()].filter(([laneId]) => !lanes.get(laneId)).map(([laneId, agentId]) => ({ laneId, agentId }));
    return [...running, ...named];
  };

  // Everything the cards window draws. It is sent whole on every change: it is three cards, so there is nothing
  // to gain from diffing, and a renderer that holds no state of its own cannot drift from the core's.
  function view() {
    const { cards: top, more } = cards.visible();
    return {
      cards: top.map((c) => ({ ...describe(c), agent: agents.get(c.agentId)?.name ?? null })),
      more,
      selectedId: cards.selected()?.id ?? null,
      answerMode,
      textFor,
      agents: list().length,
      mic: dictation() === true, // the reply box shows Mewndo's mic button
      empty: emptyShown && !cards.count(), // the dock's Inbox clicked with nothing in it: "All clear."
    };
  }

  const redraw = () => ui?.send?.('cards', 'cards:state', view());

  // The empty Inbox beside the dock ("All clear."). It never takes focus and goes by itself.
  let emptyShown = false;
  let emptyTimer = null;
  const EMPTY_FOR_MS = 4_000;
  function hideEmpty() {
    clearTimeout(emptyTimer);
    if (!emptyShown) return;
    emptyShown = false;
    if (!cards.count()) ui?.hideCards?.();
    redraw();
  }

  // A card id from the renderer that the app no longer has is a stale key press or click on a card that has gone.
  // It must never fall through onto whatever happens to be selected now, which would answer the wrong agent --
  // the same rule the v0 drift card's id check follows in main.js.
  const target = (cardId) => (cardId ? cards.get(cardId) : cards.selected());

  // Cards that still need the user. An answered card is still drawn -- it says "sent", and a Done or Receipt card
  // keeps its Undo (§33.4) -- but it is not something the user has to deal with.
  const needsUser = () => cards.list().some((c) => c.state === 'open' || c.state === 'answering');

  // After an answer, or Esc out of answer mode (§33.10 Part E step 5): hide the card window if nothing is left
  // that needs the user, then hand the keyboard back. The hand-back does not wait for the core to confirm
  // anything, because it is the thing the user feels: their next keystroke belongs to the app they were in.
  function afterAnswer() {
    if (!needsUser()) {
      textFor = null;
      ui?.hideCards?.();
    }
    leaveAnswerMode();
    redraw();
  }

  function leaveAnswerMode() {
    if (!answerMode) return;
    answerMode = false;
    ui?.unfocusCards?.();
    // Only the foreground process may hand focus over, and at this moment that is Electron (§33.10 Part E step 5).
    const ok = focus?.restore?.();
    if (!ok && focus?.reason?.()) log?.info?.(`Mewndo kept the card window and did not hand focus back: ${focus.reason()}`);
  }

  // --- core events ------------------------------------------------------------------------------------------------

  function onCard(event) {
    const fresh = !cards.get(String(event.body?.id ?? ''));
    const card = cards.apply(event);
    if (!card) return;
    // A new card never takes focus: the user keeps typing in whatever app they were in (§33.3). During Do not
    // disturb it doesn't show at all, unless it's a permission request (the Inbox and the dock's badge still count it).
    if (quiet(card) !== true) ui?.showCards?.({ focus: false });
    if (fresh) arrived(card);
    redraw();
  }

  function onRelease(event) {
    if (!cards.apply(event)) return;
    afterAnswer();
  }

  // The core accepted Undo on a card: restoring to its save point goes through v0 and §23.3's confirmation.
  function onUndo(event) {
    const savepointId = event.body?.savepoint_id;
    if (savepointId) commands('undo-to', { savepointId, cardId: event.body.card_id ?? null });
    else problem('That answer has no save point, so there is nothing to undo it to.');
  }

  function onAgentStatus(event) {
    const b = event.body ?? {};
    if (!b.agent_id) return;
    agents.set(String(b.agent_id), {
      agentId: String(b.agent_id),
      kind: b.kind ?? null,
      name: b.name ?? String(b.agent_id),
      connection: b.connection ?? null,
      status: b.status ?? null,
      lastLine: b.last_line ?? null,
    });
    // The lane an agent runs in: agent.status's lane_id (every agent, Claude Code included), or for Codex and
    // Cursor also their agent id ("lane:<lane id>"). That is Part H's first delivery row.
    const inLane = b.lane_id ?? laneOfAgent(b.agent_id);
    if (inLane) laneAgents.set(String(inLane), String(b.agent_id));
    if (b.status === 'gone') agents.delete(String(b.agent_id));
    onAgents(list());
    redraw();
  }

  // The Router answered. Confidence 0.7 or higher is delivered; below that the top two become chips (Part H step 2).
  function onRoute(event) {
    if (!talking) return;
    const { deliver: target, chips, confidence } = decide(event.body);
    if (target) return send(target);
    talking = { ...talking, chips };
    ui?.send?.('talk', 'talk:chips', { chips: chipLabels(chips, { agents: list() }), confidence });
    if (!chips.length) {
      problem('Mewndo could not work out where that should go.');
      closeTalk();
    }
    return undefined;
  }

  // --- lanes (§33.7, Part G) ---------------------------------------------------------------------------------------

  // Everything the lanes window draws, sent whole on every change, like the cards window's state.
  function laneView() {
    return {
      lanes: lanes.list().map((l) => ({ ...l, agentId: laneAgents.get(l.laneId) ?? null })),
      connected: client?.connected?.() ?? true,
    };
  }
  const redrawLanes = () => ui?.send?.('lanes', 'lanes:state', laneView());

  function onLane(event) {
    const lane = lanes.apply(event);
    if (!lane) return;
    if (lane.removed) laneAgents.delete(lane.laneId);
    redrawLanes();
  }

  // Terminal output: the bytes go to the lanes window as they are, for its terminal to draw.
  function onLaneData(event) {
    lanes.output(event.lane, event.data);
    ui?.send?.('lanes', 'lanes:data', { laneId: String(event.lane), data: event.data });
  }

  // The core refused a lane.open ("claude is not on PATH"): the lanes window shows the core's words.
  function onLaneError(event) {
    const failed = lanes.failed(event);
    if (failed) ui?.send?.('lanes', 'lanes:error', failed);
  }

  // What the lanes window asks for (`lanes:action`). Returns whether it was sent.
  function laneAction(action, laneId, arg) {
    switch (action) {
      case 'open':
        // Show the window on that lane, and ask the core for its replay buffer so the terminal starts where the
        // lane is now (§33.7: the session survives the window).
        if (laneId) ui?.showLanes?.(laneId);
        return laneId ? lanes.attach(laneId) : false;
      case 'start': {
        const sent = lanes.start(arg ?? {});
        if (!sent) {
          const message = 'Mewndo can start Claude, Codex or Cursor in a lane, in a folder, while it is connected to the core.';
          problem(message);
          ui?.send?.('lanes', 'lanes:error', { program: arg?.program ?? null, cwd: arg?.cwd ?? null, message });
        }
        return sent;
      }
      case 'reply': return lanes.reply(laneId, arg);
      case 'brake': return lanes.brake(laneId);
      case 'resize': return lanes.resize(laneId, arg?.rows, arg?.cols);
      case 'type': return lanes.type(laneId, arg);
      case 'attach': return lanes.attach(laneId);
      case 'close': return lanes.close(laneId);
      default: return false;
    }
  }

  // --- delivery (Part H step 3) -----------------------------------------------------------------------------------

  function send(target) {
    const { text, via } = talking ?? {};
    const canMessage = client?.speaks?.('agent.message') === true;
    const plan = deliver(target, { agents: list(), cards: cards.list(), lanes: laneList(), text, via, canMessage });
    let sent = false;
    switch (plan.how) {
      case 'lane':
        sent = client?.sendLane?.(plan.lane, plan.bytes);
        break;
      case 'reply':
      case 'followup':
        // Both are an ordinary inbox answer: the core turns it into Claude's block reason or Cursor's
        // followup_message (§33.6). The app does not pick the wire shape, only the card it answers.
        sent = client?.send?.('inbox.answer', plan.answer);
        break;
      case 'message':
        return message(plan);
      case 'command':
        // Undo, brake and resume call the existing v0 and §24 functions, with §23.3's confirmation UI.
        commands(plan.command, plan);
        break;
      default:
        // Part H says this is a card. The card stack is fed only by the core (§38.3), so main.js asks it the way
        // Mewndo asks its own questions (offerLane), with the lane picker set to that agent. Without that, the
        // Talk box says what it cannot do.
        cantReach(plan.card, plan.agent);
        break;
    }
    // Spoken words are shown in the box, so the box also says where they went before it goes (reference 11).
    if (via === 'voice' && sent && plan.agent) return showResult({ tone: 'sent', text: `Sent to ${plan.agent}.`, options: [] });
    closeTalk();
    return plan;
  }

  function cantReach(card, name) {
    if (offerLane) offerLane({ ...card, program: programFor(agents.get(card.agentId)?.kind) ?? programFor(name) });
    else problem(`${card.title} ${card.body}`);
  }

  // The Talk box stays up to say what happened, the keyboard goes back to the user's app at once, and the box
  // closes itself a moment later (talk.js).
  function showResult(result) {
    talking = null;
    ui?.send?.('talk', 'talk:status', result);
    leaveAnswerMode();
    return result;
  }

  // No lane and no open reply window: the core delivers it, now to a hook that is waiting or when the agent next
  // stops, and answers `agent.message.result`. Silence past the deadline is said as silence, never as "sent".
  function message(plan) {
    if (!client?.send?.('agent.message', plan.body)) {
      problem(`Mewndo is not connected to the core, so ${plan.agent} did not get that.`);
      closeTalk();
      return plan;
    }
    const before = pending.get(plan.agentId);
    if (before) cancel(before.timer);
    const timer = schedule(() => settle(plan.agentId, null), messageDeadlineMs);
    timer?.unref?.();
    pending.set(plan.agentId, { name: plan.agent, text: plan.body.text, via: plan.body.via, timer });
    showResult({ tone: 'sending', text: `Sending to ${plan.agent}…`, options: [] });
    return plan;
  }

  function settle(agentId, result) {
    const wait = pending.get(agentId);
    if (!wait) return null; // a late answer for a message already reported
    pending.delete(agentId);
    cancel(wait.timer);
    const said = resultText(result, wait.name);
    if (said.tone === 'confirm') {
      confirmTyping(agentId, wait.name, said);
    } else if (result?.delivered === 'unsupported') {
      // The same offer as a target Mewndo can't reach at all: open a lane, where replies always arrive.
      ui?.hideTalk?.();
      cantReach({ kind: 'question', agentId, title: said.text, body: said.body, options: said.options }, wait.name);
    } else {
      ui?.send?.('talk', 'talk:status', said);
    }
    if (said.tone === 'failed') log?.info?.(`agent.message to ${wait.name}: ${said.text}`);
    return said;
  }

  // The agent is idle at its prompt and the core can type into its terminal: the Talk box shows why, the exact text
  // in quotes, and "1 Type it" / "2 Cancel". It takes the keyboard for that, and gives it back on either answer.
  // Nothing is typed unless the user picks Type it (the limits in docs/decisions.md).
  function confirmTyping(agentId, name, said) {
    offer = { offerId: said.offerId, agentId, name };
    focus?.save?.();
    answerMode = true;
    sizeTalk(true);
    ui?.showTalk?.({ focus: true });
    ui?.send?.('talk', 'talk:confirm', { text: said.text, preview: said.preview, options: said.options });
  }

  // "Type it": the core types only the text it stored and showed, so the offer's id is all that goes.
  function typeIt() {
    const o = offer;
    offer = null;
    if (!o) return false;
    sizeTalk(false);
    if (!client?.send?.('agent.type', { offer_id: o.offerId })) {
      problem(`Mewndo is not connected to the core, so nothing was typed into ${o.name}'s terminal.`);
      closeTalk();
      return false;
    }
    const before = pending.get(o.agentId);
    if (before) cancel(before.timer);
    const timer = schedule(() => settle(o.agentId, null), messageDeadlineMs);
    timer?.unref?.();
    pending.set(o.agentId, { name: o.name, text: '', via: 'key', timer, offerId: o.offerId });
    showResult({ tone: 'sending', text: `Typing into ${o.name}'s terminal…`, options: [] });
    return true;
  }

  // Which pending message a result answers: by its agent, or, for an offer the core no longer knows (and so can't
  // name the agent of), by the offer it echoes.
  function resultFor(body) {
    const agentId = String(body?.agent_id ?? '');
    if (agentId && pending.has(agentId)) return agentId;
    const byOffer = body?.offer_id ? [...pending].find(([, w]) => w.offerId === body.offer_id)?.[0] : null;
    return byOffer ?? agentId;
  }

  // An older core answers `agent.message` with "unknown message type": then it is today's "can't reach".
  function onError(event) {
    if (!/unknown message type agent\.message\b/.test(String(event.body?.message ?? ''))) return;
    for (const [agentId, wait] of pending) {
      pending.delete(agentId);
      cancel(wait.timer);
      ui?.hideTalk?.();
      const plan = deliver(agentId, { agents: list(), text: wait.text, via: wait.via });
      if (plan.how === 'unreachable') cantReach(plan.card, plan.agent);
    }
  }

  // inbox.hold: the user is writing or saying a reply to a Done card, so the core keeps the agent's Stop hook
  // waiting longer. At most once every few seconds per card; an older core that doesn't take it is not asked again.
  function hold(cardId) {
    const card = cards.get(cardId);
    if (!card || card.kind !== 'done' || card.state !== 'open') return false;
    const now = Date.now();
    if (now - (holds.get(card.id) ?? -Infinity) < HOLD_EVERY_MS) return false;
    if (client?.speaks?.('inbox.hold') === false) return false;
    holds.set(card.id, now);
    return client?.send?.('inbox.hold', { card_id: card.id }) === true;
  }

  // The user let a held Done card go (dismissed it, or left answer mode) without answering: the core stops keeping
  // the agent's Stop hook waiting, so the agent isn't held for minutes by a card nobody is writing on.
  function unhold(cardId) {
    if (!holds.delete(cardId)) return;
    client?.send?.('inbox.hold', { card_id: cardId, held: false });
  }

  // Answer mode without the Inbox key: the user clicked into a card. The cards window is not activated by that
  // click (windows.js), so the window they were in is still the foreground one and is what gets saved.
  function enterAnswerMode() {
    if (answerMode) return;
    focus?.save?.();
    answerMode = true;
    ui?.showCards?.({ focus: true });
  }

  // --- the user ---------------------------------------------------------------------------------------------------

  // One card key (§33.2). The renderer reports the key and the card it was on; what it means is worked out here.
  function onKey(key, cardId) {
    // A card id the app doesn't have is a stale key, not one for whichever card is selected now.
    const card = cardId ? cards.get(cardId) : cards.selected();
    if (!card) return null;
    const action = keyAction(card, key);
    if (!action) return null;
    switch (action.action) {
      case 'move':
        cards.move(action.delta);
        textFor = null;
        redraw();
        break;
      case 'answer':
        answer(card.id, { choice: action.choice, via: 'key' });
        break;
      case 'voice':
        if (dictation() === true) {
          // Mewndo's own mic: V starts recording into the reply box, V again stops; the words land in the box for
          // the user to check and send with Enter. Nothing is sent by speaking alone.
          const listening = textFor?.cardId === card.id && textFor.mic === 'listening';
          textFor = listening
            ? { cardId: card.id, via: 'voice', hint: 'Writing down what you said…', mic: 'working' }
            : { cardId: card.id, via: 'voice', hint: MIC_HINT, mic: 'listening' };
          if (!listening) hold(card.id);
          redraw();
          break;
        }
      // falls through: without Mewndo's mic, V opens the same box with the Wispr Flow hint (§33.5)
      case 'text':
        textFor = { cardId: card.id, via: action.action === 'voice' ? 'voice' : 'key', hint: action.hint };
        hold(card.id);
        redraw();
        break;
      case 'undo':
        // "Undo everything the agent did after this answer", from the save point the release wrote (§33.4).
        client?.send?.('inbox.undo', { card_id: card.id, savepoint_id: card.savepointId ?? null });
        break;
      case 'dismiss':
        unhold(card.id);
        cards.dismiss(card.id);
        if (textFor?.cardId === card.id) textFor = null;
        afterAnswer();
        break;
      case 'take-back':
        // Esc during the grace: nothing was sent, so the card reopens and focus stays here.
        cards.takeBack(card.id);
        redraw();
        break;
      case 'leave':
        // Esc out of answer mode: the stack stays, the window goes, the keyboard goes back.
        for (const id of [...holds.keys()]) unhold(id);
        textFor = null;
        ui?.hideCards?.();
        leaveAnswerMode();
        redraw();
        break;
      case 'confirm':
        // Enter confirms whatever the user is in. Inside a text box the renderer sends the text itself
        // (`desk:text`), so there is nothing left for Enter to mean here.
        break;
      default:
        break;
    }
    return action;
  }

  // A click does what the same key does, so there is one path and one set of rules (§33.3 step 3).
  function onClick(action, cardId, arg) {
    if (action === 'close-empty') { hideEmpty(); return; }
    // A card id the app doesn't have is a stale key, not one for whichever card is selected now.
    const card = cardId ? cards.get(cardId) : cards.selected();
    if (!card) return;
    if (action === 'select') { cards.select(card.id); enterAnswerMode(); redraw(); return; }
    if (action === 'answer') { answer(card.id, { choice: Number(arg), via: 'click' }); return; }
    if (action === 'dismiss') { unhold(card.id); cards.dismiss(card.id); afterAnswer(); return; }
    if (action === 'undo') { client?.send?.('inbox.undo', { card_id: card.id, savepoint_id: card.savepointId ?? null }); return; }
    if (action === 'take-back') { cards.takeBack(card.id); redraw(); }
  }

  // The answer waits for the grace bar, which is a CSS animation in the renderer: no JS timer on this path
  // (§33.10 speed rules). Its animationend arrives as `desk:grace-end`.
  function answer(cardId, { choice = null, text = null, via = 'key' } = {}) {
    const started = cards.startAnswer(cardId, { choice, text, via });
    if (!started) return null; // a second answer while one waits is ignored (§33.4)
    if (textFor?.cardId === cardId) textFor = null;
    redraw();
    // A grace of 0 has no animation to end, so the renderer would never report one.
    if (!started.graceMs) graceEnd(cardId);
    return started;
  }

  function graceEnd(cardId) {
    const card = cards.get(cardId);
    const out = cards.release(cardId);
    if (!out) return null;
    holds.delete(cardId);
    // Nothing waits behind a Codex Done card (its Stop hook can't wait), so a reply typed or said on it would be
    // lost as an inbox answer. It goes as an agent.message: the core queues it for Codex's next stop, or says why not.
    const agent = card?.kind === 'done' && out.text ? agents.get(String(card.agentId)) : null;
    if (agent?.kind === 'codex' && client?.speaks?.('agent.message') === true) {
      afterAnswer();
      ui?.showTalk?.({ focus: false });
      return message({ how: 'message', agent: agent.name ?? 'Codex', agentId: agent.agentId,
        body: { agent_id: agent.agentId, text: out.text, via: out.via ?? 'key' } });
    }
    const sent = client?.send?.('inbox.answer', out);
    if (!sent) {
      // What it can't do: the answer was held in the app for the grace, so a core that went away in those two
      // seconds loses it. The agent then waits for its hook timeout, which is what happens when nobody answers.
      log?.warn?.(`Mewndo could not send the answer to ${cardId}: the core is not connected.`);
      problem('Mewndo lost its connection to the core, so that answer did not reach the agent.');
    }
    afterAnswer();
    return out;
  }

  function closeTalk() {
    talking = null;
    if (offer) { offer = null; sizeTalk(false); } // Cancel, Esc, or the box closing itself: nothing is typed
    ui?.hideTalk?.();
    leaveAnswerMode();
  }

  return {
    start() {
      unsubscribe = [
        client.on('inbox.card', onCard),
        client.on('inbox.release', onRelease),
        client.on('inbox.expired', onRelease),
        client.on('inbox.undo', onUndo),
        // The gateway's day budget: the dock says "Rules only mode" while the model can't be reached (§37.2).
        client.on('budget.state', (event) => onBudget(event.body?.rules_only === true)),
        client.on('agent.status', onAgentStatus),
        client.on('route.result', onRoute),
        client.on('agent.message.result', (event) => settle(resultFor(event.body), event.body)),
        client.on('error', onError),
        client.on('lane.opened', onLane),
        client.on('lane.closed', onLane),
        client.on('lane', onLaneData),
        client.on('error', onLaneError),
        // The core keeps its lanes when a connection drops and re-sends lane.opened for each on reconnect.
        client.on('closed', () => { lanes.forget(); redrawLanes(); }),
      ];
      client.start?.();
    },

    stop() {
      for (const off of unsubscribe) off?.();
      unsubscribe = [];
      client.stop?.();
    },

    // The Inbox key (§33.3 step 1): remember the window the user was in, show the stack, focus the top card.
    openInbox() {
      if (!cards.count()) {
        ui?.hideCards?.();
        return false;
      }
      focus?.save?.();
      answerMode = true;
      cards.select(cards.list()[0].id);
      redraw();
      ui?.showCards?.({ focus: true });
      return true;
    },

    // The Talk key (§33.10 Part H step 1): the same save, then the one-line input takes focus.
    // to: an agent's name when the Talk box was opened from that agent's row in the agent list; the text then goes
    // straight to it instead of through the Router.
    openTalk(to = null) {
      if (offer) { offer = null; sizeTalk(false); }
      focus?.save?.();
      answerMode = true;
      talking = { text: '', via: 'key', chips: [], to };
      ui?.showTalk?.({ to });
      return true;
    },

    // The dock's Inbox capsule clicked with nothing to answer: the empty Inbox shows beside the dock for a few
    // seconds, without taking focus. (The Inbox key still does nothing then; see openInbox.) True when shown.
    showEmptyInbox() {
      if (cards.count() || !ui?.showCards) return false;
      emptyShown = true;
      redraw();
      ui.showCards({ focus: false });
      clearTimeout(emptyTimer);
      emptyTimer = setTimeout(hideEmpty, EMPTY_FOR_MS);
      emptyTimer.unref?.();
      return true;
    },

    // Hovering the dock's "Claude needs you" chip (reference 16): the stack shows, without taking focus.
    peek() {
      if (!cards.count()) return false;
      redraw();
      ui?.showCards?.({ focus: false });
      return true;
    },

    // Words said to the dock's mic that are not a Mewndo command (engine/voice.js classify): they appear in the
    // Talk box as they were heard and go to an agent. One agent: that one. More: the core's Router, and its chips
    // when it isn't sure. The box never takes focus for this. False when there is no core to ask.
    say(text, { via = 'voice' } = {}) {
      const trimmed = String(text ?? '').trim();
      if (!trimmed) return false;
      const to = talking?.to ?? null; // the Talk box is open, aimed at one agent: the words go there
      const only = to ? null : onlyAgent(list());
      if (!client || (!to && !only && client.connected?.() === false)) return false;
      if (offer) { offer = null; sizeTalk(false); } // new words replace an offer nobody answered: nothing is typed
      talking = { text: trimmed, via, chips: [], to };
      ui?.showTalk?.({ focus: false });
      ui?.send?.('talk', 'talk:dictated', { text: trimmed });
      if (to) { send(to); return true; }
      if (only) { send(only.agentId); return true; }
      if (!client?.send?.('route.request', { text: trimmed })) {
        talking = null;
        ui?.hideTalk?.();
        return false;
      }
      return true;
    },

    // What the renderers send back (app/desk/windows.js's `on`).
    handlers: {
      key: onKey,
      click: onClick,
      graceEnd,
      text: (cardId, text, via) => answer(cardId, { text, via }),
      // The card's dictation came back from speech.js: the words go into its reply box, not to the agent.
      dictated(cardId, text) {
        if (textFor?.cardId !== cardId) return null;
        const words = String(text ?? '').trim();
        textFor = {
          cardId, via: 'voice', mic: null, draft: words,
          hint: words ? 'Check it, then Enter to send' : "Mewndo didn't catch that. Type it, or press V to try again.",
        };
        redraw();
        return textFor;
      },
      hold,
      talk(text) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) return closeTalk();
        const to = talking?.to ?? null;
        talking = { text: trimmed, via: talking?.via === 'voice' ? 'voice' : 'key', chips: [], to };
        // Aimed at one agent from its row: straight there. Otherwise the core's Router decides where it goes (§34.5);
        // the app never routes by itself.
        if (to) { send(to); return undefined; }
        if (!client?.send?.('route.request', { text: trimmed })) {
          problem('Mewndo is not connected to the core, so it cannot work out where that should go.');
          closeTalk();
        }
        return undefined;
      },
      chip(n) {
        // A typing offer: 1 types it, 2 cancels. Nothing else is a chip while it is up.
        if (offer) {
          if (Number(n) === 1) typeIt();
          else if (Number(n) === 2) closeTalk();
          return;
        }
        const target = talking?.chips?.[Number(n) - 1];
        if (target) send(target);
      },
      closeTalk,
      lane: laneAction,
    },

    // For the layout and the tests.
    agents: list,
    lanes: laneList,
    laneView,
    cards: () => cards,
    view,
    answerMode: () => answerMode,
    talking: () => talking,
    offer: () => offer,
  };
}

module.exports = { createDesk, MESSAGE_DEADLINE_MS, HOLD_EVERY_MS };
