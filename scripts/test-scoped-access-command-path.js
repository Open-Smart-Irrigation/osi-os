#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/bcryptjs'
);
const commands = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scoped-access-commands'
);

const GATEWAY = '10AA10AA10AA10AD';
const ADMIN_UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USER_UUID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ZONE_UUID = 'cccccccccccccccccccccccccccccccc';
const ASSIGNMENT_UUID = 'dddddddddddddddddddddddddddddddd';

function txFacade(db) {
  return {
    run(sql, params = []) {
      db.prepare(sql).run(...params);
      return Promise.resolve();
    },
    get(sql, params = []) {
      return Promise.resolve(db.prepare(sql).get(...params));
    },
    all(sql, params = []) {
      return Promise.resolve(db.prepare(sql).all(...params));
    },
  };
}

function database() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      user_uuid TEXT UNIQUE,
      edge_originated INTEGER DEFAULT 0,
      role TEXT NOT NULL,
      disabled_at TEXT,
      sync_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE user_zone_assignments (
      assignment_uuid TEXT PRIMARY KEY,
      user_uuid TEXT NOT NULL,
      zone_uuid TEXT NOT NULL,
      assigned_by_user_uuid TEXT,
      gateway_device_eui TEXT,
      sync_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE user_plot_assignments (
      assignment_uuid TEXT PRIMARY KEY,
      user_uuid TEXT NOT NULL,
      plot_uuid TEXT NOT NULL,
      assigned_by_user_uuid TEXT,
      gateway_device_eui TEXT,
      sync_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE applied_commands (
      command_id TEXT PRIMARY KEY,
      device_eui TEXT NOT NULL,
      command_type TEXT NOT NULL,
      effect_key TEXT,
      applied_at TEXT NOT NULL,
      result TEXT NOT NULL,
      result_detail TEXT,
      originator TEXT
    );
    CREATE TABLE command_ack_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  const facade = {
    transaction: async function(executor) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await executor(txFacade(raw));
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { raw, facade };
}

function seedAdmin(raw, role = 'admin') {
  raw.prepare(
    'INSERT INTO users(username,password_hash,created_at,user_uuid,role,sync_version) ' +
    'VALUES (?,?,?,?,?,1)'
  ).run('admin', bcrypt.hashSync('admin-secret', 4), new Date().toISOString(), ADMIN_UUID, role);
}

function envelope(commandId, type, effectKey, payload) {
  return {
    commandId,
    commandType: type,
    effectKey,
    payload: Object.assign({
      command_id: '11111111-1111-4111-8111-' + String(commandId).padStart(12, '0'),
      command_type: type,
      effect_key: effectKey,
    }, payload),
  };
}

function runtime(scopeInvalidations = []) {
  return {
    gateway_device_eui: GATEWAY,
    command_type_recognized: true,
    scope_helper: {
      invalidateScope(value) {
        scopeInvalidations.push(value == null ? 'all' : value);
      },
    },
  };
}

function userCommand(commandId, base, overrides = {}) {
  const effectKey = `scoped_user:${USER_UUID}:${base}`;
  return envelope(commandId, 'UPSERT_SCOPED_USER', effectKey, {
    user: Object.assign({
      user_uuid: USER_UUID,
      username: 'viewer',
      role: 'viewer',
      disabled_at: null,
      sync_version: base + 1,
      gateway_device_eui: GATEWAY,
      base_sync_version: base,
      password_hash: bcrypt.hashSync('temporary-secret', 4),
    }, overrides),
  });
}

test('scoped user apply is atomic, replayable, and invalidates the scope cache', async () => {
  commands._resetForTests();
  const db = database();
  const invalidations = [];
  try {
    seedAdmin(db.raw);
    const first = await commands.applyScopedAccessCommand(
      db.facade, userCommand(1, 0), runtime(invalidations)
    );
    assert.equal(first.ack.result, 'APPLIED');
    assert.equal(first.ack.appliedSyncVersion, 1);
    assert.equal(db.raw.prepare('SELECT role FROM users WHERE user_uuid=?').get(USER_UUID).role, 'viewer');
    assert.deepEqual(invalidations, ['all']);

    const replay = await commands.applyScopedAccessCommand(
      db.facade, userCommand(1, 0), runtime(invalidations)
    );
    assert.deepEqual(replay.ack, first.ack);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE user_uuid=?').get(USER_UUID).n, 1);
  } finally {
    db.raw.close();
  }
});

test('stale base and last-admin mutation return terminal conflicts without changing rows', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedAdmin(db.raw);
    const stale = await commands.applyScopedAccessCommand(
      db.facade, userCommand(2, 4), runtime()
    );
    assert.equal(stale.ack.result, 'CONFLICT');
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE user_uuid=?').get(USER_UUID).n, 0);

    const effectKey = `scoped_user:${ADMIN_UUID}:1`;
    const demote = envelope(3, 'UPSERT_SCOPED_USER', effectKey, {
      user: {
        user_uuid: ADMIN_UUID,
        username: 'admin',
        role: 'viewer',
        disabled_at: null,
        sync_version: 2,
        gateway_device_eui: GATEWAY,
        base_sync_version: 1,
      },
    });
    const protectedResult = await commands.applyScopedAccessCommand(
      db.facade, demote, runtime()
    );
    assert.equal(protectedResult.ack.result, 'REJECTED_PERMANENT');
    assert.equal(db.raw.prepare('SELECT role FROM users WHERE user_uuid=?').get(ADMIN_UUID).role, 'admin');
  } finally {
    db.raw.close();
  }
});

