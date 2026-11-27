'use strict';
// Out-of-process database reader (node:sqlite, read-only). Never loaded into a
// backend process. Rows are keyed by rowid where a table has one.
const { DatabaseSync } = require('node:sqlite');

function snapshot(file) {
  // Integers are read as bigint so values past 2^53 survive; safe ones go back
  // to numbers, so ordinary cassettes are unchanged.
  const db = new DatabaseSync(file, { readOnly: true, readBigInts: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const out = {};
    for (const t of tables) {
      const q = '"' + t.name.replace(/"/g, '""') + '"';
      const withoutRowid = /WITHOUT\s+ROWID/i.test(t.sql || '');
      const rows = db.prepare(withoutRowid ? `SELECT * FROM ${q}` : `SELECT rowid AS __rowid, * FROM ${q} ORDER BY rowid`).all();
      out[t.name] = rows.map(numbers);
    }
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name").all().map(numbers);
    return { tables: out, schema };
  } finally { db.close(); }
}

function numbers(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    o[k] = typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  return o;
}

// Unsafe integers stay bigint: compare and key them by their decimal text.
const text = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? { '<bigint>': v.toString() } : v);

function rowKey(r, i) { return r.__rowid !== undefined ? String(r.__rowid) : text(r); }

function diff(before, after) {
  const changes = {};
  const names = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  for (const name of [...names].sort()) {
    const a = new Map((before.tables[name] || []).map((r, i) => [rowKey(r, i), r]));
    const b = new Map((after.tables[name] || []).map((r, i) => [rowKey(r, i), r]));
    const added = [], removed = [], changed = [];
    for (const [k, r] of b) {
      if (!a.has(k)) added.push(r);
      else {
        const old = a.get(k), cols = {};
        for (const c of new Set([...Object.keys(old), ...Object.keys(r)])) {
          if (text(old[c]) !== text(r[c])) cols[c] = { from: old[c], to: r[c] };
        }
        if (Object.keys(cols).length) changed.push({ __rowid: r.__rowid, cols });
      }
    }
    for (const [k, r] of a) if (!b.has(k)) removed.push(r);
    if (added.length || removed.length || changed.length) changes[name] = { added, removed, changed };
  }
  return changes;
}

// SQLite values to JSON: bigint becomes a tagged string, Uint8Array hex.
function jsonable(v) {
  return JSON.parse(JSON.stringify(v, (k, x) => typeof x === 'bigint' ? { '<bigint>': x.toString() }
    : x instanceof Uint8Array ? { '<blob>': Buffer.from(x).toString('hex') } : x));
}

module.exports = { snapshot, diff, jsonable };
