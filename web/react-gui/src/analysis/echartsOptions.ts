import type { AnalysisPoint, AnalysisSeries } from './types';
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
  formatPartial?: PartialFormatter;
}

/** Text appended to a tooltip value, e.g. " (23 of 24 h)" for a partial sum; '' for none. */
export type PartialFormatter = (point: AnalysisPoint, series: AnalysisSeries) => string;

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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The markup of ECharts 5.6's default axis tooltip (component/tooltip/tooltipMarkup.js
// with the default text style): a grey header, then per series the marker, the name
// on the left and the value in bold on the right. The formatter below replaces the
// ECharts default for every series of a chart that passes formatPartial — device
// series do not keep their stock look either, they get the same rebuilt rows. On
// the stacked layout, `drawn` lists series panel-then-series (see buildTimeSeriesOption
// below), so a merged tooltip across the linked grids shows one time header and the
// rows top panel first.
const TOOLTIP_NAME_STYLE = 'font-size:12px;color:#6e7079;font-weight:400';
const TOOLTIP_VALUE_STYLE = 'font-size:14px;color:#464646;font-weight:900';

function tooltipBlock(content: string, topGap: number): string {
  return `<div style="margin: ${topGap}px 0 0;line-height:1;">${content}<div style="clear:both"></div></div>`;
}

function tooltipRow(marker: string, name: string, value: string, topGap: number): string {
  return tooltipBlock(
    `${marker}<span style="${TOOLTIP_NAME_STYLE};margin-left:2px">${escapeHtml(name)}</span>`
      + `<span style="float:right;margin-left:20px;${TOOLTIP_VALUE_STYLE}">${escapeHtml(value)}</span>`,
    topGap,
  );
}

interface AxisTooltipParam {
  seriesIndex?: number;
  dataIndex?: number;
  marker?: string;
  seriesName?: string;
  value?: unknown;
  axisValueLabel?: string;
}

// `drawn` lists the series in ECharts series order, so a hovered
// (seriesIndex, dataIndex) finds its AnalysisPoint and the partial marker.
function axisTooltip(drawn: AnalysisSeries[], formatPartial?: PartialFormatter): Record<string, unknown> {
  // Callers without formatPartial (the builder tests) keep ECharts' own tooltip.
  if (!formatPartial) return { trigger: 'axis', valueFormatter: tooltipValueFormatter };
  return {
    trigger: 'axis',
    valueFormatter: tooltipValueFormatter,
    formatter: (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as AxisTooltipParam[];
      const rows = list.map((param, index) => {
        const item = drawn[param.seriesIndex ?? -1];
        const point = item?.points[param.dataIndex ?? -1];
        const raw = Array.isArray(param.value) ? param.value[1] : param.value;
        const text = tooltipValueFormatter(typeof raw === 'number' ? raw : null);
        const suffix = item && point ? formatPartial(point, item) : '';
        return tooltipRow(param.marker ?? '', param.seriesName ?? '', `${text}${suffix}`, index > 0 ? 10 : 0);
      }).join('');
      const header = list[0]?.axisValueLabel;
      return header
        ? tooltipBlock(`<div style="${TOOLTIP_NAME_STYLE};line-height:1;">${escapeHtml(header)}</div>${tooltipBlock(rows, 10)}`, 0)
        : tooltipBlock(rows, 0);
    },
  };
}

// A daily point between two null days has no line to either side; its symbol
// keeps it visible. Hourly and device series keep today's plain line.
function symbolSpec(s: AnalysisSeries): Record<string, unknown> {
  return s.cadence === 'daily' ? { showSymbol: true, symbolSize: 4 } : { showSymbol: false };
}

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

interface DisplayLabelItem {
  identity: string;
  label: string;
}

/** ECharts uses series.name as the legend key, so duplicate labels need stable display names. */
function uniqueDisplayLabels(items: DisplayLabelItem[]): Map<string, string> {
  const byLabel = new Map<string, DisplayLabelItem[]>();
  for (const item of items) {
    const group = byLabel.get(item.label) ?? [];
    group.push(item);
    byLabel.set(item.label, group);
  }

  const used = new Set(
    Array.from(byLabel.entries())
      .filter(([, group]) => group.length === 1)
      .map(([label]) => label),
  );
  const displayLabels = new Map<string, string>();
  for (const [label, group] of byLabel) {
    if (group.length === 1) {
      displayLabels.set(group[0].identity, label);
      continue;
    }
    let suffix = 1;
    for (const item of [...group].sort((a, b) => a.identity.localeCompare(b.identity))) {
      let candidate = `${label} (${suffix})`;
      while (used.has(candidate)) {
        suffix += 1;
        candidate = `${label} (${suffix})`;
      }
      displayLabels.set(item.identity, candidate);
      used.add(candidate);
      suffix += 1;
    }
  }
  return displayLabels;
}

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
  displayName: string,
): Record<string, unknown> {
  return {
    name: displayName,
    type: 'line',
    color,
    ...symbolSpec(s),
    connectNulls: false,
    xAxisIndex: stacked ? axisIndex : 0,
    yAxisIndex: axisIndex,
    data: seriesData(s, normalize),
  };
}

export function buildTimeSeriesOption(input: TimeSeriesOptionInput): Record<string, unknown> {
  const { panels, series, normalize, multiAxis, includeLegend } = input;
  const displayLabels = uniqueDisplayLabels(series.map((item) => ({ identity: item.seriesId, label: item.label })));
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
      return lineSeries(s, normalize, yIndex, false, seriesColor(i), displayLabels.get(s.seriesId) ?? s.label);
    });
    return {
      color: SERIES_PALETTE,
      tooltip: axisTooltip(series, input.formatPartial),
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
      displayLabels.get(id) ?? byId.get(id)?.label ?? id,
    )),
  );
  const drawn = panels.flatMap((panel) => panel.seriesIds.map((id) => byId.get(id) as AnalysisSeries));
  return {
    color: SERIES_PALETTE,
    tooltip: axisTooltip(drawn, input.formatPartial),
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
  formatPartial?: PartialFormatter,
): Record<string, unknown> {
  const displayLabels = uniqueDisplayLabels(series.map((item) => ({ identity: item.seriesId, label: item.label })));
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
    name: displayLabels.get(s.seriesId) ?? s.label,
    type: 'line',
    color: seriesColor(i),
    ...symbolSpec(s),
    connectNulls: false,
    xAxisIndex: i,
    yAxisIndex: i,
    data: seriesData(s, normalize),
  }));
  return {
    color: SERIES_PALETTE,
    tooltip: axisTooltip(series, formatPartial),
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
  const displayLabels = uniqueDisplayLabels(input.zonePairs.map((zone) => ({ identity: zone.groupId, label: zone.label })));
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
      id: zone.groupId,
      name: displayLabels.get(zone.groupId) ?? zone.label,
      type: 'scatter',
      symbolSize: 7,
      data: zone.points,
    })),
  };
}
