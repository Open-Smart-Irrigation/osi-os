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

for (const ns of NAMESPACES) {
  test(`locale key sets match en for namespace ${ns}`, () => {
    const en = load('en', ns);
    const enKeys = Object.keys(en).sort();
    for (const locale of LOCALES.slice(1)) {
      const keys = Object.keys(load(locale, ns)).sort();
      assert.deepEqual(keys, enKeys, `${locale}/${ns}.json key set differs from en`);
    }
  });

  test(`placeholder tokens match en for namespace ${ns}`, () => {
    const en = load('en', ns);
    for (const locale of LOCALES.slice(1)) {
      const translated = load(locale, ns);
      for (const [key, value] of Object.entries(translated)) {
        assert.equal(
          placeholders(value), placeholders(en[key] ?? ''),
          `${locale}/${ns}.json "${key}" placeholder mismatch`,
        );
      }
    }
  });
}

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
