import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertHeldAuthoritiesDisjoint,
  holdDirectoryAuthority,
} from '../../shared/held-directory-authority.mjs';

const temporaryDirectories: string[] = [];
const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(homedir(), '.osi-held-directory-'));
  temporaryDirectories.push(root);
  await chmod(root, 0o700);
  return root;
}

describe('held directory authority', () => {
  it('creates missing components beneath held parents and exposes only the final held FD', async () => {
    const root = await createRoot();
    const path = join(root, 'config', 'osi-image-builder');
    const authority = await holdDirectoryAuthority(path, { ownerUid, allowMissing: true });
    try {
      expect(authority.exists).toBe(false);
      expect(authority.executionPath).toBeUndefined();
      expect(authority.unresolvedSuffix).toEqual(['config', 'osi-image-builder']);

      await authority.ensure();

      expect(authority.exists).toBe(true);
      expect(authority.unresolvedSuffix).toEqual([]);
      expect(await realpath(authority.executionPath as string)).toBe(path);
      expect(authority.identityChain.at(-1)).toMatchObject({ path, final: true });
      expect((await lstat(path)).mode & 0o7777).toBe(0o700);
      await authority.revalidate();
    } finally {
      await authority.close();
    }
  });

  it('refuses a symlink in a missing-target descendant chain without creating later components', async () => {
    const root = await createRoot();
    const external = join(root, 'external');
    const linked = join(root, 'linked');
    await mkdir(external, { mode: 0o700 });
    await symlink(external, linked);

    await expect(holdDirectoryAuthority(join(linked, 'osi-image-builder'), {
      ownerUid,
      allowMissing: true,
    })).rejects.toThrow();
    await expect(lstat(join(external, 'osi-image-builder'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects replacement of a held component', async () => {
    const root = await createRoot();
    const path = join(root, 'state');
    const moved = `${path}-moved`;
    await mkdir(path, { mode: 0o700 });
    const authority = await holdDirectoryAuthority(path, { ownerUid });
    try {
      await rename(path, moved);
      await mkdir(path, { mode: 0o700 });
      await expect(authority.revalidate()).rejects.toThrow(/identity|pathname|changed/u);
    } finally {
      await authority.close();
    }
  });

  it('rejects lexical and physical ancestor overlap using held identity chains', async () => {
    const root = await createRoot();
    const leftPath = join(root, 'left');
    const rightPath = join(root, 'right');
    await mkdir(leftPath, { mode: 0o700 });
    await mkdir(rightPath, { mode: 0o700 });
    const left = await holdDirectoryAuthority(leftPath, { ownerUid });
    const right = await holdDirectoryAuthority(rightPath, { ownerUid });
    try {
      expect(() => assertHeldAuthoritiesDisjoint([
        { name: 'left', path: leftPath, authority: left },
        { name: 'right', path: rightPath, authority: right },
      ])).not.toThrow();
      expect(() => assertHeldAuthoritiesDisjoint([
        { name: 'left', path: leftPath, authority: left },
        { name: 'nested', path: join(leftPath, 'nested'), authority: left },
      ])).toThrow(/overlap/u);

      const leftFinal = left.identityChain.at(-1);
      if (leftFinal === undefined) throw new Error('left authority identity is missing');
      const physicalAlias = {
        exists: true,
        unresolvedSuffix: [],
        identityChain: [
          ...right.identityChain.slice(0, -1),
          { ...leftFinal, path: rightPath, final: true },
        ],
      };
      expect(() => assertHeldAuthoritiesDisjoint([
        { name: 'left', path: leftPath, authority: left },
        { name: 'alias', path: rightPath, authority: physicalAlias },
      ])).toThrow(/physical overlap/u);
    } finally {
      await left.close();
      await right.close();
    }
  });

  it.each([
    ['same', ['missing'], ['missing']],
    ['ancestor', ['missing'], ['missing', 'child']],
  ])('rejects physically aliased missing roots with %s unresolved suffix overlap', (_label, leftSuffix, rightSuffix) => {
    const authority = (basePath: string, path: string, unresolvedSuffix: string[]) => ({
      exists: false,
      unresolvedSuffix,
      identityChain: [{
        path: basePath,
        dev: 11n,
        ino: 22n,
        final: false,
      }],
      path,
    });

    expect(() => assertHeldAuthoritiesDisjoint([
      {
        name: 'left',
        path: `/srv/left/${leftSuffix.join('/')}`,
        authority: authority('/srv/left', `/srv/left/${leftSuffix.join('/')}`, leftSuffix),
      },
      {
        name: 'right',
        path: `/srv/right/${rightSuffix.join('/')}`,
        authority: authority('/srv/right', `/srv/right/${rightSuffix.join('/')}`, rightSuffix),
      },
    ])).toThrow(/physical overlap/u);
  });

  it('keeps physically aliased missing roots with disjoint suffixes separate', () => {
    const authority = (basePath: string, path: string, suffix: string[]) => ({
      exists: false,
      unresolvedSuffix: suffix,
      identityChain: [{
        path: basePath,
        dev: 11n,
        ino: 22n,
        final: false,
      }],
    });

    expect(() => assertHeldAuthoritiesDisjoint([
      {
        name: 'left',
        path: '/srv/left/one',
        authority: authority('/srv/left', '/srv/left/one', ['one']),
      },
      {
        name: 'right',
        path: '/srv/right/two',
        authority: authority('/srv/right', '/srv/right/two', ['two']),
      },
    ])).not.toThrow();
  });
});
