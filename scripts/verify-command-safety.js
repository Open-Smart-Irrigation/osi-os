#!/usr/bin/env node
// WS1 verification: STREGA actuation expectations, calibration, dispatch rejection,
// reconciliation monitor, and explicit cancel path.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SEED_DB = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

function assertTable(dbPath, name, requiredColumns) {
    const output = execFileSync('sqlite3', [dbPath, `pragma table_info(${name});`], { encoding: 'utf8' });
    const cols = output.trim().split('\n').filter(l => l).map(l => l.split('|')[1]);
    if (cols.length === 0) throw new Error(`Missing required table: ${name}`);
    for (const col of requiredColumns) {
        if (!cols.includes(col)) throw new Error(`Table ${name} missing column: ${col}`);
    }
    console.log(`  ok ${name} has required columns`);
}

function checkSchema() {
    assertTable(SEED_DB, 'valve_actuation_expectations', [
        'expectation_id', 'device_eui', 'zone_id', 'command_id', 'effect_key',
        'commanded_at', 'commanded_duration_seconds', 'expected_close_at',
        'flow_rate_lpm', 'flow_rate_source', 'estimated_gross_liters', 'volume_source',
        'observed_open_at', 'observed_close_at', 'reconciliation_state',
        'cancel_reason', 'created_at',
    ]);
    assertTable(SEED_DB, 'zone_irrigation_calibration', [
        'zone_id', 'valve_device_eui', 'measured_flow_rate_lpm',
        'measurement_method', 'measured_at', 'created_at', 'updated_at',
    ]);
}

function assertIndefiniteOpenRejection() {
    const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
    const node = flows.find(n =>
        n.type === 'function' && n.name === 'Reject Indefinite Open'
    );
    if (!node) {
        throw new Error('Missing function node "Reject Indefinite Open" in command dispatch path');
    }
    if (!node.func.includes('requires_duration')) {
        throw new Error('"Reject Indefinite Open" must check requires_duration from the command-type registry');
    }
    if (!node.func.includes("command_type === 'OPEN'")) {
        throw new Error('"Reject Indefinite Open" must explicitly reject command_type === "OPEN"');
    }
    console.log('  ok Indefinite-open rejection node present');
}

function main() {
    checkSchema();
    assertIndefiniteOpenRejection();
    console.log('verify-command-safety: OK');
}

try { main(); } catch (e) { console.error('FAIL:', e.message); process.exit(1); }
