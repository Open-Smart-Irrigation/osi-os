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

function columns(table) {
    return execFileSync('sqlite3', [dbPath, `PRAGMA table_info(${table});`], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|')[1])
        .filter(Boolean);
}

function addColumnIfMissing(table, name, definition) {
    if (columns(table).includes(name)) {
        return false;
    }
    return exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
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
    'CREATE INDEX IF NOT EXISTS idx_applied_commands_applied_at ON applied_commands(applied_at)',
    'CREATE INDEX IF NOT EXISTS idx_device_data_deveui_recorded_at ON device_data(deveui, recorded_at)',
];

for (const stmt of indexes) {
    if (exec(stmt)) applied++;
}

// 3. History data visualization foundation. Additive only; safe for live Pi DBs.
const historySchema = [
    `CREATE TABLE IF NOT EXISTS zone_seasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT, zone_id INTEGER NOT NULL,
        season_uuid TEXT, name TEXT NOT NULL, starts_on TEXT NOT NULL,
        ends_on TEXT NOT NULL, crop_type TEXT, variety TEXT,
        phenological_stage TEXT,
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (starts_on <= ends_on),
        FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_zone_seasons_zone_range
        ON zone_seasons(zone_id, starts_on, ends_on)`,
    `CREATE INDEX IF NOT EXISTS idx_zone_seasons_zone_active
        ON zone_seasons(zone_id, is_active, starts_on, ends_on)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_seasons_zone_active_unique
        ON zone_seasons(zone_id) WHERE is_active = 1`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_seasons_zone_default
        ON zone_seasons(zone_id) WHERE is_default = 1`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_seasons_uuid
        ON zone_seasons(season_uuid) WHERE season_uuid IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS history_channel_rollups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, zone_id INTEGER NOT NULL,
        card_type TEXT NOT NULL, logical_source_key TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        bucket_level TEXT NOT NULL CHECK (bucket_level IN ('15m', 'hourly', 'daily', 'weekly', 'season')),
        bucket_start TEXT NOT NULL, bucket_end TEXT NOT NULL,
        min_value REAL, max_value REAL, mean_value REAL, median_value REAL,
        latest_value REAL, dominant_status TEXT,
        coverage_pct REAL CHECK (coverage_pct IS NULL OR (coverage_pct >= 0 AND coverage_pct <= 100)),
        coverage_confidence TEXT NOT NULL DEFAULT 'unknown' CHECK (coverage_confidence IN ('configured', 'derived', 'unknown')),
        sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
        event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
        threshold_crossing_count INTEGER NOT NULL DEFAULT 0 CHECK (threshold_crossing_count >= 0),
        unit TEXT, computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (bucket_start < bucket_end),
        FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_history_rollups_unique_bucket
        ON history_channel_rollups(zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start)`,
    `CREATE INDEX IF NOT EXISTS idx_history_rollups_zone_card_bucket
        ON history_channel_rollups(zone_id, card_type, bucket_level, bucket_start, bucket_end)`,
    `CREATE INDEX IF NOT EXISTS idx_history_rollups_source_channel
        ON history_channel_rollups(logical_source_key, channel_id, bucket_level, bucket_start)`,
    `CREATE TABLE IF NOT EXISTS history_card_preferences (
        user_id INTEGER NOT NULL, owner_user_uuid TEXT,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('zone', 'gateway')),
        zone_id INTEGER, gateway_eui TEXT, card_id TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        manual_order INTEGER, open_count INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),
        last_opened_at TEXT, last_view_mode TEXT,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (scope_type = 'zone' AND zone_id IS NOT NULL AND gateway_eui IS NULL) OR
          (scope_type = 'gateway' AND gateway_eui IS NOT NULL AND zone_id IS NULL)
        ),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_history_card_preferences_zone
        ON history_card_preferences(user_id, zone_id, card_id) WHERE scope_type = 'zone'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_history_card_preferences_gateway
        ON history_card_preferences(user_id, gateway_eui, card_id) WHERE scope_type = 'gateway'`,
    `CREATE TABLE IF NOT EXISTS history_workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        owner_user_uuid TEXT, zone_id INTEGER, name TEXT NOT NULL,
        workspace_json TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_history_workspaces_user_zone
        ON history_workspaces(user_id, zone_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_history_workspaces_user_default
        ON history_workspaces(user_id, zone_id) WHERE is_default = 1`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_history_workspaces_user_global_default
        ON history_workspaces(user_id) WHERE is_default = 1 AND zone_id IS NULL`,
    'ANALYZE',
];

for (const stmt of historySchema) {
    if (exec(stmt)) applied++;
}

// 4. Column-level repairs for DBs that got an earlier runtime-created ledger.
const appliedCommandColumns = [
    ['result_detail', 'TEXT'],
    ['originator', 'TEXT'],
    ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_error', 'TEXT'],
    ['last_ack_attempt_at', 'TEXT'],
    ['expires_at', 'TEXT'],
];
for (const [name, definition] of appliedCommandColumns) {
    if (addColumnIfMissing('applied_commands', name, definition)) applied++;
}

// 5. Verify
const tables = execFileSync('sqlite3', [dbPath, ".tables"], { encoding: 'utf8' }).split(/\s+/);
const want = [
    'valve_actuation_expectations',
    'zone_irrigation_calibration',
    'applied_commands',
    'zone_seasons',
    'history_channel_rollups',
    'history_card_preferences',
    'history_workspaces',
];
for (const t of want) {
    if (!tables.includes(t)) {
        console.error(`FAIL: missing table after repair: ${t}`);
        process.exit(1);
    }
}
const appliedColumns = columns('applied_commands');
for (const column of appliedCommandColumns.map(([name]) => name)) {
    if (!appliedColumns.includes(column)) {
        console.error(`FAIL: missing applied_commands column after repair: ${column}`);
        process.exit(1);
    }
}

console.log(`OK: ${applied} repairs applied; all required tables present`);
