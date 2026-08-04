import { readFile, mkdtemp, writeFile, mkdir, rm, symlink, access, truncate, lstat, rename, chmod, realpath, readlink } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { BUILDER_LOCK_OPTIONAL_KEYS, BUILDER_LOCK_REQUIRED_KEYS, validateBuilderLock } from '../../domain/builder-lock.js';
import { BUILDER_ONLY_PACKAGES, BuilderSourceError, deriveDockerfile, supportedPackageTokens } from '../../builder/derive-dockerfile.js';
import {
  builderImageReference,
  builderRuntimeArguments,
  parseCanonicalBuilderImageReference,
  READ_ONLY_OPERATION_IDS,
  selectExactRepositoryDigest,
  sha256,
  validateBuiltBuilderImage,
  validateBuilderDockerfile,
  validateBuilderLockFile,
  validateBuilderSource,
  validateProductionBuilderLock,
  validationEvidenceSha256,
  validateExecutionDefinition,
  validateTrustedModuleProbeSource,
  validateTrustedDependencyProxySource,
  validateTrustedProxyCredentialEnvironmentSource,
  validateTrustedWgetConfigSource,
  validateTrustedExecutionGuardSource,
  validateTrustedOperationToolSource,
  type BuilderValidationEvidence,
} from '../../builder/validate-builder.js';
import { enforceOpenWrtRustFeed, OPENWRT_RUST_FEED_CONTRACT, validateOpenWrtRustFeed, validateRustToolchain, validateRustToolchainEvidence } from '../../builder/validate-rust-toolchain.js';

const digest = (letter: string) => letter.repeat(64);
const dockerfile = new URL('../../builder/Dockerfile', import.meta.url).pathname;
const validatorSource = new URL('../../builder/validate-builder.ts', import.meta.url).pathname;
const rootDockerfile = new URL('../../../../Dockerfile-devel', import.meta.url).pathname;
const executionDefinitionPath = new URL('../../builder/execution-definition.json', import.meta.url).pathname;
const fixturePath = new URL('../fixtures/builder/non-installable-lock.json', import.meta.url).pathname;
const rustMakefileFixturePath = new URL('../fixtures/openwrt-packages-d8cd30f4/lang/rust/Makefile', import.meta.url).pathname;
const definitionPath = new URL('../../builder/execution-definition.json', import.meta.url).pathname;
const targetNames = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-musl', 'armv7-unknown-linux-musleabihf'] as const;
const execFileAsync = promisify(execFile);
const operationToolPath = new URL('../../builder/operations/osi-image-builder-tool.js', import.meta.url).pathname;
const moduleProbePath = new URL('../../builder/operations/osi-image-builder-module-probe.js', import.meta.url).pathname;
const pi5Environment = 'full_raspberrypi_bcm27xx_bcm2712';
const pi5FactoryImage = 'chirpstack-gateway-os-2026.07-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz';
type TestSignalSource = EventEmitter & { kill: (pid: number, signal: string) => void };
const operationToolModule = async () => await import(operationToolPath) as unknown as { readonly createOperationHandlersForTesting: (root: string, hooks?: { readonly onStep?: (point: string, path: string) => void | Promise<void> }) => { readonly copyFeedConfig: () => Promise<{ readonly sha256: string }>; readonly mirrorGui: () => Promise<{ readonly fileCount: number }>; readonly verifyImage: () => Promise<{ readonly sha256: string; readonly targetId: string; readonly nodeResolution: readonly { readonly packageName: string; readonly specifier: string; readonly resolvedRelativePath: string; readonly exportType: 'function' | 'object' | 'incompatible' }[] }> }; readonly runUpdateFeedsForTesting: (root: string, spawn?: (file: string, args: readonly string[], options: Record<string, unknown>) => unknown, hooks?: { readonly onStep?: (point: string, path: string) => void | Promise<void> }, signalSource?: TestSignalSource) => Promise<{ readonly operation: 'update-feeds' }> };
const evidence: BuilderValidationEvidence = {
  imageId: `sha256:${digest('f')}`, imageDigest: digest('a'), architecture: 'linux/amd64',
  rustc: 'rustc 1.85.0', llvm: '19.1.7', polly: '19.1.7', zstd: '1.5.7', node: 'v22.14.0', npm: '11.10.1',
  packages: ['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev', 'sqlite3'],
  packageVersions: { 'gcc-14': '14.2.0-19', nodejs: '22.14.0-1', npm: '10.9.2', 'openwrt-build-tools': 'complete-host-tool-set', 'llvm-dev': '1:19.0-63', 'libpolly-19-dev': '1.5.0-1', 'libzstd-dev': '1.5.7-1', sqlite3: '3.46.1-1', 'musl:arm64': '1.2.5-3.1~deb13u1', 'musl-dev:arm64': '1.2.5-3.1~deb13u1', 'musl:armhf': '1.2.5-3.1~deb13u1', 'musl-dev:armhf': '1.2.5-3.1~deb13u1' },
  commands: [
    { argv: ['/bin/sh', '-c', '/usr/bin/llvm-config --version; pkg-config --modversion libzstd'], exitCode: 0 as const, stdoutSha256: digest('1'), stderrSha256: digest('2') },
    { argv: ['/bin/sh', '-c', '/usr/bin/rustc --target x86_64-unknown-linux-gnu; ar t libstd.rlib; file -b target.o'], exitCode: 0 as const, stdoutSha256: digest('1'), stderrSha256: digest('2') },
    ...Array.from({ length: 5 }, (_, index) => ({ argv: ['dpkg-query', '--show', String(index)], exitCode: 0 as const, stdoutSha256: digest('1'), stderrSha256: digest('2') })),
  ],
    rustTargets: targetNames.map((target, index) => ({ target, standardLibraryPath: `/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu/lib/rustlib/${target}/lib/libstd-${index}.rlib`, standardLibrarySha256: digest('3'), standardLibraryArchitecture: target === 'x86_64-unknown-linux-gnu' ? 'ELF 64-bit LSB relocatable, x86-64' : target === 'aarch64-unknown-linux-musl' ? 'ELF 64-bit LSB relocatable, ARM aarch64' : 'ELF 32-bit LSB relocatable, ARM, EABI5', compileArtifact: `/tmp/osi-rust-validation/${index}.o`, compileSha256: digest('4'), compileArchitecture: target === 'x86_64-unknown-linux-gnu' ? 'ELF 64-bit LSB relocatable, x86-64' : target === 'aarch64-unknown-linux-musl' ? 'ELF 64-bit LSB relocatable, ARM aarch64' : 'ELF 32-bit LSB relocatable, ARM, EABI5', result: 'passed' as const })),
  operationTool: { path: '/opt/osi-image-builder/operations/osi-image-builder-tool.js', owner: '0:0', mode: '0555', user: 'buildbot', result: 'passed' },
  executionGuard: { path: '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js', owner: '0:0', mode: '0555', user: 'buildbot', result: 'passed' },
  executionSelfTest: 'passed',
};

function lock() {
  return {
    schemaVersion: 1, packageVersion: '2026.07.23.1', imageRepository: 'registry.example.invalid/osi-builder', imageDigest: digest('a'),
    baseImage: `docker.io/library/debian@sha256:${digest('b')}`, baseImageDigest: digest('b'), dockerfileSha256: digest('c'),
    packageSet: [...evidence.packages].filter((packageName) => packageName !== 'sqlite3'), rustConfig: { llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }, nodeVersion: '22.14.0',
    executionDefinitionSha256: digest('d'), validationEvidenceSha256: digest('e'), dependencyEgressProxySha256: digest('1'), installable: true, imageId: digest('f'),
  };
}

async function configurePi5(root: string): Promise<void> {
  await mkdir(join(root, 'conf', pi5Environment), { recursive: true });
  await writeFile(
    join(root, 'conf', pi5Environment, '.config'),
    'CONFIG_TARGET_PROFILE="DEVICE_rpi-5"\n',
  );
  await symlink(`${pi5Environment}/.config`, join(root, 'conf/.config'));
  await symlink('../conf/.config', join(root, 'openwrt/.config'));
}

