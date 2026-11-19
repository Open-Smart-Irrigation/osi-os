// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import '../EChart';
import { buildWindRoseOption } from '../../farming/WindRoseChart';
import { computeWindRose } from '../../../utils/wind';

use([SVGRenderer]);
const theme = { axisLine: '#aaa', axisLabel: '#aaa', splitLine: '#ddd', legendText: '#aaa' };

describe('shared EChart registrations', () => {
  it.each([['one sector', [182, 182, 182]], ['multiple sectors', [0, 90, 180]]])('renders populated polar bars: %s', (_name, directions) => {
    const rose = computeWindRose((directions as number[]).map((direction) => ({ wind_speed_mps: 3.5, wind_direction_deg: direction })));
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 600, height: 340 });
    try {
      chart.setOption({ ...buildWindRoseOption(rose, theme), animation: false });
      expect(chart.getOption().series).toHaveLength(rose.speedBins.length);
      expect(chart.renderToSVGString()).toContain('#22c55e');
    } finally { chart.dispose(); }
  });
  it.each([342, 624])('centers cardinal sectors on compass bearings at %i px', (width) => {
    const rose = computeWindRose([0, 90, 180, 270].map((direction) => ({ wind_speed_mps: 3.5, wind_direction_deg: direction })));
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width, height: 340 });
    try {
      chart.setOption({ ...buildWindRoseOption(rose, theme), animation: false });
      chart.renderToSVGString();
      const center = chart.convertToPixel({ seriesIndex: 0 }, [0, 'N']);
      const points = ['N', 'E', 'S', 'W'].map((direction) => chart.convertToPixel({ seriesIndex: 0 }, [25, direction]));
      const [north, east, south, west] = points;
      expect(north[0]).toBeCloseTo(center[0], 6);
      expect(north[1]).toBeLessThan(center[1]);
      expect(east[0]).toBeGreaterThan(center[0]);
      expect(east[1]).toBeCloseTo(center[1], 6);
      expect(south[0]).toBeCloseTo(center[0], 6);
      expect(south[1]).toBeGreaterThan(center[1]);
      expect(west[0]).toBeLessThan(center[0]);
      expect(west[1]).toBeCloseTo(center[1], 6);
    } finally { chart.dispose(); }
  });
  it('continues to render cartesian line and scatter charts', () => {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 600, height: 340 });
    try {
      chart.setOption({ animation: false, xAxis: {}, yAxis: {}, series: [{ type: 'line', data: [[0, 1], [1, 2]] }, { type: 'scatter', data: [[0, 2], [1, 3]] }] });
      expect(chart.getOption().series).toHaveLength(2);
      expect(chart.renderToSVGString()).toContain('<path');
    } finally { chart.dispose(); }
  });
});
