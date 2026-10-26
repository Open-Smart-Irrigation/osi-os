import { DAILY_AGRONOMY_SOURCE_KEY, type AnalysisPoint, type AnalysisSeries } from './types';
import type { ZonePairs } from './correlation';
import type { UnitPanel } from './unitGrouping';
import { SERIES_PALETTE, seriesColor } from './seriesColors';
import { canonicalize } from '../channels/registry';
import { prettyUnit } from './channelLabels';
import { smallMultiplesColumns, type ChartViewport } from './chartGeometry';
import { fitAxisTitle } from '../charts/axisLayout';
import {
  LABEL_MARGIN,
  NAME_BAND,
  NAME_SPACING,
  OUTER_PAD,
  RIGHT_PAD_NO_AXIS,
  axisBand,
  axisValues,
  overlaidMargins,
  tickLabelWidth,
} from './axisBands';

export interface TimeSeriesOptionInput {
  panels: UnitPanel[];
  series: AnalysisSeries[];
  normalize: boolean;
  multiAxis: boolean;
  includeLegend?: boolean;
  resolveAxisLabel?: (channelKey: string, unit: string | null) => string;
  formatPartial?: PartialFormatter;
  /** Measured chart size. Margins and title fitting use it; a default stands in before the first measurement. */
  viewport?: ChartViewport;
}

/** Text appended to a tooltip value, e.g. " (23 of 24 h)" for a partial sum; '' for none. */
export type PartialFormatter = (point: AnalysisPoint, series: AnalysisSeries) => string;

export type PointNoteTranslate = (key: string, options: Record<string, unknown>) => string;

// Rain amounts are sparse event reports: the gateway sends `expected: null` for them
// and the tooltip states the received count, never a coverage percentage.
const RAIN_AMOUNT_KEYS = new Set(['rain_mm_delta', 'rain_tips_delta']);

/**
 * The tooltip note of one point: " · 2 reports received" for a rain amount, " (23 of 24 h)"
 * for a partial weather sum (days for a weekly agronomy bucket), '' otherwise.
 */
export function formatPointNote(point: AnalysisPoint, item: AnalysisSeries, t: PointNoteTranslate): string {
  if (RAIN_AMOUNT_KEYS.has(canonicalize(item.resolved.channelKey)) && point.expected === null) {
    return t('analysis.tooltip.reportsReceived', { count: point.count });
  }
  if (point.quality !== 'partial' || point.expected == null) return '';
  const key = item.resolved.sourceKey === DAILY_AGRONOMY_SOURCE_KEY ? 'analysis.tooltip.partialDays' : 'analysis.tooltip.partialHours';
  return t(key, { count: point.count, expected: point.expected });
}

const tooltipValueFormatter = (value: number | null | undefined, unit?: string | null) => (
  value == null || !Number.isFinite(Number(value)) ? '–' : Number(value).toFixed(unit === 'pF' ? 2 : 1)
);

const NAME_FONT_PX = 12;
const DEFAULT_WIDTH = 720;
const SINGLE_DEFAULT_HEIGHT = 360;
const STACKED_DEFAULT_PANEL_HEIGHT = 240;
const SMALL_MULTIPLE_DEFAULT_CELL_HEIGHT = 220;

