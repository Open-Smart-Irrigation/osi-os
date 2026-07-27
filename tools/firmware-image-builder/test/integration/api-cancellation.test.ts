import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { BuilderStore, type CreateJobInput } from '../../api/src/store.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import { requestCancellation, type ApiCancellationClock, type ApiCancellationSystemd } from '../../api/src/cancellation.js';

const NOW = '2026-07-27T12:00:00.000Z';
const LATER = '2026-07-27T12:00:01.000Z';
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const directories: string[] = [];

function sourcePreparation() {
  return {
    schemaVersion: 1 as const,
    sourceSha: SHA40,
    gitmodulesBlobSha: 'c'.repeat(40),
    preparedAt: NOW,
    components: [
      { path: 'feeds/chirpstack-openwrt-feed' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'd'.repeat(40), provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git' },
      { path: 'openwrt' as const, mode: '040000' as const, type: 'tree' as const, objectId: 'e'.repeat(40), provenanceUrl: 'https://github.com/openwrt/openwrt.git' },
    ],
  };
}

function offlineFeeds(jobId: string) {
  const recursiveSubmoduleStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  return {
    schemaVersion: 1 as const,
    boundary: 'api-prepared-pinned-feeds-v1' as const,
    networkPolicy: 'runner-offline' as const,
    jobId,
    sourceSha: SHA40,
    preparedAt: NOW,
    feeds: [
      { name: 'packages', location: 'https://git.openwrt.org/feed/packages.git', commit: 'd8cd30f4e281d6853b3de134c4f147a807583e43', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
      { name: 'luci', location: 'https://git.openwrt.org/project/luci.git', commit: '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
      { name: 'routing', location: 'https://git.openwrt.org/feed/routing.git', commit: 'c9b636698881059a3c981032770968f5a98ff201', detached: true as const, clean: true as const, recursiveSubmodulesPrepared: true as const, recursiveSubmodules: [], recursiveSubmoduleStatusSha256, treeSha256: SHA64 },
    ],
  };
}

function input(jobId: string): CreateJobInput {
  return {
    jobId,
    requestId: `request-${jobId}`,
    request: { branch: 'main', target: 'rpi-5' },
    sourceRemote: 'git@example.com:osi-os.git',
    sourceRef: 'refs/remotes/origin/main',
    sourceBranch: 'main',
    branch: 'main',
    expectedSha: SHA40,
    pinnedSha: SHA40,
    sourcePreparation: sourcePreparation(),
    offlineFeedPreparation: offlineFeeds(jobId),
    targetId: 'rpi-5',
    rootId: 'release',
    targetManifestSha256: SHA64,
    sourceCommitTime: NOW,
    sourceAuthor: 'API test',
    sourceSubject: 'API cancellation',
    acceptedAt: NOW,
  };
}

function clock(): ApiCancellationClock {
  let monotonic = 0;
  return {
    now: () => NOW,
    monotonicNow: () => monotonic,
    sleep: async (milliseconds) => { monotonic += milliseconds; },
  };
}

function systemd(): ApiCancellationSystemd & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    signalCancellation: vi.fn(async (unit) => { calls.push(['signal', unit]); return { active: true, argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }),
    stopRunner: vi.fn(async (unit) => { calls.push(['stop', unit]); return { active: true, argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }),
    inspectRunner: vi.fn(async (unit) => { calls.push(['inspect', unit]); return { active: true, argv: [], exitCode: 0, signal: null, stdout: 'active\n', stderr: '', timedOut: false }; }),
  };
}

async function fixture(jobIds: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'osi-api-cancellation-'));
  directories.push(directory);
  const db = openBuilderDatabase(join(directory, 'jobs.sqlite'));
  const ownership = new OwnershipStore(db, { now: () => NOW });
  const store = new BuilderStore(db);
  for (const jobId of jobIds) expect(ownership.apiWrite({ kind: 'enqueue', input: input(jobId) }).ok).toBe(true);
  return { db, ownership, store };
}

function toPublishing(fixtureValue: Awaited<ReturnType<typeof fixture>>, jobId: string): void {
  const unit = `osi-image-builder-runner@${jobId}.service`;
  const owner = 'runner-publishing';
  const leaseExpiresAt = '2026-07-27T12:10:00.000Z';
  expect(fixtureValue.ownership.apiWrite({ kind: 'dispatch', jobId, runnerUnit: unit, at: LATER }).ok).toBe(true);
  expect(fixtureValue.ownership.runnerWrite({ kind: 'acquire-lease', jobId, runnerUnit: unit, owner, expiresAt: leaseExpiresAt, at: LATER }).ok).toBe(true);
  const stages = [
    ['preflight', 'preflight'], ['source', 'source'], ['release-gates', 'release_gates'], ['frontend', 'frontend'],
    ['target-setup', 'target_setup'], ['feeds', 'feeds'], ['config', 'config'], ['build', 'building'], ['verify', 'verifying'],
  ] as const;
  let expectedState: 'starting' | 'preflight' | 'source' | 'release_gates' | 'frontend' | 'target_setup' | 'feeds' | 'config' | 'building' | 'verifying' = 'starting';
  for (const [index, [stage, state]] of stages.entries()) {
    const startedAt = new Date(Date.parse(NOW) + (index + 2) * 1_000).toISOString();
    const finishedAt = new Date(Date.parse(NOW) + (index + 2) * 1_000 + 100).toISOString();
    const at = new Date(Date.parse(NOW) + (index + 2) * 1_000 + 200).toISOString();
    expect(fixtureValue.ownership.runnerWrite({
      kind: 'stage', jobId, owner, runnerUnit: unit, leaseExpiresAt, at,
      expectedState, state, stage, outcome: 'passed', startedAt, finishedAt,
      evidencePath: `jobs/${jobId}/evidence/${String(index).padStart(2, '0')}-${stage}.json`, evidenceSha256: SHA64,
    }).ok).toBe(true);
    expectedState = state;
  }
  const artifactAt = new Date(Date.parse(NOW) + 12_000).toISOString();
  expect(fixtureValue.ownership.runnerWrite({
    kind: 'artifact', jobId, owner, runnerUnit: unit, leaseExpiresAt, at: artifactAt,
    expectedState: 'verifying', state: 'verifying', stagingPath: `staging/${jobId}/image`, artifactSha256: SHA64, artifactSize: 10,
    artifactMtime: new Date(Date.parse(NOW) + 11_000).toISOString(), checksumPath: `staging/${jobId}/sha256sums`, checksumSha256: SHA64,
    manifestPath: `staging/${jobId}/manifest.json`, manifestSha256: SHA64, verificationPath: `staging/${jobId}/verification.json`, verificationSha256: SHA64,
  }).ok).toBe(true);
  const publishStartedAt = new Date(Date.parse(NOW) + 13_000).toISOString();
  expect(fixtureValue.ownership.runnerWrite({
    kind: 'publish-stage-start', jobId, owner, runnerUnit: unit, leaseExpiresAt, at: new Date(Date.parse(NOW) + 14_000).toISOString(),
    expectedState: 'verifying', startedAt: publishStartedAt, publishStartedAt,
    finalDirectory: `release/${jobId}`, finalPath: `release/${jobId}/image`,
  }).ok).toBe(true);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('API cancellation against the durable ownership store', () => {
  it('cancels queued work in one transaction, removes its queue row, and does not start or signal a service', async () => {
    const fixtureValue = await fixture(['queued-a', 'queued-b']);
    const systemdValue = systemd();

    const outcome = await requestCancellation({
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      systemd: systemdValue,
      clock: clock(),
    }, { jobId: 'queued-a', reason: 'operator', at: LATER });

    expect(outcome).toMatchObject({ kind: 'queued-cancelled', state: 'cancelled' });
    expect(fixtureValue.store.getJob('queued-a')).toMatchObject({ state: 'cancelled', queueState: 'cancelled', queuePosition: null, cancelReason: 'operator', terminalErrorCode: 'CANCELLED' });
    expect(fixtureValue.store.getQueuePosition('queued-b')).toBe(0);
    expect((fixtureValue.db.prepare('SELECT COUNT(*) AS count FROM queue_entries WHERE job_id=?').get('queued-a') as { count: number }).count).toBe(0);
    expect(fixtureValue.store.listEvents('queued-a').events.map((event) => event.eventType)).toEqual(['enqueue', 'cancellation_requested', 'terminal']);
    expect(systemdValue.calls).toEqual([]);
  });

  it('persists an active cancellation request, signals the persisted unit, and escalates only after the durable 30+15 second windows', async () => {
    const fixtureValue = await fixture(['active-a']);
    expect(fixtureValue.ownership.apiWrite({ kind: 'dispatch', jobId: 'active-a', runnerUnit: 'osi-image-builder-runner@active-a.service', at: LATER }).ok).toBe(true);
    expect(fixtureValue.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'active-a', runnerUnit: 'osi-image-builder-runner@active-a.service', owner: 'runner-a', expiresAt: '2026-07-27T12:10:00.000Z', at: LATER }).ok).toBe(true);
    const systemdValue = systemd();

    const outcome = await requestCancellation({
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      systemd: systemdValue,
      clock: clock(),
      pollIntervalMs: 15_000,
    }, { jobId: 'active-a', reason: 'operator', at: '2026-07-27T12:00:02.000Z' });

    expect(outcome).toMatchObject({ kind: 'recovery-blocked', blockerCode: 'RUNNER_DISAPPEARED' });
    expect(systemdValue.calls[0]).toEqual(['signal', 'osi-image-builder-runner@active-a.service']);
    expect(systemdValue.calls.some(([kind]) => kind === 'stop')).toBe(true);
    expect(fixtureValue.store.getJob('active-a')).toMatchObject({ state: 'starting', cancelRequestedAt: '2026-07-27T12:00:02.000Z', cleanupBlockerCode: 'RUNNER_DISAPPEARED' });
    expect(fixtureValue.store.listEvents('active-a').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.listEvents('active-a').events.some((event) => event.eventType === 'terminal')).toBe(false);
  });

  it('makes repeated requests idempotent after the request transaction and never gives API a runner terminal write', async () => {
    const fixtureValue = await fixture(['repeat-a']);
    expect(fixtureValue.ownership.apiWrite({ kind: 'dispatch', jobId: 'repeat-a', runnerUnit: 'osi-image-builder-runner@repeat-a.service', at: LATER }).ok).toBe(true);
    const systemdValue = systemd();
    const options = { store: fixtureValue.store, ownership: fixtureValue.ownership, systemd: systemdValue, clock: clock(), cooperativeTimeoutMs: 0, systemdGraceMs: 0, pollIntervalMs: 1 };

    const first = await requestCancellation(options, { jobId: 'repeat-a', reason: 'operator', at: LATER });
    const second = await requestCancellation(options, { jobId: 'repeat-a', reason: 'operator-retry', at: '2026-07-27T12:00:02.000Z' });

    expect(first).toMatchObject({ kind: 'recovery-blocked' });
    expect(second).toMatchObject({ kind: 'recovery-blocked' });
    expect(fixtureValue.store.listEvents('repeat-a').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.listEvents('repeat-a').events.some((event) => event.eventType === 'terminal')).toBe(false);
  });

  it('makes concurrent cancellation requests converge on one durable request event and existing recovery evidence', async () => {
    const fixtureValue = await fixture(['concurrent-a']);
    expect(fixtureValue.ownership.apiWrite({ kind: 'dispatch', jobId: 'concurrent-a', runnerUnit: 'osi-image-builder-runner@concurrent-a.service', at: LATER }).ok).toBe(true);
    expect(fixtureValue.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'concurrent-a', runnerUnit: 'osi-image-builder-runner@concurrent-a.service', owner: 'runner-a', expiresAt: '2026-07-27T12:10:00.000Z', at: LATER }).ok).toBe(true);
    const systemdValue = systemd();
    const base = { store: fixtureValue.store, ownership: fixtureValue.ownership, systemd: systemdValue, cooperativeTimeoutMs: 0, systemdGraceMs: 0, pollIntervalMs: 1 } as const;

    const outcomes = await Promise.all([
      requestCancellation({ ...base, clock: clock() }, { jobId: 'concurrent-a', reason: 'operator-a', at: '2026-07-27T12:00:02.000Z' }),
      requestCancellation({ ...base, clock: clock() }, { jobId: 'concurrent-a', reason: 'operator-b', at: '2026-07-27T12:00:03.000Z' }),
    ]);

    expect(outcomes).toEqual([expect.objectContaining({ kind: 'recovery-blocked' }), expect.objectContaining({ kind: 'recovery-blocked' })]);
    expect(fixtureValue.store.listEvents('concurrent-a').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.getJob('concurrent-a').cleanupBlockerCode).toBe('RUNNER_DISAPPEARED');
  });

  it('durably records a late publishing request and leaves the publisher unit untouched', async () => {
    const fixtureValue = await fixture(['publishing-a']);
    toPublishing(fixtureValue, 'publishing-a');
    const systemdValue = systemd();

    const outcome = await requestCancellation({
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      systemd: systemdValue,
      clock: clock(),
    }, { jobId: 'publishing-a', reason: 'operator', at: '2026-07-27T12:00:15.000Z' });

    expect(outcome).toMatchObject({ kind: 'late-publishing', state: 'publishing', late: true });
    expect(fixtureValue.store.getJob('publishing-a')).toMatchObject({ state: 'publishing', cancelRequestedAt: '2026-07-27T12:00:15.000Z', cancelReason: 'operator' });
    const requestEvent = fixtureValue.store.listEvents('publishing-a').events.find((event) => event.eventType === 'cancellation_requested');
    expect(requestEvent?.payload).toMatchObject({ reason: 'operator', late: true });
    expect(systemdValue.calls).toEqual([]);
  });
});
