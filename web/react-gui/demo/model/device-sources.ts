import type {Device} from '../../src/types/farming';
import {sha256Text} from './sha256';

export type DeviceSourceDescription = {families: Record<string, string[]>; current: string[]; presentation: 'timeseries' | 'specialized' | 'unsupported';
  destination: 'network' | null; limitation: 'valve_events' | 'unsupported_type' | null};
const climate = ['ambient_temperature', 'relative_humidity', 'light_lux'];
const weather = ['wind_speed_mps','wind_gust_mps','barometric_pressure_hpa','uv_index','rain_count_cumulative','rain_tips_delta','rain_gauge_cumulative_mm','rain_mm_per_hour','rain_mm_per_10min','rain_mm_today','rain_mm_delta','wind_direction_deg','pipe_pressure_kpa'];
const flow = ['flow_liters_per_min','flow_liters_per_10min','flow_liters_today','flow_liters_delta','flow_count_cumulative','flow_pulses_delta'];
const dendro = ['dendro_stem_change_um','dendro_position_mm','dendro_position_raw_mm','dendro_delta_mm','dendro_ratio','adc_ch0v','adc_ch1v'];
const sdi = [...Array.from({length: 10}, (_, i) => `vwc_${i + 1}`), ...Array.from({length: 10}, (_, i) => `soil_vic_${i + 1}`),
  'swt_1','soil_temp_1','soil_temp_2','soil_ec_1','soil_ec_2'];
