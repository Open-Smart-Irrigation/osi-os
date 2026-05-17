#!/usr/bin/env node
// Asserts C5 wiring: write-strega-expectation sits between
// from-scheduler/manual and Build STREGA downlink.
const fs = require('fs');
const path = require('path');

const flowsPath = path.resolve(
    __dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const byId = Object.fromEntries(flows.filter(n => n.id).map(n => [n.id, n]));

function assertWires(nodeId, expectedWires, label) {
    const node = byId[nodeId];
    if (!node) { console.error(`FAIL: node ${nodeId} not found (${label})`); process.exit(1); }
    const actual = JSON.stringify(node.wires);
    const expected = JSON.stringify(expectedWires);
    if (actual !== expected) {
        console.error(`FAIL ${label}: expected wires ${expected}, got ${actual}`);
        process.exit(1);
    }
    console.log(`OK  ${label}`);
}

// from scheduler/manual must wire to write-strega-expectation (not directly to Build STREGA downlink)
assertWires('5974306566e99a92',
    [['072f29aa8760340a', 'write-strega-expectation']],
    'from-scheduler/manual → write-strega-expectation');

// write-strega-expectation must wire directly to Build STREGA downlink
assertWires('write-strega-expectation',
    [['cdbaa3891d40d7a1']],
    'write-strega-expectation → Build STREGA downlink');

// H2: reconciliation monitor must handle OBSERVED_RUNNING stale timeout
const reconcNode = byId['strega-reconciliation-monitor'];
if (!reconcNode) { console.error('FAIL: strega-reconciliation-monitor not found'); process.exit(1); }
if (!reconcNode.func.includes('STALE_OPEN_OBSERVED')) {
    console.error('FAIL H2: strega-reconciliation-monitor missing STALE_OPEN_OBSERVED transition');
    process.exit(1);
}
console.log('OK  H2: STALE_OPEN_OBSERVED present in reconciliation monitor');

// L1: write-strega-expectation and reject-indefinite-open must not fall back to {}
['write-strega-expectation', 'reject-indefinite-open'].forEach(nodeId => {
    const n = byId[nodeId];
    if (!n) { console.error(`FAIL: node ${nodeId} not found`); process.exit(1); }
    if (n.func.includes("flow.get('command_types') || {}")) {
        console.error(`FAIL L1: ${nodeId} falls back to {} on startup race`);
        process.exit(1);
    }
    console.log(`OK  L1: ${nodeId} has hardcoded fallback`);
});

// M8: today-liters HTTP endpoint nodes must exist
['strega-today-liters-http-in', 'strega-today-liters-fn', 'strega-today-liters-http-out'].forEach(id => {
    if (!byId[id]) { console.error(`FAIL M8: node ${id} not found`); process.exit(1); }
    console.log(`OK  M8: ${id} present`);
});

console.log('PASS: C5 + H2 + L1 + M8 checks correct');
