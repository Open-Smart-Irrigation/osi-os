import { describe, expect, it } from 'vitest';
import { SERIES_PALETTE, seriesColor } from '../seriesColors';

describe('seriesColors', () => {
  it('uses a distinct colourblind-safe palette with at least eight colours', () => {
    expect(SERIES_PALETTE).toHaveLength(8);
    expect(new Set(SERIES_PALETTE).size).toBe(SERIES_PALETTE.length);
    expect(SERIES_PALETTE).toEqual(expect.arrayContaining([expect.stringMatching(/^#[0-9A-F]{6}$/)]));
  });

  it('wraps palette lookups by series order', () => {
    expect(seriesColor(0)).toBe(SERIES_PALETTE[0]);
    expect(seriesColor(SERIES_PALETTE.length)).toBe(SERIES_PALETTE[0]);
    expect(seriesColor(-1)).toBe(SERIES_PALETTE[SERIES_PALETTE.length - 1]);
  });
});
