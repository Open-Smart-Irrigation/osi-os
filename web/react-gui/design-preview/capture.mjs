import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use an existing Playwright installation without adding a product dependency.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SWT_PREVIEW_URL || 'http://127.0.0.1:4178/gui/design-preview/';
const expectedMode = process.env.SWT_PREVIEW_MODE || 'proposed';
const output = process.env.SWT_PREVIEW_OUTPUT || fileURLToPath(new URL(`../../../docs/superpowers/previews/swt-water-status/${expectedMode === 'implemented' ? 'implemented/' : ''}`, import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const labels = { en: ['Wet', 'Moist', 'Dry'], 'de-CH': ['Nass', 'Feucht', 'Trocken'], fr: ['Saturé', 'Humide', 'Sec'] };

try {
  const matrix = [];
  for (const width of [1440, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      for (const lang of ['en', 'de-CH', 'fr']) matrix.push({ width, theme, lang, unit: 'kPa', scenario: 'fresh' });
    }
  }
  for (const scenario of ['stale', 'fault', 'zero', 'future']) {
    matrix.push({ width: 390, theme: 'light', lang: 'en', unit: 'pF', scenario });
  }
  matrix.push({ width: 390, theme: 'dark', lang: 'de-CH', unit: 'pF', scenario: 'fresh' });

  for (const item of matrix) {
    const page = await browser.newPage({ viewport: { width: item.width, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== new URL(base).origin) {
        requests.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const name = `${item.width}-${item.theme}-${item.lang}-${item.unit}-${item.scenario}`;
    await page.goto(`${base}?${new URLSearchParams(item)}`, { waitUntil: 'networkidle' });
    if (errors.length) throw new Error(`${name}: initial load failed: ${errors.join('\n')}`);
    await page.getByRole('button', { name: /^Zone B / }).click();
    await page.locator('[data-testid="water-soil-tile"]').waitFor();
    await page.locator('button[aria-expanded="false"]').click();
    await page.getByText('Tensiomark · south bed', { exact: true }).waitFor({ state: 'attached' });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.getByText(expectedMode === 'proposed'
      ? /proposed indicators/ : /implementation under test/).count(), 1, 'preview mode');

    const badges = page.locator('[data-swt-status]');
    const count = await badges.count();
    const expectedCount = item.scenario === 'stale' || item.scenario === 'future' ? 0 : item.scenario === 'fault' ? 4 : 7;
    assert.equal(count, expectedCount, `${name}: status badge count`);
    if (item.scenario === 'fresh') {
      const actual = await badges.allTextContents();
      for (const label of labels[item.lang]) assert(actual.some(text => text.trim() === label), `${name}: missing ${label}`);
    }
    if (item.scenario === 'fault') {
      assert.match(await page.getByTestId('water-soil-tile').innerText(), /2\.52 pF/, 'faulted Chameleon excluded from Soil now');
    }
    assert.equal(await page.locator('button button').count(), 0, 'no nested buttons');
    assert.equal(await page.locator('[data-swt-status][role="status"], [data-swt-status] [role="status"]').count(), 0, 'no live regions');
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth > innerWidth,
      badges: [...document.querySelectorAll('[data-swt-status]')].filter(el => {
        const r = el.getBoundingClientRect();
        const parent = el.parentElement.getBoundingClientRect();
        return r.left < 0 || r.right > innerWidth || el.scrollWidth > el.clientWidth + 1
          || r.left < parent.left - 1 || r.right > parent.right + 1 || r.bottom > parent.bottom + 1;
      }).map(el => el.textContent),
    }));
    assert.equal(overflow.document, false, `${name}: document overflow`);
    assert.deepEqual(overflow.badges, [], `${name}: badge overflow`);
    assert.deepEqual(errors, [], `${name}: browser errors`);
    assert.deepEqual(requests, [], `${name}: external requests`);

    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    if (item.width === 1440 && item.lang === 'en' || name === '390-dark-en-kPa-fresh') {
      await page.getByTestId('water-today-card').screenshot({ path: `${output}/${name}-water.png` });
      for (const [card, title] of [['kiwi', 'Kiwi · north bed'], ['chameleon', 'Chameleon · orchard'], ['sdi12', 'Tensiomark · south bed']]) {
        await page.locator('div.rounded-xl').filter({ has: page.getByText(title, { exact: true }) }).last()
          .screenshot({ path: `${output}/${name}-${card}.png` });
      }
    }
    results.push({ ...item, badges: count, browserErrors: errors, overflow });
    if (name === '1440-light-en-kPa-fresh') {
      // Reach the existing history controls using the keyboard, then activate.
      for (const selector of ['button[title="View history"]', 'button[title="View SWT history"]']) {
        let reached = false;
        for (let step = 0; step < 80; step++) {
          await page.keyboard.press('Tab');
          reached = await page.evaluate(css => document.activeElement?.matches(css) === true, selector);
          if (reached) break;
        }
        assert(reached, `keyboard cannot reach ${selector}`);
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: '×', exact: true }).waitFor();
        await page.getByRole('button', { name: '×', exact: true }).click();
      }
      assert.deepEqual(errors, [], 'history drawer browser errors');
      results.at(-1).keyboardHistory = 'KIWI and LSN50 opened with Tab/Enter';
    }
    console.log(`PASS ${name}`);
    await page.close();
  }
  await writeFile(`${output}/checks.json`, JSON.stringify({ mode: expectedMode, cases: results }, null, 2) + '\n');
  if (expectedMode === 'proposed') {
    const gallery = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    await gallery.goto(pathToFileURL(`${output}/index.html`).href, { waitUntil: 'load' });
    await gallery.screenshot({ path: `${output}/gallery-light.png`, fullPage: true });
    await gallery.getByRole('button', { name: 'Dark', exact: true }).click();
    await gallery.screenshot({ path: `${output}/gallery-dark.png`, fullPage: true });
    await gallery.close();
  }
} finally {
  await browser.close();
}
