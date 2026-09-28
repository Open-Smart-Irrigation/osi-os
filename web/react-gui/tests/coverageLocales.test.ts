import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import i18next from 'i18next';

/**
 * The coverage walk of 2026-09-25 is read off NetworkPage while an operator
 * carries a RAK10701 around the farm, and the demo runs in French. Every string
 * of that view needs a value in all seven bundles or the page falls back to
 * English on the one language the customer is reading.
 *
 * Same contract as tests/moduleVisibilityLocales.test.ts: present in all seven
 * bundles, matching interpolation placeholders, translated in the five European
 * locales, and byte-identical English in Luganda until a human pass lands.
 *
 * `points` additionally carries plural forms, and the last test renders them
 * through real i18next rather than inspecting the JSON: the first uplink of a
 * walk makes that count 1, so "1 points positionnés" would be the first thing
 * the customer reads.
 *
 * The show-all/show-fewer toggle on the Observations list is two more keys of
 * the same page under the same contract, tested near the bottom of this file;
 * they live outside `network.coverage`, so they get their own small block
 * rather than joining KEYS.
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];

function readNetwork(locale: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'network.json'), 'utf8'));
}
function readCoverage(locale: string): Record<string, string> {
  return (readNetwork(locale).network?.coverage ?? {}) as Record<string, string>;
}

const KEYS = [
  'title', 'window', 'windowLastHour', 'windowHours', 'windowDays', 'export',
  'gateway', 'legendStrong', 'legendWeak', 'noPosition', 'noPoints', 'captureOff',
];

/**
 * The one key driven by live data, so the one that needs plural forms. The
 * window labels take `{{count}}` too but COVERAGE_WINDOWS only ever supplies
 * 6, 24, 168 and 720 -- the one-hour option has its own key -- so their
 * singular is unreachable.
 *
 * Luganda ships the English source text, so it is held to English's categories
 * rather than to `Intl.PluralRules('lg')`, which no CLDR data backs.
 */
const COUNT_KEY = 'points';
function requiredPluralKeys(locale: string): string[] {
  const rules = new Intl.PluralRules(locale === 'lg' ? 'en' : locale);
  return rules.resolvedOptions().pluralCategories.map((category) => `${COUNT_KEY}_${category}`).sort();
}

// Luganda is human translation work product: where no reviewed Luganda exists,
// the honest shipped value is the English source text, never a machine
// translation. Every key above is in that state today (tracked in
// docs/i18n/pending-luganda-translations.md), and this assertion forces the doc
// and the shipped file to move together.
const PENDING_HUMAN_LUGANDA = new Set<string>([...KEYS, ...requiredPluralKeys('en')]);

// locale:key pairs where matching English is correct, not an untranslated leak.
// "Gateway" is the established loanword in these three -- settings.json
// `gatewayHub` and devices.json `systemPanel.title` already ship exactly
// "Gateway" for each of them. French translates it, and Spanish already uses
// "pasarela" in this same bundle (`noDevices`).
const REVIEWED_IDENTICAL = new Set<string>(['de-CH:gateway', 'it:gateway', 'pt:gateway']);

test('coverage keys exist in every shipped locale', () => {
  for (const locale of LOCALES) {
    const coverage = readCoverage(locale);
    for (const key of KEYS) {
      assert.equal(typeof coverage[key], 'string', `${locale} network.json missing coverage.${key}`);
      assert.ok(String(coverage[key]).trim().length > 0, `${locale} network.json coverage.${key} is blank`);
    }
  }
});

test('every plural category a locale can produce has a point-count form', () => {
  for (const locale of LOCALES) {
    const coverage = readCoverage(locale);
    for (const key of requiredPluralKeys(locale)) {
      assert.equal(
        typeof coverage[key],
        'string',
        `${locale} network.json missing coverage.${key}; i18next falls back to English for that category`,
      );
    }
    assert.equal(coverage[COUNT_KEY], undefined, `${locale} network.json still has the unpluralised coverage.${COUNT_KEY}`);
  }
});

test('coverage interpolation placeholders match English in every locale', () => {
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  const english = readCoverage('en');
  for (const locale of LOCALES) {
    const translated = readCoverage(locale);
    for (const key of KEYS) {
      assert.equal(
        placeholders(translated[key]),
        placeholders(english[key]),
        `${locale} network.json placeholder mismatch at coverage.${key}`,
      );
    }
    for (const key of requiredPluralKeys(locale)) {
      assert.equal(placeholders(translated[key]), '{{count}}', `${locale} network.json coverage.${key} lost its {{count}}`);
    }
  }
});

