import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { withStateRootSnapshot, type StateRootAuthority } from '../../config/load.js';
import { FIXED_GIT_ENV, GIT_EXECUTABLE, GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS } from '../../api/src/git/git-command.js';
import { canonicalInstant, boundedText, stableRelativePath } from '../../api/src/validation.js';
import { BuilderError } from '../../domain/errors.js';
import type { BuilderErrorCode } from '../../domain/types.js';
import { validateOriginUrl } from '../../config/origin-policy.js';
import type { CommandExecutor, CommandResult } from './command-executor.js';

const SHA40 = /^[0-9a-f]{40}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const PROC_FD = '/proc/self/fd';
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const SOURCE_GIT_ENV = Object.freeze({ ...FIXED_GIT_ENV, GIT_ALLOW_PROTOCOL: 'file' });

export interface PersistedSourceMetadata {
  readonly sourceRemote: string;
  readonly sourceRef: string;
  readonly sourceBranch: string;
  readonly branch: string;
  readonly pinnedSha: string;
  readonly sourceCommitTime: string;
  readonly sourceAuthor: string;
  readonly sourceSubject: string;
}

export interface SourceFileSystem {
  readonly lstat: (path: string) => Promise<{ readonly isSymbolicLink: () => boolean; readonly isDirectory: () => boolean }>;
}

export interface SourceTarget { readonly openwrtTarget: string; }

export interface SourceCommandEvidence {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly timedOut?: boolean;
}

export interface SourceSubmoduleObservation {
  readonly path: string;
  readonly sha: string;
  readonly dirty: boolean;
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
    readonly submodules: readonly SourceSubmoduleObservation[];
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
  readonly executor: CommandExecutor;
  readonly fileSystem?: SourceFileSystem;
  readonly requestId?: string;
  readonly now?: () => string;
}

class SourceCommandFailure extends Error {
  readonly result: CommandResult | null;
  readonly argv: readonly string[];
  readonly phase: SourcePhase;

  constructor(argv: readonly string[], result: CommandResult | null, phase: SourcePhase, options?: ErrorOptions) {
    super('trusted Git command failed', options);
    this.name = 'SourceCommandFailure';
    this.argv = argv;
    this.result = result;
    this.phase = phase;
  }
}

type SourcePhase = 'identity' | 'workspace' | 'submodules' | 'target' | 'verification';

function attachCommands(error: BuilderError, commands: readonly SourceCommandEvidence[]): BuilderError {
  Object.defineProperty(error, 'commands', { configurable: false, enumerable: false, value: Object.freeze(commands.map((command) => Object.freeze({ ...command, argv: Object.freeze([...command.argv]) }))), writable: false });
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
  const error = new BuilderError({ code: input.code, stage: 'source', details: input.details ?? {}, retryable: input.code === 'WORKTREE_CREATE_FAILED', requestId: input.requestId, diagnosis: input.diagnosis, recovery: input.recovery });
  return input.commands === undefined ? error : attachCommands(error, input.commands);
}

function assertJobId(jobId: string): string {
  const value = stableRelativePath(jobId, 'jobId');
  if (value.includes('/')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job ID is not a single safe path segment.', recovery: 'Use the API-issued job ID.', requestId: 'source' });
  return value;
}

function assertAbsolutePath(path: string, field: string, requestId: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.includes('//') || path.split('/').some((part, index) => index > 0 && (part === '.' || part === '..'))) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: `${field} is not a canonical absolute path.`, recovery: 'Use the configured active checkout.', requestId });
  return path;
}

function assertSource(source: PersistedSourceMetadata, requestId: string): void {
  try { validateOriginUrl(source.sourceRemote); canonicalInstant(source.sourceCommitTime, 'sourceCommitTime'); boundedText(source.sourceAuthor, 'sourceAuthor'); boundedText(source.sourceSubject, 'sourceSubject'); }
  catch (error) { throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source identity is invalid.', recovery: 'Re-run source selection and queue a valid persisted source record.', requestId, details: { cause: error instanceof Error ? error.message : String(error) } }); }
  if (!SHA40.test(source.pinnedSha) || source.branch !== source.sourceBranch || !SAFE_BRANCH.test(source.sourceBranch) || source.sourceBranch.includes('..') || source.sourceBranch.endsWith('/') || source.sourceBranch.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.startsWith('.'))) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source branch or SHA is invalid.', recovery: 'Re-run source selection and queue a valid commit.', requestId });
  if (source.sourceRef !== `refs/remotes/origin/${source.sourceBranch}` || source.sourceRef.includes('\0')) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source ref is invalid.', recovery: 'Re-run source selection and queue a valid remote ref.', requestId });
}

