import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REQUIRED_RUNTIME_FILES } from '../../manifest/schema.js';
import { verifyFirmwareArtifact, type VerificationInput } from '../../runner/src/verification.js';

const temporaryDirectories: string[] = [];
const SHA40 = '0123456789abcdef0123456789abcdef01234567';

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function hash(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex'); }

async function makeRootfsFixture(): Promise<VerificationInput> {
  const root = await mkdtemp(join(tmpdir(), 'osi-rootfs-verification-'));
  temporaryDirectories.push(root);
  const artifactDirectory = join(root, 'output');
  const rootfs = join(root, 'rootfs');
  await mkdir(artifactDirectory, { recursive: true });
  for (const file of REQUIRED_RUNTIME_FILES) {
    const path = join(rootfs, file.slice(1));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '{}\n');
  }
  await writeFile(join(rootfs, 'usr/lib/node-red/gui/index.html'), '<html><head><title>OSI Gateway</title></head></html>\n');
  await mkdir(join(rootfs, 'etc/nginx'), { recursive: true });
  await writeFile(join(rootfs, 'etc/nginx/nginx.conf'), ['/gui/', '/auth/', '/api/', '/download/'].map((route) => `location ${route} {}`).join('\n'));
  await mkdir(join(rootfs, 'usr/share/node-red/node_modules/protobufjs'), { recursive: true });
  await writeFile(join(rootfs, 'usr/share/node-red/node_modules/protobufjs/package.json'), '{"name":"protobufjs","version":"1.0.0"}\n');
  await rm(join(rootfs, 'usr/share/db/farming.db'));
  const database = new DatabaseSync(join(rootfs, 'usr/share/db/farming.db'));
  database.exec('CREATE TABLE chameleon_calibrations (array_id TEXT PRIMARY KEY)');
  database.close();
  const source = join(root, 'source');
  await mkdir(join(source, 'gui'), { recursive: true });
  await writeFile(join(source, 'flows.json'), await import('node:fs/promises').then(({ readFile }) => readFile(join(rootfs, 'usr/share/flows.json'))));
  await writeFile(join(source, 'farming.db'), await import('node:fs/promises').then(({ readFile }) => readFile(join(rootfs, 'usr/share/db/farming.db'))));
  await writeFile(join(source, 'gui/index.html'), '<html><head><title>OSI Gateway</title></head></html>\n');
  const image = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x71), { level: 0 });
  const artifact = 'chirpstack-gateway-os-test-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz';
  await writeFile(join(artifactDirectory, artifact), image);
  await writeFile(join(artifactDirectory, 'sha256sums'), `${hash(image)}  ${artifact}\n`);
  return {
    target: { id: 'rpi-5', label: 'Pi 5', environment: 'full_raspberrypi_bcm27xx_bcm2712', openwrtTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5', rootfs: 'root', artifactGlob: 'chirpstack-gateway-os-*-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz', rootfsPartSize: 14336, minimumArtifactBytes: 67108864, configSymbols: [], operations: [] },
    artifactDirectory, rootfsPath: rootfs, buildStartedAt: '2026-07-26T09:00:00.000Z', sourceEvidence: { targetOutputAbsent: true, checkedTargetOutputPath: 'openwrt/bin/targets/bcm27xx/bcm2712/' }, config: { selectedTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5', rootfsPartSize: 14336, bothProfilesChecked: true }, sourcePayloads: { flows: { sourcePath: join(source, 'flows.json'), rootfsPath: join(rootfs, 'usr/share/flows.json') }, database: { sourcePath: join(source, 'farming.db'), rootfsPath: join(rootfs, 'usr/share/db/farming.db') }, gui: { sourcePath: join(source, 'gui'), rootfsPath: join(rootfs, 'usr/lib/node-red/gui') } }, feedGuiPath: join(source, 'gui'), pinnedSha: SHA40, branch: 'main', freshnessResolver: async () => ({ status: 'unknown', pinnedSha: SHA40, observedSha: null, newerSourceAvailable: false, errorCode: 'FRESHNESS_UNKNOWN' }),
  };
}

describe('rootfs verification integration boundary', () => {
  it('uses realistic rootfs and artifact fixtures without invoking a build or network', async () => {
    const input = await makeRootfsFixture();
    const result = await verifyFirmwareArtifact(input);
    expect(result.artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.rootfs.requiredFiles).toEqual(expect.arrayContaining([...REQUIRED_RUNTIME_FILES]));
    expect(result.freshness.status).toBe('unknown');
    expect(result.freshness.newerSourceAvailable).toBe(false);
  });

  it('rejects a missing required payload and a mismatched target/profile before publication', async () => {
    const missing = await makeRootfsFixture();
    await rm(join(missing.rootfsPath, 'usr/share/flows.json'));
    await expect(verifyFirmwareArtifact(missing)).rejects.toMatchObject({ code: 'ROOTFS_CONTENT_FAILED' });
    const mismatch = await makeRootfsFixture();
    await expect(verifyFirmwareArtifact({ ...mismatch, config: { ...mismatch.config, profile: 'DEVICE_rpi-2' } })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
  });
});
