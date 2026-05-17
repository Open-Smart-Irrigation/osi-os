#!/usr/bin/env node
// Idempotent migration: WS2 sync_outbox v2 selective delivery columns.
// Usage: node scripts/migrate-sync-outbox.js [/data/db/farming.db]
// Safe to re-run.

const fs = require('fs');
const { execFileSync } = require('child_process');

const dbPath = process.argv[2] || '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
    console.error(`FAIL: DB file does not exist: ${dbPath}`);
    process.exit(2);
}

function columns(table) {
    return execFileSync('sqlite3', [dbPath, `PRAGMA table_info(${table});`], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|')[1])
        .filter(Boolean);
}

function sqlite(input) {
    return execFileSync('sqlite3', [dbPath], { input, encoding: 'utf8' });
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
    ensureColumn('sync_outbox', 'rejected_at', 'TEXT');
    ensureColumn('sync_outbox', 'rejection_reason', 'TEXT');
    ensureColumn('sync_outbox', 'last_retryable_failure_at', 'TEXT');
    console.log('OK: sync_outbox v2 columns ensured');
} catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
}
