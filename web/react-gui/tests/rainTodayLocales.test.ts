import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The rain "today" tile strings (src/components/farming/shared/RainTodayTile.tsx): present in
 * all seven bundles with the same placeholders, translated in the five European locales, and
 * English in Luganda until the human pass lands.
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];
const KEYS = ['recordedToday', 'soFar', 'lastReportOn'];

const rain = (locale: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8')).rain ?? {};
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

test('rain today strings exist in every locale with the English placeholders', () => {
  const en = rain('en');
  for (const locale of [...EUROPEAN, 'lg']) {
    const strings = rain(locale);
    for (const key of KEYS) {
      assert.equal(typeof strings[key], 'string', `${locale} rain.${key}`);
      assert.deepEqual(placeholders(strings[key]), placeholders(en[key]), `${locale} rain.${key} placeholders`);
    }
  }
});

test('European locales translate; Luganda carries English for the human pass', () => {
  const en = rain('en');
  for (const locale of EUROPEAN) {
    for (const key of KEYS) assert.notEqual(rain(locale)[key], en[key], `${locale} rain.${key} untranslated`);
  }
  assert.deepEqual(rain('lg'), en);
});
