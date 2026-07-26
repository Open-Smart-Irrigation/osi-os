import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
import {
  authenticateTargetManifests,
  ManifestValidationError,
} from '../../manifest/validate.js';
import { REQUIRED_RUNTIME_FILES, type TargetManifest } from '../../manifest/schema.js';
import type { TargetId } from '../../domain/types.js';
import {
  requestPersistedFreshness,
  type FreshnessBoundary,
  type VerificationFreshnessResult,
} from './freshness.js';

const PROC_FD = '/proc/self/fd';
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ROUTES = ['/gui/', '/auth/', '/api/', '/download/'] as const;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
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
const FIRST_BOOT_SEED_COMMANDS = Object.freeze([
  'set -eu',
  'SRC=/usr/share/node-red',
  'DST=/srv/node-red',
  'mkdir -p "$DST" "$DST/node_modules"',
  'chown node-red:node-red "$DST" "$DST/node_modules" 2>/dev/null || true',
  'if [ -f /usr/share/flows.json ] && [ ! -f "$DST/flows.json" ]; then',
  'cp /usr/share/flows.json "$DST/flows.json"',
  'fi',
  'if [ -f "$SRC/settings.js" ] && [ ! -f "$DST/settings.js" ]; then',
  'cp "$SRC/settings.js" "$DST/settings.js"',
  'fi',
  'if [ -f "$SRC/package.json" ] && [ ! -f "$DST/package.json" ]; then',
  'cp "$SRC/package.json" "$DST/package.json"',
  'fi',
  'if [ -f "$SRC/package-lock.json" ] && [ ! -f "$DST/package-lock.json" ]; then',
  'cp "$SRC/package-lock.json" "$DST/package-lock.json"',
  'fi',
  'if [ -f "$SRC/edge-channels.json" ]; then',
  'cp "$SRC/edge-channels.json" "$DST/edge-channels.json"',
  'fi',
  'if [ -d "$SRC/codecs" ]; then',
  'mkdir -p "$DST/codecs"',
  'cp -a "$SRC/codecs/." "$DST/codecs/"',
  'fi',
  'if [ -d "$SRC/node_modules" ]; then',
  'cp -a "$SRC/node_modules/." "$DST/node_modules/"',
  'fi',
  'rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"',
  'for module in osi-chameleon-helper osi-chirpstack-helper osi-cloud-http osi-command-ledger osi-db-helper osi-dendro-helper osi-dendro-analytics osi-zone-env osi-history-helper osi-history-sync-helper osi-history-router osi-health-helper osi-lib osi-journal osi-device-writer osi-uc512-normalize osi-lsn50-normalize; do',
  'if [ -d "$SRC/$module" ]; then',
  'rm -rf "$DST/$module" "$DST/node_modules/$module"',
  'cp -a "$SRC/$module" "$DST/$module"',
  'cp -a "$SRC/$module" "$DST/node_modules/$module"',
  'fi',
  'done',
  'SQLITE_SRC=/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3',
  'if [ -d "$SQLITE_SRC" ]; then',
  'ln -s "$SQLITE_SRC" "$DST/node_modules/sqlite3"',
  'fi',
  'chown -R node-red:node-red "$DST" 2>/dev/null || true',
  'exit 0',
] as const);
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

export interface ProfileConfigEvidence {
  readonly target: TargetId;
  readonly environment: string;
  readonly selectedTarget: string;
  readonly profile: string;
  readonly rootfsPartSize: number;
  readonly sourceSha256: string;
  readonly sourceConfigEvidencePath: string;
  readonly resolvedSha256: string;
}

export interface RootfsNodeResolutionRequest {
  readonly targetId: TargetId;
  readonly modules: readonly {
    readonly packageName: string;
    readonly specifier: string;
  }[];
}

export interface RootfsNodeResolutionResult {
  readonly targetId: TargetId;
  readonly modules: readonly {
    readonly packageName: string;
    readonly resolvedRelativePath: string;
    readonly exportType: 'function' | 'object' | 'incompatible';
  }[];
}

export interface TrustedRootfsVerifierOperation {
  readonly resolve: (
    request: RootfsNodeResolutionRequest,
  ) => Promise<RootfsNodeResolutionResult>;
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
  readonly nodeVerifier: TrustedRootfsVerifierOperation;
  readonly freshness: FreshnessBoundary;
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
  readonly config: VerificationInput['config'] & {
    readonly profiles: Readonly<Record<TargetId, ProfileConfigEvidence & {
      readonly sourceConfigEvidencePath: string;
      readonly resolvedConfigPath: string;
      readonly manifestSymbolsVerified: true;
    }>>;
  };
  readonly rootfs: {
    readonly requiredFiles: readonly string[];
    readonly nginxRoutes: Readonly<Record<(typeof ROUTES)[number], boolean>>;
    readonly gui: {
      readonly title: string;
      readonly sourceGuiTreeSha256: string;
      readonly feedGuiTreeSha256: string;
      readonly rootfsGuiTreeSha256: string;
    };
    readonly criticalHashes: {
      readonly flows: {
        readonly sourceSha256: string;
        readonly rootfsSha256: string;
        readonly matched: true;
      };
      readonly database: {
        readonly sourceSha256: string;
        readonly rootfsSha256: string;
        readonly matched: true;
      };
      readonly gui: {
        readonly sourceGuiTreeSha256: string;
        readonly feedGuiTreeSha256: string;
        readonly rootfsGuiTreeSha256: string;
        readonly matched: true;
      };
    };
    readonly helpers: {
      readonly relativeSymlinks: readonly string[];
      readonly directUntilFirstBoot: readonly string[];
      readonly firstBootSeedVerified: true;
    };
    readonly nodeResolution: Readonly<Record<string, boolean>>;
    readonly database: { readonly integrityCheck: 'ok'; readonly chameleonCalibrationRows: number };
  };
  readonly freshness: VerificationFreshnessResult;
  readonly evidence: { readonly json: Record<string, unknown>; readonly bytes: number; readonly sha256: string };
}

