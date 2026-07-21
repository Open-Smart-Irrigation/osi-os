import { describe, expect, it } from 'vitest';
import deCH from '../../../public/locales/de-CH/history.json';
import en from '../../../public/locales/en/history.json';
import es from '../../../public/locales/es/history.json';
import fr from '../../../public/locales/fr/history.json';
import itLocale from '../../../public/locales/it/history.json';
import lg from '../../../public/locales/lg/history.json';
import pt from '../../../public/locales/pt/history.json';

const LOCALES = ['de-CH', 'es', 'fr', 'it', 'lg', 'pt'] as const;
type Locale = (typeof LOCALES)[number];
const LOCALE_RESOURCES: Record<string, unknown> = { en, 'de-CH': deCH, es, fr, it: itLocale, lg, pt };

function flattenLeaves(value: unknown, prefix = '', leaves: Record<string, string> = {}): Record<string, string> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenLeaves(child, prefix ? `${prefix}.${key}` : key, leaves);
    }
  } else if (typeof value === 'string' && value.trim() !== '') {
    placeholders(value);
    leaves[prefix] = value;
  } else {
    throw new Error(`invalid history locale leaf at ${prefix || '<root>'}`);
  }
  return leaves;
}

function localeLeaves(locale: string): Record<string, string> {
  return flattenLeaves(LOCALE_RESOURCES[locale]);
}

function placeholders(value: string): string[] {
  const matches: string[] = [];
  let index = 0;

  while (index < value.length) {
    const open = value.indexOf('{', index);
    const close = value.indexOf('}', index);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      throw new Error(`malformed interpolation braces in ${JSON.stringify(value)}`);
    }
    if (!value.startsWith('{{', open)) {
      throw new Error(`malformed interpolation braces in ${JSON.stringify(value)}`);
    }

    const end = value.indexOf('}}', open + 2);
    const name = end === -1 ? '' : value.slice(open + 2, end);
    if (end === -1 || !/^\S+$/.test(name) || /[{}]/.test(name)) {
      throw new Error(`malformed interpolation braces in ${JSON.stringify(value)}`);
    }

    matches.push(value.slice(open, end + 2));
    index = end + 2;
  }

  return matches.sort();
}

// These are intentionally key-specific: a shared word is legitimate only at the
// reviewed leaf where it is a proper name, abbreviation, unit, or technical token.
const REVIEWED_IDENTICAL_KEYS: Record<Locale, ReadonlySet<string>> = {
  'de-CH': new Set([
    'history.mobile.zoneLabel',
    'history.rangeShort.12h', 'history.rangeShort.24h',
    'history.cardFrame.aggregationBadge',
    'history.dendroTimeline.series.dendrometer', 'history.environmentLineChart.series.wind',
    'history.dailyMinMax.axisLabel', 'history.dailyMinMax.tooltipMin', 'history.dailyMinMax.tooltipMax',
    'history.gatewayStatus.status.ok', 'history.gatewayStatus.status.online',
    'history.gatewayStatus.status.offline', 'history.gatewayStatus.category.system',
    'history.gatewayStatus.metric.signal', 'history.gatewayStatus.metric.cpu',
    'history.irrigationTimeline.severity.info', 'history.irrigationTimeline.severity.unknown',
    'history.cardType.gateway', 'history.soilProfile.depthLabel',
    'history.soilProfile.status.optimal', 'history.calendar.state.optimal',
    'history.calendar.state.normal', 'history.calendar.state.offline',
    'history.interpretation.title', 'history.advanced.field.rssi',
    'history.advanced.field.snr', 'history.advanced.field.firmware',
    'history.soilLineChart.series.sensor', 'history.dendroLineChart.series.position',
    'history.dendroLineChart.series.dendrometer',
  ]),
  es: new Set([
    'history.desktop.inspectorTitle', 'history.detail.inspectorPlaceholder',
    'history.rangeShort.12h', 'history.rangeShort.24h',
    'history.rangeShort.7d', 'history.rangeShort.30d', 'history.dailyMinMax.axisLabel',
    'history.gatewayStatus.status.ok', 'history.gatewayStatus.metric.cpu',
    'history.irrigationTimeline.severity.info', 'history.irrigationTimeline.severity.unknown',
    'history.cardType.gateway', 'history.metadata.syncState.local',
    'history.metadata.aggregation.15m', 'history.soilProfile.depthLabel',
    'history.calendar.state.normal', 'history.advanced.field.rssi',
    'history.advanced.field.snr', 'history.advanced.field.firmware',
    'history.soilLineChart.series.sensor', 'history.inspector.title',
  ]),
  fr: new Set([
    'history.desktop.modeFocus', 'history.desktop.sourceSelectorLabel', 'history.mobile.zoneLabel',
    'history.overview.alert', 'history.rangeShort.12h', 'history.rangeShort.24h',
    'history.sidebar.zones', 'history.dailyMinMax.axisLabel', 'history.dailyMinMax.tooltipMin',
    'history.dailyMinMax.tooltipMax', 'history.gatewayStatus.status.ok',
    'history.gatewayStatus.metric.signal', 'history.gatewayStatus.metric.cpu',
    'history.irrigationTimeline.severity.info', 'history.irrigationTimeline.severity.unknown',
    'history.cardType.irrigation', 'history.metadata.syncState.local',
    'history.metadata.aggregation.15m', 'history.soilProfile.depthLabel',
    'history.soilProfile.status.optimal', 'history.calendar.state.optimal',
    'history.calendar.state.normal', 'history.advanced.field.rssi', 'history.advanced.field.snr',
    'history.advanced.field.firmware', 'history.source.multiple',
    'history.dendroLineChart.series.position', 'history.sourceFilter.label',
    'history.inspector.date', 'history.inspector.source', 'history.sources.button',
  ]),
  it: new Set([
    'history.desktop.modeFocus', 'history.rangeShort.12h', 'history.rangeShort.24h',
    'history.dailyMinMax.axisLabel', 'history.dailyMinMax.tooltipMin', 'history.dailyMinMax.tooltipMax',
    'history.gatewayStatus.status.ok', 'history.gatewayStatus.status.online',
    'history.gatewayStatus.status.offline', 'history.gatewayStatus.metric.cpu',
    'history.irrigationTimeline.severity.info', 'history.irrigationTimeline.severity.unknown',
    'history.cardType.gateway', 'history.metadata.aggregation.15m',
    'history.soilProfile.depthLabel', 'history.calendar.state.offline',
    'history.advanced.field.rssi', 'history.advanced.field.snr', 'history.advanced.field.firmware',
    'history.inspector.timestamp',
  ]),
  lg: new Set([
    'history.rangeShort.12h', 'history.rangeShort.24h', 'history.rangeShort.7d',
    'history.rangeShort.30d', 'history.dendroTimeline.series.dendrometer',
    'history.dailyMinMax.axisLabel', 'history.gatewayStatus.metric.cpu',
    'history.cardType.gateway', 'history.soilProfile.depthLabel',
    'history.advanced.field.rssi', 'history.advanced.field.snr', 'history.advanced.field.firmware',
    'history.advanced.field.gatewayEui', 'history.dendroLineChart.series.dendrometer',
  ]),
  pt: new Set([
    'history.rangeShort.12h', 'history.rangeShort.24h', 'history.rangeShort.7d',
    'history.rangeShort.30d', 'history.dailyMinMax.axisLabel', 'history.gatewayStatus.status.ok',
    'history.gatewayStatus.status.online', 'history.gatewayStatus.status.offline',
    'history.gatewayStatus.metric.cpu', 'history.cardType.gateway',
    'history.metadata.syncState.local', 'history.metadata.aggregation.15m',
    'history.soilProfile.depthLabel', 'history.calendar.state.normal',
    'history.calendar.state.offline', 'history.advanced.field.rssi', 'history.advanced.field.snr',
    'history.advanced.field.firmware', 'history.soilLineChart.series.sensor',
  ]),
};

