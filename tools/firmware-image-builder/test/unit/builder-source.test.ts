import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUILDER_LOCK_OPTIONAL_KEYS, BUILDER_LOCK_REQUIRED_KEYS, validateBuilderLock } from '../../domain/builder-lock.js';
import { BuilderSourceError, deriveDockerfile, supportedPackageTokens } from '../../builder/derive-dockerfile.js';
import {
  builderImageReference,
  validateBuilderDockerfile,
  validateBuilderLockFile,
  validateBuilderSource,
  validateProductionBuilderLock,
  validationEvidenceSha256,
  validateExecutionDefinition,
  type BuilderValidationEvidence,
} from '../../builder/validate-builder.js';
import { validateOpenWrtRustFeed, validateRustToolchain, validateRustToolchainEvidence } from '../../builder/validate-rust-toolchain.js';

const digest = (letter: string) => letter.repeat(64);
const dockerfile = new URL('../../builder/Dockerfile', import.meta.url).pathname;
const validatorSource = new URL('../../builder/validate-builder.ts', import.meta.url).pathname;
const rootDockerfile = new URL('../../../../Dockerfile-devel', import.meta.url).pathname;
const executionDefinitionPath = new URL('../../builder/execution-definition.json', import.meta.url).pathname;
const fixturePath = new URL('../fixtures/builder/non-installable-lock.json', import.meta.url).pathname;
const definitionPath = new URL('../../builder/execution-definition.json', import.meta.url).pathname;
const targetNames = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-musl', 'armv7-unknown-linux-musleabihf'] as const;
const evidence: BuilderValidationEvidence = {
  imageId: `sha256:${digest('f')}`, imageDigest: digest('a'), architecture: 'linux/amd64',
  rustc: 'rustc 1.85.0', llvm: '19.1.7', polly: '19.1.7', zstd: '1.5.7', node: 'v22.14.0',
  packages: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev'],
  packageVersions: { 'gcc-14': '14.2.0-19', nodejs: '22.14.0-1', npm: '10.9.2', 'openwrt-build-tools': 'complete-host-tool-set', 'llvm-dev': '1:19.0-63', 'libpolly-19-dev': '1.5.0-1', 'libzstd-dev': '1.5.7-1', 'musl:arm64': '1.2.5-3.1~deb13u1', 'musl-dev:arm64': '1.2.5-3.1~deb13u1', 'musl:armhf': '1.2.5-3.1~deb13u1', 'musl-dev:armhf': '1.2.5-3.1~deb13u1' },
  commands: [
    { argv: ['/bin/sh', '-c', '/usr/bin/llvm-config --version; pkg-config --modversion libzstd'], exitCode: 0 as const, stdoutSha256: digest('1'), stderrSha256: digest('2') },
    { argv: ['/bin/sh', '-c', '/usr/bin/rustc --target x86_64-unknown-linux-gnu; ar t libstd.rlib; file -b target.o'], exitCode: 0 as const, stdoutSha256: digest('1'), stderrSha256: digest('2') },
    ...Array.from({ length: 5 }, (_, index) => ({ argv: ['dpkg-query', '--show', String(index)], exitCode: 0 as const, stdoutSha256: digest('1'), stderrSha256: digest('2') })),
  ],
    rustTargets: targetNames.map((target, index) => ({ target, standardLibraryPath: `/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu/lib/rustlib/${target}/lib/libstd-${index}.rlib`, standardLibrarySha256: digest('3'), standardLibraryArchitecture: target === 'x86_64-unknown-linux-gnu' ? 'ELF 64-bit LSB relocatable, x86-64' : target === 'aarch64-unknown-linux-musl' ? 'ELF 64-bit LSB relocatable, ARM aarch64' : 'ELF 32-bit LSB relocatable, ARM, EABI5', compileArtifact: `/tmp/osi-rust-validation/${index}.o`, compileSha256: digest('4'), compileArchitecture: target === 'x86_64-unknown-linux-gnu' ? 'ELF 64-bit LSB relocatable, x86-64' : target === 'aarch64-unknown-linux-musl' ? 'ELF 64-bit LSB relocatable, ARM aarch64' : 'ELF 32-bit LSB relocatable, ARM, EABI5', result: 'passed' as const })),
  executionSelfTest: 'passed',
};

function lock() {
  return {
    schemaVersion: 1, packageVersion: '2026.07.23.1', imageRepository: 'registry.example.invalid/osi-builder', imageDigest: digest('a'),
    baseImage: `docker.io/library/debian@sha256:${digest('b')}`, baseImageDigest: digest('b'), dockerfileSha256: digest('c'),
    packageSet: [...evidence.packages], rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }, nodeVersion: '22.14.0',
    executionDefinitionSha256: digest('d'), validationEvidenceSha256: digest('e'), installable: true, imageId: digest('f'),
  };
}

