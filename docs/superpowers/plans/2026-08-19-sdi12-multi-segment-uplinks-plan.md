# SDI-12 Multi-Segment Uplinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The edge reassembles Dragino `AT+DATAUP=1` multi-segment FPort 2 uplinks (payload version 2) into the single ASCII string the existing SDI-12 normalizer consumes, atomically or not at all.

**Architecture:** A `payver === 2` branch in the codec exposes `SegCount`/`SegIndex`; a new pure helper module `osi-sdi12-reassemble` owns the per-device buffering state machine; `sdi12-gate-fn` drives it via flow context and forwards only complete sequences; incomplete sequences dead-letter as one quarantine row through a small new writer export. Normalizer, schema, channels, identify, GUI, cloud: untouched.

**Tech Stack:** Node-RED function nodes, plain-Node helper modules (`node --test`), existing verify/golden-vector harnesses.

**Spec:** `docs/superpowers/specs/2026-08-19-sdi12-multi-segment-uplinks-design.md` — read first.

## Global Constraints

- Repo `/home/phil/Repos/osi-os-agrolink`, branch `AgroLink`. `bcm2712` is canonical; mirror `bcm2709` byte-identically for flows.json and node-red modules; `node scripts/verify-profile-parity.js` after every mirror. Never touch `bcm2708`.
- Any flows.json edit: read `.claude/skills/osi-flows-json-editing/SKILL.md` FIRST; one-shot Node script in the scratchpad, byte-identical `JSON.stringify(flows, null, 2)+'\n'` roundtrip guard before and after, never an Edit-tool string replacement. All SDI-12 nodes stay BEFORE the `journal-v2-replication-*` cluster in the array (you are editing existing nodes, not adding — verify order is unchanged).
- Do NOT touch `sync-init-fn` or any node hash-pinned in `scripts/verify-live-gateway-identity.js` (~L339). A hash mismatch there is a HALT.
- New helper module needs the three-surface registration (`osi-lib` `NAME_TO_PATH`, node-red `package.json` + `package-lock.json` both profiles, `98_osi_node_red_seed` module loop) plus `deploy.sh` `fetch_required` pairs — copy exactly how `osi-sdi12-normalize` is registered (grep it in each file). `node scripts/verify-helper-registration.js` gates.
- No bare `require` in function nodes (`osiLib.require` only; `fs` via `global.get('fs')`). No silent catches. Flows size ratchet is measure-and-raise (append reason).
- No push, no deploy, no SSH, no live-Pi access during execution — the orchestrator does those after review.
- Prose passes `node /home/phil/Repos/osi-os/.claude/skills/anti-slop-writing/slop-check.js <file>`.

---

### Task 0: Baseline + commit spec/plan

- [ ] `git status -s` clean apart from the two new docs; `git log --oneline -1` is `19ca945e` or a descendant.
- [ ] `node scripts/verify-sdi12-codec.js && (cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize && node --test) && node scripts/verify-device-integration.js 2>&1 | tail -3` — all green before you change anything; if not, STOP.
- [ ] `git add docs/superpowers/specs/2026-08-19-sdi12-multi-segment-uplinks-design.md docs/superpowers/plans/2026-08-19-sdi12-multi-segment-uplinks-plan.md && git commit -m "docs(sdi12): multi-segment uplink spec + plan"`

---

### Task 1: Codec payver-2 header

