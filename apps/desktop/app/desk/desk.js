// The Agent Desk, joined up (spec §33.10 Part E and Part H, §38.3). This is the piece that was missing: the
// modules beside it were written but nothing called them.
//
// It runs in Electron's main process and holds no Electron of its own, so tests drive it with a fake event source
// and fake windows. What it does:
//   core events in  -> cards.js works out what the stack looks like -> the cards window is told to redraw;
//   user keys in    -> cards.js says what that key means for that card -> an `inbox.answer` goes to the core;
//   Talk text in    -> `route.request` to the core -> routing.js says how to deliver what comes back.
//
// §38.3's rule, which shapes all of it: the renderer only displays core events and sends user answers. Every
// decision lives in the core. So nothing here invents a card, an option or a target: the core's `inbox.card` says
// what a card offers, the core's `route.result` says where text goes, and this file only works out how to get it
// there and what to redraw. The one thing it owns is the keyboard, because a key press is not a decision.
const { createCards, keyAction, describe } = require('./cards');
const { decide, deliver, chipLabels } = require('./routing');

// client: app/desk/core-client.js (or a fake). ui: app/desk/windows.js's return (or a fake), minus the windows.
// focus: app/desk/focus.js. commands(command, plan): Mewndo's own commands, which main.js runs through the v0
// confirmation UI of §23.3. problem(message): how the app tells the user something it could not do.
// onAgents(agents): the dock and the layout follow the agent count (§33.1).
function createDesk({
  client, ui, focus, log, cards = createCards(),
  commands = () => {}, problem = () => {}, onAgents = () => {}, onBudget = () => {},
} = {}) {
  const agents = new Map(); // agent_id -> the last agent.status for it
  const lanes = new Map(); // lane_id -> agent_id, for Part H's first delivery row
  let answerMode = false; // the Inbox key was pressed: the cards window has focus and the card keys work
  let textFor = null; // { cardId, via, hint } while a text box is open on a card
  let talking = null; // { text, via, chips } while the Talk box waits for, or acts on, a route.result
  let unsubscribe = [];

  const list = () => [...agents.values()];
  const laneList = () => [...lanes.entries()].map(([laneId, agentId]) => ({ laneId, agentId }));

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
    };
  }

  const redraw = () => ui?.send?.('cards', 'cards:state', view());

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
    // Only the foreground process may hand focus over, and at this moment that is Electron (§33.10 Part E step 5).
    const ok = focus?.restore?.();
    if (!ok && focus?.reason?.()) log?.info?.(`Mewndo kept the card window and did not hand focus back: ${focus.reason()}`);
  }

  // --- core events ------------------------------------------------------------------------------------------------

  function onCard(event) {
    const card = cards.apply(event);
    if (!card) return;
    // A new card never takes focus: the user keeps typing in whatever app they were in (§33.3).
    ui?.showCards?.({ focus: false });
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
    // §38.5's agent.status carries no lane id today. If the core ever adds one, Part H's first delivery row starts
    // working without another change here; until then `lanes` stays empty and a reply to a lane is unreachable.
    if (b.lane_id) lanes.set(String(b.lane_id), String(b.agent_id));
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

  // --- delivery (Part H step 3) -----------------------------------------------------------------------------------

  function send(target) {
    const { text, via } = talking ?? {};
    const plan = deliver(target, { agents: list(), cards: cards.list(), lanes: laneList(), text, via });
    switch (plan.how) {
      case 'lane':
        client?.sendLane?.(plan.lane, plan.bytes);
        break;
      case 'reply':
      case 'followup':
        // Both are an ordinary inbox answer: the core turns it into Claude's block reason or Cursor's
        // followup_message (§33.6). The app does not pick the wire shape, only the card it answers.
        client?.send?.('inbox.answer', plan.answer);
        break;
      case 'command':
        // Undo, brake and resume call the existing v0 and §24 functions, with §23.3's confirmation UI.
        commands(plan.command, plan);
        break;
      default:
        // Part H says this is a card. The card stack is fed only by the core (§38.3), and Mewndo cannot offer
        // "Open a lane" until lanes are built, so the Talk box says what it cannot do instead of showing a
        // button that would not work.
        problem(`${plan.card.title} ${plan.card.body}`);
        break;
    }
    closeTalk();
    return plan;
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
      case 'text':
      case 'voice':
        // Space and V open the same box; V adds the Wispr Flow hint, because Mewndo has no speech engine (§33.5).
        textFor = { cardId: card.id, via: action.action === 'voice' ? 'voice' : 'key', hint: action.hint };
        redraw();
        break;
      case 'undo':
        // "Undo everything the agent did after this answer", from the save point the release wrote (§33.4).
        client?.send?.('inbox.undo', { card_id: card.id, savepoint_id: card.savepointId ?? null });
        break;
      case 'dismiss':
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
    // A card id the app doesn't have is a stale key, not one for whichever card is selected now.
    const card = cardId ? cards.get(cardId) : cards.selected();
    if (!card) return;
    if (action === 'select') { cards.select(card.id); redraw(); return; }
    if (action === 'answer') { answer(card.id, { choice: Number(arg), via: 'click' }); return; }
    if (action === 'dismiss') { cards.dismiss(card.id); afterAnswer(); return; }
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
    const out = cards.release(cardId);
    if (!out) return null;
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
    openTalk() {
      focus?.save?.();
      answerMode = true;
      talking = { text: '', via: 'key', chips: [] };
      ui?.showTalk?.();
      return true;
    },

    // What the renderers send back (app/desk/windows.js's `on`).
    handlers: {
      key: onKey,
      click: onClick,
      graceEnd,
      text: (cardId, text, via) => answer(cardId, { text, via }),
      talk(text) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) return closeTalk();
        talking = { text: trimmed, via: talking?.via === 'voice' ? 'voice' : 'key', chips: [] };
        // The core's Router decides where it goes (§34.5). The app never routes by itself.
        if (!client?.send?.('route.request', { text: trimmed })) {
          problem('Mewndo is not connected to the core, so it cannot work out where that should go.');
          closeTalk();
        }
        return undefined;
      },
      chip(n) {
        const target = talking?.chips?.[Number(n) - 1];
        if (target) send(target);
      },
      closeTalk,
      lane(action, laneId) {
        if (action === 'open' && laneId) ui?.showLanes?.(laneId);
      },
    },

    // For the layout and the tests.
    agents: list,
    lanes: laneList,
    cards: () => cards,
    view,
    answerMode: () => answerMode,
    talking: () => talking,
  };
}

module.exports = { createDesk };
