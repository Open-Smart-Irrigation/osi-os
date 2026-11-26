import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bedtimeCard, openedValveRuns, referenceSentence, runFigures, sliceReport, timerComparison,
  type RunFigures, type ValveRun, type WaterFigures,
} from '../../src/core/report';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {MINUTE_MS} from '../../src/core/time';
import {World} from '../../src/core/world';
import type {WorldDayView} from '../../src/core/types';
import timerReferences from '../../src/scenarios/reference-summary.json';

/** The run a report belongs to: a T4 run of the baseline scenario, which has a timer reference. */
const T4 = {scenario: 'baseline', tier: 4} as const;

const day: WorldDayView = {
  date: '2027-01-11', at: 10, rainMm: 2, irrigationLiters: {can: 2, tap: 10, valve: 0},
  runoffLiters: 6, percolationLiters: 12, applicationLossLiters: 1, waterEnergy: 3,
  pumpStrokes: 4, carryTrips: 1, soilWaterMm: {start: 150, end: 148.5},
  waterMinutes: 9, meanKs: .75, stressDay: true, pickedKg: .1, lostKg: .001,
  waterProductivityKgPerM3: 8.33, cutoffs: [],
};

test('bedtime uses applied litres, picked kilograms and remaining energy', () => {
  assert.deepEqual(bedtimeCard(day, 97), {appliedLiters: 11, pickedKg: .1, energyLeft: 97});
});

test('report totals actual volume and computes productivity over the whole run', () => {
  const second = {...day, at: 20, date: '2027-01-12', meanKs: .9, stressDay: false,
    irrigationLiters: {can: 0, tap: 0, valve: 20}, pumpStrokes: 6, carryTrips: 0,
    soilWaterMm: {start: 148.5, end: 151.25}, pickedKg: .35,
    cutoffs: [{at: 15, liters: {estimated: 20.1, delivered: 20}}]};
  const runs: ValveRun[] = [{trigger: 'manual', openedAt: 12}];
  const {days, total, valveRuns} = sliceReport({daily: [day], today: second}, runs, T4);
  assert.deepEqual(days, [day, second]);
  assert.deepEqual(valveRuns, runs);
  assert.deepEqual(total, {
    rainMm: 4, irrigationLiters: {can: 2, tap: 10, valve: 20}, runoffLiters: 12,
    percolationLiters: 24, applicationLossLiters: 2, waterEnergy: 6, pumpStrokes: 10, carryTrips: 1,
    soilWaterMm: {start: 150, end: 151.25}, waterMinutes: 18,
    stressDays: 1, pickedKg: .45, lostKg: .002, waterProductivityKgPerM3: 14.06, cutoffs: second.cutoffs,
  });
  const dry = {...day, irrigationLiters: {can: 0, tap: 0, valve: 0}};
  assert.equal(sliceReport({daily: [dry], today: dry}, [], T4).total.waterProductivityKgPerM3, null);
  assert.equal(sliceReport({daily: [dry], today: dry}, [], T4).days.length, 1);
});


test('HUD and bedtime can account for water delivered between soil steps', () => {
  const header = defaultHeader('test');
  const world = new World(header, TUTORIAL_SCENARIO);
  const at = header.start + MINUTE_MS;
  assert.ok(world.setManualTap(header.start, true));
  assert.equal(world.viewModel(at).today.irrigationLiters.tap, 8);
  assert.equal(bedtimeCard(world.dayAt(at), world.energyLeft).appliedLiters, 7.2);
  assert.equal(world.committedAt, header.start);
});

const timer: WaterFigures = {
  irrigationDays: 14, liters: 5000, pumpStrokes: 250, carryTrips: 0, harvestedKg: 20, stressDays: 0, soilWaterEndMm: 160,
};
const trigger: RunFigures = {
  triggerOnly: true, irrigationDays: 6, liters: 2500, pumpStrokes: 125, carryTrips: 0, harvestedKg: 20, stressDays: 0,
  soilWaterEndMm: 130,
};
const compare = (run: Partial<RunFigures>, reference: Partial<WaterFigures> = {}) =>
  timerComparison({...trigger, ...run}, {...timer, ...reference});
const sentence = (run: Partial<RunFigures>, reference: Partial<WaterFigures> = {}): string => {
  const text = compare(run, reference);
  assert.ok(text !== null);
  return text;
};

