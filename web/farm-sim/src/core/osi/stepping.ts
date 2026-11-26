import type {Simulator} from '@osi-demo/model';
import {nextLocalMidnight} from '../time';
import type {World} from '../world';
import type {WaterTap} from './water-tap';

export function drainNow(sim: Simulator, world: World, water: WaterTap): void {
  do {
    sim.advanceTo(sim.now);
    world.stepTo(sim.now);
    world.applyDueTankEvents(sim.now);
  } while (water.afterStep(sim.now));
}

export function advanceOsi(sim: Simulator, world: World, water: WaterTap, target: number): void {
  if (!Number.isSafeInteger(target) || target < sim.now) throw new RangeError('Invalid simulation target');
  drainNow(sim, world, water);
  while (sim.now < target) {
    const step = Math.min(target,
      sim.clock.nextEventAt(target - sim.now) ?? target,
      water.nextCutoffAt() ?? target,
      world.nextTankEventAt() ?? target,
      nextLocalMidnight(sim.now));
    sim.advanceTo(step);
    // drainNow() as plan 4.2 writes it, minus its first sim.advanceTo(sim.now), which here repeats the call above
    // with the same instant and nothing in between: clock.advanceTo has already run every event due by `step`
    // (demo/model/clock.ts), and the environment refresh finds each zone's key unchanged. That call was a third of
    // the replay load's sim.advanceTo calls; any later pass (after a CLOSE was sent) runs drainNow() unchanged.
    world.stepTo(sim.now);
    world.applyDueTankEvents(sim.now);
    if (water.afterStep(sim.now)) drainNow(sim, world, water);
  }
}
