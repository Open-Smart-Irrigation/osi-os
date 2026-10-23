import { expect, test, type Page } from '@playwright/test';
import { dispatchTouchSequence, pinchPoints } from '../browser/cdp-touch';
import { installHistoryHost, historyDataRequests, type HostPlatform } from './history-host-fixtures';

const route = (host: HostPlatform) => host === 'edge' ? '/gui/previews/mobile-soil/#/history/zones/7/cards/soil-card' : '/prototypes/mobile-soil/history/zones/7';
const hostOf = (name: string): HostPlatform => name === 'cloud' ? 'cloud' : 'edge';
async function ready(page: Page) {
  await expect(page.getByTestId('chart-host')).toBeVisible();
  await expect(page.locator('.mobile-soil-history fieldset input')).toHaveCount(2);
  await expect(page.locator('.mobile-history-refresh')).toHaveAttribute('aria-hidden', 'true');
}

test('preserves all-hidden choices and chart geometry across an empty zoom-out', async ({ page }, info) => {
  const host = hostOf(info.project.name);
  const fixture = await installHistoryHost(page, host);
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(route(host)); await ready(page);
    const chart = page.getByTestId('chart-host');
    await chart.scrollIntoViewIfNeeded();
    // Button activation may scroll the page; compare document geometry.
    const documentBox = () => chart.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }; });
    const before = await documentBox();
    await page.locator('.mobile-soil-history fieldset input').nth(0).uncheck();
    await page.locator('.mobile-soil-history fieldset input').nth(1).uncheck();
    fixture.setEmpty(true);
    await page.getByRole('button', { name: '90 days', exact: true }).click();
    await expect(page.locator('.mobile-soil-history .history-empty')).toBeVisible();
    await expect(page.locator('.mobile-soil-history fieldset input:checked')).toHaveCount(0);
    expect(await documentBox()).toEqual(before);
    fixture.setEmpty(false);
    const layer = page.locator('.mobile-soil-history .gesture-layer');
    await layer.scrollIntoViewIfNeeded();
    const box = (await layer.boundingBox())!;
    await dispatchTouchSequence(cdp, pinchPoints({left: box.x, top: box.y, width: box.width, height: box.height}, {startGap: 35, endGap: 220, startCenterFraction: .5, endCenterFraction: .5, steps: 18, pauseMs: 16}));
    await expect(page.locator('.mobile-soil-history .history-empty')).toHaveCount(0);
    await expect(page.locator('.mobile-soil-history fieldset input:checked')).toHaveCount(0);
    await page.locator('.mobile-soil-history fieldset input').nth(0).check();
    await expect(page.locator('.mobile-soil-history fieldset input:checked')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await cdp.detach(); await fixture.dispose(); }
});

test('keeps unit controls, inspection and Latest usable at Pixel-width', async ({ page }, info) => {
  await page.setViewportSize({width:448,height:998});
  const host = hostOf(info.project.name), fixture = await installHistoryHost(page, host);
  try {
    await page.goto(route(host)); await ready(page);
    await page.locator('.mobile-history-unit select').selectOption('°C');
    await expect(page.locator('.mobile-soil-history fieldset input')).toHaveCount(1);
    await expect(page.locator('.mobile-soil-history fieldset')).toContainText('Soil temperature');
    const layer = page.locator('.mobile-soil-history .gesture-layer'); await layer.scrollIntoViewIfNeeded();
    const box = (await layer.boundingBox())!;
    await page.mouse.click(box.x + box.width * .4, box.y + box.height * .5);
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('inspector')).toContainText('Soil temperature');
    await page.getByTestId('inspector-close').click();
    const before = historyDataRequests(fixture).length;
    await page.getByRole('button', {name:'Latest',exact:true}).click();
    await expect.poll(() => historyDataRequests(fixture).length).toBeGreaterThan(before);
    await expect(page.locator('.mobile-history-unit select')).toHaveValue('°C');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await fixture.dispose(); }
});

test('can navigate beyond 90 days while every data request stays bounded', async ({ page }, info) => {
  const host = hostOf(info.project.name), fixture = await installHistoryHost(page, host);
  try {
    await page.goto(route(host)); await ready(page);
    await page.getByRole('button', {name:'90 days',exact:true}).click();
    await expect.poll(() => historyDataRequests(fixture).some(r => new URL(r.url()).searchParams.get('aggregation') === 'daily')).toBe(true);
    await page.getByRole('button', {name:'Back',exact:true}).click();
    await page.getByRole('button', {name:'Back',exact:true}).click();
    await expect.poll(() => historyDataRequests(fixture).some(r => Date.parse(new URL(r.url()).searchParams.get('to')!) < Date.now() - 90 * 86400000)).toBe(true);
    for (const request of historyDataRequests(fixture)) {
      const p = new URL(request.url()).searchParams;
      expect(Date.parse(p.get('to')!) - Date.parse(p.get('from')!)).toBeLessThanOrEqual(90 * 86400000);
    }
  } finally { await fixture.dispose(); }
});
