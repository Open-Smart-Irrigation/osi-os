import assert from 'node:assert/strict';
import test from 'node:test';
import {BED_A_ZONE, BED_B_TOP_LEFT} from '../../src/core/map';
import {FarmOsiAdapter} from '../../src/core/osi/adapter';
import {PROBE_EUI, VALVE_EUI} from '../../src/core/osi/farm-builder';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS, HOUR_MS, MINUTE_MS, localDayStart} from '../../src/core/time';
import {deepDrying, rollingTransplant, Tutorial} from '../../src/core/tutorial';
import type {Scenario} from '../../src/core/types';
import {World} from '../../src/core/world';
import {tutorialHint} from '../../src/ui/hints';

test('day two leaf rolling follows bed B transplant state, then describes the same plant at recovery', () => {
  const header = defaultHeader('test');
  const scenario: Scenario = {...TUTORIAL_SCENARIO, initial: {
    ...TUTORIAL_SCENARIO.initial, bedB: {...TUTORIAL_SCENARIO.initial.bedB, depletion: [.15, .4, .3, .25, .2]},
  }};
  const world = new World(header, scenario);
  const shallow = {...BED_B_TOP_LEFT};
  const tutorial = new Tutorial(header.start, true, header.tier);
  const feedback = {tutorial: tutorial.state(), bedtime: undefined, notice: undefined,
    sleepCount: 0, report: undefined, manualTapOpen: false};
  const dayTwo = localDayStart(header.start) + DAY_MS;
  assert.ok(world.till(header.start, shallow));
  assert.ok(world.transplant(header.start, shallow));
  tutorial.action({text: '', decision: 'plant'}, header.start);
  feedback.tutorial = tutorial.state();
  const view = (hour: number) => {
    const at = dayTwo + hour * HOUR_MS;
    world.stepTo(at);
    return world.viewModel(at);
  };
  assert.equal(rollingTransplant(view(12)), undefined);
  const midday = view(15);
  const rolled = rollingTransplant(midday);
  assert.deepEqual(rolled, shallow);
  assert.equal(tutorialHint(midday, feedback, rolled), 'A bed B transplant is rolling its leaves. Its shallow roots reach '
    + 'only the top few centimetres, which dry first. Water it with the can and look at it again this evening.');
  assert.match(tutorialHint(view(18), feedback, rolled) ?? '', /same bed B transplant/);
});

test('an observed 20 cm change is stated in kPa and asks for an evening check', () => {
  const header = defaultHeader('test', TUTORIAL_SCENARIO, 1);
  const world = new World(header, TUTORIAL_SCENARIO);
  const at = header.start + 2 * DAY_MS;
  world.stepTo(at);
  const feedback = {
    tutorial: {...new Tutorial(header.start, true, header.tier).state(),
      observed: {beforeKpa: 56.3, afterKpa: 52.1, changeKpa: -4.2, sampledAt: at}},
    bedtime: undefined, notice: undefined, sleepCount: 0, report: undefined, manualTapOpen: false,
  };
  assert.equal(tutorialHint(world.viewModel(at), feedback, undefined),
    'The 20 cm reading is down 4.2 kPa since before the run. Check both readings again this evening.');
});

test('after the day-3 run the hint says when the comparison comes, without promising one after midnight or sleep', () => {
  const header = defaultHeader('test', TUTORIAL_SCENARIO, 1);
  const world = new World(header, TUTORIAL_SCENARIO);
  const at = header.start + 2 * DAY_MS;
  world.stepTo(at);
  const feedback = {
    tutorial: {...new Tutorial(header.start, true, header.tier).state(), dripStart: at - HOUR_MS, dripEnd: at},
    bedtime: undefined, notice: undefined, sleepCount: 0, report: undefined, manualTapOpen: false,
  };
  // Council r2, Fable S14: the last day-3 reading is at 23:30, so a run that ends at 21:45 gets no figure, sleep skips
  // the evening readings, and a run on an empty tank delivers no water to compare. The text states the conditions
  // instead of promising the comparison.
  assert.equal(tutorialHint(world.viewModel(at), feedback, undefined),
    'Water takes a while to sink in. If the run wet bed A and you are awake for a probe reading two or more hours '
      + 'after it ends and before midnight, the hint shows the 20 cm change.');
});

