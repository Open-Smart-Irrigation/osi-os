import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatHistorySourceLabel } from '../../../history/sourceLabels';
import type { HistoryCardSummary } from '../../../history/types';
import { HistorySourcePopover, type HistorySourcePopoverSource } from './HistorySourcePopover';

interface HistoryDetailHeaderProps {
  zoneName: string | null;
  card: HistoryCardSummary;
  settingsOpen?: boolean;
  canExport?: boolean;
  canOpenAdvanced?: boolean;
  onSettingsToggle?: () => void;
  onExport?: () => void;
  onAdvancedView?: () => void;
  onResetRange?: () => void;
  onRefresh?: () => void;
  sources?: readonly HistorySourcePopoverSource[];
  enabledSourceKeys?: readonly string[];
  onSourceKeysChange?: (enabledKeys: string[]) => void;
  compact?: boolean;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function normalizedText(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function detailTitle(card: HistoryCardSummary, zoneName: string | null): string {
  const title = normalizedText(card.title) ?? card.cardType;
  const zone = normalizedText(zoneName);
  if (card.scope !== 'zone' || !zone || title.toLocaleLowerCase().includes(zone.toLocaleLowerCase())) return title;
  return `${title} ${zone}`;
}

export const HistoryDetailHeader: React.FC<HistoryDetailHeaderProps> = ({
  zoneName,
  card,
  settingsOpen = false,
  canExport = false,
  canOpenAdvanced = false,
  onSettingsToggle,
  onExport,
  onAdvancedView,
  onResetRange,
  onRefresh,
  sources = [],
  enabledSourceKeys = [],
  onSourceKeysChange,
  compact = false,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const title = detailTitle(card, zoneName);
  const eyebrow = t(`history.cardType.${card.cardType}`);
  const sourceSummary = sources.length > 1 ? formatHistorySourceLabel(t, card) : null;

  return (
    <header className={`sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)] shadow-sm ${compact ? 'px-3 py-1' : 'px-4 py-3'}`}>
      <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`}>
        <div className="min-w-0 flex-1">
          <p className={`truncate font-semibold uppercase tracking-wide text-[var(--text-tertiary)] ${compact ? 'text-[0.62rem] leading-tight' : 'text-xs'}`}>
            {eyebrow}
          </p>
          <h1 className={`truncate font-bold text-[var(--text)] ${compact ? 'text-base leading-tight' : 'text-xl'}`}>
            {title}
          </h1>
          {sourceSummary && (
            <p className={`truncate font-semibold text-[var(--text-secondary)] ${compact ? 'text-[0.68rem] leading-tight' : 'text-xs'}`}>
              {sourceSummary}
            </p>
          )}
        </div>
        {onSourceKeysChange && (
          <HistorySourcePopover
            sources={sources}
            enabledKeys={enabledSourceKeys}
            onChange={onSourceKeysChange}
            compact={compact}
          />
        )}
        {canExport && (
          <button
            type="button"
            className={`rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] text-sm font-bold text-[var(--text)] ${compact ? 'px-2 py-1' : 'px-3 py-2'}`}
            aria-label={t('history.export.open')}
            onClick={onExport}
          >
            {t('history.export.open')}
          </button>
        )}
        <div className="relative">
          <button
            type="button"
            className={`rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] text-sm font-bold text-[var(--text)] ${compact ? 'px-2 py-1' : 'px-3 py-2'}`}
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
