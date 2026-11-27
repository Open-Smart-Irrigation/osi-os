import {FarmOsiAdapter} from './core/osi/adapter';
import {createRun, FarmRun} from './core/replay';
import {TUTORIAL_SCENARIO} from './core/scenario';
import {DAY_MS, HOUR_MS, localDayStart, localHour, sleepUntil} from './core/time';
import type {ReplayHeader, Save} from './core/types';
import {Weather} from './core/weather';
import {World} from './core/world';
import {loopProbe} from './loop';
import {SleepJump} from './sleep-jump';
import {TerrainChunk} from './view/terrain-layer';
import type {createFarmRenderer} from './view/renderer';
import {FrameQuality, frameSlot, percentile95, type QualityTier} from './view/quality';

const TICK_MS = 50;
const SLEEP_TICK = 720;
const RAIN_TICK = 960;
type Renderer = Awaited<ReturnType<typeof createFarmRenderer>>;
type FrameName = 'dawn' | 'noon' | 'dusk' | 'night' | 'rain' | 't1-noon';

declare global {
  interface Window {
    farmRenderReview?: ReturnType<typeof makeReview>;
    farmPerf?: PerfProbe;
  }
}

function fixedTick(name: FrameName, weather: Weather, header: ReplayHeader, simTickMs: number) {
  const hours = {dawn: 6.5, noon: 12, dusk: 17.5, night: 21, 't1-noon': 12};
  const dayStart = localDayStart(header.start);
  if (name !== 'rain') return Math.round((dayStart + hours[name] * HOUR_MS - header.start) / simTickMs);

  // Use the seeded baseline's own weather at a tick inside its first daytime burst.
  for (let day = 0; day < 14; day++) {
    const burst = weather.actual(dayStart + day * DAY_MS).burst;
    if (burst && burst.startsAt >= header.start && localHour(burst.startsAt) >= 7 && localHour(burst.startsAt) <= 17) {
      return Math.ceil((burst.startsAt + (burst.endsAt - burst.startsAt) / 2 - header.start) / simTickMs);
    }
  }
  throw new Error('The baseline has no daytime rain inside the slice.');
}

