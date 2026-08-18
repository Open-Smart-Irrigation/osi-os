'use strict';
// Fable review (c28ebcbf) FIX 2: lib/osi-migrate/sql-normalize.js's
// normalizeSqlClause is not comment-aware. A `--` line comment whose text
// happens to contain an ODD number of apostrophes (e.g. "-- Silvan's
// fallback") flips normalizeSqlClause's own single-quote string-literal
// tracking for everything AFTER it in the same DDL statement, corrupting
// normalization of the rest of the object (pair J). Separately, `x --y`
// (a real line comment) must not be confused with `x - -y` (a real SQL
// double unary minus expression) (pair E).
//
// The fix (fingerprints.js's stripSqlComments) runs BEFORE
// normalizeSqlClause and does its own minimal, literal-aware `--`/`/* */`
// stripping — it deliberately does NOT live in sql-normalize.js itself,
// because that module also backs issue #107's schema_sig comparison and
// must keep its existing semantics.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSqlV3, stripSqlComments, computeFingerprints } = require('../fingerprints');
const { bootstrapFresh } = require('../runner');
const { cliRunner } = require('../runner-iface');
const path = require('node:path'); const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database/migrations/ordered');

test('FABLE PAIR J: an odd-apostrophe-count comment must not change the fingerprint vs the same DDL without the comment', () => {
  const withComment = `CREATE TABLE t (b TEXT -- Silvan's fallback comment
    CHECK (b IN ('X')));`;
  const withoutComment = `CREATE TABLE t (b TEXT CHECK (b IN ('X')));`;
  assert.equal(normalizeSqlV3(withComment), normalizeSqlV3(withoutComment),
    'a comment (even one with an odd apostrophe count) must be fully stripped, not corrupt downstream literal tracking');
});

test('FABLE PAIR J (corruption-shape regression): the odd-apostrophe comment must not flip literal-case sensitivity for what follows it', () => {
  // Before the fix: normalizeSqlClause's own string-tracking, fed the RAW
  // (un-stripped) text, would treat "Silvan's fallback comment\n    CHECK (b
  // IN (" as re-entering/exiting a string literal at the wrong points
  // because of the odd apostrophe count, potentially making a real
  // case-sensitive literal difference AFTER the comment invisible. Prove the
  // opposite still holds post-fix: 'X' vs 'x' after such a comment must
  // still fingerprint differently.
  const upper = `CREATE TABLE t (b TEXT -- Silvan's fallback comment
    CHECK (b IN ('X')));`;
  const lower = `CREATE TABLE t (b TEXT -- Silvan's fallback comment
    CHECK (b IN ('x')));`;
  assert.notEqual(normalizeSqlV3(upper), normalizeSqlV3(lower),
    'a real literal-case difference AFTER an odd-apostrophe comment must remain significant');
});

test('FABLE PAIR E: a line comment ("x --y") is not confused with a double unary minus ("x - -y")', () => {
  const comment = normalizeSqlV3('SELECT x --y\nFROM t;');
  const doubleMinus = normalizeSqlV3('SELECT x - -y FROM t;');
  assert.notEqual(comment, doubleMinus, '"--" (adjacent dashes) must be treated as a comment; "- -" (space-separated) must not be');
  // And the comment form really did drop the "y": it must equal the same
  // statement with that trailing text removed outright.
  assert.equal(comment, normalizeSqlV3('SELECT x FROM t;'));
});

test('a literal-case difference with NO comment involved still hashes differently (guard: stripSqlComments must not be over-eager)', () => {
  const a = normalizeSqlV3("CREATE TABLE t (b TEXT CHECK (b IN ('X')));");
  const b = normalizeSqlV3("CREATE TABLE t (b TEXT CHECK (b IN ('x')));");
  assert.notEqual(a, b);
});

test('unit: stripSqlComments never strips inside a string literal, including a literal containing "--" or "/*"', () => {
  assert.equal(stripSqlComments("SELECT '--not a comment' FROM t;"), "SELECT '--not a comment' FROM t;");
  assert.equal(stripSqlComments("SELECT '/*not a comment*/' FROM t;"), "SELECT '/*not a comment*/' FROM t;");
  assert.equal(stripSqlComments("SELECT 'it''s -- still one literal' FROM t;"), "SELECT 'it''s -- still one literal' FROM t;");
});

test('unit: stripSqlComments strips a real line comment and a real block comment', () => {
  assert.equal(stripSqlComments('a -- comment\nb'), 'a  \nb');
  assert.equal(stripSqlComments('a /* block */ b'), 'a   b');
});

// Build the fully-migrated reference DB once (mirrors the pattern used in
// fingerprints-boot-rewrite-rehearsal.test.js — rebuilding all 47 migrations
// per test is prohibitively slow via the sqlite3-CLI-backed runner).
let migratedDbPromise = null;
function migratedDb() {
  if (!migratedDbPromise) {
    migratedDbPromise = (async () => {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'osimig-comments-'));
      const db = path.join(dir, 'migrated.db');
      const r = cliRunner(db);
      await bootstrapFresh(r, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
      return db;
    })();
  }
  return migratedDbPromise;
}

test('all 227 head objects still fingerprint without throwing, including the 4 tables that carry real -- comments', async () => {
  const db = await migratedDb();
  const r = cliRunner(db);
  const fps = await computeFingerprints(r);
  assert.equal(fps.length, 227, 'object count on a fully-migrated reference DB (seed + all ordered migrations, including the 2 ledger tables)');
  for (const name of ['journal_vocab', 'journal_layouts', 'journal_crop_cycles', 'journal_crop_cycle_plots']) {
    const f = fps.find((x) => x.object_type === 'table' && x.object_name === name);
    assert.ok(f, `expected a fingerprint for ${name} (a table whose DDL carries a real -- comment)`);
    assert.equal(typeof f.fingerprint, 'string');
    assert.equal(f.fingerprint.length, 64, 'sha256 hex digest');
  }
});
