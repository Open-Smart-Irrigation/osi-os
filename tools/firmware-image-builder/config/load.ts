import { execFile as execFileCallback } from 'node:child_process';
import { access, lstat, mkdir, open, readFile, readlink, realpath, rmdir, statfs } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_BUILDER_LOCK_FILE,
  DEFAULT_MAX_QUEUE_LENGTH,
  DEFAULT_REMOTE,
  isAbsolutePath,
  MIN_DISK_FREE_BYTES,
  resolveConfigDirectories,
  type ConfigDirectories,
} from './defaults.js';

const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const BUILDER_VERSION_PATTERN = /^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/;
const TRUSTED_GIT_EXECUTABLE = '/usr/bin/git';
const GIT_PROBE_TIMEOUT_MS = 5_000;
const GIT_PROBE_MAX_BUFFER_BYTES = 64 * 1024;
const SAFE_GIT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
} as const;

export type ConfigErrorCode =
  | 'CONFIG_FILE_INVALID'
  | 'REPOSITORY_PATH_NOT_ABSOLUTE'
  | 'ORIGIN_NOT_SSH'
  | 'OUTPUT_ROOTS_INVALID'
  | 'OUTPUT_ROOT_ID_INVALID'
  | 'OUTPUT_ROOT_ID_DUPLICATE'
  | 'OUTPUT_ROOT_PATH_NOT_ABSOLUTE'
  | 'OUTPUT_ROOT_SYMLINK'
  | 'OUTPUT_ROOT_NOT_FOUND'
  | 'OUTPUT_ROOT_NOT_DIRECTORY'
  | 'OUTPUT_ROOT_BLOCK_DEVICE'
  | 'OUTPUT_ROOT_NOT_WRITABLE'
  | 'OUTPUT_ROOT_CANONICALIZE_FAILED'
  | 'OUTPUT_ROOT_SPACE_CHECK_FAILED'
  | 'PREFLIGHT_DISK_SPACE'
  | 'MAX_QUEUE_INVALID'
  | 'DISK_THRESHOLD_INVALID'
  | 'BUILDER_LOCK_PATH_INVALID'
  | 'OUTPUT_ROOT_ID_UNKNOWN'
  | 'OUTPUT_PATH_NOT_ALLOWED'
  | 'OUTPUT_ROOT_OVERLAP'
  | 'OUTPUT_ROOT_OWNER'
  | 'OUTPUT_ROOT_MODE'
  | 'STATE_ROOT_OWNER'
  | 'STATE_ROOT_MODE'
  | 'STATE_ROOT_NOT_FOUND'
  | 'STATE_ROOT_CREATE_FAILED';

export class ConfigValidationError extends Error {
  readonly code: ConfigErrorCode;
  readonly field?: string;

  constructor(code: ConfigErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ConfigValidationError';
    this.code = code;
    this.field = field;
  }
}

export interface ConfigFile {
  readonly repositoryPath: string;
  readonly approvedOutputRoots: readonly ApprovedOutputRootInput[];
  readonly builderLockPath: string;
  readonly maxQueueLength?: number;
  readonly diskFreeMinimumBytes?: number;
}

export interface ApprovedOutputRootInput {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface ApprovedOutputRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly quarantinePath: string;
}

export interface ApprovedRootRegistry {
  readonly __opaqueApprovedRootRegistry: unique symbol;
}

export interface StateRootAuthority {
  readonly __opaqueStateRootAuthority: unique symbol;
}

export interface PathAuthorities {
  readonly approvedRoots: ApprovedRootRegistry;
  readonly stateRoot: StateRootAuthority;
}

export interface PathAuthorityDependencies {
  readonly close: (handle: FileHandle) => Promise<void>;
  readonly stat: (handle: FileHandle) => Promise<Stats>;
  readonly statBigInt: (handle: FileHandle) => Promise<BigIntStats>;
  readonly readlink: (path: string) => Promise<string>;
  readonly mountId: (handle: FileHandle) => Promise<number>;
  readonly beforeRead: (handle: FileHandle) => Promise<void>;
}

interface AuthorityRootRecord {
  readonly id: string;
  readonly path: string;
  readonly quarantinePath: string;
  readonly device: number;
  readonly inode: number;
}