test('the T4 sentence takes its day counts from the run and the reference', () => {
  assert.equal(sentence({}), 'The soil-triggered valve watered on 6 of the 14 days and the daily timer'
    + ' (reference run, same weather) on 14: about the same tomatoes, 20.00 kg against 20.00 kg, for half the water'
    + ' and half the pumping. The root zone ended 30 mm drier, about 1,920 L the soil has lent.');
  assert.match(sentence({irrigationDays: 9}, {irrigationDays: 12}), /watered on 9 of the 14 days .* on 12: /);
});

test('the T4 sentence names the soil trigger only when the trigger opened every valve run', () => {
  assert.match(sentence({}), /^The soil-triggered valve watered on 6 of the 14 days and /);
  assert.equal(sentence({triggerOnly: false}), 'Your valve watered on 6 of the 14 days and the daily timer'
    + ' (reference run, same weather) on 14: about the same tomatoes, 20.00 kg against 20.00 kg, for half the water'
    + ' and half the pumping. The root zone ended 30 mm drier, about 1,920 L the soil has lent.');
});

test('the T4 sentence prints both harvests and calls them about the same only within 3 %', () => {
  assert.match(sentence({}), /: about the same tomatoes, 20\.00 kg against 20\.00 kg, for /);
  // Exactly 3 %; in floating point |19.4 - 20| / 20 is 0.030000000000000072.
  assert.match(sentence({harvestedKg: 19.4}), /: about the same tomatoes, 19\.40 kg against 20\.00 kg, for /);
  assert.match(sentence({harvestedKg: 20.6}), /: about the same tomatoes, 20\.60 kg against 20\.00 kg, for /);
  // 3.01 %.
  assert.match(sentence({harvestedKg: 19.398}), /: fewer tomatoes, 19\.40 kg against 20\.00 kg, for /);
  assert.match(sentence({harvestedKg: 20.602}), /: more tomatoes, 20\.60 kg against 20\.00 kg, for /);
  // The storm reference runs: 3.2 % apart.
  assert.match(sentence({harvestedKg: 23.168}, {harvestedKg: 23.936}), /: fewer tomatoes, 23\.17 kg against 23\.94 kg, for /);
});

test('the T4 sentence says half only for a share from 0.45 to 0.55, otherwise the whole percentage', () => {
  for (const liters of [2250, 2500, 2750]) assert.match(sentence({liters}), / for half the water and /);
  assert.match(sentence({liters: 2249.95}), / for 45 % of the water and /);
  assert.match(sentence({liters: 2750.05}), / for 55 % of the water and /);
  // No special case for 40 % and 60 %: the share rounds normally, halves up.
  assert.match(sentence({liters: 2000}), / for 40 % of the water and /);
  assert.match(sentence({liters: 3000}), / for 60 % of the water and /);
  assert.match(sentence({liters: 2124}), / for 42 % of the water and /);
  assert.match(sentence({liters: 2125}), / for 43 % of the water and /);
  // Exact shares stay exact: 5500 / 5000 * 100 is 110.00000000000001 in floating point.
  assert.match(sentence({liters: 5500}), / for 110 % of the water and /);
  assert.match(sentence({liters: 350}), / for 7 % of the water and /);
  assert.match(sentence({liters: 10}), / for under 1 % of the water and /);
  assert.match(sentence({liters: 0}), / for 0 % of the water and /);
  for (const pumpStrokes of [90, 110]) assert.match(sentence({pumpStrokes}, {pumpStrokes: 200}), / and half the pumping\. /);
  assert.match(sentence({pumpStrokes: 89}, {pumpStrokes: 200}), / and 45 % of the pumping\. /);
  assert.match(sentence({pumpStrokes: 111}, {pumpStrokes: 200}), / and 56 % of the pumping\. /);
  assert.match(sentence({pumpStrokes: 161}, {pumpStrokes: 269}), / and 60 % of the pumping\. /);
});

test('the T4 sentence counts shared-well trips whenever either run made any', () => {
  assert.doesNotMatch(sentence({}), /shared well/);
  assert.match(sentence({}, {carryTrips: 22}),
    /, for half the water, half the pumping and no trips to the shared well against 22\. The root zone ended /);
  assert.match(sentence({carryTrips: 3}), / and 3 trips to the shared well against none\. /);
  assert.match(sentence({carryTrips: 1}, {carryTrips: 1}), / and 1 trip to the shared well against 1\. /);
  assert.match(sentence({carryTrips: 5}, {carryTrips: 5}), / and 5 trips to the shared well against 5\. /);
});

