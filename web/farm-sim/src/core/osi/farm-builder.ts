import {Simulator, type SimulatorOptions} from '@osi-demo/model';
import {BED_A_AREA_M2, BED_A_ZONE} from '../map';
import {DAY_MS, FARM_SITE, localDate, localDayStart} from '../time';
import type {ReplayHeader, Scenario} from '../types';
import {WATER} from '../water';

export const PROBE_EUI = '00000000000000B1';
export const METER_EUI = '00000000000000B2';
export const VALVE_EUI = '00000000000000B3';
export const ZONE_PATH = '/api/irrigation-zones/' + BED_A_ZONE;
export const VALVE_PATH = '/api/valve/' + VALVE_EUI;
export const PLANS_PATH = '/api/valves/' + VALVE_EUI;

export function buildFarm(header: ReplayHeader, scenario: Scenario,
  sources: Pick<SimulatorOptions, 'readingSource' | 'weatherSource'>): Simulator {
  const sim = new Simulator({mode: 'public', fictionalHistory: false, ...sources});
  const write = (method: string, path: string, body?: unknown) => {
    const response = sim.requestResponse(method, path, body);
    if (response.status >= 400) throw new Error('Farm initialization failed for ' + path + ' with status ' + response.status);
  };
  const register = (deveui: string, name: string, type_id: string) =>
    write('POST', '/api/devices', {deveui, name, type_id, zone_id: BED_A_ZONE});
  for (const device of [...sim.devices]) write('DELETE', '/api/devices/' + device.deveui);
  sim.clock.reset(header.start);
  sim.state.now = header.start;
  sim.state.settings.defaultTimezone = FARM_SITE.timezone;
  write('PUT', ZONE_PATH + '/config', {
    cropType: 'tomato', phenologicalStage: 'mid_season',
    stageStartedOn: localDate(localDayStart(header.start) - scenario.initial.bedA.dayInStage * DAY_MS),
    areaM2: BED_A_AREA_M2, irrigationEfficiencyPct: WATER.dripEfficiency * 100, soilType: 'sandy_loam',
    irrigationMethod: 'drip', timezone: FARM_SITE.timezone, weatherSource: header.tier >= 2 ? 'auto' : 'local',
  });
  write('PUT', ZONE_PATH + '/location', {latitude: FARM_SITE.latDeg, longitude: FARM_SITE.lonDeg});
  write('PUT', '/api/system/settings', {gatewayTimezone: FARM_SITE.timezone});
  write('PUT', ZONE_PATH + '/name', {name: 'Tomato bed'});
  write('DELETE', '/api/irrigation-zones/2');
  sim.resetEnvironmentRecords();
  if (header.tier >= 1) register(PROBE_EUI, 'Bed soil probe', 'KIWI_SENSOR');
  if (header.tier >= 2) register(METER_EUI, 'Rain and flow meter', 'DRAGINO_LSN50');
  if (header.tier >= 3) {
    register(VALVE_EUI, 'Bed valve', 'STREGA_VALVE');
    write('PUT', PLANS_PATH + '/settings', {flow_rate_lpm: WATER.dripRateLpm});
  }
  const trigger = scenario.reference.tiers.find(policy => policy.kind === 'swt-trigger');
  if (header.tier === 4 && trigger) {
    write('PUT', ZONE_PATH + '/schedule', {trigger_metric: trigger.sensor,
      threshold_kpa: trigger.kPa, duration_minutes: trigger.minutes, enabled: true});
  }
  sim.state.sessions.pendingOutboxCount = 0;
  return sim;
}
