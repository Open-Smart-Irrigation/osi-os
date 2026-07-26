import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { boundedText, canonicalInstant, encodeJson, normalizeJson, stableRelativePath, SharedValidationError } from '../../api/src/validation.js';
import { withStateRootSnapshot, type PathAuthorityDependencies, type StateRootAuthority } from '../../config/load.js';
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
const COMMAND_KEYS = Object.freeze(['argv', 'exitCode', 'finishedAt', 'outputLimit', 'signal', 'startedAt', 'timedOut']);
const ERROR_REQUIRED_KEYS = Object.freeze(['code', 'details', 'diagnosis', 'recovery', 'requestId', 'retryable', 'stage']);
const ERROR_OPTIONAL_KEYS = Object.freeze(['evidencePath', 'operationId']);

export interface EvidenceCommand {
  readonly argv: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputLimit: boolean;
}

export interface StageEvidenceInput {
  readonly jobId: string;
  readonly stage: PipelineStageName;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'passed' | 'failed';
  /** Source setup is a stage-only contract; it does not impersonate a target operation. */
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
  readonly path: string;
  readonly sha256: string;
}

export interface EvidenceFileSystem {
  readonly publishExclusive: (root: StateRootAuthority, relativePath: string, contents: Buffer) => Promise<void>;
}

export class EvidenceError extends Error {
  readonly code: 'EVIDENCE_PATH_INVALID' | 'EVIDENCE_EXISTS' | 'EVIDENCE_PUBLICATION_FAILED' | 'EVIDENCE_TEMPORARY_BLOCKER' | 'EVIDENCE_INVALID';

  constructor(code: EvidenceError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

class EvidenceBindingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvidenceBindingError';
  }
}

interface DirectoryBinding {
  readonly handle: FileHandle;
  readonly parent: FileHandle | null;
  readonly basename: string | null;
  readonly device: number;
  readonly inode: number;
}

interface FileBinding {
  readonly handle: FileHandle;
  readonly device: number;
  readonly inode: number;
}

function invalid(message: string, cause?: unknown): never {
  throw new EvidenceError('EVIDENCE_INVALID', message, cause === undefined ? undefined : { cause });
}

function evidenceRelativePath(jobId: string, stage: PipelineStageName): string {
  if (!isPipelineStageName(stage)) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'stage is not approved');
  const index = PIPELINE_STAGE_NAMES.indexOf(stage);
  return `jobs/${jobId}/evidence/${String(index).padStart(2, '0')}-${stage}.json`;
}

function exactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value).sort();
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function validateCommand(input: EvidenceCommand, index: number): EvidenceCommand {
  let normalized: Readonly<Record<string, unknown>>;
  try {
    const value = normalizeJson(input, `commands[${index}]`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(`commands[${index}] is invalid`);
    normalized = value as Readonly<Record<string, unknown>>;
  } catch (error) {
    return invalid(`commands[${index}] is not bounded JSON`, error);
  }
  if (!exactKeys(normalized, COMMAND_KEYS)
    || !Array.isArray(normalized.argv)
    || normalized.argv.length === 0
    || normalized.argv.some((value) => typeof value !== 'string' || value.length === 0)
    || (normalized.exitCode !== null && !Number.isSafeInteger(normalized.exitCode))
    || (normalized.signal !== null && typeof normalized.signal !== 'string')
    || typeof normalized.timedOut !== 'boolean'
    || typeof normalized.outputLimit !== 'boolean') {
    return invalid(`commands[${index}] is invalid`);
  }
  let startedAt: string;
  let finishedAt: string;
  try {
    startedAt = canonicalInstant(normalized.startedAt, `commands[${index}].startedAt`);
    finishedAt = canonicalInstant(normalized.finishedAt, `commands[${index}].finishedAt`);
    if (finishedAt < startedAt) return invalid(`commands[${index}] timestamps are out of order`);
    for (const [argumentIndex, argument] of normalized.argv.entries()) boundedText(argument, `commands[${index}].argv[${argumentIndex}]`);
    if (normalized.signal !== null) boundedText(normalized.signal, `commands[${index}].signal`, 32);
  } catch (error) {
    return invalid(`commands[${index}] is invalid`, error);
  }
  return Object.freeze({
    argv: Object.freeze([...(normalized.argv as string[])]),
    startedAt,
    finishedAt,
    exitCode: normalized.exitCode as number | null,
    signal: normalized.signal as string | null,
    timedOut: normalized.timedOut as boolean,
    outputLimit: normalized.outputLimit as boolean,
  });
}

function validateErrorDetails(value: unknown): Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>> {
  const normalized = normalizeJson(value, 'error.details');
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) return invalid('error.details must be a JSON object');
  for (const detail of Object.values(normalized)) {
    if (Array.isArray(detail)) {
      if (detail.some((entry) => entry !== null && !['string', 'number', 'boolean'].includes(typeof entry))) return invalid('error.details contains a non-scalar array');
    } else if (detail !== null && !['string', 'number', 'boolean'].includes(typeof detail)) {
      return invalid('error.details contains a non-scalar value');
    }
  }
  return normalized as Readonly<Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>>;
}

