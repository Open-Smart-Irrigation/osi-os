import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { DurableLogStream, type LogStreamEvent } from '../../api/src/log-stream.js';

const NOW = '2026-07-28T10:00:00.000Z';
const roots: string[] = [];
const dbs: Array<ReturnType<typeof openBuilderDatabase>> = [];

function seedJob(db: ReturnType<typeof openBuilderDatabase>, jobId = 'job-log'): void {
  db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json,
    target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at)
    VALUES (?, ?, '{}', 'ssh://example/repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, '{}', '{}', 'rpi-5', 'release', ?, ?, 'test', 'log', ?, 'building', 'released', NULL, ?, ?)`)
    .run(jobId, `${jobId}-request`, 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), NOW, NOW, NOW, NOW);
}

async function fixture(): Promise<{ root: string; db: ReturnType<typeof openBuilderDatabase>; stream: DurableLogStream }> {
  const root = await mkdtemp(join(tmpdir(), 'osi-log-stream-'));
  roots.push(root);
  const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
  dbs.push(db);
  seedJob(db);
  return { root, db, stream: new DurableLogStream({ db, root, jobId: 'job-log', now: () => NOW }) };
}

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableLogStream', () => {
  it('appends exact bytes before recording a durable range and partial UTF-8 metadata', async () => {
    const { stream, db, root } = await fixture();
    const bytes = Buffer.from('Gr\u00fczi\nlast line', 'utf8');
    const event = stream.appendSync('runner', bytes);
    expect(event).toMatchObject({ stream: 'runner', generation: 0, offset: 0, length: bytes.length, partial: true });
    expect(await readFile(join(root, 'logs/runner.0'))).toEqual(bytes);
    expect(db.prepare('SELECT size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=0').get('job-log', 'runner')).toEqual({ size_bytes: bytes.length });
    expect(db.prepare('SELECT stream, file_generation, byte_offset, byte_length, partial FROM job_events WHERE job_id=? AND seq=?').get('job-log', event.seq)).toEqual({ stream: 'runner', file_generation: 0, byte_offset: 0, byte_length: bytes.length, partial: 1 });
  });

  it('seals and rotates contiguous generations, then replays exact bytes after a cursor', async () => {
    const { stream, db, root } = await fixture();
    stream.appendSync('docker', Buffer.from('one\n'));
    stream.sealSync('docker');
    const rotated = stream.rotateSync('docker');
    expect(rotated.generation).toBe(1);
    stream.appendSync('docker', Buffer.from('two\n'));
    const replay = stream.replaySync(-1);
    expect(replay.filter((event) => event.event === 'log').map((event) => event.data.text)).toEqual(['one\n', 'two\n']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_log_generations WHERE job_id=? AND stream=?').get('job-log', 'docker')).toEqual({ count: 2 });
    expect(await readFile(join(root, 'logs/docker.1'))).toEqual(Buffer.from('two\n'));
  });

  it('persists a recovery log gap and does not advance over a short source range', async () => {
    const { stream, db, root } = await fixture();
    const appended = stream.appendSync('runner', Buffer.from('unreadable\n'));
    const path = join(root, 'logs/runner.0');
    await rm(path);
    const replay = stream.replaySync(-1);
    expect(replay.filter((event) => event.event === 'log-gap')).toHaveLength(1);
    expect(db.prepare("SELECT event_type, json_extract(payload_json, '$.code') AS code FROM job_events WHERE job_id=? ORDER BY seq DESC LIMIT 1").get('job-log')).toEqual({ event_type: 'log-gap', code: 'RECOVERY_LOG_GAP' });
    expect(stream.replaySync(-1).filter((event) => event.event === 'log-gap')).toHaveLength(1);
    expect(stream.replaySync(appended.seq).filter((event) => event.event === 'log-gap')).toHaveLength(1);
    expect(replay.find((event) => event.event === 'log-gap')?.seq).toBeGreaterThan(appended.seq);
  });

  it('rejects symlinked or mismatched generation paths and never creates directories while replaying', async () => {
    const { stream, db, root } = await fixture();
    stream.appendSync('runner', Buffer.from('safe\n'));
    await rm(join(root, 'logs/runner.0'));
    await symlink('/etc/hosts', join(root, 'logs/runner.0'));
    expect(() => stream.replaySync(-1)).toThrow();
    expect(() => stream.appendSync('runner', Buffer.from('blocked\n'))).toThrow();
    await rm(join(root, 'logs/runner.0'));
    await writeFile(join(root, 'logs/runner.0'), Buffer.from('safe\n'));
    db.exec('DROP TRIGGER job_log_generations_immutable_guard');
    db.prepare('UPDATE job_log_generations SET path=? WHERE job_id=? AND stream=? AND generation=?').run('logs/other.0', 'job-log', 'runner', 0);
    expect(stream.replaySync(-1).map(({ seq, event }) => [seq, event])).toEqual([[1, 'log-gap']]);
    expect(db.prepare("SELECT json_extract(payload_json, '$.code') AS code, json_extract(payload_json, '$.reason') AS reason FROM job_events WHERE job_id=? AND event_type='log-gap'").get('job-log')).toEqual({ code: 'RECOVERY_LOG_GAP', reason: 'GENERATION_PATH_MISMATCH' });
    expect(stream.replaySync(-1).filter((event) => event.event === 'log-gap')).toHaveLength(1);
  });

  it('rejects symlinks in the root authority chain and at the logs directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'osi-log-authority-'));
    roots.push(parent);
    const realParent = join(parent, 'real');
    const realRoot = join(realParent, 'job');
    const aliasParent = join(parent, 'alias');
    await mkdir(realRoot, { recursive: true });
    await symlink(realParent, aliasParent);
    const db = openBuilderDatabase(join(realRoot, 'jobs.sqlite'));
    dbs.push(db);
    seedJob(db);
    expect(() => new DurableLogStream({ db, root: join(aliasParent, 'job'), jobId: 'job-log', now: () => NOW })).toThrow();

    const externalLogs = join(parent, 'external-logs');
    await mkdir(externalLogs);
    await symlink(externalLogs, join(realRoot, 'logs'));
    expect(() => new DurableLogStream({ db, root: realRoot, jobId: 'job-log', now: () => NOW })).toThrow();
  });

  it('seals an exact orphan tail only after liveness proof and is idempotent', async () => {
    const { stream, db, root } = await fixture();
    stream.appendSync('docker', Buffer.from('indexed\n'));
    await writeFile(join(root, 'logs/docker.0'), Buffer.from('indexed\norphan\n'));
    expect(() => stream.sealOrphanTailSync('docker', { unitInactive: false, leaseStale: true, noMatchingContainer: true })).toThrow(/proof/i);
    const sealed = stream.sealOrphanTailSync('docker', { unitInactive: true, leaseStale: true, noMatchingContainer: true });
    expect(sealed.eventType).toBe('log_orphan_tail');
    expect(sealed.length).toBe(Buffer.byteLength('orphan\n'));
    expect(stream.sealOrphanTailSync('docker', { unitInactive: true, leaseStale: true, noMatchingContainer: true })).toEqual(sealed);
    expect((db.prepare('SELECT sealed_at FROM job_log_generations WHERE job_id=? AND stream=? AND generation=0').get('job-log', 'docker') as { sealed_at: string | null }).sealed_at).not.toBeNull();
  });

  it('records one durable gap for a short orphan file and maps metadata events to public stage only', async () => {
    const { stream, db, root } = await fixture();
    stream.appendSync('docker', Buffer.from('indexed\n'));
    await writeFile(join(root, 'logs/docker.0'), Buffer.from('short'));
    const gap = stream.sealOrphanTailSync('docker', { unitInactive: true, leaseStale: true, noMatchingContainer: true });
    expect(gap).toMatchObject({ eventType: 'log-gap', offset: Buffer.byteLength('short'), length: Buffer.byteLength('indexed\n') - Buffer.byteLength('short') });
    expect(db.prepare("SELECT json_extract(payload_json, '$.offset') AS offset, json_extract(payload_json, '$.length') AS length FROM job_events WHERE job_id=? AND event_type='log-gap'").get('job-log')).toEqual({ offset: 5, length: 3 });
    expect(stream.sealOrphanTailSync('docker', { unitInactive: true, leaseStale: true, noMatchingContainer: true })).toEqual(gap);
    stream.appendMetadataSync('state', { kind: 'state', state: 'building' });
    expect(stream.replaySync(-1).filter((event) => event.event === 'stage' || event.event === 'terminal').every((event) => event.event === 'stage')).toBe(true);
  });

  it('waits exactly 15 seconds between deterministic keepalive frames', async () => {
    vi.useFakeTimers();
    try {
      const { stream } = await fixture();
      const iterator = stream.keepaliveIterator();
      const first = iterator.next();
      await vi.advanceTimersByTimeAsync(14_999);
      let done = false;
      void first.then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await first).value).toBe(': keepalive\n\n');
      await iterator.return?.(undefined);
    } finally { vi.useRealTimers(); }
  });

  it('closes held authority descriptors idempotently', async () => {
    const { stream } = await fixture();
    stream.appendSync('runner', Buffer.from('open\n'));
    stream.close();
    expect(() => stream.close()).not.toThrow();
    expect(() => stream.appendSync('runner', Buffer.from('closed\n'))).toThrow();
  });

  it('encodes bounded SSE events and emits log-truncated metadata for an oversized payload', async () => {
    const { stream } = await fixture();
    const event: LogStreamEvent = { seq: 9, event: 'log', data: { jobId: 'job-log', stream: 'runner', text: 'x'.repeat(70_000), partial: false } };
    const encoded = stream.encodeSse(event);
    expect(encoded.length).toBeLessThanOrEqual(64 * 1024);
    expect(encoded).toContain('event: log-truncated');
  });
});
