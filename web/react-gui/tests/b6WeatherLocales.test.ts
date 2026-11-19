import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../public/locales');
const read = (locale: string) => JSON.parse(fs.readFileSync(path.join(root, locale, 'devices.json'), 'utf8'));
const en = read('en');
function leaves(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, val]) => typeof val === 'string' ? [`${prefix}${key}`] : leaves(val as Record<string, unknown>, `${prefix}${key}.`));
}
const keys = [
  ...leaves(en.weatherCard, 'weatherCard.'),
  ...leaves(en.environment.compass, 'environment.compass.'),
  ...leaves(en.environment.agronomic.vpdStatus, 'environment.agronomic.vpdStatus.'),
  ...leaves(en.environment.agronomic.thiStatus, 'environment.agronomic.thiStatus.'),
  'environment.agronomic.conditions', 'environment.agronomic.evapotranspiration',
  'environment.forecast.rain', 'environment.forecast.probability',
  'environment.forecast.hourlyHelp', 'environment.forecast.hourlyHelpLabel',
];
const at = (data: any, key: string): string => key.split('.').reduce((obj, part) => obj?.[part], data);

test('B6 weather labels have keys and matching interpolation fields in every locale', () => {
  for (const locale of ['de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
    const data = read(locale);
    for (const key of keys) {
      const text = at(data, key);
      assert.equal(typeof text, 'string', `${locale} ${key}`);
      assert.deepEqual(text.match(/{{\w+}}/g)?.sort(), at(en, key).match(/{{\w+}}/g)?.sort(), `${locale} ${key}`);
    }
  }
});

test('B6 pending Luganda keys retain English and are individually recorded', () => {
  const lg = read('lg');
  const ledger = fs.readFileSync(path.resolve(import.meta.dirname, '../../../docs/i18n/pending-luganda-translations.md'), 'utf8').split('## UI FIX-LIST B6 (weather and agronomy)')[1];
  assert.ok(ledger);
  for (const key of keys) {
    assert.equal(at(lg, key), at(en, key), key);
    assert.ok(ledger.includes(`\`${key}\``), key);
  }
});