**Files:** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js` (+ bcm2709 mirror), `scripts/verify-sdi12-codec.js`, `scripts/verify-codec-robustness.js` (sdi12 entry ~L138).

**Interfaces — Produces:** FPort 2 `payver===2` → `{ BatV, EXTI_Trigger, Payver: 2, SegCount, SegIndex, data_sum, Node_type: 'SDI12' }`; `payver===1` unchanged; `payver===2` with `bytes.length < 5` → `{ unsupported_payload: 'payver2_short' }`; other payver → `{ unsupported_payload: 'payver_<n>' }`.

- [ ] **Step 1 — failing tests.** Append to `scripts/verify-sdi12-codec.js` (it is assert-style, not node:test; follow its existing shape):

```js
// payver 2: 3.300 V, count 3, index 1, slice "+28.1+25.9"
const s2 = ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x02, 0x03, 0x01].concat(ascii('+28.1+25.9')) }).data;
assert.strictEqual(s2.BatV, 3.3);
assert.strictEqual(s2.Payver, 2);
assert.strictEqual(s2.SegCount, 3);
assert.strictEqual(s2.SegIndex, 1);
assert.strictEqual(s2.data_sum, '+28.1+25.9');
assert.strictEqual(s2.Node_type, 'SDI12');
// payver 1 is byte-for-byte unchanged (no Seg* fields)
const s1 = ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x01].concat(ascii('+2.48+21.5')) }).data;
assert.strictEqual(s1.SegCount, undefined);
assert.strictEqual(s1.data_sum, '+2.48+21.5');
// payver 2 too short
assert.strictEqual(ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x02, 0x03] }).data.unsupported_payload, 'payver2_short');
// unknown payver
assert.strictEqual(ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x07, 0x01] }).data.unsupported_payload, 'payver_7');
```
Run `node scripts/verify-sdi12-codec.js` → expect FAIL on `SegCount`.

- [ ] **Step 2 — implement.** In the codec's FPort 2 branch (currently: `if (bytes.length < 3) return {}; var batRaw = ...; return { BatV, EXTI_Trigger, Payver: bytes[2], data_sum: asciiFromBytes(bytes, 3), Node_type }`), replace with:

```js
  if (bytes.length < 3) return {};
  var batRaw = (bytes[0] << 8) | bytes[1];
  var payver = bytes[2];
  var common = {
    BatV: (batRaw & 0x7FFF) / 1000,
    EXTI_Trigger: (batRaw & 0x8000) ? 'TRUE' : 'FALSE',
    Payver: payver,
    Node_type: 'SDI12'
  };
  if (payver === 1) {
    common.data_sum = asciiFromBytes(bytes, 3);
    return common;
  }
  if (payver === 2) {
    // AT+DATAUP=1 multi-segment: [bat][bat][payver=2][count][index][ascii slice]
    if (bytes.length < 5) return { unsupported_payload: 'payver2_short' };
    common.SegCount = bytes[3];
    common.SegIndex = bytes[4];
    common.data_sum = asciiFromBytes(bytes, 5);
    return common;
  }
  return { unsupported_payload: 'payver_' + payver };
```
(Keep the existing header comment; extend it with the payver-2 layout line.)

- [ ] **Step 3** — `node scripts/verify-sdi12-codec.js` → PASS. Add a payver-2 representative frame to the sdi12 entry's robustness coverage if the table supports multiple frames (read the table's schema; if single-frame only, leave it — the fuzz pass still covers the branch).
- [ ] **Step 4** — `cp` codec to bcm2709; `node scripts/verify-profile-parity.js`; `node scripts/verify-codec-robustness.js`. Commit: `feat(sdi12): codec decodes payver-2 multi-segment header`.

---

### Task 2: `osi-sdi12-reassemble` helper module

**Files (create):** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble/{index.js,index.test.js,package.json}` (+ bcm2709 copies). **Modify:** `osi-lib/index.js` `NAME_TO_PATH` (add `'sdi12-reassemble': 'osi-sdi12-reassemble',`), node-red `package.json` + `package-lock.json` (both profiles, same form as `osi-sdi12-normalize`), `98_osi_node_red_seed` module loop, `deploy.sh` two `fetch_required` pairs next to the `osi-sdi12-normalize` ones (~L811-817).

**Interfaces — Produces:**
```js
step(state, deveui, segment) -> { action, message?, quarantine?, status }
// state: {} persisted by caller, mutated in place; keyed by deveui
// segment: { count, index, ascii, batV, extiTrigger, recordedAt, nowMs }
// action: 'passthrough' | 'buffered' | 'complete' | 'reset'
// message (passthrough/complete): { BatV, EXTI_Trigger, Payver: 2, data_sum, Node_type: 'SDI12', recordedAt }
// quarantine (reset): { channel: 'sdi12_segments_incomplete', raw: '<count>:[i,j,...]' }
// status: 'seg <seen>/<count>' | 'complete <count>' | 'passthrough' | 'reset <reason>'
WINDOW_MS = 600000
```