describe('locked builder source', () => {
  it('accepts only the closed direct-runtime definition and rejects nested unknown or unsafe values', async () => {
    const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as Record<string, unknown>;
    expect(() => validateExecutionDefinition(definition)).not.toThrow();
    const mutations: Array<(candidate: Record<string, unknown>) => void> = [
      (candidate) => { (candidate.environment as Record<string, unknown>).HOME = '/home/buildbot'; },
      (candidate) => { (candidate.environment as Record<string, unknown>).PATH = '/host/bin'; },
      (candidate) => { (candidate.environment as Record<string, unknown>).EXTRA = 'x'; },
      (candidate) => { (candidate.security as Record<string, unknown>).privileged = true; },
      (candidate) => { (candidate.security as Record<string, unknown>).capAdd = ['SYS_ADMIN']; },
      (candidate) => { (candidate.security as Record<string, unknown>).sockets = ['/var/run/docker.sock']; },
      (candidate) => { (candidate as Record<string, unknown>).argv = ['sh', '-c', 'echo unsafe']; },
      (candidate) => { (candidate as Record<string, unknown>).unknown = {}; },
      (candidate) => { (candidate.mount as Record<string, unknown>).destination = '/tmp'; },
      (candidate) => { (candidate as Record<string, unknown>).operations = { 'build-image': ['make'] }; },
    ];
    for (const mutate of mutations) {
      const candidate = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
      mutate(candidate);
      expect(() => validateExecutionDefinition(candidate), JSON.stringify(mutate)).toThrow(BuilderSourceError);
    }
  });

  it('binds definition operation IDs to manifest operations without executable argv', async () => {
    const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as { operationIds: string[] };
    const manifest = JSON.parse(await readFile(new URL('../../manifest/targets.json', import.meta.url), 'utf8')) as { targets: Array<{ operations: string[] }> };
    const allowed = new Set(definition.operationIds);
    expect(manifest.targets.flatMap((target) => target.operations).every((operation) => allowed.has(operation))).toBe(true);
    expect(JSON.stringify(definition)).not.toMatch(/"(argv|command|executable|compose|shell)"/u);
  });

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
    expect(contents).toContain('liblibz3.so.so');
    expect(contents).toContain('jobs = 2');
    expect(contents).toContain('/opt/target-sysroots/aarch64/usr/lib/aarch64-linux-musl');
    expect(contents).toContain('/opt/target-sysroots/armv7/usr/lib/arm-linux-musleabihf');
    expect(validateBuilderDockerfile(contents.replace('libzstd-dev', 'libzstd-missing')).ok).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-source-'));
    const destination = join(directory, 'Dockerfile');
    await expect(deriveDockerfile({ rootDockerfilePath: rootDockerfile, destinationPath: destination })).resolves.toMatchObject({ destinationPath: destination });
    const original = await readFile(destination, 'utf8');
    const driftedRoot = join(directory, 'Dockerfile-devel');
    await writeFile(driftedRoot, `${await readFile(rootDockerfile, 'utf8')}\nRUN apt-get install unsupported-drift-tool\n`);
    await expect(deriveDockerfile({ rootDockerfilePath: driftedRoot, destinationPath: destination })).rejects.toMatchObject({ code: 'BUILDER_SOURCE_DRIFT' });
    expect(await readFile(destination, 'utf8')).toBe(original);
    const rootContents = await readFile(rootDockerfile, 'utf8');
    for (const drift of [
      rootContents.replace("    'gawk' \\\n", ''),
      `${rootContents}\nRUN apt-get install unsupported-drift-tool\n`,
      rootContents.replace("    'gawk' \\\n", "    'awk' \\\n"),
      rootContents.replace("    'libncurses5-dev' \\\n", "    'libncurses6-dev' \\\n"),
    ]) {
      await writeFile(driftedRoot, drift);
      await expect(deriveDockerfile({ rootDockerfilePath: driftedRoot, destinationPath: destination })).rejects.toMatchObject({ code: 'BUILDER_SOURCE_DRIFT' });
      expect(await readFile(destination, 'utf8')).toBe(original);
    }
    expect(supportedPackageTokens(rootContents)).toContain('libncurses-dev');
  });

  it('keeps the system LLVM probe bound to rustc -vV semantic output', async () => {
    const source = await readFile(validatorSource, 'utf8');
    expect(source).toContain("sed -n 's/^LLVM version: *//p'");
    expect(source).toContain("/^LLVM version:\\s*\\d+\\.\\d+/u");
    expect(source).toContain('libPolly.a');
    expect(source).toContain('opt -passes=polly-opt-isl');
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
    expect(validateOpenWrtRustFeed('[llvm]\ndownload-ci-llvm = false').ok).toBe(true);
    expect(validateOpenWrtRustFeed('[llvm]\ndownload-ci-llvm=true').ok).toBe(false);
    expect(validateOpenWrtRustFeed('[llvm]\nllvm-config = "/usr/bin/llvm-config"').ok).toBe(false);
  });

  it('rejects fabricated Rust evidence and requires all three semantic target artifacts', () => {
    const fabricated = { ...evidence, imageId: 'sha256:' + digest('a'), imageDigest: digest('b'), architecture: 'linux/amd64', packageVersions: {}, commands: [], rustTargets: [], } as unknown as BuilderValidationEvidence;
    const candidate = { ...lock(), imageDigest: digest('b'), imageId: digest('a') };
    expect(validateProductionBuilderLock(candidate, candidate.packageVersion, { dockerfile, executionDefinitionPath, evidence: fabricated })).toMatchObject({ ok: false });
  });

  it('keeps the schema field set identical to the canonical domain contract and accepts the same repository ports', async () => {
    const schema = JSON.parse(await readFile(new URL('../../builder/builder-lock.schema.json', import.meta.url), 'utf8')) as { required: string[]; properties: Record<string, unknown> };
    const required = [...BUILDER_LOCK_REQUIRED_KEYS];
    const optional = [...BUILDER_LOCK_OPTIONAL_KEYS];
    expect(schema.required).toEqual(required);
    expect(Object.keys(schema.properties).sort()).toEqual([...required, ...optional].sort());
    for (const repository of ['builder', 'registry.example:5000/team/builder']) {
      expect(validateBuilderLock({ ...lock(), imageRepository: repository }, '2026.07.23.1').ok).toBe(true);
    }
    for (const repository of ['builder:5000', 'registry.example:0/team/builder', 'registry.example:65536/team/builder', 'Registry/team']) {
      expect(validateBuilderLock({ ...lock(), imageRepository: repository }, '2026.07.23.1').ok).toBe(false);
    }
  });
});
