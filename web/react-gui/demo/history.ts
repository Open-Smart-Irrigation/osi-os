import type {Device, WaterDay} from '../src/types/farming';

export const DEMO_EPOCH = Date.parse('2026-09-29T09:00:00Z');
const QUARTER = 15 * 60 * 1000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const round = (value: number) => Number(value.toFixed(2));
const localDay = (time: number) => new Date(time + 3 * HOUR).toISOString().slice(0, 10);

type WaterEvent = {at: number; zone: 1 | 2 | 'both'; rain: number; liters: number};
function eventSeries(start: string, zone: WaterEvent['zone'], kind: 'rain' | 'liters', amounts: number[]): WaterEvent[] {
  return amounts.map((amount, index) => ({at: Date.parse(start) + (index + 1) * QUARTER,
    zone, rain: kind === 'rain' ? amount : 0, liters: kind === 'liters' ? amount : 0}));
}
// Each timestamp closes a sampled 15-minute interval. Both zones see the same rain.
const WATER_EVENTS: WaterEvent[] = [
  ...eventSeries('2026-07-04T15:30Z', 'both', 'rain', [1, 2, 3, 3, 2]),
  ...eventSeries('2026-07-10T17:00Z', 1, 'liters', [130, 200, 200, 120]),
  ...eventSeries('2026-07-10T17:00Z', 2, 'liters', [120, 180, 180, 120]),
  ...eventSeries('2026-07-17T15:30Z', 'both', 'rain', [2, 4, 5, 4, 3]),
  ...eventSeries('2026-07-25T17:00Z', 1, 'liters', [150, 225, 225, 150]),
  ...eventSeries('2026-07-25T17:00Z', 2, 'liters', [140, 210, 210, 140]),
  ...eventSeries('2026-08-03T15:30Z', 'both', 'rain', [1, 2, 3, 2, 1]),
  ...eventSeries('2026-08-12T17:00Z', 2, 'liters', [170, 255, 255, 170]),
  ...eventSeries('2026-08-19T15:30Z', 'both', 'rain', [2, 3, 4, 4, 3]),
  ...eventSeries('2026-08-28T17:00Z', 1, 'liters', [150, 225, 225, 150]),
  ...eventSeries('2026-09-06T15:30Z', 'both', 'rain', [1, 3, 4, 3, 1]),
  ...eventSeries('2026-09-14T17:00Z', 2, 'liters', [140, 210, 210, 140]),
  ...eventSeries('2026-09-20T15:30Z', 'both', 'rain', [1, 2, 3, 3, 1]),
  ...eventSeries('2026-09-23T15:30Z', 'both', 'rain', [0.4, 1.6, 3, 2, 2.4, 1.6, 2, 1]),
  ...eventSeries('2026-09-25T17:00Z', 1, 'liters', [120, 220, 220, 140]),
  ...eventSeries('2026-09-28T18:00Z', 2, 'liters', [120, 180, 200, 180, 120]),
  ...eventSeries('2026-09-29T02:00Z', 'both', 'rain', [0.4, 0.8, 1.4, 1.6, 1.2, 0.6]),
  ...eventSeries('2026-09-29T05:45Z', 2, 'liters', [40, 40]),
  ...eventSeries('2026-09-29T06:30Z', 1, 'liters', [60, 60]),
];
function waterTotal(zone: number, kind: 'rain' | 'liters', from: number, to: number): number {
  return round(WATER_EVENTS.filter(e => (e.zone === 'both' || e.zone === zone) && e.at > from && e.at <= to)
    .reduce((sum, e) => sum + e[kind], 0));
}
export function waterReading(zone: number, field: string, at: number): number | null {
  const match = /^(rain_mm|flow_liters)_(delta|today|per_10min|per_hour|per_min)$/.exec(field);
  if (!match) return null;
  const kind = match[1] === 'rain_mm' ? 'rain' : 'liters';
  const start = match[2] === 'today' ? Date.parse(`${localDay(at)}T00:00:00+03:00`) : at - QUARTER;
  const total = waterTotal(zone, kind, start, at);
  const scale = match[2] === 'per_10min' ? 10 / 15 : match[2] === 'per_hour' ? 4 : match[2] === 'per_min' ? 1 / 15 : 1;
  return round(total * scale);
}
export function waterDays(rainZone: number | null, flowZone: number | null): WaterDay[] {
  return Array.from({length: 7}, (_, index) => {
    const at = DEMO_EPOCH - (6 - index) * DAY;
    const date = localDay(at), end = Math.min(DEMO_EPOCH, Date.parse(`${date}T23:59:59.999+03:00`));
    const rainMm = rainZone === null ? null : waterReading(rainZone, 'rain_mm_today', end);
    const liters = flowZone === null ? null : waterReading(flowZone, 'flow_liters_today', end);
    const netMm = liters === null ? null : round(liters / 100 * 0.85);
    return {date, rainMm, irrigationLiters: liters, measuredIrrigationLiters: liters,
      irrigationNetMm: netMm, measuredIrrigationNetMm: netMm,
      totalWaterMm: rainMm === null || netMm === null ? null : round(rainMm + netMm)};
  });
}

