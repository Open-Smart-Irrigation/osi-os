import type { HistoryCardDataResponse } from './types';

export function filterHistoryDataSources(
  data: HistoryCardDataResponse | undefined,
  sourceKeys: readonly string[],
): HistoryCardDataResponse | undefined {
  if (!data || sourceKeys.length === 0) return data;
  const allowed = new Set(sourceKeys);
  const belongsToSelection = (item: { sourceKey?: string | null; deviceSourceId?: string | null }): boolean =>
    (item.sourceKey ? allowed.has(item.sourceKey) : false)
      || (item.deviceSourceId ? allowed.has(item.deviceSourceId) : false);
  return {
    ...data,
    series: data.series.filter(belongsToSelection),
    profiles: data.profiles.filter(belongsToSelection),
  };
}
