import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const CLOSE_ON_EXEC = typeof constants.O_CLOEXEC === 'number' ? constants.O_CLOEXEC : 0;
const DIRECTORY_FLAGS = constants.O_RDONLY
  | constants.O_DIRECTORY
  | constants.O_NOFOLLOW
  | CLOSE_ON_EXEC;

function currentUid() {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('effective user ID is unavailable');
  return uid;
}

function safeComponent(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

function descriptorChild(parent, name) {
  if (!safeComponent(name)) throw new Error('directory authority contains an unsafe component');
  return `/proc/self/fd/${parent.fd}/${name}`;
}

function executionPath(handle) {
  return `/proc/${process.pid}/fd/${handle.fd}`;
}

function sameStableIdentity(left, right) {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev;
}

function sameCurrentIdentity(left, right) {
  return sameStableIdentity(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function trustedDirectory(stats, ownerUid) {
  if (!stats.isDirectory() || stats.nlink < 1n) return false;
  const mode = Number(stats.mode);
  if (stats.uid === 0n && (mode & 0o1000) !== 0) return true;
  return (stats.uid === 0n || stats.uid === BigInt(ownerUid)) && (mode & 0o022) === 0;
}

function validateFinalDirectory(stats, ownerUid, finalAccess) {
  if (!trustedDirectory(stats, ownerUid) || stats.uid !== BigInt(ownerUid)) {
    throw new Error('held directory final owner or mode is unsafe');
  }
  const ownerMode = Number(stats.mode) & 0o700;
  const required = finalAccess === 'write' ? 0o700 : 0o500;
  if ((ownerMode & required) !== required) {
    throw new Error(`held directory final ${finalAccess} access is unavailable`);
  }
}

async function openBinding(parent, name, path, ownerUid) {
  const handle = await open(descriptorChild(parent.handle, name), DIRECTORY_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    const named = await lstat(descriptorChild(parent.handle, name), { bigint: true });
    if (!sameCurrentIdentity(before, named) || !trustedDirectory(before, ownerUid)) {
      throw new Error(`directory authority component is unsafe: ${path}`);
    }
    return { handle, before, parent, name, path };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function closeBindings(bindings) {
  const results = await Promise.allSettled(
    [...bindings].reverse().map((binding) => binding.handle.close()),
  );
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'held directory descriptors could not be closed');
  }
}

function pathOverlap(left, right) {
  const contains = (from, to) => {
    const value = relative(from, to);
    return value === ''
      || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  };
  return contains(left, right) || contains(right, left);
}

function pathSuffix(from, to) {
  const value = relative(from, to);
  if (value === '') return [];
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  const components = value.split(sep);
  return components.every(safeComponent) ? components : undefined;
}

function componentPathOverlap(left, right) {
  const prefix = (shorter, longer) => shorter.every((component, index) => component === longer[index]);
  return prefix(left, right) || prefix(right, left);
}

function samePhysicalIdentity(left, right) {
  return left !== undefined
    && right !== undefined
    && left.dev === right.dev
    && left.ino === right.ino;
}

function validateTopologyAuthority(entry) {
  const authority = entry?.authority;
  if (
    !entry
    || typeof entry.name !== 'string'
    || typeof entry.path !== 'string'
    || !isAbsolute(entry.path)
    || resolve(entry.path) !== entry.path
    || !authority
    || typeof authority.exists !== 'boolean'
    || !Array.isArray(authority.identityChain)
    || authority.identityChain.length < 1
    || !Array.isArray(authority.unresolvedSuffix)
    || !authority.unresolvedSuffix.every(safeComponent)
    || (authority.exists && authority.unresolvedSuffix.length !== 0)
    || (!authority.exists && authority.unresolvedSuffix.length === 0)
  ) {
    throw new Error('held authority topology entry is invalid');
  }
  for (const identity of authority.identityChain) {
    if (
      !identity
      || typeof identity.path !== 'string'
      || !isAbsolute(identity.path)
      || resolve(identity.path) !== identity.path
    ) {
      throw new Error('held authority topology identity is invalid');
    }
  }
  const deepest = authority.identityChain.at(-1);
  const suffix = pathSuffix(deepest.path, entry.path);
  if (suffix === undefined || (!authority.exists && suffix.join('\0') !== authority.unresolvedSuffix.join('\0'))) {
    throw new Error('held authority topology unresolved suffix is invalid');
  }
}

function physicalAuthorityOverlap(left, right) {
  for (let leftIndex = 0; leftIndex < left.authority.identityChain.length; leftIndex += 1) {
    const leftIdentity = left.authority.identityChain[leftIndex];
    const leftSuffix = pathSuffix(leftIdentity.path, left.path);
    if (leftSuffix === undefined) continue;
    for (let rightIndex = 0; rightIndex < right.authority.identityChain.length; rightIndex += 1) {
      const rightIdentity = right.authority.identityChain[rightIndex];
      if (!samePhysicalIdentity(leftIdentity, rightIdentity)) continue;
      const rightSuffix = pathSuffix(rightIdentity.path, right.path);
      if (rightSuffix !== undefined && componentPathOverlap(leftSuffix, rightSuffix)) return true;
    }
  }
  return false;
}

export function assertHeldAuthoritiesDisjoint(entries) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new Error('held authority topology requires at least one entry');
  }
  for (let index = 0; index < entries.length; index += 1) {
    const left = entries[index];
    validateTopologyAuthority(left);
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const right = entries[otherIndex];
      validateTopologyAuthority(right);
      if (pathOverlap(left.path, right.path)) {
        throw new Error(`held authority lexical overlap between ${left.name} and ${right.name}`);
      }
      if (physicalAuthorityOverlap(left, right)) {
        throw new Error(`held authority physical overlap between ${left.name} and ${right.name}`);
      }
    }
  }
}