const DAY_ONE = localDayStart(TUTORIAL_SCENARIO.start);
const sevenAm = (day: number) => DAY_ONE + (day - 1) * DAY_MS + 7 * HOUR_MS;

test('deep drying needs 20 cm under the trigger threshold now, 40 cm above 50 kPa and a 10 kPa rise', () => {
  const at = sevenAm(9);
  const pair = (before: readonly [number, number], now: readonly [number, number]) => [
    {at: at - 2 * DAY_MS, values: {swt_1: before[0], swt_2: before[1]}},
    {at, values: {swt_1: now[0], swt_2: now[1]}},
    {at: at + 30 * MINUTE_MS, values: {swt_1: 40, swt_2: 40}},
  ];
  assert.deepEqual(deepDrying(pair([23.1, 54.6], [24.76, 66.09]), at, 25),
    {sampledAt: at, thresholdKpa: 25, shallowKpa: 24.76, deepBeforeKpa: 54.6, deepKpa: 66.09, riseKpa: 11.49});
  assert.equal(deepDrying(pair([23.1, 56.09], [24.76, 66.09]), at, 25)?.riseKpa, 10);
  assert.equal(deepDrying(pair([23.1, 54.6], [25, 66.09]), at, 25), null, '20 cm at the 25 kPa threshold now');
  assert.equal(deepDrying(pair([27.2, 54.6], [24.76, 66.09]), at, 25)?.shallowKpa, 24.76,
    '20 cm above the threshold two days earlier, on the morning of a run');
  assert.equal(deepDrying(pair([23.1, 54.6], [32, 66.09]), at, 35)?.thresholdKpa, 35, 'a 35 kPa trigger, 20 cm at 32 kPa');
  assert.equal(deepDrying(pair([20, 54.6], [24, 66.09]), at, 22), null, 'a 22 kPa trigger, 20 cm at 24 kPa');
  assert.equal(deepDrying(pair([23.1, 38], [24.76, 50]), at, 25), null, '40 cm at the 50 kPa dry edge');
  assert.equal(deepDrying(pair([23.1, 56.1], [24.76, 66.09]), at, 25), null, '40 cm up 9.99 kPa');
  assert.equal(deepDrying(pair([23.1, 54.6], [24.76, 66.09]).slice(1), at, 25), null, 'no reading two days earlier');
});

type ProbeSample = ReturnType<FarmOsiAdapter['probeSamples']>[number];
type TriggerEvaluation = ReturnType<FarmOsiAdapter['triggerEvaluations']>[number];

type TriggerSchedule = {enabled: boolean; trigger_metric: string; threshold_kpa: number};
const PRESET: TriggerSchedule = {enabled: true, trigger_metric: 'SWT_1', threshold_kpa: 25};

/**
 * Serves scripted probe uplinks, trigger evaluations, bed A's trigger and the valve plans through the adapter
 * methods the tutorial reads.
 */
class UplinkFeed extends FarmOsiAdapter {
  readonly samples: ProbeSample[] = [];
  readonly evaluations: TriggerEvaluation[] = [];
  readonly plans: [valveEui: string, plans: unknown[]][] = [];
  /** The simulator clock; by default the newest uplink's instant. */
  clock: number | undefined;
  constructor(private readonly schedule: TriggerSchedule | null = PRESET) {
    super({dispatcher: {dispatchQueued: () => undefined, dispatchPhone: () => { throw new Error('No phone in this test'); }}});
  }
  override get now() { return this.clock ?? this.samples[this.samples.length - 1]?.at ?? TUTORIAL_SCENARIO.start; }
  override latestProbeSample() { return this.samples[this.samples.length - 1]; }
  override probeSamples() { return structuredClone(this.samples); }
  override triggerEvaluations() { return this.evaluations; }
  override zones() {
    return [{id: BED_A_ZONE, schedule: this.schedule}] as unknown as ReturnType<FarmOsiAdapter['zones']>;
  }
  override valvePlans() {
    return new Map(this.plans) as unknown as ReturnType<FarmOsiAdapter['valvePlans']>;
  }
  override simulatorSnapshot(): ReturnType<FarmOsiAdapter['simulatorSnapshot']> {
    throw new Error('The tutorial reads zones() and valvePlans(), never the detached snapshot');
  }
}