- [ ] **Step 1 — failing tests** (`index.test.js`, `node --test`):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('./index.js');
const seg = (o) => Object.assign({ count: 3, ascii: '', batV: 3.3, extiTrigger: 'FALSE', recordedAt: '2026-08-19T20:00:00Z', nowMs: 1000 }, o);

test('count 1 passes straight through and clears any stale buffer for that device', () => {
  const st = {};
  const r = m.step(st, 'EUI1', seg({ count: 1, index: 0, ascii: '+1.5' }));
  assert.strictEqual(r.action, 'passthrough');
  assert.strictEqual(r.message.data_sum, '+1.5');
  assert.strictEqual(r.message.Payver, 2);
  assert.deepStrictEqual(st, {});
  m.step(st, 'EUI1', seg({ index: 0, ascii: 'x' }));           // start a 3-seg buffer
  m.step(st, 'EUI1', seg({ count: 1, index: 0, ascii: '+9' }));  // device back to single-frame
  assert.strictEqual(st.EUI1, undefined);
});
test('in-order 3 segments complete; message from last segment; buffer cleared', () => {
  const st = {};
  assert.strictEqual(m.step(st, 'E', seg({ index: 0, ascii: '+1', batV: 3.1 })).action, 'buffered');
  assert.strictEqual(m.step(st, 'E', seg({ index: 1, ascii: '+2', batV: 3.2 })).action, 'buffered');
  const r = m.step(st, 'E', seg({ index: 2, ascii: '+3', batV: 3.3, recordedAt: 'T3' }));
  assert.strictEqual(r.action, 'complete');
  assert.strictEqual(r.message.data_sum, '+1+2+3');
  assert.strictEqual(r.message.BatV, 3.3);
  assert.strictEqual(r.message.recordedAt, 'T3');
  assert.strictEqual(st.E, undefined);
});
test('out-of-order completes in index order', () => {
  const st = {};
  m.step(st, 'E', seg({ index: 2, ascii: '+3' }));
  m.step(st, 'E', seg({ index: 0, ascii: '+1' }));
  const r = m.step(st, 'E', seg({ index: 1, ascii: '+2' }));
  assert.strictEqual(r.message.data_sum, '+1+2+3');
});
test('status text while buffering', () => {
  const st = {};
  assert.strictEqual(m.step(st, 'E', seg({ index: 0 })).status, 'seg 1/3');
});
test('duplicate index resets with one quarantine record, then re-buffers the incoming', () => {
  const st = {};
  m.step(st, 'E', seg({ index: 0, ascii: '+1' }));
  const r = m.step(st, 'E', seg({ index: 0, ascii: '+1' }));
  assert.strictEqual(r.action, 'reset');
  assert.strictEqual(r.quarantine.channel, 'sdi12_segments_incomplete');
  assert.strictEqual(r.quarantine.raw, '3:[0]');
  assert.ok(st.E, 'incoming segment starts a fresh buffer');
  assert.deepStrictEqual(Object.keys(st.E.segments), ['0']);
});
test('count mismatch resets', () => {
  const st = {};
  m.step(st, 'E', seg({ index: 0, count: 3 }));
  const r = m.step(st, 'E', seg({ index: 1, count: 4 }));
  assert.strictEqual(r.action, 'reset');
  assert.strictEqual(st.E.count, 4);
});
test('index out of range resets and does NOT re-buffer the bad segment', () => {
  const st = {};
  m.step(st, 'E', seg({ index: 0 }));
  const r = m.step(st, 'E', seg({ index: 3 }));
  assert.strictEqual(r.action, 'reset');
  assert.strictEqual(r.quarantine.raw, '3:[0]');
  assert.strictEqual(st.E, undefined);
});
test('window elapsed resets', () => {
  const st = {};
  m.step(st, 'E', seg({ index: 0, nowMs: 0 }));
  const r = m.step(st, 'E', seg({ index: 1, nowMs: m.WINDOW_MS + 1 }));
  assert.strictEqual(r.action, 'reset');
  assert.strictEqual(r.quarantine.raw, '3:[0]');
});
test('devices are isolated', () => {
  const st = {};
  m.step(st, 'A', seg({ index: 0, ascii: 'a' }));
  m.step(st, 'B', seg({ index: 0, ascii: 'b' }));
  m.step(st, 'A', seg({ index: 1, ascii: 'a' }));
  const r = m.step(st, 'A', seg({ index: 2, ascii: 'a' }));
  assert.strictEqual(r.message.data_sum, 'aaa');
  assert.ok(st.B);
});
test('invalid segment shape is rejected without touching state', () => {
  const st = {};
  assert.throws(() => m.step(st, 'E', { count: 0, index: 0 }));
  assert.throws(() => m.step(st, 'E', { count: 16, index: 0 }));
  assert.deepStrictEqual(st, {});
});
```
Run `node --test` in the module dir → FAIL (module missing).

- [ ] **Step 2 — implement `index.js`:**

```js
'use strict';
// osi-sdi12-reassemble — pure per-device state machine for Dragino AT+DATAUP=1
// multi-segment SDI-12 uplinks (payload version 2). Spec:
// docs/superpowers/specs/2026-08-19-sdi12-multi-segment-uplinks-design.md
// No Node-RED, no I/O: the caller persists `state` (flow context) and passes
// nowMs so the window is testable.

