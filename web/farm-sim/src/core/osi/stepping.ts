import type {Simulator} from '@osi-demo/model';
import {nextLocalMidnight, nextSoilGridAt} from '../time';
import type {World} from '../world';
import type {WaterTap} from './water-tap';

export function drainNow(sim: Simulator, world: World, water: WaterTap): void {
  do {
    sim.advanceTo(sim.now);
    world.stepTo(sim.now);
    world.applyDueTankEvents(sim.now);
  } while (water.afterStep(sim.now));
}

function beginAdvance(sim: Simulator, world: World, water: WaterTap, target: number): void {
  if (!Number.isSafeInteger(target) || target < sim.now) throw new RangeError('Invalid simulation target');
  drainNow(sim, world, water);
}

export function advanceOsi(sim: Simulator, world: World, water: WaterTap, target: number): void {
  beginAdvance(sim, world, water, target);
  while (sim.now < target) {
    advanceBoundary(sim, world, water, nextBoundary(sim, world, water, target));
  }
}

function nextBoundary(sim: Simulator, world: World, water: WaterTap, target: number): number {
  return Math.min(target,
    sim.clock.nextEventAt(target - sim.now) ?? target,
    water.nextCutoffAt() ?? target,
    world.nextTankEventAt() ?? target,
    nextLocalMidnight(sim.now));
}

/** Uplinks are not meaningful clock events, so two OSI boundaries can be hours apart.
 * Between them, pause on the world's soil grid. Settle the tank and valve only at the
 * original OSI boundary, after its clock events and world physics, exactly as in advanceOsi. */
export function* sleepBoundaries(sim: Simulator, world: World, water: WaterTap, target: number): Generator<void> {
  beginAdvance(sim, world, water, target);
  while (sim.now < target) {
    const boundary = nextBoundary(sim, world, water, target);
    for (let grid = nextSoilGridAt(sim.now); grid < boundary; grid = nextSoilGridAt(grid)) {
      sim.advanceTo(grid);
      world.stepTo(grid);
      yield;
    }
    advanceBoundary(sim, world, water, boundary);
    if (sim.now < target) yield;
  }
}

function advanceBoundary(sim: Simulator, world: World, water: WaterTap, step: number): void {
  sim.advanceTo(step);
  // drainNow() as plan 4.2 writes it, minus its first sim.advanceTo(sim.now), which here repeats the call above
  // with the same instant and nothing in between: clock.advanceTo has already run every event due by `step`
  // (demo/model/clock.ts), and the environment refresh finds each zone's key unchanged. That call was a third of
  // the replay load's sim.advanceTo calls; any later pass (after a CLOSE was sent) runs drainNow() unchanged.
  world.stepTo(sim.now);
  world.applyDueTankEvents(sim.now);
  if (water.afterStep(sim.now)) drainNow(sim, world, water);
}
