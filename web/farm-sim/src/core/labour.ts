import {HOUR_MS, MINUTE_MS} from './time';

export const LABOUR = Object.freeze({
  dailyEnergy: 100, carryEnergy: 6, pumpEnergy: 1, canPourEnergy: 1,
  tillEnergy: 4, harvestEnergy: 1, sharedWellDistanceM: 30, walkMps: 1.2,
  pumpMs: MINUTE_MS, canPourMs: MINUTE_MS / 5, restHour: 5,
});

export type Facing = 'north' | 'south' | 'east' | 'west';
export type PlayerActivity = 'idle' | 'walk' | 'hoe' | 'pour' | 'carry' | 'pump' | 'harvest';

export function carryTripMs(distanceM = LABOUR.sharedWellDistanceM): number {
  return Math.ceil(2 * distanceM / LABOUR.walkMps * 1000);
}

export function spendEnergy(energy: number, cost: number): number | null {
  return energy < cost ? null : energy - cost;
}

export function facingFor(dx: number, dy: number): Facing {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  return dy > 0 ? 'south' : 'north';
}

export const LABOUR_REST_MS = LABOUR.restHour * HOUR_MS;
