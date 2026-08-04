import { basename, isAbsolute, normalize } from 'node:path';

const HASH64 = /^[a-f0-9]{64}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const PACKAGE_VERSION = /^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u;
const PACKAGE_ROOT = /^\/[A-Za-z0-9._/-]+$/u;
const DOCKER_REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9]\d{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;

export interface BuilderIdentity {
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly lockSha256: string;
  readonly executionDefinitionSha256: string;
  readonly targetManifestSha256: string;
  readonly runnerSha256: string;
  readonly cleanupWorkerSha256: string;
  readonly dependencyEgressProxySha256: string;
  readonly imageReference: string;
  readonly imageId: string;
  readonly imageDigest: string;
}

export function parseBuilderIdentity(value: unknown): BuilderIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('builder identity must be an object');
  const identity = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify([
    'cleanupWorkerSha256', 'dependencyEgressProxySha256', 'executionDefinitionSha256', 'imageDigest', 'imageId', 'imageReference',
    'lockSha256', 'packageRoot', 'packageVersion', 'runnerSha256', 'targetManifestSha256',
  ])) throw new Error('builder identity fields are not exact');
  if (
    typeof identity.packageVersion !== 'string' || !PACKAGE_VERSION.test(identity.packageVersion)
    || typeof identity.packageRoot !== 'string' || identity.packageRoot.length > 1024
    || !PACKAGE_ROOT.test(identity.packageRoot)
    || !isAbsolute(identity.packageRoot) || normalize(identity.packageRoot) !== identity.packageRoot
    || identity.packageRoot === '/' || basename(identity.packageRoot) !== identity.packageVersion
    || typeof identity.lockSha256 !== 'string' || !HASH64.test(identity.lockSha256) || /^0+$/u.test(identity.lockSha256)
    || typeof identity.executionDefinitionSha256 !== 'string' || !HASH64.test(identity.executionDefinitionSha256) || /^0+$/u.test(identity.executionDefinitionSha256)
    || typeof identity.targetManifestSha256 !== 'string' || !HASH64.test(identity.targetManifestSha256) || /^0+$/u.test(identity.targetManifestSha256)
    || typeof identity.runnerSha256 !== 'string' || !HASH64.test(identity.runnerSha256) || /^0+$/u.test(identity.runnerSha256)
    || typeof identity.cleanupWorkerSha256 !== 'string' || !HASH64.test(identity.cleanupWorkerSha256) || /^0+$/u.test(identity.cleanupWorkerSha256)
    || typeof identity.dependencyEgressProxySha256 !== 'string' || !HASH64.test(identity.dependencyEgressProxySha256) || /^0+$/u.test(identity.dependencyEgressProxySha256)
    || typeof identity.imageDigest !== 'string' || !HASH64.test(identity.imageDigest) || /^0+$/u.test(identity.imageDigest)
    || typeof identity.imageId !== 'string' || !IMAGE_ID.test(identity.imageId) || /^sha256:0+$/u.test(identity.imageId)
    || typeof identity.imageReference !== 'string'
  ) throw new Error('builder identity values are invalid');
  const marker = '@sha256:';
  const markerIndex = identity.imageReference.indexOf(marker);
  const repository = markerIndex < 0 ? '' : identity.imageReference.slice(0, markerIndex);
  const digest = markerIndex < 0 ? '' : identity.imageReference.slice(markerIndex + marker.length);
  if (markerIndex !== identity.imageReference.lastIndexOf(marker) || !DOCKER_REPOSITORY.test(repository) || digest !== identity.imageDigest) throw new Error('builder image reference is not canonical or digest bound');
  return Object.freeze({
    packageVersion: identity.packageVersion,
    packageRoot: identity.packageRoot,
    lockSha256: identity.lockSha256,
    executionDefinitionSha256: identity.executionDefinitionSha256,
    targetManifestSha256: identity.targetManifestSha256,
    runnerSha256: identity.runnerSha256,
    cleanupWorkerSha256: identity.cleanupWorkerSha256,
    dependencyEgressProxySha256: identity.dependencyEgressProxySha256,
    imageReference: identity.imageReference,
    imageId: identity.imageId,
    imageDigest: identity.imageDigest,
  });
}
