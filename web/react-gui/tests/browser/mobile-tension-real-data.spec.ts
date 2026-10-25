import { expect, test, type CDPSession, type Page } from '@playwright/test';
import {
  EXPECTED_SERIES,
  FIXTURE_TIME_ZONE,
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
    const target = window as Window & { __mobileHistoryTickAnchors?: Array<{ text: string; x: number; y: number; a: number; c: number; e: number }> };
    target.__mobileHistoryTickAnchors = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function fillText(text: string, x: number, y: number, maxWidth?: number) {
      if (this.textAlign === 'right' && this.textBaseline === 'middle') {
        const transform = this.getTransform();
        target.__mobileHistoryTickAnchors?.push({ text, x, y, a: transform.a, c: transform.c, e: transform.e });
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
  await expect(page.getByRole('heading', { name: 'Hourly averages' })).toBeVisible();
  await fixture.waitForSeries(1);
  await expect.poll(async () => {
    const shell = (await diagnostics(page)).shell;
    return shell.status === 'ready' && !shell.refreshing && shell.errorKind === null;
  }).toBe(true);
  const snapshot = await diagnostics(page);
  expect(snapshot.renderedViewport).not.toBeNull();
  expect(snapshot.plotRect).not.toBeNull();
  expect(snapshot.loader.entries).toBeLessThanOrEqual(8);
  expect(snapshot.loader.points).toBeLessThanOrEqual(20_000);
  expect(snapshot.renderedViewport).toEqual(snapshot.requestedViewport);
  return snapshot;
}

function assertDiagnosticBounds(samples: readonly DiagnosticSnapshot[]): { maxEntries: number; maxPoints: number; lanePairs: string[] } {
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(sample.loader.entries).toBeLessThanOrEqual(8);
    expect(sample.loader.points).toBeLessThanOrEqual(20_000);
  }
  return {
    maxEntries: Math.max(...samples.map((sample) => sample.loader.entries)),
    maxPoints: Math.max(...samples.map((sample) => sample.loader.points)),
    lanePairs: [...new Set(samples.map((sample) => `${sample.loader.foregroundActive}/${sample.loader.prefetchActive}`))].sort(),
  };
}

async function openSources(page: Page): Promise<void> {
  await page.getByRole('button', { name: /chart sources|Sources:/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function closeSheet(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function dispatchFractionalClick(page: Page, selector: string, clientX: number, clientY: number): Promise<void> {
  await page.locator(selector).evaluate((element, point) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: Math.round(point.x), clientY: Math.round(point.y) });
    Object.defineProperty(event, 'clientX', { configurable: true, value: point.x });
    Object.defineProperty(event, 'clientY', { configurable: true, value: point.y });
    element.dispatchEvent(event);
  }, { x: clientX, y: clientY });
}

async function assertCanvasAlignment(page: Page, plotTop: number): Promise<void> {
  const result = await page.evaluate((actualPlotTop) => {
    const target = window as Window & { __mobileHistoryTickAnchors?: Array<{ text: string; x: number; y: number; a: number; c: number; e: number }> };
    const shell = document.querySelector('.mobile-tension-history')?.getBoundingClientRect();
    const canvas = document.querySelector('.mobile-tension-chart-frame .uplot canvas')?.getBoundingClientRect();
    const unit = document.querySelector('.mobile-tension-unit-row strong')?.getBoundingClientRect();
    const ticks = (target.__mobileHistoryTickAnchors ?? []).filter((tick) => /^-?\d+(?:[.,]\d+)?$/.test(tick.text));
    if (!shell || !canvas || !unit || ticks.length === 0) return null;
    const canvasElement = document.querySelector('.mobile-tension-chart-frame .uplot canvas') as HTMLCanvasElement | null;
    const rightmostTick = Math.max(...ticks.map((tick) => canvas.left + ((tick.x * tick.a + tick.y * tick.c + tick.e) / canvasElement!.width) * canvas.width));
    return {
      shell: { left: shell.left, right: shell.right },
      unit: { left: unit.left, right: unit.right, top: unit.top, bottom: unit.bottom },
      rightmostTick,
      delta: Math.abs(unit.right - rightmostTick),
      plotTop: actualPlotTop,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      clipped: unit.left < 0 || unit.right > document.documentElement.clientWidth || unit.top < 0 || unit.bottom > window.innerHeight,
    };
  }, plotTop);
  expect(result).not.toBeNull();
  expect(result!.delta).toBeLessThanOrEqual(1);
  expect(result!.overflow).toBeLessThanOrEqual(0);
  expect(result!.clipped).toBe(false);
  expect(result!.unit.top).toBeLessThanOrEqual(result!.plotTop + 1);
  expect(result!.unit.bottom).toBeLessThanOrEqual(result!.plotTop + 1);
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

async function sampleDiagnosticsDuring(page: Page, action: () => Promise<void>): Promise<DiagnosticSnapshot[]> {
  const samples: DiagnosticSnapshot[] = [];
  let active = true;
  const collector = (async () => {
    while (active) {
      try { samples.push(await diagnostics(page)); } catch { /* diagnostics is not mounted during initial navigation */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  try {
    await action();
  } finally {
    active = false;
    await collector;
  }
  return samples;
}

async function pageErrorsAreClosed(fixture: MobileHistoryFixture, expectedHttpStatuses: readonly number[] = [], expectedAbortedRequests = 0): Promise<void> {
  expect(fixture.unexpectedApiRequests).toEqual([]);
  expect(fixture.contractErrors).toEqual([]);
  expect(fixture.failedRequests).toEqual([]);
  expect(fixture.abortedRequests).toHaveLength(expectedAbortedRequests);
  expect(fixture.pageErrors).toEqual([]);
  if (expectedHttpStatuses.length > 0) {
    expect(fixture.consoleErrors.every((message) => expectedHttpStatuses.some((status) => message.includes(`status of ${status}`)))).toBe(true);
  }
  else expect(fixture.consoleErrors).toEqual([]);
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
    await page.goto('./?VITE_MOBILE_HISTORY_INTERNAL=true#/internal/mobile-history/zones/1', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/#\/history$/);
    expect(fixture.seriesRequests()).toHaveLength(0);
    await expect(page.getByRole('heading', { name: 'Water tension history' })).toHaveCount(0);
    expect(await page.evaluate(() => Boolean((window as Window & { __osiMobileHistoryDiagnostics?: unknown }).__osiMobileHistoryDiagnostics))).toBe(false);
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
    const delayedDiagnostics = sampleDiagnosticsDuring(page, () => page.waitForTimeout(800));
    const snapshot = await expectReady(page, fixture);
    const duringDelayedResponse = await delayedDiagnostics;
    const diagnosticSamples: DiagnosticSnapshot[] = [...duringDelayedResponse, snapshot];
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
    await assertCanvasAlignment(page, snapshot.plotRect!.top);
    const cdp = await page.context().newCDPSession(page);
    const plot = snapshot.plotRect!;
    const gestureSnapshots: DiagnosticSnapshot[] = [];
    const frame = await frameSampling(page, async () => {
      gestureSnapshots.push(...await sampleDiagnosticsDuring(page, () => dispatchTouchSequence(cdp, touchPoints(plot, 70, 140, 0.5))));
      gestureSnapshots.push(...await sampleDiagnosticsDuring(page, () => dispatchTouchSequence(cdp, panTouchPoints(plot))));
    });
    diagnosticSamples.push(...gestureSnapshots);
    await page.waitForTimeout(5_000);
    const afterGesture = await diagnostics(page);
    diagnosticSamples.push(afterGesture);
    const diagnosticSummary = assertDiagnosticBounds(diagnosticSamples);
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
      diagnosticSummary,
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

    // A settled removal is served from the current response cache. Re-adding the
    // same source must reuse that accepted backing without issuing a request.
    await openSources(page);
    const checks = page.getByRole('dialog').locator('input[type="checkbox"]');
    await expect(checks).toHaveCount(26);
    await checks.nth(0).uncheck();
    await closeSheet(page);
    await expect(page.getByText(/Selected 7 of 26 sources/i)).toBeVisible();
    const afterRemoval = fixture.seriesRequests().length;
    await expect.poll(async () => {
      const snapshot = await diagnostics(page);
      return snapshot.shell.status === 'ready' && !snapshot.shell.refreshing;
    }).toBe(true);
    expect(fixture.seriesRequests().length).toBe(afterRemoval);
    const diagnosticSamples: DiagnosticSnapshot[] = [await diagnostics(page)];

    await openSources(page);
    await checks.nth(0).check();
    await closeSheet(page);
    await expect(page.getByText(/Selected 8 of 26 sources/i)).toBeVisible();
    await expect.poll(async () => {
      const snapshot = await diagnostics(page);
      return snapshot.shell.status === 'ready' && !snapshot.shell.refreshing;
    }).toBe(true);
    expect(fixture.seriesRequests().length).toBe(afterRemoval);
    diagnosticSamples.push(await diagnostics(page));

    await openSources(page);
    await expect(checks).toHaveCount(26);
    const beforeCapFill = fixture.seriesRequests().length;
    for (let index = 8; index < 25; index += 1) {
      const checkbox = checks.nth(index);
      if (await checkbox.isEnabled() && !(await checkbox.isChecked())) {
        await checkbox.check();
        await expect(checkbox).toBeChecked();
      }
    }
    await expect(page.getByRole('dialog').getByText(/Selected 25 of 26 sources/i)).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/up to 25 sources/i)).toBeVisible();
    expect(await checks.nth(25).isDisabled()).toBe(true);
    await closeSheet(page);
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(beforeCapFill);
    await expect.poll(() => fixture.seriesRequests().every((record) => record.status !== null)).toBe(true);
    await expect.poll(async () => {
      const snapshot = await diagnostics(page);
      return snapshot.shell.status === 'ready' && !snapshot.shell.refreshing;
    }).toBe(true);
    const firstSeriesCount = fixture.seriesRequests().length;
    await openSources(page);
    await checks.nth(0).uncheck();
    await closeSheet(page);
    await expect(page.getByText(/Selected 24 of 26 sources/i)).toBeVisible();
    await expect.poll(async () => {
      const snapshot = await diagnostics(page);
      return snapshot.shell.status === 'ready' && !snapshot.shell.refreshing;
    }).toBe(true);
    expect(fixture.seriesRequests().length).toBe(firstSeriesCount);
    const capSnapshot = await diagnostics(page);
    const capDiagnostics = assertDiagnosticBounds([capSnapshot]);
    diagnosticSamples.push(capSnapshot);

    await page.locator('summary').filter({ hasText: 'Details' }).click();
    await expect(page.locator('.mobile-tension-details[open]')).toBeVisible();

    await openSources(page);
    for (let index = 1; index < 25; index += 1) {
      const checkbox = checks.nth(index);
      if (await checkbox.isChecked() && await checkbox.isEnabled()) await checkbox.uncheck();
    }
    await closeSheet(page);
    await expect(page.getByText('Choose sources')).toBeVisible();
    await expect.poll(async () => {
      const snapshot = await diagnostics(page);
      return snapshot.shell.status === 'empty' && !snapshot.shell.refreshing;
    }).toBe(true);
    expect(fixture.seriesRequests().length).toBe(firstSeriesCount);
    const emptySnapshot = await diagnostics(page);
    expect(emptySnapshot.shell.status).toBe('empty');
    diagnosticSamples.push(emptySnapshot);
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /7/ }).click();
    await expect.poll(async () => (await diagnostics(page)).shell.status).toBe('empty');
    expect(fixture.seriesRequests().length).toBe(firstSeriesCount);
    diagnosticSamples.push(await diagnostics(page));
    console.log(JSON.stringify({ capDiagnostics, diagnosticSummary: assertDiagnosticBounds(diagnosticSamples) }));
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

test('uncached source addition coalesces to one request and keeps a late response out after removal', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { catalogRows: 9 });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expectReady(page, fixture);
    const initialCount = fixture.seriesRequests().length;
    fixture.setScenario('pending-addition');
    await openSources(page);
    const checks = page.getByRole('dialog').locator('input[type="checkbox"]');
    await checks.nth(8).check();
    await closeSheet(page);
    expect(fixture.seriesRequests().length).toBeLessThanOrEqual(initialCount + 1);
    await expect.poll(() => fixture.seriesRequests().length).toBe(initialCount + 1);
    const pendingAddition = fixture.seriesRequests().at(-1)!;
    expect((pendingAddition.body as { selectors: unknown[] }).selectors).toHaveLength(9);
    expect(pendingAddition.outcome).toBeNull();
    await openSources(page);
    await checks.nth(8).uncheck();
    await closeSheet(page);
    await expect.poll(() => fixture.seriesRequests().at(-1)?.outcome !== null).toBe(true);
    await expect.poll(async () => {
      const snapshot = await diagnostics(page);
      return snapshot.shell.status === 'ready' && !snapshot.shell.refreshing && snapshot.shell.errorKind === null;
    }).toBe(true);
    expect(pendingAddition.outcome).toMatch(/fulfilled|aborted/);
    expect(fixture.seriesRequests().slice(initialCount + 1).every((record) => (record.body as { selectors: unknown[] }).selectors.length === 9)).toBe(true);
    await expect(page.getByRole('button', { name: 'Choose chart sources' }).filter({ hasText: /Selected 8 of 9 sources/i })).toBeVisible();
    expect((await diagnostics(page)).loader.entries).toBeLessThanOrEqual(8);
    const namedAbortCount = fixture.seriesRequests().filter((record) => record === pendingAddition && record.outcome === 'aborted').length;
    expect(fixture.abortedRequests).toHaveLength(namedAbortCount);
    await pageErrorsAreClosed(fixture, [], namedAbortCount);
  } finally {
    await fixture.dispose();
  }
});

test('all-null interval enters EMPTY and Show latest recovers after a gesture', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { scenario: 'empty-range' });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('No data in this interval.')).toBeVisible();
    await expect.poll(async () => (await diagnostics(page)).shell.status).toBe('empty');
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(0);
    const initialRequest = fixture.seriesRequests()[0];
    await expect.poll(() => initialRequest.outcome).toBe('fulfilled');
    await expect.poll(async () => {
      const current = await diagnostics(page);
      return current.shell.status === 'empty' && !current.shell.refreshing && current.renderedViewport !== null && current.renderedViewport.from === current.requestedViewport.from && current.renderedViewport.to === current.requestedViewport.to;
    }).toBe(true);
    const snapshot = await diagnostics(page);
    expect(snapshot.renderedViewport).not.toBeNull();
    expect(snapshot.plotRect).not.toBeNull();
    expect(snapshot.plotRect!.width).toBeGreaterThan(0);
    expect(snapshot.plotRect!.height).toBeGreaterThan(0);
    expect(snapshot.loader.entries).toBeLessThanOrEqual(8);
    const cdp = await page.context().newCDPSession(page);
    const preGestureRequestCount = fixture.seriesRequests().length;
    await dispatchTouchSequence(cdp, panTouchPoints(snapshot.plotRect!));
    await expect.poll(async () => (await diagnostics(page)).requestedViewport).not.toEqual(snapshot.requestedViewport);
    await expect.poll(async () => {
      const current = await diagnostics(page);
      const transportFrom = Math.floor(current.requestedViewport.from / 3_600_000) * 3_600_000;
      const transportTo = Math.ceil(current.requestedViewport.to / 3_600_000) * 3_600_000;
      const foregroundReady = fixture.seriesRequests().slice(preGestureRequestCount).some((record) => {
        const body = record.body as { range: { from: string; to: string } };
        return record.outcome === 'fulfilled' && Date.parse(body.range.from) === transportFrom && Date.parse(body.range.to) === transportTo;
      });
      return current.shell.status === 'empty' && !current.shell.refreshing && current.renderedViewport !== null && current.renderedViewport.from === current.requestedViewport.from && current.renderedViewport.to === current.requestedViewport.to && foregroundReady;
    }).toBe(true);
    const gestureRequests = fixture.seriesRequests().slice(preGestureRequestCount);
    expect(gestureRequests.length).toBeGreaterThanOrEqual(1);
    expect(gestureRequests.length).toBeLessThanOrEqual(2);
    await expect.poll(() => gestureRequests.every((record) => record.outcome !== null)).toBe(true);
    const finalGesture = await diagnostics(page);
    const requested = finalGesture.requestedViewport;
    const foregroundRequests = gestureRequests.filter((record) => {
      const body = record.body as { range: { from: string; to: string }; selectors: unknown[] };
      const transportFrom = Math.floor(requested.from / 3_600_000) * 3_600_000;
      const transportTo = Math.ceil(requested.to / 3_600_000) * 3_600_000;
      return record.outcome === 'fulfilled' && Date.parse(body.range.from) === transportFrom && Date.parse(body.range.to) === transportTo;
    });
    expect(foregroundRequests).toHaveLength(1);
    const gestureRequest = foregroundRequests[0];
    expect(gestureRequest.body).toMatchObject({ range: { label: '24h' } });
    const gestureBody = gestureRequest.body as { range: { from: string; to: string }; selectors: unknown[]; aggregation: string };
    const adjacentRequests = gestureRequests.filter((record) => record !== gestureRequest);
    if (adjacentRequests.length === 1) {
      const adjacentBody = adjacentRequests[0].body as { range: { from: string; to: string }; selectors: unknown[]; aggregation: string };
      const foregroundSpan = Date.parse(gestureBody.range.to) - Date.parse(gestureBody.range.from);
      const adjacentSpan = Date.parse(adjacentBody.range.to) - Date.parse(adjacentBody.range.from);
      expect(adjacentRequests[0].outcome).toBe('fulfilled');
      expect(adjacentBody.aggregation).toBe(gestureBody.aggregation);
      expect(adjacentBody.selectors).toEqual(gestureBody.selectors);
      expect(adjacentSpan).toBe(foregroundSpan);
      const foregroundFrom = Date.parse(gestureBody.range.from);
      const adjacentFrom = Date.parse(adjacentBody.range.from);
      expect(adjacentFrom).not.toBe(foregroundFrom);
      expect(Math.abs(adjacentFrom - foregroundFrom)).toBeLessThan(2 * foregroundSpan);
      expect(Date.parse(adjacentBody.range.to)).toBeGreaterThan(foregroundFrom);
      expect(adjacentFrom).toBeLessThan(Date.parse(gestureBody.range.to));
    }
    const formatCoverageDate = (timestamp: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: FIXTURE_TIME_ZONE }).format(timestamp);
    await page.locator('summary').filter({ hasText: 'Details' }).click();
    await expect(page.locator('.mobile-tension-details[open]')).toContainText(`Loaded from ${formatCoverageDate(Date.parse(gestureBody.range.from))} to ${formatCoverageDate(Date.parse(gestureBody.range.to))}.`);
    await page.locator('summary').filter({ hasText: 'Details' }).click();
    fixture.setScenario('normal');
    const preRecoveryRequestCount = fixture.seriesRequests().length;
    await page.getByRole('button', { name: 'Show latest 24 hours' }).click();
    await expect.poll(() => fixture.seriesRequests().length).toBe(preRecoveryRequestCount + 1);
    const recoveryRequest = fixture.seriesRequests().at(-1)!;
    await expect.poll(() => recoveryRequest.outcome).toBe('fulfilled');
    expect(recoveryRequest.body).toMatchObject({ range: { label: '24h' } });
    await expectReady(page, fixture);
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

