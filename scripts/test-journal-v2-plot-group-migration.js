#!/usr/bin/env node
'use strict';
// 0069 rebuilds journal_edge_mutations and journal_replication_applied to widen
// their closed operation/kind CHECK lists with PLOT_GROUP_SNAPSHOT. The rebuild
// must keep every queued and replayed row, restore the dependent overlay view
// and attachment triggers, and add the plot-group snapshot table.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ordered = path.join(root, 'database/migrations/ordered');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-v2-group-migration-'));
const db = path.join(directory, 'farming.db');

function sql(text) {
  return execFileSync('sqlite3', ['-bail', db], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function query(text) {
  return execFileSync('sqlite3', ['-json', db, text], { encoding: 'utf8' }).trim();
}
function apply(name) {
  sql(fs.readFileSync(path.join(ordered, name), 'utf8'));
}

apply('0042__journal_v2_replication.sql');
apply('0043__journal_v2_media.sql');

const hash = 'a'.repeat(64);
sql(`
INSERT INTO journal_edge_mutations(mutation_uuid,workspace_uuid,operation,resource_uuid,base_version,
  payload_json,payload_sha256,status,attempts,recorded_at,created_at,updated_at)
VALUES
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','ENTRY_CREATE',
   '30000000-0000-4000-8000-000000000001',0,'{"a":1}','${hash}','pending',0,
   '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),
  ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','PLOT_SNAPSHOT',
   '60000000-0000-4000-8000-000000000001',2,'{"b":2}','${hash}','applied',1,
   '2026-09-01T00:01:00.000Z','2026-09-01T00:01:00.000Z','2026-09-01T00:02:00.000Z');
INSERT INTO journal_replication_applied(workspace_uuid,sequence,kind,payload_sha256,recorded_at,applied_at)
VALUES ('20000000-0000-4000-8000-000000000001','1','PLOT_SNAPSHOT','${hash}',
        '2026-09-01T00:00:00.000Z','2026-09-01T00:00:01.000Z');
`);
const mutationsBefore = query('SELECT * FROM journal_edge_mutations ORDER BY mutation_uuid');
const appliedBefore = query('SELECT * FROM journal_replication_applied ORDER BY workspace_uuid, sequence');

apply('0069__journal_v2_plot_group_snapshot.sql');

assert.equal(query('SELECT * FROM journal_edge_mutations ORDER BY mutation_uuid'), mutationsBefore,
  '0069 must copy every queued mutation unchanged');
assert.equal(query('SELECT * FROM journal_replication_applied ORDER BY workspace_uuid, sequence'), appliedBefore,
  '0069 must copy every replay record unchanged');

assert.match(query("SELECT sql FROM sqlite_master WHERE type='table' AND name='journal_edge_mutations'"),
  /PLOT_GROUP_SNAPSHOT/, '0069 must widen journal_edge_mutations');
assert.match(query("SELECT sql FROM sqlite_master WHERE type='table' AND name='journal_replication_applied'"),
  /PLOT_GROUP_SNAPSHOT/, '0069 must widen journal_replication_applied');
assert.equal(query("SELECT name FROM sqlite_master WHERE name LIKE '%\\_next' ESCAPE '\\'"), '',
  '0069 must not leave a rebuild table behind');
assert.equal(JSON.parse(query(`SELECT count(*) AS n FROM sqlite_master WHERE
  (type='view' AND name='journal_v2_pending_proposal_overlay') OR
  (type='trigger' AND name IN ('trg_journal_attachment_edge_parent_bi','trg_journal_attachment_edge_parent_bu')) OR
  (type='index' AND name IN ('idx_journal_edge_mutations_pending','idx_journal_edge_mutations_workspace_resource')) OR
  (type='table' AND name='journal_v2_plot_group_snapshots')`))[0].n, 6,
  '0069 must restore the overlay view, attachment triggers and indexes, and add the snapshot table');

// The overlay view still reads the rebuilt table.
assert.equal(JSON.parse(query('SELECT count(*) AS n FROM journal_v2_pending_proposal_overlay'))[0].n, 1);

// The widened CHECKs accept the new operation and kind; unknown values stay rejected.
sql(`
INSERT INTO journal_edge_mutations(mutation_uuid,workspace_uuid,operation,resource_uuid,base_version,
  payload_json,payload_sha256,recorded_at,created_at,updated_at)
VALUES ('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','PLOT_GROUP_SNAPSHOT',
  '62000000-0000-4000-8000-000000000001',0,'{}','${hash}',
  '2026-09-01T00:03:00.000Z','2026-09-01T00:03:00.000Z','2026-09-01T00:03:00.000Z');
INSERT INTO journal_replication_applied(workspace_uuid,sequence,kind,payload_sha256,recorded_at,applied_at)
VALUES ('20000000-0000-4000-8000-000000000001','2','PLOT_GROUP_SNAPSHOT','${hash}',
        '2026-09-01T00:03:00.000Z','2026-09-01T00:03:01.000Z');
`);
assert.throws(() => sql(`INSERT INTO journal_replication_applied(workspace_uuid,sequence,kind,payload_sha256,recorded_at,applied_at)
  VALUES ('20000000-0000-4000-8000-000000000001','3','UNKNOWN_KIND','${hash}','x','x');`), /CHECK constraint failed/);

assert.equal(execFileSync('sqlite3', [db, 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim(), 'ok');
assert.equal(execFileSync('sqlite3', [db, 'PRAGMA foreign_key_check'], { encoding: 'utf8' }).trim(), '');

console.log('test-journal-v2-plot-group-migration: OK');
