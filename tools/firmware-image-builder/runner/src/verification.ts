import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats, Dirent, Stats } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import {
  withStateRootSnapshot,
  type PathAuthorityDependencies,
  type StateRootAuthority,
} from '../../config/load.js';
import {
  canonicalInstant,
  encodeJson,
  normalizeJson,
  stableRelativePath,
} from '../../api/src/validation.js';
import { REQUIRED_RUNTIME_FILES, type TargetManifest } from '../../manifest/schema.js';
import type { FreshnessResult, TargetId } from '../../domain/types.js';

const PROC_FD = '/proc/self/fd';
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ROUTES = ['/gui/', '/auth/', '/api/', '/download/'] as const;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const RELATIVE_HELPERS = Object.freeze([
  'osi-chameleon-helper',
  'osi-chirpstack-helper',
  'osi-cloud-http',
  'osi-db-helper',
  'osi-dendro-helper',
  'osi-health-helper',
  'osi-history-helper',
  'osi-history-sync-helper',
  'osi-lib',
] as const);
const DIRECT_HELPERS = Object.freeze([
  'osi-command-ledger',
  'osi-dendro-analytics',
  'osi-zone-env',
  'osi-history-router',
  'osi-journal',
  'osi-device-writer',
  'osi-uc512-normalize',
  'osi-lsn50-normalize',
] as const);
const ALL_HELPERS = Object.freeze([...RELATIVE_HELPERS, ...DIRECT_HELPERS] as const);
const REQUIRED_ROOTFS_FILES = Object.freeze(
  REQUIRED_RUNTIME_FILES.filter((path) => !path.includes('/node_modules/osi-')),
);
const THIRD_PARTY_PACKAGES = Object.freeze([
  '@grpc/grpc-js',
  '@chirpstack/chirpstack-api',
  'google-protobuf',
  'protobufjs',
] as const);

export type VerificationErrorCode =
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_STALE'
  | 'ARTIFACT_TOO_SMALL'
  | 'BUILD_OUTPUT_COLLISION'
  | 'CHECKSUM_FAILED'
  | 'GZIP_FAILED'
  | 'TARGET_CONFIG_MISMATCH'
  | 'ROOTFS_CONTENT_FAILED'
  | 'VERIFICATION_EVIDENCE_INVALID';

export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: VerificationErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VerificationError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface WorkspaceAuthority {
  readonly stateRoot: StateRootAuthority;
  readonly jobId: string;
}

export interface ApiFreshnessRequest {
  readonly jobId: string;
  readonly branch: string;
  readonly pinnedSha: string;
}

export interface ApiOwnedFreshnessBoundary {
  readonly requestFreshness: (request: ApiFreshnessRequest) => Promise<unknown>;
}

export interface ProfileConfigEvidence {
  readonly target: TargetId;
  readonly environment: string;
  readonly selectedTarget: string;
  readonly profile: string;
  readonly rootfsPartSize: number;
  readonly sourceSha256: string;
  readonly resolvedSha256: string;
}

export interface VerificationInput {
  readonly workspace: WorkspaceAuthority;
  readonly target: TargetManifest;
  readonly targets: readonly TargetManifest[];
  readonly buildStartedAt: string;
  readonly sourceEvidence: {
    readonly targetId: TargetId;
    readonly openwrtTarget: string;
    readonly targetOutputAbsent: boolean;
    readonly checkedTargetOutputPath: string;
  };
  readonly config: {
    readonly selectedTarget: string;
    readonly profile: string;
    readonly rootfsPartSize: number;
    readonly bothProfilesChecked: true;
    readonly profiles: Readonly<Record<TargetId, ProfileConfigEvidence>>;
  };
  readonly pinnedSha: string;
  readonly branch: string;
  readonly freshness: ApiOwnedFreshnessBoundary;
}

export interface VerificationResult {
  readonly artifact: {
    readonly path: string;
    readonly basename: string;
    readonly size: number;
    readonly mtime: string;
    readonly sha256: string;
    readonly gzip: true;
  };
  readonly checks: {
    readonly originalOpenWrtSha256sums: {
      readonly path: string;
      readonly verified: true;
      readonly entries: readonly string[];
    };
    readonly generatedSha256sums: {
      readonly contents: string;
      readonly sha256: string;
      readonly verified: true;
      readonly filenames: readonly [string];
    };
  };
  readonly config: VerificationInput['config'];
  readonly rootfs: {
    readonly requiredFiles: readonly string[];
    readonly nginxRoutes: Readonly<Record<(typeof ROUTES)[number], boolean>>;
    readonly gui: { readonly title: string; readonly sha256: string; readonly feedSha256: string };
    readonly criticalHashes: Readonly<Record<'flows' | 'database' | 'gui', {
      readonly sourceSha256: string;
      readonly rootfsSha256: string;
      readonly matched: true;
    }>>;
    readonly helpers: {
      readonly relativeSymlinks: readonly string[];
      readonly directUntilFirstBoot: readonly string[];
      readonly firstBootSeedVerified: true;
    };
    readonly nodeResolution: Readonly<Record<string, boolean>>;
    readonly database: { readonly integrityCheck: 'ok'; readonly chameleonCalibrationRows: number };
  };
  readonly freshness: FreshnessResult;
  readonly evidence: { readonly json: Record<string, unknown>; readonly bytes: number; readonly sha256: string };
}

