import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, statfs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  FIXED_ENV,
  PREREQUISITE_NAMES,
  probeWorkstation,
  withEffectiveHomeAuthority,
  withSelectedInstallation,
} from './run-workstation-test.mjs';
import {
  MIN_DISK_FREE_BYTES,
  ROOT_ID_PATTERN,
  validateAuthorityTopology,
  validateConfigDocument,
} from '../config/config-document.mjs';
import {
  assertHeldAuthoritiesDisjoint,
  holdDirectoryAuthority,
} from '../shared/held-directory-authority.mjs';

const execFile = promisify(execFileCallback);
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TARGETS = Object.freeze({ pi5: 'rpi-5', pi4: 'rpi-2' });
const MAX_CONFIG_BYTES = 65_536;
const MAX_PUBLISHER_BYTES = 4 * 1024 * 1024;
const CLOSE_ON_EXEC = typeof constants.O_CLOEXEC === 'number' ? constants.O_CLOEXEC : 0;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | CLOSE_ON_EXEC;
export const REAL_ACCEPTANCE_NOT_IMPLEMENTED = 'REAL_ACCEPTANCE_NOT_IMPLEMENTED';

function fail(code, detail, mutation = 'none') {
  return Object.freeze({ ok: false, code, detail, mutation: mutation === 'none' ? 'none' : 'unknown' });
}

function mutationOf(value) {
  return value?.mutation === 'none' ? 'none' : 'unknown';
}

function validWorkstationEvidence(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'available,mutation,prerequisites'
    || typeof value.available !== 'boolean'
    || (value.mutation !== 'none' && value.mutation !== 'unknown')
    || value.prerequisites === null
    || typeof value.prerequisites !== 'object'
    || Array.isArray(value.prerequisites)
    || Object.keys(value.prerequisites).sort().join(',') !== [...PREREQUISITE_NAMES].sort().join(',')
  ) {
    return false;
  }
  const structurallyValid = PREREQUISITE_NAMES.every((name) => {
    const item = value.prerequisites[name];
    return item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && Object.keys(item).sort().join(',') === 'available,code,detail,mutation'
      && typeof item.available === 'boolean'
      && typeof item.code === 'string'
      && typeof item.detail === 'string'
      && (item.mutation === 'none' || item.mutation === 'unknown');
  });
  if (!structurallyValid) return false;
  const aggregateMutation = PREREQUISITE_NAMES.some((name) => (
    value.prerequisites[name].mutation !== 'none'
  )) ? 'unknown' : 'none';
  const aggregateAvailable = aggregateMutation === 'none' && PREREQUISITE_NAMES.every((name) => (
    value.prerequisites[name].available === true
  ));
  return value.mutation === aggregateMutation && value.available === aggregateAvailable;
}

function detail(error) {
  const value = error && typeof error === 'object' ? error : {};
  return [value.code, value.stderr, value.stdout, value.message].filter((part) => typeof part === 'string' && part.length > 0).join(' ').replace(/[\r\n\t]+/gu, ' ').slice(0, 512);
}

function currentUid() {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('effective user ID is unavailable');
  return uid;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function readExactHeld(handle, snapshot, maximumBytes, label) {
  if (snapshot.size < 1n || snapshot.size > BigInt(maximumBytes)) throw new Error(`${label} size is unsafe`);
  const size = Number(snapshot.size);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead < 1) throw new Error(`${label} ended before its held size`);
    offset += bytesRead;
  }
  return buffer;
}

function validatePrivateFile(stats, owner, expectedMode, maximumBytes, label) {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(owner)
    || (Number(stats.mode) & 0o7777) !== expectedMode
    || stats.nlink !== 1n
    || stats.size < 1n
    || stats.size > BigInt(maximumBytes)
  ) throw new Error(`${label} metadata is unsafe`);
}

