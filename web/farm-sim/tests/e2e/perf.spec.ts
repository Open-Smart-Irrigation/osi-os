import {expect, test, type CDPSession, type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluate, markdown, planMismatches, requiredFailures, summarize} from '../../scripts/check-perf.mjs';
import type {PerfFrame, PerfSnapshot, PerfWindow} from '../../src/render-review';
import {PHONE_FRAME} from './phone-fixture';

// Plan section 12: the built game, the baseline scenario at T4 and 60 s of play at the default pace with
// one drip run, two phone raises and one sleep jump, under a CDP CPU throttle (FARM_SIM_PERF_CPU_THROTTLE,
// default 6). The test writes perf-<rate>x.json for the PR table and applies the same gate policy as the local table checker.
// playwright.config.ts runs this file in its own project after the other specs, so no second worker
// shares the CPU while it measures.

function cpuThrottle(value = '6') {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 1 || rate > 6) {
    throw new Error('FARM_SIM_PERF_CPU_THROTTLE must be a number from 1 to 6; plan section 12 sets the CI gate at 6x');
  }
  return rate;
}

const RATE = cpuThrottle(process.env.FARM_SIM_PERF_CPU_THROTTLE);
/** Measured play at the default pace, summed over the play windows. */
const PLAY_MS = 60_000;
const slow = expect.configure({timeout: 120_000});

// Between measured windows the spec jumps the clock to 21:00: every animation frame then reports 400 ms
// more, so the loop runs its eight-tick maximum. Only the game window, not the phone iframe.
function fastForwardShim() {
  if (window !== window.top) return;
  const request = window.requestAnimationFrame.bind(window);
  let extra = 0;
  window.requestAnimationFrame = callback => request(now => {
    if (window.farmPerf?.fastForwarding()) extra += 400;
    callback(now + extra);
  });
}

async function heapAfterGc(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage');
  const {metrics} = await cdp.send('Performance.getMetrics');
  const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
  if (!heap) throw new Error('CDP reported no JSHeapUsedSize');
  return heap;
}

function measurement(page: Page) {
  let playMs = 0;
  return {
    playMs: () => playMs,
    async measure(label: PerfWindow, work: (started: number) => Promise<void>) {
      await page.evaluate(name => window.farmPerf!.begin(name), label);
      const started = Date.now();
      await work(started);
      if (label === 'play') playMs += Date.now() - started;
      await page.evaluate(() => window.farmPerf!.end());
    },
  };
}

function syntheticSnapshot(frameMs: number): PerfSnapshot {
  const frames = Array.from({length: 600}, (_, i): PerfFrame => ({
    segment: 0, window: 'play', start: i * 16, frameMs, coreMs: 1, ticks: 1, viewMs: .5, renderMs: 2, rendered: true,
  }));
  const uplink = (): PerfSnapshot['advances'][number] => ({window: 'play', ms: 1, uplink: true});
  return {
    quality: 'standard', longTaskSupported: true, segments: [{index: 0, window: 'play', start: 0, end: 10_000}], frames,
    playCore: {ms: frames.length, ticks: frames.length},
    advances: Array.from({length: 20}, uplink),
    sleepJumps: [{ms: 50, fromHour: 21, toHour: 5 + 50 / 60}],
    replayLoads: [{ms: 1_000, ticks: 101_920, logRows: 17}],
    longTasks: [], work: [],
  };
}

test.describe.configure({mode: 'default'});
test.use({viewport: {width: 412, height: 760}, deviceScaleFactor: 2, hasTouch: true, isMobile: true, actionTimeout: 30_000});

