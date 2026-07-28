import { renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { DurableLogStream } from '../../api/src/log-stream.js';

const roots: string[] = [];
const dbs: Array<ReturnType<typeof openBuilderDatabase>> = [];
const NOW = '2026-07-28T10:00:00.000Z';

function descendants<T extends ts.Node>(node: ts.Node, kind: ts.SyntaxKind): T[] {
  const found: T[] = [];
  const visit = (current: ts.Node): void => {
    if (current.kind === kind) found.push(current as T);
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

function callsNamed(source: ts.SourceFile, name: string): ts.CallExpression[] {
  return descendants<ts.CallExpression>(source, ts.SyntaxKind.CallExpression)
    .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === name);
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
  const match = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment => (
      ts.isPropertyAssignment(candidate)
      && ((ts.isIdentifier(candidate.name) && candidate.name.text === name)
        || (ts.isStringLiteral(candidate.name) && candidate.name.text === name))
    ),
  );
  expect(match, `missing object property ${name}`).toBeDefined();
  return match!;
}

function objectArgument(call: ts.CallExpression, context: string): ts.ObjectLiteralExpression {
  const argument = call.arguments[0];
  expect(argument && ts.isObjectLiteralExpression(argument), `${context} object argument`).toBe(true);
  return argument as ts.ObjectLiteralExpression;
}

function memberCalls(node: ts.Node, receiver: string, member: string): ts.CallExpression[] {
  return descendants<ts.CallExpression>(node, ts.SyntaxKind.CallExpression).filter((call) => (
    ts.isPropertyAccessExpression(call.expression)
    && call.expression.name.text === member
    && call.expression.expression.getText() === receiver
  ));
}

function expectIdentifier(node: ts.Node | undefined, name: string): void {
  expect(node !== undefined && ts.isIdentifier(node) && node.text === name).toBe(true);
}

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
  it('pins runner production log coordinator wiring', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../runner/src/main.ts', import.meta.url)),
      'utf8',
    );
    const file = ts.createSourceFile(
      'main.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parseDiagnostics = (file as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    }).parseDiagnostics ?? [];
    expect(parseDiagnostics).toEqual([]);

    const coordinatorCalls = callsNamed(file, 'createRunnerLogCoordinator');
    expect(coordinatorCalls).toHaveLength(1);
    const coordinatorOptions = objectArgument(coordinatorCalls[0]!, 'createRunnerLogCoordinator');
    expect(property(coordinatorOptions, 'db').initializer.getText()).toBe('database');
    expect(property(coordinatorOptions, 'jobRoot').initializer.getText())
      .toBe("join(stateRootIdentity.path, 'jobs', args.jobId)");
    expect(property(coordinatorOptions, 'jobId').initializer.getText()).toBe('args.jobId');

    const executorCalls = callsNamed(file, 'createDockerExecutor');
    expect(executorCalls).toHaveLength(1);
    const executorOptions = objectArgument(executorCalls[0]!, 'createDockerExecutor');
    for (const [callbackName, captureName] of [['onStdoutBytes', 'stdout'], ['onStderrBytes', 'stderr']] as const) {
      const callback = property(executorOptions, callbackName).initializer;
      expect(ts.isArrowFunction(callback), `${callbackName} callback`).toBe(true);
      const callbackCalls = ts.isArrowFunction(callback)
        ? descendants<ts.CallExpression>(callback, ts.SyntaxKind.CallExpression)
        : [];
      const appendDockerCalls = callbackCalls.filter((call) => (
        ts.isPropertyAccessExpression(call.expression)
        && call.expression.expression.getText() === 'coordinator'
        && call.expression.name.text === 'appendDockerBytes'
      ));
      const captureAppendCalls = callbackCalls.filter((call) => (
        ts.isPropertyAccessExpression(call.expression)
        && call.expression.expression.getText() === captureName
        && call.expression.name.text === 'append'
      ));
      expect(appendDockerCalls).toHaveLength(1);
      expect(captureAppendCalls).toHaveLength(1);
      expectIdentifier(appendDockerCalls[0]!.arguments[0], 'chunk');
      expectIdentifier(captureAppendCalls[0]!.arguments[0], 'chunk');
      expect(appendDockerCalls[0]!.pos).toBeLessThan(captureAppendCalls[0]!.pos);
    }

    const finalize = property(executorOptions, 'finalizeLogs').initializer;
    expect(ts.isArrowFunction(finalize)).toBe(true);
    const finalizeCalls = memberCalls(finalize, 'coordinator', 'finalize');
    expect(finalizeCalls).toHaveLength(1);
    expectIdentifier(finalizeCalls[0]!.arguments[0], 'operationFinishedAt');

    const pipelineObject = descendants<ts.ObjectLiteralExpression>(file, ts.SyntaxKind.ObjectLiteralExpression)
      .find((object) => object.properties.some((candidate) => (
        ts.isPropertyAssignment(candidate)
        && ts.isIdentifier(candidate.name)
        && candidate.name.text === 'pipelineLogWriter'
      )));
    expect(pipelineObject).toBeDefined();
    expect(property(pipelineObject!, 'pipelineLogWriter').initializer.getText())
      .toBe('coordinator.pipelineLogWriter');

    const cleanupObject = descendants<ts.ObjectLiteralExpression>(file, ts.SyntaxKind.ObjectLiteralExpression)
      .find((object) => object.properties.some((candidate) => (
        ts.isPropertyAssignment(candidate)
        && ts.isIdentifier(candidate.name)
        && candidate.name.text === 'logs'
      )));
    expect(cleanupObject).toBeDefined();
    const logs = property(cleanupObject!, 'logs').initializer;
    expect(ts.isArrowFunction(logs)).toBe(true);
    const cancellationLogs = logs as ts.ArrowFunction;
    const sealCalls = memberCalls(cancellationLogs, 'coordinator', 'sealForCancellation');
    expect(sealCalls).toHaveLength(1);
    expectIdentifier(sealCalls[0]!.arguments[0], 'verifiedAt');
    const proofCalls = memberCalls(cancellationLogs, 'ownership', 'cancellationLogProof');
    expect(proofCalls).toHaveLength(1);
    expect(proofCalls[0]!.arguments[0]!.getText()).toBe('args.jobId');
    expect(proofCalls[0]!.arguments[1]!.getText()).toBe('coordinatorProof.verifiedAt');

    const closeProperty = descendants<ts.PropertyAssignment>(file, ts.SyntaxKind.PropertyAssignment)
      .find((candidate) => (
        ts.isIdentifier(candidate.name)
        && candidate.name.text === 'close'
        && ts.isArrowFunction(candidate.initializer)
        && descendants<ts.CallExpression>(candidate.initializer.body, ts.SyntaxKind.CallExpression)
          .some((call) => (
            ts.isPropertyAccessExpression(call.expression)
            && call.expression.name.text === 'close'
            && call.expression.expression.getText() === 'stateRootHandle'
          ))
      ));
    expect(closeProperty).toBeDefined();
    const closeBody = (closeProperty!.initializer as ts.ArrowFunction).body;
    const closeCalls = descendants<ts.CallExpression>(closeBody, ts.SyntaxKind.CallExpression);
    const coordinatorClose = closeCalls.find((call) => (
      ts.isPropertyAccessExpression(call.expression)
      && call.expression.name.text === 'close'
      && call.expression.expression.getText() === 'coordinator'
    ));
    const stateRootClose = closeCalls.find((call) => (
      ts.isPropertyAccessExpression(call.expression)
      && call.expression.name.text === 'close'
      && call.expression.expression.getText() === 'stateRootHandle'
    ));
    expect(coordinatorClose).toBeDefined();
    expect(stateRootClose).toBeDefined();
    expect(coordinatorClose!.pos).toBeLessThan(stateRootClose!.pos);

    const productionCompositionCalls = callsNamed(file, 'createProductionComposition');
    expect(productionCompositionCalls).toHaveLength(1);
    expect(productionCompositionCalls[0]!.arguments[2]!.getText()).toBe('database');
  });

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