// Council r2, Fable S13: the stress days are bed A's, so the sentence names the bed.
test('the T4 sentence adds bed A\'s stress days only when they differ from the reference', () => {
  assert.doesNotMatch(sentence({}), /stress/);
  assert.match(sentence({stressDays: 2}),
    /pumping\. Bed A had 2 stress days against none, and the root zone ended 30 mm drier, about 1,920 L the soil has lent\.$/);
  assert.match(sentence({stressDays: 1}), /\. Bed A had 1 stress day against none, and the root zone ended /);
  assert.match(sentence({stressDays: 0}, {stressDays: 3}), /\. Bed A had no stress days against 3, and the root zone /);
  assert.match(sentence({stressDays: 3}, {stressDays: 1}), /\. Bed A had 3 stress days against 1, and the root zone /);
  assert.doesNotMatch(sentence({stressDays: 2}, {stressDays: 2}), /stress/);
  assert.match(sentence({stressDays: 2}, {stressDays: 2}), /pumping\. The root zone ended /);
});

test('the T4 sentence gives the root zone in whole mm with the litres lent or held, the same within 0.5 mm', () => {
  for (const soilWaterEndMm of [159.5, 160.5]) assert.match(sentence({soilWaterEndMm}), /\. The root zone ended the same\.$/);
  // Litres are the printed whole mm times 64 m², to the nearest 10 L: 64 L rounds down, 128 L up.
  assert.match(sentence({soilWaterEndMm: 159.49}), /\. The root zone ended 1 mm drier, about 60 L the soil has lent\.$/);
  assert.match(sentence({soilWaterEndMm: 160.51}), /\. The root zone ended 1 mm wetter, about 60 L more held in the soil\.$/);
  assert.match(sentence({soilWaterEndMm: 158}), /\. The root zone ended 2 mm drier, about 130 L the soil has lent\.$/);
  assert.match(sentence({soilWaterEndMm: 172.4}), /\. The root zone ended 12 mm wetter, about 770 L more held in the soil\.$/);
  assert.match(sentence({soilWaterEndMm: 144}), /\. The root zone ended 16 mm drier, about 1,020 L the soil has lent\.$/);
  // The baseline reference runs: 35.23 mm prints as 35 mm, so 35 x 64 L.
  assert.match(sentence({soilWaterEndMm: 129.68}, {soilWaterEndMm: 164.91}),
    /\. The root zone ended 35 mm drier, about 2,240 L the soil has lent\.$/);
  assert.match(sentence({soilWaterEndMm: 0}), /\. The root zone ended 160 mm drier, about 10,240 L the soil has lent\.$/);
  // In floating point 127.52 - 128.02 is -0.5000000000000142.
  assert.match(sentence({soilWaterEndMm: 127.52}, {soilWaterEndMm: 128.02}), /\. The root zone ended the same\.$/);
});

test('the T4 sentence is left out without a harvest or a usable reference', () => {
  assert.equal(compare({harvestedKg: 0}), null);
  assert.equal(compare({}, {harvestedKg: 0}), null);
  assert.equal(compare({}, {liters: 0}), null);
  assert.equal(compare({}, {pumpStrokes: 0}), null);
});

/**
 * Fourteen slice days and the final morning: the valve runs on even days and on the final morning,
 * the farmer carries from the shared well on odd days and the final morning, and the last four
 * slice days and the final morning are stress days.
 */
function fourteenDays(): WorldDayView[] {
  return Array.from({length: 15}, (_, i) => ({
    ...day, date: '2027-01-' + (11 + i), at: 1_000 * (i + 1),
    irrigationLiters: {can: i === 0 ? 5 : 0, tap: 0, valve: i % 2 === 1 || i === 14 ? 360 : 0},
    pumpStrokes: i % 2 === 1 || i === 14 ? 18 : 0, pickedKg: 1.5,
    carryTrips: i % 2 === 0 ? 1 : 0, stressDay: i >= 10,
    soilWaterMm: {start: 152 - i, end: 151 - i + (i === 14 ? 4 : 0)},
  }));
}

/** The soil trigger opens the valve on each fourteenDays() day with valve water, the final morning included. */
function triggerRuns(): ValveRun[] {
  return [1, 3, 5, 7, 9, 11, 13, 14].map(i => ({trigger: 'trigger_based', openedAt: 1_000 * i + 250}));
}

