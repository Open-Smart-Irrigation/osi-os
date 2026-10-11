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

test('standard zone History remains reachable from its dashboard control', async ({page}, testInfo) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  const zone = app.locator('#irrigation-zone-1');
  const historyLink = zone.getByRole('link', {name: 'Data', exact: true});
  await expect(historyLink).toBeVisible();
  await historyLink.click();
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
  await expect(app.getByRole('status')).toHaveText('Saved in this demo session. No request was sent.');
  await expect(requestTitle).toHaveValue('');
  await expect(requestDescription).toHaveValue('');
  expectClean(monitor);
});
