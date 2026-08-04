import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { TrustedOperationId } from '../../domain/types.js';
import {
  DEPENDENCY_EGRESS_CREDENTIAL_PATH,
  type DependencyEgressCredentialCleanupResult,
  type DependencyEgressCredentialRemnant,
  type DependencyCredentialIdentity,
} from '../../domain/dependency-egress-identity.js';
import { destroyDependencyEgressTlsMaterial } from './dependency-egress-tls.js';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const O_CLOEXEC = 0x80000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0x20000;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0x10000;
const CREDENTIAL_FILENAME = /^(?:build-image|frontend-install)-[1-9][0-9]*\.proxy-credential$/u;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function assertCredentialDirectory(directory: string): Promise<string> {
  const absolute = resolve(directory);
  const metadata = await lstat(absolute);
  const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) {
    throw new Error('dependency egress credential directory is unsafe');
  }
  return absolute;
}

async function openCredentialDirectory(directory: string): Promise<Readonly<{
  absolute: string;
  handle: FileHandle;
  uid: number;
}>> {
  const absolute = await assertCredentialDirectory(directory);
  const expected = await lstat(absolute);
  const handle = await open(absolute, constants.O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY);
  try {
    const observed = await handle.stat();
    const uid = typeof process.getuid === 'function' ? process.getuid() : observed.uid;
    if (!observed.isDirectory() || observed.uid !== uid || (observed.mode & 0o777) !== 0o700 || observed.dev !== expected.dev || observed.ino !== expected.ino) {
      throw new Error('dependency egress credential directory identity changed');
    }
    return { absolute, handle, uid };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function validatePartialCredential(path: string, uid: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o400 || metadata.size >= 48) {
    throw new Error('existing dependency egress credential is not an owned partial file');
  }
  const handle = await open(path, constants.O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  try {
    const observed = await handle.stat();
    const value = await handle.readFile('utf8');
    if (observed.dev !== metadata.dev || observed.ino !== metadata.ino || observed.size !== metadata.size || !/^[A-Za-z0-9_-]{0,47}$/u.test(value)) {
      throw new Error('existing dependency egress credential identity changed');
    }
  } finally {
    await handle.close();
  }
}

async function removePartialCredential(path: string, directory: FileHandle): Promise<void> {
  await unlink(path);
  await directory.sync();
}

function filename(operationId: TrustedOperationId, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('dependency egress credential attempt is invalid');
  return `${operationId}-${String(attempt)}.proxy-credential`;
}

function tlsDirectory(hostPath: string): string {
  if (!isAbsolute(hostPath) || resolve(hostPath) !== hostPath || !CREDENTIAL_FILENAME.test(basename(hostPath))) {
    throw new Error('dependency egress credential path is not canonical');
  }
  return hostPath.slice(0, -'.proxy-credential'.length) + '.proxy-tls';
}

export async function verifyDependencyEgressCredential(identity: DependencyCredentialIdentity): Promise<string> {
  if (identity.containerPath !== DEPENDENCY_EGRESS_CREDENTIAL_PATH || !HASH.test(identity.sha256)) throw new Error('dependency egress credential identity is invalid');
  const metadata = await lstat(identity.hostPath);
  const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== uid || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o400 || metadata.size < 48 || metadata.size > 128) {
    throw new Error('dependency egress credential metadata changed');
  }
  const value = await readFile(identity.hostPath, 'utf8');
  if (!/^[A-Za-z0-9_-]{48,128}$/u.test(value) || sha256(value) !== identity.sha256) throw new Error('dependency egress credential hash changed');
  return value;
}

export async function createDependencyEgressCredential(input: Readonly<{
  readonly directory: string;
  readonly jobId: string;
  readonly operationId: TrustedOperationId;
  readonly attempt: number;
}>): Promise<DependencyCredentialIdentity> {
  if (!JOB_ID.test(input.jobId)) throw new Error('dependency egress credential job ID is invalid');
  const directory = await openCredentialDirectory(input.directory);
  const hostPath = join(directory.absolute, filename(input.operationId, input.attempt));
  const descriptorPath = `/proc/self/fd/${directory.handle.fd}/${filename(input.operationId, input.attempt)}`;
  const value = randomBytes(36).toString('base64url');
  let handle;
  try {
    try {
      handle = await open(descriptorPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0o400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await validatePartialCredential(descriptorPath, directory.uid);
      await destroyDependencyEgressTlsMaterial({ hostDirectory: tlsDirectory(hostPath) });
      await removePartialCredential(descriptorPath, directory.handle);
      handle = await open(descriptorPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0o400);
    }
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await directory.handle.sync();
  } catch (error) {
    throw new Error('dependency egress credential already exists or could not be created', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await directory.handle.close().catch(() => undefined);
  }
  const identity = Object.freeze({ hostPath, containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH, sha256: sha256(value) });
  await verifyDependencyEgressCredential(identity);
  return identity;
}

async function inspectTlsDirectory(path: string, uid: number): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) {
      throw new Error('dependency egress TLS directory is unsafe');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function destroyDependencyEgressCredential(identity: DependencyCredentialIdentity): Promise<DependencyEgressCredentialCleanupResult> {
  tlsDirectory(identity.hostPath);
  const trustedParent = await assertCredentialDirectory(dirname(identity.hostPath));
  if (join(trustedParent, basename(identity.hostPath)) !== identity.hostPath) throw new Error('dependency egress credential path is not canonical');
  const parent = await lstat(trustedParent);
  const uid = typeof process.getuid === 'function' ? process.getuid() : parent.uid;
  const hostDirectory = tlsDirectory(identity.hostPath);
  const tlsPresent = await inspectTlsDirectory(hostDirectory, uid);
  try {
    await verifyDependencyEgressCredential(identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const tls = await destroyDependencyEgressTlsMaterial({ hostDirectory });
    if (tlsPresent) return Object.freeze({ kind: 'tls-only', hostPath: identity.hostPath, expectedSha256: identity.sha256, observedSha256: null, tls, absent: true });
    return Object.freeze({ kind: 'credential-only', hostPath: identity.hostPath, expectedSha256: identity.sha256, observedSha256: null, tls, absent: true });
  }
  try {
    await unlink(identity.hostPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await lstat(identity.hostPath);
    throw new Error('dependency egress credential deletion was not proven');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const tls = await destroyDependencyEgressTlsMaterial({ hostDirectory });
  return Object.freeze({ kind: tlsPresent ? 'normal' : 'credential-only', hostPath: identity.hostPath, expectedSha256: identity.sha256, observedSha256: identity.sha256, tls, absent: true });
}

function remnantOperation(value: string): Readonly<{ readonly operationId: 'frontend-install' | 'build-image'; readonly attempt: number }> {
  const match = /^(frontend-install|build-image)-([1-9][0-9]*)\.proxy-tls$/u.exec(value);
  if (match === null) throw new Error('dependency egress TLS directory name is not canonical');
  const attempt = Number(match[2]);
  if (!Number.isSafeInteger(attempt) || attempt <= 0) throw new Error('dependency egress TLS attempt is invalid');
  return { operationId: match[1] as 'frontend-install' | 'build-image', attempt };
}

export async function discoverDependencyEgressCredentials(directory: string): Promise<readonly DependencyEgressCredentialRemnant[]> {
  const trustedDirectory = await assertCredentialDirectory(directory);
  const entries = await readdir(trustedDirectory, { withFileTypes: true });
  const directoryMetadata = await lstat(trustedDirectory);
  const uid = typeof process.getuid === 'function' ? process.getuid() : directoryMetadata.uid;
  const tlsEntries = new Map<string, string>();
  const credentialEntries = new Map<string, DependencyCredentialIdentity>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.endsWith('.proxy-tls')) {
      if (!entry.isDirectory() || !/^(?:build-image|frontend-install)-[1-9][0-9]*\.proxy-tls$/u.test(entry.name)) throw new Error('dependency egress credential directory contains an untrusted TLS entry');
      const hostDirectory = join(trustedDirectory, entry.name);
      await inspectTlsDirectory(hostDirectory, uid);
      tlsEntries.set(entry.name, hostDirectory);
      continue;
    }
    if (!entry.isFile() || !/^(?:build-image|frontend-install)-[1-9][0-9]*\.proxy-credential$/u.test(entry.name)) throw new Error('dependency egress credential directory contains an untrusted entry');
    const hostPath = join(trustedDirectory, entry.name);
    const value = await readFile(hostPath, 'utf8');
    const identity = Object.freeze({ hostPath, containerPath: DEPENDENCY_EGRESS_CREDENTIAL_PATH, sha256: sha256(value) });
    await verifyDependencyEgressCredential(identity);
    credentialEntries.set(entry.name, identity);
  }
  const remnants: DependencyEgressCredentialRemnant[] = [];
  for (const [name, identity] of credentialEntries) {
    const tlsName = name.slice(0, -'.proxy-credential'.length) + '.proxy-tls';
    const hostDirectory = tlsEntries.get(tlsName);
    remnants.push(Object.freeze({ kind: hostDirectory === undefined ? 'credential-only' : 'normal', identity, hostDirectory: hostDirectory ?? tlsDirectory(identity.hostPath) }));
    tlsEntries.delete(tlsName);
  }
  for (const [name, hostDirectory] of tlsEntries) {
    const parsed = remnantOperation(name);
    remnants.push(Object.freeze({ kind: 'tls-only', ...parsed, credentialHostPath: join(trustedDirectory, `${name.slice(0, -'.proxy-tls'.length)}.proxy-credential`), hostDirectory }));
  }
  remnants.sort((left, right) => (left.kind === 'tls-only' ? left.hostDirectory : left.identity.hostPath).localeCompare(right.kind === 'tls-only' ? right.hostDirectory : right.identity.hostPath));
  return Object.freeze(remnants);
}
