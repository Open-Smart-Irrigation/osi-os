#!/usr/bin/env node

/**
 * Open Smart irrigation Database Setup Script
 *
 * This script creates the SQLite database with all necessary tables
 * Run this ONCE before starting Node-RED for the first time
 * Existing farming.db files are not migrated here; remove stale local dev DBs and rerun this script after schema changes.
 *
 * Usage: node setup-database.js
 */

const Database = require('better-sqlite3');
const path = require('path');

// Database file location (change this to your preferred location)
const DB_PATH = path.join(__dirname, 'farming.db');

console.log('🌱 Open Smart irrigation Database Setup');
console.log('================================\n');
console.log(`Database location: ${DB_PATH}\n`);

// Create/open database
const db = new Database(DB_PATH, { verbose: console.log });

// Enable foreign keys
db.pragma('foreign_keys = ON');

console.log('Creating tables...\n');

// Create users table
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);
console.log('✓ Created users table');

// Create devices table
db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deveui TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        type_id TEXT NOT NULL CHECK(type_id IN ('KIWI_SENSOR', 'TEKTELIC_CLOVER', 'STREGA_VALVE', 'DRAGINO_LSN50', 'SENSECAP_S2120')),
        user_id INTEGER,
        farm_id TEXT,
        current_state TEXT CHECK(current_state IN ('OPEN', 'CLOSED')),
        target_state TEXT CHECK(target_state IN ('OPEN', 'CLOSED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        chirpstack_app_id TEXT,
        irrigation_zone_id INTEGER,
        dendro_enabled INTEGER NOT NULL DEFAULT 0,
        temp_enabled INTEGER NOT NULL DEFAULT 0,
        is_reference_tree INTEGER NOT NULL DEFAULT 0,
        sync_version INTEGER DEFAULT 0,
        deleted_at DATETIME,
        gateway_device_eui TEXT,
        strega_model TEXT,
        rain_gauge_enabled INTEGER DEFAULT 0,
        flow_meter_enabled INTEGER DEFAULT 0,
        soil_moisture_probe_depths_json TEXT,
        soil_moisture_probe_depths_configured INTEGER DEFAULT 0,
        dendro_force_legacy INTEGER DEFAULT 0,
        dendro_stroke_mm REAL,
        dendro_ratio_at_retracted REAL,
        dendro_ratio_at_extended REAL,
        dendro_ratio_zero REAL,
        dendro_ratio_span REAL,
        dendro_baseline_position_mm REAL,
        dendro_baseline_mode_used TEXT,
        dendro_baseline_calibration_signature TEXT,
        dendro_baseline_pending INTEGER DEFAULT 0,
        dendro_invert_direction INTEGER DEFAULT 0,
        chameleon_enabled INTEGER DEFAULT 0,
        chameleon_swt1_depth_cm REAL,
        chameleon_swt2_depth_cm REAL,
        chameleon_swt3_depth_cm REAL,
        chameleon_swt1_a REAL,
        chameleon_swt1_b REAL,
        chameleon_swt1_c REAL,
        chameleon_swt2_a REAL,
        chameleon_swt2_b REAL,
        chameleon_swt2_c REAL,
        chameleon_swt3_a REAL,
        chameleon_swt3_b REAL,
        chameleon_swt3_c REAL,
        device_mode INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
`);
console.log('✓ Created devices table');

// Create device_data table (for sensor readings)
db.exec(`
    CREATE TABLE IF NOT EXISTS device_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deveui TEXT NOT NULL,
        swt_wm1 REAL,
        swt_wm2 REAL,
        light_lux REAL,
        recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ambient_temperature REAL,
        relative_humidity REAL,
        ext_temperature_c REAL,
        bat_v REAL,
        adc_ch0v REAL,
        dendro_position_mm REAL,
        dendro_valid INTEGER,
        dendro_delta_mm REAL,
        rain_count_cumulative INTEGER,
        rain_tips_delta INTEGER,
        rain_mm_delta REAL,
        flow_count_cumulative INTEGER,
        flow_pulses_delta INTEGER,
        flow_liters_delta REAL,
        swt_1 REAL,
        swt_2 REAL,
        swt_3 REAL,
        lsn50_mode_code INTEGER,
        lsn50_mode_label TEXT,
        lsn50_mode_observed_at TEXT,
        rain_mm_per_hour REAL,
        rain_delta_status TEXT,
        flow_liters_per_min REAL,
        flow_delta_status TEXT,
        counter_interval_seconds INTEGER,
        rain_mm_per_10min REAL,
        rain_mm_today REAL,
        flow_liters_per_10min REAL,
        flow_liters_today REAL,
        barometric_pressure_hpa REAL,
        wind_speed_mps REAL,
        wind_direction_deg REAL,
        wind_gust_mps REAL,
        uv_index REAL,
        rain_gauge_cumulative_mm REAL,
        bat_pct REAL,
        adc_ch1v REAL,
        dendro_ratio REAL,
        dendro_mode_used TEXT,
        dendro_stem_change_um REAL,
        dendro_position_raw_mm REAL,
        dendro_saturated INTEGER DEFAULT 0,
        dendro_saturation_side TEXT,
        FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
    )
`);
console.log('✓ Created device_data table');

db.exec(`
    CREATE TABLE IF NOT EXISTS dendrometer_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deveui TEXT NOT NULL,
        position_um REAL NOT NULL,
        adc_v REAL,
        bat_v REAL,
        is_valid INTEGER NOT NULL DEFAULT 1,
        invalid_reason TEXT,
        is_outlier INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL,
        adc_ch0v REAL,
        adc_ch1v REAL,
        dendro_ratio REAL,
        dendro_mode_used TEXT,
        position_raw_um REAL,
        dendro_saturated INTEGER DEFAULT 0,
        dendro_saturation_side TEXT,
        FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chameleon_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deveui TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        payload_version INTEGER,
        status_flags INTEGER,
        i2c_missing INTEGER DEFAULT 0,
        timeout INTEGER DEFAULT 0,
        temp_fault INTEGER DEFAULT 0,
        id_fault INTEGER DEFAULT 0,
        ch1_open INTEGER DEFAULT 0,
        ch2_open INTEGER DEFAULT 0,
        ch3_open INTEGER DEFAULT 0,
        temp_c REAL,
        r1_ohm_comp INTEGER,
        r2_ohm_comp INTEGER,
        r3_ohm_comp INTEGER,
        r1_ohm_raw INTEGER,
        r2_ohm_raw INTEGER,
        r3_ohm_raw INTEGER,
        array_id TEXT,
        adc_ch0v REAL,
        adc_ch1v REAL,
        adc_ch4v REAL,
        bat_v REAL,
        payload_b64 TEXT,
        f_port INTEGER,
        f_cnt INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
    )
