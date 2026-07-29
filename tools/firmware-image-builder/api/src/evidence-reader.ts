import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { BigIntStats, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { parseJson } from './validation.js';
import { ConfigAuthorityError, withStateRootSnapshot, type PathAuthorityDependencies, type StateRootAuthority } from '../../config/load.js';
import { PIPELINE_STAGE_NAMES, type PipelineStageName } from '../../domain/types.js';

const DEFAULT_MAX_BYTES = 65_536;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROC_FD = '/proc/self/fd';
const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | O_CLOEXEC;

export interface EvidenceIndex {
  readonly jobId: string;
  readonly stage: PipelineStageName;
  readonly path: string;
  readonly sha256: string;
}

export type EvidenceReadErrorCode =
  | 'CONFIG_INVALID'
  | 'INDEX_INVALID'
  | 'PATH_UNSAFE'
  | 'NOT_FOUND'
  | 'FILE_UNSAFE'
  | 'SIZE_INVALID'
  | 'RACE_DETECTED'
  | 'DIGEST_MISMATCH'
  | 'UTF8_INVALID'
  | 'JSON_INVALID'
  | 'PLATFORM_UNSUPPORTED'
  | 'READ_FAILED';

export class EvidenceReadError extends Error {
  readonly code: EvidenceReadErrorCode;

  constructor(code: EvidenceReadErrorCode, message: string) {
    super(message);
    this.name = 'EvidenceReadError';
    this.code = code;
  }
}

export interface IndexedEvidenceReaderOptions {
  readonly stateRoot: StateRootAuthority;
  readonly ownerUid?: number;
  readonly maxBytes?: number;
}

export interface IndexedEvidenceReader {
  readonly read: (index: EvidenceIndex) => Promise<unknown>;
}

interface HeldDirectories {
  readonly root: FileHandle;
  readonly jobs: FileHandle;
  readonly job: FileHandle;
  readonly evidence: FileHandle;
}

interface FileSnapshot {
  readonly stats: Stats;
  readonly precise: BigIntStats;
}

function fail(code: EvidenceReadErrorCode): never {
  throw new EvidenceReadError(code, messageFor(code));
}

function messageFor(code: EvidenceReadErrorCode): string {
  switch (code) {
    case 'CONFIG_INVALID': return 'evidence reader configuration is invalid';
    case 'INDEX_INVALID': return 'evidence index is invalid';
    case 'PATH_UNSAFE': return 'evidence path is unsafe';
    case 'NOT_FOUND': return 'evidence file was not found';
    case 'FILE_UNSAFE': return 'evidence file metadata is unsafe';
    case 'SIZE_INVALID': return 'evidence file size is invalid';
    case 'RACE_DETECTED': return 'evidence file or path changed during read';
    case 'DIGEST_MISMATCH': return 'evidence digest does not match its index';
    case 'UTF8_INVALID': return 'evidence is not valid UTF-8';
    case 'JSON_INVALID': return 'evidence is not a JSON object';
    case 'PLATFORM_UNSUPPORTED': return 'indexed evidence reading requires Linux';
    case 'READ_FAILED': return 'evidence could not be read';
  }
}

function pathFor(jobId: string, stage: PipelineStageName): string {
  return `jobs/${jobId}/evidence/${String(PIPELINE_STAGE_NAMES.indexOf(stage)).padStart(2, '0')}-${stage}.json`;
}

function validateIndex(index: EvidenceIndex): { readonly jobId: string; readonly stage: PipelineStageName; readonly basename: string } {
  if (index === null || typeof index !== 'object') return fail('INDEX_INVALID');
  if (!JOB_ID.test(index.jobId)) return fail('INDEX_INVALID');
  if (!(PIPELINE_STAGE_NAMES as readonly unknown[]).includes(index.stage)) return fail('INDEX_INVALID');
  if (typeof index.path !== 'string' || index.path !== pathFor(index.jobId, index.stage)) return fail('INDEX_INVALID');
  if (typeof index.sha256 !== 'string' || !SHA256.test(index.sha256)) return fail('INDEX_INVALID');
  return { jobId: index.jobId, stage: index.stage, basename: index.path.slice(index.path.lastIndexOf('/') + 1) };
}

function validateOptions(options: IndexedEvidenceReaderOptions): { readonly ownerUid: number; readonly maxBytes: number } {
  if (process.platform !== 'linux') return fail('PLATFORM_UNSUPPORTED');
  const ownerUid = options.ownerUid ?? (typeof process.geteuid === 'function' ? process.geteuid() : undefined);
  if (ownerUid === undefined || !Number.isSafeInteger(ownerUid) || ownerUid < 0) return fail('CONFIG_INVALID');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) return fail('CONFIG_INVALID');
  return { ownerUid, maxBytes };
}