test('the section 12 evaluator gates the CI column and refuses missing samples', () => {
  // Every budget and gate in ROWS, not only the frame row checked below, matches the plan's table.
  expect(planMismatches(readFileSync(new URL('../../docs/plan.md', import.meta.url), 'utf8'))).toEqual([]);
  const measured = {heapClosedBytes: 40e6, heapAfterBytes: 50e6, heapOpenBytes: 70e6, phoneFirstOpenMs: 1_500};
  const snapshot = syntheticSnapshot(24);
  snapshot.longTasks.push({start: 100, ms: 55});
  snapshot.work.push({name: 'core step', start: 101, ms: 2}, {name: 'render pass', start: 104, ms: 18});
  const atGate = evaluate(summarize(snapshot, measured), 6);
  expect(atGate.report.countedTasks[0]).toMatchObject({simulationMs: 2, renderMs: 18, oursMs: 20, remainderMs: 35});
  expect(atGate.problems).toEqual([]);
  expect(atGate.pass).toBe(true);
  const over = evaluate(summarize(syntheticSnapshot(24.5), measured), 6);
  expect(over.rows.filter(row => row.pass === false).map(row => row.id)).toEqual(['frameP95']);
  const empty = evaluate(summarize({...syntheticSnapshot(1), frames: [], playCore: {ms: 0, ticks: 0},
    advances: [], sleepJumps: [], replayLoads: []}, measured), 6);
  expect(empty.problems.length).toBeGreaterThan(0);
  expect(empty.pass).toBe(false);
});

