'use strict';
// computeFingerprints reads the per-table PRAGMA rows through four batched
// table-valued PRAGMA queries instead of one sqlite3 process per table and
// index. The fingerprints must not change: these tests compare the batched
// rows with the per-object PRAGMA rows on an edge-case schema and on the head
// seed schema, through both runners, and prove the per-object fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { computeFingerprints, readTableIntrospection } = require('../fingerprints');
const { cliRunner, nodeSqliteRunner } = require('../runner-iface');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SEED_BLANK = path.join(REPO_ROOT, 'database/seed-blank.sql');

// Quoted names, a composite and a multi-column foreign key, WITHOUT ROWID,
// generated columns, expression, partial, descending and collated indexes,
// autoindexes, a table with no index and one with no foreign key.
const EDGE_SQL = `
CREATE TABLE "odd ""name"" t" (id INTEGER PRIMARY KEY, "col ""q""" TEXT DEFAULT 'x', b BLOB);
CREATE TABLE parent (a INTEGER, b TEXT, c REAL, PRIMARY KEY (a, b)) WITHOUT ROWID;
CREATE TABLE child (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pa INTEGER, pb TEXT, other_id INTEGER REFERENCES "odd ""name"" t"(id) ON DELETE CASCADE,
  g INTEGER GENERATED ALWAYS AS (pa * 2) VIRTUAL,
  h TEXT GENERATED ALWAYS AS (upper(pb)) STORED,
  u TEXT UNIQUE COLLATE NOCASE,
  FOREIGN KEY (pa, pb) REFERENCES parent(a, b) ON UPDATE SET NULL DEFERRABLE INITIALLY DEFERRED,
  CHECK (pa IS NULL OR pa > 0)
);
CREATE INDEX idx_child_expr ON child (lower(pb), pa DESC);
CREATE INDEX idx_child_partial ON child (pb COLLATE NOCASE) WHERE pa IS NOT NULL;
CREATE UNIQUE INDEX "idx odd" ON "odd ""name"" t" ("col ""q""");
CREATE TABLE noidx (x);
CREATE VIEW v_child AS SELECT id, pa FROM child;
CREATE TRIGGER trg_child AFTER INSERT ON child BEGIN UPDATE noidx SET x = NEW.id; END;
`;

function scratchDb(t, sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-fp-batched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'farming.db');
  execFileSync('sqlite3', ['-bail', db], { input: sql });
  return db;
}

async function tableNames(runner) {
  return (await runner.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name"))
    .map((r) => r.name);
}

function counting(runner, { refuse = null } = {}) {
  const calls = [];
  return {
    calls,
    runner: {
      dbPath: runner.dbPath,
      async exec(sql) { return runner.exec(sql); },
      async all(sql) {
        calls.push(sql);
        if (refuse && refuse.test(sql)) throw new Error('Parse error: no such table: pragma_table_xinfo');
        return runner.all(sql);
      },
      async close() { return runner.close(); },
    },
  };
}

for (const [label, sql] of [['edge-case schema', EDGE_SQL], ['seed-blank.sql', null]]) {
  for (const [runnerName, factory] of [['cliRunner', cliRunner], ['nodeSqliteRunner', nodeSqliteRunner]]) {
    test(`${label}, ${runnerName}: batched PRAGMA rows equal the per-object PRAGMA rows`, async (t) => {
      const db = scratchDb(t, sql === null ? fs.readFileSync(SEED_BLANK, 'utf8') : sql);
      const runner = factory(db);
      t.after(() => runner.close());
      const names = await tableNames(runner);
      assert.ok(names.length >= 4, 'sanity: the schema has tables to compare');
      const perObject = await readTableIntrospection(runner, names, { batched: false });
      const batched = await readTableIntrospection(runner, names, { batched: true });
      // JSON text, not deepEqual: the fingerprint hashes JSON.stringify output,
      // so key order inside every row has to match too.
      assert.equal(JSON.stringify([...batched]), JSON.stringify([...perObject]));
      const withFks = [...perObject.values()].filter((v) => v.fks.length).length;
      const withIndexes = [...perObject.values()].filter((v) => v.indexes.length).length;
      assert.ok(withFks > 0 && withIndexes > 0, 'sanity: foreign keys and indexes were compared, not only empty arrays');
    });
  }
}

test('computeFingerprints reads the table PRAGMAs in a fixed number of queries', async (t) => {
  const db = scratchDb(t, fs.readFileSync(SEED_BLANK, 'utf8'));
  const { runner, calls } = counting(cliRunner(db));
  const fps = await computeFingerprints(runner);
  assert.ok(fps.filter((f) => f.object_type === 'table').length > 50, 'sanity: the head schema has many tables');
  assert.equal(calls.length, 5, `expected sqlite_master plus four batched PRAGMA queries, got ${calls.length}`);
});

// The fallback latches for the process, so this test uses its own copy of the
// module and leaves the shared one on the batched path.
function freshFingerprints() {
  const id = require.resolve('../fingerprints');
  const saved = require.cache[id];
  delete require.cache[id];
  try { return require('../fingerprints'); } finally { require.cache[id] = saved; }
}

test('a sqlite3 without table-valued PRAGMA functions falls back to per-object PRAGMAs with the same fingerprints', async (t) => {
  const db = scratchDb(t, EDGE_SQL);
  const expected = await computeFingerprints(cliRunner(db));
  const isolated = freshFingerprints();
  const { runner, calls } = counting(cliRunner(db), { refuse: /pragma_/ });
  const warn = t.mock.method(console, 'error', () => {});
  assert.deepEqual(await isolated.computeFingerprints(runner), expected);
  assert.ok(calls.some((sql) => /^PRAGMA table_xinfo\(/.test(sql)), 'the per-object path ran');
  const batchedTries = calls.filter((sql) => /pragma_/.test(sql)).length;
  calls.length = 0;
  assert.deepEqual(await isolated.computeFingerprints(runner), expected);
  assert.equal(batchedTries, 1, 'one batched query failed before the fallback');
  assert.equal(calls.filter((sql) => /pragma_/.test(sql)).length, 0, 'later calls skip the batched path');
  assert.equal(warn.mock.calls.length, 1, 'the fallback warns once');
  // The shared module is still on the batched path.
  const { runner: shared, calls: sharedCalls } = counting(cliRunner(db));
  await computeFingerprints(shared);
  assert.equal(sharedCalls.length, 5);
});
