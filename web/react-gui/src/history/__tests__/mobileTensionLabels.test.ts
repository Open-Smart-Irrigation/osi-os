import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { mobileTensionLabels } from '../mobileTensionLabels';

const VALUES: Record<string, string> = {
  'mobileTension.title': 'Water tension history',
  'mobileTension.chart': 'Water tension chart',
  'mobileTension.waterTension': 'Water tension',
  'mobileTension.controls': 'History controls',
  'mobileTension.time': 'Time',
  'mobileTension.timeRange': 'Time range',
  'mobileTension.range24h': '24 hours',
  'mobileTension.range7d': '7 days',
  'mobileTension.latest': 'Latest',
  'mobileTension.hourlyAverages': 'Hourly averages',
  'mobileTension.hourlyAverage': 'Hourly average',
  'mobileTension.loading': 'Loading history…',
  'mobileTension.refreshing': 'Updating history…',
  'mobileTension.emptyInterval': 'No data in this interval.',
  'mobileTension.showLatest24h': 'Show latest 24 hours',
  'mobileTension.unavailableValue': 'Unavailable in this hour',
  'mobileTension.notLoaded': 'Not loaded',
  'mobileTension.chooseSources': 'Choose sources',
  'mobileTension.historicalUnverified': 'Historical source; current assignment unverified',
  'mobileTension.sources': 'Sources',
  'mobileTension.chartSources': 'Chart sources',
  'mobileTension.openSources': 'Choose chart sources',
  'mobileTension.sourceDiscoveryIncomplete': 'Source discovery is incomplete.',
  'mobileTension.catalogFailed': 'Sources could not be loaded.',
  'mobileTension.unavailableSources': 'Some sources are unavailable.',
  'mobileTension.requestTooLarge': 'This request is too large.',
  'mobileTension.fewerSourcesOrShorterWindow': 'Choose fewer sources or a shorter time range.',
  'mobileTension.accessDenied': 'Access denied.',
  'mobileTension.incompleteResponse': 'The history response was incomplete.',
  'mobileTension.transientFailure': 'History is temporarily unavailable.',
  'mobileTension.retry': 'Retry',
  'mobileTension.details': 'Details',
  'mobileTension.close': 'Close',
  'mobileTension.sourceCap': 'You can select up to {{limit}} sources.',
  'mobileTension.sourceCount': 'Selected {{selected}} of {{total}} sources.',
  'mobileTension.invalidHourlyAverages': 'Invalid hourly averages: {{count}}.',
  'mobileTension.removedSources': 'Removed sources: {{names}}.',
  'mobileTension.removeSource': 'Remove {{name}}',
  'mobileTension.transportCoverage': 'Loaded from {{from}} to {{to}}.',
  'mobileTension.bucketInterval': 'From {{from}} to {{to}}.',
  'mobileTension.latestBucket': 'Latest hourly average: {{at}}.',
  'mobileTension.seriesLegend.legend': 'Legend',
  'mobileTension.seriesLegend.showAll': 'Show all',
  'mobileTension.seriesLegend.plottedSeries': 'Plotted series',
  'mobileTension.seriesLegend.seriesCount': 'Series shown: {{count}}',
  'mobileTension.seriesLegend.focusAnnouncement': 'Focused series: {{label}}',
  'mobileTension.seriesLegend.allSeriesAnnouncement': 'All series shown',
  'mobileTension.pinnedReading': 'Pinned reading',
  'mobileTension.visibleWindow': 'Visible time window',
};

describe('mobileTensionLabels', () => {
  it('maps every shell label to the history.mobileTension namespace', () => {
    const calls: Array<{ key: string; options?: Record<string, unknown> }> = [];
    const t = ((key: string, options?: Record<string, unknown>) => {
      calls.push({ key, options });
      const value = VALUES[key];
      if (!value) throw new Error(`unexpected translation key: ${key}`);
      return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
    }) as TFunction<'history'>;

    const labels = mobileTensionLabels(t);
    const functions = [
      [labels.sourceCap, [3]],
      [labels.sourceCount, [2, 5]],
      [labels.invalidHourlyAverages, [1]],
      [labels.removedSources, ['Probe 1']],
      [labels.removeSource, ['Probe 1']],
      [labels.transportCoverage, ['08:00', '09:00']],
      [labels.bucketInterval, ['08:00', '09:00']],
      [labels.latestBucket, ['09:00']],
      [labels.seriesLegend.seriesCount, [2]],
      [labels.seriesLegend.focusAnnouncement, ['Probe 1']],
    ] as const;

    for (const [factory, args] of functions) {
      const value = (factory as (...values: unknown[]) => string)(...args);
      expect(value).not.toMatch(/\{\{/);
      expect(value).not.toMatch(/\}\}/);
    }

    expect(new Set(calls.map(({ key }) => key))).toEqual(new Set(Object.keys(VALUES)));
  });
});
