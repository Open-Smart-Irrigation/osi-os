import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// F59 (overnight 2026-09-17) was reported as a namespace/bundle resolution
// defect: French pages rendering English for keys that exist in the French
// bundle. It was not — Leaflet's own control defaults were the source (see
// src/pages/__tests__/NetworkPageZoomI18n.test.tsx). But the hypothesis was
// only cheap to disprove because nothing pinned the relationship between the
// namespaces components ask for and the namespaces i18next is told to load.
// A namespace used by a component but absent from `ns` in src/i18n/config.ts,
// or missing a JSON file in one locale, produces exactly the symptom that was
// reported: silent English on that locale only. These tests close that hole.

const guiRoot = process.cwd();
const srcRoot = path.join(guiRoot, 'src');
const localeRoot = path.join(guiRoot, 'public/locales');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Namespaces i18next is initialised with, read from the single init site. */
function declaredNamespaces(): string[] {
  const config = fs.readFileSync(path.join(srcRoot, 'i18n/config.ts'), 'utf8');
  const list = config.match(/\n\s*ns:\s*\[([^\]]+)\]/);
  assert.ok(list, 'src/i18n/config.ts no longer declares an ns: [...] array');
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Namespaces components actually ask for, with the files that ask. */
function requestedNamespaces(): Map<string, Set<string>> {
  const requested = new Map<string, Set<string>>();
  const record = (ns: string, file: string) => {
    const files = requested.get(ns) ?? new Set<string>();
    files.add(path.relative(guiRoot, file));
    requested.set(ns, files);
  };
  for (const file of sourceFiles(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/useTranslation\(\s*'([^']+)'/g)) record(m[1], file);
    for (const m of text.matchAll(/useTranslation\(\s*\[([^\]]+)\]/g)) {
      for (const q of m[1].matchAll(/'([^']+)'/g)) record(q[1], file);
    }
    // `t('settings:foo')` reaches across namespaces explicitly and needs the
    // same guarantee as useTranslation('settings').
    for (const m of text.matchAll(/\bt\(\s*'([A-Za-z][A-Za-z0-9]*):[^']*'/g)) record(m[1], file);
  }
  return requested;
}

test('every namespace a component asks for is declared in the i18n init', () => {
  const declared = new Set(declaredNamespaces());
  const undeclared: string[] = [];
  for (const [ns, files] of requestedNamespaces()) {
    if (!declared.has(ns)) undeclared.push(`${ns} (used by ${[...files].sort().join(', ')})`);
  }
  assert.deepEqual(
    undeclared,
    [],
    'namespaces used in src/ but missing from ns: [...] in src/i18n/config.ts — '
      + 'i18next never loads them, so every key falls back to its defaultValue or the raw key',
  );
});

test('every declared namespace ships a bundle in all seven locales', () => {
  const missing: string[] = [];
  for (const ns of new Set([...declaredNamespaces(), ...requestedNamespaces().keys()])) {
    for (const locale of LOCALES) {
      const bundle = path.join(localeRoot, locale, `${ns}.json`);
      if (!fs.existsSync(bundle)) missing.push(`${locale}/${ns}.json`);
    }
  }
  assert.deepEqual(missing, [], 'locale bundles missing for a declared namespace');
});

test('every locale bundle keeps the same root shape as English', () => {
  // Namespaces disagree on wrapping by design: `history.json` and
  // `network.json` nest everything under a top-level object named after the
  // namespace (so call sites read `t('history.cardType.gateway')` inside ns
  // 'history'), while `devices.json` and the rest are flat. Whichever shape a
  // namespace uses, all seven locales must use the same one and carry the same
  // root sections — a bundle that wraps (or drops a section) on one locale
  // only resolves nothing there and falls back to English, which is precisely
  // the symptom F59 was reported as.
  const problems: string[] = [];
  for (const file of fs.readdirSync(path.join(localeRoot, 'en'))) {
    if (!file.endsWith('.json')) continue;
    const roots = (locale: string) => {
      const raw = fs.readFileSync(path.join(localeRoot, locale, file), 'utf8');
      return Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
    };
    const english = roots('en');
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      const theirs = roots(locale);
      if (theirs.join('|') !== english.join('|')) {
        problems.push(`${locale}/${file} root sections [${theirs.join(', ')}] differ from en [${english.join(', ')}]`);
      }
    }
  }
  assert.deepEqual(problems, [], 'locale bundles disagree with English on their root shape');
});
