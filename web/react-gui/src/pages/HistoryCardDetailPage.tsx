import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { HistoryCardVisualization } from '../components/history/HistoryCardVisualization';
import type { HistoryCalendarDateSelection } from '../components/history/visualizations/HistoryMonthCalendarView';
import { HistoryDetailHeader } from '../components/history/mobile/HistoryDetailHeader';
import { HistoryRangeSegmentedControl } from '../components/history/mobile/HistoryRangeSegmentedControl';
import { HistorySourceFilter } from '../components/history/mobile/HistorySourceFilter';
import { HistoryVisualizationSurface } from '../components/history/mobile/HistoryVisualizationSurface';
import { HistoryViewModeSegmentedControl } from '../components/history/mobile/HistoryViewModeSegmentedControl';
import { useFeatureFlags } from '../history/useFeatureFlags';
import { useHistoryCardData } from '../history/useHistoryCardData';
import { useHistoryCards } from '../history/useHistoryCards';
import { setTimeViewportRange, useTimeViewport } from '../history/useTimeViewport';
import { historyAPI, irrigationZonesAPI } from '../services/api';
import type { HistoryCardDataScope } from '../history/useHistoryCardData';
import type {
  HistoryCardSummary,
  HistoryCardSummaryResponse,
  HistoryCalendarDay,
  HistoryCalendarMarker,
  HistoryRangeLabel,
  HistoryViewMode,
} from '../history/types';
import type { IrrigationZone } from '../types/farming';

