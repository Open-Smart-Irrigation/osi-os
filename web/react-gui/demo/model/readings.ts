import type {Device} from '../../src/types/farming';
import {PUBLIC_EPOCH, iso} from '../fixtures';
import {atmosphereAt, rainfallMmBetween, rainCounterAt, quantizeLoRainTips, soilTensionAt, type WaterInput} from './forcing';
import {convertWatermarkChannel} from './watermark';
import {localDateKey, localMidnight} from './aggregation';

export type ReadingValues = Record<string, unknown>;
export type ReadingSample = {deviceEui: string; at: number; values: ReadingValues; source: 'seed' | 'fictional-history' | 'synthetic' | 'observed-flow'};
export type RainProjection = {timezone: string; timezoneBasis: string};

const INTERVAL_MS = 30 * 60 * 1000;
const round = (n: number) => Number(n.toFixed(2));
const nativeRound = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals;
const DAY_MS = 24 * 60 * 60 * 1000;
const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000;
const HISTORY_ORIGIN = PUBLIC_EPOCH - 90 * DAY_MS;
function missingRainCohortDay(at: number): boolean {
  const dayIndex = Math.floor(Date.parse(`${localDateKey(at, 'Africa/Kampala')}T00:00:00.000Z`) / DAY_MS);
  return ((dayIndex % 7) + 7) % 7 === 6;
}

function localDayStart(at: number): number { return Math.floor((at + KAMPALA_OFFSET_MS) / DAY_MS) * DAY_MS - KAMPALA_OFFSET_MS; }
function localDayString(at: number): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(at));
}

function intervalMinutes(device: Device): number {
  const configured = Number((device as Device & Record<string, unknown>).uplink_interval_minutes);
  return Number.isInteger(configured) && configured > 0 ? configured : INTERVAL_MS / 60000;
}

function openMinutesBetween(fromMs: number, toMs: number, openStartMinute: number, openEndMinute: number): number {
  if (toMs <= fromMs) return 0;
  let minutes = 0;
  const firstDay = localDayStart(fromMs);
  const lastDay = localDayStart(toMs);
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const windowStart = day + openStartMinute * 60000;
    const windowEnd = day + openEndMinute * 60000;
    minutes += Math.max(0, Math.min(toMs, windowEnd) - Math.max(fromMs, windowStart)) / 60000;
  }
  return minutes;
}

function rainBaseline(device: Device): number {
  const configured = Number((device as Device & Record<string, unknown>).public_rain_baseline_at_ms);
  return Number.isFinite(configured) ? configured : HISTORY_ORIGIN;
}

