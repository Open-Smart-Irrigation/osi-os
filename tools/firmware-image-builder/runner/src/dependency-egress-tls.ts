import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TrustedOperationId } from '../../domain/types.js';
import type {
  DependencyEgressTlsCleanupProof,
  DependencyEgressTlsDirectoryMetadata,
  DependencyEgressTlsFileMetadata,
  DependencyEgressTlsMaterial,
} from '../../domain/dependency-egress-identity.js';

const execFileAsync = promisify(execFile);
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const CA_COMMON_NAME = 'OSI image builder';
const TLS_DIRECTORY_NAME = /^(?:build-image|frontend-install)-[1-9][0-9]*\.proxy-tls$/u;

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function directoryMetadata(metadata: Readonly<{ mode: number; uid: number; gid: number; dev: number; ino: number }>): DependencyEgressTlsDirectoryMetadata {
  return Object.freeze({
    mode: metadata.mode & 0o777,
    uid: metadata.uid,
    gid: metadata.gid,
    device: metadata.dev,
    inode: metadata.ino,
  });
}

async function fileMetadata(path: string): Promise<DependencyEgressTlsFileMetadata> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('dependency egress TLS file metadata is unsafe');
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('dependency egress TLS file identity changed while hashing');
  return Object.freeze({
    ...directoryMetadata(after),
    sha256: digest(bytes),
    bytes: after.size,
    links: after.nlink,
  });
}

