import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { encodeJson, normalizeJson, canonicalInstant } from '../../api/src/validation.js';
import { REQUIRED_RUNTIME_FILES, type TargetManifest } from '../../manifest/schema.js';
import type { FreshnessResult } from '../../domain/types.js';

const SHA40 = /^[0-9a-f]{40}$/u;
const ROUTES = ['/gui/', '/auth/', '/api/', '/download/'] as const;
const REQUIRED_HELPERS = REQUIRED_RUNTIME_FILES
  .filter((path) => path.startsWith('/usr/share/node-red/node_modules/') && path.endsWith('/package.json'))
  .map((path) => path.slice('/usr/share/node-red/node_modules/'.length, -'/package.json'.length));

export type VerificationErrorCode =
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_STALE'
  | 'ARTIFACT_TOO_SMALL'
  | 'BUILD_OUTPUT_COLLISION'
  | 'CHECKSUM_FAILED'
  | 'GZIP_FAILED'
  | 'TARGET_CONFIG_MISMATCH'
  | 'ROOTFS_CONTENT_FAILED'
  | 'FRESHNESS_UNKNOWN'
  | 'VERIFICATION_EVIDENCE_INVALID';

export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(code: VerificationErrorCode, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VerificationError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface VerificationPathPair {
  readonly sourcePath: string;
  readonly rootfsPath: string;
}

export interface VerificationInput {
  readonly target: TargetManifest;
  readonly artifactDirectory: string;
  readonly rootfsPath: string;
  readonly buildStartedAt: string;
  readonly sourceEvidence: {
    readonly targetOutputAbsent: boolean;
    readonly checkedTargetOutputPath: string;
  };
  readonly config: {
    readonly selectedTarget: string;
    readonly profile: string;
    readonly rootfsPartSize: number;
    readonly bothProfilesChecked: boolean;
    readonly sourceConfigSha256?: string;
    readonly resolvedConfigSha256?: string;
  };
  readonly sourcePayloads?: {
    readonly flows: VerificationPathPair;
    readonly database: VerificationPathPair;
    readonly gui: VerificationPathPair;
  };
  readonly feedGuiPath?: string;
  readonly pinnedSha: string;
  readonly branch: string;
  readonly freshnessResolver?: (branch: string, pinnedSha: string) => Promise<FreshnessResult>;
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
    readonly criticalHashes: Readonly<Record<'flows' | 'database' | 'gui', { readonly sourceSha256: string; readonly rootfsSha256: string; readonly matched: true }>>;
    readonly nodeResolution: Readonly<Record<string, boolean>>;
    readonly database: { readonly integrityCheck: 'ok'; readonly chameleonCalibrationRows: number };
  };
  readonly freshness: FreshnessResult;
  readonly evidence: { readonly json: Record<string, unknown>; readonly bytes: number; readonly sha256: string };
}

type RootfsObservation = VerificationResult['rootfs'];

function fail(code: VerificationErrorCode, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): never {
  throw new VerificationError(code, message, details);
}

function hashBytes(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function readNoFollow(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink < 1) fail('ROOTFS_CONTENT_FAILED', 'verification input is not a regular file', { path });
    return await handle.readFile();
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    return fail('ROOTFS_CONTENT_FAILED', 'verification file cannot be read without following a symlink', { path });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertRegular(path: string, code: VerificationErrorCode, message: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) fail(code, message, { path });
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(code, message, { path });
    throw error;
  }
}

async function assertDirectoryPath(path: string, code: VerificationErrorCode, message: string): Promise<void> {
  const absolute = resolve(path);
  let current = absolute.startsWith('/') ? '/' : '';
  for (const component of absolute.split('/').filter((part) => part.length > 0)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail(code, message, { path: current });
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      fail(code, message, { path: current });
    }
  }
}

async function assertNoFollowAncestors(root: string, relativePath: string, code: VerificationErrorCode, message: string): Promise<void> {
  await assertDirectoryPath(root, code, message);
  let current = resolve(root);
  const components = relativePath.split('/');
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) fail(code, message, { path: current });
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      fail(code, message, { path: current });
    }
  }
}

function globPattern(pattern: string): RegExp {
  let expression = '^';
  for (const character of pattern) {
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else expression += /[\\^$+?.()|{}\[\]]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, 'u');
}

