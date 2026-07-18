import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { useSearchParams } from 'react-router-dom';

import { AppHeader } from '../components/AppHeader';
import { JournalTimeline } from '../components/journal/JournalTimeline';
import { JournalCaptureFlow } from '../components/journal/capture/JournalCaptureFlow';
import { useAuth } from '../contexts/AuthContext';
import { useJournalCatalog } from '../journal/useJournalCatalog';
import { useJournalEntries } from '../journal/useJournalEntries';
import { useJournalPlots } from '../journal/useJournalPlots';
import { useJournalPlotGroups } from '../journal/useJournalPlotGroups';
import { irrigationZonesAPI } from '../services/api';
import { journalApi } from '../services/journalApi';
import type { IrrigationZone } from '../types/farming';
import type { EntryListFilters } from '../types/journal';
import type { JournalTimelineProps } from '../components/journal/JournalTimeline';
import type { JournalSavedReceipt } from '../components/journal/capture/JournalCaptureFlow';

type JournalIrrigationZone = IrrigationZone & {
  zone_uuid?: string | null;
  zoneUuid?: string | null;
};

function zoneUuid(zone: JournalIrrigationZone): string | null {
  return zone.zone_uuid ?? zone.zoneUuid ?? null;
}

function zoneCropHint(zone: JournalIrrigationZone | undefined): string | null {
  const crop = zone?.cropType ?? zone?.crop_type;
  return typeof crop === 'string' && crop.trim() ? crop.trim() : null;
}

function zoneTimezone(zone: JournalIrrigationZone | undefined): string | undefined {
  const timezone = zone?.timezone;
  return typeof timezone === 'string' && timezone.trim() ? timezone : undefined;
}

