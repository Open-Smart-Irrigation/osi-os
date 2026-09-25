import type { Device, IrrigationZone } from '../src/types/farming';

export const NOW = Date.parse('2026-09-25T10:00:00Z');
export const OBSERVED = '2026-09-25T09:55:00Z';
export type Scenario = 'fresh' | 'stale' | 'fault' | 'zero' | 'future';

export function previewDevices(scenario: Scenario): Device[] {
  const lastSeen = scenario === 'stale' ? '2026-09-25T06:00:00Z'
    : scenario === 'future' ? '2027-09-25T10:00:00Z' : OBSERVED;
  return [
    {
      deveui: '0000000000000001', name: 'Kiwi · north bed', type_id: 'KIWI_SENSOR',
      last_seen: lastSeen, soilMoistureProbeDepths: { swt_1: 20, swt_2: 40 },
      latest_data: { swt_1: scenario === 'zero' ? 0 : 12.4, swt_2: 32.8,
        light_lux: 18400, ambient_temperature: 24.6, relative_humidity: 62, bat_pct: 87 },
    },
    {
      deveui: '0000000000000002', name: 'Chameleon · orchard', type_id: 'DRAGINO_LSN50',
      last_seen: lastSeen, chameleon_enabled: 1, temp_enabled: 1,
      chameleon_swt1_depth_cm: 20, chameleon_swt2_depth_cm: 40, chameleon_swt3_depth_cm: 60,
      latest_data: { swt_1: 16, swt_2: 37, swt_3: 72, ext_temperature_c: 21.5, bat_v: 3.42,
        chameleon_i2c_missing: scenario === 'fault' ? 1 : 0 },
    },
    {
      deveui: '0000000000000003', name: 'Tensiomark · south bed', type_id: 'DRAGINO_SDI12',
      last_seen: lastSeen, sdi12_probe_profile: 'TENSIOMARK', sdi12_probe_status: 'identified',
      soil_moisture_probe_depths_json: { swt_1: 30 },
      latest_data: { swt_1: scenario === 'zero' ? 0 : 30.2, soil_temp_1: 21.5, bat_v: 3.51 },
    },
  ];
}

export const zone: IrrigationZone = {
  id: 12, name: 'Zone B', device_count: 3,
  created_at: OBSERVED, updated_at: OBSERVED, timezone: 'Europe/Zurich',
  schedule: { irrigation_zone_id: 12, trigger_metric: 'SWT_2', threshold_kpa: 30, enabled: true },
};

// This fixed environment response exercises the real Water card's other tiles.
export const environment = {
  zoneId: 12, zoneName: zone.name, generatedAt: OBSERVED,
  water: {
    available: true, observedAt: OBSERVED, rainTodayMm: 4.2, next24hRainMm: 2.1,
    irrigationTodayMeasuredLiters: null, irrigationTodayEstimatedLiters: null,
    action: { code: null, source: 'insufficient_data', reasonCode: 'insufficient_data' },
    sensorHealth: { sensorCount: 3, freshSensorCount: 3, staleSensorCount: 0,
      rainGaugePresent: true, flowMeterPresent: false, warnings: [] },
  },
  display: { mode: 'unlinked_local', fallbackReason: null },
};
