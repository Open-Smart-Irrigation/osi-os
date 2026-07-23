import { createHash } from 'node:crypto';

export interface RustToolchainConfig {
  readonly llvmConfig: string;
  readonly channel: string;
  readonly version: string;
  readonly llvmMajor: number;
  readonly [key: string]: unknown;
}

export type RustToolchainValidation =
  | { readonly ok: true; readonly config: RustToolchainConfig }
  | { readonly ok: false; readonly reason: string };

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export function validateRustToolchain(value: unknown): RustToolchainValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'Rust configuration must be an object' };
  const config = value as RustToolchainConfig;
  const keys = Object.keys(config).sort();
  if (keys.join(',') !== 'channel,llvmConfig,llvmMajor,version') return { ok: false, reason: 'Rust configuration has unsupported fields' };
  if (config.llvmConfig !== '/usr/bin/llvm-config' || config.channel !== 'stable') return { ok: false, reason: 'Rust must use the stable host LLVM configuration' };
  if (typeof config.version !== 'string' || !SEMVER.test(config.version)) return { ok: false, reason: 'Rust version is not semver' };
  if (!Number.isInteger(config.llvmMajor) || config.llvmMajor < 1) return { ok: false, reason: 'Rust LLVM major is invalid' };
  return { ok: true, config };
}

export const RUST_CI_LLVM_ARTIFACT = 'rust-ci-llvm';

export type OpenWrtRustFeedValidation =
  | { readonly ok: true; readonly policy: 'system-llvm-only' }
  | { readonly ok: false; readonly reason: string };

export interface OpenWrtRustFeedTransformContract {
  readonly sourceCommit: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly enforcedSha256: string;
  readonly hostTriple: string;
}

export type OpenWrtRustFeedEnforcement =
  | { readonly ok: true; readonly policy: 'system-llvm-only'; readonly sourceSha256: string; readonly enforcedSha256: string; readonly source: string }
  | { readonly ok: false; readonly reason: string };

export const OPENWRT_RUST_FEED_CONTRACT: OpenWrtRustFeedTransformContract = Object.freeze({
  sourceCommit: 'd8cd30f4e281d6853b3de134c4f147a807583e43',
  sourcePath: 'lang/rust/Makefile',
  sourceSha256: 'e6a9895c3e4e36b1699fa472f8943ee7bc838ca7daeae1902c2abfb83379d5cb',
  enforcedSha256: 'df5c72347a7f0d862c2cf03c9d2375f4d5de2aef4665e9aa53a37487cbaa3a33',
  hostTriple: 'x86_64-unknown-linux-gnu',
});
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const TRIPLE = /^[a-z0-9_]+(?:-[a-z0-9_]+){2,}$/u;

function llvmArgument(enabled: boolean): string {
  return `\t--set=llvm.download-ci-llvm=${enabled ? 'true' : 'false'} \\\n`;
}

function hostLlvmConfigArgument(hostTriple: string): string {
  return `\t--set=target.${hostTriple}.llvm-config=/usr/bin/llvm-config \\\n`;
}

function hostConfigureArgs(source: string): string | undefined {
  return source.match(/HOST_CONFIGURE_ARGS\s*=\s*\\\n([\s\S]*?)\n\t\$\(TARGET_CONFIGURE_ARGS\)/u)?.[0];
}

function feedSha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/**
 * The builder image proves its own compiler path; the firmware feed must be
 * checked separately before OpenWrt configuration so that proof is not
 * mistaken for proof of the eventual firmware compiler.
 */