export async function holdDirectoryAuthority(path, options = {}) {
  if (
    typeof path !== 'string'
    || !isAbsolute(path)
    || path.includes('\0')
    || resolve(path) !== path
  ) {
    throw new Error('directory authority path must be canonical and absolute');
  }
  const ownerUid = options.ownerUid ?? currentUid();
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    throw new Error('directory authority owner is invalid');
  }
  const allowMissing = options.allowMissing === true;
  const finalAccess = options.finalAccess ?? 'read';
  if (finalAccess !== 'read' && finalAccess !== 'write') {
    throw new Error('directory authority final access policy is invalid');
  }
  const createMode = options.createMode ?? 0o700;
  if (!Number.isInteger(createMode) || createMode < 0 || createMode > 0o777) {
    throw new Error('directory authority creation mode is invalid');
  }

  const bindings = [];
  const missing = [];
  let closed = false;
  try {
    const rootHandle = await open('/', DIRECTORY_FLAGS);
    const rootStats = await rootHandle.stat({ bigint: true });
    if (!trustedDirectory(rootStats, ownerUid)) {
      await rootHandle.close();
      throw new Error('filesystem root authority is unsafe');
    }
    bindings.push({
      handle: rootHandle,
      before: rootStats,
      path: '/',
    });
    let parent = bindings[0];
    let currentPath = '';
    const components = path.split('/').filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      const name = components[index];
      currentPath = `${currentPath}/${name}`;
      try {
        const binding = await openBinding(parent, name, currentPath, ownerUid);
        bindings.push(binding);
        parent = binding;
      } catch (error) {
        if (allowMissing && error?.code === 'ENOENT') {
          missing.push(...components.slice(index));
          break;
        }
        throw error;
      }
    }
    if (missing.length === 0) {
      validateFinalDirectory(bindings.at(-1).before, ownerUid, finalAccess);
    }

    const revalidate = async () => {
      if (closed) throw new Error('held directory authority is closed');
      for (const binding of bindings) {
        const held = await binding.handle.stat({ bigint: true });
        if (!sameStableIdentity(binding.before, held) || !trustedDirectory(held, ownerUid)) {
          throw new Error(`held directory identity changed: ${binding.path}`);
        }
        if (binding.parent !== undefined) {
          const named = await lstat(
            descriptorChild(binding.parent.handle, binding.name),
            { bigint: true },
          );
          if (!sameCurrentIdentity(held, named)) {
            throw new Error(`held directory pathname identity changed: ${binding.path}`);
          }
        }
      }
      if (missing.length === 0) {
        validateFinalDirectory(bindings.at(-1).before, ownerUid, finalAccess);
      }
    };

    const authority = {
      path,
      ownerUid,
      get exists() {
        return missing.length === 0;
      },
      get executionPath() {
        return missing.length === 0 ? executionPath(bindings.at(-1).handle) : undefined;
      },
      get identityChain() {
        return Object.freeze(bindings.map((binding, index) => Object.freeze({
          path: binding.path,
          dev: binding.before.dev,
          ino: binding.before.ino,
          final: missing.length === 0 && index === bindings.length - 1,
        })));
      },
      get unresolvedSuffix() {
        return Object.freeze([...missing]);
      },
      ensure: async () => {
        await revalidate();
        while (missing.length > 0) {
          const name = missing[0];
          const parent = bindings.at(-1);
          const child = descriptorChild(parent.handle, name);
          try {
            await mkdir(child, { mode: createMode });
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
          }
          const childPath = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
          const binding = await openBinding(parent, name, childPath, ownerUid);
          bindings.push(binding);
          missing.shift();
        }
        validateFinalDirectory(bindings.at(-1).before, ownerUid, finalAccess);
        await revalidate();
      },
      sync: async () => {
        await revalidate();
        if (missing.length !== 0) throw new Error('cannot sync a missing directory authority');
        await bindings.at(-1).handle.sync();
      },
      revalidate,
      close: async () => {
        if (closed) return;
        await closeBindings(bindings);
        closed = true;
      },
    };
    await authority.revalidate();
    return Object.freeze(authority);
  } catch (error) {
    try {
      await closeBindings(bindings);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'directory authority acquisition and descriptor close both failed',
      );
    }
    throw error;
  }
}
