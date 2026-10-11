import type {Device, IrrigationZone, IrrigationSchedule} from '../../src/types/farming';
import type {IrrigationActuation} from '../../src/services/api';
import type {ValvePlan} from './plans';
import type {TriggerEvaluation} from './triggers';
import {seedDevices, zoneFixture, sensorFixture, DEMO_EPOCH, PUBLIC_EPOCH, iso} from '../fixtures';
import {createGatewayPreferences} from './preferences';
import {createSystemState, type PublicSystemState} from './system';
import {createSessionState, type DemoSessionState} from './sessions';
import {createAnalysisState, type AnalysisState} from './analysis';
import {createHistoryState, type HistoryState} from './history';
import {createNetworkState, type NetworkState} from './network';
import {deviceValues} from './readings';

export type SimulatorMode = 'presentation' | 'public';
export type RetainedEnvironmentRecord = {date: string; provider: 'open_meteo' | 'meteoswiss' | null; timezone: string;
  sampleAt: number; dayStart: number; dayEnd: number; hourly: Array<{at: number; et0Mm: number}>;
  values: Record<string, number | string | null>;
  provenance: {cropType: string | null; stage: string | null; stageStartedOn: string | null; areaM2: number | null; efficiencyPct: number | null;
    kc: number | null; kcSource: string | null; capturedAt: string}};
export type ActiveCommand = {
  expectation_id: string;
  reconciliation_state: string;
  commanded_at: string;
  expected_close_at: string;
  duration_seconds: number;
  trigger: string;
  device_eui: string;
  zone_id?: number | null;
  flow_device_eui?: string | null;
  flow_rate_lpm?: number;
  generation: number;
  opened_at?: string;
  open_delay_ms: number;
};

export class SimulatorState {
  readonly mode: SimulatorMode;
  now: number;
  zones: IrrigationZone[];
  devices: Device[];
  activeCommands = new Map<string, ActiveCommand>();
  timedCloseHolds = new Map<string, {priorPercentage: number; generation: number; phase: 'PENDING_CLOSE' | 'HOLD'}>();
  schedules = new Map<string, ValvePlan[]>();
  valveSettings = new Map<string, {schedulerStatus: 'ACTIVE' | 'SKIP_TODAY' | 'DEACTIVATED'; skipTodayDate: string | null; defaultOpenMinutes: number; planGeneration: number; deliveredGeneration: number; planGenerationByDay: number[]; deliveredGenerationByDay: number[]; pushQueued: number; pushAcked: number; lastPlanQueuedAt: string | null; lastPlanAckedAt: string | null; clockSyncQueued: boolean; planPushes: Array<{purpose: 'WEEKDAY_PLAN' | 'DAYMASK_PLAN' | 'CLOCK_SYNC' | 'SCHEDULER_STATUS'; weekday: number | null; daymask: number | null; plan_hash: string | null; state: 'QUEUED' | 'ACKED' | 'SUPERSEDED'; queued_at: string; acked_at: string | null; generation: number}>}>();
  serviceActions: Array<Record<string, unknown>> = [];
  rules = new Map<number, IrrigationSchedule>();
  settings = {...createGatewayPreferences(), defaultTimezone: 'Africa/Kampala'};
  system: PublicSystemState = createSystemState();
  sessions: DemoSessionState = createSessionState();
  analysis: AnalysisState = createAnalysisState();
  history: HistoryState = createHistoryState();
  network: NetworkState = createNetworkState();
  ledger: IrrigationActuation[] = [];
  triggerEvaluations: TriggerEvaluation[] = [];
  nextZoneId = 3;
  commandId = 0;
  defaultOpenMinutes = 1;
  zoneCalibration = new Map<number, {measuredFlowRateLpm: number; measurementMethod: string | null}>();
  watermarkCalibrations = new Map<string, Record<string, unknown>>();
  weatherAssignments = new Map<string, number[]>();
  environmentRecords = new Map<string, RetainedEnvironmentRecord>();

  constructor(mode: SimulatorMode) {
    this.mode = mode;
    if (mode === 'presentation') Object.assign(this.settings, {
      dataModuleEnabled: false, networkModuleEnabled: false, gatewayHubModuleEnabled: false, journalModuleEnabled: false,
    });
    this.now = mode === 'public' ? PUBLIC_EPOCH : DEMO_EPOCH;
    this.zones = [zoneFixture(1, 'Tomato plot'), zoneFixture(2, 'Demonstration bed')];
    this.devices = seedDevices();
    this.devices.filter(device => device.type_id === 'KIWI_SENSOR').forEach(device => Object.assign(device, {temp_humidity_enabled: 1}));
    if (mode === 'public') {
      this.preparePublicSeed();
      this.devices.forEach(device => SimulatorState.initialisePublicDevice(device, PUBLIC_EPOCH, true));
      this.zones.forEach(zone => Object.assign(zone, {latitude: 0.3476, longitude: 32.5825,
        weather_source: 'auto', weather_source_default: 'open_meteo'}));
      this.zones.forEach(zone => { zone.created_at = iso(PUBLIC_EPOCH); zone.updated_at = iso(PUBLIC_EPOCH); });
      this.devices.forEach(device => { device.last_seen = iso(PUBLIC_EPOCH); });
    }
  }

