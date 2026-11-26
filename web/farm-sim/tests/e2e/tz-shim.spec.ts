import {expect} from '@playwright/test';
import {currentSummary, raisePhone, selectEnvironmentTab, test} from './phone-fixture';

for (const timezoneId of ['Pacific/Honolulu', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
  test.describe(timezoneId, () => {
    test.use({timezoneId});
    test('today follows the farm date and Intl reports the farm query zone', async ({page}) => {
      // Tokyo is ahead of the farm. The other test zones are behind it.
      const sample = timezoneId === 'Asia/Tokyo' ? 'late' : 'early';
      const phone = await raisePhone(page, 'tier=2&near-midnight=' + sample);
      const {forecast, water} = await currentSummary(page);
      expect(forecast.rainFocus?.daily[0].date).toBe(water.todayDate);
      const installed = await phone.locator('html').evaluate(() => {
        const date = new Date();
        return {
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          date: [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('-'),
        };
      });
      const host = await page.evaluate(() => {
        const date = new Date(window.__farmSim!.now());
        return {
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          date: [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('-'),
        };
      });
      expect(host.zone).toBe(timezoneId);
      expect(host.date).not.toBe(water.todayDate);
      expect(installed).toEqual({zone: 'Etc/GMT-3', date: water.todayDate});
      await selectEnvironmentTab(phone, 'en', 'weather');
      const strip = phone.locator('div.snap-x');
      const highlighted = strip.locator('div[class*="border-[var(--primary)]"]');
      await expect(highlighted).toHaveCount(1);
      await expect(highlighted.getByText('Today', {exact: true})).toBeVisible();
      await expect(strip.locator(':scope > div').first().getByText('Today', {exact: true})).toBeVisible();
    });
  });
}