export type TargetSetupVerificationInput = Pick<
  VerificationInput,
  'workspace' | 'target' | 'targets' | 'config'
>;

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
  readonly entries: () => Promise<readonly BoundDirectoryEntry[]>;
  readonly inspect: (basename: string) => Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'>;
  readonly readSymlink: (basename: string) => Promise<string>;
  readonly withFile: <T>(
    basename: string,
    callback: (file: HeldFile) => Promise<T>,
  ) => Promise<T>;
}

interface BoundDirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly device: bigint;
  readonly inode: bigint;
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
  readonly #dependencies: PathAuthorityDependencies;
  readonly #baseBindings: readonly DirectoryBinding[];
  readonly #jobBindings: readonly DirectoryBinding[];
  readonly #baseHandles: readonly FileHandle[];

  private constructor(
    dependencies: PathAuthorityDependencies,
    baseBindings: readonly DirectoryBinding[],
    jobBindings: readonly DirectoryBinding[],
    baseHandles: readonly FileHandle[],
  ) {
    this.#dependencies = dependencies;
    this.#baseBindings = baseBindings;
    this.#jobBindings = jobBindings;
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
      if (!rootPath.startsWith('/') || resolve(rootPath) !== rootPath) {
        fail('ROOTFS_CONTENT_FAILED', 'state-root authority path is not canonical and absolute');
      }
      let current = await open('/', DIR_FLAGS);
      handles.push(current);
      bindings.push(await bindDirectory(current, null, null));
      for (const basename of rootPath.split('/').filter((segment) => segment.length > 0)) {
        await WorkspaceReader.validateBindings(dependencies, bindings);
        const next = await open(procChild(current, basename), DIR_FLAGS);
        handles.push(next);
        bindings.push(await bindDirectory(next, current, basename));
        current = next;
      }
      const stateRootBinding = bindings.at(-1)!;
      if (stateRootBinding.device !== expectedDevice || stateRootBinding.inode !== expectedInode) {
        fail('ROOTFS_CONTENT_FAILED', 'state-root identity changed while opening');
      }
      let jobBindings: readonly DirectoryBinding[] | undefined;
      for (const basename of ['jobs', safeJobId, 'workspace', 'source']) {
        await WorkspaceReader.validateBindings(dependencies, bindings);
        const next = await open(procChild(current, basename), DIR_FLAGS);
        handles.push(next);
        bindings.push(await bindDirectory(next, current, basename));
        current = next;
        if (basename === safeJobId) jobBindings = Object.freeze([...bindings]);
      }
      await WorkspaceReader.validateBindings(dependencies, bindings);
      if (!jobBindings) fail('ROOTFS_CONTENT_FAILED', 'job workspace authority is incomplete');
      return new WorkspaceReader(
        dependencies,
        Object.freeze(bindings),
        jobBindings,
        Object.freeze(handles),
      );
    } catch (error) {
      for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
      if (error instanceof VerificationError) throw error;
      return fail('ROOTFS_CONTENT_FAILED', 'job workspace authority could not be opened', {}, error);
    }
  }

  static async validateBindings(
    dependencies: PathAuthorityDependencies,
    bindings: readonly DirectoryBinding[],
  ): Promise<void> {
    const leaf = bindings.at(-1);
    if (!leaf) fail('ROOTFS_CONTENT_FAILED', 'workspace authority has no bindings');
    await dependencies.beforeDirectoryAccess?.(leaf.handle);
    for (const binding of bindings) {
      const held = await binding.handle.stat();
      if (!held.isDirectory()
        || held.dev !== binding.device
        || held.ino !== binding.inode) {
        fail('ROOTFS_CONTENT_FAILED', 'workspace ancestor was replaced during verification', {
          component: binding.basename ?? '/',
        });
      }
      if (binding.parent !== null && binding.basename !== null) {
        const named = await lstat(procChild(binding.parent, binding.basename));
        if (named.isSymbolicLink()
          || !named.isDirectory()
          || named.dev !== binding.device
          || named.ino !== binding.inode) {
          fail('ROOTFS_CONTENT_FAILED', 'workspace ancestor was replaced during verification', {
            component: binding.basename,
          });
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const handle of [...this.#baseHandles].reverse()) {
      await handle.close().catch(() => undefined);
    }
  }

  async assertCurrent(): Promise<void> {
    await this.#validate();
  }

  async #validate(bindings: readonly DirectoryBinding[] = this.#baseBindings): Promise<void> {
    await WorkspaceReader.validateBindings(this.#dependencies, bindings);
  }

  async #withDirectoryBindings<T>(
    relativePath: string,
    callback: (binding: DirectoryBinding, bindings: readonly DirectoryBinding[]) => Promise<T>,
    baseBindings: readonly DirectoryBinding[] = this.#baseBindings,
  ): Promise<T> {
    const segments = relativePath.length === 0 ? [] : safeSegments(relativePath);
    const handles: FileHandle[] = [];
    const bindings = [...baseBindings];
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
      const enumerated = new Map<string, BoundDirectoryEntry>();
      const inspected = new Map<string, {
        readonly status: 'missing' | 'file' | 'directory' | 'symlink' | 'other';
        readonly device?: bigint;
        readonly inode?: bigint;
      }>();
      const inspectCurrent = async (basenameInput: string) => {
        const basename = safeBasename(basenameInput);
        await this.#validate(bindings);
        let info: BigIntStats;
        try {
          info = await lstat(procChild(binding.handle, basename), { bigint: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return Object.freeze({ status: 'missing' as const });
          }
          throw error;
        }
        await this.#validate(bindings);
        const status = info.isSymbolicLink()
          ? 'symlink'
          : info.isFile()
            ? 'file'
            : info.isDirectory()
              ? 'directory'
              : 'other';
        return Object.freeze({ status, device: info.dev, inode: info.ino });
      };
      const inspect = async (basenameInput: string): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'> => {
        const basename = safeBasename(basenameInput);
        const observation = await inspectCurrent(basename);
        inspected.set(basename, observation);
        return observation.status;
      };
      const directory: HeldDirectory = Object.freeze({
        entries: async () => {
          const entries = await this.#boundEntries(binding, bindings);
          enumerated.clear();
          for (const entry of entries) enumerated.set(entry.name, entry);
          return entries;
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
          inspected.set(basename, Object.freeze({
            status: 'symlink',
            device: after.dev,
            inode: after.ino,
          }));
          return target;
        },
        withFile: <T>(basenameInput: string, fileCallback: (file: HeldFile) => Promise<T>) => (
          this.#withFileFrom(
            bindings,
            safeBasename(basenameInput),
            fileCallback,
            enumerated.get(basenameInput),
          )
        ),
      });
      const result = await callback(directory);
      if (enumerated.size > 0) {
        const finalEntries = await this.#boundEntries(binding, bindings);
        if (finalEntries.length !== enumerated.size
          || finalEntries.some((entry) => {
            const expected = enumerated.get(entry.name);
            return expected === undefined
              || expected.kind !== entry.kind
              || expected.device !== entry.device
              || expected.inode !== entry.inode;
          })) {
          fail('ROOTFS_CONTENT_FAILED', 'directory entries changed after enumeration');
        }
      }
      for (const [basename, expected] of inspected) {
        const observed = await inspectCurrent(basename);
        if (observed.status !== expected.status
          || ('device' in observed ? observed.device : undefined) !== expected.device
          || ('inode' in observed ? observed.inode : undefined) !== expected.inode) {
          fail('ROOTFS_CONTENT_FAILED', 'observed directory child changed during verification', {
            path: basename,
          });
        }
      }
      return result;
    });
  }

  async #boundEntries(
    binding: DirectoryBinding,
    bindings: readonly DirectoryBinding[],
  ): Promise<readonly BoundDirectoryEntry[]> {
    await this.#validate(bindings);
    const entries = await readdir(join(PROC_FD, String(binding.handle.fd)), {
      withFileTypes: true,
    });
    const result: BoundDirectoryEntry[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const basename = safeBasename(entry.name);
      const info = await lstat(procChild(binding.handle, basename), { bigint: true });
      const kind = info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'directory'
          : info.isSymbolicLink()
            ? 'symlink'
            : 'other';
      const direntKind = entry.isFile()
        ? 'file'
        : entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'symlink'
            : 'other';
      if (kind !== direntKind) {
        fail('ROOTFS_CONTENT_FAILED', 'directory entry changed during enumeration', {
          path: basename,
        });
      }
      result.push(Object.freeze({
        name: basename,
        kind,
        device: info.dev,
        inode: info.ino,
      }));
    }
    await this.#validate(bindings);
    return Object.freeze(result);
  }

  async walkTree(
    relativePath: string,
    callback: (path: string, file: HeldFile) => Promise<void>,
  ): Promise<void> {
    return this.#withDirectoryBindings(relativePath, async (root, rootBindings) => {
      const visit = async (
        directory: DirectoryBinding,
        bindings: readonly DirectoryBinding[],
        prefix: string,
      ): Promise<void> => {
        const before = await this.#boundEntries(directory, bindings);
        for (const entry of before) {
          const childPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
          if (entry.kind === 'symlink') {
            fail('ROOTFS_CONTENT_FAILED', 'payload tree contains a symlink', {
              path: childPath,
            });
          }
          if (entry.kind === 'other') {
            fail('ROOTFS_CONTENT_FAILED', 'payload tree contains an unsupported filesystem entry', {
              path: childPath,
            });
          }
          if (entry.kind === 'file') {
            await this.#withFileFrom(
              bindings,
              entry.name,
              (file) => callback(childPath, file),
              entry,
            );
            continue;
          }
          await this.#withDirectoryBindings(entry.name, async (child, childBindings) => {
            if (BigInt(child.device) !== entry.device || BigInt(child.inode) !== entry.inode) {
              fail('ROOTFS_CONTENT_FAILED', 'directory entry was replaced after enumeration', {
                path: childPath,
              });
            }
            await visit(child, childBindings, childPath);
          }, bindings);
        }
        const after = await this.#boundEntries(directory, bindings);
        if (before.length !== after.length
          || before.some((entry, index) => {
            const observed = after[index];
            return observed === undefined
              || entry.name !== observed.name
              || entry.kind !== observed.kind
              || entry.device !== observed.device
              || entry.inode !== observed.inode;
          })) {
          fail('ROOTFS_CONTENT_FAILED', 'payload tree changed during verification', {
            path: prefix,
          });
        }
      };
      await visit(root, rootBindings, '');
    });
  }

  async withFile<T>(
    relativePath: string,
    callback: (file: HeldFile) => Promise<T>,
  ): Promise<T> {
    return this.#withFileFrom(this.#baseBindings, relativePath, callback);
  }

  async withJobFile<T>(
    relativePath: string,
    callback: (file: HeldFile) => Promise<T>,
  ): Promise<T> {
    return this.#withFileFrom(this.#jobBindings, relativePath, callback);
  }

  async #withFileFrom<T>(
    baseBindings: readonly DirectoryBinding[],
    relativePath: string,
    callback: (file: HeldFile) => Promise<T>,
    expected?: Pick<BoundDirectoryEntry, 'device' | 'inode'>,
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
        if (expected !== undefined
          && (initial.dev !== expected.device || initial.ino !== expected.inode)) {
          fail('ROOTFS_CONTENT_FAILED', 'file entry was replaced after enumeration', {
            path: relativePath,
          });
        }

        const compareNamedToHeld = async (): Promise<BigIntStats> => {
          let named: BigIntStats;
          try {
            named = await lstat(procChild(parent.handle, basename), { bigint: true });
          } catch (error) {
            return fail('ROOTFS_CONTENT_FAILED', 'verification pathname no longer names its held file', {
              path: relativePath,
            }, error);
          }
          const current = await this.#dependencies.statBigInt(handle!);
          if (named.isSymbolicLink()
            || !named.isFile()
            || !current.isFile()
            || named.dev !== current.dev
            || named.ino !== current.ino
            || !sameFile(initial, current)) {
            fail('ROOTFS_CONTENT_FAILED', 'verification pathname or held file changed', {
              path: relativePath,
            });
          }
          return current;
        };
        const stable = async (): Promise<BigIntStats> => {
          await this.#validate(bindings);
          await compareNamedToHeld();
          await this.#validate(bindings);
          return compareNamedToHeld();
        };
        const held: HeldFile = Object.freeze({
          procPath: join(PROC_FD, String(handle.fd)),
          stat: async () => {
            await stable();
            const result = await this.#dependencies.stat(handle!);
            await stable();
            return result;
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
          },
        });
        const result = await callback(held);
        await stable();
        return result;
      } catch (error) {
        if (error instanceof VerificationError) throw error;
        return fail('ROOTFS_CONTENT_FAILED', 'workspace file traversal failed closed', {
          path: relativePath,
        }, error);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }, baseBindings);
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
      const result = await callback(workspace);
      await workspace.assertCurrent();
      return result;
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

