#!/usr/bin/env node

import { createHook } from 'node:async_hooks';
import Module, { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, normalize, relative } from 'node:path';
import { runInThisContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROBE_PROGRAM = fileURLToPath(import.meta.url);
const ORIGINAL_PROMISE = Promise;
const ORIGINAL_PROMISE_REJECT = ORIGINAL_PROMISE.reject.bind(ORIGINAL_PROMISE);
const ORIGINAL_JSON_STRINGIFY = JSON.stringify.bind(JSON);
const ORIGINAL_OBJECT_CREATE = Object.create.bind(Object);
const ORIGINAL_OBJECT_DEFINE_PROPERTY = Object.defineProperty.bind(Object);
const ORIGINAL_OBJECT_HAS_OWN = Object.hasOwn.bind(Object);
const ORIGINAL_OBJECT_FREEZE = Object.freeze.bind(Object);
const ORIGINAL_BUFFER_BYTE_LENGTH = Buffer.byteLength.bind(Buffer);
const ORIGINAL_ERROR = Error;
const ORIGINAL_STRING = String;
const ORIGINAL_MODULE_WRAP = Module.wrap;
const ORIGINAL_ARRAY_FILTER = Function.call.bind(Array.prototype.filter);
const ORIGINAL_ARRAY_IS_ARRAY = Array.isArray.bind(Array);
const ORIGINAL_ARRAY_INCLUDES = Function.call.bind(Array.prototype.includes);
const ORIGINAL_ARRAY_JOIN = Function.call.bind(Array.prototype.join);
const ORIGINAL_ARRAY_SLICE = Function.call.bind(Array.prototype.slice);
const ORIGINAL_STRING_INCLUDES = Function.call.bind(String.prototype.includes);
const ORIGINAL_STRING_REPLACE_ALL = Function.call.bind(String.prototype.replaceAll);
const ORIGINAL_STRING_SLICE = Function.call.bind(String.prototype.slice);
const ORIGINAL_STRING_STARTS_WITH = Function.call.bind(String.prototype.startsWith);
const ORIGINAL_MAP_DELETE = Function.call.bind(Map.prototype.delete);
const ORIGINAL_MAP_ENTRIES = Function.call.bind(Map.prototype.entries);
const ORIGINAL_MAP_SET = Function.call.bind(Map.prototype.set);
const ORIGINAL_MAP_ITERATOR_NEXT = Function.call.bind(
  Object.getPrototypeOf(new Map().entries()).next,
);
const ORIGINAL_REFLECT_APPLY = Reflect.apply.bind(Reflect);
const ORIGINAL_REFLECT_DEFINE_PROPERTY = Reflect.defineProperty.bind(Reflect);
const ORIGINAL_REFLECT_DELETE_PROPERTY = Reflect.deleteProperty.bind(Reflect);
const ORIGINAL_REFLECT_GET_OWN_PROPERTY_DESCRIPTOR = Reflect.getOwnPropertyDescriptor.bind(Reflect);
const ORIGINAL_REFLECT_GET_PROTOTYPE_OF = Reflect.getPrototypeOf.bind(Reflect);
const ORIGINAL_REFLECT_GET = Reflect.get.bind(Reflect);
const ORIGINAL_REFLECT_HAS = Reflect.has.bind(Reflect);
const ORIGINAL_REFLECT_IS_EXTENSIBLE = Reflect.isExtensible.bind(Reflect);
const ORIGINAL_REFLECT_OWN_KEYS = Reflect.ownKeys.bind(Reflect);
const ORIGINAL_REFLECT_PREVENT_EXTENSIONS = Reflect.preventExtensions.bind(Reflect);
const ORIGINAL_REFLECT_SET = Reflect.set.bind(Reflect);
const ORIGINAL_REFLECT_SET_PROTOTYPE_OF = Reflect.setPrototypeOf.bind(Reflect);
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);
const ORIGINAL_PROCESS_EXIT = process.exit.bind(process);
const ORIGINAL_CREATE_ASYNC_HOOK = createHook.bind(null);
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
const TRUSTED_REAL_BUILTINS_TO_WARM = Object.freeze([
  'buffer',
  'crypto',
  'dns',
  'events',
  'http',
  'http2',
  'https',
  'net',
  'node:crypto',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'zlib',
]);

for (const builtin of TRUSTED_REAL_BUILTINS_TO_WARM) ORIGINAL_GET_BUILTIN_MODULE(builtin);

