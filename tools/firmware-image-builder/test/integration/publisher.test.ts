import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const publisherDirectory = join(process.cwd(), 'publisher');
const binary = join(publisherDirectory, 'osi-image-publish');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TARGET = 'rpi-5';
let base = '';
let root = '';
let staging = '';

async function runPublisher(...argv: string[]) {
  try {
    const response = await execFile(binary, argv, { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    return { code: 0, stdout: response.stdout.trim(), stderr: response.stderr.trim() };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: (failure.stdout ?? '').trim(), stderr: (failure.stderr ?? '').trim() };
  }
}

function parsed(response: { stdout: string }): Record<string, unknown> {
  return JSON.parse(response.stdout) as Record<string, unknown>;
}

async function createStaging(jobId: string): Promise<string> {
  const path = join(root, '.osi-image-builder', 'staging', jobId);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'factory.img.gz'), 'factory image');
  await writeFile(join(path, 'sha256sums'), 'checksum  factory.img.gz\n');
  await writeFile(join(path, 'build-manifest.json'), '{"schemaVersion":1}\n');
  await writeFile(join(path, 'verification.json'), '{"schemaVersion":1}\n');
  return path;
}

describe('native publisher integration', () => {
  beforeAll(async () => {
    await execFile('make', ['-C', publisherDirectory, 'clean', 'all'], { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    base = await mkdtemp('/tmp/osi-image-publisher-');
    root = join(base, 'images');
    staging = join(root, '.osi-image-builder', 'staging');
    await mkdir(staging, { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(binary, { force: true });
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
    expect(parsed(published)).toMatchObject({ available: true, published: true, mutationCount: 1, renameResult: 'RENAME_NOREPLACE' });
    await expect(access(join(root, 'feature%2Fpublisher', SHA, TARGET))).resolves.toBeUndefined();
    const complete = await runPublisher('recheck', '--root', root, '--job-id', jobId, '--branch', 'feature%2Fpublisher', '--sha', SHA, '--target', TARGET);
    expect(complete.code).toBe(0);
    expect(parsed(complete)).toMatchObject({ available: true, destination: 'complete', staging: 'absent', mutationCount: 0 });

    const collisionJob = 'job-collision';
    await createStaging(collisionJob);
    const finalPath = join(root, 'feature%2Fcollision', SHA, TARGET);
    await mkdir(finalPath, { recursive: true });
    await writeFile(join(finalPath, 'keep.txt'), 'keep');
    const collision = await runPublisher('publish', '--root', root, '--job-id', collisionJob, '--branch', 'feature%2Fcollision', '--sha', SHA, '--target', TARGET);
    expect(collision.code).not.toBe(0);
    expect(parsed(collision)).toMatchObject({ available: true, published: false, errorCode: 'OUTPUT_COLLISION', mutationCount: 0 });
    await expect(readFile(join(finalPath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(join(root, '.osi-image-builder', 'staging', collisionJob))).resolves.toBeUndefined();

    const quarantineJob = 'job-quarantine';
    await createStaging(quarantineJob);
    const quarantined = await runPublisher('quarantine', '--root', root, '--job-id', quarantineJob);
    expect(quarantined.code).toBe(0);
    expect(parsed(quarantined)).toMatchObject({ available: true, quarantined: true, mutationCount: 1, renameResult: 'RENAME_NOREPLACE' });
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
    expect(parsed(rejected)).toMatchObject({ published: false, errorCode: 'INVALID_ARGUMENT' });

    const traversal = await runPublisher('publish', '--root', root, '--job-id', '../outside', '--branch', 'feature%2Fbad', '--sha', SHA, '--target', TARGET);
    expect(traversal.code).not.toBe(0);
    expect(parsed(traversal)).toMatchObject({ published: false, errorCode: 'INVALID_ARGUMENT', mutationCount: 0 });

    const blockDevice = await runPublisher('--self-test', '--root', '/dev/null');
    expect(blockDevice.code).not.toBe(0);
    expect(parsed(blockDevice)).toMatchObject({ published: false, errorCode: 'INVALID_ARGUMENT', mutationCount: 0 });
    expect(fsConstants.O_NOFOLLOW).toBeTypeOf('number');
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
});
