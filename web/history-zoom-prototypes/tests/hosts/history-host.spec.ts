import { expect, test } from '@playwright/test';
import { historyDataRequests, installHistoryHost, type HostPlatform } from './history-host-fixtures';
import { dispatchTouchSequence, panPoints, pinchPoints } from '../browser/cdp-touch';
const routeFor = (platform: HostPlatform) => platform === 'edge' ? '/gui/previews/mobile-soil/#/history/zones/7/cards/soil-card' : '/prototypes/mobile-soil/history/zones/7';
const platformFor = (name: string): HostPlatform => name === 'cloud' ? 'cloud' : 'edge';

test('mobile controls have touch targets and the date readout clears the chart', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const platform = platformFor(testInfo.project.name);
  const harness = await installHistoryHost(page, platform);
  try {
    await page.goto(routeFor(platform));
    const surface = page.getByTestId('mobile-soil-history');
    await expect(surface.locator('canvas').first()).toBeVisible();
    for (const control of await surface.locator('.history-ranges button, select, fieldset label').all()) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const chart = await surface.getByTestId('chart-host').boundingBox();
    const readout = page.getByLabel('Visible time window');
    await expect(readout).toBeVisible();
    expect((await readout.boundingBox())!.y).toBeGreaterThanOrEqual(chart!.y + chart!.height);
    expect(await readout.evaluate(element => getComputedStyle(element.parentElement!).overflow)).toBe('visible');
    expect(errors).toEqual([]);
  } finally { await harness.dispose(); }
});

test('mobile soil canary renders a real chart and sends host request shape', async ({ page }, testInfo) => {
  const platform = platformFor(testInfo.project.name);
  const harness = await installHistoryHost(page, platform);
  try {
    await page.goto(routeFor(platform), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mobile-soil-history')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => historyDataRequests(harness).length).toBeGreaterThan(0);
    const requests = historyDataRequests(harness); expect(requests.length).toBeGreaterThan(0);
    const url = new URL(requests[0].url()); expect(url.searchParams.get('aggregation')).toBeTruthy(); expect(url.searchParams.get('from')).toBeTruthy(); expect(url.searchParams.get('to')).toBeTruthy();
    if (platform === 'cloud') expect(url.searchParams.has('sourceKey')).toBe(false);
    if (platform === 'edge') {
      await expect(page.getByText('Probe 1').first()).toBeVisible();
      const sourcesButton = page.getByRole('button', { name: /source/i }).first();
      await expect(sourcesButton).toBeVisible();
      await sourcesButton.click();
      const probe1 = page.getByRole('checkbox', { name: 'Probe 1' });
      await expect(probe1).toBeChecked();
      await probe1.uncheck();
      await expect.poll(() => historyDataRequests(harness).some((request) => new URL(request.url()).searchParams.get('sourceKey') === 'probe-2')).toBeTruthy();
    }
  } finally { await harness.dispose(); }
});

test('mobile host sends foreground work during native pan and pinch', async ({ page }, testInfo) => {
  const platform = platformFor(testInfo.project.name);
  const harness = await installHistoryHost(page, platform);
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(routeFor(platform), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mobile-soil-history')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => historyDataRequests(harness).length).toBeGreaterThan(0);
    const layer = page.locator('.gesture-layer').first();
    await layer.scrollIntoViewIfNeeded();
    const box = await layer.boundingBox();
    expect(box).not.toBeNull();
    const rect = { left: box!.x, top: box!.y, width: box!.width, height: box!.height };
    const before = historyDataRequests(harness).length;
    await dispatchTouchSequence(cdp, panPoints(rect, { fromX: rect.width * .25, toX: rect.width * .75, steps: 12, pauseMs: 8 }));
    await expect.poll(() => historyDataRequests(harness).length).toBeGreaterThan(before);
    const afterPanReadout = await page.getByLabel('Visible time window').textContent();
    expect(afterPanReadout).toBeTruthy();
    const beforePinch = historyDataRequests(harness).length;
    await dispatchTouchSequence(cdp, pinchPoints(rect, { startGap: 80, endGap: 160, startCenterFraction: .5, endCenterFraction: .5, steps: 10, pauseMs: 8 }));
    await expect.poll(() => page.getByLabel('Visible time window').textContent()).not.toBe(afterPanReadout);
    expect(historyDataRequests(harness).length).toBeGreaterThanOrEqual(beforePinch);
  } finally { await cdp.detach(); await harness.dispose(); }
});

test('mobile host recovers an empty response after a native pan', async ({ page }, testInfo) => {
  const platform = platformFor(testInfo.project.name);
  const harness = await installHistoryHost(page, platform, false, true);
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(routeFor(platform), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('mobile-soil-history')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => historyDataRequests(harness).length).toBeGreaterThan(0);
    await expect(page.getByText(/No data|no data/i).first()).toBeVisible({ timeout: 10_000 });
    const layer = page.locator('.gesture-layer').first();
    await layer.scrollIntoViewIfNeeded();
    const box = await layer.boundingBox();
    expect(box).not.toBeNull();
    const rect = { left: box!.x, top: box!.y, width: box!.width, height: box!.height };
    await dispatchTouchSequence(cdp, panPoints(rect, { fromX: rect.width * .25, toX: rect.width * .75, steps: 12, pauseMs: 8 }));
    await expect.poll(() => historyDataRequests(harness).length).toBeGreaterThan(1);
    await expect(page.getByText(/No data|no data/i).first()).toHaveCount(0);
    await expect(page.getByTestId('chart-host')).toBeVisible();
  } finally { await cdp.detach(); await harness.dispose(); }
});

test('accepted chart remains mounted while replacement is delayed', async ({ page }, testInfo) => {
  const platform = platformFor(testInfo.project.name);
  const harness = await installHistoryHost(page, platform, true);
  try {
    await page.goto(routeFor(platform), { waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('mobile-soil-history')).toBeVisible({ timeout: 10_000 });
    const chart = page.locator('[data-testid="chart-host"]').first();
    await expect(chart).toBeVisible();
    const before = await chart.boundingBox();
    expect(before).not.toBeNull();
    const week = page.getByRole('button', { name: /7 d|7 days|7 Tage|7 jours|7 giorni|7 días|ennaku 7/i }).first();
    await expect(week).toBeVisible();
    await week.click();
    const refresh = page.locator('.mobile-history-refresh').first();
    await expect(refresh).not.toHaveText(/^\s*$/);
    expect(await chart.boundingBox()).toEqual(before);
    await expect(refresh).toHaveText(/^\s*$/);
  } finally { await harness.dispose(); }
});

test('desktop host keeps legacy history and does not mount mobile uPlot', async ({ page }, testInfo) => {
  const platform = platformFor(testInfo.project.name); await page.setViewportSize({ width: 1024, height: 800 }); const harness = await installHistoryHost(page, platform);
  try {
    await page.goto(routeFor(platform), { waitUntil: 'domcontentloaded' });
    if (platform === 'edge') {
      await expect(page.getByRole('group', { name: 'Desktop mode' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Focus', exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('complementary', { name: 'History inspector' })).toBeVisible();
    }
    await expect(page.getByTestId('mobile-soil-history')).toHaveCount(0);
  }
  finally { await harness.dispose(); }
});
