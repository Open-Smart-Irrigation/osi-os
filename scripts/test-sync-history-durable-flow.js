#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const canonicalText = fs.readFileSync(canonicalPath, 'utf8');
assert.strictEqual(canonicalText, fs.readFileSync(mirrorPath, 'utf8'));
const flows = JSON.parse(canonicalText);

function node(id) {
  const value = flows.find((candidate) => candidate.id === id);
  assert.ok(value, `missing flow node ${id}`);
  return value;
}

function includes(source, fragment, label) {
  assert.ok(source.includes(fragment), `${label}: missing ${fragment}`);
}

function excludes(source, fragment, label) {
  assert.ok(!source.includes(fragment), `${label}: forbidden ${fragment}`);
}

const build = node('sync-history-build').func;
for (const fragment of [
  'helper.tableNames()',
  'helper.nextTable(',
  'helper.snapshotHighQuery(',
  'helper.batchQuery(',
  'helper.prepareRow(',
  'sync_history_dirty_keys',
  "state === 'shadow'",
  "phase: phase",
  'snapshot_high_key',
  'last_shadow_acked_key'
]) {
  includes(build, fragment, 'Build History Batch');
}
excludes(build, "const tableName = 'device_data'", 'Build History Batch');

const mark = node('sync-history-mark').func;
for (const fragment of [
  'helper.serverConfirmsDurable',
  'helper.shouldApplyDurableAck',
  'shadow_completed_at',
  'durable_enabled_at',
  'backfill_completed_at',
  "status='done'",
  'helper.segmentQuery(',
  'helper.buildSegment(',
  'sync_history_segments',
  'tombstone_count'
]) {
  includes(mark, fragment, 'Mark History Batch ACK');
}
includes(mark, 'last_shadow_acked_id', 'Mark History Batch ACK');
includes(mark, 'last_acked_id', 'Mark History Batch ACK');

const manifestBuild = node('sync-history-manifest-build').func;
includes(manifestBuild, 'tombstone_count', 'Build History Manifest');
includes(manifestBuild, 'tombstoneCount', 'Build History Manifest');

const manifestMarkNode = node('sync-history-manifest-mark');
const manifestMark = manifestMarkNode.func;
assert.ok((manifestMarkNode.libs || []).some(
  (lib) => lib.var === 'osiDb' && lib.module === 'osi-db-helper'
));
assert.ok((manifestMarkNode.libs || []).some(
  (lib) => lib.var === 'osiLib' && lib.module === 'osi-lib'
));
for (const fragment of [
  'repairRequested',
  'helper.segmentQuery(',
  'sync_history_dirty_keys',
  "change_kind='repair'"
]) {
  includes(manifestMark, fragment, 'Mark History Manifest ACK');
}
excludes(manifestMark.toUpperCase(), 'DELETE FROM', 'Mark History Manifest ACK');

const seed = fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8');
for (const legacyTrigger of [
  'trg_dp_device_data_outbox_ai',
  'trg_dp_chameleon_readings_outbox_ai',
  'trg_dp_dendro_readings_outbox_ai',
  'trg_dp_irrigation_events_outbox_ai'
]) {
  includes(seed, legacyTrigger, 'legacy durable history path');
}

console.log('OK durable history flow contract');
