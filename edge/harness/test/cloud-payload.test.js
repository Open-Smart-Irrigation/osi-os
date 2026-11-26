'use strict';
// Cloud publish payloads that are canonical JSON text are normalised inside,
// like JSON text elsewhere: a same-form instant or a fresh UUID is clock or id
// noise. Every real change, the key order and the text form still fail.
const test = require('node:test'), assert = require('node:assert');
const { compare, cloudPayload } = require('../lib/compare');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const status = (fields) => JSON.stringify({ deviceEui: 'A840410000000091', gatewayDeviceEui: '0016C001F1000001', state: 'OPEN', timestamp: '2026-11-24T04:45:29.021Z', ...fields });
const ack = (fields) => JSON.stringify({ commandId: 'd7b955fe-565c-459c-9756-0575f650240f', eventUuid: null, commandType: 'SET_STREGA_INTERVAL',
  status: 'ACKED', result: 'APPLIED', appliedAt: '2026-11-24T04:45:29.015Z', appliedSyncVersion: null, duplicate: false, ...fields });

const cassette = ({ statusText = status(), ackText = ack(), commandId = 'd7b955fe-565c-459c-9756-0575f650240f' } = {}) => ({ steps: [{
  id: 's1', kind: 'http',
  response: { status: 202, headers: {}, bomUtf8: false, text: null, json: { command_id: commandId } },
  db: {}, radio: [], mqtt: [],
  cloud: [
    { direction: 'client', cmd: 'publish', messageId: 10, topic: 'devices/0016C001F1000001/command_ack', qos: 1, retain: false, dup: false, payload: b64(ackText) },
    { direction: 'broker', cmd: 'puback', messageId: 10, reasonCode: 16 },
    { direction: 'client', cmd: 'publish', messageId: 11, topic: 'devices/0016C001F1000001/status', qos: 1, retain: false, dup: false, payload: b64(statusText) },
    { direction: 'broker', cmd: 'puback', messageId: 11, reasonCode: 16 },
  ],
}] });

const failures = (a, b) => compare(a, b).results[0].failures;

test('same-form instants and a fresh command id inside a cloud payload compare green', () => {
  const other = '1c2d3e4f-0000-4000-8000-00000000abcd';
  const b = cassette({ statusText: status({ timestamp: '2027-01-02T03:04:05.678Z' }),
    ackText: ack({ commandId: other, appliedAt: '2027-01-02T03:04:05.600Z' }), commandId: other });
  assert.deepStrictEqual(failures(cassette(), b), []);
});

const red = {
  'state value': () => cassette({ statusText: status({ state: 'CLOSED' }) }),
  'device EUI': () => cassette({ statusText: status({ deviceEui: 'A840410000000092' }) }),
  'ack result': () => cassette({ ackText: ack({ result: 'FAILED_RETRYABLE' }) }),
  'duplicate flag': () => cassette({ ackText: ack({ duplicate: true }) }),
  'null to absent': () => cassette({ ackText: JSON.stringify((({ eventUuid, ...rest }) => rest)(JSON.parse(ack()))) }),
  'string to number': () => cassette({ ackText: ack({ appliedSyncVersion: '3' }) }),
  'timestamp milliseconds dropped': () => cassette({ statusText: status({ timestamp: '2026-11-24T04:45:29Z' }) }),
  'timestamp in SQLite form': () => cassette({ statusText: status({ timestamp: '2026-11-24 04:45:29' }) }),
  'key order': () => cassette({ statusText: JSON.stringify({ gatewayDeviceEui: '0016C001F1000001', deviceEui: 'A840410000000091', state: 'OPEN', timestamp: '2026-11-24T04:45:29.021Z' }) }),
  'non-canonical spacing': () => cassette({ statusText: JSON.stringify(JSON.parse(status()), null, 1) }),
  'command id no longer the response id': () => cassette({ ackText: ack({ commandId: '1c2d3e4f-0000-4000-8000-00000000abcd' }) }),
  'command id upper case': () => cassette({ ackText: ack({ commandId: 'D7B955FE-565C-459C-9756-0575F650240F' }), commandId: 'D7B955FE-565C-459C-9756-0575F650240F' }),
};
for (const [name, make] of Object.entries(red)) {
  test('cloud payload change goes red: ' + name, () => {
    assert.notDeepStrictEqual(failures(cassette(), make()), []);
  });
}

test('payloads that are not canonical JSON objects stay literal', () => {
  const n = { value: () => { throw new Error('must not normalise'); } };
  for (const text of ['plain text 2026-11-24T04:45:29.021Z', '"2026-11-24T04:45:29.021Z"', '42', '{"a": 1}', '{"a":1.0}']) {
    assert.strictEqual(cloudPayload(b64(text), n), b64(text), text);
  }
  const binary = Buffer.from([0xff, 0xfe, 0x7b, 0x7d]).toString('base64');
  assert.strictEqual(cloudPayload(binary, n), binary);
  assert.strictEqual(cloudPayload('not base64!', n), 'not base64!');
});

test('a non-JSON payload with a different timestamp stays red', () => {
  const a = cassette({ statusText: 'state=OPEN at 2026-11-24T04:45:29.021Z' });
  const b = cassette({ statusText: 'state=OPEN at 2026-11-24T04:45:30.021Z' });
  assert.notDeepStrictEqual(failures(a, b), []);
});

// Broker PUBACK interleaving is timing; client publish order is behaviour.
test('cloud packets: PUBACK interleaving is ignored, client publish order is not', () => {
  const { compare } = require('../lib/compare');
  const pub = (id, topic) => ({ direction: 'client', cmd: 'publish', messageId: id, qos: 1, topic, payload: '{}' });
  const ack = (id) => ({ direction: 'broker', cmd: 'puback', messageId: id });
  const mk = (cloud) => ({ meta: {}, steps: [{ id: 's', kind: 'http', response: { status: 202, headers: {}, json: {} }, cloud }] });
  const waited = mk([pub(1, 'a/command_ack'), ack(1), pub(2, 'a/status'), ack(2), pub(3, 'a/command_ack'), ack(3)]);
  const pipelined = mk([pub(1, 'a/command_ack'), ack(1), pub(2, 'a/status'), pub(3, 'a/command_ack'), ack(2), ack(3)]);
  const swapped = mk([pub(1, 'a/status'), ack(1), pub(2, 'a/command_ack'), ack(2), pub(3, 'a/command_ack'), ack(3)]);
  const missingAck = mk([pub(1, 'a/command_ack'), ack(1), pub(2, 'a/status'), pub(3, 'a/command_ack'), ack(2)]);
  assert.strictEqual(compare(waited, pipelined).pass, true);
  assert.strictEqual(compare(waited, swapped).pass, false);
  assert.strictEqual(compare(waited, missingAck).pass, false);
});
