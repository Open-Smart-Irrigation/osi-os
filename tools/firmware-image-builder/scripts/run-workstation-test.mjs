import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { checkNodeVersion } from './require-node22.mjs';
import {
  resolveEffectiveHome,
  withEffectiveHomeAuthority,
} from '../shared/effective-home.mjs';
import { holdDirectoryAuthority } from '../shared/held-directory-authority.mjs';

export { resolveEffectiveHome, withEffectiveHomeAuthority };
export const resolveTrustedServiceHome = resolveEffectiveHome;

const execFile = promisify(execFileCallback);
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MINIMUM_FREE_BYTES = 20 * 1024 ** 3;
const MAX_JSON_BYTES = 65_536;
const MAX_RELEASE_IMAGE_BYTES = 16 * 1024 ** 3;
const MAX_ORIGIN_BYTES = 4_096;
const CANONICAL_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const DOCKER_REPOSITORY_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export const FIXED_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  DOCKER_CONFIG: '/nonexistent/osi-image-builder-empty-docker-config',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_ALLOW_PROTOCOL: 'ssh',
  GIT_SSH_COMMAND: '/usr/bin/ssh -F /dev/null -oBatchMode=yes -oIdentitiesOnly=no',
  GIT_SSH_VARIANT: 'ssh',
});

export const WORKSTATION_EXECUTABLES = Object.freeze({
  git: '/usr/bin/git',
  docker: '/usr/bin/docker',
  systemctl: '/usr/bin/systemctl',
  sqlite3: '/usr/bin/sqlite3',
  npm: '/usr/bin/npm',
  gcc: '/usr/bin/gcc',
  make: '/usr/bin/make',
});

export const PREREQUISITE_NAMES = Object.freeze([
  'node',
  'npm',
  'gitSshOrigin',
  'docker',
  'userSystemd',
  'sqlite3',
  'gccLibcMake',
  'renameat2',
  'installedLockImage',
  'approvedRoot',
  'freeDisk',
]);

function result(available, code, detail, mutation = 'none') {
  return Object.freeze({ available, code, detail, mutation });
}

function unavailable(name, detail = `${name} is unavailable`) {
  return result(false, `${name.toUpperCase()}_UNAVAILABLE`, detail);
}

function mergeErrors(operationError, cleanupError, message) {
  if (operationError === undefined) return cleanupError;
  if (cleanupError === undefined) return operationError;
  return new AggregateError([operationError, cleanupError], message);
}

function unproven(name, detail) {
  return result(false, `${name.toUpperCase()}_UNAVAILABLE`, detail, 'unknown');
}

function commandFailure(error) {
  const value = error && typeof error === 'object' ? error : {};
  return [value.code, value.stderr, value.stdout, value.message]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 512);
}

async function command(executable, args, options = {}) {
  if (!isAbsolute(executable)) return { ok: false, detail: 'probe executable is not absolute' };
  try {
    const output = await execFile(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? FIXED_ENV,
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 128 * 1024,
      windowsHide: true,
      shell: false,
    });
    return { ok: true, stdout: String(output.stdout), stderr: String(output.stderr) };
  } catch (error) {
    return { ok: false, detail: commandFailure(error) || 'command failed' };
  }
}

function hasControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function validSshHost(value) {
  if (value.length === 0 || value.length > 253 || value.startsWith('-') || value.endsWith('-')) return false;
  return value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

function validSshUser(value) { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value); }

export function validateGitOrigin(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') === 0 || Buffer.byteLength(value, 'utf8') > MAX_ORIGIN_BYTES || value.trim() !== value || /\s/u.test(value) || hasControl(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return false;
  if (value.startsWith('ssh://')) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'ssh:' && parsed.hostname.length > 0 && validSshHost(parsed.hostname)
        && (!parsed.username || validSshUser(parsed.username)) && parsed.password.length === 0
        && parsed.pathname.length > 1 && !parsed.pathname.startsWith('/-') && !parsed.search && !parsed.hash
        && (parsed.port === '' || (/^\d+$/u.test(parsed.port) && Number(parsed.port) >= 1 && Number(parsed.port) <= 65535));
    } catch { return false; }
  }
  const match = /^([^@/:\\\s]+)@([^/:\\\s]+):(.+)$/u.exec(value);
  return match !== null && validSshUser(match[1]) && validSshHost(match[2]) && !match[3].startsWith('/') && !match[3].startsWith('-');
}

export function validateGitConfigKeys(keys) {
  for (const key of keys) {
    if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') === 0 || Buffer.byteLength(key, 'utf8') > 1_024 || hasControl(key)) return false;
    if (/^(?:include|includeif)(?:\.|$)/iu.test(key) || /^hook\./iu.test(key) || /^url\./iu.test(key)) return false;
    if (/^(?:core\.(?:sshcommand|gitproxy|alternaterefscommand|alternaterefsprefixes|fsmonitor|askpass|pager|editor)|protocol\.|credential\.|(?:https?|ssh|proxy|transport)\.|uploadpack\.|receive\.)/iu.test(key)) return false;
    if (/^submodule\.(?:recurse|[^.]+\.(?:url|update|fetchrecursesubmodules))$/iu.test(key) || /^fetch\.recurseSubmodules$/iu.test(key) || /^fetch\.bundle/iu.test(key)) return false;
    if (/^remote\./iu.test(key) && key.toLowerCase() !== 'remote.origin.url' && key.toLowerCase() !== 'remote.origin.fetch') return false;
  }
  return true;
}

function currentUid() {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('effective user ID is unavailable');
  return uid;
}

async function holdTrustedSshAgentSocket(candidate, ownerUid) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate) || candidate.includes('\0')
    || hasControl(candidate) || resolve(candidate) !== candidate) return undefined;
  const name = candidate.slice(candidate.lastIndexOf('/') + 1);
  if (!safePathComponent(name)) return undefined;
  let parentAuthority;
  try {
    parentAuthority = await holdDirectoryAuthority(dirname(candidate), {
      ownerUid,
      finalAccess: 'read',
    });
    if (parentAuthority.executionPath === undefined) {
      throw new Error('held SSH agent parent is unavailable');
    }
    const heldPath = join(parentAuthority.executionPath, name);
    const before = await lstat(heldPath, { bigint: true });
    if (!before.isSocket() || before.uid !== BigInt(ownerUid) || before.nlink !== 1n) {
      await parentAuthority.close();
      return undefined;
    }
    let closed = false;
    const revalidate = async () => {
      if (closed) throw new Error('held SSH agent authority is closed');
      await parentAuthority.revalidate();
      const current = await lstat(heldPath, { bigint: true });
      if (
        !current.isSocket()
        || current.uid !== BigInt(ownerUid)
        || current.nlink !== 1n
        || !sameIdentity(before, current)
      ) {
        throw new Error('held SSH agent socket identity changed');
      }
      await parentAuthority.revalidate();
    };
    const close = async () => {
      if (closed) return;
      await parentAuthority.close();
      closed = true;
    };
    await revalidate();
    return Object.freeze({
      path: heldPath,
      revalidate,
      close,
    });
  } catch (error) {
    if (parentAuthority !== undefined) {
      try {
        await parentAuthority.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'SSH agent validation and parent descriptor close both failed',
        );
      }
    }
    if (error instanceof AggregateError) throw error;
    return undefined;
  }
}

