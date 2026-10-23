import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartAdapter, MountAdapter, SensorSeries, Viewport } from '../shared/types';
import { CHART_HEIGHT, PLOT_INSETS, SERIES_COLORS } from '../shared/types';

use([LineChart, GridComponent, CanvasRenderer]);

const SHORT_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const LONG_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short',
});

export function formatEchartsTimeTick(value: number, spanMs: number): string {
  return (spanMs <= 48 * 60 * 60 * 1000 ? SHORT_TIME_FORMATTER : LONG_DATE_FORMATTER).format(new Date(value));
}

export function buildXAxis(viewport: Viewport): Record<string, unknown> {
  const spanMs = viewport.to - viewport.from;
  return {
    type: 'value',
    min: viewport.from,
    max: viewport.to,
    axisLabel: {
      formatter: (value: number) => formatEchartsTimeTick(value, spanMs),
      hideOverlap: true,
      alignMinLabel: 'left',
      alignMaxLabel: 'right',
    },
    splitNumber: 3,
  };
}

function buildOption(series: readonly SensorSeries[], viewport: Viewport): EChartsCoreOption {
  return {
    animation: false,
    grid: {
      top: PLOT_INSETS.top,
      right: PLOT_INSETS.right,
      bottom: PLOT_INSETS.bottom,
      left: PLOT_INSETS.left,
      containLabel: false,
    },
    xAxis: buildXAxis(viewport),
    yAxis: { type: 'value', min: 0, max: 100, splitNumber: 4 },
    series: series.map((item, index) => {
      const color = SERIES_COLORS[index % SERIES_COLORS.length];
      return {
        id: item.id,
        name: item.label,
        type: 'line',
        data: item.points.map((point) => [point.t, point.value]),
        showSymbol: item.points.length <= 500,
        symbolSize: 4,
        connectNulls: false,
        smooth: false,
        animation: false,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        silent: true,
      };
    }),
  };
}

function finiteViewport(chart: EChartsType, host: HTMLElement): Viewport {
  const left = chart.convertFromPixel({ xAxisIndex: 0 }, PLOT_INSETS.left);
  const right = chart.convertFromPixel({ xAxisIndex: 0 }, host.clientWidth - PLOT_INSETS.right);
  if (typeof left !== 'number' || typeof right !== 'number' || !Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error('ECharts x-axis pixel conversion did not return finite numbers');
  }
  return { from: left, to: right };
}

export const mountEcharts: MountAdapter = (host, initial, _onViewportChange): ChartAdapter => {
  const chart: EChartsType = init(host, undefined, { renderer: 'canvas' });
  let destroyed = false;

  chart.setOption(buildOption([], initial), { notMerge: true, lazyUpdate: false, silent: true });

  const setViewport = (viewport: Viewport): void => {
    if (destroyed) return;
    chart.setOption({ xAxis: buildXAxis(viewport) }, { lazyUpdate: false, silent: true });
  };

  return {
    setData(series) {
      if (destroyed) return;
      const viewport = finiteViewport(chart, host);
      chart.setOption(buildOption(series, viewport), { notMerge: true, lazyUpdate: false, silent: true });
    },
    setViewport,
    getViewport() {
      return finiteViewport(chart, host);
    },
    getPlotRect() {
      const bounds = host.getBoundingClientRect();
      const width = chart.getWidth() || host.clientWidth || bounds.width;
      const height = chart.getHeight() || host.clientHeight || bounds.height || CHART_HEIGHT;
      const xScale = width > 0 ? bounds.width / width : 1;
      const yScale = height > 0 ? bounds.height / height : 1;
      return new DOMRectReadOnly(
        bounds.left + PLOT_INSETS.left * xScale,
        bounds.top + PLOT_INSETS.top * yScale,
        Math.max(0, bounds.width - (PLOT_INSETS.left + PLOT_INSETS.right) * xScale),
        Math.max(0, bounds.height - (PLOT_INSETS.top + PLOT_INSETS.bottom) * yScale),
      );
    },
    resize() {
      if (!destroyed) chart.resize();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      chart.dispose();
      host.replaceChildren();
    },
  };
};

export default mountEcharts;
