import {expect, test} from '@playwright/test';

const preview = '/website-demo/preview.html';
const invitation = '#osi-simulator-invitation';

async function installWebsiteFixture(page: import('@playwright/test').Page, includePriorInert = false): Promise<void> {
  await page.route(`**${preview}`, async route => {
    const response = await route.fetch();
    let html = await response.text();
    if (includePriorInert) html = html.replace('</body>', '<aside id="pre-existing-inert" inert>Existing inert region</aside></body>');
    await route.fulfill({response, body: html});
  });
}

async function openPreviewWithPriorPageState(page: import('@playwright/test').Page): Promise<number> {
  let releaseInvitation!: () => void;
  const invitationGate = new Promise<void>(resolve => { releaseInvitation = resolve; });
  await installWebsiteFixture(page, true);
  await page.route('**/website-demo/invitation.html', async route => {
    await invitationGate;
    await route.continue();
  });
  await page.goto(preview);
  await page.getByRole('link', {name: 'Open Smart Irrigation home'}).focus();
  await page.evaluate(() => {
    document.documentElement.style.minHeight = '2000px';
    document.body.style.minHeight = '2000px';
    window.scrollTo(0, 240);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(240);
  releaseInvitation();
  await expect(page.locator(invitation)).toBeVisible();
  return 240;
}

async function expectNormalPageState(page: import('@playwright/test').Page, scrollY: number): Promise<void> {
  await expect(page.locator('#site-content')).not.toHaveAttribute('inert');
  await expect(page.locator('#pre-existing-inert')).toHaveAttribute('inert', '');
  expect(await page.locator('body').evaluate(element => (element as HTMLElement).style.overflow)).toBe('');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY);
}

async function expectSimulatorLink(page: import('@playwright/test').Page, link: import('@playwright/test').Locator): Promise<void> {
  const destination = await link.evaluate(anchor => {
    const url = new URL((anchor as HTMLAnchorElement).href);
    return {origin: url.origin, pathname: url.pathname};
  });
  expect(destination).toEqual({origin: new URL(page.url()).origin, pathname: '/simulator/'});
}

async function badgeGeometry(page: import('@playwright/test').Page) {
  return page.locator(invitation).evaluate(element => {
    const entry = element.querySelector('a[data-simulator-link]')!;
    const visual = element.querySelector('.osi-simulator-invitation__visual')!;
    const close = element.querySelector('button[aria-label="Close simulator invitation"]')!;
    const rect = (node: Element) => {
      const {left, top, right, bottom, width, height} = node.getBoundingClientRect();
      return {left, top, right, bottom, width, height};
    };
    const header = document.querySelector('#osiUHeader')!.getBoundingClientRect();
    const menuButton = document.querySelector('#osiUBurger')!;
    const menuButtonStyle = getComputedStyle(menuButton);
    const menuButtonRect = menuButton.getBoundingClientRect();
    const visibleMenuBottom = menuButtonStyle.display !== 'none' && menuButtonRect.width > 0
      ? menuButtonRect.bottom
      : header.bottom;
    const entryRect = rect(entry);
    const closeRect = rect(close);
    const overlap = (a: typeof entryRect, b: typeof closeRect) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return {
      entry: entryRect,
      visual: rect(visual),
      close: closeRect,
      intersects: overlap(entryRect, closeRect),
      visualHeight: rect(visual).height,
      viewport: {width: innerWidth, height: innerHeight},
      headerBottom: header.bottom,
      menuBottom: visibleMenuBottom,
      pointerEvents: getComputedStyle(element).pointerEvents,
      entryPointerEvents: getComputedStyle(entry).pointerEvents,
      closePointerEvents: getComputedStyle(close).pointerEvents,
    };
  });
}

test('homepage invitation stays nonmodal and preserves normal page state and focus', async ({page}) => {
  const initialScrollY = await openPreviewWithPriorPageState(page);
  const entry = page.locator(`${invitation} a[data-simulator-link]`);

  await expect(page.locator(invitation)).not.toHaveJSProperty('open', true);
  await expect(page.locator(invitation)).not.toHaveAttribute('aria-modal');
  await expect(page.getByRole('link', {name: 'Open Smart Irrigation home'})).toBeFocused();
  await expectNormalPageState(page, initialScrollY);
  await expect(page.locator('#wasag-ribbon')).toBeVisible();
  await expect(page.locator('#ordinary-site-control')).toBeVisible();
  await expectSimulatorLink(page, entry);
});

test('one accessible entry link wraps the real screenshot and exact Try me! caption without preloading the app', async ({page}) => {
  const simulatorRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/simulator/')) simulatorRequests.push(path);
  });
  await installWebsiteFixture(page);
  await page.goto(preview);

  const entry = page.locator(`${invitation} a[data-simulator-link]`);
  await expectSimulatorLink(page, entry);
  await expect(entry.getByRole('img', {name: /OSI OS dashboard/i})).toBeVisible();
  await expect(entry.getByText('Try me!', {exact: true})).toBeVisible();
  await expect(page.locator(`${invitation} a[data-simulator-link]`)).toHaveCount(1);
  await expect(page.locator(`${invitation} button[aria-label="Close simulator invitation"]`)).toBeVisible();
  expect(simulatorRequests).toEqual([]);
});

