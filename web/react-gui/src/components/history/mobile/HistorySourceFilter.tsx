import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryCardSourceDevice, HistoryCardSummary } from '../../../history/types';

interface HistorySourceFilterProps {
  card: HistoryCardSummary;
  selectedSourceKey: string | null;
  onSourceChange: (sourceKey: string | null) => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function shouldRenderSourceFilter(card: HistoryCardSummary): boolean {
  return (
    (card.cardType === 'soil' || card.cardType === 'environment')
    && (card.sourceDeviceCount ?? card.sourceDevices?.length ?? 0) > 1
    && Array.isArray(card.sourceDevices)
    && card.sourceDevices.some((device) => Boolean(device.sourceKey && device.name))
  );
}

function sourceOptions(card: HistoryCardSummary): HistoryCardSourceDevice[] {
  const seen = new Set<string>();
  return (card.sourceDevices ?? []).filter((device) => {
    const sourceKey = typeof device.sourceKey === 'string' ? device.sourceKey.trim() : '';
    const name = typeof device.name === 'string' ? device.name.trim() : '';
    if (!sourceKey || !name || /\b[A-F0-9]{16}\b/i.test(name) || seen.has(sourceKey)) return false;
    seen.add(sourceKey);
    return true;
  });
}

export const HistorySourceFilter: React.FC<HistorySourceFilterProps> = ({
  card,
  selectedSourceKey,
  onSourceChange,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;

  if (!shouldRenderSourceFilter(card)) return null;

  const options = sourceOptions(card);
  if (options.length < 2) return null;

  return (
    <div
      role="group"
      aria-label={t('history.sourceFilter.label')}
      className="flex gap-2 overflow-x-auto pb-1"
    >
      <button
        type="button"
        aria-pressed={selectedSourceKey === null}
        onClick={() => onSourceChange(null)}
        className={`min-h-10 whitespace-nowrap rounded-md border px-3 text-sm font-bold ${
          selectedSourceKey === null
            ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
            : 'border-[var(--border)] bg-[var(--secondary-bg)] text-[var(--text)]'
        }`}
      >
        {t('history.sourceFilter.all')}
      </button>
      {options.map((device) => {
        const sourceKey = String(device.sourceKey);
        return (
          <button
            key={sourceKey}
            type="button"
            aria-pressed={selectedSourceKey === sourceKey}
            onClick={() => onSourceChange(sourceKey)}
            className={`min-h-10 whitespace-nowrap rounded-md border px-3 text-sm font-bold ${
              selectedSourceKey === sourceKey
                ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                : 'border-[var(--border)] bg-[var(--secondary-bg)] text-[var(--text)]'
            }`}
          >
            {device.name}
          </button>
        );
      })}
    </div>
  );
};
