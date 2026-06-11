import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { HistoryCardVisualization } from '../components/history/HistoryCardVisualization';
import { HistoryDetailHeader } from '../components/history/mobile/HistoryDetailHeader';
import {
  HistoryInspectorSheet,
  type HistoryInspectorSelection,
} from '../components/history/mobile/HistoryInspectorSheet';
import { HistoryVisualizationSurface } from '../components/history/mobile/HistoryVisualizationSurface';
import { formatWindowCaption } from '../components/history/visualizations/chartAxis';
import { formatHistoryCalendarMonthLabel } from '../history/calendarMonth';
import { historyCardDefinitionsByType } from '../history/cardDefinitions';
import { useFeatureFlags } from '../history/useFeatureFlags';
import { useHistoryCardAdvancedData } from '../history/useHistoryCardAdvancedData';
import { useHistoryCardData } from '../history/useHistoryCardData';
import { orderHistoryCards, useHistoryCards } from '../history/useHistoryCards';
import { useOrientation } from '../history/useOrientation';
import {
  setTimeViewportRange,
  useTimeViewport,
  visualWindowFromTimeViewport,
  type HistoryTimeViewport,
  type HistoryVisualWindow,
} from '../history/useTimeViewport';
import { historyAPI, irrigationZonesAPI } from '../services/api';
import type { HistoryCardDataScope } from '../history/useHistoryCardData';
import type {
  HistoryAggregationLevel,
  HistoryCardSummary,
  HistoryCardSummaryResponse,
  HistoryRangeLabel,
  HistoryRangeSelection,
  HistoryViewMode,
} from '../history/types';
import type { IrrigationZone } from '../types/farming';

const zonesFetcher = () => irrigationZonesAPI.getAll();
const DETAIL_PULL_REFRESH_THRESHOLD_PX = 96;
const DETAIL_PULL_REFRESH_MAX_HORIZONTAL_PX = 48;
const DETAIL_PULL_REFRESH_SCROLL_TOP_TOLERANCE_PX = 2;
const GATEWAY_ROUTE_CARD_ID = 'gateway-hub';
const HISTORY_VISUALIZATION_SURFACE_SELECTOR = '[data-history-visualization-surface="true"]';

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type PullRefreshStart = {
  pointerId: number;
  x: number;
  y: number;
  refreshed: boolean;
};

function decodeRouteCardId(rawCardId: string | undefined): string | null {
  if (!rawCardId) return null;
  try {
    return decodeURIComponent(rawCardId);
  } catch {
    return null;
  }
}

function gatewayEuiForCard(card: HistoryCardSummary): string | null {
  const gatewayEui = card.metadata.gatewayDeviceEui ?? card.metadata.gateway_device_eui ?? card.metadata.gatewayEui;
  return typeof gatewayEui === 'string' && gatewayEui.trim() ? gatewayEui : null;
}

function containsRawGatewayIdentifier(value: string | null | undefined, gatewayEui: string): boolean {
  if (!value) return false;
  const normalizedValue = value.toUpperCase();
  return normalizedValue.includes(gatewayEui.toUpperCase()) || /\b[A-F0-9]{16}\b/i.test(value);
}

function safeGatewayText(value: string | null | undefined, gatewayEui: string): string | null {
  if (!value || containsRawGatewayIdentifier(value, gatewayEui)) return null;
  return value;
}

function sanitizeGatewayRouteCard(
  t: HistoryTranslate,
  card: HistoryCardSummary,
  gatewayEui: string,
): HistoryCardSummary {
  return {
    ...card,
    title: safeGatewayText(card.title, gatewayEui) ?? t('history.cardType.gateway'),
    subtitle: safeGatewayText(card.subtitle, gatewayEui) ?? '',
    sourceLabel: safeGatewayText(card.sourceLabel, gatewayEui),
    sourceLabels: card.sourceLabels?.filter((label) => !containsRawGatewayIdentifier(label, gatewayEui)),
    sourceDevices: card.sourceDevices?.map((device) => ({
      ...device,
      name: safeGatewayText(device.name, gatewayEui),
    })),
  };
}

type DetailRouteScope =
  | { type: 'zone'; zoneId: number }
  | { type: 'gateway'; gatewayEui: string };