function safeComponent(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function descriptorChild(parent, name) {
  if (!safeComponent(name)) throw new Error('descriptor-relative path component is unsafe');
  const base = typeof parent === 'string'
    ? parent
    : parent.executionPath ?? `/proc/self/fd/${parent.handle?.fd ?? parent.fd}`;
  if (typeof base !== 'string') throw new Error('descriptor parent is unavailable');
  return `${base}/${name}`;
}

function acceptanceAuthorityPaths(home) {
  if (typeof home !== 'string' || !isAbsolute(home) || resolve(home) !== home) throw new Error('trusted service home is invalid');
  return Object.freeze({
    home,
    configRoot: join(home, '.config', 'osi-image-builder'),
    configPath: join(home, '.config', 'osi-image-builder', 'config.json'),
    stateRoot: join(home, '.local', 'state', 'osi-image-builder'),
    installRoot: join(home, '.local', 'lib', 'osi-image-builder'),
  });
}

export async function holdAcceptanceConfig(configPath) {
  if (!isAbsolute(configPath) || resolve(configPath) !== configPath || basename(configPath) !== 'config.json') {
    throw new Error('builder config path is not canonical');
  }
  const owner = currentUid();
  const rootPath = dirname(configPath);
  let rootAuthority;
  let configHandle;
  try {
    rootAuthority = await holdDirectoryAuthority(rootPath, {
      ownerUid: owner,
      finalAccess: 'read',
    });
    if (rootAuthority.executionPath === undefined) {
      throw new Error('held builder config directory is unavailable');
    }
    const heldConfigPath = join(rootAuthority.executionPath, 'config.json');
    configHandle = await open(
      heldConfigPath,
      FILE_FLAGS,
    );
    const before = await configHandle.stat({ bigint: true });
    validatePrivateFile(before, owner, 0o600, MAX_CONFIG_BYTES, 'builder config');
    const bytes = await readExactHeld(configHandle, before, MAX_CONFIG_BYTES, 'builder config');
    const after = await configHandle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw new Error('builder config changed while being read');
    const named = await lstat(heldConfigPath, { bigint: true });
    if (!sameIdentity(before, named)) {
      throw new Error('builder config pathname changed while being read');
    }
    await rootAuthority.revalidate();
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n')) throw new Error('builder config is not canonical JSON');
    const value = JSON.parse(text.slice(0, -1));
    if (
      value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || `${JSON.stringify(value)}\n` !== text
    ) throw new Error('builder config is not canonical JSON');
    const config = validateConfigDocument(value);
    let closed = false;
    const revalidate = async () => {
      if (closed) throw new Error('held builder config authority is closed');
      await rootAuthority.revalidate();
      const held = await configHandle.stat({ bigint: true });
      const current = await lstat(heldConfigPath, { bigint: true });
      validatePrivateFile(held, owner, 0o600, MAX_CONFIG_BYTES, 'builder config');
      if (!sameIdentity(before, held) || !sameIdentity(before, current)) {
        throw new Error('held builder config or pathname identity changed');
      }
      await rootAuthority.revalidate();
    };
    const close = async () => {
      if (closed) return;
      const results = await Promise.allSettled([
        configHandle.close(),
        rootAuthority.close(),
      ]);
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'held builder config descriptors could not be closed');
      }
      closed = true;
    };
    await revalidate();
    return Object.freeze({
      path: configPath,
      config,
      directoryAuthority: rootAuthority,
      revalidate,
      close,
    });
  } catch (error) {
    const results = await Promise.allSettled([
      ...(configHandle === undefined ? [] : [configHandle.close()]),
      ...(rootAuthority === undefined ? [] : [rootAuthority.close()]),
    ]);
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        'builder config validation and descriptor close both failed',
      );
    }
    throw error;
  }
}

export async function readAcceptanceConfig(configPath) {
  const held = await holdAcceptanceConfig(configPath);
  let outcome;
  try {
    await held.revalidate();
    outcome = Object.freeze({ ok: true, config: held.config });
  } catch (error) {
    outcome = Object.freeze({ ok: false, error });
  }
  let closeError;
  try {
    await held.close();
  } catch (error) {
    closeError = error;
  }
  if (closeError !== undefined) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, closeError],
        'builder config revalidation and descriptor close both failed',
      );
    }
    throw closeError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.config;
}

