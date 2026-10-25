// Every network call Connections makes goes through here: a hard deadline on each one (CLAUDE.md rule 3), and any
// secret in hand cut out of error messages before they can reach the log (fetch's own errors can quote headers).

class DeadlineError extends Error {
  constructor(what, ms) {
    super(`${what} didn’t answer within ${Math.round(ms / 1000)} s.`);
    this.code = 'DEADLINE';
  }
}

function scrub(text, secrets) {
  let s = String(text ?? '');
  for (const secret of secrets) if (secret && secret.length >= 6) s = s.split(secret).join('[secret]');
  return s;
}

// -> { status, ok, headers, data }. data is parsed JSON, or null for an empty or non-JSON body.
// what: words for messages ("the Gmail Worker"). Throws DeadlineError, or an Error with secrets removed.
async function requestJson(fetchFn, url, { method = 'GET', headers = {}, body, deadlineMs = 10_000, secrets = [], what = 'The server' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const res = await fetchFn(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, ok: res.ok, headers: res.headers, data };
  } catch (e) {
    if (e?.name === 'AbortError' || controller.signal.aborted) throw new DeadlineError(what, deadlineMs);
    throw new Error(`${what} couldn’t be reached: ${scrub(e?.cause?.message ?? e?.message, secrets)}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { requestJson, DeadlineError, scrub };
