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

console.log('PASS: C5 wiring correct');
