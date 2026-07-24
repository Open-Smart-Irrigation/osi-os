import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { validateBuilderLock, type BuilderLock } from '../domain/builder-lock.js';
import { BUILDER_LOCK_OPTIONAL_KEYS, BUILDER_LOCK_REQUIRED_KEYS } from '../domain/builder-lock.js';
import { TRUSTED_OPERATION_IDS } from '../domain/types.js';
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
export const RUST_TARGETS = Object.freeze(['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-musl', 'armv7-unknown-linux-musleabihf'] as const);
const TARGET_PACKAGE_NAMES = Object.freeze(['musl:arm64', 'musl-dev:arm64', 'musl:armhf', 'musl-dev:armhf'] as const);

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
  readonly packages: readonly string[];
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly commands: readonly BuilderEvidenceCommand[];
  readonly rustTargets: readonly RustArtifactEvidence[];
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

function completeEvidence(evidence: BuilderValidationEvidence, expectedPackages: readonly string[], lock?: BuilderLock): void {
  if (!evidence || evidence.executionSelfTest !== 'passed' || !IMAGE_ID.test(evidence.imageId) || !DIGEST.test(evidence.imageDigest) || /^0+$/u.test(evidence.imageDigest) || evidence.architecture !== 'linux/amd64') throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence is incomplete or unbound');
  if (lock !== undefined && (evidence.imageDigest !== lock.imageDigest || (lock.imageId !== undefined && evidence.imageId !== `sha256:${lock.imageId}`))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence is bound to a different image');
  if (!/^rustc\s+\d+\.\d+\.\d+/u.test(evidence.rustc) || !/^\d+\.\d+\.\d+/u.test(evidence.llvm) || !/^(?:\d+:)?\d+\.\d+\.\d+/u.test(evidence.polly) || !/^\d+\.\d+/u.test(evidence.zstd) || !/^v22\.\d+\.\d+$/u.test(evidence.node)) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Toolchain version evidence is not semantic');
  if (!Array.isArray(evidence.packages) || expectedPackages.some((pkg) => !evidence.packages.includes(pkg))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence omits required packages');
  const evidencePackageKeys = [...expectedPackages, ...TARGET_PACKAGE_NAMES];
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
  if (!/^ARG BUILDER_PLATFORM=linux\/amd64\s+FROM\s+--platform=\$\{BUILDER_PLATFORM\}/mu.test(contents) || /^FROM\s+--platform=linux\/amd64/mu.test(contents) || !/ARG NODE_ARCH=linux-x64/u.test(contents) || !/node-v\$\{NODE_VERSION\}-\$\{NODE_ARCH\}\.tar\.xz/u.test(contents) || !/ARG NODE_TARBALL_SHA256=[0-9a-f]{64}/u.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile architecture or Node archive pin is incomplete');
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
  if (!packages.includes('gcc-14') || !packages.includes('g++-14') || !packages.includes('clang') || !packages.includes('git') || !/apt-get download "musl:arm64=\$\{MUSL_VERSION\}" "musl-dev:arm64=\$\{MUSL_VERSION\}" "musl:armhf=\$\{MUSL_VERSION\}" "musl-dev:armhf=\$\{MUSL_VERSION\}"/u.test(contents) || !/ARG MUSL_ARM64_SHA256=[0-9a-f]{64}/u.test(contents) || !/ARG MUSL_DEV_ARM64_SHA256=[0-9a-f]{64}/u.test(contents) || !/ARG MUSL_ARMHF_SHA256=[0-9a-f]{64}/u.test(contents) || !/ARG MUSL_DEV_ARMHF_SHA256=[0-9a-f]{64}/u.test(contents) || !/musl-libdir\s*=\s*"\/opt\/target-sysroots\/aarch64\/usr\/lib\/aarch64-linux-musl"/u.test(contents) || !/musl-libdir\s*=\s*"\/opt\/target-sysroots\/armv7\/usr\/lib\/arm-linux-musleabihf"/u.test(contents) || !/--sysroot=\/opt\/target-sysroots\/aarch64/u.test(contents) || !/--sysroot=\/opt\/target-sysroots\/armv7/u.test(contents) || !/\/opt\/target-sysroots\/aarch64\/usr\/include\/aarch64-linux-musl/u.test(contents) || !/\/opt\/target-sysroots\/armv7\/usr\/include\/arm-linux-musleabihf/u.test(contents) || /__clang_major__=0/u.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile lacks complete target musl toolchains');
  return { baseImage: base[1]!, baseImageDigest: base[2]!, dockerfileSha256: sha256(contents), executionDefinitionSha256: '', packageSet, rustConfig: rust.config, nodeVersion: node, architecture: 'linux/amd64', packageSource: 'snapshot.debian.org/archive/debian/20260715T000000Z' };
}

export function validateExecutionDefinition(value: unknown, imageTemplate = '{{imageRepository}}@sha256:{{imageDigest}}'): void {
  const fail = (message: string): never => { throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Execution definition must be an object');
  const record = value as Record<string, unknown>;
  const expectedTop = ['architecture', 'environment', 'image', 'mount', 'network', 'operationIds', 'runtime', 'schemaVersion', 'security', 'user', 'workdir'];
  if (!exactKeys(record, expectedTop)) fail('Execution definition contains unknown or missing top-level fields');
  if (record.schemaVersion !== 1 || record.runtime !== 'docker' || record.architecture !== 'linux/amd64' || record.user !== '<uid>:<gid>' || record.workdir !== '/workdir' || record.network !== 'bridge') fail('Execution definition runtime contract is invalid');
  if (!record.image || typeof record.image !== 'object' || Array.isArray(record.image) || !exactKeys(record.image as object, ['pullPolicy', 'reference']) || (record.image as Record<string, unknown>).pullPolicy !== 'never' || (record.image as Record<string, unknown>).reference !== imageTemplate) fail('Execution definition image contract is invalid');
  const environment = record.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || !exactKeys(environment as object, ['CARGO_BUILD_JOBS', 'HOME', 'PATH', 'SOURCE_DATE_EPOCH', 'TZ']) || JSON.stringify(environment) !== JSON.stringify({ HOME: '/workdir/.builder-home', PATH: IMAGE_PATH, CARGO_BUILD_JOBS: '2', TZ: 'UTC', SOURCE_DATE_EPOCH: '<pinned-commit-time>' })) fail('Execution definition environment is invalid');
  const mount = record.mount;
  if (!mount || typeof mount !== 'object' || Array.isArray(mount) || !exactKeys(mount as object, ['destination', 'readOnly', 'source', 'type']) || JSON.stringify(mount) !== JSON.stringify({ type: 'bind', source: '<job-worktree>', destination: '/workdir', readOnly: false })) fail('Execution definition mount is invalid');
  const security = record.security;
  if (!security || typeof security !== 'object' || Array.isArray(security) || !exactKeys(security as object, ['capAdd', 'capDrop', 'devices', 'noNewPrivileges', 'pidsLimit', 'privileged', 'sockets', 'ulimit']) || JSON.stringify(security) !== JSON.stringify({ capDrop: ['ALL'], capAdd: [], devices: [], sockets: [], privileged: false, noNewPrivileges: true, pidsLimit: 4096, ulimit: 'nofile=1024:4096' })) fail('Execution definition security is invalid');
  if (!Array.isArray(record.operationIds) || JSON.stringify(record.operationIds) !== JSON.stringify(TRUSTED_OPERATION_IDS)) fail('Execution definition operation IDs are not synchronized with the trusted manifest');
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
  for (const [name, argv] of Object.entries({ node: ['node', '--version'], npm: ['npm', '--version'], gcc14: ['gcc-14', '--version'], rustc: ['/usr/bin/rustc', '-vV'], llvm: ['/usr/bin/llvm-config', '--version'], polly: ['dpkg-query', '--show', '--showformat=${Version}', 'libpolly-19-dev'], zstd: ['pkg-config', '--modversion', 'libzstd'] })) {
    const result = await run(argv);
    versions[name] = result.stdout.trim();
    if (versions[name].length === 0) throw new BuilderValidationError('RUST_BOOTSTRAP_UNAVAILABLE', `${name} self-test returned no output`);
  }
  const packageResult = await run(['dpkg-query', '--show', '--showformat=${Package}=${Version}\\n', 'gcc-14', 'nodejs', 'npm', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev']);
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
  const evidence: BuilderValidationEvidence = { imageId: image.Id, imageDigest, architecture: 'linux/amd64', rustc: versions.rustc!, llvm: systemLines[0]!, polly: packageVersions['libpolly-19-dev']!, zstd: packageVersions['libzstd-dev']!, node: versions.node!, packages: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'], packageVersions, commands, rustTargets, executionSelfTest: 'passed' };
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
