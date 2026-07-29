import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeFreshnessAck } from '../../api/src/freshness-protocol.js';
import type { ApiFreshnessProtocolStore } from '../../api/src/freshness-protocol.js';
import type { FreshnessInput, JobRecord } from '../../api/src/store.js';
import { createApiFreshnessServer, type ApiFreshnessServer } from '../../api/src/freshness-server.js';
import { loadStateRootAuthority } from '../../config/load.js';
import { createApiFreshnessSocketClient } from '../../runner/src/freshness.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const temporaryDirectories: string[] = [];
const servers: ApiFreshnessServer[] = [];

function protocolStore(): ApiFreshnessProtocolStore & { readonly read: () => Readonly<Record<string, unknown>> } {
  let job = {
    branch: 'main',
    pinnedSha: SHA,
    freshnessStatus: null as 'fresh' | 'advanced' | 'unknown' | null,
    freshnessRequestedAt: null as string | null,
    freshnessObservedSha: null as string | null,
  };
  return {
    getJob: () => job as unknown as JobRecord,
    request: (_jobId: string, at: string) => {
      job = { ...job, freshnessRequestedAt: at };
      return { ok: true as const, kind: 'committed' as const, eventSeq: 1, value: undefined };
    },
    result: (_jobId: string, input: FreshnessInput, _at: string) => {
      job = { ...job, freshnessStatus: input.status, freshnessObservedSha: input.observedSha };
      return { ok: true as const, kind: 'committed' as const, eventSeq: 2, value: undefined };
    },
    read: () => job,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close().catch(() => undefined);
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('API freshness server integration', () => {
  it('serves the runner client from the authority socket and persists the ACK result', async () => {
    const base = await mkdtemp(join(tmpdir(), 'osi-freshness-integration-'));
    temporaryDirectories.push(base);
    const loaded = await loadStateRootAuthority({ env: { HOME: base, XDG_STATE_HOME: join(base, 'state-home') } });
    const store = protocolStore();
    const server = await createApiFreshnessServer({
      stateRoot: loaded.authority,
      store,
      resolver: {
        resolve: async ({ pinnedSha }) => ({ status: 'fresh', observedSha: pinnedSha, checkedAt: '2026-07-29T10:00:00.000Z' }),
      },
      errorEvidence: { write: async () => ({ error: { code: 'FRESHNESS_UNKNOWN', reason: 'resolver-unavailable-or-malformed', details: {} }, path: 'evidence/job.json', sha256: 'a'.repeat(64) }) },
      now: () => '2026-07-29T09:59:00.000Z',
    });
    servers.push(server);

    expect(server.socketPath).toBe(join(loaded.stateRoot, 'api.sock'));
    expect((await lstat(server.socketPath)).isSocket()).toBe(true);
    await createApiFreshnessSocketClient(loaded.authority).signal('job-1');
    expect(store.read()).toMatchObject({ freshnessStatus: 'fresh', freshnessObservedSha: SHA });
    expect(encodeFreshnessAck()).toEqual(Buffer.from('{"schemaVersion":1,"accepted":true}\n'));
  });

  it('does not leave a listener or socket after a complete shutdown', async () => {
    const base = await mkdtemp(join(tmpdir(), 'osi-freshness-shutdown-'));
    temporaryDirectories.push(base);
    const loaded = await loadStateRootAuthority({ env: { HOME: base, XDG_STATE_HOME: join(base, 'state-home') } });
    const store = protocolStore();
    const server = await createApiFreshnessServer({
      stateRoot: loaded.authority,
      store,
      resolver: { resolve: async ({ pinnedSha }) => ({ status: 'fresh', observedSha: pinnedSha, checkedAt: '2026-07-29T10:00:00.000Z' }) },
      errorEvidence: { write: async () => ({ error: { code: 'FRESHNESS_UNKNOWN', reason: 'resolver-unavailable-or-malformed', details: {} }, path: 'evidence/job.json', sha256: 'a'.repeat(64) }) },
      now: () => '2026-07-29T09:59:00.000Z',
    });
    servers.push(server);
    await server.close();
    await expect(lstat(server.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps process-exit listener cleanup away from a later public path', async () => {
    const base = await mkdtemp(join(tmpdir(), 'osi-freshness-fd-reuse-'));
    temporaryDirectories.push(base);
    const childScript = `
      import { open, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { loadStateRootAuthority } from './config/load.ts';
      import { createApiFreshnessServerForTest } from './api/src/freshness-server.ts';
      const base = process.env.FRESHNESS_TEST_BASE;
      const loaded = await loadStateRootAuthority({ env: { HOME: base, XDG_STATE_HOME: join(base, 'state-home') } });
      const server = await createApiFreshnessServerForTest({
        stateRoot: loaded.authority,
        store: { getJob: () => ({ branch: 'main', pinnedSha: '${SHA}', freshnessStatus: null, freshnessRequestedAt: null }), request: () => ({ ok: true, kind: 'committed', eventSeq: 1, value: undefined }), result: () => ({ ok: true, kind: 'committed', eventSeq: 2, value: undefined }) },
        resolver: { resolve: async ({ pinnedSha }) => ({ status: 'fresh', observedSha: pinnedSha, checkedAt: '2026-07-29T10:00:00.000Z' }) },
        errorEvidence: { write: async () => ({ error: { code: 'FRESHNESS_UNKNOWN', reason: 'resolver-unavailable-or-malformed', details: {} }, path: 'evidence/job.json', sha256: '${'a'.repeat(64)}' }) },
        now: () => '2026-07-29T09:59:00.000Z',
        shutdownTimeoutMs: 10,
      }, {
        privateClose: async () => new Promise(() => undefined),
      });
      await server.close().catch(() => undefined);
      await writeFile(join(loaded.stateRoot, 'api.sock'), 'sentinel');
      await writeFile(join(loaded.stateRoot, 'fd-reuse'), 'reuse');
      await open(join(loaded.stateRoot, 'fd-reuse'), 'r').then((handle) => handle.close());
      process.stdout.write('ready\\n');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: { ...process.env, FRESHNESS_TEST_BASE: base },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`freshness child timed out: ${stderr}`)); }, 5_000);
      child.once('error', reject);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    expect(exit, stderr).toEqual({ code: 0, signal: null });
    expect(stdout).toContain('ready');
    const sentinel = join(base, 'state-home', 'osi-image-builder', 'api.sock');
    await expect(lstat(sentinel)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('sentinel');
  });
});
