import { describe, it, expect } from 'vitest';
import { buildCorrelationOption } from '../echartsOptions';
import { SERIES_PALETTE } from '../seriesColors';

describe('buildCorrelationOption', () => {
  it('builds one scatter series per zone with named axes', () => {
    const option = buildCorrelationOption({
      zonePairs: [
        { zoneId: 1, label: 'Zone 1', points: [[1, 2], [3, 4]] },
        { zoneId: 2, label: 'Zone 2', points: [[5, 6]] },
      ],
      channelXLabel: 'Soil tension',
      channelYLabel: 'Dendro shrinkage',
    });
    expect(option.color).toEqual(SERIES_PALETTE);
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(2);
    expect(series[0].type).toBe('scatter');
    expect(series[0].name).toBe('Zone 1');
    expect(series[0].data).toEqual([[1, 2], [3, 4]]);
    expect((option.xAxis as Array<{ name: string }>)[0].name).toBe('Soil tension');
    expect((option.yAxis as Array<{ name: string }>)[0].name).toBe('Dendro shrinkage');
  });
});
