import {test, expect} from '@playwright/test';
let pageErrors: string[] = [];
let outsideRequests: string[] = [];
test.beforeEach(async ({page}) => {
  pageErrors = []; outsideRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4173/') && !request.url().startsWith('data:')) outsideRequests.push(request.url());
  });
});
test.afterEach(() => {expect(pageErrors).toEqual([]); expect(outsideRequests).toEqual([]);});


test('real app starts with fictional farm, two zones, offline translations', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const external: string[] = []; page.on('request', r => {if (!r.url().startsWith('http://127.0.0.1:4173/')) external.push(r.url());});
  await page.goto('/');
  const app = page.frameLocator('#app');
  await expect(app.getByRole('button', {name: /Tomato plot.*devices/})).toBeVisible();
  await expect(app.getByRole('button', {name: /Demonstration bed.*device/})).toBeVisible();
  await page.screenshot({path: 'demo/screenshots/overview.png'});
  await app.getByRole('button', {name: 'English'}).click();
  await app.getByRole('button', {name: 'Français', exact: true}).click();
  await expect(app.getByRole('button', {name: 'Français'})).toBeVisible();
  await page.screenshot({path: 'demo/screenshots/french.png'});
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('zone creation, assignment, removal and language preserve existing farm', async ({page}) => {
  await page.goto('/'); const app = page.frameLocator('#app');
  await app.getByRole('button', {name: /^Add/}).click();
  await app.getByRole('menuitem', {name: /Zone/}).click();
  await app.getByLabel('Zone Name').fill('Temporary bed');
  // Change language while a real form remains mounted, preserving its value.
  // Modal blocks pointer interaction with the toolbar; use the app normally before/after instead.
  await app.getByRole('button', {name: 'Create Irrigation Zone', exact:true}).click();
  await expect(app.getByRole('button', {name: /Temporary bed.*devices/})).toBeVisible();
  // Locate the zone card using its real heading, then its enclosing card container.
  const card = app.getByRole('button', {name: /Temporary bed/}).locator('xpath=../..');
  await card.getByRole('button', {name: '+ Device', exact:true}).click();
  await app.getByRole('combobox').selectOption('00000000000000A3');
  await app.getByRole('button', {name: 'Assign Device', exact:true}).click();
  await expect(app.getByRole('button', {name: /Temporary bed.*1 device/})).toBeVisible();
  await app.getByRole('button', {name: /Temporary bed.*1 device/}).click();
  await app.getByRole('button', {name:'English'}).click();
  await app.getByRole('button', {name:'Français', exact:true}).click();
  await expect(app.getByRole('button', {name:/Temporary bed/})).toHaveAttribute('aria-expanded','true');
  await app.getByRole('button', {name:'Français'}).click();await app.getByRole('button', {name:'English', exact:true}).click();
  await card.getByRole('button', {name:'Delete', exact:true}).click();
  await app.getByRole('button', {name: /Yes, Delete/}).click();
  await expect(app.getByRole('button', {name:/Temporary bed/})).toHaveCount(0);
  await expect(app.getByText('Spare demonstration probe', {exact:true})).toBeVisible();
  await expect(app.getByRole('button', {name:/Tomato plot.*3 devices/})).toBeVisible();
});

test('water card, real sensor charts and three status categories', async ({page}) => {
  await page.goto('/'); const app=page.frameLocator('#app');
  await app.getByRole('button', {name:/Tomato plot.*devices/}).click();
  await expect(app.getByTestId('water-rain-tile')).toContainText('0.0 mm');
  await expect(app.getByTestId('water-flow-meter-tile')).toContainText('120 L');
  await expect(app.getByTestId('water-forecast-tile')).toHaveCount(0);
  await expect(app.getByTestId('water-action-tile')).toBeHidden();
  await expect(app.getByTestId('water-flow-meter-tile').getByText(/Estimated/)).toBeHidden();
  await expect(app.getByTestId('water-today-card')).not.toContainText('crop demand');
  await expect(app.getByTestId('water-soil-tile')).toBeHidden();
  await expect(app.getByRole('button', {name:/Environment & weather forecast/})).toHaveCount(0);
  await app.getByTestId('water-today-card').scrollIntoViewIfNeeded();
  await page.screenshot({path:'demo/screenshots/populated-zone.png'});
  await app.getByRole('button', {name:/Devices in this zone/}).click();
  await app.getByRole('button', {name:'68.0 kPa', exact:true}).click();
  await expect(app.locator('.recharts-surface').first()).toBeVisible();
  await expect(app.getByText('97 readings · last 24 h')).toBeVisible();
  await app.locator('.recharts-surface').first().hover();
  await expect(app.locator('.recharts-tooltip-wrapper').first()).toBeVisible();
  await app.getByRole('button',{name:'×',exact:true}).click();
  await app.getByRole('button',{name:/Demonstration bed.*device/}).click();
  await app.getByRole('button',{name:/Devices in this zone/}).last().click();
  await expect(app.getByTestId('water-rain-tile').last()).toContainText('6.0 mm');
  await expect(app.getByRole('button',{name:'12.0 kPa',exact:true})).toBeVisible();
  for (const [status,color] of [['wet','rgb(59, 130, 246)'],['moist','rgb(21, 128, 61)'],['dry','rgb(239, 68, 68)']]) {
    const indicator=app.locator(`[data-swt-status="${status}"]`).filter({visible:true}).first();
    await expect(indicator).toBeVisible();
    await expect(indicator.locator(':scope > span').first()).toHaveCSS('background-color',color);
  }
  await expect(page.locator('#host-notice')).toBeEmpty();
});

test('valve acknowledgement, early cancel, timed close and active reset', async ({page}) => {
  await page.goto('/'); const app=page.frameLocator('#app');
  await app.getByRole('button', {name:'Open', exact:true}).click();
  await app.getByRole('spinbutton').fill('1');

  await app.getByRole('button', {name:/Open for 1 min/}).click();
  await expect(app.getByText('Open', {exact:true}).first()).toBeVisible({timeout:10000});
  await page.screenshot({path:'demo/screenshots/open-valve.png'});
  await app.getByRole('button', {name:'More', exact:true}).click();
  await app.getByRole('menuitem', {name:'Valve settings', exact:true}).click();
  await app.getByRole('button', {name:'Close valve now'}).click();
  await app.getByRole('button', {name:'Yes, close it'}).click();
  await app.getByRole('dialog').getByRole('button', {name:'Close', exact:true}).click();
  await expect(app.getByText('Closed', {exact:true}).first()).toBeVisible();
  await app.getByRole('button', {name:'Open', exact:true}).click();
  await app.getByRole('button', {name:'Open for 1 min'}).click();
  await page.getByRole('combobox', {name:'Simulation speed'}).selectOption('10');
  await expect(app.getByText('Closed', {exact:true}).first()).toBeVisible({timeout:12000});
  await page.getByRole('combobox', {name:'Simulation speed'}).selectOption('1');
  await app.getByRole('button', {name:'Open', exact:true}).click();
  await app.getByRole('button', {name:'Open for 1 min'}).click();
  await page.getByRole('button', {name:'Reset demo'}).click();
  await expect(app.getByRole('button', {name:'English'})).toBeVisible();
  await expect(app.getByText('Closed', {exact:true}).first()).toBeVisible();
  await expect(app.getByText('No recent irrigations recorded yet.')).toBeVisible();
});

for (const size of [{width:1920,height:1080},{width:1280,height:720}]) {
  test(`layout, enlargement, scroll and offline language at ${size.width}`, async ({page,context}) => {
    await page.setViewportSize(size);await page.goto('/');const app=page.frameLocator('#app');
    await expect(app.getByRole('button',{name:/Tomato plot.*devices/})).toBeVisible();
    const frame=page.frames().find(f=>f.url().includes('/demo/app.html'))!;
    expect(await frame.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth}))).toEqual({width:390,height:844,scroll:390});
    const rect=await page.locator('.phone-space').boundingBox();expect(rect!.y).toBeGreaterThanOrEqual(0);expect(rect!.y+rect!.height).toBeLessThan(size.height);
    await app.getByRole('button',{name:/Tomato plot.*devices/}).click();
    await page.getByRole('button',{name:'Enlarge demo'}).click();
    expect(page.frames().find(f=>f.url().includes('/demo/app.html'))).toBe(frame);
    await expect(app.getByRole('button',{name:/Tomato plot/})).toHaveAttribute('aria-expanded','true');
    await page.getByRole('button',{name:'Return to slide'}).click();
    await context.setOffline(true);
    await app.getByRole('button',{name:'English'}).click();await app.getByRole('button',{name:'Français',exact:true}).click();
    await expect(app.getByTestId('water-flow-meter-tile')).toContainText('120 L');
    await app.getByRole('button',{name:/Tomato plot/}).hover();await page.mouse.wheel(0,400);
    await expect.poll(()=>frame.evaluate(()=>scrollY)).toBeGreaterThan(0);
    expect(await page.evaluate(()=>scrollY)).toBe(0);
    await page.screenshot({path:`demo/screenshots/layout-${size.width}.png`});
  });
}

