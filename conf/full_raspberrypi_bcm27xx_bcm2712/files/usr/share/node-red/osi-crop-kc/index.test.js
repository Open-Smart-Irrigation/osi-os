'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const kc = require('./index');
const REPO = path.resolve(__dirname, '../../../../../../..');
const vectors = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contracts/agronomy/kc-vectors.json'), 'utf8'));

test('normalizeStage accepts FAO keys, maps legacy keys, treats default/unknown/null as unset', () => {
  for (const s of ['initial', 'development', 'mid_season', 'late_season', 'dormancy']) assert.equal(kc.normalizeStage(s), s);
  assert.equal(kc.normalizeStage(' Mid_Season '), 'mid_season');
  assert.equal(kc.normalizeStage('budbreak'), 'initial');
  assert.equal(kc.normalizeStage('bud_break'), 'initial');
  assert.equal(kc.normalizeStage('fruitset'), 'development');
  assert.equal(kc.normalizeStage('cell_expansion'), 'development');
  assert.equal(kc.normalizeStage('veraison'), 'mid_season');
  assert.equal(kc.normalizeStage('harvest'), 'late_season');
  assert.equal(kc.normalizeStage('post_harvest'), 'late_season');
  assert.equal(kc.normalizeStage('default'), null);
  assert.equal(kc.normalizeStage(null), null);
  assert.equal(kc.normalizeStage('flowering'), null);
});

test('resolveKc reproduces every contract vector, the 83 dated ones included', () => {
  assert.equal(vectors.length, 1335);
  for (const v of vectors) {
    assert.deepEqual(
      kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date }),
      { kc: v.kc, kcSource: v.kcSource, cropId: v.cropId, stage: v.stage, kcStageDay: v.kcStageDay, stageOverrun: v.stageOverrun },
      JSON.stringify(v)
    );
  }
});

test('resolveKc: maize by stage, unset stage, unknown crop, dormancy; grapevine is the wine row', () => {
  assert.deepEqual(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'mid_season' }), { kc: 1.2, kcSource: 'fao56_crop', cropId: 'maize', stage: 'mid_season', kcStageDay: null, stageOverrun: null });
  assert.equal(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'development' }).kc, 1.2);
  assert.deepEqual(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'default' }), { kc: 1.2, kcSource: 'fao56_crop_stage_unset', cropId: 'maize', stage: null, kcStageDay: null, stageOverrun: null });
  assert.deepEqual(kc.resolveKc({ cropType: 'other', phenologicalStage: 'mid_season' }), { kc: 0.9, kcSource: 'heuristic_phenology', cropId: null, stage: 'mid_season', kcStageDay: null, stageOverrun: null });
  assert.equal(kc.resolveKc({ cropType: 'apple', phenologicalStage: 'dormancy' }).kc, 0.25);
  assert.equal(kc.resolveKc({ cropType: 'grapevine', phenologicalStage: 'veraison' }).kc, 0.7);
  assert.equal(kc.cropById('grapevine').variant_of, null);
  assert.equal(kc.cropById('grapes_table').variant_of, 'grapevine');
  assert.equal(kc.catalogue.crops.length, 136);
});

test('the ramp stages take the FAO-56 table values: development kc_mid, late season kc_end', () => {
  const late = (cropType) => kc.resolveKc({ cropType, phenologicalStage: 'late_season' }).kc;
  assert.deepEqual(['maize', 'grapevine', 'apple', 'potato', 'alfalfa'].map(late), [0.35, 0.45, 0.7, 0.75, 1.15]);
  assert.equal(kc.resolveKc({ cropType: 'maize', phenologicalStage: 'harvest' }).kc, 0.35);
  assert.equal(kc.resolveKc({ cropType: 'soybean', phenologicalStage: 'development' }).kc, 1.15);
});

test('kcRamp reproduces FAO-56 Example 28 (Kc ini 0.15, Kc mid 1.19, Kc end 0.35): day 40 = 0.77, day 95 = 0.56', () => {
  // Day 40 of the season is day 15 of the 25-day development stage (d = 14);
  // day 95 is day 15 of the 20-day late season (d = 14).
  assert.equal(kc.kcRamp(0.15, 1.19, 14, 25), 0.77);
  assert.equal(kc.kcRamp(1.19, 0.35, 14, 20), 0.56);
});

test('stageLengths: an own row, a promoted proposal, a swapped default, a partial row, no row, an unknown id', () => {
  assert.deepEqual(kc.stageLengths('maize'), { initial: 30, development: 40, mid_season: 50, late_season: 30 });
  assert.deepEqual(kc.stageLengths(' Garlic '), { initial: 15, development: 25, mid_season: 70, late_season: 40 });
  assert.deepEqual(kc.stageLengths('sugar_beet'), { initial: 50, development: 40, mid_season: 50, late_season: 40 });
  assert.deepEqual(kc.stageLengths('grass'), { initial: 10, development: 20, mid_season: null, late_season: null });
  assert.deepEqual(kc.stageLengths('conifer'), { initial: null, development: null, mid_season: null, late_season: null });
  assert.equal(kc.stageLengths('other'), null);
  assert.equal(kc.catalogue.version, 2);
});

test('the curve counts calendar days: the spring clock change, a future start date, an impossible date', () => {
  const dev = (stageStartedOn, date) => kc.resolveKc({ cropType: 'maize', phenologicalStage: 'development', stageStartedOn, date });
  assert.deepEqual(dev('2026-03-20', '2026-04-09'), { kc: 0.77, kcSource: 'fao56_curve', cropId: 'maize', stage: 'development', kcStageDay: 21, stageOverrun: false });
  assert.deepEqual(dev('2026-05-10', '2026-05-01'), { kc: 0.3, kcSource: 'fao56_curve', cropId: 'maize', stage: 'development', kcStageDay: -8, stageOverrun: false });
  // A naive time string and a year below 100 are not calendar dates either (spec A5).
  for (const bad of ['2026-02-30', '05/01/2026', '', 'yesterday', '2026-03-20T00:00', '0099-03-20']) {
    assert.deepEqual(dev(bad, '2026-05-21'), { kc: 1.2, kcSource: 'fao56_crop', cropId: 'maize', stage: 'development', kcStageDay: null, stageOverrun: null }, bad);
  }
});
