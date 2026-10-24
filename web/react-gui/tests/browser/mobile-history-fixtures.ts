import { createHash } from 'node:crypto';
import type { Page, Request, Route } from '@playwright/test';

export const FIXTURE_NOW = Date.UTC(2026, 9, 24, 12, 17, 0);
export const FIXTURE_USERNAME = 'mobile-history-fixture';
export const FIXTURE_USER_UUID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_ZONE_ID = 1;
export const FIXTURE_ZONE_UUID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_TIME_ZONE = 'Europe/Zurich';
export const EDGE_TOKEN = 'edge-mobile-history-token';
export const RESPONSE_DELAY_BASE_MS = 600;
export const RESPONSE_BYTES_PER_SECOND = 125_000;

export const EXPECTED_SERIES = [
  ['soil-src-probe-1', 'swt_1', 'd9db14c69d12d3b3'],
  ['soil-src-probe-1', 'swt_2', '0c54b653d6eab0c0'],
  ['soil-src-probe-1', 'swt_3', 'c94f32ca9561a261'],
  ['soil-src-probe-2', 'swt_1', '8aa3c3b56ecec5df'],
  ['soil-src-probe-2', 'swt_2', '27e73fefed8d27e6'],
  ['soil-src-probe-2', 'swt_3', '1ae759d0b4091681'],
  ['soil-src-probe-3', 'swt_1', 'f613eada91b02b88'],
  ['soil-src-probe-3', 'swt_2', 'ef61638ceb200d5a'],
] as const;

export type FixtureScenario =
  | 'normal'
  | 'pending-addition'
  | 'missing-source'
  | 'access-denied-source'
  | 'range-too-large'
  | 'transient'
  | 'stale'
  | 'invalid-average'
  | 'empty-range'
  | 'finite-outside-viewport'
  | 'auth-401'
  | 'auth-403';

export interface MobileHistoryRequestRecord {
  method: string;
  pathname: string;
  body: unknown;
  authorization: string | null;
  startedAt: number;
  releasedAt: number | null;
  status: number | null;
  bytes: number;
  delayMs: number;
  role: string;
  outcome: 'fulfilled' | 'aborted' | 'error' | null;
}

export interface MobileHistoryFixtureOptions {
  enabled?: boolean;
  catalogStatus?: number;
  catalogRows?: number;
  scenario?: FixtureScenario;
}

export interface MobileHistoryFixture {
  requests: MobileHistoryRequestRecord[];
  unexpectedApiRequests: string[];
  contractErrors: string[];
  failedRequests: string[];
  abortedRequests: string[];
  pageErrors: string[];
  consoleErrors: string[];
  setScenario(scenario: FixtureScenario): void;
  seriesRequests(): MobileHistoryRequestRecord[];
  catalogRequests(): MobileHistoryRequestRecord[];
  waitForSeries(count?: number): Promise<void>;
  dispose(): Promise<void>;
}

const ABORTED = /Route is already handled|Request context disposed|Target page, context or browser has been closed|net::ERR_ABORTED/i;
const features = {
  historyUxEnabled: false,
  historyComparisonEnabled: false,
  historyWorkspacesEnabled: false,
  historyAdvancedOverlaysEnabled: false,
  historyCloudAiEnabled: false,
};

function seriesId(sourceKey: string, channelKey: string): string {
  return createHash('sha256').update(`1|soil|${sourceKey}|${channelKey}`).digest('hex').slice(0, 16);
}

for (const [sourceKey, channelKey, expected] of EXPECTED_SERIES) {
  if (seriesId(sourceKey, channelKey) !== expected) throw new Error(`fixture series id mapping drifted for ${sourceKey}/${channelKey}`);
}

