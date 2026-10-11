import {expect, test, type Page} from '@playwright/test';

test.setTimeout(120_000);

type FlowMonitor = {
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  externalRequests: string[];
  notices: string[];
  expectedNoticeIndexes: Set<number>;
};

async function installMonitor(page: Page): Promise<FlowMonitor> {
  const monitor: FlowMonitor = {
    pageErrors: [], failedRequests: [], badResponses: [], externalRequests: [],
    notices: [], expectedNoticeIndexes: new Set(),
  };
  const expectedOrigins = new Set(['http://127.0.0.1:4174', 'http://demo.osi.test:4174']);
  page.on('pageerror', error => monitor.pageErrors.push(error.message));
  page.on('requestfailed', request => monitor.failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`));
  page.on('request', request => {
    if (!expectedOrigins.has(new URL(request.url()).origin)) monitor.externalRequests.push(request.url());
  });
  page.on('response', response => {
    if (response.status() < 200 || response.status() >= 300) monitor.badResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.exposeBinding('__registrationNoticeObserved', (_source, message: string) => {
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
      void (window as Window & {__registrationNoticeObserved?: (message: string) => void})
        .__registrationNoticeObserved?.(notice.message);
    });
  });
  return monitor;
}

function expectCleanFlow(monitor: FlowMonitor): void {
  expect(monitor.pageErrors).toEqual([]);
  expect(monitor.failedRequests).toEqual([]);
  expect(monitor.badResponses).toEqual([]);
  expect(monitor.externalRequests).toEqual([]);
  expect(monitor.notices.filter((_notice, index) => !monitor.expectedNoticeIndexes.has(index))).toEqual([]);
}

async function openDashboard(page: Page) {
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
  const app = page.frameLocator('#app');
  await expect(app.getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();
  return app;
}

async function openAddDevice(app: Awaited<ReturnType<typeof openDashboard>>) {
  await app.getByRole('button', {name: 'Add', exact: true}).click();
  await app.getByRole('menuitem', {name: /device/i}).click();
  return app.getByRole('dialog');
}

test('registers every supported type with a prefilled DevEUI through native dashboard forms', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openDashboard(page);
  const types = [
    {id: 'KIWI_SENSOR', cardLabel: 'KIWI SENSOR'},
    {id: 'TEKTELIC_CLOVER', cardLabel: 'KIWI SENSOR'},
    {id: 'STREGA_VALVE', cardLabel: 'STREGA VALVE'},
    {id: 'DRAGINO_LSN50', cardLabel: 'LSN50'},
    {id: 'SENSECAP_S2120', cardLabel: 'S2120'},
    {id: 'AQUASCOPE_LORAIN', cardLabel: 'LoRain'},
    {id: 'MILESIGHT_UC512', cardLabel: 'Milesight UC512 · fictional device'},
    {id: 'DRAGINO_SDI12', cardLabel: 'SDI-12'},
    {id: 'RAK10701_FIELD_TESTER', cardLabel: 'FIELD TESTER'},
  ];
  const generatedEuis = new Set<string>();

  for (const [index, {id: type, cardLabel}] of types.entries()) {
    const dialog = await openAddDevice(app);
    await expect(dialog.locator('#device-type')).toHaveValue('KIWI_SENSOR');
    await dialog.locator('#device-type').selectOption(type);
    const name = `Public registration ${index + 1}`;
    const euiInput = dialog.locator('#deveui');
    const deveui = await euiInput.inputValue();
    expect(deveui, `${type} receives a valid fictional DevEUI`).toMatch(/^[0-9A-F]{16}$/);
    expect(generatedEuis.has(deveui), `${type} receives a distinct DevEUI`).toBe(false);
    generatedEuis.add(deveui);
    await expect(euiInput).toBeEnabled();
    await expect(dialog.locator('#appkey')).toHaveValue('');
    await dialog.locator('#name').fill(name);
    await expect(dialog.locator('#device-type')).toHaveValue(type);
    await dialog.locator('form').getByRole('button', {name: /add device/i}).click();

    const addedCard = app.locator('.shadow-sm').filter({has: app.getByText(name, {exact: true})});
    await expect(addedCard).toContainText(deveui);
    await expect(addedCard).toContainText(cardLabel);
  }

  const zone = app.locator('#irrigation-zone-1');
  await zone.getByRole('button', {name: '+ Device', exact: true}).click();
  const zoneDialog = app.getByRole('dialog');
  await zoneDialog.getByRole('tab', {name: 'New device', exact: true}).click();
  const zoneEuiInput = zoneDialog.locator('#zone-device-deveui');
  const zoneEui = await zoneEuiInput.inputValue();
  expect(zoneEui).toMatch(/^[0-9A-F]{16}$/);
  expect(generatedEuis.has(zoneEui), 'zone registration also receives a distinct DevEUI').toBe(false);
  await zoneDialog.locator('#zone-device-name').fill('Public zone registration');
  await zoneDialog.getByRole('button', {name: 'Register into zone', exact: true}).click();

  const deviceToggle = zone.getByRole('button', {name: /^Devices in this zone:/i});
  if (await deviceToggle.getAttribute('aria-expanded') === 'false') await deviceToggle.click();
  await expect(zone).toContainText('Public zone registration');
  await expect(zone).toContainText(zoneEui);
  expectCleanFlow(monitor);
});
