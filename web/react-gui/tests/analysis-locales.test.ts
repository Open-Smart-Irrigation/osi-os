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
    assert.deepEqual(keyPaths(common.analysis).sort(), expected, `${language} analysis keys drifted from en`);
  }
});
