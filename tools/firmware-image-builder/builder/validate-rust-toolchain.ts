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
  readonly sourceSha256: string;
  readonly enforcedSha256: string;
}

export type OpenWrtRustFeedEnforcement =
  | { readonly ok: true; readonly policy: 'system-llvm-only'; readonly sourceSha256: string; readonly enforcedSha256: string; readonly source: string }
  | { readonly ok: false; readonly reason: string };

const FEED_CI_LLVM_ENABLED = 'llvm.download-ci-llvm=true';
const FEED_CI_LLVM_DISABLED = 'llvm.download-ci-llvm=false';
const FEED_HOST_LLVM_CONFIG = 'llvm-config=/usr/bin/llvm-config';
const HASH = /^[0-9a-f]{64}$/u;

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
  const lines = source.split(/\r?\n/u).map((line) => line.trim());
  if (lines.filter((line) => line === FEED_CI_LLVM_ENABLED).length > 0) return { ok: false, reason: 'OpenWrt Rust feed enables the mutable Rust CI LLVM artifact' };
  if (lines.filter((line) => line === FEED_CI_LLVM_DISABLED).length !== 1) return { ok: false, reason: 'OpenWrt Rust feed must contain exactly one download-ci-llvm=false assignment' };
  if (lines.filter((line) => line === FEED_HOST_LLVM_CONFIG).length !== 1) return { ok: false, reason: 'OpenWrt Rust feed must contain exactly one host llvm-config=/usr/bin/llvm-config assignment' };
  if (lines.some((line) => line.startsWith('llvm.download-ci-llvm=') && line !== FEED_CI_LLVM_DISABLED) || lines.some((line) => line.startsWith('llvm-config=') && line !== FEED_HOST_LLVM_CONFIG)) return { ok: false, reason: 'OpenWrt Rust feed contains an unsupported LLVM assignment' };
  if (/rust-ci-llvm/iu.test(source)) return { ok: false, reason: 'OpenWrt Rust feed contains a Rust CI LLVM artifact reference' };
  return { ok: true, policy: 'system-llvm-only' };
}

export function enforceOpenWrtRustFeed(source: string, contract: OpenWrtRustFeedTransformContract): OpenWrtRustFeedEnforcement {
  if (!HASH.test(contract.sourceSha256) || !HASH.test(contract.enforcedSha256)) return { ok: false, reason: 'OpenWrt Rust feed contract hashes are invalid' };
  const sourceSha256 = feedSha256(source);
  if (sourceSha256 !== contract.sourceSha256) return { ok: false, reason: 'OpenWrt Rust feed source hash is not approved' };
  const lines = source.split(/\r?\n/u);
  const enabled = lines.filter((line) => line.trim() === FEED_CI_LLVM_ENABLED).length;
  if (enabled !== 1 || lines.some((line) => line.trim().startsWith('llvm.download-ci-llvm=') && line.trim() !== FEED_CI_LLVM_ENABLED)) return { ok: false, reason: 'OpenWrt Rust feed does not match the exact transform input contract' };
  if (lines.some((line) => line.trim().startsWith('llvm-config=') && line.trim() !== FEED_HOST_LLVM_CONFIG)) return { ok: false, reason: 'OpenWrt Rust feed contains an unknown host LLVM config input' };
  const transformedLines = lines.map((line) => line.trim() === FEED_CI_LLVM_ENABLED ? line.replace(FEED_CI_LLVM_ENABLED, FEED_CI_LLVM_DISABLED) : line);
  if (!transformedLines.some((line) => line.trim() === FEED_HOST_LLVM_CONFIG)) transformedLines.push(FEED_HOST_LLVM_CONFIG);
  const transformed = transformedLines.join('\n');
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