async function resolveArtifact(input: VerificationInput): Promise<{ path: string; basename: string; size: number; mtime: string; sha256: string }> {
  const output = resolve(input.artifactDirectory);
  await assertDirectoryPath(output, 'BUILD_OUTPUT_COLLISION', 'the target output path contains an unsafe ancestor');
  let names: string[];
  try { names = await readdir(output); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('ARTIFACT_MISSING', 'the target output directory is missing', { path: output }); throw error; }
  const matching: string[] = [];
  const pattern = globPattern(input.target.artifactGlob);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(output, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) fail('BUILD_OUTPUT_COLLISION', 'the target output contains a non-regular factory image', { path });
    matching.push(name);
  }
  if (matching.length === 0) fail('ARTIFACT_MISSING', 'the target output contains no factory image', { pattern: input.target.artifactGlob });
  if (matching.length !== 1) fail('BUILD_OUTPUT_COLLISION', 'the target output must contain exactly one factory image', { count: matching.length });
  const basename = matching[0]!;
  const path = join(output, basename);
  let info;
  let contents: Buffer;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    info = await handle.stat();
    if (!info.isFile() || info.nlink < 1) fail('BUILD_OUTPUT_COLLISION', 'the factory image is not a regular file', { path });
    contents = await handle.readFile();
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail('BUILD_OUTPUT_COLLISION', 'the factory image could not be opened without following a symlink', { path });
  } finally { await handle?.close().catch(() => undefined); }
  const started = Date.parse(canonicalInstant(input.buildStartedAt, 'buildStartedAt'));
  if (info.mtimeMs <= started) fail('ARTIFACT_STALE', 'the factory image predates the build start', { mtimeMs: info.mtimeMs, buildStartedAt: started });
  if (info.size < input.target.minimumArtifactBytes) fail('ARTIFACT_TOO_SMALL', 'the factory image is below the manifest floor', { size: info.size, minimum: input.target.minimumArtifactBytes });
  return { path, basename, size: info.size, mtime: new Date(info.mtimeMs).toISOString(), sha256: hashBytes(contents) };
}

async function verifyOriginalChecksum(directory: string, artifact: string): Promise<VerificationResult['checks']['originalOpenWrtSha256sums']> {
  const path = join(directory, 'sha256sums');
  await assertRegular(path, 'CHECKSUM_FAILED', 'the original OpenWrt sha256sums file is missing');
  const lines = (await readNoFollow(path)).toString('utf8').split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) fail('CHECKSUM_FAILED', 'the original OpenWrt sha256sums file is empty');
  const entries: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})\s+[* ](.+)$/u);
    const filename = match?.[2];
    if (!match || !filename || filename.startsWith('/') || filename.includes('\\') || filename.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) fail('CHECKSUM_FAILED', 'the original OpenWrt checksum contains an unsafe filename', { line });
    const checksumPath = join(directory, filename);
    const observed = hashBytes(await readNoFollow(checksumPath));
    if (observed !== match[1]) fail('CHECKSUM_FAILED', 'the original OpenWrt checksum does not match its file', { filename });
    entries.push(filename);
  }
  if (!entries.includes(artifact)) fail('CHECKSUM_FAILED', 'the original OpenWrt checksum does not include the factory image', { artifact });
  return Object.freeze({ path: 'sha256sums', verified: true as const, entries: Object.freeze(entries) });
}

async function verifyGzip(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    await pipeline(handle.createReadStream({ autoClose: false }), createGunzip(), async (source) => { for await (const _chunk of source) { /* drain without materializing the image */ } });
  }
  catch (error) { fail('GZIP_FAILED', 'the factory image is not valid gzip', { path }); }
  finally { await handle?.close().catch(() => undefined); }
}

async function verifyGeneratedChecksum(artifact: VerificationResult['artifact']): Promise<VerificationResult['checks']['generatedSha256sums']> {
  const contents = `${artifact.sha256}  ${artifact.basename}\n`;
  const encoded = Buffer.from(contents, 'utf8');
  const parsed = /^([0-9a-f]{64})  ([^\n]+)\n$/u.exec(contents);
  if (!parsed || parsed[1] !== artifact.sha256 || parsed[2] !== artifact.basename) fail('CHECKSUM_FAILED', 'generated image-only checksum is malformed');
  return Object.freeze({ contents, sha256: hashBytes(encoded), verified: true as const, filenames: [artifact.basename] as const });
}

async function hashTree(root: string): Promise<string> {
  await assertDirectoryPath(root, 'ROOTFS_CONTENT_FAILED', 'payload root contains a symlinked ancestor');
  const digest = createHash('sha256');
  async function visit(current: string, prefix: string): Promise<void> {
    let entries = await readdir(current, { withFileTypes: true });
    entries = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(current, entry.name);
      const childRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('ROOTFS_CONTENT_FAILED', 'GUI payload contains a symlink', { path: child });
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) { digest.update(childRelative); digest.update('\0'); digest.update(await readNoFollow(child)); }
      else fail('ROOTFS_CONTENT_FAILED', 'GUI payload contains an unsupported filesystem entry', { path: child });
    }
  }
  await visit(root, '');
  return digest.digest('hex');
}

function titleOf(contents: string): string {
  const match = contents.match(/<title>\s*([^<]+?)\s*<\/title>/iu);
  if (!match) fail('ROOTFS_CONTENT_FAILED', 'GUI index.html has no title');
  return match[1]!;
}

