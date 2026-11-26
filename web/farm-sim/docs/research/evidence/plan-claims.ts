// Evidence for web/farm-sim/docs/plan.md claims (plan revision 6, round 5 checks).
// Run on this branch, which carries the section 9 hook commit:
//   cd web/react-gui && ./node_modules/.bin/tsx ../farm-sim/docs/research/evidence/plan-claims.ts
// The harness follows one order at every instant, as plan 4.2 drainNow(): simulator events due now, then world
// events due now (manual opens, can fills, refills, observations; a tank event first settles valve flow up to now),
// then the tap's after-step logic (the cutoff recomputed from the resulting tank level and a due CLOSE sent); again
// while a CLOSE was just sent. Every write the script makes (builder writes, the cutoff CLOSE, test writes) is
// followed by drainNow() before the script reads or steps on. advance(target) is only for time steps: it stops at
// every simulator event, cutoff, local midnight, host grid point and world event, and drains each stop.
// Checks:
//   C1  T1 (no weather service): today's verdict equals the edge verdict; every daily row has no ET0.
//   C2  T2 manual tap: tap litres reach the Water tab and the meter's latest_data without lag; verdict equals edge.
//   C3  dry-run cutoff ends a 06:00 trigger run at the tank volume.
//   C4  dry-run cutoff ends a weekly-plan run at the tank volume.
//   C5  builder inputs (mid_season, longitude 0.0, Etc/GMT-3); Kc 1.15; phone ET0 equals fao56Et0 on game weather.
//   C6  determinism: two runs hash the same.
//   C7  no retained environment record carries the public seed's coordinates or time zone, at any tier.
//   C8  a device registered through REST shows source values in latest_data immediately.
//   C9  hourly forecast rain from the source drives next24hRainMm.
//   C10 phone GETs at arbitrary times do not change the simulation digest, retained environment records and their
//       capture stamps included. The stamps do not depend on when the host steps, because the loop stops at every
//       local midnight (plan 4.2) and the daily refresh therefore always runs at 00:00 (see C19).
//   C11 an empty tank at the 06:00 trigger: the cutoff CLOSE lands before the valve opens; 0 L counted.
//   C12 a weekly-plan start with 0.15 L in the tank: counted litres stay within tank + 2 s of flow; delivered = tank.
//   C13 verdict parity with edge inputs assembled from world state (not from the simulator's summary):
//       dry day, after a 400 L tap run, forecast storm inside 24 h, and just after local midnight.
//   C14 the gauge uplinks at local midnight, so today's rain is known from 00:00.
//   C15 a due-now one-time plan (fire_at a minute in the past) dispatches at the write's own instant and opens at
//       its 2 s acknowledgement; a GET right after the write does not change the digest.
//   C16 forecast window parity: next24hRainMm equals the edge sumRain over end-stamped rows built from the game's
//       forecast hours, on the hour and 30 minutes past it.
//   C17 the meter's latest_data right after registration shows flow_liters_today 0 (a measured zero).
//   C18 a one-time plan start with 0.15 L in the tank: the pre-ACK cutoff makes counted = delivered = 0.15 L exactly.
//   C19 a different host call grid (61 instead of 97 minutes) gives the same digest, retained records and
//       their capture stamps included, because the loop stops at every local midnight.
//   C20 tank ordering: a 10-minute manual run with 79 L in the tank; 2 minutes before the natural close the player
//       fills a 10 L can from the tank (a tank mutation at a command instant). The cutoff CLOSE is recomputed after
//       the fill, counted (estimated) litres equal delivered litres, and the output records which close won.
//   C21 gauge rain parity: 6 mm of world rain over 07:00-09:00 local on day 2 reaches the simulator through the
//       half-hour gauge uplinks; the verdict equals the edge verdict on world-assembled inputs with that rain.
//   C22 meter midnight convention: a 10-minute valve run from 23:55 local. Right after the 00:00 uplink the meter's
//       today counter shows the litres up to 00:00 (attributed to the new day by sample time); the world report
//       attributes them by delivery time; counted and delivered totals agree.
//   C23 refill at the cutoff send instant: the C20 run without the can (79 L) sends its cutoff CLOSE at T. A pump
//       completion adding 20 L exactly at T is applied before the cutoff is recomputed, so no CLOSE is sent and the
//       run ends at its natural close (COMPLETED). The same refill 1 ms after T leaves the CLOSE sent at T in flight;
//       the run ends CANCELLED at T + 2 s. Estimated litres equal delivered litres in every run.
//   C24 natural close and cutoff tie: with 80 L the cutoff CLOSE lands exactly at the natural close instant; the
//       natural close runs first and the run ends COMPLETED.
// The PASS/FAIL tally of all check() results is the last line of the output.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {Simulator} from '../../../../react-gui/demo/model.ts';

const require = createRequire(import.meta.url);
const EDGE = '../../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red';
const {fao56Et0} = require(`${EDGE}/osi-agronomy-daily/et0.js`);
const zoneEnv = require(`${EDGE}/osi-zone-env/index.js`) as {resolveWaterAction: (...args: unknown[]) => {code: string | null; source: string; reasonCode: string | null};
  sumRain: (hours: Array<{time: string; rainMm: number}>, nowMs: number, horizonHours: number, basis: {source: string; basis: string}) => {totalMm: number | null}};
const cropKc = require(`${EDGE}/osi-crop-kc/index.js`) as {resolveKc: (input: Record<string, unknown>) => {kc: number}};
const round2 = (v: number) => Math.round(v * 100) / 100;

const MIN = 60_000, H = 3_600_000, DAY = 24 * H;
const START = Date.parse('2027-01-11T03:30:00Z');        // 06:30 at UTC+3
const LAT = -2.0, LON = 0.0, ELEV = 1200, TZ = 'Etc/GMT-3', OFFSET = 3 * H;
const KIWI = '00000000000000B1', LSN = '00000000000000B2', VALVE = '00000000000000B3';
const RATE = 8;                                            // L/min, drip line and valve setting
const FORECAST_RAIN_DATE = '2027-01-13';                   // a forecast storm 14:00-16:59 local on day 3