test('the T4 baseline workload stays inside the section 12 CI gates', async ({page, browser}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fastForwardShim);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  // Boot under the throttle, so the frame-quality choice in src/view/quality.ts sees the throttled CPU.
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: RATE});
  await page.goto('./index.html?facilitator&perf');
  const facilitator = page.getByRole('region', {name: 'Facilitator'});
  await slow(facilitator).toBeVisible();
  await facilitator.getByLabel('Scenario').selectOption('baseline');
  await facilitator.getByLabel('Tier').selectOption('4');
  await facilitator.getByRole('button', {name: 'Start new run'}).click();
  await slow(facilitator).toBeHidden();
  expect(await page.evaluate(() => typeof window.farmPerf)).toBe('object');
  // Warm-up, not recorded: actor textures, terrain chunk caches and the two-second quality probe settle.
  await page.waitForTimeout(5_000);

  const {measure, playMs} = measurement(page);
  const raise = page.getByRole('button', {name: 'Raise phone'});
  const lower = page.getByRole('button', {name: 'Lower phone'});
  const phoneHeading = page.frameLocator(PHONE_FRAME).getByRole('heading', {name: 'Tomato bed', exact: true});
  const farm = page.getByLabel('Farm view');
  const litresUsed = async () => Number(await page.getByTestId('litres-used').textContent());
  const hold = async (key: string, ms: number) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  };

  // 1. Morning chores before the phone has ever been raised.
  await measure('play', async () => {
    await hold('ArrowRight', 1_000);
    await page.getByRole('button', {name: 'Pump'}).click();
    await page.waitForTimeout(6_000);
    await page.getByRole('button', {name: 'Feel soil'}).click();
    await page.waitForTimeout(6_000);
    await hold('ArrowLeft', 1_000);
    await page.waitForTimeout(4_000);
  });
  const heapClosedBytes = await heapAfterGc(cdp);

  // 2. First raise: the phone mounts lazily, and a timed open queues a 10-minute drip run.
  const litresBeforeDrip = await litresUsed();
  let phoneFirstOpenMs = NaN;
  await measure('phone', async () => {
    const start = Date.now();
    await raise.click();
    await phoneHeading.waitFor({timeout: 120_000});
    phoneFirstOpenMs = Date.now() - start;
    const status = await page.evaluate(() => window.farmSimPhone!.request('POST', '/api/valve/00000000000000B3',
      {action: 'OPEN_FOR_DURATION', duration_seconds: 600}).status);
    expect(status).toBeLessThan(400);
    await lower.click();
    await slow(page.locator(PHONE_FRAME)).toBeHidden();
  });

  // 3. The drip run starts once the phone is down and ends on its own after about 4 s; then more chores.
  // The litres used only rise, so a slow poll cannot miss the run the way it could miss "Drip line running".
  await measure('play', async () => {
    await expect.poll(litresUsed, {timeout: 120_000}).toBeGreaterThan(litresBeforeDrip);
    await slow(farm).toHaveAttribute('aria-description', 'Drip line idle');
    await page.getByRole('button', {name: 'Fill can'}).click();
    await page.waitForTimeout(5_000);
  });

  // 4. Second raise: the mounted phone refreshes. The heap is read while it is open.
  await measure('phone', async () => {
    await raise.click();
    await phoneHeading.waitFor({timeout: 120_000});
  });
  const heapOpenBytes = await heapAfterGc(cdp);
  await measure('phone', async () => {
    await lower.click();
    await slow(page.locator(PHONE_FRAME)).toBeHidden();
  });

  // 5. Play until 10 s of the minute remain.
  await measure('play', async () => {
    await hold('ArrowDown', 800);
    await page.waitForTimeout(Math.max(3_000, PLAY_MS - 10_000 - playMs()));
    await hold('ArrowUp', 800);
  });

  // 6. Jump to 21:00. The window keeps the OSI steps that cross an uplink; its frames are not gated.
  await measure('fast-forward', async () => {
    await page.evaluate(() => window.farmPerf!.fastForwardTo(21));
    await page.waitForFunction(() => !window.farmPerf!.fastForwarding(), undefined, {timeout: 300_000, polling: 500});
  });
  expect(await page.evaluate(() => window.farmPerf!.hour())).toBeGreaterThanOrEqual(21);

  // 7. Sleep at 21:00, wake at 05:50 and play out the minute on day 2.
  await measure('play', async started => {
    await page.getByRole('button', {name: 'Sleep'}).click();
    await slow(page.getByRole('region', {name: 'Bedtime card'})).toBeVisible();
    await slow(page.locator('time')).toHaveText('05:50');
    await page.getByRole('button', {name: 'Wake at 05:50'}).click();
    await slow(page.getByText('Day 2', {exact: false})).toBeVisible();
    await page.getByRole('button', {name: 'Feel soil'}).click();
    await page.waitForTimeout(Math.max(5_000, PLAY_MS - playMs() - (Date.now() - started)));
  });
  // The closed-phone budget also covers the retained iframe after play.
  const heapAfterBytes = await heapAfterGc(cdp);

  // 8. Load a 14-day log through the facilitator panel. Making the log is not measured, so it runs at 1x.
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
  const log = await page.evaluate(() => window.farmPerf!.replayLog());
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: RATE});
  await page.keyboard.press('Shift+F');
  await slow(facilitator).toBeVisible();
  await facilitator.getByLabel('Load replay').setInputFiles({
    name: 'farm-replay.json', mimeType: 'application/json', buffer: Buffer.from(log),
  });
  await page.waitForFunction(() => window.farmPerf!.replayLoads() > 0 || document.querySelector('.facilitator [role="alert"]') !== null,
    undefined, {timeout: 300_000, polling: 1_000});
  await expect(page.locator('.facilitator [role="alert"]')).toHaveCount(0);

  const snapshot = await page.evaluate(() => window.farmPerf!.snapshot());
  const summary = summarize(snapshot, {heapClosedBytes, heapOpenBytes, phoneFirstOpenMs, heapAfterBytes});
  const result = {chromium: browser.version(), playMs: playMs(), ...evaluate(summary, RATE)};
  const target = process.env.FARM_SIM_E2E_ARTIFACTS ?? testInfo.outputPath();
  await mkdir(target, {recursive: true});
  await writeFile(join(target, `perf-${RATE}x.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(markdown([result]));

  expect.soft(snapshot.work.filter(span => span.name === 'sleep').length, 'sleep slices inside play').toBeGreaterThan(1);
  expect(errors, 'page errors').toEqual([]);
  expect.soft(result.problems, 'samples behind the CI gates').toEqual([]);
  expect.soft(requiredFailures(result), 'section 12 budget failures').toEqual([]);
});
