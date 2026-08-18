#!/usr/bin/node
'use strict';
// backup-chirpstack-sqlite.js — checked, online, read-only backup of the
// ChirpStack SQLite device/gateway registry.
//
// Usage:
//   node scripts/backup-chirpstack-sqlite.js \
//     --runtime-config <generated chirpstack.toml> \
//     --source /srv/chirpstack/chirpstack.sqlite \
//     --destination <absent file> \
//     --manifest-out <absent json file>
//
// All four paths must be absolute; all four are injectable so tests can point
// at fixture roots instead of the real /srv/chirpstack path. In production the
// caller always passes the literal /srv/chirpstack/chirpstack.sqlite path; the
// script's own job is to verify the *generated runtime config* still declares
// that same path as its [sqlite] target -- config/argv drift is rejected
// before anything else runs.
//
// This is a standalone, fully tested primitive. It is NOT wired into
// deploy.sh in this slice. It NEVER stops or restarts ChirpStack: the service
// adapter it uses is read-only, and no service-mutation call exists anywhere
// in this file.
//
// See docs/superpowers/plans/2026-07-15-refactor-repair-program.md, Task A4
// preamble (search "backup-chirpstack-sqlite"), for the full binding contract
// this primitive will be wired into later.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const deploymentStatePath = [
  path.join(__dirname, 'lib/deployment-state.js'), path.join(__dirname, 'osi-deployment-state.js'),
].find((candidate) => fs.existsSync(candidate));
if (!deploymentStatePath) throw new Error('shared deployment-state publication primitive is unavailable');
const deploymentState = require(deploymentStatePath);

const BUSY_TIMEOUT_MS = 5_000; // SQLite's own busy-retry timeout -- NOT the wall deadline below.
const DEFAULT_WATCHDOG_MS = 30_000; // Separate wall-clock watchdog for the backup child.
const METHOD = 'sqlite3-online-backup';
const SQLITE3 = '/usr/bin/sqlite3';
const UBUS = '/bin/ubus';

const FLAG_MAP = {
  '--runtime-config': 'runtimeConfig',
  '--source': 'source',
  '--destination': 'destination',
  '--manifest-out': 'manifestOut',
  '--attempt-state': 'attemptState',
  '--deployment-id': 'deploymentId',
  '--expected-attempt-manifest-sha256': 'expectedAttemptManifestSha256',
};
const REQUIRED_KEYS = Object.values(FLAG_MAP);
const PATH_KEYS = new Set(['runtimeConfig', 'source', 'destination', 'manifestOut', 'attemptState']);

class CliError extends Error {}