function validateTargets(input: Pick<VerificationInput, 'target' | 'targets'>): Readonly<Record<TargetId, TargetManifest>> {
  let authenticated: Readonly<Record<TargetId, TargetManifest>>;
  try {
    authenticated = authenticateTargetManifests(input.targets);
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      return fail('TARGET_CONFIG_MISMATCH', 'verification target manifests are not authentic', {
        manifestError: error.code,
      }, error);
    }
    throw error;
  }
  const selected = authenticated[input.target.id];
  try {
    authenticateTargetManifests(
      input.target.id === 'rpi-5'
        ? [input.target, authenticated['rpi-2']]
        : [authenticated['rpi-5'], input.target],
    );
  } catch (error) {
    return fail('TARGET_CONFIG_MISMATCH', 'selected target manifest is not authentic', {}, error);
  }
  if (selected.id !== input.target.id) {
    fail('TARGET_CONFIG_MISMATCH', 'selected target is not in the authenticated manifest');
  }
  return authenticated;
}

async function verifyConfig(
  workspace: WorkspaceReader,
  input: TargetSetupVerificationInput,
  targets: Readonly<Record<TargetId, TargetManifest>>,
): Promise<VerificationResult['config']> {
  if (input.config.bothProfilesChecked !== true
    || input.config.selectedTarget !== input.target.openwrtTarget
    || input.config.profile !== input.target.profile
    || input.config.rootfsPartSize !== input.target.rootfsPartSize) {
    fail('TARGET_CONFIG_MISMATCH', 'selected target configuration does not match the manifest');
  }
  const keys = Object.keys(input.config.profiles).sort();
  if (keys.join(',') !== 'rpi-2,rpi-5') fail('TARGET_CONFIG_MISMATCH', 'both Task 15 profile hash records are required');
  const readStageEvidence = (
    relativePath: string,
    stage: 'target-setup' | 'config',
  ): Promise<Record<string, unknown>> => workspace.withJobFile(
    relativePath,
    async (file) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse((await file.read(MAX_CONFIG_BYTES)).toString('utf8'));
      } catch (error) {
        return fail('TARGET_CONFIG_MISMATCH', `Task 15 ${stage} evidence is missing or malformed`, {}, error);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('TARGET_CONFIG_MISMATCH', `Task 15 ${stage} evidence is not an object`);
      }
      const evidence = parsed as Record<string, unknown>;
      if (evidence.schemaVersion !== 1
        || evidence.jobId !== input.workspace.jobId
        || evidence.stage !== stage
        || evidence.outcome !== 'passed'
        || evidence.error !== null) {
        fail('TARGET_CONFIG_MISMATCH', `Task 15 ${stage} evidence envelope is not authentic`);
      }
      return evidence;
    },
  );
  const targetSetupEvidence = await readStageEvidence(
    'evidence/04-target-setup.json',
    'target-setup',
  );
  const configEvidence = await readStageEvidence(
    'evidence/06-config.json',
    'config',
  );
  const targetSetupObservations = targetSetupEvidence.observations;
  const sourceProfiles = targetSetupObservations
    && typeof targetSetupObservations === 'object'
    && !Array.isArray(targetSetupObservations)
    ? (targetSetupObservations as Record<string, unknown>).profiles
    : undefined;
  const configObservations = configEvidence.observations;
  const persistedConfig = configObservations
    && typeof configObservations === 'object'
    && !Array.isArray(configObservations)
    ? (configObservations as Record<string, unknown>).config
    : undefined;
  const resolvedProfiles = persistedConfig
    && typeof persistedConfig === 'object'
    && !Array.isArray(persistedConfig)
    ? (persistedConfig as Record<string, unknown>).profiles
    : undefined;
  if (!sourceProfiles
    || typeof sourceProfiles !== 'object'
    || Array.isArray(sourceProfiles)
    || !persistedConfig
    || typeof persistedConfig !== 'object'
    || Array.isArray(persistedConfig)
    || !resolvedProfiles
    || typeof resolvedProfiles !== 'object'
    || Array.isArray(resolvedProfiles)) {
    fail('TARGET_CONFIG_MISMATCH', 'Task 15 stage evidence has no authentic profile records');
  }
  if ((persistedConfig as Record<string, unknown>).bothProfilesChecked !== true
    || (persistedConfig as Record<string, unknown>).selectedTarget !== input.config.selectedTarget
    || (persistedConfig as Record<string, unknown>).profile !== input.config.profile
    || (persistedConfig as Record<string, unknown>).rootfsPartSize !== input.config.rootfsPartSize) {
    fail('TARGET_CONFIG_MISMATCH', 'Task 15 config evidence does not match the selected target');
  }
  const requireCanonicalProfiles = (
    profiles: Record<string, unknown>,
    stage: 'target-setup' | 'config',
  ): void => {
    if (Object.keys(profiles).sort().join(',') !== 'rpi-2,rpi-5') {
      fail('TARGET_CONFIG_MISMATCH', `Task 15 ${stage} evidence does not contain both canonical profiles`);
    }
    const seen = new Set<TargetId>();
    for (const targetId of ['rpi-5', 'rpi-2'] as const) {
      const profile = profiles[targetId];
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        fail('TARGET_CONFIG_MISMATCH', `Task 15 ${stage} profile record is invalid`, {
          target: targetId,
        });
      }
      const recordedTarget = (profile as Record<string, unknown>).target;
      if ((recordedTarget !== 'rpi-5' && recordedTarget !== 'rpi-2')
        || recordedTarget !== targetId
        || seen.has(recordedTarget)) {
        fail('TARGET_CONFIG_MISMATCH', `Task 15 ${stage} profile target is missing, duplicated, or mismatched`, {
          target: targetId,
        });
      }
      seen.add(recordedTarget);
    }
  };
  requireCanonicalProfiles(sourceProfiles as Record<string, unknown>, 'target-setup');
  requireCanonicalProfiles(resolvedProfiles as Record<string, unknown>, 'config');
  const verifiedProfiles = {} as Record<TargetId, VerificationResult['config']['profiles'][TargetId]>;
  for (const targetId of ['rpi-5', 'rpi-2'] as const) {
    const target = targets[targetId];
    const profile = input.config.profiles[targetId];
    const sourceConfigEvidencePath = `evidence/target-setup/${targetId}.source.config`;
    if (!profile
      || profile.target !== targetId
      || profile.environment !== target.environment
      || profile.selectedTarget !== target.openwrtTarget
      || profile.profile !== target.profile
      || profile.rootfsPartSize !== target.rootfsPartSize
      || profile.sourceConfigEvidencePath !== sourceConfigEvidencePath
      || !SHA256.test(profile.sourceSha256)
      || !SHA256.test(profile.resolvedSha256)) {
      fail('TARGET_CONFIG_MISMATCH', 'Task 15 profile configuration evidence is incomplete or contradictory', { target: targetId });
    }
    const sourceProfile = (sourceProfiles as Record<string, unknown>)[targetId] as Record<string, unknown>;
    const resolvedProfile = (resolvedProfiles as Record<string, unknown>)[targetId] as Record<string, unknown>;
    const identityFields = [
      'target',
      'environment',
      'selectedTarget',
      'profile',
      'rootfsPartSize',
    ] as const;
    if (identityFields.some((field) => (
      sourceProfile[field] !== profile[field]
      || resolvedProfile[field] !== profile[field]
    ))
      || sourceProfile.sourceSha256 !== profile.sourceSha256
      || sourceProfile.sourceConfigEvidencePath !== profile.sourceConfigEvidencePath
      || resolvedProfile.resolvedSha256 !== profile.resolvedSha256) {
      fail('TARGET_CONFIG_MISMATCH', 'Task 15 source and config evidence differ from verification input', {
        target: targetId,
      });
    }
    const resolvedConfigPath = `conf/${target.environment}/.config`;
    const sourceHash = await workspace.withJobFile(
      sourceConfigEvidencePath,
      async (file) => {
        const bytes = await file.read(MAX_CONFIG_BYTES);
        verifyManifestConfigSymbols(bytes.toString('utf8'), target, 'source');
        return hashBytes(bytes);
      },
    );
    const resolvedHash = await workspace.withFile(
      resolvedConfigPath,
      async (file) => {
        const bytes = await file.read(MAX_CONFIG_BYTES);
        verifyManifestConfigSymbols(bytes.toString('utf8'), target, 'resolved');
        return hashBytes(bytes);
      },
    );
    if (sourceHash !== sourceProfile.sourceSha256) {
      fail('TARGET_CONFIG_MISMATCH', 'Task 15 source configuration hash does not match its immutable bytes', { target: targetId });
    }
    if (resolvedHash !== resolvedProfile.resolvedSha256) {
      fail('TARGET_CONFIG_MISMATCH', 'Task 15 resolved configuration hash no longer matches the workspace', { target: targetId });
    }
    verifiedProfiles[targetId] = Object.freeze({
      ...profile,
      sourceConfigEvidencePath,
      resolvedConfigPath,
      manifestSymbolsVerified: true as const,
    });
  }
  return Object.freeze({
    ...input.config,
    profiles: Object.freeze(verifiedProfiles),
  });
}

