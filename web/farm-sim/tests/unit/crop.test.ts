import assert from 'node:assert/strict';
import test from 'node:test';
import catalogue from '@osi-edge/osi-crop-kc/crop-kc.json';
import {TOMATO, cropSpriteStage, cropStress, finishCropDay, harvestTomato, phenology, ripeGrams, tomato, yieldFactor} from '../../src/core/crop';

test('tomato phenology uses edge stage rows and day-one Kc ramp', () => {
  const entry = catalogue.crops.find(crop => crop.id === TOMATO.id)!;
  assert.equal(entry.stage_lengths_days.verified, true);
  assert.deepEqual([TOMATO.kcInitial, TOMATO.kcMid, TOMATO.kcEnd], [entry.kc_ini, entry.kc_mid, entry.kc_end]);
  const stageDays = entry.stage_lengths_days;
  assert.deepEqual([TOMATO.initialDays, TOMATO.developmentDays, TOMATO.midDays, TOMATO.lateDays],
    [stageDays.initial, stageDays.development, stageDays.mid_season, stageDays.late_season]);
  assert.deepEqual(phenology(tomato()), {stage: 'initial', dayInStage: 0, kc: .6, rootDepthM: .1});
  assert.equal(phenology(tomato(30)).kc, .61);
  assert.equal(phenology(tomato(69)).kc, 1.15);
  assert.deepEqual(phenology(tomato(75)), {stage: 'mid_season', dayInStage: 5, kc: 1.15, rootDepthM: 1});
  assert.equal(phenology(tomato(115)).stage, 'late_season');
  assert.equal(phenology(tomato(144)).kc, .7);
  assert.equal(phenology(tomato(145)).stage, 'dormancy');
  assert.deepEqual([0, 30, 50, 75].map(age => cropSpriteStage(tomato(age))),
    ['transplant', 'vegetative', 'flowering', 'green-fruit']);
});

test('Ks bands choose the leaf state with midday rolling and overnight recovery', () => {
  assert.equal(cropStress(1, 12, false), 'turgid');
  assert.equal(cropStress(.8, 12, false), 'rolling');
  assert.equal(cropStress(.99, 5, false), 'turgid');
  assert.equal(cropStress(.5, 13, false), 'grey-green');
  assert.equal(cropStress(.2, 13, false), 'wilted');
  assert.equal(cropStress(.1, 13, false), 'wilted');
  assert.equal(cropStress(1, 13, true), 'dead');
});

test('three consecutive severe days kill the tomato and ripe fruit is lost', () => {
  const original = tomato(75);
  const first = finishCropDay(original, 1, .19, .2);
  const recovered = finishCropDay(first.crop, 2, .20, .2);
  assert.equal(recovered.crop.severeDays, 0);
  const second = finishCropDay(first.crop, 2, .1, .2);
  const third = finishCropDay(second.crop, 3, .1, .2);
  assert.equal(second.crop.dead, false);
  assert.equal(third.crop.dead, true);
  assert.ok(third.lostGrams >= ripeGrams(second.crop));
  assert.equal(ripeGrams(third.crop), 0);
});

test('yield scales by the seven-day ET ratio and clips crop failure at zero', () => {
  assert.equal(yieldFactor([1, 1, 1]), 1);
  assert.equal(yieldFactor(Array(7).fill(0)), 0);
  assert.equal(yieldFactor([0, 1, 1, 1, 1, 1, 1, 1]), 1);
  assert.equal(yieldFactor(Array(7).fill(.5)), .475);
  const full = finishCropDay(tomato(75), 1, 1, 1).crop;
  const stressed = finishCropDay(tomato(75), 1, .5, .5).crop;
  assert.equal(ripeGrams(full), 27);
  assert.equal(ripeGrams(stressed), 13);
  assert.equal(cropSpriteStage(full), 'ripe-fruit');
});

test('ripe fruit rots on day four after ripening and can be picked before then', () => {
  let crop = finishCropDay(tomato(144), 1, 1, 1).crop;
  for (let day = 2; day < 5; day++) {
    const result = finishCropDay(crop, day, 1, 1);
    assert.equal(result.lostGrams, 0);
    crop = result.crop;
  }
  const picked = harvestTomato(crop);
  assert.equal(picked.grams, 27);
  assert.equal(ripeGrams(picked.crop), 0);
  const rotted = finishCropDay(crop, 5, 1, 1);
  assert.equal(rotted.lostGrams, 27);
  assert.equal(ripeGrams(rotted.crop), 0);
});

test('a seeded ripe batch weighs one day of ripening and rots four days after its ripening day', () => {
  let crop = tomato(75, {green: 6, ripening: 2, ripe: 1}, 10);
  assert.equal(ripeGrams(crop), 27);
  assert.equal(cropSpriteStage(crop), 'ripe-fruit');
  for (let day = 11; day < 14; day++) {
    const result = finishCropDay(crop, day, 1, 1);
    assert.equal(result.lostGrams, 0);
    crop = result.crop;
  }
  assert.equal(finishCropDay(crop, 14, 1, 1).lostGrams, 27);
});

test('a fully watered tile produces the 20 t/ha target over its 75 productive days', () => {
  let crop = tomato(70);
  let grams = 0;
  for (let day = 1; day <= 75; day++) {
    const picked = harvestTomato(finishCropDay(crop, day, 1, 1).crop);
    crop = picked.crop;
    grams += picked.grams;
  }
  assert.equal(grams, 2_000);
});
