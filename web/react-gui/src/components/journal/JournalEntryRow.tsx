import React from 'react';
import { useTranslation } from 'react-i18next';

import { vocabLabelOrCode } from '../../journal/catalogModel';
import type { EntryAggregate } from '../../types/journal';
import type { JournalCaptureCatalogModel } from '../../types/journalCapture';
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
  // P1 fix (live UX pass): resolves entry.activity_code via the catalog's own
  // label (see journal/catalogModel.ts's vocabLabelOrCode) instead of the
  // client-side journal.json `activity.*` map, which only ever covered 6 of
  // the 16 shipped activity codes and rendered the other 10 as a raw
  // snake_case code. Optional/additive: JournalTimeline is this row's only
  // caller and passes its own catalog model down; a caller (or existing
  // test) that omits it gets vocabLabelOrCode's own null-model fallback —
  // the raw activity code — exactly as before this existed.
  model?: JournalCaptureCatalogModel | null;
}

export const JournalEntryRow: React.FC<JournalEntryRowProps> = ({ entry, plotLabel, model = null }) => {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n.resolvedLanguage || i18n.language;
  const date = formatOccurredDate(entry.occurred_start, entry.occurred_timezone, locale);
  const statusClass = statusBadgeClass(entry.status);

  return (
    <article className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-bold text-[var(--text)]">
          {vocabLabelOrCode(entry.activity_code, model, locale)}
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
