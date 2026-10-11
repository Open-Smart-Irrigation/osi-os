import type {IrrigationZone} from '../../src/types/farming';
import {zoneFixture, iso} from '../fixtures';
import {normalizeEntityName} from '../../src/utils/entityName';

type Body = Record<string, unknown>;
export type FarmState = {zones: IrrigationZone[]; nextZoneId: number; now: number; settings: {defaultTimezone: string; gatewayTimezone: string}};
export function normalizedName(value: unknown): string {
  if (typeof value !== 'string') throw Object.assign(new Error('invalid'), {status: 422});
  const result = normalizeEntityName(value);
  if (!result.ok) throw Object.assign(new Error(result.reason), {status: 400});
  return result.name;
}
export function createZone(state: FarmState, body: Body): IrrigationZone {
  const zone = zoneFixture(state.nextZoneId++, normalizedName(body.name));
  zone.timezone = state.settings.defaultTimezone || state.settings.gatewayTimezone;
  zone.created_at = zone.updated_at = iso(state.now);
  state.zones.push(zone);
  return zone;
}
export function renameZone(zone: IrrigationZone, value: unknown, now: number) {
  const name = normalizedName(value);
  const changed = name !== zone.name;
  if (changed) { zone.name = name; zone.updated_at = iso(now); }
  return {...zone, changed, sync_version: changed ? 1 : 0};
}
export function configureZone(zone: IrrigationZone, body: Body, now: number): IrrigationZone {
  const fields: Record<string, string> = {
    cropType: 'crop_type', variety: 'variety', soilType: 'soil_type', irrigationMethod: 'irrigation_method',
    areaM2: 'area_m2', irrigationEfficiencyPct: 'irrigation_efficiency_pct', schedulingMode: 'scheduling_mode',
    notes: 'notes', timezone: 'timezone', phenologicalStage: 'phenological_stage', calibrationKey: 'calibration_key',
    predictionCardEnabled: 'prediction_card_enabled', weatherSource: 'weather_source', stageStartedOn: 'stage_started_on',
  };
  const patch: Record<string, unknown> = {};
  for (const [input, output] of Object.entries(fields)) if (input in body) {
    const value = body[input];
    if ((input === 'areaM2' && value != null && !(Number(value) > 0)) ||
      (input === 'irrigationEfficiencyPct' && value != null && !(Number(value) >= 0 && Number(value) <= 100))) {
      throw Object.assign(new Error('invalid'), {status: 422});
    }
    patch[output] = value;
  }
  Object.assign(zone, patch);
  zone.updated_at = iso(now);
  return zone;
}
export function deleteZone(state: FarmState, devices: Array<{irrigation_zone_id?: number | null}>, id: number): void {
  state.zones = state.zones.filter(zone => zone.id !== id);
  devices.forEach(device => { if (device.irrigation_zone_id === id) device.irrigation_zone_id = null; });
}
