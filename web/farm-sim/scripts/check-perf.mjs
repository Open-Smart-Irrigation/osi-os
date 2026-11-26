// Section 12 runtime budgets (docs/plan.md). tests/e2e/perf.spec.ts turns its probe snapshot into the
// section 12 table with summarize() and evaluate() and writes perf-<rate>x.json; its browserless test checks
// ROWS against the plan's table with planMismatches(). Run as a script, this prints the PR proof table from
// those files:
//   node scripts/check-perf.mjs <directory with perf-1x.json, perf-4x.json, perf-6x.json>
// It exits 1 when a file misses samples or fails a CI gate.
import {readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * `desktop` is the Desktop / 4x column, `low` the 6x column and `gate` the CI gate: the 6x budget with
 * the 2x margin, the plan's own number for long tasks and heap, and null for a report-only row.
 */
export const ROWS = [
  {id: 'frameP95', label: 'Main-thread JS per render frame, p95', unit: 'ms', desktop: 6, low: 12, gate: 24},
  {id: 'coreTickAvg', label: 'Core tick, average', unit: 'ms', desktop: 0.5, low: 2, gate: 4},
  {id: 'uplinkStepP95', label: 'OSI step crossing an uplink, p95', unit: 'ms', desktop: 3, low: 16, gate: 32},
  {id: 'sleepJump', label: 'Sleep jump (21:00 to 05:50)', unit: 'ms', desktop: 100, low: 600, gate: 1200},
  {id: 'replayLoad', label: 'Load by replay of a 14-day log', unit: 'ms', desktop: 2000, low: 8000, gate: 16000},
  {id: 'longTasks', label: 'Long tasks over 50 ms during the workload, phone closed', unit: 'count', desktop: 0, low: 1, gate: 2},
  {id: 'heapClosed', label: 'JS heap after GC, phone closed', unit: 'MB', desktop: 60, low: 60, gate: 60},
  {id: 'heapOpen', label: 'JS heap after GC, phone open', unit: 'MB', desktop: 85, low: 85, gate: 85},
  {id: 'phoneFirstOpen', label: 'Phone first open', unit: 'ms', desktop: 2000, low: 9000, gate: null},
];

/** The section 12 table row behind each ROWS id; both heap rows read the "closed / open" row. */
const PLAN_ROWS = {
  frameP95: 'Main-thread JS per render frame, p95',
  coreTickAvg: 'Core tick, average',
  uplinkStepP95: 'OSI step crossing an uplink',
  sleepJump: 'Sleep jump (21:00 to 05:50)',
  replayLoad: 'Load by replay of a 14-day log',
  longTasks: 'Long tasks over 50 ms during the workload, phone closed',
  heapClosed: 'JS heap after GC, phone closed / open',
  heapOpen: 'JS heap after GC, phone closed / open',
  phoneFirstOpen: 'Phone first open',
};

/** Every number in a plan cell, in ms for times, in order. */
const planNumbers = cell => [...cell.matchAll(/(\d+(?:\.\d+)?)(?:\s*(ms|s|MB)\b)?/g)]
  .map(([, value, unit]) => Number(value) * (unit === 's' ? 1000 : 1));

/**
 * Compares ROWS with the budget table in plan section 12: the Desktop / 4x and 6x columns, and the CI gate,
 * where "2x margin" is twice the 6x budget, "yes" the 6x budget and "report only" no gate.
 * @param {string} plan the text of docs/plan.md
 * @returns {string[]} one line per difference; empty when ROWS matches the plan
 */
export function planMismatches(plan) {
  const section = plan.split(/^## /m).find(part => part.startsWith('12. '));
  if (!section) return ['docs/plan.md has no section 12'];
  const table = new Map();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const [label, ...cells] = line.split('|').slice(1, -1).map(cell => cell.trim());
    table.set(label, cells);
  }
  const problems = [];
  const ids = Object.keys(PLAN_ROWS);
  const extra = ROWS.filter(row => !ids.includes(row.id)).map(row => row.id);
  if (extra.length) problems.push(`ROWS has rows plan section 12 does not: ${extra.join(', ')}`);
  for (const id of ids) {
    const row = ROWS.find(candidate => candidate.id === id);
    const cells = table.get(PLAN_ROWS[id]);
    if (!row) problems.push(`ROWS has no ${id} row`);
    if (!cells || cells.length !== 3) problems.push(`plan section 12 has no row "${PLAN_ROWS[id]}" with three columns`);
    if (!row || !cells || cells.length !== 3) continue;
    const [desktopCell, lowCell, gateCell] = cells;
    const pick = id === 'heapOpen' ? 1 : 0;
    const desktop = planNumbers(desktopCell)[pick];
    const low = lowCell === 'same' ? desktop : planNumbers(lowCell)[pick];
    const gate = gateCell === 'report only' ? null
      : gateCell === '2x margin' ? 2 * low
      : gateCell === 'yes' ? low
      : planNumbers(gateCell)[0];
    for (const [key, expected] of Object.entries({desktop, low, gate})) {
      if (expected !== null && !Number.isFinite(expected)) problems.push(`${id}: cannot read the ${key} value from the plan row`);
      else if (row[key] !== expected) problems.push(`${id}: ${key} is ${row[key]}, plan section 12 gives ${expected}`);
    }
  }
  return problems;
}

/** Fewer samples than this mean a probe did not attach or the workload did not run, so no gate can pass. */
export const FLOORS = {playFrames: 300, ticks: 400, uplinks: 10, replayTicks: 50_000, replayRows: 14};

/** Nearest-rank p95, as src/view/quality.ts computes it; NaN without samples. */
export function percentile95(samples) {
  if (!samples.length) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * .95) - 1];
}

