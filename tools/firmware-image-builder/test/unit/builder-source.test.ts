import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateBuilderLock } from '../../domain/builder-lock.js';
import { BuilderSourceError, deriveDockerfile } from '../../builder/derive-dockerfile.js';
import {
  builderImageReference,
  validateBuilderDockerfile,
  validateBuilderLockFile,
  validateBuilderSource,
  validateProductionBuilderLock,
  validationEvidenceSha256,
  type BuilderValidationEvidence,
} from '../../builder/validate-builder.js';
import { validateRustToolchain, validateRustToolchainEvidence } from '../../builder/validate-rust-toolchain.js';

const digest = (letter: string) => letter.repeat(64);
const dockerfile = new URL('../../builder/Dockerfile', import.meta.url).pathname;
const rootDockerfile = new URL('../../../../Dockerfile-devel', import.meta.url).pathname;
const executionDefinitionPath = new URL('../../builder/execution-definition.json', import.meta.url).pathname;
const fixturePath = new URL('../fixtures/builder/non-installable-lock.json', import.meta.url).pathname;
const evidence: BuilderValidationEvidence = {
  rustc: 'rustc 1.85.0', llvm: '19.1.7', polly: '19.1.7', zstd: '1.5.7', node: 'v22.14.0',
  packages: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'], executionSelfTest: 'passed',
};

function lock() {
  return {
    schemaVersion: 1, packageVersion: '2026.07.23.1', imageRepository: 'registry.example.invalid/osi-builder', imageDigest: digest('a'),
    baseImage: `docker.io/library/debian@sha256:${digest('b')}`, baseImageDigest: digest('b'), dockerfileSha256: digest('c'),
    packageSet: [...evidence.packages], rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }, nodeVersion: '22.14.0',
    executionDefinitionSha256: digest('d'), validationEvidenceSha256: digest('e'), installable: true,
  };
}

describe('locked builder source', () => {
  it('keeps the schema contract exact and rejects invalid schema versions', () => {
    for (const value of ['1', 0, 1.5]) {
      const candidate = lock();
      candidate.schemaVersion = value as never;
      expect(validateBuilderLock(candidate, candidate.packageVersion).ok).toBe(false);
    }
  });

  it('rejects mutable base images, bad digests, missing evidence, and incomplete tools', () => {
    const mutations: Array<(candidate: ReturnType<typeof lock>) => void> = [
      (candidate) => { candidate.baseImage = 'debian:stable-slim'; }, (candidate) => { candidate.baseImageDigest = '0'.repeat(64); },
      (candidate) => { candidate.dockerfileSha256 = 'bad'; }, (candidate) => { candidate.validationEvidenceSha256 = '0'.repeat(64); },
      (candidate) => { candidate.packageSet = ['gcc-13']; }, (candidate) => { candidate.nodeVersion = '20.19.0'; },
      (candidate) => { candidate.rustConfig = { llvmConfig: 'rust-ci-llvm', channel: 'stable', version: '1.85.0', llvmMajor: 19 }; },
      (candidate) => { (candidate as Record<string, unknown>).extra = true; },
    ];
    for (const mutate of mutations) { const candidate = lock(); mutate(candidate); expect(validateBuilderLock(candidate, candidate.packageVersion).ok).toBe(false); }
  });

  it('accepts only a canonical digest-qualified image reference', () => {
    const candidate = lock();
    expect(builderImageReference(candidate)).toBe(`registry.example.invalid/osi-builder@sha256:${digest('a')}`);
    expect(() => builderImageReference({ ...candidate, imageDigest: 'bad' })).toThrow(BuilderSourceError);
  });

  it('rejects a non-installable committed fixture in production validation', async () => {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
    expect(fixture.installable).toBe(false);
    expect(() => validateBuilderLockFile(fixture, { installedVersion: '2026.07.23.1' })).toThrow(BuilderSourceError);
  });

  it('validates complete Dockerfile requirements and detects root drift before mutation', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    expect(validateBuilderDockerfile(contents).ok).toBe(true);
    expect(validateBuilderDockerfile(contents.replace('libzstd-dev', 'libzstd-missing')).ok).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-source-'));
    const destination = join(directory, 'Dockerfile');
    await expect(deriveDockerfile({ rootDockerfilePath: rootDockerfile, destinationPath: destination })).resolves.toMatchObject({ destinationPath: destination });
    const original = await readFile(destination, 'utf8');
    const driftedRoot = join(directory, 'Dockerfile-devel');
    await writeFile(driftedRoot, `${await readFile(rootDockerfile, 'utf8')}\nRUN apt-get install unsupported-drift-tool\n`);
    await expect(deriveDockerfile({ rootDockerfilePath: driftedRoot, destinationPath: destination })).rejects.toMatchObject({ code: 'BUILDER_SOURCE_DRIFT' });
    expect(await readFile(destination, 'utf8')).toBe(original);
  });

  it('validates source hashes and complete evidence through the production lock path', async () => {
    const source = await validateBuilderSource({ dockerfile, rootDockerfile, executionDefinitionPath, evidence });
    const candidate = lock();
    Object.assign(candidate, { baseImage: source.baseImage, baseImageDigest: source.baseImageDigest, dockerfileSha256: source.dockerfileSha256, executionDefinitionSha256: source.executionDefinitionSha256, validationEvidenceSha256: validationEvidenceSha256(evidence), packageSet: source.packageSet, rustConfig: source.rustConfig, nodeVersion: source.nodeVersion });
    expect(validateProductionBuilderLock(candidate, candidate.packageVersion, { dockerfile, executionDefinitionPath, evidence })).toMatchObject({ ok: true });
    candidate.validationEvidenceSha256 = digest('f');
    expect(validateProductionBuilderLock(candidate, candidate.packageVersion, { dockerfile, executionDefinitionPath, evidence })).toMatchObject({ ok: false });
  });

  it('requires resolved Rust LLVM evidence and rejects Rust CI artifacts', () => {
    expect(validateRustToolchain({ llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }).ok).toBe(true);
    expect(validateRustToolchain({ llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19, artifact: 'rust-ci-llvm' }).ok).toBe(false);
    expect(validateRustToolchainEvidence({ rustcVersion: '1.85.0', llvmVersion: '19.1.7', llvmConfig: '/usr/bin/llvm-config', channel: 'stable', pollyVersion: '19.1.7', zstdVersion: '1.5.7' }).ok).toBe(true);
    expect(validateRustToolchainEvidence({ rustcVersion: '1.85.0', llvmVersion: 'rust-ci-llvm', llvmConfig: '/usr/bin/llvm-config', channel: 'stable', pollyVersion: '19.1.7', zstdVersion: '1.5.7' }).ok).toBe(false);
  });
});
