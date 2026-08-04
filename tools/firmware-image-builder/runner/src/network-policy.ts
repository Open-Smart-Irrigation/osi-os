import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { TrustedOperationId } from '../../domain/types.js';
import {
  createInstalledDependencyEgressProxyReader,
  type InstalledDependencyEgressProxyReaderOptions,
} from '../../domain/installed-dependency-egress-proxy.js';
import { DEPENDENCY_EGRESS_OPERATION_HOSTS } from '../../domain/dependency-egress-identity.js';

export const OFFLINE_NETWORK_MODE = 'none' as const;
export const DEPENDENCY_EGRESS_NETWORK_MODE = 'internal-authenticated-proxy' as const;

const EMPTY_HOSTS = Object.freeze([]) as readonly [];
export type DockerNetworkPolicy =
  | Readonly<{ readonly kind: 'offline'; readonly dockerNetwork: typeof OFFLINE_NETWORK_MODE; readonly allowedHosts: readonly [] }>
  | Readonly<{ readonly kind: 'dependency-egress'; readonly dockerNetwork: typeof DEPENDENCY_EGRESS_NETWORK_MODE; readonly allowedHosts: readonly string[] }>;

export interface DependencyLookupAddress {
  readonly address: string;
  readonly family: number;
}

export interface DependencyDestinationRequest {
  readonly operationId: TrustedOperationId;
  readonly host: string;
  readonly port: number;
  readonly tlsServerName: string | null;
}

export interface AuthorizedDependencyDestination {
  readonly host: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
}

export type DependencyLookup = (host: string) => Promise<readonly DependencyLookupAddress[]>;

interface RuntimePolicy {
  readonly resolveDependencyDestination: (
    request: DependencyDestinationRequest & Readonly<{ readonly allowedHosts: readonly string[] }>,
    lookup: DependencyLookup,
  ) => Promise<AuthorizedDependencyDestination>;
}

const HASH64 = /^[a-f0-9]{64}$/u;
const MAX_PROXY_RUNTIME_BYTES = 1024 * 1024;
const blockedIpv4Addresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4');

function deny(message = 'dependency egress denied'): never {
  throw new Error(message);
}

function normalizedHost(value: unknown): string {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/u, '');
  if (
    host.length < 1
    || host.length > 253
    || isIP(host) !== 0
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(host)
  ) deny();
  return host;
}

function ipv4Bytes(address: string): Buffer {
  if (isIP(address) !== 4) deny();
  const bytes = address.split('.').map((part) => Number(part));
  if (bytes.length !== 4 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) deny();
  return Buffer.from(bytes);
}

