import { expect, test } from '@playwright/test';

import { pairwiseOverlaps } from './overlap.js';

const SEED = Object.freeze({
  seed: 'osi-builder-browser-v1',
  jobs: ['job-pi5-success', 'job-pi4-interrupted'],
});
const SCENARIO_COOKIE = 'osi-builder-fixture-scenario';
const RETRY_TEST = 'retries failed event history bootstrap and re-establishes the live stream';
const RETRY_SSE_TEXT = 'Retry fixture SSE event sequence 4';

function scenarioId(testInfo: Readonly<{ project: Readonly<{ name: string }>; testId: string; retry: number; repeatEachIndex: number }>): string {
  return `${testInfo.project.name}-${testInfo.testId}-${testInfo.retry}-${testInfo.repeatEachIndex}`.replaceAll(/[^A-Za-z0-9._-]/gu, '-');
}

test.beforeEach(async ({ page }, testInfo) => {
  const scenario = scenarioId(testInfo);
  await page.context().addCookies([{
    name: SCENARIO_COOKIE,
    value: scenario,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  const reset = await page.request.post('/test/reset', {
    data: {
      eventHistoryFailures: testInfo.title === RETRY_TEST ? 1 : 0,
      emitSseEvent: testInfo.title === RETRY_TEST,
    },
  });
  expect(reset.ok()).toBe(true);
  expect(await reset.json()).toEqual(SEED);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'OSI image builder' })).toBeVisible();
  await expect(page.getByText('Connection live')).toBeVisible();
});

test('serves a deterministic operational console without overflow or control overlap', async ({ page }, testInfo) => {
  const health = await page.request.get('/api/health');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({
    status: 'ok',
    version: '0.1.0-fixture',
    activeJobId: null,
  });

  await expect(page.getByLabel('Remote branch')).toHaveValue('main');
  await expect(page.getByLabel('Output location')).toHaveValue('release');
  await expect(page.getByRole('button', { name: 'Pi 5' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('/home/phil/sdcard-images/0.7')).toBeVisible();
  await expect(page.getByRole('heading', { name: '2 jobs' })).toBeVisible();
  await expect(page.getByText('Refactor firmware build pipeline')).toBeVisible();

  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth);

  const groups = [
    '.system-status > span',
    '.segmented-control > button',
    '.form-actions > button',
    '.table-filters select, .table-filters input',
    '.job-detail__identity > span',
    '.job-detail__actions > button',
    '.detail-tabs > button',
  ];
  for (const selector of groups) {
    const overlaps = await pairwiseOverlaps(page.locator(selector));
    expect(overlaps, `${selector} has overlapping regions`).toEqual([]);
  }

  const screenshot = testInfo.project.name === 'mobile'
    ? 'builder-mobile.png'
    : 'builder-desktop.png';
  await expect(page).toHaveScreenshot(screenshot, {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test(RETRY_TEST, async ({ page, request }, testInfo) => {
  const diagnosticsPath = `/test/diagnostics?scenario=${encodeURIComponent(scenarioId(testInfo))}`;
  await expect(page.getByText('Building immutable rpi-5 image')).toBeVisible();
  await expect(page.getByText('Connection live')).toBeVisible();
  await expect(page.getByText('EVENT_HISTORY_TEMPORARILY_UNAVAILABLE')).not.toBeVisible();
  await expect(page.getByText(RETRY_SSE_TEXT)).toHaveCount(1);
  await expect.poll(async () => {
    const response = await request.get(diagnosticsPath);
    expect(response.ok()).toBe(true);
    return response.json();
  }).toMatchObject({
    eventHistoryRequests: 2,
    eventHistoryFailures: 1,
    sseStreamsOpened: 1,
    sseStreamsClosed: 0,
    sseEventsEmitted: 1,
    activeSseStreams: 1,
    maxConcurrentSseStreams: 1,
  });

  await page.goto('about:blank');
  await expect.poll(async () => {
    const response = await request.get(diagnosticsPath);
    expect(response.ok()).toBe(true);
    return response.json();
  }).toMatchObject({
    eventHistoryRequests: 2,
    eventHistoryFailures: 1,
    sseStreamsOpened: 1,
    sseStreamsClosed: 1,
    sseEventsEmitted: 1,
    activeSseStreams: 0,
    maxConcurrentSseStreams: 1,
  });
});

test('displays that publication may complete after a late cancellation request', async ({ page }) => {
  const prepare = await page.request.post('/test/prepare-late-cancellation');
  expect(prepare.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Request cancellation; publication may complete for job-pi4-interrupted' })).toBeVisible();
  await page.getByRole('button', { name: 'View job job-pi4-interrupted' }).click();
  await expect(page.getByRole('heading', { name: 'design-sync/agrolink' })).toBeVisible();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe('Request cancellation? If publication has started, publication may complete.');
    void dialog.accept();
  });
  await page.getByRole('button', { name: 'Request cancellation; publication may complete for job-pi4-interrupted' }).click();
  await expect(page.getByText('Cancellation was recorded after publication started. Publication may complete.')).toBeVisible();
});
