import React from 'react';
import { useTranslation } from 'react-i18next';

import type { EntryAggregate, JournalPlot } from '../../types/journal';
import { JournalEntryRow } from './JournalEntryRow';

interface JournalTimelineProps {
  entries: EntryAggregate[];
  plots: JournalPlot[];
  loading: boolean;
}

export const JournalTimeline: React.FC<JournalTimelineProps> = ({
  entries,
  plots,
  loading,
}) => {
  const { t } = useTranslation('journal');

  if (loading) {
    return <p className="text-[var(--text-secondary)]">{t('timeline.loading')}</p>;
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[var(--text-secondary)]">
        {t('timeline.empty')}
      </div>
    );
  }

  const plotLabels = new Map(plots.map((plot) => [
    plot.plot_uuid,
    plot.name?.trim() || plot.plot_code,
  ]));

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <JournalEntryRow
          key={entry.entry_uuid}
          entry={entry}
          plotLabel={entry.plot_uuid ? (plotLabels.get(entry.plot_uuid) ?? null) : null}
        />
      ))}
    </div>
  );
};