function selectableViewsForCard(card: HistoryCardSummary | null): HistoryViewMode[] {
  if (!card) return [];
  const definition = historyCardDefinitionsByType[card.cardType];
  const allowedViews = new Set<HistoryViewMode>(definition.views);
  const filtered = card.views.filter((view) => allowedViews.has(view));
  return filtered.length > 0 ? filtered : [...definition.views];
}

function primaryViewModes(views: readonly HistoryViewMode[]): HistoryViewMode[] {
  return views.filter((view) => view !== 'advanced');
}

function defaultPrimaryViewForCard(card: HistoryCardSummary | null): HistoryViewMode {
  if (!card) return 'line-chart';
  const selectableViews = selectableViewsForCard(card);
  if (card.defaultView !== 'advanced' && selectableViews.includes(card.defaultView)) return card.defaultView;
  return primaryViewModes(selectableViews)[0] ?? card.defaultView;
}

function formatRangeLabel(t: HistoryTranslate, range: HistoryRangeLabel): string {
  if (range === 'custom') return t('history.rangeShort.custom', { defaultValue: 'Custom' });
  return t(`history.rangeShort.${range}`);
}

function formatAggregationLabel(t: HistoryTranslate, aggregation: string): string {
  return t(`history.metadata.aggregation.${aggregation}`);
}

function monthRangeFromViewport(range: HistoryRangeSelection, monthOffset: number): HistoryRangeSelection {
  const baseMs = Date.parse(range.to ?? range.from ?? '');
  const baseDate = Number.isFinite(baseMs) ? new Date(baseMs) : new Date();
  const monthStart = new Date(Date.UTC(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth() + monthOffset,
    1,
    0,
    0,
    0,
    0,
  ));
  const nextMonthStart = new Date(Date.UTC(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth() + monthOffset + 1,
    1,
    0,
    0,
    0,
    0,
  ));

  return {
    label: 'custom',
    from: monthStart.toISOString(),
    to: new Date(nextMonthStart.getTime() - 1).toISOString(),
    timezone: range.timezone,
  };
}

