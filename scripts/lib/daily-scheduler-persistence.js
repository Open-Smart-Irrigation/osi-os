'use strict';
// Execute schedule-save SQL against the real seed to retain NEW-9's first-save
// versus subsequent-edit outbox behavior. No gateway DB or native addon is used.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, execute } = require('./daily-scheduler-harness');
const { cases } = require('./daily-scheduler-cases');
async function persistence(nodes, profile) {
  const names = ['upsert-version-undefined-enabled-1', 'upsert-version-4-enabled-1', 'upsert-version-4-enabled-0'];
  const statements = [];
  for (const name of names) {
    const c = cases().find(c => c.name === name);
    const n = nodes.find(n => n.id === c.id);
    const output = await execute(n.func, c, profile);
    statements.push(output.result[0].topic + ';');
  }
  const snapshot = `SELECT json_object(
    'row', json((SELECT json_object('zone_id', irrigation_zone_id, 'trigger_metric', trigger_metric,
      'threshold_kpa', threshold_kpa, 'duration_minutes', duration_minutes, 'enabled', enabled,
      'response_mode', response_mode, 'sync_version', sync_version, 'deleted_at', deleted_at,
      'created_at', created_at, 'updated_at', updated_at) FROM irrigation_schedules WHERE irrigation_zone_id = 2)),
    'events', json((SELECT json_group_array(json_object('op', op, 'payload_json', payload_json,
      'sync_version', sync_version)) FROM sync_outbox WHERE aggregate_type = 'SCHEDULE'))
  );`;
  const setup = `
    INSERT INTO users (id, username, password_hash, user_uuid, created_at) VALUES (1, 'synthetic-owner', 'h', 'synthetic-owner', '2026-01-01');
    INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, gateway_device_eui) VALUES (2, 'Synthetic zone', 1, 'synthetic-zone', '0016C001F1000001');
    INSERT INTO sync_link_state (peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '0016C001F1000001', '2026-01-01');
    DELETE FROM sync_outbox;
  `;
  const sql = '.bail on\n' + fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8') + setup + statements.map(s => s + '\n' + snapshot).join('\n');
  return execFileSync('sqlite3', ['-batch', '-noheader', ':memory:'], { input: sql, encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));
}
module.exports = { persistence };
