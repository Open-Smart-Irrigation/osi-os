import {
  cropSpriteStage, cropStress, finishCropDay, harvestTomato, phenology, ripeGrams, tomato, TOMATO,
} from './crop';
import type {Crop} from './crop';
import {carryTripMs, facingFor, LABOUR, LABOUR_REST_MS, spendEnergy} from './labour';
import type {Facing, PlayerActivity} from './labour';
import {
  BED_A_AREA_M2, BED_A_ZONE, DRIP_TILES, FARM_HEIGHT, FARM_WIDTH, farmMap, START_TILE, tileIndex,
} from './map';
import {
  layerKpa, querySoil, rainRunoffFraction, rootShares, SATURATION, soilFromDepletion,
  stepSoil, stressCoefficient, surfaceBand, WILTING_POINT,
} from './soil';
import type {Layers, SoilColumn, SoilInputs} from './soil';
import {
  DAY_MS, HOUR_MS, MINUTE_MS, SUNRISE_HOUR, SUNSET_HOUR, WELL_REFILL_HOUR,
  daylightFraction, localDate, localDayStart, localHour, nextLocalMidnight, nextSoilGridAt,
  seasonAt, sleepUntil,
} from './time';
import type {CutoffView, ReplayHeader, Scenario, TileRef, TileView, ToolId, ViewModel, WorldDayView} from './types';
import {hundredths, round2} from './units';
import {
  debitTank, drawCanPour, fillContainer, pourIntoTank, projectedSegmentDelivery, pumpWater,
  refillWell, segmentLiters, WATER, waterState,
} from './water';
import type {Container, FlowSegment, LitersBetween} from './water';
import {rainBetween, rainInDay, rainRateMmPerHour, Weather} from './weather';
import type {WeatherDay, WeatherSource} from './weather';

const TOOLS: readonly ToolId[] = Object.freeze(['hoe', 'seedling', 'can', 'jerrycan', 'basket']);
const FALLOW_KC = .25;
const KS_SCALE = 1_000_000;

export interface WorldValveTap {
  /** The WP4 tap includes historical segments as well as the current valve run. */
  readonly litersBetween: LitersBetween;
  /** Earliest actual delivery-rate change after from and no later than through, including changes at a zero tank. */
  nextInputChangeAfter(from: number, through: number): number | null;
  /** Full precision delivery for an off-grid query. */
  projectedDelivery(zoneId: number, from: number, to: number): number;
  /** Record and debit flow through at before a tank mutation changes availability. */
  settleTo(at: number): void;
  /** Start the new availability segment after a pump, pour or fill. */
  tankChanged(at: number, tankLiters: number): void;
}

interface Exposure {
  durationMs: number;
  ksTime: number;
  etc: number;
  eta: number;
}

interface Plot {
  readonly at: TileRef;
  readonly bed: 'A' | 'B';
  tilled: boolean;
  column: SoilColumn;
  crop: Crop | null;
  exposure: Exposure;
}

interface DayAccount {
  can: number;
  tap: number;
  valve: number;
  runoff: number;
  percolation: number;
  waterEnergy: number;
  waterMs: number;
  pumpStrokes: number;
  carryTrips: number;
  pickedGrams: number;
  lostGrams: number;
  /** Bed A root-zone storage summed over its tiles, in 0.01 mm, when the record's interval began. */
  soilStart: number;
}

interface TankEvent {
  readonly at: number;
  readonly seq: number;
  readonly kind: 'pump' | 'carry';
}

interface CanPour {
  readonly at: TileRef;
  readonly segment: FlowSegment;
}

/**
 * `next`, or an input change after `from` if it comes first. World.nextBoundary runs several times a tick, so this is
 * a module function: the closure it replaces cost an allocation per call, and under tsx a keepNames helper call too.
 */
function earlierChange(next: number, from: number, change: number | undefined | null): number {
  return change != null && change > from ? Math.min(next, change) : next;
}

/** Mean bed A depth from a storage total in 0.01 mm summed over the bed's 1 m² tiles. */
function bedAMm(total: number): number {
  return round2(total / BED_A_AREA_M2 / 100);
}

