#!/usr/bin/env node
'use strict';
// Rehearsal for migrations 0022 (additive scoped-access schema) and
// 0023 (data backfill). Drives: tables/indexes/triggers exist, emit gate
// default-off, USER three-arm trigger emits non-null user_uuid, conditional
// bootstrap insert semantics, uuid backfill, in-place admin promotion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const MIG_0022 = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0022__scoped_access_schema.sql'), 'utf8');
const MIG_0023 = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0023__scoped_access_backfill.sql'), 'utf8');

const USERS_DDL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  auth_mode TEXT NOT NULL DEFAULT 'local',
  user_uuid TEXT,
  cloud_user_id INTEGER
);`;
const UUID_TRIGGER = `CREATE TRIGGER trg_sync_users_uuid_ai
AFTER INSERT ON users FOR EACH ROW
WHEN NEW.user_uuid IS NULL OR NEW.user_uuid = ''
BEGIN
  UPDATE users SET user_uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;`;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(USERS_DDL);
  db.exec(UUID_TRIGGER);
  db.exec(`CREATE TABLE sync_outbox (event_uuid TEXT PRIMARY KEY, aggregate_type TEXT, aggregate_key TEXT,
    op TEXT, payload_json TEXT, sync_version INTEGER, occurred_at TEXT, gateway_device_eui TEXT)`);
  db.exec(`CREATE TABLE sync_link_state (peer_node TEXT, gateway_device_eui TEXT)`);
  db.exec(MIG_0022);
  return db;
}
const objs = (db, type) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name LIKE ? ORDER BY name`).all(type, '%').map(r => r.name);

test('0022 creates assignment tables, indexes, gate table, 7 triggers', () => {
  const db = freshDb();
  const tables = objs(db, 'table');
  for (const t of ['user_zone_assignments', 'user_plot_assignments', 'scoped_access_emit'])
    assert.ok(tables.includes(t), `missing table ${t}`);
  const indexes = objs(db, 'index');
  for (const i of ['uq_user_zone_active', 'idx_user_zone_by_zone', 'uq_user_plot_active', 'idx_user_plot_by_plot'])
    assert.ok(indexes.includes(i), `missing index ${i}`);
  const triggers = objs(db, 'trigger');
  for (const tr of [
    'trg_dp_user_zone_assign_outbox_ai', 'trg_dp_user_zone_assign_outbox_au',
    'trg_dp_user_plot_assign_outbox_ai', 'trg_dp_user_plot_assign_outbox_au',
    'trg_dp_users_outbox_uuid_au', 'trg_dp_users_outbox_ai', 'trg_dp_users_outbox_role_au',
  ]) assert.ok(triggers.includes(tr), `missing trigger ${tr}`);
  assert.equal(db.prepare('SELECT enabled FROM scoped_access_emit WHERE id=1').get().enabled, 0);
  db.close();
});

test('emit gate default off: no outbox rows until enabled', () => {
  const db = freshDb();
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('a','h','2026-01-01')`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get().n, 0);
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('b','h','2026-01-01')`);
  const rows = db.prepare(`SELECT * FROM sync_outbox WHERE op='USER_UPSERTED'`).all();
  assert.equal(rows.length, 1);
  db.close();
});

test('USER trigger arms: uuid assigned by sibling trigger still emits non-null uuid', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  // Path 1: null uuid at insert -> uuid trigger fills -> uuid_au arm must emit non-null.
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('carol','h','2026-01-01')`);
  const p1 = JSON.parse(db.prepare(`SELECT payload_json FROM sync_outbox WHERE op='USER_UPSERTED'`).get().payload_json);
  assert.ok(p1.user_uuid && p1.user_uuid.length === 32, `null/short uuid in payload: ${p1.user_uuid}`);
  // Path 2: uuid supplied at insert -> ai arm fires exactly once more.
  db.exec(`INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('dave','h','2026-01-01', lower(hex(randomblob(16))))`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_UPSERTED'`).get().n, 2);
  // Path 3: role mutation -> role_au arm fires.
  db.exec(`UPDATE users SET role='admin' WHERE username='carol'`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_UPSERTED'`).get().n, 3);
  // Guard regression: role mutation on a NULL-uuid row must NOT emit.
  db.exec(`UPDATE users SET user_uuid=NULL WHERE username='dave'`);
  db.exec(`UPDATE users SET role='viewer' WHERE username='dave'`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_UPSERTED'`).get().n, 3);
  db.close();
});

