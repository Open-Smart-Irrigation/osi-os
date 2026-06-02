import type { HistoryCardSummary } from './types';

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function sourceLabelsForCard(card: HistoryCardSummary): string[] {
  const safeLabel = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed || /\b[A-F0-9]{16}\b/i.test(trimmed)) return null;
    return trimmed;
  };

  if (Array.isArray(card.sourceLabels) && card.sourceLabels.length > 0) {
    return card.sourceLabels
      .map(safeLabel)
      .filter((label): label is string => Boolean(label));
  }

  if (Array.isArray(card.sourceDevices) && card.sourceDevices.length > 0) {
    return card.sourceDevices
      .map((device) => (typeof device.name === 'string' ? safeLabel(device.name) : null))
      .filter((label): label is string => Boolean(label));
  }

  return [];
}

export function formatHistorySourceLabel(
  t: HistoryTranslate,
  card: HistoryCardSummary,
): string | null {
  const labels = sourceLabelsForCard(card);
  const count = card.sourceDeviceCount ?? labels.length;
  if (labels.length > 1) {
    return t('history.source.multipleNamed', { count: labels.length, names: labels.join(', ') });
  }
  if (labels.length === 1) return labels[0];
  if (count > 1) return t('history.source.multiple', { count });
  return card.sourceLabel ?? null;
}
