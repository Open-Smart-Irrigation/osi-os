import { describe, it, expect } from 'vitest';
import { applyLabelOverrides } from '../labelOverrides';
import type { AnalysisSeries } from '../types';

const base: AnalysisSeries = {
  seriesId: 's1',
  resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
  label: 'Original',
  unit: 'kPa',
  coveragePct: 100,
  points: [],
  truncated: false,
};

describe('applyLabelOverrides', () => {
  it('replaces label when an override exists', () => {
    const [out] = applyLabelOverrides([base], { s1: 'Custom' });
    expect(out.label).toBe('Custom');
  });

  it('keeps original label when no override', () => {
    const [out] = applyLabelOverrides([base], {});
    expect(out.label).toBe('Original');
  });

  it('does not mutate the input series', () => {
    applyLabelOverrides([base], { s1: 'Custom' });
    expect(base.label).toBe('Original');
  });
});
