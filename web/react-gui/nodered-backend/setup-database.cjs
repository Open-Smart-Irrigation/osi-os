#!/usr/bin/env node

/**
 * Open Smart Irrigation Database Setup Script
 *
 * This script creates the SQLite database with all necessary tables
 * Run this ONCE before starting Node-RED for the first time
 *
 * Usage: npm run setup
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');

// Database file location (in parent directory)
const DB_PATH = path.join(__dirname, '..', 'farming.db');

console.log('🌱 Open Smart Irrigation Database Setup');
console.log('════════════════════════════════════════\n');
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
        type_id TEXT NOT NULL CHECK(type_id IN ('KIWI_SENSOR', 'STREGA_VALVE')),
        user_id INTEGER NOT NULL,
        current_state TEXT CHECK(current_state IN ('OPEN', 'CLOSED')),
        target_state TEXT CHECK(target_state IN ('OPEN', 'CLOSED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
        FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
    )
`);
console.log('✓ Created device_data table');

// Create indexes for better performance
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_deveui ON devices(deveui);
    CREATE INDEX IF NOT EXISTS idx_device_data_deveui ON device_data(deveui);
    CREATE INDEX IF NOT EXISTS idx_device_data_recorded_at ON device_data(recorded_at);
`);
console.log('✓ Created indexes');

// Insert sample data (optional - comment out if you don't want test data)
console.log('\nInserting sample data...');

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
console.log('  1. Copy the init.cjs path: ' + path.join(__dirname, 'init.cjs'));
console.log('  2. Edit Node-RED settings: ~/.node-red/settings.js');
console.log('  3. Add to functionGlobalContext:');
console.log(`     ...require('${path.join(__dirname, 'init.cjs')}')`);
console.log('  4. Import node-red-flows.json into Node-RED');
console.log('  5. Start the React GUI: cd .. && npm run dev\n');

db.close();