function assertTarget(target: SourceTarget, requestId: string): string {
  if (typeof target.openwrtTarget !== 'string' || target.openwrtTarget.length === 0 || target.openwrtTarget.includes('\\') || target.openwrtTarget.includes('\0')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The manifest OpenWrt target path is invalid.', recovery: 'Use the validated target manifest.', requestId });
  const segments = target.openwrtTarget.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The manifest OpenWrt target path is unsafe.', recovery: 'Use the validated target manifest.', requestId });
  return `openwrt/bin/targets/${target.openwrtTarget}/`;
}

function commandDetails(failure: SourceCommandFailure): Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>> {
  return { phase: failure.phase, argv: [...failure.argv], exitCode: failure.result?.exitCode ?? null, signal: failure.result?.signal ?? null, timedOut: failure.result?.timedOut ?? false };
}

function outputLine(result: CommandResult, field: string, requestId: string, commands: readonly SourceCommandEvidence[]): string {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: `Git could not read ${field}.`, recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, details: { argv: [...result.argv], exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut }, commands });
  const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  if (value.includes('\n') || value.includes('\r') || value.length === 0) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: `Git returned invalid ${field} evidence.`, recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, commands });
  return value;
}

function metadataFields(result: CommandResult, requestId: string, commands: readonly SourceCommandEvidence[]): readonly [string, string, string, string, string] {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Git could not read pinned commit metadata.', recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, commands });
  const fields = result.stdout.endsWith('\0') ? result.stdout.slice(0, -1).split('\0') : [];
  if (fields.length !== 5 || fields.some((field) => field.includes('\r') || field.includes('\n'))) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Git returned malformed pinned commit metadata.', recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, commands });
  const epoch = Number(fields[1]);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Git returned an invalid pinned commit timestamp.', recovery: 'Restore the API-prepared pinned source and retry the job.', requestId, commands });
  return [fields[0]!, new Date(epoch * 1_000).toISOString(), fields[2]!, fields[3]!, fields[4]!];
}

async function inspectTargetPath(workspacePath: string, relativePath: string, fileSystem: SourceFileSystem, requestId: string): Promise<void> {
  const segments = relativePath.replace(/\/$/u, '').split('/');
  let current = workspacePath;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    try {
      const stats = await fileSystem.lstat(current);
      if (stats.isSymbolicLink()) {
        if (index === segments.length - 1) throw sourceError({ code: 'BUILD_OUTPUT_COLLISION', diagnosis: 'The exact OpenWrt target output path already exists as a symlink.', recovery: 'Remove the pre-existing target output from the pinned source and retry.', requestId, details: { path: relativePath } });
        throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree contains an unsafe symlink in the target path.', recovery: 'Use a clean API-prepared pinned source and retry.', requestId, details: { path: relativePath } });
      }
      if (index < segments.length - 1 && !stats.isDirectory()) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree target path is not a directory.', recovery: 'Use a clean API-prepared pinned source and retry.', requestId, details: { path: relativePath } });
      if (index === segments.length - 1) throw sourceError({ code: 'BUILD_OUTPUT_COLLISION', diagnosis: 'The exact OpenWrt target output directory already exists.', recovery: 'Remove the pre-existing target output from the pinned source and retry.', requestId, details: { path: relativePath } });
    } catch (error) {
      if (error instanceof BuilderError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree target path could not be inspected.', recovery: 'Restore the job-owned worktree and retry.', requestId, details: { path: relativePath } });
    }
  }
}