export async function holdConfiguredAuthorityPaths(installRoot, installRootPath) {
  if (!installRoot?.executionPath || !isAbsolute(installRootPath) || resolve(installRootPath) !== installRootPath) {
    throw new Error('held installation root is unavailable for configured authorities');
  }
  let handle;
  try {
    handle = await open(descriptorChild(installRoot, 'configured-authorities.json'), FILE_FLAGS);
    const before = await handle.stat({ bigint: true });
    validatePrivateFile(before, currentUid(), 0o600, MAX_CONFIG_BYTES, 'configured authority evidence');
    const text = (await readExactHeld(handle, before, MAX_CONFIG_BYTES, 'configured authority evidence')).toString('utf8');
    if (!text.endsWith('\n')) throw new Error('configured authority evidence is not canonical JSON');
    const value = JSON.parse(text.slice(0, -1));
    if (
      value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'configRoot,schemaVersion,stateRoot'
      || `${JSON.stringify(value)}\n` !== text
      || value.schemaVersion !== 1
      || !Number.isInteger(value.schemaVersion)
      || typeof value.configRoot !== 'string'
      || !isAbsolute(value.configRoot)
      || resolve(value.configRoot) !== value.configRoot
      || typeof value.stateRoot !== 'string'
      || !isAbsolute(value.stateRoot)
      || resolve(value.stateRoot) !== value.stateRoot
    ) throw new Error('configured authority evidence is invalid');
    validateAuthorityTopology({
      configRoot: value.configRoot,
      stateRoot: value.stateRoot,
      installRoot: installRootPath,
    });
    const revalidate = async () => {
      const after = await handle.stat({ bigint: true });
      const named = await lstat(descriptorChild(installRoot, 'configured-authorities.json'), { bigint: true });
      if (!sameIdentity(before, after) || !sameIdentity(before, named)) throw new Error('configured authority evidence changed while held');
    };
    let closed = false;
    const close = async () => {
      if (closed) return;
      try {
        await handle.close();
        closed = true;
      } catch (error) {
        throw new AggregateError([error], 'configured authority evidence descriptor could not be closed');
      }
    };
    await revalidate();
    return Object.freeze({
      paths: Object.freeze({
        configRoot: value.configRoot,
        configPath: join(value.configRoot, 'config.json'),
        stateRoot: value.stateRoot,
        installRoot: installRootPath,
      }),
      revalidate,
      close,
    });
  } catch (error) {
    if (handle === undefined) throw error;
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'configured authority acquisition and descriptor cleanup both failed');
    }
    throw error;
  }
}

