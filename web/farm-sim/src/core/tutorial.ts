import {BED_A_ZONE} from './map';
import type {FarmOsiAdapter} from './osi/adapter';
import type {IrrigationEvent, TileRef, ViewModel} from './types';
import type {ActionResult} from './player-actions';
import {DAY_MS, HOUR_MS, localDayStart} from './time';
import {round2} from './units';

type ProbeComparison = {beforeKpa: number; afterKpa: number; changeKpa: number; sampledAt: number};
type ProbeSample = Readonly<{at: number; values: Readonly<Record<string, unknown>>}>;
type DeepDrying = {
  day: number; sampledAt: number; thresholdKpa: number; shallowKpa: number; deepBeforeKpa: number; deepKpa: number;
  riseKpa: number;
};
type TriggerRow = Readonly<{evaluatedAt: string; metric: string}>;

/**
 * The T4 deep-drying beat (plan 7.4) reads the 07:00 uplink on days 8 to 10. Thresholds are [tune], measured on
 * the T4 reference preset in every scenario: the 20 cm reading under the threshold of bed A's trigger, as the phone
 * shows and sets it, and the 40 cm reading above the phone's 50 kPa dry edge and at least 10 kPa higher than two
 * days earlier. The 20 cm reading of two days earlier is not tested: the trigger holds that depth near its threshold,
 * so that reading is often just above it, and a run it started then is evidence for the hint, not against it. The
 * hint blames the trigger, so the trigger must be on and read the 20 cm depth (SWT_1), and the phone must list an
 * evaluation of that reading in those two days.
 */
export const DEEP_DRYING = {
  firstDay: 8, lastDay: 10, hour: 7, deepAboveKpa: 50, riseKpa: 10, triggerMetric: 'SWT_1',
} as const;

/** Reads the uplink at or before `at`, and the 40 cm reading two days earlier, as the phone shows them. */
export function deepDrying(samples: readonly ProbeSample[], at: number,
  thresholdKpa: number): Omit<DeepDrying, 'day'> | null {
  const atOrBefore = (time: number): ProbeSample | undefined => {
    for (let index = samples.length - 1; index >= 0; index--) if (samples[index].at <= time) return samples[index];
    return undefined;
  };
  const now = atOrBefore(at);
  const shallow = now?.values.swt_1;
  const deep = now?.values.swt_2;
  const deepBefore = atOrBefore(at - 2 * DAY_MS)?.values.swt_2;
  if (!now || typeof shallow !== 'number' || typeof deep !== 'number' || typeof deepBefore !== 'number') return null;
  const riseKpa = round2(deep - deepBefore);
  return shallow < thresholdKpa && deep > DEEP_DRYING.deepAboveKpa && riseKpa >= DEEP_DRYING.riseKpa
    ? {sampledAt: now.at, thresholdKpa, shallowKpa: shallow, deepBeforeKpa: deepBefore, deepKpa: deep, riseKpa} : null;
}

/** The threshold of bed A's trigger as the phone shows it, or null unless that trigger is on and reads SWT_1. */
function shallowTriggerThreshold(adapter: FarmOsiAdapter): number | null {
  const schedule = adapter.zones().find(zone => zone.id === BED_A_ZONE)?.schedule;
  return schedule?.enabled && String(schedule.trigger_metric ?? '').toUpperCase() === DEEP_DRYING.triggerMetric
    && Number.isFinite(schedule.threshold_kpa) ? schedule.threshold_kpa : null;
}

/** True when the phone's trigger evaluations show a check of the 20 cm reading since two days before `at`. */
function shallowTriggerChecked(evaluations: readonly TriggerRow[], at: number): boolean {
  return evaluations.some(row => row.metric === DEEP_DRYING.triggerMetric
    && Date.parse(row.evaluatedAt) > at - 2 * DAY_MS);
}

/** The day-3 hint reports the probe this long after the drip run ends (plan 7.4); the goldens read it then too. */
export const DAY_THREE_HINT_DELAY_MS = 2 * HOUR_MS;

/** Litres the manual tap and bed A's valve delivered between `from` and `to`. */
function deliveredToBedA(adapter: FarmOsiAdapter, from: number, to: number): number {
  return adapter.world.manualTapLitersBetween(from, to) + adapter.litersBetween(BED_A_ZONE, from, to).delivered;
}

function probeComparison(adapter: FarmOsiAdapter, from: number, eligibleAt: number, through: number): ProbeComparison | null {
  const samples = adapter.probeSamples();
  const after = samples.find(sample => sample.at >= eligibleAt && sample.at <= through);
  if (!after) return null;
  const before = samples.reverse().find(sample => sample.at <= from);
  const beforeKpa = before?.values.swt_1;
  const afterKpa = after.values.swt_1;
  return typeof beforeKpa === 'number' && typeof afterKpa === 'number'
    ? {beforeKpa, afterKpa, changeKpa: round2(afterKpa - beforeKpa), sampledAt: after.at} : null;
}

export class Tutorial {
  /** Player decisions, plus 'plan' once the phone holds an enabled weekly plan on day 5; each ends its own hint. */
  private readonly practiced = new Set<NonNullable<ActionResult['decision']> | 'plan'>();
  private planCheckedAt: number | undefined;
  private planDayEntered = false;
  private dripStart: number | undefined;
  private dripEnd: number | undefined;
  /** On a reopen, keep dripStart only if the earlier run delivered water. */
  private reopenedAt: number | undefined;
  private observed: ProbeComparison | null = null;
  private valveUsed = false;
  private deep: DeepDrying | null = null;
  private deepCheckedDay = 0;

