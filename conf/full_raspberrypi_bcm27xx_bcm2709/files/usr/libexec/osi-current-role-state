#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROLES = Object.freeze(['osi-identityd', 'node-red', 'osi-bootstrap', 'osi-db-integrity']);
const ROLE_LINKS = Object.freeze({
  'osi-identityd': Object.freeze(['/etc/rc.d/S98osi-identityd', '/etc/rc.d/K98osi-identityd']),
  'node-red': Object.freeze(['/etc/rc.d/S99node-red', '/etc/rc.d/K99node-red']),
  'osi-bootstrap': Object.freeze(['/etc/rc.d/S99osi-bootstrap']),
  'osi-db-integrity': Object.freeze(['/etc/rc.d/S90osi-db-integrity']),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCTION_GENERATION_ROOT = '/var/run/osi-role-generations';
const SAFE_PROCESS_ENV = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' });
const ROLE_READINESS_ADAPTERS = Object.freeze({
  'osi-identityd': Object.freeze({ command: '/etc/init.d/osi-identityd', args: Object.freeze(['ready']) }),
  'node-red': Object.freeze({
    command: '/bin/wget',
    args: Object.freeze([
      '-q', '-T', '3', '-Y', 'off', '-O', '/dev/null', '--spider', 'http://127.0.0.1:1880/gui',
    ]),
  }),
  'osi-bootstrap': null,
  'osi-db-integrity': null,
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function ensureAuthorityDirectory(dir, label) {
  const existing = (() => { try { return fs.lstatSync(dir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } })();
  if (existing && existing.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be an owned mode-0700 real directory`);
  }
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function assertRole(role) {
  if (!ROLES.includes(role)) throw new Error(`unknown managed role: ${role}`);
}
function validateLifecycleEvent(value, expectedRole) {
  const fields = ['format', 'role', 'bootId', 'pid', 'processStartTime', 'token', 'createdAt'];
  if (!value || Object.keys(value).sort().join() !== fields.sort().join() || value.format !== 1
      || value.role !== expectedRole || !UUID.test(value.bootId)
      || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.processStartTime !== 'string' || !/^\d+$/.test(value.processStartTime)
      || !/^[0-9a-f]{32}$/.test(value.token)
      || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error(`invalid lifecycle event for ${expectedRole}`);
  }
  return value;
}

function strictLifecycleFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be an owned mode-0600 regular file`);
  }
  return { stat, raw: fs.readFileSync(file) };
}

function readProcessIdentity(pid, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('lifecycle publisher PID is invalid');
  let procStat;
  try { procStat = fs.lstatSync(procRoot); }
  catch (error) { throw new Error(`lifecycle publisher proc root is unavailable: ${error.message}`); }
  if (!procStat.isDirectory() || procStat.isSymbolicLink()) throw new Error('lifecycle publisher proc root is invalid');
  const statPath = path.join(procRoot, String(pid), 'stat');
  let stat;
  try { stat = fs.lstatSync(statPath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('lifecycle publisher stat is invalid');
  const statText = fs.readFileSync(statPath, 'utf8');
  const close = statText.lastIndexOf(')');
  const fields = close < 0 ? [] : statText.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) {
    throw new Error('lifecycle publisher process starttime is unavailable');
  }
  return { state: fields[0], processStartTime: fields[19] };
}

function publisherAlive(event, procRoot) {
  const identity = readProcessIdentity(event.pid, procRoot);
  return Boolean(identity && identity.state !== 'Z' && identity.processStartTime === event.processStartTime);
}

// A killed publisher can leave either a fully fsynced .<token>.tmp before the
// hardlink or that temp hardlink next to the already-published <token>.json.
// Resume requires the exact canonical event and PID/starttime ownership proof;
// anything else is ambiguous lifecycle authority and remains for forensics.
function resumeRoleStartPublication(role, bootId, roleDir, fsyncDirectory, procRoot) {
  const temporaryNames = fs.readdirSync(roleDir).filter((name) => name.endsWith('.tmp'));
  if (temporaryNames.length === 0) return null;
  if (temporaryNames.length !== 1 || !/^\.[0-9a-f]{32}\.tmp$/.test(temporaryNames[0])) {
    throw new Error(`lifecycle publication debris is ambiguous for ${role}`);
  }
  const temporaryName = temporaryNames[0];
  const token = temporaryName.slice(1, -4);
  const temporaryPath = path.join(roleDir, temporaryName);
  const finalPath = path.join(roleDir, `${token}.json`);
  let temporary;
  try {
    temporary = strictLifecycleFile(temporaryPath, `lifecycle publication debris for ${role}`);
  } catch (error) {
    throw new Error(`lifecycle publication debris is unsafe for ${role}: ${error.message}`);
  }
  let event;
  try { event = validateLifecycleEvent(JSON.parse(temporary.raw), role); }
  catch (error) { throw new Error(`invalid lifecycle event in publication debris for ${role}: ${error.message}`); }
  const expectedRaw = Buffer.from(`${canonical(event)}\n`);
  if (event.token !== token || event.bootId !== bootId || !temporary.raw.equals(expectedRaw)) {
    throw new Error(`lifecycle publication debris has tampered event bytes for ${role}`);
  }
  if (publisherAlive(event, procRoot)) {
    throw new Error(`lifecycle publication debris still belongs to a live publisher for ${role}`);
  }

  let final;
  try {
    final = strictLifecycleFile(finalPath, `lifecycle publication final for ${role}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`lifecycle publication debris is unsafe for ${role}: ${error.message}`);
    }
    try { fs.linkSync(temporaryPath, finalPath); }
    catch (linkError) {
      if (linkError.code !== 'EEXIST') throw linkError;
    }
    fsyncDirectory(roleDir);
    try { final = strictLifecycleFile(finalPath, `lifecycle publication final for ${role}`); }
    catch (finalError) {
      throw new Error(`lifecycle publication final is unavailable for ${role}: ${finalError.message}`);
    }
    try { temporary = strictLifecycleFile(temporaryPath, `lifecycle publication debris for ${role}`); }
    catch (temporaryError) {
      throw new Error(`lifecycle publication debris is unavailable for ${role}: ${temporaryError.message}`);
    }
  }
  if (temporary.stat.dev !== final.stat.dev || temporary.stat.ino !== final.stat.ino
      || temporary.stat.nlink !== 2 || final.stat.nlink !== 2
      || !temporary.raw.equals(final.raw)) {
    throw new Error(`lifecycle publication debris does not bind the exact final event for ${role}`);
  }
  fs.unlinkSync(temporaryPath);
  fsyncDirectory(roleDir);
  return event;
}

function recordRoleStart(role, {
  bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase(),
  generationRoot = PRODUCTION_GENERATION_ROOT,
  crashHook = null,
  fsyncDirectory = fsyncDir,
  procRoot = '/proc',
} = {}) {
  assertRole(role);
  if (!UUID.test(bootId)) throw new Error('role lifecycle boot ID is invalid');
  if (crashHook !== null && typeof crashHook !== 'function') throw new Error('role lifecycle crash hook must be a function');
  if (typeof fsyncDirectory !== 'function') throw new Error('role lifecycle directory fsync adapter must be a function');
  ensureAuthorityDirectory(generationRoot, 'role lifecycle root');
  const roleDir = path.join(generationRoot, role);
  ensureAuthorityDirectory(roleDir, `role lifecycle directory for ${role}`);
  const resumed = resumeRoleStartPublication(role, bootId, roleDir, fsyncDirectory, procRoot);
  if (resumed) return resumed;
  const token = crypto.randomBytes(16).toString('hex');
  const identity = readProcessIdentity(process.pid, procRoot);
  if (!identity || identity.state === 'Z') throw new Error('role lifecycle publisher process identity is unavailable');
  const content = {
    format: 1, role, bootId, pid: process.pid, processStartTime: identity.processStartTime,
    token, createdAt: new Date().toISOString(),
  };
  const raw = Buffer.from(`${canonical(content)}\n`);
  const tmp = path.join(roleDir, `.${token}.tmp`);
  const finalPath = path.join(roleDir, `${token}.json`);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, raw);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (crashHook) crashHook('after-fsync-before-link', { role, bootId, token, temporaryPath: tmp, finalPath });
  try { fs.linkSync(tmp, finalPath); }
  catch (error) {
    try { fs.unlinkSync(tmp); } finally { fsyncDirectory(roleDir); }
    throw error;
  }
  if (crashHook) crashHook('after-link', { role, bootId, token, temporaryPath: tmp, finalPath });
  fs.unlinkSync(tmp);
  fsyncDirectory(roleDir);
  return content;
}
function roleGeneration(role, bootId, generationRoot = PRODUCTION_GENERATION_ROOT) {
  assertRole(role);
  if (!UUID.test(bootId)) throw new Error('role lifecycle boot ID is invalid');
  let rootStat;
  try { rootStat = fs.lstatSync(generationRoot); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`role lifecycle authority is unavailable: ${role}`);
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid()
      || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error('role lifecycle root must be an owned mode-0700 real directory');
  }
  const roleDir = path.join(generationRoot, role);
  let roleStat;
  try { roleStat = fs.lstatSync(roleDir); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`role lifecycle authority is unavailable: ${role}`);
    throw error;
  }
  if (!roleStat.isDirectory() || roleStat.isSymbolicLink() || roleStat.uid !== process.getuid()
      || (roleStat.mode & 0o777) !== 0o700) {
    throw new Error(`role lifecycle directory is invalid: ${role}`);
  }
  let count = 0;
  for (const name of fs.readdirSync(roleDir).sort()) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) throw new Error(`invalid lifecycle event filename for ${role}`);
    const eventPath = path.join(roleDir, name);
    const stat = fs.lstatSync(eventPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`invalid lifecycle event for ${role}`);
    }
    const event = validateLifecycleEvent(JSON.parse(fs.readFileSync(eventPath, 'utf8')), role);
    if (event.token !== name.slice(0, -5)) throw new Error(`invalid lifecycle event token for ${role}`);
    if (event.bootId === bootId) count += 1;
  }
  if (count === 0) throw new Error(`current-boot role lifecycle authority is unavailable: ${role}`);
  return count;
}
function strictFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be an owned mode-0600 regular file`);
  }
  return fs.readFileSync(file, 'utf8');
}
function testSnapshot() {
  const file = process.env.OSI_CURRENT_ROLE_STATE_TEST_SNAPSHOT;
  if (!file) return null;
  const boundary = path.join('/tmp', `osi-factory-zero-tests-${process.getuid()}`);
  const resolved = path.resolve(file);
  if (process.env.OSI_REPAIR_PROGRAM_MODE !== '1' || process.env.OSI_DEPLOY_ARTIFACT_MODE !== 'test'
      || (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`))) {
    throw new Error('current role-state test adapter is outside the fixed boundary');
  }
  let cursor = resolved;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('current role-state test adapter has a symlink ancestor');
    if (cursor === boundary) break;
    cursor = path.dirname(cursor);
  }
  return JSON.parse(strictFile(resolved, 'current role-state test adapter'));
}
function validate(value, { production }) {
  if (!value || Object.keys(value).sort().join() !== ['format', 'bootId', 'roles'].sort().join() || value.format !== 1
      || !value.roles || Object.keys(value.roles).sort().join() !== [...ROLES].sort().join()) throw new Error('current role-state has an invalid exact shape');
  if (typeof value.bootId !== 'string' || !value.bootId || (production && !UUID.test(value.bootId))) throw new Error('current role-state boot ID is invalid');
  for (const role of ROLES) {
    const entry = value.roles[role];
    const fields = ['running', 'ready', 'pid', 'processStartTime', 'generation', 'bootId', 'rcLinks'];
    if (!entry || Object.keys(entry).sort().join() !== fields.sort().join()
        || typeof entry.running !== 'boolean' || typeof entry.ready !== 'boolean'
        || (entry.ready && !entry.running) || !Number.isSafeInteger(entry.generation) || entry.generation < 1
        || entry.bootId !== value.bootId || !Array.isArray(entry.rcLinks)
        || entry.rcLinks.length !== ROLE_LINKS[role].length) {
      throw new Error(`current role-state entry is invalid: ${role}`);
    }
    if (entry.running) {
      if (!Number.isSafeInteger(entry.pid) || entry.pid < 1 || !/^\d+$/.test(entry.processStartTime)) {
        throw new Error(`current role-state process identity is invalid: ${role}`);
      }
    } else if (entry.pid !== null || entry.processStartTime !== null) {
      throw new Error(`stopped current role-state must not claim a process: ${role}`);
    }
    entry.rcLinks.forEach((link, index) => {
      const expectedPath = ROLE_LINKS[role][index];
      const validAbsent = link && Object.keys(link).sort().join() === ['path', 'state'].sort().join()
        && link.path === expectedPath && link.state === 'absent';
      const validSymlink = link && Object.keys(link).sort().join() === ['path', 'state', 'target'].sort().join()
        && link.path === expectedPath && link.state === 'symlink' && link.target === `../init.d/${role}`;
      if (!validAbsent && !validSymlink) throw new Error(`current role-state rc link is invalid: ${role}`);
    });
  }
  return value;
}
function queryProcdRole(role) {
  const result = cp.spawnSync('/bin/ubus', ['call', 'service', 'list', JSON.stringify({ name: role })], {
    encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.status !== 0 || !result.stdout) throw new Error(`unable to read live procd state for ${role}`);
  return JSON.parse(result.stdout);
}

function queryRoleReady(role, { spawn = cp.spawnSync } = {}) {
  assertRole(role);
  const adapter = ROLE_READINESS_ADAPTERS[role];
  if (adapter === null) return false;
  try {
    const result = spawn(adapter.command, [...adapter.args], {
      encoding: 'utf8', timeout: 5000, env: { ...SAFE_PROCESS_ENV },
    });
    return result.status === 0;
  } catch (_error) {
    return false;
  }
}
function productionState({
  bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase(),
  generationRoot = PRODUCTION_GENERATION_ROOT,
  queryRole = queryProcdRole,
  queryReady = queryRoleReady,
  liveRoot = '/',
  procRoot = '/proc',
} = {}) {
  if (!UUID.test(bootId)) throw new Error('kernel boot ID is unavailable or malformed');
  const roles = {};
  for (const role of ROLES) {
    const service = queryRole(role);
    const named = service[role] || service;
    const instances = named && named.instances && typeof named.instances === 'object' ? named.instances : {};
    const runningInstances = Object.values(instances).filter((instance) => instance && instance.running === true
      && Number.isSafeInteger(instance.pid) && instance.pid > 0);
    if (runningInstances.length > 1) throw new Error(`multiple live instances are ambiguous for ${role}`);
    const running = runningInstances.length === 1;
    const pid = running ? runningInstances[0].pid : null;
    let processStartTime = null;
    if (running) {
      const statPath = path.join(procRoot, String(pid), 'stat');
      const statIdentity = fs.lstatSync(statPath);
      if (!statIdentity.isFile() || statIdentity.isSymbolicLink()) throw new Error(`process stat is invalid for ${role}`);
      const statText = fs.readFileSync(statPath, 'utf8');
      const close = statText.lastIndexOf(')');
      const fields = close < 0 ? [] : statText.slice(close + 1).trim().split(/\s+/);
      if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error(`process starttime is unavailable for ${role}`);
      processStartTime = fields[19];
    }
    const rcLinks = ROLE_LINKS[role].map((linkPath) => {
      const fullPath = path.resolve(liveRoot, `.${linkPath}`);
      let stat;
      try { stat = fs.lstatSync(fullPath); } catch (error) {
        if (error.code === 'ENOENT') return { path: linkPath, state: 'absent' };
        throw error;
      }
      if (!stat.isSymbolicLink() || fs.readlinkSync(fullPath) !== `../init.d/${role}`) {
        throw new Error(`canonical rc link has an unexpected identity: ${linkPath}`);
      }
      return { path: linkPath, state: 'symlink', target: `../init.d/${role}` };
    });
    const ready = running ? queryReady(role) === true : false;
    roles[role] = { running, ready, pid, processStartTime,
      generation: roleGeneration(role, bootId, generationRoot), bootId, rcLinks };
  }
  return validate({ format: 1, bootId, roles }, { production: true });
}
function dispatch(argv) {
  if (argv.length !== 1 || argv[0] !== '--json') throw new Error('usage: osi-current-role-state --json');
  const snapshot = testSnapshot();
  return validate(snapshot || productionState(), { production: snapshot === null });
}

if (require.main === module) {
  try { process.stdout.write(`${canonical(dispatch(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`[osi-current-role-state] ${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  ROLES, ROLE_LINKS, ROLE_READINESS_ADAPTERS, canonical, recordRoleStart, roleGeneration,
  queryRoleReady, productionState, dispatch,
};