function bound(text) {
  const flat = String(text).replace(/[\r\n\t]+/g, ' ').trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

function parseArgv(argv) {
  const result = {};
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (!Object.prototype.hasOwnProperty.call(FLAG_MAP, flag)) {
      throw new CliError(`unknown or malformed flag: ${bound(flag)}`);
    }
    const key = FLAG_MAP[flag];
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new CliError(`duplicate flag: ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new CliError(`missing value for ${flag}`);
    }
    if (PATH_KEYS.has(key) && !value.startsWith('/')) {
      throw new CliError(`${flag} must be an absolute path, got: ${bound(value)}`);
    }
    result[key] = value;
    i += 2;
  }
  const missing = REQUIRED_KEYS.filter((key) => !(key in result));
  if (missing.length > 0) {
    throw new CliError(`missing required flag(s): ${missing.join(', ')}`);
  }
  return result;
}

// Minimal TOML-lite reader for exactly the shape ChirpStack's generated
// config uses (see feeds/chirpstack-openwrt-feed/.../chirpstack.init):
//   [sqlite]
//   path="/srv/chirpstack/chirpstack.sqlite"
// Rejects (rather than guesses at) a missing or ambiguous [sqlite].path.
function extractDeclaredSqlitePath(configText) {
  const lines = configText.split(/\r?\n/);
  let inSqliteSection = false;
  let declared = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]*)\]$/);
    if (sectionMatch) {
      inSqliteSection = sectionMatch[1].trim() === 'sqlite';
      continue;
    }
    if (!inSqliteSection) continue;
    const kv = line.match(/^path\s*=\s*"([^"]*)"\s*$/);
    if (kv) {
      if (declared !== null) {
        throw new CliError('runtime config declares more than one [sqlite] path');
      }
      declared = kv[1];
    }
  }
  if (declared === null) {
    throw new CliError('runtime config does not declare a [sqlite] path');
  }
  return declared;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function lstatRequiredRegular(filePath, label) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    throw new CliError(`cannot lstat ${label} (${filePath}): ${bound(err.message)}`);
  }
  if (!st.isFile()) {
    throw new CliError(`${label} is not a regular non-symlink file: ${filePath}`);
  }
  return st;
}

function captureRuntimeConfig(configPath, expectedSourcePath) {
  const before = lstatRequiredRegular(configPath, 'runtime config');
  let raw;
  try { raw = fs.readFileSync(configPath); }
  catch (err) { throw new CliError(`cannot read runtime config ${configPath}: ${bound(err.message)}`); }
  const after = lstatRequiredRegular(configPath, 'runtime config');
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || raw.length !== before.size) {
    throw new CliError('runtime config identity changed while it was read');
  }
  const declaredSourcePath = extractDeclaredSqlitePath(raw.toString('utf8'));
  if (declaredSourcePath !== expectedSourcePath) {
    throw new CliError(`runtime config declares sqlite path '${declaredSourcePath}', --source is '${expectedSourcePath}'`);
  }
  return {
    path: configPath,
    device: before.dev,
    inode: before.ino,
    size: before.size,
    sha256: sha256Bytes(raw),
    declaredSourcePath,
  };
}

function assertRuntimeConfigUnchanged(configPath, expectedSourcePath, expected) {
  const current = captureRuntimeConfig(configPath, expectedSourcePath);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new CliError('runtime config path, identity, or bytes changed during backup');
  }
  return current;
}

function loadSqlite3Tool() {
  const adapterPath = process.env.BACKUP_CHIRPSTACK_SQLITE3;
  if (!adapterPath) return SQLITE3;
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test') {
    throw new CliError('sqlite3 adapter requires explicit repair/test artifact mode');
  }
  if (!path.isAbsolute(adapterPath)) throw new CliError('sqlite3 adapter must be an absolute path');
  const boundary = path.join('/tmp', `osi-chirpstack-backup-tests-${process.getuid()}`);
  const resolved = path.resolve(adapterPath);
  if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) {
    throw new CliError('sqlite3 adapter is outside the fixed test boundary');
  }
  const testRoot = process.env.BACKUP_CHIRPSTACK_TEST_ROOT
    && path.resolve(process.env.BACKUP_CHIRPSTACK_TEST_ROOT);
  if (!testRoot || (resolved !== testRoot && !resolved.startsWith(`${testRoot}${path.sep}`))) {
    throw new CliError('sqlite3 adapter is outside the exact ChirpStack test root');
  }
  if (fs.realpathSync(resolved) !== resolved) {
    throw new CliError('sqlite3 adapter path has a symlink or alias ancestor');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o755) {
    throw new CliError('sqlite3 adapter must be an owned mode-0755 regular nonsymlink file');
  }
  return resolved;
}

function readPragma(dbPath, pragma, sqlite3 = SQLITE3) {
  let out;
  try {
    out = execFileSync(
      sqlite3,
      ['-cmd', `.timeout ${BUSY_TIMEOUT_MS}`, dbPath, `PRAGMA ${pragma};`],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch (err) {
    throw new CliError(`PRAGMA ${pragma} on ${dbPath} failed: ${bound(err.message || err)}`);
  }
  return out.trim();
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dirPath) {
  const fd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function strictJson(filePath, label) {
  const stat = lstatRequiredRegular(filePath, label);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new CliError(`${label} must be owned and mode 0600`);
  let value;
  const raw = fs.readFileSync(filePath);
  try { value = JSON.parse(raw); } catch (_error) { throw new CliError(`${label} is invalid JSON`); }
  return { stat, raw, value };
}
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new CliError(`${label} has an invalid shape`);
}
function writeExclusiveJson(filePath, value, crashLabelPrefix) {
  deploymentState.publishImmutableBytes(filePath, Buffer.from(JSON.stringify(value)), {
    crashLabelPrefix,
  });
}
function maybeCrash(point) {
  if (process.env.BACKUP_CHIRPSTACK_CRASH_AT !== point) return;
  const boundary = path.join('/tmp', `osi-chirpstack-backup-tests-${process.getuid()}`);
  const testRoot = process.env.BACKUP_CHIRPSTACK_TEST_ROOT && path.resolve(process.env.BACKUP_CHIRPSTACK_TEST_ROOT);
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test'
      || !testRoot || (testRoot !== boundary && !testRoot.startsWith(`${boundary}${path.sep}`))) {
    throw new CliError('crash adapter is prohibited outside the fixed test boundary');
  }
  process.exit(137);
}

function buildBackupArgs(source, destination) {
  return ['-cmd', `.timeout ${BUSY_TIMEOUT_MS}`, source, `.backup '${destination}'`];
}

// Best-effort removal of everything a failed attempt may have created at the
// destination: the (partial) backup file plus the SQLite sidecars sqlite3
// can leave next to it. Only destination-derived paths are touched -- never
// the source set -- and this runs ONLY after the preflight proved the
// destination was absent when this invocation started, so nothing
// pre-existing can be deleted.
function removeFailedDestinationArtifacts(destination, expectedIdentity) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const candidate = `${destination}${suffix}`;
      const stat = fs.lstatSync(candidate);
      if (suffix === '' && expectedIdentity && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)) continue;
      fs.unlinkSync(candidate);
    } catch (_err) {
      // best-effort: ENOENT and any other unlink failure must not mask the
      // original error that brought us here.
    }
  }
}

function loadWatchdogMs() {
  const testMode = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
    && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test';
  if (!testMode) return DEFAULT_WATCHDOG_MS;
  const adapterPath = process.env.BACKUP_CHIRPSTACK_WATCHDOG_ADAPTER;
  if (!adapterPath) return DEFAULT_WATCHDOG_MS;
  if (!path.isAbsolute(adapterPath)) throw new CliError('watchdog adapter must be an absolute path');
  const boundary = path.join('/tmp', `osi-chirpstack-backup-tests-${process.getuid()}`);
  const resolved = path.resolve(adapterPath);
  if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) {
    throw new CliError('watchdog adapter is outside the fixed test boundary');
  }
  const testRoot = process.env.BACKUP_CHIRPSTACK_TEST_ROOT
    && path.resolve(process.env.BACKUP_CHIRPSTACK_TEST_ROOT);
  if (!testRoot || (resolved !== testRoot && !resolved.startsWith(`${testRoot}${path.sep}`))) {
    throw new CliError('watchdog adapter is outside the exact ChirpStack test root');
  }
  if (fs.realpathSync(resolved) !== resolved) {
    throw new CliError('watchdog adapter path has a symlink or alias ancestor');
  }
  const before = fs.lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
      || (before.mode & 0o777) !== 0o600) {
    throw new CliError('watchdog adapter must be an owned mode-0600 regular nonsymlink file');
  }
  const raw = fs.readFileSync(resolved);
  const after = fs.lstatSync(resolved);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || raw.length !== before.size) {
    throw new CliError('watchdog adapter identity changed while it was read');
  }
  let adapter;
  try { adapter = JSON.parse(raw); }
  catch (_error) { throw new CliError('watchdog adapter is invalid JSON'); }
  if (!adapter || Object.keys(adapter).join() !== 'watchdogMs'
      || !Number.isInteger(adapter.watchdogMs) || adapter.watchdogMs <= 0
      || adapter.watchdogMs >= DEFAULT_WATCHDOG_MS) {
    throw new CliError('watchdog adapter must contain exactly one shorter positive integer watchdogMs');
  }
  return adapter.watchdogMs;
}

// Spawns the real sqlite3 online-backup command with a watchdog that is
// separate from SQLite's own busy-retry timeout. On expiry it kills the
// child's whole process group (so a shell-wrapped grandchild cannot be
// orphaned) and only resolves once the child has actually exited.
function runBackupWithWatchdog(source, destination, sqlite3 = SQLITE3) {
  const limit = loadWatchdogMs();
  return new Promise((resolve) => {
    const args = buildBackupArgs(source, destination);
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(sqlite3, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ timedOut: false, exitCode: null, signal: null, spawnError: err, stdout: '', stderr: '', wallMs: 0 });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_err) {
        try { child.kill('SIGKILL'); } catch (_err2) { /* already gone */ }
      }
    }, limit);
    if (typeof timer.unref === 'function') timer.unref();

    function finish(exitCode, signal, spawnError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        timedOut,
        exitCode: exitCode === undefined ? null : exitCode,
        signal: signal === undefined ? null : signal,
        spawnError: spawnError || null,
        stdout,
        stderr,
        wallMs: Date.now() - startedAt,
        watchdogMs: limit,
      });
    }

    child.on('error', (err) => finish(null, null, err));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

function loadServiceAdapter() {
  const adapterPath = process.env.BACKUP_CHIRPSTACK_SERVICE_ADAPTER;
  if (!adapterPath) {
    return { captureServiceIdentity: defaultServiceIdentityAdapter };
  }
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test') throw new CliError('service adapter requires explicit repair/test artifact mode');
  if (!adapterPath.startsWith('/')) {
    throw new CliError(`BACKUP_CHIRPSTACK_SERVICE_ADAPTER must be an absolute path: ${bound(adapterPath)}`);
  }
  const boundary = path.join('/tmp', `osi-chirpstack-backup-tests-${process.getuid()}`);
  const resolved = path.resolve(adapterPath);
  if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) throw new CliError('service adapter is outside the fixed test boundary');
  const adapterStat = fs.lstatSync(resolved);
  if (!adapterStat.isFile() || adapterStat.isSymbolicLink() || adapterStat.uid !== process.getuid() || (adapterStat.mode & 0o777) !== 0o600) throw new CliError('service adapter must be an owned mode-0600 regular file');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require(adapterPath);
  if (!mod || typeof mod.captureServiceIdentity !== 'function') {
    throw new CliError(`service adapter does not export captureServiceIdentity: ${adapterPath}`);
  }
  return mod;
}

// Normalizes a `ubus call service list '{"name":"chirpstack"}'` payload into
// the identity object the before/after comparison uses. chirpstack.init runs
// ONE fixed-name respawning procd instance, so after a stop/respawn the
// instance NAME set is byte-identical -- only the pid (and per-instance
// running state) prove a restart happened. Both are captured per instance;
// instance names alone are NOT sufficient identity.
function normalizeProcdServiceState(enabled, parsed) {
  const svc = parsed && parsed.chirpstack;
  if (!svc || !svc.instances) {
    throw new CliError('chirpstack is not present in the procd service list');
  }
  const instances = {};
  for (const name of Object.keys(svc.instances).sort()) {
    const inst = svc.instances[name] || {};
    instances[name] = {
      running: inst.running === true,
      pid: Number.isInteger(inst.pid) ? inst.pid : null,
    };
  }
  const running = Object.keys(instances).some((name) => instances[name].running);
  return { enabled, running, instances };
}

// Production default: read-only procd introspection for the chirpstack
// service. Never starts, stops, restarts, reloads, or enables/disables
// anything -- it only reads state. Tests always substitute a fake adapter via
// BACKUP_CHIRPSTACK_SERVICE_ADAPTER, since ubus/procd are not present off-Pi.
async function defaultServiceIdentityAdapter() {
  let enabled;
  try {
    execFileSync('/etc/init.d/chirpstack', ['enabled'], { stdio: 'ignore' });
    enabled = true;
  } catch (err) {
    if (err && typeof err.status === 'number') {
      enabled = false;
    } else {
      throw new CliError(`cannot read chirpstack enabled state: ${bound(err.message || err)}`);
    }
  }
  let raw;
  try {
    raw = execFileSync(UBUS, ['call', 'service', 'list', '{"name":"chirpstack"}'], { encoding: 'utf8' });
  } catch (err) {
    throw new CliError(`cannot read chirpstack procd service state: ${bound(err.message || err)}`);
  }
  return normalizeProcdServiceState(enabled, JSON.parse(raw));
}

async function run(argv) {
  const opts = parseArgv(argv);
  if (!/^[0-9a-f]{64}$/.test(opts.expectedAttemptManifestSha256)) throw new CliError('--expected-attempt-manifest-sha256 must be lowercase sha256');
  if (typeof opts.deploymentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.deploymentId)
      || Buffer.byteLength(opts.deploymentId, 'utf8') > 128 || opts.deploymentId.includes('..')) {
    throw new CliError('--deployment-id is invalid');
  }

  const productionSource = '/srv/chirpstack/chirpstack.sqlite';
  if (opts.source === productionSource && (process.env.BACKUP_CHIRPSTACK_SERVICE_ADAPTER || process.env.BACKUP_CHIRPSTACK_SQLITE3)) {
    throw new CliError('test adapters are prohibited for the literal production source');
  }
  if (opts.source !== productionSource) {
    const testRoot = process.env.BACKUP_CHIRPSTACK_TEST_ROOT;
    if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test' || !testRoot || !path.isAbsolute(testRoot)) {
      throw new CliError(`--source must be the literal ${productionSource} outside an explicit repair-mode test root`);
    }
    const expectedTestSource = path.join(path.resolve(testRoot), 'srv/chirpstack/chirpstack.sqlite');
    if (path.resolve(opts.source) !== expectedTestSource) {
      throw new CliError(`non-live --source must be exactly ${expectedTestSource}`);
    }
  }
  opts.sqlite3 = loadSqlite3Tool();

  const attemptDir = path.dirname(opts.destination);
  if (attemptDir !== path.dirname(opts.manifestOut) || attemptDir !== path.dirname(opts.attemptState)) {
    throw new CliError('destination and manifest-out must share one attempt-private directory');
  }
  const attemptStat = fs.lstatSync(attemptDir);
  if (!attemptStat.isDirectory() || attemptStat.isSymbolicLink() || attemptStat.uid !== process.getuid() || (attemptStat.mode & 0o777) !== 0o700) {
    throw new CliError('attempt-private directory must be an owned nonsymlink mode-0700 directory');
  }
  const attemptStateFile = strictJson(opts.attemptState, 'deployment attempt state');
  exact(attemptStateFile.value, ['format', 'deploymentId', 'phase', 'attemptDirectory', 'runtimeManifestSha256'], 'deployment attempt state');
  if (attemptStateFile.value.format !== 1 || attemptStateFile.value.deploymentId !== opts.deploymentId ||
      attemptStateFile.value.phase !== 'chirpstack-backup-in-progress' || attemptStateFile.value.attemptDirectory !== attemptDir ||
      attemptStateFile.value.runtimeManifestSha256 !== opts.expectedAttemptManifestSha256) throw new CliError('deployment attempt state/manifest binding mismatch');
  opts.attemptStateSha256 = crypto.createHash('sha256').update(attemptStateFile.raw).digest('hex');

  // 1. Runtime-config vs --source drift is checked first: it must fail
  //    before we ever touch the source path with lstat. The exact path,
  //    device/inode, byte count, byte hash, and parsed source are one fact.
  const runtimeConfig = captureRuntimeConfig(opts.runtimeConfig, opts.source);

  const publishPrefix = path.join(attemptDir, '.chirpstack-backup.publish.json');
  const partial = path.join(attemptDir, `.chirpstack-backup-${opts.attemptStateSha256}.sqlite`);
  opts.publishPrefix = publishPrefix;
  opts.partial = partial;
  // A destination published before its manifest is an authorized resumable
  // prefix only when the private publish record binds the exact attempt.
  // preflights run BEFORE the failure-cleanup scope below: a genuinely
  // pre-existing destination is never deleted.
  if (lstatOrNull(opts.destination) || lstatOrNull(publishPrefix)) {
    if (!lstatOrNull(publishPrefix)) throw new CliError(`destination already exists without this attempt's publish prefix: ${opts.destination}`);
    const prefixFile = strictJson(publishPrefix, 'chirpstack publish prefix');
    exact(prefixFile.value, ['format', 'deploymentId', 'attemptStateSha256', 'partial', 'manifest'], 'chirpstack publish prefix');
    if (prefixFile.value.format !== 1 || prefixFile.value.deploymentId !== opts.deploymentId || prefixFile.value.attemptStateSha256 !== opts.attemptStateSha256) throw new CliError('chirpstack publish prefix does not bind this attempt');
    const manifest = prefixFile.value.manifest;
    if (!manifest || manifest.deploymentId !== opts.deploymentId || manifest.attemptManifestSha256 !== opts.expectedAttemptManifestSha256
        || manifest.backup.path !== opts.destination || JSON.stringify(manifest.runtimeConfig) !== JSON.stringify(runtimeConfig)) throw new CliError('chirpstack publish prefix manifest mismatch');
    const expectedPartial = prefixFile.value.partial;
    exact(expectedPartial, ['path', 'device', 'inode', 'size', 'sha256'], 'chirpstack partial identity');
    if (expectedPartial.path !== partial || expectedPartial.size !== manifest.backup.size || expectedPartial.sha256 !== manifest.backup.sha256) throw new CliError('chirpstack partial identity mismatch');
    if (!lstatOrNull(opts.destination)) {
      assertRuntimeConfigUnchanged(opts.runtimeConfig, opts.source, runtimeConfig);
      const pending = lstatRequiredRegular(partial, 'intent-owned ChirpStack partial');
      if (pending.dev !== expectedPartial.device || pending.ino !== expectedPartial.inode || pending.size !== expectedPartial.size
          || sha256File(partial) !== expectedPartial.sha256 || readPragma(partial, 'quick_check', opts.sqlite3) !== 'ok') throw new CliError('intent-owned ChirpStack partial drift');
      fs.linkSync(partial, opts.destination);
      maybeCrash('after-link');
      fsyncFile(opts.destination); fsyncDir(attemptDir);
      maybeCrash('after-publication-fsync');
    }
    validatePublishedDestination(opts.destination, expectedPartial, manifest, opts.sqlite3);
    if (lstatOrNull(partial)) { fs.unlinkSync(partial); fsyncDir(attemptDir); }
    maybeCrash('after-unlink');
    const adapter = loadServiceAdapter();
    validatePublishedDestination(opts.destination, expectedPartial, manifest, opts.sqlite3);
    await validateLivePublicationAuthority(opts, runtimeConfig, manifest, adapter);
    if (lstatOrNull(opts.manifestOut)) {
      const existing = strictJson(opts.manifestOut, 'chirpstack backup manifest');
      if (JSON.stringify(existing.value) !== JSON.stringify(manifest)) throw new CliError('existing ChirpStack manifest does not match publish prefix');
    } else writeExclusiveJson(opts.manifestOut, manifest, 'chirpstack-manifest');
    maybeCrash('after-manifest');
    return manifest;
  }
  if (lstatOrNull(opts.manifestOut)) {
    throw new CliError(`manifest-out already exists: ${opts.manifestOut}`);
  }
  if (lstatOrNull(partial)) {
    fs.unlinkSync(partial);
    fsyncDir(attemptDir);
  }

  // Before the immutable publish prefix exists, failures remove this
  // invocation's partial and SQLite sidecars. Once that prefix is durable,
  // the exact prefix-bound partial is recovery authority and must survive a
  // failed destination link so the same attempt can resume.
  return runCheckedBackup(opts, runtimeConfig);
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function validatePublishedDestination(destinationPath, expectedIdentity, manifest, sqlite3 = SQLITE3) {
  const destination = lstatRequiredRegular(destinationPath, 'published backup');
  if (destination.dev !== expectedIdentity.device || destination.ino !== expectedIdentity.inode
      || destination.size !== expectedIdentity.size || destination.size !== manifest.backup.size
      || sha256File(destinationPath) !== expectedIdentity.sha256
      || expectedIdentity.sha256 !== manifest.backup.sha256
      || readPragma(destinationPath, 'quick_check', sqlite3) !== 'ok') {
    throw new CliError('published ChirpStack backup device/inode/hash/integrity does not match its resumable prefix');
  }
  return destination;
}

async function validateLivePublicationAuthority(opts, runtimeConfig, manifest, adapter) {
  assertRuntimeConfigUnchanged(opts.runtimeConfig, opts.source, runtimeConfig);
  const source = lstatRequiredRegular(opts.source, 'source');
  if (source.dev !== manifest.source.device || source.ino !== manifest.source.inode) {
    throw new CliError('source device/inode changed before ChirpStack manifest publication');
  }
  const schema = readPragma(opts.source, 'schema_version', opts.sqlite3);
  if (schema !== manifest.schemaVersion.before || schema !== manifest.schemaVersion.after
      || schema !== manifest.schemaVersion.backup) {
    throw new CliError('source schema identity changed before ChirpStack manifest publication');
  }
  const service = await adapter.captureServiceIdentity();
  if (JSON.stringify(service) !== JSON.stringify(manifest.service.before)
      || JSON.stringify(service) !== JSON.stringify(manifest.service.after)) {
    throw new CliError('chirpstack service identity changed before manifest publication');
  }
}

async function runCheckedBackup(opts, runtimeConfig) {
  const partial = opts.partial;
  const partialFd = fs.openSync(partial, 'wx', 0o600);
  fs.closeSync(partialFd);
  const partialIdentity = fs.lstatSync(partial);
  let publishPrefixDurable = false;
  try {
  // 2. lstat source: regular non-symlink file; capture device+inode.
  const beforeStat = lstatRequiredRegular(opts.source, 'source');

  // 3. PRAGMA schema_version from source (before).
  const schemaBefore = readPragma(opts.source, 'schema_version', opts.sqlite3);

  // 4. Service identity, captured through a read-only injectable adapter.
  const adapter = loadServiceAdapter();
  const identityBefore = await adapter.captureServiceIdentity();

  // 5. Spawn sqlite3's online backup with a separate wall-clock watchdog.
  const backupResult = await runBackupWithWatchdog(opts.source, partial, opts.sqlite3);
  if (backupResult.spawnError) {
    throw new CliError(`failed to spawn sqlite3: ${bound(backupResult.spawnError.message)}`);
  }
  if (backupResult.timedOut) {
    throw new CliError(
      `sqlite3 backup exceeded the ${backupResult.watchdogMs}ms wall-clock watchdog and was killed`
    );
  }
  if (backupResult.exitCode !== 0) {
    throw new CliError(
      `sqlite3 backup exited ${backupResult.exitCode} (signal ${backupResult.signal}): ${bound(backupResult.stderr)}`
    );
  }

  // 6. Post-conditions on the source: unchanged device/inode, unchanged
  //    service identity, unchanged schema_version.
  const afterStat = lstatRequiredRegular(opts.source, 'source');
  if (afterStat.dev !== beforeStat.dev || afterStat.ino !== beforeStat.ino) {
    throw new CliError(
      `source device/inode changed during backup (source replaced): before dev=${beforeStat.dev} ino=${beforeStat.ino}, after dev=${afterStat.dev} ino=${afterStat.ino}`
    );
  }
  const identityAfter = await adapter.captureServiceIdentity();
  if (JSON.stringify(identityAfter) !== JSON.stringify(identityBefore)) {
    throw new CliError('chirpstack service identity changed during backup');
  }
  const schemaAfter = readPragma(opts.source, 'schema_version', opts.sqlite3);
  if (schemaAfter !== schemaBefore) {
    throw new CliError(
      `source schema_version changed during backup (before=${schemaBefore}, after=${schemaAfter})`
    );
  }

  // Post-conditions on the backup itself.
  if (!fs.existsSync(partial)) {
    throw new CliError('backup destination is missing after sqlite3 .backup');
  }
  const afterPartial = lstatRequiredRegular(partial, 'backup destination');
  if (afterPartial.dev !== partialIdentity.dev || afterPartial.ino !== partialIdentity.ino) throw new CliError('attempt-private backup file identity changed');
  const schemaBackup = readPragma(partial, 'schema_version', opts.sqlite3);
  if (schemaBackup !== schemaBefore) {
    throw new CliError(`backup PRAGMA schema_version '${schemaBackup}' != captured '${schemaBefore}'`);
  }
  const quickCheck = readPragma(partial, 'quick_check', opts.sqlite3);
  if (quickCheck !== 'ok') {
    throw new CliError(`backup PRAGMA quick_check failed: ${bound(quickCheck)}`);
  }

  // fsync file + parent dir, then hash.
  fsyncFile(partial);
  maybeCrash('after-partial-fsync');
  const backupSha256 = sha256File(partial);
  const backupSize = fs.statSync(partial).size;

  const manifest = {
    format: 'backup-chirpstack-sqlite/1',
    deploymentId: opts.deploymentId,
    attemptManifestSha256: opts.expectedAttemptManifestSha256,
    method: METHOD,
    createdAt: new Date().toISOString(),
    source: {
      path: opts.source,
      type: 'regular-file',
      device: beforeStat.dev,
      inode: beforeStat.ino,
    },
    schemaVersion: {
      before: schemaBefore,
      after: schemaAfter,
      backup: schemaBackup,
    },
    runtimeConfig,
    service: {
      name: 'chirpstack',
      before: identityBefore,
      after: identityAfter,
    },
    backup: {
      path: opts.destination,
      size: backupSize,
      sha256: backupSha256,
    },
    watchdog: {
      timedOut: backupResult.timedOut,
      wallMs: backupResult.wallMs,
      limitMs: backupResult.watchdogMs,
      exitCode: backupResult.exitCode,
    },
    check: {
      quickCheck,
      result: 'ok',
    },
  };

  // Bind the configuration a second time after the backup and immediately
  // before publishing the first immutable authority for this attempt.
  assertRuntimeConfigUnchanged(opts.runtimeConfig, opts.source, runtimeConfig);
  const partialStat = fs.lstatSync(partial);
  writeExclusiveJson(opts.publishPrefix, {
    format: 1,
    deploymentId: opts.deploymentId,
    attemptStateSha256: opts.attemptStateSha256,
    partial: { path: partial, device: partialStat.dev, inode: partialStat.ino, size: backupSize, sha256: backupSha256 },
    manifest,
  }, 'chirpstack-publish-prefix');
  publishPrefixDurable = true;
  maybeCrash('after-prefix');
  fs.linkSync(partial, opts.destination);
  maybeCrash('after-link');
  fsyncFile(opts.destination);
  fsyncDir(path.dirname(opts.destination));
  maybeCrash('after-publication-fsync');
  maybeCrash('after-publish');
  fs.unlinkSync(partial);
  fsyncDir(path.dirname(partial));
  maybeCrash('after-unlink');

  validatePublishedDestination(opts.destination,
    { path: partial, device: partialStat.dev, inode: partialStat.ino, size: backupSize, sha256: backupSha256 }, manifest,
    opts.sqlite3);
  await validateLivePublicationAuthority(opts, runtimeConfig, manifest, adapter);

  // O_EXCL manifest creation: never overwrites, never publishes on failure.
  try { writeExclusiveJson(opts.manifestOut, manifest, 'chirpstack-manifest'); }
  catch (err) { throw new CliError(`cannot exclusively create manifest-out ${opts.manifestOut}: ${bound(err.message)}`); }
  maybeCrash('after-manifest');

  return manifest;
  } finally {
    if (!publishPrefixDurable) removeFailedDestinationArtifacts(partial, partialIdentity);
  }
}

function main() {
  run(process.argv.slice(2))
    .then((manifest) => {
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
      process.exitCode = 0;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`backup-chirpstack-sqlite: ${bound(message)}\n`);
      process.exitCode = 1;
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  run,
  parseArgv,
  extractDeclaredSqlitePath,
  buildBackupArgs,
  normalizeProcdServiceState,
  loadWatchdogMs,
  DEFAULT_WATCHDOG_MS,
  BUSY_TIMEOUT_MS,
};
