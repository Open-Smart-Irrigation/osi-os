import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEPENDENCY_EGRESS_CREDENTIAL_PATH,
  DEPENDENCY_EGRESS_PROXY_PATH,
  createDependencyEgressNetwork,
  dependencyProxyEnvironment,
  destroyDependencyEgressNetwork,
  destroyDependencyEgressTlsMaterial,
  parseDependencyEgressNetwork,
  type DependencyEgressNetworkInput,
} from '../../runner/src/dependency-egress-proxy.js';

const NETWORK_ID = 'a'.repeat(64);
const PROXY_ID = 'b'.repeat(64);
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const IMAGE_DIGEST = 'd'.repeat(64);
const MANIFEST_SHA = 'e'.repeat(64);
const CREDENTIAL_SHA = 'f'.repeat(64);
const IMAGE_REFERENCE = `registry.example/builder@sha256:${IMAGE_DIGEST}`;
const JOB_ID = 'job-1';
const NETWORK_NAME = expect.stringContaining('osi-image-builder-egress-');
const PROXY_NAME = expect.stringContaining('osi-image-builder-egress-proxy-');
const TLS_DIRECTORY_METADATA = { mode: 0o700, uid: 1000, gid: 1000, device: 1, inode: 2 } as const;
const tlsFileMetadata = (mode: number, hash: string, inode: number) => ({ ...TLS_DIRECTORY_METADATA, mode, inode, sha256: hash.repeat(64), bytes: 1024, links: 1 } as const);
const TLS = {
  hostDirectory: '/trusted/job-1/frontend-install-1.proxy-tls',
  directoryMetadata: TLS_DIRECTORY_METADATA,
  caCertificateHostPath: '/trusted/job-1/frontend-install-1.proxy-tls/ca.pem',
  caCertificateMetadata: tlsFileMetadata(0o444, '1', 3),
  leafCertificates: {
    'registry.npmjs.org': {
      certificateHostPath: '/trusted/job-1/frontend-install-1.proxy-tls/registry_npmjs_org.pem',
      keyHostPath: '/trusted/job-1/frontend-install-1.proxy-tls/registry_npmjs_org.key',
      certificateMetadata: tlsFileMetadata(0o444, '2', 4),
      keyMetadata: tlsFileMetadata(0o400, '3', 5),
    },
  },
} as const;
const require = createRequire(import.meta.url);
type TestPaths = Readonly<{ readonly credentialHostPath: string; readonly tlsHostDirectory: string }>;
const DEFAULT_PATHS = Object.freeze({
  credentialHostPath: '/trusted/job-1/frontend-install-1.proxy-credential',
  tlsHostDirectory: TLS.hostDirectory,
});
const runtimeProxy = require('../../builder/operations/osi-dependency-egress-proxy.cjs') as {
  readonly validateRequestAuthority: (input: Readonly<Record<string, unknown>>) => { readonly host: string; readonly port: 443 };
};

