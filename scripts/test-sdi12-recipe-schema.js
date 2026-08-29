#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const seedPath = path.join(repoRoot, 'database/seed-blank.sql');
const recipeColumns = [
  'deveui',
  'desired_version',
  'desired_layout_hash',
  'desired_recipe_json',
  'status',
  'queue_item_ids_json',
  'queued_at',
  'queue_drained_at',
  'commissioning_deadline_at',
  'observed_count',
  'failed_observation_count',
  'last_observed_at',
  'last_error_code',
  'compatible_recipe_json',
  'compatible_layout_json',
  'compatible_at',
  'updated_at',
];
const identifyColumns = [
  'deveui',
  'stage',
  'discovered_address',
  'requested_at',
  'updated_at',
];
const recipeStatuses = [
  'not_applied',
  'queueing',
  'queued',
  'observed_once',
  'observed_compatible',
  'degraded',
];
const identifyStages = ['discovering', 'identifying'];

function sqlite(dbPath, sql) {
  return execFileSync('sqlite3', ['-bail', dbPath], {
    encoding: 'utf8',
    input: `PRAGMA foreign_keys = ON;\n${sql}`,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function columns(dbPath, tableName) {
  const output = sqlite(dbPath, `PRAGMA table_info(${tableName});`);
  return output ? output.split('\n').map((line) => line.split('|')[1]) : [];
}

function tableExists(dbPath, tableName) {
  return sqlite(
    dbPath,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${tableName}';`,
  ) === tableName;
}

function normalizedTableSql(dbPath, tableName) {
  return sqlite(
    dbPath,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${tableName}';`,
  ).replace(/\s+/g, '').toLowerCase();
}

function assertSqlFails(dbPath, sql, message) {
  assert.throws(() => sqlite(dbPath, sql), /CHECK constraint failed/, message);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-recipe-schema-'));
const dbPath = path.join(tempDir, 'farming.db');

try {
  execFileSync('sqlite3', ['-bail', dbPath], {
    encoding: 'utf8',
    input: fs.readFileSync(seedPath, 'utf8'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  assert.equal(tableExists(dbPath, 'sdi12_recipe_deployments'), true, 'recipe deployment table is missing');
  assert.equal(tableExists(dbPath, 'sdi12_identify_attempts'), true, 'identify attempts table is missing');
  assert.deepEqual(columns(dbPath, 'sdi12_recipe_deployments'), recipeColumns);
  assert.deepEqual(columns(dbPath, 'sdi12_identify_attempts'), identifyColumns);
  assert.ok(
    normalizedTableSql(dbPath, 'sdi12_recipe_deployments').includes(
      "check(statusin('not_applied','queueing','queued','observed_once','observed_compatible','degraded'))",
    ),
    'recipe deployment status CHECK drifted from the commissioning state machine',
  );
  assert.ok(
    normalizedTableSql(dbPath, 'sdi12_identify_attempts').includes(
      "check(stagein('discovering','identifying'))",
    ),
    'identify attempt stage CHECK drifted from the two-stage operation',
  );

  sqlite(dbPath, `
    INSERT INTO devices (deveui, name, type_id, created_at, updated_at)
    VALUES ('0123456789ABCDEF', 'SDI-12 probe', 'DRAGINO_SDI12', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
    INSERT INTO sdi12_recipe_deployments (deveui, status, updated_at)
    VALUES ('0123456789ABCDEF', 'not_applied', '2026-08-29T00:00:00Z');
    INSERT INTO sdi12_identify_attempts (deveui, stage, requested_at, updated_at)
    VALUES ('0123456789ABCDEF', 'discovering', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
  `);

  for (const [index, status] of recipeStatuses.entries()) {
    const deveui = `0123456789ABCDE${index}`;
    sqlite(dbPath, `
      INSERT INTO devices (deveui, name, type_id, created_at, updated_at)
      VALUES ('${deveui}', 'SDI-12 probe', 'DRAGINO_SDI12', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
      INSERT INTO sdi12_recipe_deployments (deveui, status, updated_at)
      VALUES ('${deveui}', '${status}', '2026-08-29T00:00:00Z');
    `);
  }
  for (const [index, stage] of identifyStages.entries()) {
    const deveui = `1123456789ABCDE${index}`;
    sqlite(dbPath, `
      INSERT INTO devices (deveui, name, type_id, created_at, updated_at)
      VALUES ('${deveui}', 'SDI-12 probe', 'DRAGINO_SDI12', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
      INSERT INTO sdi12_identify_attempts (deveui, stage, requested_at, updated_at)
      VALUES ('${deveui}', '${stage}', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
    `);
  }

  assertSqlFails(
    dbPath,
    `
      INSERT INTO devices (deveui, name, type_id, created_at, updated_at)
      VALUES ('2123456789ABCDE0', 'SDI-12 probe', 'DRAGINO_SDI12', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
      INSERT INTO sdi12_recipe_deployments (deveui, status, updated_at)
      VALUES ('2123456789ABCDE0', 'invalid', '2026-08-29T00:00:00Z');
    `,
    'recipe deployment status must reject values outside the commissioning state machine',
  );
  assertSqlFails(
    dbPath,
    `
      INSERT INTO devices (deveui, name, type_id, created_at, updated_at)
      VALUES ('3123456789ABCDE0', 'SDI-12 probe', 'DRAGINO_SDI12', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
      INSERT INTO sdi12_identify_attempts (deveui, stage, requested_at, updated_at)
      VALUES ('3123456789ABCDE0', 'complete', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z');
    `,
    'identify attempt stage must reject values outside discovering and identifying',
  );

  const statusIndex = sqlite(
    dbPath,
    "SELECT group_concat(ii.name, ',') FROM pragma_index_list('sdi12_recipe_deployments') AS il JOIN pragma_index_info(il.name) AS ii WHERE il.name = 'idx_sdi12_recipe_deployments_status';",
  );
  assert.equal(statusIndex, 'status', 'status poller index is missing or indexed on the wrong column');

  sqlite(dbPath, "DELETE FROM devices WHERE deveui = '0123456789ABCDEF';");
  assert.equal(sqlite(dbPath, "SELECT count(*) FROM sdi12_recipe_deployments WHERE deveui = '0123456789ABCDEF';"), '0');
  assert.equal(sqlite(dbPath, "SELECT count(*) FROM sdi12_identify_attempts WHERE deveui = '0123456789ABCDEF';"), '0');

  console.log('test-sdi12-recipe-schema: OK');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
