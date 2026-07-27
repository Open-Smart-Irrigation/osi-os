#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import Module, { createRequire, isBuiltin } from 'node:module';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKTREE = '/workdir';
const OPERATIONS = new Set(['copy-feed-config', 'verify-image', 'mirror-gui']);
const FIXED_PATHS = Object.freeze({
  feedSource: 'feeds.conf.default',
  feedDestination: 'openwrt/feeds.conf.default',
  feedStaging: '.osi-image-builder-feed-config-staging',
  guiSource: 'web/react-gui/build',
  guiDestination: 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui',
  guiStaging: '.osi-image-builder-gui-staging',
  imageDirectory: 'openwrt/bin/targets',
});
const PROC_FD = '/proc/self/fd';
const DIRECTORY_FLAGS = constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const RELATIVE_HELPER_START = 4;
const RELATIVE_HELPER_END = 13;
const ALLOWED_ROOTFS_BUILTINS = Object.freeze([
  'buffer',
  'crypto',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'net',
  'node:child_process',
  'node:crypto',
  'node:fs',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'zlib',
]);
function deniedFilesystemCapability() {
  throw new Error('rootfs Node module attempted to use a denied builder filesystem capability');
}
const ROOTFS_FILESYSTEM_CAPABILITY = Object.freeze(new Proxy(
  Object.freeze({ readFile: deniedFilesystemCapability }),
  {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) {
        throw new Error(
          `rootfs Node module requested a denied builder filesystem capability: ${String(property)}`,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  },
));
function deniedChildProcessCapability() {
  throw new Error('rootfs Node module attempted to use a denied builder process capability');
}
const ROOTFS_CHILD_PROCESS_CAPABILITY = Object.freeze({
  execFile: deniedChildProcessCapability,
});
const BUILTIN_CAPABILITY_STUBS = Object.freeze({
  'node:child_process': Object.freeze({
    packageName: 'osi-health-helper',
    parentRelativePath: 'osi-health-helper/index.js',
    value: ROOTFS_CHILD_PROCESS_CAPABILITY,
  }),
});
class NativeDatabaseInitializerStub {
  constructor() {
    throw new Error('the sqlite3 initializer stub cannot open a database');
  }
}
Object.freeze(NativeDatabaseInitializerStub.prototype);
Object.freeze(NativeDatabaseInitializerStub);
const SQLITE3_INITIALIZER_STUB = Object.freeze({
  Database: NativeDatabaseInitializerStub,
  OPEN_READONLY: 1,
  OPEN_READWRITE: 2,
  OPEN_CREATE: 4,
});
const NATIVE_DEPENDENCY_STUBS = Object.freeze({
  sqlite3: Object.freeze({
    packageName: 'osi-db-helper',
    value: SQLITE3_INITIALIZER_STUB,
  }),
});
const NODE_MODULES = Object.freeze([
  ['@grpc/grpc-js', '@grpc/grpc-js'],
  [
    '@chirpstack/chirpstack-api',
    '@chirpstack/chirpstack-api',
    '@chirpstack/chirpstack-api/api/application_grpc_pb',
  ],
  ['google-protobuf', 'google-protobuf'],
  ['protobufjs', 'protobufjs'],
  ['osi-chameleon-helper', 'osi-chameleon-helper'],
  ['osi-chirpstack-helper', 'osi-chirpstack-helper'],
  ['osi-cloud-http', 'osi-cloud-http'],
  ['osi-db-helper', 'osi-db-helper'],
  ['osi-dendro-helper', 'osi-dendro-helper'],
  ['osi-health-helper', 'osi-health-helper'],
  ['osi-history-helper', 'osi-history-helper'],
  ['osi-history-sync-helper', 'osi-history-sync-helper'],
  ['osi-lib', 'osi-lib'],
  ['osi-command-ledger', './osi-command-ledger'],
  ['osi-dendro-analytics', './osi-dendro-analytics'],
  ['osi-zone-env', './osi-zone-env'],
  ['osi-history-router', './osi-history-router'],
  ['osi-journal', './osi-journal'],
  ['osi-device-writer', './osi-device-writer'],
  ['osi-uc512-normalize', './osi-uc512-normalize'],
  ['osi-lsn50-normalize', './osi-lsn50-normalize'],
]);
const ROOTFS_BY_PROFILE = Object.freeze({
  'DEVICE_rpi-5': {
    targetId: 'rpi-5',
    path: 'openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx',
  },
  'DEVICE_rpi-2': {
    targetId: 'rpi-2',
    path: 'openwrt/build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx',
  },
});

function fail(message) {
  process.stderr.write(`osi-image-builder-tool: ${message}\n`);
  process.exitCode = 2;
}

function requireAbsoluteRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0')) throw new Error('operation root is not a canonical absolute path');
}

