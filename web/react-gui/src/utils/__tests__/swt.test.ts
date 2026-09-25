import { describe, expect, it } from 'vitest';

import { classifySwtWaterStatus, formatSwtCardValue, formatSwtValue, kpaToPf, pfToKpa, summarizeSwtValues } from '../swt';

describe('classifySwtWaterStatus', () => {
  it.each([
    [0, 'wet'], [19.999, 'wet'], [20, 'moist'], [50, 'moist'], [50.001, 'dry'], [300, 'dry'],
  ] as const)('classifies %s kPa as %s', (value, status) => {
    expect(classifySwtWaterStatus(value)).toBe(status);
  });

  it.each([-1, 301, null, undefined, NaN, -Infinity, Infinity, '20'])('rejects %s', value => {
    expect(classifySwtWaterStatus(value)).toBeNull();
  });
});

describe('formatSwtCardValue', () => {
  it('uses the selected unit for positive tension', () => {
    expect(formatSwtCardValue(30, 'kPa')).toBe('30.0 kPa');
    expect(formatSwtCardValue(30, 'pF')).toBe('2.48 pF');
  });
  it('keeps a measured zero visible without inventing zero pF', () => {
    expect(formatSwtCardValue(0, 'pF')).toBe('0.0 kPa');
  });
  it.each([-1, 301, null, undefined, NaN, Infinity, '30'])('keeps %s unavailable in both units', value => {
    expect(formatSwtCardValue(value, 'pF')).toBeNull();
    expect(formatSwtCardValue(value, 'kPa')).toBeNull();
  });
});

describe('summarizeSwtValues', () => {
  it('returns status codes for callers to translate using the same VIA bands', () => {
    expect(summarizeSwtValues([0, 10])).toEqual({ status: 'wet', swt: 5 });
    expect(summarizeSwtValues([20, 50])).toEqual({ status: 'moist', swt: 35 });
    expect(summarizeSwtValues([51, 59])).toEqual({ status: 'dry', swt: 55 });
    expect(summarizeSwtValues([])).toEqual({ status: null, swt: null });
    expect(summarizeSwtValues([301])).toEqual({ status: null, swt: null });
  });
});

describe('kpaToPf golden vectors', () => {
  it('matches the contract-pinned vectors', () => {
    expect(kpaToPf(10)).toBeCloseTo(2.0, 12);
    expect(kpaToPf(30)).toBeCloseTo(2.4771212547196626, 12);
    expect(kpaToPf(60)).toBeCloseTo(2.7781512503836436, 12);
    expect(kpaToPf(300)).toBeCloseTo(3.4771212547196626, 12);
  });

  it('returns null for missing, zero, negative, and non-finite input', () => {
    expect(kpaToPf(null)).toBeNull();
    expect(kpaToPf(undefined)).toBeNull();
    expect(kpaToPf(0)).toBeNull();
    expect(kpaToPf(-5)).toBeNull();
    expect(kpaToPf(Number.NaN)).toBeNull();
    expect(kpaToPf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(kpaToPf('30' as unknown)).toBeNull();
  });
});

describe('pfToKpa', () => {
  it('inverts kpaToPf', () => {
    for (const kpa of [0.5, 10, 30, 60, 123.4, 300]) {
      expect(pfToKpa(kpaToPf(kpa))).toBeCloseTo(kpa, 9);
    }
  });

  it('returns null for missing and non-finite input', () => {
    expect(pfToKpa(null)).toBeNull();
    expect(pfToKpa(Number.NaN)).toBeNull();
  });

  it('returns null when conversion overflows finite kPa', () => {
    expect(pfToKpa(400)).toBeNull();
  });
});

describe('formatSwtValue', () => {
  it('formats kPa at 1 decimal', () => {
    expect(formatSwtValue(30, 'kPa')).toBe('30.0 kPa');
    expect(formatSwtValue(6.25, 'kPa')).toBe('6.3 kPa');
  });

  it('formats pF at 2 decimals', () => {
    expect(formatSwtValue(30, 'pF')).toBe('2.48 pF');
    expect(formatSwtValue(10, 'pF')).toBe('2.00 pF');
  });

  it('returns null for non-positive tension under pF so callers can render a localized placeholder', () => {
    expect(formatSwtValue(0, 'pF')).toBeNull();
    expect(formatSwtValue(-1, 'pF')).toBeNull();
  });

  it('keeps showing raw kPa for non-positive tension under kPa', () => {
    expect(formatSwtValue(0, 'kPa')).toBe('0.0 kPa');
  });

  it('returns null for missing values in both units', () => {
    expect(formatSwtValue(null, 'kPa')).toBeNull();
    expect(formatSwtValue(undefined, 'pF')).toBeNull();
  });

  it('lets callers keep their placeholder for missing readings', () => {
    expect(formatSwtValue(null, 'pF') ?? '—').toBe('—');
  });
});