export async function withTrustedGitEnvironment(options = {}, callback) {
  if (typeof callback !== 'function') throw new TypeError('trusted Git environment callback is required');
  return withEffectiveHomeAuthority(options, async (authority) => {
    const ownerUid = options.ownerUid ?? currentUid();
    const candidate = Object.hasOwn(options, 'sshAuthSock')
      ? options.sshAuthSock
      : process.env.SSH_AUTH_SOCK;
    const socketAuthority = await holdTrustedSshAgentSocket(candidate, ownerUid);
    const environment = Object.freeze({
      ...FIXED_ENV,
      HOME: authority.path,
      ...(socketAuthority === undefined ? {} : { SSH_AUTH_SOCK: socketAuthority.path }),
    });
    const commandAuthority = Object.freeze({
      revalidate: async () => socketAuthority?.revalidate(),
    });
    let outcome;
    try {
      outcome = Object.freeze({
        ok: true,
        value: await callback(environment, commandAuthority),
      });
    } catch (error) {
      outcome = Object.freeze({ ok: false, error });
    }
    let authorityError;
    try {
      await commandAuthority.revalidate();
    } catch (error) {
      authorityError = error;
    }
    try {
      await socketAuthority?.close();
    } catch (error) {
      authorityError = mergeErrors(authorityError, error, 'trusted Git authority validation and cleanup both failed');
    }
    const operationError = outcome.ok ? undefined : outcome.error;
    const failure = mergeErrors(operationError, authorityError, 'trusted Git operation and authority cleanup both failed');
    if (failure !== undefined) throw failure;
    return outcome.value;
  });
}

export async function createTrustedGitEnvironment(options = {}) {
  return withEffectiveHomeAuthority(options, async (authority) => Object.freeze({
    ...FIXED_ENV,
    HOME: authority.path,
  }));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.rdev === right.rdev
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

const CLOSE_ON_EXEC = typeof fsConstants.O_CLOEXEC === 'number' ? fsConstants.O_CLOEXEC : 0;
const NO_ACCESS_TIME = typeof fsConstants.O_NOATIME === 'number' ? fsConstants.O_NOATIME : 0;
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | CLOSE_ON_EXEC;
const FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW | NO_ACCESS_TIME | CLOSE_ON_EXEC;

function safePathComponent(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function descriptorChild(parent, name) {
  if (!safePathComponent(name)) throw new Error('unsafe descriptor-relative path component');
  const base = typeof parent === 'string'
    ? parent
    : parent.executionPath ?? `/proc/self/fd/${parent.handle?.fd ?? parent.fd}`;
  return `${base}/${name}`;
}

async function closeBindings(bindings, closeHandle = (handle) => handle.close()) {
  const results = await Promise.allSettled(
    [...bindings].reverse().map(({ handle }) => closeHandle(handle)),
  );
  const failures = results
    .filter((item) => item.status === 'rejected')
    .map((item) => item.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'workstation descriptors could not be closed');
}

async function openAbsoluteDirectoryChain(path, closeHandle = (handle) => handle.close()) {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error('directory path is not a canonical absolute path');
  const bindings = [];
  let parent;
  try {
    const rootHandle = await open('/', DIRECTORY_OPEN_FLAGS);
    const rootSnapshot = await rootHandle.stat({ bigint: true });
    if (!rootSnapshot.isDirectory()) throw new Error('filesystem root is not a directory');
    bindings.push({ handle: rootHandle, before: rootSnapshot });
    parent = rootHandle;
    for (const name of path.split('/').filter(Boolean)) {
      const handle = await open(descriptorChild(parent, name), DIRECTORY_OPEN_FLAGS);
      const before = await handle.stat({ bigint: true });
      const named = await lstat(descriptorChild(parent, name), { bigint: true });
      if (!before.isDirectory() || !sameIdentity(before, named)) {
        let closeError;
        try {
          await closeHandle(handle);
        } catch (error) {
          closeError = error;
        }
        if (closeError !== undefined) {
          throw new AggregateError(
            [new Error('directory path contains an unsafe component'), closeError],
            'directory acquisition and descriptor cleanup both failed',
          );
        }
        throw new Error('directory path contains an unsafe component');
      }
      bindings.push({ handle, before, parent, name });
      parent = handle;
    }
    return bindings;
  } catch (error) {
    let cleanupError;
    try {
      await closeBindings(bindings, closeHandle);
    } catch (closeError) {
      cleanupError = closeError;
    }
    throw mergeErrors(error, cleanupError, 'directory acquisition and descriptor cleanup both failed');
  }
}

async function revalidateDirectoryChain(bindings) {
  for (const binding of bindings) {
    const after = await binding.handle.stat({ bigint: true });
    if (!sameIdentity(binding.before, after)) throw new Error('held directory metadata changed');
    if (binding.parent !== undefined) {
      const named = await lstat(descriptorChild(binding.parent, binding.name), { bigint: true });
      if (!sameIdentity(binding.before, named)) throw new Error('directory pathname identity changed');
    }
  }
}

async function readHeldBytes(binding, maximumBytes) {
  if (binding.before.size < 1n || binding.before.size > BigInt(maximumBytes)) throw new Error('held file size is outside its bound');
  const size = Number(binding.before.size);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await binding.handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) throw new Error('held file ended before its recorded size');
    offset += bytesRead;
  }
  return buffer;
}