const zonesFetcher = () => irrigationZonesAPI.getAll();
const DETAIL_PULL_REFRESH_THRESHOLD_PX = 96;
const DETAIL_PULL_REFRESH_MAX_HORIZONTAL_PX = 48;
const DETAIL_PULL_REFRESH_SCROLL_TOP_TOLERANCE_PX = 2;
const HISTORY_VISUALIZATION_SURFACE_SELECTOR = '[data-history-visualization-surface="true"]';

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;
type PullRefreshStart = {
  pointerId: number;
  x: number;
  y: number;
  refreshed: boolean;
};
type InspectorSelection =
  | { kind: 'timestamp'; timestamp: string }
  | { kind: 'date'; date: string; day: HistoryCalendarDay | null };

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
  if (!(target instanceof Element)) return null;
  const dateCell = target.closest('[data-history-calendar-date]');
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
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const pullStartRef = useRef<PullRefreshStart | null>(null);
  const featureFlags = useFeatureFlags();
  const zoneId = Number(rawZoneId);
  const gatewayEui = typeof rawGatewayEui === 'string' && rawGatewayEui.trim() ? rawGatewayEui : null;
  const cardId = decodeRouteCardId(rawCardId);
  const validZoneRoute = Number.isInteger(zoneId) && zoneId > 0 && Boolean(cardId);
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

  const resolvedZone = useMemo(
    () => (routeScope?.type === 'zone' ? (zones ?? []).find((zone) => zone.id === routeScope.zoneId) ?? null : null),
    [routeScope, zones],
  );
  const resolvedCard = useMemo(
    () => routeCards.find((card) => card.cardId === cardId) ?? null,
    [cardId, routeCards],
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
  const primaryViews = useMemo(
    () => (displayCard ? primaryViewModes(displayCard.views) : []),
    [displayCard],
  );
  const [userSelectedView, setUserSelectedView] = useState<{ cardId: string; view: HistoryViewMode } | null>(null);
  const [selectedSource, setSelectedSource] = useState<{ cardId: string; sourceKey: string | null } | null>(null);
  const defaultRange = displayCard?.defaultRange ?? '24h';
  const timeViewport = useTimeViewport(
    defaultRange,
    displayCard ? `${displayCard.cardId}:${defaultRange}` : defaultRange,
  );
  const selectedView = useMemo(() => {
    if (
      displayCard
      && userSelectedView?.cardId === displayCard.cardId
      && primaryViews.includes(userSelectedView.view)
    ) {
      return userSelectedView.view;
    }
    return defaultPrimaryViewForCard(displayCard);
  }, [displayCard, primaryViews, userSelectedView]);
  const selectedSourceKey = displayCard && selectedSource?.cardId === displayCard.cardId
    ? selectedSource.sourceKey
    : null;
  const cardData = useHistoryCardData({
    scope: resolvedScope,
    cardId: displayCard?.cardId ?? null,
    view: selectedView,
    range: timeViewport.viewport.range,
    aggregation: timeViewport.viewport.aggregation,
    overlays: [],
    sourceKey: selectedSourceKey,
    enabled: Boolean(displayCard?.availability.available && resolvedScope),
  });
  const [inspectorSelection, setInspectorSelection] = useState<InspectorSelection | null>(null);
  const calendarDaysByDate = useMemo(() => {
    const days = cardData.data?.calendar?.days;
    return new Map((Array.isArray(days) ? days : []).map((day) => [day.date, day]));
  }, [cardData.data?.calendar?.days]);

  const handleInspectTimestamp = useCallback((selection: { timestamp: string }) => {
    setInspectorSelection({ kind: 'timestamp', timestamp: selection.timestamp });
  }, []);

  const handleInspectDate = useCallback((selection: HistoryCalendarDateSelection) => {
    setInspectorSelection({ kind: 'date', date: selection.date, day: selection.day });
  }, []);

  const handleScrollRootClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const date = calendarDateFromTarget(event.target);
    if (date) setInspectorSelection({ kind: 'date', date, day: calendarDaysByDate.get(date) ?? null });
  }, [calendarDaysByDate]);

  const handleRangeChange = useCallback((range: HistoryRangeLabel) => {
    timeViewport.setViewport(
      setTimeViewportRange(range, new Date(), timeViewport.viewport.range.timezone),
    );
  }, [timeViewport]);

  const handleViewChange = useCallback((view: HistoryViewMode) => {
    if (!displayCard) return;
    setUserSelectedView({ cardId: displayCard.cardId, view });
  }, [displayCard]);

  const handleSourceChange = useCallback((sourceKey: string | null) => {
    if (!displayCard) return;
    setSelectedSource({ cardId: displayCard.cardId, sourceKey });
  }, [displayCard]);

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
      void cardData.refresh();
    }
    pullStartRef.current = null;
  }, [calendarDaysByDate, cardData, isVisualizationEvent]);

  useEffect(() => {
    if (!featureFlags.historyEnabled || routeScope?.type !== 'zone' || !resolvedCard || !cardId) return;
    historyAPI.markZoneCardOpened(routeScope.zoneId, cardId).catch(() => undefined);
  }, [cardId, featureFlags.historyEnabled, resolvedCard, routeScope]);

  useEffect(() => {
    if (!displayCard || selectedSource?.cardId !== displayCard.cardId || selectedSource.sourceKey === null) return;
    const validSource = (displayCard.sourceDevices ?? []).some((device) => device.sourceKey === selectedSource.sourceKey);
    if (!validSource) setSelectedSource(null);
  }, [displayCard, selectedSource]);

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
      />
      <main
        data-testid="history-detail-scroll-root"
        className="flex min-h-[calc(100vh-4rem)] flex-col gap-4 px-4 py-4"
        onPointerDown={handleScrollRootPointerDown}
        onPointerUpCapture={handleScrollRootPointerUp}
        onClickCapture={handleScrollRootClick}
        onPointerCancel={() => {
          pullStartRef.current = null;
        }}
      >
        <section className="space-y-3">
          <HistoryRangeSegmentedControl
            activeRange={timeViewport.viewport.range.label}
            supportedRanges={displayCard.supportedRanges}
            onRangeChange={handleRangeChange}
          />
          {primaryViews.length > 0 && (
            <HistoryViewModeSegmentedControl
              activeView={selectedView}
              views={displayCard.views}
              onViewChange={handleViewChange}
            />
          )}
          <HistorySourceFilter
            card={displayCard}
            selectedSourceKey={selectedSourceKey}
            onSourceChange={handleSourceChange}
          />
        </section>
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
              onInspectDate={handleInspectDate}
            />
          </HistoryVisualizationSurface>
        </div>
        <section
          data-testid="history-detail-inspector"
          className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-tertiary)]"
        >
          {inspectorSelection?.kind === 'timestamp' && (
            <p className="font-semibold">{inspectorSelection.timestamp}</p>
          )}
          {inspectorSelection?.kind === 'date' && (
            <div className="space-y-1">
              <p className="font-bold text-[var(--text)]">{inspectorSelection.date}</p>
              {inspectorSelection.day ? (
                <>
                  <p className="font-semibold text-[var(--text)]">
                    {calendarStateLabel(t, inspectorSelection.day)}
                  </p>
                  <p>{displayCard ? calendarSummaryLabel(t, displayCard, inspectorSelection.day) : null}</p>
                  <p>{calendarCoverageLabel(t, inspectorSelection.day)}</p>
                  {inspectorSelection.day.markers && inspectorSelection.day.markers.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {inspectorSelection.day.markers.map((marker, index) => (
                        <span
                          key={`${marker.type}-${marker.labelKey}-${index}`}
                          className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-semibold"
                        >
                          {calendarMarkerLabel(t, marker)}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="font-semibold">{t('history.calendar.state.no_data')}</p>
              )}
            </div>
          )}
          {!inspectorSelection && t('history.detail.inspectorPlaceholder')}
        </section>
      </main>
    </div>
  );
};
