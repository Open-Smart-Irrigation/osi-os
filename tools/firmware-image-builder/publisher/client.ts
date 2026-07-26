import { createCommandExecutor, type CommandExecutor, type CommandResult, type CommandRunOptions } from '../runner/src/command-executor.js';
import { TARGET_IDS, type BuilderErrorCode, type TargetId } from '../domain/types.js';
import type { ApprovedOutputRoot } from '../config/load.js';

export const PUBLISHER_OPERATION_ERROR_CODES = Object.freeze([
  'OUTPUT_COLLISION',
  'PUBLISH_RECOVERY_FAILED',
  'UNVERIFIED_FINAL_PATH_BLOCKER',
  'QUARANTINE_PENDING',
  'PUBLISH_FAILED',
  'STAGING_FILESYSTEM_MISMATCH',
] as const satisfies readonly BuilderErrorCode[]);

export type PublisherOperationErrorCode = (typeof PUBLISHER_OPERATION_ERROR_CODES)[number];
export type PublisherErrorCode = PublisherOperationErrorCode | 'PUBLISHER_UNSUPPORTED';

export interface PublisherCommandExecutor extends Pick<CommandExecutor, 'run'> {}

export interface PublisherRequest {
  readonly rootId: string;
  readonly jobId: string;
  readonly branchSlug: string;
  readonly sourceSha: string;
  readonly targetId: TargetId;
}

export interface PublisherResponse {
  readonly available: boolean;
  readonly published: boolean;
  readonly quarantined: boolean;
  readonly selfTest: boolean;
  readonly mutationCount: number;
  readonly errorCode?: PublisherErrorCode;
  readonly destination?: 'absent' | 'candidate' | 'mismatched' | 'unknown';
  readonly staging?: 'absent' | 'present' | 'unknown';
  readonly sourceRelativePath?: string;
  readonly destinationRelativePath?: string;
  readonly renameResult?: 'RENAMED' | 'EEXIST' | 'ENOSYS' | 'EOPNOTSUPP' | 'EXDEV' | 'OTHER_ERROR';
  readonly publisherVersion?: string;
  readonly publisherSourceSha256?: string;
}

export interface PublisherClientOptions {
  readonly executable: string;
  readonly approvedRoots: readonly ApprovedOutputRoot[];
  readonly commandExecutor?: PublisherCommandExecutor;
  readonly timeoutMs?: number;
}

export interface PublisherClient {
  publish(request: PublisherRequest): Promise<PublisherResponse>;
  quarantine(request: Pick<PublisherRequest, 'rootId' | 'jobId'>): Promise<PublisherResponse>;
  recheck(request: PublisherRequest): Promise<PublisherResponse>;
}

const ROOT_ID = /^[a-z0-9][a-z0-9-]*$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const BRANCH = /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+$/u;
const SAFE_ABSOLUTE = /^\/(?:[^/\0]+\/)*[^/\0]+$/u;
const FIXED_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });

function validateRoot(root: ApprovedOutputRoot): void {
  const safePath = (value: string): boolean => SAFE_ABSOLUTE.test(value) && !value.includes('\\') && !value.split('/').some((part, index) => index > 0 && (part === '' || part === '.' || part === '..'));
  if (!ROOT_ID.test(root.id) || !safePath(root.path) || !safePath(root.quarantinePath) || root.quarantinePath !== `${root.path}/.osi-image-builder/quarantine`) {
    throw new Error('approved root is invalid');
  }
}

function validateRequest(request: PublisherRequest, root: ApprovedOutputRoot): void {
  if (!JOB_ID.test(request.jobId)) throw new Error('job ID is invalid');
  if (!BRANCH.test(request.branchSlug) || request.branchSlug === '.' || request.branchSlug === '..' || Buffer.byteLength(request.branchSlug, 'utf8') > 255) throw new Error('branch slug is invalid');
  if (!SHA.test(request.sourceSha)) throw new Error('source SHA is invalid');
  if (!(TARGET_IDS as readonly string[]).includes(request.targetId)) throw new Error('target ID is invalid');
  validateRoot(root);
}

