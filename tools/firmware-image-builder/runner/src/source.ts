import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  validateRecursiveSourcePreparation,
  type RecursiveSourcePreparation,
} from '../../api/src/git/source-resolver.js';
import { GIT_EXECUTABLE, GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS } from '../../api/src/git/git-command.js';
import { canonicalInstant, boundedText, stableRelativePath } from '../../api/src/validation.js';
import { withStateRootSnapshot, type PathAuthorityDependencies, type StateRootAuthority } from '../../config/load.js';
import { validateOriginUrl } from '../../config/origin-policy.js';
import { BuilderError } from '../../domain/errors.js';
import type { BuilderErrorCode } from '../../domain/types.js';

const execFile = promisify(execFileCallback);
const SHA40 = /^[0-9a-f]{40}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
// Git runs in a child process, so pathname capabilities must name this runner's
// retained descriptors rather than the child's unrelated /proc/self/fd table.
const PROC_FD = `/proc/${String(process.pid)}/fd`;
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const SOURCE_FILE_FLAGS = READ_FLAGS | fsConstants.O_NONBLOCK;
const SOURCE_COMPONENT_PATHS = Object.freeze(['feeds/chirpstack-openwrt-feed', 'openwrt'] as const);
const SAFE_FILTER_DRIVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_TREE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SOURCE_TREE_RECORD = /^(040000 tree|100644 blob|100755 blob|120000 blob|160000 commit) ([0-9a-f]{40})\t(.+)$/u;
const SOURCE_TREE_MODES = Object.freeze(['040000', '100644', '100755', '120000', '160000'] as const);
const SOURCE_TREE_TYPES = Object.freeze(['tree', 'blob', 'commit'] as const);

export const SOURCE_GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_ATTR_GLOBAL: '/dev/null',
  GIT_ATTR_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'protocol.allow',
  GIT_CONFIG_VALUE_1: 'never',
  GIT_CONFIG_KEY_2: 'core.fsmonitor',
  GIT_CONFIG_VALUE_2: 'false',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
} as const);

export interface PersistedSourceMetadata {
  readonly sourceRemote: string;
  readonly sourceRef: string;
  readonly sourceBranch: string;
  readonly branch: string;
  readonly pinnedSha: string;
  readonly sourceCommitTime: string;
  readonly sourceAuthor: string;
  readonly sourceSubject: string;
  readonly sourcePreparation: RecursiveSourcePreparation;
}

export interface SourceTarget {
  readonly openwrtTarget: string;
}

export interface SourceCommandEvidence {
  readonly argv: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputLimit: boolean;
}

export interface SourceGitResult extends SourceCommandEvidence {
  readonly stdout: string;
  readonly stderr: string;
}

export interface SourceGitCommand {
  run(args: readonly string[], options: {
    readonly cwd: string;
    readonly maxOutputBytes?: number;
  }): Promise<SourceGitResult>;
}

export interface SourceComponentObservation {
  readonly path: (typeof SOURCE_COMPONENT_PATHS)[number];
  readonly treeId: string;
  readonly provenanceUrl: string;
}

export interface SourceSetupResult {
  readonly workspacePath: string;
  readonly commands: readonly SourceCommandEvidence[];
  readonly observations: {
    readonly remoteUrl: string;
    readonly sourceRef: string;
    readonly branch: string;
    readonly pinnedSha: string;
    readonly commitTime: string;
    readonly author: string;
    readonly subject: string;
    readonly worktreeHead: string;
    readonly worktreeClean: boolean;
    readonly dirtyStatus: string;
    readonly components: readonly SourceComponentObservation[];
    readonly remoteRefWarning: 'runner-offline-source-ref-not-rechecked';
    readonly targetOutputAbsent: true;
    readonly checkedTargetOutputPath: string;
  };
}

export interface SourceSetupInput {
  readonly repositoryPath: string;
  readonly stateRoot: StateRootAuthority;
  readonly jobId: string;
  readonly source: PersistedSourceMetadata;
  readonly target: SourceTarget;
  readonly git?: SourceGitCommand;
  readonly requestId?: string;
  readonly now?: () => string;
}

interface SourceExecReply {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut?: boolean;
  readonly outputLimit?: boolean;
}

export type SourceGitExecFile = (
  executable: string,
  argv: readonly string[],
  options: Readonly<Record<string, unknown>>,
) => Promise<SourceExecReply>;

type SourcePhase = 'identity' | 'preparation' | 'workspace' | 'target' | 'verification';

class SourceCommandFailure extends Error {
  readonly result: SourceGitResult;
  readonly phase: SourcePhase;

  constructor(result: SourceGitResult, phase: SourcePhase, options?: ErrorOptions) {
    super('trusted source Git command failed', options);
    this.name = 'SourceCommandFailure';
    this.result = result;
    this.phase = phase;
  }
}

interface DirectoryBinding {
  readonly handle: FileHandle;
  readonly parent: FileHandle | null;
  readonly basename: string | null;
  readonly device: number;
  readonly inode: number;
}