function blankExposure(): Exposure {
  return {durationMs: 0, ksTime: 0, etc: 0, eta: 0};
}

function blankAccount(soilStart: number): DayAccount {
  return {can: 0, tap: 0, valve: 0, runoff: 0, percolation: 0,
    waterEnergy: 0, waterMs: 0, pumpStrokes: 0, carryTrips: 0, pickedGrams: 0, lostGrams: 0, soilStart};
}

type Forcing = {
  common: Omit<SoilInputs, 'canMm' | 'etcMm' | 'rootDepthM' | 'uptakeShares' | 'dripMm'>;
  et0Mm: number;
  manualLiters: number;
  valveLiters: number;
  canLiters: number;
};

interface ViewOptions {
  readonly phoneOpen?: boolean;
  readonly selectedTool?: ToolId;
  readonly valve?: ViewModel['valve'];
  readonly valveDripWet?: boolean;
}

export class World {
  readonly weather: WeatherSource;
  private readonly map: ReturnType<typeof farmMap>;
  private readonly plots: Plot[] = [];
  private readonly byTile = new Map<number, Plot>();
  private readonly records: WorldDayView[] = [];
  private readonly cutoffs: CutoffView[] = [];
  private readonly manualHistory: FlowSegment[] = [];
  private readonly tankEvents: TankEvent[] = [];
  private readonly header: Readonly<ReplayHeader>;
  private water;
  private readonly wellYieldL: number;
  private tap?: WorldValveTap;
  private manual: FlowSegment | null = null;
  private canPour: CanPour | null = null;
  private account: DayAccount;
  private playerAt = START_TILE;
  private facing: Facing = 'south';
  private activity: PlayerActivity = 'idle';
  private busyUntil: number;
  private activityUntil: number;
  private readonly waterWork: {from: number; to: number}[] = [];
  private energy: number;
  private committed: number;
  private valveSettledAt: number;
  private nextSequence = 0;

  constructor(header: ReplayHeader, scenario: Scenario, weather: WeatherSource = new Weather(header.seed)) {
    this.header = Object.freeze({...header});
    this.weather = weather;
    this.map = farmMap(header.tier);
    this.committed = this.valveSettledAt = this.busyUntil = this.activityUntil = header.start;
    this.wellYieldL = scenario.initial.wellYieldLiters;
    this.water = waterState(scenario.initial.tankLiters, scenario.initial.wellLiters, this.wellYieldL);
    this.energy = scenario.initial.energy;

    const a = soilFromDepletion(scenario.initial.bedA.depletion);
    const b = soilFromDepletion(scenario.initial.bedB.depletion);
    // The seeded ripe batch ripened at the end of the day before the slice, so it rots like any other batch.
    const planted = tomato(TOMATO.initialDays + TOMATO.developmentDays + scenario.initial.bedA.dayInStage,
      scenario.initial.bedA.fruit, localDayStart(header.start) / DAY_MS - 1);
    for (const tile of this.map) {
      if (!tile.bed) continue;
      const inA = tile.bed === 'A';
      const plot: Plot = {
        at: tile.at, bed: tile.bed, tilled: inA, column: inA ? a : b,
        crop: inA ? planted : null, exposure: blankExposure(),
      };
      this.plots.push(plot);
      this.byTile.set(tileIndex(tile.at), plot);
    }
    this.account = blankAccount(this.bedASoil());
  }

  /** Committed bed A storage over the whole 1 m column, summed over its tiles, in 0.01 mm. */
  private bedASoil(): number {
    let total = 0;
    for (const plot of this.plots) {
      if (plot.bed === 'A') for (const layer of plot.column.storage) total += layer;
    }
    return total;
  }

  get committedAt(): number {
    return this.committed;
  }

  attachValveTap(tap: WorldValveTap): void {
    if (this.header.tier < 3 || this.tap) throw new Error('Valve tap requires a valve tier and a single attachment');
    this.tap = tap;
  }

