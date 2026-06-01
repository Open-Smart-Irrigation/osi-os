import type { HistoryCardSummary } from './types';

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function sourceLabelsForCard(card: HistoryCardSummary): string[] {
  if (Array.isArray(card.sourceLabels) && card.sourceLabels.length > 0) {
    return card.sourceLabels.map((label) => label.trim()).filter(Boolean);
  }

  if (Array.isArray(card.sourceDevices) && card.sourceDevices.length > 0) {
    return card.sourceDevices
      .map((device) => (typeof device.name === 'string' ? device.name.trim() : ''))
      .filter(Boolean);
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
