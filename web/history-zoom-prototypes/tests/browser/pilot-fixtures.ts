import type { Page, Request, Route } from '@playwright/test';

export type PilotPlatform = 'edge' | 'cloud';
export interface PilotHarnessOptions { deferDataAfter?: number; delayDataMs?: number; }

export interface RecordedRequest { pathname: string; search: string; authorization: string | null; origin: string; startedAt: number; releasedAt?: number; status?: number | null; }
export interface PilotRequestBounds { from: string; to: string; aggregation: string; }
export interface RequestEvidence { pathname: string; from: string; to: string; aggregation: string; role: string; startedAt: number; releasedAt: number | null; status: number | null; }
export interface PilotRequestSnapshot {
  initial: readonly RequestEvidence[];
  neighbor: readonly RequestEvidence[];
  latest: readonly RequestEvidence[];
  total: readonly RequestEvidence[];
  aborted: readonly RequestEvidence[];
}

export interface DeferredReply {
  readonly done: Promise<'fulfilled' | 'aborted'>;
  readonly request: RecordedRequest;
  resolve(status: number, body: unknown): void;
}

export interface PilotApiHarness {
  requests: RecordedRequest[];
  dataRequests: RecordedRequest[];
  pendingData: DeferredReply[];
  activeDataRequests(): number;
  snapshot(roles?: { initial?: RecordedRequest; neighbor?: RecordedRequest; latest?: RecordedRequest }): PilotRequestSnapshot;
  releaseAll(status: number, factory: (request: RecordedRequest) => unknown): Promise<void>;
  dispose(): Promise<void>;
}

export function requestBounds(request: RecordedRequest): PilotRequestBounds {
  const params = new URLSearchParams(request.search);
  return { from: params.get('from') ?? '', to: params.get('to') ?? '', aggregation: params.get('aggregation') ?? '' };
}

export function sameRequest(a: RecordedRequest, b: RecordedRequest): boolean {
  const left = requestBounds(a);
  const right = requestBounds(b);
  return left.from === right.from && left.to === right.to && left.aggregation === right.aggregation;
}

export function findDataRequest(harness: PilotApiHarness, predicate: (bounds: PilotRequestBounds, request: RecordedRequest) => boolean): RecordedRequest | undefined {
  return harness.dataRequests.find((request) => predicate(requestBounds(request), request));
}

export function pendingDataFor(harness: PilotApiHarness, predicate: (bounds: PilotRequestBounds, request: RecordedRequest) => boolean): DeferredReply | undefined {
  return harness.pendingData.find((reply) => predicate(requestBounds(reply.request), reply.request));
}

export function countDataRequests(harness: PilotApiHarness, predicate: (bounds: PilotRequestBounds, request: RecordedRequest) => boolean): number {
  return harness.dataRequests.filter((request) => predicate(requestBounds(request), request)).length;
}

export interface CardDataFixtureOptions {
  series?: unknown[];
  aggregation?: { level: string; pointCount: number };
  truncated?: boolean;
  cardId?: string;
}

const ABORTED = /Route is already handled|Request context disposed|Target page, context or browser has been closed|net::ERR_ABORTED/i;
const tokenHeader = (route: Route): string | null => route.request().headers().authorization ?? null;

function deferredRoute(route: Route, request: RecordedRequest, onSettled: (status: 'fulfilled' | 'aborted') => void): DeferredReply {
  let settled = false;
  let settleDone!: (value: 'fulfilled' | 'aborted') => void;
  let rejectDone!: (error: unknown) => void;
  let resolveReply!: (value: { status: number; body: unknown }) => void;
  const done = new Promise<'fulfilled' | 'aborted'>((resolve, reject) => { settleDone = resolve; rejectDone = reject; });
  void done.catch(() => undefined);
  const reply = new Promise<{ status: number; body: unknown }>((resolve) => { resolveReply = resolve; });
  void (async () => {
    const { status, body } = await reply;
    try {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      request.releasedAt = Date.now(); request.status = status;
      onSettled('fulfilled');
      settleDone('fulfilled');
    } catch (error) {
      if (ABORTED.test(error instanceof Error ? error.message : String(error))) { request.releasedAt = Date.now(); request.status = null; onSettled('aborted'); settleDone('aborted'); }
      else rejectDone(error);
    }
  })();
  return {
    done,
    request,
    resolve(status, body) {
      if (settled) return;
      settled = true;
      resolveReply({ status, body });
    },
  };
}

