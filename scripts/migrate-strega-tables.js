#!/usr/bin/env node
// Idempotent migration: WS1 STREGA tables.
// Usage: node scripts/migrate-strega-tables.js [/data/db/farming.db]
// Safe to re-run. Does NOT overwrite the DB file; only adds tables/indexes if missing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dbPath = process.argv[2] || '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
    console.error(`FAIL: DB file does not exist: ${dbPath}`);
    process.exit(2);
}

const sqlPath = path.resolve(__dirname, '../database/migrations/2026-05-16-add-strega-expectations.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

try {
    execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
    console.log(`OK: applied ${path.basename(sqlPath)} to ${dbPath}`);

    const output = execFileSync('sqlite3', [dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('valve_actuation_expectations','zone_irrigation_calibration');"
    ], { encoding: 'utf8' });
    const tables = output.trim().split('\n').filter(l => l);
    const want = ['valve_actuation_expectations', 'zone_irrigation_calibration'];
    for (const t of want) {
        if (!tables.includes(t)) {
            console.error(`FAIL: post-migration table missing: ${t}`);
            process.exit(3);
        }
        console.log(`  ok ${t} present`);
    }
} catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
}
