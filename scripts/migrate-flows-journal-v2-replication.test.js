#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PROFILE_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const migrator = require('./migrate-flows-journal-v2-replication');

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function migrated(relativePath) {
  const original = source(relativePath);
  const parsed = JSON.parse(original.toString('utf8'));
  assert.equal(
    serialize(parsed).equals(original),
    true,
    relativePath + ' must have an exact byte-identical no-op JSON roundtrip',
  );
  return migrator.migrate(original);
}

function nodesById(buffer) {
  return new Map(JSON.parse(buffer.toString('utf8')).map((node) => [node.id, node]));
}

test('both maintained profiles roundtrip exactly and migrate byte-identically', () => {
  const outputs = PROFILE_PATHS.map(migrated);
  assert.equal(outputs[0].equals(outputs[1]), true);
  assert.equal(migrator.migrate(outputs[0]).equals(outputs[0]), true, 'migration is idempotent');
});

test('the shipped flows are exactly the guarded migration output from the node-free baseline', () => {
  const current = source(PROFILE_PATHS[0]);
  const ownedIds = new Set(migrator.EXPECTED_NODES.map((node) => node.id));
  const withoutWorker = JSON.parse(current.toString('utf8')).filter(
    (node) => !ownedIds.has(node.id),
  );
  assert.equal(migrator.migrate(serialize(withoutWorker)).equals(current), true);
});

test('migration adds one isolated Journal V2 worker cluster', () => {
  const nodes = nodesById(migrated(PROFILE_PATHS[0]));
  const tick = nodes.get('journal-v2-replication-tick');
  const worker = nodes.get('journal-v2-replication-worker');
  const success = nodes.get('journal-v2-replication-success-status');
  const errorCatch = nodes.get('journal-v2-replication-error-catch');
  const errorStatus = nodes.get('journal-v2-replication-error-status');

  assert.ok(tick);
  assert.equal(tick.type, 'inject');
  assert.equal(tick.name, 'Journal V2 replication tick');
  assert.equal(tick.repeat, '30');
  assert.deepEqual(tick.wires, [['journal-v2-replication-worker']]);

  assert.ok(worker);
  assert.equal(worker.type, 'function');
  assert.deepEqual(worker.wires, [['journal-v2-replication-success-status']]);
  assert.deepEqual(worker.libs, [
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiCloudHttp', module: 'osi-cloud-http' },
  ]);
  assert.match(worker.func, /osiLib\.require\('journal-replication'\)/);
  assert.match(worker.func, /new osiDb\.Database/);
  assert.match(worker.func, /osiCloudHttp\.requestJsonIpv4/);
  assert.match(worker.func, /osi-identity-restart\.json/);
  assert.match(worker.func, /fs\.readFileSync/);
  assert.match(worker.func, /finally/);
  assert.match(worker.func, /\.close\s*\(/);
  assert.doesNotMatch(worker.func, /pending-commands|mqtt|heartbeat|sync-init-fn/i);

  assert.ok(success);
  assert.deepEqual(success.wires, [[]]);
  assert.ok(errorCatch);
  assert.deepEqual(errorCatch.scope, ['journal-v2-replication-worker']);
  assert.deepEqual(errorCatch.wires, [['journal-v2-replication-error-status']]);
  assert.ok(errorStatus);
  assert.match(errorStatus.func, /node\.warn/);

  const forbidden = new Set(['sync-init-fn', '062a0f9bf66d9789']);
  for (const node of [tick, worker, success, errorCatch, errorStatus]) {
    const targets = (node.wires || []).flat();
    assert.equal(targets.some((target) => forbidden.has(target)), false, node.id);
  }
});

test('migration rejects collisions instead of overwriting a drifted worker', () => {
  const first = migrated(PROFILE_PATHS[0]);
  const flows = JSON.parse(first.toString('utf8'));
  flows.find((node) => node.id === 'journal-v2-replication-worker').func += '\n// drift';
  assert.throws(
    () => migrator.migrate(serialize(flows)),
    /Refusing non-exact Journal V2 replication node collision/,
  );
});
