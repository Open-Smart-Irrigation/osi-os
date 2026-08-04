import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRunner } from '../../runner/src/main.js';
import type { PipelineResult } from '../../runner/src/pipeline.js';
import { TEST_BUILDER_IDENTITY } from '../helpers/builder-identity.js';

const JOB_ID = 'pre-upgrade-queued-job';
const SUCCESS = Object.freeze({
  state: 'succeeded',
  buildManifest: {},
  verificationManifest: {},
  blockerCode: null,
}) satisfies PipelineResult;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => {
    await chmod(join(path, '0.1.24', 'operations'), 0o700).catch(() => undefined);
    await chmod(join(path, '0.1.24'), 0o700).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }));
});

describe('cross-version runner authority', () => {
  it('delegates to the exact admitted runner before current composition can execute', async () => {
    const resolveAdmittedRunner = vi.fn(async () => TEST_BUILDER_IDENTITY);
    const validateAdmittedRunner = vi.fn(async () => undefined);
    const invokeAdmittedRunner = vi.fn(async () => SUCCESS);
    const loadStateRoot = vi.fn(async () => {
      throw new Error('current runner composition must not start');
    });

    await expect(runRunner([JOB_ID], {
      currentExecutablePath: process.execPath,
      resolveAdmittedRunner,
      validateAdmittedRunner,
      invokeAdmittedRunner,
      loadStateRoot,
    })).resolves.toEqual(SUCCESS);

    expect(resolveAdmittedRunner).toHaveBeenCalledWith(JOB_ID);
    expect(validateAdmittedRunner).toHaveBeenCalledWith(TEST_BUILDER_IDENTITY);
    expect(invokeAdmittedRunner).toHaveBeenCalledWith({
      jobId: JOB_ID,
      identity: TEST_BUILDER_IDENTITY,
    });
    expect(loadStateRoot).not.toHaveBeenCalled();
  });

  it('rejects a legacy-null job before current composition can execute', async () => {
    const loadStateRoot = vi.fn(async () => {
      throw new Error('current runner composition must not start');
    });
    await expect(runRunner([JOB_ID], {
      currentExecutablePath: process.execPath,
      resolveAdmittedRunner: vi.fn(async () => null),
      validateAdmittedRunner: vi.fn(async () => undefined),
      invokeAdmittedRunner: vi.fn(async () => SUCCESS),
      loadStateRoot,
    })).rejects.toThrow(/admitted builder identity|legacy/iu);
    expect(loadStateRoot).not.toHaveBeenCalled();
  });

  it('validates and invokes the held pre-upgrade runner bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-admitted-runner-'));
    roots.push(root);
    const packageRoot = join(root, '0.1.24');
    const marker = join(root, 'invoked.txt');
    const manifest = await readFile(join(process.cwd(), 'manifest', 'targets.json'));
    const executionDefinition = Buffer.from('{"schemaVersion":1}\n');
    const runner = Buffer.from(`#!/bin/sh\nprintf '%s' "$1" > '${marker}'\n`);
    const cleanupWorker = Buffer.from('#!/bin/sh\nexit 0\n');
    const dependencyEgressProxy = await readFile(join(process.cwd(), 'builder', 'operations', 'osi-dependency-egress-proxy.cjs'));
    const imageDigest = '4'.repeat(64);
    const imageId = '5'.repeat(64);
    const lock = {
      schemaVersion: 1,
      packageVersion: '0.1.24',
      imageRepository: 'registry.example.invalid/osi-image-builder',
      imageDigest,
      baseImage: `ubuntu@sha256:${'6'.repeat(64)}`,
      baseImageDigest: '6'.repeat(64),
      dockerfileSha256: '7'.repeat(64),
      packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev', 'libpolly-18-dev'],
      rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.80.0', llvmMajor: 18 },
      nodeVersion: '22.12.0',
      executionDefinitionSha256: createHash('sha256').update(executionDefinition).digest('hex'),
      dependencyEgressProxySha256: createHash('sha256').update(dependencyEgressProxy).digest('hex'),
      validationEvidenceSha256: '8'.repeat(64),
      installable: true,
      publisherSha256: '9'.repeat(64),
      imageId,
    } as const;
    const lockBytes = Buffer.from(`${JSON.stringify(lock)}\n`);
    const identity = {
      packageVersion: lock.packageVersion,
      packageRoot,
      lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
      executionDefinitionSha256: lock.executionDefinitionSha256,
      targetManifestSha256: createHash('sha256').update(manifest).digest('hex'),
      runnerSha256: createHash('sha256').update(runner).digest('hex'),
      cleanupWorkerSha256: createHash('sha256').update(cleanupWorker).digest('hex'),
      dependencyEgressProxySha256: lock.dependencyEgressProxySha256,
      imageReference: `${lock.imageRepository}@sha256:${imageDigest}`,
      imageId: `sha256:${imageId}`,
      imageDigest,
    } as const;
    await Promise.all([
      mkdir(join(packageRoot, 'bin'), { recursive: true }),
      mkdir(join(packageRoot, 'manifest'), { recursive: true }),
      mkdir(join(packageRoot, 'operations'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(packageRoot, 'builder.lock.json'), lockBytes),
      writeFile(join(packageRoot, 'execution-definition.json'), executionDefinition),
      writeFile(join(packageRoot, 'bin', 'osi-image-builder-runner'), runner, { mode: 0o555 }),
      writeFile(join(packageRoot, 'bin', 'osi-image-builder-cleanup'), cleanupWorker, { mode: 0o555 }),
      writeFile(join(packageRoot, 'manifest', 'targets.json'), manifest),
      writeFile(join(packageRoot, 'operations', 'osi-dependency-egress-proxy.cjs'), dependencyEgressProxy, { mode: 0o444 }),
    ]);
    await chmod(join(packageRoot, 'operations'), 0o555);
    await chmod(packageRoot, 0o555);

    await expect(runRunner([JOB_ID], {
      currentExecutablePath: process.execPath,
      resolveAdmittedRunner: vi.fn(async () => identity),
    })).resolves.toMatchObject({ state: 'succeeded' });
    await expect(readFile(marker, 'utf8')).resolves.toBe(JOB_ID);

    await chmod(join(packageRoot, 'operations', 'osi-dependency-egress-proxy.cjs'), 0o644);
    await writeFile(join(packageRoot, 'operations', 'osi-dependency-egress-proxy.cjs'), 'changed proxy runtime\n');
    await chmod(join(packageRoot, 'operations', 'osi-dependency-egress-proxy.cjs'), 0o444);
    await expect(runRunner([JOB_ID], {
      currentExecutablePath: process.execPath,
      resolveAdmittedRunner: vi.fn(async () => identity),
    })).rejects.toThrow(/proxy|hash/iu);
  });
});
