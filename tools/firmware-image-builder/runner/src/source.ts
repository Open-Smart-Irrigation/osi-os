import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';

import { BuilderError } from '../../domain/errors.js';
import { FIXED_GIT_ENV, GIT_EXECUTABLE, type GitProcessResult } from '../../api/src/git/git-command.js';
import { validateOriginUrl } from '../../config/origin-policy.js';
import { isTrustedOperationId, type BuilderErrorCode, type TrustedOperationId } from '../../domain/types.js';
import type { CommandExecutor, CommandResult } from './command-executor.js';

const SHA40 = /^[0-9a-f]{40}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SOURCE_GIT_ENV = Object.freeze({
  ...FIXED_GIT_ENV,
  GIT_SSH_COMMAND: '/usr/bin/ssh -oBatchMode=yes -oIdentitiesOnly=no',
  GIT_SSH_VARIANT: 'ssh',
});

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
  readonly mkdir?: (path: string, options: { readonly recursive: true }) => Promise<void>;
}

export interface SourceTarget {
  readonly openwrtTarget: string;
}

export interface SourceCommandEvidence {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
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
    readonly targetOutputAbsent: true;
    readonly checkedTargetOutputPath: string;
  };
}

export interface SourceSetupInput {
  readonly repositoryPath: string;
  readonly workspacePath: string;
  readonly source: PersistedSourceMetadata;
  readonly target: SourceTarget;
  readonly executor: CommandExecutor;
  readonly fileSystem?: SourceFileSystem;
  readonly jobId?: string;
  readonly requestId?: string;
}

class SourceCommandFailure extends Error {
  readonly result: CommandResult | null;
  readonly argv: readonly string[];

  constructor(argv: readonly string[], result: CommandResult | null, options?: ErrorOptions) {
    super('trusted Git command failed', options);
    this.name = 'SourceCommandFailure';
    this.argv = argv;
    this.result = result;
  }
}

function sourceError(input: {
  readonly code: BuilderErrorCode;
  readonly diagnosis: string;
  readonly recovery: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>>;
  readonly requestId?: string;
}): BuilderError {
  return new BuilderError({
    code: input.code,
    stage: 'source',
    details: input.details ?? {},
    retryable: input.code === 'WORKTREE_CREATE_FAILED',
    requestId: input.requestId ?? 'source',
    diagnosis: input.diagnosis,
    recovery: input.recovery,
  });
}

function assertAbsolutePath(path: string, field: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: `${field} is not an absolute safe path.`, recovery: 'Use the job-owned workspace path supplied by the runner.' });
  return resolve(path);
}

function assertSource(source: PersistedSourceMetadata, requestId: string): void {
  try { validateOriginUrl(source.sourceRemote); } catch (error) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source remote is invalid.', recovery: 'Re-run source selection and queue a valid persisted source record.', requestId, details: { cause: error instanceof Error ? error.message : String(error) } });
  }
  if (!SHA40.test(source.pinnedSha) || source.branch !== source.sourceBranch || !SAFE_BRANCH.test(source.sourceBranch) || source.sourceBranch.includes('..') || source.sourceBranch.endsWith('/') || source.sourceBranch.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source identity is invalid.', recovery: 'Re-run source selection and queue a valid commit.', requestId });
  }
  if (source.sourceRef !== `refs/remotes/origin/${source.sourceBranch}` || source.sourceRef.includes('\0')) {
    throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The persisted source ref is invalid.', recovery: 'Re-run source selection and queue a valid remote ref.', requestId });
  }
  for (const [field, value] of [['sourceCommitTime', source.sourceCommitTime], ['sourceAuthor', source.sourceAuthor], ['sourceSubject', source.sourceSubject]] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/u.test(value) && field !== 'sourceSubject') throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: `The persisted ${field} is invalid.`, recovery: 'Re-run source selection and queue a valid commit.', requestId });
  }
}

function assertTarget(target: SourceTarget, requestId: string): string {
  if (typeof target.openwrtTarget !== 'string' || target.openwrtTarget.length === 0 || target.openwrtTarget.includes('\\') || target.openwrtTarget.includes('\0')) {
    throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The manifest OpenWrt target path is invalid.', recovery: 'Use the validated target manifest.', requestId });
  }
  const segments = target.openwrtTarget.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The manifest OpenWrt target path is unsafe.', recovery: 'Use the validated target manifest.', requestId });
  return `openwrt/bin/targets/${target.openwrtTarget}/`;
}

