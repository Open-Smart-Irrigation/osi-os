import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  HistoryCardDataResponse,
  HistoryEvent,
} from '../../../history/types';

interface IrrigationEventTimelineViewProps {
  data: HistoryCardDataResponse | undefined;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type IrrigationSeverity = HistoryEvent['severity'];

interface RenderableIrrigationEvent {
  renderKey: string;
  label: string;
  timestamp: string;
  timestampMs: number;
  timestampLabel: string;
  severity: IrrigationSeverity;
  details: string[];
}

const DEVICE_EUI_PATTERN = /\b[A-F0-9]{16}\b/i;
const UNSAFE_LABEL_PATTERN =
  /raw|src-|source|deveui|deviceeui|device_eui|channel|backend|payload|firmware|rssi|snr|pending|command/i;
const SEVERITIES: readonly IrrigationSeverity[] = ['info', 'warning', 'critical', 'success', 'unknown'];

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeMetadata(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function parseTimestamp(value: unknown): { iso: string; ms: number } | null {
  const timestamp = normalizeText(value);
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  if (!Number.isFinite(ms)) return null;
  return { iso: timestamp, ms };
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function metadataNumber(metadata: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = normalizeFiniteNumber(metadata[key]);
    if (value !== null) return value;
  }
  return null;
}

function durationMinutesFromEvent(event: HistoryEvent, metadata: Record<string, unknown>): number | null {
  const explicitMinutes = metadataNumber(metadata, ['durationMinutes', 'duration_minutes', 'commandedDurationMinutes']);
  if (explicitMinutes !== null) return explicitMinutes;

  const explicitSeconds = metadataNumber(metadata, ['durationSeconds', 'duration_seconds', 'commandedDurationSeconds']);
  if (explicitSeconds !== null) return explicitSeconds / 60;

  const explicitMs = metadataNumber(metadata, ['durationMs', 'duration_ms']);
  if (explicitMs !== null) return explicitMs / 60000;

  const start = parseTimestamp(event.t);
  const end = parseTimestamp(event.end);
  if (!start || !end || end.ms <= start.ms) return null;
  return (end.ms - start.ms) / 60000;
}

function responseWindowMinutesFromMetadata(metadata: Record<string, unknown>): number | null {
  const minutes = metadataNumber(metadata, [
    'responseWindowMinutes',
    'response_window_minutes',
    'expectedResponseWindowMinutes',
    'expected_response_window_minutes',
    'windowMinutes',
    'window_minutes',
  ]);
  if (minutes !== null) return minutes;

  const seconds = metadataNumber(metadata, [
    'responseWindowSeconds',
    'response_window_seconds',
    'expectedResponseWindowSeconds',
    'expected_response_window_seconds',
    'windowSeconds',
    'window_seconds',
  ]);
  if (seconds !== null) return seconds / 60;

  const hours = metadataNumber(metadata, [
    'responseWindowHours',
    'response_window_hours',
    'expectedResponseWindowHours',
    'expected_response_window_hours',
    'windowHours',
    'window_hours',
  ]);
  if (hours !== null) return hours * 60;

  return null;
}

function formatDuration(minutes: number): string {
  const roundedMinutes = Math.round(minutes);
  if (roundedMinutes < 60) return `${roundedMinutes} min`;
  if (roundedMinutes % 60 === 0) return `${roundedMinutes / 60} h`;
  return `${Number((roundedMinutes / 60).toFixed(1))} h`;
}

function safePhrase(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text || DEVICE_EUI_PATTERN.test(text) || UNSAFE_LABEL_PATTERN.test(text)) return null;
  const phrase = text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return phrase || null;
}

function isSafeLabel(label: string): boolean {
  return !label.includes('_')
    && !DEVICE_EUI_PATTERN.test(label)
    && !UNSAFE_LABEL_PATTERN.test(label);
}

function eventClue(event: HistoryEvent, metadata: Record<string, unknown>): string {
  return [
    normalizeText(event.type),
    normalizeText(event.label),
    safePhrase(metadata.source),
    safePhrase(metadata.category),
    safePhrase(metadata.action),
    safePhrase(metadata.outcome),
    safePhrase(metadata.status),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function displayEventLabel(t: HistoryTranslate, event: HistoryEvent, metadata: Record<string, unknown>): string {
  const explicitLabel = normalizeText(event.label);
  if (explicitLabel && isSafeLabel(explicitLabel)) return explicitLabel;

  const clue = eventClue(event, metadata);
  if (clue.includes('manual') || clue.includes('override')) {
    return t('history.irrigationTimeline.eventLabel.manualOverride');
  }
  if (clue.includes('ineffective') || clue.includes('no response') || clue.includes('failed')) {
    return t('history.irrigationTimeline.eventLabel.possibleIneffective');
  }
  if (clue.includes('response') || clue.includes('window')) {
    return t('history.irrigationTimeline.eventLabel.responseWindow');
  }
  if (clue.includes('schedule') || clue.includes('scheduled')) {
    return t('history.irrigationTimeline.eventLabel.scheduled');
  }
  return t('history.irrigationTimeline.eventLabel.irrigation');
}

function normalizeSeverity(severity: unknown): IrrigationSeverity {
  return SEVERITIES.includes(severity as IrrigationSeverity)
    ? severity as IrrigationSeverity
    : 'unknown';
}

function severityTone(severity: IrrigationSeverity): string {
  if (severity === 'warning') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (severity === 'critical') return 'border-red-300 bg-red-50 text-red-900';
  if (severity === 'success') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  return 'border-[var(--border)] bg-[var(--secondary-bg)] text-[var(--text)]';
}

function markerTone(severity: IrrigationSeverity): string {
  if (severity === 'warning') return 'bg-amber-500 ring-amber-100';
  if (severity === 'critical') return 'bg-red-600 ring-red-100';
  if (severity === 'success') return 'bg-emerald-600 ring-emerald-100';
  return 'bg-sky-600 ring-sky-100';
}

function normalizeEvent(
  t: HistoryTranslate,
  event: Partial<HistoryEvent> | null | undefined,
  index: number,
): RenderableIrrigationEvent | null {
  if (!event) return null;
  const parsedTimestamp = parseTimestamp(event.t);
  if (!parsedTimestamp) return null;

  const metadata = normalizeMetadata(event.metadata);
  const details: string[] = [];
  const durationMinutes = durationMinutesFromEvent(event as HistoryEvent, metadata);
  const responseWindowMinutes = responseWindowMinutesFromMetadata(metadata);
  const observedResponse = safePhrase(metadata.observedResponse ?? metadata.observed_response ?? metadata.responseStatus ?? metadata.response_status ?? metadata.outcome);

  if (durationMinutes !== null && durationMinutes > 0) {
    details.push(t('history.irrigationTimeline.detail.duration', { value: formatDuration(durationMinutes) }));
  }
  if (responseWindowMinutes !== null && responseWindowMinutes > 0) {
    details.push(t('history.irrigationTimeline.detail.responseWindow', { value: formatDuration(responseWindowMinutes) }));
  }
  if (observedResponse) {
    details.push(t('history.irrigationTimeline.detail.observedResponse', { value: observedResponse }));
  }

  const normalizedEvent = {
    ...event,
    id: normalizeText(event.id) ?? `event-${index}`,
    type: normalizeText(event.type) ?? 'irrigation',
    t: parsedTimestamp.iso,
    label: normalizeText(event.label) ?? '',
    severity: normalizeSeverity(event.severity),
    metadata,
  } as HistoryEvent;

  return {
    renderKey: normalizedEvent.id,
    label: displayEventLabel(t, normalizedEvent, metadata),
    timestamp: parsedTimestamp.iso,
    timestampMs: parsedTimestamp.ms,
    timestampLabel: formatTimestamp(parsedTimestamp.iso),
    severity: normalizedEvent.severity,
    details,
  };
}

function normalizeEvents(t: HistoryTranslate, data: HistoryCardDataResponse | undefined): RenderableIrrigationEvent[] {
  const events = Array.isArray(data?.events) ? data.events : [];
  return events
    .map((event, index) => normalizeEvent(t, event, index))
    .filter((event): event is RenderableIrrigationEvent => event !== null)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

export const IrrigationEventTimelineView: React.FC<IrrigationEventTimelineViewProps> = ({ data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const events = normalizeEvents(t, data);

  if (events.length === 0) {
    return (
      <section
        role="region"
        aria-label={t('history.irrigationTimeline.title')}
        className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6"
      >
        <h3 className="text-base font-semibold text-[var(--text)]">
          {t('history.irrigationTimeline.emptyTitle')}
        </h3>
        <p className="mt-2 text-sm text-[var(--text-tertiary)]">
          {t('history.irrigationTimeline.emptyBody')}
        </p>
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={t('history.irrigationTimeline.title')}
      className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">
            {t('history.irrigationTimeline.title')}
          </h3>
          <p className="text-sm text-[var(--text-tertiary)]">
            {t('history.irrigationTimeline.eventsCount', { count: events.length })}
          </p>
        </div>
      </div>

      <ol className="mt-4 space-y-3">
        {events.map((event) => (
          <li key={event.renderKey} className="relative pl-7">
            <span
              aria-hidden="true"
              className={`absolute left-0 top-4 h-3 w-3 rounded-full ring-4 ${markerTone(event.severity)}`}
            />
            <article className={`rounded-md border px-3 py-3 text-sm ${severityTone(event.severity)}`}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h4 className="break-words font-semibold">{event.label}</h4>
                  <time dateTime={event.timestamp} className="mt-1 block text-xs opacity-75">
                    {event.timestampLabel}
                  </time>
                </div>
                <span className="w-fit rounded-full border border-current px-2 py-0.5 text-xs font-semibold">
                  {t(`history.irrigationTimeline.severity.${event.severity}`)}
                </span>
              </div>
              {event.details.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {event.details.map((detail) => (
                    <span
                      key={detail}
                      className="rounded-md border border-current/30 bg-white/50 px-2 py-1 text-xs font-medium"
                    >
                      {detail}
                    </span>
                  ))}
                </div>
              )}
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
};
