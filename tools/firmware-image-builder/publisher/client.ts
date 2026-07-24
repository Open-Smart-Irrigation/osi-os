import { createCommandExecutor, type CommandExecutor, type CommandResult, type CommandRunOptions } from '../runner/src/command-executor.js';
import { TARGET_IDS, type TargetId } from '../domain/types.js';
import type { ApprovedOutputRoot } from '../config/load.js';

export type PublisherErrorCode =
  | 'OUTPUT_COLLISION'
  | 'PUBLISH_RECOVERY_FAILED'
  | 'UNVERIFIED_FINAL_PATH_BLOCKER'
  | 'QUARANTINE_PENDING'
  | 'PUBLISH_FAILED'
  | 'PUBLISHER_UNSUPPORTED'
  | 'STAGING_FILESYSTEM_MISMATCH'
  | 'INVALID_ARGUMENT';

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
  readonly published?: boolean;
  readonly quarantined?: boolean;
  readonly mutationCount: number;
  readonly errorCode?: PublisherErrorCode;
  readonly destination?: 'absent' | 'complete' | 'mismatched';
  readonly staging?: 'absent' | 'present';
  readonly sourceRelativePath?: string;
  readonly destinationRelativePath?: string;
  readonly renameResult?: 'RENAME_NOREPLACE';
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
  if (!BRANCH.test(request.branchSlug)) throw new Error('branch slug is invalid');
  if (!SHA.test(request.sourceSha)) throw new Error('source SHA is invalid');
  if (!(TARGET_IDS as readonly string[]).includes(request.targetId)) throw new Error('target ID is invalid');
  validateRoot(root);
}

function parseResponse(result: CommandResult): PublisherResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error('publisher returned invalid structured output', { cause: error }); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('publisher returned a non-object result');
  const value = parsed as Record<string, unknown>;
  if (typeof value.available !== 'boolean' || typeof value.mutationCount !== 'number' || !Number.isSafeInteger(value.mutationCount) || value.mutationCount < 0) throw new Error('publisher result contract is invalid');
  if (value.published === true && value.available !== true) throw new Error('unsupported publisher cannot claim publication');
  if (result.exitCode !== 0 && value.errorCode === undefined) throw new Error('publisher failed without a typed error');
  return value as unknown as PublisherResponse;
}

export function createPublisherClient(options: PublisherClientOptions): PublisherClient {
  if (typeof options.executable !== 'string' || !SAFE_ABSOLUTE.test(options.executable) || options.executable.split('/').some((part, index) => index > 0 && (part === '' || part === '.' || part === '..'))) throw new Error('publisher executable must be an absolute path');
  const executor = options.commandExecutor ?? createCommandExecutor();
  const roots = new Map(options.approvedRoots.map((root) => [root.id, root]));
  for (const root of options.approvedRoots) validateRoot(root);

  async function invoke(argv: readonly string[]): Promise<PublisherResponse> {
    const runOptions: CommandRunOptions = { env: FIXED_ENV, timeoutMs: options.timeoutMs ?? 30_000, maxCaptureBytes: 64 * 1024 };
    const result = await executor.run(argv, runOptions);
    return parseResponse(result);
  }

  return {
    publish: async (request) => {
      const root = roots.get(request.rootId);
      if (root === undefined) throw new Error('approved root is unknown');
      validateRequest(request, root);
      return invoke([options.executable, 'publish', '--root', root.path, '--job-id', request.jobId, '--branch', request.branchSlug, '--sha', request.sourceSha, '--target', request.targetId]);
    },
    quarantine: async (request) => {
      const root = roots.get(request.rootId);
      if (root === undefined) throw new Error('approved root is unknown');
      if (!JOB_ID.test(request.jobId)) throw new Error('job ID is invalid');
      validateRoot(root);
      return invoke([options.executable, 'quarantine', '--root', root.path, '--job-id', request.jobId]);
    },
    recheck: async (request) => {
      const root = roots.get(request.rootId);
      if (root === undefined) throw new Error('approved root is unknown');
      validateRequest(request, root);
      return invoke([options.executable, 'recheck', '--root', root.path, '--job-id', request.jobId, '--branch', request.branchSlug, '--sha', request.sourceSha, '--target', request.targetId]);
    },
  };
}
