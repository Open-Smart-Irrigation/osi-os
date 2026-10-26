'use strict';

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function kpaToPf(value) {
  const kpa = finiteNumber(value);
  if (kpa === null || kpa === 0) return null;
  const pf = Math.log10(Math.abs(kpa)) + 1;
  return Number.isFinite(pf) ? pf : null;
}

function pfToKpa(value) {
  const pf = finiteNumber(value);
  if (pf === null) return null;
  const kpa = Math.pow(10, pf - 1);
  return Number.isFinite(kpa) && kpa > 0 ? kpa : null;
}

module.exports = { kpaToPf, pfToKpa };
