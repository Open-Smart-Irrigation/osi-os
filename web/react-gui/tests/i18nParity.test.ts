import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');
const LOCALES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
const NAMESPACES = ['accountLink', 'auth', 'common', 'dashboard', 'devices', 'history', 'journal', 'settings', 'support'];

function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

function load(locale: string, ns: string): Record<string, string> {
  return flatten(JSON.parse(readFileSync(path.join(LOCALES_DIR, locale, `${ns}.json`), 'utf8')));
}

function placeholders(s: string): string {
  return (s.match(/\{\{[^}]+\}\}/g) ?? []).sort().join(',');
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

// Hardcoded source of truth; an agreement test below keeps it honest vs Intl.
const EXPECTED_PLURAL_CATEGORIES: Record<string, string[]> = {
  en: ['one', 'other'], 'de-CH': ['one', 'other'], fr: ['one', 'other'],
  it: ['one', 'other'], es: ['one', 'other'], pt: ['one', 'other'],
  lg: ['one', 'other'],
};

// Categories Intl.PluralRules recognizes for a locale that this app deliberately
// does not author content for. CLDR gives French/Italian/Spanish/Portuguese a
// cardinal 'many' category that triggers only for round multiples of a million
// (Intl.PluralRules('fr').select(1_000_000) === 'many'); no count in this UI
// (plots, sensors, devices, journal entries, …) can ever reach that magnitude,
// and i18next silently falls back to the '_other' form when a resolved category
// has no matching key — so a '_many' key here would be dead content nobody could
// exercise or review. Every gap between what we claim (EXPECTED_PLURAL_CATEGORIES)
// and what Intl recognizes must be named here explicitly (see the agreement test
// below): a future CLDR/ICU change that adds or drops a category still fails
// loudly instead of being silently swallowed by a lax "subset of Intl" check.
const OMITTED_PLURAL_CATEGORIES: Record<string, string[]> = {
  en: [], 'de-CH': [], fr: ['many'], it: ['many'], es: ['many'], pt: ['many'],
  lg: [],
};

function splitKeys(keys: string[], pluralBases: Set<string>) {
  const plain = new Set<string>();
  const forms = new Map<string, Set<string>>(); // base -> suffixes present
  for (const key of keys) {
    const m = key.match(PLURAL_SUFFIX);
    const base = m ? key.slice(0, -m[0].length) : key;
    if (m && pluralBases.has(base)) {
      if (!forms.has(base)) forms.set(base, new Set());
      forms.get(base)!.add(m[1]);
    } else {
      plain.add(key);
    }
  }
  return { plain, forms };
}

function pluralBasesFor(ns: string): Set<string> {
  // A base only counts as a plural group if at least two distinct CLDR-category
  // suffixes are attested for it somewhere in the locale set. This excludes
  // coincidental single-suffix collisions such as settings.json's "area_other"
  // (an enum sibling of area_dashboard/area_history/…, not a plural form) while
  // still recognizing genuine plural bases, since en always contributes at
  // least 'one' + 'other' for those.
  const suffixesByBase = new Map<string, Set<string>>();
  for (const locale of LOCALES) {
    for (const key of Object.keys(load(locale, ns))) {
      const m = key.match(PLURAL_SUFFIX);
      if (!m) continue;
      const base = key.slice(0, -m[0].length);
      if (!suffixesByBase.has(base)) suffixesByBase.set(base, new Set());
      suffixesByBase.get(base)!.add(m[1]);
    }
  }
  const bases = new Set<string>();
  for (const [base, suffixes] of suffixesByBase) {
    if (suffixes.size >= 2) bases.add(base);
  }
  return bases;
}

