import { expect, test, type CDPSession, type Page, type Route } from '@playwright/test';
import { cardDataForRequest, installPilotApi, requestBounds, type PilotApiHarness, type PilotPlatform, type RecordedRequest } from './pilot-fixtures';
import { currentPlot, rendererError, settle, span } from './browser-helpers';
import { dispatchTouchSequence, panPoints, pinchPoints } from './cdp-touch';
import { minuteViewport, requestForViewport } from '../../src/pilot/range';

const DAY_MS = 86_400_000;
const TOKEN = 'pilot-browser-token';

async function installSpanFixture(page: Page, platform: PilotPlatform, emptyAfter?: number): Promise<{ harness: PilotApiHarness; route: (route: Route) => Promise<void> }> {
  const harness = await installPilotApi(page, platform);
  const route = async (requestRoute: Route): Promise<void> => {
    const url = new URL(requestRoute.request().url());
    if (!url.pathname.endsWith('/data')) {
      await requestRoute.fallback();
      return;
    }
    const request: RecordedRequest = {
      pathname: url.pathname,
      search: url.search,
      authorization: requestRoute.request().headers().authorization ?? null,
      origin: url.origin,
      startedAt: Date.now(),
    };
    harness.dataRequests.push(request);
    const from = Date.parse(url.searchParams.get('from') ?? '');
    const to = Date.parse(url.searchParams.get('to') ?? '');
    const empty = Number.isFinite(from) && Number.isFinite(to) && (emptyAfter === undefined ? to - from > 1.5 * DAY_MS : to > emptyAfter);
    await requestRoute.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cardDataForRequest(request, empty ? { series: [] } : {})),
    });
  };
  await page.route('**/*', route);
  return { harness, route };
}

