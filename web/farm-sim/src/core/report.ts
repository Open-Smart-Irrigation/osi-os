import timerReferences from '../scenarios/reference-summary.json';
import {BED_A_AREA_M2} from './map';
import type {ReplayHeader, Tier, ViewModel, WorldDayView} from './types';
import {round2} from './units';

export function irrigationLiters(day: Pick<WorldDayView, 'irrigationLiters'>): number {
  const {can, tap, valve} = day.irrigationLiters;
  return round2(can + tap + valve);
}

export function bedtimeCard(day: WorldDayView, energyLeft: number) {
  return {
    appliedLiters: round2(irrigationLiters(day) - day.applicationLossLiters),
    pickedKg: day.pickedKg,
    energyLeft,
  };
}

/** A valve run the simulator saw open, with the trigger that started it. */
export interface ValveRun {
  /** The simulator's label: 'trigger_based' for the soil trigger, 'manual', 'on_valve_schedule' for a plan, ... */
  readonly trigger: string | null;
  readonly openedAt: number;
}

/** The valve runs that opened, from the simulator's irrigation outcomes. */
export function openedValveRuns(outcomes: readonly {trigger: string | null; observedOpenAt: string | null}[]): ValveRun[] {
  return outcomes.flatMap(row => row.observedOpenAt === null ? []
    : [{trigger: row.trigger, openedAt: Date.parse(row.observedOpenAt)}]);
}

/** The day records and valve runs of a slice report, which the T4 comparison reads. */
export interface ReportRecords {
  readonly days: readonly WorldDayView[];
  readonly valveRuns: readonly ValveRun[];
}

/** The slice report (plan 7.5), with the T4 comparison sentence built here so that ui/ only reads it. */
export function sliceReport(vm: Pick<ViewModel, 'daily' | 'today'>, valveRuns: readonly ValveRun[],
  run: Pick<ReplayHeader, 'scenario' | 'tier'>) {
  const {today} = vm;
  const days = vm.daily[vm.daily.length - 1]?.at === today.at ? [...vm.daily] : [...vm.daily, today];
  const sum = (value: (day: WorldDayView) => number) =>
    days.reduce((total, day) => total + value(day), 0);
  const total = {
    rainMm: round2(sum(day => day.rainMm)),
    irrigationLiters: {
      can: round2(sum(day => day.irrigationLiters.can)),
      tap: round2(sum(day => day.irrigationLiters.tap)),
      valve: round2(sum(day => day.irrigationLiters.valve)),
    },
    runoffLiters: round2(sum(day => day.runoffLiters)),
    percolationLiters: round2(sum(day => day.percolationLiters)),
    applicationLossLiters: round2(sum(day => day.applicationLossLiters)),
    waterEnergy: sum(day => day.waterEnergy),
    pumpStrokes: sum(day => day.pumpStrokes),
    carryTrips: sum(day => day.carryTrips),
    soilWaterMm: {start: days[0].soilWaterMm.start, end: days[days.length - 1].soilWaterMm.end},
    waterMinutes: round2(sum(day => day.waterMinutes)),
    stressDays: vm.daily.filter(day => day.stressDay).length,
    pickedKg: Math.round(sum(day => day.pickedKg) * 1_000) / 1_000,
    lostKg: Math.round(sum(day => day.lostKg) * 1_000) / 1_000,
    cutoffs: days.flatMap(day => day.cutoffs),
  };
  const liters = irrigationLiters(total);
  const records = {days, valveRuns: [...valveRuns]};
  return {
    days, total: {...total, waterProductivityKgPerM3: liters > 0 ? round2(total.pickedKg * 1_000 / liters) : null},
    valveRuns: records.valveRuns,
    /** The sentences comparing a T4 run with the daily timer, or null. */
    comparison: referenceSentence(records, run.scenario, run.tier),
  };
}

export type SliceReport = ReturnType<typeof sliceReport>;

/** Day records a reference run covers: the slice's first 14 local days, without the final morning. */
export const REFERENCE_DAYS = 14;

/** What the T4 report sentence compares, over the first REFERENCE_DAYS day records of a run. */
export interface WaterFigures {
  /** Days on which the valve delivered water. */
  readonly irrigationDays: number;
  /** Gross delivered litres from every source. */
  readonly liters: number;
  readonly pumpStrokes: number;
  /** Trips to the shared well. */
  readonly carryTrips: number;
  readonly harvestedKg: number;
  /** Stress days (mean Ks under 0.8). */
  readonly stressDays: number;
  /** Bed A root-zone water at the end of the last of those days, in mm. */
  readonly soilWaterEndMm: number;
}

/** A player's figures, which also say who opened the valve. */
export interface RunFigures extends WaterFigures {
  /** At least one valve run opened in those days, and the soil trigger started each of them. */
  readonly triggerOnly: boolean;
}

/**
 * The scripted daily-timer (T3) reference run of each scenario: same seed and weather as a
 * player's run. scripts/update-golden.ts writes the file from the closed-loop goldens.
 */
const TIMER_REFERENCES: Readonly<Record<string, WaterFigures | undefined>> = timerReferences;

