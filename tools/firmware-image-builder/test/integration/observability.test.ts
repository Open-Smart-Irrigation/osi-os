import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildHealthSnapshot, collectHealthSnapshot, createStructuredRecord } from '../../api/src/health.js';
import { createRetentionStartupHook, type RetentionPaths } from '../../api/src/retention.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { createStartupCoordinator } from '../../api/src/startup-order.js';

const pathsToRemove: string[] = [];
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);
const NOW = '2026-07-28T12:00:00.000Z';

function insertTerminalJob(db: ReturnType<typeof openBuilderDatabase>, jobId: string, terminalAt: string): void {
  db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
    .run(jobId, `request-${jobId}`, SHA40, SHA40, SHA64, terminalAt, terminalAt, terminalAt, terminalAt, terminalAt);
}

afterEach(async () => {
  await Promise.all(pathsToRemove.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('observability integration', () => {
  it('persists each retention prune and composes as the startup retention phase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-observability-'));
    pathsToRemove.push(root);
    const stateRoot = join(root, 'state');
    const builderRoot = join(stateRoot, '.osi-image-builder');
    const approvedRoot = join(root, 'approved');
    const quarantine = join(root, 'approved', '.osi-image-builder', 'quarantine');
    await mkdir(join(builderRoot, 'worktrees'), { recursive: true });
    await mkdir(approvedRoot, { recursive: true });
    await mkdir(quarantine, { recursive: true });
    await mkdir(join(builderRoot, 'worktrees', 'row-old'), { recursive: true });
    await writeFile(join(builderRoot, 'worktrees', 'row-old', 'source'), 'old');
    await mkdir(join(stateRoot, 'jobs', 'row-old', 'evidence'), { recursive: true });
    await writeFile(join(stateRoot, 'jobs', 'row-old', 'evidence', 'terminal.json'), 'evidence');
    await mkdir(join(stateRoot, 'jobs', 'replayable-log', 'logs'), { recursive: true });
    await writeFile(join(stateRoot, 'jobs', 'replayable-log', 'logs', 'runner-0.log'), 'log');

    const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
    insertTerminalJob(db, 'row-old', '2025-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run('row-old', 1, '2025-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)").run('row-old', '2025-01-01T00:00:00.000Z');
    insertTerminalJob(db, 'replayable-log', '2026-06-01T00:00:00.000Z');
    db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, 0, ?, ?, 4)').run('replayable-log', 'runner', 'logs/runner-0.log', '2025-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, 0, 'log', 'succeeded', '{}', ?, 'runner', 0, 0, 4, 0)").run('replayable-log', '2025-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO retention_prunes (category, relative_path, action, bytes, at) VALUES ('row', 'jobs/expired-audit', 'removed', 0, '2025-01-01T00:00:00.000Z')").run();
    const retentionPaths: RetentionPaths = {
      stateRoot,
      builderOwnedRoots: [builderRoot],
      approvedQuarantineRoots: [quarantine],
      approvedReleaseRoots: [approvedRoot],
      worktreeRoot: join(builderRoot, 'worktrees'),
    };
    const hook = createRetentionStartupHook({ db, paths: retentionPaths, now: '2026-07-28T12:00:00.000Z', freeBytes: 30 * 1024 ** 3 });
    const order: string[] = [];
    const phase = (name: string) => async () => { order.push(name); return { blockers: [] }; };
    const startup = createStartupCoordinator({
      migrations: phase('migrations'),
      cleanupAdmissions: phase('cleanup-admissions'),
      liveRunnerClassification: phase('live-runner-classification'),
      stalePublishingRecovery: phase('stale-publishing-recovery'),
      nonPublishingInterruption: phase('non-publishing-interruption'),
      retention: async () => { order.push('retention'); return hook(); },
      dispatch: phase('dispatch'),
    });

    await expect(startup.start()).resolves.toMatchObject({ dispatched: true, blockers: [] });
    expect(order).toEqual(['migrations', 'cleanup-admissions', 'live-runner-classification', 'stale-publishing-recovery', 'non-publishing-interruption', 'retention', 'dispatch']);
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id IN (?, ?) ORDER BY job_id').all('row-old', 'replayable-log')).toEqual([{ job_id: 'replayable-log' }]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM queue_entries WHERE job_id=?').get('row-old')).toEqual({ count: 0 });
    expect(db.prepare('SELECT category, relative_path, action, at FROM retention_prunes ORDER BY prune_id').all()).toEqual([
      { category: 'worktree', relative_path: '.osi-image-builder/worktrees/row-old', action: 'removed', at: '2026-07-28T12:00:00.000Z' },
      { category: 'evidence', relative_path: 'jobs/row-old/evidence/terminal.json', action: 'removed', at: '2026-07-28T12:00:00.000Z' },
      { category: 'row', relative_path: 'jobs/row-old', action: 'removed', at: '2026-07-28T12:00:00.000Z' },
    ]);
    await expect(import('node:fs/promises').then(({ access }) => access(join(stateRoot, 'jobs', 'row-old', 'evidence', 'terminal.json')))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(stateRoot, 'jobs', 'replayable-log', 'logs', 'runner-0.log'), 'utf8'))).resolves.toBe('log');
    expect(db.prepare('SELECT COUNT(*) AS count FROM retention_prunes WHERE at < ?').get('2026-01-29T00:00:00.000Z')).toEqual({ count: 0 });
    db.close();
  });

  it('exposes observability records without whole-environment or credential material', () => {
    const record = createStructuredRecord({
      jobId: 'job-observe', stage: 'verify', commandId: 'verify-image', timestamp: '2026-07-28T12:00:00.000Z',
      fields: { status: 'passed', env: { HOME: '/home/phil', TOKEN: 'do-not-log' }, credentialPath: '/secret/token' },
    });
    const snapshot = buildHealthSnapshot({
      now: '2026-07-28T12:00:00.000Z', queueDepth: 0, activeJob: null, diskFreeBytes: 25 * 1024 ** 3,
      builderImage: { id: 'builder', digest: 'd'.repeat(64) },
    });
    expect(record.fields).toEqual({ status: 'passed', env: '[redacted]', credentialPath: '[redacted]' });
    expect(snapshot).not.toHaveProperty('credentialPath');
    expect(snapshot).not.toHaveProperty('token');
    expect(JSON.stringify(record)).not.toContain('/secret/token');
  });

  it('uses the global last event when no job is active and only completed cleanup is pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-health-'));
    pathsToRemove.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('health-terminal', 'request-health-terminal', SHA40, SHA40, SHA64, '2026-07-28T11:00:00.000Z', '2026-07-28T11:00:00.000Z', '2026-07-28T11:00:00.000Z', '2026-07-28T11:00:00.000Z', '2026-07-28T11:00:00.000Z');
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)").run('health-terminal', '2026-07-28T11:59:00.000Z');
    const snapshot = (await import('../../api/src/health.js')).collectHealthSnapshot({ db, now: NOW, diskFreeBytes: 25 * 1024 ** 3, builderImage: null });
    expect(snapshot.lastEventAt).toBe('2026-07-28T11:59:00.000Z');
    expect(snapshot.lastEventAgeSeconds).toBe(60);
    db.close();
  });

  it('retains the newest terminal error when a newer terminal job succeeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-health-terminal-error-'));
    pathsToRemove.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
    insertTerminalJob(db, 'failed-terminal', '2026-07-28T10:00:00.000Z');
    db.prepare("UPDATE jobs SET state='failed', terminal_error_code='BUILD_FAILED', terminal_error_json=? WHERE job_id=?")
      .run('{"reason":"compile"}', 'failed-terminal');
    insertTerminalJob(db, 'successful-terminal', '2026-07-28T11:00:00.000Z');

    const snapshot = collectHealthSnapshot({ db, now: NOW, diskFreeBytes: 25 * 1024 ** 3, builderImage: null });

    expect(snapshot.lastTerminalError).toEqual({
      code: 'BUILD_FAILED',
      details: { reason: 'compile' },
      at: '2026-07-28T10:00:00.000Z',
    });
    db.close();
  });

  it('exposes interrupted jobs with pending cleanup and a completed cleanup lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-health-cleanup-'));
    pathsToRemove.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
    insertTerminalJob(db, 'interrupted-cleanup', '2026-07-28T11:00:00.000Z');
    const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
    const tokenHash = 'c'.repeat(64);
    db.prepare(`INSERT INTO cleanup_leases
      (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path,
       credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at, claim_at,
       complete_at, completion_evidence_path, completion_evidence_sha256)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`)
      .run(admissionId, 'interrupted-cleanup', `osi-image-builder-cleanup@${admissionId}.service`, 'health-test', NOW,
        `recovery/cleanup-credentials/${admissionId}.token`, 'd'.repeat(64), 4, tokenHash,
        '2026-07-28T10:59:00.000Z', '2026-07-28T10:59:01.000Z', '2026-07-28T10:59:02.000Z',
        'recovery/cleanup-evidence.json', 'e'.repeat(64));
    db.prepare(`UPDATE jobs SET state='interrupted', terminal_error_code='CANCELLED', terminal_error_json='{}',
      cleanup_generation=4, cleanup_fence_generation=4, cleanup_fence_token_hash=?, cleanup_admission_id=?
      WHERE job_id=?`).run(tokenHash, admissionId, 'interrupted-cleanup');

    const snapshot = collectHealthSnapshot({ db, now: NOW, diskFreeBytes: 25 * 1024 ** 3, builderImage: null });
    expect(snapshot.activeJobId).toBe('interrupted-cleanup');
    expect(snapshot.cleanup).toEqual({ status: 'completed', generation: 4, handBackPending: true });
    expect(snapshot.recoveryBlockers).toEqual([]);
    db.close();
  });

  it('binds the terminal error to the active pending-cleanup job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-health-terminal-ownership-'));
    pathsToRemove.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
    insertTerminalJob(db, 'cleanup-job-a', '2026-07-28T11:00:00.000Z');
    insertTerminalJob(db, 'unrelated-job-b', '2026-07-28T11:30:00.000Z');
    const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
    const tokenHash = 'c'.repeat(64);
    db.prepare(`INSERT INTO cleanup_leases
      (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path,
       credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at, claim_at,
       complete_at, completion_evidence_path, completion_evidence_sha256)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`).run(
      admissionId, 'cleanup-job-a', `osi-image-builder-cleanup@${admissionId}.service`, 'health-test', NOW,
      `recovery/cleanup-credentials/${admissionId}.token`, 'd'.repeat(64), 4, tokenHash,
      '2026-07-28T10:59:00.000Z', '2026-07-28T10:59:01.000Z', '2026-07-28T10:59:02.000Z',
      'recovery/cleanup-evidence.json', 'e'.repeat(64));
    db.prepare(`UPDATE jobs SET state='interrupted', terminal_error_code='CLEANUP_UNIT_STOP_FAILED', terminal_error_json=?,
      cleanup_generation=4, cleanup_fence_generation=4, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?`)
      .run('{"job":"A"}', tokenHash, admissionId, 'cleanup-job-a');
    db.prepare(`UPDATE jobs SET state='failed', terminal_error_code='BUILD_FAILED', terminal_error_json='{"job":"B"}' WHERE job_id=?`).run('unrelated-job-b');

    const snapshot = collectHealthSnapshot({ db, now: NOW, diskFreeBytes: 25 * 1024 ** 3, builderImage: null });
    expect(snapshot.activeJobId).toBe('cleanup-job-a');
    expect(snapshot.lastTerminalError).toEqual({ code: 'CLEANUP_UNIT_STOP_FAILED', details: { job: 'A' }, at: '2026-07-28T11:00:00.000Z' });
    db.close();
  });

  it('does not expose an unrelated global terminal error for an active pending-cleanup job without one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-health-terminal-fallback-'));
    pathsToRemove.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
    insertTerminalJob(db, 'older-failed-job', '2026-07-28T10:00:00.000Z');
    db.prepare("UPDATE jobs SET state='failed', terminal_error_code='BUILD_FAILED', terminal_error_json=? WHERE job_id=?")
      .run('{"job":"older"}', 'older-failed-job');
    insertTerminalJob(db, 'active-cleanup-job', '2026-07-28T11:00:00.000Z');
    const admissionId = 'cln_0123456789abcdefghjkmnpqrs';
    const tokenHash = 'c'.repeat(64);
    db.prepare(`INSERT INTO cleanup_leases
      (admission_id, job_id, unit_name, owner, expires_at, status, credential_relative_path,
       credential_sha256, fence_generation, fence_token_hash, proof_json, admitted_at, claim_at,
       complete_at, completion_evidence_path, completion_evidence_sha256)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`).run(
      admissionId, 'active-cleanup-job', `osi-image-builder-cleanup@${admissionId}.service`, 'health-test', NOW,
      `recovery/cleanup-credentials/${admissionId}.token`, 'd'.repeat(64), 4, tokenHash,
      '2026-07-28T10:59:00.000Z', '2026-07-28T10:59:01.000Z', '2026-07-28T10:59:02.000Z',
      'recovery/cleanup-evidence.json', 'e'.repeat(64));
    db.prepare(`UPDATE jobs SET state='succeeded', terminal_error_code=NULL, terminal_error_json=NULL,
      cleanup_generation=4, cleanup_fence_generation=4, cleanup_fence_token_hash=?, cleanup_admission_id=? WHERE job_id=?`)
      .run(tokenHash, admissionId, 'active-cleanup-job');

    const snapshot = collectHealthSnapshot({ db, now: NOW, diskFreeBytes: 25 * 1024 ** 3, builderImage: null });
    expect(snapshot.activeJobId).toBe('active-cleanup-job');
    expect(snapshot.lastTerminalError).toBeNull();
    db.close();
  });
});
