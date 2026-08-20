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
//
// This exact object is not hand-rolled: it is the captured, unedited return value of running the
// real decoder (docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up)
// against the raw byte frame `GEN2_RAW_SCHEDULER_ACK_BYTES` below (same frame used by the raw-byte
// test further down), so both tests are provably consistent with each other and with the vendor
// decoder. Battery 517 = parseInt("205", 16); Payload's 6th character is the literal 0x06 ACK
// marker byte (renders as a control character, not the digit "6").
test('Gen2 scheduler ACK on port 25 maps to DAYMASK_PLAN and hints GEN2', () => {
  const decoded = {
    MMType: 'ACK 25',
    Payload: '205001900',
    Port: 2,
    Ack_Port: 25,
    Ack_Value: 0,
    Battery: 517,
    Actuator: 0,
    Cable: 0,
    DI_0_LSO: 0,
    DI_1_LSC: 0,
    Class: 0,
    Power: 0,
  };
  const r = interpretUplink(decoded, 2);
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

// --- Fix round 1 -----------------------------------------------------------------------------
// Review found the decoded-object Gen2 path above is unreachable in production: ChirpStack
// provisions exactly one STREGA device profile, wired to the Gen1 codec, for every valve
// (chirpstack-bootstrap.js ~line 445), so a real SV2's ACK frames always arrive already decoded
// as plain Gen1 telemetry -- no `Ack_Port` ever appears. Spec §3 anticipates this and specifies
// raw-byte detection instead ("the Gen2 ACK marker 0x06 and a 3-char battery field"), hence the
// new `rawBytes` third parameter and the guard hardening below.

test('Gen1 non-integer Schl_Port does not yield a fractional weekday ack', () => {
  // 16.5 is in [14, 20] by value but is not a real conf_p the vendor decoder can ever produce
  // (conf_p comes from parseInt(...), always an integer); a fractional Schl_Port here can only
  // be a malformed/tampered object and must not resolve to weekday 2.5.
  const r = interpretUplink({ Schl_Port: 16.5, Schl_status: '00' }, 2);
  assert.deepEqual(r.acks, []);
  assert.equal(r.generationHint, null);
});

test('Gen2 Ack_Port that is not a positive integer (short/truncated ACK frame) does not promote to GEN2', () => {
  // A Gen2 ACK frame with fewer than 8 payload bytes has no port digits to parse:
  // `parseInt(payload.substr(6,2), 16)` on an empty/undersized substring is `NaN`, and `NaN`
  // round-trips through JSON as `null`. A bare `Number.isFinite(Number(x))` guard would read
  // `Number(null) === 0` as a real "port 0" ACK and falsely promote to GEN2.
  assert.deepEqual(interpretUplink({ Ack_Port: NaN, Ack_Value: 0 }, 2), { acks: [], generationHint: null });
  assert.deepEqual(interpretUplink({ Ack_Port: null, Ack_Value: 0 }, 2), { acks: [], generationHint: null });
  assert.deepEqual(interpretUplink({ Ack_Port: 0, Ack_Value: 0 }, 2), { acks: [], generationHint: null });
});

// Raw byte frame layout per ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up: 3 ASCII
// hex-digit battery bytes ("205" -> Battery 517), 2 ASCII hex-digit status bytes ("00"), the
// literal 0x06 ACK-marker byte, 2 ASCII hex-digit port bytes ("19" -> hex 0x19 -> decimal 25),
// 2 ASCII hex-digit value bytes ("00"). Verified by running it through the real vendor decoder
// (see task-3-report.md fix-round-1 section) before use here; the decoded-object test above
// uses that decoder's exact captured output for the same frame.
const GEN2_RAW_SCHEDULER_ACK_BYTES = Buffer.from([0x32, 0x30, 0x35, 0x30, 0x30, 0x06, 0x31, 0x39, 0x30, 0x30]);

test('raw-byte GEN2 detection: production path where the codec decoded a Gen2 ACK as plain Gen1 telemetry', () => {
  // This is the real production shape: ChirpStack's single Gen1-codec profile applied to the raw
  // bytes of an actual Gen2 scheduler ACK produces ordinary (ack-less) Gen1 telemetry -- captured
  // by running codecs/strega_gen1_decoder.js against GEN2_RAW_SCHEDULER_ACK_BYTES.
  const gen1MisdecodedShape = {
    Port: 2, Status: '00000000', Battery: 3, Valve: '0', Tamper: '0', Cable: '0',
    DI_0: '0', DI_1: '0', Leakage: '0', Fraud: '0', Class: '0', Power: '0', Process: 'true',
  };
  const r = interpretUplink(gen1MisdecodedShape, 2, GEN2_RAW_SCHEDULER_ACK_BYTES);
  assert.deepEqual(r.acks, [{ purpose: 'DAYMASK_PLAN', fport: 25, weekday: null, status: 0 }]);
  assert.equal(r.generationHint, 'GEN2');
});

test('raw-byte GEN2 detection: marker present but frame too short for a port yields the GEN2 hint with no ack', () => {
  const r = interpretUplink({}, 2, Buffer.from([0x32, 0x30, 0x35, 0x30, 0x30, 0x06]));
  assert.deepEqual(r.acks, []);
  assert.equal(r.generationHint, 'GEN2');
});

test('raw-byte GEN2 detection: a real Gen1 ACK frame does not false-positive (Gen1 has 0x40 "@" at index 5, not 0x06)', () => {
  const gen1AckRawBytes = Buffer.from([0x32, 0x30, 0x35, 0x30, 0x30, 0x40, 0x31, 0x30, 0x30, 0x30]);
  assert.equal(gen1AckRawBytes[5], 0x40); // confirms the offset the false-positive guard depends on
  const r = interpretUplink({}, 2, gen1AckRawBytes);
  assert.deepEqual(r.acks, []);
  assert.equal(r.generationHint, null);
});

test('raw-byte GEN2 detection: random telemetry bytes do not false-positive', () => {
  const randomTelemetryBytes = Buffer.from([0x32, 0x31, 0x30, 0x30, 0x30, 0x00, 0x00, 0x00]);
  const r = interpretUplink({}, 2, randomTelemetryBytes);
  assert.deepEqual(r.acks, []);
  assert.equal(r.generationHint, null);
});

test('raw-byte GEN2 detection is skipped when the decoded object already produced an ack', () => {
  // A real Gen1 ack must never be overridden by the raw fallback, even if rawBytes is also passed.
  const r = interpretUplink({ Schl_Port: 16, Schl_status: '00' }, 2, GEN2_RAW_SCHEDULER_ACK_BYTES);
  assert.deepEqual(r.acks, [{ purpose: 'WEEKDAY_PLAN', fport: 16, weekday: 2, status: 0 }]);
  assert.equal(r.generationHint, 'GEN1');
});
// --- end fix round 1 --------------------------------------------------------------------------

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