interface AuthorityStateRecord {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface AuthorityData {
  readonly roots: ReadonlyMap<string, AuthorityRootRecord>;
  readonly state: AuthorityStateRecord;
  readonly dependencies: PathAuthorityDependencies;
}

const authorityBrand = new WeakSet<object>();
const authorityData = new WeakMap<object, AuthorityData>();
const stateAuthorityBrand = new WeakSet<object>();
const defaultPathAuthorityDependencies: PathAuthorityDependencies = Object.freeze({
  close: async (handle: FileHandle) => handle.close(),
  stat: async (handle: FileHandle) => handle.stat(),
  statBigInt: async (handle: FileHandle) => handle.stat({ bigint: true }),
  readlink,
  mountId: async (handle: FileHandle) => {
    if (process.platform !== 'linux') throw new Error('Linux fdinfo mount IDs are unavailable');
    const contents = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const match = contents.match(/^mnt_id:\s*(\d+)\s*$/m);
    if (!match) throw new Error('Linux fdinfo mount ID is malformed');
    const mountId = Number(match[1]);
    if (!Number.isSafeInteger(mountId) || mountId < 0) throw new Error('Linux fdinfo mount ID is invalid');
    return mountId;
  },
  beforeRead: async () => undefined,
});

export interface BuilderConfig {
  readonly repository: {
    readonly path: string;
    readonly remote: typeof DEFAULT_REMOTE;
  };
  readonly approvedOutputRoots: readonly ApprovedOutputRoot[];
  readonly builderLockPath: string;
  readonly maxQueueLength: number;
  readonly diskFreeMinimumBytes: number;
}

export interface RedactedConfig {
  readonly repository: BuilderConfig['repository'];
  readonly approvedOutputRoots: readonly ApprovedOutputRoot[];
  readonly builderLockPath: string;
  readonly maxQueueLength: number;
  readonly diskFreeMinimumBytes: number;
}

export interface LoadedConfig {
  readonly config: BuilderConfig;
  readonly redacted: RedactedConfig;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly pathAuthorities: PathAuthorities;
}

export interface StatFsResult {
  readonly bavail: number;
  readonly bsize: number;
}

export interface ConfigLoadOptions {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly git?: GitOriginProbe;
  readonly rootFs?: Partial<RootFileSystem>;
  readonly pathAuthorityDependencies?: Partial<PathAuthorityDependencies>;
}

export interface RootStats {
  readonly isSymbolicLink: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isBlockDevice: () => boolean;
  readonly uid: number;
  readonly mode: number;
}

export interface RootFileSystem {
  readonly lstat: (path: string) => Promise<RootStats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly access: (path: string, mode: number) => Promise<void>;
  readonly statfs: (path: string) => Promise<StatFsResult>;
}

export interface GitOriginProbe {
  readonly getOriginUrl: (repositoryPath: string, remote: typeof DEFAULT_REMOTE) => Promise<string>;
}

export interface RootValidationOptions {
  readonly rootFs?: Partial<RootFileSystem>;
  readonly minimumFreeBytes?: number;
}

const execFile = promisify(execFileCallback);

export class ConfigAuthorityError extends Error {
  readonly code?: ConfigErrorCode;

