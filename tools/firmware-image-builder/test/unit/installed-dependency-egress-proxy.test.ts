import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createInstalledDependencyEgressProxyReader,
  type InstalledDependencyEgressProxyReaderOptions,
} from '../../domain/installed-dependency-egress-proxy.js';

const roots: string[] = [];
const OWNER_UID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const PROXY_BYTES = Buffer.from("'use strict';\nmodule.exports = Object.freeze({ value: 1 });\n");
const PROXY_SHA256 = createHash('sha256').update(PROXY_BYTES).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(join(root, '0.1.28', 'operations'), 0o700).catch(() => undefined);
    await chmod(join(root, '0.1.28', 'operations.moved'), 0o700).catch(() => undefined);
    await chmod(join(root, '0.1.28'), 0o700).catch(() => undefined);
    await chmod(join(root, '0.1.28.moved', 'operations'), 0o700).catch(() => undefined);
    await chmod(join(root, '0.1.28.moved'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function installation(): Promise<Readonly<{
  base: string;
  root: string;
  operations: string;
  proxy: string;
}>> {
  const base = await mkdtemp(join(tmpdir(), 'osi-installed-egress-proxy-'));
  roots.push(base);
  const root = join(base, '0.1.28');
  const operations = join(root, 'operations');
  const proxy = join(operations, 'osi-dependency-egress-proxy.cjs');
  await mkdir(operations, { recursive: true, mode: 0o700 });
  await writeFile(proxy, PROXY_BYTES, { mode: 0o600 });
  await chmod(proxy, 0o444);
  await chmod(operations, 0o555);
  await chmod(root, 0o555);
  return Object.freeze({ base, root, operations, proxy });
}

function reader(options: InstalledDependencyEgressProxyReaderOptions = {}) {
  return createInstalledDependencyEgressProxyReader({ ownerUid: OWNER_UID, ...options });
}

describe('installed dependency egress proxy authority', () => {
  it('descriptor-reads exact immutable bytes under the held package root', async () => {
    const fixture = await installation();

    const result = await reader().read(fixture.root, PROXY_SHA256);

    expect(result.bytes).toEqual(PROXY_BYTES);
    expect(result.sha256).toBe(PROXY_SHA256);
    expect(result.identity.package.mode).toBe(0o555);
    expect(result.identity.operations.mode).toBe(0o555);
    expect(result.identity.file.mode).toBe(0o444);
    expect(result.identity.file.nlink).toBe(1);
    expect(result.identity.package.dev).toBe(result.identity.operations.dev);
    expect(result.identity.operations.dev).toBe(result.identity.file.dev);
  });

  it('rejects missing, writable, hash-mismatched, symlinked, multiply-linked, and wrong-owner leaves', async () => {
    const fixture = await installation();
    await chmod(fixture.operations, 0o755);
    await rm(fixture.proxy);
    await chmod(fixture.operations, 0o555);
    await expect(reader().read(fixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await chmod(fixture.operations, 0o755);
    await writeFile(fixture.proxy, PROXY_BYTES, { mode: 0o444 });
    await chmod(fixture.operations, 0o555);
    await chmod(fixture.proxy, 0o644);
    await expect(reader().read(fixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'FILE_UNSAFE' });

    await chmod(fixture.proxy, 0o444);
    await expect(reader().read(fixture.root, 'a'.repeat(64))).rejects.toMatchObject({ code: 'HASH_MISMATCH' });

    await chmod(fixture.operations, 0o755);
    await rm(fixture.proxy);
    await symlink('/etc/passwd', fixture.proxy);
    await chmod(fixture.operations, 0o555);
    await expect(reader().read(fixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'PATH_UNSAFE' });

    await chmod(fixture.operations, 0o755);
    await rm(fixture.proxy);
    await writeFile(fixture.proxy, PROXY_BYTES, { mode: 0o444 });
    await link(fixture.proxy, join(fixture.operations, 'proxy-copy.cjs'));
    await chmod(fixture.operations, 0o555);
    await expect(reader().read(fixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'FILE_UNSAFE' });

    await expect(createInstalledDependencyEgressProxyReader({ ownerUid: OWNER_UID + 1 })
      .read(fixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
  });

  it('rejects leaf substitution while the original descriptor is held', async () => {
    const fixture = await installation();
    const moved = `${fixture.proxy}.moved`;

    await expect(reader({
      hooks: {
        beforePostRead: async () => {
          await chmod(fixture.operations, 0o755);
          await rename(fixture.proxy, moved);
          await writeFile(fixture.proxy, PROXY_BYTES, { mode: 0o444 });
          await chmod(fixture.operations, 0o555);
        },
      },
    }).read(fixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'RACE_DETECTED' });
  });

  it('rejects operations-parent and package-root substitution while descriptors are held', async () => {
    const operationsFixture = await installation();
    const movedOperations = `${operationsFixture.operations}.moved`;
    await expect(reader({
      hooks: {
        afterOpenOperations: async () => {
          await chmod(operationsFixture.root, 0o755);
          await rename(operationsFixture.operations, movedOperations);
          await mkdir(operationsFixture.operations, { mode: 0o555 });
          await chmod(operationsFixture.root, 0o555);
        },
      },
    }).read(operationsFixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'RACE_DETECTED' });

    const packageFixture = await installation();
    const movedPackage = `${packageFixture.root}.moved`;
    await expect(reader({
      hooks: {
        afterOpenPackage: async () => {
          await rename(packageFixture.root, movedPackage);
          await mkdir(packageFixture.root, { mode: 0o555 });
        },
      },
    }).read(packageFixture.root, PROXY_SHA256)).rejects.toMatchObject({ code: 'RACE_DETECTED' });
  });
});
