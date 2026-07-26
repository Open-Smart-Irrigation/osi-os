import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  mkdtemp,
  open,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  parseRunnerArguments,
  resolveTrustedOperationRequest,
  runRunner,
  stageVerifiedArtifact,
} from '../../runner/src/main.js';
import { createOperationDefinition } from '../../runner/src/operation-registry.js';
import {
  recoverPublishing,
  validatePublicationBinding,
  type FinalPublicationProof,
  type PublicationBinding,
} from '../../runner/src/pipeline.js';
import type {
  PublisherClient,
  PublisherRequest,
  PublisherResponse,
} from '../../publisher/client.js';

const SHA40 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);
const PUBLISHER_SHA = 'c'.repeat(64);
const JOB_ID = 'job-pipeline-unit';

describe('production runner composition', () => {
  it('constructs its own production pipeline instead of accepting a bootstrap', () => {
    expect(runRunner).toHaveLength(1);
  });

  it('stages and hashes a real artifact through a readable held descriptor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-pipeline-artifact-'));
    const workspace = join(directory, 'workspace');
    const staging = join(directory, 'staging');
    const artifactPath = join(workspace, 'factory.img.gz');
    const bytes = Buffer.from('real staged firmware bytes');
    const timestamp = new Date('2026-07-26T12:00:00.000Z');
    await Promise.all([
      import('node:fs/promises').then(({ mkdir }) => mkdir(workspace)),
      import('node:fs/promises').then(({ mkdir }) => mkdir(staging)),
    ]);
    await writeFile(artifactPath, bytes);
    await utimes(artifactPath, timestamp, timestamp);
    const stagingHandle = await open(
      staging,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await expect(stageVerifiedArtifact(
        workspace,
        'factory.img.gz',
        stagingHandle,
        'factory.img.gz',
        {
          path: 'factory.img.gz',
          basename: 'factory.img.gz',
          size: bytes.byteLength,
          mtime: timestamp.toISOString(),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          gzip: true,
        },
      )).resolves.toMatchObject({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
        mtime: timestamp.toISOString(),
      });
      await expect(readFile(join(staging, 'factory.img.gz'))).resolves.toEqual(bytes);
    } finally {
      await stagingHandle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts only the exact systemd runner argument contract', () => {
    expect(() => parseRunnerArguments([
      '--job-id', JOB_ID,
      '--runner-unit', `osi-image-builder-runner@${JOB_ID}.service`,
      '--owner', 'runner',
      '--lease-expires-at', '2026-07-26T12:00:00.000Z',
      '--bootstrap', '/tmp/untrusted.mjs',
    ])).toThrow(/unknown runner argument/i);
  });

  it('executes a held target-setup definition in the profile that produced it', () => {
    const selectedEnvironment = 'full_raspberrypi_bcm27xx_bcm2712';
    const otherEnvironment = 'full_raspberrypi_bcm27xx_bcm2709';
    const definition = createOperationDefinition('activate-target', {
      environment: otherEnvironment,
    });

    expect(resolveTrustedOperationRequest({
      operationId: 'activate-target',
      requestedDefinition: definition,
      selectedEnvironment,
      allowedEnvironments: [selectedEnvironment, otherEnvironment],
      activeTargetSetupEnvironment: null,
    })).toEqual({
      definition,
      environment: otherEnvironment,
    });
  });

  it('rejects forged and out-of-sequence target-setup definitions', () => {
    const selectedEnvironment = 'full_raspberrypi_bcm27xx_bcm2712';
    const otherEnvironment = 'full_raspberrypi_bcm27xx_bcm2709';
    const allowedEnvironments = [selectedEnvironment, otherEnvironment];

    expect(() => resolveTrustedOperationRequest({
      operationId: 'activate-target',
      requestedDefinition: {
        argv: ['make', 'switch-env', 'ENV=forged'],
        workingDirectory: '/workdir',
      },
      selectedEnvironment,
      allowedEnvironments,
      activeTargetSetupEnvironment: null,
    })).toThrow(/trusted target manifest/i);

    expect(() => resolveTrustedOperationRequest({
      operationId: 'copy-feed-config',
      requestedDefinition: createOperationDefinition('copy-feed-config', {
        environment: otherEnvironment,
      }),
      selectedEnvironment,
      allowedEnvironments,
      activeTargetSetupEnvironment: null,
    })).toThrow(/active target profile/i);
  });
});

