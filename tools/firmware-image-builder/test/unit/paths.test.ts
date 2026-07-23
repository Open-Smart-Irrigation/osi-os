import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigAuthorityError, loadConfig, type PathAuthorityDependencies } from '../../config/load.js';
import {
  PathSecurityError,
  encodeBranchSlug,
  previewEvidencePath,
  previewQuarantinePath,
  previewReleasePath,
  previewStagingPath,
  withHeldParentUnderRoot,
  withNoFollowFileUnderRoot,
  type ReadCapability,
} from '../../domain/paths.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const SHA = '0123456789abcdef0123456789abcdef01234567';
const ampleDisk = async () => ({ bavail: 30, bsize: 1024 ** 3 });

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function createRoot(dependencies?: Partial<PathAuthorityDependencies>) {
  const base = await mkdtemp('/tmp/osi-image-builder-paths-');
  temporaryDirectories.push(base);
  const configHome = join(base, 'config-home');
  const stateHome = join(base, 'state-home');
  const repositoryPath = join(base, 'osi-os');
  const outputRoot = join(base, 'images');
  await mkdir(configHome, { recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  const configPath = join(configHome, 'config.json');
  const root = { id: 'sdcard-images', label: 'SD card images', path: outputRoot };
  await writeFile(configPath, JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [root],
    builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    git: { getOriginUrl: async () => 'git@github.com:Open-Smart-Irrigation/osi-os.git' },
    rootFs: { statfs: ampleDisk },
    pathAuthorityDependencies: dependencies,
  });
  return {
    base,
    configPath,
    repositoryPath,
    root: loaded.config.approvedOutputRoots[0],
    registry: loaded.pathAuthorities.approvedRoots,
    stateRoot: loaded.pathAuthorities.stateRoot,
    statePath: join(stateHome, 'osi-image-builder'),
  };
}

describe('deterministic path previews', () => {
  it('percent-encodes UTF-8 bytes and preserves non-normalized forms', () => {
    expect(encodeBranchSlug('feature/agrolink-branding')).toBe('feature%2Fagrolink-branding');
    expect(encodeBranchSlug('A-z_0.9~')).toBe('A-z_0.9~');
    expect(encodeBranchSlug('percent% slash/')).toBe('percent%25%20slash%2F');
    expect(encodeBranchSlug('e\u0301/e\u0301')).toBe('e%CC%81%2Fe%CC%81');
    expect(encodeBranchSlug('é/\u00E9')).not.toBe(encodeBranchSlug('e\u0301/e\u0301'));
    expect(encodeBranchSlug('./../')).toBe('.%2F..%2F');
  });

  it('bounds hostile branch input incrementally and retains the full SHA', async () => {
    expect(() => encodeBranchSlug('a'.repeat(2_000_000))).toThrow(PathSecurityError);
    const { registry, root } = await createRoot();
    const preview = await previewReleasePath(registry, root.id, 'feature/agrolink-branding', SHA, 'rpi-5');
    expect(preview.absolutePath).toBe(join(root.path, 'feature%2Fagrolink-branding', SHA, 'rpi-5'));
    expect(preview.authority).toBe('preview-only');
    expect(preview).not.toHaveProperty('readFile');
  });

  it('counts UTF-8 path separators toward the relative byte budget', async () => {
    const { registry, root } = await createRoot();
    const alternating = Array.from({ length: 2_049 }, (_, index) => index % 2 === 0 ? 'a' : 'b').join('/');
    await expect(previewStagingPath(registry, root.id, alternating)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('reports collisions as preflight metadata while rejecting symlink components', async () => {
    const { registry, root } = await createRoot();
    const first = await previewStagingPath(registry, root.id, 'job-1');
    expect(first.collision).toBe(false);
    await mkdir(first.absolutePath, { recursive: true });
    const occupied = await previewStagingPath(registry, root.id, 'job-1');
    expect(occupied.collision).toBe(true);
    await symlink('/tmp', join(root.path, '.osi-image-builder', 'staging-link'));
    await expect(previewRootWithLink(registry, root.id)).rejects.toBeInstanceOf(PathSecurityError);
  });

  it('keeps staging and quarantine in output roots and evidence in state', async () => {
    const { registry, root, stateRoot, statePath } = await createRoot();
    const staging = await previewStagingPath(registry, root.id, 'job-1');
    const quarantine = await previewQuarantinePath(registry, root.id, 'job-1');
    const evidence = await previewEvidencePath(stateRoot, 'job-1', '08-verify.json');
    expect(staging.absolutePath).toBe(join(root.path, '.osi-image-builder', 'staging', 'job-1'));
    expect(quarantine.absolutePath).toBe(join(root.path, '.osi-image-builder', 'quarantine', 'job-1'));
    expect(evidence.absolutePath).toBe(join(statePath, 'jobs', 'job-1', 'evidence', '08-verify.json'));
    expect(evidence.absolutePath).not.toContain(root.path);
  });

  it('rejects unknown and forged authorities and unsafe relative inputs', async () => {
    const { registry, root, stateRoot } = await createRoot();
    await expect(previewStagingPath({} as never, root.id, 'job-1')).rejects.toBeInstanceOf(PathSecurityError);
    await expect(previewStagingPath(registry, 'unknown', 'job-1')).rejects.toBeInstanceOf(PathSecurityError);
    await expect(previewEvidencePath({} as never, 'job-1', 'evidence.json')).rejects.toBeInstanceOf(PathSecurityError);
    for (const value of ['', '.', '..', '../escape', '/absolute', 'a\\b', 'a\0b', 'x/'.repeat(3_000)]) {
      await expect(previewStagingPath(registry, root.id, value)).rejects.toBeInstanceOf(PathSecurityError);
      await expect(previewEvidencePath(stateRoot, 'job-1', value)).rejects.toBeInstanceOf(PathSecurityError);
    }
  });

  it('rejects duplicate, nested, and protected-root overlaps through config loading', async () => {
    const base = await mkdtemp('/tmp/osi-image-builder-overlap-');
    temporaryDirectories.push(base);
    const repo = join(base, 'repo');
    const images = join(base, 'images');
    const nested = join(images, 'nested');
    const stateHome = join(base, 'state-home');
    const configHome = join(base, 'config-home');
    await mkdir(repo, { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(configHome, { recursive: true });
    const configPath = join(configHome, 'config.json');
    await writeFile(configPath, JSON.stringify({ repositoryPath: repo, approvedOutputRoots: [{ id: 'a', label: 'a', path: images }, { id: 'b', label: 'b', path: nested }], builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json' }));
    await expect(loadConfig({ configPath, env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome }, git: { getOriginUrl: async () => 'git@example.com:osi/os.git' }, rootFs: { statfs: ampleDisk } })).rejects.toThrow(/overlap/i);
  });

  it('detects root replacement and symlink replacement after config issuance', async () => {
    const { base, root, registry } = await createRoot();
    const moved = join(base, 'original-images');
    await rename(root.path, moved);
    await mkdir(root.path);
    await expect(previewStagingPath(registry, root.id, 'replacement')).rejects.toBeInstanceOf(PathSecurityError);
    await rm(root.path, { recursive: true });
    await symlink(moved, root.path);
    await expect(previewStagingPath(registry, root.id, 'symlink-replacement')).rejects.toBeInstanceOf(PathSecurityError);
  });

  it('detects state-root replacement before evidence preview', async () => {
    const fixture = await createRoot();
    const moved = join(fixture.base, 'original-state');
    await rename(fixture.statePath, moved);
    await mkdir(fixture.statePath);
    await expect(previewEvidencePath(fixture.stateRoot, 'job-1', '08-verify.json')).rejects.toBeInstanceOf(PathSecurityError);
  });

  it('keeps state evidence after staging moves to quarantine', async () => {
    const { registry, root, stateRoot, statePath } = await createRoot();
    const evidence = await previewEvidencePath(stateRoot, 'job-1', '08-verify.json');
    await mkdir(join(statePath, 'jobs', 'job-1', 'evidence'), { recursive: true });
    await writeFile(evidence.absolutePath, '{"ok":true}');
    const staging = await previewStagingPath(registry, root.id, 'job-1');
    const quarantine = await previewQuarantinePath(registry, root.id, 'job-1');
    await mkdir(staging.absolutePath, { recursive: true });
    await mkdir(join(root.path, '.osi-image-builder', 'quarantine'), { recursive: true });
    await rename(staging.absolutePath, quarantine.absolutePath);
    expect(await readFile(evidence.absolutePath, 'utf8')).toBe('{"ok":true}');
  });
});

describe('held no-follow read capabilities', () => {
  it('reads and hashes original bytes after directory and final-file swaps', async () => {
    const { root, base, registry } = await createRoot();
    const payload = join(root.path, 'payload');
    const outside = join(base, 'outside');
    await mkdir(payload);
    await mkdir(outside);
    const original = Buffer.from('original bytes');
    await writeFile(join(payload, 'evidence.bin'), original);
    await writeFile(join(outside, 'evidence.bin'), 'outside bytes');
    let retained: ReadCapability | undefined;
    const observed = await withNoFollowFileUnderRoot(registry, root.id, 'payload/evidence.bin', async (reader) => {
      retained = reader;
      await rename(join(payload, 'evidence.bin'), join(payload, 'replaced.bin'));
      await writeFile(join(payload, 'evidence.bin'), 'replacement bytes');
      await rename(payload, join(root.path, 'payload-original'));
      await symlink(outside, payload);
      const bytes = await reader.readFile();
      return { bytes, hash: await reader.hashSha256() };
    });
    expect(observed.bytes).toEqual(original);
    expect(observed.hash).toBe(createHash('sha256').update(original).digest('hex'));
    await expect(retained!.readFile()).rejects.toMatchObject({ code: 'CAPABILITY_EXPIRED' });
  });

  it('rejects same-size in-place mutation during readFile', async () => {
    let mutate!: (handle: FileHandle) => Promise<void>;
    const fixture = await createRoot({ beforeRead: async (handle) => mutate(handle) });
    await mkdir(join(fixture.root.path, 'payload'));
    const evidencePath = join(fixture.root.path, 'payload', 'evidence.bin');
    await writeFile(evidencePath, 'AAAA');
    mutate = async (handle) => {
      const writable = await open(`/proc/self/fd/${handle.fd}`, fsConstants.O_WRONLY);
      try { await writable.write(Buffer.from('BBBB'), 0, 4, 0); } finally { await writable.close(); }
    };
    await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async (reader) => reader.readFile())).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects same-size in-place mutation during hashSha256', async () => {
    let mutate!: (handle: FileHandle) => Promise<void>;
    const fixture = await createRoot({ beforeRead: async (handle) => mutate(handle) });
    await mkdir(join(fixture.root.path, 'payload'));
    const evidencePath = join(fixture.root.path, 'payload', 'evidence.bin');
    await writeFile(evidencePath, 'AAAA');
    mutate = async (handle) => {
      const writable = await open(`/proc/self/fd/${handle.fd}`, fsConstants.O_WRONLY);
      try { await writable.write(Buffer.from('BBBB'), 0, 4, 0); } finally { await writable.close(); }
    };
    await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async (reader) => reader.hashSha256())).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('normalizes root replacement through the public held-read API', async () => {
    const fixture = await createRoot();
    const moved = join(fixture.base, 'original-images');
    await rename(fixture.root.path, moved);
    await mkdir(fixture.root.path);
    await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async () => { throw new Error('callback ran'); })).rejects.toMatchObject({ code: 'INVALID_PATH', cause: expect.any(ConfigAuthorityError) });
  });

  it('exposes only bounded read/stat/hash methods and rejects symlink components', async () => {
    const { root, registry } = await createRoot();
    await mkdir(join(root.path, 'payload'));
    await writeFile(join(root.path, 'payload', 'evidence.bin'), 'before');
    let keys: string[] = [];
    const value = await withNoFollowFileUnderRoot(registry, root.id, 'payload/evidence.bin', async (reader) => {
      keys = Object.keys(reader);
      return { bytes: await reader.read(), stat: await reader.stat() };
    });
    expect(value.bytes).toEqual(Buffer.from('before'));
    expect(value.stat.links).toBe(1);
    expect(keys.sort()).toEqual(['hashSha256', 'read', 'readFile', 'stat']);
    expect(keys).not.toContain('fd');
    const linkPath = join(root.path, 'linked');
    await symlink(join(root.path, 'payload'), linkPath);
    await expect(withNoFollowFileUnderRoot(registry, root.id, 'linked/evidence.bin', async () => { throw new Error('callback ran'); })).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects nonregular targets before callback and does not block on FIFO or listening socket', async () => {
    const { root, registry } = await createRoot();
    const payload = join(root.path, 'payload');
    await mkdir(payload);
    await mkdir(join(payload, 'directory'));
    let callback = false;
    await expect(withNoFollowFileUnderRoot(registry, root.id, 'payload/directory', async () => { callback = true; })).rejects.toMatchObject({ code: 'NON_REGULAR_TARGET' });
    expect(callback).toBe(false);
    const probeFixture = await createRoot();
    await execFile('/usr/bin/git', ['init', '--quiet', probeFixture.repositoryPath]);
    await execFile('/usr/bin/git', ['-C', probeFixture.repositoryPath, 'config', 'remote.origin.url', 'git@github.com:Open-Smart-Irrigation/osi-os.git']);
    await mkdir(join(probeFixture.root.path, 'payload'));
    const fifo = join(probeFixture.root.path, 'payload', 'evidence.fifo');
    await execFile('/usr/bin/mkfifo', [fifo]);
    await expectChildProbe(probeFixture, 'payload/evidence.fifo', 'NON_REGULAR_TARGET');
    const socket = join(probeFixture.root.path, 'payload', 'evidence.sock');
    const server = createServer();
    await new Promise<void>((resolvePromise, rejectPromise) => { server.once('error', rejectPromise); server.listen(socket, resolvePromise); });
    try {
      await expectChildProbe(probeFixture, 'payload/evidence.sock', 'NON_REGULAR_TARGET');
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
    }
    expect(callback).toBe(false);
  });

  it('rejects hardlinked and cross-device final targets', async () => {
    const hardlinkFixture = await createRoot();
    await mkdir(join(hardlinkFixture.root.path, 'payload'));
    await writeFile(join(hardlinkFixture.root.path, 'payload', 'source.bin'), 'bytes');
    await link(join(hardlinkFixture.root.path, 'payload', 'source.bin'), join(hardlinkFixture.root.path, 'payload', 'evidence.bin'));
    await expect(withNoFollowFileUnderRoot(hardlinkFixture.registry, hardlinkFixture.root.id, 'payload/evidence.bin', async () => { throw new Error('callback ran'); })).rejects.toMatchObject({ code: 'HARDLINK_TARGET' });

    let statCalls = 0;
    const crossDevice = await createRoot({ stat: async (handle: FileHandle) => {
      const value = await handle.stat();
      statCalls += 1;
      if (statCalls === 5) Object.defineProperty(value, 'dev', { value: value.dev + 1 });
      return value;
    } });
    await mkdir(join(crossDevice.root.path, 'payload'));
    await writeFile(join(crossDevice.root.path, 'payload', 'evidence.bin'), 'bytes');
    await expect(withNoFollowFileUnderRoot(crossDevice.registry, crossDevice.root.id, 'payload/evidence.bin', async () => { throw new Error('callback ran'); })).rejects.toMatchObject({ code: 'MOUNT_CROSSING' });
  });

  it('rejects a same-device target that crosses a mount ID', async () => {
    let mountCalls = 0;
    const fixture = await createRoot({ mountId: async () => {
      mountCalls += 1;
      return mountCalls === 4 ? 22 : 11;
    } });
    await mkdir(join(fixture.root.path, 'payload'));
    await writeFile(join(fixture.root.path, 'payload', 'evidence.bin'), 'bytes');
    let callback = false;
    await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async () => { callback = true; })).rejects.toMatchObject({ code: 'MOUNT_CROSSING' });
    expect(callback).toBe(false);
    expect(mountCalls).toBeGreaterThanOrEqual(4);
  });

  it('attempts every close, preserves callback errors, and has no descriptor leak', async () => {
    const closed: number[] = [];
    const fixture = await createRoot({ close: async (handle: FileHandle) => { closed.push(handle.fd); await handle.close(); if (closed.length === 2) throw new Error('close failure'); } });
    await mkdir(join(fixture.root.path, 'payload'));
    await writeFile(join(fixture.root.path, 'payload', 'evidence.bin'), 'bytes');
    await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async () => { throw new Error('primary callback'); })).rejects.toMatchObject({ message: 'primary callback', cleanupErrors: [expect.any(Error)] });
    expect(new Set(closed).size).toBe(closed.length);

    let successfulCloseCalls = 0;
    const successfulFixture = await createRoot({ close: async (handle: FileHandle) => {
      successfulCloseCalls += 1;
      await handle.close();
      if (successfulCloseCalls === 1 || successfulCloseCalls === 3) throw new Error(`close-${successfulCloseCalls}`);
    } });
    await mkdir(join(successfulFixture.root.path, 'payload'));
    await writeFile(join(successfulFixture.root.path, 'payload', 'evidence.bin'), 'bytes');
    await expect(withNoFollowFileUnderRoot(successfulFixture.registry, successfulFixture.root.id, 'payload/evidence.bin', async (reader) => reader.readFile())).rejects.toMatchObject({ name: 'AggregateError' });
    expect(successfulCloseCalls).toBeGreaterThan(3);

    const descriptorSet = async () => new Set(await (await import('node:fs/promises')).readdir('/proc/self/fd'));
    const before = await descriptorSet();
    for (let index = 0; index < 15; index += 1) {
      await withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async (reader) => reader.readFile());
      await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async () => { throw new Error('callback failure'); })).rejects.toThrow('callback failure');
      await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/missing.bin', async () => { throw new Error('callback ran'); })).rejects.toBeInstanceOf(PathSecurityError);
    }
    expect(await descriptorSet()).toEqual(before);
  });

  it('fails closed when proc magic-link semantics are unavailable through per-authority deps', async () => {
    let closeCalls = 0;
    const fixture = await createRoot({
      readlink: async () => { throw new Error('proc unavailable'); },
      close: async (handle: FileHandle) => { closeCalls += 1; await handle.close(); },
    });
    await mkdir(join(fixture.root.path, 'payload'));
    await writeFile(join(fixture.root.path, 'payload', 'evidence.bin'), 'bytes');
    let callback = false;
    await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async () => { callback = true; })).rejects.toMatchObject({ code: 'PROC_UNAVAILABLE' });
    expect(callback).toBe(false);
    expect(closeCalls).toBeGreaterThan(0);

    let statCalls = 0;
    const nonDirectoryProc = await createRoot({
      stat: async (handle: FileHandle) => {
        const value = await handle.stat();
        statCalls += 1;
        if (statCalls === 2) Object.defineProperty(value, 'isDirectory', { value: () => false });
        return value;
      },
      close: async (handle: FileHandle) => { closeCalls += 1; await handle.close(); },
    });
    let nonDirectoryCallback = false;
    await expect(withNoFollowFileUnderRoot(nonDirectoryProc.registry, nonDirectoryProc.root.id, 'payload/evidence.bin', async () => { nonDirectoryCallback = true; })).rejects.toMatchObject({ code: 'PROC_UNAVAILABLE' });
    expect(nonDirectoryCallback).toBe(false);

    const malformedMount = await createRoot({ mountId: async () => { throw new Error('malformed fdinfo'); } });
    await mkdir(join(malformedMount.root.path, 'payload'));
    await writeFile(join(malformedMount.root.path, 'payload', 'evidence.bin'), 'bytes');
    let malformedCallback = false;
    await expect(withNoFollowFileUnderRoot(malformedMount.registry, malformedMount.root.id, 'payload/evidence.bin', async () => { malformedCallback = true; })).rejects.toMatchObject({ code: 'PROC_UNAVAILABLE' });
    expect(malformedCallback).toBe(false);
  });

  it('waits for started reads before closing and rejects new calls after scope exit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let fileStats = 0;
    const fixture = await createRoot({ stat: async (handle: FileHandle) => {
      const value = await handle.stat();
      if (value.isFile()) {
        fileStats += 1;
      }
      if (fileStats === 3) {
        await gate;
      }
      return value;
    } });
    await mkdir(join(fixture.root.path, 'payload'));
    await writeFile(join(fixture.root.path, 'payload', 'evidence.bin'), 'bytes');
    let retained!: ReadCapability;
    let operation!: Promise<Buffer>;
    const helper = withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async (reader) => {
      retained = reader;
      operation = reader.readFile();
    });
    await new Promise<void>((resolveNext) => setImmediate(resolveNext));
    release();
    await expect(helper).resolves.toBeUndefined();
    await expect(operation).resolves.toEqual(Buffer.from('bytes'));
    await expect(retained.readFile()).rejects.toMatchObject({ code: 'CAPABILITY_EXPIRED' });
  });

  it('rejects a truncated stable read instead of returning partial bytes', async () => {
    let shrink!: () => Promise<void>;
    const fixture = await createRoot({ beforeRead: async () => shrink() });
    await mkdir(join(fixture.root.path, 'payload'));
    const evidencePath = join(fixture.root.path, 'payload', 'evidence.bin');
    await writeFile(evidencePath, 'stable bytes');
    shrink = async () => { await (await import('node:fs/promises')).truncate(evidencePath, 2); };
    await expect(withNoFollowFileUnderRoot(fixture.registry, fixture.root.id, 'payload/evidence.bin', async (reader) => reader.readFile())).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
});

