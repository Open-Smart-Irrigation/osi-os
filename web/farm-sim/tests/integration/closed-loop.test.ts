import assert from 'node:assert/strict';
import test from 'node:test';
import {BED_A_AREA_M2} from '../../src/core/map';
import {SCENARIOS, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {HOUR_MS, MINUTE_MS, SECOND_MS, sleepUntil} from '../../src/core/time';
import {hundredths} from '../../src/core/units';
import {WATER} from '../../src/core/water';
import {atHour, buildAdapter, fixtureWeather, openFor, probeAt} from './osi-fixture';
import golden from './reference-golden.json';
import {dayThreeHint, dayThreeRun, referenceRun} from './reference-run';

for (const scenario of SCENARIOS) {
  for (const tier of scenario.tiers) {
    test(scenario.id + ' T' + tier + ' matches its 14-day reference policy', () => {
      assert.deepEqual(referenceRun(scenario, tier), golden[scenario.id].tiers[String(tier) as '0' | '1' | '2' | '3' | '4']);
    });
  }
  test(scenario.id + ' day-three hint uses the observed 20 cm change', () => {
    assert.equal(dayThreeHint(scenario), golden[scenario.id].dayThreeHintKpa);
  });
}

test('the hand-dug well limits only the daily timer, and only in the dry spell', () => {
  type TierKey = '0' | '1' | '2' | '3' | '4';
  for (const scenario of SCENARIOS) {
    for (const tier of scenario.tiers) {
      const run = golden[scenario.id].tiers[String(tier) as TierKey];
      assert.equal(run.carryTrips > 0, scenario.id === 'dry-spell' && tier === 3, scenario.id + ' T' + tier);
    }
  }
  // At 25 kPa the trigger no longer trails the even-day tap in the dry spell (plan 6.6).
  const dry = golden['dry-spell'].tiers;
  assert.ok(dry['4'].harvestedKg >= dry['0'].harvestedKg);
  assert.ok(dry['4'].stressDays <= dry['0'].stressDays);
});

test('the tutorial day-3 drip run lowers the 20 cm reading by at least 5 kPa within three hours', () => {
  const run = dayThreeRun(TUTORIAL_SCENARIO);
  assert.equal(run.liters, TUTORIAL_SCENARIO.reference.tutorialDrip.minutes * WATER.dripRateLpm);
  const within = [...run.readings].filter(([at]) => at > run.at && at <= run.at + 3 * HOUR_MS).map(([, kPa]) => kPa);
  const drop = run.kPa(run.at) - Math.min(...within);
  assert.ok(drop >= 5, 'the 20 cm reading fell by ' + drop.toFixed(2) + ' kPa');
});

test('45-minute drip run balances actual storage against the dry twin and lowers 20 cm tension', () => {
  const weather = fixtureWeather({et0: 0});
  const irrigated = buildAdapter(3, {weather, tank: 1000}).adapter;
  const twin = buildAdapter(3, {weather, tank: 1000}).adapter;
  const open = atHour(1, 7);
  openFor(irrigated, open - 2 * SECOND_MS, 45);
  const boundaries = [0, 10, 20, 30, 40, 45].map(minute => open + minute * MINUTE_MS);
  let applied = 0;
  for (let i = 1; i < boundaries.length; i++) {
    irrigated.advance(boundaries[i]);
    const {delivered} = irrigated.litersBetween(1, boundaries[i - 1], boundaries[i]);
    applied += hundredths(delivered * WATER.dripEfficiency / BED_A_AREA_M2);
  }
  const liters = irrigated.litersBetween(1, open, boundaries[5]);
  assert.deepEqual(liters, {estimated: 360, delivered: 360});
  assert.ok(Math.abs(applied / 100 - liters.delivered * WATER.dripEfficiency / BED_A_AREA_M2) <= .025);

  const sumLoss = (adapter: typeof twin) => [...adapter.viewModel().daily, adapter.viewModel().today]
    .reduce((total, day) => total + hundredths(day.percolationLiters + day.runoffLiters), 0);
  const sumStorage = (adapter: typeof twin) => adapter.world.bedAColumn().storage.reduce((sum, layer) => sum + layer, 0);
  const limit = open + 24 * HOUR_MS;
  irrigated.advance(limit);
  twin.advance(limit);
  assert.equal((sumStorage(irrigated) - sumStorage(twin)) * BED_A_AREA_M2,
    applied * BED_A_AREA_M2 - (sumLoss(irrigated) - sumLoss(twin)));
  const differences = Array.from({length: 48}, (_, i) => open + (i + 1) * 30 * MINUTE_MS)
    .map(at => probeAt(twin, at) - probeAt(irrigated, at));
  assert.ok(Math.max(...differences) >= 5, 'maximum tension response was ' + Math.max(...differences));
});

test('T0 and T2 sleep runs commit identical world state through midnight', () => {
  const a = buildAdapter(0).adapter;
  const b = buildAdapter(2).adapter;
  for (let day = 1; day <= 3; day++) {
    for (const adapter of [a, b]) {
      adapter.advance(atHour(day, 18));
      const wake = sleepUntil(adapter.now);
      assert.ok(wake !== null);
      adapter.advance(wake);
    }
    assert.deepEqual(a.world.snapshot(), b.world.snapshot());
    assert.equal(a.viewModel().daily.length, day);
    assert.equal(a.viewModel().plants[0].dayInStage, 5 + day);
  }
});
