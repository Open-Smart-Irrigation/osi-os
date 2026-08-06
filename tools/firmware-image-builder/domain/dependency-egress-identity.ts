import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import type { TrustedOperationId, DependencyEgressOperationId } from './types.js';

export type DependencyEgressJsonPrimitive = string | number | boolean | null;
export type DependencyEgressJsonValue = DependencyEgressJsonPrimitive | readonly DependencyEgressJsonValue[] | Readonly<{ readonly [key: string]: DependencyEgressJsonValue }>;
export type DependencyEgressJsonObject = Readonly<{ readonly [key: string]: DependencyEgressJsonValue }>;

export const DEPENDENCY_EGRESS_PROXY_PORT = 3128;
export const DEPENDENCY_EGRESS_PROXY_ALIAS = 'osi-egress-proxy';
export const DEPENDENCY_EGRESS_PROXY_PATH = '/opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs';
export const DEPENDENCY_EGRESS_CREDENTIAL_PATH = '/run/osi-image-builder/proxy-credential';
export const DEPENDENCY_EGRESS_CA_CERT_PATH = '/run/osi-image-builder/ca.pem';
export const DEPENDENCY_EGRESS_TLS_DIRECTORY = '/run/osi-image-builder/tls';
export const EGRESS_JOB_LABEL = 'org.osi.image-builder.egress-job-id';
export const EGRESS_MANIFEST_LABEL = 'org.osi.image-builder.egress-manifest-sha';
export const EGRESS_OPERATION_LABEL = 'org.osi.image-builder.egress-operation-id';
export const EGRESS_ATTEMPT_LABEL = 'org.osi.image-builder.egress-attempt';
export const EGRESS_CREDENTIAL_SHA_LABEL = 'org.osi.image-builder.egress-credential-sha';
export const EGRESS_ROLE_LABEL = 'org.osi.image-builder.egress-role';
export const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const PROXY_NANO_CPUS = 1_000_000_000;
export const PROXY_MEMORY_BYTES = 256 * 1024 * 1024;
export const ID = /^[a-f0-9]{64}$/u;
export const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;

export const DEPENDENCY_EGRESS_OPERATION_HOSTS = Object.freeze({
  'frontend-install': Object.freeze(['registry.npmjs.org']),
  'build-image': Object.freeze([
    'busybox.net', 'cdn.kernel.org', 'codeload.github.com', 'crates.io', 'download.savannah.gnu.org',
    'downloads.openwrt.org', 'ftp.gnu.org', 'ftpmirror.gnu.org', 'git.kernel.org', 'git.openwrt.org', 'github.com',
    'mirror2.openwrt.org', 'nodejs.org', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
    'registry.npmjs.org', 'sources.cdn.openwrt.org', 'static.crates.io', 'static.rust-lang.org', 'www.kernel.org',
  ]),
} as const satisfies Readonly<Record<DependencyEgressOperationId, readonly string[]>>);

function isDependencyEgressOperationId(value: unknown): value is DependencyEgressOperationId {
  return typeof value === 'string' && Object.hasOwn(DEPENDENCY_EGRESS_OPERATION_HOSTS, value);
}

export interface DockerResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DependencyCredentialIdentity {
  readonly hostPath: string;
  readonly containerPath: typeof DEPENDENCY_EGRESS_CREDENTIAL_PATH;
  readonly sha256: string;
}

export interface DependencyEgressTlsMaterial {
  readonly hostDirectory: string;
  readonly directoryMetadata: DependencyEgressTlsDirectoryMetadata;
  readonly caCertificateHostPath: string;
  readonly caCertificateMetadata: DependencyEgressTlsFileMetadata;
  readonly leafCertificates: Readonly<Record<string, Readonly<{
    readonly certificateHostPath: string;
    readonly keyHostPath: string;
    readonly certificateMetadata: DependencyEgressTlsFileMetadata;
    readonly keyMetadata: DependencyEgressTlsFileMetadata;
  }>>>;
}

export interface DependencyEgressTlsCleanupProof {
  readonly [key: string]: DependencyEgressJsonValue;
  readonly hostDirectory: string;
  readonly absent: true;
}

export interface DependencyEgressTlsDirectoryMetadata {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly device: number;
  readonly inode: number;
}

