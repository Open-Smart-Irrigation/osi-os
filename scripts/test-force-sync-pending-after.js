'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const flowPath = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const forceSync = flows.find((node) => node.id === 'sync-force-build');
assert.ok(forceSync && typeof forceSync.func === 'string', 'missing Run Force Sync function');
const source = forceSync.func;

function outboxSection() {
  const start = source.indexOf('  const refreshOutboxPendingAfter = async () => {');
  const end = source.indexOf('\n  if (!migrationPaused) {', start);
  assert.ok(start >= 0 && end > start, 'could not isolate Force Sync outbox section');
  return source.slice(start, end);
}

test('backoff-only outbox completion refreshes pendingAfter from a fresh pending query', () => {
  const section = outboxSection();
  assert.match(section, /const refreshOutboxPendingAfter = async \(\) =>/);
  assert.match(section, /else \{[\s\S]*await refreshOutboxPendingAfter\(\)/);
  assert.doesNotMatch(section, /summary\.outbox\.pendingAfter = summary\.outbox\.beforeCount/);
});

test('HTTP failure outbox completion refreshes pendingAfter from a fresh pending query', () => {
  const section = outboxSection();
  assert.match(section, /finally \{[\s\S]*await refreshOutboxPendingAfter\(\)/);
  assert.doesNotMatch(section, /summary\.outbox\.pendingAfter = summary\.outbox\.beforeCount/);
});

test('fresh pending count updates both pendingAfter and afterCount', () => {
  const section = outboxSection();
  assert.match(section, /SELECT COUNT\(\*\) AS pending_count FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL/);
  assert.match(section, /summary\.outbox\.afterCount = summary\.outbox\.pendingAfter/);
});
