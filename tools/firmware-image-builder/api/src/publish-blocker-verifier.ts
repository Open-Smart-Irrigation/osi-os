import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ConfigAuthorityError,
  withApprovedRootSnapshot,
  type ApprovedRootRegistry,
} from '../../config/load.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import { TARGET_IDS } from '../../domain/types.js';
import { JSON_LIMITS, TEXT_LIMITS } from './validation.js';
import type { JobRecord } from './store.js';
import type {
  FinalDestinationEvidence,
  FinalDestinationVerificationInput,
  FinalDestinationVerifier,
} from './publish-blocker-recheck.js';

const PROC_FD = '/proc/self/fd';
const O_CLOEXEC = (fsConstants as typeof fsConstants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0x80000;
const O_PATH = (fsConstants as typeof fsConstants & { readonly O_PATH?: number }).O_PATH ?? 0x200000;
const O_NOATIME = (fsConstants as typeof fsConstants & { readonly O_NOATIME?: number }).O_NOATIME ?? 0x40000;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC | O_NOATIME;
const FILE_INSPECTION_FLAGS = O_PATH | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const FILE_READ_FLAGS = fsConstants.O_RDONLY | O_CLOEXEC | O_NOATIME;
const FINAL_PARENT_MODE = 0o750;
const FINAL_LEAF_MODE = 0o700;
const MANAGED_DIRECTORY_MODES = [0o700, 0o750] as const;
const FILE_MODE = 0o600;
const MAX_SEGMENT_BYTES = 255;
const MAX_CHECKSUM_BYTES = TEXT_LIMITS.maxChecksumBytes;
const MAX_MANIFEST_BYTES = Math.min(JSON_LIMITS.maxEncodedBytes, TEXT_LIMITS.maxManifestBytes);
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type PublishBlockerFinalVerifierErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_BINDING'
  | 'AUTHORITY_DRIFT'
  | 'UNSAFE_PATH'
  | 'UNSAFE_DIRECTORY'
  | 'UNSAFE_FILE'
  | 'FILE_CHANGED'
  | 'HASH_MISMATCH'
  | 'STAGING_PRESENT'
  | 'FILESYSTEM';

export class PublishBlockerFinalVerifierError extends Error {
  readonly code: PublishBlockerFinalVerifierErrorCode;

  constructor(code: PublishBlockerFinalVerifierErrorCode, field: string) {
    super(`publish blocker final verification failed: ${code.toLowerCase()} (${field})`);
    this.name = 'PublishBlockerFinalVerifierError';
    this.code = code;
  }
}

export interface PublishBlockerFinalVerifierOptions {
  readonly beforeFinalRevalidation?: () => void | Promise<void>;
  readonly beforeStagingRecheck?: () => void | Promise<void>;
  readonly beforeAuthorityRecheck?: () => void | Promise<void>;
  readonly afterAuthorityRecheck?: () => void | Promise<void>;
  readonly betweenStagingPasses?: () => void | Promise<void>;
}

interface HeldDirectory {
  readonly path: string;
  readonly parts: readonly string[];
  readonly handle: FileHandle;
  readonly stats: Stats;
  readonly mode: number;
}

interface HeldFile {
  readonly path: string;
  readonly name: string;
  readonly handle: FileHandle;
  readonly stats: Stats;
}

interface Binding {
  readonly finalDirectory: string;
  readonly finalPath: string;
  readonly stagingPath: string;
  readonly artifactSha256: string;
  readonly artifactSize: number;
}

function fail(code: PublishBlockerFinalVerifierErrorCode, field: string): never {
  throw new PublishBlockerFinalVerifierError(code, field);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function safeSegment(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_SEGMENT_BYTES
  ) return fail('UNSAFE_PATH', field);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return fail('UNSAFE_PATH', field);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return fail('UNSAFE_PATH', field);
    }
  }
  return value;
}

