'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanSqlText } = require('./verify-rename-swap-fence');

const SUFFIX_SWAP = `ALTER TABLE zones RENAME TO zones_old;
CREATE TABLE zones (id INTEGER PRIMARY KEY);
INSERT INTO zones SELECT * FROM zones_old;
DROP TABLE zones_old;`;

const DROP_FIRST_SWAP = `CREATE TABLE zones_rebuild_20260911 (id INTEGER PRIMARY KEY);
INSERT INTO zones_rebuild_20260911 SELECT id FROM zones;
DROP TABLE zones;
ALTER TABLE zones_rebuild_20260911 RENAME TO zones;`;

test('unfenced suffix swap is reported', () => {
  const p = scanSqlText('f.sql', '-- risk: additive\n' + SUFFIX_SWAP);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
});

test('unfenced drop-then-rename swap is reported', () => {
  const p = scanSqlText('ops.sql', DROP_FIRST_SWAP);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones without an FK fence/);
});

test('destructive risk class counts as fenced (the runner wraps it)', () => {
  assert.deepStrictEqual(scanSqlText('f.sql', '-- risk: destructive\n' + SUFFIX_SWAP), []);
});

test('an explicit pragma counts as fenced', () => {
  assert.deepStrictEqual(
    scanSqlText('ops.sql', 'PRAGMA foreign_keys=OFF;\n' + DROP_FIRST_SWAP + '\nPRAGMA foreign_keys=ON;'), []);
});

test('a rename with no DROP of either table is not a swap', () => {
  assert.deepStrictEqual(scanSqlText('f.sql', 'ALTER TABLE zones RENAME TO zones_archive;'), []);
});

// --- additional coverage beyond the plan's starting set ---

test('a pragma that only appears after the swap does not fence it', () => {
  const p = scanSqlText('ops.sql', DROP_FIRST_SWAP + '\nPRAGMA foreign_keys=OFF;');
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones without an FK fence/);
});

test('the label prefixes the finding', () => {
  const p = scanSqlText('bcm2712:sync-init-fn', '-- risk: additive\n' + SUFFIX_SWAP);
  assert.match(p[0], /^bcm2712:sync-init-fn: /);
});

test('SQL split across JavaScript string concatenation still matches', () => {
  const js = [
    "await t.exec('DROP TABLE IF EXISTS devices;');",
    "await t.exec(",
    "  'ALTER TABLE devices_new'",
    "  + ' RENAME TO devices;');",
  ].join('\n');
  const p = scanSqlText('flows:node', js);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving devices without an FK fence/);
});

test('template-literal table names are treated as one identifier', () => {
  const js = 'lines.push(`DROP TABLE ${table};`);\nlines.push(`ALTER TABLE ${staging} RENAME TO ${table};`);';
  const p = scanSqlText('gen.js', js);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving \$\{table\} without an FK fence/);
});

test('each swapped table is reported once even when dropped repeatedly', () => {
  const sql = `ALTER TABLE zones RENAME TO zones_old;
DROP TABLE zones_old;
DROP TABLE IF EXISTS zones_old;`;
  assert.strictEqual(scanSqlText('f.sql', sql).length, 1);
});

test('two independent unfenced swaps are both reported', () => {
  const sql = DROP_FIRST_SWAP + '\n' + SUFFIX_SWAP;
  const p = scanSqlText('ops.sql', sql);
  assert.strictEqual(p.length, 2);
});

test('quoted identifiers are matched', () => {
  const p = scanSqlText('f.sql', 'ALTER TABLE "zones" RENAME TO "zones_old";\nDROP TABLE "zones_old";');
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
});

test('a DROP of an unrelated table is not a swap', () => {
  assert.deepStrictEqual(
    scanSqlText('f.sql', 'ALTER TABLE zones RENAME TO zones_old;\nDROP TABLE scratch_tmp;'), []);
});

test('the repository corpora are clean', () => {
  const { collectCorpora } = require('./verify-rename-swap-fence');
  const corpora = collectCorpora();
  assert.ok(corpora.length > 60, `expected the scanner to see the real corpora, got ${corpora.length}`);
  const problems = corpora.flatMap(({ label, sql }) => scanSqlText(label, sql));
  assert.deepStrictEqual(problems, []);
});

test('the corpora include migrations, ops SQL, ops generators and both boot nodes', () => {
  const { collectCorpora } = require('./verify-rename-swap-fence');
  const labels = collectCorpora().map((c) => c.label);
  assert.ok(labels.some((l) => /ordered\/0027__/.test(l)), 'ordered migrations scanned');
  assert.ok(labels.some((l) => /ops\/uganda-schema-rebuild-20260911\.sql$/.test(l)), 'executed ops SQL scanned');
  assert.ok(labels.some((l) => /ops\/generate-uganda-schema-rebuild-20260911\.js$/.test(l)), 'ops generators scanned');
  assert.ok(labels.some((l) => /^bcm2712:sync-init-fn$/.test(l)), 'bcm2712 boot node scanned');
  assert.ok(labels.some((l) => /^bcm2709:sync-init-fn$/.test(l)), 'bcm2709 boot node scanned');
});