function sourceRows(extraRows = 0): Array<Record<string, unknown>> {
  const rows = EXPECTED_SERIES.map(([sourceKey, channelKey]) => ({
    seriesId: seriesId(sourceKey, channelKey),
    hubEui: '0004A30B00112233',
    zoneId: FIXTURE_ZONE_ID,
    zoneName: 'North plot',
    cardType: 'soil',
    sourceKey,
    channelKey,
    displayName: `Probe ${sourceKey.slice(-1)} · ${channelKey.toUpperCase()}`,
    unit: 'kPa',
    availability: 'available',
    deviceName: `Probe ${sourceKey.slice(-1)}`,
    depthCm: Number(channelKey.slice(-1)) * 10,
    depthReference: 'current_layout',
    sourceKind: 'device',
    deviceSourceId: sourceKey,
    configurationState: 'current',
    legacy: false,
  }));
  for (let index = 0; index < extraRows; index += 1) {
    const sourceKey = `soil-src-cap-${String(index + 1).padStart(2, '0')}`;
    const channelKey = 'swt_1';
    rows.push({
      seriesId: seriesId(sourceKey, channelKey),
      hubEui: '0004A30B00112233', zoneId: FIXTURE_ZONE_ID, zoneName: 'North plot', cardType: 'soil',
      sourceKey, channelKey, displayName: `Cap probe ${index + 1} · SWT_1`, unit: 'kPa', availability: 'available',
      deviceName: `Cap probe ${index + 1}`, depthCm: 10, depthReference: 'current_layout', sourceKind: 'device',
      deviceSourceId: sourceKey, configurationState: 'current', legacy: false,
    });
  }
  return rows;
}

function edgeStats() {
  return { cpu_temp_c: 45, mem_total_mb: 1024, mem_used_mb: 256, mem_free_mb: 768, mem_percent: 25, load_1: 0.1, load_5: 0.1, load_15: 0.1, cpu_count: 4, fan_available: false, fan_mode: 'none', fan_value: null, fan_max: null, restartPending: null };
}

