import {expect, test} from '@playwright/test';

test.setTimeout(90_000);

test('visitor host fits supported viewports and keeps the app edge-to-edge on mobile', async ({page}) => {
  const captures = [
    {width: 320, height: 720}, {width: 360, height: 800}, {width: 390, height: 844}, {width: 430, height: 932},
    {width: 768, height: 1024}, {width: 1280, height: 720}, {width: 1440, height: 900},
  ];
  await page.setViewportSize(captures[0]!);
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const initialAppUrl = await page.locator('#app').getAttribute('src');

  for (const viewport of captures) {
    await page.setViewportSize(viewport);
    await expect(page.locator('#reset')).toBeVisible();
    const host = await page.evaluate(() => ({
      width: innerWidth,
      html: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      height: innerHeight,
      bodyHeight: document.body.scrollHeight,
    }));
    expect(host.html, `host document overflow at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(host.width);
    expect(host.body, `host body overflow at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(host.width);
    expect(host.bodyHeight, `outer page scroll at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(host.height + 1);

    const appWidth = await page.frameLocator('#app').locator('html').evaluate(element => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(appWidth.scroll, `app document overflow at ${viewport.width}px`).toBeLessThanOrEqual(appWidth.width);
    expect(appWidth.body, `app body overflow at ${viewport.width}px`).toBeLessThanOrEqual(appWidth.width);
    const appBounds = await page.frameLocator('#app').locator('body').evaluate(body => {
      const width = innerWidth;
      const nodes = [...body.querySelectorAll('h1,h2,h3,p,label,button,a,input,select,[role="button"]')];
      return nodes.filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > width + 1);
      }).map(element => ({tag: element.tagName, label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60),
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width}));
    });
    expect(appBounds, `app text/control bounds at ${viewport.width}px`).toEqual([]);

    const frame = await page.locator('.phone-frame').evaluate(element => {
      const iframe = element.querySelector('iframe')!;
      const box = element.getBoundingClientRect();
      const app = iframe.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        border: getComputedStyle(element).borderLeftWidth,
        borderColor: getComputedStyle(element).borderLeftColor,
        background: getComputedStyle(element).backgroundColor,
        shadow: getComputedStyle(element).boxShadow,
        appLeft: app.left,
        appRight: app.right,
        appWidth: app.width,
      };
    });
    expect(frame.left, `simulator starts inside viewport at ${viewport.width}px`).toBeGreaterThanOrEqual(-1);
    expect(frame.right, `simulator ends inside viewport at ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(frame.appLeft, `app starts inside viewport at ${viewport.width}px`).toBeGreaterThanOrEqual(-1);
    expect(frame.appRight, `app ends inside viewport at ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);
    expect(frame.appWidth, `app iframe fits viewport at ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);
    if (viewport.width <= 700) {
      expect(frame.border).toBe('0px');
    } else {
      expect(frame.border).toBe('6px');
      expect(frame.borderColor).toBe('rgb(255, 255, 255)');
      expect(frame.background).toBe('rgb(255, 255, 255)');
      expect(frame.shadow).not.toBe('none');
    }
    const resetHeight = await page.locator('#reset').evaluate(element => element.getBoundingClientRect().height);
    expect(resetHeight, `reset touch target at ${viewport.width}px`).toBeGreaterThanOrEqual(44);
    const outOfBounds = await page.locator('body *').evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    }).map(element => element.id || element.tagName.toLowerCase()));
    expect(outOfBounds, `host text/control bounds at ${viewport.width}px`).toEqual([]);
    const primaryTargets = await page.locator('button').evaluateAll(elements => elements
      .filter(element => element.getClientRects().length > 0)
      .map(element => ({name: element.getAttribute('aria-label') || element.textContent?.trim(), height: element.getBoundingClientRect().height})));
    for (const target of primaryTargets) expect(target.height, `${target.name} touch target at ${viewport.width}px`).toBeGreaterThanOrEqual(44);
    expect(await page.locator('#app').getAttribute('src')).toBe(initialAppUrl);
    if (viewport.width === 320 || viewport.width === 390 || viewport.width === 1280) {
      await page.screenshot({path: `../../.superpowers/sdd/2026-10-10-public-simulator/task-7-capture-${viewport.width}.png`, fullPage: true});
    }
  }

  await page.setViewportSize({width: 844, height: 390});
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#reset')).toBeVisible();
  await expect(page.locator('.phone-frame')).toBeVisible();
  await expect(page.locator('.phone-frame')).toHaveCSS('border-left-width', '0px');
  const landscape = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
  expect(landscape.scroll).toBeLessThanOrEqual(landscape.width);

  // At 200% browser zoom a 1280×900 desktop exposes roughly a 640×450 CSS viewport.
  await page.setViewportSize({width: 640, height: 450});
  await expect(page.locator('#reset')).toBeVisible();
  await expect(page.locator('.phone-frame')).toBeVisible();
  await expect(page.locator('.phone-frame')).toHaveCSS('border-left-width', '0px');
  const zoomed = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth, height: innerHeight, bodyHeight: document.body.scrollHeight}));
  expect(zoomed.scroll).toBeLessThanOrEqual(zoomed.width);
  expect(zoomed.bodyHeight).toBeLessThanOrEqual(zoomed.height + 1);
  const dashboardHeading = await page.frameLocator('#app').getByRole('heading', {name: 'OSI OS Dashboard'}).evaluate(element => {
    const style = getComputedStyle(element);
    return {height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight)};
  });
  expect(dashboardHeading.height, 'dashboard title should not wrap into an orphan line at the effective 200% viewport')
    .toBeLessThanOrEqual(dashboardHeading.lineHeight * 2 + 1);
  await page.screenshot({path: '../../.superpowers/sdd/2026-10-10-public-simulator/task-7-capture-200-percent.png', fullPage: true});
});

