import { describe, expect, it, vi } from 'vitest';
import { buildWindRoseOption, type WindRoseTheme } from '../WindRoseChart';
import { computeWindRose } from '../../../utils/wind';

vi.mock('../../analysis/EChart', () => ({ EChart: () => null }));

const THEME: WindRoseTheme = {
  axisLine: '#111',
  axisLabel: '#222',
  splitLine: '#333',
  legendText: '#444',
};

describe('buildWindRoseOption', () => {
  const rose = computeWindRose([
    { wind_speed_mps: 3.5, wind_direction_deg: 90 },
    { wind_speed_mps: 6, wind_direction_deg: 200 },
  ]);
  const option = buildWindRoseOption(rose, THEME) as any;

  it('produces a polar coordinate system', () => {
    expect(option.polar).toEqual({});
  });

  it('uses the 16 compass directions as the angle axis, N first, clockwise from top', () => {
    expect(option.angleAxis.type).toBe('category');
    expect(option.angleAxis.data).toHaveLength(16);
    expect(option.angleAxis.data[0]).toBe('N');
    expect(option.angleAxis.startAngle).toBe(90);
    expect(option.angleAxis.clockwise).toBe(true);
  });

  it('emits one stacked polar bar series per speed bin', () => {
    expect(option.series).toHaveLength(rose.speedBins.length);
    for (const series of option.series) {
      expect(series.type).toBe('bar');
      expect(series.coordinateSystem).toBe('polar');
      expect(series.stack).toBe('total');
      expect(series.data).toHaveLength(16);
    }
  });

  it('colors each series from its speed bin and names it with the bin label', () => {
    expect(option.series[0].name).toBe(rose.speedBins[0].label);
    expect(option.series[0].itemStyle.color).toBe(rose.speedBins[0].color);
  });

  it('lists the speed-bin labels in the legend', () => {
    expect(option.legend.data).toEqual(rose.speedBins.map((b) => b.label));
  });
});
