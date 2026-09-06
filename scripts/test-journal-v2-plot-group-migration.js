#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-v2-group-migration-'));
const db = path.join(directory, 'farming.db');
const v2Baseline = path.join(root, 'database/migrations/ordered/0043__journal_v2_replication.sql');
const v2Media = path.join(root, 'database/migrations/ordered/0044__journal_v2_media.sql');
const migration = path.join(root, 'database/migrations/ordered/0050__journal_v2_plot_group_snapshot.sql');

function apply(sqlPath) {
  execFileSync('sqlite3', ['-bail', db], {
    input: fs.readFileSync(sqlPath, 'utf8'),
    encoding: 'utf8',
  });
}

apply(v2Baseline);
apply(v2Media);
apply(migration);

const tableSql = execFileSync('sqlite3', [db,
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='journal_edge_mutations'"],
  { encoding: 'utf8' });
assert.match(tableSql, /PLOT_GROUP_SNAPSHOT/,
  '0050 must widen journal_edge_mutations without invalidating its dependent overlay view');
const replicationSql = execFileSync('sqlite3', [db,
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='journal_replication_applied'"],
  { encoding: 'utf8' });
assert.match(replicationSql, /PLOT_GROUP_SNAPSHOT/,
  '0050 must widen journal_replication_applied');
assert.equal(execFileSync('sqlite3', [db,
  "SELECT count(*) FROM sqlite_master WHERE type='view' AND name='journal_v2_pending_proposal_overlay'"],
  { encoding: 'utf8' }).trim(), '1', '0050 must restore the pending proposal overlay');
assert.equal(execFileSync('sqlite3', [db, 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim(), 'ok');
assert.equal(execFileSync('sqlite3', [db, 'PRAGMA foreign_key_check'], { encoding: 'utf8' }).trim(), '');

console.log('test-journal-v2-plot-group-migration: OK');