const prefixes = (platform: PilotPlatform) => platform === 'edge'
  ? { zones: '/api/irrigation-zones', history: '/api/history' }
  : { zones: '/api/v1/irrigation-zones', history: '/api/v1/history' };

export async function installPilotApi(page: Page, platform: PilotPlatform, options: PilotHarnessOptions = {}): Promise<PilotApiHarness> {
  const paths = prefixes(platform);
  const requests: RecordedRequest[] = [];
  const dataRequests: RecordedRequest[] = [];
  const pendingData: DeferredReply[] = [];
  const abortedData: RecordedRequest[] = [];
  const abortedSet = new Set<RecordedRequest>();
  let activeData = 0;
  const settledData = new Set<RecordedRequest>();
  const requestRecords = new WeakMap<Request, RecordedRequest>();
  const finishData = (request: RecordedRequest): void => {
    if (!settledData.has(request)) { settledData.add(request); request.releasedAt ??= Date.now(); activeData -= 1; }
  };
  const markAborted = (request: RecordedRequest): void => {
    if (abortedSet.has(request)) return;
    abortedSet.add(request); request.status = null; finishData(request); abortedData.push(request);
  };
  const deferAfter = options.deferDataAfter ?? Number.POSITIVE_INFINITY;
  const delayDataMs = options.delayDataMs ?? 0;
  let dataCount = 0;
  const matches = (pathname: string): 'zones' | 'cards' | 'data' | null => {
    if (pathname === paths.zones) return 'zones';
    if (pathname === `${paths.history}/zones/7/cards`) return 'cards';
    if (new RegExp(`^${paths.history.replaceAll('/', '\\/')}\\/zones\\/7\\/cards\\/[^/]+\\/data$`).test(pathname)) return 'data';
    return null;
  };
  const routeHandler = async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    const kind = matches(url.pathname);
    if (!kind) { await route.continue(); return; }
    const recorded: RecordedRequest = { pathname: url.pathname, search: url.search, authorization: tokenHeader(route), origin: url.origin, startedAt: Date.now() };
    requestRecords.set(route.request(), recorded);
    requests.push(recorded);
    if (kind === 'data') {
      dataRequests.push(recorded);
      activeData += 1;
      dataCount += 1;
      if (dataCount > deferAfter) {
        pendingData.push(deferredRoute(route, recorded, (status) => { finishData(recorded); if (status === 'aborted') markAborted(recorded); }));
        return;
      }
      if (delayDataMs > 0) await new Promise((resolve) => setTimeout(resolve, delayDataMs));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cardDataForRequest(recorded)) });
      recorded.status = 200; finishData(recorded);
      return;
    }
    if (kind === 'zones') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 7, name: 'North plot' }]) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ zoneId: 7, generatedAt: new Date().toISOString(), cards: [
      { cardId: 'soil-card', cardType: 'soil', title: 'Root tension', views: ['soil-profile', 'line-chart'], availability: { available: true, reasons: [] }, sourceLabels: ['Field probe'] },
      { cardId: 'environment-card', cardType: 'environment', title: 'Microclimate', views: ['line-chart'], availability: { available: true, reasons: [] } },
      { cardId: 'irrigation-card', cardType: 'irrigation', title: 'Irrigation', views: ['event-timeline'], availability: { available: true, reasons: [] } },
    ] }) });
  };
  const requestFailed = (failed: Request): void => {
    const request = requestRecords.get(failed);
    if (!request || abortedData.includes(request)) return;
    markAborted(request);
  };
  page.on('requestfailed', requestFailed);
  await page.route('**/*', routeHandler);
  const releaseAll = async (status: number, factory: (request: RecordedRequest) => unknown): Promise<void> => {
    const replies = pendingData.splice(0);
    replies.forEach((reply) => reply.resolve(status, factory(reply.request)));
    await Promise.all(replies.map((reply) => reply.done));
  };
  const dispose = async (): Promise<void> => {
    const replies = pendingData.splice(0);
    replies.forEach((reply) => reply.resolve(499, { message: 'disposed' }));
    await Promise.all(replies.map((reply) => reply.done));
    await page.unroute('**/*', routeHandler);
    page.off('requestfailed', requestFailed);
  };
  const evidence = (request: RecordedRequest, role: string): RequestEvidence => ({ pathname: request.pathname, ...requestBounds(request), role, startedAt: request.startedAt, releasedAt: request.releasedAt ?? null, status: request.status ?? null });
  const snapshot = (roles: { initial?: RecordedRequest; neighbor?: RecordedRequest; latest?: RecordedRequest } = {}): PilotRequestSnapshot => {
    const roleFor = (request: RecordedRequest): string => request === roles.initial ? 'initial' : request === roles.neighbor ? 'neighbor' : request === roles.latest ? 'latest' : 'other';
    return {
      initial: dataRequests.filter((request) => request === roles.initial).map((request) => evidence(request, 'initial')),
      neighbor: dataRequests.filter((request) => request === roles.neighbor).map((request) => evidence(request, 'neighbor')),
      latest: dataRequests.filter((request) => request === roles.latest).map((request) => evidence(request, 'latest')),
      total: dataRequests.map((request) => evidence(request, roleFor(request))),
      aborted: abortedData.map((request) => evidence(request, 'aborted')),
    };
  };
  return { requests, dataRequests, pendingData, activeDataRequests: () => activeData, releaseAll, snapshot, dispose };
}

