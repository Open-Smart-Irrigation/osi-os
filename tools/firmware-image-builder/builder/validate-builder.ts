import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { validateBuilderLock, type BuilderLock } from '../domain/builder-lock.js';
import { BUILDER_LOCK_OPTIONAL_KEYS, BUILDER_LOCK_REQUIRED_KEYS } from '../domain/builder-lock.js';
import { assertSupportedPackageParity, BuilderSourceError, supportedPackageTokens } from './derive-dockerfile.js';
import { validateRustToolchain, type RustToolchainConfig } from './validate-rust-toolchain.js';

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/u;
const NODE_VERSION = /(?:node-v|NODE_VERSION=|nodejs\s+)(\d+\.\d+\.\d+)/u;
const LLVM_MAJOR = /(?:LLVM_MAJOR=|llvm(?:-dev)?\s+)(\d+)/u;
const POLLY_PACKAGE = /libpolly-(\d+)-dev/u;
const BASE_IMAGE = /^FROM\s+(\S+@sha256:([0-9a-f]{64}))\s*$/mu;

export type BuilderValidationErrorCode = 'BUILDER_SOURCE_DRIFT' | 'BUILDER_DOCKERFILE_INVALID' | 'BUILDER_VALIDATION_EVIDENCE_INVALID' | 'BUILDER_LOCK_INVALID' | 'DOCKER_UNAVAILABLE';

export class BuilderValidationError extends Error {
  readonly code: BuilderValidationErrorCode;

  constructor(code: BuilderValidationErrorCode, message: string) {
    super(message);
    this.name = 'BuilderValidationError';
    this.code = code;
  }
}

export interface BuilderValidationEvidence {
  readonly rustc: string;
  readonly llvm: string;
  readonly polly: string;
  readonly zstd: string;
  readonly node: string;
  readonly packages: readonly string[];
  readonly executionSelfTest: 'passed';
}

export interface BuilderSourceMetadata {
  readonly baseImage: string;
  readonly baseImageDigest: string;
  readonly dockerfileSha256: string;
  readonly executionDefinitionSha256: string;
  readonly packageSet: readonly string[];
  readonly rustConfig: RustToolchainConfig;
  readonly nodeVersion: string;
}