interface DirectoryBinding {
  readonly handle: FileHandle;
  readonly parent: FileHandle | null;
  readonly basename: string | null;
  readonly device: number;
  readonly inode: number;
}

interface HeldFile {
  readonly procPath: string;
  readonly stat: () => Promise<Stats>;
  readonly read: (maxBytes?: number) => Promise<Buffer>;
  readonly hashSha256: () => Promise<string>;
  readonly verifyGzip: () => Promise<void>;
}

interface HeldDirectory {
  readonly entries: () => Promise<readonly Dirent[]>;
  readonly inspect: (basename: string) => Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'>;
  readonly readSymlink: (basename: string) => Promise<string>;
}

function fail(
  code: VerificationErrorCode,
  message: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
  cause?: unknown,
): never {
  throw new VerificationError(code, message, details, cause === undefined ? undefined : { cause });
}

function procChild(parent: FileHandle, basename: string): string {
  return join(PROC_FD, String(parent.fd), basename);
}

function safeSegments(relativePath: string): readonly string[] {
  let stable: string;
  try {
    stable = stableRelativePath(relativePath, 'workspace relative path');
  } catch (error) {
    return fail('ROOTFS_CONTENT_FAILED', 'verification path is not confined to the job workspace', {}, error);
  }
  return stable.split('/');
}

function safeBasename(value: string): string {
  const segments = safeSegments(value);
  if (segments.length !== 1) fail('ROOTFS_CONTENT_FAILED', 'verification basename is not confined');
  return segments[0]!;
}

