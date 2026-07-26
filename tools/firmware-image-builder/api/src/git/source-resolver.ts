import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { GitCommand, GitCommandError, type GitProcessResult, type GitRunOptions } from './git-command.js';
import {
  CANONICAL_FETCH_REFSPEC,
  EFFECTIVE_ORIGIN_CONFIG_COMMANDS,
  OriginPolicyError,
  parseNulValues,
  sameOriginPolicy,
  validateEffectiveOriginConfig,
  validateOriginUrl,
  type ValidatedOriginPolicy,
} from '../../../config/origin-policy.js';
import { canonicalInstant, normalizeJson } from '../validation.js';
import {
  withStateRootSnapshot,
  type PathAuthorityDependencies,
  type StateRootAuthority,
} from '../../../config/load.js';

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REMOTE_NAME = 'origin';
const MAX_BRANCH_BYTES = 255;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_PREPARED_FEED_FILE_BYTES = 256 * 1024 * 1024;
const MAX_REF_COUNT = 1000;
const NUL = '\0';
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PREPARED_FEED_NAMES = Object.freeze(['packages', 'luci', 'routing'] as const);
const SOURCE_COMPONENTS = Object.freeze([
  Object.freeze({
    path: 'feeds/chirpstack-openwrt-feed',
    provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git',
  }),
  Object.freeze({
    path: 'openwrt',
    provenanceUrl: 'https://github.com/openwrt/openwrt.git',
  }),
] as const);

export interface GitExecutor {
  run(argv: readonly string[], options?: GitRunOptions): Promise<GitProcessResult>;
}

export interface SourceResolverOptions {
  readonly repositoryPath: string;
  readonly remote?: typeof REMOTE_NAME;
  readonly git?: GitExecutor;
  readonly feedGit?: GitExecutor;
  readonly now?: () => string;
}

export interface RemoteBranch {
  readonly name: string;
  readonly sha: string;
  readonly commitTime: string;
  readonly subject: string;
}

export interface BranchList {
  readonly fetchedAt: string;
  readonly branches: readonly RemoteBranch[];
}

export interface GitResolutionMetadata {
  readonly remote: typeof REMOTE_NAME;
  readonly originUrl: string;
  readonly ref: string;
  readonly branch: string;
  readonly sha: string;
  readonly commitTime: string;
  readonly author: string;
  readonly subject: string;
  readonly sourcePreparation: RecursiveSourcePreparation;
}

export interface RunnerPinnedSource {
  readonly branch: string;
  readonly sha: string;
  readonly commitTime: string;
  readonly author: string;
  readonly subject: string;
  readonly sourcePreparation: RecursiveSourcePreparation;
}

export interface PreparedSourceComponent {
  readonly path: (typeof SOURCE_COMPONENTS)[number]['path'];
  readonly mode: '040000';
  readonly type: 'tree';
  readonly objectId: string;
  readonly provenanceUrl: string;
}

export interface RecursiveSourcePreparation {
  readonly schemaVersion: 1;
  readonly sourceSha: string;
  readonly gitmodulesBlobSha: string;
  readonly preparedAt: string;
  readonly components: readonly PreparedSourceComponent[];
}

export interface ApiPreparedFeed {
  readonly name: string;
  readonly location: string;
  readonly commit: string;
  readonly detached: true;
  readonly clean: true;
  readonly recursiveSubmodulesPrepared: true;
  readonly recursiveSubmodules: readonly {
    readonly path: string;
    readonly commit: string;
  }[];
  readonly recursiveSubmoduleStatusSha256: string;
  readonly treeSha256: string;
}

export interface OfflineFeedPreparation {
  readonly schemaVersion: 1;
  readonly boundary: 'api-prepared-pinned-feeds-v1';
  readonly networkPolicy: 'runner-offline';
  readonly jobId: string;
  readonly sourceSha: string;
  readonly preparedAt: string;
  readonly feeds: readonly ApiPreparedFeed[];
}

export function hashRecursiveSubmoduleAttestation(
  submodules: readonly ApiPreparedFeed['recursiveSubmodules'][number][],
): string {
  const records = submodules.map(({ path, commit }) => `${commit}\0${path}\n`).join('');
  return createHash('sha256').update(records).digest('hex');
}

export type FreshnessResult =
  | { readonly status: 'fresh'; readonly pinnedSha: string; readonly observedSha: string; readonly newerSourceAvailable: false }
  | { readonly status: 'advanced'; readonly pinnedSha: string; readonly observedSha: string; readonly newerSourceAvailable: true }
  | { readonly status: 'unknown'; readonly pinnedSha: string; readonly observedSha: null; readonly newerSourceAvailable: false; readonly errorCode: 'FRESHNESS_UNKNOWN'; readonly errorEvidence: 'remote freshness check unavailable' };