function procChild(parent: FileHandle, name: string): string {
  return `${PROC_FD}/${String(parent.fd)}/${name}`;
}

function isDirectory(stats: Stats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

function assertDirectory(stats: Stats, ownerUid: number, device: number, inode?: number): void {
  if (!isDirectory(stats) || stats.dev !== device || (inode !== undefined && stats.ino !== inode) || stats.uid !== ownerUid || (stats.mode & 0o7777) !== 0o700) {
    fail('PATH_UNSAFE');
  }
}

function assertFile(stats: Stats, ownerUid: number, device: number, maxBytes: number): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.dev !== device || stats.uid !== ownerUid || (stats.mode & 0o7777) !== 0o600 || stats.nlink !== 1) {
    fail('FILE_UNSAFE');
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maxBytes) fail('SIZE_INVALID');
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return isDirectory(left) && isDirectory(right) && left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && (left.mode & 0o7777) === (right.mode & 0o7777);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink
    && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function openError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') return fail('NOT_FOUND');
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EXDEV') return fail('PATH_UNSAFE');
  return fail('READ_FAILED');
}

async function openTracked(path: string, flags: number, handles: FileHandle[]): Promise<FileHandle> {
  let handle: FileHandle;
  try { handle = await open(path, flags); } catch (error) { return openError(error); }
  handles.push(handle);
  return handle;
}

async function statSnapshot(handle: FileHandle, dependencies: PathAuthorityDependencies): Promise<FileSnapshot> {
  return { stats: await dependencies.stat(handle), precise: await dependencies.statBigInt(handle) };
}

async function holdDirectory(
  parent: FileHandle,
  name: string,
  dependencies: PathAuthorityDependencies,
  handles: FileHandle[],
): Promise<FileHandle> {
  await dependencies.beforeDirectoryAccess?.(parent);
  return openTracked(procChild(parent, name), DIRECTORY_FLAGS, handles);
}

async function checkNamedFile(
  parent: FileHandle,
  basename: string,
  held: FileSnapshot,
  ownerUid: number,
  device: number,
  maxBytes: number,
  dependencies: PathAuthorityDependencies,
  handles: FileHandle[],
): Promise<void> {
  const named = await openTracked(procChild(parent, basename), FILE_FLAGS, handles);
  const namedSnapshot = await statSnapshot(named, dependencies);
  assertFile(namedSnapshot.stats, ownerUid, device, maxBytes);
  if (!sameFile(namedSnapshot.stats, held.stats) || !sameStableFile(namedSnapshot.precise, held.precise)) fail('RACE_DETECTED');
}

async function revalidateCurrentChain(
  stateRoot: StateRootAuthority,
  held: HeldDirectories,
  jobId: string,
  ownerUid: number,
  device: number,
  handles: FileHandle[],
): Promise<FileHandle> {
  try {
    return await withStateRootSnapshot(stateRoot, async ({ snapshot: current, dependencies: currentDependencies }) => {
      assertDirectory(await currentDependencies.stat(held.root), ownerUid, device, current.inode);
      assertDirectory(await currentDependencies.stat(held.jobs), ownerUid, device);
      assertDirectory(await currentDependencies.stat(held.job), ownerUid, device);
      assertDirectory(await currentDependencies.stat(held.evidence), ownerUid, device);

      const currentRoot = await openTracked(current.path, DIRECTORY_FLAGS, handles);
      const currentRootSnapshot = await statSnapshot(currentRoot, currentDependencies);
      assertDirectory(currentRootSnapshot.stats, ownerUid, device, current.inode);
      if (!sameDirectory(currentRootSnapshot.stats, await currentDependencies.stat(held.root))) fail('RACE_DETECTED');

      const currentJobs = await holdDirectory(currentRoot, 'jobs', currentDependencies, handles);
      const currentJobsSnapshot = await statSnapshot(currentJobs, currentDependencies);
      assertDirectory(currentJobsSnapshot.stats, ownerUid, device);
      if (!sameDirectory(currentJobsSnapshot.stats, await currentDependencies.stat(held.jobs))) fail('RACE_DETECTED');

      const currentJob = await holdDirectory(currentJobs, jobId, currentDependencies, handles);
      const currentJobSnapshot = await statSnapshot(currentJob, currentDependencies);
      assertDirectory(currentJobSnapshot.stats, ownerUid, device);
      if (!sameDirectory(currentJobSnapshot.stats, await currentDependencies.stat(held.job))) fail('RACE_DETECTED');

      const currentEvidence = await holdDirectory(currentJob, 'evidence', currentDependencies, handles);
      const currentEvidenceSnapshot = await statSnapshot(currentEvidence, currentDependencies);
      assertDirectory(currentEvidenceSnapshot.stats, ownerUid, device);
      if (!sameDirectory(currentEvidenceSnapshot.stats, await currentDependencies.stat(held.evidence))) fail('RACE_DETECTED');
      return currentEvidence;
    });
  } catch (error) {
    if (error instanceof EvidenceReadError) throw error;
    if (error instanceof ConfigAuthorityError) fail('RACE_DETECTED');
    throw error;
  }
}

