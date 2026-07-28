import type { PipelineStageName } from '../../domain/types.js';
import { PIPELINE_STAGE_NAMES } from '../../domain/types.js';
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
import { HttpTransportError, type ApiRouteHandler, type ApiRouteContext, type HttpResponse, jsonResponse } from './server.js';

const DEFAULT_JOB_LIMIT = 50;
const MAX_JOB_LIMIT = 100;
const MAX_CURSOR_BYTES = 512;
const MAX_JOB_ID_BYTES = 128;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;

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

type JsonRecord = Record<string, unknown>;

function badRequest(message: string): never {
  throw new HttpTransportError({ code: 'INVALID_REQUEST', status: 400, details: { field: message } });
}

function notFound(): never {
  throw new HttpTransportError({ code: 'NOT_FOUND', status: 404 });
}

function validateJobId(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_JOB_ID_BYTES || !JOB_ID_PATTERN.test(value)) badRequest('job id');
  return value;
}

function validateStage(value: string): PipelineStageName {
  if (!(PIPELINE_STAGE_NAMES as readonly string[]).includes(value)) badRequest('stage');
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

function isUnsafeKey(key: string): boolean {
  const normalized = key.replaceAll('-', '').replaceAll('_', '').toLowerCase();
  return normalized.includes('path') || normalized.includes('secret') || normalized.includes('token')
    || normalized.includes('password') || normalized.includes('credential') || normalized.includes('authorization')
    || normalized === 'env' || normalized.includes('environment') || normalized.includes('mount')
    || normalized.includes('quarantine') || normalized.includes('staging');
}

function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeValue).filter((item) => item !== undefined);
  if (value !== null && typeof value === 'object') {
    const result: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      if (!isUnsafeKey(key)) result[key] = safeValue(child);
    }
    return result;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function summary(job: JobRecord): JsonRecord {
  return {
    id: job.jobId,
    state: job.state,
    branch: job.branch,
    targetId: job.targetId,
    outputRootId: job.rootId,
    acceptedAt: job.acceptedAt,
    currentStage: job.currentStage,
    queuePosition: job.queuePosition,
    terminalAt: job.terminalAt,
  };
}

function stageDto(stage: StoredStage): JsonRecord {
  return {
    stage: stage.stage,
    outcome: stage.outcome,
    startedAt: stage.startedAt,
    finishedAt: stage.finishedAt,
    evidenceSha256: stage.evidenceSha256,
    errorCode: stage.errorCode,
    ...(stage.error === null ? {} : { error: safeValue(stage.error) }),
  };
}

async function detail(job: JobRecord, store: ApiJobStore): Promise<JsonRecord> {
  const stages = await Promise.all(PIPELINE_STAGE_NAMES.map(async (stage) => store.getStage(job.jobId, stage)));
  return {
    ...summary(job),
    source: {
      branch: job.branch,
      sourceRef: job.sourceRef,
      expectedSha: job.expectedSha,
      pinnedSha: job.pinnedSha,
      commitTime: job.sourceCommitTime,
      author: job.sourceAuthor,
      subject: job.sourceSubject,
    },
    stage: job.currentStage,
    output: {
      rootId: job.rootId,
      artifactSha256: job.artifactSha256,
      artifactSize: job.artifactSize,
      artifactMtime: job.artifactMtime,
      publishState: job.publishState,
      publishedAt: job.publishedAt,
    },
    errors: {
      terminal: job.terminalErrorCode === null ? null : { code: job.terminalErrorCode, details: safeValue(job.terminalError), at: job.terminalAt },
      publish: job.publishBlockerCode === null ? null : { code: job.publishBlockerCode, details: safeValue(job.publishBlocker) },
      cleanup: job.cleanupBlockerCode === null ? null : { code: job.cleanupBlockerCode, details: safeValue(job.cleanupBlocker) },
      freshness: job.freshnessErrorCode === null ? null : { code: job.freshnessErrorCode, details: safeValue(job.freshnessError) },
    },
    cancellation: {
      requestedAt: job.cancelRequestedAt,
      reason: job.cancelReason,
      cooperativeDeadlineAt: job.cancellationCooperativeDeadlineAt,
      graceDeadlineAt: job.cancellationGraceDeadlineAt,
    },
    runtime: {
      runnerUnit: job.runnerUnit,
      dispatchedAt: job.dispatchedAt,
      containerImageDigest: job.containerImageDigest,
      cleanupOutcome: job.containerCleanupOutcome,
    },
    evidence: stages.filter((stage): stage is StoredStage => stage !== null).map(stageDto),
  };
}

