import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fao56Et0} from '@osi-edge/osi-agronomy-daily/et0.js';
import {resolveKc} from '@osi-edge/osi-crop-kc/index.js';
import type {Command} from '../../src/core/commands';
import {FarmOsiAdapter} from '../../src/core/osi/adapter';
import type {PhoneTraffic, PhoneWrite} from '../../src/core/osi/bridge';
import {METER_EUI, PROBE_EUI, VALVE_PATH, ZONE_PATH} from '../../src/core/osi/farm-builder';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS, FARM_SITE, HOUR_MS, MINUTE_MS, dayOfYear, localDate, localDayStart, localDateStart} from '../../src/core/time';
import type {Scenario, Tier} from '../../src/core/types';
import {Weather, type WeatherDay, type WeatherSource} from '../../src/core/weather';

export const START = TUTORIAL_SCENARIO.start;
export const SUMMARY = ZONE_PATH + '/environment-summary';
export const atHour = (day: number, hour: number) => localDayStart(START) + (day - 1) * DAY_MS + hour * HOUR_MS;
export const iso = (at: number) => new Date(at).toISOString();

export function buildAdapter(tier: Tier, options: {scenario?: Scenario; tank?: number; weather?: WeatherSource;
  sensorNoise?: boolean; open?: boolean} = {}) {
  const scenario = options.scenario ?? TUTORIAL_SCENARIO;
  const header = defaultHeader('integration', scenario, tier);
  const log: Array<Extract<Command, {kind: 'phoneRequest'}>> = [];
  const traffic: PhoneTraffic[] = [];
  const queued: (() => void)[] = [];
  let dispatchQueued = () => { while (queued.length) queued.shift()!(); };
  let dispatchPhone = (cmd: PhoneWrite) => {
    const command = {...cmd, simNow: adapter.now, seq: log.length + 1};
    const response = adapter.executePhoneWrite(command);
    log.push(command);
    adapter.drainNow();
    return response;
  };
  const adapter: FarmOsiAdapter = new FarmOsiAdapter({
    dispatcher: {
      dispatchQueued: () => dispatchQueued(),
      dispatchPhone: cmd => dispatchPhone(cmd),
    },
    sensorNoise: options.sensorNoise ?? false, weather: options.weather,
    logPhoneTraffic: event => traffic.push(event),
  });
  adapter.build(header, options.tank === undefined ? scenario : {
    ...scenario, initial: {...scenario.initial, tankLiters: options.tank},
  });
  adapter.setPhoneOpen(options.open ?? true);
  return {adapter, header, log, traffic, queued, setDispatcher: (drain: typeof dispatchQueued, fn: typeof dispatchPhone) => {
    dispatchQueued = drain;
    dispatchPhone = fn;
  }};
}

export function fao56(day: WeatherDay): number {
  const et0 = fao56Et0({...day, ...FARM_SITE, windHeightM: 2, dayOfYear: dayOfYear(day.startsAt)});
  assert.notEqual(et0, null);
  return et0!;
}

// The CommonJS resolver's null defaults infer null-only dates in TypeScript.
const resolveEdgeKc = resolveKc as unknown as (input: {
  cropType: string; phenologicalStage: string; stageStartedOn: string; date: string;
}) => {kc: number};
export const edgeTomatoKc = (date: string) => resolveEdgeKc({
  cropType: 'tomato', phenologicalStage: 'mid_season', stageStartedOn: '2027-01-06', date,
}).kc;

export function fixtureWeather(options: {
  actualRain?: (day: WeatherDay) => readonly number[];
  forecastRain?: (day: WeatherDay, now: number) => readonly number[];
  leadZeroTemperatureDelta?: number;
  et0?: number;
} = {}): WeatherSource {
  const weather = new Weather(9);
  const dry = Array<number>(24).fill(0);
  const withRain = (base: WeatherDay, hourlyRainMm: readonly number[]): WeatherDay => {
    const rainMm = hourlyRainMm.reduce((sum, value) => sum + value, 0);
    const start = hourlyRainMm.findIndex(value => value > 0);
    const end = hourlyRainMm.map(value => value > 0).lastIndexOf(true) + 1;
    return {...base, rainMm, hourlyRainMm, wet: start >= 0, burst: start < 0 ? null : {
      startsAt: base.startsAt + start * HOUR_MS, endsAt: base.startsAt + end * HOUR_MS,
    }, et0Mm: options.et0 ?? base.et0Mm};
  };
  const actual = (at: number) => {
    const base = weather.actual(at);
    return withRain(base, options.actualRain?.(base) ?? dry);
  };
  return {
    actual,
    asOf(date, now) {
      if (date < localDate(now)) return actual(localDateStart(date));
      const base = weather.asOf(date, now);
      if (!base) return null;
      const day = withRain(base, options.forecastRain?.(base, now) ?? dry);
      if (date !== localDate(now) || !options.leadZeroTemperatureDelta) return day;
      const leadZero = {...day, tMaxC: day.tMaxC + options.leadZeroTemperatureDelta};
      return {...leadZero, et0Mm: options.et0 ?? fao56(leadZero)};
    },
  };
}

export function write(adapter: FarmOsiAdapter, method: string, path: string, body?: unknown): unknown {
  const response = adapter.request(method, path, body);
  assert.ok(response.status < 400, JSON.stringify(response));
  return response.data;
}

export function openFor(adapter: FarmOsiAdapter, at: number, minutes: number): void {
  adapter.advance(at);
  write(adapter, 'POST', VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: minutes * 60});
}

export function manualTap(adapter: FarmOsiAdapter, at: number, minutes: number): number {
  adapter.advance(at);
  assert.ok(adapter.world.setManualTap(at, true));
  adapter.drainNow();
  const end = at + minutes * MINUTE_MS;
  adapter.advance(end);
  assert.ok(adapter.world.setManualTap(end, false));
  adapter.drainNow();
  return adapter.world.manualTapLitersBetween(at, end);
}

type WaterDay = {
  date: string; et0Mm: number | null; kc: number | null; demandMm: number | null;
  rainMm: number | null; irrigationLiters: number | null;
};
type Summary = {
  water: {todayDate: string; action: {code: string; source: string; reasonCode: string}; daily: WaterDay[];
    balanceTodayMm: number | null; next24hRainMm: number | null; waterNeededTodayMm: number | null};
  forecast: {rainFocus: {hourly: {rainMm: number}[]}};
};
export function environment(adapter: FarmOsiAdapter): Summary {
  return write(adapter, 'GET', SUMMARY) as Summary;
}

export function meter(adapter: FarmOsiAdapter) {
  const devices = write(adapter, 'GET', '/api/devices') as ReturnType<FarmOsiAdapter['simulatorSnapshot']>['devices'];
  const device = devices.find(d => d.deveui === METER_EUI);
  assert.ok(device);
  const data = device.latest_data;
  assert.ok('sampled_at' in data && typeof data.sampled_at === 'string');
  return data;
}

export function probeAt(adapter: FarmOsiAdapter, at: number): number {
  const records = adapter.simulatorSnapshot().readings.find(([eui]) => eui === PROBE_EUI)?.[1];
  const value = records?.find(row => row.at === at)?.values.swt_1;
  assert.equal(typeof value, 'number');
  return value as number;
}

export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64');
}
