'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { applyPending, bootstrapFresh, verifyHead } = require('../index');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-dest-'));
  const dir = path.join(root, 'migrations'); fs.mkdirSync(dir);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { db: path.join(root, 't.db'), dir };
}

// A destructive CHECK-rebuild with a child table referencing the parent ON DELETE CASCADE.
const DESTRUCTIVE = `-- risk: destructive
CREATE TABLE devices_new (id INTEGER PRIMARY KEY, type_id TEXT CHECK(type_id IN ('A','B')));
INSERT INTO devices_new (id, type_id) SELECT id, type_id FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
`;

test('composeDestructiveScript toggles FK OUTSIDE the transaction (regression guard for Spec 1 §9.8)', () => {
  const { composeDestructiveScript } = require('../runner');
  const s = composeDestructiveScript('DROP TABLE devices;');
  const off = s.indexOf('PRAGMA foreign_keys=OFF');
  const begin = s.indexOf('BEGIN IMMEDIATE');
  const commit = s.indexOf('COMMIT');
  const on = s.indexOf('PRAGMA foreign_keys=ON');
  assert.ok(off >= 0 && begin > off, 'FK off must come before BEGIN');
  assert.ok(commit > begin && on > commit, 'FK on must come after COMMIT');
});

test('destructive migration preserves child rows (FK fence effective) when writers stopped', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': "-- risk: additive\nCREATE TABLE devices (id INTEGER PRIMARY KEY, type_id TEXT CHECK(type_id IN ('A')));\nCREATE TABLE child (id INTEGER PRIMARY KEY, dev INTEGER REFERENCES devices(id) ON DELETE CASCADE);\n",
  });
  const r = cliRunner(db);
  // Apply the baseline FIRST, then seed data against the real schema.
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  await r.exec("PRAGMA foreign_keys=ON; INSERT INTO devices (id,type_id) VALUES (1,'A'); INSERT INTO child (id,dev) VALUES (10,1);");
  // Now introduce and apply the destructive rebuild.
  fs.writeFileSync(path.join(dir, '0002__rebuild.sql'), DESTRUCTIVE);
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6', writersStopped: true });
  assert.deepEqual(await r.all('SELECT id FROM child'), [{ id: 10 }], 'child rows survive (FK was off during DROP)');
});

test('destructive migration refuses unless writersStopped', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': "-- risk: additive\nCREATE TABLE devices (id INTEGER PRIMARY KEY, type_id TEXT);\n",
    '0002__rebuild.sql': DESTRUCTIVE,
  });
  const r = cliRunner(db);
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }), /writers/i);
});

test('bootstrapFresh applies all; verifyHead reports ok then drift', async () => {
  const { db, dir } = fixture({ '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n' });
  const r = cliRunner(db);
  await bootstrapFresh(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.equal((await verifyHead(r, { migrationsDir: dir })).ok, true);
  await r.exec('ALTER TABLE t ADD COLUMN sneaky INTEGER;'); // out-of-band edit
  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false);
  assert.match(v.reason, /fingerprint|drift/i);
});
