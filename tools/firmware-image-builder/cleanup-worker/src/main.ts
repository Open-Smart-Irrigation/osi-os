import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  ADMISSION_ID_PATTERN,
  createRecoveryFileSystem,
  type RecoveryDescriptorFileSystem,
  type RecoveryDirectoryHandle,
  type RecoveryFileHandle,
  type RecoveryStats,
} from '../../api/src/recovery.js';
import {
  OwnershipStore,
  type CleanupPostcondition,
  type CleanupSnapshot,
  type CleanupStagingPostcondition,
  type LogCleanupProof,
} from '../../api/src/ownership.js';
import { BuilderStore, type JobRecord, type JsonObject } from '../../api/src/store.js';
import { canonicalInstant, encodeJson, parseJson, stableRelativePath, type JsonValue } from '../../api/src/validation.js';
import {
  ACTIVE_RECOVERY_STATES,
  CLEANUP_CREDENTIAL_TOKEN_MAX_CHARS,
  CLEANUP_CREDENTIAL_TOKEN_MIN_CHARS,
  type BuilderErrorCode,
} from '../../domain/types.js';

const HASH64 = /^[0-9a-f]{64}$/u;
const CREDENTIAL_DIRECTORY = 'recovery/cleanup-credentials';
const CREDENTIAL_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const LABEL_JOB = 'org.osi.image-builder.job-id';
const LABEL_MANIFEST = 'org.osi.image-builder.manifest-sha';
const RECOVERY_STATES = new Set<string>([...ACTIVE_RECOVERY_STATES, 'interrupted']);

export const CLEANUP_ADMISSION_ID_PATTERN = ADMISSION_ID_PATTERN;

export interface CleanupDockerContainer {
  readonly id: string;
  readonly name: string;
  readonly imageDigest: string;
  readonly labels: JsonObject;
  readonly running: boolean;
  readonly stoppedAt: string | null;
}

export interface CleanupDocker {
  readonly inspect: (containerId: string, timeoutMs: number) => Promise<CleanupDockerContainer | null>;
  readonly stop: (containerId: string, timeoutMs: number) => Promise<void>;
  readonly waitForStopped: (containerId: string, timeoutMs: number) => Promise<CleanupDockerContainer>;
  readonly remove: (containerId: string, timeoutMs: number) => Promise<void>;
  readonly listByLabels: (labels: JsonObject, timeoutMs: number) => Promise<readonly CleanupDockerContainer[]>;
}

export interface CleanupRunnerObservation {
  readonly unit: string;
  readonly active: boolean;
  readonly observedAt: string;
}

export interface CleanupRunnerSystemd {
  readonly inspect: (unit: string, timeoutMs: number) => Promise<CleanupRunnerObservation>;
}

export interface CleanupLogSeal extends LogCleanupProof {
  readonly contiguous: true;
}

export interface CleanupLogSealer {
  readonly seal: (input: Readonly<{ jobId: string; admissionId: string; at: string; snapshot: CleanupSnapshot }>) => Promise<CleanupLogSeal>;
}

export interface CleanupQuarantineRequest {
  readonly rootId: string;
  readonly jobId: string;
  readonly admittedStaging: CleanupSnapshot['staging'];
  readonly stagingPath: string | null;
  readonly artifactSha256: string | null;
  readonly artifactSize: number | null;
}

export interface CleanupQuarantine {
  /** Wraps the native no-overwrite publisher and proves the held source/destination. */
  readonly quarantine: (input: CleanupQuarantineRequest) => Promise<CleanupStagingPostcondition>;
}

export interface CleanupEvidenceWriter {
  readonly write: (input: Readonly<{ jobId: string; admissionId: string; evidence: JsonObject }>) => Promise<Readonly<{ path: string; sha256: string }>>;
}

export interface CleanupWorkerClock {
  readonly now: () => string;
}

export interface CleanupWorkerTimeouts {
  readonly dockerMs: number;
  readonly systemdMs: number;
}

export interface CleanupWorkerOptions {
  readonly db: DatabaseSync;
  readonly stateRoot: string;
  readonly ownerUid: number;
  readonly workerOwner: string;
  readonly ownership: Pick<OwnershipStore, 'cleanupWrite'>;
  readonly fileSystem?: RecoveryDescriptorFileSystem;
  readonly systemd: CleanupRunnerSystemd;
  readonly docker: CleanupDocker;
  readonly logSealer: CleanupLogSealer;
  readonly quarantine: CleanupQuarantine;
  readonly evidenceWriter: CleanupEvidenceWriter;
  readonly clock: CleanupWorkerClock;
  readonly timeouts: CleanupWorkerTimeouts;
}