test('finite data outside the current viewport enters EMPTY after a backed seven-day window', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { scenario: 'finite-outside-viewport' });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('No data in this interval.')).toBeVisible();
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /7/ }).click();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
    await expectReady(page, fixture);
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /24/ }).click();
    const backedRequestCount = fixture.seriesRequests().length;
    expect(backedRequestCount).toBe(2);
    await expect.poll(async () => (await diagnostics(page)).shell.status).toBe('empty');
    await expect(page.getByText('No data in this interval.')).toBeVisible();
    fixture.setScenario('normal');
    await page.getByRole('button', { name: 'Show latest 24 hours' }).click();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(backedRequestCount);
    expect(fixture.seriesRequests().at(-1)?.body).toMatchObject({ range: { label: '24h' } });
    await expectReady(page, fixture);
    await pageErrorsAreClosed(fixture);
  } finally {
    await fixture.dispose();
  }
});

const failureCases: Array<{ scenario: FixtureScenario; text: RegExp }> = [
  { scenario: 'missing-source', text: /unavailable|remove/i },
  { scenario: 'access-denied-source', text: /removed|access/i },
  { scenario: 'range-too-large', text: /too large|shorter window/i },
  { scenario: 'transient', text: /temporarily|incomplete|retry/i },
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
        await page.locator('summary').filter({ hasText: 'Details' }).click();
        await expect(page.getByText(/invalid/i)).toBeVisible();
      } else {
        await expect(page.getByRole('alert').filter({ hasText: failureCase.text }).first()).toBeVisible();
      }
      await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(0);
      await expect.poll(() => fixture.seriesRequests().every((record) => record.status !== null)).toBe(true);
      if (failureCase.scenario === 'missing-source' || failureCase.scenario === 'access-denied-source') {
        await expect.poll(() => fixture.catalogRequests().length).toBe(2);
        if (failureCase.scenario === 'missing-source') {
          const remove = page.getByRole('alert').getByRole('button', { name: /Remove/i });
          await expect(remove).toBeVisible();
          await remove.click();
        } else {
          await openSources(page);
          const deniedChecks = page.getByRole('dialog').locator('input[type="checkbox"]');
          await expect(deniedChecks).toHaveCount(8);
          await expect(deniedChecks.nth(7)).toBeDisabled();
          await closeSheet(page);
          await expect(page.getByText(/Selected 7 of 8 sources/i)).toBeVisible();
        }
        await expect.poll(async () => {
          const snapshot = await diagnostics(page);
          return snapshot.shell.status === 'ready' && snapshot.shell.errorKind === null && !snapshot.shell.refreshing;
        }).toBe(true);
      } else if (failureCase.scenario === 'transient') {
        fixture.setScenario('normal');
        await page.getByRole('button', { name: 'Retry' }).click();
        await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
        await expectReady(page, fixture);
      } else if (failureCase.scenario === 'range-too-large') {
        fixture.setScenario('normal');
        await page.getByRole('button', { name: 'Time' }).click();
        await page.getByRole('dialog').getByRole('button', { name: /7/ }).click();
        await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
        await expectReady(page, fixture);
      }
      await pageErrorsAreClosed(fixture, failureCase.scenario === 'range-too-large' ? [413] : failureCase.scenario === 'transient' ? [500] : []);
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
    await expect(page.getByText(/source discovery is incomplete/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(fixture.seriesRequests()).toHaveLength(0);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => fixture.catalogRequests().length).toBe(2);
    expect(fixture.seriesRequests()).toHaveLength(0);
    await pageErrorsAreClosed(fixture, [500]);
  } finally {
    await fixture.dispose();
  }
});

