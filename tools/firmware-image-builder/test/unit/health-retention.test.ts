import { mkdtemp, mkdir, rm, utimes, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHealthSnapshot,
  createStructuredRecord,
  type HealthInput,
} from '../../api/src/health.js';
import {
  createRetentionStartupHook,
  RETENTION_DAYS,
  type RetentionPaths,
  type RetentionPruneRecord,
} from '../../api/src/retention.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';

const roots: string[] = [];
const databases: Array<{ close: () => void }> = [];
const NOW = '2026-07-28T12:00:00.000Z';
const OLD = '2025-12-01T12:00:00.000Z';

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function healthInput(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    queueDepth: 3,
    activeJob: {
      jobId: 'job-1',
      currentStage: 'build',
      lastEventAt: '2026-07-28T11:59:00.000Z',
      preflightExpiresAt: '2026-07-28T13:00:00.000Z',
      terminalError: { code: 'BUILD_FAILED', details: { stderr: 'compiler failed' }, at: '2026-07-28T11:30:00.000Z' },
      queueBlockers: [{ code: 'PREFLIGHT_EXPIRED', details: { reason: 'old' } }],
      recoveryBlockers: [{ code: 'QUARANTINE_PENDING', details: { path: 'jobs/job-1' } }],
      staleLogAt: '2026-07-28T11:45:00.000Z',
      runner: { liveness: 'active' },
      cleanup: { status: 'claimed', generation: 4, handBackPending: true },
      container: {
        id: 'container-1',
        name: 'osi-job-1',
        imageDigest: 'a'.repeat(64),
        labels: { 'org.osi.image-builder.job-id': 'job-1', 'org.osi.image-builder.manifest-sha': 'b'.repeat(64) },
      },
    },
    diskFreeBytes: 40 * 1024 ** 3,
    builderImage: { id: 'osi-builder:locked', digest: 'c'.repeat(64) },
    ...overrides,
  };
}

describe('builder health and structured records', () => {
  it('returns typed operational fields without credential paths or tokens', () => {
    const snapshot = buildHealthSnapshot(healthInput());

    expect(snapshot).toMatchObject({
      queueDepth: 3,
      activeJobId: 'job-1',
      currentStage: 'build',
      lastEventAt: '2026-07-28T11:59:00.000Z',
      diskFreeBytes: 40 * 1024 ** 3,
      builderImage: { id: 'osi-builder:locked', digest: 'c'.repeat(64) },
      container: { id: 'container-1', name: 'osi-job-1', imageDigest: 'a'.repeat(64) },
      preflightExpiresAt: '2026-07-28T13:00:00.000Z',
      cleanup: { status: 'claimed', generation: 4, handBackPending: true },
    });
    expect(snapshot.lastEventAgeSeconds).toBe(60);
    expect(snapshot.staleLogAgeSeconds).toBe(900);
    expect(snapshot.queueBlockers).toEqual([{ code: 'PREFLIGHT_EXPIRED', details: { reason: 'old' } }]);
    expect(snapshot.recoveryBlockers).toEqual([{ code: 'QUARANTINE_PENDING', details: { path: 'jobs/job-1' } }]);
    expect(snapshot).not.toHaveProperty('credentialPath');
    expect(JSON.stringify(snapshot)).not.toContain('token');
  });

  it('records job, stage, command, and timestamp while redacting the fixed secret denylist', () => {
    const record = createStructuredRecord({
      jobId: 'job-1',
      stage: 'build',
      commandId: 'build-image',
      timestamp: NOW,
      fields: {
        argv: ['make', 'image'],
        DOCKER_AUTH_TOKEN: 'secret-token',
        API_PASSWORD: 'secret-password',
        safe: 'kept',
        env: { SHOULD_NOT_BE_LOGGED: 'whole-env' },
      },
    });

    expect(record).toMatchObject({ jobId: 'job-1', stage: 'build', commandId: 'build-image', timestamp: NOW });
    expect(record.fields).toEqual({
      argv: ['make', 'image'],
      DOCKER_AUTH_TOKEN: '[redacted]',
      API_PASSWORD: '[redacted]',
      safe: 'kept',
      env: '[redacted]',
    });
    expect(JSON.stringify(record)).not.toContain('secret-token');
    expect(JSON.stringify(record)).not.toContain('whole-env');
  });
});

