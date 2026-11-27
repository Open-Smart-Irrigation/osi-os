'use strict';
// Exact, out-of-process comparison of two farm databases for the boot-runner
// parity check. Reads with node:sqlite read-only (Node >= 22.5); never loaded
// into a process that runs the boot node.
//
// - schema: every sqlite_master row (type, name, tbl_name, sql), byte-exact;
//   rootpage is reported separately (page allocation, not content);
// - rows: every table including sqlite_sequence, keyed by rowid (or the
//   primary key for WITHOUT ROWID tables), each cell as typeof() + quote();
// - database pragmas: user_version, application_id, journal_mode,
//   integrity_check, foreign_key_check.
const { DatabaseSync } = require('node:sqlite');

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';

function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const master = db.prepare('SELECT type, name, tbl_name, sql, rootpage FROM sqlite_master ORDER BY type, name').all();
    const schema = new Map(master.map((r) => [r.type + '|' + r.name, { tbl_name: r.tbl_name, sql: r.sql }]));
    const rootpages = new Map(master.map((r) => [r.type + '|' + r.name, r.rootpage]));
    const tables = new Map();
    for (const t of master.filter((r) => r.type === 'table')) {
      const cols = db.prepare(`SELECT name, pk FROM pragma_table_xinfo(${"'" + t.name.replace(/'/g, "''") + "'"})`).all();
      const withoutRowid = /WITHOUT\s+ROWID\s*$/i.test(String(t.sql || '').trim());
      const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const sel = cols.map((c) => `typeof(${qi(c.name)}) || ':' || quote(${qi(c.name)}) AS ${qi(c.name)}`).join(', ');
      const keyExpr = withoutRowid ? pk.map((c) => `quote(${qi(c)})`).join(" || '|' || ") : 'rowid';
      const rows = db.prepare(`SELECT ${keyExpr} AS __key, ${sel} FROM ${qi(t.name)} ORDER BY ${withoutRowid ? pk.map(qi).join(', ') : 'rowid'}`).all();
      const map = new Map();
      for (const r of rows) { const { __key, ...cells } = r; map.set(String(__key), cells); }
      tables.set(t.name, map);
    }
    const one = (sql) => Object.values(db.prepare(sql).get() || {})[0];
    const pragmas = {
      user_version: one('PRAGMA user_version'),
      application_id: one('PRAGMA application_id'),
      journal_mode: one('PRAGMA journal_mode'),
      integrity_check: db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join(';'),
      foreign_key_check: db.prepare('PRAGMA foreign_key_check').all().length,
    };
    return { schema, rootpages, tables, pragmas };
  } finally { db.close(); }
}

// Differences as a flat list of keys: "schema|<type|name>", "pragma|<name>",
// "row|<table>|<key>" (row on one side only) and "cell|<table>|<key>|<column>".
function diff(a, b) {
  const out = [];
  for (const k of new Set([...a.schema.keys(), ...b.schema.keys()])) {
    const x = a.schema.get(k), y = b.schema.get(k);
    if (!x || !y || x.sql !== y.sql || x.tbl_name !== y.tbl_name) out.push({ key: 'schema|' + k, a: x && x.sql, b: y && y.sql });
  }
  for (const k of Object.keys(a.pragmas)) {
    if (a.pragmas[k] !== b.pragmas[k]) out.push({ key: 'pragma|' + k, a: a.pragmas[k], b: b.pragmas[k] });
  }
  for (const t of new Set([...a.tables.keys(), ...b.tables.keys()])) {
    const x = a.tables.get(t) || new Map(), y = b.tables.get(t) || new Map();
    for (const k of new Set([...x.keys(), ...y.keys()])) {
      const rx = x.get(k), ry = y.get(k);
      if (!rx || !ry) { out.push({ key: `row|${t}|${k}`, a: rx || null, b: ry || null }); continue; }
      for (const c of new Set([...Object.keys(rx), ...Object.keys(ry)])) {
        if (rx[c] !== ry[c]) out.push({ key: `cell|${t}|${k}|${c}`, a: rx[c], b: ry[c] });
      }
    }
  }
  return out;
}

function rootpageDiff(a, b) {
  const out = [];
  for (const k of new Set([...a.rootpages.keys(), ...b.rootpages.keys()])) if (a.rootpages.get(k) !== b.rootpages.get(k)) out.push(k);
  return out;
}

// What a boot changed relative to its input, per table (for the inventory).
function effects(before, after) {
  const d = diff(before, after);
  const summary = { schema: [], tables: {} };
  for (const x of d) {
    const [kind, t, , col] = x.key.split('|');
    if (kind === 'schema') summary.schema.push(x.key.slice(7) + (x.a == null ? ' (added)' : x.b == null ? ' (dropped)' : ' (changed)'));
    else if (kind === 'row' || kind === 'cell') {
      const s = summary.tables[t] || (summary.tables[t] = { rows_added: 0, rows_removed: 0, cells_changed: 0, columns: {} });
      if (kind === 'row') { if (x.a == null) s.rows_added++; else s.rows_removed++; }
      else { s.cells_changed++; s.columns[col] = (s.columns[col] || 0) + 1; }
    } else if (kind === 'pragma') summary['pragma_' + t] = { from: x.a, to: x.b };
  }
  return summary;
}

module.exports = { snapshot, diff, rootpageDiff, effects };