export interface DependencyEgressTlsFileMetadata extends DependencyEgressTlsDirectoryMetadata {
  readonly sha256: string;
  readonly bytes: number;
  readonly links: number;
}

export interface DependencyEgressNetworkInput {
  readonly dockerPath: string;
  readonly imageReference: string;
  readonly imageId: string;
  readonly imageDigest: string;
  readonly jobId: string;
  readonly operationId: TrustedOperationId;
  readonly attempt: number;
  readonly uid: number;
  readonly gid: number;
  readonly manifestSha256: string;
  readonly credential: DependencyCredentialIdentity;
  readonly tls?: DependencyEgressTlsMaterial;
  readonly run: (argv: readonly string[]) => Promise<DockerResult>;
}

export interface DependencyEgressNetworkIdentity {
  readonly id: string;
  readonly name: string;
  readonly internal: true;
  readonly labels: DependencyEgressJsonObject;
  readonly proxyEndpointId: string;
  readonly proxyAddress: string;
}

export interface DependencyEgressProxyIdentity {
  readonly id: string;
  readonly name: string;
  readonly imageReference: string;
  readonly imageId: string;
  readonly imageDigest: string;
  readonly user: string;
  readonly labels: DependencyEgressJsonObject;
  readonly command: readonly string[];
  readonly internalEndpointId: string;
  readonly internalAddress: string;
  readonly bridgeNetworkId: string;
  readonly bridgeEndpointId: string;
  readonly bridgeAddress: string;
}

export interface DependencyEgressReadiness {
  readonly authenticated: true;
  readonly unauthenticatedStatus: 407;
  readonly authenticatedStatus: 204;
  readonly bridgeEndpointDenied: true;
}

export interface DependencyEgressNetwork {
  readonly network: DependencyEgressNetworkIdentity;
  readonly proxy: DependencyEgressProxyIdentity;
  readonly credential: DependencyCredentialIdentity;
  readonly tls: DependencyEgressTlsMaterial;
  readonly readiness: DependencyEgressReadiness;
  readonly allowedHosts: readonly string[];
  readonly networkName: string;
  readonly proxyName: string;
}

export type DependencyEgressCredentialAbsenceProof = Readonly<{
  readonly kind: 'normal' | 'credential-only';
  readonly operationId: DependencyEgressOperationId;
  readonly attempt: number;
  readonly hostPath: string;
  readonly expectedSha256: string;
  readonly observedSha256: string | null;
  readonly tls: DependencyEgressTlsCleanupProof;
  readonly absent: true;
}> | Readonly<{
  readonly kind: 'tls-only';
  readonly operationId: DependencyEgressOperationId;
  readonly attempt: number;
  readonly hostPath: string;
  readonly expectedSha256: string | null;
  readonly observedSha256: null;
  readonly tls: DependencyEgressTlsCleanupProof;
  readonly absent: true;
}>;

export type DependencyEgressCredentialRemnant = Readonly<{
  readonly kind: 'normal' | 'credential-only';
  readonly identity: DependencyCredentialIdentity;
  readonly hostDirectory: string;
}> | Readonly<{
  readonly kind: 'tls-only';
  readonly operationId: DependencyEgressOperationId;
  readonly attempt: number;
  readonly credentialHostPath: string;
  readonly hostDirectory: string;
}>;

export type DependencyEgressCredentialCleanupResult = Readonly<{
  readonly kind: 'normal' | 'credential-only';
  readonly hostPath: string;
  readonly expectedSha256: string;
  readonly observedSha256: string | null;
  readonly tls: DependencyEgressTlsCleanupProof;
  readonly absent: true;
}> | Readonly<{
  readonly kind: 'tls-only';
  readonly hostPath: string;
  readonly expectedSha256: string | null;
  readonly observedSha256: null;
  readonly tls: DependencyEgressTlsCleanupProof;
  readonly absent: true;
}>;

export type DependencyEgressDockerAbsenceProof = Readonly<{
  readonly operationId: DependencyEgressOperationId;
  readonly attempt: number;
  readonly proxy: Readonly<{ readonly id: string; readonly absent: true }> | null;
  readonly network: Readonly<{ readonly id: string; readonly absent: true }>;
  readonly tls: Readonly<{ readonly hostDirectory: string; readonly absent: true }>;
  readonly credential: Readonly<{ readonly hostPath: string; readonly sha256: string }>;
}>;

