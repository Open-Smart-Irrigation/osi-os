#!/usr/bin/env node
'use strict';
// Boot-survival guard: the frozen sync-init-fn boot function text must never
// name or drop the migration-owned scoped-access triggers (spec §5.1). This
// is a static text guard, not a runtime rehearsal: it is stronger because it
// cannot false-pass on a shim/facade DB that happens not to exercise the path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_TRIGGERS = [
  'trg_dp_user_zone_assign_outbox_ai', 'trg_dp_user_zone_assign_outbox_au',
  'trg_dp_user_plot_assign_outbox_ai', 'trg_dp_user_plot_assign_outbox_au',
  'trg_dp_users_outbox_uuid_au', 'trg_dp_users_outbox_ai', 'trg_dp_users_outbox_role_au',
];

function extractBootFunc() {
  const flows = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
  const node = flows.find(n => n.id === 'sync-init-fn');
  if (!node) throw new Error('sync-init-fn not found');
  return node.func;
}

test('sync-init-fn text never references the migration-owned scoped triggers', () => {
  const func = extractBootFunc();
  for (const t of EXPECTED_TRIGGERS) {
    assert.ok(!func.includes(t), `boot node references ${t} — it must stay migration-owned`);
  }
});

test('sync-init-fn text has no DROP TRIGGER wildcard sweep beyond its own 30', () => {
  const func = extractBootFunc();
  const drops = new Set([...func.matchAll(/DROP TRIGGER IF EXISTS\s+([A-Za-z0-9_]+)/gi)].map(m => m[1]));
  for (const t of EXPECTED_TRIGGERS) assert.ok(!drops.has(t), `boot node drops ${t}`);
  // Pin: 30 distinct drops inside sync-init-fn (verified 2026-07-19; a 31st
  // drop in dendro-compute-fn is unrelated to the boot node).
  assert.equal(drops.size, 30, `expected the frozen 30 drop list, found ${drops.size}: ${[...drops].join(',')}`);
});
