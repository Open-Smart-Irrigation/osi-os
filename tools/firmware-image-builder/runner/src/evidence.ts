import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { withStateRootSnapshot, type StateRootAuthority } from '../../config/load.js';
import { boundedText, encodeJson, normalizeJson, canonicalInstant, stableRelativePath, SharedValidationError } from '../../api/src/validation.js';
import {
  BUILDER_ERROR_CODES,
  PIPELINE_STAGE_NAMES,
  isPipelineStageName,
  isTrustedOperationId,
  type BuilderErrorContract,
  type PipelineStageName,
  type TrustedOperationId,
} from '../../domain/types.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CAPTURED_COMMANDS = 256;
const PROC_FD = '/proc/self/fd';
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const FILE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

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
  /** Source is a stage-only operation; other stages carry a trusted operation ID. */
  readonly operationId: TrustedOperationId | null;
  readonly commands: readonly EvidenceCommand[];
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly error: BuilderErrorContract | null;
}

export interface StageEvidence extends StageEvidenceInput {
  readonly schemaVersion: 1;
}

export interface EvidencePublication {
  /** A confined state-root-relative path, suitable for persistence in the store. */
  readonly path: string;
  readonly sha256: string;
}

export interface EvidenceFileSystem {
  readonly publishExclusive: (root: StateRootAuthority, relativePath: string, contents: Buffer) => Promise<void>;
}

export class EvidenceError extends Error {
  readonly code: 'EVIDENCE_PATH_INVALID' | 'EVIDENCE_EXISTS' | 'EVIDENCE_PUBLICATION_FAILED' | 'EVIDENCE_INVALID';

  constructor(code: EvidenceError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new EvidenceError('EVIDENCE_INVALID', message, cause === undefined ? undefined : { cause });
}

function validateInput(input: StageEvidenceInput): StageEvidence {
  if (!input || typeof input !== 'object') return invalid('stage evidence input is invalid');
  let jobId: string;
  try { jobId = stableRelativePath(input.jobId, 'jobId'); }
  catch (error) { throw new EvidenceError('EVIDENCE_PATH_INVALID', 'jobId is not a stable path segment', { cause: error }); }
  if (jobId.includes('/')) return invalid('jobId must be one stable path segment');
  if (!isPipelineStageName(input.stage) || (input.operationId !== null && !isTrustedOperationId(input.operationId)) || (input.stage === 'source' && input.operationId !== null) || (input.stage !== 'source' && input.operationId === null)) return invalid('stage or operation is not trusted');
  let startedAt: string;
  let finishedAt: string;
  try {
    startedAt = canonicalInstant(input.startedAt, 'startedAt');
    finishedAt = canonicalInstant(input.finishedAt, 'finishedAt');
  } catch (error) { return invalid('evidence timestamps are not canonical', error); }
  if (finishedAt < startedAt) return invalid('evidence timestamps are out of order');
  if (input.outcome !== 'passed' && input.outcome !== 'failed') return invalid('evidence outcome is invalid');
  if (!Array.isArray(input.commands) || input.commands.length > MAX_CAPTURED_COMMANDS) return invalid('captured commands are invalid');
  const commands = input.commands.map((command, index) => {
    if (!command || typeof command !== 'object' || !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((value: unknown) => typeof value !== 'string' || value.length === 0) || (command.exitCode !== null && !Number.isSafeInteger(command.exitCode))) return invalid(`commands[${index}] is invalid`);
    try { return normalizeJson({ argv: command.argv, exitCode: command.exitCode }, `commands[${index}]`) as unknown as EvidenceCommand; }
    catch (error) { return invalid(`commands[${index}] is not bounded JSON`, error); }
  });
  if (input.outcome === 'passed' && input.error !== null) return invalid('passed evidence cannot contain an error');
  if (input.outcome === 'failed' && input.error === null) return invalid('failed evidence requires an error');
  if (input.error !== null) {
    const error = input.error;
    const operationCoherent = input.operationId === null ? error.operationId === undefined : error.operationId === input.operationId;
    if (typeof error !== 'object' || !(BUILDER_ERROR_CODES as readonly string[]).includes(error.code) || error.stage !== input.stage || !operationCoherent || typeof error.retryable !== 'boolean' || typeof error.requestId !== 'string' || typeof error.diagnosis !== 'string' || typeof error.recovery !== 'string') return invalid('stage error is not coherent with the stage operation');
    try {
      stableRelativePath(error.requestId, 'error.requestId');
      boundedText(error.diagnosis, 'error.diagnosis');
      boundedText(error.recovery, 'error.recovery');
      const details = normalizeJson(error.details, 'error.details');
      if (details === null || typeof details !== 'object' || Array.isArray(details)) return invalid('error.details must be a JSON object');
    } catch (cause) { return invalid('stage error details are not bounded JSON', cause); }
  }
  let inputs: Record<string, unknown>;
  let observations: Record<string, unknown>;
  try {
    inputs = normalizeJson(input.inputs, 'evidence.inputs') as Record<string, unknown>;
    observations = normalizeJson(input.observations, 'evidence.observations') as Record<string, unknown>;
    encodeJson(inputs, 'evidence.inputs', true);
    encodeJson(observations, 'evidence.observations', true);
  } catch (error) { return invalid('evidence JSON is not bounded', error); }
  return {
    schemaVersion: 1,
    jobId,
    stage: input.stage,
    startedAt,
    finishedAt,
    outcome: input.outcome,
    operationId: input.operationId,
    commands: commands as readonly EvidenceCommand[],
    inputs,
    observations,
    error: input.error,
  };
}

function evidenceRelativePath(jobId: string, stage: PipelineStageName): string {
  if (!isPipelineStageName(stage)) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'stage is not approved');
  const index = PIPELINE_STAGE_NAMES.indexOf(stage);
  return `jobs/${jobId}/evidence/${String(index).padStart(2, '0')}-${stage}.json`;
}

