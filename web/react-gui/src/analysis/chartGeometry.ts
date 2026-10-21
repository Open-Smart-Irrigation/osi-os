/** Pixel geometry shared by the Analysis chart frame and its ECharts options. */

export interface ChartViewport {
  width: number;
  height: number;
}

/** A small-multiples cell narrower than this squeezes its plot to a sliver. */
export const SMALL_MULTIPLE_MIN_CELL_WIDTH = 260;

/**
 * Column count for small multiples: a square-ish grid, but never cells narrower
 * than SMALL_MULTIPLE_MIN_CELL_WIDTH, so a phone gets one column. Without a
 * measured width (first render) it keeps the square-ish grid.
 */
export function smallMultiplesColumns(count: number, width?: number): number {
  if (count <= 0) return 1;
  const square = Math.ceil(Math.sqrt(count));
  if (width === undefined || !(width > 0)) return square;
  const fit = Math.max(1, Math.floor(width / SMALL_MULTIPLE_MIN_CELL_WIDTH));
  return Math.max(1, Math.min(square, fit));
}