test('catalog 401 expires the real session', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { scenario: 'auth-401' });
  try {
    await page.goto(`./?catalogAuth=401${route.slice(1)}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/#\/login$/);
    expect(fixture.catalogRequests()[0].status).toBe(401);
    await pageErrorsAreClosed(fixture, [401]);
  } finally { await fixture.dispose(); }
});

test('catalog 403 remains route-local', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { scenario: 'auth-403' });
  try {
    await page.goto(`./?catalogAuth=403${route.slice(1)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Access denied/i)).toBeVisible();
    expect(fixture.catalogRequests()[0].status).toBe(403);
    await pageErrorsAreClosed(fixture, [403]);
  } finally { await fixture.dispose(); }
});

async function assertSeriesAuthFailure(page: Page, scenario: 'auth-401' | 'auth-403'): Promise<void> {
  const fixture = await installMobileHistoryFixtures(page, { catalogRows: 9 });
  try {
    await page.goto(`./?seriesAuth=${scenario}${route.slice(1)}`, { waitUntil: 'domcontentloaded' });
    await expectReady(page, fixture);
    fixture.setScenario(scenario);
    await openSources(page);
    const checks = page.getByRole('dialog').locator('input[type="checkbox"]');
    await expect(checks).toHaveCount(9);
    await checks.nth(8).check();
    await closeSheet(page);
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
    expect(fixture.seriesRequests().at(-1)?.status).toBe(scenario === 'auth-401' ? 401 : 403);
    if (scenario === 'auth-401') {
      await expect(page).toHaveURL(/#\/login$/);
    } else {
      await expect(page.getByText(/Access denied/i)).toBeVisible();
      expect(new URL(page.url()).hash).toContain('/internal/mobile-history/zones/1');
      const authSnapshot = await diagnostics(page);
      expect(authSnapshot.shell.status).toBe('idle');
      expect(authSnapshot.plotRect).toBeNull();
      await expect(page.locator('.mobile-tension-chart-frame')).toHaveCount(0);
    }
    await pageErrorsAreClosed(fixture, scenario === 'auth-401' ? [401] : [403]);
  } finally { await fixture.dispose(); }
}

test('series auth failure after accepted data logs out on 401', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  await assertSeriesAuthFailure(page, 'auth-401');
});

