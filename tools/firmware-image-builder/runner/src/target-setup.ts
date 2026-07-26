import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { BuilderError, type BuilderErrorCode } from '../../domain/errors.js';
import type { TargetManifest } from '../../manifest/schema.js';
import { enforceOpenWrtRustFeed, OPENWRT_RUST_FEED_CONTRACT } from '../../builder/validate-rust-toolchain.js';
import {
  createOperationDefinition,
  type OperationDefinition,
} from './operation-registry.js';
import type { CommandResult } from './command-executor.js';

export const ROOTFS_PADDING_PATCH = 'image-with-padded-rootfs.patch';
const PACKAGES_COMMIT = OPENWRT_RUST_FEED_CONTRACT.sourceCommit;
const ROOTFS_PADDING_MARKERS = Object.freeze([
  'ROOTFSSIZE="$(($4 / 512))"',
  'ROOTFSIMGSIZE="$((($(wc -c < $ROOTFS) + 511) / 512))"',
  'ROOTFSPADDINGSIZE="$(($ROOTFSSIZE - $ROOTFSIMGSIZE))"',
  'ROOTFSPADDINGOFFSET="$(($ROOTFSOFFSET + $ROOTFSIMGSIZE))"',
  'if [ "$ROOTFSPADDINGSIZE" -gt 2048 ]; then',
  'ROOTFSPADDINGSIZE="2048"',
  'dd bs=512 if=/dev/zero of="$OUTPUT" seek="$ROOTFSPADDINGOFFSET" count="$ROOTFSPADDINGSIZE" conv=notrunc',
] as const);
const REQUIRED_LINKS = Object.freeze(['node-red', 'node-red-contrib-chirpstack', 'node-red-node-sqlite', 'chirpstack'] as const);
const TARGET_SETUP_OPERATIONS = Object.freeze(['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config'] as const);
export type TargetSetupOperationId = (typeof TARGET_SETUP_OPERATIONS)[number];

export class TargetSetupError extends BuilderError {
  constructor(code: BuilderErrorCode, message: string, requestId: string, details: Record<string, string | number | boolean | null> = {}, operationId?: TargetSetupOperationId) {
    super({
      code,
      stage: code === 'FEED_INSTALL_FAILED' || code === 'FEED_LINKS_MISSING' ? 'feeds' : code === 'TARGET_CONFIG_MISMATCH' ? 'config' : 'target-setup',
      details,
      retryable: code === 'FEED_INSTALL_FAILED',
      requestId,
      diagnosis: message,
      recovery: code === 'RUST_BOOTSTRAP_UNAVAILABLE' ? 'Restore the pinned packages feed and supported LLVM-backed Rust configuration.' : 'Inspect the target-setup evidence and create a new job from the corrected pinned source.',
      operationId,
    });
    this.name = 'TargetSetupError';
  }
}

export interface LockedTargetSetupOperations {
  readonly run: (operationId: TargetSetupOperationId, definition: OperationDefinition) => Promise<CommandResult>;
}

export interface TargetSetupFileSystem {
  readonly readFile: typeof readFile;
  readonly lstat: typeof lstat;
  readonly realpath: typeof realpath;
  readonly writeFile: typeof writeFile;
}

const DEFAULT_FILE_SYSTEM: TargetSetupFileSystem = { readFile, lstat, realpath, writeFile };

export interface RootfsPatchStateInput {
  readonly series: readonly string[];
  readonly applied: readonly string[];
  readonly output: string;
  readonly rootfsScript: string;
}

export type RootfsPatchDecision = 'applied' | 'already-present';

function fail(code: BuilderErrorCode, message: string, requestId: string, details: Record<string, string | number | boolean | null> = {}, operationId?: TargetSetupOperationId): never {
  throw new TargetSetupError(code, message, requestId, details, operationId);
}

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function parsePatchNames(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
}

function hasExactList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function hasRootfsPaddingImplementation(source: string): boolean {
  return ROOTFS_PADDING_MARKERS.every((marker) => source.includes(marker));
}

