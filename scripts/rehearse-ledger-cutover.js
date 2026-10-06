#!/usr/bin/env node
'use strict';
// Rehearses the edge schema cutover of a gateway whose migration ledger was
// stamped under an earlier lineage's numbering, on a COPY of its database:
//
//   reconcile --report -> reconcile --apply -> migrate-cli -> verify-head
//   -> devices-rebuild rehearsal x2 (on a scratch copy) -> boot node
//   -> verify-head -> integrity_check / foreign_key_check -> schema vs seed
//   -> per-table row counts and content hashes (before, after the migrations,
//      after the boot node) -> a second full pass that must change nothing.
//
//   node scripts/rehearse-ledger-cutover.js --db <pulled copy of farming.db> --work <scratch directory>
//       [--gateway-eui <16 hex>] [--allow-dirty] [--json]
//
// The report records the checkout (HEAD, `git status --porcelain`, and the
// sha256 of CHECKSUMS.json, the boot node text, seed-blank.sql, the lineage
// fixture manifests and this tool, plus node and sqlite versions). A dirty
// checkout fails the rehearsal unless --allow-dirty is given (trial runs).
//
// The source file is never opened: it (and a -wal next to it, if any) is
// copied into <work> first and only the copy is changed. --work must be an
// empty directory, a new path, or a directory an earlier run of this script
// created (it holds the marker file); an earlier run's files in it are
// replaced, so an interrupted run is restarted cleanly from the pristine copy.
// Paths under /data/db (a gateway's live database directory) are refused for
// --db and --work, after resolving symbolic links.
//
// Every step runs the same code deploy.sh runs on the gateway: the exported
// entry points of scripts/reconcile-ledger-numbering.js, scripts/migrate-cli.js
// and scripts/verify-head-cli.js, scripts/rehearse-devices-rebuild.js as its
// own process, and the shipped `sync-init-fn` boot node text of this
// checkout's flows.json.
//
// The report (<work>/rehearsal-report.json) lists every step with its result
// and duration. Exit status: 0 PASS, 1 FAIL (a step refused or a check failed),
// 2 usage or path guard refusal (nothing was written).
//
// Row changes the migrations make by design are listed in EXPECTED_CHANGES.
// Any other row change, removed table or removed column fails the rehearsal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const FIXTURES_DIR = path.join(REPO, 'scripts/fixtures/lineages');
const SEED_SQL = path.join(REPO, 'database/seed-blank.sql');
const DEVICES_REBUILD_CLI = path.join(REPO, 'scripts/rehearse-devices-rebuild.js');
const BOOT_FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

const LIVE_DB_DIR = '/data/db';
const WORK_MARKER = '.ledger-cutover-rehearsal';
const REPORT_NAME = 'rehearsal-report.json';
const STATE_NAME = 'run-state.json';
// Everything a run creates inside --work; a restart removes exactly these.
const WORK_ENTRIES = [REPORT_NAME, STATE_NAME, 'backups', 'tmp', 'seed.db', 'devices-rehearsal.db'];
const WORK_DB_NAME = 'farming.db';
const SYNTHETIC_GATEWAY_EUI = '0016C001F1000001';

const BOOKKEEPING_TABLES = new Set(['schema_migrations', 'schema_object_fingerprints']);
// Per-row keys are kept for tables up to this size, so a changed table can be
// explained row by row; larger tables are compared by count and hash only.
const ROW_KEYS_LIMIT = 250000;
// Full row values are kept for tables up to this size (validators and the
// changed-column list need them). Tables with a rule for a pending migration
// (`keepValuesFor`) keep every row's values whatever their size, and a snapshot
// taken against an earlier one keeps the values of every new or changed row.
const ROW_VALUES_LIMIT = 20000;

// --- row changes made by design ---------------------------------------------

const LEGACY_STAGE_TO_FAO = {
  budbreak: 'initial', bud_break: 'initial',
  fruitset: 'development', cell_division: 'development', cell_expansion: 'development',
  veraison: 'mid_season', fruit_maturation: 'mid_season',
  harvest: 'late_season', post_harvest: 'late_season',
};

function col(row, columns, name) { return row[columns.indexOf(name)]; }

// 0064: every changed zone had a legacy stage key, now has its FAO-56 key, and
// its sync_version went up by exactly one.
function validateFaoStageKeys({ changedRows, columns }) {
  const problems = [];
  for (const { key, before, after } of changedRows) {
    const legacy = String(col(before, columns, 'phenological_stage') || '').trim().toLowerCase();
    const expected = LEGACY_STAGE_TO_FAO[legacy];
    if (!expected) problems.push(`zone ${key}: stage '${legacy}' is not a legacy key`);
    else if (col(after, columns, 'phenological_stage') !== expected) problems.push(`zone ${key}: stage '${col(after, columns, 'phenological_stage')}' is not '${expected}'`);
    if (col(before, columns, 'deleted_at') !== null) problems.push(`zone ${key}: deleted zone changed`);
    const vb = BigInt(col(before, columns, 'sync_version') || 0);
    const va = BigInt(col(after, columns, 'sync_version') || 0);
    if (va !== vb + 1n) problems.push(`zone ${key}: sync_version ${vb} -> ${va}, expected +1`);
  }
  return problems;
}

// The cloud link as the earlier snapshot holds it (sync_link_state is small,
// so its values are always kept).
function linkOf(snapshot) {
  const t = snapshot && snapshot.tables.sync_link_state;
  if (!t || !t.rows) return { linked: false, eui: null };
  for (const { v } of t.rows.values()) {
    if (v && col(v, t.columns, 'peer_node') === 'cloud') {
      return { linked: BigInt(col(v, t.columns, 'linked') || 0) === 1n, eui: String(col(v, t.columns, 'gateway_device_eui') || '').trim() || null };
    }
  }
  return { linked: false, eui: null };
}

