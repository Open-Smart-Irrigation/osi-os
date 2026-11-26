'use strict';
// The Gen1 clock frame normalisation and its negative controls. A row with
// transport_json falls back to nothing else; a row without it is compared
// against its own queued_at, and a frame that disagrees stays literal.
const test = require('node:test'), assert = require('node:assert');
const { clockPayload } = require('../lib/normalize');
const { compare } = require('../lib/compare');

// HHMMSS0wDDMMYY, one byte per digit, from the UTC fields of `at` shifted by offsetMinutes.
function frame(at, offsetMinutes = 0) {
  const d = new Date(Date.parse(at) + offsetMinutes * 60000);
  const two = (n) => String(n).padStart(2, '0');
  const digits = two(d.getUTCHours()) + two(d.getUTCMinutes()) + two(d.getUTCSeconds()) + two(d.getUTCDay())
    + two(d.getUTCDate()) + two(d.getUTCMonth() + 1) + two(d.getUTCFullYear() % 100);
  return [...digits].map((c) => '0' + c).join('');
}

test('a NULL-transport row normalises against its own queued_at', () => {
  assert.strictEqual(clockPayload(frame('2026-11-24T04:47:04Z'), null, '2026-11-24 04:47:04'), '<gen1-clock-offset-minutes:0>');
  assert.strictEqual(clockPayload(frame('2026-11-24T04:47:04Z', 60), null, '2026-11-24 04:47:05'), '<gen1-clock-offset-minutes:60>');
  assert.strictEqual(clockPayload(frame('2026-11-24T04:47:04Z'), undefined, '2026-11-24 04:47:04'), '<gen1-clock-offset-minutes:0>');
});

test('negative control: a NULL-transport frame that disagrees with queued_at stays literal', () => {
  const off = frame('2026-11-24T04:47:04Z');
  assert.strictEqual(clockPayload(off, null, '2026-11-24 04:47:34'), off, '30 s off a whole-minute offset');
  assert.strictEqual(clockPayload(off, null, '2026-11-25 04:47:04'), off, 'a day apart is beyond the 14 h offset bound');
  assert.strictEqual(clockPayload(off, null, '2026-11-24T04:47:04.000Z'), off, 'not SQLite datetime text');
  assert.strictEqual(clockPayload(off, null, null), off, 'no queued_at');
  assert.strictEqual(clockPayload(off, null, 1795494424), off, 'non-text queued_at does not throw');
});

test('a row with transport_json ignores queued_at', () => {
  const f = frame('2026-11-24T04:47:04Z');
  const agreeing = JSON.stringify({ intent_at: '2026-11-24T04:47:04.120Z' });
  const disagreeing = JSON.stringify({ intent_at: '2026-11-24T09:13:41.000Z' });
  assert.strictEqual(clockPayload(f, agreeing, '2030-01-01 00:00:00'), '<gen1-clock-offset-minutes:0>');
  assert.strictEqual(clockPayload(f, disagreeing, '2026-11-24 04:47:04'), f, 'queued_at must not rescue a frame its intent_at disowns');
  assert.strictEqual(clockPayload(f, '{not json', '2026-11-24 04:47:04'), f, 'malformed transport_json stays literal');
  assert.strictEqual(clockPayload(f, JSON.stringify({}), '2026-11-24 04:47:04'), f, 'transport_json without intent_at stays literal');
});

const clockStep = (hex, queuedAt) => ({ steps: [{ id: 'tick', kind: 'timer', db: { valve_schedule_pushes: { added: [
  { __rowid: 1, push_id: 'p1', device_eui: 'NOTAHEXEUI000007', purpose: 'CLOCK_SYNC', fport: 12, payload_hex: hex, state: 'QUEUED',
    queued_at: queuedAt, transport_json: null },
], removed: [], changed: [] } }, radio: [], mqtt: [] }] });

test('compare: NULL-transport clock rows recorded at different times match', () => {
  const r = compare(clockStep(frame('2026-11-24T04:47:04Z'), '2026-11-24 04:47:04'),
    clockStep(frame('2026-11-24T04:49:03Z'), '2026-11-24 04:49:03'));
  assert.strictEqual(r.pass, true, JSON.stringify(r.results));
});

test('compare negative control: a replayed frame off its own queued_at is a failure', () => {
  const r = compare(clockStep(frame('2026-11-24T04:47:04Z'), '2026-11-24 04:47:04'),
    clockStep(frame('2026-11-24T04:49:33Z'), '2026-11-24 04:49:03'));
  assert.strictEqual(r.pass, false);
  assert.match(JSON.stringify(r.results[0].failures), /payload_hex/);
});

test('compare negative control: a different local offset is a failure', () => {
  const r = compare(clockStep(frame('2026-11-24T04:47:04Z'), '2026-11-24 04:47:04'),
    clockStep(frame('2026-11-24T04:49:03Z', 60), '2026-11-24 04:49:03'));
  assert.strictEqual(r.pass, false);
  assert.match(JSON.stringify(r.results[0].failures), /payload_hex/);
});

