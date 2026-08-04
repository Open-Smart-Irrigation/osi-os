import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDependencyEgressCredential,
  discoverDependencyEgressCredentials,
  destroyDependencyEgressCredential,
} from '../../runner/src/dependency-egress-credential.js';
import { DEPENDENCY_EGRESS_CREDENTIAL_PATH } from '../../runner/src/dependency-egress-proxy.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('dependency egress credential lifecycle', () => {
  it('creates an exclusive mode-0400 per-operation credential and persists only its hash identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });

    const credential = await createDependencyEgressCredential({
      directory,
      jobId: 'job-1',
      operationId: 'frontend-install',
      attempt: 1,
    });
    const metadata = await stat(credential.hostPath);
    const secret = await readFile(credential.hostPath, 'utf8');

    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o400);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{48}$/u);
    expect(credential).toEqual({
      hostPath: join(directory, 'frontend-install-1.proxy-credential'),
      containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(credential)).not.toContain(secret);

    await expect(createDependencyEgressCredential({
      directory,
      jobId: 'job-1',
      operationId: 'frontend-install',
      attempt: 1,
    })).rejects.toThrow(/exists|credential/u);
  });

  it('verifies the hash before deletion and attests that the credential is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const credential = await createDependencyEgressCredential({
      directory,
      jobId: 'job-1',
      operationId: 'build-image',
      attempt: 2,
    });

    await expect(destroyDependencyEgressCredential(credential)).resolves.toMatchObject({
      kind: 'credential-only',
      hostPath: credential.hostPath,
      expectedSha256: credential.sha256,
      observedSha256: credential.sha256,
      tls: { hostDirectory: `${credential.hostPath.slice(0, -'.proxy-credential'.length)}.proxy-tls`, absent: true },
      absent: true,
    });
    await expect(access(credential.hostPath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(destroyDependencyEgressCredential(credential)).resolves.toMatchObject({
      kind: 'credential-only',
      hostPath: credential.hostPath,
      expectedSha256: credential.sha256,
      observedSha256: null,
      tls: { hostDirectory: `${credential.hostPath.slice(0, -'.proxy-credential'.length)}.proxy-tls`, absent: true },
      absent: true,
    });
  });

  it('does not reuse a durable hash when the credential is already absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const identity = {
      hostPath: join(directory, 'frontend-install-1.proxy-credential'),
      containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
      sha256: 'a'.repeat(64),
    } as const;

    await expect(destroyDependencyEgressCredential(identity)).resolves.toMatchObject({
      kind: 'credential-only',
      hostPath: identity.hostPath,
      expectedSha256: identity.sha256,
      observedSha256: null,
      tls: { hostDirectory: `${identity.hostPath.slice(0, -'.proxy-credential'.length)}.proxy-tls`, absent: true },
      absent: true,
    });
  });

  it('recovers an owned crash-left partial deterministic credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'frontend-install-1.proxy-credential');
    await writeFile(path, '', { mode: 0o400 });
    await chmod(path, 0o400);

    const credential = await createDependencyEgressCredential({
      directory,
      jobId: 'job-1',
      operationId: 'frontend-install',
      attempt: 1,
    });

    expect(credential.hostPath).toBe(path);
    expect(await readFile(path, 'utf8')).toMatch(/^[A-Za-z0-9_-]{48}$/u);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
  });

  it('does not remove TLS material when a crash-left partial credential fails validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'frontend-install-1.proxy-credential');
    const tls = join(directory, 'frontend-install-1.proxy-tls');
    await writeFile(path, 'invalid+partial', { mode: 0o400 });
    await mkdir(tls, { mode: 0o700 });
    await writeFile(join(tls, 'ca.key'), 'crash-left signing key', { mode: 0o400 });

    await expect(createDependencyEgressCredential({
      directory,
      jobId: 'job-1',
      operationId: 'frontend-install',
      attempt: 1,
    })).rejects.toThrow(/credential|partial|created/u);

    await expect(access(tls, constants.F_OK)).resolves.toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('invalid+partial');
  });

  it.each([
    ['unsafe mode', 'partial', 0o600],
    ['invalid bytes', 'not+base64url', 0o400],
  ])('does not replace an owned partial credential with %s', async (_case, contents, mode) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'frontend-install-1.proxy-credential');
    await writeFile(path, contents, { mode });
    await chmod(path, mode);

    await expect(createDependencyEgressCredential({
      directory,
      jobId: 'job-1',
      operationId: 'frontend-install',
      attempt: 1,
    })).rejects.toThrow(/credential|partial|created/u);

    expect(await readFile(path, 'utf8')).toBe(contents);
    expect((await stat(path)).mode & 0o777).toBe(mode);
  });

  it('discovers exact crash-left credentials without reading names from branch input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const frontend = await createDependencyEgressCredential({ directory, jobId: 'job-1', operationId: 'frontend-install', attempt: 3 });
    const build = await createDependencyEgressCredential({ directory, jobId: 'job-1', operationId: 'build-image', attempt: 2 });

    await expect(discoverDependencyEgressCredentials(directory)).resolves.toEqual([
      { kind: 'credential-only', identity: build, hostDirectory: `${build.hostPath.slice(0, -'.proxy-credential'.length)}.proxy-tls` },
      { kind: 'credential-only', identity: frontend, hostDirectory: `${frontend.hostPath.slice(0, -'.proxy-credential'.length)}.proxy-tls` },
    ]);
  });

  it.each([
    ['TLS-only', false],
    ['TLS beside a complete credential', true],
  ] as const)('discovers a canonical non-destructive %s crash remnant', async (_case, withCredential) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const credential = withCredential
      ? await createDependencyEgressCredential({ directory, jobId: 'job-1', operationId: 'build-image', attempt: 4 })
      : null;
    const tls = join(directory, 'build-image-4.proxy-tls');
    await mkdir(tls, { mode: 0o700 });
    await writeFile(join(tls, 'ca.pem'), 'crash-left CA', { mode: 0o444 });

    await expect(discoverDependencyEgressCredentials(directory)).resolves.toEqual(credential === null
      ? [{ kind: 'tls-only', operationId: 'build-image', attempt: 4, credentialHostPath: join(directory, 'build-image-4.proxy-credential'), hostDirectory: tls }]
      : [{ kind: 'normal', identity: credential, hostDirectory: tls }]);
    await expect(access(tls, constants.F_OK)).resolves.toBeUndefined();
  });

  it('does not remove TLS before credential verification can block cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const credential = await createDependencyEgressCredential({ directory, jobId: 'job-1', operationId: 'build-image', attempt: 5 });
    const tls = join(directory, 'build-image-5.proxy-tls');
    await mkdir(tls, { mode: 0o700 });
    await writeFile(join(tls, 'ca.key'), 'crash-left signing key', { mode: 0o400 });
    await chmod(credential.hostPath, 0o600);

    await expect(destroyDependencyEgressCredential(credential)).rejects.toThrow(/metadata|credential/u);
    await expect(access(tls, constants.F_OK)).resolves.toBeUndefined();
    await expect(access(credential.hostPath, constants.F_OK)).resolves.toBeUndefined();
  });

  it('attests a TLS-only remnant when the credential was already removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const credential = await createDependencyEgressCredential({ directory, jobId: 'job-1', operationId: 'build-image', attempt: 7 });
    const hostDirectory = join(directory, 'build-image-7.proxy-tls');
    await mkdir(hostDirectory, { mode: 0o700 });
    await rm(credential.hostPath);

    await expect(destroyDependencyEgressCredential(credential)).resolves.toEqual({
      kind: 'tls-only',
      hostPath: credential.hostPath,
      expectedSha256: credential.sha256,
      observedSha256: null,
      tls: { hostDirectory, absent: true },
      absent: true,
    });
    await expect(access(hostDirectory, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a noncanonical credential identity before touching its sibling TLS directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    roots.push(root);
    const directory = join(root, 'trusted-runtime');
    await mkdir(directory, { mode: 0o700 });
    const canonical = await createDependencyEgressCredential({ directory, jobId: 'job-1', operationId: 'build-image', attempt: 6 });
    const value = await readFile(canonical.hostPath, 'utf8');
    const hostPath = join(directory, 'branch-controlled.proxy-credential');
    const tls = join(directory, 'branch-controlled.proxy-tls');
    await writeFile(hostPath, value, { mode: 0o400 });
    await mkdir(tls, { mode: 0o700 });
    await writeFile(join(tls, 'ca.key'), 'must remain', { mode: 0o400 });

    await expect(destroyDependencyEgressCredential({ ...canonical, hostPath })).rejects.toThrow(/canonical|identity|credential/iu);
    await expect(readFile(join(tls, 'ca.key'), 'utf8')).resolves.toBe('must remain');
    await expect(readFile(hostPath, 'utf8')).resolves.toBe(value);
  });
});
