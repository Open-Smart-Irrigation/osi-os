'use strict';
const crypto = require('node:crypto');

const NORMALIZER_VERSION = 2;

function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// Collapse whitespace only — PRESERVE case. String literals ('A' vs 'a') must fingerprint differently.
function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

async function computeFingerprints(runner) {
  const version = (await runner.all('SELECT sqlite_version() AS v'))[0].v;
  const tag = { normalizer: NORMALIZER_VERSION, sqlite: version };
  const out = [];

  // master DDL captures what PRAGMA omits: table CHECK constraints, partial-index WHERE, defaults.
  const master = await runner.all(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name");
  const ddl = {};
  for (const m of master) ddl[`${m.type}|${m.name}`] = normalizeSql(m.sql);

  for (const { name } of master.filter((m) => m.type === 'table')) {
    const columns = await runner.all(`PRAGMA table_xinfo(${name})`);
    const fks = await runner.all(`PRAGMA foreign_key_list(${name})`);
    const indexes = await runner.all(`PRAGMA index_list(${name})`);
    const indexCols = {};
    for (const idx of indexes) indexCols[idx.name] = await runner.all(`PRAGMA index_xinfo(${idx.name})`);
    out.push({ object_type: 'table', object_name: name,
      fingerprint: hash({ tag, columns, fks, indexes, indexCols, ddl: ddl[`table|${name}`] }) });
  }
  for (const { name } of master.filter((m) => m.type === 'index')) {
    out.push({ object_type: 'index', object_name: name,
      fingerprint: hash({ tag, ddl: ddl[`index|${name}`] }) });
  }
  for (const { name } of master.filter((m) => m.type === 'trigger')) {
    out.push({ object_type: 'trigger', object_name: name,
      fingerprint: hash({ tag, body: ddl[`trigger|${name}`] }) });
  }
  return out;
}

module.exports = { computeFingerprints, NORMALIZER_VERSION };