/** Figures over a run's first 14 day records, or null when the report stops before the final morning. */
export function runFigures(report: ReportRecords): RunFigures | null {
  if (report.days.length <= REFERENCE_DAYS) return null;
  const days = report.days.slice(0, REFERENCE_DAYS);
  const opened = report.valveRuns.filter(run => run.openedAt < days[REFERENCE_DAYS - 1].at);
  return {
    triggerOnly: opened.length > 0 && opened.every(run => run.trigger === 'trigger_based'),
    irrigationDays: days.filter(day => day.irrigationLiters.valve > 0).length,
    liters: round2(days.reduce((liters, day) => liters + irrigationLiters(day), 0)),
    pumpStrokes: days.reduce((strokes, day) => strokes + day.pumpStrokes, 0),
    carryTrips: days.reduce((trips, day) => trips + day.carryTrips, 0),
    harvestedKg: Math.round(days.reduce((kg, day) => kg + day.pickedKg, 0) * 1_000) / 1_000,
    stressDays: days.filter(day => day.stressDay).length,
    soilWaterEndMm: days[REFERENCE_DAYS - 1].soilWaterMm.end,
  };
}

/** "half the water" for a share from 0.45 to 0.55, otherwise the share in whole percent, rounded normally. */
function share(part: number, whole: number, noun: string): string {
  const ratio = part / whole;
  if (ratio >= .45 && ratio <= .55) return 'half the ' + noun;
  const percent = Math.round(part * 100 / whole);
  return (percent === 0 && part > 0 ? 'under 1' : String(percent)) + ' % of the ' + noun;
}

/** A run's count: "no trips", "1 trip", "22 trips". */
function count(value: number, one: string, many: string): string {
  return (value === 0 ? 'no' : String(value)) + ' ' + (value === 1 ? one : many);
}

/** The reference's count after "against": "none", "22". */
function referenceCount(value: number): string {
  return value === 0 ? 'none' : String(value);
}

/** Kilograms to two decimals from a gram-rounded harvest. */
function kg(grams: number): string {
  return (Math.round(grams / 10) / 100).toFixed(2);
}

/** A whole number with a comma between thousands. */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ',');
}

/**
 * The playtester's sentences comparing a T4 run with the daily timer. Each qualitative phrase
 * follows from the figures: both harvests in kilograms, "about the same tomatoes" within 3 % of
 * the timer's harvest; "half" for a share from 0.45 to 0.55; the shared-well trips when either
 * run made any; the stress days when they differ; and the root zone in whole mm with its litres
 * on bed A, "the same" within 0.5 mm. It names the soil trigger only when the trigger opened every
 * valve run, and says "Your valve" after a manual or plan run. Null without a harvest.
 */
export function timerComparison(run: RunFigures, timer: WaterFigures): string | null {
  if (run.harvestedKg <= 0 || timer.harvestedKg <= 0 || timer.liters <= 0 || timer.pumpStrokes <= 0) return null;
  // Harvests are gram-rounded, so the 3 % gate compares whole grams without floating-point error.
  const runGrams = Math.round(run.harvestedKg * 1_000);
  const timerGrams = Math.round(timer.harvestedKg * 1_000);
  const tomatoes = (Math.abs(runGrams - timerGrams) * 100 <= 3 * timerGrams ? 'about the same'
    : runGrams < timerGrams ? 'fewer' : 'more') + ' tomatoes, ' + kg(runGrams) + ' kg against ' + kg(timerGrams) + ' kg';
  const costs = [share(run.liters, timer.liters, 'water'), share(run.pumpStrokes, timer.pumpStrokes, 'pumping')];
  if (run.carryTrips > 0 || timer.carryTrips > 0) {
    costs.push(count(run.carryTrips, 'trip', 'trips') + ' to the shared well against ' + referenceCount(timer.carryTrips));
  }
  const soilMm = round2(run.soilWaterEndMm - timer.soilWaterEndMm);
  // Litres from the whole millimetres the sentence prints, so that "35 mm" reads as 35 x 64 L.
  const mm = Math.round(Math.abs(soilMm));
  const liters = 'about ' + grouped(Math.round(mm * BED_A_AREA_M2 / 10) * 10) + ' L';
  const rootZone = Math.abs(soilMm) <= .5 ? 'the same'
    : soilMm < 0 ? mm + ' mm drier, ' + liters + ' the soil has lent'
    : mm + ' mm wetter, ' + liters + ' more held in the soil';
  const valve = run.triggerOnly ? 'The soil-triggered valve' : 'Your valve';
  return valve + ' watered on ' + run.irrigationDays + ' of the ' + REFERENCE_DAYS
    + ' days and the daily timer (reference run, same weather) on ' + timer.irrigationDays + ': '
    + tomatoes + ', for ' + costs.slice(0, -1).join(', ') + ' and ' + costs[costs.length - 1] + '. '
    + (run.stressDays === timer.stressDays ? 'The root zone'
      : 'Bed A had ' + count(run.stressDays, 'stress day', 'stress days') + ' against '
        + referenceCount(timer.stressDays) + ', and the root zone')
    + ' ended ' + rootZone + '.';
}

/** The comparison sentence for a run at T4 (soil-triggered valve) only. */
export function referenceSentence(report: ReportRecords, scenario: string, tier: Tier): string | null {
  if (tier !== 4) return null;
  const timer = TIMER_REFERENCES[scenario];
  const run = runFigures(report);
  return timer && run ? timerComparison(run, timer) : null;
}
