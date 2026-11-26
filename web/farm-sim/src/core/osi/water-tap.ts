import type {Simulator} from '@osi-demo/model';
import {BED_A_ZONE} from '../map';
import {MINUTE_MS} from '../time';
import type {IrrigationEvent, ViewModel} from '../types';
import {hundredths} from '../units';
import {
  pendingCutoffAt, projectedSegmentDelivery, runningCutoffAt, WATER,
  type FlowSegment, type LitersBetween,
} from '../water';
import type {World, WorldValveTap} from '../world';
import {VALVE_EUI, VALVE_PATH} from './farm-builder';

type Outcome = Simulator['outcomes'][number];
type Delivery = FlowSegment & {expectationId: string; openedAt: number};

function estimatedAt(openedAt: number, rate: number, at: number): number {
  return hundredths(Math.max(0, at - openedAt) / MINUTE_MS * rate);
}

/** Keep one rounding origin for the whole run, even when a refill splits delivery. */
function deliveredCents(segment: Delivery, from: number, to: number): number {
  const baseline = estimatedAt(segment.openedAt, segment.rateLpm, segment.startsAt);
  const available = hundredths(segment.availableLiters);
  const cumulative = (at: number) => Math.min(available, Math.max(0,
    estimatedAt(segment.openedAt, segment.rateLpm, Math.min(at, segment.endsAt ?? Infinity)) - baseline));
  return cumulative(to) - cumulative(from);
}

export class WaterTap implements WorldValveTap {
  private readonly deliveries: Delivery[] = [];
  private readonly cutoffSent = new Map<string, number>();
  private readonly announced = new Map<string, 'commanded' | 'opened' | 'closed'>();
  private events: IrrigationEvent[] = [];
  private live: Delivery | null = null;
  private settledAt: number;

  constructor(private readonly sim: Simulator, private readonly world: World) {
    this.settledAt = sim.now;
  }

  private rate(outcome: Outcome): number {
    const active = this.sim.state.activeCommands.get(outcome.deviceEui);
    return active?.expectation_id === outcome.expectationId
      ? active.flow_rate_lpm ?? WATER.dripRateLpm : outcome.flowRateLpm ?? 0;
  }

  private liveDelivery(): Delivery | null {
    if (!this.live) return null;
    const outcome = this.sim.outcomes.find(row => row.expectationId === this.live?.expectationId);
    const end = outcome?.observedCloseAt;
    return end ? {...this.live, endsAt: Date.parse(end)} : this.live;
  }

  private *segments() {
    yield* this.deliveries;
    const current = this.liveDelivery();
    if (current) yield current;
  }

  readonly litersBetween: LitersBetween = (zoneId, from, to) => {
    if (zoneId !== BED_A_ZONE || to <= from) return {estimated: 0, delivered: 0};
    let estimated = 0;
    for (const run of this.sim.outcomes) {
      if (run.zoneId !== zoneId || !run.observedOpenAt) continue;
      const open = Date.parse(run.observedOpenAt);
      const close = run.observedCloseAt ? Date.parse(run.observedCloseAt) : to;
      const rate = this.rate(run);
      const cumulative = (at: number) => estimatedAt(open, rate, Math.min(close, at));
      estimated += cumulative(to) - cumulative(from);
    }
    let delivered = 0;
    for (const segment of this.segments()) delivered += deliveredCents(segment, from, to);
    return {estimated: estimated / 100, delivered: delivered / 100};
  };

  projectedDelivery(zoneId: number, from: number, to: number): number {
    if (zoneId !== BED_A_ZONE) return 0;
    let total = 0;
    for (const segment of this.segments()) total += projectedSegmentDelivery(segment, from, to);
    return total;
  }

  nextInputChangeAfter(from: number, through: number): number | null {
    let next: number | null = null;
    for (const segment of this.segments()) {
      const empty = segment.startsAt + Math.ceil(segment.availableLiters * MINUTE_MS / segment.rateLpm);
      for (const at of [segment.startsAt, segment.endsAt, empty]) {
        if (at !== null && at > from && at <= through && (segment.endsAt === null || at <= segment.endsAt)
          && (next === null || at < next)) next = at;
      }
    }
    const active = this.sim.state.activeCommands.get(VALVE_EUI);
    if (active?.opened_at) {
      const opened = Date.parse(active.opened_at);
      if (opened > from && opened <= through && (next === null || opened < next)) next = opened;
    }
    return next;
  }

  settleTo(at: number): void {
    const segment = this.liveDelivery();
    if (segment && at > this.settledAt) {
      this.world.debitValve(at, deliveredCents(segment, this.settledAt, at) / 100);
    }
    this.settledAt = at;
    if (segment?.endsAt != null) {
      this.deliveries.push(segment);
      this.live = null;
    }
    const active = this.sim.state.activeCommands.get(VALVE_EUI);
    if (!this.live && active?.opened_at) {
      const openedAt = Date.parse(active.opened_at);
      this.live = {expectationId: active.expectation_id, openedAt, startsAt: openedAt, endsAt: null,
        availableLiters: this.world.settledTankLiters(), rateLpm: active.flow_rate_lpm ?? WATER.dripRateLpm};
    }
  }

