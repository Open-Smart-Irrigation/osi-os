import type { HistoryCardDataResponse, HistorySourceChoice } from './types';

export interface HistorySourceDescriptor {
  sourceKey?: string | null;
  deviceSourceId?: string | null;
  sourceLabel?: string | null;
  label?: string | null;
}

function sourceSuffix(sourceKey: string): string {
  return sourceKey.trim().slice(-8) || 'unknown';
}

export function historySourceChoiceLabel(name: string | null | undefined, sourceKey: string, duplicate = false): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const safe = trimmed && !/^[0-9a-f]{16}$/i.test(trimmed) && !/(?:soil|dendro|environment|gateway)-src-[a-z0-9-]+$/i.test(trimmed);
  if (!safe) return `Source · ${sourceSuffix(sourceKey)}`;
  return duplicate ? `${trimmed} · ${sourceSuffix(sourceKey)}` : trimmed;
}

export function historySourceChoicesFromSeries(series: readonly HistorySourceDescriptor[]): HistorySourceChoice[] {
  const byKey = new Map<string, HistorySourceDescriptor>();
  series.forEach((item) => {
    const sourceKey = typeof item.sourceKey === 'string' ? item.sourceKey.trim() : '';
    if (sourceKey && !byKey.has(sourceKey)) byKey.set(sourceKey, item);
  });
  const entries = [...byKey.entries()];
  const baseLabels = entries.map(([, item]) => typeof item.sourceLabel === 'string' && item.sourceLabel.trim()
    ? item.sourceLabel.trim()
    : typeof item.label === 'string' ? item.label.trim() : '');
  const counts = new Map<string, number>();
  baseLabels.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1));
  return entries.map(([sourceKey, item], index) => ({
    sourceKey,
    label: historySourceChoiceLabel(baseLabels[index], sourceKey, (counts.get(baseLabels[index]) ?? 0) > 1),
    deviceSourceId: item.deviceSourceId ?? null,
  }));
}

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
