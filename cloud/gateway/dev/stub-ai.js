// Local test entry for `wrangler dev -c dev/wrangler.stub.toml`: the real gateway with
// a stubbed Workers AI binding, so the core's Clef client can be tested against the real
// Worker (routing, auth, budget, cache) with no Cloudflare account and no neurons spent.
//
// The stub answers every question with a fixed, valid §34.9 R6 answer in the same
// `{response: "<json text>"}` wrapper askWorkersAi already unwraps. It is NOT a capture of
// clef-flash's real output; that is still unverified (docs/decisions.md).
import gateway, { StateDO, HubDO } from '../src/index.js'

export { StateDO, HubDO }

const stubAi = {
  async run(_model, input) {
    const user = input.messages.find((m) => m.role === 'user')
    const req = JSON.parse(user.content)
    const answers = {}
    for (const q of req.questions) {
      if (q.type === 'noul') answers[q.id] = { p_yes: 0.9 }
      else if (q.type === 'score') answers[q.id] = { value: q.scale?.[0] ?? 0 }
      else {
        const options = q.options ?? q.choices
        answers[q.id] = { probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 1 : 0])) }
      }
    }
    return { response: JSON.stringify({ answers }) }
  },
}

export default {
  fetch(request, env, ctx) {
    return gateway.fetch(request, { ...env, AI: stubAi }, ctx)
  },
}