describe('locked builder source', () => {
  it('accepts only the closed direct-runtime definition and rejects nested unknown or unsafe values', async () => {
    const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as Record<string, unknown>;
    expect(() => validateExecutionDefinition(definition)).not.toThrow();
    expect(definition.network).toBe('internal-authenticated-proxy');
    expect(definition.networkPolicy).toEqual({
      offline: 'none',
      dependencyEgress: 'internal-authenticated-proxy',
      proxyPort: 3128,
      allowedPorts: [80, 443],
      credentialPath: '/run/osi-image-builder/proxy-credential',
      operationAllowedHosts: {
        'frontend-install': ['registry.npmjs.org'],
        'build-image': [
          'busybox.net', 'cdn.kernel.org', 'codeload.github.com', 'crates.io',
          'download.savannah.gnu.org', 'downloads.openwrt.org', 'ftp.gnu.org',
          'git.kernel.org', 'git.openwrt.org', 'github.com', 'mirror2.openwrt.org',
          'nodejs.org', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
          'registry.npmjs.org', 'sources.cdn.openwrt.org', 'static.crates.io',
          'static.rust-lang.org', 'www.kernel.org',
        ],
      },
    });
    expect(definition.readOnlyOperationIds).toEqual(READ_ONLY_OPERATION_IDS);
    expect(definition.offlineOperationIds).toEqual([
      'activate-target',
      'copy-feed-config',
      'update-feeds',
      'install-feeds',
      'resolve-config',
      'verify-image',
      'verify-profile-parity',
      'verify-chameleon',
      'verify-db-schema',
      'verify-sync-flow',
      'verify-strega',
      'verify-communication',
      'check-mqtt-topics',
      'frontend-test',
      'frontend-typecheck',
      'frontend-build',
      'mirror-gui',
    ]);
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
      (candidate) => { candidate.readOnlyOperationIds = []; },
      (candidate) => { candidate.readOnlyOperationIds = ['verify-image', 'build-image']; },
      (candidate) => { candidate.readOnlyOperationIds = ['build-image']; },
      (candidate) => { candidate.offlineOperationIds = []; },
      (candidate) => { candidate.offlineOperationIds = ['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config']; },
      (candidate) => { candidate.offlineOperationIds = ['activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config', 'verify-image', 'build-image']; },
      (candidate) => { candidate.offlineOperationIds = ['verify-image', 'activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds', 'resolve-config']; },
      (candidate) => { ((candidate.networkPolicy as Record<string, unknown>).operationAllowedHosts as Record<string, unknown>)['frontend-install'] = ['example.com']; },
      (candidate) => { (candidate as Record<string, unknown>).operations = { 'build-image': ['make'] }; },
    ];
    for (const mutate of mutations) {
      const candidate = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
      mutate(candidate);
      expect(() => validateExecutionDefinition(candidate), JSON.stringify(mutate)).toThrow(BuilderSourceError);
    }
  });

  it('declares package version 0.1.35 consistently before installation', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    const packageLock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
    expect(packageJson.version).toBe('0.1.35');
    expect(packageLock.version).toBe('0.1.35');
    expect(packageLock.packages['']?.version).toBe('0.1.35');
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
    expect(contents).toContain('ARG BUILDER_PLATFORM=linux/amd64\nFROM --platform=${BUILDER_PLATFORM}');
    expect(contents).toContain('ARG NODE_VERSION=22.14.0');
    expect(contents).toContain('ARG NODE_TARBALL_SHA256=69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec');
    expect(contents).toContain('ARG NPM_VERSION=11.10.1');
    expect(contents).toContain('ARG NPM_TARBALL_SHA256=2190945151842685142f5085b3c5dd356b1021ab390d7d02c2bb2c580f0c4840');
    expect(contents).toContain('npm-${NPM_VERSION}.tgz');
    expect(contents).toContain('ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(contents).not.toMatch(/^ENV .*\b(?:CARGO_HOME|DEBIAN_FRONTEND|CARGO_BUILD_JOBS|RUST_TARGETS)=/mu);
    expect(contents).toContain('liblibz3.so.so');
    expect(contents).toContain('jobs = 2');
    expect(contents).toContain('/opt/target-sysroots/aarch64/usr/lib/aarch64-linux-musl');
    expect(contents).toContain('/opt/target-sysroots/armv7/usr/lib/arm-linux-musleabihf');
    expect(validateBuilderDockerfile(contents.replace('libzstd-dev', 'libzstd-missing')).ok).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), 'osi-builder-source-'));
    const destination = join(directory, 'Dockerfile');
    await expect(deriveDockerfile({ rootDockerfilePath: rootDockerfile, destinationPath: destination })).resolves.toMatchObject({ destinationPath: destination });
    const original = await readFile(destination, 'utf8');
    expect(validateBuilderDockerfile(original).ok).toBe(true);
    expect(validateBuilderDockerfile(`${original}\nRUN true\n`).ok).toBe(false);
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

  it('validates the immutable execution guard source and rejects guard drift', async () => {
    const source = await readFile(new URL('../../builder/operations/osi-image-builder-exec-guard.js', import.meta.url), 'utf8');
    expect(() => validateTrustedExecutionGuardSource(source)).not.toThrow();
    expect(source).toContain("createRequire(import.meta.url)('./osi-proxy-credential-environment.cjs')");
    expect(source).toContain('authenticatedProxyEnvironment(process.env, readProxyCredential)');
    expect(source).toContain("const PROXY_CREDENTIAL_PATH = '/run/osi-image-builder/proxy-credential';");
    expect(() => validateTrustedExecutionGuardSource(source.replace('shell: false', 'shell: true'))).toThrow(/guard source digest|guard/i);
  });

  it('bakes and digest-pins the tool-owned proxy runtime and credential helper', async () => {
    const proxy = await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url), 'utf8');
    const credential = await readFile(new URL('../../builder/operations/osi-proxy-credential-environment.cjs', import.meta.url), 'utf8');
    const wgetConfig = await readFile(new URL('../../builder/operations/osi-wgetrc', import.meta.url), 'utf8');
    expect(() => validateTrustedDependencyProxySource(proxy)).not.toThrow();
    expect(() => validateTrustedProxyCredentialEnvironmentSource(credential)).not.toThrow();
    expect(() => validateTrustedWgetConfigSource(wgetConfig)).not.toThrow();
    expect(() => validateTrustedDependencyProxySource(`${proxy}\n`)).toThrow(/proxy|digest/u);
    expect(() => validateTrustedProxyCredentialEnvironmentSource(`${credential}\n`)).toThrow(/credential|digest/u);
    expect(() => validateTrustedWgetConfigSource(`${wgetConfig}\n`)).toThrow(/wget|digest|trust/u);
    const contents = await readFile(dockerfile, 'utf8');
    expect(contents).toContain('COPY --chown=root:root --chmod=0555 builder/operations/osi-dependency-egress-proxy.cjs /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs');
    expect(contents).toContain('COPY --chown=root:root --chmod=0555 builder/operations/osi-proxy-credential-environment.cjs /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs');
    expect(contents).toContain('COPY --chown=root:root --chmod=0444 builder/operations/osi-wgetrc /opt/osi-image-builder/operations/osi-wgetrc');
  });

  it('allows and immutably proves the builder-only sqlite3 CLI dependency', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    expect(BUILDER_ONLY_PACKAGES).toContain('sqlite3');
    expect(supportedPackageTokens(contents)).toContain('sqlite3');

    const canonical = `registry.example.invalid/osi-builder@sha256:${digest('a')}`;
    const inspect = JSON.stringify({ Id: `sha256:${digest('b')}`, Architecture: 'amd64', Os: 'linux', Size: 1, RepoDigests: [canonical], Config: { Env: [`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`] } });
    const calls: string[][] = [];
    const result = await validateBuiltBuilderImage(canonical, { run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'image') return { stdout: inspect, stderr: '' };
      const command = argv.join(' ');
      const runtime = argv.slice(7);
      if (argv.includes('/opt/osi-image-builder/operations/osi-image-builder-tool.js')) return { stdout: 'helper self-test passed\n', stderr: '' };
      if (runtime[0] === 'node') return { stdout: 'v22.14.0\n', stderr: '' };
      if (runtime[0] === 'npm') return { stdout: '11.10.1\n', stderr: '' };
      if (runtime[0] === 'gcc-14') return { stdout: 'gcc (Debian 14.2.0) 14.2.0\n', stderr: '' };
      if (runtime[0] === 'sqlite3') return { stdout: '3.46.1 2024-08-13 09:16:08\n', stderr: '' };
      if (runtime[0] === '/usr/bin/rustc' && runtime[1] === '-vV') return { stdout: 'rustc 1.85.0\nLLVM version: 19.1.7\n', stderr: '' };
      if (runtime[0] === '/usr/bin/llvm-config') return { stdout: '19.1.7\n', stderr: '' };
      if (command.includes('--showformat=${Package}=${Version')) return { stdout: 'gcc-14=14.2.0\nnodejs=22.14.0\nnpm=10.9.2\nllvm-dev=19.1.7\nlibpolly-19-dev=19.1.7\nlibzstd-dev=1.5.7\nsqlite3=3.46.1-1\n', stderr: '' };
      if (runtime[0] === 'dpkg-query' && command.includes('libpolly-19-dev')) return { stdout: '19.1.7\n', stderr: '' };
      if (runtime[0] === 'pkg-config') return { stdout: '1.5.7\n', stderr: '' };
      if (command.includes('cat /opt/target-sysroots/package-versions')) return { stdout: 'musl:arm64=1.2.5\nmusl-dev:arm64=1.2.5\nmusl:armhf=1.2.5\nmusl-dev:armhf=1.2.5\n', stderr: '' };
      if (command.includes('/usr/bin/rustc --target')) return { stdout: ['x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/std|'.concat(digest('1'), '|x86-64|/tmp/osi-rust-validation/x.o|', digest('2'), '|x86-64'), 'aarch64-unknown-linux-musl|/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/std|'.concat(digest('1'), '|aarch64|/tmp/osi-rust-validation/a.o|', digest('2'), '|aarch64'), 'armv7-unknown-linux-musleabihf|/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/std|'.concat(digest('1'), '|ARM|/tmp/osi-rust-validation/arm.o|', digest('2'), '|ARM')].join('\n') + '\n', stderr: '' };
      if (command.includes('llvm_version=')) return { stdout: '19.1.7\nrustc 1.85.0\nLLVM version: 19.1.7\n/usr/lib/llvm-19/lib/libPolly.a /usr/lib/llvm-19/lib/libPollyISL.a\n1.5.7\n', stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    } });
    expect(calls.some((argv) => argv.slice(7).join(' ') === 'sqlite3 --version')).toBe(true);
    expect(result.evidence.packageVersions.sqlite3).toBe('3.46.1-1');
  });

  it('rejects an npm archive checksum bypass', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const bypassed = contents.replace('sha256sum --check --status \\\n  && rm -rf /usr/local/lib/node_modules/npm', 'true \\\n  && rm -rf /usr/local/lib/node_modules/npm');
    expect(bypassed).not.toBe(contents);
    expect(validateBuilderDockerfile(bypassed).ok).toBe(false);
  });

  it('rejects removal of the npm archive checksum command', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const checksum = `  && printf '%s  %s\\n' \\\n      "\${NPM_TARBALL_SHA256}" \\\n      /tmp/npm.tgz | sha256sum --check --status \\\n`;
    const removed = contents.replace(checksum, '');
    expect(removed).not.toBe(contents);
    expect(validateBuilderDockerfile(removed).ok).toBe(false);
  });

  it('rejects substitution of the pinned npm archive URL', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const substituted = contents.replace('https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz', 'https://example.invalid/npm-${NPM_VERSION}.tgz');
    expect(substituted).not.toBe(contents);
    expect(validateBuilderDockerfile(substituted).ok).toBe(false);
  });

  it('rejects extracting npm from a different archive', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const substituted = contents.replace('--file /tmp/npm.tgz --strip-components=1 --directory /usr/local/lib/node_modules/npm', '--file /tmp/unchecked-npm.tgz --strip-components=1 --directory /usr/local/lib/node_modules/npm');
    expect(substituted).not.toBe(contents);
    expect(validateBuilderDockerfile(substituted).ok).toBe(false);
  });

  it('rejects extracting npm to a different installation path', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const substituted = contents.replace('--strip-components=1 --directory /usr/local/lib/node_modules/npm', '--strip-components=1 --directory /usr/local/lib/node_modules/npm-staging');
    expect(substituted).not.toBe(contents);
    expect(validateBuilderDockerfile(substituted).ok).toBe(false);
  });

  it('rejects extracting npm before its archive checksum succeeds', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const checksum = `printf '%s  %s\\n' \\\n      "\${NPM_TARBALL_SHA256}" \\\n      /tmp/npm.tgz | sha256sum --check --status`;
    const extraction = 'tar --extract --gzip --file /tmp/npm.tgz --strip-components=1 --directory /usr/local/lib/node_modules/npm';
    const reordered = contents
      .replace(checksum, '__OSI_NPM_CHECKSUM__')
      .replace(extraction, checksum)
      .replace('__OSI_NPM_CHECKSUM__', extraction);
    expect(reordered).not.toBe(contents);
    expect(reordered).not.toContain('__OSI_NPM_CHECKSUM__');
    expect(validateBuilderDockerfile(reordered).ok).toBe(false);
  });

  it('accepts harmless whitespace changes in the pinned npm sequence', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const reformatted = contents
      .replace('RUN curl --fail --silent --show-error --location --retry 3 \\\n', 'RUN    curl   --fail --silent --show-error --location --retry 3 \\\n')
      .replace('      --output /tmp/npm.tgz \\\n', '          --output    /tmp/npm.tgz \\\n');
    expect(reformatted).not.toBe(contents);
    expect(validateBuilderDockerfile(reformatted).ok).toBe(true);
  });

  it('rejects a post-pin RUN heredoc', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nRUN <<'EOF'\nnpm --version\nEOF\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects RUN after a continued physical comment line', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\n${[
      '# audit comment \\',
      'RUN npm install --global npm@11.10.1',
      '',
    ].join('\n')}`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects every added post-pin Docker instruction by default', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    for (const instruction of [
      'RUN true',
      'COPY builder/Dockerfile /tmp/Dockerfile',
      'ADD builder/Dockerfile /tmp/Dockerfile',
      'CMD ["true"]',
      'ENTRYPOINT ["true"]',
      'HEALTHCHECK CMD true',
      'ONBUILD RUN true',
      'SHELL ["/bin/bash", "-c"]',
      'LABEL audit.note="unexpected"',
    ]) {
      expect(validateBuilderDockerfile(`${contents}\n${instruction}\n`).ok, instruction).toBe(false);
    }
  });

  it('rejects a later global npm installation', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nRUN npm install --global npm@11.10.1\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects npm global mode through command environment configuration', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nRUN npm_config_global=true npm install npm@11.10.1\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects npm global location mode', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nRUN npm install --location=global npm@11.10.1\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects corepack activation after the pinned npm install', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nRUN corepack enable npm\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects npx invocation after the pinned npm install', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nRUN npx --version\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects a later npm global-mode environment', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nENV npm_config_global=true\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects a later write to the installed npm CLI', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const replaced = `${contents}\nRUN printf '%s\\n' tampered > /usr/local/lib/node_modules/npm/bin/npm-cli.js\n`;
    expect(validateBuilderDockerfile(replaced).ok).toBe(false);
  });

  it('rejects later replacement of npm and npx entrypoints', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    for (const entrypoint of ['/usr/local/bin/npm', '/usr/local/bin/npx']) {
      const replaced = `${contents}\nRUN ln -sfn /tmp/replacement-cli ${entrypoint}\n`;
      expect(validateBuilderDockerfile(replaced).ok, entrypoint).toBe(false);
    }
  });

  it('accepts harmless post-pin comments and whitespace', async () => {
    const contents = await readFile(dockerfile, 'utf8');
    const reformatted = contents
      .replace(
        '# The runner invokes only this fixed, image-owned operation entry.',
        '# Audit-only comment.\n\n# The runner invokes only this fixed, image-owned operation entry.',
      )
      .replace('USER buildbot\n', 'USER   buildbot   \n\n# Trailing audit-only comment.\n');
    expect(reformatted).not.toBe(contents);
    expect(validateBuilderDockerfile(reformatted).ok).toBe(true);
  });

  it('bakes and validates the immutable operation tool with a closed runtime surface', async () => {
    const dockerfileContents = await readFile(dockerfile, 'utf8');
    const toolContents = await readFile(operationToolPath, 'utf8');
    const probeContents = await readFile(moduleProbePath, 'utf8');
    expect(dockerfileContents).toContain('COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-tool.js /opt/osi-image-builder/operations/osi-image-builder-tool.js');
    expect(dockerfileContents).toContain('COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-module-probe.js /opt/osi-image-builder/operations/osi-image-builder-module-probe.js');
    expect(dockerfileContents).toContain("stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-tool.js");
    expect(dockerfileContents).toContain("stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-module-probe.js");
    expect(dockerfileContents).toContain("stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-tool.js");
    expect(dockerfileContents).toContain("stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-module-probe.js");
    expect(() => validateTrustedOperationToolSource(toolContents)).not.toThrow();
    expect(() => validateTrustedModuleProbeSource(probeContents)).not.toThrow();
    expect(toolContents).not.toMatch(/process\.argv\.slice\(2\).*join/u);
    for (const drift of [
      toolContents.replace(
        "    '--permission',",
        "    '--allow-child-process',",
      ),
      toolContents.replace(
        "const INSTALLED_NODE_BINARY = '/usr/local/bin/node';",
        "const INSTALLED_NODE_BINARY = process.execPath;",
      ),
      toolContents.replace(
        'shell: false',
        'shell: true',
      ),
      toolContents.replace(
        'const MODULE_PROBE_TIMEOUT_MS = 15_000;',
        'const MODULE_PROBE_TIMEOUT_MS = 150_000;',
      ),
      toolContents.replace(
        'const [packageName, specifier] = NODE_MODULES[packageIndex];',
        "const [packageName, specifier] = NODE_MODULES[0];",
      ),
      toolContents.replace(
        'Object.keys(parsed).join(\'\\0\')\n        !== \'packageIndex\\0packageName\\0specifier\\0resolvedRelativePath\\0exportType\'',
        'Object.keys(parsed).join(\'\\0\') !== \'packageIndex\\0packageName\\0specifier\\0resolvedRelativePath\'',
      ),
      `${toolContents}\nprocess.env.NODE_PATH = '/host/node_modules';\n`,
    ]) {
      expect(() => validateTrustedOperationToolSource(drift)).toThrow();
    }
    for (const drift of [
      probeContents.replace('NATIVE_DEPENDENCY_STUBS.sqlite3 = Object.freeze({', 'NATIVE_DEPENDENCY_STUBS.betterSqlite3 = Object.freeze({'),
      probeContents.replace("packageName: 'osi-db-helper'", "packageName: 'osi-history-helper'"),
      probeContents.replace("  'process',\n", ''),
      probeContents.replace(
        'return ROOTFS_FILESYSTEM_CAPABILITY;',
        'return Reflect.apply(originalLoad, this, [request, parent, isMain]);',
      ),
      probeContents.replace(
        "parentRelativePath: 'osi-health-helper/index.js'",
        "parentRelativePath: 'osi-db-helper/index.js'",
      ),
      probeContents.replace(
        "'@chirpstack/chirpstack-api/api/application_grpc_pb',",
        "'@chirpstack/chirpstack-api',",
      ),
      probeContents.replace('const ORIGINAL_PROCESS_EXIT = process.exit.bind(process);', ''),
      probeContents.replace(
        'const ORIGINAL_JSON_STRINGIFY = JSON.stringify.bind(JSON);',
        'const ORIGINAL_JSON_STRINGIFY = JSON.stringify;',
      ),
      probeContents.replace(
        'const ORIGINAL_PROMISE_REJECT = ORIGINAL_PROMISE.reject.bind(ORIGINAL_PROMISE);',
        'const ORIGINAL_PROMISE_REJECT = Promise.reject;',
      ),
      probeContents.replace(
        'const ORIGINAL_ARRAY_INCLUDES = Function.call.bind(Array.prototype.includes);',
        'const ORIGINAL_ARRAY_INCLUDES = Array.prototype.includes;',
      ),
      probeContents.replace(
        'const ORIGINAL_REFLECT_APPLY = Reflect.apply.bind(Reflect);',
        'const ORIGINAL_REFLECT_APPLY = Reflect.apply;',
      ),
      probeContents.replace(
        'const BUILTIN_CAPABILITY_STUBS = ORIGINAL_OBJECT_CREATE(null);',
        'const BUILTIN_CAPABILITY_STUBS = Object.freeze({});',
      ),
      probeContents.replace(
        'const NATIVE_DEPENDENCY_STUBS = ORIGINAL_OBJECT_CREATE(null);',
        'const NATIVE_DEPENDENCY_STUBS = Object.freeze({});',
      ),
      probeContents.replace(
        "const moduleCache = createRestrictedLoaderCache(realModuleCache, 'Module._cache');",
        'const moduleCache = realModuleCache;',
      ),
      probeContents.replace(
        "seal(Module, '_pathCache', modulePathCache, 'Module._pathCache');",
        '',
      ),
      probeContents.replace(
        'const moduleFacade = ORIGINAL_OBJECT_CREATE(null);',
        'const moduleFacade = module;',
      ),
      probeContents.replace(
        "if (typeof request !== 'string') {",
        "if (request == null) {",
      ),
      probeContents.replace(
        'rootfs require.resolve options are not supported',
        'rootfs require.resolve options are supported',
      ),
      probeContents.replace(
        "seal(Module, '_load', sealedLoad, 'Module._load');",
        '',
      ),
      probeContents.replace(
        'promiseResolve(asyncId)',
        'promiseResolveRemoved(asyncId)',
      ),
      probeContents.replace(
        'Object.freeze(Module);',
        '',
      ),
      probeContents.replace(
        'const ORIGINAL_MAP_ITERATOR_NEXT = Function.call.bind(',
        'const ORIGINAL_MAP_ITERATOR_NEXT_REMOVED = Function.call.bind(',
      ),
      probeContents.replace(
        'const record = ORIGINAL_OBJECT_CREATE(null);',
        'const record = {};',
      ),
      probeContents.replace(
        'const MAX_OUTPUT_BYTES = 1024 * 1024;',
        'const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;',
      ),
      probeContents.replace('args.length !== 4', 'args.length !== 3'),
      probeContents.replace('function installRootfsLoader(', 'function installRootfsLoaderRemoved('),
      probeContents.replace(
        "    '--permission',",
        "    '--allow-fs-write=/tmp',",
      ),
      probeContents.replace(
        "Object.defineProperty(process, 'getBuiltinModule', {",
        "Object.defineProperty(process, 'getBuiltinModuleRemoved', {",
      ),
      probeContents.replace('    writable: false,', '    writable: true,'),
      probeContents.replace('    configurable: false,', '    configurable: true,'),
      `${probeContents}\nprocess.env.NODE_PATH = '/host/node_modules';\n`,
    ]) {
      expect(() => validateTrustedModuleProbeSource(drift)).toThrow();
    }
    for (const operation of ['copy-feed-config', 'update-feeds', 'verify-image', 'mirror-gui']) {
      await expect(execFileAsync(process.execPath, [operationToolPath, operation], { cwd: new URL('../../../../', import.meta.url).pathname, maxBuffer: 32 * 1024 })).rejects.toMatchObject({ code: 2 });
    }
    await expect(execFileAsync(process.execPath, [operationToolPath, 'verify-image', '/workdir/evil.js'], { maxBuffer: 32 * 1024 })).rejects.toMatchObject({ code: 2 });
    await expect(execFileAsync(process.execPath, [operationToolPath, 'unknown-operation'], { maxBuffer: 32 * 1024 })).rejects.toMatchObject({ code: 2 });
  });

  it('derives the OpenWrt feed link path, attests both hashes, and rejects symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-'));
    try {
      await mkdir(join(root, 'openwrt/feeds'), { recursive: true });
      await mkdir(join(root, 'feeds/chirpstack-openwrt-feed'), { recursive: true });
      const source = 'src-link chirpstack feeds/chirpstack-openwrt-feed\n';
      const expectedDestination = 'src-link chirpstack ../../feeds/chirpstack-openwrt-feed\n';
      await writeFile(join(root, 'feeds.conf.default'), source);
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root);
      const result = await handlers.copyFeedConfig();
      const destination = await readFile(join(root, 'openwrt/feeds.conf.default'), 'utf8');
      expect(destination).toBe(expectedDestination);
      expect(result).toMatchObject({
        sourceSha256: sha256(source),
        destinationSha256: sha256(expectedDestination),
        sha256: sha256(source),
      });
      await symlink('../../feeds/chirpstack-openwrt-feed', join(root, 'openwrt/feeds/chirpstack'));
      expect(await realpath(join(root, 'openwrt/feeds/chirpstack'))).toBe(await realpath(join(root, 'feeds/chirpstack-openwrt-feed')));
      await rm(join(root, 'feeds.conf.default'));
      await symlink('/etc/passwd', join(root, 'feeds.conf.default'));
      await expect(handlers.copyFeedConfig()).rejects.toThrow(/symbolic|symlink|escape/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('masks refresh_config by removing and restoring only the exact active config link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-'));
    try {
      await mkdir(join(root, 'openwrt/scripts'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      const config = join(root, 'conf/.config');
      const activeConfig = join(root, 'openwrt/.config');
      await writeFile(config, 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);
      const spawnCalls: Array<{ readonly file: string; readonly args: readonly string[]; readonly options: Record<string, unknown> }> = [];
      const result = await (await operationToolModule()).runUpdateFeedsForTesting(root, (file, args, options) => {
        spawnCalls.push({ file, args, options });
        expect(existsSync(activeConfig)).toBe(false);
        return { status: 0, signal: null };
      });
      expect(result).toEqual({ operation: 'update-feeds' });
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toMatchObject({
        file: '/proc/self/fd/3/scripts/feeds',
        args: ['update', '-a'],
        options: {
          cwd: expect.stringMatching(/^\/proc\/self\/fd\/\d+$/u),
          detached: true,
          env: expect.objectContaining({ TOPDIR: '/proc/self/fd/3' }),
          shell: false,
          stdio: ['inherit', 'inherit', 'inherit', expect.any(Number)],
        },
      });
      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(config, 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing active config link', async (root: string) => undefined],
    ['wrong active config link', async (root: string) => symlink('../conf/wrong.config', join(root, 'openwrt/.config'))],
  ])('rejects %s before spawning and does not create a replacement', async (_case, setup) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-invalid-'));
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await setup(root);
      const spawn = () => { throw new Error('spawn must not be called'); };
      await expect((await operationToolModule()).runUpdateFeedsForTesting(root, spawn)).rejects.toThrow(/exact.*config link|config link/i);
      if (_case === 'missing active config link') await expect(lstat(join(root, 'openwrt/.config'))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readlink(join(root, 'openwrt/.config'))).toBe('../conf/wrong.config');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['nonzero', { status: 17, signal: null }, /17/u],
    ['signal', { status: null, signal: 'SIGTERM' }, /SIGTERM/u],
    ['spawn error', { status: null, signal: null, error: new Error('ENOENT') }, /spawn/u],
  ] as const)('restores the exact config link after %s update failure', async (_case, child, message) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-failure-'));
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', join(root, 'openwrt/.config'));
      await expect((await operationToolModule()).runUpdateFeedsForTesting(root, () => child)).rejects.toThrow(message);
      expect(await readlink(join(root, 'openwrt/.config'))).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes a child-created config replacement and restores the exact active link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-replacement-'));
    const activeConfig = join(root, 'openwrt/.config');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);

      await expect((await operationToolModule()).runUpdateFeedsForTesting(root, () => {
        writeFileSync(activeConfig, 'CONFIG_UNTRUSTED=y\n');
        return { status: 0, signal: null };
      })).rejects.toThrow(/config link changed/u);

      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers the exact active link when both child replacement paths are occupied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-collision-'));
    const activeConfig = join(root, 'openwrt/.config');
    const mask = join(root, 'openwrt/.osi-image-builder-active-config-mask');
    const replacement = join(root, 'openwrt/.osi-image-builder-active-config-replacement');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);

      await expect((await operationToolModule()).runUpdateFeedsForTesting(root, () => {
        writeFileSync(activeConfig, 'CONFIG_UNTRUSTED=y\n');
        mkdirSync(replacement);
        writeFileSync(join(replacement, 'occupied'), 'untrusted\n');
        return { status: 0, signal: null };
      })).rejects.toThrow(/config link changed|restoration.*anomal/u);

      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
      expect(existsSync(mask)).toBe(false);
      expect(existsSync(replacement)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails before spawning when the active config changes during atomic masking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-mask-race-'));
    const activeConfig = join(root, 'openwrt/.config');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);
      let spawned = false;

      await expect((await operationToolModule()).runUpdateFeedsForTesting(
        root,
        () => { spawned = true; return { status: 0, signal: null }; },
        { onStep: async (point) => {
          if (point !== 'before-config-mask-rename') return;
          await rename(activeConfig, `${activeConfig}.original`);
          await symlink('../conf/wrong.config', activeConfig);
        } },
      )).rejects.toThrow(/restoration failed|changed.*mask|identity|exact active config/u);

      expect(spawned).toBe(false);
      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans an occupied mask after the atomic masking rename fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-mask-collision-'));
    const activeConfig = join(root, 'openwrt/.config');
    const mask = join(root, 'openwrt/.osi-image-builder-active-config-mask');
    const replacement = join(root, 'openwrt/.osi-image-builder-active-config-replacement');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);
      let spawned = false;

      await expect((await operationToolModule()).runUpdateFeedsForTesting(
        root,
        () => { spawned = true; return { status: 0, signal: null }; },
        { onStep: async (point) => {
          if (point !== 'before-config-mask-rename') return;
          await mkdir(mask);
          await writeFile(join(mask, 'occupied'), 'untrusted\n');
        } },
      )).rejects.toThrow(/rename|directory|EISDIR/u);

      expect(spawned).toBe(false);
      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
      expect(existsSync(mask)).toBe(false);
      expect(existsSync(replacement)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects a quarantined-link swap during restoration and leaves the exact active link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-restore-race-'));
    const activeConfig = join(root, 'openwrt/.config');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);

      await expect((await operationToolModule()).runUpdateFeedsForTesting(
        root,
        () => ({ status: 0, signal: null }),
        { onStep: async (point, path) => {
          if (point !== 'before-config-restore-rename') return;
          await rename(path, `${path}.original`);
          await symlink('../conf/wrong.config', path);
        } },
      )).rejects.toThrow(/changed.*restore|identity|quarantined|restoration.*anomal/u);

      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports both operation and restoration failures while recovering the exact active link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-aggregate-'));
    const activeConfig = join(root, 'openwrt/.config');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);

      const failure = (await operationToolModule()).runUpdateFeedsForTesting(
        root,
        () => ({ status: 17, signal: null }),
        { onStep: async (point, path) => {
          if (point !== 'before-config-restore-rename') return;
          await rename(path, `${path}.original`);
          await symlink('../conf/wrong.config', path);
        } },
      );
      await expect(failure).rejects.toBeInstanceOf(AggregateError);
      await expect(failure).rejects.toThrow(/feeds update failed.*restoration failed/u);
      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['after-config-mask-rename', 'before-config-restore-rename'])('retains signal handling through %s and restores the exact active link', async (signalPoint) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-signal-window-'));
    const activeConfig = join(root, 'openwrt/.config');
    const signalSource = new EventEmitter() as TestSignalSource;
    signalSource.kill = () => undefined;
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);
      let spawned = false;

      await expect((await operationToolModule()).runUpdateFeedsForTesting(
        root,
        () => { spawned = true; return { status: 0, signal: null }; },
        { onStep: async (point) => {
          if (point === signalPoint) signalSource.emit('SIGTERM');
        } },
        signalSource,
      )).rejects.toThrow(/SIGTERM/u);

      expect(spawned).toBe(signalPoint === 'before-config-restore-rename');
      expect(await readlink(activeConfig)).toBe('../conf/.config');
      expect(await readFile(join(root, 'conf/.config'), 'utf8')).toBe('CONFIG_ORIGINAL=y\n');
      expect(signalSource.listenerCount('SIGTERM')).toBe(0);
      expect(signalSource.listenerCount('SIGINT')).toBe(0);
      expect(signalSource.listenerCount('SIGHUP')).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('signals the complete detached feeds process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-process-group-'));
    const activeConfig = join(root, 'openwrt/.config');
    const signalSource = new EventEmitter() as TestSignalSource;
    const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    const kills: Array<{ readonly pid: number; readonly signal: string }> = [];
    signalSource.kill = (pid, signal) => {
      kills.push({ pid, signal });
      queueMicrotask(() => child.emit('close', 0, null));
    };
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', activeConfig);

      await expect((await operationToolModule()).runUpdateFeedsForTesting(
        root,
        (_file, _args, options) => {
          expect(options).toMatchObject({
            detached: true,
            env: expect.objectContaining({ TOPDIR: '/proc/self/fd/3' }),
            shell: false,
            stdio: ['inherit', 'inherit', 'inherit', expect.any(Number)],
          });
          queueMicrotask(() => signalSource.emit('SIGTERM'));
          return child;
        },
        {},
        signalSource,
      )).rejects.toThrow(/SIGTERM/u);

      expect(kills).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
      expect(await readlink(activeConfig)).toBe('../conf/.config');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes feeds through the held OpenWrt descriptor and rejects a named-directory swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-update-feeds-directory-swap-'));
    const heldOpenWrt = join(root, 'openwrt-held');
    try {
      await mkdir(join(root, 'openwrt/scripts'), { recursive: true });
      await mkdir(join(root, 'conf'), { recursive: true });
      await writeFile(join(root, 'conf/.config'), 'CONFIG_ORIGINAL=y\n');
      await symlink('../conf/.config', join(root, 'openwrt/.config'));
      const trustedFeeds = join(root, 'openwrt/scripts/feeds');
      await writeFile(trustedFeeds, [
        '#!/bin/sh',
        '[ "$1" = update ] && [ "$2" = -a ] || exit 90',
        '[ "$TOPDIR" = /proc/self/fd/3 ] || exit 91',
        '[ "$(pwd -P)" = "$(cd /proc/self/fd/3 && pwd -P)" ] || exit 92',
        "printf 'trusted\\n' > /proc/self/fd/3/trusted-feed-ran",
        '',
      ].join('\n'));
      await chmod(trustedFeeds, 0o755);

      await expect((await operationToolModule()).runUpdateFeedsForTesting(
        root,
        undefined,
        { onStep: async (point) => {
          if (point !== 'after-config-mask-rename') return;
          await rename(join(root, 'openwrt'), heldOpenWrt);
          await mkdir(join(root, 'openwrt/scripts'), { recursive: true });
          const replacementFeeds = join(root, 'openwrt/scripts/feeds');
          await writeFile(replacementFeeds, `#!/bin/sh\nprintf 'untrusted\\n' > ${JSON.stringify(join(root, 'untrusted-feed-ran'))}\n`);
          await chmod(replacementFeeds, 0o755);
        } },
      )).rejects.toThrow(/named OpenWrt directory identity changed/u);

      expect(await readFile(join(heldOpenWrt, 'trusted-feed-ran'), 'utf8')).toBe('trusted\n');
      expect(existsSync(join(root, 'untrusted-feed-ran'))).toBe(false);
      expect(await readlink(join(heldOpenWrt, '.config'))).toBe('../conf/.config');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives the ChirpStack feed link with source-parser-compatible whitespace and CRLF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-whitespace-'));
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      const source = 'src-git packages https://example.test/packages.git^0123456789012345678901234567890123456789\r\n  src-link chirpstack feeds/chirpstack-openwrt-feed  \r\n';
      const expectedDestination = 'src-git packages https://example.test/packages.git^0123456789012345678901234567890123456789\r\n  src-link chirpstack ../../feeds/chirpstack-openwrt-feed  \r\n';
      await writeFile(join(root, 'feeds.conf.default'), source);

      const result = await (await operationToolModule()).createOperationHandlersForTesting(root).copyFeedConfig();

      expect(await readFile(join(root, 'openwrt/feeds.conf.default'), 'utf8')).toBe(expectedDestination);
      expect(result).toMatchObject({
        sourceSha256: sha256(source),
        destinationSha256: sha256(expectedDestination),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves a UTF-8 BOM before a first-line canonical ChirpStack entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-bom-'));
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      const source = '\uFEFFsrc-link chirpstack feeds/chirpstack-openwrt-feed\n';
      const expectedDestination = '\uFEFFsrc-link chirpstack ../../feeds/chirpstack-openwrt-feed\n';
      await writeFile(join(root, 'feeds.conf.default'), source);

      await (await operationToolModule()).createOperationHandlersForTesting(root).copyFeedConfig();

      expect(await readFile(join(root, 'openwrt/feeds.conf.default'), 'utf8')).toBe(expectedDestination);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing entry', 'src-git packages https://example.test/packages.git^0123456789012345678901234567890123456789\n'],
    ['duplicate canonical entry', 'src-link chirpstack feeds/chirpstack-openwrt-feed\nsrc-link chirpstack feeds/chirpstack-openwrt-feed\n'],
    ['canonical plus noncanonical entry', 'src-link chirpstack feeds/chirpstack-openwrt-feed\nsrc-link chirpstack /tmp/attacker\n'],
    ['canonical plus malformed entry', 'src-link chirpstack feeds/chirpstack-openwrt-feed\nsrc-link chirpstack\n'],
  ])('rejects a %s in the trusted feed derivation', async (_case, source) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-invalid-'));
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await writeFile(join(root, 'feeds.conf.default'), source);
      await expect((await operationToolModule()).createOperationHandlersForTesting(root).copyFeedConfig())
        .rejects.toThrow(/exactly one supported ChirpStack src-link/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid UTF-8 instead of rewriting unrelated feed-config bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-utf8-'));
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await writeFile(join(root, 'feeds.conf.default'), Buffer.concat([
        Buffer.from('src-link chirpstack feeds/chirpstack-openwrt-feed\n# '),
        Buffer.from([0xff]),
        Buffer.from('\n'),
      ]));
      await expect((await operationToolModule()).createOperationHandlersForTesting(root).copyFeedConfig())
        .rejects.toThrow(/UTF-8/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('continues staging writes from the first unwritten buffer byte', async () => {
    const source = await readFile(operationToolPath, 'utf8');
    expect(source).toContain('destination.write(contents, position, contents.length - position, position)');
    expect(source).not.toContain('destination.write(contents, 0, contents.length - position, position)');
  });

  it('mirrors GUI through a clean staging replacement, compares exact files, and rejects symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-'));
    const source = join(root, 'web/react-gui/build');
    const destination = join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
    try {
      await mkdir(source, { recursive: true });
      await mkdir(destination, { recursive: true });
      await writeFile(join(source, 'index.html'), '<title>OSI</title>');
      await writeFile(join(source, 'assets.js'), 'new asset');
      await writeFile(join(destination, 'stale.js'), 'must disappear');
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root);
      await expect(handlers.mirrorGui()).resolves.toMatchObject({ fileCount: 2 });
      await expect(access(join(destination, 'stale.js'))).rejects.toThrow();
      expect(await readFile(join(destination, 'index.html'), 'utf8')).toBe('<title>OSI</title>');
      await symlink('/etc/passwd', join(destination, 'escape.js'));
      await expect(handlers.mirrorGui()).rejects.toThrow(/symbolic|symlink|escape/i);
      await rm(join(destination, 'escape.js'), { force: true });
      await symlink('/etc/passwd', join(source, 'escape.js'));
      await expect(handlers.mirrorGui()).rejects.toThrow(/symbolic|symlink|escape/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['web', 'react-gui'] as const)('rejects GUI source intermediate symlink escapes: %s', async (component) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-outside-'));
    try {
      const outsideBuild = join(outside, 'react-gui/build');
      await mkdir(outsideBuild, { recursive: true });
      await writeFile(join(outsideBuild, 'index.html'), '<title>outside</title>');
      if (component === 'web') {
        await symlink(outside, join(root, 'web'));
      } else {
        await mkdir(join(root, 'web'), { recursive: true });
        await symlink(join(outside, 'react-gui'), join(root, 'web/react-gui'));
      }
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root);
      await expect(handlers.mirrorGui()).rejects.toThrow(/symbolic|symlink|escape/i);
      await expect(access(join(root, 'feeds'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(['openwrt', 'bin'] as const)('rejects image directory intermediate symlink escapes: %s', async (component) => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-image-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-image-outside-'));
    try {
      const outsideBin = join(outside, 'bin');
      await mkdir(join(outsideBin, 'targets/self/profile'), { recursive: true });
      await writeFile(join(outsideBin, 'targets/self/profile/outside.img'), '');
      await truncate(join(outsideBin, 'targets/self/profile/outside.img'), 64 * 1024 * 1024);
      if (component === 'openwrt') {
        await symlink(outside, join(root, 'openwrt'));
      } else {
        await mkdir(join(root, 'openwrt'), { recursive: true });
        await configurePi5(root);
        await symlink(outsideBin, join(root, 'openwrt/bin'));
      }
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root);
      await expect(handlers.verifyImage()).rejects.toThrow(/symbolic|symlink|escape/i);
      const escapedComponent = component === 'openwrt' ? join(root, 'openwrt') : join(root, 'openwrt/bin');
      expect((await lstat(escapedComponent)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('loads the fixed rootfs Node package set and records actual compatible export types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-node-resolve-'));
    const rootfs = join(
      root,
      'openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx',
    );
    const nodeRed = join(rootfs, 'usr/share/node-red');
    const image = join(root, 'openwrt/bin/targets/bcm27xx/bcm2712', pi5FactoryImage);
    const packaged = [
      '@grpc/grpc-js',
      '@chirpstack/chirpstack-api',
      'google-protobuf',
      'protobufjs',
      'osi-chameleon-helper',
      'osi-chirpstack-helper',
      'osi-cloud-http',
      'osi-db-helper',
      'osi-dendro-helper',
      'osi-health-helper',
      'osi-history-helper',
      'osi-history-sync-helper',
      'osi-lib',
    ];
    const direct = [
      'osi-command-ledger',
      'osi-dendro-analytics',
      'osi-zone-env',
      'osi-history-router',
      'osi-journal',
      'osi-device-writer',
      'osi-uc512-normalize',
      'osi-lsn50-normalize',
    ];
    try {
      await mkdir(join(root, 'openwrt/bin/targets/bcm27xx/bcm2712'), { recursive: true });
      await mkdir(join(nodeRed, 'node_modules'), { recursive: true });
      await configurePi5(root);
      await writeFile(image, '');
      await truncate(image, 64 * 1024 * 1024);
      for (const [index, packageName] of packaged.entries()) {
        const packageRoot = join(nodeRed, 'node_modules', packageName);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(
          join(packageRoot, 'package.json'),
          JSON.stringify({ name: packageName, main: 'index.js' }),
        );
        await writeFile(
          join(packageRoot, 'index.js'),
          index % 2 === 0
            ? 'module.exports = { compatible: true };\n'
            : 'module.exports = function compatible() {};\n',
        );
      }
      const chirpstackEntrypoint = join(
        nodeRed,
        'node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js',
      );
      await mkdir(join(chirpstackEntrypoint, '..'), { recursive: true });
      await writeFile(
        chirpstackEntrypoint,
        'module.exports = function compatible() {};\n',
      );
      for (const [index, packageName] of direct.entries()) {
        const packageRoot = join(nodeRed, packageName);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(
          join(packageRoot, 'package.json'),
          JSON.stringify({ name: packageName, main: 'index.js' }),
        );
        await writeFile(
          join(packageRoot, 'index.js'),
          index % 2 === 0
            ? 'module.exports = function compatible() {};\n'
            : 'module.exports = { compatible: true };\n',
        );
      }
      const result = await (await operationToolModule())
        .createOperationHandlersForTesting(root)
        .verifyImage();
      expect(result.targetId).toBe('rpi-5');
      expect(result.nodeResolution).toHaveLength(21);
      expect(result.nodeResolution.map(({ packageName }) => packageName))
        .toEqual([...packaged, ...direct]);
      expect(result.nodeResolution.every(({ resolvedRelativePath }) => (
        !resolvedRelativePath.startsWith('../')
      ))).toBe(true);
      expect(new Set(result.nodeResolution.map(({ exportType }) => exportType)))
        .toEqual(new Set(['function', 'object']));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps GUI reads inside held source descriptors across a fixed-path swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-race-outside-'));
    let swapped = false;
    try {
      const source = join(root, 'web/react-gui/build');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'index.html'), '<title>held source</title>');
      await mkdir(join(outside, 'react-gui/build'), { recursive: true });
      await writeFile(join(outside, 'react-gui/build/index.html'), '<title>outside</title>');
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root, { onStep: async (point) => {
        if (!swapped && point === 'before-file-open') {
          swapped = true;
          await rename(join(root, 'web'), join(root, 'web-original'));
          await symlink(outside, join(root, 'web'));
        }
      } });
      await expect(handlers.mirrorGui()).resolves.toMatchObject({ fileCount: 1 });
      expect(await readFile(join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/index.html'), 'utf8')).toBe('<title>held source</title>');
      expect((await lstat(join(outside, 'react-gui/build/index.html'))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an artifact swapped to an outside symlink before open without reading outside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-image-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-image-race-outside-'));
    let swapped = false;
    try {
      const image = join(root, 'openwrt/bin/targets/bcm27xx/bcm2712', pi5FactoryImage);
      await mkdir(join(root, 'openwrt/bin/targets/bcm27xx/bcm2712'), { recursive: true });
      await configurePi5(root);
      await writeFile(image, '');
      await truncate(image, 64 * 1024 * 1024);
      const outsideImage = join(outside, 'outside.img');
      await writeFile(outsideImage, 'outside');
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root, { onStep: async (point, path) => {
        if (!swapped && point === 'before-file-open' && path.endsWith(`/${pi5FactoryImage}`)) {
          swapped = true;
          await rename(image, `${image}.original`);
          await symlink(outsideImage, image);
        }
      } });
      await expect(handlers.verifyImage()).rejects.toThrow(/stable regular|symbolic|symlink/i);
      expect(await readFile(outsideImage, 'utf8')).toBe('outside');
      expect((await lstat(`${image}.original`)).size).toBe(64 * 1024 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('aborts recursive destination removal when the held entry is swapped before rmdir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-remove-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-remove-race-outside-'));
    let swapped = false;
    try {
      const source = join(root, 'web/react-gui/build');
      const destination = join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'index.html'), '<title>replacement</title>');
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'stale.js'), 'stale');
      await writeFile(join(outside, 'outside.js'), 'outside');
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root, { onStep: async (point, path) => {
        if (!swapped && point === 'before-remove-directory' && path.endsWith('/gui')) {
          swapped = true;
          await rename(destination, `${destination}.original`);
          await symlink(outside, destination);
        }
      } });
      await expect(handlers.mirrorGui()).rejects.toThrow(/changed|symbolic|symlink/i);
      expect(await readFile(join(outside, 'outside.js'), 'utf8')).toBe('outside');
      expect((await lstat(`${destination}.original`)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a GUI staging swap during destination removal without publishing the outside symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-publish-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-publish-outside-'));
    const destination = join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
    const staging = join(root, '.osi-image-builder-gui-staging');
    try {
      await mkdir(join(root, 'web/react-gui/build'), { recursive: true });
      await writeFile(join(root, 'web/react-gui/build/index.html'), '<title>replacement</title>');
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'stale.js'), 'stale');
      await mkdir(join(outside, 'gui'), { recursive: true });
      await writeFile(join(outside, 'gui/outside.js'), 'outside');
      let swapped = false;
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root, { onStep: async (point, path) => {
        if (!swapped && point === 'before-remove' && path.endsWith('/gui')) {
          swapped = true;
          await rename(staging, `${staging}.original`);
          await symlink(join(outside, 'gui'), staging);
        }
      } });
      await expect(handlers.mirrorGui()).rejects.toThrow(/identity|staging|symbolic|symlink/i);
      await expect(lstat(destination)).rejects.toThrow();
      expect((await lstat(staging)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(outside, 'gui/outside.js'), 'utf8')).toBe('outside');
      await expect(handlers.mirrorGui()).resolves.toMatchObject({ fileCount: 1 });
      expect((await lstat(destination)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes a GUI destination symlink after a post-rename identity swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-post-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-gui-post-outside-'));
    const destination = join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
    try {
      await mkdir(join(root, 'web/react-gui/build'), { recursive: true });
      await writeFile(join(root, 'web/react-gui/build/index.html'), '<title>replacement</title>');
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'stale.js'), 'stale');
      await mkdir(join(outside, 'gui'), { recursive: true });
      await writeFile(join(outside, 'gui/outside.js'), 'outside');
      let swapped = false;
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root, { onStep: async (point, path) => {
        if (!swapped && point === 'after-rename' && path.endsWith('/gui')) {
          swapped = true;
          await rename(destination, `${destination}.published`);
          await symlink(join(outside, 'gui'), destination);
        }
      } });
      await expect(handlers.mirrorGui()).rejects.toThrow(/identity|stable|symbolic|symlink/i);
      await expect(lstat(destination)).rejects.toThrow();
      expect(await readFile(join(outside, 'gui/outside.js'), 'utf8')).toBe('outside');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a feed staging swap during destination removal without publishing the outside symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-publish-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-publish-outside-'));
    const destination = join(root, 'openwrt/feeds.conf.default');
    const staging = join(root, '.osi-image-builder-feed-config-staging');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await writeFile(join(root, 'feeds.conf.default'), 'src-link chirpstack feeds/chirpstack-openwrt-feed\n');
      await writeFile(destination, 'stale\n');
      await writeFile(join(outside, 'outside.conf'), 'outside\n');
      let swapped = false;
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root, { onStep: async (point, path) => {
        if (!swapped && point === 'before-remove' && path.endsWith('/feeds.conf.default')) {
          swapped = true;
          await rename(staging, `${staging}.original`);
          await symlink(join(outside, 'outside.conf'), staging);
        }
      } });
      await expect(handlers.copyFeedConfig()).rejects.toThrow(/identity|staging|symbolic|symlink/i);
      await expect(lstat(destination)).rejects.toThrow();
      expect((await lstat(staging)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(outside, 'outside.conf'), 'utf8')).toBe('outside\n');
      await expect(handlers.copyFeedConfig()).resolves.toMatchObject({ operation: 'copy-feed-config' });
      expect((await lstat(destination)).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes a feed destination symlink after a post-rename identity swap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-post-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'osi-operation-tool-feed-post-outside-'));
    const destination = join(root, 'openwrt/feeds.conf.default');
    try {
      await mkdir(join(root, 'openwrt'), { recursive: true });
      await writeFile(join(root, 'feeds.conf.default'), 'src-link chirpstack feeds/chirpstack-openwrt-feed\n');
      await writeFile(destination, 'stale\n');
      await writeFile(join(outside, 'outside.conf'), 'outside\n');
      let swapped = false;
      const handlers = (await operationToolModule()).createOperationHandlersForTesting(root, { onStep: async (point, path) => {
        if (!swapped && point === 'after-rename' && path.endsWith('/feeds.conf.default')) {
          swapped = true;
          await rename(destination, `${destination}.published`);
          await symlink(join(outside, 'outside.conf'), destination);
        }
      } });
      await expect(handlers.copyFeedConfig()).rejects.toThrow(/identity|stable|symbolic|symlink/i);
      await expect(lstat(destination)).rejects.toThrow();
      expect(await readFile(join(outside, 'outside.conf'), 'utf8')).toBe('outside\n');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('hashes firmware through a bounded no-follow stream rather than readFile', async () => {
    const toolContents = await readFile(operationToolPath, 'utf8');
    expect(toolContents).toContain('hashHandle');
    expect(toolContents).toContain('Buffer.allocUnsafe(1024 * 1024)');
    expect(toolContents).not.toContain('readFile(imagePath)');
  });

  it('keeps the system LLVM probe bound to rustc -vV semantic output', async () => {
    const source = await readFile(validatorSource, 'utf8');
    expect(source).toContain("sed -n 's/^LLVM version: *//p'");
    expect(source).toContain("/^LLVM version:\\s*\\d+\\.\\d+/u");
    expect(source).toContain('libPolly.a');
    expect(source).toContain('opt -passes=polly-opt-isl');
  });

  it('validates source hashes and invokes the real production image validator without evidence injection', async () => {
    const source = await validateBuilderSource({ dockerfile, rootDockerfile, executionDefinitionPath, evidence });
    const candidate = lock();
    Object.assign(candidate, { baseImage: source.baseImage, baseImageDigest: source.baseImageDigest, dockerfileSha256: source.dockerfileSha256, executionDefinitionSha256: source.executionDefinitionSha256, validationEvidenceSha256: validationEvidenceSha256(evidence), packageSet: source.packageSet, rustConfig: source.rustConfig, nodeVersion: source.nodeVersion });
    const options = { dockerfile, executionDefinitionPath };
    expect(Object.keys(options).sort()).toEqual(['dockerfile', 'executionDefinitionPath']);
    const result = await validateProductionBuilderLock(candidate, candidate.packageVersion, options);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('production validation unexpectedly accepted an unbuilt image');
    expect(result.reason).toMatch(/No such image|manifest unknown|reference not found/u);
  });

  it('rejects evidence from the incompatible Debian npm runtime', async () => {
    const incompatibleEvidence = { ...evidence, npm: '10.9.2' } as BuilderValidationEvidence & { readonly npm: string };
    await expect(validateBuilderSource({ dockerfile, rootDockerfile, executionDefinitionPath, evidence: incompatibleEvidence })).rejects.toMatchObject({ code: 'BUILDER_VALIDATION_EVIDENCE_INVALID' });
  });

  it('requires the canonical image validator to execute the installed helper self-test', async () => {
    const canonical = `registry.example.invalid/osi-builder@sha256:${digest('a')}`;
    const inspect = JSON.stringify({ Id: `sha256:${digest('b')}`, Architecture: 'amd64', Os: 'linux', Size: 1, RepoDigests: [canonical], Config: { Env: [`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`] } });
    const calls: string[][] = [];
    const result = await validateBuiltBuilderImage(canonical, { run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === 'image') return { stdout: inspect, stderr: '' };
      const command = argv.join(' ');
      if (argv.includes('/opt/osi-image-builder/operations/osi-image-builder-tool.js')) return { stdout: 'helper self-test passed\n', stderr: '' };
      const runtime = argv.slice(7);
      if (runtime[0] === 'node') return { stdout: 'v22.14.0\n', stderr: '' };
      if (runtime[0] === 'npm') return { stdout: '11.10.1\n', stderr: '' };
      if (runtime[0] === 'gcc-14') return { stdout: 'gcc (Debian 14.2.0) 14.2.0\n', stderr: '' };
      if (runtime[0] === '/usr/bin/rustc' && runtime[1] === '-vV') return { stdout: 'rustc 1.85.0\nLLVM version: 19.1.7\n', stderr: '' };
      if (runtime[0] === '/usr/bin/llvm-config') return { stdout: '19.1.7\n', stderr: '' };
      if (command.includes('--showformat=${Package}=${Version')) return { stdout: 'gcc-14=14.2.0\nnodejs=22.14.0\nnpm=10.9.2\nllvm-dev=19.1.7\nlibpolly-19-dev=19.1.7\nlibzstd-dev=1.5.7\nsqlite3=3.46.1-1\n', stderr: '' };
      if (runtime[0] === 'dpkg-query' && command.includes('libpolly-19-dev')) return { stdout: '19.1.7\n', stderr: '' };
      if (runtime[0] === 'pkg-config') return { stdout: '1.5.7\n', stderr: '' };
      if (command.includes('cat /opt/target-sysroots/package-versions')) return { stdout: 'musl:arm64=1.2.5\nmusl-dev:arm64=1.2.5\nmusl:armhf=1.2.5\nmusl-dev:armhf=1.2.5\n', stderr: '' };
      if (command.includes('/usr/bin/rustc --target')) return { stdout: ['x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/std|'.concat(digest('1'), '|x86-64|/tmp/osi-rust-validation/x.o|', digest('2'), '|x86-64'), 'aarch64-unknown-linux-musl|/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/std|'.concat(digest('1'), '|aarch64|/tmp/osi-rust-validation/a.o|', digest('2'), '|aarch64'), 'armv7-unknown-linux-musleabihf|/opt/rust-system/toolchains/1.85.0-x86_64-unknown-linux-gnu|/opt/rust-system/toolchains/std|'.concat(digest('1'), '|ARM|/tmp/osi-rust-validation/arm.o|', digest('2'), '|ARM')].join('\n') + '\n', stderr: '' };
      if (command.includes('llvm_version=')) return { stdout: '19.1.7\nrustc 1.85.0\nLLVM version: 19.1.7\n/usr/lib/llvm-19/lib/libPolly.a /usr/lib/llvm-19/lib/libPollyISL.a\n1.5.7\n', stderr: '' };
      return { stdout: 'ok\n', stderr: '' };
    } });
    expect(result.evidence.operationTool).toEqual({ path: '/opt/osi-image-builder/operations/osi-image-builder-tool.js', owner: '0:0', mode: '0555', user: 'buildbot', result: 'passed' });
    expect(calls.some((argv) => argv.join(' ').includes('/opt/osi-image-builder/operations/osi-image-builder-tool.js'))).toBe(true);
    const helperCall = calls.find((argv) => argv.join(' ').includes('/opt/osi-image-builder/operations/osi-image-builder-tool.js'))!;
    expect(helperCall).toContain('--platform=linux/amd64');
    expect(helperCall).toContain('--pull=never');
    expect(helperCall.join(' ')).toContain('node "$tool" copy-feed-config');
    expect(helperCall.join(' ')).toContain('node "$tool" mirror-gui');
    expect(helperCall.join(' ')).toContain('node "$tool" verify-image');
    const helperScript = helperCall.at(-1)!;
    const pi4Activation = 'node "$tool" activate-target full_raspberrypi_bcm27xx_bcm2709';
    const pi5Activation = 'node "$tool" activate-target full_raspberrypi_bcm27xx_bcm2712';
    expect(helperScript).toContain(pi4Activation);
    expect(helperScript).toContain(pi5Activation);
    expect(helperScript.indexOf(pi4Activation)).toBeLessThan(helperScript.indexOf(pi5Activation));
    for (const assertion of [
      `test "$(readlink /workdir/conf/.config)" = 'full_raspberrypi_bcm27xx_bcm2712/.config'`,
      `test "$(readlink /workdir/conf/files)" = 'full_raspberrypi_bcm27xx_bcm2712/files'`,
      `test "$(readlink /workdir/conf/patches)" = 'full_raspberrypi_bcm27xx_bcm2712/patches'`,
      `test "$(readlink /workdir/openwrt/.config)" = '../conf/.config'`,
      `test "$(readlink /workdir/openwrt/files)" = '../conf/files'`,
      `test "$(readlink /workdir/openwrt/patches)" = '../conf/patches'`,
    ]) expect(helperScript).toContain(assertion);
    expect(helperScript).toContain('CONFIG_TARGET_PROFILE="DEVICE_rpi-5"');
    expect(helperScript).toContain(
      'openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx',
    );
    expect(helperScript).toContain('node_red="$rootfs/usr/share/node-red"');
    expect(helperScript).toContain(
      'probe=/opt/osi-image-builder/operations/osi-image-builder-module-probe.js',
    );
    expect(helperScript).toContain("require('sqlite3')");
    expect(helperScript).toContain("require('process')");
    expect(helperScript).toContain("require('node:child_process')");
    expect(helperScript).toContain("process.getBuiltinModule('node:sqlite')");
    expect(helperScript).toContain(
      '@chirpstack/chirpstack-api/api/application_grpc_pb.js',
    );
    expect(helperScript).toContain('relativeHelpers');
    expect(helperScript).toContain("'osi-db-helper'");
    expect(helperScript).toContain(
      "'node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js'",
    );
    expect(helperScript).toContain('resolvedRelativePath');
    expect(helperScript).toContain('exportType');
    expect(helperScript).toContain('JSON.stringify(actual) !== JSON.stringify(expected)');
    expect(helperScript).toContain('JSON.stringify replacement forged an incompatible export');
    expect(helperScript).toContain('Object.prototype.toJSON forged an incompatible export');
    expect(helperScript).toContain('globalThis.Promise = class PoisonedPromise');
    expect(helperScript).toContain("setImmediate(() => import(['node', 'sqlite'].join(':'))");
    await expect(execFileAsync('/bin/sh', ['-n', '-c', helperScript])).resolves.toMatchObject({
      stdout: '',
      stderr: '',
    });
    const localSelfTest = await mkdtemp(join(tmpdir(), 'osi-builder-self-test-'));
    try {
      const localTool = join(localSelfTest, 'osi-image-builder-tool.js');
      const localProbe = join(localSelfTest, 'osi-image-builder-module-probe.js');
      const localGuard = join(localSelfTest, 'osi-image-builder-exec-guard.js');
      const localProxy = join(localSelfTest, 'osi-dependency-egress-proxy.cjs');
      const localCredentialEnvironment = join(localSelfTest, 'osi-proxy-credential-environment.cjs');
      const localWgetConfig = join(localSelfTest, 'osi-wgetrc');
      await writeFile(localProbe, await readFile(moduleProbePath, 'utf8'));
      await writeFile(localProxy, await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url), 'utf8'));
      await writeFile(localCredentialEnvironment, await readFile(new URL('../../builder/operations/osi-proxy-credential-environment.cjs', import.meta.url), 'utf8'));
      await writeFile(localWgetConfig, await readFile(new URL('../../builder/operations/osi-wgetrc', import.meta.url), 'utf8'));
      const localToolSource = (await readFile(operationToolPath, 'utf8')).replace(
        "const WORKTREE = '/workdir';",
        `const WORKTREE = '${localSelfTest}';`,
      ).replace(
        "const INSTALLED_NODE_BINARY = '/usr/local/bin/node';",
        `const INSTALLED_NODE_BINARY = '${process.execPath}';`,
      ).replace(
        "  '/opt/osi-image-builder/operations/osi-image-builder-module-probe.js';",
        `  '${localProbe}';`,
      );
      await writeFile(localTool, localToolSource);
      await writeFile(localGuard, (await readFile(new URL('../../builder/operations/osi-image-builder-exec-guard.js', import.meta.url), 'utf8')).replace(
        "const WORKTREE = '/workdir';",
        `const WORKTREE = '${localSelfTest}';`,
      ).replace(
        "const TOOL = '/opt/osi-image-builder/operations/osi-image-builder-tool.js';",
        `const TOOL = '${localTool}';`,
      ).replace(
        "const WORKING_DIRECTORIES = new Set(['/workdir', '/workdir/web/react-gui']);",
        `const WORKING_DIRECTORIES = new Set(['${localSelfTest}', '${localSelfTest}/web/react-gui']);`,
      ));
      await chmod(localGuard, 0o555);
      await chmod(localProxy, 0o555);
      await chmod(localCredentialEnvironment, 0o555);
      await chmod(localWgetConfig, 0o444);
      const functionalStart = helperScript.indexOf('node --check "$tool"');
      expect(functionalStart).toBeGreaterThan(0);
      const functionalScript = [
        'set -eu',
        `tool='${localTool}'`,
        `probe='${localProbe}'`,
        `cd '${localSelfTest}'`,
        helperScript
          .slice(functionalStart)
          .replaceAll('/workdir', localSelfTest)
          .replaceAll(
            '/opt/osi-image-builder/operations/osi-image-builder-module-probe.js',
            localProbe,
          )
          .replaceAll('/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js', localGuard)
          .replaceAll('/opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs', localProxy)
          .replaceAll('/opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs', localCredentialEnvironment)
          .replaceAll('/opt/osi-image-builder/operations/osi-wgetrc', localWgetConfig)
          .replaceAll(
            `test "$(stat -c '%u:%g' "$guard")" = '0:0'`,
            `test "$(stat -c '%u:%g' "$guard")" = "$(id -u):$(id -g)"`,
          )
          .replaceAll(
            `test "$(stat -c '%u:%g' "$proxy")" = '0:0'`,
            `test "$(stat -c '%u:%g' "$proxy")" = "$(id -u):$(id -g)"`,
          )
          .replaceAll(
            `test "$(stat -c '%u:%g' "$credential_environment")" = '0:0'`,
            `test "$(stat -c '%u:%g' "$credential_environment")" = "$(id -u):$(id -g)"`,
          )
          .replaceAll(
            `test "$(stat -c '%u:%g' "$wget_config")" = '0:0'`,
            `test "$(stat -c '%u:%g' "$wget_config")" = "$(id -u):$(id -g)"`,
          ),
      ].join('\n');
      await expect(execFileAsync('/bin/sh', ['-c', functionalScript], {
        maxBuffer: 1024 * 1024,
      })).resolves.toMatchObject({
        stdout: expect.stringContaining('trusted operation tool:'),
        stderr: '',
      });
    } finally {
      await rm(localSelfTest, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['absent', 'wrong-owner', 'wrong-mode', 'unrunnable'] as const)('rejects an installed helper self-test failure: %s', async (failure) => {
    const canonical = `registry.example.invalid/osi-builder@sha256:${digest('a')}`;
    const inspect = JSON.stringify({ Id: `sha256:${digest('b')}`, Architecture: 'amd64', Os: 'linux', Size: 1, RepoDigests: [canonical], Config: { Env: [`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`] } });
    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => {
      if (argv[0] === 'image') return { stdout: inspect, stderr: '' };
      if (argv.join(' ').includes('/opt/osi-image-builder/operations/osi-image-builder-tool.js')) throw Object.assign(new Error(`helper ${failure}`), { code: 1, stderr: failure });
      return { stdout: 'ok\n', stderr: '' };
    } })).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
  });

  it('requires resolved Rust LLVM evidence and rejects Rust CI artifacts', async () => {
    expect(validateRustToolchain({ llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }).ok).toBe(true);
    expect(validateRustToolchain({ llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19, artifact: 'rust-ci-llvm' }).ok).toBe(false);
    expect(validateRustToolchainEvidence({ rustcVersion: '1.85.0', llvmVersion: '19.1.7', llvmConfig: '/usr/bin/llvm-config', channel: 'stable', pollyVersion: '19.1.7', zstdVersion: '1.5.7' }).ok).toBe(true);
    expect(validateRustToolchainEvidence({ rustcVersion: '1.85.0', llvmVersion: 'rust-ci-llvm', llvmConfig: '/usr/bin/llvm-config', channel: 'stable', pollyVersion: '19.1.7', zstdVersion: '1.5.7' }).ok).toBe(false);
    const source = await readFile(rustMakefileFixturePath, 'utf8');
    expect(sha256(source)).toBe('e6a9895c3e4e36b1699fa472f8943ee7bc838ca7daeae1902c2abfb83379d5cb');
    const contract = OPENWRT_RUST_FEED_CONTRACT;
    const enforced = enforceOpenWrtRustFeed(source, contract);
    expect(enforced).toMatchObject({ ok: true, sourceSha256: contract.sourceSha256, enforcedSha256: contract.enforcedSha256 });
    if (enforced.ok) {
      expect(enforced.source).toContain('\t--set=llvm.download-ci-llvm=false \\\n\t--set=target.x86_64-unknown-linux-gnu.llvm-config=/usr/bin/llvm-config \\\n');
      expect(enforced.source.match(/--set=llvm\.download-ci-llvm=false /gu)).toHaveLength(1);
      expect(enforced.source.match(/--set=target\.x86_64-unknown-linux-gnu\.llvm-config=\/usr\/bin\/llvm-config /gu)).toHaveLength(1);
      expect(validateOpenWrtRustFeed(enforced.source).ok).toBe(true);
    }
    expect(enforceOpenWrtRustFeed(source, { ...contract, sourceCommit: '0'.repeat(40) }).ok).toBe(false);
    expect(enforceOpenWrtRustFeed(`${source}\n`, contract).ok).toBe(false);
    expect(enforceOpenWrtRustFeed(source.replace('--set=llvm.download-ci-llvm=true \\\n', '--set=llvm.download-ci-llvm=true \\\n\t--set=llvm.download-ci-llvm=true \\\n'), contract).ok).toBe(false);
  });

  it('requires canonical repository digests and classifies Docker availability separately from Rust failures', async () => {
    const canonical = `registry.example.invalid/osi-builder@sha256:${digest('a')}`;
    expect(parseCanonicalBuilderImageReference(canonical)).toEqual({ imageRepository: 'registry.example.invalid/osi-builder', imageDigest: digest('a') });
    expect(selectExactRepositoryDigest(canonical, [`other@sha256:${digest('b')}`, canonical])).toBe(digest('a'));
    expect(() => selectExactRepositoryDigest(canonical, [canonical, canonical])).toThrow(/exactly one/u);
    const inspect = JSON.stringify({ Id: `sha256:${digest('b')}`, Architecture: 'amd64', Os: 'linux', Size: 1, RepoDigests: [canonical], Config: { Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'] } });
    const semanticFailure = Object.assign(new Error('rust probe failed'), { code: 1, stderr: 'target artifact missing' });
    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => { if (argv[0] === 'image') return { stdout: inspect, stderr: '' }; throw semanticFailure; } })).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    const unavailable = Object.assign(new Error('docker missing'), { code: 'ENOENT' });
    await expect(validateBuiltBuilderImage(canonical, { run: async () => { throw unavailable; } })).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });

    for (const code of ['ENOENT', 'EACCES'] as const) {
      const runtimeSpawnFailure = Object.assign(new Error(`docker ${code}`), { code });
      await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => argv[0] === 'image' ? { stdout: inspect, stderr: '' } : Promise.reject(runtimeSpawnFailure) })).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    }
    const runtimeMissingImage = Object.assign(new Error('image disappeared'), { code: 1, stderr: `Error response from daemon: No such image: ${canonical}` });
    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => argv[0] === 'image' ? { stdout: inspect, stderr: '' } : Promise.reject(runtimeMissingImage) })).rejects.toMatchObject({ code: 'BUILDER_IMAGE_DIGEST_INVALID' });

    const runtimePermission = Object.assign(new Error('rustc permission denied'), { code: 1, stderr: 'rustc: permission denied' });
    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => argv[0] === 'image' ? { stdout: inspect, stderr: '' } : Promise.reject(runtimePermission) })).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    const runtimeTimeout = Object.assign(new Error('container command timed out'), { code: 'ETIMEDOUT', stderr: 'rustc timed out' });
    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => argv[0] === 'image' ? { stdout: inspect, stderr: '' } : Promise.reject(runtimeTimeout) })).rejects.toMatchObject({ code: 'RUST_BOOTSTRAP_UNAVAILABLE' });
    const socketPermission = Object.assign(new Error('Docker socket permission denied'), { code: 1, stderr: '/var/run/docker.sock: permission denied' });
    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => argv[0] === 'image' ? { stdout: inspect, stderr: '' } : Promise.reject(socketPermission) })).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    const runtimeArgs = builderRuntimeArguments(canonical, ['/usr/bin/rustc', '-vV']);
    expect(runtimeArgs).toEqual(['run', '--platform=linux/amd64', '--pull=never', '--rm', '--network', 'none', canonical, '/usr/bin/rustc', '-vV']);
    expect(runtimeArgs.slice(0, 7)).toEqual(['run', '--platform=linux/amd64', '--pull=never', '--rm', '--network', 'none', canonical]);
  });

  it('classifies missing images and malformed inspect output separately from Docker availability', async () => {
    const canonical = `registry.example.invalid/osi-builder@sha256:${digest('a')}`;
    const missingImage = Object.assign(new Error('image lookup failed'), { code: 1, stderr: `Error response from daemon: No such image: ${canonical}` });
    await expect(validateBuiltBuilderImage(canonical, { run: async () => { throw missingImage; } })).rejects.toMatchObject({ code: 'BUILDER_IMAGE_DIGEST_INVALID' });

    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => argv[0] === 'image' ? { stdout: '{not-json', stderr: '' } : { stdout: '', stderr: '' } })).rejects.toMatchObject({ code: 'BUILDER_VALIDATION_EVIDENCE_INVALID' });
  });

  it('rejects build-only values in the inspected runtime environment', async () => {
    const canonical = `registry.example.invalid/osi-builder@sha256:${digest('a')}`;
    const inspect = JSON.stringify({ Id: `sha256:${digest('b')}`, Architecture: 'amd64', Os: 'linux', Size: 1, RepoDigests: [canonical], Config: { Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'CARGO_HOME=/opt/cargo'] } });
    await expect(validateBuiltBuilderImage(canonical, { run: async (argv) => argv[0] === 'image' ? { stdout: inspect, stderr: '' } : { stdout: '', stderr: '' } })).rejects.toMatchObject({ code: 'BUILDER_RUNTIME_ENV_INVALID' });
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
