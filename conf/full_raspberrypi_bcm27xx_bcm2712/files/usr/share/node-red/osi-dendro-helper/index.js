'use strict';

const SMALL_REFERENCE_THRESHOLD = 0.05;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function lsn50ModeLabel(modeCode) {
  const numericMode = toFiniteNumber(modeCode);
  if (numericMode === null) return null;
  if (numericMode >= 1 && numericMode <= 9) return `MOD${numericMode}`;
  return null;
}

function detectLsn50ModeCode(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 7) return null;
    const rawMode = (buf[6] >> 2) & 0x1f;
    const modeCode = rawMode + 1;
    return modeCode >= 1 && modeCode <= 9 ? modeCode : null;
  } catch (_) {
    return null;
  }
}

function decodeRawAdcPayload(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 7) return null;

    const batV = ((buf[0] << 8) | buf[1]) / 1000;
    const modeCode = detectLsn50ModeCode(b64);
    const tempDisconnected = buf.length >= 4 && buf[2] === 0x7f && buf[3] === 0xff;
    const tempRaw = buf.length >= 4 ? ((buf[2] << 24 >> 16) | buf[3]) : null;
    const tempC1 = tempDisconnected || tempRaw === null ? null : tempRaw / 10;
    const adcCh0V = buf.length >= 6 ? ((buf[4] << 8) | buf[5]) / 1000 : null;
    // Only trust the raw CH1/CH4 layout when the observed payload is actually MOD3.
    const adcCh1V = modeCode === 3 && buf.length >= 9 ? ((buf[7] << 8) | buf[8]) / 1000 : null;
    const adcCh4V = modeCode === 3 && buf.length >= 11 ? ((buf[9] << 8) | buf[10]) / 1000 : null;

    return {
      batV,
      tempC1,
      adcCh0V,
      adcCh1V,
      adcCh4V,
      modeCode,
      modeLabel: lsn50ModeLabel(modeCode),
    };
  } catch (_) {
    return null;
  }
}

function calculateDendroRatio(adcCh0V, adcCh1V, options = {}) {
  const signal = toFiniteNumber(adcCh0V);
  const reference = toFiniteNumber(adcCh1V);
  const threshold = toFiniteNumber(options.smallReferenceThreshold) ?? SMALL_REFERENCE_THRESHOLD;

  if (signal === null || reference === null) {
    return { ratio: null, isValid: false, invalidReason: 'missing_adc_channels' };
  }
  if (reference <= threshold) {
    return { ratio: null, isValid: false, invalidReason: 'reference_voltage_too_small' };
  }

  const ratio = signal / reference;
  if (!Number.isFinite(ratio)) {
    return { ratio: null, isValid: false, invalidReason: 'ratio_not_finite' };
  }

  return { ratio: roundTo(ratio, 6), isValid: true, invalidReason: null };
}

function detectDendroModeUsed(options = {}) {
  const forceLegacy = Number(options.forceLegacy || 0) === 1;
  const effectiveMode = toFiniteNumber(options.effectiveMode);
  const adcCh0V = toFiniteNumber(options.adcCh0V);
  const adcCh1V = toFiniteNumber(options.adcCh1V);
  const threshold = toFiniteNumber(options.smallReferenceThreshold) ?? SMALL_REFERENCE_THRESHOLD;

  if (forceLegacy) return 'legacy_single_adc';
  if (effectiveMode === 3 && adcCh0V !== null && adcCh1V !== null && adcCh1V > threshold) {
    return 'ratio_mod3';
  }
  return 'legacy_single_adc';
}

