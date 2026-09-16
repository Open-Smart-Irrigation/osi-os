import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];

function readNamespace(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, `${namespace}.json`), 'utf8'));
}

function getPath(tree: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, tree);
}

// Read by IrrigationZoneCard.tsx (water card, zone chips, device group
// headings), the four device cards' history buttons, SoilTab.tsx and the
// environment tabs' date helpers. A key missing from one locale silently
// falls back to English on that language, which is exactly the leak this
// pass closed.

const DEVICES_KEYS = [
  'zone.configure',
  'zone.chips.dendroActive',
  'zone.chips.schedulerOff',
  'zone.chips.metricEnabled',
  'zone.chips.metric.DENDRO',
  'zone.chips.metric.VWC',
  'zone.chips.metric.SWT_1',
  'zone.chips.metric.SWT_2',
  'zone.chips.metric.SWT_3',
  'zone.chips.metric.SWT_WM1',
  'zone.chips.metric.SWT_WM2',
  'zone.chips.metric.SWT_AVG',
  'zone.chips.metric.default',
  'zone.groups.lsn50Nodes',
  'zone.groups.sdi12Nodes',
  'zone.groups.weatherStations',
  'zone.groups.rainGauges',
  'zone.water.title',
  'zone.water.subtitle',
  'zone.water.updated',
  'zone.water.rainToday',
  'zone.water.measured',
  'zone.water.estimated',
  'zone.water.nextRain',
  'zone.water.forecastNext24h',
  'zone.water.actionTitle',
  'zone.water.drivenByDendro',
  'zone.water.drivenByBalance',
  'zone.water.treeStress',
  'zone.water.awaitingRecommendation',
  'zone.water.confidence',
  'zone.water.confidencePending',
  'zone.water.action.delay_irrigation',
  'zone.water.action.irrigate_today',
  'zone.water.action.monitor_today',
  'zone.water.action.maintain_rain_suppression',
  'zone.water.action.maintain_recovery_hold',
  'zone.water.action.increase_10',
  'zone.water.action.increase_20',
  'zone.water.action.decrease_10',
  'zone.water.action.decrease_20',
  'zone.water.action.emergency_irrigate',
  'zone.water.action.default',
  'zone.water.source.shared_server',
  'zone.water.source.shared_server_stale',
  'zone.water.source.local_fallback',
  'zone.water.source.unlinked_local',
  'zone.water.source.default',
  'zone.water.soil.title',
  'zone.water.soil.wet',
  'zone.water.soil.moderate',
  'zone.water.soil.dry',
  'zone.water.soil.volumetric',
  'zone.water.soil.noReadingSince',
  'zone.water.soil.noReadingYet',
  'zone.water.soil.invalidReading',
  'zone.water.soil.lastValid',
  'common.viewHistory',
  'environment.soil.moistureSwtVwc',
  'environment.soil.moistureSwt',
  'environment.soil.moistureVwc',
  'environment.soil.moisture',
  'environment.forecast.dayToday',
  'environment.forecast.dayTomorrow',
  'environment.forecast.etaToday',
  'environment.forecast.etaTomorrow',
  'environment.generatedAt',
];

const NETWORK_KEYS = [
  'network.loadingDevices',
  'network.noDevices',
  'network.loadingObservations',
];

// Luganda is human translation work product: where no reviewed Luganda exists,
// the honest shipped value is the English source text, never a machine
// translation. Every key above is in that state today, tracked in
// docs/i18n/pending-luganda-translations.md. A human Luganda pass must change
// both files together, and this assertion is what forces that.
const PENDING_HUMAN_LUGANDA = new Set<string>([...DEVICES_KEYS, ...NETWORK_KEYS]);


// locale:key pairs where matching English is correct: OSI Server is a product
// name, and "Action" is the same word in French.
const REVIEWED_IDENTICAL = new Set<string>([
  'de-CH:zone.water.source.shared_server',
  'es:zone.water.source.shared_server',
  'fr:zone.water.source.shared_server',
  'it:zone.water.source.shared_server',
  'pt:zone.water.source.shared_server',
  'fr:zone.water.actionTitle',
]);

test('water-card and date-format keys exist in every shipped locale', () => {
  for (const locale of LOCALES) {
    const devices = readNamespace(locale, 'devices');
    for (const key of DEVICES_KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
    const network = readNamespace(locale, 'network');
    for (const key of NETWORK_KEYS) {
      assert.equal(typeof getPath(network, key), 'string', `${locale} network.json missing ${key}`);
    }
  }
});

test('interpolation placeholders match English in every locale', () => {
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  for (const [namespace, keys] of [['devices', DEVICES_KEYS], ['network', NETWORK_KEYS]] as const) {
    const english = readNamespace('en', namespace);
    for (const locale of LOCALES) {
      const translated = readNamespace(locale, namespace);
      for (const key of keys) {
        assert.equal(
          placeholders(getPath(translated, key) as string),
          placeholders(getPath(english, key) as string),
          `${locale} ${namespace}.json placeholder mismatch at ${key}`,
        );
      }
    }
  }
});

test('the five European locales translate every new key', () => {
  for (const [namespace, keys] of [['devices', DEVICES_KEYS], ['network', NETWORK_KEYS]] as const) {
    const english = readNamespace('en', namespace);
    for (const locale of ['de-CH', 'es', 'fr', 'it', 'pt']) {
      const translated = readNamespace(locale, namespace);
      const identical = keys.filter((key) => getPath(translated, key) === getPath(english, key));
      // Proper names and one genuine French cognate; everything else identical
      // to English would be an untranslated key.
      assert.deepEqual(
        identical,
        identical.filter((key) => REVIEWED_IDENTICAL.has(`${locale}:${key}`)),
        `${locale} ${namespace}.json has untranslated values`,
      );
    }
  }
});

test('Luganda ships the English source text until a human pass lands', () => {
  for (const [namespace, keys] of [['devices', DEVICES_KEYS], ['network', NETWORK_KEYS]] as const) {
    const english = readNamespace('en', namespace);
    const luganda = readNamespace('lg', namespace);
    for (const key of keys) {
      if (!PENDING_HUMAN_LUGANDA.has(key)) continue;
      assert.equal(
        getPath(luganda, key),
        getPath(english, key),
        `lg ${namespace}.json ${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`,
      );
    }
  }
});

test('de-CH avoids the eszett', () => {
  const german = JSON.stringify(readNamespace('de-CH', 'devices'));
  for (const key of DEVICES_KEYS) {
    const value = getPath(JSON.parse(german), key) as string;
    assert.ok(!value.includes('\u00df'), `de-CH ${key} uses \u00df instead of Swiss spelling`);
  }
});