function parseSubmodules(output: string, requestId: string, commands: readonly SourceCommandEvidence[]): readonly SourceSubmoduleObservation[] {
  const observations = output.split('\n').filter(Boolean).map((line) => {
    const match = /^([ +-U])([0-9a-f]{40})\s+(\S+)(?:\s+\(.+\))?$/u.exec(line);
    if (!match) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'Git returned malformed recursive submodule status.', recovery: 'Use an API-prepared recursive source commit and retry.', requestId, commands });
    return { path: match[3]!, sha: match[2]!, dirty: match[1] !== ' ' };
  });
  if (observations.filter((entry) => entry.path === 'openwrt').length !== 1 || observations.some((entry) => entry.dirty) || new Set(observations.map((entry) => entry.path)).size !== observations.length) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'Recursive submodules are absent, dirty, duplicated, or not at their pinned gitlink SHA.', recovery: 'Prepare every recursive submodule commit through the API and retry.', requestId, commands });
  return observations;
}

async function createWorkspace(stateRoot: StateRootAuthority, jobId: string): Promise<string> {
  return withStateRootSnapshot(stateRoot, async ({ snapshot }) => {
    if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The host lacks Linux no-follow directory support.', recovery: 'Run the builder on the supported host.', requestId: jobId });
    const handles: FileHandle[] = [];
    try {
      let current = await open(snapshot.path, DIR_FLAGS);
      handles.push(current);
      const identity = await current.stat();
      if (!identity.isDirectory() || identity.dev !== snapshot.device || identity.ino !== snapshot.inode) throw new Error('state root identity changed');
      for (const part of ['jobs', jobId, 'workspace']) {
        let next: FileHandle;
        try { next = await open(join(PROC_FD, String(current.fd), part), DIR_FLAGS); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await mkdir(join(PROC_FD, String(current.fd), part), { mode: 0o700 });
          await current.sync();
          next = await open(join(PROC_FD, String(current.fd), part), DIR_FLAGS);
        }
        handles.push(next);
        current = next;
      }
      const workspacePath = join(snapshot.path, 'jobs', jobId, 'workspace', 'source');
      try { await open(join(PROC_FD, String(current.fd), 'source'), DIR_FLAGS).then((handle) => handle.close().then(() => { throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job-owned source worktree path already exists.', recovery: 'Remove the incomplete job-owned worktree and retry.', requestId: jobId }); })); }
      catch (error) {
        if (error instanceof BuilderError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job-owned source worktree path is a symlink.', recovery: 'Remove the unsafe job-owned path and retry.', requestId: jobId });
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return workspacePath;
    } finally { for (const handle of handles.reverse()) await handle.close().catch(() => undefined); }
  });
}

export async function setupSourceWorktree(input: SourceSetupInput): Promise<SourceSetupResult> {
  const requestId = input.requestId ?? input.jobId;
  const jobId = assertJobId(input.jobId);
  const repositoryPath = assertAbsolutePath(input.repositoryPath, 'repository path', requestId);
  assertSource(input.source, requestId);
  const checkedTargetOutputPath = assertTarget(input.target, requestId);
  const fileSystem: SourceFileSystem = input.fileSystem ?? { lstat: async (path) => lstat(path) };
  const commands: SourceCommandEvidence[] = [];
  let phase: SourcePhase = 'identity';
  const run = async (args: readonly string[], cwd: string, commandPhase: SourcePhase): Promise<CommandResult> => {
    phase = commandPhase;
    const argv = Object.freeze([GIT_EXECUTABLE, ...args]);
    let result: CommandResult;
    try { result = await input.executor.run(argv, { cwd, env: SOURCE_GIT_ENV, timeoutMs: GIT_TIMEOUT_MS, maxCaptureBytes: GIT_MAX_OUTPUT_BYTES }); }
    catch (error) {
      const failed = error as { readonly result?: CommandResult | null };
      result = failed.result ?? { argv, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: input.now?.() ?? new Date().toISOString(), finishedAt: input.now?.() ?? new Date().toISOString() };
      commands.push({ argv, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut });
      throw new SourceCommandFailure(argv, result, commandPhase, { cause: error });
    }
    commands.push({ argv, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut });
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw new SourceCommandFailure(argv, result, commandPhase);
    return result;
  };
  let workspacePath = '';
  try {
    await run(['cat-file', '-e', '--end-of-options', `${input.source.pinnedSha}^{commit}`], repositoryPath, 'identity');
    const remoteUrl = outputLine(await run(['remote', 'get-url', 'origin'], repositoryPath, 'identity'), 'origin URL', requestId, commands);
    if (remoteUrl !== input.source.sourceRemote) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The active checkout origin URL differs from the persisted source record.', recovery: 'Restore the configured origin and queue a new pinned source.', requestId, details: { expected: input.source.sourceRemote, observed: remoteUrl }, commands });
    const [fullSha, commitTime, authorName, authorEmail, subject] = metadataFields(await run(['show', '--no-patch', '--format=format:%H%x00%ct%x00%an%x00%ae%x00%s%x00', '--end-of-options', input.source.pinnedSha], repositoryPath, 'identity'), requestId, commands);
    const observedAuthor = `${authorName} <${authorEmail}>`;
    if (fullSha !== input.source.pinnedSha || commitTime !== input.source.sourceCommitTime || observedAuthor !== input.source.sourceAuthor || subject !== input.source.sourceSubject) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Pinned commit identity differs from the persisted source record.', recovery: 'Re-run source selection and queue a commit whose metadata is unchanged.', requestId, details: { expectedSha: input.source.pinnedSha, observedSha: fullSha }, commands });
    phase = 'workspace';
    workspacePath = await createWorkspace(input.stateRoot, jobId);
    if (relative(workspacePath, join(workspacePath, checkedTargetOutputPath)).startsWith('..')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The target path escapes the detached worktree.', recovery: 'Use the validated target manifest.', requestId, commands });
    await run(['worktree', 'add', '--detach', workspacePath, input.source.pinnedSha], repositoryPath, 'workspace');
    phase = 'submodules';
    await run(['submodule', 'update', '--init', '--recursive', '--no-fetch'], workspacePath, 'submodules');
    const modulesFile = await run(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..+\\.url$'], workspacePath, 'submodules');
    const moduleUrls = modulesFile.stdout.split('\n').filter(Boolean).map((line) => line.split(/\s+/, 2)[1] ?? '');
    if (moduleUrls.length === 0 || moduleUrls.some((url) => !/^https:\/\//u.test(url))) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The recursive source .gitmodules file is not the validated HTTPS shape.', recovery: 'Validate and pre-prepare recursive submodule commits through the API.', requestId, commands });
    const submodules = parseSubmodules((await run(['submodule', 'status', '--recursive'], workspacePath, 'submodules')).stdout, requestId, commands);
    phase = 'target';
    await inspectTargetPath(workspacePath, checkedTargetOutputPath, fileSystem, requestId);
    phase = 'verification';
    const worktreeHead = outputLine(await run(['rev-parse', '--verify', 'HEAD'], workspacePath, 'verification'), 'worktree HEAD', requestId, commands);
    if (worktreeHead !== input.source.pinnedSha) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree HEAD differs from the pinned SHA.', recovery: 'Remove the incomplete job-owned worktree and retry.', requestId, commands });
    const statusResult = await run(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], workspacePath, 'verification');
    if (statusResult.stdout !== '') throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached recursive worktree is dirty.', recovery: 'Use a clean API-prepared source commit and retry.', requestId, details: { status: statusResult.stdout }, commands });
    return Object.freeze({ workspacePath, commands: Object.freeze(commands), observations: Object.freeze({ remoteUrl, sourceRef: input.source.sourceRef, branch: input.source.sourceBranch, pinnedSha: input.source.pinnedSha, commitTime, author: observedAuthor, subject, worktreeHead, worktreeClean: true, dirtyStatus: '', submodules: Object.freeze(submodules), remoteRefWarning: 'runner-offline-source-ref-not-rechecked' as const, targetOutputAbsent: true as const, checkedTargetOutputPath }) });
  } catch (error) {
    if (error instanceof BuilderError) { if (!(error as unknown as { commands?: unknown }).commands) attachCommands(error, commands); throw error; }
    if (error instanceof SourceCommandFailure) {
      const code = error.phase === 'identity' ? 'SOURCE_NOT_COMMIT' : 'WORKTREE_CREATE_FAILED';
      throw sourceError({ code, diagnosis: `The trusted Git ${error.phase} phase failed.`, recovery: 'Restore the API-prepared source and retry the job.', requestId, details: commandDetails(error), commands });
    }
    throw sourceError({ code: phase === 'identity' ? 'SOURCE_NOT_COMMIT' : 'WORKTREE_CREATE_FAILED', diagnosis: `The source ${phase} phase failed.`, recovery: 'Restore the API-prepared source and retry the job.', requestId, commands });
  }
}

export { SOURCE_GIT_ENV };
