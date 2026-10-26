import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { FIXTURE_FEATURES } from '../../src/shared/fixtures';
import { SERIES_COLORS, type Candidate, type Viewport } from '../../src/shared/types';
import {
  beginFrameSampling, candidates, currentPlot, endFrameSampling, loadFixture,
  openCandidate, probe, rendererError, resetViewport, settle, span,
  viewportDistance, writeFrameDiagnostics,
} from './browser-helpers';
import { dispatchTouchSequence, panPoints, pinchPoints, verticalPageSwipe } from './cdp-touch';

const parseHex = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16),
];
const seriesBlue = parseHex(SERIES_COLORS[0]);
const colorNear = (png: PNG, x: number, y: number, color = seriesBlue): boolean => {
  for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
    const px = Math.max(0, Math.min(png.width - 1, Math.round(x + dx)));
    const py = Math.max(0, Math.min(png.height - 1, Math.round(y + dy)));
    const index = (py * png.width + px) * 4;
    if (Math.hypot(png.data[index] - color[0], png.data[index + 1] - color[1], png.data[index + 2] - color[2]) <= 40) return true;
  }
  return false;
};
const xFor = (time: number, viewport: Viewport, left: number, width: number) => left + (time - viewport.from) / span(viewport) * width;
const yFor = (value: number, top: number, height: number) => top + (1 - value / 100) * height;