// N3 (dispatch r3): a queue flush re-sends a clock frame whose push row was
// added in an earlier step. Each side's frame is tied to its own earlier row.
const resent = (at, { eui = 'A840410000000051', resendHex, resendEui = eui, row = true } = {}) => {
  const hex = frame(at);
  const transport = JSON.stringify({ intent_at: at });
  return { steps: [
    { id: 'clock-tick', kind: 'timer', db: row ? { valve_schedule_pushes: { added: [
      { __rowid: 1, push_id: 'p1', device_eui: eui, purpose: 'CLOCK_SYNC', fport: 12, payload_hex: hex, state: 'QUEUED',
        queued_at: at.slice(0, 19).replace('T', ' '), transport_json: transport },
    ], removed: [], changed: [] } } : {}, radio: row ? [{ fn: 'enqueue', eui, port: 12, hex, id: 'q1' }] : [], mqtt: [] },
    { id: 'cancel', kind: 'http', response: { status: 409, headers: {}, json: {}, text: null, bomUtf8: false }, db: {},
      radio: [{ fn: 'enqueue', eui: resendEui, port: 12, hex: resendHex || hex, id: 'q2' }], mqtt: [] },
  ] };
};

test('compare: a clock frame re-sent in a later step matches its own earlier push row', () => {
  const r = compare(resent('2026-11-24T04:47:04.120Z'), resent('2026-11-24T04:49:33.480Z'));
  assert.strictEqual(r.pass, true, JSON.stringify(r.results));
});

test('compare negative control: a re-sent frame without an earlier push row stays literal', () => {
  const e = resent('2026-11-24T04:47:04.120Z', { row: false, resendHex: frame('2026-11-24T04:47:04Z') });
  const a = resent('2026-11-24T04:49:33.480Z', { row: false, resendHex: frame('2026-11-24T04:49:33Z') });
  const r = compare(e, a);
  assert.strictEqual(r.pass, false);
  assert.match(JSON.stringify(r.results[1].failures), /radio/);
});

test('compare negative control: a re-sent frame for another device stays literal', () => {
  const e = resent('2026-11-24T04:47:04.120Z', { resendEui: 'A840410000000052' });
  const a = resent('2026-11-24T04:49:33.480Z', { resendEui: 'A840410000000052' });
  const r = compare(e, a);
  assert.strictEqual(r.pass, false);
  assert.match(JSON.stringify(r.results[1].failures), /radio/);
});

test('compare negative control: a re-sent frame more than 5 s off its earlier row stays literal', () => {
  // The row's intent_at says 04:49:33.480 but the re-sent frame (also the row's bytes) says 04:49:43.
  const at = '2026-11-24T04:49:33.480Z';
  const a = resent(at);
  const late = frame('2026-11-24T04:49:43Z');
  a.steps[0].db.valve_schedule_pushes.added[0].payload_hex = late;
  a.steps[0].radio[0].hex = late;
  a.steps[1].radio[0].hex = late;
  const r = compare(resent('2026-11-24T04:47:04.120Z'), a);
  assert.strictEqual(r.pass, false);
  assert.match(JSON.stringify(r.results[1].failures), /radio/);
});

test('compare negative control: a re-sent frame whose non-time bytes changed stays literal', () => {
  const at = '2026-11-24T04:49:33.480Z';
  const changed = frame(at).replace(/^0[0-9]/, '01').slice(0, -2) + '09';
  const r = compare(resent('2026-11-24T04:47:04.120Z'), resent(at, { resendHex: changed }));
  assert.strictEqual(r.pass, false);
  assert.match(JSON.stringify(r.results[1].failures), /radio/);
});

// S3 (confirm-B2): both sides hold an older clock row for the device (two
// hours earlier, an earlier generation) and the latest row. Node-RED re-sends
// the latest frame; a backend that re-sends the superseded older frame must
// not pass by matching its own older row.
const superseded = (at, { resendOlder = false } = {}) => {
  const c = resent(at);
  const older = new Date(Date.parse(at) - 2 * 3600000).toISOString();
  const olderHex = frame(older);
  c.steps.unshift({ id: 'older-tick', kind: 'timer', db: { valve_schedule_pushes: { added: [
    { __rowid: 9, push_id: 'p0', device_eui: 'A840410000000051', purpose: 'CLOCK_SYNC', fport: 12, payload_hex: olderHex, state: 'QUEUED',
      queued_at: older.slice(0, 19).replace('T', ' '), transport_json: JSON.stringify({ intent_at: older }) },
  ], removed: [], changed: [] } }, radio: [{ fn: 'enqueue', eui: 'A840410000000051', port: 12, hex: olderHex, id: 'q0' }], mqtt: [] });
  if (resendOlder) c.steps[2].radio[0].hex = olderHex;
  return c;
};

test('compare: with an older row present, re-sending the latest frame still matches', () => {
  const r = compare(superseded('2026-11-24T04:47:04.120Z'), superseded('2026-11-24T04:49:33.480Z'));
  assert.strictEqual(r.pass, true, JSON.stringify(r.results));
});

test('compare negative control: re-sending a superseded clock frame stays literal', () => {
  const r = compare(superseded('2026-11-24T04:47:04.120Z'), superseded('2026-11-24T04:49:33.480Z', { resendOlder: true }));
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.results[2].pass, false);
  assert.match(JSON.stringify(r.results[2].failures), /radio/);
});