function normalizeRatioCalibration(options = {}) {
  const strokeMm = toFiniteNumber(options.strokeMm);
  let ratioAtRetracted = toFiniteNumber(options.ratioAtRetracted);
  let ratioAtExtended = toFiniteNumber(options.ratioAtExtended);

  if (ratioAtRetracted === null || ratioAtExtended === null) {
    const ratioZero = toFiniteNumber(options.ratioZero);
    const ratioSpan = toFiniteNumber(options.ratioSpan);
    const invertDirection = Number(options.invertDirection || 0) === 1;

    if (ratioAtRetracted === null && ratioZero !== null && ratioSpan !== null) {
      ratioAtRetracted = invertDirection ? ratioSpan : ratioZero;
    }
    if (ratioAtExtended === null && ratioZero !== null && ratioSpan !== null) {
      ratioAtExtended = invertDirection ? ratioZero : ratioSpan;
    }
  }

  return {
    strokeMm,
    ratioAtRetracted,
    ratioAtExtended,
  };
}

function calibrationSignature(options = {}) {
  const calibration = normalizeRatioCalibration(options);
  return [
    calibration.strokeMm === null ? 'null' : calibration.strokeMm,
    calibration.ratioAtRetracted === null ? 'null' : calibration.ratioAtRetracted,
    calibration.ratioAtExtended === null ? 'null' : calibration.ratioAtExtended,
  ].join('|');
}

function calculateRatioDendroPositionRawMm(options = {}) {
  const calibration = normalizeRatioCalibration(options);
  const strokeMm = calibration.strokeMm;
  const ratioAtRetracted = calibration.ratioAtRetracted;
  const ratioAtExtended = calibration.ratioAtExtended;
  const ratio = toFiniteNumber(options.ratio);

  if (strokeMm === null || ratioAtRetracted === null || ratioAtExtended === null || ratio === null) return null;
  if (strokeMm <= 0 || ratioAtExtended === ratioAtRetracted) return null;

  const numerator = strokeMm * (ratio - ratioAtRetracted);
  const denominator = ratioAtExtended - ratioAtRetracted;
  const position = numerator / denominator;
  if (!Number.isFinite(position)) return null;

  return roundTo(position, 3);
}

function calculateRatioDendroPositionMm(options = {}) {
  const calibration = normalizeRatioCalibration(options);
  const rawPosition = calculateRatioDendroPositionRawMm(options);
  if (rawPosition === null || calibration.strokeMm === null) return null;

  return roundTo(clamp(rawPosition, 0, calibration.strokeMm), 3);
}

function buildDendroDerivedMetrics(options = {}) {
  const adcCh0V = toFiniteNumber(options.adcCh0V);
  const adcCh1V = toFiniteNumber(options.adcCh1V);
  const calibration = normalizeRatioCalibration(options);
  const strokeMm = calibration.strokeMm;
  const modeUsed = detectDendroModeUsed(options);
  const legacyValid = adcCh0V !== null ? (adcCh0V >= 0 && adcCh0V <= 2.6 ? 1 : 0) : null;
  const legacyPositionMm = legacyValid === 1 ? roundTo(adcCh0V * 10, 3) : null;
  const ratioInfo = modeUsed === 'ratio_mod3'
    ? calculateDendroRatio(adcCh0V, adcCh1V, options)
    : { ratio: null, isValid: false, invalidReason: null };

  let dendroValid = legacyValid;
  let positionRawMm = legacyPositionMm;
  let positionMm = legacyPositionMm;
  let calibrationMissing = false;
  let dendroSaturated = 0;
  let dendroSaturationSide = null;

  if (modeUsed === 'ratio_mod3') {
    dendroValid = ratioInfo.isValid ? 1 : 0;
    positionRawMm = calculateRatioDendroPositionRawMm({
      strokeMm,
      ratioAtRetracted: calibration.ratioAtRetracted,
      ratioAtExtended: calibration.ratioAtExtended,
      ratio: ratioInfo.ratio,
    });
    positionMm = calculateRatioDendroPositionMm({
      strokeMm,
      ratioAtRetracted: calibration.ratioAtRetracted,
      ratioAtExtended: calibration.ratioAtExtended,
      ratio: ratioInfo.ratio,
    });
    if (ratioInfo.isValid && positionRawMm === null) {
      calibrationMissing = true;
    }
    if (positionRawMm !== null && strokeMm !== null && strokeMm > 0) {
      if (positionRawMm < 0) {
        dendroSaturated = 1;
        dendroSaturationSide = 'low';
      } else if (positionRawMm > strokeMm) {
        dendroSaturated = 1;
        dendroSaturationSide = 'high';
      }
    }
  }

  return {
    adcCh0V,
    adcCh1V,
    dendroModeUsed: modeUsed,
    dendroRatio: ratioInfo.ratio,
    dendroValid,
    positionRawMm,
    positionMm,
    positionUm: positionMm === null ? null : Math.round(positionMm * 1000),
    dendroSaturated,
    dendroSaturationSide,
    ratioInvalidReason: ratioInfo.invalidReason,
    calibrationMissing,
    calibrationSignature: calibrationSignature({
      strokeMm,
      ratioAtRetracted: calibration.ratioAtRetracted,
      ratioAtExtended: calibration.ratioAtExtended,
    }),
    strokeMm,
    ratioAtRetracted: calibration.ratioAtRetracted,
    ratioAtExtended: calibration.ratioAtExtended,
  };
}