  private nextBoundary(through: number, day: WeatherDay): number {
    const from = this.committed;
    let next = nextSoilGridAt(from);
    next = earlierChange(next, from, day.burst?.startsAt);
    next = earlierChange(next, from, day.burst?.endsAt);
    next = earlierChange(next, from, this.canPour?.segment.endsAt);
    if (this.manual) {
      // At exhaustion the tap remains mechanically open, but flow stops.
      next = earlierChange(next, from,
        this.manual.startsAt + Math.ceil(this.manual.availableLiters * MINUTE_MS / this.manual.rateLpm));
    }
    return earlierChange(next, from, this.tap?.nextInputChangeAfter(from, Math.min(through, next)));
  }

  private forcing(to: number, day: WeatherDay, quantised: boolean): Forcing {
    const from = this.committed;
    const amount = (segment: FlowSegment | undefined | null) => segment
      ? quantised ? segmentLiters(segment, from, to).delivered : projectedSegmentDelivery(segment, from, to)
      : 0;
    const valveLiters = !this.tap ? 0 : quantised
      ? this.tap.litersBetween(BED_A_ZONE, from, to).delivered
      : this.tap.projectedDelivery(BED_A_ZONE, from, to);
    return {
      common: {
        durationMs: to - from, rainMm: rainInDay(day, from, to),
        rainRunoffFraction: rainRunoffFraction(day.rainMm),
        daylightFraction: daylightFraction(day.startsAt, from, to),
      },
      et0Mm: day.et0Mm, manualLiters: amount(this.manual),
      valveLiters,
      canLiters: amount(this.canPour?.segment),
    };
  }

  private inputFor(plot: Plot, forcing: Forcing, stage: ReturnType<typeof phenology> | null, shares: Layers): SoilInputs {
    return {
      ...forcing.common, rootDepthM: stage?.rootDepthM ?? 0, etcMm: (stage?.kc ?? FALLOW_KC) * forcing.et0Mm,
      dripMm: plot.bed === 'A' ? (forcing.manualLiters + forcing.valveLiters) * WATER.dripEfficiency / BED_A_AREA_M2 : 0,
      canMm: plot.at === this.canPour?.at ? forcing.canLiters : 0,
      uptakeShares: shares,
    };
  }

  private commit(to: number, day: WeatherDay): void {
    const forcing = this.forcing(to, day, true);
    const cache = new Map<SoilColumn, {age: number; bed: Plot['bed']; result: ReturnType<typeof stepSoil>}>();
    const stages = new Map<number, {stage: ReturnType<typeof phenology> | null; shares: Layers}>();
    for (const plot of this.plots) {
      const age = plot.crop && !plot.crop.dead ? plot.crop.ageDays : -1;
      let group = stages.get(age);
      if (!group) {
        const stage = age >= 0 && plot.crop ? phenology(plot.crop) : null;
        group = {stage, shares: rootShares(stage?.rootDepthM ?? 0)};
        stages.set(age, group);
      }
      const activePour = plot.at === this.canPour?.at;
      const cached = cache.get(plot.column);
      let result;
      if (!activePour && cached?.age === age && cached.bed === plot.bed) {
        result = cached.result;
      } else {
        result = stepSoil(plot.column, this.inputFor(plot, forcing, group.stage, group.shares));
        if (!activePour) cache.set(plot.column, {age, bed: plot.bed, result});
      }
      plot.column = result.column;
      const {fluxes} = result;
      this.account.runoff += fluxes.runoff;
      this.account.percolation += fluxes.percolation;
      if (age >= 0) {
        plot.exposure.durationMs += forcing.common.durationMs;
        plot.exposure.ksTime += Math.round(fluxes.ks * KS_SCALE) * forcing.common.durationMs;
        plot.exposure.etc += fluxes.potentialEt;
        plot.exposure.eta += fluxes.et;
      }
    }
    this.account.can += hundredths(forcing.canLiters);
    this.account.tap += hundredths(forcing.manualLiters);
    this.account.valve += hundredths(forcing.valveLiters);
    for (const work of this.waterWork) {
      this.account.waterMs += Math.max(0, Math.min(to, work.to) - Math.max(this.committed, work.from));
    }
    while (this.waterWork.length && this.waterWork[0].to <= to) this.waterWork.shift();
    this.committed = to;

    if (this.canPour && to >= (this.canPour.segment.endsAt ?? Infinity)) this.canPour = null;
    if (to === nextLocalMidnight(day.startsAt)) this.finishDay(to);
    if (to === localDayStart(to) + WELL_REFILL_HOUR * HOUR_MS) this.water = refillWell(this.water, this.wellYieldL);
    if (to === localDayStart(to) + LABOUR_REST_MS) this.energy = LABOUR.dailyEnergy;
  }

