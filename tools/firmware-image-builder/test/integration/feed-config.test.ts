import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadManifest } from '../../manifest/validate.js';
import { resolveTargetSetup, type LockedTargetSetupOperations } from '../../runner/src/target-setup.js';
import type { CommandResult } from '../../runner/src/command-executor.js';

const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function ok(argv: readonly string[]): CommandResult {
  return { argv, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, startedAt: '2026-07-26T10:00:00.000Z', finishedAt: '2026-07-26T10:00:01.000Z' };
}

describe('feed configuration integration boundary', () => {
  it('uses fixture operations only, copies the pinned file immediately, and resolves the local feed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-feed-config-'));
    temporaryDirectories.push(root);
    const target = manifest.targets[1]!;
    await mkdir(join(root, 'openwrt/.pc'), { recursive: true });
    await mkdir(join(root, 'openwrt/target/linux/bcm27xx/image'), { recursive: true });
    await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red'), { recursive: true });
    await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red-contrib-chirpstack'), { recursive: true });
    await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red-node-sqlite'), { recursive: true });
    await mkdir(join(root, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack'), { recursive: true });
    await mkdir(join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712'), { recursive: true });
    await mkdir(join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709'), { recursive: true });
    await writeFile(join(root, 'feeds.conf.default'), 'src-git packages https://git.openwrt.org/feed/packages.git^d8cd30f4e281d6853b3de134c4f147a807583e43\nsrc-link chirpstack feeds/chirpstack-openwrt-feed\n');
    await writeFile(join(root, 'openwrt/.pc/series'), 'image-with-padded-rootfs.patch\n');
    await writeFile(join(root, 'openwrt/.pc/applied-patches'), 'image-with-padded-rootfs.patch\n');
    await writeFile(join(root, 'openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh'), 'ROOTFSSIZE="$(($4 / 512))"\nROOTFSIMGSIZE="$((($(wc -c < $ROOTFS) + 511) / 512))"\nROOTFSPADDINGSIZE="$(($ROOTFSSIZE - $ROOTFSIMGSIZE))"\nROOTFSPADDINGOFFSET="$(($ROOTFSOFFSET + $ROOTFSIMGSIZE))"\nif [ "$ROOTFSPADDINGSIZE" -gt 2048 ]; then\nROOTFSPADDINGSIZE="2048"\ndd bs=512 if=/dev/zero of="$OUTPUT" seek="$ROOTFSPADDINGOFFSET" count="$ROOTFSPADDINGSIZE" conv=notrunc\n');
    await mkdir(join(root, 'openwrt/feeds/packages/lang/rust'), { recursive: true });
    await writeFile(join(root, 'openwrt/feeds/packages/lang/rust/Makefile'), await readFile(new URL('../fixtures/openwrt-packages-d8cd30f4/lang/rust/Makefile', import.meta.url)));
    for (const profile of manifest.targets) await writeFile(join(root, 'conf', profile.environment, '.config'), `${profile.configSymbols.map((symbol) => symbol.type === 'bool' ? `${symbol.name}=y` : symbol.type === 'string' ? `${symbol.name}="${symbol.value}"` : `${symbol.name}=${symbol.value}`).join('\n')}\n`);
    const operations: LockedTargetSetupOperations = {
      async run(operationId, definition) {
        if (operationId === 'copy-feed-config') await writeFile(join(root, 'openwrt/feeds.conf.default'), await readFile(join(root, 'feeds.conf.default')));
        if (operationId === 'update-feeds') await mkdir(join(root, 'openwrt/package/feeds/chirpstack'), { recursive: true });
        if (operationId === 'install-feeds') {
          const parent = join(root, 'openwrt/package/feeds/chirpstack');
          for (const name of ['node-red', 'node-red-contrib-chirpstack', 'node-red-node-sqlite', 'chirpstack']) {
            const targetPath = name === 'chirpstack' ? join(root, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack') : join(root, 'feeds/chirpstack-openwrt-feed/apps', name);
            await symlink(targetPath, join(parent, name));
          }
        }
        if (operationId === 'resolve-config') await writeFile(join(root, 'openwrt/.config'), await readFile(join(root, 'conf', target.environment, '.config')));
        return ok(definition.argv);
      },
    };
    const setup = await resolveTargetSetup({ worktreePath: root, target, targets: manifest.targets, operations, requestId: 'req-feed-integration' });
    expect(setup.feed.localPath).toBe(join(root, 'feeds/chirpstack-openwrt-feed'));
    expect(setup.feed.sourceSha256).toBe(setup.feed.destinationSha256);
    expect(setup.rust.enforcedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(setup.config.profile).toBe('DEVICE_rpi-2');
  });
});