function validateError(
  input: BuilderErrorContract,
  stage: PipelineStageName,
  operationId: TrustedOperationId | null,
  expectedEvidencePath: string,
): BuilderErrorContract {
  let normalized: Readonly<Record<string, unknown>>;
  try {
    const value = normalizeJson(input, 'error');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('stage error is invalid');
    normalized = value as Readonly<Record<string, unknown>>;
  } catch (error) {
    return invalid('stage error is not bounded JSON', error);
  }
  if (!exactKeys(normalized, ERROR_REQUIRED_KEYS, ERROR_OPTIONAL_KEYS)
    || !(BUILDER_ERROR_CODES as readonly unknown[]).includes(normalized.code)
    || normalized.stage !== stage
    || typeof normalized.retryable !== 'boolean'
    || typeof normalized.requestId !== 'string'
    || typeof normalized.diagnosis !== 'string'
    || typeof normalized.recovery !== 'string') {
    return invalid('stage error is not coherent with the stage operation');
  }
  const normalizedOperation = normalized.operationId;
  if ((operationId === null && normalizedOperation !== undefined)
    || (operationId !== null && normalizedOperation !== operationId)
    || (normalized.evidencePath !== undefined && normalized.evidencePath !== expectedEvidencePath)) {
    return invalid('stage error is not coherent with the stage operation');
  }
  let requestId: string;
  let diagnosis: string;
  let recovery: string;
  let details: ReturnType<typeof validateErrorDetails>;
  try {
    requestId = stableRelativePath(normalized.requestId, 'error.requestId');
    diagnosis = boundedText(normalized.diagnosis, 'error.diagnosis');
    recovery = boundedText(normalized.recovery, 'error.recovery');
    details = validateErrorDetails(normalized.details);
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    return invalid('stage error details are not bounded JSON', error);
  }
  const result: BuilderErrorContract = {
    code: normalized.code as BuilderErrorContract['code'],
    stage,
    details,
    retryable: normalized.retryable,
    requestId,
    diagnosis,
    recovery,
    ...(normalized.evidencePath === undefined ? {} : { evidencePath: expectedEvidencePath }),
    ...(operationId === null ? {} : { operationId }),
  };
  return Object.freeze(result);
}

