import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPublisherClient } from '../../publisher/client.js';

const execFile = promisify(execFileCallback);
const publisherDirectory = join(process.cwd(), 'publisher');
const binary = join(publisherDirectory, 'osi-image-publish');
const beforeRaceBinary = join(publisherDirectory, 'osi-image-publish-test-before');
const afterRaceBinary = join(publisherDirectory, 'osi-image-publish-test-after');
const destinationRaceBinary = join(publisherDirectory, 'osi-image-publish-test-destination');
const ancestorBeforeBinary = join(publisherDirectory, 'osi-image-publish-test-ancestor-before');
const ancestorAfterBinary = join(publisherDirectory, 'osi-image-publish-test-ancestor-after');
const rootAncestorBeforeBinary = join(publisherDirectory, 'osi-image-publish-test-root-ancestor-before');
const rootAncestorAfterBinary = join(publisherDirectory, 'osi-image-publish-test-root-ancestor-after');
const metadataAfterBinary = join(publisherDirectory, 'osi-image-publish-test-metadata-after');
const metadataAfterQuarantineBinary = join(publisherDirectory, 'osi-image-publish-test-metadata-after-quarantine');
const stagingParentAfterBinary = join(publisherDirectory, 'osi-image-publish-test-staging-parent-after');
const branchParentAfterBinary = join(publisherDirectory, 'osi-image-publish-test-branch-parent-after');
const recheckLateSwapBinary = join(publisherDirectory, 'osi-image-publish-test-recheck-late-swap');
const preRenameFsyncFailureBinary = join(publisherDirectory, 'osi-image-publish-test-pre-rename-fsync-failure');
const unsupportedBinary = join(publisherDirectory, 'osi-image-publish-test-unsupported');
const crossDeviceBinary = join(publisherDirectory, 'osi-image-publish-test-cross-device');
const fsyncFailureBinary = join(publisherDirectory, 'osi-image-publish-test-fsync-failure');
const blockRootBinary = join(publisherDirectory, 'osi-image-publish-test-block-root');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TARGET = 'rpi-5';
let base = '';
let root = '';
let staging = '';
let publisherSourceSha256 = '';

async function runPublisher(...argv: string[]) {
  return runBinary(binary, ...argv);
}

async function runBinary(executable: string, ...argv: string[]) {
  try {
    const response = await execFile(executable, argv, { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    return { code: 0, stdout: response.stdout.trim(), stderr: response.stderr.trim() };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: (failure.stdout ?? '').trim(), stderr: (failure.stderr ?? '').trim() };
  }
}

function parsed(response: { stdout: string }): Record<string, unknown> {
  return JSON.parse(response.stdout) as Record<string, unknown>;
}

async function createStaging(jobId: string, selectedRoot = root): Promise<string> {
  const path = join(selectedRoot, '.osi-image-builder', 'staging', jobId);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'factory.img.gz'), 'factory image');
  await writeFile(join(path, 'sha256sums'), 'checksum  factory.img.gz\n');
  await writeFile(join(path, 'build-manifest.json'), '{"schemaVersion":1}\n');
  await writeFile(join(path, 'verification.json'), '{"schemaVersion":1}\n');
  return path;
}

