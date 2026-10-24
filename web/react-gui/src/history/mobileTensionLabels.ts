import type { TFunction } from 'i18next';
import type { MobileTensionHistoryLabels } from '@osi/history-uplot';

type MobileTensionLabelKey =
  | 'title' | 'chart' | 'waterTension' | 'controls' | 'time' | 'timeRange' | 'range24h' | 'range7d'
  | 'latest' | 'hourlyAverages' | 'hourlyAverage' | 'loading' | 'refreshing' | 'emptyInterval' | 'showLatest24h'
  | 'unavailableValue' | 'notLoaded' | 'chooseSources' | 'historicalUnverified' | 'sources' | 'chartSources'
  | 'openSources' | 'sourceDiscoveryIncomplete' | 'catalogFailed' | 'unavailableSources' | 'requestTooLarge'
  | 'fewerSourcesOrShorterWindow' | 'accessDenied' | 'incompleteResponse' | 'transientFailure' | 'retry'
  | 'details' | 'close' | 'sourceCap' | 'sourceCount' | 'invalidHourlyAverages' | 'removedSources'
  | 'removeSource' | 'transportCoverage' | 'bucketInterval' | 'latestBucket' | 'pinnedReading' | 'visibleWindow'
  | 'seriesLegend.legend' | 'seriesLegend.showAll' | 'seriesLegend.plottedSeries' | 'seriesLegend.seriesCount'
  | 'seriesLegend.focusAnnouncement' | 'seriesLegend.allSeriesAnnouncement';

export function mobileTensionLabels(t: TFunction<'history'>): MobileTensionHistoryLabels {
  const label = (key: MobileTensionLabelKey, options?: Record<string, unknown>): string =>
    t(`history.mobileTension.${key}`, options);

  return {
    title: label('title'),
    chart: label('chart'),
    waterTension: label('waterTension'),
    controls: label('controls'),
    time: label('time'),
    timeRange: label('timeRange'),
    range24h: label('range24h'),
    range7d: label('range7d'),
    latest: label('latest'),
    hourlyAverages: label('hourlyAverages'),
    hourlyAverage: label('hourlyAverage'),
    loading: label('loading'),
    refreshing: label('refreshing'),
    emptyInterval: label('emptyInterval'),
    showLatest24h: label('showLatest24h'),
    unavailableValue: label('unavailableValue'),
    notLoaded: label('notLoaded'),
    chooseSources: label('chooseSources'),
    historicalUnverified: label('historicalUnverified'),
    sources: label('sources'),
    chartSources: label('chartSources'),
    openSources: label('openSources'),
    sourceDiscoveryIncomplete: label('sourceDiscoveryIncomplete'),
    catalogFailed: label('catalogFailed'),
    unavailableSources: label('unavailableSources'),
    requestTooLarge: label('requestTooLarge'),
    fewerSourcesOrShorterWindow: label('fewerSourcesOrShorterWindow'),
    accessDenied: label('accessDenied'),
    incompleteResponse: label('incompleteResponse'),
    transientFailure: label('transientFailure'),
    retry: label('retry'),
    details: label('details'),
    close: label('close'),
    sourceCap: (limit) => label('sourceCap', { limit }),
    sourceCount: (selected, total) => label('sourceCount', { selected, total }),
    invalidHourlyAverages: (count) => label('invalidHourlyAverages', { count }),
    removedSources: (names) => label('removedSources', { names }),
    removeSource: (name) => label('removeSource', { name }),
    transportCoverage: (from, to) => label('transportCoverage', { from, to }),
    bucketInterval: (from, to) => label('bucketInterval', { from, to }),
    latestBucket: (at) => label('latestBucket', { at }),
    seriesLegend: {
      legend: label('seriesLegend.legend'),
      showAll: label('seriesLegend.showAll'),
      plottedSeries: label('seriesLegend.plottedSeries'),
      seriesCount: (count) => label('seriesLegend.seriesCount', { count }),
      focusAnnouncement: (labelText) => label('seriesLegend.focusAnnouncement', { label: labelText }),
      allSeriesAnnouncement: label('seriesLegend.allSeriesAnnouncement'),
    },
    pinnedReading: label('pinnedReading'),
    visibleWindow: label('visibleWindow'),
  };
}