const request: PublisherRequest = Object.freeze({
  rootId: 'release',
  jobId: JOB_ID,
  branchSlug: 'design%2Fagrolink',
  sourceSha: SHA40,
  targetId: 'rpi-5',
});

const binding: PublicationBinding = Object.freeze({
  jobId: JOB_ID,
  rootId: 'release',
  rootPath: '/srv/osi-images',
  rootDevice: 11,
  rootInode: 22,
  branch: 'design/agrolink',
  branchSlug: request.branchSlug,
  pinnedSha: SHA40,
  targetId: 'rpi-5',
  stagingDirectory: `staging/${JOB_ID}`,
  stagingPath: `staging/${JOB_ID}/factory.img.gz`,
  finalDirectory: `${request.branchSlug}/${SHA40}/rpi-5`,
  finalPath: `${request.branchSlug}/${SHA40}/rpi-5/factory.img.gz`,
  artifactSha256: SHA256,
  artifactSize: 100,
});

const publishEvidence = Object.freeze({
  publisherVersion: '0.1.0',
  publisherSourceSha256: PUBLISHER_SHA,
  sourceRelativePath: `.osi-image-builder/staging/${JOB_ID}`,
  destinationRelativePath: binding.finalDirectory,
});

function response(
  value: Partial<PublisherResponse> = {},
): PublisherResponse {
  return {
    available: true,
    published: false,
    quarantined: false,
    selfTest: false,
    mutationCount: 0,
    ...value,
  };
}

function proof(): FinalPublicationProof {
  return Object.freeze({
    finalPath: binding.finalPath,
    artifactSha256: SHA256,
    artifactSize: 100,
    checksumPath: `${binding.finalDirectory}/sha256sums`,
    checksumSha256: 'd'.repeat(64),
    manifestPath: `${binding.finalDirectory}/build-manifest.json`,
    manifestSha256: 'e'.repeat(64),
    verificationPath: `${binding.finalDirectory}/verification.json`,
    verificationSha256: 'f'.repeat(64),
    staging: 'absent',
    verified: true,
  });
}

function publisher(overrides: Partial<PublisherClient> = {}): PublisherClient {
  return {
    publish: vi.fn(async () => response()),
    recheck: vi.fn(async () => response({
      destination: 'candidate',
      staging: 'absent',
    })),
    quarantine: vi.fn(async () => response({
      quarantined: true,
      mutationCount: 2,
      renameResult: 'RENAMED',
      ...publishEvidence,
      destinationRelativePath: `.osi-image-builder/quarantine/${JOB_ID}`,
    })),
    ...overrides,
  };
}

describe('publication binding', () => {
  it.each([
    ['jobId', { jobId: 'job-other' }],
    ['rootId', { rootId: 'other' }],
    ['root identity', { rootInode: 23 }],
    ['branch', { branch: 'main' }],
    ['branch slug', { branchSlug: 'main' }],
    ['SHA', { pinnedSha: '1'.repeat(40) }],
    ['target', { targetId: 'rpi-2' as const }],
    ['staging path', { stagingPath: `staging/${JOB_ID}/other.img.gz` }],
    ['final path', { finalPath: `${binding.finalDirectory}/other.img.gz` }],
  ])('rejects a %s mismatch before publication', (_field, changed) => {
    const native = vi.fn();
    expect(() => validatePublicationBinding({
      persisted: binding,
      candidate: { ...binding, ...changed },
      request,
    })).toThrow(/publication binding/i);
    expect(native).not.toHaveBeenCalled();
  });

  it('accepts only the exact persisted job, root, source, target, and paths', () => {
    expect(validatePublicationBinding({
      persisted: binding,
      candidate: binding,
      request,
    })).toEqual(binding);
  });
});

