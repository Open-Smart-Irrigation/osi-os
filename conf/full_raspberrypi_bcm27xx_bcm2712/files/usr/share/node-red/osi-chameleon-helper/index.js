'use strict';

const MAX_VALID_RESISTANCE_OHMS = 10000000;
const MIN_KPA = 0;
const MAX_KPA = 300;

const DEFAULT_CALIBRATION = Object.freeze({
  swt1: Object.freeze({ a: 10.71, b: 0.13, c: 7.18 }),
  swt2: Object.freeze({ a: 10.40, b: 0.13, c: 7.31 }),
  swt3: Object.freeze({ a: 10.33, b: 0.12, c: 7.21 }),
});

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toFlag(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true' || value.trim() === '1';
  return Number(value || 0) === 1;
}

function roundTo(value, decimals) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const factor = Math.pow(10, Number(decimals) || 0);
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, min), max);
}

function normalizeCoefficients(input, fallback) {
  const a = toFiniteNumber(input && input.a);
  const b = toFiniteNumber(input && input.b);
  const c = toFiniteNumber(input && input.c);
  return {
    a: a === null ? fallback.a : a,
    b: b === null ? fallback.b : b,
    c: c === null ? fallback.c : c,
  };
}

function calibrationFromDeviceRow(row = {}) {
  return {
    enabled: Number(row.chameleon_enabled || 0) === 1 ? 1 : 0,
    swt1: normalizeCoefficients(
      { a: row.chameleon_swt1_a, b: row.chameleon_swt1_b, c: row.chameleon_swt1_c },
      DEFAULT_CALIBRATION.swt1,
    ),
    swt2: normalizeCoefficients(
      { a: row.chameleon_swt2_a, b: row.chameleon_swt2_b, c: row.chameleon_swt2_c },
      DEFAULT_CALIBRATION.swt2,
    ),
    swt3: normalizeCoefficients(
      { a: row.chameleon_swt3_a, b: row.chameleon_swt3_b, c: row.chameleon_swt3_c },
      DEFAULT_CALIBRATION.swt3,
    ),
  };
}

function resistanceOhmsToKpa(ohms, coefficients) {
  const resistanceOhms = toFiniteNumber(ohms);
  const coeffs = normalizeCoefficients(coefficients || {}, DEFAULT_CALIBRATION.swt1);
  if (resistanceOhms === null || resistanceOhms <= 0 || resistanceOhms >= MAX_VALID_RESISTANCE_OHMS) {
    return null;
  }
  const resistanceKOhms = resistanceOhms / 1000;
  const kpa = coeffs.a * Math.log(resistanceKOhms) + coeffs.b * resistanceKOhms + coeffs.c;
  if (!Number.isFinite(kpa)) return null;
  return roundTo(clamp(kpa, MIN_KPA, MAX_KPA), 2);
}

function buildChameleonSwtMetrics(sample = {}, config = {}) {
  const calibration = {
    enabled: Number(config.enabled || 0) === 1 ? 1 : 0,
    swt1: normalizeCoefficients(config.swt1 || {}, DEFAULT_CALIBRATION.swt1),
    swt2: normalizeCoefficients(config.swt2 || {}, DEFAULT_CALIBRATION.swt2),
    swt3: normalizeCoefficients(config.swt3 || {}, DEFAULT_CALIBRATION.swt3),
  };
  const dataInvalid = toFlag(sample.i2cMissing) || toFlag(sample.timeout);
  const enabled = calibration.enabled === 1;
  return {
    enabled,
    dataInvalid,
    swt1Kpa: enabled && !dataInvalid && !toFlag(sample.ch1Open)
      ? resistanceOhmsToKpa(sample.r1OhmComp, calibration.swt1)
      : null,
    swt2Kpa: enabled && !dataInvalid && !toFlag(sample.ch2Open)
      ? resistanceOhmsToKpa(sample.r2OhmComp, calibration.swt2)
      : null,
    swt3Kpa: enabled && !dataInvalid && !toFlag(sample.ch3Open)
      ? resistanceOhmsToKpa(sample.r3OhmComp, calibration.swt3)
      : null,
  };
}

module.exports = {
  DEFAULT_CALIBRATION,
  MAX_VALID_RESISTANCE_OHMS,
  calibrationFromDeviceRow,
  resistanceOhmsToKpa,
  buildChameleonSwtMetrics,
  toFiniteNumber,
};