export interface DockerCapability {
  readonly available: boolean;
  readonly mutation: 'none' | 'probe';
  readonly clientVersion: string | null;
  readonly serverVersion: string | null;
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

function completeEvidence(evidence: BuilderValidationEvidence, expectedPackages: readonly string[]): void {
  if (!evidence || evidence.executionSelfTest !== 'passed' || [evidence.rustc, evidence.llvm, evidence.polly, evidence.zstd, evidence.node].some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence is incomplete');
  }
  if (!Array.isArray(evidence.packages) || expectedPackages.some((pkg) => !evidence.packages.includes(pkg))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Builder validation evidence omits required packages');
  if (/rust-ci-llvm/iu.test(JSON.stringify(evidence))) throw new BuilderValidationError('BUILDER_VALIDATION_EVIDENCE_INVALID', 'Rust CI LLVM artifacts are not accepted');
}

function dockerfileMetadata(contents: string): BuilderSourceMetadata {
  const base = contents.match(BASE_IMAGE);
  if (!base) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile has no digest-pinned base image');
  const baseName = base[1]!.slice(0, base[1]!.lastIndexOf('@'));
  if (baseName.includes(':')) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Mutable base tags are not accepted');
  const node = contents.match(NODE_VERSION)?.[1];
  const llvmMajor = Number(contents.match(/LLVM_MAJOR=(\d+)/u)?.[1] ?? contents.match(POLLY_PACKAGE)?.[1] ?? '0');
  const pollyMajor = Number(contents.match(POLLY_PACKAGE)?.[1] ?? '0');
  if (!node || Number.parseInt(node, 10) < 22) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile must contain Node >= 22');
  if (!Number.isInteger(llvmMajor) || llvmMajor < 1 || pollyMajor !== llvmMajor || !/\bllvm-dev\b/u.test(contents) || !/\blibzstd-dev\b/u.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile LLVM, Polly, or Zstd packages are incomplete');
  const rustConfig = { llvmConfig: contents.match(/RUST_LLVM_CONFIG=([^\s\\]+)/u)?.[1], channel: contents.match(/RUST_CHANNEL=([^\s\\]+)/u)?.[1], version: contents.match(/RUST_VERSION=([^\s\\]+)/u)?.[1], llvmMajor };
  const rust = validateRustToolchain(rustConfig);
  if (!rust.ok || /rust-ci-llvm/iu.test(contents)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile Rust LLVM configuration is unsupported');
  const packages = supportedPackageTokens(contents);
  const packageSet = ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', `libpolly-${llvmMajor}-dev`, 'libzstd-dev'] as const;
  if (!packages.includes('gcc-14') || !packages.includes('g++-14') || !packages.includes('clang') || !packages.includes('git')) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Dockerfile lacks complete GCC/OpenWrt tooling');
  return { baseImage: base[1]!, baseImageDigest: base[2]!, dockerfileSha256: sha256(contents), executionDefinitionSha256: '', packageSet, rustConfig: rust.config, nodeVersion: node };
}

function validateExecutionDefinition(value: unknown, imageTemplate: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Execution definition must be an object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.image !== 'object' || record.image === null || (record.image as Record<string, unknown>).reference !== imageTemplate) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Execution definition is not the canonical direct-Docker definition');
  if ('shell' in record || 'compose' in record || 'command' in record) throw new BuilderValidationError('BUILDER_DOCKERFILE_INVALID', 'Execution definition cannot contain shell or Compose commands');
}

export function builderImageReference(lock: Pick<BuilderLock, 'imageRepository' | 'imageDigest'>): string {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9]\d{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u.test(lock.imageRepository) || !SHA256.test(lock.imageDigest) || /^0+$/u.test(lock.imageDigest)) {
    throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'Builder image reference is not immutable');
  }
  return `${lock.imageRepository}@sha256:${lock.imageDigest}`;
}

export function canonicalBuilderImageReference(value: { readonly imageRepository: string; readonly imageDigest: string }): string {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9]\d{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u.test(value.imageRepository) || !SHA256.test(value.imageDigest) || /^0+$/u.test(value.imageDigest)) {
    throw new BuilderSourceError('BUILDER_DOCKERFILE_INVALID', 'Builder image reference is not immutable');
  }
  return builderImageReference(value as BuilderLock);
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

export function validateProductionBuilderLock(value: unknown, installedVersion: string, options: { readonly dockerfile: string; readonly executionDefinitionPath: string; readonly evidence: BuilderValidationEvidence }): { readonly ok: true; readonly lock: BuilderLock } | { readonly ok: false; readonly reason: string } {
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
    completeEvidence(options.evidence, lock.packageSet);
    if (validationEvidenceSha256(options.evidence) !== lock.validationEvidenceSha256) throw new Error('validation evidence hash mismatch');
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

export async function probeDocker(): Promise<DockerCapability> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/docker', ['version', '--format', '{{json .}}'], { timeout: 5_000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const client = value.Client as Record<string, unknown> | undefined;
    const server = value.Server as Record<string, unknown> | undefined;
    const clientVersion = typeof client?.Version === 'string' ? client.Version : null;
    const serverVersion = typeof server?.Version === 'string' ? server.Version : null;
    return { available: clientVersion !== null && serverVersion !== null, mutation: 'probe', clientVersion, serverVersion };
  } catch {
    return { available: false, mutation: 'none', clientVersion: null, serverVersion: null };
  }
}

export async function validateBuiltBuilderImage(imageReference: string): Promise<{ readonly imageId: string; readonly selfTest: 'passed'; readonly versions: Readonly<Record<string, string>> }> {
  try {
    const inspect = await execFileAsync('/usr/bin/docker', ['image', 'inspect', '--format', '{{json .}}', imageReference], { timeout: 10_000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    const image = JSON.parse(inspect.stdout) as { Id?: unknown };
    if (typeof image.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(image.Id)) throw new Error('Docker image ID is invalid');
    const versions: Record<string, string> = {};
    for (const [name, argv] of Object.entries({ node: ['node', '--version'], npm: ['npm', '--version'], gcc14: ['gcc-14', '--version'], rustc: ['rustc', '--version'], llvm: ['llvm-config', '--version'], polly: ['dpkg-query', '--show', '--showformat=${Version}', 'libpolly-19-dev'], zstd: ['dpkg-query', '--show', '--showformat=${Version}', 'libzstd-dev'] })) {
      const result = await execFileAsync('/usr/bin/docker', ['run', '--rm', '--network', 'none', imageReference, ...argv], { timeout: 60_000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
      versions[name] = result.stdout.trim();
      if (versions[name].length === 0) throw new Error(`${name} self-test returned no output`);
    }
    return { imageId: image.Id, selfTest: 'passed', versions };
  } catch (error) {
    throw new BuilderValidationError('DOCKER_UNAVAILABLE', error instanceof Error ? error.message : 'Docker image validation failed');
  }
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