function safeRelative(value: unknown, field: string): readonly string[] {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.endsWith('/')) {
    return fail('UNSAFE_PATH', field);
  }
  const parts = value.split('/').map((part, index) => safeSegment(part, `${field}-${index}`));
  if (parts.length === 0) return fail('UNSAFE_PATH', field);
  return parts;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameStats(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.atimeMs === right.atimeMs
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameRootIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function modeOf(stats: Stats): number {
  return stats.mode & 0o7777;
}

function assertDirectory(
  stats: Stats,
  field: string,
  ownerUid: number,
  device: number,
  expectedMode: number | readonly number[],
): void {
  const modes = typeof expectedMode === 'number' ? [expectedMode] : expectedMode;
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== ownerUid
    || stats.dev !== device
    || !modes.includes(modeOf(stats))
    || stats.nlink < 2
  ) return fail('UNSAFE_DIRECTORY', field);
}

function assertFile(stats: Stats, field: string, ownerUid: number, device: number): void {
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.uid !== ownerUid
    || stats.dev !== device
    || modeOf(stats) !== FILE_MODE
    || stats.nlink !== 1
  ) return fail('UNSAFE_FILE', field);
}

function fdPath(parent: FileHandle, name?: string): string {
  return name === undefined ? `${PROC_FD}/${String(parent.fd)}` : join(PROC_FD, String(parent.fd), name);
}

async function close(handle: FileHandle | null): Promise<void> {
  if (handle === null) return;
  await handle.close().catch(() => undefined);
}

async function openDirectory(parent: FileHandle, name: string, field: string): Promise<HeldDirectory> {
  const handle = await open(fdPath(parent, safeSegment(name, field)), DIRECTORY_FLAGS);
  try {
    const stats = await handle.stat();
    return { path: field, parts: field.split('/'), handle, stats, mode: modeOf(stats) };
  } catch (error) {
    await close(handle);
    throw error;
  }
}

async function openFile(parent: FileHandle, name: string, field: string, ownerUid: number, device: number): Promise<HeldFile> {
  const safeName = safeSegment(name, field);
  let inspected: FileHandle | null = null;
  let readable: FileHandle | null = null;
  try {
    inspected = await open(fdPath(parent, safeName), FILE_INSPECTION_FLAGS);
    const inspectedStats = await inspected.stat();
    assertFile(inspectedStats, field, ownerUid, device);
    readable = await open(fdPath(inspected), FILE_READ_FLAGS);
    const readableStats = await readable.stat();
    assertFile(readableStats, field, ownerUid, device);
    if (!sameStats(inspectedStats, readableStats)) return fail('FILE_CHANGED', field);
    const result = { path: field, name: safeName, handle: readable, stats: readableStats };
    readable = null;
    return result;
  } finally {
    await close(readable);
    await close(inspected);
  }
}

