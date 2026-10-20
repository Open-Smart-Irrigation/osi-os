import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The shared soil tension card strings (devices.json): the `soilTension.*` layout used by the
 * WATERMARK and Tensiomark cards (src/components/farming/shared/SoilTensionReadings.tsx), the
 * device card footer and settings labels (`deviceCard.*`) and the SDI-12 card header and
 * notices (`sdi12Soil.*` below). Present in all seven bundles with the English placeholders,
 * translated in the five European locales, and English in Luganda until a human pass
 * (docs/i18n/pending-luganda-translations.md).
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];
const SDI12_CARD_KEYS = [
  'sdi12Soil.badge',
  'sdi12Soil.noProfile',
  'sdi12Soil.detecting',
  'sdi12Soil.invalidLayout',
  'sdi12Soil.status.pending_identify',
  'sdi12Soil.status.identified',
  'sdi12Soil.status.unmatched',
  'sdi12Soil.status.manual',
  'sdi12Soil.status.unknown',
];
// The depth unit, product names and the bus name read the same in every language.
const SAME_IN_ALL = new Set(['soilTension.depthCm', 'soilTension.family.watermark', 'soilTension.family.tensiomark', 'sdi12Soil.badge']);

const read = (locale: string) => JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
const flatten = (tree: Record<string, unknown>, prefix: string): Array<[string, unknown]> => Object.entries(tree).flatMap(
  ([key, value]) => (value && typeof value === 'object'
    ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
    : [[`${prefix}${key}`, value] as [string, unknown]]),
);
const lookup = (tree: Record<string, unknown>, key: string): unknown => key.split('.')
  .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
function block(locale: string): Map<string, unknown> {
  const devices = read(locale);
  return new Map([
    ...flatten(devices.soilTension ?? {}, 'soilTension.'),
    ...flatten(devices.deviceCard ?? {}, 'deviceCard.'),
    ...SDI12_CARD_KEYS.map((key) => [key, lookup(devices, key)] as [string, unknown]),
  ]);
}
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();

const EN = block('en');
// A human Luganda pass drops a key from this set and from the pending table in the same change.
const PENDING_HUMAN_LUGANDA = new Set(EN.keys());

test('soil tension card strings exist in every locale with the English key set and placeholders', () => {
  assert.ok(EN.size >= 28, 'English soil tension card block is unexpectedly small');
  for (const [key, value] of EN) assert.equal(typeof value, 'string', `en ${key}`);
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

test('every last-seen tier has its singular and plural form', () => {
  for (const tier of ['minutes', 'hours', 'days']) {
    for (const form of ['one', 'other']) assert.ok(EN.has(`deviceCard.lastSeen.${tier}_${form}`), `${tier}_${form}`);
  }
});
