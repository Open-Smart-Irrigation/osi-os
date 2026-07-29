import {
  BUILDER_ERROR_CODES,
  JOB_STATES,
  PIPELINE_STAGE_NAMES,
  TARGET_IDS,
  type PipelineStageName,
} from '../../domain/types.js';
import { encodeBranchSlug } from '../../domain/paths.js';
import type { BuilderConfig } from '../../config/load.js';
import type { HealthSnapshot } from './health.js';
import {
  StoreNotFoundError,
  type BuilderStore,
  type EventPage,
  type EventRecord,
  type JobRecord,
  type StoredStage,
} from './store.js';
import {
  boundedText,
  canonicalAbsolutePath,
  canonicalInstant,
  encodeJson,
  JSON_LIMITS,
  optionalInstant,
  sourceMetadataSubject,
  stableRelativePath,
} from './validation.js';
import type { EvidenceIndex, IndexedEvidenceReader } from './evidence-reader.js';
import { decodeStoredStageEvidence, type EvidenceCommand } from '../../runner/src/evidence.js';
import { validateRemoteBranchName } from './git/source-resolver.js';
import {
  HttpTransportError,
  type ApiRouteContext,
  type ApiRouteHandler,
  type HttpResponse,
  jsonResponse,
} from './server.js';

const DEFAULT_JOB_LIMIT = 50;
const MAX_JOB_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const MAX_BRANCHES = 1_000;
const MAX_CURSOR_BYTES = 512;
const MAX_JOB_ID_BYTES = 128;
const MAX_CONFIG_ITEMS = 256;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RUNNER_UNIT_PATTERN = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const HASH40_PATTERN = /^[0-9a-f]{40}$/u;
const HASH64_PATTERN = /^[0-9a-f]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const PRIVATE_KEY_PATTERN = /(?:-----BEGIN [^-\r\n]*PRIVATE KEY-----|----+\s*BEGIN [^\r\n]*PRIVATE KEY\s*----+|(?:^|\r?\n)\s*PuTTY-User-Key-File-\d+\s*:|(?:^|\r?\n)\s*(?:SSH|RSA|EC|DSA)\s+PRIVATE KEY\s*[:=-])/imu;
const QUOTED_CREDENTIAL_PATTERN = /(["'])\s*[a-z0-9_.-]*(?:token|password|passwd|secret|credential|cookie|private[_-]?key|ssh[_-]?auth[_-]?sock|git[_-]?ssh[_-]?command|ssh[_-]?path|api[_-]?key|ssh[_-]?key|identity[_-]?file|client[_-]?secret|passphrase|auth[a-z0-9_.-]*|oauth[a-z0-9_.-]*|access[_-]?key[a-z0-9_.-]*|session[_-]?key[a-z0-9_.-]*)[a-z0-9_.-]*\1\s*:\s*(["'])[\s\S]*?\2/iu;
const SENSITIVE_OBSERVATION_KEY_PARTS = Object.freeze([
  'token', 'password', 'passwd', 'secret', 'credential', 'privatekey', 'authorization', 'cookie',
  'sshauthsock', 'gitsshcommand', 'sshpath', 'apikey', 'sshkey', 'identityfile', 'clientsecret',
  'passphrase', 'auth', 'oauth', 'accesskey', 'sessionkey',
]);
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:^|[^a-z0-9_])(?:[a-z0-9_.-]*(?:token|password|passwd|secret|credential|cookie|private[_-]?key|ssh[_-]?auth[_-]?sock|git[_-]?ssh[_-]?command|ssh[_-]?path|api[_-]?key|ssh[_-]?key|identity[_-]?file|client[_-]?secret|passphrase|auth[a-z0-9_.-]*|oauth[a-z0-9_.-]*|access[_-]?key[a-z0-9_.-]*|session[_-]?key[a-z0-9_.-]*)[a-z0-9_.-]*)\s*(?:=|:)\s*[^\s;,?&]+/iu;
const AUTHORIZATION_HEADER_PATTERN = /\b(?:authorization)\s*[:=]\s*\S+/iu;
const COMPLETE_BARE_AUTHORIZATION_PATTERN = /^(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+$/iu;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]*/giu;
const ABSOLUTE_POSIX_PATH_PATTERN = /(?:^|[^a-z0-9._~\/-])\/+[^\s/]+(?:\/[^\s/]+)*/iu;
const PUBLIC_EVIDENCE_EXECUTABLES = new Set([
  '/usr/bin/git', '/usr/bin/docker', '/usr/bin/node', '/usr/bin/npm', '/usr/bin/sqlite3', '/usr/bin/systemctl',
  '/usr/bin/make', '/usr/bin/gcc', '/usr/bin/llvm-config', '/usr/bin/rustc', '/bin/sh',
]);
const COMMAND_HOME_PATH_PATTERN = /(?:^|[^a-z0-9._-])(?:~(?:[a-z0-9._-]+)?|\$\{?home\}?)(?:\/|$)/iu;
const COMMAND_CREDENTIAL_ASSIGNMENT_PATTERN = /(?:^|[^a-z0-9_])(?:--?)?[a-z0-9_.-]*(?:token|password|passwd|secret|credential|cookie|private[_-]?key|ssh[_-]?auth[_-]?sock|git[_-]?ssh[_-]?command|ssh[_-]?path|api[_-]?key|ssh[_-]?key|identity[_-]?file|client[_-]?secret|passphrase|auth[a-z0-9_.-]*|oauth[a-z0-9_.-]*|access[_-]?key[a-z0-9_.-]*|session[_-]?key[a-z0-9_.-]*)[a-z0-9_.-]*\s*(?:=|:)\s*[^\s;,?&]+/iu;
const SENSITIVE_COMMAND_OPTION_PATTERN = /^--?[a-z0-9_.-]*(?:token|password|passwd|secret|credential|cookie|private[_-]?key|ssh[_-]?auth[_-]?sock|git[_-]?ssh[_-]?command|ssh[_-]?path|api[_-]?key|ssh[_-]?key|identity[_-]?file|client[_-]?secret|passphrase|auth[a-z0-9_.-]*|oauth[a-z0-9_.-]*|access[_-]?key[a-z0-9_.-]*|session[_-]?key[a-z0-9_.-]*)[a-z0-9_.-]*$/iu;
const JOB_STATE_SET = new Set<string>(JOB_STATES);
const STAGE_SET = new Set<string>(PIPELINE_STAGE_NAMES);
const ERROR_CODE_SET = new Set<string>(BUILDER_ERROR_CODES);
const PUBLIC_EVIDENCE_INPUT_KEYS = new Set(['targetId', 'rootId', 'branch', 'pinnedSha']);
const PUBLIC_DETAIL_KEYS = new Set([
  'availableBytes',
  'expectedSha',
  'field',
  'observedSha',
  'operationId',
  'outputRootId',
  'requiredBytes',
  'signal',
  'targetId',
  'timeoutSeconds',
]);
const PUBLIC_EVENT_KEYS = new Set([
  'code',
  'generation',
  'jobId',
  'length',
  'newerSourceAvailable',
  'observedSha',
  'offset',
  'operationId',
  'outcome',
  'partial',
  'sourceSeq',
  'stream',
  'truncated',
]);

type JsonRecord = Record<string, unknown>;
type ConfigSymbol =
  | Readonly<{ readonly name: string; readonly type: 'bool'; readonly value: boolean }>
  | Readonly<{ readonly name: string; readonly type: 'string'; readonly value: string }>
  | Readonly<{ readonly name: string; readonly type: 'number'; readonly value: number }>;

export interface JobPage {
  readonly jobs: readonly JobRecord[];
  readonly nextCursor: string | null;
}

export interface ApiJobStore extends Pick<BuilderStore, 'getJob' | 'getStage' | 'listEvents'> {
  readonly listJobs: (options: { readonly cursor: string | null; readonly limit: number }) => JobPage | Promise<JobPage>;
}

export interface ApiTargetConfig {
  readonly id: string;
  readonly label: string;
  readonly environment: string;
  readonly openwrtTarget: string;
  readonly profile: string;
  readonly rootfs: string;
  readonly artifactGlob: string;
  readonly rootfsPartSize: number;
  readonly minimumArtifactBytes: number;
  readonly configSymbols: readonly ConfigSymbol[];
  readonly operations: readonly string[];
}

export interface BranchResolver {
  readonly listBranches: () => unknown | Promise<unknown>;
}

export interface ApiRouteDependencies {
  readonly version: string;
  readonly config: BuilderConfig;
  readonly targets: readonly ApiTargetConfig[];
  readonly health: () => Pick<HealthSnapshot, 'activeJobId'> | HealthSnapshot | Promise<Pick<HealthSnapshot, 'activeJobId'> | HealthSnapshot>;
  readonly branches: BranchResolver['listBranches'];
  readonly store: ApiJobStore;
  readonly evidenceReader: IndexedEvidenceReader;
}

function badRequest(message: string): never {
  throw new HttpTransportError({ code: 'INVALID_REQUEST', status: 400, details: { field: message } });
}

function notFound(): never {
  throw new HttpTransportError({ code: 'NOT_FOUND', status: 404 });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxBytes: number): string {
  const result = boundedText(value, field, maxBytes);
  if (CONTROL_PATTERN.test(result)) throw new Error(`${field} contains a control character`);
  return result;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 256);
  if (!IDENTIFIER_PATTERN.test(result)) throw new Error(`${field} is not an identifier`);
  return result;
}

