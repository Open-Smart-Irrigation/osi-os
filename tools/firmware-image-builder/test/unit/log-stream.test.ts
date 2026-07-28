import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { fstatSync, fsyncSync as systemFsyncSync, readSync as systemReadSync, renameSync, writeFileSync, writeSync as systemWriteSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { assertOrphanLogLivenessProof, DurableLogStream, type LogStreamEvent, type LogStreamIo } from '../../api/src/log-stream.js';

const NOW = '2026-07-28T10:00:00.000Z';
const roots: string[] = [];
const dbs: Array<ReturnType<typeof openBuilderDatabase>> = [];

function seedJob(db: ReturnType<typeof openBuilderDatabase>, jobId = 'job-log'): void {
  db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json,
    target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at)
    VALUES (?, ?, '{}', 'ssh://example/repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, '{}', '{}', 'rpi-5', 'release', ?, ?, 'test', 'log', ?, 'building', 'released', NULL, ?, ?)`)
    .run(jobId, `${jobId}-request`, 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), NOW, NOW, NOW, NOW);
}

async function fixture(options: { readonly io?: Partial<LogStreamIo> } = {}): Promise<{ root: string; db: ReturnType<typeof openBuilderDatabase>; stream: DurableLogStream }> {
  const root = await mkdtemp(join(tmpdir(), 'osi-log-stream-'));
  roots.push(root);
  const db = openBuilderDatabase(join(root, 'jobs.sqlite'));
  dbs.push(db);
  seedJob(db);
  return { root, db, stream: new DurableLogStream({ db, root, jobId: 'job-log', now: () => NOW, ...options }) };
}

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableLogStream', () => {
  it('validates every orphan-log liveness fact before sealing', () => {
    expect(() => assertOrphanLogLivenessProof({ unitInactive: true, leaseStale: true, noMatchingContainer: true })).not.toThrow();
    for (const proof of [
      { unitInactive: false, leaseStale: true, noMatchingContainer: true },
      { unitInactive: true, leaseStale: false, noMatchingContainer: true },
      { unitInactive: true, leaseStale: true, noMatchingContainer: false },
    ]) {
      expect(() => assertOrphanLogLivenessProof(proof)).toThrow(/proof/i);
    }
  });

  it('appends exact bytes before recording a durable range and partial UTF-8 metadata', async () => {
    const { stream, db, root } = await fixture();
    const bytes = Buffer.from('Gr\u00fczi\nlast line', 'utf8');
    const event = stream.appendSync('runner', bytes);
    expect(event).toMatchObject({ stream: 'runner', generation: 0, offset: 0, length: bytes.length, partial: true });
    expect(await readFile(join(root, 'logs/runner.0'))).toEqual(bytes);
    expect(db.prepare('SELECT size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=0').get('job-log', 'runner')).toEqual({ size_bytes: bytes.length });
    expect(db.prepare('SELECT stream, file_generation, byte_offset, byte_length, partial FROM job_events WHERE job_id=? AND seq=?').get('job-log', event.seq)).toEqual({ stream: 'runner', file_generation: 0, byte_offset: 0, byte_length: bytes.length, partial: 1 });
  });

  it('completes partial synchronous I/O and fails immediately on zero progress', async () => {
    let reads = 0;
    let writes = 0;
    const partial = await fixture({
      io: {
        readSync: (fd, buffer, offset, length, position) => {
          reads += 1;
          return systemReadSync(fd, buffer, offset, Math.min(2, length), position);
        },
        writeSync: (fd, buffer, offset, length) => {
          writes += 1;
          return systemWriteSync(fd, buffer, offset, Math.min(2, length));
        },
      },
    });
    const bytes = Buffer.from('chunked\n');
    partial.stream.appendSync('runner', bytes);
    const replayed = partial.stream.replaySync(-1).find((event) => event.event === 'log');
    expect(Buffer.from(String(replayed?.data.bytesBase64), 'base64')).toEqual(bytes);
    expect(reads).toBeGreaterThan(1);
    expect(writes).toBeGreaterThan(1);

    const zeroWrite = await fixture({ io: { writeSync: () => 0 } });
    expect(() => zeroWrite.stream.appendSync('runner', Buffer.from('blocked\n'))).toThrow(/zero progress/i);

    const zeroRead = await fixture();
    zeroRead.stream.appendSync('runner', Buffer.from('indexed\n'));
    zeroRead.stream.close();
    const zeroReadStream = new DurableLogStream({
      db: zeroRead.db,
      root: zeroRead.root,
      jobId: 'job-log',
      now: () => NOW,
      io: { readSync: () => 0 },
    });
    expect(() => zeroReadStream.sealSync('runner')).toThrow(/zero progress/i);
  });

  it('hashes a generation incrementally while sealing', async () => {
    const readLengths: number[] = [];
    const value = await fixture({
      io: {
        readSync: (fd, buffer, offset, length, position) => {
          readLengths.push(length);
          return systemReadSync(fd, buffer, offset, length, position);
        },
      },
    });
    value.stream.appendSync('runner', Buffer.alloc(128 * 1024, 0x61));

    value.stream.sealSync('runner');

    expect(Math.max(...readLengths)).toBeLessThanOrEqual(64 * 1024);
    expect(readLengths.length).toBeGreaterThan(1);
  });

  it('fsyncs newly created directory entries before committing the first range', async () => {
    const calls: string[] = [];
    let eventsAtLogsFsync = -1;
    let db: ReturnType<typeof openBuilderDatabase>;
    const value = await fixture({
      io: {
        fsyncSync: (fd) => {
          const kind = fstatSync(fd).isDirectory() ? 'directory' : 'file';
          calls.push(kind);
          if (calls.length === 3) {
            eventsAtLogsFsync = Number((db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get('job-log') as { count: number }).count);
          }
          systemFsyncSync(fd);
        },
      },
    });
    db = value.db;

    value.stream.appendSync('runner', Buffer.from('first\n'));
    expect(calls).toEqual(['directory', 'file', 'directory']);
    expect(eventsAtLogsFsync).toBe(0);

    value.stream.appendSync('runner', Buffer.from('second\n'));
    expect(calls).toEqual(['directory', 'file', 'directory', 'file']);
  });

  it('reserves before fsync, fails closed on an ambiguous retry, and recovers the exact orphan once', async () => {
    let injected = false;
    const failed = await fixture({
      io: {
        fsyncSync: (fd) => {
          systemFsyncSync(fd);
          if (!injected && fstatSync(fd).isFile()) {
            injected = true;
            throw new Error('injected post-fsync failure');
          }
        },
      },
    });
    const bytes = Buffer.from('durable before metadata\n');

    expect(() => failed.stream.appendSync('runner', bytes)).toThrow('injected post-fsync failure');
    expect(failed.db.prepare('SELECT generation, sealed_at, size_bytes FROM job_log_generations WHERE job_id=? AND stream=?').get('job-log', 'runner')).toEqual({ generation: 0, sealed_at: null, size_bytes: 0 });
    expect(await readFile(join(failed.root, 'logs/runner.0'))).toEqual(bytes);
    expect(() => failed.stream.appendSync('runner', bytes)).toThrow(/ambiguous/i);

    const recovery = new DurableLogStream({ db: failed.db, root: failed.root, jobId: 'job-log', now: () => NOW });
    const orphan = recovery.sealOrphanTailSync('runner', { unitInactive: true, leaseStale: true, noMatchingContainer: true });
    expect(orphan).toMatchObject({ eventType: 'log_orphan_tail', generation: 0, offset: 0, length: bytes.length });

    const later = recovery.appendSync('runner', Buffer.from('replayed once\n'));
    expect(later.generation).toBe(1);
    const replayed = recovery.replaySync(-1).filter((event) => event.event === 'log');
    expect(replayed.map((event) => event.data.text)).toEqual(['durable before metadata\n', 'replayed once\n']);
    expect(recovery.replaySync(-1).filter((event) => event.event === 'log')).toHaveLength(2);
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

  it('reopens a logs directory created by another stream instance before replay and seal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-log-stream-cross-instance-'));
    roots.push(root);
    const firstDb = openBuilderDatabase(join(root, 'jobs.sqlite'));
    const secondDb = openBuilderDatabase(join(root, 'jobs.sqlite'));
    dbs.push(firstDb, secondDb);
    seedJob(firstDb);
    const first = new DurableLogStream({ db: firstDb, root, jobId: 'job-log', now: () => NOW });
    const seal = new DurableLogStream({ db: firstDb, root, jobId: 'job-log', now: () => NOW });
    const second = new DurableLogStream({ db: secondDb, root, jobId: 'job-log', now: () => NOW });

    const appended = second.appendSync('runner', Buffer.from('cross-instance\n'));
    expect(first.replaySync(-1)).toEqual([expect.objectContaining({ seq: appended.seq, event: 'log' })]);
    seal.sealSync('runner');

    expect(first.replaySync(-1).some((event) => event.event === 'log-gap')).toBe(false);
    expect(firstDb.prepare('SELECT sealed_at, sha256 FROM job_log_generations WHERE job_id=? AND stream=? AND generation=0').get('job-log', 'runner')).toEqual({ sealed_at: NOW, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(firstDb.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type='log-gap'").get('job-log')).toEqual({ count: 0 });
  });

  it('does not seal a generation when its pathname is replaced during hashing', async () => {
    const replacePathDuringHash = (root: string, contents: Uint8Array, readLength: number): LogStreamIo['readSync'] => {
      let replaced = false;
      return (fd, buffer, offset, length, position) => {
        if (!replaced && length === readLength) {
          replaced = true;
          const path = join(root, 'logs/runner.0');
          const replacement = join(root, 'logs/replacement');
          writeFileSync(replacement, contents);
          renameSync(replacement, path);
        }
        return systemReadSync(fd, buffer, offset, length, position);
      };
    };

    const normal = await fixture();
    normal.stream.appendSync('runner', Buffer.from('normal\n'));
    const normalPath = join(normal.root, 'logs/runner.0');
    const normalIo = replacePathDuringHash(normal.root, Buffer.from('changed\n'), Buffer.byteLength('normal\n'));
    const normalRacingStream = new DurableLogStream({ db: normal.db, root: normal.root, jobId: 'job-log', now: () => NOW, io: { readSync: normalIo } });
    expect(() => normalRacingStream.sealSync('runner')).toThrow(/changed|identity|diverged/i);
    expect(normal.db.prepare('SELECT sealed_at, sha256 FROM job_log_generations WHERE job_id=? AND stream=? AND generation=0').get('job-log', 'runner')).toEqual({ sealed_at: null, sha256: null });
    expect(await readFile(normalPath)).toEqual(Buffer.from('changed\n'));

    const orphan = await fixture();
    orphan.stream.appendSync('runner', Buffer.from('indexed\n'));
    const orphanPath = join(orphan.root, 'logs/runner.0');
    await writeFile(orphanPath, Buffer.from('indexed\norphan\n'));
    const orphanIo = replacePathDuringHash(orphan.root, Buffer.from('indexed\nchanged\n'), Buffer.byteLength('indexed\norphan\n'));
    const orphanRacingStream = new DurableLogStream({ db: orphan.db, root: orphan.root, jobId: 'job-log', now: () => NOW, io: { readSync: orphanIo } });
    expect(() => orphanRacingStream.sealOrphanTailSync('runner', { unitInactive: true, leaseStale: true, noMatchingContainer: true })).toThrow(/changed|identity|diverged/i);
    expect(orphan.db.prepare('SELECT sealed_at, sha256, size_bytes FROM job_log_generations WHERE job_id=? AND stream=? AND generation=0').get('job-log', 'runner')).toEqual({ sealed_at: null, sha256: null, size_bytes: Buffer.byteLength('indexed\n') });
    expect(orphan.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type='log_orphan_tail'").get('job-log')).toEqual({ count: 0 });
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

  it('rechecks a replay-created gap inside the write transaction across stream instances', async () => {
    const first = await fixture();
    const secondDb = openBuilderDatabase(join(first.root, 'jobs.sqlite'));
    dbs.push(secondDb);
    const second = new DurableLogStream({ db: secondDb, root: first.root, jobId: 'job-log', now: () => NOW });
    first.stream.appendSync('runner', Buffer.from('interleaved\n'));
    await rm(join(first.root, 'logs/runner.0'));

    const originalExec = DatabaseSync.prototype.exec;
    let interleaved = false;
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!interleaved && this === first.db && sql === 'BEGIN IMMEDIATE') {
        interleaved = true;
        expect(second.replaySync(-1).filter((event) => event.event === 'log-gap')).toHaveLength(1);
      }
      return originalExec.call(this, sql);
    });
    try {
      expect(first.stream.replaySync(-1).filter((event) => event.event === 'log-gap')).toHaveLength(1);
    } finally {
      execSpy.mockRestore();
    }
    expect(interleaved).toBe(true);
    expect(first.db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type='log-gap'").get('job-log')).toEqual({ count: 1 });
  });

  it('rejects invalid replay cursors, limits, and persisted ranges before allocation', async () => {
    const { stream, db } = await fixture();
    const appended = stream.appendSync('runner', Buffer.from('bounded\n'));

    expect(() => stream.replaySync(-2)).toThrow(/cursor/i);
    expect(() => stream.replaySync(0.5)).toThrow(/cursor/i);
    expect(() => stream.replaySync(-1, { eventLimit: 0 })).toThrow(/event limit/i);
    expect(() => stream.replaySync(-1, { eventLimit: Number.MAX_SAFE_INTEGER })).toThrow(/event limit/i);
    expect(() => stream.replaySync(-1, { maxDecodedBytes: 0 })).toThrow(/decoded byte limit/i);
    expect(() => stream.replaySync(-1, { maxDecodedBytes: Number.MAX_SAFE_INTEGER })).toThrow(/decoded byte limit/i);
    expect(() => stream.replaySync(-1, { maxMetadataBytes: 0 })).toThrow(/metadata byte limit/i);
    expect(() => stream.replaySync(-1, { maxMetadataBytes: Number.MAX_SAFE_INTEGER })).toThrow(/metadata byte limit/i);

    db.exec('DROP TRIGGER job_events_immutable_update_guard');
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('UPDATE job_events SET byte_offset=1, byte_length=? WHERE job_id=? AND seq=?').run(Number.MAX_SAFE_INTEGER, 'job-log', appended.seq);
    expect(() => stream.replaySync(-1)).toThrow(/persisted log range/i);
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

  it('hashes an orphan generation incrementally and reads only its final byte for partial state', async () => {
    const readLengths: number[] = [];
    const value = await fixture({
      io: {
        readSync: (fd, buffer, offset, length, position) => {
          readLengths.push(length);
          return systemReadSync(fd, buffer, offset, length, position);
        },
      },
    });
    value.stream.appendSync('docker', Buffer.from('indexed\n'));
    await writeFile(join(value.root, 'logs/docker.0'), Buffer.concat([Buffer.from('indexed\n'), Buffer.alloc(128 * 1024, 0x62)]));

    const sealed = value.stream.sealOrphanTailSync('docker', { unitInactive: true, leaseStale: true, noMatchingContainer: true });

    expect(sealed).toMatchObject({ eventType: 'log_orphan_tail', length: 128 * 1024 });
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(64 * 1024);
    expect(readLengths).toContain(1);
  });

  it('reports a single source range larger than the replay budget explicitly', async () => {
    const { stream } = await fixture();
    stream.appendSync('runner', Buffer.from('large'));

    const replay = stream.replaySync(-1, { maxDecodedBytes: 2 });

    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ seq: 0, event: 'log-truncated', data: { truncated: true, reason: 'REPLAY_EVENT_TOO_LARGE', length: 5 } });
  });

  it('rejects metadata that cannot fit in a 64 KiB SSE frame before persistence', async () => {
    const { stream, db } = await fixture();

    expect(() => stream.appendMetadataSync('stage', { message: 'x'.repeat(70_000) })).toThrow(/SSE metadata/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id=?').get('job-log')).toEqual({ count: 0 });
  });

  it('turns an oversized persisted metadata row into one cursor-advancing compact event', async () => {
    const { stream, db } = await fixture();
    db.prepare('INSERT INTO job_events (job_id, seq, event_type, payload_json, at) VALUES (?, ?, ?, ?, ?)')
      .run('job-log', 0, 'stage', JSON.stringify({ message: 'x'.repeat(70_000) }), NOW);

    const replay = stream.replaySync(-1);
    expect(replay).toEqual([{ seq: 0, event: 'log-truncated', data: { jobId: 'job-log', truncated: true, reason: 'REPLAY_METADATA_TOO_LARGE' } }]);
    expect(stream.replaySync(0)).toEqual([]);
  });

  it('returns the same persisted seal result when there is no orphan tail', async () => {
    const { stream, db } = await fixture();
    stream.appendSync('runner', Buffer.from('complete\n'));
    const proof = { unitInactive: true, leaseStale: true, noMatchingContainer: true };

    const first = stream.sealOrphanTailSync('runner', proof);
    const persisted = db.prepare('SELECT sealed_at, sha256 FROM job_log_generations WHERE job_id=? AND stream=? AND generation=0').get('job-log', 'runner');
    const second = stream.sealOrphanTailSync('runner', proof);

    expect(first).toEqual({ eventType: 'sealed', seq: -1, stream: 'runner', generation: 0, offset: Buffer.byteLength('complete\n'), length: 0 });
    expect(second).toEqual(first);
    expect(persisted).toEqual({ sealed_at: NOW, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=? AND event_type='log_orphan_tail'").get('job-log')).toEqual({ count: 0 });
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

  it('rejects every public operation after close without changing durable state', async () => {
    const { stream, db } = await fixture();
    stream.appendSync('runner', Buffer.from('open\n'));
    const beforeEvents = db.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY seq').all('job-log');
    const beforeGenerations = db.prepare('SELECT * FROM job_log_generations WHERE job_id=? ORDER BY stream, generation').all('job-log');
    stream.close();
    expect(() => stream.close()).not.toThrow();
    const operations = [
      () => stream.replaySync(-1),
      () => stream.appendSync('runner', Buffer.from('closed\n')),
      () => stream.sealSync('runner'),
      () => stream.rotateSync('runner'),
      () => stream.appendMetadataSync('state', { state: 'closed' }),
      () => stream.sealOrphanTailSync('runner', { unitInactive: true, leaseStale: true, noMatchingContainer: true }),
      () => stream.encodeSse({ seq: 0, event: 'stage', data: {} }),
      () => stream.keepalive(),
      () => stream.keepaliveIterator(),
    ];
    for (const operation of operations) expect(operation).toThrow(/closed/i);
    expect(db.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY seq').all('job-log')).toEqual(beforeEvents);
    expect(db.prepare('SELECT * FROM job_log_generations WHERE job_id=? ORDER BY stream, generation').all('job-log')).toEqual(beforeGenerations);
  });

  it('removes each keepalive abort listener after its timer resolves', async () => {
    vi.useFakeTimers();
    try {
      const { stream } = await fixture();
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, 'addEventListener');
      const removed = vi.spyOn(controller.signal, 'removeEventListener');
      const iterator = stream.keepaliveIterator(controller.signal);
      for (let interval = 0; interval < 3; interval += 1) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(15_000);
        expect((await next).value).toBe(': keepalive\n\n');
      }
      expect(added).toHaveBeenCalledTimes(3);
      expect(removed).toHaveBeenCalledTimes(3);
      await iterator.return(undefined);
    } finally { vi.useRealTimers(); }
  });

  it('encodes bounded SSE events and emits log-truncated metadata for an oversized payload', async () => {
    const { stream } = await fixture();
    const event: LogStreamEvent = { seq: 9, event: 'log', data: { jobId: 'job-log', stream: 'runner', text: 'x'.repeat(70_000), partial: false } };
    const encoded = stream.encodeSse(event);
    expect(encoded.length).toBeLessThanOrEqual(64 * 1024);
    expect(encoded).toContain('event: log-truncated');
  });
});