var WINDOW_MS = 600000; // 10 min: >> Dragino inter-segment spacing, < 20 min TDC
var MAX_COUNT = 15;      // Dragino: at most 15 segments / 1500 bytes

function validate(segment) {
  if (!segment || typeof segment !== 'object') throw new Error('segment required');
  var c = segment.count, i = segment.index;
  if (!Number.isInteger(c) || c < 1 || c > MAX_COUNT) throw new Error('bad count ' + c);
  if (!Number.isInteger(i) || i < 0) throw new Error('bad index ' + i);
  if (typeof segment.ascii !== 'string') throw new Error('ascii must be a string');
  if (!Number.isFinite(segment.nowMs)) throw new Error('nowMs required');
}

function emit(segment, ascii) {
  return {
    BatV: segment.batV,
    EXTI_Trigger: segment.extiTrigger,
    Payver: 2,
    data_sum: ascii,
    Node_type: 'SDI12',
    recordedAt: segment.recordedAt || null
  };
}

function seenIndices(buf) {
  return Object.keys(buf.segments).map(Number).sort(function (a, b) { return a - b; });
}

function quarantineFor(buf) {
  return { channel: 'sdi12_segments_incomplete', raw: buf.count + ':[' + seenIndices(buf).join(',') + ']' };
}

function startBuffer(state, deveui, segment) {
  state[deveui] = { count: segment.count, firstAtMs: segment.nowMs, segments: {} };
  state[deveui].segments[segment.index] = segment;
  return state[deveui];
}

function step(state, deveui, segment) {
  validate(segment);
  if (segment.count === 1) {
    delete state[deveui]; // a device back on single-frame must not keep an orphan buffer
    return { action: 'passthrough', message: emit(segment, segment.ascii), status: 'passthrough' };
  }
  var buf = state[deveui];
  var resetReason = null;
  if (buf) {
    if (buf.count !== segment.count) resetReason = 'count';
    else if (segment.index >= buf.count) resetReason = 'range';
    else if (buf.segments[segment.index]) resetReason = 'duplicate';
    else if (segment.nowMs - buf.firstAtMs > WINDOW_MS) resetReason = 'window';
  } else if (segment.index >= segment.count) {
    // first segment we see is already out of range: nothing to reset, just refuse
    return { action: 'reset', quarantine: { channel: 'sdi12_segments_incomplete', raw: segment.count + ':[]' }, status: 'reset range' };
  }
  if (resetReason) {
    var q = quarantineFor(buf);
    delete state[deveui];
    if (segment.index < segment.count) startBuffer(state, deveui, segment);
    return { action: 'reset', quarantine: q, status: 'reset ' + resetReason };
  }
  if (!buf) buf = startBuffer(state, deveui, segment);
  else buf.segments[segment.index] = segment;

  var seen = seenIndices(buf);
  if (seen.length < buf.count) {
    return { action: 'buffered', status: 'seg ' + seen.length + '/' + buf.count };
  }
  var ascii = seen.map(function (i) { return buf.segments[i].ascii; }).join('');
  var last = buf.segments[buf.count - 1];
  delete state[deveui];
  return { action: 'complete', message: emit(last, ascii), status: 'complete ' + buf.count };
}

