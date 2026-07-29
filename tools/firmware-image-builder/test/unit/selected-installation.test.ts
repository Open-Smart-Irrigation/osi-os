import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadSelectedInstallation,
} from '../../installer/configure.js';
import { createProductionBuilderLock } from '../../installer/install.js';
import { loadManifest } from '../../manifest/validate.js';

const VERSION = '0.1.0';
const directories: string[] = [];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe('selected production installation', () => {
  it('binds every selection digest to the immutable version contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'selected-installation-test-'));
    directories.push(root);
    const installRoot = join(root, 'install');
    const versionRoot = join(installRoot, VERSION);
    const manifestRoot = join(versionRoot, 'manifest');
    const selectionPath = join(installRoot, 'selected.json');
    await mkdir(manifestRoot, { recursive: true });
    const manifestSource = new URL('../../manifest/targets.json', import.meta.url);
    const manifestText = await readFile(manifestSource, 'utf8');
    const manifestPath = join(manifestRoot, 'targets.json');
    await writeFile(manifestPath, manifestText);
    const lock = createProductionBuilderLock({
      packageVersion: VERSION,
      imageRepository: 'osi-image-builder',
      imageDigest: digest('image'),
      baseImage: `docker.io/library/debian@sha256:${digest('base')}`,
      baseImageDigest: digest('base'),
      dockerfileSha256: digest('dockerfile'),
      packageSet: [
        'gcc-14',
        'nodejs',
        'npm',
        'openwrt-build-tools',
        'llvm-dev',
        'libpolly-19-dev',
        'libzstd-dev',
      ],
      rustConfig: {
        llvmConfig: '/usr/bin/llvm-config',
        channel: 'stable',
        version: '1.85.0',
        llvmMajor: 19,
      },
      nodeVersion: '22.14.0',
      executionDefinitionSha256: digest('execution'),
      validationEvidenceSha256: digest('validation'),
      publisherSha256: digest('publisher'),
      imageId: digest('image-id'),
    });
    const lockText = `${JSON.stringify(lock)}\n`;
    const lockPath = join(versionRoot, 'builder.lock.json');
    await writeFile(lockPath, lockText);
    const selection = {
      packageVersion: VERSION,
      manifestSha256: loadManifest(manifestPath).sha256,
      lockSha256: digest(lockText),
      publisherSha256: lock.publisherSha256!,
      executionDefinitionSha256: lock.executionDefinitionSha256,
    };
    await writeFile(selectionPath, `${JSON.stringify(selection)}\n`);

    await expect(loadSelectedInstallation(installRoot, selectionPath)).resolves.toEqual({
      versionRoot,
      lockPath,
    });

    for (const key of [
      'manifestSha256',
      'lockSha256',
      'publisherSha256',
      'executionDefinitionSha256',
    ] as const) {
      await writeFile(selectionPath, `${JSON.stringify({ ...selection, [key]: digest(`wrong-${key}`) })}\n`);
      await expect(loadSelectedInstallation(installRoot, selectionPath)).rejects.toThrow(
        /selected installation evidence/u,
      );
    }
    await writeFile(selectionPath, `${JSON.stringify({ ...selection, unexpected: true })}\n`);
    await expect(loadSelectedInstallation(installRoot, selectionPath)).rejects.toThrow(
      /selected installation version/u,
    );
  });
});