function confinedRootfsModulePath(nodeRed, path) {
  if (typeof path !== 'string') return false;
  const relativePath = relative(nodeRed, path).replaceAll('\\', '/');
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith('../')
    && !relativePath.startsWith('/');
}

// CommonJS has no per-require hook; verify-image is synchronous and restores both hooks.
function loadFixedRootfsEntrypoint({
  nodeRed,
  packageName,
  specifier,
  resolvedEntrypoint,
  rootfsRequire,
}) {
  const originalLoad = Module._load;
  const originalResolveFilename = Module._resolveFilename;
  const sealedResolveFilename = function sealedResolveFilename(
    request,
    parent,
    isMain,
    options,
  ) {
    if (isBuiltin(request)) {
      if (!ALLOWED_ROOTFS_BUILTINS.includes(request)) {
        throw new Error(`rootfs Node module requested an unapproved builder builtin: ${request}`);
      }
      return Reflect.apply(
        originalResolveFilename,
        Module,
        [request, parent, isMain, options],
      );
    }
    const resolved = Reflect.apply(
      originalResolveFilename,
      Module,
      [request, parent, isMain, options],
    );
    if (!confinedRootfsModulePath(nodeRed, resolved)) {
      throw new Error(`rootfs Node module dependency resolved outside the trusted rootfs: ${request}`);
    }
    return resolved;
  };
  const sealedLoad = function sealedLoad(request, parent, isMain) {
    const stub = Object.hasOwn(NATIVE_DEPENDENCY_STUBS, request)
      ? NATIVE_DEPENDENCY_STUBS[request]
      : undefined;
    if (stub !== undefined) {
      if (packageName !== stub.packageName || parent?.filename !== resolvedEntrypoint) {
        throw new Error(`rootfs Node module requested an unapproved native dependency stub: ${request}`);
      }
      return stub.value;
    }
    sealedResolveFilename(request, parent, isMain);
    if (request === 'fs' || request === 'node:fs') {
      return ROOTFS_FILESYSTEM_CAPABILITY;
    }
    const builtinStub = Object.hasOwn(BUILTIN_CAPABILITY_STUBS, request)
      ? BUILTIN_CAPABILITY_STUBS[request]
      : undefined;
    if (builtinStub !== undefined) {
      const parentRelativePath = typeof parent?.filename === 'string'
        ? relative(nodeRed, parent.filename).replaceAll('\\', '/')
        : '';
      if (
        packageName !== builtinStub.packageName
        || parentRelativePath !== builtinStub.parentRelativePath
      ) {
        throw new Error(`rootfs Node module requested an unapproved builder builtin: ${request}`);
      }
      return builtinStub.value;
    }
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };

  Module._resolveFilename = sealedResolveFilename;
  Module._load = sealedLoad;
  let exported;
  let failure;
  let failed = false;
  try {
    exported = rootfsRequire(specifier);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const loaderChanged = Module._load !== sealedLoad
    || Module._resolveFilename !== sealedResolveFilename;
  Module._load = originalLoad;
  Module._resolveFilename = originalResolveFilename;
  if (failed) throw failure;
  if (loaderChanged) {
    throw new Error(`rootfs Node module changed the sealed builder loader: ${packageName}`);
  }
  return exported;
}

function entryPath(directory, name = '') {
  return name.length === 0 ? `${PROC_FD}/${directory.fd}` : `${PROC_FD}/${directory.fd}/${name}`;
}

async function step(hooks, point, path) {
  await hooks?.onStep?.(point, path);
}

async function openRoot(root) {
  return open(root, DIRECTORY_FLAGS);
}

async function openDirectoryAt(parent, name, field, hooks) {
  const path = entryPath(parent, name);
  await step(hooks, 'before-directory-open', path);
  try { return await open(path, DIRECTORY_FLAGS); }
  catch (error) { if (error?.code === 'ELOOP') throw new Error(`${field} contains a symbolic link`, { cause: error });
    throw new Error(`${field} is not a stable directory or symbolic link`, { cause: error }); }
}

async function openFileAt(parent, name, field, hooks) {
  const path = entryPath(parent, name);
  await step(hooks, 'before-file-open', path);
  try { return await open(path, FILE_FLAGS); }
  catch (error) { if (error?.code === 'ELOOP') throw new Error(`${field} contains a symbolic link`, { cause: error });
    throw new Error(`${field} is not a stable regular file or symbolic link`, { cause: error }); }
}

async function openDirectoryChain(parent, relativePath, create, field, hooks) {
  const handles = [];
  let current = parent;
  try {
    for (const name of relativePath.split('/').filter(Boolean)) {
      let child;
      try { child = await openDirectoryAt(current, name, field, hooks); }
      catch (error) {
        if (!create || error?.cause?.code !== 'ENOENT') throw error;
        await step(hooks, 'before-directory-create', entryPath(current, name));
        await mkdir(entryPath(current, name));
        child = await openDirectoryAt(current, name, field, hooks);
      }
      handles.push(child);
      current = child;
    }
    return { handle: current, handles };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close();
    throw error;
  }
}

async function closeChain(chain) {
  for (const handle of [...chain.handles].reverse()) await handle.close();
}

async function hashHandle(handle) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest('hex');
}