// 0064: when 0064 runs, the only AFTER UPDATE trigger on irrigation_zones is
// 0058's trg_sync_zones_outbox_au. With the cloud link up it writes exactly
// one ZONE_CONFIG_UPSERTED event per changed zone, stamped with the gateway
// EUI, whose payload carries the new stage and sync_version; without the link
// it writes nothing.
function validateZoneOutbox({ addedRows, columns, context }) {
  const problems = [];
  const zoneChanges = context.changedKeysByTable.get('irrigation_zones');
  const changedZones = new Map();
  for (const r of (zoneChanges ? zoneChanges.changedRows : [])) {
    if (!r.after) { problems.push('changed zone values not kept'); continue; }
    changedZones.set(col(r.after, zoneChanges.columns, 'zone_uuid'), {
      stage: col(r.after, zoneChanges.columns, 'phenological_stage'),
      version: String(col(r.after, zoneChanges.columns, 'sync_version')),
    });
  }
  const link = linkOf(context.before);
  if (!link.linked) {
    if (addedRows.length) problems.push(`${addedRows.length} ZONE outbox row(s) although the cloud link is down (the zone trigger writes none)`);
    return problems;
  }
  const byZone = new Map();
  for (const row of addedRows) {
    const zone = col(row, columns, 'aggregate_key');
    if (!changedZones.has(zone)) problems.push(`outbox row for zone ${zone}, which 0064 did not change`);
    byZone.set(zone, (byZone.get(zone) || []).concat([row]));
  }
  for (const [zone, expected] of changedZones) {
    const events = byZone.get(zone) || [];
    if (events.length !== 1) { problems.push(`zone ${zone}: ${events.length} outbox event(s), expected exactly 1`); continue; }
    const row = events[0];
    const op = col(row, columns, 'op');
    if (op !== 'ZONE_CONFIG_UPSERTED') problems.push(`zone ${zone}: event op ${op}, expected ZONE_CONFIG_UPSERTED`);
    const eui = String(col(row, columns, 'gateway_device_eui') || '').trim();
    if (!eui) problems.push(`zone ${zone}: event has no gateway_device_eui`);
    else if (eui !== link.eui) problems.push(`zone ${zone}: event EUI ${eui} is not the link EUI ${link.eui}`);
    if (columns.includes('sync_version') && String(col(row, columns, 'sync_version')) !== expected.version) {
      problems.push(`zone ${zone}: event sync_version ${col(row, columns, 'sync_version')}, zone has ${expected.version}`);
    }
    let payload = null;
    try { payload = JSON.parse(String(col(row, columns, 'payload_json'))); } catch (_) { /* reported below */ }
    if (!payload) problems.push(`zone ${zone}: event payload is not JSON`);
    else {
      if (payload.phenological_stage !== expected.stage) problems.push(`zone ${zone}: payload stage ${payload.phenological_stage}, zone has ${expected.stage}`);
      if (String(payload.sync_version) !== expected.version) problems.push(`zone ${zone}: payload sync_version ${payload.sync_version}, zone has ${expected.version}`);
    }
  }
  return problems;
}

function validateCatalogState({ changedRows, columns }) {
  const problems = [];
  for (const { before, after } of changedRows) {
    if (BigInt(col(after, columns, 'catalog_version')) < BigInt(col(before, columns, 'catalog_version'))) {
      problems.push('catalog_version went down');
    }
  }
  return problems;
}

// Keyed by migration version. A rule allows, for one table, changes to the
// listed columns of existing rows (`columns`), new rows (`append`, optionally
// limited to column values), or both. Migrations without an entry may not
// change any existing row. New tables and new columns are always allowed (the
// schema comparison against the seed judges them).
const EXPECTED_CHANGES = {
  64: {
    name: '0064__fao56_stage_keys.sql',
    rules: [
      { table: 'irrigation_zones', columns: ['phenological_stage', 'sync_version', 'updated_at'], validate: validateFaoStageKeys },
      { table: 'sync_outbox', append: { aggregate_type: ['ZONE'] }, validate: validateZoneOutbox },
    ],
  },
  70: {
    name: '0070__journal_catalog_v11.sql',
    rules: [
      { table: 'journal_templates', append: true },
      { table: 'journal_layouts', append: true },
      { table: 'journal_catalog_state', columns: ['catalog_version', 'catalog_hash', 'updated_at'], append: true, validate: validateCatalogState },
    ],
  },
};

// --- argument and path guards -----------------------------------------------

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { db: null, work: null, gatewayEui: null, json: false, allowDirty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') options.db = argv[++i];
    else if (arg === '--work') options.work = argv[++i];
    else if (arg === '--gateway-eui') options.gatewayEui = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else throw new UsageError('unknown argument ' + arg);
  }
  if (!options.db || !options.work) throw new UsageError('usage: rehearse-ledger-cutover.js --db <copy of farming.db> --work <scratch directory> [--gateway-eui <16 hex>] [--allow-dirty] [--json]');
  if (options.gatewayEui !== null && !/^[0-9A-Fa-f]{16}$/.test(options.gatewayEui)) throw new UsageError('--gateway-eui must be 16 hex digits');
  return options;
}

