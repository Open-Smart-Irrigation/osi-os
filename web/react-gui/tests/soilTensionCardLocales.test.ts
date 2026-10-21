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
// Human Luganda that already existed for the same English meaning, kept under the shared footer
// keys: the Kiwi card's "Last seen: N minutes ago" and "Never seen". Never machine text.
const HUMAN_LUGANDA_REUSED: Record<string, { key: string; from: string; to: string }> = {
  'deviceCard.footer.lastSeenMinutes': { key: 'kiwiSensor.lastSeen', from: '{{minutes}}', to: '{{count}}' },
  'deviceCard.footer.neverSeen': { key: 'kiwiSensor.neverSeen', from: '', to: '' },
};
// A human Luganda pass drops a key from this set and from the pending table in the same change.
const PENDING_HUMAN_LUGANDA = new Set([...EN.keys()].filter((key) => !(key in HUMAN_LUGANDA_REUSED)));

test('soil tension card strings exist in every locale with the English key set and placeholders', () => {
  assert.ok(EN.size >= 27, 'English soil tension card block is unexpectedly small');
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

test('the shared footer keeps the existing human Luganda last-seen strings', () => {
  const lgDevices = read('lg');
  const enDevices = read('en');
  const lg = block('lg');
  for (const [key, source] of Object.entries(HUMAN_LUGANDA_REUSED)) {
    const human = lookup(lgDevices, source.key) as string;
    assert.notEqual(human, lookup(enDevices, source.key), `lg ${source.key} is no longer human Luganda`);
    assert.equal(lg.get(key), source.from ? human.replace(source.from, source.to) : human, `lg ${key}`);
  }
});

test('the footer carries the cloud key names: relative tiers, the absolute date, battery', () => {
  assert.deepEqual(
    [...EN.keys()].filter((key) => key.startsWith('deviceCard.footer.')).sort(),
    ['battery', 'batteryLow', 'lastSeenAt', 'lastSeenHours', 'lastSeenJustNow', 'lastSeenMinutes', 'neverSeen']
      .map((key) => `deviceCard.footer.${key}`),
  );
  assert.equal(EN.get('deviceCard.footer.lastSeenAt'), 'Last seen {{date}}');
});

test('every footer key still English in lg is on the Luganda release gate (R16 M2)', () => {
  const ledger = fs.readFileSync(path.resolve(process.cwd(), '../../docs/i18n/pending-luganda-translations.md'), 'utf8');
  const start = ledger.indexOf('## Release gate');
  assert.ok(start >= 0, 'the ledger has no "Release gate" section');
  const end = ledger.indexOf('\n## ', start + 1);
  const gate = ledger.slice(start, end === -1 ? undefined : end);
  const english = [...PENDING_HUMAN_LUGANDA].filter((key) => key.startsWith('deviceCard.footer.'));
  assert.ok(english.length > 0);
  for (const key of english) assert.ok(gate.includes(`\`${key}\``), `${key} missing from the release gate`);
  assert.ok(gate.includes('`common.batteryEstimated`'), 'common.batteryEstimated missing from the release gate');
});