function doy(date: string) { const d = Date.parse(`${date}T00:00:00Z`); return Math.floor((d - Date.UTC(new Date(d).getUTCFullYear(), 0, 1)) / DAY) + 1; }
function weatherFor(date: string) {                        // deterministic toy weather, January-like
  const n = Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY);
  return {tMinC: 15.6 + (n % 3) * 0.4, tMaxC: 29.3 + (n % 4) * 0.5, meanRhPct: 64 - (n % 5), windSpeedMs: 1.54, solarRadMjM2: 23.3};
}
type HourlyRain = (date: string) => number[];
const stormHours: HourlyRain = date => Array.from({length: 24}, (_, h) => date === FORECAST_RAIN_DATE && h >= 14 && h < 17 ? 2 : 0);
const weatherSourceWith = (hourly: HourlyRain) => (date: string, _zone?: unknown, _now?: number) => {
  if (date < '2026-10-11') return null;                    // before the generator start (plan 6.2)
  const w = weatherFor(date);
  const et0 = fao56Et0({...w, windHeightM: 2, elevationM: ELEV, latDeg: LAT, dayOfYear: doy(date)});
  const rainByHour = hourly(date);
  return et0 == null ? null : {et0, rain: rainByHour.reduce((a, b) => a + b, 0), maxTemp: w.tMaxC, meanRhPct: w.meanRhPct,
    windSpeedMps: w.windSpeedMs, et0Source: 'fao56_daily_game_weather', et0Tier: 'fao56_daily', hourlyRainMm: rainByHour};
};
const weatherSource = weatherSourceWith(stormHours);
// End-stamped forecast rows built from the game's own hours (not from the simulator): a row at T carries the local
// hour [T - 1 h, T), as Open-Meteo points do on the edge (osi-zone-env sumRain, basis 'end').
function gameForecastRows(now: number, hourly: HourlyRain) {
  const first = Math.floor(now / H) * H + H;
  return Array.from({length: 72}, (_, i) => {
    const T = first + i * H, local = new Date(T - H + OFFSET);
    return {time: new Date(T).toISOString(), rainMm: hourly(local.toISOString().slice(0, 10))[local.getUTCHours()]!};
  });
}

type Tier = 1 | 2 | 3 | 4;
type Opts = {tapAt?: number; tapMinutes?: number; tankLiters?: number; weeklyPlan?: boolean; oncePlanAt?: number;
  dueNowPlan?: {getAfter: boolean}; interleaveGets?: boolean; until?: number; hourly?: HourlyRain; gridMinutes?: number;
  // Round 4: world events dispatched at their own instant (the advance loop stops there), and world rain.
  manualOpen?: {at: number; seconds: number}; canFill?: {at: number; liters: number}; observeAt?: number;
  rainLog?: Array<{from: number; to: number; mm: number}>;
  // Round 5: a pump completion that adds litres to the tank at its own instant.
  refill?: {at: number; liters: number}};
