import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import { createCleanupAdmissionRecovery, type CleanupAdmissionRecovery, type RecoveryDatabase, type RecoverySystemd } from '../../api/src/recovery.js';

const NOW = '2026-07-27T12:00:00.000Z';
const EXPIRES = '2026-07-27T12:05:00.000Z';
const STALE_AT = '2026-07-27T12:06:00.000Z';
const RETRY_AT = '2026-07-27T12:08:00.000Z';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const ADMISSION = 'cln_0123456789abcdefghjkmnpqrs';
const JOB_ID = 'job-stop-authorization';

function snapshot() {
  return {
    runner: { unit: `osi-image-builder-runner@${JOB_ID}.service`, owner: null, leaseExpiresAt: null, inactiveAt: NOW, observedAt: NOW },
    state: 'starting' as const,
    container: { kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt: NOW },
    staging: { kind: 'absent' as const, path: null },
    logs: { runner: 'absent' as const, docker: 'absent' as const, verifiedAt: NOW },
    blocker: 'none' as const,
  };
}

function seedJob(db: ReturnType<typeof openBuilderDatabase>): void {
  db.prepare(
    `INSERT INTO jobs (
       job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha,
       target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject,
       accepted_at, state, queue_state, created_at, updated_at, source_preparation_json,
       offline_feed_preparation_json, runner_unit
     ) VALUES (?, ?, 'origin', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'release', ?, ?, 'owner', 'stop authorization', ?, 'starting', 'dispatched', ?, ?, '{}', '{}', ?)`,
  ).run(JOB_ID, `${JOB_ID}-request`, 'a'.repeat(40), 'a'.repeat(40), SHA, NOW, NOW, NOW, NOW, `osi-image-builder-runner@${JOB_ID}.service`);
}

function systemd(active: { value: boolean }, stopCalls: string[]): RecoverySystemd {
  return {
    async start() {},
    async isActive() { return active.value; },
    async stop(unit) { stopCalls.push(unit); active.value = false; },
  };
}

function recovery(db: ReturnType<typeof openBuilderDatabase>, root: string, systemdClient: RecoverySystemd, fill: number): CleanupAdmissionRecovery {
  const ownership = new OwnershipStore(db);
  return createCleanupAdmissionRecovery({
    db: db as unknown as RecoveryDatabase,
    ownership,
    stateRoot: root,
    clock: { now: () => STALE_AT },
    crypto: { randomBytes: (size) => Buffer.alloc(size, fill) },
    systemd: systemdClient,
  });
}

async function claimedFixture(): Promise<{
  readonly root: string;
  readonly db: ReturnType<typeof openBuilderDatabase>;
  readonly recovery: CleanupAdmissionRecovery;
  readonly admissionId: string;
  readonly unitName: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-stop-authorization-'));
  const db = openBuilderDatabase(join(root, 'builder.db'));
  seedJob(db);
  const active = { value: false };
  const admissionRecovery = recovery(db, root, systemd(active, []), 7);
  await admissionRecovery.openAdmissions();
  const admitted = await admissionRecovery.admitAndStart({ jobId: JOB_ID, owner: 'api', expiresAt: EXPIRES, snapshot: snapshot(), at: NOW });
  db.prepare("UPDATE cleanup_leases SET status='claimed', claim_at=? WHERE admission_id=?").run(NOW, admitted.admissionId);
  return { root, db, recovery: admissionRecovery, admissionId: admitted.admissionId, unitName: admitted.unitName };
}

function predecessor(db: ReturnType<typeof openBuilderDatabase>, admissionId: string): Record<string, unknown> {
  return db.prepare(`SELECT admission_id AS "previousAdmissionId", status AS "previousStatus", unit_name AS "previousUnitName",
      fence_generation AS "previousFenceGeneration", fence_token_hash AS "previousFenceTokenHash", owner AS "previousOwner",
      expires_at AS "previousExpiresAt", claim_at AS "previousClaimAt", renew_at AS "previousRenewAt",
      blocker_code AS "previousBlockerCode", blocker_json AS "previousBlocker"
    FROM cleanup_leases WHERE admission_id=?`).get(admissionId) as Record<string, unknown>;
}