describe('startup retention', () => {
  async function retentionWorkspace(): Promise<RetentionPaths> {
    const root = await mkdtemp(join(tmpdir(), 'osi-image-builder-retention-'));
    roots.push(root);
    const stateRoot = join(root, 'state');
    const approvedRoot = join(root, 'approved');
    const workRoot = join(stateRoot, '.osi-image-builder');
    const quarantine = join(approvedRoot, '.osi-image-builder', 'quarantine');
    await mkdir(join(workRoot, 'worktrees'), { recursive: true });
    await mkdir(join(workRoot, 'cache', 'docker'), { recursive: true });
    await mkdir(join(workRoot, 'cache', 'openwrt'), { recursive: true });
    await mkdir(join(workRoot, 'logs'), { recursive: true });
    await mkdir(join(quarantine, 'old-job'), { recursive: true });
    await mkdir(join(approvedRoot, 'main', 'sha', 'rpi-5'), { recursive: true });
    await writeFile(join(workRoot, 'worktrees', 'terminal-old'), 'old');
    await writeFile(join(workRoot, 'worktrees', 'active-old'), 'active');
    await writeFile(join(workRoot, 'cache', 'docker', 'old'), 'old');
    await writeFile(join(workRoot, 'cache', 'openwrt', 'old'), 'old');
    await writeFile(join(workRoot, 'logs', 'old.log'), 'old');
    await writeFile(join(quarantine, 'old-job', 'partial'), 'old');
    await writeFile(join(approvedRoot, 'main', 'sha', 'rpi-5', 'release.img.gz'), 'immutable');
    const oldTime = new Date(OLD);
    for (const path of [join(workRoot, 'worktrees', 'terminal-old'), join(workRoot, 'worktrees', 'active-old'), join(workRoot, 'cache', 'docker', 'old'), join(workRoot, 'cache', 'openwrt', 'old'), join(workRoot, 'logs', 'old.log'), join(quarantine, 'old-job')]) {
      await utimes(path, oldTime, oldTime);
    }
    return { stateRoot, approvedQuarantineRoots: [quarantine], builderOwnedRoots: [workRoot], approvedReleaseRoots: [approvedRoot], worktreeRoot: join(workRoot, 'worktrees') };
  }

  it('prunes old builder state and quarantine, never releases or symlink targets, and records the startup run', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('terminal-old', 'request-terminal-old', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'building', 'dispatched', ?, ?, '{}', '{}')`)
      .run('active-old', 'request-active-old', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs'), { recursive: true });
    const external = await mkdtemp(join(tmpdir(), 'osi-image-builder-retention-external-'));
    roots.push(external);
    await writeFile(join(external, 'secret'), 'keep');
    await symlink(join(external, 'secret'), join(paths.builderOwnedRoots[0]!, 'logs', 'link'));
    const records: RetentionPruneRecord[] = [];
    const hook = createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      recordPrune: async (record) => { records.push(record); },
    });

    await expect(hook()).resolves.toEqual({ blockers: [] });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.builderOwnedRoots[0]!, 'worktrees', 'terminal-old')))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.builderOwnedRoots[0]!, 'worktrees', 'active-old')))).resolves.toBeUndefined();
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.approvedQuarantineRoots[0]!, 'old-job')))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(external, 'secret'), 'utf8'))).resolves.toBe('keep');
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(paths.approvedReleaseRoots[0]!, 'main', 'sha', 'rpi-5', 'release.img.gz'), 'utf8'))).resolves.toBe('immutable');
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records.some((record) => record.relativePath === '.osi-image-builder/worktrees/terminal-old')).toBe(true);
    expect(records.every((record) => record.timestamp === NOW)).toBe(true);
    expect(RETENTION_DAYS).toEqual({ rows: 180, evidence: 180, logs: 180, worktrees: 7, caches: 30, quarantine: 180 });
  });

  it('does not prune caches below the 20 GiB floor', async () => {
    const paths = await retentionWorkspace();
    const records: RetentionPruneRecord[] = [];
    await createRetentionStartupHook({ paths, now: NOW, freeBytes: 19 * 1024 ** 3, recordPrune: async (record) => { records.push(record); } })();
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old')))).resolves.toBeUndefined();
    expect(records.some((record) => record.category === 'cache')).toBe(false);
  });
});