// The real path of p, also when p does not exist yet: the nearest existing
// parent is resolved, and a link whose target is missing is followed.
// (Same guard as scripts/rehearse-history-queue-drain.js.)
function realPath(p, depth = 0) {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch (_) {
    if (depth > 40) throw new UsageError('too many symbolic links: ' + p);
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    const resolvedParent = realPath(parent, depth + 1);
    const candidate = path.join(resolvedParent, path.basename(absolute));
    let link = null;
    try { link = fs.readlinkSync(candidate); } catch (_) { /* not a link: a path that does not exist yet */ }
    return link === null ? candidate : realPath(path.resolve(resolvedParent, link), depth + 1);
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Checks --db and --work before anything is written. Returns resolved paths
// and whether an earlier run left a 'running' state behind (interrupted).
function checkPaths(options) {
  const work = realPath(options.work);
  const source = realPath(options.db);
  const liveDirs = [LIVE_DB_DIR, realPath(LIVE_DB_DIR)];
  for (const p of [work, source]) {
    if (liveDirs.some((dir) => isInside(p, dir))) throw new UsageError('refusing a path under ' + LIVE_DB_DIR + ' (' + p + '); pull a copy first');
  }
  if (isInside(source, work)) throw new UsageError('--work must not contain --db (' + source + ')');
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new UsageError('--db is not a file: ' + source);
  const header = Buffer.alloc(16);
  const fd = fs.openSync(source, 'r');
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (header.toString('latin1') !== 'SQLite format 3\u0000') throw new UsageError('--db is not an SQLite database: ' + source);
  let interrupted = false;
  if (fs.existsSync(work)) {
    if (!fs.statSync(work).isDirectory()) throw new UsageError('--work must be a scratch directory, not a file (' + work + ')');
    const entries = fs.readdirSync(work);
    if (entries.length && !entries.includes(WORK_MARKER)) {
      throw new UsageError('--work is not empty and was not created by this script (no ' + WORK_MARKER + ' in ' + work + ')');
    }
    try {
      interrupted = JSON.parse(fs.readFileSync(path.join(work, STATE_NAME), 'utf8')).status === 'running';
    } catch (_) { /* no earlier state */ }
  }
  return { work, source, interrupted };
}

// Creates --work (or empties an earlier run's files from it) and marks it.
function prepareWork(work) {
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, WORK_MARKER), 'Scratch directory of scripts/rehearse-ledger-cutover.js; every run replaces its files.\n');
  for (const entry of fs.readdirSync(work)) {
    if (entry === WORK_MARKER) continue;
    if (WORK_ENTRIES.includes(entry) || entry === WORK_DB_NAME || entry.startsWith(WORK_DB_NAME + '-') || entry.startsWith(WORK_DB_NAME + '.')) {
      fs.rmSync(path.join(work, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.join(work, 'backups'));
  fs.mkdirSync(path.join(work, 'tmp'));
}

// --- checkout provenance -------------------------------------------------------

// HEAD and the porcelain status (untracked files included: an untracked
// migration file is read like a tracked one).
function gitState(dir) {
  try {
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const porcelain = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((l) => l.trim());
    return { head, dirty: porcelain.length > 0, porcelain: porcelain.slice(0, 200) };
  } catch (_) {
    return { head: null, dirty: true, porcelain: ['not a git checkout'] };
  }
}

// What the rehearsal actually runs from this working tree, hashed, so a report
// proves the exact migration set, boot node, seed and tool versions.
function checkoutProvenance() {
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const bootNode = JSON.parse(fs.readFileSync(BOOT_FLOWS, 'utf8')).find((n) => n.id === 'sync-init-fn');
  const lineageFixtures = {};
  if (fs.existsSync(FIXTURES_DIR)) {
    for (const dir of fs.readdirSync(FIXTURES_DIR).sort()) {
      const manifest = path.join(FIXTURES_DIR, dir, 'CHECKSUMS.json');
      if (fs.existsSync(manifest)) lineageFixtures[dir] = sha(manifest);
    }
  }
  let nodeSqlite = null;
  try {
    const db = new DatabaseSync(':memory:');
    nodeSqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
    db.close();
  } catch (_) { /* reported as null */ }
  let sqlite3Cli = null;
  try { sqlite3Cli = execFileSync('sqlite3', ['--version'], { encoding: 'utf8' }).trim(); } catch (_) { /* reported as null */ }
  return {
    checksumsJsonSha256: sha(path.join(MIGRATIONS_DIR, 'CHECKSUMS.json')),
    seedSha256: sha(SEED_SQL),
    bootNodeSha256: bootNode ? crypto.createHash('sha256').update(bootNode.func).digest('hex') : null,
    toolSha256: sha(__filename),
    lineageFixtures,
    node: process.version,
    nodeSqlite,
    sqlite3Cli,
  };
}

// --- small helpers ------------------------------------------------------------

function sha256File(p) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function sqliteJson(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => {
    if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    if (v instanceof Uint8Array) return 'x\'' + Buffer.from(v).toString('hex') + '\'';
    return v;
  }));
}

function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

// --- table snapshots ------------------------------------------------------------

function encodeValue(v) {
  if (v === null || v === undefined) return 'n';
  if (typeof v === 'bigint') return 'i' + v.toString();
  if (typeof v === 'number') return 'r' + String(v);
  if (typeof v === 'string') return 's' + v.length + ':' + v;
  if (v instanceof Uint8Array) return 'b' + Buffer.from(v).toString('hex');
  return 'u' + String(v);
}

// Row counts and content hashes of every table. The hash covers the given
// column list (default: the table's current columns) with typed values, rows
// ordered by primary key (or by every column when there is none), so it does
// not depend on rowids or on physical column order. `columnsFrom` (an earlier
// snapshot) makes the hash cover the earlier column list, so a table rebuilt
// with extra columns still compares equal when no earlier value changed.
function snapshotTables(dbPath, { columnsFrom = null, keepValuesFor = new Set() } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name").all().map((r) => r.name);
    const tables = {};
    for (const name of names) {
      const info = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
      const current = info.map((c) => c.name);
      // sqlite_sequence has no declared key; its rows are keyed by table name.
      const pkNow = name === 'sqlite_sequence' ? ['name'] : info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const earlier = columnsFrom && columnsFrom.tables[name];
      const columns = earlier ? earlier.columns.filter((c) => current.includes(c)) : current;
      const missingColumns = earlier ? earlier.columns.filter((c) => !current.includes(c)) : [];
      const addedColumns = earlier ? current.filter((c) => !earlier.columns.includes(c)) : [];
      const pkEarlier = earlier ? earlier.pk.filter((c) => current.includes(c)) : pkNow;
      const pk = pkEarlier.length ? pkEarlier : [];
      const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get().n);
      const orderBy = (pk.length ? pk : columns).map(quoteIdent).join(', ');
      const stmt = db.prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(name)}${orderBy ? ' ORDER BY ' + orderBy : ''}`);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const pkIdx = pk.map((c) => columns.indexOf(c));
      const keepKeys = count <= ROW_KEYS_LIMIT;
      const keepValues = count <= ROW_VALUES_LIMIT || keepValuesFor.has(name);
      const earlierRows = earlier && earlier.rows;
      const rows = keepKeys ? new Map() : null;
      const hash = crypto.createHash('sha256');
      const seen = new Map();
      for (const row of stmt.iterate()) {
        const encoded = row.map(encodeValue).join('\u001f');
        hash.update(encoded + '\u001e');
        if (!keepKeys) continue;
        let key = pkIdx.length ? pkIdx.map((i) => encodeValue(row[i])).join('\u001f') : encoded;
        if (!pkIdx.length) {
          const n = (seen.get(key) || 0) + 1;
          seen.set(key, n);
          key += '#' + n;
        }
        const h = crypto.createHash('sha256').update(encoded).digest('base64');
        let keep = keepValues;
        if (!keep && earlierRows) {
          const prior = earlierRows.get(key);
          keep = !prior || prior.h !== h;
        }
        rows.set(key, { h, v: keep ? row : null });
      }
      // Rows in an added column must hold its declared default (no migration
      // backfills one unless a rule says so). A non-constant default is
      // recorded as not checked.
      const addedColumnDefaults = addedColumns.map((c) => {
        const dflt = info.find((x) => x.name === c).dflt_value;
        const literal = dflt === null ? 'NULL' : String(dflt).trim().replace(/^\((.*)\)$/s, '$1').trim();
        if (!/^(NULL|TRUE|FALSE|[-+]?\d+(\.\d+)?([eE][-+]?\d+)?|'(?:[^']|'')*')$/i.test(literal)) return { column: c, default: dflt, nonDefaultRows: null };
        const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)} WHERE ${quoteIdent(c)} IS NOT (${literal})`).get().n);
        return { column: c, default: dflt, nonDefaultRows: n };
      });
      tables[name] = { columns, pk, count, sha256: hash.digest('hex'), rows, missingColumns, addedColumns, addedColumnDefaults };
    }
    return { tables };
  } finally {
    db.close();
  }
}

