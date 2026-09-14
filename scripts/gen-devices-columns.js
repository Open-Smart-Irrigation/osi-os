#!/usr/bin/env node
'use strict';
// gen-devices-columns - generates sync-init-fn's DEVICES_COLUMNS table (osi-os#173/#219/#220).
//
// The boot node's devices rebuild must declare exactly what database/seed-blank.sql
// declares, in seed order. That table is never hand-written: this script transcribes it,
// and scripts/gen-devices-columns.test.js asserts that regenerating reproduces what both
// profiles ship, so the committed table cannot drift from the seed silently.
//
// Per column:
//   ddl   always the seed's own declaration, whitespace-collapsed.
//   from  the live columns a value may be copied from, most-preferred first. Not derivable
//         from the seed - the legacy dendrometer aliases are historical knowledge - so an
//         existing entry's `from` is preserved, and a column new to the seed gets [name].
//   dflt  the SQL literal used when none of `from` exists on the source. Taken from the
//         seed's own DEFAULT when it has one; otherwise preserved from the existing entry,
//         else NOT_NULL_FALLBACKS, else NULL. A NOT NULL column may never end up NULL.
//
// Usage:
//   node scripts/gen-devices-columns.js            # rewrite both profiles in place
//   node scripts/gen-devices-columns.js --check    # exit 1 if either profile is stale

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(REPO, p));

// Seed NOT NULL columns that carry no DEFAULT of their own. Copying a source that lacks
// one of these would violate the constraint, so each needs an explicit non-NULL literal.
const NOT_NULL_FALLBACKS = {
  deveui: "''",
  name: "''",
  type_id: "'KIWI_SENSOR'",
  created_at: "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  updated_at: "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
};

// Legacy column aliases the pre-#219 positional copy carried as COALESCE(...) pairs. Only
// used to bootstrap an entry that does not exist yet; a shipped entry's `from` wins.
const LEGACY_SOURCES = {
  dendro_ratio_at_retracted: ['dendro_ratio_at_retracted', 'dendro_ratio_zero'],
  dendro_ratio_at_extended: ['dendro_ratio_at_extended', 'dendro_ratio_span'],
};

