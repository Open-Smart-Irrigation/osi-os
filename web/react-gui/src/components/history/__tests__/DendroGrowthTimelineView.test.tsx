import { describe, expect, it } from 'vitest';

import { buildNumericRows } from '../visualizations/DendroGrowthTimelineView';

describe('DendroGrowthTimelineView', () => {
  it('rows carry epoch-ms timestamps for numeric axis clipping', () => {
    const rows = buildNumericRows([
      {
        key: 'growth',
        label: 'Growth',
        unit: 'um',
        points: [{ t: '2026-06-01T00:00:00Z', value: 3 }],
      },
    ]);

    expect(rows[0].tMs).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });
});
