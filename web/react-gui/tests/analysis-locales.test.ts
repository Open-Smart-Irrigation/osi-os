import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const localesRoot = join(import.meta.dirname, '..', 'public', 'locales');

function keyPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

test('English analysis layout actions use imperative labels', () => {
  const analysis = JSON.parse(readFileSync(join(localesRoot, 'en', 'common.json'), 'utf8')).analysis;
  assert.equal(analysis.layout.stacked, 'Stack');
  assert.equal(analysis.layout.overlaid, 'Overlay');
});

test('all edge locales expose the same analysis translation key shape', () => {
  const languages = readdirSync(localesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const baseline = JSON.parse(readFileSync(join(localesRoot, 'en', 'common.json'), 'utf8')).analysis;
  const expected = keyPaths(baseline).sort();

  for (const language of languages) {
    const common = JSON.parse(readFileSync(join(localesRoot, language, 'common.json'), 'utf8'));
    assert.ok(common.analysis, `${language}/common.json must contain analysis translations`);
    assert.equal(
      typeof common.analysis.export.allZonesCsv,
      'string',
      `${language}/common.json must translate the portable all-zones export action`,
    );
    assert.ok(common.analysis.export.allZonesCsv.trim().length > 0);
    assert.deepEqual(keyPaths(common.analysis).sort(), expected, `${language} analysis keys drifted from en`);
  }
});

test('the weather data view keys resolve in all seven locales with matching placeholders', () => {
  const keys = ['aggregation.helpLabel', 'aggregation.help', 'tooltip.partialHours', 'tooltip.partialDays'];
  // lg ships the English text until a human pass; a translated key leaves this
  // set and docs/i18n/pending-luganda-translations.md in the same change.
  const PENDING_HUMAN_LUGANDA = new Set(keys);
  const pick = (tree: unknown, key: string) => key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  const analysisOf = (language: string) => JSON.parse(readFileSync(join(localesRoot, language, 'common.json'), 'utf8')).analysis;
  const english = analysisOf('en');
  for (const language of ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
    const analysis = analysisOf(language);
    for (const key of keys) {
      const value = pick(analysis, key);
      assert.equal(typeof value, 'string', `${language} analysis.${key} is missing`);
      assert.equal(placeholders(value as string), placeholders(pick(english, key) as string), `${language} analysis.${key} placeholders`);
      if (language === 'lg' && PENDING_HUMAN_LUGANDA.has(key)) {
        assert.equal(value, pick(english, key), `lg analysis.${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`);
      }
      if (language === 'de-CH') assert.ok(!(value as string).includes('ß'), `de-CH analysis.${key} uses ß`);
    }
  }
});

test('the saved-view delete confirmation resolves in all seven locales', () => {
  const keys = [
    'views.confirmDelete',
  ];
  // lg ships the English text until a human pass; a translated key leaves this
  // set and docs/i18n/pending-luganda-translations.md in the same change.
  const PENDING_HUMAN_LUGANDA = new Set(keys);
  const pick = (tree: unknown, key: string) => key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  const analysisOf = (language: string) => JSON.parse(readFileSync(join(localesRoot, language, 'common.json'), 'utf8')).analysis;
  const english = analysisOf('en');
  assert.match(pick(english, 'views.confirmDelete') as string, /\{\{name\}\}/);
  for (const language of ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
    const analysis = analysisOf(language);
    for (const key of keys) {
      const value = pick(analysis, key);
      assert.equal(typeof value, 'string', `${language} analysis.${key} is missing`);
      assert.ok((value as string).trim().length > 0, `${language} analysis.${key} is empty`);
      assert.equal(placeholders(value as string), placeholders(pick(english, key) as string), `${language} analysis.${key} placeholders`);
      if (language === 'lg' && PENDING_HUMAN_LUGANDA.has(key)) {
        assert.equal(value, pick(english, key), `lg analysis.${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`);
      }
      if (language !== 'en' && language !== 'lg') {
        assert.notEqual(value, pick(english, key), `${language} analysis.${key} is untranslated`);
      }
      if (language === 'de-CH') assert.ok(!(value as string).includes('ß'), `de-CH analysis.${key} uses ß`);
    }
  }
});