export async function verifyTargetSetupConfiguration(
  input: TargetSetupVerificationInput,
): Promise<VerificationResult['config']> {
  const targets = validateTargets(input);
  return withWorkspace(input.workspace, (workspace) => verifyConfig(workspace, input, targets));
}

function verifyManifestConfigSymbols(
  contents: string,
  target: TargetManifest,
  kind: 'source' | 'resolved',
): void {
  const lines = contents.split(/\r?\n/u);
  for (const symbol of target.configSymbols) {
    const matches = lines.filter((line) => (
      line.startsWith(`${symbol.name}=`)
      || line === `# ${symbol.name} is not set`
    ));
    if (matches.length !== 1) {
      fail('TARGET_CONFIG_MISMATCH', `${kind} config does not contain exactly one manifest symbol`, {
        target: target.id,
        symbol: symbol.name,
      });
    }
    const line = matches[0]!;
    const expected = symbol.type === 'bool'
      ? `${symbol.name}=${symbol.value ? 'y' : 'n'}`
      : symbol.type === 'string'
        ? `${symbol.name}="${symbol.value}"`
        : `${symbol.name}=${symbol.value}`;
    if (line !== expected) {
      fail('TARGET_CONFIG_MISMATCH', `${kind} config symbol differs from the authenticated manifest`, {
        target: target.id,
        symbol: symbol.name,
      });
    }
  }
}