function nullableInstant(value: unknown, field: string): string | null {
  return optionalInstant(value, field);
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${field} is not a safe integer`);
  return Number(value);
}

function validateJobId(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_JOB_ID_BYTES || !JOB_ID_PATTERN.test(value)) badRequest('job id');
  return value;
}

function storedJobId(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_JOB_ID_BYTES || !JOB_ID_PATTERN.test(value)) {
    throw new Error('stored job ID is invalid');
  }
  return value;
}

function validateStage(value: string): PipelineStageName {
  if (!STAGE_SET.has(value)) badRequest('stage');
  return value as PipelineStageName;
}

function storedStage(value: unknown, field: string): PipelineStageName | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !STAGE_SET.has(value)) throw new Error(`${field} is invalid`);
  return value as PipelineStageName;
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_JOB_LIMIT;
  if (!/^\d+$/u.test(value)) badRequest('limit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_JOB_LIMIT) badRequest('limit');
  return limit;
}

function parseCursor(value: string | null): string | null {
  if (value === null) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES || !OPAQUE_CURSOR_PATTERN.test(value)) badRequest('cursor');
  return value;
}

function parseAfter(value: string | null): number {
  if (value === null) return -1;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) badRequest('after');
  const after = Number(value);
  if (!Number.isSafeInteger(after)) badRequest('after');
  return after;
}

function branchName(value: unknown, field: string): string {
  try {
    return validateRemoteBranchName(value);
  } catch {
    throw new Error(`${field} is not a canonical branch name`);
  }
}

function nullableQueuePosition(value: unknown): number | null {
  return value === null ? null : safeInteger(value, 'job queue position');
}

function nullableHash64(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !HASH64_PATTERN.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function publicDetails(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: JsonRecord = {};
  for (const key of PUBLIC_DETAIL_KEYS) {
    const item = input[key];
    if (item === undefined) continue;
    if (key === 'expectedSha' || key === 'observedSha') {
      if (typeof item === 'string' && HASH40_PATTERN.test(item)) output[key] = item;
    } else if (key === 'availableBytes' || key === 'requiredBytes' || key === 'timeoutSeconds') {
      if (Number.isSafeInteger(item) && Number(item) >= 0) output[key] = item;
    } else if (typeof item === 'string' && IDENTIFIER_PATTERN.test(item)) {
      output[key] = item;
    }
  }
  return output;
}

function publicError(code: unknown, details: unknown, at?: unknown): JsonRecord | null {
  if (code === null || code === undefined) return null;
  const publicCode = identifier(code, 'job error code');
  if (!ERROR_CODE_SET.has(publicCode)) throw new Error('stored job error code is invalid');
  const result: JsonRecord = { code: publicCode, details: publicDetails(details) };
  if (at !== undefined && at !== null) result.at = canonicalInstant(at, 'job error time');
  return result;
}

function nullableErrorCode(value: unknown, field: string): string | null {
  if (value === null) return null;
  const result = identifier(value, field);
  if (!ERROR_CODE_SET.has(result)) throw new Error(`${field} is invalid`);
  return result;
}

function summary(job: JobRecord): JsonRecord {
  const state = identifier(job.state, 'job state');
  if (!JOB_STATE_SET.has(state)) throw new Error('stored job state is invalid');
  return {
    id: storedJobId(job.jobId),
    state,
    branch: branchName(job.branch, 'job branch'),
    targetId: identifier(job.targetId, 'job target ID'),
    outputRootId: identifier(job.rootId, 'job output root ID'),
    acceptedAt: canonicalInstant(job.acceptedAt, 'job acceptedAt'),
    currentStage: storedStage(job.currentStage, 'job current stage'),
    queuePosition: nullableQueuePosition(job.queuePosition),
    terminalAt: nullableInstant(job.terminalAt, 'job terminalAt'),
  };
}

function canonicalStageEvidencePath(jobId: string, stage: PipelineStageName, value: unknown): string {
  if (typeof value !== 'string') throw new Error('stage evidence path is invalid');
  const path = stableRelativePath(value, 'stage evidence path');
  const expectedPath = `jobs/${jobId}/evidence/${String(PIPELINE_STAGE_NAMES.indexOf(stage)).padStart(2, '0')}-${stage}.json`;
  if (path !== expectedPath) throw new Error('stage evidence path does not match the fixed stage index');
  return path;
}

function evidencePath(stage: StoredStage): string | null {
  if (stage.evidencePath === null) return null;
  const jobId = storedJobId(stage.jobId);
  const stageName = storedStage(stage.stage, 'stage name');
  if (stageName === null) throw new Error('stage name is invalid');
  const value = canonicalStageEvidencePath(jobId, stageName, stage.evidencePath);
  return `evidence/${value.slice(`jobs/${jobId}/evidence/`.length)}`;
}

function indexedEvidenceIndex(value: unknown, expectedJobId: string, expectedStage: PipelineStageName): EvidenceIndex | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('stored stage is not a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) throw new Error('stored stage has a symbol property');
  const fields = ['jobId', 'stage', 'evidencePath', 'evidenceSha256'] as const;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !('value' in descriptor)) throw new Error(`stored stage ${field} is not a data property`);
  }

  const jobId = storedJobId(descriptors.jobId.value);
  const stage = storedStage(descriptors.stage.value, 'stage name');
  if (stage === null || jobId !== expectedJobId || stage !== expectedStage) throw new Error('stage identity does not match the requested evidence');
  const evidencePath = descriptors.evidencePath.value;
  const evidenceSha256 = descriptors.evidenceSha256.value;
  if (evidencePath !== null && typeof evidencePath !== 'string') throw new Error('stage evidence path is invalid');
  if (evidenceSha256 !== null && typeof evidenceSha256 !== 'string') throw new Error('stage evidence SHA is invalid');
  if (evidencePath === null || evidenceSha256 === null) return null;
  const path = canonicalStageEvidencePath(jobId, stage, evidencePath);
  const sha256 = nullableHash64(evidenceSha256, 'stage evidence SHA');
  if (sha256 === null) throw new Error('stage evidence SHA is invalid');
  return Object.freeze({ jobId, stage, path, sha256 });
}

function stageDto(stage: StoredStage, expectedJobId: string, expectedStage: PipelineStageName): JsonRecord {
  if (storedJobId(stage.jobId) !== expectedJobId) throw new Error('stage belongs to another job');
  if (storedStage(stage.stage, 'stage name') !== expectedStage) throw new Error('stage does not match the requested stage');
  return {
    stage: storedStage(stage.stage, 'stage name'),
    outcome: stage.outcome === null ? null : identifier(stage.outcome, 'stage outcome'),
    startedAt: nullableInstant(stage.startedAt, 'stage startedAt'),
    finishedAt: nullableInstant(stage.finishedAt, 'stage finishedAt'),
    path: evidencePath(stage),
    evidenceSha256: nullableHash64(stage.evidenceSha256, 'stage evidence SHA'),
    errorCode: nullableErrorCode(stage.errorCode, 'stage error code'),
  };
}

function selectedJobError(job: JobRecord): JsonRecord | null {
  return publicError(job.terminalErrorCode, job.terminalError, job.terminalAt)
    ?? publicError(job.publishBlockerCode, job.publishBlocker)
    ?? publicError(job.cleanupBlockerCode, job.cleanupBlocker);
}

async function detail(job: JobRecord, store: ApiJobStore): Promise<JsonRecord> {
  const base = summary(job);
  const jobId = base.id as string;
  const branch = branchName(job.branch, 'job branch');
  const sourceRef = text(job.sourceRef, 'source ref', 512);
  if (sourceRef !== `refs/remotes/origin/${branch}`) throw new Error('source ref does not match the stored origin branch');
  const stages = await Promise.all(PIPELINE_STAGE_NAMES.map(async (requestedStage) => {
    const stored = await store.getStage(jobId, requestedStage);
    return stored === null ? null : { requestedStage, stored };
  }));
  const artifactSha256 = nullableHash64(job.artifactSha256, 'artifact SHA');
  const artifact = artifactSha256 === null ? null : (() => {
    const directory = stableRelativePath(job.artifactFinalDirectory, 'artifact final directory');
    const path = stableRelativePath(job.artifactFinalPath, 'artifact final path');
    const targetId = identifier(job.targetId, 'artifact target ID');
    if (!(TARGET_IDS as readonly string[]).includes(targetId)) throw new Error('artifact target ID is invalid');
    const expectedDirectory = `${encodeBranchSlug(branch)}/${job.pinnedSha}/${targetId}`;
    if (directory !== expectedDirectory) throw new Error('artifact final directory is not the deterministic release directory');
    if (!path.startsWith(`${directory}/`)) throw new Error('artifact final path is outside its release directory');
    return {
      rootId: identifier(job.rootId, 'artifact output root ID'),
      directory,
      path,
      sha256: artifactSha256,
      size: safeInteger(job.artifactSize, 'artifact size'),
      mtime: canonicalInstant(job.artifactMtime, 'artifact mtime'),
      publishState: job.publishState === null ? null : identifier(job.publishState, 'publish state'),
      publishedAt: nullableInstant(job.publishedAt, 'publishedAt'),
    };
  })();
  const freshnessStatus = job.freshnessStatus === null ? 'unknown' : identifier(job.freshnessStatus, 'freshness status');
  if (!['fresh', 'advanced', 'unknown'].includes(freshnessStatus)) throw new Error('stored freshness status is invalid');

  return {
    ...base,
    stage: base.currentStage,
    pinnedSha: HASH40_PATTERN.test(job.pinnedSha) ? job.pinnedSha : (() => { throw new Error('pinned SHA is invalid'); })(),
    cancelRequestedAt: nullableInstant(job.cancelRequestedAt, 'cancel requestedAt'),
    artifact,
    freshnessStatus,
    freshnessCheckedAt: nullableInstant(job.freshnessCheckedAt, 'freshness checkedAt'),
    newerSourceAvailable: job.newerSourceAvailable === true,
    error: selectedJobError(job),
    source: {
      branch,
      sourceRef,
      expectedSha: HASH40_PATTERN.test(job.expectedSha) ? job.expectedSha : (() => { throw new Error('expected SHA is invalid'); })(),
      pinnedSha: job.pinnedSha,
      commitTime: canonicalInstant(job.sourceCommitTime, 'source commit time'),
      author: text(job.sourceAuthor, 'source author', 1_024),
      subject: sourceMetadataSubject(job.sourceSubject, 'source subject'),
    },
    output: artifact,
    errors: {
      terminal: publicError(job.terminalErrorCode, job.terminalError, job.terminalAt),
      publish: publicError(job.publishBlockerCode, job.publishBlocker),
      cleanup: publicError(job.cleanupBlockerCode, job.cleanupBlocker),
      freshness: publicError(job.freshnessErrorCode, job.freshnessError),
    },
    cancellation: {
      requestedAt: nullableInstant(job.cancelRequestedAt, 'cancellation requestedAt'),
      cooperativeDeadlineAt: nullableInstant(job.cancellationCooperativeDeadlineAt, 'cancellation cooperative deadline'),
      graceDeadlineAt: nullableInstant(job.cancellationGraceDeadlineAt, 'cancellation grace deadline'),
    },
    runtime: {
      runnerUnit: job.runnerUnit === null ? null : RUNNER_UNIT_PATTERN.test(job.runnerUnit)
        ? job.runnerUnit
        : (() => { throw new Error('runner unit is invalid'); })(),
      dispatchedAt: nullableInstant(job.dispatchedAt, 'dispatchedAt'),
      cleanupOutcome: job.containerCleanupOutcome === null ? null : identifier(job.containerCleanupOutcome, 'cleanup outcome'),
    },
    evidence: stages.filter((entry): entry is { readonly requestedStage: PipelineStageName; readonly stored: StoredStage } => entry !== null)
      .map(({ requestedStage, stored }) => stageDto(stored, jobId, requestedStage)),
  };
}

function publicEventData(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: JsonRecord = {};
  for (const key of PUBLIC_EVENT_KEYS) {
    const item = input[key];
    if (item === undefined) continue;
    if (key === 'observedSha') {
      if (typeof item === 'string' && HASH40_PATTERN.test(item)) output[key] = item;
    } else if (['generation', 'length', 'offset', 'sourceSeq'].includes(key)) {
      if (Number.isSafeInteger(item) && Number(item) >= 0) output[key] = item;
    } else if (['newerSourceAvailable', 'partial', 'truncated'].includes(key)) {
      if (typeof item === 'boolean') output[key] = item;
    } else if (typeof item === 'string' && IDENTIFIER_PATTERN.test(item)) {
      output[key] = item;
    }
  }
  return output;
}

function eventDto(event: EventRecord, expectedJobId: string): JsonRecord {
  if (storedJobId(event.jobId) !== expectedJobId) throw new Error('event belongs to another job');
  const state = event.state === null ? null : identifier(event.state, 'event state');
  if (state !== null && !JOB_STATE_SET.has(state)) throw new Error('event state is invalid');
  return {
    seq: safeInteger(event.seq, 'event sequence'),
    event: identifier(event.eventType, 'event type'),
    state,
    stage: storedStage(event.stage, 'event stage'),
    at: canonicalInstant(event.at, 'event time'),
    data: publicEventData(event.payload),
  };
}

function configSymbolDto(value: ConfigSymbol): JsonRecord {
  const name = identifier(value.name, 'config symbol name');
  if (!name.startsWith('CONFIG_')) throw new Error('config symbol name is invalid');
  if (value.type === 'bool' && typeof value.value === 'boolean') return { name, type: value.type, value: value.value };
  if (value.type === 'string' && typeof value.value === 'string') return { name, type: value.type, value: text(value.value, 'config symbol value', 1_024) };
  if (value.type === 'number' && Number.isSafeInteger(value.value)) return { name, type: value.type, value: value.value };
  throw new Error('config symbol is invalid');
}

function targetDto(target: ApiTargetConfig): JsonRecord {
  if (target.configSymbols.length > MAX_CONFIG_ITEMS || target.operations.length > MAX_CONFIG_ITEMS) throw new Error('target configuration is unbounded');
  return {
    id: identifier(target.id, 'target ID'),
    label: text(target.label, 'target label', 256),
    environment: identifier(target.environment, 'target environment'),
    openwrtTarget: stableRelativePath(target.openwrtTarget, 'OpenWrt target'),
    profile: identifier(target.profile, 'target profile'),
    rootfs: stableRelativePath(target.rootfs, 'target rootfs'),
    artifactGlob: text(target.artifactGlob, 'target artifact glob', 1_024),
    rootfsPartSize: safeInteger(target.rootfsPartSize, 'rootfs partition size', 1),
    minimumArtifactBytes: safeInteger(target.minimumArtifactBytes, 'minimum artifact bytes', 1),
    configSymbols: target.configSymbols.map(configSymbolDto),
    operations: target.operations.map((operation) => identifier(operation, 'target operation')),
  };
}

function configDto(config: BuilderConfig, targets: readonly ApiTargetConfig[]): JsonRecord {
  if (targets.length === 0 || targets.length > 64) throw new Error('target list is invalid');
  const targetDtos = targets.map(targetDto);
  if (new Set(targetDtos.map((target) => target.id)).size !== targetDtos.length) throw new Error('target IDs are duplicated');
  return {
    repository: {
      path: canonicalAbsolutePath(config.repository.path, 'repository path'),
      remote: config.repository.remote === 'origin' ? 'origin' : (() => { throw new Error('repository remote is invalid'); })(),
    },
    approvedOutputRoots: config.approvedOutputRoots.map(({ id, label, path }) => ({
      id: identifier(id, 'output root ID'),
      label: text(label, 'output root label', 256),
      path: canonicalAbsolutePath(path, 'output root path'),
    })),
    targets: targetDtos,
  };
}

function branchesDto(value: unknown): JsonRecord {
  const input = record(value, 'branch resolver result');
  if (!Array.isArray(input.branches) || input.branches.length > MAX_BRANCHES) throw new Error('branch resolver returned invalid data');
  const branches = input.branches.map((branch, index) => {
    const item = record(branch, `branch ${index}`);
    if (typeof item.sha !== 'string' || !HASH40_PATTERN.test(item.sha)) throw new Error('branch resolver returned an invalid SHA');
    return {
      name: branchName(item.name, `branch ${index} name`),
      sha: item.sha,
      commitTime: canonicalInstant(item.commitTime, `branch ${index} commit time`),
      subject: sourceMetadataSubject(item.subject, `branch ${index} subject`),
    };
  });
  return { fetchedAt: canonicalInstant(input.fetchedAt, 'branches fetchedAt'), branches };
}

function jobPageDto(value: unknown, limit: number, currentCursor: string | null): JsonRecord {
  const page = record(value, 'job page');
  if (!Array.isArray(page.jobs) || page.jobs.length > limit) throw new Error('store returned an invalid job page');
  if (page.nextCursor !== null && (typeof page.nextCursor !== 'string'
    || Buffer.byteLength(page.nextCursor, 'utf8') > MAX_CURSOR_BYTES
    || !OPAQUE_CURSOR_PATTERN.test(page.nextCursor)
    || page.nextCursor === currentCursor)) {
    throw new Error('store returned an invalid opaque cursor');
  }
  return { jobs: page.jobs.map((job) => summary(job as JobRecord)), nextCursor: page.nextCursor };
}

function eventPageDto(page: EventPage, jobId: string, after: number): JsonRecord {
  if (!page || !Array.isArray(page.events) || page.events.length > MAX_EVENT_LIMIT) throw new Error('store returned an invalid event page');
  const events = page.events.map((event) => eventDto(event, jobId));
  let previous = after;
  for (const event of events) {
    const seq = event.seq as number;
    if (seq <= previous) throw new Error('store returned a non-monotonic event page');
    previous = seq;
  }
  if (page.nextAfterSeq !== null
    && (!Number.isSafeInteger(page.nextAfterSeq) || page.nextAfterSeq !== (events.at(-1)?.seq ?? null))) {
    throw new Error('store returned an invalid event cursor');
  }
  return { events, next: page.nextAfterSeq ?? events.at(-1)?.seq ?? after };
}

function publicEvidenceInputs(value: unknown, job: JobRecord, dependencies: ApiRouteDependencies): JsonRecord {
  const input = record(value, 'evidence inputs');
  const keys = Object.keys(input);
  if (keys.length !== PUBLIC_EVIDENCE_INPUT_KEYS.size || keys.some((key) => !PUBLIC_EVIDENCE_INPUT_KEYS.has(key))) {
    throw new Error('evidence inputs have an invalid public shape');
  }
  const targetId = identifier(input.targetId, 'evidence target ID');
  if (!dependencies.targets.some((target) => target.id === targetId)) throw new Error('evidence target ID is not configured');
  const rootId = identifier(input.rootId, 'evidence root ID');
  if (!dependencies.config.approvedOutputRoots.some((root) => root.id === rootId)) throw new Error('evidence root ID is not configured');
  let branch: string;
  try {
    branch = validateRemoteBranchName(input.branch);
  } catch {
    throw new Error('evidence branch is not a canonical branch name');
  }
  if (typeof input.pinnedSha !== 'string' || !HASH40_PATTERN.test(input.pinnedSha)) {
    throw new Error('evidence pinned SHA is invalid');
  }
  if (targetId !== job.targetId || rootId !== job.rootId || branch !== job.branch || input.pinnedSha !== job.pinnedSha) {
    throw new Error('evidence inputs do not match the owning job');
  }
  return { targetId, rootId, branch, pinnedSha: input.pinnedSha };
}

function normalizedObservationKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function isSensitiveObservationKey(key: string): boolean {
  const normalized = normalizedObservationKey(key);
  return SENSITIVE_OBSERVATION_KEY_PARTS.some((part) => part === 'auth'
    ? normalized.startsWith(part)
    : normalized.includes(part));
}

interface ObservationProjectionBudget {
  nodes: number;
  edges: number;
}

function matchingJsonContainerEnd(value: string, start: number, limit: number): number | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < limit; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const opening = stack.pop();
      if ((character === '}' && opening !== '{') || (character === ']' && opening !== '[')) return null;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

function hasSensitiveJsonKey(value: unknown, field: string, depth: number, budget: ObservationProjectionBudget): boolean {
  budget.nodes += 1;
  if (budget.nodes > JSON_LIMITS.maxNodes || depth > JSON_LIMITS.maxDepth) return true;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return false;
  if (Array.isArray(value)) {
    if (value.length > JSON_LIMITS.maxArrayElements) return true;
    for (let index = 0; index < value.length; index += 1) {
      budget.edges += 1;
      if (budget.edges > JSON_LIMITS.maxEdges || hasSensitiveJsonKey(value[index], `${field}[${index}]`, depth + 1, budget)) return true;
    }
    return false;
  }
  if (typeof value !== 'object') return true;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length > JSON_LIMITS.maxKeys) return true;
  for (const key of keys) {
    if (isSensitiveObservationKey(key)) return true;
    budget.edges += 1;
    if (budget.edges > JSON_LIMITS.maxEdges || hasSensitiveJsonKey(input[key], `${field}.${key}`, depth + 1, budget)) return true;
  }
  return false;
}

function hasStructuredJsonCredential(value: string): boolean {
  const limit = Math.min(value.length, JSON_LIMITS.maxEncodedBytes);
  for (let start = 0; start < limit; start += 1) {
    if (value[start] !== '{' && value[start] !== '[') continue;
    const end = matchingJsonContainerEnd(value, start, limit);
    if (end === null) continue;
    const candidate = value.slice(start, end);
    if (Buffer.byteLength(candidate, 'utf8') > JSON_LIMITS.maxEncodedBytes) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (hasSensitiveJsonKey(parsed, 'public text JSON', 0, { nodes: 0, edges: 0 })) return true;
      start = end - 1;
    } catch {
      continue;
    }
  }
  return false;
}

function hasCredentialUrl(value: string): boolean {
  for (const match of value.matchAll(URL_PATTERN)) {
    try {
      const url = new URL(match[0]);
      if (url.username !== '' || url.password !== '') return true;
    } catch {
      continue;
    }
  }
  return false;
}

function hasBareAuthorizationToken(value: string): boolean {
  return COMPLETE_BARE_AUTHORIZATION_PATTERN.test(value);
}

function hasAbsolutePosixPath(value: string): boolean {
  return ABSOLUTE_POSIX_PATH_PATTERN.test(value.replace(URL_PATTERN, ''));
}

function hasCommonStringRedaction(value: string): boolean {
  return CONTROL_PATTERN.test(value)
    || PRIVATE_KEY_PATTERN.test(value)
    || QUOTED_CREDENTIAL_PATTERN.test(value)
    || hasStructuredJsonCredential(value)
    || AUTHORIZATION_HEADER_PATTERN.test(value)
    || hasBareAuthorizationToken(value)
    || hasCredentialUrl(value)
    || hasAbsolutePosixPath(value)
    || /file:\/\//iu.test(value);
}

function redactPublicText(value: string): string {
  return hasCommonStringRedaction(value)
    || /~\/\.ssh(?:\/|$)/iu.test(value)
    || CREDENTIAL_ASSIGNMENT_PATTERN.test(value)
    ? '[redacted]'
    : value;
}

function redactObservationString(value: string): string {
  return redactPublicText(value);
}

function projectPublicObservation(value: unknown, field: string, depth: number, budget: ObservationProjectionBudget): unknown {
  budget.nodes += 1;
  if (budget.nodes > JSON_LIMITS.maxNodes || depth > JSON_LIMITS.maxDepth) throw new Error(`${field} exceeds JSON bounds`);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactObservationString(value);
  if (Array.isArray(value)) {
    if (value.length > JSON_LIMITS.maxArrayElements) throw new Error(`${field} exceeds JSON array bounds`);
    return value.map((item, index) => {
      budget.edges += 1;
      if (budget.edges > JSON_LIMITS.maxEdges) throw new Error(`${field} exceeds JSON edge bounds`);
      return projectPublicObservation(item, `${field}[${index}]`, depth + 1, budget);
    });
  }
  if (typeof value !== 'object') throw new Error(`${field} contains a non-JSON value`);
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length > JSON_LIMITS.maxKeys) throw new Error(`${field} exceeds JSON key bounds`);
  const output = Object.create(null) as JsonRecord;
  for (const key of keys) {
    if (isSensitiveObservationKey(key)) continue;
    budget.edges += 1;
    if (budget.edges > JSON_LIMITS.maxEdges) throw new Error(`${field} exceeds JSON edge bounds`);
    output[key] = projectPublicObservation(input[key], `${field}.${key}`, depth + 1, budget);
  }
  return output;
}

function publicObservations(value: unknown): unknown {
  return projectPublicObservation(value, 'public observations', 0, { nodes: 0, edges: 0 });
}

function redactCommandArgument(value: string): string {
  const redacted = redactPublicText(value);
  return redacted !== value
    ? redacted
    : COMMAND_CREDENTIAL_ASSIGNMENT_PATTERN.test(value) || COMMAND_HOME_PATH_PATTERN.test(value)
      ? '[redacted]'
      : value;
}

function redactCommandArguments(argv: readonly string[]): readonly string[] {
  let redactNext = false;
  return argv.map((argument, index) => {
    if (index === 0) return PUBLIC_EVIDENCE_EXECUTABLES.has(argument) ? argument : '[redacted]';
    if (redactNext) {
      redactNext = false;
      return '[redacted]';
    }
    const redacted = redactCommandArgument(argument);
    if (redacted !== argument) return redacted;
    if (SENSITIVE_COMMAND_OPTION_PATTERN.test(argument)) redactNext = true;
    return argument;
  });
}

function publicEvidenceCommands(commands: readonly EvidenceCommand[]): readonly EvidenceCommand[] {
  return commands.map((command) => ({
    argv: redactCommandArguments(command.argv),
    startedAt: command.startedAt,
    finishedAt: command.finishedAt,
    exitCode: command.exitCode,
    signal: command.signal,
    timedOut: command.timedOut,
    outputLimit: command.outputLimit,
  }));
}

function publicEvidence(value: unknown, job: JobRecord, expectedJobId: string, expectedStage: PipelineStageName, dependencies: ApiRouteDependencies): JsonRecord {
  const evidence = decodeStoredStageEvidence(value);
  if (evidence.jobId !== expectedJobId || evidence.stage !== expectedStage) {
    throw new Error('evidence response identity is invalid');
  }
  if (evidence.error !== null && evidence.error.requestId !== job.requestId) {
    throw new Error('evidence error request ID does not match the owning job');
  }
  const error = evidence.error === null ? null : {
    code: evidence.error.code,
    details: publicDetails(evidence.error.details),
    stage: evidence.error.stage,
    retryable: evidence.error.retryable,
    requestId: job.requestId,
    diagnosis: redactPublicText(evidence.error.diagnosis),
    recovery: redactPublicText(evidence.error.recovery),
    ...(evidence.error.evidencePath === undefined ? {} : { evidencePath: evidence.error.evidencePath }),
    ...(evidence.error.operationId === undefined ? {} : { operationId: evidence.error.operationId }),
  };
  const projected = {
    schemaVersion: evidence.schemaVersion,
    jobId: expectedJobId,
    stage: expectedStage,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    outcome: evidence.outcome,
    operationId: evidence.operationId,
    commands: publicEvidenceCommands(evidence.commands),
    inputs: publicEvidenceInputs(evidence.inputs, job, dependencies),
    observations: publicObservations(evidence.observations),
    error,
  };
  encodeJson(projected, 'public evidence response', true);
  return projected;
}

function getJob(store: ApiJobStore, id: string): JobRecord {
  try {
    return store.getJob(id);
  } catch (error) {
    if (error instanceof StoreNotFoundError) notFound();
    throw error;
  }
}

export function createApiRouteHandler(dependencies: ApiRouteDependencies): ApiRouteHandler {
  return async (context: ApiRouteContext): Promise<HttpResponse | null> => {
    if (context.method !== 'GET') return null;

    if (context.path === '/api/health') {
      const health = await dependencies.health();
      const activeJobId = health.activeJobId === null ? null : storedJobId(health.activeJobId);
      return jsonResponse(200, { status: 'ok', version: text(dependencies.version, 'version', 128), activeJobId });
    }
    if (context.path === '/api/config') return jsonResponse(200, configDto(dependencies.config, dependencies.targets));
    if (context.path === '/api/branches') {
      try {
        return jsonResponse(200, branchesDto(await dependencies.branches()));
      } catch {
        throw new HttpTransportError({ code: 'GIT_FETCH_FAILED', status: 503, retryable: true });
      }
    }
    if (context.path === '/api/jobs') {
      const limit = parseLimit(context.query.get('limit'));
      const cursor = parseCursor(context.query.get('cursor'));
      const page = await dependencies.store.listJobs({ cursor, limit });
      return jsonResponse(200, jobPageDto(page, limit, cursor));
    }

    const evidenceMatch = context.path.match(/^\/api\/jobs\/([^/]+)\/evidence\/([^/]+)$/u);
    if (evidenceMatch) {
      const jobId = validateJobId(evidenceMatch[1]!);
      const stage = validateStage(evidenceMatch[2]!);
      const jobRecord = getJob(dependencies.store, jobId);
      const indexedStage = dependencies.store.getStage(jobRecord.jobId, stage);
      if (indexedStage === null) notFound();
      const evidenceIndex = indexedEvidenceIndex(indexedStage, jobId, stage);
      if (evidenceIndex === null) notFound();
      return jsonResponse(200, publicEvidence(await dependencies.evidenceReader.read(evidenceIndex), jobRecord, jobId, stage, dependencies));
    }
    const eventsMatch = context.path.match(/^\/api\/jobs\/([^/]+)\/events$/u);
    if (eventsMatch) {
      const jobId = validateJobId(eventsMatch[1]!);
      getJob(dependencies.store, jobId);
      const after = parseAfter(context.query.get('after'));
      let page: EventPage;
      try {
        page = dependencies.store.listEvents(jobId, { afterSeq: after });
      } catch (error) {
        if (error instanceof StoreNotFoundError) notFound();
        throw error;
      }
      return jsonResponse(200, eventPageDto(page, jobId, after));
    }
    const detailMatch = context.path.match(/^\/api\/jobs\/([^/]+)$/u);
    if (detailMatch) {
      return jsonResponse(200, await detail(getJob(dependencies.store, validateJobId(detailMatch[1]!)), dependencies.store));
    }
    return null;
  };
}
