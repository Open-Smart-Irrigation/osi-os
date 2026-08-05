import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pagePath = path.resolve(import.meta.dirname, '../src/pages/FarmingDashboard.tsx');

test('the farming dashboard renders its empty state through ui-core', () => {
  const source = fs.readFileSync(pagePath, 'utf8');
  assert.match(source, /from '\.\.\/ui-core'/);
  assert.ok(source.includes('<EmptyState'), 'EmptyState primitive not used');
  assert.ok(
    !source.includes('text-center py-12 bg-[var(--surface)] rounded-xl'),
    'hand-rolled empty-state markup still present',
  );
});
