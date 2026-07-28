import { renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { DurableLogStream } from '../../api/src/log-stream.js';

const roots: string[] = [];
const dbs: Array<ReturnType<typeof openBuilderDatabase>> = [];
const NOW = '2026-07-28T10:00:00.000Z';

function seed(db: ReturnType<typeof openBuilderDatabase>): void {
  db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json,
    target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, created_at, updated_at)
    VALUES ('job-sse', 'request-sse', '{}', 'ssh://example/repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, '{}', '{}', 'rpi-5', 'release', ?, ?, 'test', 'sse', ?, 'building', 'released', ?, ?)`)
    .run('a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), NOW, NOW, NOW, NOW);
}

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SSE durable replay', () => {
  it('replays stage, exact log, terminal, and keepalive-compatible frames without duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sse-replay-')); roots.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite')); dbs.push(db); seed(db);
    const stream = new DurableLogStream({ db, root, jobId: 'job-sse', now: () => NOW });
    stream.appendMetadataSync('stage', { jobId: 'job-sse', state: 'building', stage: 'build', at: NOW, message: 'active' });
    stream.appendSync('runner', Buffer.from('alpha\n\u03b2eta'));
    stream.appendMetadataSync('terminal', { jobId: 'job-sse', state: 'succeeded', at: NOW, newerSourceAvailable: false });
    const frames = stream.replaySync(-1).map((event) => stream.encodeSse(event));
    expect(frames.join('')).toContain('event: stage');
    expect(frames.join('')).toContain('event: log');
    expect(frames.join('')).toContain('alpha\\n\u03b2eta');
    expect(frames.join('')).toContain('event: terminal');
    const afterLog = stream.replaySync(1);
    expect(afterLog.filter((event) => event.event === 'log')).toHaveLength(0);
    await writeFile(join(root, 'logs/runner.0'), Buffer.from('alpha\n'));
    expect(stream.replaySync(0).some((event) => event.event === 'log-gap')).toBe(true);
  });

  it('reconnects after every cursor without duplicate or invented partial-line bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sse-cursors-')); roots.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite')); dbs.push(db); seed(db);
    const stream = new DurableLogStream({ db, root, jobId: 'job-sse', now: () => NOW });
    const first = stream.appendSync('runner', Buffer.from('line 1\nline 2')); 
    const second = stream.appendSync('runner', Buffer.from(' tail'));
    for (const cursor of [-1, first.seq, second.seq]) {
      const events = stream.replaySync(cursor);
      expect(events.filter((event) => event.event === 'log')).toHaveLength(cursor < first.seq ? 2 : cursor < second.seq ? 1 : 0);
      expect(events.map((event) => event.data.text).filter(Boolean).join('')).not.toContain('line 1\nline 2 tail tail');
    }
  });

  it('pages by durable event count and decoded bytes without changing canonical log bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sse-pages-')); roots.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite')); dbs.push(db); seed(db);
    const stream = new DurableLogStream({ db, root, jobId: 'job-sse', now: () => NOW });
    stream.appendMetadataSync('stage', { stage: 'build' });
    stream.appendSync('runner', Buffer.from('ab'));
    stream.appendSync('runner', Buffer.from('cdef\n'));
    stream.appendMetadataSync('terminal', { state: 'succeeded' });

    const first = stream.replaySync(-1, { eventLimit: 4, maxDecodedBytes: 2 });
    const second = stream.replaySync(first.at(-1)?.seq ?? -1, { eventLimit: 2, maxDecodedBytes: 2 });
    const replayed = [...first, ...second];

    expect(first).toHaveLength(2);
    expect(first.map(({ seq, event }) => [seq, event])).toEqual([[0, 'stage'], [1, 'log']]);
    expect(second).toHaveLength(2);
    expect(replayed.map(({ seq, event }) => [seq, event])).toEqual([[0, 'stage'], [1, 'log'], [2, 'log-truncated'], [3, 'terminal']]);
    expect(Buffer.from(String(replayed[1]?.data.bytesBase64), 'base64')).toEqual(Buffer.from('ab'));
    expect(replayed[2]?.data).toMatchObject({ offset: 2, length: 5, truncated: true, reason: 'REPLAY_EVENT_TOO_LARGE' });
    expect(await readFile(join(root, 'logs/runner.0'))).toEqual(Buffer.from('abcdef\n'));
  });

  it('does not expose stream-null log-gap or log-truncated as stage or terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sse-mapping-')); roots.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite')); dbs.push(db); seed(db);
    const stream = new DurableLogStream({ db, root, jobId: 'job-sse', now: () => NOW });
    stream.appendMetadataSync('log-gap', { code: 'RECOVERY_LOG_GAP' });
    stream.appendMetadataSync('log-truncated', { truncated: true });
    const events = stream.replaySync(-1);
    expect(events.map((event) => event.event)).toEqual(['log-gap', 'log-truncated']);
    expect(events.map((event) => stream.encodeSse(event))).not.toContain(expect.stringContaining('event: terminal'));
  });

  it('discovers gaps before emitting strictly ascending durable cursor events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sse-gap-order-')); roots.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite')); dbs.push(db); seed(db);
    const stream = new DurableLogStream({ db, root, jobId: 'job-sse', now: () => NOW });
    const source = stream.appendSync('runner', Buffer.from('lost\n'));
    const terminal = stream.appendMetadataSync('terminal', { jobId: 'job-sse', state: 'failed', at: NOW });
    await rm(join(root, 'logs/runner.0'));

    expect(source.seq).toBe(0);
    expect(terminal).toBe(1);
    expect(stream.replaySync(0).map(({ seq, event }) => [seq, event])).toEqual([[1, 'terminal'], [2, 'log-gap']]);
    expect(stream.replaySync(-1).map(({ seq, event }) => [seq, event])).toEqual([[1, 'terminal'], [2, 'log-gap']]);
    expect(stream.replaySync(1).map(({ seq, event }) => [seq, event])).toEqual([[2, 'log-gap']]);
    expect(stream.replaySync(2)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id='job-sse' AND event_type='log-gap'").get()).toEqual({ count: 1 });
  });

  it('replays split UTF-8 ranges as exact bytes without replacement text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sse-utf8-')); roots.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite')); dbs.push(db); seed(db);
    const stream = new DurableLogStream({ db, root, jobId: 'job-sse', now: () => NOW });
    const encoded = Buffer.from('\u20ac\n', 'utf8');
    const first = stream.appendSync('runner', encoded.subarray(0, 1));
    stream.appendSync('runner', encoded.subarray(1));

    const events = stream.replaySync(-1).filter((event) => event.event === 'log');
    const replayed = Buffer.concat(events.map((event) => Buffer.from(String(event.data.bytesBase64), 'base64')));
    expect(replayed).toEqual(encoded);
    expect(events.every((event) => event.data.text === undefined || !String(event.data.text).includes('\ufffd'))).toBe(true);
    expect(stream.replaySync(first.seq).filter((event) => event.event === 'log').map((event) => event.data.text)).not.toContain('\ufffd\n');
  });

  it('persists one ordered gap when the generation changes between discovery and read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sse-read-race-')); roots.push(root);
    const db = openBuilderDatabase(join(root, 'jobs.sqlite')); dbs.push(db); seed(db);
    let raced = false;
    const stream = new DurableLogStream({
      db,
      root,
      jobId: 'job-sse',
      now: () => NOW,
      beforeReplayRead: () => {
        if (raced) return;
        raced = true;
        const replacement = join(root, 'logs/replacement');
        writeFileSync(replacement, Buffer.from('other\n'));
        renameSync(replacement, join(root, 'logs/runner.0'));
      },
    });
    stream.appendSync('runner', Buffer.from('raced\n'));
    stream.appendMetadataSync('terminal', { jobId: 'job-sse', state: 'failed', at: NOW });

    expect(stream.replaySync(-1).map(({ seq, event }) => [seq, event])).toEqual([[1, 'terminal']]);
    expect(stream.replaySync(1).map(({ seq, event }) => [seq, event])).toEqual([[2, 'log-gap']]);
    expect(stream.replaySync(-1).map(({ seq, event }) => [seq, event])).toEqual([[1, 'terminal'], [2, 'log-gap']]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id='job-sse' AND event_type='log-gap'").get()).toEqual({ count: 1 });
  });
});
