import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The production script is JavaScript and intentionally has no declaration file.
import { FIXED_ENV, withSelectedInstallation } from '../../scripts/run-workstation-test.mjs';
import { loadConfig, type ApprovedRootRegistry, type LoadedConfig } from '../../config/load.js';
import { decodeStoredStageEvidence, EvidenceWriter, type StageEvidenceInput } from '../../runner/src/evidence.js';
import { createOperationArgv } from '../../runner/src/operation-registry.js';
import { createTerminalVerification } from '../../runner/src/terminal-verification.js';
import { assertActiveTargetLinks } from '../../runner/src/target-setup.js';
import { withNoFollowFileUnderRoot, type ReadCapability } from '../../domain/paths.js';
import { BUILDER_LOCK_REQUIRED_KEYS, validateBuilderLock } from '../../domain/builder-lock.js';
import {
  JOB_STATES,
  PIPELINE_STAGE_NAMES,
  TERMINAL_STATES,
  type JobState,
  type PipelineStageName,
  type TrustedOperationId,
} from '../../domain/types.js';
import { REQUIRED_RUNTIME_FILES, type TargetManifest } from '../../manifest/schema.js';
import { loadManifest } from '../../manifest/validate.js';
import { PREFLIGHT_CHECK_IDS } from '../../api/src/preflight.js';
import { holdDirectoryAuthority as holdTestDirectoryAuthority } from '../../shared/held-directory-authority.mjs';

// @ts-expect-error The production script is JavaScript and intentionally has no declaration file.
import * as acceptance from '../../scripts/accept-real-target.mjs';

const SHA40 = '0123456789abcdef0123456789abcdef01234567';
const API_BASE_URL = 'http://127.0.0.1:43120';
const API_REQUEST_TIMEOUT_MS = 10_000;
const ENQUEUE_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const NONTERMINAL_JOB_STATES = JOB_STATES.filter(
  (state): state is Exclude<JobState, (typeof TERMINAL_STATES)[number]> => (
    !(TERMINAL_STATES as readonly JobState[]).includes(state)
  ),
);
const execFile = promisify(execFileCallback);
const IMAGE_DIGEST = 'a'.repeat(64);
const IMAGE_ID = '1'.repeat(64);
const PACKAGE_VERSION = '2026.07.29.1';
const STARTED_AT = '2026-07-29T10:00:00.000Z';
const FINISHED_AT = '2026-07-29T10:00:01.000Z';
const ARTIFACT_MTIME = '2026-07-29T10:05:00.000Z';
const ADVANCED_SHA40 = 'fedcba9876543210fedcba9876543210fedcba98';
const BUILD_START_EPOCH = Math.floor(Date.parse('2026-07-29T10:04:00.000Z') / 1000);
const IMAGE_SIZE_BYTES = 64 * 1024 * 1024;
const COMMAND_POLICIES = Object.freeze({
  short: Object.freeze({ timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }),
  medium: Object.freeze({ timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 }),
  releaseGate: Object.freeze({ timeoutMs: 1_800_000, maxOutputBytes: 8 * 1024 * 1024 }),
});
const MANIFEST_SOURCE = fileURLToPath(new URL('../../manifest/targets.json', import.meta.url));
const INSTALLED_MANIFEST_BYTES = await readFile(MANIFEST_SOURCE);
const LOADED_MANIFEST = loadManifest(MANIFEST_SOURCE);
const ACCEPTANCE_MODULE_URL = new URL('../../scripts/accept-real-target.mjs', import.meta.url).href;
const HELD_AUTHORITY_MODULE_URL = new URL('../../shared/held-directory-authority.mjs', import.meta.url).href;

const RELATIVE_HELPERS = Object.freeze([
  'osi-chameleon-helper',
  'osi-chirpstack-helper',
  'osi-cloud-http',
  'osi-db-helper',
  'osi-dendro-helper',
  'osi-health-helper',
  'osi-history-helper',
  'osi-history-sync-helper',
  'osi-lib',
] as const);
const DIRECT_HELPERS = Object.freeze([
  'osi-command-ledger',
  'osi-dendro-analytics',
  'osi-zone-env',
  'osi-history-router',
  'osi-journal',
  'osi-device-writer',
  'osi-uc512-normalize',
  'osi-lsn50-normalize',
] as const);
const THIRD_PARTY_PACKAGES = Object.freeze([
  '@grpc/grpc-js',
  '@chirpstack/chirpstack-api',
  'google-protobuf',
  'protobufjs',
] as const);
const NODE_RESOLUTION_PACKAGES = Object.freeze([
  ...THIRD_PARTY_PACKAGES,
  ...RELATIVE_HELPERS,
  ...DIRECT_HELPERS,
] as const);
const REAL_ENV = Object.freeze({
  OSI_IMAGE_BUILDER_REAL: '1',
  OSI_IMAGE_BUILDER_APPROVED_ROOT_ID: 'release',
  OSI_IMAGE_BUILDER_PINNED_SHA: SHA40,
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
});

const FIXED_EVIDENCE = Object.freeze(PIPELINE_STAGE_NAMES.map((stage, index) => Object.freeze({
  stage,
  path: `${String(index).padStart(2, '0')}-${stage}.json`,
})));

const STAGE_OPERATIONS: Readonly<Record<PipelineStageName, readonly TrustedOperationId[]>> = Object.freeze({
  preflight: [],
  source: [],
  'release-gates': [
    'verify-profile-parity',
    'verify-chameleon',
    'verify-db-schema',
    'verify-sync-flow',
    'verify-strega',
    'verify-communication',
    'check-mqtt-topics',
  ],
  frontend: [
    'frontend-install',
    'frontend-test',
    'frontend-typecheck',
    'frontend-build',
    'mirror-gui',
  ],
  'target-setup': ['activate-target'],
  feeds: ['copy-feed-config', 'update-feeds', 'install-feeds'],
  config: ['resolve-config'],
  build: ['build-image'],
  verify: ['verify-image'],
  publish: [],
});

const productionEvidenceWriter = new EvidenceWriter({ stateRoot: undefined as never });

const SQLITE_SCRIPT = [
  "const { DatabaseSync } = require('node:sqlite');",
  'const db = new DatabaseSync(process.argv[1], { readOnly: true });',
  "const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;",
  "const count = db.prepare('SELECT COUNT(*) AS count FROM chameleon_calibrations').get()?.count;",
  "if (integrity !== 'ok' || !Number.isInteger(count)) process.exit(1);",
  "process.stdout.write(JSON.stringify({ integrity, chameleonCalibrationCount: count }) + '\\n');",
  'db.close();',
].join(' ');

const NODE_RESOLUTION_SCRIPT = String((acceptance as Record<string, unknown>).NODE_RESOLUTION_SCRIPT);

const temporaryDirectories: string[] = [];

type TargetId = 'rpi-5' | 'rpi-2';
type CommandResult = Readonly<{
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;
type CommandRequest = Readonly<{
  id: string;
  cwd: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}>;
type ExpectedCommand = Readonly<{
  request: CommandRequest;
  result: CommandResult;
}>;
type HttpRequest = Readonly<{
  method: 'GET' | 'POST';
  baseUrl: typeof API_BASE_URL;
  path: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
  body?: Readonly<Record<string, unknown>>;
}>;
type HttpResponse = Readonly<{
  status: number;
  body: unknown;
}>;
type JobDto = Record<string, unknown> & {
  id: string;
  state: JobState;
  branch: string;
  targetId: TargetId;
  outputRootId: string;
};
const JOB_DETAIL_KEYS = Object.freeze([
  'id',
  'state',
  'branch',
  'targetId',
  'outputRootId',
  'acceptedAt',
  'currentStage',
  'queuePosition',
  'terminalAt',
  'stage',
  'pinnedSha',
  'cancelRequestedAt',
  'artifact',
  'freshnessStatus',
  'freshnessCheckedAt',
  'newerSourceAvailable',
  'error',
  'source',
  'output',
  'errors',
  'cancellation',
  'runtime',
  'evidence',
] as const);
type HeldEvidenceSnapshot = Readonly<{
  path: string;
  bytes: Buffer;
  sha256: string;
  regular: boolean;
  singleLink: boolean;
  device: number;
  mode: number;
  size: number;
}>;
type ReopenedDescriptorSnapshot = Readonly<{
  relativeName: string;
  path: string;
  kind: 'file' | 'directory';
  sha256?: string;
  regular: boolean;
  singleLink: boolean;
  device: number;
  inode: number;
  links: number;
  mode: number;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}>;
type ReopenDescriptorRequest = Readonly<{
  relativeName: string;
  path: string;
  kind: 'file' | 'directory';
  executionPath: string;
}>;
type TrustedAcceptanceContext = Readonly<{
  targetId: TargetId;
  branch: 'main';
  pinnedSha: string;
  outputRootId: 'release';
  selectedInstallation: Readonly<{
    versionRoot: string;
    lockPath: string;
    lockBytes: Buffer;
    lock: Readonly<Record<string, unknown>>;
    manifestPath: string;
    manifestBytes: Buffer;
    manifest: ReturnType<typeof loadManifest>;
    dependencyEgressProxySha256: string;
  }>;
  loadedConfig: LoadedConfig;
  job: JobDto;
}>;

interface Fixture {
  readonly base: string;
  readonly approvedRoot: string;
  readonly versionRoot: string;
  readonly worktree: string;
  readonly releaseDir: string;
  readonly jobEvidenceRoot: string;
  readonly rootfs: string;
  readonly targetOutput: string;
  readonly installedManifestPath: string;
  readonly installedLockPath: string;
  readonly buildManifestPath: string;
  readonly publishedVerificationPath: string;
  readonly publishedChecksumsPath: string;
  readonly reportPath: string;
  readonly dockerInspectionPath: string;
  readonly releaseImage: string;
  readonly targetImage: string;
  readonly target: TargetManifest;
  readonly lock: Record<string, unknown>;
  readonly buildManifest: Record<string, unknown>;
  readonly fullVerification: Record<string, unknown>;
  readonly fullVerifyDocument: Record<string, unknown>;
  readonly aggregation: Record<string, unknown>;
  readonly loadedConfig: LoadedConfig;
  readonly context: TrustedAcceptanceContext;
  readonly job: JobDto;
  readonly expectedObservations: Record<string, unknown>;
  readonly expectedCommands: ReadonlyMap<string, ExpectedCommand>;
  readonly commandRequests: CommandRequest[];
  readonly httpRequests: HttpRequest[];
  readonly hashedFiles: string[];
  readonly heldReads: string[];
  readonly heldCwds: string[];
  readonly heldCwdRevalidations: string[];
  readonly acceptancePublicationCalls: string[];
  readonly acceptancePublicationSnapshots: Record<string, HeldEvidenceSnapshot>;
  readonly reopenedDescriptors: string[];
  readonly reopenedDescriptorSnapshots: ReopenedDescriptorSnapshot[];
  readonly heldRegistry: ApprovedRootRegistry;
  readonly dependencies: Record<string, unknown>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashDescriptorFile(path: string): Promise<Readonly<{
  sha256: string;
  stats: BigIntStats;
}>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat({ bigint: true }) as BigIntStats;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0n;
    while (position < stats.size) {
      const length = Number(stats.size - position > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : stats.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
      if (bytesRead < 1) throw new Error('descriptor fixture ended before its held size');
      hash.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    return { sha256: hash.digest('hex'), stats };
  } finally {
    await handle.close();
  }
}

function heldExecutionPath(authorityPath: string): string {
  const descriptor = Number.parseInt(sha256(authorityPath).slice(0, 8), 16);
  return `/proc/self/fd/${descriptor}`;
}

function sortFixtureJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortFixtureJson(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortFixtureJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalJson(value: unknown, newline = true): string {
  const encoded = JSON.stringify(sortFixtureJson(value));
  if (encoded === undefined) throw new Error('fixture value is not JSON-serializable');
  return newline ? `${encoded}\n` : encoded;
}

function installerOrderedLock(lock: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'packageVersion', 'imageRepository', 'imageDigest', 'baseImage', 'baseImageDigest',
    'dockerfileSha256', 'packageSet', 'rustConfig', 'nodeVersion', 'executionDefinitionSha256',
    'validationEvidenceSha256', 'dependencyEgressProxySha256', 'publisherSha256', 'imageId', 'schemaVersion', 'installable',
  ];
  return Object.fromEntries(keys
    .filter((key) => Object.prototype.hasOwnProperty.call(lock, key))
    .map((key) => [key, lock[key]]));
}

function sparseZeroSha256(size: number): string {
  const hash = createHash('sha256');
  const block = Buffer.alloc(1024 * 1024);
  for (let remaining = size; remaining > 0; remaining -= block.length) {
    hash.update(block.subarray(0, Math.min(remaining, block.length)));
  }
  return hash.digest('hex');
}

const IMAGE_SHA256 = sparseZeroSha256(IMAGE_SIZE_BYTES);

async function ensureSparseImage(path: string, size: number): Promise<void> {
  await ensureFile(path, Buffer.from([0]), 0o600);
  await truncate(path, size);
  await utimes(path, new Date(ARTIFACT_MTIME), new Date(ARTIFACT_MTIME));
}

function targetManifest(targetId: TargetId): TargetManifest {
  const target = LOADED_MANIFEST.manifest.targets.find((candidate) => candidate.id === targetId);
  if (target === undefined) throw new Error(`installed manifest has no ${targetId}`);
  return structuredClone(target);
}

function productionLock(schemaVersion: unknown = 1): Record<string, unknown> {
  const baseImageDigest = 'b'.repeat(64);
  const document = {
    schemaVersion,
    packageVersion: PACKAGE_VERSION,
    imageRepository: 'osi/firmware-builder',
    imageDigest: IMAGE_DIGEST,
    baseImage: `docker.io/library/debian@sha256:${baseImageDigest}`,
    baseImageDigest,
    dockerfileSha256: 'c'.repeat(64),
    packageSet: [
      'gcc-14',
      'nodejs',
      'npm',
      'openwrt-build-tools',
      'llvm-dev',
      'libzstd-dev',
      'libpolly-18-dev',
    ],
    rustConfig: {
      llvmConfig: '/usr/bin/llvm-config',
      channel: 'stable',
      version: '1.88.0',
      llvmMajor: 18,
    },
    nodeVersion: '22.17.0',
    executionDefinitionSha256: 'd'.repeat(64),
    validationEvidenceSha256: 'e'.repeat(64),
    dependencyEgressProxySha256: '1'.repeat(64),
    installable: true,
    publisherSha256: 'f'.repeat(64),
    imageId: IMAGE_ID,
  };
  return document;
}

function lockBuildFields(lock: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(BUILDER_LOCK_REQUIRED_KEYS.map((key) => [key, lock[key]]));
}

async function createActualSelectedInstallation(
  base: string,
  installRoot = join(base, 'actual-selected-installation'),
): Promise<Readonly<{
  installRoot: string;
  versionRoot: string;
  manifestPath: string;
  lockPath: string;
  publisherPath: string;
  lock: Record<string, unknown>;
  lockText: string;
  manifestText: string;
  publisherBytes: Buffer;
  dependencyEgressProxySha256: string;
}>> {
  const versionRoot = join(installRoot, PACKAGE_VERSION);
  const manifestDirectory = join(versionRoot, 'manifest');
  const binDirectory = join(versionRoot, 'bin');
  const operationsDirectory = join(versionRoot, 'operations');
  const manifestPath = join(manifestDirectory, 'targets.json');
  const lockPath = join(versionRoot, 'builder.lock.json');
  const publisherPath = join(binDirectory, 'osi-image-publish');
  const dependencyEgressProxyPath = join(operationsDirectory, 'osi-dependency-egress-proxy.cjs');
  const publisherBytes = Buffer.from('#!/bin/sh\nexit 0\n');
  const dependencyEgressProxyBytes = await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url));
  const lock = productionLock();
  lock.publisherSha256 = sha256(publisherBytes);
  lock.dependencyEgressProxySha256 = sha256(dependencyEgressProxyBytes);
  const lockText = canonicalJson(lock);
  const manifestText = INSTALLED_MANIFEST_BYTES.toString('utf8');
  const selectedText = canonicalJson({
    executionDefinitionSha256: lock.executionDefinitionSha256,
    lockSha256: sha256(lockText),
    manifestSha256: sha256(INSTALLED_MANIFEST_BYTES),
    packageVersion: PACKAGE_VERSION,
    publisherSha256: sha256(publisherBytes),
  });
  await Promise.all([
    mkdir(manifestDirectory, { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
    mkdir(operationsDirectory, { recursive: true }),
    ensureFile(join(installRoot, 'selected.json'), selectedText, 0o600),
    ensureFile(lockPath, lockText, 0o600),
    ensureFile(manifestPath, INSTALLED_MANIFEST_BYTES, 0o444),
    ensureFile(publisherPath, publisherBytes, 0o555),
    ensureFile(dependencyEgressProxyPath, dependencyEgressProxyBytes, 0o444),
  ]);
  await Promise.all([
    chmod(installRoot, 0o700),
    chmod(versionRoot, 0o555),
    chmod(manifestDirectory, 0o555),
    chmod(binDirectory, 0o555),
    chmod(operationsDirectory, 0o555),
    chmod(join(installRoot, 'selected.json'), 0o600),
    chmod(lockPath, 0o600),
    chmod(manifestPath, 0o444),
    chmod(publisherPath, 0o555),
    chmod(dependencyEgressProxyPath, 0o444),
  ]);
  return {
    installRoot,
    versionRoot,
    manifestPath,
    lockPath,
    publisherPath,
    lock,
    lockText,
    manifestText,
    publisherBytes,
    dependencyEgressProxySha256: lock.dependencyEgressProxySha256 as string,
  };
}

async function createProductionRuntimeFixture(rootId = 'archive'): Promise<Readonly<{
  base: string;
  home: string;
  configRoot: string;
  configPath: string;
  stateRoot: string;
  repositoryPath: string;
  outputRoot: string;
  installRoot: string;
  selected: Awaited<ReturnType<typeof createActualSelectedInstallation>>;
  env: Record<string, string>;
  dependencies: Record<string, unknown>;
}>> {
  const base = await mkdtemp(join(tmpdir(), 'osi-real-production-runtime-'));
  temporaryDirectories.push(base);
  const home = join(base, 'home');
  const configHome = join(base, 'custom-config');
  const stateHome = join(base, 'custom-state');
  const configRoot = join(configHome, 'osi-image-builder');
  const stateRoot = join(stateHome, 'osi-image-builder');
  const repositoryPath = join(base, 'repository');
  const outputRoot = join(base, 'published-images');
  const installRoot = join(home, '.local', 'lib', 'osi-image-builder');
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(configRoot, { recursive: true, mode: 0o700 }),
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
    mkdir(repositoryPath, { recursive: true, mode: 0o700 }),
    mkdir(outputRoot, { recursive: true, mode: 0o700 }),
  ]);
  const selected = await createActualSelectedInstallation(base, installRoot);
  const configPath = join(configRoot, 'config.json');
  await ensureFile(configPath, canonicalJson({
    approvedOutputRoots: [{ id: rootId, label: 'Production fixture', path: outputRoot }],
    builderLockPath: selected.lockPath,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
    maxQueueLength: 50,
    repositoryPath,
  }), 0o600);
  await ensureFile(join(installRoot, 'configured-authorities.json'), canonicalJson({
    configRoot,
    schemaVersion: 1,
    stateRoot,
  }), 0o600);
  await Promise.all([
    chmod(home, 0o700),
    chmod(configRoot, 0o700),
    chmod(stateHome, 0o700),
    chmod(stateRoot, 0o700),
    chmod(repositoryPath, 0o700),
    chmod(outputRoot, 0o700),
    chmod(configPath, 0o600),
    chmod(join(installRoot, 'configured-authorities.json'), 0o600),
  ]);
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid!();
  const gid = typeof process.getegid === 'function' ? process.getegid() : process.getgid!();
  const env = {
    OSI_IMAGE_BUILDER_REAL: '1',
    OSI_IMAGE_BUILDER_APPROVED_ROOT_ID: rootId,
    OSI_IMAGE_BUILDER_PINNED_SHA: SHA40,
    HOME: '/untrusted-home-must-not-win',
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
  };
  const dependencies = {
    effectiveHomeOptions: {
      lookupPasswd: async () => `builder:x:${uid}:${gid}:Builder:${home}:/bin/sh\n`,
    },
    productionConfigOptions: {
      git: {
        getOriginPolicy: async () => ({
          url: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
          fetchRefspec: '+refs/heads/*:refs/remotes/origin/*',
        }),
      },
      rootFs: {
        statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }),
      },
    },
  };
  return {
    base,
    home,
    configRoot,
    configPath,
    stateRoot,
    repositoryPath,
    outputRoot,
    installRoot,
    selected,
    env,
    dependencies,
  };
}

function configLines(target: TargetManifest): string {
  return `${target.configSymbols.map((symbol) => {
    if (symbol.type === 'bool') return `${symbol.name}=${symbol.value ? 'y' : 'n'}`;
    if (symbol.type === 'string') return `${symbol.name}="${symbol.value}"`;
    return `${symbol.name}=${symbol.value}`;
  }).join('\n')}\n`;
}

type FreshnessFixture =
  | Readonly<{
      status: 'fresh';
      pinnedSha: string;
      observedSha: string;
      newerSourceAvailable: false;
      checkedAt: string;
    }>
  | Readonly<{
      status: 'advanced';
      pinnedSha: string;
      observedSha: string;
      newerSourceAvailable: true;
      checkedAt: string;
    }>
  | Readonly<{
      status: 'unknown';
      pinnedSha: string;
      observedSha: null;
      newerSourceAvailable: false;
      checkedAt: string | null;
      error: Readonly<{
        code: 'FRESHNESS_UNKNOWN';
        reason: 'socket-unavailable' | 'timeout' | 'malformed-result' | 'api-error';
        evidencePath?: string;
        evidenceSha256?: string;
        details?: Readonly<Record<string, unknown>>;
      }>;
    }>;

function freshnessFixture(status: FreshnessFixture['status'] = 'fresh'): FreshnessFixture {
  if (status === 'advanced') {
    return {
      status,
      pinnedSha: SHA40,
      observedSha: ADVANCED_SHA40,
      newerSourceAvailable: true,
      checkedAt: FINISHED_AT,
    };
  }
  if (status === 'unknown') {
    return {
      status,
      pinnedSha: SHA40,
      observedSha: null,
      newerSourceAvailable: false,
      checkedAt: FINISHED_AT,
      error: {
        code: 'FRESHNESS_UNKNOWN',
        reason: 'api-error',
        evidencePath: 'jobs/job-rpi-5/evidence/freshness.json',
        evidenceSha256: '7'.repeat(64),
        details: { operation: 'origin-refresh', available: false },
      },
    };
  }
  return {
    status,
    pinnedSha: SHA40,
    observedSha: SHA40,
    newerSourceAvailable: false,
    checkedAt: FINISHED_AT,
  };
}

function sourceProfileRecord(target: TargetManifest): Record<string, unknown> {
  return {
    target: target.id,
    environment: target.environment,
    selectedTarget: target.openwrtTarget,
    profile: target.profile,
    rootfsPartSize: target.rootfsPartSize,
    sourceSha256: target.id === 'rpi-5' ? '2'.repeat(64) : '4'.repeat(64),
    sourceConfigEvidencePath: `evidence/target-setup/${target.id}.source.config`,
  };
}

function resolvedProfileRecord(target: TargetManifest): Record<string, unknown> {
  return {
    target: target.id,
    environment: target.environment,
    selectedTarget: target.openwrtTarget,
    profile: target.profile,
    rootfsPartSize: target.rootfsPartSize,
    resolvedSha256: target.id === 'rpi-5' ? '3'.repeat(64) : '5'.repeat(64),
  };
}

function verifiedProfileRecord(target: TargetManifest): Record<string, unknown> {
  return {
    ...sourceProfileRecord(target),
    ...resolvedProfileRecord(target),
    resolvedConfigPath: `conf/${target.environment}/.config`,
    manifestSymbolsVerified: true,
  };
}

function verifiedConfig(target: TargetManifest): Record<string, unknown> {
  const pi5 = targetManifest('rpi-5');
  const pi4 = targetManifest('rpi-2');
  return {
    selectedTarget: target.openwrtTarget,
    profile: target.profile,
    rootfsPartSize: target.rootfsPartSize,
    bothProfilesChecked: true,
    profiles: {
      'rpi-5': verifiedProfileRecord(pi5),
      'rpi-2': verifiedProfileRecord(pi4),
    },
  };
}

