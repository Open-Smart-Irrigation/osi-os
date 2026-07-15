import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AppHeader } from '../components/AppHeader';
import { JournalTimeline } from '../components/journal/JournalTimeline';
import { useAuth } from '../contexts/AuthContext';
import { useJournalCatalog } from '../journal/useJournalCatalog';
import { useJournalEntries } from '../journal/useJournalEntries';
import { useJournalPlots } from '../journal/useJournalPlots';
import type { EntryListFilters } from '../types/journal';

export const JournalPage: React.FC = () => {
  const { t } = useTranslation('journal');
  const { username, logout } = useAuth();
  const [plotUuid, setPlotUuid] = useState('');
  const [activityCode, setActivityCode] = useState('');
  const catalogState = useJournalCatalog();
  const filters = useMemo<EntryListFilters>(() => ({
    status: 'final',
    limit: 50,
    ...(plotUuid ? { plot_uuid: plotUuid } : {}),
    ...(activityCode ? { activity_code: activityCode } : {}),
  }), [activityCode, plotUuid]);
  const entryState = useJournalEntries(filters, catalogState.available);
  const plotState = useJournalPlots(catalogState.available);
  const readError = entryState.error || plotState.error;
  const activities = (catalogState.catalog?.vocab ?? [])
    .filter((row) => row.kind === 'activity' && row.active === 1);

  const retryReads = () => Promise.all([entryState.retry(), plotState.retry()]);
  const errorCard = (retry: () => Promise<unknown>) => (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8">
      <h2 className="text-xl font-bold text-[var(--text)]">{t('error.title')}</h2>
      <p className="mt-2 text-[var(--text-secondary)]">{t('error.body')}</p>
      <button
        type="button"
        className="btn-liquid mt-4 rounded-lg px-4 py-2"
        onClick={() => void retry()}
      >
        {t('error.retry')}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <AppHeader
        title={t('title')}
        activeTab="journal"
        username={username}
        onLogout={logout}
      />

      <main className="mx-auto max-w-3xl px-4 py-8">
        {catalogState.loading ? (
          <p className="text-[var(--text-secondary)]">{t('timeline.loading')}</p>
        ) : catalogState.unavailable ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8">
            <h2 className="text-xl font-bold text-[var(--text)]">
              {t('unavailable.title')}
            </h2>
            <p className="mt-2 text-[var(--text-secondary)]">{t('unavailable.body')}</p>
          </div>
        ) : catalogState.error ? (
          errorCard(catalogState.retry)
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <label className="min-w-40 flex-1 text-sm text-[var(--text-secondary)]">
                {t('filters.plot')}
                <select
                  aria-label={t('filters.plot')}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[var(--text)]"
                  value={plotUuid}
                  onChange={(event) => setPlotUuid(event.target.value)}
                >
                  <option value="">{t('filters.allPlots')}</option>
                  {plotState.plots.map((plot) => (
                    <option key={plot.plot_uuid} value={plot.plot_uuid}>
                      {plot.name?.trim() || plot.plot_code}
                    </option>
                  ))}
                </select>
              </label>

              <label className="min-w-40 flex-1 text-sm text-[var(--text-secondary)]">
                {t('filters.activity')}
                <select
                  aria-label={t('filters.activity')}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[var(--text)]"
                  value={activityCode}
                  onChange={(event) => setActivityCode(event.target.value)}
                >
                  <option value="">{t('filters.allActivities')}</option>
                  {activities.map((activity) => (
                    <option key={activity.code} value={activity.code}>
                      {t(`activity.${activity.code}`, activity.code)}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="btn-liquid rounded-lg px-5 py-2.5 font-bold"
              >
                {t('logActivity')}
              </button>
            </div>

            {readError ? errorCard(retryReads) : (
              <JournalTimeline
                entries={entryState.entries}
                plots={plotState.plots}
                loading={entryState.loading || plotState.loading}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};