test('grant lifecycle applies and tombstones with exact version checks', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedAdmin(db.raw);
    db.raw.prepare(
      'INSERT INTO users(username,password_hash,created_at,user_uuid,role,sync_version) ' +
      'VALUES (?,?,?,?,?,1)'
    ).run('researcher', bcrypt.hashSync('secret', 4), new Date().toISOString(), USER_UUID, 'researcher');

    const upsertEffect = `scoped_zone_assignment:${ASSIGNMENT_UUID}:0`;
    const upsert = envelope(4, 'UPSERT_USER_ZONE_ASSIGNMENT', upsertEffect, {
      zone_assignment: {
        assignment_uuid: ASSIGNMENT_UUID,
        user_uuid: USER_UUID,
        zone_uuid: ZONE_UUID,
        assigned_by_user_uuid: ADMIN_UUID,
        sync_version: 1,
        deleted_at: null,
        gateway_device_eui: GATEWAY,
        base_sync_version: 0,
      },
    });
    assert.equal(
      (await commands.applyScopedAccessCommand(db.facade, upsert, runtime())).ack.result,
      'APPLIED'
    );

    const deleteEffect = `scoped_zone_assignment:${ASSIGNMENT_UUID}:1`;
    const remove = envelope(5, 'DELETE_USER_ZONE_ASSIGNMENT', deleteEffect, {
      assignment_uuid: ASSIGNMENT_UUID,
      base_sync_version: 1,
    });
    const removed = await commands.applyScopedAccessCommand(db.facade, remove, runtime());
    assert.equal(removed.ack.result, 'APPLIED');
    assert.ok(db.raw.prepare(
      'SELECT deleted_at FROM user_zone_assignments WHERE assignment_uuid=?'
    ).get(ASSIGNMENT_UUID).deleted_at);
  } finally {
    db.raw.close();
  }
});

test('credential ACK and ledger result never contain the password hash', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedAdmin(db.raw);
    const hash = bcrypt.hashSync('replacement-secret', 4);
    const effectKey = `scoped_user_password:${ADMIN_UUID}:1`;
    const reset = envelope(6, 'RESET_SCOPED_USER_PASSWORD', effectKey, {
      user_uuid: ADMIN_UUID,
      base_sync_version: 1,
      password_hash: hash,
    });
    const result = await commands.applyScopedAccessCommand(db.facade, reset, runtime());
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(result.ack.appliedSyncVersion, 2);
    const ledger = db.raw.prepare(
      'SELECT result_detail FROM applied_commands WHERE command_id=?'
    ).get('6').result_detail;
    assert.equal(ledger.includes(hash), false);
    assert.equal(JSON.stringify(result.ack).includes(hash), false);
  } finally {
    db.raw.close();
  }
});

test('malformed effect binding fails closed before mutation', async () => {
  const db = database();
  try {
    seedAdmin(db.raw);
    const malformed = userCommand(7, 0);
    malformed.payload.effect_key = 'scoped_user:wrong:0';
    await assert.rejects(
      commands.applyScopedAccessCommand(db.facade, malformed, runtime()),
      /effect_key/
    );
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  } finally {
    db.raw.close();
  }
});
