/**
 * Layout arithmetic shared by the history charts (ECharts on Analysis,
 * Recharts on device and card history).
 *
 * Neither library sizes a value axis to its own tick labels: ECharts places a
 * rotated axis title at a fixed `nameGap`, and Recharts 2 uses a fixed `YAxis`
 * width. Both let text spill over the plot or out of the canvas once labels get
 * long (four-digit values, negative stem change, "Soil water tension (kPa)").
 * These helpers estimate text widths so the callers can size the axis band and
 * shorten titles before they overflow.
 *
 * The width estimate is a per-glyph table for a generic sans-serif face. It is
 * deterministic (no canvas, so it behaves the same in jsdom tests and in the
 * browser) and errs on the wide side: the tests hold it at or above the
 * Helvetica/Arial AFM widths. Other UI faces (Segoe UI, Roboto, SF) differ by
 * a few per cent per glyph.
 *
 * The tick labels are approximated from a tight min/max domain. Recharts
 * (`[0, 'auto']` on some charts) and ECharts (`scale: false`) may include 0 and
 * draw a different extreme label; the widest label is usually the largest
 * magnitude, so the estimate rarely differs by more than one glyph. The
 * rendered check at 320/390/1440 px remains the real gate.
 */

/** Approximate advance widths in em for a generic sans-serif face. */
function glyphEm(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x2e80) return 1; // CJK and other full-width scripts
  if (/[0-9]/.test(char)) return 0.56;
  if (char === ' ') return 0.28;
  if ('.,:;\'|!'.includes(char)) return 0.28;
  if ('iljI'.includes(char)) return 0.24;
  if ('ftr()[]-'.includes(char)) return 0.36;
  if ('MW'.includes(char)) return 0.95;
  if ('mw%'.includes(char)) return 0.9;
  if ('OQG'.includes(char)) return 0.78;
  if ('°'.includes(char)) return 0.4;
  if (char === '—') return 1;
  if ('…–'.includes(char)) return 0.6;
  if (/[A-Z]/.test(char)) return 0.73;
  return 0.56;
}

export function estimateTextWidth(text: string, fontPx = 12): number {
  let em = 0;
  for (const char of text) em += glyphEm(char);
  return Math.ceil(em * fontPx);
}

const ELLIPSIS = '…';

/** Shortens `text` with a trailing ellipsis so it fits `maxPx`. */
export function fitText(text: string, maxPx: number, fontPx = 12): string {
  if (estimateTextWidth(text, fontPx) <= maxPx) return text;
  const ellipsisPx = estimateTextWidth(ELLIPSIS, fontPx);
  if (ellipsisPx > maxPx) return '';
  const chars = Array.from(text);
  let kept = chars.length;
  while (kept > 0 && estimateTextWidth(chars.slice(0, kept).join(''), fontPx) + ellipsisPx > maxPx) kept -= 1;
  return `${chars.slice(0, kept).join('').trimEnd()}${ELLIPSIS}`;
}

export interface FittedTitle {
  /** What to draw. */
  text: string;
  /** The untouched title, for a tooltip or `title` attribute. */
  full: string;
  shortened: boolean;
}

/**
 * Fits an axis title into `maxPx`: the descriptive title when it fits, else the
 * bare unit (`short`), else the title cut with an ellipsis. The unit comes
 * before the ellipsis because "kPa" says more than "Soil water te…".
 */
export function fitAxisTitle(full: string, opts: { maxPx: number; short?: string | null; fontPx?: number }): FittedTitle {
  const fontPx = opts.fontPx ?? 12;
  if (estimateTextWidth(full, fontPx) <= opts.maxPx) return { text: full, full, shortened: false };
  const short = opts.short?.trim();
  if (short && estimateTextWidth(short, fontPx) <= opts.maxPx) return { text: short, full, shortened: true };
  return { text: fitText(short || full, opts.maxPx, fontPx), full, shortened: true };
}

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  return factor * magnitude;
}

export interface TickLabelOptions {
  /** Target tick count; both libraries default to about five. */
  count?: number;
  /** The axis tick formatter. Default: the plain number at the step's decimals. */
  format?: (value: number) => string;
}

/**
 * Approximates the tick labels a value axis will draw for these values: nice
 * 1/2/5 steps, bounds extended outward to a whole step, as ECharts and
 * Recharts both do for an automatic domain.
 */
export function valueAxisTickLabels(values: Iterable<number | null | undefined>, opts: TickLabelOptions = {}): string[] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === Infinity) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.2 || 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep(max - min, opts.count ?? 5);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  // Rounding only (the labels feed a width estimate), so no locale formatting here.
  const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
  const format = opts.format ?? ((value: number) => String(round(value, decimals)));
  const labels: string[] = [];
  for (let i = 0; i <= 50; i += 1) {
    const value = start + i * step;
    if (value > end + step / 2) break;
    labels.push(format(round(value, decimals + 2)));
  }
  return labels;
}

/** Widest estimated tick label for these values, in px. */
export function valueAxisLabelWidth(
  values: Iterable<number | null | undefined>,
  opts: TickLabelOptions & { fontPx?: number } = {},
): number {
  const fontPx = opts.fontPx ?? 12;
  const labels = valueAxisTickLabels(values, opts);
  if (labels.length === 0) return estimateTextWidth('00', fontPx);
  return Math.max(...labels.map((label) => estimateTextWidth(label, fontPx)));
}

const RECHARTS_TICK_OFFSET = 8; // default tickSize 6 + tickMargin 2, applied even with tickLine={false}
const RECHARTS_AXIS_PAD = 4;
const RECHARTS_MIN_WIDTH = 28;
const RECHARTS_MAX_WIDTH = 96;

/**
 * A Recharts `YAxis` width that fits its tick labels. Recharts 2 has no auto
 * width; the old fixed 48-60 px cut four-digit and negative labels and wasted
 * room on small ones.
 */
export function rechartsYAxisWidth(
  values: Iterable<number | null | undefined>,
  opts: TickLabelOptions & { fontPx?: number } = {},
): number {
  const label = valueAxisLabelWidth(values, { fontPx: 11, ...opts });
  const width = label + RECHARTS_TICK_OFFSET + RECHARTS_AXIS_PAD;
  return Math.min(RECHARTS_MAX_WIDTH, Math.max(RECHARTS_MIN_WIDTH, Math.ceil(width)));
}
