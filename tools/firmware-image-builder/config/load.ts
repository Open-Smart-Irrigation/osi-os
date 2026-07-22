import { execFile as execFileCallback } from 'node:child_process';
import { access, lstat, readFile, realpath, statfs } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
  | 'OUTPUT_PATH_NOT_ALLOWED';

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
}

export interface RootStats {
  readonly isSymbolicLink: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isBlockDevice: () => boolean;
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
  };
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
