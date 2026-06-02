import React from 'react';
import { useTranslation } from 'react-i18next';
import { AdvancedViewPanel } from './AdvancedViewPanel';
import { CalendarView } from './CalendarView';
import { InterpretationList } from './InterpretationList';
import { DendroGrowthTimelineView } from './visualizations/DendroGrowthTimelineView';
import { EnvironmentLineChartView } from './visualizations/EnvironmentLineChartView';
import { GatewayStatusOverviewView } from './visualizations/GatewayStatusOverviewView';
import { IrrigationEventTimelineView } from './visualizations/IrrigationEventTimelineView';
import { SoilProfileView } from './visualizations/SoilProfileView';
import type {
  HistoryAdvancedResponse,
  HistoryCardDataResponse,
  HistoryCardSummary,
  HistoryViewMode,
} from '../../history/types';

interface HistoryCardVisualizationProps {
  card: HistoryCardSummary;
  data: HistoryCardDataResponse | undefined;
  selectedView: HistoryViewMode;
  isLoading?: boolean;
  error?: unknown;
  advancedData?: HistoryAdvancedResponse | undefined;
  advancedIsLoading?: boolean;
  advancedError?: unknown;
}

type HistoryTranslate = (key: string, options?: Record<string, unknown>) => string;

function formatViewLabel(t: HistoryTranslate, view: HistoryViewMode): string {
  return t(`history.viewMode.${view}`);
}

function getErrorMessage(t: HistoryTranslate, error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return t('history.cardFrame.cardDataUnknownError');
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
}) => {
  const { t: translate } = useTranslation('history');
  const t = translate as HistoryTranslate;
  const shouldRenderSoilProfile = card.cardType === 'soil' && selectedView === 'soil-profile';
  const shouldRenderDendroGrowth = card.cardType === 'dendro' && selectedView === 'growth-timeline';
  const shouldRenderEnvironmentLineChart = card.cardType === 'environment' && selectedView === 'line-chart';
  const shouldRenderGatewayStatus = card.cardType === 'gateway' && selectedView === 'status-overview';
  const shouldRenderIrrigationEventTimeline = card.cardType === 'irrigation' && selectedView === 'event-timeline';
  const shouldRenderCalendar = selectedView === 'calendar';
  const shouldRenderAdvanced = selectedView === 'advanced';

  if (isLoading) {
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

  if (shouldRenderSoilProfile && data) {
    return <SoilProfileView profiles={Array.isArray(data.profiles) ? data.profiles : []} />;
  }

  if (shouldRenderDendroGrowth) {
    return <DendroGrowthTimelineView data={data} />;
  }

  if (shouldRenderEnvironmentLineChart) {
    return <EnvironmentLineChartView data={data} />;
  }

  if (shouldRenderGatewayStatus) {
    return <GatewayStatusOverviewView card={card} data={data} />;
  }

  if (shouldRenderIrrigationEventTimeline) {
    return <IrrigationEventTimelineView data={data} />;
  }

  if (shouldRenderCalendar) {
    return (
      <>
        <CalendarView cardType={card.cardType} calendar={data?.calendar} />
        <InterpretationList interpretations={data?.interpretations ?? []} />
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