  private preparePublicSeed(): void {
    this.zones.forEach(zone => { zone.schedule = null; });
    const first = this.devices.find(device => device.deveui === '00000000000000A1')!;
    const second = this.devices.find(device => device.deveui === '00000000000000A2')!;
    Object.assign(first.latest_data, {swt_1: 45, swt_2: 50, swt_3: 55});
    Object.assign(second.latest_data, {swt_1: 10, swt_2: 12, swt_3: 14});

    const firstValve = this.devices.find(device => device.type_id === 'STREGA_VALVE')!;
    this.devices.push({...structuredClone(firstValve), deveui: '00000000000000D2', name: 'Bed valve',
      irrigation_zone_id: 2, last_seen: iso(PUBLIC_EPOCH)});
    const dendro = {...structuredClone(this.devices.find(device => device.deveui === '00000000000000E2')!),
      deveui: '00000000000000E3', name: 'Bed dendrometer', dendro_enabled: 1,
      lsn50_mode: 'MOD3', lsn50_mode_code: 3,
      rain_gauge_enabled: 0, flow_meter_enabled: 0, temp_enabled: 1, chameleon_enabled: 1, irrigation_zone_id: 2,
      chameleon_array_id: 'SIM-CHAMELEON-KNOWN-01', chameleon_calibration_usable: true,
      chameleon_calibration_status: 'calibrated', calibration_status: 'calibrated' as const,
      chameleon_swt1_depth_cm: 10, chameleon_swt2_depth_cm: 20, chameleon_swt3_depth_cm: 40,
      latest_data: {ext_temperature_c: 24, bat_v: 3.7, adc_ch0v: 1.8, adc_ch1v: null,
        lsn50_mode_label: 'MOD3',
        chameleon_array_id: 'SIM-CHAMELEON-KNOWN-01',
        dendro_position_raw_mm: 12, dendro_position_mm: 12, dendro_valid: 1, dendro_delta_mm: 0,
        dendro_stem_change_um: 0, dendro_ratio: null, dendro_mode_used: 'legacy',
        dendro_saturated: 0, dendro_saturation_side: null, bat_pct: 90}} as Device & {chameleon_array_id: string};
    this.devices.push(dendro);
    const unlistedChameleon = {...structuredClone(dendro), deveui: '00000000000000E4', name: 'Unlisted Chameleon array', dendro_enabled: 0,
      chameleon_array_id: 'SIM-CHAMELEON-UNLISTED-01',
      chameleon_calibration_usable: false, chameleon_calibration_status: 'unknown', calibration_status: 'unknown' as const,
      latest_data: {...dendro.latest_data, chameleon_array_id: 'SIM-CHAMELEON-UNLISTED-01'}};
    this.devices.push(unlistedChameleon);
    // Internal fictional cohort selector for the custom Watermark demo frame; this is not a production MOD/FPort setting.
    const watermark = {...structuredClone(this.devices.find(device => device.deveui === '00000000000000E1')!),
      deveui: '00000000000000E5', name: 'Bed Watermark demonstration', irrigation_zone_id: 2,
      rain_gauge_enabled: 0, flow_meter_enabled: 0, chameleon_enabled: 0, dendro_enabled: 0,
      watermark_fixture: true, watermark_enabled: 1};
    this.devices.push(watermark);

    const extraFamilies: Array<[string, string, Device['type_id'], number | null]> = [
      ['00000000000000F1', 'Bed wireless soil probe', 'TEKTELIC_CLOVER', 2],
      ['00000000000000F2', 'Weather station', 'SENSECAP_S2120', 2],
      ['00000000000000F3', 'LoRain gauge', 'AQUASCOPE_LORAIN', 1],
      ['00000000000000F4', 'UC512 valve controller', 'MILESIGHT_UC512', 1],
      ['00000000000000F5', 'SDI-12 soil profile', 'DRAGINO_SDI12', 2],
      ['00000000000000F6', 'Field tester', 'RAK10701_FIELD_TESTER', null],
    ];
    for (const [eui, name, type, zoneId] of extraFamilies) {
      const device = makeDevice(eui, name, zoneId);
      device.type_id = type;
      if (type === 'SENSECAP_S2120') Object.assign(device.latest_data, {barometric_pressure_hpa: 1012,
        wind_speed_mps: 1.2, wind_direction_deg: 135, wind_gust_mps: 2.1, uv_index: 3, rain_gauge_cumulative_mm: 14.4});
      if (type === 'AQUASCOPE_LORAIN') Object.assign(device.latest_data, {rain_mm_today: 0, rain_mm_delta: 0, rain_gauge_cumulative_mm: 14.4});
      if (type === 'DRAGINO_SDI12') {
        Object.assign(device, {sdi12_probe_profile: 'GENERIC_VWC', sdi12_value_count: 3});
        Object.assign(device.latest_data, {vwc_1: 23, vwc_2: 25, vwc_3: 27});
      }
      this.devices.push(device);
    }
    const station = this.devices.find(device => device.deveui.endsWith('F2'));
    if (station) this.weatherAssignments.set(station.deveui, [1, 2]);
  }