async function hashHeldFile(binding, maximumBytes) {
  if (binding.before.size < 1n || binding.before.size > BigInt(maximumBytes)) throw new Error('held file size is outside its bound');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Number(binding.before.size)));
  let offset = 0;
  const size = Number(binding.before.size);
  while (offset < size) {
    const length = Math.min(chunk.length, size - offset);
    const { bytesRead } = await binding.handle.read(chunk, 0, length, offset);
    if (bytesRead === 0) throw new Error('held file ended before its recorded size');
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

async function revalidateHeldFile(binding) {
  const after = await binding.handle.stat({ bigint: true });
  const named = await lstat(descriptorChild(binding.parent, binding.name), { bigint: true });
  if (!sameIdentity(binding.before, after) || !sameIdentity(binding.before, named)) throw new Error('held file or pathname identity changed');
}

async function secureStat(path, kind, mode, owner = currentUid()) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error(`${kind} path is unsafe`);
  const parts = path.split('/').filter(Boolean);
  let current = '/';
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const component = await lstat(current);
    if (component.isSymbolicLink() || (index < parts.length - 1 && !component.isDirectory())) throw new Error(`${kind} path contains an unsafe component`);
  }
  const snapshot = await lstat(path, { bigint: true });
  if (snapshot.isSymbolicLink() || (kind === 'directory' ? !snapshot.isDirectory() : !snapshot.isFile())) throw new Error(`${kind} is not a safe ${kind}`);
  if (snapshot.uid !== BigInt(owner)) throw new Error(`${kind} owner is unsafe`);
  if (mode !== undefined && (Number(snapshot.mode) & 0o7777) !== mode) throw new Error(`${kind} mode is unsafe`);
  if (kind === 'directory') {
    const canonical = await realpath(path);
    if (canonical !== path) throw new Error(`${kind} is not canonical`);
  } else if (snapshot.nlink !== 1n) {
    throw new Error(`${kind} link count is unsafe`);
  }
  return snapshot;
}

function parseCanonicalJson(bytes, label) {
  const text = bytes.toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text.endsWith('\n') ? text.slice(0, -1) : text); } catch (error) { throw new Error(`${label} is invalid JSON`, { cause: error }); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  const canonical = JSON.stringify(parsed);
  if (text !== canonical && text !== `${canonical}\n`) throw new Error(`${label} is not canonical JSON`);
  return Object.freeze({ text, value: parsed });
}

function validateLock(lock, packageVersion) {
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return false;
  const required = [
    'schemaVersion', 'packageVersion', 'imageRepository', 'imageDigest', 'baseImage',
    'baseImageDigest', 'dockerfileSha256', 'packageSet', 'rustConfig', 'nodeVersion',
    'executionDefinitionSha256', 'validationEvidenceSha256',
  ];
  const optional = ['installable', 'publisherSha256', 'imageId'];
  const keys = Object.keys(lock);
  if (keys.some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !keys.includes(key)) || keys.length < required.length || keys.length > required.length + optional.length) return false;
  if (lock.schemaVersion !== 1 || !Number.isInteger(lock.schemaVersion) || lock.packageVersion !== packageVersion || !VERSION.test(packageVersion) || lock.installable !== true) return false;
  const dockerRepository = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value !== value.toLowerCase() || /[@\s]/u.test(value)) return false;
    const components = value.split('/');
    const registryParts = components[0].split(':');
    if (registryParts.length > 2 || (registryParts.length === 2 && components.length < 2) || !DOCKER_REPOSITORY_COMPONENT.test(registryParts[0])) return false;
    if (registryParts.length === 2 && (!/^\d{1,5}$/u.test(registryParts[1]) || Number(registryParts[1]) < 1 || Number(registryParts[1]) > 65_535)) return false;
    return components.slice(1).every((component) => DOCKER_REPOSITORY_COMPONENT.test(component));
  };
  if (!dockerRepository(lock.imageRepository)) return false;
  for (const key of ['imageDigest', 'baseImageDigest', 'dockerfileSha256', 'executionDefinitionSha256', 'validationEvidenceSha256']) if (typeof lock[key] !== 'string' || !SHA256.test(lock[key]) || /^0+$/u.test(lock[key])) return false;
  if (typeof lock.baseImage !== 'string' || !lock.baseImage.endsWith(`@sha256:${lock.baseImageDigest}`)) return false;
  const baseSeparator = lock.baseImage.lastIndexOf('@');
  if (baseSeparator < 1 || !dockerRepository(lock.baseImage.slice(0, baseSeparator)) || !/^sha256:[0-9a-f]{64}$/u.test(lock.baseImage.slice(baseSeparator + 1))) return false;
  if (lock.rustConfig === null || typeof lock.rustConfig !== 'object' || Array.isArray(lock.rustConfig)
    || Object.keys(lock.rustConfig).sort().join(',') !== 'channel,llvmConfig,llvmMajor,version'
    || lock.rustConfig.llvmConfig !== '/usr/bin/llvm-config' || lock.rustConfig.channel !== 'stable'
    || typeof lock.rustConfig.version !== 'string' || !SEMVER.test(lock.rustConfig.version)
    || !Number.isInteger(lock.rustConfig.llvmMajor) || lock.rustConfig.llvmMajor < 1) return false;
  if (!Array.isArray(lock.packageSet) || lock.packageSet.length !== 7 || new Set(lock.packageSet).size !== 7
    || lock.packageSet.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 64)) return false;
  const requiredPackages = ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev', `libpolly-${lock.rustConfig.llvmMajor}-dev`];
  if (requiredPackages.some((item) => !lock.packageSet.includes(item))) return false;
  if (typeof lock.nodeVersion !== 'string' || !SEMVER.test(lock.nodeVersion) || Number.parseInt(lock.nodeVersion, 10) < 22) return false;
  for (const key of ['publisherSha256', 'imageId']) if (lock[key] !== undefined && (typeof lock[key] !== 'string' || !SHA256.test(lock[key]) || /^0+$/u.test(lock[key]))) return false;
  return true;
}

async function openSelectedDirectory(parent, name, ownerUid, device, mode, hooks) {
  const handle = await open(descriptorChild(parent, name), DIRECTORY_OPEN_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    const named = await lstat(descriptorChild(parent, name), { bigint: true });
    if (!before.isDirectory() || before.uid !== BigInt(ownerUid) || before.dev !== device
      || before.nlink < 1n || (Number(before.mode) & 0o7777) !== mode || !sameIdentity(before, named)) {
      throw new Error(`installed directory is unsafe: ${name}`);
    }
    const binding = { handle, before, parent, name };
    if (typeof hooks?.afterDirectoryOpen === 'function') await hooks.afterDirectoryOpen(Object.freeze({ name }));
    return binding;
  } catch (error) {
    let closeError;
    try {
      await (hooks?.closeHandle ?? ((value) => value.close()))(handle);
    } catch (cleanupError) {
      closeError = cleanupError;
    }
    throw mergeErrors(error, closeError, 'selected directory acquisition and descriptor cleanup both failed');
  }
}

