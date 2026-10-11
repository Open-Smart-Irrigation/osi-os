import {expect, test, type Locator, type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {PUBLIC_EPOCH} from '../../fixtures';

test.setTimeout(120_000);

type ReleaseMonitor = {
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  externalRequests: string[];
  notices: string[];
  expectedNoticeIndexes: Set<number>;
  expectedOrigins: Set<string>;
};

async function installMonitor(page: Page): Promise<ReleaseMonitor> {
  const monitor: ReleaseMonitor = {
    pageErrors: [], failedRequests: [], badResponses: [], externalRequests: [],
    notices: [], expectedNoticeIndexes: new Set(),
    expectedOrigins: new Set(['http://127.0.0.1:4174', 'http://demo.osi.test:4174']),
  };
  page.on('pageerror', error => monitor.pageErrors.push(error.message));
  page.on('requestfailed', request => monitor.failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`));
  page.on('request', request => {
    const url = new URL(request.url());
    if (!monitor.expectedOrigins.has(url.origin)) monitor.externalRequests.push(request.url());
  });
  page.on('response', response => {
    if (response.status() < 200 || response.status() >= 300) monitor.badResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.exposeBinding('__releaseNoticeObserved', (_source, message: string) => {
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
      void (window as Window & {__releaseNoticeObserved?: (message: string) => void})
        .__releaseNoticeObserved?.(notice.message);
    });
  });
  return monitor;
}

function markExpectedNotice(monitor: ReleaseMonitor, matcher: RegExp): void {
  let index = -1;
  for (let candidate = monitor.notices.length - 1; candidate >= 0; candidate -= 1) {
    if (matcher.test(monitor.notices[candidate])) {
      index = candidate;
      break;
    }
  }
  expect(index, `expected a retained notice matching ${matcher}; notices: ${monitor.notices.join(' | ')}`).toBeGreaterThanOrEqual(0);
  monitor.expectedNoticeIndexes.add(index);
}

function expectOrdinaryFlowClean(monitor: ReleaseMonitor): void {
  expect(monitor.pageErrors).toEqual([]);
  expect(monitor.failedRequests).toEqual([]);
  expect(monitor.badResponses).toEqual([]);
  expect(monitor.externalRequests).toEqual([]);
  const unexpected = monitor.notices.filter((_message, index) => !monitor.expectedNoticeIndexes.has(index));
  expect(unexpected, `unexpected simulator notices: ${unexpected.join(' | ')}`).toEqual([]);
}

async function openPublicApp(page: Page): Promise<ReturnType<Page['frameLocator']>> {
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
  await expect(page.frameLocator('#app').getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();
  return page.frameLocator('#app');
}

async function advanceNextEvent(page: Page): Promise<void> {
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  const controls = page.getByRole('dialog', {name: 'Simulation controls'});
  const pause = controls.getByRole('button', {name: /^(Pause time|Resume time)$/});
  if (await pause.getAttribute('aria-pressed') !== 'true') await pause.click();
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  const clock = page.locator('#simulated-time');
  const before = Date.parse((await clock.getAttribute('datetime')) ?? '');
  expect(Number.isFinite(before), 'the host exposes a simulated time before the event').toBe(true);
  await controls.getByRole('button', {name: 'Advance to next event'}).click();
  await expect.poll(async () => Date.parse((await clock.getAttribute('datetime')) ?? ''), {
    timeout: 5_000,
    message: 'the host clock reports completion of the requested next-event advance',
  }).toBeGreaterThan(before);
  await controls.getByRole('button', {name: 'Close'}).click();
}

async function pausePublicClock(page: Page): Promise<void> {
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  const controls = page.getByRole('dialog', {name: 'Simulation controls'});
  const pause = controls.getByRole('button', {name: /^(Pause time|Resume time)$/});
  if (await pause.getAttribute('aria-pressed') !== 'true') await pause.click();
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  await controls.getByRole('button', {name: 'Close'}).click();
}

async function advanceToNextDailyTrigger(page: Page, timeZone = 'Africa/Kampala'): Promise<void> {
  const clock = page.locator('#simulated-time');
  const initial = Date.parse((await clock.getAttribute('datetime')) ?? '');
  expect(Number.isFinite(initial), 'public simulation clock exposes its current instant').toBe(true);
  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  for (let event = 0; event < 160; event += 1) {
    await advanceNextEvent(page);
    const current = Date.parse((await clock.getAttribute('datetime')) ?? '');
    if (current > initial && localTime.format(new Date(current)) === '06:00') return;
  }
  throw new Error(`No daily trigger event reached 06:00 ${timeZone} within 160 simulation events`);
}

function valveTile(app: ReturnType<Page['frameLocator']>, name: string): Locator {
  const panel = app.locator('section').filter({has: app.getByRole('heading', {name: 'Valve control', exact: true})});
  // The real ValveTile root contains the tested action group; querying its parent keeps
  // the subsequent heading and control lookups scoped to that one native tile.
  return panel.getByTestId('valve-actions').locator('..').filter({hasText: name});
}

function valveState(tile: Locator): Locator {
  // ValveTile renders last-seen first and the native open/closed/pending state second.
  return tile.locator('p').nth(1);
}

async function advanceUntilOnceSent(page: Page, app: ReturnType<Page['frameLocator']>, valve: import('@playwright/test').Locator, label: string): Promise<void> {
  for (let event = 0; event < 40; event += 1) {
    await valve.getByRole('button', {name: 'Schedule', exact: true}).click();
    const dialog = app.getByRole('dialog');
    const row = dialog.getByRole('listitem').filter({hasText: label});
    const dispatch = await row.innerText();
    await dialog.getByRole('button', {name: 'Close'}).click();
    if (/Dispatch: Sent to the radio network/i.test(dispatch)) return;
    await advanceNextEvent(page);
  }
  throw new Error(`No event sent the one-time plan ${label} within 40 simulation events`);
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

async function expandZone(app: ReturnType<Page['frameLocator']>, zoneId: number, zoneName: string): Promise<Locator> {
  const zone = app.locator(`#irrigation-zone-${zoneId}`);
  const toggle = zone.getByRole('button', {name: new RegExp(`^${zoneName} \\d+ devices?$`)});
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return zone;
}

async function expandZoneDevices(zone: Locator): Promise<void> {
  // The visible label is followed by the chevron glyph in its accessible name.
  const toggle = zone.getByRole('button', {name: /^Devices in this zone:/i});
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function saveSentekLayout(dialog: Locator, channel: number, depthCm: number): Promise<void> {
  await dialog.getByLabel('Probe profile').selectOption('SENTEK_ENVIROSCAN');
  await expect(dialog.getByLabel('SDI-12 address')).toBeVisible();
  await dialog.getByLabel('SDI-12 address').fill('0');
  const removeButtons = dialog.getByRole('button', {name: 'Remove', exact: true});
  while (await removeButtons.count() > 1) await removeButtons.last().click();
  await dialog.getByLabel('Channel 1').fill(String(channel));
  await dialog.getByLabel('Response position 1').fill('1');
  await dialog.getByLabel('Depth 1 (cm)').fill(String(depthCm));
  await dialog.getByLabel('Module type 1').selectOption('ENVIROSCAN');
  await dialog.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog.getByText('Layout saved; acquisition configuration not applied.', {exact: true})).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Apply acquisition configuration'})).toBeEnabled();
}

async function unassignZoneDevice(app: ReturnType<Page['frameLocator']>, zone: Locator, name: string): Promise<void> {
  const deviceCard = zone.locator('div.shadow-sm').filter({has: app.getByText(name, {exact: true})});
  await deviceCard.getByRole('button', {name: 'Unassign from this zone'}).click();
  await deviceCard.getByRole('button', {name: 'Yes, unassign', exact: true}).click();
  await expect(zone).not.toContainText(name);
}

async function startConfirm(page: Page, app: ReturnType<Page['frameLocator']>, action: () => Promise<void>, accept: boolean) {
  const confirmation = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('confirm');
    const message = dialog.message();
    if (accept) await dialog.accept();
    else await dialog.dismiss();
    return message;
  });
  await action();
  const message = await confirmation;
  expect(message.trim().length).toBeGreaterThan(10);
  return app;
}

