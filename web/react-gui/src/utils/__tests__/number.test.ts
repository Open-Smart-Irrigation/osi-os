import { describe, expect, it } from 'vitest';
import { formatNumber, NO_VALUE } from '../number';

describe('formatNumber', () => {
  it('uses the decimal separator of the interface language', () => {
    expect(formatNumber(16.81, 'en')).toBe('16.8');
    expect(formatNumber(16.81, 'fr')).toBe('16,8');
    expect(formatNumber(16.81, 'de-CH')).toBe('16.8');
    expect(formatNumber(16.81, 'it')).toBe('16,8');
    expect(formatNumber(16.81, 'pt', 2)).toBe('16,81');
  });

  it('keeps a measured zero and marks a missing value', () => {
    expect(formatNumber(0, 'fr')).toBe('0,0');
    expect(formatNumber(null, 'fr')).toBe(NO_VALUE);
    expect(formatNumber(Number.NaN, 'fr')).toBe(NO_VALUE);
  });

  it('falls back to the runtime default for an invalid language tag', () => {
    expect(formatNumber(1.5, 'not a tag!')).toMatch(/^1[.,]5$/);
  });
});