test('visual phone and caption occupy 10dvh while entry and close targets remain separate 44px controls', async ({page}) => {
  const viewports = [
    {width: 320, height: 568}, {width: 568, height: 320}, {width: 390, height: 844},
    {width: 844, height: 390}, {width: 880, height: 720}, {width: 881, height: 720},
    {width: 1280, height: 720}, {width: 640, height: 450},
  ];
  await page.setViewportSize(viewports[0]!);
  await installWebsiteFixture(page);
  await page.goto(preview);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const geometry = await badgeGeometry(page);
    expect(geometry.visualHeight, `10dvh visual height at ${viewport.width}x${viewport.height}`)
      .toBeGreaterThanOrEqual(geometry.viewport.height * 0.1 - 1);
    expect(geometry.visualHeight, `10dvh visual height at ${viewport.width}x${viewport.height}`)
      .toBeLessThanOrEqual(geometry.viewport.height * 0.1 + 1);
    expect(geometry.entry.width, 'entry target width').toBeGreaterThanOrEqual(44);
    expect(geometry.entry.height, 'entry target height').toBeGreaterThanOrEqual(44);
    expect(geometry.close.width, 'close target width').toBeGreaterThanOrEqual(44);
    expect(geometry.close.height, 'close target height').toBeGreaterThanOrEqual(44);
    expect(geometry.intersects, `entry and close targets are disjoint at ${viewport.width}px`).toBe(false);
    expect(geometry.close.left - geometry.entry.right, 'explicit 8px gap between targets').toBeGreaterThanOrEqual(7.99);
    expect(geometry.pointerEvents).toBe('none');
    expect(geometry.entryPointerEvents).toBe('auto');
    expect(geometry.closePointerEvents).toBe('auto');
    expect(geometry.entry.top, `badge below header/menu at ${viewport.width}px`)
      .toBeGreaterThanOrEqual(Math.max(geometry.headerBottom, geometry.menuBottom) + 7);
    expect(geometry.entry.right).toBeLessThanOrEqual(viewport.width - 7);
    expect(geometry.close.right).toBeLessThanOrEqual(viewport.width - 7);
    expect(geometry.close.bottom).toBeLessThanOrEqual(viewport.height + 1);
    const buttonVisible = await page.locator('#osiUBurger').isVisible();
    expect(buttonVisible, `menu button breakpoint at ${viewport.width}px`).toBe(viewport.width <= 880);
  }
});

test('the menu overlay stays above the badge and its real controls remain clickable', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await installWebsiteFixture(page);
  await page.goto(preview);
  await expect(page.locator(invitation)).toBeVisible();
  await page.getByRole('button', {name: 'Menu', exact: true}).click();
  const menuAction = page.getByRole('button', {name: 'Menu action'});
  await expect(menuAction).toBeVisible();
  const menuActionBox = await menuAction.boundingBox();
  const closeBox = await page.locator(`${invitation} button[aria-label="Close simulator invitation"]`).boundingBox();
  expect(menuActionBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(menuActionBox!.x).toBeLessThan(closeBox!.x + closeBox!.width);
  await menuAction.click();
  await expect(menuAction).toHaveAttribute('data-clicked', 'yes');
});