test('farm-device-roundtrip creates, renames, assigns, unassigns, removes, and reads saved farm state', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await app.getByRole('button', {name: 'Add', exact: true}).click();
  await app.getByRole('menuitem', {name: /zone/i}).click();
  const createZone = app.getByRole('dialog');
  await createZone.locator('#zone-name').fill('Release trial bed');
  await createZone.locator('form').getByRole('button', {name: /create/i}).click();
  const createdZone = app.locator('div[id^="irrigation-zone-"]').filter({has: app.getByRole('heading', {name: 'Release trial bed', exact: true})});
  const createdZoneId = await createdZone.getAttribute('id');
  expect(createdZoneId).toMatch(/^irrigation-zone-/);
  const zone = app.locator(`#${createdZoneId}`);
  await expect(zone).toContainText('Release trial bed');
  await zone.getByRole('button', {name: /rename zone/i}).click();
  const renameZone = zone.getByRole('textbox', {name: 'Zone name'});
  await renameZone.fill('Release test bed');
  await renameZone.press('Enter');
  await expect(zone).toContainText('Release test bed');

  await app.getByRole('button', {name: 'Add', exact: true}).click();
  await app.getByRole('menuitem', {name: /device/i}).click();
  const addDevice = app.getByRole('dialog');
  await addDevice.locator('#device-type').selectOption('KIWI_SENSOR');
  await addDevice.locator('#name').fill('Release probe');
  await addDevice.locator('#deveui').fill('00000000000000B0');
  await addDevice.locator('form').getByRole('button', {name: /add device/i}).click();
  await expect(app.getByText('Release probe', {exact: true})).toBeVisible();
  const addedDevice = app.locator('div.shadow-sm').filter({hasText: '00000000000000B0'});
  await addedDevice.getByRole('button', {name: 'Rename device'}).click();
  const renameDevice = addedDevice.getByRole('textbox', {name: 'Device name'});
  await renameDevice.fill('Renamed release probe');
  await renameDevice.press('Enter');
  await expect(app.getByText('Renamed release probe', {exact: true})).toBeVisible();

  await zone.getByRole('button', {name: '+ Device', exact: true}).click();
  const assign = app.getByRole('dialog');
  await assign.locator('#device').selectOption('00000000000000B0');
  await assign.getByRole('button', {name: 'Assign Device', exact: true}).click();
  const zoneToggle = zone.getByRole('button', {name: 'Release test bed 1 device', exact: true});
  if (await zoneToggle.getAttribute('aria-expanded') === 'false') await zoneToggle.click();
  await expect(zoneToggle).toHaveAttribute('aria-expanded', 'true');
  await expandZoneDevices(zone);
  await expect(zone).toContainText('Renamed release probe');
  const inZoneCard = zone.locator('div.shadow-sm').filter({hasText: '00000000000000B0'});
  await inZoneCard.getByRole('button', {name: 'Unassign from this zone'}).click();
  await inZoneCard.getByRole('button', {name: 'Yes, unassign', exact: true}).click();
  await expect(zone).not.toContainText('Renamed release probe');
  await expect(app.getByText('Renamed release probe', {exact: true})).toBeVisible();
  await addedDevice.getByRole('button', {name: 'Remove device'}).click();
  await addedDevice.getByRole('button', {name: 'Yes, remove', exact: true}).click();
  await expect(app.getByText('Renamed release probe', {exact: true})).toHaveCount(0);
  await expect(zone).toContainText('Release test bed');
  expectOrdinaryFlowClean(monitor);
});

