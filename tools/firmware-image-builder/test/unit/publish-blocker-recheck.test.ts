import { describe, expect, it, vi } from 'vitest';

import type { JobRecord } from '../../api/src/store.js';
import type { ApiWriteCommand, OwnershipResult } from '../../api/src/ownership.js';
import type { PublisherResponse } from '../../publisher/client.js';
import {
  PublishBlockerRecheckError,
  createPublishBlockerRecheckService,
  type FinalDestinationEvidence,
} from '../../api/src/publish-blocker-recheck.js';

const JOB_ID = 'recheck-job';
const SHA40 = 'a'.repeat(40);
const ARTIFACT_SHA = 'b'.repeat(64);
const CHECKSUM_SHA = 'c'.repeat(64);
const MANIFEST_SHA = 'd'.repeat(64);
const VERIFICATION_SHA = 'e'.repeat(64);
const ARTIFACT_MTIME = '2026-07-26T08:00:00.000Z';
const AT = '2026-07-26T09:00:00.000Z';
const VERIFIER_AT = '2026-07-26T09:00:01.000Z';
const COMMAND_AT = '2026-07-26T09:00:02.000Z';
const FINAL_DIRECTORY = `design%2Fagrolink/${SHA40}/rpi-5`;
const FINAL_PATH = `${FINAL_DIRECTORY}/factory.img.gz`;

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: JOB_ID,
    rootId: 'sdcard-images',
    branch: 'design/agrolink',
    pinnedSha: SHA40,
    targetId: 'rpi-5',
    state: 'failed',
    publishState: 'blocked',
    publishBlockerCode: 'UNVERIFIED_FINAL_PATH_BLOCKER',
    publishBlocker: {
      code: 'UNVERIFIED_FINAL_PATH_BLOCKER',
      binding: {
        jobId: JOB_ID,
        rootId: 'sdcard-images',
        branch: 'design/agrolink',
        branchSlug: 'design%2Fagrolink',
        pinnedSha: SHA40,
        targetId: 'rpi-5',
        stagingDirectory: `staging/${JOB_ID}`,
        stagingPath: `staging/${JOB_ID}/factory.img.gz`,
        finalDirectory: FINAL_DIRECTORY,
        finalPath: FINAL_PATH,
        artifactSha256: ARTIFACT_SHA,
        artifactSize: 123,
      },
      staging: 'absent',
    },
    artifactStagingPath: null,
    artifactQuarantinePath: null,
    artifactSha256: ARTIFACT_SHA,
    artifactSize: 123,
    artifactMtime: ARTIFACT_MTIME,
    checksumPath: `staging/${JOB_ID}/sha256sums`,
    checksumSha256: CHECKSUM_SHA,
    manifestPath: `staging/${JOB_ID}/build-manifest.json`,
    manifestSha256: MANIFEST_SHA,
    verificationPath: `staging/${JOB_ID}/verification.json`,
    verificationSha256: VERIFICATION_SHA,
    ...overrides,
  } as JobRecord;
}

function publisher(overrides: Partial<PublisherResponse> = {}): PublisherResponse {
  return {
    available: true,
    published: false,
    quarantined: false,
    selfTest: false,
    mutationCount: 0,
    destination: 'absent',
    staging: 'absent',
    errorCode: 'PUBLISH_RECOVERY_FAILED',
    ...overrides,
  };
}

function finalEvidence(overrides: Partial<FinalDestinationEvidence> = {}): FinalDestinationEvidence {
  return {
    sealStatus: 'sealed',
    finalDirectory: FINAL_DIRECTORY,
    finalPath: FINAL_PATH,
    artifact: { sha256: ARTIFACT_SHA, size: 123, mtime: ARTIFACT_MTIME },
    checksum: { path: `${FINAL_DIRECTORY}/sha256sums`, sha256: CHECKSUM_SHA },
    manifest: { path: `${FINAL_DIRECTORY}/build-manifest.json`, sha256: MANIFEST_SHA },
    verification: { path: `${FINAL_DIRECTORY}/verification.json`, sha256: VERIFICATION_SHA },
    staging: { path: `staging/${JOB_ID}`, state: 'absent' },
    ...overrides,
  };
}

function committed(): OwnershipResult {
  return { ok: true, kind: 'committed', eventSeq: 12, value: undefined };
}

