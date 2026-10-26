'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cliRunner } = require('../../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../../lib/osi-migrate');
const {
  generate, apply, verify, TABLES, INDEXES, TRIGGERS, ARTIFACT_PATH,
} = require('./generate-uganda-catchup-20260911');

const REPO = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-catchup-test-'));
  return path.join(dir, 'test.db');
}

test('verify library leaves process exit state to caller; CLI maps results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uganda-catchup-exit-'));
  const missing = path.join(dir, 'missing.db');
  const complete = path.join(dir, 'complete.db');
  const script = path.join(__dirname, 'generate-uganda-catchup-20260911.js');
  try {
    await cliRunner(missing).exec('PRAGMA user_version=0;');
    const ddl = [
      'CREATE TABLE probe (value INTEGER);',
      ...TABLES.map((name) => `CREATE TABLE "${name}" (value INTEGER);`),
      ...INDEXES.map((name) => `CREATE INDEX "${name}" ON probe(value);`),
      ...TRIGGERS.map((name) => `CREATE TRIGGER "${name}" AFTER INSERT ON probe BEGIN SELECT 1; END;`),
    ];
    await cliRunner(complete).exec(ddl.join('\n'));

    const apiProbe = `
      const assert = require('node:assert/strict');
      const { verify } = require(${JSON.stringify(script)});
      (async () => {
        const expected = process.argv[3] === 'preset' ? 7 : undefined;
        if (expected !== undefined) process.exitCode = expected;
        assert.equal(await verify(process.argv[1]), false);
        assert.equal(process.exitCode, expected);
        assert.equal(await verify(process.argv[2]), true);
        assert.equal(process.exitCode, expected);
      })().catch((error) => { console.error(error); process.exit(2); });
    `;
    for (const [label, expectedStatus] of [['unset', 0], ['preset', 7]]) {
      const child = spawnSync(process.execPath, ['-e', apiProbe, missing, complete, label], { encoding: 'utf8' });
      assert.equal(child.status, expectedStatus, child.stderr);
      assert.match(child.stderr, /--verify FAILED/);
      assert.match(child.stderr, /--verify PASSED/);
    }

    for (const [mode, db, expectedStatus] of [
      ['--verify', missing, 1],
      ['--verify', complete, 0],
      ['--verify', path.join(dir, 'absent.db'), 2],
      ['--apply', path.join(dir, 'absent.db'), 2],
    ]) {
      const child = spawnSync(process.execPath, [script, mode, db], { encoding: 'utf8' });
      assert.equal(child.status, expectedStatus, `${mode} ${db}: ${child.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generate() emits valid, additive-only SQL sourced from 0001__baseline.sql', () => {
  generate();
  const sql = fs.readFileSync(ARTIFACT_PATH, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sync_link_state/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending/);
  assert.match(sql, /DROP TRIGGER IF EXISTS trg_sync_zones_outbox_au/);
  // Additive-only: no DROP TABLE, no DELETE (the sync_link_state bootstrap
  // is an INSERT ... ON CONFLICT DO UPDATE, not a DELETE).
  assert.doesNotMatch(sql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(sql, /\bALTER TABLE\b/i);
  assert.doesNotMatch(sql, /\bDELETE FROM\b/i);
});

test('apply() + verify(): a reference(1) DB with the target objects stripped out is repaired', async () => {
  const db = tmpDb();
  // Build a real reference(1) DB (migration 0001 only), matching what
  // baseline-existing-db.js compares against, then simulate Uganda's gap by
  // dropping exactly the objects this artifact targets.
  await bootstrapFresh(cliRunner(db), { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
  const runner = cliRunner(db);
  const drops = [];
  for (const t of TABLES) drops.push(`DROP TABLE ${t};`);
  for (const tr of TRIGGERS) drops.push(`DROP TRIGGER IF EXISTS ${tr};`);
  // Indexes on tables we just dropped disappear with the table; only drop the
  // standalone survivors explicitly.
  for (const i of INDEXES) {
    if (i === 'idx_history_rollups_unique_bucket'
      || i === 'idx_history_rollups_zone_card_bucket'
      || i === 'idx_history_rollups_source_channel'
      || i === 'idx_sync_outbox_pending') continue; // owned by a dropped/preexisting table already covered
    drops.push(`DROP INDEX IF EXISTS ${i};`);
  }
  // schema_migrations/schema_object_fingerprints would make verify's snapshot
  // path irrelevant to this test; leave them - snapshotSchema ignores them.
  await runner.exec(`PRAGMA foreign_keys=OFF;\nBEGIN IMMEDIATE;\n${drops.join('\n')}\nCOMMIT;\nPRAGMA foreign_keys=ON;`);

  const before = await verify(db);
  assert.equal(before, false, 'verify should report missing objects before apply()');

  await apply(db);
  const after = await verify(db);
  assert.equal(after, true, 'verify should report all objects present after apply()');

  const integ = (await runner.all('PRAGMA integrity_check'))[0];
  assert.equal(integ.integrity_check || Object.values(integ)[0], 'ok');
});

test('apply() is idempotent (safe to re-run)', async () => {
  const db = tmpDb();
  await bootstrapFresh(cliRunner(db), { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
  await apply(db); // no-op-ish: everything already present at head, IF NOT EXISTS guards make this safe
  const ok = await verify(db);
  assert.equal(ok, true);
});