module.exports = { step: step, WINDOW_MS: WINDOW_MS, MAX_COUNT: MAX_COUNT };
```
`package.json`: copy `osi-sdi12-normalize/package.json`, name `osi-sdi12-reassemble`.

- [ ] **Step 3** — `node --test` → all PASS. Fix any test/impl mismatch in the implementation, not by weakening tests.
- [ ] **Step 4 — registration** (all surfaces listed in the header) + `cp -r` the module dir to bcm2709 + `node scripts/verify-helper-registration.js && node scripts/verify-profile-parity.js`. Commit: `feat(sdi12): reassembly state machine for multi-segment uplinks`.

---

### Task 3: Writer quarantine-only export

**Files:** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/{index.js,index.test.js}` (+ bcm2709).

**Interfaces — Produces:** `quarantineOnly(db, deveui, channel, rawValue) -> Promise<void>` — inserts one `ingest_quarantine` row with reason `'unknown_channel'` (the same reason string the writer uses for all normalizer unknowns, so existing troubleshooting queries filter on channel, per the v1 spec) and applies the existing 1000-row eviction.

- [ ] **Step 1 — failing test** in `index.test.js` (copy the file's existing db-fixture pattern): calling `quarantineOnly(db, 'E', 'sdi12_segments_incomplete', '3:[0,2]')` yields exactly one quarantine row with that channel/raw and reason `unknown_channel`, and NO `device_data` row.
- [ ] **Step 2 — implement** in `index.js`: `async function quarantineOnly(db, deveui, channel, rawValue) { await deadLetter(db, String(deveui||'').toUpperCase().trim(), channel, 'unknown_channel', rawValue); await evictQuarantine(db); }` and add it to `module.exports`.
- [ ] **Step 3** — tests PASS; mirror; parity. Commit: `feat(device-writer): quarantineOnly export for pre-normalize dead-letters`.

---

### Task 4: Gate + write node wiring (flows.json)

Read `.claude/skills/osi-flows-json-editing/SKILL.md` first. One-shot script in the scratchpad mutating BOTH profiles' flows.json; roundtrip guard before/after.

**Files:** both `flows.json`; `scripts/verify-flows-size-ratchet-allowances.json` (measure-and-raise for `sdi12-gate-fn` and `sdi12-write-fn`, reasons appended).

- [ ] **Step 1 — `sdi12-gate-fn` func** (replace the function body with this; it is the current body plus the payver-2 branch):

```js
// Output 1: FPort 2 periodic sensor payload -> config query chain.
// Output 2: FPort 100 identify echo -> identify handler.
// payver 2 (AT+DATAUP=1) frames are reassembled per device here, via
// osi-sdi12-reassemble + flow context; only complete sequences go on.
// Everything else (FPort 5 status, FPort 3 datalog, unknown ports/payvers)
// is dropped with a visible status, never written.
var data = msg.payload;
if (!data || !data.deviceInfo) return null;
var profileId = String(data.deviceInfo.deviceProfileId || '').trim();
var sdi12ProfileId = String(env.get('CHIRPSTACK_PROFILE_SDI12') || '').trim();
if (!sdi12ProfileId || profileId !== sdi12ProfileId) return null; // strict id match, no name fallback
var deveui = String(data.deviceInfo.devEui || '').toUpperCase();
var fPort = Number(data.fPort);
var decoded = data.object || {};
msg.sdi12 = { deveui: deveui, fPort: fPort, decoded: decoded, recordedAt: data.time || null };
if (fPort === 100) return [null, msg];
if (fPort !== 2 || decoded.unsupported_fport !== undefined || decoded.unsupported_payload !== undefined) {
  node.status({ fill: 'grey', shape: 'ring', text: 'dropped fport ' + fPort + ' ' + (decoded.unsupported_payload || '') + ' ' + deveui });
  return null;
}
if (decoded.Payver !== 2 || decoded.SegCount === undefined) {
  return [msg, null]; // payver 1: unchanged single-uplink path
}
var reRes = osiLib.require('sdi12-reassemble');
if (!reRes.ok) {
  node.error('SDI12 gate: reassemble module load failed: ' + reRes.error, msg);
  node.status({ fill: 'red', shape: 'dot', text: 'SDI12 REASSEMBLE_LOAD_FAILED' });
  return null;
}
var state = flow.get('sdi12_reassembly') || {};
var r;
try {
  r = reRes.value.step(state, deveui, {
    count: decoded.SegCount, index: decoded.SegIndex, ascii: String(decoded.data_sum || ''),
    batV: decoded.BatV, extiTrigger: decoded.EXTI_Trigger, recordedAt: data.time || null, nowMs: Date.now()
  });
} catch (e) {
  node.error('SDI12 gate: reassemble step failed: ' + (e && e.message), msg);
  node.status({ fill: 'red', shape: 'dot', text: 'SDI12 REASSEMBLE_STEP_FAILED' });
  return null;
}
flow.set('sdi12_reassembly', state);
node.status({ fill: r.action === 'reset' ? 'yellow' : 'blue', shape: r.action === 'complete' ? 'dot' : 'ring', text: r.status + ' ' + deveui });
if (r.action === 'buffered') return null;
if (r.action === 'reset') {
  msg.sdi12.quarantineOnly = r.quarantine;
  return [msg, null]; // write node records the dead-letter, no row
}
// complete or passthrough
var announced = flow.get('sdi12_reassembly_announced') || {};
if (r.action === 'complete' && !announced[deveui]) {
  announced[deveui] = true; flow.set('sdi12_reassembly_announced', announced);
  node.warn('sdi12 multi-segment reassembled: ' + deveui + ' ' + decoded.SegCount + ' segments, ' + r.message.data_sum.length + ' bytes');
}
msg.sdi12.decoded = r.message;
msg.sdi12.recordedAt = r.message.recordedAt || msg.sdi12.recordedAt;
return [msg, null];
```
`sdi12-gate-fn`'s `libs` is currently `null` (flows.json ~L13093) — set it to `[{"var":"osiLib","module":"osi-lib"}]` in the same mutation script (copy the exact object shape from `sdi12-write-fn`'s libs entry for osi-lib).