function fixture(options: {
  readonly storedJob?: JobRecord;
  readonly response?: PublisherResponse;
  readonly publisherError?: Error;
  readonly evidence?: FinalDestinationEvidence;
  readonly verifierError?: Error;
  readonly beforeVerify?: () => void;
  readonly ownershipResult?: OwnershipResult;
  readonly clockTimes?: readonly string[];
} = {}) {
  const clockTimes = options.clockTimes ?? [AT];
  let clockIndex = 0;
  const now = vi.fn(() => clockTimes[Math.min(clockIndex++, clockTimes.length - 1)]!);
  const getJob = vi.fn(() => options.storedJob ?? job());
  const recheck = vi.fn(async () => {
    if (options.publisherError) throw options.publisherError;
    return options.response ?? publisher();
  });
  const verify = vi.fn(async () => {
    options.beforeVerify?.();
    if (options.verifierError) throw options.verifierError;
    return options.evidence ?? finalEvidence();
  });
  const apiWrite = vi.fn((_command: ApiWriteCommand) => options.ownershipResult ?? committed());
  return {
    getJob,
    recheck,
    verify,
    apiWrite,
    service: createPublishBlockerRecheckService({
      store: { getJob },
      publisher: { recheck },
      verifier: { verify },
      ownership: { apiWrite },
      clock: { now },
    }),
    now,
  };
}