function createRunnerVerification(
  target: TargetManifest,
  imageName: string,
  hashes: Readonly<{
    sourceFlows: string;
    rootfsFlows: string;
    sourceDb: string;
    rootfsDb: string;
    sourceGui: string;
    feedGui: string;
    rootfsGui: string;
  }>,
  freshness: FreshnessFixture = freshnessFixture(),
): Readonly<{
  artifact: Record<string, unknown>;
  config: Record<string, unknown>;
  verification: Record<string, unknown>;
}> {
  const artifactPath = `openwrt/bin/targets/${target.openwrtTarget}/${imageName}`;
  const artifact = {
    path: artifactPath,
    basename: imageName,
    size: target.minimumArtifactBytes,
    mtime: ARTIFACT_MTIME,
    sha256: IMAGE_SHA256,
    gzip: true,
  };
  const generatedContents = `${artifact.sha256}  ${imageName}\n`;
  const checks = {
    originalOpenWrtSha256sums: {
      path: `openwrt/bin/targets/${target.openwrtTarget}/sha256sums`,
      verified: true,
      entries: [imageName],
    },
    generatedSha256sums: {
      contents: generatedContents,
      sha256: sha256(generatedContents),
      verified: true,
      filenames: [imageName],
    },
  };
  const config = verifiedConfig(target);
  const nodeResolution = Object.fromEntries(NODE_RESOLUTION_PACKAGES.map((name) => [name, true]));
  const rootfs = {
    requiredFiles: REQUIRED_RUNTIME_FILES.filter((path) => !path.includes('/node_modules/osi-')),
    nginxRoutes: {
      '/gui/': true,
      '/auth/': true,
      '/api/': true,
      '/download/': true,
    },
    gui: {
      title: 'OSI',
      sourceGuiTreeSha256: hashes.sourceGui,
      feedGuiTreeSha256: hashes.feedGui,
      rootfsGuiTreeSha256: hashes.rootfsGui,
    },
    criticalHashes: {
      flows: {
        sourceSha256: hashes.sourceFlows,
        rootfsSha256: hashes.rootfsFlows,
        matched: true,
      },
      database: {
        sourceSha256: hashes.sourceDb,
        rootfsSha256: hashes.rootfsDb,
        matched: true,
      },
      gui: {
        sourceGuiTreeSha256: hashes.sourceGui,
        feedGuiTreeSha256: hashes.feedGui,
        rootfsGuiTreeSha256: hashes.rootfsGui,
        matched: true,
      },
    },
    helpers: {
      relativeSymlinks: RELATIVE_HELPERS,
      directUntilFirstBoot: DIRECT_HELPERS,
      firstBootSeedVerified: true,
    },
    nodeResolution,
    database: {
      integrityCheck: 'ok',
      chameleonCalibrationRows: 0,
    },
  };
  const evidenceJson = {
    schemaVersion: 1,
    artifact,
    checks,
    config,
    rootfs,
    freshness,
    observations: {
      targetOutputAbsent: true,
      checkedTargetOutputPath: `openwrt/bin/targets/${target.openwrtTarget}/`,
      artifact,
      checks,
      config,
      rootfs,
      freshnessStatus: freshness.status,
      newerSourceAvailable: freshness.newerSourceAvailable,
      pinnedSha: freshness.pinnedSha,
      observedSha: freshness.observedSha,
      freshnessCheckedAt: freshness.checkedAt,
      freshnessError: freshness.status === 'unknown' ? freshness.error : null,
    },
  };
  const evidenceBytes = canonicalJson(evidenceJson);
  return {
    artifact,
    config,
    verification: {
      checks,
      rootfs,
      freshness,
      evidence: {
        json: evidenceJson,
        bytes: Buffer.byteLength(evidenceBytes),
        sha256: sha256(evidenceBytes),
      },
    },
  };
}

function commandRecord(argv: readonly string[], offset = 0): Record<string, unknown> {
  return {
    argv: [...argv],
    startedAt: new Date(Date.parse(STARTED_AT) + offset).toISOString(),
    finishedAt: new Date(Date.parse(STARTED_AT) + offset + 100).toISOString(),
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimit: false,
  };
}

function operationObservation(operationId: TrustedOperationId, jobId: string): Record<string, unknown> {
  return {
    operationId,
    attempt: 1,
    outcome: 'passed',
    evidencePath: `jobs/${jobId}/operations/${operationId}/attempt-1.json`,
    evidenceSha256: sha256(operationId),
  };
}

function stageObservations(
  target: TargetManifest,
  stage: PipelineStageName,
  paths: Readonly<{ worktree: string; targetOutput: string; rootfs: string; releaseImage: string }>,
  verificationSha256: string,
  buildManifestSha256 = '0'.repeat(64),
  runnerVerification?: ReturnType<typeof createRunnerVerification>,
): Record<string, unknown> {
  const operations = STAGE_OPERATIONS[stage];
  if (stage === 'preflight') {
    return {
      persistedPreflight: true,
      targetId: target.id,
      rootId: 'release',
      nodeVersion: '22.17.0',
      dockerServerVersion: '27.0.3',
    };
  }
  if (stage === 'source') {
    return {
      remoteUrl: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
      sourceRef: 'refs/remotes/origin/main',
      branch: 'main',
      pinnedSha: SHA40,
      commitTime: '2026-07-29T09:55:00.000Z',
      author: 'Builder <builder@example.test>',
      subject: 'Task 35 runner contract fixture',
      worktreeHead: SHA40,
      worktreeClean: true,
      dirtyStatus: '',
      components: [
        {
          path: 'feeds/chirpstack-openwrt-feed',
          treeId: '4'.repeat(40),
          provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git',
        },
        {
          path: 'openwrt',
          treeId: '5'.repeat(40),
          provenanceUrl: 'https://github.com/openwrt/openwrt.git',
        },
      ],
      remoteRefWarning: 'runner-offline-source-ref-not-rechecked',
      targetOutputAbsent: true,
      checkedTargetOutputPath: `openwrt/bin/targets/${target.openwrtTarget}/`,
    };
  }
  if (stage === 'target-setup') {
    const pi5 = targetManifest('rpi-5');
    const pi4 = targetManifest('rpi-2');
    return {
      target: target.id,
      patchDecision: 'applied',
      profiles: {
        'rpi-5': sourceProfileRecord(pi5),
        'rpi-2': sourceProfileRecord(pi4),
      },
    };
  }
  if (stage === 'feeds') {
    return {
      feed: {
        sourceSha256: '6'.repeat(64),
        destinationSha256: '6'.repeat(64),
        localPath: join(paths.worktree, 'feeds/chirpstack-openwrt-feed'),
        packagesCommit: '8'.repeat(40),
        installedPackages: ['node-red', 'node-red-contrib-chirpstack', 'node-red-node-sqlite', 'chirpstack'],
        prepared: [
          {
            name: 'packages',
            commit: '8'.repeat(40),
            sourceTreeSha256: '9'.repeat(64),
            destinationTreeSha256: '9'.repeat(64),
          },
          {
            name: 'chirpstack',
            commit: 'a'.repeat(40),
            sourceTreeSha256: 'b'.repeat(64),
            destinationTreeSha256: 'b'.repeat(64),
          },
        ],
      },
      rust: {
        sourceSha256: 'c'.repeat(64),
        enforcedSha256: 'd'.repeat(64),
        path: 'openwrt/feeds/packages/lang/rust/Makefile',
        sourceCommit: '8'.repeat(40),
        hostTriple: 'x86_64-unknown-linux-gnu',
      },
    };
  }
  if (stage === 'config') {
    const pi5 = targetManifest('rpi-5');
    const pi4 = targetManifest('rpi-2');
    return {
      config: {
        selectedTarget: target.openwrtTarget,
        profile: target.profile,
        rootfsPartSize: target.rootfsPartSize,
        bothProfilesChecked: true,
        profiles: {
          'rpi-5': resolvedProfileRecord(pi5),
          'rpi-2': resolvedProfileRecord(pi4),
        },
      },
    };
  }
  if (stage === 'verify') {
    if (runnerVerification === undefined) throw new Error('runner verification fixture is required');
    const evidence = runnerVerification.verification.evidence as {
      json: { observations: Record<string, unknown> };
    };
    const freshness = runnerVerification.verification.freshness as FreshnessFixture;
    return {
      artifact: runnerVerification.artifact,
      config: runnerVerification.config,
      // Keep the stored stage within the shared JSON budget. The full runner
      // verification object is retained separately and exercised by the
      // terminal-aggregation bound test below.
      verification: {
        checks: runnerVerification.verification.checks,
        rootfs: runnerVerification.verification.rootfs,
        freshness: runnerVerification.verification.freshness,
      },
      rootfs: runnerVerification.verification.rootfs,
      freshnessStatus: freshness.status,
      newerSourceAvailable: freshness.newerSourceAvailable,
      pinnedSha: freshness.pinnedSha,
      observedSha: freshness.observedSha,
      freshnessCheckedAt: freshness.checkedAt,
      freshnessError: freshness.status === 'unknown' ? freshness.error : null,
      ...evidence.json.observations,
    };
  }
  if (stage === 'publish') {
    const releaseRelative = `main/${SHA40}/${target.id}`;
    return {
      native: {
        ok: true,
        destinationRelativePath: releaseRelative,
      },
      recovered: false,
      nativeFailures: [],
      final: {
        verified: true,
        finalPath: `${releaseRelative}/${basename(paths.releaseImage)}`,
        artifactSha256: IMAGE_SHA256,
        artifactSize: target.minimumArtifactBytes,
        checksumPath: `${releaseRelative}/sha256sums`,
        checksumSha256: sha256(`${IMAGE_SHA256}  ${basename(paths.releaseImage)}\n`),
        manifestPath: `${releaseRelative}/build-manifest.json`,
        manifestSha256: buildManifestSha256,
        verificationPath: `${releaseRelative}/verification.json`,
        verificationSha256,
        staging: 'absent',
      },
    };
  }
  return {
    operations: operations.map((operationId) => operationObservation(operationId, `job-${target.id}`)),
  };
}

function stageDocument(
  target: TargetManifest,
  stage: PipelineStageName,
  paths: Readonly<{ worktree: string; targetOutput: string; rootfs: string; releaseImage: string }>,
  verificationSha256: string,
  buildManifestSha256 = '0'.repeat(64),
  runnerVerification?: ReturnType<typeof createRunnerVerification>,
): Record<string, unknown> {
  const operations = STAGE_OPERATIONS[stage];
  const operationId = operations.at(-1) ?? null;
  const commands = stage === 'source'
    ? [commandRecord(['/usr/bin/git', 'status', '--porcelain'])]
    : operations.map((candidate, index) => commandRecord(
        createOperationArgv(candidate, { environment: target.environment }),
        index * 200,
      ));
  const document = {
    schemaVersion: 1,
    jobId: `job-${target.id}`,
    stage,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    outcome: 'passed',
    operationId,
    commands,
    inputs: {
      targetId: target.id,
      rootId: 'release',
      branch: 'main',
      pinnedSha: SHA40,
    },
    observations: stageObservations(
      target,
      stage,
      paths,
      verificationSha256,
      buildManifestSha256,
      runnerVerification,
    ),
    error: null,
  };
  const prepared = productionEvidenceWriter.prepare(document as unknown as StageEvidenceInput);
  expect(prepared.bytes).toBe(canonicalJson(document));
  return JSON.parse(prepared.bytes) as Record<string, unknown>;
}

function fullVerifyDocument(
  target: TargetManifest,
  paths: Readonly<{ worktree: string; targetOutput: string; rootfs: string; releaseImage: string }>,
  verificationSha256: string,
  buildManifestSha256: string,
  runnerVerification: ReturnType<typeof createRunnerVerification>,
): Record<string, unknown> {
  const document = {
    schemaVersion: 1,
    jobId: `job-${target.id}`,
    stage: 'verify' as const,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    outcome: 'passed' as const,
    operationId: 'verify-image' as const,
    commands: STAGE_OPERATIONS.verify.map((operationId, index) => commandRecord(
      createOperationArgv(operationId, { environment: target.environment }),
      index * 200,
    )),
    inputs: {
      targetId: target.id,
      rootId: 'release',
      branch: 'main',
      pinnedSha: SHA40,
    },
    observations: {
      ...stageObservations(
        target,
        'verify',
        paths,
        verificationSha256,
        buildManifestSha256,
        runnerVerification,
      ),
      verification: runnerVerification.verification,
    },
    error: null,
  };
  return document;
}

async function ensureFile(path: string, contents: string | Buffer, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode });
}

async function recursiveContentHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const name = relative(root, path);
        hash.update(name);
        hash.update('\0');
        hash.update(sha256(await readFile(path)));
      } else {
        throw new Error(`tree contains non-regular entry: ${path}`);
      }
    }
  };
  await visit(root);
  return hash.digest('hex');
}

async function makeRemovable(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    return;
  }
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path).catch(() => [])) {
      await makeRemovable(join(path, entry));
    }
  } else if (!metadata.isSymbolicLink()) {
    await chmod(path, 0o600).catch(() => undefined);
  }
}

async function createHeldRegistry(root: string): Promise<ApprovedRootRegistry> {
  const authorityBase = await mkdtemp(join(tmpdir(), 'osi-real-acceptance-authority-'));
  temporaryDirectories.push(authorityBase);
  const configHome = join(authorityBase, 'config');
  const stateHome = join(authorityBase, 'state');
  const repositoryPath = join(authorityBase, 'repository');
  await Promise.all([
    mkdir(configHome, { recursive: true }),
    mkdir(repositoryPath, { recursive: true }),
  ]);
  const configPath = join(configHome, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [{ id: 'fixture', label: 'Fixture authority', path: root }],
    builderLockPath: '/opt/osi-image-builder/2026.07.29.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath,
    env: {
      HOME: authorityBase,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    },
    git: {
      getOriginPolicy: async () => ({
        url: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
        fetchRefspec: '+refs/heads/*:refs/remotes/origin/*',
      }),
    },
    rootFs: {
      statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }),
    },
  });
  return loaded.pathAuthorities.approvedRoots;
}

function result(stdout = ''): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: '' };
}

function expectedCommand(
  id: string,
  cwd: string,
  argv: readonly string[],
  stdout = '',
  policy: keyof typeof COMMAND_POLICIES = 'medium',
): ExpectedCommand {
  return {
    request: {
      id,
      cwd,
      argv: [...argv],
      env: FIXED_ENV,
      ...COMMAND_POLICIES[policy],
    },
    result: result(stdout),
  };
}

function expectedCommandMap(
  fixture: Pick<Fixture, 'worktree' | 'targetOutput' | 'releaseDir' | 'rootfs' | 'releaseImage' | 'targetImage' | 'target'>,
  canonicalImageRef: string,
  imageId: string,
): ReadonlyMap<string, ExpectedCommand> {
  const imageOk = `${basename(fixture.releaseImage)}: OK\n`;
  const dependencies = Object.fromEntries([
    ...THIRD_PARTY_PACKAGES.map((name) => [
      name,
      join('usr/share/node-red/node_modules', name, name === '@chirpstack/chirpstack-api'
        ? 'api/application_grpc_pb.js'
        : 'index.js'),
    ] as const),
    ...RELATIVE_HELPERS.map((name) => [name, join('usr/share/node-red', name, 'index.js')] as const),
    ...DIRECT_HELPERS.map((name) => [name, join('usr/share/node-red', name, 'index.js')] as const),
  ]);
  const inspection = canonicalJson({
    Id: `sha256:${imageId}`,
    RepoDigests: [canonicalImageRef],
  });
  return new Map([
    ['gzip-test', expectedCommand('gzip-test', heldExecutionPath(fixture.releaseDir), ['gzip', '-t', basename(fixture.releaseImage)])],
    ['git-origin', expectedCommand(
      'git-origin',
      heldExecutionPath(fixture.worktree),
      ['git', 'remote', 'get-url', 'origin'],
      'git@github.com:Open-Smart-Irrigation/osi-os.git\n',
      'short',
    )],
    ['repo-profile-parity', expectedCommand(
      'repo-profile-parity',
      heldExecutionPath(fixture.worktree),
      ['node', 'scripts/verify-profile-parity.js'],
      'All parity checks passed.\n',
      'releaseGate',
    )],
    ['repo-chameleon-calibration', expectedCommand(
      'repo-chameleon-calibration',
      heldExecutionPath(fixture.worktree),
      ['node', 'scripts/verify-chameleon-calibration.js'],
      'verify-chameleon-calibration PASS\n',
      'releaseGate',
    )],
    ['repo-db-schema', expectedCommand(
      'repo-db-schema',
      heldExecutionPath(fixture.worktree),
      ['node', 'scripts/verify-db-schema-consistency.js'],
      'DB schema consistency verification passed\n',
      'releaseGate',
    )],
    ['repo-sync-flow', expectedCommand(
      'repo-sync-flow',
      heldExecutionPath(fixture.worktree),
      ['node', 'scripts/verify-sync-flow.js'],
      'Sync flow verification passed\n',
      'releaseGate',
    )],
    ['repo-strega', expectedCommand(
      'repo-strega',
      heldExecutionPath(fixture.worktree),
      ['node', 'scripts/verify-strega-gen1.js'],
      'OK Strega Gen1 smoke checks passed\n',
      'releaseGate',
    )],
    ['repo-communication', expectedCommand(
      'repo-communication',
      heldExecutionPath(fixture.worktree),
      ['node', 'scripts/verify-communication-contract.js'],
      'Communication contract verification passed\n',
      'releaseGate',
    )],
    ['repo-mqtt-topics', expectedCommand(
      'repo-mqtt-topics',
      heldExecutionPath(fixture.worktree),
      ['scripts/check-mqtt-topics.sh'],
      [
        `OK: conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \u2014 no UUID patterns in MQTT IN topics`,
        `OK: conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \u2014 no UUID patterns in MQTT IN topics`,
        `OK: conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json \u2014 no UUID patterns in MQTT IN topics`,
        '',
      ].join('\n'),
      'releaseGate',
    )],
    ['target-sha256sum', expectedCommand(
      'target-sha256sum',
      heldExecutionPath(fixture.targetOutput),
      ['sha256sum', '-c', 'sha256sums'],
      imageOk,
    )],
    ['published-sha256sum', expectedCommand(
      'published-sha256sum',
      heldExecutionPath(fixture.releaseDir),
      ['sha256sum', '-c', 'sha256sums'],
      imageOk,
    )],
    ['sqlite-integrity', expectedCommand(
      'sqlite-integrity',
      heldExecutionPath(fixture.rootfs),
      ['node', '-e', SQLITE_SCRIPT, 'usr/share/db/farming.db'],
      '{"integrity":"ok","chameleonCalibrationCount":0}\n',
    )],
    ['node-dependency-resolution', expectedCommand(
      'node-dependency-resolution',
      heldExecutionPath(fixture.rootfs),
      ['node', '-e', NODE_RESOLUTION_SCRIPT, 'usr/share/node-red'],
      canonicalJson(dependencies),
    )],
    ['docker-image-inspect', expectedCommand(
      'docker-image-inspect',
      heldExecutionPath(fixture.worktree),
      ['docker', 'image', 'inspect', '--format', '{"Id":"{{.Id}}","RepoDigests":{{json .RepoDigests}}}', canonicalImageRef],
      inspection,
      'short',
    )],
  ]);
}

