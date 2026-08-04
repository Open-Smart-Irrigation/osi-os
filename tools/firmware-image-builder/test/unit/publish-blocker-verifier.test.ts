import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, open, readdir, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type LoadedConfig } from '../../config/load.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import { JSON_LIMITS, TEXT_LIMITS } from '../../api/src/validation.js';
import type { JobRecord } from '../../api/src/store.js';
import {
  PublishBlockerFinalVerifierError,
  createPublishBlockerFinalVerifier,
} from '../../api/src/publish-blocker-verifier.js';

const ROOT_ID = 'sdcard-images';
const JOB_ID = 'verify-job';
const BRANCH = 'design/agrolink';
const SHA = 'a'.repeat(40);
const ARTIFACT_NAME = 'osi-rpi-5.img.gz';
const ARTIFACT_BYTES = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
const CHECKSUM_BYTES = Buffer.from('checksum evidence\n', 'utf8');
const MANIFEST_BYTES = Buffer.from('{"schemaVersion":1,"target":"rpi-5"}\n', 'utf8');
const VERIFICATION_BYTES = Buffer.from('{"schemaVersion":1,"verified":true}\n', 'utf8');
const ARTIFACT_MTIME = new Date('2026-07-29T10:11:12.345Z');
const OLD_ATIME = new Date('2020-01-02T03:04:05.000Z');
const OLD_MTIME = new Date('2020-01-02T03:04:06.000Z');
const FINAL_DIRECTORY = `${encodeBranchSlug(BRANCH)}/${SHA}/rpi-5`;
const FINAL_PATH = `${FINAL_DIRECTORY}/${ARTIFACT_NAME}`;

const temporaryDirectories: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function minimalJob(overrides: Record<string, unknown> = {}): JobRecord {
  return {
    jobId: JOB_ID,
    rootId: ROOT_ID,
    branch: BRANCH,
    pinnedSha: SHA,
    targetId: 'rpi-5',
    state: 'failed',
    publishState: 'blocked',
    publishBlockerCode: 'UNVERIFIED_FINAL_PATH_BLOCKER',
    artifactSha256: sha256(ARTIFACT_BYTES),
    artifactSize: ARTIFACT_BYTES.byteLength,
    artifactMtime: ARTIFACT_MTIME.toISOString(),
    checksumPath: `staging/${JOB_ID}/sha256sums`,
    checksumSha256: sha256(CHECKSUM_BYTES),
    manifestPath: `staging/${JOB_ID}/build-manifest.json`,
    manifestSha256: sha256(MANIFEST_BYTES),
    verificationPath: `staging/${JOB_ID}/verification.json`,
    verificationSha256: sha256(VERIFICATION_BYTES),
    publishBlocker: {
      binding: {
        jobId: JOB_ID,
        rootId: ROOT_ID,
        branch: BRANCH,
        branchSlug: encodeBranchSlug(BRANCH),
        pinnedSha: SHA,
        targetId: 'rpi-5',
        stagingDirectory: `staging/${JOB_ID}`,
        stagingPath: `staging/${JOB_ID}/${ARTIFACT_NAME}`,
        finalDirectory: FINAL_DIRECTORY,
        finalPath: FINAL_PATH,
        artifactSha256: sha256(ARTIFACT_BYTES),
        artifactSize: ARTIFACT_BYTES.byteLength,
      },
    },
    ...overrides,
  } as unknown as JobRecord;
}

