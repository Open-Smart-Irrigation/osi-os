import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { validateBuilderLock, type BuilderLock } from '../domain/builder-lock.js';
import { BUILDER_LOCK_OPTIONAL_KEYS, BUILDER_LOCK_REQUIRED_KEYS } from '../domain/builder-lock.js';
import { TRUSTED_OPERATION_IDS } from '../domain/types.js';
import { DEPENDENCY_EGRESS_OPERATION_HOSTS } from '../domain/dependency-egress-identity.js';
export { DEPENDENCY_EGRESS_OPERATION_HOSTS } from '../domain/dependency-egress-identity.js';
import { assertSupportedPackageParity, BuilderSourceError, supportedPackageTokens } from './derive-dockerfile.js';
import { validateRustToolchain, type RustToolchainConfig } from './validate-rust-toolchain.js';

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/u;
const NODE_VERSION = /(?:node-v|NODE_VERSION=|nodejs\s+)(\d+\.\d+\.\d+)/u;
const LLVM_MAJOR = /(?:LLVM_MAJOR=|llvm(?:-dev)?\s+)(\d+)/u;
const POLLY_PACKAGE = /libpolly-(\d+)-dev/u;
const BASE_IMAGE = /^ARG BUILDER_PLATFORM=linux\/amd64\s+FROM\s+--platform=\$\{BUILDER_PLATFORM\}\s+(\S+@sha256:([0-9a-f]{64}))\s*$/mu;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DOCKER_REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9]\d{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const TRUSTED_OPERATION_TOOL_SHA256 = '950fcbe2149c9d8ae53ed1bebd621d5c6a63f3e291274682bec8b25e89bcb3b5';
const TRUSTED_MODULE_PROBE_SHA256 = 'da68440c7c0662c9278ed656efe9861cda78cc190643320562066bca2d4ba5e7';
const TRUSTED_EXECUTION_GUARD_SHA256 = '9d484b8a438ddcab8d35ebf85e4a0cf03cfe167f4919c3057071135ce16c3fe6';
export const TRUSTED_DEPENDENCY_PROXY_SHA256 = '84832d32bc6c0028218f58ebe392678361fcd2e315dad5af4dbad3b847502ac5';
const TRUSTED_PROXY_CREDENTIAL_ENV_SHA256 = 'ce6a981786811b9d9f5cc1d86b8b6664900ac29748b6dd9c0a543809d550e684';
const TRUSTED_WGET_CONFIG_SHA256 = '21610fb0e4cc78052b4e5a4582300bea2affeaf2f1501d14662a8137cdb443aa';
const PINNED_NODE_VERSION = '22.14.0';
const PINNED_NODE_TARBALL_SHA256 = '69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec';
const PINNED_NPM_VERSION = '11.10.1';
const PINNED_NPM_TARBALL_SHA256 = '2190945151842685142f5085b3c5dd356b1021ab390d7d02c2bb2c580f0c4840';
export const TRUSTED_OPERATION_TOOL_RELATIVE_PATH = 'operations/osi-image-builder-tool.js';
export const TRUSTED_MODULE_PROBE_RELATIVE_PATH =
  'operations/osi-image-builder-module-probe.js';
export const TRUSTED_EXECUTION_GUARD_RELATIVE_PATH =
  'operations/osi-image-builder-exec-guard.js';
export const TRUSTED_DEPENDENCY_PROXY_RELATIVE_PATH =
  'operations/osi-dependency-egress-proxy.cjs';
export const TRUSTED_PROXY_CREDENTIAL_ENV_RELATIVE_PATH =
  'operations/osi-proxy-credential-environment.cjs';
export const TRUSTED_WGET_CONFIG_RELATIVE_PATH = 'operations/osi-wgetrc';
export const READ_ONLY_OPERATION_IDS = Object.freeze(['verify-image'] as const);
export const OFFLINE_OPERATION_IDS = Object.freeze([
  'activate-target',
  'copy-feed-config',
  'update-feeds',
  'install-feeds',
  'resolve-config',
  'verify-image',
  'verify-profile-parity',
  'verify-chameleon',
  'verify-db-schema',
  'verify-sync-flow',
  'verify-strega',
  'verify-communication',
  'check-mqtt-topics',
  'frontend-test',
  'frontend-typecheck',
  'frontend-build',
  'mirror-gui',
] as const);
export const RUST_TARGETS = Object.freeze(['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-musl', 'armv7-unknown-linux-musleabihf'] as const);
const TARGET_PACKAGE_NAMES = Object.freeze(['musl:arm64', 'musl-dev:arm64', 'musl:armhf', 'musl-dev:armhf'] as const);
const BUILDER_VALIDATION_PACKAGE_NAMES = Object.freeze(['sqlite3'] as const);

export type BuilderValidationErrorCode = 'BUILDER_SOURCE_DRIFT' | 'BUILDER_DOCKERFILE_INVALID' | 'BUILDER_VALIDATION_EVIDENCE_INVALID' | 'BUILDER_LOCK_INVALID' | 'BUILDER_IMAGE_DIGEST_INVALID' | 'BUILDER_RUNTIME_ENV_INVALID' | 'RUST_BOOTSTRAP_UNAVAILABLE' | 'DOCKER_UNAVAILABLE';

export class BuilderValidationError extends Error {
  readonly code: BuilderValidationErrorCode;

  constructor(code: BuilderValidationErrorCode, message: string) {
    super(message);
    this.name = 'BuilderValidationError';
    this.code = code;
  }
}

export interface BuilderValidationEvidence {
  readonly imageId: string;
  readonly imageDigest: string;
  readonly architecture: 'linux/amd64';
  readonly rustc: string;
  readonly llvm: string;
  readonly polly: string;
  readonly zstd: string;
  readonly node: string;
  readonly npm: string;
  readonly packages: readonly string[];
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly commands: readonly BuilderEvidenceCommand[];
  readonly rustTargets: readonly RustArtifactEvidence[];
  readonly operationTool: Readonly<{ readonly path: '/opt/osi-image-builder/operations/osi-image-builder-tool.js'; readonly owner: '0:0'; readonly mode: '0555'; readonly user: 'buildbot'; readonly result: 'passed' }>;
  readonly executionGuard: Readonly<{ readonly path: '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js'; readonly owner: '0:0'; readonly mode: '0555'; readonly user: 'buildbot'; readonly result: 'passed' }>;
  readonly executionSelfTest: 'passed';
}

export interface BuilderEvidenceCommand {
  readonly argv: readonly string[];
  readonly exitCode: 0;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export interface RustArtifactEvidence {
  readonly target: (typeof RUST_TARGETS)[number];
  readonly standardLibraryPath: string;
  readonly standardLibrarySha256: string;
  readonly standardLibraryArchitecture: string;
  readonly compileArtifact: string;
  readonly compileSha256: string;
  readonly compileArchitecture: string;
  readonly result: 'passed';
}

export interface BuilderSourceMetadata {
  readonly baseImage: string;
  readonly baseImageDigest: string;
  readonly dockerfileSha256: string;
  readonly executionDefinitionSha256: string;
  readonly packageSet: readonly string[];
  readonly rustConfig: RustToolchainConfig;
  readonly nodeVersion: string;
  readonly architecture: 'linux/amd64';
  readonly packageSource: string;
}

export interface DockerCapability {
  readonly available: boolean;
  readonly mutation: 'none' | 'probe';
  readonly clientVersion: string | null;
  readonly serverVersion: string | null;
  readonly architecture: string | null;
  readonly code: 'OK' | 'DOCKER_UNAVAILABLE';
}

export interface DockerImageValidationOptions {
  readonly executable?: string;
  readonly run?: (argv: readonly string[], options?: { readonly timeout: number; readonly maxBuffer: number; readonly env: Readonly<Record<string, string>> }) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validationEvidenceSha256(value: BuilderValidationEvidence): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function jsonDigest(path: string, contents: string): string {
  try { JSON.parse(contents); } catch { throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', `${path} is not valid JSON`); }
  return sha256(contents);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function dockerfileLogicalInstructions(contents: string): readonly string[] {
  const uncommentedPhysicalLines = contents
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return uncommentedPhysicalLines
    .replace(/\\\r?\n[ \t]*/gu, ' ')
    .split(/\r?\n/u)
    .map((instruction) => instruction.trim());
}

function normalizedDockerfileInstructions(contents: string): readonly string[] {
  return dockerfileLogicalInstructions(contents)
    .filter((instruction) => instruction.length > 0)
    .map((instruction) => instruction.replace(/[ \t]+/gu, ' ').trim());
}

const CANONICAL_POST_NPM_INSTRUCTIONS = Object.freeze([
  'COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-tool.js /opt/osi-image-builder/operations/osi-image-builder-tool.js',
  'COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-module-probe.js /opt/osi-image-builder/operations/osi-image-builder-module-probe.js',
  'COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-exec-guard.js /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js',
  'COPY --chown=root:root --chmod=0555 builder/operations/osi-dependency-egress-proxy.cjs /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs',
  'COPY --chown=root:root --chmod=0555 builder/operations/osi-proxy-credential-environment.cjs /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs',
  'COPY --chown=root:root --chmod=0444 builder/operations/osi-wgetrc /opt/osi-image-builder/operations/osi-wgetrc',
  `RUN test -f /opt/osi-image-builder/operations/osi-image-builder-tool.js && test -f /opt/osi-image-builder/operations/osi-image-builder-module-probe.js && test -f /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js && test -f /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs && test -f /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs && test -f /opt/osi-image-builder/operations/osi-wgetrc && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-tool.js)" = '0:0' && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-module-probe.js)" = '0:0' && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js)" = '0:0' && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs)" = '0:0' && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs)" = '0:0' && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-wgetrc)" = '0:0' && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-tool.js)" = '555' && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-module-probe.js)" = '555' && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js)" = '555' && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs)" = '555' && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs)" = '555' && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-wgetrc)" = '444'`,
  'RUN useradd --create-home --shell /bin/bash --user-group buildbot && chown --recursive buildbot:buildbot /workdir',
  'USER buildbot',
] as const);

function npmInstallCommands(contents: string): readonly string[] | null {
  const logicalInstructions = dockerfileLogicalInstructions(contents);
  const candidates = logicalInstructions.filter((instruction) => instruction.startsWith('RUN ') && instruction.includes('npm-${NPM_VERSION}.tgz'));
  if (candidates.length !== 1) return null;
  return candidates[0]!
    .slice('RUN '.length)
    .split(/\s+&&\s+/u)
    .map((command) => command.replace(/[ \t]+/gu, ' ').trim());
}

function hasPinnedNpmInstallSequence(contents: string): boolean {
  const commands = npmInstallCommands(contents);
  const expected = [
    'curl --fail --silent --show-error --location --retry 3 "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz" --output /tmp/npm.tgz',
    `printf '%s %s\\n' "\${NPM_TARBALL_SHA256}" /tmp/npm.tgz | sha256sum --check --status`,
    'rm -rf /usr/local/lib/node_modules/npm',
    'mkdir -p /usr/local/lib/node_modules/npm',
    'tar --extract --gzip --file /tmp/npm.tgz --strip-components=1 --directory /usr/local/lib/node_modules/npm',
    'rm -f /tmp/npm.tgz',
    'npm --version | grep -- "^${NPM_VERSION}$"',
  ];
  return commands !== null && JSON.stringify(commands) === JSON.stringify(expected);
}

function hasCanonicalPostNpmSuffix(contents: string): boolean {
  const instructions = normalizedDockerfileInstructions(contents);
  const pinnedIndices = instructions
    .map((instruction, index) => instruction.startsWith('RUN ') && instruction.includes('npm-${NPM_VERSION}.tgz') ? index : -1)
    .filter((index) => index >= 0);
  if (pinnedIndices.length !== 1) return false;
  return JSON.stringify(instructions.slice(pinnedIndices[0]! + 1)) === JSON.stringify(CANONICAL_POST_NPM_INSTRUCTIONS);
}

function completeEvidence(evidence: BuilderValidationEvidence, expectedPackages: readonly string[], lock?: BuilderLock): void {
  if (!evidence || evidence.executionSelfTest !== 'passed' || !IMAGE_ID.test(evidence.imageId) || !DIGEST.test(evidence.imageDigest) || /^0+$/u.test(evidence.imageDigest) || evidence.architecture !== 'linux/amd64') throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence is incomplete or unbound');
  if (!evidence.operationTool || evidence.operationTool.path !== '/opt/osi-image-builder/operations/osi-image-builder-tool.js' || evidence.operationTool.owner !== '0:0' || evidence.operationTool.mode !== '0555' || evidence.operationTool.user !== 'buildbot' || evidence.operationTool.result !== 'passed') throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Trusted operation tool evidence is incomplete');
  if (lock !== undefined && (evidence.imageDigest !== lock.imageDigest || (lock.imageId !== undefined && evidence.imageId !== `sha256:${lock.imageId}`))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence is bound to a different image');
  if (!evidence.executionGuard || evidence.executionGuard.path !== '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js' || evidence.executionGuard.owner !== '0:0' || evidence.executionGuard.mode !== '0555' || evidence.executionGuard.user !== 'buildbot' || evidence.executionGuard.result !== 'passed') throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Execution guard evidence is incomplete');
  if (!/^rustc\s+\d+\.\d+\.\d+/u.test(evidence.rustc) || !/^\d+\.\d+\.\d+/u.test(evidence.llvm) || !/^(?:\d+:)?\d+\.\d+\.\d+/u.test(evidence.polly) || !/^\d+\.\d+/u.test(evidence.zstd) || evidence.node !== `v${PINNED_NODE_VERSION}` || evidence.npm !== PINNED_NPM_VERSION) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Toolchain version evidence is not the pinned compatible identity');
  if (!Array.isArray(evidence.packages) || [...expectedPackages, ...BUILDER_VALIDATION_PACKAGE_NAMES].some((pkg) => !evidence.packages.includes(pkg))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence omits required packages');
  const evidencePackageKeys = [...new Set([...expectedPackages, ...BUILDER_VALIDATION_PACKAGE_NAMES, ...TARGET_PACKAGE_NAMES])];
  if (!evidence.packageVersions || !exactKeys(evidence.packageVersions, evidencePackageKeys) || Object.entries(evidence.packageVersions).some(([name, version]) => !evidencePackageKeys.includes(name) || typeof version !== 'string' || (!/^complete-host-tool-set$/u.test(version) && !/^[0-9][A-Za-z0-9.+:~_-]*$/u.test(version)))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Package version evidence is incomplete');
  if (!Array.isArray(evidence.commands) || evidence.commands.length < expectedPackages.length || evidence.commands.some((command) => !exactKeys(command, ['argv', 'exitCode', 'stdoutSha256', 'stderrSha256']) || command.exitCode !== 0 || !Array.isArray(command.argv) || command.argv.length === 0 || !command.argv.every((part: unknown) => typeof part === 'string' && part.length > 0) || !DIGEST.test(command.stdoutSha256) || !DIGEST.test(command.stderrSha256))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Command evidence is incomplete');
  const commandText = evidence.commands.map((command) => command.argv.join('\u0000')).join('\u0001');
  if (!commandText.includes('/usr/bin/llvm-config') || !commandText.includes('/usr/bin/rustc') || !commandText.includes('rustc --target') || !commandText.includes('pkg-config') || !commandText.includes('file -b') || !commandText.includes('ar ')) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Evidence does not prove the supported system LLVM/Rust dependency path');
  const targetSet = new Set(evidence.rustTargets?.map((target) => target.target));
  const architectureMatches = (target: RustArtifactEvidence): boolean => {
    const pattern = target.target === 'x86_64-unknown-linux-gnu' ? /x86-64/iu : target.target === 'aarch64-unknown-linux-musl' ? /aarch64/iu : /ARM/iu;
    return pattern.test(target.standardLibraryArchitecture) && pattern.test(target.compileArchitecture);
  };
  if (!Array.isArray(evidence.rustTargets) || targetSet.size !== RUST_TARGETS.length || RUST_TARGETS.some((target) => !targetSet.has(target)) || evidence.rustTargets.some((target) => !/^\/tmp\/osi-rust-validation\//u.test(target.compileArtifact) || !/^\/opt\/rust-system\/toolchains\//u.test(target.standardLibraryPath) || target.result !== 'passed' || !DIGEST.test(target.standardLibrarySha256) || !DIGEST.test(target.compileSha256) || typeof target.standardLibraryArchitecture !== 'string' || typeof target.compileArchitecture !== 'string' || !architectureMatches(target))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Rust target artifacts are incomplete or have the wrong machine architecture');
  if (/rust-ci-llvm/iu.test(JSON.stringify(evidence))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Rust CI LLVM artifacts are not accepted');
}

function dockerfileMetadata(contents: string): BuilderSourceMetadata {
  const base = contents.match(BASE_IMAGE);
  if (!base) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile has no digest-pinned base image');
  const baseName = base[1]!.slice(0, base[1]!.lastIndexOf('@'));
  if (baseName.includes(':')) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Mutable base tags are not accepted');
  if (!/ARG DEBIAN_SNAPSHOT=20260715T000000Z/u.test(contents) || !/snapshot\.debian\.org\/archive\/debian\/\$\{DEBIAN_SNAPSHOT\}/u.test(contents) || /(?:deb|security)\.debian\.org/u.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile package source is not the immutable Debian snapshot');
  if (!/ARG RUST_SOURCE_SHA256=2f4f3142ffb7c8402139cfa0796e24baaac8b9fd3f96b2deec3b94b4045c6a8a/u.test(contents) || !/static\.rust-lang\.org\/dist\/rustc-\$\{RUST_SOURCE_VERSION\}-src\.tar\.gz/u.test(contents) || !/jobs\s*=\s*2/u.test(contents) || !/download-ci-llvm\s*=\s*false/u.test(contents) || !/llvm-config\s*=\s*"\/usr\/bin\/llvm-config"/u.test(contents) || /rustup/iu.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile Rust compiler source is not system-LLVM configured');
  if (!/^ARG BUILDER_PLATFORM=linux\/amd64\s+FROM\s+--platform=\$\{BUILDER_PLATFORM\}/mu.test(contents) || /^FROM\s+--platform=linux\/amd64/mu.test(contents) || !/ARG NODE_ARCH=linux-x64/u.test(contents) || !new RegExp(`ARG NODE_VERSION=${PINNED_NODE_VERSION}(?:\\s|$)`, 'u').test(contents) || !/node-v\$\{NODE_VERSION\}-\$\{NODE_ARCH\}\.tar\.xz/u.test(contents) || !contents.includes(`ARG NODE_TARBALL_SHA256=${PINNED_NODE_TARBALL_SHA256}`) || !new RegExp(`ARG NPM_VERSION=${PINNED_NPM_VERSION}(?:\\s|$)`, 'u').test(contents) || !contents.includes(`ARG NPM_TARBALL_SHA256=${PINNED_NPM_TARBALL_SHA256}`) || !hasPinnedNpmInstallSequence(contents) || !hasCanonicalPostNpmSuffix(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile architecture, Node, npm archive pin, or post-install suffix is invalid');
  if (!/^ENV PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/mu.test(contents) || /^ENV\s+(?!PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$)/mu.test(contents) || /^(?:ENV|ARG)\s+(?:CARGO_HOME|DEBIAN_FRONTEND|CARGO_BUILD_JOBS|RUST_TARGETS)=/mu.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile runtime environment contains build-only values');
  const node = contents.match(NODE_VERSION)?.[1];
  const llvmMajor = Number(contents.match(/LLVM_MAJOR=(\d+)/u)?.[1] ?? contents.match(POLLY_PACKAGE)?.[1] ?? '0');
  const pollyMajor = Number(contents.match(POLLY_PACKAGE)?.[1] ?? '0');
  if (!node || Number.parseInt(node, 10) < 22) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile must contain Node >= 22');
  if (!Number.isInteger(llvmMajor) || llvmMajor < 1 || pollyMajor !== llvmMajor || !/\bllvm-dev\b/u.test(contents) || !/\blibzstd-dev\b/u.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile LLVM, Polly, or Zstd packages are incomplete');
  const rustConfig = { llvmConfig: contents.match(/llvm-config\s*=\s*"([^"]+)"/u)?.[1], channel: contents.match(/RUST_CHANNEL=([^\s\\]+)/u)?.[1], version: contents.match(/RUST_VERSION=([^\s\\]+)/u)?.[1], llvmMajor };
  const rust = validateRustToolchain(rustConfig);
  if (!rust.ok || /rust-ci-llvm/iu.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile Rust LLVM configuration is unsupported');
  const packages = supportedPackageTokens(contents);
  const packageSet = ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', `libpolly-${llvmMajor}-dev`, 'libzstd-dev'] as const;
  if (!packages.includes('gcc-14') || !packages.includes('g++-14') || !packages.includes('clang') || !packages.includes('git') || !packages.includes('sqlite3') || !/apt-get download "musl:arm64=\$\{MUSL_VERSION\}" "musl-dev:arm64=\$\{MUSL_VERSION\}" "musl:armhf=\$\{MUSL_VERSION\}" "musl-dev:armhf=\$\{MUSL_VERSION\}"/u.test(contents) || !/ARG MUSL_ARM64_SHA256=[0-9a-f]{64}/u.test(contents) || !/ARG MUSL_DEV_ARM64_SHA256=[0-9a-f]{64}/u.test(contents) || !/ARG MUSL_ARMHF_SHA256=[0-9a-f]{64}/u.test(contents) || !/ARG MUSL_DEV_ARMHF_SHA256=[0-9a-f]{64}/u.test(contents) || !/musl-libdir\s*=\s*"\/opt\/target-sysroots\/aarch64\/usr\/lib\/aarch64-linux-musl"/u.test(contents) || !/musl-libdir\s*=\s*"\/opt\/target-sysroots\/armv7\/usr\/lib\/arm-linux-musleabihf"/u.test(contents) || !/--sysroot=\/opt\/target-sysroots\/aarch64/u.test(contents) || !/--sysroot=\/opt\/target-sysroots\/armv7/u.test(contents) || !/\/opt\/target-sysroots\/aarch64\/usr\/include\/aarch64-linux-musl/u.test(contents) || !/\/opt\/target-sysroots\/armv7\/usr\/include\/arm-linux-musleabihf/u.test(contents) || /__clang_major__=0/u.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile lacks complete target musl toolchains');
  if (
    !/^COPY --chown=root:root --chmod=0555 builder\/operations\/osi-image-builder-tool\.js \/opt\/osi-image-builder\/operations\/osi-image-builder-tool\.js$/mu.test(contents)
    || !/^COPY --chown=root:root --chmod=0555 builder\/operations\/osi-image-builder-module-probe\.js \/opt\/osi-image-builder\/operations\/osi-image-builder-module-probe\.js$/mu.test(contents)
    || !/^COPY --chown=root:root --chmod=0555 builder\/operations\/osi-image-builder-exec-guard\.js \/opt\/osi-image-builder\/operations\/osi-image-builder-exec-guard\.js$/mu.test(contents)
    || !/^COPY --chown=root:root --chmod=0555 builder\/operations\/osi-dependency-egress-proxy\.cjs \/opt\/osi-image-builder\/operations\/osi-dependency-egress-proxy\.cjs$/mu.test(contents)
    || !/^COPY --chown=root:root --chmod=0555 builder\/operations\/osi-proxy-credential-environment\.cjs \/opt\/osi-image-builder\/operations\/osi-proxy-credential-environment\.cjs$/mu.test(contents)
    || !/^COPY --chown=root:root --chmod=0444 builder\/operations\/osi-wgetrc \/opt\/osi-image-builder\/operations\/osi-wgetrc$/mu.test(contents)
    || !/stat -c '%u:%g'.*osi-image-builder-tool\.js.*0:0/u.test(contents)
    || !/stat -c '%u:%g'.*osi-image-builder-module-probe\.js.*0:0/u.test(contents)
    || !/stat -c '%u:%g'.*osi-image-builder-exec-guard\.js.*0:0/u.test(contents)
    || !/stat -c '%u:%g'.*osi-dependency-egress-proxy\.cjs.*0:0/u.test(contents)
    || !/stat -c '%u:%g'.*osi-proxy-credential-environment\.cjs.*0:0/u.test(contents)
    || !/stat -c '%u:%g'.*osi-wgetrc.*0:0/u.test(contents)
    || !/stat -c '%a'.*osi-image-builder-tool\.js.*555/u.test(contents)
    || !/stat -c '%a'.*osi-image-builder-module-probe\.js.*555/u.test(contents)
    || !/stat -c '%a'.*osi-image-builder-exec-guard\.js.*555/u.test(contents)
    || !/stat -c '%a'.*osi-dependency-egress-proxy\.cjs.*555/u.test(contents)
    || !/stat -c '%a'.*osi-proxy-credential-environment\.cjs.*555/u.test(contents)
    || !/stat -c '%a'.*osi-wgetrc.*444/u.test(contents)
  ) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile does not bake the immutable trusted operation tool and module probe');
  return { baseImage: base[1]!, baseImageDigest: base[2]!, dockerfileSha256: sha256(contents), executionDefinitionSha256: '', packageSet, rustConfig: rust.config, nodeVersion: node, architecture: 'linux/amd64', packageSource: 'snapshot.debian.org/archive/debian/20260715T000000Z' };
}

export function validateTrustedOperationToolSource(contents: string): void {
  if (!contents.startsWith('#!/usr/bin/env node\n')
    || !contents.includes("new Set(['activate-target', 'copy-feed-config', 'update-feeds', 'verify-image', 'mirror-gui'])")
    || !contents.includes('args.length !== 1')
    || !contents.includes('feedSource')
    || !contents.includes('guiSource')
    || !contents.includes('imageDirectory')
    || !contents.includes("const INSTALLED_NODE_BINARY = '/usr/local/bin/node';")
    || !contents.includes("'/opt/osi-image-builder/operations/osi-image-builder-module-probe.js';")
    || !contents.includes("    '--permission',")
    || !contents.includes("    '--experimental-vm-modules',")
    || !contents.includes('`--allow-fs-read=${dependencies.probeProgram}`')
    || !contents.includes('`--allow-fs-read=${nodeRed}`')
    || !contents.includes('for (let packageIndex = 0; packageIndex < NODE_MODULES.length; packageIndex += 1)')
    || !contents.includes('const [packageName, specifier] = NODE_MODULES[packageIndex];')
    || !contents.includes('const execution = spawn(dependencies.nodeBinary, args, {')
    || !contents.includes("const FORWARDED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);")
    || !contents.includes('signalSource.kill(-child.pid, signal)')
    || !contents.includes('finally { signalForwarder.close(); }')
    || !contents.includes('detached: true')
    || !contents.includes("const UPDATE_FEEDS_PATH = '/proc/self/fd/3/scripts/feeds';")
    || !contents.includes("const UPDATE_FEEDS_TOPDIR = '/proc/self/fd/3';")
    || !contents.includes("stdio: ['inherit', 'inherit', 'inherit', activeConfig.directory]")
    || !contents.includes('fstatSync(activeConfig.directory)')
    || !contents.includes('assertNamedOpenWrtDirectory(activeConfig)')
    || !contents.includes("throw new AggregateError(anomalies, 'active OpenWrt config restoration encountered anomalies')")
    || !contents.includes("'--package-index',")
    || !contents.includes('String(packageIndex)')
    || !contents.includes('timeout: MODULE_PROBE_TIMEOUT_MS')
    || !contents.includes('const MODULE_PROBE_TIMEOUT_MS = 15_000;')
    || !contents.includes("killSignal: 'SIGKILL'")
    || !contents.includes('maxBuffer: 8 * 1024 * 1024')
    || !contents.includes('results.push(result)')
    || !contents.includes('const text = stdout.slice(0, -1);')
    || !contents.includes('parsed = JSON.parse(text);')
    || !contents.includes('Object.keys(parsed).join(\'\\0\')\n        !== \'packageIndex\\0packageName\\0specifier\\0resolvedRelativePath\\0exportType\'')
    || !contents.includes('stdout.indexOf(\'\\n\') !== stdout.length - 1')
    || !contents.includes('parsed.resolvedRelativePath.split(\'/\').includes(\'..\')')
    || !contents.includes('const { packageIndex: _packageIndex, ...result } = parsed;')
    || !contents.includes('shell: false')
    || !contents.includes("cwd: '/'")
    || !contents.includes("NODE_MODULES[packageIndex]")
    || contents.includes('--allow-fs-write')
    || contents.includes('--allow-child-process')
    || contents.includes('--allow-worker')
    || contents.includes('--allow-wasi')
    || contents.includes('--allow-addons')
    || contents.includes('process.argv.slice(2).join')
    || /(?:process\.env\.)?NODE_PATH\s*=/u.test(contents)) {
    throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'trusted operation tool is not a fixed permission-probe launcher');
  }
  if (sha256(contents) !== TRUSTED_OPERATION_TOOL_SHA256) {
    throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'trusted operation tool source digest changed');
  }
}

export function validateTrustedExecutionGuardSource(contents: string): void {
  if (!contents.startsWith('#!/usr/bin/env node\n')
    || !contents.includes("const WORKTREE = '/workdir';")
    || !contents.includes("const TOOL = '/opt/osi-image-builder/operations/osi-image-builder-tool.js';")
    || !contents.includes("const PROXY_CREDENTIAL_PATH = '/run/osi-image-builder/proxy-credential';")
    || !contents.includes("createRequire(import.meta.url)('./osi-proxy-credential-environment.cjs')")
    || !contents.includes('authenticatedProxyEnvironment(process.env, readProxyCredential)')
    || !contents.includes("readFileSync(path, 'utf8')")
    || !contents.includes('(stats.mode & 0o777) !== 0o400')
    || !contents.includes("lstatSync(WORKTREE, { bigint: true })")
    || !contents.includes('stats.dev !== identity.workspaceDev')
    || !contents.includes('stats.ino !== identity.workspaceIno')
    || !contents.includes('const LINK_SPECS = Object.freeze([')
    || !contents.includes('readlinkSync(path) !== expected')
    || !contents.includes('spawn(parsed.operationArgv[0], parsed.operationArgv.slice(1)')
    || !contents.includes('shell: false')
    || !contents.includes("stdio: 'inherit'")
    || !contents.includes("process.cwd() !== parsed.workingDirectory")
    || !contents.includes("import { constants as osConstants } from 'node:os';")
    || !contents.includes("const FORWARDED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);")
    || !contents.includes('process.on(signal, listener)')
    || !contents.includes('process.off(name, listener)')
    || !contents.includes('process.kill(-child.pid, signal)')
    || !contents.includes('detached: true')
    || !contents.includes("child.once('close', (status, signal) =>")
    || !contents.includes('process.exitCode = signalExitCode(child.requestedSignal)')
    || !contents.includes('const signalNumber = osConstants.signals[signal];')
    || !contents.includes('Number.isInteger(signalNumber)')
    || !contents.includes('128 + signalNumber : 255')
    || contents.includes('exec(')) {
    throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'execution guard is not a fixed descriptor identity and link attestation wrapper');
  }
  if (sha256(contents) !== TRUSTED_EXECUTION_GUARD_SHA256) {
    throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'execution guard source digest changed');
  }
}

export function validateTrustedDependencyProxySource(contents: string): void {
  if (
    !contents.startsWith("'use strict';\n")
    || !contents.includes("const { BlockList, isIP } = require('node:net');")
    || !contents.includes("const { timingSafeEqual } = require('node:crypto');")
    || !contents.includes('function parseTlsClientHelloServerName(value)')
    || !contents.includes('function createDependencyProxyServer(options)')
    || !contents.includes('validProxyAuthorization')
    || !contents.includes('resolveDependencyDestination')
    || sha256(contents) !== TRUSTED_DEPENDENCY_PROXY_SHA256
  ) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'trusted dependency proxy source digest changed');
}

export function validateTrustedProxyCredentialEnvironmentSource(contents: string): void {
  if (
    !contents.startsWith("'use strict';\n")
    || !contents.includes('function authenticatedProxyEnvironment(environment, readCredential)')
    || !contents.includes("delete child.OSI_EGRESS_PROXY_CREDENTIAL_FILE")
    || sha256(contents) !== TRUSTED_PROXY_CREDENTIAL_ENV_SHA256
  ) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'trusted proxy credential environment source digest changed');
}

export function validateTrustedWgetConfigSource(contents: string): void {
  if (
    contents !== 'ca_certificate = /run/osi-image-builder/ca.pem\ncheck_certificate = on\n'
    || sha256(contents) !== TRUSTED_WGET_CONFIG_SHA256
  ) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'trusted wget CA configuration source digest changed');
}

export function validateTrustedModuleProbeSource(contents: string): void {
  const builtinClosure = [
    'buffer',
    'crypto',
    'dns',
    'events',
    'fs',
    'http',
    'http2',
    'https',
    'net',
    'node:child_process',
    'node:crypto',
    'node:fs',
    'os',
    'path',
    'process',
    'stream',
    'tls',
    'url',
    'util',
    'zlib',
  ];
  const exactBuiltinClosure = [
    'const ALLOWED_ROOTFS_BUILTINS = Object.freeze([',
    ...builtinClosure.map((name) => `  '${name}',`),
    ']);',
  ].join('\n');
  const exactDynamicImportRestriction = `let firstDynamicImportViolation = null;

function recordDynamicImportViolation(specifier) {
  const violation = new ORIGINAL_ERROR(
    \`rootfs Node module requested an unapproved builder ESM builtin: \${specifier}\`,
  );
  if (firstDynamicImportViolation === null) firstDynamicImportViolation = violation;
  return violation;
}`;
  if (!contents.startsWith('#!/usr/bin/env node\n')
    || !contents.includes("args.length !== 4")
    || !contents.includes("args[0] !== '--rootfs-node-red'")
    || !contents.includes("args[2] !== '--package-index'")
    || !contents.includes('NODE_MODULES[packageIndex]')
    || !contents.includes("NATIVE_DEPENDENCY_STUBS.sqlite3 = Object.freeze({\n  packageName: 'osi-db-helper'")
    || !contents.includes(exactBuiltinClosure)
    || !contents.includes('const ROOTFS_FILESYSTEM_CAPABILITY = Object.freeze(new Proxy(')
    || !contents.includes("  if (request === 'fs' || request === 'node:fs') {\n    return ROOTFS_FILESYSTEM_CAPABILITY;\n  }")
    || !contents.includes("BUILTIN_CAPABILITY_STUBS['node:child_process'] = Object.freeze({\n  packageName: 'osi-health-helper',\n  parentRelativePath: 'osi-health-helper/index.js'")
    || !contents.includes('return builtinStub.value;')
    || !contents.includes("'@chirpstack/chirpstack-api/api/application_grpc_pb',")
    || !contents.includes("seal(Module, '_resolveFilename', sealedResolveFilename, 'Module._resolveFilename');")
    || !contents.includes("seal(Module, '_load', sealedLoad, 'Module._load');")
    || !contents.includes("    '--permission',")
    || !contents.includes('`--allow-fs-read=${PROBE_PROGRAM}`')
    || !contents.includes('`--allow-fs-read=${nodeRed}`')
    || !contents.includes("    '--experimental-vm-modules',")
    || !contents.includes("process.permission.has('fs.write')")
    || !contents.includes("process.permission.has('child')")
    || !contents.includes("process.permission.has('worker')")
    || !contents.includes("process.permission.has('wasi')")
    || !contents.includes("process.permission.has('addons')")
    || !contents.includes('const ORIGINAL_GET_BUILTIN_MODULE = process.getBuiltinModule.bind(process);')
    || !contents.includes('function sealedGetBuiltinModule(request)')
    || !contents.includes('Object.freeze(sealedGetBuiltinModule);')
    || !contents.includes("function sealProcessBuiltinAccess()")
    || !contents.includes("Object.defineProperty(process, 'getBuiltinModule', {")
    || !contents.includes("  Object.defineProperty(process, 'getBuiltinModule', {\n    value: sealedGetBuiltinModule,\n    writable: false,\n    enumerable: true,\n    configurable: false,\n  });")
    || !contents.includes("Object.defineProperty(process, 'exit', {")
    || !contents.includes('writable: false')
    || !contents.includes('configurable: false')
    || !contents.includes("import Module, { createRequire, isBuiltin } from 'node:module';")
    || !contents.includes("import { createHook } from 'node:async_hooks';")
    || !contents.includes("import { runInThisContext } from 'node:vm';")
    || !contents.includes('const ORIGINAL_MODULE_WRAP = Module.wrap;')
    || !contents.includes(exactDynamicImportRestriction)
    || !contents.includes('const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);')
    || !contents.includes('const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);')
    || !contents.includes('const ORIGINAL_PROCESS_EXIT = process.exit.bind(process);')
    || !contents.includes('const ORIGINAL_ERROR = Error;')
    || !contents.includes('const ORIGINAL_PROMISE = Promise;')
    || !contents.includes('const ORIGINAL_PROMISE_REJECT = ORIGINAL_PROMISE.reject.bind(ORIGINAL_PROMISE);')
    || !contents.includes('const ORIGINAL_ARRAY_INCLUDES = Function.call.bind(Array.prototype.includes);')
    || !contents.includes('const ORIGINAL_ARRAY_IS_ARRAY = Array.isArray.bind(Array);')
    || !contents.includes('const ORIGINAL_STRING_REPLACE_ALL = Function.call.bind(String.prototype.replaceAll);')
    || !contents.includes('const ORIGINAL_STRING_STARTS_WITH = Function.call.bind(String.prototype.startsWith);')
    || !contents.includes('const ORIGINAL_REFLECT_APPLY = Reflect.apply.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_DEFINE_PROPERTY = Reflect.defineProperty.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_DELETE_PROPERTY = Reflect.deleteProperty.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_GET_OWN_PROPERTY_DESCRIPTOR = Reflect.getOwnPropertyDescriptor.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_GET_PROTOTYPE_OF = Reflect.getPrototypeOf.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_GET = Reflect.get.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_HAS = Reflect.has.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_IS_EXTENSIBLE = Reflect.isExtensible.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_OWN_KEYS = Reflect.ownKeys.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_PREVENT_EXTENSIONS = Reflect.preventExtensions.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_SET = Reflect.set.bind(Reflect);')
    || !contents.includes('const ORIGINAL_REFLECT_SET_PROTOTYPE_OF = Reflect.setPrototypeOf.bind(Reflect);')
    || !contents.includes('const ORIGINAL_MAP_DELETE = Function.call.bind(Map.prototype.delete);')
    || !contents.includes('const ORIGINAL_MAP_ENTRIES = Function.call.bind(Map.prototype.entries);')
    || !contents.includes('const ORIGINAL_MAP_SET = Function.call.bind(Map.prototype.set);')
    || !contents.includes('const ORIGINAL_MAP_ITERATOR_NEXT = Function.call.bind(')
    || !contents.includes('Object.getPrototypeOf(new Map().entries()).next,')
    || !contents.includes('const ORIGINAL_CREATE_ASYNC_HOOK = createHook.bind(null);')
    || !contents.includes('const ORIGINAL_JSON_STRINGIFY = JSON.stringify.bind(JSON);')
    || !contents.includes('const ORIGINAL_OBJECT_CREATE = Object.create.bind(Object);')
    || !contents.includes('const ORIGINAL_OBJECT_DEFINE_PROPERTY = Object.defineProperty.bind(Object);')
    || !contents.includes('const ORIGINAL_OBJECT_HAS_OWN = Object.hasOwn.bind(Object);')
    || !contents.includes('const ORIGINAL_OBJECT_FREEZE = Object.freeze.bind(Object);')
    || !contents.includes('const ORIGINAL_BUFFER_BYTE_LENGTH = Buffer.byteLength.bind(Buffer);')
    || !contents.includes('const MAX_OUTPUT_BYTES = 1024 * 1024;')
    || !contents.includes('return ORIGINAL_PROMISE_REJECT(recordDynamicImportViolation(specifier));')
    || !contents.includes('function installRootfsLoader(')
    || !contents.includes('const BUILTIN_CAPABILITY_STUBS = ORIGINAL_OBJECT_CREATE(null);')
    || !contents.includes('const NATIVE_DEPENDENCY_STUBS = ORIGINAL_OBJECT_CREATE(null);')
    || !contents.includes('Object.freeze(BUILTIN_CAPABILITY_STUBS);')
    || !contents.includes('Object.freeze(NATIVE_DEPENDENCY_STUBS);')
    || !contents.includes('const nativeStub = ORIGINAL_OBJECT_HAS_OWN(NATIVE_DEPENDENCY_STUBS, request)')
    || !contents.includes('const builtinStub = ORIGINAL_OBJECT_HAS_OWN(BUILTIN_CAPABILITY_STUBS, request)')
    || !contents.includes('let loaderAccessDepth = 0;')
    || !contents.includes('function withTrustedLoaderAccess(operation)')
    || !contents.includes('function createRestrictedLoaderCache(realCache, label)')
    || !contents.includes("const moduleCache = createRestrictedLoaderCache(realModuleCache, 'Module._cache');")
    || !contents.includes("const modulePathCache = createRestrictedLoaderCache(realModulePathCache, 'Module._pathCache');")
    || !contents.includes("seal(Module, '_cache', moduleCache, 'Module._cache');")
    || !contents.includes("seal(Module, '_pathCache', modulePathCache, 'Module._pathCache');")
    || !contents.includes('const moduleFacade = ORIGINAL_OBJECT_CREATE(null);')
    || !contents.includes("['constructor', null]")
    || !contents.includes("['prototype', null]")
    || !contents.includes('const requireEntry = createRequire(filename);')
    || !contents.includes('rootfs require requests must be primitive strings')
    || !contents.includes('rootfs require.resolve requests must be primitive strings')
    || !contents.includes('rootfs require.resolve options are not supported')
    || !contents.includes('ORIGINAL_OBJECT_FREEZE(localRequire);')
    || !contents.includes('loaderAccessDepth = 0;')
    || !contents.includes('const TRUSTED_REAL_BUILTINS_TO_WARM = Object.freeze([')
    || !contents.includes('for (const builtin of TRUSTED_REAL_BUILTINS_TO_WARM) ORIGINAL_GET_BUILTIN_MODULE(builtin);')
    || !contents.includes('let firstDynamicImportViolation = null;')
    || !contents.includes('const violation = new ORIGINAL_ERROR(')
    || !contents.includes('if (firstDynamicImportViolation === null) firstDynamicImportViolation = violation;')
    || !contents.includes('if (firstDynamicImportViolation !== null)')
    || !contents.includes("seal(Module.prototype, '_compile', sealedCompile, 'Module.prototype._compile');")
    || !contents.includes("seal(Module.prototype, 'require', originalRequire, 'Module.prototype.require');")
    || !contents.includes("seal(Module, '_extensions', extensionSurface, 'Module._extensions');")
    || !contents.includes("const javascriptExtension = Object.getOwnPropertyDescriptor(extensionSurface, '.js');")
    || !contents.includes('for (const [property, label] of [')
    || !contents.includes("['wrapper', 'Module.wrapper']")
    || !contents.includes("['builtinModules', 'Module.builtinModules']")
    || !contents.includes("['globalPaths', 'Module.globalPaths']")
    || !contents.includes('Object.freeze(Module.prototype);')
    || !contents.includes('Object.freeze(Module);')
    || !contents.includes('const pendingResources = new Map();')
    || !contents.includes('function observeSynchronousModuleLoad(load)')
    || !contents.includes('promiseResolve(asyncId)')
    || !contents.includes('return { exported: load(), firstPendingResource };')
    || !contents.includes('hook.enable();')
    || !contents.includes('hook.disable();')
    || !contents.includes('const record = ORIGINAL_OBJECT_CREATE(null);')
    || !contents.includes('function createSuccessRecord(')
    || !contents.includes('const serialized = ORIGINAL_JSON_STRINGIFY(record);')
    || !contents.includes('ORIGINAL_BUFFER_BYTE_LENGTH(serialized)')
    || !contents.includes('write(output, () => ORIGINAL_PROCESS_EXIT(code));')
    || !contents.includes('function flushAndExit(record, code)')
    || !contents.includes('write(output, () => ORIGINAL_PROCESS_EXIT(code));')
    || contents.includes('snapshotModuleLoaderState')
    || contents.includes('restoreModuleLoaderState')
    || contents.includes('installAsyncSchedulingGuards')
    || contents.includes('--allow-fs-write')
    || contents.includes('--allow-child-process')
    || contents.includes('--allow-worker')
    || contents.includes('--allow-wasi')
    || contents.includes('--allow-addons')
    || contents.includes('async function probePackage(')
    || contents.includes('async function main(')
    || /Reflect\.(?:apply|get|has)\(/u.test(contents)
    || contents.includes('process.argv.slice(2).join')
    || /(?:process\.env\.)?NODE_PATH\s*=/u.test(contents)) {
    throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'trusted module probe is not a read-only, fail-closed implementation');
  }
  if (sha256(contents) !== TRUSTED_MODULE_PROBE_SHA256) {
    throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'trusted module probe source digest changed');
  }
}

export function validateExecutionDefinition(value: unknown, imageTemplate = '{{imageRepository}}@sha256:{{imageDigest}}'): void {
  const fail = (message: string): never => { throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Execution definition must be an object');
  const record = value as Record<string, unknown>;
  const expectedTop = ['architecture', 'environment', 'image', 'mount', 'network', 'networkPolicy', 'offlineOperationIds', 'operationIds', 'readOnlyOperationIds', 'runtime', 'schemaVersion', 'security', 'user', 'workdir'];
  if (!exactKeys(record, expectedTop)) fail('Execution definition contains unknown or missing top-level fields');
  if (record.schemaVersion !== 1 || record.runtime !== 'docker' || record.architecture !== 'linux/amd64' || record.user !== '<uid>:<gid>' || record.workdir !== '/workdir' || record.network !== 'internal-authenticated-proxy') fail('Execution definition runtime contract is invalid');
  if (JSON.stringify(record.networkPolicy) !== JSON.stringify({
    offline: 'none',
    dependencyEgress: 'internal-authenticated-proxy',
    proxyPort: 3128,
    allowedPorts: [80, 443],
    credentialPath: '/run/osi-image-builder/proxy-credential',
    operationAllowedHosts: DEPENDENCY_EGRESS_OPERATION_HOSTS,
  })) fail('Execution definition network policy is invalid');
  if (!record.image || typeof record.image !== 'object' || Array.isArray(record.image) || !exactKeys(record.image as object, ['pullPolicy', 'reference']) || (record.image as Record<string, unknown>).pullPolicy !== 'never' || (record.image as Record<string, unknown>).reference !== imageTemplate) fail('Execution definition image contract is invalid');
  const environment = record.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || !exactKeys(environment as object, ['CARGO_BUILD_JOBS', 'HOME', 'PATH', 'SOURCE_DATE_EPOCH', 'TZ']) || JSON.stringify(environment) !== JSON.stringify({ HOME: '/workdir/.builder-home', PATH: IMAGE_PATH, CARGO_BUILD_JOBS: '2', TZ: 'UTC', SOURCE_DATE_EPOCH: '<pinned-commit-time>' })) fail('Execution definition environment is invalid');
  const mount = record.mount;
  if (!mount || typeof mount !== 'object' || Array.isArray(mount) || !exactKeys(mount as object, ['destination', 'readOnly', 'source', 'type']) || JSON.stringify(mount) !== JSON.stringify({ type: 'bind', source: '<job-worktree>', destination: '/workdir', readOnly: false })) fail('Execution definition mount is invalid');
  const security = record.security;
  if (!security || typeof security !== 'object' || Array.isArray(security) || !exactKeys(security as object, ['capAdd', 'capDrop', 'devices', 'noNewPrivileges', 'pidsLimit', 'privileged', 'sockets', 'ulimit']) || JSON.stringify(security) !== JSON.stringify({ capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, pidsLimit: 4096, ulimit: 'nofile=1024:4096' })) fail('Execution definition security is invalid');
  if (!Array.isArray(record.operationIds) || JSON.stringify(record.operationIds) !== JSON.stringify(TRUSTED_OPERATION_IDS)) fail('Execution definition operation IDs are not synchronized with the trusted manifest');
  if (!Array.isArray(record.readOnlyOperationIds) || JSON.stringify(record.readOnlyOperationIds) !== JSON.stringify(READ_ONLY_OPERATION_IDS)) fail('Execution definition read-only operation IDs are invalid');
  if (!Array.isArray(record.offlineOperationIds) || JSON.stringify(record.offlineOperationIds) !== JSON.stringify(OFFLINE_OPERATION_IDS)) fail('Execution definition offline operation IDs are invalid');
}

export function builderImageReference(lock: Pick<BuilderLock, 'imageRepository' | 'imageDigest'>): string {
  if (!DOCKER_REPOSITORY.test(lock.imageRepository) || !SHA256.test(lock.imageDigest) || /^0+$/u.test(lock.imageDigest)) {
    throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'Builder image reference is not immutable');
  }
  return `${lock.imageRepository}@sha256:${lock.imageDigest}`;
}

export function canonicalBuilderImageReference(value: { readonly imageRepository: string; readonly imageDigest: string }): string {
  if (!DOCKER_REPOSITORY.test(value.imageRepository) || !SHA256.test(value.imageDigest) || /^0+$/u.test(value.imageDigest)) {
    throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'Builder image reference is not immutable');
  }
  return builderImageReference(value as BuilderLock);
}

export function parseCanonicalBuilderImageReference(value: string): { readonly imageRepository: string; readonly imageDigest: string } {
  const marker = '@sha256:';
  const markerIndex = value.lastIndexOf(marker);
  const imageRepository = markerIndex > 0 ? value.slice(0, markerIndex) : '';
  const imageDigest = markerIndex > 0 ? value.slice(markerIndex + marker.length) : '';
  if (markerIndex !== value.indexOf(marker) || !DOCKER_REPOSITORY.test(imageRepository) || !DIGEST.test(imageDigest) || /^0+$/u.test(imageDigest)) throw new BuilderValidationError('BUILDER_IMAGE_DIGEST_INVALID', 'Builder image reference must be canonical repository@sha256:digest metadata');
  return { imageRepository, imageDigest };
}

export function selectExactRepositoryDigest(imageReference: string, repoDigests: readonly unknown[]): string {
  const { imageRepository } = parseCanonicalBuilderImageReference(imageReference);
  const prefix = `${imageRepository}@sha256:`;
  const matches = repoDigests.filter((value): value is string => typeof value === 'string' && value.startsWith(prefix) && DIGEST.test(value.slice(prefix.length)));
  if (matches.length !== 1) throw new BuilderValidationError('BUILDER_IMAGE_DIGEST_INVALID', `Expected exactly one RepoDigest for ${imageRepository}, found ${matches.length}`);
  return matches[0]!.slice(matches[0]!.lastIndexOf('@sha256:') + 8);
}

export function validateBuilderDockerfile(contents: string): { readonly ok: true; readonly metadata: BuilderSourceMetadata } | { readonly ok: false; readonly reason: string } {
  try { return { ok: true, metadata: dockerfileMetadata(contents) }; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Dockerfile validation failed' }; }
}

export function validateBuilderLockFile(value: unknown, options: { readonly installedVersion: string }): BuilderLock {
  const result = validateBuilderLock(value, options.installedVersion);
  if (!result.ok) throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', result.reason);
  return result.lock;
}

export interface ProductionBuilderLockValidationOptions {
  readonly dockerfile: string;
  readonly executionDefinitionPath: string;
}

export async function validateProductionBuilderLock(value: unknown, installedVersion: string, options: ProductionBuilderLockValidationOptions): Promise<{ readonly ok: true; readonly lock: BuilderLock } | { readonly ok: false; readonly reason: string }> {
  const domain = validateBuilderLock(value, installedVersion);
  if (!domain.ok) return domain;
  try {
    const lock = domain.lock;
    if (lock.installable !== true) throw new Error('lock is not installable');
    const dockerfileContents = requireRead(options.dockerfile);
    if (sha256(dockerfileContents) !== lock.dockerfileSha256) throw new Error('Dockerfile hash mismatch');
    const definitionContents = requireRead(options.executionDefinitionPath);
    validateExecutionDefinition(JSON.parse(definitionContents), '{{imageRepository}}@sha256:{{imageDigest}}');
    if (sha256(definitionContents) !== lock.executionDefinitionSha256) throw new Error('execution definition hash mismatch');
    const imageReference = canonicalBuilderImageReference(lock);
    const verified = await validateBuiltBuilderImage(imageReference);
    completeEvidence(verified.evidence, lock.packageSet, lock);
    if (validationEvidenceSha256(verified.evidence) !== lock.validationEvidenceSha256) throw new Error('validation evidence hash mismatch');
    return { ok: true, lock };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'builder lock validation failed' };
  }
}

function requireRead(path: string): string {
  return readFileSync(path, 'utf8');
}

export async function validateBuilderSource(options: { readonly dockerfile: string; readonly rootDockerfile: string; readonly executionDefinitionPath: string; readonly evidence: BuilderValidationEvidence }): Promise<BuilderSourceMetadata> {
  try {
    await assertSupportedPackageParity(options.rootDockerfile, options.dockerfile);
    const dockerfileContents = await readFile(options.dockerfile, 'utf8');
    validateTrustedOperationToolSource(await readFile(join(dirname(options.dockerfile), TRUSTED_OPERATION_TOOL_RELATIVE_PATH), 'utf8'));
    validateTrustedModuleProbeSource(await readFile(join(dirname(options.dockerfile), TRUSTED_MODULE_PROBE_RELATIVE_PATH), 'utf8'));
    validateTrustedExecutionGuardSource(await readFile(join(dirname(options.dockerfile), TRUSTED_EXECUTION_GUARD_RELATIVE_PATH), 'utf8'));
    validateTrustedDependencyProxySource(await readFile(join(dirname(options.dockerfile), TRUSTED_DEPENDENCY_PROXY_RELATIVE_PATH), 'utf8'));
    validateTrustedProxyCredentialEnvironmentSource(await readFile(join(dirname(options.dockerfile), TRUSTED_PROXY_CREDENTIAL_ENV_RELATIVE_PATH), 'utf8'));
    validateTrustedWgetConfigSource(await readFile(join(dirname(options.dockerfile), TRUSTED_WGET_CONFIG_RELATIVE_PATH), 'utf8'));
    const definitionContents = await readFile(options.executionDefinitionPath, 'utf8');
    const metadata = dockerfileMetadata(dockerfileContents);
    validateExecutionDefinition(JSON.parse(definitionContents), '{{imageRepository}}@sha256:{{imageDigest}}');
    completeEvidence(options.evidence, metadata.packageSet);
    return Object.freeze({ ...metadata, executionDefinitionSha256: jsonDigest(options.executionDefinitionPath, definitionContents) });
  } catch (error) {
    if (error instanceof BuilderSourceError) throw error;
    if (error instanceof BuilderValidationError) throw error;
    throw new BuilderValidationError('BUILDER_SOURCE_DRIFT', error instanceof Error ? error.message : 'builder source validation failed');
  }
}

export interface DockerProbeOptions {
  readonly executable?: string;
  readonly run?: (executable: string, argv: readonly string[], options?: Record<string, unknown>) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export async function probeDocker(options: DockerProbeOptions = {}): Promise<DockerCapability> {
  const executable = options.executable ?? '/usr/bin/docker';
  const run = options.run ?? ((file, argv) => execFileAsync(file, [...argv], { timeout: 5_000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } }));
  try {
    const { stdout } = await run(executable, ['version', '--format', '{{json .}}'], { timeout: 5_000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const client = value.Client as Record<string, unknown> | undefined;
    const server = value.Server as Record<string, unknown> | undefined;
    const clientVersion = typeof client?.Version === 'string' ? client.Version : null;
    const serverVersion = typeof server?.Version === 'string' ? server.Version : null;
    const architecture = typeof server?.Arch === 'string' ? server.Arch : null;
    const available = clientVersion !== null && serverVersion !== null && architecture === 'amd64';
    return { available, mutation: 'probe', clientVersion, serverVersion, architecture, code: available ? 'OK' : 'DOCKER_UNAVAILABLE' };
  } catch {
    return { available: false, mutation: 'none', clientVersion: null, serverVersion: null, architecture: null, code: 'DOCKER_UNAVAILABLE' };
  }
}

function evidenceCommand(argv: readonly string[], stdout: string, stderr: string): BuilderEvidenceCommand {
  return { argv: [...argv], exitCode: 0, stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) };
}

const SYSTEM_TOOLCHAIN_PROBE = `set -eu
test -x /usr/bin/llvm-config
llvm_version="$(/usr/bin/llvm-config --version)"
rust_version="$(/usr/bin/rustc -vV)"
rust_llvm_version="$(printf '%s\\n' "$rust_version" | sed -n 's/^LLVM version: *//p')"
test "$rust_llvm_version" = "$llvm_version" || { echo 'rustc is not bound to the system LLVM version' >&2; exit 1; }
test -s /usr/lib/llvm-19/lib/libPolly.a
test -s /usr/lib/llvm-19/lib/libPollyISL.a
test "$(pkg-config --modversion libzstd)" != ''
mkdir -p /tmp/osi-rust-validation
cat > /tmp/osi-rust-validation/system-path.c <<'EOF'
#include <llvm-c/Core.h>
#include <zstd.h>
int main(void) { LLVMContextRef context = LLVMContextCreate(); size_t bound = ZSTD_compressBound(1); LLVMContextDispose(context); return bound == 0; }
EOF
clang -Werror -o /tmp/osi-rust-validation/system-path /tmp/osi-rust-validation/system-path.c $(/usr/bin/llvm-config --cflags --ldflags --libs core) $(pkg-config --cflags --libs libzstd)
/tmp/osi-rust-validation/system-path
cat > /tmp/osi-rust-validation/polly.c <<'EOF'
void builder_polly_probe(float *a, const float *b, const float *c, int n) { for (int i = 0; i < n; ++i) a[i] = b[i] + c[i]; }
EOF
clang -O1 -S -emit-llvm -o /tmp/osi-rust-validation/polly.ll /tmp/osi-rust-validation/polly.c
opt -passes=polly-opt-isl -disable-output /tmp/osi-rust-validation/polly.ll
printf '%s\\n' "$llvm_version"
printf '%s\\n' "$rust_version"
printf '%s\\n' '/usr/lib/llvm-19/lib/libPolly.a /usr/lib/llvm-19/lib/libPollyISL.a'
printf '%s\\n' "$(pkg-config --modversion libzstd)"`;

const RUST_TARGET_VALIDATION = `set -eu
mkdir -p /tmp/osi-rust-validation
printf 'pub fn builder_validation_marker() -> u64 { 42 }\\n' > /tmp/osi-rust-validation/lib.rs
for spec in x86_64-unknown-linux-gnu:x86_64 aarch64-unknown-linux-musl:aarch64 armv7-unknown-linux-musleabihf:armv7; do
  target="\${spec%%:*}"; slug="\${spec##*:}"
  libdir="$(/usr/bin/rustc --print target-libdir --target "$target")"
  std="$(find "$libdir" -maxdepth 1 -type f -name 'libstd-*.rlib' | sort | head -n 1)"
  test -s "$std"
  member="$(ar t "$std" | awk '/\\.rcgu\\.o$/ { print; exit }')"
  test -n "$member"
  std_object="/tmp/osi-rust-validation/\${slug}-std.o"
  ar p "$std" "$member" > "$std_object"
  test -s "$std_object"
  std_arch="$(file -b "$std_object")"
  out="/tmp/osi-rust-validation/\${slug}.o"
  /usr/bin/rustc --target "$target" --crate-type=lib --emit=obj -o "$out" /tmp/osi-rust-validation/lib.rs
  test -s "$out"
  out_arch="$(file -b "$out")"
  printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$target" "$libdir" "$std" "$(sha256sum "$std" | cut -d' ' -f1)" "$std_arch" "$out" "$(sha256sum "$out" | cut -d' ' -f1)" "$out_arch"
done`;

const OPERATION_TOOL_SELF_TEST = `set -eu
tool=/opt/osi-image-builder/operations/osi-image-builder-tool.js
probe=/opt/osi-image-builder/operations/osi-image-builder-module-probe.js
test "$(id -u)" != 0
test "$(id -un)" = buildbot
test -f "$tool"
test -f "$probe"
test "$(stat -c '%u:%g' "$tool")" = '0:0'
test "$(stat -c '%u:%g' "$probe")" = '0:0'
test "$(stat -c '%a' "$tool")" = '555'
test "$(stat -c '%a' "$probe")" = '555'
node --check "$tool"
node --check "$probe"
guard="$(dirname "$tool")/osi-image-builder-exec-guard.js"
proxy="$(dirname "$tool")/osi-dependency-egress-proxy.cjs"
credential_environment="$(dirname "$tool")/osi-proxy-credential-environment.cjs"
wget_config="$(dirname "$tool")/osi-wgetrc"
test -f "$guard"
test -f "$proxy"
test -f "$credential_environment"
test -f "$wget_config"
test "$(stat -c '%u:%g' "$guard")" = '0:0'
test "$(stat -c '%u:%g' "$proxy")" = '0:0'
test "$(stat -c '%u:%g' "$credential_environment")" = '0:0'
test "$(stat -c '%u:%g' "$wget_config")" = '0:0'
test "$(stat -c '%a' "$guard")" = '555'
test "$(stat -c '%a' "$proxy")" = '555'
test "$(stat -c '%a' "$credential_environment")" = '555'
test "$(stat -c '%a' "$wget_config")" = '444'
node --check "$guard"
node --check "$proxy"
node --check "$credential_environment"
test "$(cat "$wget_config")" = 'ca_certificate = /run/osi-image-builder/ca.pem
check_certificate = on'
rm -rf /workdir/conf /workdir/openwrt /workdir/web /workdir/feeds /workdir/feeds.conf.default
mkdir -p /workdir/conf/full_raspberrypi_bcm27xx_bcm2709/files /workdir/conf/full_raspberrypi_bcm27xx_bcm2709/patches /workdir/conf/full_raspberrypi_bcm27xx_bcm2712/files /workdir/conf/full_raspberrypi_bcm27xx_bcm2712/patches /workdir/openwrt /workdir/web/react-gui/build /workdir/feeds/chirpstack-openwrt-feed/apps/node-red/files
printf '%s\\n' 'CONFIG_TARGET_PROFILE="DEVICE_rpi-2"' > /workdir/conf/full_raspberrypi_bcm27xx_bcm2709/.config
printf '%s\\n' 'CONFIG_TARGET_PROFILE="DEVICE_rpi-5"' > /workdir/conf/full_raspberrypi_bcm27xx_bcm2712/.config
printf '%s\n' 'src-link chirpstack feeds/chirpstack-openwrt-feed' > /workdir/feeds.conf.default
printf '%s\n' '<!doctype html>' > /workdir/web/react-gui/build/index.html
node "$tool" activate-target full_raspberrypi_bcm27xx_bcm2709 >/tmp/osi-operation-tool-self-test.out 2>/tmp/osi-operation-tool-self-test.err
test ! -s /tmp/osi-operation-tool-self-test.err
test "$(cat /tmp/osi-operation-tool-self-test.out)" = '{"operation":"activate-target","environment":"full_raspberrypi_bcm27xx_bcm2709"}'
test "$(readlink /workdir/conf/.config)" = 'full_raspberrypi_bcm27xx_bcm2709/.config'
test "$(readlink /workdir/conf/files)" = 'full_raspberrypi_bcm27xx_bcm2709/files'
test "$(readlink /workdir/conf/patches)" = 'full_raspberrypi_bcm27xx_bcm2709/patches'
test "$(readlink /workdir/openwrt/.config)" = '../conf/.config'
test "$(readlink /workdir/openwrt/files)" = '../conf/files'
test "$(readlink /workdir/openwrt/patches)" = '../conf/patches'
workspace_dev="$(stat -c '%d' /workdir)"
workspace_ino="$(stat -c '%i' /workdir)"
node "$guard" "--workspace-dev=$workspace_dev" "--workspace-ino=$workspace_ino" '--active-target-environment=root' '--operation-id=copy-feed-config' '--operation-environment=full_raspberrypi_bcm27xx_bcm2712' '--working-directory=/workdir' -- node "$tool" copy-feed-config >/tmp/osi-execution-guard-self-test.out
test -s /tmp/osi-execution-guard-self-test.out
status=0; node "$guard" '--workspace-dev=0' "--workspace-ino=$workspace_ino" '--active-target-environment=root' '--operation-id=copy-feed-config' '--operation-environment=full_raspberrypi_bcm27xx_bcm2712' '--working-directory=/workdir' -- node "$tool" copy-feed-config >/tmp/osi-execution-guard-self-test.out 2>/tmp/osi-execution-guard-self-test.err || status=$?
test "$status" -eq 126
test -s /tmp/osi-execution-guard-self-test.err
rm -f /workdir/conf/.config /workdir/conf/files /workdir/conf/patches /workdir/openwrt/.config /workdir/openwrt/files /workdir/openwrt/patches
test ! -e /workdir/conf/.config
test ! -e /workdir/conf/files
test ! -e /workdir/conf/patches
test ! -e /workdir/openwrt/.config
test ! -e /workdir/openwrt/files
test ! -e /workdir/openwrt/patches
node "$tool" activate-target full_raspberrypi_bcm27xx_bcm2712 >/tmp/osi-operation-tool-self-test.out 2>/tmp/osi-operation-tool-self-test.err
test ! -s /tmp/osi-operation-tool-self-test.err
test "$(cat /tmp/osi-operation-tool-self-test.out)" = '{"operation":"activate-target","environment":"full_raspberrypi_bcm27xx_bcm2712"}'
test "$(readlink /workdir/conf/.config)" = 'full_raspberrypi_bcm27xx_bcm2712/.config'
test "$(readlink /workdir/conf/files)" = 'full_raspberrypi_bcm27xx_bcm2712/files'
test "$(readlink /workdir/conf/patches)" = 'full_raspberrypi_bcm27xx_bcm2712/patches'
test "$(readlink /workdir/openwrt/.config)" = '../conf/.config'
test "$(readlink /workdir/openwrt/files)" = '../conf/files'
test "$(readlink /workdir/openwrt/patches)" = '../conf/patches'
for link in conf/.config conf/files conf/patches openwrt/.config openwrt/files openwrt/patches; do
  target="$(readlink "/workdir/$link")"
  rm "/workdir/$link"
  ln -s "$target.invalid" "/workdir/$link"
  status=0; node "$guard" "--workspace-dev=$workspace_dev" "--workspace-ino=$workspace_ino" '--active-target-environment=full_raspberrypi_bcm27xx_bcm2712' '--operation-id=copy-feed-config' '--operation-environment=full_raspberrypi_bcm27xx_bcm2712' '--working-directory=/workdir' -- node "$tool" copy-feed-config >/tmp/osi-execution-guard-self-test.out 2>/tmp/osi-execution-guard-self-test.err || status=$?
  test "$status" -eq 126
  test -s /tmp/osi-execution-guard-self-test.err
  rm "/workdir/$link"
  ln -s "$target" "/workdir/$link"
done
node "$tool" copy-feed-config >/tmp/osi-operation-tool-self-test.out
test -s /workdir/openwrt/feeds.conf.default
set -- $(sha256sum /workdir/feeds.conf.default); source_feed_sha="$1"
set -- $(sha256sum /workdir/openwrt/feeds.conf.default); destination_feed_sha="$1"
expected_copy_result="$(printf '{\"operation\":\"copy-feed-config\",\"source\":\"feeds.conf.default\",\"destination\":\"openwrt/feeds.conf.default\",\"sha256\":\"%s\",\"sourceSha256\":\"%s\",\"destinationSha256\":\"%s\"}' "$source_feed_sha" "$source_feed_sha" "$destination_feed_sha")"
test "$(cat /tmp/osi-operation-tool-self-test.out)" = "$expected_copy_result"
node "$tool" mirror-gui >/tmp/osi-operation-tool-self-test.out
test -s /workdir/feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/index.html
rootfs=/workdir/openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx
node_red="$rootfs/usr/share/node-red"
mkdir -p /workdir/openwrt/bin/targets/bcm27xx/bcm2712 "$node_red/node_modules"
truncate -s 67108864 /workdir/openwrt/bin/targets/bcm27xx/bcm2712/chirpstack-gateway-os-self-test-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz
truncate -s 67108864 /workdir/openwrt/bin/targets/bcm27xx/bcm2712/chirpstack-gateway-os-self-test-full-bcm27xx-bcm2712-rpi-5-squashfs-sysupgrade.img.gz
third_party='@grpc/grpc-js @chirpstack/chirpstack-api google-protobuf protobufjs'
relative_helpers='osi-chameleon-helper osi-chirpstack-helper osi-cloud-http osi-db-helper osi-dendro-helper osi-health-helper osi-history-helper osi-history-sync-helper osi-lib'
direct_helpers='osi-command-ledger osi-dendro-analytics osi-zone-env osi-history-router osi-journal osi-device-writer osi-uc512-normalize osi-lsn50-normalize'
for module in $third_party; do
  package="$node_red/node_modules/$module"
  mkdir -p "$package"
  printf '{"name":"%s","main":"index.js"}\\n' "$module" > "$package/package.json"
  printf '%s\\n' 'module.exports = { compatible: true };' > "$package/index.js"
done
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
require('buffer');
require('crypto');
require('dns');
require('events');
require('fs');
require('http2');
require('net');
require('os');
require('path');
require('process');
require('stream');
require('tls');
require('url');
require('util');
require('zlib');
module.exports = { compatible: true };
EOF
mkdir -p "$node_red/node_modules/@chirpstack/chirpstack-api/api"
printf '%s\\n' 'module.exports = { compatible: true };' > "$node_red/node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js"
for module in $relative_helpers; do
  package="$node_red/$module"
  mkdir -p "$package"
  printf '{"name":"%s","main":"index.js"}\\n' "$module" > "$package/package.json"
  if [ "$module" = osi-db-helper ]; then
    cat > "$package/index.js" <<'EOF'
'use strict';
const sqlite3 = require('sqlite3');
if (Object.keys(sqlite3).sort().join(',') !== 'Database,OPEN_CREATE,OPEN_READONLY,OPEN_READWRITE' || typeof sqlite3.Database !== 'function' || sqlite3.OPEN_READONLY !== 1 || sqlite3.OPEN_READWRITE !== 2 || sqlite3.OPEN_CREATE !== 4) {
  throw new Error('sqlite3 initializer stub shape changed');
}
module.exports = { compatible: true };
EOF
  elif [ "$module" = osi-cloud-http ]; then
    cat > "$package/index.js" <<'EOF'
'use strict';
require('http');
require('https');
module.exports = { compatible: true };
EOF
  elif [ "$module" = osi-health-helper ]; then
    cat > "$package/index.js" <<'EOF'
'use strict';
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
if (Object.keys(childProcess).join(',') !== 'execFile' || Object.keys(fs).join(',') !== 'readFile' || typeof crypto.createHash !== 'function') {
  throw new Error('sealed builtin capability shape changed');
}
module.exports = { compatible: true };
EOF
  else
    printf '%s\\n' 'module.exports = { compatible: true };' > "$package/index.js"
  fi
  ln -s "../$module" "$node_red/node_modules/$module"
done
for module in $direct_helpers; do
  package="$node_red/$module"
  mkdir -p "$package"
  printf '{"name":"%s","main":"index.js"}\\n' "$module" > "$package/package.json"
  printf '%s\\n' 'module.exports = function compatible() {};' > "$package/index.js"
done
node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out
test ! -e "$node_red/node_modules/sqlite3"
node --input-type=commonjs <<'EOF'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const outputPath = '/tmp/osi-operation-tool-self-test.out';
const imagePath = '/workdir/openwrt/bin/targets/bcm27xx/bcm2712/chirpstack-gateway-os-self-test-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz';
const actual = JSON.parse(readFileSync(outputPath, 'utf8'));
const thirdParty = ['@grpc/grpc-js', '@chirpstack/chirpstack-api', 'google-protobuf', 'protobufjs'];
const relativeHelpers = ['osi-chameleon-helper', 'osi-chirpstack-helper', 'osi-cloud-http', 'osi-db-helper', 'osi-dendro-helper', 'osi-health-helper', 'osi-history-helper', 'osi-history-sync-helper', 'osi-lib'];
const directHelpers = ['osi-command-ledger', 'osi-dendro-analytics', 'osi-zone-env', 'osi-history-router', 'osi-journal', 'osi-device-writer', 'osi-uc512-normalize', 'osi-lsn50-normalize'];
const expected = {
  operation: 'verify-image',
  targetId: 'rpi-5',
  relativePath: 'openwrt/bin/targets/bcm27xx/bcm2712/chirpstack-gateway-os-self-test-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz',
  size: 67108864,
  sha256: createHash('sha256').update(readFileSync(imagePath)).digest('hex'),
  nodeResolution: [
    ...thirdParty.map((packageName) => ({ packageName, specifier: packageName, resolvedRelativePath: packageName === '@chirpstack/chirpstack-api' ? 'node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js' : 'node_modules/' + packageName + '/index.js', exportType: 'object' })),
    ...relativeHelpers.map((packageName) => ({ packageName, specifier: packageName, resolvedRelativePath: 'node_modules/' + packageName + '/index.js', exportType: 'object' })),
    ...directHelpers.map((packageName) => ({ packageName, specifier: './' + packageName, resolvedRelativePath: packageName + '/index.js', exportType: 'function' })),
  ],
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('verify-image canonical self-test output changed');
}
EOF
pi4_rootfs=/workdir/openwrt/build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx
mkdir -p "$(dirname "$pi4_rootfs")"
cp -a "$rootfs" "$pi4_rootfs"
mkdir -p "$node_red/node_modules/round-nine-native" "$node_red/node_modules/round-nine-builtin"
printf '%s\n' '{"name":"round-nine-native","main":"index.js"}' > "$node_red/node_modules/round-nine-native/package.json"
printf '%s\n' '{"name":"round-nine-builtin","main":"index.js"}' > "$node_red/node_modules/round-nine-builtin/package.json"
printf '%s\n' 'module.exports = { compatible: true };' > "$node_red/node_modules/round-nine-native/index.js"
printf '%s\n' 'module.exports = { compatible: true };' > "$node_red/node_modules/round-nine-builtin/index.js"
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
Object.prototype['round-nine-native'] = { packageName: '@grpc/grpc-js', value: { forged: true } };
Object.prototype['round-nine-builtin'] = { packageName: '@grpc/grpc-js', parentRelativePath: 'node_modules/@grpc/grpc-js/index.js', value: { forged: true } };
if (require('round-nine-native').forged || require('round-nine-builtin').forged) {
  throw new Error('inherited stub entry was used');
}
module.exports = { compatible: true };
EOF
node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out
test -s /tmp/osi-operation-tool-self-test.out
printf '%s\n' 'module probe inherited stub entries ignored'
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
require.cache.poisoned = true;
module.exports = { compatible: true };
EOF
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
printf '%s\n' 'module probe same-child cache mutation rejected'
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
module.constructor._pathCache.poisoned = true;
module.exports = { compatible: true };
EOF
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
printf '%s\n' 'module probe facade hides Module path cache'
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
JSON.stringify = () => '{"packageIndex":0,"packageName":"@grpc/grpc-js","specifier":"@grpc/grpc-js","resolvedRelativePath":"node_modules/@grpc/grpc-js/index.js","exportType":"object"}';
Object.prototype.toJSON = () => ({ packageIndex: 0, packageName: '@grpc/grpc-js', specifier: '@grpc/grpc-js', resolvedRelativePath: 'node_modules/@grpc/grpc-js/index.js', exportType: 'object' });
module.exports = 7;
EOF
node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out
node --input-type=commonjs <<'EOF'
const { readFileSync } = require('node:fs');
const actual = JSON.parse(readFileSync('/tmp/osi-operation-tool-self-test.out', 'utf8'));
if (actual.nodeResolution.find(({ packageName }) => packageName === '@grpc/grpc-js').exportType !== 'incompatible') {
  throw new Error('JSON.stringify replacement forged an incompatible export; Object.prototype.toJSON forged an incompatible export');
}
EOF
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
module.exports = { compatible: true };
EOF
cat > "$node_red/node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js" <<'EOF'
'use strict';
module.exports = { compatible: true };
EOF
cat > "$node_red/osi-db-helper/index.js" <<'EOF'
'use strict';
process.getBuiltinModule('fs').writeFileSync('/tmp/osi-module-probe-write-marker', 'written');
module.exports = {};
EOF
rm -f /tmp/osi-module-probe-write-marker
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
test ! -e /tmp/osi-module-probe-write-marker
cat > "$node_red/osi-db-helper/index.js" <<'EOF'
'use strict';
process.getBuiltinModule('child_process').spawnSync(
  process.execPath,
  ['-e', "require('node:fs').writeFileSync('/tmp/osi-module-probe-child-marker', 'spawned')"]
);
module.exports = {};
EOF
rm -f /tmp/osi-module-probe-child-marker
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
test ! -e /tmp/osi-module-probe-child-marker
cat > "$node_red/osi-db-helper/index.js" <<'EOF'
'use strict';
const sqlite = process.getBuiltinModule('node:sqlite');
const marker = new sqlite.DatabaseSync('/tmp/osi-module-probe-sqlite-marker.db');
marker.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');
marker.close();
module.exports = {};
EOF
rm -f /tmp/osi-module-probe-sqlite-marker.db
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
test ! -e /tmp/osi-module-probe-sqlite-marker.db
cat > "$node_red/osi-db-helper/index.js" <<'EOF'
'use strict';
import('node:sqlite').then(({ DatabaseSync }) => {
  const marker = new DatabaseSync('/tmp/osi-module-probe-dynamic-sqlite-marker.db');
  marker.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');
  marker.close();
  process.exitCode = 1;
}, (error) => {
  if (!(error instanceof Error) || !/unapproved builder ESM builtin/u.test(error.message)) process.exitCode = 1;
});
module.exports = {};
EOF
rm -f /tmp/osi-module-probe-dynamic-sqlite-marker.db
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
test ! -e /tmp/osi-module-probe-dynamic-sqlite-marker.db
cat > "$node_red/osi-db-helper/index.js" <<'EOF'
'use strict';
globalThis.Promise = class PoisonedPromise {
  constructor(executor) { executor(() => {}, () => {}); }
  then(onFulfilled) { return onFulfilled?.(); }
  catch(onRejected) { return this; }
  static resolve() { return new this(() => {}); }
  static reject() { return new this(() => {}); }
};
Array.prototype.push = () => { throw new globalThis.Error('mutable push used'); };
globalThis.Error = class DisabledError {};
setImmediate(() => import(['node', 'sqlite'].join(':')).then(({ DatabaseSync }) => {
  const marker = new DatabaseSync('/tmp/osi-module-probe-deferred-sqlite-marker.db');
  marker.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');
  marker.close();
}, () => {}));
module.exports = {};
EOF
rm -f /tmp/osi-module-probe-deferred-sqlite-marker.db
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
test ! -e /tmp/osi-module-probe-deferred-sqlite-marker.db
cat > "$node_red/osi-db-helper/index.js" <<'EOF'
'use strict';
Array.prototype.includes = () => true;
const sqlite = process.getBuiltinModule('node:sqlite');
const marker = new sqlite.DatabaseSync('/tmp/osi-module-probe-mutated-includes-marker.db');
marker.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');
marker.close();
module.exports = {};
EOF
rm -f /tmp/osi-module-probe-mutated-includes-marker.db
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
test ! -e /tmp/osi-module-probe-mutated-includes-marker.db
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
module.constructor._load = () => ({ compatible: true });
require('osi-round-eight-missing-dependency');
module.exports = { compatible: true };
EOF
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
cat > "$node_red/node_modules/@grpc/grpc-js/index.js" <<'EOF'
'use strict';
const schedule = (depth) => depth === 0
  ? import('node:sqlite').catch(() => {})
  : setImmediate(() => schedule(depth - 1));
schedule(4);
module.exports = { compatible: true };
EOF
status=0; node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?
test "$status" -eq 2
test ! -e /tmp/osi-module-probe-nested-sqlite-marker.db
rm -f /workdir/conf/.config /workdir/conf/files /workdir/conf/patches /workdir/openwrt/.config /workdir/openwrt/files /workdir/openwrt/patches
node "$tool" activate-target full_raspberrypi_bcm27xx_bcm2709 >/tmp/osi-operation-tool-self-test.out
mkdir -p /workdir/openwrt/bin/targets/bcm27xx/bcm2709
truncate -s 67108864 /workdir/openwrt/bin/targets/bcm27xx/bcm2709/chirpstack-gateway-os-self-test-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz
truncate -s 67108864 /workdir/openwrt/bin/targets/bcm27xx/bcm2709/chirpstack-gateway-os-self-test-full-bcm27xx-bcm2709-rpi-2-squashfs-sysupgrade.img.gz
node "$tool" verify-image >/tmp/osi-operation-tool-self-test.out
node --input-type=commonjs <<'EOF'
const { readFileSync } = require('node:fs');
const actual = JSON.parse(readFileSync('/tmp/osi-operation-tool-self-test.out', 'utf8'));
if (
  actual.targetId !== 'rpi-2'
  || actual.relativePath !== 'openwrt/bin/targets/bcm27xx/bcm2709/chirpstack-gateway-os-self-test-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz'
  || actual.size !== 67108864
  || actual.nodeResolution.length !== 21
) throw new Error('verify-image Pi 4 canonical self-test output changed');
EOF
rm -rf /workdir/openwrt /workdir/web /workdir/feeds /workdir/feeds.conf.default
status=0; node "$tool" unknown-operation >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?; test "$status" -eq 2
for operation in copy-feed-config verify-image mirror-gui; do
  status=0; node "$tool" "$operation" /unexpected-argument >/tmp/osi-operation-tool-self-test.out 2>&1 || status=$?; test "$status" -eq 2
done
printf '%s\n' 'trusted operation tool: path owner mode syntax and closed argv surface passed'`;

function dockerErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return 'Docker command failed';
  const value = error as { message?: unknown; stderr?: unknown };
  return [value.message, value.stderr].filter((item): item is string => typeof item === 'string' && item.length > 0).join(': ') || 'Docker command failed';
}

function isDockerUnavailable(error: unknown, purpose: 'inspect' | 'runtime'): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; stderr?: unknown; message?: unknown };
  const text = `${typeof value.stderr === 'string' ? value.stderr : ''}\n${typeof value.message === 'string' ? value.message : ''}`;
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock|failed to connect to.*daemon/iu.test(text)) return true;
  if (typeof value.code === 'string' && ['ENOENT', 'EACCES', 'ECONNREFUSED'].includes(value.code)) return true;
  if (purpose === 'inspect') {
    if (typeof value.code === 'string' && ['ETIMEDOUT'].includes(value.code)) return true;
    return /permission denied/iu.test(text);
  }
  return false;
}

function isMissingImage(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { stderr?: unknown; message?: unknown };
  const text = `${typeof value.stderr === 'string' ? value.stderr : ''}\n${typeof value.message === 'string' ? value.message : ''}`;
  return /No such image|manifest unknown|reference not found/iu.test(text);
}

export function builderRuntimeArguments(imageReference: string, commandArguments: readonly string[]): readonly string[] {
  return ['run', '--platform=linux/amd64', '--pull=never', '--rm', '--network', 'none', imageReference, ...commandArguments];
}

export async function validateBuiltBuilderImage(imageReference: string, options: DockerImageValidationOptions = {}): Promise<{ readonly imageId: string; readonly selfTest: 'passed'; readonly versions: Readonly<Record<string, string>>; readonly evidence: BuilderValidationEvidence }> {
  const canonical = parseCanonicalBuilderImageReference(imageReference);
  const executable = options.executable ?? '/usr/bin/docker';
  const environment = { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } as const;
  const command = options.run ?? ((argv, runOptions) => execFileAsync(executable, [...argv], { ...runOptions, encoding: 'utf8' }) as Promise<{ stdout: string; stderr: string }>);
  const invoke = async (argv: readonly string[], timeout: number, purpose: 'inspect' | 'runtime'): Promise<{ stdout: string; stderr: string }> => {
    try {
      return await command(argv, { timeout, maxBuffer: purpose === 'inspect' ? 64 * 1024 : 256 * 1024, env: environment });
    } catch (error) {
      if (purpose === 'inspect' && isMissingImage(error)) throw new BuilderValidationError('BUILDER_IMAGE_DIGEST_INVALID', dockerErrorMessage(error));
      if (purpose === 'runtime' && isMissingImage(error)) throw new BuilderValidationError('BUILDER_IMAGE_DIGEST_INVALID', dockerErrorMessage(error));
      if (isDockerUnavailable(error, purpose)) throw new BuilderValidationError('DOCKER_UNAVAILABLE', dockerErrorMessage(error));
      if (purpose === 'inspect') throw new BuilderValidationError('BUILDER_IMAGE_DIGEST_INVALID', dockerErrorMessage(error));
      throw new BuilderValidationError('RUST_BOOTSTRAP_UNAVAILABLE', dockerErrorMessage(error));
    }
  };
  let inspect: { stdout: string; stderr: string };
  try { inspect = await invoke(['image', 'inspect', '--format', '{{json .}}', imageReference], 10_000, 'inspect'); }
  catch (error) { throw error; }
  let image: { Id?: unknown; Architecture?: unknown; Os?: unknown; RepoDigests?: unknown; Size?: unknown; Config?: { Env?: unknown } };
  try { image = JSON.parse(inspect.stdout) as typeof image; } catch (error) { throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', `Docker image inspect was not valid JSON: ${dockerErrorMessage(error)}`); }
  if (typeof image.Id !== 'string' || !IMAGE_ID.test(image.Id)) throw new BuilderValidationError('BUILDER_IMAGE_DIGEST_INVALID', 'Docker image ID is invalid');
  if (image.Architecture !== 'amd64' || image.Os !== 'linux') throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Docker image architecture is not linux/amd64');
  if (typeof image.Size !== 'number' || image.Size <= 0 || image.Size > 4 * 1024 * 1024 * 1024) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Docker image size is outside the builder limit');
  if (!Array.isArray(image.Config?.Env) || JSON.stringify(image.Config.Env) !== JSON.stringify([`PATH=${IMAGE_PATH}`])) throw new BuilderValidationError('BUILDER_RUNTIME_ENV_INVALID', 'Docker image Config.Env is not the exact permitted runtime PATH');
  const repoDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
  const imageDigest = selectExactRepositoryDigest(imageReference, repoDigests);
  if (imageDigest !== canonical.imageDigest) throw new BuilderValidationError('BUILDER_IMAGE_DIGEST_INVALID', 'Docker image RepoDigest does not match the requested canonical digest');
  const versions: Record<string, string> = {};
  const commands: BuilderEvidenceCommand[] = [];
  const packageVersions: Record<string, string> = {};
  const run = async (argv: readonly string[], timeout = 60_000): Promise<{ stdout: string; stderr: string }> => {
    const result = await invoke(builderRuntimeArguments(imageReference, argv), timeout, 'runtime');
    commands.push(evidenceCommand(argv, result.stdout, result.stderr));
    return result;
  };
  await run(['/bin/sh', '-c', OPERATION_TOOL_SELF_TEST]);
  for (const [name, argv] of Object.entries({ node: ['node', '--version'], npm: ['npm', '--version'], gcc14: ['gcc-14', '--version'], sqlite3: ['sqlite3', '--version'], rustc: ['/usr/bin/rustc', '-vV'], llvm: ['/usr/bin/llvm-config', '--version'], polly: ['dpkg-query', '--show', '--showformat=${Version}', 'libpolly-19-dev'], zstd: ['pkg-config', '--modversion', 'libzstd'] })) {
    const result = await run(argv);
    versions[name] = result.stdout.trim();
    if (versions[name].length === 0) throw new BuilderValidationError('RUST_BOOTSTRAP_UNAVAILABLE', `${name} self-test returned no output`);
  }
  const packageResult = await run(['dpkg-query', '--show', '--showformat=${Package}=${Version}\\n', 'gcc-14', 'nodejs', 'npm', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev', 'sqlite3']);
  for (const line of packageResult.stdout.trim().split(/\r?\n/u)) { const separator = line.indexOf('='); if (separator > 0) packageVersions[line.slice(0, separator)] = line.slice(separator + 1); }
  packageVersions['openwrt-build-tools'] = 'complete-host-tool-set';
  const targetPackageResult = await run(['/bin/sh', '-c', 'cat /opt/target-sysroots/package-versions']);
  for (const line of targetPackageResult.stdout.trim().split(/\r?\n/u)) { const separator = line.indexOf('='); if (separator > 0) packageVersions[line.slice(0, separator)] = line.slice(separator + 1); }
  await run(['/bin/sh', '-c', 'test ! -e /tmp/rust-source && test -s /opt/target-sysroots/package-versions && du -sb /opt/rust-system /opt/target-sysroots']);
  const systemProbe = await run(['/bin/sh', '-c', SYSTEM_TOOLCHAIN_PROBE]);
  const systemLines = systemProbe.stdout.trim().split(/\r?\n/u);
  const systemRustLlv = systemLines.find((line) => /^LLVM version:\s*\d+\.\d+/u.test(line));
  if (systemLines.length < 4 || !/^\d+\.\d+/u.test(systemLines[0]!) || systemRustLlv === undefined) throw new BuilderValidationError('RUST_BOOTSTRAP_UNAVAILABLE', 'System LLVM/Polly/Zstd probe evidence is not semantic');
  const rustResult = await run(['/bin/sh', '-c', RUST_TARGET_VALIDATION]);
  const rustTargets = rustResult.stdout.trim().split(/\r?\n/u).map((line) => {
    const fields = line.split('|');
    if (fields.length !== 8 || !RUST_TARGETS.includes(fields[0] as (typeof RUST_TARGETS)[number]) || !DIGEST.test(fields[3]!) || !DIGEST.test(fields[6]!)) throw new BuilderValidationError('RUST_BOOTSTRAP_UNAVAILABLE', 'Rust target validation evidence is malformed');
    return { target: fields[0] as (typeof RUST_TARGETS)[number], standardLibraryPath: fields[2]!, standardLibrarySha256: fields[3]!, standardLibraryArchitecture: fields[4]!, compileArtifact: fields[5]!, compileSha256: fields[6]!, compileArchitecture: fields[7]!, result: 'passed' as const };
  });
  const evidence: BuilderValidationEvidence = { imageId: image.Id, imageDigest, architecture: 'linux/amd64', rustc: versions.rustc!, llvm: systemLines[0]!, polly: packageVersions['libpolly-19-dev']!, zstd: packageVersions['libzstd-dev']!, node: versions.node!, npm: versions.npm!, packages: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev', 'sqlite3'], packageVersions, commands, rustTargets, operationTool: { path: '/opt/osi-image-builder/operations/osi-image-builder-tool.js', owner: '0:0', mode: '0555', user: 'buildbot', result: 'passed' }, executionGuard: { path: '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js', owner: '0:0', mode: '0555', user: 'buildbot', result: 'passed' }, executionSelfTest: 'passed' };
  completeEvidence(evidence, evidence.packages);
  return { imageId: image.Id, selfTest: 'passed', versions, evidence };
}

export async function inspectBuilderImage(options: { readonly executable: string; readonly imageReference: string; readonly run: (executable: string, argv: readonly string[], options?: Record<string, unknown>) => Promise<{ readonly stdout: string; readonly stderr: string }> }): Promise<{ readonly available: boolean; readonly code: 'DOCKER_UNAVAILABLE' | null; readonly imageId?: string }> {
  try {
    const result = await options.run(options.executable, ['image', 'inspect', '--format', '{{json .}}', options.imageReference], { timeout: 5_000, maxBuffer: 64 * 1024, shell: false });
    const image = JSON.parse(result.stdout) as { Id?: unknown };
    if (typeof image.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(image.Id)) throw new Error('Docker image identity is invalid');
    return { available: true, code: null, imageId: image.Id };
  } catch {
    return { available: false, code: 'DOCKER_UNAVAILABLE' };
  }
}

export { BUILDER_LOCK_REQUIRED_KEYS, BUILDER_LOCK_OPTIONAL_KEYS };
