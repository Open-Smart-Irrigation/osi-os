import React from 'react';
import { useTranslation } from 'react-i18next';
import { AdvancedViewPanel } from './AdvancedViewPanel';
import { CalendarView } from './CalendarView';
import { InterpretationList } from './InterpretationList';
import { DendroGrowthTimelineView } from './visualizations/DendroGrowthTimelineView';
import { DendroLineChartView } from './visualizations/DendroLineChartView';
import { DendroStressEventsView } from './visualizations/DendroStressEventsView';
import { DailyMinMaxView } from './visualizations/DailyMinMaxView';
import { EnvironmentLineChartView } from './visualizations/EnvironmentLineChartView';
import { GatewayStatusOverviewView } from './visualizations/GatewayStatusOverviewView';
import type { HistoryCalendarDateSelection } from './visualizations/HistoryMonthCalendarView';
import { IrrigationEventTimelineView } from './visualizations/IrrigationEventTimelineView';
import { SoilIrrigationResponseView } from './visualizations/SoilIrrigationResponseView';
import { SoilLineChartView } from './visualizations/SoilLineChartView';
import { SoilProfileView } from './visualizations/SoilProfileView';
import { useJournalMarkers } from './useJournalMarkers';
import { JournalMarkerLane } from '../journal/markers/JournalMarkerLane';
import type {
  HistoryAdvancedResponse,
  HistoryCardDataResponse,
  HistoryCardSummary,
  HistoryViewMode,
} from '../../history/types';
import type { HistoryVisualWindow } from '../../history/useTimeViewport';

