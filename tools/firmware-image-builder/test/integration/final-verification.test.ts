import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The final verifier is a JavaScript entrypoint without a separate declaration file.
import { verifyReleasePair } from '../../scripts/run-workstation-test.mjs';

const temporaryDirectories: string[] = [];

function productionLock(packageVersion: string): Readonly<Record<string, unknown>> {
  const llvmMajor = 18;
  const baseImageDigest = 'b'.repeat(64);
  return {
    schemaVersion: 1,
    packageVersion,
    imageRepository: 'osi/image-builder',
    imageDigest: 'a'.repeat(64),
    baseImage: `ubuntu@sha256:${baseImageDigest}`,
    baseImageDigest,
    dockerfileSha256: 'c'.repeat(64),
    packageSet: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libzstd-dev', `libpolly-${llvmMajor}-dev`],
    rustConfig: {
      llvmConfig: '/usr/bin/llvm-config',
      channel: 'stable',
      version: '1.88.0',
      llvmMajor,
    },
    nodeVersion: '22.17.0',
    executionDefinitionSha256: 'd'.repeat(64),
    validationEvidenceSha256: 'e'.repeat(64),
    dependencyEgressProxySha256: '1'.repeat(64),
    installable: true,
    publisherSha256: 'f'.repeat(64),
  };
}

async function writeRelease(
  root: string,
  targetId: 'rpi-5' | 'rpi-2',
  imageContents: string,
  lockVersion = '2026.07.29.1',
  lockValue: Readonly<Record<string, unknown>> = productionLock(lockVersion),
): Promise<void> {
  const release = join(root, targetId);
  await mkdir(release, { recursive: true });
  const lock = `${JSON.stringify(lockValue)}\n`;
  const lockSha256 = createHash('sha256').update(lock).digest('hex');
  const image = Buffer.from(imageContents);
  const imageSha256 = createHash('sha256').update(image).digest('hex');
  await writeFile(join(release, 'builder.lock.json'), lock);
  await writeFile(join(release, 'image.img'), image);
  await writeFile(join(release, 'sha256sums'), `${imageSha256}  image.img\n`);
  await writeFile(join(release, 'verification.json'), JSON.stringify({ verified: true, targetId, imageSha256 }));
  await writeFile(join(release, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    targetId,
    installedLockSha256: lockSha256,
    imageSha256,
  }));
  for (const name of ['builder.lock.json', 'image.img', 'sha256sums', 'verification.json', 'manifest.json']) {
    await chmod(join(release, name), 0o444);
  }
  await chmod(release, 0o555);
}

