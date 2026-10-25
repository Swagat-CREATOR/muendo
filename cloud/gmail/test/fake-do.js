// An in-memory stand-in for a Durable Object namespace, for route tests (no Cloudflare account needed).
// Shared by cloud/gmail, cloud/drive and cloud/notion tests.
export function fakeNamespace(DOClass) {
  const objects = new Map()
  return {
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) objects.set(id, new DOClass({ storage: fakeStorage() }))
      const obj = objects.get(id)
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) }
    },
    objects,
  }
}

export function fakeStorage() {
  const m = new Map()
  return {
    m,
    async get(k) {
      if (Array.isArray(k)) return new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))]))
      return m.has(k) ? structuredClone(m.get(k)) : undefined
    },
    async put(k, v) { m.set(k, structuredClone(v)) },
    async delete(k) { return m.delete(k) },
    async deleteAll() { m.clear() },
    async list({ prefix = '', limit = Infinity } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit)
      return new Map(keys.map((k) => [k, structuredClone(m.get(k))]))
    },
  }
}

// Replace global fetch for one test with a router: (url, init) -> Response | object (sent as JSON).
export function withFetch(t, route) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    const r = await route(u, init)
    return r instanceof Response ? r : new Response(JSON.stringify(r ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = real })
  return calls
}