export function deviceValues(device: Device, at: number, waterInputs: readonly WaterInput[] = []): ReadingValues {
  const config = device as Device & Record<string, unknown>;
  const eui = device.deveui;
  const phase = Math.floor((at - PUBLIC_EPOCH) / INTERVAL_MS);
  const weather = atmosphereAt(at);
  const intervalMs = intervalMinutes(device) * 60000;
  const intervalRain = rainfallMmBetween(at - intervalMs, at);
  const dayStart = localDayStart(at);
  const baseAt = Number(config.public_soil_baseline_at_ms ?? PUBLIC_EPOCH);
  const zoneId = String(device.irrigation_zone_id ?? `device:${eui}`);
  const installationId = `zone:${zoneId}`;
  const soilValue = (field: string, fallback: number, depthClass: 'shallow' | 'deep') => {
    const baseline = Number(config[`public_soil_baseline_${field}`] ?? fallback);
    if (at <= PUBLIC_EPOCH) return round(Math.max(0, baseline + Math.sin(phase / 19) * 1.2 + Math.cos(phase / 57) * 0.5));
    return soilTensionAt({zoneId, installationId, depthClass, baselineAtMs: baseAt, baselineKpa: baseline}, at, waterInputs);
  };
  if (device.type_id === 'KIWI_SENSOR') {
    const baseline = eui === '00000000000000A1' ? [45, 50, 55] : eui === '00000000000000A2' ? [10, 12, 14] : [35, 40];
    const dry = (index: number) => soilValue(`swt_${index + 1}`, baseline[index]!, index === 0 ? 'shallow' : 'deep');
    const tempEnabled = config.temp_humidity_enabled === 1;
    return {swt_1: dry(0), swt_2: dry(1), ...(baseline.length === 3 ? {swt_3: dry(2)} : {}),
      ...(tempEnabled ? {ambient_temperature: round(weather.airTemperatureC), relative_humidity: round(weather.relativeHumidityPct)} : {}),
      light_lux: weather.lightLux, ...('bat_pct' in device.latest_data ? {bat_pct: device.latest_data.bat_pct} : {}),
      ...('bat_v' in device.latest_data ? {bat_v: device.latest_data.bat_v} : {})};
  }
  if (device.type_id === 'TEKTELIC_CLOVER') {
    return {swt_1: null, swt_2: null, swt_3: null, swt_wm1: null, swt_wm2: null,
      ambient_temperature: round(weather.airTemperatureC), relative_humidity: round(weather.relativeHumidityPct), light_lux: weather.lightLux,
      ...(typeof device.latest_data.bat_v === 'number' ? {bat_v: device.latest_data.bat_v} : {}),
      ...(typeof device.latest_data.bat_pct === 'number' ? {bat_pct: device.latest_data.bat_pct} : {})};
  }
  if (device.type_id === 'DRAGINO_LSN50') {
    const modeLabel = String(config.lsn50_mode ?? device.latest_data.lsn50_mode_label ?? 'MOD9');
    const mode = Number(modeLabel.replace('MOD', '')) || Number(device.device_mode) || 9;
    const rain = mode === 9 && device.rain_gauge_enabled === 1 ? {rain_mm_delta: round(intervalRain),
      rain_mm_per_10min: round(intervalRain * 10 / intervalMinutes(device)), rain_mm_today: round(rainfallMmBetween(dayStart, at)),
      rain_day: localDayString(at), rain_day_timezone: 'Africa/Kampala', rain_day_timezone_basis: 'zone',
      rain_delta_status: 'ok', counter_interval_seconds: intervalMinutes(device) * 60} : {};
    const flow = mode === 9 && device.flow_meter_enabled === 1 ? {flow_liters_delta: 0, flow_liters_today: 0, flow_liters_per_10min: 0,
      counter_interval_seconds: intervalMinutes(device) * 60} : {};
    const localHour = ((at + KAMPALA_OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS / 3600000;
    const ratio = Number((0.46 + Math.sin(2 * Math.PI * (localHour - 15) / 24) * 0.002).toFixed(4));
    const calibrated = device.dendro_enabled === 1 && (mode === 1 || mode === 3);
    const ratioMode = calibrated && mode === 3 && device.dendro_force_legacy !== 1;
    const adc0 = mode === 3 ? Number((0.92 + Math.sin(2 * Math.PI * (localHour - 15) / 24) * 0.01).toFixed(4)) : 0.92;
    const adc1 = mode === 3 ? Number((adc0 / ratio).toFixed(4)) : null;
    const optionalFinite = (value: unknown): number | null => value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const retracted = optionalFinite(device.dendro_ratio_at_retracted), extended = optionalFinite(device.dendro_ratio_at_extended);
    const stroke = Number(device.dendro_stroke_mm);
    const dendroRatio = ratioMode && adc1 !== null && adc1 > 0.05 ? nativeRound(adc0 / adc1, 6) : null;
    const legacyValid = adc0 >= 0 && adc0 <= 2.6;
    const ratioValid = dendroRatio !== null;
    const dendroRaw = ratioMode
      ? ratioValid && Number.isFinite(stroke) && stroke > 0 && retracted !== null && extended !== null && extended !== retracted
        ? nativeRound(stroke * (dendroRatio - retracted) / (extended - retracted), 3) : null
      : legacyValid ? nativeRound(adc0 * 10, 3) : null;
    const dendroPosition = ratioMode
      ? dendroRaw === null || !Number.isFinite(stroke) || stroke <= 0 ? null : nativeRound(Math.max(0, Math.min(stroke, dendroRaw)), 3)
      : dendroRaw;
    const saturated = ratioMode && dendroRaw !== null && Number.isFinite(stroke) && stroke > 0 && (dendroRaw < 0 || dendroRaw > stroke);
    const saturationSide = saturated ? dendroRaw! < 0 ? 'low' : 'high' : null;
    const baseline = Number(config.dendro_baseline_position_mm);
    const stemChange = dendroPosition !== null && Number.isFinite(baseline) ? round((dendroPosition - baseline) * 1000)
      : dendroRaw === null ? null : round((dendroRaw - 12) * 1000);
    const rawWatermark = config.watermark_fixture === true ? {watermark_fwd_1: 512 + Math.round(Math.sin(phase / 31) * 3), watermark_rev_1: 3584 + Math.round(Math.sin(phase / 37) * 3),
      watermark_fwd_2: 520 + Math.round(Math.sin(phase / 33) * 3), watermark_rev_2: 3578 + Math.round(Math.sin(phase / 39) * 3),
      watermark_temp_c: round(22 + Math.sin(phase / 48) * 4)} : {};
    const chameleon = mode === 3 && device.chameleon_enabled === 1;
    const adcChannels = device.dendro_enabled === 1 || chameleon ? {adc_ch0v: Number(adc0.toFixed(4)), ...(mode === 3 ? {adc_ch1v: Number((adc1 ?? 0).toFixed(4))} : {})} : {};
    const chameleonKnown = config.chameleon_calibration_usable === true;
    const calibrationStatus = chameleonKnown ? String(config.chameleon_calibration_status ?? 'calibrated') : 'unknown';
    const rainCounter = rainCounterAt(at, rainBaseline(device), 0);
    const mode9FlowEligible = mode === 9 && device.flow_meter_enabled === 1;
    return {...rain, ...flow, ...rawWatermark, lsn50_mode_label: modeLabel, lsn50_mode_code: mode,
      bat_v: typeof device.latest_data.bat_v === 'number' ? device.latest_data.bat_v : 3.55,
      ...(mode === 9 && device.rain_gauge_enabled === 1 ? {rain_gauge_cumulative_mm: round(rainCounter)} : {}),
      ...adcChannels,
      ...(chameleon ? {chameleon_array_id: String(config.chameleon_array_id ?? ''), calibration_status: calibrationStatus,
        swt_1: chameleonKnown ? soilValue('swt_1', 35, 'shallow') : null,
        swt_2: chameleonKnown ? soilValue('swt_2', 42, 'deep') : null,
        swt_3: chameleonKnown ? soilValue('swt_3', 48, 'deep') : null,
        soil_temp_c: round(weather.airTemperatureC - 1.2)} : {}),
      ...(mode9FlowEligible ? {flow_liters_per_min: 0} : {}),
      ...(mode === 1 && device.temp_enabled === 1 ? {ext_temperature_c: round(weather.airTemperatureC)} : {}),
      ...(calibrated ? {dendro_position_raw_mm: dendroRaw, dendro_position_mm: dendroPosition, dendro_valid: ratioMode ? ratioValid ? 1 : 0 : legacyValid ? 1 : 0, dendro_delta_mm: null,
        dendro_stem_change_um: stemChange, dendro_ratio: ratioMode ? dendroRatio : null,
        dendro_mode_used: ratioMode ? 'ratio_mod3' : 'legacy_single_adc', dendro_saturated: saturated ? 1 : 0,
        dendro_saturation_side: saturationSide} : {})};
  }
  if (device.type_id === 'STREGA_VALVE') {
    const gen2 = config.strega_generation === 'GEN2' || config.valve_generation === 'GEN2';
    const battery = gen2 ? {bat_v: 3.6} : typeof device.latest_data.bat_pct === 'number' ? {bat_pct: device.latest_data.bat_pct} : {};
    return {valve_state: device.current_state == null ? null : device.current_state === 'OPEN' ? 1 : 0, ...battery};
  }
  if (device.type_id === 'SENSECAP_S2120') {
    const baseline = rainBaseline(device);
    const total = rainCounterAt(at, baseline, 0);
    const daily = rainfallMmBetween(dayStart, at);
    const intensity = rainfallMmBetween(at - 10 * 60000, at);
    return {ambient_temperature: round(weather.airTemperatureC), relative_humidity: round(weather.relativeHumidityPct),
      wind_speed_mps: weather.windSpeedMps, wind_gust_mps: weather.windGustMps, wind_direction_deg: weather.windDirectionDeg,
      rain_mm_delta: Number(intervalRain.toFixed(3)), rain_mm_per_hour: Number((intensity * 6).toFixed(3)),
      rain_mm_per_10min: Number(intensity.toFixed(3)),
      rain_gauge_cumulative_mm: Number(total.toFixed(3)), rain_mm_today: Number(daily.toFixed(3)), rain_day: localDayString(at),
      rain_day_timezone: 'Africa/Kampala', rain_day_timezone_basis: 'zone', rain_delta_status: 'ok', counter_interval_seconds: intervalMinutes(device) * 60,
      barometric_pressure_hpa: weather.stationPressureHpa, light_lux: weather.lightLux, uv_index: weather.uvIndex, bat_pct: 90};
  }
  if (device.type_id === 'AQUASCOPE_LORAIN') {
    const baseline = rainBaseline(device), tipsAt = (time: number) => quantizeLoRainTips(rainCounterAt(time, baseline, 0)).tips;
    const tips = Math.max(0, tipsAt(at) - tipsAt(at - intervalMs));
    const todayTips = Math.max(0, tipsAt(at) - tipsAt(dayStart));
    return {rain_tips_delta: tips, rain_mm_delta: tips * 0.5, rain_mm_per_10min: null, rain_mm_per_hour: null,
      rain_mm_today: todayTips * 0.5, rain_day: localDayString(at), rain_day_timezone: 'Africa/Kampala',
      rain_day_timezone_basis: 'zone', counter_interval_seconds: intervalMinutes(device) * 60, rain_delta_status: 'received_only',
      ambient_temperature: round(weather.airTemperatureC), bat_v: 3.3};
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
      : field.startsWith('swt_') ? soilValue(field, 30, field.endsWith('_1') ? 'shallow' : 'deep')
      : field.startsWith('soil_ec_') ? round(0.8 + index * 0.1 + Math.sin(phase / 60) * 0.05)
      : round(weather.airTemperatureC - 1.2 + index * 0.2)]));
  }
  if (device.type_id === 'MILESIGHT_UC512') {
    const day = localDayStart(at), minutes = ((at - day) / 60000);
    const valve1 = minutes >= 360 && minutes < 420, valve2 = minutes >= 450 && minutes < 480;
    const start = rainBaseline(device);
    const pulse1 = 12000 + Math.floor(openMinutesBetween(start, at, 360, 420) * 2);
    const pulse2 = 8000 + Math.floor(openMinutesBetween(start, at, 450, 480));
    return {bat_pct: 90, pipe_pressure_kpa: valve1 ? 190 : valve2 ? 200 : 220,
      valve_1_state: valve1 ? 'open' : 'close', valve_2_state: valve2 ? 'open' : 'close', valve_1_pulse: pulse1, valve_2_pulse: pulse2};
  }
  if (device.type_id === 'RAK10701_FIELD_TESTER') {
    const index = Math.floor(at / (15 * 60000));
    const reportedPosition = {latitude: Number((0.3476 + (Number.parseInt(eui.slice(-2), 16) % 11) * 0.00004).toFixed(6)),
      longitude: Number((32.5825 + (Number.parseInt(eui.slice(-2), 16) % 13) * 0.00004).toFixed(6))};
    const receiverEui = '0016C001F1000001';
    const rssi = -52 - Math.abs(index % 58), snr = Number((7 - (index % 12) * 0.5).toFixed(1));
    return {rssi, snr, network_observation: {version: 1, ingested_at: iso(at), timestamp_source: 'ingest', deduplication_uncertain: true,
      radio: {frequency_hz: null, spreading_factor: null, bandwidth_hz: null, coding_rate: null, f_cnt: null, adr: null, f_port: null},
      reported_position: {latitude: reportedPosition.latitude, longitude: reportedPosition.longitude, altitude_m: null, accuracy_m: null,
        hdop: null, satellites: null, fix_time: null, source: 'simulated'},
      receivers: [{gateway_id: receiverEui, uplink_id_num: null, rssi_dbm: rssi, snr_db: snr, channel: null, crc_status: null,
        position: {latitude: 0.3476, longitude: 32.5825, fix_time: null, source: 'fictional_gateway', sync_version: null}}],
      device_location: null}};
  }
  return {...device.latest_data};
}

