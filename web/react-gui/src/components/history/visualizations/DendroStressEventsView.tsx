import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryCardDataResponse, HistoryEvent, HistoryInterpretation } from '../../../history/types';

interface DendroStressEventsViewProps {
  data: HistoryCardDataResponse | undefined;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

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
  return (
    /dendro-src-/i.test(value)
    || /\b[0-9a-f]{16}\b/i.test(value)
    || /\b(dev[\s_-]?eui|device[\s_-]?eui|payload|firmware|rssi|snr|raw|adc)\b/i.test(value)
  );
}

function safeEventLabel(t: HistoryTranslate, event: HistoryEvent): string {
  const label = normalizedText(event.label);
  if (label && !looksLikeRawSourceToken(label)) return label;
  const type = String(event.type || '').toLowerCase();
  if (type.includes('recovery')) return t('history.dendroStressEvents.event.incompleteRecovery');
  if (type.includes('shrink')) return t('history.dendroStressEvents.event.shrinkage');
  return t('history.dendroStressEvents.event.stress');
}

function tone(event: Pick<HistoryEvent, 'severity'>): string {
  if (event.severity === 'critical') return 'border-red-300 bg-red-50 text-red-900';
  if (event.severity === 'warning') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (event.severity === 'success') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  return 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]';
}

function isDendroStressInterpretation(interpretation: HistoryInterpretation): boolean {
  const haystack = [
    interpretation.id,
    interpretation.ruleId,
    interpretation.titleKey,
    interpretation.bodyKey,
    interpretation.title,
    interpretation.body,
    interpretation.evidence?.map((item) => [item.type, item.seriesId, item.status].filter(Boolean).join(' ')).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
  return /dendro|stem|shrink|stress|recovery|growth/.test(haystack);
}

function interpretationLabel(interpretation: HistoryInterpretation): string | null {
  return normalizedText(interpretation.title) ?? normalizedText(interpretation.body);
}

export const DendroStressEventsView: React.FC<DendroStressEventsViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const events = Array.isArray(data?.events) ? data.events : [];
  const interpretations = (Array.isArray(data?.interpretations) ? data.interpretations : [])
    .filter(isDendroStressInterpretation)
    .map(interpretationLabel)
    .filter((label): label is string => Boolean(label && !looksLikeRawSourceToken(label)));

  if (events.length === 0 && interpretations.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.dendroStressEvents.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.dendroStressEvents.emptyTitle')}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          {t('history.dendroStressEvents.emptyBody')}
        </p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.dendroStressEvents.title')}
      className="mt-4 space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.dendroStressEvents.title')}
        </h3>
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('history.dendroStressEvents.eventsCount', { count: events.length })}
        </p>
      </div>

      {events.length > 0 && (
        <ol className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className={`rounded-md border px-3 py-2 text-sm ${tone(event)}`}>
              <span className="font-semibold">{safeEventLabel(t, event)}</span>
              <span className="ml-2 text-xs opacity-75">{formatTimestamp(event.t)}</span>
            </li>
          ))}
        </ol>
      )}

      {interpretations.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-[var(--text)]">
            {t('history.dendroStressEvents.interpretationsTitle')}
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
