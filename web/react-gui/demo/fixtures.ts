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
export function seedDevices(): Device[] {
  return [sensorFixture('00000000000000A1', 'Tomato soil probe', 1, 68, 56),
    sensorFixture('00000000000000A2', 'Bed soil probe', 2, 12, 35),
    sensorFixture(SPARE_EUI, 'Spare demonstration probe', null),
    { deveui: VALVE_EUI, name: 'Tomato valve', type_id: 'STREGA_VALVE', irrigation_zone_id: 1,
      strega_model: 'STANDARD', current_state: 'CLOSED', target_state: 'CLOSED',
      last_seen: iso(DEMO_EPOCH), latest_data: { bat_pct: 94 } }];
}
// Simulated backend output, matching resolveWaterAction in osi-zone-env/index.js.
// No live weather service, ET0 calculation or crop prediction runs here.
export function environmentFixture(zone: IrrigationZone, devices: Device[]): ZoneEnvironmentSummary {
  const sensorCount = devices.filter(d => d.type_id === 'KIWI_SENSOR').length;
  const populated = sensorCount > 0;
  const dry = zone.id === 1;
  const at = populated ? iso(DEMO_EPOCH) : null;
  return { zoneId: zone.id, zoneName: zone.name, generatedAt: iso(DEMO_EPOCH),
    location: { latitude: null, longitude: null, timezone: 'Africa/Kampala', source: 'unavailable' },
    display: { mode: 'unlinked_local', schedulingMode: 'local', sourceLabel: 'Demo', sharedGeneratedAt: null, sharedObservedAt: null, lastReceivedAt: null, fallbackReason: null },
    water: { available: populated, observedAt: at, areaM2: 100, irrigationEfficiencyPct: 85,
      rainTodayMm: dry ? 0 : 6, irrigationTodayLiters: 0, irrigationTodayNetMm: 0,
      irrigationTodayMeasuredLiters: null, irrigationTodayEstimatedLiters: null,
      waterNeededTodayMm: 4, balanceTodayMm: dry ? -4 : 2, next24hRainMm: dry ? 0.5 : 5,
      action: populated ? { code: dry ? 'irrigate_today' : 'delay_irrigation', source: 'heuristic',
        reasonCode: dry ? 'demand_exceeds_supply' : 'supply_covers_demand', recommendationDate: '2026-09-29' } : null,
      daily: Array.from({length: 7}, (_, i) => ({ date: iso(DEMO_EPOCH - (6 - i) * 86400000).slice(0, 10),
        rainMm: dry ? [2, 0, 1, 0, 0, 0, 0][i] : [1, 0, 3, 0, 2, 4, 6][i], irrigationLiters: 0, irrigationNetMm: 0, totalWaterMm: dry ? [2, 0, 1, 0, 0, 0, 0][i] : [1, 0, 3, 0, 2, 4, 6][i] })),
      sensorHealth: {sensorCount, freshSensorCount: sensorCount, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: []} },
    local: {available: populated, observedAt: at, sensorCount, freshSensorCount: sensorCount, staleSensorCount: 0, metrics: [], devices: []},
    online: {available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null},
    agronomic: {preferredSource: 'unavailable', current: null},
    forecast: {available: populated, source: 'open_meteo', cacheStatus: 'stale', observedAt: at, expiresAt: at, rainFocus: populated ? {totalNext24hMm: dry ? 0.5 : 5, totalNext72hMm: dry ? 2 : 9, maxHourlyRainMm: dry ? 0.5 : 5, maxHourlyRainAt: iso(DEMO_EPOCH + 3600000), nextRainEta: iso(DEMO_EPOCH + 3600000), rainHoursNext24h: 1, daily: [], hourly: [{time: iso(DEMO_EPOCH + 3600000), rainMm: dry ? 0.5 : 5, rainProbabilityPct: 70, tempC: 26, windSpeedMps: 1.2}]} : null} };
}
