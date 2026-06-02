import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryCardSummary } from '../../../history/types';
import { HistorySourcePopover, type HistorySourcePopoverSource } from './HistorySourcePopover';

interface HistoryDetailHeaderProps {
  zoneName: string | null;
  card: HistoryCardSummary;
  settingsOpen?: boolean;
  canOpenAdvanced?: boolean;
  onSettingsToggle?: () => void;
  onAdvancedView?: () => void;
  onResetRange?: () => void;
  onRefresh?: () => void;
  sources?: readonly HistorySourcePopoverSource[];
  enabledSourceKeys?: readonly string[];
  onSourceKeysChange?: (enabledKeys: string[]) => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistoryDetailHeader: React.FC<HistoryDetailHeaderProps> = ({
  zoneName,
  card,
  settingsOpen = false,
  canOpenAdvanced = false,
  onSettingsToggle,
  onAdvancedView,
  onResetRange,
  onRefresh,
  sources = [],
  enabledSourceKeys = [],
  onSourceKeysChange,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;

  return (
    <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {zoneName ?? t(`history.cardType.${card.cardType}`)}
          </p>
          <h1 className="truncate text-xl font-bold text-[var(--text)]">{card.title}</h1>
        </div>
        {onSourceKeysChange && (
          <HistorySourcePopover
            sources={sources}
            enabledKeys={enabledSourceKeys}
            onChange={onSourceKeysChange}
          />
        )}
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
