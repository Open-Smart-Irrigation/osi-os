#!/usr/bin/env node
// repair-pi-schema.js — idempotent schema repair for live Pi DB
// Usage: node scripts/repair-pi-schema.js [/data/db/farming.db]
// Never overwrites the DB file; uses IF NOT EXISTS / idempotent DDL.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dbPath = process.argv[2] || '/data/db/farming.db';

if (!fs.existsSync(dbPath)) {
    console.error(`FAIL: DB file does not exist: ${dbPath}`);
    process.exit(2);
}

let applied = 0;

function exec(sql) {
    try {
        execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
        return true;
    } catch (e) {
        console.error(`  WARN: ${e.message.split('\n')[0]}`);
        return false;
    }
}

console.log(`Repairing ${dbPath}`);

// 1. Base tables
const baseTables = [
    `CREATE TABLE IF NOT EXISTS valve_actuation_expectations (
        expectation_id TEXT PRIMARY KEY, device_eui TEXT NOT NULL, zone_id INTEGER,
        command_id TEXT, effect_key TEXT, commanded_at TEXT NOT NULL,
        commanded_duration_seconds INTEGER NOT NULL, expected_close_at TEXT NOT NULL,
        flow_rate_lpm REAL, flow_rate_source TEXT, estimated_gross_liters REAL,
        volume_source TEXT NOT NULL, observed_open_at TEXT, observed_close_at TEXT,
        reconciliation_state TEXT NOT NULL DEFAULT 'PENDING_OBSERVATION',
        cancel_reason TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS zone_irrigation_calibration (
        zone_id INTEGER PRIMARY KEY, valve_device_eui TEXT,
        measured_flow_rate_lpm REAL NOT NULL, measurement_method TEXT NOT NULL,
        measured_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS applied_commands (
        command_id TEXT PRIMARY KEY, device_eui TEXT NOT NULL,
        command_type TEXT NOT NULL, effect_key TEXT, applied_at TEXT NOT NULL,
        result TEXT NOT NULL, result_detail TEXT, originator TEXT)`,
];

for (const stmt of baseTables) {
    if (exec(stmt)) applied++;
}

// 2. Indexes
const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_valve_act_exp_device_eui ON valve_actuation_expectations(device_eui)',
    'CREATE INDEX IF NOT EXISTS idx_valve_act_exp_active ON valve_actuation_expectations(reconciliation_state) WHERE reconciliation_state IN (\'PENDING_OBSERVATION\',\'OBSERVED_RUNNING\')',
    'CREATE INDEX IF NOT EXISTS idx_valve_act_exp_effect_key ON valve_actuation_expectations(effect_key)',
    'CREATE INDEX IF NOT EXISTS idx_applied_commands_device_eui ON applied_commands(device_eui)',
    'CREATE INDEX IF NOT EXISTS idx_applied_commands_effect_key ON applied_commands(effect_key)',
];

for (const stmt of indexes) {
    if (exec(stmt)) applied++;
}

// 3. Verify
const tables = execFileSync('sqlite3', [dbPath, ".tables"], { encoding: 'utf8' }).split(/\s+/);
const want = ['valve_actuation_expectations', 'zone_irrigation_calibration', 'applied_commands'];
for (const t of want) {
    if (!tables.includes(t)) {
        console.error(`FAIL: missing table after repair: ${t}`);
        process.exit(1);
    }
}

console.log(`OK: ${applied} repairs applied; all required tables present`);