type Anchor = readonly [string, number, number];
const TOMATO: Anchor[] = [
  ['2026-07-01T09:00Z',32,37], ['2026-07-04T15:30Z',45,44],
  ['2026-07-04T20:00Z',24,44], ['2026-07-05T06:00Z',22,34],
  ['2026-07-10T16:45Z',47,41], ['2026-07-10T20:00Z',26,41],
  ['2026-07-11T06:00Z',24,33], ['2026-07-17T15:30Z',44,40],
  ['2026-07-17T20:00Z',23,40], ['2026-07-18T09:00Z',21,31],
  ['2026-07-25T16:45Z',44,39], ['2026-07-25T20:00Z',25,39],
  ['2026-07-26T08:00Z',23,31], ['2026-08-03T15:30Z',42,38],
  ['2026-08-03T20:00Z',24,38], ['2026-08-04T06:00Z',22,30],
  ['2026-08-19T15:30Z',55,45], ['2026-08-19T20:00Z',20,45],
  ['2026-08-20T08:00Z',18,32], ['2026-08-28T16:45Z',44,38],
  ['2026-08-28T20:00Z',24,38], ['2026-08-29T08:00Z',22,30],
  ['2026-09-06T15:30Z',42,36], ['2026-09-06T20:00Z',22,36],
  ['2026-09-07T06:00Z',20,29], ['2026-09-20T15:30Z',55,43],
  ['2026-09-20T20:00Z',23,43], ['2026-09-21T06:00Z',21,32],
  ['2026-09-22T09:00Z',28,33], ['2026-09-23T15:30Z',39,40],
  ['2026-09-23T20:00Z',23,40], ['2026-09-24T06:00Z',21,31],
  ['2026-09-25T16:45Z',42,38], ['2026-09-25T20:00Z',27,38],
  ['2026-09-26T06:00Z',24,30], ['2026-09-27T18:00Z',43,38],
  ['2026-09-28T18:00Z',54,43], ['2026-09-29T01:45Z',60,46],
  ['2026-09-29T04:30Z',51,46], ['2026-09-29T09:00Z',56,46],
];
const BED: Anchor[] = [
  ['2026-07-01T09:00Z',28,34], ['2026-07-04T15:30Z',42,42],
  ['2026-07-04T20:00Z',20,42], ['2026-07-05T06:00Z',18,32],
  ['2026-07-10T16:45Z',45,40], ['2026-07-10T20:00Z',22,40],
  ['2026-07-11T06:00Z',20,31], ['2026-07-17T15:30Z',44,39],
  ['2026-07-17T20:00Z',21,39], ['2026-07-18T09:00Z',19,29],
  ['2026-07-25T16:45Z',46,38], ['2026-07-25T20:00Z',24,38],
  ['2026-07-26T08:00Z',22,30], ['2026-08-03T15:30Z',47,40],
  ['2026-08-03T20:00Z',23,40], ['2026-08-04T06:00Z',20,30],
  ['2026-08-12T16:45Z',48,42], ['2026-08-12T20:00Z',23,42],
  ['2026-08-13T06:00Z',20,31], ['2026-08-19T15:30Z',46,39],
  ['2026-08-19T20:00Z',20,39], ['2026-08-20T08:00Z',18,29],
  ['2026-08-28T16:45Z',55,43], ['2026-09-06T15:30Z',58,45],
  ['2026-09-06T20:00Z',22,45], ['2026-09-07T06:00Z',20,33],
  ['2026-09-14T16:45Z',44,38], ['2026-09-14T20:00Z',21,38],
  ['2026-09-15T06:00Z',19,29], ['2026-09-20T15:30Z',43,36],
  ['2026-09-20T20:00Z',23,36], ['2026-09-21T06:00Z',21,29],
  ['2026-09-22T09:00Z',29,36], ['2026-09-23T15:30Z',40,43],
  ['2026-09-23T20:00Z',24,43], ['2026-09-24T06:00Z',22,34],
  ['2026-09-25T16:45Z',39,39], ['2026-09-26T18:00Z',51,46],
  ['2026-09-28T17:45Z',60,51], ['2026-09-28T22:00Z',24,51],
  ['2026-09-29T01:45Z',20,49], ['2026-09-29T04:30Z',12,42],
  ['2026-09-29T09:00Z',12,35],
];
// Synthetic, reviewed narrative samples, not a calibrated infiltration model.
// This integral weights daytime drying more than night-time drying.
function dryingTime(at: number): number {
  const local = at / HOUR + 3, day = Math.floor(local / 24), hour = local - day * 24;
  return day * 14.25 + (hour < 7 ? hour * 0.25 : hour < 18 ? 1.75 + hour - 7 : 12.75 + (hour - 18) * 0.25);
}
function noise(index: number, seed: number): number {
  const hashed = Math.imul(index ^ seed, 1597334677) ^ Math.imul(index + seed, 3812015801);
  return ((hashed >>> 0) / 4294967295 - 0.5) * 0.4;
}
function soilReading(eui: string, channel: 1 | 2, at: number): number {
  const anchors = eui.endsWith('A1') ? TOMATO : BED;
  let right = anchors.findIndex(a => Date.parse(a[0]) >= at);
  if (right < 0) right = anchors.length - 1;
  const b = anchors[right], a = anchors[Math.max(0, right - 1)];
  const start = Date.parse(a[0]), end = Date.parse(b[0]);
  const progress = end === start ? 1 : Math.max(0, Math.min(1, (at - start) / (end - start)));
  const u = b[channel] > a[channel] && end !== start
    ? (dryingTime(at) - dryingTime(start)) / (dryingTime(end) - dryingTime(start)) : progress;
  const smooth = u * u * (3 - 2 * u);
  const hour = Math.floor(at / HOUR), fraction = at / HOUR - hour;
  const jitter = (noise(hour, channel) * (1 - fraction) + noise(hour + 1, channel) * fraction) * 4 * progress * (1 - progress);
  let value = a[channel] + (b[channel] - a[channel]) * smooth + jitter;
  if (!eui.endsWith('A1') && !eui.endsWith('A2')) value = channel === 1 ? 35 + (value - 12) * 0.65 : value - 3;
  return round(Math.max(0, value));
}
function environmentReading(field: string, at: number): number | undefined {
  const hour = ((at / HOUR + 3) % 24 + 24) % 24;
  const daylight = Math.max(0, Math.sin(Math.PI * (hour - 6) / 12));
  const warm = (1 + Math.cos((hour - 15) * Math.PI / 12)) / 2;
  const rain = Math.min(1, waterTotal(1, 'rain', at - 3 * HOUR, at) / 4);
  const dailyOffset = noise(Math.floor(at / DAY), 7) * 2;
  if (field === 'ambient_temperature') return round(21 + 9 * warm + dailyOffset - 2.2 * rain);
  if (field === 'relative_humidity') return round(Math.min(98, 91 - 36 * warm - dailyOffset * 2 + 9 * rain));
  if (field === 'light_lux') return Math.round(42000 * daylight * (1 - 0.7 * rain));
  return undefined;
}
export function sensorSnapshot(eui: string): Device['latest_data'] {
  return {swt_1: soilReading(eui, 1, DEMO_EPOCH), swt_2: soilReading(eui, 2, DEMO_EPOCH),
    ambient_temperature: environmentReading('ambient_temperature', DEMO_EPOCH),
    relative_humidity: environmentReading('relative_humidity', DEMO_EPOCH), light_lux: environmentReading('light_lux', DEMO_EPOCH), bat_pct: 92};
}
export function sensorHistory(device: Device, field: string, hours: number): {t: string; value: number}[] {
  const current = device.latest_data[field as keyof Device['latest_data']];
  if (typeof current !== 'number') return [];
  const count = Math.floor(Math.min(2160, Math.max(1, hours)) * 4);
  return Array.from({length: count + 1}, (_, index) => {
    const at = DEMO_EPOCH - (count - index) * QUARTER;
    const value = field === 'swt_1' || field === 'swt_2' ? soilReading(device.deveui, field === 'swt_1' ? 1 : 2, at)
      : device.type_id === 'DRAGINO_LSN50' ? waterReading(Number(device.deveui.slice(-1)), field, at) ?? current
      : environmentReading(field, at) ?? current;
    return {t: new Date(at).toISOString(), value};
  });
}