function edgeZone() {
  return [{ id: 1, name: 'North plot', device_count: 3, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-10-24T00:00:00.000Z', zone_uuid: FIXTURE_ZONE_UUID, timezone: FIXTURE_TIME_ZONE, schedule: null }];
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function responseDelay(bytes: number): number {
  return RESPONSE_DELAY_BASE_MS + (bytes / RESPONSE_BYTES_PER_SECOND) * 1_000;
}

function requestBody(request: Request): Record<string, unknown> {
  try { return (request.postDataJSON() ?? {}) as Record<string, unknown>; } catch { return {}; }
}

function matchingSeriesRows(rows: readonly Record<string, unknown>[], selectors: readonly string[]): Array<Record<string, unknown>> {
  const byId = new Map(rows.map((row) => [String(row.seriesId), row]));
  return selectors.map((id) => byId.get(id)).filter((row): row is Record<string, unknown> => row !== undefined);
}

const DROPPED_SERIES_ID = EXPECTED_SERIES[EXPECTED_SERIES.length - 1][2];

function validateSeriesRequest(rows: readonly Record<string, unknown>[], body: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const selectors = body.selectors;
  if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 25) {
    errors.push(`selectors must contain 1..25 entries; got ${Array.isArray(selectors) ? selectors.length : 'non-array'}`);
  }
  const ids = Array.isArray(selectors) ? selectors.map((selector) => (selector && typeof selector === 'object' ? String((selector as Record<string, unknown>).seriesId) : '')) : [];
  if (new Set(ids).size !== ids.length) errors.push('selectors must be unique');
  const knownIds = new Set(rows.map((row) => String(row.seriesId)));
  for (const id of ids) if (!knownIds.has(id)) errors.push(`selector ${id} is not in the active catalog`);
  if (body.aggregation !== 'hourly') errors.push(`aggregation must be hourly; got ${String(body.aggregation)}`);
  const range = body.range;
  if (!range || typeof range !== 'object') {
    errors.push('range must be an object');
    return errors;
  }
  const rangeRecord = range as Record<string, unknown>;
  if (rangeRecord.mode !== 'custom') errors.push(`range mode must be custom; got ${String(rangeRecord.mode)}`);
  const from = Date.parse(String(rangeRecord.from));
  const to = Date.parse(String(rangeRecord.to));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    errors.push('range bounds must be an increasing ISO interval');
  } else {
    if (from % 3_600_000 !== 0 || to % 3_600_000 !== 0) errors.push('edge range bounds must align to UTC hours');
    const bucketCount = (to - from) / 3_600_000;
    const expectedLabel = bucketCount <= 25 ? '24h' : bucketCount === 169 ? '7d' : null;
    if (expectedLabel !== null && rangeRecord.label !== expectedLabel) errors.push(`range label must be ${expectedLabel} for ${bucketCount} hourly transport buckets`);
  }
  return errors;
}

function seriesResponse(rows: readonly Record<string, unknown>[], body: Record<string, unknown>, scenario: FixtureScenario, dropNamedSource: boolean) {
  const range = (body.range ?? {}) as Record<string, unknown>;
  const from = String(range.from);
  const to = String(range.to);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const selectorRows = ((body.selectors ?? []) as Array<Record<string, unknown>>)
    .map((selector) => String(selector.seriesId));
  const requestedRows = matchingSeriesRows(rows, selectorRows);
  const pointCount = Math.max(0, Math.ceil((toMs - fromMs) / 3_600_000));
  const makeSeries = (row: Record<string, unknown>, seriesIndex: number) => ({
    seriesId: row.seriesId,
    resolved: { hubEui: row.hubEui, zoneId: row.zoneId, cardType: row.cardType, sourceKey: row.sourceKey, channelKey: row.channelKey, deviceSourceId: row.deviceSourceId },
    label: row.displayName,
    unit: row.unit,
    coveragePct: 100,
    cadence: 'hourly',
    timezone: FIXTURE_TIME_ZONE,
    truncated: false,
    points: Array.from({ length: pointCount }, (_, bucketIndex) => ({
      t: new Date(fromMs + bucketIndex * 3_600_000).toISOString(),
      value: scenario === 'empty-range' || (scenario === 'finite-outside-viewport' && fromMs + (bucketIndex + 1) * 3_600_000 > FIXTURE_NOW - 24 * 3_600_000)
        ? null
        : scenario === 'invalid-average' && bucketIndex === 2 ? -1 : 18 + seriesIndex * 2 + Math.sin(bucketIndex / 6),
      count: 1,
      quality: 'ok',
    })),
  });
  let selectedRows = requestedRows;
  let dropped: Array<{ seriesId: string | null; reason: string }> = [];
  if (scenario === 'missing-source' && dropNamedSource && selectedRows.some((row) => String(row.seriesId) === DROPPED_SERIES_ID)) {
    selectedRows = selectedRows.filter((row) => String(row.seriesId) !== DROPPED_SERIES_ID);
    dropped = [{ seriesId: DROPPED_SERIES_ID, reason: 'source_missing' }];
  }
  if (scenario === 'access-denied-source' && dropNamedSource && selectedRows.some((row) => String(row.seriesId) === DROPPED_SERIES_ID)) {
    selectedRows = selectedRows.filter((row) => String(row.seriesId) !== DROPPED_SERIES_ID);
    dropped = [{ seriesId: DROPPED_SERIES_ID, reason: 'access_denied' }];
  }
  return {
    generatedAt: new Date(FIXTURE_NOW).toISOString(),
    range: { label: String(range.label), from, to, timezone: FIXTURE_TIME_ZONE },
    aggregation: { requested: 'hourly', applied: 'hourly', bucketSizeSeconds: 3_600 },
    series: selectedRows.map(makeSeries),
    dropped,
  };
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

export async function installMobileHistoryFixtures(page: Page, options: MobileHistoryFixtureOptions = {}): Promise<MobileHistoryFixture> {
  const enabled = options.enabled ?? true;
  const rows = sourceRows(Math.max(0, (options.catalogRows ?? 8) - 8));
  const requests: MobileHistoryRequestRecord[] = [];
  const unexpectedApiRequests: string[] = [];
  const contractErrors: string[] = [];
  const failedRequests: string[] = [];
  const abortedRequests: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let scenario = options.scenario ?? 'normal';
  let scenarioFailureConsumed = false;
  let delayedSeriesRequestNumber: number | null = scenario === 'stale' ? 1 : null;
  let disposed = false;
  const recordsByRequest = new WeakMap<Request, MobileHistoryRequestRecord>();

  await page.addInitScript(({ now, token }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('username', 'mobile-history-fixture');
    Date.now = () => now;
  }, { now: FIXTURE_NOW, token: EDGE_TOKEN });

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', (request) => {
    if (!isApiPath(new URL(request.url()).pathname)) return;
    const matching = recordsByRequest.get(request);
    const detail = request.failure()?.errorText ?? 'failed';
    const entry = `${request.method()} ${new URL(request.url()).pathname}: ${detail}`;
    if (ABORTED.test(detail)) {
      abortedRequests.push(entry);
      if (matching) {
        matching.releasedAt = Date.now();
        matching.outcome = 'aborted';
      }
    }
    else failedRequests.push(entry);
  });

  const record = (route: Route, role: string, body: unknown): MobileHistoryRequestRecord => {
    const request = route.request();
    const value: MobileHistoryRequestRecord = {
      method: request.method(), pathname: new URL(request.url()).pathname, body,
      authorization: request.headers().authorization ?? null, startedAt: Date.now(), releasedAt: null,
      status: null, bytes: 0, delayMs: 0, role, outcome: null,
    };
    requests.push(value);
    recordsByRequest.set(request, value);
    return value;
  };

  const fulfillJson = async (route: Route, recordValue: MobileHistoryRequestRecord, status: number, body: unknown, delayed: boolean | number = false) => {
    const payload = JSON.stringify(body);
    recordValue.bytes = Buffer.byteLength(payload, 'utf8');
    recordValue.delayMs = typeof delayed === 'number' ? delayed : delayed ? responseDelay(recordValue.bytes) : 0;
    if (delayed && recordValue.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, recordValue.delayMs));
    try {
      await route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: payload });
      if (recordValue.outcome !== 'aborted') {
        recordValue.status = status;
        recordValue.releasedAt = Date.now();
        recordValue.outcome = 'fulfilled';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordValue.releasedAt = Date.now();
      if (ABORTED.test(message)) { recordValue.outcome = 'aborted'; return; }
      recordValue.outcome = 'error';
      throw error;
    }
  };

  const routeHandler = async (route: Route): Promise<void> => {
    if (disposed) { await route.abort(); return; }
    const url = new URL(route.request().url());
    if (!isApiPath(url.pathname)) { await route.fallback(); return; }
    const method = route.request().method();
    const body = method === 'POST' ? requestBody(route.request()) : null;
    const path = url.pathname;
    const known = method === 'GET' && path === '/api/me'
      || method === 'GET' && path === '/api/system/stats'
      || method === 'GET' && path === '/api/system/features'
      || method === 'GET' && path === '/api/irrigation-zones'
      || method === 'GET' && path === '/api/analysis/channels'
      || method === 'POST' && path === '/api/analysis/series';
    if (!known || (!enabled && (path === '/api/analysis/channels' || path === '/api/analysis/series'))) {
      unexpectedApiRequests.push(`${method} ${path}`);
      await route.abort('failed');
      return;
    }

    if (method === 'GET' && path === '/api/me') {
      await fulfillJson(route, record(route, 'auth-profile', null), 200, { username: FIXTURE_USERNAME, user_uuid: FIXTURE_USER_UUID, role: 'viewer', zone_uuids: null, plot_uuids: null, features: { scoped_access: false } });
    } else if (method === 'GET' && path === '/api/system/stats') {
      await fulfillJson(route, record(route, 'gateway-stats', null), 200, edgeStats());
    } else if (method === 'GET' && path === '/api/system/features') {
      await fulfillJson(route, record(route, 'feature-flags', null), 200, features);
    } else if (method === 'GET' && path === '/api/irrigation-zones') {
      await fulfillJson(route, record(route, 'zones', null), 200, edgeZone());
    } else if (method === 'GET' && path === '/api/analysis/channels') {
      const item = record(route, 'catalog', null);
      const status = options.catalogStatus ?? (scenario === 'auth-401' ? 401 : scenario === 'auth-403' ? 403 : 200);
      await fulfillJson(route, item, status, status === 200 ? { generatedAt: new Date(FIXTURE_NOW).toISOString(), channels: rows } : { code: status === 500 ? 'temporary_failure' : 'access_denied', detail: status === 500 ? 'temporary fixture failure' : 'fixture authorization response' }, true);
    } else {
      const item = record(route, `series-${requests.filter((entry) => entry.pathname === path).length + 1}`, body);
      const requestErrors = validateSeriesRequest(rows, body ?? {});
      if (requestErrors.length > 0) {
        contractErrors.push(...requestErrors.map((error) => `${item.role}: ${error}`));
      }
      const status = scenario === 'auth-401' ? 401 : scenario === 'auth-403' ? 403 : scenario === 'range-too-large' ? 413 : scenario === 'transient' ? 500 : 200;
      if (status !== 200) {
        await fulfillJson(route, item, status, { code: status === 413 ? 'range_too_large' : status === 500 ? 'temporary_failure' : 'access_denied', detail: 'fixture response' }, false);
      } else {
        const seriesRequestNumber = requests.filter((entry) => entry.pathname === path).length;
        const delay = (scenario === 'stale' || scenario === 'pending-addition') && seriesRequestNumber === delayedSeriesRequestNumber ? 5_000 : true;
        const dropNamedSource = !scenarioFailureConsumed;
        await fulfillJson(route, item, status, seriesResponse(rows, body ?? {}, scenario, dropNamedSource), delay);
        if (scenario === 'missing-source' || scenario === 'access-denied-source') scenarioFailureConsumed = true;
      }
    }
  };

  await page.route('**/*', routeHandler);

  const dispose = async () => {
    disposed = true;
    try {
      await page.unroute('**/*', routeHandler);
    } catch (error) {
      if (!/Target page, context or browser has been closed/i.test(String(error))) throw error;
    }
  };

  return {
    requests,
    unexpectedApiRequests,
    contractErrors,
    failedRequests,
    abortedRequests,
    pageErrors,
    consoleErrors,
    setScenario(next) {
      scenario = next;
      scenarioFailureConsumed = false;
      delayedSeriesRequestNumber = next === 'stale'
        || next === 'pending-addition'
        ? requests.filter((entry) => entry.pathname === '/api/analysis/series').length + 1
        : null;
    },
    seriesRequests: () => requests.filter((request) => request.pathname === '/api/analysis/series'),
    catalogRequests: () => requests.filter((request) => request.pathname === '/api/analysis/channels'),
    async waitForSeries(count = 1) {
      const deadline = Date.now() + 20_000;
      while (requests.filter((request) => request.pathname === '/api/analysis/series' && request.outcome === 'fulfilled').length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} fulfilled series request(s)`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    dispose,
  };
}

export function expectedSeriesIds(rows = EXPECTED_SERIES): string[] {
  return rows.map(([, , id]) => id);
}

export function bucketCountForRequest(record: MobileHistoryRequestRecord): number {
  const body = record.body as { range?: { from?: string; to?: string } };
  return Math.ceil((Date.parse(body.range?.to ?? '') - Date.parse(body.range?.from ?? '')) / 3_600_000);
}
