import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryViewMode } from '../../../history/types';

interface HistoryViewModeSegmentedControlProps {
  activeView: HistoryViewMode;
  views: readonly HistoryViewMode[];
  onViewChange: (view: HistoryViewMode) => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function formatViewLabel(t: HistoryTranslate, view: HistoryViewMode): string {
  return t(`history.viewMode.${view}`);
}

export const HistoryViewModeSegmentedControl: React.FC<HistoryViewModeSegmentedControlProps> = ({
  activeView,
  views,
  onViewChange,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const primaryViews = views.filter((view) => view !== 'advanced');

  if (primaryViews.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t('history.detail.viewControlLabel')}
      className="flex overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--secondary-bg)]"
    >
      {primaryViews.map((view) => {
        const isActive = activeView === view;

        return (
          <button
            key={view}
            type="button"
            aria-pressed={isActive}
            onClick={() => onViewChange(view)}
            className={`min-h-11 flex-1 whitespace-nowrap border-r border-[var(--border)] px-3 text-sm font-bold last:border-r-0 ${
              isActive
                ? 'bg-[var(--primary)] text-white'
                : 'bg-transparent text-[var(--text)]'
            }`}
          >
            {formatViewLabel(t, view)}
          </button>
        );
      })}
    </div>
  );
};
