import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REQUIRED_RUNTIME_FILES } from '../../manifest/schema.js';
import { verifyFirmwareArtifact, type VerificationInput } from '../../runner/src/verification.js';

const temporaryDirectories: string[] = [];
const NOW = '2026-07-26T10:00:00.000Z';
const SHA40 = '0123456789abcdef0123456789abcdef01234567';

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function fixture(): Promise<{ input: VerificationInput; artifactDirectory: string; rootfs: string; feedGui: string }> {
  const root = await mkdtemp(join(tmpdir(), 'osi-verification-unit-'));
  temporaryDirectories.push(root);
  const artifactDirectory = join(root, 'bin', 'targets', 'bcm27xx', 'bcm2712');
  const rootfs = join(root, 'rootfs');
  const feedGui = join(root, 'feed-gui');
  await mkdir(artifactDirectory, { recursive: true });
  await mkdir(feedGui, { recursive: true });
  const image = Buffer.alloc(64 * 1024 * 1024, 0x5a);
  const artifact = 'chirpstack-gateway-os-2026.07-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz';
  await writeFile(join(artifactDirectory, artifact), gzipSync(image, { level: 0 }));
  const imageSha = sha256(await import('node:fs/promises').then(({ readFile }) => readFile(join(artifactDirectory, artifact))));
  await writeFile(join(artifactDirectory, 'sha256sums'), `${imageSha}  ${artifact}\n`);
  await writeFile(join(feedGui, 'index.html'), '<!doctype html><html><head><title>OSI Gateway</title></head><body>gui</body></html>\n');

  for (const runtimePath of REQUIRED_RUNTIME_FILES) {
    const path = join(rootfs, runtimePath.slice(1));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, runtimePath.endsWith('/index.html') ? '<html><head><title>OSI Gateway</title></head></html>\n' : '{}\n');
  }
  await mkdir(join(rootfs, 'etc/nginx/conf.d'), { recursive: true });
  await writeFile(join(rootfs, 'etc/nginx/conf.d/osi.conf'), [
    'location /gui/ { try_files $uri /gui/index.html; }',
    'location /auth/ { proxy_pass http://127.0.0.1:1880; }',
    'location /api/ { proxy_pass http://127.0.0.1:1880; }',
    'location /download/ { proxy_pass http://127.0.0.1:1880; }',
  ].join('\n'));

  const sourceFlows = join(root, 'source-flows.json');
  const sourceDb = join(root, 'source-farming.db');
  const sourceGui = join(root, 'source-gui');
  await mkdir(sourceGui, { recursive: true });
  await writeFile(sourceFlows, '{"flow":true}\n');
  const sourceDatabase = new DatabaseSync(sourceDb);
  sourceDatabase.exec('CREATE TABLE chameleon_calibrations (array_id TEXT PRIMARY KEY)');
  sourceDatabase.close();
  await writeFile(join(sourceGui, 'index.html'), await import('node:fs/promises').then(({ readFile }) => readFile(join(feedGui, 'index.html'))));
  const rootfsFlows = join(rootfs, 'usr/share/flows.json');
  const rootfsDb = join(rootfs, 'usr/share/db/farming.db');
  const rootfsGui = join(rootfs, 'usr/lib/node-red/gui');
  await writeFile(rootfsFlows, await import('node:fs/promises').then(({ readFile }) => readFile(sourceFlows)));
  await writeFile(rootfsDb, await import('node:fs/promises').then(({ readFile }) => readFile(sourceDb)));
  await writeFile(join(rootfsGui, 'index.html'), await import('node:fs/promises').then(({ readFile }) => readFile(join(feedGui, 'index.html'))));

  const input: VerificationInput = {
    target: {
      id: 'rpi-5', label: 'Pi 5', environment: 'full_raspberrypi_bcm27xx_bcm2712', openwrtTarget: 'bcm27xx/bcm2712',
      profile: 'DEVICE_rpi-5', rootfs: 'build_dir/root', artifactGlob: 'chirpstack-gateway-os-*-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz',
      rootfsPartSize: 14336, minimumArtifactBytes: 67108864, configSymbols: [], operations: [],
    },
    artifactDirectory,
    rootfsPath: rootfs,
    buildStartedAt: NOW,
    sourceEvidence: { targetOutputAbsent: true, checkedTargetOutputPath: 'openwrt/bin/targets/bcm27xx/bcm2712/' },
    config: { selectedTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5', rootfsPartSize: 14336, bothProfilesChecked: true },
    sourcePayloads: {
      flows: { sourcePath: sourceFlows, rootfsPath: rootfsFlows },
      database: { sourcePath: sourceDb, rootfsPath: rootfsDb },
      gui: { sourcePath: sourceGui, rootfsPath: rootfsGui },
    },
    feedGuiPath: feedGui,
    pinnedSha: SHA40,
    branch: 'main',
    freshnessResolver: async () => ({ status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, newerSourceAvailable: false }),
  };
  await utimes(join(artifactDirectory, artifact), new Date('2026-07-26T10:00:02.000Z'), new Date('2026-07-26T10:00:02.000Z'));
  return { input, artifactDirectory, rootfs, feedGui };
}

