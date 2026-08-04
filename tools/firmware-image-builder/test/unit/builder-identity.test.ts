import { describe, expect, it } from 'vitest';

import { parseBuilderIdentity } from '../../domain/builder-identity.js';

const HASHES = Object.freeze({
  lock: '1'.repeat(64),
  execution: '2'.repeat(64),
  manifest: '3'.repeat(64),
  image: '4'.repeat(64),
  imageId: '5'.repeat(64),
  runner: '6'.repeat(64),
  cleanup: '7'.repeat(64),
  dependencyEgressProxy: '8'.repeat(64),
});

const COMPLETE_IDENTITY = Object.freeze({
  packageVersion: '0.1.24',
  packageRoot: '/home/builder/.local/lib/osi-image-builder/0.1.24',
  lockSha256: HASHES.lock,
  executionDefinitionSha256: HASHES.execution,
  targetManifestSha256: HASHES.manifest,
  runnerSha256: HASHES.runner,
  cleanupWorkerSha256: HASHES.cleanup,
  dependencyEgressProxySha256: HASHES.dependencyEgressProxy,
  imageReference: `registry.example.invalid/osi-image-builder@sha256:${HASHES.image}`,
  imageId: `sha256:${HASHES.imageId}`,
  imageDigest: HASHES.image,
});

describe('admitted builder identity', () => {
  it('requires and preserves the complete immutable package and image identity', () => {
    expect(parseBuilderIdentity(COMPLETE_IDENTITY)).toEqual(COMPLETE_IDENTITY);
    expect(Object.isFrozen(parseBuilderIdentity(COMPLETE_IDENTITY))).toBe(true);
  });

  it.each([
    'packageRoot',
    'lockSha256',
    'executionDefinitionSha256',
    'targetManifestSha256',
    'runnerSha256',
    'cleanupWorkerSha256',
    'dependencyEgressProxySha256',
  ] as const)('rejects an identity missing %s', (field) => {
    const incomplete = { ...COMPLETE_IDENTITY };
    delete incomplete[field];
    expect(() => parseBuilderIdentity(incomplete)).toThrow(/builder identity/iu);
  });

  it('rejects a package root that is not the exact admitted version directory', () => {
    expect(() => parseBuilderIdentity({ ...COMPLETE_IDENTITY, packageRoot: '/tmp/current' }))
      .toThrow(/package root|builder identity/iu);
    expect(() => parseBuilderIdentity({ ...COMPLETE_IDENTITY, packageRoot: '/home/builder/.local/lib/osi-image-builder/0.1.23' }))
      .toThrow(/package root|builder identity/iu);
  });

  it.each([
    '/home/builder/.local/lib/osi-image-builder/é/0.1.24',
    '/home/builder/.local/lib/osi-image-builder/😀/0.1.24',
    '/home/builder/.local/lib/osi-image-builder/$version/0.1.24',
    '/home/builder/.local/lib/osi-image-builder/%h/0.1.24',
    '/home/builder/.local/lib/osi-image-builder/source:target/0.1.24',
  ])('rejects a package root outside the ASCII systemd-safe path grammar: %s', (packageRoot) => {
    expect(() => parseBuilderIdentity({ ...COMPLETE_IDENTITY, packageRoot }))
      .toThrow(/package root|builder identity/iu);
  });
});
