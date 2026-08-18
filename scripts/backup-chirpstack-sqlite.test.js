'use strict';
// Tests for scripts/backup-chirpstack-sqlite.js — checked online ChirpStack
// SQLite backup helper. Uses the real sqlite3 CLI and real SQLite files in
// temp dirs (node:test). No network, no live hosts, no service mutation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'backup-chirpstack-sqlite.js');

function mkTmp() {
  const boundary = path.join('/tmp', `osi-chirpstack-backup-tests-${process.getuid()}`);
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  fs.chmodSync(boundary, 0o700);
  return fs.mkdtempSync(path.join(boundary, 'case-'));
}

function createSourceDb(dbPath, rows) {
  execFileSync('sqlite3', [dbPath], {
    input: `CREATE TABLE t(x INTEGER, y TEXT);\n${
      Array.from({ length: rows }, (_, i) => `INSERT INTO t VALUES (${i}, 'row-${i}-abcdefghijklmnopqrstuvwxyz');`).join('\n')
    }\n`,
  });
}

function writeRuntimeConfig(configPath, declaredSqlitePath) {
  fs.writeFileSync(
    configPath,
    `[sqlite]\npath="${declaredSqlitePath}"\n\n[gateway]\nallow_unknown_gateways=true\n`
  , { mode: 0o600 });
}

function writeWatchdogAdapter(adapterPath, watchdogMs = 300) {
  fs.writeFileSync(adapterPath, `${JSON.stringify({ watchdogMs })}\n`, { mode: 0o600 });
}

// Fake adapters mirror the real normalized procd shape: per-instance
// running state AND pid, so a same-name respawn is visible.
function writeStableAdapter(adapterPath) {
  fs.writeFileSync(
    adapterPath,
    `'use strict';\nmodule.exports.captureServiceIdentity = async function captureServiceIdentity() {\n  return { enabled: true, running: true, instances: { instance1: { running: true, pid: 4242 } } };\n};\n`
  , { mode: 0o600 });
}

function writeFixedPidAdapter(adapterPath, pid) {
  fs.writeFileSync(
    adapterPath,
    `'use strict';\nmodule.exports.captureServiceIdentity = async function captureServiceIdentity() {\n  return { enabled: true, running: true, instances: { instance1: { running: true, pid: ${pid} } } };\n};\n`,
    { mode: 0o600 }
  );
}

function writeRestartingAdapter(adapterPath) {
  fs.writeFileSync(
    adapterPath,
    `'use strict';\nlet calls = 0;\nmodule.exports.captureServiceIdentity = async function captureServiceIdentity() {\n  calls += 1;\n  return calls === 1\n    ? { enabled: true, running: true, instances: { instance1: { running: true, pid: 100 } } }\n    : { enabled: true, running: true, instances: { instance2: { running: true, pid: 100 } } };\n};\n`
  , { mode: 0o600 });
}

// Same instance name before and after -- only the pid changed, i.e. procd
// respawned the fixed-name chirpstack instance during the backup.
function writeRespawnAdapter(adapterPath) {
  fs.writeFileSync(
    adapterPath,
    `'use strict';\nlet calls = 0;\nmodule.exports.captureServiceIdentity = async function captureServiceIdentity() {\n  calls += 1;\n  return calls === 1\n    ? { enabled: true, running: true, instances: { instance1: { running: true, pid: 100 } } }\n    : { enabled: true, running: true, instances: { instance1: { running: true, pid: 200 } } };\n};\n`
  );
}

function chmodX(p) {
  fs.chmodSync(p, 0o755);
}

const REAL_SQLITE3 = execFileSync('sh', ['-c', 'command -v sqlite3']).toString().trim();

