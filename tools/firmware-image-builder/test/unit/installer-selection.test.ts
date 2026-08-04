import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  BUILDER_LOCK_OPTIONAL_KEYS,
  BUILDER_LOCK_REQUIRED_KEYS,
} from '../../domain/builder-lock.js';
import type { NativePrerequisiteResult } from '../../installer/probes.js';
import {
  createProductionBuilderLock,
  validateInstallerSelection,
} from '../../installer/install.js';

const VERSION = '2026.07.29.1';
const digest = (letter: string): string => letter.repeat(64);
const IMAGE_REPOSITORY = 'registry.example.invalid/osi-builder';
const IMAGE_DIGEST = digest('a');
const BASE_IMAGE_DIGEST = digest('b');
const DOCKERFILE_SHA256 = digest('c');
const EXECUTION_DEFINITION_SHA256 = digest('d');
const DEPENDENCY_EGRESS_PROXY_SHA256 = digest('8');
const EVIDENCE_SHA256 = digest('e');
const IMAGE_ID = digest('f');
const DOCKER_IMAGE_ID = `sha256:${IMAGE_ID}`;
const BUILDER_REFERENCE = `${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}`;
const RUNTIME_ENV = Object.freeze(['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']);

const AVAILABLE_PROBES: NativePrerequisiteResult = {
  available: true,
  code: 'HOST_PREREQUISITES_AVAILABLE',
  detail: 'native host and selected filesystem prerequisites are available',
  mutation: 'none',
};

function validLock(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packageVersion: VERSION,
    imageRepository: IMAGE_REPOSITORY,
    imageDigest: IMAGE_DIGEST,
    baseImage: `docker.io/library/debian@sha256:${BASE_IMAGE_DIGEST}`,
    baseImageDigest: BASE_IMAGE_DIGEST,
    dockerfileSha256: DOCKERFILE_SHA256,
    packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'],
    rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 },
    nodeVersion: '22.14.0',
    executionDefinitionSha256: EXECUTION_DEFINITION_SHA256,
    dependencyEgressProxySha256: DEPENDENCY_EGRESS_PROXY_SHA256,
    validationEvidenceSha256: EVIDENCE_SHA256,
    installable: true,
    imageId: IMAGE_ID,
  };
}

function validDependencies(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installedVersion: VERSION,
    source: {
      dockerfile: 'validated tool-owned Dockerfile',
      rootDockerfile: 'current main Dockerfile-devel',
      executionDefinition: 'validated execution definition',
      dockerfileSha256: DOCKERFILE_SHA256,
      baseImageDigest: BASE_IMAGE_DIGEST,
      executionDefinitionSha256: EXECUTION_DEFINITION_SHA256,
      validationEvidenceSha256: EVIDENCE_SHA256,
    },
    builderImage: {
      available: true,
      validated: true,
      reference: BUILDER_REFERENCE,
      repoDigests: [`${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}`],
      imageId: DOCKER_IMAGE_ID,
      configEnv: RUNTIME_ENV,
    },
    serviceUser: {
      inspect: async (reference: string) => ({
        available: true,
        reference,
        imageId: DOCKER_IMAGE_ID,
        repoDigests: [`${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}`],
        configEnv: RUNTIME_ENV,
      }),
    },
    productionImageValidation: async (reference: string) => ({
      reference,
      imageId: DOCKER_IMAGE_ID,
      imageDigest: IMAGE_DIGEST,
      repoDigests: [`${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}`],
      configEnv: RUNTIME_ENV,
      validationEvidenceSha256: EVIDENCE_SHA256,
    }),
    publisher: {
      selfTest: async () => ({ available: true, passed: true, sha256: digest('9') }),
    },
    hostProbes: async () => AVAILABLE_PROBES,
    ...overrides,
  };
}

async function rejectSelection(
  candidate: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  reason?: string,
): Promise<void> {
  const assertion = expect(validateInstallerSelection(candidate, validDependencies(overrides)));
  if (reason) await assertion.rejects.toMatchObject({ code: reason });
  else await assertion.rejects.toBeDefined();
}

