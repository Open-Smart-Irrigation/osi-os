import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, readlink, statfs } from 'node:fs/promises';
import { request as nodeHttpRequest } from 'node:http';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
import {
  assertSafeCommandArgv,
  runSafeCommand,
} from './shared/command-adapter.mjs';

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TARGETS = Object.freeze({ pi5: 'rpi-5', pi4: 'rpi-2' });
const MAX_CONFIG_BYTES = 65_536;
const MAX_PUBLISHER_BYTES = 4 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const CLOSE_ON_EXEC = typeof constants.O_CLOEXEC === 'number' ? constants.O_CLOEXEC : 0;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | CLOSE_ON_EXEC;
// Node does not expose Linux O_PATH, but the numeric flag is stable on the supported Linux targets.
const O_PATH = 0x200000;
const HELD_ENTRY_FLAGS = O_PATH | constants.O_NOFOLLOW | CLOSE_ON_EXEC;
export const REAL_ACCEPTANCE_NOT_IMPLEMENTED = 'REAL_ACCEPTANCE_NOT_IMPLEMENTED';

let productionValidators;
let productionCompositionApis;

async function loadProductionValidators() {
  if (productionValidators === undefined) {
    const { tsImport } = await import('tsx/esm/api');
    const [evidence, terminalVerification, preflight, domainTypes, domainStates, targetSetup] = await Promise.all([
      tsImport(new URL('../runner/src/evidence.ts', import.meta.url).href, import.meta.url),
      tsImport(new URL('../runner/src/terminal-verification.ts', import.meta.url).href, import.meta.url),
      tsImport(new URL('../api/src/preflight.ts', import.meta.url).href, import.meta.url),
      tsImport(new URL('../domain/types.ts', import.meta.url).href, import.meta.url),
      tsImport(new URL('../domain/states.ts', import.meta.url).href, import.meta.url),
      tsImport(new URL('../runner/src/target-setup.ts', import.meta.url).href, import.meta.url),
    ]);
    productionValidators = Object.freeze({
      decodeStoredStageEvidence: evidence.decodeStoredStageEvidence,
      createTerminalVerification: terminalVerification.createTerminalVerification,
      PREFLIGHT_CHECK_IDS: preflight.PREFLIGHT_CHECK_IDS,
      JOB_STATES: domainTypes.JOB_STATES,
      TERMINAL_STATES: domainTypes.TERMINAL_STATES,
      isTerminalState: domainStates.isTerminalState,
      assertActiveTargetLinks: targetSetup.assertActiveTargetLinks,
    });
  }
  return productionValidators;
}

async function loadProductionCompositionApis() {
  if (productionCompositionApis === undefined) {
    const { tsImport } = await import('tsx/esm/api');
    const production = await tsImport(
      new URL('./shared/acceptance-production-apis.ts', import.meta.url).href,
      import.meta.url,
    );
    productionCompositionApis = Object.freeze({
      loadConfig: production.loadConfig,
      withNoFollowFileUnderRoot: production.withNoFollowFileUnderRoot,
      withNoFollowFileUnderStateRoot: production.withNoFollowFileUnderStateRoot,
      EvidenceWriter: production.EvidenceWriter,
    });
  }
  return productionCompositionApis;
}

const REPORT_FIELDS = Object.freeze([
  'release_dir', 'job_evidence_root', 'worktree', 'rootfs', 'target_output', 'target_id',
  'target_manifest_json', 'build_start_epoch', 'source_flows', 'source_db', 'source_gui',
  'feed_gui', 'build_manifest', 'installed_lock', 'docker_inspection_json',
  'published_verification_json', 'published_sha256sums', 'report_json',
]);
const EVIDENCE_PAIRS = Object.freeze([
  ['preflight', '00-preflight.json'], ['source', '01-source.json'],
  ['release-gates', '02-release-gates.json'], ['frontend', '03-frontend.json'],
  ['target-setup', '04-target-setup.json'], ['feeds', '05-feeds.json'],
  ['config', '06-config.json'], ['build', '07-build.json'],
  ['verify', '08-verify.json'], ['publish', '09-publish.json'],
]);
const COMMANDS = Object.freeze([
  ['git-origin', ['git', 'remote', 'get-url', 'origin']],
  ['repo-profile-parity', ['node', 'scripts/verify-profile-parity.js']],
  ['repo-chameleon-calibration', ['node', 'scripts/verify-chameleon-calibration.js']],
  ['repo-db-schema', ['node', 'scripts/verify-db-schema-consistency.js']],
  ['repo-sync-flow', ['node', 'scripts/verify-sync-flow.js']],
  ['repo-strega', ['node', 'scripts/verify-strega-gen1.js']],
  ['repo-communication', ['node', 'scripts/verify-communication-contract.js']],
  ['repo-mqtt-topics', ['scripts/check-mqtt-topics.sh']],
]);
const DIGEST_FIELDS = Object.freeze([
  'installedLockSha256', 'buildManifestSha256', 'publishedImageSha256',
  'dockerInspectionSha256', 'targetManifestSha256', 'publishedSha256sumsSha256',
  'publishedVerificationSha256', 'sourceEvidenceSha256', 'verifyEvidenceSha256',
  'sourceFlowsSha256', 'rootfsFlowsSha256', 'sourceDbSha256', 'rootfsDbSha256',
  'feedGuiTreeSha256', 'sourceGuiTreeSha256', 'rootfsGuiTreeSha256',
  'dependencyEgressProxySha256',
]);
const REQUIRED_RUNTIME_FILES = Object.freeze([
  '/etc/uci-defaults/98_osi_node_red_seed', '/usr/share/flows.json', '/usr/share/db/farming.db',
  '/etc/init.d/node-red', '/usr/lib/node-red/gui/index.html',
  '/usr/share/node-red/node_modules/@grpc/grpc-js/package.json',
  '/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json',
  '/usr/share/node-red/node_modules/google-protobuf/package.json',
  '/usr/share/node-red/node_modules/protobufjs/package.json',
  '/usr/share/node-red/node_modules/osi-chameleon-helper/package.json',
  '/usr/share/node-red/node_modules/osi-chirpstack-helper/package.json',
  '/usr/share/node-red/node_modules/osi-cloud-http/package.json',
  '/usr/share/node-red/node_modules/osi-command-ledger/package.json',
  '/usr/share/node-red/node_modules/osi-db-helper/package.json',
  '/usr/share/node-red/node_modules/osi-dendro-helper/package.json',
  '/usr/share/node-red/node_modules/osi-dendro-analytics/package.json',
  '/usr/share/node-red/node_modules/osi-zone-env/package.json',
  '/usr/share/node-red/node_modules/osi-history-helper/package.json',
  '/usr/share/node-red/node_modules/osi-history-sync-helper/package.json',
  '/usr/share/node-red/node_modules/osi-history-router/package.json',
  '/usr/share/node-red/node_modules/osi-health-helper/package.json',
  '/usr/share/node-red/node_modules/osi-lib/package.json',
  '/usr/share/node-red/node_modules/osi-journal/package.json',
  '/usr/share/node-red/node_modules/osi-device-writer/package.json',
  '/usr/share/node-red/node_modules/osi-uc512-normalize/package.json',
  '/usr/share/node-red/node_modules/osi-lsn50-normalize/package.json',
]);

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
      repositoryDev: repository.identityChain.at(-1).dev,
      repositoryIno: repository.identityChain.at(-1).ino,
      statePath: state.path,
      stateExecutionPath: state.executionPath,
      stateDev: state.identityChain.at(-1).dev,
      stateIno: state.identityChain.at(-1).ino,
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
  if (!installation || typeof installation.versionRoot !== 'string' || !isAbsolute(installation.versionRoot) || resolve(installation.versionRoot) !== installation.versionRoot || typeof installation.lockPath !== 'string' || !isAbsolute(installation.lockPath) || resolve(installation.lockPath) !== installation.lockPath || installation.lockPath !== join(installation.versionRoot, 'builder.lock.json') || typeof installation.dependencyEgressProxySha256 !== 'string' || !SHA256.test(installation.dependencyEgressProxySha256) || /^0+$/u.test(installation.dependencyEgressProxySha256)) return false;
  if (typeof lockText !== 'string' || createHash('sha256').update(lockText).digest('hex') !== selection.lockSha256) return false;
  let parsedLock;
  try { parsedLock = JSON.parse(lockText.endsWith('\n') ? lockText.slice(0, -1) : lockText); } catch { return false; }
  if (JSON.stringify(parsedLock) !== (lockText.endsWith('\n') ? lockText.slice(0, -1) : lockText)) return false;
  if (!lock || typeof lock !== 'object' || JSON.stringify(lock) !== JSON.stringify(parsedLock)) return false;
  const requiredLockKeys = ['schemaVersion', 'packageVersion', 'imageRepository', 'imageDigest', 'baseImage', 'baseImageDigest', 'dockerfileSha256', 'packageSet', 'rustConfig', 'nodeVersion', 'executionDefinitionSha256', 'validationEvidenceSha256', 'dependencyEgressProxySha256'];
  const optionalLockKeys = ['installable', 'publisherSha256', 'imageId'];
  const lockKeys = Object.keys(lock);
  if (lockKeys.some((key) => !requiredLockKeys.includes(key) && !optionalLockKeys.includes(key)) || requiredLockKeys.some((key) => !lockKeys.includes(key)) || lock.schemaVersion !== 1 || lock.installable !== true || lock.packageVersion !== selection.packageVersion || typeof lock.imageRepository !== 'string' || !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(lock.imageRepository) || typeof lock.imageDigest !== 'string' || !SHA256.test(lock.imageDigest) || typeof lock.baseImage !== 'string' || !lock.baseImage.endsWith(`@sha256:${lock.baseImageDigest}`)) return false;
  for (const key of ['imageDigest', 'baseImageDigest', 'dockerfileSha256', 'executionDefinitionSha256', 'validationEvidenceSha256', 'dependencyEgressProxySha256', 'publisherSha256', 'imageId']) if (lock[key] !== undefined && (!SHA256.test(lock[key]) || /^0+$/u.test(lock[key]))) return false;
  if (!Array.isArray(lock.packageSet) || lock.packageSet.length !== 7 || new Set(lock.packageSet).size !== 7 || lock.packageSet.some((item) => typeof item !== 'string')) return false;
  if (lock.rustConfig === null || typeof lock.rustConfig !== 'object' || lock.rustConfig.llvmConfig !== '/usr/bin/llvm-config' || lock.rustConfig.channel !== 'stable' || !/^\d+\.\d+\.\d+$/u.test(lock.rustConfig.version) || !Number.isInteger(lock.rustConfig.llvmMajor) || typeof lock.nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(lock.nodeVersion) || Number.parseInt(lock.nodeVersion, 10) < 22) return false;
  return lock.publisherSha256 === selection.publisherSha256 && lock.executionDefinitionSha256 === selection.executionDefinitionSha256 && lock.dependencyEgressProxySha256 === installation.dependencyEgressProxySha256;
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
    const output = await runGuardCommand([`/proc/${process.pid}/fd/${publisherFile.handle.fd}`, '--self-test'], {
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
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

async function runGuardCommand(argv, options) {
  const result = await runSafeCommand({
    argv,
    env: FIXED_ENV,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
  if (result.ok) return result;
  const error = new Error(result.stderr || result.stdout || `command failed with exit code ${result.exitCode}`);
  error.code = result.exitCode;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  throw error;
}

async function defaultInspect(lock) {
  const reference = `${lock.imageRepository}@sha256:${lock.imageDigest}`;
  try {
    const output = await runGuardCommand(['/usr/bin/docker', 'version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
    });
    if (!/^\S+$/u.test(String(output.stdout).trim())) return { available: false, code: 'DOCKER_DAEMON_UNAVAILABLE', detail: 'Docker client is present but daemon did not respond', mutation: 'none' };
    const inspected = await runGuardCommand(['/usr/bin/docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', reference], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    });
    const repoDigests = JSON.parse(String(inspected.stdout));
    return Array.isArray(repoDigests) && repoDigests.every((value) => typeof value === 'string') && repoDigests.includes(reference)
      ? { available: true, repository: lock.imageRepository, digest: lock.imageDigest, repoDigests, mutation: 'none' }
      : { available: false, code: 'IMAGE_DIGEST_MISMATCH', detail: 'Docker did not return the canonical RepoDigest', mutation: 'none' };
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
          || !Array.isArray(inspected.repoDigests) || inspected.repoDigests.some((value) => typeof value !== 'string') || !inspected.repoDigests.includes(reference)) {
          outcome = fail(inspected?.code ?? 'IMAGE_DIGEST_MISMATCH', inspected?.detail ?? 'generated image RepoDigest is not verified', mutationOf(inspected));
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

const JOB_DETAIL_KEYS = Object.freeze([
  'id', 'state', 'branch', 'targetId', 'outputRootId', 'acceptedAt', 'currentStage',
  'queuePosition', 'terminalAt', 'stage', 'pinnedSha', 'cancelRequestedAt', 'artifact',
  'freshnessStatus', 'freshnessCheckedAt', 'newerSourceAvailable', 'error', 'source',
  'output', 'errors', 'cancellation', 'runtime', 'evidence',
]);
const LOCK_REQUIRED_KEYS = Object.freeze([
  'schemaVersion', 'packageVersion', 'imageRepository', 'imageDigest', 'baseImage',
  'baseImageDigest', 'dockerfileSha256', 'packageSet', 'rustConfig', 'nodeVersion',
  'executionDefinitionSha256', 'validationEvidenceSha256', 'dependencyEgressProxySha256',
]);
const NODE_RESOLUTION_PACKAGES = Object.freeze([
  '@grpc/grpc-js', '@chirpstack/chirpstack-api', 'google-protobuf', 'protobufjs',
  'osi-chameleon-helper', 'osi-chirpstack-helper', 'osi-cloud-http', 'osi-db-helper',
  'osi-dendro-helper', 'osi-health-helper', 'osi-history-helper', 'osi-history-sync-helper',
  'osi-lib', 'osi-command-ledger', 'osi-dendro-analytics', 'osi-zone-env',
  'osi-history-router', 'osi-journal', 'osi-device-writer', 'osi-uc512-normalize',
  'osi-lsn50-normalize',
]);
const THIRD_PARTY_PACKAGES = Object.freeze([
  '@grpc/grpc-js', '@chirpstack/chirpstack-api', 'google-protobuf', 'protobufjs',
]);
const RELATIVE_HELPERS = Object.freeze([
  'osi-chameleon-helper', 'osi-chirpstack-helper', 'osi-cloud-http', 'osi-db-helper',
  'osi-dendro-helper', 'osi-health-helper', 'osi-history-helper', 'osi-history-sync-helper',
  'osi-lib',
]);
const DIRECT_HELPERS = Object.freeze([
  'osi-command-ledger', 'osi-dendro-analytics', 'osi-zone-env', 'osi-history-router',
  'osi-journal', 'osi-device-writer', 'osi-uc512-normalize', 'osi-lsn50-normalize',
]);
const ALL_HELPERS = Object.freeze([...RELATIVE_HELPERS, ...DIRECT_HELPERS]);
const NON_HELPER_REQUIRED_RUNTIME_FILES = Object.freeze(
  REQUIRED_RUNTIME_FILES.filter((path) => !path.includes('/node_modules/')),
);
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const SQLITE_SCRIPT = [
  "const { DatabaseSync } = require('node:sqlite');",
  'const db = new DatabaseSync(process.argv[1], { readOnly: true });',
  "const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;",
  "const count = db.prepare('SELECT COUNT(*) AS count FROM chameleon_calibrations').get()?.count;",
  "if (integrity !== 'ok' || !Number.isInteger(count)) process.exit(1);",
  "process.stdout.write(JSON.stringify({ integrity, chameleonCalibrationCount: count }) + '\\n');",
  'db.close();',
].join(' ');
export const NODE_RESOLUTION_SCRIPT = [
  `const modules = ${JSON.stringify([
    ...THIRD_PARTY_PACKAGES.map((packageName) => ({
      packageName,
      specifier: packageName,
      loadSpecifier: packageName === '@chirpstack/chirpstack-api'
        ? '@chirpstack/chirpstack-api/api/application_grpc_pb'
        : packageName,
    })),
    ...RELATIVE_HELPERS.map((packageName) => ({ packageName, specifier: packageName, loadSpecifier: packageName })),
    ...DIRECT_HELPERS.map((packageName) => ({ packageName, specifier: `./${packageName}`, loadSpecifier: `./${packageName}` })),
  ])};`,
  `const thirdPartyPackages = ${JSON.stringify(THIRD_PARTY_PACKAGES)};`,
  "const path = require('node:path'); const fs = require('node:fs'); const { createRequire } = require('node:module'); const rootfs = fs.realpathSync.native(process.cwd()); const nodeRedRoot = path.resolve(rootfs, process.argv[1]); const anchoredRequire = createRequire(path.join(nodeRedRoot, '__osi_verification__.cjs'));",
  "const resolved = Object.fromEntries(modules.map(({ packageName, specifier, loadSpecifier }) => { const physical = fs.realpathSync.native(anchoredRequire.resolve(loadSpecifier)); const within = physical === nodeRedRoot || physical.startsWith(`${nodeRedRoot}${path.sep}`); if (!within) throw new Error(`resolved dependency escapes rootfs node-red: ${packageName}`); const nodeRedRelative = path.relative(nodeRedRoot, physical).split(path.sep).join('/'); const expectedPrefix = thirdPartyPackages.includes(packageName) ? `node_modules/${packageName}/` : `${packageName}/`; if (!nodeRedRelative.startsWith(expectedPrefix)) throw new Error(`resolved dependency changed package identity: ${packageName}`); const relative = path.relative(rootfs, physical).split(path.sep).join('/'); return [packageName, relative]; }));",
  "process.stdout.write(JSON.stringify(Object.fromEntries(Object.keys(resolved).sort().map(name => [name, resolved[name]]))) + '\\n');",
].join(' ');
const COMMAND_POLICIES = Object.freeze({
  short: Object.freeze({ timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }),
  medium: Object.freeze({ timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 }),
  releaseGate: Object.freeze({ timeoutMs: 1_800_000, maxOutputBytes: 8 * 1024 * 1024 }),
});
const BUILD_MANIFEST_KEYS = Object.freeze([
  ...LOCK_REQUIRED_KEYS, 'artifactBasename', 'artifactMtime', 'artifactSha256', 'artifactSize',
  'branch', 'builderLockSha256', 'canonicalImageRef', 'config', 'jobId', 'pinnedSha', 'rootId',
  'rootIdentity', 'source', 'targetId', 'targetManifestSha256', 'tool',
]);
function isCanonicalAbsolute(value) {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value
    && !value.includes('\\') && !value.includes('\0');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
  }
  return false;
}

function canonicalJson(value, newline = true) {
  const encoded = JSON.stringify(stableValue(value));
  return newline ? `${encoded}\n` : encoded;
}

function canonicalText(bytes, label, allowMissingNewline = false) {
  const text = Buffer.from(bytes).toString('utf8');
  if (!allowMissingNewline && !text.endsWith('\n')) throw new Error(`${label} is not canonical JSON`);
  const encoded = text.endsWith('\n') ? text.slice(0, -1) : text;
  let value;
  try { value = JSON.parse(encoded); } catch (error) { throw new Error(`${label} is invalid JSON: ${detail(error)}`); }
  if (canonicalJson(value, text.endsWith('\n')) !== text) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function installerCanonicalText(bytes, label) {
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.endsWith('\n')) throw new Error(`${label} is not canonical JSON`);
  const encoded = text.slice(0, -1);
  let value;
  try { value = JSON.parse(encoded); } catch (error) { throw new Error(`${label} is invalid JSON: ${detail(error)}`); }
  if (`${JSON.stringify(value)}\n` !== text) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function parseJsonLine(text, label) {
  if (typeof text !== 'string' || !text.endsWith('\n')) throw new Error(`${label} output is not newline terminated`);
  try { return JSON.parse(text.slice(0, -1)); } catch (error) { throw new Error(`${label} output is invalid JSON: ${detail(error)}`); }
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\\') || value.includes('\0')) throw new Error(`${label} is not a stable relative path`);
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw new Error(`${label} contains an unsafe component`);
  return parts;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`${label} fields are not exact`);
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT';
}

function statsIdentity(stats) {
  return {
    device: Number(stats.device ?? stats.dev),
    inode: Number(stats.inode ?? stats.ino),
    links: Number(stats.links ?? stats.nlink),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  };
}

function sameStats(left, right) {
  return left.device === right.device && left.inode === right.inode && left.links === right.links
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function requiredAuthorityAdapter(dependencies, name) {
  const adapter = dependencies?.[name];
  if (typeof adapter !== 'function') throw new Error(`${name} authority adapter is missing`);
  return adapter;
}

async function readHeldJson(withNoFollowFile, path, label, allowMissingNewline = false) {
  return withNoFollowFile(path, async (reader) => {
    const bytes = await reader.readFile(MAX_PUBLISHER_BYTES);
    return Object.freeze({ bytes, value: canonicalText(bytes, label, allowMissingNewline) });
  });
}

async function readHeldText(withNoFollowFile, path) {
  return withNoFollowFile(path, async (reader) => reader.readFile(MAX_PUBLISHER_BYTES));
}

async function listArtifactsInHeldDirectory(withHeldDirectory, directory, pattern) {
  const [prefix, suffix] = pattern.split('*');
  if (prefix === undefined || suffix === undefined) throw new Error('artifact glob is invalid');
  return withHeldDirectory(directory, async (authority) => {
    if (typeof authority?.executionPath !== 'string' || authority.executionPath.length === 0) {
      throw new Error('held artifact directory execution path is missing');
    }
    await authority.revalidate();
    const entries = await readdir(authority.executionPath, { withFileTypes: true });
    await authority.revalidate();
    const paths = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
      paths.push(join(directory, entry.name));
    }
    return paths.sort();
  });
}

async function heldDirectoryEntries(withHeldDirectory, directory) {
  return withHeldDirectory(directory, async (authority) => {
    if (typeof authority?.executionPath !== 'string' || authority.executionPath.length === 0) {
      throw new Error('held directory execution path is missing');
    }
    await authority.revalidate();
    const entries = (await readdir(authority.executionPath)).sort();
    await authority.revalidate();
    return entries;
  });
}

function validateGeneratedLock(lock, packageVersion) {
  const optional = ['installable', 'publisherSha256', 'imageId'];
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)
    || Object.keys(lock).some((key) => !LOCK_REQUIRED_KEYS.includes(key) && !optional.includes(key))
    || LOCK_REQUIRED_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(lock, key))
    || lock.schemaVersion !== 1 || !Number.isInteger(lock.schemaVersion) || lock.installable !== true
    || lock.packageVersion !== packageVersion || typeof lock.packageVersion !== 'string'
    || !/^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u.test(lock.packageVersion)
    || typeof lock.imageRepository !== 'string' || !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(lock.imageRepository)
    || typeof lock.imageDigest !== 'string' || !SHA256.test(lock.imageDigest)
    || typeof lock.baseImageDigest !== 'string' || !SHA256.test(lock.baseImageDigest)
    || typeof lock.baseImage !== 'string' || lock.baseImage !== `${lock.baseImage.split('@')[0]}@sha256:${lock.baseImageDigest}`
    || ['dockerfileSha256', 'executionDefinitionSha256', 'validationEvidenceSha256', 'dependencyEgressProxySha256'].some((key) => !SHA256.test(lock[key]) || /^0+$/u.test(lock[key]))
    || !Array.isArray(lock.packageSet) || lock.packageSet.length !== 7 || new Set(lock.packageSet).size !== 7 || lock.packageSet.some((item) => typeof item !== 'string')
    || lock.rustConfig === null || typeof lock.rustConfig !== 'object' || lock.rustConfig.llvmConfig !== '/usr/bin/llvm-config' || lock.rustConfig.channel !== 'stable'
    || typeof lock.rustConfig.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(lock.rustConfig.version) || !Number.isInteger(lock.rustConfig.llvmMajor)
    || typeof lock.nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(lock.nodeVersion) || Number.parseInt(lock.nodeVersion, 10) < 22
    || (lock.publisherSha256 !== undefined && !SHA256.test(lock.publisherSha256))
    || (lock.imageId !== undefined && !SHA256.test(lock.imageId))) return false;
  return true;
}

function validateJobAndDerivePaths(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) throw new Error('acceptance context is invalid');
  if (Object.keys(context).sort().join(',') !== 'branch,job,loadedConfig,outputRootId,pinnedSha,selectedInstallation,targetId') throw new Error('acceptance context fields are not exact');
  if (context.branch !== 'main' || !ROOT_ID_PATTERN.test(context.outputRootId) || !SHA40.test(context.pinnedSha) || (context.targetId !== 'rpi-5' && context.targetId !== 'rpi-2')) throw new Error('acceptance context identity is invalid');
  const loaded = context.loadedConfig;
  const selected = context.selectedInstallation;
  if (loaded === null || typeof loaded !== 'object' || selected === null || typeof selected !== 'object') throw new Error('acceptance authorities are missing');
  if (!isCanonicalAbsolute(loaded.stateRoot) || !isCanonicalAbsolute(loaded.config.repository.path)) throw new Error('acceptance authority paths are invalid');
  if (!isCanonicalAbsolute(selected.versionRoot) || !isCanonicalAbsolute(selected.lockPath) || !isCanonicalAbsolute(selected.manifestPath)) throw new Error('selected installation paths are invalid');
  if (selected.lockPath !== join(selected.versionRoot, 'builder.lock.json') || selected.manifestPath !== join(selected.versionRoot, 'manifest', 'targets.json')) throw new Error('selected installation paths are not derived from its version root');
  if (!Buffer.isBuffer(selected.lockBytes) || !Buffer.isBuffer(selected.manifestBytes) || selected.manifest === null || typeof selected.manifest !== 'object') throw new Error('selected installation evidence is incomplete');
  if (typeof selected.dependencyEgressProxySha256 !== 'string' || !SHA256.test(selected.dependencyEgressProxySha256) || /^0+$/u.test(selected.dependencyEgressProxySha256)
    || selected.dependencyEgressProxySha256 !== selected.lock?.dependencyEgressProxySha256) throw new Error('selected installation proxy evidence is invalid');
  const rawManifest = JSON.parse(selected.manifestBytes.toString('utf8'));
  if (!sameJson(rawManifest, selected.manifest.manifest) || selected.manifest.sha256 !== createHash('sha256').update(selected.manifestBytes).digest('hex')) throw new Error('selected full manifest bytes, hash, and parser result disagree');
  const target = selected.manifest.manifest.targets?.find((candidate) => candidate.id === context.targetId);
  if (target === undefined) throw new Error('selected full manifest has no requested target');
  const approved = loaded.config.approvedOutputRoots?.find((root) => root.id === context.outputRootId);
  if (approved === undefined || !isCanonicalAbsolute(approved.path)) throw new Error('selected approved output root is unavailable');
  const job = context.job;
  exactKeys(job, JOB_DETAIL_KEYS, 'job DTO');
  if (!safeComponent(job.id) || job.state !== 'succeeded' || job.branch !== context.branch || job.targetId !== context.targetId || job.outputRootId !== context.outputRootId
    || job.currentStage !== 'publish' || job.stage !== 'publish' || job.pinnedSha !== context.pinnedSha || job.error !== null) throw new Error('job DTO identity is invalid');
  const acceptedMs = Date.parse(job.acceptedAt);
  if (!Number.isFinite(acceptedMs) || acceptedMs < 1) throw new Error('job acceptedAt is invalid');
  const buildStartEpoch = Math.floor(acceptedMs / 1000);
  const releaseRelative = `${context.branch}/${context.pinnedSha}/${target.id}`;
  const artifact = job.artifact;
  exactKeys(artifact, ['directory', 'mtime', 'path', 'publishState', 'publishedAt', 'rootId', 'sha256', 'size'], 'job artifact');
  if (artifact.rootId !== context.outputRootId || artifact.directory !== releaseRelative || artifact.publishState !== 'published'
    || !SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < target.minimumArtifactBytes || typeof artifact.mtime !== 'string'
    || !Number.isFinite(Date.parse(artifact.mtime)) || Date.parse(artifact.mtime) <= acceptedMs || typeof artifact.path !== 'string') throw new Error('job artifact evidence is invalid');
  const artifactParts = safeRelative(artifact.path, 'job artifact path');
  if (artifactParts.length !== 4 || artifactParts.slice(0, 3).join('/') !== releaseRelative || !artifactParts[3].startsWith(target.artifactGlob.split('*')[0]) || !artifactParts[3].endsWith(target.artifactGlob.split('*')[1])) throw new Error('job artifact path is not bound to the selected target');
  if (!sameJson(job.output, artifact)) throw new Error('job output and artifact disagree');
  if (job.freshnessStatus !== 'fresh' && job.freshnessStatus !== 'advanced' && job.freshnessStatus !== 'unknown') throw new Error('job freshness status is invalid');
  if (job.freshnessStatus !== 'unknown' && job.freshnessCheckedAt === null) throw new Error('job freshness timestamp is missing');
  if (job.freshnessCheckedAt !== null) canonicalInstant(job.freshnessCheckedAt, 'job freshness checkedAt');
  if (typeof job.newerSourceAvailable !== 'boolean'
    || job.newerSourceAvailable !== (job.freshnessStatus === 'advanced')) throw new Error('job freshness newer-source flag is inconsistent');
  if (!Array.isArray(job.evidence) || job.evidence.length !== EVIDENCE_PAIRS.length) throw new Error('job evidence DTO is incomplete');
  EVIDENCE_PAIRS.forEach(([stage, path], index) => {
    const entry = job.evidence[index];
    exactKeys(entry, ['evidenceSha256', 'errorCode', 'finishedAt', 'outcome', 'path', 'stage', 'startedAt'], `job evidence ${stage}`);
    if (entry.stage !== stage || entry.outcome !== 'passed' || entry.path !== `evidence/${path}` || !SHA256.test(entry.evidenceSha256) || entry.errorCode !== null) throw new Error(`job evidence ${stage} is not bound to its fixed stage`);
  });
  const lock = installerCanonicalText(selected.lockBytes, 'selected builder lock');
  if (!sameJson(lock, selected.lock) || !validateGeneratedLock(lock, selected.versionRoot.split('/').at(-1))) throw new Error('selected generated builder lock is invalid');
  const worktree = join(loaded.stateRoot, 'jobs', job.id, 'workspace', 'source');
  const evidenceRoot = join(loaded.stateRoot, 'jobs', job.id, 'evidence');
  const releaseDir = join(approved.path, releaseRelative);
  const targetOutput = join(worktree, 'openwrt', 'bin', 'targets', target.openwrtTarget);
  const rootfs = join(worktree, 'openwrt', target.rootfs);
  const imageName = artifactParts[3];
  return {
    context, loaded, selected, target, job, buildStartEpoch, approvedRoot: approved.path,
    worktree, evidenceRoot, releaseDir, targetOutput, rootfs, imageName,
    buildManifestPath: join(releaseDir, 'build-manifest.json'),
    publishedVerificationPath: join(releaseDir, 'verification.json'),
    publishedChecksumsPath: join(releaseDir, 'sha256sums'),
    reportPath: join(evidenceRoot, 'real-acceptance-report.json'),
    dockerInspectionPath: join(evidenceRoot, 'docker-inspection.json'),
    targetManifestSha256: createHash('sha256').update(selected.manifestBytes).digest('hex'),
    lockSha256: createHash('sha256').update(selected.lockBytes).digest('hex'),
    releaseImage: join(releaseDir, imageName),
    targetImage: join(targetOutput, imageName),
  };
}