describe('native publisher integration', () => {
  beforeAll(async () => {
    publisherSourceSha256 = createHash('sha256')
      .update(await readFile(join(publisherDirectory, 'osi-image-publish.c')))
      .digest('hex');
    await execFile('make', ['-C', publisherDirectory, 'clean', 'all', 'test-hooks'], { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    base = await mkdtemp('/tmp/osi-image-publisher-');
    root = join(base, 'images');
    staging = join(root, '.osi-image-builder', 'staging');
    await mkdir(staging, { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(binary, { force: true });
    await rm(beforeRaceBinary, { force: true });
    await rm(afterRaceBinary, { force: true });
    await rm(destinationRaceBinary, { force: true });
    await rm(ancestorBeforeBinary, { force: true });
    await rm(ancestorAfterBinary, { force: true });
    await rm(rootAncestorBeforeBinary, { force: true });
    await rm(rootAncestorAfterBinary, { force: true });
    await rm(metadataAfterBinary, { force: true });
    await rm(metadataAfterQuarantineBinary, { force: true });
    await rm(stagingParentAfterBinary, { force: true });
    await rm(branchParentAfterBinary, { force: true });
    await rm(recheckLateSwapBinary, { force: true });
    await rm(preRenameFsyncFailureBinary, { force: true });
    await rm(unsupportedBinary, { force: true });
    await rm(crossDeviceBinary, { force: true });
    await rm(fsyncFailureBinary, { force: true });
    await rm(blockRootBinary, { force: true });
  });

  it('reports version and completes a private self-test', async () => {
    const version = await runPublisher('--version');
    expect(version.code).toBe(0);
    expect(parsed(version)).toMatchObject({ available: true, version: '0.1.0' });
    const selfTest = await runPublisher('--self-test');
    expect(selfTest.code).toBe(0);
    expect(parsed(selfTest)).toMatchObject({ available: true, selfTest: true, mutationCount: 0 });
  });

  it('publishes once with fsynced same-filesystem staging and never overwrites a collision', async () => {
    const jobId = 'job-publish';
    await createStaging(jobId);
    const published = await runPublisher('publish', '--root', root, '--job-id', jobId, '--branch', 'feature%2Fpublisher', '--sha', SHA, '--target', TARGET);
    expect(published.code).toBe(0);
    expect(parsed(published)).toMatchObject({ available: true, published: true, mutationCount: 3, renameResult: 'RENAMED' });
    expect(parsed(published)).toMatchObject({ publisherVersion: '0.1.0', publisherSourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/), sourceRelativePath: `.osi-image-builder/staging/${jobId}`, destinationRelativePath: `feature%2Fpublisher/${SHA}/${TARGET}` });
    expect((await readdir(join(root, '.osi-image-builder'))).some((entry) => entry.startsWith('.osi-image-publisher-capability-'))).toBe(false);
    await expect(access(join(root, 'feature%2Fpublisher', SHA, TARGET))).resolves.toBeUndefined();
    const complete = await runPublisher('recheck', '--root', root, '--job-id', jobId, '--branch', 'feature%2Fpublisher', '--sha', SHA, '--target', TARGET);
    expect(complete.code).toBe(0);
    expect(parsed(complete)).toMatchObject({ available: true, destination: 'candidate', staging: 'absent', mutationCount: 0 });
    const productionClient = createPublisherClient({
      executable: binary,
      approvedRoots: [{ id: 'images', label: 'Images', path: root, quarantinePath: `${root}/.osi-image-builder/quarantine` }],
      expectedVersion: '0.1.0',
      expectedSourceSha256: publisherSourceSha256,
    });
    const clientRecheck = await productionClient.recheck({
      rootId: 'images',
      jobId,
      branchSlug: 'feature%2Fpublisher',
      sourceSha: SHA,
      targetId: TARGET,
    });
    expect(clientRecheck).toMatchObject({ destination: 'candidate', staging: 'absent' });
    expect(clientRecheck).not.toHaveProperty('errorCode');

    const collisionJob = 'job-collision';
    await createStaging(collisionJob);
    const finalPath = join(root, 'feature%2Fcollision', SHA, TARGET);
    await mkdir(finalPath, { recursive: true });
    await writeFile(join(finalPath, 'keep.txt'), 'keep');
    const collision = await runPublisher('publish', '--root', root, '--job-id', collisionJob, '--branch', 'feature%2Fcollision', '--sha', SHA, '--target', TARGET);
    expect(collision.code).not.toBe(0);
    expect(parsed(collision)).toMatchObject({
      available: true,
      published: false,
      errorCode: 'OUTPUT_COLLISION',
      mutationCount: 0,
      renameResult: 'EEXIST',
      sourceRelativePath: `.osi-image-builder/staging/${collisionJob}`,
      destinationRelativePath: `feature%2Fcollision/${SHA}/${TARGET}`,
    });
    await expect(readFile(join(finalPath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(join(root, '.osi-image-builder', 'staging', collisionJob))).resolves.toBeUndefined();

    const quarantineJob = 'job-quarantine';
    await createStaging(quarantineJob);
    const quarantined = await runPublisher('quarantine', '--root', root, '--job-id', quarantineJob);
    expect(quarantined.code).toBe(0);
    expect(parsed(quarantined)).toMatchObject({ available: true, quarantined: true, mutationCount: 2, renameResult: 'RENAMED', publisherVersion: '0.1.0', publisherSourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/), sourceRelativePath: `.osi-image-builder/staging/${quarantineJob}`, destinationRelativePath: `.osi-image-builder/quarantine/${quarantineJob}` });
    await expect(access(join(root, '.osi-image-builder', 'staging', quarantineJob))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(root, '.osi-image-builder', 'quarantine', quarantineJob))).resolves.toBeUndefined();
  });

  it('rejects symlink and traversal components and reports block-device roots', async () => {
    const symlinkJob = 'job-link';
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, '.osi-image-builder', 'staging', symlinkJob));
    const rejected = await runPublisher('publish', '--root', root, '--job-id', symlinkJob, '--branch', 'feature%2Flink', '--sha', SHA, '--target', TARGET);
    expect(rejected.code).not.toBe(0);
    expect(parsed(rejected)).toMatchObject({ published: false, errorCode: 'PUBLISH_FAILED' });

    const traversal = await runPublisher('publish', '--root', root, '--job-id', '../outside', '--branch', 'feature%2Fbad', '--sha', SHA, '--target', TARGET);
    expect(traversal.code).not.toBe(0);
    expect(parsed(traversal)).toMatchObject({ published: false, errorCode: 'INVALID_ARGUMENT', mutationCount: 0 });

    const blockPublish = await runBinary(blockRootBinary, 'publish', '--root', root, '--job-id', 'job-block', '--branch', 'feature%2Fblock', '--sha', SHA, '--target', TARGET);
    expect(blockPublish.code).not.toBe(0);
    expect(parsed(blockPublish)).toMatchObject({ available: true, published: false, quarantined: false, mutationCount: 0, errorCode: 'PUBLISH_FAILED' });
    const blockQuarantine = await runBinary(blockRootBinary, 'quarantine', '--root', root, '--job-id', 'job-block');
    expect(blockQuarantine.code).not.toBe(0);
    expect(parsed(blockQuarantine)).toMatchObject({ available: true, published: false, quarantined: false, mutationCount: 0, errorCode: 'QUARANTINE_PENDING' });
    for (const branch of ['.', '..']) {
      const dotJob = `job-dot-${branch === '.' ? 'one' : 'two'}`;
      await createStaging(dotJob);
      const dot = await runPublisher('publish', '--root', root, '--job-id', dotJob, '--branch', branch, '--sha', SHA, '--target', TARGET);
      expect(dot.code).not.toBe(0);
      expect(parsed(dot)).toMatchObject({ available: true, published: false, mutationCount: 0, errorCode: 'INVALID_ARGUMENT' });
      await expect(access(join(root, '.osi-image-builder', 'staging', dotJob))).resolves.toBeUndefined();
      await expect(access(join(base, SHA, TARGET))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(fsConstants.O_NOFOLLOW).toBeTypeOf('number');
  });

  it('aligns encoded branch and job-ID boundaries across the client and native helper', async () => {
    const encodedJob = 'job-encoded-leading';
    await createStaging(encodedJob);
    const encoded = await runPublisher('publish', '--root', root, '--job-id', encodedJob, '--branch', '%C3%A9-main', '--sha', SHA, '--target', TARGET);
    expect(encoded.code).toBe(0);
    expect(parsed(encoded)).toMatchObject({ published: true, destinationRelativePath: `%C3%A9-main/${SHA}/${TARGET}` });

    const maximumJob = `j${'a'.repeat(127)}`;
    await createStaging(maximumJob);
    const maximum = await runPublisher('quarantine', '--root', root, '--job-id', maximumJob);
    expect(maximum.code).toBe(0);
    expect(parsed(maximum)).toMatchObject({ quarantined: true, sourceRelativePath: `.osi-image-builder/staging/${maximumJob}` });
  });

  it('reports selected-filesystem capability, cross-device, and fsync failures honestly', async () => {
    const scratchBefore = new Set((await readdir('/tmp')).filter((entry) => entry.startsWith('osi-image-publish-self-test-')));
    const unsupportedJob = 'job-unsupported';
    await createStaging(unsupportedJob);
    const unsupported = await runBinary(unsupportedBinary, 'publish', '--root', root, '--job-id', unsupportedJob, '--branch', 'feature%2Funsupported', '--sha', SHA, '--target', TARGET);
    expect(unsupported.code).not.toBe(0);
    expect(parsed(unsupported)).toEqual({ available: false, published: false, quarantined: false, selfTest: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' });
    await expect(access(join(root, 'feature%2Funsupported'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(root, '.osi-image-builder'))).some((entry) => entry.startsWith('.osi-image-publisher-capability-'))).toBe(false);
    const unsupportedSelfTest = await runBinary(unsupportedBinary, '--self-test');
    expect(unsupportedSelfTest.code).not.toBe(0);
    expect(parsed(unsupportedSelfTest)).toEqual({ available: false, published: false, quarantined: false, selfTest: false, mutationCount: 0, errorCode: 'PUBLISHER_UNSUPPORTED' });
    const scratchAfter = new Set((await readdir('/tmp')).filter((entry) => entry.startsWith('osi-image-publish-self-test-')));
    expect(scratchAfter).toEqual(scratchBefore);

    const crossDeviceJob = 'job-cross-device';
    await createStaging(crossDeviceJob);
    const crossDevice = await runBinary(crossDeviceBinary, 'publish', '--root', root, '--job-id', crossDeviceJob, '--branch', 'feature%2Fcross-device', '--sha', SHA, '--target', TARGET);
    expect(crossDevice.code).not.toBe(0);
    expect(parsed(crossDevice)).toMatchObject({ available: true, published: false, mutationCount: 2, errorCode: 'STAGING_FILESYSTEM_MISMATCH' });

    const fsyncJob = 'job-fsync-failure';
    await createStaging(fsyncJob);
    const fsyncFailure = await runBinary(fsyncFailureBinary, 'publish', '--root', root, '--job-id', fsyncJob, '--branch', 'feature%2Ffsync-failure', '--sha', SHA, '--target', TARGET);
    expect(fsyncFailure.code).not.toBe(0);
    expect(parsed(fsyncFailure)).toMatchObject({ published: false, mutationCount: 3, errorCode: 'PUBLISH_FAILED', renameResult: 'RENAMED' });
  });

  it('keeps native early filesystem failures typed through the production client', async () => {
    const missingRoot = join(base, 'missing-root');
    const missingClient = createPublisherClient({
      executable: binary,
      approvedRoots: [{ id: 'missing', label: 'Missing', path: missingRoot, quarantinePath: `${missingRoot}/.osi-image-builder/quarantine` }],
      expectedVersion: '0.1.0',
      expectedSourceSha256: publisherSourceSha256,
    });
    const request = { rootId: 'missing', jobId: 'job-missing-root', branchSlug: 'feature%2Fmissing-root', sourceSha: SHA, targetId: 'rpi-5' as const };
    await expect(missingClient.publish(request)).resolves.toMatchObject({
      available: true,
      published: false,
      errorCode: 'PUBLISH_FAILED',
      sourceRelativePath: '.osi-image-builder/staging/job-missing-root',
    });
    await expect(missingClient.quarantine(request)).resolves.toMatchObject({
      available: true,
      quarantined: false,
      errorCode: 'QUARANTINE_PENDING',
      sourceRelativePath: '.osi-image-builder/staging/job-missing-root',
    });
    await expect(missingClient.recheck(request)).resolves.toMatchObject({
      destination: 'unknown',
      staging: 'unknown',
      errorCode: 'PUBLISH_RECOVERY_FAILED',
    });

    const invalidRoot = join(base, 'invalid-staging-root');
    await mkdir(join(invalidRoot, '.osi-image-builder'), { recursive: true });
    await writeFile(join(invalidRoot, '.osi-image-builder', 'staging'), 'not a directory');
    const invalidClient = createPublisherClient({
      executable: binary,
      approvedRoots: [{ id: 'invalid', label: 'Invalid staging', path: invalidRoot, quarantinePath: `${invalidRoot}/.osi-image-builder/quarantine` }],
      expectedVersion: '0.1.0',
      expectedSourceSha256: publisherSourceSha256,
    });
    await expect(invalidClient.publish({ ...request, rootId: 'invalid', jobId: 'job-invalid-staging' })).resolves.toMatchObject({ errorCode: 'PUBLISH_FAILED' });
    await expect(invalidClient.quarantine({ rootId: 'invalid', jobId: 'job-invalid-staging' })).resolves.toMatchObject({ errorCode: 'QUARANTINE_PENDING' });
    await expect(invalidClient.recheck({ ...request, rootId: 'invalid', jobId: 'job-invalid-staging' })).resolves.toMatchObject({
      destination: 'unknown',
      staging: 'unknown',
      errorCode: 'PUBLISH_RECOVERY_FAILED',
    });
  });

  it('distinguishes a surviving staging tree from an existing mismatched destination without mutation', async () => {
    const survivingJob = 'job-survives';
    await createStaging(survivingJob);
    const surviving = await runPublisher('recheck', '--root', root, '--job-id', survivingJob, '--branch', 'feature%2Fsurvives', '--sha', SHA, '--target', TARGET);
    expect(surviving.code).toBe(0);
    expect(parsed(surviving)).toMatchObject({ available: true, destination: 'absent', staging: 'present', errorCode: 'PUBLISH_RECOVERY_FAILED', mutationCount: 0 });

    const mismatchedJob = 'job-mismatch';
    await createStaging(mismatchedJob);
    const destination = join(root, 'feature%2Fmismatch', SHA, TARGET);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'wrong.txt'), 'wrong');
    const mismatch = await runPublisher('recheck', '--root', root, '--job-id', mismatchedJob, '--branch', 'feature%2Fmismatch', '--sha', SHA, '--target', TARGET);
    expect(mismatch.code).toBe(0);
    expect(parsed(mismatch)).toMatchObject({ available: true, destination: 'mismatched', staging: 'present', errorCode: 'UNVERIFIED_FINAL_PATH_BLOCKER', mutationCount: 0 });
    await expect(readFile(join(destination, 'wrong.txt'), 'utf8')).resolves.toBe('wrong');
    await expect(access(join(root, '.osi-image-builder', 'staging', mismatchedJob))).resolves.toBeUndefined();
  });

  it('rejects a held-source swap before rename without mutation and reports post-rename mismatch honestly', async () => {
    const beforeJob = 'job-race-before';
    await createStaging(beforeJob);
    const before = await runBinary(beforeRaceBinary, 'publish', '--root', root, '--job-id', beforeJob, '--branch', 'feature%2Frace-before', '--sha', SHA, '--target', TARGET);
    expect(before.code).not.toBe(0);
    expect(parsed(before)).toMatchObject({ published: false, mutationCount: 0, errorCode: 'PUBLISH_FAILED' });
    await unlink(join(root, '.osi-image-builder', 'staging', beforeJob));
    await rename(join(root, '.osi-image-builder', 'staging', '.publisher-test-hidden'), join(root, '.osi-image-builder', 'staging', beforeJob));

    const afterJob = 'job-race-after';
    await createStaging(afterJob);
    const after = await runBinary(afterRaceBinary, 'publish', '--root', root, '--job-id', afterJob, '--branch', 'feature%2Frace-after', '--sha', SHA, '--target', TARGET);
    expect(after.code).not.toBe(0);
    expect(parsed(after)).toMatchObject({ published: false, mutationCount: 2, errorCode: 'PUBLISH_FAILED', sourceRelativePath: `.osi-image-builder/staging/${afterJob}`, destinationRelativePath: `feature%2Frace-after/${SHA}/${TARGET}` });
    await unlink(join(root, '.osi-image-builder', 'staging', afterJob));
    await rename(join(root, '.osi-image-builder', 'staging', '.publisher-test-hidden'), join(root, '.osi-image-builder', 'staging', afterJob));
  });

  it('retains and revalidates the complete approved-root descriptor chain', async () => {
    for (const [phase, executable] of [['before', rootAncestorBeforeBinary], ['after', rootAncestorAfterBinary]] as const) {
      for (const offset of [1, 2, 3, 4, 5]) {
        const chainBase = await mkdtemp('/tmp/osi-image-publisher-chain-');
        const selectedRoot = join(chainBase, 'stable', 'level-one', 'level-two', 'level-three', 'images');
        const jobId = `job-root-${phase}-${offset}`;
        try {
          await createStaging(jobId, selectedRoot);
          const response = await runBinary(executable, 'publish', '--root', selectedRoot, '--job-id', jobId, '--branch', `feature%2Froot-${phase}-${offset}`, '--sha', SHA, '--target', TARGET);
          expect(response.code).toBe(2);
          expect(parsed(response)).toMatchObject({
            published: false,
            errorCode: 'PUBLISH_FAILED',
            mutationCount: phase === 'before' ? 0 : 3,
            ...(phase === 'after' ? { renameResult: 'RENAMED' } : {}),
          });
          await expect(access(join(selectedRoot, `feature%2Froot-${phase}-${offset}`, SHA, TARGET))).rejects.toMatchObject({ code: 'ENOENT' });
          const hiddenParent = offset === 5 ? '/tmp' : chainBase;
          expect((await readdir(hiddenParent, { recursive: offset !== 5 })).some((entry) => entry.includes(`.publisher-test-root-ancestor-hidden-${jobId}`))).toBe(true);
        } finally {
          await rm(chainBase, { recursive: true, force: true });
          if (offset === 5) await rm(join('/tmp', `.publisher-test-root-ancestor-hidden-${jobId}`), { recursive: true, force: true });
        }
      }
    }

    for (const operation of ['quarantine', 'recheck'] as const) {
      for (const offset of [1, 2, 3, 4, 5]) {
        const operationBase = await mkdtemp(`/tmp/osi-image-publisher-chain-${operation}-`);
        const selectedRoot = join(operationBase, 'stable', 'level-one', 'level-two', 'level-three', 'images');
        const jobId = `job-chain-${operation}-${offset}`;
        try {
          await createStaging(jobId, selectedRoot);
          const response = operation === 'quarantine'
            ? await runBinary(rootAncestorBeforeBinary, operation, '--root', selectedRoot, '--job-id', jobId)
            : await runBinary(rootAncestorBeforeBinary, operation, '--root', selectedRoot, '--job-id', jobId, '--branch', `feature%2Fchain-${offset}`, '--sha', SHA, '--target', TARGET);
          expect(response.code).toBe(2);
          expect(parsed(response)).toMatchObject(operation === 'quarantine'
            ? { quarantined: false, mutationCount: 0, errorCode: 'QUARANTINE_PENDING' }
            : { destination: 'unknown', staging: 'unknown', mutationCount: 0, errorCode: 'PUBLISH_RECOVERY_FAILED' });
        } finally {
          await rm(operationBase, { recursive: true, force: true });
          if (offset === 5) await rm(join('/tmp', `.publisher-test-root-ancestor-hidden-${jobId}`), { recursive: true, force: true });
        }
      }
    }
  });

  it('rejects metadata replacement around capability, quarantine creation, and recheck', async () => {
    for (const operation of ['publish', 'quarantine', 'recheck'] as const) {
      const operationBase = await mkdtemp(`/tmp/osi-image-publisher-metadata-${operation}-`);
      const selectedRoot = join(operationBase, 'images');
      const jobId = `job-metadata-${operation}`;
      try {
        await createStaging(jobId, selectedRoot);
        const response = operation === 'quarantine'
          ? await runBinary(metadataAfterBinary, operation, '--root', selectedRoot, '--job-id', jobId)
          : await runBinary(metadataAfterBinary, operation, '--root', selectedRoot, '--job-id', jobId, '--branch', `feature%2Fmetadata-${operation}`, '--sha', SHA, '--target', TARGET);
        expect(response.code).toBe(2);
        expect(parsed(response)).toMatchObject(operation === 'publish'
          ? { published: false, mutationCount: 0, errorCode: 'PUBLISH_FAILED' }
          : operation === 'quarantine'
            ? { quarantined: false, mutationCount: 0, errorCode: 'QUARANTINE_PENDING' }
            : { destination: 'unknown', staging: 'unknown', mutationCount: 0, errorCode: 'PUBLISH_RECOVERY_FAILED' });
        expect((await readdir(selectedRoot)).some((entry) => entry.startsWith('.publisher-test-metadata-hidden-'))).toBe(true);
      } finally {
        await rm(operationBase, { recursive: true, force: true });
      }
    }

    const quarantineBase = await mkdtemp('/tmp/osi-image-publisher-metadata-quarantine-parent-');
    const quarantineRoot = join(quarantineBase, 'images');
    try {
      await createStaging('job-metadata-after-quarantine', quarantineRoot);
      const response = await runBinary(metadataAfterQuarantineBinary, 'quarantine', '--root', quarantineRoot, '--job-id', 'job-metadata-after-quarantine');
      expect(response.code).toBe(2);
      expect(parsed(response)).toMatchObject({ quarantined: false, mutationCount: 1, errorCode: 'QUARANTINE_PENDING' });
    } finally {
      await rm(quarantineBase, { recursive: true, force: true });
    }
  });

  it('rejects staging and branch parent replacement across publication and recovery', async () => {
    for (const operation of ['publish', 'quarantine', 'recheck'] as const) {
      const operationBase = await mkdtemp(`/tmp/osi-image-publisher-staging-parent-${operation}-`);
      const selectedRoot = join(operationBase, 'images');
      const jobId = `job-staging-parent-${operation}`;
      try {
        await createStaging(jobId, selectedRoot);
        const response = operation === 'quarantine'
          ? await runBinary(stagingParentAfterBinary, operation, '--root', selectedRoot, '--job-id', jobId)
          : await runBinary(stagingParentAfterBinary, operation, '--root', selectedRoot, '--job-id', jobId, '--branch', `feature%2Fstaging-${operation}`, '--sha', SHA, '--target', TARGET);
        expect(response.code).toBe(2);
        expect(parsed(response)).toMatchObject(operation === 'publish'
          ? { published: false, mutationCount: 0, errorCode: 'PUBLISH_FAILED' }
          : operation === 'quarantine'
            ? { quarantined: false, mutationCount: 0, errorCode: 'QUARANTINE_PENDING' }
            : { destination: 'unknown', staging: 'unknown', mutationCount: 0, errorCode: 'PUBLISH_RECOVERY_FAILED' });
      } finally {
        await rm(operationBase, { recursive: true, force: true });
      }
    }

    const publishBase = await mkdtemp('/tmp/osi-image-publisher-branch-parent-publish-');
    const publishRoot = join(publishBase, 'images');
    try {
      await createStaging('job-branch-parent-publish', publishRoot);
      const response = await runBinary(branchParentAfterBinary, 'publish', '--root', publishRoot, '--job-id', 'job-branch-parent-publish', '--branch', 'feature%2Fbranch-parent', '--sha', SHA, '--target', TARGET);
      expect(response.code).toBe(2);
      expect(parsed(response)).toMatchObject({ published: false, mutationCount: 2, errorCode: 'PUBLISH_FAILED' });
    } finally {
      await rm(publishBase, { recursive: true, force: true });
    }

    const recheckBase = await mkdtemp('/tmp/osi-image-publisher-branch-parent-recheck-');
    const recheckRoot = join(recheckBase, 'images');
    try {
      await createStaging('job-branch-parent-seed', recheckRoot);
      const seeded = await runBinary(binary, 'publish', '--root', recheckRoot, '--job-id', 'job-branch-parent-seed', '--branch', 'feature%2Fbranch-recheck', '--sha', SHA, '--target', TARGET);
      expect(seeded.code).toBe(0);
      const response = await runBinary(branchParentAfterBinary, 'recheck', '--root', recheckRoot, '--job-id', 'job-branch-parent-seed', '--branch', 'feature%2Fbranch-recheck', '--sha', SHA, '--target', TARGET);
      expect(response.code).toBe(2);
      expect(parsed(response)).toMatchObject({ destination: 'unknown', staging: 'unknown', errorCode: 'PUBLISH_RECOVERY_FAILED' });
    } finally {
      await rm(recheckBase, { recursive: true, force: true });
    }
  });

  it('propagates pre-rename fsync failure and rejects late recheck name replacement', async () => {
    const syncBase = await mkdtemp('/tmp/osi-image-publisher-pre-sync-');
    const syncRoot = join(syncBase, 'images');
    try {
      await createStaging('job-pre-sync-publish', syncRoot);
      const publish = await runBinary(preRenameFsyncFailureBinary, 'publish', '--root', syncRoot, '--job-id', 'job-pre-sync-publish', '--branch', 'feature%2Fpre-sync', '--sha', SHA, '--target', TARGET);
      expect(publish.code).toBe(2);
      expect(parsed(publish)).toMatchObject({ published: false, mutationCount: 2, errorCode: 'PUBLISH_FAILED' });
      expect(parsed(publish)).not.toHaveProperty('renameResult');
      await expect(access(join(syncRoot, '.osi-image-builder', 'staging', 'job-pre-sync-publish'))).resolves.toBeUndefined();

      await createStaging('job-pre-sync-quarantine', syncRoot);
      const quarantine = await runBinary(preRenameFsyncFailureBinary, 'quarantine', '--root', syncRoot, '--job-id', 'job-pre-sync-quarantine');
      expect(quarantine.code).toBe(2);
      expect(parsed(quarantine)).toMatchObject({ quarantined: false, mutationCount: 1, errorCode: 'QUARANTINE_PENDING' });
      expect(parsed(quarantine)).not.toHaveProperty('renameResult');
      await expect(access(join(syncRoot, '.osi-image-builder', 'staging', 'job-pre-sync-quarantine'))).resolves.toBeUndefined();
    } finally {
      await rm(syncBase, { recursive: true, force: true });
    }

    const recheckBase = await mkdtemp('/tmp/osi-image-publisher-recheck-late-');
    const recheckRoot = join(recheckBase, 'images');
    try {
      await createStaging('job-recheck-late', recheckRoot);
      const publish = await runBinary(binary, 'publish', '--root', recheckRoot, '--job-id', 'job-recheck-late', '--branch', 'feature%2Frecheck-late', '--sha', SHA, '--target', TARGET);
      expect(publish.code).toBe(0);
      const recheck = await runBinary(recheckLateSwapBinary, 'recheck', '--root', recheckRoot, '--job-id', 'job-recheck-late', '--branch', 'feature%2Frecheck-late', '--sha', SHA, '--target', TARGET);
      expect(parsed(recheck)).toMatchObject({ destination: 'unknown', staging: 'unknown', errorCode: 'PUBLISH_RECOVERY_FAILED' });
    } finally {
      await rm(recheckBase, { recursive: true, force: true });
    }
  });

  it('applies the same held-source identity proof and post-rename evidence to quarantine', async () => {
    const beforeJob = 'job-quarantine-race-before';
    await createStaging(beforeJob);
    const before = await runBinary(beforeRaceBinary, 'quarantine', '--root', root, '--job-id', beforeJob);
    expect(before.code).not.toBe(0);
    expect(parsed(before)).toMatchObject({ quarantined: false, mutationCount: 0, errorCode: 'QUARANTINE_PENDING' });
    await unlink(join(root, '.osi-image-builder', 'staging', beforeJob));
    await rename(join(root, '.osi-image-builder', 'staging', '.publisher-test-hidden'), join(root, '.osi-image-builder', 'staging', beforeJob));

    const afterJob = 'job-quarantine-race-after';
    await createStaging(afterJob);
    const after = await runBinary(afterRaceBinary, 'quarantine', '--root', root, '--job-id', afterJob);
    expect(after.code).not.toBe(0);
    expect(parsed(after)).toMatchObject({ quarantined: false, mutationCount: 0, errorCode: 'QUARANTINE_PENDING', sourceRelativePath: `.osi-image-builder/staging/${afterJob}`, destinationRelativePath: `.osi-image-builder/quarantine/${afterJob}` });
    await unlink(join(root, '.osi-image-builder', 'staging', afterJob));
    await rename(join(root, '.osi-image-builder', 'staging', '.publisher-test-hidden'), join(root, '.osi-image-builder', 'staging', afterJob));
  });

  it('rejects a destination-name swap after rename for publish and quarantine', async () => {
    const publishJob = 'job-destination-race';
    await createStaging(publishJob);
    const published = await runBinary(destinationRaceBinary, 'publish', '--root', root, '--job-id', publishJob, '--branch', 'feature%2Fdestination-race', '--sha', SHA, '--target', TARGET);
    expect(published.code).not.toBe(0);
    expect(parsed(published)).toMatchObject({
      published: false,
      mutationCount: 3,
      errorCode: 'PUBLISH_FAILED',
      destinationRelativePath: `feature%2Fdestination-race/${SHA}/${TARGET}`,
    });
    await expect(access(join(root, 'feature%2Fdestination-race', SHA, TARGET))).resolves.toBeUndefined();
    await expect(access(join(root, 'feature%2Fdestination-race', SHA, '.publisher-test-destination-hidden-rpi-5'))).resolves.toBeUndefined();

    const quarantineJob = 'job-quarantine-destination-race';
    await createStaging(quarantineJob);
    const quarantined = await runBinary(destinationRaceBinary, 'quarantine', '--root', root, '--job-id', quarantineJob);
    expect(quarantined.code).not.toBe(0);
    expect(parsed(quarantined)).toMatchObject({
      quarantined: false,
      mutationCount: 1,
      errorCode: 'QUARANTINE_PENDING',
      destinationRelativePath: `.osi-image-builder/quarantine/${quarantineJob}`,
    });
    await expect(access(join(root, '.osi-image-builder', 'quarantine', quarantineJob))).resolves.toBeUndefined();
    await expect(access(join(root, '.osi-image-builder', 'quarantine', `.publisher-test-destination-hidden-${quarantineJob}`))).resolves.toBeUndefined();
  });

  it('rejects detached ancestor names before rename and after a completed rename', async () => {
    const beforeJob = 'job-ancestor-before';
    await createStaging(beforeJob);
    const before = await runBinary(ancestorBeforeBinary, 'publish', '--root', root, '--job-id', beforeJob, '--branch', 'feature%2Fancestor-before', '--sha', SHA, '--target', TARGET);
    expect(before.code).not.toBe(0);
    expect(parsed(before)).toMatchObject({ published: false, mutationCount: 2, errorCode: 'PUBLISH_FAILED' });
    await expect(access(join(root, 'feature%2Fancestor-before', SHA, TARGET))).rejects.toMatchObject({ code: 'ENOENT' });

    const afterJob = 'job-ancestor-after';
    await createStaging(afterJob);
    const after = await runBinary(ancestorAfterBinary, 'publish', '--root', root, '--job-id', afterJob, '--branch', 'feature%2Fancestor-after', '--sha', SHA, '--target', TARGET);
    expect(after.code).not.toBe(0);
    expect(parsed(after)).toMatchObject({ published: false, mutationCount: 3, errorCode: 'PUBLISH_FAILED', renameResult: 'RENAMED' });
    await expect(access(join(root, 'feature%2Fancestor-after', SHA, TARGET))).rejects.toMatchObject({ code: 'ENOENT' });

    const quarantineJob = 'job-quarantine-ancestor-after';
    await createStaging(quarantineJob);
    const quarantine = await runBinary(ancestorAfterBinary, 'quarantine', '--root', root, '--job-id', quarantineJob);
    expect(quarantine.code).not.toBe(0);
    expect(parsed(quarantine)).toMatchObject({ quarantined: false, mutationCount: 1, errorCode: 'QUARANTINE_PENDING', renameResult: 'RENAMED' });
    await expect(access(join(root, '.osi-image-builder', 'quarantine', quarantineJob))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports only a structural candidate and blocks candidate-plus-staging recovery', async () => {
    const candidateBranch = 'feature%2Fcandidate';
    const candidate = join(root, candidateBranch, SHA, TARGET);
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, 'factory.img.gz'), 'corrupt');
    await writeFile(join(candidate, 'sha256sums'), 'wrong  factory.img.gz\n');
    await writeFile(join(candidate, 'build-manifest.json'), '{}\n');
    await writeFile(join(candidate, 'verification.json'), '{}\n');
    const candidateResult = await runPublisher('recheck', '--root', root, '--job-id', 'job-no-staging', '--branch', candidateBranch, '--sha', SHA, '--target', TARGET);
    expect(candidateResult.code).toBe(0);
    expect(parsed(candidateResult)).toMatchObject({ destination: 'candidate', staging: 'absent', mutationCount: 0 });

    const blockedJob = 'job-candidate-with-staging';
    await createStaging(blockedJob);
    const blocked = await runPublisher('recheck', '--root', root, '--job-id', blockedJob, '--branch', candidateBranch, '--sha', SHA, '--target', TARGET);
    expect(blocked.code).toBe(0);
    expect(parsed(blocked)).toMatchObject({ destination: 'mismatched', staging: 'present', errorCode: 'UNVERIFIED_FINAL_PATH_BLOCKER' });

    const swappedBranch = 'feature%2Frecheck-swap';
    const swappedDestination = join(root, swappedBranch, SHA, TARGET);
    await mkdir(swappedDestination, { recursive: true });
    await writeFile(join(swappedDestination, 'factory.img.gz'), 'candidate');
    await writeFile(join(swappedDestination, 'sha256sums'), 'candidate  factory.img.gz\n');
    await writeFile(join(swappedDestination, 'build-manifest.json'), '{}\n');
    await writeFile(join(swappedDestination, 'verification.json'), '{}\n');
    const swapped = await runBinary(destinationRaceBinary, 'recheck', '--root', root, '--job-id', 'job-recheck-swap', '--branch', swappedBranch, '--sha', SHA, '--target', TARGET);
    expect(swapped.code).toBe(2);
    expect(parsed(swapped)).toMatchObject({ destination: 'unknown', staging: 'unknown', errorCode: 'PUBLISH_RECOVERY_FAILED' });
  });

  it('classifies existing branch, SHA, and final symlinks as explicit recovery blockers', async () => {
    const cases = [
      { branch: 'feature%2Fsymlink-branch', level: 'branch' },
      { branch: 'feature%2Fsymlink-sha', level: 'sha' },
      { branch: 'feature%2Fsymlink-target', level: 'target' },
    ] as const;
    for (const item of cases) {
      if (item.level === 'branch') {
        await symlink('/tmp', join(root, item.branch));
      } else {
        await mkdir(join(root, item.branch), { recursive: true });
        if (item.level === 'sha') await symlink('/tmp', join(root, item.branch, SHA));
        else {
          await mkdir(join(root, item.branch, SHA), { recursive: true });
          await symlink('/tmp', join(root, item.branch, SHA, TARGET));
        }
      }
      const response = await runPublisher('recheck', '--root', root, '--job-id', `job-${item.level}-symlink`, '--branch', item.branch, '--sha', SHA, '--target', TARGET);
      expect(response.code).toBe(0);
      expect(parsed(response)).toMatchObject({
        destination: 'mismatched',
        staging: 'absent',
        errorCode: 'UNVERIFIED_FINAL_PATH_BLOCKER',
        mutationCount: 0,
      });
    }

    const racedBranch = 'feature%2Fsha-blocker-branch-race';
    await mkdir(join(root, racedBranch), { recursive: true });
    await symlink('/tmp', join(root, racedBranch, SHA));
    const raced = await runBinary(branchParentAfterBinary, 'recheck', '--root', root, '--job-id', 'job-sha-blocker-branch-race', '--branch', racedBranch, '--sha', SHA, '--target', TARGET);
    expect(raced.code).toBe(2);
    expect(parsed(raced)).toMatchObject({
      destination: 'unknown',
      staging: 'unknown',
      errorCode: 'PUBLISH_RECOVERY_FAILED',
      mutationCount: 0,
    });
  });

  it('keeps explicit source and kernel evidence when quarantine collides', async () => {
    const jobId = 'job-quarantine-collision';
    await createStaging(jobId);
    const destination = join(root, '.osi-image-builder', 'quarantine', jobId);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'keep.txt'), 'keep');
    const collision = await runPublisher('quarantine', '--root', root, '--job-id', jobId);
    expect(collision.code).not.toBe(0);
    expect(parsed(collision)).toMatchObject({
      quarantined: false,
      mutationCount: 0,
      errorCode: 'QUARANTINE_PENDING',
      renameResult: 'EEXIST',
      sourceRelativePath: `.osi-image-builder/staging/${jobId}`,
      destinationRelativePath: `.osi-image-builder/quarantine/${jobId}`,
    });
    await expect(readFile(join(destination, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(join(root, '.osi-image-builder', 'staging', jobId))).resolves.toBeUndefined();
  });
});