/**
 * The 40 cm reading climbs 10 kPa a day. The 20 cm reading is 20 kPa from `wetFrom` on and 40 kPa before, so
 * every 07:00 uplink from day `wetFrom` (and from day 3) meets the deep-drying readings under a trigger above
 * 20 kPa. At 06:00 each day the trigger evaluates the metric `metricOn` returns for that day, newest first as in
 * the simulator; undefined means no evaluation, as with the schedule off.
 */
function scriptedDeepDrying(tier: number, enabled = true, wetFrom = 1,
  metricOn: (day: number) => string | undefined = () => 'SWT_1', schedule: TriggerSchedule | null = PRESET) {
  const tutorial = new Tutorial(TUTORIAL_SCENARIO.start, enabled, tier);
  const feed = new UplinkFeed(schedule);
  for (let at = TUTORIAL_SCENARIO.start; at < DAY_ONE + 14 * DAY_MS; at += 30 * MINUTE_MS) {
    const day = 1 + (localDayStart(at) - DAY_ONE) / DAY_MS;
    const metric = metricOn(day);
    if (at - localDayStart(at) === 6 * HOUR_MS && metric !== undefined) {
      feed.evaluations.unshift({zoneId: BED_A_ZONE, evaluatedAt: new Date(at).toISOString(), metric, status: 'skipped',
        reason: 'below_threshold', value: 20, threshold: 25, durationMinutes: null, valveEui: null, advisory: ''});
    }
    feed.samples.push({deviceEui: PROBE_EUI, at, source: 'synthetic',
      values: {swt_1: day >= wetFrom ? 20 : 40, swt_2: 40 + 10 * (day - 1)}});
    tutorial.observe(feed);
  }
  return tutorial.state().deepDrying;
}

test('the deep-drying beat waits for day 8, fires once, and only in a T4 tutorial with hints on', () => {
  assert.deepEqual(scriptedDeepDrying(4), {day: 8, sampledAt: sevenAm(8), thresholdKpa: 25, shallowKpa: 20,
    deepBeforeKpa: 90, deepKpa: 110, riseKpa: 20});
  assert.equal(scriptedDeepDrying(4, true, 10)?.day, 10, 'readings first match on day 10');
  assert.equal(scriptedDeepDrying(4, true, 11), null, 'readings first match on day 11');
  assert.equal(scriptedDeepDrying(3), null);
  assert.equal(scriptedDeepDrying(4, false), null);
});

test('the deep-drying beat tests the 20 cm reading against the threshold of bed A\'s trigger as the phone sets it', () => {
  const beat = (schedule: TriggerSchedule | null) => scriptedDeepDrying(4, true, 1, () => 'SWT_1', schedule);
  assert.equal(beat({...PRESET, threshold_kpa: 35})?.thresholdKpa, 35);
  assert.equal(beat({...PRESET, threshold_kpa: 20}), null, '20 cm at the 20 kPa threshold');
  assert.equal(beat({...PRESET, enabled: false}), null, 'trigger off, although the phone lists SWT_1 evaluations');
  assert.equal(beat({...PRESET, trigger_metric: 'SWT_AVG'}), null, 'trigger on the mean of the depths');
  assert.equal(beat(null), null, 'no trigger');
});

test('the deep-drying beat needs a trigger evaluation on the 20 cm reading in the two days before the reading', () => {
  const beat = (metricOn: (day: number) => string | undefined) => scriptedDeepDrying(4, true, 1, metricOn);
  assert.equal(beat(() => undefined), null, 'no evaluations: the schedule is off');
  assert.equal(beat(() => 'SWT_AVG'), null, 'the trigger reads the mean of the depths');
  assert.equal(beat(() => 'SWT_2'), null, 'the trigger reads the 40 cm depth');
  assert.equal(beat(day => day <= 6 ? 'SWT_1' : undefined), null,
    'the last check, day 6 at 06:00, is before day 6 at 07:00');
  assert.equal(beat(day => day <= 7 ? 'SWT_1' : undefined)?.day, 8, 'day 7 at 06:00 is inside the day-8 window');
});

