import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOperationDefinition } from '../../runner/src/operation-registry.js';
import {
  CANONICAL_MAIN_APPLIED_PATCHES,
  CANONICAL_MAIN_QUILT_FILES,
  decideCanonicalRootfsPatchState,
} from '../../runner/src/target-setup.js';
// @ts-expect-error The immutable builder operation is JavaScript by design.
import { createOperationHandlersForTesting } from '../../builder/operations/osi-image-builder-tool.js';

const temporaryRoots: string[] = [];
const PI5_ENV = 'full_raspberrypi_bcm27xx_bcm2712';
const PI4_ENV = 'full_raspberrypi_bcm27xx_bcm2709';
const APPROVED_ROOTFS_PATH = new URL(
  '../../../../openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh',
  import.meta.url,
).pathname;
const MAIN_STATE_FIXTURE = new URL('../fixtures/target-setup/main-prepatched/', import.meta.url).pathname;

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function canonicalWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'osi-target-activation-'));
  temporaryRoots.push(root);
  const approvedRootfs = await readFile(APPROVED_ROOTFS_PATH, 'utf8');
  await mkdir(join(root, 'conf', PI5_ENV, 'files'), { recursive: true });
  await mkdir(join(root, 'conf', PI5_ENV, 'patches'), { recursive: true });
  await writeFile(join(root, 'conf', PI5_ENV, '.config'), 'CONFIG_TARGET_PROFILE="DEVICE_rpi-5"\n');
  await mkdir(join(root, 'conf', PI4_ENV, 'files'), { recursive: true });
  await mkdir(join(root, 'conf', PI4_ENV, 'patches'), { recursive: true });
  await writeFile(join(root, 'conf', PI4_ENV, '.config'), 'CONFIG_TARGET_PROFILE="DEVICE_rpi-2"\n');
  await mkdir(join(root, 'openwrt', '.pc'), { recursive: true });
  await mkdir(join(root, 'openwrt', 'target', 'linux', 'bcm27xx', 'image'), { recursive: true });
  for (const file of ['.quilt_patches', '.quilt_series', '.version', 'applied-patches']) {
    await writeFile(
      join(root, 'openwrt', '.pc', file),
      await readFile(join(MAIN_STATE_FIXTURE, 'openwrt', '.pc', file), 'utf8'),
    );
  }
  await writeFile(join(root, 'openwrt', 'target', 'linux', 'bcm27xx', 'image', 'gen_rpi_sdcard_img.sh'), approvedRootfs);
  return root;
}

