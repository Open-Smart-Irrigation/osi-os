import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryRangeLabel } from '../../../history/types';

const DETAIL_RANGE_OPTIONS: readonly HistoryRangeLabel[] = ['12h', '24h', '7d', '30d', 'season'];

interface HistoryRangeSegmentedControlProps {
  activeRange: HistoryRangeLabel;
  supportedRanges: readonly HistoryRangeLabel[];
  onRangeChange: (range: HistoryRangeLabel) => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function formatRangeLabel(t: HistoryTranslate, range: HistoryRangeLabel): string {
  return t(`history.rangeShort.${range}`);
}

export const HistoryRangeSegmentedControl: React.FC<HistoryRangeSegmentedControlProps> = ({
  activeRange,
  supportedRanges,
  onRangeChange,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const supportedRangeSet = new Set(supportedRanges);

  return (
    <div
      role="group"
      aria-label={t('history.detail.rangeControlLabel')}
      className="grid grid-cols-5 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--secondary-bg)]"
    >
      {DETAIL_RANGE_OPTIONS.map((range) => {
        const isActive = activeRange === range;
        const isSupported = supportedRangeSet.has(range);

        return (
          <button
            key={range}
            type="button"
            aria-pressed={isActive}
            disabled={!isSupported}
            onClick={() => {
              if (isSupported) onRangeChange(range);
            }}
            className={`min-h-11 border-r border-[var(--border)] px-2 text-sm font-bold last:border-r-0 ${
              isActive
                ? 'bg-[var(--primary)] text-white'
                : 'bg-transparent text-[var(--text)]'
            } disabled:cursor-not-allowed disabled:text-[var(--text-tertiary)] disabled:opacity-45`}
          >
            {formatRangeLabel(t, range)}
          </button>
        );
      })}
    </div>
  );
};