export function decideRootfsPatchState(input: RootfsPatchStateInput, requestId = 'target-setup'): RootfsPatchDecision {
  const series = parsePatchNames(input.series);
  const applied = parsePatchNames(input.applied);
  if (!series.includes(ROOTFS_PADDING_PATCH) || series.length === 0 || new Set(series).size !== series.length || !hasRootfsPaddingImplementation(input.rootfsScript)) {
    fail('PATCH_STATE_AMBIGUOUS', 'The rootfs padding patch series or implementation is not the approved one.', requestId);
  }
  const outputLines = input.output.split(/\r?\n/u);
  const reverseWindows = outputLines.flatMap((line, index) => /revers(?:ed|e)|previously applied/iu.test(line)
    ? [`${outputLines[index - 1] ?? ''}\n${line}\n${outputLines[index + 1] ?? ''}`]
    : []);
  const namedReverse = reverseWindows.filter((window) => window.includes(ROOTFS_PADDING_PATCH));
  const unknownReverse = reverseWindows.filter((window) => !window.includes(ROOTFS_PADDING_PATCH));
  const expectedApplied = series.filter((patch) => patch !== ROOTFS_PADDING_PATCH);
  if (namedReverse.length === 1 && unknownReverse.length === 0 && hasExactList(applied, expectedApplied)) return 'already-present';
  if (reverseWindows.length > 0) fail('PATCH_STATE_AMBIGUOUS', 'OpenWrt reported an unapproved reverse-applicable patch state.', requestId, { patch: ROOTFS_PADDING_PATCH });
  if (hasExactList(applied, series)) return 'applied';
  fail('PATCH_STATE_AMBIGUOUS', 'OpenWrt reported an incomplete or unapproved reverse-applicable patch state.', requestId, { patch: ROOTFS_PADDING_PATCH });
}

function feedEntry(contents: string, name: string): { readonly type: string; readonly location: string } | null {
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/u);
    if (parts.length >= 3 && parts[1] === name) return { type: parts[0]!, location: parts.slice(2).join(' ') };
  }
  return null;
}

function pinnedPackagesFeed(contents: string, requestId: string): void {
  const entry = feedEntry(contents, 'packages');
  if (entry === null || entry.type !== 'src-git' || !entry.location.endsWith(`^${PACKAGES_COMMIT}`)) {
    fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The packages feed is not pinned to the approved Rust contract commit.', requestId, { expectedCommit: PACKAGES_COMMIT });
  }
}

async function readText(path: string, fileSystem: TargetSetupFileSystem): Promise<string> {
  return (await fileSystem.readFile(path, 'utf8')) as string;
}

