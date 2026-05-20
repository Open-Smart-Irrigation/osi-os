'use strict';

const MAX_VALID_RESISTANCE_OHMS = 10000000;
const MIN_KPA = 0;
const MAX_KPA = 300;

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
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, min), max);
}

function normalizeArrayId(arrayId) {
  if (typeof arrayId !== 'string') return null;
  const upper = arrayId.toUpperCase();
  return /^[0-9A-F]{16}$/.test(upper) ? upper : null;
}

function resistanceOhmsToKpa(ohms, coefficients) {
  const resistanceOhms = toFiniteNumber(ohms);
  if (!coefficients || resistanceOhms === null
      || resistanceOhms <= 0 || resistanceOhms >= MAX_VALID_RESISTANCE_OHMS) {
    return null;
  }
  const resistanceKOhms = resistanceOhms / 1000;
  const kpa = coefficients.a * Math.log(resistanceKOhms)
            + coefficients.b * resistanceKOhms
            + coefficients.c;
  if (!Number.isFinite(kpa)) return null;
  return roundTo(clamp(kpa, MIN_KPA, MAX_KPA), 2);
}

function buildChameleonSwtMetrics(sample = {}, options = {}) {
  const { enabled = false, calibration = null } = options;
  const dataInvalid = toFlag(sample.i2cMissing) || toFlag(sample.timeout);
  const usable = enabled && !dataInvalid && calibration !== null;
  return {
    enabled: Boolean(enabled),
    dataInvalid,
    calibrationStatus: calibration !== null ? 'calibrated' : 'pending',
    swt1Kpa: usable && !toFlag(sample.ch1Open)
      ? resistanceOhmsToKpa(sample.r1OhmComp, calibration.swt1) : null,
    swt2Kpa: usable && !toFlag(sample.ch2Open)
      ? resistanceOhmsToKpa(sample.r2OhmComp, calibration.swt2) : null,
    swt3Kpa: usable && !toFlag(sample.ch3Open)
      ? resistanceOhmsToKpa(sample.r3OhmComp, calibration.swt3) : null,
  };
}

module.exports = {
  MAX_VALID_RESISTANCE_OHMS,
  normalizeArrayId,
  resistanceOhmsToKpa,
  buildChameleonSwtMetrics,
  toFiniteNumber,
};