async function findNginxFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) fail('ROOTFS_CONTENT_FAILED', 'nginx configuration contains a symlink', { path });
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function verifyRootfs(input: VerificationInput): Promise<RootfsObservation> {
  const rootfs = resolve(input.rootfsPath);
  const requiredFiles: string[] = [];
  for (const runtimePath of REQUIRED_RUNTIME_FILES) {
    const relativePath = runtimePath.slice(1);
    const path = join(rootfs, relativePath);
    await assertNoFollowAncestors(rootfs, relativePath, 'ROOTFS_CONTENT_FAILED', 'a required rootfs path contains an unsafe ancestor');
    await assertRegular(path, 'ROOTFS_CONTENT_FAILED', 'a required rootfs file is missing');
    requiredFiles.push(runtimePath);
  }
  if (input.config.selectedTarget !== input.target.openwrtTarget || input.config.profile !== input.target.profile || input.config.rootfsPartSize !== input.target.rootfsPartSize || input.config.bothProfilesChecked !== true) {
    fail('TARGET_CONFIG_MISMATCH', 'resolved target configuration does not match the manifest', { selectedTarget: input.config.selectedTarget, profile: input.config.profile, rootfsPartSize: input.config.rootfsPartSize });
  }
  const nginx = Object.fromEntries(ROUTES.map((route) => [route, false])) as Record<(typeof ROUTES)[number], boolean>;
  const nginxRoot = join(rootfs, 'etc/nginx');
  await assertNoFollowAncestors(rootfs, 'etc/nginx/index', 'ROOTFS_CONTENT_FAILED', 'nginx configuration contains an unsafe ancestor');
  for (const path of await findNginxFiles(nginxRoot)) {
    const contents = (await readNoFollow(path)).toString('utf8');
    for (const route of ROUTES) {
      const escaped = route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (new RegExp(`\\blocation\\s+(?:(?:\\^~|=)\\s+)?${escaped}(?:\\s|\\{|$)`, 'u').test(contents)) nginx[route] = true;
    }
  }
  if (ROUTES.some((route) => !nginx[route])) fail('ROOTFS_CONTENT_FAILED', 'a required nginx route is missing', { missingRoute: ROUTES.find((route) => !nginx[route])! });

  const guiRoot = join(rootfs, 'usr/lib/node-red/gui');
  const feedGui = resolve(input.feedGuiPath ?? guiRoot);
  const guiIndex = join(guiRoot, 'index.html');
  const feedIndex = join(feedGui, 'index.html');
  await assertRegular(guiIndex, 'ROOTFS_CONTENT_FAILED', 'rootfs GUI index is missing');
  await assertRegular(feedIndex, 'ROOTFS_CONTENT_FAILED', 'frontend GUI mirror is missing');
  const guiTitle = titleOf((await readNoFollow(guiIndex)).toString('utf8'));
  const feedTitle = titleOf((await readNoFollow(feedIndex)).toString('utf8'));
  if (guiTitle !== feedTitle) fail('ROOTFS_CONTENT_FAILED', 'rootfs GUI title does not match the frontend mirror');
  const guiSha256 = await hashTree(guiRoot);
  const feedSha256 = await hashTree(feedGui);
  if (guiSha256 !== feedSha256) fail('ROOTFS_CONTENT_FAILED', 'rootfs GUI payload does not match the frontend mirror', { guiSha256, feedSha256 });

  const nodeResolution: Record<string, boolean> = {};
  const requireFromRootfs = createRequire(join(rootfs, 'usr/share/node-red/__verification__.js'));
  for (const helper of REQUIRED_HELPERS) {
    try { requireFromRootfs.resolve(`${helper}/package.json`); nodeResolution[helper] = true; } catch { nodeResolution[helper] = false; }
  }
  if (Object.values(nodeResolution).some((value) => !value)) fail('ROOTFS_CONTENT_FAILED', 'a required Node-RED dependency does not resolve', { missing: Object.entries(nodeResolution).find(([, value]) => !value)?.[0] ?? null });

  const databasePath = join(rootfs, 'usr/share/db/farming.db');
  let database: DatabaseSync | undefined;
  let chameleonCalibrationRows = 0;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    if (integrity.integrity_check !== 'ok') fail('ROOTFS_CONTENT_FAILED', 'SQLite integrity_check did not return ok');
    const row = database.prepare('SELECT COUNT(*) AS count FROM chameleon_calibrations').get() as { count?: number | bigint };
    chameleonCalibrationRows = Number(row.count ?? 0);
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail('ROOTFS_CONTENT_FAILED', 'rootfs SQLite database failed integrity or Chameleon checks', { path: databasePath });
  } finally { database?.close(); }

  const criticalHashes = {} as Record<'flows' | 'database' | 'gui', { sourceSha256: string; rootfsSha256: string; matched: true }>;
  if (!input.sourcePayloads) fail('ROOTFS_CONTENT_FAILED', 'critical source payload hashes were not supplied');
  for (const [name, pair] of Object.entries(input.sourcePayloads) as Array<[keyof typeof input.sourcePayloads, VerificationPathPair]>) {
    const sourceSha256 = name === 'gui' ? await hashTree(pair.sourcePath) : hashBytes(await readNoFollow(pair.sourcePath));
    const rootfsSha256 = name === 'gui' ? await hashTree(pair.rootfsPath) : hashBytes(await readNoFollow(pair.rootfsPath));
    if (sourceSha256 !== rootfsSha256) fail('ROOTFS_CONTENT_FAILED', 'critical source and rootfs payload hashes differ', { payload: name, sourceSha256, rootfsSha256 });
    criticalHashes[name] = { sourceSha256, rootfsSha256, matched: true };
  }
  return Object.freeze({ requiredFiles: Object.freeze(requiredFiles), nginxRoutes: Object.freeze(nginx), gui: Object.freeze({ title: guiTitle, sha256: guiSha256, feedSha256 }), criticalHashes: Object.freeze(criticalHashes), nodeResolution: Object.freeze(nodeResolution), database: Object.freeze({ integrityCheck: 'ok' as const, chameleonCalibrationRows }) });
}

