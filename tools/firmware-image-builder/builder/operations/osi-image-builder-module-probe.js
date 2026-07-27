#!/usr/bin/env node

import Module, { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, normalize, relative } from 'node:path';
import { runInThisContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROBE_PROGRAM = fileURLToPath(import.meta.url);
const ORIGINAL_SET_IMMEDIATE = setImmediate;
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);
const ORIGINAL_PROCESS_EXIT = process.exit.bind(process);
const MAX_OUTPUT_BYTES = 1024 * 1024;
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
const RELATIVE_HELPER_START = 4;
const RELATIVE_HELPER_END = 13;
const ORIGINAL_GET_BUILTIN_MODULE = process.getBuiltinModule.bind(process);

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
const DYNAMIC_IMPORT_VIOLATIONS = [];

function recordDynamicImportViolation(specifier) {
  const violation = new Error(
    `rootfs Node module requested an unapproved builder ESM builtin: ${specifier}`,
  );
  DYNAMIC_IMPORT_VIOLATIONS.push(violation);
  return violation;
}

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

function requireCanonicalAbsolutePath(value, field) {
  if (
    typeof value !== 'string'
    || !isAbsolute(value)
    || normalize(value) !== value
    || value.includes('\0')
  ) throw new Error(`${field} is not one canonical absolute path`);
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
  Object.defineProperty(process, 'exit', {
    value: () => { throw new Error('rootfs Node module attempted to exit the probe'); },
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
  ) throw new Error('probe process builtin access is not sealed');
}

function silenceProcessOutput() {
  const quietWrite = () => true;
  Object.defineProperty(process.stdout, 'write', {
    value: quietWrite,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(process.stderr, 'write', {
    value: quietWrite,
    writable: false,
    configurable: false,
  });
}

function confinedRootfsModulePath(nodeRed, value) {
  if (typeof value !== 'string') return false;
  const relativePath = relative(nodeRed, value).replaceAll('\\', '/');
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith('../')
    && !relativePath.startsWith('/');
}

function installRootfsLoader({ nodeRed, packageName, resolvedEntrypoint }) {
  const originalLoad = Module._load;
  const originalResolveFilename = Module._resolveFilename;
  const originalCompile = Module.prototype._compile;
  const sealedResolveFilename = function sealedResolveFilename(request, parent, isMain, options) {
    if (isBuiltin(request)) {
      if (!ALLOWED_ROOTFS_BUILTINS.includes(request)) {
        throw new Error(`rootfs Node module requested an unapproved builder builtin: ${request}`);
      }
      return Reflect.apply(originalResolveFilename, Module, [request, parent, isMain, options]);
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
    const nativeStub = NATIVE_DEPENDENCY_STUBS[request];
    if (nativeStub !== undefined) {
      if (packageName !== nativeStub.packageName || parent?.filename !== resolvedEntrypoint) {
        throw new Error(`rootfs Node module requested an unapproved native dependency stub: ${request}`);
      }
      return nativeStub.value;
    }
    sealedResolveFilename(request, parent, isMain);
    if (request === 'fs' || request === 'node:fs') return ROOTFS_FILESYSTEM_CAPABILITY;
    const builtinStub = BUILTIN_CAPABILITY_STUBS[request];
    if (builtinStub !== undefined) {
      const parentRelativePath = typeof parent?.filename === 'string'
        ? relative(nodeRed, parent.filename).replaceAll('\\', '/')
        : '';
      if (
        packageName !== builtinStub.packageName
        || parentRelativePath !== builtinStub.parentRelativePath
      ) throw new Error(`rootfs Node module requested an unapproved builder builtin: ${request}`);
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
        return Promise.reject(recordDynamicImportViolation(specifier));
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
}

async function drainAsyncBarrier() {
  await Promise.resolve();
  await new Promise((resolve) => ORIGINAL_SET_IMMEDIATE(resolve));
  await Promise.resolve();
  await new Promise((resolve) => ORIGINAL_SET_IMMEDIATE(resolve));
  await Promise.resolve();
}

function exportType(value) {
  return typeof value === 'function'
    ? 'function'
    : value !== null && typeof value === 'object'
      ? 'object'
      : 'incompatible';
}

async function probePackage(nodeRed, packageIndex) {
  const [packageName, specifier, loadSpecifier = specifier] = NODE_MODULES[packageIndex];
  const rootfsRequire = createRequire(`${nodeRed}/__osi_verification__.cjs`);
  const resolved = rootfsRequire.resolve(loadSpecifier);
  installRootfsLoader({ nodeRed, packageName, resolvedEntrypoint: resolved });
  const dynamicImportViolationStart = DYNAMIC_IMPORT_VIOLATIONS.length;
  const exported = rootfsRequire(loadSpecifier);
  await drainAsyncBarrier();
  if (DYNAMIC_IMPORT_VIOLATIONS.length > dynamicImportViolationStart) {
    throw DYNAMIC_IMPORT_VIOLATIONS[dynamicImportViolationStart];
  }
  const actualRelativePath = relative(nodeRed, resolved).replaceAll('\\', '/');
  if (actualRelativePath.startsWith('../') || actualRelativePath.startsWith('/')) {
    throw new Error(`resolved Node module escaped the trusted rootfs base: ${packageName}`);
  }
  const directRoot = `${packageName}/`;
  const nodeModulesRoot = `node_modules/${packageName}/`;
  const resolvedRelativePath = packageIndex >= RELATIVE_HELPER_START
    && packageIndex < RELATIVE_HELPER_END
    && actualRelativePath.startsWith(directRoot)
    ? `${nodeModulesRoot}${actualRelativePath.slice(directRoot.length)}`
    : actualRelativePath;
  const expectedRoot = specifier.startsWith('./') ? directRoot : nodeModulesRoot;
  if (!resolvedRelativePath.startsWith(expectedRoot)) {
    throw new Error(`resolved Node module changed package identity: ${packageName}`);
  }
  return {
    packageIndex,
    packageName,
    specifier,
    resolvedRelativePath,
    exportType: exportType(exported),
  };
}

function boundedDetails(error) {
  const details = error && typeof error === 'object'
    ? [
        'code' in error ? error.code : undefined,
        'permission' in error ? error.permission : undefined,
        'resource' in error ? error.resource : undefined,
        'message' in error ? error.message : undefined,
      ].filter((value) => typeof value === 'string').join(' ')
    : String(error);
  return details.slice(0, 4096);
}

function flushAndExit(record, code) {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) {
    ORIGINAL_STDERR_WRITE(
      'osi-image-builder-module-probe: output exceeds bounded limit\n',
      () => ORIGINAL_PROCESS_EXIT(2),
    );
    return;
  }
  const output = code === 0
    ? `${serialized}\n`
    : `osi-image-builder-module-probe: ${serialized}\n`;
  const write = code === 0 ? ORIGINAL_STDOUT_WRITE : ORIGINAL_STDERR_WRITE;
  write(output, () => ORIGINAL_PROCESS_EXIT(code));
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 4
    || args[0] !== '--rootfs-node-red'
    || args[2] !== '--package-index'
    || !/^\d+$/u.test(args[3])
  ) throw new Error('exactly one fixed rootfs Node-RED path and package index are required');
  const nodeRed = args[1];
  const packageIndex = Number(args[3]);
  requireCanonicalAbsolutePath(nodeRed, 'rootfs Node-RED path');
  if (!Number.isSafeInteger(packageIndex) || packageIndex < 0 || packageIndex >= NODE_MODULES.length) {
    throw new Error('package index is outside the fixed module list');
  }
  assertPermissionBoundary(nodeRed);
  silenceProcessOutput();
  sealProcessBuiltinAccess();
  const result = await probePackage(nodeRed, packageIndex);
  flushAndExit(result, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => flushAndExit({ error: boundedDetails(error) }, 2));
}