async function hashFileAt(parent, name, field, hooks) {
  const handle = await openFileAt(parent, name, field, hooks);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${field} is not a regular file`);
    return { size: info.size, sha256: await hashHandle(handle) };
  } finally { await handle.close(); }
}

async function copyFileAt(sourceParent, sourceName, destinationParent, destinationName, field, hooks) {
  const source = await openFileAt(sourceParent, sourceName, `${field} source`, hooks);
  try {
    const sourceInfo = await source.stat();
    if (!sourceInfo.isFile()) throw new Error(`${field} source is not a regular file`);
    await step(hooks, 'before-destination-create', entryPath(destinationParent, destinationName));
    const destination = await open(entryPath(destinationParent, destinationName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let position = 0;
      while (position < sourceInfo.size) {
        const length = Math.min(buffer.length, sourceInfo.size - position);
        const result = await source.read(buffer, 0, length, position);
        if (result.bytesRead === 0) throw new Error(`${field} source ended during copy`);
        await destination.write(buffer, 0, result.bytesRead);
        position += result.bytesRead;
      }
    } finally { await destination.close(); }
  } finally { await source.close(); }
}

async function fileManifest(directory, relativePath = '', hooks) {
  const result = new Map();
  for (const entry of (await readdir(entryPath(directory), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const currentPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`source contains a symbolic link at ${currentPath}`);
    if (entry.isDirectory()) {
      const child = await openDirectoryAt(directory, entry.name, `source directory ${currentPath}`, hooks);
      try {
        for (const [file, metadata] of await fileManifest(child, currentPath, hooks)) result.set(file, metadata);
      } finally { await child.close(); }
    } else if (entry.isFile()) {
      const metadata = await hashFileAt(directory, entry.name, `source file ${currentPath}`, hooks);
      result.set(currentPath, metadata);
    } else {
      throw new Error(`source contains a non-regular path at ${currentPath}`);
    }
  }
  return result;
}

function manifestHash(manifest) {
  const serialized = [...manifest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => `${path}\0${value.size}\0${value.sha256}\n`).join('');
  return createHash('sha256').update(serialized).digest('hex');
}

function equalManifest(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, value] of left) {
    const other = right.get(path);
    if (!other || other.size !== value.size || other.sha256 !== value.sha256) return false;
  }
  return true;
}

async function copyManifest(source, destination, manifest, hooks) {
  for (const path of [...manifest.keys()].sort()) {
    const parts = path.split('/');
    const file = parts.pop();
    const sourceChain = await openDirectoryChain(source, parts.join('/'), false, `source ${path}`, hooks);
    try {
      const destinationChain = await openDirectoryChain(destination, parts.join('/'), true, `destination ${path}`, hooks);
      try { await copyFileAt(sourceChain.handle, file, destinationChain.handle, file, path, hooks); }
      finally { await closeChain(destinationChain); }
    } finally { await closeChain(sourceChain); }
  }
}

async function removeEntry(parent, name, hooks) {
  const path = entryPath(parent, name);
  let value;
  try { value = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  await step(hooks, 'before-remove', path);
  if (value.isSymbolicLink()) throw new Error(`cannot remove symbolic link: ${path}`);
  if (value.isFile()) { await unlink(path); return; }
  if (!value.isDirectory()) throw new Error(`cannot remove non-regular path ${path}`);
  const child = await openDirectoryAt(parent, name, 'removal directory', hooks);
  const identity = await child.stat();
  try {
    for (const entry of await readdir(entryPath(child), { withFileTypes: true })) await removeEntry(child, entry.name, hooks);
    const current = await lstat(path);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`directory changed during removal: ${path}`);
    await step(hooks, 'before-remove-directory', path);
    const stable = await lstat(path);
    if (!stable.isDirectory() || stable.dev !== identity.dev || stable.ino !== identity.ino) throw new Error(`directory changed before removal: ${path}`);
    await rmdir(path);
  } finally { await child.close(); }
}

async function removeUntrustedEntry(parent, name) {
  const path = entryPath(parent, name);
  let value;
  try { value = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (value.isSymbolicLink() || value.isFile()) { await unlink(path); return; }
  if (!value.isDirectory()) throw new Error(`cannot quarantine non-regular path ${path}`);
  for (let index = 0; index < 100; index += 1) {
    const quarantine = `${name}.quarantine${index === 0 ? '' : `-${index}`}`;
    try { await lstat(entryPath(parent, quarantine)); continue; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await rename(path, entryPath(parent, quarantine)); return; }
      catch (renameError) {
        if (renameError?.code === 'ENOENT') return;
        if (renameError?.code !== 'EEXIST') throw renameError;
      }
    }
  }
  throw new Error(`could not quarantine untrusted path ${path}`);
}

function sameIdentity(named, held, kind) {
  return named.dev === held.dev && named.ino === held.ino && (kind === 'directory' ? named.isDirectory() : named.isFile());
}

async function assertNamedIdentity(parent, name, held, kind, field) {
  const named = await lstat(entryPath(parent, name));
  const heldInfo = await held.stat();
  if (!sameIdentity(named, heldInfo, kind)) throw new Error(`${field} identity changed before publication`);
}

async function publishVerified(sourceParent, sourceName, sourceHandle, destinationParent, destinationName, kind, field, hooks, verify) {
  await assertNamedIdentity(sourceParent, sourceName, sourceHandle, kind, field);
  await step(hooks, 'before-rename', entryPath(sourceParent, sourceName));
  await assertNamedIdentity(sourceParent, sourceName, sourceHandle, kind, field);
  let renamed = false;
  try {
    await rename(entryPath(sourceParent, sourceName), entryPath(destinationParent, destinationName));
    renamed = true;
    await step(hooks, 'after-rename', entryPath(destinationParent, destinationName));
    const destination = kind === 'directory'
      ? await openDirectoryAt(destinationParent, destinationName, `${field} destination`, hooks)
      : await openFileAt(destinationParent, destinationName, `${field} destination`, hooks);
    try {
      const publishedInfo = await destination.stat();
      const sourceInfo = await sourceHandle.stat();
      if (!sameIdentity(publishedInfo, sourceInfo, kind)) throw new Error(`${field} destination identity does not match verified staging`);
      const result = await verify(destination);
      await assertNamedIdentity(destinationParent, destinationName, destination, kind, field);
      return result;
    } finally { await destination.close(); }
  } catch (error) {
    if (renamed) {
      try { await removeUntrustedEntry(destinationParent, destinationName); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `${field} publication failed and untrusted destination cleanup failed`); }
    }
    throw error;
  }
}

async function copyFeedConfig(root, hooks) {
  const rootHandle = await openRoot(root);
  let openwrt;
  try {
    openwrt = await openDirectoryChain(rootHandle, 'openwrt', true, 'OpenWrt directory', hooks);
    const source = await hashFileAt(rootHandle, FIXED_PATHS.feedSource, 'feed configuration source', hooks);
    await removeUntrustedEntry(rootHandle, FIXED_PATHS.feedStaging);
    await copyFileAt(rootHandle, FIXED_PATHS.feedSource, rootHandle, FIXED_PATHS.feedStaging, 'feed configuration', hooks);
    const staging = await openFileAt(rootHandle, FIXED_PATHS.feedStaging, 'feed configuration staging', hooks);
    try {
      const stagingInfo = await staging.stat();
      const staged = { size: stagingInfo.size, sha256: await hashHandle(staging) };
      if (source.sha256 !== staged.sha256 || source.size !== staged.size) throw new Error('feed configuration hash changed during staging');
      await removeEntry(openwrt.handle, 'feeds.conf.default', hooks);
      await publishVerified(rootHandle, FIXED_PATHS.feedStaging, staging, openwrt.handle, 'feeds.conf.default', 'file', 'feed configuration', hooks, async (destination) => {
        const destinationInfo = await destination.stat();
        const destinationHash = await hashHandle(destination);
        if (source.sha256 !== destinationHash || source.size !== destinationInfo.size) throw new Error('feed configuration hash changed during publication');
      });
    } finally { await staging.close(); }
    return { operation: 'copy-feed-config', source: FIXED_PATHS.feedSource, destination: FIXED_PATHS.feedDestination, sha256: source.sha256 };
  } finally { if (openwrt) await closeChain(openwrt); await rootHandle.close(); }
}

async function mirrorGui(root, hooks) {
  const rootHandle = await openRoot(root);
  let source;
  let destinationParent;
  try {
    source = await openDirectoryChain(rootHandle, FIXED_PATHS.guiSource, false, 'GUI source', hooks);
    destinationParent = await openDirectoryChain(rootHandle, 'feeds/chirpstack-openwrt-feed/apps/node-red/files', true, 'GUI destination parent', hooks);
    const sourceManifest = await fileManifest(source.handle, '', hooks);
    if (sourceManifest.size === 0) throw new Error('GUI build output contains no regular files');
    await removeUntrustedEntry(rootHandle, FIXED_PATHS.guiStaging);
    await mkdir(entryPath(rootHandle, FIXED_PATHS.guiStaging));
    const staging = await openDirectoryAt(rootHandle, FIXED_PATHS.guiStaging, 'GUI staging', hooks);
    try {
      await copyManifest(source.handle, staging, sourceManifest, hooks);
      const stagedManifest = await fileManifest(staging, '', hooks);
      if (!equalManifest(sourceManifest, stagedManifest)) throw new Error('GUI staging manifest does not match source');
      await removeEntry(destinationParent.handle, 'gui', hooks);
      await publishVerified(rootHandle, FIXED_PATHS.guiStaging, staging, destinationParent.handle, 'gui', 'directory', 'GUI staging', hooks, async (destination) => {
        const destinationManifest = await fileManifest(destination, '', hooks);
        if (!equalManifest(sourceManifest, destinationManifest)) throw new Error('GUI destination manifest does not match source');
      });
    } finally { await staging.close(); }
    return { operation: 'mirror-gui', source: FIXED_PATHS.guiSource, destination: FIXED_PATHS.guiDestination, fileCount: sourceManifest.size, manifestSha256: manifestHash(sourceManifest) };
  } finally { if (destinationParent) await closeChain(destinationParent); if (source) await closeChain(source); await rootHandle.close(); }
}

async function verifyImage(root, hooks) {
  const rootHandle = await openRoot(root);
  let targetDirectory;
  try {
    targetDirectory = await openDirectoryChain(rootHandle, FIXED_PATHS.imageDirectory, false, 'OpenWrt target directory', hooks);
    const candidates = [];
    for (const platform of await readdir(entryPath(targetDirectory.handle), { withFileTypes: true })) {
      if (platform.isSymbolicLink()) throw new Error(`image platform contains a symbolic link: ${platform.name}`);
      if (!platform.isDirectory()) continue;
      const platformHandle = await openDirectoryAt(targetDirectory.handle, platform.name, 'image platform', hooks);
      try {
        for (const profile of await readdir(entryPath(platformHandle), { withFileTypes: true })) {
          if (profile.isSymbolicLink()) throw new Error(`image profile contains a symbolic link: ${profile.name}`);
          if (!profile.isDirectory()) continue;
          const profileHandle = await openDirectoryAt(platformHandle, profile.name, 'image profile', hooks);
          try {
            for (const file of await readdir(entryPath(profileHandle), { withFileTypes: true })) {
              if (file.isSymbolicLink()) throw new Error(`image artifact contains a symbolic link: ${file.name}`);
              if (file.isFile() && /\.(?:img|img\.gz)$/u.test(file.name)) candidates.push({ platform: platform.name, profile: profile.name, name: file.name });
            }
          } finally { await profileHandle.close(); }
        }
      } finally { await platformHandle.close(); }
    }
    if (candidates.length !== 1) throw new Error(`expected exactly one firmware image, found ${candidates.length}`);
    const candidate = candidates[0];
    const profile = await openDirectoryChain(targetDirectory.handle, `${candidate.platform}/${candidate.profile}`, false, 'firmware image profile', hooks);
    try {
      const image = await openFileAt(profile.handle, candidate.name, 'firmware image', hooks);
      try {
        const info = await image.stat();
        if (!info.isFile() || info.size < 64 * 1024 * 1024) throw new Error('firmware image is missing or below the 64 MiB minimum');
        const openwrt = await openDirectoryAt(rootHandle, 'openwrt', 'OpenWrt directory', hooks);
        const config = await openFileAt(openwrt, '.config', 'OpenWrt config', hooks);
        let rootfs;
        try {
          const contents = await config.readFile('utf8');
          const profiles = Object.entries(ROOTFS_BY_PROFILE).filter(
            ([profile]) => contents.includes(`CONFIG_TARGET_PROFILE="${profile}"`),
          );
          if (profiles.length !== 1) throw new Error('active target profile is not an exact trusted Node resolution target');
          rootfs = profiles[0][1];
        } finally {
          await config.close();
          await openwrt.close();
        }
        const nodeRed = `${root}/${rootfs.path}/usr/share/node-red`;
        const require = createRequire(`${nodeRed}/__osi_verification__.cjs`);
        const nodeResolution = NODE_MODULES.map((
          [packageName, specifier, loadSpecifier = specifier],
          index,
        ) => {
          const resolved = require.resolve(loadSpecifier);
          const exported = loadFixedRootfsEntrypoint({
            nodeRed,
            packageName,
            specifier: loadSpecifier,
            resolvedEntrypoint: resolved,
            rootfsRequire: require,
          });
          const actualRelativePath = relative(nodeRed, resolved).replaceAll('\\', '/');
          if (actualRelativePath.startsWith('../') || actualRelativePath.startsWith('/')) {
            throw new Error(`resolved Node module escaped the trusted rootfs base: ${packageName}`);
          }
          const directRoot = `${packageName}/`;
          const nodeModulesRoot = `node_modules/${packageName}/`;
          const resolvedRelativePath = index >= RELATIVE_HELPER_START
            && index < RELATIVE_HELPER_END
            && actualRelativePath.startsWith(directRoot)
            ? `${nodeModulesRoot}${actualRelativePath.slice(directRoot.length)}`
            : actualRelativePath;
          const expectedRoot = specifier.startsWith('./') ? directRoot : nodeModulesRoot;
          if (!resolvedRelativePath.startsWith(expectedRoot)) {
            throw new Error(`resolved Node module changed package identity: ${packageName}`);
          }
          const exportType = typeof exported === 'function'
            ? 'function'
            : exported !== null && typeof exported === 'object'
              ? 'object'
              : 'incompatible';
          return { packageName, specifier, resolvedRelativePath, exportType };
        });
        return {
          operation: 'verify-image',
          targetId: rootfs.targetId,
          relativePath: `openwrt/bin/targets/${candidate.platform}/${candidate.profile}/${candidate.name}`,
          size: info.size,
          sha256: await hashHandle(image),
          nodeResolution,
        };
      } finally { await image.close(); }
    } finally { await closeChain(profile); }
  } finally { if (targetDirectory) await closeChain(targetDirectory); await rootHandle.close(); }
}

export function createOperationHandlersForTesting(root, hooks = {}) {
  requireAbsoluteRoot(root);
  return Object.freeze({ copyFeedConfig: () => copyFeedConfig(root, hooks), mirrorGui: () => mirrorGui(root, hooks), verifyImage: () => verifyImage(root, hooks) });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !OPERATIONS.has(args[0])) { fail('exactly one trusted operation name is required'); return; }
  try {
    const handlers = createOperationHandlersForTesting(WORKTREE);
    const result = args[0] === 'copy-feed-config' ? await handlers.copyFeedConfig() : args[0] === 'mirror-gui' ? await handlers.mirrorGui() : await handlers.verifyImage();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