function validateReportShape(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('acceptance report is not an object');
  return report;
}

export async function validateAcceptanceReport(input) {
  try { return { ok: true, report: validateReportShape(input?.report) }; }
  catch (error) { return fail('ACCEPTANCE_REPORT_INVALID', detail(error) || 'acceptance report is invalid'); }
}

let cachedRootIdentity;
function stateRootIdentity(state) {
  return state.rootIdentity;
}

async function loadRootIdentity(state, dependencies) {
  return requiredAuthorityAdapter(dependencies, 'statRoot')(state.approvedRoot);
}

function freshnessEvidenceMatchesJob(job, verify) {
  const verifyCheckedAt = verify.freshnessCheckedAt;
  if (job.freshnessStatus === verify.freshnessStatus
    && job.newerSourceAvailable === verify.newerSourceAvailable
    && job.freshnessCheckedAt === verifyCheckedAt) return true;
  return verify.freshnessStatus === 'unknown'
    && verify.freshnessCheckedAt === null
    && (job.freshnessStatus === 'fresh' || job.freshnessStatus === 'advanced' || job.freshnessStatus === 'unknown')
    && job.freshnessCheckedAt !== null;
}

export async function validateStageEvidence(input) {
  try {
    const dependencies = input?.dependencies ?? {};
    const { createTerminalVerification, decodeStoredStageEvidence } = await loadProductionValidators();
    const state = validateJobAndDerivePaths(input?.context);
    const withNoFollowFile = requiredAuthorityAdapter(dependencies, 'withNoFollowFile');
    state.rootIdentity = await loadRootIdentity(state, dependencies);
    const aggregationRead = await withNoFollowFile(state.publishedVerificationPath, async (reader) => {
      const bytes = await reader.readFile(MAX_PUBLISHER_BYTES);
      return Object.freeze({ bytes, value: canonicalText(bytes, 'published verification', true) });
    });
    const terminal = createTerminalVerification(state.job.id, aggregationRead.value);
    if (!Buffer.from(terminal.bytes).equals(aggregationRead.bytes)) throw new Error('published verification is not the exact terminal aggregation');
    const aggregation = terminal.manifest;
    if (aggregation.jobId !== state.job.id || aggregation.targetId !== state.context.targetId || aggregation.branch !== state.context.branch || aggregation.pinnedSha !== state.context.pinnedSha || aggregation.rootId !== state.context.outputRootId) throw new Error('published verification identity is invalid');
    if (!sameJson(aggregation.rootIdentity, stateRootIdentity(state))) throw new Error('published verification root identity is invalid');
    const stageEvidenceSha256 = {};
    const stageObservations = {};
    const stageDocuments = {};
    for (const [stage, relativePath] of EVIDENCE_PAIRS) {
      const evidence = await readHeldJson(withNoFollowFile, join(state.evidenceRoot, relativePath), `${stage} evidence`);
      const decoded = decodeStoredStageEvidence(evidence.value);
      if (decoded.jobId !== state.job.id || decoded.stage !== stage || decoded.outcome !== 'passed'
        || decoded.inputs.targetId !== state.context.targetId || decoded.inputs.rootId !== state.context.outputRootId
        || decoded.inputs.branch !== state.context.branch || decoded.inputs.pinnedSha !== state.context.pinnedSha
        || Object.keys(decoded.observations).length === 0) throw new Error(`${stage} evidence is not bound to the acceptance job`);
      if (decoded.observations.targetOutputAbsent === false) throw new Error('source stage proves target output exists');
      const expectedDto = state.job.evidence[EVIDENCE_PAIRS.findIndex(([, path]) => path === relativePath)];
      if (expectedDto.evidenceSha256 !== createHash('sha256').update(evidence.bytes).digest('hex')) throw new Error(`${stage} evidence hash is not bound to the job DTO`);
      stageEvidenceSha256[relativePath] = expectedDto.evidenceSha256;
      stageObservations[stage] = decoded.observations;
      stageDocuments[stage] = decoded;
    }
    let reportValue;
    if (!input?.allowMissingReport) {
      reportValue = (await readHeldJson(withNoFollowFile, state.reportPath, 'acceptance report')).value;
      exactKeys(reportValue, ['branch', 'generatedAt', 'jobId', 'observations', 'pinnedSha', 'rootId', 'rootIdentity', 'schemaVersion', 'targetId'], 'acceptance report');
      if (reportValue.schemaVersion !== 1 || reportValue.jobId !== state.job.id || reportValue.targetId !== state.context.targetId || reportValue.branch !== state.context.branch || reportValue.pinnedSha !== state.context.pinnedSha || reportValue.rootId !== state.context.outputRootId || !sameJson(reportValue.rootIdentity, state.rootIdentity)) throw new Error('acceptance report identity is invalid');
    }
    const source = stageObservations.source;
    const verify = stageObservations.verify;
    if (source.targetOutputAbsent !== true || !['fresh', 'advanced', 'unknown'].includes(verify.freshnessStatus)) throw new Error('source and verify freshness evidence is invalid');
    if (verify.freshnessCheckedAt !== null) canonicalInstant(verify.freshnessCheckedAt, 'verify freshness checkedAt');
    if (typeof verify.newerSourceAvailable !== 'boolean'
      || verify.newerSourceAvailable !== (verify.freshnessStatus === 'advanced')) throw new Error('source and verify freshness evidence is invalid');
    if (!freshnessEvidenceMatchesJob(state.job, verify)) throw new Error('job DTO freshness is not bound to verify evidence');
    return {
      ok: true,
      observationsOnly: true,
      observations: Object.freeze({
        stageEvidenceSha256: Object.freeze(stageEvidenceSha256),
        sourceEvidenceSha256: stageEvidenceSha256['01-source.json'],
        verifyEvidenceSha256: stageEvidenceSha256['08-verify.json'],
        targetOutputAbsent: source.targetOutputAbsent,
        freshnessStatus: verify.freshnessStatus,
        newerSourceAvailable: verify.newerSourceAvailable,
        publishedVerificationSha256: createHash('sha256').update(aggregationRead.bytes).digest('hex'),
        reportObservationValues: reportValue?.observations,
      }),
      _internal: { state, aggregation, aggregationBytes: aggregationRead.bytes, stageObservations, stageDocuments },
    };
  } catch (error) {
    return fail('STAGE_EVIDENCE_INVALID', detail(error) || 'stage evidence could not be validated', 'unknown');
  }
}

