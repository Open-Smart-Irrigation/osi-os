#!/usr/bin/env node
'use strict';
// Per-column SQLite typeof() census, COUNTS ONLY (CHARTER.md §1.4 point 1):
// evidence for whether a stored-value shape was ever written. Never prints
// a value. Usage: node edge/harness/typeof-census.js <db> [--json]
const { DatabaseSync } = require('node:sqlite');
const file = process.argv[2];
if (!file) { console.error('usage: typeof-census.js <db> [--json]'); process.exit(2); }
const db = new DatabaseSync(file, { readOnly: true });
const q = (n) => '"' + n.replace(/"/g, '""') + '"';
const out = {};
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
  const cols = db.prepare(`PRAGMA table_info(${q(name)})`).all();
  const rows = db.prepare(`SELECT count(*) AS n FROM ${q(name)}`).get().n;
  out[name] = { rows: Number(rows), columns: {} };
  if (!rows) continue;
  for (const c of cols) {
    const counts = {};
    for (const r of db.prepare(`SELECT typeof(${q(c.name)}) AS t, count(*) AS n FROM ${q(name)} GROUP BY 1`).all()) counts[r.t] = Number(r.n);
    out[name].columns[c.name] = { declared: c.type || '', counts };
  }
}
db.close();
if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
for (const [t, v] of Object.entries(out)) {
  if (!v.rows) continue;
  for (const [c, info] of Object.entries(v.columns)) {
    const kinds = Object.keys(info.counts);
    const odd = kinds.length > 1 || (/INT/i.test(info.declared) && kinds.some((k) => k === 'real' || k === 'text')) ? ' MIXED' : '';
    console.log(`${t}.${c} [${info.declared}] ${JSON.stringify(info.counts)}${odd}`);
  }
}