test('USER trigger arms emit users.sync_version, not literal 0 (issue #10 boot-ddl gate)', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  // (a) insert path: a fresh row's sync_version (0) must appear in both the
  // outbox column and the payload json, not be silently dropped.
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('erin','h','2026-01-01')`);
  const insertRow = db.prepare(
    `SELECT sync_version, payload_json FROM sync_outbox WHERE op='USER_UPSERTED' ORDER BY rowid`
  ).get();
  assert.equal(insertRow.sync_version, 0, 'outbox column must carry the row sync_version, not a disconnected literal');
  assert.equal(JSON.parse(insertRow.payload_json).sync_version, 0, 'payload must carry sync_version');
  // (b) writer-bumped update: the same UPDATE statement that changes role
  // also bumps sync_version (spec §11 writer-bumped contract); the trigger
  // must emit that bumped value, in both places, not literal 0.
  db.exec(`UPDATE users SET role='admin', sync_version = COALESCE(sync_version,0)+1 WHERE username='erin'`);
  const rows = db.prepare(
    `SELECT sync_version, payload_json FROM sync_outbox WHERE op='USER_UPSERTED' ORDER BY rowid`
  ).all();
  assert.equal(rows.length, 2, 'role update must emit exactly one more USER_UPSERTED event');
  const bumped = rows[1];
  assert.equal(bumped.sync_version, 1, 'outbox column must carry the bumped sync_version');
  assert.equal(JSON.parse(bumped.payload_json).sync_version, 1, 'payload must carry the bumped sync_version');
  db.close();
});

test('assignment triggers emit upsert on grant and delete on tombstone', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  db.exec(`INSERT INTO user_zone_assignments (assignment_uuid, user_uuid, zone_uuid, created_at)
           VALUES ('as1','u1','z1','2026-01-01')`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_ZONE_ASSIGNMENT_UPSERTED'`).get().n, 1);
  db.exec(`UPDATE user_zone_assignments SET deleted_at='2026-01-02', sync_version=sync_version+1 WHERE assignment_uuid='as1'`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_ZONE_ASSIGNMENT_DELETED'`).get().n, 1);
  db.exec(`INSERT INTO user_plot_assignments (assignment_uuid, user_uuid, plot_uuid, created_at)
           VALUES ('ap1','u1','p1','2026-01-01')`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_PLOT_ASSIGNMENT_UPSERTED'`).get().n, 1);
  db.exec(`UPDATE user_plot_assignments SET deleted_at='2026-01-02', sync_version=sync_version+1 WHERE assignment_uuid='ap1'`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_PLOT_ASSIGNMENT_DELETED'`).get().n, 1);
  db.close();
});

test('0023 backfills null user_uuid and promotes lowest-id admin; no-op on empty users', () => {
  const db = freshDb();
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('legacy1','h','2026-01-01')`);
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('legacy2','h','2026-01-01')`);
  db.exec(`UPDATE users SET user_uuid=NULL`); // simulate pre-trigger-era rows
  db.exec(MIG_0023);
  const nulls = db.prepare(`SELECT COUNT(*) n FROM users WHERE user_uuid IS NULL OR user_uuid=''`).get().n;
  assert.equal(nulls, 0);
  const admins = db.prepare(`SELECT username FROM users WHERE role='admin'`).all().map(r => r.username);
  assert.deepEqual(admins, ['legacy1']); // lowest id promoted when no input
  const db2 = freshDb();
  db2.exec(MIG_0023);
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM users').get().n, 0); // fresh image: no crash, no rows
  db.close(); db2.close();
});

test('conditional bootstrap insert: exactly one admin, loser gets zero rows', () => {
  const db = freshDb();
  const BOOT = `INSERT INTO users (username, password_hash, created_at, role)
    SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`;
  db.prepare(BOOT).run('first', 'h', '2026-01-01');
  db.prepare(BOOT).run('second', 'h', '2026-01-01'); // loses: admin now exists
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE role='admin'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE username='second'`).get().n, 0);
  // A disabled admin still blocks bootstrap (spec §10: any-state count).
  db.exec(`UPDATE users SET disabled_at='2026-01-02' WHERE role='admin'`);
  db.prepare(BOOT).run('third', 'h', '2026-01-01');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE username='third'`).get().n, 0);
  db.close();
});
