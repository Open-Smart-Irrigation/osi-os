import {expect, test, type Locator, type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

test.setTimeout(120_000);

function valveTile(app: ReturnType<Page['frameLocator']>): Locator {
  return app.getByTestId('valve-actions').first().locator('..');
}

function valveState(app: ReturnType<Page['frameLocator']>): Locator {
  return valveTile(app).locator(':scope > div.flex.items-start.gap-3 > div.min-w-0 > p').first();
}

async function startTimedStep(page: Page): Promise<void> {
  await page.getByRole('button', {name: 'Guide'}).click();
  await expect(page.locator('#guide-intro')).toBeVisible();
  await page.getByRole('button', {name: 'Start guide'}).click();
  for (let step = 0; step < 3; step += 1) {
    await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});
    await page.locator('#guide-next').click();
  }
  await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});
  await expect(page.frameLocator('#app').getByTestId('valve-actions').first()).toHaveClass(/demo-guide-target/);
}

async function advanceWithHostButton(page: Page): Promise<void> {
  const before = Date.parse((await page.locator('#simulated-time').getAttribute('datetime')) ?? '');
  await page.getByRole('button', {name: /Skip to next event/}).click();
  await expect.poll(async () => Date.parse((await page.locator('#simulated-time').getAttribute('datetime')) ?? ''), {timeout: 5_000}).toBeGreaterThan(before);
}

for (const viewport of [{width: 390, height: 844}, {width: 1280, height: 800}]) {
  test(`guided timed irrigation and weekly schedule remain pointer-operable at ${viewport.width}px`, async ({page}) => {
    await page.setViewportSize(viewport);
    await page.goto('/simulator/');
    await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
    const app = page.frameLocator('#app');
    await startTimedStep(page);
    await mkdir('/tmp/osi-simulator-ux-evidence', {recursive: true});
    await page.mouse.move(8, 8);
    await page.screenshot({path: `/tmp/osi-simulator-ux-evidence/guide-${viewport.width}.png`, fullPage: true});

    const guide = await page.locator('#guide-panel').boundingBox();
    const frame = await page.locator('#app').boundingBox();
    expect(guide).not.toBeNull();
    expect(frame).not.toBeNull();
    if (viewport.width <= 700) {
      expect(frame!.x).toBe(0);
      expect(frame!.width, 'the guided app uses the full phone width').toBe(viewport.width);
    }
    expect(guide!.x).toBeGreaterThanOrEqual(0);
    expect(guide!.x + guide!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(guide!.y + guide!.height).toBeLessThanOrEqual(viewport.height + 1);
    if (viewport.width > 700) expect(guide!.x + guide!.width).toBeLessThanOrEqual(frame!.x + 1);
    else expect(guide!.y + guide!.height).toBeLessThanOrEqual(frame!.y + 1);

    const open = valveTile(app).getByRole('button', {name: 'Open', exact: true});
    const openBox = await open.boundingBox();
    expect(openBox).not.toBeNull();
    const hit = await page.evaluate(({x, y}) => {
      const element = document.elementFromPoint(x, y);
      return {id: element?.id, tag: element?.tagName.toLowerCase()};
    }, {x: openBox!.x + openBox!.width / 2, y: openBox!.y + openBox!.height / 2});
    expect(hit, 'the guide leaves the center of Open unobstructed').toEqual({id: 'app', tag: 'iframe'});
    await open.click();
    const dialog = app.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.mouse.move(8, 8);
    await page.screenshot({path: `/tmp/osi-simulator-ux-evidence/open-dialog-${viewport.width}.png`, fullPage: true});
    await dialog.getByLabel(/duration/i).fill('1');
    await dialog.getByRole('button', {name: /open for 1 min/i}).click();
    await expect(page.locator('#event-row')).toBeVisible();
    const event = page.locator('#skip-event');
    await expect(event).toBeVisible();
    await page.mouse.move(8, 8);
    await page.screenshot({path: `/tmp/osi-simulator-ux-evidence/event-row-${viewport.width}.png`, fullPage: true});
    const eventBox = await event.boundingBox();
    expect(eventBox!.x).toBeGreaterThanOrEqual(0);
    expect(eventBox!.x + eventBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(eventBox!.y).toBeGreaterThanOrEqual(0);
    expect(eventBox!.y + eventBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(eventBox!.height, 'event action has a bounded touch target').toBeLessThanOrEqual(100);
    await page.locator('#guide-next').click();
    await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});
    await advanceWithHostButton(page);
    await expect(valveState(app)).toContainText(/^Open\b/);
    await advanceWithHostButton(page);
    await expect(valveState(app)).toContainText(/^Closed\b/);

    const outcomes = app.locator('section').filter({has: app.getByRole('heading', {name: 'Recent irrigations', exact: true})});
    await expect(outcomes).toContainText('Duration: 1 min');
    await expect(outcomes).toContainText(/Irrigated:/i);
    await page.locator('#guide-next').click();
    await expect(outcomes).toHaveClass(/demo-guide-target/);
    await expect(outcomes).toBeVisible();
    await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});
    await page.locator('#guide-next').click();
    await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});

    const schedule = valveTile(app).getByRole('button', {name: 'Schedule', exact: true});
    await schedule.click();
    const scheduleDialog = app.getByRole('dialog');
    const weekly = scheduleDialog.getByRole('button', {name: 'Mon', exact: true}).locator('xpath=ancestor::section[1]');
    await weekly.getByLabel('Start', {exact: true}).fill('06:15');
    await weekly.getByLabel('Duration (min)', {exact: true}).fill('2');
    await weekly.getByLabel('Label (optional)', {exact: true}).fill(`Guide weekly ${viewport.width}`);
    await weekly.getByRole('button', {name: 'Mon', exact: true}).click();
    await weekly.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(scheduleDialog).toContainText(`Guide weekly ${viewport.width}`);
    await expect(page.locator('#guide-panel')).toBeVisible();
    await page.locator('#guide-next').click();
    await expect(page.locator('#guide-links')).toBeVisible();
    await expect(page.locator('#guide-links [data-public-link="visitor"]')).toBeFocused();
  });
}

