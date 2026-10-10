// The Agent Desk wire format, protocol v2 (spec §33.10 Part A, §38.5), the app's half of
// core/crates/mewndo-proto/src/lib.rs. Plain Node, no Electron: tests run it with plain Node.
//
// A frame is a 1-byte frame type, a 4-byte little-endian payload length, then the payload (at most 8 MB):
//   type 0, JSON:  {"v":2,"id":"01J…","type":"hello","body":{"role":"app"}}
//   type 1, lane:  a 1-byte lane id length, the lane id (UTF-8), then raw terminal bytes
// Keep this file level with mewndo-proto: if a contract there changes, VERSION is bumped on both sides in the
// same commit (§32.5 rule 1).

const VERSION = 2;
const MAX_FRAME = 8 * 1024 * 1024;
const HEADER = 5;
const JSON_FRAME = 0;
const LANE_FRAME = 1;

function frame(type, payload) {
  if (payload.length > MAX_FRAME) throw tooLarge(payload.length);
  const head = Buffer.allocUnsafe(HEADER);
  head[0] = type;
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

const tooLarge = (n) => Object.assign(new Error(`a ${n}-byte frame is over the ${MAX_FRAME}-byte limit`), { framing: true });

// { v, id, type, body } as mewndo-proto's Envelope.
function encodeJson(envelope) {
  return frame(JSON_FRAME, Buffer.from(JSON.stringify(envelope), 'utf8'));
}

// Terminal bytes for one lane (Part G). data: Buffer or Uint8Array.
function encodeLane(lane, data) {
  const id = Buffer.from(String(lane), 'utf8');
  if (id.length > 255) throw Object.assign(new Error('a lane id is at most 255 bytes'), { framing: true });
  return frame(LANE_FRAME, Buffer.concat([Buffer.from([id.length]), id, Buffer.from(data)]));
}

// A reader over a stream that hands back whole frames. Sockets split and join writes however they like, so every
// chunk is buffered until its frame is complete.
//   { kind: 'json', envelope } · { kind: 'lane', lane, data } · { kind: 'bad', message } for a payload that can't
// be read (the frame is skipped, the connection is fine).
// A broken header means the framing itself is lost: push throws with .framing = true, and the caller drops the
// connection rather than guess where the next frame starts. Nothing is allocated for an oversize length.
function createReader() {
  let buffered = Buffer.alloc(0);
  return {
    get buffered() { return buffered.length; },
    push(chunk) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
      const frames = [];
      for (;;) {
        if (buffered.length < HEADER) return frames;
        const type = buffered[0];
        const length = buffered.readUInt32LE(1);
        if (type !== JSON_FRAME && type !== LANE_FRAME) {
          throw Object.assign(new Error(`unknown frame type ${type}`), { framing: true });
        }
        if (length > MAX_FRAME) throw tooLarge(length);
        if (buffered.length < HEADER + length) return frames;
        const payload = buffered.subarray(HEADER, HEADER + length);
        buffered = buffered.subarray(HEADER + length);
        frames.push(type === JSON_FRAME ? readJson(payload) : readLane(payload));
      }
    },
  };
}

function readJson(payload) {
  try {
    const envelope = JSON.parse(payload.toString('utf8'));
    if (!envelope || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      return { kind: 'bad', message: 'a JSON frame without a type' };
    }
    return { kind: 'json', envelope };
  } catch (e) {
    return { kind: 'bad', message: `bad message: ${e.message}` };
  }
}

function readLane(payload) {
  if (!payload.length) return { kind: 'bad', message: 'bad lane frame' };
  const n = payload[0];
  if (payload.length < 1 + n) return { kind: 'bad', message: 'bad lane frame' };
  return { kind: 'lane', lane: payload.subarray(1, 1 + n).toString('utf8'), data: payload.subarray(1 + n) };
}

module.exports = { VERSION, MAX_FRAME, HEADER, JSON_FRAME, LANE_FRAME, encodeJson, encodeLane, createReader };