test('screenshot and caption each enter same-tab simulator navigation in a fresh session', async ({page, context}) => {
  await installWebsiteFixture(page);
  const enter = async (targetPage: import('@playwright/test').Page, clicked: 'image' | 'caption') => {
    await targetPage.goto(preview);
    const entry = targetPage.locator(`${invitation} a[data-simulator-link]`);
    if (clicked === 'image') await entry.getByRole('img', {name: /OSI OS dashboard/i}).click();
    else await entry.getByText('Try me!', {exact: true}).click();
    await expect(targetPage).toHaveURL(/\/simulator\/$/);
    await expect(targetPage.frameLocator('#app').getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible({timeout: 20_000});
    await targetPage.goBack();
    await expect(targetPage).toHaveURL(/\/website-demo\/preview\.html$/);
    await expect(targetPage.locator(invitation)).toBeHidden();
  };
  await enter(page, 'image');
  await enter(await context.newPage(), 'caption');
});

test('close and Escape dismiss only for the current tab without changing focus, scroll, or history', async ({page, context}) => {
  const initialScrollY = await openPreviewWithPriorPageState(page);
  const close = page.locator(`${invitation} button[aria-label="Close simulator invitation"]`);
  await close.click();
  await expect(page.locator(invitation)).toBeHidden();
  await expect(page.getByRole('link', {name: 'Open Smart Irrigation home'})).toBeFocused();
  await expectNormalPageState(page, initialScrollY);
  await expect(page).toHaveURL(/\/website-demo\/preview\.html$/);
  await page.addScriptTag({url: '/website-demo/invitation.js'});
  await expect(page.locator(invitation)).toBeHidden();

  const secondTab = await context.newPage();
  await secondTab.goto(preview);
  await expect(secondTab.locator(invitation)).toBeVisible();
  await secondTab.keyboard.press('Escape');
  await expect(secondTab.locator(invitation)).toBeHidden();
  await expect(secondTab).toHaveURL(/\/website-demo\/preview\.html$/);

  const thirdTab = await context.newPage();
  await thirdTab.goto(preview);
  await expect(thirdTab.locator(invitation)).toBeVisible();
});

test('session storage failure falls back to memory and reduced motion removes transitions', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {configurable: true, get: () => {throw new Error('storage unavailable');}});
  });
  await page.setViewportSize({width: 568, height: 320});
  await page.emulateMedia({reducedMotion: 'reduce'});
  await installWebsiteFixture(page);
  await page.goto(preview);
  await expect(page.locator(invitation)).toBeVisible();
  const close = page.locator(`${invitation} button[aria-label="Close simulator invitation"]`);
  await expect(close).toHaveCSS('transition-duration', '0s');
  await close.click();
  await page.addScriptTag({url: '/website-demo/invitation.js'});
  await expect(page.locator(invitation)).toBeHidden();
});

test('resize and scroll keep the invitation below live header geometry and outside ordinary page controls', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await installWebsiteFixture(page);
  await page.goto(preview);
  await page.locator('#ordinary-site-control').click();
  await expect(page.locator('#ordinary-site-control')).toHaveAttribute('data-clicked', 'yes');

  await page.locator('#osiUHeader').evaluate(element => { (element as HTMLElement).style.height = '92px'; });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect.poll(async () => (await badgeGeometry(page)).entry.top).toBeGreaterThanOrEqual(99);
  await page.evaluate(() => window.scrollTo(0, 240));
  await expect.poll(async () => {
    const geometry = await badgeGeometry(page);
    return geometry.entry.top >= Math.max(geometry.headerBottom, geometry.menuBottom) + 7;
  }).toBe(true);
});

test('header positioning work coalesces and stops after the invitation is dismissed', async ({page}) => {
  await installWebsiteFixture(page);
  await page.goto(preview);
  await expect(page.locator(invitation)).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  await page.locator(invitation).evaluate(badge => {
    const counts = {
      headerRectReads: 0,
      menuStyleReads: 0,
      menuRectReads: 0,
      badgeRectReads: 0,
      positionWrites: 0,
    };
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.id === 'osiUHeader') counts.headerRectReads += 1;
      if (this.id === 'osiUBurger') counts.menuRectReads += 1;
      if (this.id === 'osi-simulator-invitation') counts.badgeRectReads += 1;
      return originalRect.call(this);
    };

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element, pseudoElement?: string | null) => {
        if (element.id === 'osiUBurger') counts.menuStyleReads += 1;
        return originalGetComputedStyle(element, pseudoElement);
      },
    });

    const badgeStyle = badge.style;
    const originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (property, value, priority) {
      if (this === badgeStyle && property === '--osi-invitation-top') counts.positionWrites += 1;
      return originalSetProperty.call(this, property, value, priority);
    };
    Object.defineProperty(window, '__osiBadgePositioningCounts', {configurable: true, value: counts});
  });

  const visibleWork = await page.evaluate(async () => {
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const counts = Object.getOwnPropertyDescriptor(window, '__osiBadgePositioningCounts')!.value;
    return {...counts};
  });
  expect(visibleWork).toEqual({
    headerRectReads: 1,
    menuStyleReads: 1,
    menuRectReads: 1,
    badgeRectReads: 1,
    positionWrites: 1,
  });

  const dismissedWork = await page.evaluate(async () => {
    const counts = Object.getOwnPropertyDescriptor(window, '__osiBadgePositioningCounts')!.value;
    Object.assign(counts, {
      headerRectReads: 0,
      menuStyleReads: 0,
      menuRectReads: 0,
      badgeRectReads: 0,
      positionWrites: 0,
    });

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));
    (document.querySelector('#osi-simulator-invitation .osi-simulator-invitation__close') as HTMLButtonElement).click();
    (document.querySelector('#osiUHeader') as HTMLElement).style.height = '96px';
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    return {...counts};
  });
  expect(dismissedWork).toEqual({
    headerRectReads: 0,
    menuStyleReads: 0,
    menuRectReads: 0,
    badgeRectReads: 0,
    positionWrites: 0,
  });
  await expect(page.locator(invitation)).toBeHidden();
});

