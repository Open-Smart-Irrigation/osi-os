import type {GatewayModuleDefaults, SystemSettings, UpdateSystemSettingsRequest, UpdateSystemSettingsResult} from '../../src/services/api';
import type {IrrigationZone} from '../../src/types/farming';

export const PUBLIC_GATEWAY_MODULE_DEFAULTS: GatewayModuleDefaults = {
  dataModuleEnabled: true,
  networkModuleEnabled: true,
  gatewayHubModuleEnabled: true,
  journalModuleEnabled: true,
};

export interface GatewayPreferences {
  gatewayTimezone: string;
  dataModuleEnabled: boolean;
  networkModuleEnabled: boolean;
  gatewayHubModuleEnabled: boolean;
  journalModuleEnabled: boolean;
}

export function createGatewayPreferences(): GatewayPreferences {
  return {gatewayTimezone: 'Africa/Kampala', ...PUBLIC_GATEWAY_MODULE_DEFAULTS};
}

export function readSystemSettings(settings: GatewayPreferences): SystemSettings {
  return {...settings, moduleDefaults: {...PUBLIC_GATEWAY_MODULE_DEFAULTS}};
}

export function updateSystemSettings(
  current: GatewayPreferences,
  zones: IrrigationZone[],
  body: UpdateSystemSettingsRequest,
  updatedAt = new Date().toISOString(),
): {settings: GatewayPreferences; result: UpdateSystemSettingsResult; zonesChanged: boolean} {
  const next = {...current};
  const input = body as Record<string, unknown>;
  const moduleKeys = ['dataModuleEnabled', 'networkModuleEnabled', 'gatewayHubModuleEnabled', 'journalModuleEnabled'] as const;
  const moduleWrites = moduleKeys.filter(key => key in input);
  let changed = false;
  for (const key of moduleWrites) {
    if (typeof input[key] !== 'boolean') throw Object.assign(new Error(`${key} must be a boolean`), {status: 422, code: 'invalid_request'});
    next[key] = input[key];
    changed = true;
  }
  const hasTimezone = Object.prototype.hasOwnProperty.call(input, 'gatewayTimezone');
  let applyTimezone = current.gatewayTimezone;
  if (hasTimezone || moduleWrites.length === 0) {
    const timezone = String(input.gatewayTimezone || '').trim();
    if (!timezone) throw Object.assign(new Error('gatewayTimezone is required'), {status: 422, code: 'invalid_timezone'});
    try { new Intl.DateTimeFormat('en', {timeZone: timezone}); }
    catch { throw Object.assign(new Error('gatewayTimezone must be a valid IANA time zone'), {status: 422, code: 'invalid_timezone'}); }
    applyTimezone = timezone;
    next.gatewayTimezone = timezone;
    changed = true;
  }
  let zonesChanged = false;
  let zonesUpdated = 0;
  if (input.applyToAllZones === true) {
    for (const zone of zones) {
      if (zone.timezone === applyTimezone) continue;
      zone.timezone = applyTimezone;
      const versionedZone = zone as IrrigationZone & {sync_version?: number};
      versionedZone.sync_version = (versionedZone.sync_version ?? 0) + 1;
      zone.updated_at = updatedAt;
      zonesUpdated++;
    }
    zonesChanged = zonesUpdated > 0;
  }
  if (!changed) throw Object.assign(new Error('gatewayTimezone is required'), {status: 422, code: 'invalid_timezone'});
  return {settings: next, zonesChanged, result: {
    ...next,
    gatewayTimezone: next.gatewayTimezone,
    zonesUpdated,
    moduleDefaults: {...PUBLIC_GATEWAY_MODULE_DEFAULTS},
  }};
}
