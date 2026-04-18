'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeMod3DendroPayload,
  buildDendroDerivedMetrics,
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
  // Back-compat aliases: raw * batV / 4095 (VDDA ≈ batV on LSN50 V2).
  assert.ok(Math.abs(out.adcCh0V - (2048 * 3.2 / 4095)) < 1e-6);
  assert.ok(Math.abs(out.adcCh1V - (2048 * 3.2 / 4095)) < 1e-6);
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

test('buildDendroDerivedMetrics: ratio_mod3 path with new frame', () => {
  const {
    decodeRawAdcPayload,
    buildDendroDerivedMetrics,
  } = require('..');

  const frame = [0x0C, 0x80, 0x08, 0x00, 0x0C, 0x00, 0x08, 0x01];
  const decoded = decodeRawAdcPayload(hex(frame));

  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: decoded.modeCode,
    strokeMm: 50,
    ratioZero: 0.2,
    ratioSpan: 0.9,
    invertDirection: 0,
  });

  assert.equal(metrics.dendroModeUsed, 'ratio_mod3');
  assert.equal(typeof metrics.dendroRatio, 'number');
  assert.ok(metrics.dendroRatio > 0.66 && metrics.dendroRatio < 0.67);
  assert.equal(metrics.dendroValid, 1);
});

test('buildDendroDerivedMetrics: invalid MOD=3 frame falls to dendroValid=0', () => {
  const {
    decodeRawAdcPayload,
    buildDendroDerivedMetrics,
  } = require('..');

  // REF_LOW frame: ref raw=31 (≈0.038 V) falls below the 0.05 V threshold in
  // detectDendroModeUsed so the legacy path is selected; signal raw=0x0FFF
  // (≈5.0 V) falls outside the legacy valid band [0, 2.6], so legacyValid=0
  // and dendroValid propagates as 0.
  const frame = [0x0C, 0x80, 0x0F, 0xFF, 0x00, 0x1F, 0x08, 0x02];
  const decoded = decodeRawAdcPayload(hex(frame));

  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: decoded.modeCode,
    strokeMm: 50,
    ratioZero: 0.2,
    ratioSpan: 0.9,
    invertDirection: 0,
  });

  assert.equal(metrics.dendroValid, 0);
});

test('buildDendroDerivedMetrics: REF_HIGH firmware flag forces dendroValid=0 even when voltages look valid', () => {
  // Voltages in-band (signal=ref=2048 raw ≈ 1.6 V with batV=3.2) but firmware
  // reported REF_HIGH. The gateway must honor the firmware's validity bit.
  const metrics = buildDendroDerivedMetrics({
    effectiveMode: 3,
    adcCh0V: (2048 * 3.2) / 4095,
    adcCh1V: (2048 * 3.2) / 4095,
    measurementValid: false,
    strokeMm: 50,
    ratioZero: 0.2,
    ratioSpan: 0.9,
    invertDirection: 0,
  });
  assert.equal(metrics.dendroModeUsed, 'ratio_mod3');
  assert.equal(metrics.dendroValid, 0);
  assert.equal(metrics.dendroRatio, null);
  assert.equal(metrics.positionMm, null);
});

test('buildDendroDerivedMetrics: ADC_FAIL firmware flag forces dendroValid=0', () => {
  const metrics = buildDendroDerivedMetrics({
    effectiveMode: 3,
    adcCh0V: (2048 * 3.2) / 4095,
    adcCh1V: (2048 * 3.2) / 4095,
    measurementValid: false,
    strokeMm: 50,
    ratioZero: 0.2,
    ratioSpan: 0.9,
    invertDirection: 0,
  });
  assert.equal(metrics.dendroValid, 0);
  assert.equal(metrics.dendroRatio, null);
});

test('buildDendroDerivedMetrics: legacy (no measurementValid field) keeps voltage-derived validity', () => {
  // Stock firmware path: measurementValid is not passed. Voltage-based
  // validity governs, matching pre-existing behavior.
  const metrics = buildDendroDerivedMetrics({
    effectiveMode: 3,
    adcCh0V: 1.2,
    adcCh1V: 2.4,
    strokeMm: 40,
    ratioZero: 0.2,
    ratioSpan: 0.8,
    invertDirection: 0,
  });
  assert.equal(metrics.dendroModeUsed, 'ratio_mod3');
  assert.equal(metrics.dendroValid, 1);
  assert.ok(Math.abs(metrics.dendroRatio - 0.5) < 1e-6);
});
