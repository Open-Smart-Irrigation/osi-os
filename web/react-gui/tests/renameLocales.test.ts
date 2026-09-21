import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The nine strings the rename affordance needs: the two pencil labels, the two
 * input labels, the four reason texts of the name rule (design section 4) and
 * the generic failure. Read by
 * src/components/farming/shared/EditableName.tsx and by the three device/zone
 * creation modals.
 *
 * Same contract as tests/systemPanelLocales.test.ts: present in all seven
 * bundles, matching interpolation placeholders, translated in the five European
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
  'rename.zone',
  'rename.device',
  'rename.zoneInputLabel',
  'rename.deviceInputLabel',
  'rename.reason.name_empty',
  'rename.reason.name_too_long',
  'rename.reason.name_control_characters',
  'rename.reason.name_invalid_unicode',
  'rename.failed',
];

// Luganda is human translation work product: where no reviewed Luganda exists,
// the honest shipped value is the English source text, never a machine
// translation. Every key above is in that state, tracked in
// docs/i18n/pending-luganda-translations.md. A human pass must change both
// files together, and this assertion is what forces that.
const PENDING_HUMAN_LUGANDA = new Set<string>(KEYS);

test('rename keys exist in every shipped locale', () => {
  for (const locale of LOCALES) {
    const devices = readDevices(locale);
    for (const key of KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
  }
});

test('rename interpolation placeholders match English in every locale', () => {
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

test('the five European locales translate every rename key', () => {
  const english = readDevices('en');
  for (const locale of EUROPEAN) {
    const translated = readDevices(locale);
    const identical = KEYS.filter((key) => getPath(translated, key) === getPath(english, key));
    assert.deepEqual(identical, [], `${locale} devices.json has untranslated rename values`);
  }
});

test('Luganda ships the English source text for the rename keys until a human pass lands', () => {
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
