import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{await page.goto('/');});

test('expanded valve device keeps a readable title and translated actions keep whole words',async({page})=>{
  const app=page.frameLocator('#app');
  await app.getByRole('button',{name:/Tomato plot.*devices/}).click();
  await app.getByRole('button',{name:/Devices in this zone/}).click();
  const title=app.getByRole('heading',{name:'Tomato valve',exact:true}).first();
  const size=await title.evaluate(el=>({width:el.clientWidth,height:el.clientHeight}));
  expect(size.width).toBeGreaterThan(80);expect(size.height).toBeLessThan(50);
  await app.getByRole('button',{name:'English',exact:true}).click();
  await app.getByRole('menuitem',{name:'Français',exact:true}).click();
  const schedule=app.getByRole('button',{name:'Programmer',exact:true});
  expect(await schedule.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;})).toBe(1);
});

test('create form has padding, initial focus and feedback; collapsed zone can be deleted',async({page})=>{
  const app=page.frameLocator('#app');
  await app.getByRole('button',{name:/^Add/}).click();await app.getByRole('menuitem',{name:'Add Zone',exact:true}).click();
  await expect(app.getByLabel('Zone Name')).toBeFocused();
  expect(await app.getByRole('button',{name:'Create Irrigation Zone',exact:true}).evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThanOrEqual(12);
  await app.getByLabel('Zone Name').fill('Polish trial');await app.getByRole('button',{name:'Create Irrigation Zone',exact:true}).click();
  const toggle=app.getByRole('button',{name:/Polish trial.*devices/});
  await expect(toggle).toBeFocused();await expect(toggle).toBeInViewport();
  await expect(toggle).toHaveAttribute('aria-expanded','false');
  await toggle.locator('xpath=../..').getByRole('button',{name:'Delete',exact:true}).click();
  await expect(app.getByRole('button',{name:'Yes, Delete',exact:true})).toBeVisible();
  await app.getByRole('button',{name:'Yes, Delete',exact:true}).click();await expect(toggle).toHaveCount(0);
});

test('demo account actions preserve the session and give dismissible feedback',async({page})=>{
  const app=page.frameLocator('#app');
  for(const action of ['Logout','OSI Server']) {
    await app.getByRole('button',{name:/Account/}).click();await app.getByRole('menuitem',{name:action,exact:true}).click();
    await expect(app.getByRole('heading',{name:'OSI OS Dashboard',exact:true})).toBeVisible();
    await expect(page.locator('#host-notice')).toContainText('not simulated');
    await page.getByRole('button',{name:'Dismiss notice',exact:true}).click();await expect(page.locator('#host-notice')).toBeEmpty();
  }
});

test('accelerated opening never displays more time than requested',async({page})=>{
  const app=page.frameLocator('#app');await app.getByRole('button',{name:'Open',exact:true}).waitFor();
  await page.getByRole('combobox',{name:'Simulation speed'}).selectOption('10');await page.waitForTimeout(800);
  await app.getByRole('button',{name:'Open',exact:true}).click();await app.getByRole('spinbutton').fill('1');
  await app.getByRole('button',{name:'Open for 1 min',exact:true}).click();
  const tile=app.getByTestId('valve-last-seen').locator('..');
  await expect(tile).toContainText('min left');
  await expect(tile).not.toContainText('2 min left');
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByText('Paused — commands wait until Resume.',{exact:true})).toBeVisible();
});

test('chart and valve dialogs contain keyboard focus and restore their openers',async({page})=>{
  const app=page.frameLocator('#app');
  await app.getByRole('button',{name:/Tomato plot.*devices/}).click();await app.getByRole('button',{name:/Devices in this zone/}).click();
  const opener=app.getByRole('button',{name:'56.0 kPa',exact:true});await opener.click();
  const dialog=app.getByRole('dialog');await expect(dialog).toHaveAccessibleName(/20 cm/i);
  const first=dialog.getByRole('button').first(),last=dialog.getByRole('button').last();
  await last.focus();await last.press('Tab');await expect(first).toBeFocused();
  await first.press('Escape');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
  const open=app.getByRole('button',{name:'Open',exact:true});await open.click();
  await expect(dialog.getByRole('spinbutton')).toBeFocused();
  await dialog.getByRole('spinbutton').press('Escape');await expect(open).toBeFocused();
});

test('language menu supports keyboard selection and Escape',async({page})=>{
  const app=page.frameLocator('#app'),trigger=app.getByRole('button',{name:'English',exact:true});
  await trigger.press('ArrowDown');await expect(app.getByRole('menu')).toBeVisible();
  await app.getByRole('menuitem',{name:'English',exact:true}).press('ArrowDown');
  await expect(app.getByRole('menuitem',{name:'Deutsch',exact:true})).toBeFocused();
  await app.getByRole('menuitem',{name:'Deutsch',exact:true}).press('Escape');await expect(trigger).toBeFocused();await expect(app.getByRole('menu')).toHaveCount(0);
});

test('enlargement makes text larger at 720p without replacing the frame or losing state',async({page})=>{
  await page.setViewportSize({width:1280,height:720});const app=page.frameLocator('#app');
  await app.getByRole('button',{name:/Tomato plot.*devices/}).click();
  const frame=page.frames().find(f=>f.url().includes('/demo/app.html'))!;
  await page.getByRole('button',{name:'Enlarge demo'}).click();
  expect(page.frames().find(f=>f.url().includes('/demo/app.html'))).toBe(frame);
  const scale=await page.locator('.phone').evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).a);expect(scale).toBeGreaterThanOrEqual(1);
  const phone=await page.locator('.phone-space').boundingBox(),controls=await page.locator('.controls').boundingBox();
  expect(phone!.y+phone!.height).toBeLessThanOrEqual(720);expect(controls!.x).toBeGreaterThan(phone!.x+phone!.width);
  expect(await frame.evaluate(()=>innerHeight)).toBeLessThan(844);
  await page.getByRole('button',{name:'Return to slide'}).click();
  expect(await frame.evaluate(()=>({width:innerWidth,height:innerHeight}))).toEqual({width:390,height:844});
  await expect(app.getByRole('button',{name:/Tomato plot.*devices/})).toHaveAttribute('aria-expanded','true');
});

for(const zone of ['Europe/Zurich','America/Los_Angeles'])test.describe(zone,()=>{
  test.use({timezoneId:zone});
  test('demo timestamps consistently use the farm timezone',async({page})=>{
    const app=page.frameLocator('#app');await app.getByRole('button',{name:/Tomato plot.*devices/}).click();
    await expect(app.getByTestId('water-today-card')).toContainText('Updated 12:00 PM');
    await app.getByRole('button',{name:'Open',exact:true}).click();await expect(app.getByRole('dialog')).toContainText('12:01 PM');
  });
});

test('opening the app directly retains unsupported-action feedback',async({page})=>{
  await page.goto('/demo/app.html#/dashboard');
  await page.getByRole('button',{name:/Account/}).click();
  await page.getByRole('menuitem',{name:'Logout',exact:true}).click();
  await expect(page.getByRole('heading',{name:'OSI OS Dashboard',exact:true})).toBeVisible();
  await expect(page.locator('#demo-notice')).toContainText('not simulated');
  await page.locator('#demo-notice').click();await expect(page.locator('#demo-notice')).toBeHidden();
});
