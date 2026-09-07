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
// fingerprints-boot-rewrite-rehearsal.test.js — rebuilding the full ordered
// migration set per test is prohibitively slow via the sqlite3-CLI-backed
// runner).
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

test('all head objects still fingerprint without throwing, including the tables that carry real -- comments', async () => {
  const db = await migratedDb();
  const r = cliRunner(db);
  const fps = await computeFingerprints(r);
  // A hardcoded object-count pin here has gone stale twice in a week (227,
  // then 187) purely because migrations keep adding tables/indexes/triggers
  // to main — the number was never the point, completeness was. Derive the
  // expected count from the same migrated schema instead of pinning it:
  // count sqlite_master rows independently, using the identical selection
  // computeFingerprints itself applies (table/index/trigger, DDL present,
  // not an internal sqlite_ object — see fingerprints.js), and assert
  // computeFingerprints fingerprinted exactly that set. This still catches
  // a real regression (an object silently dropped or duplicated by
  // computeFingerprints) without going stale every time the schema grows.
  const master = await r.all(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL");
  const fingerprintableTypes = new Set(['table', 'index', 'trigger']);
  const expectedCount = master.filter((m) => fingerprintableTypes.has(m.type)).length;
  assert.equal(fps.length, expectedCount,
    'computeFingerprints must fingerprint every table/index/trigger visible in sqlite_master, no more and no fewer');
  // Sanity floor, independent of the derivation above: catches a
  // catastrophic mass-drop (e.g. a near-empty schema from a broken
  // migration replay) that a self-consistent-but-wrong derivation would not
  // catch on its own. Not a re-pin — main currently migrates to 216 objects;
  // 150 is headroom below that, not a tracked expectation.
  assert.ok(fps.length >= 150,
    `expected at least 150 fingerprinted objects on a fully-migrated reference DB, got ${fps.length}`);
  for (const name of ['journal_vocab', 'journal_layouts']) {
    const f = fps.find((x) => x.object_type === 'table' && x.object_name === name);
    assert.ok(f, `expected a fingerprint for ${name} (a table whose DDL carries a real -- comment)`);
    assert.equal(typeof f.fingerprint, 'string');
    assert.equal(f.fingerprint.length, 64, 'sha256 hex digest');
  }
});
