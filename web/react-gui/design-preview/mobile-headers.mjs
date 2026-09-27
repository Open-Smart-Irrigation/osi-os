import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SWT_PREVIEW_URL || 'http://127.0.0.1:4179/gui/design-preview/';
const output = process.env.SWT_PREVIEW_OUTPUT || '/tmp/swt-mobile-polish';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

async function geometry(element) {
  return element.evaluate(el => {
    const card = el.closest('div.rounded-xl');
    const bounds = card.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      width: rect.width, height: rect.height,
      clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      contained: rect.left >= bounds.left && rect.right <= bounds.right
        && rect.top >= bounds.top && rect.bottom <= bounds.bottom,
    };
  });
}

try {
  for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
    for (const names of ['long', 'unbroken']) for (const readonly of ['false', 'true']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const params = { theme, names, readonly, lang: 'de-CH' };
      await page.goto(`${base}?${new URLSearchParams(params)}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /^Zone B / }).click();
      await page.getByTestId('water-soil-tile').waitFor();
      await page.locator('button[aria-expanded="false"]').click();
      const headings = page.locator('h3').filter({ hasText: /^(Kiwi|Chameleon|Tensiomark)/ });
      await headings.last().waitFor();
      // Allow the device-list height animation to settle before containment checks.
      await page.waitForTimeout(400);
      assert.equal(await headings.count(), 3);
      const evidence = [];
      for (let index = 0; index < 3; index++) {
        const heading = headings.nth(index);
        const originalName = await heading.innerText();
        const eui = `000000000000000${index + 1}`;
        const card = page.locator('div.rounded-xl').filter({ has: page.getByText(eui, { exact: true }) }).last();
        const header = card.locator(':scope > div').first();
        const shape = await geometry(heading);
        assert(shape.width >= 100 && !shape.clipped && shape.contained, `${width} ${originalName}: heading ${JSON.stringify(shape)}`);
        const buttons = header.locator('button');
        assert.equal(await buttons.count(), readonly === 'true' ? 0 : 3);
        for (const button of await buttons.all()) {
          const box = await geometry(button);
          assert(box.width >= 48 && box.height >= 48 && box.contained, `touch target ${JSON.stringify(box)}`);
        }
        if (readonly === 'false') {
          const pencil = buttons.first();
          await pencil.click();
          const input = header.locator('input');
          const box = await geometry(input);
          assert(box.width >= 150 && box.contained, 'rename input fits card');
          await input.fill('Unsaved edit');
          await input.press('Escape');
          assert.equal(await heading.innerText(), originalName);
          assert(await pencil.evaluate(el => document.activeElement === el), 'focus returns to rename');
        }
        evidence.push({ name: originalName, ...shape });
      }
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const name = `${width}-${theme}-${names}-${readonly}`;
      if (names === 'long' && readonly === 'false') await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
      results.push({ width, ...params, headings: evidence });
      console.log(`PASS headers ${name}`);
      await page.close();
    }
  }
  await writeFile(`${output}/mobile-headers.json`, JSON.stringify(results, null, 2) + '\n');
} finally {
  await browser.close();
}
