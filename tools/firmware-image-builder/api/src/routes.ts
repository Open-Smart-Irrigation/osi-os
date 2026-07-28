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
  optionalInstant,
  sourceMetadataSubject,
  stableRelativePath,
} from './validation.js';
import { decodeStoredStageEvidence } from '../../runner/src/evidence.js';
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
const MAX_BRANCH_BYTES = 512;
const MAX_CONFIG_ITEMS = 256;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RUNNER_UNIT_PATTERN = /^osi-image-builder-runner@[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const HASH40_PATTERN = /^[0-9a-f]{40}$/u;
const HASH64_PATTERN = /^[0-9a-f]{64}$/u;
const EVIDENCE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.json$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const JOB_STATE_SET = new Set<string>(JOB_STATES);
const STAGE_SET = new Set<string>(PIPELINE_STAGE_NAMES);
const ERROR_CODE_SET = new Set<string>(BUILDER_ERROR_CODES);
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

export interface EvidenceReader {
  readonly read: (job: JobRecord, stage: PipelineStageName) => unknown | Promise<unknown>;
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
  readonly readEvidence: EvidenceReader['read'];
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
  const result = text(value, field, MAX_BRANCH_BYTES);
  if (result.startsWith('/') || result.endsWith('/') || result.includes('\\')
    || result.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`${field} is not a canonical branch name`);
  }
  return result;
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

function evidencePath(stage: StoredStage): string | null {
  if (stage.evidencePath === null) return null;
  const value = stableRelativePath(stage.evidencePath, 'stage evidence path');
  const directPrefix = 'evidence/';
  const jobPrefix = `jobs/${storedJobId(stage.jobId)}/evidence/`;
  const filename = value.startsWith(directPrefix)
    ? value.slice(directPrefix.length)
    : value.startsWith(jobPrefix) ? value.slice(jobPrefix.length) : '';
  const stageIndex = PIPELINE_STAGE_NAMES.indexOf(stage.stage);
  const expectedFilename = `${String(stageIndex).padStart(2, '0')}-${stage.stage}.json`;
  if (!EVIDENCE_FILE_PATTERN.test(filename) || filename !== expectedFilename) {
    throw new Error('stage evidence path does not match the fixed stage index');
  }
  return `${directPrefix}${filename}`;
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

function publicEvidence(value: unknown, expectedJobId: string, expectedStage: PipelineStageName): JsonRecord {
  const evidence = decodeStoredStageEvidence(value);
  if (evidence.jobId !== expectedJobId || evidence.stage !== expectedStage) {
    throw new Error('evidence response identity is invalid');
  }
  const error = evidence.error === null ? null : {
    code: evidence.error.code,
    details: publicDetails(evidence.error.details),
    stage: evidence.error.stage,
    retryable: evidence.error.retryable,
    requestId: evidence.error.requestId,
    diagnosis: evidence.error.diagnosis,
    recovery: evidence.error.recovery,
    ...(evidence.error.evidencePath === undefined ? {} : { evidencePath: evidence.error.evidencePath }),
    ...(evidence.error.operationId === undefined ? {} : { operationId: evidence.error.operationId }),
  };
  return {
    schemaVersion: evidence.schemaVersion,
    jobId: expectedJobId,
    stage: expectedStage,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    outcome: evidence.outcome,
    operationId: evidence.operationId,
    commands: evidence.commands,
    inputs: evidence.inputs,
    observations: evidence.observations,
    error,
  };
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
      if (indexedStage === null || indexedStage.evidenceSha256 === null) notFound();
      stageDto(indexedStage, jobId, stage);
      return jsonResponse(200, publicEvidence(await dependencies.readEvidence(jobRecord, stage), jobId, stage));
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