type SourceTreeMode = (typeof SOURCE_TREE_MODES)[number];
type SourceTreeType = (typeof SOURCE_TREE_TYPES)[number];

interface SourceTreeEntry {
  readonly mode: SourceTreeMode;
  readonly type: SourceTreeType;
  readonly objectId: string;
  readonly path: string;
}

function truncateUtf8(value: string, limit: number): string {
  let result = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > limit) break;
    result += character;
    used += size;
  }
  return result;
}

async function defaultSourceExecFile(executable: string, argv: readonly string[], options: Readonly<Record<string, unknown>>): Promise<SourceExecReply> {
  try {
    const result = await execFile(executable, [...argv], options as Parameters<typeof execFile>[2]);
    return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0, signal: null };
  } catch (error) {
    const failure = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
    };
    return {
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      signal: typeof failure.signal === 'string' ? failure.signal : null,
      timedOut: failure.code === 'ETIMEDOUT' || failure.killed === true,
      outputLimit: failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    };
  }
}

export function createSourceGitCommand(options: {
  readonly execFile?: SourceGitExecFile;
  readonly now?: () => string;
} = {}): SourceGitCommand {
  const execute = options.execFile ?? defaultSourceExecFile;
  const now = options.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async run(args: readonly string[], runOptions: {
      readonly cwd: string;
      readonly maxOutputBytes?: number;
    }): Promise<SourceGitResult> {
      if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.includes('\0'))) throw new TypeError('source Git arguments are invalid');
      if (typeof runOptions.cwd !== 'string' || !runOptions.cwd.startsWith('/') || runOptions.cwd.includes('\0')) throw new TypeError('source Git cwd is invalid');
      const maxOutputBytes = runOptions.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > SOURCE_TREE_MAX_OUTPUT_BYTES) throw new TypeError('source Git output bound is invalid');
      const argv = Object.freeze([GIT_EXECUTABLE, ...args]);
      const startedAt = canonicalInstant(now(), 'source command startedAt');
      let reply: SourceExecReply;
      try {
        reply = await execute(GIT_EXECUTABLE, args, {
          cwd: runOptions.cwd,
          env: SOURCE_GIT_ENV,
          encoding: 'utf8',
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: maxOutputBytes,
          windowsHide: true,
        });
      } catch {
        reply = { stdout: '', stderr: '', exitCode: null, signal: null };
      }
      const finishedAt = canonicalInstant(now(), 'source command finishedAt');
      const stdout = typeof reply.stdout === 'string' ? reply.stdout : '';
      const stderr = typeof reply.stderr === 'string' ? reply.stderr : '';
      const outputLimit = reply.outputLimit === true
        || Buffer.byteLength(stdout, 'utf8') > maxOutputBytes
        || Buffer.byteLength(stderr, 'utf8') > maxOutputBytes;
      return Object.freeze({
        argv,
        startedAt,
        finishedAt,
        exitCode: Number.isSafeInteger(reply.exitCode) ? reply.exitCode : null,
        signal: typeof reply.signal === 'string' ? reply.signal : null,
        timedOut: reply.timedOut === true,
        outputLimit,
        stdout: truncateUtf8(stdout, maxOutputBytes),
        stderr: truncateUtf8(stderr, maxOutputBytes),
      });
    },
  });
}

function attachCommands(error: BuilderError, commands: readonly SourceCommandEvidence[]): BuilderError {
  Object.defineProperty(error, 'commands', {
    configurable: false,
    enumerable: false,
    value: Object.freeze(commands.map((command) => Object.freeze({ ...command, argv: Object.freeze([...command.argv]) }))),
    writable: false,
  });
  return error;
}

function sourceError(input: {
  readonly code: BuilderErrorCode;
  readonly diagnosis: string;
  readonly recovery: string;
  readonly requestId: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>>;
  readonly commands?: readonly SourceCommandEvidence[];
}): BuilderError {
  const error = new BuilderError({
    code: input.code,
    stage: 'source',
    details: input.details ?? {},
    retryable: input.code === 'WORKTREE_CREATE_FAILED',
    requestId: input.requestId,
    diagnosis: input.diagnosis,
    recovery: input.recovery,
  });
  return input.commands === undefined ? error : attachCommands(error, input.commands);
}

function assertJobId(jobId: string): string {
  const value = stableRelativePath(jobId, 'jobId');
  if (value.includes('/')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job ID is not a single safe path segment.', recovery: 'Use the API-issued job ID.', requestId: 'source' });
  return value;
}

function assertAbsolutePath(path: string, field: string, requestId: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.includes('//') || path.split('/').some((part, index) => index > 0 && (part === '.' || part === '..'))) {
    throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: `${field} is not a canonical absolute path.`, recovery: 'Use the configured active checkout.', requestId });
  }
  return path;
}

