import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIGRATION_REGISTRY, openBuilderDatabase } from '../../api/src/store-schema.js';
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

function clock(wallStart = NOW): ApiCancellationClock {
  let monotonic = 0;
  return {
    now: () => new Date(Date.parse(wallStart) + monotonic).toISOString(),
    monotonicNow: () => monotonic,
    sleep: async (milliseconds) => { monotonic += milliseconds; },
  };
}

function systemd(): ApiCancellationSystemd & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    signalCancellation: vi.fn(async (unit) => { calls.push(['signal', unit]); return { commandOutcome: 'completed' as const, activity: 'unknown' as const, argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }),
    stopRunner: vi.fn(async (unit) => { calls.push(['stop', unit]); return { commandOutcome: 'completed' as const, activity: 'unknown' as const, argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }; }),
    inspectRunner: vi.fn(async (unit) => { calls.push(['inspect', unit]); return { commandOutcome: 'completed' as const, activity: 'active' as const, argv: [], exitCode: 0, signal: null, stdout: 'active\n', stderr: '', timedOut: false }; }),
  };
}

async function fixture(jobIds: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'osi-api-cancellation-'));
  directories.push(directory);
  const databasePath = join(directory, 'jobs.sqlite');
  const db = openBuilderDatabase(databasePath);
  const ownership = new OwnershipStore(db, { now: () => NOW });
  const store = new BuilderStore(db);
  for (const jobId of jobIds) expect(ownership.apiWrite({ kind: 'enqueue', input: input(jobId) }).ok).toBe(true);
  return { databasePath, db, ownership, store };
}

