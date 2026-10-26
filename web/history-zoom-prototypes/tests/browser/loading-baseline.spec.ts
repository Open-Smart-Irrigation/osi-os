import { expect, test, type CDPSession, type Route } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { cardDataForRequest, installPilotApi, type RecordedRequest } from './pilot-fixtures';
import { beginFrameSampling, currentPlot, endFrameSampling, probe, rendererError, span, viewportDistance } from './browser-helpers';
import { dispatchTouchSequence, panPoints, pinchPoints } from './cdp-touch';

const platforms = ['edge', 'cloud'] as const;
const runs = [1, 2, 3] as const;
const expectedSeries = 8;
const expectedPoints = 5_376;
const maxDataRequests = 2;
const maxResponseHandlers = 2;
const responseDelayMs = (bytes: number): number => 600 + (bytes / 125_000) * 1_000;

type Outcome = 'fulfilled' | 'aborted' | 'error';
type BaselineRequest = RecordedRequest & {
  bytes: number;
  delayMs: number;
  outcome: Outcome | null;
  error?: string;
};

function syntheticSeries(from: number, to: number): unknown[] {
  return Array.from({ length: expectedSeries }, (_, seriesIndex) => ({
    id: `swt-${seriesIndex}`,
    label: `Probe ${seriesIndex + 1}`,
    unit: 'kPa',
    points: Array.from({ length: 672 }, (_, pointIndex) => ({
      t: new Date(from + ((to - from) * pointIndex) / 672).toISOString(),
      value: 20 + seriesIndex + Math.sin(pointIndex / 10),
    })),
  }));
}

