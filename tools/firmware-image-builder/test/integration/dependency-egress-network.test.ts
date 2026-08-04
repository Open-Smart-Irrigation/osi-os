import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { probeDocker, validateBuiltBuilderImage, validationEvidenceSha256 } from '../../builder/validate-builder.js';
import { createDockerContainerName, createDockerExecutor } from '../../runner/src/docker-executor.js';
import type { RunnerWriteCommand } from '../../api/src/ownership.js';
import {
  createDependencyEgressCredential,
  destroyDependencyEgressCredential,
} from '../../runner/src/dependency-egress-credential.js';
import {
  createDependencyEgressNetwork,
  dependencyProxyEnvironment,
  destroyDependencyEgressNetwork,
  parseDependencyEgressNetwork,
  recoverDependencyEgressForJob,
  type DependencyCredentialIdentity,
  type DependencyEgressNetwork,
} from '../../runner/src/dependency-egress-proxy.js';

const execFileAsync = promisify(execFile);
const BASE_IMAGE = 'osi-image-builder@sha256:d5da61222652ad92b1e6b47b4407d4b16ab28cc6ffe966d5b9a91c5ecd6ec9cb';
const resourcesToClean: DependencyEgressNetwork[] = [];
const credentialsToClean: DependencyCredentialIdentity[] = [];
const containersToClean: string[] = [];
const directoriesToClean: string[] = [];

async function docker(argv: readonly string[], timeout = 30_000) {
  try {
    const result = await execFileAsync('/usr/bin/docker', [...argv], { maxBuffer: 1024 * 1024, timeout });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string; readonly message?: string };
    return { exitCode: typeof value.code === 'number' ? value.code : 1, stdout: value.stdout ?? '', stderr: value.stderr ?? value.message ?? '' };
  }
}

async function inspectRuntimeImage(): Promise<Readonly<{ reference: string; imageId: string; imageDigest: string; validationEvidenceSha256: string }>> {
  const inspected = await docker(['image', 'inspect', '--format={{json .}}', BASE_IMAGE]);
  expect(inspected.exitCode, inspected.stderr).toBe(0);
  const image = JSON.parse(inspected.stdout) as { readonly Id: string; readonly Config: { readonly User: string } };
  expect(image.Id).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(image.Config.User).toBe('buildbot');
  const installedPolicy = await docker(['run', '--rm', '--network=none', '--entrypoint=/bin/sh', BASE_IMAGE, '-ceu', String.raw`
test "$(stat -c '%u:%g:%a' /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js)" = '0:0:555'
test "$(stat -c '%u:%g:%a' /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs)" = '0:0:555'
test "$(stat -c '%u:%g:%a' /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs)" = '0:0:555'
test "$(stat -c '%u:%g:%a' /opt/osi-image-builder/operations/osi-wgetrc)" = '0:0:444'
printf '%s  %s\n' \
  9d484b8a438ddcab8d35ebf85e4a0cf03cfe167f4919c3057071135ce16c3fe6 /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js \
  84832d32bc6c0028218f58ebe392678361fcd2e315dad5af4dbad3b847502ac5 /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs \
  ce6a981786811b9d9f5cc1d86b8b6664900ac29748b6dd9c0a543809d550e684 /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs \
  21610fb0e4cc78052b4e5a4582300bea2affeaf2f1501d14662a8137cdb443aa /opt/osi-image-builder/operations/osi-wgetrc \
  | sha256sum --check --status
`]);
  expect(installedPolicy.exitCode, installedPolicy.stderr || installedPolicy.stdout).toBe(0);
  const guard = await docker(['run', '--rm', '--network=none', BASE_IMAGE, 'node', '/opt/osi-image-builder/operations/osi-image-builder-exec-guard.js']);
  expect(guard.exitCode).toBe(126);
  expect(guard.stderr).toContain('guard arguments are incomplete');
  const validated = await validateBuiltBuilderImage(BASE_IMAGE);
  expect(validated.imageId).toBe(image.Id);
  return { reference: BASE_IMAGE, imageId: image.Id, imageDigest: image.Id.slice('sha256:'.length), validationEvidenceSha256: validationEvidenceSha256(validated.evidence) };
}