function activate(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  jobId: string,
  owner = 'runner-a',
  leaseExpiresAt = '2026-07-27T12:10:00.000Z',
): void {
  const runnerUnit = `osi-image-builder-runner@${jobId}.service`;
  expect(fixtureValue.ownership.apiWrite({ kind: 'dispatch', jobId, runnerUnit, at: LATER }).ok).toBe(true);
  expect(fixtureValue.ownership.runnerWrite({ kind: 'acquire-lease', jobId, runnerUnit, owner, expiresAt: leaseExpiresAt, at: LATER }).ok).toBe(true);
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

  it('keeps queued cancellation atomic when it wins a separate-connection dispatch race', async () => {
    const fixtureValue = await fixture(['queued-race-cancel']);
    const secondDb = openBuilderDatabase(fixtureValue.databasePath);
    const secondOwnership = new OwnershipStore(secondDb, { now: () => NOW });
    const systemdValue = systemd();
    let dispatchResult: ReturnType<OwnershipStore['apiWrite']> | null = null;
    let synchronized = false;
    const ownership = {
      apiWrite: (command: Parameters<OwnershipStore['apiWrite']>[0]) => {
        const result = fixtureValue.ownership.apiWrite(command);
        if (command.kind === 'request-cancellation' && !synchronized) {
          synchronized = true;
          dispatchResult = secondOwnership.apiWrite({
            kind: 'dispatch',
            jobId: 'queued-race-cancel',
            runnerUnit: 'osi-image-builder-runner@queued-race-cancel.service',
            at: '2026-07-27T12:00:03.000Z',
          });
        }
        return result;
      },
    };

    const outcome = await requestCancellation({
      store: fixtureValue.store,
      ownership,
      systemd: systemdValue,
      clock: clock('2026-07-27T12:00:02.000Z'),
    }, { jobId: 'queued-race-cancel', reason: 'operator', at: '2026-07-27T12:00:02.000Z' });

    expect(outcome).toMatchObject({ kind: 'queued-cancelled', state: 'cancelled' });
    expect(dispatchResult).toMatchObject({ ok: false });
    expect(fixtureValue.store.getJob('queued-race-cancel')).toMatchObject({
      state: 'cancelled',
      queueState: 'cancelled',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
    });
    expect(fixtureValue.store.listEvents('queued-race-cancel').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.listEvents('queued-race-cancel').events.map((event) => event.eventType))
      .toEqual(['enqueue', 'cancellation_requested', 'terminal']);
    expect(systemdValue.calls).toEqual([]);
    secondDb.close();
  });

  it('continues active coordination when dispatch wins a stale queued cancellation view', async () => {
    const fixtureValue = await fixture(['queued-race-dispatch']);
    const secondDb = openBuilderDatabase(fixtureValue.databasePath);
    const secondOwnership = new OwnershipStore(secondDb, { now: () => NOW });
    const systemdValue = systemd();
    let synchronized = false;
    const ownership = {
      apiWrite: (command: Parameters<OwnershipStore['apiWrite']>[0]) => {
        if (command.kind === 'request-cancellation' && !synchronized) {
          synchronized = true;
          expect(secondOwnership.apiWrite({
            kind: 'dispatch',
            jobId: 'queued-race-dispatch',
            runnerUnit: 'osi-image-builder-runner@queued-race-dispatch.service',
            at: LATER,
          }).ok).toBe(true);
          expect(secondOwnership.runnerWrite({
            kind: 'acquire-lease',
            jobId: 'queued-race-dispatch',
            runnerUnit: 'osi-image-builder-runner@queued-race-dispatch.service',
            owner: 'runner-race',
            expiresAt: '2026-07-27T12:10:00.000Z',
            at: LATER,
          }).ok).toBe(true);
        }
        return fixtureValue.ownership.apiWrite(command);
      },
    };

    const outcome = await requestCancellation({
      store: fixtureValue.store,
      ownership,
      systemd: systemdValue,
      clock: clock('2026-07-27T12:00:02.000Z'),
      cooperativeTimeoutMs: 0,
      systemdGraceMs: 0,
      pollIntervalMs: 1,
    }, { jobId: 'queued-race-dispatch', reason: 'operator', at: '2026-07-27T12:00:02.000Z' });

    expect(outcome).toMatchObject({ kind: 'recovery-blocked', requestPersisted: true });
    expect(fixtureValue.store.getCancellationJob('queued-race-dispatch')).toMatchObject({
      state: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      runnerUnit: 'osi-image-builder-runner@queued-race-dispatch.service',
      runnerLeaseOwner: 'runner-race',
    });
    expect(fixtureValue.store.listEvents('queued-race-dispatch').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.listEvents('queued-race-dispatch').events
      .filter((event) => ['enqueue', 'dispatch', 'cancellation_requested'].includes(event.eventType))
      .map((event) => event.eventType))
      .toEqual(['enqueue', 'dispatch', 'cancellation_requested']);
    expect(systemdValue.calls[0]).toEqual(['signal', 'osi-image-builder-runner@queued-race-dispatch.service']);
    secondDb.close();
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
      clock: clock('2026-07-27T12:00:02.000Z'),
      pollIntervalMs: 15_000,
    }, { jobId: 'active-a', reason: 'operator', at: '2026-07-27T12:00:02.000Z' });

    expect(outcome).toMatchObject({ kind: 'recovery-blocked', blockerCode: 'RUNNER_DISAPPEARED' });
    expect(systemdValue.calls[0]).toEqual(['signal', 'osi-image-builder-runner@active-a.service']);
    expect(systemdValue.calls.some(([kind]) => kind === 'stop')).toBe(true);
    expect(fixtureValue.store.getJob('active-a')).toMatchObject({
      state: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      cancellationCooperativeDeadlineAt: '2026-07-27T12:00:32.000Z',
      cancellationStopIntentAt: '2026-07-27T12:00:32.000Z',
      cancellationGraceDeadlineAt: '2026-07-27T12:00:47.000Z',
      cancellationClockHighWaterAt: '2026-07-27T12:00:47.000Z',
      cancellationStopAuthorizedAt: '2026-07-27T12:00:32.000Z',
      cancellationStopAuthorizedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      cancellationSignalObservation: expect.objectContaining({ commandOutcome: 'completed', activity: 'unknown' }),
      cancellationStopObservation: expect.objectContaining({ commandOutcome: 'completed', activity: 'unknown' }),
      cancellationInspectionObservations: expect.objectContaining({ observations: expect.any(Array) }),
      cleanupBlockerCode: 'RUNNER_DISAPPEARED',
    });
    expect(fixtureValue.store.listEvents('active-a').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.listEvents('active-a').events.some((event) => event.eventType === 'terminal')).toBe(false);
  });

  it('fails closed across restart when wall time is below the persisted cancellation high-water', async () => {
    const fixtureValue = await fixture(['restart-clock-a']);
    activate(fixtureValue, 'restart-clock-a');
    expect(fixtureValue.ownership.apiWrite({
      kind: 'request-cancellation',
      jobId: 'restart-clock-a',
      reason: 'operator',
      at: '2026-07-27T12:00:02.000Z',
      cooperativeDeadlineAt: '2026-07-27T12:00:32.000Z',
    }).ok).toBe(true);
    fixtureValue.db.prepare('UPDATE jobs SET cancellation_clock_high_water_at=? WHERE job_id=?')
      .run('2026-07-27T12:00:20.000Z', 'restart-clock-a');
    const secondDb = openBuilderDatabase(fixtureValue.databasePath);
    const secondStore = new BuilderStore(secondDb);
    const secondOwnership = new OwnershipStore(secondDb, { now: () => NOW });
    const systemdValue = systemd();

    const outcome = await requestCancellation({
      store: secondStore,
      ownership: secondOwnership,
      systemd: systemdValue,
      clock: clock('2026-07-27T12:00:10.000Z'),
    }, { jobId: 'restart-clock-a', reason: 'retry', at: '2026-07-27T12:00:10.000Z' });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({
        kind: 'api-cancellation-clock-regression',
        observedAt: '2026-07-27T12:00:10.000Z',
        highWaterAt: '2026-07-27T12:00:20.000Z',
      }),
    });
    expect(systemdValue.calls).toEqual([]);
    expect(secondStore.getCancellationJob('restart-clock-a')).toMatchObject({
      cancellationClockHighWaterAt: '2026-07-27T12:00:20.000Z',
      cleanupBlockerCode: 'RUNNER_DISAPPEARED',
    });
    secondDb.close();
  });

  it('upgrades a migration-010 cancellation to the latest durable observation without restoring elapsed budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osi-api-cancellation-v10-'));
    directories.push(directory);
    const databasePath = join(directory, 'jobs.sqlite');
    const historical = new DatabaseSync(databasePath);
    for (const migration of MIGRATION_REGISTRY.slice(0, 10)) {
      historical.exec(readFileSync(new URL(`../../api/migrations/${migration.filename}`, import.meta.url), 'utf8'));
      historical.prepare('INSERT INTO schema_migrations (version, filename, sha256, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.filename, migration.sha256, NOW);
    }
    const jobId = 'migration-v10-a';
    historical.prepare(`INSERT INTO jobs (
      job_id, request_id, request_json,
      source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha,
      source_preparation_json, offline_feed_preparation_json,
      target_id, root_id, target_manifest_sha256,
      source_commit_time, source_author, source_subject,
      accepted_at, state, queue_state,
      cancel_requested_at, cancel_reason,
      created_at, updated_at, dispatched_at, runner_unit,
      runner_lease_owner, runner_lease_expires_at,
      cancellation_cooperative_deadline_at,
      cancellation_escalation_owner, cancellation_escalation_lease_expires_at,
      cancellation_stop_intent_at, cancellation_grace_deadline_at,
      cancellation_signal_observation_json, cancellation_stop_observation_json,
      cancellation_inspection_observations_json
    ) VALUES (
      ?, ?, '{}',
      ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, 'starting', 'dispatched',
      ?, 'operator',
      ?, ?, ?, ?,
      'runner-v10', ?,
      ?,
      'coordinator-v10', ?,
      ?, ?,
      '{}', '{}', '{"observations":[{"activity":"active"}]}'
    )`).run(
      jobId,
      `request-${jobId}`,
      'git@example.com:osi-os.git',
      'refs/remotes/origin/main',
      'main',
      'main',
      SHA40,
      SHA40,
      JSON.stringify(sourcePreparation()),
      JSON.stringify(offlineFeeds(jobId)),
      'rpi-5',
      'release',
      SHA64,
      NOW,
      'Migration test',
      'Cancellation high-water',
      NOW,
      '2026-07-27T12:00:02.000Z',
      NOW,
      '2026-07-27T12:00:25.000Z',
      LATER,
      `osi-image-builder-runner@${jobId}.service`,
      '2026-07-27T12:10:00.000Z',
      '2026-07-27T12:00:32.000Z',
      '2026-07-27T12:00:35.000Z',
      '2026-07-27T12:00:20.000Z',
      '2026-07-27T12:00:35.000Z',
    );
    const insertEvent = historical.prepare(`INSERT INTO job_events (
      job_id, seq, event_type, state, payload_json, at
    ) VALUES (?, ?, ?, 'starting', ?, ?)`);
    insertEvent.run(jobId, 0, 'cancellation_requested', '{"reason":"operator"}', '2026-07-27T12:00:02.000Z');
    insertEvent.run(jobId, 1, 'recovery', '{"kind":"cancellation-signal-observed"}', '2026-07-27T12:00:10.000Z');
    insertEvent.run(jobId, 2, 'recovery', '{"kind":"cancellation-stop-intent"}', '2026-07-27T12:00:20.000Z');
    insertEvent.run(jobId, 3, 'recovery', '{"kind":"cancellation-inspection-observed"}', '2026-07-27T12:00:24.000Z');
    historical.close();

    const upgraded = openBuilderDatabase(databasePath);
    const store = new BuilderStore(upgraded);
    const systemdValue = systemd();
    expect(store.getCancellationJob(jobId).cancellationClockHighWaterAt)
      .toBe('2026-07-27T12:00:25.000Z');

    const outcome = await requestCancellation({
      store,
      ownership: new OwnershipStore(upgraded, { now: () => NOW }),
      systemd: systemdValue,
      clock: clock('2026-07-27T12:00:20.000Z'),
    }, { jobId, reason: 'retry', at: '2026-07-27T12:00:20.000Z' });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({
        kind: 'api-cancellation-clock-regression',
        observedAt: '2026-07-27T12:00:20.000Z',
        highWaterAt: '2026-07-27T12:00:25.000Z',
      }),
    });
    expect(systemdValue.calls).toEqual([]);
    upgraded.close();
  });

  it('accepts a production-style same-owner lease renewal at twenty seconds and stops once at thirty seconds', async () => {
    const fixtureValue = await fixture(['lease-renewal-a']);
    activate(fixtureValue, 'lease-renewal-a');
    let monotonic = 0;
    const wallStart = Date.parse('2026-07-27T12:00:02.000Z');
    let renewed = false;
    const renewalClock: ApiCancellationClock = {
      now: () => new Date(wallStart + monotonic).toISOString(),
      monotonicNow: () => monotonic,
      sleep: async (milliseconds) => {
        monotonic += milliseconds;
        if (!renewed && monotonic >= 20_000) {
          renewed = true;
          expect(fixtureValue.ownership.runnerWrite({
            kind: 'renew-lease',
            jobId: 'lease-renewal-a',
            runnerUnit: 'osi-image-builder-runner@lease-renewal-a.service',
            owner: 'runner-a',
            expectedExpiresAt: '2026-07-27T12:10:00.000Z',
            expiresAt: '2026-07-27T12:11:00.000Z',
            at: '2026-07-27T12:00:22.000Z',
          }).ok).toBe(true);
        }
      },
    };
    const systemdValue = systemd();

    await requestCancellation({
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      systemd: systemdValue,
      clock: renewalClock,
      pollIntervalMs: 10_000,
      systemdGraceMs: 0,
    }, { jobId: 'lease-renewal-a', reason: 'operator', at: '2026-07-27T12:00:02.000Z' });

    expect(systemdValue.calls.filter(([kind]) => kind === 'stop')).toEqual([
      ['stop', 'osi-image-builder-runner@lease-renewal-a.service'],
    ]);
    expect(fixtureValue.store.getCancellationJob('lease-renewal-a')).toMatchObject({
      runnerLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
      cancellationStopAuthorizedAt: '2026-07-27T12:00:32.000Z',
      cancellationStopAuthorizedLeaseExpiresAt: '2026-07-27T12:11:00.000Z',
    });
  });

  it('CAS-advances the durable clock and rolls stop authorization back atomically', async () => {
    const fixtureValue = await fixture(['clock-cas-a', 'authorization-rollback-a']);
    activate(fixtureValue, 'clock-cas-a');
    activate(fixtureValue, 'authorization-rollback-a');
    const secondDb = openBuilderDatabase(fixtureValue.databasePath);
    const secondOwnership = new OwnershipStore(secondDb, { now: () => NOW });
    for (const jobId of ['clock-cas-a', 'authorization-rollback-a']) {
      expect(fixtureValue.ownership.apiWrite({
        kind: 'request-cancellation',
        jobId,
        reason: 'operator',
        at: '2026-07-27T12:00:02.000Z',
        cooperativeDeadlineAt: '2026-07-27T12:00:32.000Z',
      }).ok).toBe(true);
    }

    expect(fixtureValue.ownership.apiWrite({
      kind: 'observe-cancellation-clock',
      jobId: 'clock-cas-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      expectedHighWaterAt: '2026-07-27T12:00:02.000Z',
      observedAt: '2026-07-27T12:00:10.000Z',
      at: '2026-07-27T12:00:10.000Z',
    }).ok).toBe(true);
    expect(secondOwnership.apiWrite({
      kind: 'observe-cancellation-clock',
      jobId: 'clock-cas-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      expectedHighWaterAt: '2026-07-27T12:00:02.000Z',
      observedAt: '2026-07-27T12:00:11.000Z',
      at: '2026-07-27T12:00:11.000Z',
    })).toMatchObject({ ok: false, conflict: { kind: 'cas-lost' } });
    expect(fixtureValue.store.getCancellationJob('clock-cas-a').cancellationClockHighWaterAt)
      .toBe('2026-07-27T12:00:10.000Z');

    expect(fixtureValue.ownership.apiWrite({
      kind: 'observe-cancellation-clock',
      jobId: 'authorization-rollback-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      expectedHighWaterAt: '2026-07-27T12:00:02.000Z',
      observedAt: '2026-07-27T12:00:32.000Z',
      at: '2026-07-27T12:00:32.000Z',
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'claim-cancellation-escalation',
      jobId: 'authorization-rollback-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      cooperativeDeadlineAt: '2026-07-27T12:00:32.000Z',
      runnerUnit: 'osi-image-builder-runner@authorization-rollback-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'coordinator-rollback',
      escalationLeaseExpiresAt: '2026-07-27T12:00:47.000Z',
      stopIntentAt: '2026-07-27T12:00:32.000Z',
      graceDeadlineAt: '2026-07-27T12:00:47.000Z',
      at: '2026-07-27T12:00:32.000Z',
    }).ok).toBe(true);
    const eventsBefore = fixtureValue.store.listEvents('authorization-rollback-a').events.length;
    const rollbackOwnership = new OwnershipStore(fixtureValue.db, {
      now: () => NOW,
      failBeforeCommit: () => { throw new Error('injected authorization rollback'); },
    });
    expect(() => rollbackOwnership.apiWrite({
      kind: 'authorize-cancellation-stop',
      jobId: 'authorization-rollback-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      runnerUnit: 'osi-image-builder-runner@authorization-rollback-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'coordinator-rollback',
      stopIntentAt: '2026-07-27T12:00:32.000Z',
      expectedHighWaterAt: '2026-07-27T12:00:32.000Z',
      authorizedAt: '2026-07-27T12:00:32.000Z',
      at: '2026-07-27T12:00:32.000Z',
    })).toThrow(/rolled back/i);
    expect(fixtureValue.store.getCancellationJob('authorization-rollback-a')).toMatchObject({
      cancellationStopAuthorizedAt: null,
      cancellationStopAuthorizedLeaseExpiresAt: null,
    });
    expect(fixtureValue.store.listEvents('authorization-rollback-a').events).toHaveLength(eventsBefore);
    secondDb.close();
  });

  it('retries a healthy concurrent high-water advance when the local wall clock catches up', async () => {
    const fixtureValue = await fixture(['clock-race-a']);
    activate(fixtureValue, 'clock-race-a');
    const requestAt = '2026-07-27T12:00:02.000Z';
    expect(fixtureValue.ownership.apiWrite({
      kind: 'request-cancellation',
      jobId: 'clock-race-a',
      reason: 'operator',
      at: requestAt,
      cooperativeDeadlineAt: requestAt,
    }).ok).toBe(true);
    const secondDb = openBuilderDatabase(fixtureValue.databasePath);
    const secondOwnership = new OwnershipStore(secondDb, { now: () => NOW });
    let raced = false;
    const ownership = {
      apiWrite: (command: Parameters<OwnershipStore['apiWrite']>[0]) => {
        if (command.kind === 'observe-cancellation-clock' && !raced) {
          raced = true;
          expect(secondOwnership.apiWrite({
            kind: 'observe-cancellation-clock',
            jobId: 'clock-race-a',
            expectedState: 'starting',
            cancelRequestedAt: requestAt,
            expectedHighWaterAt: requestAt,
            observedAt: '2026-07-27T12:00:02.002Z',
            at: '2026-07-27T12:00:02.002Z',
          }).ok).toBe(true);
        }
        return fixtureValue.ownership.apiWrite(command);
      },
    };
    const wallSamples = [
      '2026-07-27T12:00:02.001Z',
      '2026-07-27T12:00:02.003Z',
    ];
    let sampleIndex = 0;
    const staggeredClock: ApiCancellationClock = {
      now: () => wallSamples[Math.min(sampleIndex++, wallSamples.length - 1)]!,
      monotonicNow: () => 0,
      sleep: async () => {},
    };
    const systemdValue = systemd();

    const outcome = await requestCancellation({
      store: fixtureValue.store,
      ownership,
      systemd: systemdValue,
      clock: staggeredClock,
      coordinatorId: 'clock-race-coordinator-a',
      cooperativeTimeoutMs: 0,
      systemdGraceMs: 0,
      pollIntervalMs: 1,
    }, { jobId: 'clock-race-a', reason: 'retry', at: '2026-07-27T12:00:02.003Z' });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({ kind: 'api-cancellation-escalation' }),
    });
    expect(systemdValue.calls.filter(([kind]) => kind === 'signal')).toHaveLength(1);
    expect(systemdValue.calls.filter(([kind]) => kind === 'stop')).toHaveLength(1);
    expect(fixtureValue.store.getCancellationJob('clock-race-a')).toMatchObject({
      cancellationClockHighWaterAt: '2026-07-27T12:00:02.003Z',
      cleanupBlocker: expect.objectContaining({ kind: 'api-cancellation-escalation' }),
    });
    secondDb.close();
  });

  it('does not replay stop after restart across the durable stop-authorization ambiguity boundary', async () => {
    const fixtureValue = await fixture(['authorized-crash-a']);
    activate(fixtureValue, 'authorized-crash-a');
    const requestAt = '2026-07-27T12:00:02.000Z';
    const intentAt = '2026-07-27T12:00:32.000Z';
    expect(fixtureValue.ownership.apiWrite({
      kind: 'request-cancellation',
      jobId: 'authorized-crash-a',
      reason: 'operator',
      at: requestAt,
      cooperativeDeadlineAt: intentAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'observe-cancellation-clock',
      jobId: 'authorized-crash-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      expectedHighWaterAt: requestAt,
      observedAt: intentAt,
      at: intentAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'claim-cancellation-escalation',
      jobId: 'authorized-crash-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      cooperativeDeadlineAt: intentAt,
      runnerUnit: 'osi-image-builder-runner@authorized-crash-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'crashed-after-authorization',
      escalationLeaseExpiresAt: '2026-07-27T12:00:47.000Z',
      stopIntentAt: intentAt,
      graceDeadlineAt: '2026-07-27T12:00:47.000Z',
      at: intentAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'authorize-cancellation-stop',
      jobId: 'authorized-crash-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      runnerUnit: 'osi-image-builder-runner@authorized-crash-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'crashed-after-authorization',
      stopIntentAt: intentAt,
      expectedHighWaterAt: intentAt,
      authorizedAt: intentAt,
      at: intentAt,
    }).ok).toBe(true);
    const secondDb = openBuilderDatabase(fixtureValue.databasePath);
    const systemdValue = systemd();

    const outcome = await requestCancellation({
      store: new BuilderStore(secondDb),
      ownership: new OwnershipStore(secondDb, { now: () => NOW }),
      systemd: systemdValue,
      clock: clock('2026-07-27T12:00:48.000Z'),
      coordinatorId: 'restart-after-authorization',
    }, { jobId: 'authorized-crash-a', reason: 'retry', at: '2026-07-27T12:00:48.000Z' });

    expect(outcome).toMatchObject({ kind: 'recovery-blocked' });
    expect(systemdValue.calls.filter(([kind]) => kind === 'stop')).toHaveLength(0);
    expect(systemdValue.calls.filter(([kind]) => kind === 'inspect')).toHaveLength(1);
    expect(new BuilderStore(secondDb).getCancellationJob('authorized-crash-a')).toMatchObject({
      cancellationStopAuthorizedAt: intentAt,
      cancellationStopObservation: null,
      cleanupBlockerCode: 'RUNNER_DISAPPEARED',
    });
    secondDb.close();
  });

  it('makes repeated requests idempotent after the request transaction and never gives API a runner terminal write', async () => {
    const fixtureValue = await fixture(['repeat-a']);
    activate(fixtureValue, 'repeat-a');
    const systemdValue = systemd();
    const options = { store: fixtureValue.store, ownership: fixtureValue.ownership, systemd: systemdValue, clock: clock(LATER), cooperativeTimeoutMs: 0, systemdGraceMs: 0, pollIntervalMs: 1 };

    const first = await requestCancellation(options, { jobId: 'repeat-a', reason: 'operator', at: LATER });
    const second = await requestCancellation(options, { jobId: 'repeat-a', reason: 'operator-retry', at: '2026-07-27T12:00:02.000Z' });

    expect(first).toMatchObject({ kind: 'recovery-blocked' });
    expect(second).toMatchObject({ kind: 'recovery-blocked' });
    expect(fixtureValue.store.listEvents('repeat-a').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.listEvents('repeat-a').events.some((event) => event.eventType === 'terminal')).toBe(false);
    expect(systemdValue.calls.filter(([kind]) => kind === 'signal')).toHaveLength(1);
    expect(systemdValue.calls.filter(([kind]) => kind === 'stop')).toHaveLength(1);
  });

  it('makes concurrent cancellation requests converge on one durable request event and existing recovery evidence', async () => {
    const fixtureValue = await fixture(['concurrent-a']);
    expect(fixtureValue.ownership.apiWrite({ kind: 'dispatch', jobId: 'concurrent-a', runnerUnit: 'osi-image-builder-runner@concurrent-a.service', at: LATER }).ok).toBe(true);
    expect(fixtureValue.ownership.runnerWrite({ kind: 'acquire-lease', jobId: 'concurrent-a', runnerUnit: 'osi-image-builder-runner@concurrent-a.service', owner: 'runner-a', expiresAt: '2026-07-27T12:10:00.000Z', at: LATER }).ok).toBe(true);
    const systemdValue = systemd();
    const base = { store: fixtureValue.store, ownership: fixtureValue.ownership, systemd: systemdValue, cooperativeTimeoutMs: 0, systemdGraceMs: 0, pollIntervalMs: 1 } as const;

    const outcomes = await Promise.all([
      requestCancellation({ ...base, clock: clock('2026-07-27T12:00:02.000Z') }, { jobId: 'concurrent-a', reason: 'operator-a', at: '2026-07-27T12:00:02.000Z' }),
      requestCancellation({ ...base, clock: clock('2026-07-27T12:00:03.000Z') }, { jobId: 'concurrent-a', reason: 'operator-b', at: '2026-07-27T12:00:03.000Z' }),
    ]);

    expect(outcomes).toEqual([expect.objectContaining({ kind: 'recovery-blocked' }), expect.objectContaining({ kind: 'recovery-blocked' })]);
    expect(fixtureValue.store.listEvents('concurrent-a').events.filter((event) => event.eventType === 'cancellation_requested')).toHaveLength(1);
    expect(fixtureValue.store.getJob('concurrent-a').cleanupBlockerCode).toBe('RUNNER_DISAPPEARED');
  });

  it('coordinates one stop across separate SQLite stores and survives restart after a persisted stop intent', async () => {
    const fixtureValue = await fixture(['separate-a', 'preintent-a', 'restart-a', 'stopresult-a']);
    activate(fixtureValue, 'separate-a');
    activate(fixtureValue, 'preintent-a');
    activate(fixtureValue, 'restart-a');
    activate(fixtureValue, 'stopresult-a');
    const secondDb = openBuilderDatabase(fixtureValue.databasePath);
    const secondOwnership = new OwnershipStore(secondDb, { now: () => NOW });
    const secondStore = new BuilderStore(secondDb);
    const sharedSystemd = systemd();
    const requestAt = '2026-07-27T12:00:02.000Z';
    const base = { systemd: sharedSystemd, cooperativeTimeoutMs: 0, systemdGraceMs: 0, pollIntervalMs: 1 } as const;

    const outcomes = await Promise.all([
      requestCancellation({ ...base, store: fixtureValue.store, ownership: fixtureValue.ownership, clock: clock(requestAt), coordinatorId: 'coordinator-one' }, { jobId: 'separate-a', reason: 'one', at: requestAt }),
      requestCancellation({ ...base, store: secondStore, ownership: secondOwnership, clock: clock(requestAt), coordinatorId: 'coordinator-two' }, { jobId: 'separate-a', reason: 'two', at: requestAt }),
    ]);

    expect(outcomes).toEqual([expect.objectContaining({ kind: 'recovery-blocked' }), expect.objectContaining({ kind: 'recovery-blocked' })]);
    expect(sharedSystemd.calls.filter(([kind]) => kind === 'stop')).toHaveLength(1);

    expect(fixtureValue.ownership.apiWrite({
      kind: 'request-cancellation', jobId: 'preintent-a', reason: 'operator', at: requestAt,
      cooperativeDeadlineAt: requestAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'record-cancellation-signal',
      jobId: 'preintent-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      runnerUnit: 'osi-image-builder-runner@preintent-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      observation: { commandOutcome: 'completed', activity: 'unknown', argv: ['signal-before-crash'] },
      at: requestAt,
    }).ok).toBe(true);
    const preIntentSystemd = systemd();
    const resumedBeforeIntent = await requestCancellation({
      store: secondStore,
      ownership: secondOwnership,
      systemd: preIntentSystemd,
      clock: clock('2026-07-27T12:00:03.000Z'),
      coordinatorId: 'preintent-restart',
      systemdGraceMs: 0,
    }, { jobId: 'preintent-a', reason: 'restart', at: '2026-07-27T12:00:03.000Z' });
    expect(resumedBeforeIntent).toMatchObject({ kind: 'recovery-blocked' });
    expect(preIntentSystemd.calls.filter(([kind]) => kind === 'stop')).toHaveLength(1);

    expect(fixtureValue.ownership.apiWrite({
      kind: 'request-cancellation', jobId: 'restart-a', reason: 'operator', at: requestAt,
      cooperativeDeadlineAt: requestAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'claim-cancellation-escalation',
      jobId: 'restart-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      cooperativeDeadlineAt: requestAt,
      runnerUnit: 'osi-image-builder-runner@restart-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'crashed-coordinator',
      escalationLeaseExpiresAt: '2026-07-27T12:00:17.000Z',
      stopIntentAt: requestAt,
      graceDeadlineAt: '2026-07-27T12:00:17.000Z',
      at: requestAt,
    }).ok).toBe(true);
    const restartSystemd = systemd();

    const restarted = await requestCancellation({
      store: secondStore,
      ownership: secondOwnership,
      systemd: restartSystemd,
      clock: clock('2026-07-27T12:00:18.000Z'),
      coordinatorId: 'restarted-coordinator',
    }, { jobId: 'restart-a', reason: 'restart', at: '2026-07-27T12:00:18.000Z' });

    expect(restarted).toMatchObject({ kind: 'recovery-blocked' });
    expect(restartSystemd.calls.filter(([kind]) => kind === 'stop')).toHaveLength(0);
    expect(restartSystemd.calls.filter(([kind]) => kind === 'inspect')).toHaveLength(1);
    expect(secondStore.getCancellationJob('restart-a')).toMatchObject({
      cancellationEscalationOwner: 'crashed-coordinator',
      cancellationStopIntentAt: requestAt,
      cleanupBlockerCode: 'RUNNER_DISAPPEARED',
    });

    expect(fixtureValue.ownership.apiWrite({
      kind: 'request-cancellation', jobId: 'stopresult-a', reason: 'operator', at: requestAt,
      cooperativeDeadlineAt: requestAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'claim-cancellation-escalation',
      jobId: 'stopresult-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      cooperativeDeadlineAt: requestAt,
      runnerUnit: 'osi-image-builder-runner@stopresult-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'stop-result-coordinator',
      escalationLeaseExpiresAt: '2026-07-27T12:00:17.000Z',
      stopIntentAt: requestAt,
      graceDeadlineAt: '2026-07-27T12:00:17.000Z',
      at: requestAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'authorize-cancellation-stop',
      jobId: 'stopresult-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      runnerUnit: 'osi-image-builder-runner@stopresult-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'stop-result-coordinator',
      stopIntentAt: requestAt,
      expectedHighWaterAt: requestAt,
      authorizedAt: requestAt,
      at: requestAt,
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'record-cancellation-stop',
      jobId: 'stopresult-a',
      expectedState: 'starting',
      cancelRequestedAt: requestAt,
      runnerUnit: 'osi-image-builder-runner@stopresult-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      escalationOwner: 'stop-result-coordinator',
      stopIntentAt: requestAt,
      observation: {
        commandOutcome: 'timed-out',
        activity: 'unknown',
        argv: ['/usr/bin/systemctl', '--user', 'stop', 'osi-image-builder-runner@stopresult-a.service'],
        timedOut: true,
      },
      at: requestAt,
    }).ok).toBe(true);
    const afterStopSystemd = systemd();
    const resumedAfterStop = await requestCancellation({
      store: secondStore,
      ownership: secondOwnership,
      systemd: afterStopSystemd,
      clock: clock('2026-07-27T12:00:18.000Z'),
      coordinatorId: 'after-stop-restart',
    }, { jobId: 'stopresult-a', reason: 'restart', at: '2026-07-27T12:00:18.000Z' });
    expect(resumedAfterStop).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({
        systemd: expect.objectContaining({
          stop: expect.objectContaining({ commandOutcome: 'timed-out', timedOut: true }),
        }),
      }),
    });
    expect(afterStopSystemd.calls.filter(([kind]) => kind === 'stop')).toHaveLength(0);
    secondDb.close();
  });

  it.each([
    ['null unit', null, null, null],
    ['malformed unit', 'not-a-systemd-unit', 'runner-a', '2026-07-27T12:10:00.000Z'],
    ['mismatched unit', 'osi-image-builder-runner@different.service', 'runner-a', '2026-07-27T12:10:00.000Z'],
    ['null owner and lease', 'osi-image-builder-runner@anomaly-a.service', null, null],
    ['malformed lease', 'osi-image-builder-runner@anomaly-a.service', 'runner-a', 'not-an-instant'],
    ['expired lease', 'osi-image-builder-runner@anomaly-a.service', 'runner-a', '2026-07-27T12:00:02.500Z'],
  ])('persists raw fail-closed evidence for %s', async (_label, runnerUnit, owner, leaseExpiresAt) => {
    const fixtureValue = await fixture(['anomaly-a']);
    activate(fixtureValue, 'anomaly-a');
    expect(fixtureValue.ownership.apiWrite({
      kind: 'request-cancellation',
      jobId: 'anomaly-a',
      reason: 'operator',
      at: '2026-07-27T12:00:02.000Z',
      cooperativeDeadlineAt: '2026-07-27T12:00:02.000Z',
    }).ok).toBe(true);
    fixtureValue.db.exec('DROP TRIGGER jobs_runner_lease_guard_update');
    fixtureValue.db.exec('PRAGMA ignore_check_constraints=ON');
    fixtureValue.db.prepare('UPDATE jobs SET runner_unit=?, runner_lease_owner=?, runner_lease_expires_at=? WHERE job_id=?')
      .run(runnerUnit, owner, leaseExpiresAt, 'anomaly-a');
    const systemdValue = systemd();

    const outcome = await requestCancellation({
      store: fixtureValue.store,
      ownership: fixtureValue.ownership,
      systemd: systemdValue,
      clock: clock('2026-07-27T12:00:03.000Z'),
    }, { jobId: 'anomaly-a', reason: 'retry', at: '2026-07-27T12:00:03.000Z' });

    expect(outcome).toMatchObject({
      kind: 'recovery-blocked',
      evidence: expect.objectContaining({
        persistedRunnerUnit: runnerUnit,
        observedOwner: owner,
        observedLeaseExpiresAt: leaseExpiresAt,
      }),
    });
    expect(systemdValue.calls).toEqual([]);
    expect(fixtureValue.store.getCancellationJob('anomaly-a')).toMatchObject({
      cleanupBlockerCode: 'RUNNER_DISAPPEARED',
      cleanupBlocker: expect.objectContaining({
        persistedRunnerUnit: runnerUnit,
        observedOwner: owner,
        observedLeaseExpiresAt: leaseExpiresAt,
      }),
    });
  });

  it('rejects stale anomaly CAS and rolls blocker persistence back with its event', async () => {
    const fixtureValue = await fixture(['cas-a', 'rollback-a']);
    activate(fixtureValue, 'cas-a');
    activate(fixtureValue, 'rollback-a');
    for (const jobId of ['cas-a', 'rollback-a']) {
      expect(fixtureValue.ownership.apiWrite({
        kind: 'request-cancellation', jobId, reason: 'operator',
        at: '2026-07-27T12:00:02.000Z', cooperativeDeadlineAt: '2026-07-27T12:00:02.000Z',
      }).ok).toBe(true);
    }
    const stale = fixtureValue.ownership.apiWrite({
      kind: 'cancellation-recovery-blocker',
      jobId: 'cas-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      observedRunnerUnit: 'osi-image-builder-runner@cas-a.service',
      observedOwner: 'wrong-owner',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      blocker: { kind: 'stale' },
      at: '2026-07-27T12:00:03.000Z',
    });
    expect(stale).toMatchObject({ ok: false, conflict: { kind: 'identity-mismatch' } });
    expect(fixtureValue.store.getCancellationJob('cas-a').cleanupBlocker).toBeNull();
    expect(fixtureValue.ownership.apiWrite({
      kind: 'runner-recovery-blocker',
      jobId: 'cas-a',
      expectedState: 'starting',
      runnerUnit: 'osi-image-builder-runner@cas-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      blocker: { kind: 'unrelated-runner-recovery' },
      at: '2026-07-27T12:00:03.000Z',
    }).ok).toBe(true);
    expect(fixtureValue.ownership.apiWrite({
      kind: 'cancellation-recovery-blocker',
      jobId: 'cas-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      observedRunnerUnit: 'osi-image-builder-runner@cas-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      blocker: { kind: 'must-not-overwrite' },
      at: '2026-07-27T12:00:04.000Z',
    })).toMatchObject({ ok: false, conflict: { kind: 'fenced' } });
    expect(fixtureValue.store.getCancellationJob('cas-a').cleanupBlocker).toEqual({ kind: 'unrelated-runner-recovery' });

    const eventsBefore = fixtureValue.store.listEvents('rollback-a').events.length;
    const rollbackOwnership = new OwnershipStore(fixtureValue.db, {
      now: () => NOW,
      failBeforeCommit: () => { throw new Error('injected rollback'); },
    });
    expect(() => rollbackOwnership.apiWrite({
      kind: 'cancellation-recovery-blocker',
      jobId: 'rollback-a',
      expectedState: 'starting',
      cancelRequestedAt: '2026-07-27T12:00:02.000Z',
      observedRunnerUnit: 'osi-image-builder-runner@rollback-a.service',
      observedOwner: 'runner-a',
      observedLeaseExpiresAt: '2026-07-27T12:10:00.000Z',
      blocker: { kind: 'rollback' },
      at: '2026-07-27T12:00:03.000Z',
    })).toThrow(/rolled back/i);
    expect(fixtureValue.store.getCancellationJob('rollback-a').cleanupBlocker).toBeNull();
    expect(fixtureValue.store.listEvents('rollback-a').events).toHaveLength(eventsBefore);
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