test('pause, spoofed messages and storage/transport boundaries', async ({page}) => {
  const outbound:string[]=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4173/')&&!r.url().startsWith('data:'))outbound.push(r.url());});
  await page.goto('/');const app=page.frameLocator('#app');await expect(app.getByRole('button',{name:'English'})).toBeVisible();
  const frame=page.frames().find(f=>f.url().includes('/demo/app.html'))!;
  await page.evaluate(()=>localStorage.setItem('auth_token','host-sentinel'));
  expect(await frame.evaluate(()=>localStorage.getItem('auth_token'))).toBe('inert-demo-session-not-a-jwt');
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect.poll(async()=>{const a=await frame.evaluate(()=>Date.now());await page.waitForTimeout(120);return (await frame.evaluate(()=>Date.now()))-a;}).toBe(0);
  const frozen=await frame.evaluate(()=>Date.now());
  await frame.evaluate(()=>window.postMessage({channel:'osi-wasag-demo-v1',type:'active',value:true},location.origin));
  await page.waitForTimeout(200);expect(await frame.evaluate(()=>Date.now())).toBe(frozen);
  expect(await frame.evaluate(()=>+new Date())).toBe(frozen);
  const blocked=await frame.evaluate(async()=>{
    const attempts=[()=>fetch('https://example.invalid/api'),()=>new XMLHttpRequest(),()=>new WebSocket('wss://example.invalid'),()=>new EventSource('https://example.invalid/events'),()=>navigator.sendBeacon('https://example.invalid','x')];
    return Promise.all(attempts.map(async attempt=>{try{await attempt();return false;}catch{return true;}}));
  });expect(blocked).toEqual([true,true,true,true,true]);expect(outbound).toEqual([]);
  expect(await frame.evaluate(()=>new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve('unexpected location'),error=>resolve(error.code))))).toBe(2);
  await page.getByRole('button',{name:'Reset demo'}).click();await expect(app.getByRole('button',{name:'English'})).toBeVisible();
  expect(await page.evaluate(()=>localStorage.getItem('auth_token'))).toBe('host-sentinel');
});

