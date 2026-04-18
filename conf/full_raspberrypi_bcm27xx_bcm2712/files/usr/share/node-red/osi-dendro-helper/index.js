'use strict';

const SMALL_REFERENCE_THRESHOLD = 0.05;

const DENDRO_FLAG_VALID    = 0x01;
const DENDRO_FLAG_REF_LOW  = 0x02;
const DENDRO_FLAG_REF_HIGH = 0x04;
const DENDRO_FLAG_ADC_FAIL = 0x08;

const MOD3_DENDRO_FRAME_LENGTH = 8;

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

function decodeMod3DendroPayload(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length !== MOD3_DENDRO_FRAME_LENGTH) return null;

    const batV                = ((buf[0] << 8) | buf[1]) / 1000;
    const adcSignalAvgRaw     = (buf[2] << 8) | buf[3];
    const adcReferenceAvgRaw  = (buf[4] << 8) | buf[5];
    const statusByte          = buf[6];
    const dendroFlags         = buf[7];

    const refTooLow        = (dendroFlags & DENDRO_FLAG_REF_LOW)  !== 0;
    const refTooHigh       = (dendroFlags & DENDRO_FLAG_REF_HIGH) !== 0;
    const adcFail          = (dendroFlags & DENDRO_FLAG_ADC_FAIL) !== 0;
    const measurementValid = (dendroFlags & DENDRO_FLAG_VALID)    !== 0;

    const dendroRatio = measurementValid && adcReferenceAvgRaw > 0
      ? roundTo(adcSignalAvgRaw / adcReferenceAvgRaw, 6)
      : null;

    const toVolts = (raw) => raw === null ? null : (raw * 5) / 4095;

    return {
      batV,
      adcSignalAvgRaw,
      adcReferenceAvgRaw,
      statusByte,
      modeCode: 3,
      modeLabel: 'MOD3',
      switchStatus: (statusByte >> 7) & 0x01,
      dendroFlags,
      measurementValid,
      refTooLow,
      refTooHigh,
      adcFail,
      dendroRatio,
      adcCh0V: toVolts(adcSignalAvgRaw),
      adcCh1V: toVolts(adcReferenceAvgRaw),
      adcCh4V: null,
    };
  } catch (_) {
    return null;
  }
}

function decodeRawAdcPayload(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 7) return null;

    // New MOD=3 dendrometer frame is always exactly 8 bytes with the
    // MOD nibble (bits 2..6 of byte 6) encoding "3" (raw==2).
    if (buf.length === MOD3_DENDRO_FRAME_LENGTH) {
      const rawMode = (buf[6] >> 2) & 0x1f;
      if (rawMode + 1 === 3) {
        return decodeMod3DendroPayload(b64);
      }
    }

    const batV = ((buf[0] << 8) | buf[1]) / 1000;
    const modeCode = detectLsn50ModeCode(b64);
    const tempDisconnected = buf.length >= 4 && buf[2] === 0x7f && buf[3] === 0xff;
    const tempRaw = buf.length >= 4 ? ((buf[2] << 24 >> 16) | buf[3]) : null;
    const tempC1 = tempDisconnected || tempRaw === null ? null : tempRaw / 10;
    const adcCh0V = buf.length >= 6 ? ((buf[4] << 8) | buf[5]) / 1000 : null;
    const adcCh1V = buf.length >= 9 ? ((buf[7] << 8) | buf[8]) / 1000 : null;
    const adcCh4V = buf.length >= 11 ? ((buf[9] << 8) | buf[10]) / 1000 : null;

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

function calibrationSignature(options = {}) {
  const strokeMm = toFiniteNumber(options.strokeMm);
  const ratioZero = toFiniteNumber(options.ratioZero);
  const ratioSpan = toFiniteNumber(options.ratioSpan);
  const invertDirection = Number(options.invertDirection || 0) === 1 ? 1 : 0;
  return [
    strokeMm === null ? 'null' : strokeMm,
    ratioZero === null ? 'null' : ratioZero,
    ratioSpan === null ? 'null' : ratioSpan,
    invertDirection,
  ].join('|');
}

function calculateRatioDendroPositionMm(options = {}) {
  const strokeMm = toFiniteNumber(options.strokeMm);
  const ratioZero = toFiniteNumber(options.ratioZero);
  const ratioSpan = toFiniteNumber(options.ratioSpan);
  const ratio = toFiniteNumber(options.ratio);
  const invertDirection = Number(options.invertDirection || 0) === 1;

  if (strokeMm === null || ratioZero === null || ratioSpan === null || ratio === null) return null;
  if (strokeMm <= 0 || ratioSpan === ratioZero) return null;

  const numerator = invertDirection
    ? strokeMm * (ratioSpan - ratio)
    : strokeMm * (ratio - ratioZero);
  const denominator = ratioSpan - ratioZero;
  const position = numerator / denominator;
  if (!Number.isFinite(position)) return null;

  return roundTo(clamp(position, 0, strokeMm), 3);
}

function buildDendroDerivedMetrics(options = {}) {
  const adcCh0V = toFiniteNumber(options.adcCh0V);
  const adcCh1V = toFiniteNumber(options.adcCh1V);
  const strokeMm = toFiniteNumber(options.strokeMm);
  const ratioZero = toFiniteNumber(options.ratioZero);
  const ratioSpan = toFiniteNumber(options.ratioSpan);
  const invertDirection = Number(options.invertDirection || 0) === 1 ? 1 : 0;
  const modeUsed = detectDendroModeUsed(options);
  const legacyValid = adcCh0V !== null ? (adcCh0V >= 0 && adcCh0V <= 2.6 ? 1 : 0) : null;
  const legacyPositionMm = legacyValid === 1 ? roundTo(adcCh0V * 10, 3) : null;
  const ratioInfo = calculateDendroRatio(adcCh0V, adcCh1V, options);

  let dendroValid = legacyValid;
  let positionMm = legacyPositionMm;
  let calibrationMissing = false;

  if (modeUsed === 'ratio_mod3') {
    dendroValid = ratioInfo.isValid ? 1 : 0;
    positionMm = calculateRatioDendroPositionMm({
      strokeMm,
      ratioZero,
      ratioSpan,
      ratio: ratioInfo.ratio,
      invertDirection,
    });
    if (ratioInfo.isValid && positionMm === null) {
      calibrationMissing = true;
    }
  }

  return {
    adcCh0V,
    adcCh1V,
    dendroModeUsed: modeUsed,
    dendroRatio: ratioInfo.ratio,
    dendroValid,
    positionMm,
    positionUm: positionMm === null ? null : Math.round(positionMm * 1000),
    ratioInvalidReason: ratioInfo.invalidReason,
    calibrationMissing,
    calibrationSignature: calibrationSignature({
      strokeMm,
      ratioZero,
      ratioSpan,
      invertDirection,
    }),
    strokeMm,
    ratioZero,
    ratioSpan,
    invertDirection,
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

module.exports = {
  SMALL_REFERENCE_THRESHOLD,
  toFiniteNumber,
  roundTo,
  lsn50ModeLabel,
  detectLsn50ModeCode,
  decodeMod3DendroPayload,
  decodeRawAdcPayload,
  detectDendroModeUsed,
  calculateDendroRatio,
  calculateRatioDendroPositionMm,
  buildDendroDerivedMetrics,
  calibrationSignature,
  computeDendroDeltaMm,
};
