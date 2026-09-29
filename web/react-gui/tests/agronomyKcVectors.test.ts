import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { kcRamp, resolveKc } from '../src/agronomy/cropKc.ts';

const contractDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'contracts', 'agronomy');

test('the GUI resolver reproduces every contract Kc vector, dated ones included', () => {
  const vectors = JSON.parse(readFileSync(join(contractDir, 'kc-vectors.json'), 'utf8'));
  assert.equal(vectors.length, 1335);
  for (const v of vectors) {
    assert.deepEqual(
      resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date }),
      { kc: v.kc, kcSource: v.kcSource, cropId: v.cropId, stage: v.stage, kcStageDay: v.kcStageDay, stageOverrun: v.stageOverrun },
      JSON.stringify(v),
    );
  }
});

test('FAO-56 Example 28 through kcRamp: day 40 of the season is 0.77, day 95 is 0.56', () => {
  assert.equal(kcRamp(0.15, 1.19, 14, 25), 0.77);
  assert.equal(kcRamp(1.19, 0.35, 14, 20), 0.56);
});

test('the GUI copy of crop-kc.json is byte-identical to the contract', () => {
  assert.equal(readFileSync(join(import.meta.dirname, '..', 'src', 'agronomy', 'crop-kc.json'), 'utf8'), readFileSync(join(contractDir, 'crop-kc.json'), 'utf8'));
});
