'use strict';
// Task 4 / osi-os#221 characterisation harness.
//
// Reproduces, in a scratch DB, the exact sequence that blocked Uganda on
// 2026-09-11: `deploy.sh` runs the migration runner with Node-RED stopped and
// stamps schema_object_fingerprints against the result, then the very next
// Node-RED start executes the frozen `sync-init-fn` boot node, which may
// rebuild `devices`. The question this helper exists to answer is whether that
// boot pass leaves any diff the runner's drift gate refuses.
//
// Everything here executes the SHIPPED artifacts: the real ordered migrations
// via scripts/baseline-existing-db.js's reference-chain builder, and the real
// `sync-init-fn` function text lifted out of flows.json. A hand-copied DDL in a
// test would prove nothing about what the fleet actually runs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '../../../..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

const { cliRunner } = require('../../runner-iface');
const { syncFingerprints } = require('../../runner');
const { loadMigrations } = require('../../migrations-loader');
const { buildReference } = require('../../../../scripts/baseline-existing-db');
const { snapshotSchema, compareSchemas } = require('../../../../scripts/semantic-schema-compare');

// The canonical `devices.type_id` CHECK list the boot node converges on. A live
// CHECK that is a strict subset of this is what makes the boot node rebuild.
const REQUIRED_TYPES = ['KIWI_SENSOR', 'STREGA_VALVE', 'DRAGINO_LSN50', 'TEKTELIC_CLOVER',
  'SENSECAP_S2120', 'AQUASCOPE_LORAIN', 'MILESIGHT_UC512', 'DRAGINO_SDI12'];
const DRIFTED_TYPES = REQUIRED_TYPES.filter((t) => t !== 'AQUASCOPE_LORAIN' && t !== 'DRAGINO_SDI12');

function headVersion() {
  const migrations = loadMigrations(MIGRATIONS_DIR);
  return migrations[migrations.length - 1].version;
}

function bootFuncText() {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === 'sync-init-fn');
  if (!node || !node.func) throw new Error('sync-init-fn not found in flows.json');
  return node.func;
}

function sh(db, sql) { execFileSync('sqlite3', ['-bail', db], { input: sql, encoding: 'utf8' }); }

// Narrow the live `devices` CHECK the way scripts/rehearse-devices-rebuild.js's
// reseedDevicesCheck does, so the boot node's set-equality guard fires and the
// rebuild actually runs. MUST happen before the stamp: narrowing afterwards
// would bake the rebuild's own result into the baseline and the characterisation
// would pass vacuously.
function narrowDevicesCheck(db, types) {
  const out = execFileSync('sqlite3', ['-json', db,
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'"], { encoding: 'utf8' }).trim();
  const cur = JSON.parse(out)[0].sql;
  const list = types.map((t) => `'${t}'`).join(',');
  const narrowed = cur.replace(/CHECK\s*\(\s*type_id\s+IN\s*\([\s\S]*?\)/i, `CHECK(type_id IN (${list})`);
  if (narrowed === cur) throw new Error('narrowDevicesCheck: type_id CHECK not found in the live devices DDL');
  sh(db, 'PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;'
    + `ALTER TABLE devices RENAME TO devices_seedtmp; ${narrowed};`
    + 'INSERT INTO devices SELECT * FROM devices_seedtmp; DROP TABLE devices_seedtmp;'
    + 'PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
}

// Facade-compatible shim over node:sqlite, mirroring the osi-db-helper API that
// `sync-init-fn` calls (run/get/all/exec as promise OR node-style callback,
// plus transaction/close). Same shape as scripts/rehearse-devices-rebuild.js's
// makeFacadeShim; that file runs main() at require time, so it cannot be
// required from a test.
function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
    try {
      let r;
      if (kind === 'run' || kind === 'exec') { db.exec(sql); r = undefined; }
      else if (kind === 'get') r = db.prepare(sql).get();
      else r = db.prepare(sql).all();
      if (typeof cb === 'function') { process.nextTick(() => cb(null, r)); return undefined; }
      return Promise.resolve(r);
    } catch (e) {
      if (typeof cb === 'function') { process.nextTick(() => cb(e)); return undefined; }
      return Promise.reject(e);
    }
  };
  const scope = { run: call('run'), all: call('all'), get: call('get'), exec: call('exec') };
  return Object.assign({}, scope, {
    async transaction(executor) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await executor(scope); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* rollback of a failed tx */ } throw e; }
    },
    close(cb) { try { db.close(); } catch (_) { /* already closed */ } if (typeof cb === 'function') cb(); },
  });
}

async function runBootNode(dbPath, deviceEui) {
  const errors = [];
  const warnings = [];
  // `new osiDb.Database(...)`: a shorthand method has no [[Construct]] slot, so
  // this must stay a function expression or the boot node dies with
  // "osiDb.Database is not a constructor" before it touches the schema.
  const osiDb = { Database: function () { return makeFacadeShim(dbPath); }, verbose() { return osiDb; } };
  const env = { get: (k) => (k === 'DEVICE_EUI' ? deviceEui : '') };
  const node = {
    error(m) { errors.push(String(m)); },
    warn(m) { warnings.push(String(m)); },
    status() {}, log() {},
  };
  // eslint-disable-next-line no-new-func -- executing the shipped function-node body verbatim
  const fn = new Function('osiDb', 'env', 'node', 'msg', bootFuncText());
  await fn(osiDb, env, node, {});
  return { errors, warnings };
}

// stampThenBoot: migrate a scratch DB to `head`, optionally drift `devices` so
// the boot node must rebuild it, stamp fingerprints (the deploy.sh step), run
// the shipped boot node, optionally mutate the result, and report the diffs the
// drift gate would see.
//
// Returns { runner, refRunner, head, diffs, dbPath, refDbPath, boot }.
// `diffs` is compareSchemas(live, reference(head)).diffs -- the same comparator
// and the same reference the runner's isBootOwnedTriggerBodyDrift consults.
async function stampThenBoot({
  head = headVersion(),
  deviceEui = '0016C001F151B1D6',
  forceRebuild = false,
  mutateAfterBoot = null,
} = {}) {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-boot-rehearsal-'));
  const refDbPath = await buildReference(MIGRATIONS_DIR, head, scratchRoot);

  const dbPath = path.join(scratchRoot, 'farming.db');
  fs.copyFileSync(refDbPath, dbPath);
  for (const sidecar of ['-wal', '-shm']) {
    if (fs.existsSync(refDbPath + sidecar)) fs.copyFileSync(refDbPath + sidecar, dbPath + sidecar);
  }
  const runner = cliRunner(dbPath);

  if (forceRebuild) narrowDevicesCheck(dbPath, DRIFTED_TYPES);
  // The deploy.sh stamp: fingerprints captured with Node-RED stopped, over
  // whatever the live schema is at that moment.
  await syncFingerprints(runner);

  const boot = await runBootNode(dbPath, deviceEui);
  if (mutateAfterBoot) await runner.exec(mutateAfterBoot);

  const refRunner = cliRunner(refDbPath);
  const { diffs } = compareSchemas(await snapshotSchema(runner), await snapshotSchema(refRunner));
  return { runner, refRunner, head, diffs, dbPath, refDbPath, boot };
}

module.exports = {
  stampThenBoot, headVersion, bootFuncText, makeFacadeShim, runBootNode,
  narrowDevicesCheck, MIGRATIONS_DIR, REQUIRED_TYPES, DRIFTED_TYPES,
};
