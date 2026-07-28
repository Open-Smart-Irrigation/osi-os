import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { DurableLogStream } from '../../api/src/log-stream.js';
import {
  createRunnerLogCoordinator,
  appendByteBoundedTextCapture,
} from '../../runner/src/log-coordinator.js';

const NOW = '2026-07-28T10:00:00.000Z';
const FINISHED = '2026-07-28T10:00:01.000Z';
const LATER = '2026-07-28T10:00:02.000Z';
const roots: string[] = [];
const databases: Array<ReturnType<typeof openBuilderDatabase>> = [];

function seedJob(db: ReturnType<typeof openBuilderDatabase>, jobId = 'job-runner-log'): void {
  db.prepare(`INSERT INTO jobs (job_id, request_id, request_json, source_remote, source_ref, source_branch, branch, expected_sha, pinned_sha, source_preparation_json, offline_feed_preparation_json,
    target_id, root_id, target_manifest_sha256, source_commit_time, source_author, source_subject, accepted_at, state, queue_state, queue_position, created_at, updated_at)
    VALUES (?, ?, '{}', 'ssh://example/repo', 'refs/remotes/origin/main', 'main', 'main', ?, ?, '{}', '{}', 'rpi-5', 'release', ?, ?, 'test', 'log', ?, 'building', 'released', NULL, ?, ?)`).run(
    jobId, `${jobId}-request`, 'a'.repeat(40), 'a'.repeat(40), 'b'.repeat(64), NOW, NOW, NOW, NOW,
  );
}

async function fixture(jobId = 'job-runner-log') {
  const jobRoot = await mkdtemp(join(tmpdir(), 'osi-runner-log-'));
  roots.push(jobRoot);
  const db = openBuilderDatabase(join(jobRoot, 'jobs.sqlite'), { now: () => NOW });
  databases.push(db);
  seedJob(db, jobId);
  return { db, jobRoot, coordinator: createRunnerLogCoordinator({ db, jobRoot, jobId, clock: { now: () => NOW } }) };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runner log coordinator', () => {
  it('writes safe pipeline lines, exact Docker bytes, events, files, and replay', async () => {
    const { db, jobRoot, coordinator } = await fixture();
    coordinator.pipelineLogWriter.write({ jobId: 'ignored', stage: 'source', outcome: 'running', at: NOW });
    coordinator.appendDockerBytes(Buffer.from('out\n\xff\n'));

    expect(await readFile(join(jobRoot, 'logs/runner.0'))).toEqual(Buffer.from('{"jobId":"job-runner-log","stage":"source","outcome":"running","at":"2026-07-28T10:00:00.000Z"}\n'));
    expect(await readFile(join(jobRoot, 'logs/docker.0'))).toEqual(Buffer.from('out\n\xff\n'));
    expect(db.prepare('SELECT stream, event_type FROM job_events WHERE job_id=? ORDER BY seq').all('job-runner-log')).toEqual([
      { stream: 'runner', event_type: 'log' },
      { stream: 'docker', event_type: 'log' },
    ]);

    const replay = new DurableLogStream({ db, root: jobRoot, jobId: 'job-runner-log', now: () => NOW }).replaySync(-1);
    const logEvents = replay.filter((event) => event.event === 'log');
    expect(logEvents[0]?.data.text).toBe('{"jobId":"job-runner-log","stage":"source","outcome":"running","at":"2026-07-28T10:00:00.000Z"}\n');
    expect(Buffer.from(String(logEvents[1]?.data.bytesBase64), 'base64')).toEqual(Buffer.from('out\n\xff\n'));
    coordinator.close();
  });

  it('preserves sequential stdout/stderr append order and rotates after finalize', async () => {
    const { db, jobRoot, coordinator } = await fixture();
    coordinator.appendDockerBytes(Buffer.from('stdout-1\n'));
    coordinator.appendDockerBytes(Buffer.from('stderr-1\n'));
    expect(coordinator.finalize(FINISHED)).toEqual({ runner: 'absent', docker: 'sealed', verifiedAt: FINISHED });
    coordinator.appendDockerBytes(Buffer.from('stdout-2\n'));
    expect(await readFile(join(jobRoot, 'logs/docker.1'))).toEqual(Buffer.from('stdout-2\n'));
    expect(db.prepare('SELECT stream, generation, size_bytes, sealed_at FROM job_log_generations WHERE job_id=? ORDER BY generation').all('job-runner-log')).toEqual([
      { stream: 'docker', generation: 0, size_bytes: 18, sealed_at: NOW },
      { stream: 'docker', generation: 1, size_bytes: 9, sealed_at: null },
    ]);
    coordinator.close();
  });

  it('returns absent/sealed proofs with verified chronology and cancellation parity', async () => {
    const value = await fixture();
    expect(value.coordinator.finalize(FINISHED)).toEqual({ runner: 'absent', docker: 'absent', verifiedAt: FINISHED });
    value.coordinator.appendDockerBytes(Buffer.from('cancelled\n'));
    expect(value.coordinator.sealForCancellation(LATER)).toEqual({ runner: 'absent', docker: 'sealed', verifiedAt: LATER });
    value.coordinator.close();
  });

  it('emits only the safe line keys and bounds UTF-8 capture by bytes', async () => {
    const { coordinator, jobRoot } = await fixture();
    coordinator.pipelineLogWriter.write({ jobId: 'wrong', stage: 'source', outcome: 'passed', at: NOW });
    const line = (await readFile(join(jobRoot, 'logs/runner.0'), 'utf8')).trim();
    expect(Object.keys(JSON.parse(line))).toEqual(['jobId', 'stage', 'outcome', 'at']);
    const capture: string[] = [];
    appendByteBoundedTextCapture(capture, Buffer.from('a\u00e9b', 'utf8'), 3);
    expect(capture).toEqual(['a\u00e9']);
    expect(Buffer.byteLength(capture.join(''))).toBe(3);
    coordinator.close();
  });

  it('rejects invalid ids, rejects writes after close, and makes close idempotent', async () => {
    const { coordinator } = await fixture();
    expect(() => createRunnerLogCoordinator({ db: databases[0]!, jobRoot: roots[0]!, jobId: '../escape', clock: { now: () => NOW } })).toThrow(/job id/i);
    coordinator.close();
    expect(() => coordinator.close()).not.toThrow();
    expect(() => coordinator.appendDockerBytes(Buffer.from('late'))).toThrow(/closed/i);
    expect(() => coordinator.pipelineLogWriter.write({ jobId: 'job-runner-log', stage: 'source', outcome: 'failed', at: NOW })).toThrow(/closed/i);
  });

  it('aggregates close sealing errors and remains closed afterward', async () => {
    const { coordinator, jobRoot } = await fixture();
    coordinator.appendDockerBytes(Buffer.from('will be missing\n'));
    await unlink(join(jobRoot, 'logs/docker.0'));
    expect(() => coordinator.close()).toThrow(AggregateError);
    expect(() => coordinator.appendDockerBytes(Buffer.from('late'))).toThrow(/closed/i);
    expect(() => coordinator.close()).not.toThrow();
  });
});