  static initialisePublicDevice(device: Device, at: number, seed: boolean): void {
    const fields = device as Device & Record<string, unknown>;
    if (device.type_id !== 'KIWI_SENSOR') {
      delete device.soil_moisture_probe_depths_configured;
      delete device.soil_moisture_probe_depths_json;
    }
    fields.public_rain_baseline_at_ms = seed ? PUBLIC_EPOCH - 90 * 24 * 60 * 60 * 1000 : at - 90 * 24 * 60 * 60 * 1000;
    if (device.type_id === 'TEKTELIC_CLOVER') {
      const suppliedBattery = typeof device.latest_data.bat_pct === 'number' ? device.latest_data.bat_pct : seed ? null : 90;
      device.latest_data = suppliedBattery === null ? {} : {bat_pct: suppliedBattery};
    } else if (device.type_id === 'STREGA_VALVE') {
      fields.strega_generation ??= 'GEN1';
      fields.strega_model ??= 'STANDARD';
      device.current_state ??= 'CLOSED';
      device.latest_data = {valve_state: device.current_state === 'OPEN' ? 1 : 0,
        ...(typeof fields.strega_generation === 'string' && fields.strega_generation === 'GEN2' ? {bat_v: 3.6}
          : typeof device.latest_data.bat_pct === 'number' ? {bat_pct: device.latest_data.bat_pct} : {bat_pct: seed ? 94 : 90})} as unknown as Device['latest_data'];
    } else if (device.type_id === 'DRAGINO_LSN50') {
      fields.lsn50_mode ??= 'MOD9'; fields.lsn50_mode_code ??= 9; fields.device_mode ??= 9;
      fields.rain_gauge_enabled ??= 1; fields.flow_meter_enabled ??= 1; fields.temp_enabled ??= 0;
      fields.dendro_enabled ??= 0; fields.chameleon_enabled ??= 0;
      device.latest_data = {};
    } else if (device.type_id === 'SENSECAP_S2120') {
      device.latest_data = {};
    } else if (device.type_id === 'AQUASCOPE_LORAIN') {
      device.latest_data = {};
    } else if (device.type_id === 'MILESIGHT_UC512') {
      device.current_state = undefined;
      device.target_state = undefined;
      device.latest_data = {};
    } else if (device.type_id === 'DRAGINO_SDI12') {
      fields.sdi12_probe_profile = seed ? 'TENSIOMARK' : fields.sdi12_probe_profile ?? 'TENSIOMARK';
      fields.sdi12_probe_status ??= 'manual'; fields.sdi12_value_count = seed ? 2 : fields.sdi12_value_count ?? 2;
      const canonicalDepths = fields.sdi12_probe_profile === 'TENSIOMARK' ? {swt_1: 30, soil_temp_1: 30} : {};
      device.soil_moisture_probe_depths_json = canonicalDepths as Record<string, number>;
      device.soil_moisture_probe_depths_configured = Object.keys(canonicalDepths).length ? 1 : 0;
      fields.sdi12_depths_json ??= {1: 30};
      device.latest_data = {};
    } else if (device.type_id === 'RAK10701_FIELD_TESTER') {
      device.latest_data = {};
    }
    if (device.type_id === 'DRAGINO_LSN50' && fields.lsn50_mode === 'MOD3' && device.chameleon_enabled === 1) {
      device.calibration_status = fields.chameleon_calibration_status === 'calibrated' && fields.chameleon_calibration_usable === true
        ? 'calibrated' : 'unknown';
      fields.chameleon_swt1_depth_cm ??= 10; fields.chameleon_swt2_depth_cm ??= 20; fields.chameleon_swt3_depth_cm ??= 40;
    }
    device.latest_data = {...deviceValues(device, at), sampled_at: iso(at)} as Device['latest_data'];
  }

  reset(): void { const fresh = new SimulatorState(this.mode); Object.assign(this, fresh); }

  get activeActuation(): ActiveCommand | null {
    return this.activeCommands.values().next().value ?? null;
  }
}

export function makeDevice(eui: string, name: string, zoneId: number | null): Device {
  return sensorFixture(eui, name, zoneId);
}
