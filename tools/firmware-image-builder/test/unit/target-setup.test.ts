import { createHash } from 'node:crypto';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadManifest } from '../../manifest/validate.js';
import type { TargetManifest } from '../../manifest/schema.js';
import {
  ROOTFS_PADDING_PATCH,
  decideRootfsPatchState,
  resolveTargetSetup,
  type LockedTargetSetupOperations,
} from '../../runner/src/target-setup.js';
import type { CommandResult } from '../../runner/src/command-executor.js';

const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;
const targets = manifest.targets;
const rustFixture = new URL('../fixtures/openwrt-packages-d8cd30f4/lang/rust/Makefile', import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function result(argv: readonly string[], stdout = ''): CommandResult {
  return { argv, exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z' };
}

function configFor(target: TargetManifest): string {
  return `${target.configSymbols.map((symbol) => {
    if (symbol.type === 'bool') return `${symbol.name}=${symbol.value ? 'y' : 'n'}`;
    if (symbol.type === 'string') return `${symbol.name}="${symbol.value}"`;
    return `${symbol.name}=${symbol.value}`;
  }).join('\n')}\n`;
}

async function fixture(target = targets[0]!) {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'osi-target-setup-')));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'openwrt/.pc'), { recursive: true });
  await mkdir(join(root, 'openwrt/target/linux/bcm27xx/image'), { recursive: true });
  await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red'), { recursive: true });
  await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red-contrib-chirpstack'), { recursive: true });
  await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red-node-sqlite'), { recursive: true });
  await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack'), { recursive: true });
  await mkdir(join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712'), { recursive: true });
  await mkdir(join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709'), { recursive: true });
  await writeFile(join(root, 'feeds.conf.default'), `src-git packages https://git.openwrt.org/feed/packages.git^d8cd30f4e281d6853b3de134c4f147a807583e43\nsrc-link chirpstack feeds/chirpstack-openwrt-feed\n`);
  await writeFile(join(root, 'openwrt/feeds.conf.default'), 'stale\n');
  await writeFile(join(root, 'openwrt/.pc/applied-patches'), 'no-uart-console.patch\nboot-config.patch\nadd_designware_spi_kmod.patch\nimage-with-padded-rootfs.patch\n');
  await writeFile(join(root, 'openwrt/.pc/series'), 'no-uart-console.patch\nboot-config.patch\nadd_designware_spi_kmod.patch\nimage-with-padded-rootfs.patch\n');
  await writeFile(join(root, 'openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh'), [
    'ROOTFSSIZE="$(($4 / 512))"',
    'ROOTFSIMGSIZE="$((($(wc -c < $ROOTFS) + 511) / 512))"',
    'ROOTFSPADDINGSIZE="$(($ROOTFSSIZE - $ROOTFSIMGSIZE))"',
    'ROOTFSPADDINGOFFSET="$(($ROOTFSOFFSET + $ROOTFSIMGSIZE))"',
    'if [ "$ROOTFSPADDINGSIZE" -gt 2048 ]; then',
    '  ROOTFSPADDINGSIZE="2048"',
    'fi',
    'dd bs=512 if=/dev/zero of="$OUTPUT" seek="$ROOTFSPADDINGOFFSET" count="$ROOTFSPADDINGSIZE" conv=notrunc',
    '',
  ].join('\n'));
  await mkdir(join(root, 'openwrt/feeds/packages/lang/rust'), { recursive: true });
  await writeFile(join(root, 'openwrt/feeds/packages/lang/rust/Makefile'), await readFile(rustFixture));
  await writeFile(join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/.config'), configFor(targets[0]!));
  await writeFile(join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/.config'), configFor(targets[1]!));
  return { root, target, sourceFeed: await readFile(join(root, 'feeds.conf.default')), config: configFor(target) };
}

function operations(fixtureRoot: string, target: TargetManifest): { readonly runner: LockedTargetSetupOperations; readonly calls: string[] } {
  const calls: string[] = [];
  const runner: LockedTargetSetupOperations = {
    async run(operationId, definition) {
      calls.push(operationId);
      if (operationId === 'copy-feed-config') await writeFile(join(fixtureRoot, 'openwrt/feeds.conf.default'), await readFile(join(fixtureRoot, 'feeds.conf.default')));
      if (operationId === 'update-feeds') await mkdir(join(fixtureRoot, 'openwrt/package/feeds/chirpstack'), { recursive: true });
      if (operationId === 'install-feeds') {
        const parent = join(fixtureRoot, 'openwrt/package/feeds/chirpstack');
        for (const packageName of ['node-red', 'node-red-contrib-chirpstack', 'node-red-node-sqlite', 'chirpstack']) {
          const targetPath = packageName === 'chirpstack'
            ? join(fixtureRoot, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack')
            : join(fixtureRoot, 'feeds/chirpstack-openwrt-feed/apps', packageName);
          await symlink(relative(parent, targetPath), join(parent, packageName));
        }
      }
      if (operationId === 'resolve-config') await writeFile(join(fixtureRoot, 'openwrt/.config'), configFor(target));
      expect(definition.argv.length).toBeGreaterThan(0);
      return result(definition.argv);
    },
  };
  return { runner, calls };
}

describe('target setup', () => {
  it('runs only registered locked operations in safe order and records feed/config hashes', async () => {
    const fixtureValue = await fixture();
    const { runner, calls } = operations(fixtureValue.root, fixtureValue.target);
    const setup = await resolveTargetSetup({ worktreePath: fixtureValue.root, target: fixtureValue.target, targets, operations: runner, requestId: 'req-target' });

    expect(calls).toEqual(['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config']);
    expect(setup.patchDecision).toBe('applied');
    expect(setup.feed.sourceSha256).toBe(createHash('sha256').update(fixtureValue.sourceFeed).digest('hex'));
    expect(setup.feed.destinationSha256).toBe(setup.feed.sourceSha256);
    expect(setup.feed.localPath).toBe(join(fixtureValue.root, 'feeds/chirpstack-openwrt-feed'));
    expect(setup.config.selectedTarget).toBe('bcm27xx/bcm2712');
    expect(setup.config.profile).toBe('DEVICE_rpi-5');
    expect(setup.config.rootfsPartSize).toBe(14336);
    expect(setup.config.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(setup.config.resolvedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readlink(join(fixtureValue.root, 'openwrt/package/feeds/chirpstack/node-red'))).toContain('node-red');
  });

  it('rejects invalid environment before invoking or mutating an operation', async () => {
    const fixtureValue = await fixture();
    const calls: string[] = [];
    await expect(resolveTargetSetup({
      worktreePath: fixtureValue.root,
      target: { ...fixtureValue.target, environment: 'bad;touch' },
      targets,
      operations: { async run(operationId) { calls.push(operationId); return result([]); } },
      requestId: 'req-invalid-env',
    })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('accepts only the named reverse-applicable rootfs patch with a complete stack', () => {
    const base = { series: ['a.patch', ROOTFS_PADDING_PATCH], applied: ['a.patch'], output: `Reversed (or previously applied) patch detected: ${ROOTFS_PADDING_PATCH}`, rootfsScript: 'ROOTFSSIZE="$(($4 / 512))"\nROOTFSIMGSIZE="$((($(wc -c < $ROOTFS) + 511) / 512))"\nROOTFSPADDINGSIZE="$(($ROOTFSSIZE - $ROOTFSIMGSIZE))"\nROOTFSPADDINGOFFSET="$(($ROOTFSOFFSET + $ROOTFSIMGSIZE))"\nif [ "$ROOTFSPADDINGSIZE" -gt 2048 ]; then\nROOTFSPADDINGSIZE="2048"\ndd bs=512 if=/dev/zero of="$OUTPUT" seek="$ROOTFSPADDINGOFFSET" count="$ROOTFSPADDINGSIZE" conv=notrunc' };
    expect(decideRootfsPatchState(base)).toEqual('already-present');
    expect(() => decideRootfsPatchState({ ...base, output: 'Reversed (or previously applied) patch detected: other.patch' })).toThrow();
    expect(() => decideRootfsPatchState({ ...base, applied: [] })).toThrow();
    expect(() => decideRootfsPatchState({ ...base, rootfsScript: 'missing' })).toThrow();
  });

  it('fails closed on a changed pinned Rust feed before update/install', async () => {
    const fixtureValue = await fixture();
    await writeFile(join(fixtureValue.root, 'openwrt/feeds/packages/lang/rust/Makefile'), 'changed\n');
    const { runner, calls } = operations(fixtureValue.root, fixtureValue.target);
    await expect(resolveTargetSetup({ worktreePath: fixtureValue.root, target: fixtureValue.target, targets, operations: runner, requestId: 'req-rust' })).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    expect(calls).toEqual(['activate-target', 'copy-feed-config']);
  });

  it('rejects a missing installed package link and a mismatched typed config', async () => {
    const fixtureValue = await fixture();
    const base = operations(fixtureValue.root, fixtureValue.target).runner;
    const runner: LockedTargetSetupOperations = {
      async run(operationId, definition) {
        if (operationId === 'install-feeds') return result(definition.argv);
        return base.run(operationId, definition);
      },
    };
    await expect(resolveTargetSetup({ worktreePath: fixtureValue.root, target: fixtureValue.target, targets, operations: runner, requestId: 'req-config' })).rejects.toMatchObject({ code: expect.stringMatching(/FEED_LINKS_MISSING|TARGET_CONFIG_MISMATCH/u) });
  });
});
