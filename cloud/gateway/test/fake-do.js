'use strict'
// Fakes for the Workers runtime, shared by the tests. Only what the gateway
// actually uses: Durable Object storage, a Durable Object namespace, the Workers
// AI binding and the execution context.
import { StateDO } from '../src/index.js'

// The Durable Object storage API, as much of it as State uses. Values are cloned
// in and out, like the real one, so a test can't mutate stored state by accident.
function fakeStorage() {
  const map = new Map()
  return {
    map,
    async get(key) {
      if (Array.isArray(key)) {
        const out = new Map()
        for (const k of key) if (map.has(k)) out.set(k, structuredClone(map.get(k)))
        return out
      }
      return map.has(key) ? structuredClone(map.get(key)) : undefined
    },
    async put(entries) {
      for (const [k, v] of Object.entries(entries)) map.set(k, structuredClone(v))
    },
    async delete(key) {
      return map.delete(key)
    },
    async list({ prefix } = {}) {
      const out = new Map()
      for (const [k, v] of [...map].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!prefix || k.startsWith(prefix)) out.set(k, structuredClone(v))
      }
      return out
    },
  }
}

const ADMIN_SECRET = 'admin-secret'
const GATEWAY_SECRET = 'kaggle-secret'

// One Durable Object instance behind the STATE binding, plus an AI binding whose
// answer each test chooses. `ai` is called with (model, input) and may throw.
function fakeEnv({ ai, storage = fakeStorage(), ...over } = {}) {
  const object = new StateDO({ storage })
  const calls = []
  return {
    storage,
    calls,
    ADMIN_SECRET,
    GATEWAY_SECRET,
    AI: ai
      ? {
        run: async (model, input) => {
          calls.push({ model, input })
          return ai(model, input)
        },
      }
      : undefined,
    STATE: {
      idFromName: (name) => name,
      get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }),
    },
    ...over,
  }
}

// Collects what the Worker defers, so a test can wait for the caching and the
// neuron correction before it looks at storage.
function fakeCtx() {
  const pending = []
  return { waitUntil: (p) => pending.push(p), settled: () => Promise.allSettled(pending) }
}

export { fakeStorage, fakeEnv, fakeCtx, ADMIN_SECRET, GATEWAY_SECRET }
