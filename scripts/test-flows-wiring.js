#!/usr/bin/env node
// Combined flow-wiring regression guard.
// Asserts:
//   * STREGA actuation wiring (WS1 — C5/H2/L1/M8)
//   * osiDb.Database handles are always closed (WS2/WS3 osidb audit)
//   * Misc wiring invariants added during the WS2/WS3 review cycle
//     (gateway migration helpers, sync-force timeout, ACK flush gate,
//     S2120 zone_ids validation)
const fs = require('fs');
const path = require('path');

const flowsPath = path.resolve(
    __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const byId = Object.fromEntries(flows.filter((n) => n.id).map((n) => [n.id, n]));

let failures = [];

function assertWires(nodeId, expectedWires, label) {
    const node = byId[nodeId];
    if (!node) {
        failures.push(`${label}: node ${nodeId} not found`);
        return;
    }
    const actual = JSON.stringify(node.wires);
    const expected = JSON.stringify(expectedWires);
    if (actual !== expected) {
        failures.push(`${label}: expected wires ${expected}, got ${actual}`);
        return;
    }
    console.log(`OK  ${label}`);
}

// === WS1 STREGA wiring (C5 / H2 / L1 / M8) ===

// C5: from scheduler/manual must wire to write-strega-expectation (not directly to Build STREGA downlink)
assertWires('5974306566e99a92',
    [['072f29aa8760340a', 'write-strega-expectation']],
    'C5: from-scheduler/manual → write-strega-expectation');

// C5: write-strega-expectation must wire directly to Build STREGA downlink
assertWires('write-strega-expectation',
    [['cdbaa3891d40d7a1']],
    'C5: write-strega-expectation → Build STREGA downlink');

// H2: reconciliation monitor must handle OBSERVED_RUNNING stale timeout
const reconcNode = byId['strega-reconciliation-monitor'];
if (!reconcNode) {
    failures.push('H2: strega-reconciliation-monitor not found');
} else if (!reconcNode.func.includes('STALE_OPEN_OBSERVED')) {
    failures.push('H2: strega-reconciliation-monitor missing STALE_OPEN_OBSERVED transition');
} else {
    console.log('OK  H2: STALE_OPEN_OBSERVED present in reconciliation monitor');
}

// L1: write-strega-expectation and reject-indefinite-open must not fall back to {}
for (const nodeId of ['write-strega-expectation', 'reject-indefinite-open']) {
    const n = byId[nodeId];
    if (!n) {
        failures.push(`L1: node ${nodeId} not found`);
        continue;
    }
    if (n.func.includes("flow.get('command_types') || {}")) {
        failures.push(`L1: ${nodeId} falls back to {} on startup race`);
        continue;
    }
    console.log(`OK  L1: ${nodeId} has hardcoded fallback`);
}

// M8: today-liters HTTP endpoint nodes must exist
for (const id of ['strega-today-liters-http-in', 'strega-today-liters-fn', 'strega-today-liters-http-out']) {
    if (!byId[id]) {
        failures.push(`M8: node ${id} not found`);
        continue;
    }
    console.log(`OK  M8: ${id} present`);
}

// === WS2/WS3 osiDb.Database close audit ===

const OPEN_RX = /new\s+osiDb\.Database/;
// Any `.close(` anywhere in the function body counts. osi-os variable names
// for the db handle vary (db, _db, _dbS2120, etc.), so a name-anchored regex
// produces false negatives. False positives are theoretically possible
// (an unrelated `.close(` call on a Stream, say) but none exist today.
const CLOSE_RX = /\.close\s*\(/;

let leaks = [];
for (const node of flows) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    if (!OPEN_RX.test(node.func)) continue;
    if (CLOSE_RX.test(node.func)) continue;
    leaks.push((node.name || '(unnamed)') + ' [' + node.id + ']');
}
if (leaks.length > 0) {
    console.error('FAIL: ' + leaks.length + ' function node(s) open osiDb.Database without closing it:');
    leaks.forEach((l) => console.error('  - ' + l));
    process.exit(1);
}
console.log('OK  osiDb.Database: every opening node closes it');

// === WS2/WS3 misc wiring invariants ===

for (const node of flows) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    const label = (node.name || '(unnamed)') + ' [' + node.id + ']';
    if (/runGatewayMigrationPreflight/.test(node.func)) {
        if (!/const q = \(sql, params = \[\]\) =>/.test(node.func)) {
            failures.push(label + ' defines gateway migration preflight without a parameterized q helper');
        }
        if (!/const run = \(sql, params = \[\]\) =>/.test(node.func)) {
            failures.push(label + ' defines gateway migration preflight without a parameterized run helper');
        }
    }
    if (node.id === 'sync-force-build' && !/req\.setTimeout\(timeoutMs/.test(node.func)) {
        failures.push(label + ' requestJson lacks a timeout guard');
    }
    if (node.id === 'command-ack-build-batch' && !/gatewayMigrationPendingBootstrap/.test(node.func)) {
        failures.push(label + ' does not gate ACK flushes on stable gateway identity');
    }
    if (node.id === 's2120-zones-put-auth-fn') {
        if (!/const rawZoneIds =/.test(node.func) || !/Number\.isInteger/.test(node.func)) {
            failures.push(label + ' does not reject malformed zone_ids before deleting assignments');
        }
    }
}

if (failures.length > 0) {
    console.error('FAIL: ' + failures.length + ' flow wiring regression(s):');
    failures.forEach((l) => console.error('  - ' + l));
    process.exit(1);
}

console.log('PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed');