async function createLoadedFixtureConfig(
  base: string,
  approvedRoot: string,
  repositoryPath: string,
  installedLockPath: string,
): Promise<LoadedConfig> {
  const configHome = join(base, 'config-home');
  const stateHome = join(base, 'state-home');
  const configPath = join(configHome, 'osi-image-builder', 'config.json');
  await Promise.all([
    mkdir(approvedRoot, { recursive: true }),
    mkdir(repositoryPath, { recursive: true }),
    mkdir(dirname(configPath), { recursive: true }),
  ]);
  await writeFile(configPath, canonicalJson({
    repositoryPath,
    approvedOutputRoots: [{ id: 'release', label: 'Release images', path: approvedRoot }],
    builderLockPath: installedLockPath,
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  return loadConfig({
    configPath,
    env: {
      HOME: base,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    },
    git: {
      getOriginPolicy: async () => ({
        url: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
        fetchRefspec: '+refs/heads/*:refs/remotes/origin/*',
      }),
    },
    rootFs: {
      statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }),
    },
  });
}

async function createFixture(
  targetId: TargetId = 'rpi-5',
  options: Readonly<{
    seedReport?: boolean;
    seedDockerInspection?: boolean;
    lock?: Record<string, unknown>;
    lockEncoding?: 'sorted' | 'installer';
    buildManifestEncoding?: 'newline' | 'producer';
    freshness?: FreshnessFixture;
  }> = {},
): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), `osi-real-acceptance-${targetId}-`));
  temporaryDirectories.push(base);
  const target = targetManifest(targetId);
  const approvedRoot = join(base, 'releases');
  const versionRoot = join(base, 'installation', PACKAGE_VERSION);
  const repositoryPath = join(base, 'repository');
  const installedManifestPath = join(versionRoot, 'manifest', 'targets.json');
  const installedLockPath = join(versionRoot, 'builder.lock.json');
  const loadedConfig = await createLoadedFixtureConfig(
    base,
    approvedRoot,
    repositoryPath,
    installedLockPath,
  );
  const worktree = join(loadedConfig.stateRoot, 'jobs', `job-${target.id}`, 'workspace', 'source');
  const releaseDir = join(approvedRoot, 'main', SHA40, target.id);
  const jobEvidenceRoot = join(loadedConfig.stateRoot, 'jobs', `job-${target.id}`, 'evidence');
  const rootfs = join(worktree, 'openwrt', target.rootfs);
  const targetOutput = join(worktree, 'openwrt', 'bin', 'targets', target.openwrtTarget);
  const buildManifestPath = join(releaseDir, 'build-manifest.json');
  const publishedVerificationPath = join(releaseDir, 'verification.json');
  const publishedChecksumsPath = join(releaseDir, 'sha256sums');
  const reportPath = join(jobEvidenceRoot, 'real-acceptance-report.json');
  const dockerInspectionPath = join(jobEvidenceRoot, 'docker-inspection.json');
  const imageName = target.artifactGlob.replace('*', '0.7.0');
  const releaseImage = join(releaseDir, imageName);
  const targetImage = join(targetOutput, imageName);
  const sourceRoot = join(worktree, 'conf', target.environment, 'files');
  const sourceFlows = join(sourceRoot, 'usr/share/flows.json');
  const sourceDb = join(sourceRoot, 'usr/share/db/farming.db');
  const sourceGui = join(worktree, 'web/react-gui/build');
  const feedGui = join(worktree, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
  const rootfsGui = join(rootfs, 'usr/lib/node-red/gui');
  const nodeRedRoot = join(rootfs, 'usr/share/node-red');
  const nodeModulesRoot = join(nodeRedRoot, 'node_modules');
  const lock = options.lockEncoding === 'installer'
    ? installerOrderedLock(structuredClone(options.lock ?? productionLock()))
    : structuredClone(options.lock ?? productionLock());
  const lockValidation = validateBuilderLock(lock, PACKAGE_VERSION);
  if (!lockValidation.ok) throw new Error(`fixture lock is invalid: ${lockValidation.reason}`);
  const lockBytes = Buffer.from(options.lockEncoding === 'installer'
    ? `${JSON.stringify(lock)}\n`
    : canonicalJson(lock));

  await Promise.all([
    mkdir(releaseDir, { recursive: true }),
    mkdir(jobEvidenceRoot, { recursive: true }),
    mkdir(targetOutput, { recursive: true }),
    mkdir(rootfs, { recursive: true }),
    mkdir(versionRoot, { recursive: true }),
    ensureFile(installedManifestPath, INSTALLED_MANIFEST_BYTES),
    ensureFile(installedLockPath, lockBytes),
    ensureFile(join(worktree, 'conf', target.environment, '.config'), configLines(target)),
    mkdir(join(worktree, 'conf', target.environment, 'patches'), { recursive: true }),
    ensureFile(sourceFlows, '{"flows":"runner-contract"}\n'),
    ensureFile(sourceDb, 'sqlite-fixture'),
    ensureFile(join(sourceGui, 'index.html'), '<!doctype html><title>OSI</title>\n'),
    ensureFile(join(sourceGui, 'assets/nested/app.js'), 'console.log("osi");\n'),
    ensureFile(join(feedGui, 'index.html'), '<!doctype html><title>OSI</title>\n'),
    ensureFile(join(feedGui, 'assets/nested/app.js'), 'console.log("osi");\n'),
    ensureFile(join(rootfsGui, 'index.html'), '<!doctype html><title>OSI</title>\n'),
    ensureFile(join(rootfsGui, 'assets/nested/app.js'), 'console.log("osi");\n'),
    ensureSparseImage(releaseImage, target.minimumArtifactBytes),
    ensureSparseImage(targetImage, target.minimumArtifactBytes),
    ensureFile(join(targetOutput, 'sha256sums'), `${IMAGE_SHA256}  ${imageName}\n`),
  ]);

  await Promise.all([
    symlink(`${target.environment}/.config`, join(worktree, 'conf/.config')),
    symlink(`${target.environment}/files`, join(worktree, 'conf/files')),
    symlink(`${target.environment}/patches`, join(worktree, 'conf/patches')),
    symlink('../conf/.config', join(worktree, 'openwrt/.config')),
    symlink('../conf/files', join(worktree, 'openwrt/files')),
    symlink('../conf/patches', join(worktree, 'openwrt/patches')),
  ]);

  await Promise.all([
    ensureFile(join(rootfs, 'usr/share/flows.json'), await readFile(sourceFlows)),
    ensureFile(join(rootfs, 'usr/share/db/farming.db'), await readFile(sourceDb)),
    ensureFile(
      join(rootfs, 'etc/nginx/conf.d/node-red.locations'),
      'location /gui/ {}\nlocation /auth/ {}\nlocation /api/ {}\nlocation /download/ {}\n',
    ),
    ...REQUIRED_RUNTIME_FILES.filter((path) => ![
      '/usr/share/flows.json',
      '/usr/share/db/farming.db',
      '/usr/lib/node-red/gui/index.html',
    ].includes(path) && !path.includes('/node_modules/osi-') && !path.endsWith('/package.json')).map((path) => ensureFile(
      join(rootfs, path.slice(1)),
      path.endsWith('package.json') ? canonicalJson({ name: basename(dirname(path)), version: '1.0.0' }) : 'fixture\n',
    )),
    ...[...RELATIVE_HELPERS, ...DIRECT_HELPERS].flatMap((name) => [
      ensureFile(join(nodeRedRoot, name, 'package.json'), canonicalJson({ name, version: '1.0.0' })),
      ensureFile(join(nodeRedRoot, name, 'index.js'), 'module.exports = {};\n'),
    ]),
    ...THIRD_PARTY_PACKAGES.flatMap((name) => [
      ensureFile(join(nodeModulesRoot, name, 'package.json'), canonicalJson({ name, version: '1.0.0' })),
      ensureFile(
        join(nodeModulesRoot, name, name === '@chirpstack/chirpstack-api' ? 'api/application_grpc_pb.js' : 'index.js'),
        'module.exports = {};\n',
      ),
    ]),
  ]);

  await Promise.all(RELATIVE_HELPERS.map((name) => symlink(`../${name}`, join(nodeModulesRoot, name))));

  const contentHashes = {
    sourceFlows: sha256(await readFile(sourceFlows)),
    rootfsFlows: sha256(await readFile(join(rootfs, 'usr/share/flows.json'))),
    sourceDb: sha256(await readFile(sourceDb)),
    rootfsDb: sha256(await readFile(join(rootfs, 'usr/share/db/farming.db'))),
    sourceGui: await recursiveContentHash(sourceGui),
    feedGui: await recursiveContentHash(feedGui),
    rootfsGui: await recursiveContentHash(rootfsGui),
  };
  const freshness = options.freshness ?? freshnessFixture();
  const runnerVerification = createRunnerVerification(target, imageName, contentHashes, freshness);
  const rootMetadata = await stat(approvedRoot);
  const preflight = stageDocument(target, 'preflight', {
    worktree,
    targetOutput,
    rootfs,
    releaseImage,
  }, '0'.repeat(64));
  const preflightBytes = canonicalJson(preflight);
  const operationExecutions = PIPELINE_STAGE_NAMES.flatMap((stage) => (
    STAGE_OPERATIONS[stage].map((operationId, index) => {
      const command = commandRecord(
        createOperationArgv(operationId, { environment: target.environment }),
        index * 200,
      );
      return {
        operationId,
        attempt: 1,
        argv: command.argv,
        exitCode: command.exitCode,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
        observations: operationObservation(operationId, `job-${target.id}`),
      };
    })
  ));
  const buildManifest = {
    ...lockBuildFields(lock),
    builderLockSha256: sha256(lockBytes),
    canonicalImageRef: `${String(lock.imageRepository)}@sha256:${String(lock.imageDigest)}`,
    targetManifestSha256: sha256(INSTALLED_MANIFEST_BYTES),
    jobId: `job-${target.id}`,
    branch: 'main',
    pinnedSha: SHA40,
    targetId: target.id,
    rootId: 'release',
    rootIdentity: {
      device: rootMetadata.dev,
      inode: rootMetadata.ino,
    },
    source: {
      remote: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
      ref: 'refs/remotes/origin/main',
      branch: 'main',
      pinnedSha: SHA40,
      commitTime: '2026-07-29T09:55:00.000Z',
      author: 'Builder <builder@example.test>',
      subject: 'Task 35 runner contract fixture',
    },
    config: runnerVerification.config,
    tool: {
      nodeVersion: String(lock.nodeVersion),
      preflight: {
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        evidencePath: `jobs/job-${target.id}/evidence/00-preflight.json`,
        evidenceSha256: sha256(preflightBytes),
        observations: preflight.observations,
      },
      operations: operationExecutions,
    },
    artifactSha256: IMAGE_SHA256,
    artifactSize: target.minimumArtifactBytes,
    artifactMtime: ARTIFACT_MTIME,
    artifactBasename: imageName,
  };
  const buildManifestBytes = Buffer.from(canonicalJson(
    buildManifest,
    options.buildManifestEncoding !== 'producer',
  ));
  const stagedAggregation = {
    ...buildManifest,
    observations: {
      stageEvidence: FIXED_EVIDENCE.map(({ stage, path }) => ({
        stage,
        path,
        outcome: 'passed',
      })),
      publishEvidence: {
        path: `jobs/job-${target.id}/evidence/09-publish.json`,
      },
    },
  };
  const terminal = createTerminalVerification(
    `job-${target.id}`,
    stagedAggregation as Parameters<typeof createTerminalVerification>[1],
  );
  const aggregation = JSON.parse(terminal.bytes) as Record<string, unknown>;
  const aggregationBytes = terminal.bytes;
  const fullVerifyStageDocument = fullVerifyDocument(
    target,
    { worktree, targetOutput, rootfs, releaseImage },
    sha256(aggregationBytes),
    sha256(buildManifestBytes),
    runnerVerification,
  );
  const evidenceBytes = new Map<string, string>();
  for (const { stage, path } of FIXED_EVIDENCE) {
    const document = stage === 'preflight'
      ? preflight
      : stageDocument(target, stage, {
          worktree,
          targetOutput,
          rootfs,
          releaseImage,
        }, sha256(aggregationBytes), sha256(buildManifestBytes), runnerVerification);
    const bytes = canonicalJson(document);
    evidenceBytes.set(path, bytes);
    await ensureFile(join(jobEvidenceRoot, path), bytes, 0o444);
  }

  const dockerInspection = {
    Id: `sha256:${String(lock.imageId)}`,
    RepoDigests: [buildManifest.canonicalImageRef],
  };
  const dockerInspectionBytes = canonicalJson(dockerInspection);
  if (options.seedDockerInspection !== false) {
    await ensureFile(dockerInspectionPath, dockerInspectionBytes, 0o600);
  }
  await Promise.all([
    ensureFile(buildManifestPath, buildManifestBytes, 0o444),
    ensureFile(publishedVerificationPath, aggregationBytes, 0o444),
    ensureFile(publishedChecksumsPath, `${IMAGE_SHA256}  ${imageName}\n`, 0o444),
  ]);

  const feedGuiTreeSha256 = contentHashes.feedGui;
  const sourceGuiTreeSha256 = contentHashes.sourceGui;
  const rootfsGuiTreeSha256 = contentHashes.rootfsGui;
  const stageEvidenceSha256 = Object.fromEntries(
    FIXED_EVIDENCE.map(({ path }) => [path, sha256(evidenceBytes.get(path)!)]),
  );
  const expectedObservations = {
    stageEvidenceSha256,
    sourceEvidenceSha256: stageEvidenceSha256['01-source.json'],
    verifyEvidenceSha256: stageEvidenceSha256['08-verify.json'],
    targetOutputAbsent: true,
    freshnessStatus: freshness.status,
    newerSourceAvailable: freshness.newerSourceAvailable,
    sourceSha: SHA40,
    targetId: target.id,
    targetProfile: target.profile,
    targetOpenwrtTarget: target.openwrtTarget,
    targetRootfsPartSize: target.rootfsPartSize,
    sourceConfigSha256: target.id === 'rpi-5' ? '2'.repeat(64) : '4'.repeat(64),
    resolvedConfigSha256: target.id === 'rpi-5' ? '3'.repeat(64) : '5'.repeat(64),
    installedLockSha256: sha256(lockBytes),
    dependencyEgressProxySha256: lock.dependencyEgressProxySha256,
    buildManifestSha256: sha256(buildManifestBytes),
    publishedImageSha256: IMAGE_SHA256,
    publishedImageSize: target.minimumArtifactBytes,
    publishedImageMtime: ARTIFACT_MTIME,
    dockerInspectionSha256: sha256(dockerInspectionBytes),
    targetManifestSha256: sha256(INSTALLED_MANIFEST_BYTES),
    publishedSha256sumsSha256: sha256(`${IMAGE_SHA256}  ${imageName}\n`),
    publishedVerificationSha256: sha256(aggregationBytes),
    sourceFlowsSha256: contentHashes.sourceFlows,
    rootfsFlowsSha256: contentHashes.rootfsFlows,
    sourceDbSha256: contentHashes.sourceDb,
    rootfsDbSha256: contentHashes.rootfsDb,
    feedGuiTreeSha256,
    sourceGuiTreeSha256,
    rootfsGuiTreeSha256,
    sqliteIntegrity: 'ok',
    chameleonCalibrationCount: 0,
    imageDigest: lock.imageDigest,
    imageId: lock.imageId,
    canonicalImageRef: buildManifest.canonicalImageRef,
  };
  if (options.seedReport !== false) {
    await ensureFile(reportPath, canonicalJson({
      schemaVersion: 1,
      targetId: target.id,
      jobId: `job-${target.id}`,
      branch: 'main',
      pinnedSha: SHA40,
      rootId: 'release',
      rootIdentity: buildManifest.rootIdentity,
      generatedAt: FINISHED_AT,
      observations: expectedObservations,
    }), 0o600);
  }

  const evidence = FIXED_EVIDENCE.map(({ stage, path }) => ({
    stage,
    outcome: 'passed',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    path: `evidence/${path}`,
    evidenceSha256: stageEvidenceSha256[path],
    errorCode: null,
  }));
  const artifact = {
    rootId: 'release',
    directory: `main/${SHA40}/${target.id}`,
    path: `main/${SHA40}/${target.id}/${imageName}`,
    sha256: IMAGE_SHA256,
    size: target.minimumArtifactBytes,
    mtime: ARTIFACT_MTIME,
    publishState: 'published',
    publishedAt: FINISHED_AT,
  };
  const job: JobDto = {
    id: `job-${target.id}`,
    state: 'succeeded',
    branch: 'main',
    targetId: target.id,
    outputRootId: 'release',
    acceptedAt: STARTED_AT,
    currentStage: 'publish',
    queuePosition: null,
    terminalAt: FINISHED_AT,
    stage: 'publish',
    pinnedSha: SHA40,
    cancelRequestedAt: null,
    artifact,
    freshnessStatus: freshness.status,
    freshnessCheckedAt: freshness.checkedAt,
    newerSourceAvailable: freshness.newerSourceAvailable,
    error: null,
    source: {
      branch: 'main',
      sourceRef: 'refs/remotes/origin/main',
      expectedSha: SHA40,
      pinnedSha: SHA40,
      commitTime: '2026-07-29T09:55:00.000Z',
      author: 'Builder <builder@example.test>',
      subject: 'Task 35 runner contract fixture',
    },
    output: artifact,
    errors: {
      terminal: null,
      publish: null,
      cleanup: null,
      freshness: freshness.status === 'unknown'
        ? { code: 'FRESHNESS_UNKNOWN', details: {} }
        : null,
    },
    cancellation: {
      requestedAt: null,
      cooperativeDeadlineAt: null,
      graceDeadlineAt: null,
    },
    runtime: {
      runnerUnit: `osi-image-builder-runner@job-${target.id}.service`,
      dispatchedAt: STARTED_AT,
      cleanupOutcome: 'removed',
    },
    evidence,
  };
  expect(Object.keys(job).sort()).toEqual([...JOB_DETAIL_KEYS].sort());
  const installedManifest = loadManifest(installedManifestPath);
  const context: TrustedAcceptanceContext = {
    targetId: target.id,
    branch: 'main',
    pinnedSha: SHA40,
    outputRootId: 'release',
    selectedInstallation: {
      versionRoot,
      lockPath: installedLockPath,
      lockBytes,
      lock: structuredClone(lock),
      manifestPath: installedManifestPath,
      manifestBytes: Buffer.from(INSTALLED_MANIFEST_BYTES),
      manifest: installedManifest,
      dependencyEgressProxySha256: lock.dependencyEgressProxySha256 as string,
    },
    loadedConfig,
    job,
  };

  const commandRequests: CommandRequest[] = [];
  const httpRequests: HttpRequest[] = [];
  const hashedFiles: string[] = [];
  const heldReads: string[] = [];
  const heldCwds: string[] = [];
  const heldCwdRevalidations: string[] = [];
  const acceptancePublicationCalls: string[] = [];
  const acceptancePublicationSnapshots: Record<string, HeldEvidenceSnapshot> = {};
  const reopenedDescriptors: string[] = [];
  const reopenedDescriptorSnapshots: ReopenedDescriptorSnapshot[] = [];
  const heldRegistry = await createHeldRegistry(base);
  const expectedCommands = expectedCommandMap({
    worktree,
    targetOutput,
    releaseDir,
    rootfs,
    releaseImage,
    targetImage,
    target,
  }, String(buildManifest.canonicalImageRef), String(lock.imageId));
  const withHeldFile = async <T>(
    absolutePath: string,
    callback: (reader: ReadCapability) => Promise<T>,
  ): Promise<T> => {
    if (absolutePath === base || !absolutePath.startsWith(`${base}/`)) {
      throw new Error(`path is outside held fixture authority: ${absolutePath}`);
    }
    const relativePath = relative(base, absolutePath);
    heldReads.push(absolutePath);
    return withNoFollowFileUnderRoot(heldRegistry, 'fixture', relativePath, callback);
  };
  const runCommand = async (request: CommandRequest): Promise<CommandResult> => {
    commandRequests.push(structuredClone(request));
    const expected = expectedCommands.get(request.id);
    if (expected === undefined) throw new Error(`unexpected command: ${request.id}`);
    expect(request).toEqual(expected.request);
    return expected.result;
  };
  const withHeldDirectory = async <T>(
    path: string,
    callback: (authority: Readonly<{ executionPath: string; descriptorPath: string; revalidate: () => Promise<void> }>) => Promise<T>,
  ): Promise<T> => {
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`unsafe command cwd: ${path}`);
    const executionPath = heldExecutionPath(path);
    heldCwds.push(executionPath);
    const held = await holdTestDirectoryAuthority(path, { finalAccess: 'read' });
    if (held.executionPath === undefined) throw new Error(`held command cwd descriptor is missing: ${path}`);
    try {
      return await callback({
        executionPath,
        descriptorPath: held.executionPath,
        revalidate: async () => {
          heldCwdRevalidations.push(executionPath);
          await held.revalidate();
        },
      });
    } finally {
      await held.close();
    }
  };
  const publishAcceptanceEvidence = async (request: Readonly<{
    jobId: string;
    relativePath: string;
    contents: string | Buffer;
  }>): Promise<HeldEvidenceSnapshot> => {
    if (request.jobId !== job.id) throw new Error('acceptance evidence job ID mismatch');
    if (request.relativePath.includes('/') || request.relativePath.includes('\\')) {
      throw new Error('acceptance evidence publication must be basename-relative');
    }
    const path = join(jobEvidenceRoot, request.relativePath);
    acceptancePublicationCalls.push(request.relativePath);
    const expectedContents = Buffer.from(request.contents);
    try {
      const existing = await readFile(path);
      if (!existing.equals(expectedContents)) throw new Error('pre-seeded acceptance evidence differs');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await ensureFile(path, expectedContents, 0o600);
    }
    const snapshot = await withHeldFile(path, async (reader) => {
      const held = await reader.stat();
      const named = await lstat(path);
      const bytes = await reader.readFile();
      return {
        path: `jobs/${job.id}/evidence/${request.relativePath}`,
        bytes,
        sha256: sha256(bytes),
        regular: named.isFile(),
        singleLink: held.links === 1,
        device: held.device,
        mode: named.mode & 0o7777,
        size: held.size,
      };
    });
    acceptancePublicationSnapshots[request.relativePath] = snapshot;
    return snapshot;
  };
  const http = {
    request: async (request: HttpRequest): Promise<HttpResponse> => {
      httpRequests.push(structuredClone(request));
      const selection = {
        branch: 'main',
        expectedSha: SHA40,
        targetId: target.id,
        outputRootId: 'release',
      };
      if (request.method === 'POST' && request.path === '/api/branches/refresh') {
        return {
          status: 200,
          body: {
            fetchedAt: STARTED_AT,
            branches: [{
              name: 'main',
              sha: SHA40,
              commitTime: '2026-07-29T09:55:00.000Z',
              subject: 'Task 35 runner contract fixture',
            }],
          },
        };
      }
      if (request.method === 'POST' && request.path === '/api/preflight') {
        return {
          status: 200,
          body: {
            preflightId: `pf_${target.id}`,
            observedSha: SHA40,
            expiresAt: '2026-07-29T10:10:00.000Z',
            checks: exactPreflightChecks(),
          },
        };
      }
      if (request.method === 'POST' && request.path === '/api/jobs') {
        return {
          status: 202,
          body: {
            job: {
              id: job.id,
              state: 'queued',
              queuePosition: 0,
              branch: selection.branch,
              targetId: selection.targetId,
              outputRootId: selection.outputRootId,
            },
          },
        };
      }
      if (request.method === 'GET' && request.path === `/api/jobs/${job.id}`) {
        return { status: 200, body: job };
      }
      throw new Error(`unexpected local API request: ${request.method} ${request.path}`);
    },
  };
  const dependencies = {
    http,
    clock: { now: () => Date.parse(STARTED_AT) },
    sleep: async (_milliseconds: number) => undefined,
    assertActiveTargetLinks: async (executionPath: string, environment: string) => {
      expect(executionPath).toBe(heldExecutionPath(worktree));
      await assertActiveTargetLinks(worktree, environment);
    },
    withNoFollowFile: withHeldFile,
    withHeldDirectory,
    listArtifacts: async (directory: string, pattern: string) => {
      const [prefix, suffix] = pattern.split('*');
      if (prefix === undefined || suffix === undefined) throw new Error('fixture artifact glob is invalid');
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
        .map((entry) => join(directory, entry.name))
        .sort();
    },
    statRoot: async (path: string) => {
      const metadata = await stat(path);
      return { device: metadata.dev, inode: metadata.ino };
    },
    publishAcceptanceEvidence,
    reopenDescriptor: async (request: ReopenDescriptorRequest): Promise<ReopenedDescriptorSnapshot> => {
      reopenedDescriptors.push(request.relativeName);
      if (request.kind === 'file') {
        const { sha256: digest, stats } = await hashDescriptorFile(request.executionPath);
        const snapshot = {
          relativeName: request.relativeName,
          path: request.path,
          kind: 'file' as const,
          sha256: digest,
          regular: stats.isFile(),
          singleLink: stats.nlink === 1n,
          device: Number(stats.dev),
          inode: Number(stats.ino),
          links: Number(stats.nlink),
          mode: Number(stats.mode) & 0o7777,
          size: Number(stats.size),
          mtimeNs: stats.mtimeNs.toString(),
          ctimeNs: stats.ctimeNs.toString(),
        };
        reopenedDescriptorSnapshots.push(snapshot);
        return snapshot;
      }
      const handle = await open(request.executionPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const named = await handle.stat({ bigint: true }) as BigIntStats;
      await handle.close();
      const snapshot = {
        relativeName: request.relativeName,
        path: request.path,
        kind: 'directory' as const,
        regular: false,
        singleLink: named.nlink >= 1n,
        device: Number(named.dev),
        inode: Number(named.ino),
        links: Number(named.nlink),
        mode: Number(named.mode) & 0o7777,
        size: Number(named.size),
        mtimeNs: named.mtimeNs.toString(),
        ctimeNs: named.ctimeNs.toString(),
      };
      reopenedDescriptorSnapshots.push(snapshot);
      return snapshot;
    },
    statArtifact: async (path: string) => {
      if (path !== releaseImage && path !== targetImage) throw new Error(`unexpected artifact stat: ${path}`);
      return withHeldFile(path, async (reader) => {
        const observed = await reader.stat();
        return {
          regular: true,
          symlink: false,
          size: observed.size,
          mtimeMs: observed.mtimeMs,
        };
      });
    },
    hashFile: async (path: string) => {
      if (path !== releaseImage && path !== targetImage) throw new Error(`unexpected artifact hash: ${path}`);
      hashedFiles.push(path);
      return withHeldFile(path, (reader) => reader.hashSha256());
    },
    hashTree: recursiveContentHash,
    chmodHandle: async (handle: { chmod: (mode: number) => Promise<void> }, mode: number) => {
      await handle.chmod(mode);
    },
    runCommand,
  };

  await Promise.all([
    chmod(releaseImage, 0o600),
    chmod(buildManifestPath, 0o600),
    chmod(publishedVerificationPath, 0o600),
    chmod(publishedChecksumsPath, 0o600),
    chmod(releaseDir, 0o700),
  ]);

  return {
    base,
    approvedRoot,
    versionRoot,
    worktree,
    releaseDir,
    jobEvidenceRoot,
    rootfs,
    targetOutput,
    installedManifestPath,
    installedLockPath,
    buildManifestPath,
    publishedVerificationPath,
    publishedChecksumsPath,
    reportPath,
    dockerInspectionPath,
    releaseImage,
    targetImage,
    target,
    lock,
    buildManifest,
    fullVerification: runnerVerification.verification,
    fullVerifyDocument: fullVerifyStageDocument,
    aggregation,
    loadedConfig,
    context,
    job,
    expectedObservations,
    expectedCommands,
    commandRequests,
    httpRequests,
    hashedFiles,
    heldReads,
    heldCwds,
    heldCwdRevalidations,
    acceptancePublicationCalls,
    acceptancePublicationSnapshots,
    reopenedDescriptors,
    reopenedDescriptorSnapshots,
    heldRegistry,
    dependencies,
  };
}

