import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatHistorySourceLabel } from '../../../history/sourceLabels';
import type {
  HistoryCalendarDay,
  HistoryCalendarMarker,
  HistoryCardDataResponse,
  HistoryCardSummary,
  HistoryInterpretation,
} from '../../../history/types';
import { InterpretationList } from '../InterpretationList';

export type HistoryInspectorSelection =
  | { kind: 'timestamp'; timestamp: string }
  | { kind: 'date'; date: string; day: HistoryCalendarDay | null };

interface HistoryInspectorSheetProps {
  card: HistoryCardSummary;
  data: HistoryCardDataResponse | undefined;
  selection: HistoryInspectorSelection | null;
  isOpen: boolean;
  onClose: () => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function translateParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return params && typeof params === 'object' ? params : {};
}

function calendarStateLabel(t: HistoryTranslate, day: HistoryCalendarDay): string {
  return t(`history.calendar.state.${day.state}`);
}

function calendarSummaryLabel(t: HistoryTranslate, card: HistoryCardSummary, day: HistoryCalendarDay): string {
  if (day.summary?.key) return t(day.summary.key, translateParams(day.summary.params));
  return t(`history.calendar.summary.${card.cardType}.${day.state}`, translateParams(day.metrics));
}

function calendarCoverageLabel(t: HistoryTranslate, day: HistoryCalendarDay): string {
  if (day.coveragePct === null || day.coveragePct === undefined) return t('history.metadata.coverageUnknown');
  return t('history.metadata.coverageKnown', { coverage: Math.round(day.coveragePct) });
}

function calendarMarkerLabel(t: HistoryTranslate, marker: HistoryCalendarMarker): string {
  return t(marker.labelKey, translateParams(marker.params));
}

function formatTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed).toLocaleString();
}

function formatSyncState(t: HistoryTranslate, syncState: string | undefined): string {
  return t(`history.metadata.syncState.${syncState ?? 'unknown'}`);
}

function formatCoverage(t: HistoryTranslate, data: HistoryCardDataResponse | undefined): string {
  const coveragePct = data?.aggregation.coveragePct;
  if (coveragePct === null || coveragePct === undefined) return t('history.metadata.coverageUnknown');
  return t('history.metadata.coverageKnown', { coverage: Math.round(coveragePct) });
}

function selectInterpretations(data: HistoryCardDataResponse | undefined): readonly HistoryInterpretation[] {
  return Array.isArray(data?.interpretations) ? data.interpretations : [];
}

export const HistoryInspectorSheet: React.FC<HistoryInspectorSheetProps> = ({
  card,
  data,
  selection,
  isOpen,
  onClose,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const sourceLabel = formatHistorySourceLabel(t, card);
  const interpretations = useMemo(() => selectInterpretations(data), [data]);
  const visibleEvents = useMemo(() => (data?.events ?? []).slice(0, 4), [data?.events]);

  useEffect(() => {
    if (!isOpen) return;
    closeButtonRef.current?.focus();
  }, [isOpen]);

  if (!isOpen || !selection) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 px-3 pb-3 sm:px-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-inspector-title"
        className="mx-auto max-h-[70vh] max-w-2xl overflow-y-auto rounded-t-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl"
      >
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[var(--border)]" aria-hidden="true" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
              {t('history.inspector.context')}
            </p>
            <h2 id="history-inspector-title" className="text-lg font-bold text-[var(--text)]">
              {t('history.inspector.title')}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-sm font-bold text-[var(--text)]"
            onClick={onClose}
          >
            {t('history.inspector.close')}
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
            {selection.kind === 'timestamp' ? (
              <>
                <p className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
                  {t('history.inspector.timestamp')}
                </p>
                <p className="mt-1 break-words text-base font-bold text-[var(--text)]">
                  {formatTimestamp(selection.timestamp)}
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
                  {t('history.inspector.date')}
                </p>
                <p className="mt-1 break-words text-base font-bold text-[var(--text)]">{selection.date}</p>
                {selection.day ? (
                  <div className="mt-2 space-y-1 text-sm text-[var(--text)]">
                    <p className="font-semibold">{calendarStateLabel(t, selection.day)}</p>
                    <p>{calendarSummaryLabel(t, card, selection.day)}</p>
                    <p className="text-[var(--text-tertiary)]">{calendarCoverageLabel(t, selection.day)}</p>
                    {selection.day.markers && selection.day.markers.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {selection.day.markers.map((marker, index) => (
                          <span
                            key={`${marker.type}-${marker.labelKey}-${index}`}
                            className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-semibold"
                          >
                            {calendarMarkerLabel(t, marker)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-sm font-semibold text-[var(--text-tertiary)]">
                    {t('history.calendar.state.no_data')}
                  </p>
                )}
              </>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
              <dt className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
                {t('history.inspector.source')}
              </dt>
              <dd className="mt-1 break-words font-semibold text-[var(--text)]">
                {sourceLabel ?? t(`history.cardType.${card.cardType}`)}
              </dd>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
              <dt className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
                {t('history.inspector.coverage')}
              </dt>
              <dd className="mt-1 font-semibold text-[var(--text)]">{formatCoverage(t, data)}</dd>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
              <dt className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
                {t('history.inspector.syncState')}
              </dt>
              <dd className="mt-1 font-semibold text-[var(--text)]">
                {formatSyncState(t, data?.freshness.syncState)}
              </dd>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
              <dt className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
                {t('history.inspector.dataAsOf')}
              </dt>
              <dd className="mt-1 break-words font-semibold text-[var(--text)]">
                {data?.freshness.dataAsOf ? formatTimestamp(data.freshness.dataAsOf) : t('history.advanced.value.unavailable')}
              </dd>
            </div>
          </dl>

          {visibleEvents.length > 0 && (
            <section aria-label={t('history.inspector.events')} className="space-y-2">
              <h3 className="text-sm font-bold text-[var(--text)]">{t('history.inspector.events')}</h3>
              <div className="space-y-2">
                {visibleEvents.map((event) => (
                  <div key={event.id} className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
                    <p className="text-sm font-semibold text-[var(--text)]">{event.label}</p>
                    <p className="text-xs text-[var(--text-tertiary)]">{formatTimestamp(event.t)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {interpretations.length > 0 ? (
            <InterpretationList interpretations={interpretations} />
          ) : (
            <p className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text-tertiary)]">
              {t('history.inspector.noInterpretation')}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};