test('tools drawer restores focus and host language follows the native app selector', async ({page}) => {
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});

  const trigger = page.getByRole('button', {name: 'Simulation controls'});
  await trigger.click();
  await expect(page.getByRole('dialog', {name: 'Simulation controls'})).toBeVisible();
  await page.getByRole('button', {name: 'Close'}).click();
  await expect(trigger).toBeFocused();

  const app = page.frameLocator('#app');
  await app.getByRole('button', {name: 'English', exact: true}).click();
  await app.getByRole('menuitem', {name: 'Français', exact: true}).click();
  await expect(page.locator('#page-title')).toHaveText('Découvrir OSI OS');
  await expect(page.locator('#reset')).toHaveText('Réinitialiser la session');
  await page.getByRole('button', {name: 'Réinitialiser la session'}).click();
  await expect(page.locator('#page-title')).toHaveText('Explore OSI OS');
  await expect(page.locator('#app')).toHaveAttribute('src', /session=/);

  const locales = [
    {name: 'Deutsch', code: 'de-CH', reset: 'Sitzung zurücksetzen', tools: 'Simulationssteuerung', retry: 'Erneut versuchen'},
    {name: 'Français', code: 'fr', reset: 'Réinitialiser la session', tools: 'Commandes de simulation', retry: 'Réessayer'},
    {name: 'Italiano', code: 'it', reset: 'Reimposta sessione', tools: 'Controlli della simulazione', retry: 'Riprova'},
    {name: 'Español', code: 'es', reset: 'Restablecer sesión', tools: 'Controles de simulación', retry: 'Reintentar'},
    {name: 'Português', code: 'pt', reset: 'Repor sessão', tools: 'Controlos da simulação', retry: 'Tentar novamente'},
    {name: 'Luganda', code: 'lg', reset: 'Zza obuggya ekiseera', tools: 'Ebifuga okugezesa', retry: 'Ddamu ogezeeko'},
    {name: 'English', code: 'en', reset: 'Reset session', tools: 'Simulation controls', retry: 'Retry'},
  ];
  for (const locale of locales) {
    await app.getByRole('button', {name: /English|Deutsch|Français|Italiano|Español|Português|Luganda/}).click();
    await app.getByRole('menuitem', {name: locale.name, exact: true}).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale.code);
    await expect(page.locator('#reset')).toHaveText(locale.reset);
    await expect(page.getByRole('button', {name: locale.tools})).toBeVisible();
    await expect(page.locator('#retry')).toHaveText(locale.retry);
    if (locale.code === 'fr') {
      await app.getByRole('link', {name: 'Réglages', exact: true}).click();
      await app.getByRole('button', {name: 'Sombre', exact: true}).click();
      await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.setViewportSize({width: 360, height: 640});
      await expect(page.locator('#reset')).toBeVisible();
      const narrow = await page.frameLocator('#app').locator('body').evaluate(body => ({
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        body: body.scrollWidth,
        outOfBounds: [...body.querySelectorAll('h1,h2,h3,p,label,button,a,input,select')].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
        }).map(element => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40)),
      }));
      expect(narrow.document).toBeLessThanOrEqual(narrow.width);
      expect(narrow.body).toBeLessThanOrEqual(narrow.width);
      expect(narrow.outOfBounds).toEqual([]);
      await page.setViewportSize({width: 1280, height: 720});
      await app.getByRole('link', {name: /tableau de bord/i}).click();
    }
  }

  await page.setViewportSize({width: 390, height: 844});
  await app.getByRole('button', {name: 'English', exact: true}).click();
  await app.getByRole('menuitem', {name: 'Luganda', exact: true}).click();
  const lugandaReview = 'Ebigambo by’Oluganda bya kugezesa kwokka era tebinnakeberwa muntu omulala mu bwetwaze.';
  await page.getByRole('button', {name: 'Ebifuga okugezesa'}).click();
  const controls = page.getByRole('dialog', {name: 'Ebifuga okugezesa'});
  await expect(controls.getByText(lugandaReview)).toBeVisible();
  await controls.getByRole('button', {name: 'Laba ng’ekigazi'}).click();
  await expect(controls.getByText(lugandaReview)).toBeVisible();
  await controls.getByRole('button', {name: 'Ggalawo'}).click();
  expect(await page.locator('body').evaluate(element => element.classList.contains('expanded'))).toBe(true);
});