async function exists(path: string, fileSystem: TargetSetupFileSystem): Promise<boolean> {
  try { await fileSystem.lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function hashFile(path: string, fileSystem: TargetSetupFileSystem): Promise<string> {
  return sha256(await fileSystem.readFile(path));
}

function expectedConfigValue(config: string, name: string, type: 'bool' | 'string' | 'number'): boolean | string | number | undefined {
  const matching = config.split(/\r?\n/u).filter((line) => line.startsWith(`${name}=`) || line === `# ${name} is not set`);
  if (matching.length !== 1) return undefined;
  const line = matching[0]!;
  if (type === 'bool') return line === `${name}=y`;
  if (line.startsWith(`${name}="`) && line.endsWith('"')) return type === 'string' ? line.slice(name.length + 2, -1) : undefined;
  if (type === 'number' && new RegExp(`^${name}=-?\\d+$`, 'u').test(line)) return Number(line.slice(name.length + 1));
  return undefined;
}

function checkConfig(config: string, target: TargetManifest, requestId: string, context: string): void {
  for (const symbol of target.configSymbols) {
    const actual = expectedConfigValue(config, symbol.name, symbol.type);
    if (actual !== symbol.value) fail('TARGET_CONFIG_MISMATCH', `The ${context} config symbol ${symbol.name} does not match the target manifest.`, requestId, { symbol: symbol.name, expected: String(symbol.value), observed: actual === undefined ? null : String(actual) });
  }
}

async function verifyLinks(worktreePath: string, requestId: string, fileSystem: TargetSetupFileSystem): Promise<readonly string[]> {
  const linkDirectory = join(worktreePath, 'openwrt/package/feeds/chirpstack');
  const feedRoot = await fileSystem.realpath(join(worktreePath, 'feeds/chirpstack-openwrt-feed'));
  const names: string[] = [];
  for (const name of REQUIRED_LINKS) {
    const path = join(linkDirectory, name);
    let info;
    try { info = await fileSystem.lstat(path); } catch { fail('FEED_LINKS_MISSING', `The installed feed link ${name} is missing.`, requestId, { package: name }); }
    if (!info.isSymbolicLink()) fail('FEED_LINKS_MISSING', `The installed feed entry ${name} is not a symbolic link.`, requestId, { package: name });
    let resolved: string;
    try { resolved = await fileSystem.realpath(path); } catch { fail('FEED_LINKS_MISSING', `The installed feed link ${name} is broken.`, requestId, { package: name }); }
    const expected = name === 'chirpstack' ? join(feedRoot, 'chirpstack/chirpstack') : join(feedRoot, 'apps', name);
    if (resolved !== expected) fail('FEED_LINKS_MISSING', `The installed feed link ${name} resolves to an unexpected package.`, requestId, { package: name });
    names.push(name);
  }
  return names;
}

async function rustFeed(worktreePath: string, sourceFeed: string, requestId: string, fileSystem: TargetSetupFileSystem): Promise<{ readonly sourceSha256: string; readonly enforcedSha256: string; readonly path: string; readonly sourceCommit: string; readonly hostTriple: string }> {
  pinnedPackagesFeed(sourceFeed, requestId);
  const feedRoot = join(worktreePath, 'openwrt/feeds/packages');
  const path = join(feedRoot, OPENWRT_RUST_FEED_CONTRACT.sourcePath);
  if (!(await exists(path, fileSystem))) fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The pinned packages feed Rust Makefile is unavailable.', requestId, { path: relative(worktreePath, path), commit: PACKAGES_COMMIT });
  let source: string;
  try { source = await readText(path, fileSystem); } catch { fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The pinned packages feed Rust Makefile cannot be read.', requestId, { path: relative(worktreePath, path), commit: PACKAGES_COMMIT }); }
  const enforcement = enforceOpenWrtRustFeed(source, OPENWRT_RUST_FEED_CONTRACT);
  if (!enforcement.ok) fail('RUST_BOOTSTRAP_UNAVAILABLE', `The pinned Rust feed failed the exact transformation contract: ${enforcement.reason}`, requestId, { path: relative(worktreePath, path), commit: PACKAGES_COMMIT, hostTriple: OPENWRT_RUST_FEED_CONTRACT.hostTriple });
  try { await fileSystem.writeFile(path, enforcement.source, 'utf8'); } catch { fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The transformed Rust feed could not be written.', requestId, { path: relative(worktreePath, path), commit: PACKAGES_COMMIT }); }
  if (await hashFile(path, fileSystem) !== enforcement.enforcedSha256) fail('RUST_BOOTSTRAP_UNAVAILABLE', 'The transformed Rust feed hash does not match the approved contract.', requestId, { path: relative(worktreePath, path), commit: PACKAGES_COMMIT, hostTriple: OPENWRT_RUST_FEED_CONTRACT.hostTriple });
  return { sourceSha256: enforcement.sourceSha256, enforcedSha256: enforcement.enforcedSha256, path: relative(worktreePath, path), sourceCommit: PACKAGES_COMMIT, hostTriple: OPENWRT_RUST_FEED_CONTRACT.hostTriple };
}

async function patchState(worktreePath: string, output: string, requestId: string, fileSystem: TargetSetupFileSystem): Promise<RootfsPatchDecision> {
  const seriesPath = await exists(join(worktreePath, 'openwrt/.pc/series'), fileSystem) ? join(worktreePath, 'openwrt/.pc/series') : join(worktreePath, 'openwrt/patches/series');
  const appliedPath = join(worktreePath, 'openwrt/.pc/applied-patches');
  let series: string;
  let applied: string;
  let rootfsScript: string;
  try {
    series = await readText(seriesPath, fileSystem);
    applied = await readText(appliedPath, fileSystem);
    rootfsScript = await readText(join(worktreePath, 'openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh'), fileSystem);
  } catch { fail('PATCH_STATE_AMBIGUOUS', 'The OpenWrt quilt state or rootfs padding implementation is unavailable.', requestId); }
  return decideRootfsPatchState({ series: series.split(/\r?\n/u), applied: applied.split(/\r?\n/u), output, rootfsScript }, requestId);
}

export interface TargetSetupInput {
  readonly worktreePath: string;
  readonly target: TargetManifest;
  readonly targets: readonly TargetManifest[];
  readonly operations: LockedTargetSetupOperations;
  readonly requestId: string;
  readonly fileSystem?: TargetSetupFileSystem;
}

export interface TargetSetupResult {
  readonly target: TargetManifest['id'];
  readonly patchDecision: RootfsPatchDecision;
  readonly feed: { readonly sourceSha256: string; readonly destinationSha256: string; readonly localPath: string; readonly packagesCommit: string; readonly installedPackages: readonly string[] };
  readonly rust: { readonly sourceSha256: string; readonly enforcedSha256: string; readonly path: string; readonly sourceCommit: string; readonly hostTriple: string };
  readonly config: { readonly selectedTarget: string; readonly profile: string; readonly rootfsPartSize: number; readonly sourceSha256: string; readonly resolvedSha256: string; readonly bothProfilesChecked: true };
}

export async function resolveTargetSetup(input: TargetSetupInput): Promise<TargetSetupResult> {
  const fileSystem = input.fileSystem ?? DEFAULT_FILE_SYSTEM;
  if (!isAbsolute(input.worktreePath)) throw new TargetSetupError('WORKTREE_CREATE_FAILED', 'The target setup worktree must be an absolute path.', input.requestId);
  const worktreePath = resolve(input.worktreePath);
  const targetById = new Map(input.targets.map((target) => [target.id, target]));
  if (targetById.size !== 2 || !targetById.has('rpi-5') || !targetById.has('rpi-2')) fail('TARGET_CONFIG_MISMATCH', 'Both shipped Raspberry Pi profile manifests are required for target setup.', input.requestId);
  const run = async (operationId: TargetSetupOperationId): Promise<CommandResult> => {
    let definition: OperationDefinition;
    try { definition = createOperationDefinition(operationId, { environment: input.target.environment }); }
    catch { fail('TARGET_CONFIG_MISMATCH', 'The target environment is not a validated locked-builder environment.', input.requestId, { environment: input.target.environment }, operationId); }
    const result = await input.operations.run(operationId, definition);
    return result;
  };

  const activation = await run('activate-target');
  const patchDecision = await patchState(worktreePath, `${activation.stdout}\n${activation.stderr}`, input.requestId, fileSystem);
  if (activation.exitCode !== 0 && patchDecision !== 'already-present') fail('PATCH_STATE_AMBIGUOUS', 'Target environment activation did not produce an approved patch state.', input.requestId, { exitCode: activation.exitCode }, 'activate-target');

  const sourceFeedPath = join(worktreePath, 'feeds.conf.default');
  const destinationFeedPath = join(worktreePath, 'openwrt/feeds.conf.default');
  const sourceFeed = await readText(sourceFeedPath, fileSystem);
  const sourceSha256 = sha256(sourceFeed);
  const copyResult = await run('copy-feed-config');
  if (copyResult.exitCode !== 0) fail('FEED_INSTALL_FAILED', 'The pinned feed configuration could not be copied.', input.requestId, { exitCode: copyResult.exitCode }, 'copy-feed-config');
  let destinationSha256: string;
  try { destinationSha256 = await hashFile(destinationFeedPath, fileSystem); } catch { fail('FEED_INSTALL_FAILED', 'The copied feed configuration is missing.', input.requestId, { path: relative(worktreePath, destinationFeedPath) }, 'copy-feed-config'); }
  if (sourceSha256 !== destinationSha256) fail('FEED_INSTALL_FAILED', 'The copied feed configuration hash differs from the pinned source.', input.requestId, { sourceSha256, destinationSha256 }, 'copy-feed-config');
  const chirpstack = feedEntry(sourceFeed, 'chirpstack');
  if (chirpstack === null || chirpstack.type !== 'src-link' || chirpstack.location !== 'feeds/chirpstack-openwrt-feed') fail('FEED_INSTALL_FAILED', 'The feed configuration does not contain the exact local ChirpStack feed entry.', input.requestId, { entry: chirpstack?.location ?? null });
  let localPath: string;
  let expectedLocalPath: string;
  try {
    localPath = await fileSystem.realpath(join(worktreePath, chirpstack.location));
    expectedLocalPath = await fileSystem.realpath(join(worktreePath, 'feeds/chirpstack-openwrt-feed'));
  } catch { fail('FEED_INSTALL_FAILED', 'The local ChirpStack feed directory is unavailable.', input.requestId, { path: 'feeds/chirpstack-openwrt-feed' }); }
  if (localPath !== expectedLocalPath) fail('FEED_INSTALL_FAILED', 'The local ChirpStack feed does not resolve to the pinned worktree.', input.requestId, { localPath, expectedLocalPath });

  const rust = await rustFeed(worktreePath, sourceFeed, input.requestId, fileSystem);
  const update = await run('update-feeds');
  if (update.exitCode !== 0) fail('FEED_INSTALL_FAILED', 'OpenWrt feed update failed.', input.requestId, { exitCode: update.exitCode }, 'update-feeds');
  const install = await run('install-feeds');
  if (install.exitCode !== 0) fail('FEED_INSTALL_FAILED', 'OpenWrt feed installation failed.', input.requestId, { exitCode: install.exitCode }, 'install-feeds');
  const installedPackages = await verifyLinks(worktreePath, input.requestId, fileSystem);

  const sourceConfig = await readText(join(worktreePath, 'conf', input.target.environment, '.config'), fileSystem);
  for (const target of input.targets) {
    if (target.id === 'rpi-5' || target.id === 'rpi-2') checkConfig(await readText(join(worktreePath, 'conf', target.environment, '.config'), fileSystem), target, input.requestId, `${target.id} source`);
  }
  const sourceSha = sha256(sourceConfig);
  const resolveResult = await run('resolve-config');
  if (resolveResult.exitCode !== 0) fail('TARGET_CONFIG_MISMATCH', 'OpenWrt defconfig failed.', input.requestId, { exitCode: resolveResult.exitCode }, 'resolve-config');
  const resolvedConfig = await readText(join(worktreePath, 'openwrt/.config'), fileSystem);
  checkConfig(resolvedConfig, input.target, input.requestId, 'resolved');
  const configSymbols = new Map(input.target.configSymbols.map((symbol) => [symbol.name, expectedConfigValue(resolvedConfig, symbol.name, symbol.type)]));
  const profile = configSymbols.get('CONFIG_TARGET_PROFILE');
  const rootfsPartSize = configSymbols.get('CONFIG_TARGET_ROOTFS_PARTSIZE');
  if (typeof profile !== 'string' || typeof rootfsPartSize !== 'number') fail('TARGET_CONFIG_MISMATCH', 'The resolved target profile or rootfs size is not typed as expected.', input.requestId);

  return Object.freeze({
    target: input.target.id,
    patchDecision,
    feed: Object.freeze({ sourceSha256, destinationSha256, localPath, packagesCommit: PACKAGES_COMMIT, installedPackages: Object.freeze(installedPackages) }),
    rust: Object.freeze(rust),
    config: Object.freeze({ selectedTarget: input.target.openwrtTarget, profile, rootfsPartSize, sourceSha256: sourceSha, resolvedSha256: sha256(resolvedConfig), bothProfilesChecked: true as const }),
  });
}
