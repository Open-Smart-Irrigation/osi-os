import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HistoryCardVisualization } from '../HistoryCardVisualization';
import { HistoryOverviewStrip } from './HistoryOverviewStrip';
import { HistoryCompareGrid } from './HistoryCompareGrid';
import {
  resetViewport,
  zoomViewport,
  panViewport,
  type HistoryViewport,
  type ViewportBounds,
} from '../../../history/historyViewport';
import { useChartMouseInteractions } from '../../../history/useChartMouseInteractions';
import { useHistoryCardAdvancedData } from '../../../history/useHistoryCardAdvancedData';
import { useHistoryCardData } from '../../../history/useHistoryCardData';
import {
  defaultDesktopView,
  desktopAggregationForView,
  desktopBoundsForData,
  desktopCardHeaderTitle,
  desktopRailCardLabel,
  desktopSourceOptions,
  selectableDesktopViews,
} from '../../../history/desktopHistory';
import type { HistoryCardDataScope } from '../../../history/useHistoryCardData';
import type {
  HistoryCardSummary,
  HistoryRangeLabel,
  HistoryRangeSelection,
  HistoryViewMode,
} from '../../../history/types';
import type { HistoryVisualWindow } from '../../../history/useTimeViewport';

type DesktopMode = 'focus' | 'compare';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PRESET_SPANS_MS: Record<string, number> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  season: 180 * DAY_MS,
};

const PRESET_LABELS: Array<{ key: HistoryRangeLabel; label: string }> = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'season', label: 'Season' },
];

function defaultSpanMsForRange(range: HistoryRangeLabel): number {
  return PRESET_SPANS_MS[range] ?? 24 * HOUR_MS;
}