`);
console.log('✓ Created LSN50 extension tables');

// Create indexes for better performance
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_deveui ON devices(deveui);
    CREATE INDEX IF NOT EXISTS idx_device_data_deveui ON device_data(deveui);
    CREATE INDEX IF NOT EXISTS idx_device_data_recorded_at ON device_data(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_dendro_readings_deveui_time ON dendrometer_readings(deveui, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_chameleon_readings_deveui_time ON chameleon_readings(deveui, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_chameleon_readings_array_id ON chameleon_readings(array_id);
`);
console.log('✓ Created indexes');

// Insert sample data (optional - comment out if you don't want test data)
console.log('\nInserting sample data...');

const bcrypt = require('bcrypt');

// Sample user (username: farmer, password: test123)
const samplePasswordHash = bcrypt.hashSync('test123', 10);
const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, created_at)
    VALUES (?, ?, datetime('now'))
`);
insertUser.run('farmer', samplePasswordHash);
console.log('✓ Created sample user (username: farmer, password: test123)');

// Get the user ID
const user = db.prepare('SELECT id FROM users WHERE username = ?').get('farmer');

if (user) {
    // Sample Kiwi Sensor
    const insertDevice = db.prepare(`
        INSERT OR IGNORE INTO devices (deveui, name, type_id, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    insertDevice.run('0123456789ABCDEF', 'North Field Sensor', 'KIWI_SENSOR', user.id);
    console.log('✓ Created sample Kiwi sensor (DevEUI: 0123456789ABCDEF)');

    // Sample Strega Valve
    const insertValve = db.prepare(`
        INSERT OR IGNORE INTO devices (deveui, name, type_id, user_id, current_state, target_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    insertValve.run('FEDCBA9876543210', 'Main Irrigation Valve', 'STREGA_VALVE', user.id, 'CLOSED', 'CLOSED');
    console.log('✓ Created sample Strega valve (DevEUI: FEDCBA9876543210)');

    // Sample sensor data
    const insertData = db.prepare(`
        INSERT INTO device_data (deveui, swt_wm1, swt_wm2, light_lux, recorded_at)
        VALUES (?, ?, ?, ?, datetime('now'))
    `);

    insertData.run('0123456789ABCDEF', 45.2, 42.8, 15000);
    insertData.run('0123456789ABCDEF', 25.1, 28.3, 14500); // This one is "too dry"
    console.log('✓ Created sample sensor readings');
}

console.log('\n✅ Database setup complete!\n');
console.log('Database stats:');
console.log(`  Users: ${db.prepare('SELECT COUNT(*) as count FROM users').get().count}`);
console.log(`  Devices: ${db.prepare('SELECT COUNT(*) as count FROM devices').get().count}`);
console.log(`  Sensor readings: ${db.prepare('SELECT COUNT(*) as count FROM device_data').get().count}`);

console.log('\n📝 Next steps:');
console.log('  1. Update the DB_PATH in your Node-RED settings or init script');
console.log('  2. Import the node-red-flows.json into Node-RED');
console.log('  3. Set required environment variable: JWT_SECRET=your-secret-key');
console.log('  4. Restart Node-RED');
console.log('  5. Start the React app with: npm run dev\n');

db.close();
