import {sha256} from '@noble/hashes/sha256';
import {utf8ToBytes} from '@noble/hashes/utils';
import type {Command} from './commands';
import {FARM_SITES} from './map';
import {GameLog} from './log';
import {FarmOsiAdapter} from './osi/adapter';
import type {PhoneWrite} from './osi/bridge';
import {PLANS_PATH} from './osi/farm-builder';
import type {DemoResponse} from './osi/types';
import {playerAction, withinReach} from './player-actions';
import {bedtimeCard, openedValveRuns, sliceReport, type SliceReport} from './report';
import {scenarioById} from './scenario';
import {DAY_MS, sleepUntil} from './time';
import {Tutorial} from './tutorial';
import type {ReplayHeader, Run, Save, ViewModel, WorldDayView} from './types';

export const TICK_MS = 50;
const MAX_TICKS = 8;
const CHECKPOINT_TICKS = 600;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function digest(value: unknown): string {
  const bytes = sha256(utf8ToBytes(JSON.stringify(value)));
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.subarray(i, i + 3);
    result += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)]
      + (i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=')
      + (i + 2 < bytes.length ? BASE64[c & 63] : '=');
  }
  return result;
}

type PlayerCommand = Exclude<Command, {kind: 'phoneRequest'}>;

export class FarmRun implements Run {
  readonly header: Readonly<ReplayHeader>;
  private readonly adapter: FarmOsiAdapter;
  private readonly queue: Command[] = [];
  private readonly history: Save['log'] = [];
  private readonly checkpoints: Save['checkpoints'] = [];
  private readonly eventLog = new GameLog();
  private readonly tutorial: Tutorial;
  private readonly end: number;
  private tick = 0;
  private accumulator = 0;
  private completedDays = 0;
  private triggerAt = -Infinity;
  private readonly parsedTimes = new Map<string, number>();
  private cachedView: Readonly<ViewModel> | undefined;
  private notice: string | undefined;
  private bedtime: ReturnType<typeof bedtimeCard> | undefined;
  private sleepCount = 0;
  private report: SliceReport | undefined;
  private revision = 0;

  constructor(header: ReplayHeader) {
    const scenario = scenarioById(header.scenario);
    if (header.format !== 1 || typeof header.build !== 'string' || !scenario.tiers.includes(header.tier)
      || header.seed !== scenario.seed || header.start !== scenario.start || ![75, 150, 300].includes(header.pace)
      || [header.hints, header.moistureLens, header.pauseWhilePhoneOpen].some(value => typeof value !== 'boolean')) {
      throw new RangeError('Invalid farm replay header');
    }
    this.header = Object.freeze({...header});
    this.end = header.start + 14 * DAY_MS;
    this.tutorial = new Tutorial(header.start, header.hints && scenario.tutorial, header.tier);
    this.adapter = new FarmOsiAdapter({
      dispatcher: {
        dispatchQueued: () => this.dispatchQueued(),
        dispatchPhone: cmd => this.dispatchPhone(cmd),
      },
      logPhoneTraffic: ({type, ...payload}) => {
        if (type === 'api_read' && 'path' in payload) this.eventLog.append(this.now, type, {path: payload.path});
        if (type === 'phone_refused' && 'code' in payload) this.eventLog.append(this.now, type, payload);
      },
    });
    this.adapter.build(this.header, scenario);
    this.eventLog.append(this.now, 'session_start', this.header);
  }

  get now(): number { return this.adapter.now; }
  get complete(): boolean { return this.now === this.end; }
  get phoneRevision(): number { return this.revision + this.adapter.clockRevision; }

  isPhoneOpen(): boolean { return this.adapter.isPhoneOpen(); }
  phoneNow(): number { return this.adapter.phoneNow(); }
  request(method: string, path: string, body?: unknown): DemoResponse {
    return this.adapter.request(method, path, body);
  }

  apply(cmd: Command): void {
    if (cmd.kind === 'phoneRequest') throw new Error('Phone writes enter through the bridge');
    this.queue.push(structuredClone(cmd));
  }

  /**
   * `Date.parse` with a memo. Every tick re-reads the retained trigger evaluations (at most 100), and parsing their
   * timestamps took 3 % of a replay load; a timestamp is an immutable string, so the memo returns what parsing would.
   */
  private parseTime(text: string): number {
    let at = this.parsedTimes.get(text);
    if (at === undefined) this.parsedTimes.set(text, at = Date.parse(text));
    return at;
  }

