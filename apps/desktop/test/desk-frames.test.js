// The Agent Desk wire format (app/desk/frames.js), the app's half of core/crates/mewndo-proto/src/lib.rs
// (spec §33.10 Part A, §38.5). A frame is a 1-byte type, a 4-byte little-endian length, then the payload.
// These are the cases that break a reader in the field: a frame split across socket writes, a payload length
// bigger than the 8 MB limit, and a frame type the app doesn't know.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  VERSION, MAX_FRAME, HEADER, JSON_FRAME, LANE_FRAME, encodeJson, encodeLane, createReader,
} = require('../app/desk/frames');

// A header with any type byte and any length, without allocating the payload: this is what a hostile or
// out-of-date peer can put on the wire.
function header(type, length) {
  const h = Buffer.allocUnsafe(HEADER);
  h[0] = type;
  h.writeUInt32LE(length, 1);
  return h;
}

test('the protocol version and the limits match mewndo-proto', () => {
  // If these ever disagree with core/crates/mewndo-proto/src/lib.rs the two sides cannot talk at all, and the
  // only honest fix is to bump VERSION on both sides in the same commit (§32.5 rule 1).
  assert.strictEqual(VERSION, 2);
  assert.strictEqual(MAX_FRAME, 8 * 1024 * 1024);
  assert.strictEqual(HEADER, 5);
  assert.deepStrictEqual([JSON_FRAME, LANE_FRAME], [0, 1]);
});

test('a JSON frame round-trips, header first and payload after', () => {
  const envelope = { v: VERSION, id: '01J', type: 'hello', body: { role: 'app' } };
  const bytes = encodeJson(envelope);
  assert.strictEqual(bytes[0], JSON_FRAME);
  assert.strictEqual(bytes.readUInt32LE(1), bytes.length - HEADER);
  assert.deepStrictEqual(createReader().push(bytes), [{ kind: 'json', envelope }]);
});

test('a lane frame carries its lane id as a length-prefixed string and the terminal bytes raw', () => {
  const data = Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0x00, 0xff]); // an escape sequence with a NUL and 0xff in it
  const bytes = encodeLane('lane-7', data);
  assert.strictEqual(bytes[0], LANE_FRAME);
  const [frame] = createReader().push(bytes);
  assert.strictEqual(frame.kind, 'lane');
  assert.strictEqual(frame.lane, 'lane-7');
  assert.deepStrictEqual(Buffer.from(frame.data), data, 'the bytes are passed through untouched');
  // A lane id longer than the one byte that holds its length cannot be encoded, rather than be truncated.
  assert.throws(() => encodeLane('x'.repeat(256), data), (e) => e.framing === true);
});

test('several frames in one chunk come back in order', () => {
  const reader = createReader();
  const chunk = Buffer.concat([
    encodeJson({ v: VERSION, id: '1', type: 'inbox.card', body: { id: 'c1' } }),
    encodeLane('a', Buffer.from('ls\r')),
    encodeJson({ v: VERSION, id: '2', type: 'inbox.release', body: { card_id: 'c1' } }),
  ]);
  const frames = reader.push(chunk);
  assert.deepStrictEqual(frames.map((f) => f.kind), ['json', 'lane', 'json']);
  assert.deepStrictEqual(frames.map((f) => f.envelope?.type ?? f.lane), ['inbox.card', 'a', 'inbox.release']);
  assert.strictEqual(reader.buffered, 0, 'nothing is left over');
});

test('a split read: a frame arriving one byte at a time is handed back once, whole', () => {
  // Sockets split and join writes however they like. The worst case is one byte per chunk, including a header
  // split in the middle, which is where a reader that trusts a single chunk goes wrong.
  const envelope = { v: VERSION, id: '01J', type: 'inbox.card', body: { id: 'c1', title: 'Run npm test?', risk: 2 } };
  const bytes = encodeJson(envelope);
  const reader = createReader();
  const got = [];
  for (let i = 0; i < bytes.length; i++) {
    const frames = reader.push(bytes.subarray(i, i + 1));
    got.push(...frames);
    if (i < bytes.length - 1) {
      assert.deepStrictEqual(frames, [], `nothing before the last byte (byte ${i})`);
      assert.ok(reader.buffered > 0, 'the partial frame is held');
    }
  }
  assert.deepStrictEqual(got, [{ kind: 'json', envelope }]);
  assert.strictEqual(reader.buffered, 0);
});

