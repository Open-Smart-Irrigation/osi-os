import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { mobileTensionLabels } from '../mobileTensionLabels';

const VALUES: Record<string, string> = {
  'history.mobileTension.title': 'Water tension history',
  'history.mobileTension.chart': 'Water tension chart',
  'history.mobileTension.waterTension': 'Water tension',
  'history.mobileTension.controls': 'History controls',
  'history.mobileTension.time': 'Time',
  'history.mobileTension.timeRange': 'Time range',
  'history.mobileTension.range24h': '24 hours',
  'history.mobileTension.range7d': '7 days',
  'history.mobileTension.latest': 'Latest',
  'history.mobileTension.hourlyAverages': 'Hourly averages',
  'history.mobileTension.hourlyAverage': 'Hourly average',
  'history.mobileTension.loading': 'Loading history…',
  'history.mobileTension.refreshing': 'Updating history…',
  'history.mobileTension.emptyInterval': 'No data in this interval.',
  'history.mobileTension.showLatest24h': 'Show latest 24 hours',
  'history.mobileTension.unavailableValue': 'Unavailable in this hour',
  'history.mobileTension.notLoaded': 'Not loaded',
  'history.mobileTension.chooseSources': 'Choose sources',
  'history.mobileTension.historicalUnverified': 'Historical source; current assignment unverified',
  'history.mobileTension.sources': 'Sources',
  'history.mobileTension.chartSources': 'Chart sources',
  'history.mobileTension.openSources': 'Choose chart sources',
  'history.mobileTension.sourceDiscoveryIncomplete': 'Source discovery is incomplete.',
  'history.mobileTension.catalogFailed': 'Sources could not be loaded.',
  'history.mobileTension.unavailableSources': 'Some sources are unavailable.',
  'history.mobileTension.requestTooLarge': 'This request is too large.',
  'history.mobileTension.fewerSourcesOrShorterWindow': 'Choose fewer sources or a shorter time range.',
  'history.mobileTension.accessDenied': 'Access denied.',
  'history.mobileTension.incompleteResponse': 'The history response was incomplete.',
  'history.mobileTension.transientFailure': 'History is temporarily unavailable.',
  'history.mobileTension.retry': 'Retry',
  'history.mobileTension.details': 'Details',
  'history.mobileTension.close': 'Close',
  'history.mobileTension.sourceCap': 'You can select up to {{limit}} sources.',
  'history.mobileTension.sourceCount': 'Selected {{selected}} of {{total}} sources.',
  'history.mobileTension.invalidHourlyAverages': 'Invalid hourly averages: {{count}}.',
  'history.mobileTension.removedSources': 'Removed sources: {{names}}.',
  'history.mobileTension.removeSource': 'Remove {{name}}',
  'history.mobileTension.transportCoverage': 'Loaded from {{from}} to {{to}}.',
  'history.mobileTension.bucketInterval': 'From {{from}} to {{to}}.',
  'history.mobileTension.latestBucket': 'Latest hourly average: {{at}}.',
  'history.mobileTension.seriesLegend.legend': 'Legend',
  'history.mobileTension.seriesLegend.showAll': 'Show all',
  'history.mobileTension.seriesLegend.plottedSeries': 'Plotted series',
  'history.mobileTension.seriesLegend.seriesCount': 'Series shown: {{count}}',
  'history.mobileTension.seriesLegend.focusAnnouncement': 'Focused series: {{label}}',
  'history.mobileTension.seriesLegend.allSeriesAnnouncement': 'All series shown',
  'history.mobileTension.pinnedReading': 'Pinned reading',
  'history.mobileTension.visibleWindow': 'Visible time window',
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

    const rendered = functions.map(([factory, args]) =>
      (factory as (...values: unknown[]) => string)(...args));
    expect(rendered).toEqual([
      'You can select up to 3 sources.',
      'Selected 2 of 5 sources.',
      'Invalid hourly averages: 1.',
      'Removed sources: Probe 1.',
      'Remove Probe 1',
      'Loaded from 08:00 to 09:00.',
      'From 08:00 to 09:00.',
      'Latest hourly average: 09:00.',
      'Series shown: 2',
      'Focused series: Probe 1',
    ]);
    expect(rendered.every((value) => !value.includes('{{') && !value.includes('}}'))).toBe(true);

    expect(new Set(calls.map(({ key }) => key))).toEqual(new Set(Object.keys(VALUES)));
  });
});