async function verifyPersistedSourceEvidence(
  workspace: WorkspaceReader,
  input: VerificationInput,
  exactTargetOutput: string,
): Promise<void> {
  await workspace.withJobFile('evidence/01-source.json', async (file) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await file.read(MAX_TEXT_BYTES)).toString('utf8'));
    } catch (error) {
      return fail('BUILD_OUTPUT_COLLISION', 'source-stage evidence is missing or malformed', {}, error);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('BUILD_OUTPUT_COLLISION', 'source-stage evidence is not an object');
    }
    const evidence = parsed as Record<string, unknown>;
    const observations = evidence.observations;
    if (evidence.schemaVersion !== 1
      || evidence.jobId !== input.workspace.jobId
      || evidence.stage !== 'source'
      || evidence.outcome !== 'passed'
      || !observations
      || typeof observations !== 'object'
      || Array.isArray(observations)
      || (observations as Record<string, unknown>).targetOutputAbsent !== true
      || (observations as Record<string, unknown>).checkedTargetOutputPath !== exactTargetOutput) {
      fail('BUILD_OUTPUT_COLLISION', 'source-stage evidence does not prove exact target-output absence');
    }
  });
}

async function hashTree(workspace: WorkspaceReader, root: string): Promise<string> {
  const hash = createHash('sha256');
  await workspace.walkTree(root, async (path, file) => {
    hash.update(path);
    hash.update('\0');
    hash.update(await file.hashSha256());
  });
  return hash.digest('hex');
}