async function artifactFiles(state, dependencies) {
  const listArtifacts = typeof dependencies.listArtifacts === 'function'
    ? dependencies.listArtifacts
    : (directory, pattern) => listArtifactsInHeldDirectory(
      requiredAuthorityAdapter(dependencies, 'withHeldDirectory'),
      directory,
      pattern,
    );
  const release = await listArtifacts(state.releaseDir, state.target.artifactGlob);
  const target = await listArtifacts(state.targetOutput, state.target.artifactGlob);
  if (!Array.isArray(release) || !Array.isArray(target) || release.length !== 1 || target.length !== 1) throw new Error('artifact cardinality is invalid');
  const releasePath = release[0];
  const targetPath = target[0];
  if (!isCanonicalAbsolute(releasePath) || !isCanonicalAbsolute(targetPath) || basename(releasePath) !== state.imageName || basename(targetPath) !== state.imageName) throw new Error('artifact paths are not bound to the selected job');
  return { releasePath, targetPath };
}

async function verifyArtifactPath(path, state, dependencies) {
  const withNoFollowFile = requiredAuthorityAdapter(dependencies, 'withNoFollowFile');
  return withNoFollowFile(path, async (reader) => {
    const heldBefore = await reader.stat();
    const supplied = dependencies.statArtifact === undefined
      ? { regular: true, symlink: false, size: heldBefore.size, mtimeMs: heldBefore.mtimeMs }
      : await dependencies.statArtifact(path);
    const expectedSize = state.job.artifact.size;
    const expectedMtimeMs = Date.parse(state.job.artifact.mtime);
    const canonicalSuppliedMtimeMs = Number.isFinite(supplied?.mtimeMs)
      ? Date.parse(new Date(supplied.mtimeMs).toISOString())
      : NaN;
    if (dependencies.statArtifact !== undefined && (supplied.size !== heldBefore.size || supplied.mtimeMs !== heldBefore.mtimeMs)) throw new Error('independent artifact metadata changed while being held');
    if (supplied?.regular !== true || supplied.symlink === true || !Number.isSafeInteger(supplied.size)
      || supplied.size !== expectedSize || supplied.size < state.target.minimumArtifactBytes
      || !Number.isFinite(supplied.mtimeMs) || !Number.isFinite(expectedMtimeMs)
      || canonicalSuppliedMtimeMs !== expectedMtimeMs
      || supplied.mtimeMs <= state.buildStartEpoch * 1000) throw new Error('artifact metadata is not bound to the job DTO');
    const hash = dependencies.hashFile === undefined ? await reader.hashSha256() : await dependencies.hashFile(path);
    const heldHash = await reader.hashSha256();
    if (!SHA256.test(hash) || hash !== heldHash) throw new Error('artifact hash is not bound to its held bytes');
    const heldAfter = await reader.stat();
    if (!sameStats(heldBefore, heldAfter)) throw new Error('artifact changed while being hashed');
    const current = await withNoFollowFile(path, async (currentReader) => currentReader.stat());
    if (!sameStats(heldBefore, current)) throw new Error('artifact pathname identity changed between stat and hash');
    return Object.freeze({ hash, supplied });
  });
}

export async function verifyTargetArtifact(input) {
  try {
    const dependencies = input?.dependencies ?? {};
    const state = validateJobAndDerivePaths(input?.context);
    state.rootIdentity = await loadRootIdentity(state, dependencies);
    const files = await artifactFiles(state, dependencies);
    const release = await verifyArtifactPath(files.releasePath, state, dependencies);
    const target = await verifyArtifactPath(files.targetPath, state, dependencies);
    if (release.hash !== target.hash || release.hash !== state.job.artifact.sha256) throw new Error('artifact hashes do not match job DTO');
    const checksumBytes = await readHeldText(
      requiredAuthorityAdapter(dependencies, 'withNoFollowFile'),
      state.publishedChecksumsPath,
    );
    const checksumText = checksumBytes.toString('utf8');
    if (checksumText !== `${release.hash}  ${state.imageName}\n`) throw new Error('published checksum is invalid');
    const members = typeof dependencies.listArtifacts === 'function'
      ? await dependencies.listArtifacts(state.releaseDir, '*')
      : (await heldDirectoryEntries(
        requiredAuthorityAdapter(dependencies, 'withHeldDirectory'),
        state.releaseDir,
      )).map((name) => {
        if (!safeComponent(name)) throw new Error('release directory member name is unsafe');
        return join(state.releaseDir, name);
      });
    if (!Array.isArray(members) || members.some((path) => (
      !isCanonicalAbsolute(path) || dirname(path) !== state.releaseDir
    ))) throw new Error('release directory listing is not authority-bound');
    const memberNames = members.map((path) => basename(path)).sort();
    if (!sameJson(memberNames, [state.imageName, 'build-manifest.json', 'sha256sums', 'verification.json'].sort())) throw new Error('release directory members are not exact');
    return {
      ok: true,
      artifactPattern: state.target.artifactGlob,
      cardinality: 1,
      basename: state.imageName,
      imagePath: files.releasePath,
      targetImagePath: files.targetPath,
      sha256: release.hash,
      publishedSha256sumsSha256: createHash('sha256').update(checksumBytes).digest('hex'),
      size: state.job.artifact.size,
      mtime: state.job.artifact.mtime,
      _internal: { state, release, target, checksumBytes },
    };
  } catch (error) {
    return fail('TARGET_ARTIFACT_INVALID', detail(error) || 'target artifact could not be verified');
  }
}

export { assertSafeCommandArgv };

async function checkedCommand(state, dependencies, id, cwdPath, argv, policy) {
  assertSafeCommandArgv(argv);
  const withHeldDirectory = requiredAuthorityAdapter(dependencies, 'withHeldDirectory');
  return withHeldDirectory(cwdPath, async (authority) => {
    await authority.revalidate();
    const request = Object.freeze({ id, cwd: authority.executionPath, argv: Object.freeze([...argv]), env: FIXED_ENV, ...COMMAND_POLICIES[policy] });
    const result = await (dependencies.runCommand ?? runSafeCommand)(request);
    await authority.revalidate();
    if (result === null || typeof result !== 'object' || Array.isArray(result)
      || Object.keys(result).sort().join(',') !== 'exitCode,ok,stderr,stdout'
      || typeof result.ok !== 'boolean' || !Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw new Error(`${id} returned malformed command evidence`);
    if (result.ok !== true || result.exitCode !== 0) throw new Error(`${id} failed: ${result.stderr || result.stdout}`);
    return Object.freeze({ result, executionPath: authority.executionPath });
  });
}

function commandSpecs(state, canonicalImageRef) {
  return [
    ['gzip-test', state.releaseDir, ['gzip', '-t', state.imageName], 'medium'],
    ['git-origin', state.worktree, ['git', 'remote', 'get-url', 'origin'], 'short'],
    ['repo-profile-parity', state.worktree, ['node', 'scripts/verify-profile-parity.js'], 'releaseGate'],
    ['repo-chameleon-calibration', state.worktree, ['node', 'scripts/verify-chameleon-calibration.js'], 'releaseGate'],
    ['repo-db-schema', state.worktree, ['node', 'scripts/verify-db-schema-consistency.js'], 'releaseGate'],
    ['repo-sync-flow', state.worktree, ['node', 'scripts/verify-sync-flow.js'], 'releaseGate'],
    ['repo-strega', state.worktree, ['node', 'scripts/verify-strega-gen1.js'], 'releaseGate'],
    ['repo-communication', state.worktree, ['node', 'scripts/verify-communication-contract.js'], 'releaseGate'],
    ['repo-mqtt-topics', state.worktree, ['scripts/check-mqtt-topics.sh'], 'releaseGate'],
    ['target-sha256sum', state.targetOutput, ['sha256sum', '-c', 'sha256sums'], 'medium'],
    ['published-sha256sum', state.releaseDir, ['sha256sum', '-c', 'sha256sums'], 'medium'],
    ['sqlite-integrity', state.rootfs, ['node', '-e', SQLITE_SCRIPT, 'usr/share/db/farming.db'], 'medium'],
    ['node-dependency-resolution', state.rootfs, ['node', '-e', NODE_RESOLUTION_SCRIPT, 'usr/share/node-red'], 'medium'],
    ['docker-image-inspect', state.worktree, ['docker', 'image', 'inspect', '--format', '{"Id":"{{.Id}}","RepoDigests":{{json .RepoDigests}}}', canonicalImageRef], 'short'],
  ];
}

function parseNodeResolution(stdout, state) {
  const parsed = parseJsonLine(stdout, 'node dependency resolution');
  if (canonicalJson(parsed) !== stdout) throw new Error('node dependency resolution output is not canonical JSON');
  exactKeys(parsed, NODE_RESOLUTION_PACKAGES, 'node dependency resolution');
  const normalized = {};
  for (const name of NODE_RESOLUTION_PACKAGES) {
    const value = parsed[name];
    if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) throw new Error(`node dependency path is invalid: ${name}`);
    const relative = safeRelative(value, `node dependency path: ${name}`).join('/');
    const expectedPrefix = THIRD_PARTY_PACKAGES.includes(name)
      ? `usr/share/node-red/node_modules/${name}/`
      : `usr/share/node-red/${name}/`;
    if (!relative.startsWith(expectedPrefix)) throw new Error(`node dependency path escapes rootfs: ${name}`);
    normalized[name] = relative;
  }
  return normalized;
}

async function verifyCommandSet(state, dependencies, canonicalImageRef) {
  const withHeldDirectory = requiredAuthorityAdapter(dependencies, 'withHeldDirectory');
  await withHeldDirectory(state.worktree, async (authority) => authority.revalidate());
  const values = new Map();
  for (const [id, cwdPath, argv, policy] of commandSpecs(state, canonicalImageRef)) {
    values.set(id, { request: { cwdPath, argv, policy }, ...(await checkedCommand(state, dependencies, id, cwdPath, argv, policy)) });
  }
  const output = (id) => values.get(id).result.stdout;
  if (output('git-origin') !== 'git@github.com:Open-Smart-Irrigation/osi-os.git\n') throw new Error('origin is not the approved SSH repository');
  const sentinels = {
    'repo-profile-parity': 'All parity checks passed.',
    'repo-chameleon-calibration': 'verify-chameleon-calibration PASS',
    'repo-db-schema': 'DB schema consistency verification passed',
    'repo-sync-flow': 'Sync flow verification passed',
    'repo-strega': 'OK Strega Gen1 smoke checks passed',
    'repo-communication': 'Communication contract verification passed',
  };
  for (const [id, sentinel] of Object.entries(sentinels)) if (!output(id).includes(`${sentinel}\n`)) throw new Error(`${id} pass sentinel is missing`);
  for (const path of [
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
    'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
    'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json',
  ]) if (!output('repo-mqtt-topics').includes(`OK: ${path}`)) throw new Error('MQTT topic compliance output is incomplete');
  const checksumLine = `${state.imageName}: OK`;
  validateChecksumCommandOutput(output('target-sha256sum'), checksumLine, 'target sha256sum');
  validateChecksumCommandOutput(output('published-sha256sum'), checksumLine, 'published sha256sum');
  const sqlite = parseJsonLine(output('sqlite-integrity'), 'SQLite integrity');
  exactKeys(sqlite, ['chameleonCalibrationCount', 'integrity'], 'SQLite integrity');
  if (sqlite.integrity !== 'ok' || !Number.isInteger(sqlite.chameleonCalibrationCount) || sqlite.chameleonCalibrationCount < 0) throw new Error('SQLite integrity output is invalid');
  const dependencyValues = parseNodeResolution(output('node-dependency-resolution'), state);
  const inspection = parseJsonLine(output('docker-image-inspect'), 'Docker image inspection');
  exactKeys(inspection, ['Id', 'RepoDigests'], 'Docker image inspection');
  if (!/^sha256:[0-9a-f]{64}$/u.test(inspection.Id)
    || (state.selected.lock.imageId !== undefined && inspection.Id !== `sha256:${state.selected.lock.imageId}`)
    || !Array.isArray(inspection.RepoDigests)
    || inspection.RepoDigests.some((value) => typeof value !== 'string')
    || !inspection.RepoDigests.includes(canonicalImageRef)) throw new Error('Docker image identity is invalid');
  return {
    sqliteIntegrity: sqlite.integrity,
    chameleonCalibrationCount: sqlite.chameleonCalibrationCount,
    nodeResolution: dependencyValues,
    inspection,
    inspectionBytes: Buffer.from(output('docker-image-inspect')),
  };
}

function configLines(target) {
  return target.configSymbols.map((symbol) => symbol.type === 'bool'
    ? `${symbol.name}=${symbol.value ? 'y' : 'n'}`
    : symbol.type === 'string' ? `${symbol.name}="${symbol.value}"` : `${symbol.name}=${symbol.value}`);
}

function validateChecksumCommandOutput(stdout, expectedLine, label) {
  if (typeof stdout !== 'string' || !stdout.endsWith('\n')) throw new Error(`${label} output is malformed`);
  const lines = stdout.slice(0, -1).split('\n');
  if (lines.length < 1 || lines.some((line) => !/^[^:\r\n]+: OK$/u.test(line)) || lines.filter((line) => line === expectedLine).length !== 1) {
    throw new Error(`${label} output is malformed`);
  }
}

function nodeRedDescriptorPath(authority) {
  const value = authority?.descriptorPath;
  if (typeof value !== 'string' || !/^\/proc\/(?:self|\d+)\/fd\/\d+$/u.test(value)) {
    throw new Error('held Node-RED root descriptor is unavailable');
  }
  return value;
}

function nodeRedEntryOwner(stats, ownerUid) {
  return stats.uid === 0n || stats.uid === BigInt(ownerUid);
}

function validateNodeRedDirectory(stats, device, ownerUid, label) {
  if (!trustedProductionDirectory(stats, ownerUid) || stats.dev !== device) {
    throw new Error(`held Node-RED directory is unsafe: ${label}`);
  }
}

function validateNodeRedSymlink(stats, device, ownerUid, label) {
  if (!stats.isSymbolicLink() || stats.dev !== device || stats.nlink !== 1n || !nodeRedEntryOwner(stats, ownerUid)) {
    throw new Error(`held Node-RED symlink is unsafe: ${label}`);
  }
}

function validateNodeRedFile(stats, device, ownerUid, label) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.dev !== device || stats.nlink !== 1n
    || !nodeRedEntryOwner(stats, ownerUid) || (Number(stats.mode) & 0o022) !== 0
    || stats.size < 1n || stats.size > BigInt(MAX_PACKAGE_JSON_BYTES)) {
    throw new Error(`held Node-RED package manifest is unsafe: ${label}`);
  }
}

async function nodeRedHook(dependencies, name, payload) {
  const hook = dependencies?.nodeRedPayloadHooks?.[name];
  if (hook !== undefined) {
    if (typeof hook !== 'function') throw new Error(`Node-RED payload hook is invalid: ${name}`);
    await hook(Object.freeze(payload));
  }
}

