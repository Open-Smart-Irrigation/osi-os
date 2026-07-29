import { chmod, link, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  InstalledLockReadError,
  createInstalledLockReader,
  type InstalledLockReaderOptions,
} from '../../domain/installed-lock.js';

const roots: string[] = [];
const LOCK_TEXT = '{"installable":true,"packageVersion":"2026.07.29.1"}\n';
const OWNER_UID = typeof process.geteuid === 'function' ? process.geteuid() : 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installation(lockText = LOCK_TEXT): Promise<{ readonly root: string; readonly lock: string }> {
  const base = await mkdtemp(join(tmpdir(), 'osi-image-builder-installed-lock-'));
  roots.push(base);
  const root = join(base, '2026.07.29.1');
  const lock = join(root, 'builder.lock.json');
  await mkdir(root, { mode: 0o700 });
  await writeFile(lock, lockText, { mode: 0o600 });
  await chmod(root, 0o700);
  await chmod(lock, 0o600);
  return { root, lock };
}

function expectCode(operation: Promise<unknown>, code: InstalledLockReadError['code']): Promise<void> {
  return expect(operation).rejects.toMatchObject({ name: 'InstalledLockReadError', code });
}

function testReader(options: InstalledLockReaderOptions = {}) {
  return createInstalledLockReader({ ownerUid: OWNER_UID, ...options });
}

describe('installed builder lock reader', () => {
  it('reads canonical lock bytes and returns stable parent and file identities', async () => {
    const fixture = await installation();

    const result = await testReader().read(fixture.root);

    expect(result.bytes).toEqual(Buffer.from(LOCK_TEXT));
    expect(result.text).toBe(LOCK_TEXT);
    expect(result.identity.installationDirectory).toBe(fixture.root);
    expect(result.identity.lockPath).toBe(fixture.lock);
    expect(result.identity.parent.dev).toBe(result.identity.file.dev);
    expect(result.identity.parent.ino).not.toBe(result.identity.file.ino);
    expect(result.identity.file.mode).toBe(0o600);
    expect(result.identity.file.nlink).toBe(1);
    expect(result.identity.file.uid).toBe(OWNER_UID);
    expect(result.identity.file.size).toBe(Buffer.byteLength(LOCK_TEXT));
    expect(result.identity.file.mtimeNs).toMatch(/^\d+$/u);
    expect(result.identity.file.ctimeNs).toMatch(/^\d+$/u);
  });

  it('rejects a lock with mode 0644', async () => {
    const fixture = await installation();
    await chmod(fixture.lock, 0o644);

    await expectCode(testReader().read(fixture.root), 'LOCK_UNSAFE');
  });

  it('rejects a lock whose owner does not match the injected owner', async () => {
    const fixture = await installation();

    await expectCode(createInstalledLockReader({ ownerUid: OWNER_UID + 1 }).read(fixture.root), 'OWNER_MISMATCH');
  });

  it('rejects a hard-linked lock', async () => {
    const fixture = await installation();
    await link(fixture.lock, join(fixture.root, 'builder.lock.copy'));

    await expectCode(testReader().read(fixture.root), 'LOCK_UNSAFE');
  });

  it('rejects a symlink at the lock pathname without following it', async () => {
    const fixture = await installation();
    await rm(fixture.lock);
    await symlink('/etc/passwd', fixture.lock);

    await expectCode(testReader().read(fixture.root), 'PATH_UNSAFE');
  });

  it('rejects a directory pathname swap after the parent descriptor is held', async () => {
    const fixture = await installation();
    const moved = join(join(fixture.root, '..'), 'moved-installation');

    await expectCode(testReader({
      hooks: {
        afterOpenDirectory: async () => {
          await rename(fixture.root, moved);
          await mkdir(fixture.root, { mode: 0o700 });
        },
      },
    }).read(fixture.root), 'RACE_DETECTED');
  });

  it('rejects a lock replacement while the original descriptor is held', async () => {
    const fixture = await installation();
    const replacement = join(fixture.root, 'builder.lock.replacement');

    await expectCode(testReader({
      hooks: {
        beforePostRead: async () => {
          await rename(fixture.lock, replacement);
          await writeFile(fixture.lock, LOCK_TEXT, { mode: 0o600 });
          await chmod(fixture.lock, 0o600);
        },
      },
    }).read(fixture.root), 'RACE_DETECTED');
  });

  it('rejects a lock larger than the configured bound before allocation', async () => {
    const fixture = await installation(`${'{"value":"'}${'x'.repeat(128)}"}\n`);

    await expectCode(testReader({ maxBytes: 32 }).read(fixture.root), 'SIZE_INVALID');
  });

  it('rejects non-canonical JSON while accepting the installer newline form', async () => {
    const fixture = await installation('{ "packageVersion": "2026.07.29.1", "installable": true }\n');

    await expectCode(testReader().read(fixture.root), 'JSON_INVALID');
  });

  it('rejects a lock whose device cannot match the held parent when a cross-device fixture exists', async () => {
    const sharedMemory = '/dev/shm';
    let sharedMemoryStats;
    try {
      sharedMemoryStats = await lstat(sharedMemory);
    } catch {
      return;
    }
    const fixture = await installation();
    const parentStats = await lstat(fixture.root);
    if (sharedMemoryStats.dev === parentStats.dev) return;

    await rm(fixture.lock);
    await symlink(join(sharedMemory, 'builder-lock-cross-device-target'), fixture.lock);
    await expectCode(testReader().read(fixture.root), 'PATH_UNSAFE');
  });

  it('uses no-follow directory opening for a selected installation symlink', async () => {
    const fixture = await installation();
    const selected = join(join(fixture.root, '..'), 'selected-installation');
    await symlink(fixture.root, selected);

    await expectCode(testReader().read(selected), 'PATH_UNSAFE');
  });

  it('reports a bounded configuration error instead of weakening the byte limit', async () => {
    expect(() => createInstalledLockReader({ ownerUid: OWNER_UID, maxBytes: 65_537 })).toThrow(/maxBytes/u);
  });
});
