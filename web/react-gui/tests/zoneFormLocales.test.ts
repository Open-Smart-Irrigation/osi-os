import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The two forms that configure irrigation: `ScheduleSection`'s trigger form
 * (the only screen where a farmer sets the number that opens a valve) and
 * `ZoneConfigModal` (crop, soil, area, efficiency, timezone, coordinates —
 * every input to the water balance). Both rendered entirely in English inside
 * French and German screens.
 *
 * Same contract as tests/waterCardLocales.ts: present in all seven bundles,
 * matching interpolation placeholders, translated in the five European
 * locales, and byte-identical English in Luganda until a human pass lands.
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];

function readDevices(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
}

function getPath(tree: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, tree);
}

const KEYS = [
  'schedule.triggerMethod',
  'schedule.methodSwt',
  'schedule.methodDendro',
  'schedule.sensor',
  'schedule.irrigateWhen',
  'schedule.durationMin',
  'schedule.triggerSensitivity',
  'schedule.baseDurationMin',
  'schedule.responseMode',
  'schedule.advancedSettings',
  'schedule.metric.SWT_1',
  'schedule.metric.SWT_2',
  'schedule.metric.SWT_3',
  'schedule.metric.SWT_AVG',
  'schedule.stress.mild',
  'schedule.stress.moderate',
  'schedule.stress.significant',
  'schedule.stress.severe',
  'schedule.mode.proportional',
  'schedule.mode.fixed',
  'schedule.mode.aggressive',
  'zoneConfig.title',
  'zoneConfig.crop',
  'zoneConfig.selectCrop',
  'zoneConfig.variety',
  'zoneConfig.varietyPlaceholder',
  'zoneConfig.soilType',
  'zoneConfig.irrigationMethod',
  'zoneConfig.area',
  'zoneConfig.irrigationEfficiency',
  'zoneConfig.calibrationTitle',
  'zoneConfig.flowRate',
  'zoneConfig.measurementMethod',
  'zoneConfig.measurementMethodPlaceholder',
  'zoneConfig.dendroCalibration',
  'zoneConfig.phenologicalStage',
  'zoneConfig.timezone',
  'zoneConfig.zoneLocation',
  'zoneConfig.latitude',
  'zoneConfig.longitude',
  'zoneConfig.deviceGps',
  'zoneConfig.useDeviceLocation',
  'zoneConfig.locating',
  'zoneConfig.permissionState',
  'zoneConfig.checkingGps',
  'zoneConfig.locationCaptured',
  'zoneConfig.captured',
  'zoneConfig.capturedAccuracy',
  'zoneConfig.capturedViaApp',
  'zoneConfig.capturedViaBrowser',
  'zoneConfig.openAppSettings',
  'zoneConfig.openSettingsHint',
  'zoneConfig.notes',
  'zoneConfig.notesPlaceholder',
  'zoneConfig.save',
  'zoneConfig.saving',
  'zoneConfig.soil.select',
  'zoneConfig.soil.sandy',
  'zoneConfig.soil.sandy_loam',
  'zoneConfig.soil.loam',
  'zoneConfig.soil.clay_loam',
  'zoneConfig.soil.clay',
  'zoneConfig.soil.silt_loam',
  'zoneConfig.soil.other',
  'zoneConfig.method.select',
  'zoneConfig.method.drip',
  'zoneConfig.method.sprinkler',
  'zoneConfig.method.furrow',
  'zoneConfig.method.flood',
  'zoneConfig.method.subsurface',
  'zoneConfig.method.other',
  'zoneConfig.calibration.default',
  'zoneConfig.calibration.apple',
  'zoneConfig.calibration.grapevine',
  'zoneConfig.calibration.olive',
  'zoneConfig.stage.default',
  'zoneConfig.stage.dormancy',
  'zoneConfig.stage.budbreak',
  'zoneConfig.stage.fruitset',
  'zoneConfig.stage.veraison',
  'zoneConfig.stage.harvest',
  'zoneConfig.gps.available',
  'zoneConfig.gps.permissionNeeded',
  'zoneConfig.gps.checking',
  'zoneConfig.gps.unavailable',
  'zoneConfig.errors.bothCoordinates',
  'zoneConfig.errors.latitudeRange',
  'zoneConfig.errors.longitudeRange',
  'zoneConfig.errors.flowRateRequired',
  'zoneConfig.errors.flowRatePositive',
  'zoneConfig.errors.saveFailed',
  'environment.water.effective',
  'environment.water.rainGaugeReporting',
  'environment.water.flowMeterReporting',
  'environment.water.tooltipRain',
  'environment.water.tooltipMeasuredEffective',
  'environment.water.tooltipEstimatedEffective',
];

/** `locale:key` pairs where matching English is the correct translation. */
const REVIEWED_IDENTICAL = new Set<string>([
  'de-CH:schedule.methodDendro',
  'de-CH:schedule.sensor',
  'es:schedule.sensor',
  'pt:schedule.sensor',
  'de-CH:schedule.metric.SWT_1',
  'de-CH:schedule.metric.SWT_2',
  'de-CH:schedule.metric.SWT_3',
  'es:schedule.metric.SWT_1',
  'es:schedule.metric.SWT_2',
  'es:schedule.metric.SWT_3',
  'pt:schedule.metric.SWT_1',
  'pt:schedule.metric.SWT_2',
  'pt:schedule.metric.SWT_3',
  // Same word in the target language.
  'de-CH:zoneConfig.calibration.olive',
  'fr:zoneConfig.latitude',
  'fr:zoneConfig.longitude',
  'fr:zoneConfig.notes',
  'pt:zoneConfig.latitude',
  'pt:zoneConfig.longitude',
]);

test('every zone-form key resolves in all seven locales', () => {
  for (const locale of LOCALES) {
    const devices = readDevices(locale);
    for (const key of KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
  }
});

test('interpolation placeholders match English in every locale', () => {
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  const english = readDevices('en');
  for (const locale of LOCALES) {
    const translated = readDevices(locale);
    for (const key of KEYS) {
      assert.equal(
        placeholders(getPath(translated, key) as string),
        placeholders(getPath(english, key) as string),
        `${locale} devices.json placeholder mismatch at ${key}`,
      );
    }
  }
});

test('the five European locales translate every zone-form key', () => {
  const english = readDevices('en');
  for (const locale of EUROPEAN) {
    const translated = readDevices(locale);
    const identical = KEYS.filter((key) => getPath(translated, key) === getPath(english, key));
    assert.deepEqual(
      identical,
      identical.filter((key) => REVIEWED_IDENTICAL.has(`${locale}:${key}`)),
      `${locale} devices.json has untranslated zone-form values`,
    );
  }
});

test('Luganda ships the English source text until a human pass lands', () => {
  const english = readDevices('en');
  const luganda = readDevices('lg');
  for (const key of KEYS) {
    assert.equal(
      getPath(luganda, key),
      getPath(english, key),
      `lg devices.json ${key} changed; drop it from docs/i18n/pending-luganda-translations.md and from this list`,
    );
  }
});

test('de-CH avoids the eszett', () => {
  const german = readDevices('de-CH');
  for (const key of KEYS) {
    const value = getPath(german, key) as string;
    assert.ok(!value.includes('ß'), `de-CH ${key} uses ß instead of Swiss spelling`);
  }
});