function computeDendroDeltaMm(options = {}) {
  const positionMm = toFiniteNumber(options.positionMm);
  const modeUsed = String(options.modeUsed || '');
  const calibrationSig = String(options.calibrationSignature || '');
  const previous = options.previousState && typeof options.previousState === 'object'
    ? options.previousState
    : null;

  if (positionMm === null) {
    return {
      deltaMm: null,
      nextState: null,
      reset: true,
    };
  }

  if (
    !previous
    || toFiniteNumber(previous.positionMm) === null
    || String(previous.modeUsed || '') !== modeUsed
    || String(previous.calibrationSignature || '') !== calibrationSig
  ) {
    return {
      deltaMm: null,
      nextState: { positionMm, modeUsed, calibrationSignature: calibrationSig },
      reset: true,
    };
  }

  return {
    deltaMm: roundTo(positionMm - Number(previous.positionMm), 3),
    nextState: { positionMm, modeUsed, calibrationSignature: calibrationSig },
    reset: false,
  };
}

function computeDendroStemChangeUm(options = {}) {
  const positionMm = toFiniteNumber(options.positionMm);
  const modeUsed = String(options.modeUsed || '');
  const calibrationSig = String(options.calibrationSignature || '');
  const baseline = options.baselineState && typeof options.baselineState === 'object'
    ? options.baselineState
    : null;

  if (positionMm === null) {
    return {
      stemChangeUm: null,
      nextBaseline: null,
      reset: true,
    };
  }

  if (
    !baseline
    || toFiniteNumber(baseline.positionMm) === null
    || String(baseline.modeUsed || '') !== modeUsed
    || String(baseline.calibrationSignature || '') !== calibrationSig
  ) {
    return {
      stemChangeUm: 0,
      nextBaseline: { positionMm, modeUsed, calibrationSignature: calibrationSig },
      reset: true,
    };
  }

  const baselinePositionMm = Number(baseline.positionMm);
  if (!Number.isFinite(baselinePositionMm)) {
    return {
      stemChangeUm: 0,
      nextBaseline: { positionMm, modeUsed, calibrationSignature: calibrationSig },
      reset: true,
    };
  }

  return {
    stemChangeUm: Math.round((positionMm - baselinePositionMm) * 1000),
    nextBaseline: {
      positionMm: baselinePositionMm,
      modeUsed,
      calibrationSignature: calibrationSig,
    },
    reset: false,
  };
}

module.exports = {
  SMALL_REFERENCE_THRESHOLD,
  toFiniteNumber,
  roundTo,
  lsn50ModeLabel,
  detectLsn50ModeCode,
  decodeRawAdcPayload,
  detectDendroModeUsed,
  normalizeRatioCalibration,
  calculateDendroRatio,
  calculateRatioDendroPositionRawMm,
  calculateRatioDendroPositionMm,
  buildDendroDerivedMetrics,
  calibrationSignature,
  computeDendroDeltaMm,
  computeDendroStemChangeUm,
};