test('series auth failure after accepted data remains route-local on 403', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  await assertSeriesAuthFailure(page, 'auth-403');
});

test('stale delayed responses and a later route-local series 403 cannot replace the current request', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page, { scenario: 'stale', catalogRows: 9 });
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mobile-tension-history')).toBeVisible();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(0);
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /7/ }).click();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
    await page.waitForTimeout(5_500);
    expect(fixture.seriesRequests()[1].body).toMatchObject({ range: { label: '7d' } });
    expect(fixture.seriesRequests()[0].pathname).toBe(fixturePath);
    expect(fixture.seriesRequests()[0].outcome).toMatch(/fulfilled|aborted/);
    expect(fixture.seriesRequests()[1].outcome).toBe('fulfilled');
    const latest = await diagnostics(page);
    expect(latest.renderedViewport).toEqual(latest.requestedViewport);
    const sevenDayRange = (fixture.seriesRequests()[1].body as { range: { from: string; to: string } }).range;
    const formatCoverageDate = (timestamp: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: FIXTURE_TIME_ZONE }).format(timestamp);
    await page.locator('summary').filter({ hasText: 'Details' }).click();
    await expect(page.locator('.mobile-tension-details[open]')).toContainText(`Loaded from ${formatCoverageDate(Date.parse(sevenDayRange.from))} to ${formatCoverageDate(Date.parse(sevenDayRange.to))}.`);
    await page.locator('summary').filter({ hasText: 'Details' }).click();
    fixture.setScenario('auth-403');
    await openSources(page);
    const sourceChecks = page.getByRole('dialog').locator('input[type="checkbox"]');
    await expect(sourceChecks).toHaveCount(9);
    await sourceChecks.nth(8).check();
    await closeSheet(page);
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(2);
    await expect(page.getByText(/Access denied/i)).toBeVisible();
    expect(new URL(page.url()).hash).toContain('/internal/mobile-history/zones/1');
    expect(fixture.seriesRequests().at(-1)?.status).toBe(403);
    const staleAuthSnapshot = await diagnostics(page);
    expect(staleAuthSnapshot.shell.status).toBe('idle');
    expect(staleAuthSnapshot.plotRect).toBeNull();
    await expect(page.locator('.mobile-tension-chart-frame')).toHaveCount(0);
    const namedAbortCount = fixture.seriesRequests().filter((record) => record === fixture.seriesRequests()[0] && record.outcome === 'aborted').length;
    expect(fixture.abortedRequests).toHaveLength(namedAbortCount);
    await pageErrorsAreClosed(fixture, [403], namedAbortCount);
  } finally {
    await fixture.dispose();
  }
});

