import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createHistoryLoader,
  HISTORY_LATEST_TTL_MS,
  HISTORY_PREFETCH_COOLDOWN_MS,
  HISTORY_PREFETCH_IDLE_MS,
  HISTORY_SETTLE_MS,
} from './historyLoader';
import { bufferedRequest, coverageContains, HISTORY_MAX_VIEWPORT_SPAN_MS, HISTORY_NAVIGATION_START_MS, minuteViewport, neighborRequest } from './range';
import { cardHistoryRangeStrategy, type HistoryRangeStrategy } from './rangeStrategy';
import { HistoryAbortError, HistoryAuthError, type HistoryAcceptedData, type HistoryDemand, type HistoryLoader, type HistoryRangeRequest } from './types';
import { DAY_MS, HOUR_MS, MINUTE_MS, type HistoryWindowOptions, type HistoryWindowReason, type Viewport } from '../shared/types';
import { createViewportStore, type ViewportStore } from '../shared/viewport';

export interface HistoryWindowResult {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  accepted: HistoryAcceptedData | null;
  loadingRequest: HistoryRangeRequest | null;
  failedRequest: HistoryRangeRequest | null;
  error: unknown | null;
  refreshing: boolean;
  viewportStore: ViewportStore;
  store: ViewportStore;
  horizon: Viewport;
  selectPreset(span: '24h' | '7d' | '30d' | '90d'): void;
  moveWindow(direction: 'back' | 'forward'): void;
  showLatest(): void;
  retry(): void;
  selectedIds?: readonly string[] | undefined;
  displayedIds?: readonly string[] | undefined;
  selectSources?(ids: readonly string[]): void;
  evictSeries?(ids: readonly string[]): void;
}

function filterAccepted(data: HistoryAcceptedData | null, ids: readonly string[] | undefined): HistoryAcceptedData | null {
  if (!data || ids === undefined) return data;
  const allowed = new Set(ids);
  return { ...data, series: data.series.filter((item) => allowed.has(item.id)), unitGroups: data.unitGroups.map((group) => ({ ...group, seriesIds: group.seriesIds.filter((id) => allowed.has(id)) })).filter((group) => group.seriesIds.length > 0) };
}

function mergeAccepted(previous: HistoryAcceptedData | null, next: HistoryAcceptedData): HistoryAcceptedData {
  if (!previous || previous.request.from !== next.request.from || previous.request.to !== next.request.to || previous.request.aggregation !== next.request.aggregation) return next;
  const series = [...previous.series];
  for (const item of next.series) {
    const index = series.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) series[index] = item; else series.push(item);
  }
  return { ...next, series, unitGroups: next.unitGroups.length ? next.unitGroups : previous.unitGroups };
}

const identityOf = (context: HistoryWindowOptions['context']): string => context
  ? `${context.sessionKey}|${context.scopeKey}|${context.cardId}|${context.sourceKey ?? ''}`
  : '';

const browserNow = () => Date.now();
const clear = (timer: number | null) => {
  if (timer !== null && typeof window !== 'undefined') window.clearTimeout(timer);
};

