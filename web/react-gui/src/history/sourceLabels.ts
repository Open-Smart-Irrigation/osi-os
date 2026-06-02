import type { HistoryCardSummary } from './types';

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function safeSourceLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /\b[A-F0-9]{16}\b/i.test(trimmed)) return null;
  return trimmed;
}

function sourceLabelsForCard(card: HistoryCardSummary): string[] {
  if (Array.isArray(card.sourceLabels) && card.sourceLabels.length > 0) {
    return card.sourceLabels
      .map(safeSourceLabel)
      .filter((label): label is string => Boolean(label));
  }

  if (Array.isArray(card.sourceDevices) && card.sourceDevices.length > 0) {
    return card.sourceDevices
      .map((device) => safeSourceLabel(device.name))
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
  return safeSourceLabel(card.sourceLabel);
}
