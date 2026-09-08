#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_TRIGGERS = [
  'trg_dp_user_zone_assign_outbox_ai',
  'trg_dp_user_zone_assign_outbox_au',
  'trg_dp_user_plot_assign_outbox_ai',
  'trg_dp_user_plot_assign_outbox_au',
  'trg_dp_users_outbox_uuid_au',
  'trg_dp_users_outbox_ai',
  'trg_dp_users_outbox_role_au',
];

function bootFunction() {
  const flows = JSON.parse(fs.readFileSync(
    path.join(
      ROOT,
      'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
    ),
    'utf8'
  ));
  const node = flows.find((entry) => entry.id === 'sync-init-fn');
  assert.ok(node, 'sync-init-fn not found');
  return node.func;
}

test('sync-init-fn never references migration-owned scoped triggers', () => {
  const source = bootFunction();
  for (const trigger of EXPECTED_TRIGGERS) {
    assert.ok(!source.includes(trigger), `boot node references ${trigger}`);
  }
});

test('sync-init-fn retains its frozen 30-trigger drop set', () => {
  const source = bootFunction();
  const drops = new Set(
    [...source.matchAll(/DROP TRIGGER IF EXISTS\s+([A-Za-z0-9_]+)/gi)]
      .map((match) => match[1])
  );
  for (const trigger of EXPECTED_TRIGGERS) {
    assert.ok(!drops.has(trigger), `boot node drops ${trigger}`);
  }
  assert.equal(
    drops.size,
    30,
    `expected frozen 30-trigger drop set, found ${drops.size}: ${[...drops].join(',')}`
  );
});
