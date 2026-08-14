'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const commands = require('./index.js');

const ROOT = path.resolve(__dirname, '../../../../../../../');
const GATEWAY = '0016C001F1000001';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ZONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function database() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  native.prepare(
    'INSERT INTO users(username,password_hash,created_at,user_uuid,role,sync_version) VALUES (?,?,?,?,?,?)'
  ).run('zone-owner', 'unused', '2026-08-13T00:00:00.000Z', OWNER, 'researcher', 1);
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
  const target = base + 1;
  return {
    commandId,
    commandType: 'UPSERT_ZONE',
    payload: {
      command_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc' + commandId,
      command_type: 'UPSERT_ZONE',
      effect_key: `zone:${ZONE}:${base}`,
      zone_uuid: ZONE,
      gateway_device_eui: GATEWAY,
      base_sync_version: base,
      target_sync_version: target,
      zone: {
        contract_version: 1,
        zone_uuid: ZONE,
        gateway_device_eui: GATEWAY,
        sync_version: target,
        deleted_at: null,
        name: 'North block',
        timezone: 'Europe/Zurich',
        latitude: null,
        longitude: null,
        phenological_stage: null,
        calibration_key: null,
        crop_type: 'barley',
        variety: null,
        soil_type: null,
        irrigation_method: null,
        area_m2: null,
        irrigation_efficiency_pct: null,
        scheduling_mode: 'local',
        prediction_card_enabled: 1,
        notes: null,
        user: { user_uuid: OWNER },
      },
    },
  };
}

test('applyZoneCommand applies a valid UPSERT_ZONE and persists its ACK', async () => {
  const db = database();
  try {
    const result = await commands.applyZoneCommand(db, envelope(1), {
      gateway_device_eui: GATEWAY,
    });
    assert.equal(result.handled, true);
    assert.equal(result.ack.result, 'APPLIED');
    assert.equal(db.native.prepare('SELECT sync_version FROM irrigation_zones WHERE zone_uuid=?').get(ZONE).sync_version, 1);
  } finally {
    db.native.close();
    commands._resetForTests();
  }
});

test('applyZoneCommand rejects a stale UPSERT_ZONE without changing the zone', async () => {
  const db = database();
  try {
    await commands.applyZoneCommand(db, envelope(1), { gateway_device_eui: GATEWAY });
    const result = await commands.applyZoneCommand(db, envelope(2), { gateway_device_eui: GATEWAY });
    assert.equal(result.ack.result, 'CONFLICT');
    assert.equal(db.native.prepare('SELECT sync_version FROM irrigation_zones WHERE zone_uuid=?').get(ZONE).sync_version, 1);
  } finally {
    db.native.close();
    commands._resetForTests();
  }
});