- [ ] **Step 2 — `sdi12-write-fn`.** The current body (read it in full first) is: `row` → `reportFailure` def → async IIFE: `normRes` → `writerRes` → manifest → `normalize()` → `var db = new osiDb.Database(...)` → `try { writeDeviceData } catch` → `try { await db.close() }`. There is NO finally and the db opens AFTER normalize, so the quarantine-only branch must come BEFORE normalize, own its own db handle, and close it itself. Insert this immediately after the `writerRes` load check (`if (!writerRes.ok) return reportFailure('writer_load');`) and before the manifest load:

```js
  if (info.quarantineOnly) {
    // Pre-normalize dead-letter from the gate (incomplete multi-segment
    // sequence): record one quarantine row, write no device_data row.
    var qdb;
    try {
      qdb = new osiDb.Database('/data/db/farming.db'); // same ctor form the node uses below for `db` -- copy it exactly
    } catch (e) {
      return reportFailure('db_open');
    }
    try {
      await writerRes.value.quarantineOnly(qdb, info.deveui, info.quarantineOnly.channel, info.quarantineOnly.raw);
      node.status({ fill: 'yellow', shape: 'ring', text: 'SDI12 segments incomplete ' + info.deveui });
    } catch (e) {
      node.error('SDI12 write failed [writer_run] code=WRITER_RUN_FAILED', msg);
      node.status({ fill: 'red', shape: 'dot', text: 'SDI12 WRITER_RUN_FAILED' });
    } finally {
      try { await qdb.close(); } catch (e) { node.error('SDI12 write failed [db_close] code=DB_CLOSE_FAILED', msg); }
    }
    return [null, null];
  }
```
Use the exact `osiDb` constructor/path expression the node already uses for `db` (copy it; do not guess). The `finally` guarantees the handle closes on every path.

