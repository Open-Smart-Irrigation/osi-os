#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

function readUniqueMigration(suffix) {
  const dir = path.join(ROOT, 'database/migrations/ordered');
  const matches = fs.readdirSync(dir).filter((name) => name.endsWith(suffix));
  assert.equal(matches.length, 1, `expected one migration ending ${suffix}`);
  return fs.readFileSync(path.join(dir, matches[0]), 'utf8');
}

const MIG_SCHEMA = readUniqueMigration('__scoped_access_schema.sql');
const MIG_BACKFILL = readUniqueMigration('__scoped_access_backfill.sql');

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
  db.exec(`CREATE TABLE sync_outbox (
    event_uuid TEXT PRIMARY KEY,
    aggregate_type TEXT,
    aggregate_key TEXT,
    op TEXT,
    payload_json TEXT,
    sync_version INTEGER,
    occurred_at TEXT,
    gateway_device_eui TEXT
  )`);
  db.exec('CREATE TABLE sync_link_state (peer_node TEXT, gateway_device_eui TEXT)');
  db.exec(MIG_SCHEMA);
  return db;
}

const objectNames = (db, type) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE '%' ORDER BY name")
    .all(type)
    .map((row) => row.name);

test('schema migration creates assignment tables, indexes, gate table, and seven triggers', () => {
  const db = freshDb();
  const tables = objectNames(db, 'table');
  for (const table of ['user_zone_assignments', 'user_plot_assignments', 'scoped_access_emit']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  const indexes = objectNames(db, 'index');
  for (const index of [
    'uq_user_zone_active',
    'idx_user_zone_by_zone',
    'uq_user_plot_active',
    'idx_user_plot_by_plot',
  ]) {
    assert.ok(indexes.includes(index), `missing index ${index}`);
  }
  const triggers = objectNames(db, 'trigger');
  for (const trigger of [
    'trg_dp_user_zone_assign_outbox_ai',
    'trg_dp_user_zone_assign_outbox_au',
    'trg_dp_user_plot_assign_outbox_ai',
    'trg_dp_user_plot_assign_outbox_au',
    'trg_dp_users_outbox_uuid_au',
    'trg_dp_users_outbox_ai',
    'trg_dp_users_outbox_role_au',
  ]) {
    assert.ok(triggers.includes(trigger), `missing trigger ${trigger}`);
  }
  assert.equal(db.prepare('SELECT enabled FROM scoped_access_emit WHERE id = 1').get().enabled, 0);
  db.close();
});

test('emit gate defaults off and suppresses producers until enabled', () => {
  const db = freshDb();
  db.exec("INSERT INTO users (username, password_hash, created_at) VALUES ('a', 'h', '2026-01-01')");
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sync_outbox').get().count, 0);
  db.exec('UPDATE scoped_access_emit SET enabled = 1 WHERE id = 1');
  db.exec("INSERT INTO users (username, password_hash, created_at) VALUES ('b', 'h', '2026-01-01')");
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sync_outbox WHERE op = 'USER_UPSERTED'").get().count,
    1
  );
  db.close();
});

test('USER trigger arms emit a non-null UUID and reject null-UUID role emission', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled = 1 WHERE id = 1');
  db.exec("INSERT INTO users (username, password_hash, created_at) VALUES ('carol', 'h', '2026-01-01')");
  const first = JSON.parse(
    db.prepare("SELECT payload_json FROM sync_outbox WHERE op = 'USER_UPSERTED'").get().payload_json
  );
  assert.equal(first.user_uuid.length, 32);
  db.exec(`INSERT INTO users (username, password_hash, created_at, user_uuid)
           VALUES ('dave', 'h', '2026-01-01', lower(hex(randomblob(16))))`);
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sync_outbox WHERE op = 'USER_UPSERTED'").get().count,
    2
  );
  db.exec("UPDATE users SET role = 'admin', sync_version = sync_version + 1 WHERE username = 'carol'");
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sync_outbox WHERE op = 'USER_UPSERTED'").get().count,
    3
  );
  db.exec("UPDATE users SET user_uuid = NULL WHERE username = 'dave'");
  db.exec("UPDATE users SET role = 'viewer', sync_version = sync_version + 1 WHERE username = 'dave'");
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sync_outbox WHERE op = 'USER_UPSERTED'").get().count,
    3
  );
  db.close();
});

