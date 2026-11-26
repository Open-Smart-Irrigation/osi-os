import {HOUR_MS} from './time';
import {hundredths, round2} from './units';

export type Layers = readonly [number, number, number, number, number];

export const LAYER_EDGES_M = [0, .1, .3, .5, .7, 1] as const;
const THICKNESS_M = [.1, .2, .2, .2, .3] as const;
export const SANDY_LOAM = Object.freeze({
  thetaR: .039, thetaS: .387, alphaPerCm: .0267, n: 1.449,
  thetaFc: .198, thetaWp: .062, tawMmPerM: 135, tewMm: 17, curveNumber: 88,
});

function byLayer(fn: (index: number) => number): [number, number, number, number, number] {
  return [fn(0), fn(1), fn(2), fn(3), fn(4)];
}

// Use the plan's rounded TAW (135 mm/m) for storage. It also fixes the initial
// 20% depletion in L1 at exactly 2.70 mm.
export const FIELD_CAPACITY = Object.freeze(byLayer(i => hundredths(198 * THICKNESS_M[i])));
export const SATURATION = Object.freeze(byLayer(i => hundredths(387 * THICKNESS_M[i])));
export const WILTING_POINT = Object.freeze(byLayer(i => FIELD_CAPACITY[i] - hundredths(135 * THICKNESS_M[i])));
export const DRAINAGE_TAU_MS = 6 * HOUR_MS;

export interface SoilColumn {
  /** Layer water storage in 0.01 mm units. A projected column can be fractional. */
  readonly storage: Layers;
}

export function soilFromDepletion(depletion: Layers): SoilColumn {
  return {storage: Object.freeze(byLayer(i => FIELD_CAPACITY[i]
    - Math.round((FIELD_CAPACITY[i] - WILTING_POINT[i]) * depletion[i])))};
}

const BELOW_FC_KPA = [20, 24.8, 31.1, 40, 52.8, 72.3, 103.8, 159.6, 271.2, 543.6, 1500];
const ABOVE_FC_KPA = [20, 10.3, 5.5, 2.6, 0];

export function depletionToKpa(fraction: number): number {
  if (fraction >= 1) return 1500;
  if (fraction <= -1) return 0;
  if (fraction < 0) {
    const position = -4 * fraction;
    const node = Math.floor(position);
    return ABOVE_FC_KPA[node] + (ABOVE_FC_KPA[node + 1] - ABOVE_FC_KPA[node]) * (position - node);
  }
  const position = 10 * fraction;
  const node = Math.floor(position);
  const left = BELOW_FC_KPA[node];
  return position === node ? left : left * (BELOW_FC_KPA[node + 1] / left) ** (position - node);
}

export function layerKpa(column: SoilColumn, layer: number, quantised = true): number {
  const deficit = FIELD_CAPACITY[layer] - column.storage[layer];
  const range = deficit >= 0 ? FIELD_CAPACITY[layer] - WILTING_POINT[layer]
    : SATURATION[layer] - FIELD_CAPACITY[layer];
  const value = depletionToKpa(deficit / range);
  return quantised ? round2(value) : value;
}

export type SurfaceBand = 'saturated' | 'wet' | 'moist' | 'dry' | 'very-dry';

export function surfaceBand(kPa: number): SurfaceBand {
  if (kPa < 8) return 'saturated';
  if (kPa < 20) return 'wet';
  if (kPa <= 50) return 'moist';
  if (kPa <= 100) return 'dry';
  return 'very-dry';
}

/** SCS curve-number runoff as a fraction of the entire day's rain. */
export function rainRunoffFraction(dailyRainMm: number): number {
  const retention = 25400 / SANDY_LOAM.curveNumber - 254;
  const excess = dailyRainMm - .2 * retention;
  return excess <= 0 ? 0 : excess ** 2 / (excess + retention) / dailyRainMm;
}

function overlap(top: number, bottom: number, layer: number): number {
  return Math.max(0, Math.min(bottom, LAYER_EDGES_M[layer + 1]) - Math.max(top, LAYER_EDGES_M[layer]));
}

export function rootShares(rootDepthM: number): Layers {
  const quarter = Math.min(1, rootDepthM) / 4;
  if (quarter <= 0) return [0, 0, 0, 0, 0];
  const values = [.4, .3, .2, .1];
  return byLayer(i => values.reduce((share, value, j) =>
    share + value * overlap(j * quarter, (j + 1) * quarter, i) / quarter, 0));
}

export function stressCoefficient(column: SoilColumn, rootDepthM: number, etcMm: number): number {
  const depth = Math.min(1, rootDepthM);
  if (depth <= 0) return 1;
  const depletion = THICKNESS_M.reduce((total, thickness, i) => {
    const capacity = FIELD_CAPACITY[i] - WILTING_POINT[i];
    const deficit = Math.max(0, Math.min(capacity, FIELD_CAPACITY[i] - column.storage[i]));
    return total + deficit * overlap(0, depth, i) / thickness;
  }, 0);
  const taw = SANDY_LOAM.tawMmPerM * depth * 100;
  const p = Math.min(.8, Math.max(.1, .40 + .04 * (5 - etcMm)));
  return Math.max(0, Math.min(1, (1 - depletion / taw) / (1 - p)));
}