- [ ] **Step 3 — gates:** `node scripts/verify-flows-fn-parse.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/flows-bare-require-scan.js && node scripts/verify-flows-size-ratchet.js` (raise per procedure) `&& node --test scripts/migrate-flows-journal-v2-replication.test.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-profile-parity.js && node scripts/verify-sync-flow.js`. Commit: `feat(sdi12): gate reassembles payver-2 multi-segment uplinks; write node records incomplete sequences`.

---

### Task 5: Golden vectors through the runner

**Files:** `scripts/fixtures/device-integration/sdi12/golden-vectors.json`, `scripts/verify-device-integration.js` (sdi12 block ~L176-230).

The runner's sdi12 block is UNCONDITIONAL today: `:197 assert.ok(row, 'device_data row must exist')`, `:222-224` maps quarantine rows to `{channel, reason}` and `deepEqual`s against `vector.expectedQuarantine`, `:226-229` asserts `result.deadLettered`. Both new behaviors must be explicit branches.

- [ ] **Step 1 — runner extension.** Support `vector.segments` (array of byte arrays) alongside `vector.bytes`:
  - If `segments` present: `const re = require('<path>/osi-sdi12-reassemble'); const st = {}; let last;` then for each `(bytes, i)`: `decoded = codec.decodeUplink({fPort: 2, bytes}).data; last = re.step(st, TEST_DEVEUI, { count: decoded.SegCount, index: decoded.SegIndex, ascii: decoded.data_sum, batV: decoded.BatV, extiTrigger: decoded.EXTI_Trigger, recordedAt: '2026-07-12T10:00:00Z', nowMs: i * 1000 });`
  - If `vector.expectedNoRow === true`: the vector is an incomplete-sequence case. Assert `last.action !== 'complete'`; then force the lazy window: `const forced = re.step(st, TEST_DEVEUI, { count: 1, index: 0, ascii: '', batV: 0, extiTrigger: 'FALSE', recordedAt: null, nowMs: re.WINDOW_MS + 100000 });` — NOTE: count 1 passthrough clears the buffer WITHOUT emitting a quarantine, so instead force with the SAME count: `{ count: last_count, index: 0, ..., nowMs: re.WINDOW_MS + 100000 }` → `forced.action === 'reset'`, `forced.quarantine.raw === vector.expectedQuarantineRaw`. Then call `writer.quarantineOnly(writerDb, TEST_DEVEUI, forced.quarantine.channel, forced.quarantine.raw)`, read `ingest_quarantine`, assert exactly `[{channel: 'sdi12_segments_incomplete', reason: 'unknown_channel'}]`, and assert `SELECT COUNT(*) FROM device_data` is 0. SKIP the normalize/writeDeviceData/row-must-exist/deadLettered assertions for this vector.
  - Else (complete or single `bytes`): `decodedData = last ? last.message : decoded.data` and continue through the existing normalize → write → row/quarantine assertions unchanged.
- [ ] **Step 2 — vectors.** (a) `"Sentek EnviroSCAN 8 values over 2 segments (payver 2)"`: `segments: [[0x0D,0xC8,0x02,0x02,0x00,...ascii('+0.1+0.2+0.3+0.4')],[0x0D,0xC8,0x02,0x02,0x01,...ascii('+0.5+0.6+0.7+0.8')]]`, `fPort: 2`, `deviceConfig: {probeProfile:'SENTEK_ENVIROSCAN', sdi12ValueCount: 8}`, `expected: {bat_v: 3.528, vwc_1: 0.1, ..., vwc_8: 0.8}`, `expectedQuarantine: []`. (b) `"3 segments, middle missing -> incomplete, quarantine only"`: `segments` = index 0 and index 2 of count 3 (any ascii), `expectedNoRow: true`, `expectedQuarantineRaw: '3:[0,2]'`. Encode ascii as byte arrays in the JSON (write them with a small node one-liner; do not hand-type).
- [ ] **Step 3** — `node scripts/verify-device-integration.js` → all pass incl. both new. Commit: `test(sdi12): multi-segment golden vectors (complete + incomplete)`.

