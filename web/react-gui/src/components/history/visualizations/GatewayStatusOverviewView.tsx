import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  HistoryCardDataResponse,
  HistoryCardSummary,
  HistoryEvent,
  HistoryMetricStatus,
  HistorySeries,
  HistorySeriesPoint,
  HistorySyncState,
} from '../../../history/types';

interface GatewayStatusOverviewViewProps {
  card: HistoryCardSummary;
  data: HistoryCardDataResponse | undefined;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type StatusCategory = 'connectivity' | 'storage' | 'system';
type MetricKey =
  | 'signal'
  | 'storage'
  | 'memory'
  | 'cpu'
  | 'temperature';

interface StatusItem {
  id: string;
  category: StatusCategory;
  metric: MetricKey;
  value: string;
  sortOrder: number;
}

interface FieldCandidate {
  key: string;
  value: unknown;
  unit: string | null;
}

const RAW_IDENTIFIER_PATTERN = /\b[a-f0-9]{16}\b/i;
const UNSAFE_FIELD_PATTERN =
  /(dev_?eui|device_?eui|gateway_?eui|\beui\b|channel|payload|raw|firmware|uci|token|secret|calibration|coefficient|rssi|snr|spreading|frequency|freq|bytes?|lsn50|kiwi|strega|pending|command|battery|voltage|fan|power|uptime|reboot)/i;

const CATEGORY_ORDER: Record<StatusCategory, number> = {
  connectivity: 10,
  storage: 20,
  system: 30,
};
const KNOWN_SYNC_STATES = new Set(['local', 'synced', 'stale', 'degraded', 'unknown']);

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStatus(value: unknown): string | null {
  const status = normalizeText(value);
  return status && status.toLowerCase() !== 'unknown' ? status : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnsafeText(value: string): boolean {
  return RAW_IDENTIFIER_PATTERN.test(value) || UNSAFE_FIELD_PATTERN.test(value);
}

function isSafeDisplayText(value: string): boolean {
  return Boolean(value.trim()) && !isUnsafeText(value);
}

function humanizeStatus(status: string): string {
  return status
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function formatStatus(t: HistoryTranslate, status: string): string {
  const normalized = status.toLowerCase();
  return t(`history.gatewayStatus.status.${normalized}`, { defaultValue: humanizeStatus(status) });
}

function formatSyncState(t: HistoryTranslate, value: HistorySyncState): string {
  return t(`history.metadata.syncState.${value}`);
}

function normalizeSyncState(value: unknown): HistorySyncState {
  return typeof value === 'string' && KNOWN_SYNC_STATES.has(value) ? value as HistorySyncState : 'unknown';
}

function formatTimestamp(t: HistoryTranslate, value: unknown): string {
  const timestamp = normalizeText(value);
  if (!timestamp || isUnsafeText(timestamp)) return t('history.gatewayStatus.value.unavailable');

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return t('history.gatewayStatus.value.unavailable');

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 10 ? 1 : 0);
}

function formatMetricValue(t: HistoryTranslate, value: unknown, unit: string | null): string | null {
  const numericValue = normalizeFiniteNumber(value);
  if (numericValue !== null) {
    return unit ? `${formatNumber(numericValue)} ${unit}` : formatNumber(numericValue);
  }

  if (typeof value === 'boolean') return value ? formatStatus(t, 'online') : formatStatus(t, 'offline');

  const textValue = normalizeText(value);
  if (!textValue || !isSafeDisplayText(textValue)) return null;
  return formatStatus(t, textValue);
}

function isFarmerFacingSignalUnit(unit: string | null): boolean {
  const normalized = unit?.toLowerCase() ?? '';
  return normalized === '%' || normalized.includes('percent') || normalized.includes('bar');
}

function metricStatusValue(t: HistoryTranslate, metricStatus: HistoryMetricStatus | undefined, metric: MetricKey): string | null {
  if (!metricStatus || !isObjectRecord(metricStatus)) return null;

  if (metric !== 'signal') {
    const metricValue = formatMetricValue(t, metricStatus.latest, normalizeText(metricStatus.unit));
    if (metricValue) return metricValue;
  }

  const status = normalizeStatus(metricStatus.status);
  if (status) return formatStatus(t, status);

  if (metric === 'signal' && !isFarmerFacingSignalUnit(normalizeText(metricStatus.unit))) return null;

  return formatMetricValue(t, metricStatus.latest, normalizeText(metricStatus.unit));
}

function latestPointValue(point: Partial<HistorySeriesPoint> | null | undefined): unknown {
  if (!point) return null;
  return point.value ?? point.latest ?? point.mean ?? point.median ?? null;
}

function latestSeriesValue(series: Partial<HistorySeries> | null | undefined): FieldCandidate | null {
  if (!series || !Array.isArray(series.points)) return null;

  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const value = latestPointValue(series.points[index]);
    if (normalizeFiniteNumber(value) !== null || normalizeText(value)) {
      return {
        key: `${series.id ?? ''} ${series.label ?? ''}`,
        value,
        unit: normalizeText(series.unit ?? series.points[index]?.unit),
      };
    }
  }

  return null;
}

function classifyField(key: string): { category: StatusCategory; metric: MetricKey } | null {
  const normalized = key.toLowerCase().replace(/[_-]+/g, ' ');
  if (!normalized.trim() || UNSAFE_FIELD_PATTERN.test(normalized)) return null;

  if (normalized.includes('storage') || normalized.includes('disk') || normalized.includes('rootfs')) {
    return { category: 'storage', metric: 'storage' };
  }
  if (normalized.includes('network') || normalized.includes('connect') || normalized.includes('online') || normalized.includes('internet')) {
    return { category: 'connectivity', metric: 'signal' };
  }
  if (normalized.includes('mem')) return { category: 'system', metric: 'memory' };
  if (normalized.includes('cpu') && normalized.includes('temp')) return { category: 'system', metric: 'temperature' };
  if (normalized.includes('cpu')) return { category: 'system', metric: 'cpu' };

  return null;
}

function addStatusItem(items: Map<string, StatusItem>, item: Omit<StatusItem, 'id' | 'sortOrder'>): void {
  const id = `${item.category}:${item.metric}`;
  if (items.has(id)) return;
  items.set(id, {
    ...item,
    id,
    sortOrder: CATEGORY_ORDER[item.category],
  });
}

function buildStatusItems(t: HistoryTranslate, card: HistoryCardSummary, data: HistoryCardDataResponse | undefined): StatusItem[] {
  const items = new Map<string, StatusItem>();

  const signalValue = metricStatusValue(t, card.metadata.signal, 'signal');
  if (signalValue) {
    addStatusItem(items, { category: 'connectivity', metric: 'signal', value: signalValue });
  }

  const seriesCandidates = (Array.isArray(data?.series) ? data.series : [])
    .map(latestSeriesValue)
    .filter((candidate): candidate is FieldCandidate => candidate !== null);

  seriesCandidates.forEach((candidate) => {
    const classification = classifyField(candidate.key);
    if (!classification) return;

    const value = formatMetricValue(t, candidate.value, candidate.unit);
    if (!value) return;
    addStatusItem(items, { ...classification, value });
  });

  return [...items.values()].sort((left, right) => left.sortOrder - right.sortOrder || left.metric.localeCompare(right.metric));
}

function eventTone(event: HistoryEvent): string {
  if (event.severity === 'warning') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (event.severity === 'critical') return 'border-red-300 bg-red-50 text-red-900';
  if (event.severity === 'success') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  return 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]';
}