async function createFixture(): Promise<{
  readonly base: string;
  readonly loaded: LoadedConfig;
  readonly root: string;
  readonly finalDirectory: string;
  readonly finalPath: string;
  readonly job: JobRecord;
}> {
  const base = await mkdtemp(join(tmpdir(), 'osi-image-builder-final-verifier-'));
  temporaryDirectories.push(base);
  const configHome = join(base, 'config-home');
  const stateHome = join(base, 'state-home');
  const repository = join(base, 'repository');
  const root = join(base, 'images');
  const configRoot = join(configHome, 'osi-image-builder');
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(repository, { mode: 0o700 });
  await mkdir(root, { mode: 0o750 });
  const configPath = join(configRoot, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath: repository,
    approvedOutputRoots: [{ id: ROOT_ID, label: 'SD card images', path: root }],
    builderLockPath: '/opt/osi-image-builder/2026.07.29/builder.lock.json',
  }), { mode: 0o600 });
  const loaded = await loadConfig({
    configPath,
    env: { HOME: base, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    git: { getOriginPolicy: async () => ({ url: 'git@example.com:osi/osi-os.git', fetchRefspec: '+refs/heads/*:refs/remotes/origin/*' }) },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
  });
  const finalDirectory = join(root, FINAL_DIRECTORY);
  await mkdir(finalDirectory, { recursive: true, mode: 0o750 });
  await chmod(finalDirectory, 0o700);
  const finalPath = join(root, FINAL_PATH);
  const checksumPath = join(finalDirectory, 'sha256sums');
  const manifestPath = join(finalDirectory, 'build-manifest.json');
  const verificationPath = join(finalDirectory, 'verification.json');
  await writeFile(finalPath, ARTIFACT_BYTES, { mode: 0o600 });
  await writeFile(checksumPath, CHECKSUM_BYTES, { mode: 0o600 });
  await writeFile(manifestPath, MANIFEST_BYTES, { mode: 0o600 });
  await writeFile(verificationPath, VERIFICATION_BYTES, { mode: 0o600 });
  await utimes(finalPath, OLD_ATIME, ARTIFACT_MTIME);
  await utimes(checksumPath, OLD_ATIME, OLD_MTIME);
  await utimes(manifestPath, OLD_ATIME, OLD_MTIME);
  await utimes(verificationPath, OLD_ATIME, OLD_MTIME);
  await utimes(join(root, encodeBranchSlug(BRANCH)), OLD_ATIME, OLD_MTIME);
  await utimes(join(root, encodeBranchSlug(BRANCH), SHA), OLD_ATIME, OLD_MTIME);
  await utimes(finalDirectory, OLD_ATIME, OLD_MTIME);
  return { base, loaded, root, finalDirectory, finalPath, job: minimalJob() };
}

function verifier(fixture: Awaited<ReturnType<typeof createFixture>>, options: Parameters<typeof createPublishBlockerFinalVerifier>[1] = {}) {
  return createPublishBlockerFinalVerifier(fixture.loaded.pathAuthorities.approvedRoots, options);
}

