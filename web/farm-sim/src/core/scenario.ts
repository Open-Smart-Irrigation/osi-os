import baseline from '../scenarios/baseline.json';
import drySpell from '../scenarios/dry-spell.json';
import storm from '../scenarios/storm.json';
import {BED_A_AREA_M2} from './map';
import type {ReferencePolicy, ReplayHeader, Scenario, Tier} from './types';
import {WATER} from './water';

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const SCENARIOS: readonly Scenario[] = freeze(
  [baseline, drySpell, storm] as unknown as Scenario[],
);
export const TUTORIAL_SCENARIO = SCENARIOS[0];

export function scenarioById(id: string): Scenario {
  const scenario = SCENARIOS.find(candidate => candidate.id === id);
  if (!scenario) throw new RangeError('Unknown farm scenario: ' + id);
  return scenario;
}

export function defaultHeader(build: string, scenario = TUTORIAL_SCENARIO, tier: Tier = scenario.tiers[0]): ReplayHeader {
  if (!scenario.tiers.includes(tier)) throw new RangeError('Tier is unavailable in this scenario');
  return {
    format: 1, build, scenario: scenario.id, seed: scenario.seed, tier, start: scenario.start,
    pace: 150, pauseWhilePhoneOpen: true, moistureLens: false, hints: true,
  };
}

/** T2 policy converts a negative daily deficit to delivered minutes at the tank outlet. */
export function verdictTapMinutes(
  policy: Extract<ReferencePolicy, {kind: 'verdict-tap'}>, verdict: string, balanceMm: number | null,
): number {
  if (verdict !== policy.verdict || balanceMm === null) return 0;
  const minutes = Math.ceil(-balanceMm * BED_A_AREA_M2 / WATER.dripEfficiency / WATER.dripRateLpm);
  return Math.max(0, Math.min(policy.maxMinutes, minutes));
}