describe('native publication recovery', () => {
  it('rechecks post-rename ambiguity and accepts only a complete held final proof', async () => {
    const native = publisher();
    const verifyFinal = vi.fn(async () => proof());
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: false,
        mutationCount: 3,
        errorCode: 'PUBLISH_FAILED',
        renameResult: 'RENAMED',
        ...publishEvidence,
      }),
      verifyFinal,
    })).resolves.toEqual({
      kind: 'complete',
      response: expect.objectContaining({ destination: 'candidate', staging: 'absent' }),
      proof: proof(),
      recovered: true,
    });
    expect(native.recheck).toHaveBeenCalledOnce();
    expect(native.quarantine).not.toHaveBeenCalled();
    expect(verifyFinal).toHaveBeenCalledOnce();
  });

  it('quarantines only after recheck proves final absence and surviving staging', async () => {
    const native = publisher({
      recheck: vi.fn(async () => response({
        destination: 'absent',
        staging: 'present',
        errorCode: 'PUBLISH_RECOVERY_FAILED',
      })),
    });
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: false,
        mutationCount: 3,
        errorCode: 'PUBLISH_FAILED',
        renameResult: 'RENAMED',
        ...publishEvidence,
      }),
      verifyFinal: async () => proof(),
    })).resolves.toMatchObject({
      kind: 'blocked',
      code: 'PUBLISH_RECOVERY_FAILED',
      staging: 'quarantined',
      quarantine: {
        quarantined: true,
        renameResult: 'RENAMED',
      },
    });
    expect(native.quarantine).toHaveBeenCalledWith({
      rootId: request.rootId,
      jobId: request.jobId,
    });
  });

  it('retains a quarantine blocker when the helper cannot prove the move', async () => {
    const native = publisher({
      recheck: vi.fn(async () => response({
        destination: 'absent',
        staging: 'present',
        errorCode: 'PUBLISH_RECOVERY_FAILED',
      })),
      quarantine: vi.fn(async () => response({
        errorCode: 'QUARANTINE_PENDING',
      })),
    });
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: false,
        mutationCount: 3,
        errorCode: 'PUBLISH_FAILED',
        renameResult: 'RENAMED',
        ...publishEvidence,
      }),
      verifyFinal: async () => proof(),
    })).resolves.toMatchObject({
      kind: 'blocked',
      code: 'QUARANTINE_PENDING',
      staging: 'present',
    });
  });

  it('does not claim staging survives an ambiguous quarantine rename', async () => {
    const native = publisher({
      recheck: vi.fn(async () => response({
        destination: 'absent',
        staging: 'present',
        errorCode: 'PUBLISH_RECOVERY_FAILED',
      })),
      quarantine: vi.fn(async () => response({
        errorCode: 'QUARANTINE_PENDING',
        mutationCount: 1,
        renameResult: 'RENAMED',
        ...publishEvidence,
        destinationRelativePath: `.osi-image-builder/quarantine/${JOB_ID}`,
      })),
    });
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: false,
        mutationCount: 3,
        errorCode: 'PUBLISH_FAILED',
        renameResult: 'RENAMED',
        ...publishEvidence,
      }),
      verifyFinal: async () => proof(),
    })).resolves.toMatchObject({
      kind: 'blocked',
      code: 'QUARANTINE_PENDING',
      staging: 'unknown',
      quarantine: {
        renameResult: 'RENAMED',
      },
    });
  });

  it.each([
    [
      'mismatched final',
      response({
        destination: 'mismatched',
        staging: 'present',
        errorCode: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      }),
      'UNVERIFIED_FINAL_PATH_BLOCKER',
      'unknown',
    ],
    [
      'absent final and absent staging',
      response({
        destination: 'absent',
        staging: 'absent',
        errorCode: 'PUBLISH_RECOVERY_FAILED',
      }),
      'PUBLISH_RECOVERY_FAILED',
      'absent',
    ],
    [
      'unknown native outcome',
      response({
        destination: 'unknown',
        staging: 'unknown',
        errorCode: 'PUBLISH_RECOVERY_FAILED',
      }),
      'PUBLISH_RECOVERY_FAILED',
      'unknown',
    ],
  ] as const)('persists a blocker for %s without inventing a move', async (
    _name,
    recheck,
    code,
    staging,
  ) => {
    const native = publisher({ recheck: vi.fn(async () => recheck) });
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: false,
        mutationCount: 3,
        errorCode: 'PUBLISH_FAILED',
        renameResult: 'RENAMED',
        ...publishEvidence,
      }),
      verifyFinal: async () => proof(),
    })).resolves.toMatchObject({ kind: 'blocked', code, staging });
    expect(native.quarantine).not.toHaveBeenCalled();
  });

  it.each([
    ['recheck', publisher({
      recheck: vi.fn(async () => {
        throw new Error('recheck transport failed');
      }),
    }), 'PUBLISH_RECOVERY_FAILED'],
    ['quarantine', publisher({
      recheck: vi.fn(async () => response({
        destination: 'absent',
        staging: 'present',
        errorCode: 'PUBLISH_RECOVERY_FAILED',
      })),
      quarantine: vi.fn(async () => {
        throw new Error('quarantine transport failed');
      }),
    }), 'QUARANTINE_PENDING'],
  ] as const)('retains an explicit unknown blocker when native %s throws', async (
    phase,
    native,
    code,
  ) => {
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: false,
        mutationCount: 3,
        errorCode: 'PUBLISH_FAILED',
        renameResult: 'RENAMED',
        ...publishEvidence,
      }),
      verifyFinal: async () => proof(),
    })).resolves.toMatchObject({
      kind: 'blocked',
      code,
      staging: 'unknown',
      nativeFailures: [{ phase }],
    });
  });

  it('classifies EEXIST as an immutable output collision without recheck', async () => {
    const native = publisher();
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        errorCode: 'OUTPUT_COLLISION',
        renameResult: 'EEXIST',
        ...publishEvidence,
      }),
      verifyFinal: async () => proof(),
    })).resolves.toEqual({
      kind: 'blocked',
      code: 'OUTPUT_COLLISION',
      staging: 'present',
      response: expect.objectContaining({ renameResult: 'EEXIST' }),
    });
    expect(native.recheck).not.toHaveBeenCalled();
    expect(native.quarantine).not.toHaveBeenCalled();
  });

  it('rejects a forged native source or destination path before recheck', async () => {
    const native = publisher();
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: false,
        mutationCount: 3,
        errorCode: 'PUBLISH_FAILED',
        renameResult: 'RENAMED',
        ...publishEvidence,
        destinationRelativePath: 'main/forged/rpi-5',
      }),
      verifyFinal: async () => proof(),
    })).rejects.toThrow(/publisher.*path/i);
    expect(native.recheck).not.toHaveBeenCalled();
  });

  it('returns an explicit blocker when final proof differs after rename', async () => {
    const native = publisher();
    await expect(recoverPublishing({
      publisher: native,
      request,
      binding,
      response: response({
        published: true,
        mutationCount: 3,
        renameResult: 'RENAMED',
        ...publishEvidence,
      }),
      verifyFinal: async () => ({
        ...proof(),
        artifactSha256: createHash('sha256').update('tampered').digest('hex'),
      }),
    })).resolves.toMatchObject({
      kind: 'blocked',
      code: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      staging: 'absent',
      response: {
        published: true,
        renameResult: 'RENAMED',
      },
    });
  });
});
