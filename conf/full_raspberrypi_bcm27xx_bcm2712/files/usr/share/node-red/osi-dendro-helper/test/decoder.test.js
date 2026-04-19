'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeRawAdcPayload,
  decodeStockMod3Payload,
  buildDendroDerivedMetrics,
} = require('..');

function buildStockMod3Base64(opts = {}) {
  const {
    oilMv = 1500,
    adc1Mv = 3000,
    adc2Mv = 0,
    switchStatus = 0,
    shtTempC = 20.5,
    shtHumPct = 55.0,
    battMvDiv100 = 33,
  } = opts;
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(oilMv, 0);
  buf.writeUInt16BE(adc1Mv, 2);
  buf.writeUInt16BE(adc2Mv, 4);
  buf[6] = (switchStatus << 7) | 0x08;
  buf.writeInt16BE(Math.round(shtTempC * 10), 7);
  buf.writeInt16BE(Math.round(shtHumPct * 10), 9);
  buf[11] = battMvDiv100;
  return buf.toString('base64');
}

test('decodeStockMod3Payload: happy path', () => {
  const out = decodeStockMod3Payload(buildStockMod3Base64());
  assert.equal(out.modeCode, 3);
  assert.equal(out.modeLabel, 'MOD3');
  assert.equal(out.adcCh0V, 1.5);
  assert.equal(out.adcCh1V, 3.0);
  assert.equal(out.adcCh4V, 0.0);
  assert.equal(out.batV, 3.3);
  assert.equal(out.switchStatus, 0);
  assert.equal(out.statusByte, 0x08);
});

test('decodeStockMod3Payload: tempC1 is null (not carried in MOD=3 wire)', () => {
  const out = decodeStockMod3Payload(buildStockMod3Base64());
  assert.equal(out.tempC1, null);
});

test('decodeStockMod3Payload: switch bit propagates from buf[6]', () => {
  const out = decodeStockMod3Payload(buildStockMod3Base64({ switchStatus: 1 }));
  assert.equal(out.switchStatus, 1);
  assert.equal(out.statusByte, 0x88);
});

test('decodeStockMod3Payload: short buffer returns null', () => {
  const buf = Buffer.alloc(8);
  assert.equal(decodeStockMod3Payload(buf.toString('base64')), null);
});

test('decodeStockMod3Payload: wrong mode nibble returns null', () => {
  const buf = Buffer.from(buildStockMod3Base64(), 'base64');
  buf[6] = (buf[6] & ~0x7c) | 0x00;
  assert.equal(decodeStockMod3Payload(buf.toString('base64')), null);
});

test('decodeRawAdcPayload dispatches 12-byte MOD=3 to stock decoder', () => {
  const out = decodeRawAdcPayload(buildStockMod3Base64());
  assert.equal(out.modeLabel, 'MOD3');
  assert.equal(out.adcCh0V, 1.5);
  assert.equal(out.adcCh1V, 3.0);
  assert.equal(out.adcCh4V, 0.0);
});

test('decodeRawAdcPayload: legacy MOD=1 frame still decoded by legacy path', () => {
  const buf = Buffer.alloc(11);
  buf.writeUInt16BE(3200, 0);
  buf.writeInt16BE(200, 2);
  buf.writeUInt16BE(1500, 4);
  buf[6] = 0x00;
  buf[10] = 40;
  const out = decodeRawAdcPayload(buf.toString('base64'));
  assert.equal(out.batV, 3.2);
  assert.equal(out.modeCode, 1);
});

test('buildDendroDerivedMetrics: stock MOD=3 decode produces ratio_mod3 metrics', () => {
  const decoded = decodeStockMod3Payload(buildStockMod3Base64());
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: 3,
    strokeMm: 10,
    ratioZero: 0.0,
    ratioSpan: 1.0,
  });
  assert.equal(metrics.dendroModeUsed, 'ratio_mod3');
  assert.equal(metrics.dendroRatio, 0.5);
  assert.equal(metrics.dendroValid, 1);
});

test('buildDendroDerivedMetrics: tiny PA1 reference flags reference_voltage_too_small', () => {
  const decoded = decodeStockMod3Payload(buildStockMod3Base64({ adc1Mv: 40 }));
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: 3,
  });
  assert.equal(metrics.dendroValid, 0);
  assert.equal(metrics.ratioInvalidReason, 'reference_voltage_too_small');
});

test('REF_HIGH: reference voltage near VDDA flags invalid', () => {
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: 2.0,
    adcCh1V: 3.1,
    batV: 3.2,
    effectiveMode: 3,
  });
  assert.equal(metrics.dendroValid, 0);
  assert.equal(metrics.ratioInvalidReason, 'reference_voltage_too_high');
  assert.equal(metrics.positionMm, null);
  assert.equal(metrics.dendroRatio, null);
});

test('REF_HIGH: reference safely below 0.95*VDDA passes', () => {
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: 1.25,
    adcCh1V: 2.5,
    batV: 3.3,
    effectiveMode: 3,
    strokeMm: 10,
    ratioZero: 0.0,
    ratioSpan: 1.0,
  });
  assert.equal(metrics.dendroValid, 1);
  assert.equal(metrics.ratioInvalidReason, null);
});

test('REF_HIGH: missing batV disables the guard (no false positives)', () => {
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: 1.25,
    adcCh1V: 2.5,
    effectiveMode: 3,
  });
  assert.equal(metrics.dendroValid, 1);
  assert.notEqual(metrics.ratioInvalidReason, 'reference_voltage_too_high');
});