test('valve-lifecycle reads pending, acknowledged open, timed close, early close, and water outcomes', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await pausePublicClock(page);
  const valve = valveTile(app, 'Tomato valve');
  await valve.getByRole('button', {name: 'Open', exact: true}).click();
  const openDialog = app.getByRole('dialog');
  await openDialog.getByLabel(/duration/i).fill('1');
  await openDialog.getByRole('button', {name: /open for 1 min/i}).click();
  await expect(valveState(valve)).toContainText(/pending|waiting/i);
  await advanceNextEvent(page);
  await expect(valveState(valve)).toContainText(/^Open\b/);
  await advanceNextEvent(page);
  await expect(valveState(valve)).toContainText(/^Closed\b/);

  await valve.getByRole('button', {name: 'Open', exact: true}).click();
  await app.getByRole('dialog').getByLabel(/duration/i).fill('5');
  await app.getByRole('dialog').getByRole('button', {name: /open for 5 min/i}).click();
  await advanceNextEvent(page);
  await expect(valveState(valve)).toContainText(/^Open\b/);
  await valve.getByRole('button', {name: 'More'}).click();
  await valve.getByRole('menuitem', {name: 'Settings'}).click();
  const valveSettings = app.getByRole('dialog', {name: 'Valve settings'});
  await valveSettings.getByRole('button', {name: 'Close valve now'}).click();
  await valveSettings.getByRole('button', {name: 'Yes, close it'}).click();
  await expect(valveSettings).toContainText('Close command sent');
  await advanceNextEvent(page);
  await expect(valveState(valve)).toContainText(/^Closed\b/i);
  await valveSettings.getByRole('button', {name: 'Close', exact: true}).click();
  const recent = app.locator('section').filter({has: app.getByRole('heading', {name: 'Recent irrigations', exact: true})});
  await recent.getByRole('button', {name: 'Recent irrigations settings'}).click();
  await recent.getByLabel('Advanced view').check();
  const timedRun = recent.getByRole('listitem').filter({hasText: 'Duration: 1 min'});
  const earlyCloseRun = recent.getByRole('listitem').filter({hasText: 'Duration: 5 min'});
  await expect(timedRun).toContainText('Total volume: 6 L');
  await expect(timedRun).toContainText(/completed/i);
  await expect(earlyCloseRun).toContainText('Total volume: 0 L');
  await expect(earlyCloseRun).toContainText(/cancelled/i);
  await expect(app.getByTestId('water-today-card')).toContainText('6 L');
  expectOrdinaryFlowClean(monitor);
});

test('plan-roundtrip saves WEEKLY and ONCE plans, fires, and retains a valid plan after rejected edits', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await pausePublicClock(page);
  const valve = valveTile(app, 'Tomato valve');
  await valve.getByRole('button', {name: 'Schedule', exact: true}).click();
  const dialog = app.getByRole('dialog');
  const weeklyForm = dialog.getByRole('button', {name: 'Mon', exact: true}).locator('xpath=ancestor::section[1]');
  const onceForm = dialog.getByLabel('Date', {exact: true}).locator('xpath=ancestor::section[1]');
  await weeklyForm.getByLabel('Start', {exact: true}).fill('06:15');
  await weeklyForm.getByLabel('Duration (min)', {exact: true}).fill('2');
  await weeklyForm.getByLabel('Label (optional)', {exact: true}).fill('Release weekly');
  await weeklyForm.getByRole('button', {name: 'Mon', exact: true}).click();
  await weeklyForm.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog).toContainText('Release weekly');
  await weeklyForm.getByLabel('Start', {exact: true}).fill('06:15');
  await weeklyForm.getByLabel('Duration (min)', {exact: true}).fill('2');
  await weeklyForm.getByLabel('Label (optional)', {exact: true}).fill('Release conflict candidate');
  await weeklyForm.getByRole('button', {name: 'Tue', exact: true}).click();
  await weeklyForm.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog).toContainText('Release conflict candidate');
  const dateValue = await page.locator('#simulated-time').evaluate((element) => {
    const next = new Date(Date.parse(element.getAttribute('datetime') ?? '') + 5 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(next);
    const values = new Map(parts.map(({type, value}) => [type, value]));
    return {date: `${values.get('year')}-${values.get('month')}-${values.get('day')}`,
      time: `${values.get('hour')}:${values.get('minute')}`};
  });
  await onceForm.getByLabel('Date', {exact: true}).fill(dateValue.date);
  await onceForm.getByLabel('Time', {exact: true}).fill(dateValue.time);
  await onceForm.getByLabel('Duration (min)', {exact: true}).fill('1');
  await onceForm.getByLabel('Label (optional)', {exact: true}).fill('Release once');
  await onceForm.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(dialog).toContainText('Release once');
  await dialog.getByRole('button', {name: 'Close'}).click();
  await valve.getByRole('button', {name: 'Schedule', exact: true}).click();
  const reopened = app.getByRole('dialog');
  await expect(reopened).toContainText('Release weekly');
  await expect(reopened).toContainText('Release conflict candidate');
  await expect(reopened).toContainText('Release once');
  const onceRow = reopened.getByRole('listitem').filter({hasText: 'Release once'});
  const onceDateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Kampala', year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(`${dateValue.date}T12:00:00Z`));
  await expect(onceRow).toContainText(onceDateLabel);
  await expect(onceRow).toContainText('1 min');
  await expect(onceRow.getByLabel('Enabled')).toBeChecked();
  await expect(onceRow).not.toContainText(/Dispatch:/i);
  const conflictingWeekly = reopened.getByRole('listitem').filter({hasText: 'Release conflict candidate'});
  await conflictingWeekly.getByRole('button', {name: 'Edit', exact: true}).click();
  const weeklyEditor = reopened.locator('section').filter({hasText: 'Edit weekly schedule'});
  await weeklyEditor.getByRole('button', {name: 'Tue', exact: true}).click();
  await weeklyEditor.getByRole('button', {name: 'Mon', exact: true}).click();
  const before = monitor.notices.length;
  await weeklyEditor.getByRole('button', {name: 'Update schedule'}).click();
  await expect(weeklyEditor.getByText(/overlaps another window/i)).toBeVisible();
  await expect.poll(() => monitor.notices.length).toBeGreaterThan(before);
  expect(monitor.notices.slice(before)).toEqual(['Check the entered values.']);
  markExpectedNotice(monitor, /^Check the entered values\.$/);
  await expect(reopened).toContainText('Release weekly');
  await expect(reopened).toContainText('Release conflict candidate');
  await weeklyEditor.getByRole('button', {name: 'Discard', exact: true}).click();
  await reopened.getByRole('button', {name: 'Close'}).click();
  await valve.getByRole('button', {name: 'Schedule', exact: true}).click();
  const afterRejectedEdit = app.getByRole('dialog');
  await expect(afterRejectedEdit).toContainText('Release weekly');
  await expect(afterRejectedEdit).toContainText('Release conflict candidate');
  await expect(afterRejectedEdit.getByRole('listitem').filter({hasText: 'Release conflict candidate'})).toContainText('Tue');
  await afterRejectedEdit.getByRole('button', {name: 'Close'}).click();
  await advanceUntilOnceSent(page, app, valve, 'Release once');
  await advanceNextEvent(page);
  await advanceNextEvent(page);
  await expect(app.getByText('Recent irrigations', {exact: true})).toBeVisible();
  const recent = app.locator('section').filter({has: app.getByRole('heading', {name: 'Recent irrigations', exact: true})});
  await expect(recent.getByRole('listitem').filter({hasText: /Scheduled \(on valve\)/i}).first()).toBeVisible();
  await valve.getByRole('button', {name: 'Schedule', exact: true}).click();
  await expect(app.getByRole('dialog').getByRole('listitem').filter({hasText: 'Release once'})).toContainText(/Dispatch: Sent to the radio network/i);
  await app.getByRole('dialog').getByRole('button', {name: 'Close'}).click();
  expectOrdinaryFlowClean(monitor);
});