function validateInput(input: StageEvidenceInput): StageEvidence {
  if (!input || typeof input !== 'object') return invalid('stage evidence input is invalid');
  let jobId: string;
  try {
    jobId = stableRelativePath(input.jobId, 'jobId');
  } catch (error) {
    throw new EvidenceError('EVIDENCE_PATH_INVALID', 'jobId is not a stable path segment', { cause: error });
  }
  if (jobId.includes('/')) return invalid('jobId must be one stable path segment');
  if (!isPipelineStageName(input.stage)
    || (input.operationId !== null && !isTrustedOperationId(input.operationId))
    || (input.stage === 'source' && input.operationId !== null)
    || (input.stage !== 'source' && input.operationId === null)) {
    return invalid('stage or operation is not trusted');
  }
  let startedAt: string;
  let finishedAt: string;
  try {
    startedAt = canonicalInstant(input.startedAt, 'startedAt');
    finishedAt = canonicalInstant(input.finishedAt, 'finishedAt');
  } catch (error) {
    return invalid('evidence timestamps are not canonical', error);
  }
  if (finishedAt < startedAt) return invalid('evidence timestamps are out of order');
  if (input.outcome !== 'passed' && input.outcome !== 'failed') return invalid('evidence outcome is invalid');
  if (!Array.isArray(input.commands) || input.commands.length > MAX_CAPTURED_COMMANDS) return invalid('captured commands are invalid');
  const commands = Object.freeze(input.commands.map(validateCommand));
  if (input.outcome === 'passed' && input.error !== null) return invalid('passed evidence cannot contain an error');
  if (input.outcome === 'failed' && input.error === null) return invalid('failed evidence requires an error');
  const path = evidenceRelativePath(jobId, input.stage);
  const error = input.error === null ? null : validateError(input.error, input.stage, input.operationId, path);
  let inputs: Record<string, unknown>;
  let observations: Record<string, unknown>;
  try {
    inputs = normalizeJson(input.inputs, 'evidence.inputs') as Record<string, unknown>;
    observations = normalizeJson(input.observations, 'evidence.observations') as Record<string, unknown>;
    encodeJson(inputs, 'evidence.inputs', true);
    encodeJson(observations, 'evidence.observations', true);
  } catch (validationError) {
    return invalid('evidence JSON is not bounded', validationError);
  }
  return Object.freeze({
    schemaVersion: 1,
    jobId,
    stage: input.stage,
    startedAt,
    finishedAt,
    outcome: input.outcome,
    operationId: input.operationId,
    commands,
    inputs,
    observations,
    error,
  });
}

function procChild(parent: FileHandle, basename: string): string {
  return join(PROC_FD, String(parent.fd), basename);
}

async function bindDirectory(handle: FileHandle, parent: FileHandle | null, basename: string | null): Promise<DirectoryBinding> {
  const stats = await handle.stat();
  if (!stats.isDirectory()) throw new EvidenceBindingError('evidence ancestor is not a directory');
  return Object.freeze({ handle, parent, basename, device: stats.dev, inode: stats.ino });
}

async function validateBindings(bindings: readonly DirectoryBinding[], rootPath: string, dependencies: PathAuthorityDependencies): Promise<void> {
  const leaf = bindings.at(-1);
  if (!leaf) throw new EvidenceBindingError('evidence authority is empty');
  await dependencies.beforeDirectoryAccess?.(leaf.handle);
  try {
    const root = bindings[0]!;
    const namedRoot = await lstat(rootPath);
    const heldRoot = await root.handle.stat();
    if (!namedRoot.isDirectory() || namedRoot.isSymbolicLink() || !heldRoot.isDirectory()
      || namedRoot.dev !== root.device || namedRoot.ino !== root.inode
      || heldRoot.dev !== root.device || heldRoot.ino !== root.inode) {
      throw new EvidenceBindingError('state root evidence binding changed');
    }
    for (const binding of bindings.slice(1)) {
      const named = await lstat(procChild(binding.parent!, binding.basename!));
      const held = await binding.handle.stat();
      if (!named.isDirectory() || named.isSymbolicLink() || !held.isDirectory()
        || named.dev !== binding.device || named.ino !== binding.inode
        || held.dev !== binding.device || held.ino !== binding.inode) {
        throw new EvidenceBindingError('evidence ancestor binding changed');
      }
    }
  } catch (error) {
    if (error instanceof EvidenceBindingError) throw error;
    throw new EvidenceBindingError('evidence ancestor could not be revalidated', { cause: error });
  }
}