function deniedFilesystemCapability() {
  throw new ORIGINAL_ERROR('rootfs Node module attempted to use a denied builder filesystem capability');
}

const ROOTFS_FILESYSTEM_CAPABILITY = Object.freeze(new Proxy(
  Object.freeze({ readFile: deniedFilesystemCapability }),
  {
    get(target, property, receiver) {
      if (!ORIGINAL_REFLECT_HAS(target, property)) {
        throw new ORIGINAL_ERROR(
          `rootfs Node module requested a denied builder filesystem capability: ${ORIGINAL_STRING(property)}`,
        );
      }
      return ORIGINAL_REFLECT_GET(target, property, receiver);
    },
  },
));

function deniedChildProcessCapability() {
  throw new ORIGINAL_ERROR('rootfs Node module attempted to use a denied builder process capability');
}

const ROOTFS_CHILD_PROCESS_CAPABILITY = Object.freeze({
  execFile: deniedChildProcessCapability,
});
const BUILTIN_CAPABILITY_STUBS = ORIGINAL_OBJECT_CREATE(null);
BUILTIN_CAPABILITY_STUBS['node:child_process'] = Object.freeze({
  packageName: 'osi-health-helper',
  parentRelativePath: 'osi-health-helper/index.js',
  value: ROOTFS_CHILD_PROCESS_CAPABILITY,
});
Object.freeze(BUILTIN_CAPABILITY_STUBS);

