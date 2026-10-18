import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The zone rain gauge strings (src/components/farming/ZoneRainGaugeField.tsx and
 * src/components/farming/environment/RainGaugeAmbiguityBanner.tsx): present in all seven
 * bundles with the same placeholders, translated in the five European locales, and English in
 * Luganda until the human pass lands.
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];
const KEYS = ['label', 'helpLabel', 'help', 'notChosen', 'optionShared', 'optionSuggested', 'ambiguous',
  'onlyCandidate', 'loadFailed', 'banner'];

const group = (locale: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8')).zoneRainGauge ?? {};
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

test('zone rain gauge strings exist in every locale with the English placeholders', () => {
  const en = group('en');
  assert.deepEqual(Object.keys(en).sort(), [...KEYS].sort());
  for (const locale of [...EUROPEAN, 'lg']) {
    const strings = group(locale);
    for (const key of KEYS) {
      assert.equal(typeof strings[key], 'string', `${locale} zoneRainGauge.${key}`);
      assert.deepEqual(placeholders(strings[key]), placeholders(en[key]), `${locale} zoneRainGauge.${key} placeholders`);
    }
  }
});

test('European locales translate; Luganda carries English for the human pass', () => {
  const en = group('en');
  for (const locale of EUROPEAN) {
    for (const key of KEYS) assert.notEqual(group(locale)[key], en[key], `${locale} zoneRainGauge.${key} untranslated`);
  }
  assert.deepEqual(group('lg'), en);
});
