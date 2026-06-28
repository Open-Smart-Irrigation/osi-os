#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(repoRoot, 'database', 'seed-blank.sql'), 'utf8');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sync-history-schema-'));
const dbPath = path.join(tmpDir, 'farming.db');

function sqlite(sql) {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function exec(sql) {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function columnNames(tableName) {
  const output = sqlite(`PRAGMA table_info(${tableName});`);
  if (!output) return [];
  return output.split('\n').map((line) => line.split('|')[1]).filter(Boolean);
}

function tableNamesWhere(whereClause) {
  const output = sqlite(`SELECT name FROM sqlite_master WHERE ${whereClause} ORDER BY name;`);
  return output ? output.split('\n') : [];
}

function scalar(sql) {
  const output = sqlite(sql);
  return output === '' ? 0 : Number(output);
}

try {
  exec(schema);

  const names = new Set(tableNamesWhere("type='table' AND (name LIKE 'sync_history_%' OR name='sync_link_state')"));
  for (const name of ['sync_link_state', 'sync_history_cursors', 'sync_history_dirty_keys', 'sync_history_segments', 'sync_history_quarantine']) {
    if (!names.has(name)) throw new Error(`missing ${name}`);
  }

  const irrigationColumns = columnNames('irrigation_events');
  if (!irrigationColumns.includes('event_uuid')) throw new Error('missing irrigation_events.event_uuid');

  const indexNames = new Set(tableNamesWhere("type='index' AND tbl_name='irrigation_events'"));
  if (!indexNames.has('idx_irrigation_events_event_uuid')) throw new Error('missing idx_irrigation_events_event_uuid');

  exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid) VALUES(1, 'local', 'x', '2026-06-28T10:00:00.000Z', 'user-1')");
  exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(1, 1, 'Zone 1', 'zone-1', '0016C001F11715E2', 1)");
  if (scalar('SELECT COUNT(*) FROM sync_outbox;') !== 0) {
    throw new Error('unlinked structural insert created outbox row');
  }

  exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES('cloud', 1, '0016C001F11715E2', '2026-06-28T10:00:00.000Z')");
  exec("UPDATE irrigation_zones SET name='Zone linked', sync_version=2 WHERE id=1");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='ZONE';") !== 1) {
    throw new Error('linked structural update did not create outbox row');
  }

  console.log('OK sync history schema');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