for (const platform of platforms) {
  for (const run of runs) {
    test(`${platform}-${run}`, async ({ page }, testInfo) => {
      const harness = await installPilotApi(page, platform);
      const records: BaselineRequest[] = [];
      let activeHandlers = 0;
      let maxActiveHandlers = 0;
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      let failure: { message: string; stack?: string } | null = null;
      let cdp: CDPSession | null = null;
      let firstReadyMs: number | null = null;
      let initialProbe: Awaited<ReturnType<typeof probe>> | null = null;
      let afterPinch: Awaited<ReturnType<typeof probe>> | null = null;
      let afterPan: Awaited<ReturnType<typeof probe>> | null = null;
      let frame: Awaited<ReturnType<typeof endFrameSampling>> | null = null;
      let finalProbe: Awaited<ReturnType<typeof probe>> | null = null;

      const routeHandler = async (route: Route): Promise<void> => {
        const url = new URL(route.request().url());
        if (!url.pathname.includes('/cards/soil-card/data')) {
          await route.fallback();
          return;
        }
        const request: BaselineRequest = {
          pathname: url.pathname,
          search: url.search,
          authorization: route.request().headers().authorization ?? null,
          origin: url.origin,
          startedAt: Date.now(),
          bytes: 0,
          delayMs: 0,
          outcome: null,
        };
        const params = new URLSearchParams(url.search);
        const from = Date.parse(params.get('from') ?? '');
        const to = Date.parse(params.get('to') ?? '');
        const body = cardDataForRequest(request, {
          series: syntheticSeries(from, to),
          aggregation: { level: params.get('aggregation') ?? 'raw', pointCount: expectedPoints },
        });
        const payload = JSON.stringify(body);
        request.bytes = Buffer.byteLength(payload, 'utf8');
        request.delayMs = responseDelayMs(request.bytes);
        records.push(request);
        activeHandlers += 1;
        maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
        try {
          await new Promise((resolve) => setTimeout(resolve, request.delayMs));
          await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: payload });
          request.outcome = 'fulfilled';
          request.status = 200;
          request.releasedAt = Date.now();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Route is already handled|Request context disposed|Target page, context or browser has been closed|net::ERR_ABORTED/i.test(message)) {
            request.outcome = 'aborted';
            request.status = null;
            request.error = message;
            request.releasedAt = Date.now();
          } else {
            request.outcome = 'error';
            request.error = message;
            request.releasedAt = Date.now();
            throw error;
          }
        } finally {
          activeHandlers -= 1;
        }
      };

      await page.route('**/*', routeHandler);
      await page.addInitScript(() => localStorage.setItem('auth_token', 'synthetic-benchmark-token'));
      const startedAt = Date.now();
      try {
        await page.goto(`./#/pilot/${platform}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('pilot-load-status')).toHaveText('Ready', { timeout: 15_000 });
        await expect(page.getByTestId('pilot-point-count')).toHaveText(`Points: ${expectedPoints.toLocaleString()}`);
        await expect(page.locator('[data-testid^="pilot-series-toggle-"]')).toHaveCount(expectedSeries);
        firstReadyMs = Date.now() - startedAt;
        const viewportSize = page.viewportSize();
        const dpr = await page.evaluate(() => window.devicePixelRatio);
        const browserVersion = await page.context().browser()?.version();
        expect(viewportSize).toEqual({ width: 448, height: 998 });
        expect(dpr).toBe(3);
        expect(browserVersion).toBeTruthy();
        initialProbe = await currentPlot(page);
        const plot = initialProbe;
        cdp = await page.context().newCDPSession(page);
        await beginFrameSampling(page);
        await dispatchTouchSequence(cdp, pinchPoints(plot.plotRect, {
          startGap: 70, endGap: 140, startCenterFraction: 0.5, endCenterFraction: 0.5, steps: 20, pauseMs: 16,
        }));
        afterPinch = await currentPlot(page);
        expect(span(afterPinch.renderedViewport) / span(initialProbe.renderedViewport)).toBeCloseTo(0.5, 1);
        await dispatchTouchSequence(cdp, panPoints(afterPinch.plotRect, {
          fromX: afterPinch.plotRect.width * 0.3, toX: afterPinch.plotRect.width * 0.7, steps: 20, pauseMs: 16,
        }));
        afterPan = await probe(page);
        expect(viewportDistance(afterPinch.renderedViewport, afterPan.renderedViewport)).toBeGreaterThan(span(afterPinch.renderedViewport) * 0.05);
        frame = await endFrameSampling(page);
        // The fixed sequence permits one nearby response after the gesture. Let
        // that response settle so diagnostics report its real outcome.
        await page.waitForTimeout(5_000);
        finalProbe = await probe(page);
        expect(finalProbe.renderedViewport).toEqual(finalProbe.requestedViewport);
        expect(rendererError(finalProbe)).toBe(0);
        expect(frame.p95Ms).toBeLessThanOrEqual(33.4);
        expect(records.length).toBeLessThanOrEqual(maxDataRequests);
        expect(maxActiveHandlers).toBeLessThanOrEqual(maxResponseHandlers);
        expect(records.every((record) => record.outcome !== null)).toBe(true);
        expect(records.some((record) => record.outcome === 'error')).toBe(false);
        expect(pageErrors).toEqual([]);
        console.log(JSON.stringify({ platform, run, firstReadyMs, p95Ms: frame.p95Ms, rendererErrorMs: rendererError(finalProbe), requests: records.length, maxActiveHandlers, bytes: records.reduce((sum, record) => sum + record.bytes, 0) }));
      } catch (error) {
        failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
        throw error;
      } finally {
        if (cdp) {
          try {
            await cdp.detach();
          } catch (error) {
            const detachFailure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
            failure ??= detachFailure;
          }
        }
        const viewportSize = page.viewportSize();
        const dpr = await page.evaluate(() => window.devicePixelRatio).catch((error: unknown) => {
          failure ??= { message: error instanceof Error ? error.message : String(error) };
          return null;
        });
        const browserVersion = await page.context().browser()?.version();
        const diagnostic = {
          status: failure ? 'failed' : 'passed', failure, platform, run, firstReadyMs, expectedSeries, expectedPoints,
          viewport: viewportSize, dpr, browserVersion,
          initialViewport: initialProbe?.renderedViewport ?? null,
          afterPinchViewport: afterPinch?.renderedViewport ?? null,
          afterPanViewport: afterPan?.renderedViewport ?? null,
          frame, rendererErrorMs: finalProbe ? rendererError(finalProbe) : null, maxActiveHandlers,
          requestCount: records.length,
          fulfilledCount: records.filter((record) => record.outcome === 'fulfilled').length,
          abortedCount: records.filter((record) => record.outcome === 'aborted').length,
          errorCount: records.filter((record) => record.outcome === 'error').length,
          requestBytes: records.map((record) => record.bytes),
          totalBytes: records.reduce((sum, record) => sum + record.bytes, 0),
          records,
          pageErrors,
          environment: 'Chromium touch emulation at 448x998 CSS px, DPR 3; synthetic auth and intercepted APIs; 8 series x 672 points; 600 ms + measured UTF-8 bytes / 125000 Bps delay',
        };
        await mkdir(testInfo.outputPath(), { recursive: true });
        await writeFile(testInfo.outputPath('diagnostics.json'), JSON.stringify(diagnostic, null, 2));
        await harness.dispose();
        await page.unroute('**/*', routeHandler);
      }
    });
  }
}
