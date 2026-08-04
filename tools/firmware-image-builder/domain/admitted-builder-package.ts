import { createHash } from 'node:crypto';

import { validateBuilderLock, type BuilderLock } from './builder-lock.js';
import { parseBuilderIdentity, type BuilderIdentity } from './builder-identity.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface AdmittedBuilderPackageEvidence {
  readonly identity: BuilderIdentity;
  readonly lockBytes: Uint8Array;
  readonly executionDefinition: Uint8Array;
  readonly runner: Uint8Array;
  readonly cleanupWorker: Uint8Array;
  readonly dependencyEgressProxy: Uint8Array;
  readonly manifestSha256: string;
}

export function validateAdmittedBuilderPackage(input: AdmittedBuilderPackageEvidence): BuilderLock {
  let identity: BuilderIdentity;
  try { identity = parseBuilderIdentity(input.identity); }
  catch (error) { throw new Error('admitted builder package identity is invalid', { cause: error }); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(input.lockBytes).toString('utf8')) as unknown; }
  catch (error) { throw new Error('admitted builder package lock is invalid', { cause: error }); }
  const validated = validateBuilderLock(parsed, identity.packageVersion);
  if (!validated.ok) throw new Error(`admitted builder package lock is invalid: ${validated.reason}`);
  const lock = validated.lock;
  if (
    sha256(input.lockBytes) !== identity.lockSha256
    || sha256(input.executionDefinition) !== identity.executionDefinitionSha256
    || sha256(input.runner) !== identity.runnerSha256
    || sha256(input.cleanupWorker) !== identity.cleanupWorkerSha256
    || sha256(input.dependencyEgressProxy) !== identity.dependencyEgressProxySha256
    || input.manifestSha256 !== identity.targetManifestSha256
    || lock.executionDefinitionSha256 !== identity.executionDefinitionSha256
    || lock.dependencyEgressProxySha256 !== identity.dependencyEgressProxySha256
    || lock.imageDigest !== identity.imageDigest
    || lock.imageId === undefined || `sha256:${lock.imageId}` !== identity.imageId
    || `${lock.imageRepository}@sha256:${lock.imageDigest}` !== identity.imageReference
  ) throw new Error('admitted builder package evidence does not match the immutable job identity');
  return lock;
}
