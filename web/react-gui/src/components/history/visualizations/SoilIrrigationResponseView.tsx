import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryCardDataResponse, HistoryEvent, HistoryInterpretation } from '../../../history/types';

interface SoilIrrigationResponseViewProps {
  data: HistoryCardDataResponse | undefined;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function looksLikeRawSourceToken(value: string): boolean {
  return /\b[0-9a-f]{16}\b/i.test(value)
    || /\b(dev[\s_-]?eui|device[\s_-]?eui|payload|firmware|rssi|snr|raw)\b/i.test(value);
}

function safeEventLabel(t: HistoryTranslate, event: HistoryEvent): string {
  const label = normalizedText(event.label);
  if (label && !looksLikeRawSourceToken(label)) return label;
  return t('history.soilIrrigationResponse.eventFallback');
}

function responseText(t: HistoryTranslate, event: HistoryEvent): string | null {
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const observed = normalizedText(metadata.observedResponse);
  if (observed && !looksLikeRawSourceToken(observed)) return observed;
  const duration = typeof metadata.durationMinutes === 'number' && Number.isFinite(metadata.durationMinutes)
    ? metadata.durationMinutes
    : null;
  if (duration !== null) return t('history.soilIrrigationResponse.duration', { value: duration });
  return null;
}

function interpretationLabel(interpretation: HistoryInterpretation): string | null {
  return normalizedText(interpretation.title) ?? normalizedText(interpretation.body);
}

export const SoilIrrigationResponseView: React.FC<SoilIrrigationResponseViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const events = (Array.isArray(data?.events) ? data.events : [])
    .filter((event) => String(event.type || '').toLowerCase().includes('irrigation') || isRecord(event.metadata));
  const interpretations = (Array.isArray(data?.interpretations) ? data.interpretations : [])
    .map(interpretationLabel)
    .filter((label): label is string => Boolean(label && !looksLikeRawSourceToken(label)));

  if (events.length === 0 && interpretations.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.soilIrrigationResponse.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.soilIrrigationResponse.emptyTitle')}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          {t('history.soilIrrigationResponse.emptyBody')}
        </p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.soilIrrigationResponse.title')}
      className="mt-4 space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.soilIrrigationResponse.title')}
        </h3>
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('history.soilIrrigationResponse.eventsCount', { count: events.length })}
        </p>
      </div>

      {events.length > 0 && (
        <ol className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-sm font-semibold text-[var(--text)]">{safeEventLabel(t, event)}</p>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">{formatTimestamp(event.t)}</p>
              {responseText(t, event) && (
                <p className="mt-2 text-sm text-[var(--text)]">{responseText(t, event)}</p>
              )}
            </li>
          ))}
        </ol>
      )}

      {interpretations.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text)]">
            {t('history.soilIrrigationResponse.interpretationsTitle')}
          </h4>
          {interpretations.map((label, index) => (
            <p key={`${label}-${index}`} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]">
              {label}
            </p>
          ))}
        </div>
      )}
    </section>
  );
};