export type SourceResolverCode =
  | 'INVALID_REMOTE'
  | 'INVALID_BRANCH'
  | 'INVALID_SHA'
  | 'ORIGIN_NOT_SSH'
  | 'GIT_FETCH_FAILED'
  | 'SOURCE_NOT_COMMIT'
  | 'SOURCE_PREPARATION_FAILED'
  | 'BRANCH_MOVED'
  | 'FRESHNESS_UNKNOWN';

export class SourceResolverError extends Error {
  readonly code: SourceResolverCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: SourceResolverCode, details: Readonly<Record<string, string>> = {}) {
    super(sourceMessage(code));
    this.name = 'SourceResolverError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function sourceMessage(code: SourceResolverCode): string {
  switch (code) {
    case 'INVALID_REMOTE': return 'Only the configured origin remote is allowed.';
    case 'INVALID_BRANCH': return 'The remote branch name is invalid.';
    case 'INVALID_SHA': return 'The pinned SHA must be exactly 40 lowercase hexadecimal characters.';
    case 'ORIGIN_NOT_SSH': return 'The configured origin is not one approved SSH URL.';
    case 'GIT_FETCH_FAILED': return 'The configured origin could not be fetched.';
    case 'SOURCE_NOT_COMMIT': return 'The selected remote ref does not resolve to a commit.';
    case 'SOURCE_PREPARATION_FAILED': return 'The selected source tree could not be prepared for offline execution.';
    case 'BRANCH_MOVED': return 'The remote branch moved after it was displayed.';
    case 'FRESHNESS_UNKNOWN': return 'The remote freshness check was unavailable.';
  }
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasControl(value: string, allowNewline = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    if (allowNewline && (code === 9 || code === 10 || code === 13)) return false;
    return code < 32 || code === 127;
  });
}

