import {expect, type FrameLocator} from '@playwright/test';
import {join} from 'node:path';
import {expectedCopy, locales} from '../phone-spec';
import {clickHeaderControl, openSettingsFromHeader} from './header';
import {
  PHONE_FRAME, raisePhone, scanPhone, selectEnvironmentTab, showZoneDevices, startTimedDrip, test, translate,
} from './phone-fixture';

const languageNames = ['English', 'Deutsch', 'Français', 'Italiano', 'Español', 'Português', 'Luganda'];
const screens = process.env.FARM_SIM_SCREENSHOTS;

async function changeLanguage(phone: FrameLocator, from: number, to: number) {
  const header = phone.locator('header');
  await header.getByRole('button', {name: languageNames[from], exact: true}).click();
  await header.getByRole('menuitem', {name: languageNames[to], exact: true}).click();
  await expect(phone.locator('html')).toHaveAttribute('lang', locales[to]);
}

test('raises the production phone, keeps storage isolated, and sends a timed drip open', async ({page}) => {
  await page.addInitScript(() => {
    if (parent !== window) return;
    localStorage.setItem('osi.defaults.timezone', 'UTC');
    sessionStorage.setItem('parent-only', 'sentinel');
  });
  const phone = await raisePhone(page, 'tier=3');
  const parentNow = await page.evaluate(() => window.__farmSim!.now());
  const state = await phone.locator('html').evaluate(() => {
    localStorage.setItem('osi.defaults.timezone', 'UTC');
    sessionStorage.setItem('phone-only', 'yes');
    return {now: Date.now(), zone: localStorage.getItem('osi.defaults.timezone'), parentOnly: sessionStorage.getItem('parent-only')};
  });
  expect(state).toEqual({now: parentNow, zone: 'Etc/GMT-3', parentOnly: null});
  expect(await page.evaluate(() => [Object.entries(localStorage), Object.entries(sessionStorage)])).toEqual([
    [['osi.defaults.timezone', 'UTC']], [['parent-only', 'sentinel']],
  ]);

  await startTimedDrip(phone, '10');
  await expect.poll(() => page.evaluate(() => window.__farmSim!.log.find(event => 'kind' in event
    && event.kind === 'phoneRequest' && event.path === '/api/valve/00000000000000B3'))).toEqual(expect.objectContaining({
    method: 'POST', simNow: parentNow, seq: expect.any(Number),
    body: {action: 'OPEN_FOR_DURATION', duration_seconds: 600},
  }));
  await page.getByRole('button', {name: 'Advance 3 seconds'}).click();
  await expect(page.getByText('Drip line running')).toBeVisible();
  await expect(phone.getByText(translate('en', 'devices:stregaValve.open'), {exact: true}).first()).toBeVisible();
  await scanPhone(phone);
  if (screens) await page.screenshot({path: join(screens, 'timed-drip.png')});
});

