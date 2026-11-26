import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIELD_CAPACITY, SATURATION, WILTING_POINT, depletionToKpa, drainageFlux, layerKpa, querySoil,
  rainRunoffFraction, rootShares, soilFromDepletion, stepSoil, stressCoefficient,
} from '../../src/core/soil';
import type {Layers, SoilColumn, SoilInputs} from '../../src/core/soil';
import {HOUR_MS, SOIL_STEP_MS} from '../../src/core/time';
import {hundredths} from '../../src/core/units';

const dry: SoilInputs = {
  durationMs: SOIL_STEP_MS, rainMm: 0, rainRunoffFraction: 0, dripMm: 0, canMm: 0,
  etcMm: 0, daylightFraction: 0, rootDepthM: 1,
};
const sum = (storage: Layers) => storage.reduce((total, layer) => total + layer, 0);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, actual + ' vs ' + expected);

test('every soil step conserves integer hundredths through wetting, runoff, ET and deep losses', () => {
  const rain = 72;
  let column = soilFromDepletion([.6, .35, .3, .25, .2]);
  let percolation = 0;
  let runoff = 0;
  let et = 0;
  for (let n = 0; n < 144; n++) {
    const next = stepSoil(column, {
      ...dry, rainMm: n < 12 ? rain / 12 : 0, rainRunoffFraction: rainRunoffFraction(rain),
      canMm: n === 0 ? 2 : 0, dripMm: n === 20 ? 300 : 0, etcMm: 6, daylightFraction: 1 / 144,
    });
    const f = next.fluxes;
    assert.equal(f.rain + f.drip + f.can,
      sum(next.column.storage) - sum(column.storage) + f.et + f.percolation + f.runoff);
    next.column.storage.forEach((storage, i) => {
      assert.ok(Number.isInteger(storage) && storage >= WILTING_POINT[i] && storage <= SATURATION[i]);
    });
    column = next.column;
    runoff += f.runoff;
    percolation += f.percolation;
    et += f.et;
  }
  assert.ok(runoff > 20, 'can and rain both run off');
  assert.ok(percolation > 0 && et > 0);
  assert.equal(stepSoil(soilFromDepletion([.6, 0, 0, 0, 0]), {...dry, canMm: 2}).fluxes.runoff, 20);
  assert.equal(stepSoil(soilFromDepletion([.5, 0, 0, 0, 0]), {...dry, canMm: 2}).fluxes.runoff, 0);
});

test('the 2.40 mm bottom-layer excess reaches zero at grid step 106', () => {
  let column: SoilColumn = {storage: [FIELD_CAPACITY[0], FIELD_CAPACITY[1], FIELD_CAPACITY[2], FIELD_CAPACITY[3], FIELD_CAPACITY[4] + 240]};
  for (let step = 1; step <= 106; step++) {
    const next = stepSoil(column, dry);
    assert.equal(next.fluxes.percolation, column.storage[4] - next.column.storage[4]);
    assert.ok(next.fluxes.percolation >= 1);
    column = next.column;
    assert.equal(column.storage[4] > FIELD_CAPACITY[4], step < 106);
  }
});

test('at least 98 percent of every 0.01–50 mm isolated excess drains within 24 hours', () => {
  for (let initial = 1; initial <= 5000; initial++) {
    let excess = initial;
    for (let elapsed = 0; elapsed < 24 * HOUR_MS; elapsed += SOIL_STEP_MS) {
      excess -= drainageFlux(excess, SOIL_STEP_MS);
    }
    assert.ok(excess <= .02 * initial, 'excess still present for ' + initial);
  }
  assert.equal(drainageFlux(1, 1), 1);
  assert.equal(drainageFlux(1, 0), 0);
});

test('van Genuchten tension matches the pinned nodes and interpolation rules', () => {
  [20, 24.8, 31.1, 40, 52.8, 72.3, 103.8, 159.6, 271.2, 543.6, 1500]
    .forEach((kPa, i) => assert.equal(depletionToKpa(i / 10), kPa));
  [20, 10.3, 5.5, 2.6, 0].forEach((kPa, i) => assert.equal(depletionToKpa(-i / 4), kPa));
  near(depletionToKpa(.45), Math.sqrt(52.8 * 72.3));
  near(depletionToKpa(-.125), (20 + 10.3) / 2);
  assert.equal(layerKpa({storage: SATURATION}, 0), 0);
  assert.equal(layerKpa({storage: WILTING_POINT}, 0), 1500);
});

test('stress follows depth-weighted depletion and the demand-adjusted RAW threshold', () => {
  const column = soilFromDepletion([.6, .4, .4, .4, .4]);
  near(stressCoefficient(column, .1, 5), (1 - .6) / (1 - .4));
  near(stressCoefficient(column, 1, 5), (1 - .42) / (1 - .4));
  near(stressCoefficient(column, 1, 4), 1);
  near(stressCoefficient({storage: SATURATION}, 1, 5), 1);
  near(stressCoefficient({storage: WILTING_POINT}, 1, 5), 0);
  near(stressCoefficient(column, .1, 50), .4 / .9);
});

test('root quarters are mapped to layers by overlap at both root extents', () => {
  rootShares(.1).forEach((share, i) => near(share, [1, 0, 0, 0, 0][i]));
  rootShares(1).forEach((share, i) => near(share, [.16, .30, .24, .16, .14][i]));
  assert.equal(sum(rootShares(0)), 0);
});

test('an off-grid soil projection does not quantise or mutate storage', () => {
  const original = soilFromDepletion([0, 0, 0, 0, 0]);
  const input = {...dry, durationMs: 0, dripMm: .004};
  const projected = querySoil(original, input);
  near(projected.storage[0] - original.storage[0], .4);
  assert.equal(stepSoil(original, input).column.storage[0], original.storage[0]);
  assert.equal(original.storage[0], FIELD_CAPACITY[0]);
  assert.equal(hundredths(-1.005), -101);
});