export class ReadingLedger {
  private samples = new Map<string, ReadingSample[]>();
  private sampleIndexes = new Map<string, Map<number, number>>();
  private waterInputs = new Map<string, WaterInput>();
  private rainInputs = new Map<string, WaterInput[]>();
  private rainGeneratedUntil = new Map<string, number>();
  private rainBaselinePending = new Set<string>();
  private watermarkCalibration = new Map<string, Record<string, number>>();
  constructor(devices: Device[], public readonly enabled: boolean,
    private readonly rainProjection: (device: Device) => RainProjection = device => ({
      timezone: typeof device.latest_data.rain_day_timezone === 'string' ? device.latest_data.rain_day_timezone : 'Africa/Kampala',
      timezoneBasis: typeof device.latest_data.rain_day_timezone_basis === 'string' ? device.latest_data.rain_day_timezone_basis : 'zone'})) {
    if (enabled) this.seed(devices);
  }

  private seed(devices: Device[]): void {
    const first = PUBLIC_EPOCH - (90 * 48) * INTERVAL_MS;
    for (const device of devices) {
      for (let index = 0; index <= 90 * 48; index++) {
        const at = first + index * INTERVAL_MS;
        let values = this.convertWatermark(device.deveui, deviceValues(device, at), at);
        values = this.projectRainValues(device, at, values, this.rainProjection(device));
        if (at === PUBLIC_EPOCH) {
          if (device.deveui === '00000000000000A1') Object.assign(values, {swt_1: 45, swt_2: 50, swt_3: 55});
          if (device.deveui === '00000000000000A2') Object.assign(values, {swt_1: 10, swt_2: 12, swt_3: 14});
        }
        this.append(device.deveui, at, values, 'seed');
      }
    }
  }