export type CleanupWorkerResult =
  | Readonly<{ status: 'completed'; jobId: string; admissionId: string; exactContainerId: string | null }>
  | Readonly<{ status: 'blocked'; jobId: string; admissionId: string; blockerCode: BuilderErrorCode; message: string }>;

export class CleanupWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CleanupWorkerError';
    this.code = code;
  }
}

export function validateCleanupWorkerArgv(argv: readonly string[]): string {
  if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== 'string' || !ADMISSION_ID_PATTERN.test(argv[0])) {
    throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup worker requires exactly one valid admission ID argument');
  }
  return argv[0];
}

class CleanupActionGuardError extends CleanupWorkerError {
  constructor(message: string, options?: ErrorOptions) {
    super('CLEANUP_ADMISSION_BLOCKED', message, options);
    this.name = 'CleanupActionGuardError';
  }
}

type Row = Record<string, unknown>;

interface CredentialLease {
  readonly unlinkAfterClaim: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface PersistedAdmission {
  readonly admissionId: string;
  readonly jobId: string;
  readonly owner: string;
  readonly unitName: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly credentialRelativePath: string;
  readonly credentialSha256: string;
  readonly fenceGeneration: number;
  readonly fenceTokenHash: string;
  readonly snapshot: CleanupSnapshot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function isRecord(value: JsonValue | unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): JsonObject {
  if (!isRecord(value)) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `${field} is not a JSON object`);
  return value;
}

function exactJson(left: unknown, right: unknown): boolean {
  return encodeJson(left, 'observed Docker labels', true)
    === encodeJson(right, 'expected Docker labels', true);
}

function rowString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `persisted ${field} is invalid`);
  return value;
}

function rowNullableString(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `persisted ${field} is invalid`);
  return value;
}

function rowInteger(row: Row, field: string): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `persisted ${field} is invalid`);
  return value;
}

function validateHash(value: string, field: string): string {
  if (!HASH64.test(value)) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `persisted ${field} is invalid`);
  return value;
}

function directoryMode(stats: RecoveryStats): number {
  return stats.mode & 0o7777;
}

function verifyDirectory(stats: RecoveryStats, path: string, ownerUid: number): void {
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== ownerUid || directoryMode(stats) !== DIRECTORY_MODE) {
    throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', `unsafe cleanup credential directory: ${path}`);
  }
}

function verifyCredential(stats: RecoveryStats, path: string, ownerUid: number): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.uid !== ownerUid || directoryMode(stats) !== CREDENTIAL_MODE || stats.nlink !== 1) {
    throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', `unsafe cleanup credential: ${path}`);
  }
}

function safeSegment(value: string, field: string): void {
  if (value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', `${field} is not a safe path segment`);
  }
}

async function closeHandles(handles: readonly RecoveryFileHandle[]): Promise<void> {
  let firstError: unknown;
  for (const handle of handles.slice().reverse()) {
    try { await handle.close(); } catch (error) { firstError ??= error; }
  }
  if (firstError !== undefined) throw firstError;
}

function parseCredential(bytes: Uint8Array): { readonly admissionId: string; readonly generation: number; readonly token: string } {
  if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential size is invalid');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; }
  catch (error) { throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential is corrupt', { cause: error }); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential record is invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'admissionId,generation,token') throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential fields are not exact');
  if (typeof record.admissionId !== 'string' || !ADMISSION_ID_PATTERN.test(record.admissionId)) throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential admission ID is invalid');
  if (!Number.isSafeInteger(record.generation) || Number(record.generation) <= 0) throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential generation is invalid');
  if (typeof record.token !== 'string' || record.token.length < CLEANUP_CREDENTIAL_TOKEN_MIN_CHARS || record.token.length > CLEANUP_CREDENTIAL_TOKEN_MAX_CHARS) throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential token is invalid');
  return { admissionId: record.admissionId, generation: Number(record.generation), token: record.token };
}

function exactLabels(jobId: string, manifestSha: string): JsonObject {
  return { [LABEL_JOB]: jobId, [LABEL_MANIFEST]: manifestSha };
}

