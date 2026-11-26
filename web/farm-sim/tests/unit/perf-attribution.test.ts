import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {evaluate, FLOORS, markdown, planMismatches, requiredFailures, ROWS, summarize} from '../../scripts/check-perf.mjs';
import type {PerfSnapshot} from '../../src/render-review';

test('the closed-phone heap gate covers both the cold reading and the retained phone', () => {
  assert.deepEqual(planMismatches(readFileSync(new URL('../../docs/plan.md', import.meta.url), 'utf8')), []);
  const snapshot: PerfSnapshot = {
    quality: 'standard', longTaskSupported: true, segments: [], frames: [], playCore: {ms: 0, ticks: 0}, advances: [],
    sleepJumps: [], replayLoads: [], longTasks: [], work: [],
  };
  for (const [heapClosedBytes, heapAfterBytes] of [[40e6, 70e6], [70e6, 40e6]]) {
    const result = evaluate(summarize(snapshot, {heapClosedBytes, heapAfterBytes,
      heapOpenBytes: 85e6, phoneFirstOpenMs: 1_500}), 6);
    const closed = result.rows.find(row => row.id === 'heapClosed')!;
    assert.deepEqual([closed.value, closed.gate, closed.pass], [70, 60, false]);
    assert.equal(result.rows.find(row => row.id === 'heapOpen')?.pass, true);
    assert.equal(result.report.heapAfterWorkloadMB, heapAfterBytes / 1e6);
  }
  const missing = summarize(snapshot, {heapClosedBytes: 40e6, heapAfterBytes: 0,
    heapOpenBytes: 85e6, phoneFirstOpenMs: 1_500});
  assert.ok(missing.problems.includes('no heapAfterBytes measurement'));
});

test('a long task counts by its start in play and reports overlapping work across the window end', () => {
  const snapshot: PerfSnapshot = {
    quality: 'standard', longTaskSupported: true, frames: [], playCore: {ms: 0, ticks: 0},
    advances: [], sleepJumps: [], replayLoads: [],
    segments: [
      {index: 0, window: 'play', start: 10, end: 200},
      {index: 1, window: 'phone', start: 210, end: 350},
      {index: 2, window: 'play', start: 360, end: 500},
    ],
    longTasks: [{start: 1, ms: 65}, {start: 100, ms: 60}, {start: 330, ms: 80},
      {start: 420, ms: 55}, {start: 490, ms: 76}],
    work: [
      // The probe emits children before their parents. Clip the core start and second render end to the task.
      {name: 'checkpoint hash', start: 102, ms: 6}, {name: 'uplink advance', start: 110, ms: 2},
      {name: 'core step', start: 90, ms: 25, simFrom: 10, simTo: 20}, {name: 'view model', start: 116, ms: 2},
      {name: 'terrain re-bake', start: 125, ms: 10}, {name: 'render pass', start: 120, ms: 19},
      {name: 'render pass', start: 148, ms: 17}, {name: 'sleep', start: 490, ms: 64},
    ],
  };
  const result = evaluate(summarize(snapshot, {heapClosedBytes: 1, heapAfterBytes: 1, heapOpenBytes: 1, phoneFirstOpenMs: 1}), 6);
  const row = result.rows.find(row => row.id === 'longTasks')!;
  assert.equal(row.value, 3);
  assert.equal(row.pass, false);
  assert.deepEqual(result.report.countedTasks, [
    {start: 100, ms: 60, playWindow: 1, segment: 0, work: snapshot.work.slice(0, 7).sort((a, b) => a.start - b.start),
      simulationMs: 17, renderMs: 31, oursMs: 48, remainderMs: 12},
    {start: 420, ms: 55, playWindow: 2, segment: 2, work: [], simulationMs: 0, renderMs: 0, oursMs: 0, remainderMs: 55},
    {start: 490, ms: 76, playWindow: 2, segment: 2, work: snapshot.work.slice(7),
      simulationMs: 64, renderMs: 0, oursMs: 64, remainderMs: 12},
  ]);
  const output = markdown([result]);
  assert.match(output, /play window 2, long task at 490.00 ms for 76.00 ms.*sleep at 490.00 ms for 64.00 ms/);
  assert.match(output, /No recorded work overlapped/);
  assert.match(output, /recorded 3 long tasks, including 1 with over 50 ms of measured simulation and rendering/);
  assert.ok(output.includes('Ours 48.00 ms (simulation 17.00 ms, render 31.00 ms), remainder 12.00 ms.'));
  assert.ok(output.includes('render pass at 148.00 ms for 17.00 ms'));
  assert.ok(output.includes('core step at 90.00 ms for 25.00 ms (sim 10 to 20)'));
});

