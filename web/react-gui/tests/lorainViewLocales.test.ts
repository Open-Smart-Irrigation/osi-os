import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Rain presentation strings (LoRain card "Last report" tile, the Data view's legacy-estimate
 * switch and suffix, the "reports received" tooltip note, the CSV quality-columns switch): present in all seven bundles with
 * the English placeholders, translated in the five European locales, and English in Luganda
 * until the human pass (docs/i18n/pending-luganda-translations.md).
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];
const KEYS: Array<[string, string]> = [
  ['devices', 'loRain.intervalRainfall'],
  ['devices', 'loRain.lastReport'],
  ['devices', 'loRain.tips_one'],
  ['devices', 'loRain.tips_other'],
  ['devices', 'loRain.tipsUnavailable'],
  ['common', 'analysis.tray.showLegacy'],
  ['common', 'analysis.legacyEstimate'],
  ['common', 'analysis.tooltip.reportsReceived_one'],
  ['common', 'analysis.tooltip.reportsReceived_other'],
  ['common', 'analysis.export.qualityColumns'],
];
// A human Luganda pass drops a key from this set and from the pending table in the same change.
const PENDING_HUMAN_LUGANDA = new Set(KEYS.map(([ns, key]) => `${ns}:${key}`));

const read = (locale: string, ns: string) => JSON.parse(fs.readFileSync(path.join(localeRoot, locale, `${ns}.json`), 'utf8'));
const pick = (tree: unknown, key: string): unknown => key.split('.').reduce<unknown>(
  (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
  tree,
);
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

test('rain presentation strings exist in every locale with the English placeholders', () => {
  for (const [ns, key] of KEYS) {
    const en = pick(read('en', ns), key);
    assert.equal(typeof en, 'string', `en ${ns}:${key}`);
    for (const locale of [...EUROPEAN, 'lg']) {
      const value = pick(read(locale, ns), key);
      assert.equal(typeof value, 'string', `${locale} ${ns}:${key}`);
      assert.deepEqual(placeholders(value as string), placeholders(en as string), `${locale} ${ns}:${key} placeholders`);
      if (locale === 'de-CH') assert.ok(!(value as string).includes('ß'), `de-CH ${ns}:${key} uses ß`);
    }
  }
});

test('European locales translate; Luganda carries English for the human pass', () => {
  for (const [ns, key] of KEYS) {
    const en = pick(read('en', ns), key);
    for (const locale of EUROPEAN) assert.notEqual(pick(read(locale, ns), key), en, `${locale} ${ns}:${key} untranslated`);
    if (PENDING_HUMAN_LUGANDA.has(`${ns}:${key}`)) assert.equal(pick(read('lg', ns), key), en, `lg ${ns}:${key} changed`);
  }
});