const NAME_TEXT_STYLE = { fontSize: NAME_FONT_PX, fontWeight: 500 as const, color: '#475569' };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (!formatPartial) return {
    trigger: 'axis',
    valueFormatter: (value: number | null | undefined) => tooltipValueFormatter(value, drawn.length === 1 ? drawn[0]?.unit : null),
  };
  return {
    trigger: 'axis',
    valueFormatter: tooltipValueFormatter,
    formatter: (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as AxisTooltipParam[];
      const rows = list.map((param, index) => {
        const item = drawn[param.seriesIndex ?? -1];
        const point = item?.points[param.dataIndex ?? -1];
        const raw = Array.isArray(param.value) ? param.value[1] : param.value;
        const text = tooltipValueFormatter(typeof raw === 'number' ? raw : null, item?.unit);
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

interface AxisTitle {
  full: string;
  /** Unit-only fallback for a cramped axis. */
  short: string | null;
  /** Channel key of an editable (renameable) title. */
  editableKey?: string;
}

function axisTitle(
  axisSeries: AnalysisSeries[],
  normalize: boolean,
  resolveAxisLabel?: (channelKey: string, unit: string | null) => string,
): AxisTitle {
  if (normalize) return { full: '%', short: null };
  if (axisSeries.length === 0) return { full: '', short: null };
  const units = Array.from(new Set(axisSeries.map((s) => s.unit ?? '').filter(Boolean)));
  if (units.length > 1) {
    return { full: units.map((u) => prettyUnit(u)).join(', '), short: null };
  }
  const key = canonicalize(axisSeries[0]?.resolved.channelKey ?? '');
  const unit = axisSeries[0]?.unit ?? null;
  const full = resolveAxisLabel ? resolveAxisLabel(key, unit) : (unit ? `${key} (${prettyUnit(unit)})` : key);
  return { full, short: unit ? prettyUnit(unit) : null, editableKey: key };
}

/**
 * Name options for one value axis. `parallel` draws the title rotated along the
 * axis, `top` draws it horizontally above the plot (small-multiple cells).
 * A title longer than `maxPx` falls back to its unit, then to an ellipsis; the
 * full title then shows as a tooltip on hover.
 */
function axisNameOptions(
  title: AxisTitle,
  placement: 'parallel' | 'top',
  maxPx: number,
  labelWidth: number,
  axisIndex: number,
): Record<string, unknown> {
  const fitted = fitAxisTitle(title.full, { maxPx: Math.max(0, maxPx), short: title.short, fontPx: NAME_FONT_PX });
  const base: Record<string, unknown> = placement === 'parallel'
    ? {
      name: fitted.text,
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: labelWidth + LABEL_MARGIN + NAME_SPACING,
      nameTextStyle: NAME_TEXT_STYLE,
    }
    : {
      name: fitted.text,
      nameLocation: 'end',
      nameRotate: 0,
      nameGap: 8,
      nameTextStyle: { ...NAME_TEXT_STYLE, align: 'left' },
    };
  if (title.editableKey) {
    base.id = `${title.editableKey}#${axisIndex}`;
    base.triggerEvent = true;
  }
  if (fitted.shortened) {
    const full = escapeHtml(fitted.full);
    // ECharts 5.6 hands this axis tooltip to the name and to every tick label; only a tick
    // label's params carry `tickIndex`, and it keeps its own text.
    base.tooltip = {
      show: true,
      formatter: (params?: { name?: unknown; tickIndex?: unknown }) => (
        params && params.tickIndex != null ? escapeHtml(String(params.name ?? '')) : full
      ),
    };
  }
  return base;
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
    tooltip: { valueFormatter: (value: number | null | undefined) => tooltipValueFormatter(value, s.unit) },
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
    const height = input.viewport?.height ?? SINGLE_DEFAULT_HEIGHT;
    const top = 24;
    const bottom = includeLegend ? 88 : 56;
    const titleMax = height - top - bottom - 8;
    const axisGroups = multiAxis && !normalize
      ? panels.map((panel) => series.filter((s) => panel.seriesIds.includes(s.seriesId)))
      : [series];
    let rightOffset = 0;
    const bands: number[] = [];
    const yAxis = axisGroups.map((axisSeries, i) => {
      const title = axisTitle(axisSeries, normalize, input.resolveAxisLabel);
      const labelWidth = tickLabelWidth(axisValues(axisSeries, normalize));
      const band = axisBand(labelWidth, title.full !== '');
      bands.push(band);
      const placement = i === 0
        ? { position: 'left' }
        : { position: 'right', offset: rightOffset };
      if (i > 0) rightOffset += band;
      return { type: 'value', ...placement, ...axisNameOptions(title, 'parallel', titleMax, labelWidth, i) };
    });
    const echSeries = series.map((s, i) => {
      const panelIndex = panels.findIndex((p) => p.seriesIds.includes(s.seriesId));
      const yIndex = multiAxis && !normalize ? Math.max(0, panelIndex) : 0;
      return lineSeries(s, normalize, yIndex, false, seriesColor(i), displayLabels.get(s.seriesId) ?? s.label);
    });
    return {
      color: SERIES_PALETTE,
      tooltip: axisTooltip(series, input.formatPartial),
      ...(includeLegend ? { legend: EXPORT_LEGEND } : {}),
      grid: [{ ...overlaidMargins(bands), top, bottom }],
      xAxis: [{ type: 'time', axisLabel: TIME_AXIS_LABEL }],
      yAxis,
      series: echSeries,
    };
  }

  // Stacked: one grid per unit. Pixel geometry with a fixed gap for each
  // panel's own time labels; percentage gaps grew with the panel count and
  // left 100 px plots under five units.
  const gridCount = panels.length;
  const height = input.viewport?.height ?? gridCount * STACKED_DEFAULT_PANEL_HEIGHT;
  const top = 16;
  const gap = 40;
  const bottom = includeLegend ? 72 : 32;
  const panelHeight = Math.max(40, Math.floor((height - top - bottom - gap * (gridCount - 1)) / gridCount));
  const axes = panels.map((panel) => {
    const axisSeries = series.filter((s) => panel.seriesIds.includes(s.seriesId));
    const title = axisTitle(axisSeries, normalize, input.resolveAxisLabel);
    const labelWidth = tickLabelWidth(axisValues(axisSeries, normalize));
    return { title, labelWidth };
  });
  // One shared left edge keeps the time axes of all panels aligned, and one
  // shared title distance keeps the rotated titles in a column.
  const sharedLabelWidth = Math.max(...axes.map((a) => a.labelWidth));
  const left = axisBand(sharedLabelWidth, axes.some((a) => a.title.full !== '')) + OUTER_PAD;
  const grid = panels.map((_, i) => ({
    left,
    right: RIGHT_PAD_NO_AXIS,
    top: top + i * (panelHeight + gap),
    height: panelHeight,
  }));
  const xAxis = panels.map((_, i) => ({ type: 'time', gridIndex: i, axisLabel: TIME_AXIS_LABEL }));
  const yAxis = axes.map(({ title }, i) => ({
    type: 'value',
    gridIndex: i,
    ...axisNameOptions(title, 'parallel', panelHeight - 8, sharedLabelWidth, i),
  }));
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
  viewport?: ChartViewport,
): Record<string, unknown> {
  const displayLabels = uniqueDisplayLabels(series.map((item) => ({ identity: item.seriesId, label: item.label })));
  const count = series.length;
  const cols = smallMultiplesColumns(count, viewport?.width);
  const rows = count === 0 ? 0 : Math.ceil(count / cols);
  const width = viewport?.width ?? DEFAULT_WIDTH;
  const height = viewport?.height ?? rows * SMALL_MULTIPLE_DEFAULT_CELL_HEIGHT;
  const cellW = width / cols;
  const cellH = rows === 0 ? 0 : height / rows;
  const titleBand = 28;
  const timeLabelBand = 32;
  const cellRightPad = 16;

  const cells = series.map((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const labelWidth = tickLabelWidth(axisValues([s], normalize));
    const plotLeft = Math.round(col * cellW + labelWidth + LABEL_MARGIN + OUTER_PAD);
    const grid = {
      left: plotLeft,
      width: Math.max(40, Math.floor(cellW - (plotLeft - col * cellW) - cellRightPad)),
      top: Math.round(row * cellH + titleBand),
      height: Math.max(40, Math.floor(cellH - titleBand - timeLabelBand)),
    };
    // The title starts at the plot's left edge and may run to the cell's right edge.
    const titleMax = Math.floor((col + 1) * cellW - plotLeft - 8);
    return { s, grid, labelWidth, titleMax };
  });

  const grid = cells.map((c) => c.grid);
  const xAxis = series.map((_, i) => ({ type: 'time', gridIndex: i, axisLabel: TIME_AXIS_LABEL }));
  const yAxis = cells.map((c, i) => ({
    type: 'value',
    gridIndex: i,
    ...axisNameOptions(axisTitle([c.s], normalize, resolveAxisLabel), 'top', c.titleMax, c.labelWidth, i),
  }));
  const echSeries = series.map((s, i) => ({
    name: displayLabels.get(s.seriesId) ?? s.label,
    type: 'line',
    color: seriesColor(i),
    ...symbolSpec(s),
    connectNulls: false,
    xAxisIndex: i,
    yAxisIndex: i,
    tooltip: { valueFormatter: (value: number | null | undefined) => tooltipValueFormatter(value, s.unit) },
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
  channelXUnit?: string | null;
  channelYUnit?: string | null;
  viewport?: ChartViewport;
}

export function buildCorrelationOption(input: CorrelationOptionInput): Record<string, unknown> {
  const width = input.viewport?.width ?? DEFAULT_WIDTH;
  const height = input.viewport?.height ?? SINGLE_DEFAULT_HEIGHT;
  const ys: number[] = [];
  for (const zone of input.zonePairs) {
    for (const [, y] of zone.points) {
      if (Number.isFinite(y)) ys.push(y);
    }
  }
  const yLabelWidth = tickLabelWidth(ys);
  const left = axisBand(yLabelWidth, input.channelYLabel !== '') + OUTER_PAD;
  const right = RIGHT_PAD_NO_AXIS;
  const top = 40; // room for the scrolling legend
  const xNameGap = 28;
  const bottom = xNameGap + NAME_BAND + 8;
  const xTitle: AxisTitle = { full: input.channelXLabel, short: input.channelXUnit ? prettyUnit(input.channelXUnit) : null };
  const yTitle: AxisTitle = { full: input.channelYLabel, short: input.channelYUnit ? prettyUnit(input.channelYUnit) : null };
  const xName = axisNameOptions(xTitle, 'parallel', width - left - right, 0, 0);
  const displayLabels = uniqueDisplayLabels(input.zonePairs.map((zone) => ({ identity: zone.groupId, label: zone.label })));
  const correlationTooltip = input.channelXUnit === 'pF' || input.channelYUnit === 'pF'
    ? {
      trigger: 'item',
      formatter: (param: { value?: unknown; seriesName?: unknown }) => {
        const value = Array.isArray(param.value) ? param.value : [];
        const name = typeof param.seriesName === 'string' ? `${escapeHtml(param.seriesName)}<br/>` : '';
        return `${name}${escapeHtml(input.channelXLabel)}: ${tooltipValueFormatter(value[0] as number | null, input.channelXUnit)}<br/>${escapeHtml(input.channelYLabel)}: ${tooltipValueFormatter(value[1] as number | null, input.channelYUnit)}`;
      },
    }
    : { trigger: 'item', valueFormatter: tooltipValueFormatter };
  return {
    color: SERIES_PALETTE,
    tooltip: correlationTooltip,
    legend: { type: 'scroll' },
    grid: [{ left, right, top, bottom }],
    xAxis: [{
      type: 'value',
      ...xName,
      nameRotate: 0,
      nameGap: xNameGap,
    }],
    yAxis: [{ type: 'value', ...axisNameOptions(yTitle, 'parallel', height - top - bottom - 8, yLabelWidth, 0) }],
    series: input.zonePairs.map((zone) => ({
      id: zone.groupId,
      name: displayLabels.get(zone.groupId) ?? zone.label,
      type: 'scatter',
      symbolSize: 7,
      data: zone.points,
    })),
  };
}