function hashBytes(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function bindDirectory(
  handle: FileHandle,
  parent: FileHandle | null,
  basename: string | null,
): Promise<DirectoryBinding> {
  const info = await handle.stat();
  if (!info.isDirectory()) fail('ROOTFS_CONTENT_FAILED', 'workspace binding is not a directory');
  return Object.freeze({
    handle,
    parent,
    basename,
    device: info.dev,
    inode: info.ino,
  });
}

class WorkspaceReader {
  readonly #rootPath: string;
  readonly #dependencies: PathAuthorityDependencies;
  readonly #baseBindings: readonly DirectoryBinding[];
  readonly #baseHandles: readonly FileHandle[];

  private constructor(
    rootPath: string,
    dependencies: PathAuthorityDependencies,
    baseBindings: readonly DirectoryBinding[],
    baseHandles: readonly FileHandle[],
  ) {
    this.#rootPath = rootPath;
    this.#dependencies = dependencies;
    this.#baseBindings = baseBindings;
    this.#baseHandles = baseHandles;
  }

  static async open(
    jobId: string,
    rootPath: string,
    dependencies: PathAuthorityDependencies,
    expectedDevice: number,
    expectedInode: number,
  ): Promise<WorkspaceReader> {
    if (process.platform !== 'linux' || typeof fsConstants.O_NOFOLLOW !== 'number') {
      fail('ROOTFS_CONTENT_FAILED', 'workspace verification requires Linux no-follow descriptors');
    }
    let safeJobId: string;
    try {
      safeJobId = stableRelativePath(jobId, 'jobId');
    } catch (error) {
      return fail('ROOTFS_CONTENT_FAILED', 'job ID is not a safe workspace segment', {}, error);
    }
    if (safeJobId.includes('/')) fail('ROOTFS_CONTENT_FAILED', 'job ID is not one workspace segment');
    const handles: FileHandle[] = [];
    const bindings: DirectoryBinding[] = [];
    try {
      let current = await open(rootPath, DIR_FLAGS);
      handles.push(current);
      const rootBinding = await bindDirectory(current, null, null);
      if (rootBinding.device !== expectedDevice || rootBinding.inode !== expectedInode) {
        fail('ROOTFS_CONTENT_FAILED', 'state-root identity changed while opening');
      }
      bindings.push(rootBinding);
      for (const basename of ['jobs', safeJobId, 'workspace', 'source']) {
        await WorkspaceReader.validateBindings(rootPath, dependencies, bindings);
        const next = await open(procChild(current, basename), DIR_FLAGS);
        handles.push(next);
        bindings.push(await bindDirectory(next, current, basename));
        current = next;
      }
      await WorkspaceReader.validateBindings(rootPath, dependencies, bindings);
      return new WorkspaceReader(rootPath, dependencies, Object.freeze(bindings), Object.freeze(handles));
    } catch (error) {
      for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
      if (error instanceof VerificationError) throw error;
      return fail('ROOTFS_CONTENT_FAILED', 'job workspace authority could not be opened', {}, error);
    }
  }

  static async validateBindings(
    rootPath: string,
    dependencies: PathAuthorityDependencies,
    bindings: readonly DirectoryBinding[],
  ): Promise<void> {
    const leaf = bindings.at(-1);
    if (!leaf) fail('ROOTFS_CONTENT_FAILED', 'workspace authority has no bindings');
    await dependencies.beforeDirectoryAccess?.(leaf.handle);
    const root = bindings[0]!;
    const namedRoot = await lstat(rootPath);
    const heldRoot = await root.handle.stat();
    if (namedRoot.isSymbolicLink()
      || !namedRoot.isDirectory()
      || !heldRoot.isDirectory()
      || namedRoot.dev !== root.device
      || namedRoot.ino !== root.inode
      || heldRoot.dev !== root.device
      || heldRoot.ino !== root.inode) {
      fail('ROOTFS_CONTENT_FAILED', 'state-root binding was replaced during verification');
    }
    for (const binding of bindings.slice(1)) {
      const named = await lstat(procChild(binding.parent!, binding.basename!));
      const held = await binding.handle.stat();
      if (named.isSymbolicLink()
        || !named.isDirectory()
        || !held.isDirectory()
        || named.dev !== binding.device
        || named.ino !== binding.inode
        || held.dev !== binding.device
        || held.ino !== binding.inode) {
        fail('ROOTFS_CONTENT_FAILED', 'workspace ancestor was replaced during verification', {
          component: binding.basename,
        });
      }
    }
  }

  async close(): Promise<void> {
    for (const handle of [...this.#baseHandles].reverse()) {
      await handle.close().catch(() => undefined);
    }
  }

  async #validate(bindings: readonly DirectoryBinding[] = this.#baseBindings): Promise<void> {
    await WorkspaceReader.validateBindings(this.#rootPath, this.#dependencies, bindings);
  }

  async #withDirectoryBindings<T>(
    relativePath: string,
    callback: (binding: DirectoryBinding, bindings: readonly DirectoryBinding[]) => Promise<T>,
  ): Promise<T> {
    const segments = safeSegments(relativePath);
    const handles: FileHandle[] = [];
    const bindings = [...this.#baseBindings];
    let current = bindings.at(-1)!.handle;
    try {
      for (const basename of segments) {
        await this.#validate(bindings);
        const next = await open(procChild(current, basename), DIR_FLAGS);
        handles.push(next);
        const binding = await bindDirectory(next, current, basename);
        bindings.push(binding);
        current = next;
      }
      await this.#validate(bindings);
      const result = await callback(bindings.at(-1)!, bindings);
      await this.#validate(bindings);
      return result;
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      return fail('ROOTFS_CONTENT_FAILED', 'workspace directory traversal failed closed', {
        path: relativePath,
      }, error);
    } finally {
      for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    }
  }

  async withDirectory<T>(
    relativePath: string,
    callback: (directory: HeldDirectory) => Promise<T>,
  ): Promise<T> {
    return this.#withDirectoryBindings(relativePath, async (binding, bindings) => {
      const inspect = async (basenameInput: string): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'> => {
        const basename = safeBasename(basenameInput);
        await this.#validate(bindings);
        let info: Stats;
        try {
          info = await lstat(procChild(binding.handle, basename));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
          throw error;
        }
        await this.#validate(bindings);
        if (info.isSymbolicLink()) return 'symlink';
        if (info.isFile()) return 'file';
        if (info.isDirectory()) return 'directory';
        return 'other';
      };
      const directory: HeldDirectory = Object.freeze({
        entries: async () => {
          await this.#validate(bindings);
          const entries = await readdir(join(PROC_FD, String(binding.handle.fd)), { withFileTypes: true });
          await this.#validate(bindings);
          return Object.freeze(entries.sort((left, right) => left.name.localeCompare(right.name)));
        },
        inspect,
        readSymlink: async (basenameInput: string) => {
          const basename = safeBasename(basenameInput);
          await this.#validate(bindings);
          const before = await lstat(procChild(binding.handle, basename), { bigint: true });
          if (!before.isSymbolicLink()) fail('ROOTFS_CONTENT_FAILED', 'helper link is not a symlink', { helper: basename });
          const target = await readlink(procChild(binding.handle, basename));
          const after = await lstat(procChild(binding.handle, basename), { bigint: true });
          await this.#validate(bindings);
          if (!sameFile(before, after)) fail('ROOTFS_CONTENT_FAILED', 'helper symlink changed during verification', { helper: basename });
          return target;
        },
      });
      return callback(directory);
    });
  }

  async withFile<T>(
    relativePath: string,
    callback: (file: HeldFile) => Promise<T>,
  ): Promise<T> {
    const segments = safeSegments(relativePath);
    const basename = segments.at(-1)!;
    const parentPath = segments.slice(0, -1).join('/');
    return this.#withDirectoryBindings(parentPath, async (parent, bindings) => {
      let handle: FileHandle | undefined;
      try {
        await this.#validate(bindings);
        handle = await open(procChild(parent.handle, basename), FILE_FLAGS);
        const initial = await this.#dependencies.statBigInt(handle);
        if (!initial.isFile()) fail('ROOTFS_CONTENT_FAILED', 'verification target is not a regular file', { path: relativePath });

        const stable = async (): Promise<BigIntStats> => {
          const current = await this.#dependencies.statBigInt(handle!);
          if (!current.isFile() || !sameFile(initial, current)) {
            fail('ROOTFS_CONTENT_FAILED', 'verification file changed while held', { path: relativePath });
          }
          return current;
        };
        const held: HeldFile = Object.freeze({
          procPath: join(PROC_FD, String(handle.fd)),
          stat: async () => {
            await stable();
            return this.#dependencies.stat(handle!);
          },
          read: async (maxBytes = MAX_FILE_BYTES) => {
            if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_FILE_BYTES) {
              fail('ROOTFS_CONTENT_FAILED', 'verification read exceeds its bounded limit', { path: relativePath });
            }
            const info = await stable();
            if (info.size > BigInt(maxBytes)) fail('ROOTFS_CONTENT_FAILED', 'verification file exceeds its bounded limit', { path: relativePath });
            await this.#dependencies.beforeRead(handle!);
            const output = Buffer.alloc(Number(info.size));
            let position = 0;
            while (position < output.length) {
              const read = await handle!.read(output, position, output.length - position, position);
              if (read.bytesRead === 0) fail('ROOTFS_CONTENT_FAILED', 'verification file changed during read', { path: relativePath });
              position += read.bytesRead;
            }
            await stable();
            await this.#validate(bindings);
            return output;
          },
          hashSha256: async () => {
            const info = await stable();
            await this.#dependencies.beforeRead(handle!);
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(1024 * 1024);
            for (let position = 0n; position < info.size;) {
              const length = Number(info.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : info.size - position);
              const read = await handle!.read(buffer, 0, length, Number(position));
              if (read.bytesRead === 0) fail('ROOTFS_CONTENT_FAILED', 'verification file changed during hash', { path: relativePath });
              hash.update(buffer.subarray(0, read.bytesRead));
              position += BigInt(read.bytesRead);
            }
            await stable();
            await this.#validate(bindings);
            return hash.digest('hex');
          },
          verifyGzip: async () => {
            await stable();
            await this.#dependencies.beforeRead(handle!);
            try {
              await pipeline(
                handle!.createReadStream({ autoClose: false, start: 0 }),
                createGunzip(),
                async (source) => {
                  for await (const _chunk of source) {
                    // Drain target bytes without executing them or materializing the image.
                  }
                },
              );
            } catch (error) {
              return fail('GZIP_FAILED', 'the factory image is not valid gzip', { path: relativePath }, error);
            }
            await stable();
            await this.#validate(bindings);
          },
        });
        const result = await callback(held);
        await stable();
        await this.#validate(bindings);
        return result;
      } catch (error) {
        if (error instanceof VerificationError) throw error;
        return fail('ROOTFS_CONTENT_FAILED', 'workspace file traversal failed closed', {
          path: relativePath,
        }, error);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    });
  }
}

