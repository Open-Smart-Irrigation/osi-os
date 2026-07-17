import type { JournalPlot } from '../types/journal';

const DECIMAL_OR_EXPONENT_SYNTAX = /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+/;

export interface StationPlotPosition {
  plot: JournalPlot;
  gridNumber: number;
  sourceNumber: number;
}

export interface StationModel {
  gridPlots: StationPlotPosition[];
  namedFallbackPlots: JournalPlot[];
  unstationedPlots: JournalPlot[];
}

function sourceNumberFrom(value: string | null): number | null {
  if (typeof value !== 'string') return null;
  if (DECIMAL_OR_EXPONENT_SYNTAX.test(value)) return null;
  const matches = value.match(/[0-9]+/g);
  if (!matches || matches.length !== 1) return null;

  const number = Number(matches[0]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function sourceNumberFor(plot: JournalPlot): number | null {
  return sourceNumberFrom(plot.plot_code) ?? sourceNumberFrom(plot.name);
}

export function deriveStationModel(
  stationCode: string,
  plots: readonly JournalPlot[],
): StationModel {
  const stationPlots = plots.filter((plot) => plot.station_code === stationCode);
  const unstationedPlots = plots.filter((plot) => plot.station_code == null);
  const sourceNumbers = new Map<number, JournalPlot[]>();
  const extracted = stationPlots.map((plot) => ({ plot, sourceNumber: sourceNumberFor(plot) }));

  for (const { plot, sourceNumber } of extracted) {
    if (sourceNumber == null) continue;
    const members = sourceNumbers.get(sourceNumber) ?? [];
    members.push(plot);
    sourceNumbers.set(sourceNumber, members);
  }

  const gridPlots = extracted
    .filter(({ sourceNumber }) => sourceNumber != null && sourceNumbers.get(sourceNumber)?.length === 1)
    .sort((left, right) => left.sourceNumber! - right.sourceNumber!)
    .map(({ plot, sourceNumber }, index) => ({
      plot,
      gridNumber: index + 1,
      sourceNumber: sourceNumber!,
    }));

  const namedFallbackPlots = extracted
    .filter(({ sourceNumber }) =>
      sourceNumber == null || sourceNumbers.get(sourceNumber)!.length > 1,
    )
    .map(({ plot }) => plot);

  return { gridPlots, namedFallbackPlots, unstationedPlots };
}
