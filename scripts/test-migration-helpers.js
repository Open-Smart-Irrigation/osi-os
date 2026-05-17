#!/usr/bin/env node
// Regression tests for idempotent SQLite migration helpers.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSqliteHelpers } = require('./sqlite-migration-helpers.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-migration-helper-'));
const dbPath = path.join(tmpDir, 'test.db');

try {
    execFileSync('sqlite3', [dbPath, 'CREATE TABLE sync_outbox(id INTEGER PRIMARY KEY);']);
    const helpers = createSqliteHelpers(dbPath);

    helpers.ensureColumn('sync_outbox', 'rejected_at', 'TEXT');
    helpers.ensureColumn('sync_outbox', 'rejected_at', 'TEXT');
    assert.deepStrictEqual(helpers.columns('sync_outbox'), ['id', 'rejected_at']);

    assert.throws(
        () => helpers.columns('sync_outbox;DROP_TABLE'),
        /Invalid table name/
    );
    assert.throws(
        () => helpers.ensureColumn('sync_outbox', 'bad-name', 'TEXT'),
        /Invalid column name/
    );
    assert.throws(
        () => helpers.ensureColumn('sync_outbox', 'bad_definition', 'TEXT; DROP TABLE sync_outbox'),
        /Invalid column definition/
    );

    console.log('PASS: migration helper checks pass');
} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}