export async function inspectConfiguredApprovedRoot(rootId, installation, configPath, authorityPaths = {}) {
  if (typeof rootId !== 'string' || !ROOT_ID_PATTERN.test(rootId)) return { available: false, code: 'APPROVED_ROOT_ID_INVALID', detail: 'approved root ID is not canonical', mutation: 'none' };
  let configAuthority;
  let install;
  let output;
  let repository;
  let state;
  let rejectionCode = 'APPROVED_ROOT_UNAVAILABLE';
  try {
    configAuthority = await holdAcceptanceConfig(configPath);
    const { config } = configAuthority;
    if (
      typeof config.repositoryPath !== 'string'
      || typeof config.builderLockPath !== 'string'
      || !isAbsolute(config.builderLockPath)
      || resolve(config.builderLockPath) !== config.builderLockPath
    ) throw new Error('builder config authorities are invalid');
    if (config.builderLockPath !== installation.lockPath) {
      rejectionCode = 'CONFIG_INSTALLATION_MISMATCH';
      throw new Error('configured builder lock does not match the selected installation');
    }
    if (!Array.isArray(config.approvedOutputRoots)) throw new Error('approved roots are missing from builder config');
    const rootIds = new Set();
    for (const root of config.approvedOutputRoots) {
      if (
        root === null
        || typeof root !== 'object'
        || Object.keys(root).sort().join(',') !== 'id,label,path'
        || typeof root.id !== 'string'
        || !ROOT_ID_PATTERN.test(root.id)
        || rootIds.has(root.id)
        || typeof root.label !== 'string'
        || root.label.length < 1
        || typeof root.path !== 'string'
        || !isAbsolute(root.path)
        || resolve(root.path) !== root.path
      ) throw new Error('approved roots in builder config are invalid');
      rootIds.add(root.id);
    }
    const matches = config.approvedOutputRoots.filter((root) => root && root.id === rootId);
    if (matches.length !== 1 || typeof matches[0].path !== 'string' || !isAbsolute(matches[0].path)) {
      throw new Error('requested approved root is not present exactly once in builder config');
    }
    const configRoot = authorityPaths.configRoot ?? dirname(configPath);
    if (
      typeof configRoot !== 'string'
      || !isAbsolute(configRoot)
      || resolve(configRoot) !== configRoot
      || configAuthority.directoryAuthority?.path !== configRoot
      || typeof authorityPaths.installRoot !== 'string'
      || typeof authorityPaths.stateRoot !== 'string'
    ) throw new Error('configured directory authorities are incomplete');
    try {
      validateAuthorityTopology({
        configRoot,
        stateRoot: authorityPaths.stateRoot,
        installRoot: authorityPaths.installRoot,
        repositoryPath: config.repositoryPath,
        approvedOutputRoots: config.approvedOutputRoots,
      });
    } catch (error) {
      rejectionCode = 'APPROVED_ROOT_OVERLAP';
      throw new Error(detail(error) || 'configured authority topology overlaps');
    }

    const holdAuthority = authorityPaths.holdDirectoryAuthority ?? holdDirectoryAuthority;
    install = await holdAuthority(authorityPaths.installRoot, { finalAccess: 'read' });
    output = await holdAuthority(matches[0].path, { finalAccess: 'write' });
    repository = await holdAuthority(config.repositoryPath, { finalAccess: 'read' });
    state = await holdAuthority(authorityPaths.stateRoot, { finalAccess: 'write' });
    const topology = authorityPaths.assertHeldAuthoritiesDisjoint ?? assertHeldAuthoritiesDisjoint;
    try {
      topology([
        { name: 'config', path: configRoot, authority: configAuthority.directoryAuthority },
        { name: 'install', path: authorityPaths.installRoot, authority: install },
        { name: 'state', path: authorityPaths.stateRoot, authority: state },
        { name: 'repository', path: config.repositoryPath, authority: repository },
        { name: 'output', path: matches[0].path, authority: output },
      ]);
    } catch (error) {
      rejectionCode = 'APPROVED_ROOT_OVERLAP';
      throw error;
    }
    for (const authority of [configAuthority.directoryAuthority, install, output, repository, state]) {
      if (authority?.exists !== true || typeof authority.executionPath !== 'string') {
        throw new Error('configured authority is unavailable');
      }
    }
    const revalidate = async () => {
      await configAuthority.revalidate();
      await install.revalidate();
      await output.revalidate();
      await repository.revalidate();
      await state.revalidate();
      await configAuthority.revalidate();
    };
    let closed = false;
    const close = async () => {
      if (closed) return;
      const results = await Promise.allSettled([
        configAuthority.close(),
        install.close(),
        output.close(),
        repository.close(),
        state.close(),
      ]);
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'configured authority descriptors could not be closed');
      }
      closed = true;
    };
    return Object.freeze({
      available: true,
      path: output.path,
      dev: output.identityChain.at(-1).dev,
      ino: output.identityChain.at(-1).ino,
      releaseExecutionPath: output.executionPath,
      installRoot: install.path,
      installExecutionPath: install.executionPath,
      repositoryPath: repository.path,
      repositoryExecutionPath: repository.executionPath,
      statePath: state.path,
      stateExecutionPath: state.executionPath,
      builderLockPath: config.builderLockPath,
      minimumFreeBytes: config.diskFreeMinimumBytes,
      mutation: 'none',
      revalidate,
      close,
    });
  } catch (error) {
    const results = await Promise.allSettled([
      configAuthority?.close(),
      install?.close(),
      output?.close(),
      repository?.close(),
      state?.close(),
    ]);
    const closeFailures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    const failure = closeFailures.length === 0
      ? error
      : new AggregateError(
        [error, ...closeFailures],
        'approved-root validation and descriptor close both failed',
      );
    return {
      available: false,
      code: rejectionCode,
      detail: detail(failure) || 'approved root could not be validated',
      mutation: closeFailures.length === 0 ? 'none' : 'unknown',
    };
  }
}

export async function checkAuthorityFreeDisk(root, readStatfs = statfs) {
  if (!root || root.available !== true || !isAbsolute(root.path)) return { available: false, code: 'FREE_DISK_UNAVAILABLE', detail: 'validated approved root is missing', mutation: 'none' };
  try {
    if (typeof root.releaseExecutionPath !== 'string' || typeof root.stateExecutionPath !== 'string'
      || !Number.isSafeInteger(root.minimumFreeBytes) || root.minimumFreeBytes < MIN_DISK_FREE_BYTES) {
      throw new Error('validated output/state filesystem authorities are incomplete');
    }
    if (typeof root.revalidate === 'function') await root.revalidate();
    const outputStats = await readStatfs(root.releaseExecutionPath);
    const stateStats = await readStatfs(root.stateExecutionPath);
    const outputFreeBytes = Number(outputStats.bavail) * Number(outputStats.bsize);
    const stateFreeBytes = Number(stateStats.bavail) * Number(stateStats.bsize);
    return Number.isSafeInteger(outputFreeBytes) && Number.isSafeInteger(stateFreeBytes)
      && outputFreeBytes >= root.minimumFreeBytes && stateFreeBytes >= root.minimumFreeBytes
      ? { available: true, path: root.path, outputFreeBytes, stateFreeBytes, minimumFreeBytes: root.minimumFreeBytes, mutation: 'none' }
      : { available: false, code: 'FREE_DISK_UNAVAILABLE', detail: 'validated output or state filesystem is below the configured free-space floor', mutation: 'none' };
  } catch (error) { return { available: false, code: 'FREE_DISK_UNAVAILABLE', detail: detail(error) || 'free disk could not be measured', mutation: 'none' }; }
}

