import { lstat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import type { JsonObject } from '../../api/src/store.js';
import { isDependencyEgressOperationId, type DependencyEgressOperationId, type TrustedOperationId } from '../../domain/types.js';
import { operationNetworkPolicy } from './network-policy.js';
import {
  DEPENDENCY_EGRESS_CA_CERT_PATH,
  DEPENDENCY_EGRESS_CREDENTIAL_PATH,
  DEPENDENCY_EGRESS_PROXY_ALIAS,
  DEPENDENCY_EGRESS_PROXY_PATH,
  DEPENDENCY_EGRESS_PROXY_PORT,
  DEPENDENCY_EGRESS_TLS_DIRECTORY,
  EGRESS_ATTEMPT_LABEL,
  EGRESS_CREDENTIAL_SHA_LABEL,
  EGRESS_JOB_LABEL,
  EGRESS_MANIFEST_LABEL,
  EGRESS_OPERATION_LABEL,
  EGRESS_ROLE_LABEL,
  ID,
  IMAGE_ID,
  IMAGE_PATH,
  PROXY_MEMORY_BYTES,
  PROXY_NANO_CPUS,
  exactLabels,
  dependencyEgressNames,
  parseDependencyEgressNetwork,
  type DockerResult,
  type DependencyCredentialIdentity,
  type DependencyEgressNetwork,
  type DependencyEgressNetworkInput,
  type DependencyEgressNetworkIdentity,
  type DependencyEgressProxyIdentity,
  type DependencyEgressReadiness,
  type DependencyEgressTlsDirectoryMetadata,
  type DependencyEgressTlsFileMetadata,
  type DependencyEgressTlsCleanupProof,
  type DependencyEgressTlsMaterial,
  type DependencyEgressDockerAbsenceProof,
} from '../../domain/dependency-egress-identity.js';
import { createDependencyEgressTlsMaterial, destroyDependencyEgressTlsMaterial, inspectDependencyEgressTlsMaterial, verifyDependencyEgressTlsMaterial } from './dependency-egress-tls.js';
import { verifyDependencyEgressCredential } from './dependency-egress-credential.js';
export { destroyDependencyEgressTlsMaterial } from './dependency-egress-tls.js';
export {
  DEPENDENCY_EGRESS_CA_CERT_PATH,
  DEPENDENCY_EGRESS_CREDENTIAL_PATH,
  DEPENDENCY_EGRESS_PROXY_ALIAS,
  DEPENDENCY_EGRESS_PROXY_PATH,
  DEPENDENCY_EGRESS_PROXY_PORT,
  DEPENDENCY_EGRESS_TLS_DIRECTORY,
  dependencyEgressNames,
  parseDependencyEgressNetwork,
} from '../../domain/dependency-egress-identity.js';
export type {
  DependencyCredentialIdentity,
  DependencyEgressNetwork,
  DependencyEgressNetworkInput,
  DependencyEgressNetworkIdentity,
  DependencyEgressProxyIdentity,
  DependencyEgressReadiness,
  DependencyEgressTlsDirectoryMetadata,
  DependencyEgressTlsFileMetadata,
  DependencyEgressTlsMaterial,
} from '../../domain/dependency-egress-identity.js';

interface DockerNetworkEndpoint {
  readonly networkId: string;
  readonly endpointId: string;
  readonly address: string;
  readonly aliases: readonly string[];
}

function derivedTlsDirectory(credentialHostPath: string): string {
  if (!credentialHostPath.endsWith('.proxy-credential')) throw new Error('dependency egress credential path is not canonical');
  return credentialHostPath.slice(0, -'.proxy-credential'.length) + '.proxy-tls';
}

function requireSuccess(result: DockerResult, action: string): string {
  if (result.exitCode !== 0) throw new Error(`${action} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function parseJson(stdout: string, action: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()) as unknown; }
  catch (error) { throw new Error(`${action} returned invalid JSON`, { cause: error }); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${action} returned an invalid object`);
  return parsed as Record<string, unknown>;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${field} is invalid`);
  return value as string[];
}

function exactRecord(actual: unknown, expected: Readonly<Record<string, unknown>>, field: string): void {
  const value = record(actual, field);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(expected).sort()) || keys.some((key) => JSON.stringify(value[key]) !== JSON.stringify(expected[key]))) throw new Error(`${field} does not match the installed policy`);
}

function emptyRecordOrNull(value: unknown, field: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) throw new Error(`${field} must be empty`);
}

function environmentRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  const values = strings(value, field);
  const result: Record<string, string> = {};
  for (const item of values) {
    const separator = item.indexOf('=');
    if (separator < 1) throw new Error(`${field} contains an invalid entry`);
    const key = item.slice(0, separator);
    if (Object.hasOwn(result, key)) throw new Error(`${field} contains a duplicate key`);
    result[key] = item.slice(separator + 1);
  }
  return result;
}

function expectedEnvironmentRecord(allowedHosts: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(environment(allowedHosts).map((item) => {
    const separator = item.indexOf('=');
    return [item.slice(0, separator), item.slice(separator + 1)];
  }));
}

function labels(input: Pick<DependencyEgressNetworkInput, 'jobId' | 'manifestSha256' | 'operationId' | 'attempt' | 'credential'>, role: 'network' | 'proxy'): JsonObject {
  return {
    [EGRESS_JOB_LABEL]: input.jobId,
    [EGRESS_MANIFEST_LABEL]: input.manifestSha256,
    [EGRESS_OPERATION_LABEL]: input.operationId,
    [EGRESS_ATTEMPT_LABEL]: String(input.attempt),
    [EGRESS_CREDENTIAL_SHA_LABEL]: input.credential.sha256,
    [EGRESS_ROLE_LABEL]: role,
  };
}

function environment(allowedHosts: readonly string[]): readonly string[] {
  return [
    `OSI_EGRESS_ALLOWED_HOSTS_JSON=${JSON.stringify(allowedHosts)}`,
    `OSI_EGRESS_CREDENTIAL_PATH=${DEPENDENCY_EGRESS_CREDENTIAL_PATH}`,
    `OSI_EGRESS_BIND_ALIAS=${DEPENDENCY_EGRESS_PROXY_ALIAS}`,
    `OSI_EGRESS_PROXY_PORT=${String(DEPENDENCY_EGRESS_PROXY_PORT)}`,
    `OSI_EGRESS_TLS_DIRECTORY=${DEPENDENCY_EGRESS_TLS_DIRECTORY}`,
    `OSI_EGRESS_CA_CERT_PATH=${DEPENDENCY_EGRESS_TLS_DIRECTORY}/ca.pem`,
    `PATH=${IMAGE_PATH}`,
  ];
}

function address(value: unknown, field: string): string {
  if (typeof value !== 'string' || isIP(value) === 0) throw new Error(`${field} is invalid`);
  return value;
}

function endpoint(value: unknown, field: string): DockerNetworkEndpoint {
  const item = record(value, field);
  if (typeof item.NetworkID !== 'string' || !ID.test(item.NetworkID) || typeof item.EndpointID !== 'string' || !ID.test(item.EndpointID)) throw new Error(`${field} identity is invalid`);
  const ipv4 = typeof item.IPAddress === 'string' && item.IPAddress.length > 0 ? item.IPAddress : null;
  const ipv6 = typeof item.GlobalIPv6Address === 'string' && item.GlobalIPv6Address.length > 0 ? item.GlobalIPv6Address : null;
  if ((ipv4 === null) === (ipv6 === null)) throw new Error(`${field} must have exactly one address`);
  const aliases = item.Aliases === null ? [] : strings(item.Aliases, `${field} aliases`);
  return { networkId: item.NetworkID, endpointId: item.EndpointID, address: address(ipv4 ?? ipv6, `${field} address`), aliases };
}

function inspectNetwork(
  value: Record<string, unknown>,
  expected: Readonly<{ id: string; name: string; labels: JsonObject; proxy?: Readonly<{ id: string; name: string; endpointId: string; address: string }> }>,
): void {
  if (value.Id !== expected.id || value.Name !== expected.name || value.Internal !== true) throw new Error('Docker egress network is not the exact Internal network');
  exactRecord(value.Labels, expected.labels, 'Docker egress network labels');
  const containers = record(value.Containers, 'Docker egress network containers');
  if (expected.proxy === undefined) {
    if (Object.keys(containers).length !== 0) throw new Error('Docker egress network has unexpected endpoints');
    return;
  }
  if (JSON.stringify(Object.keys(containers)) !== JSON.stringify([expected.proxy.id])) throw new Error('Docker egress network endpoint set is not exact');
  const proxy = record(containers[expected.proxy.id], 'Docker egress network proxy endpoint');
  if (proxy.Name !== expected.proxy.name || proxy.EndpointID !== expected.proxy.endpointId) throw new Error('Docker egress network proxy endpoint identity changed');
  const endpointAddress = String(proxy.IPv4Address || proxy.IPv6Address || '').split('/')[0];
  if (endpointAddress !== expected.proxy.address) throw new Error('Docker egress network proxy address changed');
}

function inspectProxy(
  value: Record<string, unknown>,
  input: DependencyEgressNetworkInput,
  expected: Readonly<{ id: string; name: string; networkId: string; networkName: string; running: boolean; bridge: boolean; allowedHosts: readonly string[]; status?: 'created' | 'running' | 'exited' }>,
): Readonly<{ internal: DockerNetworkEndpoint; bridge: DockerNetworkEndpoint | null }> {
  if (value.Id !== expected.id || value.Name !== `/${expected.name}` || value.Image !== input.imageId) throw new Error('Docker egress proxy identity or image ID changed');
  const config = record(value.Config, 'Docker egress proxy config');
  if (config.Image !== input.imageReference || config.User !== `${input.uid}:${input.gid}` || config.Entrypoint !== null) throw new Error('Docker egress proxy image or user changed');
  exactRecord(config.Labels, labels(input, 'proxy'), 'Docker egress proxy labels');
  exactRecord(environmentRecord(config.Env, 'Docker egress proxy environment'), expectedEnvironmentRecord(expected.allowedHosts), 'Docker egress proxy environment');
  if (JSON.stringify(config.Cmd) !== JSON.stringify(['node', DEPENDENCY_EGRESS_PROXY_PATH])) throw new Error('Docker egress proxy command changed');
  emptyRecordOrNull(config.ExposedPorts, 'Docker egress proxy exposed ports');

  const host = record(value.HostConfig, 'Docker egress proxy HostConfig');
  const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits : [];
  const nofile = ulimits.length === 1 ? record(ulimits[0], 'Docker egress proxy nofile ulimit') : {};
  if (
    host.NetworkMode !== expected.networkName
    || JSON.stringify(host.CapAdd) !== JSON.stringify(null)
    || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL'])
    || host.Privileged !== false
    || host.PublishAllPorts !== false
    || JSON.stringify(host.SecurityOpt) !== JSON.stringify(['no-new-privileges:true'])
    || host.ReadonlyRootfs !== true
    || host.PidsLimit !== 128
    || host.NanoCpus !== PROXY_NANO_CPUS
    || host.Memory !== PROXY_MEMORY_BYTES
    || host.MemorySwap !== PROXY_MEMORY_BYTES
    || nofile.Name !== 'nofile' || nofile.Soft !== 256 || nofile.Hard !== 1024
  ) throw new Error('Docker egress proxy resource or security limits changed');
  emptyRecordOrNull(host.PortBindings, 'Docker egress proxy port bindings');

  const mounts = value.Mounts;
  if (!Array.isArray(mounts) || mounts.length !== 2) throw new Error('Docker egress proxy TLS mounts are not exact');
  exactRecord(mounts.find((mount) => record(mount, 'Docker egress proxy mount').Destination === DEPENDENCY_EGRESS_CREDENTIAL_PATH), {
    Type: 'bind',
    Source: input.credential.hostPath,
    Destination: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
    Mode: '',
    RW: false,
    Propagation: 'rprivate',
  }, 'Docker egress proxy credential mount');
  if (input.tls === undefined) throw new Error('Docker egress proxy TLS identity is absent');
  exactRecord(mounts.find((mount) => record(mount, 'Docker egress proxy mount').Destination === DEPENDENCY_EGRESS_TLS_DIRECTORY), {
    Type: 'bind', Source: input.tls.hostDirectory, Destination: DEPENDENCY_EGRESS_TLS_DIRECTORY, Mode: '', RW: false, Propagation: 'rprivate',
  }, 'Docker egress proxy TLS mount');

  const state = record(value.State, 'Docker egress proxy state');
  const expectedStatus = expected.status ?? (expected.running ? 'running' : 'created');
  if (state.Running !== expected.running || state.Status !== expectedStatus) throw new Error('Docker egress proxy lifecycle state is invalid');
  const networkSettings = record(value.NetworkSettings, 'Docker egress proxy network settings');
  emptyRecordOrNull(networkSettings.Ports, 'Docker egress proxy runtime ports');
  const networks = record(networkSettings.Networks, 'Docker egress proxy networks');
  const expectedNames = expected.bridge ? [expected.networkName, 'bridge'] : [expected.networkName];
  if (JSON.stringify(Object.keys(networks).sort()) !== JSON.stringify(expectedNames.sort())) throw new Error('Docker egress proxy network attachment set is not exact');
  if (expectedStatus === 'created') {
    const pending = record(networks[expected.networkName], 'Docker egress proxy pending internal endpoint');
    const aliases = pending.Aliases === null ? [] : strings(pending.Aliases, 'Docker egress proxy pending internal aliases');
    if (pending.NetworkID !== '' || pending.EndpointID !== '' || pending.IPAddress !== '' || pending.GlobalIPv6Address !== '' || JSON.stringify(aliases) !== JSON.stringify([DEPENDENCY_EGRESS_PROXY_ALIAS])) throw new Error('Docker egress proxy pending internal attachment changed');
    return { internal: { networkId: expected.networkId, endpointId: '', address: '', aliases }, bridge: null };
  }
  const internal = endpoint(networks[expected.networkName], 'Docker egress proxy internal endpoint');
  if (internal.networkId !== expected.networkId || JSON.stringify(internal.aliases) !== JSON.stringify([DEPENDENCY_EGRESS_PROXY_ALIAS])) throw new Error('Docker egress proxy internal endpoint changed');
  return { internal, bridge: expected.bridge ? endpoint(networks.bridge, 'Docker egress proxy bridge endpoint') : null };
}

function readiness(stdout: string, requireBridgeDenial: boolean): DependencyEgressReadiness {
  const value = parseJson(stdout, 'Docker egress proxy readiness');
  if (
    value.authenticated !== true
    || value.unauthenticatedStatus !== 407
    || value.authenticatedStatus !== 204
    || value.bridgeEndpointDenied !== requireBridgeDenial
  ) throw new Error('Docker egress proxy authenticated readiness was not proven');
  return { authenticated: true, unauthenticatedStatus: 407, authenticatedStatus: 204, bridgeEndpointDenied: true };
}

async function awaitReadiness(
  input: DependencyEgressNetworkInput,
  proxyId: string,
  internalAddress: string,
  bridgeAddress: string,
  requireBridgeDenial: boolean,
): Promise<DependencyEgressReadiness> {
  let last: DockerResult | null = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    last = await input.run([input.dockerPath, 'exec', proxyId, 'node', DEPENDENCY_EGRESS_PROXY_PATH, '--readiness', internalAddress, bridgeAddress]);
    if (last.exitCode === 0) return readiness(last.stdout, requireBridgeDenial);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Docker egress proxy readiness failed: ${last?.stderr || last?.stdout || 'no evidence'}`);
}