const RESULT_FIELDS = new Set(['available', 'published', 'quarantined', 'selfTest', 'mutationCount', 'errorCode', 'destination', 'staging', 'sourceRelativePath', 'destinationRelativePath', 'renameResult', 'publisherVersion', 'publisherSourceSha256']);
const ERROR_CODES = new Set<PublisherErrorCode>([...PUBLISHER_OPERATION_ERROR_CODES, 'PUBLISHER_UNSUPPORTED']);
const BLOCKER_CODES = new Set<PublisherErrorCode>(['PUBLISH_RECOVERY_FAILED', 'UNVERIFIED_FINAL_PATH_BLOCKER']);
const EVIDENCE_FIELDS = ['publisherVersion', 'publisherSourceSha256', 'sourceRelativePath', 'destinationRelativePath', 'renameResult'];
const RENAME_RESULTS = new Set(['RENAMED', 'EEXIST', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV', 'OTHER_ERROR']);
const PUBLISH_PRE_RENAME_ERROR_CODES = new Set<PublisherErrorCode>(['OUTPUT_COLLISION', 'PUBLISH_FAILED', 'STAGING_FILESYSTEM_MISMATCH']);

function own(value: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`publisher result is missing ${key}`);
  return value[key];
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = own(value, key);
  if (typeof field !== 'string' || field.length === 0 || Buffer.byteLength(field, 'utf8') > 4_096) throw new Error(`publisher result field ${key} is invalid`);
  return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = own(value, key);
  if (typeof field !== 'boolean') throw new Error(`publisher result field ${key} is invalid`);
  return field;
}

function validatePathEvidence(value: Record<string, unknown>, sourceRelativePath: string, destinationRelativePath: string): void {
  if (stringField(value, 'publisherVersion') !== '0.1.0') throw new Error('publisher version evidence is invalid');
  if (!/^[0-9a-f]{64}$/u.test(stringField(value, 'publisherSourceSha256'))) throw new Error('publisher source hash evidence is invalid');
  if (stringField(value, 'sourceRelativePath') !== sourceRelativePath) throw new Error('publisher source path evidence is invalid');
  if (stringField(value, 'destinationRelativePath') !== destinationRelativePath) throw new Error('publisher destination path evidence is invalid');
}

function validateRenameEvidence(value: Record<string, unknown>, expected: string): void {
  if (stringField(value, 'renameResult') !== expected) throw new Error('publisher rename evidence is invalid');
}

function parseResponse(result: CommandResult, argv: readonly string[], operation: 'publish' | 'quarantine' | 'recheck', request: PublisherRequest | Pick<PublisherRequest, 'rootId' | 'jobId'>): PublisherResponse {
  if (JSON.stringify(result.argv) !== JSON.stringify(argv) || result.signal !== null || result.timedOut !== false || !Number.isSafeInteger(result.exitCode)) throw new Error('publisher command result execution evidence is invalid');
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > 65_536) throw new Error('publisher output exceeds its bound');
  const text = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error('publisher returned invalid structured output', { cause: error }); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('publisher returned a non-object result');
  const value = parsed as Record<string, unknown>;
  if (JSON.stringify(value) !== text || Object.keys(value).some((key) => !RESULT_FIELDS.has(key))) throw new Error('publisher result is not canonical or contains extra fields');
  const available = booleanField(value, 'available');
  const published = booleanField(value, 'published');
  const quarantined = booleanField(value, 'quarantined');
  const selfTest = booleanField(value, 'selfTest');
  const mutationCount = own(value, 'mutationCount');
  if (typeof mutationCount !== 'number' || !Number.isSafeInteger(mutationCount) || mutationCount < 0 || mutationCount > 3) throw new Error('publisher mutation count is invalid');
  if (available === false) {
    if (result.exitCode !== 2 || mutationCount !== 0 || published || quarantined || selfTest || Object.keys(value).some((key) => ['renameResult', 'sourceRelativePath', 'destinationRelativePath', 'publisherVersion', 'publisherSourceSha256', 'destination', 'staging'].includes(key)) || value.errorCode !== 'PUBLISHER_UNSUPPORTED') throw new Error('unsupported publisher result is contradictory');
    return value as unknown as PublisherResponse;
  }
  if (selfTest || (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !ERROR_CODES.has(value.errorCode as PublisherErrorCode)))) throw new Error('publisher result error contract is invalid');
  if (value.renameResult !== undefined && (typeof value.renameResult !== 'string' || !RENAME_RESULTS.has(value.renameResult))) throw new Error('publisher rename result is invalid');
  const jobId = request.jobId;
  const sourcePath = `.osi-image-builder/staging/${jobId}`;
  const destinationPath = operation === 'publish' ? `${(request as PublisherRequest).branchSlug}/${(request as PublisherRequest).sourceSha}/${(request as PublisherRequest).targetId}` : `.osi-image-builder/quarantine/${jobId}`;
  if (operation === 'recheck') {
    if (published || quarantined || mutationCount !== 0 || EVIDENCE_FIELDS.some((key) => key in value)) throw new Error('publisher recheck result is contradictory');
    if (result.exitCode === 0) {
      if (typeof value.destination !== 'string' || !['absent', 'candidate', 'mismatched'].includes(value.destination) || typeof value.staging !== 'string' || !['absent', 'present'].includes(value.staging) || (value.errorCode !== undefined && !BLOCKER_CODES.has(value.errorCode as PublisherErrorCode))) throw new Error('publisher recheck result is contradictory');
      if (
        (value.destination === 'candidate' && (value.staging !== 'absent' || value.errorCode !== undefined))
        || (value.destination === 'absent' && value.errorCode !== 'PUBLISH_RECOVERY_FAILED')
        || (value.destination === 'mismatched' && value.errorCode !== 'UNVERIFIED_FINAL_PATH_BLOCKER')
      ) throw new Error('publisher recheck phase result is contradictory');
    } else if (result.exitCode !== 2 || value.destination !== 'unknown' || value.staging !== 'unknown' || value.errorCode !== 'PUBLISH_RECOVERY_FAILED') {
      throw new Error('publisher failed recheck result is contradictory');
    }
  } else if (operation === 'publish') {
    if (quarantined || 'destination' in value || 'staging' in value) throw new Error('publisher publication result is contradictory');
    validatePathEvidence(value, sourcePath, destinationPath);
    if (published) {
      if (result.exitCode !== 0 || mutationCount < 1 || value.errorCode !== undefined) throw new Error('successful publisher result is contradictory');
      validateRenameEvidence(value, 'RENAMED');
    } else {
      if (result.exitCode !== 2 || typeof value.errorCode !== 'string' || !PUBLISH_PRE_RENAME_ERROR_CODES.has(value.errorCode as PublisherErrorCode)) throw new Error('publisher failure is contradictory');
      if (value.renameResult === undefined) {
        if (value.errorCode === 'OUTPUT_COLLISION' || mutationCount > 2) throw new Error('pre-rename publisher failure is contradictory');
      } else if (value.renameResult === 'RENAMED') {
        if (value.errorCode !== 'PUBLISH_FAILED' || mutationCount < 1) throw new Error('post-rename publisher failure is contradictory');
      } else if (value.renameResult === 'EEXIST') {
        if (value.errorCode !== 'OUTPUT_COLLISION' || mutationCount > 2) throw new Error('publisher collision result is contradictory');
      } else if (value.renameResult === 'EXDEV') {
        if (value.errorCode !== 'STAGING_FILESYSTEM_MISMATCH' || mutationCount > 2) throw new Error('publisher cross-device result is contradictory');
      } else if (value.errorCode !== 'PUBLISH_FAILED' || mutationCount > 2) throw new Error('publisher rename failure is contradictory');
    }
  } else {
    if (published || 'destination' in value || 'staging' in value) throw new Error('publisher quarantine result is contradictory');
    validatePathEvidence(value, sourcePath, destinationPath);
    if (quarantined) {
      if (result.exitCode !== 0 || mutationCount < 1 || mutationCount > 2 || value.errorCode !== undefined) throw new Error('successful quarantine result is contradictory');
      validateRenameEvidence(value, 'RENAMED');
    } else {
      if (result.exitCode !== 2 || value.errorCode !== 'QUARANTINE_PENDING') throw new Error('quarantine failure is contradictory');
      if (value.renameResult === undefined && mutationCount > 1) throw new Error('pre-rename quarantine failure is contradictory');
      if (value.renameResult === 'RENAMED' && (mutationCount < 1 || mutationCount > 2)) throw new Error('post-rename quarantine failure is contradictory');
      if (value.renameResult !== undefined && value.renameResult !== 'RENAMED' && mutationCount > 1) throw new Error('quarantine rename failure is contradictory');
    }
  }
  return value as unknown as PublisherResponse;
}