function validSelection(selection, lock, lockText, installation) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return false;
  const keys = ['executionDefinitionSha256', 'lockSha256', 'manifestSha256', 'packageVersion', 'publisherSha256'];
  if (Object.keys(selection).sort().join(',') !== keys.sort().join(',') || typeof selection.packageVersion !== 'string' || !/^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u.test(selection.packageVersion)) return false;
  if (['executionDefinitionSha256', 'lockSha256', 'manifestSha256', 'publisherSha256'].some((key) => typeof selection[key] !== 'string' || !SHA256.test(selection[key]))) return false;
  if (!installation || typeof installation.versionRoot !== 'string' || !isAbsolute(installation.versionRoot) || resolve(installation.versionRoot) !== installation.versionRoot || typeof installation.lockPath !== 'string' || !isAbsolute(installation.lockPath) || resolve(installation.lockPath) !== installation.lockPath || installation.lockPath !== join(installation.versionRoot, 'builder.lock.json')) return false;
  if (typeof lockText !== 'string' || createHash('sha256').update(lockText).digest('hex') !== selection.lockSha256) return false;
  let parsedLock;
  try { parsedLock = JSON.parse(lockText.endsWith('\n') ? lockText.slice(0, -1) : lockText); } catch { return false; }
  if (JSON.stringify(parsedLock) !== (lockText.endsWith('\n') ? lockText.slice(0, -1) : lockText)) return false;
  if (!lock || typeof lock !== 'object' || JSON.stringify(lock) !== JSON.stringify(parsedLock)) return false;
  const requiredLockKeys = ['schemaVersion', 'packageVersion', 'imageRepository', 'imageDigest', 'baseImage', 'baseImageDigest', 'dockerfileSha256', 'packageSet', 'rustConfig', 'nodeVersion', 'executionDefinitionSha256', 'validationEvidenceSha256'];
  const optionalLockKeys = ['installable', 'publisherSha256', 'imageId'];
  const lockKeys = Object.keys(lock);
  if (lockKeys.some((key) => !requiredLockKeys.includes(key) && !optionalLockKeys.includes(key)) || requiredLockKeys.some((key) => !lockKeys.includes(key)) || lock.schemaVersion !== 1 || lock.installable !== true || lock.packageVersion !== selection.packageVersion || typeof lock.imageRepository !== 'string' || !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(lock.imageRepository) || typeof lock.imageDigest !== 'string' || !SHA256.test(lock.imageDigest) || typeof lock.baseImage !== 'string' || !lock.baseImage.endsWith(`@sha256:${lock.baseImageDigest}`)) return false;
  for (const key of ['imageDigest', 'baseImageDigest', 'dockerfileSha256', 'executionDefinitionSha256', 'validationEvidenceSha256', 'publisherSha256', 'imageId']) if (lock[key] !== undefined && (!SHA256.test(lock[key]) || /^0+$/u.test(lock[key]))) return false;
  if (!Array.isArray(lock.packageSet) || lock.packageSet.length !== 7 || new Set(lock.packageSet).size !== 7 || lock.packageSet.some((item) => typeof item !== 'string')) return false;
  if (lock.rustConfig === null || typeof lock.rustConfig !== 'object' || lock.rustConfig.llvmConfig !== '/usr/bin/llvm-config' || lock.rustConfig.channel !== 'stable' || !/^\d+\.\d+\.\d+$/u.test(lock.rustConfig.version) || !Number.isInteger(lock.rustConfig.llvmMajor) || typeof lock.nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(lock.nodeVersion) || Number.parseInt(lock.nodeVersion, 10) < 22) return false;
  return lock.publisherSha256 === selection.publisherSha256 && lock.executionDefinitionSha256 === selection.executionDefinitionSha256;
}