function validateDockerIdentity(
  observed: CleanupDockerContainer,
  expected: CleanupSnapshot & { readonly container: Extract<CleanupSnapshot['container'], { kind: 'present' }> },
  jobId: string,
  manifestSha: string,
): void {
  const labels = exactLabels(jobId, manifestSha);
  if (
    observed.id !== expected.container.id
    || observed.name !== expected.container.name
    || observed.imageDigest !== expected.container.imageDigest
    || !exactJson(observed.labels, labels)
  ) {
    throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'Docker container identity or labels do not match the admitted identity');
  }
}

function validateLogSeal(seal: CleanupLogSeal, at: string): LogCleanupProof {
  if (seal.contiguous !== true || !['absent', 'sealed'].includes(seal.runner) || !['absent', 'sealed'].includes(seal.docker)) {
    throw new CleanupWorkerError('RECOVERY_LOG_GAP', 'cleanup log sealer did not provide contiguous sealed evidence');
  }
  const verifiedAt = canonicalInstant(seal.verifiedAt, 'cleanup log verifiedAt');
  if (verifiedAt > at) throw new CleanupWorkerError('RECOVERY_LOG_GAP', 'cleanup log evidence is from the future');
  return { runner: seal.runner, docker: seal.docker, verifiedAt };
}

function validateStagingProof(
  proof: CleanupStagingPostcondition,
  job: JobRecord,
  admitted: CleanupSnapshot['staging'],
  at: string,
): CleanupStagingPostcondition {
  const sourcePath = `staging/${job.jobId}`;
  const destinationPath = `quarantine/${job.jobId}`;
  if (proof.sourcePath !== sourcePath || proof.sourceAbsent !== true) throw new CleanupWorkerError('QUARANTINE_PENDING', 'staging proof does not bind the fixed job staging path');
  if (canonicalInstant(proof.verifiedAt, 'quarantine verifiedAt') > at) throw new CleanupWorkerError('QUARANTINE_PENDING', 'staging quarantine evidence is from the future');
  if (admitted.kind === 'absent') {
    const preparationIntent = job.publishState === 'not_started' && job.artifactStagingPath !== null;
    if (proof.kind !== 'absent' || proof.path !== null || job.artifactStagingPath !== null && !preparationIntent) {
      throw new CleanupWorkerError('QUARANTINE_PENDING', 'staging state differs from the admitted absence');
    }
    return proof;
  }
  if (
    proof.kind !== 'quarantined'
    || proof.destinationPath !== destinationPath
    || proof.destinationPresent !== true
  ) {
    throw new CleanupWorkerError('QUARANTINE_PENDING', 'staging quarantine was not proven');
  }
  if (admitted.kind === 'physical-present') {
    if (admitted.path !== sourcePath || job.artifactStagingPath !== null || proof.sha256 !== null || proof.size !== null) {
      throw new CleanupWorkerError('QUARANTINE_PENDING', 'physical staging quarantine does not match the admitted untracked directory');
    }
    return proof;
  }
  if (proof.sha256 !== job.artifactSha256 || proof.size !== job.artifactSize) {
    throw new CleanupWorkerError('QUARANTINE_PENDING', 'staging quarantine identity does not match the persisted artifact');
  }
  return proof;
}

function validateTimeouts(timeouts: CleanupWorkerTimeouts): void {
  if (!Number.isSafeInteger(timeouts.dockerMs) || timeouts.dockerMs <= 0 || timeouts.dockerMs > 120_000) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup Docker timeout is invalid');
  if (!Number.isSafeInteger(timeouts.systemdMs) || timeouts.systemdMs <= 0 || timeouts.systemdMs > 120_000) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup systemd timeout is invalid');
}

function parseSnapshot(raw: unknown): CleanupSnapshot {
  let parsed: JsonValue;
  try {
    parsed = typeof raw === 'string' ? parseJson(raw, 'cleanup proof', true) : raw as JsonValue;
  } catch (error) {
    throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'persisted cleanup proof is invalid', { cause: error });
  }
  return requireRecord(parsed, 'persisted cleanup proof') as CleanupSnapshot;
}

