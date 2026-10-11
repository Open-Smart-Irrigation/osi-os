import {expect, test} from '@playwright/test';

test.beforeEach(async ({page}, testInfo) => {
  if (!testInfo.project.name.startsWith('firefox')) return;
  await page.route(/^http:\/\/[a-z0-9.-]+\.osi\.test:4174\//i, async route => {
    const original = new URL(route.request().url());
    const local = new URL(original);
    local.hostname = '127.0.0.1';
    local.searchParams.set('__ancestor_host', original.hostname);
    await route.fulfill({response: await route.fetch({url: local.href})});
  });
});

test('public simulator loads at its deployed base and reset stays beneath that base', async ({page}) => {
  const requests: string[] = [];
  const failures: string[] = [];
  const responses: Array<{url: string; status: number; contentType: string | undefined; cache: string | undefined}> = [];
  page.on('request', request => requests.push(request.url()));
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => responses.push({url: response.url(), status: response.status(),
    contentType: response.headers()['content-type'], cache: response.headers()['cache-control']}));

  const simulatorUrl = 'http://demo.osi.test:4174/simulator/';
  await page.goto(simulatorUrl);
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  expect(new URL(page.url()).hostname).toBe('demo.osi.test');
  await expect(page.frameLocator('#app').locator('#root')).toHaveAttribute('data-public-simulator', 'true');
  const initialAppUrl = new URL(await page.locator('#app').getAttribute('src')!, page.url());
  expect(initialAppUrl.pathname).toBe('/simulator/app.html');
  await expect(page.frameLocator('#app').getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();

  await page.reload();
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const refreshedAppUrl = new URL(await page.locator('#app').getAttribute('src')!, page.url());
  expect(refreshedAppUrl.pathname).toBe('/simulator/app.html');
  await expect(page.frameLocator('#app').getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();

  await page.getByRole('button', {name: 'Reset session'}).click();
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const resetAppUrl = new URL(await page.locator('#app').getAttribute('src')!, page.url());
  expect(resetAppUrl.pathname).toBe('/simulator/app.html');
  expect(resetAppUrl.searchParams.get('session')).not.toBe(refreshedAppUrl.searchParams.get('session'));

  expect(failures).toEqual([]);
  expect(responses.filter(response => new URL(response.url).origin === new URL(page.url()).origin)
    .every(response => response.status >= 200 && response.status < 300)).toBe(true);
  const external = requests.filter(url => new URL(url).origin !== new URL(page.url()).origin);
  expect(external, 'public simulator must not request resources outside its own origin').toEqual([]);
  const appAndAssetRequests = requests.map(url => new URL(url, page.url()).pathname)
    .filter(path => path === '/simulator/app.html' || path.startsWith('/simulator/assets/'));
  expect(appAndAssetRequests).toContain('/simulator/app.html');
  expect(appAndAssetRequests.some(path => path.startsWith('/simulator/assets/'))).toBe(true);
  expect(appAndAssetRequests.every(path => path.startsWith('/simulator/'))).toBe(true);
  const assets = responses.filter(response => new URL(response.url).pathname.startsWith('/simulator/assets/'));
  expect(assets.length).toBeGreaterThan(0);
  expect(assets.every(response => /(?:javascript|css|image|font)/i.test(response.contentType ?? ''))).toBe(true);
  expect(assets.every(response => response.cache?.includes('immutable'))).toBe(true);
  expect(responses.filter(response => new URL(response.url).pathname.endsWith('.html'))
    .every(response => response.cache?.includes('no-store'))).toBe(true);
});

test('public hostname, static headers, absent paths and traversal are constrained', async ({page, request}) => {
  const hostResponse = await request.get('/simulator/');
  expect(hostResponse.status()).toBe(200);
  expect(hostResponse.headers()['content-type']).toMatch(/^text\/html/);
  expect(hostResponse.headers()['cache-control']).toMatch(/no-store/);
  expect(hostResponse.headers()['content-security-policy']).toContain("connect-src 'none'");
  expect(hostResponse.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
  expect(hostResponse.headers()['permissions-policy']).toContain('geolocation=()');
  const appResponse = await request.get('/simulator/app.html');
  expect(appResponse.status()).toBe(200);
  expect(appResponse.headers()['content-type']).toMatch(/^text\/html/);
  expect(appResponse.headers()['cache-control']).toContain('no-store');
  expect(appResponse.headers()['content-security-policy']).toContain("connect-src 'none'");
  expect(appResponse.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
  expect((await request.get('/simulator/not-present.js')).status()).toBe(404);
  expect((await request.get('/api/devices')).status()).toBe(404);
  expect((await request.get('/simulator/%2e%2e/package.json')).status()).toBe(404);
  expect((await request.get('/website-demo/%2e%2e/package.json')).status()).toBe(404);
  const websitePreview = await request.get('/website-demo/preview.html');
  expect(websitePreview.status()).toBe(200);
  expect(websitePreview.headers()['content-type']).toMatch(/^text\/html/);
  expect(websitePreview.headers()['cache-control']).toMatch(/no-store/);
  expect(websitePreview.headers()['permissions-policy']).toContain('geolocation=()');
  expect(websitePreview.headers()['content-security-policy'] ?? '').not.toContain("connect-src 'none'");
  expect((await request.get('/website-demo/not-present.html')).status()).toBe(404);

  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const frameSrc = await page.locator('#app').getAttribute('src');
  expect(frameSrc).toMatch(/^\.\/app\.html\?/);
  expect(await page.locator('#app').getAttribute('sandbox')).toContain('allow-modals');
  expect(pageErrors).toEqual([]);
});

test('URL parameters do not switch the public artifact compiled runtime mode', async ({page}) => {
  await page.goto('/simulator/?VITE_PUBLIC_SIMULATOR=true&auth_token=inert-demo-session-not-a-jwt');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  await expect(page.frameLocator('#app').getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();
  expect(await page.locator('#app').getAttribute('src')).toContain('./app.html?session=');
});

test('non-localhost public hostname starts and transports and geolocation stay blocked', async ({page}) => {
  const attempted: string[] = [];
  page.on('request', request => attempted.push(new URL(request.url()).pathname));
  await page.goto('http://demo.osi.test:4174/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const blocked = await page.frameLocator('#app').locator('body').evaluate(async () => {
    const outcomes: string[] = [];
    try {await fetch('/api/devices');} catch {outcomes.push('fetch');}
    try {new XMLHttpRequest();} catch {outcomes.push('xhr');}
    try {new WebSocket('wss://example.invalid/socket');} catch {outcomes.push('websocket');}
    try {new EventSource('/events');} catch {outcomes.push('eventsource');}
    try {navigator.sendBeacon('/beacon', 'payload');} catch {outcomes.push('beacon');}
    const location = await new Promise<string>(resolve => navigator.geolocation.getCurrentPosition(
      () => resolve('unexpected-success'), error => resolve(error.message)));
    return {outcomes, location};
  });
  expect(blocked.outcomes).toEqual(['fetch', 'xhr', 'websocket', 'eventsource', 'beacon']);
  expect(blocked.location).toContain('Simulated environment');
  expect(attempted.some(path => path.startsWith('/api/') || path === '/events' || path === '/beacon')).toBe(false);
});