async function openDirectory(parent: FileHandle, basename: string, create: boolean): Promise<FileHandle> {
  try {
    return await open(procChild(parent, basename), DIR_FLAGS);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await mkdir(procChild(parent, basename), { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
    }
    await parent.sync();
    return open(procChild(parent, basename), DIR_FLAGS);
  }
}

async function readHandleExact(handle: FileHandle, expected: Buffer): Promise<boolean> {
  const before = await handle.stat();
  if (!before.isFile() || before.size !== expected.length || before.nlink < 1) return false;
  const actual = Buffer.alloc(expected.length);
  let offset = 0;
  while (offset < actual.length) {
    const result = await handle.read(actual, offset, actual.length - offset, offset);
    if (result.bytesRead === 0) return false;
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  return after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && Buffer.compare(actual, expected) === 0;
}

async function bindFinalExact(parent: FileHandle, basename: string, expected: Buffer): Promise<FileHandle | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(procChild(parent, basename), READ_FLAGS);
    const named = await lstat(procChild(parent, basename));
    const held = await handle.stat();
    if (!named.isFile() || named.isSymbolicLink() || !held.isFile() || named.dev !== held.dev || named.ino !== held.ino || !(await readHandleExact(handle, expected))) {
      await handle.close();
      return null;
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ELOOP') return null;
    throw error;
  }
}

async function verifyFinalBinding(parent: FileHandle, basename: string, finalHandle: FileHandle, expected: Buffer): Promise<void> {
  const named = await lstat(procChild(parent, basename));
  const held = await finalHandle.stat();
  if (!named.isFile() || named.isSymbolicLink() || !held.isFile() || named.dev !== held.dev || named.ino !== held.ino || !(await readHandleExact(finalHandle, expected))) {
    throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'published evidence identity or content changed');
  }
}

async function bindFile(handle: FileHandle): Promise<FileBinding> {
  const stats = await handle.stat();
  if (!stats.isFile()) throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'temporary evidence inode is not a file');
  return Object.freeze({ handle, device: stats.dev, inode: stats.ino });
}

async function validateFileBinding(parent: FileHandle, basename: string, binding: FileBinding): Promise<void> {
  try {
    const named = await lstat(procChild(parent, basename));
    const held = await binding.handle.stat();
    if (!named.isFile() || named.isSymbolicLink() || !held.isFile()
      || named.dev !== binding.device || named.ino !== binding.inode
      || held.dev !== binding.device || held.ino !== binding.inode) {
      throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'temporary evidence pathname no longer names its held inode');
    }
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'temporary evidence pathname could not be revalidated', { cause: error });
  }
}

async function assertTemporaryAbsent(parent: FileHandle, basename: string): Promise<void> {
  try {
    await lstat(procChild(parent, basename));
    throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'temporary evidence pathname survived cleanup');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'temporary evidence cleanup could not be verified', { cause: error });
  }
}

function isTemporaryEntry(entry: string, basename: string): boolean {
  return entry.startsWith(`.${basename}.`) && entry.endsWith('.tmp');
}

async function assertNoTemporaryEntries(parent: FileHandle, basename: string): Promise<void> {
  if ((await readdir(join(PROC_FD, String(parent.fd)))).some((entry) => isTemporaryEntry(entry, basename))) {
    throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'unexpected temporary evidence survivor blocks publication');
  }
}

async function reconcileTemporaryLinks(
  parent: FileHandle,
  basename: string,
  finalHandle: FileHandle,
  contents: Buffer,
  excluded = '',
): Promise<void> {
  const finalIdentity = await finalHandle.stat();
  for (const entry of await readdir(join(PROC_FD, String(parent.fd)))) {
    if (!isTemporaryEntry(entry, basename) || entry === excluded) continue;
    let temporaryHandle: FileHandle | undefined;
    try {
      temporaryHandle = await open(procChild(parent, entry), READ_FLAGS);
      const named = await lstat(procChild(parent, entry));
      const held = await temporaryHandle.stat();
      if (!named.isFile() || named.isSymbolicLink() || !held.isFile()
        || named.dev !== held.dev || named.ino !== held.ino
        || held.dev !== finalIdentity.dev || held.ino !== finalIdentity.ino
        || !(await readHandleExact(temporaryHandle, contents))) {
        throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'unexpected temporary evidence survivor blocks publication');
      }
      await validateFileBinding(parent, entry, Object.freeze({
        handle: temporaryHandle,
        device: held.dev,
        inode: held.ino,
      }));
      await unlink(procChild(parent, entry));
      await assertTemporaryAbsent(parent, entry);
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'temporary evidence survivor could not be reconciled', { cause: error });
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
    }
  }
}