  /** Advance only across physical boundaries. The caller owns the clock and tank event order. */
  stepTo(at: number): void {
    this.checkTime(at);
    while (at > this.committed) {
      const day = this.weather.actual(this.committed);
      const next = this.nextBoundary(at, day);
      if (next > at) break;
      this.commit(next, day);
    }
  }

  private checkTime(at: number): void {
    if (!Number.isSafeInteger(at)) throw new RangeError('Expected integer simulation milliseconds');
  }

  /** Call before changing an input at an off-grid instant. */
  commitInputChange(at: number): void {
    this.checkTime(at);
    if (at < this.committed) throw new RangeError('An input change cannot precede committed physics');
    this.stepTo(at);
    if (at > this.committed) this.commit(at, this.weather.actual(this.committed));
  }

  private projection(at: number): Forcing | null {
    if (at === this.committed) return null;
    if (at < this.committed) throw new RangeError('Cannot project before the committed soil cursor');
    const day = this.weather.actual(this.committed);
    if (at >= this.nextBoundary(at, day)) throw new RangeError('Step to the current soil grid before projecting');
    return this.forcing(at, day, false);
  }

  private plotColumn(plot: Plot, forcing: Forcing | null): SoilColumn {
    if (!forcing) return plot.column;
    const stage = plot.crop && !plot.crop.dead ? phenology(plot.crop) : null;
    return querySoil(plot.column, this.inputFor(plot, forcing, stage, rootShares(stage?.rootDepthM ?? 0)));
  }

  /** Project top-to-bottom storage for one tile through the current partial step. */
  columnAt(tile: TileRef, at = this.committed): SoilColumn | null {
    const plot = this.byTile.get(tileIndex(tile));
    return plot ? this.plotColumn(plot, this.projection(at)) : null;
  }

  /** Mean bed A storage for the paired 20 and 40 cm sensor at zone 1. */
  bedAColumn(at = this.committed): SoilColumn {
    const forcing = this.projection(at);
    const sum = [0, 0, 0, 0, 0] as [number, number, number, number, number];
    for (const plot of this.plots) {
      if (plot.bed !== 'A') continue;
      const {storage} = this.plotColumn(plot, forcing);
      for (let i = 0; i < sum.length; i++) sum[i] += storage[i] / BED_A_AREA_M2;
    }
    return {storage: sum};
  }

  /** Fixed batteries for the slice. Battery wear starts after M1. */
  sensorBatteryPct(type: string): number {
    return type === 'DRAGINO_LSN50' ? 88 : 90;
  }

  /** Measured rain depth for a historical uplink interval. */
  rainMmBetween(from: number, to: number): number {
    return rainBetween(this.weather, from, to);
  }

  nextTankEventAt(): number | null {
    return this.tankEvents[0]?.at ?? null;
  }

  /** The caller reaches at with stepTo, then settles these events before recomputing the cutoff. */
  applyDueTankEvents(at: number): void {
    while (this.tankEvents.length && this.tankEvents[0].at <= at) {
      const event = this.tankEvents[0];
      this.beforeTankMutation(event.at);
      this.tankEvents.shift();
      if (event.kind === 'pump') this.water = pumpWater(this.water).state;
      else {
        this.water = fillContainer(this.water, 'jerrycan', 'shared-well').state;
        this.water = pourIntoTank(this.water, 'jerrycan').state;
      }
      this.afterTankMutation(event.at);
    }
  }