export function createPublisherClient(options: PublisherClientOptions): PublisherClient {
  if (typeof options.executable !== 'string' || !SAFE_ABSOLUTE.test(options.executable) || options.executable.split('/').some((part, index) => index > 0 && (part === '' || part === '.' || part === '..'))) throw new Error('publisher executable must be an absolute path');
  const executor = options.commandExecutor ?? createCommandExecutor();
  const roots = new Map<string, ApprovedOutputRoot>();
  for (const root of options.approvedRoots) {
    validateRoot(root);
    if (roots.has(root.id)) throw new Error('duplicate approved root ID');
    roots.set(root.id, root);
  }

  async function invoke(argv: readonly string[], operation: 'publish' | 'quarantine' | 'recheck', request: PublisherRequest | Pick<PublisherRequest, 'rootId' | 'jobId'>): Promise<PublisherResponse> {
    const runOptions: CommandRunOptions = { env: FIXED_ENV, timeoutMs: options.timeoutMs ?? 30_000, maxCaptureBytes: 64 * 1024 };
    const result = await executor.run(argv, runOptions);
    return parseResponse(result, argv, operation, request);
  }

  return {
    publish: async (request) => {
      const root = roots.get(request.rootId);
      if (root === undefined) throw new Error('approved root is unknown');
      validateRequest(request, root);
      return invoke([options.executable, 'publish', '--root', root.path, '--job-id', request.jobId, '--branch', request.branchSlug, '--sha', request.sourceSha, '--target', request.targetId], 'publish', request);
    },
    quarantine: async (request) => {
      const root = roots.get(request.rootId);
      if (root === undefined) throw new Error('approved root is unknown');
      if (!JOB_ID.test(request.jobId)) throw new Error('job ID is invalid');
      validateRoot(root);
      return invoke([options.executable, 'quarantine', '--root', root.path, '--job-id', request.jobId], 'quarantine', request);
    },
    recheck: async (request) => {
      const root = roots.get(request.rootId);
      if (root === undefined) throw new Error('approved root is unknown');
      validateRequest(request, root);
      return invoke([options.executable, 'recheck', '--root', root.path, '--job-id', request.jobId, '--branch', request.branchSlug, '--sha', request.sourceSha, '--target', request.targetId], 'recheck', request);
    },
  };
}