async function withWorkspace<T>(
  authority: WorkspaceAuthority,
  callback: (workspace: WorkspaceReader) => Promise<T>,
): Promise<T> {
  return withStateRootSnapshot(authority.stateRoot, async ({ snapshot, dependencies }) => {
    const workspace = await WorkspaceReader.open(
      authority.jobId,
      snapshot.path,
      dependencies,
      snapshot.device,
      snapshot.inode,
    );
    try {
      return await callback(workspace);
    } finally {
      await workspace.close();
    }
  });
}

function globPattern(pattern: string): RegExp {
  let expression = '^';
  for (const character of pattern) {
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else expression += /[\\^$+?.()|{}[\]]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, 'u');
}

function validateTargets(input: VerificationInput): Readonly<Record<TargetId, TargetManifest>> {
  const byId = new Map(input.targets.map((target) => [target.id, target]));
  if (byId.size !== 2 || !byId.has('rpi-5') || !byId.has('rpi-2') || byId.get(input.target.id) !== input.target) {
    fail('TARGET_CONFIG_MISMATCH', 'verification requires both manifest targets and the selected manifest identity');
  }
  return Object.freeze({
    'rpi-5': byId.get('rpi-5')!,
    'rpi-2': byId.get('rpi-2')!,
  });
}

async function verifyConfig(
  workspace: WorkspaceReader,
  input: VerificationInput,
  targets: Readonly<Record<TargetId, TargetManifest>>,
): Promise<void> {
  if (input.config.bothProfilesChecked !== true
    || input.config.selectedTarget !== input.target.openwrtTarget
    || input.config.profile !== input.target.profile
    || input.config.rootfsPartSize !== input.target.rootfsPartSize) {
    fail('TARGET_CONFIG_MISMATCH', 'selected target configuration does not match the manifest');
  }
  const keys = Object.keys(input.config.profiles).sort();
  if (keys.join(',') !== 'rpi-2,rpi-5') fail('TARGET_CONFIG_MISMATCH', 'both Task 15 profile hash records are required');
  for (const targetId of ['rpi-5', 'rpi-2'] as const) {
    const target = targets[targetId];
    const profile = input.config.profiles[targetId];
    if (!profile
      || profile.target !== targetId
      || profile.environment !== target.environment
      || profile.selectedTarget !== target.openwrtTarget
      || profile.profile !== target.profile
      || profile.rootfsPartSize !== target.rootfsPartSize
      || !SHA256.test(profile.sourceSha256)
      || !SHA256.test(profile.resolvedSha256)) {
      fail('TARGET_CONFIG_MISMATCH', 'Task 15 profile configuration evidence is incomplete or contradictory', { target: targetId });
    }
    const resolvedHash = await workspace.withFile(
      `conf/${target.environment}/.config`,
      (file) => file.hashSha256(),
    );
    if (resolvedHash !== profile.resolvedSha256) {
      fail('TARGET_CONFIG_MISMATCH', 'Task 15 resolved configuration hash no longer matches the workspace', { target: targetId });
    }
  }
}