test('rapid range reversal keeps the latest 24-hour viewport and rejects older work', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  const fixture = await installMobileHistoryFixtures(page);
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expectReady(page, fixture);
    fixture.setScenario('stale');
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /7/ }).click();
    await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(1);
    await page.getByRole('button', { name: /Time/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /24/ }).click();
    await expect.poll(() => fixture.seriesRequests().every((record) => record.status !== null || record.outcome === 'aborted')).toBe(true);
    expect(fixture.seriesRequests()).toHaveLength(2);
    expect(fixture.seriesRequests()[1].body).toMatchObject({ range: { label: '7d' } });
    expect(fixture.seriesRequests()[1].outcome).toMatch(/fulfilled|aborted/);
    const latest = await expectReady(page, fixture);
    expect(latest.renderedViewport).toEqual(latest.requestedViewport);
    expect(latest.requestedViewport.to - latest.requestedViewport.from).toBe(24 * 3_600_000);
    const initialRange = (fixture.seriesRequests()[0].body as { range: { from: string; to: string } }).range;
    const formatCoverageDate = (timestamp: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: FIXTURE_TIME_ZONE }).format(timestamp);
    await page.locator('summary').filter({ hasText: 'Details' }).click();
    await expect(page.locator('.mobile-tension-details[open]')).toContainText(`Loaded from ${formatCoverageDate(Date.parse(initialRange.from))} to ${formatCoverageDate(Date.parse(initialRange.to))}.`);
    const namedAbortCount = fixture.seriesRequests().filter((record) => record === fixture.seriesRequests()[1] && record.outcome === 'aborted').length;
    expect(fixture.abortedRequests).toHaveLength(namedAbortCount);
    await pageErrorsAreClosed(fixture, [], namedAbortCount);
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
    const sevenDaySnapshot = await expectReady(page, fixture);
    const request = fixture.seriesRequests().at(-1)!;
    await expect.poll(() => request.status).toBe(200);
    expect((request.body as { range: { label: string } }).range.label).toBe('7d');
    expect(bucketCountForRequest(request)).toBe(169);
    const plot = sevenDaySnapshot.plotRect;
    expect(plot).not.toBeNull();
    const { from, to } = sevenDaySnapshot.requestedViewport;
    const responseRange = (request.body as { range: { from: string } }).range;
    const boundary = Date.parse(responseRange.from) + 24 * 3_600_000;
    const layer = page.locator('.mobile-tension-chart-frame .gesture-layer');
    const formatInspectorDate = (timestamp: number) => new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: FIXTURE_TIME_ZONE, timeZoneName: 'shortOffset' }).format(timestamp);
    const inspectAt = async (targetTime: number, bucketFrom: number, bucketIndex: number): Promise<string> => {
      const clientX = plot!.left + ((targetTime - from) / (to - from)) * plot!.width;
      const clientY = plot!.top + plot!.height / 2;
      expect(Number.isFinite(clientX)).toBe(true);
      await dispatchFractionalClick(page, '.mobile-tension-chart-frame .gesture-layer', clientX, clientY);
      const inspector = page.getByTestId('inspector');
      await expect(inspector).toBeVisible();
      const target = await page.getByTestId('inspector-target').getAttribute('dateTime');
      expect(target).not.toBeNull();
      expect(Math.abs(Date.parse(target!) - targetTime)).toBeLessThanOrEqual(1);
      const text = await inspector.innerText();
      const expectedValue = new Intl.NumberFormat('en', { maximumSignificantDigits: 6 }).format(18 + Math.sin(bucketIndex / 6));
      expect(text).toContain(`${expectedValue} kPa`);
      expect(text).toContain(`From ${formatInspectorDate(bucketFrom)} to ${formatInspectorDate(bucketFrom + 3_600_000)}.`);
      expect(text).toContain('Hourly average');
      await page.getByTestId('inspector-close').click();
      return text;
    };
    const before = await inspectAt(boundary - 1, boundary - 3_600_000, 23);
    const after = await inspectAt(boundary, boundary, 24);
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
    await pageErrorsAreClosed(fixture);
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
    await fixture.dispose();
  }
});

