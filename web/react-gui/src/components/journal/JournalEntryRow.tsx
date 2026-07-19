import React from 'react';
import { useTranslation } from 'react-i18next';

import type { EntryAggregate } from '../../types/journal';
import { statusBadgeClass } from './statusBadgeClass';

export function formatOccurredDate(value: string, timeZone: string, locale?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  }
}

interface JournalEntryRowProps {
  entry: EntryAggregate;
  plotLabel: string | null;
}

export const JournalEntryRow: React.FC<JournalEntryRowProps> = ({ entry, plotLabel }) => {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n.resolvedLanguage || i18n.language;
  const date = formatOccurredDate(entry.occurred_start, entry.occurred_timezone, locale);
  const statusClass = statusBadgeClass(entry.status);

  return (
    <article className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-bold text-[var(--text)]">
          {t(`activity.${entry.activity_code}`, entry.activity_code)}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {entry.plot_uuid ? (plotLabel ?? t('row.unknownPlot')) : t('row.farmLevel')}
          {' · '}
          <time dateTime={entry.occurred_start}>{date}</time>
        </p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${statusClass}`}
        role="status"
      >
        {t(`row.status.${entry.status}`)}
      </span>
    </article>
  );
};