async function directoryEntries(
  workspace: WorkspaceReader,
  relativePath: string,
): Promise<readonly Dirent[]> {
  return workspace.withDirectory(relativePath, (directory) => directory.entries());
}

async function hashTree(workspace: WorkspaceReader, root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (relativeDirectory: string, prefix: string): Promise<void> => {
    const before = await directoryEntries(workspace, relativeDirectory);
    for (const entry of before) {
      const path = `${relativeDirectory}/${entry.name}`;
      const treePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) fail('ROOTFS_CONTENT_FAILED', 'payload tree contains a symlink', { path });
      if (entry.isDirectory()) {
        await visit(path, treePath);
      } else if (entry.isFile()) {
        hash.update(treePath);
        hash.update('\0');
        hash.update(await workspace.withFile(path, (file) => file.hashSha256()));
      } else {
        fail('ROOTFS_CONTENT_FAILED', 'payload tree contains an unsupported filesystem entry', { path });
      }
    }
    const after = await directoryEntries(workspace, relativeDirectory);
    if (before.map((entry) => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : entry.isSymbolicLink() ? 'l' : 'o'}`).join('\0')
      !== after.map((entry) => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : entry.isSymbolicLink() ? 'l' : 'o'}`).join('\0')) {
      fail('ROOTFS_CONTENT_FAILED', 'payload tree changed during hashing', { path: relativeDirectory });
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

function titleOf(contents: string): string {
  const match = contents.match(/<title>\s*([^<]+?)\s*<\/title>/iu);
  if (!match) fail('ROOTFS_CONTENT_FAILED', 'GUI index.html has no title');
  return match[1]!;
}

async function textFile(
  workspace: WorkspaceReader,
  relativePath: string,
): Promise<string> {
  const bytes = await workspace.withFile(relativePath, (file) => file.read(MAX_TEXT_BYTES));
  return bytes.toString('utf8');
}

async function verifyOriginalChecksums(
  workspace: WorkspaceReader,
  targetDirectory: string,
  artifactName: string,
): Promise<VerificationResult['checks']['originalOpenWrtSha256sums']> {
  const checksumPath = `${targetDirectory}/sha256sums`;
  const lines = (await textFile(workspace, checksumPath))
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (lines.length === 0) fail('CHECKSUM_FAILED', 'OpenWrt sha256sums is empty');
  const entries: string[] = [];
  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s+[* ](.+)$/u.exec(line);
    const filename = match?.[2];
    let stableFilename: string;
    try {
      stableFilename = stableRelativePath(filename ?? '', 'OpenWrt checksum filename');
    } catch (error) {
      return fail('CHECKSUM_FAILED', 'OpenWrt sha256sums contains an unsafe entry', {}, error);
    }
    if (!match || !filename || stableFilename !== filename || stableFilename.includes('/')) {
      fail('CHECKSUM_FAILED', 'OpenWrt sha256sums contains an unsafe entry');
    }
    const observed = await workspace.withFile(
      `${targetDirectory}/${filename}`,
      (file) => file.hashSha256(),
    );
    if (observed !== match[1]) fail('CHECKSUM_FAILED', 'OpenWrt checksum validation failed', { filename });
    entries.push(filename);
  }
  if (!entries.includes(artifactName)) fail('CHECKSUM_FAILED', 'OpenWrt checksums omit the factory image');
  return Object.freeze({
    path: `${targetDirectory}/sha256sums`,
    verified: true as const,
    entries: Object.freeze(entries),
  });
}