describe('firmware artifact verification', () => {
  it('verifies one factory image and emits bounded evidence without publishing sha256sums', async () => {
    const fixtureValue = await fixture();
    const result = await verifyFirmwareArtifact(fixtureValue.input);
    expect(result.artifact.basename).toMatch(/factory\.img\.gz$/u);
    expect(result.artifact.size).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(result.artifact.gzip).toBe(true);
    expect(result.checks.originalOpenWrtSha256sums).toMatchObject({ verified: true });
    expect(result.checks.generatedSha256sums).toMatchObject({ verified: true, filenames: [result.artifact.basename] });
    expect(result.rootfs.requiredFiles).toHaveLength(REQUIRED_RUNTIME_FILES.length);
    expect(result.rootfs.nginxRoutes).toEqual({ '/gui/': true, '/auth/': true, '/api/': true, '/download/': true });
    expect(result.rootfs.nodeResolution.protobufjs).toBe(true);
    expect(result.rootfs.database.integrityCheck).toBe('ok');
    expect(result.rootfs.database.chameleonCalibrationRows).toBe(0);
    expect(result.freshness.status).toBe('fresh');
    expect(result.evidence.bytes).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(result.evidence.json)).not.toContain('sha256sums');
    expect(result.evidence.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }, 15000);

  it('rejects a missing source absence observation before trusting output', async () => {
    const fixtureValue = await fixture();
    await expect(verifyFirmwareArtifact({ ...fixtureValue.input, sourceEvidence: { targetOutputAbsent: false, checkedTargetOutputPath: 'openwrt/bin/targets/bcm27xx/bcm2712/' } })).rejects.toMatchObject({ code: 'BUILD_OUTPUT_COLLISION' });
  });

  it('rejects stale, small, missing, and duplicate artifacts', async () => {
    const stale = await fixture();
    await utimes(join(stale.artifactDirectory, 'chirpstack-gateway-os-2026.07-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz'), new Date('2026-07-26T09:59:59.000Z'), new Date('2026-07-26T09:59:59.000Z'));
    await expect(verifyFirmwareArtifact(stale.input)).rejects.toMatchObject({ code: 'ARTIFACT_STALE' });

    const small = await fixture();
    await writeFile(join(small.artifactDirectory, 'chirpstack-gateway-os-2026.07-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz'), gzipSync(Buffer.from('small')));
    await expect(verifyFirmwareArtifact(small.input)).rejects.toMatchObject({ code: 'ARTIFACT_TOO_SMALL' });

    const missing = await fixture();
    await rm(join(missing.artifactDirectory, 'chirpstack-gateway-os-2026.07-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz'));
    await expect(verifyFirmwareArtifact(missing.input)).rejects.toMatchObject({ code: 'ARTIFACT_MISSING' });

    const duplicate = await fixture();
    await writeFile(join(duplicate.artifactDirectory, 'chirpstack-gateway-os-2026.08-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz'), Buffer.from('duplicate'));
    await expect(verifyFirmwareArtifact(duplicate.input)).rejects.toMatchObject({ code: 'BUILD_OUTPUT_COLLISION' });
  });

  it('records advanced and unknown freshness without downgrading verified artifacts', async () => {
    const advanced = await fixture();
    await expect(verifyFirmwareArtifact({ ...advanced.input, freshnessResolver: async () => ({ status: 'advanced', pinnedSha: SHA40, observedSha: 'fedcba9876543210fedcba9876543210fedcba98', newerSourceAvailable: true }) })).resolves.toMatchObject({ freshness: { status: 'advanced', newerSourceAvailable: true } });
    const unknown = await fixture();
    await expect(verifyFirmwareArtifact({ ...unknown.input, freshnessResolver: async () => { throw new Error('socket unavailable'); } })).resolves.toMatchObject({ freshness: { status: 'unknown', newerSourceAvailable: false } });
  }, 15000);
});
