import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { deriveSystemdBusEnvironment } from '../api/src/preflight.js';
import { validateAuthorityTopology } from '../config/config-document.mjs';
import { resolveConfigDirectories } from '../config/defaults.js';
import { validateBuilderLock } from '../domain/builder-lock.js';
import { loadManifest } from '../manifest/validate.js';
import {
  withEffectiveHomeAuthority,
  type EffectiveHomeAuthority,
  type EffectiveHomeResolverOptions,
} from '../shared/effective-home.mjs';
import {
  assertHeldAuthoritiesDisjoint,
  holdDirectoryAuthority,
  type HeldAuthorityTopologyEntry,
  type HeldDirectoryAuthority,
} from '../shared/held-directory-authority.mjs';
import { InstallerError, type InstallerFileSystem } from './install.js';
import { acquireInstallLock, INSTALL_LOCK_NAME } from './production.js';

const execFile = promisify(execFileCallback);
const MAX_ERROR_BYTES = 1_024;
const VERSION = /^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u;
const CLOSE_ON_EXEC = Number(Reflect.get(fsConstants, 'O_CLOEXEC') ?? 0);
const DIRECTORY_FLAGS = fsConstants.O_RDONLY
  | fsConstants.O_DIRECTORY
  | fsConstants.O_NOFOLLOW
  | CLOSE_ON_EXEC;
const OUTPUT_DIRECTORY_MODE = 0o750;
const UNIT_NAMES = Object.freeze([
  'osi-image-builder.service',
  'osi-image-builder-runner@.service',
] as const);
const LEGACY_CLEANUP_UNIT = 'osi-image-builder-cleanup@.service';

export interface ConfigureInstallerInput {
  readonly fs: Pick<
    InstallerFileSystem,
    'writeFile' | 'fsyncFile' | 'fsyncDirectory' | 'renameReplace' | 'remove'
  >;
  readonly approvedRoot?: string;
  readonly installRoot: string;
  readonly selectionPath: string;
  readonly systemdConfigPath: string;
  readonly output: (line: string) => void;
  readonly canonicalize?: (path: string) => string | Promise<string>;
}

async function canonicalPath(
  value: string | undefined,
  name: string,
  canonicalize: (path: string) => string | Promise<string>,
): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/') || value.includes('\0')) {
    throw new InstallerError(name === 'approvedOutputRoot' ? 'APPROVED_ROOT_REQUIRED' : 'INSTALL_PATH_INVALID', `${name} must be an explicit absolute path`);
  }
  const canonical = await canonicalize(posix.normalize(value));
  if (typeof canonical !== 'string' || !canonical.startsWith('/') || canonical.includes('\0')) {
    throw new InstallerError('INSTALL_PATH_INVALID', `${name} did not resolve to a canonical absolute path`);
  }
  return posix.normalize(canonical);
}

export async function configureInstaller(input: ConfigureInstallerInput): Promise<Readonly<{
  readonly approvedOutputRoot: string;
  readonly installRoot: string;
  readonly selectionPath: string;
  readonly systemdConfigPath: string;
}>> {
  const canonicalize = input.canonicalize ?? ((path: string) => path);
  const approvedOutputRoot = await canonicalPath(input.approvedRoot, 'approvedOutputRoot', canonicalize);
  const installRoot = await canonicalPath(input.installRoot, 'installRoot', canonicalize);
  const selectionPath = await canonicalPath(input.selectionPath, 'selectionPath', canonicalize);
  const systemdConfigPath = await canonicalPath(input.systemdConfigPath, 'systemdConfigPath', canonicalize);
  const paths = Object.freeze({ approvedOutputRoot, installRoot, selectionPath, systemdConfigPath });

  input.output(`approvedOutputRoot=${paths.approvedOutputRoot}`);
  input.output(`installRoot=${paths.installRoot}`);
  input.output(`selectionPath=${paths.selectionPath}`);
  input.output(`systemdConfigPath=${paths.systemdConfigPath}`);

  const temporaryPath = `${paths.systemdConfigPath}.tmp`;
  let committed = false;
  try {
    await input.fs.writeFile(temporaryPath, [
      `APPROVED_OUTPUT_ROOT=${paths.approvedOutputRoot}`,
      `INSTALL_ROOT=${paths.installRoot}`,
      `SELECTION_PATH=${paths.selectionPath}`,
      '',
    ].join('\n'));
    await input.fs.fsyncFile(temporaryPath);
    await input.fs.renameReplace(temporaryPath, paths.systemdConfigPath);
    committed = true;
    await input.fs.fsyncDirectory(posix.dirname(paths.systemdConfigPath));
  } finally {
    if (!committed) await input.fs.remove(temporaryPath).catch(() => undefined);
  }
  return paths;
}

export interface ProductionConfigureInput {
  readonly approvedRoot: string;
  readonly repositoryPath: string;
}

export interface ProductionConfigureResult {
  readonly approvedOutputRoot: string;
  readonly repositoryPath: string;
  readonly configPath: string;
  readonly authorityPath: string;
  readonly versionRoot: string;
}

export interface SelectedInstallation {
  readonly versionRoot: string;
  readonly lockPath: string;
  readonly executionVersionRoot?: string;
}

