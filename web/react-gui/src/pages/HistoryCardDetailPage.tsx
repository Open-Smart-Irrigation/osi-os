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
import { useFeatureFlags } from '../history/useFeatureFlags';
import { useHistoryCardAdvancedData } from '../history/useHistoryCardAdvancedData';
import { useHistoryCardData } from '../history/useHistoryCardData';
import { orderHistoryCards, useHistoryCards } from '../history/useHistoryCards';
import { setTimeViewportRange, useTimeViewport } from '../history/useTimeViewport';
import { historyAPI, irrigationZonesAPI } from '../services/api';
import type { HistoryCardDataScope } from '../history/useHistoryCardData';
import type {
  HistoryCardSummary,
  HistoryCardSummaryResponse,
  HistoryRangeLabel,
  HistoryViewMode,
} from '../history/types';
import type { IrrigationZone } from '../types/farming';

const zonesFetcher = () => irrigationZonesAPI.getAll();
const DETAIL_PULL_REFRESH_THRESHOLD_PX = 96;
const DETAIL_PULL_REFRESH_MAX_HORIZONTAL_PX = 48;
const DETAIL_PULL_REFRESH_SCROLL_TOP_TOLERANCE_PX = 2;
const DETAIL_CARD_SWIPE_THRESHOLD_PX = 72;
const DETAIL_CARD_SWIPE_VERTICAL_RATIO = 0.65;
const GATEWAY_ROUTE_CARD_ID = 'gateway-hub';
const HISTORY_VISUALIZATION_SURFACE_SELECTOR = '[data-history-visualization-surface="true"]';
const HISTORY_CARD_SWIPE_IGNORE_SELECTOR = [
  HISTORY_VISUALIZATION_SURFACE_SELECTOR,
  '[data-history-calendar-date]',
  '[role="grid"]',
  'a',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="menu"]',
].join(',');

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type PullRefreshStart = {
  pointerId: number;
  x: number;
  y: number;
  refreshed: boolean;
};
type CardSwipeStart = {
  pointerId: number;
  x: number;
  y: number;
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

function primaryViewModes(views: readonly HistoryViewMode[]): HistoryViewMode[] {
  return views.filter((view) => view !== 'advanced');
}

function defaultPrimaryViewForCard(card: HistoryCardSummary | null): HistoryViewMode {
  if (!card) return 'line-chart';
  if (card.defaultView !== 'advanced') return card.defaultView;
  return primaryViewModes(card.views)[0] ?? card.defaultView;
}

function formatRangeLabel(t: HistoryTranslate, range: HistoryRangeLabel): string {
  if (range === 'custom') return t('history.rangeShort.custom', { defaultValue: 'Custom' });
  return t(`history.rangeShort.${range}`);
}

function formatAggregationLabel(t: HistoryTranslate, aggregation: string): string {
  return t(`history.metadata.aggregation.${aggregation}`);
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

function isCardSwipeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest(HISTORY_CARD_SWIPE_IGNORE_SELECTOR);
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
  const cardSwipeStartRef = useRef<CardSwipeStart | null>(null);
  const featureFlags = useFeatureFlags();
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const defaultRange = displayCard?.defaultRange ?? '24h';
  const timeViewport = useTimeViewport(
    defaultRange,
    displayCard ? `${displayCard.cardId}:${defaultRange}` : defaultRange,
  );
  const selectedView = useMemo(() => {
    if (
      displayCard
      && userSelectedView?.cardId === displayCard.cardId
      && displayCard.views.includes(userSelectedView.view)
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
  const cardData = useHistoryCardData({
    scope: resolvedScope,
    cardId: displayCard?.cardId ?? null,
    view: selectedView,
    range: timeViewport.viewport.range,
    aggregation: timeViewport.viewport.aggregation,
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
    timeViewport.setViewport(
      setTimeViewportRange(displayCard.defaultRange, new Date(), timeViewport.viewport.range.timezone),
    );
  }, [displayCard, timeViewport]);

  const handleAdvancedView = useCallback(() => {
    if (!displayCard || !displayCard.views.includes('advanced')) return;
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

  const isVisualizationEvent = useCallback((target: EventTarget | null): boolean => {
    return target instanceof Element && Boolean(target.closest(HISTORY_VISUALIZATION_SURFACE_SELECTOR));
  }, []);

  const handleScrollRootPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (
      routeScope?.type === 'zone'
      && isPullRefreshPointerType(event.pointerType)
      && isCardSwipeTarget(event.target)
    ) {
      cardSwipeStartRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    } else {
      cardSwipeStartRef.current = null;
    }

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
  }, [isVisualizationEvent, routeScope?.type]);

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

    const swipeStart = cardSwipeStartRef.current;
    if (
      routeScope?.type === 'zone'
      && displayCard
      && swipeStart
      && swipeStart.pointerId === event.pointerId
      && isPullRefreshPointerType(event.pointerType)
      && isCardSwipeTarget(event.target)
    ) {
      const deltaX = event.clientX - swipeStart.x;
      const deltaY = Math.abs(event.clientY - swipeStart.y);
      const isHorizontalSwipe = Math.abs(deltaX) >= DETAIL_CARD_SWIPE_THRESHOLD_PX
        && deltaY <= Math.abs(deltaX) * DETAIL_CARD_SWIPE_VERTICAL_RATIO;
      if (isHorizontalSwipe) {
        const currentIndex = orderedRouteCards.findIndex((card) => card.cardId === displayCard.cardId);
        if (currentIndex >= 0 && orderedRouteCards.length > 1) {
          const nextIndex = deltaX < 0
            ? (currentIndex + 1) % orderedRouteCards.length
            : (currentIndex - 1 + orderedRouteCards.length) % orderedRouteCards.length;
          const nextCard = orderedRouteCards[nextIndex];
          cardSwipeStartRef.current = null;
          pullStartRef.current = null;
          navigate(`/history/zones/${routeScope.zoneId}/cards/${encodeURIComponent(routeCardIdForCard(nextCard))}`);
          return;
        }
      }
    }
    cardSwipeStartRef.current = null;

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
  }, [calendarDaysByDate, displayCard, handleRefresh, isVisualizationEvent, navigate, orderedRouteCards, routeScope]);

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
    <div className="min-h-screen bg-[var(--bg)]">
      <HistoryDetailHeader
        zoneName={resolvedZone?.name ?? null}
        card={displayCard}
        backHref="/history"
        settingsOpen={settingsOpen}
        canOpenAdvanced={displayCard.views.includes('advanced')}
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
        className="flex min-h-[calc(100vh-4rem)] flex-col gap-4 px-4 py-4"
        onPointerDown={handleScrollRootPointerDown}
        onPointerDownCapture={handleScrollRootCalendarPointer}
        onMouseDownCapture={handleScrollRootCalendarMouse}
        onPointerUpCapture={handleScrollRootPointerUp}
        onClickCapture={handleScrollRootClick}
        onPointerCancel={() => {
          pullStartRef.current = null;
          cardSwipeStartRef.current = null;
        }}
      >
        <div
          data-testid="view-mode-label"
          className="py-1 text-center text-xs font-semibold text-[var(--text-tertiary)]"
        >
          {formatViewLabel(t, selectedView)} · {formatRangeLabel(t, timeViewport.viewport.range.label)}
        </div>
        <div className="flex-1">
          {!displayCard.availability.available && (
            <div className="mb-4 rounded-lg border border-[var(--warning-bg)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-[var(--warning-text)]">
              {t('history.cardFrame.unavailable')}
            </div>
          )}
          <HistoryVisualizationSurface
            viewport={timeViewport.viewport}
            defaultRange={displayCard.defaultRange}
            onViewportChange={timeViewport.setViewport}
            onInspect={handleInspectTimestamp}
            rangeLabel={formatRangeLabel(t, timeViewport.viewport.range.label)}
            aggregationLabel={formatAggregationLabel(t, timeViewport.viewport.aggregation)}
          >
            <HistoryCardVisualization
              card={displayCard}
              data={cardData.data}
              selectedView={selectedView}
              isLoading={cardData.isLoading}
              error={cardData.error}
              advancedData={advancedData.data}
              advancedIsLoading={advancedData.isLoading}
              advancedError={advancedData.error}
              onInspectDate={handleInspectDate}
              selectedCalendarDate={inspectorSelection?.kind === 'date' ? inspectorSelection.date : null}
            />
          </HistoryVisualizationSurface>
        </div>
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
