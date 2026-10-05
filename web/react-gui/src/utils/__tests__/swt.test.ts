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
  // Was '0.0 kPa' (a kPa fallback in pF mode); the pF floor rule shows 0 pF instead.
  it('shows a measured zero as the 0 pF floor in pF mode and as 0.0 kPa in kPa mode', () => {
    expect(formatSwtCardValue(0, 'pF')).toBe('0.00 pF');
    expect(formatSwtCardValue(0, 'kPa')).toBe('0.0 kPa');
  });
  it.each([
    [0.05, '0.00 pF', '0.1 kPa'],
    [0.1, '0.00 pF', '0.1 kPa'],
    [0.11, '0.04 pF', '0.1 kPa'],
  ])('shows %s kPa as %s in pF mode and %s in kPa mode', (kpa, pf, kpaText) => {
    expect(formatSwtCardValue(kpa, 'pF')).toBe(pf);
    expect(formatSwtCardValue(kpa, 'kPa')).toBe(kpaText);
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

  it('returns null for missing and non-finite input', () => {
    expect(kpaToPf(null)).toBeNull();
    expect(kpaToPf(undefined)).toBeNull();
    expect(kpaToPf(Number.NaN)).toBeNull();
    expect(kpaToPf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(kpaToPf(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(kpaToPf('30' as unknown)).toBeNull();
  });
});

// pF is never shown below 0: finite tension at or below 0.1 kPa, where
// log10(kPa * 10) is 0, negative or undefined, derives the 0 pF floor.
// Zero and negative kPa returned null before this rule; 0.05 kPa returned -0.30.
describe('kpaToPf floor at 0.1 kPa', () => {
  it.each([
    [0.11, Math.log10(1.1)],
    [0.1, 0],
    [0.05, 0],
    [0, 0],
    [-5, 0],
  ])('derives %s kPa as pF %s', (kpa, pf) => {
    expect(kpaToPf(kpa)).toBeCloseTo(pf, 12);
  });

  it('never returns a negative pF', () => {
    for (const kpa of [0.1, 0.0999, 0.05, 0.001, 0, -0.01, -300]) {
      expect(kpaToPf(kpa)).toBe(0);
    }
  });

  it('starts just above the floor without a jump', () => {
    expect(kpaToPf(0.1000001)).toBeGreaterThan(0);
    expect(kpaToPf(0.1000001)).toBeLessThan(1e-6);
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

  it('stays exact above the floor and maps 0 pF to the 0.1 kPa floor', () => {
    for (const kpa of [0.11, 0.2, 1, 5]) {
      expect(pfToKpa(kpaToPf(kpa))).toBeCloseTo(kpa, 12);
    }
    expect(pfToKpa(0)).toBeCloseTo(0.1, 15);
  });

  it('rejects a negative pF, which is never shown', () => {
    expect(pfToKpa(-0.3)).toBeNull();
    expect(pfToKpa(-1)).toBeNull();
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

  // Was null for non-positive tension; the pF floor rule shows 0 pF at 2 decimals.
  it.each([
    [0.11, '0.04 pF'],
    [0.1, '0.00 pF'],
    [0.05, '0.00 pF'],
    [0, '0.00 pF'],
    [-1, '0.00 pF'],
  ])('formats %s kPa as %s', (kpa, shown) => {
    expect(formatSwtValue(kpa, 'pF')).toBe(shown);
  });

  it('keeps showing raw kPa for low and non-positive tension under kPa', () => {
    expect(formatSwtValue(0, 'kPa')).toBe('0.0 kPa');
    expect(formatSwtValue(0.05, 'kPa')).toBe('0.1 kPa');
    expect(formatSwtValue(-1, 'kPa')).toBe('-1.0 kPa');
  });

  it('returns null for missing values in both units', () => {
    expect(formatSwtValue(null, 'kPa')).toBeNull();
    expect(formatSwtValue(undefined, 'pF')).toBeNull();
  });

  it('lets callers keep their placeholder for missing readings', () => {
    expect(formatSwtValue(null, 'pF') ?? '—').toBe('—');
  });
});
