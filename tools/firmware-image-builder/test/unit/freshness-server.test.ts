import { createConnection, createServer } from 'node:net';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FRESHNESS_PROTOCOL_MAX_BYTES,
  encodeFreshnessAck,
  encodeFreshnessSignal,
} from '../../api/src/freshness-protocol.js';
import { loadStateRootAuthority, type StateRootAuthority } from '../../config/load.js';
import {
  createApiFreshnessServer,
  createApiFreshnessServerForTest,
  type ApiFreshnessServer,
} from '../../api/src/freshness-server.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const temporaryDirectories: string[] = [];
const servers: ApiFreshnessServer[] = [];
const staleProcesses: ReturnType<typeof spawn>[] = [];

interface FakeProtocol {
  readonly dependencies: Parameters<typeof createApiFreshnessServer>[0];
  readonly calls: { readonly jobId: string }[];
  readonly result: { status: string; observedSha: string | null } | null;
}

function fakeProtocol(options: { readonly fail?: boolean; readonly waitForHandler?: Promise<void> } = {}): FakeProtocol {
  let job = {
    branch: 'main',
    pinnedSha: SHA,
    freshnessStatus: null as 'fresh' | 'advanced' | 'unknown' | null,
    freshnessRequestedAt: null as string | null,
  };
  const calls: { jobId: string }[] = [];
  let result: { status: string; observedSha: string | null } | null = null;
  const dependencies = {
    stateRoot: undefined as never,
    store: {
      getJob: () => {
        if (options.fail) throw new Error('secret store detail');
        return job;
      },
      request: (_jobId: string, at: string) => {
        job = { ...job, freshnessRequestedAt: at };
        return { ok: true as const, kind: 'committed' as const, eventSeq: 1, value: undefined };
      },
      result: (_jobId: string, input: { readonly status: 'fresh' | 'advanced' | 'unknown'; readonly observedSha: string | null }, _at: string) => {
        job = { ...job, freshnessStatus: input.status };
        result = { status: input.status, observedSha: input.observedSha };
        return { ok: true as const, kind: 'committed' as const, eventSeq: 2, value: undefined };
      },
    },
    resolver: {
      resolve: async ({ pinnedSha }: { readonly branch: string; readonly pinnedSha: string }) => {
        calls.push({ jobId: 'job-1' });
        if (options.waitForHandler) await options.waitForHandler;
        if (options.fail) throw new Error('secret resolver detail');
        return { status: 'fresh' as const, observedSha: pinnedSha, checkedAt: '2026-07-29T10:00:00.000Z' };
      },
    },
    errorEvidence: {
      write: async () => ({
        error: { code: 'FRESHNESS_UNKNOWN', reason: 'resolver-unavailable-or-malformed', details: {} },
        path: 'evidence/job-1.json',
        sha256: 'a'.repeat(64),
      }),
    },
    now: () => '2026-07-29T09:59:00.000Z',
  } as unknown as Parameters<typeof createApiFreshnessServer>[0];
  Object.defineProperty(dependencies, 'calls', { value: calls });
  Object.defineProperty(dependencies, 'result', { get: () => result });
  return { dependencies, calls, get result() { return result; } };
}

async function authorityFixture(): Promise<{ readonly base: string; readonly authority: StateRootAuthority; readonly socketPath: string }> {
  const base = await mkdtemp(join(tmpdir(), 'osi-freshness-unit-'));
  temporaryDirectories.push(base);
  const loaded = await loadStateRootAuthority({
    env: {
      HOME: base,
      XDG_STATE_HOME: join(base, 'state-home'),
    },
  });
  return { base, authority: loaded.authority, socketPath: join(loaded.stateRoot, 'api.sock') };
}

async function start(options: Partial<Omit<Parameters<typeof createApiFreshnessServer>[0], 'stateRoot'>> = {}): Promise<{ readonly fixture: Awaited<ReturnType<typeof authorityFixture>>; readonly fake: FakeProtocol; readonly server: ApiFreshnessServer }> {
  const fixture = await authorityFixture();
  const fake = fakeProtocol();
  const server = await createApiFreshnessServer({ ...fake.dependencies, ...options, stateRoot: fixture.authority });
  servers.push(server);
  return { fixture, fake, server };
}

