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

const ORDERED = 'database/migrations/ordered/0099__example.sql';

test('destructive risk class counts as fenced (the runner wraps it)', () => {
  assert.deepStrictEqual(scanSqlText(ORDERED, '-- risk: destructive\n' + SUFFIX_SWAP), []);
});

test('the risk header fences nothing outside database/migrations/ordered', () => {
  // scripts/ops/*.sql is piped straight to the sqlite3 CLI; no runner wrap.
  const p = scanSqlText('scripts/ops/rebuild.sql', '-- risk: destructive\n' + SUFFIX_SWAP);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
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

test('a destructive marker below the header line does not fence anything', () => {
  const p = scanSqlText(ORDERED, '-- rebuild notes\n-- risk: destructive (see 0027)\n' + SUFFIX_SWAP);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
});

test('identifiers compare case-insensitively, as SQLite folds them', () => {
  const p = scanSqlText('f.sql', 'ALTER TABLE zones RENAME TO zones_old;\nDROP TABLE ZONES_OLD;');
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
});

test('foreign keys switched back on before a later swap leave it unfenced', () => {
  const sql = 'PRAGMA foreign_keys=OFF;\n' + DROP_FIRST_SWAP + '\nPRAGMA foreign_keys=ON;\n' + SUFFIX_SWAP;
  const p = scanSqlText('ops.sql', sql);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
});

test('PRAGMA foreign_keys=0 fences as OFF does', () => {
  assert.deepStrictEqual(scanSqlText('ops.sql', 'PRAGMA foreign_keys = 0;\n' + DROP_FIRST_SWAP), []);
});

test('a pragma inside a SQL line comment does not fence a swap', () => {
  const sql = '-- PRAGMA foreign_keys=OFF is what we should have done\n' + DROP_FIRST_SWAP;
  const p = scanSqlText('ops.sql', sql);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones without an FK fence/);
});

test('a pragma inside a block comment does not fence a swap', () => {
  const p = scanSqlText('ops.sql', '/* PRAGMA foreign_keys = OFF; */\n' + DROP_FIRST_SWAP);
  assert.strictEqual(p.length, 1);
});

test('a pragma inside a JavaScript line comment does not fence a swap', () => {
  const js = '// PRAGMA foreign_keys=OFF held across the whole transaction\n'
    + "db.exec('DROP TABLE zones');\ndb.exec('ALTER TABLE zones_new RENAME TO zones');";
  const p = scanSqlText('gen.js', js);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones without an FK fence/);
});

test('a SQL comment inside a JavaScript string does not fence a swap', () => {
  const js = [
    'function build(table, staging) {',
    "  const header = ['-- PRAGMA foreign_keys=OFF is held across the transaction'];",
    '  const lines = [`DROP TABLE ${table};`, `ALTER TABLE ${staging} RENAME TO ${table};`];',
    '  return [...header, ...lines];',
    '}',
  ].join('\n');
  const p = scanSqlText('gen.js', js);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving \$\{table\} without an FK fence/);
});

test('a decrement is not mistaken for a SQL comment', () => {
  const js = [
    'function build(table, staging) {',
    "  db.exec('PRAGMA foreign_keys=OFF');",
    '  for (let i = rows.length; i-- > 0;) { keep(i); }',
    "  db.exec('DROP TABLE ' + table);",
    "  db.exec('ALTER TABLE ' + staging + ' RENAME TO ' + table);",
    '}',
  ].join('\n');
  assert.deepStrictEqual(scanSqlText('helper.js', js), []);
});

test('a commented-out swap is not reported', () => {
  assert.deepStrictEqual(
    scanSqlText('ops.sql', '-- DROP TABLE zones;\n-- ALTER TABLE zones_new RENAME TO zones;'), []);
});

