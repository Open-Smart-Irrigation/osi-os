import type { AnalysisSeries } from './types';

export function applyLabelOverrides(
  series: AnalysisSeries[],
  overrides: Record<string, string>,
): AnalysisSeries[] {
  return series.map((s) => {
    const override = overrides[s.seriesId];
    return override ? { ...s, label: override } : s;
  });
}
