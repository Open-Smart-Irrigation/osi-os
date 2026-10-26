import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { MobileSoilHistory, useHistoryWindow, type HistoryWindowContext, type HistoryWindowRequest } from '@osi/history-uplot';
import { createMobileSoilHistoryLoader } from '../../../history/mobileSoilHistoryAdapter';
import type { HistoryCardDataScope } from '../../../history/useHistoryCardData';
import { useAuth } from '../../../contexts/AuthContext';
import { mobileSoilHistoryContextKey } from '../../../history/mobileSoilUplot';

interface Props {
  scope: HistoryCardDataScope;
  cardId: string;
  sourceKey?: string | null;
  /**
   * Set while mounted to a function returning the interval the chart shows,
   * so the host can open export on the same dates. Read on demand: the
   * viewport changes on every gesture frame and must not re-render the page.
   */
  visibleIntervalReaderRef?: MutableRefObject<(() => VisibleInterval) | null>;
}

export interface VisibleInterval {
  from: number;
  to: number;
}

export function MobileSoilUplotHistory({ scope, cardId, sourceKey, visibleIntervalReaderRef }: Props) {
  const { t } = useTranslation('history');
  const { sessionIdentity } = useAuth();
  const loader = useMemo(() => createMobileSoilHistoryLoader({ scope, cardId, sourceKey }), [scope, cardId, sourceKey]);
  const context = useMemo<HistoryWindowContext>(() => ({
    sessionKey: `${sessionIdentity.sessionEpoch}:${sessionIdentity.principalId ?? 'anonymous'}`,
    scopeKey: scope.type === 'zone' ? `zone:${scope.zoneId}` : `gateway:${scope.gatewayEui}`,
    cardId,
    sourceKey,
  }), [cardId, scope, sessionIdentity, sourceKey]);
  const model = useHistoryWindow({
    enabled: true,
    context,
    load: (request: HistoryWindowRequest, signal) => loader(request, signal),
  });
  const { viewportStore } = model;
  useEffect(() => {
    if (!visibleIntervalReaderRef) return undefined;
    const read = () => {
      const { from, to } = viewportStore.get();
      return { from, to };
    };
    visibleIntervalReaderRef.current = read;
    return () => {
      if (visibleIntervalReaderRef.current === read) visibleIntervalReaderRef.current = null;
    };
  }, [viewportStore, visibleIntervalReaderRef]);
  const labels = useMemo(() => ({
    ranges: { day: t('mobileUplot.ranges.day'), week: t('mobileUplot.ranges.week'), month: t('mobileUplot.ranges.month'), ninetyDays: t('mobileUplot.ranges.ninetyDays') },
    back: t('mobileUplot.back'), forward: t('mobileUplot.forward'), latest: t('mobileUplot.latest'), sensors: t('mobileUplot.sensors'),
    unitNotReported: t('mobileUplot.unitNotReported'), loading: t('mobileUplot.loading'), updating: t('mobileUplot.updating'), noData: t('mobileUplot.noData'), allHidden: t('mobileUplot.allHidden'), unavailable: t('mobileUplot.unavailable'), pinnedReading: t('mobileUplot.pinnedReading'), close: t('mobileUplot.close'), aggregation: t('mobileUplot.aggregation'), points: t('mobileUplot.points'), loadedRange: t('mobileUplot.loadedRange'), truncated: t('mobileUplot.truncated'), showDay: t('mobileUplot.showDay'), retry: t('mobileUplot.retry'), failure: t('mobileUplot.failure'), coverage: t('mobileUplot.coverage'), freshness: t('mobileUplot.freshness'), notLoaded: t('mobileUplot.notLoaded'), rangesGroup: t('mobileUplot.rangesGroup'), visibleWindow: t('mobileUplot.visibleWindow'),
    seriesLegend: {
      legend: t('mobileUplot.seriesLegend.legend'), showAll: t('mobileUplot.seriesLegend.showAll'),
      plottedSeries: t('mobileUplot.seriesLegend.plottedSeries'),
      seriesCount: (count: number) => t('mobileUplot.seriesLegend.seriesCount', { count }),
      focusAnnouncement: (label: string) => t('mobileUplot.seriesLegend.focusAnnouncement', { label }),
      allSeriesAnnouncement: t('mobileUplot.seriesLegend.allSeriesAnnouncement'),
    },
    formatAggregation: (level: string) => t(`history.metadata.aggregation.${level}`, { defaultValue: level }),
  }), [t]);
  return <MobileSoilHistory model={model} contextKey={mobileSoilHistoryContextKey(sessionIdentity.sessionEpoch, sessionIdentity.principalId, context.scopeKey, cardId, sourceKey)} labels={labels} formatAggregation={labels.formatAggregation} />;
}