function assertSource(source: PersistedSourceMetadata, requestId: string): RecursiveSourcePreparation {
  try {
    validateOriginUrl(source.sourceRemote);
    canonicalInstant(source.sourceCommitTime, 'sourceCommitTime');
    boundedText(source.sourceAuthor, 'sourceAuthor');
    boundedText(source.sourceSubject, 'sourceSubject');
  } catch (error) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source identity is invalid.', recovery: 'Re-run source selection and queue a valid persisted source record.', requestId, details: { cause: error instanceof Error ? error.message : String(error) } });
  }
  if (!SHA40.test(source.pinnedSha) || source.branch !== source.sourceBranch || !SAFE_BRANCH.test(source.sourceBranch) || source.sourceBranch.includes('..') || source.sourceBranch.endsWith('/') || source.sourceBranch.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source branch or SHA is invalid.', recovery: 'Re-run source selection and queue a valid commit.', requestId });
  }
  if (source.sourceRef !== `refs/remotes/origin/${source.sourceBranch}` || source.sourceRef.includes('\0')) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source ref is invalid.', recovery: 'Re-run source selection and queue a valid remote ref.', requestId });
  }
  try {
    return validateRecursiveSourcePreparation(source.sourcePreparation, source.pinnedSha);
  } catch (error) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The API source preparation record is invalid.', recovery: 'Re-run API source preparation and queue a new job.', requestId, details: { phase: 'preparation' } });
  }
}

function assertTarget(target: SourceTarget, requestId: string): { readonly path: string; readonly segments: readonly string[] } {
  if (typeof target.openwrtTarget !== 'string' || target.openwrtTarget.length === 0 || target.openwrtTarget.includes('\\') || target.openwrtTarget.includes('\0')) {
    throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The manifest OpenWrt target path is invalid.', recovery: 'Use the validated target manifest.', requestId });
  }
  const segments = ['openwrt', 'bin', 'targets', ...target.openwrtTarget.split('/')];
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The manifest OpenWrt target path is unsafe.', recovery: 'Use the validated target manifest.', requestId });
  }
  return Object.freeze({ path: `${segments.join('/')}/`, segments: Object.freeze(segments) });
}

function procChild(parent: FileHandle, basename: string): string {
  return join(PROC_FD, String(parent.fd), basename);
}

async function bindDirectory(handle: FileHandle, parent: FileHandle | null, basename: string | null): Promise<DirectoryBinding> {
  const stats = await handle.stat();
  if (!stats.isDirectory()) throw new Error('directory binding is not a directory');
  return Object.freeze({ handle, parent, basename, device: stats.dev, inode: stats.ino });
}

