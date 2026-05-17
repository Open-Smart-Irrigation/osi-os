#!/usr/bin/env node
// Idempotent migration: WS3 applied_commands table.
// Usage: node scripts/migrate-applied-commands.js [/data/db/farming.db]
// Safe to re-run.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dbPath = process.argv[2] || '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
    console.error(`FAIL: DB file does not exist: ${dbPath}`);
    process.exit(2);
}

const sqlPath = path.resolve(__dirname, '../database/migrations/2026-05-17-add-applied-commands.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

function sqlite(input) {
    return execFileSync('sqlite3', [dbPath], { input, encoding: 'utf8' });
}

function columns(table) {
    return execFileSync('sqlite3', [dbPath, `PRAGMA table_info(${table});`], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|')[1])
        .filter(Boolean);
}

function ensureColumn(table, name, definition) {
    if (columns(table).includes(name)) {
        console.log(`  ok ${table}.${name} present`);
        return;
    }
    sqlite(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
    console.log(`  added ${table}.${name}`);
}

try {
    sqlite(sql);
    console.log(`OK: applied ${path.basename(sqlPath)} to ${dbPath}`);

    const output = execFileSync('sqlite3', [dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='applied_commands';"
    ], { encoding: 'utf8' });
    if (!output.trim()) throw new Error('applied_commands table missing after migration');
    console.log('  ok applied_commands present');

    ensureColumn('applied_commands', 'result_detail', 'TEXT');
    ensureColumn('applied_commands', 'originator', 'TEXT');
    ensureColumn('applied_commands', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('applied_commands', 'last_error', 'TEXT');
    ensureColumn('applied_commands', 'last_ack_attempt_at', 'TEXT');
    ensureColumn('applied_commands', 'expires_at', 'TEXT');
} catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
}
