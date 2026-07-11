#!/usr/bin/env node
'use strict';
// Semantic schema comparator - Option B Stage 0 (issue #88).
// Order/whitespace-insensitive SET comparison of application schema between a
// live DB and reference(N); reference(head) classifies live extras as forward
// drift delivered early by an ensure_* path.
const fs = require('node:fs');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { normalizeSqlClause } = require('../lib/osi-migrate/sql-normalize');

const DEFAULT_ALLOWLIST = { chameleon_readings: ['swt_1', 'swt_2', 'swt_3'] };

const IGNORED_TABLES = new Set(['schema_migrations', 'schema_object_fingerprints', 'sqlite_sequence']);

const FAILING_CLASSES = new Set(['missing', 'changed', 'extra_unknown']);

function q(name) { return `"${String(name).replace(/"/g, '""')}"`; }

function extractChecks(createSql) {
  const checks = [];
  const src = String(createSql || '');
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') depth -= 1;
      j += 1;
    }
    checks.push(normalizeSqlClause(`CHECK (${src.slice(m.index + m[0].length, j - 1)})`));
  }
  return checks.sort();
}

function normalizeIdent(value) {
  return normalizeSqlClause(String(value === null || value === undefined ? '' : value));
}

async function snapshotForeignKeys(runner, tableName) {
  const rows = await runner.all(`PRAGMA foreign_key_list(${q(tableName)})`);
  return rows
    .slice()
    .sort((a, b) => (a.id - b.id) || (a.seq - b.seq))
    .map((fk) => [
      fk.id,
      fk.seq,
      normalizeIdent(fk.table),
      normalizeIdent(fk.from),
      normalizeIdent(fk.to),
      normalizeIdent(fk.on_update),
      normalizeIdent(fk.on_delete),
      normalizeIdent(fk.match),
    ].join('|'));
}

