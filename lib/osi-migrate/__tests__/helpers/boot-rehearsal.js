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

// The node:sqlite shim that mirrors the osi-db-helper API `sync-init-fn` calls
// is scripts/rehearse-devices-rebuild.js's; it is exported behind a
// require.main guard so there is exactly one copy of it in the repo.
const { makeFacadeShim } = require('../../../../scripts/rehearse-devices-rebuild');

// Two devices plus telemetry, so the rebuild has real rows to preserve. The
// comparator is schema-only and cannot see row loss -- the #219 failure mode
// was DATA loss through a copy statement that omitted columns, not a missing
// column -- so the row counts and values this seeds are the only thing in this
// harness that could catch it.
const SEEDED_DEVICES = ['AAAA000000000101', 'AAAA000000000102'];
const TELEMETRY_PER_DEVICE = 3;

function seedDeviceRows(dbPath) {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const stmts = SEEDED_DEVICES.map((eui, i) =>
    `INSERT INTO devices (deveui,name,type_id,created_at,updated_at,sdi12_probe_profile,`
    + `sdi12_identity,sdi12_value_count,sdi12_channel_layout_json,chameleon_enabled) VALUES `
    + `('${eui}','n','KIWI_SENSOR',${now},${now},'SENTINEL_P${i}','SENTINEL_I${i}',${5 + i},`
    // chameleon_enabled deliberately 1, not NULL: the rebuild's COALESCE
    // default legitimately turns a NULL into 0 (#173), so a NULL here would
    // make the row-preservation assertion below fail for a correct rebuild.
    // 1 is a value the copy must carry through unchanged.
    + `'{"version":1,"address":"${i}"}',1);`
    + Array.from({ length: TELEMETRY_PER_DEVICE }, (_, j) =>
      `INSERT INTO device_data (deveui,recorded_at,swt_wm1) VALUES ('${eui}',${now},${10 + j});`).join(''));
  sh(dbPath, stmts.join(''));
}

function readRowWitness(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return {
      deviceCount: Number(db.prepare('SELECT COUNT(*) c FROM devices').get().c),
      telemetryCount: Number(db.prepare('SELECT COUNT(*) c FROM device_data').get().c),
      devices: db.prepare(
        'SELECT deveui, type_id, sdi12_probe_profile, sdi12_identity, sdi12_value_count,'
        + ' sdi12_channel_layout_json, chameleon_enabled FROM devices ORDER BY deveui').all(),
    };
  } finally { db.close(); }
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
// Returns { runner, refRunner, head, diffs, dbPath, refDbPath, boot, rowsBefore, rowsAfter }.
// `diffs` is compareSchemas(live, reference(head)).diffs -- the same comparator
// and the same reference the runner's isBootOwnedTriggerBodyDrift consults.
// `rowsBefore`/`rowsAfter` bracket the boot pass because the comparator cannot
// see row contents at all (see SEEDED_DEVICES).
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

  seedDeviceRows(dbPath);
  if (forceRebuild) narrowDevicesCheck(dbPath, DRIFTED_TYPES);
  // The deploy.sh stamp: fingerprints captured with Node-RED stopped, over
  // whatever the live schema is at that moment.
  await syncFingerprints(runner);

  const rowsBefore = readRowWitness(dbPath);
  const boot = await runBootNode(dbPath, deviceEui);
  const rowsAfter = readRowWitness(dbPath);
  if (mutateAfterBoot) await runner.exec(mutateAfterBoot);

  const refRunner = cliRunner(refDbPath);
  const { diffs } = compareSchemas(await snapshotSchema(runner), await snapshotSchema(refRunner));
  return { runner, refRunner, head, diffs, dbPath, refDbPath, boot, rowsBefore, rowsAfter };
}

module.exports = {
  stampThenBoot, headVersion, bootFuncText, makeFacadeShim, runBootNode,
  narrowDevicesCheck, readRowWitness, MIGRATIONS_DIR, REQUIRED_TYPES, DRIFTED_TYPES,
  SEEDED_DEVICES, TELEMETRY_PER_DEVICE,
};