async function openOrCreateDirectory(parent: FileHandle, basename: string): Promise<FileHandle> {
  try {
    return await open(procChild(parent, basename), DIR_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await mkdir(procChild(parent, basename), { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
    }
    await parent.sync();
    return open(procChild(parent, basename), DIR_FLAGS);
  }
}

async function validateDirectoryBindings(
  bindings: readonly DirectoryBinding[],
  rootPath: string,
  dependencies: PathAuthorityDependencies,
): Promise<void> {
  const leaf = bindings.at(-1);
  if (!leaf) throw new Error('directory authority is empty');
  await dependencies.beforeDirectoryAccess?.(leaf.handle);
  const root = bindings[0]!;
  const namedRoot = await lstat(rootPath);
  if (!namedRoot.isDirectory() || namedRoot.isSymbolicLink() || namedRoot.dev !== root.device || namedRoot.ino !== root.inode) throw new Error('state root binding changed');
  const rootStats = await root.handle.stat();
  if (!rootStats.isDirectory() || rootStats.dev !== root.device || rootStats.ino !== root.inode) throw new Error('held state root changed');
  for (const binding of bindings.slice(1)) {
    const named = await lstat(procChild(binding.parent!, binding.basename!));
    const held = await binding.handle.stat();
    if (!named.isDirectory() || named.isSymbolicLink() || !held.isDirectory() || named.dev !== binding.device || named.ino !== binding.inode || held.dev !== binding.device || held.ino !== binding.inode) {
      throw new Error('state workspace binding changed');
    }
  }
}

async function assertChildAbsent(parent: FileHandle, basename: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(procChild(parent, basename), READ_FLAGS);
    throw new Error('child exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function withWorkspaceAuthority<T>(
  stateRoot: StateRootAuthority,
  jobId: string,
  requestId: string,
  callback: (workspace: {
    readonly path: string;
    readonly destination: string;
    validate(): Promise<void>;
    bindSource(): Promise<FileHandle>;
    inspectTargetAbsent(segments: readonly string[], relativePath: string): Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') {
    throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The host lacks Linux no-follow directory support.', recovery: 'Run the builder on the supported host.', requestId });
  }
  return withStateRootSnapshot(stateRoot, async ({ snapshot, dependencies }) => {
    const handles: FileHandle[] = [];
    const bindings: DirectoryBinding[] = [];
    try {
      let current = await open(snapshot.path, DIR_FLAGS);
      handles.push(current);
      bindings.push(await bindDirectory(current, null, null));
      if (bindings[0]!.device !== snapshot.device || bindings[0]!.inode !== snapshot.inode) throw new Error('state root identity changed');
      await validateDirectoryBindings(bindings, snapshot.path, dependencies);
      for (const basename of ['jobs', jobId, 'workspace']) {
        await validateDirectoryBindings(bindings, snapshot.path, dependencies);
        current = await openOrCreateDirectory(current, basename);
        handles.push(current);
        bindings.push(await bindDirectory(current, bindings.at(-1)!.handle, basename));
        await validateDirectoryBindings(bindings, snapshot.path, dependencies);
      }
      await validateDirectoryBindings(bindings, snapshot.path, dependencies);
      try {
        await assertChildAbsent(current, 'source');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job-owned source worktree path is a symlink.', recovery: 'Remove the unsafe job-owned path and retry.', requestId });
        if (error instanceof Error && error.message === 'child exists') throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job-owned source worktree path already exists.', recovery: 'Remove the incomplete job-owned worktree and retry.', requestId });
        throw error;
      }
      await validateDirectoryBindings(bindings, snapshot.path, dependencies);
      const workspaceParent = current;
      const workspacePath = join(snapshot.path, 'jobs', jobId, 'workspace', 'source');
      return await callback({
        path: workspacePath,
        destination: procChild(workspaceParent, 'source'),
        validate: async () => validateDirectoryBindings(bindings, snapshot.path, dependencies),
        bindSource: async () => {
          await validateDirectoryBindings(bindings, snapshot.path, dependencies);
          const source = await open(procChild(workspaceParent, 'source'), DIR_FLAGS);
          handles.push(source);
          bindings.push(await bindDirectory(source, workspaceParent, 'source'));
          await validateDirectoryBindings(bindings, snapshot.path, dependencies);
          return source;
        },
        inspectTargetAbsent: async (segments, relativePath) => {
          await validateDirectoryBindings(bindings, snapshot.path, dependencies);
          const source = bindings.at(-1)!.handle;
          const inspectionHandles: FileHandle[] = [];
          const inspectionBindings: DirectoryBinding[] = [];
          let parent = source;
          try {
            for (let index = 0; index < segments.length; index += 1) {
              await validateDirectoryBindings([...bindings, ...inspectionBindings], snapshot.path, dependencies);
              const basename = segments[index]!;
              let child: FileHandle;
              try {
                child = await open(procChild(parent, basename), index === segments.length - 1 ? READ_FLAGS : DIR_FLAGS);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                  await validateDirectoryBindings([...bindings, ...inspectionBindings], snapshot.path, dependencies);
                  return;
                }
                const code = (error as NodeJS.ErrnoException).code;
                if (index === segments.length - 1 && (code === 'ELOOP' || code === 'ENOTDIR')) {
                  throw sourceError({ code: 'BUILD_OUTPUT_COLLISION', diagnosis: 'The exact OpenWrt target output path already exists.', recovery: 'Remove the pre-existing target output from the pinned source and retry.', requestId, details: { path: relativePath } });
                }
                throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree contains an unsafe target-path ancestor.', recovery: 'Use a clean API-prepared pinned source and retry.', requestId, details: { path: relativePath } });
              }
              inspectionHandles.push(child);
              if (index === segments.length - 1) {
                throw sourceError({ code: 'BUILD_OUTPUT_COLLISION', diagnosis: 'The exact OpenWrt target output path already exists.', recovery: 'Remove the pre-existing target output from the pinned source and retry.', requestId, details: { path: relativePath } });
              }
              const binding = await bindDirectory(child, parent, basename);
              inspectionBindings.push(binding);
              parent = child;
              await validateDirectoryBindings([...bindings, ...inspectionBindings], snapshot.path, dependencies);
            }
          } finally {
            for (const handle of inspectionHandles.reverse()) await handle.close().catch(() => undefined);
            await validateDirectoryBindings(bindings, snapshot.path, dependencies);
          }
        },
      });
    } finally {
      for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    }
  });
}

function commandEvidence(result: SourceGitResult): SourceCommandEvidence {
  return Object.freeze({
    argv: Object.freeze([...result.argv]),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimit: result.outputLimit,
  });
}

function commandDetails(failure: SourceCommandFailure): Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>> {
  return {
    phase: failure.phase,
    argv: [...failure.result.argv],
    exitCode: failure.result.exitCode,
    signal: failure.result.signal,
    timedOut: failure.result.timedOut,
    outputLimit: failure.result.outputLimit,
    startedAt: failure.result.startedAt,
    finishedAt: failure.result.finishedAt,
  };
}

function outputLine(result: SourceGitResult, field: string, requestId: string, commands: readonly SourceCommandEvidence[]): string {
  const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  if (value.includes('\n') || value.includes('\r') || value.length === 0) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: `Git returned invalid ${field} evidence.`, recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, commands });
  }
  return value;
}