async function snapshotSchema(runner) {
  const master = await runner.all(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const snap = { tables: {}, indexes: {}, triggers: {}, views: {} };
  for (const row of master) {
    if (IGNORED_TABLES.has(row.name) || IGNORED_TABLES.has(row.tbl_name)) continue;
    if (row.type === 'table') {
      const cols = await runner.all(`PRAGMA table_xinfo(${q(row.name)})`);
      const columns = {};
      for (const c of cols) {
        if (c.hidden) continue;
        columns[c.name.toLowerCase()] = [
          c.name.toLowerCase(),
          normalizeSqlClause(c.type || ''),
          c.notnull ? 1 : 0,
          c.dflt_value === null || c.dflt_value === undefined ? '' : normalizeSqlClause(String(c.dflt_value)),
          c.pk ? 1 : 0,
        ].join('|');
      }
      const sorted = {};
      for (const k of Object.keys(columns).sort()) sorted[k] = columns[k];
      snap.tables[row.name] = {
        columns: sorted,
        checks: extractChecks(row.sql),
        foreignKeys: await snapshotForeignKeys(runner, row.name),
      };
    } else if (row.type === 'index') {
      if (row.sql === null) continue;
      const xinfo = await runner.all(`PRAGMA index_xinfo(${q(row.name)})`);
      const list = await runner.all(`PRAGMA index_list(${q(row.tbl_name)})`);
      const meta = list.find((x) => x.name === row.name) || {};
      const cols = xinfo.filter((x) => x.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
        .map((x) => (x.name || `expr${x.seqno}`).toLowerCase());
      snap.indexes[row.name] = `table=${row.tbl_name.toLowerCase()}|unique=${meta.unique ? 1 : 0}|cols=${cols.join(',')}`;
    } else if (row.type === 'trigger') {
      snap.triggers[row.name] = normalizeSqlClause(row.sql);
    } else if (row.type === 'view') {
      snap.views[row.name] = normalizeSqlClause(row.sql);
    }
  }
  return snap;
}

function sameList(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameTable(a, b) {
  return JSON.stringify(a.columns) === JSON.stringify(b.columns)
    && sameList(a.checks, b.checks)
    && sameList(a.foreignKeys, b.foreignKeys);
}

function compareSchemas(liveSnap, refSnap, headSnap = null, allowlist = DEFAULT_ALLOWLIST) {
  const diffs = [];
  const add = (cls, kind, name, detail) => diffs.push({ class: cls, kind, name, detail });

  for (const t of Object.keys(refSnap.tables)) {
    if (!liveSnap.tables[t]) add('missing', 'table', t, 'reference table absent from live DB');
  }
  for (const t of Object.keys(liveSnap.tables)) {
    if (refSnap.tables[t]) continue;
    const headT = headSnap && headSnap.tables[t];
    if (headT && sameTable(liveSnap.tables[t], headT)) {
      add('extra_forward', 'table', t, 'identical to the reference(head) table introduced after N');
    } else {
      add('extra_unknown', 'table', t, 'live-only table with no identical reference(head) counterpart');
    }
  }
  for (const t of Object.keys(liveSnap.tables)) {
    const ref = refSnap.tables[t];
    if (!ref) continue;
    const live = liveSnap.tables[t];
    const allowCols = new Set((allowlist[t] || []).map((c) => c.toLowerCase()));
    for (const c of Object.keys(ref.columns)) {
      if (!(c in live.columns)) add('missing', 'column', `${t}.${c}`, `reference: ${ref.columns[c]}`);
      else if (live.columns[c] !== ref.columns[c]) add('changed', 'column', `${t}.${c}`, `live=${live.columns[c]} ref=${ref.columns[c]}`);
    }
    for (const c of Object.keys(live.columns)) {
      if (c in ref.columns) continue;
      if (allowCols.has(c)) {
        add('extra_allowlisted', 'column', `${t}.${c}`, 'named allowlist: verified-dead live-only column');
        continue;
      }
      const headT = headSnap && headSnap.tables[t];
      if (headT && headT.columns[c] === live.columns[c]) {
        add('extra_forward', 'column', `${t}.${c}`, 'identical to the reference(head) column introduced after N');
      } else {
        add('extra_unknown', 'column', `${t}.${c}`, `live: ${live.columns[c]}`);
      }
    }
    if (!sameList(live.checks, ref.checks)) {
      const liveOnly = live.checks.filter((c) => !ref.checks.includes(c));
      const refOnly = ref.checks.filter((c) => !live.checks.includes(c));
      const headChecks = (headSnap && headSnap.tables[t] && headSnap.tables[t].checks) || [];
      if (refOnly.length === 0 && liveOnly.every((c) => headChecks.includes(c))) {
        add('extra_forward', 'check', t, `live-only CHECKs identical in reference(head): ${liveOnly.join(' ;; ')}`);
      } else {
        add('changed', 'check', t, `liveOnly=[${liveOnly.join(' ;; ')}] refOnly=[${refOnly.join(' ;; ')}]`);
      }
    }
    if (!sameList(live.foreignKeys, ref.foreignKeys)) {
      const liveOnly = live.foreignKeys.filter((fk) => !ref.foreignKeys.includes(fk));
      const refOnly = ref.foreignKeys.filter((fk) => !live.foreignKeys.includes(fk));
      const headFks = (headSnap && headSnap.tables[t] && headSnap.tables[t].foreignKeys) || [];
      if (refOnly.length === 0 && liveOnly.every((fk) => headFks.includes(fk))) {
        add('extra_forward', 'foreign_key', t, `live-only FKs identical in reference(head): ${liveOnly.join(' ;; ')}`);
      } else {
        add('changed', 'foreign_key', t, `liveOnly=[${liveOnly.join(' ;; ')}] refOnly=[${refOnly.join(' ;; ')}]`);
      }
    }
  }
  for (const [kind, key] of [['index', 'indexes'], ['trigger', 'triggers'], ['view', 'views']]) {
    const liveM = liveSnap[key];
    const refM = refSnap[key];
    const headM = headSnap ? headSnap[key] : {};
    for (const n of Object.keys(refM)) {
      if (!(n in liveM)) add('missing', kind, n, 'reference object absent from live DB');
      else if (liveM[n] !== refM[n]) add('changed', kind, n, `live and reference ${kind} content differ (normalized)`);
    }
    for (const n of Object.keys(liveM)) {
      if (n in refM) continue;
      if (headM && headM[n] === liveM[n]) add('extra_forward', kind, n, 'identical to the reference(head) object introduced after N');
      else add('extra_unknown', kind, n, `live-only ${kind} with no identical reference(head) counterpart`);
    }
  }
  const failingCount = diffs.filter((d) => FAILING_CLASSES.has(d.class)).length;
  return { ok: failingCount === 0, diffs, failingCount };
}

async function main() {
  const argv = process.argv.slice(2);
  const paths = [];
  let headDb = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--head-db') headDb = argv[++i];
    else paths.push(argv[i]);
  }
  const [liveDb, refDb] = paths;
  if (!liveDb || !refDb) {
    console.error('usage: semantic-schema-compare.js <live.db> <reference.db> [--head-db <head.db>]');
    process.exit(2);
  }
  for (const p of [liveDb, refDb, headDb].filter(Boolean)) {
    if (!fs.existsSync(p)) {
      console.error(`[compare] refusing: database file does not exist: ${p}`);
      process.exit(2);
    }
  }
  const live = await snapshotSchema(cliRunner(liveDb));
  const ref = await snapshotSchema(cliRunner(refDb));
  const head = headDb ? await snapshotSchema(cliRunner(headDb)) : null;
  const res = compareSchemas(live, ref, head);
  for (const d of res.diffs) console.log(`[${d.class}] ${d.kind} ${d.name} - ${d.detail}`);
  console.log(res.ok ? 'semantic-schema-compare: PASS' : `semantic-schema-compare: FAIL (${res.failingCount} failing diffs)`);
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error(`[compare] ERROR: ${e.message}`); process.exit(2); });
}

module.exports = {
  snapshotSchema,
  compareSchemas,
  extractChecks,
  DEFAULT_ALLOWLIST,
  IGNORED_TABLES,
  FAILING_CLASSES,
};
