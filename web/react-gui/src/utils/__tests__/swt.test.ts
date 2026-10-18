import { describe, expect, it } from 'vitest';

import { classifySwtWaterStatus, formatMeasuredSwtValue, formatSwtCardValue, formatSwtValue, kpaToPf, pfToKpa, summarizeSwtValues } from '../swt';

describe('classifySwtWaterStatus', () => {
  it.each([
    [0, 'wet'], [19.999, 'wet'], [20, 'moist'], [50, 'moist'], [50.001, 'dry'], [300, 'dry'], [500, 'dry'], [1_000_000, 'dry'],
  ] as const)('classifies %s kPa as %s', (value, status) => {
    expect(classifySwtWaterStatus(value)).toBe(status);
  });

  it.each([-1, 1_000_000.1, null, undefined, NaN, -Infinity, Infinity, '20'])('rejects %s', value => {
    expect(classifySwtWaterStatus(value)).toBeNull();
  });
});

describe('formatMeasuredSwtValue', () => {
  it('shows a measured zero as 0.0 kPa in pF mode and leaves other values to formatSwtValue', () => {
    expect(formatMeasuredSwtValue(0, 'pF')).toBe('0.0 kPa');
    expect(formatMeasuredSwtValue(0, 'kPa')).toBe('0.0 kPa');
    expect(formatMeasuredSwtValue(30, 'pF')).toBe('2.48 pF');
    expect(formatMeasuredSwtValue(null, 'pF')).toBeNull();
  });
});

describe('formatSwtCardValue', () => {
  it('uses the selected unit for positive tension', () => {
    expect(formatSwtCardValue(30, 'kPa')).toBe('30.0 kPa');
    expect(formatSwtCardValue(30, 'pF')).toBe('2.48 pF');
  });
  it('shows a measured zero as 0.0 kPa in both modes, since pF has no value at zero', () => {
    expect(formatSwtCardValue(0, 'pF')).toBe('0.0 kPa');
    expect(formatSwtCardValue(0, 'kPa')).toBe('0.0 kPa');
    expect(formatSwtCardValue(null, 'pF')).toBeNull();
    expect(formatSwtCardValue(-1, 'pF')).toBeNull();
  });
  it.each([
    [0.05, '-0.30 pF', '0.1 kPa'],
    [0.1, '0.00 pF', '0.1 kPa'],
    [0.11, '0.04 pF', '0.1 kPa'],
  ])('shows %s kPa as %s in pF mode and %s in kPa mode', (kpa, pf, kpaText) => {
    expect(formatSwtCardValue(kpa, 'pF')).toBe(pf);
    expect(formatSwtCardValue(kpa, 'kPa')).toBe(kpaText);
  });
  it.each([-1, 1_000_000.1, null, undefined, NaN, Infinity, '30'])('keeps %s unavailable in both units', value => {
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
    expect(summarizeSwtValues([1_000_000.1])).toEqual({ status: null, swt: null });
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

describe('kpaToPf general matric-potential conversion', () => {
  it.each([
    [0.11, Math.log10(1.1)],
    [0.1, 0],
    [0.05, Math.log10(0.05) + 1],
    [0, null],
    [-5, Math.log10(5) + 1],
  ])('derives %s kPa as pF %s', (kpa, pf) => {
    if (pf === null) expect(kpaToPf(kpa)).toBeNull();
    else expect(kpaToPf(kpa)).toBeCloseTo(pf, 12);
  });

  it('preserves signed measurement magnitude and allows negative pF', () => {
    expect(kpaToPf(-0.05)).toBeCloseTo(-0.3010299956639812, 12);
    expect(kpaToPf(0)).toBeNull();
  });

  it('crosses zero pF continuously at 0.1 kPa', () => {
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

  it('round-trips finite nonzero kPa and maps 0 pF to 0.1 kPa', () => {
    for (const kpa of [0.05, 0.11, 0.2, 1, 5]) {
      expect(pfToKpa(kpaToPf(kpa))).toBeCloseTo(kpa, 12);
    }
    expect(pfToKpa(0)).toBeCloseTo(0.1, 15);
  });

  it('accepts negative pF values', () => {
    expect(pfToKpa(-1)).toBeCloseTo(0.01, 15);
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

  it.each([
    [0.11, '0.04 pF'],
    [0.1, '0.00 pF'],
    [0.05, '-0.30 pF'],
    [0, null],
    [-1, '1.00 pF'],
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
