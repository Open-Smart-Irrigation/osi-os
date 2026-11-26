import {MINUTE_MS, SECOND_MS} from './time';
import {hundredths, round2} from './units';

export const WATER = Object.freeze({
  tankCapacityL: 1000, tankStandM: 1.5, wellYieldL: 480, pumpActionL: 20,
  jerrycanCapacityL: 20, canCapacityL: 10, canPourL: 2,
  dripRateLpm: 8, dripEfficiency: .9, closeDelayMs: 2 * SECOND_MS,
});

export type Container = 'can' | 'jerrycan';

export interface WaterState {
  readonly tankLiters: number;
  readonly wellLiters: number;
  readonly canLiters: number;
  readonly jerrycanLiters: number;
}

/** The scenario sets the daily well yield; WATER.wellYieldL is the default. */
export function waterState(tankLiters: number, wellLiters: number, wellYieldL: number = WATER.wellYieldL): WaterState {
  return {
    tankLiters: round2(Math.min(WATER.tankCapacityL, Math.max(0, tankLiters))),
    wellLiters: round2(Math.min(wellYieldL, Math.max(0, wellLiters))),
    canLiters: 0, jerrycanLiters: 0,
  };
}

export function refillWell(state: WaterState, wellYieldL: number = WATER.wellYieldL): WaterState {
  return {...state, wellLiters: wellYieldL};
}

const roomInTank = (state: WaterState) => round2(WATER.tankCapacityL - state.tankLiters);

export function pumpWater(state: WaterState) {
  const liters = Math.min(WATER.pumpActionL, state.wellLiters, roomInTank(state));
  return {
    state: {...state, tankLiters: round2(state.tankLiters + liters), wellLiters: round2(state.wellLiters - liters)},
    liters,
  };
}

export function fillContainer(state: WaterState, container: Container, source: 'tank' | 'shared-well') {
  const field = container === 'can' ? 'canLiters' : 'jerrycanLiters';
  const capacity = container === 'can' ? WATER.canCapacityL : WATER.jerrycanCapacityL;
  const available = source === 'tank' ? state.tankLiters : capacity;
  const liters = Math.min(available, round2(capacity - state[field]));
  return {
    state: {
      ...state,
      [field]: round2(state[field] + liters),
      tankLiters: source === 'tank' ? round2(state.tankLiters - liters) : state.tankLiters,
    },
    liters,
  };
}

export function pourIntoTank(state: WaterState, container: Container) {
  const field = container === 'can' ? 'canLiters' : 'jerrycanLiters';
  const liters = Math.min(roomInTank(state), state[field]);
  return {
    state: {...state, tankLiters: round2(state.tankLiters + liters), [field]: round2(state[field] - liters)},
    liters,
  };
}

export function drawCanPour(state: WaterState) {
  const liters = Math.min(WATER.canPourL, state.canLiters);
  return {state: {...state, canLiters: round2(state.canLiters - liters)}, liters};
}

export function debitTank(state: WaterState, requestedLiters: number) {
  const liters = Math.min(state.tankLiters, round2(Math.max(0, requestedLiters)));
  return {state: {...state, tankLiters: round2(state.tankLiters - liters)}, liters};
}

/** Phone meter estimate and actual tank discharge over the same interval. */
export interface FlowLiters {
  readonly estimated: number;
  readonly delivered: number;
}

export type LitersBetween = (zoneId: number, from: number, to: number) => FlowLiters;

export interface FlowSegment {
  /** First open instant, or the last tank mutation while a valve was open. */
  readonly startsAt: number;
  /** Observed close or following tank mutation, if it has happened. */
  readonly endsAt: number | null;
  readonly rateLpm: number;
  readonly availableLiters: number;
}

/**
 * Integrate one constant-rate segment. Subtract cumulative rounded values so
 * that dividing a segment across grid steps or midnight conserves centilitres.
 */
export function segmentLiters(segment: FlowSegment, from: number, to: number): FlowLiters {
  if (to <= from) return {estimated: 0, delivered: 0};
  const estimatedAt = (t: number) => hundredths(Math.max(0,
    Math.min(t, segment.endsAt ?? Infinity) - segment.startsAt) * segment.rateLpm / MINUTE_MS);
  const available = hundredths(segment.availableLiters);
  const before = estimatedAt(from);
  const after = estimatedAt(to);
  return {
    estimated: (after - before) / 100,
    delivered: (Math.min(after, available) - Math.min(before, available)) / 100,
  };
}

/** Full precision delivery for a partial soil projection between grid points. */
export function projectedSegmentDelivery(segment: FlowSegment, from: number, to: number): number {
  const deliveredAt = (t: number) => Math.min(segment.availableLiters, Math.max(0,
    Math.min(t, segment.endsAt ?? Infinity) - segment.startsAt) * segment.rateLpm / MINUTE_MS);
  return Math.max(0, deliveredAt(to) - deliveredAt(from));
}

export function cutoffAt(now: number, ackAt: number, tankLiters: number, rateLpm: number): number {
  if (!(rateLpm > 0)) throw new RangeError('A cutoff requires a positive flow rate');
  const emptyAt = Math.max(now, ackAt) + Math.max(0, tankLiters) * MINUTE_MS / rateLpm;
  return Math.max(now, Math.floor(emptyAt - WATER.closeDelayMs));
}

export function pendingCutoffAt(now: number, ackAt: number, tankLiters: number, rateLpm: number): number {
  return cutoffAt(now, ackAt, tankLiters, rateLpm);
}

export function runningCutoffAt(now: number, tankLiters: number, rateLpm: number): number {
  return cutoffAt(now, now, tankLiters, rateLpm);
}
