import { describe, it, expect, vi } from 'vitest';
import * as echarts from 'echarts/core';
import { ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { buildCorrelationOption } from '../echartsOptions';
import { SERIES_PALETTE } from '../seriesColors';

echarts.use([ScatterChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

describe('buildCorrelationOption', () => {
  it('builds one scatter series per zone with named axes', () => {
    const option = buildCorrelationOption({
      zonePairs: [
        { groupId: 'zone:1', zoneId: 1, label: 'Zone 1', points: [[1, 2], [3, 4]] },
        { groupId: 'zone:2', zoneId: 2, label: 'Zone 2', points: [[5, 6]] },
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

  it('keeps duplicate labels independent in the real ECharts legend', () => {
    const option = buildCorrelationOption({
      zonePairs: [
        { groupId: 'device:b', zoneId: null, label: 'Rain', points: [[1, 2]] },
        { groupId: 'device:a', zoneId: null, label: 'Rain', points: [[3, 4]] },
        { groupId: 'device:c', zoneId: null, label: 'Rain (1)', points: [[5, 6]] },
      ],
      channelXLabel: 'X',
      channelYLabel: 'Y',
    });
    const series = option.series as Array<{ id: string; name: string }>;
    expect(Object.fromEntries(series.map((item) => [item.id, item.name]))).toEqual({
      'device:a': 'Rain (2)',
      'device:b': 'Rain (3)',
      'device:c': 'Rain (1)',
    });

    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 500 });
    Object.defineProperty(host, 'clientHeight', { value: 300 });
    document.body.appendChild(host);
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ measureText: () => ({ width: 0 }) }) as unknown as CanvasRenderingContext2D,
    );
    const chart = echarts.init(host, null, { renderer: 'svg' });
    try {
      chart.setOption(option);
      chart.dispatchAction({ type: 'legendUnSelect', name: 'Rain (2)' });
      const selected = (chart.getOption().legend as Array<{ selected: Record<string, boolean> }>)[0].selected;
      expect(selected['Rain (2)']).toBe(false);
      expect(selected['Rain (3)']).toBe(true);
      expect(selected['Rain (1)']).toBe(true);
    } finally {
      chart.dispose();
      getContext.mockRestore();
      host.remove();
    }
  });
});