function ipv6Bytes(address: string): Buffer {
  if (isIP(address) !== 6) deny();
  let value = address.toLowerCase();
  const ipv4Separator = value.lastIndexOf(':');
  if (value.includes('.')) {
    if (ipv4Separator < 0) deny();
    const embedded = ipv4Bytes(value.slice(ipv4Separator + 1));
    value = `${value.slice(0, ipv4Separator)}:${embedded.readUInt16BE(0).toString(16)}:${embedded.readUInt16BE(2).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) deny();
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':');
  const compressed = halves.length === 2;
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) deny();
  const groups = compressed
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) deny();
  const result = Buffer.alloc(16);
  groups.forEach((group, index) => result.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return result;
}

function hasPrefix(bytes: Buffer, prefix: Buffer, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  if (!bytes.subarray(0, fullBytes).equals(prefix.subarray(0, fullBytes))) return false;
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes]! & mask) === (prefix[fullBytes]! & mask);
}

function ipv4BytesAreGlobal(bytes: Buffer): boolean {
  return !blockedIpv4Addresses.check([...bytes].join('.'), 'ipv4');
}

function embeddedIpv4(bytes: Buffer, offset: number, inverted = false): boolean {
  const value = Buffer.from(bytes.subarray(offset, offset + 4));
  if (value.length !== 4) deny();
  if (inverted) for (let index = 0; index < value.length; index += 1) value[index] = value[index]! ^ 0xff;
  return ipv4BytesAreGlobal(value);
}

const IPV6_PREFIXES = Object.freeze({
  compatible: ipv6Bytes('::'),
  mapped: ipv6Bytes('::ffff:0:0'),
  nat64: ipv6Bytes('64:ff9b::'),
  sixToFour: ipv6Bytes('2002::'),
  teredo: ipv6Bytes('2001::'),
  protocolAssignments: ipv6Bytes('2001::'),
  documentation: ipv6Bytes('2001:db8::'),
  documentationV2: ipv6Bytes('3fff::'),
  globalUnicast: ipv6Bytes('2000::'),
});

function ipv6AddressIsGlobal(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (hasPrefix(bytes, IPV6_PREFIXES.mapped, 96) || hasPrefix(bytes, IPV6_PREFIXES.compatible, 96)) {
    embeddedIpv4(bytes, 12);
    return false;
  }
  if (hasPrefix(bytes, IPV6_PREFIXES.nat64, 96)) {
    embeddedIpv4(bytes, 12);
    return false;
  }
  if (hasPrefix(bytes, IPV6_PREFIXES.sixToFour, 16)) {
    embeddedIpv4(bytes, 2);
    return false;
  }
  if (hasPrefix(bytes, IPV6_PREFIXES.teredo, 32)) {
    embeddedIpv4(bytes, 12, true);
    return false;
  }
  return hasPrefix(bytes, IPV6_PREFIXES.globalUnicast, 3)
    && !hasPrefix(bytes, IPV6_PREFIXES.protocolAssignments, 23)
    && !hasPrefix(bytes, IPV6_PREFIXES.documentation, 32)
    && !hasPrefix(bytes, IPV6_PREFIXES.documentationV2, 20);
}

function publicAddress(value: unknown): DependencyLookupAddress & Readonly<{ family: 4 | 6 }> {
  if (value === null || typeof value !== 'object') deny();
  const address = 'address' in value && typeof value.address === 'string' ? value.address : deny();
  const family = isIP(address);
  if (
    (family !== 4 && family !== 6)
    || !('family' in value)
    || value.family !== family
    || (family === 4 ? blockedIpv4Addresses.check(address, 'ipv4') : !ipv6AddressIsGlobal(address))
  ) deny();
  return Object.freeze({ address, family });
}

async function resolveDependencyDestinationTrusted(
  request: DependencyDestinationRequest & Readonly<{ readonly allowedHosts: readonly string[] }>,
  lookup: DependencyLookup,
): Promise<AuthorizedDependencyDestination> {
  if (request === null || typeof request !== 'object' || typeof lookup !== 'function') deny();
  const allowedHosts = Array.isArray(request.allowedHosts)
    ? request.allowedHosts.map(normalizedHost)
    : deny();
  const host = normalizedHost(request.host);
  const tlsServerName = request.tlsServerName === null ? null : normalizedHost(request.tlsServerName);
  if (
    !allowedHosts.includes(host)
    || (request.port !== 80 && request.port !== 443)
    || (tlsServerName !== null && tlsServerName !== host)
  ) deny();
  const resolved = await lookup(host);
  if (!Array.isArray(resolved) || resolved.length < 1 || resolved.length > 32) deny();
  const addresses = resolved.map(publicAddress);
  const selected = addresses[0];
  if (selected === undefined) deny();
  return Object.freeze({ host, address: selected.address, family: selected.family, port: request.port });
}

function validateDependencyEgressProxyEvidence(bytes: Uint8Array, expectedSha256: string): RuntimePolicy {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_PROXY_RUNTIME_BYTES) {
    throw new Error('dependency egress proxy runtime bytes are invalid');
  }
  if (!HASH64.test(expectedSha256) || /^0+$/u.test(expectedSha256)) {
    throw new Error('dependency egress proxy runtime hash is invalid');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256) throw new Error('dependency egress proxy runtime hash mismatch');
  return Object.freeze({ resolveDependencyDestination: resolveDependencyDestinationTrusted });
}

export function operationNetworkPolicy(operationId: TrustedOperationId): DockerNetworkPolicy {
  const allowedHosts = DEPENDENCY_EGRESS_OPERATION_HOSTS[operationId as keyof typeof DEPENDENCY_EGRESS_OPERATION_HOSTS];
  if (allowedHosts === undefined) {
    return Object.freeze({ kind: 'offline', dockerNetwork: OFFLINE_NETWORK_MODE, allowedHosts: EMPTY_HOSTS });
  }
  return Object.freeze({
    kind: 'dependency-egress',
    dockerNetwork: DEPENDENCY_EGRESS_NETWORK_MODE,
    allowedHosts,
  });
}

export function createDependencyEgressDestinationResolver(
  validatedProxyBytes: Uint8Array,
  expectedSha256: string,
): (
  request: DependencyDestinationRequest,
  lookup: DependencyLookup,
) => Promise<AuthorizedDependencyDestination> {
  const runtime = validateDependencyEgressProxyEvidence(validatedProxyBytes, expectedSha256);
  return async (request, lookup) => {
    const policy = operationNetworkPolicy(request.operationId);
    if (policy.kind !== 'dependency-egress') throw new Error('dependency egress denied');
    return runtime.resolveDependencyDestination({ ...request, allowedHosts: policy.allowedHosts }, lookup);
  };
}

export async function loadInstalledDependencyEgressPolicy(
  packageRoot: string,
  expectedSha256: string,
  readerOptions: InstalledDependencyEgressProxyReaderOptions = {},
): Promise<Readonly<{
  bytes: Buffer;
  sha256: string;
  resolveDependencyDestination: ReturnType<typeof createDependencyEgressDestinationResolver>;
}>> {
  const installed = await createInstalledDependencyEgressProxyReader(readerOptions)
    .read(packageRoot, expectedSha256);
  return Object.freeze({
    bytes: installed.bytes,
    sha256: installed.sha256,
    resolveDependencyDestination: createDependencyEgressDestinationResolver(installed.bytes, expectedSha256),
  });
}
