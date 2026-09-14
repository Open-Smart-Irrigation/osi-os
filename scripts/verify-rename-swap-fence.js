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
// source or the target of a `RENAME TO` in the same text is a rename-swap, and
// it must be fenced. Two things count as a fence:
//
//   1. A `-- risk: destructive` header on the first non-blank line, but ONLY in
//      `database/migrations/ordered/`. That is the one corpus the ordered
//      runner executes, and only the runner supplies the
//      `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; …; COMMIT;
//      PRAGMA foreign_keys=ON;` wrap (lib/osi-migrate/runner.js). An ops script
//      is piped straight to the sqlite3 CLI, where the header is a comment and
//      nothing more.
//   2. A real `PRAGMA foreign_keys=OFF` in scope at the swap: the nearest
//      preceding pragma says OFF, it is not inside a comment, and control has
//      not left the block that set it. That last part matters in JavaScript
//      corpora, where a pragma in one function must not fence a swap in the
//      next one, while the boot node's pragma legitimately covers the nested
//      transaction callback below it.
//
// Corpora: ordered and legacy migrations, radio migrations, lineage fixtures,
// `database/seed-blank.sql`, the executed `scripts/ops/*.sql` artifacts and
// their generators, the repair and baseline tools under `scripts/`, the
// Node-RED helper modules under `conf/*/files/usr/share/node-red/`, and every
// function-node body in both `flows.json` profiles.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const ORDERED_MIGRATIONS_REL = 'database/migrations/ordered';
const FLOWS = [
  ['bcm2712', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'],
  ['bcm2709', 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'],
];
const NODE_RED_DIRS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red',
];
// Rebuild-capable tools outside the globs. A whole-`scripts/*.js` sweep would
// swallow this verifier's own fixtures, so the list is explicit.
const EXTRA_SCRIPTS = [
  'scripts/repair-pi-schema.js',
  'scripts/repair-sync-outbox-v2.js',
  'scripts/baseline-existing-db.js',
];

// A table name as it appears in repo SQL: a bare identifier, or a JavaScript
// template placeholder in a generator (`DROP TABLE ${table};`). An optional
// schema qualifier (`main.devices`) is matched and dropped.
const IDENT = '(?:\\$\\{[^}]+\\}|[A-Za-z_][A-Za-z0-9_]*)';
const QUALIFIER = `(?:${IDENT}\\s*\\.\\s*)?`;
// SQL in this repo is frequently spliced out of JavaScript string literals, so
// quotes, brackets and concatenation operators may sit between the keywords.
const GLUE = '[\'"`+\\[\\]\\s]*';
const RENAME_RE = new RegExp(
  `ALTER\\s+TABLE\\s+${GLUE}${QUALIFIER}(${IDENT})${GLUE}RENAME\\s+TO\\s+${GLUE}${QUALIFIER}(${IDENT})`, 'gi');
const DROP_RE = new RegExp(
  `DROP\\s+TABLE\\s+${GLUE}(?:IF\\s+EXISTS\\s+${GLUE})?${QUALIFIER}(${IDENT})`, 'gi');
// The risk header is the file's first non-blank line (AGENTS.md); a later line
// mentioning the marker is a comment, not a header.
const DESTRUCTIVE_HEADER_RE = /^\s*--\s*risk:\s*destructive\b/i;
const FK_PRAGMA_RE = /PRAGMA\s+foreign_keys\s*=\s*(OFF|ON|0|1|TRUE|FALSE)/gi;

function isJsLabel(label) {
  return label.endsWith('.js') || label.startsWith('bcm2712:') || label.startsWith('bcm2709:');
}

// Only the ordered-migration runner supplies the FK wrap, so only its inputs
// may be fenced by a risk header: `database/migrations/ordered/`,
// `database/radio-migrations/ordered/`, and the per-lineage `NNNN__slug.sql`
// fixtures deploy.sh ships to gateways on a non-default lineage
// (scripts/deploy-fetch-list.js). `scripts/ops/*.sql` is piped to the sqlite3
// CLI and gets no wrap.
function isRunnerMigration(label) {
  const rel = label.split(path.sep).join('/');
  if (rel.includes('/ordered/')) return true;
  return /^scripts\/fixtures\/lineages\/[^/]+\/\d{4}__[^/]+\.sql$/.test(rel);
}

// A JavaScript file may EXECUTE SQL or ASSEMBLE it for later execution. For an
// executed statement, source order and lexical scope are the truth. For an
// assembled fragment (`lines.push('DROP TABLE …')`) neither is: the emitted
// script orders the fragments, so the fence can be built anywhere in the file,
// which is how the Uganda generator puts its pragma in a header array below the
// per-table blocks. Fragments therefore fall back to file scope, and a file
// that assembles a swap with no pragma anywhere still fails.
const EXEC_CALLS = /^(?:exec|execute|run|query|prepare|all|get|each|execSql|runSql)$/i;
const CALL_BEFORE_RE = /([A-Za-z_$][\w$]*)\s*\(/g;
function isExecutedStatement(text, index) {
  let name = null;
  CALL_BEFORE_RE.lastIndex = Math.max(0, index - 200);
  for (let m = CALL_BEFORE_RE.exec(text); m && m.index < index; m = CALL_BEFORE_RE.exec(text)) name = m[1];
  return name != null && EXEC_CALLS.test(name);
}

// Comments are not statements: a `-- PRAGMA foreign_keys=OFF` note must not
// fence anything, and a commented-out DROP must not be reported. Blanking
// rather than deleting keeps every index aligned with the source text.
function stripComments(text, kind) {
  let out = '';
  let i = 0;
  const line = kind === 'js' ? '//' : '--';
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (text.startsWith(line, i) && !(kind === 'js' && text[i - 1] === ':')) {
      // `://` inside a URL literal is not a comment.
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (kind === 'js' && text.startsWith('-- ', i)) {
      // A SQL comment inside a JavaScript string literal, such as the Uganda
      // generator's header lines. It ends at the newline or at the quote that
      // closes the literal, whichever comes first; `i--` and `--i` never match
      // because the trailing space is required.
      let stop = i + 3;
      while (stop < text.length && !'\n\'"`'.includes(text[stop])) stop += 1;
      out += ' '.repeat(stop - i);
      i = stop;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

// SQLite folds unquoted and quoted identifiers to the same name; a generator's
// `${...}` placeholder is compared verbatim.
function identKey(name) {
  return name.startsWith('${') ? name : name.toLowerCase();
}

function hasDestructiveHeader(sql) {
  const first = String(sql == null ? '' : sql).split('\n').find((l) => l.trim() !== '');
  return first != null && DESTRUCTIVE_HEADER_RE.test(first);
}

function braceDepths(text) {
  const depths = new Int32Array(text.length);
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') depth += 1;
    depths[i] = depth;
    if (c === '}') depth = Math.max(0, depth - 1);
  }
  return depths;
}

/**
 * Are foreign keys off at `index`? The nearest preceding pragma decides, and it
 * only counts while control has not left the block that set it, so a pragma in
 * an earlier sibling function does not fence a later swap.
 */
function fkOffAt(text, depths, index, fileScope) {
  const events = [];
  FK_PRAGMA_RE.lastIndex = 0;
  for (let m = FK_PRAGMA_RE.exec(text); m; m = FK_PRAGMA_RE.exec(text)) {
    if (!fileScope && m.index >= index) break;
    events.push({ index: m.index, off: /^(OFF|0|FALSE)$/i.test(m[1]) });
  }
  if (fileScope) return events.some((e) => e.off);
  for (let e = events.length - 1; e >= 0; e -= 1) {
    const { index: at, off } = events[e];
    let inScope = true;
    for (let i = at; i < index; i += 1) {
      if (depths[i] < depths[at]) { inScope = false; break; }
    }
    if (inScope) return off;
  }
  return false;
}

/**
 * Report every unfenced rename-swap in one text.
 * @param {string} label how the text is named in the failure output; its
 *   extension picks the comment syntax, and only a
 *   `database/migrations/ordered/` label may be fenced by its risk header
 * @param {string} sql SQL, or JavaScript that emits SQL
 * @returns {string[]} one message per swapped table, empty when clean
 */
function scanSqlText(label, sql) {
  const kind = isJsLabel(label) ? 'js' : 'sql';
  if (isRunnerMigration(label) && hasDestructiveHeader(sql)) return [];

  const text = stripComments(String(sql == null ? '' : sql), kind).replace(/\s/g, ' ');
  const depths = braceDepths(text);

  const renamed = new Map(); // table key -> {name, index of the earliest RENAME touching it}
  RENAME_RE.lastIndex = 0;
  for (let m = RENAME_RE.exec(text); m; m = RENAME_RE.exec(text)) {
    for (const name of [m[1], m[2]]) {
      if (!renamed.has(identKey(name))) renamed.set(identKey(name), { name, index: m.index });
    }
  }
  if (renamed.size === 0) return [];

  const problems = [];
  const seen = new Set();
  DROP_RE.lastIndex = 0;
  for (let m = DROP_RE.exec(text); m; m = DROP_RE.exec(text)) {
    const key = identKey(m[1]);
    const rename = renamed.get(key);
    if (!rename || seen.has(key)) continue;
    const first = Math.min(m.index, rename.index);
    const fileScope = kind === 'js'
      && !isExecutedStatement(text, m.index) && !isExecutedStatement(text, rename.index);
    if (fkOffAt(text, depths, first, fileScope)) continue;
    seen.add(key);
    problems.push(
      `${label}: rename-swap involving ${rename.name} without an FK fence `
      + '(needs PRAGMA foreign_keys=OFF in scope at the swap, or a "-- risk: destructive" '
      + 'header if this is an ordered migration)');
  }
  return problems;
}

function listDir(rel, filter) {
  const dir = path.join(REPO, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(filter).sort().map((f) => path.join(rel, f));
}

function walk(rel, filter, acc = []) {
  const dir = path.join(REPO, rel);
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(child, filter, acc);
    else if (filter(entry.name)) acc.push(child);
  }
  return acc;
}

const isSql = (f) => f.endsWith('.sql');
const isSource = (f) => f.endsWith('.sql') || f.endsWith('.js');

/**
 * Every text the verifier scans.
 * @returns {Array<{label: string, sql: string}>}
 */
function collectCorpora() {
  const corpora = [];
  const files = [
    ...listDir(ORDERED_MIGRATIONS_REL, isSql),
    ...listDir('database/migrations', isSql),
    ...listDir('database/radio-migrations/ordered', isSql),
    ...walk('scripts/fixtures/lineages', isSql),
    'database/seed-blank.sql',
    ...listDir('scripts/ops', isSource),
    ...EXTRA_SCRIPTS,
    ...NODE_RED_DIRS.flatMap((d) => walk(d, (f) => f.endsWith('.js'))),
  ];
  const seen = new Set();
  for (const rel of files) {
    if (seen.has(rel) || !fs.existsSync(path.join(REPO, rel))) continue;
    seen.add(rel);
    corpora.push({ label: rel, sql: fs.readFileSync(path.join(REPO, rel), 'utf8') });
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
