'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { applyPending } = require('../index');
const { getApplied } = require('../ledger');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-run-'));
  const dir = path.join(root, 'migrations'); fs.mkdirSync(dir);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { db: path.join(root, 't.db'), dir };
}

test('applies pending additive migrations once, in order', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n',
    '0002__add.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n',
  });
  const r = cliRunner(db);
  const res1 = await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.deepEqual(res1.applied, [1, 2]);
  const res2 = await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.deepEqual(res2.applied, [], 'second run is a no-op');
  assert.deepEqual((await getApplied(r)).map((x) => x.version), [1, 2]);
});

test('failure aborts and records status=failed on a clean connection', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n',
    '0002__boom.sql': '-- risk: additive\nALTER TABLE nonexistent ADD COLUMN v TEXT;\n',
  });
  const r = cliRunner(db);
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }));
  const rows = await getApplied(r);
  assert.deepEqual(rows.map((x) => [x.version, x.status]), [[1, 'applied'], [2, 'failed']]);
});

test('checksum mismatch on an applied version throws repair_required', async () => {
  const { db, dir } = fixture({ '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER);\n' });
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER, z INTEGER);\n');
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }), /repair_required/);
});
