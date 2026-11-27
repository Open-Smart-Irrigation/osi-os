import {expect, type Page} from '@playwright/test';
import {join} from 'node:path';
import {PHONE_FRAME, selectEnvironmentTab, showZoneDevices, startTimedDrip, test} from './phone-fixture';

test.use({viewport: {width: 1280, height: 900}});

async function raiseGamePhone(page: Page, tier: '2' | '3') {
  await page.goto('./index.html?facilitator');
  const panel = page.getByRole('region', {name: 'Facilitator'});
  await panel.getByLabel('Tier').selectOption(tier);
  await panel.getByRole('button', {name: 'Start new run'}).click();
  await expect(page.locator(PHONE_FRAME)).toHaveCount(0);
  await page.getByRole('button', {name: 'Raise phone'}).click();
  await expect(page.getByText('Phone starting…', {exact: true})).toBeVisible();
  const phone = page.frameLocator(PHONE_FRAME);
  await expect(phone.getByRole('heading', {name: 'Tomato bed', exact: true})).toBeVisible();
  return phone;
}

test('the built game runs the drip line after a timed open in the T3 phone', async ({page}, testInfo) => {
  const capture = (name: string) => page.screenshot({
    path: process.env.FARM_SIM_E2E_ARTIFACTS ? join(process.env.FARM_SIM_E2E_ARTIFACTS, name) : testInfo.outputPath(name),
  });

  const t2 = await raiseGamePhone(page, '2');
  await selectEnvironmentTab(t2, 'en', 'water');
  await expect(t2.getByTestId('water-action-tile')).toBeVisible();
  await capture('game-phone-t2.png');

  const t3 = await raiseGamePhone(page, '3');
  await showZoneDevices(t3, 'en');
  await expect(t3.locator('input[id^="strega-duration-"]')).toBeVisible();
  await capture('game-phone-t3.png');
  const farm = page.getByLabel('Farm view');
  await expect(farm).toHaveAttribute('aria-description', 'Drip line idle');
  await startTimedDrip(t3, '10');
  await expect(farm).toHaveAttribute('aria-description', 'Drip line idle');
  await page.getByRole('button', {name: 'Lower phone'}).click();
  await expect(page.locator(PHONE_FRAME)).toBeHidden();
  await expect(farm).toHaveAttribute('aria-description', 'Drip line running');
});