  constructor(private readonly start: number, private readonly enabled: boolean, private readonly tier: number) {}

  private day(at: number): number {
    return 1 + (localDayStart(at) - localDayStart(this.start)) / DAY_MS;
  }

  action(result: ActionResult, at: number): void {
    if (!this.enabled) return;
    if (result.decision) this.practiced.add(result.decision);
    // Run dispatches player commands at its current instant, after collectEvents() has observed every uplink through it.
    if (result.tapOpen !== undefined) this.drip(result.tapOpen, at);
  }

  irrigation(event: IrrigationEvent, adapter: FarmOsiAdapter): void {
    if (!this.enabled) return;
    if (event.kind === 'opened') {
      this.valveUsed = true;
      // Sleep can deliver a batch of yesterday's events after the day-3 hint has ended.
      if (this.day(adapter.now) === 3) this.compareDripThrough(adapter, event.at);
      this.drip(true, event.at);
    }
    if (event.kind === 'closed') this.drip(false, event.at);
  }

  /**
   * Plan 7.4 counts from the first day-3 run that delivered water. An open before an eligible uplink restarts
   * the two-hour wait. A same-instant uplink precedes the valve open and its comparison holds for the day.
   */
  private drip(open: boolean, at: number): void {
    if (this.tier < 1) return;
    if (open && this.day(at) === 3 && !this.observed) {
      if (this.dripStart === undefined) this.dripStart = at;
      else this.reopenedAt = at;
      this.dripEnd = undefined;
    }
    if (!open && this.dripStart !== undefined && this.dripEnd === undefined) this.dripEnd = at;
  }

  observe(adapter: FarmOsiAdapter): void {
    this.observePlan(adapter);
    this.observeDepths(adapter);
    if (this.dripStart === undefined || this.day(adapter.now) > 3) return;
    if (this.dripEnd === undefined && adapter.world.tankLitersAt(adapter.now) === 0) this.dripEnd = adapter.now;
    this.compareDripThrough(adapter, adapter.now);
  }

  private compareDripThrough(adapter: FarmOsiAdapter, through: number): void {
    if (this.dripStart === undefined || this.observed) return;
    if (this.reopenedAt !== undefined) {
      if (deliveredToBedA(adapter, this.dripStart, this.reopenedAt) === 0) this.dripStart = this.reopenedAt;
      this.reopenedAt = undefined;
    }
    if (this.dripEnd === undefined) return;
    const eligibleAt = this.dripEnd + DAY_THREE_HINT_DELAY_MS;
    if (through >= eligibleAt && (adapter.latestProbeSample()?.at ?? -Infinity) >= eligibleAt
      && deliveredToBedA(adapter, this.dripStart, this.dripEnd) > 0) {
      this.observed = probeComparison(adapter, this.dripStart, eligibleAt, through);
    }
  }

  /** The Run calls this right after the simulator accepted a phone write to the valve plans. */
  planWritten(adapter: FarmOsiAdapter): void {
    this.observePlan(adapter, true);
  }

  /**
   * On day 5 at T3 and T4, checks whether the phone holds an enabled weekly plan, the action the day-5 hint asks for:
   * on entering day 5, right after a plan write and after each new uplink. A one-time open or a disabled plan does not
   * count. None exists at start.
   */
  private observePlan(adapter: FarmOsiAdapter, written = false): void {
    if (!this.enabled || this.tier < 3 || this.practiced.has('plan')) return;
    const today = this.day(adapter.now) === 5;
    const newest = adapter.latestProbeSample()?.at;
    const uplink = newest !== undefined && newest !== this.planCheckedAt && this.day(newest) === 5;
    if (!uplink && !(today && (written || !this.planDayEntered))) return;
    if (uplink) this.planCheckedAt = newest;
    if (today) this.planDayEntered = true;
    const weekly = [...adapter.valvePlans().values()]
      .some(plans => plans.some(plan => plan.kind === 'WEEKLY' && plan.enabled));
    if (weekly) this.practiced.add('plan');
  }

  /** Checks each of days 8 to 10 once, after its 07:00 uplink, and keeps the first match for the rest of the run. */
  private observeDepths(adapter: FarmOsiAdapter): void {
    if (!this.enabled || this.tier !== 4 || this.deep) return;
    const newest = adapter.latestProbeSample()?.at;
    if (newest === undefined) return;
    const day = this.day(newest);
    const readAt = localDayStart(newest) + DEEP_DRYING.hour * HOUR_MS;
    if (day < DEEP_DRYING.firstDay || day > DEEP_DRYING.lastDay || newest < readAt || day <= this.deepCheckedDay) return;
    this.deepCheckedDay = day;
    const thresholdKpa = shallowTriggerThreshold(adapter);
    const found = thresholdKpa === null ? null : deepDrying(adapter.probeSamples(), readAt, thresholdKpa);
    if (found && shallowTriggerChecked(adapter.triggerEvaluations(), readAt)) this.deep = {day, ...found};
  }

  state() {
    return {
      enabled: this.enabled, practiced: [...this.practiced], valveUsed: this.valveUsed,
      observed: this.observed && {...this.observed}, dripStart: this.dripStart ?? null, dripEnd: this.dripEnd ?? null,
      deepDrying: this.deep && {...this.deep},
    };
  }
}

export function rollingTransplant(vm: Pick<ViewModel, 'map' | 'plants'>): TileRef | undefined {
  return vm.plants.find(plant => plant.phenology === 'initial'
    && plant.stress === 'rolling'
    && vm.map.tiles[plant.at.y * vm.map.width + plant.at.x]?.bed === 'B')?.at;
}
