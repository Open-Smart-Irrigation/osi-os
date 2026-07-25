#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const schemaMigration = fs.readFileSync(
  path.join(root, 'database/migrations/ordered/0041__installation_identity.sql'),
  'utf8'
);
const backfillMigration = fs.readFileSync(
  path.join(root, 'database/migrations/ordered/0042__installation_identity_backfill.sql'),
  'utf8'
);
const currentSeed = fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8');
const installationMigrationCommit = execFileSync(
  'git',
  ['log', '-1', '--format=%H', '--diff-filter=A', '--', 'database/migrations/ordered/0041__installation_identity.sql'],
  { cwd: root, encoding: 'utf8' }
).trim();
const preMigrationSeed = execFileSync(
  'git',
  ['show', `${installationMigrationCommit}^:database/seed-blank.sql`],
  { cwd: root, encoding: 'utf8' }
);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-installation-schema-'));

function apply(label, sqlParts) {
  const db = path.join(tmpDir, `${label}.db`);
  for (const sql of sqlParts) {
    execFileSync('sqlite3', [db], { input: sql, encoding: 'utf8' });
  }
  return db;
}

function scalar(db, sql) {
  return execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();
}

function assertSchema(db, label, expectsIdentity) {
  assert.equal(
    scalar(db, "SELECT COUNT(*) FROM installation_identity WHERE singleton_id=1"),
    expectsIdentity ? '1' : '0',
    `${label} singleton`
  );
  if (expectsIdentity) {
    assert.match(
      scalar(db, 'SELECT installation_uuid FROM installation_identity WHERE singleton_id=1'),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      `${label} UUID`
    );
    assert.equal(
      scalar(db, "SELECT recovery_state FROM installation_identity WHERE singleton_id=1"),
      'ACTIVE',
      `${label} initial recovery state`
    );
  }
  assert.equal(
    scalar(db, "SELECT COUNT(*) FROM pragma_table_info('sync_link_state') WHERE name='installation_uuid'"),
    '1',
    `${label} link column`
  );
  assert.equal(
    scalar(db, 'SELECT COUNT(*) FROM installation_recovery_audit'),
    '0',
    `${label} audit empty`
  );
}

try {
  const fresh = apply('fresh', [currentSeed]);
  assertSchema(fresh, 'fresh', false);

  const upgraded = apply('upgraded', [preMigrationSeed]);
  execFileSync('sqlite3', [upgraded, `
    INSERT INTO sync_link_state(
      peer_node, linked, gateway_device_eui, updated_at
    ) VALUES(
      'cloud', 1, '0016C001F11715E2', '2026-07-25T10:00:00.000Z'
    ) ON CONFLICT(peer_node) DO UPDATE SET
      linked=excluded.linked,
      gateway_device_eui=excluded.gateway_device_eui,
      updated_at=excluded.updated_at;
  `]);
  execFileSync('sqlite3', [upgraded], { input: schemaMigration, encoding: 'utf8' });
  execFileSync('sqlite3', [upgraded], { input: backfillMigration, encoding: 'utf8' });
  assertSchema(upgraded, 'upgrade', true);
  assert.equal(
    scalar(upgraded, 'SELECT current_gateway_device_eui FROM installation_identity WHERE singleton_id=1'),
    '0016C001F11715E2'
  );
  assert.equal(
    scalar(upgraded, "SELECT installation_uuid=(SELECT installation_uuid FROM installation_identity WHERE singleton_id=1) FROM sync_link_state WHERE peer_node='cloud'"),
    '1'
  );

  assert.throws(
    () => execFileSync('sqlite3', [upgraded, "UPDATE installation_identity SET recovery_state='ACTIVE', recovery_operation_uuid='operation-1' WHERE singleton_id=1"]),
    /CHECK constraint failed/
  );
  console.log('OK installation recovery schema');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