test('skipped callbacks cannot dilute the render gate or hide checkpoint CPU time', () => {
  const snapshot: PerfSnapshot = {
    quality: 'standard', longTaskSupported: true,
    segments: [{index: 0, window: 'play', start: 0, end: 10_000}],
    frames: Array.from({length: 620}, (_, i) => ({
      window: 'play', segment: 0, start: i * 16, rendered: i < FLOORS.playFrames,
      frameMs: i < 25 ? 30 : 10, renderMs: i < FLOORS.playFrames ? 2 : 0,
      ticks: i < 400 ? 1 : 0, coreMs: i < 400 ? 3.8 : .4, viewMs: 0,
    })),
    playCore: {ms: 1_608, ticks: 400},
    advances: Array.from({length: FLOORS.uplinks}, () => ({window: 'play', ms: 1, uplink: true})),
    sleepJumps: [{ms: 50, fromHour: 21, toHour: 5 + 50 / 60}],
    replayLoads: [{ms: 1_000, ticks: 101_920, logRows: 17}],
    longTasks: [], work: [],
  };
  const measured = {heapClosedBytes: 1, heapAfterBytes: 1, heapOpenBytes: 1, phoneFirstOpenMs: 1};
  const result = evaluate(summarize(snapshot, measured), 6);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(requiredFailures(result, false).map(row => [row.id, row.value]), [
    ['frameP95', 30], ['coreTickAvg', 4.02],
  ]);
  snapshot.frames[0].rendered = false;
  assert.deepEqual(summarize(snapshot, measured).problems, [
    `${FLOORS.playFrames - 1} rendered play frames, fewer than ${FLOORS.playFrames}`,
  ]);
});

test('local timings bind and only an explicit hosted switch reports overruns', t => {
  const directory = mkdtempSync(join(tmpdir(), 'farm-perf-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const file = join(directory, 'perf-6x.json');
  const cli = (flag?: string) => {
    const env = {...process.env};
    delete env.FARM_SIM_PERF_REPORT_ONLY;
    if (flag !== undefined) env.FARM_SIM_PERF_REPORT_ONLY = flag;
    return spawnSync(process.execPath, ['scripts/check-perf.mjs', directory], {env, encoding: 'utf8'});
  };
  const metrics = Object.fromEntries(ROWS.map(row => [row.id, row.gate ?? row.low]));
  const timings = ROWS.filter(row => row.unit !== 'MB' && row.gate !== null);
  for (const row of timings) {
    const result = evaluate({metrics: {...metrics, [row.id]: row.gate! + 1}, problems: [], report: {countedTasks: []}}, 6);
    // The browser spec uses this same decision after recording the strict verdict for the table.
    assert.deepEqual(requiredFailures(result, false), result.rows.filter(candidate => candidate.id === row.id));
    assert.deepEqual(requiredFailures(result, true), []);
    writeFileSync(file, JSON.stringify(result));
    assert.equal(cli().status, 1, row.id);
    const hosted = cli('1');
    assert.equal(hosted.status, 0, hosted.stderr);
    assert.ok(hosted.stdout.includes(row.label));
  }
  assert.equal(cli('0').status, 1);
  assert.equal(cli('true').status, 1);
  for (const summary of [
    {metrics: {...metrics, heapOpen: 86}, problems: []},
    {metrics: {...metrics, frameP95: NaN}, problems: []},
    {metrics, problems: ['no replay samples']},
  ]) {
    writeFileSync(file, JSON.stringify(evaluate({...summary, report: {}}, 6)));
    assert.equal(cli('1').status, 1);
    assert.equal(cli().status, 1);
  }
});
