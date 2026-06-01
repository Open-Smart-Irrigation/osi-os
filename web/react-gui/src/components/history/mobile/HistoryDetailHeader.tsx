import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatHistorySourceLabel } from '../../../history/sourceLabels';
import type { HistoryCardSummary } from '../../../history/types';

interface HistoryDetailHeaderProps {
  zoneName: string | null;
  card: HistoryCardSummary;
  backHref: string;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistoryDetailHeader: React.FC<HistoryDetailHeaderProps> = ({
  zoneName,
  card,
  backHref,
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
      </div>
    </header>
  );
};
