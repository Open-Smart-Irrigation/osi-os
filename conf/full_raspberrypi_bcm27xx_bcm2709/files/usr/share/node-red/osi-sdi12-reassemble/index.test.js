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
