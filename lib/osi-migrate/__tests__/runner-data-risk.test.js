'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { applyPending } = require('../runner');
const { cliRunner } = require('../runner-iface');

test('a data-risk migration takes a backup and applies without writers stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__seed.sql'),
    '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);\nINSERT INTO t (id, v) VALUES (1, 0);\n');
  fs.writeFileSync(path.join(dir, '0002__backfill.sql'),
    '-- risk: data\nUPDATE t SET v = 42 WHERE id = 1;\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  const res = await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // writersStopped defaults false
  assert.deepStrictEqual(res.applied, [1, 2]);
  assert.strictEqual((await r.all('SELECT v FROM t WHERE id = 1'))[0].v, 42);
  assert.strictEqual(fs.readdirSync(root).filter((f) => f.startsWith('t.db.bak-')).length, 1,
    'data migration must create exactly one backup');
});