class NativeDatabaseInitializerStub {
  constructor() {
    throw new ORIGINAL_ERROR('the sqlite3 initializer stub cannot open a database');
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
const NATIVE_DEPENDENCY_STUBS = ORIGINAL_OBJECT_CREATE(null);
NATIVE_DEPENDENCY_STUBS.sqlite3 = Object.freeze({
  packageName: 'osi-db-helper',
  value: SQLITE3_INITIALIZER_STUB,
});
Object.freeze(NATIVE_DEPENDENCY_STUBS);
let loaderAccessDepth = 0;

function withTrustedLoaderAccess(operation) {
  loaderAccessDepth += 1;
  try {
    return operation();
  } finally {
    loaderAccessDepth -= 1;
  }
}

function createRestrictedLoaderCache(realCache, label) {
  const deniedMutation = () => {
    throw new ORIGINAL_ERROR(`rootfs Node module attempted to mutate ${label}`);
  };
  return new Proxy(realCache, {
    get(target, property, receiver) {
      return loaderAccessDepth > 0
        ? ORIGINAL_REFLECT_GET(target, property, receiver)
        : undefined;
    },
    has(target, property) {
      return loaderAccessDepth > 0 && ORIGINAL_REFLECT_HAS(target, property);
    },
    ownKeys(target) {
      return loaderAccessDepth > 0 ? ORIGINAL_REFLECT_OWN_KEYS(target) : [];
    },
    getOwnPropertyDescriptor(target, property) {
      return loaderAccessDepth > 0
        ? ORIGINAL_REFLECT_GET_OWN_PROPERTY_DESCRIPTOR(target, property)
        : undefined;
    },
    getPrototypeOf(target) {
      return loaderAccessDepth > 0 ? ORIGINAL_REFLECT_GET_PROTOTYPE_OF(target) : null;
    },
    isExtensible(target) {
      return loaderAccessDepth > 0 ? ORIGINAL_REFLECT_IS_EXTENSIBLE(target) : true;
    },
    set(target, property, value, receiver) {
      if (loaderAccessDepth === 0) return deniedMutation();
      return ORIGINAL_REFLECT_SET(target, property, value, receiver);
    },
    defineProperty(target, property, descriptor) {
      if (loaderAccessDepth === 0) return deniedMutation();
      return ORIGINAL_REFLECT_DEFINE_PROPERTY(target, property, descriptor);
    },
    deleteProperty(target, property) {
      if (loaderAccessDepth === 0) return deniedMutation();
      return ORIGINAL_REFLECT_DELETE_PROPERTY(target, property);
    },
    setPrototypeOf(target, prototype) {
      if (loaderAccessDepth === 0) return deniedMutation();
      return ORIGINAL_REFLECT_SET_PROTOTYPE_OF(target, prototype);
    },
    preventExtensions(target) {
      if (loaderAccessDepth === 0) return deniedMutation();
      return ORIGINAL_REFLECT_PREVENT_EXTENSIONS(target);
    },
  });
}
let firstDynamicImportViolation = null;

function recordDynamicImportViolation(specifier) {
  const violation = new ORIGINAL_ERROR(
    `rootfs Node module requested an unapproved builder ESM builtin: ${specifier}`,
  );
  if (firstDynamicImportViolation === null) firstDynamicImportViolation = violation;
  return violation;
}

function sealedGetBuiltinModule(request) {
  if (typeof request !== 'string' || !ORIGINAL_ARRAY_INCLUDES(ALLOWED_ROOTFS_BUILTINS, request)) {
    throw new ORIGINAL_ERROR(`rootfs Node module requested an unapproved builder builtin: ${request}`);
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
    || ORIGINAL_STRING_INCLUDES(value, '\0')
  ) throw new ORIGINAL_ERROR(`${field} is not one canonical absolute path`);
}

function assertPermissionBoundary(nodeRed) {
  const expectedExecArgv = [
    '--experimental-vm-modules',
    '--permission',
    `--allow-fs-read=${PROBE_PROGRAM}`,
    `--allow-fs-read=${nodeRed}`,
  ];
  if (JSON.stringify(process.execArgv) !== JSON.stringify(expectedExecArgv)) {
    throw new ORIGINAL_ERROR('probe process permission arguments changed');
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
    throw new ORIGINAL_ERROR('probe process permissions are not read-only and fail-closed');
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
    value: () => { throw new ORIGINAL_ERROR('rootfs Node module attempted to exit the probe'); },
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
  ) throw new ORIGINAL_ERROR('probe process builtin access is not sealed');
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
  const relativePath = ORIGINAL_STRING_REPLACE_ALL(relative(nodeRed, value), '\\', '/');
  return relativePath.length > 0
    && relativePath !== '..'
    && !ORIGINAL_STRING_STARTS_WITH(relativePath, '../')
    && !ORIGINAL_STRING_STARTS_WITH(relativePath, '/');
}

function installRootfsLoader({ nodeRed, packageName, resolvedEntrypoint }) {
  const originalLoad = Module._load;
  const originalResolveFilename = Module._resolveFilename;
  const originalCompile = Module.prototype._compile;
  const realModuleCache = Module._cache;
  const realModulePathCache = Module._pathCache;
  if (!realModuleCache || typeof realModuleCache !== 'object'
    || !realModulePathCache || typeof realModulePathCache !== 'object') {
    throw new ORIGINAL_ERROR('Node module loader caches are unavailable');
  }
  const moduleCache = createRestrictedLoaderCache(realModuleCache, 'Module._cache');
  const modulePathCache = createRestrictedLoaderCache(realModulePathCache, 'Module._pathCache');
  const sealedResolveFilename = function sealedResolveFilename(request, parent, isMain, options) {
    if (typeof request !== 'string') {
      throw new ORIGINAL_ERROR('rootfs Node module requests must be primitive strings');
    }
    return withTrustedLoaderAccess(() => {
      if (isBuiltin(request)) {
        if (!ORIGINAL_ARRAY_INCLUDES(ALLOWED_ROOTFS_BUILTINS, request)) {
          throw new ORIGINAL_ERROR(`rootfs Node module requested an unapproved builder builtin: ${request}`);
        }
        return ORIGINAL_REFLECT_APPLY(originalResolveFilename, Module, [request, parent, isMain, options]);
      }
      const resolved = ORIGINAL_REFLECT_APPLY(
        originalResolveFilename,
        Module,
        [request, parent, isMain, options],
      );
      if (!confinedRootfsModulePath(nodeRed, resolved)) {
        throw new ORIGINAL_ERROR(`rootfs Node module dependency resolved outside the trusted rootfs: ${request}`);
      }
      return resolved;
    });
  };
  const sealedLoad = function sealedLoad(request, parent, isMain) {
    if (typeof request !== 'string') {
      throw new ORIGINAL_ERROR('rootfs Node module requests must be primitive strings');
    }
    const nativeStub = ORIGINAL_OBJECT_HAS_OWN(NATIVE_DEPENDENCY_STUBS, request)
      ? NATIVE_DEPENDENCY_STUBS[request]
      : undefined;
    if (nativeStub !== undefined) {
      if (packageName !== nativeStub.packageName || parent?.filename !== resolvedEntrypoint) {
        throw new ORIGINAL_ERROR(`rootfs Node module requested an unapproved native dependency stub: ${request}`);
      }
      return nativeStub.value;
    }
    sealedResolveFilename(request, parent, isMain);
    if (request === 'fs' || request === 'node:fs') return ROOTFS_FILESYSTEM_CAPABILITY;
    const builtinStub = ORIGINAL_OBJECT_HAS_OWN(BUILTIN_CAPABILITY_STUBS, request)
      ? BUILTIN_CAPABILITY_STUBS[request]
      : undefined;
    if (builtinStub !== undefined) {
      const parentRelativePath = typeof parent?.filename === 'string'
        ? ORIGINAL_STRING_REPLACE_ALL(relative(nodeRed, parent.filename), '\\', '/')
        : '';
      if (
        packageName !== builtinStub.packageName
        || parentRelativePath !== builtinStub.parentRelativePath
      ) throw new ORIGINAL_ERROR(`rootfs Node module requested an unapproved builder builtin: ${request}`);
      return builtinStub.value;
    }
    return withTrustedLoaderAccess(() => ORIGINAL_REFLECT_APPLY(originalLoad, this, [request, parent, isMain]));
  };
  const sealedCompile = function sealedCompile(content, filename) {
    if (!confinedRootfsModulePath(nodeRed, filename)) {
      return withTrustedLoaderAccess(() => ORIGINAL_REFLECT_APPLY(originalCompile, this, [content, filename]));
    }
    const module = this;
    const compiledWrapper = runInThisContext(ORIGINAL_MODULE_WRAP(content), {
      filename,
      displayErrors: true,
      importModuleDynamically(specifier) {
        return ORIGINAL_PROMISE_REJECT(recordDynamicImportViolation(specifier));
      },
    });
    const requireEntry = createRequire(filename);
    const originalResolve = requireEntry.resolve;
    const localRequire = function localRequire(request) {
      if (typeof request !== 'string') {
        throw new ORIGINAL_ERROR('rootfs require requests must be primitive strings');
      }
      return requireEntry(request);
    };
    const safeResolve = function safeResolve(request, options) {
      if (typeof request !== 'string') {
        throw new ORIGINAL_ERROR('rootfs require.resolve requests must be primitive strings');
      }
      if (arguments.length > 1) {
        throw new ORIGINAL_ERROR('rootfs require.resolve options are not supported');
      }
      return originalResolve(request);
    };
    const safeResolvePaths = () => {
      throw new ORIGINAL_ERROR('rootfs require.resolve.paths is not supported');
    };
    ORIGINAL_OBJECT_DEFINE_PROPERTY(safeResolve, 'paths', {
      value: safeResolvePaths,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    ORIGINAL_OBJECT_DEFINE_PROPERTY(localRequire, 'resolve', {
      value: safeResolve,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    ORIGINAL_OBJECT_DEFINE_PROPERTY(localRequire, 'cache', {
      value: moduleCache,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    ORIGINAL_OBJECT_DEFINE_PROPERTY(localRequire, 'extensions', {
      value: Module._extensions,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    if (localRequire.cache !== moduleCache) {
      throw new ORIGINAL_ERROR('rootfs local require cache is not restricted');
    }
    ORIGINAL_OBJECT_FREEZE(localRequire);
    const safePaths = ORIGINAL_OBJECT_FREEZE(
      ORIGINAL_ARRAY_SLICE(ORIGINAL_ARRAY_IS_ARRAY(module.paths) ? module.paths : []),
    );
    const safeChildren = ORIGINAL_OBJECT_FREEZE([]);
    const moduleFacade = ORIGINAL_OBJECT_CREATE(null);
    ORIGINAL_OBJECT_DEFINE_PROPERTY(moduleFacade, 'exports', {
      get: () => module.exports,
      set: (value) => { module.exports = value; },
      enumerable: true,
      configurable: false,
    });
    for (const [property, value] of [
      ['id', typeof module.id === 'string' ? module.id : filename],
      ['filename', filename],
      ['path', dirname(filename)],
      ['paths', safePaths],
      ['parent', null],
      ['children', safeChildren],
      ['loaded', false],
      ['isPreloading', false],
      ['require', localRequire],
      ['constructor', null],
      ['prototype', null],
    ]) {
      ORIGINAL_OBJECT_DEFINE_PROPERTY(moduleFacade, property, {
        value,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    ORIGINAL_OBJECT_FREEZE(moduleFacade);
    const trustedDepth = loaderAccessDepth;
    loaderAccessDepth = 0;
    try {
      ORIGINAL_REFLECT_APPLY(compiledWrapper, module.exports, [
        module.exports,
        localRequire,
        moduleFacade,
        filename,
        dirname(filename),
      ]);
    } finally {
      loaderAccessDepth = trustedDepth;
    }
  };
  const originalRequire = Module.prototype.require;
  const extensionSurface = Module._extensions;
  if (!extensionSurface || typeof extensionSurface !== 'object') {
    throw new ORIGINAL_ERROR('Node extension loader surface is unavailable');
  }
  Object.freeze(extensionSurface);
  const seal = (target, property, value, label) => {
    const previous = Object.getOwnPropertyDescriptor(target, property);
    if (!previous || !('value' in previous)) {
      throw new ORIGINAL_ERROR(`${label} descriptor is unavailable`);
    }
    ORIGINAL_OBJECT_DEFINE_PROPERTY(target, property, {
      value,
      writable: false,
      enumerable: previous.enumerable,
      configurable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (
      descriptor?.value !== value
      || descriptor.writable !== false
      || descriptor.enumerable !== previous.enumerable
      || descriptor.configurable !== false
    ) throw new ORIGINAL_ERROR(`${label} is not sealed for the probe lifetime`);
  };
  seal(Module, '_resolveFilename', sealedResolveFilename, 'Module._resolveFilename');
  seal(Module, '_load', sealedLoad, 'Module._load');
  seal(Module.prototype, '_compile', sealedCompile, 'Module.prototype._compile');
  seal(Module.prototype, 'require', originalRequire, 'Module.prototype.require');
  seal(Module, '_extensions', extensionSurface, 'Module._extensions');
  seal(Module, '_cache', moduleCache, 'Module._cache');
  seal(Module, '_pathCache', modulePathCache, 'Module._pathCache');
  const javascriptExtension = Object.getOwnPropertyDescriptor(extensionSurface, '.js');
  if (
    !javascriptExtension
    || javascriptExtension.writable !== false
    || javascriptExtension.configurable !== false
  ) throw new ORIGINAL_ERROR('JavaScript extension loader is not sealed for the probe lifetime');
  for (const [property, label] of [
    ['wrapper', 'Module.wrapper'],
    ['builtinModules', 'Module.builtinModules'],
    ['globalPaths', 'Module.globalPaths'],
  ]) {
    const value = Module[property];
    if (Array.isArray(value)) {
      Object.freeze(value);
      if (!Object.isFrozen(value)) throw new ORIGINAL_ERROR(`${label} is not frozen`);
    }
  }
  Object.freeze(Module.prototype);
  Object.freeze(Module);
  if (!Object.isFrozen(Module.prototype) || !Object.isFrozen(Module)) {
    throw new ORIGINAL_ERROR('Node module loader surfaces are not frozen for the probe lifetime');
  }
}

function exportType(value) {
  return typeof value === 'function'
    ? 'function'
    : value !== null && typeof value === 'object'
      ? 'object'
      : 'incompatible';
}

function createSuccessRecord(packageIndex, packageName, specifier, resolvedRelativePath, exported) {
  const record = ORIGINAL_OBJECT_CREATE(null);
  record.packageIndex = packageIndex;
  record.packageName = packageName;
  record.specifier = specifier;
  record.resolvedRelativePath = resolvedRelativePath;
  record.exportType = exportType(exported);
  return record;
}

function observeSynchronousModuleLoad(load) {
  const pendingResources = new Map();
  let firstPendingResource = null;
  const selectFirstPendingResource = () => {
    const iterator = ORIGINAL_MAP_ENTRIES(pendingResources);
    const next = ORIGINAL_MAP_ITERATOR_NEXT(iterator);
    firstPendingResource = next.done
      ? null
      : { id: next.value[0], type: next.value[1] };
  };
  const hook = ORIGINAL_CREATE_ASYNC_HOOK({
    init(asyncId, type) {
      ORIGINAL_MAP_SET(pendingResources, asyncId, type);
      if (firstPendingResource === null) firstPendingResource = { id: asyncId, type };
    },
    promiseResolve(asyncId) {
      ORIGINAL_MAP_DELETE(pendingResources, asyncId);
      if (firstPendingResource?.id === asyncId) selectFirstPendingResource();
    },
  });
  hook.enable();
  try {
    return { exported: load(), firstPendingResource };
  } finally {
    hook.disable();
  }
}

function probePackage(nodeRed, packageIndex) {
  const [packageName, specifier, loadSpecifier = specifier] = NODE_MODULES[packageIndex];
  const resolutionRequire = createRequire(`${nodeRed}/__osi_verification__.cjs`);
  const resolved = resolutionRequire.resolve(loadSpecifier);
  const actualRelativePath = ORIGINAL_STRING_REPLACE_ALL(relative(nodeRed, resolved), '\\', '/');
  if (
    ORIGINAL_STRING_STARTS_WITH(actualRelativePath, '../')
    || ORIGINAL_STRING_STARTS_WITH(actualRelativePath, '/')
  ) {
    throw new ORIGINAL_ERROR(`resolved Node module escaped the trusted rootfs base: ${packageName}`);
  }
  const directRoot = `${packageName}/`;
  const nodeModulesRoot = `node_modules/${packageName}/`;
  const resolvedRelativePath = packageIndex >= RELATIVE_HELPER_START
    && packageIndex < RELATIVE_HELPER_END
    && ORIGINAL_STRING_STARTS_WITH(actualRelativePath, directRoot)
    ? `${nodeModulesRoot}${ORIGINAL_STRING_SLICE(actualRelativePath, directRoot.length)}`
    : actualRelativePath;
  const expectedRoot = ORIGINAL_STRING_STARTS_WITH(specifier, './') ? directRoot : nodeModulesRoot;
  if (!ORIGINAL_STRING_STARTS_WITH(resolvedRelativePath, expectedRoot)) {
    throw new ORIGINAL_ERROR(`resolved Node module changed package identity: ${packageName}`);
  }
  installRootfsLoader({ nodeRed, packageName, resolvedEntrypoint: resolved });
  const rootfsRequire = createRequire(`${nodeRed}/__osi_verification__.cjs`);
  const observation = observeSynchronousModuleLoad(() => rootfsRequire(loadSpecifier));
  if (firstDynamicImportViolation !== null) {
    throw firstDynamicImportViolation;
  }
  if (observation.firstPendingResource !== null) {
    throw new ORIGINAL_ERROR(
      `rootfs Node module created asynchronous resource during synchronous module initialization: ${ORIGINAL_STRING(observation.firstPendingResource.type)}`,
    );
  }
  return createSuccessRecord(
    packageIndex,
    packageName,
    specifier,
    resolvedRelativePath,
    observation.exported,
  );
}

function boundedDetails(error) {
  const details = error && typeof error === 'object'
    ? ORIGINAL_ARRAY_JOIN(
      ORIGINAL_ARRAY_FILTER([
        'code' in error ? error.code : undefined,
        'permission' in error ? error.permission : undefined,
        'resource' in error ? error.resource : undefined,
        'message' in error ? error.message : undefined,
      ], (value) => typeof value === 'string'),
      ' ',
    )
    : ORIGINAL_STRING(error);
  return ORIGINAL_STRING_SLICE(details, 0, 4096);
}

function flushAndExit(record, code) {
  const serialized = ORIGINAL_JSON_STRINGIFY(record);
  if (typeof serialized !== 'string' || ORIGINAL_BUFFER_BYTE_LENGTH(serialized) > MAX_OUTPUT_BYTES) {
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

function main() {
  const args = ORIGINAL_ARRAY_SLICE(process.argv, 2);
  if (
    args.length !== 4
    || args[0] !== '--rootfs-node-red'
    || args[2] !== '--package-index'
    || !/^\d+$/u.test(args[3])
  ) throw new ORIGINAL_ERROR('exactly one fixed rootfs Node-RED path and package index are required');
  const nodeRed = args[1];
  const packageIndex = Number(args[3]);
  requireCanonicalAbsolutePath(nodeRed, 'rootfs Node-RED path');
  if (!Number.isSafeInteger(packageIndex) || packageIndex < 0 || packageIndex >= NODE_MODULES.length) {
    throw new ORIGINAL_ERROR('package index is outside the fixed module list');
  }
  assertPermissionBoundary(nodeRed);
  silenceProcessOutput();
  sealProcessBuiltinAccess();
  const result = probePackage(nodeRed, packageIndex);
  flushAndExit(result, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const record = ORIGINAL_OBJECT_CREATE(null);
    record.error = boundedDetails(error);
    flushAndExit(record, 2);
  }
}
