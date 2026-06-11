import { describe, expect, it } from 'vitest';

import { buildNumericRows } from '../visualizations/EnvironmentLineChartView';

describe('EnvironmentLineChartView', () => {
  it('rows carry epoch-ms timestamps for numeric axis clipping', () => {
    const rows = buildNumericRows([
      {
        key: 'temperature',
        label: 'Temperature',
        unit: 'C',
        points: [{ t: '2026-06-01T00:00:00Z', value: 22 }],
      },
    ]);

    expect(rows[0].tMs).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });
});