test('a split read in two halves, with the second frame tacked on to the tail of the first', () => {
  const one = encodeJson({ v: VERSION, id: '1', type: 'agent.status', body: { agent_id: 'a' } });
  const two = encodeLane('a', Buffer.from('hello'));
  const reader = createReader();
  const split = 3; // inside the first header: the length isn't even readable yet
  assert.deepStrictEqual(reader.push(one.subarray(0, split)), []);
  const frames = reader.push(Buffer.concat([one.subarray(split), two]));
  assert.deepStrictEqual(frames.map((f) => f.kind), ['json', 'lane']);
});

test('an 8 MB oversize frame throws a framing error and allocates nothing for it', () => {
  // Only the header arrives: the length alone is over the limit, so the reader must refuse before it ever waits
  // for (or allocates) the payload. .framing marks it as "where the next frame starts is now unknown", which is
  // what makes core-client drop the connection instead of resyncing blindly.
  const reader = createReader();
  assert.throws(() => reader.push(header(JSON_FRAME, MAX_FRAME + 1)), (e) => {
    assert.strictEqual(e.framing, true);
    assert.match(e.message, /8388609-byte frame is over the 8388608-byte limit/);
    return true;
  });
  // The biggest a sender may claim is exactly the limit, and that one only waits for its payload.
  assert.deepStrictEqual(createReader().push(header(LANE_FRAME, MAX_FRAME)), []);
  // Encoding one is refused on this side too, rather than put on the wire for the core to reject.
  assert.throws(() => encodeLane('a', Buffer.alloc(MAX_FRAME)), (e) => e.framing === true && /over the/.test(e.message));
});

test('a bad type byte throws a framing error: the app never guesses what an unknown frame means', () => {
  for (const type of [2, 3, 0x7f, 0xff]) {
    const reader = createReader();
    assert.throws(() => reader.push(header(type, 0)), (e) => {
      assert.strictEqual(e.framing, true);
      assert.strictEqual(e.message, `unknown frame type ${type}`);
      return true;
    }, `type ${type}`);
  }
  // It is the type byte that is checked, not the payload: a good frame before a bad one is still delivered
  // first, so nothing already read is lost.
  const reader = createReader();
  const good = encodeJson({ v: VERSION, id: '1', type: 'hello', body: {} });
  assert.throws(() => reader.push(Buffer.concat([good, header(9, 0)])), /unknown frame type 9/);
});

test('a payload that cannot be read is one bad frame, not a lost connection', () => {
  // A broken payload is recoverable: its length was honoured, so the next frame's start is known. The reader
  // reports it and carries on, and core-client only logs it.
  const reader = createReader();
  const broken = Buffer.from('{"v":2,"id":"1"'); // truncated JSON
  const frames = reader.push(Buffer.concat([
    Buffer.concat([header(JSON_FRAME, broken.length), broken]),
    encodeJson({ v: VERSION, id: '2', type: 'hello', body: {} }),
  ]));
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].kind, 'bad');
  assert.match(frames[0].message, /^bad message:/);
  assert.strictEqual(frames[1].envelope.type, 'hello');
});

test('JSON that is valid but is not an envelope is a bad frame, not a message with no type', () => {
  const reader = createReader();
  for (const payload of ['null', '42', '"hello"', '[]', '{}', '{"type":7}']) {
    const bytes = Buffer.from(payload, 'utf8');
    const [frame] = reader.push(Buffer.concat([header(JSON_FRAME, bytes.length), bytes]));
    assert.strictEqual(frame.kind, 'bad', payload);
    assert.strictEqual(frame.message, 'a JSON frame without a type', payload);
  }
});

test('a lane frame whose own id length runs past the payload is a bad frame', () => {
  const reader = createReader();
  for (const payload of [Buffer.alloc(0), Buffer.from([4, 0x61, 0x62])]) { // empty, then "id is 4 bytes" with 2
    const [frame] = reader.push(Buffer.concat([header(LANE_FRAME, payload.length), payload]));
    assert.deepStrictEqual([frame.kind, frame.message], ['bad', 'bad lane frame']);
  }
  // A lane with no output yet is legal: an empty data buffer, not a bad frame.
  const [empty] = reader.push(encodeLane('a', Buffer.alloc(0)));
  assert.deepStrictEqual([empty.kind, empty.lane, empty.data.length], ['lane', 'a', 0]);
});

test('a zero-length JSON frame is a bad frame and does not stall the reader', () => {
  const reader = createReader();
  const frames = reader.push(Buffer.concat([header(JSON_FRAME, 0), encodeJson({ v: VERSION, id: '1', type: 'hello' })]));
  assert.strictEqual(frames[0].kind, 'bad');
  assert.strictEqual(frames[1].envelope.type, 'hello');
});