async function openHeldNodeRedDirectory(parent, name, relativeName, records, device, mountId, ownerUid, dependencies) {
  const bindingPath = descriptorChild(parent.handle, name);
  const namedBefore = await lstat(bindingPath, { bigint: true });
  validateNodeRedDirectory(namedBefore, device, ownerUid, relativeName);
  let handle;
  try {
    handle = await open(bindingPath, TREE_DIRECTORY_FLAGS);
    const heldBefore = await handle.stat({ bigint: true });
    validateNodeRedDirectory(heldBefore, device, ownerUid, relativeName);
    if (!sameIdentity(namedBefore, heldBefore)) throw new Error(`held Node-RED directory identity changed: ${relativeName}`);
    if (await productionDirectoryMountId(dependencies, handle, { authority: 'node-red', role: 'package-directory', relativePath: relativeName }) !== mountId) {
      throw new Error(`held Node-RED directory crosses a mount boundary: ${relativeName}`);
    }
    const record = { kind: 'directory', handle, before: heldBefore, parent, name, bindingPath, relativeName };
    records.push(record);
    return record;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function openHeldNodeRedFile(parent, name, relativeName, records, device, mountId, ownerUid, dependencies) {
  const bindingPath = descriptorChild(parent.handle, name);
  const namedBefore = await lstat(bindingPath, { bigint: true });
  validateNodeRedFile(namedBefore, device, ownerUid, relativeName);
  let handle;
  try {
    handle = await open(bindingPath, FILE_FLAGS);
    const heldBefore = await handle.stat({ bigint: true });
    validateNodeRedFile(heldBefore, device, ownerUid, relativeName);
    if (!sameIdentity(namedBefore, heldBefore)) throw new Error(`held Node-RED file identity changed: ${relativeName}`);
    if (await productionDirectoryMountId(dependencies, handle, { authority: 'node-red', role: 'package-file', relativePath: relativeName }) !== mountId) {
      throw new Error(`held Node-RED file crosses a mount boundary: ${relativeName}`);
    }
    const record = { kind: 'file', handle, before: heldBefore, parent, name, bindingPath, relativeName };
    records.push(record);
    return record;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function openHeldNodeRedSymlink(parent, name, relativeName, records, device, mountId, ownerUid, dependencies) {
  const bindingPath = descriptorChild(parent.handle, name);
  let handle;
  try {
    handle = await open(bindingPath, HELD_ENTRY_FLAGS);
    const heldBefore = await handle.stat({ bigint: true });
    validateNodeRedSymlink(heldBefore, device, ownerUid, relativeName);
    const namedBefore = await lstat(bindingPath, { bigint: true });
    validateNodeRedSymlink(namedBefore, device, ownerUid, relativeName);
    if (!sameIdentity(namedBefore, heldBefore)) throw new Error(`held Node-RED symlink identity changed: ${relativeName}`);
    if (await productionDirectoryMountId(dependencies, handle, { authority: 'node-red', role: 'helper-symlink', relativePath: relativeName }) !== mountId) {
      throw new Error(`held Node-RED symlink crosses a mount boundary: ${relativeName}`);
    }
    const record = { kind: 'symlink', handle, before: heldBefore, parent, name, bindingPath, relativeName };
    records.push(record);
    return record;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function revalidateHeldNodeRedEntry(record, device, mountId, ownerUid, dependencies) {
  const held = await record.handle.stat({ bigint: true });
  if (record.kind === 'directory') validateNodeRedDirectory(held, device, ownerUid, record.relativeName);
  else if (record.kind === 'file') validateNodeRedFile(held, device, ownerUid, record.relativeName);
  else validateNodeRedSymlink(held, device, ownerUid, record.relativeName);
  if (!sameIdentity(record.before, held)) throw new Error(`held Node-RED entry changed: ${record.relativeName}`);
  if (await productionDirectoryMountId(dependencies, record.handle, { authority: 'node-red', role: 'revalidate-entry', relativePath: record.relativeName }) !== mountId) {
    throw new Error(`held Node-RED entry crossed a mount boundary: ${record.relativeName}`);
  }
  const named = await lstat(record.bindingPath, { bigint: true });
  if (!sameIdentity(record.before, named)) throw new Error(`held Node-RED pathname changed: ${record.relativeName}`);
}

async function assertHeldNodeRedEntryAbsent(parent, name, relativeName) {
  try {
    const metadata = await lstat(descriptorChild(parent.handle, name), { bigint: true });
    throw new Error(`direct helper unexpectedly exists in node_modules: ${relativeName}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readHeldNodeRedPackage(parent, pathComponents, packageName, records, device, mountId, ownerUid, dependencies) {
  let directory = parent;
  let relativeName = '';
  for (const component of pathComponents) {
    relativeName = relativeName === '' ? component : `${relativeName}/${component}`;
    directory = await openHeldNodeRedDirectory(directory, component, relativeName, records, device, mountId, ownerUid, dependencies);
  }
  await nodeRedHook(dependencies, 'beforePackageManifest', { packageName, packagePath: relativeName });
  const manifest = await openHeldNodeRedFile(directory, 'package.json', `${relativeName}/package.json`, records, device, mountId, ownerUid, dependencies);
  const bytes = await readExactHeld(manifest.handle, manifest.before, MAX_PACKAGE_JSON_BYTES, `package manifest ${packageName}`);
  let packageJson;
  try {
    packageJson = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`package manifest is invalid: ${packageName}: ${detail(error)}`);
  }
  if (packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson) || packageJson.name !== packageName) {
    throw new Error(`package identity does not match its path: ${packageName}`);
  }
}

export async function verifyHeldNodeRedPayload(rootfs, authority, dependencies = {}) {
  if (!isCanonicalAbsolute(rootfs)) throw new Error('Node-RED root path is not canonical');
  if (typeof authority?.revalidate !== 'function') throw new Error('held Node-RED authority cannot revalidate');
  const descriptorPath = nodeRedDescriptorPath(authority);
  const ownerUid = currentUid();
  const records = [];
  let root;
  let operationError;
  try {
    await authority.revalidate();
    root = await open(descriptorPath, PROC_DIRECTORY_REOPEN_FLAGS);
    const rootBefore = await root.stat({ bigint: true });
    const rootDevice = rootBefore.dev;
    validateNodeRedDirectory(rootBefore, rootDevice, ownerUid, 'root');
    if (authority.device !== undefined && identityBigInt(authority.device, 'held Node-RED root device') !== rootDevice) throw new Error('held Node-RED root device changed');
    const rootMountId = await productionDirectoryMountId(dependencies, root, { authority: 'node-red', role: 'root', relativePath: '' });
    const rootRecord = { kind: 'directory', handle: root, before: rootBefore, parent: undefined, name: undefined, bindingPath: undefined, relativeName: '.' };
    records.push(rootRecord);
    const nodeModules = await openHeldNodeRedDirectory(rootRecord, 'node_modules', 'node_modules', records, rootDevice, rootMountId, ownerUid, dependencies);

    for (const packageName of THIRD_PARTY_PACKAGES) {
      await readHeldNodeRedPackage(nodeModules, packageName.split('/'), packageName, records, rootDevice, rootMountId, ownerUid, dependencies);
    }
    for (const helper of ALL_HELPERS) {
      await readHeldNodeRedPackage(rootRecord, [helper], helper, records, rootDevice, rootMountId, ownerUid, dependencies);
    }

    for (const helper of RELATIVE_HELPERS) {
      const entry = await openHeldNodeRedSymlink(nodeModules, helper, `node_modules/${helper}`, records, rootDevice, rootMountId, ownerUid, dependencies);
      await nodeRedHook(dependencies, 'beforeHelperSymlinkRead', { helper });
      const target = await readlink(descriptorChild(nodeModules.handle, helper));
      if (target !== `../${helper}`) throw new Error(`relative helper symlink target is invalid: ${helper}`);
      await revalidateHeldNodeRedEntry(entry, rootDevice, rootMountId, ownerUid, dependencies);
    }
    for (const helper of DIRECT_HELPERS) await assertHeldNodeRedEntryAbsent(nodeModules, helper, helper);
    await nodeRedHook(dependencies, 'beforeDirectHelperFinalCheck', { helper: DIRECT_HELPERS[0] });
    for (const helper of DIRECT_HELPERS) await assertHeldNodeRedEntryAbsent(nodeModules, helper, helper);

    for (const record of records.slice().reverse()) {
      if (record !== rootRecord) await revalidateHeldNodeRedEntry(record, rootDevice, rootMountId, ownerUid, dependencies);
    }
    const rootAfter = await root.stat({ bigint: true });
    if (!sameIdentity(rootBefore, rootAfter)) throw new Error('held Node-RED root changed while being checked');
    await authority.revalidate();
  } catch (error) {
    operationError = error;
  }
  const closeHandles = records.slice().reverse().map((record) => record.handle);
  if (root !== undefined && !closeHandles.includes(root)) closeHandles.push(root);
  const closeResults = await Promise.allSettled(closeHandles.map((handle) => handle.close()));
  const closeErrors = closeResults.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (operationError !== undefined || closeErrors.length > 0) {
    const failures = [
      ...(operationError === undefined ? [] : [operationError]),
      ...closeErrors,
    ];
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Node-RED payload inspection and descriptor cleanup failed');
  }
  return Object.freeze({
    packageNames: Object.freeze([...THIRD_PARTY_PACKAGES, ...ALL_HELPERS]),
    relativeHelpers: Object.freeze([...RELATIVE_HELPERS]),
    directHelpers: Object.freeze([...DIRECT_HELPERS]),
  });
}

async function verifyPayload(state, dependencies) {
  const withNoFollowFile = requiredAuthorityAdapter(dependencies, 'withNoFollowFile');
  const withHeldDirectory = requiredAuthorityAdapter(dependencies, 'withHeldDirectory');
  const assertActiveTargetLinks = dependencies.assertActiveTargetLinks
    ?? (await loadProductionValidators()).assertActiveTargetLinks;
  const configBytes = await withHeldDirectory(state.worktree, async (workspace) => {
    if (typeof workspace?.executionPath !== 'string' || workspace.executionPath.length === 0) {
      throw new Error('held source workspace execution path is missing');
    }
    await workspace.revalidate();
    await assertActiveTargetLinks(workspace.executionPath, state.target.environment);
    const bytes = await readHeldText(
      withNoFollowFile,
      join(state.worktree, 'conf', state.target.environment, '.config'),
    );
    await assertActiveTargetLinks(workspace.executionPath, state.target.environment);
    await workspace.revalidate();
    return bytes;
  });
  const configText = configBytes.toString('utf8').split('\n').filter(Boolean);
  for (const line of configLines(state.target)) if (!configText.includes(line)) throw new Error(`missing target config symbol: ${line}`);
  for (const runtimePath of NON_HELPER_REQUIRED_RUNTIME_FILES) {
    await withNoFollowFile(join(state.rootfs, runtimePath.slice(1)), async (reader) => {
      const metadata = await reader.stat();
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.links !== 1) throw new Error(`required rootfs file is invalid: ${runtimePath}`);
    });
  }
  const nodeRedRoot = join(state.rootfs, 'usr/share/node-red');
  await withHeldDirectory(nodeRedRoot, async (authority) => verifyHeldNodeRedPayload(nodeRedRoot, authority, dependencies));
  const routes = (await readHeldText(withNoFollowFile, join(state.rootfs, 'etc/nginx/conf.d/node-red.locations'))).toString('utf8');
  for (const route of ['/gui/', '/auth/', '/api/', '/download/']) if (!new RegExp(`^[\\t ]*location[\\t ]+${route.replace('/', '\\/')}`, 'mu').test(routes)) throw new Error(`required route is missing: ${route}`);
  const sourceFlows = await readHeldText(withNoFollowFile, join(state.worktree, 'conf', state.target.environment, 'files/usr/share/flows.json'));
  const rootfsFlows = await readHeldText(withNoFollowFile, join(state.rootfs, 'usr/share/flows.json'));
  const sourceDb = await readHeldText(withNoFollowFile, join(state.worktree, 'conf', state.target.environment, 'files/usr/share/db/farming.db'));
  const rootfsDb = await readHeldText(withNoFollowFile, join(state.rootfs, 'usr/share/db/farming.db'));
  if (!sourceFlows.equals(rootfsFlows) || !sourceDb.equals(rootfsDb)) throw new Error('source and rootfs payloads differ');
  const hashTree = requiredAuthorityAdapter(dependencies, 'hashTree');
  const feedGui = join(state.worktree, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
  const sourceGui = join(state.worktree, 'web/react-gui/build');
  const rootfsGui = join(state.rootfs, 'usr/lib/node-red/gui');
  const feedGuiTreeSha256 = await hashTree(feedGui);
  const sourceGuiTreeSha256 = await hashTree(sourceGui);
  const rootfsGuiTreeSha256 = await hashTree(rootfsGui);
  if (!SHA256.test(feedGuiTreeSha256) || !SHA256.test(sourceGuiTreeSha256) || !SHA256.test(rootfsGuiTreeSha256) || feedGuiTreeSha256 !== sourceGuiTreeSha256 || sourceGuiTreeSha256 !== rootfsGuiTreeSha256) throw new Error('GUI trees differ');
  const feedTitle = (await readHeldText(withNoFollowFile, join(feedGui, 'index.html'))).toString('utf8').match(/<title>[^<]*<\/title>/u)?.[0];
  const rootfsTitle = (await readHeldText(withNoFollowFile, join(rootfsGui, 'index.html'))).toString('utf8').match(/<title>[^<]*<\/title>/u)?.[0];
  if (feedTitle === undefined || feedTitle !== rootfsTitle) throw new Error('GUI titles differ');
  return {
    sourceFlowsSha256: createHash('sha256').update(sourceFlows).digest('hex'),
    rootfsFlowsSha256: createHash('sha256').update(rootfsFlows).digest('hex'),
    sourceDbSha256: createHash('sha256').update(sourceDb).digest('hex'),
    rootfsDbSha256: createHash('sha256').update(rootfsDb).digest('hex'),
    feedGuiTreeSha256, sourceGuiTreeSha256, rootfsGuiTreeSha256,
  };
}

async function readBuildManifest(state, dependencies, artifact, stage) {
  const withNoFollowFile = requiredAuthorityAdapter(dependencies, 'withNoFollowFile');
  const buildRead = await readHeldJson(withNoFollowFile, state.buildManifestPath, 'build manifest', true);
  const build = buildRead.value;
  exactKeys(build, BUILD_MANIFEST_KEYS, 'build manifest');
  for (const key of LOCK_REQUIRED_KEYS) if (!sameJson(build[key], state.selected.lock[key])) throw new Error(`build manifest lock field differs: ${key}`);
  if (build.builderLockSha256 !== state.lockSha256 || build.canonicalImageRef !== `${state.selected.lock.imageRepository}@sha256:${state.selected.lock.imageDigest}` || build.targetManifestSha256 !== state.targetManifestSha256
    || build.jobId !== state.job.id || build.branch !== state.context.branch || build.pinnedSha !== state.context.pinnedSha || build.targetId !== state.context.targetId || build.rootId !== state.context.outputRootId
    || build.artifactSha256 !== artifact.sha256 || build.artifactSize !== state.job.artifact.size || build.artifactMtime !== state.job.artifact.mtime || build.artifactBasename !== state.imageName) throw new Error('build manifest is not bound to held acceptance identity');
  if (!sameJson(build.rootIdentity, state.rootIdentity)) throw new Error('build manifest root identity differs');
  if (build.source?.branch !== state.context.branch || build.source?.pinnedSha !== state.context.pinnedSha || build.source?.ref !== 'refs/remotes/origin/main') throw new Error('build manifest source identity differs');
  if (build.config?.selectedTarget !== state.target.openwrtTarget || build.config?.profile !== state.target.profile || build.config?.rootfsPartSize !== state.target.rootfsPartSize) throw new Error('build manifest configuration differs');
  if (build.tool?.nodeVersion !== state.selected.lock.nodeVersion || build.tool?.preflight?.evidenceSha256 !== stage.observations.stageEvidenceSha256['00-preflight.json']) throw new Error('build manifest tool evidence differs');
  return Object.freeze({ build, buildBytes: buildRead.bytes });
}

function validateAggregationAgainstBuild(aggregation, build) {
  for (const key of BUILD_MANIFEST_KEYS) if (!sameJson(aggregation[key], build[key])) throw new Error(`terminal aggregation differs from build manifest: ${key}`);
}

async function validateSelectedInstallationBindings(state, dependencies) {
  const withNoFollowFile = requiredAuthorityAdapter(dependencies, 'withNoFollowFile');
  const [lockBytes, manifestBytes] = await Promise.all([
    readHeldText(withNoFollowFile, state.selected.lockPath),
    readHeldText(withNoFollowFile, state.selected.manifestPath),
  ]);
  if (!lockBytes.equals(state.selected.lockBytes) || !manifestBytes.equals(state.selected.manifestBytes)) {
    throw new Error('selected installation pathname bytes changed');
  }
}

function observationValues(state, stage, artifact, identity, payload, commands) {
  const source = stage._internal.stageObservations.source;
  const setup = stage._internal.stageObservations['target-setup'];
  const config = stage._internal.stageObservations.config;
  const resolved = config?.config?.profiles?.[state.context.targetId]?.resolvedSha256;
  const sourceConfig = setup?.profiles?.[state.context.targetId]?.sourceSha256;
  const observations = {
    stageEvidenceSha256: stage.observations.stageEvidenceSha256,
    sourceEvidenceSha256: stage.observations.sourceEvidenceSha256,
    verifyEvidenceSha256: stage.observations.verifyEvidenceSha256,
    targetOutputAbsent: stage.observations.targetOutputAbsent,
    freshnessStatus: stage.observations.freshnessStatus,
    newerSourceAvailable: stage.observations.newerSourceAvailable,
    sourceSha: source.pinnedSha,
    targetId: state.context.targetId,
    targetProfile: state.target.profile,
    targetOpenwrtTarget: state.target.openwrtTarget,
    targetRootfsPartSize: state.target.rootfsPartSize,
    sourceConfigSha256: sourceConfig,
    resolvedConfigSha256: resolved,
    installedLockSha256: state.lockSha256,
    dependencyEgressProxySha256: identity.lock.dependencyEgressProxySha256,
    buildManifestSha256: createHash('sha256').update(identity.buildBytes).digest('hex'),
    publishedImageSha256: artifact.sha256,
    publishedImageSize: artifact.size,
    publishedImageMtime: artifact.mtime,
    dockerInspectionSha256: createHash('sha256').update(commands.inspectionBytes).digest('hex'),
    targetManifestSha256: state.targetManifestSha256,
    publishedSha256sumsSha256: artifact.publishedSha256sumsSha256,
    publishedVerificationSha256: stage.observations.publishedVerificationSha256,
    sourceFlowsSha256: payload.sourceFlowsSha256,
    rootfsFlowsSha256: payload.rootfsFlowsSha256,
    sourceDbSha256: payload.sourceDbSha256,
    rootfsDbSha256: payload.rootfsDbSha256,
    feedGuiTreeSha256: payload.feedGuiTreeSha256,
    sourceGuiTreeSha256: payload.sourceGuiTreeSha256,
    rootfsGuiTreeSha256: payload.rootfsGuiTreeSha256,
    sqliteIntegrity: commands.sqliteIntegrity,
    chameleonCalibrationCount: commands.chameleonCalibrationCount,
    imageDigest: identity.lock.imageDigest,
    imageId: identity.lock.imageId,
    canonicalImageRef: identity.canonicalImageRef,
  };
  for (const key of DIGEST_FIELDS) if (!SHA256.test(observations[key])) throw new Error(`observation digest is invalid: ${key}`);
  if (![observations.sourceConfigSha256, observations.resolvedConfigSha256].every((value) => SHA256.test(value))) throw new Error('configuration observation digest is invalid');
  return Object.freeze(observations);
}

export async function verifyTargetAcceptance(input) {
  try {
    const dependencies = input?.dependencies ?? {};
    const state = validateJobAndDerivePaths(input?.context);
    await validateSelectedInstallationBindings(state, dependencies);
    state.rootIdentity = await loadRootIdentity(state, dependencies);
    const stage = await validateStageEvidence({ context: input.context, dependencies, allowMissingReport: input?.allowMissingReport === true });
    if (stage.ok !== true) return stage;
    const artifact = await verifyTargetArtifact({ context: input.context, dependencies });
    if (artifact.ok !== true) return artifact;
    const identity = {
      lock: state.selected.lock,
      lockBytes: state.selected.lockBytes,
      canonicalImageRef: `${state.selected.lock.imageRepository}@sha256:${state.selected.lock.imageDigest}`,
      targetManifestBytes: state.selected.manifestBytes,
      build: undefined,
      buildBytes: undefined,
      rootIdentity: state.rootIdentity,
    };
    const build = await readBuildManifest(state, dependencies, artifact, stage);
    identity.build = build.build;
    identity.buildBytes = build.buildBytes;
    validateAggregationAgainstBuild(stage._internal.aggregation, build.build);
    const payload = await verifyPayload(state, dependencies);
    const commands = await verifyCommandSet(state, dependencies, identity.canonicalImageRef);
    const observations = observationValues(state, stage, artifact, identity, payload, commands);
    if (stage.observations.reportObservationValues !== undefined && !sameJson(stage.observations.reportObservationValues, observations)) throw new Error('published report observations do not match fresh verification');
    const success = { ok: true, targetId: state.context.targetId, observations, mutation: 'none' };
    Object.defineProperty(success, '_internal', { value: { state, stage, artifact, identity, payload, commands }, enumerable: false });
    return success;
  } catch (error) {
    return fail('TARGET_ACCEPTANCE_FAILED', detail(error) || 'target acceptance failed', 'unknown');
  }
}

function validateAcceptancePublication(publication, jobId, basenameValue, contents) {
  if (publication === null || typeof publication !== 'object' || Array.isArray(publication)) throw new Error('acceptance evidence publication is malformed');
  exactKeys(publication, ['bytes', 'device', 'mode', 'path', 'regular', 'sha256', 'singleLink', 'size'], 'acceptance evidence publication');
  const expectedPath = `jobs/${jobId}/evidence/${basenameValue}`;
  if (publication.path !== expectedPath || !Buffer.isBuffer(publication.bytes) || !publication.bytes.equals(contents) || publication.sha256 !== createHash('sha256').update(contents).digest('hex') || publication.regular !== true || publication.singleLink !== true || publication.mode !== 0o600 || publication.size !== contents.length) throw new Error('acceptance evidence publication is not a verified held snapshot');
  return publication;
}

async function publishAcceptanceEvidence(dependencies, state, basenameValue, contents) {
  if (typeof dependencies.publishAcceptanceEvidence !== 'function') throw new Error('acceptance evidence publisher is missing');
  const publication = await dependencies.publishAcceptanceEvidence({
    jobId: state.job.id,
    relativePath: basenameValue,
    contents: Buffer.from(contents),
  });
  return validateAcceptancePublication(publication, state.job.id, basenameValue, Buffer.from(contents));
}

function createVerifiedSealExpectation(internal, observations) {
  const state = internal.state;
  const definitions = [
    {
      relativeName: state.imageName,
      sha256: observations.publishedImageSha256,
      size: observations.publishedImageSize,
    },
    {
      relativeName: 'build-manifest.json',
      sha256: observations.buildManifestSha256,
      size: internal.identity.buildBytes.length,
    },
    {
      relativeName: 'verification.json',
      sha256: observations.publishedVerificationSha256,
      size: internal.stage._internal.aggregationBytes.length,
    },
    {
      relativeName: 'sha256sums',
      sha256: observations.publishedSha256sumsSha256,
      size: internal.artifact._internal.checksumBytes.length,
    },
  ];
  const exactDigests = [
    createHash('sha256').update(internal.identity.buildBytes).digest('hex'),
    createHash('sha256').update(internal.stage._internal.aggregationBytes).digest('hex'),
    createHash('sha256').update(internal.artifact._internal.checksumBytes).digest('hex'),
  ];
  if (definitions[0].sha256 !== state.job.artifact.sha256
    || definitions[0].size !== state.job.artifact.size
    || definitions.slice(1).some((member, index) => member.sha256 !== exactDigests[index])
    || definitions.some((member) => !safeComponent(member.relativeName) || !SHA256.test(member.sha256)
      || !Number.isSafeInteger(member.size) || member.size < 1)) {
    throw new Error('verified seal expectation disagrees with acceptance evidence');
  }
  return Object.freeze({
    targetId: state.context.targetId,
    outputRootId: state.context.outputRootId,
    pinnedSha: state.context.pinnedSha,
    rootIdentity: Object.freeze({
      device: Number(state.rootIdentity.device),
      inode: Number(state.rootIdentity.inode),
    }),
    members: Object.freeze(definitions.map((member) => Object.freeze(member))),
  });
}

export async function buildAcceptanceReport(input) {
  try {
    const verified = await verifyTargetAcceptance({ ...input, allowMissingReport: true });
    if (verified.ok !== true) return verified;
    const internal = verified._internal;
    const state = internal.state;
    const dockerBytes = internal.commands.inspectionBytes;
    const reportBytes = Buffer.from(canonicalJson({
      schemaVersion: 1,
      targetId: state.context.targetId,
      jobId: state.job.id,
      branch: state.context.branch,
      pinnedSha: state.context.pinnedSha,
      rootId: state.context.outputRootId,
      rootIdentity: state.rootIdentity,
      generatedAt: state.job.terminalAt,
      observations: verified.observations,
    }));
    const dockerInspectionEvidence = await publishAcceptanceEvidence(input.dependencies ?? {}, state, 'docker-inspection.json', dockerBytes);
    const reportEvidence = await publishAcceptanceEvidence(input.dependencies ?? {}, state, 'real-acceptance-report.json', reportBytes);
    const reopen = requiredAuthorityAdapter(input.dependencies, 'withNoFollowFile');
    await reopen(state.reportPath, async (reader) => {
      const reopened = await reader.readFile(MAX_PUBLISHER_BYTES);
      if (!reopened.equals(reportEvidence.bytes) || createHash('sha256').update(reopened).digest('hex') !== reportEvidence.sha256) throw new Error('acceptance report changed after publication');
    });
    const success = {
      ok: true,
      targetId: state.context.targetId,
      observations: verified.observations,
      mutation: 'committed',
      reportEvidence,
      dockerInspectionEvidence,
    };
    Object.defineProperty(success, '_sealExpectation', {
      value: createVerifiedSealExpectation(internal, verified.observations),
      enumerable: false,
    });
    return success;
  } catch (error) {
    return fail('ACCEPTANCE_REPORT_BUILD_FAILED', detail(error) || 'acceptance report could not be built', 'unknown');
  }
}

const LOCAL_API_BASE_URL = 'http://127.0.0.1:43120';
const API_REQUEST_TIMEOUT_MS = 10_000;
const ENQUEUE_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

function validateRealEnvironment(env, context) {
  if (env?.OSI_IMAGE_BUILDER_REAL !== '1') throw new Error('OSI_IMAGE_BUILDER_REAL=1 is required');
  const targetId = context?.targetId;
  if (typeof targetId !== 'string' || (targetId !== 'rpi-5' && targetId !== 'rpi-2')) throw new Error('acceptance target is invalid');
  if (typeof env.OSI_IMAGE_BUILDER_APPROVED_ROOT_ID !== 'string' || !ROOT_ID_PATTERN.test(env.OSI_IMAGE_BUILDER_APPROVED_ROOT_ID)) throw new Error('approved root ID is invalid');
  if (typeof env.OSI_IMAGE_BUILDER_PINNED_SHA !== 'string' || !SHA40.test(env.OSI_IMAGE_BUILDER_PINNED_SHA)) throw new Error('pinned SHA is invalid');
  if (env.OSI_IMAGE_BUILDER_APPROVED_ROOT_ID !== context?.outputRootId) throw new Error('approved root ID does not match acceptance context');
  if (env.OSI_IMAGE_BUILDER_PINNED_SHA !== context?.pinnedSha) throw new Error('pinned SHA does not match acceptance context');
  if (env.OSI_IMAGE_BUILDER_TARGET !== undefined && env.OSI_IMAGE_BUILDER_TARGET !== targetId) throw new Error('acceptance target does not match environment');
}

function validateAcceptanceContext(context) {
  exactKeys(context, ['branch', 'job', 'loadedConfig', 'outputRootId', 'pinnedSha', 'selectedInstallation', 'targetId'], 'acceptance context');
  if (context.branch !== 'main' || !ROOT_ID_PATTERN.test(context.outputRootId) || !SHA40.test(context.pinnedSha)
    || (context.targetId !== 'rpi-5' && context.targetId !== 'rpi-2')) throw new Error('acceptance context identity is invalid');
  const selected = context.selectedInstallation;
  const loaded = context.loadedConfig;
  if (selected === null || typeof selected !== 'object' || loaded === null || typeof loaded !== 'object') throw new Error('acceptance context authorities are missing');
  if (!isCanonicalAbsolute(selected.versionRoot) || !isCanonicalAbsolute(selected.lockPath) || !isCanonicalAbsolute(selected.manifestPath)
    || selected.lockPath !== join(selected.versionRoot, 'builder.lock.json')
    || selected.manifestPath !== join(selected.versionRoot, 'manifest', 'targets.json')) throw new Error('acceptance context installation paths are invalid');
  if (!Buffer.isBuffer(selected.lockBytes) || !Buffer.isBuffer(selected.manifestBytes) || selected.manifest === null || typeof selected.manifest !== 'object') throw new Error('acceptance context installation evidence is incomplete');
  if (!isCanonicalAbsolute(loaded.stateRoot) || !isCanonicalAbsolute(loaded.config?.repository?.path)) throw new Error('acceptance context authority paths are invalid');
  const root = loaded.config?.approvedOutputRoots?.find((candidate) => candidate.id === context.outputRootId);
  if (root === undefined || !isCanonicalAbsolute(root.path)) throw new Error('acceptance context output root is invalid');
  if (!context.selectedInstallation.manifest.manifest?.targets?.some((target) => target.id === context.targetId)) throw new Error('acceptance context target is not installed');
  return context;
}

function apiRequest(method, path, body, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  const request = {
    method,
    baseUrl: LOCAL_API_BASE_URL,
    path,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: LOCAL_API_BASE_URL,
    },
    timeoutMs,
    ...(body === undefined ? {} : { body }),
  };
  return Object.freeze(request);
}

function parseApiJson(body, label) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
    let text;
    try {
      text = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (error) {
      throw new Error(`${label} bytes are not valid UTF-8: ${detail(error)}`);
    }
    try { return JSON.parse(text); } catch (error) { throw new Error(`${label} is invalid JSON: ${detail(error)}`); }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${label} body is malformed`);
  return body;
}

export async function defaultApiRequest(request, http = { request: nodeHttpRequest }) {
  if (!(request.signal instanceof AbortSignal)) throw new Error('loopback HTTP request signal is missing');
  if (request.signal.aborted) throw new Error('loopback HTTP request was aborted before opening');
  const url = new URL(request.path, request.baseUrl);
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.origin !== request.baseUrl
    || `${url.pathname}${url.search}` !== request.path
  ) {
    throw new Error('loopback HTTP request URL is invalid');
  }
  const body = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), 'utf8');
  return new Promise((resolve, reject) => {
    let settled = false;
    let outbound;
    let response;
    let responseEnded = false;
    let responseData;
    let responseEnd;
    let responseClose;
    let responseAborted;
    let responseError;
    let outboundError;
    const removeResponseDataListeners = () => {
      if (response === undefined) return;
      if (responseData !== undefined) response.removeListener('data', responseData);
      if (responseEnd !== undefined) response.removeListener('end', responseEnd);
      if (responseAborted !== undefined) response.removeListener('aborted', responseAborted);
    };
    const removeResponseListeners = () => {
      if (response === undefined) return;
      removeResponseDataListeners();
      if (responseClose !== undefined) response.removeListener('close', responseClose);
      if (responseError !== undefined) response.removeListener('error', responseError);
    };
    const removeOutboundListener = () => {
      if (outbound !== undefined && outboundError !== undefined) outbound.removeListener('error', outboundError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', abort);
      removeResponseDataListeners();
      removeOutboundListener();
      reject(error);
    };
    const abort = () => {
      const error = new Error('loopback HTTP request was aborted');
      fail(error);
      outbound?.destroy();
      response?.destroy();
    };
    const failResponse = (error) => {
      fail(error);
      response?.destroy();
    };
    const onResponseClose = () => {
      if (!responseEnded) failResponse(new Error('loopback HTTP response closed before end'));
      removeResponseListeners();
    };
    try {
      outbound = http.request(url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        agent: false,
      }, (incoming) => {
        response = incoming;
        responseClose = onResponseClose;
        responseError = (error) => {
          if (!responseEnded) failResponse(error);
        };
        response.on('close', responseClose);
        response.once('error', responseError);
        if (settled) {
          response.destroy();
          return;
        }
        const status = response.statusCode;
        if (!Number.isInteger(status)) {
          failResponse(new Error('loopback HTTP response status is missing'));
          return;
        }
        const declaredLength = response.headers['content-length'];
        if (declaredLength !== undefined && (
          typeof declaredLength !== 'string'
          || !/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
          || BigInt(declaredLength) > BigInt(MAX_API_RESPONSE_BYTES)
        )) {
          failResponse(new Error('loopback HTTP response exceeds the size limit'));
          return;
        }
        const chunks = [];
        let size = 0;
        responseData = (chunk) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_API_RESPONSE_BYTES) {
            failResponse(new Error('loopback HTTP response exceeds the size limit'));
            return;
          }
          chunks.push(bytes);
        };
        responseAborted = () => failResponse(new Error('loopback HTTP response closed before end'));
        responseEnd = () => {
          if (settled) return;
          responseEnded = true;
          removeResponseDataListeners();
          settled = true;
          request.signal.removeEventListener('abort', abort);
          removeOutboundListener();
          resolve({ status, body: Buffer.concat(chunks, size) });
        };
        response.on('data', responseData);
        response.once('aborted', responseAborted);
        response.once('end', responseEnd);
      });
      outboundError = (error) => {
        if (response !== undefined && !responseEnded) {
          failResponse(new Error('loopback HTTP response closed before end'));
        } else {
          fail(error);
        }
      };
      outbound.once('error', outboundError);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      outbound.end(body);
    } catch (error) {
      fail(error);
    }
  });
}

function createFixedDeadline(dependencies, timeoutMs, label) {
  const controller = dependencies?.createDeadlineController === undefined
    ? new AbortController()
    : dependencies.createDeadlineController(label);
  if (!(controller instanceof AbortController)) throw new Error(`${label} deadline controller is invalid`);
  const deadline = {
    label,
    logicalExpiresAt: clockMilliseconds(dependencies) + timeoutMs,
    wallExpiresAt: Date.now() + timeoutMs,
    controller,
    timer: setTimeout(() => controller.abort(), timeoutMs),
  };
  return deadline;
}

function closeFixedDeadline(deadline) {
  clearTimeout(deadline.timer);
}

function remainingDeadlineMilliseconds(dependencies, deadline) {
  return Math.min(
    deadline.logicalExpiresAt - clockMilliseconds(dependencies),
    deadline.wallExpiresAt - Date.now(),
  );
}

function requestWithSignal(request, signal) {
  const value = { ...request };
  Object.defineProperty(value, 'signal', {
    value: signal,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(value);
}

async function requestApi(dependencies, request, label, parentDeadline) {
  const transport = dependencies?.http?.request ?? defaultApiRequest;
  if (typeof transport !== 'function') throw new Error('loopback HTTP transport is invalid');
  const startedAt = clockMilliseconds(dependencies);
  const parentRemaining = parentDeadline === undefined
    ? Number.POSITIVE_INFINITY
    : remainingDeadlineMilliseconds(dependencies, parentDeadline);
  const timeoutMs = Math.min(request.timeoutMs, parentRemaining);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error(`${label} request timed out`);
  const logicalExpiresAt = startedAt + timeoutMs;
  const wallExpiresAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  const parentSignal = parentDeadline?.controller.signal;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadlineFailure = new Promise((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new Error(`${label} request timed out`)),
      { once: true },
    );
  });
  let response;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => transport(requestWithSignal(request, controller.signal))),
      deadlineFailure,
    ]);
    if (clockMilliseconds(dependencies) >= logicalExpiresAt || Date.now() >= wallExpiresAt
      || (parentDeadline !== undefined && remainingDeadlineMilliseconds(dependencies, parentDeadline) <= 0)) {
      controller.abort();
      throw new Error(`${label} request timed out`);
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
  if (response === null || typeof response !== 'object' || Array.isArray(response) || !Number.isInteger(response.status)) throw new Error(`${label} response is malformed`);
  if (response.status < 200 || response.status >= 300) throw new Error(`${label} returned HTTP ${response.status}`);
  return parseApiJson(response.body, label);
}

