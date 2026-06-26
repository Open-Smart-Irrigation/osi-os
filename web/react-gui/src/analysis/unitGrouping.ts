import type { AnalysisSeries } from './types';

export interface UnitPanel {
  unit: string;
  seriesIds: string[];
}

/** One panel per distinct unit, preserving first-seen order. */
export function groupByUnit(series: AnalysisSeries[]): UnitPanel[] {
  const panels: UnitPanel[] = [];
  const index = new Map<string, UnitPanel>();
  for (const item of series) {
    const unit = item.unit ?? '';
    let panel = index.get(unit);
    if (!panel) {
      panel = { unit, seriesIds: [] };
      index.set(unit, panel);
      panels.push(panel);
    }
    panel.seriesIds.push(item.seriesId);
  }
  return panels;
}

export function isOverlay(panels: UnitPanel[]): boolean {
  return panels.length <= 1;
}