export function useHistoryWindow(options: HistoryWindowOptions): HistoryWindowResult {
  const now = options.now ?? browserNow;
  const context = options.context;
  const identity = identityOf(context);
  const viewportIdentity = options.viewportIdentity ?? identity;
  const rangeStrategy: HistoryRangeStrategy = options.rangeStrategy ?? cardHistoryRangeStrategy;
  const maxSpanMs = options.maxSpanMs ?? HISTORY_MAX_VIEWPORT_SPAN_MS;
  const selectionMode = options.selectedIds !== undefined;
  const [selection, setSelection] = useState<readonly string[] | undefined>(() => options.selectedIds?.slice());
  const [selectionRevision, setSelectionRevision] = useState(0);
  const selectionRef = useRef<readonly string[] | undefined>(selection);
  selectionRef.current = selection;
  const selectionRevisionRef = useRef(0);
  const [horizonEnd, setHorizonEnd] = useState(() => Math.floor(now() / MINUTE_MS) * MINUTE_MS);
  const [acceptedState, setAcceptedState] = useState<{ identity: string; data: HistoryAcceptedData } | null>(null);
  const backingAccepted = acceptedState?.identity === identity ? acceptedState.data : null;
  const accepted = filterAccepted(backingAccepted, selection);
  const [status, setStatus] = useState<HistoryWindowResult['status']>(options.enabled && context ? 'loading' : 'idle');
  const [loadingRequest, setLoadingRequest] = useState<HistoryRangeRequest | null>(null);
  const [failedRequest, setFailedRequest] = useState<HistoryRangeRequest | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loader = useMemo<HistoryLoader>(() => options.loader ?? createHistoryLoader({ now }), [options.loader, now]);
  const horizon = useMemo(() => ({ from: options.navigationStartMs ?? HISTORY_NAVIGATION_START_MS, to: horizonEnd }), [options.navigationStartMs, horizonEnd]);
  const visibleSpan = useRef(DAY_MS);
  const viewportStore = useMemo(() => {
    const span = Math.min(maxSpanMs, Math.max(options.minSpanMs ?? HOUR_MS, visibleSpan.current));
    return createViewportStore({ from: horizon.to - span, to: horizon.to }, horizon, options.minSpanMs ?? HOUR_MS, maxSpanMs);
  }, [options.minSpanMs, viewportIdentity, maxSpanMs]);
  useEffect(() => {
    viewportStore.setExtent?.(horizon);
  }, [horizon.from, horizon.to, viewportStore]);
  const acceptedRef = useRef(backingAccepted);
  acceptedRef.current = backingAccepted;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const intent = useRef(0);
  const lifetime = useRef(0);
  const timer = useRef<number | null>(null);
  const prefetchTimer = useRef<number | null>(null);
  const previousCenter = useRef<number | null>(null);
  const leadingAnchor = useRef<number | null>(null);
  const direction = useRef<'back' | 'forward'>('back');
  const lastPrefetch = useRef(-Infinity);
  const acceptedReceivedAt = useRef<number | null>(null);
  const pendingLatest = useRef<{ to: number; span: number } | null>(null);

  const cancelTimers = () => {
    clear(timer.current);
    clear(prefetchTimer.current);
    timer.current = null;
    prefetchTimer.current = null;
  };

  const resetAccepted = () => {
    intent.current += 1;
    loader.clear();
    cancelTimers();
    setAcceptedState(null);
    setLoadingRequest(null);
    setFailedRequest(null);
    setError(null);
    setRefreshing(false);
  };

  const schedulePrefetch = (visible: Viewport, immediate = false) => {
    if (!options.enabled || !context || typeof document === 'undefined' || document.hidden) return;
    if (now() - lastPrefetch.current < HISTORY_PREFETCH_COOLDOWN_MS) return;
    const request = rangeStrategy.neighborRequest(visible, direction.current, horizon);
    if (!request) return;
    clear(prefetchTimer.current);
    const lifetimeAtSchedule = lifetime.current;
    const identityAtSchedule = identity;
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null;
      if (document.hidden || identityRef.current !== identityAtSchedule || lifetime.current !== lifetimeAtSchedule) return;
      lastPrefetch.current = now();
      const policy = options.readPolicy?.(request) ?? request.readPolicy ?? 'card-default';
      const selected = selectionRef.current;
      const selectionKey = selected === undefined ? undefined : JSON.stringify([...selected].sort());
      const demand: HistoryDemand = { context, visible, request: { ...request, readPolicy: policy, selectionKey }, horizon, reason: 'prefetch', forceFresh: false, direction: direction.current, neighbor: request, readPolicy: policy, selectionKey, selectedIds: selected, requestRevision: selectionRevisionRef.current };
      void loader.prefetch(demand, (signal) => options.load(request, signal)).catch((cause: unknown) => {
        if (cause instanceof HistoryAuthError && identityRef.current === identityAtSchedule && lifetime.current === lifetimeAtSchedule) options.onAuthError?.(cause);
      });
    }, immediate ? 0 : HISTORY_PREFETCH_IDLE_MS);
  };

  const schedule = (viewport: Viewport, reason: Exclude<HistoryWindowReason, 'prefetch'>, extra: { forceFresh?: boolean; failedRequest?: HistoryRangeRequest } = {}) => {
    if (!options.enabled || !context) return;
    const visible = rangeStrategy === cardHistoryRangeStrategy ? minuteViewport(viewport) : viewport;
    const baseRequest = extra.failedRequest ?? rangeStrategy.bufferedRequest(visible, horizon);
    const policy = options.readPolicy?.(baseRequest) ?? baseRequest.readPolicy ?? 'card-default';
    const selected = selectionRef.current;
    const selectionKey = selected === undefined ? undefined : JSON.stringify([...selected].sort());
    const request = { ...baseRequest, readPolicy: policy, selectionKey };
    const generation = ++intent.current;
    const identityAtStart = identity;
    const lifetimeAtStart = lifetime.current;
    const demand: HistoryDemand = { context, visible, request, horizon, reason, direction: direction.current, neighbor: rangeStrategy.neighborRequest(visible, direction.current, horizon), forceFresh: extra.forceFresh ?? (reason === 'latest' || reason === 'retry'), readPolicy: policy, selectionKey, selectedIds: selected, requestRevision: selectionRevisionRef.current };
    const handle = loader.foreground(demand, (signal) => options.load(request, signal));
    options.onDiagnostics?.({ reason, ...loader.diagnostics() });
    const sessionCurrent = () => lifetime.current === lifetimeAtStart && identityRef.current === identityAtStart;
    const current = () => lifetime.current === lifetimeAtStart && identityRef.current === identityAtStart && generation === intent.current;
    if (handle.source === 'cache') {
      setLoadingRequest(null);
      setRefreshing(false);
    } else {
      setLoadingRequest(request);
      setFailedRequest(null);
      setError(null);
      if (acceptedRef.current) setRefreshing(true); else setStatus('loading');
    }
    void handle.result.then((value) => {
      if (!current()) return;
      const visibleNow = rangeStrategy === cardHistoryRangeStrategy ? minuteViewport(viewportStore.get()) : viewportStore.get();
      const direct = visibleNow.from === visible.from && visibleNow.to === visible.to;
      const reusable = !value.data.limits.truncated && value.data.aggregation.level === request.aggregation && coverageContains(value.data, visibleNow, request.aggregation);
      if (!direct && !reusable) return;
      setAcceptedState({ identity: identityAtStart, data: mergeAccepted(acceptedRef.current, value.data) });
      acceptedReceivedAt.current = value.receivedAt;
      setLoadingRequest(null);
      setRefreshing(false);
      setError(null);
      setStatus(value.data.series.length ? 'ready' : 'empty');
      schedulePrefetch(visibleNow);
    }).catch((cause: unknown) => {
      if (cause instanceof HistoryAuthError) {
        if (sessionCurrent()) options.onAuthError?.(cause);
        if (current()) { setLoadingRequest(null); setRefreshing(false); }
        return;
      }
      if (!current() || cause instanceof HistoryAbortError) return;
      setLoadingRequest(null);
      setRefreshing(false);
      setFailedRequest(request);
      setError(cause);
      setStatus(acceptedRef.current ? 'ready' : 'error');
    });
  };

  useEffect(() => {
    lifetime.current += 1;
    resetAccepted();
    if (!options.enabled || !context) {
      setStatus('idle');
      return;
    }
    if (selection !== undefined && selection.length === 0) {
      setStatus('empty');
      return;
    }
    setStatus('loading');
    schedule(viewportStore.get(), 'initial');
    return () => {
      lifetime.current += 1;
      cancelTimers();
      loader.abortPrefetch();
      loader.clear();
    };
  }, [identity, options.enabled]);

  useEffect(() => {
    const unsubscribe = viewportStore.subscribe((viewport, source) => {
      if (source !== 'gesture') return;
      setLoadingRequest(null);
      setRefreshing(false);
      clear(prefetchTimer.current);
      prefetchTimer.current = null;
      intent.current += 1;
      const center = (viewport.from + viewport.to) / 2;
      const moved = previousCenter.current === null || center >= previousCenter.current ? 'forward' : 'back';
      previousCenter.current = center;
      if (leadingAnchor.current === null) leadingAnchor.current = center;
      if (Math.abs(center - leadingAnchor.current) >= (viewport.to - viewport.from) * 0.05) {
        if (direction.current !== moved) loader.abortPrefetch();
        direction.current = moved;
        leadingAnchor.current = center;
        schedulePrefetch(viewport, true);
      }
      clear(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        schedule(viewport, 'gesture');
      }, HISTORY_SETTLE_MS);
    });
    return () => { unsubscribe(); cancelTimers(); loader.abortPrefetch(); };
  }, [viewportStore, identity, horizon]);

  useEffect(() => {
    const changed = () => {
      if (document.hidden) {
        loader.abortPrefetch();
        clear(timer.current);
        clear(prefetchTimer.current);
        timer.current = null;
        prefetchTimer.current = null;
        return;
      }
      if (!acceptedRef.current) return;
      const visible = viewportStore.get();
      const age = acceptedReceivedAt.current === null ? Infinity : now() - acceptedReceivedAt.current;
      if (visible.to >= horizon.to && age > HISTORY_LATEST_TTL_MS) schedule(visible, 'visibility', { forceFresh: true });
    };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [viewportStore, horizon.to, identity]);

  const selectPreset = (span: '24h' | '7d' | '30d' | '90d') => {
    const durations = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };
    const to = viewportStore.get().to;
    const selectedSpan = Math.min(durations[span], maxSpanMs);
    const next = { from: Math.max(horizon.from, to - selectedSpan), to };
    visibleSpan.current = selectedSpan;
    cancelTimers();
    viewportStore.set(next, 'external');
    schedule(next, 'preset');
  };
  const moveWindow = (way: 'back' | 'forward') => {
    const current = viewportStore.get();
    const span = current.to - current.from;
    const from = Math.max(horizon.from, Math.min(current.from + span * 0.8 * (way === 'back' ? -1 : 1), horizon.to - span));
    const next = { from, to: from + span };
    direction.current = way;
    visibleSpan.current = span;
    cancelTimers();
    viewportStore.set(next, 'external');
    schedule(next, way);
  };
  const showLatest = () => {
    cancelTimers();
    const to = Math.floor(now() / MINUTE_MS) * MINUTE_MS;
    const span = viewportStore.get().to - viewportStore.get().from;
    if (to === horizon.to) {
      const next = { from: to - span, to };
      viewportStore.set(next, 'external');
      schedule(next, 'latest', { forceFresh: true });
    } else {
      pendingLatest.current = { to, span };
      setHorizonEnd(to);
    }
  };
  useEffect(() => {
    const pending = pendingLatest.current;
    if (!pending || pending.to !== horizon.to) return;
    pendingLatest.current = null;
    const next = { from: horizon.to - pending.span, to: horizon.to };
    viewportStore.set(next, 'external');
    schedule(next, 'latest', { forceFresh: true });
  }, [horizon.to, viewportStore]);
  const retry = () => schedule(viewportStore.get(), 'retry', { forceFresh: true, failedRequest: failedRequest ?? loadingRequest ?? undefined });
  const selectSources = (ids: readonly string[]) => {
    if (!selectionMode) return;
    const next = [...ids];
    const previous = selection ?? [];
    setSelection(next);
    selectionRef.current = next;
    selectionRevisionRef.current += 1;
    setSelectionRevision(selectionRevisionRef.current);
    clear(timer.current);
    timer.current = null;
    intent.current += 1;
    const adding = next.some((id) => !previous.includes(id));
    if (next.length === 0) setStatus('empty');
    else if (adding) timer.current = window.setTimeout(() => schedule(viewportStore.get(), 'gesture'), HISTORY_SETTLE_MS);
  };
  const evictSeries = (ids: readonly string[]) => {
    loader.evictSeries(ids);
    const denied = new Set(ids);
    setSelection((current) => current?.filter((id) => !denied.has(id)));
    setAcceptedState((current) => current ? { ...current, data: { ...current.data, series: current.data.series.filter((item) => !denied.has(item.id)), unitGroups: current.data.unitGroups.map((group) => ({ ...group, seriesIds: group.seriesIds.filter((id) => !denied.has(id)) })).filter((group) => group.seriesIds.length > 0) } } : current);
    intent.current += 1;
  };
  return { status, accepted, loadingRequest, failedRequest, error, refreshing, viewportStore, store: viewportStore, horizon, selectPreset, moveWindow, showLatest, retry, selectedIds: selection, displayedIds: selection, selectSources, evictSeries };
}
