#!/usr/bin/env node
'use strict';
// SQLite engine vectors: how the DEVICE's engine renders values in SQL that
// triggers and queries use (JSON functions, printf, CAST, REAL-to-TEXT, date
// functions). The bytes of trigger-built outbox payloads depend on this.
// Must run under the device's Node (20.18.3: node_sqlite3 then uses its bundled
// SQLite 3.44.2; under a newer Node it binds to Node's embedded SQLite).
//   ~/.local/node-v20.18.3-linux-x64/bin/node edge/vectors/generate-sqlite.js [--check]
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const pinned = /OSI_SMOKE_NODE_VERSION:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, '.github/workflows/release-smoke.yml'), 'utf8'))[1];
if (process.versions.node !== pinned) { console.error(`run under Node ${pinned} (device engine); this is ${process.versions.node}`); process.exit(2); }
const sqlite3 = Module.createRequire(path.join(ROOT, 'scripts/fixtures/release-smoke/package.json'))('sqlite3');
const reals = ['1e-309', '2e-309', '2.2250738585072009e-308', '-1e-310', '0.0', '-0.0', '1.0', '0.1', '0.2+0.1', '1.23456789012345678', '123456789.123456789', '1e15', '1e16', '1e21', '1e-7', '-1.5e-10',
  '3.14159265358979', '2.5', '100.0', '9007199254740993.0', '1.7976931348623157e308', '4.9e-324', '15.098299999999998', '67.1208', '0.30000000000000004', '1.0/3.0', '2.0/3.0'];
const ints = ['0', '-1', '9007199254740993', '9223372036854775807', '-9223372036854775808'];
const texts = ["'plain'", "'quote\"back\\slash'", "'tab\tnl\n'", "char(0x2028)", "char(0x1f331)", "'<&>'", "''", "char(0xe9)"];
const exprs = [];
for (const v of [...reals, ...ints]) {
  exprs.push(`json_object('v', ${v})`, `json_array(${v})`, `CAST(${v} AS TEXT)`, `printf('%s', ${v})`, `printf('%.15g', ${v})`, `printf('%!.17g', ${v})`, `quote(${v})`, `json(${v})`, `(${v}) || ''`, `typeof(${v})`);
}
for (const t of texts) exprs.push(`json_object('t', ${t})`, `json_quote(${t})`, `quote(${t})`);
exprs.push(`json_object('a', json('{"b":1,"a":[1.0,2.50,-0.0]}'))`, `json('{"x":1e21,"y":1.0}')`, `json_extract('{"x":1.5}', '$.x')`,
  `json_set('{"a":1}', '$.b', 2.0)`, `json_group_array(x) FROM (SELECT 1.0 AS x UNION ALL SELECT 2.5)`, `json_object('n', NULL, 't', 1=1)`,
  `strftime('%Y-%m-%dT%H:%M:%fZ', '2026-11-23 17:03:41.6449')`, `datetime('2026-11-23T19:03:41+02:00')`, `julianday('2026-11-23')`,
  `round(2.5)`, `round(-2.5)`, `round(0.5)`, `round(1.005, 2)`, `CAST('1e3' AS INTEGER)`, `CAST(' 12 ' AS REAL)`, `1/0`, `5 % 3.0`, `abs(-0.0)`,
  `lower('ÄÉ')`, `upper('straße')`, `length(char(0x1f331))`, `hex(char(0x1f331))`);
const db = new sqlite3.Database(':memory:');
const all = (sql) => new Promise((res) => db.all(sql, (e, rows) => res(e ? { error: e.message } : rows)));
(async () => {
  const version = (await all('SELECT sqlite_version() AS v'))[0].v;
  const vectors = [];
  for (const e of exprs) {
    const sql = /\bFROM\b/.test(e) ? `SELECT ${e}` : `SELECT ${e} AS r`;
    const rows = await all(sql);
    if (rows.error) { vectors.push({ sql, error: rows.error }); continue; }
    const r = Object.values(rows[0])[0];
    vectors.push({ sql, type: r === null ? 'null' : typeof r, text: r === null ? null : String(r), jsNumberBits: typeof r === 'number' ? Buffer.from(new Float64Array([r]).buffer).reverse().toString('hex') : undefined });
  }
  const body = { meta: { generator: 'edge/vectors/generate-sqlite.js', sqlite: version, node: process.versions.node }, about: 'Value rendering of the device SQLite engine. A backend that writes through triggers or SQL must produce identical text.', vectors };
  const file = path.join(__dirname, 'sqlite-engine.vectors.json'), text = JSON.stringify(body, null, 1) + '\n';
  if (process.argv.includes('--check')) { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { console.error('STALE sqlite-engine.vectors.json'); process.exit(1); } }
  else fs.writeFileSync(file, text);
  console.log('sqlite-engine.vectors.json', vectors.length, 'engine', version);
})();