async function openCredential(
  fileSystem: RecoveryDescriptorFileSystem,
  stateRoot: string,
  jobId: string,
  admission: PersistedAdmission,
  ownerUid: number,
): Promise<CredentialLease> {
  safeSegment(jobId, 'job ID');
  const expectedRelativePath = `${CREDENTIAL_DIRECTORY}/${admission.admissionId}.token`;
  if (admission.credentialRelativePath !== expectedRelativePath) throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential path is not exact');
  const handles: RecoveryFileHandle[] = [];
  let directory: RecoveryDirectoryHandle | null = null;
  try {
    const root = await fileSystem.openDirectory(stateRoot);
    handles.push(root);
    verifyDirectory(await root.stat(), stateRoot, ownerUid);
    const jobs = await root.openDirectoryChild('jobs'); handles.push(jobs); verifyDirectory(await jobs.stat(), `${stateRoot}/jobs`, ownerUid);
    const job = await jobs.openDirectoryChild(jobId); handles.push(job); verifyDirectory(await job.stat(), `${stateRoot}/jobs/${jobId}`, ownerUid);
    const recovery = await job.openDirectoryChild('recovery'); handles.push(recovery); verifyDirectory(await recovery.stat(), `${stateRoot}/jobs/${jobId}/recovery`, ownerUid);
    directory = await recovery.openDirectoryChild('cleanup-credentials'); handles.push(directory); verifyDirectory(await directory.stat(), `${stateRoot}/jobs/${jobId}/${CREDENTIAL_DIRECTORY}`, ownerUid);
    const filename = `${admission.admissionId}.token`;
    const credential = await directory.openFileChild(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      verifyCredential(await credential.stat(), expectedRelativePath, ownerUid);
      const bytes = await credential.readFile();
      const record = parseCredential(bytes);
      const fileSha = createHash('sha256').update(bytes).digest('hex');
      const tokenHash = createHash('sha256').update(record.token).digest('hex');
      if (record.admissionId !== admission.admissionId || record.generation !== admission.fenceGeneration || fileSha !== admission.credentialSha256 || tokenHash !== admission.fenceTokenHash) {
        throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential does not match the committed admission');
      }
    } finally {
      await credential.close();
    }
    return {
      unlinkAfterClaim: async () => {
        await directory!.unlinkChild(filename);
        await directory!.sync();
      },
      close: async () => { await closeHandles(handles); },
    };
  } catch (error) {
    try { await closeHandles(handles); } catch (closeError) { throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential descriptor close failed', { cause: closeError }); }
    if (error instanceof CleanupWorkerError) throw error;
    throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential filesystem operation failed', { cause: error });
  }
}

function parseAdmission(row: Row, admissionId: string): PersistedAdmission {
  if (!ADMISSION_ID_PATTERN.test(admissionId)) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup admission ID is invalid');
  const persistedId = rowString(row, 'admission_id');
  if (persistedId !== admissionId) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup admission ID mismatch');
  const unitName = rowString(row, 'unit_name');
  if (unitName !== `osi-image-builder-cleanup@${admissionId}.service`) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup unit name is not exact');
  const status = rowString(row, 'status');
  if (status !== 'admitted') throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `cleanup admission is not admitted: ${status}`);
  const credentialRelativePath = rowString(row, 'credential_relative_path');
  const expectedPath = `${CREDENTIAL_DIRECTORY}/${admissionId}.token`;
  if (credentialRelativePath !== expectedPath) throw new CleanupWorkerError('CLEANUP_CREDENTIAL_INVALID', 'cleanup credential path is not exact');
  return {
    admissionId,
    jobId: rowString(row, 'job_id'),
    owner: rowString(row, 'owner'),
    unitName,
    expiresAt: canonicalInstant(rowString(row, 'expires_at'), 'cleanup admission expiry'),
    status,
    credentialRelativePath,
    credentialSha256: validateHash(rowString(row, 'credential_sha256'), 'cleanup credential SHA-256'),
    fenceGeneration: rowInteger(row, 'fence_generation'),
    fenceTokenHash: validateHash(rowString(row, 'fence_token_hash'), 'cleanup fence token hash'),
    snapshot: parseSnapshot(row.proof_json),
  };
}

function requireOwnership(result: ReturnType<OwnershipStore['cleanupWrite']>, action: string): void {
  if (!result.ok) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `${action} lost cleanup ownership: ${result.conflict.kind}`);
}

