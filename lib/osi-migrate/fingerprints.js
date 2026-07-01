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

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function computeFingerprints(runner) {
  const tag = { normalizer: NORMALIZER_VERSION };
  const out = [];

  // master DDL captures what PRAGMA omits: table CHECK constraints, partial-index WHERE, defaults.
  const master = await runner.all(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name");
  const ddl = {};
  for (const m of master) ddl[`${m.type}|${m.name}`] = normalizeSql(m.sql);

  for (const { name } of master.filter((m) => m.type === 'table')) {
    const quotedName = quoteIdent(name);
    const columns = await runner.all(`PRAGMA table_xinfo(${quotedName})`);
    const fks = await runner.all(`PRAGMA foreign_key_list(${quotedName})`);
    const indexes = await runner.all(`PRAGMA index_list(${quotedName})`);
    const indexCols = {};
    for (const idx of indexes) indexCols[idx.name] = await runner.all(`PRAGMA index_xinfo(${quoteIdent(idx.name)})`);
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

module.exports = { computeFingerprints, NORMALIZER_VERSION, quoteIdent };
