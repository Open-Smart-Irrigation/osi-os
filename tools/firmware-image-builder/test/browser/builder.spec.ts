import { expect, test } from '@playwright/test';

import { pairwiseOverlaps } from './overlap.js';

const SEED = Object.freeze({
  seed: 'osi-builder-browser-v1',
  jobs: ['job-pi5-success', 'job-pi4-interrupted'],
});

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post('/test/reset');
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