function procChild(parent: FileHandle, basename: string): string {
  return join(PROC_FD, String(parent.fd), basename);
}

async function openDirectory(parent: FileHandle, basename: string, create: boolean): Promise<FileHandle> {
  try { return await open(procChild(parent, basename), DIR_FLAGS); }
  catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await mkdir(procChild(parent, basename), { mode: 0o700 }); } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
    }
    await parent.sync();
    return open(procChild(parent, basename), DIR_FLAGS);
  }
}

async function readExact(parent: FileHandle, basename: string, expected: Buffer): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(procChild(parent, basename), READ_FLAGS);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== expected.length || stats.nlink < 1) return false;
    const actual = await handle.readFile();
    return Buffer.compare(actual, expected) === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return false;
    throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

async function removeTemporaryLinks(parent: FileHandle, basename: string): Promise<void> {
  for (const entry of await readdir(join(PROC_FD, String(parent.fd)))) {
    if (entry.startsWith(`.${basename}.`) && entry.endsWith('.tmp')) {
      try { await unlink(procChild(parent, entry)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

async function reconcileExisting(parent: FileHandle, basename: string, contents: Buffer, syncDirectory: () => Promise<void>): Promise<boolean> {
  if (!(await readExact(parent, basename, contents))) return false;
  await removeTemporaryLinks(parent, basename);
  await syncDirectory();
  return true;
}

async function syncReconciled(parent: FileHandle, basename: string, contents: Buffer, syncDirectory: () => Promise<void>): Promise<void> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await syncDirectory();
      return;
    } catch (error) {
      firstError ??= error;
      if (!(await readExact(parent, basename, contents))) throw error;
    }
  }
  throw firstError;
}

async function publishExclusive(root: StateRootAuthority, relativePath: string, contents: Buffer): Promise<void> {
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'descriptor publication requires Linux no-follow support');
  const parts = relativePath.split('/');
  const basename = parts.pop();
  if (!basename || parts.length < 1 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'evidence path is not stable');
  await withStateRootSnapshot(root, async ({ snapshot, dependencies }) => {
    let current: FileHandle | undefined;
    const handles: FileHandle[] = [];
    try {
      current = await open(snapshot.path, DIR_FLAGS);
      handles.push(current);
      const identity = await current.stat();
      if (!identity.isDirectory() || identity.dev !== snapshot.device || identity.ino !== snapshot.inode) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'state root identity changed');
      for (const part of parts) {
        let next: FileHandle;
        await dependencies.beforeDirectoryAccess?.(current);
        try { next = await openDirectory(current, part, true); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ELOOP' || code === 'ENOTDIR') throw new EvidenceError('EVIDENCE_PATH_INVALID', 'evidence path contains an unsafe ancestor', { cause: error });
          throw error;
        }
        handles.push(next);
        current = next;
      }
      const parent = current;
      const temporary = `.${basename}.${randomUUID()}.tmp`;
      let temporaryHandle: FileHandle | undefined;
      const syncDirectory = async (): Promise<void> => { await dependencies.beforeDirectorySync?.(parent); await parent.sync(); };
      try {
        let existing: FileHandle | undefined;
        try { existing = await open(procChild(parent, basename), READ_FLAGS); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error; }
        if (existing !== undefined) {
          await existing.close();
          if (await reconcileExisting(parent, basename, contents, syncDirectory)) return;
          throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists');
        }
        temporaryHandle = await open(procChild(parent, temporary), FILE_FLAGS, 0o600);
        await temporaryHandle.writeFile(contents);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        try { await link(procChild(parent, temporary), procChild(parent, basename)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists', { cause: error });
          throw error;
        }
        await syncReconciled(parent, basename, contents, syncDirectory);
      } finally {
        await temporaryHandle?.close().catch(() => undefined);
        try { await unlink(procChild(parent, temporary)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await syncDirectory();
      }
    } finally {
      for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    }
  });
}

const DEFAULT_FILE_SYSTEM: EvidenceFileSystem = Object.freeze({ publishExclusive });

export class EvidenceWriter {
  readonly #stateRoot: StateRootAuthority;
  readonly #fileSystem: EvidenceFileSystem;

  constructor(options: { readonly stateRoot: StateRootAuthority; readonly fileSystem?: EvidenceFileSystem }) {
    this.#stateRoot = options.stateRoot;
    this.#fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  }

  async write(input: StageEvidenceInput): Promise<EvidencePublication> {
    let evidence: StageEvidence;
    try { evidence = validateInput(input); }
    catch (error) { if (error instanceof EvidenceError) throw error; if (error instanceof SharedValidationError) throw new EvidenceError('EVIDENCE_INVALID', error.message, { cause: error }); throw error; }
    const path = evidenceRelativePath(evidence.jobId, evidence.stage);
    let encoded: string;
    try { encoded = encodeJson(evidence, 'stage evidence', true); }
    catch (error) { throw new EvidenceError('EVIDENCE_INVALID', 'stage evidence is not canonical JSON', { cause: error }); }
    const contents = Buffer.from(`${encoded}\n`, 'utf8');
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (!SHA256.test(sha256)) throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'evidence hash could not be calculated');
    try { await this.#fileSystem.publishExclusive(this.#stateRoot, path, contents); }
    catch (error) {
      if (error instanceof EvidenceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists', { cause: error });
      throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'evidence publication failed', { cause: error });
    }
    return Object.freeze({ path, sha256 });
  }
}

export function createEvidenceWriter(options: { readonly stateRoot: StateRootAuthority; readonly fileSystem?: EvidenceFileSystem }): EvidenceWriter {
  return new EvidenceWriter(options);
}

export async function writeStageEvidence(options: { readonly stateRoot: StateRootAuthority; readonly fileSystem?: EvidenceFileSystem }, input: StageEvidenceInput): Promise<EvidencePublication> {
  return createEvidenceWriter(options).write(input);
}