test('responsive route keeps controls, details and plot inside the viewport at normal and 200 percent text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'edge-on', 'the enabled production route is the subject of this assertion');
  await installCanvasTickProbe(page);
  const fixture = await installMobileHistoryFixtures(page, { catalogRows: 26 });
  try {
    for (const width of [320, 390, 448]) {
      await page.setViewportSize({ width, height: 998 });
      for (const scale of [1, 2]) {
        const previousSeriesRequests = fixture.seriesRequests().length;
        await page.goto(`./?mobileHistoryFontScale=${scale}${route.slice(2)}`, { waitUntil: 'domcontentloaded' });
        await page.evaluate((fontScale) => { document.documentElement.style.fontSize = `${16 * fontScale}px`; }, scale);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect.poll(() => fixture.seriesRequests().length).toBeGreaterThan(previousSeriesRequests);
        await expectReady(page, fixture);
        const rootFontSize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
        expect(rootFontSize).toBe(scale === 1 ? 16 : 32);
        const responsiveSnapshot = await diagnostics(page);
        await assertCanvasAlignment(page, responsiveSnapshot.plotRect!.top);
        const capRequestStart = fixture.seriesRequests().length;
        await openSources(page);
        const checks = page.getByRole('dialog').locator('input[type="checkbox"]');
        await expect(checks).toHaveCount(26);
        await checks.evaluateAll((elements) => {
          for (const element of elements.slice(8, 25)) {
            const checkbox = element as HTMLInputElement;
            if (!checkbox.checked && !checkbox.disabled) checkbox.click();
          }
        });
        await expect(page.getByRole('dialog').getByText(/Selected 25 of 26 sources/i)).toBeVisible();
        await expect(page.getByRole('dialog').getByText(/up to 25 sources/i)).toBeVisible();
        await expect(checks.nth(25)).toBeDisabled();
        await expect.poll(() => fixture.seriesRequests().slice(capRequestStart).some((record) => {
          const selectors = (record.body as { selectors?: unknown[] }).selectors;
          return selectors?.length === 25 && record.outcome === 'fulfilled';
        })).toBe(true);
        await expect.poll(async () => {
          const shell = (await diagnostics(page)).shell;
          return shell.status === 'ready' && !shell.refreshing && shell.errorKind === null;
        }).toBe(true);
        const controls = page.getByRole('dialog').locator('button, label, [role="button"]');
        const count = await controls.count();
        for (let index = 0; index < count; index += 1) {
          const rect = await controls.nth(index).boundingBox();
          expect(rect?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(rect?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        await closeSheet(page);
        await expect.poll(async () => {
          const snapshot = await diagnostics(page);
          return snapshot.shell.status === 'ready' && !snapshot.shell.refreshing;
        }).toBe(true);
        await page.locator('summary').filter({ hasText: 'Details' }).click();
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
