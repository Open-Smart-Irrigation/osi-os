import {expect, test, type Page} from '@playwright/test';

type Monitor = {
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  externalRequests: string[];
  notices: string[];
};

async function installMonitor(page: Page): Promise<Monitor> {
  const monitor: Monitor = {
    pageErrors: [], failedRequests: [], badResponses: [], externalRequests: [], notices: [],
  };
  const expectedOrigins = new Set(['http://127.0.0.1:4174', 'http://demo.osi.test:4174']);
  page.on('pageerror', error => monitor.pageErrors.push(error.message));
  page.on('requestfailed', request => monitor.failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`));
  page.on('request', request => {
    const url = new URL(request.url());
    if (!expectedOrigins.has(url.origin)) monitor.externalRequests.push(request.url());
  });
  page.on('response', response => {
    if (response.status() < 200 || response.status() >= 300) monitor.badResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.exposeBinding('__stableModuleNoticeObserved', (_source, message: string) => {
    const trimmed = message.trim();
    if (trimmed) monitor.notices.push(trimmed);
  });
  await page.addInitScript(() => {
    window.addEventListener('message', event => {
      const frame = document.querySelector<HTMLIFrameElement>('#app');
      if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const notice = data as Record<string, unknown>;
      if (notice.channel !== 'osi-mobile-simulator-v1' || notice.type !== 'notice' || Object.keys(notice).length !== 3 ||
        typeof notice.message !== 'string' || notice.message.length > 600) return;
      void (window as Window & {__stableModuleNoticeObserved?: (message: string) => void})
        .__stableModuleNoticeObserved?.(notice.message);
    });
  });
  return monitor;
}

function expectClean(monitor: Monitor): void {
  expect(monitor.pageErrors).toEqual([]);
  expect(monitor.failedRequests).toEqual([]);
  expect(monitor.badResponses).toEqual([]);
  expect(monitor.externalRequests).toEqual([]);
  expect(monitor.notices).toEqual([]);
}

async function openPublicApp(page: Page) {
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
  const app = page.frameLocator('#app');
  await expect(app.getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();
  return app;
}

async function setAppRoute(app: ReturnType<Page['frameLocator']>, route: string): Promise<void> {
  await app.locator('body').evaluate((body, hash) => {
    body.ownerDocument.defaultView!.location.hash = hash;
  }, `#${route}`);
}

async function openSoilMoistureHistoryFromOverview(app: ReturnType<Page['frameLocator']>): Promise<void> {
  const mobileShell = app.getByTestId('history-mobile-shell');
  await expect(mobileShell).toBeVisible();
  await expect(mobileShell.getByRole('combobox', {name: 'Zone'})).toHaveValue('1');
  const openHistory = mobileShell.getByRole('link', {name: 'Open Soil Moisture history', exact: true});
  await expect(openHistory).toBeVisible();
  await expect(openHistory).toHaveAttribute('href', /history\/zones\/1\/cards\//);
  await openHistory.click();
  await expect(app.getByTestId('history-visualization-surface')).toBeVisible();
}

test('public Settings keeps stable modules and omits every experimental control', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await app.getByRole('link', {name: /settings/i}).click();

  const modules = app.getByRole('region', {name: 'Modules'});
  await expect(modules.locator('[data-experimental-module]')).toHaveCount(0);
  for (const name of ['Water balance', 'Trigger-based irrigation', 'Valve control', 'Environment & weather forecast']) {
    await expect(modules.getByRole('group', {name, exact: true})).toBeVisible();
  }
  await expect(app.getByRole('region', {name: 'Journal'})).toHaveCount(0);

  const scheduler = modules.getByRole('group', {name: 'Trigger-based irrigation', exact: true});
  await expect(scheduler.getByRole('button', {name: 'On', exact: true})).toHaveAttribute('aria-pressed', 'true');
  expectClean(monitor);
});

test('public dashboard navigation hides experimental module entries', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);

  const dashboardHeader = app.locator('header').first();
  await expect(dashboardHeader.getByRole('link', {name: 'Data', exact: true})).toHaveCount(0);
  await expect(dashboardHeader.getByRole('link', {name: 'History', exact: true})).toHaveCount(0);
  await expect(app.getByRole('link', {name: 'Data', exact: true})).toHaveCount(0);
  await expect(app.getByRole('button', {name: 'Data', exact: true})).toHaveCount(0);
  await expect(dashboardHeader.getByRole('link', {name: 'Network', exact: true})).toHaveCount(0);
  await expect(app.getByRole('heading', {name: 'Gateway', exact: true})).toHaveCount(0);
  await app.getByRole('button', {name: 'Add', exact: true}).click();
  await expect(app.getByRole('menuitem', {name: 'Log activity', exact: true})).toHaveCount(0);

  expectClean(monitor);
});