function eventDto(event: EventRecord): JsonRecord {
  return { seq: event.seq, event: event.eventType, state: event.state, stage: event.stage, at: event.at, data: safeValue(event.payload) as JsonRecord };
}

function configDto(config: BuilderConfig, targets: readonly ApiTargetConfig[]): JsonRecord {
  return {
    repository: config.repository,
    approvedOutputRoots: config.approvedOutputRoots.map(({ id, label, path }) => ({ id, label, path })),
    targets: targets.map(({ id, label, environment, openwrtTarget, profile, rootfs, artifactGlob }) => ({ id, label, environment, openwrtTarget, profile, rootfs, artifactGlob })),
  };
}

function branchesDto(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('branch resolver returned invalid data');
  const input = value as Record<string, unknown>;
  if (typeof input.fetchedAt !== 'string' || !Array.isArray(input.branches) || input.branches.length > 10_000) throw new Error('branch resolver returned invalid data');
  const branches = input.branches.map((branch) => {
    if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) throw new Error('branch resolver returned invalid branch');
    const item = branch as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(item.sha)
      || typeof item.commitTime !== 'string' || typeof item.subject !== 'string' || item.subject.length > 4_096) {
      throw new Error('branch resolver returned invalid branch');
    }
    return { name: item.name, sha: item.sha, commitTime: item.commitTime, subject: item.subject };
  });
  return { fetchedAt: input.fetchedAt, branches };
}

function getJob(store: ApiJobStore, id: string): JobRecord {
  try { return store.getJob(id); }
  catch (error) { if (error instanceof StoreNotFoundError) notFound(); throw error; }
}

export function createApiRouteHandler(dependencies: ApiRouteDependencies): ApiRouteHandler {
  return async (context: ApiRouteContext): Promise<HttpResponse | null> => {
    if (context.method !== 'GET') return null;

    if (context.path === '/api/health') {
      const health = await dependencies.health();
      return jsonResponse(200, { status: 'ok', version: dependencies.version, activeJobId: health.activeJobId });
    }
    if (context.path === '/api/config') return jsonResponse(200, configDto(dependencies.config, dependencies.targets));
    if (context.path === '/api/branches') {
      try { return jsonResponse(200, branchesDto(await dependencies.branches())); }
      catch { throw new HttpTransportError({ code: 'GIT_FETCH_FAILED', status: 503, retryable: true }); }
    }
    if (context.path === '/api/jobs') {
      const page = await dependencies.store.listJobs({ cursor: parseCursor(context.query.get('cursor')), limit: parseLimit(context.query.get('limit')) });
      if (page.nextCursor !== null && !OPAQUE_CURSOR_PATTERN.test(page.nextCursor)) throw new Error('store returned invalid opaque cursor');
      return jsonResponse(200, { jobs: page.jobs.map(summary), nextCursor: page.nextCursor });
    }

    const evidenceMatch = context.path.match(/^\/api\/jobs\/([^/]+)\/evidence\/([^/]+)$/u);
    if (evidenceMatch) {
      const jobRecord = getJob(dependencies.store, validateJobId(evidenceMatch[1]!));
      const stage = validateStage(evidenceMatch[2]!);
      const indexedStage = dependencies.store.getStage(jobRecord.jobId, stage);
      if (indexedStage === null || indexedStage.evidenceSha256 === null) notFound();
      return jsonResponse(200, safeValue(await dependencies.readEvidence(jobRecord, stage)));
    }
    const eventsMatch = context.path.match(/^\/api\/jobs\/([^/]+)\/events$/u);
    if (eventsMatch) {
      const jobId = validateJobId(eventsMatch[1]!);
      const page: EventPage = dependencies.store.listEvents(jobId, { afterSeq: parseAfter(context.query.get('after')) });
      return jsonResponse(200, { events: page.events.map(eventDto), next: page.nextAfterSeq });
    }
    const detailMatch = context.path.match(/^\/api\/jobs\/([^/]+)$/u);
    if (detailMatch) return jsonResponse(200, await detail(getJob(dependencies.store, validateJobId(detailMatch[1]!)), dependencies.store));
    return null;
  };
}
