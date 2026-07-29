import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from 'vite';

import { createStaticUiService, type StaticUiService } from '../../api/src/static-ui.js';

const LOOPBACK = '127.0.0.1';
const PORT = Number(process.env.OSI_BUILDER_FIXTURE_PORT ?? '43139');
const SHA = 'd92fabc2f778324ee9db4ddfb8dd46e3234fb4cb';
const FIXED_NOW = '2026-07-28T10:00:00.000Z';
const FIXED_LATER = '2026-07-28T10:18:42.000Z';
const SEED_ID = 'osi-builder-browser-v1';
const JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
});

interface FixtureState {
  jobs: Array<Record<string, unknown>>;
  details: Map<string, Record<string, unknown>>;
  events: Map<string, Array<Record<string, unknown>>>;
}

function stageEvidence(stage: string, index: number): Record<string, unknown> {
  return {
    stage,
    outcome: 'passed',
    startedAt: FIXED_NOW,
    finishedAt: FIXED_LATER,
    path: `jobs/job-pi5-success/evidence/${String(index).padStart(2, '0')}-${stage}.json`,
    evidenceSha256: String(index + 1).padStart(64, '0'),
    errorCode: null,
  };
}

function jobSummary(input: Readonly<{
  id: string;
  state: string;
  branch: string;
  targetId: string;
  currentStage: string | null;
  acceptedAt: string;
  terminalAt: string | null;
}>): Record<string, unknown> {
  return {
    ...input,
    outputRootId: 'release',
    queuePosition: null,
  };
}