function canonicalInstant(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new Error(`${label} is not canonical`);
  return Date.parse(value);
}

function validateBranchRefresh(body, pinnedSha) {
  exactKeys(body, ['branches', 'fetchedAt'], 'branch refresh response');
  canonicalInstant(body.fetchedAt, 'branch refresh fetchedAt');
  if (!Array.isArray(body.branches)) throw new Error('branch refresh branches are malformed');
  const mains = [];
  for (const branch of body.branches) {
    exactKeys(branch, ['commitTime', 'name', 'sha', 'subject'], 'branch refresh entry');
    if (typeof branch.name !== 'string' || branch.name.length === 0 || !SHA40.test(branch.sha) || typeof branch.subject !== 'string') throw new Error('branch refresh entry is malformed');
    canonicalInstant(branch.commitTime, 'branch refresh commitTime');
    if (branch.name === 'main') mains.push(branch);
  }
  if (mains.length !== 1 || mains[0].sha !== pinnedSha) throw new Error('refreshed main does not match the pinned SHA');
}

async function loadPreflightCheckIds() {
  const validators = await loadProductionValidators();
  if (!Array.isArray(validators.PREFLIGHT_CHECK_IDS) || validators.PREFLIGHT_CHECK_IDS.length !== 18) throw new Error('production preflight check IDs are unavailable');
  return validators.PREFLIGHT_CHECK_IDS;
}

async function loadJobStateClassification() {
  const validators = await loadProductionValidators();
  if (!Array.isArray(validators.JOB_STATES) || !Array.isArray(validators.TERMINAL_STATES)
    || typeof validators.isTerminalState !== 'function') throw new Error('production job state classification is unavailable');
  const jobStates = new Set(validators.JOB_STATES);
  const terminalStates = new Set(validators.TERMINAL_STATES);
  if (jobStates.size !== validators.JOB_STATES.length || terminalStates.size !== validators.TERMINAL_STATES.length
    || [...terminalStates].some((state) => !jobStates.has(state))
    || [...jobStates].some((state) => validators.isTerminalState(state) !== terminalStates.has(state))) {
    throw new Error('production job state classification is inconsistent');
  }
  return Object.freeze({
    jobStates,
    isTerminalState: validators.isTerminalState,
  });
}

function validatePreflight(body, pinnedSha, targetId, clockNow, checkIds) {
  exactKeys(body, ['checks', 'expiresAt', 'observedSha', 'preflightId'], 'preflight response');
  if (typeof body.preflightId !== 'string' || !/^pf_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(body.preflightId)) throw new Error('preflight ID is invalid');
  if (body.observedSha !== pinnedSha) throw new Error('preflight observed SHA does not match the pinned SHA');
  if (canonicalInstant(body.expiresAt, 'preflight expiry') <= clockNow) throw new Error('preflight has expired');
  if (!Array.isArray(body.checks) || body.checks.length !== checkIds.length) throw new Error('preflight checks are incomplete');
  body.checks.forEach((check, index) => {
    exactKeys(check, ['details', 'id', 'status'], 'preflight check');
    if (check.id !== checkIds[index] || check.status !== 'passed' || check.details === null || typeof check.details !== 'object' || Array.isArray(check.details)) throw new Error('preflight check is invalid');
  });
}