export function cardDataForRequest(request: RecordedRequest, overrides: Partial<CardDataFixtureOptions> = {}): Record<string, unknown> {
  const params = new URLSearchParams(request.search);
  const from = Date.parse(params.get('from') ?? '') || Date.UTC(2026, 6, 1);
  const to = Date.parse(params.get('to') ?? '') || from + 86_400_000;
  const cardId = overrides.cardId ?? request.pathname.match(/cards\/([^/]+)\/data$/)?.[1] ?? 'soil-card';
  const times = [0.2, 0.4, 0.6, 0.8].map((fraction) => new Date(from + (to - from) * fraction).toISOString());
  const values: Record<string, (number | null)[]> = { 'swt-20': [18, 0, null, 24], 'swt-40': [22, 21, 20, 19], 'air-temp': [16, 17, 18, 19] };
  const definitions = [['swt-20', '20 cm', 'kPa'], ['swt-40', '40 cm', 'kPa'], ['air-temp', 'Air temperature', 'C']] as const;
  const series = overrides.series ?? definitions.map(([id, label, unit]) => ({ id, label, unit, points: times.map((t, index) => ({ t, value: values[id][index], ...(id === 'swt-20' && index === 2 ? { mean: 99 } : {}), coverageConfidence: 'derived' })) }));
  const level = overrides.aggregation?.level ?? params.get('aggregation') ?? 'raw';
  const pointCount = overrides.aggregation?.pointCount ?? 12;
  const expectedSeconds: Record<string, number | null> = { raw: null, '15m': 900, hourly: 3600, daily: 86_400 };
  return {
    cardId,
    cardType: cardId === 'environment-card' ? 'environment' : 'soil',
    view: 'line-chart',
    range: { label: params.get('range'), from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: 'UTC' },
    series,
    aggregation: { level, bucketSizeSeconds: expectedSeconds[level] ?? null, coveragePct: 100, coverageConfidence: 'derived', pointCount },
    limits: { maxPointsPerSeries: 2000, maxEvents: 200, maxInterpretations: 20, truncated: overrides.truncated ?? false },
    profiles: [], events: [], interpretations: [], advancedFields: {}, calendar: null,
    freshness: { dataAsOf: new Date(to).toISOString(), syncState: 'synced' },
  };
}
