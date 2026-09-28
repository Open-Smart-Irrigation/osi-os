import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The WATERMARK soil-tension strings added in Tasks 9-10: probe cards, status
 * codes, probe-depth editor and the calibration form. Read by
 * src/components/farming/shared/WatermarkProbeSection.tsx,
 * src/components/farming/WatermarkDepthSection.tsx,
 * src/components/farming/WatermarkCalibrationSection.tsx and
 * src/components/farming/DraginoTempCard.tsx / DraginoSettingsModal.tsx.
 *
 * Same contract as tests/renameLocales.test.ts and
 * tests/systemPanelLocales.test.ts: present in all seven bundles with
 * matching interpolation placeholders, translated in the five European
 * locales, and byte-identical English in Luganda until a human pass lands.
 *
 * Unlike those tests, the key list here is not a fixed literal: it is
 * collected dynamically from every leaf under `en` devices.json's
 * `watermark` group, so a new key added under that group (e.g. a future
 * `watermark.depths.invalid`-style addition) is covered automatically
 * without editing this file.
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

/** Every leaf key under `watermark`, as dotted paths rooted at `watermark`. */
function collectLeafKeys(tree: unknown, prefix: string): string[] {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return [prefix];
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    out.push(...collectLeafKeys(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

const englishDevices = readDevices('en');
const watermarkRoot = getPath(englishDevices, 'watermark');
assert.ok(watermarkRoot && typeof watermarkRoot === 'object', 'en devices.json has no watermark group to collect keys from');
const KEYS = collectLeafKeys(watermarkRoot, 'watermark').sort();

// Units, symbols and "OK" may legitimately match English in every locale:
// there is nothing to translate in "OK", "≤ {{value}}", or the two
// Ω-suffixed electronics loanwords ("Pull-up"/"Pull-down") shared with bench
// documentation in every language. "Series, forward"/"Series, reverse" are
// plain English prose, not loanwords, so they are NOT exempt here and must
// be translated (Task 11 fix round 1).
const IDENTICAL_OK = new Set<string>([
  'watermark.status.ok',
  'watermark.wetUpTo',
  'watermark.calibration.pullup',
  'watermark.calibration.pulldown',
]);

// Luganda is human translation work product: where no reviewed Luganda exists,
// the honest shipped value is the English source text, never a machine
// translation. Every watermark key is in that state, tracked in
// docs/i18n/pending-luganda-translations.md.
const PENDING_HUMAN_LUGANDA = new Set<string>(KEYS);

test('watermark keys exist in every shipped locale', () => {
  assert.ok(KEYS.length > 0, 'no watermark leaf keys found in en devices.json');
  for (const locale of LOCALES) {
    const devices = readDevices(locale);
    for (const key of KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
  }
});

test('watermark interpolation placeholders match English in every locale', () => {
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

test('the five European locales translate every watermark key except units and symbols', () => {
  const english = readDevices('en');
  for (const locale of EUROPEAN) {
    const translated = readDevices(locale);
    const identical = KEYS.filter(
      (key) => !IDENTICAL_OK.has(key) && getPath(translated, key) === getPath(english, key),
    );
    assert.deepEqual(identical, [], `${locale} devices.json has untranslated watermark values`);
  }
});

test('Luganda ships the English source text for the watermark keys until a human pass lands', () => {
  const english = readDevices('en');
  const luganda = readDevices('lg');
  for (const key of KEYS) {
    if (!PENDING_HUMAN_LUGANDA.has(key)) continue;
    assert.equal(
      getPath(luganda, key),
      getPath(english, key),
      `lg devices.json ${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`,
    );
  }
});
