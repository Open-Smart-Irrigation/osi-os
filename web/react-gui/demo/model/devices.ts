import type {Device, DeviceType} from '../../src/types/farming';
import {makeDevice, SimulatorState} from './state';
import {normalizedName} from './farm';
import {iso} from '../fixtures';

export const DEVICE_CATALOG = [
  {id: 'KIWI_SENSOR', name: 'Kiwi Soil Sensor'},
  {id: 'TEKTELIC_CLOVER', name: 'Clover Soil Sensor'},
  {id: 'STREGA_VALVE', name: 'Strega Smart Valve'},
  {id: 'DRAGINO_LSN50', name: 'Dragino LSN50 Sensor Node'},
  {id: 'SENSECAP_S2120', name: 'SenseCAP S2120 Weather Station'},
  {id: 'AQUASCOPE_LORAIN', name: 'Aqua-Scope LoRain Rain Gauge'},
  {id: 'MILESIGHT_UC512', name: 'Milesight UC512 Valve Controller'},
  {id: 'DRAGINO_SDI12', name: 'Dragino SDI-12 Soil Node (LB/LS)'},
  {id: 'RAK10701_FIELD_TESTER', name: 'RAK10701 Field Tester'},
] as const;

export function createDevice(euiValue: unknown, nameValue: unknown, typeValue: unknown, zoneId: number | null, now: number,
  stregaGeneration?: unknown): Device {
  const eui = String(euiValue ?? '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(eui)) throw Object.assign(new Error('demo_device'), {status: 422});
  if (!DEVICE_CATALOG.some(item => item.id === typeValue)) throw Object.assign(new Error('type_id'), {status: 422});
  const type = typeValue as DeviceType;
  const device = makeDevice(eui, normalizedName(nameValue), zoneId);
  device.type_id = type;
  (device as Device & {created_at: string}).created_at = iso(now);
  device.updated_at = iso(now);
  device.last_seen = iso(now);
  if (type === 'STREGA_VALVE') Object.assign(device, {strega_generation: stregaGeneration === 'GEN2' ? 'GEN2' : 'GEN1'});
  if (type === 'STREGA_VALVE' || type === 'MILESIGHT_UC512') {
    device.current_state = 'CLOSED'; device.target_state = 'CLOSED';
    device.latest_data = {bat_pct: 90};
  } else if (type === 'KIWI_SENSOR') {
    (device as Device & {temp_humidity_enabled?: number}).temp_humidity_enabled = 0;
    delete device.latest_data.ambient_temperature;
    delete device.latest_data.relative_humidity;
  } else if (type === 'TEKTELIC_CLOVER') {
    device.latest_data = {swt_1: 31, swt_2: 37, ambient_temperature: 24, relative_humidity: 68, light_lux: 18000};
  } else if (type === 'DRAGINO_LSN50') {
    device.latest_data = {};
    Object.assign(device, {lsn50_mode: 'MOD9', lsn50_mode_code: 9, rain_gauge_enabled: 1, flow_meter_enabled: 1,
      temp_enabled: 0, dendro_enabled: 0, chameleon_enabled: 0});
    Object.assign(device.latest_data, {rain_mm_delta: 0, rain_mm_today: 0, flow_liters_delta: 0,
      flow_liters_today: 0, flow_liters_per_10min: 0, counter_interval_seconds: 1800});
  } else if (type === 'SENSECAP_S2120') device.latest_data = {ambient_temperature: 24,
    relative_humidity: 68, wind_speed_mps: 1.2, wind_direction_deg: 135, wind_gust_mps: 2.1,
    rain_mm_delta: 0, rain_gauge_cumulative_mm: 0};
  else if (type === 'DRAGINO_SDI12') {
    device.sdi12_probe_profile = 'TENSIOMARK'; device.sdi12_probe_status = 'manual';
    device.sdi12_value_count = 2; device.latest_data = {};
    device.soil_moisture_probe_depths_json = {swt_1: 30, soil_temp_1: 30}; device.soil_moisture_probe_depths_configured = 1;
  } else if (type === 'AQUASCOPE_LORAIN') device.latest_data = {rain_mm_delta: 0, rain_mm_today: 0, rain_gauge_cumulative_mm: 0};
  else if (type === 'RAK10701_FIELD_TESTER') device.latest_data = {};
  SimulatorState.initialisePublicDevice(device, now, false);
  return device;
}

export function setFlag(device: Device, field: keyof Device, value: unknown): void {
  if (typeof value !== 'boolean') throw Object.assign(new Error('invalid'), {status: 422});
  (device as unknown as Record<string, unknown>)[field] = value ? 1 : 0;
}
