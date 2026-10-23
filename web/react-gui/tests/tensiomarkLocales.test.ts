import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Tensiomark settings and card strings (`sdi12.tensiomark.*` in devices.json): present in all
 * seven bundles with the English placeholders, translated in the five European locales, and
 * English in Luganda until the human pass (docs/i18n/pending-luganda-translations.md).
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];
// Units and the sensor abbreviation read the same in every language.
const SAME_IN_ALL = new Set(['depthCm', 'swt']);

const read = (locale: string) => JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
const flatten = (tree: Record<string, unknown>, prefix = ''): Array<[string, unknown]> => Object.entries(tree).flatMap(
  ([key, value]) => (value && typeof value === 'object'
    ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
    : [[`${prefix}${key}`, value] as [string, unknown]]),
);
const block = (locale: string) => new Map(flatten(read(locale).sdi12.tensiomark as Record<string, unknown>));
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

const EN = block('en');
// A human Luganda pass drops a key from this set and from the pending table in the same change.
const PENDING_HUMAN_LUGANDA = new Set(EN.keys());

test('Tensiomark strings exist in every locale with the English key set and placeholders', () => {
  assert.ok(EN.size >= 25, 'English Tensiomark block is unexpectedly small');
  for (const locale of [...EUROPEAN, 'lg']) {
    const values = block(locale);
    assert.deepEqual([...values.keys()].sort(), [...EN.keys()].sort(), `${locale} key set`);
    for (const [key, en] of EN) {
      const value = values.get(key);
      assert.equal(typeof value, 'string', `${locale} ${key}`);
      assert.deepEqual(placeholders(value as string), placeholders(en as string), `${locale} ${key} placeholders`);
      if (locale === 'de-CH') assert.ok(!(value as string).includes('ß'), `de-CH ${key} uses ß`);
    }
  }
});

test('European locales translate; Luganda carries English for the human pass', () => {
  for (const locale of EUROPEAN) {
    const values = block(locale);
    for (const [key, en] of EN) {
      if (!SAME_IN_ALL.has(key)) assert.notEqual(values.get(key), en, `${locale} ${key} untranslated`);
    }
  }
  const lg = block('lg');
  for (const key of PENDING_HUMAN_LUGANDA) assert.equal(lg.get(key), EN.get(key), `lg ${key} changed`);
});

test('operator copy avoids the developer term bench-observed', () => {
  for (const locale of ['en', ...EUROPEAN]) {
    for (const [key, value] of block(locale)) assert.doesNotMatch(String(value), /bench|Versuch/i, `${locale} ${key}`);
  }
});