function validateBranch(branch: unknown): string {
  if (typeof branch !== 'string' || bytes(branch) === 0 || bytes(branch) > MAX_BRANCH_BYTES || branch === 'HEAD' || !BRANCH_PATTERN.test(branch) || branch.endsWith('/') || branch.startsWith('/') || branch.includes('..') || branch.includes('@') || /[\s~^:?*[\\]/u.test(branch)) {
    throw new SourceResolverError('INVALID_BRANCH');
  }
  const components = branch.split('/');
  if (components.some((component) => component.length === 0 || component === '.' || component === '..' || component.startsWith('.') || component.endsWith('.') || component.toLowerCase().endsWith('.lock') || bytes(component) > MAX_BRANCH_BYTES)) {
    throw new SourceResolverError('INVALID_BRANCH');
  }
  if (branch.startsWith('-') || hasControl(branch)) throw new SourceResolverError('INVALID_BRANCH');
  return branch;
}

function validateSha(sha: unknown): string {
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new SourceResolverError('INVALID_SHA');
  return sha;
}

function parseRefRecords(output: string, expectedFields: number): string[][] {
  const frame = NUL + '\n';
  if (bytes(output) > MAX_FIELD_BYTES || !output.endsWith(frame)) throw new SourceResolverError('SOURCE_NOT_COMMIT');
  const records = output.slice(0, -frame.length).split(frame);
  if (records.length === 0 || records.some((record) => record.length === 0)) throw new SourceResolverError('SOURCE_NOT_COMMIT');
  return records.map((record) => {
    const fields = record.split(NUL);
    if (fields.length !== expectedFields || fields.some((field) => field.includes('\n') || field.includes('\r'))) throw new SourceResolverError('SOURCE_NOT_COMMIT');
    return fields;
  });
}

function parseSingleMetadataRecord(output: string, expectedFields: number): string[] {
  if (bytes(output) > MAX_FIELD_BYTES || !output.endsWith(NUL)) throw new SourceResolverError('SOURCE_NOT_COMMIT');
  const fields = output.slice(0, -1).split(NUL);
  if (fields.length !== expectedFields) throw new SourceResolverError('SOURCE_NOT_COMMIT');
  return fields;
}

function parseSingleSha(output: string): string {
  const normalized = output.endsWith('\n') ? output.slice(0, -1) : output;
  if (!SHA_PATTERN.test(normalized)) throw new SourceResolverError('SOURCE_NOT_COMMIT');
  return normalized;
}

function validateCommitMetadata(sha: string, commitTime: string, authorName: string, authorEmail: string, subject: string): void {
  if (!SHA_PATTERN.test(sha) || bytes(commitTime) > 256 || bytes(authorName) > 4096 || bytes(authorEmail) > 4096 || bytes(subject) > MAX_FIELD_BYTES || hasControl(commitTime) || hasControl(authorName) || hasControl(authorEmail) || hasControl(subject, true) || Number.isNaN(Date.parse(commitTime))) {
    throw new SourceResolverError('SOURCE_NOT_COMMIT');
  }
}

function immutable<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

interface HeldDirectory {
  readonly handle: FileHandle;
  readonly parent: HeldDirectory | null;
  readonly name: string | null;
}

interface PinnedFeed {
  readonly name: (typeof PREPARED_FEED_NAMES)[number];
  readonly location: string;
  readonly commit: string;
}

function descriptorPath(handle: FileHandle, name?: string): string {
  const root = `/proc/${process.pid}/fd/${handle.fd}`;
  return name === undefined ? root : join(root, name);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function safePathSegment(value: string): string {
  if (
    value.length === 0
    || Buffer.byteLength(value) > 255
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || /[\0-\x1f\x7f]/u.test(value)
  ) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  return value;
}

async function assertHeldDirectory(directory: HeldDirectory, dependencies: PathAuthorityDependencies): Promise<void> {
  if (directory.parent === null || directory.name === null) return;
  await dependencies.beforeDirectoryAccess?.(directory.parent.handle);
  const current = await open(descriptorPath(directory.parent.handle, directory.name), DIR_FLAGS);
  try {
    const [heldStats, currentStats] = await Promise.all([directory.handle.stat(), current.stat()]);
    if (!heldStats.isDirectory() || !currentStats.isDirectory() || !sameIdentity(heldStats, currentStats)) {
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
  } finally {
    await current.close();
  }
}

async function openHeldDirectory(
  parent: HeldDirectory,
  name: string,
  dependencies: PathAuthorityDependencies,
): Promise<HeldDirectory> {
  safePathSegment(name);
  await dependencies.beforeDirectoryAccess?.(parent.handle);
  const handle = await open(descriptorPath(parent.handle, name), DIR_FLAGS);
  const directory = { handle, parent, name };
  try {
    await assertHeldDirectory(directory, dependencies);
    return directory;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function createHeldDirectory(
  parent: HeldDirectory,
  name: string,
  dependencies: PathAuthorityDependencies,
  exclusive: boolean,
): Promise<HeldDirectory> {
  safePathSegment(name);
  try {
    await mkdir(descriptorPath(parent.handle, name), { mode: 0o700 });
  } catch (error) {
    if (exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return openHeldDirectory(parent, name, dependencies);
}

async function readHeldFile(parent: HeldDirectory, name: string, dependencies: PathAuthorityDependencies): Promise<Buffer> {
  safePathSegment(name);
  const handle = await open(descriptorPath(parent.handle, name), READ_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_PREPARED_FEED_FILE_BYTES) {
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
    await dependencies.beforeRead(handle);
    const contents = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < contents.length) {
      const result = await handle.read(contents, offset, contents.length - offset, offset);
      if (result.bytesRead === 0) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameIdentity(before, after) || before.size !== after.size) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    const named = await open(descriptorPath(parent.handle, name), READ_FLAGS);
    try {
      if (!sameIdentity(after, await named.stat())) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    } finally {
      await named.close();
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function assertSafeSymlink(target: string, relativePath: string): void {
  if (target.length === 0 || target.includes('\0') || posix.isAbsolute(target)) {
    throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  }
  const resolved = posix.resolve('/prepared-feed', posix.dirname(relativePath), target);
  if (resolved !== '/prepared-feed' && !resolved.startsWith('/prepared-feed/')) {
    throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  }
}

async function hashPreparedFeedTree(
  root: HeldDirectory,
  dependencies: PathAuthorityDependencies,
): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: HeldDirectory, prefix: string): Promise<void> => {
    const names = await readdir(descriptorPath(directory.handle));
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      safePathSegment(name);
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      const stats = await lstat(descriptorPath(directory.handle, name));
      if (stats.isDirectory()) {
        hash.update(`D\0${relativePath}\0${stats.mode & 0o777}\0`);
        const child = await openHeldDirectory(directory, name, dependencies);
        try {
          await visit(child, relativePath);
          await assertHeldDirectory(child, dependencies);
        } finally {
          await child.handle.close();
        }
      } else if (stats.isFile()) {
        hash.update(`F\0${relativePath}\0${stats.mode & 0o777}\0`);
        hash.update(await readHeldFile(directory, name, dependencies));
        hash.update('\0');
      } else if (stats.isSymbolicLink()) {
        const before = await lstat(descriptorPath(directory.handle, name));
        const target = await readlink(descriptorPath(directory.handle, name));
        const after = await lstat(descriptorPath(directory.handle, name));
        if (!sameIdentity(before, after)) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
        assertSafeSymlink(target, relativePath);
        hash.update(`L\0${relativePath}\0${target}\0`);
      } else {
        throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
      }
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

function parsePinnedFeeds(contents: string): readonly PinnedFeed[] {
  const feeds = new Map<string, PinnedFeed>();
  let localChirpstack = false;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^src-git ([A-Za-z0-9][A-Za-z0-9._-]*) (https:\/\/[^\s^]+)\^([0-9a-f]{40})$/u.exec(line);
    if (!match) {
      if (line === 'src-link chirpstack feeds/chirpstack-openwrt-feed' && !localChirpstack) {
        localChirpstack = true;
        continue;
      }
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
    const name = match[1]!;
    if (!PREPARED_FEED_NAMES.includes(name as PinnedFeed['name']) || feeds.has(name)) {
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
    feeds.set(name, immutable({ name: name as PinnedFeed['name'], location: match[2]!, commit: match[3]! }));
  }
  if (
    feeds.size !== PREPARED_FEED_NAMES.length
    || !localChirpstack
    || PREPARED_FEED_NAMES.some((name) => !feeds.has(name))
  ) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  return Object.freeze(PREPARED_FEED_NAMES.map((name) => feeds.get(name)!));
}

function parseRecursiveSubmodules(output: string): readonly { readonly path: string; readonly commit: string }[] {
  if (bytes(output) > MAX_FIELD_BYTES) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  if (output.length === 0) return Object.freeze([]);
  const records = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n');
  const submodules = records.map((line) => {
    const match = /^ ([0-9a-f]{40}) ([A-Za-z0-9][A-Za-z0-9._/+ -]*?)(?: \(.+\))?$/u.exec(line);
    if (!match || match[2]!.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
    return immutable({ path: match[2]!, commit: match[1]! });
  });
  if (new Set(submodules.map(({ path }) => path)).size !== submodules.length) {
    throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  }
  return Object.freeze(submodules);
}

function parseSourceTree(output: string): {
  readonly gitmodulesBlobSha: string;
  readonly components: readonly Omit<PreparedSourceComponent, 'provenanceUrl'>[];
} {
  if (bytes(output) > MAX_FIELD_BYTES || !output.endsWith(NUL)) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  const records = output.slice(0, -1).split(NUL);
  const entries = records.map((record) => {
    const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t([^\0\r\n]+)$/u.exec(record);
    if (!match) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    return { mode: match[1]!, type: match[2]!, objectId: match[3]!, path: match[4]! };
  });
  if (entries.length !== 3 || new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  const modules = entries.find((entry) => entry.path === '.gitmodules');
  if (!modules || modules.mode !== '100644' || modules.type !== 'blob') throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  const components = SOURCE_COMPONENTS.map(({ path }) => {
    const entry = entries.find((candidate) => candidate.path === path);
    if (!entry || entry.mode !== '040000' || entry.type !== 'tree') throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    return immutable({ path, mode: '040000' as const, type: 'tree' as const, objectId: entry.objectId });
  });
  return immutable({ gitmodulesBlobSha: modules.objectId, components: Object.freeze(components) });
}

function validateGitmodules(contents: string): void {
  if (bytes(contents) > MAX_FIELD_BYTES || contents.includes('\0') || contents.includes('\r')) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  let currentName = '';
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const section = /^\[submodule "([^"]+)"\]$/u.exec(line);
    if (section) {
      currentName = section[1]!;
      if (!SOURCE_COMPONENTS.some(({ path }) => path === currentName) || sections.has(currentName)) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
      current = new Map();
      sections.set(currentName, current);
      continue;
    }
    const setting = /^(path|url|branch)\s*=\s*(\S+)$/u.exec(line);
    if (!current || !setting || current.has(setting[1]!)) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    if (setting[1] === 'branch' && currentName !== 'openwrt') throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    current.set(setting[1]!, setting[2]!);
  }
  if (sections.size !== SOURCE_COMPONENTS.length) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  for (const expected of SOURCE_COMPONENTS) {
    const values = sections.get(expected.path);
    const expectedKeys = expected.path === 'openwrt' ? ['branch', 'path', 'url'] : ['path', 'url'];
    if (!values || [...values.keys()].sort().join('\0') !== expectedKeys.join('\0') || values.get('path') !== expected.path || values.get('url') !== expected.provenanceUrl) {
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
    if (expected.path === 'openwrt' && values.get('branch') !== 'openwrt-24.10') throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  }
}

export function validateRecursiveSourcePreparation(preparation: RecursiveSourcePreparation, sourceSha: string): RecursiveSourcePreparation {
  try {
    const value = normalizeJson(preparation, 'sourcePreparation');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    const normalized = value as unknown as RecursiveSourcePreparation;
    if (normalized.schemaVersion !== 1 || normalized.sourceSha !== sourceSha || !SHA_PATTERN.test(normalized.gitmodulesBlobSha)) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    const preparedAt = canonicalInstant(normalized.preparedAt, 'sourcePreparation.preparedAt');
    if (!Array.isArray(normalized.components) || normalized.components.length !== SOURCE_COMPONENTS.length) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    const components = SOURCE_COMPONENTS.map((expected, index) => {
      const component = normalized.components[index];
      if (!component || component.path !== expected.path || component.mode !== '040000' || component.type !== 'tree' || !SHA_PATTERN.test(component.objectId) || component.provenanceUrl !== expected.provenanceUrl || Object.keys(component).sort().join('\0') !== 'mode\0objectId\0path\0provenanceUrl\0type') throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
      return immutable({ ...component });
    });
    if (Object.keys(normalized).sort().join('\0') !== 'components\0gitmodulesBlobSha\0preparedAt\0schemaVersion\0sourceSha') throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    return immutable({ schemaVersion: 1, sourceSha, gitmodulesBlobSha: normalized.gitmodulesBlobSha, preparedAt, components: Object.freeze(components) });
  } catch {
    throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
  }
}

export class SourceResolver {
  readonly #repositoryPath: string;
  readonly #git: GitExecutor;
  readonly #feedGit: GitExecutor;
  readonly #now: () => string;

  constructor(options: SourceResolverOptions) {
    if (options.remote !== undefined && options.remote !== REMOTE_NAME) throw new SourceResolverError('INVALID_REMOTE');
    if (typeof options.repositoryPath !== 'string' || !options.repositoryPath.startsWith('/') || hasControl(options.repositoryPath)) throw new TypeError('Repository path must be an absolute path without control characters.');
    this.#repositoryPath = options.repositoryPath;
    this.#git = options.git ?? new GitCommand();
    this.#feedGit = options.feedGit ?? this.#git;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  static toRunnerPinnedSource(metadata: GitResolutionMetadata): RunnerPinnedSource {
    if (!metadata || typeof metadata !== 'object' || metadata.remote !== REMOTE_NAME || typeof metadata.originUrl !== 'string' || typeof metadata.ref !== 'string' || metadata.ref !== `refs/remotes/origin/${metadata.branch}` || typeof metadata.branch !== 'string' || typeof metadata.sha !== 'string' || typeof metadata.commitTime !== 'string' || typeof metadata.author !== 'string' || typeof metadata.subject !== 'string') {
      throw new SourceResolverError('SOURCE_NOT_COMMIT');
    }
    validateBranch(metadata.branch);
    validateSha(metadata.sha);
    validateOriginUrl(metadata.originUrl);
    if (bytes(metadata.author) === 0 || bytes(metadata.author) > 8192 || bytes(metadata.subject) > MAX_FIELD_BYTES || hasControl(metadata.commitTime) || hasControl(metadata.author) || hasControl(metadata.subject, true) || Number.isNaN(Date.parse(metadata.commitTime))) throw new SourceResolverError('SOURCE_NOT_COMMIT');
    return immutable({
      branch: metadata.branch,
      sha: metadata.sha,
      commitTime: metadata.commitTime,
      author: metadata.author,
      subject: metadata.subject,
      sourcePreparation: validateRecursiveSourcePreparation(metadata.sourcePreparation, metadata.sha),
    });
  }

  async prepareRecursiveSource(shaInput: unknown): Promise<RecursiveSourcePreparation> {
    const sha = validateSha(shaInput);
    try {
      const tree = parseSourceTree((await this.#run([
        'ls-tree',
        '-z',
        '--full-tree',
        sha,
        '--',
        '.gitmodules',
        'feeds/chirpstack-openwrt-feed',
        'openwrt',
      ])).stdout);
      const modules = await this.#run(['show', `${sha}:.gitmodules`]);
      validateGitmodules(modules.stdout);
      for (const component of tree.components) {
        await this.#run(['cat-file', '-e', '--end-of-options', `${component.objectId}^{tree}`]);
      }
      return immutable({
        schemaVersion: 1,
        sourceSha: sha,
        gitmodulesBlobSha: tree.gitmodulesBlobSha,
        preparedAt: canonicalInstant(this.#now(), 'sourcePreparation.preparedAt'),
        components: Object.freeze(tree.components.map((component, index) => immutable({
          ...component,
          provenanceUrl: SOURCE_COMPONENTS[index]!.provenanceUrl,
        }))),
      });
    } catch (error) {
      if (error instanceof SourceResolverError && error.code === 'INVALID_SHA') throw error;
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
  }

  async prepareOfflineFeeds(
    sourceShaInput: unknown,
    stateRoot: StateRootAuthority,
    jobIdInput: unknown,
  ): Promise<OfflineFeedPreparation> {
    // This is the API-only HTTPS boundary; the runner receives the resulting
    // job/source-bound checkout attestations and has no network fallback.
    const sourceSha = validateSha(sourceShaInput);
    if (typeof jobIdInput !== 'string' || !SAFE_JOB_ID.test(jobIdInput)) {
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }
    const jobId = jobIdInput;
    let feeds: readonly PinnedFeed[];
    try {
      feeds = parsePinnedFeeds((await this.#run(['show', `${sourceSha}:feeds.conf.default`])).stdout);
    } catch {
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
    }

    try {
      return await withStateRootSnapshot(stateRoot, async ({ snapshot, dependencies }) => {
        const handles: FileHandle[] = [];
        try {
          const rootHandle = await open(snapshot.path, DIR_FLAGS);
          handles.push(rootHandle);
          const rootStats = await rootHandle.stat();
          if (!rootStats.isDirectory() || rootStats.dev !== snapshot.device || rootStats.ino !== snapshot.inode) {
            throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
          }
          const root: HeldDirectory = { handle: rootHandle, parent: null, name: null };
          const jobs = await createHeldDirectory(root, 'jobs', dependencies, false);
          handles.push(jobs.handle);
          const job = await createHeldDirectory(jobs, jobId, dependencies, false);
          handles.push(job.handle);
          const preparedRoot = await createHeldDirectory(job, 'prepared-feeds', dependencies, true);
          handles.push(preparedRoot.handle);
          const prepared: ApiPreparedFeed[] = [];

          for (const feed of feeds) {
            await assertHeldDirectory(preparedRoot, dependencies);
            await this.#runPreparedGit([
              'clone',
              '--quiet',
              '--no-checkout',
              '--no-tags',
              '--origin',
              REMOTE_NAME,
              '--',
              feed.location,
              feed.name,
            ], descriptorPath(preparedRoot.handle));
            const checkout = await openHeldDirectory(preparedRoot, feed.name, dependencies);
            handles.push(checkout.handle);
            await this.#runPreparedGit([
              'checkout',
              '--quiet',
              '--detach',
              '--force',
              '--no-recurse-submodules',
              feed.commit,
            ], descriptorPath(checkout.handle));
            await this.#runPreparedGit(['submodule', 'sync', '--recursive'], descriptorPath(checkout.handle));
            await this.#runPreparedGit([
              'submodule',
              'update',
              '--quiet',
              '--init',
              '--recursive',
              '--force',
            ], descriptorPath(checkout.handle));

            const head = (await this.#runPreparedGit([
              'rev-parse',
              '--verify',
              '--end-of-options',
              'HEAD^{commit}',
            ], descriptorPath(checkout.handle))).stdout;
            if (head !== `${feed.commit}\n`) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
            const origin = (await this.#runPreparedGit([
              'remote',
              'get-url',
              '--all',
              REMOTE_NAME,
            ], descriptorPath(checkout.handle))).stdout;
            if (origin !== `${feed.location}\n`) throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
            const status = (await this.#runPreparedGit([
              'status',
              '--porcelain=v1',
              '--untracked-files=all',
              '--ignore-submodules=none',
            ], descriptorPath(checkout.handle))).stdout;
            if (status !== '') throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
            const recursiveStatus = (await this.#runPreparedGit([
              'submodule',
              'status',
              '--recursive',
            ], descriptorPath(checkout.handle))).stdout;
            const recursiveSubmodules = parseRecursiveSubmodules(recursiveStatus);
            const gitDirectory = await openHeldDirectory(checkout, '.git', dependencies);
            try {
              if ((await readHeldFile(gitDirectory, 'HEAD', dependencies)).toString('utf8') !== `${feed.commit}\n`) {
                throw new SourceResolverError('SOURCE_PREPARATION_FAILED');
              }
            } finally {
              await gitDirectory.handle.close();
            }
            await assertHeldDirectory(checkout, dependencies);
            prepared.push(immutable({
              name: feed.name,
              location: feed.location,
              commit: feed.commit,
              detached: true as const,
              clean: true as const,
              recursiveSubmodulesPrepared: true as const,
              recursiveSubmodules,
              recursiveSubmoduleStatusSha256: hashRecursiveSubmoduleAttestation(recursiveSubmodules),
              treeSha256: await hashPreparedFeedTree(checkout, dependencies),
            }));
          }
          return immutable({
            schemaVersion: 1 as const,
            boundary: 'api-prepared-pinned-feeds-v1' as const,
            networkPolicy: 'runner-offline' as const,
            jobId,
            sourceSha,
            preparedAt: canonicalInstant(this.#now(), 'offlineFeedPreparation.preparedAt'),
            feeds: Object.freeze(prepared),
          });
        } finally {
          for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
        }
      });
    } catch (error) {
      if (error instanceof SourceResolverError) throw error;
      throw new SourceResolverError('SOURCE_PREPARATION_FAILED', {
        sourceSha,
        jobId,
        cause: error instanceof Error ? error.message.slice(0, 512) : 'unknown preparation failure',
      });
    }
  }

  async listBranches(): Promise<BranchList> {
    const originUrl = await this.#fetchOrigin();
    const refResult = await this.#run(['for-each-ref', '--format=%(refname)%00%(symref)%00', 'refs/remotes/origin/']);
    const names = parseRefRecords(refResult.stdout, 2);
    if (names.length > MAX_REF_COUNT) throw new SourceResolverError('SOURCE_NOT_COMMIT');
    const branches: RemoteBranch[] = [];
    for (const [ref, symref] of names) {
      if (ref === 'refs/remotes/origin/HEAD') continue;
      if (!ref.startsWith('refs/remotes/origin/')) continue;
      const branch = validateBranch(ref.slice('refs/remotes/origin/'.length));
      if (symref) continue;
      const sha = await this.#resolveRef(branch);
      const metadata = await this.#readMetadata(sha, false, originUrl, branch);
      branches.push(immutable({ name: branch, sha, commitTime: metadata.commitTime, subject: metadata.subject }));
    }
    branches.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0);
    return immutable({ fetchedAt: this.#now(), branches: Object.freeze(branches) });
  }

  async resolveAtAcceptance(branchInput: unknown, expectedShaInput: unknown, accept?: (metadata: Readonly<GitResolutionMetadata>) => void | Promise<void>): Promise<Readonly<GitResolutionMetadata>> {
    const branch = validateBranch(branchInput);
    const expectedSha = validateSha(expectedShaInput);
    const originUrl = await this.#fetchOrigin();
    const observedSha = await this.#resolveRef(branch);
    const commit = await this.#readMetadata(observedSha, true, originUrl, branch);
    if (observedSha !== expectedSha) throw new SourceResolverError('BRANCH_MOVED', { expectedSha, observedSha, branch });
    const metadata = immutable({ ...commit, sourcePreparation: await this.prepareRecursiveSource(observedSha) });
    if (accept) await accept(metadata);
    return metadata;
  }

  async requestFreshness(branchInput: unknown, pinnedShaInput: unknown): Promise<FreshnessResult> {
    const branch = validateBranch(branchInput);
    const pinnedSha = validateSha(pinnedShaInput);
    try {
      const originUrl = await this.#fetchOrigin();
      const observedSha = await this.#resolveRef(branch);
      await this.#readMetadata(observedSha, true, originUrl, branch);
      if (observedSha === pinnedSha) return immutable({ status: 'fresh', pinnedSha, observedSha, newerSourceAvailable: false });
      return immutable({ status: 'advanced', pinnedSha, observedSha, newerSourceAvailable: true });
    } catch (error) {
      return immutable({ status: 'unknown' as const, pinnedSha, observedSha: null, newerSourceAvailable: false, errorCode: 'FRESHNESS_UNKNOWN' as const, errorEvidence: 'remote freshness check unavailable' as const });
    }
  }

  async #fetchOrigin(): Promise<string> {
    let before: ValidatedOriginPolicy;
    try {
      before = await this.#readOriginPolicy();
    } catch (error) {
      if (error instanceof OriginPolicyError) throw new SourceResolverError('ORIGIN_NOT_SSH');
      throw new SourceResolverError('GIT_FETCH_FAILED');
    }
    try {
      await this.#run([
        '-c',
        'core.hooksPath=/dev/null',
        'fetch',
        '--prune',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        before.url,
        CANONICAL_FETCH_REFSPEC,
      ]);
    } catch {
      throw new SourceResolverError('GIT_FETCH_FAILED');
    }
    let after: ValidatedOriginPolicy;
    try {
      after = await this.#readOriginPolicy();
    } catch {
      throw new SourceResolverError('GIT_FETCH_FAILED');
    }
    if (!sameOriginPolicy(before, after)) throw new SourceResolverError('GIT_FETCH_FAILED');
    return after.url;
  }

  async #resolveRef(branch: string): Promise<string> {
    const ref = `refs/remotes/origin/${branch}`;
    try {
      const symbolic = await this.#run(['for-each-ref', '--format=%(refname)%00%(symref)%00', ref]);
      const records = parseRefRecords(symbolic.stdout, 2);
      if (records.length !== 1 || records[0]![0] !== ref || records[0]![1] !== '') throw new SourceResolverError('SOURCE_NOT_COMMIT');
      const result = await this.#run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
      return parseSingleSha(result.stdout);
    } catch (error) {
      if (error instanceof SourceResolverError) throw error;
      throw new SourceResolverError('SOURCE_NOT_COMMIT');
    }
  }

  async #readMetadata(sha: string, complete: boolean, originUrl = '', branch = ''): Promise<Omit<GitResolutionMetadata, 'sourcePreparation'>> {
    const format = complete ? '%H%x00%cI%x00%an%x00%ae%x00%s%x00' : '%H%x00%cI%x00%s%x00';
    try {
      const result = await this.#run(['show', '--no-patch', `--format=format:${format}`, '--end-of-options', sha]);
      const fields = parseSingleMetadataRecord(result.stdout, complete ? 5 : 3);
      if (complete) {
        const [fullSha, commitTime, authorName, authorEmail, subject] = fields;
        validateCommitMetadata(fullSha!, commitTime!, authorName!, authorEmail!, subject!);
        if (fullSha !== sha) throw new SourceResolverError('SOURCE_NOT_COMMIT');
        return immutable({ remote: REMOTE_NAME, originUrl, ref: `refs/remotes/origin/${branch}`, branch, sha: fullSha!, commitTime: commitTime!, author: `${authorName} <${authorEmail}>`, subject: subject! });
      }
      const [fullSha, commitTime, subject] = fields;
      validateCommitMetadata(fullSha!, commitTime!, '', '', subject!);
      if (fullSha !== sha) throw new SourceResolverError('SOURCE_NOT_COMMIT');
      return immutable({ remote: REMOTE_NAME, originUrl, ref: '', branch: '', sha: fullSha!, commitTime: commitTime!, author: '', subject: subject! });
    } catch (error) {
      if (error instanceof SourceResolverError) throw error;
      throw new SourceResolverError('SOURCE_NOT_COMMIT');
    }
  }

  async #run(argv: readonly string[]): Promise<GitProcessResult> {
    try {
      const result = await this.#git.run(argv, { cwd: this.#repositoryPath });
      if (result.exitCode !== 0 || result.timedOut || result.aborted) throw new GitCommandError({ code: result.aborted ? 'GIT_COMMAND_ABORTED' : result.timedOut ? 'GIT_COMMAND_TIMEOUT' : 'GIT_COMMAND_FAILED', argv, exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, aborted: result.aborted });
      if (bytes(result.stdout) > MAX_FIELD_BYTES || bytes(result.stderr) > MAX_FIELD_BYTES) throw new GitCommandError({ code: 'GIT_OUTPUT_LIMIT', argv });
      return result;
    } catch (error) {
      if (error instanceof GitCommandError) throw error;
      throw new GitCommandError({ code: 'GIT_EXECUTION_FAILED', argv });
    }
  }

  async #runPreparedGit(argv: readonly string[], cwd: string): Promise<GitProcessResult> {
    try {
      const result = await this.#feedGit.run(argv, {
        cwd,
        timeoutMs: 30 * 60 * 1000,
        allowedProtocols: 'https',
      });
      if (
        result.exitCode !== 0
        || result.signal !== null
        || result.timedOut
        || result.aborted
        || result.argv.length !== argv.length
        || result.argv.some((value, index) => value !== argv[index])
      ) {
        throw new GitCommandError({
          code: result.aborted ? 'GIT_COMMAND_ABORTED' : result.timedOut ? 'GIT_COMMAND_TIMEOUT' : 'GIT_COMMAND_FAILED',
          argv,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          aborted: result.aborted,
        });
      }
      if (bytes(result.stdout) > MAX_FIELD_BYTES || bytes(result.stderr) > MAX_FIELD_BYTES) {
        throw new GitCommandError({ code: 'GIT_OUTPUT_LIMIT', argv });
      }
      return result;
    } catch (error) {
      if (error instanceof GitCommandError) throw error;
      throw new GitCommandError({ code: 'GIT_EXECUTION_FAILED', argv });
    }
  }

  async #readOriginPolicy(): Promise<ValidatedOriginPolicy> {
    const originResult = await this.#run(EFFECTIVE_ORIGIN_CONFIG_COMMANDS.urls);
    const urls = parseNulValues(originResult.stdout);
    const keysResult = await this.#run(EFFECTIVE_ORIGIN_CONFIG_COMMANDS.keys);
    const refspecResult = await this.#run(EFFECTIVE_ORIGIN_CONFIG_COMMANDS.fetchRefspecs);
    return validateEffectiveOriginConfig({
      urls,
      keys: parseNulValues(keysResult.stdout, { allowEmpty: true }),
      fetchRefspecs: parseNulValues(refspecResult.stdout, { allowEmpty: true }),
    });
  }
}