async function runBranch(
  image: string,
  resources: DependencyEgressNetwork,
  script: string,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const environment = dependencyProxyEnvironment(resources);
  const trustedEnvironment = {
    ...environment,
    CURL_CA_BUNDLE: '/run/osi-image-builder/ca.pem',
    SSL_CERT_FILE: '/run/osi-image-builder/ca.pem',
    GIT_SSL_CAINFO: '/run/osi-image-builder/ca.pem',
    NODE_EXTRA_CA_CERTS: '/run/osi-image-builder/ca.pem',
  };
  return docker([
    'run', '--rm',
    `--network=${resources.network.name}`,
    '--user=1000:1000',
    `--mount=type=bind,source=${resources.credential.hostPath},destination=${resources.credential.containerPath},readonly`,
    `--mount=type=bind,source=${resources.tls.caCertificateHostPath},destination=/run/osi-image-builder/ca.pem,readonly`,
    ...Object.entries(trustedEnvironment).map(([key, value]) => `--env=${key}=${value}`),
    image,
    'node', '--input-type=module', '--eval', script,
  ], 60_000);
}

afterEach(async () => {
  while (containersToClean.length > 0) await docker(['rm', '--force', containersToClean.pop()!]);
  while (resourcesToClean.length > 0) {
    await destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run: (command) => docker(command.slice(1)) }, resourcesToClean.pop()!).catch(() => undefined);
  }
  while (credentialsToClean.length > 0) await destroyDependencyEgressCredential(credentialsToClean.pop()!).catch(() => undefined);
  while (directoriesToClean.length > 0) await rm(directoriesToClean.pop()!, { recursive: true, force: true });
});

