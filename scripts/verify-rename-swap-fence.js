#!/usr/bin/env node
'use strict';
// verify-rename-swap-fence (osi-os#224)
//
// SQLite cannot ALTER a CHECK or a column type in place, so the repo rebuilds a
// table by creating a replacement and swapping the names. During the swap the
// parent row of every child FK disappears for an instant; without
// `PRAGMA foreign_keys=OFF` around it SQLite either fails the statement or
// rewrites the children's references to the staging table. Migration 0027 and
// the Uganda rebuild of 2026-09-11 are both of this shape.
//
// The rule: inside one text, a `DROP TABLE [IF EXISTS] <t>` whose <t> is the
// source or the target of a `RENAME TO` in the same text is a rename-swap. It
// must be fenced, either by the `-- risk: destructive` header (the ordered
// migration runner wraps those in `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
// …; COMMIT; PRAGMA foreign_keys=ON;`) or by an explicit
// `PRAGMA foreign_keys=OFF` appearing before the first of the two statements.
//
// Corpora: ordered migrations, the executed `scripts/ops/*.sql` artifacts,
// their `scripts/ops/*.js` generators, and every function-node body in both
// `flows.json` profiles.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const OPS_DIR = path.join(REPO, 'scripts/ops');
const FLOWS = [
  ['bcm2712', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'],
  ['bcm2709', 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'],
];

// A table name as it appears in repo SQL: a bare identifier, or a JavaScript
// template placeholder in a generator (`DROP TABLE ${table};`).
const IDENT = '(?:\\$\\{[^}]+\\}|[A-Za-z_][A-Za-z0-9_]*)';
// SQL in this repo is frequently spliced out of JavaScript string literals, so
// quotes and concatenation operators may sit between the SQL keywords.
const GLUE = '[\'"`+\\s]*';
const RENAME_RE = new RegExp(
  `ALTER\\s+TABLE\\s+${GLUE}(${IDENT})${GLUE}RENAME\\s+TO\\s+${GLUE}(${IDENT})`, 'gi');
const DROP_RE = new RegExp(
  `DROP\\s+TABLE\\s+${GLUE}(?:IF\\s+EXISTS\\s+${GLUE})?(${IDENT})`, 'gi');
const DESTRUCTIVE_RE = /--\s*risk:\s*destructive/i;
const FK_OFF_RE = /PRAGMA\s+foreign_keys\s*=\s*OFF/i;

/**
 * Report every unfenced rename-swap in one text.
 * @param {string} label how the text is named in the failure output
 * @param {string} sql SQL, or JavaScript that emits SQL
 * @returns {string[]} one message per swapped table, empty when clean
 */
function scanSqlText(label, sql) {
  const text = String(sql == null ? '' : sql).replace(/\s+/g, ' ');
  if (DESTRUCTIVE_RE.test(text)) return [];

  const renamed = new Map(); // table name -> index of the earliest RENAME touching it
  RENAME_RE.lastIndex = 0;
  for (let m = RENAME_RE.exec(text); m; m = RENAME_RE.exec(text)) {
    for (const name of [m[1], m[2]]) {
      if (!renamed.has(name)) renamed.set(name, m.index);
    }
  }
  if (renamed.size === 0) return [];

  const fkOff = text.search(FK_OFF_RE);
  const problems = [];
  const seen = new Set();
  DROP_RE.lastIndex = 0;
  for (let m = DROP_RE.exec(text); m; m = DROP_RE.exec(text)) {
    const name = m[1];
    if (!renamed.has(name) || seen.has(name)) continue;
    const first = Math.min(m.index, renamed.get(name));
    if (fkOff >= 0 && fkOff < first) continue;
    seen.add(name);
    problems.push(
      `${label}: rename-swap involving ${name} without an FK fence `
      + '(needs "-- risk: destructive" or PRAGMA foreign_keys=OFF before the swap)');
  }
  return problems;
}

function listDir(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(filter).sort().map((f) => path.join(dir, f));
}

/**
 * Every text the verifier scans.
 * @returns {Array<{label: string, sql: string}>}
 */
function collectCorpora() {
  const corpora = [];
  const files = [
    ...listDir(MIGRATIONS_DIR, (f) => f.endsWith('.sql')),
    ...listDir(OPS_DIR, (f) => f.endsWith('.sql') || f.endsWith('.js')),
  ];
  for (const fp of files) {
    corpora.push({ label: path.relative(REPO, fp), sql: fs.readFileSync(fp, 'utf8') });
  }
  for (const [profile, rel] of FLOWS) {
    const nodes = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    for (const node of nodes) {
      if (node && typeof node.func === 'string' && node.func) {
        corpora.push({ label: `${profile}:${node.id}`, sql: node.func });
      }
    }
  }
  return corpora;
}

function run() {
  const corpora = collectCorpora();
  const problems = corpora.flatMap(({ label, sql }) => scanSqlText(label, sql));
  if (problems.length) {
    console.error('verify-rename-swap-fence: FAIL');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }
  console.log(`verify-rename-swap-fence: OK (${corpora.length} files)`);
}

module.exports = { scanSqlText, collectCorpora, run };
if (require.main === module) run();
