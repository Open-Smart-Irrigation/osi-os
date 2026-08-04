import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { validateAdmittedBuilderPackage } from '../../domain/admitted-builder-package.js';

describe('admitted builder package authority', () => {
  it('rejects every package evidence mismatch before execution', () => {
    const executionDefinition = Buffer.from('{"schemaVersion":1}\n');
    const runner = Buffer.from('runner-0.1.24');
    const cleanup = Buffer.from('cleanup-0.1.24');
    const dependencyEgressProxy = Buffer.from('proxy-0.1.24');
    const manifestSha256 = '3'.repeat(64);
    const imageDigest = '4'.repeat(64);
    const imageId = '5'.repeat(64);
    const lock = {
      schemaVersion: 1 as const,
      packageVersion: '0.1.24',
      imageRepository: 'registry.example.invalid/osi-image-builder',
      imageDigest,
      baseImage: `ubuntu@sha256:${'6'.repeat(64)}`,
      baseImageDigest: '6'.repeat(64),
      dockerfileSha256: '7'.repeat(64),
      packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev', 'libpolly-18-dev'],
      rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.80.0', llvmMajor: 18 },
      nodeVersion: '22.12.0',
      executionDefinitionSha256: createHash('sha256').update(executionDefinition).digest('hex'),
      dependencyEgressProxySha256: createHash('sha256').update(dependencyEgressProxy).digest('hex'),
      validationEvidenceSha256: '8'.repeat(64),
      installable: true,
      publisherSha256: '9'.repeat(64),
      imageId,
    };
    const lockBytes = Buffer.from(`${JSON.stringify(lock)}\n`);
    const identity = {
      packageVersion: '0.1.24',
      packageRoot: '/home/builder/.local/lib/osi-image-builder/0.1.24',
      lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
      executionDefinitionSha256: lock.executionDefinitionSha256,
      targetManifestSha256: manifestSha256,
      runnerSha256: createHash('sha256').update(runner).digest('hex'),
      cleanupWorkerSha256: createHash('sha256').update(cleanup).digest('hex'),
      dependencyEgressProxySha256: lock.dependencyEgressProxySha256,
      imageReference: `${lock.imageRepository}@sha256:${imageDigest}`,
      imageId: `sha256:${imageId}`,
      imageDigest,
    };

    expect(validateAdmittedBuilderPackage({ identity, lockBytes, executionDefinition, runner, cleanupWorker: cleanup, dependencyEgressProxy, manifestSha256 })).toEqual(lock);
    for (const mismatch of [
      { lockBytes: Buffer.from('{}') },
      { executionDefinition: Buffer.from('changed') },
      { runner: Buffer.from('changed') },
      { cleanupWorker: Buffer.from('changed') },
      { dependencyEgressProxy: Buffer.from('changed') },
      { manifestSha256: 'a'.repeat(64) },
    ]) {
      expect(() => validateAdmittedBuilderPackage({ identity, lockBytes, executionDefinition, runner, cleanupWorker: cleanup, dependencyEgressProxy, manifestSha256, ...mismatch }))
        .toThrow(/admitted builder package|identity/iu);
    }
  });
});
