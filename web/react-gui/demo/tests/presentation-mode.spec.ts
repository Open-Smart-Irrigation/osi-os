import {expect, test} from '@playwright/test';

test('presentation artifact keeps its localhost guard despite URL and storage values', async ({page}) => {
  const errors: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('VITE_PUBLIC_SIMULATOR', 'true');
    localStorage.setItem('auth_token', 'public-demo-session');
  });
  await page.route(/^http:\/\/demo\.osi\.test:4173\//, async route => {
    const local = new URL(route.request().url());
    local.hostname = '127.0.0.1';
    await route.fulfill({response: await route.fetch({url: local.href})});
  });
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('http://demo.osi.test:4173/demo/app.html?VITE_PUBLIC_SIMULATOR=true&auth_token=public-demo-session');

  await expect.poll(() => errors).toContain('Demo requires localhost');
  await expect(page.locator('#root')).toBeEmpty();
});