function validateQueuedJob(body, selection) {
  exactKeys(body, ['job'], 'queued job response');
  exactKeys(body.job, ['branch', 'id', 'outputRootId', 'queuePosition', 'state', 'targetId'], 'queued job');
  if (!safeComponent(body.job.id) || body.job.state !== 'queued' || body.job.branch !== selection.branch || body.job.targetId !== selection.targetId || body.job.outputRootId !== selection.outputRootId
    || !(body.job.queuePosition === null || (Number.isSafeInteger(body.job.queuePosition) && body.job.queuePosition >= 0))) throw new Error('queued job identity is invalid');
  return body.job.id;
}

function clockMilliseconds(dependencies) {
  const value = dependencies?.clock?.now === undefined ? Date.now() : dependencies.clock.now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error('acceptance clock is invalid');
  return milliseconds;
}

function pollBounds(poll) {
  const intervalMs = poll?.intervalMs ?? 1_000;
  // Twelve hours covers the manifest's six-hour build stage plus every other stage.
  const timeoutMs = poll?.timeoutMs ?? 12 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < intervalMs || timeoutMs > 24 * 60 * 60 * 1_000) throw new Error('poll bounds are invalid');
  return { intervalMs, timeoutMs };
}

async function sleepWithinDeadline(dependencies, sleep, intervalMs, deadline) {
  const remaining = remainingDeadlineMilliseconds(dependencies, deadline);
  if (remaining <= 0) throw new Error('job polling timed out');
  const duration = Math.min(intervalMs, Math.max(1, Math.floor(remaining)));
  let rejectDeadline;
  const abortSleep = () => rejectDeadline(new Error('job polling timed out'));
  const deadlineFailure = new Promise((_, reject) => {
    rejectDeadline = reject;
    deadline.controller.signal.addEventListener('abort', abortSleep, { once: true });
    if (deadline.controller.signal.aborted) abortSleep();
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => sleep(duration, { signal: deadline.controller.signal })),
      deadlineFailure,
    ]);
    if (remainingDeadlineMilliseconds(dependencies, deadline) <= 0) throw new Error('job polling timed out');
  } finally {
    deadline.controller.signal.removeEventListener('abort', abortSleep);
  }
}

async function pollTerminalJob(dependencies, jobId, context, poll, classification) {
  const { intervalMs, timeoutMs } = pollBounds(poll);
  const sleep = dependencies?.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = createFixedDeadline(dependencies, timeoutMs, 'job polling');
  try {
    for (;;) {
      if (remainingDeadlineMilliseconds(dependencies, deadline) <= 0) throw new Error('job polling timed out');
      const body = await requestApi(
        dependencies,
        apiRequest('GET', `/api/jobs/${jobId}`),
        'job status',
        deadline,
      );
      if (body === null || typeof body !== 'object' || Array.isArray(body) || body.id !== jobId || typeof body.state !== 'string'
        || !classification.jobStates.has(body.state)) throw new Error('job status DTO is malformed');
      if (classification.isTerminalState(body.state)) {
        if (body.state === 'succeeded') return body;
        throw new Error(`job ended in ${body.state}`);
      }
      if (body.branch !== context.branch || body.targetId !== context.targetId || body.outputRootId !== context.outputRootId) throw new Error('active job identity is invalid');
      await sleepWithinDeadline(dependencies, sleep, intervalMs, deadline);
    }
  } finally {
    closeFixedDeadline(deadline);
  }
}

const SEAL_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC;
const SEAL_HASH_CHUNK_BYTES = 1024 * 1024;

function sealIdentity(stats, label) {
  const identity = {
    device: Number(stats.dev),
    inode: Number(stats.ino),
    links: Number(stats.nlink),
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs?.toString(),
    ctimeNs: stats.ctimeNs?.toString(),
  };
  if ([identity.device, identity.inode, identity.links, identity.size]
    .some((value) => !Number.isSafeInteger(value) || value < 0)
    || !/^\d+$/u.test(identity.mtimeNs) || !/^\d+$/u.test(identity.ctimeNs)) {
    throw new Error(`${label} identity is invalid`);
  }
  return identity;
}

function sameSealIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode
    && left.links === right.links && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameSealIdentityAfterChmod(left, right) {
  return left.device === right.device && left.inode === right.inode
    && left.links === right.links && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function sealMode(stats) {
  return Number(stats.mode) & 0o7777;
}

function validateSealMetadata(stats, kind, label) {
  if ((kind === 'file' && !stats.isFile()) || (kind === 'directory' && !stats.isDirectory())
    || stats.isSymbolicLink() || (kind === 'file' && Number(stats.nlink) !== 1)
    || (kind === 'directory' && Number(stats.nlink) < 1)) throw new Error(`${label} metadata is unsafe`);
}

async function validateHeldSealEntry(entry, expectedMode) {
  const heldStats = await entry.handle.stat({ bigint: true });
  validateSealMetadata(heldStats, entry.kind, entry.relativeName);
  if (!sameSealIdentity(sealIdentity(heldStats, entry.relativeName), entry.identity) || sealMode(heldStats) !== expectedMode) throw new Error(`${entry.relativeName} descriptor changed during sealing`);
  const namedStats = await lstat(entry.bindingPath, { bigint: true });
  validateSealMetadata(namedStats, entry.kind, entry.relativeName);
  if (!sameSealIdentity(sealIdentity(namedStats, entry.relativeName), entry.identity) || sealMode(namedStats) !== expectedMode) throw new Error(`${entry.relativeName} pathname changed during sealing`);
}

async function refreshSealEntryAfterChmod(entry, priorIdentity, mode) {
  const heldStats = await entry.handle.stat({ bigint: true });
  const namedStats = await lstat(entry.bindingPath, { bigint: true });
  validateSealMetadata(heldStats, entry.kind, entry.relativeName);
  validateSealMetadata(namedStats, entry.kind, entry.relativeName);
  const heldIdentity = sealIdentity(heldStats, entry.relativeName);
  const namedIdentity = sealIdentity(namedStats, entry.relativeName);
  if (!sameSealIdentityAfterChmod(priorIdentity, heldIdentity)
    || !sameSealIdentity(heldIdentity, namedIdentity)
    || sealMode(heldStats) !== mode || sealMode(namedStats) !== mode) {
    throw new Error(`${entry.relativeName} changed during descriptor chmod`);
  }
  entry.identity = heldIdentity;
}

async function chmodSealEntry(dependencies, entry, mode, revalidateAuthority) {
  const priorIdentity = entry.identity;
  const request = Object.freeze({
    handle: entry.handle,
    kind: entry.kind,
    relativeName: entry.relativeName,
    mode,
  });
  if (typeof dependencies.chmodDescriptor === 'function') await dependencies.chmodDescriptor(request);
  else await request.handle.chmod(mode);
  await refreshSealEntryAfterChmod(entry, priorIdentity, mode);
  entry.mode = mode;
  await revalidateAuthority();
}

async function hashHeldSealFile(handle, size, label) {
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(SEAL_HASH_CHUNK_BYTES, Math.max(1, size)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead < 1) throw new Error(`${label} ended before its held size`);
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex');
}

function validateReopenedFile(snapshot, entry, outputDevice) {
  exactKeys(snapshot, ['ctimeNs', 'device', 'inode', 'kind', 'links', 'mode', 'mtimeNs', 'path', 'regular', 'relativeName', 'sha256', 'singleLink', 'size'], `reopened ${entry.relativeName}`);
  if (snapshot.relativeName !== entry.relativeName || snapshot.path !== entry.path || snapshot.kind !== 'file'
    || snapshot.regular !== true || snapshot.singleLink !== true || snapshot.device !== outputDevice
    || snapshot.inode !== entry.identity.inode || snapshot.links !== entry.identity.links
    || snapshot.mode !== 0o444 || snapshot.size !== entry.identity.size
    || snapshot.mtimeNs !== entry.identity.mtimeNs || snapshot.ctimeNs !== entry.identity.ctimeNs
    || snapshot.sha256 !== entry.sha256) throw new Error(`reopened ${entry.relativeName} snapshot is invalid`);
}

function validateReopenedDirectory(snapshot, entry, outputDevice) {
  exactKeys(snapshot, ['ctimeNs', 'device', 'inode', 'kind', 'links', 'mode', 'mtimeNs', 'path', 'regular', 'relativeName', 'singleLink', 'size'], `reopened ${entry.relativeName}`);
  if (snapshot.relativeName !== entry.relativeName || snapshot.path !== entry.path || snapshot.kind !== 'directory'
    || snapshot.regular !== false || snapshot.singleLink !== true || snapshot.device !== outputDevice
    || snapshot.inode !== entry.identity.inode || snapshot.links !== entry.identity.links
    || snapshot.mode !== 0o555 || snapshot.size !== entry.identity.size
    || snapshot.mtimeNs !== entry.identity.mtimeNs || snapshot.ctimeNs !== entry.identity.ctimeNs) {
    throw new Error(`reopened ${entry.relativeName} snapshot is invalid`);
  }
}

async function openSealDirectoryBinding(parent, relativeName, path, outputDevice) {
  const bindingPath = descriptorChild(parent, relativeName);
  const namedStats = await lstat(bindingPath, { bigint: true });
  validateSealMetadata(namedStats, 'directory', relativeName);
  const handle = await open(bindingPath, SEAL_DIRECTORY_FLAGS);
  try {
    const heldStats = await handle.stat({ bigint: true });
    validateSealMetadata(heldStats, 'directory', relativeName);
    const identity = sealIdentity(heldStats, relativeName);
    if (!sameSealIdentity(sealIdentity(namedStats, relativeName), identity)
      || identity.device !== outputDevice) throw new Error(`${relativeName} directory identity is invalid`);
    return {
      handle,
      kind: 'directory',
      relativeName,
      path,
      bindingPath,
      identity,
      mode: sealMode(heldStats),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validateSealAuthority(rootAuthority, directoryBindings) {
  await rootAuthority.revalidate();
  for (const binding of directoryBindings) {
    await validateHeldSealEntry(binding, binding.mode);
  }
  await rootAuthority.revalidate();
}

function validateVerifiedSealExpectation(state, expectation, fileNames) {
  exactKeys(expectation, ['members', 'outputRootId', 'pinnedSha', 'rootIdentity', 'targetId'], 'verified seal expectation');
  exactKeys(expectation.rootIdentity, ['device', 'inode'], 'verified seal root identity');
  if (expectation.targetId !== state.context.targetId
    || expectation.outputRootId !== state.context.outputRootId
    || expectation.pinnedSha !== state.context.pinnedSha
    || expectation.rootIdentity.device !== Number(state.rootIdentity?.device)
    || expectation.rootIdentity.inode !== Number(state.rootIdentity?.inode)
    || !Array.isArray(expectation.members)
    || expectation.members.length !== fileNames.length) {
    throw new Error('verified seal expectation identity is invalid');
  }
  const members = new Map();
  expectation.members.forEach((member, index) => {
    exactKeys(member, ['relativeName', 'sha256', 'size'], 'verified seal member');
    if (member.relativeName !== fileNames[index] || !SHA256.test(member.sha256)
      || !Number.isSafeInteger(member.size) || member.size < 1 || members.has(member.relativeName)) {
      throw new Error('verified seal member is invalid');
    }
    members.set(member.relativeName, member);
  });
  if (members.get(state.imageName)?.sha256 !== state.job.artifact.sha256
    || members.get(state.imageName)?.size !== state.job.artifact.size) {
    throw new Error('verified seal image differs from terminal job evidence');
  }
  return members;
}

async function sealAcceptedRelease(context, dependencies, expectation) {
  const state = validateJobAndDerivePaths(context);
  state.rootIdentity = await loadRootIdentity(state, dependencies);
  const outputDevice = Number(state.rootIdentity?.device);
  if (!Number.isSafeInteger(outputDevice) || outputDevice < 0) throw new Error('approved output filesystem identity is invalid');
  const fileNames = [state.imageName, 'build-manifest.json', 'verification.json', 'sha256sums'];
  const expectedMembers = validateVerifiedSealExpectation(state, expectation, fileNames);
  const expectedNames = [...fileNames].sort();
  const opened = [];
  let rootAuthority;
  let directoryEntry;
  let operationError;
  try {
    const holdApprovedRoot = dependencies.holdDirectoryAuthority ?? holdDirectoryAuthority;
    if (typeof holdApprovedRoot !== 'function') throw new Error('approved-root authority adapter is unavailable');
    rootAuthority = await holdApprovedRoot(state.approvedRoot, {
      ownerUid: currentUid(),
      finalAccess: 'read',
    });
    if (typeof rootAuthority?.executionPath !== 'string'
      || typeof rootAuthority.revalidate !== 'function'
      || typeof rootAuthority.close !== 'function') throw new Error('approved-root authority is malformed');
    const rootIdentity = rootAuthority.identityChain?.at(-1);
    if (Number(rootIdentity?.dev) !== outputDevice
      || Number(rootIdentity?.ino) !== Number(state.rootIdentity?.inode)) {
      throw new Error('held approved-root identity differs from accepted evidence');
    }
    await rootAuthority.revalidate();

    const directoryBindings = [];
    let parent = rootAuthority.executionPath;
    let path = state.approvedRoot;
    for (const component of [state.context.branch, state.context.pinnedSha, state.context.targetId]) {
      path = join(path, component);
      const binding = await openSealDirectoryBinding(parent, component, path, outputDevice);
      opened.push(binding.handle);
      directoryBindings.push(binding);
      parent = binding.handle;
    }
    directoryEntry = directoryBindings.at(-1);
    directoryEntry.relativeName = basename(state.releaseDir);
    directoryEntry.mode = sealMode(await directoryEntry.handle.stat({ bigint: true }));
    const revalidateAuthority = () => validateSealAuthority(rootAuthority, directoryBindings);
    await revalidateAuthority();

    const directoryExecutionPath = `/proc/self/fd/${directoryEntry.handle.fd}`;
    const memberNames = (await readdir(directoryExecutionPath)).sort();
    if (!sameJson(memberNames, expectedNames)) throw new Error('release directory members are not exact');

    const fileEntries = [];
    for (const relativeName of fileNames) {
      const path = join(state.releaseDir, relativeName);
      const bindingPath = descriptorChild(directoryEntry.handle, relativeName);
      const named = await lstat(bindingPath, { bigint: true });
      validateSealMetadata(named, 'file', relativeName);
      const handle = await open(bindingPath, FILE_FLAGS);
      opened.push(handle);
      const heldBefore = await handle.stat({ bigint: true });
      validateSealMetadata(heldBefore, 'file', relativeName);
      const namedFileIdentity = sealIdentity(named, relativeName);
      const identity = sealIdentity(heldBefore, relativeName);
      if (!sameSealIdentity(namedFileIdentity, identity) || identity.device !== outputDevice) throw new Error(`${relativeName} identity is invalid`);
      const sha256 = await hashHeldSealFile(handle, identity.size, relativeName);
      const heldAfter = sealIdentity(await handle.stat({ bigint: true }), relativeName);
      const namedAfter = sealIdentity(await lstat(bindingPath, { bigint: true }), relativeName);
      if (!sameSealIdentity(identity, heldAfter) || !sameSealIdentity(identity, namedAfter)) throw new Error(`${relativeName} changed while being captured`);
      const expected = expectedMembers.get(relativeName);
      if (sha256 !== expected.sha256 || identity.size !== expected.size) throw new Error(`${relativeName} differs from verified acceptance evidence`);
      fileEntries.push({ handle, kind: 'file', relativeName, path, bindingPath, identity, sha256 });
    }

    for (const entry of fileEntries) await chmodSealEntry(dependencies, entry, 0o444, revalidateAuthority);
    await chmodSealEntry(dependencies, directoryEntry, 0o555, revalidateAuthority);
    directoryEntry.mode = 0o555;

    const sealedMembers = (await readdir(directoryExecutionPath)).sort();
    if (!sameJson(sealedMembers, expectedNames)) throw new Error('sealed release directory members changed');
    if (typeof dependencies.reopenDescriptor !== 'function') throw new Error('reopenDescriptor authority adapter is missing');
    const reopened = [];
    for (const entry of fileEntries) {
      await revalidateAuthority();
      const snapshot = await dependencies.reopenDescriptor(Object.freeze({
        relativeName: entry.relativeName,
        path: entry.path,
        kind: entry.kind,
        executionPath: entry.bindingPath,
      }));
      validateReopenedFile(snapshot, entry, outputDevice);
      await validateHeldSealEntry(entry, 0o444);
      await revalidateAuthority();
      reopened.push(snapshot.relativeName);
    }
    await revalidateAuthority();
    const directorySnapshot = await dependencies.reopenDescriptor(Object.freeze({
      relativeName: directoryEntry.relativeName,
      path: directoryEntry.path,
      kind: directoryEntry.kind,
      executionPath: `${directoryExecutionPath}/.`,
    }));
    validateReopenedDirectory(directorySnapshot, directoryEntry, outputDevice);
    await validateHeldSealEntry(directoryEntry, 0o555);
    await revalidateAuthority();
    reopened.push(directorySnapshot.relativeName);
    if (reopened.length !== 5 || new Set(reopened).size !== 5
      || !sameJson(reopened, [...fileNames, directoryEntry.relativeName])) throw new Error('reopened descriptor cardinality is invalid');
  } catch (error) {
    operationError = error;
  }
  const cleanupResults = await Promise.allSettled([
    ...opened.reverse().map((handle) => handle.close()),
    ...(rootAuthority === undefined ? [] : [rootAuthority.close()]),
  ]);
  const cleanupErrors = cleanupResults
    .filter((item) => item.status === 'rejected')
    .map((item) => item.reason);
  if (operationError !== undefined || cleanupErrors.length > 0) {
    const failures = [
      ...(operationError === undefined ? [] : [operationError]),
      ...cleanupErrors,
    ];
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'release sealing and descriptor cleanup both failed');
  }
}

const PRODUCTION_READ_LIMIT_BYTES = 16 * 1024 * 1024;
const TREE_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOSE_ON_EXEC;
const PROC_DIRECTORY_REOPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | CLOSE_ON_EXEC;

function pathIsWithin(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'));
}

function configuredPathRouter(runtime) {
  const authorities = Object.freeze([
    Object.freeze({
      name: 'output',
      path: runtime.approvedRoot.path,
      executionPath: runtime.approvedRoot.releaseExecutionPath,
      device: runtime.approvedRoot.dev,
      inode: runtime.approvedRoot.ino,
    }),
    Object.freeze({
      name: 'state',
      path: runtime.loadedConfig.stateRoot,
      executionPath: runtime.approvedRoot.stateExecutionPath,
      device: runtime.approvedRoot.stateDev,
      inode: runtime.approvedRoot.stateIno,
    }),
    Object.freeze({
      name: 'repository',
      path: runtime.loadedConfig.config.repository.path,
      executionPath: runtime.approvedRoot.repositoryExecutionPath,
      device: runtime.approvedRoot.repositoryDev,
      inode: runtime.approvedRoot.repositoryIno,
    }),
    Object.freeze({ name: 'install', path: runtime.configured.paths.installRoot }),
    Object.freeze({ name: 'config', path: runtime.loadedConfig.configRoot }),
  ]);
  return (candidate) => {
    if (!isCanonicalAbsolute(candidate)) throw new Error('authority-routed path is not canonical and absolute');
    const matches = authorities.filter((authority) => pathIsWithin(authority.path, candidate));
    if (matches.length !== 1) throw new Error('absolute path is not beneath exactly one held configured authority');
    const suffix = relative(matches[0].path, candidate);
    return Object.freeze({
      ...matches[0],
      relativePath: suffix === '' ? '' : suffix.split('/').join('/'),
    });
  };
}

function heldBytesReader(bytes) {
  const held = Buffer.from(bytes);
  const read = async (maxBytes = PRODUCTION_READ_LIMIT_BYTES) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PRODUCTION_READ_LIMIT_BYTES
      || held.length > maxBytes) throw new Error('held installation read exceeds its bounded capability');
    return Buffer.from(held);
  };
  return Object.freeze({
    read,
    readFile: read,
    stat: async () => Object.freeze({
      size: held.length,
      mtimeMs: 0,
      device: 0,
      inode: 0,
      links: 1,
    }),
    hashSha256: async () => createHash('sha256').update(held).digest('hex'),
  });
}

async function descriptorMountId(handle) {
  const contents = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const match = contents.match(/^mnt_id:\s*(\d+)\s*$/mu);
  const value = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('descriptor mount identity is unavailable');
  return value;
}

function identityBigInt(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`${label} identity is invalid`);
}