export function validateOpenWrtRustFeed(source: string): OpenWrtRustFeedValidation {
  if (typeof source !== 'string' || source.length === 0) return { ok: false, reason: 'OpenWrt Rust feed source is missing' };
  if (!TRIPLE.test(OPENWRT_RUST_FEED_CONTRACT.hostTriple)) return { ok: false, reason: 'OpenWrt Rust feed host triple is invalid' };
  const enabled = llvmArgument(true);
  const disabled = llvmArgument(false);
  const hostConfig = hostLlvmConfigArgument(OPENWRT_RUST_FEED_CONTRACT.hostTriple);
  const hostArgs = hostConfigureArgs(source);
  if (source.includes(enabled)) return { ok: false, reason: 'OpenWrt Rust feed enables the mutable Rust CI LLVM artifact' };
  if ((source.match(new RegExp(escapeRegExp(disabled), 'gu')) ?? []).length !== 1) return { ok: false, reason: 'OpenWrt Rust feed must contain exactly one download-ci-llvm=false assignment' };
  if ((source.match(new RegExp(escapeRegExp(hostConfig), 'gu')) ?? []).length !== 1) return { ok: false, reason: 'OpenWrt Rust feed must contain exactly one host llvm-config assignment' };
  if (hostArgs === undefined || !hostArgs.includes(disabled) || !hostArgs.includes(hostConfig)) return { ok: false, reason: 'OpenWrt Rust feed LLVM settings must be inside HOST_CONFIGURE_ARGS' };
  if (/--set=llvm\.download-ci-llvm=(?!false\s*\\)/u.test(source) || /--set=target\.[^\s]+\.llvm-config=(?!\/usr\/bin\/llvm-config\s*\\)/u.test(source)) return { ok: false, reason: 'OpenWrt Rust feed contains an unsupported LLVM assignment' };
  if (/rust-ci-llvm/iu.test(source)) return { ok: false, reason: 'OpenWrt Rust feed contains a Rust CI LLVM artifact reference' };
  return { ok: true, policy: 'system-llvm-only' };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function enforceOpenWrtRustFeed(source: string, contract: OpenWrtRustFeedTransformContract): OpenWrtRustFeedEnforcement {
  if (contract.sourceCommit !== OPENWRT_RUST_FEED_CONTRACT.sourceCommit || contract.sourcePath !== OPENWRT_RUST_FEED_CONTRACT.sourcePath || contract.sourceSha256 !== OPENWRT_RUST_FEED_CONTRACT.sourceSha256 || contract.enforcedSha256 !== OPENWRT_RUST_FEED_CONTRACT.enforcedSha256 || contract.hostTriple !== OPENWRT_RUST_FEED_CONTRACT.hostTriple) return { ok: false, reason: 'OpenWrt Rust feed contract metadata is not the approved pinned contract' };
  if (!COMMIT.test(contract.sourceCommit) || !HASH.test(contract.sourceSha256) || !HASH.test(contract.enforcedSha256) || !TRIPLE.test(contract.hostTriple)) return { ok: false, reason: 'OpenWrt Rust feed contract metadata is invalid' };
  const sourceSha256 = feedSha256(source);
  if (sourceSha256 !== contract.sourceSha256) return { ok: false, reason: 'OpenWrt Rust feed source hash is not approved' };
  const enabled = llvmArgument(true);
  const disabled = llvmArgument(false);
  const hostConfig = hostLlvmConfigArgument(contract.hostTriple);
  if ((source.match(new RegExp(escapeRegExp(enabled), 'gu')) ?? []).length !== 1 || source.includes(disabled) || source.includes(hostConfig) || hostConfigureArgs(source) === undefined) return { ok: false, reason: 'OpenWrt Rust feed does not match the exact transform input contract' };
  const transformed = source.replace(enabled, `${disabled}${hostConfig}`);
  const enforcedSha256 = feedSha256(transformed);
  if (enforcedSha256 !== contract.enforcedSha256) return { ok: false, reason: 'OpenWrt Rust feed transformed hash is not approved' };
  const validation = validateOpenWrtRustFeed(transformed);
  if (!validation.ok) return validation;
  return { ok: true, policy: 'system-llvm-only', sourceSha256, enforcedSha256, source: transformed };
}

export interface RustToolchainEvidence {
  readonly rustcVersion: string;
  readonly llvmVersion: string;
  readonly llvmConfig: string;
  readonly channel: string;
  readonly pollyVersion: string | null;
  readonly zstdVersion: string | null;
}

export function validateRustToolchainEvidence(value: RustToolchainEvidence): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!value || value.llvmConfig !== '/usr/bin/llvm-config' || value.channel !== 'stable') return { ok: false, reason: 'Rust must use stable host llvm-config' };
  if ([value.rustcVersion, value.llvmVersion, value.pollyVersion, value.zstdVersion].some((item) => typeof item !== 'string' || item.length === 0 || /rust-ci-llvm/iu.test(item))) return { ok: false, reason: 'Rust/LLVM validation evidence is incomplete or uses a Rust CI artifact' };
  return { ok: true };
}