async function syncDirectory(parent: FileHandle, dependencies: PathAuthorityDependencies): Promise<void> {
  await dependencies.beforeDirectorySync?.(parent);
  await parent.sync();
}

async function syncPublished(
  parent: FileHandle,
  basename: string,
  finalHandle: FileHandle,
  contents: Buffer,
  dependencies: PathAuthorityDependencies,
): Promise<void> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await syncDirectory(parent, dependencies);
      await verifyFinalBinding(parent, basename, finalHandle, contents);
      return;
    } catch (error) {
      firstError ??= error;
      await verifyFinalBinding(parent, basename, finalHandle, contents);
    }
  }
  throw firstError;
}

async function reconcileExisting(
  bindings: readonly DirectoryBinding[],
  rootPath: string,
  parent: FileHandle,
  basename: string,
  contents: Buffer,
  dependencies: PathAuthorityDependencies,
  excludedTemporary = '',
): Promise<boolean> {
  const finalHandle = await bindFinalExact(parent, basename, contents);
  if (finalHandle === null) return false;
  try {
    await validateBindings(bindings, rootPath, dependencies);
    await reconcileTemporaryLinks(parent, basename, finalHandle, contents, excludedTemporary);
    await syncDirectory(parent, dependencies);
    await verifyFinalBinding(parent, basename, finalHandle, contents);
    await assertNoTemporaryEntries(parent, basename);
    await validateBindings(bindings, rootPath, dependencies);
    return true;
  } finally {
    await finalHandle.close().catch(() => undefined);
  }
}