export type DependencyEgressPersistedDockerAbsenceProof = Readonly<{
  readonly operationId: DependencyEgressOperationId;
  readonly attempt: number;
  readonly proxy: Readonly<{ readonly id: string; readonly absent: true }>;
  readonly network: Readonly<{ readonly id: string; readonly absent: true }>;
  readonly tls: Readonly<{ readonly hostDirectory: string; readonly absent: true }>;
  readonly credential: Readonly<{ readonly hostPath: string; readonly sha256: string }>;
  readonly globalLabelResult: 'no-match';
}>;

export type DependencyEgressCleanupPostcondition = Readonly<{
  readonly persistedDocker: DependencyEgressPersistedDockerAbsenceProof | null;
  readonly discoveredDocker: readonly DependencyEgressDockerAbsenceProof[];
  readonly credentials: readonly DependencyEgressCredentialAbsenceProof[];
  readonly globalLabelResult: 'no-match';
}>;

export function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${field} fields are not exact`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${field} is invalid`);
  return value as string[];
}

export function exactLabels(value: unknown, role: 'network' | 'proxy'): DependencyEgressJsonObject {
  const actual = record(value, `persisted dependency egress ${role} labels`);
  exactKeys(actual, [EGRESS_JOB_LABEL, EGRESS_MANIFEST_LABEL, EGRESS_OPERATION_LABEL, EGRESS_ATTEMPT_LABEL, EGRESS_CREDENTIAL_SHA_LABEL, EGRESS_ROLE_LABEL], `persisted dependency egress ${role} labels`);
  if (
    typeof actual[EGRESS_JOB_LABEL] !== 'string'
    || typeof actual[EGRESS_MANIFEST_LABEL] !== 'string'
    || !ID.test(actual[EGRESS_MANIFEST_LABEL])
    || typeof actual[EGRESS_OPERATION_LABEL] !== 'string'
    || typeof actual[EGRESS_ATTEMPT_LABEL] !== 'string' || !/^[1-9][0-9]*$/u.test(actual[EGRESS_ATTEMPT_LABEL]) || !Number.isSafeInteger(Number(actual[EGRESS_ATTEMPT_LABEL]))
    || typeof actual[EGRESS_CREDENTIAL_SHA_LABEL] !== 'string' || !ID.test(actual[EGRESS_CREDENTIAL_SHA_LABEL])
    || actual[EGRESS_ROLE_LABEL] !== role
  ) throw new Error(`persisted dependency egress ${role} labels are invalid`);
  return Object.freeze({ ...actual }) as DependencyEgressJsonObject;
}

function suffix(input: Pick<DependencyEgressNetworkInput, 'jobId' | 'operationId' | 'attempt'>): string {
  return createHash('sha256').update(`${input.jobId}:${input.operationId}:${input.attempt}`).digest('hex').slice(0, 16);
}

export function dependencyEgressNames(input: Pick<DependencyEgressNetworkInput, 'jobId' | 'operationId' | 'attempt'>): Readonly<{
  readonly networkName: string;
  readonly proxyName: string;
}> {
  const id = suffix(input);
  return Object.freeze({
    networkName: `osi-image-builder-egress-${id}`,
    proxyName: `osi-image-builder-egress-proxy-${id}`,
  });
}

function tlsDirectoryMetadata(value: unknown, field: string): DependencyEgressTlsDirectoryMetadata {
  const metadata = record(value, field);
  exactKeys(metadata, ['mode', 'uid', 'gid', 'device', 'inode'], field);
  for (const key of ['mode', 'uid', 'gid', 'device', 'inode'] as const) {
    if (!Number.isSafeInteger(metadata[key]) || Number(metadata[key]) < 0) throw new Error(`${field} is invalid`);
  }
  return Object.freeze({ mode: Number(metadata.mode), uid: Number(metadata.uid), gid: Number(metadata.gid), device: Number(metadata.device), inode: Number(metadata.inode) });
}