function metadataFields(result: SourceGitResult, requestId: string, commands: readonly SourceCommandEvidence[]): readonly [string, string, string, string, string] {
  const fields = result.stdout.endsWith('\0') ? result.stdout.slice(0, -1).split('\0') : [];
  if (fields.length !== 5 || fields.some((field) => field.includes('\r') || field.includes('\n'))) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Git returned malformed pinned commit metadata.', recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, commands });
  }
  const epoch = Number(fields[1]);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Git returned an invalid pinned commit timestamp.', recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, commands });
  }
  return [fields[0]!, new Date(epoch * 1_000).toISOString(), fields[2]!, fields[3]!, fields[4]!];
}

function expectedSourceTree(preparation: RecursiveSourcePreparation): string {
  return [
    `100644 blob ${preparation.gitmodulesBlobSha}\t.gitmodules\0`,
    ...preparation.components.map((component) => `040000 tree ${component.objectId}\t${component.path}\0`),
  ].join('');
}

function checkoutFilterDrivers(contents: string): readonly string[] {
  if (contents.includes('\0')) throw new Error('committed checkout attributes are binary');
  const drivers = new Set<string>();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    for (const token of line.trim().split(/\s+/u).slice(1)) {
      if (token === '-filter' || token === '!filter') continue;
      if (token === 'filter') throw new Error('boolean filter attributes are not supported');
      if (token.startsWith('filter=')) {
        const driver = token.slice('filter='.length);
        if (!SAFE_FILTER_DRIVER.test(driver)) throw new Error('filter driver name is unsafe');
        drivers.add(driver);
        continue;
      }
      if (/^(?:ident|eol|working-tree-encoding|crlf)(?:=|$)/u.test(token)
        || /^(?:text|crlf)(?:=|$)/u.test(token)) {
        throw new Error('checkout conversion attributes are not supported');
      }
    }
  }
  return Object.freeze([...drivers].sort());
}

function configuredFilterDrivers(contents: string): readonly string[] {
  if (contents === '') return Object.freeze([]);
  const records = contents.endsWith('\0') ? contents.slice(0, -1).split('\0') : [];
  const drivers = records.map((key) => {
    const match = /^filter\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.(?:clean|smudge|process|required)$/u.exec(key);
    if (match === null) throw new Error('configured filter driver name is unsafe');
    return match[1]!;
  });
  return Object.freeze([...new Set(drivers)].sort());
}

function checkoutConfig(drivers: readonly string[]): readonly string[] {
  return Object.freeze([
    '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'core.symlinks=true',
    '-c', 'core.sparseCheckout=false',
    '-c', 'core.sparseCheckoutCone=false',
    ...drivers.flatMap((driver) => [
      '-c', `filter.${driver}.clean=`,
      '-c', `filter.${driver}.smudge=`,
      '-c', `filter.${driver}.process=`,
      '-c', `filter.${driver}.required=false`,
    ]),
  ]);
}

function parseSourceTree(contents: string, preparation: RecursiveSourcePreparation): ReadonlyMap<string, SourceTreeEntry> {
  if (!contents.endsWith('\0')) throw new Error('pinned tree manifest is not NUL terminated');
  const entries = new Map<string, SourceTreeEntry>();
  for (const record of contents.slice(0, -1).split('\0')) {
    const match = SOURCE_TREE_RECORD.exec(record);
    if (match === null) throw new Error('pinned tree contains an unsupported mode, type, or malformed entry');
    const mode = match[1]!.slice(0, 6) as SourceTreeMode;
    const type = match[1]!.slice(7) as SourceTreeType;
    const objectId = match[2]!;
    const path = stableRelativePath(match[3]!, 'pinned tree path');
    if (path === '.git' || path.startsWith('.git/') || entries.has(path)) throw new Error('pinned tree contains an unsafe or duplicate path');
    entries.set(path, Object.freeze({ mode, type, objectId, path }));
  }
  if (entries.size === 0) throw new Error('pinned tree is empty');

  for (const entry of entries.values()) {
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = entries.get(segments.slice(0, index).join('/'));
      if (parent?.mode !== '040000' || parent.type !== 'tree') throw new Error('pinned tree directory structure is incoherent');
    }
    if (entry.mode === '160000') {
      const prepared = preparation.components.find((component) => component.path === entry.path);
      if (prepared === undefined || prepared.objectId !== entry.objectId) {
        throw new Error('pinned tree contains an unprepared gitlink declaration');
      }
    }
  }

  for (const component of preparation.components) {
    const entry = entries.get(component.path);
    if (entry?.mode !== '040000' || entry.type !== 'tree' || entry.objectId !== component.objectId) {
      throw new Error('prepared vendored component is not the exact pinned tree declaration');
    }
  }
  return entries;
}

async function validateMaterializedBindings(
  bindings: readonly DirectoryBinding[],
  validateAuthority: () => Promise<void>,
): Promise<void> {
  await validateAuthority();
  for (const binding of bindings) {
    const named = await lstat(procChild(binding.parent!, binding.basename!));
    const held = await binding.handle.stat();
    if (!named.isDirectory() || named.isSymbolicLink() || !held.isDirectory()
      || named.dev !== binding.device || named.ino !== binding.inode
      || held.dev !== binding.device || held.ino !== binding.inode) {
      throw new Error('materialized source directory binding changed');
    }
  }
  await validateAuthority();
}

