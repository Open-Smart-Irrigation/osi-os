import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import {
  createCleanupAdmissionRecovery,
  type CleanupAdmissionRecovery,
  type RecoveryDatabase,
} from '../../api/src/recovery.js';

const JOB_ID = 'job-reservation-race';
const OWNER = 'owner-reservation-race';
const UNIT_NAME = 'osi-image-builder-runner@job-reservation-race.service';
const NOW = '2026-07-27T12:00:00.000Z';

function seedJob(db: ReturnType<typeof openBuilderDatabase>): void {
  db.prepare(
    `INSERT INTO jobs (
       job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha,
       target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject,
       accepted_at, state, queue_state, created_at, updated_at, source_preparation_json,
       offline_feed_preparation_json, runner_unit
     ) VALUES (?, ?, 'origin', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'release', ?, ?, 'owner', 'cleanup race', ?, 'starting', 'dispatched', ?, ?, '{}', '{}', ?)`,
  ).run(JOB_ID, `${JOB_ID}-request`, 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), NOW, NOW, NOW, NOW, UNIT_NAME);
}

function runnerSnapshot() {
  return {
    runner: {
      unit: UNIT_NAME,
      owner: null,
      leaseExpiresAt: null,
      inactiveAt: NOW,
      observedAt: NOW,
    },
    state: 'starting' as const,
    container: { kind: 'absent' as const, globalLabelResult: 'no-match' as const, observedAt: NOW },
    staging: { kind: 'absent' as const, path: null },
    logs: { runner: 'absent' as const, docker: 'absent' as const, verifiedAt: NOW },
    blocker: 'none' as const,
  };
}

function recovery(
  db: ReturnType<typeof openBuilderDatabase>,
  root: string,
  onCredentialWritten?: () => Promise<void>,
): CleanupAdmissionRecovery {
  const ownership = new OwnershipStore(db);
  return createCleanupAdmissionRecovery({
    db: db as unknown as RecoveryDatabase,
    ownership,
    stateRoot: root,
    clock: { now: () => NOW },
    crypto: { randomBytes: (size) => Buffer.alloc(size, 7) },
    systemd: {
      async start() {},
      async isActive() {
        return false;
      },
    },
    onCredentialWritten,
  });
}

describe('Task20 correction round 2', () => {
  it('keeps a credential reserved across a concurrent facade prune', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleanup-admission-reservation-race-'));
    const dbPath = join(root, 'builder.db');
    const dbA = openBuilderDatabase(dbPath);
    seedJob(dbA);
    const dbB = openBuilderDatabase(dbPath);
    let written!: () => void;
    const writtenPromise = new Promise<void>((resolve) => { written = resolve; });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const facadeA = recovery(dbA, root, async () => { written(); await pause; });
    const facadeB = recovery(dbB, root);
    await facadeA.openAdmissions();

    const admission = facadeA.admitAndStart({
      jobId: JOB_ID,
      owner: OWNER,
      expiresAt: '2026-07-27T12:05:00.000Z',
      snapshot: runnerSnapshot(),
      at: NOW,
    });
    await writtenPromise;

    await facadeB.openAdmissions();
    const credentials = await readdir(join(root, 'jobs', JOB_ID, 'recovery', 'cleanup-credentials'));
    expect(credentials).toHaveLength(1);

    release();
    await admission;
    expect(dbA.prepare('SELECT status FROM cleanup_leases WHERE job_id = ?').get(JOB_ID)).toEqual({ status: 'admitted' });
  });

  it('removes an expired reservation before pruning its orphan credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleanup-admission-expired-reservation-'));
    const db = openBuilderDatabase(join(root, 'builder.db'));
    seedJob(db);
    const relativePath = `recovery/cleanup-credentials/cln_${'0'.repeat(26)}.token`;
    await mkdir(join(root, 'jobs', JOB_ID, 'recovery', 'cleanup-credentials'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'jobs', JOB_ID, relativePath), 'orphan-token\n', { mode: 0o600 });
    db.prepare(
      `INSERT INTO cleanup_credential_reservations
       (job_id, admission_id, owner, credential_relative_path, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(JOB_ID, `cln_${'0'.repeat(26)}`, OWNER, relativePath, '2026-07-27T11:59:00.000Z', NOW);
    const facade = recovery(db, root);
    await facade.openAdmissions();

    await expect(readdir(join(root, 'jobs', JOB_ID, 'recovery', 'cleanup-credentials'))).resolves.toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cleanup_credential_reservations').get()).toEqual({ count: 0 });
  });
});