describe('real Docker dependency egress boundary', () => {
  it('enforces authenticated allowlisted egress and leaves no resources after crash-style recovery', async () => {
    const capability = await probeDocker();
    expect(capability.available, 'real Docker is required for the dependency egress boundary test').toBe(true);
    expect(capability.architecture, 'real Docker must be linux/amd64').toBe('amd64');
    const base = await docker(['image', 'inspect', BASE_IMAGE]);
    expect(base.exitCode, `required base image ${BASE_IMAGE} is missing: ${base.stderr}`).toBe(0);

    const image = await inspectRuntimeImage();
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'osi-egress-credential-'));
    directoriesToClean.push(credentialDirectory);
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    const credential = await createDependencyEgressCredential({
      directory: credentialDirectory,
      jobId: `network-test-${String(process.pid)}`,
      operationId: 'frontend-install',
      attempt: 1,
    });
    credentialsToClean.push(credential);
    const resources = await createDependencyEgressNetwork({
      dockerPath: '/usr/bin/docker',
      imageReference: image.imageId,
      imageId: image.imageId,
      imageDigest: image.imageDigest,
      jobId: `network-test-${String(process.pid)}`,
      operationId: 'frontend-install',
      attempt: 1,
      uid: 1000,
      gid: 1000,
      manifestSha256: 'a'.repeat(64),
      credential,
      run: (command) => docker(command.slice(1)),
    });
    resourcesToClean.push(resources);

    const branch = await runBranch(image.reference, resources, String.raw`
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const token = readFileSync(process.env.OSI_EGRESS_PROXY_CREDENTIAL_FILE, 'utf8');
const authenticatedProxy = 'http://osi:' + token + '@osi-egress-proxy:3128';
function curl(url, proxy) {
  const args = ['--silent', '--show-error', '--http1.1', '--max-time', '8', '--output', '/dev/null', '--write-out', '%{http_code}'];
  if (proxy === null) args.push('--noproxy', '*'); else args.push('--proxy', proxy);
  args.push(url);
  const result = spawnSync('curl', args, { encoding: 'utf8' });
  return { status: result.status, output: result.stdout.trim() };
}
for (const url of ['http://127.0.0.1:43120/', 'http://10.42.0.7/', 'https://osicloud.ch/']) {
  if (curl(url, null).status === 0) throw new Error('direct destination unexpectedly reachable: ' + url);
}
if (curl('http://osicloud.ch/', authenticatedProxy).output !== '403') throw new Error('production host was not denied');
if (curl('http://[::ffff:127.0.0.1]/', authenticatedProxy).output !== '403') throw new Error('mapped IPv6 destination was not denied');
const allowlisted = curl('https://registry.npmjs.org/', authenticatedProxy);
if (allowlisted.status !== 0) {
  const trace = spawnSync('curl', ['--verbose', '--http1.1', '--max-time', '8', '--output', '/dev/null', '--proxy', authenticatedProxy, 'https://registry.npmjs.org/'], { encoding: 'utf8' });
  throw new Error('allowlisted dependency egress failed: ' + JSON.stringify({ ...allowlisted, trace: trace.stderr }));
}
if (curl('http://registry.npmjs.org/', 'http://osi-egress-proxy:3128').output !== '407') throw new Error('unauthenticated peer was not denied');
const npmEnvironment = { ...process.env, HTTP_PROXY: authenticatedProxy, HTTPS_PROXY: authenticatedProxy, ALL_PROXY: authenticatedProxy, http_proxy: authenticatedProxy, https_proxy: authenticatedProxy, all_proxy: authenticatedProxy };
delete npmEnvironment.OSI_EGRESS_PROXY_CREDENTIAL_FILE;
const npm = spawnSync('npm', ['view', 'react', 'version', '--registry=https://registry.npmjs.org/'], { encoding: 'utf8', env: npmEnvironment, timeout: 20_000 });
if (npm.status !== 0 || !/^\d+\.\d+\.\d+/u.test(npm.stdout.trim())) throw new Error('frontend dependency workflow failed: ' + npm.stdout + npm.stderr);

await new Promise((resolve, reject) => {
  const socket = connect({ host: 'osi-egress-proxy', port: 3128 });
  let headers = '';
  socket.once('connect', () => socket.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\nProxy-Authorization: Basic ' + Buffer.from('osi:' + token).toString('base64') + '\r\n\r\n'));
  socket.on('data', (chunk) => {
    headers += chunk.toString('latin1');
    if (!headers.includes('\r\n\r\n')) return;
    socket.removeAllListeners('data');
    if (!headers.startsWith('HTTP/1.1 200')) return reject(new Error('CONNECT setup was not accepted for the allowlisted authority'));
    const tls = tlsConnect({ socket, servername: 'osicloud.ch', rejectUnauthorized: false });
    tls.once('secureConnect', () => reject(new Error('SNI alias tunnel reached an upstream TLS endpoint')));
    tls.once('error', () => resolve());
    tls.setTimeout(8_000, () => reject(new Error('SNI alias tunnel was not rejected')));
  });
  socket.once('error', reject);
});
`);
    const proxyLogResult = branch.exitCode === 0 ? undefined : await docker(['logs', resources.proxy.id]);
    const proxyLogs = proxyLogResult === undefined ? '' : proxyLogResult.stdout + proxyLogResult.stderr;
    expect(branch.exitCode, proxyLogs + '\n' + branch.stderr + '\n' + branch.stdout).toBe(0);

    const attacker = await docker([
      'run', '--detach', `--network=${resources.network.name}`,
      '--network-alias=registry.npmjs.org', image.reference, 'sleep', '30',
    ]);
    expect(attacker.exitCode, attacker.stderr).toBe(0);
    const attackerId = attacker.stdout.trim();
    containersToClean.push(attackerId);
    const unauthenticatedPeer = await docker([
      'exec', attackerId,
      'curl', '--silent', '--max-time', '3', '--output', '/dev/null', '--write-out', '%{http_code}',
      '--proxy', 'http://osi-egress-proxy:3128', 'http://registry.npmjs.org/',
    ]);
    expect(unauthenticatedPeer.stdout.trim()).toBe('407');
    const attackerInspect = await docker(['inspect', '--format={{json .Mounts}}', attackerId]);
    expect(JSON.parse(attackerInspect.stdout)).toEqual([]);
    const rebound = await runBranch(image.reference, resources, String.raw`
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const token = readFileSync(process.env.OSI_EGRESS_PROXY_CREDENTIAL_FILE, 'utf8');
const result = spawnSync('curl', ['--silent', '--max-time', '5', '--output', '/dev/null', '--write-out', '%{http_code}', '--proxy', 'http://osi:' + token + '@osi-egress-proxy:3128', 'http://registry.npmjs.org/'], { encoding: 'utf8' });
if (result.stdout.trim() !== '403') throw new Error('private DNS rebind was not denied: ' + result.stdout + result.stderr);
`);
    expect(rebound.exitCode, rebound.stderr || rebound.stdout).toBe(0);
    await docker(['rm', '--force', attackerId]);
    containersToClean.splice(containersToClean.indexOf(attackerId), 1);

    const bridgePeer = await docker([
      'run', '--rm', '--network=bridge', image.reference,
      'curl', '--silent', '--show-error', '--max-time', '3', `http://${resources.proxy.bridgeAddress}:3128/`,
    ]);
    expect(bridgePeer.exitCode, 'proxy unexpectedly accepted a bridge-peer connection').not.toBe(0);

    expect(parseDependencyEgressNetwork(JSON.parse(JSON.stringify(resources)))).toEqual(resources);
    const recovered = await recoverDependencyEgressForJob({
      dockerPath: '/usr/bin/docker',
      imageReference: image.imageId,
      imageId: image.imageId,
      imageDigest: image.imageDigest,
      jobId: `network-test-${String(process.pid)}`,
      uid: 1000,
      gid: 1000,
      manifestSha256: 'a'.repeat(64),
      credentialDirectory,
      run: (command) => docker(command.slice(1)),
    });
    resourcesToClean.splice(resourcesToClean.indexOf(resources), 1);
    expect(recovered).toEqual({
      docker: [{
        operationId: 'frontend-install',
        attempt: 1,
        proxy: { id: resources.proxy.id, absent: true },
        network: { id: resources.network.id, absent: true },
        tls: { hostDirectory: resources.tls.hostDirectory, absent: true },
        credential: { hostPath: resources.credential.hostPath, sha256: resources.credential.sha256 },
      }],
      credentials: [resources.credential],
      globalLabelResult: 'no-match',
    });
    const credentialCleanup = await destroyDependencyEgressCredential(recovered.credentials[0]!);
    credentialsToClean.splice(credentialsToClean.indexOf(credential), 1);
    expect(credentialCleanup).toMatchObject({ hostPath: credential.hostPath, expectedSha256: credential.sha256, observedSha256: credential.sha256, absent: true });
    await expect(lstat(credential.hostPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await docker(['inspect', '--type=container', resources.proxy.id])).exitCode).not.toBe(0);
    expect((await docker(['network', 'inspect', resources.network.id])).exitCode).not.toBe(0);

    const cancellationCredential = await createDependencyEgressCredential({
      directory: credentialDirectory,
      jobId: `network-test-${String(process.pid)}`,
      operationId: 'frontend-install',
      attempt: 2,
    });
    credentialsToClean.push(cancellationCredential);
    const cancellationResources = await createDependencyEgressNetwork({
      dockerPath: '/usr/bin/docker',
      imageReference: image.imageId,
      imageId: image.imageId,
      imageDigest: image.imageDigest,
      jobId: `network-test-${String(process.pid)}`,
      operationId: 'frontend-install',
      attempt: 2,
      uid: 1000,
      gid: 1000,
      manifestSha256: 'a'.repeat(64),
      credential: cancellationCredential,
      run: (command) => docker(command.slice(1)),
    });
    resourcesToClean.push(cancellationResources);
    const cancellationEnvironment = dependencyProxyEnvironment(cancellationResources);
    const cancellable = await docker([
      'run', '--detach', `--network=${cancellationResources.network.name}`,
      '--user=1000:1000',
      `--mount=type=bind,source=${cancellationCredential.hostPath},destination=${cancellationCredential.containerPath},readonly`,
      `--mount=type=bind,source=${cancellationResources.tls.caCertificateHostPath},destination=/run/osi-image-builder/ca.pem,readonly`,
      ...Object.entries(cancellationEnvironment).map(([key, value]) => `--env=${key}=${value}`),
      image.reference, 'sleep', '30',
    ]);
    expect(cancellable.exitCode, cancellable.stderr).toBe(0);
    const cancellableId = cancellable.stdout.trim();
    containersToClean.push(cancellableId);
    expect((await docker(['stop', '--time=1', cancellableId])).exitCode).toBe(0);
    expect((await docker(['rm', cancellableId])).exitCode).toBe(0);
    containersToClean.splice(containersToClean.indexOf(cancellableId), 1);
    await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run: (command) => docker(command.slice(1)) }, cancellationResources)).resolves.toEqual({
      proxy: { id: cancellationResources.proxy.id, absent: true },
      network: { id: cancellationResources.network.id, absent: true },
      tls: { hostDirectory: cancellationResources.tls.hostDirectory, absent: true },
      globalLabelResult: 'no-match',
    });
    resourcesToClean.splice(resourcesToClean.indexOf(cancellationResources), 1);
    await expect(destroyDependencyEgressCredential(cancellationCredential)).resolves.toMatchObject({ absent: true });
    credentialsToClean.splice(credentialsToClean.indexOf(cancellationCredential), 1);
    expect((await docker(['inspect', '--type=container', cancellationResources.proxy.id])).exitCode).not.toBe(0);
    expect((await docker(['network', 'inspect', cancellationResources.network.id])).exitCode).not.toBe(0);
  }, 300_000);

  it('runs npm, Git, curl, wget, and OpenWrt downloads through createDockerExecutor and the production guard', async () => {
    const capability = await probeDocker();
    expect(capability.available).toBe(true);
    const image = await inspectRuntimeImage();
    const fixture = await mkdtemp(join(tmpdir(), 'osi-executor-worktree-'));
    directoriesToClean.push(fixture);
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'osi-executor-credentials-'));
    directoriesToClean.push(credentialDirectory);
    await mkdir(join(fixture, 'web/react-gui'), { recursive: true });
    await mkdir(join(fixture, 'openwrt/scripts'), { recursive: true });
    await writeFile(join(fixture, 'web/react-gui/package.json'), JSON.stringify({ name: 'executor-fixture', version: '1.0.0', private: true, dependencies: { 'is-number': '7.0.0' } }));
    await writeFile(join(fixture, 'web/react-gui/package-lock.json'), JSON.stringify({ name: 'executor-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'executor-fixture', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } }, 'node_modules/is-number': { version: '7.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz', integrity: 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==' } } }));
    const openWrtDownload = join(fixture, 'openwrt/scripts/download.pl');
    await writeFile(openWrtDownload, await readFile(join(process.cwd(), '../../openwrt/scripts/download.pl'), 'utf8'));
    await writeFile(join(fixture, 'openwrt/scripts/projectsmirrors.json'), await readFile(join(process.cwd(), '../../openwrt/scripts/projectsmirrors.json'), 'utf8'));
    await writeFile(join(fixture, 'openwrt/scripts/mkhash.c'), await readFile(join(process.cwd(), '../../openwrt/scripts/mkhash.c'), 'utf8'));
    await chmod(openWrtDownload, 0o755);
    await writeFile(join(fixture, 'openwrt/Makefile'), String.raw`all:
	@set -eu; \
	test "$$WGETRC" = /opt/osi-image-builder/operations/osi-wgetrc; \
	npm --prefix ../web/react-gui ci --ignore-scripts --no-audit --no-fund; \
	git ls-remote https://github.com/openwrt/openwrt.git HEAD >/tmp/osi-git-head; \
	curl --fail --silent --show-error https://sources.cdn.openwrt.org/musl-1.2.5.tar.gz --output /tmp/osi-curl-musl.tar.gz; \
	wget --quiet https://sources.cdn.openwrt.org/musl-1.2.5.tar.gz --output-document=/tmp/osi-wget-musl.tar.gz; \
	cc scripts/mkhash.c -o /tmp/osi-mkhash; \
	mkdir -p /tmp/osi-openwrt-download; \
	DOWNLOAD_CHECK_CERTIFICATE=y DOWNLOAD_TOOL_CUSTOM='' TOPDIR=/workdir/openwrt TMPDIR=/tmp MKHASH=/tmp/osi-mkhash perl scripts/download.pl /tmp/osi-openwrt-download musl-1.2.5.tar.gz a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4 musl-1.2.5.tar.gz https://sources.cdn.openwrt.org; \
	test -s /tmp/osi-openwrt-download/musl-1.2.5.tar.gz
`);
    const identity = await lstat(fixture);
    const jobId = `executor-${String(process.pid)}`;
    const digest = BASE_IMAGE.slice(BASE_IMAGE.indexOf('sha256:') + 'sha256:'.length);
    const nullJob = { sourceCommitTime: '2026-08-03T00:00:00.000Z', containerId: null, containerName: null, containerImageDigest: null, containerLabelJobId: null, containerLabelManifestSha: null, containerLabels: null, containerMount: null, containerEnvironment: null, containerSecurity: null, containerInspection: null, containerCreatedAt: null, containerStartedAt: null, containerStoppedAt: null, containerRemovedAt: null, containerCleanupOutcome: null } as const;
    let persistedJob: typeof nullJob | Record<string, unknown> = nullJob;
    let persistedEvidenceSha256: string | null = null;
    const operationOutput: string[] = [];
    const ownership = { runnerWrite: (command: RunnerWriteCommand) => {
      if (command.kind === 'container') persistedJob = { ...persistedJob, containerId: command.containerId, containerName: command.containerName, containerImageDigest: command.imageDigest, containerLabelJobId: jobId, containerLabelManifestSha: 'b'.repeat(64), containerLabels: command.labels, containerMount: command.mount, containerEnvironment: command.environment, containerSecurity: command.security, containerInspection: command.inspection, containerCreatedAt: command.createdAt, containerStartedAt: command.startedAt ?? null, containerStoppedAt: command.stoppedAt ?? null };
      if (command.kind === 'operation-complete') persistedEvidenceSha256 = command.input.evidenceSha256;
      return { ok: true, eventSeq: 1 };
    } };
    const executor = createDockerExecutor({
      dockerPath: '/usr/bin/docker', imageReference: BASE_IMAGE, imageId: image.imageId, imageDigest: digest, jobId, manifestSha256: 'b'.repeat(64), attempt: 1,
      worktreePath: fixture, dependencyEgressCredentialDirectory: credentialDirectory, workspaceIdentity: { device: identity.dev, inode: identity.ino }, activeTargetEnvironment: null,
      uid: 1000, gid: 1000, operationId: 'build-image', operationContext: { environment: 'full_raspberrypi_bcm27xx_bcm2712' }, operationTimeoutMs: 180_000, maxCaptureBytes: 64 * 1024,
      containerName: createDockerContainerName(jobId, 'build-image', 1), store: { getJob: () => persistedJob as typeof nullJob }, ownership,
      leaseSnapshot: () => ({ owner: 'runner', unit: `osi-image-builder-runner@${jobId}.service`, leaseExpiresAt: '2026-08-03T01:00:00.000Z', expectedState: 'starting' }),
      evidence: async () => ({ path: join(fixture, 'evidence.json'), sha256: image.validationEvidenceSha256 }), finalizeLogs: async ({ operationFinishedAt }) => ({ runner: 'absent', docker: 'absent', verifiedAt: operationFinishedAt }),
      authorizeContainerCreate: async () => ({ authorized: true }),
      onStdout: (chunk) => operationOutput.push(chunk),
      onStderr: (chunk) => operationOutput.push(chunk),
    });
    const result = await executor.run();
    expect(result, `${JSON.stringify(result, null, 2)}\n${operationOutput.join('')}`).toMatchObject({ available: true, outcome: 'passed' });
    expect((await docker(['ps', '--all', '--filter', `label=org.osi.image-builder.job-id=${jobId}`, '--format={{.ID}}'])).stdout.trim()).toBe('');
    expect((await docker(['ps', '--all', '--filter', `label=org.osi.image-builder.egress-job-id=${jobId}`, '--format={{.ID}}'])).stdout.trim()).toBe('');
    expect((await docker(['network', 'ls', '--filter', `label=org.osi.image-builder.egress-job-id=${jobId}`, '--format={{.ID}}'])).stdout.trim()).toBe('');
    expect(await readdir(credentialDirectory)).toEqual([]);
    expect(persistedEvidenceSha256).toBe(image.validationEvidenceSha256);
  }, 300_000);
});