async function treeSnapshot(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    result.push(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}:${entry.name}`);
    if (entry.isDirectory()) result.push(...(await treeSnapshot(path)).map((child) => `${entry.name}/${child}`));
  }
  return result;
}

async function descriptorCount(): Promise<number> {
  return (await readdir('/proc/self/fd')).length;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('publish blocker final destination verifier', () => {
  it('verifies the exact destination and does not mutate the output tree', async () => {
    const fixture = await createFixture();
    const before = await treeSnapshot(fixture.root);

    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).resolves.toEqual({
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
      artifact: { sha256: fixture.job.artifactSha256, size: ARTIFACT_BYTES.byteLength, mtime: ARTIFACT_MTIME.toISOString() },
      checksum: { path: `${FINAL_DIRECTORY}/sha256sums`, sha256: fixture.job.checksumSha256 },
      manifest: { path: `${FINAL_DIRECTORY}/build-manifest.json`, sha256: fixture.job.manifestSha256 },
      verification: { path: `${FINAL_DIRECTORY}/verification.json`, sha256: fixture.job.verificationSha256 },
      staging: { path: `staging/${JOB_ID}`, state: 'absent' },
      sealStatus: 'in_progress',
    });
    const result = await verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifact)).toBe(true);
    expect(Object.isFrozen(result.checksum)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.verification)).toBe(true);
    expect(Object.isFrozen(result.staging)).toBe(true);
    await expect(treeSnapshot(fixture.root)).resolves.toEqual(before);
  });

  it('accepts an already sealed release without mutating it', async () => {
    const fixture = await createFixture();
    try {
      await chmod(fixture.finalDirectory, 0o555);
      for (const name of [ARTIFACT_NAME, 'sha256sums', 'build-manifest.json', 'verification.json']) {
        await chmod(join(fixture.finalDirectory, name), 0o444);
      }

      await expect(verifier(fixture).verify({
        job: fixture.job,
        finalDirectory: FINAL_DIRECTORY,
        finalPath: FINAL_PATH,
      })).resolves.toMatchObject({
        finalDirectory: FINAL_DIRECTORY,
        finalPath: FINAL_PATH,
        sealStatus: 'sealed',
      });
      expect((await stat(fixture.finalDirectory)).mode & 0o777).toBe(0o555);
      for (const name of [ARTIFACT_NAME, 'sha256sums', 'build-manifest.json', 'verification.json']) {
        expect((await stat(join(fixture.finalDirectory, name))).mode & 0o777).toBe(0o444);
      }
    } finally {
      await chmod(fixture.finalDirectory, 0o700);
    }
  });

  it.each([
    ['sealed directory with writable files', 0o555, 0o600],
    ['writable directory with an untracked file mode', 0o700, 0o640],
  ] as const)('rejects the incoherent mode tuple: %s', async (_name, directoryMode, fileMode) => {
    const fixture = await createFixture();
    try {
      for (const name of [ARTIFACT_NAME, 'sha256sums', 'build-manifest.json', 'verification.json']) {
        await chmod(join(fixture.finalDirectory, name), fileMode);
      }
      await chmod(fixture.finalDirectory, directoryMode);

      await expect(verifier(fixture).verify({
        job: fixture.job,
        finalDirectory: FINAL_DIRECTORY,
        finalPath: FINAL_PATH,
      })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
    } finally {
      await chmod(fixture.finalDirectory, 0o700);
    }
  });

  it('accepts tracked mixed file modes while the release directory records an interrupted seal', async () => {
    const fixture = await createFixture();
    await chmod(join(fixture.finalDirectory, ARTIFACT_NAME), 0o444);
    await chmod(join(fixture.finalDirectory, 'build-manifest.json'), 0o444);

    await expect(verifier(fixture).verify({
      job: fixture.job,
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
    })).resolves.toMatchObject({ finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH, sealStatus: 'in_progress' });
  });

  it('rejects an otherwise valid release with an untracked directory member', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.finalDirectory, 'unexpected.txt'), 'not part of the release\n', { mode: 0o600 });

    await expect(verifier(fixture).verify({
      job: fixture.job,
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
    })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('rejects a member added during the final staging-absence check', async () => {
    const fixture = await createFixture();
    const finalVerifier = verifier(fixture, {
      beforeStagingRecheck: async () => {
        await writeFile(join(fixture.finalDirectory, 'late-member.txt'), 'late member\n', { mode: 0o600 });
      },
    });

    await expect(finalVerifier.verify({
      job: fixture.job,
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
    })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it.each([
    ['hash', async (fixture: Awaited<ReturnType<typeof createFixture>>) => { await writeFile(fixture.finalPath, Buffer.from('wrong'), { mode: 0o600 }); }],
    ['size', async (fixture: Awaited<ReturnType<typeof createFixture>>) => { await writeFile(fixture.finalPath, Buffer.concat([ARTIFACT_BYTES, Buffer.from('x')]), { mode: 0o600 }); }],
    ['mtime', async (fixture: Awaited<ReturnType<typeof createFixture>>) => { await utimes(fixture.finalPath, new Date('2026-07-29T10:11:13.345Z'), new Date('2026-07-29T10:11:13.345Z')); }],
  ] as const)('rejects an artifact with the wrong %s', async (_kind, mutate) => {
    const fixture = await createFixture();
    await mutate(fixture);
    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it.each(['sha256sums', 'build-manifest.json', 'verification.json'] as const)('rejects a missing sidecar: %s', async (name) => {
    const fixture = await createFixture();
    await unlink(join(fixture.finalDirectory, name));
    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it.each(['sha256sums', 'build-manifest.json', 'verification.json'] as const)('rejects a wrong sidecar hash: %s', async (name) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.finalDirectory, name), Buffer.from('wrong sidecar\n'), { mode: 0o600 });
    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it.each([
    ['checksum', 'sha256sums', TEXT_LIMITS.maxChecksumBytes],
    ['manifest', 'build-manifest.json', Math.min(JSON_LIMITS.maxEncodedBytes, TEXT_LIMITS.maxManifestBytes)],
    ['verification', 'verification.json', Math.min(JSON_LIMITS.maxEncodedBytes, TEXT_LIMITS.maxManifestBytes)],
  ] as const)('rejects an oversized %s sidecar', async (_kind, name, limit) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.finalDirectory, name), Buffer.alloc(limit + 1, 0x61), { mode: 0o600 });
    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('rejects a symlink final ancestor and a symlink artifact', async () => {
    const ancestor = await createFixture();
    const moved = join(ancestor.base, 'moved-branch');
    await rename(join(ancestor.root, encodeBranchSlug(BRANCH)), moved);
    await symlink(moved, join(ancestor.root, encodeBranchSlug(BRANCH)));
    await expect(verifier(ancestor).verify({ job: ancestor.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);

    const artifact = await createFixture();
    await unlink(artifact.finalPath);
    await symlink(join(artifact.base, 'outside.img.gz'), artifact.finalPath);
    await writeFile(join(artifact.base, 'outside.img.gz'), ARTIFACT_BYTES, { mode: 0o600 });
    await expect(verifier(artifact).verify({ job: artifact.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('rejects staging present even when the final files are valid', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.root, '.osi-image-builder', 'staging', JOB_ID), { recursive: true, mode: 0o750 });
    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('accepts existing 0750 staging parents when this job child is absent', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.root, '.osi-image-builder', 'staging'), { recursive: true, mode: 0o750 });
    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).resolves.toMatchObject({
      staging: { path: `staging/${JOB_ID}`, state: 'absent' },
    });
  });

  it('rejects staging recreated after final-file verification', async () => {
    const fixture = await createFixture();
    await expect(verifier(fixture, {
      afterAuthorityRecheck: async () => { await mkdir(join(fixture.root, '.osi-image-builder', 'staging', JOB_ID), { recursive: true, mode: 0o700 }); },
    }).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('propagates an absolute-deadline abort before final revalidation completes', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const reason = new Error('request deadline exceeded');

    await expect(verifier(fixture, {
      beforeFinalRevalidation: () => controller.abort(reason),
    }).verify({
      job: fixture.job,
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  it('closes staging descriptors across repeated between-pass replacement failures', async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.root, '.osi-image-builder', 'staging'), { recursive: true, mode: 0o750 });
    let replacement = 0;
    const target = verifier(fixture, {
      betweenStagingPasses: async () => {
        replacement += 1;
        const builder = join(fixture.root, '.osi-image-builder');
        await rename(builder, `${builder}.replacement-${replacement}`);
        await mkdir(builder, { mode: 0o750 });
        await mkdir(join(builder, 'staging'), { mode: 0o750 });
      },
    });
    const counts: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(target.verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toMatchObject({ code: 'FILE_CHANGED' });
      counts.push(await descriptorCount());
    }
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(4);
  });

  it.each([
    ['branch ancestor', join(encodeBranchSlug(BRANCH)), 0o700],
    ['SHA ancestor', join(encodeBranchSlug(BRANCH), SHA), 0o700],
    ['final leaf', join(FINAL_DIRECTORY), 0o750],
  ] as const)('rejects a %s with the wrong directory mode', async (_description, relativePath, mode) => {
    const fixture = await createFixture();
    await chmod(join(fixture.root, relativePath), mode);
    await expect(verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('does not change tracked final file or directory metadata', async () => {
    const fixture = await createFixture();
    const trackedPaths = [
      join(fixture.root, encodeBranchSlug(BRANCH)),
      join(fixture.root, encodeBranchSlug(BRANCH), SHA),
      fixture.finalDirectory,
      fixture.finalPath,
      join(fixture.finalDirectory, 'sha256sums'),
      join(fixture.finalDirectory, 'build-manifest.json'),
      join(fixture.finalDirectory, 'verification.json'),
    ];
    const before = await Promise.all(trackedPaths.map((path) => stat(path)));
    await verifier(fixture).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH });
    const after = await Promise.all(trackedPaths.map((path) => stat(path)));
    expect(after.map((item) => ({ atimeMs: item.atimeMs, mtimeMs: item.mtimeMs, ctimeMs: item.ctimeMs }))).toEqual(
      before.map((item) => ({ atimeMs: item.atimeMs, mtimeMs: item.mtimeMs, ctimeMs: item.ctimeMs })),
    );
  });

  it('rejects same-inode content mutation with restored mtime', async () => {
    const fixture = await createFixture();
    await expect(verifier(fixture, {
      beforeFinalRevalidation: async () => {
        const handle = await open(fixture.finalPath, 'r+');
        try {
          await handle.write(Buffer.from([0x59]), 0, 1, 0);
          await handle.utimes(OLD_ATIME, ARTIFACT_MTIME);
        } finally {
          await handle.close();
        }
      },
    }).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('rejects inode aliasing between tracked final files', async () => {
    const fixture = await createFixture();
    await unlink(join(fixture.finalDirectory, 'verification.json'));
    await link(join(fixture.finalDirectory, 'build-manifest.json'), join(fixture.finalDirectory, 'verification.json'));
    const job = minimalJob({
      manifestSha256: sha256(MANIFEST_BYTES),
      verificationSha256: sha256(MANIFEST_BYTES),
    });
    await expect(verifier(fixture).verify({ job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('rejects final-file and final-ancestor replacement races', async () => {
    const fileRace = await createFixture();
    await expect(verifier(fileRace, {
      beforeFinalRevalidation: async () => {
        const replacement = `${fileRace.finalPath}.replacement`;
        await rename(fileRace.finalPath, replacement);
        await writeFile(fileRace.finalPath, ARTIFACT_BYTES, { mode: 0o600 });
        await utimes(fileRace.finalPath, ARTIFACT_MTIME, ARTIFACT_MTIME);
      },
    }).verify({ job: fileRace.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);

    const ancestorRace = await createFixture();
    await expect(verifier(ancestorRace, {
      beforeFinalRevalidation: async () => {
        const branch = join(ancestorRace.root, encodeBranchSlug(BRANCH));
        await rename(branch, `${branch}.replacement`);
        await mkdir(join(branch, SHA, 'rpi-5'), { recursive: true, mode: 0o750 });
      },
    }).verify({ job: ancestorRace.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('rejects approved-root authority drift before returning', async () => {
    const fixture = await createFixture();
    await expect(verifier(fixture, {
      beforeAuthorityRecheck: async () => {
        await rename(fixture.root, `${fixture.root}.replacement`);
        await mkdir(fixture.root, { mode: 0o750 });
      },
    }).verify({ job: fixture.job, finalDirectory: FINAL_DIRECTORY, finalPath: FINAL_PATH })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it('rejects a path that is not the job-derived final binding', async () => {
    const fixture = await createFixture();
    await expect(verifier(fixture).verify({
      job: fixture.job,
      finalDirectory: '../outside',
      finalPath: '../outside/image.img.gz',
    })).rejects.toBeInstanceOf(PublishBlockerFinalVerifierError);
  });

  it.each([
    ['wrong job state', { state: 'succeeded' }],
    ['wrong publish state', { publishState: 'published' }],
    ['wrong blocker code', { publishBlockerCode: 'PUBLISH_RECOVERY_FAILED' }],
  ] as const)('rejects %s before filesystem verification', async (_description, override) => {
    const fixture = await createFixture();
    const beforeFinalRevalidation = vi.fn();
    const job = minimalJob(override);
    await expect(verifier(fixture, { beforeFinalRevalidation }).verify({
      job,
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
    })).rejects.toMatchObject({
      code: 'INVALID_BINDING',
    });
    expect(beforeFinalRevalidation).not.toHaveBeenCalled();
  });

  it.each([
    ['branch slug', { branchSlug: 'corrupt-branch' }],
    ['final directory', { finalDirectory: 'corrupt-directory' }],
    ['final path', { finalPath: 'corrupt-directory/image.img.gz' }],
    ['artifact size', { artifactSize: ARTIFACT_BYTES.byteLength + 1 }],
  ] as const)('rejects durable binding corruption: %s', async (_description, corruption) => {
    const fixture = await createFixture();
    const baseBinding = (minimalJob().publishBlocker as unknown as { readonly binding: Record<string, unknown> }).binding;
    const beforeFinalRevalidation = vi.fn();
    const job = minimalJob({ publishBlocker: { binding: { ...baseBinding, ...corruption } } });
    await expect(verifier(fixture, { beforeFinalRevalidation }).verify({
      job,
      finalDirectory: FINAL_DIRECTORY,
      finalPath: FINAL_PATH,
    })).rejects.toMatchObject({ code: 'INVALID_BINDING' });
    expect(beforeFinalRevalidation).not.toHaveBeenCalled();
  });
});
