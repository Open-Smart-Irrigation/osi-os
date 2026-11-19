import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const localesRoot = join(import.meta.dirname, '..', 'public', 'locales');

// Remove a key here and from the B4 ledger section when a human pass lands.
const PENDING_HUMAN_LUGANDA = [
  'analysis.preset.metricLabel',
  'analysis.preset.more',
  'analysis.export.label',
] as const;

test('B4 Analysis labels retain English fallbacks until a human Luganda pass', () => {
  const english: unknown = JSON.parse(readFileSync(join(localesRoot, 'en', 'common.json'), 'utf8'));
  const luganda: unknown = JSON.parse(readFileSync(join(localesRoot, 'lg', 'common.json'), 'utf8'));
  const pick = (tree: unknown, key: string): unknown => key.split('.').reduce<unknown>(
    (node, part) => node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    tree,
  );
  const ledger = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'i18n', 'pending-luganda-translations.md'), 'utf8');
  const section = ledger.split('## UI FIX-LIST B4 (Analysis)\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'The pending ledger must contain the B4 Analysis section');
  for (const key of PENDING_HUMAN_LUGANDA) {
    assert.equal(typeof pick(english, key), 'string', `${key} is missing in English`);
    assert.equal(pick(luganda, key), pick(english, key), `${key}: remove the pending key and ledger row only after a human Luganda pass`);
    assert.ok(section.includes(`\`${key}\``), `${key} is missing from the B4 ledger section`);
  }
});