export interface ConfigureCliDependencies {
  readonly configure: (input: ProductionConfigureInput) => Promise<ProductionConfigureResult>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

async function syncPath(path: string): Promise<void> {
  const closeOnExec = Number(Reflect.get(fsConstants, 'O_CLOEXEC') ?? 0);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | closeOnExec);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  directory: HeldDirectoryAuthority,
  name: string,
  contents: string | Uint8Array,
  mode: number,
): Promise<void> {
  if (
    directory.executionPath === undefined
    || name.length < 1
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    throw new Error('atomic write requires a held final directory and safe file name');
  }
  const path = join(directory.executionPath, name);
  const temporary = join(directory.executionPath, `${name}.tmp`);
  await rm(temporary, { force: true });
  await writeFile(temporary, contents, { flag: 'wx', mode });
  await syncPath(temporary);
  await rename(temporary, path);
  await chmod(path, mode);
  await directory.sync();
  await directory.revalidate();
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly contents?: Uint8Array;
  readonly mode?: number;
}

interface SnapshotHooks {
  readonly afterOpen?: (context: Readonly<{ name: string; path: string }>) => Promise<void> | void;
  readonly afterRead?: (context: Readonly<{ name: string; path: string }>) => Promise<void> | void;
}

async function snapshotFile(
  directory: HeldDirectoryAuthority,
  name: string,
  hooks: SnapshotHooks = {},
): Promise<FileSnapshot> {
  if (directory.executionPath === undefined) return Object.freeze({ exists: false });
  const path = join(directory.executionPath, name);
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | CLOSE_ON_EXEC);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return Object.freeze({ exists: false });
    }
    throw error;
  }
  let snapshot: FileSnapshot | undefined;
  let operationError: unknown;
  try {
    await hooks.afterOpen?.({ name, path });
    const initial = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!sameCurrentFileIdentity(initial, named)) {
      throw new Error(`cannot snapshot unsafe file ${name}`);
    }
    const contents = await handle.readFile();
    await hooks.afterRead?.({ name, path });
    const current = await handle.stat({ bigint: true });
    const currentNamed = await lstat(path, { bigint: true });
    if (!sameCurrentFileIdentity(initial, current) || !sameCurrentFileIdentity(current, currentNamed)) {
      throw new Error(`snapshotted file ${name} identity changed`);
    }
    snapshot = Object.freeze({
      exists: true,
      contents,
      mode: Number(initial.mode) & 0o7777,
    });
  } catch (error) {
    operationError = new Error(`snapshotted file ${name} identity validation failed`, { cause: error });
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError([operationError, closeError], `snapshot and descriptor close failed for ${name}`);
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  if (snapshot === undefined) throw new Error(`snapshot completed without evidence for ${name}`);
  return snapshot;
}

async function restoreFileSnapshot(
  directory: HeldDirectoryAuthority,
  name: string,
  snapshot: FileSnapshot,
): Promise<void> {
  if (directory.executionPath === undefined) throw new Error('file restore requires a held directory');
  const path = join(directory.executionPath, name);
  if (!snapshot.exists) {
    await rm(path, { force: true });
    await directory.sync();
    await directory.revalidate();
    return;
  }
  await atomicWrite(directory, name, snapshot.contents ?? new Uint8Array(), snapshot.mode ?? 0o600);
}