async function listenStaleSocket(path: string): Promise<{ readonly process: ReturnType<typeof spawn>; readonly cleanup: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createServer } from 'node:net'; const server = createServer(); server.listen(${JSON.stringify(path)});`], { stdio: 'ignore' });
  staleProcesses.push(child);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const info = await lstat(path);
      if (info.isSocket()) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
        await chmod(path, 0o600);
        return { process: child, cleanup: async () => { await unlink(path).catch(() => undefined); } };
      }
    } catch { /* wait for the child to bind */ }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  child.kill('SIGKILL');
  throw new Error('stale socket child did not bind');
}

function exchange(path: string, request: Uint8Array, options: { readonly end?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('connect', () => {
      socket.write(request);
      if (options.end !== false) socket.end();
    });
    socket.once('error', () => resolve(Buffer.concat(chunks)));
    socket.once('close', () => resolve(Buffer.concat(chunks)));
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close().catch(() => undefined);
  for (const child of staleProcesses.splice(0)) child.kill('SIGKILL');
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('API freshness Unix-socket server', () => {
  it('rejects non-Linux and invalid timeout configurations deterministically', async () => {
    const fixture = await authorityFixture();
    await expect(createApiFreshnessServer({ ...fakeProtocol().dependencies, stateRoot: fixture.authority, idleTimeoutMs: 0 })).rejects.toThrow(/timeout/iu);
  });

  it('handles one valid request and returns exactly the protocol ACK', async () => {
    const { fixture, fake } = await start();
    const response = await exchange(fixture.socketPath, encodeFreshnessSignal('job-1'));
    expect(response).toEqual(encodeFreshnessAck());
    expect(fake.calls).toHaveLength(1);
    expect(fake.result).toEqual({ status: 'fresh', observedSha: SHA });
  });

  it('creates a mode-0600 socket owned by the effective user', async () => {
    const { fixture } = await start();
    const info = await lstat(fixture.socketPath);
    expect(info.isSocket()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.uid).toBe(process.geteuid?.());
  });

  it('keeps the listener gated until post-listen identity checks complete', async () => {
    const fixture = await authorityFixture();
    const fake = fakeProtocol();
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let continueStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => { continueStartup = resolve; });
    const serverPromise = createApiFreshnessServerForTest({
      ...fake.dependencies,
      stateRoot: fixture.authority,
    }, {
      afterListen: async () => { release!(); await startupGate; },
    });
    await ready;
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(Buffer.alloc(0));
    await expect(createApiFreshnessServer({
      ...fakeProtocol().dependencies,
      stateRoot: fixture.authority,
    })).rejects.toThrow(/lifecycle.*owned/iu);
    continueStartup();
    const server = await serverPromise;
    servers.push(server);
    expect(fake.calls).toHaveLength(0);
  });

  it('recovers a crash-stale lifecycle lock before binding the listener', async () => {
    const fixture = await authorityFixture();
    const stateRoot = fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/'));
    const lockPath = join(stateRoot, '.api.lock');
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      startTime: '1',
      nonce: '00000000-0000-4000-8000-000000000000',
      bootId: '00000000-0000-0000-0000-000000000000',
    })}\n`, { mode: 0o600 });
    const fake = fakeProtocol();
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
    });
    servers.push(server);
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(encodeFreshnessAck());
    await server.close();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['malformed', async (lockPath: string) => writeFile(lockPath, 'not-json\n', { mode: 0o600 })],
    ['wrong-mode', async (lockPath: string) => writeFile(lockPath, '{}\n', { mode: 0o644 })],
    ['symlink', async (lockPath: string) => {
      await writeFile(`${lockPath}.target`, 'target\n', { mode: 0o600 });
      await symlink(`${lockPath}.target`, lockPath);
    }],
  ] as const)('rejects an unsafe %s lifecycle lock without mutation', async (_kind, createLock) => {
    const fixture = await authorityFixture();
    const stateRoot = fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/'));
    const lockPath = join(stateRoot, '.api.lock');
    await createLock(lockPath);
    const before = await lstat(lockPath);
    await expect(createApiFreshnessServer({
      ...fakeProtocol().dependencies,
      stateRoot: fixture.authority,
    })).rejects.toThrow(/lifecycle|lock|unsafe|ELOOP/iu);
    await expect(lstat(lockPath)).resolves.toMatchObject({
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
    });
  });

  it('treats a reused current PID with a mismatched start time as stale', async () => {
    const fixture = await authorityFixture();
    const stateRoot = fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/'));
    const lockPath = join(stateRoot, '.api.lock');
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      startTime: '0',
      nonce: '00000000-0000-4000-8000-000000000000',
      bootId: '00000000-0000-0000-0000-000000000000',
    })}\n`, { mode: 0o600 });
    const fake = fakeProtocol();
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
    });
    servers.push(server);
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(encodeFreshnessAck());
  });

  it('treats a matching PID/start time from another boot as stale', async () => {
    const fixture = await authorityFixture();
    const stateRoot = fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/'));
    const lockPath = join(stateRoot, '.api.lock');
    const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    const startTime = stat.slice(commandEnd + 2).trim().split(/\s+/u)[19]!;
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      startTime,
      nonce: '00000000-0000-4000-8000-000000000000',
      bootId: '00000000-0000-0000-0000-000000000000',
    })}\n`, { mode: 0o600 });
    const fake = fakeProtocol();
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
    });
    servers.push(server);
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(encodeFreshnessAck());
  });

  it('exact-cleans its own inode when a post-listen mode check fails', async () => {
    const fixture = await authorityFixture();
    await expect(createApiFreshnessServerForTest({
      ...fakeProtocol().dependencies,
      stateRoot: fixture.authority,
    }, {
      afterListen: async ({ anchorPath }) => {
        await chmod(anchorPath, 0o644);
        throw new Error('forced post-listen validation failure');
      },
    })).rejects.toThrow(/forced post-listen/iu);
    await expect(lstat(fixture.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes a bound listener when startup fails before its first identity read', async () => {
    const fixture = await authorityFixture();
    await expect(createApiFreshnessServerForTest({
      ...fakeProtocol().dependencies,
      stateRoot: fixture.authority,
    }, {
      afterBindBeforeIdentity: () => { throw new Error('forced pre-identity failure'); },
    })).rejects.toThrow(/forced pre-identity/iu);
    const stateRoot = fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/'));
    for (const basename of ['api.sock', '.api.sock.listener', '.api.lock']) {
      await expect(lstat(join(stateRoot, basename))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const fake = fakeProtocol();
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
    });
    servers.push(server);
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(encodeFreshnessAck());
  });

  it('recovers an owned mode-0600 stale socket and leaves the new socket usable', async () => {
    const fixture = await authorityFixture();
    const anchorPath = join(
      fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/')),
      '.api.sock.listener',
    );
    const stale = await listenStaleSocket(anchorPath);
    await link(anchorPath, fixture.socketPath);
    expect((await lstat(fixture.socketPath)).isSocket()).toBe(true);
    expect((await lstat(anchorPath)).ino).toBe((await lstat(fixture.socketPath)).ino);
    const fake = fakeProtocol();
    const server = await createApiFreshnessServer({ ...fake.dependencies, stateRoot: fixture.authority });
    servers.push(server);
    expect((await lstat(fixture.socketPath)).isSocket()).toBe(true);
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(encodeFreshnessAck());
  });

  it.each(['public', 'anchor'] as const)('recovers a stale %s-only listener link', async (kind) => {
    const fixture = await authorityFixture();
    const anchorPath = join(
      fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/')),
      '.api.sock.listener',
    );
    await listenStaleSocket(kind === 'public' ? fixture.socketPath : anchorPath);
    const fake = fakeProtocol();
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
    });
    servers.push(server);
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(encodeFreshnessAck());
  });

  it('does not partially remove a stale public socket when its anchor is invalid', async () => {
    const fixture = await authorityFixture();
    await listenStaleSocket(fixture.socketPath);
    const anchorPath = join(
      fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/')),
      '.api.sock.listener',
    );
    await writeFile(anchorPath, 'invalid anchor', { mode: 0o600 });
    const before = await lstat(fixture.socketPath);
    await expect(createApiFreshnessServer({
      ...fakeProtocol().dependencies,
      stateRoot: fixture.authority,
    })).rejects.toThrow(/socket|anchor|listener/iu);
    await expect(lstat(fixture.socketPath)).resolves.toMatchObject({
      dev: before.dev,
      ino: before.ino,
    });
    await expect(lstat(anchorPath)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('does not unlink an active owned mode-0600 socket', async () => {
    const fixture = await authorityFixture();
    const active = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { active.once('error', reject); active.listen(fixture.socketPath, resolve); });
    await chmod(fixture.socketPath, 0o600);
    const before = await lstat(fixture.socketPath);
    await expect(createApiFreshnessServer({ ...fakeProtocol().dependencies, stateRoot: fixture.authority, livenessTimeoutMs: 250 })).rejects.toThrow(/active|liveness/iu);
    await expect(lstat(fixture.socketPath)).resolves.toMatchObject({ ino: before.ino, dev: before.dev });
    await expect(new Promise<void>((resolve, reject) => {
      const client = createConnection({ path: fixture.socketPath });
      client.once('connect', () => { client.destroy(); resolve(); });
      client.once('error', reject);
    })).resolves.toBeUndefined();
    await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    await unlink(fixture.socketPath).catch(() => undefined);
  });

  it('reports a bounded liveness timeout instead of treating an uncertain socket as stale', async () => {
    const fixture = await authorityFixture();
    const stale = await listenStaleSocket(fixture.socketPath);
    const before = await lstat(fixture.socketPath);
    await expect(createApiFreshnessServerForTest({
      ...fakeProtocol().dependencies,
      stateRoot: fixture.authority,
      livenessTimeoutMs: 10,
    }, {
      livenessProbe: async () => new Promise<never>(() => undefined),
    })).rejects.toThrow(/liveness.*unknown/iu);
    await expect(lstat(fixture.socketPath)).resolves.toMatchObject({ ino: before.ino, dev: before.dev });
    await stale.cleanup();
  });

  it.each([
    ['symlink', async (path: string) => { await writeFile(path + '.target', 'target'); await symlink(path + '.target', path); }],
    ['regular file', async (path: string) => { await writeFile(path, 'do not remove'); }],
    ['permissive socket', async (path: string) => { await listenStaleSocket(path); await chmod(path, 0o666); }],
  ] as const)('rejects a stale %s without mutation', async (_label, createEntry) => {
    const fixture = await authorityFixture();
    await createEntry(fixture.socketPath);
    const before = await lstat(fixture.socketPath);
    const beforeLink = before.isSymbolicLink() ? await readlink(fixture.socketPath) : null;
    await expect(createApiFreshnessServer({ ...fakeProtocol().dependencies, stateRoot: fixture.authority })).rejects.toThrow();
    const after = await lstat(fixture.socketPath);
    expect(after.isSymbolicLink()).toBe(before.isSymbolicLink());
    expect(after.isSocket()).toBe(before.isSocket());
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    if (after.isSymbolicLink()) await expect(readlink(fixture.socketPath)).resolves.toBe(beforeLink);
  });

  it('does not call the handler for empty, oversized, or malformed requests', async () => {
    const { fixture, fake } = await start();
    for (const request of [Buffer.alloc(0), Buffer.alloc(FRESHNESS_PROTOCOL_MAX_BYTES + 1, 0x61), Buffer.from('{"schemaVersion":1}\n')]) {
      await expect(exchange(fixture.socketPath, request)).resolves.toEqual(Buffer.alloc(0));
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('redacts handler failures and closes the connection without a response', async () => {
    const fixture = await authorityFixture();
    const fake = fakeProtocol({ fail: true });
    let getJobCalls = 0;
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
      store: { ...fake.dependencies.store, getJob: () => { getJobCalls += 1; throw new Error('secret store detail'); } },
      resolver: { resolve: async () => { throw new Error('secret resolver detail'); } },
      errorEvidence: { write: async () => { throw new Error('secret evidence detail'); } },
    });
    servers.push(server);
    await expect(exchange(fixture.socketPath, encodeFreshnessSignal('job-1'))).resolves.toEqual(Buffer.alloc(0));
    expect(getJobCalls).toBe(1);
  });

  it('settles active connections during bounded shutdown and supports idempotent close', async () => {
    const { fixture, server } = await start({ shutdownTimeoutMs: 100 });
    const socket = createConnection({ path: fixture.socketPath });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(Promise.all([server.close(), server.close()])).resolves.toEqual([undefined, undefined]);
    if (!socket.destroyed && !socket.closed) await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(socket.destroyed || socket.closed).toBe(true);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('waits for an in-flight freshness handler before close resolves', async () => {
    const fixture = await authorityFixture();
    let release!: () => void;
    const handlerGate = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeProtocol({ waitForHandler: handlerGate });
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
      shutdownTimeoutMs: 250,
    });
    servers.push(server);
    const response = exchange(fixture.socketPath, encodeFreshnessSignal('job-1'));
    await waitFor(() => fake.calls.length === 1, 'freshness handler did not start');
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);
    release();
    await expect(closing).resolves.toBeUndefined();
    await expect(response).resolves.toEqual(Buffer.alloc(0));
  });

  it('rejects bounded close when an in-flight handler does not settle', async () => {
    const fixture = await authorityFixture();
    let release!: () => void;
    const handlerGate = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeProtocol({ waitForHandler: handlerGate });
    const server = await createApiFreshnessServer({
      ...fake.dependencies,
      stateRoot: fixture.authority,
      shutdownTimeoutMs: 20,
    });
    servers.push(server);
    const response = exchange(fixture.socketPath, encodeFreshnessSignal('job-1'));
    await waitFor(() => fake.calls.length === 1, 'freshness handler did not start');
    await expect(server.close()).rejects.toThrow(/handler shutdown timed out/iu);
    await expect(server.close()).rejects.toThrow(/handler shutdown timed out/iu);
    const lockPath = join(
      fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/')),
      '.api.lock',
    );
    await expect(lstat(lockPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    release();
    await expect(server.settled).resolves.toBeUndefined();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(response).resolves.toEqual(Buffer.alloc(0));
  });

  it('finalizes the listener and lifecycle lock after a private-close timeout settles', async () => {
    const fixture = await authorityFixture();
    const fake = fakeProtocol();
    let release!: () => void;
    const closeGate = new Promise<void>((resolve) => { release = resolve; });
    const server = await createApiFreshnessServerForTest({
      ...fake.dependencies,
      stateRoot: fixture.authority,
      shutdownTimeoutMs: 20,
    }, {
      privateClose: async (close) => {
        await closeGate;
        await close();
      },
    });
    servers.push(server);
    await expect(server.close()).rejects.toThrow(/private listener shutdown timed out/iu);
    const stateRoot = fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/'));
    await expect(lstat(join(stateRoot, '.api.lock'))).resolves.toBeDefined();
    release();
    await expect(server.settled).resolves.toBeUndefined();
    for (const basename of ['api.sock', '.api.sock.listener', '.api.lock']) {
      await expect(lstat(join(stateRoot, basename))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('refuses to unlink a replacement socket during close', async () => {
    const { fixture, server } = await start();
    const moved = fixture.socketPath + '.moved';
    const original = await lstat(fixture.socketPath);
    await rename(fixture.socketPath, moved);
    const replacement = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(fixture.socketPath, resolve); });
    await chmod(fixture.socketPath, 0o600);
    const replacementInfo = await lstat(fixture.socketPath);
    expect(replacementInfo.ino).not.toBe(original.ino);
    await expect(server.close()).rejects.toThrow(/identity|replacement|socket/iu);
    await expect(lstat(fixture.socketPath)).resolves.toMatchObject({ ino: replacementInfo.ino, dev: replacementInfo.dev });
    const replacementConnection = createConnection({ path: fixture.socketPath });
    const replacementConnectionClosed = new Promise<void>((resolve) => replacementConnection.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      replacementConnection.once('error', reject);
      replacementConnection.once('connect', () => resolve());
      replacementConnection.setTimeout(500, () => { replacementConnection.destroy(); reject(new Error('replacement socket did not accept')); });
    });
    replacementConnection.destroy();
    await replacementConnectionClosed;
    await expect(new Promise<void>((resolve, reject) => {
      const originalConnection = createConnection({ path: moved });
      const timer = setTimeout(() => { originalConnection.destroy(); reject(new Error('retired original listener did not settle')); }, 500);
      originalConnection.once('connect', () => originalConnection.end(encodeFreshnessSignal('job-1')));
      originalConnection.once('data', () => { clearTimeout(timer); originalConnection.destroy(); reject(new Error('retired original listener returned a protocol response')); });
      originalConnection.once('close', () => { clearTimeout(timer); resolve(); });
      originalConnection.once('error', () => { clearTimeout(timer); resolve(); });
    })).resolves.toBeUndefined();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replacement server did not close')), 500);
      replacement.close((error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
    });
    await unlink(moved).catch(() => undefined);
  });

  it('preserves a replacement installed after the first close identity check', async () => {
    const fixture = await authorityFixture();
    const fake = fakeProtocol();
    const moved = fixture.socketPath + '.moved';
    let replacement: ReturnType<typeof createServer> | undefined;
    let replacementInfo: Awaited<ReturnType<typeof lstat>> | undefined;
    const server = await createApiFreshnessServerForTest({
      ...fake.dependencies,
      stateRoot: fixture.authority,
    }, {
      beforeUnlink: async ({ socketPath }) => {
        await rename(socketPath, moved);
        replacement = createServer((socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          replacement!.once('error', reject);
          replacement!.listen(socketPath, resolve);
        });
        await chmod(socketPath, 0o600);
        replacementInfo = await lstat(socketPath);
      },
    });
    servers.push(server);
    await expect(server.close()).rejects.toThrow(/identity|replacement/iu);
    expect(replacementInfo).toBeDefined();
    await expect(lstat(fixture.socketPath)).resolves.toMatchObject({
      ino: replacementInfo!.ino,
      dev: replacementInfo!.dev,
    });
    await new Promise<void>((resolve, reject) => replacement!.close((error) => error ? reject(error) : resolve()));
    await unlink(moved).catch(() => undefined);
  });

  it('refuses to unlink a socket under a replacement state-root path', async () => {
    const { fixture, server } = await start();
    const stateRoot = fixture.socketPath.slice(0, fixture.socketPath.lastIndexOf('/'));
    const moved = stateRoot + '.moved';
    await rename(stateRoot, moved);
    await mkdir(stateRoot, { mode: 0o700 });
    const replacement = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(fixture.socketPath, resolve); });
    await chmod(fixture.socketPath, 0o600);
    const replacementInfo = await lstat(fixture.socketPath);
    await expect(server.close()).rejects.toThrow(/parent|identity|replacement/iu);
    await expect(lstat(fixture.socketPath)).resolves.toMatchObject({ ino: replacementInfo.ino, dev: replacementInfo.dev });
    await new Promise<void>((resolve, reject) => replacement.close((error) => error ? reject(error) : resolve()));
    await rm(moved, { recursive: true, force: true });
  });
});