test('native confirmation preserves an enabled schedule on cancel and disables it on accept', async ({page}) => {
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const frame = page.frameLocator('#app');
  expect(await page.locator('#app').getAttribute('sandbox')).toContain('allow-modals');
  const zone = frame.locator('#irrigation-zone-1');
  await zone.getByRole('button', {name: 'Trigger-based irrigation'}).click();
  const scheduleEnabled = zone.getByRole('button', {name: 'On', exact: true});
  await expect(scheduleEnabled).toBeVisible();
  await expect(zone.getByLabel('Threshold (kPa)')).toHaveValue('30');
  await zone.getByRole('button', {name: 'Save schedule'}).click();
  await expect(zone.getByText('Saved.', {exact: true})).toBeVisible();
  const initialMetric = await zone.getByLabel('Sensor').inputValue();
  const initialThreshold = await zone.getByLabel('Threshold (kPa)').inputValue();

  await frame.getByRole('link', {name: /settings/i}).click();
  const scheduler = frame.getByRole('region', {name: 'Modules'}).getByRole('group', {name: 'Trigger-based irrigation', exact: true});
  const dismissDialog = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('confirm');
    await dialog.dismiss();
  });
  await scheduler.getByRole('button', {name: 'Off', exact: true}).click();
  await dismissDialog;
  await expect(scheduler.getByRole('button', {name: 'On', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await frame.getByRole('link', {name: /dashboard/i}).click();
  await zone.getByRole('button', {name: 'Trigger-based irrigation'}).click();
  await expect(zone.getByRole('button', {name: 'On', exact: true})).toBeVisible();
  await expect(zone.getByLabel('Sensor')).toHaveValue(initialMetric);
  await expect(zone.getByLabel('Threshold (kPa)')).toHaveValue(initialThreshold);

  await frame.getByRole('link', {name: /settings/i}).click();
  const acceptDialog = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('confirm');
    await dialog.accept();
  });
  await scheduler.getByRole('button', {name: 'Off', exact: true}).click();
  await acceptDialog;
  await expect(frame.getByText('Disabled 1 active schedule.', {exact: true})).toBeVisible({timeout: 10_000});
  await expect(scheduler.getByRole('button', {name: 'Off', exact: true})).toHaveAttribute('aria-pressed', 'true');

  await scheduler.getByRole('button', {name: 'On', exact: true}).click();
  await expect(scheduler.getByRole('button', {name: 'On', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await frame.getByRole('link', {name: /dashboard/i}).click();
  await zone.getByRole('button', {name: 'Trigger-based irrigation'}).click();
  await expect(zone.getByRole('button', {name: 'Off', exact: true})).toBeVisible();
  await expect(zone.getByLabel('Sensor')).toHaveValue(initialMetric);
  await expect(zone.getByLabel('Threshold (kPa)')).toHaveValue(initialThreshold);

  await page.setViewportSize({width: 1280, height: 420});
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  const tools = page.getByRole('dialog', {name: 'Simulation controls'});
  const clockSpeed = tools.getByLabel('Clock speed');
  await clockSpeed.focus();
  await expect(clockSpeed).toBeFocused();
  const dialogBounds = await tools.evaluate(element => {
    const dialog = element.getBoundingClientRect();
    const input = element.querySelector('select')!.getBoundingClientRect();
    return {dialog: {top: dialog.top, bottom: dialog.bottom}, input: {left: input.left, right: input.right, top: input.top, bottom: input.bottom},
      width: innerWidth, height: innerHeight};
  });
  expect(dialogBounds.dialog.top).toBeGreaterThanOrEqual(-1);
  expect(dialogBounds.dialog.bottom).toBeLessThanOrEqual(dialogBounds.height + 1);
  expect(dialogBounds.input.left).toBeGreaterThanOrEqual(-1);
  expect(dialogBounds.input.right).toBeLessThanOrEqual(dialogBounds.width + 1);
  expect(dialogBounds.input.top).toBeGreaterThanOrEqual(-1);
  expect(dialogBounds.input.bottom).toBeLessThanOrEqual(dialogBounds.height + 1);
});

test('a persisted app page resumes simulation time without charging suspended time', async ({page}) => {
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const app = page.frameLocator('#app');
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  const controls = page.getByRole('dialog', {name: 'Simulation controls'});
  await controls.getByLabel('Clock speed').selectOption('60');
  await controls.getByRole('button', {name: 'Close', exact: true}).click();

  const simulatedTime = () => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.Date.now());
  const initial = await simulatedTime();
  await expect.poll(simulatedTime, {timeout: 5_000}).toBeGreaterThan(initial + 120_000);

  const dispatchLifecycle = (type: 'pagehide' | 'pageshow') => app.locator('body').evaluate((body, lifecycleType) => {
    const view = body.ownerDocument.defaultView!;
    view.dispatchEvent(new view.PageTransitionEvent(lifecycleType, {persisted: true}));
  }, type);

  await dispatchLifecycle('pagehide');
  const suspendedAt = await simulatedTime();
  await page.waitForTimeout(1_200);
  expect(await simulatedTime()).toBe(suspendedAt);

  await dispatchLifecycle('pageshow');
  await expect.poll(simulatedTime, {timeout: 5_000}).toBeGreaterThan(suspendedAt);
  const firstResume = await simulatedTime();
  expect(firstResume - suspendedAt, 'resumed time excludes wall time spent suspended').toBeLessThan(30_000);

  await dispatchLifecycle('pagehide');
  const secondSuspendedAt = await simulatedTime();
  await page.waitForTimeout(500);
  expect(await simulatedTime()).toBe(secondSuspendedAt);
  await dispatchLifecycle('pageshow');
  await expect.poll(simulatedTime, {timeout: 5_000}).toBeGreaterThan(secondSuspendedAt);
  const secondResume = await simulatedTime();
  expect(secondResume - secondSuspendedAt, 'a second persisted cycle also excludes suspended time').toBeLessThan(30_000);

  await page.getByRole('button', {name: 'Simulation controls'}).click();
  const resumedControls = page.getByRole('dialog', {name: 'Simulation controls'});
  await resumedControls.getByRole('button', {name: 'Pause time'}).click();
  await expect(resumedControls.getByRole('button', {name: 'Pause time'})).toHaveAttribute('aria-pressed', 'true');
  await resumedControls.getByRole('button', {name: 'Close', exact: true}).click();
  await dispatchLifecycle('pagehide');
  await dispatchLifecycle('pageshow');
  const pausedAt = await simulatedTime();
  await page.waitForTimeout(1_200);
  expect(await simulatedTime()).toBe(pausedAt);
});

test('native History, valve command, focused draft, and exact reset survive layout changes', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const app = page.frameLocator('#app');
  const sourceUrl = await page.locator('#app').getAttribute('src');
  const initialClock = await page.locator('#simulated-time').getAttribute('datetime');
  expect(initialClock).toBeTruthy();
  const compactGeometry = await page.locator('.phone-space').boundingBox();
  expect(compactGeometry).not.toBeNull();
  const historyLink = app.locator('#irrigation-zone-1').getByRole('link', {name: 'Data', exact: true});
  await expect(historyLink).toBeVisible();
  await historyLink.click();
  await expect.poll(() => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.location.hash))
    .toBe('#/history/zones/1');
  const expectHistoryPresentation = async () => {
    await expect(app.getByRole('heading', {name: /Tomato plot/i})).toBeVisible({timeout: 20_000});
    await expect(app.getByTestId('history-visualization-surface')).toBeVisible();
  };
  await expectHistoryPresentation();
  const historyBounds = await app.locator('body').evaluate(body => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    outOfBounds: [...body.querySelectorAll('h1,h2,h3,p,label,button,a,input,select,[role="button"]')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    }).map(element => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 50)),
  }));
  expect(historyBounds.scroll).toBeLessThanOrEqual(historyBounds.width);
  expect(historyBounds.outOfBounds).toEqual([]);

  await page.getByRole('button', {name: 'Simulation controls'}).click();
  await page.getByRole('button', {name: 'Expanded view'}).click();
  await page.getByRole('button', {name: 'Close', exact: true}).click();
  await expectHistoryPresentation();
  expect(await page.locator('#app').getAttribute('src')).toBe(sourceUrl);
  const expandedHistoryBounds = await app.locator('body').evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
  expect(expandedHistoryBounds.scroll).toBeLessThanOrEqual(expandedHistoryBounds.width);
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  await page.getByRole('button', {name: 'Phone view'}).click();
  await page.getByRole('button', {name: 'Close', exact: true}).click();

  await app.locator('body').evaluate(body => body.ownerDocument.defaultView!.history.back());
  await expect.poll(() => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.location.hash))
    .toBe('#/dashboard');
  await expect(app.getByRole('button', {name: /Tomato plot/})).toBeVisible();
  await app.getByRole('link', {name: /settings/i}).click();
  await app.getByRole('button', {name: 'Dark', exact: true}).click();
  await app.getByLabel('Gateway time zone').fill('Europe/Zurich');
  await app.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(app.getByText('Time zone saved', {exact: true})).toBeVisible();
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  await app.getByRole('link', {name: /dashboard/i}).click();
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  await page.getByLabel('Clock speed').selectOption('60');
  await expect(page.locator('#simulated-time')).not.toHaveAttribute('datetime', initialClock!, {timeout: 5_000});
  await page.getByLabel('Clock speed').selectOption('1');
  await page.getByRole('button', {name: 'Pause time'}).click();
  await page.getByRole('button', {name: 'Close', exact: true}).click();

  const zone = app.locator('#irrigation-zone-1');
  await zone.getByRole('button', {name: 'Devices in this zone:'}).click();
  const valve = app.getByTestId('valve-last-seen').locator('..').filter({has: app.getByRole('heading', {name: 'Tomato valve', exact: true})});
  await expect(valve.getByRole('heading', {name: 'Tomato valve', exact: true})).toBeVisible();
  const valveStatus = valve.locator(':scope > div.flex.items-start.gap-3 > div.min-w-0 > p').first();
  await expect(valveStatus).toHaveText(/^Closed(?:$|\s| ·)/);
  const open = valve.getByRole('button', {name: 'Open', exact: true});
  await open.click();
  const valveOpenDialog = app.getByRole('dialog', {name: 'Open Tomato valve'});
  await expect(valveOpenDialog).toBeVisible();
  await valveOpenDialog.getByRole('button', {name: 'Open for 1 min', exact: true}).click();
  await expect(valveStatus).toHaveText(/^Waiting for valve\b/);
  await expect(valve.getByRole('button', {name: 'Cancel queued open', exact: true})).toBeVisible();
  const queuedAt = Date.parse((await page.locator('#simulated-time').getAttribute('datetime')) ?? '');
  expect(Number.isFinite(queuedAt)).toBe(true);
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  await page.getByRole('button', {name: 'Advance to next event'}).click();
  await page.getByRole('button', {name: 'Close', exact: true}).click();
  await expect(page.locator('#simulated-time')).not.toHaveAttribute('datetime', new Date(queuedAt).toISOString());
  await expect(valveStatus).toHaveText(/^Open(?:$|\s| ·)/);
  await expect(valve.locator('.valve-glyph--open')).toBeVisible();
  await expect(valve.getByRole('button', {name: 'Cancel queued open', exact: true})).toHaveCount(0);

  await zone.getByRole('button', {name: 'Configure'}).click();
  const configHeading = app.getByRole('heading', {name: /Configure zone/});
  await expect(configHeading).toBeVisible();
  const draft = app.getByRole('textbox', {name: 'Variety'});
  await draft.fill('Continuity draft');
  await draft.focus();

  await page.setViewportSize({width: 390, height: 844});
  await expect(page.locator('.phone-frame')).toBeVisible();
  await expect(page.locator('.phone-frame')).toHaveCSS('border-left-width', '0px');
  await expect(configHeading).toBeVisible();
  await expect(draft).toHaveValue('Continuity draft');
  await expect(draft).toBeFocused();
  await expect(valveStatus).toHaveText(/^Open(?:$|\s| ·)/);
  await page.setViewportSize({width: 844, height: 390});
  await expect(draft).toHaveValue('Continuity draft');
  await expect(draft).toBeFocused();
  await expect(valveStatus).toHaveText(/^Open(?:$|\s| ·)/);
  await page.setViewportSize({width: 1280, height: 900});
  await expect(draft).toBeFocused();
  await expect(valveStatus).toHaveText(/^Open(?:$|\s| ·)/);
  await page.getByRole('button', {name: 'Simulation controls'}).click();
  await page.getByRole('button', {name: 'Expanded view'}).click();
  await page.getByRole('button', {name: 'Close', exact: true}).click();
  const toolsTrigger = page.getByRole('button', {name: 'Simulation controls'});
  await expect(toolsTrigger).toBeFocused();
  await expect(page.locator('.phone-frame')).toBeVisible();
  await expect(page.locator('.phone-frame')).not.toHaveCSS('border-left-width', '0px');
  await expect(configHeading).toBeVisible();
  await expect(draft).toHaveValue('Continuity draft');
  await draft.focus();
  await expect(draft).toBeFocused();
  await expect(valveStatus).toHaveText(/^Open(?:$|\s| ·)/);
  expect(await page.locator('#app').getAttribute('src')).toBe(sourceUrl);
  expect(await page.locator('#host-notice').textContent()).toBe('');

  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  const beforeResetAuth = await app.locator('body').evaluate(() => localStorage.getItem('auth_token'));
  expect(beforeResetAuth).toBe('public-demo-session');
  await page.locator('#reset').click();
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  await expect(page.locator('#page-title')).toHaveText('Explore OSI OS');
  expect(await page.locator('#app').getAttribute('src')).not.toBe(sourceUrl);
  expect(await page.locator('body').evaluate(element => element.classList.contains('expanded'))).toBe(false);
  const resetGeometry = await page.locator('.phone-space').boundingBox();
  expect(resetGeometry!.width).toBeCloseTo(compactGeometry!.width, 1);
  expect(resetGeometry!.height).toBeCloseTo(compactGeometry!.height, 1);
  const resetClock = Date.parse((await page.locator('#simulated-time').getAttribute('datetime')) ?? '');
  const publicSeedEpoch = Date.parse('2026-10-10T02:59:50.000Z');
  expect(resetClock).toBeGreaterThanOrEqual(publicSeedEpoch);
  expect(resetClock).toBeLessThan(publicSeedEpoch + 60_000);
  await expect(page.locator('#speed')).toHaveValue('1');
  await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await app.locator('body').evaluate(() => localStorage.getItem('auth_token'))).toBe('public-demo-session');
  await app.getByRole('button', {name: 'Tomato plot'}).waitFor();
  await app.getByRole('button', {name: 'Devices in this zone:'}).click();
  const resetValve = app.getByTestId('valve-last-seen').locator('..').filter({has: app.getByRole('heading', {name: 'Tomato valve', exact: true})});
  await expect(resetValve.getByRole('heading', {name: 'Tomato valve', exact: true})).toBeVisible();
  const resetValveStatus = resetValve.locator(':scope > div.flex.items-start.gap-3 > div.min-w-0 > p').first();
  await expect(resetValveStatus).toHaveText(/^Closed(?:$|\s| ·)/);
  await expect(resetValve.getByRole('button', {name: 'Cancel queued open', exact: true})).toHaveCount(0);
  await expect(resetValve.locator('.valve-glyph--open')).toHaveCount(0);
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await expect(app.getByTestId('water-flow-meter-tile')).toContainText('0 L');
  await expect(app.getByTestId('water-soil-tile')).toContainText('45.0 kPa');
  await expect(app.getByRole('heading', {name: /Configure zone/})).toHaveCount(0);
  await app.getByRole('link', {name: /settings/i}).click();
  await expect(app.locator('#gateway-timezone')).toHaveValue('Africa/Kampala');
});

