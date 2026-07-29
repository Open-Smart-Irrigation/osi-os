import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_PASSWD_BYTES = 8 * 1024;
const CLOSE_ON_EXEC = typeof fsConstants.O_CLOEXEC === 'number' ? fsConstants.O_CLOEXEC : 0;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | CLOSE_ON_EXEC;
const PASSWD_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
});

function effectiveUid() {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('effective user ID is unavailable');
  return uid;
}

async function defaultPasswdLookup(uid) {
  const output = await execFile('/usr/bin/getent', ['passwd', String(uid)], {
    env: PASSWD_ENV,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: MAX_PASSWD_BYTES,
    windowsHide: true,
    shell: false,
  });
  return String(output.stdout);
}

function sameDirectoryIdentity(left, right) {
  return left.isDirectory() && right.isDirectory()
    && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink
    && left.uid === right.uid && left.gid === right.gid;
}

function safeComponent(value) {
  return value.length > 0 && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function childPath(parent, name) {
  if (!safeComponent(name)) throw new Error('effective-user home contains an unsafe path component');
  return `/proc/self/fd/${parent.fd}/${name}`;
}

function heldChildPath(parent, components) {
  if (!Array.isArray(components) || components.some((component) => !safeComponent(component))) {
    throw new Error('effective-user home child path contains an unsafe component');
  }
  return [`/proc/${process.pid}/fd/${parent.fd}`, ...components].join('/');
}

function isUnsafeAncestor(stats, ownerUid) {
  const mode = Number(stats.mode);
  if (stats.uid === 0n && (mode & 0o1000) !== 0) return false;
  if (stats.uid !== 0n && stats.uid !== BigInt(ownerUid)) return true;
  return (mode & 0o022) !== 0;
}

function mergeErrors(operationError, cleanupError, message) {
  if (operationError === undefined) return cleanupError;
  if (cleanupError === undefined) return operationError;
  return new AggregateError([operationError, cleanupError], message);
}

async function openDirectoryChain(path, closeHandle = (handle) => handle.close()) {
  const bindings = [];
  try {
    const root = await open('/', DIRECTORY_FLAGS);
    const rootStats = await root.stat({ bigint: true });
    if (!rootStats.isDirectory()) throw new Error('filesystem root is not a directory');
    bindings.push({ handle: root, before: rootStats });
    let parent = root;
    for (const name of path.split('/').filter(Boolean)) {
      const handle = await open(childPath(parent, name), DIRECTORY_FLAGS);
      const before = await handle.stat({ bigint: true });
      const named = await lstat(childPath(parent, name), { bigint: true });
      if (!sameDirectoryIdentity(before, named)) {
        let closeError;
        try {
          await closeHandle(handle);
        } catch (error) {
          closeError = error;
        }
        throw mergeErrors(
          new Error('effective-user home path contains an unsafe component'),
          closeError,
          'effective-user home acquisition and descriptor cleanup both failed',
        );
      }
      bindings.push({ handle, before, parent, name });
      parent = handle;
    }
    return bindings;
  } catch (error) {
    let cleanupError;
    try {
      await closeDirectoryChain(bindings, closeHandle);
    } catch (closeError) {
      cleanupError = closeError;
    }
    throw mergeErrors(error, cleanupError, 'effective-user home acquisition and descriptor cleanup both failed');
  }
}

async function revalidateDirectoryChain(bindings) {
  for (const binding of bindings) {
    const held = await binding.handle.stat({ bigint: true });
    if (!sameDirectoryIdentity(binding.before, held)) throw new Error('effective-user home directory identity changed');
    if (binding.parent !== undefined) {
      const named = await lstat(childPath(binding.parent, binding.name), { bigint: true });
      if (!sameDirectoryIdentity(binding.before, named)) throw new Error('effective-user home pathname identity changed');
    }
  }
}

async function closeDirectoryChain(bindings, closeHandle = (handle) => handle.close()) {
  const results = await Promise.allSettled(
    [...bindings].reverse().map(({ handle }) => closeHandle(handle)),
  );
  const failures = results
    .filter((item) => item.status === 'rejected')
    .map((item) => item.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'effective-user home descriptors could not be closed');
  }
}

export async function withEffectiveHomeAuthority(options = {}, callback) {
  if (typeof callback !== 'function') throw new TypeError('effective-user home authority callback is required');
  const ownerUid = options.ownerUid ?? effectiveUid();
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('effective user ID is invalid');
  const lookupPasswd = options.lookupPasswd ?? defaultPasswdLookup;
  const evidence = await lookupPasswd(ownerUid);
  if (typeof evidence !== 'string' || Buffer.byteLength(evidence, 'utf8') < 2
    || Buffer.byteLength(evidence, 'utf8') > MAX_PASSWD_BYTES
    || !evidence.endsWith('\n') || evidence.indexOf('\n') !== evidence.length - 1 || evidence.includes('\r')) {
    throw new Error('effective-user passwd evidence must be exactly one bounded line');
  }
  const fields = evidence.slice(0, -1).split(':');
  if (fields.length !== 7 || fields[2] !== String(ownerUid)) {
    throw new Error('effective-user passwd evidence does not match the effective UID');
  }
  const home = fields[5];
  if (!isAbsolute(home) || home.includes('\0') || /[\u0000-\u001f\u007f]/u.test(home) || resolve(home) !== home) {
    throw new Error('effective-user home is not a canonical absolute path');
  }
  let chain = [];
  let result;
  let operationError;
  const closeHandle = options.closeHandle ?? ((handle) => handle.close());
  try {
    chain = await openDirectoryChain(home, closeHandle);
    const directory = chain.at(-1);
    if (chain.slice(0, -1).some((binding) => (
      !binding.before.isDirectory()
      || binding.before.nlink < 1n
      || isUnsafeAncestor(binding.before, ownerUid)
    ))) {
      throw new Error('effective-user home ancestor ownership or mode is unsafe');
    }
    if (directory === undefined || directory.before.uid !== BigInt(ownerUid)
      || directory.before.nlink < 1n || (Number(directory.before.mode) & 0o022) !== 0) {
      throw new Error('effective-user home owner or mode is unsafe');
    }
    await revalidateDirectoryChain(chain);
    const authority = Object.freeze({
      path: home,
      ownerUid,
      executionPath: heldChildPath(directory.handle, []),
      childPath: (...components) => heldChildPath(directory.handle, components),
      revalidate: () => revalidateDirectoryChain(chain),
    });
    try {
      result = await callback(authority);
    } catch (error) {
      operationError = error;
    }
    try {
      await revalidateDirectoryChain(chain);
    } catch (error) {
      operationError = mergeErrors(operationError, error, 'effective-user home operation and final revalidation both failed');
    }
  } catch (error) {
    operationError = mergeErrors(operationError, error, 'effective-user home operation failed during acquisition');
  }
  let cleanupError;
  try {
    await closeDirectoryChain(chain, closeHandle);
  } catch (error) {
    cleanupError = error;
  }
  const failure = mergeErrors(operationError, cleanupError, 'effective-user home operation and descriptor cleanup both failed');
  if (failure !== undefined) {
    throw failure;
  }
  return result;
}

export async function resolveEffectiveHome(options = {}) {
  return withEffectiveHomeAuthority(options, async (authority) => authority.path);
}
