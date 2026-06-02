import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatHistorySourceLabel } from '../../../history/sourceLabels';
import type { HistoryCardSummary } from '../../../history/types';

interface HistoryDetailHeaderProps {
  zoneName: string | null;
  card: HistoryCardSummary;
  backHref: string;
  settingsOpen?: boolean;
  canOpenAdvanced?: boolean;
  onSettingsToggle?: () => void;
  onAdvancedView?: () => void;
  onResetRange?: () => void;
  onRefresh?: () => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistoryDetailHeader: React.FC<HistoryDetailHeaderProps> = ({
  zoneName,
  card,
  backHref,
  settingsOpen = false,
  canOpenAdvanced = false,
  onSettingsToggle,
  onAdvancedView,
  onResetRange,
  onRefresh,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const sourceLabel = formatHistorySourceLabel(t, card);

  return (
    <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        <Link
          to={backHref}
          className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-sm font-bold text-[var(--text)]"
        >
          {t('history.detail.backToHistory')}
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {zoneName ?? t(`history.cardType.${card.cardType}`)}
          </p>
          <h1 className="truncate text-xl font-bold text-[var(--text)]">{card.title}</h1>
          {sourceLabel && (
            <p className="truncate text-sm font-medium text-[var(--text)]">{sourceLabel}</p>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-sm font-bold text-[var(--text)]"
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
            aria-label={t('history.settings.open')}
            onClick={onSettingsToggle}
          >
            ...
          </button>
          {settingsOpen && (
            <div
              role="menu"
              aria-label={t('history.settings.menuLabel')}
              className="absolute right-0 top-full z-20 mt-2 w-44 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg"
            >
              {canOpenAdvanced && (
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full rounded px-3 py-2 text-left text-sm font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
                  onClick={onAdvancedView}
                >
                  {t('history.settings.advancedView')}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-3 py-2 text-left text-sm font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
                onClick={onResetRange}
              >
                {t('history.settings.resetRange')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-3 py-2 text-left text-sm font-semibold text-[var(--text)] hover:bg-[var(--secondary-bg)]"
                onClick={onRefresh}
              >
                {t('history.settings.refresh')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