function createSeed(): FixtureState {
  const pi5 = jobSummary({
    id: 'job-pi5-success',
    state: 'succeeded',
    branch: 'main',
    targetId: 'rpi-5',
    currentStage: 'publish',
    acceptedAt: FIXED_NOW,
    terminalAt: FIXED_LATER,
  });
  const pi4 = jobSummary({
    id: 'job-pi4-interrupted',
    state: 'interrupted',
    branch: 'design-sync/agrolink',
    targetId: 'rpi-2',
    currentStage: 'build',
    acceptedAt: '2026-07-28T09:20:00.000Z',
    terminalAt: '2026-07-28T09:44:00.000Z',
  });
  const evidence = [
    'preflight', 'source', 'release-gates', 'frontend', 'target-setup',
    'feeds', 'config', 'build', 'verify', 'publish',
  ].map(stageEvidence);
  const artifact = {
    rootId: 'release',
    directory: `main/${SHA}/rpi-5`,
    path: `main/${SHA}/rpi-5/osi-os-rpi-5.img.gz`,
    sha256: 'a'.repeat(64),
    size: 1_632_504_832,
    mtime: FIXED_LATER,
    publishState: 'published',
    publishedAt: FIXED_LATER,
  };
  const detail = {
    ...pi5,
    stage: 'publish',
    pinnedSha: SHA,
    cancelRequestedAt: null,
    artifact,
    freshnessStatus: 'fresh',
    freshnessCheckedAt: FIXED_LATER,
    newerSourceAvailable: false,
    error: null,
    source: {
      branch: 'main',
      sourceRef: 'refs/remotes/origin/main',
      expectedSha: SHA,
      pinnedSha: SHA,
      commitTime: '2026-07-28T08:34:12.000Z',
      author: 'OSI Builder',
      subject: 'Refactor firmware build pipeline',
    },
    output: artifact,
    errors: { terminal: null, publish: null, cleanup: null, freshness: null },
    cancellation: { requestedAt: null, cooperativeDeadlineAt: null, graceDeadlineAt: null },
    runtime: {
      runnerUnit: 'osi-image-builder-runner@job-pi5-success.service',
      dispatchedAt: FIXED_NOW,
      cleanupOutcome: 'removed',
    },
    evidence,
  };
  const interruptedDetail = {
    ...pi4,
    stage: 'build',
    pinnedSha: SHA,
    cancelRequestedAt: null,
    artifact: null,
    freshnessStatus: 'unknown',
    freshnessCheckedAt: null,
    newerSourceAvailable: false,
    error: { code: 'RUNNER_DISAPPEARED', details: { stage: 'build' } },
    source: {
      branch: 'design-sync/agrolink',
      sourceRef: 'refs/remotes/origin/design-sync/agrolink',
      expectedSha: SHA,
      pinnedSha: SHA,
      commitTime: '2026-07-28T08:12:00.000Z',
      author: 'OSI Builder',
      subject: 'Synchronize Agrolink branding',
    },
    output: null,
    errors: { terminal: null, publish: null, cleanup: null, freshness: null },
    cancellation: { requestedAt: null, cooperativeDeadlineAt: null, graceDeadlineAt: null },
    runtime: {
      runnerUnit: 'osi-image-builder-runner@job-pi4-interrupted.service',
      dispatchedAt: '2026-07-28T09:20:02.000Z',
      cleanupOutcome: null,
    },
    evidence: evidence.slice(0, 8),
  };
  return {
    jobs: [pi5, pi4],
    details: new Map<string, Record<string, unknown>>([
      ['job-pi5-success', detail],
      ['job-pi4-interrupted', interruptedDetail],
    ]),
    events: new Map<string, Array<Record<string, unknown>>>([
      ['job-pi5-success', [
        { seq: 1, event: 'stage', state: 'source', stage: 'source', at: FIXED_NOW, data: {} },
        { seq: 2, event: 'log', state: 'building', stage: 'build', at: '2026-07-28T10:05:00.000Z', data: { text: 'Building immutable rpi-5 image' } },
        { seq: 3, event: 'terminal', state: 'succeeded', stage: 'publish', at: FIXED_LATER, data: {} },
      ]],
      ['job-pi4-interrupted', [
        { seq: 1, event: 'stage', state: 'building', stage: 'build', at: '2026-07-28T09:20:02.000Z', data: {} },
        { seq: 2, event: 'terminal', state: 'interrupted', stage: 'build', at: '2026-07-28T09:44:00.000Z', data: { reason: 'RUNNER_DISAPPEARED' } },
      ]],
    ]),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

function apiError(response: ServerResponse, status: number, code: string): void {
  json(response, status, {
    error: {
      code,
      message: code,
      stage: null,
      details: {},
      retryable: false,
      requestId: 'fixture-request',
    },
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object');
  return value as Record<string, unknown>;
}

function target(id: 'rpi-5' | 'rpi-2', label: string, environment: string, profile: string): Record<string, unknown> {
  return {
    id,
    label,
    environment,
    openwrtTarget: id === 'rpi-5' ? 'bcm27xx/bcm2712' : 'bcm27xx/bcm2709',
    profile,
    rootfs: id === 'rpi-5'
      ? 'build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx'
      : 'build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx',
    artifactGlob: `osi-os-${id}-*.img.gz`,
    rootfsPartSize: 14336,
    minimumArtifactBytes: 67_108_864,
    configSymbols: [{ name: 'CONFIG_TARGET_PROFILE', type: 'string', value: profile }],
    operations: ['activate-target', 'build-image', 'verify-image'],
  };
}

function branchSnapshot(): Record<string, unknown> {
  return {
    fetchedAt: '2099-07-28T10:00:00.000Z',
    branches: [
      { name: 'main', sha: SHA, commitTime: '2026-07-28T08:34:12.000Z', subject: 'Refactor firmware build pipeline' },
      { name: 'design-sync/agrolink', sha: SHA, commitTime: '2026-07-28T08:12:00.000Z', subject: 'Synchronize Agrolink branding' },
    ],
  };
}

async function start(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('fixture server requires NODE_ENV=test');
  if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65_535) throw new Error('invalid fixture port');

  let state = createSeed();
  const streams = new Set<ServerResponse>();
  const uiRoot = new URL('../../ui/', import.meta.url).pathname;
  const signals = ['SIGINT', 'SIGTERM'] as const;
  let signalRequested = false;
  let signalShutdownStarted = false;
  let shutdownAfterStartup: (() => Promise<void>) | null = null;
  const removeSignalHandlers = (): void => {
    for (const signal of signals) process.off(signal, handleSignal);
  };
  const finishSignalShutdown = (operation: Promise<void>): void => {
    void operation.then(() => {
      process.exitCode = 0;
    }).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  const handleSignal = (): void => {
    signalRequested = true;
    if (shutdownAfterStartup !== null && !signalShutdownStarted) {
      signalShutdownStarted = true;
      finishSignalShutdown(shutdownAfterStartup());
    }
  };
  for (const signal of signals) process.on(signal, handleSignal);

  let fixtureRoot: string;
  try {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'osi-builder-browser-'));
  } catch (error) {
    removeSignalHandlers();
    throw error;
  }
  const cleanupFixtureRoot = async (): Promise<void> => {
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
    } finally {
      removeSignalHandlers();
    }
  };
  const distRoot = join(fixtureRoot, 'dist');
  if (signalRequested) {
    await cleanupFixtureRoot();
    return;
  }

  try {
    await build({
      root: uiRoot,
      configFile: new URL('../../ui/vite.config.ts', import.meta.url).pathname,
      logLevel: 'error',
      build: {
        outDir: distRoot,
        emptyOutDir: true,
      },
    });
  } catch (error) {
    await cleanupFixtureRoot();
    throw error;
  }
  if (signalRequested) {
    await cleanupFixtureRoot();
    return;
  }
  let staticUi: StaticUiService;
  try {
    staticUi = createStaticUiService(distRoot);
  } catch (error) {
    await cleanupFixtureRoot();
    throw error;
  }

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', `http://${LOOPBACK}:${PORT}`);

      if (method === 'POST' && url.pathname === '/test/reset') {
        state = createSeed();
        json(response, 200, { seed: SEED_ID, jobs: state.jobs.map((job) => job.id) });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { status: 'ok', version: '0.1.0-fixture', activeJobId: null });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/config') {
        json(response, 200, {
          repository: { path: '/home/phil/Repos/osi-os', remote: 'origin' },
          approvedOutputRoots: [{ id: 'release', label: 'Release images', path: '/home/phil/sdcard-images/0.7' }],
          targets: [
            target('rpi-5', 'Pi 5', 'full_raspberrypi_bcm27xx_bcm2712', 'DEVICE_rpi-5'),
            target('rpi-2', 'Pi 4 / 400 / 3 / 2', 'full_raspberrypi_bcm27xx_bcm2709', 'DEVICE_rpi-2'),
          ],
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/branches') {
        json(response, 200, branchSnapshot());
        return;
      }
      if (method === 'POST' && url.pathname === '/api/branches/refresh') {
        json(response, 200, branchSnapshot());
        return;
      }
      if (method === 'POST' && url.pathname === '/api/preflight') {
        const body = await readJson(request);
        json(response, 200, {
          preflightId: 'pf_fixture_01',
          observedSha: body.expectedSha,
          expiresAt: '2099-07-28T10:10:00.000Z',
          checks: [
            { id: 'source-sha', status: 'passed', details: { observedSha: String(body.expectedSha) } },
            { id: 'approved-output-root', status: 'passed', details: { rootId: String(body.outputRootId) } },
            { id: 'builder-image', status: 'passed', details: { digestPinned: true } },
          ],
        });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readJson(request);
        const accepted = jobSummary({
          id: 'job-browser-queued',
          state: 'queued',
          branch: String(body.branch),
          targetId: String(body.targetId),
          currentStage: null,
          acceptedAt: FIXED_LATER,
          terminalAt: null,
        });
        state.jobs = [accepted, ...state.jobs.filter((job) => job.id !== accepted.id)];
        state.details.set('job-browser-queued', {
          ...accepted,
          stage: null,
          pinnedSha: String(body.expectedSha),
          cancelRequestedAt: null,
          artifact: null,
          freshnessStatus: 'fresh',
          freshnessCheckedAt: FIXED_LATER,
          newerSourceAvailable: false,
          error: null,
          source: {
            branch: String(body.branch),
            sourceRef: `refs/remotes/origin/${String(body.branch)}`,
            expectedSha: String(body.expectedSha),
            pinnedSha: String(body.expectedSha),
            commitTime: FIXED_NOW,
            author: 'OSI Builder',
            subject: 'Fixture build',
          },
          output: null,
          errors: { terminal: null, publish: null, cleanup: null, freshness: null },
          cancellation: { requestedAt: null, cooperativeDeadlineAt: null, graceDeadlineAt: null },
          runtime: { runnerUnit: null, dispatchedAt: null, cleanupOutcome: null },
          evidence: [],
        });
        state.events.set('job-browser-queued', []);
        json(response, 202, {
          job: {
            id: accepted.id,
            state: 'queued',
            queuePosition: 0,
            branch: accepted.branch,
            targetId: accepted.targetId,
            outputRootId: accepted.outputRootId,
          },
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/jobs') {
        json(response, 200, { jobs: state.jobs, nextCursor: null });
        return;
      }

      const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(url.pathname);
      if (jobMatch !== null && method === 'GET') {
        const detail = state.details.get(decodeURIComponent(jobMatch[1]!));
        if (detail === undefined) apiError(response, 404, 'JOB_NOT_FOUND');
        else json(response, 200, detail);
        return;
      }
      if (jobMatch !== null && method === 'POST') {
        const id = decodeURIComponent(jobMatch[1]!);
        const detail = state.details.get(id);
        if (detail === undefined) apiError(response, 404, 'JOB_NOT_FOUND');
        else json(response, 200, detail);
        return;
      }

      const eventMatch = /^\/api\/jobs\/([^/]+)\/events$/u.exec(url.pathname);
      if (eventMatch !== null && method === 'GET') {
        const events = state.events.get(decodeURIComponent(eventMatch[1]!));
        if (events === undefined) apiError(response, 404, 'JOB_NOT_FOUND');
        else json(response, 200, { events, next: events.at(-1)?.seq ?? -1 });
        return;
      }

      const streamMatch = /^\/api\/jobs\/([^/]+)\/events\/stream$/u.exec(url.pathname);
      if (streamMatch !== null && method === 'GET') {
        const id = decodeURIComponent(streamMatch[1]!);
        if (!state.details.has(id)) {
          apiError(response, 404, 'JOB_NOT_FOUND');
          return;
        }
        response.writeHead(200, {
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'content-type': 'text/event-stream',
        });
        response.write(': fixture-stream\n\n');
        streams.add(response);
        request.once('close', () => streams.delete(response));
        return;
      }

      const evidenceMatch = /^\/api\/jobs\/([^/]+)\/evidence\/([^/]+)$/u.exec(url.pathname);
      if (evidenceMatch !== null && method === 'GET') {
        json(response, 200, {
          schemaVersion: 1,
          jobId: decodeURIComponent(evidenceMatch[1]!),
          stage: decodeURIComponent(evidenceMatch[2]!),
          startedAt: FIXED_NOW,
          finishedAt: FIXED_LATER,
          outcome: 'passed',
          operationId: null,
          inputs: { targetId: 'rpi-5' },
          observations: { verified: true },
          commands: [],
          error: null,
        });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        apiError(response, 404, 'ROUTE_NOT_FOUND');
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        const asset = await staticUi.resolve(url.pathname);
        if (asset !== null) {
          response.writeHead(asset.status, {
            'cache-control': asset.cacheControl,
            'content-length': asset.bytes.byteLength,
            'content-type': asset.contentType,
          });
          response.end(method === 'HEAD' ? undefined : asset.bytes);
          return;
        }
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    })().catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) apiError(response, 500, 'FIXTURE_FAILURE');
      else response.end();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, LOOPBACK, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    staticUi.close();
    await cleanupFixtureRoot();
    throw error;
  }

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownPromise = (async () => {
      for (const stream of streams) stream.end();
      streams.clear();
      try {
        await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      } finally {
        staticUi.close();
        await cleanupFixtureRoot();
      }
    })();
    return shutdownPromise;
  };
  shutdownAfterStartup = shutdown;

  if (signalRequested) {
    await shutdown();
    return;
  }

  console.log(`fixture server listening on http://${LOOPBACK}:${PORT}`);
}

void start().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
