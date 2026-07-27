#!/usr/bin/env node

import Module, { createRequire, isBuiltin } from 'node:module';
import { isAbsolute, normalize, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROBE_PROGRAM = fileURLToPath(import.meta.url);
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

function confinedRootfsModulePath(nodeRed, path) {
  if (typeof path !== 'string') return false;
  const relativePath = relative(nodeRed, path).replaceAll('\\', '/');
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith('../')
    && !relativePath.startsWith('/');
}

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

function probeModules(nodeRed) {
  const rootfsRequire = createRequire(`${nodeRed}/__osi_verification__.cjs`);
  return NODE_MODULES.map((
    [packageName, specifier, loadSpecifier = specifier],
    index,
  ) => {
    const resolved = rootfsRequire.resolve(loadSpecifier);
    const exported = loadFixedRootfsEntrypoint({
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
    return { packageName, specifier, resolvedRelativePath, exportType };
  });
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
    process.stdout.write(`${JSON.stringify({ nodeResolution: probeModules(nodeRed) })}\n`);
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
