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
  'zone.water.insufficientData',
  'zone.water.reason.balance_unknown',
  'zone.water.reason.forecast_unknown',
  'zone.water.reason.supply_covers_demand',
  'zone.water.reason.forecast_rain_covers_demand',
  'zone.water.reason.demand_exceeds_supply',
  'zone.water.reason.balance_neutral',
  'zone.water.reason.default',
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
  'zone.water.source.using_last_synced',
  'zone.water.source.bundle_unavailable',
  'zone.water.source.fallback_generic',
  'zone.water.source.default',
  'zone.water.soil.title',
  'zone.water.soil.titleAtDepth',
  'zone.water.soil.titleChannel',
  'zone.water.soil.atTrigger',
  'zone.water.soil.nearTrigger',
  'zone.water.soil.belowTrigger',
  'zone.water.soil.wet',
  'zone.water.soil.moderate',
  'zone.water.soil.dry',
  'zone.water.soil.volumetric',
  'zone.water.soil.noReadingSince',
  'zone.water.soil.noReadingYet',
  'zone.water.soil.invalidReading',
  'zone.water.soil.lastValid',
  'common.viewHistory',
  'common.batteryEstimated',
  // Zone environment card, Water tab (WaterTab.tsx). These ten were called
  // with a defaultValue but existed in no locale file, so the tab rendered
  // English in all seven languages; see tests/i18nDefaultValueCoverage.test.ts.
  'environment.water.noData',
  'environment.water.rainToday',
  'environment.water.measuredIrrigationToday',
  'environment.water.estimatedIrrigationToday',
  'environment.water.waterNeededToday',
  'environment.water.balance',
  'environment.water.setupRequired',
  'environment.water.trendNote',
  'environment.water.nextRain',
  'environment.soil.moistureSwtVwc',
  'environment.soil.moistureSwt',
  'environment.soil.moistureVwc',
  'environment.soil.moisture',
  'environment.forecast.dayToday',
  'environment.forecast.dayTomorrow',
  'environment.forecast.etaToday',
  'environment.forecast.etaTomorrow',
  'environment.generatedAt',
  'environment.tabs.water',
  'environment.tabs.soil',
  'environment.tabs.weather',
  'environment.tabs.sensors',
  'environment.soil.temperature',
  'kiwiSensor.invalidDepth',
  'kiwiSensor.depthSaved',
  'kiwiSensor.failedToSaveDepth',
  'kiwiSensor.depthTitle',
  'kiwiSensor.depthNote',
  'kiwiSensor.depth1Label',
  'kiwiSensor.depth2Label',
  'kiwiSensor.depthPlaceholder',
  'kiwiSensor.savingDepths',
  'kiwiSensor.saveDepths',
  'environment.loading',
  'environment.loadFailed',
  // The Kc source line under the crop coefficient (AgronomicTab.tsx) and the
  // daily agronomy record's source labels.
  'environment.water.kcSource.fao56_crop',
  'environment.water.kcSource.fao56_crop_stage_unset',
  'environment.water.kcSource.heuristic_phenology',
  'environment.water.kcSource.server',
  'environment.water.kcSource.local',
  'environment.water.stageNotSet',
  // The Water tab's "Last 7 days" plot with per-day crop demand, its tooltips
  // and HelpTips, the rain-source labels on the tile and the zone card, and the
  // Weather tab's provider credit (2026-09-26). The first nine reuse the
  // cloud's strings.
  'environment.water.lastSevenDays',
  'environment.water.tooltipDemand',
  'environment.water.stationCredit',
  'zone.water.rainFromStation',
  'zone.water.rainFromWeather',
  'zone.water.drivenByWaterBalanceFromWeather',
  'zone.water.drivenByWaterBalanceFromStation',
  'zone.water.reason.rain_unknown',
  'zone.water.reason.demand_unknown',
  'environment.water.today',
  'environment.water.legendDemand',
  'environment.water.legendDemandTodayForecast',
  'environment.water.demandCalculated',
  'environment.water.demandForecast',
  'environment.water.demandNoData',
  'environment.water.demandNoLocation',
  'environment.water.demandPending',
  'environment.water.tooltipTodayNote',
  'environment.water.kcLine',
  'environment.water.et0Tier.station_fao56',
  'environment.water.et0Tier.hargreaves_station',
  'environment.water.et0Tier.provider_open_meteo',
  'environment.water.et0Tier.provider_meteoswiss',
  'environment.water.et0Tier.forecast',
  'environment.water.attribution.open_meteo',
  'environment.water.attributionHelpLabel',
  'environment.water.neededTodayHelpLabel',
  'environment.water.neededTodayHelp',
  'environment.water.lastSevenDaysHelpLabel',
  'environment.water.setupRequiredHelpLabel',
  'environment.water.rainSourceHelpLabel',
  // The daily agronomy final fix wave (2026-09-26): the reasons a day has no
  // demand, the day's ET0 in the source line, and the crop beside a demand
  // computed by the cloud or by this gateway.
  'environment.water.demandNoSource',
  'environment.water.demandMixedStation',
  'environment.water.demandUnknownStation',
  'environment.water.demandUnknownToday',
  'environment.water.et0Line',
  'environment.water.kcSourceByCrop',
  // Daily agronomy parity (plan E2b): the FAO-56 curve, the overrun flag and a
  // shared-mode day OSI Cloud computed; the values are the cloud's translations.
  'environment.water.kcSource.fao56_curve',
  'environment.water.stageOverrun',
  'environment.water.et0Tier.open_meteo_daily',
  'environment.water.computedBy.edge',
  'environment.water.computedBy.cloud',
  'environment.water.modelAccuracyNote',
  'environment.water.meteoswissCloudNote',
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
// name, "Action" is the same word in French, and "Balance" is the Spanish
// term for the water balance tile.
const REVIEWED_IDENTICAL = new Set<string>([
  'es:environment.water.balance',
  'de-CH:zone.water.source.shared_server',
  'es:zone.water.source.shared_server',
  'fr:zone.water.source.shared_server',
  'it:zone.water.source.shared_server',
  'pt:zone.water.source.shared_server',
  'fr:zone.water.actionTitle',
  // A pure placeholder string and a product name.
  'de-CH:environment.water.kcSource.fao56_crop',
  'es:environment.water.kcSource.fao56_crop',
  'fr:environment.water.kcSource.fao56_crop',
  'it:environment.water.kcSource.fao56_crop',
  'pt:environment.water.kcSource.fao56_crop',
  'de-CH:environment.water.kcSource.server',
  'es:environment.water.kcSource.server',
  'fr:environment.water.kcSource.server',
  'it:environment.water.kcSource.server',
  'pt:environment.water.kcSource.server',
  // "Kc (...)" is a symbol and a placeholder; "Station" is the same word in
  // German and French; Spanish and Portuguese keep the product name MeteoSwiss.
  'de-CH:environment.water.kcLine',
  'es:environment.water.kcLine',
  'fr:environment.water.kcLine',
  'it:environment.water.kcLine',
  'pt:environment.water.kcLine',
  'de-CH:environment.water.et0Tier.station_fao56',
  'fr:environment.water.et0Tier.station_fao56',
  'de-CH:environment.water.et0Tier.hargreaves_station',
  'fr:environment.water.et0Tier.hargreaves_station',
  'es:environment.water.et0Tier.provider_meteoswiss',
  'pt:environment.water.et0Tier.provider_meteoswiss',
  // "ET0 {{et0}} mm" is a symbol, a placeholder and a unit; "{{source}},
  // {{crop}}" is two placeholders.
  'de-CH:environment.water.et0Line',
  'es:environment.water.et0Line',
  'fr:environment.water.et0Line',
  'it:environment.water.et0Line',
  'pt:environment.water.et0Line',
  'de-CH:environment.water.kcSourceByCrop',
  'es:environment.water.kcSourceByCrop',
  'fr:environment.water.kcSourceByCrop',
  'it:environment.water.kcSourceByCrop',
  'pt:environment.water.kcSourceByCrop',
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
