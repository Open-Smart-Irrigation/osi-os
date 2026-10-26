import type { AnalysisSeries, TimelineLayout } from './types';
import type { UnitPanel } from './unitGrouping';
import { valueAxisLabelWidth } from '../charts/axisLayout';

// Value-axis band geometry for the Analysis ECharts options, in px. ECharts
// draws tick labels 8 px (axisLabel.margin) from the axis line in its default
// 12 px font; a rotated title sits NAME_SPACING beyond the widest label and
// takes NAME_BAND.
export const TICK_FONT_PX = 12;
export const LABEL_MARGIN = 8;
export const NAME_SPACING = 6;
export const NAME_BAND = 16;
export const OUTER_PAD = 4;
export const RIGHT_PAD_NO_AXIS = 24;

/** Owner rule (2026-10-21): stack an overlaid chart whose plot is narrower than this… */
export const AUTO_STACK_MIN_PLOT_PX = 280;
/** …or narrower than this share of the frame. */
export const AUTO_STACK_MIN_PLOT_SHARE = 0.5;

/** ECharts' default value-axis label: the number with thousands separators. */
export function echartsTickLabel(value: number): string {
  const [integer, fraction] = String(value).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function axisValues(axisSeries: AnalysisSeries[], normalize: boolean): number[] {
  if (normalize) return [0, 100];
  const values: number[] = [];
  for (const s of axisSeries) {
    for (const p of s.points) if (p.value !== null && Number.isFinite(p.value)) values.push(p.value);
  }
  return values;
}

export function tickLabelWidth(values: number[]): number {
  return valueAxisLabelWidth(values, { fontPx: TICK_FONT_PX, format: echartsTickLabel });
}

/** Width of an axis band: tick labels plus, when titled, the rotated title. */
export function axisBand(labelWidth: number, titled: boolean): number {
  return labelWidth + LABEL_MARGIN + (titled ? NAME_SPACING + NAME_BAND : 0);
}

/** Left and right grid margins of the overlaid layout, given each axis band (first = left). */
export function overlaidMargins(bands: number[]): { left: number; right: number } {
  const rightBands = bands.slice(1).reduce((sum, band) => sum + band, 0);
  return {
    left: (bands[0] ?? 0) + OUTER_PAD,
    right: rightBands > 0 ? rightBands + OUTER_PAD : RIGHT_PAD_NO_AXIS,
  };
}

/** Plot width an overlaid chart keeps after one titled axis per group. */
export function overlaidPlotWidth(axisGroups: AnalysisSeries[][], frameWidth: number): number {
  const bands = axisGroups.map((group) => axisBand(tickLabelWidth(axisValues(group, false)), group.length > 0));
  const { left, right } = overlaidMargins(bands);
  return frameWidth - left - right;
}

/**
 * Whether an overlaid multi-unit chart should render stacked: its axes leave
 * under AUTO_STACK_MIN_PLOT_PX or under half the frame for the plot. Only the
 * rendering changes; the saved view keeps `overlaid`.
 */
export function shouldAutoStack(input: {
  layout: TimelineLayout;
  normalize: boolean;
  panels: UnitPanel[];
  series: AnalysisSeries[];
  width: number | undefined;
}): boolean {
  const { layout, normalize, panels, series, width } = input;
  if (layout !== 'overlaid' || normalize || panels.length < 2 || !width || !(width > 0)) return false;
  const groups = panels.map((panel) => series.filter((s) => panel.seriesIds.includes(s.seriesId)));
  const plot = overlaidPlotWidth(groups, width);
  return plot < AUTO_STACK_MIN_PLOT_PX || plot < width * AUTO_STACK_MIN_PLOT_SHARE;
}