let delivered = 0;                                         // world litres that left the tank through the valve (tank-clamped)
function run(tier: Tier, opts: Opts = {}) {
  const world = {tankLiters: opts.tankLiters ?? 1000, tapFlowLog: [] as Array<{from: number; to: number}>, lastLsnAt: START, cutoffs: [] as number[], kpa: 45};
  const tapLitersBetween = (from: number, to: number) => world.tapFlowLog.reduce((sum, w) => sum + Math.max(0, Math.min(w.to, to) - Math.max(w.from, from)) / MIN * RATE, 0);
  // World rain, spread evenly over each logged interval; the gauge reports what fell since its previous uplink.
  const rainBetween = (from: number, to: number) => (opts.rainLog ?? []).reduce((sum, r) =>
    sum + r.mm * Math.max(0, Math.min(r.to, to) - Math.max(r.from, from)) / (r.to - r.from), 0);
  const sim = new Simulator({mode: 'public', fictionalHistory: false, weatherSource: opts.hourly ? weatherSourceWith(opts.hourly) : weatherSource,
    readingSource: (device: any, at: number, synthetic: () => Record<string, unknown>) => {
      if (device.type_id === 'KIWI_SENSOR') return {swt_1: world.kpa, swt_2: world.kpa - 10, bat_pct: 90};
      if (device.type_id === 'DRAGINO_LSN50') {
        const liters = Number(tapLitersBetween(world.lastLsnAt, at).toFixed(2));
        const rain = Number(rainBetween(world.lastLsnAt, at).toFixed(2));
        const rainPer10 = rain > 0 && at > world.lastLsnAt ? Number((rain * 10 * MIN / (at - world.lastLsnAt)).toFixed(2)) : 0;
        world.lastLsnAt = at;
        return {rain_mm_delta: rain, rain_mm_per_10min: rainPer10, flow_liters_delta: liters, flow_liters_per_10min: 0,
          lsn50_mode_label: 'MOD9', lsn50_mode_code: 9, bat_pct: 88};
      }
      return synthetic();
    }});
  const req = (m: string, p: string, b: unknown = {}) => sim.request(m, p, b) as any;

  // Water tap: litres from the outcomes ledger (same formula as demo/model.ts integrateCommandFlow).
  const valveLitersBetween = (from: number, to: number) => {
    let total = 0;
    for (const o of sim.outcomes) {
      if (!o.observedOpenAt) continue;
      const open = Date.parse(o.observedOpenAt), close = o.observedCloseAt ? Date.parse(o.observedCloseAt) : to;
      const active = sim.state.activeCommands.get(o.deviceEui);
      const rate = active?.expectation_id === o.expectationId ? active.flow_rate_lpm! : Number(o.flowRateLpm ?? 0);
      total += Math.max(0, Math.min(close, to) - Math.max(open, from)) / MIN * rate;
    }
    return total;
  };
  // The tank starts at START; before the builder moves the clock there, there is nothing to draw from it.
  let tankAt: number | null = null; const closeIssuedFor = new Set<string>();
  const tankNow = () => {
    if (tankAt === null) return world.tankLiters;
    const drawn = valveLitersBetween(tankAt, sim.now); delivered += Math.min(drawn, world.tankLiters);
    world.tankLiters = Math.max(0, world.tankLiters - drawn); tankAt = sim.now; return world.tankLiters;
  };
  // Cutoff (plan 4.4): CLOSE lands 2 s after it is sent; for a pending command, aim at ACK + tank/rate so an
  // empty tank closes the valve before it opens.
  const nextCutoffAt = (): number | null => {
    const cmd = sim.state.activeCommands.get(VALVE);
    if (!cmd || closeIssuedFor.has(cmd.expectation_id)) return null;
    const runMs = tankNow() / cmd.flow_rate_lpm! * MIN;
    if (cmd.reconciliation_state === 'PENDING_OBSERVATION') return Math.max(sim.now, Math.floor(Date.parse(cmd.commanded_at) + cmd.open_delay_ms + runMs - 2000));
    if (cmd.reconciliation_state === 'OBSERVED_RUNNING') return Math.max(sim.now, Math.floor(sim.now + runMs - 2000));
    return null;
  };
  // The tap's after-step logic: update the tank, then send a cutoff CLOSE that is due. True when a CLOSE was sent.
  const afterStep = (): boolean => {
    tankNow();
    const due = nextCutoffAt();
    if (due === null || due > sim.now) return false;
    const cmd = sim.state.activeCommands.get(VALVE)!;
    closeIssuedFor.add(cmd.expectation_id); world.cutoffs.push(sim.now);
    req('POST', `/api/valve/${VALVE}`, {action: 'CLOSE'});
    return true;
  };
  // World events (plan 4.2): manual opens, can fills, refills and observations, each run at its own instant. A manual
  // open is a command (sent, then drained); a tank event first settles valve flow up to now, then changes the level.
  const events: Array<{at: number; act: () => void}> = [];
  const runDueEvents = () => { while (events.length && events[0]!.at <= sim.now) events.shift()!.act(); };
  // One order at every instant, as plan 4.2 drainNow: simulator events due now, then world events due now, then the
  // tap's after-step logic (cutoff recomputed from the resulting tank level, a due CLOSE sent); again while a CLOSE
  // was just sent.
  const drainNow = () => { do { sim.advanceTo(sim.now); runDueEvents(); } while (afterStep()); };
  const write = (m: string, p: string, b: unknown = {}) => { const result = req(m, p, b); drainNow(); return result; };

  // Farm builder, plan section 4.7 (plan revision 6 order).
  for (const d of [...sim.devices]) write('DELETE', `/api/devices/${d.deveui}`);
  sim.clock.reset(START);
  tankAt = START; delivered = 0;
  sim.state.now = START;
  sim.state.settings.defaultTimezone = TZ;
  write('PUT', '/api/irrigation-zones/1/config', {cropType: 'tomato', phenologicalStage: 'mid_season', stageStartedOn: '2027-01-06',
    areaM2: 64, irrigationEfficiencyPct: 90, soilType: 'sandy_loam', irrigationMethod: 'drip', timezone: TZ, weatherSource: tier >= 2 ? 'auto' : 'local'});
  write('PUT', '/api/irrigation-zones/1/location', {latitude: LAT, longitude: LON});
  write('PUT', '/api/system/settings', {gatewayTimezone: TZ});
  write('PUT', '/api/irrigation-zones/1/name', {name: 'Tomato bed'});
  write('DELETE', '/api/irrigation-zones/2');
  sim.resetEnvironmentRecords();                           // after the last zone, location and settings write
  write('POST', '/api/devices', {deveui: KIWI, name: 'Bed soil probe', type_id: 'KIWI_SENSOR', zone_id: 1});
  const kiwiAtCreation = structuredClone((req('GET', '/api/devices') as any[]).find(d => d.deveui === KIWI)?.latest_data);
  let lsnAtCreation: any = null;
  if (tier >= 2) {
    write('POST', '/api/devices', {deveui: LSN, name: 'Rain and flow meter', type_id: 'DRAGINO_LSN50', zone_id: 1});
    lsnAtCreation = structuredClone((req('GET', '/api/devices') as any[]).find(d => d.deveui === LSN)?.latest_data);
  }
  if (tier >= 3) {
    write('POST', '/api/devices', {deveui: VALVE, name: 'Bed valve', type_id: 'STREGA_VALVE', zone_id: 1});
    write('PUT', `/api/valves/${VALVE}/settings`, {flow_rate_lpm: RATE});
  }
  if (tier >= 4 && !opts.weeklyPlan) write('PUT', '/api/irrigation-zones/1/schedule', {trigger_metric: 'SWT_1', threshold_kpa: 30, duration_minutes: 60, enabled: true});
  if (opts.weeklyPlan) write('POST', `/api/valves/${VALVE}/schedules`, {kind: 'WEEKLY', weekdays_mask: 127, start_time: '18:00', duration_minutes: 60});
  if (opts.oncePlanAt !== undefined) write('POST', `/api/valves/${VALVE}/schedules`, {kind: 'ONCE', fire_at: new Date(opts.oncePlanAt).toISOString(), duration_minutes: 60});
  sim.state.sessions.pendingOutboxCount = 0;
  drainNow();

  const GET_ROUTES = ['/api/devices', '/api/irrigation-zones', '/api/valves', '/api/irrigation/recent-actuations',
    '/api/irrigation-zones/1/environment-summary', `/api/valves/${VALVE}/schedules`, '/api/system/settings'];
  const getAll = () => { for (const route of GET_ROUTES) { try { req('GET', route); } catch { /* route absent at this tier */ } } };
  // The host calls on a 97-minute grid by default (gridMinutes changes it); only interleaveGets issues GETs at its
  // points. The grid does not move the retained records' capture stamps: the loop also stops at every local
  // midnight, where the daily refresh runs (C10, C19).
  let nextGridAt = START + 37 * MIN;
  // The advance loop stops at the next simulator event, cutoff, local midnight, grid point and world event; at each
  // stop drainNow() settles the instant (plan 4.2 advanceOsi).
  const advance = (target: number) => {
    drainNow();
    while (sim.now < target) {
      const nextSim = sim.clock.nextEventAt(target - sim.now) ?? target;
      const cutoff = nextCutoffAt();
      // Plan 4.2: the loop also stops at every local midnight, so the simulator's daily record refresh
      // (model.ts refreshCompletedEnvironmentRecords) always runs at 00:00 whatever the host's call grid.
      const nextMidnight = Math.floor((sim.now + 3 * H) / DAY) * DAY + DAY - 3 * H;
      const step = Math.min(target, nextSim, cutoff ?? target, nextMidnight, Math.max(sim.now + 1, nextGridAt), events[0]?.at ?? target);
      sim.advanceTo(step);
      drainNow();
      if (sim.now >= nextGridAt) {
        if (opts.interleaveGets) getAll();
        nextGridAt += (opts.gridMinutes ?? 97) * MIN;
      }
    }
  };
  if (opts.tapAt !== undefined) world.tapFlowLog.push({from: opts.tapAt, to: opts.tapAt + (opts.tapMinutes ?? 30) * MIN});
  if (opts.manualOpen) {
    const {seconds} = opts.manualOpen;
    events.push({at: opts.manualOpen.at, act: () => { write('POST', `/api/valve/${VALVE}`, {action: 'OPEN_FOR_DURATION', duration_seconds: seconds}); }});
  }
  // Tank events: settle the valve's draw up to now, then change the tank level. A can filled from the tank tap takes
  // its litres out (never counted as delivered through the valve); a pump completion adds litres. The cutoff is read
  // before and after the change; drainNow() then recomputes it and sends a CLOSE that is due.
  type TankEventLog = {at: string; tankBefore: number; tankAfter: number; cutoffBefore: string | null; cutoffAfter: string | null};
  const tankEvent = (deltaLiters: number): TankEventLog => {
    const tankBefore = tankNow(), before = nextCutoffAt();
    world.tankLiters = Math.max(0, world.tankLiters + deltaLiters);
    const after = nextCutoffAt();
    return {at: new Date(sim.now).toISOString(), tankBefore: Number(tankBefore.toFixed(3)), tankAfter: Number(world.tankLiters.toFixed(3)),
      cutoffBefore: before === null ? null : new Date(before).toISOString(), cutoffAfter: after === null ? null : new Date(after).toISOString()};
  };
  let canFillLog: TankEventLog | null = null;
  if (opts.canFill) {
    const {liters} = opts.canFill;
    events.push({at: opts.canFill.at, act: () => { canFillLog = tankEvent(-liters); }});
  }
  let refillLog: TankEventLog | null = null;
  if (opts.refill) {
    const {liters} = opts.refill;
    events.push({at: opts.refill.at, act: () => { refillLog = tankEvent(liters); }});
  }
  let observed: Record<string, unknown> | null = null;
  if (opts.observeAt !== undefined) events.push({at: opts.observeAt, act: () => {
    observed = structuredClone((req('GET', '/api/devices') as any[]).find(d => d.deveui === LSN)?.latest_data ?? null);
  }});
  events.sort((a, b) => a.at - b.at);
  let dueNowWriteAt: number | null = null;
  if (opts.dueNowPlan) {
    advance(START + DAY + 30 * MIN);                       // 07:00 local on day 2
    dueNowWriteAt = sim.now;
    write('POST', `/api/valves/${VALVE}/schedules`, {kind: 'ONCE', fire_at: new Date(sim.now - 60_000).toISOString(), duration_minutes: 10});
    if (opts.dueNowPlan.getAfter) getAll();
  }
  const dueNowPlanRow = dueNowWriteAt === null ? null
    : structuredClone((sim.state.schedules.get(VALVE) ?? []).find(p => p.kind === 'ONCE') ?? null);
  advance(opts.until ?? START + DAY + 6 * H);              // to 12:30 local on day 2
  const env = req('GET', '/api/irrigation-zones/1/environment-summary');
  const w = env.water;
  const today = w.daily?.find((d: any) => d.date === w.todayDate) ?? null;
  // Edge inputs for the same world: a gauge makes rain known; with area and efficiency set, missing flow counts as
  // 0 L (osi-zone-env/http-facade.js:369; net mm via index.js:786 toEffectiveIrrigationMm), so measured net
  // irrigation is 0 without a meter.
  const edge = zoneEnv.resolveWaterAction(w.todayDate, null, w.balanceTodayMm, w.next24hRainMm, w.waterNeededTodayMm,
    tier >= 2, tier >= 2 ? (today?.irrigationNetMm ?? 0) : 0);
  const records = [...sim.state.environmentRecords.values()];
  // Edge inputs assembled from world state (plan 5.2): no value taken from the simulator's summary.
  const localDate = new Date(sim.now + OFFSET).toISOString().slice(0, 10);
  const localMidnight = Date.parse(`${localDate}T00:00:00Z`) - OFFSET;
  const wx = weatherFor(localDate);
  const demandW = round2(fao56Et0({...wx, windHeightM: 2, elevationM: ELEV, latDeg: LAT, dayOfYear: doy(localDate)}) *
    cropKc.resolveKc({cropType: 'tomato', phenologicalStage: 'mid_season', stageStartedOn: '2027-01-06', date: localDate}).kc);
  const gaugeUplinks = sim.readings.forDevice(LSN).filter((r: any) => r.at >= localMidnight && r.at <= sim.now);
  const rainKnownW = tier >= 2 && gaugeUplinks.length > 0;
  const tapTodayW = tapLitersBetween(localMidnight, sim.now) + (tier >= 3 ? delivered : 0);
  const netW = tier >= 2 ? round2(tapTodayW * 0.9 / 64) : 0;            // osi-zone-env/index.js:786 toEffectiveIrrigationMm
  const rainW = Number(rainBetween(localMidnight, sim.now).toFixed(2));  // world rain today (0 unless rainLog is set)
  const balanceW = rainKnownW ? round2(rainW + netW - demandW) : null;
  // Next 24 h of forecast rain from the game's own end-stamped hours, summed by the edge's sumRain.
  const gameRows = gameForecastRows(sim.now, opts.hourly ?? stormHours);
  const next24W = zoneEnv.sumRain(gameRows, sim.now, 24, {source: 'open_meteo', basis: 'end'}).totalMm ?? 0;
  const edgeWorld = tier >= 2 ? zoneEnv.resolveWaterAction(localDate, null, balanceW, next24W, demandW, rainKnownW, netW) : null;
  const midnightUplink = sim.readings.forDevice(LSN).some((r: any) => r.at === localMidnight);
  const lsnNow = (req('GET', '/api/devices') as any[]).find(d => d.deveui === LSN)?.latest_data ?? null;
  // base64 digest: no long hexadecimal runs in committed output (doc hygiene). Retained environment records are
  // included with every field (source_captured_at and provenance capturedAt among them).
  const digest = createHash('sha256').update(JSON.stringify([sim.zones, sim.devices, sim.outcomes, sim.state.triggerEvaluations,
    sim.devices.map((d: any) => sim.readings.forDevice(d.deveui)), [...sim.state.schedules.entries()],
    [...sim.state.environmentRecords.entries()]])).digest('base64').slice(0, 16);
  return {tier, zone: {crop: sim.zones[0].crop_type, stage: sim.zones[0].phenological_stage, lat: sim.zones[0].latitude, lon: sim.zones[0].longitude,
      tz: sim.state.settings.gatewayTimezone},
    simAction: w.action ? {code: w.action.code, source: w.action.source, reasonCode: w.action.reasonCode} : null,
    edgeAction: {code: edge.code, source: edge.source, reasonCode: edge.reasonCode},
    daily: (w.daily ?? []).map((d: any) => ({date: d.date, et0: d.et0Mm, irrigationLiters: d.irrigationLiters})),
    today: today ? {date: today.date, et0: today.et0Mm, kc: today.kc, demand: today.demandMm, irrigationLiters: today.irrigationLiters, irrigationNetMm: today.irrigationNetMm} : null,
    expectedEt0: weatherSource(w.todayDate)?.et0 ?? null, next24h: w.next24hRainMm, now: sim.now,
    foreignRecords: records.filter(r => r.timezone !== TZ || String(r.values.location_key ?? '').includes('0.35')).length, recordCount: records.length,
    kiwiAtCreation, lsnAtCreation, lsnNow,
    outcomes: sim.outcomes.map((o: any) => ({trigger: o.trigger, status: o.status, commanded: o.commandedAt ?? null, open: o.observedOpenAt, close: o.observedCloseAt, liters: o.estimatedGrossLiters})),
    cutoffs: world.cutoffs.map(t => new Date(t).toISOString()), tankLeft: Number(world.tankLiters.toFixed(3)), digest,
    delivered: Number(delivered.toFixed(3)), edgeWorld: edgeWorld ? {code: edgeWorld.code, source: edgeWorld.source, reasonCode: edgeWorld.reasonCode} : null,
    worldInputs: {demand: demandW, net: netW, balance: balanceW, next24: next24W, rainKnown: rainKnownW}, midnightUplink,
    dueNowWriteAt, dueNowPlanRow,
    // Round 4 fields (kept out of the objects that earlier checks print, so their lines stay unchanged).
    canFillLog: canFillLog as typeof canFillLog, observed: observed as Record<string, unknown> | null, worldRain: rainW,
    todayRainMm: today?.rainMm ?? null,
    rainUplinks: sim.readings.forDevice(LSN).filter((r: any) => Number(r.values.rain_mm_delta) > 0)
      .map((r: any) => ({at: new Date(r.at).toISOString(), mm: r.values.rain_mm_delta})),
    // Delivery-time attribution: valve litres by local day from the outcomes ledger (the world's view).
    worldValveByDay: (w.daily ?? []).map((d: any) => {
      const from = Date.parse(`${d.date}T00:00:00Z`) - OFFSET;
      return {date: d.date, liters: Number(valveLitersBetween(from, Math.min(from + DAY, sim.now)).toFixed(3))};
    }),
    // Round 5 fields.
    refillLog: refillLog as TankEventLog | null};
}

