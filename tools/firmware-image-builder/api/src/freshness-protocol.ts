import type { OwnershipResult } from './ownership.js';
import type { FreshnessInput, JobRecord } from './store.js';
import { canonicalInstant, stableRelativePath } from './validation.js';

export const FRESHNESS_SOCKET_BASENAME = 'api.sock';
export const FRESHNESS_PROTOCOL_MAX_BYTES = 4096;

export interface FreshnessSignal {
  readonly schemaVersion: 1;
  readonly kind: 'freshness-request';
  readonly jobId: string;
}

export interface FreshnessSignalAck {
  readonly schemaVersion: 1;
  readonly accepted: true;
}

export interface ApiFreshnessProtocolStore {
  readonly getJob: (jobId: string) => JobRecord;
  readonly request: (jobId: string, at: string) => OwnershipResult;
  readonly result: (
    jobId: string,
    input: FreshnessInput,
    at: string,
  ) => OwnershipResult;
}

export interface ApiFreshnessResolverResult {
  readonly status: 'fresh' | 'advanced' | 'unknown';
  readonly observedSha: string | null;
  readonly checkedAt: string;
  readonly error?: FreshnessInput['error'];
  readonly errorEvidencePath?: string;
  readonly errorEvidenceSha256?: string;
}

export interface ApiFreshnessResolver {
  readonly resolve: (input: {
    readonly branch: string;
    readonly pinnedSha: string;
  }) => Promise<ApiFreshnessResolverResult>;
}

export interface ApiFreshnessErrorEvidenceWriter {
  readonly write: (input: {
    readonly jobId: string;
    readonly checkedAt: string;
    readonly reason: 'resolver-unavailable-or-malformed';
  }) => Promise<{
    readonly error: NonNullable<FreshnessInput['error']>;
    readonly path: string;
    readonly sha256: string;
  }>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

export function encodeFreshnessSignal(jobId: string): Buffer {
  const stableJobId = stableRelativePath(jobId, 'freshness job ID');
  if (stableJobId.includes('/')) throw new Error('freshness job ID must be one segment');
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'freshness-request',
    jobId: stableJobId,
  } satisfies FreshnessSignal)}\n`, 'utf8');
}

export function parseFreshnessSignal(bytes: Uint8Array): FreshnessSignal {
  if (bytes.byteLength === 0 || bytes.byteLength > FRESHNESS_PROTOCOL_MAX_BYTES) {
    throw new Error('freshness signal is empty or too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error('freshness signal is malformed', { cause: error });
  }
  if (!parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !exactKeys(parsed as Record<string, unknown>, ['schemaVersion', 'kind', 'jobId'])) {
    throw new Error('freshness signal shape is invalid');
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || candidate.kind !== 'freshness-request') {
    throw new Error('freshness signal version or kind is invalid');
  }
  const jobId = stableRelativePath(candidate.jobId, 'freshness job ID');
  if (jobId.includes('/')) throw new Error('freshness job ID must be one segment');
  return Object.freeze({ schemaVersion: 1, kind: 'freshness-request', jobId });
}

export function encodeFreshnessAck(): Buffer {
  return Buffer.from('{"schemaVersion":1,"accepted":true}\n', 'utf8');
}

export function parseFreshnessAck(bytes: Uint8Array): FreshnessSignalAck {
  if (bytes.byteLength === 0 || bytes.byteLength > FRESHNESS_PROTOCOL_MAX_BYTES) {
    throw new Error('freshness acknowledgement is empty or too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error('freshness acknowledgement is malformed', { cause: error });
  }
  if (!parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !exactKeys(parsed as Record<string, unknown>, ['schemaVersion', 'accepted'])
    || (parsed as Record<string, unknown>).schemaVersion !== 1
    || (parsed as Record<string, unknown>).accepted !== true) {
    throw new Error('freshness acknowledgement shape is invalid');
  }
  return Object.freeze({ schemaVersion: 1, accepted: true });
}

function requireCommitted(result: OwnershipResult, action: string): void {
  if (!result.ok) throw new Error(`API freshness ${action} write conflicted`);
}

export async function handleApiFreshnessSignal(
  bytes: Uint8Array,
  dependencies: {
    readonly store: ApiFreshnessProtocolStore;
    readonly resolver: ApiFreshnessResolver;
    readonly errorEvidence: ApiFreshnessErrorEvidenceWriter;
    readonly now: () => string;
  },
): Promise<Buffer> {
  const signal = parseFreshnessSignal(bytes);
  let job = dependencies.store.getJob(signal.jobId);
  if (job.freshnessStatus !== null) return encodeFreshnessAck();
  if (job.freshnessRequestedAt === null) {
    const requestedAt = canonicalInstant(dependencies.now(), 'freshness request time');
    requireCommitted(
      dependencies.store.request(signal.jobId, requestedAt),
      'request',
    );
    job = dependencies.store.getJob(signal.jobId);
  }
  try {
    const resolved = await dependencies.resolver.resolve({
      branch: job.branch,
      pinnedSha: job.pinnedSha,
    });
    const checkedAt = canonicalInstant(resolved.checkedAt, 'freshness checked time');
    const input: FreshnessInput = Object.freeze({
      status: resolved.status,
      pinnedSha: job.pinnedSha,
      observedSha: resolved.observedSha,
      checkedAt,
      ...(resolved.error === undefined ? {} : { error: resolved.error }),
      ...(resolved.errorEvidencePath === undefined
        ? {}
        : { errorEvidencePath: resolved.errorEvidencePath }),
      ...(resolved.errorEvidenceSha256 === undefined
        ? {}
        : { errorEvidenceSha256: resolved.errorEvidenceSha256 }),
    });
    const writtenAt = canonicalInstant(dependencies.now(), 'freshness result time');
    requireCommitted(
      dependencies.store.result(signal.jobId, input, writtenAt),
      'result',
    );
  } catch {
    if (dependencies.store.getJob(signal.jobId).freshnessStatus !== null) {
      return encodeFreshnessAck();
    }
    const checkedAt = canonicalInstant(dependencies.now(), 'freshness failure checked time');
    const evidence = await dependencies.errorEvidence.write({
      jobId: signal.jobId,
      checkedAt,
      reason: 'resolver-unavailable-or-malformed',
    });
    const writtenAt = canonicalInstant(dependencies.now(), 'freshness failure result time');
    requireCommitted(
      dependencies.store.result(signal.jobId, Object.freeze({
        status: 'unknown',
        pinnedSha: job.pinnedSha,
        observedSha: null,
        checkedAt,
        error: evidence.error,
        errorEvidencePath: evidence.path,
        errorEvidenceSha256: evidence.sha256,
      }), writtenAt),
      'unknown result',
    );
  }
  return encodeFreshnessAck();
}
