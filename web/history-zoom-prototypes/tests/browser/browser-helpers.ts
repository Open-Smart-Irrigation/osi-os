import { expect, type CDPSession, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate, FrameSummary, HistoryZoomProbe, Viewport } from '../../src/shared/types';

export const candidates = ['echarts', 'uplot', 'chartjs'] as const;
export const diagnosticsDir = path.resolve('test-results/diagnostics');
export const routeResultsDir = path.join(diagnosticsDir, 'routes');
export const executionTarget = process.env.HISTORY_ZOOM_BASE_URL ? 'deployed-base' : 'local-preview';

export interface ProbeSnapshot {
  route: Candidate;
  requestedViewport: Viewport;
  renderedViewport: Viewport;
  plotRect: { left: number; top: number; width: number; height: number };
  adapterSetViewportCalls: number;
  viewportNotifications: number;
  reactRenderCount: number;
  frameSamples: readonly FrameSummary[];
}

export type Criterion =
  | 'pinch-step-invariance' | 'moving-anchor' | 'pinch-axis-orientation'
  | 'reverse-pinch' | 'initial-pan' | 'partial-lift-id-1'
  | 'partial-lift-id-2' | 'cancel-recovery' | 'device-orientation-resize';
export interface CriterionResult {
  status: 'PASS' | 'FAIL';
  observed: Record<string, number | string | boolean>;
}
export interface RouteResult { route: Candidate; criteria: Record<Criterion, CriterionResult> }

export async function probe(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    const value = window.__historyZoomProbe;
    if (!value) throw new Error('history zoom probe was not published');
    return {
      route: value.route,
      requestedViewport: value.requestedViewport,
      renderedViewport: value.renderedViewport,
      plotRect: value.plotRect,
      adapterSetViewportCalls: value.adapterSetViewportCalls,
      viewportNotifications: value.viewportNotifications,
      reactRenderCount: value.reactRenderCount,
      frameSamples: value.frameSamples,
    } satisfies ProbeSnapshot;
  });
}

export async function openCandidate(page: Page, route: Candidate): Promise<void> {
  await page.goto(`./#/${route}`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('chart-host')).toBeVisible();
  await expect.poll(async () => (await probe(page)).route).toBe(route);
  await currentPlot(page);
}

export async function currentPlot(page: Page): Promise<ProbeSnapshot> {
  await page.getByTestId('chart-host').scrollIntoViewIfNeeded();
  await page.waitForTimeout(50);
  const value = await probe(page);
  expect(value.plotRect.width).toBeGreaterThan(100);
  expect(value.plotRect.height).toBeGreaterThan(100);
  return value;
}

export async function resetViewport(page: Page): Promise<ProbeSnapshot> {
  await page.getByTestId('reset-viewport').click();
  await expect.poll(async () => rendererError(await probe(page))).toBeLessThanOrEqual(1);
  return currentPlot(page);
}

export const span = (viewport: Viewport): number => viewport.to - viewport.from;
export const timeAt = (viewport: Viewport, fraction: number): number => viewport.from + span(viewport) * fraction;
export const rendererError = (value: ProbeSnapshot): number => Math.max(
  Math.abs(value.requestedViewport.from - value.renderedViewport.from),
  Math.abs(value.requestedViewport.to - value.renderedViewport.to),
);
export const viewportDistance = (a: Viewport, b: Viewport): number => Math.max(
  Math.abs(a.from - b.from), Math.abs(a.to - b.to),
);

export function criterion(pass: boolean, observed: Record<string, number | string | boolean>): CriterionResult {
  expect(Object.keys(observed).length).toBeGreaterThan(0);
  for (const value of Object.values(observed)) if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
  return { status: pass ? 'PASS' : 'FAIL', observed };
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function loadFixture(page: Page, fixture: 'nominal' | 'sparse' | 'stress' | 'empty' | 'single', delay = 0): Promise<number> {
  await page.getByTestId('fixture-select').selectOption(fixture);
  await page.getByTestId('load-delay-ms').fill(String(delay));
  await page.getByTestId('load-fixture').click();
  await expect(page.getByTestId('accepted-fixture')).toHaveText(`Accepted fixture: ${fixture}`);
  const text = await page.getByTestId('point-count').innerText();
  const match = /^Point count: (\d+)$/.exec(text.trim());
  if (!match) throw new Error(`unexpected point-count text: ${text}`);
  return Number(match[1]);
}

export async function beginFrameSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!window.__historyZoomProbe) throw new Error('probe missing');
    window.__historyZoomProbe.startFrameSampling();
  });
}

export async function endFrameSampling(page: Page): Promise<FrameSummary> {
  const summary = await page.evaluate(() => {
    if (!window.__historyZoomProbe) throw new Error('probe missing');
    return window.__historyZoomProbe.stopFrameSampling();
  });
  expect(summary.sampleCount).toBeGreaterThan(0);
  return summary;
}

export async function writeFrameDiagnostics(
  page: Page, route: Candidate, fixture: 'nominal' | 'stress', pointCount: number, frame: FrameSummary,
): Promise<void> {
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(diagnosticsDir, `${route}-${fixture}.json`), JSON.stringify({
    route, fixture, pointCount, frameSummary: frame,
    browserVersion: await page.context().browser()?.version(),
    viewport: page.viewportSize(),
    dpr: await page.evaluate(() => window.devicePixelRatio),
    executionTarget,
    baseURL: new URL(page.url()).origin,
    environment: 'desktop Chromium touch emulation; real Pixel 8 Pro pending',
  }, null, 2));
}

export async function installTouchAudit(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & { __touchAudit?: Array<{ type: string; touches: number[]; changed: number[] }> };
    target.__touchAudit = [];
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      document.addEventListener(type, (event) => target.__touchAudit?.push({
        type,
        touches: [...event.touches].map((touch) => touch.identifier),
        changed: [...event.changedTouches].map((touch) => touch.identifier),
      }), { capture: true });
    }
  });
}

export async function touchAudit(page: Page): Promise<Array<{ type: string; touches: number[]; changed: number[] }>> {
  return page.evaluate(() => (window as Window & {
    __touchAudit?: Array<{ type: string; touches: number[]; changed: number[] }>;
  }).__touchAudit ?? []);
}

export async function cancelOneFinger(cdp: CDPSession, x: number, y: number): Promise<void> {
  const p = { id: 1, x, y, radiusX: 1, radiusY: 1, force: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, x: x + 35 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
}