async function gitBlobHash(handle: FileHandle, size: number): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('materialized source file size is invalid');
  const hash = createHash('sha1');
  hash.update(`blob ${String(size)}\0`);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const result = await handle.read(buffer, 0, length, offset);
    if (result.bytesRead === 0) throw new Error('materialized source file ended before its declared size');
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  return hash.digest('hex');
}

function gitBlobHashBuffer(contents: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(contents.length)}\0`)
    .update(contents)
    .digest('hex');
}

async function verifyMaterializedRegularFile(
  parent: FileHandle,
  basename: string,
  entry: SourceTreeEntry,
  bindings: readonly DirectoryBinding[],
  validateAuthority: () => Promise<void>,
): Promise<void> {
  await validateMaterializedBindings(bindings, validateAuthority);
  let handle: FileHandle | undefined;
  try {
    const path = procChild(parent, basename);
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('materialized source blob is not a regular file');
    handle = await open(path, SOURCE_FILE_FLAGS);
    const named = await lstat(path);
    const before = await handle.stat();
    if (!named.isFile() || named.isSymbolicLink() || !before.isFile()
      || named.dev !== before.dev || named.ino !== before.ino) {
      throw new Error('materialized source blob is not a bound regular file');
    }
    const materializedMode = (before.mode & 0o111) === 0 ? '100644' : '100755';
    if (materializedMode !== entry.mode) throw new Error('materialized source file mode differs from the pinned tree');
    const objectId = await gitBlobHash(handle, before.size);
    const after = await handle.stat();
    const finalNamed = await lstat(path);
    const finalMode = (after.mode & 0o111) === 0 ? '100644' : '100755';
    if (!finalNamed.isFile() || finalNamed.isSymbolicLink() || !after.isFile()
      || finalNamed.dev !== after.dev || finalNamed.ino !== after.ino
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || finalMode !== entry.mode || objectId !== entry.objectId) {
      throw new Error('materialized source file contents differ from the pinned blob');
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await validateMaterializedBindings(bindings, validateAuthority);
  }
}

async function verifyMaterializedSymlink(
  parent: FileHandle,
  basename: string,
  entry: SourceTreeEntry,
  bindings: readonly DirectoryBinding[],
  validateAuthority: () => Promise<void>,
): Promise<void> {
  await validateMaterializedBindings(bindings, validateAuthority);
  const path = procChild(parent, basename);
  const before = await lstat(path);
  if (!before.isSymbolicLink()) throw new Error('materialized source symlink became another file type');
  const target = await readlink(path, { encoding: 'buffer' });
  const after = await lstat(path);
  if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
    || gitBlobHashBuffer(target) !== entry.objectId) {
    throw new Error('materialized source symlink target differs from the pinned blob');
  }
  await validateMaterializedBindings(bindings, validateAuthority);
}

async function verifyMaterializedDirectory(
  parent: FileHandle,
  basename: string,
  expected: SourceTreeEntry,
  manifest: ReadonlyMap<string, SourceTreeEntry>,
  seen: Set<string>,
  bindings: readonly DirectoryBinding[],
  validateAuthority: () => Promise<void>,
): Promise<void> {
  await validateMaterializedBindings(bindings, validateAuthority);
  const handle = await open(procChild(parent, basename), DIR_FLAGS);
  const binding = await bindDirectory(handle, parent, basename);
  const childBindings = [...bindings, binding];
  try {
    await validateMaterializedBindings(childBindings, validateAuthority);
    const children = await readdir(join(PROC_FD, String(handle.fd)), { withFileTypes: true });
    await validateMaterializedBindings(childBindings, validateAuthority);
    if (expected.mode === '160000') {
      if (children.length !== 0) throw new Error('materialized gitlink declaration contains unprepared files');
      return;
    }
    for (const child of children) {
      const path = `${expected.path}/${child.name}`;
      const entry = manifest.get(path);
      if (entry === undefined || seen.has(path)) throw new Error('materialized source contains an unpinned or duplicate path');
      seen.add(path);
      if (entry.mode === '040000' || entry.mode === '160000') {
        await verifyMaterializedDirectory(handle, child.name, entry, manifest, seen, childBindings, validateAuthority);
      } else if (entry.mode === '120000') {
        await verifyMaterializedSymlink(handle, child.name, entry, childBindings, validateAuthority);
      } else {
        await verifyMaterializedRegularFile(handle, child.name, entry, childBindings, validateAuthority);
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
    await validateMaterializedBindings(bindings, validateAuthority);
  }
}

async function verifyMaterializedTree(
  source: FileHandle,
  manifest: ReadonlyMap<string, SourceTreeEntry>,
  validateAuthority: () => Promise<void>,
): Promise<void> {
  await validateAuthority();
  const children = await readdir(join(PROC_FD, String(source.fd)), { withFileTypes: true });
  await validateAuthority();
  const seen = new Set<string>();
  for (const child of children) {
    if (child.name === '.git') {
      const metadata = await lstat(procChild(source, child.name));
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('detached worktree metadata is unsafe');
      continue;
    }
    const entry = manifest.get(child.name);
    if (entry === undefined || seen.has(entry.path)) throw new Error('materialized source contains an unpinned or duplicate root path');
    seen.add(entry.path);
    if (entry.mode === '040000' || entry.mode === '160000') {
      await verifyMaterializedDirectory(source, child.name, entry, manifest, seen, [], validateAuthority);
    } else if (entry.mode === '120000') {
      await verifyMaterializedSymlink(source, child.name, entry, [], validateAuthority);
    } else {
      await verifyMaterializedRegularFile(source, child.name, entry, [], validateAuthority);
    }
  }
  if (seen.size !== manifest.size || [...manifest.keys()].some((path) => !seen.has(path))) {
    throw new Error('materialized source is missing a pinned tree path');
  }
  await validateAuthority();
}

export async function setupSourceWorktree(input: SourceSetupInput): Promise<SourceSetupResult> {
  const requestId = input.requestId ?? input.jobId;
  const jobId = assertJobId(input.jobId);
  const repositoryPath = assertAbsolutePath(input.repositoryPath, 'repository path', requestId);
  const preparation = assertSource(input.source, requestId);
  const target = assertTarget(input.target, requestId);
  const git = input.git ?? createSourceGitCommand({ now: input.now });
  const commands: SourceCommandEvidence[] = [];
  let phase: SourcePhase = 'identity';

  const run = async (
    args: readonly string[],
    cwd: string,
    commandPhase: SourcePhase,
    validateAuthority?: () => Promise<void>,
    acceptedExitCodes: readonly number[] = [0],
    maxOutputBytes?: number,
  ): Promise<SourceGitResult> => {
    phase = commandPhase;
    await validateAuthority?.();
    let result: SourceGitResult;
    try {
      result = await git.run(args, { cwd, ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) });
    } catch (error) {
      const timestamp = canonicalInstant(input.now?.() ?? new Date().toISOString(), 'source command failure');
      result = Object.freeze({
        argv: Object.freeze([GIT_EXECUTABLE, ...args]),
        startedAt: timestamp,
        finishedAt: timestamp,
        exitCode: null,
        signal: null,
        timedOut: false,
        outputLimit: false,
        stdout: '',
        stderr: '',
      });
      commands.push(commandEvidence(result));
      throw new SourceCommandFailure(result, commandPhase, { cause: error });
    }
    commands.push(commandEvidence(result));
    await validateAuthority?.();
    if (result.exitCode === null || !acceptedExitCodes.includes(result.exitCode) || result.signal !== null || result.timedOut || result.outputLimit) throw new SourceCommandFailure(result, commandPhase);
    return result;
  };

  try {
    await run(['cat-file', '-e', '--end-of-options', `${input.source.pinnedSha}^{commit}`], repositoryPath, 'identity');
    const remoteUrl = outputLine(await run(['remote', 'get-url', 'origin'], repositoryPath, 'identity'), 'origin URL', requestId, commands);
    if (remoteUrl !== input.source.sourceRemote) {
      throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The active checkout origin URL differs from the persisted source record.', recovery: 'Restore the configured origin and queue a new pinned source.', requestId, details: { expected: input.source.sourceRemote, observed: remoteUrl }, commands });
    }
    const [fullSha, commitTime, authorName, authorEmail, subject] = metadataFields(await run([
      'show',
      '--no-patch',
      '--format=format:%H%x00%ct%x00%an%x00%ae%x00%s%x00',
      '--end-of-options',
      input.source.pinnedSha,
    ], repositoryPath, 'identity'), requestId, commands);
    const observedAuthor = `${authorName} <${authorEmail}>`;
    if (fullSha !== input.source.pinnedSha || commitTime !== input.source.sourceCommitTime || observedAuthor !== input.source.sourceAuthor || subject !== input.source.sourceSubject) {
      throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Pinned commit identity differs from the persisted source record.', recovery: 'Re-run source selection and queue a commit whose metadata is unchanged.', requestId, details: { expectedSha: input.source.pinnedSha, observedSha: fullSha }, commands });
    }
    phase = 'preparation';
    const observedTree = (await run([
      'ls-tree',
      '-z',
      '--full-tree',
      input.source.pinnedSha,
      '--',
      '.gitmodules',
      'feeds/chirpstack-openwrt-feed',
      'openwrt',
    ], repositoryPath, 'preparation')).stdout;
    if (observedTree !== expectedSourceTree(preparation)) {
      throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The pinned source tree differs from the API preparation record.', recovery: 'Re-run API source preparation and queue a new job.', requestId, details: { phase: 'preparation' }, commands });
    }
    const pinnedTree = parseSourceTree((await run([
      'ls-tree',
      '-r',
      '-t',
      '-z',
      '--full-tree',
      input.source.pinnedSha,
    ], repositoryPath, 'preparation', undefined, [0], SOURCE_TREE_MAX_OUTPUT_BYTES)).stdout, preparation);
    const attributes = await run([
      'grep',
      '-a',
      '-h',
      '-e',
      '^',
      input.source.pinnedSha,
      '--',
      '.gitattributes',
      '*/.gitattributes',
    ], repositoryPath, 'preparation', undefined, [0, 1]);
    const configuredFilters = await run([
      'config',
      '--local',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$',
    ], repositoryPath, 'preparation', undefined, [0, 1]);
    const infoAttributesPath = outputLine(await run([
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/attributes',
    ], repositoryPath, 'preparation'), 'repository info attributes path', requestId, commands);
    try {
      await lstat(infoAttributesPath);
      throw sourceError({
        code: 'SOURCE_NOT_COMMIT',
        diagnosis: 'Repository-local info attributes are not allowed for source checkout.',
        recovery: 'Remove the repository info attributes file and prepare the source again.',
        requestId,
        details: { phase: 'preparation' },
        commands,
      });
    } catch (error) {
      if (error instanceof BuilderError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const conversionConfig = checkoutConfig([
      ...new Set([
        ...checkoutFilterDrivers(attributes.stdout),
        ...configuredFilterDrivers(configuredFilters.stdout),
      ]),
    ].sort());

    return await withWorkspaceAuthority(input.stateRoot, jobId, requestId, async (workspace) => {
      phase = 'workspace';
      await run(['worktree', 'add', '--no-checkout', '--detach', workspace.destination, input.source.pinnedSha], repositoryPath, 'workspace', workspace.validate);
      const sourceHandle = await workspace.bindSource();
      const sourceCwd = join(PROC_FD, String(sourceHandle.fd));
      await run([...conversionConfig, 'read-tree', '--reset', input.source.pinnedSha], sourceCwd, 'workspace', workspace.validate);
      await run([...conversionConfig, 'checkout-index', '--all', '--force', '--ignore-skip-worktree-bits'], sourceCwd, 'workspace', workspace.validate);
      const components: SourceComponentObservation[] = [];
      for (const component of preparation.components) {
        const observed = outputLine(await run(['rev-parse', '--verify', `HEAD:${component.path}`], sourceCwd, 'preparation', workspace.validate), `${component.path} tree`, requestId, commands);
        if (observed !== component.objectId) {
          throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'A prepared source component differs from its API-attested tree.', recovery: 'Remove the incomplete worktree and prepare the source again.', requestId, details: { path: component.path, expected: component.objectId, observed }, commands });
        }
        components.push(Object.freeze({ path: component.path, treeId: observed, provenanceUrl: component.provenanceUrl }));
      }
      phase = 'target';
      await workspace.inspectTargetAbsent(target.segments, target.path);
      phase = 'verification';
      const worktreeHead = outputLine(await run(['rev-parse', '--verify', 'HEAD'], sourceCwd, 'verification', workspace.validate), 'worktree HEAD', requestId, commands);
      if (worktreeHead !== input.source.pinnedSha) {
        throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree HEAD differs from the pinned SHA.', recovery: 'Remove the incomplete job-owned worktree and retry.', requestId, commands });
      }
      const statusResult = await run([...conversionConfig, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], sourceCwd, 'verification', workspace.validate);
      if (statusResult.stdout !== '') {
        throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached recursive source worktree is dirty.', recovery: 'Use a clean API-prepared source commit and retry.', requestId, details: { status: statusResult.stdout }, commands });
      }
      await verifyMaterializedTree(sourceHandle, pinnedTree, workspace.validate);
      await workspace.validate();
      return Object.freeze({
        workspacePath: workspace.path,
        commands: Object.freeze(commands),
        observations: Object.freeze({
          remoteUrl,
          sourceRef: input.source.sourceRef,
          branch: input.source.sourceBranch,
          pinnedSha: input.source.pinnedSha,
          commitTime,
          author: observedAuthor,
          subject,
          worktreeHead,
          worktreeClean: true,
          dirtyStatus: '',
          components: Object.freeze(components),
          remoteRefWarning: 'runner-offline-source-ref-not-rechecked' as const,
          targetOutputAbsent: true as const,
          checkedTargetOutputPath: target.path,
        }),
      });
    });
  } catch (error) {
    if (error instanceof BuilderError) {
      if (!(error as unknown as { commands?: unknown }).commands) attachCommands(error, commands);
      throw error;
    }
    if (error instanceof SourceCommandFailure) {
      const code = error.phase === 'identity' || error.phase === 'preparation' ? 'SOURCE_NOT_COMMIT' : 'WORKTREE_CREATE_FAILED';
      throw sourceError({ code, diagnosis: `The trusted Git ${error.phase} phase failed.`, recovery: 'Restore the API-prepared source and retry the job.', requestId, details: commandDetails(error), commands });
    }
    throw sourceError({ code: phase === 'identity' || phase === 'preparation' ? 'SOURCE_NOT_COMMIT' : 'WORKTREE_CREATE_FAILED', diagnosis: `The source ${phase} phase failed.`, recovery: 'Restore the API-prepared source and retry the job.', requestId, details: { phase }, commands });
  }
}
