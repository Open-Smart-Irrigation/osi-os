#!/usr/bin/env node
'use strict';
// Explicit offline recovery, never called automatically by deploy or boot.
// Stock Node 20 + SQLite CLI. Every database write targets a private copy.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync, checkRuntime } = require('./lib/repair-sqlite-cli');
const { normalizeSqlV3, computeFingerprints } = require('../lib/osi-migrate/fingerprints');
const { ensureLedger } = require('../lib/osi-migrate/ledger');
const { syncFingerprints } = require('../lib/osi-migrate/runner');
const { LEGACY_CATALOG_SQL } = require('../lib/osi-migrate/legacy-device-catalog');
const { loadMigrationCorpus } = require('../lib/osi-migrate/migrations-loader');
const { execFileSync } = require('node:child_process');
const { prepareOffline, assertHold, backupOnline, releaseHold } = require('./lib/legacy-device-repair-ops');

const ROOT = path.resolve(__dirname, '..');
const q = s => '"' + s.replace(/"/g, '""') + '"';
const adapter = db => ({ all: async sql => db.prepare(sql).all(), exec: async sql => db.exec(sql) });
const rows = (db, sql) => db.prepare(sql).all().map(r => ({ ...r }));
const master = db => rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE lower(substr(name,1,7)) <> 'sqlite_' ORDER BY type,name");
const LEDGER = new Set(['schema_migrations', 'schema_object_fingerprints']);

function hashFile(file) {
  const h = crypto.createHash('sha256'), buf = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { for (let n; (n = fs.readSync(fd, buf)) > 0;) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function sync(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function safeDirectory(dir) {
  if (fs.realpathSync(dir) !== dir || (fs.statSync(dir).mode & 0o022)) throw new Error(`refusing symlinked or group/world-writable directory ${dir}`);
}
function sourceState(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('refusing non-regular database');
  return { identity: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.gid].join(':'), sha256: hashFile(file) };
}
function assertNoSidecars(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(file + suffix) || fs.lstatSync(file + suffix, { throwIfNoEntry: false })) {
      throw new Error(`refusing SQLite sidecar ${file + suffix}; stop writers and checkpoint/close SQLite first; never delete sidecars`);
    }
  }
}

// Same stopped-writers contract as the ledger tools, plus an explicit CLI
// assertion and an open-handle check. On a gateway run as root, as Node-RED does.
// On a workstation scan this user's processes; a non-cooperating privileged
// writer is outside the stopped-writers contract. Recheck before publication.
function assertNoOpenHandles(file) {
  const st = fs.statSync(file);
  const uid = process.getuid();
  for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    let proc;
    try { proc = fs.statSync(`/proc/${pid}`); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (uid !== 0 && proc.uid !== uid) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); }
    catch (e) { if (e.code === 'ENOENT') continue; throw new Error(`cannot prove writers stopped: ${e.message}`); }
    for (const fd of fds) {
      let s;
      try { s = fs.statSync(`/proc/${pid}/fd/${fd}`); }
      catch (e) { if (e.code === 'ENOENT') continue; throw new Error(`cannot inspect open handle: ${e.message}`); }
      if (s.dev === st.dev && s.ino === st.ino) throw new Error(`refusing open database handle in process ${pid}; writers must be stopped`);
    }
  }
}
function assertGatewayStopped(file, root = '/', ownedLock) {
  if (file !== path.join(root, '/data/db/farming.db')) return;
  assertHold(root, ownedLock);
  for (const name of ['node-red', 'osi-identityd']) {
    const response = JSON.parse(execFileSync('ubus', ['call', 'service', 'list', JSON.stringify({ name })], { encoding: 'utf8' }));
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('unknown procd service state');
    if (!Object.prototype.hasOwnProperty.call(response, name)) continue;
    const service = response[name];
    if (!service || typeof service !== 'object' || Array.isArray(service) || !service.instances ||
        typeof service.instances !== 'object' || Array.isArray(service.instances) ||
        Object.values(service.instances).some(i => !i || i.running !== false)) {
      throw new Error(`refusing: ${name} is running or its state is unknown; stop it before offline repair`);
    }
  }
}

// Replace identifiers only. Preserve literals/comments byte-for-byte so a
// DEFAULT containing the old name cannot silently change its meaning.
function correctedSql(sql) {
  return String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*/g, token => {
    if (token.startsWith("'") || token.startsWith('--') || token.startsWith('/*')) return token;
    const bare = /^["`\[]/.test(token) ? token.slice(1, -1) : token;
    return bare.toLowerCase() === 'devices_old' ? 'devices' : token;
  });
}

