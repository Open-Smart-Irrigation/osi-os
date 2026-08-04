const SHA256 = /^[0-9a-f]{64}$/u;
const DOCKER_REPOSITORY_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const PRODUCTION_VERSION = /^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export const BUILDER_LOCK_REQUIRED_KEYS = Object.freeze([
  'schemaVersion', 'packageVersion', 'imageRepository', 'imageDigest', 'baseImage',
  'baseImageDigest', 'dockerfileSha256', 'packageSet', 'rustConfig', 'nodeVersion',
  'executionDefinitionSha256', 'validationEvidenceSha256',
  'dependencyEgressProxySha256',
] as const);

export const BUILDER_LOCK_OPTIONAL_KEYS = Object.freeze(['installable', 'publisherSha256', 'imageId'] as const);

export interface BuilderLock {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly imageRepository: string;
  readonly imageDigest: string;
  readonly baseImage: string;
  readonly baseImageDigest: string;
  readonly dockerfileSha256: string;
  readonly packageSet: readonly string[];
  readonly rustConfig: object;
  readonly nodeVersion: string;
  readonly executionDefinitionSha256: string;
  readonly validationEvidenceSha256: string;
  readonly dependencyEgressProxySha256: string;
  readonly installable?: boolean;
  readonly publisherSha256?: string;
  readonly imageId?: string;
}

export type BuilderLockValidation =
  | { readonly ok: true; readonly lock: BuilderLock }
  | { readonly ok: false; readonly reason: string };

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value) && !/^0+$/u.test(value);
}

function dockerRepository(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value !== value.toLowerCase() || /[@\s]/u.test(value)) return false;
  const components = value.split('/');
  if (components.length === 0) return false;
  const registry = components[0]!;
  const registryParts = registry.split(':');
  if (registryParts.length > 2 || (registryParts.length === 2 && components.length < 2) || !DOCKER_REPOSITORY_COMPONENT.test(registryParts[0]!)) return false;
  if (registryParts.length === 2 && (!/^\d{1,5}$/u.test(registryParts[1]!) || Number(registryParts[1]) < 1 || Number(registryParts[1]) > 65535)) return false;
  return components.slice(1).every((component) => DOCKER_REPOSITORY_COMPONENT.test(component));
}

function supportedPackageSet(value: unknown, llvmMajor: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length !== 7 || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 64)) return false;
  const packages = new Set(value);
  if (packages.size !== value.length) return false;
  const required = ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev'];
  return required.every((item) => packages.has(item)) && packages.has(`libpolly-${llvmMajor}-dev`);
}

function productionRustConfig(value: unknown): value is { readonly llvmConfig: '/usr/bin/llvm-config'; readonly channel: 'stable'; readonly version: string; readonly llvmMajor: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const keys = Object.keys(config).sort();
  if (keys.join(',') !== 'channel,llvmConfig,llvmMajor,version' || config.llvmConfig !== '/usr/bin/llvm-config' || config.channel !== 'stable') return false;
  if (typeof config.version !== 'string' || !SEMVER.test(config.version) || typeof config.llvmMajor !== 'number' || !Number.isInteger(config.llvmMajor) || config.llvmMajor < 1) return false;
  return true;
}

export function validateBuilderLock(value: unknown, installedVersion: string): BuilderLockValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'lock must be an object' };
  const lock = value as Record<string, unknown>;
  const allowed = new Set<string>([...BUILDER_LOCK_REQUIRED_KEYS, ...BUILDER_LOCK_OPTIONAL_KEYS]);
  if (Object.keys(lock).some((key) => !allowed.has(key))) return { ok: false, reason: 'unexpected lock keys' };
  if (BUILDER_LOCK_REQUIRED_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(lock, key))) return { ok: false, reason: 'required lock field missing' };
  if (lock.schemaVersion !== 1 || !Number.isInteger(lock.schemaVersion)) return { ok: false, reason: 'schemaVersion must be integer 1' };
  if (lock.installable !== true) return { ok: false, reason: 'lock is not installable' };
  if (lock.packageVersion !== installedVersion || typeof lock.packageVersion !== 'string' || !PRODUCTION_VERSION.test(lock.packageVersion)) return { ok: false, reason: 'package version is not production metadata' };
  if (!dockerRepository(lock.imageRepository)) return { ok: false, reason: 'image repository is invalid' };
  if (!digest(lock.imageDigest) || !digest(lock.baseImageDigest) || !digest(lock.dockerfileSha256)
    || !digest(lock.executionDefinitionSha256) || !digest(lock.validationEvidenceSha256)
    || !digest(lock.dependencyEgressProxySha256)) return { ok: false, reason: 'lock digest is invalid' };
  if (typeof lock.baseImage !== 'string' || !lock.baseImage.endsWith(`@sha256:${lock.baseImageDigest}`)
    || !dockerRepository(lock.baseImage.slice(0, lock.baseImage.lastIndexOf('@'))) || !/^sha256:[0-9a-f]{64}$/u.test(lock.baseImage.slice(lock.baseImage.lastIndexOf('@') + 1))) return { ok: false, reason: 'base image is not digest bound' };
  if (typeof lock.nodeVersion !== 'string' || !SEMVER.test(lock.nodeVersion)) return { ok: false, reason: 'Node version is unsupported' };
  const nodeMajor = Number.parseInt(lock.nodeVersion.split('.')[0]!, 10);
  if (nodeMajor < 22 || !productionRustConfig(lock.rustConfig) || !supportedPackageSet(lock.packageSet, lock.rustConfig.llvmMajor)) return { ok: false, reason: 'install metadata is incomplete' };
  if (Object.prototype.hasOwnProperty.call(lock, 'publisherSha256') && !digest(lock.publisherSha256)) return { ok: false, reason: 'publisher digest is invalid' };
  if (Object.prototype.hasOwnProperty.call(lock, 'imageId') && !digest(lock.imageId)) return { ok: false, reason: 'image ID is invalid' };
  return { ok: true, lock: lock as unknown as BuilderLock };
}
