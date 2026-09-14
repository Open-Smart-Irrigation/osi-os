#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { normalizeSqlClause } = require('../lib/osi-migrate/sql-normalize');
const REPO = path.resolve(__dirname, '..');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(REPO, p));
const SEED = path.join(REPO, 'database/seed-blank.sql');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

// --- shared CREATE TABLE parsing -------------------------------------------------
// Both column parsers reduce a `CREATE TABLE devices*` statement to one {name, ddl}
// per column, `ddl` normalized with lib/osi-migrate/sql-normalize (the single
// definition of "the same SQL" in this repo). Splits happen on commas at paren
// depth 1 only, so a CHECK(x IN ('a','b')) never splits mid-clause, and parsing
// stops at the first table-level constraint.

const TABLE_CONSTRAINT = /^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;

function balancedBody(text, openIdx) {
  let depth = 0, inStr = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) { if (ch === "'") { if (text[i + 1] === "'") i += 1; else inStr = false; } continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  throw new Error('unbalanced parentheses in CREATE TABLE');
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) { cur += ch; if (ch === "'") { if (body[i + 1] === "'") { cur += body[i + 1]; i += 1; } else inStr = false; } continue; }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') { depth += 1; cur += ch; continue; }
    if (ch === ')') { depth -= 1; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function columnsFromCreateTable(sql, nameRe) {
  const m = nameRe.exec(sql);
  if (!m) throw new Error('CREATE TABLE devices statement not found');
  const open = sql.indexOf('(', m.index + m[0].length - 1);
  const cols = [];
  for (const part of splitTopLevel(balancedBody(sql, open))) {
    if (TABLE_CONSTRAINT.test(part)) break;
    const text = part.trim().replace(/\s+/g, ' ');
    if (!text) continue;
    cols.push({ name: text.split(/[\s(]/)[0].replace(/^["`[]|["`\]]$/g, ''), ddl: normalizeSqlClause(text) });
  }
  return cols;
}

function parseSeedDevicesColumns(seedSql) {
  return columnsFromCreateTable(String(seedSql), /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?devices["`\]]?\s*\(/i);
}

// Extracts the boot node's DEVICES_COLUMNS table, rebuilds the CREATE TABLE text the
// node itself builds, and parses that. Falls back to a literal DEVICES_NEW_DDL string
// so the parser still reads a pre-#219 payload.
function parseBootDevicesColumns(funcText) {
  const src = String(funcText || '');
  const start = src.indexOf('const DEVICES_COLUMNS = [');
  if (start >= 0) {
    const open = src.indexOf('[', start);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '[') depth += 1;
      else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('unterminated DEVICES_COLUMNS array literal');
    const table = new Function(`'use strict'; return (${src.slice(open, end + 1)});`)();
    const ddl = 'CREATE TABLE devices_new (' + table.map((c) => c.ddl).join(', ') + ')';
    const cols = columnsFromCreateTable(ddl, /CREATE\s+TABLE\s+devices_new\s*\(/i);
    cols.forEach((c, i) => {
      if (c.name !== table[i].name) throw new Error(`DEVICES_COLUMNS[${i}].name '${table[i].name}' does not match its own ddl '${table[i].ddl}'`);
    });
    return cols;
  }
  const m = /const\s+DEVICES_NEW_DDL\s*=\s*("(?:[^"\\]|\\.)*")/.exec(src);
  if (!m) throw new Error('neither DEVICES_COLUMNS nor a literal DEVICES_NEW_DDL found in sync-init-fn');
  return columnsFromCreateTable(JSON.parse(m[1]), /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?devices(?:_new)?\s*\(/i);
}

// Every `ALTER TABLE devices ADD COLUMN <col>` across the ordered migrations. Other
// tables (devices_audit, device_data, ...) are ignored: the table name must match
// exactly, with its own word boundary.
function migrationAddedDevicesColumns(migrationsDir) {
  const re = /\bALTER\s+TABLE\s+(?:"devices"|`devices`|\[devices\]|devices)\s+ADD\s+(?:COLUMN\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/gi;
  const out = new Set();
  for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    let m;
    while ((m = re.exec(sql)) !== null) out.add(m[1] || m[2] || m[3] || m[4]);
  }
  return out;
}

function run() {
  const problems = [];
  const seedCols = parseSeedDevicesColumns(fs.readFileSync(SEED, 'utf8'));
  const added = migrationAddedDevicesColumns(MIGRATIONS_DIR);
  for (const fp of FLOWS) {
    const func = (JSON.parse(fs.readFileSync(fp, 'utf8')).find((n) => n.id === 'sync-init-fn') || {}).func || '';
    const rel = path.basename(path.dirname(path.dirname(path.dirname(path.dirname(fp)))));
    if (/INSERT OR IGNORE INTO devices_new/.test(func)) problems.push(`${rel}: devices copy still uses INSERT OR IGNORE (silent drop)`);
    if (!/_db\.transaction\s*\(/.test(func)) problems.push(`${rel}: rebuild not inside _db.transaction()`);
    if (!/REQUIRED_TYPES[\s\S]*needsRebuild/.test(func)) problems.push(`${rel}: rebuild not guarded by the live CHECK`);
    const off = func.indexOf('foreign_keys=OFF'), on = func.indexOf('foreign_keys=ON'), fin = func.indexOf('finally');
    if (off < 0 || on < 0 || !(fin >= 0 && fin < on)) problems.push(`${rel}: FK fence must restore foreign_keys=ON in a finally`);
    // Stale-table safety: a leftover devices_new from a prior crash must be dropped first.
    if (!/DROP TABLE IF EXISTS devices_new/.test(func)) problems.push(`${rel}: rebuild must DROP TABLE IF EXISTS devices_new before rebuilding`);
    // On-device safety: only t.* inside the transaction executor; a facade-level _db.* there
    // deadlocks on-device (separate operationQueue slot waiting on the in-flight transaction).
    const txm = /_db\.transaction\(async \(t\) => \{([\s\S]*?)\}\);/.exec(func);
    if (txm && /_db\./.test(txm[1])) problems.push(`${rel}: no _db.* calls inside the transaction executor (use t.*; _db.* deadlocks on-device)`);

    // #173/#219: the rebuild DDL is the seed's devices table, column for column, in order.
    let bootCols = null;
    try { bootCols = parseBootDevicesColumns(func); }
    catch (e) { problems.push(`${rel}: cannot read the boot devices column table: ${e.message}`); }
    if (bootCols) {
      if (bootCols.map((c) => c.name).join(',') !== seedCols.map((c) => c.name).join(',')) {
        problems.push(`${rel}: devices DDL column list or order differs from database/seed-blank.sql`);
      } else {
        seedCols.forEach((c, i) => {
          if (c.ddl !== bootCols[i].ddl) problems.push(`${rel}: devices.${c.name} declaration differs from the seed (${bootCols[i].ddl} vs ${c.ddl})`);
        });
      }
      // Kept even though seed equality subsumes it today: this is the check that names the
      // offending column when an ALTER TABLE devices ADD COLUMN lands without a boot-node
      // update - the exact CI gap that let migration 0026 through.
      const bootNames = new Set(bootCols.map((c) => c.name));
      for (const col of added) {
        if (!bootNames.has(col)) problems.push(`${rel}: boot DDL is missing migration-added devices.${col}`);
      }
    }
    // #220/#219: the copy is built from the live column set, read inside the transaction,
    // and a live column the payload does not know aborts instead of being dropped.
    if (!/t\.all\(\s*'PRAGMA table_info\(devices\)'\s*\)/.test(func)) problems.push(`${rel}: rebuild must read the live column set with t.all inside the transaction`);
    if (!/devices rebuild ABORTED: unknown live column/.test(func)) problems.push(`${rel}: rebuild must abort on a live column the payload does not know`);
  }
  if (problems.length) { console.error('verify-devices-rebuild-fence: FAIL'); problems.forEach((p) => console.error('  - ' + p)); process.exit(1); }
  console.log(`verify-devices-rebuild-fence: OK (${FLOWS.length} flows)`); process.exit(0);
}

module.exports = { parseSeedDevicesColumns, parseBootDevicesColumns, migrationAddedDevicesColumns, run };
if (require.main === module) run();
