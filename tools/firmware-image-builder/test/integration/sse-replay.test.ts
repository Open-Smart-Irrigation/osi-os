import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
