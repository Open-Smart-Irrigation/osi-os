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

// F37: GrantsPage.tsx, DraginoDendroCalibrationSection.tsx, the 9 Section
// titles in AdvancedScheduleDrawer.tsx, and the MOD9/MOD3 gating captions in
// DraginoSettingsModal.tsx had no useTranslation at all -- uniformly English
// regardless of the selected language. Mirrors the pattern in
// waterCardLocales.test.ts: a key missing from one locale silently falls
// back to English on that language, which is exactly the leak this pass
// closes.

const SETTINGS_KEYS = [
  'grants.eyebrow',
  'grants.title',
  'grants.navUsers',
  'grants.navDashboard',
  'grants.loadError',
  'grants.userSectionTitle',
  'grants.userSelectLabel',
  'grants.grantSectionTitle',
  'grants.grantSectionHint',
  'grants.zoneSelectLabel',
  'grants.grantZoneButton',
  'grants.zoneGrantError',
  'grants.plotUuidLabel',
  'grants.grantPlotButton',
  'grants.plotGrantError',
  'grants.sessionGrantsTitle',
  'grants.sessionGrantsEmpty',
  'grants.revokeButton',
  'grants.revokeConfirm',
  'grants.revokeError',
  'grants.kindZone',
  'grants.kindPlot',
];

const DEVICES_KEYS = [
  // dendroCalibration.* -- DraginoDendroCalibrationSection.tsx
  'dendroCalibration.modeRatio',
  'dendroCalibration.modeLegacy',
  'dendroCalibration.rangeBelow',
  'dendroCalibration.rangeAbove',
  'dendroCalibration.rangeInRange',
  'dendroCalibration.statusLabelLegacyForced',
  'dendroCalibration.statusLabelCalibrationRequired',
  'dendroCalibration.statusLabelOutOfRange',
  'dendroCalibration.statusLabelAwaitingBaseline',
  'dendroCalibration.statusLabelCalibrated',
  'dendroCalibration.statusDetailLegacyForced',
  'dendroCalibration.statusDetailCalibrationRequired',
  'dendroCalibration.statusDetailOutOfRange',
  'dendroCalibration.statusDetailAwaitingBaseline',
  'dendroCalibration.statusDetailCalibrated',
  'dendroCalibration.calibrationStatusLabel',
  'dendroCalibration.forceLegacyTitle',
  'dendroCalibration.forceLegacyDescription',
  'dendroCalibration.draftNotice',
  'dendroCalibration.liveTelemetryTitle',
  'dendroCalibration.telemetryStemChange',
  'dendroCalibration.telemetryRawPosition',
  'dendroCalibration.telemetryCh0',
  'dendroCalibration.telemetryCh1',
  'dendroCalibration.telemetryCurrentRatio',
  'dendroCalibration.telemetrySource',
  'dendroCalibration.telemetryRangeState',
  'dendroCalibration.step1Title',
  'dendroCalibration.step1Description',
  'dendroCalibration.strokeLabel',
  'dendroCalibration.step2Title',
  'dendroCalibration.step2Description',
  'dendroCalibration.retractedLabel',
  'dendroCalibration.step3Title',
  'dendroCalibration.step3Description',
  'dendroCalibration.extendedLabel',
  'dendroCalibration.captureRatioButton',
  'dendroCalibration.step4Title',
  'dendroCalibration.step4Description',
  'dendroCalibration.ratioModeExplainer',
  'dendroCalibration.saveButtonBusy',
  'dendroCalibration.saveButton',
  'dendroCalibration.saveErrorGeneric',
  'dendroCalibration.ratioMismatchError',
  'dendroCalibration.invalidValuesError',
  'dendroCalibration.saveSuccessLegacy',
  'dendroCalibration.saveSuccessRatio',
  'dendroCalibration.legacyResetTitle',
  'dendroCalibration.legacyResetDescription',
  'dendroCalibration.legacyResetButtonBusy',
  'dendroCalibration.legacyResetButton',
  'dendroCalibration.legacyResetConfirm',
  'dendroCalibration.legacyResetSuccess',
  'dendroCalibration.legacyResetError',
  'dendroCalibration.fieldRetractedRatioName',
  'dendroCalibration.fieldExtendedRatioName',
  'dendroCalibration.errorMustBeFiniteNumber',
  'dendroCalibration.errorMustBeGreaterThanZero',
  // advancedSchedule.* -- the 9 Section titles in AdvancedScheduleDrawer.tsx
  'advancedSchedule.sectionPhenology',
  'advancedSchedule.sectionScheduleParameters',
  'advancedSchedule.sectionRainSuppression',
  'advancedSchedule.sectionRecoveryVerification',
  'advancedSchedule.sectionZoneAggregation',
  'advancedSchedule.sectionExtractionWindows',
  'advancedSchedule.sectionTwdMethod',
  'advancedSchedule.sectionSdVpdCorrelation',
  'advancedSchedule.sectionLatestReasoningTrace',
  // lsn50Mode.* -- the MOD9/MOD3 gating captions in DraginoSettingsModal.tsx
  'lsn50Mode.mod3Description',
  'lsn50Mode.mod9Description',
  'lsn50Mode.chameleonRequiresMod3',
  'lsn50Mode.requiredModeGeneric',
  'lsn50Mode.rainGaugeNeedsMod9',
  'lsn50Mode.chameleonNeedsMod3',
];

