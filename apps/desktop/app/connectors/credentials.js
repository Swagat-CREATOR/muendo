// Secrets for Connections live in Windows Credential Manager, never in a file or a log (CLAUDE.md rule 4,
// spec §25.4). Generic credentials, current user, through koffi (the same way app/speech.js reads the gateway's
// device token). What it can't do: anything off Windows; there it says so and nothing is saved.
//
//   Mewndo/github-token        the fine-grained personal access token the user pasted
//   Mewndo/gmail-app-token     the app token the Gmail Worker issued at sign-in (not a Google token)
//   Mewndo/drive-app-token     the same for the Drive Worker
//   Mewndo/notion-app-token    the same for the Notion Worker (the Notion secret itself stays in the Worker)

const TARGETS = {
  github: 'Mewndo/github-token',
  gmail: 'Mewndo/gmail-app-token',
  drive: 'Mewndo/drive-app-token',
  notion: 'Mewndo/notion-app-token',
};

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2; // this user on this PC; not roamed to other PCs

// A secret from a credential's bytes: UTF-16LE (what cmdkey, the Credential Manager window and Mewndo write) or
// UTF-8. Anything that isn't one plain printable word is refused, so a bad entry never reaches a header or a message.
function secretFromBlob(bytes) {
  const b = Buffer.from(bytes);
  const utf16 = b.length >= 2 && b.length % 2 === 0 && b.every((x, i) => i % 2 === 0 || x === 0);
  const s = (utf16 ? b.toString('utf16le') : b.toString('utf8')).trim();
  return /^[\x21-\x7e]{8,1024}$/.test(s) ? s : null;
}

// One set of bindings per process: koffi refuses a second struct with the same name.
let bound = null;
function bind(koffi) {
  if (bound) return bound;
  const advapi = koffi.load('advapi32.dll');
  const OUT = koffi.struct('MEWNDO_CONN_CREDW_OUT', {
    Flags: 'uint32', Type: 'uint32', TargetName: 'void *', Comment: 'void *', LastWritten: 'uint64',
    CredentialBlobSize: 'uint32', CredentialBlob: 'void *', Persist: 'uint32', AttributeCount: 'uint32',
    Attributes: 'void *', TargetAlias: 'void *', UserName: 'void *',
  });
  const IN = koffi.struct('MEWNDO_CONN_CREDW_IN', {
    Flags: 'uint32', Type: 'uint32', TargetName: 'str16', Comment: 'str16', LastWritten: 'uint64',
    CredentialBlobSize: 'uint32', CredentialBlob: 'void *', Persist: 'uint32', AttributeCount: 'uint32',
    Attributes: 'void *', TargetAlias: 'str16', UserName: 'str16',
  });
  bound = {
    OUT,
    read: advapi.func('__stdcall', 'CredReadW', 'bool', ['str16', 'uint32', 'uint32', koffi.out(koffi.pointer('void *'))]),
    write: advapi.func('__stdcall', 'CredWriteW', 'bool', [koffi.pointer(IN), 'uint32']),
    remove: advapi.func('__stdcall', 'CredDeleteW', 'bool', ['str16', 'uint32', 'uint32']),
    free: advapi.func('__stdcall', 'CredFree', 'void', ['void *']),
  };
  return bound;
}

// Windows Credential Manager. load and platform are injected in tests.
function windowsCredentials({ load = () => require('koffi'), platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return unavailable('Saving sign-ins needs Windows Credential Manager, so Connections work on Windows only.');
  }
  let api = null;
  const get = () => (api ??= bind(load()));
  return {
    available: true,
    why: null,
    read(target) {
      try {
        const a = get();
        const out = [null];
        if (!a.read(target, CRED_TYPE_GENERIC, 0, out) || !out[0]) return null;
        try {
          const cred = loadDecode(load)(out[0], a.OUT);
          return secretFromBlob(loadDecode(load, 'uint8_t')(cred.CredentialBlob, cred.CredentialBlobSize));
        } finally {
          a.free(out[0]);
        }
      } catch {
        return null;
      }
    },
    write(target, secret) {
      const blob = Buffer.from(String(secret), 'utf16le');
      const ok = get().write({
        Flags: 0, Type: CRED_TYPE_GENERIC, TargetName: target, Comment: 'Saved by Mewndo for Connections', LastWritten: 0,
        CredentialBlobSize: blob.length, CredentialBlob: blob, Persist: CRED_PERSIST_LOCAL_MACHINE, AttributeCount: 0,
        Attributes: null, TargetAlias: null, UserName: 'Mewndo',
      }, 0);
      blob.fill(0);
      if (!ok) throw new Error('Windows Credential Manager refused to save the sign-in.');
    },
    remove(target) {
      try { return get().remove(target, CRED_TYPE_GENERIC, 0) === true; } catch { return false; }
    },
  };
}

// koffi.decode(pointer, type) or koffi.decode(pointer, 'uint8_t', length), from the loaded module.
function loadDecode(load, elem) {
  const koffi = load();
  return elem ? (ptr, len) => koffi.decode(ptr, elem, len) : (ptr, type) => koffi.decode(ptr, type);
}

function unavailable(why) {
  return {
    available: false,
    why,
    read: () => null,
    write() { throw new Error(why); },
    remove: () => false,
  };
}

// In memory only: for tests, and nothing else.
function memoryCredentials() {
  const m = new Map();
  return { available: true, why: null, read: (t) => m.get(t) ?? null, write: (t, s) => { m.set(t, String(s)); }, remove: (t) => m.delete(t), _map: m };
}

module.exports = { TARGETS, windowsCredentials, memoryCredentials, secretFromBlob };