  /** The valve adapter calls this after measuring and retaining the just-settled interval. */
  debitValve(at: number, liters: number): number {
    if (at < this.valveSettledAt) throw new RangeError('Cannot debit valve flow backwards');
    const result = debitTank(this.water, liters);
    this.water = result.state;
    this.valveSettledAt = at;
    return result.liters;
  }

  /** Last physically settled store. The adapter can use it when starting a new valve segment. */
  settledTankLiters(): number {
    return this.water.tankLiters;
  }

  manualTapLitersBetween(from: number, to: number): number {
    let total = 0;
    for (const segment of this.manualHistory) total += hundredths(segmentLiters(segment, from, to).delivered);
    if (this.manual) total += hundredths(segmentLiters(this.manual, from, to).delivered);
    return total / 100;
  }

  setManualTap(at: number, open: boolean): boolean {
    if (this.header.tier >= 3 || open === (this.manual !== null)) return false;
    this.commitInputChange(at);
    if (open) this.manual = this.manualSegment(at);
    else {
      this.endManualSegment(at);
      this.manual = null;
    }
    return true;
  }

  private manualSegment(at: number): FlowSegment {
    return {startsAt: at, endsAt: null, availableLiters: this.water.tankLiters, rateLpm: WATER.dripRateLpm};
  }

  private endManualSegment(at: number): void {
    if (!this.manual || at === this.manual.startsAt) return;
    const segment = {...this.manual, endsAt: at};
    this.manualHistory.push(segment);
    this.water = debitTank(this.water, segmentLiters(segment, segment.startsAt, at).delivered).state;
  }

  private beforeTankMutation(at: number): void {
    this.tap?.settleTo(at);
    if (this.manual) {
      this.commitInputChange(at);
      this.endManualSegment(at);
    }
  }

  private afterTankMutation(at: number): void {
    if (this.manual) this.manual = this.manualSegment(at);
    if (this.tap) {
      this.tap.tankChanged(at, this.water.tankLiters);
      this.stepTo(at);
    }
  }

  /** Fills a container at the tank. The player fills at the shared well with collectFromSharedWell. */
  fill(at: number, container: Container): number {
    this.beforeTankMutation(at);
    const result = fillContainer(this.water, container, 'tank');
    this.water = result.state;
    this.afterTankMutation(at);
    return result.liters;
  }

  collectFromSharedWell(at: number, container: Container): number {
    const result = fillContainer(this.water, container, 'shared-well');
    if (!result.liters || this.isBusy(at) || !this.spend(LABOUR.carryEnergy, true)) return 0;
    this.water = result.state;
    this.account.carryTrips++;
    this.beginWaterWork(at, carryTripMs(), 'carry');
    return result.liters;
  }

  pourTank(at: number, container: Container): number {
    this.beforeTankMutation(at);
    const result = pourIntoTank(this.water, container);
    this.water = result.state;
    this.afterTankMutation(at);
    return result.liters;
  }

  private spend(cost: number, water: boolean): boolean {
    const remaining = spendEnergy(this.energy, cost);
    if (remaining === null) return false;
    this.energy = remaining;
    if (water) this.account.waterEnergy += cost;
    return true;
  }

  private beginWaterWork(at: number, duration: number, activity: PlayerActivity): number {
    const end = at + duration;
    this.waterWork.push({from: at, to: end});
    this.busyUntil = this.activityUntil = end;
    this.activity = activity;
    return end;
  }

  pump(at: number): number | null {
    if (at < this.busyUntil || this.water.wellLiters === 0 || this.tankLitersAt(at) >= WATER.tankCapacityL
      || !this.spend(LABOUR.pumpEnergy, true)) return null;
    this.account.pumpStrokes++;
    const end = this.beginWaterWork(at, LABOUR.pumpMs, 'pump');
    this.tankEvents.push({at: end, seq: this.nextSequence++, kind: 'pump'});
    return end;
  }

  carryFromSharedWell(at: number): number | null {
    if (at < this.busyUntil || this.tankLitersAt(at) >= WATER.tankCapacityL || !this.spend(LABOUR.carryEnergy, true)) return null;
    this.account.carryTrips++;
    const end = this.beginWaterWork(at, carryTripMs(), 'carry');
    this.tankEvents.push({at: end, seq: this.nextSequence++, kind: 'carry'});
    return end;
  }

