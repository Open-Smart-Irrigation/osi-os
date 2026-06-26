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

function query(sql) {
    return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function queryJson(sql) {
    const output = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
    return output ? JSON.parse(output) : [];
}

function queryNumber(sql) {
    const value = query(sql);
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function normalizeSql(sql) {
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const requiredHistoryIndexSqlFragments = {
    idx_device_data_deveui_recorded_at: [
        'on device_data(deveui, recorded_at)',
    ],
    idx_zone_seasons_zone_range: [
        'on zone_seasons(zone_id, starts_on, ends_on)',
    ],
    idx_zone_seasons_zone_active: [
        'on zone_seasons(zone_id, is_active, starts_on, ends_on)',
    ],
    idx_zone_seasons_zone_active_unique: [
        'unique index',
        'on zone_seasons(zone_id)',
        'where is_active = 1',
    ],
    idx_zone_seasons_zone_default: [
        'unique index',
        'on zone_seasons(zone_id)',
        'where is_default = 1',
    ],
    idx_zone_seasons_uuid: [
        'unique index',
        'on zone_seasons(season_uuid)',
        'where season_uuid is not null',
    ],
    idx_history_rollups_unique_bucket: [
        'unique index',
        'on history_channel_rollups(zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start)',
    ],
    idx_history_rollups_zone_card_bucket: [
        'on history_channel_rollups(zone_id, card_type, bucket_level, bucket_start, bucket_end)',
    ],
    idx_history_rollups_source_channel: [
        'on history_channel_rollups(logical_source_key, channel_id, bucket_level, bucket_start)',
    ],
    idx_history_card_preferences_zone: [
        'unique index',
        'on history_card_preferences(user_id, zone_id, card_id)',
        "where scope_type = 'zone'",
    ],
    idx_history_card_preferences_gateway: [
        'unique index',
        'on history_card_preferences(user_id, gateway_eui, card_id)',
        "where scope_type = 'gateway'",
    ],
    idx_history_workspaces_user_zone: [
        'on history_workspaces(user_id, zone_id)',
    ],
    idx_history_workspaces_user_default: [
        'unique index',
        'on history_workspaces(user_id, zone_id)',
        'where is_default = 1',
    ],
    idx_history_workspaces_user_global_default: [
        'unique index',
        'on history_workspaces(user_id)',
        'where is_default = 1 and zone_id is null',
    ],
};

function addColumnIfMissing(table, name, definition) {
    if (columns(table).includes(name)) {
        return false;
    }
    return exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function indexSql(indexName) {
    const escapedName = indexName.replace(/'/g, "''");
    return query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${escapedName}';`);
}

function reportDuplicateHistoryRows() {
    const activeSeasonDuplicates = query(
        `SELECT zone_id || ':' || COUNT(*)
         FROM zone_seasons
         WHERE is_active = 1
         GROUP BY zone_id
         HAVING COUNT(*) > 1`,
    );
    if (activeSeasonDuplicates) {
        console.error(`FAIL: duplicate active zone seasons block idx_zone_seasons_zone_active_unique: ${activeSeasonDuplicates}`);
    }

    const defaultSeasonDuplicates = query(
        `SELECT zone_id || ':' || COUNT(*)
         FROM zone_seasons
         WHERE is_default = 1
         GROUP BY zone_id
         HAVING COUNT(*) > 1`,
    );
    if (defaultSeasonDuplicates) {
        console.error(`FAIL: duplicate default zone seasons block idx_zone_seasons_zone_default: ${defaultSeasonDuplicates}`);
    }

    const seasonUuidDuplicates = query(
        `SELECT season_uuid || ':' || COUNT(*)
         FROM zone_seasons
         WHERE season_uuid IS NOT NULL
         GROUP BY season_uuid
         HAVING COUNT(*) > 1`,
    );
    if (seasonUuidDuplicates) {
        console.error(`FAIL: duplicate season UUIDs block idx_zone_seasons_uuid: ${seasonUuidDuplicates}`);
    }

    const rollupDuplicates = query(
        `SELECT zone_id || ':' || card_type || ':' || logical_source_key || ':' ||
                channel_id || ':' || bucket_level || ':' || bucket_start || ':' || COUNT(*)
         FROM history_channel_rollups
         GROUP BY zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start
         HAVING COUNT(*) > 1`,
    );
    if (rollupDuplicates) {
        console.error(`FAIL: duplicate rollup buckets block idx_history_rollups_unique_bucket: ${rollupDuplicates}`);
    }

    const zonePreferenceDuplicates = query(
        `SELECT user_id || ':' || zone_id || ':' || card_id || ':' || COUNT(*)
         FROM history_card_preferences
         WHERE scope_type = 'zone'
         GROUP BY user_id, zone_id, card_id
         HAVING COUNT(*) > 1`,
    );
    if (zonePreferenceDuplicates) {
        console.error(`FAIL: duplicate zone card preferences block idx_history_card_preferences_zone: ${zonePreferenceDuplicates}`);
    }

    const gatewayPreferenceDuplicates = query(
        `SELECT user_id || ':' || gateway_eui || ':' || card_id || ':' || COUNT(*)
         FROM history_card_preferences
         WHERE scope_type = 'gateway'
         GROUP BY user_id, gateway_eui, card_id
         HAVING COUNT(*) > 1`,
    );
    if (gatewayPreferenceDuplicates) {
        console.error(`FAIL: duplicate gateway card preferences block idx_history_card_preferences_gateway: ${gatewayPreferenceDuplicates}`);
    }

    const zonedDefaultWorkspaceDuplicates = query(
        `SELECT user_id || ':' || zone_id || ':' || COUNT(*)
         FROM history_workspaces
         WHERE is_default = 1 AND zone_id IS NOT NULL
         GROUP BY user_id, zone_id
         HAVING COUNT(*) > 1`,
    );
    if (zonedDefaultWorkspaceDuplicates) {
        console.error(`FAIL: duplicate zoned default workspaces block idx_history_workspaces_user_default: ${zonedDefaultWorkspaceDuplicates}`);
    }

    const globalDefaultDuplicates = query(
        `SELECT user_id || ':' || COUNT(*)
         FROM history_workspaces
         WHERE is_default = 1 AND zone_id IS NULL
         GROUP BY user_id
         HAVING COUNT(*) > 1`,
    );
    if (globalDefaultDuplicates) {
        console.error(`FAIL: duplicate global default workspaces block idx_history_workspaces_user_global_default: ${globalDefaultDuplicates}`);
    }
}

function verifyIndexDefinition(indexName, expectedFragments) {
    const sql = normalizeSql(indexSql(indexName));
    const missingFragments = expectedFragments.filter((fragment) => !sql.includes(fragment));
    if (missingFragments.length) {
        console.error(`FAIL: missing or malformed index ${indexName}: ${sql || '<missing>'}`);
        return false;
    }
    return true;
}

function quoteIdent(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`;
}

function ensureDeviceTypeCheckIncludesLorain() {
    const devicesSql = query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices';");
    if (devicesSql.includes("'AQUASCOPE_LORAIN'")) {
        return false;
    }

    const deviceColumns = [
        'id',
        'deveui',
        'name',
        'type_id',
        'user_id',
        'farm_id',
        'current_state',
        'target_state',
        'created_at',
        'updated_at',
        'claimed_at',
        'chirpstack_app_id',
        'irrigation_zone_id',
        'dendro_enabled',
        'temp_enabled',
        'is_reference_tree',
        'sync_version',
        'deleted_at',
        'gateway_device_eui',
        'strega_model',
        'rain_gauge_enabled',
        'flow_meter_enabled',
        'soil_moisture_probe_depths_json',
        'soil_moisture_probe_depths_configured',
        'dendro_ratio_at_retracted',
        'dendro_ratio_at_extended',
        'dendro_force_legacy',
        'dendro_stroke_mm',
        'dendro_ratio_zero',
        'dendro_ratio_span',
        'dendro_baseline_position_mm',
        'dendro_baseline_mode_used',
        'dendro_baseline_calibration_signature',
        'dendro_baseline_pending',
        'dendro_invert_direction',
        'device_mode',
        'chameleon_enabled',
        'chameleon_swt1_depth_cm',
        'chameleon_swt2_depth_cm',
        'chameleon_swt3_depth_cm',
    ];
    const existingColumns = new Set(columns('devices'));
    const copyColumns = deviceColumns.filter((column) => existingColumns.has(column));
    const copyColumnSql = copyColumns.map(quoteIdent).join(', ');
    const deviceArtifacts = queryJson(`
        SELECT type, name, sql
        FROM sqlite_master
        WHERE tbl_name = 'devices'
          AND type = 'index'
          AND sql IS NOT NULL
        ORDER BY type, name
    `).map((row) => row.sql).filter(Boolean);
    const dependentTriggers = queryJson(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'trigger'
          AND sql IS NOT NULL
          AND sql LIKE '%devices%'
        ORDER BY name
    `);
    const dropDependentTriggerSql = dependentTriggers
        .map((row) => `DROP TRIGGER IF EXISTS ${quoteIdent(row.name)};`)
        .join('\n');
    const artifacts = [
        ...deviceArtifacts,
        ...dependentTriggers.map((row) => row.sql).filter(Boolean),
    ];

    const rebuildSql = `
        PRAGMA foreign_keys = OFF;
        BEGIN TRANSACTION;
        ${dropDependentTriggerSql}
        CREATE TABLE devices_lorain_repair (
          id                                    INTEGER PRIMARY KEY AUTOINCREMENT,
          deveui                                TEXT UNIQUE NOT NULL,
          name                                  TEXT NOT NULL,
          type_id                               TEXT NOT NULL CHECK(type_id IN (
                                                  'KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50',
                                                  'TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN')),
          user_id                               INTEGER NULL,
          farm_id                               TEXT NULL,
          current_state                         TEXT CHECK(current_state IN ('OPEN','CLOSED')),
          target_state                          TEXT CHECK(target_state IN ('OPEN','CLOSED')),
          created_at                            TEXT NOT NULL,
          updated_at                            TEXT NOT NULL,
          claimed_at                            TEXT NULL,
          chirpstack_app_id                     TEXT,
          irrigation_zone_id                    INTEGER REFERENCES irrigation_zones(id) ON DELETE SET NULL,
          dendro_enabled                        INTEGER NOT NULL DEFAULT 0,
          temp_enabled                          INTEGER NOT NULL DEFAULT 0,
          is_reference_tree                     INTEGER NOT NULL DEFAULT 0,
          sync_version                          INTEGER DEFAULT 0,
          deleted_at                            DATETIME,
          gateway_device_eui                    TEXT,
          strega_model                          TEXT,
          rain_gauge_enabled                    INTEGER DEFAULT 0,
          flow_meter_enabled                    INTEGER DEFAULT 0,
          soil_moisture_probe_depths_json       TEXT,
          soil_moisture_probe_depths_configured INTEGER DEFAULT 0,
          dendro_ratio_at_retracted             REAL,
          dendro_ratio_at_extended              REAL,
          dendro_force_legacy                   INTEGER DEFAULT 0,
          dendro_stroke_mm                      REAL,
          dendro_ratio_zero                     REAL,
          dendro_ratio_span                     REAL,
          dendro_baseline_position_mm           REAL,
          dendro_baseline_mode_used             TEXT,
          dendro_baseline_calibration_signature TEXT,
          dendro_baseline_pending               INTEGER DEFAULT 0,
          dendro_invert_direction               INTEGER DEFAULT 0,
          device_mode                           INTEGER DEFAULT 1,
          chameleon_enabled                     INTEGER DEFAULT 0,
          chameleon_swt1_depth_cm               REAL,
          chameleon_swt2_depth_cm               REAL,
          chameleon_swt3_depth_cm               REAL,
          FOREIGN KEY (user_id)  REFERENCES users(id)             ON DELETE SET NULL,
          FOREIGN KEY (farm_id)  REFERENCES farms(farm_id)        ON DELETE SET NULL
        );
        INSERT INTO devices_lorain_repair (${copyColumnSql})
        SELECT ${copyColumnSql}
        FROM devices;
        DROP TABLE devices;
        ALTER TABLE devices_lorain_repair RENAME TO devices;
        COMMIT;
        PRAGMA foreign_keys = ON;
    `;

    if (!exec(rebuildSql)) {
        console.error('FAIL: devices table rebuild failed while adding AQUASCOPE_LORAIN');
        process.exit(1);
    }
    for (const artifactSql of artifacts) {
        if (!exec(artifactSql)) {
            console.error('FAIL: failed to restore devices-dependent schema artifact');
            process.exit(1);
        }
    }
    return true;
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

const zonesMissingDefaultSeasonBefore = queryNumber(`
    SELECT COUNT(*)
    FROM irrigation_zones z
    WHERE z.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM zone_seasons s
        WHERE s.zone_id = z.id AND s.is_active = 1
      )
`);

if (exec(`
    INSERT INTO zone_seasons(zone_id, name, starts_on, ends_on, is_active, is_default, created_at, updated_at)
    SELECT z.id, 'Current season', strftime('%Y-01-01', 'now'), strftime('%Y-12-31', 'now'),
           1,
           CASE WHEN EXISTS (
             SELECT 1 FROM zone_seasons s
             WHERE s.zone_id = z.id AND s.is_default = 1
           ) THEN 0 ELSE 1 END,
           datetime('now'), datetime('now')
    FROM irrigation_zones z
    WHERE z.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM zone_seasons s
        WHERE s.zone_id = z.id AND s.is_active = 1
      )
`)) {
    applied += zonesMissingDefaultSeasonBefore;
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

if (ensureDeviceTypeCheckIncludesLorain()) applied++;

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

const criticalHistoryIndexesOk = Object.entries(requiredHistoryIndexSqlFragments)
    .map(([indexName, expectedFragments]) => verifyIndexDefinition(indexName, expectedFragments))
    .every(Boolean);

if (!criticalHistoryIndexesOk) {
    reportDuplicateHistoryRows();
    process.exit(1);
}

console.log(`OK: ${applied} repairs applied; all required tables present`);
