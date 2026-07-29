import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  defaultProbe: vi.fn(async () => ({
    available: false as const,
    code: 'DEFAULT_PROBE_STOP',
    detail: 'stop before production build',
    mutation: 'none' as const,
  })),
}));

vi.mock('../../installer/probes.js', () => ({
  runNativePrerequisiteProbes: mocks.defaultProbe,
}));

import { installProductionVersion } from '../../installer/production.js';
import { withEffectiveHomeAuthority } from '../../shared/effective-home.mjs';

const temporaryDirectories: string[] = [];
const ownerUid = process.geteuid?.() ?? process.getuid?.() ?? 0;

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTrustedHome(): Promise<Readonly<{
  root: string;
  home: string;
  effectiveHomeOptions: Readonly<{
    ownerUid: number;
    lookupPasswd: (uid: number) => Promise<string>;
  }>;
}>> {
  const root = await mkdtemp(join(homedir(), '.osi-production-home-'));
  temporaryDirectories.push(root);
  const home = join(root, 'service-home');
  await mkdir(home, { mode: 0o700 });
  return Object.freeze({
    root,
    home,
    effectiveHomeOptions: Object.freeze({
      ownerUid,
      lookupPasswd: async (uid: number) => `service:x:${uid}:${uid}:service:${home}:/bin/false\n`,
    }),
  });
}

describe('production installer effective home', () => {
  it('acquires the global install lock through the held parent before ensuring installRoot', async () => {
    const source = await readFile(new URL('../../installer/production.ts', import.meta.url), 'utf8');
    const ensureParent = source.indexOf('await installParentAuthority.ensure()');
    const parentLock = source.indexOf('join(installParentExecutionRoot, INSTALL_LOCK_NAME)');
    const ensureInstall = source.indexOf('await installAuthority.ensure()');

    expect(ensureParent).toBeGreaterThan(-1);
    expect(parentLock).toBeGreaterThan(ensureParent);
    expect(ensureInstall).toBeGreaterThan(parentLock);
    expect(source).not.toContain('join(installExecutionRoot, INSTALL_LOCK_NAME)');
  });

  it('ignores poisoned HOME and passes the effective passwd home to prerequisite probing', async () => {
    const fixture = await createTrustedHome();
    const { root, home: trustedHome } = fixture;
    const observed: string[] = [];
    const previousHome = process.env.HOME;
    let authorityHeld = false;
    process.env.HOME = join(root, 'attacker-home');
    try {
      const result = await installProductionVersion({
        effectiveHomeOptions: fixture.effectiveHomeOptions,
        withEffectiveHomeAuthority: async (options, callback) => withEffectiveHomeAuthority(
          options,
          async (authority) => {
            authorityHeld = true;
            try {
              return await callback(authority);
            } finally {
              authorityHeld = false;
            }
          },
        ),
        probePrerequisites: async ({ scratchParent }: { readonly scratchParent: string }) => {
          expect(authorityHeld).toBe(true);
          expect(scratchParent).toMatch(/^\/proc\/\d+\/fd\/\d+$/u);
          expect(await realpath(scratchParent)).toBe(trustedHome);
          observed.push(scratchParent);
          return {
            available: false,
            code: 'INJECTED_PROBE_STOP',
            detail: 'stop before production build',
            mutation: 'none',
          };
        },
      });

      expect(result).toMatchObject({ available: false, code: 'INJECTED_PROBE_STOP' });
      expect(observed).toHaveLength(1);
      expect(mocks.defaultProbe).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it.each(['.local', 'lib'] as const)(
    'rejects an in-home %s symlink before prerequisite probing or installation mutation',
    async (component) => {
      const fixture = await createTrustedHome();
      const external = join(fixture.root, `external-${component.replace('.', '')}`);
      await mkdir(external, { mode: 0o700 });
      if (component === '.local') {
        await symlink(external, join(fixture.home, '.local'));
      } else {
        await mkdir(join(fixture.home, '.local'), { mode: 0o700 });
        await symlink(external, join(fixture.home, '.local', 'lib'));
      }
      const probePrerequisites = vi.fn(async () => ({
        available: false as const,
        code: 'PROBE_MUST_NOT_RUN',
        detail: 'descendant authority should reject first',
        mutation: 'none' as const,
      }));

      await expect(installProductionVersion({
        effectiveHomeOptions: fixture.effectiveHomeOptions,
        probePrerequisites,
      })).rejects.toThrow();

      expect(probePrerequisites).not.toHaveBeenCalled();
      await expect(lstat(join(external, 'osi-image-builder'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(fixture.home, '.local', 'lib', 'osi-image-builder', 'selected.json')))
        .rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|ENOENT/u) });
    },
  );

  it('detects install-root replacement by an unavailable probe without writing either pathname', async () => {
    const fixture = await createTrustedHome();
    const installRoot = join(fixture.home, '.local', 'lib', 'osi-image-builder');
    const movedInstallRoot = `${installRoot}-moved`;
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    await chmod(join(fixture.home, '.local'), 0o700);
    await chmod(join(fixture.home, '.local', 'lib'), 0o700);
    await chmod(installRoot, 0o700);
    const probePrerequisites = vi.fn(async () => {
      await rename(installRoot, movedInstallRoot);
      await mkdir(installRoot, { mode: 0o700 });
      return {
        available: false as const,
        code: 'INJECTED_PROBE_STOP',
        detail: 'stop after replacing install root',
        mutation: 'none' as const,
      };
    });

    await expect(installProductionVersion({
      effectiveHomeOptions: fixture.effectiveHomeOptions,
      probePrerequisites,
    })).rejects.toThrow(/identity|pathname|changed/u);

    expect(probePrerequisites).toHaveBeenCalledOnce();
    for (const root of [installRoot, movedInstallRoot]) {
      await expect(lstat(join(root, 'selected.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(root, '0.1.0'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