const noFeedback = {bedtime: undefined, notice: undefined, sleepCount: 0, report: undefined, manualTapOpen: false};

test('the deep-drying hint quotes the trigger threshold and the 40 cm readings in whole kPa on the day it fired', () => {
  const header = defaultHeader('test', TUTORIAL_SCENARIO, 4);
  const world = new World(header, TUTORIAL_SCENARIO);
  const view = (day: number) => {
    const at = DAY_ONE + (day - 1) * DAY_MS + 8 * HOUR_MS;
    world.stepTo(at);
    return world.viewModel(at);
  };
  const deep = {day: 9, sampledAt: sevenAm(9), thresholdKpa: 25, shallowKpa: 24.76, deepBeforeKpa: 54.6, deepKpa: 66.09,
    riseKpa: 11.49};
  const feedback = (deepDrying: typeof deep) => ({...noFeedback,
    tutorial: {...new Tutorial(header.start, true, header.tier).state(), deepDrying}});
  const dayNine = view(9);
  assert.equal(tutorialHint(dayNine, feedback(deep), undefined),
    'The 40 cm reading went from 55 to 66 kPa in two days, while the 20 cm reading is under the trigger\'s 25 kPa threshold. '
    + 'The runs are too short to reach deep, and the trigger only knows the depth it reads. '
    + 'To lengthen each run, raise Duration (min) under Trigger-based irrigation on the phone, '
    + 'then compare the 40 cm reading on the morning after the trigger\'s next run with the one before it.');
  assert.match(tutorialHint(dayNine, feedback({...deep, thresholdKpa: 35}), undefined) ?? '', /the trigger's 35 kPa threshold/);
  assert.equal(tutorialHint(view(10), feedback(deep), undefined), undefined);
});

type Decision = 'feel' | 'can' | 'pick' | 'pump' | 'tap' | 'plant' | 'carry';

/**
 * The hint at noon on `day` after the player made `actions`, each at 09:00 on its day, unprompted or not; `plan`
 * marks an enabled weekly plan on the phone as the tutorial records it on day 5.
 */
function hintAfter(tier: 1 | 2 | 3 | 4, actions: readonly [decision: Decision, day: number][], day: number, plan = false) {
  const header = defaultHeader('test', TUTORIAL_SCENARIO, tier);
  const tutorial = new Tutorial(header.start, true, header.tier);
  for (const [decision, on] of actions) tutorial.action({text: '', decision}, DAY_ONE + (on - 1) * DAY_MS + 9 * HOUR_MS);
  const state = tutorial.state();
  if (plan) state.practiced.push('plan');
  const world = new World(header, TUTORIAL_SCENARIO);
  const at = Math.max(header.start, DAY_ONE + (day - 1) * DAY_MS + 12 * HOUR_MS);
  world.stepTo(at);
  return tutorialHint(world.viewModel(at), {...noFeedback, tutorial: state}, undefined);
}

test('an action hint is skipped once the player has made its own action, asked or not', () => {
  const dayOne: [Decision, number][] = [['pick', 1], ['feel', 1], ['can', 1], ['pump', 1], ['tap', 1]];
  assert.equal(hintAfter(1, [['plant', 1], ...dayOne], 1), 'Go to the house after 18:00 to sleep.',
    'planting before the hint asked ends the planting hint');
  assert.equal(hintAfter(1, dayOne, 1),
    'Till one tile in bed B and transplant a seedling. Look for leaf rolling tomorrow.');
  assert.equal(hintAfter(1, [['pick', 1], ['feel', 1], ['pump', 1]], 1), 'Fill the can at the tank, then water a tile in bed A.');
  assert.equal(hintAfter(1, [], 2), 'Use the hoe and a seedling on bed B so you can watch a shallow transplant.');
  assert.equal(hintAfter(1, [['plant', 1]], 2), undefined, 'planted on day 1, nothing rolling');
  const planHint = 'Set a weekly plan for 07:00 on the phone. Visit the shared well while the plan waters bed A.';
  assert.equal(hintAfter(3, [], 5), planHint);
  assert.equal(hintAfter(3, [], 5, true), undefined, 'the phone holds an enabled weekly plan');
});

test('a keen player who waters, taps and plants on day 1 before being asked still sees the concept hints', () => {
  const keen: [Decision, number][] = [['can', 1], ['tap', 1], ['plant', 1], ['pump', 1], ['carry', 1], ['can', 2],
    ['tap', 2], ['feel', 2], ['pick', 2], ['pump', 3], ['carry', 3]];
  assert.equal(hintAfter(2, keen, 3), 'Check the 20 and 40 cm probe readings before and after a drip run.');
  assert.equal(hintAfter(2, keen, 4),
    'Open the Water tab on the phone. Use the game calculator to turn ET0 and Kc into litres for bed A.');
  assert.equal(hintAfter(4, keen, 6), 'Set a soil threshold and watering duration on the phone. Sleep and watch the 06:00 decision.');
});

test('on day 5 at T3 and T4 the tutorial notes an enabled weekly plan on the phone, checked after each uplink', () => {
  const practicedPlan = (tier: number, planFrom: number | null, plan: object = {kind: 'WEEKLY', enabled: true}) => {
    const tutorial = new Tutorial(TUTORIAL_SCENARIO.start, true, tier);
    const feed = new UplinkFeed();
    for (let at = TUTORIAL_SCENARIO.start; at < DAY_ONE + 7 * DAY_MS; at += 30 * MINUTE_MS) {
      if (planFrom !== null && at >= planFrom && !feed.plans.length) feed.plans.push([VALVE_EUI, [plan]]);
      feed.samples.push({deviceEui: PROBE_EUI, at, source: 'synthetic', values: {swt_1: 20, swt_2: 40}});
      tutorial.observe(feed);
      if (at >= DAY_ONE + 4 * DAY_MS + 11 * HOUR_MS) return tutorial.state().practiced.includes('plan');
    }
    throw new Error('day 5 at 11:00 was not reached');
  };
  assert.equal(practicedPlan(3, null), false);
  assert.equal(practicedPlan(3, DAY_ONE + 3 * DAY_MS + 20 * HOUR_MS), true, 'plan set on day 4');
  assert.equal(practicedPlan(4, DAY_ONE + 4 * DAY_MS + 10 * HOUR_MS), true, 'plan set on day 5 at 10:00');
  assert.equal(practicedPlan(2, DAY_ONE + 3 * DAY_MS + 20 * HOUR_MS), false, 'T2 has no valve');
  const once = {kind: 'ONCE', enabled: true, once_state: 'FIRED'};
  assert.equal(practicedPlan(3, DAY_ONE + 3 * DAY_MS + 20 * HOUR_MS, once), false, 'a one-time open that already ran');
  assert.equal(practicedPlan(3, DAY_ONE + 3 * DAY_MS + 20 * HOUR_MS, {kind: 'WEEKLY', enabled: false}), false,
    'a disabled weekly plan');
});

test('the tutorial checks the weekly plan on entering day 5, before any day-5 uplink', () => {
  const tutorial = new Tutorial(TUTORIAL_SCENARIO.start, true, 3);
  const feed = new UplinkFeed();
  feed.plans.push([VALVE_EUI, [{kind: 'WEEKLY', enabled: true}]]);
  for (let at = TUTORIAL_SCENARIO.start; at < DAY_ONE + 4 * DAY_MS; at += 30 * MINUTE_MS) {
    feed.samples.push({deviceEui: PROBE_EUI, at, source: 'synthetic', values: {swt_1: 20, swt_2: 40}});
    tutorial.observe(feed);
  }
  assert.equal(tutorial.state().practiced.includes('plan'), false, 'a plan on day 4 does not count yet');
  feed.clock = DAY_ONE + 4 * DAY_MS + MINUTE_MS;
  tutorial.observe(feed);
  assert.ok(tutorial.state().practiced.includes('plan'));
});