// Luganda is human translation work product: where no reviewed Luganda
// exists, the honest shipped value is the English source text, never a
// machine translation. Every key above is in that state today (tracked in
// docs/i18n/pending-luganda-translations.md), and this assertion is what
// forces the doc and the shipped file to move together.
const PENDING_HUMAN_LUGANDA = new Set<string>([...SETTINGS_KEYS, ...DEVICES_KEYS]);

// locale:key pairs where matching English is correct, not an untranslated
// leak: "MOD3"/"CH0"/"CH1" are firmware/hardware identifiers never
// translated anywhere in this app (same treatment as "MOD9" itself); "Zone",
// "Administration" and "Source" are genuine French cognates spelled
// identically to English; "Dashboard" is kept as a loanword in de-CH/it,
// matching the existing settings.json `area_dashboard` entry for those two
// locales.
const REVIEWED_IDENTICAL = new Set<string>([
  'fr:dendroCalibration.modeRatio',
  'de-CH:dendroCalibration.modeRatio',
  'it:dendroCalibration.modeRatio',
  'es:dendroCalibration.modeRatio',
  'pt:dendroCalibration.modeRatio',
  'fr:dendroCalibration.telemetryCh0',
  'de-CH:dendroCalibration.telemetryCh0',
  'it:dendroCalibration.telemetryCh0',
  'es:dendroCalibration.telemetryCh0',
  'pt:dendroCalibration.telemetryCh0',
  'fr:dendroCalibration.telemetryCh1',
  'de-CH:dendroCalibration.telemetryCh1',
  'it:dendroCalibration.telemetryCh1',
  'es:dendroCalibration.telemetryCh1',
  'pt:dendroCalibration.telemetryCh1',
  'fr:dendroCalibration.telemetrySource',
  'fr:grants.eyebrow',
  'fr:grants.zoneSelectLabel',
  'fr:grants.kindZone',
  'de-CH:grants.navDashboard',
  'de-CH:grants.zoneSelectLabel',
  'it:grants.navDashboard',
]);

test('F37 keys exist in every shipped locale', () => {
  for (const locale of LOCALES) {
    const settings = readNamespace(locale, 'settings');
    for (const key of SETTINGS_KEYS) {
      assert.equal(typeof getPath(settings, key), 'string', `${locale} settings.json missing ${key}`);
    }
    const devices = readNamespace(locale, 'devices');
    for (const key of DEVICES_KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
  }
});

test('F37 interpolation placeholders match English in every locale', () => {
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  for (const [namespace, keys] of [['settings', SETTINGS_KEYS], ['devices', DEVICES_KEYS]] as const) {
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

test('the five European locales translate every new F37 key', () => {
  for (const [namespace, keys] of [['settings', SETTINGS_KEYS], ['devices', DEVICES_KEYS]] as const) {
    const english = readNamespace('en', namespace);
    for (const locale of ['de-CH', 'es', 'fr', 'it', 'pt']) {
      const translated = readNamespace(locale, namespace);
      const identical = keys.filter((key) => getPath(translated, key) === getPath(english, key));
      // Loanwords/cognates/firmware identifiers are the only expected
      // exceptions; everything else identical to English would be an
      // untranslated key.
      assert.deepEqual(
        identical,
        identical.filter((key) => REVIEWED_IDENTICAL.has(`${locale}:${key}`)),
        `${locale} ${namespace}.json has untranslated F37 values`,
      );
    }
  }
});

test('Luganda ships the English source text for F37 keys until a human pass lands', () => {
  for (const [namespace, keys] of [['settings', SETTINGS_KEYS], ['devices', DEVICES_KEYS]] as const) {
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

test('de-CH F37 copy avoids the eszett', () => {
  const german = readNamespace('de-CH', 'devices');
  const germanSettings = readNamespace('de-CH', 'settings');
  for (const key of DEVICES_KEYS) {
    const value = getPath(german, key) as string;
    assert.ok(!value.includes('ß'), `de-CH devices.json ${key} uses ß instead of Swiss spelling`);
  }
  for (const key of SETTINGS_KEYS) {
    const value = getPath(germanSettings, key) as string;
    assert.ok(!value.includes('ß'), `de-CH settings.json ${key} uses ß instead of Swiss spelling`);
  }
});
