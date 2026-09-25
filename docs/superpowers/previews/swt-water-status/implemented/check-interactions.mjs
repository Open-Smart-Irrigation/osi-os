import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SWT_PREVIEW_URL || 'http://127.0.0.1:4178/gui/design-preview/';
const output = process.env.SWT_PREVIEW_OUTPUT || 'docs/superpowers/previews/swt-water-status/implemented';
const browser = await chromium.launch({ headless: true });
const results = [];
async function expand(page) {
  await page.getByRole('button', { name: /^Zone B / }).click();
  await page.getByTestId('water-soil-tile').waitFor();
  await page.locator('button[aria-expanded="false"]').click();
  await page.getByText('Tensiomark · south bed', { exact: true }).waitFor({ state: 'attached' });
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
}
try {
  for (const width of [390, 320]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}?theme=${theme}&lang=en&scenario=fresh&unit=kPa`, { waitUntil: 'networkidle' });
      await expand(page);
      const containers = await page.evaluate(() => {
        const cards = new Set([...document.querySelectorAll('[data-swt-status]')].flatMap(badge => {
          const ancestors = [];
          for (let el = badge.parentElement; el && el.tagName !== 'BODY'; el = el.parentElement) ancestors.push(el);
          return ancestors;
        }));
        return [...cards].map(el => ({ tag: el.tagName, classes: el.className, scroll: el.scrollWidth, client: el.clientWidth }));
      });
      assert.deepEqual(containers.filter(el => el.scroll > el.client + 1), [], 'card/container overflow');
      const controls = [];
      for (const [name, selector] of [['kiwi','button[title="View history"]'], ['chameleon','button[title="View SWT history"]']]) {
        let reached = false;
        for (let step=0; step<100; step++) {
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-swt-status')), false);
          reached = await page.evaluate(css => document.activeElement?.matches(css) === true, selector);
          if (reached) break;
        }
        assert(reached, `cannot tab to ${name}`);
        const focus = await page.evaluate(() => {
          const el = document.activeElement, css = getComputedStyle(el);
          return { visible: el.matches(':focus-visible'), outline: css.outlineStyle, outlineWidth: css.outlineWidth, boxShadow: css.boxShadow };
        });
        assert(focus.visible && (focus.outline !== 'none' && focus.outlineWidth !== '0px' || focus.boxShadow !== 'none'), 'visible keyboard focus');
        await page.locator(selector).first().screenshot({ path: `${output}/${width}-${theme}-${name}-focus.png` });
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: '×', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '×', exact: true }).count(), 1, 'single history drawer');
        await page.getByRole('button', { name: '×', exact: true }).click();
        controls.push({ name, focus, opened: 1 });
      }
      const statusesKpa = await page.locator('[data-swt-status]').evaluateAll(els => els.map(el => el.getAttribute('data-swt-status')));
      await page.locator('.preview-toolbar select').nth(2).selectOption('pF');
      await page.waitForURL(/unit=pF/);
      await expand(page);
      const statusesPf = await page.locator('[data-swt-status]').evaluateAll(els => els.map(el => el.getAttribute('data-swt-status')));
      assert.deepEqual(statusesPf, statusesKpa, 'unit change preserves classifications');
      assert.deepEqual(errors, []);
      results.push({ width, theme, containersChecked: containers.length, controls, unitInvariant: true, browserErrors: errors });
      console.log(`PASS ${width} ${theme}: containers, visible focus, history, unit change`);
      await page.close();
    }
  }
  await writeFile(`${output}/interactions.json`, JSON.stringify(results,null,2)+'\n');
} finally { await browser.close(); }
