'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { interpretUplink, decodeGen1Fallback } = require('./ack');

test('Gen1 scheduler ACK on port 16 maps to WEEKDAY_PLAN weekday 2', () => {
  const r = interpretUplink({ Schl_Port: 16, Schl_status: '00', Valve: '0' }, 2);
  assert.deepEqual(r.acks, [{ purpose: 'WEEKDAY_PLAN', fport: 16, weekday: 2, status: 0 }]);
  assert.equal(r.generationHint, 'GEN1');
});

test('Gen1 scheduler-status ACK (port 21) and RTC ACK (port 12)', () => {
  assert.deepEqual(interpretUplink({ Schl_status_Port: 21, Schl_status_ack: '00' }, 2).acks, [{ purpose: 'SCHEDULER_STATUS', fport: 21, weekday: null, status: 0 }]);
  assert.deepEqual(interpretUplink({ RTC_Port: 12, RTC_status: '00' }, 2).acks, [{ purpose: 'CLOCK_SYNC', fport: 12, weekday: null, status: 0 }]);
});

test('plain telemetry yields no acks', () => {
  assert.deepEqual(interpretUplink({ Battery: 87, Valve: '1' }, 2).acks, []);
});

// Real Gen2 vendor decoder ACK shape (docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up,
// lines 154-227): frames with the ACK marker (ACKNum === 6) reach the `switch (ack_port)` block; every
// port other than 10 (radio config) and 24 (counter reading) falls into the `default` case, which emits
// `Ack_Port` (the echoed port, always a Number) and `Ack_Value` (parseInt(...,16), a Number). There is no
// boolean `Ack` field anywhere in the decoder output — a periodic (non-ACK) uplink omits `Ack_Port`
// entirely, so its presence alone is what marks a frame as a Gen2 ACK.
test('Gen2 scheduler ACK on port 25 maps to DAYMASK_PLAN and hints GEN2', () => {
  const r = interpretUplink({ MMType: 'ACK 25', Payload: '\x20\x35\x00\x06\x19\x00', Port: 2, Ack_Port: 25, Ack_Value: 0, Battery: 32 }, 2);
  assert.deepEqual(r.acks, [{ purpose: 'DAYMASK_PLAN', fport: 25, weekday: null, status: 0 }]);
  assert.equal(r.generationHint, 'GEN2');
});

test('Gen2 clock-sync ACK on port 13 maps to CLOCK_SYNC and hints GEN2', () => {
  const r = interpretUplink({ MMType: 'Date Time Update', Ack_Port: 13, Ack_Value: 1 }, 2);
  assert.deepEqual(r.acks, [{ purpose: 'CLOCK_SYNC', fport: 13, weekday: null, status: 1 }]);
  assert.equal(r.generationHint, 'GEN2');
});

test('Gen2 periodic uplink (no Ack_Port) yields no acks and no generation hint', () => {
  const r = interpretUplink({ MMType: 'PERIODIC UpLink', Port: 2, Battery: 210, Actuator: 0 }, 2);
  assert.deepEqual(r.acks, []);
  assert.equal(r.generationHint, null);
});

test('decodeGen1Fallback returns null (never throws) when the codec source cannot be read', () => {
  const brokenFs = { readFileSync() { throw new Error('ENOENT: no such codec'); } };
  assert.equal(decodeGen1Fallback(brokenFs, 'not-a-real-payload==', 2), null);
});

test('decodeGen1Fallback returns null for empty/missing payload without touching fs', () => {
  const explodingFs = { readFileSync() { throw new Error('must not be called'); } };
  assert.equal(decodeGen1Fallback(explodingFs, '', 2), null);
  assert.equal(decodeGen1Fallback(explodingFs, null, 2), null);
});

test('decodeGen1Fallback decodes a real Gen1 scheduler ACK frame to an object containing Schl_Port', () => {
  // Frame layout per ChirpStack-STREGA-CODEC-Decoder-Gen1 (also mirrored in codecs/strega_gen1_decoder.js):
  // byte0 high nibble '3' (battery-operated class) + battery ASCII digits (bytes 0-3) + a status byte
  // (byte4) + '@' (0x40, byte5) + 2 ASCII-hex chars for the echoed port (bytes 6-7) + 2 ASCII-hex chars
  // for the status (bytes 8-9). Port "10" hex = 16 (Schl_Port branch, conf_p in 14..20).
  const bytes = Buffer.from([0x32, 0x30, 0x35, 0x30, 0x30, 0x40, 0x31, 0x30, 0x30, 0x30]);
  const decoded = decodeGen1Fallback(fs, bytes.toString('base64'), 2);
  assert.ok(decoded && typeof decoded === 'object');
  assert.equal(decoded.Schl_Port, 16);
  assert.equal(decoded.Schl_status, '00');
});