function witness(db) {
  const out = {};
  const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  for (const { name } of tables) {
    if (name === 'schema_object_fingerprints') continue; // deliberate computed refresh, no ledger row changes
    const columns = rows(db, `PRAGMA table_xinfo(${q(name)})`);
    if (columns.some(c => c.hidden)) throw new Error(`unsupported generated/hidden column in ${name}`);
    const h = crypto.createHash('sha256');
    let count = 0;
    // Encode SQLite storage classes before JSON transport: binary/text NULs,
    // 64-bit integers and full-precision doubles must never pass through lossy
    // CLI JSON numbers or blob rendering. Hash rows as a stream.
    const encoded = column => `CASE typeof(${column}) WHEN 'integer' THEN 'i:' || CAST(${column} AS TEXT) WHEN 'real' THEN 'r:' || printf('%!.26g',${column}) WHEN 'text' THEN 's:' || hex(CAST(${column} AS BLOB)) WHEN 'blob' THEN 'b:' || hex(${column}) ELSE 'null' END`;
    const fields = ['rowid', ...columns.map(c => q(c.name))].map((c, i) => encoded(c) + ' AS ' + q('v' + i));
    for (const row of db.prepare(`SELECT ${fields.join(',')} FROM ${q(name)} ORDER BY rowid`).iterate()) {
      h.update(JSON.stringify(Object.values(row)) + '\n');
      count++;
    }
    out[name] = { columns, count, digest: h.digest('hex') };
  }
  return out;
}
function assertEqual(a, b, message) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message);
}
function checkDb(db) {
  const integrity = rows(db, 'PRAGMA integrity_check');
  assertEqual(integrity, [{ integrity_check: 'ok' }], 'integrity_check failed');
  if (rows(db, 'PRAGMA foreign_key_check').length) throw new Error('foreign_key_check failed');
}

async function plan(db) {
  const objects = master(db);
  if (objects.some(o => o.name.toLowerCase() === 'devices_old' || o.tbl_name.toLowerCase() === 'devices_old')) {
    throw new Error('refusing surviving devices_old parent/object; preserve both catalogs for operator investigation');
  }
  const affected = rows(db, LEGACY_CATALOG_SQL);
  if (!affected.length) { checkDb(db); return { needed: false, tables: [], objects }; }
  if (affected.some(o => o.type === 'view')) throw new Error('legacy view requires separate qualification; automatic repair supports child tables and canonical triggers');
  const ref = new DatabaseSync(':memory:');
  try {
    ref.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
    await ensureLedger(adapter(ref));
    const expected = new Map(master(ref).map(o => [o.type + ':' + o.name, o]));
    const found = new Set();
    for (const obj of objects) {
      const key = obj.type + ':' + obj.name;
      const target = expected.get(key);
      if (!target || normalizeSqlV3(correctedSql(obj.sql)) !== normalizeSqlV3(target.sql)) {
        throw new Error(`unknown or divergent catalog object ${key}; only the shipped schema with legacy reference damage is supported`);
      }
      found.add(key);
    }
    for (const [key, obj] of expected) {
      if (!LEDGER.has(obj.name) && !found.has(key)) throw new Error(`unknown catalog: missing ${key}`);
    }
    const ledger = objects.some(o => o.name === 'schema_migrations');
    if (ledger) {
      const applied = rows(db, 'SELECT version,name,checksum,status FROM schema_migrations ORDER BY version');
      const corpus = loadMigrationCorpus(path.join(ROOT, 'database/migrations/ordered'));
      if (applied.length) assertEqual(applied, corpus.migrations.map(m => ({ version: m.version, name: m.name, checksum: m.checksum, status: 'applied' })), 'unknown migration ledger; reconcile/qualify it separately');
    }
    const tables = affected.filter(o => o.type === 'table');
    for (const obj of tables) {
      if (!rows(db, `PRAGMA foreign_key_list(${q(obj.name)})`).some(fk => fk.table.toLowerCase() === 'devices_old')) {
        throw new Error(`unproven legacy text in table ${obj.name}`);
      }
    }
    if (affected.some(o => correctedSql(o.sql).toLowerCase().includes('devices_old'))) throw new Error('unproven legacy literal/comment; refusing text surgery');
    return { needed: true, tables: tables.map(o => o.name), objects, ledger };
  } finally { ref.close(); }
}