test('run figures cover the first 14 day records and leave out the final morning', () => {
  const days = fourteenDays();
  const report = sliceReport({daily: days.slice(0, 14), today: days[14]}, triggerRuns(), T4);
  assert.deepEqual(runFigures(report),
    {triggerOnly: true, irrigationDays: 7, liters: 2525, pumpStrokes: 126, carryTrips: 7, harvestedKg: 21,
      stressDays: 4, soilWaterEndMm: 138});
  assert.equal(runFigures(sliceReport({daily: days.slice(0, 13), today: days[13]}, triggerRuns(), T4)), null);
});

test('run figures credit the soil trigger only when it opened every valve run in the 14 days', () => {
  const days = fourteenDays();
  const triggerOnly = (runs: ValveRun[]) =>
    runFigures(sliceReport({daily: days.slice(0, 14), today: days[14]}, runs, T4))?.triggerOnly;
  assert.equal(triggerOnly(triggerRuns()), true);
  for (const trigger of ['manual', 'on_valve_schedule', 'service_action', null]) {
    assert.equal(triggerOnly([...triggerRuns(), {trigger, openedAt: 1_600}]), false, String(trigger));
  }
  assert.equal(triggerOnly([]), false);
  // The 14th day record ends at 14 000: a run that opens then belongs to the final morning.
  assert.equal(triggerOnly([...triggerRuns(), {trigger: 'manual', openedAt: 14_000}]), true);
  assert.equal(triggerOnly([...triggerRuns(), {trigger: 'manual', openedAt: 13_999}]), false);
});

test('opened valve runs come from the outcomes the simulator saw open', () => {
  assert.deepEqual(openedValveRuns([
    {trigger: 'trigger_based', observedOpenAt: '2027-01-12T03:00:02.000Z'},
    {trigger: 'manual', observedOpenAt: null},
    {trigger: null, observedOpenAt: '2027-01-11T03:30:02.000Z'},
  ]), [
    {trigger: 'trigger_based', openedAt: Date.parse('2027-01-12T03:00:02.000Z')},
    {trigger: null, openedAt: Date.parse('2027-01-11T03:30:02.000Z')},
  ]);
});

test('the report sentence appears for T4 runs in a scenario with a timer reference only', () => {
  const days = fourteenDays();
  const report = sliceReport({daily: days.slice(0, 14), today: days[14]}, triggerRuns(), T4);
  const run = runFigures(report);
  assert.ok(run);
  const expected = timerComparison(run, timerReferences.baseline);
  assert.ok(expected);
  assert.equal(referenceSentence(report, 'baseline', 4), expected);
  assert.match(expected, /^The soil-triggered valve watered on 7 of the 14 days and the daily timer \(reference run, same weather\) on 14: /);
  for (const tier of [0, 1, 2, 3] as const) assert.equal(referenceSentence(report, 'baseline', tier), null);
  assert.equal(referenceSentence(report, 'unknown', 4), null);
  const manual = sliceReport({daily: days.slice(0, 14), today: days[14]}, [...triggerRuns(), {trigger: 'manual', openedAt: 1_600}], T4);
  assert.match(referenceSentence(manual, 'baseline', 4) ?? '', /^Your valve watered on 7 of the 14 days and the daily timer \(reference run, same weather\) on 14: /);
  assert.equal(referenceSentence(sliceReport({daily: days.slice(0, 13), today: days[13]}, triggerRuns(), T4), 'baseline', 4), null);
  const noHarvest = days.map(record => ({...record, pickedKg: 0}));
  assert.equal(referenceSentence(sliceReport({daily: noHarvest.slice(0, 14), today: noHarvest[14]}, triggerRuns(), T4), 'baseline', 4), null);
});

// Council r1, Fable S8: ui/ imports only types from core, so the report carries the sentence.
test('the slice report carries the sentence for its own run', () => {
  const days = fourteenDays();
  const report = (run: {scenario: string; tier: 0 | 1 | 2 | 3 | 4}) =>
    sliceReport({daily: days.slice(0, 14), today: days[14]}, triggerRuns(), run).comparison;
  assert.equal(report(T4), timerComparison(runFigures(sliceReport({daily: days.slice(0, 14), today: days[14]}, triggerRuns(), T4))!,
    timerReferences.baseline));
  assert.match(report(T4) ?? '', /^The soil-triggered valve watered on 7 of the 14 days/);
  assert.equal(report({scenario: 'baseline', tier: 3}), null);
  assert.equal(report({scenario: 'unknown', tier: 4}), null);
});