for (const ns of NAMESPACES) {
  test(`locale key sets match en for namespace ${ns} (plural-group aware)`, () => {
    const pluralBases = pluralBasesFor(ns);
    const en = splitKeys(Object.keys(load('en', ns)), pluralBases);
    for (const locale of LOCALES.slice(1)) {
      const loc = splitKeys(Object.keys(load(locale, ns)), pluralBases);
      assert.deepEqual([...loc.plain].sort(), [...en.plain].sort(),
        `${locale}/${ns}.json plain key set differs from en`);
      assert.deepEqual([...loc.forms.keys()].sort(), [...en.forms.keys()].sort(),
        `${locale}/${ns}.json plural-group set differs from en`);
      for (const [base, suffixes] of loc.forms) {
        assert.deepEqual([...suffixes].sort(), [...EXPECTED_PLURAL_CATEGORIES[locale]].sort(),
          `${locale}/${ns}.json "${base}" must carry exactly the CLDR forms for ${locale}`);
      }
    }
    for (const [base, suffixes] of en.forms) {
      assert.deepEqual([...suffixes].sort(), [...EXPECTED_PLURAL_CATEGORIES.en].sort(),
        `en/${ns}.json "${base}" must carry exactly the CLDR forms for en`);
    }
  });

  test(`placeholder tokens match en for namespace ${ns} (plural-group aware)`, () => {
    const pluralBases = pluralBasesFor(ns);
    const en = load('en', ns);
    for (const locale of LOCALES.slice(1)) {
      const translated = load(locale, ns);
      const { plain, forms } = splitKeys(Object.keys(translated), pluralBases);
      for (const key of plain) {
        assert.equal(
          placeholders(translated[key]), placeholders(en[key] ?? ''),
          `${locale}/${ns}.json "${key}" placeholder mismatch`,
        );
      }
      for (const [base, suffixes] of forms) {
        const enOther = en[`${base}_other`] ?? '';
        for (const suffix of suffixes) {
          const key = `${base}_${suffix}`;
          assert.equal(
            placeholders(translated[key]), placeholders(enOther),
            `${locale}/${ns}.json "${key}" placeholder mismatch (vs en "${base}_other")`,
          );
        }
      }
    }
  });
}

test('EXPECTED_PLURAL_CATEGORIES agrees with Intl.PluralRules', () => {
  for (const locale of LOCALES) {
    const intl = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
    const expected = EXPECTED_PLURAL_CATEGORIES[locale];

    // Every category we claim to support must be one Intl actually recognizes —
    // an invented category here would mean a suffix nothing can ever select.
    for (const category of expected) {
      assert.ok(intl.has(category),
        `${locale}: EXPECTED_PLURAL_CATEGORIES claims "${category}" but Intl.PluralRules does not recognize it for this locale`);
    }

    // Every Intl category we do NOT claim must be explicitly named as omitted —
    // this is what keeps the "we don't need it" call honest and re-checked
    // against every CLDR/ICU upgrade, instead of quietly accepted forever.
    const unclaimed = [...intl].filter((c) => !expected.includes(c)).sort();
    assert.deepEqual(unclaimed, [...OMITTED_PLURAL_CATEGORIES[locale]].sort(),
      `${locale}: Intl-recognized-but-unclaimed categories changed vs OMITTED_PLURAL_CATEGORIES — investigate before updating either map`);
  }
});

test('de-CH never uses ß (Swiss convention)', () => {
  for (const ns of NAMESPACES) {
    for (const [key, value] of Object.entries(load('de-CH', ns))) {
      assert.ok(!value.includes('ß'), `de-CH/${ns}.json "${key}" contains ß`);
    }
  }
});

test('no ASCII three-dot ellipsis or -> arrow in any locale', () => {
  for (const locale of LOCALES) {
    for (const ns of NAMESPACES) {
      for (const [key, value] of Object.entries(load(locale, ns))) {
        assert.ok(!value.includes('...'), `${locale}/${ns}.json "${key}" uses ... instead of …`);
        assert.ok(!value.includes('->'), `${locale}/${ns}.json "${key}" uses -> instead of →`);
      }
    }
  }
});