const T1 = run(1);
const T2 = run(2, {tapAt: START + DAY + 30 * MIN, tapMinutes: 30});          // 07:00-07:30 day 2, 240 L
const T4 = run(4, {tankLiters: 100});                                         // trigger at 06:00 day 2, 60 min ordered
const PLAN = run(3, {tankLiters: 100, weeklyPlan: true});                     // weekly plan 18:00 day 1
const T4b = run(4, {tankLiters: 100});
const T4gets = run(4, {tankLiters: 100, interleaveGets: true});
const RAIN = run(2, {until: START + DAY + 4 * H});                            // 10:30 local day 2; storm 14:00-17:00 day 3 is 27.5-30.5 h ahead
const RAIN2 = run(2, {until: START + DAY + 14 * H});                          // 20:30 local day 2; storm is inside the next 24 h
const tally = {pass: 0, fail: 0};
const check = (name: string, ok: boolean, detail: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
  tally[ok ? 'pass' : 'fail']++;
  if (!ok) process.exitCode = 1;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check('C1 T1 verdict equals edge (demand unknown)', same(T1.simAction, T1.edgeAction) && T1.simAction?.reasonCode === 'demand_unknown', {sim: T1.simAction, edge: T1.edgeAction});
check('C1 T1 every daily row has no ET0', T1.daily.length > 0 && T1.daily.every(d => d.et0 === null), T1.daily);
check('C2 tap litres credited in the Water tab', T2.today?.irrigationLiters === 240 && Math.abs((T2.today?.irrigationNetMm ?? 0) - 3.38) < 0.011, T2.today);
check('C2 meter latest_data flow total has no lag', T2.lsnNow?.flow_liters_today === 240, {flow_liters_today: T2.lsnNow?.flow_liters_today});
check('C2 T2 verdict equals edge', same(T2.simAction, T2.edgeAction), {sim: T2.simAction, edge: T2.edgeAction});
const trig = T4.outcomes.find(o => o.trigger === 'trigger_based');
check('C3 trigger run cut off at tank volume', !!trig && trig.status === 'CANCELLED' && Math.abs((trig.liters ?? 0) - 100) < 0.3 && T4.tankLeft === 0, {trig, cutoffs: T4.cutoffs});
const plan = PLAN.outcomes.find(o => o.trigger === 'on_valve_schedule');
check('C4 weekly plan run cut off at tank volume', !!plan && plan.status === 'CANCELLED' && Math.abs((plan.liters ?? 0) - 100) < 0.3, {plan, cutoffs: PLAN.cutoffs});
check('C5 builder inputs accepted', T2.zone.stage === 'mid_season' && T2.zone.lon === 0 && T2.zone.tz === TZ, T2.zone);
check('C5 Kc mid-season tomato', T2.today?.kc === 1.15, {kc: T2.today?.kc});
check('C5 phone ET0 equals fao56Et0', T2.today?.et0 === T2.expectedEt0, {phone: T2.today?.et0, game: T2.expectedEt0});
check('C6 deterministic', T4.digest === T4b.digest, {a: T4.digest, b: T4b.digest});
check('C7 no foreign environment records', [T1, T2, T4, PLAN].every(r => r.foreignRecords === 0), [T1, T2, T4, PLAN].map(r => [r.tier, r.foreignRecords, r.recordCount]));
check('C8 Kiwi latest_data from the source at creation', T1.kiwiAtCreation?.swt_1 === 45 && T1.kiwiAtCreation?.swt_2 === 35 && T1.kiwiAtCreation?.bat_pct === 90, T1.kiwiAtCreation);
check('C8 meter latest_data from the source at creation', T2.lsnAtCreation?.lsn50_mode_label === 'MOD9' && T2.lsnAtCreation?.bat_pct === 88, T2.lsnAtCreation);
check('C9 storm outside the next 24 h is not counted', RAIN.next24h === 0, {next24h: RAIN.next24h});
check('C9 storm inside the next 24 h is counted from source hours', RAIN2.next24h === 6, {next24h: RAIN2.next24h});
check('C10 GETs do not change the digest (environment records included)', T4gets.digest === T4.digest && T4.recordCount > 0,
  {withGets: T4gets.digest, without: T4.digest, records: [T4gets.recordCount, T4.recordCount]});

const EMPTY = run(4, {tankLiters: 0});
const SMALL = run(3, {tankLiters: 0.15, weeklyPlan: true});
const V1 = run(2);                                                          // dry day, 12:30 local day 2
const V2 = run(2, {tapAt: START + DAY + 30 * MIN, tapMinutes: 50});        // 400 L tap run 07:00-07:50 day 2
const V3 = run(2, {until: START + DAY + 14 * H});                           // 20:30 day 2, storm 14:00-17:00 day 3
const V4 = run(2, {until: START + DAY + 17 * H + 40 * MIN});                // 00:10 local day 3
const e0 = EMPTY.outcomes.find(o => o.trigger === 'trigger_based');
check('C11 empty tank: closed before opening, 0 L', !!e0 && e0.status === 'CANCELLED' && e0.open === null && (e0.liters ?? 0) === 0 && EMPTY.delivered === 0, {e0, cutoffs: EMPTY.cutoffs});
const s0 = SMALL.outcomes.find(o => o.trigger === 'on_valve_schedule');
check('C12 plan start with 0.15 L: counted <= tank + 2 s of flow, delivered = tank', !!s0 && (s0.liters ?? 0) <= 0.15 + 2 / 60 * RATE + 1e-9 && SMALL.delivered === 0.15, {counted: s0?.liters, delivered: SMALL.delivered});
for (const [name, v, expect] of [['dry day', V1, 'irrigate_today'], ['after 400 L tap', V2, 'delay_irrigation'], ['storm inside 24 h', V3, 'delay_irrigation'], ['just after midnight', V4, null]] as const) {
  check(`C13 parity from world inputs: ${name}`, same(v.simAction, v.edgeWorld) && (expect === null || v.simAction?.code === expect), {sim: v.simAction, edgeWorld: v.edgeWorld, worldInputs: v.worldInputs});
}
check('C14 gauge uplink at local midnight', V4.midnightUplink === true && V4.worldInputs.rainKnown === true, {midnightUplink: V4.midnightUplink});

// C15: at T3, 07:00 local on day 2, a ONCE plan whose fire_at is a minute in the past.
const DUE = run(3, {dueNowPlan: {getAfter: false}});
const DUEget = run(3, {dueNowPlan: {getAfter: true}});
const dueRun = (r: typeof DUE) => {
  const o = r.outcomes.find(row => row.trigger === 'on_valve_schedule');
  const at = new Date(r.dueNowWriteAt!).toISOString();
  return {writeAt: at, commanded: o?.commanded ?? null, open: o?.open ?? null, planState: r.dueNowPlanRow?.once_state ?? null,
    dispatchedAt: r.dueNowPlanRow?.dispatch_created_at ?? null};
};
check('C15 due-now one-time plan: a GET right after the write does not change the digest', DUE.digest === DUEget.digest, {withGet: DUEget.digest, without: DUE.digest});
// The plan dispatches at the write's own instant. A one-time dispatch is acknowledged 2 s after it is commanded
// (plans.ts passes a 2000 ms open delay to startActuation), so the observed open is the write time + 2 s.
for (const [name, r] of [['without GET', DUE], ['with GET', DUEget]] as const) {
  const d = dueRun(r);
  const ackAt = new Date(r.dueNowWriteAt! + 2000).toISOString();
  check(`C15 due-now one-time plan dispatches at the write's instant (${name})`,
    d.commanded === d.writeAt && d.dispatchedAt === d.writeAt && d.planState === 'FIRED' && d.open === ackAt, {...d, expectedOpen: ackAt});
}

// C16: rain in the first hour after now (local 07:00-08:00 on day 2) and in the hour ending at now + 24 h on the
// hour (local 06:00-07:00 on day 3); decoys in the hour ending at now and in the hour after the window.
const windowRain: HourlyRain = date => Array.from({length: 24}, (_, h) =>
  date === '2027-01-12' ? (h === 7 ? 1.5 : h === 6 ? 0.7 : 0) : date === '2027-01-13' ? (h === 6 ? 2.5 : h === 7 ? 0.9 : 0) : 0);
for (const [name, until] of [['on the hour', START + DAY + 30 * MIN], ['30 minutes past', START + DAY + 60 * MIN]] as const) {
  const r = run(2, {until, hourly: windowRain});
  const edge = zoneEnv.sumRain(gameForecastRows(r.now, windowRain), r.now, 24, {source: 'open_meteo', basis: 'end'}).totalMm;
  check(`C16 forecast window equals edge sumRain over game rows (${name})`, r.next24h === edge && edge === 4,
    {now: new Date(r.now).toISOString(), sim: r.next24h, edge});
}

check('C17 meter latest_data at registration shows a measured zero', T2.lsnAtCreation?.flow_liters_today === 0,
  {flow_liters_today: T2.lsnAtCreation?.flow_liters_today});

// C18: a ONCE plan at 18:00 local on day 1 with 0.15 L in the tank.
const ONCE_SMALL = run(3, {tankLiters: 0.15, oncePlanAt: START + 11 * H + 30 * MIN});
const o0 = ONCE_SMALL.outcomes.find(o => o.trigger === 'on_valve_schedule');
check('C18 one-time plan start with 0.15 L: counted = delivered = 0.15 L (pre-ACK cutoff)',
  !!o0 && o0.liters === 0.15 && ONCE_SMALL.delivered === 0.15,
  {counted: o0?.liters, delivered: ONCE_SMALL.delivered, open: o0?.open, close: o0?.close, cutoffs: ONCE_SMALL.cutoffs});

const T4grid = run(4, {tankLiters: 100, gridMinutes: 61});
check('C19 host call grid does not change the digest (records and capture stamps included)', T4grid.digest === T4.digest, {grid61: T4grid.digest, grid97: T4.digest});

// C20: at T3, a manual 10-minute open commanded at 07:00 local on day 2 with 79 L in the tank at 8 L/min. Without
// the can the tank would last 9 min 52.5 s and the cutoff would win just before the natural close. The natural
// close instant comes from a reference run with a full tank.
const OPEN_AT = START + DAY + 30 * MIN;
const C20_UNTIL = START + DAY + 60 * MIN;
const C20REF = run(3, {manualOpen: {at: OPEN_AT, seconds: 600}, until: C20_UNTIL});
const ref0 = C20REF.outcomes.find(o => o.trigger !== 'on_valve_schedule' && o.trigger !== 'trigger_based');
const naturalClose = ref0?.close ? Date.parse(ref0.close) : NaN;
const FILL_AT = naturalClose - 2 * MIN;
const CAN = run(3, {tankLiters: 79, manualOpen: {at: OPEN_AT, seconds: 600}, canFill: {at: FILL_AT, liters: 10}, until: C20_UNTIL});
const can0 = CAN.outcomes.find(o => o.trigger !== 'on_valve_schedule' && o.trigger !== 'trigger_based');
const fill = CAN.canFillLog;
const expectedCutoff = FILL_AT + Math.floor((fill?.tankAfter ?? 0) / RATE * MIN) - 2000;
const winner = can0?.status === 'CANCELLED' ? 'CANCELLED cutoff' : can0?.status === 'COMPLETED' ? 'COMPLETED natural close' : String(can0?.status);
check('C20 reference run: the natural close is the 10-minute timed close (COMPLETED)',
  ref0?.status === 'COMPLETED' && Number.isFinite(naturalClose) && naturalClose - Date.parse(ref0.open!) === 600_000,
  {commanded: ref0?.commanded, open: ref0?.open, naturalClose: ref0?.close, status: ref0?.status, liters: ref0?.liters});
check('C20 can fill: the cutoff CLOSE is recomputed after the fill and sent at the recomputed instant',
  !!fill && fill.cutoffBefore !== null && fill.cutoffAfter !== null && Date.parse(fill.cutoffAfter) < Date.parse(fill.cutoffBefore)
    && Date.parse(fill.cutoffAfter) === expectedCutoff && CAN.cutoffs.length === 1 && CAN.cutoffs[0] === fill.cutoffAfter,
  {fill, cutoffsSent: CAN.cutoffs});
check('C20 can fill: estimated equals delivered (litres that left the tank through the valve)',
  !!can0 && can0.liters === CAN.delivered && CAN.delivered === Number((79 - 10).toFixed(3)) && CAN.tankLeft === 0,
  {estimated: can0?.liters, delivered: CAN.delivered, tankLeft: CAN.tankLeft, closeWon: winner,
    open: can0?.open, close: can0?.close, naturalClose: ref0?.close});

// C21: 6 mm of world rain, 07:00-09:00 local on day 2, read by the gauge on its half-hour uplinks; 12:30 local.
const GAUGE = run(2, {rainLog: [{from: START + DAY + 30 * MIN, to: START + DAY + 150 * MIN, mm: 6}]});
check('C21 gauge rain: the uplinks carry the world rain and the Water tab shows 6 mm today',
  GAUGE.todayRainMm === 6 && GAUGE.worldRain === 6 && GAUGE.rainUplinks.reduce((sum, r) => sum + Number(r.mm), 0) === 6,
  {todayRainMm: GAUGE.todayRainMm, worldRain: GAUGE.worldRain, uplinks: GAUGE.rainUplinks});
check('C21 gauge rain parity: verdict equals the edge on world inputs with the measured rain (and differs from the dry day)',
  same(GAUGE.simAction, GAUGE.edgeWorld) && GAUGE.worldInputs.rainKnown === true && !same(GAUGE.simAction, V1.simAction),
  {sim: GAUGE.simAction, edgeWorld: GAUGE.edgeWorld, worldInputs: {...GAUGE.worldInputs, rain: GAUGE.worldRain}, dryDay: V1.simAction});

// C22: a manual 10-minute open commanded at 23:54:58 local on day 2, so the valve opens at 23:55:00 (the manual
// ACK comes 2 s after the command) and closes at 00:05:00. The meter is read right after the 00:00 uplink.
const MIDNIGHT3 = START + DAY + 17 * H + 30 * MIN;                          // 00:00 local on day 3
const NIGHT = run(3, {manualOpen: {at: MIDNIGHT3 - 5 * MIN - 2000, seconds: 600}, observeAt: MIDNIGHT3, until: MIDNIGHT3 + 10 * MIN});
const night0 = NIGHT.outcomes.find(o => o.trigger !== 'on_valve_schedule' && o.trigger !== 'trigger_based');
const byDay = (rows: Array<{date: string; liters?: number; irrigationLiters?: number | null}>, date: string) => {
  const row = rows.find(r => r.date === date); return row ? (row.liters ?? row.irrigationLiters ?? null) : null;
};
const attributions = {
  bySampleTime: {'2027-01-12': byDay(NIGHT.daily, '2027-01-12'), '2027-01-13': byDay(NIGHT.daily, '2027-01-13')},
  byDeliveryTime: {'2027-01-12': byDay(NIGHT.worldValveByDay, '2027-01-12'), '2027-01-13': byDay(NIGHT.worldValveByDay, '2027-01-13')},
};
check('C22 meter today counter right after the 00:00 uplink shows the litres up to 00:00 (new day, by sample time)',
  NIGHT.observed?.sampled_at === new Date(MIDNIGHT3).toISOString() && NIGHT.observed?.flow_liters_today === 40,
  {sampled_at: NIGHT.observed?.sampled_at, flow_liters_today: NIGHT.observed?.flow_liters_today, flow_liters_delta: NIGHT.observed?.flow_liters_delta,
    commanded: night0?.commanded, open: night0?.open, close: night0?.close, status: night0?.status});
check('C22 world report attributes 40 L to each day by delivery time; estimated total equals delivered total (80 L)',
  attributions.byDeliveryTime['2027-01-12'] === 40 && attributions.byDeliveryTime['2027-01-13'] === 40
    && night0?.liters === 80 && NIGHT.delivered === 80,
  {...attributions, estimated: night0?.liters, delivered: NIGHT.delivered});

const manualOf = (r: ReturnType<typeof run>) => r.outcomes.find(o => o.trigger !== 'on_valve_schedule' && o.trigger !== 'trigger_based');
const isoAt = (t: number) => Number.isFinite(t) ? new Date(t).toISOString() : null;
const closeWon = (status: string | undefined) => status === 'CANCELLED' ? 'CANCELLED cutoff' : status === 'COMPLETED' ? 'COMPLETED natural close' : String(status);

// C23: a refill at the cutoff send instant. Reference: the C20 manual 10-minute open with 79 L and no can fill. Its
// cutoff CLOSE is sent at T, when 2 s of flow are left in the tank, and lands at T + 2 s. A pump completion adds 20 L
// exactly at T (run A) or 1 ms after T (run B). At T the refill is applied before the cutoff is recomputed, so run A
// sends no CLOSE and ends at its natural close. In run B the CLOSE sent at T stays in flight (a CLOSE is never
// withdrawn) and lands at T + 2 s; the refill changes only how much of that flight the tank can supply (all of it).
const expectedSendT = OPEN_AT + Math.floor(79 / RATE * MIN);   // ACK at +2 s, then tank / rate, minus the 2 s flight
const REFILL_REF = run(3, {tankLiters: 79, manualOpen: {at: OPEN_AT, seconds: 600}, until: C20_UNTIL});
const sendT = REFILL_REF.cutoffs.length === 1 ? Date.parse(REFILL_REF.cutoffs[0]!) : expectedSendT;
const REFILL_AT_T = run(3, {tankLiters: 79, manualOpen: {at: OPEN_AT, seconds: 600}, refill: {at: sendT, liters: 20}, until: C20_UNTIL});
const REFILL_AFTER_T = run(3, {tankLiters: 79, manualOpen: {at: OPEN_AT, seconds: 600}, refill: {at: sendT + 1, liters: 20}, until: C20_UNTIL});
const [rRef, rA, rB] = [REFILL_REF, REFILL_AT_T, REFILL_AFTER_T].map(manualOf);
const refillDetail = (r: typeof REFILL_REF, o: typeof rRef) => ({refill: r.refillLog, cutoffsSent: r.cutoffs, status: o?.status,
  closeWon: closeWon(o?.status), close: o?.close, estimated: o?.liters, delivered: r.delivered, tankLeft: r.tankLeft});
check('C23 refill at the cutoff send instant T: no CLOSE, natural close (COMPLETED); 1 ms after T the CLOSE stays in flight (CANCELLED at T + 2 s); estimated = delivered',
  REFILL_REF.cutoffs.length === 1 && sendT === expectedSendT && REFILL_REF.cutoffs[0] === fill?.cutoffBefore
    && rRef?.status === 'CANCELLED' && rRef.close === isoAt(sendT + 2000) && rRef.liters === REFILL_REF.delivered && REFILL_REF.delivered === 79
    && REFILL_AT_T.refillLog?.at === isoAt(sendT) && REFILL_AT_T.refillLog.cutoffBefore === isoAt(sendT)
    && Date.parse(REFILL_AT_T.refillLog.cutoffAfter ?? '') > naturalClose && REFILL_AT_T.cutoffs.length === 0
    && rA?.status === 'COMPLETED' && rA.close === ref0?.close && rA.liters === REFILL_AT_T.delivered && REFILL_AT_T.delivered === 80
    && REFILL_AT_T.tankLeft === 79 + 20 - 80
    && REFILL_AFTER_T.refillLog?.at === isoAt(sendT + 1) && REFILL_AFTER_T.refillLog.cutoffBefore === null && REFILL_AFTER_T.refillLog.cutoffAfter === null
    && same(REFILL_AFTER_T.cutoffs, [isoAt(sendT)]) && rB?.status === 'CANCELLED' && rB.close === isoAt(sendT + 2000)
    && rB.liters === REFILL_AFTER_T.delivered && REFILL_AFTER_T.delivered === 79 && REFILL_AFTER_T.tankLeft === 79 + 20 - 79,
  {T: isoAt(sendT), reference: refillDetail(REFILL_REF, rRef), atT: refillDetail(REFILL_AT_T, rA), afterT: refillDetail(REFILL_AFTER_T, rB),
    naturalClose: ref0?.close});

// C24: a natural close and a cutoff close at the same instant. 80 L last exactly 600 s at 8 L/min, so the cutoff CLOSE
// of a manual 10-minute open is sent at open + 598 s and lands at open + 600 s, the natural close instant. Both closes
// are priority 1 (irrigation.ts:60 closure, :108 manual-close). The natural close was scheduled at the command (lower
// sequence) and runs first (clock.ts:55 sorts by time, priority, then sequence): the run ends COMPLETED. Closing
// invalidates the actuation generation (irrigation.ts:73), so the clock drops the cutoff's close as stale (clock.ts:62)
// without running its callback; had it run, it would have found no active command (irrigation.ts:66).
const TIE_LITERS = 80;
const TIE = run(3, {tankLiters: TIE_LITERS, manualOpen: {at: OPEN_AT, seconds: 600}, until: C20_UNTIL});
const tie0 = manualOf(TIE);
const tieSend = TIE.cutoffs.length === 1 ? Date.parse(TIE.cutoffs[0]!) : NaN;
const tieOpen = tie0?.open ? Date.parse(tie0.open) : NaN;
check('C24 natural close and cutoff CLOSE land at the same instant: the natural close runs first (COMPLETED)',
  tie0?.status === 'COMPLETED' && tieSend === tieOpen + 598_000 && tieSend + 2000 === naturalClose && tie0.close === ref0?.close
    && tie0.liters === TIE.delivered && TIE.delivered === TIE_LITERS && TIE.tankLeft === 0,
  {tankLiters: TIE_LITERS, commanded: tie0?.commanded, open: tie0?.open, cutoffSent: TIE.cutoffs[0] ?? null, cutoffLands: isoAt(tieSend + 2000),
    naturalClose: ref0?.close, closeWon: closeWon(tie0?.status), close: tie0?.close, estimated: tie0?.liters, delivered: TIE.delivered, tankLeft: TIE.tankLeft});

console.log(`${tally.fail === 0 ? 'PASS' : 'FAIL'} ${tally.pass}/${tally.pass + tally.fail} checks passed`);
