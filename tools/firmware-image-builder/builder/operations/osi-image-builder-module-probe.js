#!/usr/bin/env node

import Module, { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, normalize, relative } from 'node:path';
import { runInThisContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROBE_PROGRAM = fileURLToPath(import.meta.url);
const ORIGINAL_SET_IMMEDIATE = setImmediate;
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
const RELATIVE_HELPER_START = 4;
const RELATIVE_HELPER_END = 13;
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
const ORIGINAL_GET_BUILTIN_MODULE = process.getBuiltinModule.bind(process);

function sealedGetBuiltinModule(request) {
  if (typeof request !== 'string' || !ALLOWED_ROOTFS_BUILTINS.includes(request)) {
    throw new Error(`rootfs Node module requested an unapproved builder builtin: ${request}`);
  }
  if (request === 'fs' || request === 'node:fs') {
    return ROOTFS_FILESYSTEM_CAPABILITY;
  }
  if (request === 'node:child_process') {
    return ROOTFS_CHILD_PROCESS_CAPABILITY;
  }
  return ORIGINAL_GET_BUILTIN_MODULE(request);
}
Object.freeze(sealedGetBuiltinModule);

function fail(message) {
  process.stderr.write(`osi-image-builder-module-probe: ${message}\n`);
  process.exitCode = 2;
}

function requireCanonicalAbsolutePath(path, field) {
  if (
    typeof path !== 'string'
    || !isAbsolute(path)
    || normalize(path) !== path
    || path.includes('\0')
  ) {
    throw new Error(`${field} is not one canonical absolute path`);
  }
}

function assertPermissionBoundary(nodeRed) {
  const expectedExecArgv = [
    '--experimental-vm-modules',
    '--permission',
    `--allow-fs-read=${PROBE_PROGRAM}`,
    `--allow-fs-read=${nodeRed}`,
  ];
  if (JSON.stringify(process.execArgv) !== JSON.stringify(expectedExecArgv)) {
    throw new Error('probe process permission arguments changed');
  }
  if (
    !process.permission
    || process.permission.has('fs.write')
    || process.permission.has('child')
    || process.permission.has('worker')
    || process.permission.has('wasi')
    || process.permission.has('addons')
    || !process.permission.has('fs.read', PROBE_PROGRAM)
    || !process.permission.has('fs.read', nodeRed)
  ) {
    throw new Error('probe process permissions are not read-only and fail-closed');
  }
}

function sealProcessBuiltinAccess() {
  Object.defineProperty(process, 'getBuiltinModule', {
    value: sealedGetBuiltinModule,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');
  if (
    descriptor?.value !== sealedGetBuiltinModule
    || descriptor.writable !== false
    || descriptor.enumerable !== true
    || descriptor.configurable !== false
  ) {
    throw new Error('probe process builtin access is not sealed');
  }
}

function confinedRootfsModulePath(nodeRed, path) {
  if (typeof path !== 'string') return false;
  const relativePath = relative(nodeRed, path).replaceAll('\\', '/');
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith('../')
    && !relativePath.startsWith('/');
}

const DYNAMIC_IMPORT_VIOLATIONS = [];

function recordDynamicImportViolation(specifier) {
  const violation = new Error(
    `rootfs Node module requested an unapproved builder ESM builtin: ${specifier}`,
  );
  DYNAMIC_IMPORT_VIOLATIONS.push(violation);
  return violation;
}

function samePropertyDescriptor(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.value === right.value
    && left.writable === right.writable
    && left.get === right.get
    && left.set === right.set
    && left.enumerable === right.enumerable
    && left.configurable === right.configurable;
}

function sameObjectState(target, snapshot) {
  if (Object.getPrototypeOf(target) !== snapshot.prototype) return false;
  const currentKeys = Reflect.ownKeys(target);
  const snapshotKeys = Reflect.ownKeys(snapshot.descriptors);
  if (currentKeys.length !== snapshotKeys.length) return false;
  return snapshotKeys.every((key) => samePropertyDescriptor(
    Object.getOwnPropertyDescriptor(target, key),
    snapshot.descriptors[key],
  ));
}

function snapshotObjectState(target) {
  return {
    prototype: Object.getPrototypeOf(target),
    descriptors: Object.getOwnPropertyDescriptors(target),
  };
}

function restoreObjectState(target, snapshot, field) {
  if (Object.getPrototypeOf(target) !== snapshot.prototype
    && !Reflect.setPrototypeOf(target, snapshot.prototype)) {
    throw new Error(`could not restore ${field} prototype`);
  }
  for (const key of Reflect.ownKeys(target)) {
    if (Object.hasOwn(snapshot.descriptors, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor?.configurable !== true || !Reflect.deleteProperty(target, key)) {
      throw new Error(`could not restore ${field} entry: ${String(key)}`);
    }
  }
  for (const key of Reflect.ownKeys(snapshot.descriptors)) {
    const descriptor = snapshot.descriptors[key];
    if (descriptor === undefined) {
      throw new Error(`could not restore ${field} entry: ${String(key)}`);
    }
    const current = Object.getOwnPropertyDescriptor(target, key);
    if (!samePropertyDescriptor(current, descriptor)
      && !Reflect.defineProperty(target, key, descriptor)) {
      throw new Error(`could not restore ${field} entry: ${String(key)}`);
    }
  }
  if (!sameObjectState(target, snapshot)) {
    throw new Error(`could not verify restored ${field} state`);
  }
}

function snapshotModuleLoaderState() {
  return {
    moduleState: snapshotObjectState(Module),
    modulePrototypeState: snapshotObjectState(Module.prototype),
    extensions: Module._extensions,
    extensionsState: snapshotObjectState(Module._extensions),
    cache: Module._cache,
    cacheState: snapshotObjectState(Module._cache),
  };
}

function descriptorMatchesWithValue(target, snapshot, key, expectedValue) {
  const current = Object.getOwnPropertyDescriptor(target, key);
  const original = snapshot.descriptors[key];
  return current !== undefined
    && original !== undefined
    && current.value === expectedValue
    && current.writable === original.writable
    && current.enumerable === original.enumerable
    && current.configurable === original.configurable;
}

function cacheContentsChanged(snapshot) {
  if (Module._cache !== snapshot.cache
    || Object.getPrototypeOf(Module._cache) !== snapshot.cacheState.prototype) {
    return true;
  }
  for (const key of Reflect.ownKeys(snapshot.cacheState.descriptors)) {
    if (!samePropertyDescriptor(
      Object.getOwnPropertyDescriptor(Module._cache, key),
      snapshot.cacheState.descriptors[key],
    )) {
      return true;
    }
  }
  return false;
}

function moduleSurfaceChanged(
  snapshot,
  sealedLoad,
  sealedResolveFilename,
  sealedCompile,
) {
  if (Object.getPrototypeOf(Module) !== snapshot.moduleState.prototype
    || Object.getPrototypeOf(Module.prototype) !== snapshot.modulePrototypeState.prototype) {
    return true;
  }
  const moduleKeys = Reflect.ownKeys(Module);
  const originalModuleKeys = Reflect.ownKeys(snapshot.moduleState.descriptors);
  if (moduleKeys.length !== originalModuleKeys.length
    || !originalModuleKeys.every((key) => moduleKeys.includes(key))) {
    return true;
  }
  const modulePrototypeKeys = Reflect.ownKeys(Module.prototype);
  const originalModulePrototypeKeys = Reflect.ownKeys(snapshot.modulePrototypeState.descriptors);
  if (modulePrototypeKeys.length !== originalModulePrototypeKeys.length
    || !originalModulePrototypeKeys.every((key) => modulePrototypeKeys.includes(key))) {
    return true;
  }
  return originalModuleKeys.some((key) => key === '_load'
    ? !descriptorMatchesWithValue(Module, snapshot.moduleState, key, sealedLoad)
    : key === '_resolveFilename'
      ? !descriptorMatchesWithValue(Module, snapshot.moduleState, key, sealedResolveFilename)
      : !samePropertyDescriptor(
        Object.getOwnPropertyDescriptor(Module, key),
        snapshot.moduleState.descriptors[key],
      ))
    || originalModulePrototypeKeys.some((key) => key === '_compile'
      ? !descriptorMatchesWithValue(Module.prototype, snapshot.modulePrototypeState, key, sealedCompile)
      : !samePropertyDescriptor(
        Object.getOwnPropertyDescriptor(Module.prototype, key),
        snapshot.modulePrototypeState.descriptors[key],
      ))
    || Module._extensions !== snapshot.extensions
    || !sameObjectState(Module._extensions, snapshot.extensionsState)
    || cacheContentsChanged(snapshot);
}

function restoreModuleLoaderState(snapshot) {
  restoreObjectState(Module, snapshot.moduleState, 'Module');
  restoreObjectState(Module.prototype, snapshot.modulePrototypeState, 'Module.prototype');
  restoreObjectState(snapshot.extensions, snapshot.extensionsState, 'Module._extensions');
  restoreObjectState(snapshot.cache, snapshot.cacheState, 'Module._cache');
}

function installAsyncSchedulingGuards() {
  const targets = [
    [globalThis, 'setImmediate'],
    [globalThis, 'setTimeout'],
    [globalThis, 'setInterval'],
    [globalThis, 'queueMicrotask'],
    [process, 'nextTick'],
  ];
  const snapshots = targets.map(([target, key]) => ({
    target,
    key,
    descriptor: Object.getOwnPropertyDescriptor(target, key),
  }));
  const scheduled = [];
  const restore = () => {
    for (const { target, key, descriptor } of snapshots) {
      if (descriptor === undefined) {
        if (Object.hasOwn(target, key) && !Reflect.deleteProperty(target, key)) {
          throw new Error(`could not restore asynchronous scheduler: ${key}`);
        }
      } else if (!Reflect.defineProperty(target, key, descriptor)) {
        throw new Error(`could not restore asynchronous scheduler: ${key}`);
      }
    }
  };
  try {
    for (const { target, key, descriptor } of snapshots) {
      if (descriptor?.value === undefined) continue;
      const guarded = function guardedAsyncSchedule() {
        scheduled.push(key);
        throw new Error(`rootfs Node module attempted asynchronous scheduling: ${key}`);
      };
      if (!Reflect.defineProperty(target, key, { ...descriptor, value: guarded })) {
        throw new Error(`could not guard asynchronous scheduler: ${key}`);
      }
    }
  } catch (error) {
    try {
      restore();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'could not restore asynchronous scheduler guards');
    }
    throw error;
  }
  return {
    scheduled,
    restore,
  };
}

async function drainAsyncBarrier() {
  await Promise.resolve();
  await new Promise((resolve) => ORIGINAL_SET_IMMEDIATE(resolve));
  await Promise.resolve();
}

async function loadFixedRootfsEntrypoint({
  nodeRed,
  packageName,
  specifier,
  resolvedEntrypoint,
  rootfsRequire,
}) {
  const loaderSnapshot = snapshotModuleLoaderState();
  const originalLoad = Module._load;
  const originalResolveFilename = Module._resolveFilename;
  const originalCompile = Module.prototype._compile;
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
  const sealedCompile = function sealedCompile(content, filename) {
    if (!confinedRootfsModulePath(nodeRed, filename)) {
      return Reflect.apply(originalCompile, this, [content, filename]);
    }
    const module = this;
    const compiledWrapper = runInThisContext(Module.wrap(content), {
      filename,
      displayErrors: true,
      importModuleDynamically(specifier) {
        const violation = recordDynamicImportViolation(specifier);
        return Promise.reject(violation);
      },
    });
    compiledWrapper.call(
      module.exports,
      module.exports,
      createRequire(filename),
      module,
      filename,
      dirname(filename),
    );
  };

  Module._resolveFilename = sealedResolveFilename;
  Module._load = sealedLoad;
  Module.prototype._compile = sealedCompile;
  const asyncGuards = installAsyncSchedulingGuards();
  const dynamicImportViolationStart = DYNAMIC_IMPORT_VIOLATIONS.length;
  let exported;
  let failure;
  try {
    exported = rootfsRequire(specifier);
    await drainAsyncBarrier();
    if (DYNAMIC_IMPORT_VIOLATIONS.length > dynamicImportViolationStart) {
      throw DYNAMIC_IMPORT_VIOLATIONS[dynamicImportViolationStart];
    }
    if (asyncGuards.scheduled.length > 0) {
      throw new Error(
        `rootfs Node module scheduled asynchronous work beyond the probe barrier: ${asyncGuards.scheduled.join(', ')}`,
      );
    }
    if (moduleSurfaceChanged(
      loaderSnapshot,
      sealedLoad,
      sealedResolveFilename,
      sealedCompile,
    )) {
      throw new Error(`rootfs Node module changed the sealed builder loader: ${packageName}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      restoreModuleLoaderState(loaderSnapshot);
    } catch (error) {
      failure ??= error;
    }
    try {
      asyncGuards.restore();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  return exported;
}

async function probeModules(nodeRed) {
  const rootfsRequire = createRequire(`${nodeRed}/__osi_verification__.cjs`);
  const results = [];
  for (const [index, [packageName, specifier, loadSpecifier = specifier]] of NODE_MODULES.entries()) {
    const resolved = rootfsRequire.resolve(loadSpecifier);
    const exported = await loadFixedRootfsEntrypoint({
      nodeRed,
      packageName,
      specifier: loadSpecifier,
      resolvedEntrypoint: resolved,
      rootfsRequire,
    });
    const actualRelativePath = relative(nodeRed, resolved).replaceAll('\\', '/');
    if (
      actualRelativePath.startsWith('../')
      || actualRelativePath.startsWith('/')
    ) {
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
    results.push({ packageName, specifier, resolvedRelativePath, exportType });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--rootfs-node-red') {
    fail('exactly one fixed rootfs Node-RED path is required');
    return;
  }
  try {
    const nodeRed = args[1];
    requireCanonicalAbsolutePath(nodeRed, 'rootfs Node-RED path');
    assertPermissionBoundary(nodeRed);
    sealProcessBuiltinAccess();
    process.stdout.write(`${JSON.stringify({ nodeResolution: await probeModules(nodeRed) })}\n`);
  } catch (error) {
    const details = error && typeof error === 'object'
      ? [
          'code' in error ? error.code : undefined,
          'permission' in error ? error.permission : undefined,
          'resource' in error ? error.resource : undefined,
          'message' in error ? error.message : undefined,
        ].filter((value) => typeof value === 'string').join(' ')
      : String(error);
    fail(details);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
