'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replay } = require('./lib/sdi12-transport-lab');

const EUI_A = '0011223344556677';
const EUI_B = '8899AABBCCDDEEFF';
const epochA = 'synthetic-session-a';
const epochB = 'synthetic-session-b';

function data(bytes) { return Buffer.from(bytes).toString('base64'); }
function segmented(count, index, ascii) {
  return data([0x0c, 0xe4, 2, count, index, ...Buffer.from(ascii)]);
}
function single(ascii) { return data([0x0c, 0xe4, 1, ...Buffer.from(ascii)]); }
function up({ at = 0, eui = EUI_A, epoch = epochA, fCnt = 100, fPort = 2, payload = segmented(2, 0, '+10') } = {}) {
  return { type: 'up', at_ms: at, session_epoch: epoch,
    event: { deviceInfo: { devEui: eui }, fCnt, fPort, data: payload } };
}
function scenario(events, name = 'synthetic') {
  return { name, evidence_kind: 'synthetic', events };
}
function unqualified(report) {
  assert.equal(report.hardware_verified, false);
  assert.equal(report.acquisition_available, false);
  assert.equal(report.eligible, false);
}

test('reproduces legacy mixed-cycle completion while candidate rejects a counter gap', () => {
  const input = scenario([
    up({ fCnt: 100, payload: segmented(2, 0, '+10') }),
    up({ at: 10000, fCnt: 103, payload: segmented(2, 1, '+40') }),
  ], 'mixed-cycle-gap');
  const result = replay(input);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].legacy.action, 'buffered');
  assert.equal(result.results[1].legacy.action, 'complete');
  assert.equal(result.results[1].legacy.ascii, '+10+40');
  assert.equal(result.results[1].candidate.action, 'rejected');
  assert.equal(result.results[1].candidate.code, 'counter_gap');
  unqualified(result);
  assert.deepEqual(input.events[0].event.deviceInfo, { devEui: EUI_A });
});

test('completes strict contiguous fragments and preserves detached uplink evidence', () => {
  const source = up({ fCnt: 7, payload: segmented(2, 0, '+10') });
  const second = up({ at: 1000, fCnt: 8, payload: segmented(2, 1, '+20') });
  const result = replay(scenario([source, second]));
  const complete = result.results[1];
  assert.equal(complete.candidate.action, 'complete');
  assert.equal(complete.candidate.ascii, '+10+20');
  assert.deepEqual(complete.raw_bytes, [...Buffer.from(second.event.data, 'base64')]);
  assert.equal(complete.event.deviceInfo.devEui, EUI_A);
  assert.notEqual(complete.event, second.event);
  complete.event.deviceInfo.devEui = 'FFFFFFFFFFFFFFFF';
  assert.equal(second.event.deviceInfo.devEui, EUI_A);
  assert.equal(complete.session_epoch, epochA);
  unqualified(result);
});

test('isolates devices and refuses missing, reordered, duplicate, and count-changing fragments', () => {
  const result = replay(scenario([
    up({ eui: EUI_A, fCnt: 1, payload: segmented(2, 0, 'A') }),
    up({ eui: EUI_B, fCnt: 1, payload: segmented(2, 0, 'B') }),
    up({ eui: EUI_A, at: 1, fCnt: 2, payload: segmented(2, 1, 'a') }),
    up({ eui: EUI_B, at: 2, fCnt: 3, payload: segmented(2, 1, 'b') }),
    up({ eui: EUI_A, at: 3, fCnt: 3, payload: segmented(2, 1, 'x') }),
    up({ eui: EUI_A, at: 4, fCnt: 4, payload: segmented(3, 0, 'y') }),
    up({ eui: EUI_A, at: 5, fCnt: 5, payload: segmented(2, 1, 'z') }),
  ]));
  assert.equal(result.results[2].candidate.ascii, 'Aa');
  assert.equal(result.results[3].candidate.code, 'counter_gap');
  assert.deepEqual(result.results.slice(4).map(row => row.candidate.code), ['unexpected_index', 'buffered', 'count_mismatch']);
});

test('clears strict context on epoch changes and refuses retired epochs', () => {
  const result = replay(scenario([
    up({ fCnt: 100, payload: single('+10') }),
    up({ at: 1, epoch: epochB, fCnt: 1, payload: single('+20') }),
    up({ at: 2, epoch: epochA, fCnt: 101, payload: segmented(2, 0, '+30') }),
  ]));
  assert.deepEqual(result.results.map(row => row.candidate.code), ['complete', 'complete', 'retired_epoch']);
  assert.equal(result.results[1].candidate.action, 'complete');
});

test('documents epoch ordering limitation when an unseen older epoch arrives after current', () => {
  const result = replay(scenario([
    up({ epoch: epochB, fCnt: 100, payload: single('+10') }),
    up({ at: 1, epoch: epochA, fCnt: 1, payload: single('+20') }),
    up({ at: 2, epoch: epochB, fCnt: 101, payload: single('+30') }),
  ]));
  assert.deepEqual(result.results.map(row => row.candidate.code), ['complete', 'complete', 'retired_epoch']);
  assert.match(result.assumptions.join(' '), /epoch ordering/i);
  unqualified(result);
});