describe('target activation', () => {
  it('uses the immutable operation tool with a fixed environment argument', () => {
    expect(createOperationDefinition('activate-target', { environment: PI5_ENV })).toEqual({
      argv: ['node', '/opt/osi-image-builder/operations/osi-image-builder-tool.js', 'activate-target', PI5_ENV],
      workingDirectory: '/workdir',
    });
  });

  it.each([
    ['Pi 4', PI4_ENV],
    ['Pi 5', PI5_ENV],
  ])('selects %s links without mutating the canonical prepatched tree', async (_label, environment) => {
    const root = await canonicalWorkspace();
    const before = await readFile(join(root, 'openwrt', '.pc', 'applied-patches'), 'utf8');
    const result = await createOperationHandlersForTesting(root).activateTarget(environment);

    expect(result).toEqual({ operation: 'activate-target', environment });
    expect(await readlink(join(root, 'conf', '.config'))).toBe(`${environment}/.config`);
    expect(await readlink(join(root, 'conf', 'files'))).toBe(`${environment}/files`);
    expect(await readlink(join(root, 'conf', 'patches'))).toBe(`${environment}/patches`);
    expect(await readlink(join(root, 'openwrt', '.config'))).toBe('../conf/.config');
    expect(await readlink(join(root, 'openwrt', 'files'))).toBe('../conf/files');
    expect(await readlink(join(root, 'openwrt', 'patches'))).toBe('../conf/patches');
    expect(await readFile(join(root, 'openwrt', '.pc', 'applied-patches'), 'utf8')).toBe(before);
    expect(await readFile(join(root, 'openwrt', 'target', 'linux', 'bcm27xx', 'image', 'gen_rpi_sdcard_img.sh'), 'utf8')).toBe(await readFile(APPROVED_ROOTFS_PATH, 'utf8'));
  });

  it('fails closed when the quarantine destination is occupied and preserves it', async () => {
    const root = await canonicalWorkspace();
    const active = join(root, 'conf', '.config');
    const quarantine = join(root, 'conf', '.config.osi-quarantine');
    await symlink(`${PI4_ENV}/.config`, active);
    await writeFile(quarantine, 'raced-in regular destination\n');

    await expect(createOperationHandlersForTesting(root).activateTarget(PI5_ENV))
      .rejects.toThrow(/available|changed|occupied|exist|symbolic link|already exists/iu);
    expect(await readlink(active)).toBe(`${PI4_ENV}/.config`);
    expect(await readFile(quarantine, 'utf8')).toBe('raced-in regular destination\n');
  });

  it('refuses to replace a non-symlink profile entry', async () => {
    const root = await canonicalWorkspace();
    await writeFile(join(root, 'conf', '.config'), 'unsafe\n');
    await expect(createOperationHandlersForTesting(root).activateTarget(PI5_ENV)).rejects.toThrow(/symbolic link|regular|already exists/iu);
    expect((await lstat(join(root, 'conf', '.config'))).isFile()).toBe(true);
  });

  it.each([
    ['empty-name symlink creation', 'before-symlink'],
    ['created-link final attestation', 'before-symlink-attestation'],
  ])('preserves a substituted regular file during %s', async (_label, racePoint) => {
    const root = await canonicalWorkspace();
    const path = join(root, 'conf', '.config');
    if (racePoint === 'before-remove' || racePoint === 'before-remove-unlink') {
      await symlink(`${PI4_ENV}/.config`, path);
    }
    let substituted = false;
    const handlers = createOperationHandlersForTesting(root, {
      async onStep(point: string, steppedPath: string) {
        if (substituted || point !== racePoint || !steppedPath.endsWith('/.config')) return;
        substituted = true;
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await writeFile(path, `substituted at ${racePoint}\n`);
      },
    });

    await expect(handlers.activateTarget(PI5_ENV)).rejects.toThrow(/changed|symbolic link|selected profile|exist/iu);
    expect(substituted).toBe(true);
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(`substituted at ${racePoint}\n`);
  });

  it('attests the tracked main patch metadata and prepatched rootfs for each profile', async () => {
    const approvedRootfs = await readFile(APPROVED_ROOTFS_PATH, 'utf8');
    const pi4Series = (await readFile(join(MAIN_STATE_FIXTURE, 'conf', PI4_ENV, 'patches/series'), 'utf8')).split('\n');
    const pi5Series = (await readFile(join(MAIN_STATE_FIXTURE, 'conf', PI5_ENV, 'patches/series'), 'utf8')).split('\n');
    expect(decideCanonicalRootfsPatchState({
      profile: PI4_ENV,
      series: pi4Series,
      applied: CANONICAL_MAIN_APPLIED_PATCHES.split('\n'),
      quiltFiles: CANONICAL_MAIN_QUILT_FILES,
      rootfsScript: approvedRootfs,
    })).toBe('applied');
    expect(decideCanonicalRootfsPatchState({
      profile: PI5_ENV,
      series: pi5Series,
      applied: CANONICAL_MAIN_APPLIED_PATCHES.split('\n'),
      quiltFiles: CANONICAL_MAIN_QUILT_FILES,
      rootfsScript: approvedRootfs,
    })).toBe('applied');
  });

  it.each([
    ['altered applied-patches', { applied: ['no-uart-console.patch'] }],
    ['altered quilt series marker', { quiltFiles: { ...CANONICAL_MAIN_QUILT_FILES, series: 'wrong\n' } }],
    ['altered rootfs', { rootfsScript: 'altered' }],
  ])('rejects %s', async (_label, mutation) => {
    const approvedRootfs = await readFile(APPROVED_ROOTFS_PATH, 'utf8');
    expect(() => decideCanonicalRootfsPatchState({
      profile: PI5_ENV,
      series: ['no-uart-console.patch', 'boot-config.patch', 'add_designware_spi_kmod.patch', 'image-with-padded-rootfs.patch'],
      applied: 'applied' in mutation ? mutation.applied : CANONICAL_MAIN_APPLIED_PATCHES.split('\n'),
      quiltFiles: 'quiltFiles' in mutation ? mutation.quiltFiles : CANONICAL_MAIN_QUILT_FILES,
      rootfsScript: 'rootfsScript' in mutation && mutation.rootfsScript === 'altered' ? `${approvedRootfs}changed\n` : approvedRootfs,
    })).toThrow(/PATCH_STATE_AMBIGUOUS|canonical|rootfs|patch/iu);
  });
});