  constructor(message: string, options?: ErrorOptions, code?: ConfigErrorCode) {
    super(message, options);
    this.name = 'ConfigAuthorityError';
    this.code = code;
  }
}

type RootSnapshot = Readonly<AuthorityRootRecord>;
type StateSnapshot = Readonly<AuthorityStateRecord>;
type AuthorityContext = Readonly<{ snapshot: RootSnapshot; dependencies: PathAuthorityDependencies }>;
type StateAuthorityContext = Readonly<{ snapshot: StateSnapshot; dependencies: PathAuthorityDependencies }>;

function authorityReject(message: string, cause?: unknown, code?: ConfigErrorCode): never {
  throw new ConfigAuthorityError(message, cause === undefined ? undefined : { cause }, code);
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}

type DirectoryPolicy = 'output' | 'state';

function validateDirectoryPolicy(stats: Pick<RootStats, 'uid' | 'mode'>, field: string, policy: DirectoryPolicy, fail: (message: string, code: ConfigErrorCode) => never): void {
  const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
  if (expectedUid === undefined || stats.uid !== expectedUid) fail(`${field} must be owned by the effective user`, policy === 'state' ? 'STATE_ROOT_OWNER' : 'OUTPUT_ROOT_OWNER');
  const permissions = stats.mode & 0o777;
  const valid = policy === 'state'
    ? permissions === 0o700
    : (permissions & 0o700) === 0o700 && (permissions & 0o022) === 0;
  if (!valid) fail(`${field} has an insecure mode`, policy === 'state' ? 'STATE_ROOT_MODE' : 'OUTPUT_ROOT_MODE');
}

async function inspectAuthorityDirectory(path: string, field: string, policy: DirectoryPolicy): Promise<{ path: string; device: number; inode: number }> {
  let stats;
  try { stats = await lstat(path); } catch (error) { return authorityReject(`${field} cannot be inspected`, error); }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return authorityReject(`${field} must be a non-symlink directory`);
  validateDirectoryPolicy(stats, field, policy, (message, code) => authorityReject(message, undefined, code));
  let canonical: string;
  try {
    canonical = await realpath(path);
    await access(canonical, fsConstants.W_OK);
  } catch (error) { return authorityReject(`${field} is not canonical and writable`, error); }
  if (canonical !== resolve(path)) return authorityReject(`${field} resolves through a symlink`);
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | (typeof (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC === 'number' ? (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC! : 0);
  let handle: FileHandle;
  try { handle = await open(canonical, flags); } catch (error) { return authorityReject(`${field} could not be opened no-follow`, error); }
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || held.dev !== stats.dev || held.ino !== stats.ino) return authorityReject(`${field} identity changed while opening`);
    validateDirectoryPolicy(held, field, policy, (message, code) => authorityReject(message, undefined, code));
  } finally {
    await handle.close();
  }
  return { path: canonical, device: stats.dev, inode: stats.ino };
}

async function issuePathAuthorities(
  roots: readonly ApprovedOutputRoot[],
  statePath: string,
  repositoryPath: string,
  dependencies: PathAuthorityDependencies,
): Promise<PathAuthorities> {
  const inspectedRoots: Array<AuthorityRootRecord> = [];
  const ids = new Set<string>();
  for (const root of roots) {
    if (ids.has(root.id)) return authorityReject(`duplicate approved root ID: ${root.id}`);
    ids.add(root.id);
    const inspected = await inspectAuthorityDirectory(root.path, `approved root ${root.id}`, 'output');
    if (inspectedRoots.some((candidate) => pathsOverlap(candidate.path, inspected.path))) return authorityReject('approved roots may not overlap', undefined, 'OUTPUT_ROOT_OVERLAP');
    inspectedRoots.push({ id: root.id, path: inspected.path, quarantinePath: join(inspected.path, '.osi-image-builder', 'quarantine'), device: inspected.device, inode: inspected.inode });
  }
  const state = await inspectAuthorityDirectory(statePath, 'state root', 'state');
  const repository = await inspectAuthorityDirectory(repositoryPath, 'repository/work root', 'output');
  if (inspectedRoots.some((root) => pathsOverlap(root.path, state.path) || pathsOverlap(root.path, repository.path))) return authorityReject('approved root overlaps a protected state/work root', undefined, 'OUTPUT_ROOT_OVERLAP');
  if (pathsOverlap(state.path, repository.path)) return authorityReject('state and work roots may not overlap', undefined, 'OUTPUT_ROOT_OVERLAP');

  const registry = Object.freeze({}) as ApprovedRootRegistry;
  const stateAuthority = Object.freeze({}) as StateRootAuthority;
  authorityBrand.add(registry);
  stateAuthorityBrand.add(stateAuthority);
  authorityData.set(registry, { roots: new Map(inspectedRoots.map((root) => [root.id, Object.freeze(root)])), state: Object.freeze(state), dependencies });
  authorityData.set(stateAuthority, { roots: new Map(), state: Object.freeze(state), dependencies });
  return Object.freeze({ approvedRoots: registry, stateRoot: stateAuthority });
}

function authorityLookup(registry: ApprovedRootRegistry, rootId: string): AuthorityData {
  if (!registry || typeof registry !== 'object' || !authorityBrand.has(registry)) return authorityReject('approved root authority was not issued by config');
  if (typeof rootId !== 'string' || !ROOT_ID_PATTERN.test(rootId)) return authorityReject('root ID is not canonical');
  const data = authorityData.get(registry);
  if (!data || !data.roots.has(rootId)) return authorityReject('unknown approved root ID');
  return data;
}

function stateAuthorityLookup(stateRoot: StateRootAuthority): AuthorityData {
  if (!stateRoot || typeof stateRoot !== 'object' || !stateAuthorityBrand.has(stateRoot)) return authorityReject('state root authority was not issued by config');
  const data = authorityData.get(stateRoot);
  if (!data) return authorityReject('state root authority is unavailable');
  return data;
}

export async function withApprovedRootSnapshot<T>(registry: ApprovedRootRegistry, rootId: string, callback: (context: AuthorityContext) => Promise<T>): Promise<T> {
  const data = authorityLookup(registry, rootId);
  const record = data.roots.get(rootId)!;
  const current = await inspectAuthorityDirectory(record.path, 'approved root', 'output');
  if (current.path !== record.path || current.device !== record.device || current.inode !== record.inode) return authorityReject('approved root identity changed');
  return callback({ snapshot: record, dependencies: data.dependencies });
}

export async function withStateRootSnapshot<T>(stateRoot: StateRootAuthority, callback: (context: StateAuthorityContext) => Promise<T>): Promise<T> {
  const data = stateAuthorityLookup(stateRoot);
  const current = await inspectAuthorityDirectory(data.state.path, 'state root', 'state');
  if (current.path !== data.state.path || current.device !== data.state.device || current.inode !== data.state.inode) return authorityReject('state root identity changed');
  return callback({ snapshot: data.state, dependencies: data.dependencies });
}

const defaultGitOriginProbe: GitOriginProbe = {
  async getOriginUrl(repositoryPath, remote) {
    const result = await execFile(
      TRUSTED_GIT_EXECUTABLE,
      ['config', '--local', '--no-includes', '--null', '--get-all', `remote.${remote}.url`],
      {
        cwd: repositoryPath,
        encoding: 'utf8',
        env: SAFE_GIT_ENV,
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    );
    const output = result.stdout.endsWith('\0') ? result.stdout.slice(0, -1) : result.stdout;
    const originUrls = output.split('\0');
    if (originUrls.length !== 1 || originUrls[0].length === 0 || originUrls[0].trim().length === 0) {
      throw new ConfigValidationError(
        'ORIGIN_NOT_SSH',
        'Repository origin must contain exactly one nonempty URL.',
        'origin',
      );
    }
    return originUrls[0];
  },
};

export async function loadConfig(options: ConfigLoadOptions = {}): Promise<LoadedConfig> {
  const directories = resolveConfigDirectories(options.env);
  const configPath = options.configPath ?? join(directories.configRoot, 'config.json');
  let raw: unknown;

  try {
    raw = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new ConfigValidationError(
      'CONFIG_FILE_INVALID',
      `Cannot read configuration file ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const file = parseConfigFile(raw);
  const repositoryPath = validateRepositoryPath(file.repositoryPath);
  let originUrl: string;
  try {
    originUrl = await (options.git ?? defaultGitOriginProbe).getOriginUrl(repositoryPath, DEFAULT_REMOTE);
  } catch (error) {
    throw new ConfigValidationError(
      'ORIGIN_NOT_SSH',
      'Cannot inspect repository origin.',
      'origin',
    );
  }
  validateOrigin(originUrl);
  const maxQueueLength = validateMaxQueueLength(file.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH);
  const diskFreeMinimumBytes = validateDiskThreshold(file.diskFreeMinimumBytes ?? MIN_DISK_FREE_BYTES);
  const builderLockPath = validateBuilderLockPath(file.builderLockPath);
  const approvedOutputRoots = await validateApprovedRoots(file.approvedOutputRoots, {
    rootFs: options.rootFs,
    minimumFreeBytes: diskFreeMinimumBytes,
  });
  await validateAuthorityOverlaps(approvedOutputRoots, directories.stateRoot, repositoryPath);
  await validateStateRootPreflight(directories.stateRoot);
  const stateCreated = await createStateRoot(directories.stateRoot);
  let pathAuthorities: PathAuthorities;
  try {
    pathAuthorities = await issuePathAuthorities(
      approvedOutputRoots,
      directories.stateRoot,
      repositoryPath,
      Object.freeze({ ...defaultPathAuthorityDependencies, ...options.pathAuthorityDependencies }),
    );
  } catch (error) {
    if (stateCreated.length > 0) {
      try {
        for (const createdPath of stateCreated) await rmdir(createdPath);
      } catch (cleanupError) {
        if (error && typeof error === 'object' && Object.isExtensible(error)) Object.defineProperty(error, 'cleanupError', { value: cleanupError, enumerable: false });
      }
    }
    if (error instanceof ConfigAuthorityError && error.code) throw new ConfigValidationError(error.code, error.message);
    throw error;
  }

  const config: BuilderConfig = {
    repository: { path: repositoryPath, remote: DEFAULT_REMOTE },
    approvedOutputRoots,
    builderLockPath,
    maxQueueLength,
    diskFreeMinimumBytes,
  };

  return {
    config,
    redacted: { ...config },
    ...directories,
    pathAuthorities,
  };
}

async function validateAuthorityOverlaps(
  roots: readonly ApprovedOutputRoot[],
  statePath: string,
  repositoryPath: string,
): Promise<void> {
  let repositoryCanonical: string;
  try { repositoryCanonical = await realpath(repositoryPath); } catch (error) { throw new ConfigValidationError('OUTPUT_ROOT_OVERLAP', `Cannot canonicalize protected work root: ${error instanceof Error ? error.message : String(error)}`); }
  let stateCanonical = resolve(statePath);
  try { stateCanonical = await realpath(statePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigValidationError('OUTPUT_ROOT_OVERLAP', 'Cannot canonicalize protected state root.');
  }
  const rootsOverlap = roots.some((root, index) => roots.slice(index + 1).some((other) => pathsOverlap(root.path, other.path)));
  if (rootsOverlap || roots.some((root) => pathsOverlap(root.path, repositoryCanonical) || pathsOverlap(root.path, stateCanonical)) || pathsOverlap(stateCanonical, repositoryCanonical)) {
    throw new ConfigValidationError('OUTPUT_ROOT_OVERLAP', 'Approved output, state, and work roots may not overlap.');
  }
}

async function validateStateRootPreflight(statePath: string): Promise<void> {
  let exists = true;
  try {
    await lstat(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
    else throw new ConfigValidationError('STATE_ROOT_NOT_FOUND', 'State root cannot be inspected.');
  }
  try {
    if (exists) await inspectAuthorityDirectory(statePath, 'state root', 'state');
    else {
      let parent = resolve(statePath, '..');
      while (true) {
        try {
          await inspectAuthorityDirectory(parent, 'state parent', 'output');
          break;
        } catch (parentError) {
          if (!(parentError instanceof ConfigAuthorityError) || !String(parentError.message).includes('cannot be inspected')) throw parentError;
          const next = resolve(parent, '..');
          if (next === parent) throw parentError;
          parent = next;
        }
      }
    }
  } catch (error) {
    if (error instanceof ConfigAuthorityError) throw new ConfigValidationError(error.code ?? 'STATE_ROOT_NOT_FOUND', error.message);
    throw error;
  }
}

async function createStateRoot(statePath: string): Promise<string[]> {
  const missing: string[] = [];
  let current = statePath;
  while (true) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigValidationError('STATE_ROOT_CREATE_FAILED', 'State root cannot be inspected.');
      missing.push(current);
      const parent = resolve(current, '..');
      if (parent === current) throw new ConfigValidationError('STATE_ROOT_CREATE_FAILED', 'State root has no existing parent.');
      current = parent;
    }
  }
  try {
    for (const directory of [...missing].reverse()) await mkdir(directory, { mode: 0o700 });
    return missing;
  } catch (error) {
    for (const directory of missing) {
      try { await rmdir(directory); } catch (cleanupError) { void cleanupError; }
    }
    throw new ConfigValidationError('STATE_ROOT_CREATE_FAILED', `State root could not be created: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function validateApprovedRoots(
  roots: readonly ApprovedOutputRootInput[],
  options: RootValidationOptions = {},
): Promise<readonly ApprovedOutputRoot[]> {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new ConfigValidationError('OUTPUT_ROOTS_INVALID', 'At least one approved output root is required.');
  }

  const seen = new Set<string>();
  const minimumFreeBytes = validateDiskThreshold(options.minimumFreeBytes ?? MIN_DISK_FREE_BYTES);
  const rootFs: RootFileSystem = {
    lstat: lstat as RootFileSystem['lstat'],
    realpath,
    access: async (path, mode) => access(path, mode),
    statfs: statfs as RootFileSystem['statfs'],
    ...options.rootFs,
  };
  const result: ApprovedOutputRoot[] = [];

  for (const root of roots) {
    if (!root || typeof root !== 'object' || typeof root.id !== 'string' || typeof root.label !== 'string' || typeof root.path !== 'string') {
      throw new ConfigValidationError('OUTPUT_ROOTS_INVALID', 'Approved output root entries require id, label, and path.');
    }
    if (!ROOT_ID_PATTERN.test(root.id)) {
      throw new ConfigValidationError('OUTPUT_ROOT_ID_INVALID', `Invalid approved output root ID: ${root.id}`, 'approvedOutputRoots');
    }
    if (seen.has(root.id)) {
      throw new ConfigValidationError('OUTPUT_ROOT_ID_DUPLICATE', `Duplicate approved output root ID: ${root.id}`, 'approvedOutputRoots');
    }
    seen.add(root.id);
    if (!isAbsolutePath(root.path)) {
      throw new ConfigValidationError('OUTPUT_ROOT_PATH_NOT_ABSOLUTE', `Approved output root must be absolute: ${root.path}`, root.id);
    }

    let rootStats: RootStats;
    try {
      rootStats = await rootFs.lstat(root.path);
    } catch (error) {
      throw new ConfigValidationError('OUTPUT_ROOT_NOT_FOUND', `Approved output root does not exist: ${root.path}`, root.id);
    }
    if (rootStats.isSymbolicLink()) {
      throw new ConfigValidationError('OUTPUT_ROOT_SYMLINK', `Approved output root may not be a symlink: ${root.path}`, root.id);
    }
    if (rootStats.isBlockDevice()) {
      throw new ConfigValidationError('OUTPUT_ROOT_BLOCK_DEVICE', `Approved output root may not be a block device: ${root.path}`, root.id);
    }
    if (!rootStats.isDirectory()) {
      throw new ConfigValidationError('OUTPUT_ROOT_NOT_DIRECTORY', `Approved output root must be a directory: ${root.path}`, root.id);
    }
    validateDirectoryPolicy(rootStats, `Approved output root ${root.id}`, 'output', (message, code) => { throw new ConfigValidationError(code, message, root.id); });

    let canonicalPath: string;
    try {
      canonicalPath = await rootFs.realpath(root.path);
    } catch (error) {
      throw new ConfigValidationError(
        'OUTPUT_ROOT_CANONICALIZE_FAILED',
        `Cannot canonicalize approved output root ${root.path}.${error instanceof Error ? ` ${error.message}` : ''}`,
        root.id,
      );
    }
    if (resolve(root.path) !== canonicalPath) {
      throw new ConfigValidationError('OUTPUT_ROOT_SYMLINK', `Approved output root resolves through a symlink: ${root.path}`, root.id);
    }
    try {
      await rootFs.access(canonicalPath, fsConstants.W_OK);
    } catch (error) {
      throw new ConfigValidationError('OUTPUT_ROOT_NOT_WRITABLE', `Approved output root is not writable: ${root.path}`, root.id);
    }

    let free: StatFsResult;
    try {
      free = await rootFs.statfs(canonicalPath);
    } catch (error) {
      throw new ConfigValidationError(
        'OUTPUT_ROOT_SPACE_CHECK_FAILED',
        `Cannot inspect free space for approved output root ${canonicalPath}.${error instanceof Error ? ` ${error.message}` : ''}`,
        root.id,
      );
    }
    if (free.bavail * free.bsize < minimumFreeBytes) {
      throw new ConfigValidationError('PREFLIGHT_DISK_SPACE', `Approved output root has less than ${minimumFreeBytes} bytes free: ${canonicalPath}`, root.id);
    }
    result.push({
      id: root.id,
      label: root.label,
      path: canonicalPath,
      quarantinePath: join(canonicalPath, '.osi-image-builder', 'quarantine'),
    });
  }

  return result;
}

export function resolveApprovedRoot(
  config: BuilderConfig,
  rootId: string,
  submittedPath?: string,
): ApprovedOutputRoot {
  if (submittedPath !== undefined) {
    throw new ConfigValidationError('OUTPUT_PATH_NOT_ALLOWED', 'Jobs must submit an approved output root ID, not a path.');
  }
  const root = config.approvedOutputRoots.find((candidate) => candidate.id === rootId);
  if (!root) {
    throw new ConfigValidationError('OUTPUT_ROOT_ID_UNKNOWN', `Unknown approved output root ID: ${rootId}`);
  }
  return root;
}

function parseConfigFile(raw: unknown): ConfigFile {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigValidationError('CONFIG_FILE_INVALID', 'Configuration must be a JSON object.');
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.repositoryPath !== 'string' || !Array.isArray(value.approvedOutputRoots) || typeof value.builderLockPath !== 'string') {
    throw new ConfigValidationError('CONFIG_FILE_INVALID', 'Configuration requires repositoryPath, approvedOutputRoots, and builderLockPath.');
  }
  const allowedKeys = new Set(['repositoryPath', 'approvedOutputRoots', 'builderLockPath', 'maxQueueLength', 'diskFreeMinimumBytes']);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new ConfigValidationError('CONFIG_FILE_INVALID', `Unknown configuration key: ${unknownKey}`);
  }
  return value as unknown as ConfigFile;
}

function validateRepositoryPath(value: string): string {
  if (!isAbsolute(value)) {
    throw new ConfigValidationError('REPOSITORY_PATH_NOT_ABSOLUTE', `Repository path must be absolute: ${value}`, 'repositoryPath');
  }
  return resolve(value);
}

export function validateOrigin(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new ConfigValidationError('ORIGIN_NOT_SSH', 'The configured origin must use SSH syntax.', 'origin');
  }
  const isScpSsh = /^[^@\s/:]+@[^:\s/]+:.+$/.test(value);
  let isSshUrl = false;
  try {
    const parsed = new URL(value);
    isSshUrl = parsed.protocol === 'ssh:' && parsed.hostname.length > 0 && parsed.pathname.length > 1;
  } catch {
    isSshUrl = false;
  }
  if (!isScpSsh && !isSshUrl) {
    throw new ConfigValidationError('ORIGIN_NOT_SSH', 'The configured origin must use SSH syntax.', 'origin');
  }
}

function validateMaxQueueLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_QUEUE_LENGTH) {
    throw new ConfigValidationError('MAX_QUEUE_INVALID', `maxQueueLength must be an integer from 1 to ${DEFAULT_MAX_QUEUE_LENGTH}.`, 'maxQueueLength');
  }
  return value;
}

function validateDiskThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_DISK_FREE_BYTES) {
    throw new ConfigValidationError('DISK_THRESHOLD_INVALID', `diskFreeMinimumBytes must be at least ${MIN_DISK_FREE_BYTES}.`, 'diskFreeMinimumBytes');
  }
  return value;
}

function validateBuilderLockPath(value: string): string {
  if (!isAbsolute(value) || value.endsWith('/') || value.split('/').at(-1) !== DEFAULT_BUILDER_LOCK_FILE) {
    throw new ConfigValidationError('BUILDER_LOCK_PATH_INVALID', 'builderLockPath must be an absolute builder.lock.json path.', 'builderLockPath');
  }
  const version = value.split('/').at(-2);
  if (!version || !BUILDER_VERSION_PATTERN.test(version)) {
    throw new ConfigValidationError('BUILDER_LOCK_PATH_INVALID', 'builderLockPath must include a versioned installation directory.', 'builderLockPath');
  }
  return resolve(value);
}

export type { ConfigDirectories };