---

### Task 6: Normalizer budget annotation + docs

**Files:** `osi-sdi12-normalize/index.js` (+test, + bcm2709), `docs/devices/dragino-sdi12.md`.

Facts first (read `index.test.js:~90-100` and `index.js:22-23,60-66`): the budget test SKIPS variable profiles (`expectedValues == null` → `SENTEK_ENVIROSCAN`, `DELTAT_PR2_*`, `GENERIC_VWC`) and separately EXEMPTS `HYDRASCOUT` with a comment that a bench capture, not an in-task fix, is the correct next step. `UPLINK_HEADER_BYTES = 3`, `WORST_CHARS_PER_VALUE = 9` → 8 values = 3 + 72 = **75** bytes.

- [ ] `worstCaseUplinkBytes(profile)` → add `function uplinkBudgetOk(profile)`: `k = profile.maxUplinks || 1`; single: `3 + n*9 <= 51`; multi: `5*k + n*9 <= 51*k`. Keep `worstCaseUplinkBytes` as is. Set `maxUplinks: 2` on `SENTEK_ENVIROSCAN` ONLY as documentation of intent (the budget test does not evaluate variable profiles — state that in the comment; do NOT make the test evaluate them). Do NOT touch `HYDRASCOUT`'s exemption or add `maxUplinks` to it — its bench decision stands. Rewrite the EnviroSCAN "phase 2" comment lines to "8 depths requires AT+DATAUP=1 + AT+PAYVER=2 on the device (multi-segment reassembly shipped; see the 2026-08-19 spec)". Add one unit test for `uplinkBudgetOk` (k=1: 5 values ok, 8 values not; k=2: 8 values ok). `node --test` green; mirror; parity.
- [ ] `docs/devices/dragino-sdi12.md`: replace the `AT+DATAUP=0`-only guidance with a "Multi-segment uplinks" section: the `DATAUP=1` + `PAYVER=2` contract (and what happens if PAYVER is left at 1 — garbage ASCII → quarantine, never mis-parsed), the 5-byte header, 46 data bytes/segment, 15/1500 limits, the 10-minute LAZY reassembly window (evaluated on the next arrival, not a timer), what `sdi12_segments_incomplete` means and its `count:[indices]` raw format, the late-delivery residual, and the EnviroSCAN 8-sensor recipe (`AT+DATAUP=1`, `AT+PAYVER=2`, `AT+COMMAND1=0M!,10,1,1` plus the Sentek `aD1!` continuation for values beyond the first 3 per the manual — mark the exact `AT+COMMAND2` form "confirm at bench"). Slop-check. Commit: `docs(sdi12): multi-segment uplink contract + EnviroSCAN 8-sensor recipe`.

---

### Task 7: Full battery + execution report

- [ ] Run: `node scripts/verify-sdi12-codec.js; node scripts/verify-codec-robustness.js; (cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble && node --test); (cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize && node --test); (cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer && node --test); node scripts/verify-device-integration.js; node scripts/verify-helper-registration.js; node scripts/verify-flows-fn-parse.js; node scripts/test-flows-wiring.js; node scripts/verify-no-new-silent-catch.js; node scripts/flows-bare-require-scan.js; node scripts/verify-flows-size-ratchet.js; node --test scripts/migrate-flows-journal-v2-replication.test.js; node scripts/verify-live-gateway-identity.js; node scripts/verify-profile-parity.js; node scripts/verify-sync-flow.js; bash scripts/check-mqtt-topics.sh` — all green. NO frontend build needed (no GUI change) — do not run one.
- [ ] Write `docs/superpowers/plans/2026-08-19-sdi12-multi-segment-uplinks-execution-report.md` (per-task commit hashes, real gate output, deviations). Slop-check. Commit: `docs(sdi12): multi-segment execution report`.
