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

/**
 * Independent reference: advance widths (1/1000 em) from the Adobe Helvetica
 * AFM, which Arial and Liberation Sans match. ECharts draws in `sans-serif`,
 * i.e. one of these on most systems. The estimate must never be narrower than
 * the real text (that is what overflows) and should not waste more than ~25 %.
 * Limit: other UI faces (Segoe UI, Roboto, SF) differ by a few per cent per
 * glyph; the rendered check at 320/390/1440 px stays the real gate.
 */
const HELVETICA_AFM: Record<string, number> = {
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  '.': 278, ',': 278, '-': 333, ' ': 278, '%': 889, '(': 333, ')': 333, '°': 400,
  S: 667, P: 667, C: 722,
  a: 556, e: 556, i: 222, k: 500, l: 222, n: 556, o: 556, r: 333, s: 500, t: 278, w: 722,
};

function helveticaWidth(text: string, fontPx: number): number {
  let units = 0;
  for (const char of text) {
    const width = HELVETICA_AFM[char];
    if (width === undefined) throw new Error(`no reference width for ${char}`);
    units += width;
  }
  return (units / 1000) * fontPx;
}

describe('estimateTextWidth against Helvetica/Arial metrics', () => {
  const samples = ['0', '100', '-1,250.5', '12,000', '0.25', '85.3 kPa', '20 °C', '45 %', 'Soil water tension (kPa)'];
  for (const text of samples) {
    it(`never underestimates and stays within 25 % for "${text}"`, () => {
      const reference = helveticaWidth(text, 12);
      const estimate = estimateTextWidth(text, 12);
      expect(estimate).toBeGreaterThanOrEqual(reference);
      expect(estimate).toBeLessThanOrEqual(reference * 1.25 + 1);
    });
  }

  it('matches a hand-computed width exactly: "-1,250.5" at 12 px', () => {
    // Helvetica: 333 + 556 + 278 + 3*556 + 278 + 556 = 3669 units → 44.0 px.
    expect(helveticaWidth('-1,250.5', 12)).toBeCloseTo(44.03, 1);
    expect(estimateTextWidth('-1,250.5', 12)).toBe(45);
  });
});
