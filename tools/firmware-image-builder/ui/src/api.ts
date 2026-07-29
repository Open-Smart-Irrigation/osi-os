import { JOB_STATES } from './types.js';
import type {
  AcceptedJob,
  ApiErrorBody,
  BranchSnapshot,
  BuilderConfig,
  ConnectionState,
  EventPage,
  EvidenceDocument,
  HealthSnapshot,
  JobDetail,
  JobEvent,
  JobPage,
  PreflightResult,
  SourceSelection,
  StageName,
} from './types.js';

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

export class BuilderApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly retryable?: boolean;
    readonly requestId?: string | null;
  }) {
    super(input.message);
    this.name = 'BuilderApiError';
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.requestId = input.requestId ?? null;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BuilderApiError({ code: 'INVALID_RESPONSE', message: 'The builder returned invalid data.', status: 502 });
  return value as Record<string, unknown>;
}

function apiError(value: unknown, status: number): BuilderApiError {
  try {
    const envelope = record(value) as unknown as ApiErrorBody;
    if (typeof envelope.error.code !== 'string' || typeof envelope.error.message !== 'string') throw new Error('invalid error');
    return new BuilderApiError({
      code: envelope.error.code,
      message: envelope.error.message,
      status,
      retryable: envelope.error.retryable === true,
      requestId: typeof envelope.error.requestId === 'string' ? envelope.error.requestId : null,
    });
  } catch {
    return new BuilderApiError({ code: 'HTTP_ERROR', message: `The builder request failed (${status}).`, status });
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
    });
  } catch (error) {
    throw new BuilderApiError({
      code: 'NETWORK_UNAVAILABLE',
      message: 'The local builder service is unavailable.',
      status: 0,
      retryable: true,
      requestId: null,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BuilderApiError({ code: 'INVALID_RESPONSE', message: 'The builder returned an unreadable response.', status: response.status });
  }
  if (!response.ok) throw apiError(body, response.status);
  return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export const builderApi = Object.freeze({
  health: (): Promise<HealthSnapshot> => request('/api/health'),
  config: (): Promise<BuilderConfig> => request('/api/config'),
  branches: (): Promise<BranchSnapshot> => request('/api/branches'),
  refreshBranches: (): Promise<BranchSnapshot> => post('/api/branches/refresh', {}),
  preflight: (selection: SourceSelection): Promise<PreflightResult> => post('/api/preflight', selection),
  enqueue: async (selection: SourceSelection, preflightId: string): Promise<AcceptedJob> => {
    const value = await post<{ readonly job: AcceptedJob }>('/api/jobs', { ...selection, preflightId });
    return value.job;
  },
  jobs: (limit = 100): Promise<JobPage> => request(`/api/jobs?limit=${limit}`),
  job: (jobId: string): Promise<JobDetail> => request(`/api/jobs/${encodeURIComponent(jobId)}`),
  events: (jobId: string, after = -1): Promise<EventPage> => request(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${after}`),
  evidence: (jobId: string, stage: StageName): Promise<EvidenceDocument> => request(`/api/jobs/${encodeURIComponent(jobId)}/evidence/${encodeURIComponent(stage)}`),
  cancel: (jobId: string): Promise<JobDetail> => post(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
  recover: (jobId: string, retry = false): Promise<JobDetail | Readonly<{ job: JobDetail; recovery: 'cleanup_pending'; cleanupLeaseId: string }>> => (
    post(`/api/jobs/${encodeURIComponent(jobId)}/recover`, retry ? { retry: true } : {})
  ),
  recheckPublishBlocker: (jobId: string): Promise<JobDetail> => post(`/api/jobs/${encodeURIComponent(jobId)}/publish-blocker/recheck`, {}),
});

export interface JobEventStream {
  readonly close: () => void;
}

const STREAM_EVENT_NAMES = ['stage', 'log', 'terminal', 'log-gap', 'log-truncated'] as const;
const STREAM_STAGES = new Set([
  'preflight', 'source', 'release-gates', 'frontend', 'target-setup',
  'feeds', 'config', 'build', 'verify', 'publish',
]);
const STREAM_STATES = new Set<string>(JOB_STATES);

function streamString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function streamEvent(message: MessageEvent<string>, eventName: string, sequence: number): JobEvent {
  const data = record(JSON.parse(message.data));
  const stateValue = streamString(data.state);
  const stageValue = streamString(data.stage);
  return {
    seq: sequence,
    event: eventName,
    state: stateValue !== null && STREAM_STATES.has(stateValue) ? stateValue as JobEvent['state'] : null,
    stage: stageValue !== null && STREAM_STAGES.has(stageValue) ? stageValue as JobEvent['stage'] : null,
    at: streamString(data.at),
    data,
  };
}

export function openJobEventStream(input: Readonly<{
  readonly jobId: string;
  readonly after: number;
  readonly onEvent: (event: JobEvent) => void;
  readonly onConnection: (state: ConnectionState) => void;
}>): JobEventStream {
  let closed = false;
  let source: EventSource | null = null;
  let cursor = input.after;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReconnect = (): void => {
    if (closed || retryTimer !== undefined) return;
    source?.close();
    input.onConnection('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, 1_000);
  };

  const onMessage = (eventName: string, message: MessageEvent<string>): void => {
    const sequence = Number(message.lastEventId);
    if (!Number.isSafeInteger(sequence) || sequence <= cursor) return;
    try {
      const event = streamEvent(message, eventName, sequence);
      cursor = sequence;
      input.onEvent(event);
    } catch {
      scheduleReconnect();
    }
  };

  const connect = (): void => {
    if (closed) return;
    input.onConnection(source === null ? 'connecting' : 'reconnecting');
    source?.close();
    source = new EventSource(`/api/jobs/${encodeURIComponent(input.jobId)}/events/stream?after=${cursor}`);
    source.onopen = () => input.onConnection('live');
    for (const eventName of STREAM_EVENT_NAMES) {
      source.addEventListener(eventName, (message) => onMessage(eventName, message as MessageEvent<string>));
    }
    source.onerror = scheduleReconnect;
  };

  connect();
  return Object.freeze({
    close: () => {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
      input.onConnection('closed');
    },
  });
}