export async function checkHeldPublisher(installation, publisherFile) {
  try {
    if (!publisherFile?.handle || !publisherFile?.parent || publisherFile.name !== 'osi-image-publish') {
      throw new Error('held installed publisher identity is unavailable');
    }
    const snapshot = await publisherFile.handle.stat({ bigint: true });
    validatePrivateFile(snapshot, currentUid(), 0o555, MAX_PUBLISHER_BYTES, 'installed publisher');
    if (publisherFile.before !== undefined && !sameIdentity(snapshot, publisherFile.before)) throw new Error('held installed publisher metadata changed');
    const bytes = await readExactHeld(publisherFile.handle, snapshot, MAX_PUBLISHER_BYTES, 'installed publisher');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== installation.publisherSha256) {
      return { available: false, code: 'PUBLISHER_SELF_TEST_FAILED', detail: 'held installed publisher hash does not match selected evidence', mutation: 'none' };
    }
    const output = await execFile(`/proc/${process.pid}/fd/${publisherFile.handle.fd}`, ['--self-test'], {
      env: FIXED_ENV,
      timeout: 120_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    });
    const evidence = JSON.parse(String(output.stdout).trim());
    const after = await publisherFile.handle.stat({ bigint: true });
    const named = await lstat(descriptorChild(publisherFile.parent, publisherFile.name), { bigint: true });
    if (!sameIdentity(snapshot, after) || !sameIdentity(snapshot, named)) throw new Error('installed publisher identity changed during self-test');
    const exactShape = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)
      && Object.keys(evidence).sort().join(',') === 'available,mutationCount,published,quarantined,selfTest';
    if (!exactShape || evidence.available !== true || evidence.published !== false
      || evidence.quarantined !== false || evidence.selfTest !== true || evidence.mutationCount !== 0) {
      const provedNoMutation = exactShape && evidence.published === false && evidence.quarantined === false && evidence.mutationCount === 0;
      return { available: false, code: 'PUBLISHER_SELF_TEST_FAILED', detail: 'installed publisher self-test did not prove the exact zero-mutation contract', mutation: provedNoMutation ? 'none' : 'unknown' };
    }
    return { available: true, passed: true, sha256, mutation: 'none' };
  } catch (error) {
    let mutation = 'unknown';
    try {
      const evidence = JSON.parse(String(error?.stdout ?? ''));
      if (evidence?.published === false && evidence?.quarantined === false && evidence?.mutationCount === 0) mutation = 'none';
    } catch {
      mutation = 'unknown';
    }
    return { available: false, code: 'PUBLISHER_SELF_TEST_FAILED', detail: detail(error) || 'installed publisher self-test failed', mutation };
  }
}

async function defaultInspect(lock) {
  const reference = `${lock.imageRepository}@sha256:${lock.imageDigest}`;
  try {
    const output = await execFile('/usr/bin/docker', ['version', '--format', '{{.Server.Version}}'], { env: FIXED_ENV, timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true, shell: false });
    if (!/^\S+$/u.test(String(output.stdout).trim())) return { available: false, code: 'DOCKER_DAEMON_UNAVAILABLE', detail: 'Docker client is present but daemon did not respond', mutation: 'none' };
    const inspected = await execFile('/usr/bin/docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', reference], { env: FIXED_ENV, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false });
    const repoDigests = JSON.parse(String(inspected.stdout));
    return Array.isArray(repoDigests) && repoDigests.length === 1 && repoDigests[0] === reference
      ? { available: true, repository: lock.imageRepository, digest: lock.imageDigest, repoDigests, mutation: 'none' }
      : { available: false, code: 'IMAGE_DIGEST_MISMATCH', detail: 'Docker did not return the exact canonical RepoDigest', mutation: 'none' };
  } catch (error) { return { available: false, code: 'DOCKER_DAEMON_UNAVAILABLE', detail: detail(error) || 'Docker daemon inspection failed', mutation: 'none' }; }
}

/**
 * This function is the Task 34 guard boundary. A successful result is still
 * deliberately nonzero at the CLI until Task 35 supplies the build action.
 * @param {{ target: 'pi5' | 'pi4' | 'all', env?: Record<string, string | undefined>, dependencies?: object }} input
 */
