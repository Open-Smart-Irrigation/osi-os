import { createHash, X509Certificate } from 'node:crypto';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDependencyEgressTlsMaterial,
  verifyDependencyEgressTlsMaterial,
} from '../../runner/src/dependency-egress-tls.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fileIdentity(path: string) {
  const [bytes, metadata] = await Promise.all([readFile(path), lstat(path)]);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: metadata.size,
    mode: metadata.mode & 0o777,
    uid: metadata.uid,
    gid: metadata.gid,
    device: metadata.dev,
    inode: metadata.ino,
    links: metadata.nlink,
  };
}

async function fixture(hosts = ['registry.npmjs.org', 'evil.example'], jobId = 'job-1') {
  const root = await mkdtemp(join(tmpdir(), 'osi-egress-tls-'));
  roots.push(root);
  const directory = join(root, 'trusted-runtime');
  await mkdir(directory, { mode: 0o700 });
  return createDependencyEgressTlsMaterial({
    credentialHostPath: join(directory, 'frontend-install-1.proxy-credential'),
    jobId,
    operationId: 'frontend-install',
    attempt: 1,
    allowedHosts: hosts,
  });
}

describe('dependency egress TLS identity', () => {
  it('bounds the CA subject for a production-length job identity without exposing identifiers', async () => {
    const jobId = 'job_2a9e64276d8a4b6ab03df786662231fe';
    const material = await fixture(['registry.npmjs.org'], jobId);
    const certificate = new X509Certificate(await readFile(material.caCertificateHostPath));

    expect(Buffer.byteLength(certificate.subject, 'utf8')).toBeLessThanOrEqual(64);
    expect(certificate.subject).toBe('CN=OSI image builder');
    expect(certificate.subject).not.toContain(jobId);
    expect(certificate.subject).not.toContain('frontend-install');
  });

  it('persists exact hashes and metadata while removing every signing artifact', async () => {
    const material = await fixture();
    expect((await lstat(material.hostDirectory)).mode & 0o777).toBe(0o700);
    expect(material.directoryMetadata).toEqual(expect.objectContaining({ mode: 0o700, uid: expect.any(Number), gid: expect.any(Number), device: expect.any(Number), inode: expect.any(Number) }));
    expect(material.caCertificateMetadata).toEqual(await fileIdentity(material.caCertificateHostPath));
    for (const leaf of Object.values(material.leafCertificates)) {
      expect(leaf.certificateMetadata).toEqual(await fileIdentity(leaf.certificateHostPath));
      expect(leaf.keyMetadata).toEqual(await fileIdentity(leaf.keyHostPath));
    }
    expect(await readdir(material.hostDirectory)).toEqual([
      'ca.pem',
      'evil_example.key',
      'evil_example.pem',
      'registry_npmjs_org.key',
      'registry_npmjs_org.pem',
    ]);
    for (const forbidden of ['ca.key', 'ca.srl', 'evil_example.csr', 'evil_example.ext', 'registry_npmjs_org.csr', 'registry_npmjs_org.ext']) {
      await expect(access(join(material.hostDirectory, forbidden), constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(verifyDependencyEgressTlsMaterial(material, ['registry.npmjs.org', 'evil.example'])).resolves.toBeUndefined();
  });

  it('cryptographically rejects a same-CA leaf whose SAN is for another allowlisted host', async () => {
    const material = await fixture();
    const expected = material.leafCertificates['registry.npmjs.org']!;
    const wrong = material.leafCertificates['evil.example']!;
    await chmod(expected.certificateHostPath, 0o600);
    await chmod(expected.keyHostPath, 0o600);
    await copyFile(wrong.certificateHostPath, expected.certificateHostPath);
    await copyFile(wrong.keyHostPath, expected.keyHostPath);
    await chmod(expected.certificateHostPath, 0o444);
    await chmod(expected.keyHostPath, 0o400);
    const forged = {
      ...material,
      leafCertificates: {
        ...material.leafCertificates,
        'registry.npmjs.org': {
          certificateHostPath: expected.certificateHostPath,
          keyHostPath: expected.keyHostPath,
          certificateMetadata: await fileIdentity(expected.certificateHostPath),
          keyMetadata: await fileIdentity(expected.keyHostPath),
        },
      },
    };
    await expect(verifyDependencyEgressTlsMaterial(forged, ['registry.npmjs.org', 'evil.example'])).rejects.toThrow(/SAN|host|certificate/iu);
  });

  it('cryptographically rejects a leaf/private-key mismatch with matching persisted file hashes', async () => {
    const material = await fixture();
    const expected = material.leafCertificates['registry.npmjs.org']!;
    const wrong = material.leafCertificates['evil.example']!;
    await chmod(expected.keyHostPath, 0o600);
    await copyFile(wrong.keyHostPath, expected.keyHostPath);
    await chmod(expected.keyHostPath, 0o400);
    const forged = {
      ...material,
      leafCertificates: {
        ...material.leafCertificates,
        'registry.npmjs.org': {
          ...expected,
          keyMetadata: await fileIdentity(expected.keyHostPath),
        },
      },
    };
    await expect(verifyDependencyEgressTlsMaterial(forged, ['registry.npmjs.org', 'evil.example'])).rejects.toThrow(/key|certificate/iu);
  });

  it('cryptographically rejects a leaf signed by a different per-attempt CA', async () => {
    const material = await fixture(['registry.npmjs.org']);
    const other = await fixture(['registry.npmjs.org']);
    const expected = material.leafCertificates['registry.npmjs.org']!;
    const wrong = other.leafCertificates['registry.npmjs.org']!;
    await chmod(expected.certificateHostPath, 0o600);
    await chmod(expected.keyHostPath, 0o600);
    await copyFile(wrong.certificateHostPath, expected.certificateHostPath);
    await copyFile(wrong.keyHostPath, expected.keyHostPath);
    await chmod(expected.certificateHostPath, 0o444);
    await chmod(expected.keyHostPath, 0o400);
    const forged = {
      ...material,
      leafCertificates: {
        'registry.npmjs.org': {
          certificateHostPath: expected.certificateHostPath,
          keyHostPath: expected.keyHostPath,
          certificateMetadata: await fileIdentity(expected.certificateHostPath),
          keyMetadata: await fileIdentity(expected.keyHostPath),
        },
      },
    };
    await expect(verifyDependencyEgressTlsMaterial(forged, ['registry.npmjs.org'])).rejects.toThrow(/chain|issuer|certificate|signature/iu);
  });
});