  seedNewDevice(device: Device, createdAt: number, timezone = 'Africa/Kampala', timezoneBasis = 'zone'): void {
    const start = createdAt - 90 * 24 * 60 * 60 * 1000;
    for (let at = start; at < createdAt; at += INTERVAL_MS) {
      const values = this.projectRainValues(device, at, this.convertWatermark(device.deveui, deviceValues(device, at), at), {timezone, timezoneBasis});
      this.append(device.deveui, at, values, 'fictional-history');
    }
    const current = this.projectRainValues(device, createdAt, {...device.latest_data}, {timezone, timezoneBasis});
    this.append(device.deveui, createdAt, current, 'synthetic');
    device.latest_data = {...current, sampled_at: iso(createdAt)} as Device['latest_data'];
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
        for (const field of ['flow_liters_delta', 'flow_liters_today', 'flow_liters_per_10min', 'flow_delta_status', 'counter_interval_seconds']) {
          if (previous.values[field] !== undefined) mergedValues[field] = previous.values[field];
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

  latestCounterSample(deviceEui: string): ReadingSample | undefined {
    const samples = this.samples.get(deviceEui) ?? [];
    for (let index = samples.length - 1; index >= 0; index--) {
      const values = samples[index]!.values;
      if (typeof values.rain_mm_delta === 'number' || values.rain_mm_delta === null ||
        typeof values.flow_liters_delta === 'number') return samples[index];
    }
    return undefined;
  }

  sampleValues(device: Device, at: number, timezone = 'Africa/Kampala', timezoneBasis = 'zone'): ReadingValues {
    const zoneId = String(device.irrigation_zone_id ?? `device:${device.deveui}`), installationId = `zone:${zoneId}`;
    const inputs = at > PUBLIC_EPOCH && ['KIWI_SENSOR','DRAGINO_SDI12','DRAGINO_LSN50'].includes(device.type_id)
      ? this.waterInputsFor(at, zoneId, installationId) : [];
    const values = this.convertWatermark(device.deveui, deviceValues(device, at, inputs), at);
    return this.projectRainValues(device, at, values, {timezone, timezoneBasis});
  }

  observedFlowValues(device: Device, at: number, flowDelta: number, flowToday: number,
    timezone = 'Africa/Kampala', timezoneBasis = 'zone'): ReadingValues {
    const values = this.convertWatermark(device.deveui, deviceValues(device, at), at);
    values.flow_liters_delta = Number(flowDelta.toFixed(2));
    values.flow_liters_today = Number(flowToday.toFixed(2));
    values.flow_delta_status = 'ok';
    return this.projectRainValues(device, at, values, {timezone, timezoneBasis});
  }

  private projectRainValues(device: Device, at: number, values: ReadingValues, projection: RainProjection): ReadingValues {
    const lsn50Mode9 = device.type_id === 'DRAGINO_LSN50' && Number(values.lsn50_mode_code) === 9;
    const lsn50 = lsn50Mode9 && device.rain_gauge_enabled === 1;
    const lsn50Flow = lsn50Mode9 && device.flow_meter_enabled === 1;
    const s2120 = device.type_id === 'SENSECAP_S2120';
    const loRain = device.type_id === 'AQUASCOPE_LORAIN';
    if (!lsn50 && !lsn50Flow && !s2120 && !loRain) return values;
    const date = localDateKey(at, projection.timezone), dayStart = localMidnight(date, projection.timezone);
    const unavailable = lsn50 && missingRainCohortDay(at);
    const previous = this.latestCounterSample(device.deveui);
    const start = previous?.at ?? at - intervalMinutes(device) * 60000;
    const seconds = Math.max(0, (at - start) / 1000);
    if (lsn50Flow && typeof values.flow_liters_delta === 'number') {
      values.flow_liters_per_10min = seconds > 0 ? Number((values.flow_liters_delta * 600 / seconds).toFixed(2)) : 0;
    }
    if (lsn50Flow || lsn50 || s2120) values.counter_interval_seconds = seconds;
    if (loRain) values.counter_interval_seconds = null;
    if (lsn50Flow && !lsn50) return values;
    if (unavailable) {
      this.rainBaselinePending.add(device.deveui);
      for (const field of ['rain_mm_delta','rain_mm_today','rain_mm_per_10min','rain_mm_per_hour']) values[field] = null;
      values.rain_day = date; values.rain_day_timezone = projection.timezone;
      values.rain_day_timezone_basis = projection.timezoneBasis; values.rain_delta_status = 'unknown';
      return values;
    }
    if (lsn50 && this.rainBaselinePending.delete(device.deveui)) {
      for (const field of ['rain_mm_delta','rain_mm_today','rain_mm_per_10min','rain_mm_per_hour']) values[field] = null;
      values.rain_day = date; values.rain_day_timezone = projection.timezone;
      values.rain_day_timezone_basis = projection.timezoneBasis; values.rain_delta_status = 'unknown';
      return values;
    }
    const rainCounterAtPrecision = (timestamp: number) => Number(rainCounterAt(timestamp, rainBaseline(device), 0).toFixed(3));
    const delta = loRain
      ? Math.max(0, quantizeLoRainTips(rainCounterAt(at, rainBaseline(device), 0)).tips -
        quantizeLoRainTips(rainCounterAt(start, rainBaseline(device), 0)).tips) * 0.5
      : Number(Math.max(0, rainCounterAtPrecision(at) - rainCounterAtPrecision(start)).toFixed(3));
    const samples = this.samples.get(device.deveui) ?? [];
    let low = 0, high = samples.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (samples[middle]!.at < dayStart) low = middle + 1;
      else high = middle;
    }
    let measuredToday = 0;
    for (let index = low; index < samples.length && samples[index]!.at < at; index++) {
      const value = samples[index]!.values.rain_mm_delta;
      if (typeof value === 'number') measuredToday += value;
    }
    values.rain_mm_delta = delta;
    values.rain_mm_today = Number((measuredToday + delta).toFixed(3));
    values.rain_day = date; values.rain_day_timezone = projection.timezone;
    values.rain_day_timezone_basis = projection.timezoneBasis;
    if (loRain) {
      values.rain_tips_delta = delta * 2; values.rain_mm_per_10min = null; values.rain_mm_per_hour = null;
      values.rain_delta_status = 'received_only';
    } else {
      values.rain_mm_per_10min = seconds > 0 ? Number((delta * 600 / seconds).toFixed(3)) : 0;
      if (lsn50) values.rain_mm_per_hour = seconds > 0 ? Number((delta * 3600 / seconds).toFixed(3)) : 0;
      values.rain_delta_status = 'ok';
    }
    return values;
  }

  recordDeliveredWater(input: WaterInput): void {
    if (input.deliveredLiters > 0 && !this.waterInputs.has(input.eventId)) {
      this.waterInputs.set(input.eventId, structuredClone(input));
    }
  }

  private waterInputsFor(at: number, zoneId: string, installationId: string): WaterInput[] {
    const cacheKey = `${zoneId}|${installationId}`;
    const rain = this.rainInputs.get(cacheKey) ?? [];
    let generatedUntil = this.rainGeneratedUntil.get(cacheKey) ?? PUBLIC_EPOCH;
    while (generatedUntil + 60000 <= at) {
      const end = generatedUntil + 60000;
      const rainMm = rainfallMmBetween(generatedUntil, end);
      if (rainMm > 0) rain.push({eventId: `physical-rain:${generatedUntil}`, zoneId, installationId,
        atMs: generatedUntil, rainMm, deliveredLiters: 0, areaM2: null, efficiency: null});
      generatedUntil = end;
    }
    this.rainInputs.set(cacheKey, rain);
    this.rainGeneratedUntil.set(cacheKey, generatedUntil);
    const irrigation = [...this.waterInputs.values()].filter(input => input.zoneId === zoneId &&
      input.installationId === installationId && input.atMs <= at);
    const partialRainMm = generatedUntil < at ? rainfallMmBetween(generatedUntil, at) : 0;
    const partialRain = partialRainMm > 0 ? [{eventId: `physical-rain:${generatedUntil}`, zoneId, installationId,
      atMs: generatedUntil, rainMm: partialRainMm, deliveredLiters: 0, areaM2: null, efficiency: null}] : [];
    return [...rain, ...partialRain, ...irrigation];
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
    this.recordDeliveredWater({eventId: `delivery:${deviceEui}:${at}`, zoneId: String(device.irrigation_zone_id ?? `device:${deviceEui}`),
      installationId: `zone:${device.irrigation_zone_id ?? `device:${deviceEui}`}`, atMs: at, rainMm: 0, deliveredLiters,
      areaM2: null, efficiency: null});
  }

  between(deviceEui: string, from: number, to: number): ReadingSample[] {
    return (this.samples.get(deviceEui) ?? []).filter(sample => sample.at >= from && sample.at <= to).map(sample => structuredClone(sample));
  }

  clear(): void { this.samples.clear(); this.sampleIndexes.clear(); this.waterInputs.clear(); this.rainInputs.clear(); this.rainGeneratedUntil.clear(); this.rainBaselinePending.clear(); }
  clone(): ReadingLedger {
    const copy = new ReadingLedger([], false, this.rainProjection);
    for (const [eui, samples] of this.samples) for (const sample of samples) copy.append(eui, sample.at, sample.values, sample.source);
    copy.waterInputs = new Map([...this.waterInputs].map(([id, input]) => [id, structuredClone(input)]));
    copy.rainInputs = new Map([...this.rainInputs].map(([key, inputs]) => [key, structuredClone(inputs)]));
    copy.rainGeneratedUntil = new Map(this.rainGeneratedUntil);
    copy.rainBaselinePending = new Set(this.rainBaselinePending);
    copy.watermarkCalibration = new Map(this.watermarkCalibration);
    return copy;
  }
}

export function sampleIntervalMs(): number { return INTERVAL_MS; }
export function sampleTime(at: number): string { return iso(at); }