test('the five European locales translate every coverage key', () => {
  const english = readCoverage('en');
  for (const locale of EUROPEAN) {
    const translated = readCoverage(locale);
    const identical = KEYS.filter((key) => translated[key] === english[key]);
    assert.deepEqual(
      identical,
      identical.filter((key) => REVIEWED_IDENTICAL.has(`${locale}:${key}`)),
      `${locale} network.json has untranslated coverage values`,
    );
    for (const key of requiredPluralKeys('en')) {
      assert.notEqual(translated[key], english[key], `${locale} network.json coverage.${key} is untranslated`);
    }
  }
});

test('Luganda ships the English source text for the coverage keys until a human pass lands', () => {
  const english = readCoverage('en');
  const luganda = readCoverage('lg');
  for (const key of PENDING_HUMAN_LUGANDA) {
    assert.equal(
      luganda[key],
      english[key],
      `lg network.json coverage.${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`,
    );
  }
});

test('de-CH coverage copy avoids the eszett', () => {
  const german = readCoverage('de-CH');
  for (const key of [...KEYS, ...requiredPluralKeys('de-CH')]) {
    assert.ok(!String(german[key]).includes('ß'), `de-CH network.json coverage.${key} uses ß instead of Swiss spelling`);
  }
});

test('the first positioned point of a walk reads as a singular in every locale', async () => {
  for (const locale of LOCALES) {
    const instance = i18next.createInstance();
    await instance.init({
      lng: locale, fallbackLng: 'en', ns: ['network'], defaultNS: 'network',
      resources: { en: { network: readNetwork('en') }, [locale]: { network: readNetwork(locale) } },
      interpolation: { escapeValue: false },
    });
    const one = instance.t('network.coverage.points', { count: 1 });
    const many = instance.t('network.coverage.points', { count: 2 });
    assert.ok(one.startsWith('1 '), `${locale} renders ${JSON.stringify(one)} at count 1`);
    assert.notEqual(one.slice(1), many.slice(1), `${locale} uses one form for both counts: ${JSON.stringify(one)} / ${JSON.stringify(many)}`);
    // No category may leak English into a non-English bundle.
    if (locale !== 'en' && locale !== 'lg') {
      for (const count of [0, 1, 2, 7, 30, 500, 1000000]) {
        const rendered = instance.t('network.coverage.points', { count });
        assert.ok(!/positioned point/.test(rendered), `${locale} falls back to English at count ${count}: ${JSON.stringify(rendered)}`);
      }
    }
  }
});

// The Observations list's show-all/show-fewer toggle (2026-09 polish pass):
// these two keys live at the top of network.json, not under `coverage`, so
// they get their own small block rather than joining KEYS above.
const TOP_LEVEL_KEYS = ['showAllObservations', 'showFewerObservations'];
const PENDING_HUMAN_LUGANDA_TOP_LEVEL = new Set<string>(TOP_LEVEL_KEYS);

function readTopLevel(locale: string): Record<string, string> {
  return (readNetwork(locale).network ?? {}) as Record<string, string>;
}

test('the observations show-all/show-fewer toggle exists in every shipped locale', () => {
  for (const locale of LOCALES) {
    const network = readTopLevel(locale);
    for (const key of TOP_LEVEL_KEYS) {
      assert.equal(typeof network[key], 'string', `${locale} network.json missing network.${key}`);
      assert.ok(String(network[key]).trim().length > 0, `${locale} network.json network.${key} is blank`);
    }
  }
});

test('the five European locales translate the show-all/show-fewer toggle', () => {
  const english = readTopLevel('en');
  for (const locale of EUROPEAN) {
    const translated = readTopLevel(locale);
    for (const key of TOP_LEVEL_KEYS) {
      assert.notEqual(translated[key], english[key], `${locale} network.json network.${key} is untranslated`);
    }
  }
});

test('Luganda ships the English source text for the toggle until a human pass lands', () => {
  const english = readTopLevel('en');
  const luganda = readTopLevel('lg');
  for (const key of PENDING_HUMAN_LUGANDA_TOP_LEVEL) {
    assert.equal(
      luganda[key],
      english[key],
      `lg network.json network.${key} changed; drop it from PENDING_HUMAN_LUGANDA_TOP_LEVEL and from docs/i18n/pending-luganda-translations.md`,
    );
  }
});

test('French renders the walk count the way a francophone writes it', async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr', fallbackLng: 'en', ns: ['network'], defaultNS: 'network',
    resources: { en: { network: readNetwork('en') }, fr: { network: readNetwork('fr') } },
    interpolation: { escapeValue: false },
  });
  assert.equal(instance.t('network.coverage.points', { count: 1 }), '1 point géolocalisé');
  assert.equal(instance.t('network.coverage.points', { count: 2 }), '2 points géolocalisés');
  // French takes the singular for zero, which the `one` category already gives.
  assert.equal(instance.t('network.coverage.points', { count: 0 }), '0 point géolocalisé');
  assert.equal(instance.t('network.coverage.noPoints'), 'Aucune observation de cette période n’est géolocalisée.');
});
