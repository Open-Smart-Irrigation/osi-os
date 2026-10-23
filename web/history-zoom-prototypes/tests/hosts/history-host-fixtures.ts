import type { Page, Request, Route } from '@playwright/test';

export type HostPlatform = 'edge' | 'cloud';
export interface HostHistoryHarness { requests: Request[]; setEmpty(value: boolean): void; dispose(): Promise<void> }

const token = 'host-fixture-token';
const zone = { id: 7, zoneUuid: '11111111-1111-4111-8111-111111111111', zone_uuid: '11111111-1111-4111-8111-111111111111', name: 'Test zone', userId: 1, devices: [], deviceCount: 2, createdAt: '2026-04-11T00:00:00Z', updatedAt: '2026-04-11T00:00:00Z' };
const cards = [{
  cardId: 'soil-card', cardType: 'soil', title: 'Soil', subtitle: 'Probe', defaultView: 'soil-profile', views: ['soil-profile', 'line-chart'],
  supportedRanges: ['24h', '7d', '30d'], defaultRange: '24h', sourceDeviceCount: 2,
  sourceDevices: [{ name: 'Probe 1', sourceKey: 'probe-1', role: 'soil' }, { name: 'Probe 2', sourceKey: 'probe-2', role: 'soil' }], sourceLabel: 'Probe 1', sourceLabels: ['Probe 1', 'Probe 2'],
  metadata: { coveragePct: 100, coverageConfidence: 'configured', syncState: 'synced' }, ordering: { pinned: false, score: 1, recentRank: 1 },
  availability: { available: true, reasons: [] }, requiredCapabilities: [], standardOverlays: [], advancedOverlays: [],
}];

function responseFor(url: URL, platform: HostPlatform, emptyData: boolean, soilSeriesCount: number): unknown {
  if (url.pathname.endsWith('/system/features')) {
    const features = { historyUxEnabled: true, historyComparisonEnabled: false, historyWorkspacesEnabled: false, historyAdvancedOverlaysEnabled: false, historyCloudAiEnabled: false };
    return platform === 'edge' ? { features } : features;
  }
  if (url.pathname.endsWith('/users/me') || url.pathname.endsWith('/me')) return { id: 1, username: 'fixture-user', user_uuid: 'fixture-user', role: platform === 'cloud' ? 'USER' : 'viewer', enabled: true, zone_uuids: [zone.zoneUuid], plot_uuids: [], features: { scoped_access: false } };
  if (url.pathname.endsWith('/user/module-preferences')) return { modules: {} };
  if (url.pathname.endsWith('/users/me/linked-gateways')) return [];
  if (url.pathname.endsWith('/system/stats')) return { restartPending: null };
  if (url.pathname.endsWith('/devices')) return [{ deveui: 'fixture-device-1', name: 'Probe 1', type: 'KIWI_SENSOR', zone_id: 7 }, { deveui: 'fixture-device-2', name: 'Probe 2', type: 'KIWI_SENSOR', zone_id: 7 }];
  if (url.pathname.includes('/cards') && !url.pathname.endsWith('/data')) return { generatedAt: new Date().toISOString(), cards };
  if (url.pathname.includes('/data')) {
    const from = url.searchParams.get('from') ?? new Date(Date.now() - 86_400_000).toISOString();
    const to = url.searchParams.get('to') ?? new Date().toISOString();
    const empty = emptyData;
    const times = [.2, .4, .6, .8].map(f => new Date(Date.parse(from) + f * (Date.parse(to) - Date.parse(from))).toISOString());
    const series = [
      { id: 'probe-1', label: 'Soil tension', unit: 'kPa', values: [12, 0, null, 13] },
      { id: 'probe-2', label: 'Deep tension', unit: 'kPa', values: [18, 19, 20, 21] },
      { id: 'temperature', label: 'Soil temperature', unit: '°C', values: [21, 22, 23, 24] },
      ...Array.from({ length: Math.max(0, soilSeriesCount - 2) }, (_, index) => ({ id: `soil-extra-${index + 1}`, label: `Long soil channel ${index + 1} with a descriptive name`, unit: 'kPa', values: [14 + index, 15 + index, 16 + index, 17 + index] })),
    ].map(({ values, ...definition }) => ({ ...definition, points: times.map((t, i) => ({ t, value: values[i], coverageConfidence: 'derived' })) }));
    return { cardId: 'soil-card', cardType: 'soil', view: url.searchParams.get('view') ?? 'line-chart', range: { label: url.searchParams.get('range') ?? '24h', from, to, timezone: 'UTC' }, aggregation: { level: url.searchParams.get('aggregation') ?? '15m', bucketSizeSeconds: 900, coveragePct: empty ? 0 : 100, coverageConfidence: 'configured', pointCount: empty ? 0 : series.length * times.length }, limits: { maxPointsPerSeries: 1000, maxEvents: 0, maxInterpretations: 0, truncated: false }, series: empty ? [] : series, profiles: [], events: [], calendar: null, interpretations: [], freshness: { dataAsOf: to, syncState: 'synced' }, advancedFields: {} };
  }
  if (url.pathname.match(/\/irrigation-zones\/7$/)) return zone;
  if (url.pathname.endsWith('/irrigation-zones')) return [zone];
  return undefined;
}

export async function installHistoryHost(page: Page, platform: HostPlatform, delayData = false, emptyData = false, soilSeriesCount = 2): Promise<HostHistoryHarness> {
  const requests: Request[] = [];
  let emptyPending = emptyData;
  let emptyAll = false;
  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      requests.push(request);
      if (delayData && url.pathname.includes('/data')) await new Promise((resolve) => setTimeout(resolve, 500));
      const lineData = url.pathname.endsWith('/data') && url.searchParams.get('view') === 'line-chart';
      const body = responseFor(url, platform, emptyAll || (emptyPending && lineData), soilSeriesCount);
      if (emptyPending && lineData) emptyPending = false;
      await route.fulfill({ status: body === undefined ? 404 : 200, contentType: 'application/json', body: JSON.stringify(body ?? { message: 'unconfigured fixture endpoint' }) });
      return;
    }
    await route.fallback();
  };
  await page.route('**/*', handler);
  if (platform === 'cloud') {
    await page.routeWebSocket('**/ws', socket => {
      socket.onMessage(message => {
        if (String(message).startsWith('CONNECT')) socket.send('CONNECTED\nversion:1.2\nheart-beat:0,0\n\n\0');
      });
    });
  }
  await page.addInitScript(({ value }) => {
    localStorage.setItem('auth_token', value);
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('i18n_language', 'en');
    localStorage.setItem('locale', 'en');
  }, { value: token });
  return { requests, setEmpty: value => { emptyAll = value; }, dispose: () => page.unroute('**/*', handler) };
}

export function historyDataRequests(harness: HostHistoryHarness) {
  return harness.requests.filter((request) => request.url().includes('/cards/soil-card/data'));
}
