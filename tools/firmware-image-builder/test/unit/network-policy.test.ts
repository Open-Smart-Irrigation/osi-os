import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  DEPENDENCY_EGRESS_OPERATION_IDS,
  TRUSTED_OPERATION_IDS,
  isDependencyEgressOperationId,
} from '../../domain/types.js';
import { DEPENDENCY_EGRESS_OPERATION_HOSTS } from '../../builder/validate-builder.js';
import {
  DEPENDENCY_EGRESS_NETWORK_MODE,
  OFFLINE_NETWORK_MODE,
  createDependencyEgressDestinationResolver,
  operationNetworkPolicy,
} from '../../runner/src/network-policy.js';

const proxyBytes = await readFile(new URL('../../builder/operations/osi-dependency-egress-proxy.cjs', import.meta.url));
const resolveDependencyDestination = createDependencyEgressDestinationResolver(
  proxyBytes,
  createHash('sha256').update(proxyBytes).digest('hex'),
);

describe('installed Docker dependency egress policy', () => {
  it('rejects a hash mismatch before evaluating any proxy bytes', () => {
    const marker = '__osiUnvalidatedProxyEvaluated';
    delete (globalThis as Record<string, unknown>)[marker];
    const unvalidated = Buffer.from(`globalThis.${marker} = true; module.exports = {};\n`);

    expect(() => createDependencyEgressDestinationResolver(unvalidated, 'a'.repeat(64)))
      .toThrow(/hash mismatch/u);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('does not execute valid-hash proxy bytes or expose host capabilities to them', async () => {
    const markers = [
      '__osiValidatedProxyGlobal',
      '__osiValidatedProxyProcess',
      '__osiValidatedProxyConstructor',
      '__osiValidatedProxyLoader',
    ];
    for (const marker of markers) delete (globalThis as Record<string, unknown>)[marker];
    const hostile = Buffer.from(`
      globalThis.__osiValidatedProxyGlobal = true;
      globalThis.__osiValidatedProxyProcess = typeof process;
      globalThis.__osiValidatedProxyConstructor = ({}).constructor.name;
      globalThis.__osiValidatedProxyLoader = module.constructor._load('node:fs').readFileSync('/etc/hostname', 'utf8');
      module.exports = { resolveDependencyDestination() { throw new Error('hostile runtime'); } };
    `);
    const resolver = createDependencyEgressDestinationResolver(
      hostile,
      createHash('sha256').update(hostile).digest('hex'),
    );

    await expect(resolver({
      operationId: 'frontend-install',
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'registry.npmjs.org',
    }, vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]))).resolves.toMatchObject({
      host: 'registry.npmjs.org',
      address: '104.16.30.34',
    });
    for (const marker of markers) expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('gives network authority only to frontend dependency installation and image compilation', () => {
    expect(Object.keys(DEPENDENCY_EGRESS_OPERATION_HOSTS)).toEqual(DEPENDENCY_EGRESS_OPERATION_IDS);
    for (const operationId of TRUSTED_OPERATION_IDS) {
      const policy = operationNetworkPolicy(operationId);
      if (isDependencyEgressOperationId(operationId)) {
        expect(policy.kind, operationId).toBe('dependency-egress');
        expect(policy.dockerNetwork, operationId).toBe(DEPENDENCY_EGRESS_NETWORK_MODE);
        expect(policy.allowedHosts.length, operationId).toBeGreaterThan(0);
        expect(Object.isFrozen(policy.allowedHosts), operationId).toBe(true);
      } else {
        expect(policy, operationId).toEqual({
          kind: 'offline',
          dockerNetwork: OFFLINE_NETWORK_MODE,
          allowedHosts: [],
        });
      }
    }
  });

  it('uses an exact installed hostname allowlist instead of arbitrary public-host egress', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);

    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'registry.npmjs.org',
    }, lookup)).resolves.toEqual({
      host: 'registry.npmjs.org',
      address: '104.16.30.34',
      family: 4,
      port: 443,
    });

    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: 'example.com',
      port: 443,
      tlsServerName: 'example.com',
    }, lookup)).rejects.toThrow(/dependency egress denied/u);
    await expect(resolveDependencyDestination({
      operationId: 'build-image',
      host: 'osicloud.ch',
      port: 443,
      tlsServerName: 'osicloud.ch',
    }, lookup)).rejects.toThrow(/dependency egress denied/u);
  });

  it.each([
    '127.0.0.1',
    '10.42.0.7',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '0:0:0:0:0:0:7f00:1',
    '::ffff:10.42.0.7',
    '::ffff:a2a:7',
  ])('rejects non-public and mapped/compatible address %s using the runtime resolver', async (address) => {
    const lookup = vi.fn().mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'registry.npmjs.org',
    }, lookup)).rejects.toThrow(/dependency egress denied/u);
  });

  it('rejects a mixed public/private DNS answer and never resolves again after authorization', async () => {
    const rebound = vi.fn()
      .mockResolvedValueOnce([
        { address: '104.16.30.34', family: 4 },
        { address: '10.42.0.7', family: 4 },
      ])
      .mockResolvedValueOnce([{ address: '10.42.0.7', family: 4 }]);
    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'registry.npmjs.org',
    }, rebound)).rejects.toThrow(/dependency egress denied/u);
    expect(rebound).toHaveBeenCalledTimes(1);

    const stable = vi.fn()
      .mockResolvedValueOnce([{ address: '104.16.30.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.42.0.7', family: 4 }]);
    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'registry.npmjs.org',
    }, stable)).resolves.toMatchObject({ address: '104.16.30.34' });
    expect(stable).toHaveBeenCalledTimes(1);
  });

  it('requires CONNECT SNI to equal the exact allowlisted authority', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: 'registry.npmjs.org',
      port: 443,
      tlsServerName: 'osicloud.ch',
    }, lookup)).rejects.toThrow(/dependency egress denied/u);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects IP-literal authority and ports outside the installed policy', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '104.16.30.34', family: 4 }]);
    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: '104.16.30.34',
      port: 443,
      tlsServerName: '104.16.30.34',
    }, lookup)).rejects.toThrow(/dependency egress denied/u);
    await expect(resolveDependencyDestination({
      operationId: 'frontend-install',
      host: 'registry.npmjs.org',
      port: 22,
      tlsServerName: null,
    }, lookup)).rejects.toThrow(/dependency egress denied/u);
  });
});
