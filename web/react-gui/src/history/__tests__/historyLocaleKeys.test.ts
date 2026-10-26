import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const GUI_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(GUI_ROOT, 'src');
const LOCALES_ROOT = path.join(GUI_ROOT, 'public/locales');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];
const NEW_KEYS = ['history.export.open', 'history.export.title', 'history.desktop.railLabel'];
const MOBILE_TENSION_KEYS = [
  'history.mobileTension.title', 'history.mobileTension.chart', 'history.mobileTension.waterTension',
  'history.mobileTension.controls', 'history.mobileTension.time', 'history.mobileTension.timeRange',
  'history.mobileTension.range24h', 'history.mobileTension.range7d', 'history.mobileTension.latest',
  'history.mobileTension.hourlyAverages', 'history.mobileTension.hourlyAverage', 'history.mobileTension.loading',
  'history.mobileTension.refreshing', 'history.mobileTension.emptyInterval', 'history.mobileTension.showLatest24h',
  'history.mobileTension.unavailableValue', 'history.mobileTension.notLoaded', 'history.mobileTension.chooseSources',
  'history.mobileTension.historicalUnverified', 'history.mobileTension.sources', 'history.mobileTension.chartSources',
  'history.mobileTension.openSources', 'history.mobileTension.sourceDiscoveryIncomplete',
  'history.mobileTension.catalogFailed', 'history.mobileTension.unavailableSources',
  'history.mobileTension.requestTooLarge', 'history.mobileTension.fewerSourcesOrShorterWindow',
  'history.mobileTension.accessDenied', 'history.mobileTension.incompleteResponse',
  'history.mobileTension.transientFailure', 'history.mobileTension.retry', 'history.mobileTension.details',
  'history.mobileTension.close', 'history.mobileTension.sourceCap', 'history.mobileTension.sourceCount',
  'history.mobileTension.invalidHourlyAverages', 'history.mobileTension.removedSources',
  'history.mobileTension.removeSource', 'history.mobileTension.transportCoverage',
  'history.mobileTension.bucketInterval', 'history.mobileTension.latestBucket',
  'history.mobileTension.seriesLegend.legend', 'history.mobileTension.seriesLegend.showAll',
  'history.mobileTension.seriesLegend.plottedSeries', 'history.mobileTension.seriesLegend.seriesCount',
  'history.mobileTension.seriesLegend.focusAnnouncement', 'history.mobileTension.seriesLegend.allSeriesAnnouncement',
  'history.mobileTension.pinnedReading', 'history.mobileTension.visibleWindow',
  'history.mobileTension.route.zoneLoading', 'history.mobileTension.route.zonesFailed',
  'history.mobileTension.route.timeZoneUnavailable',
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function usedHistoryKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/t\(\s*['"`](history\.[a-zA-Z0-9_.]+)['"`]/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function localeKeys(locale: string): Set<string> {
  const file = path.join(LOCALES_ROOT, locale, 'history.json');
  return new Set(flattenKeys(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

describe('history locale key coverage', () => {
  it('defines every literal history.* key used in src in the en locale', () => {
    const defined = localeKeys('en');
    const missing = usedHistoryKeys().filter((key) => !defined.has(key));
    expect(missing).toEqual([]);
  });

  it('defines the export/rail keys in every locale', () => {
    for (const locale of LOCALES) {
      const defined = localeKeys(locale);
      const missing = NEW_KEYS.filter((key) => !defined.has(key));
      expect(missing, `locale ${locale}`).toEqual([]);
    }
  });

  it('defines every mobile tension key in every locale', () => {
    for (const locale of LOCALES) {
      const defined = localeKeys(locale);
      const missing = MOBILE_TENSION_KEYS.filter((key) => !defined.has(key));
      expect(missing, `locale ${locale}`).toEqual([]);
    }
  });
});
