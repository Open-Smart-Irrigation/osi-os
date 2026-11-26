#!/usr/bin/env node
// SQLite decimal-literal-to-REAL sweep (sqlite3AtoF).
//
//   node atof-sweep.js gen [count] > spellings.txt
//   node atof-sweep.js run <sqlite3 module dir> < spellings.txt > bits.tsv
//   node atof-sweep.js diff a.tsv b.tsv
//
// gen writes deterministic JS String() spellings of positive fractional
// doubles from 1e-320 to 1e20 (log-uniform, plus the normal boundary).
// run evaluates each spelling as an SQL literal, as the shipped flows embed
// numbers, in an in-memory database through the given node-sqlite3 module, and
// prints "<spelling>\t<16 hex digits of the stored double>\t<sqlite version>".
// It opens no file database. Use the same spellings file on every engine.
'use strict';

const fs = require('fs');

function bits(n) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

function gen(count) {
  let state = 0x2545f4914f6cdd1dn;
  const next = () => {
    state ^= state << 13n; state &= (1n << 64n) - 1n;
    state ^= state >> 7n;
    state ^= state << 17n; state &= (1n << 64n) - 1n;
    return Number(state >> 11n) / 2 ** 53;
  };
  const out = new Set();
  const view = new DataView(new ArrayBuffer(8));
  for (const edge of [0x0010000000000000n, 0x000fffffffffffffn]) {
    for (let d = -200n; d <= 200n; d++) {
      view.setBigUint64(0, edge + d);
      out.add(String(view.getFloat64(0)));
    }
  }
  while (out.size < count) {
    const exponent = -320 + next() * 340;
    const n = 10 ** exponent * (1 + next());
    if (!Number.isFinite(n) || n === 0 || Number.isInteger(n)) continue;
    out.add(String(n));
  }
  process.stdout.write([...out].join('\n') + '\n');
}

function run(moduleDir) {
  const sqlite3 = require(require('path').resolve(moduleDir));
  const spellings = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const db = new sqlite3.Database(':memory:');
  db.get('SELECT sqlite_version() AS v', (err, row) => {
    if (err) throw err;
    const version = row.v;
    const lines = [];
    let i = 0;
    const batch = () => {
      if (i >= spellings.length) {
        process.stdout.write(lines.join('\n') + '\n');
        db.close();
        return;
      }
      const chunk = spellings.slice(i, i + 500);
      const sql = 'SELECT ' + chunk.map((s, k) => `${s} AS c${k}`).join(',');
      db.get(sql, (e, r) => {
        if (e) throw e;
        chunk.forEach((s, k) => lines.push(`${s}\t${bits(r['c' + k])}\t${version}`));
        i += 500;
        batch();
      });
    };
    batch();
  });
}

function diff(a, b) {
  const read = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => l.split('\t')).map(([s, h]) => [s, h]));
  const left = read(a);
  const right = read(b);
  const diffs = [];
  for (const [s, h] of left) {
    if (!right.has(s)) throw new Error(`missing in ${b}: ${s}`);
    if (right.get(s) !== h) diffs.push([s, h, right.get(s)]);
  }
  console.log(JSON.stringify({ compared: left.size, differ: diffs.length, differences: diffs.slice(0, 5000) }));
}

const [mode, arg1, arg2] = process.argv.slice(2);
if (mode === 'gen') gen(Number(arg1 || 100000));
else if (mode === 'run') run(arg1);
else if (mode === 'diff') diff(arg1, arg2);
else { console.error('usage: gen [count] | run <module> | diff a b'); process.exit(2); }