export function makeReview(renderer: Pick<Renderer, 'render'>, header: ReplayHeader) {
  const simTickMs = TICK_MS * header.pace;
  return {
    frame(name: FrameName) {
      const weather = new Weather(header.seed);
      const tick = fixedTick(name, weather, header, simTickMs);
      const now = header.start + tick * simTickMs;
      // The T1 frame adds the soil probe and gateway pole to the T0 baseline of the others.
      const world = new World(name === 't1-noon' ? {...header, tier: 1} : header, TUTORIAL_SCENARIO, weather);
      world.stepTo(now);
      const vm = world.viewModel(now);
      renderer.render(vm, tick * TICK_MS, 'standard', 0);
      return {tick, date: vm.sky.date, hour: vm.sky.hour, rainfall: vm.sky.rainMmPerHour};
    },
    async benchmark(durationMs: number) {
      let world = new World(header, TUTORIAL_SCENARIO);
      const weather = new Weather(header.seed);
      const rainAt = header.start + fixedTick('rain', weather, header, simTickMs) * simTickMs;
      const rainyWorld = new World(header, TUTORIAL_SCENARIO, weather);
      rainyWorld.stepTo(rainAt);
      const quality = new FrameQuality((navigator as Navigator & {deviceMemory?: number}).deviceMemory);
      const renderMs: number[] = [];
      const viewMs: number[] = [];
      const stepMs: number[] = [];
      const intervals: number[] = [];
      const phases = {sleep: false, rain: false};
      const longTasks: PerformanceEntry[] = [];
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries()));
      observer.observe({entryTypes: ['longtask']});

      const start = performance.now();
      const measureAt = start + 2_100;
      let previous = start;
      let lastRender: number | undefined;
      let lastSlot = -1;
      let accumulator = 0;
      let now = header.start;
      let ticks = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          function next(frame: number) {
            try {
              const elapsed = frame - start;
              const slot = frameSlot(elapsed, quality.current);
              const measuring = frame >= measureAt;
              if (frame >= measureAt + durationMs) {
                resolve();
                return;
              }
              if (slot > lastSlot) {
                const stepStart = performance.now();
                accumulator = Math.min(accumulator + Math.max(0, frame - previous), 8 * TICK_MS);
                previous = frame;
                while (accumulator >= TICK_MS) {
                  accumulator -= TICK_MS;
                  ticks++;
                  now += simTickMs;
                  world.stepTo(now);
                  if (ticks === 120) world.setManualTap(now, true);
                  if (ticks === 300) world.setManualTap(now, false);
                  if (ticks % 9 === 0 && ticks < 360) world.move(now, ticks < 180 ? 1 : -1, 0);
                  if (ticks === SLEEP_TICK) {
                    const night = localDayStart(now) + 21 * HOUR_MS;
                    now = sleepUntil(night)!;
                    world.stepTo(now);
                  }
                  if (ticks === RAIN_TICK) {
                    world = rainyWorld;
                    now = rainAt;
                  }
                }

                const viewStart = performance.now();
                const vm = world.viewModel(now);
                const renderStart = performance.now();
                const drew = renderer.render(vm, elapsed, quality.current);
                const renderEnd = performance.now();
                quality.observe(frame, renderEnd - stepStart);
                lastSlot = frameSlot(elapsed, quality.current);

                if (measuring && drew) {
                  phases.sleep ||= ticks >= SLEEP_TICK;
                  phases.rain ||= ticks >= RAIN_TICK && vm.sky.raining;
                  if (lastRender !== undefined) intervals.push(frame - lastRender);
                  renderMs.push(renderEnd - renderStart);
                  viewMs.push(renderStart - viewStart);
                  stepMs.push(viewStart - stepStart);
                  lastRender = frame;
                }
              }
              requestAnimationFrame(next);
            } catch (error) {
              reject(error);
            }
          }
          requestAnimationFrame(next);
        });
        longTasks.push(...observer.takeRecords());
      } finally {
        observer.disconnect();
      }
      return {
        frames: renderMs.length,
        ticks,
        phases,
        tier: quality.current,
        renderP95: percentile95(renderMs),
        viewP95: percentile95(viewMs),
        worldStepP95: percentile95(stepMs),
        totalP95: percentile95(renderMs.map((time, i) => time + viewMs[i] + stepMs[i])),
        intervalP95: percentile95(intervals),
        longTasks: longTasks.filter(task => task.startTime >= measureAt).length,
      };
    },
  };
}

// Section 12 probe for tests/e2e/perf.spec.ts. It wraps the core classes from outside src/core,
// because the core may not call performance.now. The game loads this module only with ?perf.

/** Measurement windows the perf spec opens. Frames and ticks outside a window are not recorded. */
export type PerfWindow = 'play' | 'phone' | 'fast-forward';
type FrameWork = {coreMs: number; ticks: number; viewMs: number};
export type PerfFrame = FrameWork & {
  segment: number; window: PerfWindow; start: number; frameMs: number; renderMs: number; rendered: boolean;
};
export interface PerfSnapshot {
  quality: QualityTier | undefined;
  longTaskSupported: boolean;
  segments: {index: number; window: PerfWindow; start: number; end: number}[];
  frames: PerfFrame[];
  /** Core work inside play windows, including checkpoint continuations between animation callbacks. */
  playCore: {ms: number; ticks: number};
  /** One osi.advance call per tick; `uplink` is true when the soil probe's latest sample changed during the call. */
  advances: {window: PerfWindow; ms: number; uplink: boolean}[];
  /** Wall time from the first sleep slice through completion, including yields. */
  sleepJumps: {ms: number; fromHour: number; toHour: number}[];
  replayLoads: {ms: number; ticks: number; logRows: number}[];
  longTasks: {start: number; ms: number}[];
  work: {
    name: 'core step' | 'sleep' | 'checkpoint hash' | 'uplink advance' | 'view model' | 'render pass' | 'terrain re-bake';
    start: number; ms: number; simFrom?: number; simTo?: number;
  }[];
}
export interface PerfProbe {
  begin(window: PerfWindow): void;
  end(): void;
  hour(): number;
  fastForwardTo(hour: number): void;
  fastForwarding(): boolean;
  replayLog(): string;
  replayLoads(): number;
  snapshot(): PerfSnapshot;
}

interface CoreProbe {
  state: Pick<PerfSnapshot, 'playCore' | 'advances' | 'sleepJumps' | 'replayLoads' | 'work'> & {
    window: PerfWindow | undefined; bypass: boolean; run: FarmRun | undefined; frame: FrameWork;
  };
  bypassed<T>(work: () => T): T;
  takeFrame(): FrameWork;
}

