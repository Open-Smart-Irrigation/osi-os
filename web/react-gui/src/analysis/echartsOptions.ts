import type { AnalysisSeries } from './types';
import type { ZonePairs } from './correlation';
import type { UnitPanel } from './unitGrouping';
import { SERIES_PALETTE, seriesColor } from './seriesColors';
import { canonicalize } from '../channels/registry';
import { prettyUnit } from './channelLabels';

export interface TimeSeriesOptionInput {
  panels: UnitPanel[];
  series: AnalysisSeries[];
  normalize: boolean;
  multiAxis: boolean;
  includeLegend?: boolean;
  resolveAxisLabel?: (channelKey: string, unit: string | null) => string;
}

const tooltipValueFormatter = (value: number | null | undefined) => (
  value == null ? '–' : Number(value).toFixed(1)
);

const NAME_STYLE = {
  nameLocation: 'middle' as const,
  nameRotate: 90,
  nameGap: 58,
  nameTextStyle: { fontSize: 12, fontWeight: 500 as const, color: '#475569' },
};
const Y_AXIS_GRID_LEFT = 80;

function axisNameSpec(
  axisSeries: AnalysisSeries[],
  normalize: boolean,
  axisIndex: number,
  resolveAxisLabel?: (channelKey: string, unit: string | null) => string,
): Record<string, unknown> {
  if (normalize) return { name: '%', ...NAME_STYLE };
  if (axisSeries.length === 0) return { name: '', ...NAME_STYLE };
  const units = Array.from(new Set(axisSeries.map((s) => s.unit ?? '').filter(Boolean)));
  if (units.length > 1) {
    return { name: units.map((u) => prettyUnit(u)).join(', '), ...NAME_STYLE };
  }
  const key = canonicalize(axisSeries[0]?.resolved.channelKey ?? '');
  const unit = axisSeries[0]?.unit ?? null;
  const name = resolveAxisLabel ? resolveAxisLabel(key, unit) : (unit ? `${key} (${prettyUnit(unit)})` : key);
  return { name, ...NAME_STYLE, id: `${key}#${axisIndex}`, triggerEvent: true };
}

const TIME_AXIS_LABEL = {
  formatter: {
    year: '{yyyy}',
    month: '{MMM}',
    day: '{dd}.{MM}.',
    hour: '{HH}:{mm}',
    minute: '{HH}:{mm}',
    second: '{HH}:{mm}:{ss}',
  },
};

const EXPORT_LEGEND = { bottom: 8, type: 'scroll' as const };

function seriesData(series: AnalysisSeries, normalize: boolean): [string, number | null][] {
  if (!normalize) return series.points.map((p) => [p.t, p.value]);
  const values = series.points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length === 0) return series.points.map((p) => [p.t, null]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return series.points.map((p) => [
    p.t,
    p.value === null ? null : span === 0 ? 50 : ((p.value - min) / span) * 100,
  ]);
}

function lineSeries(
  s: AnalysisSeries,
  normalize: boolean,
  axisIndex: number,
  stacked: boolean,
  color: string,
): Record<string, unknown> {
  return {
    name: s.label,
    type: 'line',
    color,
    showSymbol: false,
    connectNulls: false,
    xAxisIndex: stacked ? axisIndex : 0,
    yAxisIndex: axisIndex,
    data: seriesData(s, normalize),
  };
}