export interface HistoryDesktopDetailProps {
  cards: HistoryCardSummary[];
  selectedCard: HistoryCardSummary;
  zoneName: string | null;
  scope: HistoryCardDataScope;
  onCardSelect: (card: HistoryCardSummary) => void;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

export const HistoryDesktopDetail: React.FC<HistoryDesktopDetailProps> = ({
  cards,
  selectedCard,
  zoneName,
  scope,
  onCardSelect,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;

  const defaultRange = selectedCard.defaultRange ?? '24h';
  const defaultSpanMs = defaultSpanMsForRange(defaultRange);

  const now = Date.now();
  const initialBounds: ViewportBounds = { minMs: now - defaultSpanMs * 2, maxMs: now };
  const [bounds, setBounds] = useState<ViewportBounds>(initialBounds);
  const [viewport, setViewport] = useState<HistoryViewport>(() =>
    resetViewport(initialBounds, defaultSpanMs),
  );
  const [activePreset, setActivePreset] = useState<HistoryRangeLabel>(defaultRange as HistoryRangeLabel);
  const [selectedView, setSelectedView] = useState<HistoryViewMode>(() => defaultDesktopView(selectedCard));
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const [mode, setMode] = useState<DesktopMode>('focus');
  const viewOptions = useMemo(() => selectableDesktopViews(selectedCard), [selectedCard]);
  const sourceOptions = useMemo(() => desktopSourceOptions(selectedCard), [selectedCard]);
  const selectedViewForCard = useMemo(() => {
    const allowedViews = viewOptions.map((entry) => entry.view);
    return allowedViews.includes(selectedView) ? selectedView : defaultDesktopView(selectedCard);
  }, [selectedCard, selectedView, viewOptions]);
  const shouldRenderAdvanced = selectedViewForCard === 'advanced';

  useEffect(() => {
    setSelectedView(defaultDesktopView(selectedCard));
  }, [selectedCard.cardId, selectedCard.defaultView]);

  useEffect(() => {
    setSelectedSourceKey(null);
  }, [selectedCard.cardId]);

  // Derive request range from viewport (shared between focus and compare modes)
  const rangeRequest: HistoryRangeSelection = useMemo(
    () => ({
      label: 'custom' as HistoryRangeLabel,
      from: new Date(bounds.minMs).toISOString(),
      to: new Date(bounds.maxMs).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    }),
    [bounds],
  );

  const cardData = useHistoryCardData({
    scope,
    cardId: selectedCard.cardId,
    view: selectedViewForCard,
    range: rangeRequest,
    aggregation: desktopAggregationForView(selectedViewForCard),
    overlays: [],
    sourceKey: selectedSourceKey,
    enabled: Boolean(selectedCard.availability.available && !shouldRenderAdvanced),
  });

  const advancedData = useHistoryCardAdvancedData({
    scope,
    cardId: selectedCard.cardId,
    view: selectedViewForCard,
    range: rangeRequest,
    aggregation: desktopAggregationForView(selectedViewForCard),
    overlays: [],
    sourceKey: selectedSourceKey,
    enabled: Boolean(selectedCard.availability.available && shouldRenderAdvanced),
  });

  // Derive bounds from loaded series timestamps (fall back to preset range)
  const derivedBounds = useMemo(() => {
    const series = cardData.data?.series ?? [];
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const s of series) {
      for (const pt of s.points ?? []) {
        const ms = Date.parse(pt.t);
        if (Number.isFinite(ms)) {
          if (ms < minMs) minMs = ms;
          if (ms > maxMs) maxMs = ms;
        }
      }
    }
    if (Number.isFinite(minMs) && Number.isFinite(maxMs) && maxMs > minMs) {
      return { minMs, maxMs };
    }
    return null;
  }, [cardData.data]);

  const effectiveBounds = desktopBoundsForData(bounds, derivedBounds);

  // Chart window passed to visualization (matches HistoryVisualWindow shape)
  const chartWindow: HistoryVisualWindow = viewport;

  const handleReset = useCallback(() => {
    const nextSpan = defaultSpanMsForRange(activePreset);
    setViewport(resetViewport(effectiveBounds, nextSpan));
  }, [activePreset, effectiveBounds]);

  const { ref: chartRef } = useChartMouseInteractions({
    viewport,
    bounds: effectiveBounds,
    onViewportChange: setViewport,
    onReset: handleReset,
  });

  const handlePreset = useCallback((rangeLabel: HistoryRangeLabel) => {
    const spanMs = defaultSpanMsForRange(rangeLabel);
    const nowMs = Date.now();
    const nextBounds: ViewportBounds = { minMs: nowMs - spanMs * 4, maxMs: nowMs };
    setBounds(nextBounds);
    setViewport(resetViewport(nextBounds, spanMs));
    setActivePreset(rangeLabel);
  }, []);

  const handleZoomIn = useCallback(() => {
    const center = (viewport.fromMs + viewport.toMs) / 2;
    setViewport(zoomViewport(viewport, effectiveBounds, center, 0.8));
  }, [viewport, effectiveBounds]);

  const handleZoomOut = useCallback(() => {
    const center = (viewport.fromMs + viewport.toMs) / 2;
    setViewport(zoomViewport(viewport, effectiveBounds, center, 1.25));
  }, [viewport, effectiveBounds]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const span = viewport.toMs - viewport.fromMs;
      const center = (viewport.fromMs + viewport.toMs) / 2;
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          setViewport(panViewport(viewport, effectiveBounds, span * 0.1));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setViewport(panViewport(viewport, effectiveBounds, -span * 0.1));
          break;
        case '+':
        case '=':
          e.preventDefault();
          setViewport(zoomViewport(viewport, effectiveBounds, center, 0.8));
          break;
        case '-':
          e.preventDefault();
          setViewport(zoomViewport(viewport, effectiveBounds, center, 1.25));
          break;
        case '0':
          e.preventDefault();
          handleReset();
          break;
        default:
          break;
      }
    },
    [viewport, effectiveBounds, handleReset],
  );

  const headerTitle = desktopCardHeaderTitle(selectedCard, zoneName);

  return (
    <div className="flex h-full min-h-0 flex-row overflow-hidden">
      {/* Left rail: card list */}
      <nav
        aria-label={t('history.desktop.railLabel', { defaultValue: 'History cards' })}
        className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)]"
      >
        <ul className="flex flex-col gap-0.5 p-2">
          {cards.map((card) => {
            const cardTitle = desktopRailCardLabel(card);
            const isSelected = card.cardId === selectedCard.cardId;
            return (
              <li key={card.cardId}>
                <button
                  type="button"
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => onCardSelect(card)}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                    isSelected
                      ? 'bg-[var(--primary)] text-white'
                      : 'text-[var(--text)] hover:bg-[var(--border)] hover:text-[var(--text)]'
                  }`}
                >
                  {cardTitle}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-[var(--text)]">{headerTitle}</h2>
            {sourceOptions.length > 0 ? (
              <div
                role="group"
                aria-label={t('history.desktop.sourceSelectorLabel', { defaultValue: 'Sources' })}
                className="flex overflow-hidden rounded border border-[var(--border)]"
              >
                {sourceOptions.map((source) => (
                  <button
                    key={source.key ?? 'all'}
                    type="button"
                    aria-pressed={selectedSourceKey === source.key}
                    onClick={() => setSelectedSourceKey(source.key)}
                    className={`px-2 py-1 text-xs font-semibold transition-colors ${
                      selectedSourceKey === source.key
                        ? 'bg-[var(--primary)] text-white'
                        : 'bg-[var(--secondary-bg)] text-[var(--text)] hover:bg-[var(--border)]'
                    }`}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
            ) : null}
            {/* Focus | Compare segmented control */}
            <div
              role="group"
              aria-label={t('history.desktop.modeLabel', { defaultValue: 'View mode' })}
              className="flex overflow-hidden rounded border border-[var(--border)]"
            >
              {(['focus', 'compare'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  data-testid={`mode-${m}`}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                    mode === m
                      ? 'bg-[var(--primary)] text-white'
                      : 'bg-[var(--secondary-bg)] text-[var(--text)] hover:bg-[var(--border)]'
                  }`}
                >
                  {m === 'focus'
                    ? t('history.desktop.modeFocus', { defaultValue: 'Focus' })
                    : t('history.desktop.modeCompare', { defaultValue: 'Compare' })}
                </button>
              ))}
            </div>
          </div>
          {/* Range presets + zoom — always visible so the shared viewport can be adjusted in either mode */}
          <div className="flex items-center gap-1">
            {mode === 'focus' ? (
              <div
                role="group"
                aria-label={t('history.desktop.viewSelectorLabel', { defaultValue: 'Card view' })}
                className="mr-2 flex overflow-hidden rounded border border-[var(--border)]"
              >
                {viewOptions.map(({ view, labelKey }) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={selectedViewForCard === view}
                    onClick={() => setSelectedView(view)}
                    className={`px-2 py-1 text-xs font-semibold transition-colors ${
                      selectedViewForCard === view
                        ? 'bg-[var(--primary)] text-white'
                        : 'bg-[var(--secondary-bg)] text-[var(--text)] hover:bg-[var(--border)]'
                    }`}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            ) : null}
            {PRESET_LABELS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                aria-pressed={activePreset === key}
                onClick={() => handlePreset(key)}
                className={`rounded px-2 py-1 text-xs font-semibold transition-colors ${
                  activePreset === key
                    ? 'bg-[var(--primary)] text-white'
                    : 'border border-[var(--border)] bg-[var(--secondary-bg)] text-[var(--text)] hover:bg-[var(--border)]'
                }`}
              >
                {label}
              </button>
            ))}
            {/* Zoom controls */}
            <div className="ml-2 flex items-center gap-1">
              <button
                type="button"
                aria-label={t('history.desktop.zoomIn', { defaultValue: 'Zoom in' })}
                onClick={handleZoomIn}
                className="rounded border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-xs font-bold text-[var(--text)] hover:bg-[var(--border)]"
              >
                +
              </button>
              <button
                type="button"
                aria-label={t('history.desktop.zoomOut', { defaultValue: 'Zoom out' })}
                onClick={handleZoomOut}
                className="rounded border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-xs font-bold text-[var(--text)] hover:bg-[var(--border)]"
              >
                −
              </button>
              <button
                type="button"
                aria-label={t('history.desktop.resetZoom', { defaultValue: 'Reset zoom' })}
                onClick={handleReset}
                className="rounded border border-[var(--border)] bg-[var(--secondary-bg)] px-2 py-1 text-xs font-semibold text-[var(--text)] hover:bg-[var(--border)]"
              >
                ↺
              </button>
            </div>
          </div>
        </div>

        {mode === 'focus' ? (
          <>
            {/* Chart region — focus mode */}
            <div
              ref={chartRef}
              data-testid="desktop-chart-surface"
              tabIndex={0}
              aria-label={t('history.desktop.chartSurfaceLabel', { defaultValue: 'History chart, use arrow keys to pan and plus or minus to zoom' })}
              onKeyDown={handleKeyDown}
              className="relative flex min-h-0 flex-1 flex-col cursor-crosshair overflow-hidden bg-[var(--bg)] outline-none focus:ring-2 focus:ring-[var(--primary)]"
              style={{ userSelect: 'none' }}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <HistoryCardVisualization
                  card={selectedCard}
                  data={cardData.data}
                  selectedView={selectedViewForCard}
                  isLoading={cardData.isLoading}
                  error={cardData.error}
                  advancedData={advancedData.data}
                  advancedIsLoading={advancedData.isLoading}
                  advancedError={advancedData.error}
                  window={chartWindow}
                />
              </div>
            </div>

            {/* Overview strip */}
            <div className="shrink-0 px-3 pb-2">
              <HistoryOverviewStrip
                bounds={effectiveBounds}
                viewport={viewport}
                onChange={setViewport}
              />
            </div>
          </>
        ) : (
          /* Compare mode — shared viewport is passed to all panels */
          <div className="min-h-0 flex-1 overflow-hidden">
            <HistoryCompareGrid
              cards={cards}
              scope={scope}
              viewport={viewport}
              rangeRequest={rangeRequest}
            />
          </div>
        )}
      </div>
    </div>
  );
};