test('the invitation remains usable at effective zoom and captures the compact design', async ({page}, testInfo) => {
  await page.setViewportSize({width: 1440, height: 900});
  await installWebsiteFixture(page);
  await page.goto(preview);
  await expect(page.locator(invitation)).toBeVisible();
  await expect(page.locator(`${invitation} img[alt*="OSI OS dashboard"]`)).toBeVisible();
  await expect(page.locator(`${invitation} a`).getByText('Try me!', {exact: true})).toBeVisible();
  await page.screenshot({path: `../../.superpowers/sdd/2026-10-11-public-simulator-v1-release/badge-${testInfo.project.name}-desktop.png`});

  await page.setViewportSize({width: 640, height: 450});
  const geometry = await badgeGeometry(page);
  expect(geometry.entry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.close.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.close.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  await page.screenshot({path: `../../.superpowers/sdd/2026-10-11-public-simulator-v1-release/badge-${testInfo.project.name}-effective-zoom.png`});
});

test('the actual outer iframe fixture permits cancel and accept of a native simulator confirmation', async ({page}) => {
  await page.goto('/website-demo/embed.html');
  const simulatorFrame = page.locator('#osi-simulator-frame');
  await expect(simulatorFrame).toBeVisible();
  await expect(simulatorFrame).toHaveAttribute('sandbox', /allow-modals/);
  await expect(simulatorFrame).toHaveAttribute('sandbox', /allow-downloads/);
  const host = page.frameLocator('#osi-simulator-frame');
  const appFrame = host.locator('#app');
  await expect(appFrame).toHaveAttribute('sandbox', /allow-modals/);
  await expect(appFrame).toHaveAttribute('sandbox', /allow-downloads/);
  const app = host.frameLocator('#app');
  await expect(app.getByRole('heading', {name: 'OSI OS Dashboard'})).toBeVisible({timeout: 20_000});

  const zone = app.locator('#irrigation-zone-1');
  await zone.getByRole('button', {name: 'Trigger-based irrigation'}).click();
  const scheduleEnabled = zone.getByRole('button', {name: 'On', exact: true});
  await expect(scheduleEnabled).toBeVisible();
  await expect(zone.getByLabel('Threshold (kPa)')).toHaveValue('30');
  await zone.getByRole('button', {name: 'Save schedule'}).click();
  await expect(zone.getByText('Saved.', {exact: true})).toBeVisible();

  const disableScheduler = async (accept: boolean) => {
    await app.getByRole('link', {name: /settings/i}).click();
    const scheduler = app.getByRole('region', {name: 'Modules'}).getByRole('group', {name: 'Trigger-based irrigation'});
    const confirmation = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.type()).toBe('confirm');
      if (accept) await dialog.accept();
      else await dialog.dismiss();
    });
    await scheduler.getByRole('button', {name: 'Off', exact: true}).click();
    await confirmation;
    if (accept) {
      await expect(app.getByText('Disabled 1 active schedule.', {exact: true})).toBeVisible({timeout: 10_000});
      await expect(scheduler.getByRole('button', {name: 'Off', exact: true})).toHaveAttribute('aria-pressed', 'true');
    } else {
      await expect(scheduler.getByRole('button', {name: 'On', exact: true})).toHaveAttribute('aria-pressed', 'true');
    }
  };
  await disableScheduler(false);
  await app.getByRole('link', {name: /back to dashboard/i}).click();
  const trigger = zone.getByRole('button', {name: 'Trigger-based irrigation'});
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(zone.getByRole('button', {name: 'On', exact: true})).toBeVisible();
  await expect(zone.getByLabel('Threshold (kPa)')).toHaveValue('30');
  await disableScheduler(true);
});
