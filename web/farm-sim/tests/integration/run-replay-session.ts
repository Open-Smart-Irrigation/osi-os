import {FARM_SITES, START_TILE} from '../../src/core/map';
import {VALVE_PATH, PLANS_PATH, ZONE_PATH} from '../../src/core/osi/farm-builder';
import {createRun, loadRun, TICK_MS, type FarmRun} from '../../src/core/replay';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {localDayStart, HOUR_MS, MINUTE_MS} from '../../src/core/time';
import type {TileRef} from '../../src/core/types';

export const tank = FARM_SITES.tank;
export const start = TUTORIAL_SCENARIO.start;
export const evening = localDayStart(start) + 18 * HOUR_MS;
/** Diagonally beside the tank and beside the house door: both within reach (1 tile). */
const byTank = {x: tank.x - 1, y: tank.y - 1};
export const house = {x: FARM_SITES.houseDoor.x + 1, y: FARM_SITES.houseDoor.y + 1};

export function advanceUntil(run: FarmRun, at: number) {
  while (run.now < at) run.step(TICK_MS * 8);
}

export function queueWalk(run: FarmRun, from: TileRef, to: TileRef) {
  let {x, y} = from;
  while (x !== to.x || y !== to.y) {
    const dx = Math.sign(to.x - x);
    const dy = Math.sign(to.y - y);
    run.apply({kind: 'move', dx, dy});
    x += dx;
    y += dy;
  }
}

export function recordSession(poll: 'none' | 'after-write' | 'frequent') {
  const header = defaultHeader('replay-test', TUTORIAL_SCENARIO, 3);
  const run = createRun(header);
  const read = () => {
    for (const path of [ZONE_PATH + '/environment-summary', '/api/devices', '/api/valves',
      '/api/irrigation/recent-actuations', PLANS_PATH + '/schedules', '/api/system/settings']) {
      if (run.request('GET', path).status >= 400) throw new Error('Replay fixture read failed: ' + path);
    }
  };
  const write = (path: string, body: object) => {
    const response = run.request('POST', path, body);
    if (response.status >= 400) throw new Error('Replay fixture write failed: ' + JSON.stringify(response));
    if (poll !== 'none') read();
  };

  queueWalk(run, START_TILE, byTank);
  run.apply({kind: 'phoneOpen'});
  // Size the run so about 10.1 L stay in the tank after it closes (8 L/min drip), whatever the scenario's starting level.
  const startTank = TUTORIAL_SCENARIO.initial.tankLiters;
  write(VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: Math.round((startTank - 10.1) / 8 * 60)});
  run.step(10_000);
  const duringPause = {at: run.now, open: run.isPhoneOpen(), phase: run.viewModel().valve};
  run.apply({kind: 'phoneClose'});
  advanceUntil(run, start + 75 * MINUTE_MS);

  const nearEmpty = run.viewModel().water.tankLiters;
  run.apply({kind: 'phoneOpen'});
  run.apply({kind: 'useTool', tool: 'can', tile: tank});
  const beforePlan = run.now;
  write(PLANS_PATH + '/schedules', {
    kind: 'ONCE', fire_at: new Date(beforePlan - MINUTE_MS).toISOString(), duration_minutes: 10,
  });
  const atWrite = {
    at: run.now, tankLitres: run.viewModel().water.tankLiters, phase: run.viewModel().valve,
    commanded: run.eventsSince(0).reverse().find(event => event.type === 'irrigation' && event.payload.kind === 'commanded'),
  };
  run.step(10_000);
  const stillPaused = run.now;
  run.apply({kind: 'phoneClose'});
  advanceUntil(run, start + 95 * MINUTE_MS);

  run.apply({kind: 'phoneOpen'});
  run.step(0);
  if (poll === 'frequent') {
    for (let i = 0; i < 5; i++) read();
  }
  run.apply({kind: 'phoneClose'});
  advanceUntil(run, evening);
  queueWalk(run, byTank, house);
  run.apply({kind: 'sleep'});
  run.step(0);
  const short = run.save();
  const shortHash = run.hash();
  run.step(400);
  run.step(400);
  const long = run.save();
  return {duringPause, nearEmpty, beforePlan, atWrite, stillPaused, short, shortHash, long, longHash: run.hash()};
}

export function paritySequence() {
  const {long, longHash} = recordSession('frequent');
  const replay = loadRun(long);
  return {checkpoints: replay.save().checkpoints, terminal: replay.hash(), live: longHash};
}
