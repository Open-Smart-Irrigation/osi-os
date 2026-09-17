import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// F35 (overnight 2026-09-17): WaterTab.tsx called t() for ten
// `environment.water.*` keys that existed in no locale file at all. Every
// call carried a `defaultValue`, so the tab rendered fluent English in all
// seven languages and no key-parity check noticed: those checks compare
// locale files against each other, and a key absent from *every* file is
// perfectly consistent.
//
// This is the generic hole. A t() call with a defaultValue is a promise that
// the key exists; when it does not, the defaultValue silently becomes the
// shipped string in every language. This test holds every such call to that
// promise, with a shrinking inventory of the gaps that predate it.

const guiRoot = process.cwd();
const srcRoot = path.join(guiRoot, 'src');
const localeRoot = path.join(guiRoot, 'public/locales');

// Pre-existing gaps of the same shape found when this check was introduced,
// outside the F35 fix's scope. Each entry is a t(key, { defaultValue }) call
// whose key is in no locale file; the component renders English everywhere.
// Removing an entry requires adding the key to all seven bundles. Entries may
// only be deleted, never added: a new one means a new untranslatable string.
// Empty, and it may only ever stay that way: PR #269 opened this inventory with
// fifteen keys — four environment tab labels, the Soil tab's temperature label
// and the ten soil-moisture depth-editor strings — and the edge polish round
// that followed added all fifteen to the seven bundles.
const KNOWN_MISSING_KEYS = new Set<string>([]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const englishBundles = new Map<string, Record<string, unknown>>();
for (const file of fs.readdirSync(path.join(localeRoot, 'en'))) {
  if (!file.endsWith('.json')) continue;
  englishBundles.set(
    file.replace(/\.json$/, ''),
    JSON.parse(fs.readFileSync(path.join(localeRoot, 'en', file), 'utf8')),
  );
}

function lookup(namespace: string, keyPath: string): unknown {
  const bundle = englishBundles.get(namespace);
  if (!bundle) return undefined;
  return keyPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, bundle);
}

/** Namespaces a file's t() resolves against, in i18next's own order. */
function namespacesFor(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/useTranslation\(\s*'([^']+)'/g)) found.push(m[1]);
  for (const m of text.matchAll(/useTranslation\(\s*\[([^\]]+)\]/g)) {
    for (const q of m[1].matchAll(/'([^']+)'/g)) found.push(q[1]);
  }
  // A bare useTranslation() resolves against defaultNS; fallbackNS is 'common'
  // for every call site (src/i18n/config.ts).
  found.push('common');
  return [...new Set(found)];
}

/** Every `t('literal', { ... defaultValue ... })` call in one file. */
function defaultedKeys(text: string): string[] {
  const keys: string[] = [];
  for (const call of text.matchAll(/\bt\(\s*(['"`])([^'"`]*)\1\s*,\s*\{/g)) {
    const key = call[2];
    // A template literal with an interpolation builds its key at runtime and
    // cannot be resolved statically.
    if (call[1] === '`' && key.includes('${')) continue;
    const braceStart = call.index + call[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    if (!/\bdefaultValue\b/.test(text.slice(braceStart, end + 1))) continue;
    keys.push(key);
  }
  return keys;
}

function missingDefaultedKeys(): Map<string, string[]> {
  const missing = new Map<string, string[]>();
  for (const file of sourceFiles(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    const namespaces = namespacesFor(text);
    for (const key of defaultedKeys(text)) {
      // `t('settings:foo.bar')` names its namespace inline.
      const prefixed = key.match(/^([A-Za-z][A-Za-z0-9]*):(.+)$/);
      const candidates = prefixed ? [prefixed[1]] : namespaces;
      const keyPath = prefixed ? prefixed[2] : key;
      if (candidates.some((ns) => typeof lookup(ns, keyPath) === 'string')) continue;
      const id = `${candidates[0]}:${keyPath}`;
      const rel = path.relative(guiRoot, file);
      const seen = missing.get(id) ?? [];
      if (!seen.includes(rel)) seen.push(rel);
      missing.set(id, seen);
    }
  }
  return missing;
}

test('no t() call relies on a defaultValue for a key English does not have', () => {
  const unlisted: string[] = [];
  for (const [id, files] of missingDefaultedKeys()) {
    if (KNOWN_MISSING_KEYS.has(id)) continue;
    unlisted.push(`${id} (${files.join(', ')})`);
  }
  assert.deepEqual(
    unlisted,
    [],
    'these t() keys exist in no locale file, so their defaultValue ships as the '
      + 'string in all seven languages — add the key to public/locales/*/ instead',
  );
});

test('the known-gap inventory has no stale entries', () => {
  const stillMissing = new Set(missingDefaultedKeys().keys());
  const fixed = [...KNOWN_MISSING_KEYS].filter((id) => !stillMissing.has(id));
  assert.deepEqual(
    fixed,
    [],
    'these keys now exist (or their call site changed) — drop them from '
      + 'KNOWN_MISSING_KEYS so the inventory only ever shrinks',
  );
});