function cleanupBlocker(error: unknown, admissionId: string, jobId: string, at: string, evidence: Readonly<{ path: string | null; sha256: string | null }>): JsonObject {
  const code = error instanceof CleanupWorkerError ? error.code : 'CLEANUP_ADMISSION_BLOCKED';
  return {
    admissionId,
    jobId,
    code,
    message: errorMessage(error),
    observedAt: at,
    evidencePath: evidence.path,
    evidenceSha256: evidence.sha256,
  };
}

function blockerCode(error: unknown): BuilderErrorCode {
  const code = error instanceof CleanupWorkerError ? error.code : 'CLEANUP_ADMISSION_BLOCKED';
  if (code === 'CLEANUP_CREDENTIAL_INVALID' || code === 'RECOVERY_LOG_GAP' || code === 'QUARANTINE_PENDING' || code === 'DOCKER_CONTAINER_ORPHANED' || code === 'CLEANUP_ADMISSION_BLOCKED') return code;
  return 'CLEANUP_ADMISSION_BLOCKED';
}

export function createCleanupWorker(options: CleanupWorkerOptions) {
  const fileSystem = options.fileSystem ?? createRecoveryFileSystem();
  validateTimeouts(options.timeouts);

  function resolveAdmission(admissionId: string): { readonly admission: PersistedAdmission; readonly job: JobRecord } {
    const row = options.db.prepare('SELECT * FROM cleanup_leases WHERE admission_id=?').get(admissionId) as Row | undefined;
    if (!row) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup admission was not found');
    const admission = parseAdmission(row, admissionId);
    if (admission.owner !== options.workerOwner) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup admission owner is not exact');
    const job = new BuilderStore(options.db).getJob(admission.jobId);
    if (!RECOVERY_STATES.has(job.state)) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `job state is not eligible for cleanup: ${job.state}`);
    const fence = options.db.prepare('SELECT cleanup_admission_id, cleanup_fence_generation, cleanup_fence_token_hash FROM jobs WHERE job_id=?').get(admission.jobId) as Row | undefined;
    if (
      !fence
      || rowString(fence, 'cleanup_admission_id') !== admission.admissionId
      || rowInteger(fence, 'cleanup_fence_generation') !== admission.fenceGeneration
      || rowString(fence, 'cleanup_fence_token_hash') !== admission.fenceTokenHash
    ) {
      throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup fence does not match the active job admission');
    }
    if (admission.snapshot.state !== job.state || admission.snapshot.runner.unit !== job.runnerUnit || admission.snapshot.runner.owner !== job.runnerLeaseOwner || admission.snapshot.runner.leaseExpiresAt !== job.runnerLeaseExpiresAt) {
      throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup admission proof does not match the job');
    }
    return { admission, job };
  }

  function assertClaimActive(admission: PersistedAdmission, action: string): string {
    const at = canonicalInstant(options.clock.now(), `${action} time`);
    const row = options.db.prepare(`SELECT
      lease.status AS lease_status, lease.owner AS lease_owner, lease.unit_name AS lease_unit_name,
      lease.expires_at AS lease_expires_at, lease.fence_generation AS lease_fence_generation,
      lease.fence_token_hash AS lease_fence_token_hash,
      jobs.cleanup_admission_id, jobs.cleanup_fence_generation, jobs.cleanup_fence_token_hash
      FROM cleanup_leases AS lease
      JOIN jobs ON jobs.job_id=lease.job_id
      WHERE lease.admission_id=? AND lease.job_id=?`).get(admission.admissionId, admission.jobId) as Row | undefined;
    if (
      !row
      || rowString(row, 'lease_status') !== 'claimed'
      || rowString(row, 'lease_owner') !== options.workerOwner
      || rowString(row, 'lease_unit_name') !== admission.unitName
      || rowInteger(row, 'lease_fence_generation') !== admission.fenceGeneration
      || rowString(row, 'lease_fence_token_hash') !== admission.fenceTokenHash
      || rowString(row, 'cleanup_admission_id') !== admission.admissionId
      || rowInteger(row, 'cleanup_fence_generation') !== admission.fenceGeneration
      || rowString(row, 'cleanup_fence_token_hash') !== admission.fenceTokenHash
    ) {
      throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `cleanup claim is no longer active before ${action}`);
    }
    const expiresAt = canonicalInstant(rowString(row, 'lease_expires_at'), 'cleanup lease expiry');
    if (expiresAt <= at) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `cleanup claim expired before ${action}`);
    return at;
  }

  async function claimedAction<T>(
    admission: PersistedAdmission,
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertClaimActive(admission, action);
    let runner: CleanupRunnerObservation;
    try {
      runner = await options.systemd.inspect(admission.snapshot.runner.unit, options.timeouts.systemdMs);
    } catch (error) {
      throw new CleanupActionGuardError(`runner unit inspection failed before ${action}: ${errorMessage(error)}`, { cause: error });
    }
    const observedAt = canonicalInstant(runner.observedAt, `runner unit observation before ${action}`);
    const upperBound = canonicalInstant(options.clock.now(), `runner unit observation upper bound before ${action}`);
    if (
      runner.unit !== admission.snapshot.runner.unit
      || runner.active
      || observedAt > upperBound
    ) {
      throw new CleanupActionGuardError(`runner unit is not proven inactive before ${action}`);
    }
    assertClaimActive(admission, action);
    return operation();
  }

  async function proveContainer(
    admission: PersistedAdmission,
    job: JobRecord,
  ): Promise<{ readonly post: CleanupPostcondition['container']; readonly exactContainerId: string | null }> {
    try {
      const expectedLabels = exactLabels(job.jobId, job.targetManifestSha256);
      if (admission.snapshot.container.kind === 'absent') {
        if (job.containerId !== null || job.containerName !== null || job.containerImageDigest !== null || job.containerLabelJobId !== null || job.containerLabelManifestSha !== null || job.containerLabels !== null) {
          throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'null-container admission has persisted container identity');
        }
        const matches = await claimedAction(admission, 'Docker label query', () => (
          options.docker.listByLabels(expectedLabels, options.timeouts.dockerMs)
        ));
        if (matches.length !== 0) throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'global Docker label query found a container for a null identity');
        const observedAt = canonicalInstant(options.clock.now(), 'null-container Docker observation time');
        return { exactContainerId: null, post: { kind: 'null-identity', dockerAction: 'none', globalLabelResult: 'no-match', observedAt } };
      }

      const identity = admission.snapshot.container;
      const observed = await claimedAction(admission, 'Docker inspect', () => (
        options.docker.inspect(identity.id, options.timeouts.dockerMs)
      ));
      if (observed === null) {
        const matches = await claimedAction(admission, 'Docker label query', () => (
          options.docker.listByLabels(expectedLabels, options.timeouts.dockerMs)
        ));
        if (matches.length !== 0) throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'exact container is absent but a matching Docker label remains');
        const observedAt = canonicalInstant(options.clock.now(), 'already-absent Docker observation time');
        return {
          exactContainerId: identity.id,
          post: {
            kind: 'already-absent',
            id: identity.id,
            name: identity.name,
            imageDigest: identity.imageDigest,
            labels: identity.labels,
            exactIdAbsent: true,
            dockerAction: 'none',
            globalLabelResult: 'no-match',
            observedAt,
          },
        };
      }
      validateDockerIdentity(observed, { ...admission.snapshot, container: identity }, job.jobId, job.targetManifestSha256);
      let stopped = observed;
      if (observed.running) {
        await claimedAction(admission, 'Docker stop', () => (
          options.docker.stop(identity.id, options.timeouts.dockerMs)
        ));
        stopped = await claimedAction(admission, 'Docker stop wait', () => (
          options.docker.waitForStopped(identity.id, options.timeouts.dockerMs)
        ));
        validateDockerIdentity(stopped, { ...admission.snapshot, container: identity }, job.jobId, job.targetManifestSha256);
      }
      if (stopped.running || stopped.stoppedAt === null) throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'Docker stop did not prove the exact container stopped');
      const stoppedAt = canonicalInstant(stopped.stoppedAt, 'Docker stoppedAt');
      const removalUpperBound = canonicalInstant(options.clock.now(), 'Docker pre-removal time');
      if (stoppedAt > removalUpperBound) throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'Docker stop time is later than the removal request');
      await claimedAction(admission, 'Docker remove', () => (
        options.docker.remove(identity.id, options.timeouts.dockerMs)
      ));
      const removedAt = canonicalInstant(options.clock.now(), 'Docker removal completion time');
      if (stoppedAt > removedAt) throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'Docker stop time is later than the removal completion time');
      const exactAfterRemove = await claimedAction(admission, 'post-remove Docker inspect', () => (
        options.docker.inspect(identity.id, options.timeouts.dockerMs)
      ));
      if (exactAfterRemove !== null) throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'Docker rm did not prove exact container absence');
      const matches = await claimedAction(admission, 'post-remove Docker label query', () => (
        options.docker.listByLabels(expectedLabels, options.timeouts.dockerMs)
      ));
      if (matches.length !== 0) throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', 'global Docker label query found a matching container after removal');
      const observedAt = canonicalInstant(options.clock.now(), 'post-remove Docker observation time');
      return {
        exactContainerId: identity.id,
        post: { kind: 'removed', id: identity.id, name: identity.name, imageDigest: identity.imageDigest, labels: identity.labels, exactIdAbsent: true, globalLabelResult: 'no-match', stoppedAt, removedAt, observedAt },
      };
    } catch (error) {
      if (error instanceof CleanupWorkerError) throw error;
      throw new CleanupWorkerError('DOCKER_CONTAINER_ORPHANED', `Docker cleanup failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  async function sealLogs(admission: PersistedAdmission): Promise<LogCleanupProof> {
    const requestedAt = canonicalInstant(options.clock.now(), 'log sealing request time');
    let seal: CleanupLogSeal;
    try {
      seal = await claimedAction(admission, 'log sealing', () => (
        options.logSealer.seal({ jobId: admission.jobId, admissionId: admission.admissionId, at: requestedAt, snapshot: admission.snapshot })
      ));
    } catch (error) {
      if (error instanceof CleanupWorkerError) throw error;
      throw new CleanupWorkerError('RECOVERY_LOG_GAP', `cleanup log sealing failed: ${errorMessage(error)}`, { cause: error });
    }
    const upperBound = canonicalInstant(options.clock.now(), 'log sealing completion time');
    return validateLogSeal(seal, upperBound);
  }

  async function quarantineStaging(admission: PersistedAdmission, job: JobRecord): Promise<CleanupStagingPostcondition> {
    let proof: CleanupStagingPostcondition;
    try {
      proof = await claimedAction(admission, 'staging quarantine', () => (
        options.quarantine.quarantine({
          rootId: job.rootId,
          jobId: job.jobId,
          admittedStaging: admission.snapshot.staging,
          stagingPath: job.artifactStagingPath,
          artifactSha256: job.artifactSha256,
          artifactSize: job.artifactSize,
        })
      ));
    } catch (error) {
      if (error instanceof CleanupWorkerError) throw error;
      throw new CleanupWorkerError('QUARANTINE_PENDING', `staging quarantine failed: ${errorMessage(error)}`, { cause: error });
    }
    const upperBound = canonicalInstant(options.clock.now(), 'staging quarantine completion time');
    return validateStagingProof(proof, job, admission.snapshot.staging, upperBound);
  }

  async function writeEvidence(admission: PersistedAdmission, evidence: JsonObject): Promise<Readonly<{ path: string; sha256: string }>> {
    const result = await claimedAction(admission, 'cleanup evidence write', () => (
      options.evidenceWriter.write({ jobId: admission.jobId, admissionId: admission.admissionId, evidence })
    ));
    const path = stableRelativePath(result.path, 'cleanup evidence path');
    if (!HASH64.test(result.sha256)) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup evidence SHA-256 is invalid');
    return { path, sha256: result.sha256 };
  }

  async function recordFailure(admission: PersistedAdmission, job: JobRecord, error: unknown, at: string): Promise<CleanupWorkerResult> {
    let evidenceLocation: Readonly<{ path: string | null; sha256: string | null }> = { path: null, sha256: null };
    try {
      const evidence = await writeEvidence(admission, {
        schemaVersion: 1,
        kind: 'cleanup-blocked',
        admissionId: admission.admissionId,
        jobId: job.jobId,
        blockerCode: blockerCode(error),
        message: errorMessage(error),
        observedAt: at,
      });
      evidenceLocation = evidence;
    } catch (evidenceError) {
      evidenceLocation = { path: null, sha256: null };
      error = new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', `${errorMessage(error)}; cleanup evidence writer failed: ${errorMessage(evidenceError)}`, { cause: error });
    }
    const blocker = cleanupBlocker(error, admission.admissionId, job.jobId, at, evidenceLocation);
    const result = await claimedAction(admission, 'cleanup blocker CAS', async () => {
      const writeAt = canonicalInstant(options.clock.now(), 'cleanup blocker write time');
      return options.ownership.cleanupWrite({
        kind: 'evidence',
        jobId: job.jobId,
        admissionId: admission.admissionId,
        owner: options.workerOwner,
        unitName: admission.unitName,
        fenceGeneration: admission.fenceGeneration,
        fenceTokenHash: admission.fenceTokenHash,
        snapshot: admission.snapshot,
        status: 'blocking',
        blockerCode: blockerCode(error),
        blocker,
        at: writeAt,
      });
    });
    requireOwnership(result, 'cleanup blocker evidence');
    return { status: 'blocked', jobId: job.jobId, admissionId: admission.admissionId, blockerCode: blockerCode(error), message: errorMessage(error) };
  }

  async function run(argv: readonly string[]): Promise<CleanupWorkerResult> {
    const admissionId = validateCleanupWorkerArgv(argv);
    const resolved = resolveAdmission(admissionId);
    const at = canonicalInstant(options.clock.now(), 'cleanup worker start time');
    if (resolved.admission.expiresAt <= at) throw new CleanupWorkerError('CLEANUP_ADMISSION_BLOCKED', 'cleanup admission is expired');
    const credential = await openCredential(fileSystem, options.stateRoot, resolved.job.jobId, resolved.admission, options.ownerUid);
    let claimed = false;
    try {
      try {
        const claim = options.ownership.cleanupWrite({
          kind: 'claim-lease',
          jobId: resolved.job.jobId,
          admissionId: resolved.admission.admissionId,
          owner: options.workerOwner,
          unitName: resolved.admission.unitName,
          fenceGeneration: resolved.admission.fenceGeneration,
          fenceTokenHash: resolved.admission.fenceTokenHash,
          snapshot: resolved.admission.snapshot,
          at,
        });
        requireOwnership(claim, 'cleanup claim');
        claimed = true;
        await claimedAction(resolved.admission, 'credential unlink', credential.unlinkAfterClaim);
        const containerProof = await proveContainer(resolved.admission, resolved.job);
        const logs = await sealLogs(resolved.admission);
        const staging = await quarantineStaging(resolved.admission, resolved.job);
        const postcondition: CleanupPostcondition = {
          runner: resolved.admission.snapshot.runner,
          state: resolved.admission.snapshot.state,
          container: containerProof.post,
          staging,
          logs,
          blocker: 'none',
        };
        const completionAt = canonicalInstant(options.clock.now(), 'cleanup completion time');
        const evidence = await writeEvidence(resolved.admission, {
          schemaVersion: 1,
          kind: 'cleanup-complete',
          admissionId: resolved.admission.admissionId,
          jobId: resolved.job.jobId,
          postcondition,
          observedAt: completionAt,
        });
        const complete = await claimedAction(resolved.admission, 'cleanup completion CAS', async () => {
          const writeAt = canonicalInstant(options.clock.now(), 'cleanup completion write time');
          return options.ownership.cleanupWrite({
            kind: 'complete',
            jobId: resolved.job.jobId,
            admissionId: resolved.admission.admissionId,
            owner: options.workerOwner,
            unitName: resolved.admission.unitName,
            fenceGeneration: resolved.admission.fenceGeneration,
            fenceTokenHash: resolved.admission.fenceTokenHash,
            snapshot: resolved.admission.snapshot,
            postcondition,
            exactContainerId: containerProof.exactContainerId,
            containerAbsent: true,
            evidencePath: evidence.path,
            evidenceSha256: evidence.sha256,
            at: writeAt,
          });
        });
        requireOwnership(complete, 'cleanup completion');
        return { status: 'completed', jobId: resolved.job.jobId, admissionId: resolved.admission.admissionId, exactContainerId: containerProof.exactContainerId };
      } catch (error) {
        if (!claimed) throw error;
        if (error instanceof CleanupActionGuardError) throw error;
        return await recordFailure(resolved.admission, resolved.job, error, canonicalInstant(options.clock.now(), 'cleanup blocker time'));
      }
    } finally {
      await credential.close();
    }
  }

  return Object.freeze({ run });
}

export async function runCleanupWorker(argv: readonly string[], options: CleanupWorkerOptions): Promise<CleanupWorkerResult> {
  return createCleanupWorker(options).run(argv);
}