const health = ['bat_v', 'bat_pct'];
export function describeDeviceSource(device: Device): DeviceSourceDescription {
  const record = device as Device & Record<string, unknown>;
  const type = device.type_id, current: string[] = [], families: Record<string, string[]> = {};
  const add = (family: string, keys: string[]) => { families[family] = [...new Set([...(families[family] ?? []), ...keys])]; };
  if (type === 'KIWI_SENSOR') { add('soil', ['swt_1','swt_2', ...(device.chameleon_enabled === 1 ? ['swt_3'] : [])]); add('environment', climate); add('device_health', health); current.push(...families.soil!, ...climate, ...health); }
  else if (type === 'TEKTELIC_CLOVER') { add('environment', climate); add('device_health', health); current.push(...climate, ...health); }
  else if (type === 'SENSECAP_S2120') { add('environment', [...climate, ...weather.filter(key => key !== 'pipe_pressure_kpa')]); add('device_health', ['bat_v']); current.push(...families.environment!, 'bat_v'); }
  else if (type === 'AQUASCOPE_LORAIN') { add('environment', ['ambient_temperature','rain_tips_delta','rain_mm_delta','rain_mm_today','rain_mm_per_hour','rain_mm_per_10min']); add('device_health', ['bat_v']); current.push(...families.environment!, 'bat_v'); }
  else if (type === 'MILESIGHT_UC512') { add('environment', ['pipe_pressure_kpa']); add('device_health', ['bat_pct','valve_1_pulse','valve_2_pulse']); current.push('pipe_pressure_kpa','bat_pct','valve_1_pulse','valve_2_pulse'); }
  else if (type === 'STREGA_VALVE') { add('device_health', ['ambient_temperature','relative_humidity', ...health]);
    current.push(...(record.valve_generation === 'GEN2' || record.strega_generation === 'GEN2' ? ['bat_v'] : ['bat_pct','ambient_temperature','relative_humidity'])); }
  else if (type === 'DRAGINO_LSN50') {
    add('soil', ['swt_1','swt_2','swt_3']); add('environment', ['ext_temperature_c', ...weather.filter(key => key.startsWith('rain_')), ...flow]);
    add('dendro', dendro); add('device_health', ['bat_v']);
    if (device.chameleon_enabled === 1) current.push('swt_1','swt_2','swt_3');
    else if (record.watermark_enabled === 1 || record.watermark_fixture === true || (device.temp_enabled !== 1 && device.rain_gauge_enabled !== 1 && device.flow_meter_enabled !== 1 && device.dendro_enabled !== 1)) current.push('swt_1','swt_2');
    if (device.temp_enabled === 1) current.push('ext_temperature_c');
    if (device.rain_gauge_enabled === 1) current.push('rain_count_cumulative','rain_tips_delta','rain_gauge_cumulative_mm','rain_mm_per_hour','rain_mm_per_10min','rain_mm_today','rain_mm_delta');
    if (device.flow_meter_enabled === 1) current.push(...flow);
    if (device.dendro_enabled === 1) current.push(...dendro);
    current.push('bat_v');
  } else if (type === 'DRAGINO_SDI12') {
    add('soil', sdi); add('device_health', ['bat_v']);
    const depths = device.soil_moisture_probe_depths_json;
    if (depths && Object.keys(depths).length) current.push(...Object.keys(depths).filter(key => sdi.includes(key)));
    const layout = (device as Device & {sdi12_channel_layout_json?: {sensors?: Array<{channel: number; type?: string}>}}).sdi12_channel_layout_json?.sensors ?? [];
    if (!current.length && layout.length) for (const sensor of layout) if (Number.isInteger(sensor.channel) && sensor.channel >= 1 && sensor.channel <= 10) {
      current.push(`vwc_${sensor.channel}`); if (sensor.type?.toUpperCase() === 'TRISCAN') current.push(`soil_vic_${sensor.channel}`);
    }
    if (!current.length) {
      const profile = device.sdi12_probe_profile;
      if (profile === 'TENSIOMARK') current.push('swt_1','soil_temp_1');
      if (profile === 'IMKO_PICO64') current.push('vwc_1','soil_temp_1');
      if (profile === 'HYDRASCOUT') current.push('vwc_1','soil_temp_1','soil_ec_1','vwc_2','soil_temp_2','soil_ec_2');
      if (profile === 'SENTEK_ENVIROSCAN') current.push(...layout.flatMap(sensor => [`vwc_${sensor.channel}`, ...(sensor.type?.toUpperCase() === 'TRISCAN' ? [`soil_vic_${sensor.channel}`] : [])]));
    }
    current.push('bat_v');
  } else if (type === 'RAK10701_FIELD_TESTER') return {families, current, presentation: 'specialized', destination: 'network', limitation: null};
  else return {families, current, presentation: 'unsupported', destination: null, limitation: 'unsupported_type'};
  return {families, current: [...new Set(current)], presentation: Object.values(families).some(keys => keys.length) ? 'timeseries' : 'unsupported',
    destination: null, limitation: type === 'STREGA_VALVE' || type === 'MILESIGHT_UC512' ? 'valve_events' : null};
}
export function canonicalEui(value: string): string { const eui = value.replace(/[^0-9a-f]/gi, '').toUpperCase(); if (!/^[0-9A-F]{16}$/.test(eui)) throw new Error('invalid device EUI'); return eui; }
export function deviceSourceId(device: Device): string { return `device-${sha256Text(canonicalEui(device.deveui)).slice(0, 12)}`; }
export function sourceKey(cardType: string, device: Device): string { return `${cardType}-src-${sha256Text(canonicalEui(device.deveui)).slice(0, 12)}`; }
export function analysisSeriesId(zoneId: number | null, cardType: string, source: string, channel: string): string {
  return sha256Text(`${zoneId === null ? 'unassigned' : zoneId}|${cardType}|${source}|${channel}`).slice(0, 16);
}
export function soilDepthCm(device: Device, channel: string): number | null {
  if (channel === 'swt_3' && device.type_id === 'DRAGINO_LSN50' && device.chameleon_enabled !== 1) return null;
  const direct = (device as Device & Record<string, unknown>)[
    ({swt_1:'chameleon_swt1_depth_cm',swt_2:'chameleon_swt2_depth_cm',swt_3:'chameleon_swt3_depth_cm'} as Record<string,string>)[channel] ?? ''];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const depths = device.soil_moisture_probe_depths_json;
  const candidate = depths?.[channel] ?? (depths as unknown as Record<string,unknown> | null)?.[channel.replace('_','')] ?? (depths as unknown as Record<string,unknown> | null)?.[channel.toUpperCase()];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}
