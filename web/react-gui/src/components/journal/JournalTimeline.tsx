import React from 'react';
import { useTranslation } from 'react-i18next';

import type { EntryAggregate, JournalPlot } from '../../types/journal';
import { hydrateBatchMembership, type BatchMembershipPage } from '../../journal/hydrateBatchMembership';
import { JournalEntryRow } from './JournalEntryRow';

export type JournalTimelineItem =
  | { kind: 'entry'; entry: EntryAggregate }
  | {
      kind: 'batch';
      batchUuid: string;
      entries: EntryAggregate[];
      count: number;
      activityCode: string;
      cropSummary: string | null;
    };

function normalizeCropSummary(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function summarizeBatchEntries(entries: readonly EntryAggregate[]): {
  activityCode: string;
  cropSummary: string | null;
} {
  const first = entries[0];
  if (!first) return { activityCode: '', cropSummary: null };

  const activityCode = entries.every((entry) => entry.activity_code === first.activity_code)
    ? first.activity_code
    : '';
  const cropValues = entries.map((entry) => normalizeCropSummary(entry.season_crop));
  const firstCrop = cropValues[0];
  const cropSummary = cropValues.every((crop) => crop === firstCrop) ? firstCrop : null;

  return { activityCode, cropSummary };
}

export function groupJournalTimelineEntries(
  entries: readonly EntryAggregate[],
): JournalTimelineItem[] {
  const items: JournalTimelineItem[] = [];
  const batches = new Map<string, Extract<JournalTimelineItem, { kind: 'batch' }>>();

  for (const entry of entries) {
    if (typeof entry.batch_uuid !== 'string' || entry.batch_uuid.trim() === '') {
      items.push({ kind: 'entry', entry });
      continue;
    }

    const existing = batches.get(entry.batch_uuid);
    if (existing) {
      existing.entries.push(entry);
      existing.count += 1;
      Object.assign(existing, summarizeBatchEntries(existing.entries));
      continue;
    }

    const batch: Extract<JournalTimelineItem, { kind: 'batch' }> = {
      kind: 'batch',
      batchUuid: entry.batch_uuid,
      entries: [entry],
      count: 1,
      ...summarizeBatchEntries([entry]),
    };
    batches.set(entry.batch_uuid, batch);
    items.push(batch);
  }

  return items;
}

export interface JournalTimelineProps {
  entries: EntryAggregate[];
  plots: JournalPlot[];
  loading: boolean;
  listBatchEntries: (filters: {
    batch_uuid: string;
    status: 'all';
    limit: 100;
    cursor?: string;
  }) => Promise<BatchMembershipPage>;
}

type BatchHydrationState = {
  status: 'loading' | 'ready' | 'error';
  entries?: EntryAggregate[];
  error?: unknown;
};

type HydrationRequestToken = {
  generation: number;
  id: number;
};

export const JournalTimeline: React.FC<JournalTimelineProps> = ({
  entries,
  plots,
  loading,
  listBatchEntries,
}) => {
  const { t } = useTranslation('journal');
  const [expandedBatches, setExpandedBatches] = React.useState<Set<string>>(() => new Set());
  const [hydration, setHydration] = React.useState<Record<string, BatchHydrationState>>({});
  const hydrationRef = React.useRef(hydration);
  const expandedRef = React.useRef(expandedBatches);
  const inFlight = React.useRef(new Map<string, HydrationRequestToken>());
  const generation = React.useRef(0);
  const requestId = React.useRef(0);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const items = React.useMemo(() => groupJournalTimelineEntries(entries), [entries]);
  const activeBatchUuids = React.useMemo(() => new Set(
    items.flatMap((item) => item.kind === 'batch' ? [item.batchUuid] : []),
  ), [items]);
  const activeBatchUuidsRef = React.useRef(activeBatchUuids);
  activeBatchUuidsRef.current = activeBatchUuids;

  const plotLabels = new Map(plots.map((plot) => [
    plot.plot_uuid,
    plot.name?.trim() || plot.plot_code,
  ]));

  const startHydration = React.useCallback((batchUuid: string) => {
    if (!activeBatchUuidsRef.current.has(batchUuid) || inFlight.current.has(batchUuid)) return;
    const token: HydrationRequestToken = {
      generation: generation.current,
      id: requestId.current += 1,
    };
    inFlight.current.set(batchUuid, token);
    setHydration((current) => {
      const next: Record<string, BatchHydrationState> = {
      ...current,
      [batchUuid]: { status: 'loading', entries: current[batchUuid]?.entries },
      };
      hydrationRef.current = next;
      return next;
    });

    const isCurrent = () => mounted.current
      && activeBatchUuidsRef.current.has(batchUuid)
      && generation.current === token.generation
      && inFlight.current.get(batchUuid) === token;

    void hydrateBatchMembership(batchUuid, listBatchEntries)
      .then((completeEntries) => {
        if (!isCurrent()) return;
        if (completeEntries.length === 0) {
          throw new Error('Empty batch membership response');
        }
        setHydration((current) => {
          const next: Record<string, BatchHydrationState> = {
          ...current,
          [batchUuid]: { status: 'ready', entries: completeEntries },
          };
          hydrationRef.current = next;
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        setHydration((current) => {
          const next: Record<string, BatchHydrationState> = {
          ...current,
          [batchUuid]: { status: 'error', error, entries: current[batchUuid]?.entries },
          };
          hydrationRef.current = next;
          return next;
        });
      })
      .finally(() => {
        if (inFlight.current.get(batchUuid) === token) inFlight.current.delete(batchUuid);
      });
  }, [listBatchEntries]);

  React.useEffect(() => {
    generation.current += 1;
    inFlight.current.clear();
    hydrationRef.current = {};
    setHydration({});
    for (const batchUuid of expandedRef.current) startHydration(batchUuid);
  }, [listBatchEntries, startHydration]);

  React.useEffect(() => {
    const nextExpanded = new Set(
      [...expandedRef.current].filter((batchUuid) => activeBatchUuids.has(batchUuid)),
    );
    expandedRef.current = nextExpanded;
    setExpandedBatches(nextExpanded);
    for (const batchUuid of inFlight.current.keys()) {
      if (!activeBatchUuids.has(batchUuid)) inFlight.current.delete(batchUuid);
    }
    setHydration((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([batchUuid]) => activeBatchUuids.has(batchUuid)),
      );
      hydrationRef.current = next;
      return next;
    });
  }, [activeBatchUuids]);

  const toggleBatch = React.useCallback((batchUuid: string) => {
    const next = new Set(expandedRef.current);
    const shouldExpand = !next.has(batchUuid);
    if (shouldExpand) next.add(batchUuid);
    else next.delete(batchUuid);
    expandedRef.current = next;
    setExpandedBatches(next);
    if (shouldExpand && hydrationRef.current[batchUuid]?.status !== 'ready') {
      startHydration(batchUuid);
    }
  }, [startHydration]);

  const renderEntry = (entry: EntryAggregate, keyPrefix: string) => (
    <JournalEntryRow
      key={`${keyPrefix}:${entry.entry_uuid}`}
      entry={entry}
      plotLabel={entry.plot_uuid ? (plotLabels.get(entry.plot_uuid) ?? null) : null}
    />
  );

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

  return (
    <div className="flex flex-col gap-2">
      {items.map((item, itemIndex) => {
        if (item.kind === 'entry') return renderEntry(item.entry, 'entry');

        const state = hydration[item.batchUuid];
        const expanded = expandedBatches.has(item.batchUuid);
        const hydratedEntries = state?.status === 'ready' ? (state.entries ?? []) : [];
        const summaryEntries = state?.status === 'ready' ? hydratedEntries : item.entries;
        const summary = summarizeBatchEntries(summaryEntries);
        const count = state?.status === 'ready' ? hydratedEntries.length : null;
        const activityLabel = summary.activityCode
          ? t(`activity.${summary.activityCode}`, summary.activityCode)
          : null;
        const titleId = `journal-batch-title-${itemIndex}`;
        const contentId = `journal-batch-content-${itemIndex}`;

        return (
          <section
            key={`batch:${item.batchUuid}`}
            aria-labelledby={titleId}
            className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 id={titleId} className="font-bold text-[var(--text)]">
                  {t('timeline.batch', { defaultValue: 'Batch activity' })}
                </h2>
                <p className="text-sm text-[var(--text-secondary)]">
                  {activityLabel}
                  {activityLabel && summary.cropSummary ? ' · ' : ''}
                  {summary.cropSummary ?? ''}
                  {(activityLabel || summary.cropSummary) && count !== null ? ' · ' : ''}
                  {count !== null
                    ? t('batch.count', { count, defaultValue: `${count} plot${count === 1 ? '' : 's'}` })
                    : null}
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-bold"
                aria-expanded={expanded}
                aria-controls={contentId}
                onClick={() => toggleBatch(item.batchUuid)}
              >
                {t(expanded ? 'timeline.batchCollapse' : 'timeline.batchExpand', {
                  defaultValue: expanded ? 'Collapse batch' : 'Expand batch',
                })}
              </button>
            </div>

            <div id={contentId} aria-labelledby={titleId} hidden={!expanded} className="mt-3 flex flex-col gap-2">
              {expanded && state?.status === 'loading' && (
                <p role="status" className="text-sm text-[var(--text-secondary)]">
                  {t('timeline.batchLoading', { defaultValue: 'Loading batch entries…' })}
                </p>
              )}
              {expanded && state?.status === 'error' && (
                <div role="alert" className="flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
                  <span>{t('timeline.batchError', { defaultValue: 'Unable to load batch entries.' })}</span>
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--border)] px-3 py-2 font-bold"
                    onClick={() => startHydration(item.batchUuid)}
                  >
                    {t('timeline.batchRetry', { defaultValue: 'Retry' })}
                  </button>
                </div>
              )}
              {expanded && state?.status === 'ready' && hydratedEntries.map((entry) => (
                renderEntry(entry, 'batch')
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
