import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clusterMarkersByDistance, DEFAULT_CLUSTER_DISTANCE_PX } from './journalMarkerClustering';
import type { MarkerCluster } from './journalMarkerClustering';

/**
 * Pure presentational marker lane for journal entries on a history chart's
 * time axis. Receives already-fetched markers as data — it never issues a
 * journal request itself. The history-owned `useJournalMarkers` hook (see
 * `components/history/useJournalMarkers.ts`) is the single data-layer path
 * that feeds this component.
 */

export interface JournalMarkerLaneMarker {
  entryUuid: string;
  activityCode: string;
  occurredAtMs: number;
  note: string | null;
}

export interface JournalMarkerLaneProps {
  markers: JournalMarkerLaneMarker[];
  fromMs: number;
  toMs: number;
  /** Overrides automatic ResizeObserver measurement — primarily for deterministic tests/stories. */
  widthPx?: number;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}

type MarkerShape = 'circle' | 'diamond' | 'square' | 'triangle' | 'hexagon' | 'pentagon' | 'octagon';

interface MarkerStyle {
  icon: string;
  shape: MarkerShape;
  colorClass: string;
}

const LANE_HEIGHT_PX = 56;
const HIT_TARGET_PX = 48;
const SHEET_ROW_CAP = 20;

const ACTIVITY_MARKER_STYLES: Record<string, MarkerStyle> = {
  irrigation: { icon: '\u{1F4A7}', shape: 'circle', colorClass: 'bg-sky-600' }, // droplet
  fertigation: { icon: '◈', shape: 'diamond', colorClass: 'bg-violet-600' },
  fertilization: { icon: '▦', shape: 'square', colorClass: 'bg-amber-700' },
  seeding: { icon: '✦', shape: 'triangle', colorClass: 'bg-emerald-600' },
  harvest: { icon: '⌄', shape: 'hexagon', colorClass: 'bg-orange-600' },
  general_observation: { icon: '○', shape: 'pentagon', colorClass: 'bg-slate-600' },
};
const FALLBACK_MARKER_STYLE: MarkerStyle = { icon: '●', shape: 'octagon', colorClass: 'bg-gray-500' };
const CLUSTER_STYLE: Pick<MarkerStyle, 'shape' | 'colorClass'> = { shape: 'circle', colorClass: 'bg-[var(--primary)]' };

const SHAPE_CLIP_PATH: Record<MarkerShape, string | undefined> = {
  circle: 'circle(50% at 50% 50%)',
  diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
  square: undefined,
  triangle: 'polygon(50% 0%, 0% 100%, 100% 100%)',
  hexagon: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
  pentagon: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)',
  octagon: 'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)',
};

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function markerStyleFor(activityCode: string): MarkerStyle {
  return ACTIVITY_MARKER_STYLES[activityCode] ?? FALLBACK_MARKER_STYLE;
}