async function releaseSnapshot(path: string): Promise<readonly string[]> {
  return Promise.all((await readdir(path)).sort().map(async (name) => {
    const child = join(path, name);
    const metadata = await lstat(child);
    return `${name}:${metadata.mode & 0o7777}:${metadata.isFile() ? sha256(await readFile(child)) : 'directory'}`;
  }));
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await makeRemovable(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

function selection(fixture: Fixture): Readonly<Record<string, unknown>> {
  return {
    branch: 'main',
    expectedSha: SHA40,
    targetId: fixture.target.id,
    outputRootId: 'release',
  };
}

function exactPreflightChecks(): readonly Record<string, unknown>[] {
  return PREFLIGHT_CHECK_IDS.map((id) => ({
    id,
    status: 'passed',
    details: id === 'source-sha'
      ? { expectedSha: SHA40, observedSha: SHA40, remote: 'origin' }
      : id === 'disk-output'
        ? { freeBytes: 30 * 1024 ** 3, minimumBytes: 20 * 1024 ** 3 }
        : { available: true },
  }));
}

function expectedApiRequest(
  method: HttpRequest['method'],
  path: string,
  body?: Readonly<Record<string, unknown>>,
): HttpRequest {
  return {
    method,
    baseUrl: API_BASE_URL,
    path,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: API_BASE_URL,
    },
    timeoutMs: method === 'POST' && path === '/api/jobs'
      ? ENQUEUE_REQUEST_TIMEOUT_MS
      : API_REQUEST_TIMEOUT_MS,
    ...(body === undefined ? {} : { body }),
  };
}

function expectedApiRequests(fixture: Fixture): readonly HttpRequest[] {
  return [
    expectedApiRequest('POST', '/api/branches/refresh', {}),
    expectedApiRequest('POST', '/api/preflight', selection(fixture)),
    expectedApiRequest('POST', '/api/jobs', { ...selection(fixture), preflightId: `pf_${fixture.target.id}` }),
    expectedApiRequest('GET', `/api/jobs/${fixture.job.id}`),
  ];
}

function dependencyHttp(
  fixture: Fixture,
  transform: (request: HttpRequest, response: HttpResponse) => Promise<HttpResponse> | HttpResponse,
): Record<string, unknown> {
  const base = fixture.dependencies.http as {
    request: (request: HttpRequest) => Promise<HttpResponse>;
  };
  return {
    ...fixture.dependencies,
    http: {
      request: async (request: HttpRequest) => transform(request, await base.request(request)),
    },
  };
}

function contextWithJob(fixture: Fixture, mutate: (job: JobDto) => void): TrustedAcceptanceContext {
  const job = structuredClone(fixture.job) as JobDto;
  mutate(job);
  return { ...fixture.context, job };
}

async function contextWithVerifyObservation(
  fixture: Fixture,
  mutateObservation: (observations: Record<string, unknown>) => void,
  mutateJob: (job: JobDto) => void,
): Promise<TrustedAcceptanceContext> {
  const verifyPath = join(fixture.jobEvidenceRoot, '08-verify.json');
  const document = JSON.parse(await readFile(verifyPath, 'utf8')) as Record<string, unknown>;
  mutateObservation(document.observations as Record<string, unknown>);
  await chmod(verifyPath, 0o600);
  await writeFile(verifyPath, canonicalJson(document));
  const bytes = await readFile(verifyPath);
  return contextWithJob(fixture, (job) => {
    const verifyEntry = (job.evidence as Array<Record<string, unknown>>)[8]!;
    verifyEntry.evidenceSha256 = sha256(bytes);
    mutateJob(job);
  });
}

async function verifyTarget(
  fixture: Fixture,
  options: Readonly<{
    context?: TrustedAcceptanceContext;
    dependencies?: Record<string, unknown>;
  }> = {},
): Promise<Record<string, unknown>> {
  return acceptance.verifyTargetAcceptance({
    env: REAL_ENV,
    context: options.context ?? fixture.context,
    dependencies: options.dependencies ?? fixture.dependencies,
  }) as Promise<Record<string, unknown>>;
}

async function acceptTarget(
  fixture: Fixture,
  options: Readonly<{
    env?: Record<string, string>;
    context?: TrustedAcceptanceContext;
    dependencies?: Record<string, unknown>;
  }> = {},
): Promise<Record<string, unknown>> {
  return acceptance.acceptTarget({
    env: options.env ?? REAL_ENV,
    context: options.context ?? fixture.context,
    dependencies: options.dependencies ?? fixture.dependencies,
    poll: { intervalMs: 1_000, timeoutMs: 60_000 },
  }) as Promise<Record<string, unknown>>;
}

async function rewriteReleaseJson(path: string, value: unknown): Promise<void> {
  await chmod(path, 0o600);
  await writeFile(path, canonicalJson(value));
}

function fixedStageEntries(aggregation: Record<string, unknown>): Array<Record<string, unknown>> {
  const observations = aggregation.observations as Record<string, unknown>;
  return observations.stageEvidence as Array<Record<string, unknown>>;
}

async function releaseModes(fixture: Fixture): Promise<Record<string, number>> {
  return Object.fromEntries(await Promise.all([
    fixture.releaseImage,
    fixture.buildManifestPath,
    fixture.publishedVerificationPath,
    fixture.publishedChecksumsPath,
    fixture.releaseDir,
  ].map(async (path) => [basename(path), (await lstat(path)).mode & 0o777])));
}

async function replaceReleaseDirectory(fixture: Fixture, suffix: string): Promise<void> {
  const bytes = new Map<string, Buffer>();
  for (const name of await readdir(fixture.releaseDir)) {
    bytes.set(name, await readFile(join(fixture.releaseDir, name)));
  }
  await rename(fixture.releaseDir, `${fixture.releaseDir}.${suffix}`);
  await mkdir(fixture.releaseDir, { mode: 0o755 });
  for (const [name, contents] of bytes) {
    await writeFile(join(fixture.releaseDir, name), contents, { mode: 0o444 });
  }
  await chmod(fixture.releaseDir, 0o555);
}

async function replaceReleaseMemberAfterVerification(
  fixture: Fixture,
  member: ReleaseMemberName,
): Promise<void> {
  const path = member === 'image'
    ? fixture.releaseImage
    : join(fixture.releaseDir, member);
  await rename(path, join(fixture.base, `verified-${basename(path)}`));
  if (member === 'image') {
    await writeFile(path, Buffer.from([1]), { mode: 0o600 });
    await truncate(path, fixture.target.minimumArtifactBytes);
    await utimes(path, new Date(ARTIFACT_MTIME), new Date(ARTIFACT_MTIME));
    return;
  }
  if (member === 'sha256sums') {
    await writeFile(path, `${'0'.repeat(64)}  ${basename(fixture.releaseImage)}\n`, { mode: 0o600 });
    return;
  }
  const document = member === 'build-manifest.json'
    ? structuredClone(fixture.buildManifest)
    : structuredClone(fixture.aggregation);
  document.postVerificationReplacement = true;
  await writeFile(path, canonicalJson(document), { mode: 0o600 });
}

async function replaceReleaseImageWithSpecialEntry(
  fixture: Fixture,
  kind: 'symlink' | 'hardlink' | 'fifo' | 'subdirectory',
): Promise<void> {
  await rm(fixture.releaseImage);
  if (kind === 'symlink') {
    await symlink(fixture.targetImage, fixture.releaseImage);
  } else if (kind === 'hardlink') {
    await link(fixture.targetImage, fixture.releaseImage);
  } else if (kind === 'fifo') {
    await execFile('mkfifo', [fixture.releaseImage]);
  } else {
    await mkdir(fixture.releaseImage);
    await writeFile(join(fixture.releaseImage, 'nested'), 'not an image\n');
  }
}

const RELEASE_MEMBER_KINDS = ['image', 'build-manifest.json', 'verification.json', 'sha256sums'] as const;
type ReleaseMemberName = typeof RELEASE_MEMBER_KINDS[number];

async function replaceReleaseMemberWithSpecialEntry(
  fixture: Fixture,
  member: ReleaseMemberName,
  kind: 'symlink' | 'hardlink' | 'fifo' | 'subdirectory',
): Promise<void> {
  const path = member === 'image'
    ? fixture.releaseImage
    : join(fixture.releaseDir, member);
  await rm(path, { recursive: kind === 'subdirectory' });
  const decoy = join(fixture.base, `decoy-${member.replaceAll(/[^A-Za-z0-9]/gu, '-')}`);
  if (kind === 'symlink') {
    await symlink(fixture.targetImage, path);
  } else if (kind === 'hardlink') {
    await ensureFile(decoy, 'hardlink decoy\n', 0o600);
    await link(decoy, path);
  } else if (kind === 'fifo') {
    await execFile('mkfifo', [path]);
  } else {
    await mkdir(path);
    await writeFile(join(path, 'nested'), 'not a release member\n');
  }
}

async function foreignDeviceFor(path: string): Promise<number> {
  const local = await stat(path);
  for (const candidate of ['/dev/shm', '/proc', '/sys']) {
    try {
      const metadata = await stat(candidate);
      if (metadata.dev !== local.dev) return metadata.dev;
    } catch {
      // The candidate is optional on the workstation running this contract suite.
    }
  }
  throw new Error('workstation has no distinct filesystem device for the cross-device test');
}

describe('Task 35 authority-first real acceptance contract', () => {
  it('uses held installation/config authorities and the exact selected full manifest', async () => {
    const fixture = await createFixture();
    const context = fixture.context;

    expect(Object.keys(context).sort()).toEqual([
      'branch',
      'job',
      'loadedConfig',
      'outputRootId',
      'pinnedSha',
      'selectedInstallation',
      'targetId',
    ]);
    expect(context.loadedConfig).toBe(fixture.loadedConfig);
    expect(context.loadedConfig.config.repository).toEqual({
      path: join(fixture.base, 'repository'),
      remote: 'origin',
    });
    expect(context.loadedConfig.config.approvedOutputRoots).toEqual([
      expect.objectContaining({ id: 'release', path: fixture.approvedRoot }),
    ]);
    expect(context.selectedInstallation).toMatchObject({
      versionRoot: fixture.versionRoot,
      lockPath: fixture.installedLockPath,
      lock: fixture.lock,
      manifestPath: fixture.installedManifestPath,
    });
    expect(context.selectedInstallation.lockBytes).toEqual(
      Buffer.from(canonicalJson(fixture.lock)),
    );
    expect(fixture.lock).toMatchObject({
      schemaVersion: 1,
      imageRepository: 'osi/firmware-builder',
      imageDigest: IMAGE_DIGEST,
      baseImage: `docker.io/library/debian@sha256:${'b'.repeat(64)}`,
      baseImageDigest: 'b'.repeat(64),
      packageSet: [
        'gcc-14',
        'nodejs',
        'npm',
        'openwrt-build-tools',
        'llvm-dev',
        'libzstd-dev',
        'libpolly-18-dev',
      ],
      rustConfig: {
        llvmConfig: '/usr/bin/llvm-config',
        channel: 'stable',
        version: '1.88.0',
        llvmMajor: 18,
      },
    });
    expect(validateBuilderLock(fixture.lock, PACKAGE_VERSION)).toMatchObject({ ok: true });
    expect(context.selectedInstallation.manifestBytes).toEqual(INSTALLED_MANIFEST_BYTES);
    expect(context.selectedInstallation.manifest.sha256).toBe(sha256(INSTALLED_MANIFEST_BYTES));
    expect(context.selectedInstallation.manifest.manifest).toEqual(LOADED_MANIFEST.manifest);
    expect(
      context.selectedInstallation.manifest.manifest.targets.find(({ id }) => id === context.targetId),
    ).toEqual(fixture.target);
    expect(Object.keys(fixture.target).sort()).toEqual([
      'artifactGlob',
      'configSymbols',
      'environment',
      'id',
      'label',
      'minimumArtifactBytes',
      'openwrtTarget',
      'operations',
      'profile',
      'rootfs',
      'rootfsPartSize',
    ]);
    expect(fixture.target.rootfs).toMatch(/^build_dir\//u);
    expect(fixture.target.minimumArtifactBytes).toBe(64 * 1024 * 1024);

    expect(fixture.worktree).toBe(
      join(context.loadedConfig.stateRoot, 'jobs', fixture.job.id, 'workspace', 'source'),
    );
    expect(fixture.jobEvidenceRoot).toBe(
      join(context.loadedConfig.stateRoot, 'jobs', fixture.job.id, 'evidence'),
    );
    expect(fixture.releaseDir).toBe(
      join(fixture.approvedRoot, 'main', SHA40, fixture.target.id),
    );
  });

  it('accepts installer-emitted builder lock bytes in insertion order', async () => {
    const fixture = await createFixture('rpi-5', { lockEncoding: 'installer' });
    const lockText = fixture.context.selectedInstallation.lockBytes.toString('utf8');

    expect(lockText).toBe(`${JSON.stringify(fixture.lock)}\n`);
    expect(lockText).not.toBe(canonicalJson(fixture.lock));
    await expect(verifyTarget(fixture)).resolves.toMatchObject({ ok: true });
  });

  it('accepts the real Node-RED helper topology and physical resolution prefixes', async () => {
    const fixture = await createFixture();
    const result = await verifyTarget(fixture);

    expect(result).toMatchObject({ ok: true });
    expect(fixture.expectedCommands.get('node-dependency-resolution')!.result.stdout).toContain(
      '"@chirpstack/chirpstack-api":"usr/share/node-red/node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js"',
    );
    expect(fixture.expectedCommands.get('node-dependency-resolution')!.result.stdout).toContain(
      '"osi-command-ledger":"usr/share/node-red/osi-command-ledger/index.js"',
    );
    expect(fixture.expectedCommands.get('node-dependency-resolution')!.request.argv.join(' ')).toContain('createRequire');
    expect(fixture.expectedCommands.get('node-dependency-resolution')!.request.argv.join(' ')).toContain(
      'loadSpecifier":"@chirpstack/chirpstack-api/api/application_grpc_pb',
    );
    expect(fixture.expectedCommands.get('node-dependency-resolution')!.request.argv.join(' ')).toContain(
      'const thirdPartyPackages =',
    );
  });

  it('executes the exact Node resolution command through the production held-directory adapter', async () => {
    const fixture = await createProductionRuntimeFixture();
    const rootfs = join(fixture.stateRoot, 'node-resolution-rootfs');
    const nodeRedRoot = join(rootfs, 'usr/share/node-red');
    const nodeModulesRoot = join(nodeRedRoot, 'node_modules');
    await Promise.all([
      mkdir(nodeModulesRoot, { recursive: true, mode: 0o755 }),
      ...[...RELATIVE_HELPERS, ...DIRECT_HELPERS].flatMap((name) => [
        ensureFile(join(nodeRedRoot, name, 'package.json'), canonicalJson({ name, version: '1.0.0' }), 0o644),
        ensureFile(join(nodeRedRoot, name, 'index.js'), 'module.exports = {};\n', 0o644),
      ]),
      ...THIRD_PARTY_PACKAGES.flatMap((name) => [
        ensureFile(join(nodeModulesRoot, name, 'package.json'), canonicalJson({ name, version: '1.0.0' }), 0o644),
        ensureFile(
          join(nodeModulesRoot, name, name === '@chirpstack/chirpstack-api' ? 'api/application_grpc_pb.js' : 'index.js'),
          'module.exports = {};\n',
          0o644,
        ),
      ]),
    ]);
    await Promise.all(RELATIVE_HELPERS.map((name) => symlink(`../${name}`, join(nodeModulesRoot, name))));

    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    const observed = await withRuntime({
      target: 'pi5',
      env: fixture.env,
      dependencies: fixture.dependencies,
    }, async (runtime) => {
      const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
      return dependencies.withHeldDirectory(rootfs, async (authority: { executionPath: string }) => {
        const command = await execFile('node', ['-e', NODE_RESOLUTION_SCRIPT, 'usr/share/node-red'], {
          cwd: authority.executionPath,
          env: FIXED_ENV,
          maxBuffer: 1024 * 1024,
        });
        return JSON.parse(command.stdout.trim()) as Record<string, string>;
      });
    });

    expect(observed).toEqual(Object.fromEntries([
      ...THIRD_PARTY_PACKAGES.map((name) => [
        name,
        join('usr/share/node-red/node_modules', name, name === '@chirpstack/chirpstack-api'
          ? 'api/application_grpc_pb.js'
          : 'index.js'),
      ]),
      ...RELATIVE_HELPERS.map((name) => [name, join('usr/share/node-red', name, 'index.js')]),
      ...DIRECT_HELPERS.map((name) => [name, join('usr/share/node-red', name, 'index.js')]),
    ]));
  });

  it.each([
    ['symlink', 'relative helper symlink target is invalid: osi-lib'],
    ['direct-helper', 'direct helper unexpectedly exists in node_modules'],
    ['package-root', 'held Node-RED entry changed: osi-lib'],
  ] as const)('runs descriptor-relative Node-RED inspection in a subprocess and rejects a %s swap', async (mode, expectedError) => {
    const fixture = await createFixture();
    const script = `
      import { join } from 'node:path';
      import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
      import { holdDirectoryAuthority } from ${JSON.stringify(HELD_AUTHORITY_MODULE_URL)};
      import { verifyHeldNodeRedPayload } from ${JSON.stringify(ACCEPTANCE_MODULE_URL)};
      const root = process.env.NODE_RED_ROOT;
      const mode = process.env.NODE_RED_RACE;
      const authority = await holdDirectoryAuthority(root, { finalAccess: 'read' });
      try {
        await verifyHeldNodeRedPayload(root, {
          ...authority,
          descriptorPath: authority.executionPath,
        }, {
          nodeRedPayloadHooks: {
            beforeHelperSymlinkRead: async ({ helper }) => {
              if (mode !== 'symlink' || helper !== 'osi-lib') return;
              const link = join(root, 'node_modules', helper);
              await rename(link, link + '.held');
              await symlink('../osi-health-helper', link);
            },
            beforeDirectHelperFinalCheck: async ({ helper }) => {
              if (mode !== 'direct-helper' || helper !== 'osi-command-ledger') return;
              await mkdir(join(root, 'node_modules', helper));
            },
            beforePackageManifest: async ({ packageName }) => {
              if (mode !== 'package-root' || packageName !== 'osi-lib') return;
              const packageRoot = join(root, packageName);
              await rename(packageRoot, packageRoot + '.held');
              await mkdir(packageRoot);
              await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }) + '\\n');
            },
          },
        });
        process.stdout.write('unexpected success\\n');
        process.exitCode = 2;
      } catch (error) {
        process.stderr.write(String(error?.message ?? error) + '\\n');
        process.exitCode = 1;
      } finally {
        await authority.close();
      }
    `;
    await expect(execFile(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        NODE_RED_ROOT: join(fixture.rootfs, 'usr/share/node-red'),
        NODE_RED_RACE: mode,
      },
      maxBuffer: 64 * 1024,
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(expectedError),
    });
  });

  it('rejects a relative helper with a wrong symlink target', async () => {
    const fixture = await createFixture();
    const linkPath = join(fixture.rootfs, 'usr/share/node-red/node_modules/osi-lib');
    await rm(linkPath);
    await symlink('../osi-health-helper', linkPath);

    await expect(verifyTarget(fixture)).resolves.toMatchObject({ ok: false });
  });

  it('rejects a direct helper unexpectedly present in node_modules', async () => {
    const fixture = await createFixture();
    await ensureFile(
      join(fixture.rootfs, 'usr/share/node-red/node_modules/osi-command-ledger/package.json'),
      canonicalJson({ name: 'osi-command-ledger', version: '1.0.0' }),
    );

    await expect(verifyTarget(fixture)).resolves.toMatchObject({ ok: false });
  });

  it('rejects an OSI helper package identity mismatch at its direct root', async () => {
    const fixture = await createFixture();
    const packagePath = join(fixture.rootfs, 'usr/share/node-red/osi-lib/package.json');
    await chmod(packagePath, 0o600);
    await writeFile(packagePath, canonicalJson({ name: 'not-osi-lib', version: '1.0.0' }));

    await expect(verifyTarget(fixture)).resolves.toMatchObject({ ok: false });
  });

  it('uses the actual selected-installation callback contract instead of caller manifest fields', async () => {
    const fixture = await createFixture();
    const selected = await createActualSelectedInstallation(fixture.base);
    const observed = await withSelectedInstallation(
      { installRoot: selected.installRoot },
      async (
        installation: Readonly<{
          versionRoot: string;
          lockPath: string;
          lockText: string;
          lock: Readonly<Record<string, unknown>>;
          manifestPath: string;
          manifestText: string;
          manifestBytes: Buffer;
          manifest: ReturnType<typeof loadManifest>;
          publisherPath: string;
          publisherSha256: string;
        }>,
        held: Readonly<{ publisherFile: unknown }>,
      ) => {
        expect(Object.keys(installation).sort()).toEqual([
          'dependencyEgressProxySha256',
          'lock',
          'lockPath',
          'lockText',
          'manifest',
          'manifestBytes',
          'manifestPath',
          'manifestText',
          'publisher',
          'publisherPath',
          'publisherSha256',
          'selection',
          'versionRoot',
        ]);
        expect(installation).toMatchObject({
          versionRoot: selected.versionRoot,
          lockPath: selected.lockPath,
          lockText: selected.lockText,
          lock: selected.lock,
          manifestPath: selected.manifestPath,
          manifestText: selected.manifestText,
          manifestBytes: INSTALLED_MANIFEST_BYTES,
          manifest: LOADED_MANIFEST,
          publisherPath: selected.publisherPath,
          publisherSha256: sha256(selected.publisherBytes),
          dependencyEgressProxySha256: selected.dependencyEgressProxySha256,
        });
        expect(held.publisherFile).toBeDefined();
        return {
          versionRoot: installation.versionRoot,
          lockText: installation.lockText,
          lock: installation.lock,
          manifestPath: installation.manifestPath,
          manifestText: installation.manifestText,
          manifestBytes: installation.manifestBytes,
          manifest: installation.manifest,
        };
      },
    );
    expect(observed.versionRoot).toBe(selected.versionRoot);
    expect(observed.lockText).toBe(selected.lockText);
    expect(observed.lock).toEqual(selected.lock);
    expect(observed.manifestPath).toBe(selected.manifestPath);
    expect(observed.manifestText).toBe(selected.manifestText);
    expect(observed.manifestBytes).toEqual(INSTALLED_MANIFEST_BYTES);
    expect(observed.manifest).toEqual(LOADED_MANIFEST);
  });

  it('rejects conflicting caller manifest path, bytes, and parsed object', async () => {
    const fixture = await createFixture();
    const decoyPath = join(fixture.base, 'caller-selected-targets.json');
    const decoyBytes = Buffer.concat([INSTALLED_MANIFEST_BYTES, Buffer.from('\n')]);
    await writeFile(decoyPath, decoyBytes);
    const conflictingContext: TrustedAcceptanceContext = {
      ...fixture.context,
      selectedInstallation: {
        ...fixture.context.selectedInstallation,
        manifestPath: decoyPath,
        manifestBytes: decoyBytes,
        manifest: loadManifest(decoyPath),
      },
    };
    const result = await verifyTarget(fixture, { context: conflictingContext });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a selected-installation manifest pathname swap during the callback', async () => {
    const fixture = await createFixture();
    const selected = await createActualSelectedInstallation(fixture.base);
    const decoyPath = join(fixture.base, 'selected-manifest-decoy.json');
    await writeFile(decoyPath, Buffer.from(selected.manifestText));
    await expect(withSelectedInstallation(
      { installRoot: selected.installRoot },
      async () => {
        await chmod(dirname(selected.manifestPath), 0o755);
        await rename(selected.manifestPath, `${selected.manifestPath}.held`);
        await rename(decoyPath, selected.manifestPath);
        await chmod(dirname(selected.manifestPath), 0o555);
      },
    )).rejects.toThrow(/changed|identity|revalidat|manifest/u);
  });

  it('models the exact pipeline build manifest and real source/publish observations', async () => {
    const fixture = await createFixture();
    expect(Object.keys(fixture.buildManifest).sort()).toEqual([
      ...BUILDER_LOCK_REQUIRED_KEYS,
      'artifactBasename',
      'artifactMtime',
      'artifactSha256',
      'artifactSize',
      'branch',
      'builderLockSha256',
      'canonicalImageRef',
      'config',
      'jobId',
      'pinnedSha',
      'rootId',
      'rootIdentity',
      'source',
      'targetId',
      'targetManifestSha256',
      'tool',
    ].sort());
    expect(fixture.buildManifest).not.toHaveProperty('installable');
    expect(fixture.buildManifest).not.toHaveProperty('publisherSha256');
    expect(fixture.buildManifest).not.toHaveProperty('imageId');
    expect(fixture.buildManifest.artifactMtime).toBe(ARTIFACT_MTIME);
    expect(fixture.buildManifest.targetManifestSha256).toBe(sha256(INSTALLED_MANIFEST_BYTES));
    expect(fixture.buildManifest).toMatchObject({
      source: {
        remote: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
        ref: 'refs/remotes/origin/main',
        branch: 'main',
        pinnedSha: SHA40,
      },
      rootIdentity: { device: expect.any(Number), inode: expect.any(Number) },
      config: {
        selectedTarget: fixture.target.openwrtTarget,
        profile: fixture.target.profile,
        rootfsPartSize: fixture.target.rootfsPartSize,
      },
      tool: {
        nodeVersion: fixture.lock.nodeVersion,
        preflight: {
          evidencePath: `jobs/${fixture.job.id}/evidence/00-preflight.json`,
          evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
        operations: expect.any(Array),
      },
    });

    const source = decodeStoredStageEvidence(JSON.parse(
      await readFile(join(fixture.jobEvidenceRoot, '01-source.json'), 'utf8'),
    ));
    expect(source.observations).toMatchObject({
      remoteUrl: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
      sourceRef: 'refs/remotes/origin/main',
      targetOutputAbsent: true,
      checkedTargetOutputPath: `openwrt/bin/targets/${fixture.target.openwrtTarget}/`,
    });
    expect(source.observations).not.toHaveProperty('sourceRemote');
    expect(source.observations).not.toHaveProperty('worktree');

    const publish = decodeStoredStageEvidence(JSON.parse(
      await readFile(join(fixture.jobEvidenceRoot, '09-publish.json'), 'utf8'),
    ));
    const releaseRelative = `main/${SHA40}/${fixture.target.id}`;
    expect(publish.observations).toMatchObject({
      final: {
        finalPath: `${releaseRelative}/${basename(fixture.releaseImage)}`,
        checksumPath: `${releaseRelative}/sha256sums`,
        manifestPath: `${releaseRelative}/build-manifest.json`,
        verificationPath: `${releaseRelative}/verification.json`,
      },
    });
    expect(JSON.stringify(publish.observations)).not.toContain(fixture.approvedRoot);
  });

  it('accepts the producer-format build manifest without weakening stage or report JSON strictness', async () => {
    const fixture = await createFixture('rpi-5', { buildManifestEncoding: 'producer' });
    const buildManifestBytes = await readFile(fixture.buildManifestPath);
    expect(buildManifestBytes.at(-1)).not.toBe(0x0a);
    expect(buildManifestBytes.toString('utf8')).toBe(canonicalJson(fixture.buildManifest, false));

    await expect(verifyTarget(fixture)).resolves.toMatchObject({ ok: true });

    const stagePath = join(fixture.jobEvidenceRoot, '08-verify.json');
    const stageBytes = await readFile(stagePath);
    await chmod(stagePath, 0o600);
    await writeFile(stagePath, stageBytes.subarray(0, -1));
    await expect(acceptance.validateStageEvidence({
      context: fixture.context,
      dependencies: fixture.dependencies,
    })).resolves.toMatchObject({ ok: false, code: 'STAGE_EVIDENCE_INVALID' });

    await writeFile(stagePath, stageBytes);
    const reportBytes = await readFile(fixture.reportPath);
    expect(reportBytes.at(-1)).toBe(0x0a);
    await chmod(fixture.reportPath, 0o600);
    await writeFile(fixture.reportPath, reportBytes.subarray(0, -1));
    await expect(acceptance.validateStageEvidence({
      context: fixture.context,
      dependencies: fixture.dependencies,
    })).resolves.toMatchObject({ ok: false, code: 'STAGE_EVIDENCE_INVALID' });
  });

  it('rejects producer-format build manifests with trailing whitespace', async () => {
    const fixture = await createFixture('rpi-5', { buildManifestEncoding: 'producer' });
    const buildManifestBytes = await readFile(fixture.buildManifestPath);
    await chmod(fixture.buildManifestPath, 0o600);
    await writeFile(fixture.buildManifestPath, Buffer.concat([buildManifestBytes, Buffer.from(' \t')]));

    const result = await verifyTarget(fixture);
    expect(result).toMatchObject({ ok: false, code: 'TARGET_ACCEPTANCE_FAILED' });
    expect(String(result.detail)).toContain('build manifest is not canonical JSON');
  });

  it('rejects producer-format build manifests with recursively noncanonical key order', async () => {
    const fixture = await createFixture('rpi-5', { buildManifestEncoding: 'producer' });
    const sortedManifest = sortFixtureJson(fixture.buildManifest) as Record<string, unknown>;
    const sortedRootIdentity = sortedManifest.rootIdentity as Record<string, unknown>;
    const noncanonicalBytes = Buffer.from(JSON.stringify({
      ...sortedManifest,
      rootIdentity: {
        inode: sortedRootIdentity.inode,
        device: sortedRootIdentity.device,
      },
    }));
    expect(noncanonicalBytes.toString('utf8')).not.toBe(canonicalJson(fixture.buildManifest, false));
    expect(noncanonicalBytes.at(-1)).not.toBe(0x0a);
    await chmod(fixture.buildManifestPath, 0o600);
    await writeFile(fixture.buildManifestPath, noncanonicalBytes);

    const result = await verifyTarget(fixture);
    expect(result).toMatchObject({ ok: false, code: 'TARGET_ACCEPTANCE_FAILED' });
    expect(String(result.detail)).toContain('build manifest is not canonical JSON');
  });

  it('models all ten decoded stage files and binds their real hashes into the API job DTO', async () => {
    const fixture = await createFixture();
    const fullActualAggregation = {
      ...fixture.aggregation,
      verification: fixture.fullVerification,
    };
    let terminal: ReturnType<typeof createTerminalVerification> | undefined;
    let terminalError: unknown;
    try {
      terminal = createTerminalVerification(
        fixture.job.id,
        fullActualAggregation as Parameters<typeof createTerminalVerification>[1],
      );
    } catch (error) {
      terminalError = error;
    }
    expect(terminalError).toBeUndefined();
    if (terminal !== undefined) expect(terminal.bytes).toBe(canonicalJson(terminal.manifest, false));
    const documents = await Promise.all(FIXED_EVIDENCE.map(async ({ stage, path }, index) => {
      const bytes = await readFile(join(fixture.jobEvidenceRoot, path));
      const decoded = decodeStoredStageEvidence(JSON.parse(bytes.toString('utf8')));
      expect(decoded).toMatchObject({
        jobId: fixture.job.id,
        stage,
        outcome: 'passed',
        inputs: {
          targetId: fixture.target.id,
          rootId: 'release',
          branch: 'main',
          pinnedSha: SHA40,
        },
      });
      expect((fixture.job.evidence as Array<Record<string, unknown>>)[index]).toEqual({
        stage,
        outcome: 'passed',
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        path: `evidence/${path}`,
        evidenceSha256: sha256(bytes),
        errorCode: null,
      });
      return decoded;
    }));
    expect(documents.map(({ operationId }) => operationId)).toEqual([
      null,
      null,
      'check-mqtt-topics',
      'mirror-gui',
      'activate-target',
      'install-feeds',
      'resolve-config',
      'build-image',
      'verify-image',
      null,
    ]);
    expect(documents.flatMap(({ commands }) => commands)).toHaveLength(20);
    expect(documents.every(({ observations }) => Object.keys(observations).length > 0)).toBe(true);
    expect(fixture.aggregation).toMatchObject({
      jobId: fixture.job.id,
      branch: 'main',
      pinnedSha: SHA40,
      targetId: fixture.target.id,
      rootId: 'release',
      rootIdentity: fixture.buildManifest.rootIdentity,
      observations: {
        stageEvidence: FIXED_EVIDENCE.map(({ stage, path }) => ({
          stage,
          path,
          outcome: 'passed',
        })),
        publishEvidence: {
          path: `jobs/${fixture.job.id}/evidence/09-publish.json`,
        },
      },
    });
  });

  it('requires the full real verify stage to use production canonical bytes once capacity is fixed', async () => {
    const fixture = await createFixture();
    let prepared: ReturnType<EvidenceWriter['prepare']> | undefined;
    let preparationError: unknown;
    try {
      prepared = productionEvidenceWriter.prepare(
        fixture.fullVerifyDocument as unknown as StageEvidenceInput,
      );
    } catch (error) {
      preparationError = error;
    }
    expect(preparationError).toBeUndefined();
    if (prepared !== undefined) expect(prepared.bytes).toBe(canonicalJson(fixture.fullVerifyDocument));
  });

  it('starts with exactly four writable release members and state-side report evidence', async () => {
    const fixture = await createFixture();
    expect((await readdir(fixture.releaseDir)).sort()).toEqual([
      basename(fixture.releaseImage),
      'build-manifest.json',
      'sha256sums',
      'verification.json',
    ].sort());
    expect(await releaseModes(fixture)).toEqual({
      [basename(fixture.releaseImage)]: 0o600,
      'build-manifest.json': 0o600,
      'verification.json': 0o600,
      sha256sums: 0o600,
      [basename(fixture.releaseDir)]: 0o700,
    });
    expect(dirname(fixture.reportPath)).toBe(fixture.jobEvidenceRoot);
    expect(dirname(fixture.dockerInspectionPath)).toBe(fixture.jobEvidenceRoot);
    expect((await readdir(fixture.releaseDir))).not.toContain(basename(fixture.reportPath));
    expect((await readdir(fixture.releaseDir))).not.toContain(basename(fixture.dockerInspectionPath));
  });

  it('requires the exact state report schema, relative identities, and digest-only observations', async () => {
    const fixture = await createFixture();
    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual([
      'branch',
      'generatedAt',
      'jobId',
      'observations',
      'pinnedSha',
      'rootId',
      'rootIdentity',
      'schemaVersion',
      'targetId',
    ].sort());
    expect(Object.keys(report.observations as Record<string, unknown>).sort()).toEqual(
      Object.keys(fixture.expectedObservations).sort(),
    );
    expect(report).not.toHaveProperty('installedLockPath');
    expect(JSON.stringify(report)).not.toContain(fixture.installedLockPath);
    expect(JSON.stringify(report)).not.toContain(fixture.approvedRoot);
    expect(JSON.stringify(report)).not.toContain(fixture.jobEvidenceRoot);
    expect(report.rootId).toBe('release');
    expect(report.rootIdentity).toEqual(fixture.buildManifest.rootIdentity);
    expect(report.pinnedSha).toBe(SHA40);
    for (const value of Object.values(report.observations as Record<string, unknown>)) {
      if (typeof value === 'string' && value.endsWith('Sha256')) {
        expect(value).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
  });

  it('validates ten fixed evidence files once through held readers and never hashes a returned pathname', async () => {
    const fixture = await createFixture();
    const result = await acceptance.validateStageEvidence({
      context: fixture.context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      observationsOnly: true,
      observations: {
        stageEvidenceSha256: fixture.expectedObservations.stageEvidenceSha256,
        sourceEvidenceSha256: fixture.expectedObservations.sourceEvidenceSha256,
        verifyEvidenceSha256: fixture.expectedObservations.verifyEvidenceSha256,
        targetOutputAbsent: true,
        freshnessStatus: 'fresh',
      },
    });
    for (const { path } of FIXED_EVIDENCE) {
      expect(fixture.heldReads.filter((value) => value === join(fixture.jobEvidenceRoot, path))).toHaveLength(1);
    }
    expect(fixture.heldReads.filter((value) => value === fixture.publishedVerificationPath)).toHaveLength(1);
    expect(fixture.heldReads.filter((value) => value === fixture.reportPath)).toHaveLength(1);
  });

  it('rejects exact terminal aggregation bytes with one appended newline', async () => {
    const fixture = await createFixture();
    const exactTerminalBytes = await readFile(fixture.publishedVerificationPath);
    expect(exactTerminalBytes.at(-1)).not.toBe(0x0a);
    await chmod(fixture.publishedVerificationPath, 0o600);
    await writeFile(
      fixture.publishedVerificationPath,
      Buffer.concat([exactTerminalBytes, Buffer.from('\n')]),
    );

    const result = await acceptance.validateStageEvidence({
      context: fixture.context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: false, code: 'STAGE_EVIDENCE_INVALID' });
  });

  const evidenceRejections = [
    ['absolute', (entries: Array<Record<string, unknown>>) => { entries[0]!.path = '/tmp/00-preflight.json'; }],
    ['empty', (entries: Array<Record<string, unknown>>) => { entries[0]!.path = ''; }],
    ['dot', (entries: Array<Record<string, unknown>>) => { entries[0]!.path = '.'; }],
    ['dot-dot', (entries: Array<Record<string, unknown>>) => { entries[0]!.path = '..'; }],
    ['backslash', (entries: Array<Record<string, unknown>>) => { entries[0]!.path = 'evidence\\00-preflight.json'; }],
    ['unexpected filename', (entries: Array<Record<string, unknown>>) => { entries[0]!.path = '00-source.json'; }],
    ['unexpected stage', (entries: Array<Record<string, unknown>>) => { entries[0]!.stage = 'source'; }],
    ['duplicate stage/path', (entries: Array<Record<string, unknown>>) => { entries[1] = structuredClone(entries[0]!); }],
    ['root escape', (entries: Array<Record<string, unknown>>) => { entries[0]!.path = '../outside.json'; }],
  ] as const;

  it.each(evidenceRejections)('rejects %s stage evidence before opening any attacker-selected file', async (_name, mutate) => {
    const fixture = await createFixture();
    const aggregation = structuredClone(fixture.aggregation);
    mutate(fixedStageEntries(aggregation));
    await rewriteReleaseJson(fixture.publishedVerificationPath, aggregation);

    const result = await acceptance.validateStageEvidence({
      context: fixture.context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;
    expect(fixture.heldReads).toContain(fixture.publishedVerificationPath);
    expect(fixture.heldReads.filter((path) => path.startsWith(`${fixture.jobEvidenceRoot}/`))).toHaveLength(0);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an actual symlink evidence component', async () => {
    const fixture = await createFixture();
    const moved = `${fixture.jobEvidenceRoot}.real`;
    const outside = join(fixture.base, 'outside-evidence');
    await rename(fixture.jobEvidenceRoot, moved);
    await mkdir(outside);
    for (const { path } of FIXED_EVIDENCE) {
      await writeFile(join(outside, path), await readFile(join(moved, path)));
    }
    await symlink(outside, fixture.jobEvidenceRoot);

    const result = await acceptance.validateStageEvidence({
      context: fixture.context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;
    expect(fixture.heldReads.some((path) => path.startsWith(`${fixture.jobEvidenceRoot}/`))).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it('keeps held bytes stable or rejects when a file and directory are swapped', async () => {
    const fixture = await createFixture();
    const relativePath = '08-verify.json';
    const original = await readFile(join(fixture.jobEvidenceRoot, relativePath));
    const movedRoot = join(fixture.base, 'moved-evidence');
    const outside = join(fixture.base, 'outside-evidence');
    await mkdir(outside);
    await writeFile(join(outside, relativePath), 'replacement\n');

    let swapped = false;
    try {
      const value = await withNoFollowFileUnderRoot(
        fixture.heldRegistry,
        'fixture',
        relative(fixture.base, join(fixture.jobEvidenceRoot, relativePath)),
        async (reader: ReadCapability) => {
          await rename(fixture.jobEvidenceRoot, movedRoot);
          await symlink(outside, fixture.jobEvidenceRoot);
          swapped = true;
          return reader.readFile();
        },
      );
      expect(value).toEqual(original);
    } catch {
      expect(swapped).toBe(true);
    }
  });

  it('collects facts, durably writes state-side evidence, reopens it, and reports committed mutation', async () => {
    const fixture = await createFixture('rpi-5', {
      seedReport: false,
      seedDockerInspection: false,
    });
    const before = await releaseSnapshot(fixture.releaseDir);
    await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(fixture.dockerInspectionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const events: string[] = [];
    const baseRunCommand = fixture.dependencies.runCommand as (
      request: CommandRequest,
    ) => Promise<CommandResult>;
    const baseHeldRead = fixture.dependencies.withNoFollowFile as <T>(
      path: string,
      callback: (reader: ReadCapability) => Promise<T>,
    ) => Promise<T>;
    const dependencies = {
      ...fixture.dependencies,
      runCommand: async (request: CommandRequest) => {
        if (events.length === 0) {
          await expect(lstat(fixture.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        events.push(`command:${request.id}`);
        return baseRunCommand(request);
      },
      withNoFollowFile: async <T>(
        path: string,
        callback: (reader: ReadCapability) => Promise<T>,
      ): Promise<T> => {
        if (path === fixture.reportPath) events.push('report:reopen');
        return baseHeldRead(path, callback);
      },
    };

    const result = await acceptance.buildAcceptanceReport({
      env: REAL_ENV,
      context: fixture.context,
      dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      targetId: fixture.target.id,
      mutation: 'committed',
      observations: fixture.expectedObservations,
    });
    expect(await releaseSnapshot(fixture.releaseDir)).toEqual(before);
    expect(JSON.parse(await readFile(fixture.dockerInspectionPath, 'utf8'))).toEqual({
      Id: `sha256:${String(fixture.lock.imageId)}`,
      RepoDigests: [fixture.buildManifest.canonicalImageRef],
    });
    expect(JSON.parse(await readFile(fixture.reportPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      targetId: fixture.target.id,
      jobId: fixture.job.id,
      observations: fixture.expectedObservations,
    });
    const storedReportBytes = await readFile(fixture.reportPath);
    const reportSnapshot = fixture.acceptancePublicationSnapshots['real-acceptance-report.json'];
    const dockerSnapshot = fixture.acceptancePublicationSnapshots['docker-inspection.json'];
    expect(reportSnapshot).toBeDefined();
    expect(dockerSnapshot).toBeDefined();
    expect(reportSnapshot.bytes).toEqual(storedReportBytes);
    expect(reportSnapshot.sha256).toBe(sha256(storedReportBytes));
    expect(dockerSnapshot.bytes).toEqual(await readFile(fixture.dockerInspectionPath));
    expect(result).toMatchObject({
      reportEvidence: {
        ...reportSnapshot,
      },
      dockerInspectionEvidence: {
        ...dockerSnapshot,
      },
    });
    expect(fixture.heldReads.filter((path) => path === fixture.reportPath)).toHaveLength(2);
    expect(fixture.heldReads.filter((path) => path === fixture.dockerInspectionPath)).toHaveLength(1);
    expect(fixture.acceptancePublicationCalls).toEqual([
      'docker-inspection.json',
      'real-acceptance-report.json',
    ]);
    expect(events.at(-1)).toBe('report:reopen');
    expect(events.findIndex((event) => event.startsWith('command:'))).toBeLessThan(
      events.indexOf('report:reopen'),
    );
  });

  it('issues every independent command with exact argv, cwd, env, timeout, output policy, and three MQTT paths', async () => {
    const fixture = await createFixture();
    const result = await verifyTarget(fixture);
    const [artifactPrefix, artifactSuffix] = fixture.target.artifactGlob.split('*');
    const matchesManifest = (name: string) => (
      name.startsWith(artifactPrefix!) && name.endsWith(artifactSuffix!)
    );

    expect(result).toMatchObject({
      ok: true,
      observations: {
        sqliteIntegrity: 'ok',
        chameleonCalibrationCount: 0,
      },
    });
    expect((await readdir(fixture.releaseDir)).filter(matchesManifest)).toEqual([
      basename(fixture.releaseImage),
    ]);
    expect((await readdir(fixture.targetOutput)).filter(matchesManifest)).toEqual([
      basename(fixture.targetImage),
    ]);
    expect(basename(fixture.targetImage)).toBe(basename(fixture.releaseImage));
    expect(fixture.commandRequests).toEqual(
      [...fixture.expectedCommands.values()].map(({ request }) => request),
    );
    expect(fixture.heldCwds).toEqual(expect.arrayContaining(
      [...new Set(fixture.commandRequests.map(({ cwd }) => cwd))],
    ));
    const expectedRevalidations = new Map<string, number>();
    for (const { cwd } of fixture.commandRequests) {
      expectedRevalidations.set(cwd, (expectedRevalidations.get(cwd) ?? 0) + 2);
    }
    for (const [cwd, minimum] of expectedRevalidations) {
      expect(fixture.heldCwdRevalidations.filter((value) => value === cwd).length).toBeGreaterThanOrEqual(minimum);
    }
    const rawAuthorityPaths = [
      fixture.worktree,
      fixture.rootfs,
      fixture.targetOutput,
      fixture.releaseDir,
    ];
    for (const request of fixture.commandRequests) {
      expect(request.cwd).toMatch(/^\/proc\/self\/fd\/\d+$/u);
      expect(rawAuthorityPaths).not.toContain(request.cwd);
      expect(request.argv.filter((argument) => /^[\\/]/u.test(argument))).toEqual([]);
    }
    expect(fixture.expectedCommands.get('repo-sync-flow')!.request).toMatchObject(
      COMMAND_POLICIES.releaseGate,
    );
    expect(fixture.expectedCommands.get('git-origin')!.request).toMatchObject(
      COMMAND_POLICIES.short,
    );
    expect(fixture.expectedCommands.get('sqlite-integrity')!.request).toMatchObject(
      COMMAND_POLICIES.medium,
    );
    expect(fixture.expectedCommands.get('repo-mqtt-topics')!.result.stdout).toContain(
      'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json',
    );
    const forbiddenTokens = ['dd', 'mkfs', 'mkfs.ext4', 'lsblk', '/dev/mmcblk0'];
    const commandSurface = fixture.commandRequests.flatMap(({ id, cwd, argv, env }) => [
      id,
      cwd,
      ...argv,
      ...Object.values(env),
    ]);
    for (const token of forbiddenTokens) {
      expect(commandSurface, `forbidden token ${token}`).not.toContain(token);
    }
  });

  it('rejects block-device tools by basename and absolute executable and forbids direct spawning', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../scripts/accept-real-target.mjs', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/promisify\(execFileCallback\)/u);
    expect(source).not.toMatch(/await execFile\(/u);
    const guard = (acceptance as Record<string, unknown>).assertSafeCommandArgv;
    expect(typeof guard).toBe('function');
    for (const argv of [
      ['dd', 'if=/dev/zero', 'of=/dev/mmcblk0'],
      ['/usr/bin/dd', 'if=/dev/zero', 'of=/dev/mmcblk0'],
      ['mkfs', '/dev/mmcblk0'],
      ['/usr/sbin/mkfs.ext4', '/dev/mmcblk0'],
    ]) {
      expect(() => (guard as (argv: readonly string[]) => void)(argv)).toThrow();
    }
    expect(() => (guard as (argv: readonly string[]) => void)(['node', '-e', 'process.exit(0)'])).not.toThrow();
  });

  it('routes every independent command through the injected command seam', async () => {
    const fixture = await createFixture();
    const base = fixture.dependencies.runCommand as (
      request: CommandRequest,
    ) => Promise<CommandResult>;
    const directSpawnSurface: CommandRequest[] = [];
    const dependencies = {
      ...fixture.dependencies,
      runCommand: async (request: CommandRequest): Promise<CommandResult> => {
        directSpawnSurface.push(request);
        return base(request);
      },
    };
    await expect(verifyTarget(fixture, { dependencies })).resolves.toMatchObject({ ok: true });
    expect(directSpawnSurface.map(({ id }) => id)).toEqual([...fixture.expectedCommands.keys()]);
  });

  it('accepts the complete OpenWrt target checksum report while requiring the factory image line', async () => {
    const fixture = await createFixture();
    const base = fixture.dependencies.runCommand as (
      request: CommandRequest,
    ) => Promise<CommandResult>;
    const dependencies = {
      ...fixture.dependencies,
      runCommand: async (request: CommandRequest): Promise<CommandResult> => {
        const value = await base(request);
        if (request.id !== 'target-sha256sum') return value;
        return {
          ...value,
          stdout: `${basename(fixture.targetImage)}: OK\nprofiles.json: OK\nversion.buildinfo: OK\n`,
        };
      },
    };

    await expect(verifyTarget(fixture, { dependencies })).resolves.toMatchObject({ ok: true });
  });

  it('revalidates every held command cwd and rejects a directory swap before execution', async () => {
    const fixture = await createFixture();
    const moved = `${fixture.worktree}.held`;
    let swapped = false;
    const dependencies = {
      ...fixture.dependencies,
      withHeldDirectory: async <T>(
        path: string,
        callback: (authority: Readonly<{ executionPath: string; revalidate: () => Promise<void> }>) => Promise<T>,
      ): Promise<T> => {
        if (!swapped && path === fixture.worktree) {
          await rename(path, moved);
          await mkdir(path);
          swapped = true;
        }
        return callback({
          executionPath: heldExecutionPath(path),
          revalidate: async () => {
            throw new Error('command cwd identity changed');
          },
        });
      },
    };
    const result = await verifyTarget(fixture, { dependencies });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false });
    expect(fixture.commandRequests).toEqual([]);
  });

  it('rejects a same-bytes artifact replacement between independent stat and hash', async () => {
    const fixture = await createFixture();
    const baseStat = fixture.dependencies.statArtifact as (
      path: string,
    ) => Promise<{ regular: boolean; symlink: boolean; size: number; mtimeMs: number }>;
    let swapped = false;
    const replacementPath = `${fixture.releaseImage}.original`;
    const dependencies = {
      ...fixture.dependencies,
      statArtifact: async (path: string) => {
        const observed = await baseStat(path);
        if (path === fixture.releaseImage && !swapped) {
          const original = await readFile(fixture.releaseImage);
          const before = await lstat(fixture.releaseImage);
          await rename(fixture.releaseImage, replacementPath);
          await writeFile(fixture.releaseImage, original, { mode: 0o600 });
          const after = await lstat(fixture.releaseImage);
          expect(after.ino).not.toBe(before.ino);
          swapped = true;
        }
        return observed;
      },
    };
    const result = await verifyTarget(fixture, { dependencies });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it('accepts a fractional-nanosecond artifact mtime at canonical API precision', async () => {
    const fixture = await createFixture();
    const fractionalMtime = '2026-07-29T10:05:00.123866699Z';
    const canonicalMtime = '2026-07-29T10:05:00.123Z';
    await execFile('/usr/bin/touch', [`--date=${fractionalMtime}`, fixture.releaseImage, fixture.targetImage]);

    const observed = await stat(fixture.releaseImage);
    expect(observed.mtimeMs).not.toBe(Date.parse(canonicalMtime));
    expect(observed.mtimeMs).toBeGreaterThan(Date.parse(canonicalMtime));

    const context = contextWithJob(fixture, (job) => {
      (job.artifact as Record<string, unknown>).mtime = canonicalMtime;
      (job.output as Record<string, unknown>).mtime = canonicalMtime;
    });
    const result = await acceptance.verifyTargetArtifact({
      env: REAL_ENV,
      context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, mtime: canonicalMtime });
  });

  const malformedCommandOutputs = [
    ['git-origin', 'https://github.com/Open-Smart-Irrigation/osi-os.git\n'],
    ['repo-profile-parity', 'finished without a pass sentinel\n'],
    ['repo-chameleon-calibration', 'verify-chameleon-calibration complete\n'],
    ['repo-db-schema', 'DB schema consistency verification complete\n'],
    ['repo-sync-flow', 'Sync flow verification complete\n'],
    ['repo-strega', 'OK Strega Gen1 smoke checks complete\n'],
    ['repo-communication', 'Communication contract verification complete\n'],
    ['repo-mqtt-topics', 'only two maintained profiles\n'],
    ['target-sha256sum', 'wrong.img.gz: OK\n'],
    ['published-sha256sum', 'wrong.img.gz: OK\n'],
    ['sqlite-integrity', '{"integrity":"ok","chameleonCalibrationCount":"0"}\n'],
    ['node-dependency-resolution', '{"protobufjs":"/tmp/protobufjs.js"}\n'],
    ['docker-image-inspect', '{"Id":"sha256:bad","RepoDigests":[]}\n'],
  ] as const;

  it.each(malformedCommandOutputs)('rejects ok:true with malformed parsed output from %s', async (id, stdout) => {
    const fixture = await createFixture();
    const base = fixture.dependencies.runCommand as (
      request: CommandRequest,
    ) => Promise<CommandResult>;
    const requests: CommandRequest[] = [];
    const dependencies = {
      ...fixture.dependencies,
      runCommand: async (request: CommandRequest): Promise<CommandResult> => {
        requests.push(request);
        const value = await base(request);
        return request.id === id ? { ...value, stdout } : value;
      },
    };
    const result = await verifyTarget(fixture, { dependencies });
    expect(requests.some((request) => request.id === id)).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a dependency-resolution success whose resolved path escapes the rootfs', async () => {
    const fixture = await createFixture();
    const base = fixture.dependencies.runCommand as (
      request: CommandRequest,
    ) => Promise<CommandResult>;
    const dependencies = {
      ...fixture.dependencies,
      runCommand: async (request: CommandRequest): Promise<CommandResult> => {
        const value = await base(request);
        if (request.id !== 'node-dependency-resolution') return value;
        const resolved = JSON.parse(value.stdout) as Record<string, unknown>;
        resolved['osi-lib'] = join(fixture.base, 'escaped-node-module.js');
        return { ...value, stdout: canonicalJson(resolved) };
      },
    };
    const result = await verifyTarget(fixture, { dependencies });
    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    'gzip-test',
    'git-origin',
    'repo-profile-parity',
    'repo-chameleon-calibration',
    'repo-db-schema',
    'repo-sync-flow',
    'repo-strega',
    'repo-communication',
    'repo-mqtt-topics',
    'target-sha256sum',
    'published-sha256sum',
    'sqlite-integrity',
    'node-dependency-resolution',
    'docker-image-inspect',
  ])('rejects a failed or missing mandatory %s command without false success', async (id) => {
    const fixture = await createFixture();
    const base = fixture.dependencies.runCommand as (
      request: CommandRequest,
    ) => Promise<CommandResult>;
    const requests: CommandRequest[] = [];
    const dependencies = {
      ...fixture.dependencies,
      runCommand: async (request: CommandRequest): Promise<CommandResult> => {
        requests.push(request);
        const value = await base(request);
        return request.id === id
          ? { ok: false, exitCode: 1, stdout: '', stderr: 'injected failure' }
          : value;
      },
    };
    const result = await verifyTarget(fixture, { dependencies });
    expect(requests.some((request) => request.id === id)).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it('allows integer zero Chameleon rows only after SQLite integrity and dependency parsing pass', async () => {
    const fixture = await createFixture();
    const result = await verifyTarget(fixture);
    expect(fixture.expectedCommands.get('sqlite-integrity')!.result.stdout).toBe(
      '{"integrity":"ok","chameleonCalibrationCount":0}\n',
    );
    expect(result).toMatchObject({
      ok: true,
      observations: {
        sqliteIntegrity: 'ok',
        chameleonCalibrationCount: 0,
      },
    });
  });

  it.each(['advanced', 'unknown'] as const)('accepts valid %s freshness through the committed acceptance path', async (status) => {
    const freshness = freshnessFixture(status);
    const freshnessError = freshness.status === 'unknown' ? freshness.error : undefined;
    const fixture = await createFixture('rpi-5', { freshness });
    const verify = JSON.parse(await readFile(join(fixture.jobEvidenceRoot, '08-verify.json'), 'utf8')) as Record<string, unknown>;
    const observations = verify.observations as Record<string, unknown>;

    expect(fixture.job.freshnessStatus).toBe(status);
    expect(fixture.job.newerSourceAvailable).toBe(freshness.newerSourceAvailable);
    expect(fixture.job.freshnessCheckedAt).toBe(freshness.checkedAt);
    expect(observations.freshnessStatus).toBe(status);
    expect(observations.observedSha).toBe(freshness.observedSha);
    expect(observations.newerSourceAvailable).toBe(freshness.newerSourceAvailable);
    expect(observations.freshnessError).toEqual(freshnessError ?? null);
    expect((fixture.job.errors as Record<string, unknown>).freshness).toEqual(
      freshness.status === 'unknown'
        ? { code: 'FRESHNESS_UNKNOWN', details: {} }
        : null,
    );

    const result = await acceptTarget(fixture);
    expect(result).toMatchObject({
      ok: true,
      targetId: 'rpi-5',
      mutation: 'committed',
    });
  });

  it('allows a later terminal freshness result to advance a timed-out verify snapshot only', async () => {
    const fixture = await createFixture('rpi-5', {
      freshness: {
        status: 'unknown',
        pinnedSha: SHA40,
        observedSha: null,
        newerSourceAvailable: false,
        checkedAt: null,
        error: {
          code: 'FRESHNESS_UNKNOWN',
          reason: 'timeout',
          details: { operation: 'requestPersistedFreshness', timeoutMs: 2_000 },
        },
      },
    });
    const laterCheckedAt = '2026-08-02T12:34:04.954Z';
    const terminalContext = contextWithJob(fixture, (job) => {
      job.freshnessStatus = 'fresh';
      job.freshnessCheckedAt = laterCheckedAt;
      job.newerSourceAvailable = false;
    });

    const result = await acceptance.validateStageEvidence({
      context: terminalContext,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      observations: {
        freshnessStatus: 'unknown',
        newerSourceAvailable: false,
      },
    });
    expect((result.observations as Record<string, unknown>).reportObservationValues).toMatchObject({
      freshnessStatus: 'unknown',
    });
  });

  it('accepts an authoritative terminal unknown result after an unresolved verify snapshot', async () => {
    const fixture = await createFixture('rpi-5', {
      freshness: {
        status: 'unknown',
        pinnedSha: SHA40,
        observedSha: null,
        newerSourceAvailable: false,
        checkedAt: null,
        error: {
          code: 'FRESHNESS_UNKNOWN',
          reason: 'socket-unavailable',
          details: { operation: 'requestPersistedFreshness' },
        },
      },
    });
    const terminalContext = contextWithJob(fixture, (job) => {
      job.freshnessStatus = 'unknown';
      job.freshnessCheckedAt = FINISHED_AT;
      job.newerSourceAvailable = false;
    });

    const result = await acceptance.validateStageEvidence({
      context: terminalContext,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      observations: {
        freshnessStatus: 'unknown',
        newerSourceAvailable: false,
      },
    });
  });

  it('accepts an advanced terminal result after an unresolved verify snapshot', async () => {
    const fixture = await createFixture('rpi-5', {
      freshness: {
        status: 'unknown',
        pinnedSha: SHA40,
        observedSha: null,
        newerSourceAvailable: false,
        checkedAt: null,
        error: {
          code: 'FRESHNESS_UNKNOWN',
          reason: 'timeout',
          details: { operation: 'requestPersistedFreshness', timeoutMs: 2_000 },
        },
      },
    });
    const terminalContext = contextWithJob(fixture, (job) => {
      job.freshnessStatus = 'advanced';
      job.freshnessCheckedAt = FINISHED_AT;
      job.newerSourceAvailable = true;
    });

    const result = await acceptance.validateStageEvidence({
      context: terminalContext,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      observations: {
        freshnessStatus: 'unknown',
        newerSourceAvailable: false,
      },
    });
  });

  it('rejects a noncanonical terminal freshness timestamp even when sealed evidence matches it', async () => {
    const fixture = await createFixture();
    const invalidTimestamp = '2026-08-02T12:34:04Z';
    const context = await contextWithVerifyObservation(
      fixture,
      (observations) => { observations.freshnessCheckedAt = invalidTimestamp; },
      (job) => { job.freshnessCheckedAt = invalidTimestamp; },
    );

    const result = await acceptance.validateStageEvidence({
      context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: false, code: 'STAGE_EVIDENCE_INVALID' });
  });

  it.each([
    ['inconsistent', true] as const,
    ['non-boolean', 'false'] as const,
  ])('rejects %s newerSourceAvailable even when terminal and sealed values match', async (_name, value) => {
    const fixture = await createFixture();
    const context = await contextWithVerifyObservation(
      fixture,
      (observations) => { observations.newerSourceAvailable = value; },
      (job) => { job.newerSourceAvailable = value; },
    );

    const result = await acceptance.validateStageEvidence({
      context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: false, code: 'STAGE_EVIDENCE_INVALID' });
  });

  it('does not advance persisted unknown freshness evidence with a non-null checkedAt', async () => {
    const fixture = await createFixture('rpi-5', { freshness: freshnessFixture('unknown') });
    const terminalContext = contextWithJob(fixture, (job) => {
      job.freshnessStatus = 'fresh';
      job.freshnessCheckedAt = '2026-08-02T12:34:04.954Z';
      job.newerSourceAvailable = false;
    });

    const result = await acceptance.validateStageEvidence({
      context: terminalContext,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: false, code: 'STAGE_EVIDENCE_INVALID' });
  });

  it.each([
    ['fresh', 'advanced'] as const,
    ['advanced', 'fresh'] as const,
  ])('requires exact terminal freshness equality for persisted %s verify evidence', async (verifyStatus, terminalStatus) => {
    const fixture = await createFixture('rpi-5', { freshness: freshnessFixture(verifyStatus) });
    const terminalContext = contextWithJob(fixture, (job) => {
      job.freshnessStatus = terminalStatus;
      job.freshnessCheckedAt = FINISHED_AT;
      job.newerSourceAvailable = terminalStatus === 'advanced';
    });

    const result = await acceptance.validateStageEvidence({
      context: terminalContext,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: false, code: 'STAGE_EVIDENCE_INVALID' });
  });

  it('uses a true recursive GUI content hash and catches a nested payload change', async () => {
    const fixture = await createFixture();
    const source = join(fixture.worktree, 'web/react-gui/build');
    const feed = join(
      fixture.worktree,
      'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui',
    );
    const rootfs = join(fixture.rootfs, 'usr/lib/node-red/gui');
    expect(await recursiveContentHash(source)).toBe(await recursiveContentHash(feed));
    expect(await recursiveContentHash(feed)).toBe(await recursiveContentHash(rootfs));
    expect(await verifyTarget(fixture)).toMatchObject({ ok: true });

    await writeFile(join(source, 'assets/nested/app.js'), 'console.log("changed");\n');
    expect(await verifyTarget(fixture)).toMatchObject({ ok: false });
  });

  it('rejects all independent file, identity, freshness, and report failure vectors', async () => {
    const control = await createFixture();
    expect(await verifyTarget(control)).toMatchObject({ ok: true });

    const vectors: readonly [
      string,
      (fixture: Fixture) => Promise<Readonly<{
        context?: TrustedAcceptanceContext;
        dependencies?: Record<string, unknown>;
      }> | void>,
    ][] = [
      ['missing artifact', async (fixture) => { await rm(fixture.releaseImage); }],
      ['duplicate artifact', async (fixture) => {
        await ensureFile(join(fixture.releaseDir, fixture.target.artifactGlob.replace('*', 'duplicate')), 'firmware-image', 0o600);
      }],
      ['target/release basename mismatch', async (fixture) => {
        await rename(fixture.targetImage, join(fixture.targetOutput, fixture.target.artifactGlob.replace('*', 'different')));
      }],
      ['mtime not after build start', async (fixture) => ({
        dependencies: {
          ...fixture.dependencies,
          statArtifact: async () => ({
            regular: true,
            symlink: false,
            size: fixture.target.minimumArtifactBytes,
            mtimeMs: BUILD_START_EPOCH * 1000,
          }),
        },
      })],
      ['artifact below 64 MiB', async (fixture) => ({
        dependencies: {
          ...fixture.dependencies,
          statArtifact: async () => ({
            regular: true,
            symlink: false,
            size: fixture.target.minimumArtifactBytes - 1,
            mtimeMs: Date.parse(ARTIFACT_MTIME),
          }),
        },
      })],
      ['bad published checksum', async (fixture) => {
        await writeFile(fixture.publishedChecksumsPath, `${'0'.repeat(64)}  ${basename(fixture.releaseImage)}\n`);
      }],
      ['missing published checksum', async (fixture) => { await rm(fixture.publishedChecksumsPath); }],
      ['missing published verification', async (fixture) => { await rm(fixture.publishedVerificationPath); }],
      ['wrong target config', async (fixture) => {
        await writeFile(join(fixture.worktree, 'conf', fixture.target.environment, '.config'), 'CONFIG_TARGET_PROFILE="wrong"\n');
      }],
      ['wrong active target link', async (fixture) => {
        await rm(join(fixture.worktree, 'openwrt/.config'));
        await symlink('../conf/wrong/.config', join(fixture.worktree, 'openwrt/.config'));
      }],
      ['missing required rootfs file', async (fixture) => {
        await rm(join(fixture.rootfs, 'usr/share/flows.json'));
      }],
      ['missing nginx route', async (fixture) => {
        await writeFile(join(fixture.rootfs, 'etc/nginx/conf.d/node-red.locations'), 'location /gui/ {}\n');
      }],
      ['GUI title mismatch', async (fixture) => {
        await writeFile(join(fixture.rootfs, 'usr/lib/node-red/gui/index.html'), '<title>Wrong</title>\n');
      }],
      ['GUI recursive tree mismatch', async (fixture) => {
        await writeFile(join(fixture.rootfs, 'usr/lib/node-red/gui/assets/nested/app.js'), 'different\n');
      }],
      ['flow hash mismatch', async (fixture) => {
        await writeFile(join(fixture.rootfs, 'usr/share/flows.json'), 'different\n');
      }],
      ['database hash mismatch', async (fixture) => {
        await writeFile(join(fixture.rootfs, 'usr/share/db/farming.db'), 'different\n');
      }],
      ['build manifest hash mismatch', async (fixture) => {
        const manifest = structuredClone(fixture.buildManifest);
        manifest.artifactSha256 = '9'.repeat(64);
        await writeFile(fixture.buildManifestPath, canonicalJson(manifest));
      }],
      ['changed unselected installed target', async (fixture) => {
        const manifest = JSON.parse(await readFile(fixture.installedManifestPath, 'utf8'));
        const other = manifest.targets.find(({ id }: { id: string }) => id !== fixture.target.id);
        other.label = `${other.label} changed`;
        await writeFile(fixture.installedManifestPath, canonicalJson(manifest));
      }],
      ['missing source output-absence observation', async (fixture) => {
        const sourcePath = join(fixture.jobEvidenceRoot, '01-source.json');
        const source = JSON.parse(await readFile(sourcePath, 'utf8'));
        delete source.observations.targetOutputAbsent;
        await chmod(sourcePath, 0o600);
        await writeFile(sourcePath, canonicalJson(source));
      }],
      ['invalid freshness observation', async (fixture) => {
        const verifyPath = join(fixture.jobEvidenceRoot, '08-verify.json');
        const verify = JSON.parse(await readFile(verifyPath, 'utf8'));
        verify.observations.freshnessStatus = 'stale';
        await chmod(verifyPath, 0o600);
        await writeFile(verifyPath, canonicalJson(verify));
      }],
      ['missing stage evidence SHA in job DTO', async (fixture) => ({
        context: contextWithJob(fixture, (job) => {
          (job.evidence as Array<Record<string, unknown>>)[4]!.evidenceSha256 = null;
        }),
      })],
      ['report digest omission', async (fixture) => {
        const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'));
        delete report.observations.rootfsGuiTreeSha256;
        await chmod(fixture.reportPath, 0o600);
        await writeFile(fixture.reportPath, canonicalJson(report));
      }],
    ];

    for (const [name, mutate] of vectors) {
      const fixture = await createFixture();
      const options = await mutate(fixture) ?? {};
      const result = await verifyTarget(fixture, options);
      expect(result, name).toMatchObject({ ok: false });
    }
  });

  it.each(['1', 0, 1.5])('rejects generated lock schemaVersion %j from held installation bytes', async (schemaVersion) => {
    const fixture = await createFixture();
    const lock = productionLock(schemaVersion);
    const bytes = Buffer.from(canonicalJson(lock));
    await writeFile(fixture.installedLockPath, bytes);
    const context: TrustedAcceptanceContext = {
      ...fixture.context,
      selectedInstallation: {
        ...fixture.context.selectedInstallation,
        lockBytes: bytes,
        lock,
      },
    };
    const result = await verifyTarget(fixture, { context });
    expect(result).toMatchObject({ ok: false });
  });

  it('runs the exact local API sequence and seals only after terminal verification succeeds', async () => {
    const fixture = await createFixture('rpi-5', {
      seedReport: false,
      seedDockerInspection: false,
    });
    const chmodCalls: Array<{ kind: string; relativeName: string; mode: number }> = [];
    const dependencies = {
      ...fixture.dependencies,
      chmodDescriptor: async (request: {
        handle: { chmod: (mode: number) => Promise<void> };
        kind: 'file' | 'directory';
        relativeName: string;
        mode: number;
      }) => {
        if (chmodCalls.length === 0) {
          expect(fixture.commandRequests).toEqual(
            [...fixture.expectedCommands.values()].map(({ request: expected }) => expected),
          );
          await expect(lstat(fixture.reportPath)).resolves.toBeDefined();
          await expect(lstat(fixture.dockerInspectionPath)).resolves.toBeDefined();
        }
        expect(request.relativeName).not.toMatch(/[\\/]/u);
        chmodCalls.push({
          kind: request.kind,
          relativeName: request.relativeName,
          mode: request.mode,
        });
        await request.handle.chmod(request.mode);
      },
    };

    const result = await acceptTarget(fixture, { dependencies });

    expect(fixture.httpRequests).toEqual(expectedApiRequests(fixture));
    expect(result).toMatchObject({
      ok: true,
      targetId: 'rpi-5',
      mutation: 'committed',
    });
    const fileSeals = chmodCalls.filter(({ kind }) => kind === 'file');
    const directorySealIndex = chmodCalls.findIndex(({ kind }) => kind === 'directory');
    expect(fileSeals).toHaveLength(4);
    expect(fileSeals.map(({ relativeName }) => relativeName).sort()).toEqual([
      basename(fixture.releaseImage),
      'build-manifest.json',
      'sha256sums',
      'verification.json',
    ].sort());
    expect(fileSeals.every(({ mode }) => mode === 0o444)).toBe(true);
    expect(fixture.reopenedDescriptors).toEqual(expect.arrayContaining([
      basename(fixture.releaseImage),
      'build-manifest.json',
      'verification.json',
      'sha256sums',
      basename(fixture.releaseDir),
    ]));
    expect(fixture.reopenedDescriptorSnapshots).toHaveLength(5);
    expect(directorySealIndex).toBe(4);
    expect(chmodCalls[directorySealIndex]).toEqual({
      kind: 'directory',
      relativeName: basename(fixture.releaseDir),
      mode: 0o555,
    });
    expect(await releaseModes(fixture)).toEqual({
      [basename(fixture.releaseImage)]: 0o444,
      'build-manifest.json': 0o444,
      'verification.json': 0o444,
      sha256sums: 0o444,
      [basename(fixture.releaseDir)]: 0o555,
    });
    const releaseDirectoryMetadata = await lstat(fixture.releaseDir);
    const expectedReleaseHashes: Record<string, string> = {
      [basename(fixture.releaseImage)]: IMAGE_SHA256,
      'build-manifest.json': sha256(await readFile(fixture.buildManifestPath)),
      'verification.json': sha256(await readFile(fixture.publishedVerificationPath)),
      sha256sums: sha256(await readFile(fixture.publishedChecksumsPath)),
    };
    for (const [member, expectedHash] of Object.entries(expectedReleaseHashes)) {
      const metadata = await lstat(join(fixture.releaseDir, member));
      const snapshot = fixture.reopenedDescriptorSnapshots.find(({ relativeName }) => relativeName === member);
      expect(snapshot).toBeDefined();
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.nlink).toBe(1);
      expect(metadata.dev).toBe(releaseDirectoryMetadata.dev);
      expect(metadata.mode & 0o777).toBe(0o444);
      expect(sha256(await readFile(join(fixture.releaseDir, member)))).toBe(expectedHash);
      expect(snapshot).toMatchObject({
        kind: 'file',
        regular: true,
        singleLink: true,
        device: releaseDirectoryMetadata.dev,
        mode: 0o444,
        size: metadata.size,
        sha256: expectedHash,
      });
    }
    const directorySnapshot = fixture.reopenedDescriptorSnapshots.find(
      ({ relativeName }) => relativeName === basename(fixture.releaseDir),
    );
    expect(directorySnapshot).toMatchObject({
      kind: 'directory',
      regular: false,
      singleLink: true,
      device: releaseDirectoryMetadata.dev,
      mode: 0o555,
      size: releaseDirectoryMetadata.size,
    });
    expect(releaseDirectoryMetadata.nlink).toBeGreaterThanOrEqual(1);
    expect(releaseDirectoryMetadata.mode & 0o777).toBe(0o555);
    expect((await readdir(fixture.releaseDir)).sort()).toEqual([
      basename(fixture.releaseImage),
      'build-manifest.json',
      'sha256sums',
      'verification.json',
    ].sort());
    expect(await lstat(fixture.reportPath)).toMatchObject({ mode: expect.any(Number) });
    expect(await lstat(fixture.dockerInspectionPath)).toMatchObject({ mode: expect.any(Number) });
    expect(fixture.hashedFiles.filter((path) => path === fixture.releaseImage).length).toBeGreaterThanOrEqual(1);
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)('rejects terminal API state %s after exact polling', async (state) => {
    const fixture = await createFixture();
    const failed = structuredClone(fixture.job) as JobDto;
    failed.state = state;
    failed.currentStage = state === 'failed' ? 'build' : 'verify';
    failed.stage = failed.currentStage;
    failed.error = {
      code: state === 'failed' ? 'BUILD_FAILED' : state === 'cancelled' ? 'CANCELLED' : 'RUNNER_DISAPPEARED',
      details: { stage: failed.currentStage },
      at: FINISHED_AT,
    };
    const dependencies = dependencyHttp(fixture, (request, response) => (
      request.method === 'GET' ? { status: 200, body: failed } : response
    ));
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests).toEqual(expectedApiRequests(fixture));
    expect(result).toMatchObject({ ok: false });
  });

  const wrongJobVectors = [
    ['job ID', (job: JobDto) => { job.id = 'job-other'; }],
    ['target', (job: JobDto) => { job.targetId = 'rpi-2'; }],
    ['root', (job: JobDto) => { job.outputRootId = 'other'; }],
    ['branch', (job: JobDto) => { job.branch = 'design-sync/agrolink'; }],
    ['pinned SHA', (job: JobDto) => { job.pinnedSha = '9'.repeat(40); }],
    ['artifact directory', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).directory = `main/${SHA40}/rpi-2`;
    }],
    ['absolute artifact path', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).path = '/tmp/image.img.gz';
    }],
    ['empty artifact path', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).path = '';
    }],
    ['dot artifact path', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).path = '.';
    }],
    ['dot-dot artifact path', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).path = '..';
    }],
    ['backslash artifact path', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).path = 'main\\image.img.gz';
    }],
    ['escaping artifact path', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).path = '../outside.img.gz';
    }],
    ['unexpected artifact filename', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).path = `main/${SHA40}/rpi-5/wrong.img.gz`;
    }],
    ['evidence SHA', (job: JobDto) => {
      (job.evidence as Array<Record<string, unknown>>)[9]!.evidenceSha256 = '9'.repeat(64);
    }],
    ['reordered evidence', (job: JobDto) => {
      (job.evidence as Array<Record<string, unknown>>).reverse();
    }],
    ['duplicate evidence', (job: JobDto) => {
      const entries = job.evidence as Array<Record<string, unknown>>;
      entries[1] = structuredClone(entries[0]!);
    }],
    ['missing evidence', (job: JobDto) => {
      (job.evidence as Array<Record<string, unknown>>).splice(4, 1);
    }],
    ['wrong evidence path', (job: JobDto) => {
      (job.evidence as Array<Record<string, unknown>>)[0]!.path = 'evidence/99-nope.json';
    }],
    ['wrong evidence stage', (job: JobDto) => {
      (job.evidence as Array<Record<string, unknown>>)[0]!.stage = 'source';
    }],
    ['wrong evidence outcome', (job: JobDto) => {
      (job.evidence as Array<Record<string, unknown>>)[0]!.outcome = 'failed';
    }],
    ['artifact root', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).rootId = 'other';
    }],
    ['artifact SHA', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).sha256 = '9'.repeat(64);
    }],
    ['artifact size', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).size = 64 * 1024 * 1024 + 1;
    }],
    ['artifact mtime', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).mtime = '2026-07-29T10:06:00.000Z';
    }],
    ['artifact publish state', (job: JobDto) => {
      (job.artifact as Record<string, unknown>).publishState = 'staging';
    }],
    ['artifact/output disagreement', (job: JobDto) => {
      (job.output as Record<string, unknown>).path = `main/${SHA40}/rpi-5/other.img.gz`;
    }],
  ] as const;

  it.each(wrongJobVectors)('rejects succeeded API DTO with wrong %s identity', async (_name, mutate) => {
    const fixture = await createFixture();
    const job = structuredClone(fixture.job) as JobDto;
    mutate(job);
    const dependencies = dependencyHttp(fixture, (request, response) => (
      request.method === 'GET' ? { status: 200, body: job } : response
    ));
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests).toEqual(expectedApiRequests(fixture));
    expect(result).toMatchObject({ ok: false });
  });

  it('requires refreshed main.sha to equal the pinned SHA before preflight', async () => {
    const fixture = await createFixture();
    const dependencies = dependencyHttp(fixture, (request, response) => {
      if (request.path !== '/api/branches/refresh') return response;
      const body = structuredClone(response.body) as Record<string, unknown>;
      (body.branches as Array<Record<string, unknown>>)[0]!.sha = '9'.repeat(40);
      return { ...response, body };
    });
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests).toEqual([
      expectedApiRequest('POST', '/api/branches/refresh', {}),
    ]);
    expect(result).toMatchObject({ ok: false });
  });

  it('requires the exact exported 18-item preflight check DTO before enqueue', async () => {
    const fixture = await createFixture();
    expect(exactPreflightChecks().map(({ id }) => id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    const dependencies = dependencyHttp(fixture, (request, response) => {
      if (request.path !== '/api/preflight') return response;
      const body = structuredClone(response.body) as Record<string, unknown>;
      body.checks = exactPreflightChecks().slice(0, 2);
      return { ...response, body };
    });
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests).toEqual([
      expectedApiRequest('POST', '/api/branches/refresh', {}),
      expectedApiRequest('POST', '/api/preflight', selection(fixture)),
    ]);
    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    ['/api/branches/refresh', { fetchedAt: STARTED_AT, branches: 'not-an-array' }],
    ['/api/preflight', { preflightId: 7 }],
    ['/api/jobs', { job: { id: '../bad', state: 'queued' } }],
    ['/api/jobs/job-rpi-5', { id: 'job-rpi-5', state: 'succeeded' }],
  ] as const)('rejects malformed local API response from %s', async (path, malformed) => {
    const fixture = await createFixture();
    const dependencies = dependencyHttp(fixture, (request, response) => (
      request.path === path ? { status: response.status, body: malformed } : response
    ));
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests.some((request) => request.path === path)).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    ['/api/branches/refresh', 500],
    ['/api/preflight', 409],
    ['/api/jobs', 503],
    ['/api/jobs/job-rpi-5', 404],
  ] as const)('rejects non-success HTTP status %s from %s', async (path, status) => {
    const fixture = await createFixture();
    const dependencies = dependencyHttp(fixture, (request, response) => (
      request.path === path ? { status, body: response.body } : response
    ));
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests.some((request) => request.path === path)).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a local API transport error without treating the request as a successful build', async () => {
    const fixture = await createFixture();
    const requests: HttpRequest[] = [];
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        http: {
          request: async (request: HttpRequest): Promise<HttpResponse> => {
            requests.push(structuredClone(request));
            throw new Error('loopback transport disconnected');
          },
        },
      },
    });
    expect(requests[0]).toEqual(expectedApiRequest('POST', '/api/branches/refresh', {}));
    expect(result).toMatchObject({ ok: false });
  });

  it('uses the explicit Node HTTP transport instead of fetch for long loopback requests', async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe('POST');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"available":true}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe('string');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ambient fetch must not be used'); };
    try {
      const response = await acceptance.defaultApiRequest({
        method: 'POST',
        baseUrl: `http://127.0.0.1:${(address as { port: number }).port}`,
        path: '/slow-admission',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          origin: API_BASE_URL,
        },
        timeoutMs: ENQUEUE_REQUEST_TIMEOUT_MS,
        body: { accepted: true },
        signal: new AbortController().signal,
      });
      expect(response).toEqual({
        status: 200,
        body: Buffer.from('{"available":true}'),
      });
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it('rejects an already-aborted request before opening a socket', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    let requests = 0;
    const server = createServer(() => { requests += 1; });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    try {
      await expect(acceptance.defaultApiRequest({
        method: 'GET',
        baseUrl: `http://127.0.0.1:${address.port}`,
        path: '/already-aborted',
        headers: { accept: 'application/json' },
        timeoutMs: API_REQUEST_TIMEOUT_MS,
        signal: controller.signal,
      })).rejects.toThrow(/abort/u);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects a request when its AbortSignal fires while the socket is open', async () => {
    const controller = new AbortController();
    let connected: (() => void) | undefined;
    const server = createServer(() => {
      connected?.();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    try {
      const request = acceptance.defaultApiRequest({
        method: 'GET',
        baseUrl: `http://127.0.0.1:${address.port}`,
        path: '/mid-request-abort',
        headers: { accept: 'application/json' },
        timeoutMs: API_REQUEST_TIMEOUT_MS,
        signal: controller.signal,
      });
      await new Promise<void>((resolve) => {
        connected = resolve;
      });
      controller.abort(new Error('caller cancelled'));
      await expect(request).rejects.toThrow(/abort/u);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    ['non-loopback hostname', 'http://localhost:43120', '/request'],
    ['non-loopback address', 'http://127.0.0.2:43120', '/request'],
    ['ambiguous base URL', 'http://127.0.0.1:43120/', '/request'],
    ['ambiguous path', 'http://127.0.0.1:43120', 'request'],
  ] as const)('rejects %s before opening a socket', async (_label, baseUrl, path) => {
    await expect(acceptance.defaultApiRequest({
      method: 'GET',
      baseUrl,
      path,
      headers: { accept: 'application/json' },
      timeoutMs: API_REQUEST_TIMEOUT_MS,
      signal: new AbortController().signal,
    })).rejects.toThrow(/URL/u);
  });

  it('rejects a declared response larger than the body limit', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(16 * 1024 * 1024 + 1),
      });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    try {
      await expect(acceptance.defaultApiRequest({
        method: 'GET',
        baseUrl: `http://127.0.0.1:${address.port}`,
        path: '/declared-too-large',
        headers: { accept: 'application/json' },
        timeoutMs: API_REQUEST_TIMEOUT_MS,
        signal: new AbortController().signal,
      })).rejects.toThrow(/size limit/u);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects a streamed response once it exceeds the body limit', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(Buffer.alloc(16 * 1024 * 1024));
      response.end(Buffer.from('x'));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    try {
      await expect(acceptance.defaultApiRequest({
        method: 'GET',
        baseUrl: `http://127.0.0.1:${address.port}`,
        path: '/streamed-too-large',
        headers: { accept: 'application/json' },
        timeoutMs: API_REQUEST_TIMEOUT_MS,
        signal: new AbortController().signal,
      })).rejects.toThrow(/size limit/u);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects a response that closes before its end event', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '64',
      });
      response.flushHeaders();
      response.write('{"available":');
      setTimeout(() => response.socket?.destroy(), 10);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    try {
      const outcome = await Promise.race([
        acceptance.defaultApiRequest({
          method: 'GET',
          baseUrl: `http://127.0.0.1:${address.port}`,
          path: '/premature-close',
          headers: { accept: 'application/json' },
          timeoutMs: API_REQUEST_TIMEOUT_MS,
          signal: new AbortController().signal,
        }).then(() => 'resolved', (error: unknown) => error),
        new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('test timeout')), 500)),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).not.toBe('test timeout');
      expect((outcome as Error).message).toMatch(/closed before end/u);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('settles once and removes listeners when response end and error race', async () => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      destroy: () => undefined,
    });
    const outbound = Object.assign(new EventEmitter(), {
      end: () => {
        queueMicrotask(() => {
          response.emit('data', Buffer.from('{"available":true}'));
          response.emit('end');
          response.emit('error', new Error('late response error'));
          response.emit('close');
          outbound.emit('close');
        });
      },
      destroy: () => undefined,
    });
    const result = await acceptance.defaultApiRequest({
      method: 'GET',
      baseUrl: 'http://127.0.0.1:43120',
      path: '/late-race',
      headers: { accept: 'application/json' },
      timeoutMs: API_REQUEST_TIMEOUT_MS,
      signal: new AbortController().signal,
    }, {
      request: (_url: URL, _options: Record<string, unknown>, callback: (value: typeof response) => void) => {
        queueMicrotask(() => callback(response));
        return outbound;
      },
    });
    expect(result).toEqual({ status: 200, body: Buffer.from('{"available":true}') });
    expect(response.listenerCount('error')).toBe(0);
    expect(outbound.listenerCount('error')).toBe(0);
  });

  it('rejects invalid JSON response bytes from the local API', async () => {
    const fixture = await createFixture();
    const dependencies = dependencyHttp(fixture, (request, response) => (
      request.path === '/api/branches/refresh'
        ? { status: 200, body: Buffer.from('{ invalid json bytes') }
        : response
    ));
    const result = await acceptTarget(fixture, { dependencies });
    expect(result).toMatchObject({ ok: false });
  });

  it('bounds a hung local API request and never accepts after the request deadline', async () => {
    const fixture = await createFixture();
    const requests: HttpRequest[] = [];
    let requestSignal: AbortSignal | undefined;
    const dependencies = {
      ...fixture.dependencies,
      http: {
        request: async (request: HttpRequest): Promise<HttpResponse> => {
          requests.push(structuredClone(request));
          requestSignal = request.signal;
          return new Promise<HttpResponse>(() => undefined);
        },
      },
    };
    const result = await Promise.race([
      acceptTarget(fixture, { dependencies }),
      new Promise<Record<string, unknown>>((resolve) => {
        setTimeout(() => resolve({ timedOutTest: true }), API_REQUEST_TIMEOUT_MS + 250);
      }),
    ]);
    expect(requests[0]).toEqual(expectedApiRequest('POST', '/api/branches/refresh', {}));
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty('timedOutTest');
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
  }, API_REQUEST_TIMEOUT_MS + 2_000);

  it('provides the request deadline AbortSignal to the injected loopback transport', async () => {
    const fixture = await createFixture();
    const base = fixture.dependencies.http as {
      request: (request: HttpRequest) => Promise<HttpResponse>;
    };
    const signals: AbortSignal[] = [];
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        http: {
          request: async (request: HttpRequest) => {
            expect(request.signal).toBeInstanceOf(AbortSignal);
            signals.push(request.signal!);
            return base.request(request);
          },
        },
      },
    });
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(result).toMatchObject({ ok: true, mutation: 'committed' });
  });

  it('rejects a request response that arrives after its fixed logical deadline', async () => {
    const fixture = await createFixture();
    const base = fixture.dependencies.http as {
      request: (request: HttpRequest) => Promise<HttpResponse>;
    };
    let now = 0;
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        clock: { now: () => now },
        http: {
          request: async (request: HttpRequest) => {
            const response = await base.request(request);
            now = API_REQUEST_TIMEOUT_MS + 1;
            return response;
          },
        },
      },
    });
    expect(fixture.httpRequests).toEqual([
      expectedApiRequest('POST', '/api/branches/refresh', {}),
    ]);
    expect(result).toMatchObject({ ok: false, mutation: 'none' });
  });

  it('reports an enqueue response past its extended deadline as an unknown mutation and never polls', async () => {
    const fixture = await createFixture();
    const base = fixture.dependencies.http as {
      request: (request: HttpRequest) => Promise<HttpResponse>;
    };
    let now = 0;
    let enqueueSignal: AbortSignal | undefined;
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        clock: { now: () => now },
        http: {
          request: async (request: HttpRequest) => {
            const response = await base.request(request);
            if (request.method !== 'POST' || request.path !== '/api/jobs') return response;
            enqueueSignal = request.signal;
            now = ENQUEUE_REQUEST_TIMEOUT_MS + 1;
            return response;
          },
        },
      },
    });
    expect(fixture.httpRequests).toEqual([
      expectedApiRequest('POST', '/api/branches/refresh', {}),
      expectedApiRequest('POST', '/api/preflight', selection(fixture)),
      expectedApiRequest('POST', '/api/jobs', {
        ...selection(fixture),
        preflightId: `pf_${fixture.target.id}`,
      }),
    ]);
    expect(enqueueSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it.each(NONTERMINAL_JOB_STATES)(
    'polls through canonical nonterminal job state %s',
    async (state) => {
      const fixture = await createFixture();
      let gets = 0;
      const sleeps: number[] = [];
      const dependencies = {
        ...dependencyHttp(fixture, (request, response) => {
          if (request.method !== 'GET') return response;
          gets += 1;
          return {
            status: 200,
            body: {
              ...structuredClone(fixture.job),
              state: gets === 1 ? state : 'failed',
            },
          };
        }),
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
        },
      };
      const result = await acceptTarget(fixture, { dependencies });
      expect(gets).toBe(2);
      expect(sleeps).toEqual([1_000]);
      expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
    },
  );

  it('removes every fixed-deadline abort listener across repeated active-state polls', async () => {
    const fixture = await createFixture();
    const activePolls = 15;
    let gets = 0;
    let listeners = 0;
    let additions = 0;
    let removals = 0;
    let maximumListeners = 0;
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...dependencyHttp(fixture, (request, response) => {
          if (request.method !== 'GET') return response;
          gets += 1;
          return {
            status: 200,
            body: {
              ...structuredClone(fixture.job),
              state: gets <= activePolls ? 'building' : 'failed',
            },
          };
        }),
        createDeadlineController: () => {
          const controller = new AbortController();
          const signal = controller.signal;
          const add = signal.addEventListener.bind(signal);
          const remove = signal.removeEventListener.bind(signal);
          Object.defineProperties(signal, {
            addEventListener: {
              value: (...args: Parameters<AbortSignal['addEventListener']>) => {
                if (args[0] === 'abort') {
                  additions += 1;
                  listeners += 1;
                  maximumListeners = Math.max(maximumListeners, listeners);
                }
                return add(...args);
              },
            },
            removeEventListener: {
              value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
                if (args[0] === 'abort') {
                  removals += 1;
                  listeners -= 1;
                }
                return remove(...args);
              },
            },
          });
          return controller;
        },
        sleep: async () => undefined,
      },
    });
    expect(gets).toBe(activePolls + 1);
    expect(additions).toBe((activePolls + 1) + activePolls);
    expect(removals).toBe(additions);
    expect(listeners).toBe(0);
    expect(maximumListeners).toBe(1);
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it('times out polling without accepting a queued DTO', async () => {
    const fixture = await createFixture();
    const queued = {
      ...structuredClone(fixture.job),
      state: 'queued',
      currentStage: null,
      stage: null,
      terminalAt: null,
      artifact: null,
      output: null,
      evidence: [],
    };
    let now = 0;
    const sleeps: number[] = [];
    const dependencies = {
      ...dependencyHttp(fixture, (request, response) => (
        request.method === 'GET' ? { status: 200, body: queued } : response
      )),
      clock: { now: () => now },
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
        now += 31_000;
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests.some((request) => request.method === 'GET')).toBe(true);
    expect(sleeps).toEqual(expect.arrayContaining([1_000]));
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a sleep that overruns the one fixed polling deadline without another request', async () => {
    const fixture = await createFixture();
    let now = 0;
    let gets = 0;
    const queued = {
      ...structuredClone(fixture.job),
      state: 'queued',
    };
    const dependencies = {
      ...dependencyHttp(fixture, (request, response) => {
        if (request.method !== 'GET') return response;
        gets += 1;
        return { status: 200, body: queued };
      }),
      clock: { now: () => now },
      sleep: async () => {
        now = 60_001;
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(gets).toBe(1);
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it('rejects a polling response returned after the remaining fixed deadline', async () => {
    const fixture = await createFixture();
    let now = 0;
    let gets = 0;
    const dependencies = {
      ...dependencyHttp(fixture, (request, response) => {
        if (request.method !== 'GET') return response;
        gets += 1;
        if (gets === 2) {
          now = 60_001;
          return response;
        }
        return {
          status: 200,
          body: { ...structuredClone(fixture.job), state: 'queued' },
        };
      }),
      clock: { now: () => now },
      sleep: async () => {
        now = 59_500;
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(gets).toBe(2);
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it('reports post-enqueue terminal failure as an unknown mutation', async () => {
    const fixture = await createFixture();
    const dependencies = dependencyHttp(fixture, (request, response) => (
      request.method === 'GET'
        ? { status: 200, body: { ...structuredClone(fixture.job), state: 'failed' } }
        : response
    ));
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests).toEqual(expectedApiRequests(fixture));
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it('accepts a canonical configured output root ID other than release', async () => {
    const fixture = await createFixture();
    const rootId = 'production-images';
    const loadedConfig = {
      ...fixture.loadedConfig,
      config: {
        ...fixture.loadedConfig.config,
        approvedOutputRoots: fixture.loadedConfig.config.approvedOutputRoots.map((root) => ({
          ...root,
          id: rootId,
        })),
      },
    };
    const context = {
      ...fixture.context,
      outputRootId: rootId,
      loadedConfig,
      job: {
        ...fixture.context.job,
        outputRootId: rootId,
      },
    } as unknown as TrustedAcceptanceContext;
    const requests: HttpRequest[] = [];
    const result = await acceptance.acceptTarget({
      env: {
        ...REAL_ENV,
        OSI_IMAGE_BUILDER_APPROVED_ROOT_ID: rootId,
      },
      context,
      dependencies: {
        ...fixture.dependencies,
        http: {
          request: async (request: HttpRequest) => {
            requests.push(structuredClone(request));
            return { status: 503, body: {} };
          },
        },
      },
    }) as Record<string, unknown>;
    expect(requests).toEqual([
      expectedApiRequest('POST', '/api/branches/refresh', {}),
    ]);
    expect(result).toMatchObject({ ok: false, mutation: 'none' });
  });

  it('allows a 10-hour-plus poll budget and rejects a budget over 24 hours', async () => {
    const accepted = await createFixture();
    let now = 0;
    let gets = 0;
    const acceptedResult = await acceptance.acceptTarget({
      env: REAL_ENV,
      context: accepted.context,
      dependencies: {
        ...dependencyHttp(accepted, (request, response) => {
          if (request.method !== 'GET') return response;
          gets += 1;
          return gets === 1
            ? { status: 200, body: { ...structuredClone(accepted.job), state: 'building' } }
            : { status: 200, body: { ...structuredClone(accepted.job), state: 'failed' } };
        }),
        clock: { now: () => now },
        sleep: async () => {
          now += 10 * 60 * 60 * 1_000 + 1;
        },
      },
    }) as Record<string, unknown>;
    expect(gets).toBe(2);
    expect(acceptedResult).toMatchObject({ ok: false, mutation: 'unknown' });

    const rejected = await createFixture();
    const rejectedResult = await acceptance.acceptTarget({
      env: REAL_ENV,
      context: rejected.context,
      dependencies: rejected.dependencies,
      poll: { intervalMs: 1_000, timeoutMs: 24 * 60 * 60 * 1_000 + 1 },
    }) as Record<string, unknown>;
    expect(rejected.httpRequests).toEqual(expectedApiRequests(rejected).slice(0, 3));
    expect(rejectedResult).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it.each([
    ['disabled', { ...REAL_ENV, OSI_IMAGE_BUILDER_REAL: '0' }],
    ['missing approved root', Object.fromEntries(Object.entries(REAL_ENV).filter(([key]) => key !== 'OSI_IMAGE_BUILDER_APPROVED_ROOT_ID'))],
    ['missing pinned SHA', Object.fromEntries(Object.entries(REAL_ENV).filter(([key]) => key !== 'OSI_IMAGE_BUILDER_PINNED_SHA'))],
    ['short pinned SHA', { ...REAL_ENV, OSI_IMAGE_BUILDER_PINNED_SHA: 'd92fabc2' }],
    ['different approved root ID', { ...REAL_ENV, OSI_IMAGE_BUILDER_APPROVED_ROOT_ID: 'backup' }],
    ['different pinned SHA', { ...REAL_ENV, OSI_IMAGE_BUILDER_PINNED_SHA: 'f'.repeat(40) }],
  ])('rejects %s guard before any API/build/release mutation', async (_name, env) => {
    const fixture = await createFixture();
    const before = await releaseSnapshot(fixture.releaseDir);
    const result = await acceptTarget(fixture, { env });
    expect(fixture.httpRequests).toEqual([]);
    expect(fixture.commandRequests).toEqual([]);
    expect(await releaseSnapshot(fixture.releaseDir)).toEqual(before);
    expect(result).toMatchObject({ ok: false, mutation: 'none' });
  });

  it('rejects a non-SSH configured origin while issuing no authority', async () => {
    const base = await mkdtemp(join(tmpdir(), 'osi-real-acceptance-origin-'));
    temporaryDirectories.push(base);
    await expect(createLoadedFixtureConfig(
      base,
      join(base, 'release'),
      join(base, 'repository'),
      join(base, 'installation', PACKAGE_VERSION, 'builder.lock.json'),
    )).resolves.toBeDefined();

    const configHome = join(base, 'bad-config-home');
    const configPath = join(configHome, 'osi-image-builder/config.json');
    const approvedRoot = join(base, 'bad-release');
    const repositoryPath = join(base, 'bad-repository');
    await Promise.all([
      mkdir(dirname(configPath), { recursive: true }),
      mkdir(approvedRoot),
      mkdir(repositoryPath),
    ]);
    await writeFile(configPath, canonicalJson({
      repositoryPath,
      approvedOutputRoots: [{ id: 'release', label: 'Release', path: approvedRoot }],
      builderLockPath: join(base, 'bad-installation', PACKAGE_VERSION, 'builder.lock.json'),
      maxQueueLength: 50,
      diskFreeMinimumBytes: 20 * 1024 ** 3,
    }));
    await expect(loadConfig({
      configPath,
      env: {
        HOME: base,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: join(base, 'bad-state-home'),
      },
      git: {
        getOriginPolicy: async () => ({
          url: 'https://github.com/Open-Smart-Irrigation/osi-os.git',
          fetchRefspec: '+refs/heads/*:refs/remotes/origin/*',
        }),
      },
      rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    })).rejects.toMatchObject({ code: 'ORIGIN_NOT_SSH' });
  });

  it('cannot bypass HTTP orchestration and final validation with a fabricated runTarget result', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.publishedChecksumsPath, `${'0'.repeat(64)}  ${basename(fixture.releaseImage)}\n`);
    let fabricatedCalls = 0;
    const dependencies = {
      ...fixture.dependencies,
      runTarget: async () => {
        fabricatedCalls += 1;
        return { ok: true, mutation: 'committed' };
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests).toEqual(expectedApiRequests(fixture));
    expect(fabricatedCalls).toBe(0);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects failed descriptor chmod after verification and report commit', async () => {
    const fixture = await createFixture('rpi-5', {
      seedReport: false,
      seedDockerInspection: false,
    });
    let calls = 0;
    const dependencies = {
      ...fixture.dependencies,
      chmodDescriptor: async (request: {
        handle: { chmod: (mode: number) => Promise<void> };
        mode: number;
      }) => {
        calls += 1;
        if (calls === 2) throw new Error('injected chmod failure');
        await request.handle.chmod(request.mode);
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(fixture.httpRequests).toEqual(expectedApiRequests(fixture));
    expect(fixture.commandRequests.length).toBeGreaterThan(0);
    expect(await lstat(fixture.reportPath)).toBeDefined();
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a release file replacement between validation and descriptor sealing', async () => {
    const fixture = await createFixture();
    let replaced = false;
    const dependencies = {
      ...fixture.dependencies,
      chmodDescriptor: async (request: {
        handle: { chmod: (mode: number) => Promise<void> };
        kind: 'file' | 'directory';
        relativeName: string;
        mode: number;
      }) => {
        await request.handle.chmod(request.mode);
        if (!replaced && request.kind === 'file') {
          const path = join(fixture.releaseDir, request.relativeName);
          const bytes = await readFile(path);
          await rename(path, `${path}.replaced`);
          await writeFile(path, bytes, { mode: 0o600 });
          replaced = true;
        }
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a release directory replacement after sealing and before reopen/hash', async () => {
    const fixture = await createFixture();
    let replaced = false;
    const dependencies = {
      ...fixture.dependencies,
      chmodDescriptor: async (request: {
        handle: { chmod: (mode: number) => Promise<void> };
        kind: 'file' | 'directory';
        mode: number;
      }) => {
        await request.handle.chmod(request.mode);
        if (!replaced && request.kind === 'directory') {
          await replaceReleaseDirectory(fixture, 'sealed-original');
          replaced = true;
        }
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it.each(RELEASE_MEMBER_KINDS)(
    'rejects coherent %s replacement after report verification but before seal acquisition',
    async (member) => {
      const fixture = await createFixture('rpi-5', {
        seedReport: false,
        seedDockerInspection: false,
      });
      let hookCalled = false;
      const result = await acceptTarget(fixture, {
        dependencies: {
          ...fixture.dependencies,
          beforeSeal: async () => {
            expect(await lstat(fixture.reportPath)).toBeDefined();
            expect(fixture.reopenedDescriptors).toEqual([]);
            await replaceReleaseMemberAfterVerification(fixture, member);
            hookCalled = true;
          },
        },
      });
      expect(hookCalled).toBe(true);
      expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
    },
  );

  it('rejects an approved-root pathname swap while release descriptors are held', async () => {
    const fixture = await createFixture();
    let swapped = false;
    let heldRoot: string | undefined;
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        holdDirectoryAuthority: async (path: string, options: Record<string, unknown>) => {
          heldRoot = path;
          return holdTestDirectoryAuthority(path, options);
        },
        chmodDescriptor: async (request: {
          handle: { chmod: (mode: number) => Promise<void> };
          mode: number;
        }) => {
          await request.handle.chmod(request.mode);
          if (!swapped) {
            await rename(fixture.approvedRoot, `${fixture.approvedRoot}.held`);
            await mkdir(fixture.approvedRoot, { mode: 0o700 });
            swapped = true;
          }
        },
      },
    });
    expect(swapped).toBe(true);
    expect(heldRoot).toBe(fixture.approvedRoot);
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it('rejects a held main ancestor swap while release descriptors are held', async () => {
    const fixture = await createFixture();
    const main = join(fixture.approvedRoot, 'main');
    let swapped = false;
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        chmodDescriptor: async (request: {
          handle: { chmod: (mode: number) => Promise<void> };
          mode: number;
        }) => {
          await request.handle.chmod(request.mode);
          if (!swapped) {
            await rename(main, `${main}.held`);
            await mkdir(main, { mode: 0o700 });
            swapped = true;
          }
        },
      },
    });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it('rejects a same-size same-bytes rewrite whose nanosecond metadata changed', async () => {
    const fixture = await createFixture();
    let rewritten = false;
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        chmodDescriptor: async (request: {
          handle: { chmod: (mode: number) => Promise<void> };
          relativeName: string;
          mode: number;
        }) => {
          if (!rewritten && request.relativeName === 'build-manifest.json') {
            const bytes = await readFile(fixture.buildManifestPath);
            await writeFile(fixture.buildManifestPath, bytes);
            await utimes(
              fixture.buildManifestPath,
              new Date('2026-07-29T10:20:00.000Z'),
              new Date('2026-07-29T10:20:00.000Z'),
            );
            rewritten = true;
          }
          await request.handle.chmod(request.mode);
        },
      },
    });
    expect(rewritten).toBe(true);
    expect(fixture.reopenedDescriptors).toEqual([]);
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it('rejects any extra release member before sealing', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.releaseDir, 'report.json'), '{}\n', { mode: 0o600 });
    const result = await acceptTarget(fixture);
    expect(fixture.httpRequests).toEqual(expectedApiRequests(fixture));
    expect(result).toMatchObject({ ok: false });
  });

  it.each(['symlink', 'hardlink', 'fifo', 'subdirectory'] as const)(
    'rejects a non-regular release image member (%s) before sealing',
    async (kind) => {
      const fixture = await createFixture();
      await replaceReleaseImageWithSpecialEntry(fixture, kind);
      const result = await acceptTarget(fixture);
      expect(result).toMatchObject({ ok: false });
      expect(await lstat(fixture.releaseDir)).toMatchObject({ mode: expect.any(Number) });
      expect(await lstat(fixture.releaseImage)).toSatisfy((metadata) => (
        kind === 'symlink' ? metadata.isSymbolicLink()
          : kind === 'fifo' ? metadata.isFIFO()
            : kind === 'subdirectory' ? metadata.isDirectory()
              : metadata.isFile()
      ));
    },
  );

  it.each(RELEASE_MEMBER_KINDS.flatMap((member) => (
    (['symlink', 'hardlink', 'fifo', 'subdirectory'] as const).map((kind) => [member, kind] as const)
  )))('rejects %s release member represented as %s', async (member, kind) => {
    const fixture = await createFixture();
    await replaceReleaseMemberWithSpecialEntry(fixture, member, kind);
    const result = await acceptTarget(fixture);
    expect(result).toMatchObject({ ok: false });
    const path = member === 'image' ? fixture.releaseImage : join(fixture.releaseDir, member);
    const metadata = await lstat(path);
    expect(
      kind === 'symlink' ? metadata.isSymbolicLink()
        : kind === 'fifo' ? metadata.isFIFO()
          : kind === 'subdirectory' ? metadata.isDirectory()
            : metadata.isFile() && metadata.nlink > 1,
    ).toBe(true);
  });

  it('rejects a release dependency whose recorded root identity is on another device', async () => {
    const fixture = await createFixture();
    const buildManifest = structuredClone(fixture.buildManifest) as Record<string, unknown>;
    const rootIdentity = buildManifest.rootIdentity as Record<string, unknown>;
    rootIdentity.device = await foreignDeviceFor(fixture.approvedRoot);
    await rewriteReleaseJson(fixture.buildManifestPath, buildManifest);
    const result = await acceptTarget(fixture);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a release that becomes writable after directory sealing and reopen', async () => {
    const fixture = await createFixture();
    let directorySealObserved = false;
    const dependencies = {
      ...fixture.dependencies,
      chmodDescriptor: async (request: {
        handle: { chmod: (mode: number) => Promise<void> };
        kind: 'file' | 'directory';
        mode: number;
      }) => {
        await request.handle.chmod(request.mode);
        if (request.kind === 'directory') {
          directorySealObserved = true;
          await chmod(fixture.releaseDir, 0o755);
        }
      },
    };
    const result = await acceptTarget(fixture, { dependencies });
    expect(directorySealObserved).toBe(true);
    expect((await lstat(fixture.releaseDir)).mode & 0o222).not.toBe(0);
    expect(result).toMatchObject({ ok: false });
  });

  it('runs Pi 5 to sealed completion before enqueueing Pi 4 and returns committed success', async () => {
    const pi5 = await createFixture('rpi-5', { seedReport: false, seedDockerInspection: false });
    const pi4 = await createFixture('rpi-2', { seedReport: false, seedDockerInspection: false });
    const order: HttpRequest[] = [];
    let active: Fixture = pi5;
    const combinedHttp = {
      request: async (request: HttpRequest): Promise<HttpResponse> => {
        order.push(structuredClone(request));
        const transport = active.dependencies.http as {
          request: (value: HttpRequest) => Promise<HttpResponse>;
        };
        const response = await transport.request(request);
        if (request.method === 'GET' && request.path === `/api/jobs/${pi5.job.id}`) active = pi4;
        return response;
      },
    };
    const dependencies = {
      http: combinedHttp,
      clock: { now: () => Date.parse(STARTED_AT) },
      sleep: async () => undefined,
      targets: {
        'rpi-5': { ...pi5.dependencies, http: combinedHttp },
        'rpi-2': { ...pi4.dependencies, http: combinedHttp },
      },
    };
    const result = await acceptance.acceptAll({
      env: REAL_ENV,
      contexts: {
        'rpi-5': pi5.context,
        'rpi-2': pi4.context,
      },
      dependencies,
      poll: { intervalMs: 1_000, timeoutMs: 60_000 },
    }) as Record<string, unknown>;
    expect(order).toEqual([
      ...expectedApiRequests(pi5),
      ...expectedApiRequests(pi4),
    ]);
    const pi5Terminal = order.findIndex(({ path }) => path === `/api/jobs/${pi5.job.id}`);
    const pi4Enqueue = order.findIndex(({ method, path, body }) => (
      method === 'POST' && path === '/api/jobs' && body?.targetId === 'rpi-2'
    ));
    expect(pi5Terminal).toBeGreaterThanOrEqual(0);
    expect(pi4Enqueue).toBeGreaterThan(pi5Terminal);
    expect(await releaseModes(pi5)).toMatchObject({ [basename(pi5.releaseDir)]: 0o555 });
    expect(await releaseModes(pi4)).toMatchObject({ [basename(pi4.releaseDir)]: 0o555 });
    expect(result).toEqual({
      ok: true,
      targetIds: ['rpi-5', 'rpi-2'],
      mutation: 'committed',
    });
  });

  it('preserves prior mutation when Pi 4 fails before its enqueue after Pi 5 committed', async () => {
    const pi5 = await createFixture('rpi-5');
    const pi4 = await createFixture('rpi-2');
    const order: HttpRequest[] = [];
    let active: Fixture = pi5;
    const combinedHttp = {
      request: async (request: HttpRequest): Promise<HttpResponse> => {
        order.push(structuredClone(request));
        const fixture = active;
        const transport = fixture.dependencies.http as {
          request: (value: HttpRequest) => Promise<HttpResponse>;
        };
        const response = await transport.request(request);
        if (fixture === pi5 && request.method === 'GET') active = pi4;
        if (fixture === pi4 && request.path === '/api/branches/refresh') {
          const body = structuredClone(response.body) as Record<string, unknown>;
          (body.branches as Array<Record<string, unknown>>)[0]!.sha = 'f'.repeat(40);
          return { ...response, body };
        }
        return response;
      },
    };
    const result = await acceptance.acceptAll({
      env: REAL_ENV,
      contexts: { 'rpi-5': pi5.context, 'rpi-2': pi4.context },
      dependencies: {
        http: combinedHttp,
        clock: { now: () => Date.parse(STARTED_AT) },
        sleep: async () => undefined,
        targets: {
          'rpi-5': { ...pi5.dependencies, http: combinedHttp },
          'rpi-2': { ...pi4.dependencies, http: combinedHttp },
        },
      },
    }) as Record<string, unknown>;
    expect(order.some(({ body }) => body?.targetId === 'rpi-2')).toBe(false);
    expect(await releaseModes(pi5)).toMatchObject({ [basename(pi5.releaseDir)]: 0o555 });
    expect(result).toMatchObject({ ok: false, mutation: 'unknown' });
  });

  it.each([
    ['replaced hash', (snapshot: ReopenedDescriptorSnapshot) => ({ ...snapshot, sha256: '0'.repeat(64) })],
    ['wrong device', (snapshot: ReopenedDescriptorSnapshot) => ({ ...snapshot, device: snapshot.device + 1 })],
    ['wrong mode', (snapshot: ReopenedDescriptorSnapshot) => ({ ...snapshot, mode: 0o644 })],
    ['wrong link count', (snapshot: ReopenedDescriptorSnapshot) => ({ ...snapshot, singleLink: false })],
  ] as const)('rejects %s returned by reopenDescriptor instead of trusting tracking state', async (_name, mutate) => {
    const fixture = await createFixture();
    const base = fixture.dependencies.reopenDescriptor as (
      request: Readonly<{ relativeName: string }>,
    ) => Promise<ReopenedDescriptorSnapshot>;
    const result = await acceptTarget(fixture, {
      dependencies: {
        ...fixture.dependencies,
        reopenDescriptor: async (request: Readonly<{ relativeName: string }>) => {
          const snapshot = await base(request);
          return request.relativeName === basename(fixture.releaseImage) ? mutate(snapshot) : snapshot;
        },
      },
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a malformed publishAcceptanceEvidence return instead of trusting the output pathname', async () => {
    const fixture = await createFixture('rpi-5', { seedReport: false, seedDockerInspection: false });
    const base = fixture.dependencies.publishAcceptanceEvidence as (
      request: Readonly<{ jobId: string; relativePath: string; contents: string | Buffer }>,
    ) => Promise<HeldEvidenceSnapshot>;
    const result = await acceptance.buildAcceptanceReport({
      env: REAL_ENV,
      context: fixture.context,
      dependencies: {
        ...fixture.dependencies,
        publishAcceptanceEvidence: async (
          request: Readonly<{ jobId: string; relativePath: string; contents: string | Buffer }>,
        ) => ({ ...(await base(request)), sha256: '0'.repeat(64) }),
      },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    ['world-readable', 0o444],
    ['owner-readable with default group permissions', 0o644],
    ['writable by other users', 0o602],
    ['mismatched private mode', 0o640],
  ] as const)('rejects %s acceptance evidence publication mode', async (_name, mode) => {
    const fixture = await createFixture('rpi-5', { seedReport: false, seedDockerInspection: false });
    const base = fixture.dependencies.publishAcceptanceEvidence as (
      request: Readonly<{ jobId: string; relativePath: string; contents: string | Buffer }>,
    ) => Promise<HeldEvidenceSnapshot>;
    const result = await acceptance.buildAcceptanceReport({
      env: REAL_ENV,
      context: fixture.context,
      dependencies: {
        ...fixture.dependencies,
        publishAcceptanceEvidence: async (
          request: Readonly<{ jobId: string; relativePath: string; contents: string | Buffer }>,
        ) => ({ ...(await base(request)), mode }),
      },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, code: 'ACCEPTANCE_REPORT_BUILD_FAILED' });
  });

  it('accepts and idempotently reuses exact pre-seeded 0600 acceptance evidence', async () => {
    const fixture = await createFixture('rpi-5');
    expect((await lstat(fixture.dockerInspectionPath)).mode & 0o7777).toBe(0o600);
    expect((await lstat(fixture.reportPath)).mode & 0o7777).toBe(0o600);

    const result = await acceptance.buildAcceptanceReport({
      env: REAL_ENV,
      context: fixture.context,
      dependencies: fixture.dependencies,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, mutation: 'committed' });
    expect(fixture.acceptancePublicationSnapshots['docker-inspection.json']).toMatchObject({ mode: 0o600 });
    expect(fixture.acceptancePublicationSnapshots['real-acceptance-report.json']).toMatchObject({ mode: 0o600 });
    expect((await lstat(fixture.dockerInspectionPath)).mode & 0o7777).toBe(0o600);
    expect((await lstat(fixture.reportPath)).mode & 0o7777).toBe(0o600);
  });

  it('publishes acceptance evidence with the exact terminal job ID', async () => {
    const fixture = await createFixture('rpi-5', {
      seedReport: false,
      seedDockerInspection: false,
    });
    const base = fixture.dependencies.publishAcceptanceEvidence as (
      request: Readonly<{ jobId: string; relativePath: string; contents: string | Buffer }>,
    ) => Promise<HeldEvidenceSnapshot>;
    const requests: Array<{ jobId: string; relativePath: string }> = [];
    const result = await acceptance.buildAcceptanceReport({
      env: REAL_ENV,
      context: fixture.context,
      dependencies: {
        ...fixture.dependencies,
        publishAcceptanceEvidence: async (
          request: Readonly<{ jobId: string; relativePath: string; contents: string | Buffer }>,
        ) => {
          requests.push({ jobId: request.jobId, relativePath: request.relativePath });
          return base(request);
        },
      },
    }) as Record<string, unknown>;
    expect(requests).toEqual([
      { jobId: fixture.job.id, relativePath: 'docker-inspection.json' },
      { jobId: fixture.job.id, relativePath: 'real-acceptance-report.json' },
    ]);
    expect(result).toMatchObject({ ok: true, mutation: 'committed' });
    expect(fixture.acceptancePublicationSnapshots['docker-inspection.json']).toMatchObject({ mode: 0o600 });
    expect(fixture.acceptancePublicationSnapshots['real-acceptance-report.json']).toMatchObject({ mode: 0o600 });
  });

  it('rejects valid but different generated builder identities across targets', async () => {
    const pi5 = await createFixture('rpi-5');
    const otherLock = productionLock();
    otherLock.baseImageDigest = '9'.repeat(64);
    otherLock.baseImage = `docker.io/library/debian@sha256:${otherLock.baseImageDigest}`;
    const pi4 = await createFixture('rpi-2', { lock: otherLock });
    const order: HttpRequest[] = [];
    let active: Fixture = pi5;
    const combinedHttp = {
      request: async (request: HttpRequest): Promise<HttpResponse> => {
        order.push(structuredClone(request));
        const transport = active.dependencies.http as {
          request: (value: HttpRequest) => Promise<HttpResponse>;
        };
        const response = await transport.request(request);
        if (request.method === 'GET' && request.path === `/api/jobs/${pi5.job.id}`) active = pi4;
        return response;
      },
    };
    const result = await acceptance.acceptAll({
      env: REAL_ENV,
      contexts: { 'rpi-5': pi5.context, 'rpi-2': pi4.context },
      dependencies: {
        http: combinedHttp,
        clock: { now: () => Date.parse(STARTED_AT) },
        sleep: async () => undefined,
        targets: {
          'rpi-5': { ...pi5.dependencies, http: combinedHttp },
          'rpi-2': { ...pi4.dependencies, http: combinedHttp },
        },
      },
    }) as Record<string, unknown>;
    expect(validateBuilderLock(otherLock, PACKAGE_VERSION)).toMatchObject({ ok: true });
    expect(pi5.lock.imageDigest).toBe(pi4.lock.imageDigest);
    expect(pi5.lock.imageId).toBe(pi4.lock.imageId);
    expect(sha256(canonicalJson(pi5.lock))).not.toBe(sha256(canonicalJson(pi4.lock)));
    expect(order.some(({ path }) => path === `/api/jobs/${pi5.job.id}`)).toBe(true);
    expect(order.some(({ path }) => path === `/api/jobs/${pi4.job.id}`)).toBe(true);
    expect(result).toMatchObject({ ok: false });
  });

  it('blocks Pi 4 enqueue when Pi 5 final verification fails', async () => {
    const pi5 = await createFixture('rpi-5');
    const pi4 = await createFixture('rpi-2');
    const pi5Base = pi5.dependencies.runCommand as (
      request: CommandRequest,
    ) => Promise<CommandResult>;
    const pi5Dependencies = {
      ...pi5.dependencies,
      runCommand: async (request: CommandRequest) => {
        const value = await pi5Base(request);
        return request.id === 'published-sha256sum'
          ? { ok: false, exitCode: 1, stdout: '', stderr: 'checksum failed' }
          : value;
      },
    };
    const order: HttpRequest[] = [];
    const combinedHttp = {
      request: async (request: HttpRequest): Promise<HttpResponse> => {
        order.push(structuredClone(request));
        return (pi5.dependencies.http as {
          request: (value: HttpRequest) => Promise<HttpResponse>;
        }).request(request);
      },
    };
    const result = await acceptance.acceptAll({
      env: REAL_ENV,
      contexts: { 'rpi-5': pi5.context, 'rpi-2': pi4.context },
      dependencies: {
        http: combinedHttp,
        clock: { now: () => Date.parse(STARTED_AT) },
        sleep: async () => undefined,
        targets: {
          'rpi-5': { ...pi5Dependencies, http: combinedHttp },
          'rpi-2': { ...pi4.dependencies, http: combinedHttp },
        },
      },
    }) as Record<string, unknown>;
    expect(order.some(({ body }) => body?.targetId === 'rpi-2')).toBe(false);
    expect(result).toMatchObject({ ok: false });
  });

  it('does not let acceptAll advance after a fabricated successful seal leaves Pi 5 writable', async () => {
    const pi5 = await createFixture('rpi-5');
    const pi4 = await createFixture('rpi-2');
    const order: HttpRequest[] = [];
    const combinedHttp = {
      request: async (request: HttpRequest): Promise<HttpResponse> => {
        order.push(structuredClone(request));
        return (pi5.dependencies.http as {
          request: (value: HttpRequest) => Promise<HttpResponse>;
        }).request(request);
      },
    };
    const result = await acceptance.acceptAll({
      env: REAL_ENV,
      contexts: { 'rpi-5': pi5.context, 'rpi-2': pi4.context },
      dependencies: {
        http: combinedHttp,
        clock: { now: () => Date.parse(STARTED_AT) },
        sleep: async () => undefined,
        targets: {
          'rpi-5': {
            ...pi5.dependencies,
            http: combinedHttp,
            chmodDescriptor: async () => undefined,
          },
          'rpi-2': { ...pi4.dependencies, http: combinedHttp },
        },
      },
    }) as Record<string, unknown>;
    expect((await lstat(pi5.releaseDir)).mode & 0o777).toBe(0o700);
    expect(order.some(({ body }) => body?.targetId === 'rpi-2')).toBe(false);
    expect(result).toMatchObject({ ok: false });
  });

  it('composes both targets from one held installation with custom XDG paths and a non-release root', async () => {
    const fixture = await createProductionRuntimeFixture('production-images');
    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    const observed = await withRuntime({
      target: 'all',
      env: fixture.env,
      dependencies: fixture.dependencies,
    }, async (runtime) => {
      const contexts = runtime.contexts as Record<TargetId, TrustedAcceptanceContext>;
      expect(contexts['rpi-5'].selectedInstallation).toBe(contexts['rpi-2'].selectedInstallation);
      expect(contexts['rpi-5'].loadedConfig).toBe(contexts['rpi-2'].loadedConfig);
      expect(contexts['rpi-5'].loadedConfig.configRoot).toBe(fixture.configRoot);
      expect(contexts['rpi-5'].loadedConfig.stateRoot).toBe(fixture.stateRoot);
      expect(contexts['rpi-5']).toMatchObject({
        branch: 'main',
        pinnedSha: SHA40,
        outputRootId: 'production-images',
        targetId: 'rpi-5',
        job: null,
      });
      expect(contexts['rpi-2']).toMatchObject({
        branch: 'main',
        pinnedSha: SHA40,
        outputRootId: 'production-images',
        targetId: 'rpi-2',
        job: null,
      });
      expect(contexts['rpi-5'].selectedInstallation.lockBytes)
        .toEqual(Buffer.from(fixture.selected.lockText));
      expect(contexts['rpi-5'].selectedInstallation.manifestBytes)
        .toEqual(INSTALLED_MANIFEST_BYTES);
      return 'held';
    });
    expect(observed).toBe('held');
  });

  it('routes production state reads and evidence writes through the held state authority with exact job identity', async () => {
    const fixture = await createProductionRuntimeFixture();
    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    await withRuntime({
      target: 'pi5',
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: fixture.dependencies,
    }, async (runtime) => {
      const readJobRoot = join(fixture.stateRoot, 'jobs', 'job-read');
      const stateFile = join(readJobRoot, 'evidence', '08-verify.json');
      await ensureFile(stateFile, '{"ok":true}\n');
      await Promise.all([
        chmod(join(fixture.stateRoot, 'jobs'), 0o700),
        chmod(readJobRoot, 0o700),
        chmod(join(readJobRoot, 'evidence'), 0o700),
      ]);
      const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
      const observedHash = await dependencies.withNoFollowFile(
        stateFile,
        async (reader: ReadCapability) => reader.hashSha256(),
      );
      expect(observedHash).toBe(sha256('{"ok":true}\n'));
      const publication = await dependencies.publishAcceptanceEvidence({
        jobId: 'job-production',
        relativePath: 'docker-inspection.json',
        contents: Buffer.from('{"Id":"sha256:test"}\n'),
      });
      expect(publication.path).toBe('jobs/job-production/evidence/docker-inspection.json');
      expect(await readFile(join(
        fixture.stateRoot,
        'jobs',
        'job-production',
        'evidence',
        'docker-inspection.json',
      ))).toEqual(Buffer.from('{"Id":"sha256:test"}\n'));
    });
  });

  it('rejects loaded and held authority drift before any production HTTP request', async () => {
    const fixture = await createProductionRuntimeFixture();
    let requests = 0;
    const stdout: string[] = [];
    const options = fixture.dependencies.productionConfigOptions as Parameters<typeof loadConfig>[0];
    const result = await acceptance.runAcceptanceMain({
      argv: ['pi5'],
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: {
        ...fixture.dependencies,
        evaluateGuards: async () => ({ ok: true, mutation: 'none' }),
        loadProductionConfig: async (input: Parameters<typeof loadConfig>[0]) => ({
          ...(await loadConfig({ ...options, ...input })),
          stateRoot: join(fixture.base, 'drifted-state'),
        }),
        http: {
          request: async () => {
            requests += 1;
            return { status: 500, body: {} };
          },
        },
        writeStdout: (line: string) => stdout.push(line),
        setExitCode: () => undefined,
      },
    });
    expect(requests).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      code: 'PRODUCTION_COMPOSITION_FAILED',
      mutation: 'none',
    });
  });

  it('rejects absolute adapter requests outside every held configured authority', async () => {
    const fixture = await createProductionRuntimeFixture();
    const outside = join(fixture.base, 'outside.txt');
    await writeFile(outside, 'outside\n');
    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    await withRuntime({
      target: 'pi5',
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: fixture.dependencies,
    }, async (runtime) => {
      const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
      await expect(dependencies.withNoFollowFile(
        outside,
        async () => undefined,
      )).rejects.toThrow('exactly one held configured authority');
      await expect(dependencies.withHeldDirectory(
        fixture.base,
        async () => undefined,
      )).rejects.toThrow('exactly one held configured authority');
    });
  });

  it('rejects a requested tree root mount crossing before entering the tree callback', async () => {
    const fixture = await createProductionRuntimeFixture();
    const tree = join(fixture.repositoryPath, 'gui');
    await ensureFile(join(tree, 'index.html'), '<title>OSI</title>\n');
    const descriptorsBefore = (await readdir('/proc/self/fd')).sort();
    let treeCallbackEntered = false;
    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    await withRuntime({
      target: 'pi5',
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: {
        ...fixture.dependencies,
        directoryMountId: async (
          _handle: unknown,
          context: { authority: string; relativePath: string; role: string },
        ) => context.role === 'component' && context.relativePath === 'gui' ? 42 : 41,
        treeHashHooks: {
          beforeOpen: async () => {
            treeCallbackEntered = true;
          },
        },
      },
    }, async (runtime) => {
      const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
      await expect(dependencies.hashTree(tree)).rejects.toThrow(/mount/iu);
    });
    expect(treeCallbackEntered).toBe(false);
    expect((await readdir('/proc/self/fd')).sort()).toEqual(descriptorsBefore);
  });

  it('rejects an intermediate command-directory mount crossing before running the callback', async () => {
    const fixture = await createProductionRuntimeFixture();
    const cwd = join(fixture.stateRoot, 'jobs', 'job-production', 'workspace', 'source');
    await mkdir(cwd, { recursive: true });
    const descriptorsBefore = (await readdir('/proc/self/fd')).sort();
    let commandRan = false;
    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    await withRuntime({
      target: 'pi5',
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: {
        ...fixture.dependencies,
        directoryMountId: async (
          _handle: unknown,
          context: { authority: string; relativePath: string; role: string },
        ) => context.role === 'component' && context.relativePath === 'jobs' ? 52 : 51,
      },
    }, async (runtime) => {
      const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
      await expect(dependencies.withHeldDirectory(cwd, async () => {
        commandRan = true;
      })).rejects.toThrow(/mount/iu);
    });
    expect(commandRan).toBe(false);
    expect((await readdir('/proc/self/fd')).sort()).toEqual(descriptorsBefore);
  });

  it('rejects a configured state root removed after guards without loading config or making HTTP requests', async () => {
    const fixture = await createProductionRuntimeFixture();
    await mkdir(fixture.stateRoot, { recursive: true, mode: 0o700 });
    const descriptorsBefore = (await readdir('/proc/self/fd')).sort();
    let configLoads = 0;
    let requests = 0;
    const stdout: string[] = [];
    const result = await acceptance.runAcceptanceMain({
      argv: ['pi5'],
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: {
        ...fixture.dependencies,
        evaluateGuards: async () => {
          await rm(fixture.stateRoot, { recursive: true });
          return { ok: true, mutation: 'none' };
        },
        loadProductionConfig: async () => {
          configLoads += 1;
          throw new Error('loadConfig must not run for a missing configured state authority');
        },
        http: {
          request: async () => {
            requests += 1;
            return { status: 500, body: {} };
          },
        },
        writeStdout: (line: string) => stdout.push(line),
        setExitCode: () => undefined,
      },
    });
    expect(configLoads).toBe(0);
    expect(requests).toBe(0);
    await expect(lstat(fixture.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stdout).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      code: 'PRODUCTION_COMPOSITION_FAILED',
      mutation: 'none',
    });
    expect((await readdir('/proc/self/fd')).sort()).toEqual(descriptorsBefore);
  });

  it('streams production seal reopen hashes for images larger than the bounded read cap', async () => {
    const fixture = await createProductionRuntimeFixture();
    const image = join(fixture.outputRoot, 'large-image.img.gz');
    await ensureSparseImage(image, 17 * 1024 * 1024);
    const directory = await open(fixture.outputRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    try {
      await withRuntime({
        target: 'pi5',
        env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
        dependencies: fixture.dependencies,
      }, async (runtime) => {
        const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
        const snapshot = await dependencies.reopenDescriptor({
          relativeName: 'large-image.img.gz',
          path: image,
          kind: 'file',
          executionPath: `/proc/self/fd/${directory.fd}/large-image.img.gz`,
        });
        expect(snapshot).toMatchObject({
          path: image,
          kind: 'file',
          regular: true,
          singleLink: true,
          size: 17 * 1024 * 1024,
          sha256: sparseZeroSha256(17 * 1024 * 1024),
        });
        expect(snapshot).not.toHaveProperty('bytes');
      });
    } finally {
      await directory.close();
    }
  });

  it('hashes production GUI trees deterministically and rejects special entries and swaps', async () => {
    const fixture = await createProductionRuntimeFixture();
    const tree = join(fixture.repositoryPath, 'gui');
    await ensureFile(join(tree, 'index.html'), '<title>OSI</title>\n');
    await ensureFile(join(tree, 'assets', 'app.js'), 'console.log("osi");\n');
    const withRuntime = acceptance.withProductionAcceptanceRuntime as (
      input: Record<string, unknown>,
      callback: (runtime: Record<string, any>) => Promise<unknown>,
    ) => Promise<unknown>;
    await withRuntime({
      target: 'pi5',
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: fixture.dependencies,
    }, async (runtime) => {
      const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
      expect(await dependencies.hashTree(tree)).toBe(await recursiveContentHash(tree));
      await symlink('/etc/passwd', join(tree, 'special'));
      await expect(dependencies.hashTree(tree)).rejects.toThrow('special entry');
    });

    const swapped = await createProductionRuntimeFixture();
    const swappedTree = join(swapped.repositoryPath, 'gui');
    const original = join(swappedTree, 'index.html');
    await ensureFile(original, 'original\n');
    let didSwap = false;
    await expect(withRuntime({
      target: 'pi5',
      env: { ...swapped.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: {
        ...swapped.dependencies,
        treeHashHooks: {
          beforeOpen: async ({ kind, relativePath }: { kind: string; relativePath: string }) => {
            if (!didSwap && kind === 'file' && relativePath === 'index.html') {
              didSwap = true;
              await rename(original, join(swappedTree, 'old-index.html'));
              await writeFile(original, 'replacement\n');
            }
          },
        },
      },
    }, async (runtime) => {
      const dependencies = runtime.dependencies as Record<string, (...args: any[]) => Promise<any>>;
      return dependencies.hashTree(swappedTree);
    })).rejects.toThrow('identity changed');
  });

  it('uses production composition by default after guards without starting a build on refresh failure', async () => {
    const fixture = await createProductionRuntimeFixture();
    const requests: HttpRequest[] = [];
    const stdout: string[] = [];
    let exitCode: number | undefined;
    const result = await acceptance.runAcceptanceMain({
      argv: ['pi5'],
      env: { ...fixture.env, OSI_IMAGE_BUILDER_TARGET: 'rpi-5' },
      dependencies: {
        ...fixture.dependencies,
        evaluateGuards: async () => ({ ok: true, mutation: 'none' }),
        http: {
          request: async (request: HttpRequest) => {
            requests.push(request);
            return { status: 503, body: {} };
          },
        },
        writeStdout: (line: string) => stdout.push(line),
        setExitCode: (value: number) => { exitCode = value; },
      },
    });
    expect(requests.map(({ method, path }) => `${method} ${path}`))
      .toEqual(['POST /api/branches/refresh']);
    expect(stdout).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      code: 'TARGET_ACCEPTANCE_FAILED',
      mutation: 'none',
    });
  });

  it('CLI main calls orchestration only after guards and sets exit success for committed acceptance', async () => {
    const runAcceptanceMain = (acceptance as Record<string, unknown>).runAcceptanceMain;
    expect(typeof runAcceptanceMain).toBe('function');
    const order: string[] = [];
    const stdout: string[] = [];
    let exitCode: number | undefined;
    const result = await (runAcceptanceMain as (input: Record<string, unknown>) => Promise<unknown>)({
      argv: ['pi5'],
      env: REAL_ENV,
      dependencies: {
        evaluateGuards: async () => {
          order.push('guards');
          return { ok: true, targetId: 'rpi-5', mutation: 'none' };
        },
        orchestrate: async () => {
          order.push('orchestrate');
          return { ok: true, targetId: 'rpi-5', mutation: 'committed' };
        },
        writeStdout: (value: string) => { stdout.push(value); },
        setExitCode: (value: number) => { exitCode = value; },
      },
    });
    expect(order).toEqual(['guards', 'orchestrate']);
    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      ok: true,
      targetId: 'rpi-5',
      mutation: 'committed',
    });
    expect(result).toMatchObject({ ok: true, mutation: 'committed' });
  });

  it('CLI main invokes production composition after guards when no context is injected', async () => {
    const order: string[] = [];
    const stdout: string[] = [];
    let exitCode: number | undefined;
    const result = await acceptance.runAcceptanceMain({
      argv: ['pi4'],
      env: {
        ...REAL_ENV,
        OSI_IMAGE_BUILDER_TARGET: 'rpi-2',
      },
      dependencies: {
        evaluateGuards: async () => {
          order.push('guards');
          return { ok: true, targetId: 'rpi-2', mutation: 'none' };
        },
        composeProduction: async (input: Record<string, unknown>) => {
          order.push('production');
          expect(input).toMatchObject({ target: 'pi4' });
          return { ok: true, targetId: 'rpi-2', mutation: 'committed' };
        },
        writeStdout: (value: string) => {
          stdout.push(value);
        },
        setExitCode: (value: number) => {
          exitCode = value;
        },
      },
    });
    expect(order).toEqual(['guards', 'production']);
    expect(stdout).toHaveLength(1);
    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ ok: true, targetId: 'rpi-2', mutation: 'committed' });
  });
});