async function inspectContainer(input: DependencyEgressNetworkInput, id: string): Promise<Record<string, unknown>> {
  return parseJson(requireSuccess(await input.run([input.dockerPath, 'inspect', '--type=container', '--format={{json .}}', id]), 'Docker egress proxy inspect'), 'Docker egress proxy inspect');
}

async function inspectDockerNetwork(input: DependencyEgressNetworkInput, id: string): Promise<Record<string, unknown>> {
  return parseJson(requireSuccess(await input.run([input.dockerPath, 'network', 'inspect', '--format={{json .}}', id]), 'Docker egress network inspect'), 'Docker egress network inspect');
}

async function proveContainerAbsent(input: Pick<DependencyEgressNetworkInput, 'dockerPath' | 'run'>, id: string): Promise<void> {
  const result = await input.run([input.dockerPath, 'inspect', '--type=container', '--format={{json .}}', id]);
  if (result.exitCode === 0 || !/no such container/iu.test(`${result.stdout}\n${result.stderr}`)) throw new Error('Docker egress proxy absence was not proven');
}

async function proveNetworkAbsent(input: Pick<DependencyEgressNetworkInput, 'dockerPath' | 'run'>, id: string): Promise<void> {
  const result = await input.run([input.dockerPath, 'network', 'inspect', '--format={{json .}}', id]);
  if (result.exitCode === 0 || !/(?:not found|no such network)/iu.test(`${result.stdout}\n${result.stderr}`)) throw new Error('Docker egress network absence was not proven');
}