for (const [index, locale] of locales.entries()) {
  test(`renders game labels and attribution in ${locale}`, async ({page}) => {
    const phone = await raisePhone(page, 'tier=2&lang=' + locale);
    const copy = expectedCopy(locale);
    await expect(phone.getByTestId('water-action-tile')).toContainText(copy['devices:zone.water.drivenByBalance']);
    await expect(phone.getByTestId('water-flow-meter-tile')).toContainText(copy['devices:zone.water.measured']);
    await scanPhone(phone);

    await selectEnvironmentTab(phone, locale, 'water');
    await expect(phone.getByText(copy['devices:environment.water.balance'], {exact: true})).toBeVisible();
    await expect(phone.getByText(copy['devices:environment.water.measuredIrrigationToday'], {exact: true})).toHaveCount(2);
    await expect(phone.getByText(copy['devices:environment.water.tooltipMeasuredEffective'], {exact: true}).first()).toBeVisible();
    await expect(phone.getByText(copy['devices:environment.water.flowMeterReporting'], {exact: true})).toBeVisible();
    await scanPhone(phone);

    await selectEnvironmentTab(phone, locale, 'agronomic');
    for (const key of [
      'environment.source.illustrative', 'environment.agronomic.dewPoint',
      'environment.agronomic.heatIndex', 'environment.agronomic.thi', 'environment.cache.live',
    ]) {
      await expect(phone.getByText(copy['devices:' + key], {exact: true}).first()).toBeVisible();
    }
    await scanPhone(phone);

    await selectEnvironmentTab(phone, locale, 'weather');
    const current = phone.getByText(copy['devices:environment.description.weatherConditions'], {exact: true});
    const credit = phone.getByText(copy['devices:environment.water.attribution.open_meteo'], {exact: true});
    for (const label of [current, credit]) {
      await expect(label).toBeVisible();
      expect(await label.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await scanPhone(phone);
    if (screens && (locale === 'de-CH' || locale === 'es')) {
      await credit.locator('..').screenshot({path: join(screens, `weather-${locale}.png`)});
    }

    for (const tab of ['soil', 'sensors'] as const) {
      await selectEnvironmentTab(phone, locale, tab);
      await scanPhone(phone);
    }

    await showZoneDevices(phone, locale);
    const flow = phone.locator('p[data-farm-sim-literal="flowMeterHeading"]');
    await expect(flow).toHaveText(copy['common:farmSim.flowMeterHeading']);
    await expect(flow).toBeVisible();
    await scanPhone(phone);

    await phone.getByRole('button', {name: translate(locale, 'devices:zone.configure'), exact: true}).click();
    await expect(phone.locator('input[id^="zone-config-timezone-"]'))
      .toHaveAttribute('placeholder', copy['devices:advancedSchedule.timezoneExample']);
    await scanPhone(phone);
    await phone.getByRole('button', {name: translate(locale, 'common:close'), exact: true}).click();

    // In some locales the header helper's Menu regex does not recognize the translated trigger.
    const menu = phone.locator('header').getByRole('button', {name: translate(locale, 'dashboard:header.menu'), exact: true});
    if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
    await openSettingsFromHeader(phone, translate(locale, 'settings:entryPoint'));
    const timezone = phone.locator('#gateway-timezone');
    await expect(timezone).toHaveAttribute('placeholder', copy['devices:advancedSchedule.timezoneExample']);
    await expect(timezone).toHaveValue('Etc/GMT-3');
    await timezone.fill('invalid');
    await expect(phone.getByText(copy['settings:timeZoneInvalid'], {exact: true})).toBeVisible();
    await scanPhone(phone);
    await timezone.fill('Etc/GMT-3');
    await expect(phone.getByText(copy['settings:swtSample'], {exact: true})).toBeVisible();
    if (index === 0 && screens) await page.screenshot({path: join(screens, 'settings.png')});

    await phone.getByRole('link', {name: translate(locale, 'settings:backToDashboard'), exact: true}).click();
    await expect(phone.getByRole('heading', {name: 'Tomato bed', exact: true})).toBeVisible();
    if (await menu.getAttribute('aria-expanded') === 'false') await menu.click();
    await clickHeaderControl(phone, phone.locator('header').getByRole('button', {
      name: translate(locale, 'dashboard:account'), exact: true,
    }));
    await phone.getByRole('menuitem', {name: translate(locale, 'dashboard:accountMenu.osiServer'), exact: true}).click();
    await expect(phone.getByRole('heading', {name: translate(locale, 'accountLink:title'), exact: true}).first()).toBeVisible();
    await scanPhone(phone);
  });
}

test('switches the T2 Flow Meter heading twice in the same frame', async ({page}) => {
  const phone = await raisePhone(page, 'tier=2');
  await selectEnvironmentTab(phone, 'en', 'weather');
  await showZoneDevices(phone, 'en');
  const flow = phone.locator('p[data-farm-sim-literal="flowMeterHeading"]');
  await phone.locator('html').evaluate(el => { el.dataset.sameFrame = 'yes'; });
  const order = [0, 1, 4];
  for (const [position, index] of order.entries()) {
    if (position) await changeLanguage(phone, order[position - 1], index);
    const copy = expectedCopy(locales[index]);
    await expect(flow).toHaveText(copy['common:farmSim.flowMeterHeading']);
    await expect(phone.getByText(copy['devices:environment.description.weatherConditions'], {exact: true})).toBeVisible();
    await expect(phone.locator('p').filter({hasText: /^Flow Meter$/})).toHaveCount(0);
    await expect(phone.locator('html')).toHaveAttribute('data-same-frame', 'yes');
    await scanPhone(phone);
  }
});

test('labels the simulated valve meter in all seven locales', async ({page}) => {
  const phone = await raisePhone(page, 'tier=3');
  await showZoneDevices(phone, 'en');
  for (const [index, locale] of locales.entries()) {
    if (index) await changeLanguage(phone, index - 1, index);
    await expect(phone.getByText(expectedCopy(locale)['devices:stregaValve.measured'], {exact: true})).toBeVisible();
    await scanPhone(phone);
  }
});

test('hides Dendrometer while keeping the adjacent zone delete Cancel visible', async ({page}) => {
  const phone = await raisePhone(page, 'tier=4');
  await openSettingsFromHeader(phone, translate('en', 'settings:entryPoint'));
  await phone.getByRole('group', {name: translate('en', 'settings:waterCard'), exact: true})
    .getByRole('button', {name: translate('en', 'settings:off'), exact: true}).click();
  await phone.getByRole('link', {name: translate('en', 'settings:backToDashboard'), exact: true}).click();

  await expect(phone.getByTestId('water-today-card')).toHaveCount(0);
  await phone.getByRole('button', {name: translate('en', 'devices:schedule.irrigationSchedule')}).click();
  await expect(phone.locator('select[id^="swt-sensor-"]')).toBeVisible();
  const methods = phone.locator('div:has(+ div > div > select[id^="swt-sensor-"]) > p + div > button:visible');
  await expect(methods).toHaveText([translate('en', 'devices:schedule.methodSwt')]);
  await expect(phone.getByText(translate('en', 'devices:advancedSchedule.tabAnalysis'), {exact: true})).toHaveCount(0);

  await phone.getByRole('button', {name: translate('en', 'devices:zone.deleteZone'), exact: true}).click();
  await expect(phone.getByRole('button', {name: translate('en', 'devices:zone.yesDelete'), exact: true})).toBeVisible();
  await expect(phone.getByRole('button', {name: translate('en', 'common:cancel'), exact: true})).toBeVisible();
  await scanPhone(phone);
  if (screens) await page.screenshot({path: join(screens, 'soil-trigger.png')});
});

test('refuses an LSN50 toggle and leaves its setting and simulator digest unchanged', async ({page}) => {
  const phone = await raisePhone(page, 'tier=2');
  await showZoneDevices(phone, 'en');
  const meter = phone.getByRole('heading', {name: 'Rain and flow meter', exact: true});
  const card = meter.locator('xpath=ancestor::div[.//button[@title="Device settings"]][1]');
  await card.getByRole('button', {name: 'Device settings', exact: true}).click();
  const dialog = phone.getByRole('dialog', {name: 'Device settings'});
  await expect(dialog.getByText('Dendrometer calibration', {exact: true})).toBeVisible();
  const toggle = dialog.getByRole('checkbox', {name: 'Flow Meter', exact: true});
  const checked = await toggle.isChecked();
  const before = await page.evaluate(() => ({snapshot: window.__farmSim!.snapshot(), index: window.__farmSim!.log.length}));
  await toggle.click();
  await expect(phone.locator('#phone-notice')).toHaveText(expectedCopy('en')['common:farmSim.game_refused']);
  await expect(toggle).toBeChecked({checked});
  const after = await page.evaluate(index => ({
    snapshot: window.__farmSim!.snapshot(), log: window.__farmSim!.log.slice(index),
  }), before.index);
  expect(after.snapshot).toBe(before.snapshot);
  expect(after.log).toContainEqual(expect.objectContaining({
    type: 'phone_refused', method: 'PUT', path: '/api/devices/00000000000000B2/flow-meter', code: 'game_refused',
  }));
  expect(after.log.find(event => 'type' in event && event.type === 'phone_refused')).not.toHaveProperty('body');
  await scanPhone(phone);
  if (screens) await page.screenshot({path: join(screens, 'refused-meter-toggle.png')});
});

test('intercepts logout and dismisses both menus without changing the phone session', async ({page}) => {
  const phone = await raisePhone(page, 'tier=1');
  const header = phone.locator('header');
  const menu = header.getByRole('button', {name: 'Menu', exact: true});
  const account = header.locator('button[aria-haspopup="menu"]').filter({hasText: /^Account$/});
  const session = () => phone.locator('html').evaluate(() => [localStorage.getItem('auth_token'), location.hash]);
  const before = await session();
  expect(before[0]).toBeTruthy();
  await clickHeaderControl(phone, account);
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await header.getByRole('menuitem', {name: 'Log out'}).click();
  await expect(phone.locator('#phone-notice')).toHaveText(expectedCopy('en')['common:farmSim.game_refused']);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  expect(await session()).toEqual(before);
  expect(await page.evaluate(() => window.__farmSim!.log.some(event => 'path' in event && event.path.startsWith('/auth/')))).toBe(false);
});

test('routes key-specific revalidation through the app SWR cache immediately after a device poll', async ({page}) => {
  await raisePhone(page, 'tier=2');
  const deviceReads = () => page.evaluate(() => window.__farmSim!.log.filter(event =>
    'type' in event && event.type === 'api_read' && event.path === '/api/devices').length);
  await expect.poll(deviceReads).toBeGreaterThan(0);
  const initial = await deviceReads();
  // Observe a real SWR interval tick before asking for just this key.
  await expect.poll(deviceReads, {timeout: 14_000, intervals: [100]}).toBeGreaterThan(initial);
  const polled = await deviceReads();
  await page.evaluate(() => window.__farmSim!.revalidate(['/api/devices']));
  await expect.poll(deviceReads, {timeout: 1000}).toBeGreaterThan(polled);
});

test('freezes the mounted phone for six minutes of polls and refreshes it on raise', async ({page}) => {
  await page.clock.install();
  const phone = await raisePhone(page, 'tier=3');
  await selectEnvironmentTab(phone, 'en', 'water');
  await startTimedDrip(phone, '5');
  await page.evaluate(() => window.__farmSim!.advance(3000));
  await expect(page.getByText('Drip line running')).toBeVisible();
  const frame = page.locator(PHONE_FRAME);
  const clock = () => phone.locator('html').evaluate(() => Date.now());
  const beforeClose = await clock();
  await page.getByRole('button', {name: 'Lower phone'}).click();
  await expect(frame).toBeHidden();
  const before = await page.evaluate(() => ({stats: window.__farmSim!.stats(), index: window.__farmSim!.log.length}));
  await page.evaluate(() => window.__farmSim!.advance(3 * 3_600_000));
  await page.clock.fastForward(6 * 60_000 + 1000);
  const stats = () => page.evaluate(() => window.__farmSim!.stats());
  await expect.poll(async () => (await stats()).closedCacheHits).toBeGreaterThan(before.stats.closedCacheHits);
  expect((await stats()).simulatorCalls).toBe(before.stats.simulatorCalls);
  expect(await clock()).toBe(beforeClose);
  expect(await page.evaluate(index => window.__farmSim!.log.slice(index).filter(event => 'type' in event && event.type === 'api_read'), before.index)).toEqual([]);
  await page.getByRole('button', {name: 'Raise phone'}).click();
  await expect(frame).toBeVisible();
  await expect.poll(async () => (await stats()).simulatorCalls, {timeout: 2000}).toBeGreaterThan(before.stats.simulatorCalls);
  expect(await clock()).toBe(await page.evaluate(() => window.__farmSim!.now()));
  await expect(page.getByText('Drip line idle')).toBeVisible();
  await expect(phone.getByText(translate('en', 'devices:stregaValve.closed'), {exact: true}).first()).toBeVisible();
});

test('reports unavailable device GPS and the fictional zone coordinates from T1', async ({page}) => {
  const phone = await raisePhone(page, 'tier=1');
  await phone.getByRole('button', {name: translate('en', 'devices:zone.configure'), exact: true}).click();
  await expect(phone.getByRole('button', {name: 'Use device location', exact: true})).toBeDisabled();
  await expect(phone.getByText(translate('en', 'devices:zoneConfig.gps.unavailable'), {exact: true})).toBeVisible();
  await expect(phone.getByLabel('Latitude', {exact: true})).toHaveValue('-2');
  await expect(phone.getByLabel('Longitude', {exact: true})).toHaveValue('0');
  await scanPhone(phone);
});

test('loads the smoke host and production phone under a nested URL', async ({page}) => {
  const phone = await raisePhone(page, 'tier=2', '/some/where/phone-host.html');
  await expect(page.locator(PHONE_FRAME)).toHaveAttribute('src', /\/some\/where\/phone\/phone\.html\?lang=en#\/dashboard$/);
  await selectEnvironmentTab(phone, 'en', 'weather');
  await expect(phone.getByText(expectedCopy('en')['devices:environment.description.weatherConditions'], {exact: true})).toBeVisible();
  await scanPhone(phone);
});

test('refuses to boot the phone without a parent bridge', async ({page}) => {
  await page.goto('/phone/phone.html#/dashboard');
  await expect(page.getByText('Open the phone from OSI Farm Sim.')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
});