test('trigger-roundtrip records dry opening, wet non-opening, and disabled-rule behavior', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await pausePublicClock(page);
  const dryZone = await expandZone(app, 1, 'Tomato plot');
  await dryZone.getByRole('button', {name: 'Trigger-based irrigation'}).click();
  await expect(dryZone.getByRole('button', {name: 'On', exact: true})).toBeVisible();
  await dryZone.getByLabel('Threshold (kPa)').fill('30');
  await dryZone.getByLabel('Duration (min)').fill('1');
  await dryZone.getByRole('button', {name: 'Save schedule'}).click();
  await expect(dryZone.getByText('Saved.', {exact: true})).toBeVisible();
  await expect(dryZone).not.toContainText('Scheduler off');
  const tomatoValve = valveTile(app, 'Tomato valve');
  await advanceToNextDailyTrigger(page);
  await advanceNextEvent(page);
  await expect(valveState(tomatoValve)).toContainText(/^Open\b/);
  await advanceNextEvent(page);
  await expect(valveState(tomatoValve)).toContainText(/^Closed\b/);
  const recent = app.locator('section').filter({has: app.getByRole('heading', {name: 'Recent irrigations', exact: true})});
  await expect(recent.getByRole('listitem').last()).toContainText('Tomato plot');
  await expect(recent.getByRole('listitem').last()).toContainText('Trigger-based');

  const dryOutcomesBeforeWetEvaluation = await recent.getByRole('listitem').filter({hasText: 'Tomato plot'}).count();
  await expandZone(app, 2, 'Demonstration bed');
  const wetZone = app.locator('#irrigation-zone-2');
  const wetTriggerToggle = wetZone.getByRole('button', {name: 'Trigger-based irrigation'});
  if (await wetTriggerToggle.getAttribute('aria-expanded') === 'false') await wetTriggerToggle.click();
  await expect(wetZone.getByRole('button', {name: 'On', exact: true})).toBeVisible();
  await wetZone.getByLabel('Threshold (kPa)').fill('30');
  const wetMetric = await wetZone.getByLabel('Sensor').inputValue();
  await wetZone.getByRole('button', {name: 'Save schedule'}).click();
  await expect(wetZone.getByText('Saved.', {exact: true})).toBeVisible();
  await expect(wetZone).not.toContainText('Scheduler off');
  await expandZoneDevices(wetZone);
  for (const soilDevice of ['Bed dendrometer', 'Unlisted Chameleon array', 'Bed wireless soil probe', 'SDI-12 soil profile']) {
    await unassignZoneDevice(app, wetZone, soilDevice);
  }
  await setAppRoute(app, '/settings');
  await setAppRoute(app, '/dashboard');
  const reopenedBed = await expandZone(app, 2, 'Demonstration bed');
  const reopenedBedScheduleToggle = reopenedBed.getByRole('button', {name: 'Trigger-based irrigation'});
  if (await reopenedBedScheduleToggle.getAttribute('aria-expanded') === 'false') await reopenedBedScheduleToggle.click();
  await expect(reopenedBed.getByLabel('Sensor')).toHaveValue(wetMetric);
  await expect(reopenedBed.getByLabel('Threshold (kPa)')).toHaveValue('30');
  await expect(reopenedBed.getByRole('button', {name: 'On', exact: true})).toBeVisible();
  const bedValve = valveTile(app, 'Bed valve');
  await expect(valveState(bedValve)).toContainText(/^Closed\b/);
  const bedOutcomesBeforeWetEvaluation = await recent.getByRole('listitem').filter({hasText: 'Demonstration bed'}).count();
  if (await dryZone.getByRole('button', {name: 'Trigger-based irrigation'}).getAttribute('aria-expanded') === 'false') {
    await dryZone.getByRole('button', {name: 'Trigger-based irrigation'}).click();
  }
  await dryZone.getByRole('button', {name: 'On', exact: true}).click();
  await dryZone.getByRole('button', {name: 'Save schedule'}).click();
  await expect(dryZone).toContainText('Scheduler off');
  await expect(dryZone.getByRole('button', {name: 'Off', exact: true})).toBeVisible();
  await advanceToNextDailyTrigger(page);
  await expect(valveState(bedValve)).toContainText(/^Closed\b/);
  await expect(recent.getByRole('listitem').filter({hasText: 'Demonstration bed'})).toHaveCount(bedOutcomesBeforeWetEvaluation);
  await expect(recent.getByRole('listitem').filter({hasText: 'Tomato plot'})).toHaveCount(dryOutcomesBeforeWetEvaluation);
  expectOrdinaryFlowClean(monitor);
});