function summarizeSnapshot(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.tables).map(([name, t]) => [name, { count: t.count, sha256: t.sha256 }]));
}

function ruleTables(versions) {
  return new Set([...rulesFor(versions).keys()]);
}

function rulesFor(appliedVersions) {
  const rules = new Map();
  for (const version of appliedVersions) {
    const entry = EXPECTED_CHANGES[version];
    if (!entry) continue;
    for (const rule of entry.rules) {
      const list = rules.get(rule.table) || [];
      list.push({ ...rule, migration: entry.name });
      rules.set(rule.table, list);
    }
  }
  return rules;
}

function matchesAppendFilter(filter, row, columns) {
  if (filter === true) return true;
  return Object.entries(filter).every(([column, allowed]) => allowed.includes(col(row, columns, column)));
}

// Compares two snapshots. `rules` (from rulesFor) lists the row changes made
// by design; `allowBookkeeping` lets the ledger and fingerprint tables change.
// Everything else must be byte-for-byte equal in the compared columns.
function compareSnapshots(before, after, { rules = new Map(), allowBookkeeping = false } = {}) {
  const result = { unchanged: [], changedByDesign: [], bookkeeping: [], newTables: [], addedColumns: [], unexpected: [] };
  const context = { changedKeysByTable: new Map(), before, after };
  const deferred = [];
  for (const [name, b] of Object.entries(before.tables)) {
    const a = after.tables[name];
    if (!a) { result.unexpected.push({ table: name, reason: 'table removed', countBefore: b.count }); continue; }
    if (a.addedColumns.length) {
      result.addedColumns.push({ table: name, columns: a.addedColumns });
      const ruleColumns = new Set((rules.get(name) || []).flatMap((r) => r.columns || []));
      const filled = (a.addedColumnDefaults || []).filter((d) => d.nonDefaultRows > 0 && !ruleColumns.has(d.column));
      if (filled.length) {
        result.unexpected.push({ table: name, reason: 'added columns hold values other than their declared default: ' + filled.map((d) => `${d.column} (${d.nonDefaultRows} row(s), default ${d.default})`).join(', ') });
      }
    }
    if (a.missingColumns.length) result.unexpected.push({ table: name, reason: 'columns removed: ' + a.missingColumns.join(', ') });
    if (a.count === b.count && a.sha256 === b.sha256 && !a.missingColumns.length) {
      result.unchanged.push(name);
      // A validator can require a change (one outbox event per changed zone),
      // so it runs on an unchanged rule table too.
      if ((rules.get(name) || []).some((r) => r.validate)) {
        deferred.push({ name, unchanged: true, diff: { table: name, countBefore: b.count, countAfter: a.count }, addedRows: [], removedKeys: [], changedRows: [], changedColumns: new Set(), columns: a.columns });
      }
      continue;
    }
    if (BOOKKEEPING_TABLES.has(name) && allowBookkeeping) {
      result.bookkeeping.push({ table: name, countBefore: b.count, countAfter: a.count });
      continue;
    }
    const diff = { table: name, countBefore: b.count, countAfter: a.count };
    if (!b.rows || !a.rows) {
      result.unexpected.push({ ...diff, reason: 'content hash changed (table too large for a row-level diff)' });
      continue;
    }
    const columns = a.columns;
    const addedRows = [];
    const removedKeys = [];
    const changedRows = [];
    for (const [key, rb] of b.rows) {
      const ra = a.rows.get(key);
      if (!ra) removedKeys.push(key);
      else if (ra.h !== rb.h) changedRows.push({ key, before: rb.v, after: ra.v });
    }
    for (const [key, ra] of a.rows) if (!b.rows.has(key)) addedRows.push(ra.v);
    const changedColumns = new Set();
    for (const r of changedRows) {
      if (!r.before || !r.after) { changedColumns.add('(row values not kept)'); continue; }
      columns.forEach((c, i) => { if (encodeValue(r.before[i]) !== encodeValue(r.after[i])) changedColumns.add(c); });
    }
    Object.assign(diff, { rowsAdded: addedRows.length, rowsRemoved: removedKeys.length, rowsChanged: changedRows.length, changedColumns: [...changedColumns].sort() });
    context.changedKeysByTable.set(name, { columns, changedRows });
    deferred.push({ name, diff, addedRows, removedKeys, changedRows, changedColumns, columns });
  }
  for (const [name, a] of Object.entries(after.tables)) {
    if (!before.tables[name]) result.newTables.push({ table: name, count: a.count });
  }
  // sqlite_sequence follows the tables it counts: a row may change or appear
  // for a table that gained rows by design or is new.
  const appendTables = new Set([...rules.entries()].filter(([, list]) => list.some((r) => r.append)).map(([t]) => t));
  for (const t of result.newTables) appendTables.add(t.table);
  for (const d of deferred) {
    const problems = [];
    if (d.name === 'sqlite_sequence') {
      const seqTables = d.changedRows.map((r) => r.after && r.after[0]).concat(d.addedRows.map((r) => r && r[0]));
      const others = seqTables.filter((t) => !appendTables.has(t));
      if (d.removedKeys.length) problems.push('sequence rows removed: ' + d.removedKeys.join(', '));
      if (others.length) problems.push('sequence changed for tables without new rows by design: ' + others.join(', '));
      if (problems.length) result.unexpected.push({ ...d.diff, reason: problems.join('; ') });
      else result.changedByDesign.push({ ...d.diff, migration: 'follows new rows', sequenceTables: seqTables });
      continue;
    }
    const tableRules = rules.get(d.name) || [];
    if (d.unchanged) {
      for (const rule of tableRules) if (rule.validate) problems.push(...rule.validate({ changedRows: [], addedRows: [], columns: d.columns, context }));
      if (problems.length) result.unexpected.push({ ...d.diff, reason: problems.join('; ') });
      continue;
    }
    if (!tableRules.length) { result.unexpected.push({ ...d.diff, reason: 'rows changed, no migration changes this table by design' }); continue; }
    const allowedColumns = new Set(tableRules.flatMap((r) => r.columns || []));
    const appendRules = tableRules.filter((r) => r.append);
    if (d.removedKeys.length) problems.push(`${d.removedKeys.length} row(s) removed`);
    const badColumns = [...d.changedColumns].filter((c) => !allowedColumns.has(c));
    if (badColumns.length) problems.push('columns changed outside the design: ' + badColumns.join(', '));
    if (d.addedRows.length) {
      if (!appendRules.length) problems.push(`${d.addedRows.length} row(s) added`);
      else if (d.addedRows.some((row) => !row)) problems.push('added rows not kept for checking');
      else {
        const stray = d.addedRows.filter((row) => !appendRules.some((r) => matchesAppendFilter(r.append, row, d.columns)));
        if (stray.length) problems.push(`${stray.length} added row(s) outside the design`);
      }
    }
    for (const rule of tableRules) {
      if (!rule.validate) continue;
      if (d.changedRows.some((r) => !r.before || !r.after) || d.addedRows.some((r) => !r)) { problems.push('row values not kept for the validator'); continue; }
      problems.push(...rule.validate({ changedRows: d.changedRows, addedRows: d.addedRows, columns: d.columns, context }));
    }
    if (problems.length) result.unexpected.push({ ...d.diff, reason: problems.join('; ') });
    else result.changedByDesign.push({ ...d.diff, migration: tableRules.map((r) => r.migration).join(', ') });
  }
  result.ok = result.unexpected.length === 0;
  return result;
}

