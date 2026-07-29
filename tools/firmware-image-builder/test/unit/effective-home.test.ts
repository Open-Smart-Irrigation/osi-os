import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, stat, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import * as effectiveHome from '../../shared/effective-home.mjs';

const temporaryDirectories: string[] = [];
const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await chmod(path, 0o700).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }));
});

async function createHome(): Promise<string> {
  const root = await mkdtemp(join(homedir(), '.osi-effective-home-'));
  temporaryDirectories.push(root);
  const home = join(root, 'service-home');
  await mkdir(home, { mode: 0o700 });
  return home;
}

function passwdLine(home: string, uid = ownerUid): string {
  return `service:x:${uid}:${uid}:service:${home}:/bin/false\n`;
}

describe('effective-user passwd home resolver', () => {
  it('holds the validated home descriptor chain for the complete callback', async () => {
    const home = await createHome();

    await expect(effectiveHome.withEffectiveHomeAuthority({
      ownerUid,
      lookupPasswd: async () => passwdLine(home),
    }, async (authority) => {
      expect(authority.path).toBe(home);
      expect((await stat(authority.executionPath)).isDirectory()).toBe(true);
      await execFile('/usr/bin/test', ['-d', authority.executionPath]);
      return authority.path;
    })).resolves.toBe(home);
  });

  it('rejects a home below an ancestor owned by neither root nor the effective UID', async () => {
    const root = await mkdtemp(join(homedir(), '.osi-unsafe-effective-home-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o700);
    const home = join(root, 'service-home');
    await mkdir(home, { mode: 0o700 });
    const otherUid = ownerUid + 1;

    await expect(effectiveHome.withEffectiveHomeAuthority({
      ownerUid: otherUid,
      lookupPasswd: async () => passwdLine(home, otherUid),
    }, async () => home)).rejects.toThrow(/ancestor ownership or mode is unsafe/u);
  });

  it('rejects an effective-UID-owned group-writable ancestor', async () => {
    const root = await mkdtemp(join(homedir(), '.osi-group-writable-effective-home-'));
    temporaryDirectories.push(root);
    await chmod(root, 0o770);
    const home = join(root, 'service-home');
    await mkdir(home, { mode: 0o700 });

    await expect(effectiveHome.withEffectiveHomeAuthority({
      ownerUid,
      lookupPasswd: async () => passwdLine(home),
    }, async () => home)).rejects.toThrow(/ancestor ownership or mode is unsafe/u);
  });

  it('accepts a root-owned sticky ancestor and same-UID-owned parents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-sticky-effective-home-'));
    temporaryDirectories.push(root);
    const home = join(root, 'service-home');
    await mkdir(home, { mode: 0o700 });

    await expect(effectiveHome.withEffectiveHomeAuthority({
      ownerUid,
      lookupPasswd: async () => passwdLine(home),
    }, async (authority) => authority.path)).resolves.toBe(home);
  });

  it('rejects replacement of the passwd home pathname during the held operation', async () => {
    const home = await createHome();
    const moved = `${home}-moved`;

    await expect(effectiveHome.withEffectiveHomeAuthority({
      ownerUid,
      lookupPasswd: async () => passwdLine(home),
    }, async () => {
      await rename(home, moved);
      await mkdir(home, { mode: 0o700 });
    })).rejects.toThrow(/pathname identity changed/u);
  });

  it('returns a canonical, held, effective-user-owned home from exact passwd evidence', async () => {
    const home = await createHome();

    await expect(effectiveHome.resolveEffectiveHome({
      ownerUid,
      lookupPasswd: async () => passwdLine(home),
    })).resolves.toBe(home);
  });

  it.each([
    ['missing line terminator', (home: string) => passwdLine(home).slice(0, -1)],
    ['multiple lines', (home: string) => `${passwdLine(home)}duplicate\n`],
    ['wrong UID', (home: string) => passwdLine(home, ownerUid + 1)],
    ['noncanonical home', (home: string) => passwdLine(`${home}/../service-home`)],
    ['oversized evidence', (home: string) => `${passwdLine(home).slice(0, -1)}${'x'.repeat(8 * 1024)}\n`],
  ])('rejects %s passwd evidence', async (_name, evidence) => {
    const home = await createHome();

    await expect(effectiveHome.resolveEffectiveHome({
      ownerUid,
      lookupPasswd: async () => evidence(home),
    })).rejects.toThrow();
  });

  it('rejects a home not owned by the supplied effective UID', async () => {
    const otherUid = ownerUid + 1;

    await expect(effectiveHome.resolveEffectiveHome({
      ownerUid: otherUid,
      lookupPasswd: async () => passwdLine('/', otherUid),
    })).rejects.toThrow(/owner or mode is unsafe/u);
  });

  it('rejects a group-writable home', async () => {
    const home = await createHome();
    await chmod(home, 0o720);

    await expect(effectiveHome.resolveEffectiveHome({
      ownerUid,
      lookupPasswd: async () => passwdLine(home),
    })).rejects.toThrow(/owner or mode is unsafe/u);
  });

  it('rejects a symlinked home without following it', async () => {
    const home = await createHome();
    const link = join(home, '..', 'linked-home');
    await symlink(home, link);

    await expect(effectiveHome.resolveEffectiveHome({
      ownerUid,
      lookupPasswd: async () => passwdLine(link),
    })).rejects.toThrow();
  });

  it('fails a successful callback when held descriptor cleanup fails', async () => {
    const home = await createHome();
    const closeHandle = async (handle: { close: () => Promise<void> }): Promise<void> => {
      await handle.close();
      throw new Error('injected effective-home close failure');
    };

    await expect(effectiveHome.withEffectiveHomeAuthority({
      ownerUid,
      lookupPasswd: async () => passwdLine(home),
      closeHandle,
    }, async () => home)).rejects.toMatchObject({ name: 'AggregateError' });
  });

  it('preserves callback and descriptor cleanup failures together', async () => {
    const home = await createHome();
    const closeHandle = async (handle: { close: () => Promise<void> }): Promise<void> => {
      await handle.close();
      throw new Error('injected effective-home close failure');
    };

    let failure: unknown;
    try {
      await effectiveHome.withEffectiveHomeAuthority({
        ownerUid,
        lookupPasswd: async () => passwdLine(home),
        closeHandle,
      }, async () => {
        throw new Error('injected effective-home operation failure');
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: 'AggregateError' });
    expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'injected effective-home operation failure' }),
      expect.objectContaining({ message: expect.stringContaining('descriptors could not be closed') }),
    ]));
  });

  it('preserves acquisition and descriptor cleanup failures together', async () => {
    const home = await createHome();
    const link = join(home, '..', 'effective-home-acquisition-link');
    await symlink(home, link);
    const closeHandle = async (handle: { close: () => Promise<void> }): Promise<void> => {
      await handle.close();
      throw new Error('injected effective-home close failure');
    };

    await expect(effectiveHome.withEffectiveHomeAuthority({
      ownerUid,
      lookupPasswd: async () => passwdLine(link),
      closeHandle,
    }, async () => link)).rejects.toMatchObject({ name: 'AggregateError' });
  });
});