function outputLine(result: GitProcessResult | CommandResult, field: string, requestId: string): string {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: `Git could not read ${field}.`, recovery: 'Restore the pinned source repository and retry the job.', requestId, details: { argv: [...result.argv], exitCode: result.exitCode, signal: result.signal } });
  const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  if (value.includes('\n') || value.includes('\r') || value.length === 0) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: `Git returned invalid ${field} evidence.`, recovery: 'Restore the pinned source repository and retry the job.', requestId });
  return value;
}

function metadataFields(result: GitProcessResult | CommandResult, requestId: string): readonly [string, string, string, string, string] {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Git could not read the pinned commit metadata.', recovery: 'Restore the pinned source repository and retry the job.', requestId, details: { argv: [...result.argv], exitCode: result.exitCode, signal: result.signal } });
  const fields = result.stdout.endsWith('\0') ? result.stdout.slice(0, -1).split('\0') : [];
  if (fields.length !== 5 || fields.some((field) => field.includes('\r') || field.includes('\n'))) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Git returned malformed pinned commit metadata.', recovery: 'Restore the pinned source repository and retry the job.', requestId });
  return fields as [string, string, string, string, string];
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
        throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree contains an unsafe symlink in the target path.', recovery: 'Use a clean pinned source and retry the job.', requestId, details: { path: relativePath } });
      }
      if (index < segments.length - 1 && !stats.isDirectory()) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree target path is not a directory.', recovery: 'Use a clean pinned source and retry the job.', requestId, details: { path: relativePath } });
      if (index === segments.length - 1) throw sourceError({ code: 'BUILD_OUTPUT_COLLISION', diagnosis: 'The exact OpenWrt target output directory already exists.', recovery: 'Remove the pre-existing target output from the pinned source and retry.', requestId, details: { path: relativePath } });
    } catch (error) {
      if (error instanceof BuilderError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree target path could not be inspected.', recovery: 'Restore the job-owned worktree and retry the job.', requestId, details: { path: relativePath } });
    }
  }
}

function parseSubmodules(output: string): readonly SourceSubmoduleObservation[] {
  return output.split('\n').filter(Boolean).map((line) => {
    const match = /^([ +-U])([0-9a-f]{40})\s+(\S+)(?:\s+\(.+\))?$/u.exec(line);
    if (!match) throw new Error('malformed submodule status');
    return { path: match[3]!, sha: match[2]!, dirty: match[1] !== ' ' };
  });
}

function worktreeFailure(error: unknown, requestId: string): BuilderError {
  if (error instanceof BuilderError) return error;
  const command = error instanceof SourceCommandFailure ? error : undefined;
  return sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached source worktree could not be prepared.', recovery: 'Remove the incomplete job-owned worktree and retry the job.', requestId, details: command === undefined ? {} : { argv: [...command.argv], exitCode: command.result?.exitCode ?? null } });
}