async function verifyArtifact(
  workspace: WorkspaceReader,
  input: VerificationInput,
): Promise<{
  readonly artifact: VerificationResult['artifact'];
  readonly checks: VerificationResult['checks'];
}> {
  const targetDirectory = `openwrt/bin/targets/${input.target.openwrtTarget}`;
  let entries: readonly Dirent[];
  try {
    entries = await directoryEntries(workspace, targetDirectory);
  } catch (error) {
    if (error instanceof VerificationError) {
      throw new VerificationError('ARTIFACT_MISSING', 'target output directory is missing or unsafe', {}, { cause: error });
    }
    throw error;
  }
  const factoryEntries = entries.filter((entry) => entry.name.endsWith('-factory.img.gz'));
  if (factoryEntries.length === 0) fail('ARTIFACT_MISSING', 'target output contains no factory image');
  if (factoryEntries.length !== 1) {
    fail('BUILD_OUTPUT_COLLISION', 'target output must contain exactly one factory image overall', { count: factoryEntries.length });
  }
  const entry = factoryEntries[0]!;
  if (!entry.isFile() || !globPattern(input.target.artifactGlob).test(entry.name)) {
    fail('BUILD_OUTPUT_COLLISION', 'factory image does not match the selected target manifest');
  }
  const artifactPath = `${targetDirectory}/${entry.name}`;
  const artifactData = await workspace.withFile(artifactPath, async (file) => {
    const info = await file.stat();
    const startedAt = Date.parse(canonicalInstant(input.buildStartedAt, 'buildStartedAt'));
    if (info.mtimeMs <= startedAt) {
      fail('ARTIFACT_STALE', 'factory image predates the build start', {
        mtimeMs: info.mtimeMs,
        buildStartedAt: startedAt,
      });
    }
    if (info.size < input.target.minimumArtifactBytes) {
      fail('ARTIFACT_TOO_SMALL', 'factory image is below the manifest size floor', {
        size: info.size,
        minimum: input.target.minimumArtifactBytes,
      });
    }
    const sha256 = await file.hashSha256();
    await file.verifyGzip();
    return {
      path: artifactPath,
      basename: entry.name,
      size: info.size,
      mtime: new Date(info.mtimeMs).toISOString(),
      sha256,
      gzip: true as const,
    };
  });
  const originalOpenWrtSha256sums = await verifyOriginalChecksums(
    workspace,
    targetDirectory,
    entry.name,
  );
  const finalHash = await workspace.withFile(artifactPath, (file) => file.hashSha256());
  if (finalHash !== artifactData.sha256) fail('CHECKSUM_FAILED', 'factory image changed after checksum verification');
  const generatedContents = `${artifactData.sha256}  ${entry.name}\n`;
  const generatedSha256sums = Object.freeze({
    contents: generatedContents,
    sha256: hashBytes(Buffer.from(generatedContents, 'utf8')),
    verified: true as const,
    filenames: [entry.name] as const,
  });
  return Object.freeze({
    artifact: Object.freeze(artifactData),
    checks: Object.freeze({ originalOpenWrtSha256sums, generatedSha256sums }),
  });
}

