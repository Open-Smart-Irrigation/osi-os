'use strict';
// NEW-23: everything in the deploy that can refuse because of the gateway's
// state runs before the first change, and a refusal leaves the gateway
// exactly as it found it. Each case builds a fixture gateway, runs
// deploy.sh's own read-only checks (check_live_db_readonly and
// gateway_state_preflight, as the main sequence calls them, before the first
// change), and compares a manifest of the gateway-side tree before and after:
// every path with its type, size, mode, link target and SHA-256. The
// database's -shm is left out: it is the WAL index, holds no data of its own,
// and a read-only reader may create or rebuild it. The deploy's own $TMP_DIR
// is outside the tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const swap = require('./deploy-payload-swap');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const SEED = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');
const fn = (name) => {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(DEPLOY);
  assert.ok(m, `deploy.sh is missing ${name}()`);
  return m[0];
};
const pin = (name) => new RegExp(`^${name}="[0-9a-f]{64}"$`, 'm').exec(DEPLOY)[0];

function manifest(dir) {
  const out = {};
  const walk = (at) => {
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name);
      const rel = path.relative(dir, file);
      if (rel.endsWith('-shm')) continue;
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) out[rel] = `link ${fs.readlinkSync(file)}`;
      else if (st.isDirectory()) { out[rel] = `dir ${(st.mode & 0o7777).toString(8)}`; walk(file); }
      else out[rel] = `file ${st.size} ${(st.mode & 0o7777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

// A gateway: <root>/gw is the gateway-side tree (srv/node-red, data/db, the
// GUI, the NTP pieces); <root>/tmp is the deploy's own directory; <root>/bin
// holds the stand-ins.
function gateway() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-gw-preflight-'));
  const gw = path.join(root, 'gw');
  const g = {
    root, gw, tmp: path.join(root, 'tmp'), bin: path.join(root, 'bin'),
    srv: path.join(gw, 'srv/node-red'), db: path.join(gw, 'data/db/farming.db'), gui: path.join(gw, 'gui'),
    hook: path.join(gw, 'etc/hotplug.d/ntp/70-osi-irrigation-clock'), sysntpd: path.join(gw, 'etc/init.d/sysntpd'),
    hotplug: path.join(gw, 'usr/sbin/ntpd-hotplug'), backups: path.join(gw, 'data/backups/migrate'),
    pinOverride: null, dfKb: 50 * 1024 * 1024,
  };
  for (const d of [g.tmp, g.bin, path.join(g.srv, 'payloads'), path.dirname(g.db), path.dirname(g.sysntpd), path.dirname(g.hotplug)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(g.sysntpd, '#!/bin/sh\n[ "$1" = enabled ]\n', { mode: 0o755 });
  fs.writeFileSync(g.hotplug, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(g.bin, 'uci'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return g;
}

function seedDatabase(g) {
  fs.copyFileSync(SEED, g.db);
}

// A served payload that is a complete pair, with its schema record.
function servedPair(g, { compatibility = true } = {}) {
  const flows = path.join(g.root, 'flows-src.json');
  const guiSrc = path.join(g.root, 'gui-src');
  fs.writeFileSync(flows, '[]');
  fs.mkdirSync(guiSrc);
  fs.writeFileSync(path.join(guiSrc, 'index.html'), 'old');
  swap.stagePayload(g.srv, '20261101T000000Z', flows, guiSrc);
  swap.flipTo(g.srv, '20261101T000000Z', g.gui);
  if (compatibility) swap.writeCompatibility(g.srv, '20261101T000000Z', '80', 'L80');
  fs.rmSync(flows); fs.rmSync(guiSrc, { recursive: true });
}

function preflight(g) {
  fs.writeFileSync(path.join(g.bin, 'df'), `#!/bin/sh\necho "Filesystem 1K-blocks Used Available Use% Mounted"\necho "/dev/x 1 1 ${g.dfKb} 1% /"\n`, { mode: 0o755 });
  fs.copyFileSync(path.join(REPO, 'scripts/deploy-payload-swap.js'), path.join(g.tmp, 'deploy-payload-swap.js'));
  const script = `set -eu
BASE=file://${REPO}
TMP_DIR=${JSON.stringify(g.tmp)}
DB_DIR=${JSON.stringify(path.dirname(g.db))}
DB_PATH=${JSON.stringify(g.db)}
SWAP_ROOT=${JSON.stringify(g.srv)}
SWAP_JS="$TMP_DIR/deploy-payload-swap.js"
GUI_ROOT=${JSON.stringify(g.gui)}
DEPLOY_STAMP=20261115T000000Z
MIGRATE_BACKUP_DIR=${JSON.stringify(g.backups)}
IRRIGATION_CLOCK_HOOK=${JSON.stringify(g.hook)}
IRRIGATION_SYSNTPD_INIT=${JSON.stringify(g.sysntpd)}
IRRIGATION_NTPD_HOTPLUG=${JSON.stringify(g.hotplug)}
IRRIGATION_UCI=uci
COMMAND_LEDGER_INSTALLER="$TMP_DIR/deploy-command-ledger-dependency.js"
${g.pinOverride ? `COMMAND_LEDGER_HELPER_SHA256="${g.pinOverride}"` : pin('COMMAND_LEDGER_HELPER_SHA256')}
DAMAGED_DB_DOC=docs/operations/damaged-farm-database.md
export SWAP_ROOT SWAP_JS
${['fetch', 'fetch_required', 'file_sha256', 'check_fetched_manifest', 'check_fetched_js_files', 'fetch_migration_runner', 'swap_call', 'ensure_sqlite3_cli', 'check_live_db_readonly', 'gateway_state_preflight'].map(fn).join('\n')}
check_live_db_readonly || exit 1
gateway_state_preflight || exit 1
echo PREFLIGHT_PASSED
`;
  return spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${g.bin}:${path.dirname(process.execPath)}:${process.env.PATH}` } });
}

function refusedUnchanged(name, build, reason) {
  test(`refused before anything changes: ${name}`, () => {
    const g = gateway();
    try {
      build(g);
      const before = manifest(g.gw);
      const r = preflight(g);
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout, /PREFLIGHT_PASSED/);
      assert.match(r.stderr, reason);
      assert.deepEqual(manifest(g.gw), before, 'the gateway-side tree is byte-identical');
    } finally {
      fs.rmSync(g.root, { recursive: true, force: true });
    }
  });
}

test('a gateway in order passes, and the preflight changes nothing on it', () => {
  const g = gateway();
  try {
    seedDatabase(g);
    servedPair(g);
    const before = manifest(g.gw);
    const r = preflight(g);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PREFLIGHT_PASSED/);
    assert.deepEqual(manifest(g.gw), before);
  } finally {
    fs.rmSync(g.root, { recursive: true, force: true });
  }
});

refusedUnchanged('the database is missing but its sidecar files are there', (g) => {
  fs.writeFileSync(`${g.db}-wal`, 'orphan');
}, /farming\.db is missing but SQLite sidecar files exist; .*refusing before anything is changed/);

refusedUnchanged('the clock hook needs sysntpd, which is missing', (g) => {
  fs.rmSync(g.sysntpd);
}, /requires executable .*sysntpd; refusing before anything is changed/);

refusedUnchanged('the clock hook needs sysntpd enabled', (g) => {
  fs.writeFileSync(g.sysntpd, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
}, /sysntpd is not enabled/);

refusedUnchanged('the command-ledger installer does not match its pin', (g) => {
  g.pinOverride = '0'.repeat(64);
}, /installer did not arrive intact \(SHA-256\); refusing before anything is changed/);

refusedUnchanged('too little free space for the migration', (g) => {
  seedDatabase(g);
  g.dfKb = 1024;
}, /insufficient disk for a safe schema migration .*refusing before anything is changed/);

refusedUnchanged('a repair_required ledger row whose checksum matches the release', (g) => {
  seedDatabase(g);
  const r = spawnSync('sqlite3', [g.db, "UPDATE schema_migrations SET status='repair_required' WHERE version=(SELECT MAX(version) FROM schema_migrations)"], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}, /repair_required row whose checksum matches this release; clear it with .*--clear-repair-required/);

refusedUnchanged('the retained payload has no schema compatibility record', (g) => {
  seedDatabase(g);
  servedPair(g, { compatibility: false });
}, /retained payload 20261101T000000Z has no schema compatibility record/);

refusedUnchanged('a damaged database (read-only integrity check)', (g) => {
  seedDatabase(g);
  const fd = fs.openSync(g.db, 'r+');
  try { fs.writeSync(fd, Buffer.alloc(2048, 0x5a), 0, 2048, 4096 + 16); } finally { fs.closeSync(fd); }
}, /failed its integrity check|could not be opened for its integrity check/);

test('the preflight runs before the deploy\'s first change on the gateway', () => {
  const pre = DEPLOY.indexOf('\ngateway_state_preflight || exit 1\n');
  const firstChange = DEPLOY.indexOf('cp "$SWAP_JS" /srv/node-red/.payload-swap.js.tmp');
  assert.ok(pre > 0 && pre < firstChange);
});
