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

/**
 * The builder image proves its own compiler path; the firmware feed must be
 * checked separately before OpenWrt configuration so that proof is not
 * mistaken for proof of the eventual firmware compiler.
 */
export function validateOpenWrtRustFeed(source: string): OpenWrtRustFeedValidation {
  if (typeof source !== 'string' || source.length === 0) return { ok: false, reason: 'OpenWrt Rust feed source is missing' };
  if (/download-ci-llvm\s*=\s*true/iu.test(source)) return { ok: false, reason: 'OpenWrt Rust feed enables the mutable Rust CI LLVM artifact' };
  if (!/download-ci-llvm\s*=\s*false/iu.test(source)) return { ok: false, reason: 'OpenWrt Rust feed does not explicitly disable Rust CI LLVM downloads' };
  return { ok: true, policy: 'system-llvm-only' };
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