function runCli(args, opts = {}) {
  const completeArgs = [...args];
  if (completeArgs.includes('--destination') && !completeArgs.includes('--attempt-state')) {
    const destination = completeArgs[completeArgs.indexOf('--destination') + 1];
    if (destination && path.isAbsolute(destination)) {
      const attemptDir = path.dirname(destination);
      const attemptState = path.join(attemptDir, 'chirpstack-attempt-state.json');
      const runtimeManifestSha256 = 'a'.repeat(64);
      if (!fs.existsSync(attemptState)) fs.writeFileSync(attemptState, JSON.stringify({
        format: 1, deploymentId: 'dep-chirpstack-test', phase: 'chirpstack-backup-in-progress',
        attemptDirectory: attemptDir, runtimeManifestSha256,
      }), { mode: 0o600 });
      completeArgs.push('--attempt-state', attemptState, '--deployment-id', 'dep-chirpstack-test',
        '--expected-attempt-manifest-sha256', runtimeManifestSha256);
    }
  }
  return spawnSync('node', [SCRIPT, ...completeArgs], {
    encoding: 'utf8',
    timeout: 15_000,
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function baseFixture() {
  const root = mkTmp();
  const srvDir = path.join(root, 'srv', 'chirpstack');
  fs.mkdirSync(srvDir, { recursive: true });
  const source = path.join(srvDir, 'chirpstack.sqlite');
  createSourceDb(source, 500);
  const runtimeConfig = path.join(root, 'chirpstack.toml');
  writeRuntimeConfig(runtimeConfig, source);
  const adapter = path.join(root, 'adapter.js');
  writeStableAdapter(adapter);
  const destination = path.join(root, 'backup.sqlite');
  const manifestOut = path.join(root, 'manifest.json');
  return { root, source, runtimeConfig, adapter, destination, manifestOut };
}

function defaultEnv(adapterPath, extra = {}) {
  return {
    BACKUP_CHIRPSTACK_SERVICE_ADAPTER: adapterPath,
    BACKUP_CHIRPSTACK_TEST_ROOT: path.dirname(adapterPath),
    OSI_REPAIR_PROGRAM_MODE: '1',
    OSI_DEPLOY_ARTIFACT_MODE: 'test',
    ...extra,
  };
}

test('literal production source prohibits the service test adapter before source access', () => {
  const f = baseFixture();
  writeRuntimeConfig(f.runtimeConfig, '/srv/chirpstack/chirpstack.sqlite');
  const result = runCli(['--runtime-config', f.runtimeConfig, '--source', '/srv/chirpstack/chirpstack.sqlite',
    '--destination', f.destination, '--manifest-out', f.manifestOut], { env: defaultEnv(f.adapter) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /adapter.*production|production.*adapter/i);
});

test('every database publication crash boundary resumes the bound attempt and publishes one manifest', () => {
  for (const point of ['after-partial-fsync', 'after-prefix', 'after-link', 'after-publication-fsync', 'after-publish', 'after-unlink']) {
    const f = baseFixture();
    const args = ['--runtime-config', f.runtimeConfig, '--source', f.source,
      '--destination', f.destination, '--manifest-out', f.manifestOut];
    const crashed = runCli(args, { env: defaultEnv(f.adapter, { BACKUP_CHIRPSTACK_CRASH_AT: point }) });
    assert.equal(crashed.status, 137, `${point}: ${crashed.stderr}`);
    assert.equal(fs.existsSync(f.manifestOut), false, point);
    const resumed = runCli(args, { env: defaultEnv(f.adapter) });
    assert.equal(resumed.status, 0, `${point}: ${resumed.stderr}`);
    assert.equal(fs.existsSync(f.manifestOut), true, point);
    assert.equal(JSON.parse(resumed.stdout).backup.sha256, JSON.parse(fs.readFileSync(f.manifestOut)).backup.sha256, point);
  }
});

test('resume rejects identical-byte destination inode replacement before manifest publication', () => {
  const f = baseFixture();
  const args = ['--runtime-config', f.runtimeConfig, '--source', f.source,
    '--destination', f.destination, '--manifest-out', f.manifestOut];
  const crashed = runCli(args, { env: defaultEnv(f.adapter, { BACKUP_CHIRPSTACK_CRASH_AT: 'after-link' }) });
  assert.equal(crashed.status, 137, crashed.stderr);
  const replacement = path.join(f.root, 'replacement-backup.sqlite');
  fs.copyFileSync(f.destination, replacement);
  fs.chmodSync(replacement, 0o600);
  fs.renameSync(replacement, f.destination);
  const resumed = runCli(args, { env: defaultEnv(f.adapter) });
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /device|inode|identity|published/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('resume revalidates source inode and service identity before manifest publication', () => {
  for (const drift of ['source', 'service']) {
    const f = baseFixture();
    const args = ['--runtime-config', f.runtimeConfig, '--source', f.source,
      '--destination', f.destination, '--manifest-out', f.manifestOut];
    const crashed = runCli(args, { env: defaultEnv(f.adapter, { BACKUP_CHIRPSTACK_CRASH_AT: 'after-unlink' }) });
    assert.equal(crashed.status, 137, `${drift}: ${crashed.stderr}`);
    if (drift === 'source') {
      const replacement = path.join(f.root, 'replacement-source.sqlite');
      fs.copyFileSync(f.source, replacement);
      fs.renameSync(replacement, f.source);
    } else {
      writeFixedPidAdapter(f.adapter, 5252);
    }
    const resumed = runCli(args, { env: defaultEnv(f.adapter) });
    assert.notEqual(resumed.status, 0, `${drift}: ${resumed.stderr}`);
    assert.match(resumed.stderr, /source|device|inode|service|identity|pid/i);
    assert.equal(fs.existsSync(f.manifestOut), false);
  }
});

// ---------------------------------------------------------------------------
// argv contract
// ---------------------------------------------------------------------------

test('argv: unknown flag is rejected', () => {
  const f = baseFixture();
  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
    '--bogus-flag', '/tmp/x',
  ], { env: defaultEnv(f.adapter) });
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('argv: duplicate flag is rejected', () => {
  const f = baseFixture();
  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('argv: relative path is rejected', () => {
  const f = baseFixture();
  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', 'relative/chirpstack.sqlite',
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('argv: missing required flags fails fast without reading stdin', () => {
  const res = spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    timeout: 5_000,
    input: '',
  });
  assert.notEqual(res.status, 0);
  assert.notEqual(res.signal, 'SIGTERM', 'must not hang waiting on stdin until spawnSync timeout kills it');
});

test('argv: stdin-style "-" value is rejected as non-absolute', () => {
  const f = baseFixture();
  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', '-',
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

// ---------------------------------------------------------------------------
// core behavior
// ---------------------------------------------------------------------------

test('happy path with WAL writes injected during the online backup', async () => {
  const f = baseFixture();
  execFileSync('sqlite3', [f.source], { input: 'PRAGMA journal_mode=WAL;\n' });

  const stopFile = path.join(f.root, 'writer.stop');
  const countFile = path.join(f.root, 'writer.count');
  const writerScript = path.join(f.root, 'writer.sh');
  fs.writeFileSync(
    writerScript,
    `#!/bin/sh\nset -eu\ndb="$1"\nstopfile="$2"\ncountfile="$3"\ni=0\nwhile [ ! -f "$stopfile" ]; do\n  i=$((i+1))\n  sqlite3 -cmd ".timeout 2000" "$db" "INSERT INTO t VALUES ($i, 'writer-$i');" 2>/dev/null || true\n  sleep 0.02\ndone\nprintf '%s' "$i" > "$countfile"\n`
  );
  chmodX(writerScript);

  const writer = spawn('sh', [writerScript, f.source, stopFile, countFile], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the writer get going

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });

  fs.writeFileSync(stopFile, '1');
  await new Promise((resolve) => writer.on('exit', resolve));

  const writerCount = Number(fs.readFileSync(countFile, 'utf8'));
  assert.ok(writerCount > 0, 'writer must have produced at least one concurrent write');

  assert.equal(res.status, 0, `expected success, stderr: ${res.stderr}`);
  assert.ok(fs.existsSync(f.manifestOut), 'manifest must be published on success');
  assert.ok(fs.existsSync(f.destination), 'backup file must exist');

  const manifest = JSON.parse(fs.readFileSync(f.manifestOut, 'utf8'));
  assert.equal(manifest.method, 'sqlite3-online-backup');
  assert.equal(manifest.check.result, 'ok');
  assert.equal(manifest.schemaVersion.before, manifest.schemaVersion.after);
  assert.equal(manifest.schemaVersion.before, manifest.schemaVersion.backup);

  const stdoutLine = res.stdout.trim();
  assert.equal(stdoutLine.split('\n').length, 1, 'stdout result must be a single bounded line');
  JSON.parse(stdoutLine); // must itself be valid JSON

  // destination is an internally consistent, independently openable database
  const check = execFileSync('sqlite3', [f.destination, 'PRAGMA quick_check;'], { encoding: 'utf8' }).trim();
  assert.equal(check, 'ok');
});

test('production sqlite authority ignores caller PATH shadows', () => {
  const f = baseFixture();
  const shadowDir = path.join(f.root, 'ambient-shadow'); fs.mkdirSync(shadowDir);
  const sentinel = path.join(f.root, 'ambient-sqlite3-ran');
  const shadow = path.join(shadowDir, 'sqlite3');
  fs.writeFileSync(shadow, `#!/bin/sh\nprintf shadow >${JSON.stringify(sentinel)}\nexit 99\n`, { mode: 0o755 });
  const result = runCli([
    '--runtime-config', f.runtimeConfig, '--source', f.source,
    '--destination', f.destination, '--manifest-out', f.manifestOut,
  ], { env: { ...defaultEnv(f.adapter), PATH: `${shadowDir}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(sentinel), false, 'ambient sqlite3 must never execute');
});

test('sqlite test adapter rejects a symlink ancestor outside its exact test root', () => {
  const f = baseFixture();
  const outside = mkTmp();
  const outsideTool = path.join(outside, 'sqlite3');
  fs.copyFileSync(REAL_SQLITE3, outsideTool); fs.chmodSync(outsideTool, 0o755);
  const linkedDir = path.join(f.root, 'linked-tools'); fs.symlinkSync(outside, linkedDir);
  const result = runCli([
    '--runtime-config', f.runtimeConfig, '--source', f.source,
    '--destination', f.destination, '--manifest-out', f.manifestOut,
  ], { env: { ...defaultEnv(f.adapter), BACKUP_CHIRPSTACK_SQLITE3: path.join(linkedDir, 'sqlite3') } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /adapter|symlink|test root|boundary/i);
  assert.equal(fs.existsSync(f.destination), false);
});

test('source replaced mid-run (device/inode change) fails without a manifest', () => {
  const f = baseFixture();
  const replacement = path.join(f.root, 'replacement.sqlite');
  createSourceDb(replacement, 5);

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    src="$3"\n    mv "$SHIM_REPLACEMENT" "$src"\n    exec "$SHIM_REAL_SQLITE3" "$@"\n    ;;\n  *)\n    exec "$SHIM_REAL_SQLITE3" "$@"\n    ;;\nesac\n`
  );
  chmodX(shim);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    env: {
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_SQLITE3: shim,
      SHIM_REAL_SQLITE3: REAL_SQLITE3,
      SHIM_REPLACEMENT: replacement,
    },
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /device|inode|replaced/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('concurrent DDL (schema_version bump) fails without a manifest', () => {
  const f = baseFixture();

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    src="$3"\n    "$SHIM_REAL_SQLITE3" -cmd ".timeout 5000" "$src" "ALTER TABLE t ADD COLUMN z TEXT;"\n    exec "$SHIM_REAL_SQLITE3" "$@"\n    ;;\n  *)\n    exec "$SHIM_REAL_SQLITE3" "$@"\n    ;;\nesac\n`
  );
  chmodX(shim);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    env: {
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_SQLITE3: shim,
      SHIM_REAL_SQLITE3: REAL_SQLITE3,
    },
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /schema_version|schema/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('runtime config replacement during backup fails before publishing any backup authority', () => {
  const f = baseFixture();
  const shimDir = path.join(f.root, 'config-race-shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  fs.writeFileSync(shim, `#!/bin/sh
case "$*" in
  *".backup "*)
    cp "$RUNTIME_CONFIG" "$RUNTIME_CONFIG.replacement"
    printf '\n# changed during backup\n' >> "$RUNTIME_CONFIG.replacement"
    mv "$RUNTIME_CONFIG.replacement" "$RUNTIME_CONFIG"
    ;;
esac
exec "$REAL_SQLITE3" "$@"
`);
  chmodX(shim);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: {
    ...defaultEnv(f.adapter),
    BACKUP_CHIRPSTACK_SQLITE3: shim,
    REAL_SQLITE3,
    RUNTIME_CONFIG: f.runtimeConfig,
  } });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /runtime config|configuration|device|inode|hash|bytes|changed/i);
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.existsSync(f.manifestOut), false);
  assert.equal(fs.existsSync(path.join(f.root, '.chirpstack-backup.publish.json')), false);
});

test('stuck child is killed by the watchdog, fails, no manifest, no orphan', () => {
  const f = baseFixture();
  const watchdogAdapter = path.join(f.root, 'watchdog-deadline.json');
  writeWatchdogAdapter(watchdogAdapter);

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  const pidFile = path.join(f.root, 'stuck.pid');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    echo "$$" > "$SHIM_PID_FILE"\n    exec sleep 5\n    ;;\n  *)\n    exec "$SHIM_REAL_SQLITE3" "$@"\n    ;;\nesac\n`
  );
  chmodX(shim);

  const start = Date.now();
  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    timeout: 10_000,
    env: {
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_SQLITE3: shim,
      SHIM_REAL_SQLITE3: REAL_SQLITE3,
      SHIM_PID_FILE: pidFile,
      BACKUP_CHIRPSTACK_WATCHDOG_ADAPTER: watchdogAdapter,
      BACKUP_CHIRPSTACK_WATCHDOG_MS: '1',
    },
  });
  const elapsedMs = Date.now() - start;

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /watchdog|timed out|killed/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
  assert.ok(elapsedMs < 5_000, `watchdog must cut the 5s sleep short (took ${elapsedMs}ms)`);

  assert.ok(fs.existsSync(pidFile), 'shim must have recorded the stuck child pid');
  const stuckPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  let alive = true;
  try {
    process.kill(stuckPid, 0);
  } catch (err) {
    alive = err.code !== 'ESRCH' ? true : false;
  }
  assert.equal(alive, false, `stuck child pid ${stuckPid} must not remain as an orphan`);
});

test('watchdog kill cleans up the partial destination and its -journal so an immediate rerun succeeds', () => {
  const f = baseFixture();
  const watchdogAdapter = path.join(f.root, 'watchdog-deadline.json');
  writeWatchdogAdapter(watchdogAdapter);

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  // Simulates a genuinely stuck backup that has already created a partial
  // destination and a rollback journal before hanging.
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    for arg do case "$arg" in .backup*) BACKUP_CMD=$arg;; esac; done\n    ACTUAL_DEST=$(printf '%s' "$BACKUP_CMD" | sed "s/^\\.backup '//;s/'$//")\n    printf 'partial-destination-bytes' > "$ACTUAL_DEST"\n    printf 'stray-journal-bytes' > "$ACTUAL_DEST-journal"\n    exec sleep 5\n    ;;\n  *)\n    exec "$SHIM_REAL_SQLITE3" "$@"\n    ;;\nesac\n`
  );
  chmodX(shim);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    timeout: 10_000,
    env: {
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_SQLITE3: shim,
      SHIM_REAL_SQLITE3: REAL_SQLITE3,
      BACKUP_CHIRPSTACK_WATCHDOG_ADAPTER: watchdogAdapter,
      BACKUP_CHIRPSTACK_WATCHDOG_MS: '1',
    },
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /watchdog|timed out|killed/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
  assert.equal(fs.existsSync(f.destination), false, 'partial destination must be removed on failure');
  assert.equal(fs.existsSync(`${f.destination}-journal`), false, 'stray -journal must be removed on failure');
  assert.equal(fs.existsSync(`${f.destination}-wal`), false);
  assert.equal(fs.existsSync(`${f.destination}-shm`), false);
  assert.ok(fs.existsSync(f.source), 'source is never touched');

  // Immediate rerun with the SAME --destination and the real sqlite3 must
  // succeed: no stale-collision at the destination-exists preflight.
  const rerun = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });
  assert.equal(rerun.status, 0, `rerun expected success, stderr: ${rerun.stderr}`);
  assert.ok(fs.existsSync(f.manifestOut));
  const check = execFileSync('sqlite3', [f.destination, 'PRAGMA quick_check;'], { encoding: 'utf8' }).trim();
  assert.equal(check, 'ok');
});

test('service restart detected via fake adapter fails without a manifest', () => {
  const f = baseFixture();
  const restartingAdapter = path.join(f.root, 'restarting-adapter.js');
  writeRestartingAdapter(restartingAdapter);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(restartingAdapter) });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /service|identity|restart/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('same-name respawn (unchanged names, changed pid) fails without a manifest', () => {
  const f = baseFixture();
  const respawnAdapter = path.join(f.root, 'respawn-adapter.js');
  writeRespawnAdapter(respawnAdapter);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(respawnAdapter) });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /service|identity|restart/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('destination already exists fails before spawn', () => {
  const f = baseFixture();
  fs.writeFileSync(f.destination, 'pre-existing');

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  const poisonFile = path.join(f.root, 'spawn-happened');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    : > "$SHIM_POISON_FILE"\n    ;;\nesac\nexec "$SHIM_REAL_SQLITE3" "$@"\n`
  );
  chmodX(shim);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    env: {
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_SQLITE3: shim,
      SHIM_REAL_SQLITE3: REAL_SQLITE3,
      SHIM_POISON_FILE: poisonFile,
    },
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /destination/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
  assert.equal(fs.existsSync(poisonFile), false, '.backup must never have been spawned');
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'pre-existing', 'pre-existing destination bytes are untouched');
});

test('manifest-out already exists fails before spawn and leaves both files untouched', () => {
  const f = baseFixture();
  fs.writeFileSync(f.manifestOut, '{"pre":"existing"}');

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  const poisonFile = path.join(f.root, 'spawn-happened');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    : > "$SHIM_POISON_FILE"\n    ;;\nesac\nexec "$SHIM_REAL_SQLITE3" "$@"\n`
  );
  chmodX(shim);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    env: {
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_SQLITE3: shim,
      SHIM_REAL_SQLITE3: REAL_SQLITE3,
      SHIM_POISON_FILE: poisonFile,
    },
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /manifest-out already exists/i);
  assert.equal(fs.existsSync(poisonFile), false, '.backup must never have been spawned');
  assert.equal(fs.existsSync(f.destination), false, 'destination must not be created');
  assert.equal(fs.readFileSync(f.manifestOut, 'utf8'), '{"pre":"existing"}', 'pre-existing manifest bytes are untouched');
});

test('quick_check failure on the backup (corrupt destination via shim) fails without a manifest', () => {
  const f = baseFixture();

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  // The backup itself succeeds; the shim then flips btree-page-header bytes
  // at offset 4096 (page 2) of the destination, so schema_version still reads
  // fine but PRAGMA quick_check reports corruption. The destination path is
  // handed to the shim via env to avoid re-parsing the quoted dot-command.
  fs.writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *".backup "*)',
      '    "$SHIM_REAL_SQLITE3" "$@"',
      '    for arg do case "$arg" in .backup*) BACKUP_CMD=$arg;; esac; done',
      "    ACTUAL_DEST=$(printf '%s' \"$BACKUP_CMD\" | sed \"s/^\\\\.backup '//;s/'$//\")",
      '    printf \'\\377\\377\\377\\377\' | dd of="$ACTUAL_DEST" bs=1 seek=4096 count=4 conv=notrunc 2>/dev/null',
      '    ;;',
      '  *)',
      '    exec "$SHIM_REAL_SQLITE3" "$@"',
      '    ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodX(shim);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    env: {
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_SQLITE3: shim,
      SHIM_REAL_SQLITE3: REAL_SQLITE3,
    },
  });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /quick_check|malformed|corrupt/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
  assert.equal(fs.existsSync(f.destination), false, 'corrupt backup must be removed on failure');
  assert.equal(fs.existsSync(`${f.destination}-journal`), false);
  assert.ok(fs.existsSync(f.source), 'source is never touched');
});

test('runtime-config drift (declared path != --source) fails before lstat', () => {
  const f = baseFixture();
  const otherPath = path.join(f.root, 'srv', 'a-different-name.sqlite');
  writeRuntimeConfig(f.runtimeConfig, otherPath);

  // If lstat ran first it would fail on a distinct, unambiguous "no such file"
  // style message for a path we never touch; assert instead on the
  // config-vs-source drift message specifically.
  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /runtime config|declares/i);
  assert.equal(fs.existsSync(f.manifestOut), false);
});

test('runtime config must still declare the production ChirpStack sqlite path in the default deployment shape', () => {
  const f = baseFixture();
  // Exercise the exact literal path named in the plan/brief end-to-end using a
  // fixture root rather than the real /srv path (paths are injectable).
  const prodStyleRoot = mkTmp();
  const prodSrv = path.join(prodStyleRoot, 'srv', 'chirpstack');
  fs.mkdirSync(prodSrv, { recursive: true });
  const prodSource = path.join(prodSrv, 'chirpstack.sqlite');
  createSourceDb(prodSource, 10);
  const prodConfig = path.join(prodStyleRoot, 'chirpstack.toml');
  writeRuntimeConfig(prodConfig, prodSource);
  const prodDestination = path.join(prodStyleRoot, 'backup.sqlite');
  const prodManifestOut = path.join(prodStyleRoot, 'manifest.json');

  const res = runCli([
    '--runtime-config', prodConfig,
    '--source', prodSource,
    '--destination', prodDestination,
    '--manifest-out', prodManifestOut,
  ], { env: defaultEnv(f.adapter, { BACKUP_CHIRPSTACK_TEST_ROOT: prodStyleRoot }) });

  assert.equal(res.status, 0, `expected success, stderr: ${res.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(prodManifestOut, 'utf8'));
  assert.equal(manifest.source.path, prodSource);
  assert.ok(manifest.runtimeConfig.sha256.length === 64);
});

test('non-live source requires an explicit repair-mode test root and exact production-relative path', () => {
  const f = baseFixture();
  const withoutRoot = runCli([
    '--runtime-config', f.runtimeConfig, '--source', f.source,
    '--destination', f.destination, '--manifest-out', f.manifestOut,
  ], { env: { BACKUP_CHIRPSTACK_SERVICE_ADAPTER: f.adapter, OSI_REPAIR_PROGRAM_MODE: '1' } });
  assert.notEqual(withoutRoot.status, 0);
  assert.match(withoutRoot.stderr, /literal|test root/i);

  const wrongSource = path.join(f.root, 'other.sqlite');
  fs.copyFileSync(f.source, wrongSource);
  writeRuntimeConfig(f.runtimeConfig, wrongSource);
  const wrongRelative = runCli([
    '--runtime-config', f.runtimeConfig, '--source', wrongSource,
    '--destination', f.destination, '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });
  assert.notEqual(wrongRelative.status, 0);
});

test('destination and manifest must share one owner-private attempt directory', () => {
  const f = baseFixture();
  const other = path.join(f.root, 'other'); fs.mkdirSync(other, { mode: 0o700 });
  const res = runCli([
    '--runtime-config', f.runtimeConfig, '--source', f.source,
    '--destination', f.destination, '--manifest-out', path.join(other, 'manifest.json'),
  ], { env: defaultEnv(f.adapter) });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /attempt|directory|contain/i);
});

test('a final-path collision created during backup is preserved and never deleted as this attempt output', () => {
  const f = baseFixture();
  const shimDir = path.join(f.root, 'collision-shim'); fs.mkdirSync(shimDir);
  const shim = path.join(shimDir, 'sqlite3');
  fs.writeFileSync(shim, `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    printf 'other-writer' > "$FINAL_DEST"\n    ;;\nesac\nexec "$REAL_SQLITE3" "$@"\n`);
  chmodX(shim);
  const res = runCli([
    '--runtime-config', f.runtimeConfig, '--source', f.source,
    '--destination', f.destination, '--manifest-out', f.manifestOut,
  ], { env: { ...defaultEnv(f.adapter), BACKUP_CHIRPSTACK_SQLITE3: shim, REAL_SQLITE3, FINAL_DEST: f.destination } });
  assert.notEqual(res.status, 0);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'other-writer');
  assert.equal(fs.existsSync(f.manifestOut), false);
  const prefixPath = path.join(f.root, '.chirpstack-backup.publish.json');
  const prefix = JSON.parse(fs.readFileSync(prefixPath));
  const partialStat = fs.statSync(prefix.partial.path);
  assert.equal(partialStat.dev, prefix.partial.device);
  assert.equal(partialStat.ino, prefix.partial.inode);
  assert.equal(fs.readFileSync(prefix.partial.path).length, prefix.partial.size);

  fs.unlinkSync(f.destination);
  const resumed = runCli([
    '--runtime-config', f.runtimeConfig, '--source', f.source,
    '--destination', f.destination, '--manifest-out', f.manifestOut,
  ], { env: defaultEnv(f.adapter) });
  assert.equal(resumed.status, 0, resumed.stderr);
  const destinationStat = fs.statSync(f.destination);
  assert.equal(destinationStat.dev, prefix.partial.device);
  assert.equal(destinationStat.ino, prefix.partial.inode);
  assert.equal(JSON.parse(resumed.stdout).backup.sha256, prefix.partial.sha256);
  assert.equal(fs.existsSync(f.manifestOut), true);
});

test('never stops or restarts ChirpStack: adapter is read-only, no service-mutation binary is ever invoked', () => {
  const f = baseFixture();

  const shimDir = path.join(f.root, 'shim');
  fs.mkdirSync(shimDir);
  for (const forbidden of ['service', '/etc/init.d/chirpstack', 'ubus']) {
    const base = path.basename(forbidden);
    const trap = path.join(shimDir, base);
    fs.writeFileSync(trap, `#!/bin/sh\necho "FORBIDDEN INVOCATION: ${base} $*" >&2\nexit 99\n`);
    chmodX(trap);
  }
  const shimSqlite3 = path.join(shimDir, 'sqlite3');
  fs.symlinkSync(REAL_SQLITE3, shimSqlite3);

  const res = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], {
    env: {
      ...defaultEnv(f.adapter),
      PATH: `${shimDir}:${process.env.PATH}`,
    },
  });

  assert.equal(res.status, 0, `expected success, stderr: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /FORBIDDEN INVOCATION/);
});

// ---------------------------------------------------------------------------
// unit-level pins on exact literal constants named in the brief
// ---------------------------------------------------------------------------

test('module pins the exact 30s default watchdog and 5000ms busy-timeout literals', () => {
  assert.equal(fs.readFileSync(SCRIPT, 'utf8').split('\n', 1)[0], '#!/usr/bin/node');
  delete require.cache[require.resolve(SCRIPT)];
  const mod = require(SCRIPT);
  assert.equal(mod.DEFAULT_WATCHDOG_MS, 30_000);
  assert.equal(mod.BUSY_TIMEOUT_MS, 5_000);
  const args = mod.buildBackupArgs('/srv/chirpstack/chirpstack.sqlite', '/data/x/backup.sqlite');
  assert.deepEqual(args, [
    '-cmd', '.timeout 5000',
    '/srv/chirpstack/chirpstack.sqlite',
    ".backup '/data/x/backup.sqlite'",
  ]);
});

test('ambient watchdog and PATH values cannot change the production 30s deadline', () => {
  const env = {
    ...process.env,
    BACKUP_CHIRPSTACK_WATCHDOG_ADAPTER: '/tmp/ambient-watchdog-shadow.json',
    BACKUP_CHIRPSTACK_WATCHDOG_MS: '1',
    PATH: '/tmp/ambient-watchdog-shadow',
  };
  delete env.OSI_REPAIR_PROGRAM_MODE;
  delete env.OSI_DEPLOY_ARTIFACT_MODE;
  const probe = spawnSync(process.execPath, ['-e',
    `const mod = require(${JSON.stringify(SCRIPT)}); process.stdout.write(String(mod.loadWatchdogMs()));`],
  { encoding: 'utf8', env });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, '30000');
});

test('a confined repair test adapter can select a shorter watchdog deadline', () => {
  const f = baseFixture();
  const watchdogAdapter = path.join(f.root, 'watchdog-deadline.json');
  writeWatchdogAdapter(watchdogAdapter, 275);
  const env = {
    ...process.env,
    ...defaultEnv(f.adapter),
    BACKUP_CHIRPSTACK_WATCHDOG_ADAPTER: watchdogAdapter,
    BACKUP_CHIRPSTACK_WATCHDOG_MS: '1',
  };
  const probe = spawnSync(process.execPath, ['-e',
    `const mod = require(${JSON.stringify(SCRIPT)}); process.stdout.write(String(mod.loadWatchdogMs()));`],
  { encoding: 'utf8', env });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, '275', 'the explicit adapter wins; the legacy ambient value is ignored');
});

test('watchdog adapter is ignored unless both repair and artifact test modes are explicit', () => {
  const f = baseFixture();
  const watchdogAdapter = path.join(f.root, 'watchdog-deadline.json');
  writeWatchdogAdapter(watchdogAdapter);
  for (const missing of ['OSI_REPAIR_PROGRAM_MODE', 'OSI_DEPLOY_ARTIFACT_MODE']) {
    const env = {
      ...process.env,
      ...defaultEnv(f.adapter),
      BACKUP_CHIRPSTACK_WATCHDOG_ADAPTER: watchdogAdapter,
    };
    delete env[missing];
    const probe = spawnSync(process.execPath, ['-e',
      `const mod = require(${JSON.stringify(SCRIPT)}); process.stdout.write(String(mod.loadWatchdogMs()));`],
    { encoding: 'utf8', env });
    assert.equal(probe.status, 0, `${missing}: ${probe.stderr}`);
    assert.equal(probe.stdout, '30000', missing);
  }
});

test('an invalid watchdog adapter fails before the backup child is spawned', () => {
  const f = baseFixture();
  const watchdogAdapter = path.join(f.root, 'watchdog-deadline.json');
  writeWatchdogAdapter(watchdogAdapter, 30_000);
  const sqliteShim = path.join(f.root, 'sqlite3-watchdog-probe');
  const backupSpawned = path.join(f.root, 'backup-child-spawned');
  fs.writeFileSync(sqliteShim, `#!/bin/sh\ncase "$*" in\n  *".backup "*)\n    : > "$BACKUP_SPAWNED_SENTINEL"\n    exit 97\n    ;;\n  *) exec "$SHIM_REAL_SQLITE3" "$@";;\nesac\n`, { mode: 0o755 });
  const result = runCli([
    '--runtime-config', f.runtimeConfig,
    '--source', f.source,
    '--destination', f.destination,
    '--manifest-out', f.manifestOut,
  ], { env: {
    ...defaultEnv(f.adapter),
    BACKUP_CHIRPSTACK_SQLITE3: sqliteShim,
    BACKUP_CHIRPSTACK_WATCHDOG_ADAPTER: watchdogAdapter,
    BACKUP_SPAWNED_SENTINEL: backupSpawned,
    SHIM_REAL_SQLITE3: REAL_SQLITE3,
  } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shorter positive integer watchdogMs/i);
  assert.equal(fs.existsSync(backupSpawned), false, 'invalid watchdog authority must be rejected before spawn');
});

test('extractDeclaredSqlitePath rejects an ambiguous [sqlite] section with two path keys', () => {
  delete require.cache[require.resolve(SCRIPT)];
  const mod = require(SCRIPT);
  assert.throws(() => {
    mod.extractDeclaredSqlitePath('[sqlite]\npath="/a"\npath="/b"\n');
  }, /more than one/i);
});

test('extractDeclaredSqlitePath rejects a config with no [sqlite] section', () => {
  delete require.cache[require.resolve(SCRIPT)];
  const mod = require(SCRIPT);
  assert.throws(() => {
    mod.extractDeclaredSqlitePath('[gateway]\nallow_unknown_gateways=true\n');
  }, /sqlite/i);
});

test('normalizeProcdServiceState is respawn-sensitive: same instance name, different pid must differ', () => {
  delete require.cache[require.resolve(SCRIPT)];
  const mod = require(SCRIPT);
  // chirpstack.init runs ONE fixed-name respawning procd instance; after a
  // stop/respawn the instance NAME set is byte-identical and only the pid
  // proves a restart happened. The normalized identity must therefore
  // include the pid (and per-instance running state), not just names.
  const before = mod.normalizeProcdServiceState(true, {
    chirpstack: { instances: { instance1: { running: true, pid: 100 } } },
  });
  const after = mod.normalizeProcdServiceState(true, {
    chirpstack: { instances: { instance1: { running: true, pid: 200 } } },
  });
  assert.notDeepEqual(before, after, 'identity must change when only the pid changed');
  assert.notEqual(JSON.stringify(before), JSON.stringify(after));
  // and per-instance running-state flips are also visible
  const stopped = mod.normalizeProcdServiceState(true, {
    chirpstack: { instances: { instance1: { running: false, pid: 100 } } },
  });
  assert.notEqual(JSON.stringify(before), JSON.stringify(stopped));
  // stable payloads normalize identically (comparison is not flaky)
  const beforeAgain = mod.normalizeProcdServiceState(true, {
    chirpstack: { instances: { instance1: { running: true, pid: 100 } } },
  });
  assert.equal(JSON.stringify(before), JSON.stringify(beforeAgain));
});

test('normalizeProcdServiceState rejects a payload without the chirpstack service', () => {
  delete require.cache[require.resolve(SCRIPT)];
  const mod = require(SCRIPT);
  assert.throws(() => {
    mod.normalizeProcdServiceState(true, {});
  }, /procd|chirpstack/i);
});