/** Clip measured spans to the task. Simulation and rendering run sequentially, but both have nested spans. */
function attributeTask(task, spans) {
  const end = task.start + task.ms;
  const work = spans.filter(span => span.start < end && span.start + span.ms > task.start)
    .sort((a, b) => a.start - b.start);
  let coveredUntil = task.start;
  let simulationMs = 0;
  let renderMs = 0;
  for (const span of work) {
    const until = Math.min(end, span.start + span.ms);
    const duration = Math.max(0, until - Math.max(coveredUntil, span.start));
    if (span.name === 'render pass' || span.name === 'terrain re-bake') renderMs += duration;
    else simulationMs += duration;
    coveredUntil = Math.max(coveredUntil, until);
  }
  const oursMs = simulationMs + renderMs;
  return {work, simulationMs, renderMs, oursMs, remainderMs: Math.max(0, task.ms - oursMs)};
}

/**
 * @param {import('../src/render-review').PerfSnapshot} snapshot
 * @param {{heapClosedBytes: number, heapOpenBytes: number, phoneFirstOpenMs: number, heapAfterBytes: number}} measured
 *   values the spec takes over CDP or its own clock
 */
export function summarize(snapshot, measured) {
  const problems = [];
  const play = snapshot.frames.filter(frame => frame.window === 'play' && frame.rendered);
  const {ms: coreMs, ticks} = snapshot.playCore;
  const regular = snapshot.advances.filter(advance => advance.window !== 'phone');
  const uplinks = regular.filter(advance => advance.uplink).map(advance => advance.ms);
  const playSegments = snapshot.segments.filter(segment => segment.window === 'play');
  const countedTasks = snapshot.longTasks.flatMap(task => {
    const index = playSegments.findIndex(segment => task.start >= segment.start && task.start <= segment.end);
    if (index < 0) return [];
    return [{...task, playWindow: index + 1, segment: playSegments[index].index, ...attributeTask(task, snapshot.work)}];
  });
  const [jump] = snapshot.sleepJumps;
  const [replay] = snapshot.replayLoads;

  if (play.length < FLOORS.playFrames) problems.push(`${play.length} rendered play frames, fewer than ${FLOORS.playFrames}`);
  if (ticks < FLOORS.ticks) problems.push(`${ticks} ticks in play windows, fewer than ${FLOORS.ticks}`);
  if (uplinks.length < FLOORS.uplinks) problems.push(`${uplinks.length} OSI steps crossing an uplink, fewer than ${FLOORS.uplinks}`);
  if (snapshot.sleepJumps.length !== 1) problems.push(`${snapshot.sleepJumps.length} sleep jumps, expected 1`);
  else if (!(jump.fromHour >= 21 && Math.abs(jump.toHour - (5 + 50 / 60)) < 1e-6)) {
    problems.push(`the sleep jump ran from hour ${jump.fromHour} to ${jump.toHour}, not from 21:00 to 05:50`);
  }
  if (snapshot.replayLoads.length !== 1) problems.push(`${snapshot.replayLoads.length} replay loads, expected 1`);
  else if (replay.ticks < FLOORS.replayTicks || replay.logRows < FLOORS.replayRows) {
    problems.push(`the replayed log has ${replay.ticks} ticks and ${replay.logRows} rows, not a 14-day log`);
  }
  if (!snapshot.longTaskSupported) problems.push('the browser reports no longtask entries');
  if (playSegments.some(segment => !(segment.end >= segment.start))) problems.push('a play window was not closed');
  for (const key of ['heapClosedBytes', 'heapAfterBytes', 'heapOpenBytes', 'phoneFirstOpenMs']) {
    if (!(measured[key] > 0)) problems.push(`no ${key} measurement`);
  }

  const phoneFrames = snapshot.frames.filter(frame => frame.window === 'phone' && frame.rendered);
  const deltas = [];
  for (let i = 1; i < play.length; i++) {
    if (play[i].segment === play[i - 1].segment) deltas.push(play[i].start - play[i - 1].start);
  }
  return {
    problems,
    metrics: {
      frameP95: percentile95(play.map(frame => frame.frameMs)),
      coreTickAvg: ticks > 0 ? coreMs / ticks : NaN,
      uplinkStepP95: percentile95(uplinks),
      sleepJump: snapshot.sleepJumps.length === 1 ? jump.ms : NaN,
      replayLoad: snapshot.replayLoads.length === 1 ? replay.ms : NaN,
      longTasks: snapshot.longTaskSupported ? countedTasks.length : NaN,
      heapClosed: Math.max(measured.heapClosedBytes, measured.heapAfterBytes) / 1e6,
      heapOpen: measured.heapOpenBytes / 1e6,
      phoneFirstOpen: measured.phoneFirstOpenMs,
    },
    // Reported, not gated.
    report: {
      quality: snapshot.quality,
      playFrames: play.length,
      ticks,
      uplinkSteps: uplinks.length,
      rafDeltaP95: percentile95(deltas),
      coreStepP95: percentile95(play.map(frame => frame.coreMs)),
      osiAdvanceP95: percentile95(regular.map(advance => advance.ms)),
      viewSyncP95: percentile95(play.map(frame => frame.viewMs)),
      renderP95: percentile95(play.map(frame => frame.renderMs)),
      phoneOpenFrameP95: percentile95(phoneFrames.map(frame => frame.frameMs)),
      heapAfterWorkloadMB: measured.heapAfterBytes / 1e6,
      replay: replay ?? null,
      sleepJump: jump ?? null,
      countedTasks,
      longTasks: snapshot.longTasks.map(task => ({...task, window: snapshot.segments.find(segment =>
        task.start >= segment.start && task.start <= segment.end)?.window ?? null})),
    },
  };
}