async function freshness(input: VerificationInput): Promise<FreshnessResult> {
  if (!input.freshnessResolver) return { status: 'unknown', pinnedSha: input.pinnedSha, observedSha: null, newerSourceAvailable: false, errorCode: 'FRESHNESS_UNKNOWN' };
  try {
    const result = await input.freshnessResolver(input.branch, input.pinnedSha);
    if (result.pinnedSha !== input.pinnedSha || result.status === 'fresh' && result.observedSha !== input.pinnedSha || result.status === 'unknown' && (result.observedSha !== null || result.newerSourceAvailable !== false) || result.status === 'advanced' && (!SHA40.test(result.observedSha) || result.newerSourceAvailable !== true)) {
      fail('FRESHNESS_UNKNOWN', 'freshness resolver returned incoherent evidence');
    }
    return result;
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    return { status: 'unknown', pinnedSha: input.pinnedSha, observedSha: null, newerSourceAvailable: false, errorCode: 'FRESHNESS_UNKNOWN' };
  }
}

export async function verifyFirmwareArtifact(input: VerificationInput): Promise<VerificationResult> {
  if (!input.sourceEvidence.targetOutputAbsent || input.sourceEvidence.checkedTargetOutputPath !== `openwrt/bin/targets/${input.target.openwrtTarget}/`) fail('BUILD_OUTPUT_COLLISION', 'source evidence does not prove target output absence', { targetOutputAbsent: input.sourceEvidence.targetOutputAbsent });
  if (!SHA40.test(input.pinnedSha)) fail('ROOTFS_CONTENT_FAILED', 'pinned source SHA is invalid');
  const artifact = await resolveArtifact(input);
  const originalOpenWrtSha256sums = await verifyOriginalChecksum(resolve(input.artifactDirectory), artifact.basename);
  await verifyGzip(artifact.path);
  const generatedSha256sums = await verifyGeneratedChecksum(artifact as VerificationResult['artifact']);
  const rootfs = await verifyRootfs(input);
  const freshnessResult = await freshness(input);
  const evidenceValue = normalizeJson({
    schemaVersion: 1,
    artifact: { path: artifact.basename, basename: artifact.basename, size: artifact.size, mtime: artifact.mtime, sha256: artifact.sha256, gzip: true },
    checks: { originalOpenWrtSha256sums: { verified: true, entries: originalOpenWrtSha256sums.entries }, generatedSha256sums: { verified: true, filenames: generatedSha256sums.filenames } },
    config: input.config,
    rootfs,
    freshness: freshnessResult,
  }, 'verification evidence');
  let encoded: string;
  try { encoded = encodeJson(evidenceValue, 'verification evidence', true); } catch (error) { throw new VerificationError('VERIFICATION_EVIDENCE_INVALID', 'verification evidence is not canonical and bounded', {}, { cause: error }); }
  const bytes = Buffer.byteLength(`${encoded}\n`, 'utf8');
  return Object.freeze({ artifact: Object.freeze({ ...artifact, gzip: true as const }), checks: Object.freeze({ originalOpenWrtSha256sums, generatedSha256sums }), config: Object.freeze({ ...input.config }), rootfs, freshness: freshnessResult, evidence: Object.freeze({ json: evidenceValue as Record<string, unknown>, bytes, sha256: hashBytes(Buffer.from(`${encoded}\n`, 'utf8')) }) });
}

export const verifyFirmwareArtifacts = verifyFirmwareArtifact;
