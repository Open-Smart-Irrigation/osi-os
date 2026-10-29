import { expect, test, type Page, type Route } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:4181';
const DEV_EUI = '0'.repeat(16);
const APP_KEY = '0'.repeat(32);
const groupedDevEui = '00 00 00 00 00 00 00 00';
const groupedAppKey = '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00';

type AddRequest = Record<string, unknown>;

type FixtureState = {
  unknownApi: string[];
  externalRequests: string[];
  addRequests: AddRequest[];
};

function response(status: number, body: unknown) {
  return { status, body };
}

async function installLocalBoundary(page: Page, state: FixtureState) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'issue-426-local-fixture-token');
    localStorage.setItem('username', 'issue-426-local-fixture');
  });

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) {
      state.externalRequests.push(`${request.method()} ${request.url()}`);
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const method = request.method().toUpperCase();
    let result: ReturnType<typeof response> | undefined;
    if (method === 'GET' && url.pathname === '/api/me') {
      result = response(200, {
        username: 'issue-426-local-fixture',
        user_uuid: '11111111-1111-4111-8111-111111111111',
        role: 'admin',
        zone_uuids: null,
        plot_uuids: null,
        features: { scoped_access: false },
      });
    } else if (method === 'GET' && url.pathname === '/api/catalog') {
      result = response(200, [
        { id: 'KIWI_SENSOR', name: 'Kiwi sensor' },
        { id: 'STREGA_VALVE', name: 'STREGA valve' },
      ]);
    } else if (method === 'GET' && url.pathname === '/api/devices') {
      result = response(200, []);
    } else if (method === 'GET' && url.pathname === '/api/irrigation-zones') {
      result = response(200, [{ id: 7, name: 'North Block', device_count: 0, timezone: 'UTC' }]);
    } else if (method === 'GET' && url.pathname === '/api/system/settings') {
      result = response(200, {
        gatewayTimezone: 'UTC',
        dataModuleEnabled: false,
        networkModuleEnabled: false,
        gatewayHubModuleEnabled: false,
        journalModuleEnabled: false,
        moduleDefaults: {
          dataModuleEnabled: false,
          networkModuleEnabled: false,
          gatewayHubModuleEnabled: false,
          journalModuleEnabled: false,
        },
      });
    } else if (method === 'GET' && url.pathname === '/api/system/stats') {
      result = response(200, {
        cpu_temp_c: 40,
        mem_total_mb: 1000,
        mem_used_mb: 400,
        mem_free_mb: 600,
        mem_percent: 40,
        load_1: 0.2,
        load_5: 0.1,
        load_15: 0.1,
        cpu_count: 4,
        fan_available: false,
        fan_mode: 'none',
        fan_value: null,
        fan_max: null,
        restartPending: null,
      });
    } else if (method === 'GET' && url.pathname === '/api/irrigation/recent-actuations') {
      result = response(200, { generatedAt: '2026-10-27T00:00:00Z', actuations: [] });
    } else if (method === 'GET' && url.pathname === '/api/irrigation-zones/7/environment-summary') {
      result = response(200, {
        zoneId: 7,
        zoneName: 'North Block',
        generatedAt: '2026-10-27T00:00:00Z',
        location: { latitude: null, longitude: null, timezone: 'UTC', source: 'unavailable' },
        water: {
          available: false,
          observedAt: null,
          areaM2: null,
          irrigationEfficiencyPct: null,
          rainTodayMm: null,
          irrigationTodayLiters: null,
          irrigationTodayNetMm: null,
          waterNeededTodayMm: null,
          balanceTodayMm: null,
          next24hRainMm: null,
          action: null,
          daily: [],
          sensorHealth: {
            sensorCount: 0,
            freshSensorCount: 0,
            staleSensorCount: 0,
            rainGaugePresent: false,
            flowMeterPresent: false,
            warnings: [],
          },
        },
        local: { available: false, observedAt: null, sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, metrics: [], devices: [] },
        online: { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null },
        agronomic: { preferredSource: 'unavailable', current: null },
        forecast: { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null },
      });
    } else if (method === 'GET' && url.pathname === '/api/system/features') {
      result = response(200, {});
    } else if (method === 'POST' && url.pathname === '/api/devices') {
      state.addRequests.push(request.postDataJSON() as AddRequest);
      result = response(201, { deveui: DEV_EUI });
    }

    if (!result) {
      state.unknownApi.push(`${method} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
}

async function pasteThroughChromium(page: Page, input: ReturnType<Page['getByLabel']>, value: string, expected: string) {
  await input.evaluate((element) => {
    const field = element as HTMLInputElement;
    field.dataset.nativePasteCount = '0';
    field.addEventListener('paste', () => {
      field.dataset.nativePasteCount = String(Number(field.dataset.nativePasteCount) + 1);
    });
  });

  await page.evaluate(async (clipboardText) => navigator.clipboard.writeText(clipboardText), value);
  await input.focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(input).toHaveValue(expected);
  await expect(input).toHaveAttribute('data-native-paste-count', '1');

  await input.fill(`FFFF${'0'.repeat(expected.length - 4)}`);
  await input.evaluate((element) => (element as HTMLInputElement).setSelectionRange(0, 4));
  await page.evaluate(async (clipboardText) => navigator.clipboard.writeText(clipboardText), '00 00');
  await input.focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(input).toHaveValue(expected);
  await expect(input).toHaveAttribute('data-native-paste-count', '2');
}

async function assertFixtureBoundary(state: FixtureState) {
  expect(state.externalRequests, `non-loopback requests: ${state.externalRequests.join(', ')}`).toEqual([]);
  expect(state.unknownApi, `unexpected API calls: ${state.unknownApi.join(', ')}`).toEqual([]);
}

test('Add Device accepts full native clipboard pastes into empty and selected credentials', async ({ page }) => {
  const state: FixtureState = { unknownApi: [], externalRequests: [], addRequests: [] };
  await installLocalBoundary(page, state);
  await page.goto('/gui/#/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Open Smart Irrigation Dashboard' })).toBeVisible();
  await expect(page.locator('#irrigation-zone-7')).toBeVisible();
  await page.locator('header').getByRole('button', { name: /Add/ }).click();
  await page.getByRole('menuitem', { name: 'Add Device', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Device Type').selectOption('STREGA_VALVE');
  await dialog.getByLabel('Device Name').fill('Native paste device');
  await pasteThroughChromium(page, dialog.getByLabel('DevEUI'), groupedDevEui, DEV_EUI);
  await pasteThroughChromium(page, dialog.getByLabel('AppKey'), groupedAppKey, APP_KEY);

  await dialog.getByRole('button', { name: 'Add Device', exact: true }).click();
  await expect.poll(() => state.addRequests.length).toBe(1);
  expect(state.addRequests[0]).toMatchObject({
    deveui: DEV_EUI,
    appkey: APP_KEY,
    name: 'Native paste device',
    type_id: 'STREGA_VALVE',
  });
  expect(state.addRequests[0]).not.toHaveProperty('zone_id');
  await assertFixtureBoundary(state);
});

test('Zone Device registration accepts full native clipboard pastes into empty and selected credentials', async ({ page }) => {
  const state: FixtureState = { unknownApi: [], externalRequests: [], addRequests: [] };
  await installLocalBoundary(page, state);
  await page.goto('/gui/#/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Open Smart Irrigation Dashboard' })).toBeVisible();
  const zone = page.locator('#irrigation-zone-7');
  await expect(zone).toBeVisible({ timeout: 20_000 });
  await zone.getByRole('button', { name: /Device/ }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'New device' }).click();
  await dialog.getByLabel('Device Type').selectOption('STREGA_VALVE');
  await dialog.getByLabel('Device Name').fill('Native paste zone device');
  await pasteThroughChromium(page, dialog.getByLabel('DevEUI'), groupedDevEui, DEV_EUI);
  await pasteThroughChromium(page, dialog.getByLabel('AppKey'), groupedAppKey, APP_KEY);

  await dialog.getByRole('button', { name: 'Register into zone' }).click();
  await expect.poll(() => state.addRequests.length).toBe(1);
  expect(state.addRequests[0]).toMatchObject({
    deveui: DEV_EUI,
    appkey: APP_KEY,
    name: 'Native paste zone device',
    type_id: 'STREGA_VALVE',
    zone_id: 7,
  });
  await assertFixtureBoundary(state);
});
