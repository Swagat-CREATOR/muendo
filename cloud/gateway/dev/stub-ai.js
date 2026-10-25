// Local test entry for `wrangler dev -c dev/wrangler.stub.toml`: the real gateway with
// a stubbed Workers AI binding, so the core's Clef client can be tested against the real
// Worker (routing, auth, budget, cache) with no Cloudflare account and no neurons spent.
//
// The stub answers every question with a fixed answer in clef-flash's documented output shape. It is NOT a capture of
// clef-flash's real output; that is still unverified (docs/decisions.md).
import gateway, { StateDO, HubDO } from '../src/index.js'

export { StateDO, HubDO }

const stubAi = {
  async run(_model, input) {
    // Whisper (POST /v1/transcribe): a fixed transcript, not real recognition.
    if (Array.isArray(input.audio)) return { text: ' stub transcript ', word_count: 2 }
    // clef-flash's documented output shape (workers-ai-models/clef-flash.json), with fixed values.
    const answers = {}
    for (const [id, q] of Object.entries(input.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 }
      else if (q.type === 'score') answers[id] = { type: 'score', score: 0, legend: {}, probabilities: { 0: 1 }, confidence: 1 }
      else {
        const options = Object.keys(q.criteria)
        answers[id] = { type: 'choice', choice: options[0], probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 1 : 0])), confidence: 1 }
      }
    }
    return { model: input.model, answers, usage: { input_tokens: 100, output_tokens: 1 } }
  },
}

export default {
  fetch(request, env, ctx) {
    return gateway.fetch(request, { ...env, AI: stubAi }, ctx)
  },
}