describe('durable cleanup stop authorization', () => {
  it('serializes two real recovery facades so only one durable authorization can stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-cleanup-stop-race-'));
    const dbPath = join(root, 'builder.db');
    const dbA = openBuilderDatabase(dbPath);
    seedJob(dbA);
    const active = { value: false };
    const stopCalls: string[] = [];
    const client = systemd(active, stopCalls);
    const facadeA = recovery(dbA, root, client, 7);
    await facadeA.openAdmissions();
    const admitted = await facadeA.admitAndStart({ jobId: JOB_ID, owner: 'api', expiresAt: EXPIRES, snapshot: snapshot(), at: NOW });
    dbA.prepare("UPDATE cleanup_leases SET status='claimed', claim_at=? WHERE admission_id=?").run(NOW, admitted.admissionId);
    active.value = true;

    const dbB = openBuilderDatabase(dbPath);
    const facadeB = recovery(dbB, root, client, 8);
    await facadeB.openAdmissions();
    const input = { jobId: JOB_ID, admissionId: admitted.admissionId, owner: 'api', expiresAt: '2026-07-27T12:10:00.000Z', snapshot: snapshot(), at: STALE_AT };
    const results = await Promise.allSettled([facadeA.reconcileAndStart(input), facadeB.reconcileAndStart(input)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(stopCalls).toEqual([admitted.unitName]);
    expect(dbA.prepare('SELECT COUNT(*) AS count FROM cleanup_stop_authorizations').get()).toEqual({ count: 1 });
    expect(dbA.prepare('SELECT state FROM cleanup_stop_authorization_heads WHERE admission_id=?').get(admitted.admissionId)).toEqual({ state: 'consumed' });

    dbB.close();
    dbA.close();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects unexpired authorization, fences an orphan, and allows only an explicit successful retry', async () => {
    const fixture = await claimedFixture();
    const stopCalls: string[] = [];
    const active = { value: true };
    const db = fixture.db;
    const ownership = new OwnershipStore(db);
    const base = predecessor(db, fixture.admissionId);
    expect(() => ownership.apiWrite({
      kind: 'cleanup-admission-stop-authorize',
      jobId: JOB_ID,
      owner: 'api',
      authorizationOwner: 'too-early-api',
      attemptId: 'sta_cccccccccccccccccccccccccccccccc',
      authorizationAt: '2026-07-27T12:04:30.000Z',
      authorizationExpiresAt: '2026-07-27T12:05:30.000Z',
      ...base,
      previousExpiresAt: EXPIRES,
      at: '2026-07-27T12:04:30.000Z',
    } as never)).toThrow(/stale predecessor lease/);
    const unexpired = ownership.apiWrite({
      kind: 'cleanup-admission-stop-authorize',
      jobId: JOB_ID,
      owner: 'api',
      authorizationOwner: 'crashed-api',
      attemptId: 'sta_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      authorizationAt: STALE_AT,
      authorizationExpiresAt: '2026-07-27T12:06:30.000Z',
      ...base,
      at: STALE_AT,
    } as never);
    expect(unexpired.ok).toBe(true);

    const early = ownership.apiWrite({
      kind: 'cleanup-admission-stop-authorize',
      jobId: JOB_ID,
      owner: 'api',
      authorizationOwner: 'second-api',
      attemptId: 'sta_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      authorizationAt: '2026-07-27T12:06:15.000Z',
      authorizationExpiresAt: '2026-07-27T12:06:45.000Z',
      ...base,
      previousExpiresAt: EXPIRES,
      at: '2026-07-27T12:06:15.000Z',
    } as never);
    expect(early).toMatchObject({ ok: false, conflict: { kind: 'fenced' } });

    const orphanRecovery = recovery(db, fixture.root, systemd(active, stopCalls), 9);
    await orphanRecovery.openAdmissions();
    await expect(orphanRecovery.reconcileAndStart({ jobId: JOB_ID, admissionId: fixture.admissionId, owner: 'api', expiresAt: '2026-07-27T12:10:00.000Z', snapshot: snapshot(), at: '2026-07-27T12:07:00.000Z' })).rejects.toThrow(/orphan|explicit|retry/i);
    expect(stopCalls).toHaveLength(0);
    expect(db.prepare('SELECT state FROM cleanup_stop_authorization_heads WHERE admission_id=?').get(fixture.admissionId)).toEqual({ state: 'orphaned' });

    const retryRecovery = recovery(db, fixture.root, systemd(active, stopCalls), 10);
    await retryRecovery.openAdmissions();
    await expect(retryRecovery.retryCorrectedAndStart({
      jobId: JOB_ID,
      admissionId: fixture.admissionId,
      owner: 'api',
      expiresAt: '2026-07-27T12:10:00.000Z',
      snapshot: snapshot(),
      correctedSnapshot: snapshot(),
      expectedBlockerCode: 'CLEANUP_UNIT_STOP_FAILED',
      expectedBlocker: { kind: 'cleanup-stop-authorization-orphaned', code: 'CLEANUP_UNIT_STOP_FAILED', unitName: fixture.unitName, failure: 'authorization-orphaned', observedAt: '2026-07-27T12:07:00.000Z', error: { message: 'cleanup stop authorization is orphaned after expiring while the unit remained active', code: null } },
      at: RETRY_AT,
    })).resolves.toMatchObject({ rotated: true });
    expect(stopCalls).toEqual([fixture.unitName]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cleanup_stop_authorizations').get()).toEqual({ count: 2 });

    db.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
});