function sameStableDirectoryIdentity(left, right) {
  return left.isDirectory() && right.isDirectory()
    && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid
    && left.gid === right.gid && left.rdev === right.rdev;
}

function trustedProductionDirectory(stats, ownerUid) {
  const mode = Number(stats.mode);
  return stats.isDirectory() && !stats.isSymbolicLink() && stats.nlink >= 1n
    && (stats.uid === 0n || stats.uid === BigInt(ownerUid))
    && (mode & 0o022) === 0;
}

async function productionDirectoryMountId(dependencies, handle, context) {
  const readMountId = dependencies.directoryMountId ?? descriptorMountId;
  if (typeof readMountId !== 'function') throw new Error('directory mount-ID adapter is invalid');
  const value = await readMountId(handle, Object.freeze(context));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('directory mount identity is invalid');
  return value;
}

async function withProductionHeldDirectory(routed, callback, revalidateAuthorities, dependencies) {
  if (!['output', 'state', 'repository'].includes(routed.name)
    || typeof routed.executionPath !== 'string'
    || routed.executionPath.length === 0) {
    throw new Error('command directories require a held output, state, or repository root');
  }
  const components = routed.relativePath === ''
    ? []
    : safeRelative(routed.relativePath, 'held command directory');
  const ownerUid = currentUid();
  const expectedDevice = identityBigInt(routed.device, `${routed.name} root device`);
  const expectedInode = identityBigInt(routed.inode, `${routed.name} root inode`);
  const bindings = [];
  let operationError;
  let result;
  try {
    await revalidateAuthorities();
    const rootHandle = await open(routed.executionPath, PROC_DIRECTORY_REOPEN_FLAGS);
    const rootBefore = await rootHandle.stat({ bigint: true });
    if (!trustedProductionDirectory(rootBefore, ownerUid)
      || rootBefore.dev !== expectedDevice || rootBefore.ino !== expectedInode) {
      await rootHandle.close();
      throw new Error(`held ${routed.name} root identity is invalid`);
    }
    bindings.push(Object.freeze({
      handle: rootHandle,
      before: rootBefore,
      parent: undefined,
      name: undefined,
      relativePath: '',
    }));
    const rootMountId = await productionDirectoryMountId(dependencies, rootHandle, {
      authority: routed.name,
      role: 'authority-root',
      relativePath: '',
    });
    let parent = bindings[0];
    let traversed = '';
    for (const name of components) {
      traversed = traversed === '' ? name : `${traversed}/${name}`;
      const bindingPath = descriptorChild(parent.handle, name);
      const namedBefore = await lstat(bindingPath, { bigint: true });
      if (!trustedProductionDirectory(namedBefore, ownerUid) || namedBefore.dev !== expectedDevice) {
        throw new Error(`held command directory component is unsafe: ${traversed}`);
      }
      const handle = await open(bindingPath, TREE_DIRECTORY_FLAGS);
      const heldBefore = await handle.stat({ bigint: true });
      if (!trustedProductionDirectory(heldBefore, ownerUid)
        || !sameIdentity(namedBefore, heldBefore)
        || heldBefore.dev !== expectedDevice) {
        await handle.close();
        throw new Error(`held command directory component identity changed: ${traversed}`);
      }
      const binding = Object.freeze({
        handle,
        before: heldBefore,
        parent,
        name,
        relativePath: traversed,
      });
      bindings.push(binding);
      const mountId = await productionDirectoryMountId(dependencies, handle, {
        authority: routed.name,
        role: 'component',
        relativePath: traversed,
      });
      if (mountId !== rootMountId) {
        throw new Error(`held command directory crosses a mount boundary: ${traversed}`);
      }
      parent = binding;
    }
    const requested = bindings.at(-1);
    if (requested.before.uid !== BigInt(ownerUid)
      || (Number(requested.before.mode) & 0o500) !== 0o500) {
      throw new Error('held command directory final owner or access is unsafe');
    }
    const revalidate = async () => {
      await revalidateAuthorities();
      for (const binding of bindings) {
        const held = await binding.handle.stat({ bigint: true });
        if (!trustedProductionDirectory(held, ownerUid)
          || !sameStableDirectoryIdentity(binding.before, held)
          || held.dev !== expectedDevice) {
          throw new Error(`held command directory identity changed: ${binding.relativePath || routed.name}`);
        }
        const mountId = await productionDirectoryMountId(dependencies, binding.handle, {
          authority: routed.name,
          role: binding.parent === undefined ? 'authority-root' : 'component',
          relativePath: binding.relativePath,
        });
        if (mountId !== rootMountId) {
          throw new Error(`held command directory crosses a mount boundary: ${binding.relativePath || routed.name}`);
        }
        if (binding.parent !== undefined) {
          const named = await lstat(descriptorChild(binding.parent.handle, binding.name), { bigint: true });
          if (!sameIdentity(held, named)) {
            throw new Error(`held command directory pathname identity changed: ${binding.relativePath}`);
          }
        }
      }
      await revalidateAuthorities();
    };
    await revalidate();
    result = await callback(Object.freeze({
      path: routed.path,
      executionPath: `/proc/self/fd/${requested.handle.fd}`,
      descriptorPath: `/proc/self/fd/${requested.handle.fd}`,
      authority: routed.name,
      device: Number(expectedDevice),
      inode: Number(requested.before.ino),
      mountId: rootMountId,
      revalidate,
    }));
    await revalidate();
  } catch (error) {
    operationError = error;
  }
  const closeResults = await Promise.allSettled(
    bindings.reverse().map((binding) => binding.handle.close()),
  );
  const closeErrors = closeResults
    .filter((item) => item.status === 'rejected')
    .map((item) => item.reason);
  let finalRevalidationError;
  try {
    await revalidateAuthorities();
  } catch (error) {
    finalRevalidationError = error;
  }
  const failures = [
    ...(operationError === undefined ? [] : [operationError]),
    ...closeErrors,
    ...(finalRevalidationError === undefined ? [] : [finalRevalidationError]),
  ];
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'held command directory operation, close, and revalidation failed');
  }
  return result;
}

function validateTreeEntry(stats, kind, device, label) {
  if (stats.isSymbolicLink()
    || (kind === 'file' && (!stats.isFile() || stats.nlink !== 1n))
    || (kind === 'directory' && (!stats.isDirectory() || stats.nlink < 1n))
    || stats.dev !== device) {
    throw new Error(`tree entry is unsafe: ${label}`);
  }
}

async function hashTreeFile(parent, name, relativeName, rootDevice, rootMountId, hooks, mountDependencies, authorityName) {
  const bindingPath = descriptorChild(parent, name);
  const namedBefore = await lstat(bindingPath, { bigint: true });
  validateTreeEntry(namedBefore, 'file', rootDevice, relativeName);
  if (typeof hooks?.beforeOpen === 'function') {
    await hooks.beforeOpen(Object.freeze({ kind: 'file', relativePath: relativeName }));
  }
  let handle;
  let operationError;
  let digest;
  try {
    handle = await open(bindingPath, FILE_FLAGS);
    const heldBefore = await handle.stat({ bigint: true });
    validateTreeEntry(heldBefore, 'file', rootDevice, relativeName);
    const mountId = await productionDirectoryMountId(mountDependencies, handle, {
      authority: authorityName,
      role: 'tree-entry',
      relativePath: relativeName,
    });
    if (!sameIdentity(namedBefore, heldBefore)
      || mountId !== rootMountId) throw new Error(`tree file identity changed or mount crossed: ${relativeName}`);
    digest = await hashHeldSealFile(handle, Number(heldBefore.size), relativeName);
    const heldAfter = await handle.stat({ bigint: true });
    const namedAfter = await lstat(bindingPath, { bigint: true });
    if (!sameIdentity(heldBefore, heldAfter) || !sameIdentity(heldBefore, namedAfter)) {
      throw new Error(`tree file changed while hashing: ${relativeName}`);
    }
  } catch (error) {
    operationError = error;
  }
  let closeError;
  try {
    await handle?.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError([operationError, closeError], `tree file hashing and close both failed: ${relativeName}`);
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return digest;
}

async function hashTreeDirectory(parent, name, relativeName, rootDevice, rootMountId, digest, hooks, mountDependencies, authorityName) {
  const bindingPath = descriptorChild(parent, name);
  const namedBefore = await lstat(bindingPath, { bigint: true });
  validateTreeEntry(namedBefore, 'directory', rootDevice, relativeName || '.');
  if (typeof hooks?.beforeOpen === 'function') {
    await hooks.beforeOpen(Object.freeze({ kind: 'directory', relativePath: relativeName }));
  }
  let handle;
  let operationError;
  try {
    handle = await open(bindingPath, TREE_DIRECTORY_FLAGS);
    const heldBefore = await handle.stat({ bigint: true });
    validateTreeEntry(heldBefore, 'directory', rootDevice, relativeName || '.');
    const mountId = await productionDirectoryMountId(mountDependencies, handle, {
      authority: authorityName,
      role: 'tree-entry',
      relativePath: relativeName,
    });
    if (!sameIdentity(namedBefore, heldBefore)
      || mountId !== rootMountId) throw new Error(`tree directory identity changed or mount crossed: ${relativeName || '.'}`);
    const entries = (await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (!safeComponent(entry.name)) throw new Error('tree entry name is unsafe');
      const childRelative = relativeName === '' ? entry.name : `${relativeName}/${entry.name}`;
      const childPath = descriptorChild(handle, entry.name);
      const childStats = await lstat(childPath, { bigint: true });
      if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
        await hashTreeDirectory(
          handle,
          entry.name,
          childRelative,
          rootDevice,
          rootMountId,
          digest,
          hooks,
          mountDependencies,
          authorityName,
        );
      } else if (childStats.isFile() && !childStats.isSymbolicLink()) {
        const fileDigest = await hashTreeFile(
          handle,
          entry.name,
          childRelative,
          rootDevice,
          rootMountId,
          hooks,
          mountDependencies,
          authorityName,
        );
        digest.update(childRelative);
        digest.update('\0');
        digest.update(fileDigest);
      } else {
        throw new Error(`tree contains a special entry: ${childRelative}`);
      }
    }
    const heldAfter = await handle.stat({ bigint: true });
    const namedAfter = await lstat(bindingPath, { bigint: true });
    if (!sameIdentity(heldBefore, heldAfter) || !sameIdentity(heldBefore, namedAfter)) {
      throw new Error(`tree directory changed while hashing: ${relativeName || '.'}`);
    }
  } catch (error) {
    operationError = error;
  }
  let closeError;
  try {
    await handle?.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError([operationError, closeError], `tree traversal and close both failed: ${relativeName || '.'}`);
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
}

async function createProductionTreeHash(path, withHeldDirectory, hooks, mountDependencies) {
  return withHeldDirectory(path, async (authority) => {
    await authority.revalidate();
    let root;
    let operationError;
    let output;
    try {
      root = await open(authority.executionPath, PROC_DIRECTORY_REOPEN_FLAGS);
      const rootBefore = await root.stat({ bigint: true });
      const rootDevice = identityBigInt(authority.device, 'tree root device');
      validateTreeEntry(rootBefore, 'directory', rootDevice, '.');
      if (rootBefore.ino !== identityBigInt(authority.inode, 'tree root inode')) {
        throw new Error('tree root differs from the held command directory');
      }
      const rootMountId = await productionDirectoryMountId(mountDependencies, root, {
        authority: authority.authority,
        role: 'tree-root',
        relativePath: '',
      });
      if (rootMountId !== authority.mountId) throw new Error('tree root crosses a mount boundary');
      const digest = createHash('sha256');
      const entries = (await readdir(`/proc/self/fd/${root.fd}`, { withFileTypes: true }))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        if (!safeComponent(entry.name)) throw new Error('tree entry name is unsafe');
        const childStats = await lstat(descriptorChild(root, entry.name), { bigint: true });
        if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
          await hashTreeDirectory(
            root,
            entry.name,
            entry.name,
            rootDevice,
            rootMountId,
            digest,
            hooks,
            mountDependencies,
            authority.authority,
          );
        } else if (childStats.isFile() && !childStats.isSymbolicLink()) {
          const fileDigest = await hashTreeFile(
            root,
            entry.name,
            entry.name,
            rootDevice,
            rootMountId,
            hooks,
            mountDependencies,
            authority.authority,
          );
          digest.update(entry.name);
          digest.update('\0');
          digest.update(fileDigest);
        } else {
          throw new Error(`tree contains a special entry: ${entry.name}`);
        }
      }
      const rootAfter = await root.stat({ bigint: true });
      if (!sameIdentity(rootBefore, rootAfter)) throw new Error('tree root changed while hashing');
      output = digest.digest('hex');
      await authority.revalidate();
    } catch (error) {
      operationError = error;
    }
    let closeError;
    try {
      await root?.close();
    } catch (error) {
      closeError = error;
    }
    if (operationError !== undefined && closeError !== undefined) {
      throw new AggregateError([operationError, closeError], 'tree hashing and descriptor close both failed');
    }
    if (operationError !== undefined) throw operationError;
    if (closeError !== undefined) throw closeError;
    return output;
  });
}