interface HistoryCardVisualizationProps {
  card: HistoryCardSummary;
  data: HistoryCardDataResponse | undefined;
  selectedView: HistoryViewMode;
  isLoading?: boolean;
  error?: unknown;
  advancedData?: HistoryAdvancedResponse | undefined;
  advancedIsLoading?: boolean;
  advancedError?: unknown;
  window?: HistoryVisualWindow;
  onInspectDate?: (selection: HistoryCalendarDateSelection) => void;
  selectedCalendarDate?: string | null;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function formatViewLabel(t: HistoryTranslate, view: HistoryViewMode): string {
  return t(`history.viewMode.${view}`);
}

function getErrorMessage(t: HistoryTranslate, error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return t('history.cardFrame.cardDataUnknownError');
}

/**
 * The zone UUID a card's journal markers are scoped to, when the backend
 * reports one on the card's metadata (see `history-api-router-fn`). Journal
 * entries are recorded per irrigation zone, not per history card, so this is
 * the join key between the two domains.
 */
function cardZoneUuid(card: HistoryCardSummary): string | null {
  const value = (card.metadata as { zoneUuid?: unknown } | undefined)?.zoneUuid;
  return typeof value === 'string' && value.trim() ? value : null;
}

export const HistoryCardVisualization: React.FC<HistoryCardVisualizationProps> = ({
  card,
  data,
  selectedView,
  isLoading = false,
  error = null,
  advancedData,
  advancedIsLoading = false,
  advancedError = null,
  window: chartWindow,
  onInspectDate,
  selectedCalendarDate = null,
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const shouldRenderSoilProfile = card.cardType === 'soil' && selectedView === 'soil-profile';
  const shouldRenderSoilLineChart = card.cardType === 'soil' && selectedView === 'line-chart';
  const shouldRenderSoilIrrigationResponse = card.cardType === 'soil' && selectedView === 'irrigation-response';
  const shouldRenderDendroGrowth = card.cardType === 'dendro' && selectedView === 'growth-timeline';
  const shouldRenderDendroLineChart = card.cardType === 'dendro' && selectedView === 'line-chart';
  const shouldRenderDendroStressEvents = card.cardType === 'dendro' && selectedView === 'stress-events';
  const shouldRenderEnvironmentLineChart = card.cardType === 'environment' && selectedView === 'line-chart';
  const shouldRenderDailyMinMax = card.cardType === 'environment' && selectedView === 'daily-min-max';
  const shouldRenderGatewayStatus = card.cardType === 'gateway' && selectedView === 'status-overview';
  const shouldRenderIrrigationEventTimeline = card.cardType === 'irrigation' && selectedView === 'event-timeline';
  const shouldRenderCalendar = selectedView === 'calendar';
  const shouldRenderAdvanced = selectedView === 'advanced';
  const currentData = data?.cardId === card.cardId && data.cardType === card.cardType ? data : undefined;

  // Journal markers only make sense on the true time-axis chart surfaces
  // (the views that receive `window={chartWindow}` — see chartAxis.ts). This
  // is also the ONLY journal request path for the marker lane: chart views
  // below stay fetch-free and simply render the pre-fetched `markers`.
  const shouldRenderTimeChart = shouldRenderSoilLineChart || shouldRenderDendroGrowth ||
    shouldRenderDendroLineChart || shouldRenderEnvironmentLineChart || shouldRenderDailyMinMax;
  const journalZoneUuid = cardZoneUuid(card);
  const journalMarkersEnabled = shouldRenderTimeChart && Boolean(journalZoneUuid) && Boolean(chartWindow);
  const journalMarkers = useJournalMarkers({
    zoneUuid: journalZoneUuid,
    fromMs: chartWindow?.fromMs ?? NaN,
    toMs: chartWindow?.toMs ?? NaN,
    enabled: journalMarkersEnabled,
  });
  const journalLane = journalMarkersEnabled && chartWindow ? (
    <JournalMarkerLane
      markers={journalMarkers.markers}
      fromMs={chartWindow.fromMs}
      toMs={chartWindow.toMs}
      loading={journalMarkers.loading}
      error={journalMarkers.error}
      onRetry={() => { void journalMarkers.retry(); }}
    />
  ) : null;

  if (isLoading && !currentData) {
    return (
      <div className="mt-4 flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6 text-center">
        <p className="text-sm font-semibold text-[var(--text)]">
          {t('history.cardFrame.cardDataLoading')}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 rounded-lg border border-[var(--warning-bg)] bg-[var(--warning-bg)] px-4 py-3 text-sm text-[var(--warning-text)]">
        {t('history.cardFrame.cardDataError', { message: getErrorMessage(t, error) })}
      </div>
    );
  }

  if (shouldRenderSoilProfile && currentData) {
    return <SoilProfileView profiles={Array.isArray(currentData.profiles) ? currentData.profiles : []} />;
  }

  if (shouldRenderSoilLineChart) {
    return (
      <>
        <SoilLineChartView data={currentData} window={chartWindow} />
        {journalLane}
      </>
    );
  }

  if (shouldRenderSoilIrrigationResponse) {
    return <SoilIrrigationResponseView data={currentData} />;
  }

  if (shouldRenderDendroGrowth) {
    return (
      <>
        <DendroGrowthTimelineView data={currentData} window={chartWindow} />
        {journalLane}
      </>
    );
  }

  if (shouldRenderDendroLineChart) {
    return (
      <>
        <DendroLineChartView data={currentData} window={chartWindow} />
        {journalLane}
      </>
    );
  }

  if (shouldRenderDendroStressEvents) {
    return <DendroStressEventsView data={currentData} />;
  }

  if (shouldRenderEnvironmentLineChart) {
    return (
      <>
        <EnvironmentLineChartView data={currentData} window={chartWindow} />
        {journalLane}
      </>
    );
  }

  if (shouldRenderDailyMinMax) {
    return (
      <>
        <DailyMinMaxView data={currentData} window={chartWindow} />
        {journalLane}
      </>
    );
  }

  if (shouldRenderGatewayStatus) {
    return <GatewayStatusOverviewView card={card} data={currentData} />;
  }

  if (shouldRenderIrrigationEventTimeline) {
    return <IrrigationEventTimelineView data={currentData} />;
  }

  if (shouldRenderCalendar) {
    return (
      <>
        <CalendarView
          cardType={card.cardType}
          calendar={currentData?.calendar}
          onInspectDate={onInspectDate}
          selectedDate={selectedCalendarDate}
        />
        <InterpretationList interpretations={currentData?.interpretations ?? []} />
      </>
    );
  }

  if (shouldRenderAdvanced) {
    return (
      <AdvancedViewPanel
        data={advancedData}
        isLoading={advancedIsLoading}
        error={advancedError}
      />
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg)] p-6">
      <p className="text-sm font-semibold text-[var(--text)]">{formatViewLabel(t, selectedView)}</p>
      <p className="mt-2 text-sm text-[var(--text-tertiary)]">
        {t('history.cardFrame.placeholderBody')}
      </p>
    </div>
  );
};