/** Compares a summary with the budget column for this CPU throttle and with the CI gate. */
export function evaluate(summary, throttle) {
  const column = throttle >= 6 ? 'low' : 'desktop';
  const rows = ROWS.map(({id, label, unit, gate, ...budgets}) => {
    const value = summary.metrics[id];
    const measured = Number.isFinite(value);
    return {
      id, label, unit, value: measured ? value : null, budget: budgets[column],
      withinBudget: measured && value <= budgets[column], gate, pass: gate === null ? null : measured && value <= gate,
    };
  });
  return {
    throttle, column, rows, problems: summary.problems, report: summary.report,
    pass: summary.problems.length === 0 && rows.every(row => row.pass !== false),
  };
}

/** Keep the measured verdict in the artifact so a local check can enforce it even for a hosted run. */
export function requiredFailures(result, reportOnly = process.env.FARM_SIM_PERF_REPORT_ONLY === '1') {
  return result.rows.filter(row => {
    const timing = row.unit === 'ms' || row.id === 'longTasks';
    return row.pass === false && (!reportOnly || !timing || row.value === null);
  });
}

function format(value, unit) {
  if (value === null) return 'none';
  if (unit === 'count') return String(value);
  if (unit === 'MB') return value.toFixed(1) + ' MB';
  return (value < 100 ? value.toFixed(2) : value.toFixed(0)) + ' ms';
}

