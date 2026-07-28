import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildHealthSnapshot, createStructuredRecord } from '../../api/src/health.js';
import { createRetentionStartupHook, type RetentionPaths } from '../../api/src/retention.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { createStartupCoordinator } from '../../api/src/startup-order.js';

const pathsToRemove: string[] = [];
const SHA40 = 'a'.repeat(40);
const SHA64 = 'b'.repeat(64);

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
});