describe('final release verification', () => {
  it('accepts both immutable target release directories only when their evidence agrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    await writeRelease(root, 'rpi-2', 'same image');
    await expect(verifyReleasePair(root)).resolves.toMatchObject({ ok: true, mutation: 'none' });
  });

  it('rejects a missing target release or any mutable release component', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_INCOMPLETE' });
    await writeRelease(root, 'rpi-2', 'same image');
    await chmod(join(root, 'rpi-2', 'manifest.json'), 0o644);
    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_MUTABLE' });
  });

  it('rejects mismatched checksum, lock digest, or verification evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'image five');
    await writeRelease(root, 'rpi-2', 'image two');
    await chmod(join(root, 'rpi-2', 'sha256sums'), 0o644);
    await writeFile(join(root, 'rpi-2', 'sha256sums'), `${'0'.repeat(64)}  image.img\n`);
    await chmod(join(root, 'rpi-2', 'sha256sums'), 0o444);
    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_EVIDENCE_MISMATCH' });
  });

  it('rejects symlinked release directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    const realRoot = await mkdtemp(join(tmpdir(), 'osi-final-verification-real-'));
    temporaryDirectories.push(realRoot);
    await writeRelease(realRoot, 'rpi-2', 'same image');
    await symlink(join(realRoot, 'rpi-2'), join(root, 'rpi-2'));
    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_MUTABLE' });
    expect((await lstat(join(root, 'rpi-2'))).isSymbolicLink()).toBe(true);
  });

  it.each(['builder.lock.json', 'image.img', 'sha256sums', 'verification.json', 'manifest.json'])('rejects a hardlinked release file: %s', async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    await writeRelease(root, 'rpi-2', 'same image');
    await link(join(root, 'rpi-5', name), join(root, `${name}.alias`));

    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_MUTABLE' });
  });

  it('rejects target releases with different exact installed locks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image', '2026.07.29.1');
    await writeRelease(root, 'rpi-2', 'same image', '2026.07.29.2');

    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_EVIDENCE_MISMATCH' });
  });

  it('rejects an exact but incomplete generated production lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    const incompleteLock = {
      schemaVersion: 1,
      packageVersion: '2026.07.29.1',
      imageDigest: 'a'.repeat(64),
      installable: true,
    };
    await writeRelease(root, 'rpi-5', 'same image', '2026.07.29.1', incompleteLock);
    await writeRelease(root, 'rpi-2', 'same image', '2026.07.29.1', incompleteLock);

    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_EVIDENCE_MISMATCH' });
  });

  it('rejects oversized release evidence before parsing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    await writeRelease(root, 'rpi-2', 'same image');
    const verificationPath = join(root, 'rpi-5', 'verification.json');
    const imageSha256 = createHash('sha256').update('same image').digest('hex');
    await chmod(verificationPath, 0o644);
    await writeFile(verificationPath, JSON.stringify({
      verified: true,
      targetId: 'rpi-5',
      imageSha256,
      padding: 'x'.repeat(65_536),
    }));
    await chmod(verificationPath, 0o444);

    await expect(verifyReleasePair(root)).rejects.toMatchObject({ code: 'RELEASE_MUTABLE' });
  });

  it('rejects an oversized image before hashing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    await writeRelease(root, 'rpi-2', 'same image');

    await expect(verifyReleasePair(root, { maxImageBytes: 8 })).rejects.toMatchObject({ code: 'RELEASE_MUTABLE' });
  });

  it('rejects a release file pathname swap after opening the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    temporaryDirectories.push(root);
    await writeRelease(root, 'rpi-5', 'same image');
    await writeRelease(root, 'rpi-2', 'same image');
    const release = join(root, 'rpi-5');
    const manifestPath = join(release, 'manifest.json');
    const original = await readFile(manifestPath);
    let swapped = false;

    await expect(verifyReleasePair(root, {
      hooks: {
        afterFileOpen: async ({ targetId, name }: { targetId: string; name: string }) => {
          if (swapped || targetId !== 'rpi-5' || name !== 'manifest.json') return;
          swapped = true;
          await chmod(release, 0o755);
          await rename(manifestPath, join(release, 'manifest-old.json'));
          await writeFile(manifestPath, original, { mode: 0o444 });
          await chmod(release, 0o555);
        },
      },
    })).rejects.toMatchObject({ code: 'RELEASE_MUTABLE' });
    expect(swapped).toBe(true);
  });

  it('rejects a target directory swap after opening the directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-final-verification-'));
    const replacementRoot = await mkdtemp(join(tmpdir(), 'osi-final-verification-replacement-'));
    temporaryDirectories.push(root, replacementRoot);
    await writeRelease(root, 'rpi-5', 'same image');
    await writeRelease(root, 'rpi-2', 'same image');
    await writeRelease(replacementRoot, 'rpi-5', 'same image');
    let swapped = false;

    await expect(verifyReleasePair(root, {
      hooks: {
        afterDirectoryOpen: async ({ targetId }: { targetId: string }) => {
          if (swapped || targetId !== 'rpi-5') return;
          swapped = true;
          await rename(join(root, 'rpi-5'), join(root, 'rpi-5-old'));
          await rename(join(replacementRoot, 'rpi-5'), join(root, 'rpi-5'));
        },
      },
    })).rejects.toMatchObject({ code: 'RELEASE_MUTABLE' });
    expect(swapped).toBe(true);
  });
});

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) {
    const makeWritable = async (path: string): Promise<void> => {
      const snapshot = await lstat(path);
      if (snapshot.isSymbolicLink()) return;
      if (snapshot.isDirectory()) {
        await chmod(path, 0o755);
        for (const entry of await readdir(path)) await makeWritable(join(path, entry));
      } else {
        await chmod(path, 0o644);
      }
    };
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});
