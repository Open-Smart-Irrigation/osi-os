import {expect, test, type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

declare global {
  interface Window {
    farmFastForward?: boolean;
    farmCspViolations?: string[];
  }
}

// The production loop still handles every tick. Skip the real-time wait for 18:00.
function instrumentPage() {
  window.farmCspViolations = [];
  document.addEventListener('securitypolicyviolation', event =>
    window.farmCspViolations!.push(event.effectiveDirective + ' ' + event.blockedURI));
  const request = window.requestAnimationFrame.bind(window);
  let extra = 0;
  window.requestAnimationFrame = callback => request(now => {
    if (window.farmFastForward) extra += 400;
    callback(now + extra);
  });
}

// The renderer publishes its logical view size and camera position on the canvas
// (src/view/renderer.ts), so a tap lands on the tile's middle at any view size and camera.
async function tapTile(page: Page, x: number, y: number) {
  const canvas = page.getByLabel('Farm view');
  const [screen, size, camera] = await Promise.all([
    canvas.boundingBox(), canvas.getAttribute('data-view'), canvas.getAttribute('data-camera'),
  ]);
  if (!screen || !size || !camera) throw new Error('Farm canvas unavailable');
  const [width, height] = size.split('x').map(Number);
  const [left, top] = camera.split(',').map(Number);
  const viewX = (x + .5) * 16 - left;
  const viewY = (y + .5) * 16 - top;
  if (!(viewX >= 0 && viewX < width && viewY >= 0 && viewY < height)) {
    throw new Error(`Tile ${x}, ${y} is outside the ${size} view at camera ${camera}`);
  }
  await page.touchscreen.tap(screen.x + viewX * screen.width / width, screen.y + viewY * screen.height / height);
}

// Logical view size and zoom: the canvas backing store is a whole multiple of the view, and the
// canvas shows it one device pixel per backing pixel.
function zoomOf(canvas: HTMLCanvasElement) {
  const [width, height] = canvas.dataset.view!.split('x').map(Number);
  const box = canvas.getBoundingClientRect();
  return {
    view: canvas.dataset.view, x: canvas.width / width, y: canvas.height / height,
    shown: [Math.round(box.width * devicePixelRatio) - canvas.width, Math.round(box.height * devicePixelRatio) - canvas.height],
  };
}

test.use({viewport: {width: 412, height: 760}, deviceScaleFactor: 2, hasTouch: true, isMobile: true});

test('built farm boots, walks, picks, pumps, waters in two ways and wakes on day two', async ({page}, testInfo) => {
  const target = process.env.FARM_SIM_E2E_ARTIFACTS ?? testInfo.outputPath('screenshots');
  await mkdir(target, {recursive: true});
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith(testInfo.project.use.baseURL!)) offsite.push(request.url());
  });
  await page.addInitScript(instrumentPage);
  await page.goto('./index.html');
  await expect(page.getByText('Day 1', {exact: false})).toBeVisible();
  await expect(page.getByLabel('Movement stick')).toBeVisible();
  // Portrait layout: the farm view spans at least 95 % of the width and ends above the tool row.
  const farmView = page.getByLabel('Farm view');
  const viewportWidth = page.viewportSize()!.width;
  await expect.poll(async () => (await farmView.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(.95 * viewportWidth);
  const view = await farmView.boundingBox();
  const tools = await page.getByLabel('Tools', {exact: true}).boundingBox();
  if (!view || !tools) throw new Error('Farm view or tool row unavailable');
  expect(view.y + view.height).toBeLessThanOrEqual(tools.y);
  // Whole-number zoom in portrait too: 824 device px across take zoom 3, 274 logical px (plan 7.3).
  const portrait = await farmView.evaluate(zoomOf);
  expect(portrait).toMatchObject({x: 3, y: 3, shown: [0, 0]});
  expect(portrait.view).toMatch(/^274x\d+$/);
  expect(Number(portrait.view!.split('x')[1])).toBeGreaterThan(270);
  // A short portrait screen takes height from the view first: Sleep stays on screen, and the view
  // still ends above the tool row. Then the test goes back to 412 x 760.
  const sleep = page.getByRole('button', {name: 'Sleep'});
  const toolRow = page.getByLabel('Tools', {exact: true});
  for (const size of [{width: 360, height: 560}, {width: 412, height: 600}]) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const button = await sleep.boundingBox();
      return button ? button.y + button.height : Infinity;
    }, {message: 'Sleep at ' + size.width + ' x ' + size.height}).toBeLessThanOrEqual(size.height);
    await expect.poll(async () => {
      const [shortView, shortTools] = await Promise.all([farmView.boundingBox(), toolRow.boundingBox()]);
      return shortView && shortTools && shortView.height > 0 ? shortTools.y - (shortView.y + shortView.height) : -1;
    }, {message: 'Farm view above the tool row at ' + size.width + ' x ' + size.height}).toBeGreaterThanOrEqual(0);
  }
  await page.setViewportSize({width: 412, height: 760});
  // The width is the same at 412 x 600, so wait for the view to regain its height.
  await expect(farmView).toHaveAttribute('data-view', portrait.view!);
  expect(await farmView.evaluate(zoomOf)).toEqual(portrait);
  await page.screenshot({path: join(target, '01-day-one.png')});

  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(125);
  await page.keyboard.up('ArrowRight');
  await page.getByRole('button', {name: 'Basket'}).tap();
  // Bed A's south-west tile (12, 10).
  await tapTile(page, 12, 10);
  // One tile's seeded ripe batch: 27 g (plan 6.6).
  await expect(page.getByTestId('picked')).toHaveText('0.03');

  // One pump stroke adds 20 L to the tutorial's 300 L tank (plan 6.5, 6.6).
  await page.getByRole('button', {name: 'Pump'}).tap();
  await expect(page.getByTestId('tank-litres')).toHaveText('320');
  await page.getByRole('button', {name: 'Fill can'}).tap();
  await expect(page.getByRole('button', {name: 'Watering can'})).toHaveText(/10 L/);
  await page.getByRole('button', {name: 'Watering can'}).tap();
  await page.getByRole('button', {name: 'Feel soil'}).tap();
  await expect(page.getByRole('status')).toHaveText(/soil feels/);
  await tapTile(page, 12, 10);
  await expect(page.getByTestId('litres-used')).toHaveText('2.0');

  await page.getByRole('button', {name: 'Open tap'}).tap();
  await expect(page.getByRole('button', {name: 'Close tap'})).toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('litres-used').textContent())).toBeGreaterThan(3);
  await page.screenshot({path: join(target, '02-water-and-harvest.png')});
  await page.getByRole('button', {name: 'Close tap'}).tap();
  await expect(page.getByRole('button', {name: 'Open tap'})).toBeVisible();

  await page.evaluate(() => { window.farmFastForward = true; });
  await expect(page.getByRole('button', {name: 'Sleep'})).toBeEnabled({timeout: 60_000});
  await page.evaluate(() => { window.farmFastForward = false; });
  await page.getByRole('button', {name: 'Sleep'}).tap();
  const bedtime = page.getByRole('region', {name: 'Bedtime card'});
  await expect(bedtime).toBeVisible();
  await expect(page.locator('time')).toHaveText('05:50');
  await expect(bedtime.locator('dt')).toHaveText(['Litres applied', 'Kilograms picked', 'Energy left']);
  await page.screenshot({path: join(target, '03-bedtime.png')});

  await page.getByRole('button', {name: 'Wake at 05:50'}).tap();
  await expect(page.getByText('Day 2', {exact: false})).toBeVisible();
  await page.screenshot({path: join(target, '04-day-two.png')});
  expect(await page.evaluate(() => window.farmCspViolations)).toEqual([]);
  expect(offsite).toEqual([]);
  expect(errors).toEqual([]);
});