function proxyInspect(networkName: string, proxyName: string, running: boolean, bridge: boolean, paths: TestPaths = DEFAULT_PATHS) {
  return {
    Id: PROXY_ID,
    Name: `/${proxyName}`,
    Image: IMAGE_ID,
    Config: {
      Image: IMAGE_REFERENCE,
      User: '1000:1000',
      Labels: {
        'org.osi.image-builder.egress-job-id': JOB_ID,
        'org.osi.image-builder.egress-manifest-sha': MANIFEST_SHA,
        'org.osi.image-builder.egress-operation-id': 'frontend-install',
        'org.osi.image-builder.egress-attempt': '1',
        'org.osi.image-builder.egress-credential-sha': CREDENTIAL_SHA,
        'org.osi.image-builder.egress-role': 'proxy',
      },
      Env: [
        'OSI_EGRESS_ALLOWED_HOSTS_JSON=["registry.npmjs.org"]',
        `OSI_EGRESS_CREDENTIAL_PATH=${DEPENDENCY_EGRESS_CREDENTIAL_PATH}`,
        'OSI_EGRESS_BIND_ALIAS=osi-egress-proxy',
        'OSI_EGRESS_PROXY_PORT=3128',
        'OSI_EGRESS_TLS_DIRECTORY=/run/osi-image-builder/tls',
        'OSI_EGRESS_CA_CERT_PATH=/run/osi-image-builder/tls/ca.pem',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ],
      Cmd: ['node', DEPENDENCY_EGRESS_PROXY_PATH],
      Entrypoint: null,
    },
    HostConfig: {
      NetworkMode: networkName,
      CapAdd: null,
      CapDrop: ['ALL'],
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      PidsLimit: 128,
      NanoCpus: 1_000_000_000,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      Ulimits: [{ Name: 'nofile', Soft: 256, Hard: 1024 }],
    },
    Mounts: [{
      Type: 'bind',
      Source: paths.credentialHostPath,
      Destination: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
      Mode: '',
      RW: false,
      Propagation: 'rprivate',
    }, {
      Type: 'bind',
      Source: paths.tlsHostDirectory,
      Destination: '/run/osi-image-builder/tls',
      Mode: '',
      RW: false,
      Propagation: 'rprivate',
    }],
    State: { Running: running, Status: running ? 'running' : 'created' },
    NetworkSettings: {
      Networks: {
        [networkName]: {
          NetworkID: running ? NETWORK_ID : '',
          EndpointID: running ? '1'.repeat(64) : '',
          IPAddress: running ? '172.30.0.2' : '',
          GlobalIPv6Address: '',
          Aliases: ['osi-egress-proxy'],
        },
        ...(bridge ? {
          bridge: {
            NetworkID: '2'.repeat(64),
            EndpointID: '3'.repeat(64),
            IPAddress: '172.17.0.4',
            GlobalIPv6Address: '',
            Aliases: null,
          },
        } : {}),
      },
    },
  };
}