async function verifyPackageResolution(
  workspace: WorkspaceReader,
  packageRoot: string,
  expectedName: string,
): Promise<void> {
  const packageJson = await textFile(workspace, `${packageRoot}/package.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch (error) {
    return fail('ROOTFS_CONTENT_FAILED', 'Node package manifest is invalid', {
      package: expectedName,
    }, error);
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { name?: unknown }).name !== expectedName) {
    fail('ROOTFS_CONTENT_FAILED', 'Node package identity does not match its path', {
      package: expectedName,
    });
  }
  const declaredMain = (parsed as { main?: unknown }).main;
  if (declaredMain !== undefined && typeof declaredMain !== 'string') {
    fail('ROOTFS_CONTENT_FAILED', 'Node package main entrypoint is invalid', {
      package: expectedName,
    });
  }
  const main = declaredMain ?? 'index.js';
  const segments = safeSegments(main);
  if (segments.join('/') !== main) {
    fail('ROOTFS_CONTENT_FAILED', 'Node package main entrypoint is not canonical', {
      package: expectedName,
    });
  }
  await workspace.withFile(`${packageRoot}/${main}`, (file) => file.stat());
}

async function verifyHelperLayout(
  workspace: WorkspaceReader,
  rootfs: string,
): Promise<VerificationResult['rootfs']['helpers']> {
  const nodeRed = `${rootfs}/usr/share/node-red`;
  const nodeModules = `${nodeRed}/node_modules`;
  for (const helper of ALL_HELPERS) {
    await verifyPackageResolution(workspace, `${nodeRed}/${helper}`, helper);
  }
  await workspace.withDirectory(nodeModules, async (directory) => {
    for (const helper of RELATIVE_HELPERS) {
      if (await directory.inspect(helper) !== 'symlink') {
        fail('ROOTFS_CONTENT_FAILED', 'required helper is not deployed through its relative symlink', { helper });
      }
      const target = await directory.readSymlink(helper);
      if (target !== `../${helper}`) {
        fail('ROOTFS_CONTENT_FAILED', 'helper symlink target is not the exact confined relative target', { helper });
      }
    }
    for (const helper of DIRECT_HELPERS) {
      if (await directory.inspect(helper) !== 'missing') {
        fail('ROOTFS_CONTENT_FAILED', 'direct first-boot helper unexpectedly exists in rootfs node_modules', { helper });
      }
    }
  });
  const seed = await textFile(workspace, `${rootfs}/etc/uci-defaults/98_osi_node_red_seed`);
  const moduleLoop = /for module in\s+([^;\r\n]+);\s*do/u.exec(seed);
  const seededHelpers = moduleLoop?.[1]?.trim().split(/\s+/u) ?? [];
  if (seededHelpers.length !== ALL_HELPERS.length
    || [...seededHelpers].sort().join('\0') !== [...ALL_HELPERS].sort().join('\0')
    || !seed.includes('cp -a "$SRC/$module" "$DST/$module"')
    || !seed.includes('cp -a "$SRC/$module" "$DST/node_modules/$module"')) {
    fail('ROOTFS_CONTENT_FAILED', 'first-boot seed does not copy every shipped helper into runtime node_modules');
  }
  return Object.freeze({
    relativeSymlinks: RELATIVE_HELPERS,
    directUntilFirstBoot: DIRECT_HELPERS,
    firstBootSeedVerified: true as const,
  });
}

async function verifyNginxRoutes(
  workspace: WorkspaceReader,
  rootfs: string,
): Promise<Readonly<Record<(typeof ROUTES)[number], boolean>>> {
  const nginxRoot = `${rootfs}/etc/nginx`;
  const contents: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await directoryEntries(workspace, directory);
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) fail('ROOTFS_CONTENT_FAILED', 'nginx configuration contains a symlink', { path });
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) contents.push(await textFile(workspace, path));
    }
  };
  await visit(nginxRoot);
  const joined = contents.join('\n');
  const observations = Object.fromEntries(ROUTES.map((route) => {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const present = new RegExp(`\\blocation\\s+(?:(?:\\^~|=)\\s+)?${escaped}(?:\\s|\\{|$)`, 'u').test(joined);
    return [route, present];
  })) as Record<(typeof ROUTES)[number], boolean>;
  const missing = ROUTES.find((route) => !observations[route]);
  if (missing) fail('ROOTFS_CONTENT_FAILED', 'required nginx route is missing', { route: missing });
  return Object.freeze(observations);
}

async function verifyRootfs(
  workspace: WorkspaceReader,
  input: VerificationInput,
): Promise<VerificationResult['rootfs']> {
  const rootfs = `openwrt/${input.target.rootfs}`;
  const requiredFiles: string[] = [];
  for (const absolutePath of REQUIRED_ROOTFS_FILES) {
    const relativePath = `${rootfs}${absolutePath}`;
    await workspace.withFile(relativePath, (file) => file.stat());
    requiredFiles.push(absolutePath);
  }
  const helpers = await verifyHelperLayout(workspace, rootfs);
  const nodeResolution: Record<string, boolean> = {};
  for (const packageName of THIRD_PARTY_PACKAGES) {
    await verifyPackageResolution(
      workspace,
      `${rootfs}/usr/share/node-red/node_modules/${packageName}`,
      packageName,
    );
    nodeResolution[packageName] = true;
  }
  for (const helper of ALL_HELPERS) nodeResolution[helper] = true;

  const feedGui = 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui';
  const rootfsGui = `${rootfs}/usr/lib/node-red/gui`;
  const feedTitle = titleOf(await textFile(workspace, `${feedGui}/index.html`));
  const rootfsTitle = titleOf(await textFile(workspace, `${rootfsGui}/index.html`));
  if (feedTitle !== rootfsTitle) fail('ROOTFS_CONTENT_FAILED', 'rootfs GUI title differs from the frontend feed mirror');
  const feedGuiSha256 = await hashTree(workspace, feedGui);
  const rootfsGuiSha256 = await hashTree(workspace, rootfsGui);
  if (feedGuiSha256 !== rootfsGuiSha256) fail('ROOTFS_CONTENT_FAILED', 'rootfs GUI payload differs from the frontend feed mirror');

  const sourceProfile = `conf/${input.target.environment}/files`;
  const sourceFlows = `${sourceProfile}/usr/share/flows.json`;
  const rootfsFlows = `${rootfs}/usr/share/flows.json`;
  const sourceDatabase = `${sourceProfile}/usr/share/db/farming.db`;
  const rootfsDatabase = `${rootfs}/usr/share/db/farming.db`;
  const sourceFlowsSha256 = await workspace.withFile(sourceFlows, (file) => file.hashSha256());
  const rootfsFlowsSha256 = await workspace.withFile(rootfsFlows, (file) => file.hashSha256());
  const sourceDatabaseSha256 = await workspace.withFile(sourceDatabase, (file) => file.hashSha256());
  const rootfsDatabaseSha256 = await workspace.withFile(rootfsDatabase, (file) => file.hashSha256());
  if (sourceFlowsSha256 !== rootfsFlowsSha256) fail('ROOTFS_CONTENT_FAILED', 'rootfs flows differ from selected profile source');
  if (sourceDatabaseSha256 !== rootfsDatabaseSha256) fail('ROOTFS_CONTENT_FAILED', 'rootfs database differs from selected profile source');

  const databaseResult = await workspace.withFile(rootfsDatabase, async (file) => {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(file.procPath, { readOnly: true });
      const integrity = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
      if (integrity.integrity_check !== 'ok') fail('ROOTFS_CONTENT_FAILED', 'SQLite integrity_check did not return ok');
      const count = database.prepare('SELECT COUNT(*) AS count FROM chameleon_calibrations').get() as { count?: number | bigint };
      return {
        integrityCheck: 'ok' as const,
        chameleonCalibrationRows: Number(count.count ?? 0),
      };
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      return fail('ROOTFS_CONTENT_FAILED', 'rootfs database failed SQLite or Chameleon verification', {}, error);
    } finally {
      database?.close();
    }
  });

  return Object.freeze({
    requiredFiles: Object.freeze(requiredFiles),
    nginxRoutes: await verifyNginxRoutes(workspace, rootfs),
    gui: Object.freeze({
      title: rootfsTitle,
      sha256: rootfsGuiSha256,
      feedSha256: feedGuiSha256,
    }),
    criticalHashes: Object.freeze({
      flows: Object.freeze({ sourceSha256: sourceFlowsSha256, rootfsSha256: rootfsFlowsSha256, matched: true as const }),
      database: Object.freeze({ sourceSha256: sourceDatabaseSha256, rootfsSha256: rootfsDatabaseSha256, matched: true as const }),
      gui: Object.freeze({ sourceSha256: feedGuiSha256, rootfsSha256: rootfsGuiSha256, matched: true as const }),
    }),
    helpers,
    nodeResolution: Object.freeze(nodeResolution),
    database: Object.freeze(databaseResult),
  });
}

function informationalUnknown(pinnedSha: string): FreshnessResult {
  return Object.freeze({
    status: 'unknown',
    pinnedSha,
    observedSha: null,
    newerSourceAvailable: false,
    errorCode: 'FRESHNESS_UNKNOWN',
  });
}

function normalizeFreshness(value: unknown, pinnedSha: string): FreshnessResult {
  if (!value || typeof value !== 'object') return informationalUnknown(pinnedSha);
  const candidate = value as Record<string, unknown>;
  const exactKeys = Object.keys(candidate).sort().join(',');
  if (candidate.status === 'fresh'
    && exactKeys === 'newerSourceAvailable,observedSha,pinnedSha,status'
    && candidate.pinnedSha === pinnedSha
    && candidate.observedSha === pinnedSha
    && candidate.newerSourceAvailable === false) {
    return Object.freeze(candidate as unknown as FreshnessResult);
  }
  if (candidate.status === 'advanced'
    && exactKeys === 'newerSourceAvailable,observedSha,pinnedSha,status'
    && candidate.pinnedSha === pinnedSha
    && typeof candidate.observedSha === 'string'
    && SHA40.test(candidate.observedSha)
    && candidate.observedSha !== pinnedSha
    && candidate.newerSourceAvailable === true) {
    return Object.freeze(candidate as unknown as FreshnessResult);
  }
  if (candidate.status === 'unknown'
    && exactKeys === 'errorCode,newerSourceAvailable,observedSha,pinnedSha,status'
    && candidate.pinnedSha === pinnedSha
    && candidate.observedSha === null
    && candidate.newerSourceAvailable === false
    && candidate.errorCode === 'FRESHNESS_UNKNOWN') {
    return Object.freeze(candidate as unknown as FreshnessResult);
  }
  return informationalUnknown(pinnedSha);
}

async function requestFreshness(input: VerificationInput): Promise<FreshnessResult> {
  try {
    const response = await input.freshness.requestFreshness(Object.freeze({
      jobId: input.workspace.jobId,
      branch: input.branch,
      pinnedSha: input.pinnedSha,
    }));
    return normalizeFreshness(response, input.pinnedSha);
  } catch {
    return informationalUnknown(input.pinnedSha);
  }
}

export async function verifyFirmwareArtifact(input: VerificationInput): Promise<VerificationResult> {
  const targets = validateTargets(input);
  const exactTargetOutput = `openwrt/bin/targets/${input.target.openwrtTarget}/`;
  if (input.sourceEvidence.targetOutputAbsent !== true
    || input.sourceEvidence.targetId !== input.target.id
    || input.sourceEvidence.openwrtTarget !== input.target.openwrtTarget
    || input.sourceEvidence.checkedTargetOutputPath !== exactTargetOutput) {
    fail('BUILD_OUTPUT_COLLISION', 'source evidence does not bind exact target-output absence');
  }
  if (!SHA40.test(input.pinnedSha)) fail('ROOTFS_CONTENT_FAILED', 'pinned source SHA is invalid');
  canonicalInstant(input.buildStartedAt, 'buildStartedAt');

  const verified = await withWorkspace(input.workspace, async (workspace) => {
    await verifyConfig(workspace, input, targets);
    const artifact = await verifyArtifact(workspace, input);
    const rootfs = await verifyRootfs(workspace, input);
    return { artifact, rootfs };
  });
  const freshness = await requestFreshness(input);
  let evidenceValue: ReturnType<typeof normalizeJson>;
  let encoded: string;
  try {
    evidenceValue = normalizeJson({
      schemaVersion: 1,
      artifact: verified.artifact.artifact,
      checks: {
        originalOpenWrtSha256sums: {
          path: verified.artifact.checks.originalOpenWrtSha256sums.path,
          verified: true,
          entries: verified.artifact.checks.originalOpenWrtSha256sums.entries,
        },
        generatedSha256sums: {
          verified: true,
          filenames: verified.artifact.checks.generatedSha256sums.filenames,
        },
      },
      config: input.config,
      rootfs: verified.rootfs,
      freshness,
    }, 'verification evidence');
    encoded = encodeJson(evidenceValue, 'verification evidence', true);
  } catch (error) {
    throw new VerificationError(
      'VERIFICATION_EVIDENCE_INVALID',
      'verification evidence is not canonical and bounded',
      {},
      { cause: error },
    );
  }
  const bytes = Buffer.byteLength(`${encoded}\n`, 'utf8');
  return Object.freeze({
    artifact: verified.artifact.artifact,
    checks: verified.artifact.checks,
    config: Object.freeze(input.config),
    rootfs: verified.rootfs,
    freshness,
    evidence: Object.freeze({
      json: evidenceValue as Record<string, unknown>,
      bytes,
      sha256: hashBytes(Buffer.from(`${encoded}\n`, 'utf8')),
    }),
  });
}

export const verifyFirmwareArtifacts = verifyFirmwareArtifact;