test('mobile user agent keeps native History and responsive navigation', async ({browser}) => {
  const context = await browser.newContext({
    viewport: {width: 390, height: 844},
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  const app = page.frameLocator('#app');
  await app.locator('body').evaluate(() => { location.hash = '#/history'; });
  await expect(app.getByRole('heading', {name: /^History$/i})).toBeVisible({timeout: 20_000});
  const mobileHistory = app.getByTestId('history-mobile-shell');
  await expect(mobileHistory).toBeVisible();
  const openHistory = mobileHistory.getByRole('link', {name: 'Open Soil Moisture history', exact: true});
  await expect(openHistory).toBeVisible();
  await expect(openHistory).toHaveAttribute('href', /history\/zones\/1\/cards\//);
  const mobileHistoryBounds = await app.locator('body').evaluate(body => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    outOfBounds: [...body.querySelectorAll('h1,h2,h3,p,label,button,a,input,select')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    }).map(element => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40)),
  }));
  expect(mobileHistoryBounds.scroll).toBeLessThanOrEqual(mobileHistoryBounds.width);
  expect(mobileHistoryBounds.outOfBounds).toEqual([]);
  await openHistory.click();
  await expect(app.getByTestId('history-visualization-surface')).toBeVisible();
  await app.locator('body').evaluate(body => body.ownerDocument.defaultView!.history.back());
  await expect.poll(() => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.location.hash))
    .toBe('#/history');
  await app.locator('body').evaluate(body => body.ownerDocument.defaultView!.history.back());
  await expect.poll(() => app.locator('body').evaluate(body => body.ownerDocument.defaultView!.location.hash))
    .toBe('#/dashboard');
  await expect(app.getByRole('button', {name: /Tomato plot/})).toBeVisible();
  const tomatoValve = app.getByTestId('valve-last-seen').locator('..').filter({has: app.getByRole('heading', {name: 'Tomato valve', exact: true})});
  await expect(tomatoValve).toBeVisible();
  const valveActions = tomatoValve.getByTestId('valve-actions').getByRole('button');
  await expect(valveActions).toHaveCount(3);
  const nativeTouchTargets = await valveActions.evaluateAll(elements => elements.map(element => ({
    name: element.getAttribute('aria-label') || element.textContent?.trim(),
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  })));
  for (const target of nativeTouchTargets) {
    expect(target.width, `${target.name} native touch target width`).toBeGreaterThanOrEqual(44);
    expect(target.height, `${target.name} native touch target height`).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});

test('retry waits for committed app readiness after a blocked initial app chunk', async ({page}) => {
  await page.route(/\/assets\/mount[^/]*\.js(?:\?.*)?$/, route => route.abort());
  await page.goto('/simulator/');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#loading')).toBeVisible();
  await expect(page.locator('#retry')).toBeHidden();
  await page.evaluate(() => window.postMessage({channel: 'osi-mobile-simulator-v1', type: 'ready'}, location.origin));
  await page.waitForTimeout(500);
  await expect(page.locator('#retry')).toBeHidden();
  await expect(page.locator('#retry')).toBeVisible({timeout: 17_000});

  await page.unrouteAll();
  await page.getByRole('button', {name: 'Retry'}).click();
  await expect(page.locator('#loading')).toBeHidden({timeout: 20_000});
  await expect(page.frameLocator('#app').getByRole('button', {name: /Tomato plot/})).toBeVisible();
});