async function openOptionalDirectory(
  parent: FileHandle,
  name: string,
  field: string,
  ownerUid: number,
  device: number,
  expectedMode: number | readonly number[] = MANAGED_DIRECTORY_MODES,
): Promise<HeldDirectory | null> {
  try {
    const result = await openDirectory(parent, name, field);
    try {
      assertDirectory(result.stats, field, ownerUid, device, expectedMode);
      return result;
    } catch (error) {
      await close(result.handle);
      throw error;
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function hashFile(
  file: HeldFile,
  expectedSha256: string,
  expectedSize: number | null,
  expectedMtime: string | null,
  maxBytes: number | null,
): Promise<Readonly<{ sha256: string; size: number; mtime: string }>> {
  const before = await file.handle.stat();
  if (!sameStats(file.stats, before)) return fail('FILE_CHANGED', file.path);
  assertFile(before, file.path, before.uid, before.dev);
  if (expectedSize !== null && before.size !== expectedSize) return fail('FILE_CHANGED', file.path);
  if (expectedMtime !== null && before.mtime.toISOString() !== expectedMtime) return fail('FILE_CHANGED', file.path);
  if (maxBytes !== null && before.size > maxBytes) return fail('FILE_CHANGED', file.path);
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < before.size) {
    const result = await file.handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
    if (result.bytesRead <= 0) return fail('FILE_CHANGED', file.path);
    digest.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  const after = await file.handle.stat();
  if (!sameStats(before, after)) return fail('FILE_CHANGED', file.path);
  if (digest.digest('hex') !== expectedSha256) return fail('HASH_MISMATCH', file.path);
  return { sha256: expectedSha256, size: after.size, mtime: after.mtime.toISOString() };
}

async function revalidateChain(
  root: FileHandle,
  rootStats: Stats,
  directories: readonly HeldDirectory[],
  file: HeldFile,
  ownerUid: number,
  device: number,
): Promise<void> {
  const currentRoot = await root.stat();
  if (!sameRootIdentity(rootStats, currentRoot)) return fail('AUTHORITY_DRIFT', 'root');
  let current = root;
  const opened: FileHandle[] = [];
  try {
    for (const directory of directories) {
      const name = directory.parts[directory.parts.length - 1]!;
      const child = await open(fdPath(current, safeSegment(name, directory.path)), DIRECTORY_FLAGS);
      opened.push(child);
      const stats = await child.stat();
      assertDirectory(stats, directory.path, ownerUid, device, directory.mode);
      if (!sameStats(directory.stats, stats)) return fail('FILE_CHANGED', directory.path);
      current = child;
    }
    const checked = await openFile(current, file.name, file.path, ownerUid, device);
    try {
      if (!sameStats(file.stats, checked.stats)) return fail('FILE_CHANGED', file.path);
    } finally {
      await close(checked.handle);
    }
  } finally {
    for (const handle of opened.reverse()) await close(handle);
  }
}

async function assertStagingAbsent(
  root: FileHandle,
  jobId: string,
  ownerUid: number,
  device: number,
  betweenPasses?: () => void | Promise<void>,
): Promise<void> {
  let firstBuilder: HeldDirectory | null | undefined;
  let firstStaging: HeldDirectory | null | undefined;
  for (let pass = 0; pass < 2; pass += 1) {
    const builder = await openOptionalDirectory(root, '.osi-image-builder', '.osi-image-builder', ownerUid, device);
    try {
      if (pass === 0) firstBuilder = builder;
      else {
        if (firstBuilder === undefined) return fail('FILE_CHANGED', 'staging');
        if ((firstBuilder === null) !== (builder === null) || (firstBuilder !== null && builder !== null && !sameStats(firstBuilder.stats, builder.stats))) return fail('FILE_CHANGED', 'staging');
      }
      if (builder === null) continue;
      const staging = await openOptionalDirectory(builder.handle, 'staging', '.osi-image-builder/staging', ownerUid, device);
      try {
        if (pass === 0) firstStaging = staging;
        else {
          if (firstStaging === undefined) return fail('FILE_CHANGED', 'staging');
          if ((firstStaging === null) !== (staging === null) || (firstStaging !== null && staging !== null && !sameStats(firstStaging.stats, staging.stats))) return fail('FILE_CHANGED', 'staging');
        }
        if (staging === null) continue;
        let job: HeldDirectory | null = null;
        try {
          job = await openOptionalDirectory(staging.handle, jobId, `.osi-image-builder/staging/${jobId}`, ownerUid, device);
        } finally {
          await close(job?.handle ?? null);
        }
        if (job !== null) return fail('STAGING_PRESENT', 'staging');
        const currentBuilder = await builder.handle.stat();
        const currentStaging = await staging.handle.stat();
        if (!sameStats(builder.stats, currentBuilder) || !sameStats(staging.stats, currentStaging)) return fail('FILE_CHANGED', 'staging');
      } finally {
        await close(staging?.handle ?? null);
      }
    } finally {
      await close(builder?.handle ?? null);
    }
    if (pass === 0) await betweenPasses?.();
  }
}

function bindingFor(job: JobRecord): Binding {
  if (
    job.state !== 'failed'
    || job.publishState !== 'blocked'
    || job.publishBlockerCode !== 'UNVERIFIED_FINAL_PATH_BLOCKER'
  ) return fail('INVALID_BINDING', 'job-eligibility');
  const blocker = record(job.publishBlocker);
  const binding = record(blocker?.binding);
  const branchSlug = (() => {
    try { return encodeBranchSlug(job.branch); } catch { return fail('INVALID_BINDING', 'branch'); }
  })();
  const targetId = safeSegment(job.targetId, 'target');
  if (
    !JOB_ID.test(job.jobId)
    || !SHA40.test(job.pinnedSha)
    || !SHA64.test(job.artifactSha256 ?? '')
    || !SHA64.test(job.checksumSha256 ?? '')
    || !SHA64.test(job.manifestSha256 ?? '')
    || !SHA64.test(job.verificationSha256 ?? '')
    || !Number.isSafeInteger(job.artifactSize)
    || Number(job.artifactSize) < 0
    || job.artifactMtime === null
    || binding === null
  ) return fail('INVALID_BINDING', 'job');
  const finalDirectory = `${branchSlug}/${job.pinnedSha}/${targetId}`;
  const stagingDirectory = `staging/${job.jobId}`;
  const stagingPath = binding.stagingPath;
  const finalPath = binding.finalPath;
  if (
    binding.jobId !== job.jobId
    || binding.rootId !== job.rootId
    || binding.branch !== job.branch
    || binding.branchSlug !== branchSlug
    || binding.pinnedSha !== job.pinnedSha
    || binding.targetId !== targetId
    || binding.stagingDirectory !== stagingDirectory
    || typeof stagingPath !== 'string'
    || !stagingPath.startsWith(`${stagingDirectory}/`)
    || stagingPath.slice(stagingDirectory.length + 1).includes('/')
    || typeof finalPath !== 'string'
    || finalPath !== `${finalDirectory}/${stagingPath.slice(stagingDirectory.length + 1)}`
    || binding.finalDirectory !== finalDirectory
    || binding.artifactSha256 !== job.artifactSha256
    || binding.artifactSize !== job.artifactSize
    || !TARGET_IDS.includes(targetId as (typeof TARGET_IDS)[number])
  ) return fail('INVALID_BINDING', 'binding');
  const artifactName = safeSegment(stagingPath.slice(stagingDirectory.length + 1), 'artifact');
  if (
    job.checksumPath !== `${stagingDirectory}/sha256sums`
    || job.manifestPath !== `${stagingDirectory}/build-manifest.json`
    || job.verificationPath !== `${stagingDirectory}/verification.json`
    || typeof job.artifactMtime !== 'string'
  ) return fail('INVALID_BINDING', 'sidecars');
  safeRelative(finalDirectory, 'final-directory');
  safeRelative(finalPath, 'final-path');
  return { finalDirectory, finalPath, stagingPath, artifactSha256: job.artifactSha256!, artifactSize: job.artifactSize!, };
}

export function createPublishBlockerFinalVerifier(
  registry: ApprovedRootRegistry,
  options: PublishBlockerFinalVerifierOptions = {},
): FinalDestinationVerifier {
  return Object.freeze({
    async verify(input: FinalDestinationVerificationInput): Promise<FinalDestinationEvidence> {
      if (process.platform !== 'linux') return fail('UNSUPPORTED_PLATFORM', 'linux');
      const binding = bindingFor(input.job);
      if (input.finalDirectory !== binding.finalDirectory || input.finalPath !== binding.finalPath) return fail('INVALID_BINDING', 'input');
      try {
        return await withApprovedRootSnapshot(registry, input.job.rootId, async ({ snapshot }) => {
          const root = await open(snapshot.path, DIRECTORY_FLAGS);
          let rootStats: Stats;
          const directories: HeldDirectory[] = [];
          const files: HeldFile[] = [];
          try {
            rootStats = await root.stat();
            if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || rootStats.dev !== snapshot.device || rootStats.ino !== snapshot.inode) return fail('AUTHORITY_DRIFT', 'root');
            const ownerUid = rootStats.uid;
            let current = root;
            const finalParts = safeRelative(binding.finalDirectory, 'final-directory');
            for (const [index, part] of finalParts.entries()) {
              const path = finalParts.slice(0, index + 1).join('/');
              const expectedMode = index === finalParts.length - 1 ? FINAL_LEAF_MODE : FINAL_PARENT_MODE;
              const directory = await openDirectory(current, part, path);
              try {
                assertDirectory(directory.stats, path, ownerUid, rootStats.dev, expectedMode);
              } catch (error) {
                await close(directory.handle);
                throw error;
              }
              directories.push({ ...directory, parts: path.split('/'), mode: expectedMode });
              current = directory.handle;
            }
            const finalDirectory = directories[directories.length - 1];
            if (finalDirectory === undefined) return fail('INVALID_BINDING', 'final-directory');
            const artifact = await openFile(finalDirectory.handle, binding.finalPath.slice(binding.finalDirectory.length + 1), binding.finalPath, ownerUid, rootStats.dev);
            files.push(artifact);
            const checksum = await openFile(finalDirectory.handle, 'sha256sums', `${binding.finalDirectory}/sha256sums`, ownerUid, rootStats.dev);
            files.push(checksum);
            const manifest = await openFile(finalDirectory.handle, 'build-manifest.json', `${binding.finalDirectory}/build-manifest.json`, ownerUid, rootStats.dev);
            files.push(manifest);
            const verification = await openFile(finalDirectory.handle, 'verification.json', `${binding.finalDirectory}/verification.json`, ownerUid, rootStats.dev);
            files.push(verification);
            const identities = new Set(files.map((file) => `${file.stats.dev}:${file.stats.ino}`));
            if (identities.size !== files.length) return fail('UNSAFE_FILE', 'distinct-files');
            const artifactEvidence = await hashFile(artifact, input.job.artifactSha256!, input.job.artifactSize!, input.job.artifactMtime, null);
            const checksumEvidence = await hashFile(checksum, input.job.checksumSha256!, null, null, MAX_CHECKSUM_BYTES);
            const manifestEvidence = await hashFile(manifest, input.job.manifestSha256!, null, null, MAX_MANIFEST_BYTES);
            const verificationEvidence = await hashFile(verification, input.job.verificationSha256!, null, null, MAX_MANIFEST_BYTES);
            await options.beforeFinalRevalidation?.();
            for (const file of files) await revalidateChain(root, rootStats, directories, file, ownerUid, rootStats.dev);
            await options.beforeAuthorityRecheck?.();
            await withApprovedRootSnapshot(registry, input.job.rootId, async ({ snapshot: current }) => {
              if (current.path !== snapshot.path || current.device !== snapshot.device || current.inode !== snapshot.inode) return fail('AUTHORITY_DRIFT', 'root');
            });
            for (const file of files) await revalidateChain(root, rootStats, directories, file, ownerUid, rootStats.dev);
            await options.afterAuthorityRecheck?.();
            await options.beforeStagingRecheck?.();
            await assertStagingAbsent(root, input.job.jobId, ownerUid, rootStats.dev, options.betweenStagingPasses);
            return Object.freeze({
              finalDirectory: binding.finalDirectory,
              finalPath: binding.finalPath,
              artifact: Object.freeze({ sha256: artifactEvidence.sha256, size: artifactEvidence.size, mtime: artifactEvidence.mtime }),
              checksum: Object.freeze({ path: `${binding.finalDirectory}/sha256sums`, sha256: checksumEvidence.sha256 }),
              manifest: Object.freeze({ path: `${binding.finalDirectory}/build-manifest.json`, sha256: manifestEvidence.sha256 }),
              verification: Object.freeze({ path: `${binding.finalDirectory}/verification.json`, sha256: verificationEvidence.sha256 }),
              staging: Object.freeze({ path: `staging/${input.job.jobId}`, state: 'absent' as const }),
            });
          } finally {
            for (const file of files.reverse()) await close(file.handle);
            for (const directory of directories.reverse()) await close(directory.handle);
            await close(root);
          }
        });
      } catch (error) {
        if (error instanceof PublishBlockerFinalVerifierError) throw error;
        if (error instanceof ConfigAuthorityError) throw new PublishBlockerFinalVerifierError('AUTHORITY_DRIFT', 'approved-root');
        throw new PublishBlockerFinalVerifierError('FILESYSTEM', 'descriptor-verification');
      }
    },
  });
}
