'use strict';

// Executable dispatch contract. The stateful binding/rollback matrix lives in
// osi-command-ledger and osi-watermark-helper tests; this test proves the
// production flow reaches that transaction boundary before generic routing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const flowPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const byName = Object.fromEntries(flows.filter((node) => node.name).map((node) => [node.name, node]));
const helper = byName['Apply WATERMARK Protected Command'];
const dedupe = byName['Deduplicate Pending Command'];
const ack = byName['Queue REST Command ACK'];
assert.ok(helper, 'protected helper node exists');
assert.ok(dedupe, 'real dedupe node exists');
assert.ok(ack, 'durable ACK queue exists');

assert.match(dedupe.func, /deduplicatePendingCommand/);
assert.match(dedupe.func, /_pendingCommandEnvelope/);
assert.match(dedupe.func, /gateway_device_eui/);
assert.match(helper.func, /withProtectedCommandTransaction|applyWatermarkCommand/);
assert.match(helper.func, /command_type_recognized/);
assert.match(helper.func, /protected_context/);
assert.match(helper.func, /finally/);
assert.match(ack.func, /queueCommandAck/);

// The generic replay node must stay upstream of the semantic helper's pass
// through, while the helper's ACK output is durable rather than downlink-only.
assert.deepEqual(helper.wires, [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']]);
assert.doesNotMatch(helper.func, /UPDATE devices SET soil_moisture_probe_depths_json/);
assert.doesNotMatch(helper.func, /INSERT OR REPLACE INTO watermark_readings/);

// The flow-wiring assertions above prove the production order.  Run the real
// SQLite-backed helper/ledger matrix as part of this gate too: it covers the
// semantic-before-replay mismatch cases, legacy rows without trusted binding,
// and rollback between local mutation and terminal ACK/outbox persistence.
const helperTests = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.test.js'
);
const helperRun = spawnSync(process.execPath, ['--test', helperTests], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
});
assert.equal(helperRun.status, 0, helperRun.stderr || helperRun.stdout);
assert.match(helperRun.stdout, /# pass \d+/);
const ledgerTests = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js'
);
const ledgerRun = spawnSync(process.execPath, ['--test', ledgerTests], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
});
assert.equal(ledgerRun.status, 0, ledgerRun.stderr || ledgerRun.stdout);
assert.match(ledgerRun.stdout, /# pass \d+/);

console.log('protected configuration dispatch checks passed');