/** The section 12 table for one or more throttle rates, as PR text. */
export function markdown(results) {
  const sorted = [...results].sort((a, b) => a.throttle - b.throttle);
  const lines = [
    `| Metric | Desktop / 4x | 6x | CI gate | ${sorted.map(result => result.throttle + 'x').join(' | ')} |`,
    `|---|---|---|---|${sorted.map(() => '---|').join('')}`,
  ];
  for (const row of ROWS) {
    const cells = sorted.map(result => {
      const measured = result.rows.find(candidate => candidate.id === row.id);
      if (!measured) return 'missing';
      const failure = requiredFailures(result).includes(measured);
      const marks = [failure && 'FAIL', !measured.withinBudget && 'over budget'].filter(Boolean);
      return format(measured.value, row.unit) + (marks.length ? ' (' + marks.join(', ') + ')' : '');
    });
    const gate = row.gate === null ? 'report only' : format(row.gate, row.unit);
    lines.push(`| ${row.label} | ${format(row.desktop, row.unit)} | ${format(row.low, row.unit)} | ${gate} | ${cells.join(' | ')} |`);
  }
  for (const result of sorted) {
    const tasks = result.report.countedTasks ?? [];
    if (result.report.countedTasks && tasks.every(task => Number.isFinite(task.oursMs))) {
      const attributed = tasks.filter(task => task.oursMs > 50).length;
      lines.push('', `${result.throttle}x play windows recorded ${tasks.length} long tasks, including ${attributed} with over 50 ms of measured simulation and rendering.`);
    }
    for (const task of tasks) {
      const timingMs = ms => `${ms.toFixed(2)} ms`;
      const timing = span => `${timingMs(span.start)} for ${timingMs(span.ms)}`;
      const overlaps = task.work.map(span => `${span.name} at ${timing(span)}` +
        (span.simFrom === undefined ? '' : ` (sim ${span.simFrom} to ${span.simTo})`));
      // Older perf JSON has the individual spans only.
      const attribution = task.oursMs === undefined ? '' :
        `Ours ${timingMs(task.oursMs)} (simulation ${timingMs(task.simulationMs)}, render ${timingMs(task.renderMs)}), ` +
        `remainder ${timingMs(task.remainderMs)}. `;
      lines.push(`
${result.throttle}x play window ${task.playWindow}, long task at ${timing(task)}. ` +
        attribution + (overlaps.length ? overlaps.join(', ') : 'No recorded work overlapped.'));
    }
  }
  return lines.join('\n');
}

function main(args) {
  if (args.length !== 1) throw new Error('usage: check-perf.mjs <directory with perf-<rate>x.json files>');
  const directory = resolve(args[0]);
  const files = readdirSync(directory).filter(name => /^perf-\d+(\.\d+)?x\.json$/.test(name));
  if (!files.length) throw new Error('no perf-<rate>x.json files in ' + directory);
  const results = files.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  console.log(markdown(results));
  let failed = false;
  for (const result of results) {
    for (const problem of result.problems) console.error(`check-perf: ${result.throttle}x: ${problem}`);
    const failures = requiredFailures(result);
    for (const row of failures) {
      console.error(`check-perf: ${result.throttle}x: ${row.label} is ${format(row.value, row.unit)}, gate ${format(row.gate, row.unit)}`);
    }
    failed ||= result.problems.length > 0 || failures.length > 0;
  }
  if (failed) process.exitCode = 1;
  else console.log('check-perf: OK');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error('check-perf: ' + error.message);
    process.exitCode = 1;
  }
}