for (const route of candidates) {
  test.describe(route, () => {
    test(`loads empty and single fixtures as accepted renderer data (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      expect(await loadFixture(page, 'empty')).toBe(0);
      let value = await probe(page);
      expect(rendererError(value)).toBeLessThanOrEqual(1);
      expect(span(value.renderedViewport)).toBeGreaterThan(0);
      expect(await loadFixture(page, 'single')).toBe(1);
      value = await probe(page);
      expect(rendererError(value)).toBeLessThanOrEqual(1);
      expect(span(value.renderedViewport)).toBeGreaterThan(0);
    });

    test(`keeps fast sparse data and a panned viewport after slow nominal resolves (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      await page.getByTestId('fixture-select').selectOption('nominal');
      await page.getByTestId('load-delay-ms').fill('1500');
      await page.getByTestId('load-fixture').click();
      await expect(page.getByRole('status')).toHaveText('Loading nominal fixture…');
      const beforePan = await currentPlot(page);
      const cdp = await page.context().newCDPSession(page);
      await dispatchTouchSequence(cdp, panPoints(beforePan.plotRect, {
        fromX: beforePan.plotRect.width * 0.4, toX: beforePan.plotRect.width * 0.7, steps: 10,
      }));
      await settle(page);
      await page.getByTestId('fixture-select').selectOption('sparse');
      await page.getByTestId('load-delay-ms').fill('0');
      await expect(page.getByRole('status')).toHaveText('Loading nominal fixture…');
      await page.getByTestId('load-fixture').click();
      await expect(page.getByTestId('accepted-fixture')).toHaveText('Accepted fixture: sparse');
      const sparseCount = Number((await page.getByTestId('point-count').innerText()).replace('Point count: ', ''));
      expect(sparseCount).toBeGreaterThan(0);
      const accepted = await probe(page);
      expect(viewportDistance(beforePan.renderedViewport, accepted.renderedViewport)).toBeGreaterThan(span(beforePan.renderedViewport) * 0.05);
      await page.waitForTimeout(1600);
      await expect(page.getByTestId('accepted-fixture')).toHaveText('Accepted fixture: sparse');
      await expect(page.getByTestId('point-count')).toHaveText(`Point count: ${sparseCount}`);
      const final = await probe(page);
      expect(viewportDistance(final.renderedViewport, accepted.renderedViewport)).toBeLessThanOrEqual(1);
      expect(rendererError(final)).toBeLessThanOrEqual(1);
      await cdp.detach();
    });

    test(`scrolls natively outside the plot and refreshes geometry (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      const before = await currentPlot(page);
      const beforeY = await page.evaluate(() => window.scrollY);
      const cdp = await page.context().newCDPSession(page);
      const startY = Math.max(80, before.plotRect.top - 70);
      await dispatchTouchSequence(cdp, verticalPageSwipe(before.plotRect.left + before.plotRect.width / 2, startY, Math.max(8, startY - 90)));
      await settle(page);
      const afterY = await page.evaluate(() => window.scrollY);
      const after = await probe(page);
      expect(afterY).toBeGreaterThan(beforeY);
      expect(viewportDistance(after.renderedViewport, before.renderedViewport)).toBeLessThanOrEqual(1);
      expect(after.plotRect.top).not.toBe(before.plotRect.top);
      await cdp.detach();
    });

    test(`removes the old renderer listeners before another renderer mounts (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      const old = await currentPlot(page);
      await page.evaluate(() => { (window as Window & { __retainedHistoryProbe?: typeof window.__historyZoomProbe }).__retainedHistoryProbe = window.__historyZoomProbe; });
      const next: Candidate = route === 'echarts' ? 'uplot' : 'echarts';
      const finalRoute: Candidate = route === 'chartjs' ? 'uplot' : 'chartjs';
      await page.route('**/assets/*.js', async (requestRoute) => {
        const pathname = new URL(requestRoute.request().url()).pathname;
        if (pathname.includes(`/${next}-`)) await requestRoute.abort();
        else await requestRoute.continue();
      });
      await page.getByTestId(`candidate-${next}`).click();
      await expect(page.getByTestId('chart-host')).toHaveCount(0);
      await expect(page.locator('.candidate-unavailable')).toBeVisible();
      expect(await page.evaluate(() => window.__historyZoomProbe === undefined)).toBe(true);
      const stale = await page.evaluate(() => {
        const probe = (window as Window & { __retainedHistoryProbe?: typeof window.__historyZoomProbe }).__retainedHistoryProbe;
        if (!probe) throw new Error('retained probe missing');
        const throws = (read: () => unknown) => { try { read(); return false; } catch { return true; } };
        return { notifications: probe.viewportNotifications, renderedThrows: throws(() => probe.renderedViewport), plotThrows: throws(() => probe.plotRect) };
      });
      expect(stale.renderedThrows).toBe(true);
      expect(stale.plotThrows).toBe(true);
      const cdp = await page.context().newCDPSession(page);
      await dispatchTouchSequence(cdp, panPoints(old.plotRect, {
        fromX: old.plotRect.width * 0.4, toX: old.plotRect.width * 0.7, steps: 8,
      }));
      await settle(page);
      const afterEmptyTouch = await page.evaluate(() => (window as Window & { __retainedHistoryProbe?: typeof window.__historyZoomProbe }).__retainedHistoryProbe?.viewportNotifications);
      expect(afterEmptyTouch).toBe(stale.notifications);
      await page.unroute('**/assets/*.js');
      await page.getByTestId(`candidate-${finalRoute}`).click();
      await expect(page.getByTestId('chart-host')).toHaveCount(1);
      await expect(page.locator('.renderer-host')).toHaveCount(1);
      await expect(page.locator('.gesture-layer')).toHaveCount(1);
      const fresh = await currentPlot(page);
      await dispatchTouchSequence(cdp, panPoints(fresh.plotRect, {
        fromX: fresh.plotRect.width * 0.4, toX: fresh.plotRect.width * 0.7, steps: 8,
      }));
      await settle(page);
      const operated = await probe(page);
      expect(operated.viewportNotifications).toBeGreaterThan(fresh.viewportNotifications);
      expect(viewportDistance(operated.renderedViewport, fresh.renderedViewport)).toBeGreaterThan(span(fresh.renderedViewport) * 0.05);
      await cdp.detach();
    });

    test(`renders the nominal zero, spike, and full null-outage band (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      expect(await loadFixture(page, 'nominal')).toBeGreaterThanOrEqual(FIXTURE_FEATURES.nominal.minimumPointCount);
      const value = await currentPlot(page);
      const png = PNG.sync.read(await page.screenshot({ scale: 'css' }));
      const zeroX = xFor(FIXTURE_FEATURES.nominal.zero, value.renderedViewport, value.plotRect.left, value.plotRect.width);
      const spikeX = xFor(FIXTURE_FEATURES.nominal.spike, value.renderedViewport, value.plotRect.left, value.plotRect.width);
      expect(colorNear(png, zeroX, Math.min(value.plotRect.top + value.plotRect.height - 1, yFor(0, value.plotRect.top, value.plotRect.height)))).toBe(true);
      expect(colorNear(png, spikeX, yFor(96, value.plotRect.top, value.plotRect.height))).toBe(true);
      const outageWidth = FIXTURE_FEATURES.nominal.outageEnd - FIXTURE_FEATURES.nominal.outageStart;
      const bandFrom = xFor(FIXTURE_FEATURES.nominal.outageStart + outageWidth * 0.15, value.renderedViewport, value.plotRect.left, value.plotRect.width);
      const bandTo = xFor(FIXTURE_FEATURES.nominal.outageEnd - outageWidth * 0.15, value.renderedViewport, value.plotRect.left, value.plotRect.width);
      let bluePixels = 0;
      for (let x = Math.ceil(bandFrom); x <= Math.floor(bandTo); x += 1) {
        for (let y = Math.ceil(value.plotRect.top + 2); y <= Math.floor(value.plotRect.top + value.plotRect.height - 2); y += 1) {
          if (colorNear(png, x, y)) { bluePixels += 1; break; }
        }
      }
      expect(bluePixels, 'blue SWT 1 pixels found inside the null-outage band').toBe(0);
    });

    test(`records real nominal and stress gesture frames (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      const cdp = await page.context().newCDPSession(page);
      for (const fixture of ['nominal', 'stress'] as const) {
        const pointCount = await loadFixture(page, fixture);
        if (fixture === 'nominal') expect(pointCount).toBeGreaterThanOrEqual(FIXTURE_FEATURES.nominal.minimumPointCount);
        else expect(pointCount).toBeGreaterThanOrEqual(100_000);
        const before = await resetViewport(page);
        await beginFrameSampling(page);
        await dispatchTouchSequence(cdp, pinchPoints(before.plotRect, {
          startGap: 80, endGap: 160, startCenterFraction: 0.5, endCenterFraction: 0.5, steps: 60, pauseMs: 16,
        }));
        await settle(page);
        const frame = await endFrameSampling(page);
        await writeFrameDiagnostics(page, route, fixture, pointCount, frame);
      }
      await cdp.detach();
    });

    test(`supports the compact 390 by 844 profile with current geometry (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      await page.setViewportSize({ width: 390, height: 844 });
      await settle(page);
      const before = await currentPlot(page);
      const cdp = await page.context().newCDPSession(page);
      await dispatchTouchSequence(cdp, pinchPoints(before.plotRect, {
        startGap: 80, endGap: 160, startCenterFraction: 0.5, endCenterFraction: 0.5, steps: 12,
      }));
      await settle(page);
      const after = await probe(page);
      expect(span(after.renderedViewport)).toBeLessThan(span(before.renderedViewport) * 0.9);
      expect(rendererError(after)).toBeLessThanOrEqual(1);
      await cdp.detach();
    });

    test(`does not synthesize a click after a long press (${route})`, async ({ page }) => {
      await openCandidate(page, route);
      const before = await currentPlot(page);
      const cdp = await page.context().newCDPSession(page);
      const p = { id: 7, x: before.plotRect.left + before.plotRect.width / 2, y: before.plotRect.top + before.plotRect.height / 2, radiusX: 1, radiusY: 1, force: 1 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await page.waitForTimeout(600);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(page);
      await expect(page.getByTestId('inspector')).toHaveCount(0);
      expect((await probe(page)).route).toBe(route);
      await cdp.detach();
    });
  });
}

test('read-only readiness and production assets make no CDN or HTTP errors', async ({ page, request, baseURL }) => {
  if (!baseURL) throw new Error('Playwright baseURL is required');
  const ready = await request.get(baseURL); // GET only: deployed-base runs remain read-only.
  expect(ready.ok()).toBe(true);
  expect(await ready.text()).toContain('<div id="root"></div>');
  const foreign: string[] = [];
  const failed: string[] = [];
  const badResponses: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('request', (requestValue) => {
    const url = new URL(requestValue.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== new URL(baseURL).origin) foreign.push(requestValue.url());
  });
  page.on('requestfailed', (requestValue) => failed.push(`${requestValue.url()}: ${requestValue.failure()?.errorText ?? 'unknown'}`));
  page.on('response', (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  for (const route of candidates) await openCandidate(page, route);
  expect(foreign).toEqual([]);
  expect(failed).toEqual([]);
  expect(badResponses).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