export const JournalPage: React.FC = () => {
  const { t } = useTranslation('journal');
  const { username, logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [captureOpen, setCaptureOpen] = useState(false);
  const closingCaptureRef = useRef(false);
  const restoreCaptureFocusRef = useRef(false);
  const logActivityRef = useRef<HTMLButtonElement>(null);
  const [plotUuid, setPlotUuid] = useState('');
  const [activityCode, setActivityCode] = useState('');
  const [exactEntryUuid, setExactEntryUuid] = useState<string | null>(null);
  const catalogState = useJournalCatalog();
  const filters = useMemo<EntryListFilters>(() => ({
    status: 'final',
    limit: 50,
    ...(exactEntryUuid
      ? { entry_uuid: exactEntryUuid }
      : {
        ...(plotUuid ? { plot_uuid: plotUuid } : {}),
        ...(activityCode ? { activity_code: activityCode } : {}),
      }),
  }), [activityCode, exactEntryUuid, plotUuid]);
  const entryState = useJournalEntries(filters, catalogState.available);
  const plotState = useJournalPlots(catalogState.available);
  const groupState = useJournalPlotGroups(catalogState.available);
  const zonesState = useSWR<JournalIrrigationZone[]>(
    catalogState.available ? 'journal:irrigation-zones' : null,
    () => irrigationZonesAPI.getAll(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const timelineReadError = entryState.error || plotState.error;
  const captureEnrichmentError = groupState.error || zonesState.error;
  const activities = (catalogState.catalog?.vocab ?? [])
    .filter((row) => row.kind === 'activity' && row.active === 1);

  const requestedZoneUuid = searchParams.get('zone_uuid')?.trim() || null;
  const captureRequested = searchParams.get('capture') === '1';
  const zonesByUuid = useMemo(() => new Map(
    (zonesState.data ?? [])
      .map((zone) => [zoneUuid(zone), zone] as const)
      .filter(([uuid]) => uuid != null),
  ), [zonesState.data]);
  const capturePlots = useMemo(() => plotState.plots.map((plot) => {
    const cropHint = zoneCropHint(
      plot.zone_uuid ? zonesByUuid.get(plot.zone_uuid) : undefined,
    ) || plot.crop_hint?.trim() || null;
    return { ...plot, crop_hint: cropHint };
  }), [plotState.plots, zonesByUuid]);
  const zoneCrops = useMemo(() => Object.fromEntries(
    (zonesState.data ?? []).flatMap((zone) => {
      const uuid = zoneUuid(zone);
      const crop = zoneCropHint(zone);
      return uuid && crop ? [[uuid, crop] as const] : [];
    }),
  ), [zonesState.data]);
  const zoneTimezones = useMemo(() => Object.fromEntries(
    (zonesState.data ?? []).flatMap((zone) => {
      const uuid = zoneUuid(zone);
      const timezone = zoneTimezone(zone);
      return uuid && timezone ? [[uuid, timezone] as const] : [];
    }),
  ), [zonesState.data]);
  const initialPlot = useMemo(() => requestedZoneUuid
    ? capturePlots.find((plot) => plot.zone_uuid === requestedZoneUuid)
    : undefined, [capturePlots, requestedZoneUuid]);
  const initialZone = useMemo(() => {
    if (!initialPlot?.zone_uuid) return undefined;
    return (zonesState.data ?? []).find((zone) => zoneUuid(zone) === initialPlot.zone_uuid);
  }, [initialPlot, zonesState.data]);
  const captureReady = catalogState.available && !catalogState.error && !timelineReadError && !captureEnrichmentError &&
    !plotState.loading && !groupState.loading && Array.isArray(zonesState.data) && !zonesState.isLoading && !zonesState.error;

  React.useEffect(() => {
    if (!captureRequested) {
      if (captureOpen) {
        restoreCaptureFocusRef.current = true;
        setCaptureOpen(false);
      }
      closingCaptureRef.current = false;
      return;
    }
    if (!closingCaptureRef.current && !captureOpen && captureReady) setCaptureOpen(true);
  }, [captureOpen, captureReady, captureRequested]);

  React.useEffect(() => {
    if (!captureOpen && restoreCaptureFocusRef.current) {
      restoreCaptureFocusRef.current = false;
      logActivityRef.current?.focus();
    }
  }, [captureOpen]);

  const openCapture = (zone?: string) => {
    closingCaptureRef.current = false;
    setExactEntryUuid(null);
    const next = new URLSearchParams(searchParams);
    next.set('capture', '1');
    if (zone) next.set('zone_uuid', zone);
    else next.delete('zone_uuid');
    setSearchParams(next, { replace: true });
    setCaptureOpen(true);
  };

  const closeCapture = () => {
    closingCaptureRef.current = true;
    restoreCaptureFocusRef.current = true;
    setCaptureOpen(false);
    const next = new URLSearchParams(searchParams);
    next.delete('capture');
    next.delete('zone_uuid');
    setSearchParams(next, { replace: true });
  };

  const onSaved = async (_receipt: JournalSavedReceipt) => {
    await entryState.retry();
  };

  const onOpenExisting = (entryUuid: string) => {
    setExactEntryUuid(entryUuid);
    closeCapture();
  };

  const showCapture = captureOpen && captureReady && catalogState.catalog;

  const retryTimelineReads = () => Promise.all([entryState.retry(), plotState.retry()]);
  const listBatchEntries = React.useCallback<JournalTimelineProps['listBatchEntries']>(
    (batchFilters) => journalApi.listEntries(batchFilters),
    [],
  );
  const retryCaptureEnrichment = () => groupState.error
    ? groupState.retry()
    : zonesState.mutate();
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
        ) : timelineReadError ? (
          errorCard(retryTimelineReads)
        ) : (captureRequested || captureOpen) && captureEnrichmentError ? (
          errorCard(retryCaptureEnrichment)
        ) : showCapture ? (
          <JournalCaptureFlow
            catalog={catalogState.catalog!}
            plots={capturePlots}
            plotGroups={groupState.groups}
            initialPlot={initialPlot}
            recentEntries={entryState.entries}
            initialTimezone={zoneTimezone(initialZone)}
            zoneCrops={zoneCrops}
            zoneTimezones={zoneTimezones}
            plotState={plotState}
            groupState={groupState}
            onClose={closeCapture}
            onOpenExisting={onOpenExisting}
            onSaved={onSaved}
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <label className="min-w-40 flex-1 text-sm text-[var(--text-secondary)]">
                {t('filters.plot')}
                <select
                  aria-label={t('filters.plot')}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[var(--text)]"
                  value={plotUuid}
                  onChange={(event) => {
                    setExactEntryUuid(null);
                    setPlotUuid(event.target.value);
                  }}
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
                  onChange={(event) => {
                    setExactEntryUuid(null);
                    setActivityCode(event.target.value);
                  }}
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
                ref={logActivityRef}
                type="button"
                className="btn-liquid rounded-lg px-5 py-2.5 font-bold"
                onClick={() => openCapture()}
              >
                {t('logActivity')}
              </button>
            </div>

            {timelineReadError ? errorCard(retryTimelineReads) : (
              <JournalTimeline
                entries={entryState.entries}
                plots={plotState.plots}
                loading={entryState.loading || plotState.loading}
                listBatchEntries={listBatchEntries}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};
