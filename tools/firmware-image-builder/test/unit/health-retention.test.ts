import { lstat, mkdtemp, mkdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
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
      cleanup: { status: 'completed', generation: 4, handBackPending: true },
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
      cleanup: { status: 'completed', generation: 4, handBackPending: true },
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

  it('retains a recovery-owned terminal worktree until its cleanup blocker is cleared', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    await writeFile(join(paths.worktreeRoot!, 'recovery-owned'), 'recovery-owned');
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, cleanup_blocker_code, cleanup_blocker_json, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, ?, ?, '{}', '{}')`)
      .run('recovery-owned', 'request-recovery-owned', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD, 'CLEANUP_ADMISSION_BLOCKED', '{"owner":"recovery"}');

    const records: RetentionPruneRecord[] = [];
    const startup = () => createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      recordPrune: async (record) => { records.push(record); },
    })();

    await expect(startup()).resolves.toEqual({ blockers: [] });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.worktreeRoot!, 'recovery-owned')))).resolves.toBeUndefined();
    expect(records.some((record) => record.category === 'worktree' && record.relativePath.endsWith('/recovery-owned'))).toBe(false);

    db.prepare('UPDATE jobs SET cleanup_blocker_code=NULL, cleanup_blocker_json=NULL WHERE job_id=?').run('recovery-owned');
    records.length = 0;
    await expect(startup()).resolves.toEqual({ blockers: [] });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.worktreeRoot!, 'recovery-owned')))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(records.some((record) => record.category === 'worktree' && record.relativePath.endsWith('/recovery-owned'))).toBe(true);
  });

  it('prunes only terminal quarantine jobs past retention while pruning aged DB-confirmed orphans', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const quarantineRoot = paths.approvedQuarantineRoots[0]!;
    const insertJob = (jobId: string, state: string, blocker: string | null = null, artifactPath: string | null = `quarantine/${jobId}`) => {
      db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, ?, 'complete', ?, ?, ?, '{}', '{}')`)
        .run(jobId, `request-${jobId}`, 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, state, OLD, OLD, state === 'succeeded' ? OLD : null);
      if (blocker !== null) db.prepare('UPDATE jobs SET cleanup_blocker_code=?, cleanup_blocker_json=? WHERE job_id=?').run(blocker, '{}', jobId);
      if (artifactPath !== null) db.prepare("UPDATE jobs SET publish_state='quarantined', artifact_quarantine_path=? WHERE job_id=?").run(artifactPath, jobId);
    };
    insertJob('active-quarantine', 'building', null, null);
    insertJob('recovery-quarantine', 'succeeded', 'CLEANUP_ADMISSION_BLOCKED');
    insertJob('terminal-quarantine', 'succeeded');
    for (const jobId of ['active-quarantine', 'recovery-quarantine', 'terminal-quarantine', 'orphan-quarantine']) {
      await mkdir(join(quarantineRoot, jobId), { recursive: true });
      await writeFile(join(quarantineRoot, jobId, 'artifact.bin'), jobId);
      await utimes(join(quarantineRoot, jobId), new Date(OLD), new Date(OLD));
    }
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('quarantine', '.osi-image-builder/quarantine/active-quarantine', 'planned', ?, ?, 1)`).run(OLD, OLD);
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('quarantine', '.osi-image-builder/quarantine/recovery-quarantine', 'removed', ?, ?, 1)`).run(OLD, OLD);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });

    for (const jobId of ['active-quarantine', 'recovery-quarantine']) {
      await expect(import('node:fs/promises').then(({ access }) => access(join(quarantineRoot, jobId)))).resolves.toBeUndefined();
    }
    expect(db.prepare("SELECT status FROM retention_prune_intents WHERE relative_path='.osi-image-builder/quarantine/active-quarantine'").get()).toEqual({ status: 'planned' });
    expect(db.prepare("SELECT status FROM retention_prune_intents WHERE relative_path='.osi-image-builder/quarantine/recovery-quarantine'").get()).toEqual({ status: 'removed' });
    await expect(import('node:fs/promises').then(({ access }) => access(join(quarantineRoot, 'terminal-quarantine')))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(import('node:fs/promises').then(({ access }) => access(join(quarantineRoot, 'orphan-quarantine')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records quarantine intents before mutation and retries stale planned and failed intents', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const quarantineRoot = paths.approvedQuarantineRoots[0]!;
    for (const jobId of ['new-quarantine', 'planned-quarantine', 'failed-quarantine']) {
      await mkdir(join(quarantineRoot, jobId), { recursive: true });
      await writeFile(join(quarantineRoot, jobId, 'artifact.bin'), jobId);
      await utimes(join(quarantineRoot, jobId), new Date(OLD), new Date(OLD));
    }
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('quarantine', ?, 'planned', ?, ?, 7)`).run('.osi-image-builder/quarantine/planned-quarantine', NOW, NOW);
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('quarantine', ?, 'failed', ?, ?, 7)`).run('.osi-image-builder/quarantine/failed-quarantine', NOW, NOW);
    const newQuarantineIdentity = await lstat(join(quarantineRoot, 'new-quarantine'));
    const observed: Array<{ path: string; status: unknown; targetDev: unknown; targetIno: unknown }> = [];

    await createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeDelete: async ({ path }) => {
        if (path === join(quarantineRoot, 'new-quarantine')) {
          const intent = db.prepare(`SELECT status, target_dev, target_ino FROM retention_prune_intents
            WHERE category='quarantine' AND relative_path='.osi-image-builder/quarantine/new-quarantine'`).get();
          observed.push({ path, status: intent?.status, targetDev: intent?.target_dev, targetIno: intent?.target_ino });
        }
      },
    })();

    expect(observed).toEqual([{
      path: join(quarantineRoot, 'new-quarantine'),
      status: 'planned',
      targetDev: newQuarantineIdentity.dev,
      targetIno: newQuarantineIdentity.ino,
    }]);
    for (const jobId of ['new-quarantine', 'planned-quarantine', 'failed-quarantine']) {
      expect(db.prepare('SELECT status, error FROM retention_prune_intents WHERE category=? AND relative_path=?').get('quarantine', `.osi-image-builder/quarantine/${jobId}`)).toEqual({ status: 'removed', error: null });
      expect(db.prepare('SELECT action FROM retention_prunes WHERE category=? AND relative_path=? ORDER BY prune_id DESC LIMIT 1').get('quarantine', `.osi-image-builder/quarantine/${jobId}`)).toEqual({ action: 'removed' });
    }
  });

  it.each(['mtime', 'entry'] as const)('retains a fresh-scan quarantine when beforeDelete refreshes its %s', async (mutation) => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const jobId = `freshened-${mutation}`;
    const quarantineRoot = join(paths.approvedQuarantineRoots[0]!, jobId);
    const intentPath = `.osi-image-builder/quarantine/${jobId}`;
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(join(quarantineRoot, 'original.bin'), 'original');
    await utimes(quarantineRoot, new Date(OLD), new Date(OLD));

    await expect(createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeDelete: async ({ path }) => {
        if (path !== quarantineRoot) return;
        if (mutation === 'entry') await writeFile(join(path, 'added.bin'), 'added');
        else await utimes(path, new Date(NOW), new Date(NOW));
      },
    })()).resolves.toEqual({ blockers: [] });

    await expect(import('node:fs/promises').then(({ access }) => access(quarantineRoot))).resolves.toBeUndefined();
    if (mutation === 'entry') {
      await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(quarantineRoot, 'added.bin'), 'utf8'))).resolves.toBe('added');
    }
    expect(db.prepare('SELECT status FROM retention_prune_intents WHERE category=? AND relative_path=?').get('quarantine', intentPath)).toBeUndefined();
  });

  it('fences cleanup ownership acquisition from the final eligibility check through quarantine deletion', async () => {
    const paths = await retentionWorkspace();
    const databasePath = join(paths.stateRoot, 'jobs.sqlite');
    const db = openBuilderDatabase(databasePath);
    databases.push(db);
    const jobId = 'ownership-race';
    const quarantineRoot = join(paths.approvedQuarantineRoots[0]!, jobId);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, publish_state, artifact_quarantine_path, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, 'quarantined', ?, '{}', '{}')`)
      .run(jobId, `request-${jobId}`, 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD, `quarantine/${jobId}`);
    await mkdir(quarantineRoot, { recursive: true });
    await Promise.all(Array.from({ length: 512 }, (_, index) => writeFile(
      join(quarantineRoot, `${String(index).padStart(4, '0')}.bin`),
      String(index),
    )));
    await utimes(quarantineRoot, new Date(OLD), new Date(OLD));

    let workerResult: Promise<{ outcome: string; code?: string; message?: string }> | undefined;
    await expect(createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeDelete: async ({ path }) => {
        if (path !== quarantineRoot) return;
        let ready!: () => void;
        const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
        workerResult = new Promise((resolve, reject) => {
          const worker = new Worker(`
            const { existsSync, readdirSync } = require('node:fs');
            const { DatabaseSync } = require('node:sqlite');
            const { parentPort, workerData } = require('node:worker_threads');
            (() => {
              const db = new DatabaseSync(workerData.databasePath);
              db.exec('PRAGMA busy_timeout=1');
              parentPort.postMessage({ kind: 'ready' });
              const sleep = new Int32Array(new SharedArrayBuffer(4));
              const deadline = Date.now() + 5000;
              while (existsSync(workerData.target) && readdirSync(workerData.target).length === workerData.initialEntries) {
                if (Date.now() >= deadline) {
                  parentPort.postMessage({ kind: 'result', outcome: 'timeout' });
                  db.close();
                  return;
                }
                Atomics.wait(sleep, 0, 0, 1);
              }
              try {
                db.prepare("UPDATE jobs SET cleanup_blocker_code='CLEANUP_ADMISSION_BLOCKED', cleanup_blocker_json='{}' WHERE job_id=?")
                  .run(workerData.jobId);
                parentPort.postMessage({ kind: 'result', outcome: 'acquired' });
              } catch (error) {
                parentPort.postMessage({ kind: 'result', outcome: 'blocked', code: error.code, message: error.message });
              } finally {
                db.close();
              }
            })();
          `, { eval: true, workerData: { databasePath, target: quarantineRoot, initialEntries: 512, jobId } });
          worker.once('error', reject);
          worker.on('message', (message: { kind: string; outcome?: string; code?: string; message?: string }) => {
            if (message.kind === 'ready') ready();
            if (message.kind === 'result') resolve({ outcome: message.outcome!, code: message.code, message: message.message });
          });
        });
        await readyPromise;
      },
    })()).resolves.toEqual({ blockers: [] });

    await expect(workerResult).resolves.toMatchObject({
      outcome: 'blocked',
      code: 'ERR_SQLITE_ERROR',
      message: expect.stringContaining('database is locked'),
    });
    await expect(import('node:fs/promises').then(({ access }) => access(quarantineRoot))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['planned', 'failed'] as const)('resumes a %s quarantine intent despite a refreshed root mtime after partial deletion', async (status) => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const jobId = `interrupted-${status}`;
    const quarantineRoot = join(paths.approvedQuarantineRoots[0]!, jobId);
    const relativePath = `.osi-image-builder/quarantine/${jobId}`;
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, publish_state, artifact_quarantine_path, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, 'quarantined', ?, '{}', '{}')`)
      .run(jobId, `request-${jobId}`, 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD, `quarantine/${jobId}`);
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(join(quarantineRoot, 'remaining.bin'), 'remaining');
    await writeFile(join(quarantineRoot, 'already-removed.bin'), 'removed before crash');
    await rm(join(quarantineRoot, 'already-removed.bin'));
    await utimes(quarantineRoot, new Date(NOW), new Date(NOW));
    const targetIdentity = await lstat(quarantineRoot);
    db.prepare(`INSERT INTO retention_prune_intents
        (category, relative_path, status, planned_at, updated_at, bytes, target_dev, target_ino)
      VALUES ('quarantine', ?, ?, ?, ?, 9, ?, ?)`)
      .run(relativePath, status, OLD, OLD, targetIdentity.dev, targetIdentity.ino);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });

    await expect(import('node:fs/promises').then(({ access }) => access(quarantineRoot))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(db.prepare('SELECT status, error FROM retention_prune_intents WHERE category=? AND relative_path=?').get('quarantine', relativePath))
      .toEqual({ status: 'removed', error: null });
  });

  it.each(['planned', 'failed'] as const)('skips a stale %s intent when a fresh quarantine replaces the original inode', async (status) => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const jobId = `replaced-${status}`;
    const quarantineRoot = join(paths.approvedQuarantineRoots[0]!, jobId);
    const displacedRoot = join(paths.stateRoot, `${jobId}-original`);
    const relativePath = `.osi-image-builder/quarantine/${jobId}`;
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(join(quarantineRoot, 'original.bin'), 'original');
    await utimes(quarantineRoot, new Date(OLD), new Date(OLD));
    const originalIdentity = await lstat(quarantineRoot);
    db.prepare(`INSERT INTO retention_prune_intents
        (category, relative_path, status, planned_at, updated_at, bytes, target_dev, target_ino)
      VALUES ('quarantine', ?, ?, ?, ?, 8, ?, ?)`)
      .run(relativePath, status, OLD, OLD, originalIdentity.dev, originalIdentity.ino);
    await rename(quarantineRoot, displacedRoot);
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(join(quarantineRoot, 'fresh.bin'), 'fresh');
    await utimes(quarantineRoot, new Date(NOW), new Date(NOW));

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });

    await expect(import('node:fs/promises').then(({ readFile }) => readFile(join(quarantineRoot, 'fresh.bin'), 'utf8'))).resolves.toBe('fresh');
    expect(db.prepare(`SELECT status, target_dev, target_ino FROM retention_prune_intents
      WHERE category='quarantine' AND relative_path=?`).get(relativePath)).toEqual({
      status: 'skipped',
      target_dev: originalIdentity.dev,
      target_ino: originalIdentity.ino,
    });
    expect(db.prepare(`SELECT action FROM retention_prunes
      WHERE category='quarantine' AND relative_path=? ORDER BY prune_id DESC LIMIT 1`).get(relativePath))
      .toEqual({ action: 'skipped' });
  });

  it('does not replay a completed removed intent against a recreated fresh quarantine', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const jobId = 'recreated-after-removed';
    const quarantineRoot = join(paths.approvedQuarantineRoots[0]!, jobId);
    const relativePath = `.osi-image-builder/quarantine/${jobId}`;
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(join(quarantineRoot, 'new-artifact.bin'), 'new');
    await utimes(quarantineRoot, new Date(NOW), new Date(NOW));
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('quarantine', ?, 'removed', ?, ?, 9)`).run(relativePath, OLD, OLD);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });

    await expect(import('node:fs/promises').then(({ access }) => access(quarantineRoot))).resolves.toBeUndefined();
    expect(db.prepare('SELECT status FROM retention_prune_intents WHERE category=? AND relative_path=?').get('quarantine', relativePath))
      .toEqual({ status: 'removed' });
  });

  it('unlinks nested quarantine symlinks through the held parent without touching external targets', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const quarantineRoot = paths.approvedQuarantineRoots[0]!;
    const external = await mkdtemp(join(tmpdir(), 'osi-image-builder-retention-external-'));
    roots.push(external);
    const target = join(external, 'secret');
    const quarantine = join(quarantineRoot, 'nested-symlink');
    await mkdir(join(quarantine, 'nested'), { recursive: true });
    await writeFile(target, 'keep');
    await symlink(target, join(quarantine, 'nested', 'external-link'));
    await utimes(quarantine, new Date(OLD), new Date(OLD));

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });

    await expect(import('node:fs/promises').then(({ access }) => access(quarantine))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(target, 'utf8'))).resolves.toBe('keep');
  });

  it('evicts eligible caches below the 20 GiB floor', async () => {
    const paths = await retentionWorkspace();
    const records: RetentionPruneRecord[] = [];
    await createRetentionStartupHook({ paths, now: NOW, freeBytes: 19 * 1024 ** 3, recordPrune: async (record) => { records.push(record); } })();
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old')))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(records.some((record) => record.category === 'cache')).toBe(true);
  });

  it('blocks quarantine retention without DB authority while still pruning unrelated cache state', async () => {
    const paths = await retentionWorkspace();
    const quarantine = join(paths.approvedQuarantineRoots[0]!, 'old-job');
    const cache = join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old');

    await expect(createRetentionStartupHook({ paths, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({
      blockers: [{
        code: 'RETENTION_PRUNE_FAILED',
        details: {
          category: 'quarantine',
          relativePath: '.osi-image-builder/quarantine',
          reason: 'database-authority-unavailable',
        },
      }],
    });

    await expect(import('node:fs/promises').then(({ access }) => access(quarantine))).resolves.toBeUndefined();
    await expect(import('node:fs/promises').then(({ access }) => access(cache))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a release root used as its own quarantine and arbitrary containment', async () => {
    const paths = await retentionWorkspace();
    await expect(createRetentionStartupHook({
      paths: { ...paths, approvedQuarantineRoots: [paths.approvedReleaseRoots[0]!] },
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
    })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_ROOT_INVALID' }] });
    await expect(createRetentionStartupHook({
      paths: { ...paths, approvedQuarantineRoots: [join(paths.approvedReleaseRoots[0]!, 'arbitrary-quarantine')] },
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
    })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_ROOT_INVALID' }] });
  });

  it('rejects a release root nested under builder cache before mutation', async () => {
    const paths = await retentionWorkspace();
    const releaseRoot = join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'release');
    const quarantineRoot = join(releaseRoot, '.osi-image-builder', 'quarantine');
    const releaseFile = join(releaseRoot, 'main', 'sha', 'rpi-5', 'release.img.gz');
    const cacheFile = join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old');
    await mkdir(quarantineRoot, { recursive: true });
    await mkdir(join(releaseRoot, 'main', 'sha', 'rpi-5'), { recursive: true });
    await writeFile(releaseFile, 'protected');
    let mutationAttempts = 0;

    await expect(createRetentionStartupHook({
      paths: { ...paths, approvedReleaseRoots: [releaseRoot], approvedQuarantineRoots: [quarantineRoot] },
      now: NOW,
      freeBytes: 19 * 1024 ** 3,
      beforeDelete: () => { mutationAttempts += 1; },
    })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_ROOT_INVALID' }] });
    expect(mutationAttempts).toBe(0);
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(cacheFile, 'utf8'))).resolves.toBe('old');
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(releaseFile, 'utf8'))).resolves.toBe('protected');
  });

  it('rejects a state root nested under a release root before mutation', async () => {
    const paths = await retentionWorkspace();
    const releaseRoot = join(paths.stateRoot, '..');
    const quarantineRoot = join(releaseRoot, '.osi-image-builder', 'quarantine');
    const releaseFile = join(releaseRoot, 'main', 'sha', 'rpi-5', 'release.img.gz');
    const cacheFile = join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old');
    await mkdir(quarantineRoot, { recursive: true });
    await mkdir(join(releaseRoot, 'main', 'sha', 'rpi-5'), { recursive: true });
    await writeFile(releaseFile, 'protected');
    let mutationAttempts = 0;

    await expect(createRetentionStartupHook({
      paths: { ...paths, approvedReleaseRoots: [releaseRoot], approvedQuarantineRoots: [quarantineRoot] },
      now: NOW,
      freeBytes: 19 * 1024 ** 3,
      beforeDelete: () => { mutationAttempts += 1; },
    })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_ROOT_INVALID' }] });
    expect(mutationAttempts).toBe(0);
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(cacheFile, 'utf8'))).resolves.toBe('old');
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(releaseFile, 'utf8'))).resolves.toBe('protected');
  });

  it('prunes the whole terminal job root after per-file candidates', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('replayable', 'request-replayable', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    const logPath = join(paths.stateRoot, 'jobs', 'replayable', 'logs');
    await mkdir(logPath, { recursive: true });
    await writeFile(join(logPath, 'runner-0.log'), 'keep');
    db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?)')
      .run('replayable', 'runner', 0, 'logs/runner-0.log', OLD, 4);
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at, stream, file_generation, byte_offset, byte_length, partial) VALUES (?, 0, 'log', 'succeeded', '{}', ?, 'runner', 0, 0, 4, 0)")
      .run('replayable', OLD);
    await createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })();
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', 'replayable')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not prune old unreferenced log generations for active jobs', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'building', 'dispatched', ?, ?, '{}', '{}')`)
      .run('active-log', 'request-active-log', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD);
    const generation = join(paths.stateRoot, 'jobs', 'active-log', 'logs', 'runner-0.log');
    await mkdir(join(paths.stateRoot, 'jobs', 'active-log', 'logs'), { recursive: true });
    await writeFile(generation, 'keep');
    await utimes(generation, new Date(OLD), new Date(OLD));
    db.prepare('INSERT INTO job_log_generations (job_id, stream, generation, path, started_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?)')
      .run('active-log', 'runner', 0, 'logs/runner-0.log', OLD, 4);

    await createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })();

    await expect(import('node:fs/promises').then(({ access }) => access(generation))).resolves.toBeUndefined();
    expect(db.prepare('SELECT generation FROM job_log_generations WHERE job_id=?').all('active-log')).toEqual([{ generation: 0 }]);
  });

  it('rejects a symlinked ancestor before retention can mutate', async () => {
    const paths = await retentionWorkspace();
    const alias = join(paths.stateRoot, '..', 'retention-alias');
    await symlink(paths.stateRoot, alias);
    const remap = (path: string): string => path.startsWith(paths.stateRoot) ? `${alias}${path.slice(paths.stateRoot.length)}` : path;
    await expect(createRetentionStartupHook({
      paths: {
        ...paths,
        stateRoot: alias,
        builderOwnedRoots: paths.builderOwnedRoots.map(remap),
        approvedReleaseRoots: paths.approvedReleaseRoots.map(remap),
        approvedQuarantineRoots: paths.approvedQuarantineRoots.map(remap),
        worktreeRoot: remap(paths.worktreeRoot!),
      },
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
    })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_ROOT_INVALID' }] });
  });

  it('detects a component swap after the target descriptor is held', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    let swapped = false;
    const target = join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old');
    await expect(createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeDelete: async ({ path }) => {
        if (!swapped && path === target) {
          swapped = true;
          await rename(path, `${path}.moved`);
          await writeFile(path, 'replacement');
        }
      },
    })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_PRUNE_FAILED' }] });
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(target, 'utf8'))).resolves.toBe('replacement');
  });

  it('reconciles a planned absent DB-backed candidate as removed', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('planned-absent', 'request-planned-absent', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs', 'planned-absent', 'evidence'), { recursive: true });
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('evidence', 'jobs/planned-absent/evidence/missing.json', 'planned', ?, ?, 12)`).run(NOW, NOW);

    await createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })();

    expect(db.prepare('SELECT status, bytes, error FROM retention_prune_intents WHERE category=? AND relative_path=?').get('evidence', 'jobs/planned-absent/evidence/missing.json'))
      .toEqual({ status: 'removed', bytes: 0, error: null });
    expect(db.prepare('SELECT action, bytes FROM retention_prunes WHERE category=? AND relative_path=? ORDER BY prune_id DESC LIMIT 1').get('evidence', 'jobs/planned-absent/evidence/missing.json'))
      .toEqual({ action: 'removed', bytes: 0 });
  });

  it('reconciles a planned absent worktree at the 7-day cutoff without purging the younger job row', async () => {
    const paths = await retentionWorkspace();
    const defaultWorktreePaths: RetentionPaths = { ...paths, worktreeRoot: undefined };
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const terminalAt = '2026-07-18T12:00:00.000Z';
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('young-worktree', 'request-young-worktree', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), terminalAt, terminalAt, terminalAt, terminalAt, terminalAt);
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('worktree', ?, 'planned', ?, ?, 12)`).run('jobs/young-worktree/workspace/source', NOW, NOW);

    await createRetentionStartupHook({ paths: defaultWorktreePaths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })();

    expect(db.prepare('SELECT status, bytes, error FROM retention_prune_intents WHERE category=? AND relative_path=?').get('worktree', 'jobs/young-worktree/workspace/source'))
      .toEqual({ status: 'removed', bytes: 0, error: null });
    expect(db.prepare('SELECT action, bytes FROM retention_prunes WHERE category=? AND relative_path=? ORDER BY prune_id DESC LIMIT 1').get('worktree', 'jobs/young-worktree/workspace/source'))
      .toEqual({ action: 'removed', bytes: 0 });
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('young-worktree')).toEqual({ job_id: 'young-worktree' });
  });

  it('plans before callback and finalizes a present candidate after deletion', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('planned-present', 'request-planned-present', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    const target = join(paths.stateRoot, 'jobs', 'planned-present', 'evidence', 'present.json');
    await mkdir(join(paths.stateRoot, 'jobs', 'planned-present', 'evidence'), { recursive: true });
    await writeFile(target, 'evidence');
    await utimes(target, new Date(OLD), new Date(OLD));
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('evidence', 'jobs/planned-present/evidence/present.json', 'planned', ?, ?, 8)`).run(NOW, NOW);
    const observed: string[] = [];

    await createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeDelete: async ({ path }) => { if (path === target) observed.push(String(db.prepare("SELECT status FROM retention_prune_intents WHERE category='evidence' AND relative_path='jobs/planned-present/evidence/present.json'").get()?.status)); },
    })();

    await expect(import('node:fs/promises').then(({ access }) => access(target))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(observed).toEqual(['planned']);
    expect(db.prepare('SELECT status FROM retention_prune_intents WHERE category=? AND relative_path=?').get('evidence', 'jobs/planned-present/evidence/present.json')).toEqual({ status: 'removed' });
  });

  it('records failure while beforeDelete can query and write without an open transaction', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('planned-failure', 'request-planned-failure', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    const target = join(paths.stateRoot, 'jobs', 'planned-failure', 'evidence', 'failure.json');
    await mkdir(join(paths.stateRoot, 'jobs', 'planned-failure', 'evidence'), { recursive: true });
    await writeFile(target, 'evidence');
    await utimes(target, new Date(OLD), new Date(OLD));
    let callbackStatus: unknown;

    await createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeDelete: async ({ path }) => {
        if (path !== target) return;
        callbackStatus = db.prepare("SELECT status FROM retention_prune_intents WHERE category='evidence' AND relative_path='jobs/planned-failure/evidence/failure.json'").get()?.status;
        db.prepare('UPDATE retention_prune_intents SET error=NULL WHERE category=? AND relative_path=?').run('evidence', 'jobs/planned-failure/evidence/failure.json');
        throw new Error('injected callback failure');
      },
    })();

    expect(callbackStatus).toBe('planned');
    expect(db.prepare('SELECT status, error FROM retention_prune_intents WHERE category=? AND relative_path=?').get('evidence', 'jobs/planned-failure/evidence/failure.json'))
      .toEqual({ status: 'failed', error: 'injected callback failure' });
  });

  it('keeps terminal job and child metadata when filesystem pruning fails', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('retryable', 'request-retryable', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs', 'retryable', 'evidence'), { recursive: true });
    await writeFile(join(paths.stateRoot, 'jobs', 'retryable', 'evidence', 'terminal.json'), 'evidence');
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)").run('retryable', OLD);
    await createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeDelete: async ({ category }) => { if (category === 'evidence') throw new Error('injected filesystem failure'); },
    })();
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('retryable')).toEqual({ job_id: 'retryable' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get('retryable')).toEqual({ count: 1 });
    expect(db.prepare('SELECT status FROM retention_prune_intents WHERE category=? AND relative_path=?').get('evidence', 'jobs/retryable/evidence/terminal.json')).toEqual({ status: 'failed' });
  });

  it('purges an old terminal job only after its row root is removed', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('purgeable', 'request-purgeable', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs', 'purgeable', 'nested'), { recursive: true });
    await writeFile(join(paths.stateRoot, 'jobs', 'purgeable', 'nested', 'state.json'), '{}');
    db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run('purgeable', 900, OLD);
    db.prepare('INSERT INTO job_stages (job_id, stage) VALUES (?, ?)').run('purgeable', 'build');
    db.prepare('INSERT INTO job_operations (job_id, operation_id, argv_hash, argv_json, started_at) VALUES (?, ?, ?, ?, ?)')
      .run('purgeable', 'build-image', 'c'.repeat(64), '[]', OLD);
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)").run('purgeable', OLD);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });

    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('purgeable')).toBeUndefined();
    for (const table of ['queue_entries', 'job_stages', 'job_operations', 'job_events']) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE job_id=?`).get('purgeable')).toEqual({ count: 0 });
    }
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', 'purgeable')))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM retention_prunes WHERE category='row' AND relative_path='jobs/purgeable' AND action='removed'").get()).toEqual({ count: 1 });
  });

  it('purges an old quarantined terminal job after the canonical quarantine and job roots are removed', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const jobId = 'quarantined-old';
    const quarantinePath = `.osi-image-builder/quarantine/${jobId}`;
    const quarantineRoot = join(paths.approvedQuarantineRoots[0]!, jobId);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, publish_state, artifact_quarantine_path, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, 'quarantined', ?, '{}', '{}')`)
      .run(jobId, 'request-quarantined-old', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD, quarantinePath);
    await mkdir(join(paths.stateRoot, 'jobs', jobId, 'child'), { recursive: true });
    await writeFile(join(paths.stateRoot, 'jobs', jobId, 'child', 'state.json'), '{}');
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(join(quarantineRoot, 'artifact.bin'), 'quarantined');
    await utimes(quarantineRoot, new Date(OLD), new Date(OLD));
    db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run(jobId, 903, OLD);
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)").run(jobId, OLD);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });

    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get(jobId)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM queue_entries WHERE job_id=?').get(jobId)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get(jobId)).toEqual({ count: 0 });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', jobId)))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(import('node:fs/promises').then(({ access }) => access(quarantineRoot))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a terminal job while its young canonical quarantine remains present', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const jobId = 'quarantined-young';
    const quarantinePath = `quarantine/${jobId}`;
    const quarantineRoot = join(paths.approvedQuarantineRoots[0]!, jobId);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, publish_state, artifact_quarantine_path, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, 'quarantined', ?, '{}', '{}')`)
      .run(jobId, 'request-quarantined-young', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD, quarantinePath);
    await mkdir(join(paths.stateRoot, 'jobs', jobId), { recursive: true });
    await mkdir(quarantineRoot, { recursive: true });
    await writeFile(join(quarantineRoot, 'artifact.bin'), 'quarantined');

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [{ code: 'RETENTION_ROW_PRUNE_FAILED', details: expect.objectContaining({ reason: 'terminal quarantine root is still present' }) }] });

    expect(db.prepare('SELECT job_id, artifact_quarantine_path FROM jobs WHERE job_id=?').get(jobId)).toEqual({ job_id: jobId, artifact_quarantine_path: quarantinePath });
    await expect(import('node:fs/promises').then(({ access }) => access(quarantineRoot))).resolves.toBeUndefined();
  });

  it('blocks row purge and keeps the job root for a malformed persisted quarantine path', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    const jobId = 'quarantined-malformed';
    const quarantinePath = `quarantine/${jobId}/extra`;
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, publish_state, artifact_quarantine_path, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, 'quarantined', ?, '{}', '{}')`)
      .run(jobId, 'request-quarantined-malformed', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD, quarantinePath);
    await mkdir(join(paths.stateRoot, 'jobs', jobId, 'child'), { recursive: true });
    await writeFile(join(paths.stateRoot, 'jobs', jobId, 'child', 'state.json'), '{}');
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)").run(jobId, OLD);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_ROW_PRUNE_FAILED' }] });

    expect(db.prepare('SELECT job_id, artifact_quarantine_path FROM jobs WHERE job_id=?').get(jobId)).toEqual({ job_id: jobId, artifact_quarantine_path: quarantinePath });
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get(jobId)).toEqual({ count: 1 });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', jobId, 'child', 'state.json')))).resolves.toBeUndefined();
  });

  it('retries a removed row intent when the job root is present', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('forged', 'request-forged', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs', 'forged'), { recursive: true });
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('row', 'jobs/forged', 'removed', ?, ?, 0)`).run(NOW, NOW);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('forged')).toBeUndefined();
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', 'forged')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries a reappeared row root across startups before purging the job and children', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('cross-startup', 'request-cross-startup', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs'), { recursive: true });
    db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run('cross-startup', 902, OLD);
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)").run('cross-startup', OLD);

    const run1 = await createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeRowPurge: async ({ path }) => {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'recreated.txt'), 'retain');
      },
    })();
    expect(run1).toMatchObject({ blockers: [{ code: 'RETENTION_ROW_PRUNE_FAILED' }] });
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('cross-startup')).toEqual({ job_id: 'cross-startup' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM queue_entries WHERE job_id=?').get('cross-startup')).toEqual({ count: 1 });
    expect(db.prepare('SELECT status FROM retention_prune_intents WHERE category=? AND relative_path=?').get('row', 'jobs/cross-startup')).toEqual({ status: 'removed' });

    const run2 = await createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })();
    expect(run2).toEqual({ blockers: [] });
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('cross-startup')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM queue_entries WHERE job_id=?').get('cross-startup')).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get('cross-startup')).toEqual({ count: 0 });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', 'cross-startup')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finalizes a missing terminal job root before purging its rows', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('missing-root', 'request-missing-root', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toEqual({ blockers: [] });
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('missing-root')).toBeUndefined();
    expect(db.prepare("SELECT status FROM retention_prune_intents WHERE category='row' AND relative_path='jobs/missing-root'").get()).toEqual({ status: 'removed' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM retention_prunes WHERE category='row' AND relative_path='jobs/missing-root'").get()).toEqual({ count: 1 });
  });

  it('retains job metadata when row eligibility changes before atomic purge', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('blocked-before-purge', 'request-blocked-before-purge', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    db.prepare("INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, 'terminal', 'succeeded', '{}', ?)")
      .run('blocked-before-purge', OLD);

    const result = await createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeRowPurge: async ({ jobId }) => {
        db.prepare("UPDATE jobs SET cleanup_blocker_code='CLEANUP_ADMISSION_BLOCKED', cleanup_blocker_json='{}' WHERE job_id=?").run(jobId);
      },
    })();

    expect(result).toMatchObject({ blockers: [{ code: 'RETENTION_ROW_PRUNE_FAILED' }] });
    expect(db.prepare('SELECT job_id, cleanup_blocker_code, cleanup_blocker_json FROM jobs WHERE job_id=?').get('blocked-before-purge'))
      .toEqual({ job_id: 'blocked-before-purge', cleanup_blocker_code: 'CLEANUP_ADMISSION_BLOCKED', cleanup_blocker_json: '{}' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get('blocked-before-purge')).toEqual({ count: 1 });
    expect(db.prepare("SELECT status FROM retention_prune_intents WHERE category='row' AND relative_path='jobs/blocked-before-purge'").get())
      .toEqual({ status: 'removed' });
  });

  it('aborts row purge when the job root reappears before the transaction', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('race-root', 'request-race-root', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs'), { recursive: true });
    db.prepare('INSERT INTO queue_entries (job_id, fifo_seq, enqueued_at) VALUES (?, ?, ?)').run('race-root', 901, OLD);
    db.prepare('INSERT INTO job_events (job_id, seq, event_type, state, payload_json, at) VALUES (?, 0, \'terminal\', \'succeeded\', \'{}\', ?)').run('race-root', OLD);

    const result = await createRetentionStartupHook({
      paths,
      db,
      now: NOW,
      freeBytes: 25 * 1024 ** 3,
      beforeRowPurge: async ({ path }) => {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'recreated.txt'), 'retain');
      },
    })();

    expect(result).toMatchObject({ blockers: [{ code: 'RETENTION_ROW_PRUNE_FAILED' }] });
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('race-root')).toEqual({ job_id: 'race-root' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM queue_entries WHERE job_id=?').get('race-root')).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get('race-root')).toEqual({ count: 1 });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', 'race-root', 'recreated.txt')))).resolves.toBeUndefined();
  });
});
