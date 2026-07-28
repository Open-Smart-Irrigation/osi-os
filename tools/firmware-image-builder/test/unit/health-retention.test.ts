import { mkdtemp, mkdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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

  it('evicts eligible caches below the 20 GiB floor', async () => {
    const paths = await retentionWorkspace();
    const records: RetentionPruneRecord[] = [];
    await createRetentionStartupHook({ paths, now: NOW, freeBytes: 19 * 1024 ** 3, recordPrune: async (record) => { records.push(record); } })();
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old')))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(records.some((record) => record.category === 'cache')).toBe(true);
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
    let swapped = false;
    const target = join(paths.builderOwnedRoots[0]!, 'cache', 'docker', 'old');
    await expect(createRetentionStartupHook({
      paths,
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

  it('does not trust a forged removed row intent while the job root is present', async () => {
    const paths = await retentionWorkspace();
    const db = openBuilderDatabase(join(paths.stateRoot, 'jobs.sqlite'));
    databases.push(db);
    db.prepare(`INSERT INTO jobs (job_id, request_id, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at, terminal_at, source_preparation_json, offline_feed_preparation_json) VALUES (?, ?, 'ssh://repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, 'rpi-5', 'root', ?, ?, 'author', 'subject', ?, 'succeeded', 'complete', ?, ?, ?, '{}', '{}')`)
      .run('forged', 'request-forged', 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), OLD, OLD, OLD, OLD, OLD);
    await mkdir(join(paths.stateRoot, 'jobs', 'forged'), { recursive: true });
    db.prepare(`INSERT INTO retention_prune_intents (category, relative_path, status, planned_at, updated_at, bytes)
      VALUES ('row', 'jobs/forged', 'removed', ?, ?, 0)`).run(NOW, NOW);

    await expect(createRetentionStartupHook({ paths, db, now: NOW, freeBytes: 25 * 1024 ** 3 })()).resolves.toMatchObject({ blockers: [{ code: 'RETENTION_ROW_PRUNE_FAILED' }] });
    expect(db.prepare('SELECT job_id FROM jobs WHERE job_id=?').get('forged')).toEqual({ job_id: 'forged' });
    await expect(import('node:fs/promises').then(({ access }) => access(join(paths.stateRoot, 'jobs', 'forged')))).resolves.toBeUndefined();
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
