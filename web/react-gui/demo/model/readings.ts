import type {Device} from '../../src/types/farming';
import {PUBLIC_EPOCH, iso} from '../fixtures';
import {convertWatermarkChannel} from './watermark';

export type ReadingValues = Record<string, unknown>;
export type ReadingSample = {deviceEui: string; at: number; values: ReadingValues; source: 'seed' | 'fictional-history' | 'synthetic' | 'observed-flow'};

const INTERVAL_MS = 30 * 60 * 1000;
const round = (n: number) => Number(n.toFixed(2));

function deviceValues(device: Device, at: number): ReadingValues {
  const config = device as Device & Record<string, unknown>;
  const eui = device.deveui;
  const phase = Math.floor((at - PUBLIC_EPOCH) / INTERVAL_MS);
  if (device.type_id === 'KIWI_SENSOR') {
    const seed = eui.endsWith('A1') ? [45, 50, 55] : eui.endsWith('A2') ? [10, 12, 14] : [35, 40, 45];
    const drying = Math.sin(phase / 19) * 2.5 + Math.cos(phase / 57) * 1.5;
    return {swt_1: round(Math.max(0, seed[0] + drying)), swt_2: round(Math.max(0, seed[1] + drying * 0.7)),
      swt_3: round(Math.max(0, seed[2] + drying * 0.5)), vwc: null,
      ...(config.temp_humidity_enabled === 1 ? {ambient_temperature: round(23 + Math.sin(phase / 48) * 5), relative_humidity: round(68 - Math.sin(phase / 48) * 16)} : {}),
      light_lux: Math.round(Math.max(0, 22000 * Math.sin(phase / 48))), rain_mm_delta: 0};
  }
  if (device.type_id === 'TEKTELIC_CLOVER') {
    const base = 31 + Math.sin(phase / 23) * 3;
    return {swt_1: round(base), swt_2: round(base + 6), ambient_temperature: round(24 + Math.sin(phase / 48) * 4),
      relative_humidity: round(68 - Math.sin(phase / 48) * 12), light_lux: Math.round(18000 * Math.max(0, Math.sin(phase / 48)))};
  }
  if (device.type_id === 'DRAGINO_LSN50') {
    const modeLabel = String(config.lsn50_mode ?? device.latest_data.lsn50_mode_label ?? 'MOD9');
    const mode = Number(modeLabel.replace('MOD', '')) || Number(device.device_mode) || 9;
    const farmDay = new Date(at + 3 * 3600000).toISOString().slice(0, 10);
    const dayIndex = Math.floor(Date.parse(`${farmDay}T00:00:00Z`) / 86400000);
    const missingRainDay = ((dayIndex % 7) + 7) % 7 === 6;
    const sampleOfDay = ((phase % 48) + 48) % 48 === 12;
    const wetDay = ((dayIndex % 5) + 5) % 5 === 0;
    const rainDelta = sampleOfDay && wetDay ? 0.4 : 0;
    const rain = mode === 9 && device.rain_gauge_enabled === 1 && !missingRainDay ? {rain_mm_delta: rainDelta,
      rain_mm_per_10min: Number((rainDelta / 3).toFixed(2)), rain_mm_today: wetDay && ((phase % 48) + 48) % 48 >= 12 ? 0.4 : 0} : {};
    const flow = mode === 9 && device.flow_meter_enabled === 1 ? {flow_liters_delta: 0, flow_liters_today: 0, flow_liters_per_10min: 0} : {};
    const ratio = 0.46 + Math.sin(phase / 48) * 0.002;
    const dendroRaw = 12 + Math.sin(phase / 48) * 0.08;
    const calibrated = device.dendro_enabled === 1 && (mode === 1 || mode === 3);
    const retracted = Number(device.dendro_ratio_at_retracted), extended = Number(device.dendro_ratio_at_extended);
    const stroke = Number(device.dendro_stroke_mm);
    const dendroPosition = Number.isFinite(retracted) && Number.isFinite(extended) && extended !== retracted && Number.isFinite(stroke)
      ? Math.max(0, Math.min(stroke, stroke * (ratio - retracted) / (extended - retracted))) : dendroRaw;
    const baseline = Number(config.dendro_baseline_position_mm);
    const stemChange = Number.isFinite(baseline) ? round((dendroPosition - baseline) * 1000) : round(Math.sin(phase / 48) * 80);
    const rawWatermark = config.watermark_fixture === true ? {watermark_fwd_1: 512 + Math.round(Math.sin(phase / 31) * 3), watermark_rev_1: 3584 + Math.round(Math.sin(phase / 37) * 3),
      watermark_fwd_2: 520 + Math.round(Math.sin(phase / 33) * 3), watermark_rev_2: 3578 + Math.round(Math.sin(phase / 39) * 3),
      watermark_temp_c: round(22 + Math.sin(phase / 48) * 4)} : {};
    return {...rain, ...flow, ...rawWatermark, lsn50_mode_label: modeLabel, lsn50_mode_code: mode,
      counter_interval_seconds: Number(config.counter_interval_seconds ?? 1800), bat_pct: Number(device.latest_data.bat_pct ?? 90),
      ...(config.chameleon_array_id ? {chameleon_array_id: String(config.chameleon_array_id)} : {}),
      ...(mode === 3 && device.chameleon_enabled === 1 ? {adc_ch0v: round(1.8 + Math.sin(phase / 37) * 0.05), adc_ch1v: round(1.7 + Math.sin(phase / 41) * 0.05),
        swt_1: round(35 + Math.sin(phase / 39) * 6), swt_2: round(42 + Math.sin(phase / 43) * 7), swt_3: round(48 + Math.sin(phase / 47) * 8)} : {}),
      ...(mode === 1 && device.temp_enabled === 1 ? {ext_temperature_c: round(22 + Math.sin(phase / 48) * 4)} : {}),
      ...(calibrated ? {dendro_position_raw_mm: dendroRaw, dendro_position_mm: dendroPosition, dendro_valid: 1, dendro_delta_mm: null,
        dendro_stem_change_um: stemChange, dendro_ratio: ratio,
        dendro_mode_used: device.dendro_force_legacy === 1 ? 'legacy_single_adc' : 'ratio_mod3', dendro_saturated: 0, dendro_saturation_side: null} : {})};
  }
  if (device.type_id === 'STREGA_VALVE') return {valve_state: device.current_state === 'OPEN' ? 1 : 0};
  if (device.type_id === 'SENSECAP_S2120') return {ambient_temperature: round(24 + Math.sin(phase / 48) * 4),
    relative_humidity: round(67 - Math.sin(phase / 48) * 12), wind_speed_mps: round(1.1 + Math.abs(Math.sin(phase / 29)) * 2),
    wind_gust_mps: round(2 + Math.abs(Math.sin(phase / 31)) * 3), wind_direction_deg: ((phase * 13) % 360 + 360) % 360,
    rain_mm_delta: Math.floor(phase / 48) % 19 === 0 ? 0.2 : 0, barometric_pressure_hpa: 1012,
    light_lux: Math.round(Math.max(0, 20000 * Math.sin(phase / 48))), uv_index: Math.max(0, round(3 + Math.sin(phase / 48)))};
  if (device.type_id === 'AQUASCOPE_LORAIN') {
    const day = Math.floor(phase / 48), rainDelta = day % 16 === 0 && ((phase % 48) + 48) % 48 === 12 ? 0.4 : 0;
    return {rain_mm_delta: rainDelta, rain_mm_per_10min: Number((rainDelta / 3).toFixed(2)),
      rain_mm_today: day % 16 === 0 && ((phase % 48) + 48) % 48 >= 12 ? 0.4 : 0,
      rain_gauge_cumulative_mm: Math.floor(day / 16) * 0.4 +
        (day % 16 === 0 && ((phase % 48) + 48) % 48 >= 12 ? 0.4 : 0)};
  }
  if (device.type_id === 'DRAGINO_SDI12') {
    const profile = String(device.sdi12_probe_profile ?? 'GENERIC_VWC');
    const layout = device.sdi12_channel_layout_json?.sensors ?? [];
    const channels = profile === 'SENTEK_ENVIROSCAN' && layout.length
      ? layout.flatMap(sensor => [`vwc_${sensor.channel}`, ...(sensor.type === 'TRISCAN' ? [`soil_vic_${sensor.channel}`] : [])])
      : profile === 'GENERIC_VWC' || profile.startsWith('DELTAT_PR2')
      ? Array.from({length: Math.max(1, Math.min(8, Number(device.sdi12_value_count) || 2))}, (_, index) => `vwc_${index + 1}`)
      : profile === 'HYDRASCOUT' ? ['vwc_1','soil_temp_1','soil_ec_1','vwc_2','soil_temp_2','soil_ec_2']
      : profile === 'TENSIOMARK' ? ['swt_1','soil_temp_1'] : ['vwc_1','soil_temp_1'];
    return Object.fromEntries(channels.map((field, index) => [field, field.startsWith('vwc_') ? round(25 + index * 2 + Math.sin(phase / (40 + index)) * 4)
      : field.startsWith('soil_vic_') ? round(0.2 + index * 0.03 + Math.sin(phase / 60) * 0.02)
      : field.startsWith('swt_') ? round(30 + Math.sin(phase / 35) * 5)
      : field.startsWith('soil_ec_') ? round(0.8 + index * 0.1 + Math.sin(phase / 60) * 0.05)
      : round(21 + index + Math.sin(phase / 48) * 3)]));
  }
  if (device.type_id === 'MILESIGHT_UC512') return {bat_pct: 90, ext_temperature_c: round(23 + Math.sin(phase / 48) * 4)};
  if (device.type_id === 'RAK10701_FIELD_TESTER') return {bat_pct: 90, rssi: -94 + Math.round(Math.sin(phase / 11) * 4), snr: 7.5};
  return {...device.latest_data};
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dendroCalibrationSignature(device: Device): string {
  const config = device as Device & Record<string, unknown>;
  const strokeMm = toNullableNumber(config.dendro_stroke_mm);
  let ratioAtRetracted = toNullableNumber(config.dendro_ratio_at_retracted);
  let ratioAtExtended = toNullableNumber(config.dendro_ratio_at_extended);
  if (ratioAtRetracted === null || ratioAtExtended === null) {
    const ratioZero = toNullableNumber(config.dendro_ratio_zero);
    const ratioSpan = toNullableNumber(config.dendro_ratio_span);
    const inverted = toNullableNumber(config.dendro_invert_direction) === 1;
    if (ratioAtRetracted === null && ratioZero !== null && ratioSpan !== null) {
      ratioAtRetracted = inverted ? ratioSpan : ratioZero;
    }
    if (ratioAtExtended === null && ratioZero !== null && ratioSpan !== null) {
      ratioAtExtended = inverted ? ratioZero : ratioSpan;
    }
  }
  return [strokeMm, ratioAtRetracted, ratioAtExtended].map(value => value === null ? 'null' : String(value)).join('|');
}

export function applyDendroBaseline(device: Device, values: ReadingValues, at: number): ReadingValues {
  if (device.type_id !== 'DRAGINO_LSN50' || device.dendro_enabled !== 1) return values;

  const rawPosition = toNullableNumber(values.dendro_position_raw_mm);
  const modeUsed = typeof values.dendro_mode_used === 'string' ? values.dendro_mode_used : '';
  if (rawPosition === null || !modeUsed) return {...values, dendro_stem_change_um: null};

  const config = device as Device & Record<string, unknown>;
  const baselinePosition = toNullableNumber(config.dendro_baseline_position_mm);
  const calibrationSignature = dendroCalibrationSignature(device);
  const baselineIsStale = config.dendro_baseline_pending === 1
    || baselinePosition === null
    || config.dendro_baseline_mode_used !== modeUsed
    || config.dendro_baseline_calibration_signature !== calibrationSignature;

  if (baselineIsStale) {
    Object.assign(config, {
      dendro_baseline_position_mm: rawPosition,
      dendro_baseline_mode_used: modeUsed,
      dendro_baseline_calibration_signature: calibrationSignature,
      dendro_baseline_pending: 0,
      dendro_baseline_at: iso(at),
    });
    return {...values, dendro_stem_change_um: 0};
  }

  return {...values, dendro_stem_change_um: Math.round((rawPosition - baselinePosition) * 1000)};
}

export class ReadingLedger {
  private samples = new Map<string, ReadingSample[]>();
  private sampleIndexes = new Map<string, Map<number, number>>();
  private soilResponse = new Map<string, number>();
  private watermarkCalibration = new Map<string, Record<string, number>>();
  constructor(devices: Device[], public readonly enabled: boolean) {
    if (enabled) this.seed(devices);
  }

  private seed(devices: Device[]): void {
    const first = PUBLIC_EPOCH - (90 * 48) * INTERVAL_MS;
    for (const device of devices) {
      for (let index = 0; index <= 90 * 48; index++) {
        const at = first + index * INTERVAL_MS;
        let values = this.convertWatermark(device.deveui, deviceValues(device, at), at);
        if (at === PUBLIC_EPOCH) {
          values = {...device.latest_data, ...values};
          if (device.deveui.endsWith('A1')) Object.assign(values, {swt_1: 45, swt_2: 50, swt_3: 55});
          if (device.deveui.endsWith('A2')) Object.assign(values, {swt_1: 10, swt_2: 12, swt_3: 14});
        }
        this.append(device.deveui, at, values, 'seed');
      }
    }
  }

  seedNewDevice(device: Device, createdAt: number): void {
    const start = createdAt - 90 * 24 * 60 * 60 * 1000;
    for (let at = start; at < createdAt; at += INTERVAL_MS) {
      this.append(device.deveui, at, this.convertWatermark(device.deveui, deviceValues(device, at), at), 'fictional-history');
    }
    this.append(device.deveui, createdAt, {...device.latest_data}, 'synthetic');
  }

  append(deviceEui: string, at: number, values: ReadingValues, source: ReadingSample['source'] = 'synthetic'): void {
    const sample = {deviceEui, at, values: {...values}, source};
    const deviceSamples = this.samples.get(deviceEui) ?? [];
    const indexes = this.sampleIndexes.get(deviceEui) ?? new Map<number, number>();
    const existing = indexes.get(at);
    if (existing !== undefined) {
      const previous = deviceSamples[existing];
      const mergedValues = {...previous.values, ...sample.values};
      if (previous.source === 'observed-flow' && source !== 'observed-flow') {
        for (const field of ['flow_liters_delta', 'flow_liters_today', 'flow_liters_per_10min', 'counter_interval_seconds']) {
          if (typeof previous.values[field] === 'number') mergedValues[field] = previous.values[field];
        }
      }
      if (previous.source === 'observed-flow' && source === 'observed-flow' &&
        typeof previous.values.flow_liters_delta === 'number' && typeof sample.values.flow_liters_delta === 'number') {
        mergedValues.flow_liters_delta = round(previous.values.flow_liters_delta + sample.values.flow_liters_delta);
      }
      deviceSamples[existing] = {deviceEui, at, values: mergedValues,
        source: previous.source === 'observed-flow' || source === 'observed-flow' ? 'observed-flow' : source};
    }
    else {
      indexes.set(at, deviceSamples.length);
      deviceSamples.push(sample);
    }
    this.samples.set(deviceEui, deviceSamples);
    this.sampleIndexes.set(deviceEui, indexes);
  }

  forDevice(deviceEui: string): ReadingSample[] {
    return structuredClone(this.samples.get(deviceEui) ?? []);
  }

  latest(deviceEui: string, field: string): number | null {
    const latest = this.latestSample(deviceEui);
    const value = latest?.values[field];
    return typeof value === 'number' ? value : null;
  }

  aggregate(deviceEui: string, field: string, from: number, to: number): number | null {
    const matching = (this.samples.get(deviceEui) ?? []).filter(sample => sample.at >= from && sample.at <= to);
    if (!matching.length) return null;
    const measured = matching.map(sample => sample.values[field]).filter((value): value is number => typeof value === 'number');
    return measured.length ? round(measured.reduce((sum, value) => sum + value, 0)) : null;
  }

  latestSample(deviceEui: string): ReadingSample | undefined {
    const samples = this.samples.get(deviceEui);
    return samples?.[samples.length - 1];
  }

  sampleValues(device: Device, at: number): ReadingValues {
    const values = deviceValues(device, at), response = this.soilResponse.get(device.deveui) ?? 0;
    for (const field of ['swt_1', 'swt_2', 'swt_3']) {
      if (typeof values[field] === 'number') values[field] = round(Math.max(0, values[field]! - response));
    }
    return this.convertWatermark(device.deveui, values, at);
  }

  private convertWatermark(eui: string, values: ReadingValues, at?: number): ReadingValues {
    if (!('watermark_fwd_1' in values)) return values;
    const calibration = this.watermarkCalibration.get(eui);
    const channels = [];
    for (const channel of [1, 2]) {
      const result = calibration ? convertWatermarkChannel(Number(values[`watermark_fwd_${channel}`]), Number(values[`watermark_rev_${channel}`]),
        Number(values.watermark_temp_c), calibration, channel) : {r_fwd: null, r_rev: null, r_solved: null, r_upper_bound: null,
          kpa: null, kpa_upper_bound: null, offset_mv: null, status: 'calibration_required'};
      values[`watermark_ch${channel}_kpa`] = result.kpa;
      values[`watermark_ch${channel}_status`] = result.status;
      values[`watermark_ch${channel}_r_solved`] = result.r_solved;
      values[`watermark_ch${channel}_r_fwd`] = result.r_fwd;
      values[`watermark_ch${channel}_r_rev`] = result.r_rev;
      channels.push({status: result.status, kpa: result.kpa, kpa_upper_bound: result.kpa_upper_bound,
        r_solved: result.r_solved, r_upper_bound: result.r_upper_bound, offset_mv: result.offset_mv});
    }
    values.watermark = {recorded_at: iso(at ?? PUBLIC_EPOCH), supply_mv: 3300, soil_temp_c: values.watermark_temp_c,
      soil_temp_source: 2, die_temp_c: null, channels};
    return values;
  }

  setWatermarkCalibration(eui: string, calibration: Record<string, number> | null, backfill: boolean): number {
    if (!calibration) this.watermarkCalibration.delete(eui); else this.watermarkCalibration.set(eui, structuredClone(calibration));
    let changed = 0;
    if (backfill && calibration) for (const sample of this.samples.get(eui) ?? []) {
      if (sample.values.watermark_ch1_status !== 'calibration_required') continue;
      Object.assign(sample.values, this.convertWatermark(eui, {...sample.values}, sample.at));
      changed++;
    }
    return changed;
  }

  applySoilResponse(deviceEui: string, at: number, deliveredLiters: number, device: Device): void {
    if (deliveredLiters <= 0) return;
    const response = Math.min(18, (this.soilResponse.get(deviceEui) ?? 0) + deliveredLiters / 100 * 0.85 * 1.5);
    this.soilResponse.set(deviceEui, response);
    const values = this.sampleValues(device, at);
    this.append(deviceEui, at, values, 'synthetic');
    Object.assign(device.latest_data, values, {sampled_at: iso(at)});
  }

  between(deviceEui: string, from: number, to: number): ReadingSample[] {
    return (this.samples.get(deviceEui) ?? []).filter(sample => sample.at >= from && sample.at <= to).map(sample => structuredClone(sample));
  }

  clear(): void { this.samples.clear(); this.sampleIndexes.clear(); }
  clone(): ReadingLedger {
    const copy = new ReadingLedger([], false);
    for (const [eui, samples] of this.samples) for (const sample of samples) copy.append(eui, sample.at, sample.values, sample.source);
    copy.soilResponse = new Map(this.soilResponse);
    copy.watermarkCalibration = new Map(this.watermarkCalibration);
    return copy;
  }
}

export function sampleIntervalMs(): number { return INTERVAL_MS; }
export function sampleTime(at: number): string { return iso(at); }