describe('publish blocker recheck service', () => {
  it('clears only an independently absent destination and derives the publisher request from the job', async () => {
    const target = fixture();

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toEqual({
      kind: 'cleared-absent',
      jobId: JOB_ID,
      eventSeq: 12,
    });
    expect(target.recheck).toHaveBeenCalledTimes(1);
    expect(target.recheck).toHaveBeenCalledWith({
      rootId: 'sdcard-images',
      jobId: JOB_ID,
      branchSlug: 'design%2Fagrolink',
      sourceSha: SHA40,
      targetId: 'rpi-5',
    });
    expect(target.verify).not.toHaveBeenCalled();
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'publish-blocker-recheck',
      resolution: 'clear-absent',
      proof: {
        kind: 'destination-absent',
        observedAt: AT,
        publisher: { destination: 'absent', staging: 'absent', mutationCount: 0 },
        finalDirectory: FINAL_DIRECTORY,
        finalPath: FINAL_PATH,
      },
    }));
  });

  it('marks a held matching destination published only after exact final evidence verification', async () => {
    const target = fixture({
      response: publisher({ destination: 'candidate', staging: 'absent', errorCode: undefined }),
    });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toEqual({
      kind: 'marked-published',
      jobId: JOB_ID,
      eventSeq: 12,
    });
    expect(target.verify).toHaveBeenCalledTimes(1);
    expect(target.verify).toHaveBeenCalledWith(expect.objectContaining({
      job: expect.objectContaining({ jobId: JOB_ID, pinnedSha: SHA40 }),
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
    }));
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      resolution: 'mark-published',
      proof: expect.objectContaining({
        kind: 'destination-matches',
        sealStatus: 'sealed',
        artifact: { sha256: ARTIFACT_SHA, size: 123, mtime: ARTIFACT_MTIME },
        checksum: { path: `${FINAL_DIRECTORY}/sha256sums`, sha256: CHECKSUM_SHA },
        manifest: { path: `${FINAL_DIRECTORY}/build-manifest.json`, sha256: MANIFEST_SHA },
        verification: { path: `${FINAL_DIRECTORY}/verification.json`, sha256: VERIFICATION_SHA },
        staging: { path: `staging/${JOB_ID}`, state: 'absent' },
      }),
    }));
  });

  it('propagates an interrupted writable candidate without claiming it is sealed', async () => {
    const target = fixture({
      response: publisher({ destination: 'candidate', staging: 'absent', errorCode: undefined }),
      evidence: finalEvidence({ sealStatus: 'in_progress' }),
    });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toMatchObject({ kind: 'marked-published' });
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      resolution: 'mark-published',
      proof: expect.objectContaining({ kind: 'destination-matches', sealStatus: 'in_progress' }),
    }));
  });

  it('timestamps final evidence after both physical inspections and commits afterward', async () => {
    const target = fixture({
      response: publisher({ destination: 'candidate', staging: 'absent', errorCode: undefined }),
      clockTimes: [AT, VERIFIER_AT, COMMAND_AT],
    });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toMatchObject({ kind: 'marked-published', eventSeq: 12 });
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      at: COMMAND_AT,
      proof: expect.objectContaining({
        kind: 'destination-matches',
        observedAt: VERIFIER_AT,
      }),
    }));
  });

  it.each([
    ['destination-mismatched', publisher({ destination: 'mismatched', staging: 'absent', errorCode: 'UNVERIFIED_FINAL_PATH_BLOCKER' })],
    ['staging-present', publisher({ destination: 'absent', staging: 'present', errorCode: 'PUBLISH_RECOVERY_FAILED' })],
  ] as const)('retains the blocker for %s without invoking the final verifier', async (reason, response) => {
    const target = fixture({ response });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toEqual({
      kind: 'retained-blocker',
      jobId: JOB_ID,
      eventSeq: 12,
    });
    expect(target.verify).not.toHaveBeenCalled();
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      resolution: 'retain-blocker',
      proof: expect.objectContaining({ kind: 'retained-blocker', reason }),
    }));
  });

  it('records publisher unavailability as an uncertain retained blocker', async () => {
    const target = fixture({ publisherError: new Error('publisher unavailable') });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toEqual({
      kind: 'retained-blocker',
      jobId: JOB_ID,
      eventSeq: 12,
    });
    expect(target.recheck).toHaveBeenCalledTimes(1);
    expect(target.verify).not.toHaveBeenCalled();
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      proof: expect.objectContaining({
        reason: 'publisher-unavailable',
        publisher: { destination: 'unknown', staging: 'unknown', mutationCount: 0 },
      }),
    }));
  });

  it.each([
    ['verifier failure', { verifierError: new Error('held path changed') }],
    ['artifact mismatch', { evidence: finalEvidence({ artifact: { sha256: 'f'.repeat(64), size: 123, mtime: ARTIFACT_MTIME } }) }],
  ] as const)('retains a candidate with incomplete evidence after %s', async (_description, failure) => {
    const target = fixture({
      response: publisher({ destination: 'candidate', staging: 'absent', errorCode: undefined }),
      ...failure,
    });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toEqual({
      kind: 'retained-blocker',
      jobId: JOB_ID,
      eventSeq: 12,
    });
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      resolution: 'retain-blocker',
      proof: expect.objectContaining({
        reason: 'incomplete-evidence',
        publisher: { destination: 'candidate', staging: 'absent', mutationCount: 0 },
      }),
    }));
  });

  it('does not mark a candidate published when staging reappears during final verification', async () => {
    const target = fixture({
      response: publisher({ destination: 'candidate', staging: 'absent', errorCode: undefined }),
      evidence: finalEvidence({ staging: { path: `staging/${JOB_ID}`, state: 'present' } }),
    });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toEqual({
      kind: 'retained-blocker',
      jobId: JOB_ID,
      eventSeq: 12,
    });
    expect(target.apiWrite).toHaveBeenCalledWith(expect.objectContaining({
      resolution: 'retain-blocker',
      proof: expect.objectContaining({ reason: 'incomplete-evidence' }),
    }));
  });

  it('does not commit a retained blocker after the request deadline aborts verification', async () => {
    const controller = new AbortController();
    const deadline = new Error('request deadline exceeded');
    const target = fixture({
      response: publisher({ destination: 'candidate', staging: 'absent', errorCode: undefined }),
      beforeVerify: () => controller.abort(deadline),
      verifierError: new Error('verification interrupted'),
    });

    await expect(target.service.recheck({
      jobId: JOB_ID,
      signal: controller.signal,
    })).rejects.toBe(deadline);
    expect(target.apiWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['mutating publisher response', job(), publisher({ mutationCount: 1 })],
    ['unavailable publisher with a mutating outcome', job(), publisher({
      available: false,
      published: true,
      errorCode: 'PUBLISHER_UNSUPPORTED',
      destination: undefined,
      staging: undefined,
    })],
    ['invalid durable binding', job({
      publishBlocker: {
        binding: {
          ...(job().publishBlocker!.binding as Record<string, unknown>),
          finalPath: 'other/image.img.gz',
        },
      },
    }), publisher()],
    ['contradictory publisher response', job(), publisher({ destination: 'candidate', staging: 'absent', errorCode: 'PUBLISH_RECOVERY_FAILED' })],
    ['unknown staging on a known destination', job(), publisher({ destination: 'absent', staging: 'unknown' })],
    ['available publisher with forbidden rename evidence', job(), publisher({
      destination: 'candidate',
      staging: 'absent',
      errorCode: undefined,
      renameResult: 'RENAMED',
    })],
  ] as const)('fails closed for %s without writing ownership', async (_description, storedJob, response) => {
    const target = fixture({ storedJob, response });

    await expect(target.service.recheck({ jobId: JOB_ID })).rejects.toBeInstanceOf(PublishBlockerRecheckError);
    expect(target.apiWrite).not.toHaveBeenCalled();
    expect(target.recheck).toHaveBeenCalledTimes(_description === 'invalid durable binding' ? 0 : 1);
  });

  it('returns an ownership conflict without claiming a completed resolution', async () => {
    const target = fixture({
      ownershipResult: {
        ok: false,
        conflict: { kind: 'cas-lost', message: 'predecessor changed' },
      },
    });

    await expect(target.service.recheck({ jobId: JOB_ID })).resolves.toEqual({
      kind: 'conflict',
      jobId: JOB_ID,
      conflict: { kind: 'cas-lost', message: 'predecessor changed' },
    });
    expect(target.recheck).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['negative', -1],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('fails closed when ownership reports a malformed committed event sequence (%s)', async (_description, eventSeq) => {
    const target = fixture({ ownershipResult: { ok: true, kind: 'committed', eventSeq, value: undefined } });

    await expect(target.service.recheck({ jobId: JOB_ID })).rejects.toMatchObject({
      code: 'OWNERSHIP_NOT_COMMITTED',
    });
  });
});