export async function setupSourceWorktree(input: SourceSetupInput): Promise<SourceSetupResult> {
  const requestId = input.requestId ?? input.jobId ?? 'source';
  const repositoryPath = assertAbsolutePath(input.repositoryPath, 'repository path');
  const workspacePath = assertAbsolutePath(input.workspacePath, 'workspace path');
  if (workspacePath === repositoryPath || workspacePath.startsWith(`${repositoryPath}/`) || repositoryPath.startsWith(`${workspacePath}/`)) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job-owned workspace overlaps the active checkout.', recovery: 'Use a workspace outside the active checkout.', requestId });
  assertSource(input.source, requestId);
  const checkedTargetOutputPath = assertTarget(input.target, requestId);
  const targetPath = join(workspacePath, checkedTargetOutputPath);
  if (relative(workspacePath, targetPath).startsWith('..')) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The target path escapes the detached worktree.', recovery: 'Use the validated target manifest.', requestId });
  const fileSystem: SourceFileSystem = input.fileSystem ?? {
    lstat: async (path) => lstat(path),
    mkdir: async (path, options) => { await mkdir(path, options); },
  };
  const commands: SourceCommandEvidence[] = [];
  const run = async (args: readonly string[], cwd: string): Promise<CommandResult> => {
    const argv = Object.freeze([GIT_EXECUTABLE, ...args]);
    let result: CommandResult;
    try { result = await input.executor.run(argv, { cwd, env: SOURCE_GIT_ENV }); }
    catch (error) { throw new SourceCommandFailure(argv, null, { cause: error }); }
    commands.push({ argv, exitCode: result.exitCode });
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw new SourceCommandFailure(argv, result);
    return result;
  };

  try {
    await run(['cat-file', '-e', '--end-of-options', `${input.source.pinnedSha}^{commit}`], repositoryPath);
    const remoteUrl = outputLine(await run(['remote', 'get-url', 'origin'], repositoryPath), 'origin URL', requestId);
    if (remoteUrl !== input.source.sourceRemote) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'The active checkout origin URL differs from the persisted source record.', recovery: 'Restore the configured origin and queue a new pinned source.', requestId, details: { expected: input.source.sourceRemote, observed: remoteUrl } });
    const [fullSha, commitTime, authorName, authorEmail, subject] = metadataFields(await run(['show', '--no-patch', '--format=format:%H%x00%cI%x00%an%x00%ae%x00%s%x00', '--end-of-options', input.source.pinnedSha], repositoryPath), requestId);
    const observedAuthor = `${authorName} <${authorEmail}>`;
    const expectedMetadata: readonly [string, string, string, string, string] = [input.source.pinnedSha, input.source.sourceCommitTime, input.source.sourceAuthor, input.source.sourceSubject, ''];
    const observedMetadata: readonly [string, string, string, string, string] = [fullSha, commitTime, observedAuthor, subject, ''];
    if (fullSha !== expectedMetadata[0] || commitTime !== expectedMetadata[1] || observedAuthor !== expectedMetadata[2] || subject !== expectedMetadata[3]) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'Pinned commit identity differs from the persisted source record.', recovery: 'Re-run source selection and queue a commit whose metadata is unchanged.', requestId, details: { expected: JSON.stringify(expectedMetadata), observed: JSON.stringify(observedMetadata) } });
    try { await fileSystem.lstat(workspacePath); throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The job-owned worktree path already exists.', recovery: 'Remove the incomplete job-owned worktree and retry the job.', requestId }); }
    catch (error) { if (error instanceof BuilderError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw worktreeFailure(error, requestId); }
    if (fileSystem.mkdir) await fileSystem.mkdir(dirname(workspacePath), { recursive: true });
    await run(['worktree', 'add', '--detach', workspacePath, input.source.pinnedSha], repositoryPath);
    await run(['submodule', 'update', '--init', '--recursive'], workspacePath);
    await inspectTargetPath(workspacePath, checkedTargetOutputPath, fileSystem, requestId);
    const worktreeHead = outputLine(await run(['rev-parse', '--verify', 'HEAD'], workspacePath), 'worktree HEAD', requestId);
    if (worktreeHead !== input.source.pinnedSha) throw sourceError({ code: 'WORKTREE_CREATE_FAILED', diagnosis: 'The detached worktree HEAD differs from the pinned SHA.', recovery: 'Remove the incomplete job-owned worktree and retry the job.', requestId, details: { expected: input.source.pinnedSha, observed: worktreeHead } });
    const submodulesResult = await run(['submodule', 'status', '--recursive'], workspacePath);
    const submodules = parseSubmodules(submodulesResult.stdout);
    const statusResult = await run(['status', '--porcelain=v1', '--untracked-files=all'], workspacePath);
    return Object.freeze({
      workspacePath,
      commands: Object.freeze(commands),
      observations: Object.freeze({ remoteUrl, sourceRef: input.source.sourceRef, branch: input.source.sourceBranch, pinnedSha: input.source.pinnedSha, commitTime, author: observedAuthor, subject, worktreeHead, worktreeClean: statusResult.stdout === '', dirtyStatus: statusResult.stdout, submodules: Object.freeze(submodules), targetOutputAbsent: true as const, checkedTargetOutputPath }),
    });
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    if (error instanceof SourceCommandFailure) {
      const identityCommands = commands.length <= 3;
      if (identityCommands) throw sourceError({ code: 'SOURCE_NOT_COMMIT', diagnosis: 'A trusted Git identity check failed.', recovery: 'Restore the pinned source repository and retry the job.', requestId, details: { argv: [...error.argv], exitCode: error.result?.exitCode ?? null } });
      throw worktreeFailure(error, requestId);
    }
    throw worktreeFailure(error, requestId);
  }
}

export { SOURCE_GIT_ENV };
