#!/usr/bin/env node
// Idempotent migration: WS2 sync_outbox v2 selective delivery columns.
// Usage: node scripts/migrate-sync-outbox.js [/data/db/farming.db]
// Safe to re-run.

const fs = require('fs');
const { createSqliteHelpers } = require('./sqlite-migration-helpers.js');

const dbPath = process.argv[2] || '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
    console.error(`FAIL: DB file does not exist: ${dbPath}`);
    process.exit(2);
}

const { ensureColumn } = createSqliteHelpers(dbPath);

try {
    ensureColumn('sync_outbox', 'rejected_at', 'TEXT');
    ensureColumn('sync_outbox', 'rejection_reason', 'TEXT');
    ensureColumn('sync_outbox', 'last_retryable_failure_at', 'TEXT');
    console.log('OK: sync_outbox v2 columns ensured');
} catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
}