async function cleanupCreated(
  input: Pick<DependencyEgressNetworkInput, 'dockerPath' | 'run'>,
  created: Readonly<{ proxyId: string | null; networkId: string | null }>,
): Promise<void> {
  const failures: unknown[] = [];
  if (created.proxyId !== null) {
    try {
      requireSuccess(await input.run([input.dockerPath, 'rm', '--force', created.proxyId]), 'Docker egress proxy cleanup');
      await proveContainerAbsent(input, created.proxyId);
    } catch (error) { failures.push(error); }
  }
  if (created.networkId !== null) {
    try {
      requireSuccess(await input.run([input.dockerPath, 'network', 'rm', created.networkId]), 'Docker egress network cleanup');
      await proveNetworkAbsent(input, created.networkId);
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Docker egress resource cleanup could not be attested');
}

async function verifyCredentialBeforeDestruction(
  credential: DependencyCredentialIdentity,
): Promise<boolean> {
  try {
    await verifyDependencyEgressCredential(credential);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

async function rejectLiveTlsForMissingCredential(credentialPresent: boolean, tlsHostDirectory: string): Promise<void> {
  if (credentialPresent) return;
  try {
    const metadata = await lstat(tlsHostDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('dependency egress TLS material is unsafe while the credential is absent');
    throw new Error('dependency egress TLS material remains while the credential is absent');
  } catch (tlsError) {
    if ((tlsError as NodeJS.ErrnoException).code !== 'ENOENT') throw tlsError;
  }
}

export function dependencyProxyEnvironment(resources: DependencyEgressNetwork): Readonly<Record<string, string>> {
  const proxy = `http://${DEPENDENCY_EGRESS_PROXY_ALIAS}:${DEPENDENCY_EGRESS_PROXY_PORT}`;
  if (resources.credential.containerPath !== DEPENDENCY_EGRESS_CREDENTIAL_PATH) throw new Error('dependency egress credential path changed');
  return Object.freeze({
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: '',
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    no_proxy: '',
    OSI_EGRESS_PROXY_CREDENTIAL_FILE: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
    OSI_EGRESS_CA_CERT_FILE: DEPENDENCY_EGRESS_CA_CERT_PATH,
  });
}

export async function createDependencyEgressNetwork(input: DependencyEgressNetworkInput): Promise<DependencyEgressNetwork> {
  const policy = operationNetworkPolicy(input.operationId);
  if (policy.kind !== 'dependency-egress' || policy.allowedHosts.length === 0) throw new Error('operation has no installed dependency egress policy');
  if (!IMAGE_ID.test(input.imageId) || !ID.test(input.imageDigest) || !ID.test(input.manifestSha256) || !ID.test(input.credential.sha256) || input.credential.containerPath !== DEPENDENCY_EGRESS_CREDENTIAL_PATH || !input.credential.hostPath.startsWith('/')) throw new Error('dependency egress identity is invalid');
  const { networkName, proxyName } = dependencyEgressNames(input);
  const networkLabels = labels(input, 'network');
  let networkId: string | null = null;
  let proxyId: string | null = null;
  const generatedTls = input.tls === undefined;
  const tls = input.tls ?? await createDependencyEgressTlsMaterial({
    credentialHostPath: input.credential.hostPath,
    jobId: input.jobId,
    operationId: input.operationId,
    attempt: input.attempt,
    allowedHosts: policy.allowedHosts,
  });
  const boundInput: DependencyEgressNetworkInput = { ...input, tls };
  try {
    if (generatedTls) await verifyDependencyEgressTlsMaterial(tls, policy.allowedHosts);
    networkId = requireSuccess(await input.run([
      input.dockerPath, 'network', 'create', '--internal',
      ...Object.entries(networkLabels).map(([key, value]) => `--label=${key}=${String(value)}`),
      networkName,
    ]), 'Docker egress network create').trim();
    if (!ID.test(networkId)) throw new Error('Docker egress network create returned an invalid ID');
    inspectNetwork(await inspectDockerNetwork(input, networkId), { id: networkId, name: networkName, labels: networkLabels });

    const proxyLabels = labels(input, 'proxy');
    proxyId = requireSuccess(await input.run([
      input.dockerPath, 'create', `--name=${proxyName}`,
      ...Object.entries(proxyLabels).map(([key, value]) => `--label=${key}=${String(value)}`),
      `--network=${networkName}`,
      `--network-alias=${DEPENDENCY_EGRESS_PROXY_ALIAS}`,
      `--user=${input.uid}:${input.gid}`,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '--pids-limit=128',
      '--cpus=1',
      '--memory=256m',
      '--memory-swap=256m',
      '--ulimit=nofile=256:1024',
      `--mount=type=bind,source=${input.credential.hostPath},destination=${DEPENDENCY_EGRESS_CREDENTIAL_PATH},readonly`,
      `--mount=type=bind,source=${tls.hostDirectory},destination=${DEPENDENCY_EGRESS_TLS_DIRECTORY},readonly`,
      ...environment(policy.allowedHosts).map((item) => `--env=${item}`),
      '--pull=never',
      input.imageReference,
      'node',
      DEPENDENCY_EGRESS_PROXY_PATH,
    ]), 'Docker egress proxy create').trim();
    if (!ID.test(proxyId)) throw new Error('Docker egress proxy create returned an invalid ID');
    inspectProxy(await inspectContainer(input, proxyId), boundInput, { id: proxyId, name: proxyName, networkId, networkName, running: false, bridge: false, allowedHosts: policy.allowedHosts });

    requireSuccess(await input.run([input.dockerPath, 'start', proxyId]), 'Docker egress proxy start');
    const runningInternal = inspectProxy(await inspectContainer(input, proxyId), boundInput, { id: proxyId, name: proxyName, networkId, networkName, running: true, bridge: false, allowedHosts: policy.allowedHosts });
    await awaitReadiness(input, proxyId, runningInternal.internal.address, 'none', false);

    requireSuccess(await input.run([input.dockerPath, 'network', 'connect', 'bridge', proxyId]), 'Docker egress proxy bridge attach');
    const running = inspectProxy(await inspectContainer(input, proxyId), boundInput, { id: proxyId, name: proxyName, networkId, networkName, running: true, bridge: true, allowedHosts: policy.allowedHosts });
    if (running.bridge === null) throw new Error('Docker egress proxy bridge endpoint is missing');
    const ready = await awaitReadiness(input, proxyId, running.internal.address, running.bridge.address, true);
    inspectNetwork(await inspectDockerNetwork(input, networkId), {
      id: networkId,
      name: networkName,
      labels: networkLabels,
      proxy: { id: proxyId, name: proxyName, endpointId: running.internal.endpointId, address: running.internal.address },
    });
    return Object.freeze({
      network: Object.freeze({ id: networkId, name: networkName, internal: true, labels: networkLabels, proxyEndpointId: running.internal.endpointId, proxyAddress: running.internal.address }),
      proxy: Object.freeze({ id: proxyId, name: proxyName, imageReference: input.imageReference, imageId: input.imageId, imageDigest: input.imageDigest, user: `${input.uid}:${input.gid}`, labels: proxyLabels, command: Object.freeze(['node', DEPENDENCY_EGRESS_PROXY_PATH]), internalEndpointId: running.internal.endpointId, internalAddress: running.internal.address, bridgeNetworkId: running.bridge.networkId, bridgeEndpointId: running.bridge.endpointId, bridgeAddress: running.bridge.address }),
      credential: Object.freeze({ ...input.credential }),
      tls,
      readiness: Object.freeze(ready),
      allowedHosts: policy.allowedHosts,
      networkName,
      proxyName,
    });
  } catch (error) {
    try { await cleanupCreated(input, { proxyId, networkId }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Docker egress setup failed and cleanup could not be attested'); }
    if (generatedTls) await destroyDependencyEgressTlsMaterial(tls).catch(() => undefined);
    throw error;
  }
}

export async function destroyDependencyEgressNetwork(
  input: Pick<DependencyEgressNetworkInput, 'dockerPath' | 'run'>,
  resources: DependencyEgressNetwork,
): Promise<Readonly<{
  readonly proxy: Readonly<{ readonly id: string; readonly absent: true }>;
  readonly network: Readonly<{ readonly id: string; readonly absent: true }>;
  readonly tls: DependencyEgressTlsCleanupProof;
  readonly globalLabelResult: 'no-match';
}>> {
  const credentialPresent = await verifyCredentialBeforeDestruction(resources.credential);
  const attestGlobalAbsence = async () => {
    const jobId = String(resources.network.labels[EGRESS_JOB_LABEL]);
    const proxyIds = listedIds(requireSuccess(await input.run([input.dockerPath, 'ps', '--all', '--no-trunc', `--filter=label=${EGRESS_JOB_LABEL}=${jobId}`, `--filter=label=${EGRESS_ROLE_LABEL}=proxy`, '--format={{.ID}}']), 'Docker egress proxy global absence'), 'Docker egress proxy global absence');
    const networkIds = listedIds(requireSuccess(await input.run([input.dockerPath, 'network', 'ls', '--no-trunc', `--filter=label=${EGRESS_JOB_LABEL}=${jobId}`, `--filter=label=${EGRESS_ROLE_LABEL}=network`, '--format={{.ID}}']), 'Docker egress network global absence'), 'Docker egress network global absence');
    if (proxyIds.length !== 0 || networkIds.length !== 0) throw new Error('Docker dependency egress global label absence was not proven');
    return 'no-match' as const;
  };
  const proxyResult = await input.run([input.dockerPath, 'inspect', '--type=container', '--format={{json .}}', resources.proxy.id]);
  const networkResult = await input.run([input.dockerPath, 'network', 'inspect', '--format={{json .}}', resources.network.id]);
  const proxyAbsent = proxyResult.exitCode !== 0 && /no such container/iu.test(`${proxyResult.stdout}\n${proxyResult.stderr}`);
  const networkAbsent = networkResult.exitCode !== 0 && /(?:not found|no such network)/iu.test(`${networkResult.stdout}\n${networkResult.stderr}`);
  if (proxyResult.exitCode !== 0 && !proxyAbsent) throw new Error(`Docker persisted egress proxy inspect failed: ${proxyResult.stderr || proxyResult.stdout}`);
  if (networkResult.exitCode !== 0 && !networkAbsent) throw new Error(`Docker persisted egress network inspect failed: ${networkResult.stderr || networkResult.stdout}`);
  if (proxyAbsent) {
    if (!networkAbsent) {
      inspectNetwork(parseJson(networkResult.stdout, 'Docker persisted egress network inspect'), {
        id: resources.network.id,
        name: resources.network.name,
        labels: resources.network.labels,
      });
      await rejectLiveTlsForMissingCredential(credentialPresent, resources.tls.hostDirectory);
      await cleanupCreated(input, { proxyId: null, networkId: resources.network.id });
    }
    const tls = await destroyDependencyEgressTlsMaterial(resources.tls);
    return Object.freeze({ proxy: Object.freeze({ id: resources.proxy.id, absent: true }), network: Object.freeze({ id: resources.network.id, absent: true }), tls, globalLabelResult: await attestGlobalAbsence() });
  }
  if (networkAbsent) throw new Error('persisted Docker egress proxy exists without its internal network');
  const proxy = parseJson(proxyResult.stdout, 'Docker persisted egress proxy inspect');
  if (proxy.Id !== resources.proxy.id || proxy.Name !== `/${resources.proxy.name}` || proxy.Image !== resources.proxy.imageId) throw new Error('persisted Docker egress proxy identity changed before cleanup');
  const config = record(proxy.Config, 'persisted Docker egress proxy config');
  if (config.Image !== resources.proxy.imageReference || config.User !== resources.proxy.user || JSON.stringify(config.Cmd) !== JSON.stringify(resources.proxy.command) || config.Entrypoint !== null) throw new Error('persisted Docker egress proxy config changed before cleanup');
  exactRecord(config.Labels, resources.proxy.labels, 'persisted Docker egress proxy labels');
  exactRecord(environmentRecord(config.Env, 'persisted Docker egress proxy environment'), expectedEnvironmentRecord(resources.allowedHosts), 'persisted Docker egress proxy environment');
  emptyRecordOrNull(config.ExposedPorts, 'persisted Docker egress proxy exposed ports');
  const host = record(proxy.HostConfig, 'persisted Docker egress proxy HostConfig');
  const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits : [];
  const nofile = ulimits.length === 1 ? record(ulimits[0], 'persisted Docker egress proxy nofile ulimit') : {};
  if (host.NetworkMode !== resources.network.name || JSON.stringify(host.CapAdd) !== JSON.stringify(null) || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL']) || host.Privileged !== false || host.PublishAllPorts !== false || JSON.stringify(host.SecurityOpt) !== JSON.stringify(['no-new-privileges:true']) || host.ReadonlyRootfs !== true || host.PidsLimit !== 128 || host.NanoCpus !== PROXY_NANO_CPUS || host.Memory !== PROXY_MEMORY_BYTES || host.MemorySwap !== PROXY_MEMORY_BYTES || nofile.Name !== 'nofile' || nofile.Soft !== 256 || nofile.Hard !== 1024) throw new Error('persisted Docker egress proxy resource or security limits changed before cleanup');
  emptyRecordOrNull(host.PortBindings, 'persisted Docker egress proxy port bindings');
  const mounts = proxy.Mounts;
  if (!Array.isArray(mounts) || mounts.length !== 2) throw new Error('persisted Docker egress proxy TLS mounts changed before cleanup');
  exactRecord(mounts.find((mount) => record(mount, 'Docker persisted egress proxy mount').Destination === resources.credential.containerPath), { Type: 'bind', Source: resources.credential.hostPath, Destination: resources.credential.containerPath, Mode: '', RW: false, Propagation: 'rprivate' }, 'persisted Docker egress proxy credential mount');
  exactRecord(mounts.find((mount) => record(mount, 'Docker persisted egress proxy mount').Destination === DEPENDENCY_EGRESS_TLS_DIRECTORY), { Type: 'bind', Source: resources.tls.hostDirectory, Destination: DEPENDENCY_EGRESS_TLS_DIRECTORY, Mode: '', RW: false, Propagation: 'rprivate' }, 'persisted Docker egress proxy TLS mount');
  const persistedNetworkSettings = record(proxy.NetworkSettings, 'persisted Docker egress proxy network settings');
  emptyRecordOrNull(persistedNetworkSettings.Ports, 'persisted Docker egress proxy runtime ports');
  const networks = record(persistedNetworkSettings.Networks, 'persisted Docker egress proxy networks');
  if (JSON.stringify(Object.keys(networks).sort()) !== JSON.stringify([resources.network.name, 'bridge'].sort())) throw new Error('persisted Docker egress proxy endpoint set changed before cleanup');
  const internal = endpoint(networks[resources.network.name], 'persisted Docker egress proxy internal endpoint');
  const bridge = endpoint(networks.bridge, 'persisted Docker egress proxy bridge endpoint');
  if (internal.networkId !== resources.network.id || internal.endpointId !== resources.proxy.internalEndpointId || internal.address !== resources.proxy.internalAddress || bridge.networkId !== resources.proxy.bridgeNetworkId || bridge.endpointId !== resources.proxy.bridgeEndpointId || bridge.address !== resources.proxy.bridgeAddress) throw new Error('persisted Docker egress proxy endpoint identity changed before cleanup');
  inspectNetwork(parseJson(networkResult.stdout, 'Docker persisted egress network inspect'), {
    id: resources.network.id,
    name: resources.network.name,
    labels: resources.network.labels,
    proxy: { id: resources.proxy.id, name: resources.proxy.name, endpointId: resources.proxy.internalEndpointId, address: resources.proxy.internalAddress },
  });
  await rejectLiveTlsForMissingCredential(credentialPresent, resources.tls.hostDirectory);
  await cleanupCreated(input, { proxyId: resources.proxy.id, networkId: resources.network.id });
  const tls = await destroyDependencyEgressTlsMaterial(resources.tls);
  return Object.freeze({ proxy: Object.freeze({ id: resources.proxy.id, absent: true }), network: Object.freeze({ id: resources.network.id, absent: true }), tls, globalLabelResult: await attestGlobalAbsence() });
}

export interface DependencyEgressRecoveryInput {
  readonly dockerPath: string;
  readonly imageReference: string;
  readonly imageId: string;
  readonly imageDigest: string;
  readonly jobId: string;
  readonly uid: number;
  readonly gid: number;
  readonly manifestSha256: string;
  readonly credentialDirectory: string;
  readonly run: (argv: readonly string[]) => Promise<DockerResult>;
}

function listedIds(stdout: string, field: string): readonly string[] {
  const ids = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (ids.length > 128 || ids.some((id) => !ID.test(id)) || new Set(ids).size !== ids.length) throw new Error(`${field} is invalid`);
  return Object.freeze([...ids].sort());
}

function discoveryBinding(
  input: DependencyEgressRecoveryInput,
  labelsValue: unknown,
  role: 'network' | 'proxy',
): Readonly<{
  operationId: DependencyEgressOperationId;
  attempt: number;
  names: Readonly<{ networkName: string; proxyName: string }>;
  credential: DependencyCredentialIdentity;
  labels: JsonObject;
  policy: Extract<ReturnType<typeof operationNetworkPolicy>, { readonly kind: 'dependency-egress' }>;
}> {
  const discoveredLabels = exactLabels(labelsValue, role);
  if (discoveredLabels[EGRESS_JOB_LABEL] !== input.jobId || discoveredLabels[EGRESS_MANIFEST_LABEL] !== input.manifestSha256) throw new Error('discovered dependency egress labels do not bind the recovering job');
  const operationValue = discoveredLabels[EGRESS_OPERATION_LABEL];
  if (!isDependencyEgressOperationId(operationValue)) throw new Error('discovered dependency egress operation is unknown');
  const operationId = operationValue;
  const attempt = Number(discoveredLabels[EGRESS_ATTEMPT_LABEL]);
  const policy = operationNetworkPolicy(operationId);
  if (policy.kind !== 'dependency-egress') throw new Error('discovered dependency egress operation has no installed policy');
  const names = dependencyEgressNames({ jobId: input.jobId, operationId, attempt });
  const credential = Object.freeze({
    hostPath: join(input.credentialDirectory, `${operationId}-${String(attempt)}.proxy-credential`),
    containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH,
    sha256: String(discoveredLabels[EGRESS_CREDENTIAL_SHA_LABEL]),
  });
  return { operationId, attempt, names, credential, labels: discoveredLabels, policy };
}

export async function recoverDependencyEgressForJob(input: DependencyEgressRecoveryInput): Promise<Readonly<{
  readonly docker: readonly DependencyEgressDockerAbsenceProof[];
  readonly credentials: readonly DependencyCredentialIdentity[];
  readonly globalLabelResult: 'no-match';
}>> {
  if (
    !ID.test(input.imageDigest) || !IMAGE_ID.test(input.imageId) || !ID.test(input.manifestSha256)
    || !isAbsolute(input.credentialDirectory) || resolve(input.credentialDirectory) !== input.credentialDirectory
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.jobId)
  ) throw new Error('dependency egress recovery identity is invalid');
  const proxyIds = listedIds(requireSuccess(await input.run([input.dockerPath, 'ps', '--all', '--no-trunc', `--filter=label=${EGRESS_JOB_LABEL}=${input.jobId}`, `--filter=label=${EGRESS_ROLE_LABEL}=proxy`, '--format={{.ID}}']), 'Docker egress proxy discovery'), 'Docker egress proxy discovery');
  const networkIds = listedIds(requireSuccess(await input.run([input.dockerPath, 'network', 'ls', '--no-trunc', `--filter=label=${EGRESS_JOB_LABEL}=${input.jobId}`, `--filter=label=${EGRESS_ROLE_LABEL}=network`, '--format={{.ID}}']), 'Docker egress network discovery'), 'Docker egress network discovery');
  const networks = new Map<string, Readonly<{ id: string; value: Record<string, unknown>; binding: ReturnType<typeof discoveryBinding> }>>();
  for (const id of networkIds) {
    const value = await inspectDockerNetwork({ ...input, operationId: 'frontend-install', attempt: 1, credential: { hostPath: '/invalid', containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH, sha256: '0'.repeat(64) } }, id);
    const binding = discoveryBinding(input, value.Labels, 'network');
    if (value.Id !== id || value.Name !== binding.names.networkName || networks.has(binding.names.networkName)) throw new Error('discovered dependency egress network identity is ambiguous');
    networks.set(binding.names.networkName, { id, value, binding });
  }

  const proofs: DependencyEgressDockerAbsenceProof[] = [];
  const credentials = new Map<string, DependencyCredentialIdentity>();
  for (const proxyId of proxyIds) {
    const raw = parseJson(requireSuccess(await input.run([input.dockerPath, 'inspect', '--type=container', '--format={{json .}}', proxyId]), 'Docker discovered egress proxy inspect'), 'Docker discovered egress proxy inspect');
    const config = record(raw.Config, 'Docker discovered egress proxy config');
    const binding = discoveryBinding(input, config.Labels, 'proxy');
    const network = networks.get(binding.names.networkName);
    if (
      network === undefined
      || network.binding.operationId !== binding.operationId
      || network.binding.attempt !== binding.attempt
      || network.binding.credential.sha256 !== binding.credential.sha256
    ) throw new Error('discovered dependency egress proxy/network role binding is invalid');
    const credentialPresent = await verifyCredentialBeforeDestruction(binding.credential);
    const state = record(raw.State, 'Docker discovered egress proxy state');
    const status = state.Status;
    if (status !== 'created' && status !== 'running' && status !== 'exited') throw new Error('discovered dependency egress proxy status is invalid');
    const running = state.Running === true;
    if (running !== (status === 'running')) throw new Error('discovered dependency egress proxy running state is invalid');
    const attached = record(record(raw.NetworkSettings, 'Docker discovered egress proxy network settings').Networks, 'Docker discovered egress proxy networks');
    const bridge = Object.hasOwn(attached, 'bridge');
    const tls = await inspectDependencyEgressTlsMaterial({ credentialHostPath: binding.credential.hostPath, allowedHosts: binding.policy.allowedHosts });
    const operationInput: DependencyEgressNetworkInput = {
      ...input,
      operationId: binding.operationId,
      attempt: binding.attempt,
      credential: binding.credential,
      tls,
    };
    await verifyDependencyEgressTlsMaterial(tls, binding.policy.allowedHosts);
    inspectProxy(raw, operationInput, { id: proxyId, name: binding.names.proxyName, networkId: network.id, networkName: binding.names.networkName, running, bridge, allowedHosts: binding.policy.allowedHosts, status });
    const internal = status === 'created' ? null : endpoint(attached[binding.names.networkName], 'Docker discovered egress internal endpoint');
    inspectNetwork(network.value, internal === null ? { id: network.id, name: binding.names.networkName, labels: network.binding.labels } : { id: network.id, name: binding.names.networkName, labels: network.binding.labels, proxy: { id: proxyId, name: binding.names.proxyName, endpointId: internal.endpointId, address: internal.address } });
    await rejectLiveTlsForMissingCredential(credentialPresent, tls.hostDirectory);
    await cleanupCreated(input, { proxyId, networkId: network.id });
    const tlsProof = await destroyDependencyEgressTlsMaterial(tls);
    networks.delete(binding.names.networkName);
    const previous = credentials.get(binding.credential.hostPath);
    if (previous !== undefined && previous.sha256 !== binding.credential.sha256) throw new Error('discovered dependency egress credential identity is ambiguous');
    credentials.set(binding.credential.hostPath, binding.credential);
    proofs.push({
      operationId: binding.operationId,
      attempt: binding.attempt,
      proxy: { id: proxyId, absent: true },
      network: { id: network.id, absent: true },
      tls: { hostDirectory: tlsProof.hostDirectory, absent: true },
      credential: { hostPath: binding.credential.hostPath, sha256: binding.credential.sha256 },
    });
  }
  for (const network of networks.values()) {
    inspectNetwork(network.value, { id: network.id, name: network.binding.names.networkName, labels: network.binding.labels });
    const credentialPresent = await verifyCredentialBeforeDestruction(network.binding.credential);
    await rejectLiveTlsForMissingCredential(credentialPresent, derivedTlsDirectory(network.binding.credential.hostPath));
    await cleanupCreated(input, { proxyId: null, networkId: network.id });
    const tlsProof = await destroyDependencyEgressTlsMaterial({ hostDirectory: derivedTlsDirectory(network.binding.credential.hostPath) });
    const previous = credentials.get(network.binding.credential.hostPath);
    if (previous !== undefined && previous.sha256 !== network.binding.credential.sha256) throw new Error('discovered dependency egress credential identity is ambiguous');
    credentials.set(network.binding.credential.hostPath, network.binding.credential);
    proofs.push({
      operationId: network.binding.operationId,
      attempt: network.binding.attempt,
      proxy: null,
      network: { id: network.id, absent: true },
      tls: { hostDirectory: tlsProof.hostDirectory, absent: true },
      credential: { hostPath: network.binding.credential.hostPath, sha256: network.binding.credential.sha256 },
    });
  }
  const remainingProxyIds = listedIds(requireSuccess(await input.run([input.dockerPath, 'ps', '--all', '--no-trunc', `--filter=label=${EGRESS_JOB_LABEL}=${input.jobId}`, `--filter=label=${EGRESS_ROLE_LABEL}=proxy`, '--format={{.ID}}']), 'Docker egress proxy absence discovery'), 'Docker egress proxy absence discovery');
  const remainingNetworkIds = listedIds(requireSuccess(await input.run([input.dockerPath, 'network', 'ls', '--no-trunc', `--filter=label=${EGRESS_JOB_LABEL}=${input.jobId}`, `--filter=label=${EGRESS_ROLE_LABEL}=network`, '--format={{.ID}}']), 'Docker egress network absence discovery'), 'Docker egress network absence discovery');
  if (remainingProxyIds.length !== 0 || remainingNetworkIds.length !== 0) throw new Error('Docker dependency egress global absence was not proven');
  proofs.sort((left, right) => `${left.operationId}:${left.attempt}:${left.network.id}`.localeCompare(`${right.operationId}:${right.attempt}:${right.network.id}`));
  const sortedCredentials = [...credentials.values()].sort((left, right) => left.hostPath.localeCompare(right.hostPath));
  return Object.freeze({ docker: Object.freeze(proofs), credentials: Object.freeze(sortedCredentials), globalLabelResult: 'no-match' as const });
}
