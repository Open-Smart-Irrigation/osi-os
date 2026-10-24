import { expect, test, type CDPSession, type Page } from '@playwright/test';
import {
  EXPECTED_SERIES,
  FIXTURE_ZONE_ID,
  bucketCountForRequest,
  installMobileHistoryFixtures,
  type FixtureScenario,
  type MobileHistoryFixture,
} from './mobile-history-fixtures';

const route = './#/internal/mobile-history/zones/1';
const fixturePath = '/api/analysis/series';

type DiagnosticSnapshot = {
  requestedViewport: { from: number; to: number };
  renderedViewport: { from: number; to: number } | null;
  plotRect: { left: number; top: number; width: number; height: number } | null;
  loader: { foregroundActive: boolean; prefetchActive: boolean; entries: number; points: number };
  shell: { status: string; refreshing: boolean; errorKind: string | null };
};

async function installCanvasTickProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as Window & { __mobileHistoryTickAnchors?: Array<{ text: string; x: number; y: number }> };
    target.__mobileHistoryTickAnchors = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function fillText(text: string, x: number, y: number, maxWidth?: number) {
      if (this.textAlign === 'right' && this.textBaseline === 'middle') {
        target.__mobileHistoryTickAnchors?.push({ text, x, y });
      }
      return maxWidth === undefined ? original.call(this, text, x, y) : original.call(this, text, x, y, maxWidth);
    };
  });
}

async function diagnostics(page: Page): Promise<DiagnosticSnapshot> {
  return page.evaluate(() => {
    const value = (window as Window & { __osiMobileHistoryDiagnostics?: { snapshot(): DiagnosticSnapshot } }).__osiMobileHistoryDiagnostics;
    if (!value) throw new Error('mobile history diagnostics were not published');
    return value.snapshot();
  });
}

async function expectReady(page: Page, fixture: MobileHistoryFixture): Promise<DiagnosticSnapshot> {
  await expect(page.getByTestId('mobile-tension-history')).toBeVisible();
  await expect(page.getByText('Hourly averages')).toBeVisible();
  await fixture.waitForSeries(1);
  await expect.poll(async () => (await diagnostics(page)).shell.status).toBe('ready');
  const snapshot = await diagnostics(page);
  expect(snapshot.renderedViewport).not.toBeNull();
  expect(snapshot.plotRect).not.toBeNull();
  expect(snapshot.loader.entries).toBeLessThanOrEqual(8);
  expect(snapshot.loader.points).toBeLessThanOrEqual(20_000);
  expect(snapshot.renderedViewport).toEqual(snapshot.requestedViewport);
  return snapshot;
}