export function buildTimeSeriesOption(input: TimeSeriesOptionInput): Record<string, unknown> {
  const { panels, series, normalize, multiAxis, includeLegend } = input;
  const byId = new Map(series.map((s) => [s.seriesId, s]));
  const indexById = new Map(series.map((s, i) => [s.seriesId, i]));
  const singleGrid = panels.length <= 1 || multiAxis;

  if (singleGrid) {
    const yAxis = multiAxis && !normalize
      ? panels.map((panel, i) => {
        const axisSeries = series.filter((s) => panel.seriesIds.includes(s.seriesId));
        return { type: 'value', position: i === 0 ? 'left' : 'right', offset: i > 1 ? (i - 1) * 56 : 0, ...axisNameSpec(axisSeries, false, i, input.resolveAxisLabel) };
      })
      : [{ type: 'value', ...axisNameSpec(series, normalize, 0, input.resolveAxisLabel) }];
    const echSeries = series.map((s, i) => {
      const panelIndex = panels.findIndex((p) => p.seriesIds.includes(s.seriesId));
      const yIndex = multiAxis && !normalize ? Math.max(0, panelIndex) : 0;
      return lineSeries(s, normalize, yIndex, false, seriesColor(i));
    });
    return {
      color: SERIES_PALETTE,
      tooltip: { trigger: 'axis', valueFormatter: tooltipValueFormatter },
      ...(includeLegend ? { legend: EXPORT_LEGEND } : {}),
      grid: [{ left: Y_AXIS_GRID_LEFT, right: 56, top: 48, bottom: includeLegend ? 88 : 56 }],
      xAxis: [{ type: 'time', axisLabel: TIME_AXIS_LABEL }],
      yAxis,
      series: echSeries,
    };
  }

  const gridCount = panels.length;
  const availableHeight = includeLegend ? 92 : 100;
  const rowHeight = availableHeight / gridCount;
  const grid = panels.map((_, i) => ({
    left: Y_AXIS_GRID_LEFT,
    right: 24,
    top: `${i * rowHeight + 6}%`,
    height: `${rowHeight - 12}%`,
  }));
  const xAxis = panels.map((_, i) => ({ type: 'time', gridIndex: i, axisLabel: TIME_AXIS_LABEL }));
  const yAxis = panels.map((panel, i) => {
    const axisSeries = series.filter((s) => panel.seriesIds.includes(s.seriesId));
    return { type: 'value', gridIndex: i, ...axisNameSpec(axisSeries, normalize, i, input.resolveAxisLabel) };
  });
  const echSeries = panels.flatMap((panel, i) =>
    panel.seriesIds.map((id) => lineSeries(
      byId.get(id) as AnalysisSeries,
      normalize,
      i,
      true,
      seriesColor(indexById.get(id) ?? 0),
    )),
  );
  return {
    color: SERIES_PALETTE,
    tooltip: { trigger: 'axis', valueFormatter: tooltipValueFormatter },
    ...(includeLegend ? { legend: EXPORT_LEGEND } : {}),
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid,
    xAxis,
    yAxis,
    series: echSeries,
  };
}

export function buildSmallMultiplesOption(
  series: AnalysisSeries[],
  normalize: boolean,
  resolveAxisLabel?: (channelKey: string, unit: string | null) => string,
): Record<string, unknown> {
  const count = series.length;
  const cols = count === 0 ? 1 : Math.ceil(Math.sqrt(count));
  const rows = count === 0 ? 0 : Math.ceil(count / cols);
  const cellW = 100 / cols;
  const cellH = rows === 0 ? 0 : 100 / rows;

  const grid = series.map((_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      left: `${col * cellW + 4}%`,
      width: `${cellW - 8}%`,
      top: `${row * cellH + 8}%`,
      height: `${cellH - 16}%`,
    };
  });
  const xAxis = series.map((_, i) => ({ type: 'time', gridIndex: i, axisLabel: TIME_AXIS_LABEL }));
  const yAxis = series.map((s, i) => (
    normalize
      ? { type: 'value', gridIndex: i, name: '%', ...NAME_STYLE }
      : { type: 'value', gridIndex: i, ...axisNameSpec([s], false, i, resolveAxisLabel) }
  ));
  const echSeries = series.map((s, i) => ({
    name: s.label,
    type: 'line',
    color: seriesColor(i),
    showSymbol: false,
    connectNulls: false,
    xAxisIndex: i,
    yAxisIndex: i,
    data: seriesData(s, normalize),
  }));
  return {
    color: SERIES_PALETTE,
    tooltip: { trigger: 'axis', valueFormatter: tooltipValueFormatter },
    grid,
    xAxis,
    yAxis,
    series: echSeries,
  };
}

export interface CorrelationOptionInput {
  zonePairs: ZonePairs[];
  channelXLabel: string;
  channelYLabel: string;
}

export function buildCorrelationOption(input: CorrelationOptionInput): Record<string, unknown> {
  return {
    color: SERIES_PALETTE,
    tooltip: { trigger: 'item', valueFormatter: tooltipValueFormatter },
    legend: { type: 'scroll' },
    grid: [{ left: 64, right: 24, top: 32, bottom: 56 }],
    xAxis: [{
      type: 'value',
      name: input.channelXLabel,
      nameLocation: 'middle',
      nameGap: 28,
    }],
    yAxis: [{ type: 'value', name: input.channelYLabel, nameLocation: 'middle', nameRotate: 90, nameGap: 48 }],
    series: input.zonePairs.map((zone) => ({
      name: zone.label,
      type: 'scatter',
      symbolSize: 7,
      data: zone.points,
    })),
  };
}
