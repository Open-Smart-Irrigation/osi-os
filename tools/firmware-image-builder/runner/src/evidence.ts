import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BUILDER_ERROR_CODES,
  PIPELINE_STAGE_NAMES,
  isPipelineStageName,
  isTrustedOperationId,
  type BuilderErrorContract,
  type PipelineStageName,
  type TrustedOperationId,
} from '../../domain/types.js';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface EvidenceCommand {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
}

export interface StageEvidenceInput {
  readonly jobId: string;
  readonly stage: PipelineStageName;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'passed' | 'failed';
  readonly operationId: TrustedOperationId;
  readonly commands: readonly EvidenceCommand[];
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly error: BuilderErrorContract | null;
}

export interface StageEvidence extends StageEvidenceInput {
  readonly schemaVersion: 1;
}

export interface EvidencePublication {
  readonly path: string;
  readonly sha256: string;
}

export interface EvidenceFileSystem {
  readonly publishExclusive: (rootPath: string, path: string, contents: Buffer) => Promise<void>;
}

export class EvidenceError extends Error {
  readonly code: 'EVIDENCE_PATH_INVALID' | 'EVIDENCE_EXISTS' | 'EVIDENCE_PUBLICATION_FAILED' | 'EVIDENCE_INVALID';

  constructor(code: EvidenceError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

function validTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new EvidenceError('EVIDENCE_INVALID', `${field} must be an ISO timestamp`);
}

function canonicalEvidencePath(stateRoot: string, jobId: string, stage: PipelineStageName): string {
  if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot) || stateRoot.includes('\0')) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'state root must be an absolute path');
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId) || jobId === '.' || jobId === '..') throw new EvidenceError('EVIDENCE_PATH_INVALID', 'job ID is not a safe path segment');
  if (!isPipelineStageName(stage)) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'stage is not approved');
  const index = PIPELINE_STAGE_NAMES.indexOf(stage);
  const root = resolve(stateRoot);
  const path = join(root, 'jobs', jobId, 'evidence', `${String(index).padStart(2, '0')}-${stage}.json`);
  const escaped = relative(root, path);
  if (escaped === '..' || escaped.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(escaped)) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'evidence path escapes state root');
  return path;
}

function validateInput(input: StageEvidenceInput): StageEvidence {
  if (!input || typeof input !== 'object') throw new EvidenceError('EVIDENCE_INVALID', 'stage evidence input is invalid');
  if (!isPipelineStageName(input.stage) || !isTrustedOperationId(input.operationId)) throw new EvidenceError('EVIDENCE_INVALID', 'stage or operation is not trusted');
  validTimestamp(input.startedAt, 'startedAt');
  validTimestamp(input.finishedAt, 'finishedAt');
  if (Date.parse(input.finishedAt) < Date.parse(input.startedAt)) throw new EvidenceError('EVIDENCE_INVALID', 'evidence timestamps are out of order');
  if (input.outcome !== 'passed' && input.outcome !== 'failed') throw new EvidenceError('EVIDENCE_INVALID', 'evidence outcome is invalid');
  if (!Array.isArray(input.commands)) throw new EvidenceError('EVIDENCE_INVALID', 'captured commands are invalid');
  for (const command of input.commands) {
    if (!command || !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((value: unknown) => typeof value !== 'string' || value.length === 0) || (command.exitCode !== null && !Number.isSafeInteger(command.exitCode))) {
      throw new EvidenceError('EVIDENCE_INVALID', 'captured commands are invalid');
    }
  }
  if (input.outcome === 'passed' && input.error !== null) throw new EvidenceError('EVIDENCE_INVALID', 'passed evidence cannot contain an error');
  if (input.outcome === 'failed' && input.error === null) throw new EvidenceError('EVIDENCE_INVALID', 'failed evidence requires an error');
  if (input.error !== null && (
    typeof input.error !== 'object'
    || !(BUILDER_ERROR_CODES as readonly string[]).includes(input.error.code)
    || typeof input.error.diagnosis !== 'string'
    || typeof input.error.recovery !== 'string'
    || typeof input.error.requestId !== 'string'
    || (input.error.operationId !== undefined && !isTrustedOperationId(input.error.operationId))
  )) throw new EvidenceError('EVIDENCE_INVALID', 'stage error is not a stable builder error');
  return {
    schemaVersion: 1,
    jobId: input.jobId,
    stage: input.stage,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    operationId: input.operationId,
    commands: input.commands.map((command) => ({ argv: [...command.argv], exitCode: command.exitCode })),
    inputs: input.inputs,
    observations: input.observations,
    error: input.error,
  };
}

function encodeEvidence(evidence: StageEvidence): Buffer {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(evidence, null, 2); } catch (error) { throw new EvidenceError('EVIDENCE_INVALID', 'stage evidence is not JSON serializable', { cause: error }); }
  if (encoded === undefined) throw new EvidenceError('EVIDENCE_INVALID', 'stage evidence is not JSON serializable');
  return Buffer.from(`${encoded}\n`, 'utf8');
}

async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  }
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'evidence directory is not a real directory');
}

async function publishExclusive(rootPath: string, path: string, contents: Buffer): Promise<void> {
  const root = resolve(rootPath);
  if (resolve(path) !== path || relative(root, path).startsWith('..')) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'evidence path is outside the state root');
  await ensureDirectory(root);
  const jobs = join(root, 'jobs');
  const job = join(jobs, path.split('/').at(-3)!);
  const evidenceDirectory = join(job, 'evidence');
  await ensureDirectory(jobs);
  await ensureDirectory(job);
  await ensureDirectory(evidenceDirectory);
  try { await lstat(path); throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists'); } catch (error) {
    if (error instanceof EvidenceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporaryPath = join(evidenceDirectory, `.${path.split('/').at(-1)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await link(temporaryPath, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists', { cause: error });
      throw error;
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  const directoryHandle = await open(evidenceDirectory, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

const DEFAULT_FILE_SYSTEM: EvidenceFileSystem = Object.freeze({ publishExclusive });

export class EvidenceWriter {
  readonly #stateRoot: string;
  readonly #fileSystem: EvidenceFileSystem;

  constructor(options: { readonly stateRoot: string; readonly fileSystem?: EvidenceFileSystem }) {
    this.#stateRoot = options.stateRoot;
    this.#fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  }

  async write(input: StageEvidenceInput): Promise<EvidencePublication> {
    const evidence = validateInput(input);
    const path = canonicalEvidencePath(this.#stateRoot, evidence.jobId, evidence.stage);
    const contents = encodeEvidence(evidence);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (!SHA256.test(sha256)) throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'evidence hash could not be calculated');
    try { await this.#fileSystem.publishExclusive(resolve(this.#stateRoot), path, contents); }
    catch (error) {
      if (error instanceof EvidenceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists', { cause: error });
      throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'evidence publication failed', { cause: error });
    }
    return Object.freeze({ path, sha256 });
  }
}

export function createEvidenceWriter(options: { readonly stateRoot: string; readonly fileSystem?: EvidenceFileSystem }): EvidenceWriter {
  return new EvidenceWriter(options);
}

export async function writeStageEvidence(options: { readonly stateRoot: string; readonly fileSystem?: EvidenceFileSystem }, input: StageEvidenceInput): Promise<EvidencePublication> {
  return createEvidenceWriter(options).write(input);
}
