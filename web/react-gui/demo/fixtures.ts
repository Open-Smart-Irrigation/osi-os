import type { Device, IrrigationZone, ZoneEnvironmentSummary } from '../src/types/farming';
export const DEMO_EPOCH = Date.parse('2026-09-29T09:00:00Z');
export const VALVE_EUI = '00000000000000D1';
export const SPARE_EUI = '00000000000000A3';
export const iso = (time: number) => new Date(time).toISOString();
export function zoneFixture(id: number, name: string): IrrigationZone {
  return { id, name, zone_uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    device_count: 0, created_at: iso(DEMO_EPOCH), updated_at: iso(DEMO_EPOCH),
    schedule: null, timezone: 'Africa/Kampala', area_m2: 100, irrigation_efficiency_pct: 85,
    crop_type: 'Tomato', soil_type: 'Loam', irrigation_method: 'Drip', prediction_card_enabled: false };
}
export function sensorFixture(deveui: string, name: string, zoneId: number | null, swt1 = 35, swt2 = 32): Device {
  return { deveui, name, type_id: 'KIWI_SENSOR', irrigation_zone_id: zoneId,
    last_seen: iso(DEMO_EPOCH), soil_moisture_probe_depths_configured: true,
    soil_moisture_probe_depths_json: { swt_1: 20, swt_2: 40 },
    latest_data: { swt_1: swt1, swt_2: swt2, ambient_temperature: 26.4,
      relative_humidity: 68, light_lux: 12500, bat_pct: 92 } };
}
function waterSensorFixture(id: number): Device {
  return {deveui: `00000000000000E${id}`, name: `${id === 1 ? 'Tomato' : 'Bed'} rain and flow meter`,
    type_id: 'DRAGINO_LSN50', irrigation_zone_id: id, last_seen: iso(DEMO_EPOCH),
    rain_gauge_enabled: 1, flow_meter_enabled: 1, temp_enabled: 0, dendro_enabled: 0,
    latest_data: {lsn50_mode_code: 9, lsn50_mode_label: 'MOD9', lsn50_mode_observed_at: iso(DEMO_EPOCH),
      rain_mm_today: id === 1 ? 0 : 6, rain_mm_delta: 0, rain_mm_per_10min: 0,
      flow_liters_today: id === 1 ? 120 : 80, flow_liters_delta: 0, flow_liters_per_10min: 0,
      counter_interval_seconds: 900, rain_delta_status: 'ok', flow_delta_status: 'ok', bat_pct: 90}};
}
export function seedDevices(): Device[] {
  return [sensorFixture('00000000000000A1', 'Tomato soil probe', 1, 68, 56),
    sensorFixture('00000000000000A2', 'Bed soil probe', 2, 12, 35),
    sensorFixture(SPARE_EUI, 'Spare demonstration probe', null),
    waterSensorFixture(1), waterSensorFixture(2),
    { deveui: VALVE_EUI, name: 'Tomato valve', type_id: 'STREGA_VALVE', irrigation_zone_id: 1,
      strega_model: 'STANDARD', current_state: 'CLOSED', target_state: 'CLOSED',
      last_seen: iso(DEMO_EPOCH), latest_data: { bat_pct: 94 } }];
}
// Fixed sensor snapshots: no weather service, forecast, ET0 or demand calculation.
export function environmentFixture(zone: IrrigationZone, devices: Device[]): ZoneEnvironmentSummary {
  const sensorCount = devices.filter(d => d.type_id !== 'STREGA_VALVE').length;
  const rainGauge = devices.find(d => d.rain_gauge_enabled === 1);
  const flowMeter = devices.find(d => d.flow_meter_enabled === 1);
  const rain = rainGauge?.latest_data.rain_mm_today ?? null;
  const liters = flowMeter?.latest_data.flow_liters_today ?? null;
  const netMm = liters == null ? null : liters / 100 * 0.85;
  const populated = sensorCount > 0;
  const at = populated ? iso(DEMO_EPOCH) : null;
  return { zoneId: zone.id, zoneName: zone.name, generatedAt: iso(DEMO_EPOCH),
    location: { latitude: null, longitude: null, timezone: 'Africa/Kampala', source: 'unavailable' },
    display: { mode: 'unlinked_local', schedulingMode: 'local', sourceLabel: 'Demo', sharedGeneratedAt: null, sharedObservedAt: null, lastReceivedAt: null, fallbackReason: null },
    water: { available: populated, observedAt: at, areaM2: 100, irrigationEfficiencyPct: 85,
      rainTodayMm: rain, irrigationTodayLiters: liters, irrigationTodayNetMm: netMm,
      irrigationTodayMeasuredLiters: liters, measuredIrrigationNetMm: netMm, irrigationTodayEstimatedLiters: null,
      waterNeededTodayMm: null, balanceTodayMm: null, next24hRainMm: null, action: null,
      daily: [{date: iso(DEMO_EPOCH).slice(0, 10), rainMm: rain, irrigationLiters: liters,
        irrigationNetMm: netMm, measuredIrrigationLiters: liters, measuredIrrigationNetMm: netMm,
        totalWaterMm: rain == null || netMm == null ? null : rain + netMm}],
      sensorHealth: {sensorCount, freshSensorCount: sensorCount, staleSensorCount: 0,
        rainGaugePresent: !!rainGauge, flowMeterPresent: !!flowMeter, warnings: []} },
    local: {available: populated, observedAt: at, sensorCount, freshSensorCount: sensorCount, staleSensorCount: 0, metrics: [], devices: []},
    online: {available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null},
    agronomic: {preferredSource: 'unavailable', current: null},
    forecast: {available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null} };
}