test('USER events carry positive versions that increase on successive mutations', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled = 1 WHERE id = 1');
  db.exec("INSERT INTO users (username, password_hash, created_at) VALUES ('erin', 'h', '2026-01-01')");
  db.exec("UPDATE users SET role = 'admin', sync_version = sync_version + 1 WHERE username = 'erin'");
  db.exec(`UPDATE users
              SET username = 'erin-renamed', sync_version = sync_version + 1
            WHERE username = 'erin'`);
  const rows = db.prepare(
    `SELECT sync_version, json_extract(payload_json, '$.sync_version') payload_version
       FROM sync_outbox
      WHERE op = 'USER_UPSERTED'
      ORDER BY rowid`
  ).all();
  assert.deepEqual(rows.map((row) => row.sync_version), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.payload_version), [1, 2, 3]);
  db.close();
});

test('USER UUID arm emits only for first assignment', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled = 1 WHERE id = 1');
  db.exec("INSERT INTO users (username, password_hash, created_at) VALUES ('frank', 'h', '2026-01-01')");
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sync_outbox WHERE op = 'USER_UPSERTED'").get().count,
    1
  );
  db.exec("UPDATE users SET user_uuid = user_uuid WHERE username = 'frank'");
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sync_outbox WHERE op = 'USER_UPSERTED'").get().count,
    1
  );
  db.close();
});

test('assignment triggers emit upsert and tombstone events for zones and plots', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled = 1 WHERE id = 1');
  db.exec(`INSERT INTO user_zone_assignments
             (assignment_uuid, user_uuid, zone_uuid, sync_version, created_at)
           VALUES ('az1', 'u1', 'z1', 1, '2026-01-01')`);
  db.exec(`UPDATE user_zone_assignments
              SET deleted_at = '2026-01-02', sync_version = sync_version + 1
            WHERE assignment_uuid = 'az1'`);
  db.exec(`INSERT INTO user_plot_assignments
             (assignment_uuid, user_uuid, plot_uuid, sync_version, created_at)
           VALUES ('ap1', 'u1', 'p1', 1, '2026-01-01')`);
  db.exec(`UPDATE user_plot_assignments
              SET deleted_at = '2026-01-02', sync_version = sync_version + 1
            WHERE assignment_uuid = 'ap1'`);
  for (const operation of [
    'USER_ZONE_ASSIGNMENT_UPSERTED',
    'USER_ZONE_ASSIGNMENT_DELETED',
    'USER_PLOT_ASSIGNMENT_UPSERTED',
    'USER_PLOT_ASSIGNMENT_DELETED',
  ]) {
    assert.equal(
      db.prepare('SELECT COUNT(*) count FROM sync_outbox WHERE op = ?').get(operation).count,
      1,
      operation
    );
  }
  db.close();
});

test('backfill fills UUID and positive version and promotes the lowest active user', () => {
  const db = freshDb();
  db.exec("INSERT INTO users (username, password_hash, created_at) VALUES ('legacy1', 'h', '2026-01-01')");
  db.exec("INSERT INTO users (username, password_hash, created_at) VALUES ('legacy2', 'h', '2026-01-01')");
  db.exec('UPDATE users SET user_uuid = NULL, sync_version = 0');
  db.exec(MIG_BACKFILL);
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM users WHERE user_uuid IS NULL OR user_uuid = ''").get().count,
    0
  );
  assert.equal(db.prepare('SELECT MIN(sync_version) version FROM users').get().version, 1);
  assert.deepEqual(
    db.prepare("SELECT username FROM users WHERE role = 'admin'").all().map((row) => row.username),
    ['legacy1']
  );
  const empty = freshDb();
  empty.exec(MIG_BACKFILL);
  assert.equal(empty.prepare('SELECT COUNT(*) count FROM users').get().count, 0);
  db.close();
  empty.close();
});

test('conditional bootstrap insert creates exactly one admin', () => {
  const db = freshDb();
  const insert = db.prepare(`INSERT INTO users (username, password_hash, created_at, role)
    SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`);
  insert.run('first', 'h', '2026-01-01');
  insert.run('second', 'h', '2026-01-01');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM users WHERE role = 'admin'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM users WHERE username = 'second'").get().count, 0);
  db.exec(`UPDATE users
              SET disabled_at = '2026-01-02', sync_version = sync_version + 1
            WHERE role = 'admin'`);
  insert.run('third', 'h', '2026-01-01');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM users WHERE username = 'third'").get().count, 0);
  db.close();
});