const idleWork = (): FrameWork => ({coreMs: 0, ticks: 0, viewMs: 0});
let coreProbe: CoreProbe | undefined;

/** Times core.step, osi.advance (FarmOsiAdapter.advance), view.sync (FarmRun.viewModel) and FarmRun.load. */
export function wrapCore(): CoreProbe {
  if (coreProbe) return coreProbe;
  const state: CoreProbe['state'] = {
    window: undefined, bypass: false, run: undefined, frame: idleWork(), playCore: {ms: 0, ticks: 0},
    advances: [], sleepJumps: [], replayLoads: [], work: [],
  };
  const {step, resumeStep, viewModel, hash} = FarmRun.prototype;
  const {advance} = FarmOsiAdapter.prototype;
  const load = FarmRun.load;

  const bypassed = <T>(work: () => T): T => {
    const previous = state.bypass;
    state.bypass = true;
    try {
      return work();
    } finally {
      state.bypass = previous;
    }
  };

  FarmOsiAdapter.prototype.advance = function (this: FarmOsiAdapter, simMs: number) {
    if (state.bypass) {
      advance.call(this, simMs);
      return;
    }
    const sample = this.latestProbeSample()?.at;
    const start = performance.now();
    advance.call(this, simMs);
    const ms = performance.now() - start;
    state.frame.ticks++;
    if (state.window) {
      const uplink = this.latestProbeSample()?.at !== sample;
      state.advances.push({window: state.window, ms, uplink});
      if (uplink && state.window === 'play') state.work.push({name: 'uplink advance', start, ms});
    }
  };
  let timingStep = false;
  function timeStep(run: FarmRun, name: 'core step' | 'checkpoint hash', runStep: () => boolean) {
    const simFrom = run.now;
    const ticksBefore = state.frame.ticks;
    const start = performance.now();
    timingStep = true;
    try {
      const done = runStep();
      const ms = performance.now() - start;
      if (state.window === 'play') {
        state.work.push({name, start, ms, simFrom, simTo: run.now});
        state.playCore.ms += ms;
        state.playCore.ticks += state.frame.ticks - ticksBefore;
      }
      state.frame.coreMs += ms;
      return done;
    } finally {
      timingStep = false;
    }
  }
  FarmRun.prototype.step = function (this: FarmRun, realMs: number, sliced = false) {
    if (state.bypass) return step.call(this, realMs, sliced);
    state.run = this;
    return timeStep(this, 'core step', () => step.call(this, realMs, sliced));
  };
  FarmRun.prototype.resumeStep = function (this: FarmRun) {
    const name = this.pendingWork;
    // A synchronous step may finish a pending checkpoint itself. Its span already includes that work.
    if (state.bypass || timingStep || !name) return resumeStep.call(this);
    return timeStep(this, name, () => resumeStep.call(this));
  };

  const advanceSleep = SleepJump.prototype.advance;
  let sleep: {start: number; from: number} | undefined;
  SleepJump.prototype.advance = function () {
    const start = performance.now();
    sleep ??= {start, from: this.run.now};
    const done = advanceSleep.call(this);
    const end = performance.now();
    if (state.window === 'play') state.work.push({name: 'sleep', start, ms: end - start});
    if (done) {
      if (this.run.now > sleep.from) {
        state.sleepJumps.push({ms: end - sleep.start, fromHour: localHour(sleep.from), toHour: localHour(this.run.now)});
      }
      sleep = undefined;
    }
    return done;
  };
  FarmRun.prototype.hash = function (this: FarmRun) {
    if (state.bypass || state.window !== 'play') return hash.call(this);
    const start = performance.now();
    const result = hash.call(this);
    state.work.push({name: 'checkpoint hash', start, ms: performance.now() - start});
    return result;
  };
  FarmRun.prototype.viewModel = function (this: FarmRun) {
    if (state.bypass) return viewModel.call(this);
    const start = performance.now();
    const view = viewModel.call(this);
    const ms = performance.now() - start;
    if (state.window === 'play') state.work.push({name: 'view model', start, ms});
    state.frame.viewMs += ms;
    return view;
  };
  FarmRun.load = (save: Save) => bypassed(() => {
    const start = performance.now();
    const run = load.call(FarmRun, save);
    state.replayLoads.push({ms: performance.now() - start, ticks: save.cursor.tick, logRows: save.log.length});
    return run;
  });

  coreProbe = {
    state,
    bypassed,
    takeFrame() {
      const work = state.frame;
      state.frame = idleWork();
      return work;
    },
  };
  return coreProbe;
}

