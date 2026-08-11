import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// Maintainer decision 4 (S6): ReadOnlyNotice (components/ReadOnlyNotice.tsx)
// consumes common:readOnly.farm and common:readOnly.section. common.json has
// no full key-equality test on the edge today (tests/analysis-locales.test.ts
// covers only the `analysis` subtree), so this task adds coverage for the
// keys it writes rather than relying on an existing guard to catch drift.
const localesRoot = join(import.meta.dirname, '..', 'public', 'locales');

function languages(): string[] {
  return readdirSync(localesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readCommon(language: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesRoot, language, 'common.json'), 'utf8'));
}

test('the edge ships exactly the seven locales this task must cover', () => {
  assert.deepEqual(languages(), ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt']);
});

test('common:readOnly.farm is present and non-empty in all seven locales', () => {
  for (const language of languages()) {
    const common = readCommon(language);
    const readOnly = common.readOnly as { farm?: unknown } | undefined;
    assert.ok(readOnly, `${language}/common.json must contain a readOnly key`);
    assert.equal(typeof readOnly?.farm, 'string', `${language}/common.json must translate readOnly.farm`);
    assert.ok((readOnly?.farm as string).trim().length > 0, `${language} readOnly.farm must not be empty`);
  }
});

test('common:readOnly.section is present and non-empty in all seven locales', () => {
  for (const language of languages()) {
    const common = readCommon(language);
    const readOnly = common.readOnly as { section?: unknown } | undefined;
    assert.ok(readOnly, `${language}/common.json must contain a readOnly key`);
    assert.equal(typeof readOnly?.section, 'string', `${language}/common.json must translate readOnly.section`);
    assert.ok((readOnly?.section as string).trim().length > 0, `${language} readOnly.section must not be empty`);
  }
});
