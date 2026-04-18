'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeMod3DendroPayload,
} = require('..');

function hex(bytes) {
  return Buffer.from(bytes).toString('base64');
}

// Fixture: valid MOD=3 dendrometer frame
//   battery = 3200 mV = 0x0C80
//   signal  = 2048    = 0x0800
//   ref     = 2048    = 0x0800
//   status  = 0x08 (mode nibble = 3, nothing else set)
//   flags   = 0x01 (VALID)
const FRAME_VALID = [0x0C, 0x80, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01];

test('decodeMod3DendroPayload: valid frame populates all fields', () => {
  const out = decodeMod3DendroPayload(hex(FRAME_VALID));
  assert.equal(out.batV, 3.2);
  assert.equal(out.adcSignalAvgRaw, 2048);
  assert.equal(out.adcReferenceAvgRaw, 2048);
  assert.equal(out.statusByte, 0x08);
  assert.equal(out.modeCode, 3);
  assert.equal(out.modeLabel, 'MOD3');
  assert.equal(out.dendroFlags, 0x01);
  assert.equal(out.measurementValid, true);
  assert.equal(out.refTooLow, false);
  assert.equal(out.refTooHigh, false);
  assert.equal(out.adcFail, false);
  assert.equal(out.dendroRatio, 1);
  // Back-compat aliases: raw * 5.0 / 4095
  assert.ok(Math.abs(out.adcCh0V - (2048 * 5 / 4095)) < 1e-6);
  assert.ok(Math.abs(out.adcCh1V - (2048 * 5 / 4095)) < 1e-6);
  assert.equal(out.adcCh4V, null);
});

test('decodeMod3DendroPayload: REF_LOW sets flags and nulls ratio', () => {
  const frame = [0x0C, 0x80, 0x04, 0x00, 0x00, 0x32, 0x08, 0x02];
  const out = decodeMod3DendroPayload(hex(frame));
  assert.equal(out.measurementValid, false);
  assert.equal(out.refTooLow, true);
  assert.equal(out.refTooHigh, false);
  assert.equal(out.dendroRatio, null);
});

test('decodeMod3DendroPayload: REF_HIGH sets flags and nulls ratio', () => {
  const frame = [0x0C, 0x80, 0x04, 0x00, 0x0F, 0xFF, 0x08, 0x04];
  const out = decodeMod3DendroPayload(hex(frame));
  assert.equal(out.refTooHigh, true);
  assert.equal(out.dendroRatio, null);
});

test('decodeMod3DendroPayload: ADC_FAIL flag', () => {
  const frame = [0x0C, 0x80, 0x00, 0x00, 0x08, 0x00, 0x08, 0x08];
  const out = decodeMod3DendroPayload(hex(frame));
  assert.equal(out.adcFail, true);
  assert.equal(out.measurementValid, false);
  assert.equal(out.dendroRatio, null);
});

test('decodeMod3DendroPayload: wrong-length buffer returns null', () => {
  const frame = [0x0C, 0x80, 0x08, 0x00];
  assert.equal(decodeMod3DendroPayload(hex(frame)), null);
});

test('decodeRawAdcPayload: 8-byte MOD=3 frame goes through new decoder', () => {
  const frame = [0x0C, 0x80, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01];
  const { decodeRawAdcPayload } = require('..');
  const out = decodeRawAdcPayload(hex(frame));
  assert.equal(out.modeCode, 3);
  assert.equal(out.adcSignalAvgRaw, 2048);
  assert.equal(out.measurementValid, true);
  // Back-compat alias still present so downstream flow code works.
  assert.ok(typeof out.adcCh0V === 'number');
});

test('decodeRawAdcPayload: legacy MOD=1 frame still works', () => {
  // 11 bytes, MOD=1: battery=3200, temp=200, oil=1500, status byte mode
  // nibble = 0 (encodes MOD=1 per detectLsn50ModeCode: rawMode + 1).
  const frame = [0x0C, 0x80, 0x00, 0xC8, 0x05, 0xDC, 0x00, 0x00, 0x3C, 0x00, 0x28];
  const { decodeRawAdcPayload } = require('..');
  const out = decodeRawAdcPayload(hex(frame));
  assert.equal(out.batV, 3.2);
  assert.equal(out.modeCode, 1);
});