describe('history locale value parity', () => {
  it('keeps all six locales translated except reviewed shared technical values', () => {
    const english = localeLeaves('en');
    expect(Object.keys(english)).toHaveLength(414);

    for (const locale of LOCALES) {
      const translated = localeLeaves(locale);
      const englishKeys = new Set(Object.keys(english));
      const translatedKeys = new Set(Object.keys(translated));
      expect([...translatedKeys].filter((key) => !englishKeys.has(key)), `${locale} extra keys`).toEqual([]);
      expect([...englishKeys].filter((key) => !translatedKeys.has(key)), `${locale} missing keys`).toEqual([]);

      const missingAllowlistKeys = [...REVIEWED_IDENTICAL_KEYS[locale]].filter((key) =>
        !Object.prototype.hasOwnProperty.call(english, key) || !Object.prototype.hasOwnProperty.call(translated, key));
      expect(missingAllowlistKeys, `${locale} allowlisted keys missing from a locale resource`).toEqual([]);

      const identicalKeys = Object.keys(english).filter((key) => translated[key] === english[key]);
      const unexpected = identicalKeys.filter((key) => !REVIEWED_IDENTICAL_KEYS[locale].has(key));
      const staleAllowlist = [...REVIEWED_IDENTICAL_KEYS[locale]].filter((key) => translated[key] !== english[key]);
      expect(unexpected, `${locale} unreviewed English-identical values`).toEqual([]);
      expect(staleAllowlist, `${locale} stale identical-value allowlist entries`).toEqual([]);

      const placeholderMismatches = Object.keys(english).filter((key) =>
        placeholders(english[key]).join('|') !== placeholders(translated[key]).join('|'));
      expect(placeholderMismatches, `${locale} placeholder mismatches`).toEqual([]);
    }
  });

  it('uses Swiss spelling in de-CH', () => {
    const german = localeLeaves('de-CH');
    expect(Object.values(german).filter((value) => value.includes('ß'))).toEqual([]);
  });

  it('rejects non-string and empty leaves instead of coercing them', () => {
    for (const invalid of [null, 42, false, '']) {
      expect(() => flattenLeaves({ invalid })).toThrow(/invalid history locale leaf/);
    }
  });

  it('rejects malformed interpolation braces while preserving valid placeholders', () => {
    expect(placeholders('Count {{count}}')).toEqual(['{{count}}']);
    expect(() => placeholders('Count {{count}}}')).toThrow(/malformed interpolation/);
    expect(() => placeholders('Count {{count}')).toThrow(/malformed interpolation/);
  });
});