async function reopenProductionSealDescriptor(request, route, outputDevice) {
  exactKeys(request, ['executionPath', 'kind', 'path', 'relativeName'], 'seal reopen request');
  const routed = route(request.path);
  if (routed.name !== 'output' || !safeComponent(request.relativeName)
    || (request.kind !== 'file' && request.kind !== 'directory')) {
    throw new Error('seal reopen request is outside the approved output authority');
  }
  const expectedExecution = request.kind === 'file'
    ? new RegExp(`^/proc/self/fd/\\d+/${request.relativeName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u')
    : /^\/proc\/self\/fd\/\d+\/\.$/u;
  if (typeof request.executionPath !== 'string' || !expectedExecution.test(request.executionPath)) {
    throw new Error('seal reopen execution path is not descriptor-relative');
  }
  const flags = request.kind === 'file' ? FILE_FLAGS : TREE_DIRECTORY_FLAGS;
  let handle;
  let operationError;
  let snapshot;
  try {
    handle = await open(request.executionPath, flags);
    const before = await handle.stat({ bigint: true });
    validateSealMetadata(before, request.kind, request.relativeName);
    const identity = sealIdentity(before, request.relativeName);
    if (identity.device !== outputDevice) throw new Error('reopened seal descriptor crosses the output filesystem');
    const sha256 = request.kind === 'file'
      ? await hashHeldSealFile(handle, identity.size, request.relativeName)
      : undefined;
    const after = await handle.stat({ bigint: true });
    const named = await lstat(request.executionPath, { bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(before, named)) {
      throw new Error('reopened seal descriptor changed while being validated');
    }
    snapshot = Object.freeze({
      relativeName: request.relativeName,
      path: request.path,
      kind: request.kind,
      regular: request.kind === 'file',
      singleLink: request.kind === 'file' ? identity.links === 1 : identity.links >= 1,
      device: identity.device,
      inode: identity.inode,
      links: identity.links,
      mode: sealMode(before),
      size: identity.size,
      mtimeNs: identity.mtimeNs,
      ctimeNs: identity.ctimeNs,
      ...(sha256 === undefined ? {} : { sha256 }),
    });
  } catch (error) {
    operationError = error;
  }
  let closeError;
  try {
    await handle?.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError([operationError, closeError], 'seal reopen and descriptor close both failed');
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return snapshot;
}

function createProductionAcceptanceDependencies(runtime, apis, inputDependencies) {
  const route = configuredPathRouter(runtime);
  const selected = runtime.selectedInstallation;
  const selectedBytes = new Map([
    [selected.lockPath, selected.lockBytes],
    [selected.manifestPath, selected.manifestBytes],
  ]);
  const revalidateAuthorities = async () => {
    await runtime.configured.revalidate();
    await runtime.approvedRoot.revalidate();
    await runtime.home.revalidate();
    await runtime.approvedRoot.revalidate();
    await runtime.configured.revalidate();
  };
  const withNoFollowFile = async (path, callback) => {
    const routed = route(path);
    await revalidateAuthorities();
    let result;
    if (routed.name === 'install') {
      const bytes = selectedBytes.get(path);
      if (bytes === undefined) throw new Error('installation reads are limited to the held lock and full manifest');
      result = await callback(heldBytesReader(bytes));
    } else if (routed.name === 'output') {
      if (routed.relativePath === '') throw new Error('approved output file path is empty');
      result = await apis.withNoFollowFileUnderRoot(
        runtime.loadedConfig.pathAuthorities.approvedRoots,
        runtime.outputRootId,
        routed.relativePath,
        callback,
      );
    } else if (routed.name === 'state') {
      if (routed.relativePath === '') throw new Error('state-root file path is empty');
      result = await apis.withNoFollowFileUnderStateRoot(
        runtime.loadedConfig.pathAuthorities.stateRoot,
        routed.relativePath,
        callback,
      );
    } else {
      throw new Error('configured authority does not permit direct file reads');
    }
    await revalidateAuthorities();
    return result;
  };
  const withHeldDirectory = async (path, callback) => {
    const routed = route(path);
    return withProductionHeldDirectory(
      routed,
      callback,
      revalidateAuthorities,
      inputDependencies,
    );
  };
  const evidenceWriter = new apis.EvidenceWriter({
    stateRoot: runtime.loadedConfig.pathAuthorities.stateRoot,
  });
  const outputIdentity = Object.freeze({
    device: Number(runtime.approvedRoot.dev),
    inode: Number(runtime.approvedRoot.ino),
  });
  return Object.freeze({
    ...(inputDependencies.http === undefined ? {} : { http: inputDependencies.http }),
    ...(inputDependencies.clock === undefined ? {} : { clock: inputDependencies.clock }),
    ...(inputDependencies.sleep === undefined ? {} : { sleep: inputDependencies.sleep }),
    withNoFollowFile,
    withHeldDirectory,
    listArtifacts: (directory, pattern) => listArtifactsInHeldDirectory(withHeldDirectory, directory, pattern),
    statRoot: async (path) => {
      const routed = route(path);
      if (routed.name !== 'output' || routed.relativePath !== '') throw new Error('root stat request is not the held approved root');
      await revalidateAuthorities();
      return outputIdentity;
    },
    hashTree: (path) => createProductionTreeHash(
      path,
      withHeldDirectory,
      inputDependencies.treeHashHooks,
      inputDependencies,
    ),
    publishAcceptanceEvidence: async (request) => {
      exactKeys(request, ['contents', 'jobId', 'relativePath'], 'acceptance evidence adapter request');
      const publication = await evidenceWriter.writeAcceptanceEvidence({
        jobId: request.jobId,
        basename: request.relativePath,
        contents: Buffer.from(request.contents),
      });
      await revalidateAuthorities();
      return publication;
    },
    reopenDescriptor: async (request) => {
      await revalidateAuthorities();
      const snapshot = await reopenProductionSealDescriptor(request, route, outputIdentity.device);
      await revalidateAuthorities();
      return snapshot;
    },
    holdDirectoryAuthority: async (path, options) => {
      const routed = route(path);
      if (routed.name !== 'output') throw new Error('sealing authority must remain beneath the approved output root');
      await revalidateAuthorities();
      const authority = await holdDirectoryAuthority(path, options);
      let closed = false;
      return Object.freeze({
        path: authority.path,
        ownerUid: authority.ownerUid,
        exists: authority.exists,
        executionPath: authority.executionPath,
        identityChain: authority.identityChain,
        unresolvedSuffix: authority.unresolvedSuffix,
        ensure: authority.ensure,
        sync: authority.sync,
        revalidate: async () => {
          if (closed) throw new Error('production sealing authority is closed');
          await revalidateAuthorities();
          await authority.revalidate();
          await revalidateAuthorities();
        },
        close: async () => {
          if (closed) return;
          let closeError;
          try {
            await authority.close();
          } catch (error) {
            closeError = error;
          }
          let revalidationError;
          try {
            await revalidateAuthorities();
          } catch (error) {
            revalidationError = error;
          }
          closed = closeError === undefined;
          if (closeError !== undefined && revalidationError !== undefined) {
            throw new AggregateError(
              [closeError, revalidationError],
              'production sealing authority close and configured revalidation both failed',
            );
          }
          if (closeError !== undefined) throw closeError;
          if (revalidationError !== undefined) throw revalidationError;
        },
      });
    },
    runCommand: runSafeCommand,
  });
}

function validateProductionComposition(runtime) {
  const { loadedConfig: loaded, configured, approvedRoot, selectedInstallation: selected, outputRootId } = runtime;
  const matchingRoots = loaded.config.approvedOutputRoots.filter((root) => root.id === outputRootId);
  if (loaded.configRoot !== configured.paths.configRoot
    || loaded.stateRoot !== configured.paths.stateRoot
    || configured.paths.installRoot !== approvedRoot.installRoot
    || loaded.config.builderLockPath !== selected.lockPath
    || approvedRoot.builderLockPath !== selected.lockPath
    || approvedRoot.repositoryPath !== loaded.config.repository.path
    || approvedRoot.statePath !== loaded.stateRoot
    || approvedRoot.path !== matchingRoots[0]?.path
    || matchingRoots.length !== 1) {
    throw new Error('loaded configuration differs from held configured authorities');
  }
}

export async function withProductionAcceptanceRuntime(input, callback) {
  if (typeof callback !== 'function') throw new TypeError('production acceptance callback is required');
  const target = input?.target;
  const env = input?.env ?? process.env;
  const dependencies = input?.dependencies ?? {};
  if (target !== 'pi5' && target !== 'pi4' && target !== 'all') throw new Error('production acceptance target is invalid');
  const outputRootId = env.OSI_IMAGE_BUILDER_APPROVED_ROOT_ID;
  const pinnedSha = env.OSI_IMAGE_BUILDER_PINNED_SHA;
  if (env.OSI_IMAGE_BUILDER_REAL !== '1' || typeof outputRootId !== 'string' || !ROOT_ID_PATTERN.test(outputRootId)
    || typeof pinnedSha !== 'string' || !SHA40.test(pinnedSha)) throw new Error('production acceptance environment is invalid');
  const apis = await loadProductionCompositionApis();
  const holdHome = dependencies.withEffectiveHomeAuthority ?? withEffectiveHomeAuthority;
  return holdHome(dependencies.effectiveHomeOptions ?? {}, async (home) => {
    const installRoot = acceptanceAuthorityPaths(home.path).installRoot;
    const holdInstallation = dependencies.withSelectedInstallation ?? withSelectedInstallation;
    return holdInstallation({
      ...(dependencies.selectedInstallationOptions ?? {}),
      installRoot,
    }, async (installation, heldInstallation) => {
      const configured = await (dependencies.holdConfiguredAuthorityPaths ?? holdConfiguredAuthorityPaths)(
        heldInstallation.installRoot,
        installRoot,
      );
      let approvedRoot;
      let operationError;
      let result;
      try {
        await configured.revalidate();
        approvedRoot = await (dependencies.inspectProductionApprovedRoot ?? inspectConfiguredApprovedRoot)(
          outputRootId,
          installation,
          configured.paths.configPath,
          configured.paths,
        );
        if (approvedRoot?.available !== true || approvedRoot.mutation !== 'none') {
          throw new Error(approvedRoot?.detail ?? 'configured approved root is unavailable');
        }
        await approvedRoot.revalidate();
        await configured.revalidate();
        const load = dependencies.loadProductionConfig ?? apis.loadConfig;
        const loadedConfig = await load({
          ...(dependencies.productionConfigOptions ?? {}),
          configPath: configured.paths.configPath,
          env: {
            ...env,
            HOME: home.path,
          },
        });
        const selectedInstallation = Object.freeze({
          versionRoot: installation.versionRoot,
          lockPath: installation.lockPath,
          lockBytes: Buffer.from(installation.lockText),
          lock: installation.lock,
          manifestPath: installation.manifestPath,
          manifestBytes: Buffer.from(installation.manifestBytes),
          manifest: installation.manifest,
          dependencyEgressProxySha256: installation.dependencyEgressProxySha256,
        });
        const runtime = {
          home,
          configured,
          approvedRoot,
          loadedConfig,
          selectedInstallation,
          outputRootId,
          pinnedSha,
        };
        validateProductionComposition(runtime);
        await configured.revalidate();
        await approvedRoot.revalidate();
        const targetIds = target === 'all' ? ['rpi-5', 'rpi-2'] : [TARGETS[target]];
        const contexts = Object.fromEntries(targetIds.map((targetId) => [targetId, Object.freeze({
          targetId,
          branch: 'main',
          pinnedSha,
          outputRootId,
          selectedInstallation,
          loadedConfig,
          job: null,
        })]));
        const productionDependencies = createProductionAcceptanceDependencies(runtime, apis, dependencies);
        result = await callback(Object.freeze({
          env,
          contexts: Object.freeze(contexts),
          dependencies: productionDependencies,
          poll: input.poll,
        }));
        await approvedRoot.revalidate();
        await configured.revalidate();
      } catch (error) {
        operationError = error;
      }
      const cleanupResults = await Promise.allSettled([
        approvedRoot?.close?.(),
        configured.close(),
      ]);
      const cleanupErrors = cleanupResults
        .filter((item) => item.status === 'rejected')
        .map((item) => item.reason);
      if (operationError !== undefined || cleanupErrors.length > 0) {
        const failures = [
          ...(operationError === undefined ? [] : [operationError]),
          ...cleanupErrors,
        ];
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'production acceptance operation and authority cleanup both failed');
      }
      return result;
    });
  });
}

export async function orchestrateProductionAcceptance(input) {
  let mutation = 'none';
  let enteredAcceptance = false;
  try {
    return await withProductionAcceptanceRuntime(input, async (runtime) => {
      enteredAcceptance = true;
      let result;
      if (input.target === 'all') {
        result = await acceptAll({
          env: runtime.env,
          contexts: runtime.contexts,
          dependencies: {
            ...(runtime.dependencies.http === undefined ? {} : { http: runtime.dependencies.http }),
            ...(runtime.dependencies.clock === undefined ? {} : { clock: runtime.dependencies.clock }),
            ...(runtime.dependencies.sleep === undefined ? {} : { sleep: runtime.dependencies.sleep }),
            targets: {
              'rpi-5': runtime.dependencies,
              'rpi-2': runtime.dependencies,
            },
          },
          poll: runtime.poll,
        });
      } else {
        const targetId = TARGETS[input.target];
        result = await acceptTarget({
          env: runtime.env,
          context: runtime.contexts[targetId],
          dependencies: runtime.dependencies,
          poll: runtime.poll,
        });
      }
      mutation = result?.mutation ?? 'unknown';
      return result;
    });
  } catch (error) {
    return fail(
      'PRODUCTION_COMPOSITION_FAILED',
      detail(error) || 'production acceptance composition failed',
      enteredAcceptance ? 'unknown' : 'none',
    );
  }
}

export async function acceptTarget(input) {
  let mutation = 'none';
  try {
    const env = input?.env ?? process.env;
    validateRealEnvironment(env, input?.context);
    const context = validateAcceptanceContext(input?.context);
    const dependencies = input?.dependencies ?? {};
    const classification = await loadJobStateClassification();
    const selection = {
      branch: context.branch,
      expectedSha: context.pinnedSha,
      targetId: context.targetId,
      outputRootId: context.outputRootId,
    };
    const refresh = await requestApi(dependencies, apiRequest('POST', '/api/branches/refresh', {}), 'branch refresh');
    validateBranchRefresh(refresh, context.pinnedSha);
    const checkIds = await loadPreflightCheckIds();
    const now = clockMilliseconds(dependencies);
    const preflight = await requestApi(dependencies, apiRequest('POST', '/api/preflight', selection), 'preflight');
    validatePreflight(preflight, context.pinnedSha, context.targetId, now, checkIds);
    mutation = 'unknown';
    const queued = await requestApi(
      dependencies,
      apiRequest(
        'POST',
        '/api/jobs',
        { ...selection, preflightId: preflight.preflightId },
        ENQUEUE_REQUEST_TIMEOUT_MS,
      ),
      'enqueue',
    );
    const jobId = validateQueuedJob(queued, selection);
    const terminalJob = await pollTerminalJob(dependencies, jobId, context, input?.poll, classification);
    const trustedContext = { ...context, job: terminalJob };
    const report = await buildAcceptanceReport({ env, context: trustedContext, dependencies });
    if (report.ok !== true) return report;
    if (dependencies.beforeSeal !== undefined) {
      if (typeof dependencies.beforeSeal !== 'function') throw new Error('beforeSeal hook is invalid');
      await dependencies.beforeSeal();
    }
    await sealAcceptedRelease(trustedContext, dependencies, report._sealExpectation);
    return { ok: true, targetId: context.targetId, observations: report.observations, mutation: 'committed' };
  } catch (error) {
    return fail('TARGET_ACCEPTANCE_FAILED', detail(error) || 'target acceptance failed', mutation);
  }
}

export async function acceptAll(input) {
  let mutation = 'none';

  try {
    const env = input?.env ?? process.env;
    if (env.OSI_IMAGE_BUILDER_REAL !== '1') throw new Error('OSI_IMAGE_BUILDER_REAL=1 is required');
    if (typeof env.OSI_IMAGE_BUILDER_APPROVED_ROOT_ID !== 'string' || !ROOT_ID_PATTERN.test(env.OSI_IMAGE_BUILDER_APPROVED_ROOT_ID)) throw new Error('approved root ID is invalid');
    if (typeof env.OSI_IMAGE_BUILDER_PINNED_SHA !== 'string' || !SHA40.test(env.OSI_IMAGE_BUILDER_PINNED_SHA)) throw new Error('pinned SHA is invalid');
    if (env.OSI_IMAGE_BUILDER_TARGET !== undefined) throw new Error('accept:all does not accept a single-target override');

    const targetIds = ['rpi-5', 'rpi-2'];
    const contexts = input?.contexts;
    exactKeys(contexts, targetIds, 'accept:all contexts');
    const dependenciesInput = input?.dependencies;
    if (dependenciesInput === null || typeof dependenciesInput !== 'object' || Array.isArray(dependenciesInput)) throw new Error('accept:all dependencies are invalid');
    const targetDependencyInput = dependenciesInput.targets;
    if (targetDependencyInput === null || typeof targetDependencyInput !== 'object' || Array.isArray(targetDependencyInput)) throw new Error('accept:all target dependencies are invalid');

    const targetDependencies = {};
    for (const targetId of targetIds) {
      const context = validateAcceptanceContext(contexts[targetId]);
      if (context.targetId !== targetId) throw new Error(`accept:all context target mismatch: ${targetId}`);
      validateRealEnvironment(env, context);
      const authoritative = targetDependencyInput[targetId];
      if (authoritative === null || typeof authoritative !== 'object' || Array.isArray(authoritative)) throw new Error(`accept:all dependencies are missing for ${targetId}`);
      const shared = {};
      for (const name of ['http', 'clock', 'sleep']) {
        if (dependenciesInput[name] !== undefined) shared[name] = dependenciesInput[name];
      }
      targetDependencies[targetId] = { ...shared, ...authoritative };
    }

    const observations = [];
    for (const targetId of targetIds) {
      const result = await acceptTarget({
        env,
        context: contexts[targetId],
        dependencies: targetDependencies[targetId],
        poll: input?.poll,
      });
      if (result === null || typeof result !== 'object' || result.ok !== true || result.mutation !== 'committed') {
        return mutation === 'none' && result?.ok === false
          ? result
          : fail(
              result?.code ?? 'TARGET_ACCEPTANCE_FAILED',
              result?.detail ?? `target ${targetId} was not accepted`,
              mutation === 'none' ? mutationOf(result) : mutation,
            );
      }
      if (result.observations === null || typeof result.observations !== 'object' || Array.isArray(result.observations)) throw new Error(`target ${targetId} observations are malformed`);
      observations.push(result.observations);
      mutation = 'unknown';
    }

    const [pi5, pi4] = observations;
    for (const key of ['installedLockSha256', 'dependencyEgressProxySha256', 'imageDigest', 'canonicalImageRef']) if (pi5[key] !== pi4[key]) throw new Error(`cross-target builder identity mismatch: ${key}`);
    if (pi5.imageId !== pi4.imageId) throw new Error('cross-target builder image ID mismatch');
    return { ok: true, targetIds, mutation: 'committed' };
  } catch (error) {
    return fail('ALL_TARGET_ACCEPTANCE_FAILED', detail(error) || 'both target acceptance failed', mutation);
  }
}

export async function runAcceptanceMain(input = {}) {
  const argv = Array.isArray(input.argv) ? input.argv : process.argv.slice(2);
  const target = argv[0];
  const env = input.env ?? process.env;
  const dependencies = input.dependencies ?? {};
  let result;

  try {
    const evaluateGuards = typeof dependencies.evaluateGuards === 'function'
      ? dependencies.evaluateGuards
      : evaluateAcceptanceGuards;
    const guards = await evaluateGuards({ target, env, dependencies });

    if (guards?.ok !== true) {
      result = guards ?? fail('ACCEPTANCE_GUARD_FAILED', 'acceptance guards failed', 'none');
    } else if (typeof dependencies.orchestrate === 'function') {
      result = await dependencies.orchestrate({
        target,
        env,
        context: input.context,
        contexts: input.contexts,
        dependencies,
        poll: input.poll,
        guards,
      });
    } else if (target === 'all' && input.contexts !== undefined) {
      result = await acceptAll({
        env,
        contexts: input.contexts,
        dependencies,
        poll: input.poll,
      });
    } else if ((TARGETS[target] !== undefined || Object.values(TARGETS).includes(target)) && input.context !== undefined) {
      result = await acceptTarget({
        env,
        context: input.context,
        dependencies,
        poll: input.poll,
      });
    } else {
      const composeProduction = typeof dependencies.composeProduction === 'function'
        ? dependencies.composeProduction
        : orchestrateProductionAcceptance;
      result = await composeProduction({
        target,
        env,
        dependencies,
        poll: input.poll,
        guards,
      });
    }
  } catch (error) {
    result = fail('ACCEPTANCE_MAIN_FAILED', detail(error) || 'acceptance main failed', 'unknown');
  }

  const writeStdout = typeof dependencies.writeStdout === 'function'
    ? dependencies.writeStdout
    : (line) => process.stdout.write(line);
  const setExitCode = typeof dependencies.setExitCode === 'function'
    ? dependencies.setExitCode
    : (code) => {
      process.exitCode = code;
    };
  writeStdout(`${JSON.stringify(result)}\n`);
  setExitCode(result?.ok === true && result?.mutation === 'committed' ? 0 : 1);
  return result;
}

async function main() {
  return runAcceptanceMain({
    argv: process.argv.slice(2),
    env: process.env,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