function isPullRefreshPointerType(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

function getPullRefreshScrollTop(scrollRoot: HTMLElement): number {
  return Math.max(
    scrollRoot.scrollTop,
    window.scrollY,
    document.documentElement.scrollTop,
    document.body.scrollTop,
  );
}

function calendarDateFromTarget(target: EventTarget | null): string | null {
  if (!target || typeof (target as Element).closest !== 'function') return null;
  const dateCell = (target as Element).closest('[data-history-calendar-date]');
  return dateCell?.getAttribute('data-history-calendar-date') ?? null;
}

function scopeForCard(card: HistoryCardSummary, routeScope: DetailRouteScope): HistoryCardDataScope | null {
  if (routeScope.type === 'gateway') {
    return { type: 'gateway', gatewayEui: routeScope.gatewayEui };
  }

  if (card.scope === 'gateway') {
    const gatewayEui = gatewayEuiForCard(card);
    return gatewayEui ? { type: 'gateway', gatewayEui } : null;
  }
  return { type: 'zone', zoneId: routeScope.zoneId };
}

function isRouteMatchForCard(routeCardId: string | null, card: HistoryCardSummary): boolean {
  if (card.cardId === routeCardId) return true;
  return card.scope === 'gateway' && routeCardId === GATEWAY_ROUTE_CARD_ID;
}

function routeCardIdForCard(card: HistoryCardSummary): string {
  return card.scope === 'gateway' ? GATEWAY_ROUTE_CARD_ID : card.cardId;
}

function sourceOptionsForCard(card: HistoryCardSummary | null): Array<{ key: string; name: string }> {
  if (!card || (card.sourceDeviceCount ?? card.sourceDevices?.length ?? 0) <= 1) return [];
  const seen = new Set<string>();
  return (card.sourceDevices ?? []).reduce<Array<{ key: string; name: string }>>((options, device) => {
    const key = typeof device.sourceKey === 'string' ? device.sourceKey.trim() : '';
    const name = typeof device.name === 'string' ? device.name.trim() : '';
    if (!key || !name || /\b[A-F0-9]{16}\b/i.test(name) || seen.has(key)) return options;
    seen.add(key);
    options.push({ key, name });
    return options;
  }, []);
}

function formatViewLabel(t: HistoryTranslate, view: HistoryViewMode): string {
  return t(`history.viewMode.${view}`);
}

function detailViewModeLabel(
  t: HistoryTranslate,
  selectedView: HistoryViewMode,
  visibleRangeLabel: string,
  calendarMonthLabel: string | null,
): string {
  const viewLabel = formatViewLabel(t, selectedView);
  if (selectedView === 'calendar') return calendarMonthLabel ? `${viewLabel} - ${calendarMonthLabel}` : viewLabel;
  return `${viewLabel} - ${visibleRangeLabel}`;
}

const HistoryDetailError: React.FC<{
  title: string;
  body: string;
  backLabel: string;
}> = ({ title, body, backLabel }) => (
  <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
    <section className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
      <h1 className="text-2xl font-bold text-[var(--text)]">{title}</h1>
      <p className="mt-2 text-sm text-[var(--text-tertiary)]">{body}</p>
      <Link
        to="/history"
        className="mt-5 inline-flex rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-bold text-white"
      >
        {backLabel}
      </Link>
    </section>
  </div>
);

export const HistoryCardDetailPage: React.FC = () => {
  const { zoneId: rawZoneId, gatewayEui: rawGatewayEui, cardId: rawCardId } = useParams();
  const navigate = useNavigate();
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const pullStartRef = useRef<PullRefreshStart | null>(null);
  const featureFlags = useFeatureFlags();
  const orientation = useOrientation();
  const isLandscape = orientation === 'landscape';
  const zoneId = Number(rawZoneId);
  const gatewayEui = typeof rawGatewayEui === 'string' && rawGatewayEui.trim() ? rawGatewayEui : null;
  const cardId = decodeRouteCardId(rawCardId);
  const validZoneRoute = Number.isInteger(zoneId) && zoneId > 0;
  const validGatewayRoute = Boolean(gatewayEui && cardId);
  const validRoute = validZoneRoute || validGatewayRoute;
  const routeScope = useMemo<DetailRouteScope | null>(() => {
    if (validGatewayRoute && gatewayEui) return { type: 'gateway', gatewayEui };
    if (validZoneRoute) return { type: 'zone', zoneId };
    return null;
  }, [gatewayEui, validGatewayRoute, validZoneRoute, zoneId]);

  const {
    data: zones,
    error: zonesError,
    isLoading: zonesLoading,
  } = useSWR<IrrigationZone[]>(
    featureFlags.historyEnabled && routeScope?.type === 'zone' ? '/api/irrigation-zones' : null,
    zonesFetcher,
    { revalidateOnFocus: true },
  );

  const {
    cards,
    error: cardsError,
    isLoading: cardsLoading,
  } = useHistoryCards(routeScope?.type === 'zone' ? routeScope.zoneId : null, featureFlags.historyEnabled);
  const {
    data: gatewayCardsResponse,
    error: gatewayCardsError,
    isLoading: gatewayCardsLoading,
  } = useSWR<HistoryCardSummaryResponse>(
    featureFlags.historyEnabled && routeScope?.type === 'gateway'
      ? `/api/history/gateways/${routeScope.gatewayEui}/cards`
      : null,
    () => {
      if (routeScope?.type !== 'gateway') throw new Error('Gateway route unavailable');
      return historyAPI.getGatewayCards(routeScope.gatewayEui);
    },
    { revalidateOnFocus: true },
  );
  const routeCards = routeScope?.type === 'gateway' ? gatewayCardsResponse?.cards ?? [] : cards;
  const orderedRouteCards = useMemo(
    () => (routeScope?.type === 'zone' ? orderHistoryCards(routeCards) : routeCards),
    [routeCards, routeScope?.type],
  );

  const resolvedZone = useMemo(
    () => (routeScope?.type === 'zone' ? (zones ?? []).find((zone) => zone.id === routeScope.zoneId) ?? null : null),
    [routeScope, zones],
  );
  const resolvedCard = useMemo(
    () => routeCards.find((card) => isRouteMatchForCard(cardId, card))
      ?? (!cardId ? orderedRouteCards[0] ?? null : null),
    [cardId, orderedRouteCards, routeCards],
  );
  const resolvedScope = resolvedCard && routeScope ? scopeForCard(resolvedCard, routeScope) : null;
  const displayCard = useMemo(
    () => (
      resolvedCard && routeScope?.type === 'gateway'
        ? sanitizeGatewayRouteCard(t, resolvedCard, routeScope.gatewayEui)
        : resolvedCard
    ),
    [resolvedCard, routeScope, t],
  );
  const [userSelectedView, setUserSelectedView] = useState<{ cardId: string; view: HistoryViewMode } | null>(null);
  const [enabledSources, setEnabledSources] = useState<{ cardId: string; keys: string[] } | null>(null);
  const [calendarMonthOffset, setCalendarMonthOffset] = useState(0);
  const [visualWindow, setVisualWindow] = useState<HistoryVisualWindow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const defaultRange = displayCard?.defaultRange ?? '24h';
  const timeViewport = useTimeViewport(
    defaultRange,
    displayCard ? `${displayCard.cardId}:${defaultRange}` : defaultRange,
  );
  const selectedView = useMemo(() => {
    const selectableViews = selectableViewsForCard(displayCard);
    if (
      displayCard
      && userSelectedView?.cardId === displayCard.cardId
      && selectableViews.includes(userSelectedView.view)
    ) {
      return userSelectedView.view;
    }
    return defaultPrimaryViewForCard(displayCard);
  }, [displayCard, userSelectedView]);
  const shouldRenderAdvanced = selectedView === 'advanced';
  const sourceOptions = useMemo(() => sourceOptionsForCard(displayCard), [displayCard]);
  const allSourceKeys = useMemo(() => sourceOptions.map((source) => source.key), [sourceOptions]);
  const enabledSourceKeys = useMemo(() => {
    if (!displayCard || sourceOptions.length <= 1) return allSourceKeys;
    if (enabledSources?.cardId !== displayCard.cardId) return allSourceKeys;
    const valid = enabledSources.keys.filter((key) => allSourceKeys.includes(key));
    return valid.length > 0 ? valid : allSourceKeys;
  }, [allSourceKeys, displayCard, enabledSources, sourceOptions.length]);
  const selectedSourceKey = sourceOptions.length > 1 && enabledSourceKeys.length === 1
    ? enabledSourceKeys[0]
    : null;
  const requestAggregation: HistoryAggregationLevel = selectedView === 'daily-min-max'
    ? 'daily'
    : timeViewport.viewport.aggregation;
  const committedWindow = useMemo(
    () => visualWindowFromTimeViewport(timeViewport.viewport),
    [timeViewport.viewport],
  );
  const chartWindow = visualWindow ?? committedWindow ?? undefined;
  const visibleRangeLabel = useMemo(() => {
    const fallback = formatRangeLabel(t, timeViewport.viewport.range.label);
    if (timeViewport.viewport.range.label !== 'custom' || !chartWindow) return fallback;
    const caption = formatWindowCaption(chartWindow.fromMs, chartWindow.toMs);
    return caption === '-' ? fallback : caption;
  }, [chartWindow, t, timeViewport.viewport.range.label]);
  const requestRange = useMemo(
    () => (selectedView === 'calendar'
      ? monthRangeFromViewport(timeViewport.viewport.range, calendarMonthOffset)
      : timeViewport.viewport.range),
    [calendarMonthOffset, selectedView, timeViewport.viewport.range],
  );
  const singleDeviceName = useMemo(() => {
    if (!displayCard) return null;
    const count = displayCard.sourceDeviceCount ?? displayCard.sourceDevices?.length ?? 0;
    if (count !== 1) return null;
    // Prefer display-safe sources; never surface a raw DevEUI-like identifier.
    const candidates = [
      displayCard.sourceDevices?.[0]?.name,
      displayCard.sourceLabels?.[0],
      displayCard.sourceLabel,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const value = candidate.trim();
      if (value && !/^[A-Fa-f0-9]{16}$/.test(value)) return value;
    }
    return null;
  }, [displayCard]);
  const cardData = useHistoryCardData({
    scope: resolvedScope,
    cardId: displayCard?.cardId ?? null,
    view: selectedView,
    range: requestRange,
    aggregation: requestAggregation,
    overlays: [],
    sourceKey: selectedSourceKey,
    enabled: Boolean(displayCard?.availability.available && resolvedScope && !shouldRenderAdvanced),
  });
  const advancedData = useHistoryCardAdvancedData({
    scope: resolvedScope,
    cardId: displayCard?.cardId ?? null,
    view: selectedView,
    range: timeViewport.viewport.range,
    aggregation: timeViewport.viewport.aggregation,
    overlays: [],
    sourceKey: selectedSourceKey,
    enabled: Boolean(displayCard?.availability.available && resolvedScope && shouldRenderAdvanced),
  });
  const [inspectorSelection, setInspectorSelection] = useState<HistoryInspectorSelection | null>(null);
  const calendarDaysByDate = useMemo(() => {
    const days = cardData.data?.calendar?.days;
    return new Map((Array.isArray(days) ? days : []).map((day) => [day.date, day]));
  }, [cardData.data?.calendar?.days]);
  const calendarMonthLabel = useMemo(
    () => formatHistoryCalendarMonthLabel(cardData.data?.calendar),
    [cardData.data?.calendar],
  );
  const viewModeLabel = detailViewModeLabel(t, selectedView, visibleRangeLabel, calendarMonthLabel);

  const handleInspectTimestamp = useCallback((selection: { timestamp: string }) => {
    setInspectorSelection({ kind: 'timestamp', timestamp: selection.timestamp });
  }, []);

  const handleInspectDate = useCallback((selection: HistoryInspectorSelection & { kind: 'date' }) => {
    setInspectorSelection({ kind: 'date', date: selection.date, day: selection.day });
  }, []);

  const handleScrollRootClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const date = calendarDateFromTarget(event.target);
    if (date) setInspectorSelection({ kind: 'date', date, day: calendarDaysByDate.get(date) ?? null });
  }, [calendarDaysByDate]);

  const handleScrollRootCalendarPointer = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const date = calendarDateFromTarget(event.target);
    if (date) setInspectorSelection({ kind: 'date', date, day: calendarDaysByDate.get(date) ?? null });
  }, [calendarDaysByDate]);

  const handleScrollRootCalendarMouse = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const date = calendarDateFromTarget(event.target);
    if (date) setInspectorSelection({ kind: 'date', date, day: calendarDaysByDate.get(date) ?? null });
  }, [calendarDaysByDate]);

  const handleResetRange = useCallback(() => {
    if (!displayCard) return;
    setSettingsOpen(false);
    setVisualWindow(null);
    timeViewport.setViewport(
      setTimeViewportRange(displayCard.defaultRange, new Date(), timeViewport.viewport.range.timezone),
    );
  }, [displayCard, timeViewport]);

  const handleViewportChange = useCallback((nextViewport: HistoryTimeViewport) => {
    setVisualWindow(null);
    timeViewport.setViewport(nextViewport);
  }, [timeViewport]);

  const handleAdvancedView = useCallback(() => {
    if (!displayCard || !selectableViewsForCard(displayCard).includes('advanced')) return;
    setSettingsOpen(false);
    setUserSelectedView({ cardId: displayCard.cardId, view: 'advanced' });
  }, [displayCard]);

  const handleRefresh = useCallback(() => {
    setSettingsOpen(false);
    if (shouldRenderAdvanced) {
      void advancedData.refresh();
      return;
    }
    void cardData.refresh();
  }, [advancedData, cardData, shouldRenderAdvanced]);

  const handleCloseInspector = useCallback(() => {
    setInspectorSelection(null);
    window.setTimeout(() => {
      const surface = document.querySelector<HTMLElement>('[data-testid="history-visualization-surface"]');
      surface?.focus();
    }, 0);
  }, []);

  const handleSourceKeysChange = useCallback((keys: string[]) => {
    if (!displayCard) return;
    const valid = keys.filter((key) => allSourceKeys.includes(key));
    setEnabledSources({ cardId: displayCard.cardId, keys: valid.length > 0 ? valid : allSourceKeys });
  }, [allSourceKeys, displayCard]);

  const handleCardSwipe = useCallback((delta: -1 | 1) => {
    if (!displayCard || routeScope?.type !== 'zone' || orderedRouteCards.length <= 1) return;
    const currentIndex = orderedRouteCards.findIndex((card) => card.cardId === displayCard.cardId);
    if (currentIndex < 0) return;

    const nextIndex = delta < 0
      ? (currentIndex + 1) % orderedRouteCards.length
      : (currentIndex - 1 + orderedRouteCards.length) % orderedRouteCards.length;
    const nextCard = orderedRouteCards[nextIndex];
    navigate(`/history/zones/${routeScope.zoneId}/cards/${encodeURIComponent(routeCardIdForCard(nextCard))}`);
  }, [displayCard, navigate, orderedRouteCards, routeScope]);

  const handleViewSwipe = useCallback((delta: -1 | 1) => {
    if (!displayCard) return;
    const views = primaryViewModes(selectableViewsForCard(displayCard));
    if (views.length <= 1) return;
    const currentIndex = Math.max(0, views.indexOf(selectedView));
    const nextIndex = delta < 0
      ? (currentIndex + 1) % views.length
      : (currentIndex - 1 + views.length) % views.length;
    setUserSelectedView({ cardId: displayCard.cardId, view: views[nextIndex] });
  }, [displayCard, selectedView]);

  const handleMonthSwipe = useCallback((delta: -1 | 1) => {
    setCalendarMonthOffset((offset) => offset + delta);
  }, []);

  const isVisualizationEvent = useCallback((target: EventTarget | null): boolean => {
    return target instanceof Element && Boolean(target.closest(HISTORY_VISUALIZATION_SURFACE_SELECTOR));
  }, []);

  const handleScrollRootPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const isAtScrollTop = getPullRefreshScrollTop(event.currentTarget) <= DETAIL_PULL_REFRESH_SCROLL_TOP_TOLERANCE_PX;
    if (
      !isPullRefreshPointerType(event.pointerType)
      || !isAtScrollTop
      || isVisualizationEvent(event.target)
    ) {
      pullStartRef.current = null;
      return;
    }
    pullStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      refreshed: false,
    };
  }, [isVisualizationEvent]);

  const handleScrollRootPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const selectedDate = calendarDateFromTarget(event.target);
    if (selectedDate) {
      setInspectorSelection({
        kind: 'date',
        date: selectedDate,
        day: calendarDaysByDate.get(selectedDate) ?? null,
      });
      pullStartRef.current = null;
      return;
    }

    const start = pullStartRef.current;
    if (
      !start
      || start.pointerId !== event.pointerId
      || start.refreshed
      || !isPullRefreshPointerType(event.pointerType)
      || isVisualizationEvent(event.target)
    ) {
      pullStartRef.current = null;
      return;
    }

    const deltaY = event.clientY - start.y;
    const deltaX = Math.abs(event.clientX - start.x);
    if (deltaY >= DETAIL_PULL_REFRESH_THRESHOLD_PX && deltaX <= DETAIL_PULL_REFRESH_MAX_HORIZONTAL_PX) {
      start.refreshed = true;
      handleRefresh();
    }
    pullStartRef.current = null;
  }, [calendarDaysByDate, handleRefresh, isVisualizationEvent]);

  useEffect(() => {
    if (!featureFlags.historyEnabled || routeScope?.type !== 'zone' || !resolvedCard) return;
    historyAPI.markZoneCardOpened(routeScope.zoneId, resolvedCard.cardId).catch(() => undefined);
  }, [featureFlags.historyEnabled, resolvedCard, routeScope]);

  useEffect(() => {
    if (!displayCard || enabledSources?.cardId !== displayCard.cardId) return;
    const valid = enabledSources.keys.filter((key) => allSourceKeys.includes(key));
    if (valid.length !== enabledSources.keys.length || valid.length === 0) {
      setEnabledSources(valid.length > 0 ? { cardId: displayCard.cardId, keys: valid } : null);
    }
  }, [allSourceKeys, displayCard, enabledSources]);

  useEffect(() => {
    setCalendarMonthOffset(0);
    setVisualWindow(null);
  }, [
    displayCard?.cardId,
    selectedSourceKey,
    selectedView,
    timeViewport.viewport.range.label,
    timeViewport.viewport.range.from,
    timeViewport.viewport.range.to,
  ]);

  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
    return () => {
      if (!meta) return;
      if (previousContent === null) {
        meta.removeAttribute('content');
        return;
      }
      meta.setAttribute('content', previousContent);
    };
  }, []);

  if (!validRoute) {
    return (
      <HistoryDetailError
        title={t('history.detail.invalidRouteTitle')}
        body={t('history.detail.invalidRouteBody')}
        backLabel={t('history.detail.backToHistory')}
      />
    );
  }

  if (featureFlags.isLoading || zonesLoading || cardsLoading || gatewayCardsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
        <p className="text-sm font-semibold text-[var(--text-tertiary)]">
          {t('history.detail.loading')}
        </p>
      </div>
    );
  }

  if (
    !featureFlags.historyEnabled
    || zonesError
    || cardsError
    || gatewayCardsError
    || (routeScope?.type === 'zone' && !resolvedZone)
    || !displayCard
    || !resolvedScope
  ) {
    return (
      <HistoryDetailError
        title={t('history.detail.notFoundTitle')}
        body={t('history.detail.notFoundBody')}
        backLabel={t('history.detail.backToHistory')}
      />
    );
  }

  return (
    <div className={`flex min-h-screen flex-col bg-[var(--bg)] ${isLandscape ? 'h-[100dvh] overflow-hidden' : ''}`}>
      <HistoryDetailHeader
        zoneName={resolvedZone?.name ?? null}
        card={displayCard}
        compact={isLandscape}
        settingsOpen={settingsOpen}
        canOpenAdvanced={selectableViewsForCard(displayCard).includes('advanced')}
        onSettingsToggle={() => setSettingsOpen((open) => !open)}
        onAdvancedView={handleAdvancedView}
        onResetRange={handleResetRange}
        onRefresh={handleRefresh}
        sources={sourceOptions}
        enabledSourceKeys={enabledSourceKeys}
        onSourceKeysChange={handleSourceKeysChange}
      />
      <main
        data-testid="history-detail-scroll-root"
        className={`flex min-h-0 flex-1 flex-col ${isLandscape ? 'overflow-hidden' : ''}`}
        onPointerDown={handleScrollRootPointerDown}
        onPointerDownCapture={handleScrollRootCalendarPointer}
        onMouseDownCapture={handleScrollRootCalendarMouse}
        onPointerUpCapture={handleScrollRootPointerUp}
        onClickCapture={handleScrollRootClick}
        onPointerCancel={() => {
          pullStartRef.current = null;
        }}
      >
        {!displayCard.availability.available && (
          <div className="mx-4 mt-4 rounded-lg border border-[var(--warning-bg)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-[var(--warning-text)]">
            {t('history.cardFrame.unavailable')}
          </div>
        )}
        <HistoryVisualizationSurface
          viewport={timeViewport.viewport}
          defaultRange={displayCard.defaultRange}
          activeView={selectedView}
          isZoomed={timeViewport.viewport.range.label === 'custom'}
          onViewportChange={handleViewportChange}
          onInspect={handleInspectTimestamp}
          onVisualWindow={setVisualWindow}
          onCardSwipe={handleCardSwipe}
          onViewSwipe={handleViewSwipe}
          onMonthSwipe={handleMonthSwipe}
          rangeLabel={visibleRangeLabel}
          aggregationLabel={formatAggregationLabel(t, timeViewport.viewport.aggregation)}
        >
          <div
            data-testid="view-mode-label"
            className="pointer-events-none absolute left-1 top-1 z-10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-tertiary)]"
            style={{ backgroundColor: 'color-mix(in srgb, var(--bg) 82%, transparent)' }}
          >
            {viewModeLabel}
          </div>
          {singleDeviceName && (
            <div
              data-testid="single-device-label"
              className="pointer-events-none absolute right-1 top-1 z-10 rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
              style={{ backgroundColor: 'color-mix(in srgb, var(--bg) 82%, transparent)' }}
            >
              {singleDeviceName}
            </div>
          )}
          <HistoryCardVisualization
            card={displayCard}
            data={cardData.data}
            selectedView={selectedView}
            isLoading={cardData.isLoading}
            error={cardData.error}
            advancedData={advancedData.data}
            advancedIsLoading={advancedData.isLoading}
            advancedError={advancedData.error}
            window={chartWindow}
            onInspectDate={handleInspectDate}
            selectedCalendarDate={inspectorSelection?.kind === 'date' ? inspectorSelection.date : null}
          />
        </HistoryVisualizationSurface>
      </main>
      <HistoryInspectorSheet
        card={displayCard}
        data={cardData.data}
        selection={inspectorSelection}
        isOpen={Boolean(inspectorSelection)}
        onClose={handleCloseInspector}
      />
    </div>
  );
};
