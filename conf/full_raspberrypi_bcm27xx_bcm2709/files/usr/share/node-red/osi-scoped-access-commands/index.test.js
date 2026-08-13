'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const commands = require('./index.js');

const ROOT = path.resolve(__dirname, '../../../../../../../');
const GATEWAY = '0016C001F1000001';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BCRYPT = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function database() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  return {
    native,
    get(sql, params) { return Promise.resolve(native.prepare(sql).get(...(params || []))); },
    run(sql, params) { return Promise.resolve(native.prepare(sql).run(...(params || []))); },
    async transaction(work) {
      native.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(this);
        native.exec('COMMIT');
        return result;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function envelope(commandId, base = 0) {
  return {
    commandId,
    commandType: 'UPSERT_SCOPED_USER',
    payload: {
      command_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb' + commandId,
      command_type: 'UPSERT_SCOPED_USER',
      effect_key: `scoped_user:${USER}:${base}`,
      user: {
        user_uuid: USER,
        gateway_device_eui: GATEWAY,
        username: 'field-user',
        role: 'researcher',
        disabled_at: null,
        base_sync_version: base,
        password_hash: BCRYPT,
      },
    },
  };
}

test('applyScopedAccessCommand applies a valid UPSERT_SCOPED_USER and persists its ACK', async () => {
  const db = database();
  try {
    const result = await commands.applyScopedAccessCommand(db, envelope(1), {
      gateway_device_eui: GATEWAY,
    });
    assert.equal(result.handled, true);
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(db.native.prepare('SELECT user_uuid FROM users WHERE user_uuid=?').get(USER).user_uuid, USER);
    assert.equal(db.native.prepare('SELECT sync_version FROM users WHERE user_uuid=?').get(USER).sync_version, 1);
  } finally {
    db.native.close();
    commands._resetForTests();
  }
});

test('applyScopedAccessCommand rejects a stale UPSERT_SCOPED_USER without changing the user', async () => {
  const db = database();
  try {
    await commands.applyScopedAccessCommand(db, envelope(1), { gateway_device_eui: GATEWAY });
    const result = await commands.applyScopedAccessCommand(db, envelope(2), { gateway_device_eui: GATEWAY });
    assert.equal(result.ack.result, 'CONFLICT');
    assert.equal(db.native.prepare('SELECT sync_version FROM users WHERE user_uuid=?').get(USER).sync_version, 1);
  } finally {
    db.native.close();
    commands._resetForTests();
  }
});
