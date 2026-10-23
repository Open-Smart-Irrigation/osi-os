import uPlot from 'uplot';
import type { SensorSeries } from '../shared/types';

type UplotTable = [number[], Array<number | null>];

function normalizeTable(series: SensorSeries): UplotTable {
  const valueByMillisecond = new Map<number, number | null>();

  for (const point of series.points) {
    valueByMillisecond.set(point.t, point.value);
  }

  const ordered = [...valueByMillisecond.entries()].sort(
    ([left], [right]) => left - right,
  );

  return [
    ordered.map(([timestamp]) => timestamp / 1_000),
    ordered.map(([, value]) => value),
  ];
}

export function toUplotData(
  series: readonly SensorSeries[],
): uPlot.AlignedData {
  if (series.length === 0) {
    return [[]];
  }

  const tables = series.map(normalizeTable);

  // Expand explicit nulls across only the undefined alignment artifacts that
  // uPlot adds between adjacent points in the same outage.
  const nullModes: uPlot.JoinNullMode[][] = tables.map(() => [0, 2]);

  return uPlot.join(tables, nullModes);
}