  tankChanged(at: number, tankLiters: number): void {
    if (!this.live || tankLiters === roundRemaining(this.live, at)) return;
    if (this.live.startsAt < at) this.deliveries.push({...this.live, endsAt: at});
    this.live = {...this.live, startsAt: at, availableLiters: tankLiters};
  }

  private closeInFlight(expectationId: string): boolean {
    return this.sim.clock.ids().some(id => id.startsWith('manual-close:' + expectationId + ':'));
  }

  nextCutoffAt(): number | null {
    const cmd = this.sim.state.activeCommands.get(VALVE_EUI);
    if (!cmd || this.closeInFlight(cmd.expectation_id)) return null;
    const rate = cmd.flow_rate_lpm ?? WATER.dripRateLpm;
    if (cmd.reconciliation_state === 'PENDING_OBSERVATION') {
      return pendingCutoffAt(this.sim.now, Date.parse(cmd.commanded_at) + cmd.open_delay_ms,
        this.world.settledTankLiters(), rate);
    }
    if (cmd.reconciliation_state === 'OBSERVED_RUNNING' && this.live) {
      // Anchor at the last tank mutation to avoid rounding the remaining litres at each host stop.
      const due = runningCutoffAt(this.live.startsAt, this.live.availableLiters, rate);
      return Math.max(this.sim.now, due);
    }
    return null;
  }

  afterStep(at: number): boolean {
    this.settleTo(at);
    this.observe(at);
    const due = this.nextCutoffAt();
    if (due === null || due > at) return false;
    const cmd = this.sim.state.activeCommands.get(VALVE_EUI)!;
    this.cutoffSent.set(cmd.expectation_id, at);
    const result = this.sim.requestResponse('POST', VALVE_PATH, {action: 'CLOSE'});
    if (result.status >= 400) throw new Error('Dry-run switch could not close the valve');
    return true;
  }

  private observe(at: number): void {
    for (let index = this.sim.outcomes.length - 1; index >= 0; index--) {
      const row = this.sim.outcomes[index];
      const seen = this.announced.get(row.expectationId);
      if (seen === 'closed' || row.commandResultDetail?.startsWith('SKIPPED:')) continue;
      const base = {expectationId: row.expectationId, zoneId: row.zoneId, valveEui: row.deviceEui};
      if (seen === undefined) {
        this.events.push({...base, kind: 'commanded', at: Date.parse(row.commandedAt),
          trigger: row.trigger ?? 'unexplained', durationSeconds: row.commandedDurationSeconds ?? 0});
        this.announced.set(row.expectationId, 'commanded');
      }
      if (seen !== 'opened' && row.observedOpenAt) {
        this.events.push({...base, kind: 'opened', at: Date.parse(row.observedOpenAt), flowRateLpm: this.rate(row)});
        this.announced.set(row.expectationId, 'opened');
      }
      if (row.status !== 'COMPLETED' && row.status !== 'CANCELLED') continue;
      const closedAt = row.observedCloseAt ? Date.parse(row.observedCloseAt) : at;
      this.events.push({...base, kind: 'closed', at: closedAt, status: row.status, grossLiters: row.estimatedGrossLiters});
      this.announced.set(row.expectationId, 'closed');
      const sentAt = this.cutoffSent.get(row.expectationId);
      if (sentAt !== undefined) {
        const from = row.observedOpenAt ? Date.parse(row.observedOpenAt) : closedAt;
        const liters = this.litersBetween(BED_A_ZONE, from, closedAt);
        this.world.recordCutoff({at: sentAt, liters});
        this.events.push({...base, kind: 'cutoff', at: sentAt, closedAt, status: row.status, liters,
          winner: row.status === 'COMPLETED' ? 'natural' : row.cancelReason ? 'operator' : 'cutoff'});
      }
    }
  }

  view(): {valve: ViewModel['valve']; valveDripWet?: boolean} {
    const valve = this.sim.devices.find(device => device.deveui === VALVE_EUI);
    if (!valve) return {valve: 'absent'};
    const cmd = this.sim.state.activeCommands.get(VALVE_EUI);
    const wet = valve.current_state === 'OPEN' && this.live !== null
      && this.live.availableLiters > projectedSegmentDelivery(this.live, this.live.startsAt, this.sim.now);
    if (!cmd) return {valve: 'closed', valveDripWet: false};
    const closing = this.closeInFlight(cmd.expectation_id);
    return {valve: closing ? 'closing' : valve.current_state === 'OPEN' ? 'open' : 'pending', valveDripWet: wet};
  }

  snapshot() {
    return {
      deliveries: this.deliveries.map(segment => ({...segment})), live: this.live && {...this.live},
      cutoffSent: [...this.cutoffSent], settledAt: this.settledAt,
    };
  }

  drain(): IrrigationEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }
}

function roundRemaining(segment: Delivery, at: number): number {
  return (hundredths(segment.availableLiters) - deliveredCents(segment, segment.startsAt, at)) / 100;
}