test('a pragma in an earlier sibling function does not fence a later swap', () => {
  const js = [
    'function fenced() {',
    "  db.exec('PRAGMA foreign_keys=OFF');",
    '}',
    'function rebuild() {',
    "  db.exec('DROP TABLE zones');",
    "  db.exec('ALTER TABLE zones_new RENAME TO zones');",
    '}',
  ].join('\n');
  const p = scanSqlText('helper.js', js);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones without an FK fence/);
});

test('a pragma still fences a swap nested inside the same function', () => {
  const js = [
    'async function rebuild() {',
    "  await db.run('PRAGMA foreign_keys=OFF');",
    '  await db.transaction(async (t) => {',
    "    await t.run('ALTER TABLE zones RENAME TO zones_old');",
    "    await t.run('DROP TABLE IF EXISTS zones_old');",
    '  });',
    '}',
  ].join('\n');
  assert.deepStrictEqual(scanSqlText('helper.js', js), []);
});

test('a lineage fixture migration is fenced by its risk header (the runner wraps it too)', () => {
  const label = 'scripts/fixtures/lineages/agrolink/0046__add_dragino_sdi12_type.sql';
  assert.deepStrictEqual(scanSqlText(label, '-- risk: destructive\n' + SUFFIX_SWAP), []);
});

test('an assembled fragment is fenced by a pragma the generator emits elsewhere in the file', () => {
  // Source order does not survive assembly: the Uganda generator pushes its
  // per-table swap blocks first and prepends the pragma header afterwards.
  const js = [
    'function buildRebuild(table, staging) {',
    '  const lines = [];',
    '  lines.push(`DROP TABLE ${table};`);',
    '  lines.push(`ALTER TABLE ${staging} RENAME TO ${table};`);',
    '  return lines;',
    '}',
    'function write(blocks) {',
    "  const header = ['PRAGMA foreign_keys = OFF;', 'BEGIN IMMEDIATE;'];",
    '  return [...header, ...blocks].join("\\n");',
    '}',
  ].join('\n');
  assert.deepStrictEqual(scanSqlText('gen.js', js), []);
});

test('an assembled swap with no pragma anywhere in the file is reported', () => {
  const js = [
    'function buildRebuild(table, staging) {',
    '  const lines = [];',
    '  lines.push(`DROP TABLE ${table};`);',
    '  lines.push(`ALTER TABLE ${staging} RENAME TO ${table};`);',
    '  return lines;',
    '}',
  ].join('\n');
  const p = scanSqlText('gen.js', js);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving \$\{table\} without an FK fence/);
});

test('bracketed and schema-qualified identifiers are matched', () => {
  const p = scanSqlText('f.sql', 'ALTER TABLE [zones] RENAME TO [zones_old];\nDROP TABLE main.zones_old;');
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
});

test('the live-Pi repair tool is scanned', () => {
  const { collectCorpora } = require('./verify-rename-swap-fence');
  const labels = collectCorpora().map((c) => c.label);
  assert.ok(labels.includes('scripts/repair-pi-schema.js'), 'repair-pi-schema.js scanned');
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
  assert.ok(labels.some((l) => /^database\/migrations\/2026-.*\.sql$/.test(l)), 'legacy migrations scanned');
  assert.ok(labels.some((l) => l.startsWith('database/radio-migrations/ordered/')), 'radio migrations scanned');
  assert.ok(labels.some((l) => l.startsWith('scripts/fixtures/lineages/')), 'lineage fixtures scanned');
  assert.ok(labels.includes('database/seed-blank.sql'), 'seed scanned');
  assert.ok(labels.includes('scripts/repair-sync-outbox-v2.js'), 'outbox repair tool scanned');
  assert.ok(labels.includes('scripts/baseline-existing-db.js'), 'baseline tool scanned');
  assert.ok(
    labels.some((l) => /^conf\/full_raspberrypi_bcm27xx_bcm2712\/files\/usr\/share\/node-red\/.*\.js$/.test(l)),
    'node-red helper modules scanned');
  assert.ok(!labels.some((l) => l.includes('/node_modules/')), 'vendored modules skipped');
});