async function publishExclusive(root: StateRootAuthority, relativePath: string, contents: Buffer): Promise<void> {
  if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') {
    throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'descriptor publication requires Linux no-follow support');
  }
  const parts = relativePath.split('/');
  const basename = parts.pop();
  if (!basename || parts.length < 1 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new EvidenceError('EVIDENCE_PATH_INVALID', 'evidence path is not stable');
  }
  try {
    await withStateRootSnapshot(root, async ({ snapshot, dependencies }) => {
      const handles: FileHandle[] = [];
      const bindings: DirectoryBinding[] = [];
      let temporary = '';
      let temporaryHandle: FileHandle | undefined;
      let temporaryBinding: FileBinding | undefined;
      let finalHandle: FileHandle | undefined;
      let primaryError: unknown;
      try {
        let current = await open(snapshot.path, DIR_FLAGS);
        handles.push(current);
        bindings.push(await bindDirectory(current, null, null));
        if (bindings[0]!.device !== snapshot.device || bindings[0]!.inode !== snapshot.inode) throw new EvidenceBindingError('state root identity changed');
        for (const part of parts) {
          let next: FileHandle;
          try {
            next = await openDirectory(current, part, true);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ELOOP' || code === 'ENOTDIR') throw new EvidenceBindingError('evidence path contains an unsafe ancestor', { cause: error });
            throw error;
          }
          handles.push(next);
          bindings.push(await bindDirectory(next, current, part));
          current = next;
        }
        const parent = current;
        await validateBindings(bindings, snapshot.path, dependencies);
        const existing = await bindFinalExact(parent, basename, contents);
        if (existing !== null) {
          await existing.close();
          if (await reconcileExisting(bindings, snapshot.path, parent, basename, contents, dependencies)) return;
          throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists');
        }
        try {
          const conflicting = await open(procChild(parent, basename), READ_FLAGS);
          await conflicting.close();
          throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists');
        } catch (error) {
          if (error instanceof EvidenceError) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error;
          if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists');
        }

        temporary = `.${basename}.${randomUUID()}.tmp`;
        temporaryHandle = await open(procChild(parent, temporary), FILE_FLAGS, 0o600);
        temporaryBinding = await bindFile(temporaryHandle);
        await temporaryHandle.writeFile(contents);
        await temporaryHandle.sync();
        await validateBindings(bindings, snapshot.path, dependencies);
        await validateFileBinding(parent, temporary, temporaryBinding);
        try {
          await link(procChild(parent, temporary), procChild(parent, basename));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST'
            && await reconcileExisting(bindings, snapshot.path, parent, basename, contents, dependencies, temporary)) return;
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new EvidenceError('EVIDENCE_EXISTS', 'canonical evidence already exists', { cause: error });
          throw error;
        }
        finalHandle = await open(procChild(parent, basename), READ_FLAGS);
        const temporaryIdentity = await temporaryBinding.handle.stat();
        const finalIdentity = await finalHandle.stat();
        if (!temporaryIdentity.isFile() || !finalIdentity.isFile()
          || temporaryIdentity.dev !== finalIdentity.dev || temporaryIdentity.ino !== finalIdentity.ino
          || temporaryIdentity.nlink < 2 || finalIdentity.nlink < 2) {
          throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'final evidence link identity is invalid');
        }
        await syncPublished(parent, basename, finalHandle, contents, dependencies);
        await verifyFinalBinding(parent, basename, finalHandle, contents);
        await validateBindings(bindings, snapshot.path, dependencies);
      } catch (error) {
        primaryError = error;
      } finally {
        const parent = bindings.at(-1)?.handle;
        let cleanupError: unknown;
        if (parent !== undefined && temporary !== '' && temporaryBinding !== undefined) {
          try {
            await validateFileBinding(parent, temporary, temporaryBinding);
            await unlink(procChild(parent, temporary));
            await assertTemporaryAbsent(parent, temporary);
          } catch (error) {
            cleanupError = error instanceof EvidenceError
              ? error
              : new EvidenceError('EVIDENCE_TEMPORARY_BLOCKER', 'temporary evidence cleanup failed', { cause: error });
          }
          try {
            if (finalHandle !== undefined) await reconcileTemporaryLinks(parent, basename, finalHandle, contents);
            else await assertNoTemporaryEntries(parent, basename);
            await syncDirectory(parent, dependencies);
            if (finalHandle !== undefined) await verifyFinalBinding(parent, basename, finalHandle, contents);
            await assertNoTemporaryEntries(parent, basename);
          } catch (error) {
            cleanupError ??= error;
          }
          try {
            await validateBindings(bindings, snapshot.path, dependencies);
          } catch (error) {
            cleanupError ??= error;
          }
        }
        await finalHandle?.close().catch(() => undefined);
        await temporaryHandle?.close().catch(() => undefined);
        for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
        if (cleanupError !== undefined) throw cleanupError;
        if (primaryError !== undefined) throw primaryError;
      }
    });
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    if (error instanceof EvidenceBindingError) throw new EvidenceError('EVIDENCE_PATH_INVALID', 'evidence ancestor identity changed', { cause: error });
    throw error;
  }
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
    try {
      evidence = validateInput(input);
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      if (error instanceof SharedValidationError) throw new EvidenceError('EVIDENCE_INVALID', error.message, { cause: error });
      throw error;
    }
    const path = evidenceRelativePath(evidence.jobId, evidence.stage);
    let encoded: string;
    try {
      encoded = encodeJson(evidence, 'stage evidence', true);
    } catch (error) {
      throw new EvidenceError('EVIDENCE_INVALID', 'stage evidence is not canonical JSON', { cause: error });
    }
    const contents = Buffer.from(`${encoded}\n`, 'utf8');
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (!SHA256.test(sha256)) throw new EvidenceError('EVIDENCE_PUBLICATION_FAILED', 'evidence hash could not be calculated');
    try {
      await this.#fileSystem.publishExclusive(this.#stateRoot, path, contents);
    } catch (error) {
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

export async function writeStageEvidence(
  options: { readonly stateRoot: StateRootAuthority; readonly fileSystem?: EvidenceFileSystem },
  input: StageEvidenceInput,
): Promise<EvidencePublication> {
  return createEvidenceWriter(options).write(input);
}