function normalizeError(error: unknown): EvidenceReadError {
  if (error instanceof ConfigAuthorityError) return new EvidenceReadError('PATH_UNSAFE', messageFor('PATH_UNSAFE'));
  return error instanceof EvidenceReadError ? error : new EvidenceReadError('READ_FAILED', messageFor('READ_FAILED'));
}

export function createIndexedEvidenceReader(options: IndexedEvidenceReaderOptions): IndexedEvidenceReader {
  const { ownerUid, maxBytes } = validateOptions(options);

  return Object.freeze({
    read: async (index: EvidenceIndex): Promise<unknown> => {
      const validated = validateIndex(index);
      const handles: FileHandle[] = [];
      let closeDependencies: PathAuthorityDependencies | undefined;
      let primaryError: unknown;
      let result: unknown;
      try {
        result = await withStateRootSnapshot(options.stateRoot, async ({ snapshot, dependencies }) => {
          closeDependencies = dependencies;
          const root = await openTracked(snapshot.path, DIRECTORY_FLAGS, handles);
          const rootSnapshot = await statSnapshot(root, dependencies);
          assertDirectory(rootSnapshot.stats, ownerUid, snapshot.device, snapshot.inode);

          const jobs = await holdDirectory(root, 'jobs', dependencies, handles);
          const jobsSnapshot = await statSnapshot(jobs, dependencies);
          assertDirectory(jobsSnapshot.stats, ownerUid, snapshot.device);

          const job = await holdDirectory(jobs, validated.jobId, dependencies, handles);
          const jobSnapshot = await statSnapshot(job, dependencies);
          assertDirectory(jobSnapshot.stats, ownerUid, snapshot.device);

          const evidence = await holdDirectory(job, 'evidence', dependencies, handles);
          const evidenceSnapshot = await statSnapshot(evidence, dependencies);
          assertDirectory(evidenceSnapshot.stats, ownerUid, snapshot.device);

          const file = await openTracked(procChild(evidence, validated.basename), FILE_FLAGS, handles);
          const before = await statSnapshot(file, dependencies);
          assertFile(before.stats, ownerUid, snapshot.device, maxBytes);
          if (!sameFile(before.stats, await dependencies.stat(file))) fail('RACE_DETECTED');
          await checkNamedFile(evidence, validated.basename, before, ownerUid, snapshot.device, maxBytes, dependencies, handles);

          await dependencies.beforeRead(file);
          const bytes = Buffer.alloc(before.stats.size);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await file.read(bytes, offset, bytes.length - offset, offset);
            if (read.bytesRead <= 0 || read.bytesRead > bytes.length - offset) fail('RACE_DETECTED');
            offset += read.bytesRead;
          }

          const after = await statSnapshot(file, dependencies);
          assertFile(after.stats, ownerUid, snapshot.device, maxBytes);
          if (!sameStableFile(before.precise, after.precise)) fail('RACE_DETECTED');

          const currentEvidence = await revalidateCurrentChain(options.stateRoot, { root, jobs, job, evidence }, validated.jobId, ownerUid, snapshot.device, handles);
          await checkNamedFile(currentEvidence, validated.basename, after, ownerUid, snapshot.device, maxBytes, dependencies, handles);

          const digest = createHash('sha256').update(bytes).digest('hex');
          if (digest !== index.sha256) fail('DIGEST_MISMATCH');
          let text: string;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('UTF8_INVALID'); }
          try { return parseJson(text, 'evidence', true); } catch { fail('JSON_INVALID'); }
        });
      } catch (error) {
        primaryError = normalizeError(error);
      }

      let closeError: unknown;
      for (const handle of handles.reverse()) {
        try { await (closeDependencies?.close(handle) ?? handle.close()); } catch (error) { closeError ??= error; }
      }
      if (primaryError !== undefined) throw primaryError;
      if (closeError !== undefined) throw normalizeError(closeError);
      return result;
    },
  });
}