async function rebuild(db, proposal, checkpoint) {
  let sequence = null;
  if (rows(db, "SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").length) {
    const statement = db.prepare('SELECT rowid,* FROM sqlite_sequence ORDER BY rowid');
    statement.setReadBigInts(true);
    sequence = statement.all();
  }
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
    try {
      for (const o of proposal.objects.filter(o => o.type === 'trigger')) db.exec(`DROP TRIGGER ${q(o.name)}`);
      for (const name of proposal.tables) {
        const obj = proposal.objects.find(o => o.type === 'table' && o.name === name);
        const temp = '__eb19_' + name;
        const ddl = correctedSql(obj.sql);
        db.exec(`CREATE TABLE ${q(temp)} ${ddl.slice(ddl.indexOf('('))}`);
        const columns = rows(db, `PRAGMA table_xinfo(${q(name)})`).map(c => q(c.name));
        const cols = ['rowid', ...columns].join(',');
        db.exec(`INSERT INTO ${q(temp)} (${cols}) SELECT ${cols} FROM ${q(name)}`);
        await checkpoint('child-copied');
        db.exec(`DROP TABLE ${q(name)}; ALTER TABLE ${q(temp)} RENAME TO ${q(name)}`);
        for (const index of proposal.objects.filter(o => o.type === 'index' && o.tbl_name === name && o.sql)) db.exec(correctedSql(index.sql));
      }
      for (const o of proposal.objects.filter(o => o.type === 'trigger')) db.exec(correctedSql(o.sql));
      if (sequence) {
        db.exec('DELETE FROM sqlite_sequence');
        const insert = db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES (?,?,?)');
        for (const r of sequence) insert.run(r.rowid, r.name, r.seq);
      }
      if (rows(db, 'PRAGMA foreign_key_check').length) throw new Error('foreign_key_check failed before COMMIT');
      await checkpoint('before-commit');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally {
    try { db.exec('PRAGMA foreign_keys=ON'); }
    finally { db.exec('PRAGMA legacy_alter_table=OFF'); }
    const flags = { foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
      legacyAlterTable: db.prepare('PRAGMA legacy_alter_table').get().legacy_alter_table };
    assertEqual(flags, { foreignKeys: 1, legacyAlterTable: 0 }, 'FK fence was not restored');
    await checkpoint('fence-restored', flags);
  }
  assertEqual(rows(db, 'PRAGMA foreign_keys'), [{ foreign_keys: 1 }], 'FK enforcement was not restored');
}

async function repair({ dbPath, apply = false, writersStopped = false, backupDir, checkpoint = async () => {}, gatewayRoot = '/' } = {}) {
  if (!dbPath) throw new Error('database path is required');
  const file = path.resolve(dbPath);
  if (fs.realpathSync(file) !== file) throw new Error('refusing symlinked database path');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('refusing non-regular or multiply-linked database; inspect retained repair artifacts');
  if (fs.lstatSync(file + '.legacy-device-fk-repair.lock', { throwIfNoEntry: false })) throw new Error('refusing incomplete repair lock (EEXIST); inspect its stage/receipt before retry');
  if (apply && (!writersStopped || !backupDir)) throw new Error('--apply requires --writers-stopped and --backup-dir; stop all writers first');
  if (apply) safeDirectory(path.dirname(file));
  assertNoSidecars(file);
  if (apply) { assertGatewayStopped(file, gatewayRoot); assertNoOpenHandles(file); }
  const originalState = sourceState(file);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eb19-report-'));
  let db, stage, lock, ownedLock, published = false, publicationCommitted = false;
  try {
    let candidate = path.join(scratch, 'copy.db');
    fs.copyFileSync(file, candidate, fs.constants.COPYFILE_EXCL);
    assertEqual(sourceState(file), originalState, 'source changed during snapshot');
    assertEqual(hashFile(candidate), hashFile(file), 'snapshot differs from source');
    db = new DatabaseSync(candidate);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON');
    assertEqual(rows(db, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }], 'source copy integrity_check failed');
    const proposal = await plan(db);
    if (!apply || !proposal.needed) {
      if (proposal.needed) await rebuild(db, proposal, checkpoint);
      checkDb(db);
      return { applied: false, needed: proposal.needed, tables: proposal.tables, dataEligible: true, fieldCount: 'unknown' };
    }
    const before = witness(db);
    db.close(); db = null;
    lock = file + '.legacy-device-fk-repair.lock';
    fs.mkdirSync(lock, { mode: 0o700 }); // EEXIST refuses interrupted/concurrent attempts
    ownedLock = fs.lstatSync(lock);
    sync(path.dirname(file));
    stage = fs.mkdtempSync(path.join(path.dirname(file), '.legacy-device-fk-repair-'));
    const record = { source: file, originalSha256: originalState.sha256, phase: 'copying', fieldCount: 'unknown' };
    const receipt = () => {
      const next = path.join(stage, 'receipt.json.next');
      fs.writeFileSync(next, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      sync(next); fs.renameSync(next, path.join(stage, 'receipt.json')); sync(stage);
    };
    record.stage = stage;
    fs.writeFileSync(path.join(lock, 'stage'), stage + '\n', { mode: 0o600 }); sync(path.join(lock, 'stage')); sync(lock);
    receipt();
    const copied = path.join(stage, 'candidate.db');
    fs.copyFileSync(candidate, copied, fs.constants.COPYFILE_EXCL);
    candidate = copied;
    fs.rmSync(scratch, { recursive: true, force: true }); // do not retain a third full working image
    db = new DatabaseSync(candidate);
    await rebuild(db, proposal, checkpoint);
    checkDb(db);
    assertEqual(witness(db), before, 'row, column, rowid or sequence preservation failed');
    const normalizedObjects = list => list.map(o => ({ ...o, sql: normalizeSqlV3(correctedSql(o.sql)) }));
    assertEqual(normalizedObjects(master(db)), normalizedObjects(proposal.objects), 'schema preservation failed');
    const repaired = await plan(db);
    if (repaired.needed) throw new Error('legacy references remain');
    if (proposal.objects.some(o => o.name === 'schema_object_fingerprints')) {
      await syncFingerprints(adapter(db));
      const stored = rows(db, 'SELECT object_type,object_name,fingerprint FROM schema_object_fingerprints ORDER BY object_type,object_name');
      const actual = (await computeFingerprints(adapter(db))).sort((a, b) => a.object_type < b.object_type ? -1 : a.object_type > b.object_type ? 1 : a.object_name < b.object_name ? -1 : a.object_name > b.object_name ? 1 : 0);
      assertEqual(stored, actual, 'computed fingerprint verification failed');
    }
    checkDb(db);
    assertEqual(witness(db), before, 'post-stamp preservation failed');
    db.close(); db = null;
    assertNoSidecars(candidate);
    fs.chmodSync(candidate, stat.mode & 0o777);
    fs.chownSync(candidate, stat.uid, stat.gid);
    sync(candidate);
    const candidateState = sourceState(candidate);
    record.candidateSha256 = candidateState.sha256;
    record.preservation = Object.fromEntries(Object.entries(before).map(([name, w]) => [name, { rows: w.count, digest: w.digest }]));
    record.phase = 'verified'; receipt();
    await checkpoint('verified');
    assertNoSidecars(file); assertGatewayStopped(file, gatewayRoot, ownedLock); assertNoOpenHandles(file);
    assertEqual(sourceState(file), originalState, 'source changed before backup');
    const backupRoot = path.resolve(backupDir);
    let existing = backupRoot;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    safeDirectory(existing);
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    safeDirectory(backupRoot);
    for (let dir = backupRoot; dir !== existing; dir = path.dirname(dir)) sync(path.dirname(dir));
    const backup = path.join(backupRoot, `${path.basename(file)}.legacy-fk-${crypto.randomUUID()}.db`);
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
    assertEqual(hashFile(backup), record.originalSha256, 'backup verification failed');
    sync(backup); sync(backupRoot);
    record.backup = backup;
    fs.copyFileSync(file, path.join(stage, 'original.db'), fs.constants.COPYFILE_EXCL);
    assertEqual(hashFile(path.join(stage, 'original.db')), record.originalSha256, 'independent original verification failed');
    sync(path.join(stage, 'original.db')); sync(stage); sync(path.dirname(file));
    const preparedState = sourceState(file);
    record.phase = 'prepared'; receipt();
    await checkpoint('prepared');
    assertNoSidecars(file); assertGatewayStopped(file, gatewayRoot, ownedLock); assertNoOpenHandles(file);
    assertEqual(sourceState(file), preparedState, 'source changed before atomic swap');
    assertEqual(hashFile(file), record.originalSha256, 'source bytes changed before atomic swap');
    assertNoSidecars(candidate);
    assertEqual(sourceState(candidate), candidateState, 'verified candidate changed before atomic swap');
    fs.renameSync(candidate, file); published = true;
    sync(path.dirname(file));
    await checkpoint('published');
    record.phase = 'published'; receipt();
    // Publication and its receipt are durable. Cleanup failures must never
    // roll a committed repair back after its exclusion lock may be released.
    publicationCommitted = true;
    await checkpoint('before-unlock');
    fs.unlinkSync(path.join(lock, 'stage')); fs.rmdirSync(lock); lock = null;
    sync(path.dirname(file));
    return { applied: true, tables: proposal.tables, backup, original: path.join(stage, 'original.db'), receipt: path.join(stage, 'receipt.json'), foreignKeys: 1, fieldCount: 'unknown' };
  } catch (e) {
    if (published && !publicationCommitted) {
      try {
        fs.copyFileSync(file, path.join(stage, 'verified.db'), fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(path.join(stage, 'original.db'), path.join(stage, 'restore.db'), fs.constants.COPYFILE_EXCL);
        assertEqual(hashFile(path.join(stage, 'restore.db')), originalState.sha256, 'restore copy verification failed');
        fs.chmodSync(path.join(stage, 'restore.db'), stat.mode & 0o777);
        fs.chownSync(path.join(stage, 'restore.db'), stat.uid, stat.gid);
        sync(path.join(stage, 'restore.db'));
        fs.renameSync(path.join(stage, 'restore.db'), file);
        sync(path.dirname(file));
      } catch (restoreError) { e.message += '; automatic restore failed: ' + restoreError.message; }
    }
    if (publicationCommitted) e.message = 'Verified repair is published; cleanup is incomplete: ' + e.message;
    if (stage) e.message += `; original/candidate evidence retained at ${stage}; inspect ${lock || 'receipt.json'} before retry`;
    throw e;
  } finally {
    try { if (db) db.close(); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
}

function parseArgs(argv) {
  const out = { dbPath: null, apply: false, writersStopped: false };
  let mode;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--report', '--apply', '--prepare-offline', '--backup-online', '--release-hold'].includes(a)) { if (mode) throw new Error('choose exactly one mode'); mode = a; out.apply = a === '--apply'; if (!['--report', '--apply'].includes(a)) out.action = a; }
    else if (a === '--writers-stopped') out.writersStopped = true;
    else if (a === '--backup-dir') { out.backupDir = argv[++i]; if (!out.backupDir || out.backupDir.startsWith('--')) throw new Error('--backup-dir requires a path'); }
    else if (!a.startsWith('-') && !out.dbPath) out.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!mode || !out.dbPath) throw new Error('usage: repair-legacy-device-fk.js --check-runtime | <db> --backup-online --backup-dir <dir> | --prepare-offline | --report | --apply --writers-stopped --backup-dir <dir> | --release-hold');
  return out;
}
async function main(argv) {
  if (argv.length === 1 && argv[0] === '--check-runtime') return checkRuntime();
  const args = parseArgs(argv);
  if (['--prepare-offline', '--backup-online', '--release-hold'].includes(args.action)) {
    if (path.resolve(args.dbPath) !== '/data/db/farming.db') throw new Error('gateway maintenance modes require /data/db/farming.db');
    if (args.action === '--prepare-offline') return prepareOffline();
    if (args.action === '--backup-online') return backupOnline(args);
    return releaseHold({ verify: async file => {
      const checks = execFileSync('sqlite3', ['-init', '/dev/null', '-readonly', file, 'PRAGMA integrity_check; PRAGMA foreign_key_check;'], { encoding: 'utf8' }).trim();
      if (checks !== 'ok') throw new Error('database integrity/FK verification failed; keep writer hold');
      const { verifyHead } = require('../lib/osi-migrate');
      const { cliRunner } = require('../lib/osi-migrate/runner-iface');
      const result = await verifyHead(cliRunner(file, { readOnly: true }), { migrationsDir: path.join(ROOT, 'database/migrations/ordered') });
      if (!result.ok) throw new Error('migration verification failed; keep writer hold: ' + result.reason);
    } });
  }
  return repair(args);
}
if (require.main === module) main(process.argv.slice(2))
  .then(r => console.log(JSON.stringify(r))).catch(e => { console.error('Legacy device FK repair refused/failed: ' + e.message); process.exitCode = 1; });

module.exports = { repair, parseArgs, correctedSql, witness, assertNoOpenHandles, assertGatewayStopped };