  private dispatchQueued(): void {
    while (this.queue.length > 0) this.dispatch(this.queue.shift()!);
  }

  private dispatchPhone(cmd: PhoneWrite): DemoResponse {
    this.queue.push({...cmd, simNow: 0, seq: 0});
    return this.dispatch(this.queue.shift()!)!;
  }

  private dispatch(input: Command): DemoResponse | undefined {
    if (this.complete && !(input.kind === 'phoneClose' && this.isPhoneOpen())) {
      if (input.kind !== 'phoneRequest') return;
      // Plan 4.6 logs every refused write, never its body.
      const {method, path} = input;
      this.eventLog.append(this.now, 'phone_refused', {method, path, code: 'game_refused', simNow: this.now});
      return {status: 403, headers: {'content-type': 'application/json'}, data: {error: 'game_refused'}};
    }
    const at = this.now;
    const seq = this.history.length + 1;
    const cmd = input.kind === 'phoneRequest' ? {...input, simNow: at, seq} : input;
    const advanceTo = cmd.kind === 'sleep' ? this.sleepTarget() : null;
    let response;
    if (cmd.kind === 'phoneRequest') {
      response = this.adapter.executePhoneWrite(cmd);
      const {method, path, body, simNow} = cmd;
      this.eventLog.append(at, 'phone_request', {tick: this.tick, seq, method, path, body, simNow});
    } else {
      this.eventLog.append(at, 'command', {tick: this.tick, seq, cmd});
      this.dispatchPlayer(cmd, at, advanceTo);
    }
    this.history.push({tick: this.tick, seq, cmd});
    if (advanceTo !== null) this.adapter.advance(advanceTo);
    this.adapter.drainNow();
    if (cmd.kind === 'phoneRequest' && response && response.status >= 200 && response.status < 300
      && cmd.path.startsWith(PLANS_PATH + '/schedules')) this.tutorial.planWritten(this.adapter);
    this.collectEvents();
    return response;
  }

  private sleepTarget(): number | null {
    const world = this.adapter.world;
    if (!world.canSleep(this.now) || this.isPhoneOpen() || !withinReach(world.playerTile, FARM_SITES.houseDoor)) return null;
    return Math.min(this.end, sleepUntil(this.now)!);
  }

  private dispatchPlayer(cmd: PlayerCommand, at: number, sleepTarget: number | null): void {
    const world = this.adapter.world;
    switch (cmd.kind) {
      case 'move': world.move(at, cmd.dx, cmd.dy); break;
      case 'interact':
      case 'useTool': {
        const result = playerAction(world, at, this.header.tier, cmd);
        this.notice = result.text;
        this.tutorial.action(result, at);
        if (result.pickedKg) this.eventLog.append(at, 'harvest', {tile: cmd.tile, kg: result.pickedKg});
        break;
      }
      case 'phoneOpen': this.adapter.setPhoneOpen(true); break;
      case 'phoneClose': this.adapter.setPhoneOpen(false); break;
      case 'sleep':
        if (sleepTarget === null) {
          this.notice = 'Sleep at the house after 18:00.';
          break;
        }
        this.bedtime = bedtimeCard(world.dayAt(at), world.energyLeft);
        this.sleepCount++;
        this.notice = undefined;
        this.revision++;
        break;
    }
  }

  private collectEvents(): void {
    this.cachedView = undefined;
    const world = this.adapter.world;
    const irrigation = this.adapter.drain();
    const triggers = this.adapter.triggerEvaluations()
      .filter(row => this.parseTime(row.evaluatedAt) > this.triggerAt).reverse();
    let days: readonly WorldDayView[] = [];
    if (world.completedDayCount > this.completedDays) {
      days = world.dailyRecords().slice(this.completedDays);
      this.completedDays = world.completedDayCount;
    }
    const events = [
      ...irrigation.map(event => ({at: event.kind === 'cutoff' ? event.closedAt : event.at, event, type: 'irrigation' as const})),
      ...triggers.map(event => ({at: this.parseTime(event.evaluatedAt), event, type: 'trigger_evaluation' as const})),
      ...days.map(event => ({at: event.at, event, type: 'world_daily' as const})),
    ].sort((a, b) => a.at - b.at);
    for (const {at, event, type} of events) {
      if (type === 'irrigation') {
        if (event.kind === 'cutoff') this.eventLog.append(at, 'cutoff', event);
        else this.eventLog.append(at, type, event);
        this.tutorial.irrigation(event, this.adapter);
      } else if (type === 'trigger_evaluation') {
        this.eventLog.append(at, type, event);
        this.triggerAt = at;
      } else this.eventLog.append(at, type, event);
    }
    if (events.length > 0) this.revision++;
    this.tutorial.observe(this.adapter);
    if (this.complete && !this.report) {
      this.report = sliceReport(this.viewModel(), openedValveRuns(this.adapter.simulatorSnapshot().outcomes), this.header);
      this.eventLog.append(this.now, 'report', this.report);
    }
  }