function exactMetadata(actual: DependencyEgressTlsDirectoryMetadata, expected: DependencyEgressTlsDirectoryMetadata, field: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${field} metadata changed`);
}

function validNow(certificate: X509Certificate, field: string): void {
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  const now = Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to || to <= from || to - from > 3 * 24 * 60 * 60 * 1000) {
    throw new Error(`${field} validity is invalid`);
  }
}

function samePublicKey(certificate: X509Certificate, privateKeyBytes: Buffer): boolean {
  const privateKey = createPrivateKey(privateKeyBytes);
  const publicFromPrivate = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicFromCertificate = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(publicFromPrivate).equals(Buffer.from(publicFromCertificate));
}

function tlsDirectory(credentialHostPath: string): string {
  if (!credentialHostPath.endsWith('.proxy-credential')) throw new Error('dependency egress credential path is not canonical');
  return credentialHostPath.slice(0, -'.proxy-credential'.length) + '.proxy-tls';
}

function leafName(host: string): string {
  if (!HOST.test(host)) throw new Error('dependency egress TLS host is invalid');
  return host.replaceAll('.', '_');
}

async function openssl(args: readonly string[]): Promise<void> {
  await execFileAsync('/usr/bin/openssl', [...args], { timeout: 30_000, maxBuffer: 1024 * 1024 });
}

export async function inspectDependencyEgressTlsMaterial(input: Readonly<{
  readonly credentialHostPath: string;
  readonly allowedHosts: readonly string[];
}>): Promise<DependencyEgressTlsMaterial> {
  const hostDirectory = tlsDirectory(input.credentialHostPath);
  const directory = await lstat(hostDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) throw new Error('dependency egress TLS directory metadata is unsafe');
  const caCertificateHostPath = join(hostDirectory, 'ca.pem');
  const leafCertificates = Object.fromEntries(await Promise.all(input.allowedHosts.map(async (host) => {
    const name = leafName(host);
    const certificateHostPath = join(hostDirectory, `${name}.pem`);
    const keyHostPath = join(hostDirectory, `${name}.key`);
    return [host, Object.freeze({
      certificateHostPath,
      keyHostPath,
      certificateMetadata: await fileMetadata(certificateHostPath),
      keyMetadata: await fileMetadata(keyHostPath),
    })];
  })));
  return Object.freeze({
    hostDirectory,
    directoryMetadata: directoryMetadata(directory),
    caCertificateHostPath,
    caCertificateMetadata: await fileMetadata(caCertificateHostPath),
    leafCertificates: Object.freeze(leafCertificates),
  });
}

export async function createDependencyEgressTlsMaterial(input: Readonly<{
  readonly credentialHostPath: string;
  readonly jobId: string;
  readonly operationId: TrustedOperationId;
  readonly attempt: number;
  readonly allowedHosts: readonly string[];
}>): Promise<DependencyEgressTlsMaterial> {
  const directory = tlsDirectory(input.credentialHostPath);
  const caKey = join(directory, 'ca.key');
  const caCertificate = join(directory, 'ca.pem');
  await mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    await openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', `/CN=${CA_COMMON_NAME}`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', caKey, '-out', caCertificate,
    ]);
    await chmod(caKey, 0o400);
    await chmod(caCertificate, 0o444);
    for (const host of input.allowedHosts) {
      if (!HOST.test(host)) throw new Error('dependency egress TLS host is invalid');
      const name = leafName(host);
      const key = join(directory, `${name}.key`);
      const csr = join(directory, `${name}.csr`);
      const certificate = join(directory, `${name}.pem`);
      const extensions = join(directory, `${name}.ext`);
      await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host}\n`, { mode: 0o600, flag: 'wx' });
      await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${host}`, '-keyout', key, '-out', csr]);
      await openssl(['x509', '-req', '-sha256', '-days', '2', '-in', csr, '-CA', caCertificate, '-CAkey', caKey, '-CAcreateserial', '-out', certificate, '-extfile', extensions]);
      await chmod(key, 0o400);
      await chmod(certificate, 0o444);
      await rm(csr, { force: false });
      await rm(extensions, { force: false });
    }
    await rm(join(directory, 'ca.srl'), { force: true });
    await rm(caKey, { force: false });
    const material = await inspectDependencyEgressTlsMaterial({ credentialHostPath: input.credentialHostPath, allowedHosts: input.allowedHosts });
    await verifyDependencyEgressTlsMaterial(material, input.allowedHosts);
    return material;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('dependency egress TLS material could not be created', { cause: error });
  }
}

export interface DependencyEgressTlsRemovalFileSystem {
  readonly rm: typeof rm;
  readonly lstat: typeof lstat;
}

const defaultRemovalFileSystem: DependencyEgressTlsRemovalFileSystem = { rm, lstat };

export async function destroyDependencyEgressTlsMaterial(
  material: Pick<DependencyEgressTlsMaterial, 'hostDirectory'>,
  fileSystem: DependencyEgressTlsRemovalFileSystem = defaultRemovalFileSystem,
): Promise<DependencyEgressTlsCleanupProof> {
  if (!isAbsolute(material.hostDirectory) || resolve(material.hostDirectory) !== material.hostDirectory || !TLS_DIRECTORY_NAME.test(basename(material.hostDirectory))) throw new Error('dependency egress TLS directory is not canonical');
  try {
    await fileSystem.rm(material.hostDirectory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('dependency egress TLS directory removal is ambiguous', { cause: error });
  }
  try {
    await fileSystem.lstat(material.hostDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ hostDirectory: material.hostDirectory, absent: true });
    throw new Error('dependency egress TLS directory absence could not be attested', { cause: error });
  }
  throw new Error('dependency egress TLS directory remains after removal');
}

export async function verifyDependencyEgressTlsMaterial(material: DependencyEgressTlsMaterial, allowedHosts: readonly string[]): Promise<void> {
  if (!material.hostDirectory.endsWith('.proxy-tls') || basename(material.hostDirectory).length < 12) throw new Error('dependency egress TLS directory is not canonical');
  const directory = await lstat(material.hostDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('dependency egress TLS directory identity changed');
  exactMetadata(directoryMetadata(directory), material.directoryMetadata, 'dependency egress TLS directory');
  if ((directory.mode & 0o777) !== 0o700) throw new Error('dependency egress TLS directory mode changed');
  const expectedEntries = ['ca.pem', ...allowedHosts.flatMap((host) => [`${leafName(host)}.key`, `${leafName(host)}.pem`])].sort();
  if (JSON.stringify((await readdir(material.hostDirectory)).sort()) !== JSON.stringify(expectedEntries)) throw new Error('dependency egress TLS directory contains signing artifacts or unknown files');
  if (material.caCertificateHostPath !== join(material.hostDirectory, 'ca.pem') || Object.keys(material.leafCertificates).sort().join(',') !== [...allowedHosts].sort().join(',')) throw new Error('dependency egress TLS material identity changed');
  exactMetadata(await fileMetadata(material.caCertificateHostPath), material.caCertificateMetadata, 'dependency egress TLS CA certificate');
  if (material.caCertificateMetadata.mode !== 0o444) throw new Error('dependency egress TLS CA certificate mode changed');
  const caBytes = await readFile(material.caCertificateHostPath);
  const ca = new X509Certificate(caBytes);
  validNow(ca, 'dependency egress TLS CA certificate');
  if (!ca.ca || !ca.verify(ca.publicKey)) throw new Error('dependency egress TLS CA certificate is not a valid self-signed CA');
  for (const host of allowedHosts) {
    const leaf = material.leafCertificates[host];
    const name = leafName(host);
    if (leaf === undefined || leaf.certificateHostPath !== join(material.hostDirectory, `${name}.pem`) || leaf.keyHostPath !== join(material.hostDirectory, `${name}.key`)) throw new Error('dependency egress TLS leaf identity changed');
    exactMetadata(await fileMetadata(leaf.certificateHostPath), leaf.certificateMetadata, `dependency egress TLS leaf certificate ${host}`);
    exactMetadata(await fileMetadata(leaf.keyHostPath), leaf.keyMetadata, `dependency egress TLS leaf key ${host}`);
    if (leaf.certificateMetadata.mode !== 0o444 || leaf.keyMetadata.mode !== 0o400) throw new Error('dependency egress TLS leaf file mode changed');
    const certificate = new X509Certificate(await readFile(leaf.certificateHostPath));
    const key = await readFile(leaf.keyHostPath);
    validNow(certificate, `dependency egress TLS leaf certificate ${host}`);
    if (certificate.ca || certificate.checkHost(host, { subject: 'never' }) !== host) throw new Error(`dependency egress TLS leaf certificate SAN does not match ${host}`);
    if (!certificate.checkIssued(ca) || !certificate.verify(ca.publicKey)) throw new Error(`dependency egress TLS leaf certificate chain is invalid for ${host}`);
    if (!samePublicKey(certificate, key)) throw new Error(`dependency egress TLS leaf private key does not match certificate for ${host}`);
  }
}