async function openSources(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Sources:/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function closeSheet(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function assertCanvasAlignment(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const target = window as Window & { __mobileHistoryTickAnchors?: Array<{ text: string; x: number; y: number }> };
    const frame = document.querySelector('.mobile-tension-chart-frame')?.getBoundingClientRect();
    const plot = document.querySelector('.mobile-tension-chart-frame .uplot')?.getBoundingClientRect();
    const unit = document.querySelector('.mobile-tension-unit-row strong')?.getBoundingClientRect();
    const ticks = target.__mobileHistoryTickAnchors ?? [];
    if (!frame || !plot || !unit || ticks.length === 0) return null;
    const rightmostTick = Math.max(...ticks.map((tick) => tick.x + plot.left));
    return {
      frame: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom },
      plot: { left: plot.left, right: plot.right, top: plot.top },
      unit: { left: unit.left, right: unit.right, top: unit.top, bottom: unit.bottom },
      rightmostTick,
      delta: Math.abs(unit.right - rightmostTick),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(result).not.toBeNull();
  expect(result!.unit.right).toBeLessThanOrEqual(result!.plot.left + 1);
  expect(result!.unit.left).toBeGreaterThanOrEqual(result!.frame.left - 1);
  expect(result!.unit.top).toBeGreaterThanOrEqual(result!.frame.top - 1);
  expect(result!.unit.bottom).toBeLessThanOrEqual(result!.frame.bottom + 1);
  expect(result!.delta).toBeLessThanOrEqual(1);
  expect(result!.overflow).toBeLessThanOrEqual(0);
}

type TouchPoint = { id: number; x: number; y: number };

async function dispatchTouchSequence(cdp: CDPSession, steps: Array<{ type: 'touchStart' | 'touchMove' | 'touchEnd'; touchPoints: TouchPoint[] }>): Promise<void> {
  for (const step of steps) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: step.type,
      touchPoints: step.touchPoints.map((point) => ({ ...point, radiusX: 1, radiusY: 1, force: 1 })),
      modifiers: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

function touchPoints(plot: { left: number; top: number; width: number; height: number }, startGap: number, endGap: number, center: number): Array<{ type: 'touchStart' | 'touchMove' | 'touchEnd'; touchPoints: TouchPoint[] }> {
  const points: Array<{ type: 'touchStart' | 'touchMove' | 'touchEnd'; touchPoints: TouchPoint[] }> = [];
  const y = plot.top + plot.height / 2;
  for (let index = 0; index <= 20; index += 1) {
    const gap = startGap + (endGap - startGap) * (index / 20);
    const x = plot.left + plot.width * center;
    points.push({ type: index === 0 ? 'touchStart' : 'touchMove', touchPoints: [{ id: 1, x: x - gap / 2, y }, { id: 2, x: x + gap / 2, y }] });
  }
  points.push({ type: 'touchEnd', touchPoints: [] });
  return points;
}

function panTouchPoints(plot: { left: number; top: number; width: number; height: number }): Array<{ type: 'touchStart' | 'touchMove' | 'touchEnd'; touchPoints: TouchPoint[] }> {
  const points: Array<{ type: 'touchStart' | 'touchMove' | 'touchEnd'; touchPoints: TouchPoint[] }> = [];
  const y = plot.top + plot.height / 2;
  for (let index = 0; index <= 20; index += 1) {
    points.push({ type: index === 0 ? 'touchStart' : 'touchMove', touchPoints: [{ id: 1, x: plot.left + plot.width * (0.3 + 0.4 * index / 20), y }] });
  }
  points.push({ type: 'touchEnd', touchPoints: [] });
  return points;
}

async function frameSampling(page: Page, action: () => Promise<void>): Promise<{ p95Ms: number; sampleCount: number }> {
  await page.evaluate(() => {
    const target = window as Window & { __mobileHistoryFrameSamples?: number[]; __mobileHistoryFrameHandle?: number; __mobileHistoryFrameLast?: number };
    target.__mobileHistoryFrameSamples = [];
    target.__mobileHistoryFrameLast = performance.now();
    const tick = (now: number) => {
      if (target.__mobileHistoryFrameLast !== undefined) target.__mobileHistoryFrameSamples?.push(now - target.__mobileHistoryFrameLast);
      target.__mobileHistoryFrameLast = now;
      target.__mobileHistoryFrameHandle = requestAnimationFrame(tick);
    };
    target.__mobileHistoryFrameHandle = requestAnimationFrame(tick);
  });
  await action();
  const samples = await page.evaluate(() => {
    const target = window as Window & { __mobileHistoryFrameSamples?: number[]; __mobileHistoryFrameHandle?: number };
    if (target.__mobileHistoryFrameHandle !== undefined) cancelAnimationFrame(target.__mobileHistoryFrameHandle);
    return target.__mobileHistoryFrameSamples ?? [];
  });
  expect(samples.length).toBeGreaterThan(0);
  const ordered = [...samples].sort((left, right) => left - right);
  const rank = Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1);
  return { p95Ms: ordered[rank], sampleCount: samples.length };
}

async function pageErrorsAreClosed(fixture: MobileHistoryFixture): Promise<void> {
  expect(fixture.unexpectedApiRequests).toEqual([]);
  expect(fixture.failedRequests).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
  expect(fixture.consoleErrors).toEqual([]);
}

test('default-off build redirects the real protected route and omits the lazy module', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-off', 'the off build is the only subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { enabled: false });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/#\/history$/);
    await expect(page.getByTestId('mobile-tension-history')).toHaveCount(0);
    expect(await page.evaluate(() => Boolean((window as Window & { __osiMobileHistoryDiagnostics?: unknown }).__osiMobileHistoryDiagnostics))).toBe(false);
    expect(fixture.seriesRequests()).toHaveLength(0);
    expect(fixture.catalogRequests()).toHaveLength(0);
    const manifestUrl = new URL('.vite/manifest.json', page.url()).toString();
    const manifest = await (await page.request.get(manifestUrl)).json();
    expect(JSON.stringify(manifest)).not.toMatch(/MobileTensionHistoryRoute|mobile-history/);
    await page.addInitScript(() => localStorage.setItem('VITE_MOBILE_HISTORY_INTERNAL', 'true'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/#\/history$/);
    expect(fixture.seriesRequests()).toHaveLength(0);
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

test('enabled production route uses authentic catalog ids, hourly buckets, measured delay, diagnostics and canvas geometry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  await installCanvasTickProbe(page);
  const fixture = await installMobileHistoryFixtures(page);
  const navigationStarted = Date.now();
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    const snapshot = await expectReady(page, fixture);
    const manifest = await (await page.request.get(new URL('.vite/manifest.json', page.url()).toString())).json();
    expect(JSON.stringify(manifest)).toMatch(/MobileTensionHistoryRoute|mobile-history/);
    const record = fixture.seriesRequests()[0];
    expect(record.pathname).toBe(fixturePath);
    expect(record.authorization).toBe('Bearer edge-mobile-history-token');
    const body = record.body as { selectors: Array<{ seriesId: string }>; aggregation: string; range: { mode: string; label: string } };
    expect(body.selectors.map((selector) => selector.seriesId)).toEqual(EXPECTED_SERIES.map(([, , id]) => id));
    expect(body.aggregation).toBe('hourly');
    expect(body.range).toMatchObject({ mode: 'custom', label: '24h' });
    expect(bucketCountForRequest(record)).toBe(25);
    expect(record.bytes).toBeGreaterThan(0);
    expect(record.delayMs).toBeGreaterThan(600);
    expect(record.releasedAt! - record.startedAt).toBeGreaterThanOrEqual(record.delayMs - 50);
    expect(record.releasedAt! - record.startedAt).toBeLessThan(record.delayMs + 2_000);
    const catalogDoneMs = Math.max(...fixture.catalogRequests().map((request) => (request.releasedAt ?? request.startedAt) - navigationStarted));
    const firstReadyMs = Date.now() - navigationStarted;
    expect(firstReadyMs).toBeLessThanOrEqual(catalogDoneMs + record.delayMs + 1_000);
    const zonesRequest = fixture.requests.find((request) => request.role === 'zones');
    const catalogRequest = fixture.catalogRequests()[0];
    await assertCanvasAlignment(page);
    const cdp = await page.context().newCDPSession(page);
    const plot = snapshot.plotRect!;
    const frame = await frameSampling(page, async () => {
      await dispatchTouchSequence(cdp, touchPoints(plot, 70, 140, 0.5));
      await dispatchTouchSequence(cdp, panTouchPoints(plot));
    });
    await page.waitForTimeout(5_000);
    const afterGesture = await diagnostics(page);
    expect(afterGesture.renderedViewport).toEqual(afterGesture.requestedViewport);
    expect(fixture.seriesRequests().length).toBeLessThanOrEqual(2);
    expect(frame.p95Ms).toBeLessThanOrEqual(33.4);
    console.log(JSON.stringify({
      project: testInfo.project.name,
      navigationToReadyMs: firstReadyMs,
      navigationToZonesMs: zonesRequest ? zonesRequest.startedAt - navigationStarted : null,
      zonesToCatalogMs: zonesRequest && catalogRequest ? catalogRequest.startedAt - (zonesRequest.releasedAt ?? zonesRequest.startedAt) : null,
      catalogBytes: fixture.catalogRequests().reduce((sum, request) => sum + request.bytes, 0),
      seriesBytes: record.bytes,
      imposedDelayMs: record.delayMs,
      bucketCount: bucketCountForRequest(record),
      frame,
      diagnostics: snapshot,
    }));
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

test('source selection, zero state, cap state and details remain usable on the real route', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { catalogRows: 26 });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expectReady(page, fixture);
    await openSources(page);
    const checks = page.getByRole('dialog').locator('input[type="checkbox"]');
    await expect(checks).toHaveCount(26);
    for (let index = 8; index < 25; index += 1) {
      const checkbox = checks.nth(index);
      if (await checkbox.isEnabled() && !(await checkbox.isChecked())) await checkbox.check();
    }
    await expect(page.getByText(/maximum of 25|25 sources/i)).toBeVisible();
    expect(await checks.nth(25).isDisabled()).toBe(true);
    await closeSheet(page);
    const firstSeriesCount = fixture.seriesRequests().length;
    await openSources(page);
    await checks.nth(0).uncheck();
    await closeSheet(page);
    await expect(page.getByText('Choose sources')).toHaveCount(0);
    expect(fixture.seriesRequests().length).toBe(firstSeriesCount);
    await openSources(page);
    for (let index = 1; index < 25; index += 1) {
      const checkbox = checks.nth(index);
      if (await checkbox.isChecked() && await checkbox.isEnabled()) await checkbox.uncheck();
    }
    await closeSheet(page);
    await expect(page.getByText('Choose sources')).toBeVisible();
    expect(fixture.seriesRequests().length).toBeGreaterThanOrEqual(firstSeriesCount);
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.locator('.mobile-tension-details[open]')).toBeVisible();
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

const failureCases: Array<{ scenario: FixtureScenario; text: RegExp }> = [
  { scenario: 'missing-source', text: /unavailable|remove/i },
  { scenario: 'access-denied-source', text: /removed|access/i },
  { scenario: 'range-too-large', text: /too large|shorter window/i },
  { scenario: 'transient', text: /temporary|incomplete|retry/i },
  { scenario: 'invalid-average', text: /invalid|hourly/i },
];

for (const failureCase of failureCases) {
  test(`closed failure recovery for ${failureCase.scenario}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
    const fixture = await installMobileHistoryFixtures(page, { scenario: failureCase.scenario });
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('mobile-tension-history')).toBeVisible();
      if (failureCase.scenario === 'invalid-average') {
        await expectReady(page, fixture);
        await page.getByRole('button', { name: 'Details' }).click();
        await expect(page.getByText(/invalid/i)).toBeVisible();
      } else {
        await expect(page.getByText(failureCase.text)).toBeVisible();
      }
      await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(0);
      if (failureCase.scenario === 'missing-source' || failureCase.scenario === 'access-denied-source') {
        await expect.poll(() => fixture.catalogRequests().length).toBe(2);
      }
      expect(fixture.seriesRequests().every((record) => record.status !== null)).toBe(true);
      await pageErrorsAreClosed(fixture);
    } finally {
      await fixture.dispose();
    }
  });
}

test('catalog transient failure exposes one explicit retry and keeps Analysis idle until discovery succeeds', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { catalogStatus: 500 });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/source discovery incomplete/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(fixture.seriesRequests()).toHaveLength(0);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => fixture.catalogRequests().length).toBe(2);
    expect(fixture.seriesRequests()).toHaveLength(0);
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

test('catalog 401 expires the real session and catalog 403 remains route-local', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  for (const [scenario, expected] of [['auth-401', /#\/login$/], ['auth-403', /Access denied/i]] as const) {
    const fixture = await installMobileHistoryFixtures(page, { scenario });
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      if (scenario === 'auth-401') await expect(page).toHaveURL(expected);
      else await expect(page.getByText(expected)).toBeVisible();
      expect(fixture.catalogRequests()[0].status).toBe(Number(scenario === 'auth-401' ? 401 : 403));
      await pageErrorsAreClosed(fixture);
    } finally {
      await fixture.dispose();
    }
    if (scenario === 'auth-401') {
      await page.addInitScript(({ token }) => localStorage.setItem('auth_token', token), { token: 'edge-mobile-history-token' });
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  }
});

test('stale delayed responses and a later route-local series 403 cannot replace the current request', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { scenario: 'stale' });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mobile-tension-history')).toBeVisible();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(0);
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /7/ }).click();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
    await page.waitForTimeout(3_000);
    expect(fixture.seriesRequests()[1].body).toMatchObject({ range: { label: '7d' } });
    const latest = await diagnostics(page);
    expect(latest.renderedViewport).toEqual(latest.requestedViewport);
    fixture.setScenario('auth-403');
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /24/ }).click();
    await expect(page.getByText(/Access denied/i)).toBeVisible();
    expect(new URL(page.url()).hash).toContain('/internal/mobile-history/zones/1');
    expect(fixture.seriesRequests().at(-1)?.status).toBe(403);
  } finally {
    await fixture.dispose();
  }
});

test('seven-day production request keeps 169 hourly buckets and inspector uses containing intervals at boundaries', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page);
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expectReady(page, fixture);
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /7/ }).click();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
    await fixture.waitForSeries(2);
    const request = fixture.seriesRequests().at(-1)!;
    expect((request.body as { range: { label: string } }).range.label).toBe('7d');
    expect(bucketCountForRequest(request)).toBe(169);
    const plot = await page.locator('.mobile-tension-chart-frame .uplot').boundingBox();
    expect(plot).not.toBeNull();
    const body = request.body as { range: { from: string; to: string } };
    const from = Date.parse(body.range.from);
    const to = Date.parse(body.range.to);
    const boundary = from + 24 * 3_600_000;
    const x = plot!.left + ((boundary - from) / (to - from)) * plot!.width;
    await page.mouse.click(x - 2, plot!.top + plot!.height / 2);
    const before = await page.getByTestId('inspector').innerText();
    await page.getByTestId('inspector-close').click();
    await page.mouse.click(x + 2, plot!.top + plot!.height / 2);
    const after = await page.getByTestId('inspector').innerText();
    expect(before).toContain('Hourly average');
    expect(after).toContain('Hourly average');
    expect(before).not.toBe(after);
    await page.screenshot({ path: testInfo.outputPath('seven-day-containing-boundary.png'), fullPage: true });
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

test('four-times CPU gesture evidence is reported separately from the unthrottled budget', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    const snapshot = await expectReady(page, fixture);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const frame = await frameSampling(page, async () => {
      await dispatchTouchSequence(cdp, touchPoints(snapshot.plotRect!, 70, 140, 0.5));
      await dispatchTouchSequence(cdp, panTouchPoints(snapshot.plotRect!));
    });
    console.log(JSON.stringify({ project: testInfo.project.name, cpuThrottle: 4, frame }));
    expect(frame.sampleCount).toBeGreaterThan(0);
    expect(Number.isFinite(frame.p95Ms)).toBe(true);
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
    await fixture.dispose();
  }
});

test('responsive route keeps controls, details and plot inside the viewport at normal and 200 percent text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page);
  try {
    for (const width of [320, 390, 448]) {
      await page.setViewportSize({ width, height: 998 });
      for (const scale of [1, 2]) {
        const previousSeriesRequests = fixture.seriesRequests().length;
        await page.addInitScript(({ value }) => { document.documentElement.style.fontSize = `${value * 100}%`; }, { value: scale });
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(previousSeriesRequests);
        await expectReady(page, fixture);
        await openSources(page);
        const controls = page.getByRole('dialog').locator('button, input, [role="button"]');
        const count = await controls.count();
        for (let index = 0; index < count; index += 1) {
          const rect = await controls.nth(index).boundingBox();
          expect(rect?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(rect?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        await closeSheet(page);
        await page.getByRole('button', { name: 'Details' }).click();
        await expect(page.locator('.mobile-tension-details[open]')).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await page.screenshot({ path: testInfo.outputPath(`responsive-${width}-${scale * 100}pct.png`), fullPage: true });
      }
    }
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});