test('refuses missing context and all candidate frames after restart while legacy clears and reseeds', () => {
  const omittedEpoch = up({ payload: single('+0') });
  delete omittedEpoch.session_epoch;
  const result = replay(scenario([
    omittedEpoch,
    up({ at: 1, epoch: null, fCnt: 101, payload: segmented(2, 0, '+10') }),
    up({ at: 2, epoch: null, fCnt: 102, payload: segmented(2, 1, '+20') }),
    up({ at: 3, fCnt: 103 }),
    { type: 'restart', at_ms: 4 },
    up({ at: 5, fCnt: 104, payload: segmented(2, 0, '+30') }),
    up({ at: 6, fCnt: 105, payload: segmented(2, 1, '+40') }),
  ]));
  assert.equal(result.results[0].session_epoch, null);
  assert.deepEqual(result.results.map(row => row.candidate.action), ['rejected', 'rejected', 'rejected', 'buffered', 'reset', 'rejected', 'rejected']);
  assert.equal(result.results[2].legacy.action, 'complete');
  assert.equal(result.results[6].legacy.action, 'complete');
});

test('enforces timeout boundary, rollover, count-one index range, unsupported transport, and lossy bytes', () => {
  const atBoundary = replay(scenario([
    up({ at: 0, fCnt: 10 }),
    up({ at: 600000, fCnt: 11, payload: segmented(2, 1, '+20') }),
  ]));
  assert.equal(atBoundary.results[1].candidate.action, 'complete');
  const rollover = replay(scenario([
    up({ at: 0, fCnt: 0xffffffff }),
    up({ at: 1, fCnt: 0, payload: segmented(2, 1, '+20') }),
  ]));
  assert.equal(rollover.results[1].candidate.code, 'replayed_counter');
  const beyond = replay(scenario([
    up({ at: 0, fCnt: 1 }),
    up({ at: 600001, fCnt: 2, payload: segmented(2, 1, '+20') }),
  ]));
  assert.equal(beyond.results[1].candidate.code, 'window_expired');
  const invalid = replay(scenario([
    up({ fCnt: 1, payload: segmented(1, 1, '+10') }),
    up({ at: 1, fCnt: 2, fPort: 5, payload: data([0x17]) }),
    up({ at: 2, fCnt: 3, payload: data([0x0c, 0xe4, 7]) }),
    up({ at: 3, fCnt: 4, payload: data([0x0c, 0xe4, 1, 0xf1, 3, 0x2b, 0x31]) }),
  ]));
  assert.deepEqual(invalid.results.map(row => row.candidate.code), ['invalid_segment', 'unsupported_fport', 'unsupported_payver', 'lossy_ascii']);
  const countChange = replay(scenario([
    up({ fCnt: 20, payload: segmented(3, 0, '+10') }),
    up({ at: 1, fCnt: 21, payload: segmented(2, 1, '+20') }),
  ]));
  assert.equal(countChange.results[1].candidate.code, 'count_mismatch');
  const countBounds = replay(scenario([
    up({ fCnt: 30, payload: segmented(15, 0, '+10') }),
    up({ at: 1, fCnt: 31, payload: segmented(16, 0, '+20') }),
  ]));
  assert.deepEqual(countBounds.results.map(row => row.candidate.code), ['buffered', 'invalid_segment']);
});

test('keeps codec exceptions bounded, consumes their counters, and continues replay', () => {
  const result = replay(scenario([
    up({ fCnt: 10, payload: segmented(2, 0, '+10') }),
    up({ at: 1, fCnt: 11, fPort: 5, payload: data([0x17]) }),
    up({ at: 2, fCnt: 11, payload: segmented(2, 1, '+20') }),
    up({ at: 3, fCnt: 12, payload: single('+30') }),
  ]));
  assert.equal(result.results[1].legacy.code, 'codec_error');
  assert.equal(result.results[1].candidate.code, 'unsupported_fport');
  assert.equal(result.results[2].candidate.code, 'replayed_counter');
  assert.equal(result.results[3].candidate.action, 'complete');
});

test('does not promote ACK or TXACK evidence and keeps their metadata detached', () => {
  const ack = { type: 'ack', at_ms: 0, event: { deviceInfo: { devEui: EUI_A }, queueItemId: 'queue-1', acknowledged: true } };
  const failed = { type: 'ack', at_ms: 1, event: { deviceInfo: { devEui: EUI_A }, queueItemId: 'queue-2', acknowledged: false } };
  const repeated = { type: 'ack', at_ms: 2, event: { deviceInfo: { devEui: EUI_A }, queueItemId: 'queue-1', acknowledged: true } };
  const txack = { type: 'txack', at_ms: 3, event: { deviceInfo: { devEui: EUI_A }, queueItemId: 'queue-1', details: { status: 'ok' } } };
  const result = replay(scenario([ack, failed, repeated, txack, up({ at: 4, payload: single('+10') })]));
  assert.deepEqual(result.results.slice(0, 4).map(row => row.candidate.action), ['evidence_only', 'evidence_only', 'evidence_only', 'evidence_only']);
  assert.notEqual(result.results[0].event, ack.event);
  assert.deepEqual(result.results[3].event.details, { status: 'ok' });
  unqualified(result);
});

test('validates malformed scenarios without throwing or leaking input', () => {
  const invalids = [null, {}, { name: '', evidence_kind: 'synthetic', events: [] },
    { name: 'x', evidence_kind: 'other', events: [] },
    { name: 'x', evidence_kind: 'synthetic', events: Array(1001).fill({ type: 'restart', at_ms: 0 }) },
    scenario([up({ at: 2 }), { type: 'restart', at_ms: 1 }]),
    scenario([up({ payload: 'not base64!' })]),
    scenario([{ type: 'ack', at_ms: 0, event: { deviceInfo: { devEui: EUI_A }, queueItemId: 'q', acknowledged: 'yes' } }]),
  ];
  for (const input of invalids) {
    const before = input && JSON.stringify(input);
    const result = replay(input);
    assert.equal(result.ok, false);
    assert.equal(result.hardware_verified, false);
    assert.equal(result.acquisition_available, false);
    assert.equal(result.eligible, false);
    if (before) assert.equal(JSON.stringify(input), before);
  }
});