test('the T3 host mounts lazily, dispatches a phone write and freezes its clock when lowered', async ({page}) => {
  await page.goto('./index.html?facilitator');
  const panel = page.getByRole('region', {name: 'Facilitator'});
  await panel.getByLabel('Tier').selectOption('3');
  await panel.getByRole('button', {name: 'Start new run'}).tap();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', {name: 'Raise phone'}).tap();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
  const during = await page.evaluate(() => {
    const port = window.farmSimPhone!;
    const at = port.phoneNow();
    const read = port.request('GET', '/api/devices', undefined);
    const write = port.request('POST', '/api/valve/00000000000000B3', {action: 'OPEN_FOR_DURATION', duration_seconds: 600});
    return {at, read: read.status, write: write.status};
  });
  expect(during.read).toBe(200);
  expect(during.write).toBeLessThan(400);
  await expect(page.getByTestId('litres-used')).toHaveText('0.0');
  await page.getByRole('button', {name: 'Lower phone'}).tap();
  await expect.poll(async () => Number(await page.getByTestId('litres-used').textContent())).toBeGreaterThan(0);
  await expect(page.locator('iframe')).toBeHidden();
  const after = await page.evaluate(() => {
    const port = window.farmSimPhone!;
    const response = port.request('GET', '/api/devices', undefined);
    return {at: port.phoneNow(), open: port.isOpen(), status: response.status};
  });
  expect(after).toEqual({at: during.at, open: false, status: 200});
});