export interface SoilInputs {
  readonly durationMs: number;
  readonly rainMm: number;
  readonly rainRunoffFraction: number;
  readonly dripMm: number;
  readonly canMm: number;
  readonly etcMm: number;
  readonly daylightFraction: number;
  readonly rootDepthM: number;
  /** Reuse quarter overlaps when a bed's plants have the same root depth. */
  readonly uptakeShares?: Layers;
}

export interface SoilFluxes {
  /** Inflow and loss values in units of 0.01 mm. */
  readonly rain: number;
  readonly drip: number;
  readonly can: number;
  readonly runoff: number;
  readonly drainage: Layers;
  readonly percolation: number;
  readonly et: number;
  readonly potentialEt: number;
  readonly ks: number;
}

export function drainageFlux(excess: number, durationMs: number, quantised = true): number {
  if (excess <= 0 || durationMs <= 0) return 0;
  const flux = excess * durationMs / DRAINAGE_TAU_MS;
  return Math.min(excess, quantised ? Math.max(1, Math.round(flux)) : flux);
}

function integrate(column: SoilColumn, input: SoilInputs, quantised: boolean) {
  const round = quantised ? Math.round : (value: number) => value;
  const depthUnits = quantised ? hundredths : (mm: number) => mm * 100;
  const storage = [...column.storage] as [number, number, number, number, number];
  const rain = depthUnits(input.rainMm);
  const drip = depthUnits(input.dripMm);
  const can = depthUnits(input.canMm);
  const crusted = FIELD_CAPACITY[0] - storage[0] > (FIELD_CAPACITY[0] - WILTING_POINT[0]) / 2;
  const runoff = Math.min(rain, depthUnits(input.rainMm * input.rainRunoffFraction))
    + (crusted ? Math.min(can, depthUnits(input.canMm * .10)) : 0);
  const ks = stressCoefficient(column, input.rootDepthM, input.etcMm);
  let infiltration = rain + drip + can - runoff;
  for (let i = 0; i < storage.length && infiltration > 0; i++) {
    const accepted = Math.min(infiltration, SATURATION[i] - storage[i]);
    storage[i] += accepted;
    infiltration -= accepted;
  }

  // Compute each outflow from the post-infiltration state before incoming
  // drainage. The bottom-up pass lets a lower layer make room for that inflow.
  const drainage = byLayer(i => drainageFlux(storage[i] - FIELD_CAPACITY[i], input.durationMs, quantised));
  for (let i = storage.length - 1; i >= 0; i--) {
    if (i < storage.length - 1) {
      drainage[i] = Math.min(drainage[i], SATURATION[i + 1] - storage[i + 1]);
      storage[i + 1] += drainage[i];
    }
    storage[i] -= drainage[i];
  }

  const demand = depthUnits(ks * input.etcMm * input.daylightFraction);
  const evapShare = FIELD_CAPACITY[0] - storage[0] < hundredths(SANDY_LOAM.tewMm)
    ? (input.rootDepthM > 0 ? .10 : 1) : 0;
  const withdraw = (i: number, amount: number) => {
    const actual = Math.min(amount, Math.max(0, storage[i] - WILTING_POINT[i]));
    storage[i] -= actual;
    return actual;
  };
  let et = withdraw(0, round(demand * evapShare));
  const shares = input.uptakeShares ?? rootShares(input.rootDepthM);
  const rootDemand = demand - et;
  let carry = 0;
  let cumulativeShare = 0;
  let allocated = 0;
  for (let i = 0; i < shares.length; i++) {
    if (shares[i] <= 0) continue;
    cumulativeShare = Math.min(1, cumulativeShare + shares[i]);
    const quota = round(rootDemand * cumulativeShare) - allocated;
    allocated += quota;
    const actual = withdraw(i, quota + carry);
    carry += quota - actual;
    et += actual;
  }

  const fluxes: SoilFluxes = {
    rain, drip, can, runoff, drainage: Object.freeze(drainage),
    percolation: infiltration + drainage[4], et, ks,
    potentialEt: depthUnits(input.etcMm * input.daylightFraction),
  };
  return {column: {storage: Object.freeze(storage)}, fluxes};
}

/** Commit a grid step using integer storage and rounded fluxes. */
export function stepSoil(column: SoilColumn, input: SoilInputs) {
  return integrate(column, input, true);
}

/** Project a partial step. The caller keeps the previously committed column. */
export function querySoil(column: SoilColumn, input: SoilInputs): SoilColumn {
  return integrate(column, input, false).column;
}
