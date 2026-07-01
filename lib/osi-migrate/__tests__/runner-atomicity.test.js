'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { applyPending } = require('../index');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-atom-'));
  const dir = path.join(root, 'migrations'); fs.mkdirSync(dir);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { db: path.join(root, 't.db'), dir };
}

// 0002 inserts a dangling FK row. The SQLite CLI has FK enforcement OFF by default, so the INSERT
// commits; postflight's PRAGMA foreign_key_check then reports the violation -> post-commit failure.
test('post-commit postflight failure marks repair_required, keeps schema, and does NOT re-run DDL', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE parent (id INTEGER PRIMARY KEY);\nCREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id));\n',
    '0002__bad.sql': '-- risk: additive\nINSERT INTO child (id, p) VALUES (1, 999);\n',
  });
  const r = cliRunner(db);
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }), /foreign_key_check/);
  const rows = await r.all('SELECT version, status FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((x) => [x.version, x.status]), [[1, 'applied'], [2, 'repair_required']],
    'schema change and its ledger row committed together; postflight flagged it');
  assert.deepEqual(await r.all('SELECT id FROM child'), [{ id: 1 }], 'the committed change persisted');
  // The old bug: re-run retried non-idempotent DDL. Now it must halt on repair_required.
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }), /repair_required/);
});

test('a pre-commit (rolled-back) failure records status=failed and is retryable', async () => {
  const { db, dir } = fixture({
    '0001__ok.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n',
    '0002__boom.sql': '-- risk: additive\nALTER TABLE nonexist ADD COLUMN v TEXT;\n',
  });
  const r = cliRunner(db);
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }));
  const [row] = await r.all("SELECT status, applied_at FROM schema_migrations WHERE version=2");
  assert.equal(row.status, 'failed');
  assert.equal(row.applied_at, null);
  // fix the migration, re-run: version 2 (failed) is retried and succeeds
  fs.writeFileSync(path.join(dir, '0002__boom.sql'), '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n');
  const res = await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.deepEqual(res.applied, [2]);
});
