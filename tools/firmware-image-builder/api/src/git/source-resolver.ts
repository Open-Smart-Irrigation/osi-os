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

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REMOTE_NAME = 'origin';
const MAX_BRANCH_BYTES = 255;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_REF_COUNT = 1000;
const NUL = '\0';

export interface GitExecutor {
  run(argv: readonly string[], options?: GitRunOptions): Promise<GitProcessResult>;
}

export interface SourceResolverOptions {
  readonly repositoryPath: string;
  readonly remote?: typeof REMOTE_NAME;
  readonly git?: GitExecutor;
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
}

export interface RunnerPinnedSource {
  readonly branch: string;
  readonly sha: string;
  readonly commitTime: string;
  readonly author: string;
  readonly subject: string;
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

export class SourceResolver {
  readonly #repositoryPath: string;
  readonly #git: GitExecutor;
  readonly #now: () => string;

  constructor(options: SourceResolverOptions) {
    if (options.remote !== undefined && options.remote !== REMOTE_NAME) throw new SourceResolverError('INVALID_REMOTE');
    if (typeof options.repositoryPath !== 'string' || !options.repositoryPath.startsWith('/') || hasControl(options.repositoryPath)) throw new TypeError('Repository path must be an absolute path without control characters.');
    this.#repositoryPath = options.repositoryPath;
    this.#git = options.git ?? new GitCommand();
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
    });
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
    const metadata = immutable(await this.#readMetadata(observedSha, true, originUrl, branch));
    if (observedSha !== expectedSha) throw new SourceResolverError('BRANCH_MOVED', { expectedSha, observedSha, branch });
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

  async #readMetadata(sha: string, complete: boolean, originUrl = '', branch = ''): Promise<GitResolutionMetadata> {
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
