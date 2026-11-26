// Run after npm run build using the contained verification job.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import {homedir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {brotliCompressSync} from 'node:zlib';
import {chromium} from '@playwright/test';
import {preview} from 'vite';

// FARM_FRAMES_DIR keeps a later art round from overwriting an earlier round's frames.
const output = resolve(process.env.FARM_FRAMES_DIR ?? join(homedir(), 'builds', 'farm-sim-wp7'));
const scratch = join(output, 'scratch');
const dist = resolve('dist');
const FRAME_NAMES = ['dawn', 'noon', 'dusk', 'night', 'rain', 't1-noon'] as const;
const RATES = [1, 4, 6] as const;

async function sizes(files: readonly string[]) {
  let rawBytes = 0;
  let brotliBytes = 0;
  for (const file of files) {
    const data = await readFile(join(dist, file));
    rawBytes += data.length;
    brotliBytes += brotliCompressSync(data).length;
  }
  return {rawBytes, brotliBytes};
}

await mkdir(scratch, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 0, strictPort: true}});
try {
  const base = new URL('http://127.0.0.1:' + (server.httpServer.address() as AddressInfo).port);
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    env: {...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch},
    downloadsPath: scratch,
    tracesDir: scratch,
  });
  try {
    const page = await browser.newPage({viewport: {width: 960, height: 540}, deviceScaleFactor: 1});
    const errors: string[] = [];
    const requested = new Set<string>();
    const frameHashes = new Set<string>();
    const frames = [];
    const measurements = [];

    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('worker', worker => errors.push('Unexpected worker ' + worker.url()));
    page.on('requestfailed', request => errors.push('Failed request ' + request.url()));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== base.origin) errors.push('Unexpected request ' + request.url());
      else requested.add(url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    });
    await page.exposeFunction('recordFarmPolicyViolation', (message: string) => errors.push(message));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', event => {
        const record = Reflect.get(window, 'recordFarmPolicyViolation') as (message: string) => void;
        record(event.violatedDirective + ' blocked ' + event.blockedURI);
      });
    });

    const response = await page.goto(base.href);
    const policy = response?.headers()['content-security-policy'] ?? '';
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /worker-src 'self'/);
    const canvas = page.locator('canvas');
    await canvas.waitFor();
    // Let the ordinary entry draw and finish requesting its first-frame assets.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const criticalFiles = [...requested].sort();
    assert.equal(await page.evaluate(() => window.farmRenderReview === undefined), true);
    const url = new URL('?render-review', base).href;
    await page.goto(url);
    await page.waitForFunction(() => window.farmRenderReview || document.getElementById('root')?.textContent);
    assert.equal(await canvas.count(), 1, errors.join('\n'));
    assert.deepEqual(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]), [960, 540]);
    assert.equal(await canvas.evaluate((element: HTMLCanvasElement) => Boolean(element.getContext('webgl2'))), true);
    assert.deepEqual(errors, []);

    for (const name of FRAME_NAMES) {
      const render = () => page.evaluate(frame => window.farmRenderReview!.frame(frame), name);
      const details = await render();
      const path = join(output, name + '.png');
      const first = await canvas.screenshot();
      assert.equal((details.rainfall > 0), name === 'rain');
      const hash = createHash('sha256').update(first).digest('hex');
      assert.ok(!frameHashes.has(hash), 'Two lighting fixtures produced the same image');
      frameHashes.add(hash);
      await writeFile(path, first);
      frames.push({path, hash, ...details});
    }
    // Interleave live animation before checking the fixed captures again.
    await page.evaluate(() => window.farmRenderReview!.benchmark(100));
    for (const [index, name] of FRAME_NAMES.entries()) {
      const {path, hash, ...details} = frames[index];
      assert.deepEqual(await page.evaluate(frame => window.farmRenderReview!.frame(frame), name), details);
      assert.ok((await readFile(path)).equals(await canvas.screenshot()), 'Fixed tick changed pixels for ' + name);
    }
    assert.deepEqual(errors, []);

    // Verify responsive backing resolution and centred letterboxing at a 2x device scale.
    const hiDpi = await browser.newPage({viewport: {width: 601, height: 401}, deviceScaleFactor: 2});
    await hiDpi.goto(url);
    await hiDpi.waitForFunction(() => !!window.farmRenderReview);
    const dimensions = await hiDpi.locator('canvas').evaluate((element: HTMLCanvasElement) => {
      const bounds = element.getBoundingClientRect();
      return [element.width, element.height, bounds.left, bounds.top, bounds.width, bounds.height];
    });
    assert.deepEqual(dimensions, [960, 540, 60.5, 65.5, 480, 270]);
    await hiDpi.close();
    await page.bringToFront();

    const cdp = await page.context().newCDPSession(page);
    for (const rate of RATES) {
      await cdp.send('Emulation.setCPUThrottlingRate', {rate});
      await page.goto(url);
      await page.waitForFunction(() => !!window.farmRenderReview);
      const workload = await page.evaluate(() => window.farmRenderReview!.benchmark(60_000));
      assert.ok(workload.frames > 0);
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('Performance.enable');
      const {metrics} = await cdp.send('Performance.getMetrics');
      const heapBytesAfterGc = metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
      const measurement = {rate, ...workload, heapBytesAfterGc};
      measurements.push(measurement);
      console.log(JSON.stringify(measurement));
    }
    assert.deepEqual(errors, []);

    for (const file of requested) {
      assert.ok(!relative(dist, resolve(dist, file)).startsWith('..'));
      await readFile(join(dist, file));
    }
    const atlas = criticalFiles.filter(file => file.startsWith('generated/'));
    const phone = (await readdir(join(dist, 'phone'), {recursive: true, withFileTypes: true}))
      .filter(entry => entry.isFile()).map(entry => relative(dist, join(entry.parentPath, entry.name))).sort();
    const bundles = {
      critical: await sizes(criticalFiles),
      atlas: await sizes(atlas),
      gameCode: await sizes(criticalFiles.filter(file => !atlas.includes(file))),
      phone: await sizes(phone),
    };
    const report = {chromium: browser.version(), frames, measurements, bundles, criticalFiles, phone};
    console.log(JSON.stringify(report, null, 2));
    await writeFile(join(output, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
    assert.ok(bundles.critical.brotliBytes <= 600_000);
    assert.ok(bundles.atlas.brotliBytes <= 130_000);
    assert.ok(bundles.phone.brotliBytes <= 900_000);
    for (const {rate, ticks, phases} of measurements) {
      assert.ok(phases.sleep && phases.rain,
        `${rate}x benchmark stopped at tick ${ticks} (sleep: ${phases.sleep}, rain: ${phases.rain})`);
    }
    const lowEnd = measurements.find(measurement => measurement.rate === 6)!;
    assert.ok(lowEnd.totalP95 <= 24, '6x CPU frame p95 exceeds the CI budget');
    for (const measurement of measurements) {
      assert.ok(measurement.heapBytesAfterGc && measurement.heapBytesAfterGc <= 60_000_000);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