function eventLabel(t: HistoryTranslate, event: Partial<HistoryEvent>): string {
  const label = normalizeText(event.label);
  const type = normalizeText(event.type);
  return label && isSafeDisplayText(label) && (!type || !isUnsafeText(type))
    ? label
    : t('history.gatewayStatus.eventFallback');
}

function safeEvents(data: HistoryCardDataResponse | undefined): HistoryEvent[] {
  return Array.isArray(data?.events) ? data.events.slice(0, 3) : [];
}

export const GatewayStatusOverviewView: React.FC<GatewayStatusOverviewViewProps> = ({ card, data }) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const statusItems = buildStatusItems(t, card, data);
  const events = safeEvents(data);
  const syncState = normalizeSyncState(data?.freshness?.syncState ?? card.metadata.syncState);

  return (
    <section
      role="region"
      aria-label={t('history.gatewayStatus.title')}
      className="mt-4 space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4 sm:p-5"
    >
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">{t('history.gatewayStatus.title')}</h3>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('history.gatewayStatus.lastSeen')}
          </p>
          <p className="mt-1 text-sm font-semibold text-[var(--text)]">
            {formatTimestamp(t, card.metadata.lastSeenAt)}
          </p>
        </div>
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('history.gatewayStatus.dataAsOf')}
          </p>
          <p className="mt-1 text-sm font-semibold text-[var(--text)]">
            {formatTimestamp(t, data?.freshness?.dataAsOf)}
          </p>
        </div>
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {t('history.gatewayStatus.syncState')}
          </p>
          <p className="mt-1 text-sm font-semibold text-[var(--text)]">{formatSyncState(t, syncState)}</p>
        </div>
      </div>

      {statusItems.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {statusItems.map((item) => (
            <div key={item.id} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {t(`history.gatewayStatus.category.${item.category}`)}
              </p>
              <p className="mt-2 text-sm font-semibold text-[var(--text)]">
                {t(`history.gatewayStatus.metric.${item.metric}`)}
              </p>
              <p className="mt-1 text-base font-bold text-[var(--text)]">{item.value}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold text-[var(--text)]">{t('history.gatewayStatus.emptyTitle')}</p>
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">{t('history.gatewayStatus.emptyBody')}</p>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-[var(--text)]">{t('history.gatewayStatus.eventsTitle')}</h4>
        {events.length > 0 ? (
          <ol className="mt-2 space-y-2">
            {events.map((event, index) => (
              <li key={event.id || `gateway-event-${index}`} className={`rounded-md border px-3 py-2 text-sm ${eventTone(event)}`}>
                <span className="font-semibold">{eventLabel(t, event)}</span>
                <span className="ml-2 text-xs opacity-75">{formatTimestamp(t, event.t)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-[var(--text-tertiary)]">{t('history.gatewayStatus.noEvents')}</p>
        )}
      </div>
    </section>
  );
};