  waterTile(at: number, tile: TileRef): number | null {
    const plot = this.byTile.get(tileIndex(tile));
    if (!plot || at < this.busyUntil || this.water.canLiters <= 0 || !this.spend(LABOUR.canPourEnergy, true)) return null;
    this.commitInputChange(at);
    const {state, liters} = drawCanPour(this.water);
    this.water = state;
    const endsAt = this.beginWaterWork(at, LABOUR.canPourMs, 'pour');
    this.canPour = {at: plot.at, segment: {
      startsAt: at, endsAt, availableLiters: liters, rateLpm: liters * MINUTE_MS / LABOUR.canPourMs,
    }};
    return endsAt;
  }

  move(at: number, dx: number, dy: number): boolean {
    if (at < this.busyUntil || !Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return false;
    this.facing = facingFor(dx, dy);
    const next = {x: this.playerAt.x + Math.sign(dx), y: this.playerAt.y + Math.sign(dy)};
    if (next.x !== this.playerAt.x && next.y !== this.playerAt.y
      && (!this.map[tileIndex({x: next.x, y: this.playerAt.y})]?.walkable
        || !this.map[tileIndex({x: this.playerAt.x, y: next.y})]?.walkable)) return false;
    const tile = this.map[tileIndex(next)];
    if (!tile?.walkable) return false;
    this.playerAt = tile.at;
    this.activity = 'walk';
    this.activityUntil = at + 15_000;
    return true;
  }

  till(at: number, tile: TileRef): boolean {
    const plot = this.byTile.get(tileIndex(tile));
    if (!plot || plot.tilled || at < this.busyUntil || !this.spend(LABOUR.tillEnergy, false)) return false;
    plot.tilled = true;
    this.activity = 'hoe';
    this.activityUntil = at + MINUTE_MS;
    return true;
  }

  transplant(at: number, tile: TileRef): boolean {
    const plot = this.byTile.get(tileIndex(tile));
    if (!plot?.tilled || plot.crop || at < this.busyUntil) return false;
    this.commitInputChange(at);
    plot.crop = tomato();
    return true;
  }

  harvest(at: number, tile: TileRef): number {
    const plot = this.byTile.get(tileIndex(tile));
    if (!plot?.crop || ripeGrams(plot.crop) === 0 || at < this.busyUntil
      || !this.spend(LABOUR.harvestEnergy, false)) return 0;
    const result = harvestTomato(plot.crop);
    plot.crop = result.crop;
    this.account.pickedGrams += result.grams;
    this.activity = 'harvest';
    this.activityUntil = at + MINUTE_MS;
    return result.grams / 1_000;
  }

  feelSoil(at: number, tile: TileRef): 'sticky and cool' | 'crumbly' | 'dusty' | null {
    const column = this.columnAt(tile, at);
    if (!column) return null;
    const kPa = layerKpa(column, 0);
    return kPa < 20 ? 'sticky and cool' : kPa <= 50 ? 'crumbly' : 'dusty';
  }

  recordCutoff(cutoff: CutoffView): void {
    this.cutoffs.push(Object.freeze({at: cutoff.at, liters: Object.freeze({...cutoff.liters})}));
  }

  private finishDay(at: number): void {
    const day = localDayStart(at - 1) / DAY_MS;
    for (const plot of this.plots) {
      if (plot.crop && plot.exposure.durationMs > 0) {
        const {durationMs, ksTime, etc, eta} = plot.exposure;
        const result = finishCropDay(plot.crop, day, ksTime / durationMs / KS_SCALE, etc ? eta / etc : 1);
        plot.crop = result.crop;
        this.account.lostGrams += result.lostGrams;
      }
    }
    this.records.push(this.dayRecord(at, at - 1));
    this.account = blankAccount(this.bedASoil());
    for (const plot of this.plots) plot.exposure = blankExposure();
  }

  private dayRecord(at: number, on: number, projected?: Forcing | null): WorldDayView {
    const dayStart = localDayStart(on);
    let duration = 0;
    let ksTime = 0;
    // Stress days describe bed A, like its root-zone water; the T4 reference runs have no bed B (plan 7.5).
    for (const {bed, exposure} of this.plots) {
      if (bed !== 'A') continue;
      duration += exposure.durationMs;
      ksTime += exposure.ksTime;
    }
    const a = this.account;
    const can = a.can + hundredths(projected?.canLiters ?? 0);
    const tap = a.tap + hundredths(projected?.manualLiters ?? 0);
    const valve = a.valve + hundredths(projected?.valveLiters ?? 0);
    const irrigated = can + tap + valve;
    const pendingWorkMs = projected ? this.waterWork.reduce((ms, work) =>
      ms + Math.max(0, Math.min(at, work.to) - Math.max(this.committed, work.from)), 0) : 0;
    const ks = duration ? ksTime / duration / KS_SCALE : null;
    return Object.freeze({
      date: localDate(on), at, rainMm: round2(rainInDay(this.weather.actual(on), Math.max(dayStart, this.header.start), at)),
      irrigationLiters: Object.freeze({can: can / 100, tap: tap / 100, valve: valve / 100}),
      runoffLiters: a.runoff / 100, percolationLiters: a.percolation / 100,
      applicationLossLiters: round2((tap + valve) / 100 * (1 - WATER.dripEfficiency)),
      waterEnergy: a.waterEnergy, waterMinutes: round2((a.waterMs + pendingWorkMs) / MINUTE_MS),
      pumpStrokes: a.pumpStrokes, carryTrips: a.carryTrips,
      soilWaterMm: Object.freeze({start: bedAMm(a.soilStart), end: bedAMm(this.bedASoil())}),
      meanKs: ks === null ? null : round2(ks), stressDay: ks !== null && ks < .8,
      pickedKg: a.pickedGrams / 1_000, lostKg: a.lostGrams / 1_000,
      waterProductivityKgPerM3: irrigated > 0 ? round2(a.pickedGrams * 100 / irrigated) : null,
      cutoffs: this.cutoffsOn(dayStart),
    });
  }

  private cutoffsOn(dayStart: number): readonly CutoffView[] {
    return Object.freeze(this.cutoffs.filter(cutoff => localDayStart(cutoff.at) === dayStart));
  }

  get completedDayCount(): number { return this.records.length; }

  dayAt(at: number): WorldDayView { return this.dayRecord(at, at, this.projection(at)); }

  dailyRecords(): readonly WorldDayView[] {
    if (!this.cutoffs.length) return Object.freeze([...this.records]);
    return Object.freeze(this.records.map(record => Object.freeze({
      ...record, cutoffs: this.cutoffsOn(localDayStart(record.at - 1)),
    })));
  }

  tankLitersAt(at: number): number {
    const projected = this.manual ? segmentLiters(this.manual, this.manual.startsAt, at).delivered
      : this.tap?.litersBetween(BED_A_ZONE, this.valveSettledAt, at).delivered ?? 0;
    return round2(Math.max(0, this.water.tankLiters - projected));
  }

  tileAt(at: TileRef): TileView | undefined { return this.map[tileIndex(at)]; }
  get playerTile(): TileRef { return this.playerAt; }
  get manualTapOpen(): boolean { return this.manual !== null; }
  get energyLeft(): number { return this.energy; }
  isBusy(at: number): boolean { return at < this.busyUntil; }
  canSleep(at: number): boolean { return !this.isBusy(at) && sleepUntil(at) !== null; }

  /** Serializable physical state for replay. Forecast caches and renderer options are derived. */
  snapshot() {
    return {
      committedAt: this.committed, valveSettledAt: this.valveSettledAt, water: {...this.water},
      plots: this.plots.map(plot => ({
        at: plot.at, tilled: plot.tilled, storage: [...plot.column.storage], exposure: {...plot.exposure},
        crop: plot.crop && {...plot.crop, fruit: {...plot.crop.fruit}, ripe: plot.crop.ripe.map(batch => ({...batch})),
          yieldWindow: [...plot.crop.yieldWindow]},
      })),
      player: {at: this.playerAt, facing: this.facing, energy: this.energy, activity: this.activity,
        busyUntil: this.busyUntil, activityUntil: this.activityUntil},
      waterWork: this.waterWork.map(work => ({...work})),
      manualHistory: this.manualHistory.map(segment => ({...segment})),
      manual: this.manual && {...this.manual},
      canPour: this.canPour && {at: this.canPour.at, segment: {...this.canPour.segment}},
      tankEvents: this.tankEvents.map(event => ({...event})), nextSequence: this.nextSequence,
      cutoffs: [...this.cutoffs], account: {...this.account}, daily: this.dailyRecords(),
    };
  }

  viewModel(at: number, options: ViewOptions = {}): ViewModel {
    const forcing = this.projection(at);
    const currentWeather = this.weather.actual(at);
    const hour = localHour(at);
    const plants: ViewModel['plants'][number][] = [];
    const tiles = this.map.map(tile => {
      const plot = this.byTile.get(tileIndex(tile.at));
      if (!plot) return tile;
      const column = this.plotColumn(plot, forcing);
      if (plot.crop) {
        const stage = phenology(plot.crop);
        const ks = stressCoefficient(column, stage.rootDepthM, currentWeather.et0Mm * stage.kc);
        const sprite = cropSpriteStage(plot.crop);
        plants.push(Object.freeze({
          at: plot.at, stage: sprite, stress: cropStress(ks, hour, plot.crop.dead),
          phenology: stage.stage, dayInStage: stage.dayInStage, ks: round2(ks),
          flowerDrop: sprite === 'flowering' && ks < .5 && !plot.crop.dead,
          ripeKg: ripeGrams(plot.crop) / 1_000,
        }));
      }
      return Object.freeze({
        ...tile, terrain: plot.tilled ? 'tilled' as const : tile.terrain,
        surfaceBand: surfaceBand(layerKpa(column, 0, false)),
        wetness: (column.storage[0] - WILTING_POINT[0]) / (SATURATION[0] - WILTING_POINT[0]),
      });
    });
    const rainMmPerHour = rainRateMmPerHour(currentWeather, at);
    const tankLiters = this.tankLitersAt(at);
    const wet = options.valveDripWet ?? (this.manual !== null && tankLiters > 0);
    return Object.freeze({
      simNow: at, tier: this.header.tier, phoneOpen: options.phoneOpen ?? false,
      map: Object.freeze({width: FARM_WIDTH, height: FARM_HEIGHT, tiles: Object.freeze(tiles)}),
      plants: Object.freeze(plants),
      player: Object.freeze({at: this.playerAt, facing: this.facing, energy: this.energy,
        activity: at < this.activityUntil ? this.activity : 'idle'}),
      water: Object.freeze({tankLiters, tankCapacityLiters: WATER.tankCapacityL,
        wellLiters: this.water.wellLiters, wellDailyLiters: this.wellYieldL}),
      sky: Object.freeze({date: localDate(at),
        day: Math.min(14, 1 + (localDayStart(at) - localDayStart(this.header.start)) / DAY_MS),
        hour, sunriseHour: SUNRISE_HOUR, sunsetHour: SUNSET_HOUR, season: seasonAt(at),
        raining: rainMmPerHour > 0, rainMmPerHour}),
      dripLine: Object.freeze(DRIP_TILES.map(tile => Object.freeze({...tile, wet}))),
      valve: options.valve ?? (this.header.tier >= 3 ? 'closed' : 'absent'),
      hud: Object.freeze({tools: TOOLS, selectedTool: options.selectedTool ?? 'can',
        canLiters: this.water.canLiters, jerrycanLiters: this.water.jerrycanLiters, maxEnergy: LABOUR.dailyEnergy,
        canSleep: this.canSleep(at), canUsePhone: this.header.tier > 0,
        moistureLens: this.header.moistureLens, sliceComplete: at >= this.header.start + 14 * DAY_MS}),
      today: this.dayRecord(at, at, forcing), daily: this.dailyRecords(),
    });
  }
}