function activityLabel(t: HistoryTranslate, activityCode: string): string {
  return ACTIVITY_MARKER_STYLES[activityCode] ? t(`activity.${activityCode}`) : t('markers.unknownActivity');
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

function dominantActivity(cluster: MarkerCluster<JournalMarkerLaneMarker>): string | null {
  const codes = new Set(cluster.markers.map((m) => m.activityCode));
  return codes.size === 1 ? [...codes][0] : null;
}

interface MarkerSheetProps {
  cluster: MarkerCluster<JournalMarkerLaneMarker>;
  onClose: () => void;
}

const MarkerDetailsSheet: React.FC<MarkerSheetProps> = ({ cluster, onClose }) => {
  const { t: translate } = useTranslation('journal');
  const t = translate as HistoryTranslate;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sorted = useMemo(
    () => [...cluster.markers].sort((a, b) => a.occurredAtMs - b.occurredAtMs),
    [cluster.markers],
  );
  const visible = sorted.slice(0, SHEET_ROW_CAP);
  const overflowCount = sorted.length - visible.length;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="fixed inset-0 z-20 cursor-default bg-black/25"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="journal-marker-sheet-title"
        data-testid="journal-marker-sheet"
        className="fixed inset-x-3 bottom-3 z-30 mx-auto max-h-[70vh] max-w-2xl overflow-y-auto rounded-t-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl sm:inset-x-4"
        onKeyDown={handleKeyDown}
      >
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[var(--border)]" aria-hidden="true" />
        <div className="flex items-start justify-between gap-3">
          <h2 id="journal-marker-sheet-title" className="text-lg font-bold text-[var(--text)]">
            {sorted.length > 1 ? t('markers.sheet.title') : t('markers.sheet.titleSingle')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            data-testid="journal-marker-sheet-close"
            className="rounded-md border border-[var(--border)] bg-[var(--secondary-bg)] px-3 py-2 text-sm font-bold text-[var(--text)]"
            onClick={onClose}
          >
            {t('markers.sheet.close')}
          </button>
        </div>

        <ul className="mt-4 space-y-2">
          {visible.map((entry) => (
            <li key={entry.entryUuid} className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs text-white ${markerStyleFor(entry.activityCode).colorClass}`}
                >
                  {markerStyleFor(entry.activityCode).icon}
                </span>
                <span className="text-sm font-semibold text-[var(--text)]">
                  {activityLabel(t, entry.activityCode)}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                {t('markers.sheet.when')}: {formatTimestamp(entry.occurredAtMs)}
              </p>
              <p className="mt-1 text-sm text-[var(--text)]">
                {entry.note && entry.note.trim() ? entry.note : t('markers.sheet.noNote')}
              </p>
            </li>
          ))}
        </ul>

        {overflowCount > 0 && (
          <p className="mt-3 text-xs text-[var(--text-tertiary)]">
            {t('markers.sheet.overflow', { count: overflowCount })}
          </p>
        )}
      </section>
    </>
  );
};

export const JournalMarkerLane: React.FC<JournalMarkerLaneProps> = ({
  markers,
  fromMs,
  toMs,
  widthPx,
  loading = false,
  error = null,
  onRetry,
}) => {
  const { t: translate } = useTranslation('journal');
  const t = translate as HistoryTranslate;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [excludedActivityCodes, setExcludedActivityCodes] = useState<Set<string>>(() => new Set());
  const [openClusterId, setOpenClusterId] = useState<string | null>(null);

  useEffect(() => {
    if (widthPx !== undefined) return undefined;
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setMeasuredWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [widthPx]);

  const effectiveWidth = widthPx ?? measuredWidth;

  const distinctActivityCodes = useMemo(
    () => [...new Set(markers.map((m) => m.activityCode))].sort(),
    [markers],
  );

  const visibleMarkers = useMemo(
    () => markers.filter((m) => !excludedActivityCodes.has(m.activityCode)),
    [markers, excludedActivityCodes],
  );

  const clusters = useMemo(
    () => clusterMarkersByDistance(visibleMarkers, fromMs, toMs, effectiveWidth, DEFAULT_CLUSTER_DISTANCE_PX),
    [visibleMarkers, fromMs, toMs, effectiveWidth],
  );

  const openCluster = useMemo(
    () => clusters.find((cluster) => cluster.id === openClusterId) ?? null,
    [clusters, openClusterId],
  );

  const toggleActivityFilter = (code: string) => {
    setExcludedActivityCodes((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const focusSibling = (currentEntryUuid: string, direction: 1 | -1) => {
    const node = trackRef.current;
    if (!node) return;
    const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('[data-marker-kind]'));
    const index = buttons.findIndex((btn) => btn.dataset.entryUuid === currentEntryUuid);
    if (index === -1) return;
    const nextIndex = index + direction;
    buttons[nextIndex]?.focus();
  };

  const handleMarkerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    cluster: MarkerCluster<JournalMarkerLaneMarker>,
  ) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpenClusterId(cluster.id);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusSibling(cluster.markers[0].entryUuid, 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusSibling(cluster.markers[0].entryUuid, -1);
    }
  };

  const hasContent = loading || Boolean(error) || markers.length > 0;

  return (
    <section
      ref={containerRef}
      data-testid="journal-marker-lane"
      aria-label={t('markers.regionLabel')}
      className={hasContent ? 'mt-2 w-full' : 'w-full'}
    >
      {loading && (
        <p data-testid="journal-marker-lane-loading" className="text-xs text-[var(--text-tertiary)]">
          {t('markers.loading')}
        </p>
      )}

      {!loading && Boolean(error) && (
        <div data-testid="journal-marker-lane-error" className="flex items-center gap-2 text-xs text-[var(--warning-text)]">
          <span>{t('markers.error')}</span>
          <button
            type="button"
            data-testid="journal-marker-lane-retry"
            className="rounded border border-current px-2 py-0.5 font-semibold"
            onClick={() => onRetry?.()}
          >
            {t('markers.retry')}
          </button>
        </div>
      )}

      {!loading && !error && distinctActivityCodes.length > 1 && (
        <div
          role="group"
          aria-label={t('markers.filters.groupLabel')}
          className="mb-1 flex flex-wrap gap-1"
        >
          {distinctActivityCodes.map((code) => {
            const active = !excludedActivityCodes.has(code);
            return (
              <button
                key={code}
                type="button"
                data-testid={`journal-marker-filter-${code}`}
                aria-pressed={active}
                onClick={() => toggleActivityFilter(code)}
                className={`rounded-full border px-2 py-0.5 text-xs font-semibold transition-colors ${
                  active
                    ? 'border-[var(--primary)] bg-[var(--primary)] text-white'
                    : 'border-[var(--border)] bg-[var(--secondary-bg)] text-[var(--text-tertiary)]'
                }`}
              >
                {activityLabel(t, code)}
              </button>
            );
          })}
        </div>
      )}

      {!loading && !error && (
        <div
          ref={trackRef}
          data-testid="journal-marker-lane-track"
          className="relative"
          style={{ width: effectiveWidth > 0 ? effectiveWidth : '100%', height: clusters.length > 0 ? LANE_HEIGHT_PX : 0 }}
        >
          {clusters.map((cluster) => {
            const isCluster = cluster.markers.length > 1;
            const single = cluster.markers[0];
            const homogeneous = dominantActivity(cluster);
            const style = isCluster
              ? { ...CLUSTER_STYLE, icon: String(cluster.markers.length) }
              : markerStyleFor(single.activityCode);
            const activityAttr = isCluster ? (homogeneous ?? 'mixed') : single.activityCode;
            const ariaLabel = isCluster
              ? t('markers.clusterLabel', { count: cluster.markers.length, date: formatTimestamp(single.occurredAtMs) })
              : t('markers.entryLabel', {
                  activity: activityLabel(t, single.activityCode),
                  date: formatTimestamp(single.occurredAtMs),
                });

            return (
              <button
                key={cluster.id}
                type="button"
                data-marker-kind={isCluster ? 'cluster' : 'single'}
                data-shape={style.shape}
                data-activity={activityAttr}
                data-count={cluster.markers.length}
                data-entry-uuid={single.entryUuid}
                aria-label={ariaLabel}
                aria-haspopup="dialog"
                onClick={() => setOpenClusterId(cluster.id)}
                onKeyDown={(event) => handleMarkerKeyDown(event, cluster)}
                className={`absolute rounded-full ${style.colorClass} text-white shadow focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--primary)]`}
                style={{
                  width: HIT_TARGET_PX,
                  height: HIT_TARGET_PX,
                  left: Math.max(0, Math.min(cluster.xPx - HIT_TARGET_PX / 2, effectiveWidth - HIT_TARGET_PX)),
                  top: '50%',
                  transform: 'translateY(-50%)',
                }}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-2.5 flex items-center justify-center bg-black/20 text-[11px] font-bold leading-none"
                  style={{ clipPath: SHAPE_CLIP_PATH[style.shape] }}
                >
                  {style.icon}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {openCluster && (
        <MarkerDetailsSheet cluster={openCluster} onClose={() => setOpenClusterId(null)} />
      )}
    </section>
  );
};
