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

try {
    execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
    console.log(`OK: applied ${path.basename(sqlPath)} to ${dbPath}`);

    const output = execFileSync('sqlite3', [dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='applied_commands';"
    ], { encoding: 'utf8' });
    if (!output.trim()) throw new Error('applied_commands table missing after migration');
    console.log('  ok applied_commands present');
} catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
}