test('reveal slide departure pauses clock, return retains state and keyboard stays in app', async ({page}) => {
  await page.goto('/demo/reveal.html');await page.getByRole('button',{name:'next slide'}).click();
  const host=page.frameLocator('#osi-demo'),app=host.frameLocator('#app');
  await expect(app.getByRole('button',{name:'English'})).toBeVisible();
  await app.getByRole('button',{name:/^Add/}).click();await app.getByRole('menuitem',{name:/Zone/}).click();
  await app.getByLabel('Zone Name').fill('Trial');await app.getByLabel('Zone Name').press('Space');await app.getByLabel('Zone Name').press('ArrowLeft');
  await expect(page).toHaveURL(/#\/1$/);await expect(app.getByLabel('Zone Name')).toHaveValue('Trial ');
  await app.getByRole('button',{name:'Cancel',exact:true}).click();
  await app.getByRole('button',{name:'Open',exact:true}).click();await app.getByRole('button',{name:'Open for 1 min'}).click();
  await expect(app.getByText('Open',{exact:true}).first()).toBeVisible({timeout:10000});
  await host.getByRole('button',{name:'Slide focus'}).click();await expect(page.locator('.reveal')).toBeFocused();await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/2$/);
  const frame=page.frames().find(f=>f.url().includes('/demo/app.html'))!;
  await page.waitForTimeout(200);const paused=await frame.evaluate(()=>Date.now());await page.waitForTimeout(1200);expect(await frame.evaluate(()=>Date.now())).toBe(paused);
  await page.keyboard.press('ArrowLeft');await expect(page).toHaveURL(/#\/1$/);
  await expect(app.getByText('Open',{exact:true}).first()).toBeVisible();
  const resumed=await frame.evaluate(()=>Date.now());await page.waitForTimeout(500);const elapsed=(await frame.evaluate(()=>Date.now()))-resumed;
  expect(elapsed).toBeGreaterThan(250);expect(elapsed).toBeLessThan(900);
});

test('existing device registration and SWT trigger configuration', async ({page}) => {
  await page.goto('/');const app=page.frameLocator('#app');
  await app.getByRole('button',{name:/^Add/}).click();await app.getByRole('menuitem',{name:'Add Device',exact:true}).click();
  await app.getByLabel('Device Name',{exact:true}).fill('Practice probe');await app.getByLabel('DevEUI',{exact:true}).fill('00000000000000B0');
  await app.getByRole('dialog').getByRole('button',{name:'Add Device',exact:true}).click();
  await expect(app.getByText('Practice probe',{exact:true})).toBeVisible();
  await app.getByRole('button',{name:/Tomato plot.*devices/}).click();
  await app.getByRole('button',{name:/Trigger-based irrigation/i}).click();
  await app.getByLabel('Threshold (kPa)').fill('70');
  await app.getByRole('button',{name:'English'}).click();await app.getByRole('button',{name:'Français',exact:true}).click();
  await expect(app.locator('#swt-threshold-1')).toHaveValue('70');
  await app.getByRole('button',{name:'Français'}).click();await app.getByRole('button',{name:'English',exact:true}).click();
  await app.getByRole('button',{name:'Save schedule',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Automatic trigger execution is not simulated');
  await app.locator('#demo-notice').click();
  await app.getByRole('button',{name:'Reload',exact:true}).click();await expect(app.getByLabel('Threshold (kPa)')).toHaveValue('70');
});


test('all shipped languages work offline and preserve the open zone', async ({page,context}) => {
  await page.goto('/');const app=page.frameLocator('#app');
  await expect(app.getByRole('heading',{name:'OSI OS Dashboard',exact:true})).toBeVisible();
  await app.getByRole('button',{name:/Tomato plot.*devices/}).click();
  await context.setOffline(true);
  let current='English';
  for(const label of ['Deutsch','Français','Italiano','Español','Português','Luganda','English']) {
    await app.getByRole('button',{name:current,exact:true}).click();
    await expect(app.locator('.demo-language').getByRole('button')).toHaveCount(8);
    await app.getByRole('button',{name:label,exact:true}).click();
    await expect(app.getByRole('button',{name:label,exact:true})).toBeVisible();
    await expect(app.getByRole('button',{name:/Tomato plot/})).toHaveAttribute('aria-expanded','true');
    await expect(app.getByTestId('water-flow-meter-tile')).toContainText('120 L');
    await expect(app.getByTestId('water-forecast-tile')).toHaveCount(0);
    current=label;
  }
});