function dockerHarness(overrides: {
  readonly internal?: boolean;
  readonly authenticated?: boolean;
  readonly publishProxyPort?: boolean;
  readonly rogueGlobal?: boolean;
  readonly proxyNanoCpus?: number;
  readonly proxyMemory?: number;
  readonly proxyMemorySwap?: number;
  readonly credentialHostPath?: string;
  readonly tlsHostDirectory?: string;
} = {}) {
  let networkName = '';
  let proxyName = '';
  let started = false;
  let bridge = false;
  let proxyRemoved = false;
  let networkRemoved = false;
  const run = vi.fn(async (argv: readonly string[]) => {
    if (argv[1] === 'network' && argv[2] === 'create') {
      networkName = argv.at(-1)!;
      return { exitCode: 0, stdout: `${NETWORK_ID}\n`, stderr: '' };
    }
    if (argv[1] === 'network' && argv[2] === 'inspect') {
      if (networkRemoved) return { exitCode: 1, stdout: '', stderr: `Error response from daemon: network ${NETWORK_ID} not found` };
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          Id: NETWORK_ID,
          Name: networkName,
          Internal: overrides.internal ?? true,
          Labels: {
            'org.osi.image-builder.egress-job-id': JOB_ID,
            'org.osi.image-builder.egress-manifest-sha': MANIFEST_SHA,
            'org.osi.image-builder.egress-operation-id': 'frontend-install',
            'org.osi.image-builder.egress-attempt': '1',
            'org.osi.image-builder.egress-credential-sha': CREDENTIAL_SHA,
            'org.osi.image-builder.egress-role': 'network',
          },
          Containers: started ? {
            [PROXY_ID]: { Name: proxyName, EndpointID: '1'.repeat(64), IPv4Address: '172.30.0.2/16', IPv6Address: '' },
          } : {},
        })}\n`,
        stderr: '',
      };
    }
    if (argv[1] === 'create') {
      proxyName = argv.find((value) => value.startsWith('--name='))!.slice('--name='.length);
      return { exitCode: 0, stdout: `${PROXY_ID}\n`, stderr: '' };
    }
    if (argv[1] === 'inspect' && argv.includes('--type=container')) {
      if (proxyRemoved) return { exitCode: 1, stdout: '', stderr: `Error response from daemon: No such container: ${PROXY_ID}` };
      const value = proxyInspect(networkName, proxyName, started, bridge, {
        credentialHostPath: overrides.credentialHostPath ?? DEFAULT_PATHS.credentialHostPath,
        tlsHostDirectory: overrides.tlsHostDirectory ?? DEFAULT_PATHS.tlsHostDirectory,
      });
      const config = value.Config as Record<string, unknown>;
      const hostConfig = value.HostConfig as Record<string, unknown>;
      const networkSettings = value.NetworkSettings as Record<string, unknown>;
      config.ExposedPorts = overrides.publishProxyPort ? { '3128/tcp': {} } : null;
      hostConfig.PortBindings = overrides.publishProxyPort ? { '3128/tcp': [{ HostIp: '0.0.0.0', HostPort: '3128' }] } : {};
      hostConfig.PublishAllPorts = false;
      hostConfig.NanoCpus = overrides.proxyNanoCpus ?? 1_000_000_000;
      hostConfig.Memory = overrides.proxyMemory ?? 256 * 1024 * 1024;
      hostConfig.MemorySwap = overrides.proxyMemorySwap ?? 256 * 1024 * 1024;
      networkSettings.Ports = overrides.publishProxyPort ? { '3128/tcp': [{ HostIp: '0.0.0.0', HostPort: '3128' }] } : {};
      return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
    }
    if (argv[1] === 'start') {
      started = true;
      return { exitCode: 0, stdout: `${PROXY_ID}\n`, stderr: '' };
    }
    if (argv[1] === 'exec') {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ authenticated: overrides.authenticated ?? true, unauthenticatedStatus: 407, authenticatedStatus: 204, bridgeEndpointDenied: bridge })}\n`,
        stderr: '',
      };
    }
    if (argv[1] === 'network' && argv[2] === 'connect') {
      bridge = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (argv[1] === 'rm') {
      proxyRemoved = true;
      started = false;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (argv[1] === 'network' && argv[2] === 'rm') {
      networkRemoved = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (argv[1] === 'ps' && argv.includes(`--filter=label=org.osi.image-builder.egress-job-id=${JOB_ID}`)) {
      return { exitCode: 0, stdout: overrides.rogueGlobal ? `${'9'.repeat(64)}\n` : '', stderr: '' };
    }
    if (argv[1] === 'network' && argv[2] === 'ls' && argv.includes(`--filter=label=org.osi.image-builder.egress-job-id=${JOB_ID}`)) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected Docker command: ${argv.join(' ')}` };
  });
  return run;
}

function input(run: ReturnType<typeof dockerHarness>, paths: TestPaths = DEFAULT_PATHS): DependencyEgressNetworkInput {
  return {
    dockerPath: '/usr/bin/docker',
    imageReference: IMAGE_REFERENCE,
    imageId: IMAGE_ID,
    imageDigest: IMAGE_DIGEST,
    jobId: JOB_ID,
    operationId: 'frontend-install' as const,
    attempt: 1,
    uid: 1000,
    gid: 1000,
    manifestSha256: MANIFEST_SHA,
    credential: {
      hostPath: paths.credentialHostPath,
      containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
      sha256: CREDENTIAL_SHA,
    },
    tls: {
      ...TLS,
      hostDirectory: paths.tlsHostDirectory,
      caCertificateHostPath: `${paths.tlsHostDirectory}/ca.pem`,
      leafCertificates: {
        'registry.npmjs.org': {
          ...TLS.leafCertificates['registry.npmjs.org'],
          certificateHostPath: `${paths.tlsHostDirectory}/registry_npmjs_org.pem`,
          keyHostPath: `${paths.tlsHostDirectory}/registry_npmjs_org.key`,
        },
      },
    },
    run,
  };
}

describe('dependency egress Docker boundary', () => {
  it('requires exact HTTP/1.1 Host authority and rejects redirects to another authority', () => {
    expect(runtimeProxy.validateRequestAuthority({ protocol: 'http/1.1', host: 'registry.npmjs.org', expectedHost: 'registry.npmjs.org' })).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(runtimeProxy.validateRequestAuthority({ protocol: 'http/1.1', host: 'registry.npmjs.org:443', expectedHost: 'registry.npmjs.org' })).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(() => runtimeProxy.validateRequestAuthority({ protocol: 'http/1.1', host: 'registry.npmjs.org, evil.example', expectedHost: 'registry.npmjs.org' })).toThrow(/authority|host/u);
    expect(() => runtimeProxy.validateRequestAuthority({ protocol: 'http/1.1', host: 'evil.example', expectedHost: 'registry.npmjs.org' })).toThrow(/authority|host/u);
  });

  it('requires exact HTTP/2 :authority and rejects unknown protocol markers', () => {
    expect(runtimeProxy.validateRequestAuthority({ protocol: 'h2', authority: 'registry.npmjs.org', expectedHost: 'registry.npmjs.org' })).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(() => runtimeProxy.validateRequestAuthority({ protocol: 'h2', authority: 'registry.npmjs.org:8443', expectedHost: 'registry.npmjs.org' })).toThrow(/authority|port/u);
    expect(() => runtimeProxy.validateRequestAuthority({ protocol: 'spdy/3.1', authority: 'registry.npmjs.org', expectedHost: 'registry.npmjs.org' })).toThrow(/protocol/u);
  });

  it('creates and attests an authenticated internal-only proxy before branch execution', async () => {
    const run = dockerHarness();
    const resources = await createDependencyEgressNetwork(input(run));

    expect(resources.network).toMatchObject({ id: NETWORK_ID, name: NETWORK_NAME, internal: true });
    expect(resources.proxy).toMatchObject({ id: PROXY_ID, name: PROXY_NAME, imageId: IMAGE_ID, imageDigest: IMAGE_DIGEST });
    expect(resources.credential).toEqual({ hostPath: '/trusted/job-1/frontend-install-1.proxy-credential', containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH, sha256: CREDENTIAL_SHA });
    expect(resources.readiness).toEqual({ authenticated: true, unauthenticatedStatus: 407, authenticatedStatus: 204, bridgeEndpointDenied: true });

    const create = run.mock.calls.find(([argv]) => argv[1] === 'create')?.[0] as readonly string[];
    expect(create.some((value) => /^--network=osi-image-builder-egress-/u.test(value))).toBe(true);
    expect(create).not.toContain('--network=bridge');
    expect(create).toContain('--read-only');
    expect(create).toContain('--cpus=1');
    expect(create).toContain('--memory=256m');
    expect(create).toContain('--memory-swap=256m');
    expect(create).toContain(`--mount=type=bind,source=/trusted/job-1/frontend-install-1.proxy-credential,destination=${DEPENDENCY_EGRESS_CREDENTIAL_PATH},readonly`);
    expect(create).toContain(DEPENDENCY_EGRESS_PROXY_PATH);
    expect(create.join('\u0000')).not.toContain('Proxy-Authorization');
    expect(create.join('\u0000')).not.toContain('Basic ');
    expect(dependencyProxyEnvironment(resources)).toEqual({
      HTTP_PROXY: 'http://osi-egress-proxy:3128',
      HTTPS_PROXY: 'http://osi-egress-proxy:3128',
      ALL_PROXY: 'http://osi-egress-proxy:3128',
      NO_PROXY: '',
      http_proxy: 'http://osi-egress-proxy:3128',
      https_proxy: 'http://osi-egress-proxy:3128',
      all_proxy: 'http://osi-egress-proxy:3128',
      no_proxy: '',
      OSI_EGRESS_PROXY_CREDENTIAL_FILE: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
      OSI_EGRESS_CA_CERT_FILE: '/run/osi-image-builder/ca.pem',
    });
  });

  it('fails closed and removes created resources when the network is not Internal', async () => {
    const run = dockerHarness({ internal: false });
    await expect(createDependencyEgressNetwork(input(run))).rejects.toThrow(/internal|network/u);
    expect(run.mock.calls.some(([argv]) => argv[1] === 'network' && argv[2] === 'rm')).toBe(true);
    expect(run.mock.calls.some(([argv]) => argv[1] === 'start')).toBe(false);
  });

  it('fails closed and cleans up when authenticated readiness or bridge refusal is not proven', async () => {
    const run = dockerHarness({ authenticated: false });
    await expect(createDependencyEgressNetwork(input(run))).rejects.toThrow(/readiness|authentication/u);
    expect(run.mock.calls.some(([argv]) => argv[1] === 'rm' && argv.includes('--force'))).toBe(true);
    expect(run.mock.calls.some(([argv]) => argv[1] === 'network' && argv[2] === 'rm')).toBe(true);
  });

  it('fails closed before start when the proxy has any published endpoint', async () => {
    const run = dockerHarness({ publishProxyPort: true });
    await expect(createDependencyEgressNetwork(input(run))).rejects.toThrow(/port|endpoint|security/u);
    expect(run.mock.calls.some(([argv]) => argv[1] === 'start')).toBe(false);
    expect(run.mock.calls.some(([argv]) => argv[1] === 'rm' && argv.includes('--force'))).toBe(true);
  });

  it.each([
    ['CPU', { proxyNanoCpus: 2_000_000_000 }],
    ['memory', { proxyMemory: 512 * 1024 * 1024 }],
    ['swap', { proxyMemorySwap: 512 * 1024 * 1024 }],
  ] as const)('fails closed before start when the proxy %s limit changed', async (_name, overrides) => {
    const run = dockerHarness(overrides);
    await expect(createDependencyEgressNetwork(input(run))).rejects.toThrow(/resource|security|limit/iu);
    expect(run.mock.calls.some(([argv]) => argv[1] === 'start')).toBe(false);
  });

  it('re-inspects exact persisted identities and attests normal cleanup absence', async () => {
    const run = dockerHarness();
    const resources = await createDependencyEgressNetwork(input(run));
    const callsBeforeCleanup = run.mock.calls.length;
    await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run }, resources)).resolves.toEqual({
      proxy: { id: PROXY_ID, absent: true },
      network: { id: NETWORK_ID, absent: true },
      tls: { hostDirectory: resources.tls.hostDirectory, absent: true },
      globalLabelResult: 'no-match',
    });
    const cleanupCalls = run.mock.calls.slice(callsBeforeCleanup).map(([argv]) => argv as readonly string[]);
    expect(cleanupCalls[0]).toEqual(['/usr/bin/docker', 'inspect', '--type=container', '--format={{json .}}', PROXY_ID]);
    expect(cleanupCalls.some((argv) => argv[1] === 'rm' && argv.includes(PROXY_ID))).toBe(true);
    expect(cleanupCalls.some((argv) => argv[1] === 'network' && argv[2] === 'rm' && argv.includes(NETWORK_ID))).toBe(true);
  });

  it('does not remove Docker or TLS when persisted credential validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-invalid-credential-'));
    const credentialHostPath = join(root, 'frontend-install-1.proxy-credential');
    const tlsHostDirectory = join(root, 'frontend-install-1.proxy-tls');
    await mkdir(tlsHostDirectory, { mode: 0o700 });
    await writeFile(credentialHostPath, 'a'.repeat(48), { mode: 0o400 });
    const paths = { credentialHostPath, tlsHostDirectory } as const;
    const run = dockerHarness(paths);
    const resources = await createDependencyEgressNetwork(input(run, paths));
    const persisted = {
      ...resources,
      credential: { ...resources.credential, sha256: '0'.repeat(64) },
    };
    try {
      await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run }, persisted)).rejects.toThrow(/hash|credential/iu);
      await expect(lstat(tlsHostDirectory)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      expect(run.mock.calls.some(([argv]) => argv[1] === 'rm' || argv[1] === 'network' && argv[2] === 'rm')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not remove Docker or TLS when the credential is absent but TLS remains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-missing-credential-'));
    const paths = {
      credentialHostPath: join(root, 'frontend-install-1.proxy-credential'),
      tlsHostDirectory: join(root, 'frontend-install-1.proxy-tls'),
    } as const;
    await mkdir(paths.tlsHostDirectory, { mode: 0o700 });
    const run = dockerHarness(paths);
    try {
      const resources = await createDependencyEgressNetwork(input(run, paths));

      await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run }, resources)).rejects.toThrow(/credential|TLS/iu);
      await expect(lstat(paths.tlsHostDirectory)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      expect(run.mock.calls.some(([argv]) => argv[1] === 'rm' || argv[1] === 'network' && argv[2] === 'rm')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails normal cleanup when a global job-label query finds another egress resource', async () => {
    const run = dockerHarness({ rogueGlobal: true });
    const resources = await createDependencyEgressNetwork(input(run));
    await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run }, resources))
      .rejects.toThrow(/global|label|absence/iu);
  });

  it('resumes exact persisted cleanup after a crash removed only the proxy', async () => {
    const run = dockerHarness();
    const resources = await createDependencyEgressNetwork(input(run));
    await run(['/usr/bin/docker', 'rm', '--force', PROXY_ID]);

    await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run }, resources)).resolves.toEqual({
      proxy: { id: PROXY_ID, absent: true },
      network: { id: NETWORK_ID, absent: true },
      tls: { hostDirectory: resources.tls.hostDirectory, absent: true },
      globalLabelResult: 'no-match',
    });
    expect(run.mock.calls.some(([argv]) => argv[1] === 'network' && argv[2] === 'rm' && argv.includes(NETWORK_ID))).toBe(true);
  });

  it('accepts a replay only after both exact persisted Docker identities are absent', async () => {
    const run = dockerHarness();
    const resources = await createDependencyEgressNetwork(input(run));
    await run(['/usr/bin/docker', 'rm', '--force', PROXY_ID]);
    await run(['/usr/bin/docker', 'network', 'rm', NETWORK_ID]);

    await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run }, resources)).resolves.toEqual({
      proxy: { id: PROXY_ID, absent: true },
      network: { id: NETWORK_ID, absent: true },
      tls: { hostDirectory: resources.tls.hostDirectory, absent: true },
      globalLabelResult: 'no-match',
    });
  });

  it('removes and attests the canonical TLS directory when Docker resources are both already absent', async () => {
    const run = dockerHarness();
    const resources = await createDependencyEgressNetwork(input(run));
    const root = await mkdtemp(join(tmpdir(), 'osi-egress-tls-'));
    const hostDirectory = join(root, 'frontend-install-1.proxy-tls');
    await mkdir(hostDirectory);
    const replayResources = {
      ...resources,
      tls: { ...resources.tls, hostDirectory },
    };
    try {
      await run(['/usr/bin/docker', 'rm', '--force', PROXY_ID]);
      await run(['/usr/bin/docker', 'network', 'rm', NETWORK_ID]);

      await expect(destroyDependencyEgressNetwork({ dockerPath: '/usr/bin/docker', run }, replayResources)).resolves.toMatchObject({
        proxy: { id: PROXY_ID, absent: true },
        network: { id: NETWORK_ID, absent: true },
        tls: { hostDirectory, absent: true },
        globalLabelResult: 'no-match',
      });
      await expect(lstat(hostDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when TLS removal cannot attest nonexistence', async () => {
    const destroy = destroyDependencyEgressTlsMaterial as unknown as (
      material: { readonly hostDirectory: string },
      fileSystem: {
        readonly rm: (path: string, options: { readonly recursive: true; readonly force: true }) => Promise<void>;
        readonly lstat: (path: string) => Promise<unknown>;
      },
    ) => Promise<unknown>;
    await expect(destroy(
      { hostDirectory: '/trusted/job-1/frontend-install-1.proxy-tls' },
      {
        rm: async () => undefined,
        lstat: async () => ({ isDirectory: () => true }),
      },
    )).rejects.toThrow(/absence|nonexistence|removal|TLS/iu);
  });

  it.each([
    ['unrelated TLS directory', (value: Record<string, any>) => { value.tls.hostDirectory = '/var/lib/unrelated/foreign.proxy-tls'; }],
    ['wrong CA path', (value: Record<string, any>) => { value.tls.caCertificateHostPath = `${value.tls.hostDirectory}/foreign-ca.pem`; }],
    ['wrong leaf path', (value: Record<string, any>) => { value.tls.leafCertificates['registry.npmjs.org'].certificateHostPath = `${value.tls.hostDirectory}/evil.pem`; }],
    ['evil leaf key', (value: Record<string, any>) => { value.tls.leafCertificates['evil.example'] = value.tls.leafCertificates['registry.npmjs.org']; }],
    ['missing policy leaf', (value: Record<string, any>) => { delete value.tls.leafCertificates['registry.npmjs.org']; }],
  ] as const)('rejects noncanonical persisted TLS identity: %s', async (_label, mutate) => {
    const run = dockerHarness();
    const resources = await createDependencyEgressNetwork(input(run));
    const persisted = JSON.parse(JSON.stringify(resources)) as Record<string, any>;
    mutate(persisted);

    expect(() => parseDependencyEgressNetwork(persisted)).toThrow(/TLS|leaf|CA|path|identity/iu);
  });
});