function balancedBody(text, openIdx) {
  let depth = 0, inStr = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) { if (ch === "'") { if (text[i + 1] === "'") i += 1; else inStr = false; } continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  throw new Error('unbalanced parentheses');
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

const TABLE_CONSTRAINT = /^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;

function seedColumns(seedSql) {
  const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?devices\s*\(/i.exec(seedSql);
  if (!m) throw new Error('CREATE TABLE devices not found in the seed');
  const cols = [];
  for (const part of splitTopLevel(balancedBody(seedSql, seedSql.indexOf('(', m.index + m[0].length - 1)))) {
    if (TABLE_CONSTRAINT.test(part)) break;
    const text = part.trim().replace(/\s+/g, ' ');
    if (text) cols.push({ name: text.split(/\s/)[0], ddl: text });
  }
  return cols;
}

// The seed's own DEFAULT literal for a column declaration, or null. Only simple literals
// are read: a DEFAULT (expression) is not something the copy builder can inline safely.
function seedDefault(ddl) {
  const m = /\bDEFAULT\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE|CURRENT_TIMESTAMP)/i.exec(ddl);
  if (!m) return null;
  return /^null$/i.test(m[1]) ? null : m[1];
}

const START_MARKER = 'const DEVICES_COLUMNS = [';

function shippedTable(funcText) {
  const start = funcText.indexOf(START_MARKER);
  if (start < 0) return new Map();
  const open = funcText.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < funcText.length; i += 1) {
    if (funcText[i] === '[') depth += 1;
    else if (funcText[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('unterminated DEVICES_COLUMNS array literal');
  const entries = new Function(`'use strict'; return (${funcText.slice(open, end + 1)});`)();
  return new Map(entries.map((e) => [e.name, e]));
}

function entryFor(col, prior) {
  const existing = prior.get(col.name);
  const from = (existing && existing.from) || LEGACY_SOURCES[col.name] || [col.name];
  const dflt = seedDefault(col.ddl)
    || (existing && existing.dflt !== 'NULL' ? existing.dflt : null)
    || NOT_NULL_FALLBACKS[col.name]
    || 'NULL';
  return { name: col.name, ddl: col.ddl, from, dflt };
}

function renderTable(entries) {
  return [
    '// DEVICES_COLUMNS is a mechanical transcription of the devices table declaration',
    '// in database/seed-blank.sql, in seed order (osi-os#173/#219/#220; see',
    '// docs/superpowers/plans/2026-09-12-boot-node-schema-safety.md). Never hand-edit:',
    '// regenerate with scripts/gen-devices-columns.js, which its own test re-runs to',
    '// prove the shipped table still matches the seed in both profiles.',
    START_MARKER,
    ...entries.map((e) => '  { name: ' + JSON.stringify(e.name) + ', ddl: ' + JSON.stringify(e.ddl)
      + ', from: [' + e.from.map((f) => JSON.stringify(f)).join(', ') + ']'
      + ', dflt: ' + JSON.stringify(e.dflt) + ' },'),
    '];',
    "const DEVICES_TABLE_CONSTRAINTS = 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL, FOREIGN KEY (farm_id) REFERENCES farms(farm_id) ON DELETE SET NULL';",
    "const DEVICES_NEW_DDL = 'CREATE TABLE IF NOT EXISTS devices_new (' + DEVICES_COLUMNS.map((c) => c.ddl).join(', ') + ', ' + DEVICES_TABLE_CONSTRAINTS + ')';",
    '// Named INSERT built from the live column set: absent source columns fall back to dflt,',
    '// so a pre-0026 devices table rebuilds instead of aborting on every boot (#220).',
    "const buildDevicesCopySql = (present) => 'INSERT INTO devices_new (' + DEVICES_COLUMNS.map((c) => c.name).join(',') + ') SELECT ' + DEVICES_COLUMNS.map((c) => { const have = c.from.filter((f) => present.has(f)); if (have.length === 0) return c.dflt; if (have.length === 1 && c.dflt === 'NULL') return have[0]; return 'COALESCE(' + have.join(',') + ',' + c.dflt + ')'; }).join(',') + ' FROM devices';",
  ].join('\n');
}

// Replaces the DEVICES_COLUMNS block in a sync-init-fn func with a freshly generated one.
// Idempotent by construction: regenerating an up-to-date func returns it unchanged.
function regenerateFunc(funcText, seedSql) {
  const entries = seedColumns(seedSql).map((c) => entryFor(c, shippedTable(funcText)));
  const block = renderTable(entries);
  const lines = funcText.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('// DEVICES_COLUMNS is a mechanical'));
  const end = lines.findIndex((l) => l.startsWith('const buildDevicesCopySql = '));
  if (start < 0 || end < start) throw new Error('DEVICES_COLUMNS block not found in sync-init-fn');
  lines.splice(start, end - start + 1, block);
  const out = lines.join('\n');
  new Function('osiDb', 'env', 'node', 'msg', out); // must still parse as JS
  return out;
}

function regenerateProfile(flowsPath, seedSql) {
  const raw = fs.readFileSync(flowsPath, 'utf8');
  const flows = JSON.parse(raw);
  const node = flows.find((n) => n && n.id === 'sync-init-fn');
  if (!node) throw new Error(`${flowsPath}: sync-init-fn not found`);
  const next = regenerateFunc(node.func, seedSql);
  if (next === node.func) return { changed: false, text: raw };
  node.func = next;
  return { changed: true, text: JSON.stringify(flows, null, 2) + '\n' };
}

function run(argv) {
  const check = argv.includes('--check');
  const seedSql = fs.readFileSync(SEED, 'utf8');
  const stale = [];
  for (const flowsPath of PROFILES) {
    const { changed, text } = regenerateProfile(flowsPath, seedSql);
    const rel = path.relative(REPO, flowsPath);
    if (!changed) { console.log(`OK ${rel} (DEVICES_COLUMNS matches database/seed-blank.sql)`); continue; }
    if (check) { stale.push(rel); continue; }
    fs.writeFileSync(flowsPath, text);
    console.log(`rewrote ${rel}`);
  }
  if (stale.length) {
    console.error('gen-devices-columns: FAIL - stale DEVICES_COLUMNS in:');
    stale.forEach((r) => console.error('  - ' + r));
    console.error('Run: node scripts/gen-devices-columns.js');
    process.exit(1);
  }
  console.log('gen-devices-columns: OK');
}

module.exports = { regenerateFunc, seedColumns, seedDefault, shippedTable, renderTable, run };
if (require.main === module) run(process.argv.slice(2));
