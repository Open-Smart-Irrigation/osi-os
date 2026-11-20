import { expect, test } from '@playwright/test';
import { EDGE_TOKEN, FIXTURE_NOW, FIXTURE_USER_UUID, FIXTURE_ZONE_UUID } from './mobile-history-fixtures';

const cardId = 'fixture-soil';
const range = { label: '24h', from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00Z', timezone: 'UTC' };
const channel = {
  seriesId: 'fixture-pressure',
  sourceKey: 'fixture-uc512',
  sourceKind: 'device',
  deviceSourceId: 'fixture-uc512',
  deviceName: 'Fixture UC512',
  hubEui: null,
  zoneId: 1,
  zoneName: 'North plot',
  cardType: 'irrigation',
  channelKey: 'pipe_pressure_kpa',
  displayName: 'Pipe pressure',
  unit: 'kPa',
  availability: 'available',
  depthCm: null,
};
const staleWorkspace = {
  schemaVersion: 1, selectors: [{ seriesId: channel.seriesId }],
  mode: 'correlation', layout: 'overlaid', toggles: { normalize: true },
};
const features = {
  historyUxEnabled: true, historyComparisonEnabled: true, historyWorkspacesEnabled: true,
  historyAdvancedOverlaysEnabled: true, historyCloudAiEnabled: true,
};

test('1.0 packaged GUI keeps the legacy phone route and desktop data chart', async ({ page }, testInfo) => {
  const desktop = testInfo.project.name === 'release-feed';
  const unavailableRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const cardRequests: string[] = [];
  const seriesRequests: unknown[] = [];
  await page.addInitScript(({ now, token, workspace }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('username', 'fixture');
    localStorage.setItem('osi.analysis.workspace.v1', JSON.stringify(workspace));
    Date.now = () => now;
  }, { now: FIXTURE_NOW, token: EDGE_TOKEN, workspace: staleWorkspace });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (data: unknown, status = 200) => route.fulfill({ json: data, status });
    expect(req.headers().authorization).toBe(`Bearer ${EDGE_TOKEN}`);
    if (/\/workspaces|\/views|\/advanced/.test(url.pathname)) {
      unavailableRequests.push(url.pathname);
      return json({}, 404);
    }
    switch (url.pathname) {
      case '/api/me':
        return json({ username: 'fixture', user_uuid: FIXTURE_USER_UUID, role: 'admin', features: { scoped_access: false } });
      case '/api/system/features':
        return json({ features });
      case '/api/system/settings':
        return json({ dataModuleEnabled: true, gatewayHubModuleEnabled: false });
      case '/api/irrigation-zones':
        return json([{ id: 1, name: 'North plot', zone_uuid: FIXTURE_ZONE_UUID, timezone: 'UTC', device_count: 0, schedule: null }]);
      case '/api/devices':
        return json([]);
      case '/api/irrigation-zones/1/environment-summary':
        return json(null);
      case '/api/history/zones/1/cards':
        return json({ zoneId: 1, cards: [{
          cardId, cardType: 'soil', scope: 'zone', title: 'Soil Moisture',
          defaultView: 'line-chart', views: ['line-chart', 'advanced'], supportedRanges: ['24h', '7d'], defaultRange: '24h',
          metadata: {}, availability: { available: true, reasons: [] }, ordering: { pinned: false },
        }] });
      case `/api/history/zones/1/cards/${cardId}/data`:
        cardRequests.push(url.searchParams.get('view') ?? '');
        return json({
          cardId, cardType: 'soil', view: 'line-chart', range,
          aggregation: { level: 'raw', coverageConfidence: 'configured' }, limits: {},
          series: [], profiles: [], events: [], calendar: null, interpretations: [],
          freshness: { syncState: 'local' }, advancedFields: {},
        });
      case '/api/analysis/channels':
        return json({ channels: [channel] });
      case '/api/analysis/series':
        seriesRequests.push(req.postDataJSON());
        return json({ range, aggregation: { applied: 'hourly' }, series: [{
          seriesId: channel.seriesId, resolved: channel, label: channel.displayName, unit: channel.unit,
          points: [{ t: range.from, value: 30, count: 1, quality: 'ok' }],
        }] });
      default:
        return json({});
    }
  });

  await page.goto('./#/internal/mobile-history/zones/1');
  await expect(page).toHaveURL(/#\/history$/);
  expect(seriesRequests).toHaveLength(0);
  expect(await page.evaluate(() => window.__osiMobileHistoryDiagnostics)).toBeUndefined();

  if (desktop) {
    await page.goto('./#/analysis?mode=correlation&layout=overlaid');
    await expect(page.getByTestId('analysis-chart-shell').locator('canvas')).toBeVisible();
    expect(seriesRequests).toEqual([expect.objectContaining({ selectors: [{ seriesId: channel.seriesId }] })]);
    await expect(page.getByRole('button', { name: 'Correlation' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Overlay' })).toHaveCount(0);
    await page.locator('summary').filter({ hasText: 'Export' }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toMatch(/\.csv$/);
  } else {
    await page.goto('./#/dashboard');
    await page.locator('a[href="#/history/zones/1"]').click();
    await expect.poll(() => cardRequests).toContain('line-chart');
    await expect(page.locator('.uplot')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open card settings' }).click();
    await expect(page.getByRole('menuitem', { name: 'Advanced View' })).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('./#/analysis');
    await expect(page).toHaveURL(/#\/history$/);
    await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Soil Moisture history' })).toBeVisible();
    expect(seriesRequests).toHaveLength(0);
  }
  expect(unavailableRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
