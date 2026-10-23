import { expect, test, type CDPSession, type Page, type Route } from '@playwright/test';
import { cardDataForRequest, countDataRequests, findDataRequest, installPilotApi, pendingDataFor, requestBounds, sameRequest, type PilotApiHarness, type PilotHarnessOptions, type PilotPlatform, type RecordedRequest } from './pilot-fixtures';
import { currentPlot, probe, rendererError, settle, span, viewportDistance } from './browser-helpers';
import { dispatchTouchSequence, panPoints, pinchPoints } from './cdp-touch';
import { minuteViewport, requestForViewport } from '../../src/pilot/range';

const TOKEN = 'pilot-browser-token';
const platformPrefix = (platform: PilotPlatform) => platform === 'edge' ? '/api/' : '/api/v1/';
const loginHref = (platform: PilotPlatform) => platform === 'edge' ? '/gui/#/login' : '/login';

async function authenticated(page: Page, platform: PilotPlatform, options: PilotHarnessOptions = {}): Promise<PilotApiHarness> {
  const harness = await installPilotApi(page, platform, options);
  await page.addInitScript((token) => localStorage.setItem('auth_token', token), TOKEN);
  await page.goto(`./#/pilot/${platform}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pilot-shell')).toBeVisible();
  await expect(page.getByTestId('chart-host')).toBeVisible();
  await expect(page.getByTestId('pilot-load-status')).toHaveText(/ready/i);
  return harness;
}

async function installOneShotResponse(page: Page, predicate: (request: RecordedRequest) => boolean, status: number, body: unknown | ((request: RecordedRequest) => unknown), record?: (request: RecordedRequest) => void): Promise<void> {
  const handler = async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    const request: RecordedRequest = { pathname: url.pathname, search: url.search, authorization: route.request().headers().authorization ?? null, origin: url.origin, startedAt: Date.now() };
    if (!predicate(request)) { await route.fallback(); return; }
    record?.(request);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(typeof body === 'function' ? body(request) : body) });
    request.releasedAt = Date.now(); request.status = status;
    await page.unroute('**/*', handler);
  };
  await page.route('**/*', handler);
}

async function pointX(page: Page, fraction: number): Promise<number> {
  const plot = await currentPlot(page);
  return plot.plotRect.left + plot.plotRect.width * fraction;
}

function pastNeighborBounds(request: RecordedRequest): { from: string; to: string; aggregation: string } {
  const bounds = requestBounds(request);
  const from = Date.parse(bounds.from);
  const to = Date.parse(bounds.to);
  const shift = (to - from) * 0.8;
  return { from: new Date(from - shift).toISOString(), to: new Date(to - shift).toISOString(), aggregation: bounds.aggregation };
}

function pastNeighborBoundsFromViewport(viewport: { from: number; to: number }, aggregation: string): { from: string; to: string; aggregation: string } {
  const shift = (viewport.to - viewport.from) * 0.8;
  return { from: new Date(viewport.from - shift).toISOString(), to: new Date(viewport.to - shift).toISOString(), aggregation };
}

function acceptedRangeText(request: RecordedRequest): string {
  const bounds = requestBounds(request);
  return `${new Date(bounds.from).toLocaleString()} – ${new Date(bounds.to).toLocaleString()}`;
}

test.describe('real-history pilot', () => {
  let activeHarness: PilotApiHarness | undefined;
  let activeCdp: CDPSession | undefined;
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); });
  test.afterEach(async () => {
    if (activeCdp) { await activeCdp.detach().catch(() => undefined); activeCdp = undefined; }
    if (activeHarness) { await activeHarness.dispose(); activeHarness = undefined; }
  });

  for (const platform of ['edge', 'cloud'] as const) {
    test(`uses ${platform} API prefixes, authorization, and login target`, async ({ page }) => {
      activeHarness = await installPilotApi(page, platform);
      await page.goto('./#/uplot', { waitUntil: 'networkidle' });
      const expectedOrigin = new URL(page.url()).origin;
      const foreign: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== expectedOrigin) foreign.push(request.url());
      });
      await page.evaluate(() => localStorage.removeItem('auth_token'));
      await page.goto(`./#/pilot/${platform}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('pilot-login-required')).toBeVisible();
      expect(activeHarness.requests).toEqual([]);
      await expect(page.getByTestId('pilot-login-link')).toHaveAttribute('href', loginHref(platform));
      await page.evaluate((token) => localStorage.setItem('auth_token', token), TOKEN);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('chart-host')).toBeVisible();
      await expect(page.getByTestId('pilot-load-status')).toHaveText(/ready/i);
      expect(activeHarness.requests.length).toBeGreaterThan(0);
      expect(activeHarness.requests.every((request) => request.pathname.startsWith(platformPrefix(platform)))).toBe(true);
      if (platform === 'edge') expect(activeHarness.requests.every((request) => !request.pathname.startsWith('/api/v1/'))).toBe(true);
      expect(activeHarness.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(activeHarness.requests.every((request) => request.origin === expectedOrigin)).toBe(true);
      expect(foreign).toEqual([]);
      const pageText = await page.locator('body').innerText();
      const markup = await page.locator('body').evaluate((node) => node.outerHTML);
      expect(`${pageText}\n${markup}\n${page.url()}`).not.toContain(TOKEN);
    });
  }

  test('keeps native pinch and pan fluid while replacement data is pending', async ({ page }) => {
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1 });
    const acceptedChartBox = await page.getByTestId('chart-host').boundingBox();
    await page.getByTestId('pilot-range-7d').click();
    await expect(page.getByTestId('pilot-load-status')).toHaveText('Ready');
    await expect(page.getByTestId('pilot-refresh-status')).toHaveText('Updating nearby history…');
    await expect(page.locator('.pilot-loading-overlay')).toHaveCount(0);
    const refreshingChartBox = await page.getByTestId('chart-host').boundingBox();
    expect(refreshingChartBox).toEqual(acceptedChartBox);
    const afterPreset = await currentPlot(page);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: Array<{ url: string; error: string }> = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
    activeCdp = await page.context().newCDPSession(page);
    await dispatchTouchSequence(activeCdp, pinchPoints(afterPreset.plotRect, { startGap: 70, endGap: 150, startCenterFraction: 0.45, endCenterFraction: 0.55, steps: 16, pauseMs: 8 }));
    await settle(page);
    await page.waitForTimeout(200);
    const afterPinch = await probe(page);
    expect(await page.getByTestId('chart-host').count()).toBe(1);
    expect(afterPinch.viewportNotifications).toBeGreaterThan(afterPreset.viewportNotifications);
    expect(Math.abs(span(afterPinch.renderedViewport) / span(afterPreset.renderedViewport) - 70 / 150)).toBeLessThanOrEqual(0.05);
    expect(rendererError(afterPinch)).toBeLessThanOrEqual(1);
    const beforePan = await currentPlot(page);
    const acceptedRangeBeforePan = await page.getByTestId('pilot-accepted-range').innerText();
    await dispatchTouchSequence(activeCdp, panPoints(beforePan.plotRect, { fromX: beforePan.plotRect.width * 0.55, toX: beforePan.plotRect.width * 0.35, steps: 12, pauseMs: 8 }));
    await settle(page);
    const afterPan = await probe(page);
    expect(Math.abs(span(afterPan.renderedViewport) - span(beforePan.renderedViewport))).toBeLessThanOrEqual(1);
    expect(viewportDistance(beforePan.renderedViewport, afterPan.renderedViewport)).toBeGreaterThan(span(beforePan.renderedViewport) * 0.05);
    const requestedPan = requestForViewport(minuteViewport(afterPan.renderedViewport));
    const minutePan = minuteViewport(afterPan.renderedViewport);
    await expect.poll(() => pendingDataFor(activeHarness!, (bounds) => bounds.aggregation === requestedPan.aggregation && Date.parse(bounds.from) <= minutePan.from && Date.parse(bounds.to) >= minutePan.to)).toBeTruthy();
    await page.touchscreen.tap(afterPan.plotRect.left + afterPan.plotRect.width * 0.5, afterPan.plotRect.top + afterPan.plotRect.height * 0.5);
    await expect(page.getByTestId('inspector')).toBeVisible();
    await page.getByTestId('inspector-close').click();
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    const beforeResponse = await probe(page);
    const deferredReplies = [...activeHarness.pendingData];
    const deferredUrls = new Set(deferredReplies.map((reply) => new URL(`${reply.request.pathname}${reply.request.search}`, reply.request.origin).href));
    await activeHarness.releaseAll(200, (request) => cardDataForRequest(request));
    await expect(page.getByTestId('pilot-refresh-status')).toHaveText('');
    await expect(page.getByTestId('pilot-refresh-status')).toHaveAttribute('aria-hidden', 'true');
    expect(activeHarness.activeDataRequests()).toBe(0);
    const afterResponse = await probe(page);
    await expect(page.getByTestId('pilot-accepted-range')).not.toHaveText(acceptedRangeBeforePan);
    expect(viewportDistance(beforeResponse.renderedViewport, afterResponse.renderedViewport)).toBeLessThanOrEqual(1);
    expect(rendererError(afterResponse)).toBeLessThanOrEqual(1);
    await Promise.all(deferredReplies.map((reply) => reply.done));
    await page.setViewportSize({ width: 844, height: 390 });
    await settle(page);
    const landscape = await currentPlot(page);
    expect(landscape.plotRect.width).not.toBe(afterResponse.plotRect.width);
    expect(viewportDistance(afterResponse.renderedViewport, landscape.renderedViewport)).toBeLessThanOrEqual(1);
    await dispatchTouchSequence(activeCdp, pinchPoints(landscape.plotRect, { startGap: 150, endGap: 70, startCenterFraction: 0.55, endCenterFraction: 0.45, steps: 12, pauseMs: 8 }));
    await settle(page);
    await page.waitForTimeout(200);
    const landscapeReplies = [...activeHarness.pendingData];
    landscapeReplies.forEach((reply) => deferredUrls.add(new URL(`${reply.request.pathname}${reply.request.search}`, reply.request.origin).href));
    if (landscapeReplies.length > 0) {
      await activeHarness.releaseAll(200, (request) => cardDataForRequest(request));
      await Promise.all(landscapeReplies.map((reply) => reply.done));
      await expect(page.getByTestId('pilot-refresh-status')).toHaveText('');
    }
    expect(span((await probe(page)).renderedViewport)).not.toBe(span(landscape.renderedViewport));
    expect(rendererError(await probe(page))).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    for (const failure of failedRequests) {
      expect(failure.error).toMatch(/net::ERR_ABORTED|Route is already handled|Request context disposed|Target page, context or browser has been closed/i);
      expect(deferredUrls.has(failure.url)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('revoking a token fences a pending response', async ({ page }) => {
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1 });
    await page.getByTestId('pilot-range-7d').click();
    await expect.poll(() => pendingDataFor(activeHarness!, (_bounds, request) => request.search.includes('range=7d'))).toBeTruthy();
    await page.evaluate(() => localStorage.removeItem('auth_token'));
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', oldValue: 'pilot-browser-token', newValue: null, storageArea: window.localStorage })));
    await expect(page.getByTestId('pilot-login-required')).toBeVisible();
    await expect(page.getByTestId('chart-host')).toHaveCount(0);
    await expect(page.getByTestId('pilot-accepted-range')).toHaveCount(0);
    await expect(page.getByTestId('pilot-point-count')).toHaveCount(0);
    await activeHarness.releaseAll(200, (request) => cardDataForRequest(request));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.locator('body').innerText()).not.toMatch(/20 cm|40 cm|Air temperature/);
    const bodyHtml = await page.locator('body').evaluate((node) => node.outerHTML);
    expect(`${bodyHtml}\n${page.url()}`).not.toContain(TOKEN);
  });

  test('isolates units and preserves null versus zero in inspection', async ({ page }) => {
    activeHarness = await authenticated(page, 'edge');
    await expect(page.getByTestId('pilot-unit-select')).toHaveValue('kPa');
    await expect(page.getByTestId('pilot-legend')).toContainText('20 cm');
    await expect(page.getByTestId('pilot-legend')).toContainText('40 cm');
    await expect(page.getByTestId('pilot-legend')).not.toContainText('Air temperature');
    await expect(page.getByTestId('pilot-series-toggle-swt-20')).toBeChecked();
    await expect(page.getByTestId('pilot-series-toggle-swt-40')).toBeChecked();
    await page.touchscreen.tap(await pointX(page, 0.4), (await currentPlot(page)).plotRect.top + 40);
    await expect(page.getByTestId('inspector')).toContainText(/20 cm.*0\s*kPa/s);
    await page.getByTestId('inspector-close').click();
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await page.touchscreen.tap(await pointX(page, 0.6), (await currentPlot(page)).plotRect.top + 40);
    await expect(page.getByTestId('inspector')).toContainText(/20 cm.*Unavailable at this sample/s);
    await expect(page.getByTestId('inspector')).toContainText(/40 cm.*20\s*kPa/s);
    await page.getByTestId('inspector-close').click();
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await page.getByTestId('pilot-series-toggle-swt-40').uncheck();
    await expect(page.getByTestId('pilot-legend')).not.toContainText('40 cm');
    await page.touchscreen.tap(await pointX(page, 0.6), (await currentPlot(page)).plotRect.top + 40);
    await expect(page.getByTestId('inspector')).not.toContainText('40 cm');
    await page.getByTestId('inspector-close').click();
    await page.getByTestId('pilot-series-toggle-swt-40').check();
    await expect(page.getByTestId('pilot-legend')).toContainText('40 cm');
    await page.getByTestId('pilot-unit-select').selectOption('C');
    await expect(page.getByTestId('pilot-legend')).toContainText('Air temperature');
    await expect(page.getByTestId('pilot-legend')).not.toContainText('20 cm');
    await page.touchscreen.tap(await pointX(page, 0.6), (await currentPlot(page)).plotRect.top + 40);
    await expect(page.getByTestId('inspector')).toContainText('Air temperature');
    await expect(page.getByTestId('inspector')).not.toContainText('20 cm');
    await expect(page.getByTestId('inspector')).not.toContainText('40 cm');
    await page.getByTestId('inspector-close').click();
    await page.getByTestId('pilot-unit-select').selectOption('kPa');
    await expect(page.getByTestId('pilot-legend')).toContainText('20 cm');
    await expect(page.getByTestId('pilot-legend')).toContainText('40 cm');
    await expect(page.getByTestId('pilot-legend')).not.toContainText('Air temperature');
    expect(activeHarness.dataRequests.every((request) => !request.search.includes('sourceKey'))).toBe(true);
  });

  test('keeps the latest accepted response when an older response resolves later', async ({ page }) => {
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1 });
    await page.getByTestId('pilot-range-7d').click();
    await expect.poll(() => pendingDataFor(activeHarness!, (_bounds, request) => request.search.includes('range=7d'))).toBeTruthy();
    await page.getByTestId('pilot-range-30d').click();
    await expect.poll(() => pendingDataFor(activeHarness!, (_bounds, request) => request.search.includes('range=30d'))).toBeTruthy();
    const oldRequest = findDataRequest(activeHarness, (_bounds, request) => request.search.includes('range=7d'))!;
    const latestRequest = findDataRequest(activeHarness, (_bounds, request) => request.search.includes('range=30d'))!;
    const latestSeries = [{ id: 'latest-series', label: 'Latest window', unit: 'kPa', points: [{ t: new Date(Date.parse(new URLSearchParams(latestRequest.search).get('from')!)).toISOString(), value: 7 }] }];
    const oldSeries = [{ id: 'old-series', label: 'Old window', unit: 'kPa', points: [{ t: new Date(Date.parse(new URLSearchParams(oldRequest.search).get('from')!)).toISOString(), value: 3 }] }];
    const latestReply = pendingDataFor(activeHarness, (_bounds, request) => request.search.includes('range=30d'))!;
    latestReply.resolve(200, cardDataForRequest(latestRequest, { series: latestSeries }));
    await latestReply.done;
    await expect(page.getByTestId('pilot-legend')).toContainText('Latest window');
    await expect(page.getByTestId('pilot-legend')).not.toContainText('Old window');
    const acceptedLatest = await page.getByTestId('pilot-accepted-range').innerText();
    const oldReply = pendingDataFor(activeHarness, (_bounds, request) => request.search.includes('range=7d'))!;
    oldReply.resolve(200, cardDataForRequest(oldRequest, { series: oldSeries }));
    expect(await oldReply.done).toMatch(/fulfilled|aborted/);
    await page.waitForTimeout(100);
    await expect(page.getByTestId('pilot-accepted-range')).toHaveText(acceptedLatest);
    await expect(page.getByTestId('pilot-legend')).toContainText('Latest window');
    await expect(page.getByTestId('pilot-legend')).not.toContainText('Old window');
  });

  test('reports truncation and narrows to raw 24 hour data', async ({ page }) => {
    activeHarness = await authenticated(page, 'edge');
    await installOneShotResponse(page, (request) => request.search.includes('range=30d'), 200, (request: RecordedRequest) => cardDataForRequest(request, { truncated: true, aggregation: { level: 'daily', pointCount: 2000 } }), (request) => activeHarness?.dataRequests.push(request));
    await page.getByTestId('pilot-range-30d').click();
    await expect(page.getByTestId('pilot-load-status')).toHaveText(/ready/i);
    await expect(page.getByTestId('pilot-truncated')).toContainText(/incomplete/i);
    await expect(page.getByTestId('pilot-aggregation')).toContainText(/Daily/i);
    await expect(page.getByTestId('pilot-point-count')).toContainText('2,000');
    const requestsBeforeNarrow = activeHarness.dataRequests.length;
    await page.getByTestId('pilot-show-24h').click();
    await expect.poll(() => activeHarness?.dataRequests.length ?? 0).toBe(requestsBeforeNarrow + 1);
    const request = activeHarness.dataRequests.at(-1)!;
    const params = new URLSearchParams(request.search);
    expect(params.get('aggregation')).toBe('raw');
    expect(Date.parse(params.get('to')!) - Date.parse(params.get('from')!)).toBeLessThanOrEqual(86_400_000);
    await expect(page.getByTestId('pilot-truncated')).toHaveCount(0);
    await expect(page.getByTestId('chart-host')).toBeVisible();
  });

  test('keeps controls usable for an accepted empty response', async ({ page }) => {
    activeHarness = await installPilotApi(page, 'edge');
    await page.addInitScript((token) => localStorage.setItem('auth_token', token), TOKEN);
    await installOneShotResponse(page, (request) => request.pathname.endsWith('/data'), 200, (request: RecordedRequest) => cardDataForRequest(request, { series: [], aggregation: { level: 'raw', pointCount: 0 } }));
    await page.goto('./#/pilot/edge', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('pilot-empty')).toBeVisible();
    await expect(page.getByTestId('pilot-empty')).toContainText('Pinch, drag, Back, Forward, or Latest');
    await expect(page.getByTestId('chart-host')).toBeVisible();
    await expect(page.getByTestId('pilot-zone-select')).toBeEnabled();
    await expect(page.getByTestId('pilot-card-select')).toBeEnabled();
    await expect(page.getByTestId('pilot-range-24h')).toBeEnabled();
  });

  for (const failure of [
    { name: 'first-load HTTP 500', status: 500, body: { message: 'fixture failure' }, firstLoad: true },
    { name: 'malformed response', status: 200, body: { cardId: 'soil-card', series: 'wrong' }, firstLoad: true },
    { name: '401 auth rejection', status: 401, body: { message: 'secret fixture token' }, firstLoad: true },
    { name: '403 auth rejection', status: 403, body: { message: 'secret fixture token' }, firstLoad: true },
  ] as const) {
    test(`handles ${failure.name}`, async ({ page }) => {
      activeHarness = await installPilotApi(page, 'edge');
      await page.addInitScript((token) => localStorage.setItem('auth_token', token), TOKEN);
      await installOneShotResponse(page, (request) => request.pathname.endsWith('/data'), failure.status, failure.body, (request) => activeHarness?.dataRequests.push(request));
      await page.goto('./#/pilot/edge', { waitUntil: 'domcontentloaded' });
      if (failure.status === 401 || failure.status === 403) await expect(page.getByTestId('pilot-login-required')).toBeVisible();
      else {
        await expect(page.getByTestId('pilot-error')).toBeVisible();
        await expect(page.getByTestId('pilot-retry')).toBeVisible();
        await expect(page.getByTestId('chart-host')).toHaveCount(0);
        if (failure.status === 500) {
          const failedSearch = activeHarness.dataRequests.at(-1)!.search;
          const requestsBeforeRetry = activeHarness.dataRequests.length;
          await page.getByTestId('pilot-retry').click();
          await expect(page.getByTestId('pilot-load-status')).toHaveText(/ready/i);
          await expect.poll(() => activeHarness?.dataRequests.length ?? 0).toBe(requestsBeforeRetry + 1);
          expect(activeHarness.dataRequests.at(-1)!.search).toBe(failedSearch);
          await expect(page.getByTestId('chart-host')).toBeVisible();
        }
      }
      if (failure.status !== 500) await expect(page.getByTestId('chart-host')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain('secret fixture token');
    });
  }

  test('recovers from a same-identity background HTTP 500 without moving the viewport', async ({ page }) => {
    activeHarness = await authenticated(page, 'edge');
    await installOneShotResponse(page, (request) => request.search.includes('range=7d'), 500, { message: 'fixture failure' }, (request) => activeHarness?.dataRequests.push(request));
    await page.getByTestId('pilot-range-7d').click();
    await settle(page);
    const expected = await probe(page);
    await expect(page.getByTestId('pilot-error')).toBeVisible();
    await expect(page.getByTestId('chart-host')).toBeVisible();
    expect(viewportDistance(expected.renderedViewport, (await probe(page)).renderedViewport)).toBeLessThanOrEqual(1);
    const failedSearch = activeHarness.dataRequests.at(-1)!.search;
    const requestsBeforeRetry = activeHarness.dataRequests.length;
    await page.getByTestId('pilot-retry').click();
    await expect(page.getByTestId('pilot-refresh-status')).toHaveText('');
    await expect(page.getByTestId('pilot-error')).toHaveCount(0);
    expect(activeHarness.dataRequests.length).toBe(requestsBeforeRetry + 1);
    expect(activeHarness.dataRequests.at(-1)!.search).toBe(failedSearch);
  });

  test('reuses a warm Back neighbor and original window without a prefetch chain', async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date('2026-07-01T12:00:00.000Z') });
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1, delayDataMs: 600 });
    const initial = activeHarness.dataRequests[0];
    const expectedNeighbor = pastNeighborBounds(initial);
    await page.clock.fastForward(500);
    await expect.poll(() => pendingDataFor(activeHarness!, (bounds) => bounds.from === expectedNeighbor.from && bounds.to === expectedNeighbor.to && bounds.aggregation === expectedNeighbor.aggregation)).toBeTruthy();
    const neighbor = pendingDataFor(activeHarness, (bounds) => bounds.from === expectedNeighbor.from && bounds.to === expectedNeighbor.to && bounds.aggregation === expectedNeighbor.aggregation)!;
    expect(requestBounds(neighbor.request).aggregation).toBe(requestBounds(initial).aggregation);
    const prefetchCount = activeHarness.dataRequests.length;
    neighbor.resolve(200, cardDataForRequest(neighbor.request));
    await neighbor.done;
    await page.clock.fastForward(1_000);
    expect(activeHarness.dataRequests.length).toBe(prefetchCount);
    const initialAcceptedRange = await page.getByTestId('pilot-accepted-range').innerText();
    await page.getByTestId('pilot-window-back').click();
    await expect(page.getByTestId('pilot-accepted-range')).not.toHaveText(initialAcceptedRange);
    expect(activeHarness.dataRequests.length).toBe(prefetchCount);
    await page.getByTestId('pilot-window-forward').click();
    await expect(page.getByTestId('pilot-accepted-range')).toHaveText(initialAcceptedRange);
    expect(activeHarness.dataRequests.length).toBe(prefetchCount);
    const snapshot = activeHarness.snapshot({ initial, neighbor: neighbor.request });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('authorization');
    expect(snapshot.initial[0].startedAt).toBeLessThanOrEqual(snapshot.initial[0].releasedAt ?? Date.now());
    expect(snapshot.neighbor[0].startedAt).toBeLessThanOrEqual(snapshot.neighbor[0].releasedAt ?? Date.now());
    await testInfo.attach('pilot-request-snapshot', { body: Buffer.from(serialized), contentType: 'application/json' });
  });

  test('deduplicates duplicate Latest clicks while the refresh is pending', async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date('2026-07-01T12:00:00.000Z') });
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1, delayDataMs: 600 });
    const initial = activeHarness.dataRequests[0];
    const initialBounds = requestBounds(initial);
    await page.getByTestId('pilot-window-latest').click();
    await page.getByTestId('pilot-window-latest').click();
    await expect.poll(() => activeHarness?.dataRequests.length ?? 0).toBe(2);
    const latest = pendingDataFor(activeHarness, (bounds, request) => request !== initial && bounds.from === initialBounds.from && bounds.to === initialBounds.to && bounds.aggregation === initialBounds.aggregation)!;
    latest.resolve(200, cardDataForRequest(latest.request));
    await latest.done;
    await expect(page.getByTestId('pilot-refresh-status')).toHaveText('');
    await expect(page.getByTestId('pilot-accepted-range')).toBeVisible();
    const snapshot = activeHarness.snapshot({ initial, latest: latest.request });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('authorization');
    await testInfo.attach('pilot-latest-request-snapshot', { body: Buffer.from(serialized), contentType: 'application/json' });
  });

  test('starts directional work before touch end and never exceeds two physical requests', async ({ page }) => {
    const fixedClock = new Date('2026-07-01T12:00:00.000Z');
    await page.clock.install({ time: fixedClock });
    await page.clock.pauseAt(new Date(fixedClock.getTime() + 1_000));
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1, delayDataMs: 600 });
    expect(activeHarness.dataRequests).toHaveLength(1);
    activeCdp = await page.context().newCDPSession(page);
    const initial = activeHarness.dataRequests[0];
    const plot = (await currentPlot(page)).plotRect;
    const startViewport = (await probe(page)).requestedViewport;
    const steps = panPoints(plot, { fromX: plot.width * 0.25, toX: plot.width * 0.65, steps: 14, pauseMs: 0 });
    let crossingIndex = -1;
    let expectedNeighbor: ReturnType<typeof pastNeighborBoundsFromViewport> | undefined;
    for (let index = 0; index < steps.length - 1; index += 1) {
      await dispatchTouchSequence(activeCdp, [steps[index]]);
      await page.clock.runFor(8);
      const current = (await probe(page)).requestedViewport;
      if (viewportDistance(startViewport, current) >= span(startViewport) * 0.05) {
        crossingIndex = index;
        expectedNeighbor = pastNeighborBoundsFromViewport(current, requestBounds(initial).aggregation);
        break;
      }
    }
    expect(crossingIndex).toBeGreaterThanOrEqual(0);
    await page.clock.runFor(1);
    await expect.poll(() => pendingDataFor(activeHarness!, (bounds) => bounds.from === expectedNeighbor!.from && bounds.to === expectedNeighbor!.to && bounds.aggregation === expectedNeighbor!.aggregation)).toBeTruthy();
    const pendingNeighbor = pendingDataFor(activeHarness, (bounds) => bounds.from === expectedNeighbor!.from && bounds.to === expectedNeighbor!.to && bounds.aggregation === expectedNeighbor!.aggregation)!;
    expect(pendingNeighbor.request).toBeTruthy();
    expect(activeHarness.activeDataRequests()).toBeLessThanOrEqual(2);
    await dispatchTouchSequence(activeCdp, steps.slice(crossingIndex + 1));
    await activeHarness.releaseAll(200, (request) => cardDataForRequest(request));
    await expect(page.getByTestId('pilot-refresh-status')).toHaveText('');
    expect(activeHarness.activeDataRequests()).toBe(0);
  });

  for (const [label, response] of [
    ['truncated', { truncated: true, aggregation: { level: 'daily', pointCount: 2_000 } }],
    ['actual aggregation mismatch', { truncated: false, aggregation: { level: 'daily', pointCount: 12 } }],
  ] as const) {
    test(`does not cache a ${label} response`, async ({ page }) => {
      activeHarness = await authenticated(page, 'edge');
      const initial = activeHarness.dataRequests[0];
      let excludedRequest: RecordedRequest | undefined;
      await installOneShotResponse(page, (request) => request.search.includes('range=7d'), 200, (request: RecordedRequest) => cardDataForRequest(request, response), (request) => { excludedRequest = request; activeHarness?.dataRequests.push(request); });
      await page.getByTestId('pilot-range-7d').click();
      await expect.poll(() => Boolean(excludedRequest)).toBeTruthy();
      const firstExcluded = excludedRequest!;
      await expect(page.getByTestId('pilot-accepted-range')).toHaveText(`Accepted range: ${acceptedRangeText(firstExcluded)}`);
      await expect(page.getByTestId('pilot-aggregation')).toHaveText(`Aggregation: ${response.aggregation.level}`);
      const before24h = activeHarness.dataRequests.length;
      await page.getByTestId('pilot-range-24h').click();
      await expect(page.getByTestId('pilot-accepted-range')).toHaveText(`Accepted range: ${acceptedRangeText(initial)}`);
      await expect(page.getByTestId('pilot-aggregation')).toHaveText('Aggregation: raw');
      expect(activeHarness.dataRequests.length).toBe(before24h);
      const beforeReturn = countDataRequests(activeHarness, (_bounds, request) => sameRequest(request, firstExcluded));
      await page.getByTestId('pilot-range-7d').click();
      await expect.poll(() => countDataRequests(activeHarness!, (_bounds, request) => sameRequest(request, firstExcluded))).toBeGreaterThan(beforeReturn);
      const returned7d = activeHarness.dataRequests.filter((candidate) => sameRequest(candidate, firstExcluded)).at(-1)!;
      await expect(page.getByTestId('pilot-accepted-range')).toHaveText(`Accepted range: ${acceptedRangeText(returned7d)}`);
      await expect(page.getByTestId('pilot-aggregation')).toHaveText(`Aggregation: ${requestBounds(returned7d).aggregation}`);
    });
  }

  test('keeps non-auth prefetch failures quiet and clears on auth prefetch failure', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-07-01T12:00:00.000Z') });
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1, delayDataMs: 600 });
    const initial = activeHarness.dataRequests[0];
    const expectedNeighbor = pastNeighborBounds(initial);
    await page.clock.fastForward(500);
    await expect.poll(() => pendingDataFor(activeHarness!, (bounds) => bounds.from === expectedNeighbor.from && bounds.to === expectedNeighbor.to && bounds.aggregation === expectedNeighbor.aggregation)).toBeTruthy();
    const failedPrefetch = pendingDataFor(activeHarness, (bounds) => bounds.from === expectedNeighbor.from && bounds.to === expectedNeighbor.to && bounds.aggregation === expectedNeighbor.aggregation)!;
    failedPrefetch.resolve(500, { message: 'prefetch fixture failure' });
    await failedPrefetch.done;
    await expect(page.getByTestId('pilot-load-status')).toHaveText('Ready');
    await expect(page.getByTestId('pilot-refresh-status')).toHaveText('');
    await expect(page.getByTestId('pilot-refresh-status')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('pilot-error')).toHaveCount(0);
  });

  test('turns a prefetch auth failure into login-required state', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-07-01T12:00:00.000Z') });
    activeHarness = await authenticated(page, 'edge', { deferDataAfter: 1, delayDataMs: 600 });
    await page.clock.fastForward(500);
    const initial = activeHarness.dataRequests[0];
    const initialBounds = requestBounds(initial);
    const expectedNeighbor = pastNeighborBounds(initial);
    await expect.poll(() => pendingDataFor(activeHarness!, (bounds) => bounds.from === expectedNeighbor.from && bounds.to === expectedNeighbor.to && bounds.aggregation === expectedNeighbor.aggregation)).toBeTruthy();
    await page.getByTestId('pilot-window-latest').click();
    await expect.poll(() => pendingDataFor(activeHarness!, (bounds, request) => request !== initial && bounds.from === initialBounds.from && bounds.to === initialBounds.to && bounds.aggregation === initialBounds.aggregation)).toBeTruthy();
    const failedPrefetch = pendingDataFor(activeHarness, (bounds) => bounds.from === expectedNeighbor.from && bounds.to === expectedNeighbor.to && bounds.aggregation === expectedNeighbor.aggregation)!;
    const heldForeground = pendingDataFor(activeHarness, (bounds, request) => request !== initial && bounds.from === initialBounds.from && bounds.to === initialBounds.to && bounds.aggregation === initialBounds.aggregation)!;
    failedPrefetch.resolve(401, { message: 'auth fixture failure' });
    await failedPrefetch.done;
    await expect(page.getByTestId('pilot-login-required')).toBeVisible();
    await expect(page.getByTestId('chart-host')).toHaveCount(0);
    await expect(page.getByTestId('pilot-accepted-range')).toHaveCount(0);
    heldForeground.resolve(200, cardDataForRequest(heldForeground.request));
    await heldForeground.done;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId('chart-host')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('auth fixture failure');
  });
});