test('Guide remains visible when opened from expanded desktop view', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 800});
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
  await page.locator('#open-tools').click();
  await page.locator('#view-toggle').click();
  await page.locator('#close-tools').click();
  await expect(page.locator('body')).toHaveClass(/expanded/);
  await page.locator('#guide-start').click();
  await expect(page.locator('#guide-panel')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/expanded/);
  await expect(page.locator('#guide-next')).toBeFocused();
});

test('guide skip target is fresh, locale-aware, reset clears it and close restores focus', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
  const app = page.frameLocator('#app');
  await valveTile(app).getByRole('button', {name: 'Open', exact: true}).click();
  await app.getByRole('dialog').getByRole('button', {name: /open for 1 min/i}).click();
  await expect(page.locator('#skip-event')).toContainText('farm time');
  await app.getByRole('button', {name: 'English', exact: true}).click();
  await app.getByRole('menuitem', {name: 'Français', exact: true}).click();
  await expect(page.locator('#skip-event')).toContainText('heure de la ferme');
  const kampalaTime = await page.locator('#skip-event [data-skip-time]').innerText();
  await app.getByRole('link', {name: 'Réglages', exact: true}).click();
  await app.getByLabel('Fuseau horaire de la passerelle').fill('Europe/Zurich');
  await app.getByRole('button', {name: 'Enregistrer', exact: true}).click();
  await expect(app.getByText('Fuseau horaire enregistré', {exact: true})).toBeVisible();
  const zoneTime = await page.locator('#skip-event [data-skip-time]').innerText();
  expect(zoneTime).not.toBe(kampalaTime);
  const eventAtBeforeJump = await page.locator('#skip-event').getAttribute('data-event-at');
  expect(eventAtBeforeJump).not.toBeNull();
  await page.locator('#skip-event').click();
  await expect(page.locator('#simulated-time')).not.toHaveAttribute('datetime', '');
  await expect.poll(() => page.locator('#skip-event').getAttribute('data-event-at')).not.toBe(eventAtBeforeJump);
  await page.locator('#reset').click();
  await page.locator('#reset-confirm').click();
  await expect(page.locator('#event-row')).toBeHidden();
  await expect(page.locator('#skip-event')).not.toHaveAttribute('data-event-at', /\d+/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  await page.locator('#guide-start').click();
  await page.locator('#guide-next').click();
  await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});
  await page.locator('#guide-close').click();
  await expect(page.locator('#guide-start')).toBeFocused();
  await expect(app.locator('.demo-guide-target')).toHaveCount(0);
});
