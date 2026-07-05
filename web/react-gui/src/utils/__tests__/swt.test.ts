import { describe, expect, it } from 'vitest';

import { formatSwtValue, kpaToPf, pfToKpa } from '../swt';

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