for (const route of [
  '/analysis',
  '/network',
  '/journal',
  '/history/gateways/00000000000000D1/cards/gateway-hub',
]) {
  test(`public direct route ${route} returns to the standard dashboard`, async ({page}) => {
    const monitor = await installMonitor(page);
    const app = await openPublicApp(page);
    await setAppRoute(app, route);
    await expect.poll(() => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.location.hash))
      .toBe('#/dashboard');
    await expect(app.getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();
    expectClean(monitor);
  });
}

test('standard zone History remains reachable directly without a dashboard shortcut', async ({page}, testInfo) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  const zone = app.locator('#irrigation-zone-1');
  await expect(zone.getByRole('link', {name: 'History', exact: true})).toHaveCount(0);
  await setAppRoute(app, '/history/zones/1');
  await expect.poll(() => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.location.hash))
    .toBe('#/history/zones/1');
  await expect(app.getByTestId('history-visualization-surface')).toBeVisible();
  await expect(app.getByRole('heading', {name: /Tomato plot/i})).toBeVisible();

  await setAppRoute(app, '/history');
  await expect(app.getByRole('heading', {name: /^History$/i})).toBeVisible();
  if (testInfo.project.name === 'chromium-mobile') {
    await openSoilMoistureHistoryFromOverview(app);
    await expect.poll(() => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.location.hash))
      .toMatch(/^#\/history\/zones\/1\/cards\//);
  }

  expectClean(monitor);
});

test('public Environment shows data-backed tabs and the native S2120 card has complete readings', async ({page}, testInfo) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  const zone = app.locator('#irrigation-zone-2');
  const zoneToggle = zone.getByRole('button', {name: /^Demonstration bed \d+ devices?$/});
  if (await zoneToggle.getAttribute('aria-expanded') === 'false') await zoneToggle.click();
  const environmentToggle = zone.getByRole('button', {name: /^Environment/});
  await expect(environmentToggle).toContainText('Environment & weather forecast');
  await environmentToggle.click();
  const environment = environmentToggle.locator('xpath=..');
  for (const name of ['Water', 'Soil', 'Weather', 'Agronomic', 'Sensors']) {
    await expect(environment.getByRole('button', {name, exact: true})).toBeVisible();
  }
  await page.screenshot({path: testInfo.outputPath('public-environment.png'), fullPage: true});

  const deviceToggle = zone.getByRole('button', {name: /^Devices in this zone:/i});
  if (await deviceToggle.getAttribute('aria-expanded') === 'false') await deviceToggle.click();
  const station = zone.getByRole('heading', {name: 'Weather station', exact: true})
    .locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
  await expect(station.getByText('S2120', {exact: true})).toBeVisible();
  const titleBounds = await station.getByRole('heading', {name: 'Weather station', exact: true})
    .evaluate(title => ({height: title.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(title).lineHeight),
      scrollWidth: title.scrollWidth, clientWidth: title.clientWidth}));
  expect(titleBounds.height, 'weather station title remains visible').toBeGreaterThan(0);
  expect(titleBounds.scrollWidth, 'weather station title wraps without horizontal clipping').toBeLessThanOrEqual(titleBounds.clientWidth);
  expect(titleBounds.height, 'weather station title stays within four readable lines').toBeLessThanOrEqual(titleBounds.lineHeight * 4 + 1);
  for (const [label, value] of [
    ['Rain recorded today', /\d+(?:\.\d+)?\s*mm/],
    ['Pressure', /\d+(?:\.\d+)?\s*hPa/],
    ['Light', /\d+(?:\.\d+)?\s*(?:k )?lux/],
    ['UV Index', /\d+(?:\.\d+)?\s*UVI/],
  ] as const) {
    const tile = station.getByText(label, {exact: true}).locator('xpath=..');
    await expect(tile.getByRole('button')).toHaveText(value);
  }
  await station.scrollIntoViewIfNeeded();
  await page.screenshot({path: testInfo.outputPath('public-s2120.png'), fullPage: true});
  expectClean(monitor);
});

test('support submission remains a normal Settings journey', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await app.getByRole('link', {name: /settings/i}).click();
  const requestTitle = app.locator('#user-request-title');
  const requestDescription = app.locator('#user-request-description');
  await requestTitle.fill('Release local support check');
  await requestDescription.fill('This receipt stays in the local simulator session.');
  await app.getByLabel('May be shared publicly without private farm details.').check();
  const saveRequest = app.getByRole('button', {name: 'Save request', exact: true});
  await expect(saveRequest).toBeEnabled();
  await saveRequest.click();
  await expect(app.getByRole('status')).toHaveText('Saved.');
  await expect(requestTitle).toHaveValue('');
  await expect(requestDescription).toHaveValue('');
  expectClean(monitor);
});
