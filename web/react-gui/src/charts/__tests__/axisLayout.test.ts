import { describe, expect, it } from 'vitest';
import {
  estimateTextWidth,
  fitAxisTitle,
  fitText,
  rechartsYAxisWidth,
  valueAxisLabelWidth,
  valueAxisTickLabels,
} from '../axisLayout';

describe('estimateTextWidth', () => {
  it('grows with text length and font size', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
    expect(estimateTextWidth('100', 12)).toBeGreaterThan(estimateTextWidth('10', 12));
    expect(estimateTextWidth('100', 16)).toBeGreaterThan(estimateTextWidth('100', 12));
  });

  it('treats narrow glyphs as narrower than wide ones', () => {
    expect(estimateTextWidth('iiii', 12)).toBeLessThan(estimateTextWidth('MMMM', 12));
  });

  it('does not underestimate a 12px digit string (about 0.56em per digit)', () => {
    expect(estimateTextWidth('1000', 12)).toBeGreaterThanOrEqual(26);
  });
});

describe('fitText', () => {
  it('returns the text unchanged when it fits', () => {
    expect(fitText('kPa', 100, 12)).toBe('kPa');
  });

  it('truncates with an ellipsis so the result fits the budget', () => {
    const full = 'Soil water tension at thirty centimetres';
    const fitted = fitText(full, 80, 12);
    expect(fitted.endsWith('…')).toBe(true);
    expect(fitted.length).toBeLessThan(full.length);
    expect(estimateTextWidth(fitted, 12)).toBeLessThanOrEqual(80);
  });

  it('returns an empty string when not even the ellipsis fits', () => {
    expect(fitText('abc', 2, 12)).toBe('');
  });
});

describe('fitAxisTitle', () => {
  it('keeps the full title when it fits', () => {
    expect(fitAxisTitle('Soil water tension (kPa)', { maxPx: 400, short: 'kPa' }))
      .toEqual({ text: 'Soil water tension (kPa)', full: 'Soil water tension (kPa)', shortened: false });
  });

  it('falls back to the unit before truncating the descriptive title', () => {
    expect(fitAxisTitle('Soil water tension (kPa)', { maxPx: 60, short: 'kPa' }))
      .toEqual({ text: 'kPa', full: 'Soil water tension (kPa)', shortened: true });
  });

  it('truncates with an ellipsis when there is no unit to fall back to', () => {
    const fitted = fitAxisTitle('Stem diameter change sensor one', { maxPx: 70 });
    expect(fitted.shortened).toBe(true);
    expect(fitted.text.endsWith('…')).toBe(true);
    expect(fitted.full).toBe('Stem diameter change sensor one');
  });
});

describe('valueAxisTickLabels', () => {
  it('returns nothing for an empty or all-missing series', () => {
    expect(valueAxisTickLabels([])).toEqual([]);
    expect(valueAxisTickLabels([null, Number.NaN])).toEqual([]);
  });

  it('extends to nice bounds outside the data range', () => {
    const labels = valueAxisTickLabels([3, 87]);
    expect(labels[0]).toBe('0');
    expect(labels[labels.length - 1]).toBe('100');
  });

  it('uses the decimals the step needs', () => {
    const labels = valueAxisTickLabels([1.21, 1.94]);
    expect(labels.some((label) => label.includes('.'))).toBe(true);
  });

  it('applies a caller formatter (e.g. thousands separators)', () => {
    const labels = valueAxisTickLabels([0, 12000], { format: (v) => v.toLocaleString('en-US') });
    expect(labels).toContain('12,000');
  });

  it('handles a constant series without an infinite loop', () => {
    expect(valueAxisTickLabels([5, 5, 5]).length).toBeGreaterThan(0);
    expect(valueAxisTickLabels([0, 0]).length).toBeGreaterThan(0);
  });
});

describe('valueAxisLabelWidth', () => {
  it('is wider for four-digit values than for one-digit values', () => {
    expect(valueAxisLabelWidth([1200, 4800])).toBeGreaterThan(valueAxisLabelWidth([1, 8]));
  });

  it('is wider for negative values', () => {
    expect(valueAxisLabelWidth([-850, -10])).toBeGreaterThan(valueAxisLabelWidth([10, 850]));
  });

  it('has a sane floor for missing data', () => {
    expect(valueAxisLabelWidth([])).toBeGreaterThan(0);
  });
});

describe('rechartsYAxisWidth', () => {
  it('stays compact for small numbers instead of the old fixed 52 px', () => {
    expect(rechartsYAxisWidth([0, 40])).toBeLessThan(52);
  });

  it('grows past the old fixed width for long tick labels', () => {
    expect(rechartsYAxisWidth([-125000, 980000])).toBeGreaterThan(52);
  });

  it('clamps to a minimum and a maximum', () => {
    expect(rechartsYAxisWidth([])).toBeGreaterThanOrEqual(28);
    expect(rechartsYAxisWidth([1e12, 9e12])).toBeLessThanOrEqual(96);
  });

  it('honours the tick formatter decimals', () => {
    const plain = rechartsYAxisWidth([10, 90]);
    const twoDecimals = rechartsYAxisWidth([10, 90], { format: (v) => v.toFixed(2) });
    expect(twoDecimals).toBeGreaterThan(plain);
  });
});
