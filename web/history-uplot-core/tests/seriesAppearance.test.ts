import { describe, expect, test } from 'vitest';
import { getSeriesAppearance } from '../src/shared/seriesAppearance';

describe('series appearance', () => {
  test('provides twelve deterministic combinations and cycles by index', () => {
    const styles = Array.from({ length: 12 }, (_, index) => getSeriesAppearance(index));
    expect(new Set(styles.map((style) => `${style.color}|${style.dash.join(',')}|${style.marker}`)).size).toBe(12);
    expect(getSeriesAppearance(0)).toEqual(getSeriesAppearance(12));
  });
});