test('preferences-auth reopens preferences and preserves farm edits through logout and login', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  const zone = app.locator('#irrigation-zone-1');
  await zone.getByRole('button', {name: /rename zone/i}).click();
  await zone.getByRole('textbox').fill('Persisted public farm');
  await zone.getByRole('textbox').press('Enter');
  await setAppRoute(app, '/settings');
  await app.getByRole('button', {name: 'Dark', exact: true}).click();
  await app.getByRole('button', {name: 'pF', exact: true}).click();
  const refresh = app.getByRole('region', {name: 'Data & Refresh'});
  await refresh.getByRole('button', {name: 'Off', exact: true}).click();
  await expect(refresh.getByRole('button', {name: 'Off', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await refresh.getByRole('button', {name: 'On', exact: true}).click();
  await setAppRoute(app, '/dashboard');
  await setAppRoute(app, '/settings');
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(app.getByRole('button', {name: 'pF', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await setAppRoute(app, '/dashboard');
  await app.getByRole('button', {name: 'Account'}).click();
  await app.getByRole('menuitem', {name: 'Logout', exact: true}).click();
  await expect(app.getByRole('heading', {name: 'OSI OS v0.8.0 (Alpha)'})).toBeVisible();
  const loginForm = app.locator('form');
  await expect(loginForm.getByLabel(/username/i)).toHaveValue('Demo farmer');
  await expect(loginForm.getByLabel(/password/i)).toHaveValue('demo');
  await loginForm.getByRole('button', {name: 'Sign In', exact: true}).click();
  await expect(app.getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();
  await expect(app.locator('#irrigation-zone-1')).toContainText('Persisted public farm');
  expectOrdinaryFlowClean(monitor);
});

test('standard-history opens the native Tomato soil record from the History overview', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await setAppRoute(app, '/history');
  await expect(app.getByRole('heading', {name: /^History$/i})).toBeVisible();
  await openSoilMoistureHistoryFromOverview(app);
  await expect(app.getByTestId('history-visualization-surface')).toBeVisible();
  await expect(app.getByRole('heading', {name: /Tomato plot/i})).toBeVisible();
  expectOrdinaryFlowClean(monitor);
});

test('native rain card shows a dated measured dry zero from the seeded rain source', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  const zone = await expandZone(app, 1, 'Tomato plot');
  await expandZoneDevices(zone);
  const rainCard = app.getByRole('heading', {name: 'LoRain gauge', exact: true}).locator('xpath=../../..');
  const rainTodayTile = rainCard.getByText('Rain recorded today', {exact: true}).locator('..');

  await expect(rainTodayTile).toContainText('0.0 mm');
  await expect(rainTodayTile).toContainText('so far');
  expectOrdinaryFlowClean(monitor);
});

test('first compatible Sentek layout can be restored after a different saved layout', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  const zone = await expandZone(app, 2, 'Demonstration bed');
  await expandZoneDevices(zone);
  const deviceCard = app.getByRole('heading', {name: 'SDI-12 soil profile', exact: true}).locator('xpath=../../..');
  await deviceCard.getByRole('button', {name: 'Device settings'}).click();
  const dialog = app.getByRole('dialog', {name: 'SDI-12 probe settings'});

  await saveSentekLayout(dialog, 1, 20);
  await dialog.getByRole('button', {name: 'Apply acquisition configuration'}).click();
  await dialog.getByRole('button', {name: 'Confirm apply'}).click();
  await expect(dialog).toContainText('Request accepted (version 1; queueing).');
  await advanceNextEvent(page);
  await expect(deviceCard).toContainText('Acquisition configuration active');

  await saveSentekLayout(dialog, 2, 40);
  await expect(deviceCard).toContainText('Depth 40 cm');
  await dialog.getByRole('button', {name: 'Rollback acquisition configuration'}).click();

  await expect(dialog).toContainText('Rollback request accepted (version 2; queued).');
  await expect(deviceCard).toContainText('Depth 20 cm');
  await expect(deviceCard).not.toContainText('Depth 40 cm');
  expectOrdinaryFlowClean(monitor);
});

test('support-settings submits a local support receipt from Settings', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await setAppRoute(app, '/settings');
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
  expectOrdinaryFlowClean(monitor);
});

test('downloads exports selected soil observations from standard History', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await setAppRoute(app, '/history');
  await openSoilMoistureHistoryFromOverview(app);
  await expect(app.getByRole('heading', {name: /Tomato plot/i})).toBeVisible();
  await app.getByRole('button', {name: 'Export'}).click();
  const exportDialog = app.getByRole('dialog', {name: 'Export data'});
  const calendar = exportDialog.getByTestId('range-calendar');
  const selectedDay = calendar.getByTestId('day-2026-10-10');
  const targetMonth = Date.UTC(2026, 9, 1);
  for (let month = 0; month < 24 && !(await selectedDay.isEnabled().catch(() => false)); month += 1) {
    const monthLabel = await calendar.locator('p').first().innerText();
    const shownMonth = Date.parse(`${monthLabel} 1 UTC`);
    expect(Number.isFinite(shownMonth), `calendar month label is parseable: ${monthLabel}`).toBe(true);
    if (shownMonth === targetMonth) break;
    await calendar.getByRole('button', {name: shownMonth < targetMonth ? 'Next month' : 'Previous month'}).click();
  }
  await expect(calendar.locator('p').first()).toHaveText(/October 2026/);
  await expect(selectedDay).toBeEnabled();
  await selectedDay.dblclick();
  await expect(exportDialog).toContainText(/2026-10-10.*2026-10-10/);
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', {name: 'Download CSV'}).click();
  const file = await download;
  const csvText = (await readFile(await file.path())).toString('utf8');
  const csvRows = csvText.split(/\r?\n/).filter(Boolean).map(line => line.split(','));
  expect(csvRows[0]).toContain('timestamp');
  const soilRow = csvRows.find(row => row[6] === 'swt_1' && row[0] === '2026-10-10T02:59:50.000Z');
  expect(soilRow, 'the selected local day export contains the seeded Tomato SWT1 observation').toBeDefined();
  expect(soilRow?.[2]).toBe('Tomato plot');
  expect(soilRow?.[7]).toBe('20');
  expect(soilRow?.[10]).toBe('45');
  expectOrdinaryFlowClean(monitor);
});

test('reset-continuity restores seed, auth, clock, valve, preferences, and a usable route', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await pausePublicClock(page);
  await app.getByRole('button', {name: 'Add', exact: true}).click();
  await app.getByRole('menuitem', {name: /zone/i}).click();
  await app.getByRole('dialog').locator('#zone-name').fill('Discarded reset zone');
  await app.getByRole('dialog').locator('form').getByRole('button', {name: /create/i}).click();
  await app.getByRole('link', {name: /settings/i}).click();
  await app.getByRole('button', {name: 'Dark', exact: true}).click();
  await setAppRoute(app, '/dashboard');
  const valve = valveTile(app, 'Tomato valve');
  await valve.getByRole('button', {name: 'Open', exact: true}).click();
  await app.getByRole('dialog').getByLabel(/duration/i).fill('5');
  await app.getByRole('dialog').getByRole('button', {name: /open for 5 min/i}).click();
  await expect(valveState(valve)).toContainText(/pending|waiting/i);
  await advanceNextEvent(page);
  await expect(valveState(valve)).toContainText(/^Open\b/);
  await page.getByRole('button', {name: 'Reset session'}).click();
  await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
  await pausePublicClock(page);
  const resetTime = Date.parse((await page.locator('#simulated-time').getAttribute('datetime')) ?? '');
  expect(Number.isFinite(resetTime)).toBe(true);
  expect(resetTime).toBeGreaterThanOrEqual(PUBLIC_EPOCH);
  expect(resetTime).toBeLessThanOrEqual(PUBLIC_EPOCH + 30_000);
  const resetApp = page.frameLocator('#app');
  await expect(resetApp.getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible();
  await expect(resetApp.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(resetApp.getByTestId('water-soil-tile')).toContainText('45.0 kPa');
  await expect(resetApp.getByTestId('water-today-card')).toContainText('0 L');
  await expect(resetApp.locator('#irrigation-zone-1').getByRole('heading', {name: 'Tomato plot', exact: true})).toBeVisible();
  await expect(resetApp.getByText('Discarded reset zone', {exact: true})).toHaveCount(0);
  await expect(valveState(valveTile(resetApp, 'Tomato valve'))).toContainText(/^Closed\b/);
  await expect(resetApp.getByText('Demo farmer')).toBeVisible();
  expectOrdinaryFlowClean(monitor);
});

test('release monitor retains repeated identical notices after clear and navigation', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  const notice = 'This action is not simulated. No command was sent.';
  const requestLocation = () => app.locator('body').evaluate(() => {
    navigator.geolocation.getCurrentPosition(() => {}, () => {});
  });

  await requestLocation();
  await expect.poll(() => monitor.notices).toEqual([notice]);
  markExpectedNotice(monitor, /^This action is not simulated\. No command was sent\.$/);

  await setAppRoute(app, '/settings');
  await expect(page.locator('#host-notice')).toBeHidden();
  await expect(app.getByRole('button', {name: 'Dark', exact: true})).toBeVisible();
  await requestLocation();

  await expect.poll(() => monitor.notices).toEqual([notice, notice]);
  expect(() => expectOrdinaryFlowClean(monitor)).toThrow(/unexpected simulator notices/);
});

test('release monitor retains unsupported local and blocked external-operation notices', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await app.locator('body').evaluate(async () => {
    await new Promise<void>(resolve => navigator.geolocation.getCurrentPosition(
      () => resolve(), () => resolve(),
    ));
  });
  await expect.poll(() => monitor.notices.join('\n')).toMatch(/not simulated|unsupported/i);
  markExpectedNotice(monitor, /not simulated|unsupported/i);
  const blocked = await app.locator('body').evaluate(async () => {
    try {
      await fetch('https://example.invalid/release-probe');
      return 'unexpected-success';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(blocked).toMatch(/Network access is disabled/i);
  await expect.poll(() => monitor.notices.join('\n')).toMatch(/Network access is disabled/i);
  markExpectedNotice(monitor, /Network access is disabled/i);
  expect(monitor.externalRequests).toEqual([]);
  expect(monitor.failedRequests).toEqual([]);
  expect(monitor.badResponses).toEqual([]);
  expect(monitor.pageErrors).toEqual([]);
});

test('native confirmations preserve state on dismissal and apply state on acceptance', async ({page}) => {
  const monitor = await installMonitor(page);
  const app = await openPublicApp(page);
  await pausePublicClock(page);
  expect(await page.locator('#app').getAttribute('sandbox')).toContain('allow-modals');

  await setAppRoute(app, '/settings');
  const timezone = app.locator('#gateway-timezone');
  const persistedTimezone = await timezone.inputValue();
  await timezone.fill('Europe/Zurich');
  await startConfirm(page, app, () => app.getByRole('button', {name: /apply to all zones/i}).click(), false);
  await expect(app.getByText(/updated .* zones/i)).toHaveCount(0);
  await setAppRoute(app, '/dashboard');
  await setAppRoute(app, '/settings');
  await expect(app.locator('#gateway-timezone')).toHaveValue(persistedTimezone);
  await setAppRoute(app, '/dashboard');
  const dismissedZone = app.locator('#irrigation-zone-1');
  await dismissedZone.getByRole('button', {name: 'Configure'}).click();
  await expect(app.getByLabel('Timezone', {exact: true})).toHaveValue(persistedTimezone);
  await app.getByRole('button', {name: 'Cancel', exact: true}).click();
  await setAppRoute(app, '/settings');
  await app.locator('#gateway-timezone').fill('Europe/Zurich');
  await startConfirm(page, app, () => app.getByRole('button', {name: /apply to all zones/i}).click(), true);
  await expect(app.getByRole('status').filter({hasText: /updated .* zones/i})).toBeVisible();
  await setAppRoute(app, '/dashboard');
  await setAppRoute(app, '/settings');
  await expect(app.locator('#gateway-timezone')).toHaveValue('Europe/Zurich');
  await setAppRoute(app, '/dashboard');
  const acceptedZone = app.locator('#irrigation-zone-1');
  await acceptedZone.getByRole('button', {name: 'Configure'}).click();
  const acceptedZoneTimezoneInput = app.getByLabel('Timezone', {exact: true});
  await expect(acceptedZoneTimezoneInput).toHaveValue('Europe/Zurich');
  const acceptedZoneTimezone = await acceptedZoneTimezoneInput.inputValue();
  await app.getByRole('button', {name: 'Cancel', exact: true}).click();

  const scheduleZone = app.locator('#irrigation-zone-1');
  const scheduleToggle = scheduleZone.getByRole('button', {name: 'Trigger-based irrigation'});
  if (await scheduleToggle.getAttribute('aria-expanded') === 'false') await scheduleToggle.click();
  await expect(scheduleZone.getByRole('button', {name: 'On', exact: true})).toBeVisible();
  await scheduleZone.getByRole('button', {name: 'Save schedule'}).click();
  await expect(scheduleZone.getByRole('button', {name: 'On', exact: true})).toBeVisible();
  await app.getByRole('link', {name: /settings/i}).click();
  const modules = app.getByRole('region', {name: 'Modules'});
  const scheduler = modules.getByRole('group', {name: 'Trigger-based irrigation', exact: true});
  await expect(scheduler.getByRole('button', {name: 'On'})).toHaveAttribute('aria-pressed', 'true');
  await startConfirm(page, app, () => scheduler.getByRole('button', {name: 'Off'}).click(), false);
  await expect(scheduler.getByRole('button', {name: 'On'})).toHaveAttribute('aria-pressed', 'true');
  await startConfirm(page, app, () => scheduler.getByRole('button', {name: 'Off'}).click(), true);
  await expect(scheduler.getByRole('button', {name: 'Off'})).toHaveAttribute('aria-pressed', 'true');

  await setAppRoute(app, '/dashboard');
  const disabledSchedule = app.locator('#irrigation-zone-1');
  await expect(disabledSchedule).toContainText(/Scheduler off/i);
  await setAppRoute(app, '/settings');
  const reopenedModules = app.getByRole('region', {name: 'Modules'});
  const reopenedScheduler = reopenedModules.getByRole('group', {name: 'Trigger-based irrigation', exact: true});
  await expect(reopenedScheduler.getByRole('button', {name: 'Off'})).toHaveAttribute('aria-pressed', 'true');
  await reopenedScheduler.getByRole('button', {name: 'On'}).click();
  await expect(reopenedScheduler.getByRole('button', {name: 'On'})).toHaveAttribute('aria-pressed', 'true');
  await setAppRoute(app, '/dashboard');
  const retainedDisabledZone = await expandZone(app, 1, 'Tomato plot');
  const retainedDisabledToggle = retainedDisabledZone.getByRole('button', {name: 'Trigger-based irrigation'});
  if (await retainedDisabledToggle.getAttribute('aria-expanded') === 'false') await retainedDisabledToggle.click();
  await expect(retainedDisabledZone.getByRole('button', {name: 'Off', exact: true})).toBeVisible();

  await retainedDisabledZone.getByRole('button', {name: 'Off', exact: true}).click();
  await retainedDisabledZone.getByRole('button', {name: 'Save schedule'}).click();
  await expect(retainedDisabledZone.getByText('Saved.', {exact: true})).toBeVisible();
  await expect(retainedDisabledZone).not.toContainText('Scheduler off');
  await expect(retainedDisabledZone.getByRole('button', {name: 'On', exact: true})).toBeVisible();

  await setAppRoute(app, '/dashboard');
  const demonstrationBed = await expandZone(app, 2, 'Demonstration bed');
  await expandZoneDevices(demonstrationBed);
  const dragino = demonstrationBed.locator('div.shadow-sm').filter({has: app.getByText('Bed dendrometer', {exact: true})});

  const watermark = demonstrationBed.locator('div.shadow-sm').filter({has: app.getByText('Bed Watermark demonstration', {exact: true})});
  await watermark.getByRole('button', {name: 'Device settings'}).click();
  const watermarkSettings = app.getByRole('dialog', {name: 'Device settings'});
  await expect(watermarkSettings.getByText('WATERMARK calibration', {exact: true})).toBeVisible();
  const watermarkCalibration = watermarkSettings.locator('section').filter({hasText: 'WATERMARK calibration'});
  const calibrationInputs = watermarkCalibration.locator('input');
  await expect(calibrationInputs).toHaveCount(8);
  const calibrationValues: Record<string, string> = {
    pullup_1_ohm: '47000', pulldown_1_ohm: '47000',
    pullup_2_ohm: '47000', pulldown_2_ohm: '47000',
    series_fwd_1_ohm: '100', series_rev_1_ohm: '100',
    series_fwd_2_ohm: '100', series_rev_2_ohm: '100',
  };
  for (const [field, value] of Object.entries(calibrationValues)) {
    await watermarkCalibration.locator(`input[name="${field}"]`).fill(value);
  }
  const saveCalibration = watermarkCalibration.getByRole('button', {name: 'Save calibration'});
  await expect(saveCalibration).toBeEnabled();
  for (const [field, value] of Object.entries(calibrationValues)) {
    await expect(watermarkCalibration.locator(`input[name="${field}"]`)).toHaveValue(value);
  }
  await saveCalibration.click();
  await expect(watermarkCalibration.getByText(/Calibration saved\./)).toBeVisible();
  await expect(watermarkSettings.getByRole('button', {name: /delete calibration/i})).toBeVisible();
  await startConfirm(page, app, () => watermarkCalibration.getByRole('button', {name: 'Delete calibration'}).click(), false);
  await expect(watermarkSettings.getByRole('button', {name: /delete calibration/i})).toBeVisible();
  await watermarkSettings.getByRole('button', {name: 'Close', exact: true}).click();
  await watermark.getByRole('button', {name: 'Device settings'}).click();
  const watermarkAfterDismissal = app.getByRole('dialog', {name: 'Device settings'});
  await expect(watermarkAfterDismissal.getByRole('button', {name: /delete calibration/i})).toBeVisible();
  const watermarkAfterDismissalSection = watermarkAfterDismissal.locator('section').filter({hasText: 'WATERMARK calibration'});
  await startConfirm(page, app, () => watermarkAfterDismissalSection.getByRole('button', {name: 'Delete calibration'}).click(), true);
  await expect(watermarkAfterDismissalSection.getByText('Calibration deleted.')).toBeVisible();
  await watermarkAfterDismissal.getByRole('button', {name: 'Close', exact: true}).click();
  await watermark.getByRole('button', {name: 'Device settings'}).click();
  const watermarkReopened = app.getByRole('dialog', {name: 'Device settings'});
  await expect(watermarkReopened.getByRole('button', {name: /delete calibration/i})).toHaveCount(0);
  await watermarkReopened.getByRole('button', {name: 'Close', exact: true}).click();

  const dendro = demonstrationBed.locator('div.shadow-sm').filter({has: app.getByText('Bed dendrometer', {exact: true})});
  await dendro.getByRole('button', {name: 'Device settings'}).click();
  const dendroSettings = app.getByRole('dialog', {name: 'Device settings'});
  const dendrometerCalibration = dendroSettings.locator('section').filter({hasText: 'Dendrometer calibration'});
  // The seed is a compatibility fixture: its current reading is legacy, while
  // the reset control appears only for legacy_single_adc telemetry or a saved
  // force-legacy setting. An unsaved checkbox draft must not expose the action.
  const resetBaselineDraft = dendroSettings.getByRole('button', {name: 'Reset stem baseline'});
  await expect(resetBaselineDraft).toHaveCount(0);
  await dendrometerCalibration.getByRole('checkbox').check();
  await expect(resetBaselineDraft).toHaveCount(0);
  await dendrometerCalibration.getByRole('button', {name: 'Save dendrometer calibration'}).click();
  await expect(dendrometerCalibration.getByText(
    'Dendrometer calibration saved. Legacy ADC is forced for this device.', {exact: true},
  )).toBeVisible();
  await dendroSettings.getByRole('button', {name: 'Close', exact: true}).click();
  await dendro.getByRole('button', {name: 'Device settings'}).click();
  const savedDendroSettings = app.getByRole('dialog', {name: 'Device settings'});
  const savedDendrometerCalibration = savedDendroSettings.locator('section').filter({hasText: 'Dendrometer calibration'});
  await expect(savedDendrometerCalibration.getByRole('checkbox')).toBeChecked();
  await expect(savedDendrometerCalibration.getByLabel('Stroke (mm)', {exact: true})).toHaveValue('');
  await expect(savedDendrometerCalibration.getByLabel('Retracted ratio (0 mm)', {exact: true})).toHaveValue('');
  await expect(savedDendrometerCalibration.getByLabel('Extended ratio (full stroke)', {exact: true})).toHaveValue('');
  const resetBaseline = savedDendroSettings.getByRole('button', {name: 'Reset stem baseline'});
  await expect(resetBaseline).toBeVisible();
  await advanceToNextDailyTrigger(page, acceptedZoneTimezone);
  const stemChange = dendro.locator('button[title="View stem change history"]');
  const stemChangeCard = stemChange.locator('..');
  let stemReading = '';
  for (let event = 0; event < 6; event += 1) {
    if (await stemChange.count()) {
      stemReading = await stemChange.innerText();
      const parsed = Number(stemReading.match(/-?\d+(?:\.\d+)?/)?.[0]);
      if (Number.isFinite(parsed) && parsed !== 0) break;
    }
    await advanceNextEvent(page);
  }
  const nonzeroStemReading = Number(stemReading.match(/-?\d+(?:\.\d+)?/)?.[0]);
  expect(Number.isFinite(nonzeroStemReading) && nonzeroStemReading !== 0, `observed nonzero live dendrometer stem change: ${stemReading}`).toBe(true);
  await expect(dendro).not.toContainText('Awaiting baseline');
  const baselineBeforeDismiss = await stemChange.innerText();
  await startConfirm(page, app, () => resetBaseline.click(), false);
  await expect(resetBaseline).toBeVisible();
  await expect(stemChangeCard).toContainText(baselineBeforeDismiss.replace(/\s+/g, ' ').trim());
  await expect(stemChange).toHaveText(baselineBeforeDismiss.trim());
  await startConfirm(page, app, () => resetBaseline.click(), true);
  await expect(savedDendroSettings.getByText(/legacy stem baseline cleared/i)).toBeVisible();
  await savedDendroSettings.getByRole('button', {name: 'Close'}).click();
  await dendro.getByRole('button', {name: 'Device settings'}).click();
  const baselineReadback = app.getByRole('dialog', {name: 'Device settings'});
  await expect(baselineReadback.getByRole('button', {name: 'Reset stem baseline'})).toBeVisible();
  const awaitingBaseline = dendro.locator('button[title="View mechanical history while the new baseline is being established"]');
  await expect(awaitingBaseline).toHaveText('Awaiting baseline');
  await baselineReadback.getByRole('button', {name: 'Close'}).click();

  await dragino.getByRole('button', {name: 'Device settings'}).click();
  const draginoSettings = app.getByRole('dialog', {name: 'Device settings'});
  const mode = draginoSettings.getByLabel('LSN50 mode');
  await mode.selectOption('MOD9');
  await startConfirm(page, app, () => draginoSettings.getByRole('button', {name: 'Apply mode'}).click(), false);
  const currentModeLabel = draginoSettings.getByText('LSN50 mode', {exact: true}).locator('..');
  await expect(currentModeLabel.getByText('MOD3', {exact: true})).toBeVisible();
  await draginoSettings.getByRole('button', {name: 'Close', exact: true}).click();
  await dragino.getByRole('button', {name: 'Device settings'}).click();
  const modeAfterDismissal = app.getByRole('dialog', {name: 'Device settings'});
  await expect(modeAfterDismissal.getByLabel('LSN50 mode')).toHaveValue('MOD3');
  await modeAfterDismissal.getByLabel('LSN50 mode').selectOption('MOD9');
  await startConfirm(page, app, () => modeAfterDismissal.getByRole('button', {name: 'Apply mode'}).click(), true);
  await expect(modeAfterDismissal.getByText(/waiting for the next uplink/i)).toBeVisible();
  await modeAfterDismissal.getByRole('button', {name: 'Close', exact: true}).click();
  await advanceNextEvent(page);
  await dragino.getByRole('button', {name: 'Device settings'}).click();
  const modeReadback = app.getByRole('dialog', {name: 'Device settings'});
  await expect(modeReadback.getByLabel('LSN50 mode')).toHaveValue('MOD9');
  await modeReadback.getByRole('button', {name: 'Close', exact: true}).click();

  await setAppRoute(app, '/history');
  await expect(app.getByRole('heading', {name: /^History$/i})).toBeVisible();
  await openSoilMoistureHistoryFromOverview(app);
  await expect(app.getByTestId('history-visualization-surface')).toBeVisible();
  expectOrdinaryFlowClean(monitor);
});
