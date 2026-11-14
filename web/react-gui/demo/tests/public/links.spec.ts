import {expect, test} from '@playwright/test';

test('public host renders only approved role links and valid Open Graph metadata', async ({page, request}) => {
  const rawHtml = await (await request.get('/simulator/')).text();
  const rawImage = rawHtml.match(/property="og:image" content="([^"]+)"/)?.[1];
  expect(rawImage).toBe('https://opensmartirrigation.org/simulator/assets/osi-os-preview.png');
  expect((await request.get(new URL(rawImage!).pathname)).status()).toBe(200);
  await page.setViewportSize({width: 1280, height: 800});
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const links = await page.locator('[data-public-link]').evaluateAll(anchors => anchors.map(anchor => ({
    href: (anchor as HTMLAnchorElement).getAttribute('href'), rel: (anchor as HTMLAnchorElement).rel,
  })));
  const allowed = new Set(['/', '/osi-system/', 'https://github.com/Open-Smart-Irrigation/osi-os', 'https://github.com/Open-Smart-Irrigation/osi-os#device-setup']);
  expect(links.length).toBeGreaterThan(4);
  for (const link of links) {
    expect(allowed.has(link.href ?? '')).toBe(true);
    if (link.href?.startsWith('https://')) expect(link.rel).toBe('noopener');
  }
  const metadata = await page.locator('meta[property^="og:"]').evaluateAll(tags => Object.fromEntries(tags.map(tag => [tag.getAttribute('property'), tag.getAttribute('content')])));
  expect(metadata['og:title']).toBe('Explore OSI OS');
  expect(metadata['og:description']).toContain('sensor readings');
  const image = metadata['og:image'] as string;
  expect(image).toContain('/simulator/assets/');
  expect((await request.get(new URL(image).pathname)).status()).toBe(200);
});

test('the guided path links app surfaces without changing farm state', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 800});
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const app = page.frameLocator('#app');
  const waterBefore = await app.getByTestId('water-today-card').innerText();
  const valveBefore = await app.getByTestId('valve-actions').first().innerText();
  await page.locator('#guide-start').click();
  await expect(page.locator('#guide-intro')).toBeVisible();
  await expect(page.locator('#guide-step-copy')).toBeHidden();
  await page.locator('#guide-next').click();
  await expect(page.locator('#guide-step-copy')).toBeVisible();
  await expect(app.getByTestId('water-today-card')).toHaveClass(/demo-guide-target/);
  await page.locator('#guide-next').click();
  for (const target of ['water-action-tile', 'zone-history-link', 'valve-actions']) {
    if (target === 'zone-history-link') {
      await expect(app.getByTestId('history-detail-scroll-root')).toHaveClass(/demo-guide-target/);
      await expect(app.getByRole('heading', {name: /Tomato plot/i})).toBeVisible();
      await page.locator('#guide-next').click();
      continue;
    }
    await expect(app.locator(`[data-testid="${target}"].demo-guide-target`)).toBeVisible({timeout: 5_000});
    await page.locator('#guide-next').click();
  }
  await expect(page.locator('#guide-next')).toBeEnabled();
  await expect(page.locator('#guide-next')).toHaveText('Retry this step');
  expect(await app.getByTestId('water-today-card').innerText()).toBe(waterBefore);
  expect(await app.getByTestId('valve-actions').first().innerText()).toBe(valveBefore);
  await page.locator('#guide-close').click();
  await page.locator('#guide-start').click();
  await expect(page.locator('#guide-next')).toBeEnabled();
});

test('website CTA fixture has visible simulator and OSI OS links', async ({page, request}) => {
  const response = await request.get('/website-demo/preview.html');
  expect(response.status()).toBe(200);
  await page.goto('/website-demo/preview.html');
  const cta = page.locator('.osi-simulator-cta');
  await expect(cta).toBeVisible();
  await expect(cta.getByRole('link', {name: 'Try the OSI OS simulator'})).toHaveAttribute('href', '/simulator/');
  await expect(cta.getByRole('link', {name: 'About OSI OS'})).toHaveAttribute('href', '/osi-system/');
  expect((await request.get('/website-demo/cta.css')).status()).toBe(200);
});