describe('versioned installer selection', () => {
  it('rejects the committed non-installable fixture before any injected boundary can mutate state', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/builder/non-installable-lock.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(fixture.installable).toBe(false);

    const boundaryCalls: string[] = [];
    await rejectSelection(fixture, {
      builderImage: { available: true, validated: true },
      serviceUser: { inspect: async () => { boundaryCalls.push('service-user'); return { available: true }; } },
      productionImageValidation: async () => { boundaryCalls.push('production-validator'); return {}; },
      publisher: { selfTest: async () => { boundaryCalls.push('publisher'); return { available: true, passed: true }; } },
      hostProbes: async () => { boundaryCalls.push('probes'); return AVAILABLE_PROBES; },
    }, 'BUILDER_LOCK_INVALID');
    expect(boundaryCalls).toEqual([]);
  });

  it('rejects mutable tags, sentinel evidence, and incomplete or invalid lock data', async () => {
    await rejectSelection({ ...validLock(), imageRepository: `${IMAGE_REPOSITORY}:latest` }, {}, 'BUILDER_IMAGE_DIGEST_INVALID');
    await rejectSelection({ ...validLock(), baseImage: 'docker.io/library/debian:stable' }, {}, 'BUILDER_LOCK_INVALID');
    for (const evidence of ['UNRESOLVED', 'PENDING', '<validation-evidence>', '']) {
      await rejectSelection({ ...validLock(), validationEvidenceSha256: evidence }, {}, 'BUILDER_LOCK_INVALID');
    }
    for (const field of BUILDER_LOCK_REQUIRED_KEYS) {
      const candidate = validLock();
      delete candidate[field];
      await rejectSelection(candidate, {}, 'BUILDER_LOCK_INVALID');
    }
    for (const field of ['imageDigest', 'baseImageDigest', 'dockerfileSha256', 'executionDefinitionSha256', 'dependencyEgressProxySha256', 'validationEvidenceSha256', 'imageId']) {
      for (const value of ['bad', digest('A'), `${digest('a')}0`, '0'.repeat(64)]) {
        await rejectSelection({ ...validLock(), [field]: value }, {}, 'BUILDER_LOCK_INVALID');
      }
    }
  });

  it('rejects Dockerfile, base-image, image, and execution-definition mismatches', async () => {
    await rejectSelection(validLock(), { source: { dockerfileSha256: digest('1'), baseImageDigest: BASE_IMAGE_DIGEST, executionDefinitionSha256: EXECUTION_DEFINITION_SHA256, validationEvidenceSha256: EVIDENCE_SHA256 } }, 'BUILDER_DIGEST_MISMATCH');
    await rejectSelection(validLock(), { source: { dockerfileSha256: DOCKERFILE_SHA256, baseImageDigest: digest('1'), executionDefinitionSha256: EXECUTION_DEFINITION_SHA256, validationEvidenceSha256: EVIDENCE_SHA256 } }, 'BUILDER_DIGEST_MISMATCH');
    await rejectSelection(validLock(), { builderImage: { available: true, validated: true, reference: BUILDER_REFERENCE, repoDigests: [`${IMAGE_REPOSITORY}@sha256:${digest('1')}`], imageId: DOCKER_IMAGE_ID, configEnv: RUNTIME_ENV } }, 'BUILDER_DIGEST_MISMATCH');
    await rejectSelection(validLock(), { source: { dockerfileSha256: DOCKERFILE_SHA256, baseImageDigest: BASE_IMAGE_DIGEST, executionDefinitionSha256: digest('1'), validationEvidenceSha256: EVIDENCE_SHA256 } }, 'DOCKER_EXECUTION_DEFINITION_MISMATCH');
  });

  it('requires exactly one canonical RepoDigest and the locked runtime Config.Env', async () => {
    const matching = `${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}`;
    await rejectSelection(validLock(), {
      builderImage: { available: true, validated: true, reference: BUILDER_REFERENCE, repoDigests: [matching, matching], imageId: DOCKER_IMAGE_ID, configEnv: RUNTIME_ENV },
    }, 'BUILDER_IMAGE_DIGEST_INVALID');
    await rejectSelection(validLock(), {
      builderImage: { available: true, validated: true, reference: BUILDER_REFERENCE, repoDigests: [matching], imageId: DOCKER_IMAGE_ID, configEnv: ['PATH=/bin'] },
    }, 'BUILDER_RUNTIME_ENV_INVALID');
    await rejectSelection(validLock(), {
      productionImageValidation: async () => ({ reference: BUILDER_REFERENCE, imageId: DOCKER_IMAGE_ID, imageDigest: IMAGE_DIGEST, repoDigests: [matching], configEnv: ['PATH=/bin'], validationEvidenceSha256: EVIDENCE_SHA256 }),
    }, 'BUILDER_RUNTIME_ENV_INVALID');
    await expect(validateInstallerSelection(validLock(), validDependencies({
      builderImage: {
        available: true,
        validated: true,
        reference: BUILDER_REFERENCE,
        repoDigests: [`other.example.invalid/builder@sha256:${digest('1')}`, matching],
        imageId: DOCKER_IMAGE_ID,
        configEnv: RUNTIME_ENV,
      },
    }))).resolves.toMatchObject({ reference: BUILDER_REFERENCE });
  });

  it('uses the canonical digest-qualified reference for service-user inspect and reruns production validation', async () => {
    const calls: string[] = [];
    const dependencies = validDependencies({
      serviceUser: { inspect: async (reference: string) => { calls.push(`service:${reference}`); return { available: true, reference, imageId: DOCKER_IMAGE_ID, repoDigests: [`${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}`], configEnv: RUNTIME_ENV }; } },
      productionImageValidation: async (reference: string) => { calls.push(`production:${reference}`); return { reference, imageId: DOCKER_IMAGE_ID, imageDigest: IMAGE_DIGEST, repoDigests: [`${IMAGE_REPOSITORY}@sha256:${IMAGE_DIGEST}`], configEnv: RUNTIME_ENV, validationEvidenceSha256: EVIDENCE_SHA256 }; },
    });
    await expect(validateInstallerSelection(validLock(), dependencies)).resolves.toMatchObject({ reference: BUILDER_REFERENCE });
    expect(calls).toEqual([`service:${BUILDER_REFERENCE}`, `production:${BUILDER_REFERENCE}`]);
  });

  it('rejects an unavailable image, service-user inspect denial, publisher self-test failure, or host probe failure', async () => {
    await rejectSelection(validLock(), { builderImage: { available: false, code: 'BUILDER_IMAGE_MISSING', validated: false } }, 'DOCKER_UNAVAILABLE');
    await rejectSelection(validLock(), { serviceUser: { inspect: async () => ({ available: false, code: 'SERVICE_USER_INSPECT_DENIED' }) } }, 'DOCKER_UNAVAILABLE');
    await rejectSelection(validLock(), { publisher: { selfTest: async () => ({ available: false, code: 'PUBLISHER_SELF_TEST_MISSING' }) } }, 'PUBLISHER_SELF_TEST_MISSING');
    await rejectSelection(validLock(), { hostProbes: async () => ({ available: false, code: 'GCC_MISSING', detail: 'required compiler is unavailable', mutation: 'none' }) }, 'GCC_MISSING');
    await rejectSelection(validLock(), { publisher: undefined }, 'PUBLISHER_SELF_TEST_MISSING');
    await rejectSelection(validLock(), { hostProbes: undefined }, 'HOST_PREREQUISITES_MISSING');
    await rejectSelection(validLock(), { source: undefined }, 'BUILDER_SOURCE_DRIFT');
  });

  it('generates installable production locks with exactly the required keys plus permitted optional keys', () => {
    const lock = createProductionBuilderLock({
      packageVersion: VERSION,
      imageRepository: IMAGE_REPOSITORY,
      imageDigest: IMAGE_DIGEST,
      baseImage: `docker.io/library/debian@sha256:${BASE_IMAGE_DIGEST}`,
      baseImageDigest: BASE_IMAGE_DIGEST,
      dockerfileSha256: DOCKERFILE_SHA256,
      packageSet: validLock().packageSet,
      rustConfig: validLock().rustConfig,
      nodeVersion: '22.14.0',
      executionDefinitionSha256: EXECUTION_DEFINITION_SHA256,
      dependencyEgressProxySha256: DEPENDENCY_EGRESS_PROXY_SHA256,
      validationEvidenceSha256: EVIDENCE_SHA256,
      publisherSha256: digest('9'),
      imageId: IMAGE_ID,
    });

    expect(lock.installable).toBe(true);
    expect(lock.imageId).toBe(IMAGE_ID);
    expect(Object.keys(lock).sort()).toEqual([...BUILDER_LOCK_REQUIRED_KEYS, ...BUILDER_LOCK_OPTIONAL_KEYS].sort());
    expect(() => createProductionBuilderLock({ ...lock, unexpected: true })).toThrow(/unexpected|lock/i);
    expect(() => createProductionBuilderLock({ ...lock, schemaVersion: 0 })).toThrow(/schema/i);
  });
});