function titleOf(contents: string): string {
  const match = contents.match(/<title>\s*([^<]+?)\s*<\/title>/iu);
  if (!match) fail('ROOTFS_CONTENT_FAILED', 'GUI index.html has no title');
  return match[1]!;
}

async function parseTextFile<T>(
  workspace: WorkspaceReader,
  relativePath: string,
  parser: (contents: string) => T,
): Promise<T> {
  return workspace.withFile(relativePath, async (file) => (
    parser((await file.read(MAX_TEXT_BYTES)).toString('utf8'))
  ));
}

async function verifyOriginalChecksums(
  directory: HeldDirectory,
  targetDirectory: string,
  artifactName: string,
): Promise<VerificationResult['checks']['originalOpenWrtSha256sums']> {
  const checksumPath = `${targetDirectory}/sha256sums`;
  const parsedEntries = await directory.withFile(
    'sha256sums',
    async (file) => {
      const lines = (await file.read(MAX_TEXT_BYTES))
        .toString('utf8')
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      if (lines.length === 0) fail('CHECKSUM_FAILED', 'OpenWrt sha256sums is empty');
      return lines.map((line) => {
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
        return Object.freeze({ sha256: match[1]!, filename });
      });
    },
  );
  const entries: string[] = [];
  for (const entry of parsedEntries) {
    const observed = await directory.withFile(
      entry.filename,
      (file) => file.hashSha256(),
    );
    if (observed !== entry.sha256) fail('CHECKSUM_FAILED', 'OpenWrt checksum validation failed', { filename: entry.filename });
    entries.push(entry.filename);
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
  try {
    return await workspace.withDirectory(targetDirectory, async (directory) => {
      const entries = await directory.entries();
      const factoryEntries = entries.filter((entry) => entry.name.endsWith('-factory.img.gz'));
      if (factoryEntries.length === 0) fail('ARTIFACT_MISSING', 'target output contains no factory image');
      if (factoryEntries.length !== 1) {
        fail('BUILD_OUTPUT_COLLISION', 'target output must contain exactly one factory image overall', { count: factoryEntries.length });
      }
      const entry = factoryEntries[0]!;
      if (entry.kind !== 'file' || !globPattern(input.target.artifactGlob).test(entry.name)) {
        fail('BUILD_OUTPUT_COLLISION', 'factory image does not match the selected target manifest');
      }
      const artifactPath = `${targetDirectory}/${entry.name}`;
      const artifactData = await directory.withFile(entry.name, async (file) => {
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
        directory,
        targetDirectory,
        entry.name,
      );
      const finalHash = await directory.withFile(entry.name, (file) => file.hashSha256());
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
    });
  } catch (error) {
    if (error instanceof VerificationError
      && error.code === 'ROOTFS_CONTENT_FAILED'
      && error.details.path === targetDirectory) {
      throw new VerificationError('ARTIFACT_MISSING', 'target output directory is missing or unsafe', {}, { cause: error });
    }
    throw error;
  }
}

async function verifyPackageIdentity(
  workspace: WorkspaceReader,
  packageRoot: string,
  expectedName: string,
): Promise<void> {
  await parseTextFile(workspace, `${packageRoot}/package.json`, (packageJson) => {
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
  });
}

async function verifyHelperLayout(
  workspace: WorkspaceReader,
  rootfs: string,
): Promise<VerificationResult['rootfs']['helpers']> {
  const nodeRed = `${rootfs}/usr/share/node-red`;
  const nodeModules = `${nodeRed}/node_modules`;
  for (const helper of ALL_HELPERS) {
    await verifyPackageIdentity(workspace, `${nodeRed}/${helper}`, helper);
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
  await parseTextFile(
    workspace,
    `${rootfs}/etc/uci-defaults/98_osi_node_red_seed`,
    verifyFirstBootSeed,
  );
  return Object.freeze({
    relativeSymlinks: RELATIVE_HELPERS,
    directUntilFirstBoot: DIRECT_HELPERS,
    firstBootSeedVerified: true as const,
  });
}

function verifyFirstBootSeed(contents: string): void {
  const firstLine = contents.split(/\r?\n/u, 1)[0];
  if (firstLine !== '#!/bin/sh') {
    fail('ROOTFS_CONTENT_FAILED', 'first-boot seed interpreter is not exact');
  }
  const activeSeed = activeShellLines(contents);
  const mismatchIndex = FIRST_BOOT_SEED_COMMANDS.findIndex(
    (command, index) => activeSeed[index] !== command,
  );
  if (mismatchIndex !== -1 || activeSeed.length !== FIRST_BOOT_SEED_COMMANDS.length) {
    const commandIndex = mismatchIndex === -1
      ? Math.min(activeSeed.length, FIRST_BOOT_SEED_COMMANDS.length)
      : mismatchIndex;
    fail('ROOTFS_CONTENT_FAILED', 'first-boot seed command contract does not match', {
      commandIndex,
      expected: FIRST_BOOT_SEED_COMMANDS[commandIndex] ?? null,
      observed: activeSeed[commandIndex] ?? null,
    });
  }
}

function activeShellLines(contents: string): readonly string[] {
  const lines: string[] = [];
  for (const rawLine of contents.split(/\r?\n/u)) {
    let singleQuoted = false;
    let doubleQuoted = false;
    let escaped = false;
    let active = '';
    for (const character of rawLine) {
      if (escaped) {
        active += character;
        escaped = false;
        continue;
      }
      if (character === '\\' && !singleQuoted) {
        active += character;
        escaped = true;
        continue;
      }
      if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
      if (character === '"' && !singleQuoted) doubleQuoted = !doubleQuoted;
      if (character === '#' && !singleQuoted && !doubleQuoted) break;
      active += character;
    }
    if (singleQuoted || doubleQuoted || escaped) {
      fail('ROOTFS_CONTENT_FAILED', 'first-boot seed contains an unsupported multiline shell token');
    }
    const line = active.trim();
    if (line.length > 0) lines.push(line);
  }
  return Object.freeze(lines);
}

function nodeResolutionRequest(targetId: TargetId): RootfsNodeResolutionRequest {
  return Object.freeze({
    targetId,
    modules: Object.freeze([
      ...THIRD_PARTY_PACKAGES.map((packageName) => Object.freeze({
        packageName,
        specifier: packageName,
      })),
      ...RELATIVE_HELPERS.map((packageName) => Object.freeze({
        packageName,
        specifier: packageName,
      })),
      ...DIRECT_HELPERS.map((packageName) => Object.freeze({
        packageName,
        specifier: `./${packageName}`,
      })),
    ]),
  });
}

async function verifyNodeResolution(
  input: VerificationInput,
): Promise<Readonly<Record<string, boolean>>> {
  const request = nodeResolutionRequest(input.target.id);
  let result: RootfsNodeResolutionResult;
  try {
    result = await input.nodeVerifier.resolve(request);
  } catch (error) {
    return fail('ROOTFS_CONTENT_FAILED', 'trusted Node resolution operation failed', {}, error);
  }
  if (!result
    || result.targetId !== input.target.id
    || !Array.isArray(result.modules)
    || result.modules.length !== request.modules.length) {
    fail('ROOTFS_CONTENT_FAILED', 'trusted Node resolution operation returned an incomplete result');
  }
  const expected = new Map(request.modules.map((module) => [module.packageName, module]));
  const observations: Record<string, boolean> = {};
  for (const module of result.modules) {
    const contract = expected.get(module.packageName);
    let resolved: string;
    try {
      resolved = stableRelativePath(
        module.resolvedRelativePath,
        'resolved Node module path',
      );
    } catch (error) {
      return fail('ROOTFS_CONTENT_FAILED', 'trusted Node resolution escaped the rootfs Node-RED base', {
        package: module.packageName,
      }, error);
    }
    const expectedRoot = `${module.packageName}/`;
    const directRoot = `node_modules/${module.packageName}/`;
    if (!contract
      || observations[module.packageName] !== undefined
      || module.exportType === 'incompatible'
      || (module.exportType !== 'function' && module.exportType !== 'object')
      || (!resolved.startsWith(expectedRoot) && !resolved.startsWith(directRoot))) {
      fail('ROOTFS_CONTENT_FAILED', 'trusted Node resolution result is contradictory or incompatible', {
        package: module.packageName,
      });
    }
    observations[module.packageName] = true;
  }
  if ([...expected.keys()].some((packageName) => observations[packageName] !== true)) {
    fail('ROOTFS_CONTENT_FAILED', 'trusted Node resolution omitted a required package');
  }
  return Object.freeze(observations);
}

async function verifyNginxRoutes(
  workspace: WorkspaceReader,
  rootfs: string,
): Promise<Readonly<Record<(typeof ROUTES)[number], boolean>>> {
  const activeLines = await parseTextFile(
    workspace,
    `${rootfs}/etc/nginx/conf.d/node-red.locations`,
    (contents) => contents
      .split(/\r?\n/u)
      .map((line) => line.replace(/#.*$/u, '').trim())
      .filter((line) => line.length > 0),
  );
  const observations = Object.fromEntries(ROUTES.map((route) => {
    const declaration = `location ${route} {`;
    const present = activeLines.filter((line) => line === declaration).length === 1;
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
  for (const packageName of THIRD_PARTY_PACKAGES) {
    await verifyPackageIdentity(
      workspace,
      `${rootfs}/usr/share/node-red/node_modules/${packageName}`,
      packageName,
    );
  }
  const nodeResolution = await verifyNodeResolution(input);

  const sourceGui = 'web/react-gui/build';
  const feedGui = 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui';
  const rootfsGui = `${rootfs}/usr/lib/node-red/gui`;
  const sourceTitle = await parseTextFile(workspace, `${sourceGui}/index.html`, titleOf);
  const feedTitle = await parseTextFile(workspace, `${feedGui}/index.html`, titleOf);
  const rootfsTitle = await parseTextFile(workspace, `${rootfsGui}/index.html`, titleOf);
  if (sourceTitle !== feedTitle || feedTitle !== rootfsTitle) {
    fail('ROOTFS_CONTENT_FAILED', 'source, feed, and rootfs GUI titles differ');
  }
  const sourceGuiSha256 = await hashTree(workspace, sourceGui);
  const feedGuiSha256 = await hashTree(workspace, feedGui);
  const rootfsGuiSha256 = await hashTree(workspace, rootfsGui);
  if (sourceGuiSha256 !== feedGuiSha256 || feedGuiSha256 !== rootfsGuiSha256) {
    fail('ROOTFS_CONTENT_FAILED', 'source, feed, and rootfs GUI payloads differ');
  }

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
      sourceGuiTreeSha256: sourceGuiSha256,
      feedGuiTreeSha256: feedGuiSha256,
      rootfsGuiTreeSha256: rootfsGuiSha256,
    }),
    criticalHashes: Object.freeze({
      flows: Object.freeze({ sourceSha256: sourceFlowsSha256, rootfsSha256: rootfsFlowsSha256, matched: true as const }),
      database: Object.freeze({ sourceSha256: sourceDatabaseSha256, rootfsSha256: rootfsDatabaseSha256, matched: true as const }),
      gui: Object.freeze({
        sourceGuiTreeSha256: sourceGuiSha256,
        feedGuiTreeSha256: feedGuiSha256,
        rootfsGuiTreeSha256: rootfsGuiSha256,
        matched: true as const,
      }),
    }),
    helpers,
    nodeResolution: Object.freeze(nodeResolution),
    database: Object.freeze(databaseResult),
  });
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

  return withWorkspace(input.workspace, async (workspace) => {
    await verifyPersistedSourceEvidence(workspace, input, exactTargetOutput);
    const config = await verifyConfig(workspace, input, targets);
    const artifact = await verifyArtifact(workspace, input);
    const rootfs = await verifyRootfs(workspace, input);
    const freshness = await requestPersistedFreshness({
      boundary: input.freshness,
      jobId: input.workspace.jobId,
      pinnedSha: input.pinnedSha,
    });
    let evidenceValue: ReturnType<typeof normalizeJson>;
    let encoded: string;
    try {
      evidenceValue = normalizeJson({
        schemaVersion: 1,
        artifact: artifact.artifact,
        checks: {
          originalOpenWrtSha256sums: {
            path: artifact.checks.originalOpenWrtSha256sums.path,
            verified: true,
            entries: artifact.checks.originalOpenWrtSha256sums.entries,
          },
          generatedSha256sums: {
            contents: artifact.checks.generatedSha256sums.contents,
            sha256: artifact.checks.generatedSha256sums.sha256,
            verified: true,
            filenames: artifact.checks.generatedSha256sums.filenames,
          },
        },
        config,
        rootfs,
        freshness,
        observations: {
          targetOutputAbsent: true,
          checkedTargetOutputPath: exactTargetOutput,
          artifact: artifact.artifact,
          checks: artifact.checks,
          config,
          rootfs,
          freshnessStatus: freshness.status,
          newerSourceAvailable: freshness.newerSourceAvailable,
          pinnedSha: freshness.pinnedSha,
          observedSha: freshness.observedSha,
          freshnessCheckedAt: freshness.checkedAt,
          freshnessError: freshness.status === 'unknown' ? freshness.error : null,
        },
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
      artifact: artifact.artifact,
      checks: artifact.checks,
      config,
      rootfs,
      freshness,
      evidence: Object.freeze({
        json: evidenceValue as Record<string, unknown>,
        bytes,
        sha256: hashBytes(Buffer.from(`${encoded}\n`, 'utf8')),
      }),
    });
  });
}

export const verifyFirmwareArtifacts = verifyFirmwareArtifact;