// --- read-only checks -------------------------------------------------------------

function ledgerSummary(dbPath) {
  const hasLedger = sqliteJson(dbPath, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'")[0].n > 0;
  if (!hasLedger) return { rows: 0, head: null, statuses: {} };
  const rows = sqliteJson(dbPath, 'SELECT version, name, checksum, status FROM schema_migrations ORDER BY version');
  const statuses = {};
  for (const r of rows) statuses[r.status] = (statuses[r.status] || 0) + 1;
  return { rows: rows.length, head: rows.length ? rows[rows.length - 1].version : null, statuses, ledger: rows };
}

// A ledger the tools can classify: positive integer versions, a 64-hex
// checksum and status 'applied' on every row. Anything else is refused before
// any write; reconcile-ledger-numbering.js --clear-repair-required and manual
// review own those cases.
function checkLedgerShape(ledger) {
  const problems = [];
  for (const r of ledger) {
    if (!Number.isInteger(r.version) || r.version < 1) problems.push(`row ${JSON.stringify(r.version)}: version is not a positive integer`);
    if (!/^[0-9a-f]{64}$/.test(String(r.checksum || ''))) problems.push(`v${r.version} ${r.name}: checksum is not 64 hex digits`);
    if (r.status !== 'applied') problems.push(`v${r.version} ${r.name}: status '${r.status}', expected 'applied'`);
  }
  return problems;
}

function tableExists(dbPath, name) {
  return sqliteJson(dbPath, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='${name}'`)[0].n > 0;
}

// Outbox, history queue and link state: the numbers the cutover runbook checks.
function operationalSummary(dbPath) {
  const out = {};
  if (tableExists(dbPath, 'sync_outbox')) {
    out.outbox = sqliteJson(dbPath, "SELECT COUNT(*) AS total, SUM(delivered_at IS NULL AND rejected_at IS NULL) AS pending, SUM(rejected_at IS NOT NULL) AS rejected FROM sync_outbox")[0];
    out.outboxPendingByType = sqliteJson(dbPath, "SELECT aggregate_type, op, COUNT(*) AS n, SUM(COALESCE(trim(gateway_device_eui),'')='') AS without_gateway_eui FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2");
  }
  if (tableExists(dbPath, 'sync_history_dirty_keys')) {
    out.historyQueue = sqliteJson(dbPath, 'SELECT table_name, status, COUNT(*) AS n FROM sync_history_dirty_keys GROUP BY 1, 2 ORDER BY 1, 2');
    out.historyInFlight = sqliteJson(dbPath, "SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE status='in_flight'")[0].n;
  }
  if (tableExists(dbPath, 'sync_link_state')) {
    out.link = sqliteJson(dbPath, "SELECT peer_node, linked, gateway_device_eui IS NOT NULL AND trim(gateway_device_eui) <> '' AS has_gateway_eui FROM sync_link_state ORDER BY peer_node");
  }
  return out;
}

function devicesDdl(dbPath) {
  const rows = sqliteJson(dbPath, "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'");
  return rows.length ? rows[0].sql : null;
}

function storedEqualsLiveFingerprints(dbPath) {
  // Lazy: keeps --help and the path guards free of the migrate library.
  const { readStoredFingerprints, sortFps } = require('../lib/osi-migrate/runner');
  const { computeFingerprints } = require('../lib/osi-migrate/fingerprints');
  const { cliRunner } = require('../lib/osi-migrate/runner-iface');
  return (async () => {
    const runner = cliRunner(dbPath);
    const stored = await readStoredFingerprints(runner);
    const live = sortFps(await computeFingerprints(runner));
    return JSON.stringify(stored) === JSON.stringify(live);
  })();
}

// --- the rehearsal ---------------------------------------------------------------

class StepFailed extends Error {}

// Resource use sampled at every step boundary: the size of <work>/tmp (the
// reconciler's reference chain lives there), MemAvailable, and this
// process's peak RSS (sqlite3 child processes are short-lived and not counted).
function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else { try { total += fs.statSync(p).size; } catch (_) { /* removed meanwhile */ } }
  }
  return total;
}

function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (_) { return null; }
}

const resources = { workTmp: null, maxRssKb: 0, peakWorkTmpBytes: 0, minMemAvailableMb: null };

function sampleResources() {
  const sample = {
    workTmpBytes: resources.workTmp ? dirBytes(resources.workTmp) : 0,
    memAvailableMb: memAvailableMb(),
    maxRssKb: process.resourceUsage().maxRSS,
  };
  resources.maxRssKb = Math.max(resources.maxRssKb, sample.maxRssKb);
  resources.peakWorkTmpBytes = Math.max(resources.peakWorkTmpBytes, sample.workTmpBytes);
  if (sample.memAvailableMb !== null) {
    resources.minMemAvailableMb = resources.minMemAvailableMb === null ? sample.memAvailableMb : Math.min(resources.minMemAvailableMb, sample.memAvailableMb);
  }
  return sample;
}

function makeLogger(quiet) {
  return (line) => { if (!quiet) process.stderr.write('[rehearsal] ' + line + '\n'); };
}

async function runStep(pass, name, log, fn) {
  log(`pass ${pass.pass} step ${name} start`);
  const started = Date.now();
  const entry = { name, ok: false, durationMs: 0 };
  pass.steps.push(entry);
  try {
    const result = (await fn()) || {};
    entry.ok = result.ok !== false;
    if (result.skipped) entry.skipped = true;
    entry.result = jsonSafe(result);
  } catch (error) {
    entry.ok = false;
    entry.error = error && error.message ? error.message : String(error);
  }
  entry.durationMs = Date.now() - started;
  entry.resources = sampleResources();
  log(`pass ${pass.pass} step ${name} ${entry.ok ? (entry.skipped ? 'skipped' : 'ok') : 'FAILED'} ${entry.durationMs} ms${entry.error ? ': ' + entry.error : ''}`);
  if (!entry.ok) throw new StepFailed(`pass ${pass.pass} step ${name} failed`);
  return entry.result;
}

async function runPass({ passNumber, workDb, work, gatewayEui, log, migrations, report }) {
  const { runReconcile } = require('./reconcile-ledger-numbering');
  const { runMigrateCli } = require('./migrate-cli');
  const { runVerifyHead } = require('./verify-head-cli');
  const { runBootNode } = require('../lib/osi-migrate/__tests__/helpers/boot-rehearsal');
  const { snapshotSchema, compareSchemas } = require('./semantic-schema-compare');
  const { cliRunner } = require('../lib/osi-migrate/runner-iface');

  const pass = { pass: passNumber, steps: [] };
  report.passes.push(pass);
  const backupDir = path.join(work, 'backups');
  const headVersion = migrations[migrations.length - 1].version;
  let snapBefore;
  let snapMigrated;
  let pendingAfterReconcile = null;
  let applied = [];

  await runStep(pass, 'preflight', log, async () => {
    const integrity = sqliteJson(workDb, 'PRAGMA integrity_check').map((r) => r.integrity_check);
    const foreignKeys = sqliteJson(workDb, 'PRAGMA foreign_key_check');
    const ledger = ledgerSummary(workDb);
    const shape = checkLedgerShape(ledger.ledger || []);
    const problems = [];
    if (integrity.join(',') !== 'ok') problems.push('integrity_check: ' + integrity.join('; '));
    if (foreignKeys.length) problems.push(`foreign_key_check: ${foreignKeys.length} violation(s)`);
    if (!ledger.rows) problems.push('no migration ledger (schema_migrations is missing or empty); baseline-existing-db.js owns that case');
    problems.push(...shape);
    const operational = operationalSummary(workDb);
    // The cutover runbook's freezes; a copy pulled outside them still
    // rehearses, but the report says so.
    const warnings = [];
    if (operational.outbox && operational.outbox.pending > 0) warnings.push(`${operational.outbox.pending} outbox event(s) pending (cutover freeze expects 0)`);
    if (operational.historyInFlight > 0) warnings.push(`${operational.historyInFlight} history queue key(s) in_flight`);
    if (!(operational.link || []).some((l) => l.peer_node === 'cloud' && l.has_gateway_eui)) warnings.push('no cloud link row with a gateway EUI');
    if (passNumber === 1) report.warnings.push(...warnings);
    return {
      ok: problems.length === 0, problems, warnings, integrity, foreignKeyViolations: foreignKeys.length,
      ledger: { rows: ledger.rows, head: ledger.head, statuses: ledger.statuses },
      operational,
    };
  });

  const reconcileLog = [];
  const reconcileReport = await runStep(pass, 'reconcile-report', log, async () => {
    const shaBefore = sha256File(workDb);
    const res = await runReconcile({ dbPath: workDb, migrationsDir: MIGRATIONS_DIR, fixturesDir: FIXTURES_DIR, apply: false, log: (l) => reconcileLog.push(l) });
    const unchanged = sha256File(workDb) === shaBefore;
    const settled = new Set(res.rows.filter((r) => r.decision === 'match').map((r) => r.version)
      .concat(res.rows.filter((r) => r.decision === 'remap').map((r) => r.target.version)));
    pendingAfterReconcile = migrations.map((m) => m.version).filter((v) => !settled.has(v));
    const mapping = res.rows.map((r) => ({ from: r.version, name: r.name, decision: r.decision, matchType: r.matchType, to: r.target ? r.target.version : null, reason: r.decision === 'refuse' ? r.reason : undefined }));
    return {
      ok: !res.refused && unchanged,
      refused: res.refused,
      databaseUnchanged: unchanged,
      summary: res.summary,
      remaps: mapping.filter((m) => m.decision === 'remap'),
      refusedRows: mapping.filter((m) => m.decision === 'refuse'),
      pendingAfterReconcile,
      log: reconcileLog,
    };
  });

  // After the report (which writes nothing, checked above): the pending list
  // says which tables carry a rule, and those keep every row's values.
  await runStep(pass, 'snapshot-before', log, async () => {
    const keepValuesFor = ruleTables(pendingAfterReconcile);
    snapBefore = snapshotTables(workDb, { keepValuesFor });
    return { tables: Object.keys(snapBefore.tables).length, valuesKeptFor: [...keepValuesFor], rows: summarizeSnapshot(snapBefore) };
  });

  await runStep(pass, 'reconcile-apply', log, async () => {
    const remaps = reconcileReport.summary.remapExact + reconcileReport.summary.remapHeaderStripped;
    if (remaps === 0) return { skipped: true, reason: 'every ledger row already matches main (deploy.sh takes the fast path)' };
    const applyLog = [];
    const res = await runReconcile({ dbPath: workDb, migrationsDir: MIGRATIONS_DIR, fixturesDir: FIXTURES_DIR, apply: true, writersStopped: true, backupDir, log: (l) => applyLog.push(l) });
    return { ok: res.applied && !res.refused, applied: res.applied, summary: res.summary, backup: res.backupPath && path.relative(work, res.backupPath), log: applyLog };
  });

  await runStep(pass, 'migrate-cli', log, async () => {
    const migrateLog = [];
    const res = await runMigrateCli({ dbPath: workDb, backupDir, migrationsDir: MIGRATIONS_DIR, log: (l) => migrateLog.push(l) });
    applied = res.applied;
    const asExpected = JSON.stringify(applied) === JSON.stringify(pendingAfterReconcile);
    return {
      ok: asExpected, applied, expected: pendingAfterReconcile,
      migrations: applied.map((v) => { const m = migrations.find((x) => x.version === v); return { version: v, name: m.name, risk: m.risk }; }),
      backup: res.offDeviceBackup && path.relative(work, res.offDeviceBackup), log: migrateLog,
    };
  });

  await runStep(pass, 'verify-head', log, async () => {
    const exact = await storedEqualsLiveFingerprints(workDb);
    const res = await runVerifyHead({ dbPath: workDb, migrationsDir: MIGRATIONS_DIR });
    const ledger = ledgerSummary(workDb);
    return { ok: res.ok === true && ledger.head === headVersion && ledger.rows === migrations.length, verifyHead: res, fingerprintsExact: exact, ledger: { rows: ledger.rows, head: ledger.head, statuses: ledger.statuses } };
  });

  await runStep(pass, 'snapshot-migrated', log, async () => {
    snapMigrated = snapshotTables(workDb, { columnsFrom: snapBefore });
    return { tables: Object.keys(snapMigrated.tables).length };
  });

  // Rehearsed on a scratch copy: the script stamps a synthetic gateway EUI
  // into empty gateway columns, which must not reach the compared database.
  const rehearsalDb = path.join(work, 'devices-rehearsal.db');
  for (const n of [1, 2]) {
    await runStep(pass, `devices-rebuild-${n}`, log, async () => {
      if (n === 1) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(rehearsalDb + suffix, { force: true });
        fs.copyFileSync(workDb, rehearsalDb);
      }
      const child = spawnSync(process.execPath, [DEVICES_REBUILD_CLI, 'existing', rehearsalDb], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
      let out = null;
      try { out = JSON.parse(String(child.stdout).trim().split('\n').pop()); } catch (_) { /* reported below */ }
      if (!out) return { ok: false, exitCode: child.status, stderr: String(child.stderr).slice(-2000) };
      return { ok: child.status === 0 && out.ok === true && out.skipped === true, exitCode: child.status, skipped: false, guardSkippedRebuild: out.skipped, devices: out.after, rowsPreserved: out.rowsPreserved, telemetryPreserved: out.telemetryPreserved, error: out.error };
    });
  }
  fs.rmSync(rehearsalDb, { force: true });

  let snapBooted;
  await runStep(pass, 'boot-node', log, async () => {
    const ddlBefore = devicesDdl(workDb);
    const boot = await runBootNode(workDb, gatewayEui.value);
    const ddlAfter = devicesDdl(workDb);
    const rebuilt = ddlBefore !== ddlAfter;
    return { ok: boot.errors.length === 0 && !rebuilt, gatewayEui: gatewayEui.source, devicesRebuilt: rebuilt, errors: boot.errors, warnings: boot.warnings };
  });

  await runStep(pass, 'verify-head-after-boot', log, async () => {
    const exact = await storedEqualsLiveFingerprints(workDb);
    const res = await runVerifyHead({ dbPath: workDb, migrationsDir: MIGRATIONS_DIR });
    return { ok: res.ok === true, verifyHead: res, fingerprintsExact: exact, note: exact ? undefined : 'stored fingerprints differed from the live schema; verifyHead accepted and restamped (boot-owned trigger bodies)' };
  });

  await runStep(pass, 'integrity', log, async () => {
    const integrity = sqliteJson(workDb, 'PRAGMA integrity_check').map((r) => r.integrity_check);
    const foreignKeys = sqliteJson(workDb, 'PRAGMA foreign_key_check');
    return { ok: integrity.join(',') === 'ok' && foreignKeys.length === 0, integrity, foreignKeyViolations: foreignKeys.slice(0, 50) };
  });

  await runStep(pass, 'schema-compare', log, async () => {
    const seedDb = path.join(work, 'seed.db');
    if (!fs.existsSync(seedDb)) await cliRunner(seedDb).exec(fs.readFileSync(SEED_SQL, 'utf8'));
    const cmp = compareSchemas(await snapshotSchema(cliRunner(workDb)), await snapshotSchema(cliRunner(seedDb)));
    return { ok: cmp.diffs.length === 0, diffs: cmp.diffs };
  });

  await runStep(pass, 'snapshot-after-boot', log, async () => {
    snapBooted = snapshotTables(workDb, { columnsFrom: snapMigrated });
    return { tables: Object.keys(snapBooted.tables).length };
  });

  await runStep(pass, 'data-compare', log, async () => {
    // Migrations: only the listed changes by design, ledger bookkeeping allowed.
    const migrationPhase = compareSnapshots(snapBefore, snapMigrated, { rules: rulesFor(applied), allowBookkeeping: applied.length > 0 || passNumber === 1 });
    // Boot node: no row may change.
    const bootPhase = compareSnapshots(snapMigrated, snapBooted, { allowBookkeeping: true });
    const operational = operationalSummary(workDb);
    const problems = [];
    if (!migrationPhase.ok) problems.push('migration phase changed rows outside the design');
    if (!bootPhase.ok) problems.push('the boot node changed rows');
    if (passNumber > 1) {
      // The second run must be a no-op, ledger and fingerprints included.
      const strict = compareSnapshots(snapBefore, snapBooted, {});
      if (!strict.ok || strict.newTables.length || strict.addedColumns.length) problems.push('second run changed the database');
      return { ok: problems.length === 0, problems, noOp: strict, operational };
    }
    return {
      ok: problems.length === 0,
      problems,
      migrationPhase: { ...migrationPhase, unchanged: migrationPhase.unchanged.length, unchangedTables: migrationPhase.unchanged },
      bootPhase: { ok: bootPhase.ok, unexpected: bootPhase.unexpected, bookkeeping: bootPhase.bookkeeping, newTables: bootPhase.newTables },
      expectedChangeRules: [...rulesFor(applied).entries()].map(([table, list]) => ({ table, migrations: list.map((r) => r.migration) })),
      tables: Object.fromEntries(Object.keys(snapBooted.tables).map((name) => [name, {
        before: snapBefore.tables[name] ? { count: snapBefore.tables[name].count, sha256: snapBefore.tables[name].sha256 } : null,
        after: { count: snapBooted.tables[name].count, sha256: snapBooted.tables[name].sha256 },
      }])),
      operational,
    };
  });

  if (passNumber > 1) {
    const recon = reconcileReport.summary;
    const noOp = recon.match === recon.total && recon.total === migrations.length && applied.length === 0;
    await runStep(pass, 'second-run-no-op', log, async () => ({ ok: noOp, reconcile: recon, migrateApplied: applied }));
  }
  return pass;
}

async function rehearse(options, { log }) {
  const startedAt = new Date();
  const { work, source, interrupted } = checkPaths(options);
  prepareWork(work);
  // Every scratch file the reused tools create (reference chains, structural
  // proofs) goes under --work, not the system temporary directory.
  process.env.TMPDIR = path.join(work, 'tmp');
  resources.workTmp = process.env.TMPDIR;
  const statePath = path.join(work, STATE_NAME);
  fs.writeFileSync(statePath, JSON.stringify({ status: 'running', pid: process.pid, startedAt: startedAt.toISOString() }) + '\n');

  const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const report = {
    tool: 'scripts/rehearse-ledger-cutover.js',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    verdict: 'FAIL',
    failedStep: null,
    previousRunInterrupted: interrupted,
    warnings: [],
    checkout: { head: null, migrationsHead: migrations[migrations.length - 1].version, migrationCount: migrations.length },
    source: { path: source, bytes: fs.statSync(source).size, sha256Before: sha256File(source), sha256After: null, wal: fs.existsSync(source + '-wal') },
    work,
    expectedChanges: Object.fromEntries(Object.entries(EXPECTED_CHANGES).map(([v, e]) => [v, { name: e.name, rules: e.rules.map((r) => ({ table: r.table, columns: r.columns || [], append: r.append || false })) }])),
    passes: [],
  };
  Object.assign(report.checkout, gitState(REPO), checkoutProvenance(), { allowDirty: options.allowDirty });

  const workDb = path.join(work, WORK_DB_NAME);
  const copyPass = { pass: 0, steps: [] };
  report.passes.push(copyPass);
  const gatewayEui = { value: SYNTHETIC_GATEWAY_EUI, source: 'synthetic' };
  try {
    // RH-E must run on the exact SHA that will be deployed: a dirty working
    // tree runs migrations, boot node or tool code that no commit holds.
    await runStep(copyPass, 'checkout', log, async () => ({
      ok: !report.checkout.dirty || options.allowDirty,
      head: report.checkout.head,
      dirty: report.checkout.dirty,
      reason: report.checkout.dirty && !options.allowDirty ? 'the checkout has uncommitted or untracked files (git status --porcelain); commit them, or pass --allow-dirty for a trial run' : undefined,
    }));
    await runStep(copyPass, 'copy-source', log, async () => {
      fs.copyFileSync(source, workDb);
      fs.chmodSync(workDb, 0o600); // a pulled backup is often read-only
      if (fs.existsSync(source + '-wal')) {
        fs.copyFileSync(source + '-wal', workDb + '-wal');
        fs.chmodSync(workDb + '-wal', 0o600);
        sqliteJson(workDb, 'PRAGMA wal_checkpoint(TRUNCATE)');
      }
      const linked = tableExists(workDb, 'sync_link_state')
        ? sqliteJson(workDb, "SELECT gateway_device_eui AS eui FROM sync_link_state WHERE peer_node='cloud'")
        : [];
      const fromDb = linked.length && /^[0-9A-Fa-f]{16}$/.test(String(linked[0].eui || '').trim()) ? String(linked[0].eui).trim().toUpperCase() : null;
      if (options.gatewayEui) Object.assign(gatewayEui, { value: options.gatewayEui.toUpperCase(), source: '--gateway-eui' });
      else if (fromDb) Object.assign(gatewayEui, { value: fromDb, source: 'sync_link_state' });
      return {
        workingCopy: WORK_DB_NAME,
        sha256: sha256File(workDb),
        journalMode: sqliteJson(workDb, 'PRAGMA journal_mode')[0].journal_mode,
        gatewayEuiSource: gatewayEui.source,
        gatewayEuiMatchesLink: fromDb ? fromDb === gatewayEui.value : null,
      };
    });
    await runPass({ passNumber: 1, workDb, work, gatewayEui, log, migrations, report });
    await runPass({ passNumber: 2, workDb, work, gatewayEui, log, migrations, report });
    report.verdict = 'PASS';
  } catch (error) {
    if (!(error instanceof StepFailed)) {
      report.error = error && error.stack ? error.stack : String(error);
    }
    const failed = report.passes.flatMap((p) => p.steps.map((s) => ({ pass: p.pass, ...s }))).find((s) => !s.ok);
    report.failedStep = failed ? `pass ${failed.pass} ${failed.name}` : 'internal error';
  }
  report.source.sha256After = sha256File(source);
  if (report.source.sha256After !== report.source.sha256Before) {
    report.verdict = 'FAIL';
    report.failedStep = report.failedStep || 'source changed';
  }
  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.durationMs = finishedAt - startedAt;
  report.workingCopySha256 = fs.existsSync(workDb) ? sha256File(workDb) : null;
  sampleResources();
  report.resources = { sampledAt: 'step boundaries', maxRssKb: resources.maxRssKb, peakWorkTmpBytes: resources.peakWorkTmpBytes, minMemAvailableMb: resources.minMemAvailableMb };
  fs.rmSync(path.join(work, 'tmp'), { recursive: true, force: true });
  fs.writeFileSync(path.join(work, REPORT_NAME), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(statePath, JSON.stringify({ status: 'finished', verdict: report.verdict, finishedAt: report.finishedAt }) + '\n');
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('rehearse-ledger-cutover: ' + error.message + '\n');
    process.exit(2);
  }
  const log = makeLogger(false);
  let report;
  try {
    report = await rehearse(options, { log });
  } catch (error) {
    process.stderr.write('rehearse-ledger-cutover: ' + (error instanceof UsageError ? error.message : (error && error.stack) || error) + '\n');
    process.exit(2);
  }
  if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(`${report.verdict}${report.failedStep ? ' (' + report.failedStep + ')' : ''}: report ${path.join(report.work, REPORT_NAME)}, ${Math.round(report.durationMs / 1000)} s\n`);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  EXPECTED_CHANGES,
  LEGACY_STAGE_TO_FAO,
  WORK_MARKER,
  REPORT_NAME,
  parseArgs,
  checkPaths,
  checkLedgerShape,
  snapshotTables,
  compareSnapshots,
  rulesFor,
  ruleTables,
  gitState,
  checkoutProvenance,
  rehearse,
};