test.describe('pilot empty-response recovery', () => {
  for (const platform of ['edge', 'cloud'] as const) {
    test(`keeps ${platform} chart gestures alive through empty zoom-out data`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const { harness, route } = await installSpanFixture(page, platform);
      let cdp: CDPSession | undefined;
      try {
        await page.addInitScript((token) => localStorage.setItem('auth_token', token), TOKEN);
        await page.goto(`./#/pilot/${platform}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('pilot-shell')).toBeVisible();
        await expect(page.getByTestId('pilot-load-status')).toHaveText('Ready');
        await expect(page.getByTestId('chart-host')).toBeVisible();
        await expect(page.getByTestId('pilot-unit-select')).toHaveValue('kPa');
        await page.getByTestId('pilot-unit-select').selectOption('C');
        await expect(page.getByTestId('pilot-unit-select')).toHaveValue('C');

        cdp = await page.context().newCDPSession(page);
        const initial = await currentPlot(page);
        const initialBox = await page.getByTestId('chart-host').boundingBox();
        const chartMarker = `empty-recovery-${platform}`;
        await page.getByTestId('chart-host').evaluate((node, marker) => node.setAttribute('data-empty-recovery-marker', marker), chartMarker);
        await dispatchTouchSequence(cdp, pinchPoints(initial.plotRect, {
          startGap: 150,
          endGap: 40,
          startCenterFraction: 0.5,
          endCenterFraction: 0.5,
          steps: 14,
          pauseMs: 8,
        }));
        await settle(page);
        await expect(page.getByTestId('pilot-empty')).toBeVisible();
        await expect(page.locator('.pilot-chart-wrap')).toHaveCount(1);
        await expect(page.getByTestId('chart-host')).toBeVisible();
        expect(await page.getByTestId('chart-host').boundingBox()).toEqual(initialBox);
        await expect(page.getByTestId('chart-host')).toHaveAttribute('data-empty-recovery-marker', chartMarker);
        await expect(page.getByTestId('pilot-unit-select')).toHaveValue('C');

        const emptyPlot = await currentPlot(page);
        await page.touchscreen.tap(emptyPlot.plotRect.left + emptyPlot.plotRect.width / 2, emptyPlot.plotRect.top + emptyPlot.plotRect.height / 2);
        await expect(page.getByTestId('inspector')).toHaveCount(0);
        const emptyVisible = emptyPlot.requestedViewport;
        const emptyDemand = minuteViewport(emptyVisible);
        const expectedEmptyAggregation = requestForViewport(emptyDemand).aggregation;
        const emptyRequest = harness.dataRequests.find((candidate) => {
          const bounds = requestBounds(candidate);
          return bounds.aggregation === expectedEmptyAggregation && Date.parse(bounds.from) <= emptyDemand.from && Date.parse(bounds.to) >= emptyDemand.to;
        });
        expect(emptyRequest).toBeTruthy();
        expect(emptyRequest!.pathname).toBe(`/api${platform === 'cloud' ? '/v1' : ''}/history/zones/7/cards/soil-card/data`);
        const emptyBounds = requestBounds(emptyRequest!);
        expect(Date.parse(emptyBounds.from)).toBeLessThanOrEqual(emptyDemand.from);
        expect(Date.parse(emptyBounds.to)).toBeGreaterThanOrEqual(emptyDemand.to);
        expect(emptyBounds.aggregation).toBe(expectedEmptyAggregation);
        expect(Date.parse(emptyBounds.to) - Date.parse(emptyBounds.from)).toBeLessThanOrEqual(90 * DAY_MS);
        await dispatchTouchSequence(cdp, pinchPoints(emptyPlot.plotRect, {
          startGap: 40,
          endGap: 150,
          startCenterFraction: 0.5,
          endCenterFraction: 0.5,
          steps: 14,
          pauseMs: 8,
        }));
        await settle(page);
        await expect(page.getByTestId('pilot-empty')).toHaveCount(0);
        await expect(page.getByTestId('chart-host')).toBeVisible();
        await expect(page.getByTestId('chart-host')).toHaveAttribute('data-empty-recovery-marker', chartMarker);
        await expect(page.getByTestId('pilot-unit-select')).toHaveValue('C');
        await expect(page.getByTestId('pilot-legend')).toContainText('Air temperature (C)');
        const recovered = await currentPlot(page);
        expect(span(recovered.requestedViewport)).toBeLessThan(span(emptyPlot.requestedViewport));
        expect(rendererError(recovered)).toBeLessThanOrEqual(1);
        const recoveredDemand = minuteViewport(recovered.requestedViewport);
        const expectedRecoveredAggregation = requestForViewport(recoveredDemand).aggregation;
        const finalRequest = harness.dataRequests.find((candidate) => {
          const bounds = requestBounds(candidate);
          return bounds.aggregation === expectedRecoveredAggregation && Date.parse(bounds.from) <= recoveredDemand.from && Date.parse(bounds.to) >= recoveredDemand.to;
        });
        expect(finalRequest).toBeTruthy();
        expect(Date.parse(requestBounds(finalRequest!).to) - Date.parse(requestBounds(finalRequest!).from)).toBeLessThanOrEqual(90 * DAY_MS);
        expect(requestBounds(finalRequest!).aggregation).toBe('raw');
      } finally {
        await cdp?.detach().catch(() => undefined);
        await page.unroute('**/*', route);
        await harness.dispose();
      }
    });

    test(`recovers ${platform} from an initially empty latest interval with native pan`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const emptyAfter = Date.now() - 6 * 60 * 60 * 1_000;
      const { harness, route } = await installSpanFixture(page, platform, emptyAfter);
      let cdp: CDPSession | undefined;
      try {
        await page.addInitScript((token) => localStorage.setItem('auth_token', token), TOKEN);
        await page.goto(`./#/pilot/${platform}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('pilot-shell')).toBeVisible();
        await expect(page.getByTestId('pilot-load-status')).toHaveText('Ready · no data');
        await expect(page.getByTestId('pilot-empty')).toBeVisible();
        await expect(page.getByTestId('chart-host')).toBeVisible();
        const emptyPlot = await currentPlot(page);
        const emptyBox = await page.getByTestId('chart-host').boundingBox();
        const chartMarker = `initial-empty-recovery-${platform}`;
        await page.getByTestId('chart-host').evaluate((node, marker) => node.setAttribute('data-empty-recovery-marker', marker), chartMarker);
        const emptyProbe = await page.evaluate(() => window.__historyZoomProbe);
        cdp = await page.context().newCDPSession(page);
        await dispatchTouchSequence(cdp, panPoints(emptyPlot.plotRect, { fromX: emptyPlot.plotRect.width * 0.15, toX: emptyPlot.plotRect.width * 0.85, steps: 16, pauseMs: 8 }));
        await settle(page);
        await expect(page.getByTestId('pilot-empty')).toHaveCount(0);
        await expect(page.locator('.pilot-chart-wrap')).toHaveCount(1);
        await expect(page.getByTestId('chart-host')).toHaveAttribute('data-empty-recovery-marker', chartMarker);
        const recoveredBox = await page.getByTestId('chart-host').boundingBox();
        expect(recoveredBox?.width).toBe(emptyBox?.width);
        expect(recoveredBox?.height).toBe(emptyBox?.height);
        await expect(page.getByTestId('pilot-legend')).toContainText('20 cm (kPa)');
        const recovered = await currentPlot(page);
        expect(Math.abs(span(recovered.requestedViewport) - span(emptyProbe!.requestedViewport))).toBeLessThanOrEqual(1);
        expect(recovered.requestedViewport.from).toBeLessThan(emptyProbe!.requestedViewport.from);
        expect(recovered.requestedViewport.to).toBeLessThan(emptyProbe!.requestedViewport.to);
        expect(rendererError(recovered)).toBeLessThanOrEqual(1);
      } finally {
        await cdp?.detach().catch(() => undefined);
        await page.unroute('**/*', route);
        await harness.dispose();
      }
    });

    test(`navigates ${platform} beyond 90 days while keeping each view bounded`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const { harness, route } = await installSpanFixture(page, platform, Number.POSITIVE_INFINITY);
      let cdp: CDPSession | undefined;
      try {
        await page.addInitScript((token) => localStorage.setItem('auth_token', token), TOKEN);
        await page.goto(`./#/pilot/${platform}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('pilot-load-status')).toHaveText('Ready');
        await page.getByTestId('pilot-range-90d').click();
        await expect(page.getByTestId('pilot-load-status')).toHaveText('Ready');
        const plot = await currentPlot(page);
        const at90Days = await probeViewport(page);
        expect(span(at90Days)).toBeLessThanOrEqual(90 * DAY_MS + 1);
        const beforeOlder = harness.dataRequests.length;
        await page.getByTestId('pilot-window-back').click();
        await expect.poll(async () => (await probeViewport(page)).from).toBeLessThan(at90Days.from - DAY_MS);
        const olderViewport = await probeViewport(page);
        expect(olderViewport.to).toBeLessThan(at90Days.to);
        expect(Math.abs(span(olderViewport) - span(at90Days))).toBeLessThanOrEqual(1);
        const expectedOlder = requestForViewport(minuteViewport(olderViewport));
        await expect.poll(() => harness.dataRequests.find((request) => {
          const bounds = requestBounds(request);
          const from = Date.parse(bounds.from);
          const to = Date.parse(bounds.to);
          return bounds.aggregation === expectedOlder.aggregation && from <= olderViewport.from && to >= olderViewport.to && from >= 0 && to - from <= 90 * DAY_MS;
        })).toBeTruthy();
        expect(harness.dataRequests.length).toBeGreaterThan(beforeOlder);
        cdp = await page.context().newCDPSession(page);
        await dispatchTouchSequence(cdp, pinchPoints(plot.plotRect, { startGap: 150, endGap: 40, startCenterFraction: 0.5, endCenterFraction: 0.5, steps: 12, pauseMs: 8 }));
        await settle(page);
        const clamped = await probeViewport(page);
        expect(span(clamped)).toBeLessThanOrEqual(90 * DAY_MS + 1);
        await dispatchTouchSequence(cdp, pinchPoints((await currentPlot(page)).plotRect, { startGap: 40, endGap: 150, startCenterFraction: 0.5, endCenterFraction: 0.5, steps: 12, pauseMs: 8 }));
        await settle(page);
        const zoomedIn = await probeViewport(page);
        expect(span(zoomedIn)).toBeLessThan(span(clamped));
        expect(span(zoomedIn)).toBeLessThanOrEqual(90 * DAY_MS + 1);
        expect(rendererError(await currentPlot(page))).toBeLessThanOrEqual(1);
        const beforeOlderPan = zoomedIn;
        await dispatchTouchSequence(cdp, panPoints((await currentPlot(page)).plotRect, { fromX: 0.15 * plot.plotRect.width, toX: 0.85 * plot.plotRect.width, steps: 14, pauseMs: 8 }));
        await settle(page);
        const olderPan = await probeViewport(page);
        expect(olderPan.from).toBeLessThan(beforeOlderPan.from - DAY_MS);
        expect(olderPan.to).toBeLessThan(beforeOlderPan.to - DAY_MS);
        expect(Math.abs(span(olderPan) - span(beforeOlderPan))).toBeLessThanOrEqual(1);
        const olderPanDemand = minuteViewport(olderPan);
        const expectedPan = requestForViewport(olderPanDemand);
        await expect.poll(() => harness.dataRequests.find((request) => {
          const bounds = requestBounds(request);
          return bounds.aggregation === expectedPan.aggregation && Date.parse(bounds.from) <= olderPanDemand.from && Date.parse(bounds.to) >= olderPanDemand.to && Date.parse(bounds.from) >= 0;
        })).toBeTruthy();
      } finally {
        await cdp?.detach().catch(() => undefined);
        await page.unroute('**/*', route);
        await harness.dispose();
      }
    });
  }
});

async function probeViewport(page: Page): Promise<{ from: number; to: number }> {
  return page.evaluate(() => window.__historyZoomProbe?.requestedViewport ?? { from: 0, to: 0 });
}