function tlsFileMetadata(value: unknown, field: string): DependencyEgressTlsFileMetadata {
  const metadata = record(value, field);
  exactKeys(metadata, ['mode', 'uid', 'gid', 'device', 'inode', 'sha256', 'bytes', 'links'], field);
  const base = tlsDirectoryMetadata({ mode: metadata.mode, uid: metadata.uid, gid: metadata.gid, device: metadata.device, inode: metadata.inode }, field);
  if (typeof metadata.sha256 !== 'string' || !ID.test(metadata.sha256) || !Number.isSafeInteger(metadata.bytes) || Number(metadata.bytes) < 1 || metadata.links !== 1) throw new Error(`${field} is invalid`);
  return Object.freeze({ ...base, sha256: metadata.sha256, bytes: Number(metadata.bytes), links: 1 });
}

function canonicalAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.includes('\\') || resolve(value) !== value) throw new Error(`${field} is not canonical`);
  return value;
}

function tlsLeafName(host: string): string {
  return host.replaceAll('.', '_');
}

export function parseDependencyEgressNetwork(value: unknown): DependencyEgressNetwork {
  const root = record(value, 'persisted dependency egress identity');
  exactKeys(root, ['network', 'proxy', 'credential', 'tls', 'readiness', 'allowedHosts', 'networkName', 'proxyName'], 'persisted dependency egress identity');

  const network = record(root.network, 'persisted dependency egress network');
  exactKeys(network, ['id', 'name', 'internal', 'labels', 'proxyEndpointId', 'proxyAddress'], 'persisted dependency egress network');
  if (typeof network.id !== 'string' || !ID.test(network.id) || typeof network.name !== 'string' || !/^osi-image-builder-egress-[a-f0-9]{16}$/u.test(network.name) || network.internal !== true || typeof network.proxyEndpointId !== 'string' || !ID.test(network.proxyEndpointId) || typeof network.proxyAddress !== 'string' || isIP(network.proxyAddress) === 0) throw new Error('persisted dependency egress network identity is invalid');
  const networkLabels = exactLabels(network.labels, 'network');

  const proxy = record(root.proxy, 'persisted dependency egress proxy');
  exactKeys(proxy, ['id', 'name', 'imageReference', 'imageId', 'imageDigest', 'user', 'labels', 'command', 'internalEndpointId', 'internalAddress', 'bridgeNetworkId', 'bridgeEndpointId', 'bridgeAddress'], 'persisted dependency egress proxy');
  if (
    typeof proxy.id !== 'string' || !ID.test(proxy.id)
    || typeof proxy.name !== 'string' || proxy.name !== network.name.replace('osi-image-builder-egress-', 'osi-image-builder-egress-proxy-')
    || typeof proxy.imageReference !== 'string'
    || typeof proxy.imageDigest !== 'string' || !ID.test(proxy.imageDigest) || (!proxy.imageReference.endsWith(`@sha256:${proxy.imageDigest}`) && proxy.imageReference !== proxy.imageId)
    || typeof proxy.imageId !== 'string' || !IMAGE_ID.test(proxy.imageId)
    || typeof proxy.user !== 'string' || !/^\d{1,5}:\d{1,5}$/u.test(proxy.user)
    || !Array.isArray(proxy.command) || JSON.stringify(proxy.command) !== JSON.stringify(['node', DEPENDENCY_EGRESS_PROXY_PATH])
    || typeof proxy.internalEndpointId !== 'string' || !ID.test(proxy.internalEndpointId) || proxy.internalEndpointId !== network.proxyEndpointId
    || typeof proxy.internalAddress !== 'string' || isIP(proxy.internalAddress) === 0 || proxy.internalAddress !== network.proxyAddress
    || typeof proxy.bridgeNetworkId !== 'string' || !ID.test(proxy.bridgeNetworkId)
    || typeof proxy.bridgeEndpointId !== 'string' || !ID.test(proxy.bridgeEndpointId)
    || typeof proxy.bridgeAddress !== 'string' || isIP(proxy.bridgeAddress) === 0
  ) throw new Error('persisted dependency egress proxy identity is invalid');
  const proxyLabels = exactLabels(proxy.labels, 'proxy');
  if (
    proxyLabels[EGRESS_JOB_LABEL] !== networkLabels[EGRESS_JOB_LABEL]
    || proxyLabels[EGRESS_MANIFEST_LABEL] !== networkLabels[EGRESS_MANIFEST_LABEL]
    || proxyLabels[EGRESS_OPERATION_LABEL] !== networkLabels[EGRESS_OPERATION_LABEL]
    || proxyLabels[EGRESS_ATTEMPT_LABEL] !== networkLabels[EGRESS_ATTEMPT_LABEL]
    || proxyLabels[EGRESS_CREDENTIAL_SHA_LABEL] !== networkLabels[EGRESS_CREDENTIAL_SHA_LABEL]
  ) throw new Error('persisted dependency egress labels do not bind one operation');

  const credential = record(root.credential, 'persisted dependency egress credential');
  exactKeys(credential, ['hostPath', 'containerPath', 'sha256'], 'persisted dependency egress credential');
  const credentialHostPath = canonicalAbsolutePath(credential.hostPath, 'persisted dependency egress credential host path');
  if (credential.containerPath !== DEPENDENCY_EGRESS_CREDENTIAL_PATH || typeof credential.sha256 !== 'string' || !ID.test(credential.sha256)) throw new Error('persisted dependency egress credential identity is invalid');
  const tls = record(root.tls, 'persisted dependency egress TLS identity');
  exactKeys(tls, ['hostDirectory', 'directoryMetadata', 'caCertificateHostPath', 'caCertificateMetadata', 'leafCertificates'], 'persisted dependency egress TLS identity');
  const leafCertificates = record(tls.leafCertificates, 'persisted dependency egress TLS leaves');

  const readinessValue = record(root.readiness, 'persisted dependency egress readiness');
  exactKeys(readinessValue, ['authenticated', 'unauthenticatedStatus', 'authenticatedStatus', 'bridgeEndpointDenied'], 'persisted dependency egress readiness');
  if (readinessValue.authenticated !== true || readinessValue.unauthenticatedStatus !== 407 || readinessValue.authenticatedStatus !== 204 || readinessValue.bridgeEndpointDenied !== true) throw new Error('persisted dependency egress readiness is invalid');

  const allowedHosts = strings(root.allowedHosts, 'persisted dependency egress allowed hosts');
  if (allowedHosts.length === 0 || allowedHosts.some((host) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host))) throw new Error('persisted dependency egress allowed hosts are invalid');
  const operationIdValue = networkLabels[EGRESS_OPERATION_LABEL];
  if (!isDependencyEgressOperationId(operationIdValue)) throw new Error('persisted dependency egress operation is invalid');
  const operationId = operationIdValue;
  const attempt = Number(networkLabels[EGRESS_ATTEMPT_LABEL]);
  const allowedHostsPolicy = DEPENDENCY_EGRESS_OPERATION_HOSTS[operationId];
  if (JSON.stringify(allowedHosts) !== JSON.stringify(allowedHostsPolicy)) throw new Error('persisted dependency egress hosts do not match installed policy');
  const credentialName = `${operationId}-${String(attempt)}.proxy-credential`;
  if (!credentialHostPath.endsWith(`/${credentialName}`)) throw new Error('persisted dependency egress credential path is not bound to the operation');
  const expectedTlsDirectory = credentialHostPath.slice(0, -'.proxy-credential'.length) + '.proxy-tls';
  const hostDirectory = canonicalAbsolutePath(tls.hostDirectory, 'persisted dependency egress TLS host directory');
  if (hostDirectory !== expectedTlsDirectory) throw new Error('persisted dependency egress TLS directory is not bound to the credential');
  const directoryMetadata = tlsDirectoryMetadata(tls.directoryMetadata, 'persisted dependency egress TLS directory metadata');
  if (directoryMetadata.mode !== 0o700 || directoryMetadata.device < 1 || directoryMetadata.inode < 1) throw new Error('persisted dependency egress TLS directory metadata is unsafe');
  const caCertificateHostPath = canonicalAbsolutePath(tls.caCertificateHostPath, 'persisted dependency egress TLS CA path');
  if (caCertificateHostPath !== join(hostDirectory, 'ca.pem')) throw new Error('persisted dependency egress TLS CA path is not canonical');
  const caCertificateMetadata = tlsFileMetadata(tls.caCertificateMetadata, 'persisted dependency egress TLS CA certificate metadata');
  if (caCertificateMetadata.mode !== 0o444 || caCertificateMetadata.device < 1 || caCertificateMetadata.inode < 1 || caCertificateMetadata.links !== 1) throw new Error('persisted dependency egress TLS CA metadata is unsafe');
  exactKeys(leafCertificates, allowedHostsPolicy, 'persisted dependency egress TLS leaves');
  const parsedLeaves: Record<string, Readonly<{
    readonly certificateHostPath: string;
    readonly keyHostPath: string;
    readonly certificateMetadata: DependencyEgressTlsFileMetadata;
    readonly keyMetadata: DependencyEgressTlsFileMetadata;
  }>> = {};
  for (const host of allowedHostsPolicy) {
    const leaf = record(leafCertificates[host], `persisted dependency egress TLS leaf ${host}`);
    exactKeys(leaf, ['certificateHostPath', 'keyHostPath', 'certificateMetadata', 'keyMetadata'], `persisted dependency egress TLS leaf ${host}`);
    const certificateHostPath = canonicalAbsolutePath(leaf.certificateHostPath, `persisted dependency egress TLS leaf certificate path ${host}`);
    const keyHostPath = canonicalAbsolutePath(leaf.keyHostPath, `persisted dependency egress TLS leaf key path ${host}`);
    const name = tlsLeafName(host);
    if (certificateHostPath !== join(hostDirectory, `${name}.pem`) || keyHostPath !== join(hostDirectory, `${name}.key`)) throw new Error('persisted dependency egress TLS leaf path is not canonical');
    const certificateMetadata = tlsFileMetadata(leaf.certificateMetadata, `persisted dependency egress TLS leaf certificate ${host}`);
    const keyMetadata = tlsFileMetadata(leaf.keyMetadata, `persisted dependency egress TLS leaf key ${host}`);
    if (certificateMetadata.mode !== 0o444 || keyMetadata.mode !== 0o400 || certificateMetadata.device < 1 || certificateMetadata.inode < 1 || keyMetadata.device < 1 || keyMetadata.inode < 1 || certificateMetadata.links !== 1 || keyMetadata.links !== 1) throw new Error('persisted dependency egress TLS leaf metadata is unsafe');
    parsedLeaves[host] = Object.freeze({ certificateHostPath, keyHostPath, certificateMetadata, keyMetadata });
  }
  if (root.networkName !== network.name || root.proxyName !== proxy.name) throw new Error('persisted dependency egress compatibility names changed');
  const expectedNames = dependencyEgressNames({ jobId: String(networkLabels[EGRESS_JOB_LABEL]), operationId, attempt });
  if (network.name !== expectedNames.networkName || proxy.name !== expectedNames.proxyName || credential.sha256 !== networkLabels[EGRESS_CREDENTIAL_SHA_LABEL]) throw new Error('persisted dependency egress names or credential binding changed');

  return Object.freeze({
    network: Object.freeze({ id: network.id, name: network.name, internal: true, labels: networkLabels, proxyEndpointId: network.proxyEndpointId, proxyAddress: network.proxyAddress }),
    proxy: Object.freeze({ id: proxy.id, name: proxy.name, imageReference: proxy.imageReference, imageId: proxy.imageId, imageDigest: proxy.imageDigest, user: proxy.user, labels: proxyLabels, command: Object.freeze([...proxy.command] as string[]), internalEndpointId: proxy.internalEndpointId, internalAddress: proxy.internalAddress, bridgeNetworkId: proxy.bridgeNetworkId, bridgeEndpointId: proxy.bridgeEndpointId, bridgeAddress: proxy.bridgeAddress }),
    credential: Object.freeze({ hostPath: credentialHostPath, containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH, sha256: credential.sha256 }),
    tls: Object.freeze({ hostDirectory, directoryMetadata, caCertificateHostPath, caCertificateMetadata, leafCertificates: Object.freeze(parsedLeaves) }),
    readiness: Object.freeze({ authenticated: true, unauthenticatedStatus: 407, authenticatedStatus: 204, bridgeEndpointDenied: true }),
    allowedHosts: Object.freeze([...allowedHosts]),
    networkName: network.name,
    proxyName: proxy.name,
  });
}