export async function evaluateAcceptanceGuards(input) {
  const env = input.env ?? process.env;
  if (input.target !== 'pi5' && input.target !== 'pi4' && input.target !== 'all') return fail('TARGET_INVALID', 'acceptance target is invalid');
  if (env.OSI_IMAGE_BUILDER_REAL !== '1') return fail('REAL_ACCEPTANCE_DISABLED', 'OSI_IMAGE_BUILDER_REAL=1 is required');
  const rootId = env.OSI_IMAGE_BUILDER_APPROVED_ROOT_ID;
  if (typeof rootId !== 'string' || !ROOT_ID_PATTERN.test(rootId)) return fail('APPROVED_ROOT_ID_MISSING', 'a canonical approved root ID is required');
  if (typeof env.OSI_IMAGE_BUILDER_PINNED_SHA !== 'string' || !SHA40.test(env.OSI_IMAGE_BUILDER_PINNED_SHA)) return fail('PINNED_SHA_INVALID', 'a full 40-character pinned SHA is required');
  const targetId = input.target === 'all' ? undefined : TARGETS[input.target];
  if (targetId !== undefined && env.OSI_IMAGE_BUILDER_TARGET !== targetId) return fail('TARGET_MISMATCH', `exact target ${targetId} is required`);
  if (input.target === 'all' && env.OSI_IMAGE_BUILDER_TARGET !== undefined) return fail('TARGET_MISMATCH', 'accept:all requires no single-target environment override');

  const dependencies = input.dependencies ?? {};
  if (dependencies.readInstalledInstallation === undefined) {
    try {
      const holdHome = dependencies.withTrustedHomeAuthority ?? (
        dependencies.resolveTrustedHome === undefined
          ? async (callback) => withEffectiveHomeAuthority(undefined, callback)
          : async (callback) => callback(Object.freeze({
            path: await dependencies.resolveTrustedHome(),
          }))
      );
      return await holdHome(async (homeAuthority) => {
        const trustedPaths = acceptanceAuthorityPaths(homeAuthority.path);
        const holdInstallation = dependencies.holdSelectedInstallation ?? withSelectedInstallation;
        return holdInstallation({ installRoot: trustedPaths.installRoot }, async (heldInstallation, heldFiles) => {
          const configured = await (dependencies.readConfiguredAuthorityPaths ?? holdConfiguredAuthorityPaths)(
            heldFiles?.installRoot,
            trustedPaths.installRoot,
          );
          try {
            const result = await evaluateAcceptanceGuards({
              ...input,
              env,
              dependencies: {
                ...dependencies,
                readInstalledInstallation: async () => heldInstallation,
                heldPublisherFile: heldFiles?.publisherFile,
                authorityPaths: configured.paths,
              },
            });
            await configured.revalidate();
            return result;
          } finally {
            await configured.close();
          }
        });
      });
    } catch (error) {
      return fail('INSTALLED_INSTALLATION_UNAVAILABLE', `selected installation could not be held for acceptance: ${detail(error) || String(error)}`, 'unknown');
    }
  }
  let installation;
  try { installation = await dependencies.readInstalledInstallation(); }
  catch (error) { return fail('INSTALLED_INSTALLATION_UNAVAILABLE', `selected installation could not be validated: ${detail(error) || String(error)}`, 'unknown'); }
  if (!validSelection(installation.selection, installation.lock, installation.lockText, installation)) return fail('INSTALLED_INSTALLATION_INVALID', 'selected installation evidence is incomplete or mismatched');

  let root;
  try {
    root = await (dependencies.checkApprovedRoot ?? inspectConfiguredApprovedRoot)(
      rootId,
      installation,
      dependencies.authorityPaths?.configPath,
      dependencies.authorityPaths,
    );
  } catch (error) {
    return fail('APPROVED_ROOT_UNAVAILABLE', `approved-root adapter failed before returning mutation evidence: ${detail(error) || String(error)}`, 'unknown');
  }
  if (root?.available !== true || root.mutation !== 'none' || typeof root.path !== 'string' || !isAbsolute(root.path)) return fail(root?.code ?? 'APPROVED_ROOT_UNAVAILABLE', root?.detail ?? 'approved root is unavailable', mutationOf(root));

  let outcome;
  let authorityError;
  try {
    if (root.builderLockPath !== installation.lockPath) outcome = fail('CONFIG_INSTALLATION_MISMATCH', 'configured builder lock does not match the selected installation');
    else if (typeof root.repositoryPath !== 'string' || !isAbsolute(root.repositoryPath) || resolve(root.repositoryPath) !== root.repositoryPath) outcome = fail('CONFIG_REPOSITORY_INVALID', 'configured repository authority is unavailable');
    else {
      let disk;
      try {
        disk = await (dependencies.checkFreeDisk ?? checkAuthorityFreeDisk)(root);
      } catch (error) {
        outcome = fail('FREE_DISK_UNAVAILABLE', `free-disk adapter failed before returning mutation evidence: ${detail(error) || String(error)}`, 'unknown');
      }
      if (outcome === undefined && (disk?.available !== true || disk.mutation !== 'none')) outcome = fail(disk?.code ?? 'FREE_DISK_UNAVAILABLE', disk?.detail ?? 'free disk is unavailable', mutationOf(disk));

      let workstation;
      if (outcome === undefined) {
        try {
          workstation = dependencies.workstation ?? await (dependencies.probeWorkstation ?? probeWorkstation)({
            mode: 'real',
            cwd: root.repositoryExecutionPath ?? root.repositoryPath,
            pinnedSha: env.OSI_IMAGE_BUILDER_PINNED_SHA,
            env: {
              ...env,
              OSI_IMAGE_BUILDER_APPROVED_ROOT_PATH: root.path,
              OSI_IMAGE_BUILDER_STATE_ROOT_PATH: root.stateExecutionPath,
              OSI_IMAGE_BUILDER_DISK_MINIMUM_BYTES: String(root.minimumFreeBytes),
            },
          });
        } catch (error) {
          outcome = fail('PREREQUISITE_UNAVAILABLE', `workstation adapter failed before returning mutation evidence: ${detail(error) || String(error)}`, 'unknown');
        }
      }
      if (outcome === undefined && !validWorkstationEvidence(workstation)) {
        outcome = fail(
          'PREREQUISITE_UNAVAILABLE',
          'workstation adapter returned incomplete evidence',
          'unknown',
        );
      }
      if (outcome === undefined && (workstation.available !== true || workstation.mutation !== 'none')) {
        const failed = Object.entries(workstation.prerequisites ?? {}).find(([, item]) => item && item.available !== true);
        outcome = fail(failed?.[1]?.code ?? 'PREREQUISITE_UNAVAILABLE', failed?.[1]?.detail ?? 'workstation prerequisites are unavailable', mutationOf(workstation));
      }

      let inspected;
      if (outcome === undefined) {
        try {
          inspected = await (dependencies.inspectImage ?? defaultInspect)(installation.lock);
        } catch (error) {
          outcome = fail('IMAGE_DIGEST_MISMATCH', `image-inspection adapter failed before returning mutation evidence: ${detail(error) || String(error)}`, 'unknown');
        }
      }
      if (outcome === undefined) {
        const reference = `${installation.lock.imageRepository}@sha256:${installation.lock.imageDigest}`;
        if (inspected?.available !== true || inspected.mutation !== 'none'
          || inspected.repository !== installation.lock.imageRepository || inspected.digest !== installation.lock.imageDigest
          || !Array.isArray(inspected.repoDigests) || inspected.repoDigests.length !== 1 || inspected.repoDigests[0] !== reference) {
          outcome = fail(inspected?.code ?? 'IMAGE_DIGEST_MISMATCH', inspected?.detail ?? 'exact generated image RepoDigest is not verified', mutationOf(inspected));
        }
      }

      let publisher;
      if (outcome === undefined) {
        try {
          publisher = await (dependencies.checkPublisher ?? checkHeldPublisher)(installation, dependencies.heldPublisherFile);
        } catch (error) {
          outcome = fail('PUBLISHER_SELF_TEST_FAILED', `publisher adapter failed before returning mutation evidence: ${detail(error) || String(error)}`, 'unknown');
        }
      }
      if (outcome === undefined && (publisher?.available !== true || publisher.passed !== true || publisher.mutation !== 'none' || publisher.sha256 !== installation.lock.publisherSha256)) {
        outcome = fail(publisher?.code ?? 'PUBLISHER_SELF_TEST_FAILED', publisher?.detail ?? 'installed publisher self-test failed', mutationOf(publisher));
      }
      if (outcome === undefined) outcome = Object.freeze({ ok: true, code: REAL_ACCEPTANCE_NOT_IMPLEMENTED, detail: 'all acceptance guards passed; real image acceptance is assigned to Task 35', mutation: 'none', ...(targetId === undefined ? { targetIds: ['rpi-5', 'rpi-2'] } : { targetId }) });
    }
    if (typeof root.revalidate === 'function') await root.revalidate();
  } catch (error) {
    authorityError = error;
  }
  try {
    if (typeof root.close === 'function') await root.close();
  } catch (error) {
    authorityError ??= error;
  }
  return authorityError === undefined
    ? outcome
    : fail('APPROVED_ROOT_CHANGED', `configured authority could not be revalidated and closed: ${detail(authorityError) || String(authorityError)}`, 'unknown');
}

async function main() {
  const target = process.argv[2];
  const result = await evaluateAcceptanceGuards({ target, env: process.env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