async function openSelectedFile(parent, name, ownerUid, device, mode, maximumBytes, hooks) {
  const handle = await open(descriptorChild(parent, name), FILE_OPEN_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    const named = await lstat(descriptorChild(parent, name), { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(ownerUid) || before.dev !== device
      || before.nlink !== 1n || (Number(before.mode) & 0o7777) !== mode
      || before.size < 1n || before.size > BigInt(maximumBytes) || !sameIdentity(before, named)) {
      throw new Error(`installed file is unsafe: ${name}`);
    }
    const binding = { handle, before, parent, name };
    if (typeof hooks?.afterFileOpen === 'function') await hooks.afterFileOpen(Object.freeze({ name }));
    return binding;
  } catch (error) {
    let closeError;
    try {
      await (hooks?.closeHandle ?? ((value) => value.close()))(handle);
    } catch (cleanupError) {
      closeError = cleanupError;
    }
    throw mergeErrors(error, closeError, 'selected file acquisition and descriptor cleanup both failed');
  }
}

async function revalidateSelectedInstallation(context) {
  for (const file of context.files) await revalidateHeldFile(file);
  await revalidateDirectoryChain(context.directories);
  await context.rootAuthority.revalidate();
}

export async function withSelectedInstallation(options = {}, callback = async (installation) => installation) {
  const ownerUid = options.ownerUid ?? currentUid();
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('selected installation owner is invalid');
  if (options.installRoot === undefined) {
    const holdHome = options.withEffectiveHomeAuthority ?? withEffectiveHomeAuthority;
    return holdHome(
      { ...options.effectiveHomeOptions, ownerUid },
      async (authority) => withSelectedInstallation({
        ...options,
        ownerUid,
        installRoot: join(authority.path, '.local', 'lib', 'osi-image-builder'),
      }, callback),
    );
  }
  const installRoot = options.installRoot;
  let rootAuthority;
  const directories = [];
  const files = [];
  let resultValue;
  let operationError;
  const closeHandle = options.hooks?.closeHandle ?? ((handle) => handle.close());
  try {
    const holdRoot = options.holdDirectoryAuthority ?? holdDirectoryAuthority;
    rootAuthority = await holdRoot(installRoot, { ownerUid, finalAccess: 'read' });
    if (rootAuthority.exists !== true || typeof rootAuthority.executionPath !== 'string') {
      throw new Error('installation root is unavailable');
    }
    const root = {
      executionPath: rootAuthority.executionPath,
      before: await stat(rootAuthority.executionPath, { bigint: true }),
    };
    if (!root.before.isDirectory() || root.before.uid !== BigInt(ownerUid) || root.before.nlink < 1n
      || (Number(root.before.mode) & 0o7777) !== 0o700) throw new Error('installation root owner or mode is unsafe');
    const device = root.before.dev;
    const selectionFile = await openSelectedFile(root, 'selected.json', ownerUid, device, 0o600, MAX_JSON_BYTES, options.hooks);
    files.push(selectionFile);
    const selection = parseCanonicalJson(await readHeldBytes(selectionFile, MAX_JSON_BYTES), 'selected installation');
    const keys = ['executionDefinitionSha256', 'lockSha256', 'manifestSha256', 'packageVersion', 'publisherSha256'];
    if (Object.keys(selection.value).sort().join(',') !== keys.sort().join(',') || typeof selection.value.packageVersion !== 'string' || !VERSION.test(selection.value.packageVersion)) throw new Error('selected installation shape is invalid');
    for (const key of ['executionDefinitionSha256', 'lockSha256', 'manifestSha256', 'publisherSha256']) if (!SHA256.test(selection.value[key])) throw new Error('selected installation digest is invalid');
    const version = await openSelectedDirectory(root, selection.value.packageVersion, ownerUid, device, 0o555, options.hooks);
    directories.push(version);
    const manifestDirectory = await openSelectedDirectory(version, 'manifest', ownerUid, device, 0o555, options.hooks);
    directories.push(manifestDirectory);
    const binDirectory = await openSelectedDirectory(version, 'bin', ownerUid, device, 0o555, options.hooks);
    directories.push(binDirectory);
    const lockFile = await openSelectedFile(version, 'builder.lock.json', ownerUid, device, 0o600, MAX_JSON_BYTES, options.hooks);
    files.push(lockFile);
    const manifestFile = await openSelectedFile(manifestDirectory, 'targets.json', ownerUid, device, 0o444, MAX_JSON_BYTES, options.hooks);
    files.push(manifestFile);
    const publisherFile = await openSelectedFile(binDirectory, 'osi-image-publish', ownerUid, device, 0o555, 16 * 1024 * 1024, options.hooks);
    files.push(publisherFile);
    const lock = parseCanonicalJson(await readHeldBytes(lockFile, MAX_JSON_BYTES), 'builder lock');
    if (!validateLock(lock.value, selection.value.packageVersion)) throw new Error('generated builder lock is invalid');
    const manifest = parseCanonicalJson(await readHeldBytes(manifestFile, MAX_JSON_BYTES), 'target manifest');
    const publisherSha256 = await hashHeldFile(publisherFile, 16 * 1024 * 1024);
    if (createHash('sha256').update(lock.text).digest('hex') !== selection.value.lockSha256
      || createHash('sha256').update(manifest.text).digest('hex') !== selection.value.manifestSha256
      || publisherSha256 !== selection.value.publisherSha256
      || lock.value.publisherSha256 !== selection.value.publisherSha256
      || lock.value.executionDefinitionSha256 !== selection.value.executionDefinitionSha256) throw new Error('selected installation evidence does not match generated files');
    const context = { rootAuthority, directories, files };
    if (typeof options.hooks?.beforeFinalRevalidation === 'function') await options.hooks.beforeFinalRevalidation();
    await revalidateSelectedInstallation(context);
    const versionRoot = join(installRoot, selection.value.packageVersion);
    const installation = Object.freeze({
      versionRoot,
      lockPath: join(versionRoot, 'builder.lock.json'),
      publisherPath: join(versionRoot, 'bin', 'osi-image-publish'),
      lockText: lock.text,
      lock: lock.value,
      selection: selection.value,
      publisher: publisherFile.before,
      publisherSha256,
    });
    const output = await callback(installation, Object.freeze({ installRoot: root, publisherFile }));
    await revalidateSelectedInstallation(context);
    resultValue = output;
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  const cleanupFailures = [];
  try {
    await closeBindings(files, closeHandle);
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await closeBindings(directories, closeHandle);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (rootAuthority !== undefined) {
    try {
      await rootAuthority.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length === 1) cleanupError = cleanupFailures[0];
  if (cleanupFailures.length > 1) cleanupError = new AggregateError(cleanupFailures, 'selected installation descriptors could not be closed');
  const failure = mergeErrors(operationError, cleanupError, 'selected installation operation and descriptor cleanup both failed');
  if (failure !== undefined) {
    throw failure;
  }
  return resultValue;
}

export async function readSelectedInstallation(options = {}) {
  return withSelectedInstallation(options);
}

export async function runSelectedPublisherSelfTest(options = {}) {
  try {
    return await withSelectedInstallation(options, async (installation, held) => {
      const executable = `/proc/${process.pid}/fd/${held.publisherFile.handle.fd}`;
      const output = await execFile(executable, ['--self-test'], {
        env: FIXED_ENV,
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        shell: false,
      });
      let evidence;
      try { evidence = JSON.parse(String(output.stdout).trim()); } catch { evidence = null; }
      const exactShape = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)
        && Object.keys(evidence).sort().join(',') === 'available,mutationCount,published,quarantined,selfTest';
      if (!exactShape || evidence.available !== true || evidence.published !== false
        || evidence.quarantined !== false || evidence.selfTest !== true || evidence.mutationCount !== 0) {
        const provedNoMutation = exactShape && evidence.mutationCount === 0
          && evidence.published === false && evidence.quarantined === false;
        return Object.freeze({
          available: false,
          passed: false,
          code: 'PUBLISHER_SELF_TEST_FAILED',
          detail: 'installed publisher did not prove a zero-mutation self-test',
          mutation: provedNoMutation ? 'none' : 'unknown',
          sha256: installation.publisherSha256,
        });
      }
      return Object.freeze({
        available: true,
        passed: true,
        code: 'PUBLISHER_SELF_TEST_PASSED',
        detail: 'installed publisher self-test passed through its held identity',
        mutation: 'none',
        sha256: installation.publisherSha256,
      });
    });
  } catch (error) {
    return Object.freeze({
      available: false,
      passed: false,
      code: 'PUBLISHER_SELF_TEST_FAILED',
      detail: error instanceof Error ? error.message : String(error),
      mutation: 'unknown',
    });
  }
}

async function probeNode() {
  return checkNodeVersion(process.version).ok ? result(true, 'NODE_AVAILABLE', `Node.js ${process.version} is supported`) : unavailable('node', `Node.js ${process.version} is below 22.5.0`);
}

async function probeVersion(executable, name) {
  const output = await command(executable, ['--version']);
  return output.ok ? result(true, `${name.toUpperCase()}_AVAILABLE`, `${name} reported a version`) : unavailable(name, `${name} is unavailable: ${output.detail}`);
}

async function probeGitWithEnvironment(cwd, expectedSha, runCommand, env) {
  const keys = await runCommand(WORKSTATION_EXECUTABLES.git, ['-C', cwd, 'config', '--includes', '--null', '--name-only', '--list'], { env, maxBuffer: 64 * 1024 });
  const urls = await runCommand(WORKSTATION_EXECUTABLES.git, ['-C', cwd, 'config', '--includes', '--null', '--get-all', 'remote.origin.url'], { env, maxBuffer: 64 * 1024 });
  const refspecs = await runCommand(WORKSTATION_EXECUTABLES.git, ['-C', cwd, 'config', '--includes', '--null', '--get-all', 'remote.origin.fetch'], { env, maxBuffer: 64 * 1024 });
  if (!keys.ok || !urls.ok || !refspecs.ok || !keys.stdout.endsWith('\0') || !urls.stdout.endsWith('\0') || !refspecs.stdout.endsWith('\0')) return unavailable('gitsshorigin', 'effective Git origin configuration is unavailable');
  const keyNames = keys.stdout.slice(0, -1).split('\0').filter(Boolean);
  if (!validateGitConfigKeys(keyNames) || keyNames.filter((key) => key.toLowerCase() === 'remote.origin.url').length !== 1 || keyNames.filter((key) => key.toLowerCase() === 'remote.origin.fetch').length !== 1) return unavailable('gitsshorigin', 'effective Git origin configuration contains unsafe keys');
  const origin = urls.stdout.slice(0, -1).split('\0');
  const refspecsFound = refspecs.stdout.slice(0, -1).split('\0');
  if (origin.length !== 1 || !validateGitOrigin(origin[0]) || refspecsFound.length !== 1 || refspecsFound[0] !== CANONICAL_FETCH_REFSPEC) return unavailable('gitsshorigin', 'effective origin URL or fetch refspec is not approved');
  const remote = await runCommand(WORKSTATION_EXECUTABLES.git, ['-C', cwd, 'ls-remote', '--exit-code', '--heads', 'origin'], { env, timeout: 30_000, maxBuffer: 64 * 1024 });
  const remoteLines = remote.ok ? remote.stdout.trim().split('\n').filter(Boolean) : [];
  const advertised = remoteLines.map((line) => {
    const [sha, ref, ...extra] = line.split('\t');
    return {
      valid: SHA40.test(sha ?? '') && typeof ref === 'string' && ref.startsWith('refs/heads/')
        && !hasControl(ref) && !/\s/u.test(ref) && extra.length === 0,
      sha,
    };
  });
  const pinned = advertised.length > 0 && advertised.every((entry) => entry.valid)
    && advertised.some((entry) => entry.sha === expectedSha);
  return pinned ? result(true, 'GITSSHORIGIN_AVAILABLE', 'effective SSH origin advertised the requested pinned SHA noninteractively') : unavailable('gitsshorigin', `noninteractive SSH pinned-SHA query failed: ${remote.detail || 'requested SHA was not advertised'}`);
}

export async function probeGit(cwd, expectedSha, options = {}) {
  if (!isAbsolute(cwd)) return unavailable('gitsshorigin', 'worktree path is not absolute');
  if (typeof expectedSha !== 'string' || !SHA40.test(expectedSha)) return unavailable('gitsshorigin', 'requested pinned SHA is missing or invalid');
  const runCommand = options.runCommand ?? command;
  const withGitEnvironment = options.withGitEnvironment ?? (
    options.gitEnvironment === undefined
      ? async (callback) => withTrustedGitEnvironment(options.homeOptions ?? {}, callback)
      : async (callback) => callback(await options.gitEnvironment())
  );
  try {
    return await withGitEnvironment(async (env, commandAuthority) => {
      const revalidate = typeof commandAuthority?.revalidate === 'function'
        ? commandAuthority.revalidate
        : async () => undefined;
      const guardedRunCommand = async (...parameters) => {
        await revalidate();
        let commandResult;
        let commandError;
        try {
          commandResult = await runCommand(...parameters);
        } catch (error) {
          commandError = error;
        }
        await revalidate();
        if (commandError !== undefined) throw commandError;
        return commandResult;
      };
      return probeGitWithEnvironment(cwd, expectedSha, guardedRunCommand, env);
    });
  } catch (error) {
    return unavailable('gitsshorigin', `trusted Git environment is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function probeDockerDaemon() {
  const output = await command(WORKSTATION_EXECUTABLES.docker, ['version', '--format', '{{.Server.Version}}']);
  return output.ok && /^\S+$/u.test(output.stdout.trim()) ? result(true, 'DOCKER_AVAILABLE', 'Docker daemon reported a server version') : unavailable('docker', `Docker daemon is unavailable: ${output.detail || 'client-only Docker'}`);
}

async function probeSystemd() {
  const uid = currentUid();
  const env = Object.freeze({ ...FIXED_ENV, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` });
  try {
    const output = await execFile(WORKSTATION_EXECUTABLES.systemctl, ['--user', 'show', '--no-pager', '--property=Version'], { env, timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true, shell: false });
    return /^Version=\S+/mu.test(String(output.stdout)) ? result(true, 'USERSYSTEMD_AVAILABLE', 'user systemd reported a version') : unavailable('usersystemd', 'user systemd did not report a version');
  } catch (error) { return unavailable('usersystemd', `user systemd is unavailable: ${commandFailure(error)}`); }
}

async function probeHostCompiler() {
  const scratch = await mkdtemp(join(tmpdir(), 'osi-image-builder-host-probe-')).catch(() => null);
  if (scratch === null) return unavailable('gcclibcmake', 'host probe scratch could not be created');
  let outcome;
  try {
    const binary = join(scratch, 'probe-host');
    const source = join(PACKAGE_ROOT, 'installer', 'probe-host.c');
    const compile = await command(WORKSTATION_EXECUTABLES.gcc, ['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', binary]);
    if (!compile.ok) outcome = unavailable('gcclibcmake', `existing probe-host.c failed to compile: ${compile.detail}`);
    else {
      const run = await command(binary, []);
      if (!run.ok || !/HOST_PREREQUISITES_AVAILABLE/u.test(run.stdout)) outcome = unavailable('gcclibcmake', `existing probe-host.c failed: ${run.detail || 'invalid evidence'}`);
      else {
        const make = await command(WORKSTATION_EXECUTABLES.make, ['--version']);
        outcome = make.ok ? result(true, 'GCCLIBCMAKE_AVAILABLE', 'GCC/libc headers, probe-host.c, and make are available') : unavailable('gcclibcmake', `make is unavailable: ${make.detail}`);
      }
    }
  } catch (error) {
    outcome = unavailable('gcclibcmake', `host compiler probe failed: ${commandFailure(error)}`);
  }
  try { await rm(scratch, { recursive: true, force: true }); }
  catch { return result(false, 'GCCLIBCMAKE_CLEANUP_FAILED', 'host compiler probe cleanup could not be proven', 'unknown'); }
  return outcome;
}

async function probeNativeRenameat2() {
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number') return unavailable('renameat2', 'Linux renameat2 support is unavailable');
  const scratch = await mkdtemp(join(tmpdir(), 'osi-image-builder-renameat2-')).catch(() => null);
  if (scratch === null) return unavailable('renameat2', 'renameat2 probe scratch could not be created');
  let outcome;
  try {
    const binary = join(scratch, 'probe-renameat2');
    const compile = await command(WORKSTATION_EXECUTABLES.gcc, ['-std=c17', '-D_GNU_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', join(PACKAGE_ROOT, 'installer', 'probe-renameat2.c'), '-o', binary]);
    if (!compile.ok) outcome = unavailable('renameat2', `renameat2 probe compilation failed: ${compile.detail}`);
    else {
      const run = await command(binary, [scratch]);
      outcome = run.ok && /RENAME_NOREPLACE_AVAILABLE/u.test(run.stdout) ? result(true, 'RENAMEAT2_AVAILABLE', 'renameat2 no-replace semantics are available') : unavailable('renameat2', `renameat2 probe failed: ${run.detail || 'unsupported syscall'}`);
    }
  } catch (error) {
    outcome = unavailable('renameat2', `renameat2 probe failed: ${commandFailure(error)}`);
  }
  try { await rm(scratch, { recursive: true, force: true }); }
  catch { return result(false, 'RENAMEAT2_CLEANUP_FAILED', 'renameat2 probe cleanup could not be proven', 'unknown'); }
  return outcome;
}

async function probeSqlite() { return probeVersion(WORKSTATION_EXECUTABLES.sqlite3, 'sqlite3'); }

async function probeInstalledLockImage() {
  let installation;
  try { installation = await readSelectedInstallation(); } catch (error) { return unavailable('installedlockimage', `selected installation is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  const reference = `${installation.lock.imageRepository}@sha256:${installation.lock.imageDigest}`;
  const daemon = await probeDockerDaemon();
  if (!daemon.available) return unavailable('installedlockimage', daemon.detail);
  const image = await command(WORKSTATION_EXECUTABLES.docker, ['image', 'inspect', '--format', '{{json .RepoDigests}}', reference], { maxBuffer: 64 * 1024 });
  let digests;
  try { digests = JSON.parse(image.stdout); } catch { digests = null; }
  return image.ok && Array.isArray(digests) && digests.length === 1 && digests[0] === reference
    ? result(true, 'INSTALLEDLOCKIMAGE_AVAILABLE', 'selected generated lock and exact Docker RepoDigest are available')
    : unavailable('installedlockimage', 'generated builder image exact RepoDigest could not be verified');
}

async function probeApprovedRoot(env) {
  const root = env.OSI_IMAGE_BUILDER_APPROVED_ROOT_PATH;
  if (!isAbsolute(root ?? '')) return unavailable('approvedroot', 'approved root path is not absolute');
  try { await secureStat(root, 'directory'); return result(true, 'APPROVEDROOT_AVAILABLE', 'approved root is canonical and safe'); }
  catch (error) { return unavailable('approvedroot', `approved root is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function probeFreeDisk(env, readStatfs = statfs) {
  const outputRoot = env.OSI_IMAGE_BUILDER_APPROVED_ROOT_PATH;
  const stateRoot = env.OSI_IMAGE_BUILDER_STATE_ROOT_PATH;
  const configuredMinimum = env.OSI_IMAGE_BUILDER_DISK_MINIMUM_BYTES;
  const minimumBytes = typeof configuredMinimum === 'string' && /^\d+$/u.test(configuredMinimum)
    ? Number(configuredMinimum)
    : MINIMUM_FREE_BYTES;
  if (!isAbsolute(outputRoot ?? '') || !isAbsolute(stateRoot ?? '')
    || !Number.isSafeInteger(minimumBytes) || minimumBytes < MINIMUM_FREE_BYTES) {
    return unavailable('freedisk', 'approved output/state roots or configured disk floor are missing');
  }
  try {
    const [outputStats, stateStats] = await Promise.all([readStatfs(outputRoot), readStatfs(stateRoot)]);
    const outputFreeBytes = Number(outputStats.bavail) * Number(outputStats.bsize);
    const stateFreeBytes = Number(stateStats.bavail) * Number(stateStats.bsize);
    return Number.isSafeInteger(outputFreeBytes) && Number.isSafeInteger(stateFreeBytes)
      && outputFreeBytes >= minimumBytes && stateFreeBytes >= minimumBytes
      ? result(true, 'FREEDISK_AVAILABLE', `approved output and state roots have at least ${minimumBytes} free bytes`)
      : unavailable('freedisk', 'approved output or state root does not have enough free disk');
  } catch (error) { return unavailable('freedisk', `free disk could not be measured: ${commandFailure(error)}`); }
}

function realDependencies(env, cwd, pinnedSha) {
  return {
    node: probeNode,
    npm: () => probeVersion(WORKSTATION_EXECUTABLES.npm, 'npm'),
    gitSshOrigin: () => probeGit(cwd, pinnedSha),
    docker: probeDockerDaemon,
    userSystemd: probeSystemd,
    sqlite3: probeSqlite,
    gccLibcMake: probeHostCompiler,
    renameat2: probeNativeRenameat2,
    installedLockImage: probeInstalledLockImage,
    approvedRoot: () => probeApprovedRoot(env),
    freeDisk: () => probeFreeDisk(env),
  };
}

export async function probeWorkstation(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? PACKAGE_ROOT;
  const dependencies = options.dependencies ?? (options.mode === 'test'
    ? Object.fromEntries(PREREQUISITE_NAMES.map((name) => [name, unavailable(name, 'test mode did not execute host commands')]))
    : realDependencies(env, cwd, options.pinnedSha));
  const prerequisites = {};
  for (const name of PREREQUISITE_NAMES) {
    const candidate = dependencies[name];
    let item;
    try { item = typeof candidate === 'function' ? await candidate() : candidate; }
    catch (error) { item = unproven(name, `prerequisite adapter failed before returning mutation evidence: ${commandFailure(error)}`); }
    prerequisites[name] = item && typeof item === 'object' && typeof item.available === 'boolean'
      && (item.mutation === 'none' || item.mutation === 'unknown')
      && typeof item.code === 'string' && typeof item.detail === 'string'
      ? Object.freeze({ ...item })
      : unproven(name, 'prerequisite adapter returned evidence with unknown mutation state');
  }
  const failed = PREREQUISITE_NAMES.find((name) => prerequisites[name].available !== true);
  const mutation = PREREQUISITE_NAMES.some((name) => prerequisites[name].mutation !== 'none') ? 'unknown' : 'none';
  return Object.freeze({ available: failed === undefined && mutation === 'none', mutation, prerequisites: Object.freeze(prerequisites) });
}

export class ReleaseVerificationError extends Error {
  constructor(code, message) { super(message); this.name = 'ReleaseVerificationError'; this.code = code; }
}

function releaseFail(code, message) { throw new ReleaseVerificationError(code, message); }

const RELEASE_FILE_NAMES = Object.freeze(['manifest.json', 'builder.lock.json', 'image.img', 'sha256sums', 'verification.json']);

function validateReleaseDirectory(binding, ownerUid, device, label) {
  const snapshot = binding.before;
  if (!snapshot.isDirectory() || snapshot.uid !== BigInt(ownerUid) || snapshot.dev !== device
    || (Number(snapshot.mode) & 0o7777) !== 0o555) releaseFail('RELEASE_MUTABLE', `${label} is not an immutable owned directory`);
}

async function openReleaseFile(directory, name, targetId, maxImageBytes, hook, closeHandle) {
  let handle;
  try {
    handle = await open(descriptorChild(directory.handle, name), FILE_OPEN_FLAGS);
    const before = await handle.stat({ bigint: true });
    const named = await lstat(descriptorChild(directory.handle, name), { bigint: true });
    const maximum = name === 'image.img' ? maxImageBytes : MAX_JSON_BYTES;
    if (!before.isFile() || before.nlink !== 1n || before.uid !== directory.before.uid
      || before.dev !== directory.before.dev || (Number(before.mode) & 0o7777) !== 0o444
      || before.size < 1n || before.size > BigInt(maximum) || !sameIdentity(before, named)) {
      releaseFail('RELEASE_MUTABLE', `${targetId} release file is unsafe: ${name}`);
    }
    const binding = { handle, before, parent: directory.handle, name };
    if (typeof hook === 'function') await hook(Object.freeze({ targetId, name }));
    return binding;
  } catch (error) {
    let cleanupError;
    if (handle !== undefined) {
      try {
        await (closeHandle ?? ((value) => value.close()))(handle);
      } catch (closeError) {
        cleanupError = closeError;
      }
    }
    let operationError = error;
    if (!(error instanceof ReleaseVerificationError)) {
      operationError = error?.code === 'ENOENT'
        ? new ReleaseVerificationError('RELEASE_INCOMPLETE', `missing ${targetId} release file: ${name}`)
        : new ReleaseVerificationError('RELEASE_MUTABLE', `${targetId} release file could not be held safely: ${name}`);
    }
    throw mergeErrors(operationError, cleanupError, 'release file acquisition and descriptor cleanup both failed');
  }
}

async function revalidateRelease(release) {
  try {
    for (const file of release.files.values()) await revalidateHeldFile(file);
    await revalidateDirectoryChain([release.directory]);
  } catch {
    releaseFail('RELEASE_MUTABLE', `${release.targetId} release identity changed during verification`);
  }
}

async function openAndVerifyRelease(rootDirectory, targetId, maxImageBytes, hooks) {
  let directoryHandle;
  const files = new Map();
  try {
    directoryHandle = await open(descriptorChild(rootDirectory.handle, targetId), DIRECTORY_OPEN_FLAGS);
    const before = await directoryHandle.stat({ bigint: true });
    const named = await lstat(descriptorChild(rootDirectory.handle, targetId), { bigint: true });
    if (!sameIdentity(before, named)) releaseFail('RELEASE_MUTABLE', `${targetId} release directory identity is unsafe`);
    const directory = { handle: directoryHandle, before, parent: rootDirectory.handle, name: targetId };
    validateReleaseDirectory(directory, currentUid(), rootDirectory.before.dev, targetId);
    if (typeof hooks?.afterDirectoryOpen === 'function') await hooks.afterDirectoryOpen(Object.freeze({ targetId }));
    for (const name of RELEASE_FILE_NAMES) files.set(name, await openReleaseFile(
      directory,
      name,
      targetId,
      maxImageBytes,
      hooks?.afterFileOpen,
      hooks?.closeHandle,
    ));

    let manifest; let lock; let verification; let lockText; let checksum; let imageSha256;
    try {
      const lockBytes = await readHeldBytes(files.get('builder.lock.json'), MAX_JSON_BYTES);
      lockText = lockBytes.toString('utf8');
      manifest = JSON.parse((await readHeldBytes(files.get('manifest.json'), MAX_JSON_BYTES)).toString('utf8'));
      lock = JSON.parse(lockText.endsWith('\n') ? lockText.slice(0, -1) : lockText);
      verification = JSON.parse((await readHeldBytes(files.get('verification.json'), MAX_JSON_BYTES)).toString('utf8'));
      checksum = (await readHeldBytes(files.get('sha256sums'), MAX_JSON_BYTES)).toString('utf8');
      imageSha256 = await hashHeldFile(files.get('image.img'), maxImageBytes);
    } catch (error) {
      if (error instanceof ReleaseVerificationError) throw error;
      releaseFail('RELEASE_EVIDENCE_MISMATCH', `${targetId} release evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const lockSha256 = createHash('sha256').update(lockText).digest('hex');
    if (manifest?.schemaVersion !== 1 || manifest?.targetId !== targetId || manifest?.installedLockSha256 !== lockSha256 || manifest?.imageSha256 !== imageSha256
      || !validateLock(lock, lock?.packageVersion)
      || verification?.verified !== true || verification?.targetId !== targetId || verification?.imageSha256 !== imageSha256 || checksum !== `${imageSha256}  image.img\n`) releaseFail('RELEASE_EVIDENCE_MISMATCH', `${targetId} release evidence does not match its files`);
    const release = { targetId, directory, files, result: Object.freeze({ targetId, imageSha256, lockSha256, imageDigest: lock.imageDigest }) };
    await revalidateRelease(release);
    return release;
  } catch (error) {
    const cleanupFailures = [];
    try {
      await closeBindings([...files.values()], hooks?.closeHandle);
    } catch (closeError) {
      cleanupFailures.push(closeError);
    }
    if (directoryHandle !== undefined) {
      try {
        await (hooks?.closeHandle ?? ((value) => value.close()))(directoryHandle);
      } catch (closeError) {
        cleanupFailures.push(closeError);
      }
    }
    let operationError = error;
    if (!(error instanceof ReleaseVerificationError) && !(error instanceof AggregateError)) {
      operationError = error?.code === 'ENOENT'
        ? new ReleaseVerificationError('RELEASE_INCOMPLETE', `missing target release ${targetId}`)
        : new ReleaseVerificationError('RELEASE_MUTABLE', `${targetId} release directory could not be held safely`);
    }
    const cleanupError = cleanupFailures.length === 0
      ? undefined
      : cleanupFailures.length === 1
        ? cleanupFailures[0]
        : new AggregateError(cleanupFailures, 'release descriptors could not be closed');
    throw mergeErrors(operationError, cleanupError, 'release verification and descriptor cleanup both failed');
  }
}

export async function verifyReleasePair(root, options = {}) {
  const requestedMaximum = options.maxImageBytes;
  const maxImageBytes = Number.isSafeInteger(requestedMaximum) && requestedMaximum > 0
    ? Math.min(requestedMaximum, MAX_RELEASE_IMAGE_BYTES)
    : MAX_RELEASE_IMAGE_BYTES;
  let rootChain = [];
  const heldReleases = [];
  let resultValue;
  let operationError;
  const closeHandle = options.hooks?.closeHandle ?? ((handle) => handle.close());
  try {
    rootChain = await openAbsoluteDirectoryChain(root, closeHandle);
    const rootDirectory = rootChain.at(-1);
    if (rootDirectory.before.uid !== BigInt(currentUid()) || (Number(rootDirectory.before.mode) & 0o022) !== 0) releaseFail('RELEASE_MUTABLE', 'release root owner or mode is unsafe');
    for (const targetId of ['rpi-5', 'rpi-2']) heldReleases.push(await openAndVerifyRelease(rootDirectory, targetId, maxImageBytes, options.hooks));
    const releases = heldReleases.map((release) => release.result);
    if (releases[0].imageDigest !== releases[1].imageDigest) releaseFail('RELEASE_EVIDENCE_MISMATCH', 'target releases do not use the same generated image digest');
    if (releases[0].lockSha256 !== releases[1].lockSha256) releaseFail('RELEASE_EVIDENCE_MISMATCH', 'target releases do not use the same installed lock');
    for (const release of heldReleases) await revalidateRelease(release);
    try { await revalidateDirectoryChain(rootChain); } catch { releaseFail('RELEASE_MUTABLE', 'release root pathname chain changed during verification'); }
    resultValue = Object.freeze({ ok: true, mutation: 'none', releases: Object.freeze(releases) });
  } catch (error) {
    operationError = error;
  }
  const cleanupFailures = [];
  for (const release of heldReleases) {
    try {
      await closeBindings([...release.files.values()], closeHandle);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await closeBindings([{ handle: release.directory.handle }], closeHandle);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await closeBindings(rootChain, closeHandle);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (operationError !== undefined && !(operationError instanceof ReleaseVerificationError) && !(operationError instanceof AggregateError)) {
    operationError = operationError?.code === 'ENOENT'
      ? new ReleaseVerificationError('RELEASE_INCOMPLETE', 'release root or target is missing')
      : new ReleaseVerificationError('RELEASE_MUTABLE', `release root could not be held safely: ${operationError instanceof Error ? operationError.message : String(operationError)}`);
  }
  const cleanupError = cleanupFailures.length === 0
    ? undefined
    : cleanupFailures.length === 1
      ? cleanupFailures[0]
      : new AggregateError(cleanupFailures, 'release verification descriptors could not be closed');
  const failure = mergeErrors(operationError, cleanupError, 'release verification and descriptor cleanup both failed');
  if (failure !== undefined) throw failure;
  return resultValue;
}

async function main() {
  const testMode = process.argv.includes('--test');
  const output = await probeWorkstation({
    mode: testMode ? 'test' : 'real',
    cwd: process.env.OSI_IMAGE_BUILDER_WORKTREE ?? PACKAGE_ROOT,
    pinnedSha: process.env.OSI_IMAGE_BUILDER_PINNED_SHA,
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!testMode && output.available !== true) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