/** A 14-day log of a run with this header: the player steps next to the house door and sleeps at 21:00 each night. */
export function replayLog(header: ReplayHeader): Save {
  const run = createRun(header);
  for (const [dx, dy] of [[-1, 0], [-1, 0], [0, -1]]) {
    run.apply({kind: 'move', dx, dy});
    run.step(TICK_MS);
  }
  let night = -1;
  while (!run.complete) {
    if (localHour(run.now) >= 21 && localDayStart(run.now) !== night) {
      night = localDayStart(run.now);
      run.apply({kind: 'sleep'});
    }
    run.step(TICK_MS);
  }
  const {sleepCount} = run.feedback();
  if (sleepCount !== 14) throw new Error(`The replay log slept ${sleepCount} of 14 nights`);
  return run.save();
}

/** Adds renderer.render and the loop's frame span to the core probe and publishes window.farmPerf. */
export function installPerfProbe(renderer: Pick<Renderer, 'render'>) {
  const core = wrapCore();
  const segments: PerfSnapshot['segments'] = [];
  const frames: PerfFrame[] = [];
  const longTasks: PerfSnapshot['longTasks'] = [];
  const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
  const recordTasks = (entries: PerformanceEntry[]) => {
    for (const entry of entries) longTasks.push({start: entry.startTime, ms: entry.duration});
  };
  const observer = longTaskSupported ? new PerformanceObserver(list => recordTasks(list.getEntries())) : undefined;
  observer?.observe({type: 'longtask', buffered: true});
  let segment: PerfSnapshot['segments'][number] | undefined;
  let quality: QualityTier | undefined;
  let renderMs = 0;
  let rendered = false;
  let fastForwardUntil: number | undefined;

  const rebake = TerrainChunk.prototype.rebake;
  TerrainChunk.prototype.rebake = function (...args) {
    if (core.state.window !== 'play') return rebake.apply(this, args);
    const start = performance.now();
    rebake.apply(this, args);
    core.state.work.push({name: 'terrain re-bake', start, ms: performance.now() - start});
  };
  const render = renderer.render;
  renderer.render = (...args: Parameters<Renderer['render']>) => {
    const start = performance.now();
    const drew = render(...args);
    const ms = performance.now() - start;
    if (core.state.window === 'play') core.state.work.push({name: 'render pass', start, ms});
    if (drew) {
      rendered = true;
      renderMs += ms;
    }
    return drew;
  };
  loopProbe.frame = (start, end, tier) => {
    const work = core.takeFrame();
    quality = tier;
    if (segment) frames.push({...work, segment: segment.index, window: segment.window, start, frameMs: end - start, renderMs, rendered});
    renderMs = 0;
    rendered = false;
  };

  const activeRun = () => {
    if (!core.state.run) throw new Error('No farm run has stepped yet');
    return core.state.run;
  };
  window.farmPerf = {
    begin(label) {
      if (segment) throw new Error('A perf window is already open');
      segment = {index: segments.length, window: label, start: performance.now(), end: -1};
      segments.push(segment);
      core.state.window = label;
    },
    end() {
      if (!segment) throw new Error('No perf window is open');
      segment.end = performance.now();
      segment = undefined;
      core.state.window = undefined;
    },
    hour: () => localHour(activeRun().now),
    fastForwardTo(hour) {
      fastForwardUntil = localDayStart(activeRun().now) + hour * HOUR_MS;
    },
    fastForwarding: () => fastForwardUntil !== undefined && (core.state.run?.now ?? Infinity) < fastForwardUntil,
    replayLog: () => JSON.stringify(core.bypassed(() => replayLog(activeRun().header))),
    replayLoads: () => core.state.replayLoads.length,
    snapshot() {
      if (segment) throw new Error('Close the perf window before taking a snapshot');
      if (observer) recordTasks(observer.takeRecords());
      const {playCore, advances, sleepJumps, replayLoads, work} = core.state;
      return {quality, longTaskSupported, segments, frames, playCore, advances, sleepJumps, replayLoads, longTasks, work};
    },
  };
}