async function defaultServiceHealthCheck(expectedVersion: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:43120/api/health', {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (body.status !== 'ok' || body.version !== expectedVersion) {
        throw new Error('health endpoint reported the wrong service version');
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`new image builder service did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function acquireProductionConfigureLock(path: string): Promise<() => Promise<void>> {
  const scratch = await mkdtemp(join(tmpdir(), 'osi-image-builder-configure-lock-'));
  const helper = join(scratch, 'installer-fs-helper');
  let releaseNative: (() => Promise<void>) | undefined;
  try {
    await execFile('/usr/bin/gcc', [
      '-std=c17',
      '-D_GNU_SOURCE',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-o',
      helper,
      fileURLToPath(new URL('./installer-fs-helper.c', import.meta.url)),
    ], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        LANG: 'C',
        LC_ALL: 'C',
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    });
    releaseNative = await acquireInstallLock(helper, path);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (cause) {
      cleanupError = cause;
    }
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], 'configure lock acquisition and cleanup failed');
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const failures: unknown[] = [];
    try {
      await releaseNative?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'configure lock release failed');
  };
}

function systemdPath(path: string): string {
  if (/[\u0000-\u001f\u007f\r\n]/u.test(path)) throw new Error('systemd path contains control characters');
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function canonicalAuthorityPath(path: string, name: string): string {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) {
    throw new Error(`${name} must be a canonical absolute path`);
  }
  return path;
}

async function revalidateAuthorities(authorities: readonly HeldDirectoryAuthority[]): Promise<void> {
  for (const held of authorities) await held.revalidate();
}

async function closeAuthorities(authorities: readonly HeldDirectoryAuthority[]): Promise<void> {
  const results = await Promise.allSettled([...authorities].reverse().map((held) => held.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'configured directory authorities could not be closed');
  }
}

function serviceStateFromError(error: unknown): 'stopped' | 'uncertain' | undefined {
  if (error instanceof ConfigurationRollbackError) return error.serviceState;
  if (error instanceof Error) {
    const match = /service-state=(stopped|uncertain)/u.exec(error.message);
    if (match?.[1] === 'stopped' || match?.[1] === 'uncertain') return match[1];
  }
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const state = serviceStateFromError(cause);
      if (state !== undefined) return state;
    }
  }
  return undefined;
}

interface HeldOutputDirectories {
  readonly revalidate: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface HeldOutputDirectoryBinding {
  readonly handle: FileHandle;
  readonly initial: BigIntStats;
  readonly namedPath: () => string;
  readonly label: string;
}

function sameStableDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev;
}

function sameCurrentDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameStableDirectoryIdentity(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryObjectIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev;
}

function sameFileObjectIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev;
}

function sameCurrentFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileObjectIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function validateOutputDirectoryCandidate(
  metadata: BigIntStats,
  ownerUid: number,
  outputDevice: bigint,
  label: string,
): void {
  if (
    !metadata.isDirectory()
    || metadata.nlink < 1n
    || metadata.uid !== BigInt(ownerUid)
    || metadata.dev !== outputDevice
  ) {
    throw new Error(`${label} directory authority is unsafe`);
  }
}

function validateOutputDirectory(
  metadata: BigIntStats,
  ownerUid: number,
  outputDevice: bigint,
  label: string,
): void {
  validateOutputDirectoryCandidate(metadata, ownerUid, outputDevice, label);
  if (
    (Number(metadata.mode) & 0o7777) !== OUTPUT_DIRECTORY_MODE
  ) {
    throw new Error(`${label} directory authority is unsafe`);
  }
}

async function openOutputDirectory(
  parentExecutionPath: string,
  name: string,
  ownerUid: number,
  outputDevice: bigint,
  label: string,
): Promise<HeldOutputDirectoryBinding> {
  const path = join(parentExecutionPath, name);
  try {
    await mkdir(path, { mode: OUTPUT_DIRECTORY_MODE });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    const initial = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    validateOutputDirectoryCandidate(initial, ownerUid, outputDevice, label);
    validateOutputDirectoryCandidate(named, ownerUid, outputDevice, label);
    if (!sameCurrentDirectoryIdentity(initial, named)) {
      throw new Error(`${label} directory pathname identity changed`);
    }
    const initialMode = Number(initial.mode) & 0o7777;
    if (initialMode !== OUTPUT_DIRECTORY_MODE) {
      if (initialMode !== 0o700) throw new Error(`${label} directory authority is unsafe`);
      await handle.chmod(OUTPUT_DIRECTORY_MODE);
    }
    const normalized = await handle.stat({ bigint: true });
    const normalizedNamed = await lstat(path, { bigint: true });
    validateOutputDirectory(normalized, ownerUid, outputDevice, label);
    validateOutputDirectory(normalizedNamed, ownerUid, outputDevice, label);
    if (
      !sameDirectoryObjectIdentity(initial, normalized)
      || !sameCurrentDirectoryIdentity(normalized, normalizedNamed)
    ) {
      throw new Error(`${label} directory pathname identity changed`);
    }
    return Object.freeze({
      handle,
      initial: normalized,
      namedPath: () => path,
      label,
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function holdOutputDirectories(
  outputRoot: HeldDirectoryAuthority,
  ownerUid: number,
): Promise<HeldOutputDirectories> {
  await outputRoot.revalidate();
  const outputExecutionPath = outputRoot.executionPath;
  const outputIdentity = outputRoot.identityChain.at(-1);
  if (outputExecutionPath === undefined || outputIdentity === undefined) {
    throw new Error('approved output root authority is unavailable');
  }
  const bindings: HeldOutputDirectoryBinding[] = [];
  let closed = false;
  try {
    const work = await openOutputDirectory(
      outputExecutionPath,
      '.osi-image-builder',
      ownerUid,
      outputIdentity.dev,
      'output work root',
    );
    bindings.push(work);
    const workExecutionPath = `/proc/${process.pid}/fd/${work.handle.fd}`;
    const staging = await openOutputDirectory(
      workExecutionPath,
      'staging',
      ownerUid,
      outputIdentity.dev,
      'output staging root',
    );
    bindings.push(staging);
    const quarantine = await openOutputDirectory(
      workExecutionPath,
      'quarantine',
      ownerUid,
      outputIdentity.dev,
      'output quarantine root',
    );
    bindings.push(quarantine);

    const revalidate = async (): Promise<void> => {
      if (closed) throw new Error('output directory authorities are closed');
      await outputRoot.revalidate();
      for (const binding of bindings) {
        const held = await binding.handle.stat({ bigint: true });
        const named = await lstat(binding.namedPath(), { bigint: true });
        validateOutputDirectory(held, ownerUid, outputIdentity.dev, binding.label);
        if (
          !sameStableDirectoryIdentity(binding.initial, held)
          || !sameCurrentDirectoryIdentity(held, named)
        ) {
          throw new Error(`${binding.label} directory identity changed`);
        }
      }
    };
    await revalidate();
    return Object.freeze({
      revalidate,
      close: async (): Promise<void> => {
        if (closed) return;
        const results = await Promise.allSettled(
          [...bindings].reverse().map((binding) => binding.handle.close()),
        );
        closed = true;
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'output directory authorities could not be closed');
        }
      },
    });
  } catch (error) {
    const results = await Promise.allSettled(
      [...bindings].reverse().map((binding) => binding.handle.close()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        'output directory authority acquisition and close both failed',
      );
    }
    throw error;
  }
}

function renderUnit(
  name: (typeof UNIT_NAMES)[number],
  source: string,
  values: Readonly<{
    versionRoot: string;
    configRoot: string;
    stateRoot: string;
    repositoryPath: string;
    approvedRoot: string;
    configHome: string;
    stateHome: string;
    runtimeDir: string;
  }>,
): string {
  const apiExecutable = systemdPath(join(values.versionRoot, 'bin', 'osi-image-builder-api'));
  const runnerExecutable = systemdPath(join(values.versionRoot, 'bin', 'osi-image-builder-runner'));
  let result = source
    .replaceAll(
      '%h/.local/lib/osi-image-builder/selected/bin/osi-image-builder-api',
      apiExecutable,
    )
    .replaceAll(
      '%h/.local/lib/osi-image-builder/selected/bin/osi-image-builder-runner',
      runnerExecutable,
    )
    .replaceAll('@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@', systemdPath(values.versionRoot))
    .replaceAll('@OSI_IMAGE_BUILDER_XDG_CONFIG_HOME@', systemdPath(values.configHome))
    .replaceAll('@OSI_IMAGE_BUILDER_XDG_STATE_HOME@', systemdPath(values.stateHome))
    .replaceAll('@OSI_IMAGE_BUILDER_XDG_RUNTIME_DIR@', systemdPath(values.runtimeDir))
    .replaceAll('@OSI_IMAGE_BUILDER_STATE_ROOT@', systemdPath(values.stateRoot))
    .replaceAll('@OSI_IMAGE_BUILDER_CONFIG_ROOT@', systemdPath(values.configRoot))
    .replaceAll('@OSI_IMAGE_BUILDER_REPOSITORY_PATH@', systemdPath(values.repositoryPath))
    .replaceAll('@OSI_IMAGE_BUILDER_OUTPUT_ROOT_PATHS@', systemdPath(values.approvedRoot))
    .replaceAll(
      '@OSI_IMAGE_BUILDER_OUTPUT_WORK_ROOT_PATHS@',
      systemdPath(join(values.approvedRoot, '.osi-image-builder')),
    );
  if (
    result.includes('@OSI_IMAGE_BUILDER_')
    || result.includes('/osi-image-builder/selected/')
    || result.includes('%h/.local/lib/osi-image-builder/selected')
  ) {
    throw new Error(`systemd unit ${name} contains an unresolved installation placeholder`);
  }
  if (!result.endsWith('\n')) result += '\n';
  return result;
}

async function validateGitRepository(path: string): Promise<void> {
  const result = await execFile('/usr/bin/git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (String(result.stdout).trim() !== 'true') throw new Error('repository is not a Git worktree');
}

export async function loadSelectedInstallation(
  installRoot: string,
  selectionPath: string,
  executionInstallRoot: string = installRoot,
): Promise<SelectedInstallation> {
  const executionPrefix = `/proc/${process.pid}/fd/`;
  const executionParts = executionInstallRoot.startsWith(executionPrefix)
    ? executionInstallRoot.slice(executionPrefix.length).split('/')
    : [];
  if (
    executionInstallRoot !== installRoot
    && (
      !/^[1-9][0-9]*$/u.test(executionParts[0] ?? '')
      || executionParts.slice(1).some((component) => (
        component.length < 1
        || component === '.'
        || component === '..'
        || component.includes('\0')
      ))
    )
  ) {
    throw new Error('selected installation execution root is invalid');
  }
  const selectionText = await readFile(
    executionInstallRoot === installRoot
      ? selectionPath
      : join(executionInstallRoot, 'selected.json'),
    'utf8',
  );
  const selection = JSON.parse(selectionText) as Record<string, unknown>;
  const selectionKeys = [
    'executionDefinitionSha256',
    'lockSha256',
    'manifestSha256',
    'packageVersion',
    'publisherSha256',
  ];
  const selectionHashKeys = [
    'executionDefinitionSha256',
    'lockSha256',
    'manifestSha256',
    'publisherSha256',
  ];
  if (
    Object.keys(selection).sort().join(',') !== [...selectionKeys].sort().join(',')
    || typeof selection.packageVersion !== 'string'
    || !VERSION.test(selection.packageVersion)
    || selectionHashKeys.some((key) => (
      typeof selection[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(selection[key])
    ))
  ) {
    throw new Error('selected installation version is invalid');
  }
  const versionRoot = join(installRoot, selection.packageVersion);
  const executionVersionRoot = join(executionInstallRoot, selection.packageVersion);
  const lockPath = join(versionRoot, 'builder.lock.json');
  const lockText = await readFile(join(executionVersionRoot, 'builder.lock.json'), 'utf8');
  const lock = JSON.parse(lockText) as unknown;
  const lockValidation = validateBuilderLock(lock, selection.packageVersion);
  if (!lockValidation.ok) throw new Error(`selected builder lock is invalid: ${lockValidation.reason}`);
  if (
    createHash('sha256').update(lockText).digest('hex') !== selection.lockSha256
    || lockValidation.lock.publisherSha256 !== selection.publisherSha256
    || lockValidation.lock.executionDefinitionSha256 !== selection.executionDefinitionSha256
    || loadManifest(join(executionVersionRoot, 'manifest', 'targets.json')).sha256 !== selection.manifestSha256
  ) {
    throw new Error('selected installation evidence does not match the immutable version');
  }
  return Object.freeze({
    versionRoot,
    lockPath,
    ...(executionInstallRoot === installRoot ? {} : { executionVersionRoot }),
  });
}

export interface ProductionConfigureOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly withEffectiveHomeAuthority?: typeof withEffectiveHomeAuthority;
  readonly effectiveHomeOptions?: EffectiveHomeResolverOptions;
  readonly deriveSystemdBusEnvironment?: typeof deriveSystemdBusEnvironment;
  readonly output?: (line: string) => void;
  readonly runSystemctl?: (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly getSystemdUnitState?: (
    env: Readonly<Record<string, string>>,
  ) => Promise<SystemdUnitState>;
  readonly runSystemdStateCommand?: (
    verb: 'is-active' | 'is-enabled',
    env: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly checkServiceHealth?: (expectedVersion: string) => Promise<void>;
  readonly snapshotHooks?: SnapshotHooks;
  readonly acquireConfigureLock?: (path: string) => Promise<() => Promise<void>>;
}

export type SystemdUnitState =
  | Readonly<{ presence: 'absent' }>
  | Readonly<{ presence: 'present'; active: boolean; enabled: boolean }>;

interface ActivationFile {
  readonly directory: HeldDirectoryAuthority;
  readonly name: string;
  readonly snapshot: FileSnapshot;
}

interface ActivationState {
  readonly files: readonly ActivationFile[];
  readonly systemd: SystemdUnitState;
  readonly previousVersion?: string;
}

class ConfigurationRollbackError extends AggregateError {
  readonly serviceState: 'stopped' | 'uncertain';

  constructor(errors: readonly unknown[], serviceState: 'stopped' | 'uncertain') {
    super(errors, `configuration rollback failed; service-state=${serviceState}`);
    this.name = 'ConfigurationRollbackError';
    this.serviceState = serviceState;
  }
}

async function defaultSystemdUnitState(
  env: Readonly<Record<string, string>>,
  runStateCommand?: ProductionConfigureOptions['runSystemdStateCommand'],
): Promise<SystemdUnitState> {
  const check = async (verb: 'is-active' | 'is-enabled'): Promise<boolean | 'absent'> => {
    try {
      if (runStateCommand !== undefined) {
        await runStateCommand(verb, env);
      } else {
        await execFile('/usr/bin/systemctl', ['--user', verb, '--quiet', 'osi-image-builder.service'], {
          env,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 16 * 1024,
          windowsHide: true,
          shell: false,
        });
      }
      return true;
    } catch (error) {
      const exitCode = error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'number'
        ? error.code
        : undefined;
      if ((verb === 'is-active' && exitCode === 3) || (verb === 'is-enabled' && exitCode === 1)) {
        return false;
      }
      if (exitCode === 4) return 'absent';
      throw new Error(`could not determine prior systemd ${verb} state`, { cause: error });
    }
  };
  const active = await check('is-active');
  const enabled = await check('is-enabled');
  if (active === 'absent' || enabled === 'absent') {
    if (active !== 'absent' || enabled !== 'absent') {
      throw new Error('prior systemd unit presence probes disagree');
    }
    return Object.freeze({ presence: 'absent' });
  }
  return Object.freeze({ presence: 'present', active, enabled });
}

async function rollbackActivation(
  activation: ActivationState,
  daemonReloadAttempted: boolean,
  runSystemctl: (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<void>,
  env: Readonly<Record<string, string>>,
  checkServiceHealth: (expectedVersion: string) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  let serviceState: 'stopped' | 'uncertain' = 'uncertain';
  const attempt = async (operation: () => Promise<void>): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error) {
      failures.push(error);
      return false;
    }
  };

  if (await attempt(() => runSystemctl(['--user', 'stop', 'osi-image-builder.service'], env))) {
    serviceState = 'stopped';
  }
  for (const file of [...activation.files].reverse()) {
    await attempt(() => restoreFileSnapshot(file.directory, file.name, file.snapshot));
  }
  if (daemonReloadAttempted && failures.length === 0) {
    await attempt(() => runSystemctl(['--user', 'daemon-reload'], env));
  }
  if (failures.length === 0 && activation.systemd.presence === 'present') {
    const previousSystemd = activation.systemd;
    if (previousSystemd.active) {
      serviceState = 'uncertain';
      await attempt(() => runSystemctl(['--user', 'restart', 'osi-image-builder.service'], env));
      if (failures.length === 0) {
        await attempt(() => checkServiceHealth(activation.previousVersion ?? ''));
      }
    }
    if (failures.length === 0) {
      await attempt(() => previousSystemd.enabled
        ? runSystemctl(['--user', 'enable', 'osi-image-builder.service'], env)
        : runSystemctl(['--user', 'disable', 'osi-image-builder.service'], env));
    }
  }
  if (failures.length > 0) {
    if (serviceState !== 'stopped') {
      try {
        await runSystemctl(['--user', 'stop', 'osi-image-builder.service'], env);
        serviceState = 'stopped';
      } catch (error) {
        failures.push(error);
      }
    }
    throw new ConfigurationRollbackError(failures, serviceState);
  }
}

function previousServiceVersion(
  installRoot: string,
  serviceUnit: FileSnapshot,
): string | undefined {
  if (!serviceUnit.exists || serviceUnit.contents === undefined) return undefined;
  const source = Buffer.from(serviceUnit.contents).toString('utf8');
  const candidates = new Set<string>();
  const pattern = /(?<version>v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)(?=\/bin\/osi-image-builder-api)/gu;
  for (const match of source.matchAll(pattern)) {
    if (match.groups?.version !== undefined) candidates.add(match.groups.version);
  }
  const exact = [...candidates].filter((version) => source.split('\n').includes(
    `ExecStart=${systemdPath(join(installRoot, version, 'bin', 'osi-image-builder-api'))}`,
  ));
  return exact.length === 1 ? exact[0] : undefined;
}

async function configureProductionWithHome(
  input: ProductionConfigureInput,
  options: Readonly<ProductionConfigureOptions>,
  authority: EffectiveHomeAuthority,
): Promise<ProductionConfigureResult> {
  const home = authority.path;
  const approvedOutputRoot = canonicalAuthorityPath(input.approvedRoot, 'approved output root');
  const repositoryPath = canonicalAuthorityPath(input.repositoryPath, 'repository');
  const installRoot = join(home, '.local', 'lib', 'osi-image-builder');
  const installParentRoot = dirname(installRoot);
  const selectionPath = join(installRoot, 'selected.json');
  const directories = resolveConfigDirectories({ ...options.env, HOME: home });
  const configPath = join(directories.configRoot, 'config.json');
  const authorityPath = join(installRoot, 'configured-authorities.json');
  const configHome = dirname(directories.configRoot);
  const stateHome = dirname(directories.stateRoot);
  const userUnitRoot = join(configHome, 'systemd', 'user');
  validateAuthorityTopology({
    configRoot: directories.configRoot,
    stateRoot: directories.stateRoot,
    installRoot,
    repositoryPath,
    approvedOutputRoots: [{ id: 'release', path: approvedOutputRoot }],
  });
  const ownerUid = authority.ownerUid;
  const held: HeldDirectoryAuthority[] = [];
  let outputDirectories: HeldOutputDirectories | undefined;
  let activation: ActivationState | undefined;
  let configurationMutationStarted = false;
  let daemonReloadAttempted = false;
  let systemdEnv: Readonly<Record<string, string>> | undefined;
  let runSystemctl: ProductionConfigureOptions['runSystemctl'];
  let releaseConfigureLock: (() => Promise<void>) | undefined;
  let operationError: unknown;
  let result: ProductionConfigureResult | undefined;
  const deriveSystemdBus = options.deriveSystemdBusEnvironment ?? deriveSystemdBusEnvironment;
  try {
    const installParent = await holdDirectoryAuthority(installParentRoot, {
      ownerUid,
      finalAccess: 'write',
    });
    held.push(installParent);
    if (installParent.executionPath === undefined) {
      throw new Error('required installation parent authority is unavailable');
    }
    releaseConfigureLock = await (options.acquireConfigureLock ?? acquireProductionConfigureLock)(
      join(installParent.executionPath, INSTALL_LOCK_NAME),
    );
    await installParent.revalidate();
    const install = await holdDirectoryAuthority(installRoot, {
      ownerUid,
      finalAccess: 'write',
    });
    held.push(install);
    const config = await holdDirectoryAuthority(directories.configRoot, {
      ownerUid,
      allowMissing: true,
      finalAccess: 'write',
    });
    held.push(config);
    const state = await holdDirectoryAuthority(directories.stateRoot, {
      ownerUid,
      allowMissing: true,
      finalAccess: 'write',
    });
    held.push(state);
    const units = await holdDirectoryAuthority(userUnitRoot, {
      ownerUid,
      allowMissing: true,
      finalAccess: 'write',
    });
    held.push(units);
    const repository = await holdDirectoryAuthority(repositoryPath, {
      ownerUid,
      finalAccess: 'read',
    });
    held.push(repository);
    const outputRoot = await holdDirectoryAuthority(approvedOutputRoot, {
      ownerUid,
      finalAccess: 'write',
    });
    held.push(outputRoot);
    const topology: HeldAuthorityTopologyEntry[] = [
      { name: 'installRoot', path: installRoot, authority: install },
      { name: 'configRoot', path: directories.configRoot, authority: config },
      { name: 'stateRoot', path: directories.stateRoot, authority: state },
      { name: 'userUnitRoot', path: userUnitRoot, authority: units },
      { name: 'repositoryPath', path: repositoryPath, authority: repository },
      { name: 'approvedOutputRoot', path: approvedOutputRoot, authority: outputRoot },
    ];
    assertHeldAuthoritiesDisjoint(topology);
    await revalidateAuthorities(held);
    if (install.executionPath === undefined || repository.executionPath === undefined) {
      throw new Error('required configured directory authority is unavailable');
    }
    const { versionRoot, lockPath, executionVersionRoot = versionRoot } = await loadSelectedInstallation(
      installRoot,
      selectionPath,
      install.executionPath,
    );
    await validateGitRepository(repository.executionPath);
    const renderedBus = await deriveSystemdBus({ uid: ownerUid });
    const renderedUnits = await Promise.all(UNIT_NAMES.map(async (name) => {
      const source = await readFile(join(executionVersionRoot, 'systemd', name), 'utf8');
      return Object.freeze({
        name,
        rendered: renderUnit(name, source, {
          versionRoot,
          configRoot: directories.configRoot,
          stateRoot: directories.stateRoot,
          repositoryPath,
          approvedRoot: approvedOutputRoot,
          configHome,
          stateHome,
          runtimeDir: renderedBus.XDG_RUNTIME_DIR,
        }),
      });
    }));
    await revalidateAuthorities(held);
    systemdEnv = Object.freeze({
      PATH: '/usr/bin:/bin',
      HOME: home,
      LANG: 'C',
      LC_ALL: 'C',
      ...renderedBus,
    });
    runSystemctl = options.runSystemctl ?? (async (argv, env) => {
      await execFile('/usr/bin/systemctl', [...argv], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        shell: false,
      });
    });
    const getSystemdUnitState = options.getSystemdUnitState
      ?? (options.runSystemctl === undefined || options.runSystemdStateCommand !== undefined
        ? (env) => defaultSystemdUnitState(env, options.runSystemdStateCommand)
        : async () => ({ presence: 'absent' } as const));
    const output = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
    for (const line of [
      `approvedOutputRoot=${approvedOutputRoot}`,
      `repositoryPath=${repositoryPath}`,
      `configPath=${configPath}`,
      `authorityPath=${authorityPath}`,
      `versionRoot=${versionRoot}`,
      `stateRoot=${directories.stateRoot}`,
      `userUnitRoot=${userUnitRoot}`,
    ]) output(line);

    await revalidateAuthorities(held);
    const systemd = await getSystemdUnitState(systemdEnv);
    const activationFiles = Object.freeze(await Promise.all([
        { directory: install, name: 'configured-authorities.json' },
        { directory: config, name: 'config.json' },
        ...UNIT_NAMES.map((name) => ({ directory: units, name })),
        { directory: units, name: LEGACY_CLEANUP_UNIT },
      ].map(async (file) => Object.freeze({
        ...file,
        snapshot: await snapshotFile(file.directory, file.name, options.snapshotHooks),
      }))));
    const serviceUnit = activationFiles.find((file) => file.name === 'osi-image-builder.service')?.snapshot;
    const previousVersion = serviceUnit === undefined ? undefined : previousServiceVersion(installRoot, serviceUnit);
    if (systemd.presence === 'present' && systemd.active && previousVersion === undefined) {
      throw new Error('active prior systemd unit does not identify one installed package version');
    }
    activation = Object.freeze({
      files: activationFiles,
      systemd,
      ...(previousVersion === undefined ? {} : { previousVersion }),
    });
    await config.ensure();
    await state.ensure();
    await units.ensure();
    if (units.executionPath === undefined) {
      throw new Error('systemd user unit directory authority is unavailable');
    }
    outputDirectories = await holdOutputDirectories(outputRoot, ownerUid);
    configurationMutationStarted = true;
    await rm(join(units.executionPath, LEGACY_CLEANUP_UNIT), { force: true });
    await units.sync();
    await units.revalidate();
    await revalidateAuthorities(held);
    assertHeldAuthoritiesDisjoint(topology);
    await atomicWrite(install, 'configured-authorities.json', `${JSON.stringify({
      schemaVersion: 1,
      configRoot: directories.configRoot,
      stateRoot: directories.stateRoot,
    })}\n`, 0o600);
    await atomicWrite(config, 'config.json', `${JSON.stringify({
      repositoryPath,
      approvedOutputRoots: [{
        id: 'release',
        label: 'Firmware images',
        path: approvedOutputRoot,
      }],
      builderLockPath: lockPath,
    })}\n`, 0o600);
    for (const unit of renderedUnits) {
      await atomicWrite(units, unit.name, unit.rendered, 0o600);
    }
    await revalidateAuthorities(held);
    await outputDirectories.revalidate();
    const bus = await deriveSystemdBus({ uid: ownerUid });
    if (
      bus.XDG_RUNTIME_DIR !== renderedBus.XDG_RUNTIME_DIR
      || bus.DBUS_SESSION_BUS_ADDRESS !== renderedBus.DBUS_SESSION_BUS_ADDRESS
    ) {
      throw new Error('systemd user bus authority changed while configuring units');
    }
    daemonReloadAttempted = true;
    await runSystemctl(['--user', 'daemon-reload'], systemdEnv);
    await revalidateAuthorities(held);
    await outputDirectories.revalidate();
    const restartBus = await deriveSystemdBus({ uid: ownerUid });
    if (
      restartBus.XDG_RUNTIME_DIR !== renderedBus.XDG_RUNTIME_DIR
      || restartBus.DBUS_SESSION_BUS_ADDRESS !== renderedBus.DBUS_SESSION_BUS_ADDRESS
    ) {
      throw new Error('systemd user bus authority changed while configuring units');
    }
    await runSystemctl(['--user', 'restart', 'osi-image-builder.service'], systemdEnv);
    await (options.checkServiceHealth ?? (options.runSystemctl === undefined
      ? defaultServiceHealthCheck
      : async () => undefined))(basename(versionRoot));
    await revalidateAuthorities(held);
    await outputDirectories.revalidate();
    await runSystemctl(['--user', 'enable', 'osi-image-builder.service'], systemdEnv);
    await revalidateAuthorities(held);
    await outputDirectories.revalidate();
    result = Object.freeze({
      approvedOutputRoot,
      repositoryPath,
      configPath,
      authorityPath,
      versionRoot,
    });
  } catch (error) {
    if (activation !== undefined && configurationMutationStarted) {
      try {
        if (runSystemctl === undefined || systemdEnv === undefined) throw new Error('activation rollback authority is unavailable');
        const checkServiceHealth = options.checkServiceHealth ?? (options.runSystemctl === undefined
          ? defaultServiceHealthCheck
          : async () => undefined);
        await rollbackActivation(
          activation,
          daemonReloadAttempted,
          runSystemctl,
          systemdEnv,
          checkServiceHealth,
        );
      } catch (rollbackError) {
        const serviceState = rollbackError instanceof ConfigurationRollbackError
          ? rollbackError.serviceState
          : 'uncertain';
        const primaryDetail = boundedPrimaryDetail(error);
        operationError = new AggregateError(
          [error, rollbackError],
          `configuration activation and rollback failed; service-state=${serviceState}${primaryDetail === undefined ? '' : `: ${primaryDetail}`}`,
        );
      }
    }
    operationError ??= error;
  }

  if (releaseConfigureLock !== undefined) {
    try {
      await releaseConfigureLock();
    } catch (error) {
      operationError = operationError === undefined
        ? error
        : new AggregateError([operationError, error], 'configuration and configure-lock release failed');
    }
  }

  const completionErrors: unknown[] = [];
  if (operationError !== undefined) completionErrors.push(operationError);
  try {
    await outputDirectories?.revalidate();
  } catch (error) {
    completionErrors.push(error);
  }
  for (const authority of held) {
    try {
      await authority.revalidate();
    } catch (error) {
      completionErrors.push(error);
    }
  }
  try {
    await outputDirectories?.close();
  } catch (error) {
    completionErrors.push(error);
  }
  try {
    await closeAuthorities(held);
  } catch (error) {
    completionErrors.push(error);
  }
  if (completionErrors.length === 1) throw completionErrors[0];
  if (completionErrors.length > 1) {
    const serviceState = completionErrors
      .map(serviceStateFromError)
      .find((state) => state !== undefined);
    const primaryDetail = boundedPrimaryDetail(completionErrors[0]);
    throw new AggregateError(
      completionErrors,
      `configuration failed with activation or authority cleanup errors${serviceState === undefined ? '' : `; service-state=${serviceState}`}${primaryDetail === undefined ? '' : `: ${primaryDetail}`}`,
    );
  }
  if (result === undefined) throw new Error('configuration completed without a result');
  return result;
}

export async function configureProductionInstaller(
  input: ProductionConfigureInput,
  options: Readonly<ProductionConfigureOptions> = {},
): Promise<ProductionConfigureResult> {
  return (options.withEffectiveHomeAuthority ?? withEffectiveHomeAuthority)(
    options.effectiveHomeOptions,
    async (authority) => configureProductionWithHome(input, options, authority),
  );
}

function parseConfigureArguments(argv: readonly string[]): ProductionConfigureInput | null {
  if (
    argv.length !== 4
    || argv[0] !== '--approved-root'
    || argv[2] !== '--repository'
    || !argv[1]?.startsWith('/')
    || !argv[3]?.startsWith('/')
  ) {
    return null;
  }
  return Object.freeze({ approvedRoot: argv[1], repositoryPath: argv[3] });
}

function errorDetails(error: unknown): readonly string[] {
  const details: string[] = [];
  const seen = new Set<unknown>();
  const visit = (cause: unknown, depth: number): void => {
    if (details.length >= 8 || depth > 4 || seen.has(cause)) return;
    if (cause !== null && (typeof cause === 'object' || typeof cause === 'function')) seen.add(cause);
    const message = cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);
    const singleLine = message.replace(/[\r\n\t]+/gu, ' ').trim();
    if (singleLine.length > 0 && !details.includes(singleLine)) details.push(singleLine);
    if (cause instanceof AggregateError) {
      for (const nested of cause.errors) visit(nested, depth + 1);
    } else if (cause instanceof Error && cause.cause !== undefined) {
      visit(cause.cause, depth + 1);
    }
  };
  visit(error, 0);
  return details;
}

function boundedPrimaryDetail(error: unknown): string | undefined {
  const detail = errorDetails(error).at(0);
  if (detail === undefined) return undefined;
  return truncateUtf8(detail, 256);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + codePointBytes > maximumBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

function boundedError(error: unknown): string {
  const singleLine = errorDetails(error).join(' | caused-by: ') || 'unknown configuration failure';
  const prefix = 'configuration failed: ';
  const available = MAX_ERROR_BYTES - Buffer.byteLength(prefix, 'utf8') - 1;
  return `${prefix}${truncateUtf8(singleLine, available)}\n`;
}

export async function runConfigureCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: Partial<ConfigureCliDependencies> = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  const input = parseConfigureArguments(argv);
  if (input === null) {
    writeStderr('configuration requires --approved-root <absolute> --repository <absolute>\n');
    return 2;
  }
  try {
    const result = await (dependencies.configure ?? configureProductionInstaller)(input);
    writeStdout(`${JSON.stringify({ available: true, ...result })}\n`);
    return 0;
  } catch (error) {
    writeStderr(boundedError(error));
    return 1;
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  void runConfigureCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(boundedError(error));
    process.exitCode = 1;
  });
}