  private get paused(): boolean {
    return this.header.pauseWhilePhoneOpen && this.isPhoneOpen();
  }

  private advanceTick(): void {
    if (this.paused || this.complete) throw new Error('Replay attempted to advance a frozen run');
    this.adapter.advance(Math.min(this.end, this.now + TICK_MS * this.header.pace));
    this.tick++;
    this.collectEvents();
    if (this.tick % CHECKPOINT_TICKS === 0) this.checkpoints.push(this.hash());
  }

  step(realMs: number): void {
    this.dispatchQueued();
    if (this.paused || this.complete) return;
    if (!Number.isFinite(realMs) || realMs < 0) throw new RangeError('Invalid frame duration');
    this.accumulator += realMs;
    const ticks = Math.floor(this.accumulator / TICK_MS);
    this.accumulator -= ticks * TICK_MS;
    if (ticks > MAX_TICKS) this.eventLog.append(this.now, 'slow_frame', {dropped_ms: (ticks - MAX_TICKS) * TICK_MS});
    for (let i = 0; i < Math.min(ticks, MAX_TICKS) && !this.complete; i++) this.advanceTick();
  }

  viewModel(): Readonly<ViewModel> {
    return this.cachedView ??= this.adapter.viewModel();
  }

  feedback() {
    return {
      notice: this.notice, bedtime: this.bedtime, sleepCount: this.sleepCount,
      manualTapOpen: this.adapter.world.manualTapOpen, report: this.report,
      tutorial: this.tutorial.state(),
    };
  }

  eventsSince(seq: number) { return this.eventLog.since(seq); }

  hash(): string {
    return digest({
      header: this.header, tick: this.tick, seq: this.history.length, now: this.now,
      phoneOpen: this.isPhoneOpen(), phoneNow: this.phoneNow(),
      tutorial: this.tutorial.state(), world: this.adapter.world.snapshot(),
      water: this.adapter.waterSnapshot(), simulator: this.adapter.simulatorDigestInputs(),
    });
  }

  save(): Save {
    this.dispatchQueued();
    return structuredClone({
      header: this.header, log: this.history, checkpoints: this.checkpoints,
      cursor: {tick: this.tick, seq: this.history.length, simNow: this.now},
    });
  }

  static load(save: Save): FarmRun {
    const run = createRun(save.header);
    const {tick, seq, simNow} = save.cursor;
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > Math.ceil((run.end - run.now) / (TICK_MS * run.header.pace))
      || !Number.isSafeInteger(seq) || seq < 0 || seq > save.log.length) throw new Error('Invalid replay cursor');
    for (let index = 0; index < seq; index++) {
      const row = save.log[index];
      if (row.seq !== index + 1 || !Number.isInteger(row.tick) || row.tick < run.tick || row.tick > tick) {
        throw new Error('Invalid replay command order');
      }
      while (run.tick < row.tick) run.advanceTick();
      if (row.cmd.kind === 'phoneRequest' && (row.cmd.simNow !== run.now || row.cmd.seq !== row.seq)) {
        throw new Error('Invalid replay phone write instant');
      }
      run.dispatch(structuredClone(row.cmd));
    }
    while (run.tick < tick) run.advanceTick();
    if (run.history.length !== seq || run.now !== simNow || run.checkpoints.length !== save.checkpoints.length
      || run.checkpoints.some((hash, index) => hash !== save.checkpoints[index])) {
      throw new Error('Replay does not match its cursor or checkpoints');
    }
    return run;
  }
}

export type RunFeedback = ReturnType<FarmRun['feedback']>;
export function createRun(header: ReplayHeader): FarmRun { return new FarmRun(header); }
export function loadRun(save: Save): FarmRun { return FarmRun.load(save); }