async function previewRootWithLink(registry: Parameters<typeof previewStagingPath>[0], rootId: string): Promise<unknown> {
  return previewStagingPath(registry, rootId, 'staging-link/job-1');
}

async function expectChildProbe(fixture: Awaited<ReturnType<typeof createRoot>>, relative: string, expectedCode: string): Promise<void> {
  const source = [
    "import { loadConfig } from './config/load.ts';",
    "import { withNoFollowFileUnderRoot } from './domain/paths.ts';",
    "const loaded = await loadConfig({ configPath: process.env.PROBE_CONFIG, env: { HOME: process.env.PROBE_HOME, XDG_CONFIG_HOME: process.env.PROBE_CONFIG_HOME, XDG_STATE_HOME: process.env.PROBE_STATE_HOME }, rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) } });",
    "let callback = false;",
    "try { await withNoFollowFileUnderRoot(loaded.pathAuthorities.approvedRoots, 'sdcard-images', process.env.PROBE_REL, async () => { callback = true; }); process.stdout.write('unexpected-success'); } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, callback })); }",
  ].join('\n');
  const result = await execFile(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROBE_CONFIG: fixture.configPath,
      PROBE_REL: relative,
      PROBE_HOME: fixture.base,
      PROBE_CONFIG_HOME: join(fixture.base, 'config-home'),
      PROBE_STATE_HOME: join(fixture.base, 'state-home'),
    },
    timeout: 1_500,
  });
  expect(result.stdout).toBe(JSON.stringify({ code: expectedCode, callback: false }));
}
