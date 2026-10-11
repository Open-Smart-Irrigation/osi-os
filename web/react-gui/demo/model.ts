import {sensorHistory} from './history';
import { normalizeEntityName } from '../src/utils/entityName';
import type { Device, IrrigationZone, IrrigationSchedule } from '../src/types/farming';
import type { IrrigationActuation, UpdateSystemSettingsRequest } from '../src/services/api';
import { DEMO_EPOCH, PUBLIC_EPOCH, VALVE_EUI, SPARE_EUI, environmentFixture, iso } from './fixtures';
import {SimulationClock, MAX_JUMP_MS} from './model/clock';
import {deviceValues, ReadingLedger, sampleIntervalMs, type ReadingValues} from './model/readings';
import {SimulatorState, makeDevice, type SimulatorMode, type ActiveCommand} from './model/state';
import {configureZone, createZone, deleteZone, normalizedName, renameZone} from './model/farm';
import {createDevice, DEVICE_CATALOG} from './model/devices';
import {dailyRainHistory, dendroDailyIndicators, dendroHistory, dendroRawReadings, sensorHistory as ledgerSensorHistory, zoneRecommendationEvidence} from './model/histories';
import {SDI12_PROFILES} from './model/sdi12-profiles';
import type {Sdi12RecipeDeployment} from '../src/types/farming';
import {convertWatermarkChannel} from './model/watermark';
import {handleIrrigationRoute, deviceValve, updateValveSettings, commandValve, cancelValveCommand, executeStregaServiceCommand, cancelTimedCloseHold, startValveActuation, closeValveActuation, type IrrigationDomainPort} from './model/irrigation';
import {compilePlans, handlePlanRoute, nextPlanRun, createValvePlan, updateValvePlan, deleteValvePlan, resendValvePlan, setValveSchedulerStatus, planPushState, planPushSummary, rescheduleSkipTodayRollover, type ValvePlan, type PlanDomainPort} from './model/plans';
import {evaluateAutomaticTriggers, selectDendroRecommendation, type DendroRecommendation, type TriggerDomainPort} from './model/triggers';
import {readSystemSettings, updateSystemSettings} from './model/preferences';
import {publicSystemFeatures, publicSystemStats, scheduleSimulatedRestart, setSimulatedFan} from './model/system';
import {diagnosticsPreview, listSupportRequests, submitSupportRequest} from './model/support';
import {forceLocalSync, linkLocalAccount, loginLocal, permissionDenied, recordPendingMutation, registerLocal, sessionProfile, setSessionUser, syncSummary, unlinkLocalAccount} from './model/sessions';
import {DemoError} from './errors';
import {createJournalState, handleJournalRoute, type JournalState} from './model/journal';
import {handleAnalysisRoute} from './model/analysis';
import {handleHistoryRoute} from './model/history';
import {buildEnvironmentSummary, hasValidWeatherLocation, seedCompletedEnvironmentRecords} from './model/environment';
import {resolveWaterAction} from './model/water-action';
import {netIrrigationMm} from './model/forcing';
import {handleNetworkRoute} from './model/network';
export { DEMO_EPOCH, PUBLIC_EPOCH, VALVE_EUI, SPARE_EUI };
export {DemoError};
export interface DemoResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}
type Body = Record<string, unknown>;
const fail = (status = 422, code = 'invalid', data?: unknown): never => { throw new DemoError(status, code, data); };
const MAX_KIWI_INTERVAL_MINUTES = 1440;
const MAX_LSN50_INTERVAL_MINUTES = Math.floor(0xffffff / 60);
const MAX_LSN50_5V_WARMUP_MS = 65535;
function isCanonicalPendingMutation(method: string, path: string): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  return path === '/api/irrigation-zones' || /^\/api\/irrigation-zones\/\d+(?:\/(?:name|config|calibration|location|devices\/[^/]+|schedule))?$/.test(path)
    || path === '/api/irrigation-zones/schedules/disable-all'
    || method === 'PUT' && /^\/api\/devices\/[^/]+\/(?:installation-location|radio-configuration)$/.test(path)
    || path === '/api/devices' || /^\/api\/devices\//.test(path)
    || /^\/api\/valves\/[^/]+\/(?:schedules(?:\/[^/]+)?|scheduler-status|plan\/resend)$/.test(path);
}
function isDeferredDeviceConfig(method: string, path: string): boolean {
  return (method === 'PUT' || method === 'POST') && /^\/api\/devices\/[^/]+\/(?:dendro|temp|rain-gauge|flow-meter|chameleon|kiwi\/interval|kiwi\/temperature-humidity\/enable|lsn50\/(?:mode|interval|interrupt-mode|5v-warmup)|chameleon\/depth|dendro-config|dendro-baseline\/reset)$/.test(path);
}
const CHAMELEON_CALIBRATION_FIXTURES = new Map<string, {sensorId: string}>([
  ['SIM-CHAMELEON-KNOWN-01', {sensorId: 'SIM-CHAMELEON-SENSOR-01'}],
]);
function chameleonFixture(arrayId: string): {sensorId: string} | undefined {
  const fixture = CHAMELEON_CALIBRATION_FIXTURES.get(arrayId);
  if (fixture) return fixture;
  const attached = arrayId.match(/^SIM-CHAMELEON-KNOWN-([0-9A-F]{16})$/);
  return attached ? {sensorId: `SIM-CHAMELEON-SENSOR-${attached[1]}`} : undefined;
}
function localDayStart(at: number, timezone: string): number {
  return localCalendarDayStart(localCalendarDate(at, timezone), timezone);
}
function localCalendarDate(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(at));
}
function shiftCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function localCalendarDayStart(localDate: string, timezone: string): number {
  const start = Date.parse(`${localDate}T00:00:00Z`) - 18 * 60 * 60 * 1000;
  const format = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  for (let time = start; time <= start + 48 * 60 * 60 * 1000; time += 60000) {
    const parts = Object.fromEntries(format.formatToParts(new Date(time)).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === localDate && parts.hour === '00' && parts.minute === '00') return time;
  }
  throw new RangeError(`Could not resolve local midnight for ${timezone}`);
}
function nameOf(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const result = normalizeEntityName(value);
  return result.ok ? result.name : fail(400, result.reason);
}
export class Simulator {
  active = true;
  speed = 1;
  readonly mode: SimulatorMode;
  readonly clock: SimulationClock;
  state: SimulatorState;
  readings: ReadingLedger;
  private journal: JournalState = createJournalState();
  private lastIntegratedAt = new Map<string, number>();
  private waterGeometryByCommand = new Map<string, {zoneId: number | null; areaM2: number | null; efficiency: number | null}>();
  private flowByZone = new Map<number, number>();
  private flowByCommand = new Map<string, number>();
  private pendingFlowByMeter = new Map<string, {liters: number; today: number}>();
  private presentationWaterSeed = new Map<string, {rain_mm_today?: number | null; flow_liters_today?: number | null}>();
  onDailyTrigger?: (at: number) => void;
  constructor(options: {mode?: SimulatorMode} = {}) {
    this.mode = options.mode ?? 'presentation';
    this.state = new SimulatorState(this.mode);
    if (this.mode === 'presentation') for (const device of this.state.devices) {
      this.presentationWaterSeed.set(device.deveui, {rain_mm_today: device.latest_data.rain_mm_today, flow_liters_today: device.latest_data.flow_liters_today});
    }
    this.clock = new SimulationClock(this.state.now);
    this.readings = new ReadingLedger(this.state.devices, this.mode === 'public', device => ({
      timezone: this.rainTimezone(device), timezoneBasis: this.rainTimezoneBasis(device)}));
    if (this.mode === 'public') seedCompletedEnvironmentRecords(this.zones, this.now, this.state.settings.gatewayTimezone, this.state.environmentRecords);
    if (this.mode === 'public') this.syncSeedSnapshots();
    if (this.mode === 'public') {
      this.onDailyTrigger = at => evaluateAutomaticTriggers(this.triggerPort(at), at);
      this.setupPublicClock();
    }
  }
  get now() { return this.clock.now; }
  get zones() { return this.state.zones; }
  set zones(value: IrrigationZone[]) { this.state.zones = value; }
  get devices() { return this.state.devices; }
  set devices(value: Device[]) { this.state.devices = value; }
  get actuation() { return this.state.activeActuation; }
  set actuation(value: ActiveCommand | null) {
    if (value === null) this.state.activeCommands.clear();
    if (value) this.state.activeCommands.set(value.device_eui, value);
  }
  get outcomes() { return this.state.ledger; }
  set outcomes(value: IrrigationActuation[]) { this.state.ledger = value; }
  get defaultOpenMinutes() { return this.state.defaultOpenMinutes; }
  set defaultOpenMinutes(value: number) { this.state.defaultOpenMinutes = value; }
  setSessionUser(username: string | null): void { setSessionUser(this.state.sessions, username); }
  recordPublicPendingMutation(): void {
    if (this.mode === 'public') recordPendingMutation(this.state.sessions);
  }
  private canonicalMutationSnapshot(): string {
    const entries = <K extends number | string, T>(map: Map<K, T>) => [...map.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
    return JSON.stringify([this.zones, this.devices, entries(this.state.schedules), entries(this.state.rules),
      entries(this.state.zoneCalibration), entries(this.state.watermarkCalibrations), entries(this.state.valveSettings), entries(this.state.weatherAssignments),
      entries(this.state.network.locations), entries(this.state.network.radios)]);
  }
  private setupPublicClock() {
    this.devices.forEach(device => this.scheduleSample(device.deveui, this.now + this.intervalFor(device)));
    this.scheduleDailyTrigger(this.nextDailyTriggerAt());
  }
  private intervalFor(device: Device): number {
    const fields = device as Device & Record<string, unknown>;
    const interval = device.type_id === 'STREGA_VALVE'
      ? Number(fields.strega_uplink_interval_closed_minutes)
      : Number(fields.uplink_interval_minutes ?? (fields.temp_humidity_enabled === 1 ? fields.temp_humidity_interval_minutes : undefined));
    return Number.isInteger(interval) && interval > 0 ? interval * 60_000 : sampleIntervalMs();
  }
  private scheduleSample(eui: string, at: number) {
    for (const pending of this.clock.ids()) if (pending.startsWith(`sample:${eui}:`)) this.clock.cancel(pending);
    const entity = `sampling:${eui}`, generation = this.clock.generation(entity);
    this.clock.schedule(at, () => {
      const device = this.devices.find(d => d.deveui === eui);
      if (!device) return;
      if (device.type_id !== 'STREGA_VALVE') for (const command of this.state.activeCommands.values()) this.integrateFlow(command, at);
      this.flushPendingFlowReports(at);
      const alreadyObserved = this.readings.latestSample(eui);
      const values = alreadyObserved?.at === at ? alreadyObserved.values :
        this.withDailyWaterTotals(device, this.readings.sampleValues(device, at, this.rainTimezone(device),
          this.rainTimezoneBasis(device)), at);
      if (alreadyObserved?.at !== at) this.readings.append(eui, at, values);
      const merged = this.readings.latestSample(eui);
      device.latest_data = {...(merged?.values ?? values), sampled_at: iso(merged?.at ?? at)} as typeof device.latest_data;
      if (device.type_id === 'DRAGINO_LSN50' && typeof values.calibration_status === 'string') {
        device.calibration_status = values.calibration_status as Device['calibration_status'];
      }
      device.last_seen = iso(at);
      this.scheduleSample(eui, at + this.intervalFor(device));
    }, {id: `sample:${eui}:${at}`, meaningful: false, entity, generation, priority: 4});
  }
  private applyDeviceConfig(device: Device, key: string, patch: Record<string, unknown>, delayMs = 2000): void {
    const entity = `device-config:${device.deveui}:${key}`;
    const generation = this.clock.invalidate(entity);
    this.clock.schedule(this.now + delayMs, () => {
      const current = this.devices.find(row => row.deveui === device.deveui);
      if (!current) return;
      const changed = Object.entries(patch).some(([field, value]) => {
        const currentValue = (current as Device & Record<string, unknown>)[field];
        return !Object.is(currentValue, value) && JSON.stringify(currentValue) !== JSON.stringify(value);
      });
      if (!changed) return;
      Object.assign(current, patch);
      if (current.type_id === 'DRAGINO_LSN50' && (key === 'chameleon' || key === 'lsn50-mode')) {
        const fields = current as Device & Record<string, unknown>;
        const mode = Number(String(fields.lsn50_mode ?? '').replace('MOD', '')) || Number(fields.device_mode) || 9;
        if (mode === 3 && current.chameleon_enabled === 1) {
          if (!fields.chameleon_array_id) {
            fields.chameleon_array_id = `SIM-CHAMELEON-KNOWN-${current.deveui}`;
            fields.chameleon_calibration_usable = true;
            fields.chameleon_calibration_status = 'calibrated';
            fields.chameleon_swt1_depth_cm ??= 10; fields.chameleon_swt2_depth_cm ??= 20; fields.chameleon_swt3_depth_cm ??= 40;
          }
          current.calibration_status = fields.chameleon_calibration_usable === true ? 'calibrated' : 'unknown';
        } else {
          const latest = {...current.latest_data} as Record<string, unknown>;
          for (const field of ['swt_1','swt_2','swt_3','soil_temp_c','calibration_status','adc_ch0v','adc_ch1v']) delete latest[field];
          current.latest_data = latest;
        }
      }
      this.recordPublicPendingMutation();
      if ('uplink_interval_minutes' in patch) {
        this.clock.invalidate(`sampling:${device.deveui}`);
        this.scheduleSample(device.deveui, this.now + this.intervalFor(current));
      }
    }, {id: `${key}-ack:${device.deveui}:${this.now}:${generation}`, meaningful: true, priority: 3, entity, generation});
  }
  private syncSeedSnapshots() {
    for (const device of this.devices) {
      const sample = this.readings.latestSample(device.deveui);
      if (sample) device.latest_data = {...sample.values, sampled_at: iso(sample.at)} as typeof device.latest_data;
    }
  }
  private rainTimezone(device: Device): string {
    if (device.type_id === 'SENSECAP_S2120') {
      const zoneId = (this.state.weatherAssignments.get(device.deveui) ?? [])[0];
      const zone = this.zones.find(row => row.id === zoneId);
      return zone?.timezone ?? 'UTC';
    }
    return this.zones.find(row => row.id === device.irrigation_zone_id)?.timezone ?? 'UTC';
  }
  private rainTimezoneBasis(device: Device): string {
    if (device.type_id === 'SENSECAP_S2120') {
      return (this.state.weatherAssignments.get(device.deveui)?.length ?? 0) > 0 ? 'weather_station_zone' : 'unassigned_default';
    }
    return device.irrigation_zone_id == null ? 'unassigned_default' : 'zone';
  }
  private withDailyWaterTotals(device: Device, values: ReadingValues, at: number): ReadingValues {
    if (device.type_id !== 'DRAGINO_LSN50') return values;
    const from = localDayStart(at, this.rainTimezone(device));
    const totals: ReadingValues = {};
    if ('rain_mm_delta' in values) totals.rain_mm_today = typeof values.rain_mm_delta === 'number'
      ? Number(((this.readings.aggregate(device.deveui, 'rain_mm_delta', from, at - 1) ?? 0) + values.rain_mm_delta).toFixed(3)) : null;
    if ('flow_liters_delta' in values) totals.flow_liters_today = Number(((this.readings.aggregate(device.deveui, 'flow_liters_delta', from, at - 1) ?? 0) +
      (typeof values.flow_liters_delta === 'number' ? values.flow_liters_delta : 0)).toFixed(2));
    return {...values, ...totals};
  }
  private scheduleDailyTrigger(at: number) {
    if (at > this.now + MAX_JUMP_MS || !this.zones.some(zone => zone.schedule?.enabled)) return;
    const id = `daily-trigger:${at}`;
    this.clock.schedule(at, () => { this.onDailyTrigger?.(this.now); this.refreshDailyTrigger(); },
      {id, meaningful: true, priority: 7});
  }
  private refreshDailyTrigger() {
    for (const event of this.clockEventsByPrefix('daily-trigger:')) this.clock.cancel(event);
    if (this.zones.some(zone => zone.schedule?.enabled)) this.scheduleDailyTrigger(this.nextDailyTriggerAt());
  }
  private nextDailyTriggerAt(): number {
    const timezone = this.state.settings.gatewayTimezone;
    const formatter = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    const start = Math.floor(this.now / 60000) * 60000 + 60000;
    for (let at = start; at <= this.now + 48 * 60 * 60 * 1000; at += 60000) {
      const parts = formatter.formatToParts(new Date(at));
      if (parts.find(part => part.type === 'hour')?.value === '06' && parts.find(part => part.type === 'minute')?.value === '00') return at;
    }
    return this.now + 24 * 60 * 60 * 1000;
  }
  setGatewayTimezone(timezone: string): void {
    new Intl.DateTimeFormat('en', {timeZone: timezone});
    this.state.settings.gatewayTimezone = timezone;
    this.refreshDailyTrigger();
    for (const device of this.devices) if (device.type_id === 'STREGA_VALVE') rescheduleSkipTodayRollover(this.planPort(), device.deveui);
  }
  private saveSystemSettings(body: UpdateSystemSettingsRequest) {
    try {
      if (this.mode === 'public') seedCompletedEnvironmentRecords(this.zones, this.now, this.state.settings.gatewayTimezone, this.state.environmentRecords);
      const previousTimezone = this.state.settings.gatewayTimezone;
      const update = updateSystemSettings(this.state.settings, this.zones, body, iso(this.now));
      Object.assign(this.state.settings, update.settings);
      if (update.settings.gatewayTimezone !== previousTimezone) this.setGatewayTimezone(update.settings.gatewayTimezone);
      else if (update.zonesChanged) {
        for (const device of this.devices) if (device.type_id === 'STREGA_VALVE') rescheduleSkipTodayRollover(this.planPort(), device.deveui);
      }
      return update.result;
    } catch (error) {
      const status = Number((error as {status?: number}).status ?? 422);
      const code = String((error as {code?: string}).code ?? (error as Error).message ?? 'invalid');
      return fail(status, code, {error: code, message: (error as Error).message ?? code});
    }
  }
  private clockEventsByPrefix(prefix: string): string[] {
    return this.clock.ids().filter(id => id.startsWith(prefix));
  }
  removeDevice(eui: string): void {
    cancelTimedCloseHold(this.irrigationPort(), eui);
    this.clock.invalidate(`device:${eui}`);
    this.clock.invalidate(`sampling:${eui}`);
    for (const plan of this.valvePlanRows(eui)) this.clock.invalidate(`plan:${plan.schedule_uuid}`);
    this.state.schedules.delete(eui);
    this.state.valveSettings.delete(eui);
    for (const key of ['uplink','temperature-humidity','lsn50-mode','interrupt-mode','5v-warmup','chameleon-depth','dendro-config','dendro-baseline','chameleon-calibration','dendro','temp','rain-gauge','flow-meter','chameleon']) {
      this.clock.invalidate(`device-config:${eui}:${key}`);
    }
    for (const id of this.clock.ids()) if (id.includes(eui)) this.clock.cancel(id);
    const command = this.state.activeCommands.get(eui);
    if (command) {
      const valve = this.devices.find(device => device.deveui === eui);
      if (valve?.current_state === 'OPEN') this.integrateFlow(command, this.now);
      this.flushPendingFlowReports(this.now);
      if (valve) { valve.current_state = 'CLOSED'; valve.target_state = 'CLOSED'; }
      this.clock.invalidate(`actuation:${eui}`);
      const outcome = this.outcomes.find(item => item.expectationId === command.expectation_id);
      if (outcome) Object.assign(outcome, {status: 'CANCELLED', reconciliationState: 'CANCELLED', cancelReason: 'device_removed', observedCloseAt: command.opened_at ? iso(this.now) : null});
      this.afterActuationClosed(command, valve);
      this.state.activeCommands.delete(eui);
    }
    this.devices = this.devices.filter(device => device.deveui !== eui);
  }
  reset() {
    this.active = true; this.speed = 1;
    this.state = new SimulatorState(this.mode);
    this.journal = createJournalState();
    this.clock.reset(this.state.now);
    this.readings = new ReadingLedger(this.devices, this.mode === 'public', device => ({
      timezone: this.rainTimezone(device), timezoneBasis: this.rainTimezoneBasis(device)}));
    if (this.mode === 'public') seedCompletedEnvironmentRecords(this.zones, this.now, this.state.settings.gatewayTimezone, this.state.environmentRecords);
    if (this.mode === 'public') this.syncSeedSnapshots();
    this.lastIntegratedAt.clear(); this.flowByZone.clear(); this.flowByCommand.clear(); this.pendingFlowByMeter.clear();
    this.waterGeometryByCommand.clear();
    if (this.mode === 'public') this.setupPublicClock();
  }
  advance(realMilliseconds: number): boolean {
    if (!this.active || !Number.isFinite(realMilliseconds) || realMilliseconds <= 0) return false;
    const before = this.clock.revision;
    this.clock.advanceTo(this.now + realMilliseconds * this.speed);
    if (this.mode === 'public') seedCompletedEnvironmentRecords(this.zones, this.now, this.state.settings.gatewayTimezone, this.state.environmentRecords);
    return this.clock.revision !== before;
  }
  advanceTo(targetMs: number) {
    this.clock.advanceTo(targetMs);
    if (this.mode === 'public') seedCompletedEnvironmentRecords(this.zones, this.now, this.state.settings.gatewayTimezone, this.state.environmentRecords);
  }
  jumpToNextEvent(): boolean {
    const at = this.clock.nextEventAt(MAX_JUMP_MS);
    if (at === null) return false;
    this.advanceTo(at);
    return true;
  }
  private valve(eui = VALVE_EUI) { return this.devices.find(d => d.deveui === eui)!; }
  close(status: 'COMPLETED' | 'CANCELLED', eui?: string) {
    closeValveActuation(this.irrigationPort(), status, eui);
  }
  private afterActuationClosed(command: ActiveCommand, valve: Device | undefined) {
    void valve;
    this.flushPendingFlowReports(this.now);
    this.lastIntegratedAt.delete(command.expectation_id);
    this.waterGeometryByCommand.delete(command.expectation_id);
  }
  private integrateFlow(command: ActiveCommand, until: number) {
    const valve = this.devices.find(d => d.deveui === command.device_eui);
    if (valve?.current_state !== 'OPEN') return;
    const from = this.lastIntegratedAt.get(command.expectation_id) ?? until;
    const flowRateLpm = command.flow_rate_lpm ?? 6;
    const openness = Number((valve as Device & Record<string, unknown>).valve_opening_percent ?? 100);
    const liters = Math.max(0, (until - from) / 60000 * flowRateLpm * openness / 100);
    this.lastIntegratedAt.set(command.expectation_id, until);
    if (!liters) return;
    const capturedGeometry = this.waterGeometryByCommand.get(command.expectation_id);
    const zoneId = capturedGeometry ? capturedGeometry.zoneId : command.zone_id ?? valve.irrigation_zone_id ?? null;
    const flow = zoneId == null ? undefined : this.flowSourceForZone(zoneId);
    const zone = this.zones.find(item => item.id === zoneId);
    const areaM2 = capturedGeometry?.areaM2 ?? null;
    const efficiency = capturedGeometry?.efficiency ?? null;
    for (let segmentStart = from; segmentStart < until;) {
      const segmentEnd = Math.min(until, segmentStart + 60000);
      const segmentLiters = Math.max(0, (segmentEnd - segmentStart) / 60000 * flowRateLpm * openness / 100);
      if (segmentLiters > 0) this.readings.recordDeliveredWater({eventId: `delivery:${command.expectation_id}:${segmentStart}`,
        zoneId: String(zoneId ?? `device:${command.device_eui}`), installationId: `zone:${zoneId ?? `device:${command.device_eui}`}`,
        atMs: segmentStart, rainMm: 0, deliveredLiters: segmentLiters,
        areaM2, efficiency});
      segmentStart = segmentEnd;
    }
    const dayStart = localDayStart(until, this.state.settings.gatewayTimezone);
    const flowZoneKey = zoneId ?? -1;
    const flowPending = flow ? this.pendingFlowByMeter.get(flow.deveui) : undefined;
    const total = flow ? (this.readings.aggregate(flow.deveui, 'flow_liters_delta', dayStart, until) ?? 0) +
      (flowPending?.liters ?? 0) + liters
      : (this.flowByZone.get(flowZoneKey) ?? 0) + liters;
    this.flowByZone.set(flowZoneKey, total);
    this.flowByCommand.set(command.expectation_id, (this.flowByCommand.get(command.expectation_id) ?? 0) + liters);
    const actuationOutcome = this.outcomes.find(entry => entry.expectationId === command.expectation_id);
    if (actuationOutcome) Object.assign(actuationOutcome, {
      estimatedGrossLiters: Number((this.flowByCommand.get(command.expectation_id) ?? 0).toFixed(2)), flowRateLpm,
    });
    if (zone) Object.assign(zone, {daily_volume_liters: Number(total.toFixed(2))});
    if (flow) {
      if (this.mode === 'public') {
        const pending = this.pendingFlowByMeter.get(flow.deveui) ?? {liters: 0, today: total};
        this.pendingFlowByMeter.set(flow.deveui, {liters: pending.liters + liters, today: total});
      } else {
        flow.latest_data.flow_liters_delta = Number(liters.toFixed(2));
        flow.latest_data.flow_liters_today = Number(total.toFixed(2));
      }
    }
  }
  private flushPendingFlowReports(at: number) {
    for (const command of this.state.activeCommands.values()) this.integrateFlow(command, at);
    for (const [eui, pending] of this.pendingFlowByMeter) {
      const flow = this.devices.find(device => device.deveui === eui);
      if (!flow) continue;
      const values = this.readings.observedFlowValues(flow, at, pending.liters, pending.today,
        this.rainTimezone(flow), this.rainTimezoneBasis(flow));
      this.readings.append(eui, at, values, 'observed-flow');
      const latest = this.readings.latestSample(eui);
      if (latest) {
        flow.latest_data = {...flow.latest_data, ...latest.values, sampled_at: iso(latest.at)} as Device['latest_data'];
        flow.last_seen = iso(latest.at);
      }
    }
    this.pendingFlowByMeter.clear();
  }
  private publicWaterDays(zoneId: number, timezone: string) {
    const rain = this.rainSourceForZone(zoneId);
    const flow = this.devices.find(device => device.irrigation_zone_id === zoneId && device.flow_meter_enabled === 1);
    const currentDate = localCalendarDate(this.now, timezone);
    return Array.from({length: 7}, (_, index) => {
      const date = shiftCalendarDate(currentDate, index - 6);
      const start = localCalendarDayStart(date, timezone);
      const nextDayStart = localCalendarDayStart(shiftCalendarDate(date, 1), timezone);
      const end = index === 6 ? this.now : nextDayStart - 1;
      const rainMm = rain ? this.readings.aggregate(rain.deveui, 'rain_mm_delta', start, end) : null;
      const liters = flow ? this.readings.aggregate(flow.deveui, 'flow_liters_delta', start, end) : null;
      const zone = this.zones.find(item => item.id === zoneId);
      const areaValue = zone?.area_m2, efficiencyValue = zone?.irrigation_efficiency_pct;
      const areaM2 = typeof areaValue === 'number' && Number.isFinite(areaValue) ? areaValue : null;
      const efficiencyPct = typeof efficiencyValue === 'number' && Number.isFinite(efficiencyValue) ? efficiencyValue : null;
      const netMm = liters === null || areaM2 === null || efficiencyPct === null
        ? null : Number((netIrrigationMm(liters, areaM2, efficiencyPct / 100) ?? 0).toFixed(2));
      return {date, rainMm, irrigationLiters: liters, measuredIrrigationLiters: liters,
        irrigationNetMm: netMm, measuredIrrigationNetMm: netMm,
        totalWaterMm: rainMm == null || netMm == null ? null : Number((rainMm + netMm).toFixed(2))};
    });
  }
  private weatherStationForZone(zoneId: number): Device | undefined {
    return this.devices.find(device => device.type_id === 'SENSECAP_S2120' && (this.state.weatherAssignments.get(device.deveui) ?? []).includes(zoneId));
  }
  private rainSourceForZone(zoneId: number): Device | undefined {
    const station = this.weatherStationForZone(zoneId);
    if (station) return station;
    return this.devices.find(device => device.type_id === 'DRAGINO_LSN50' && device.irrigation_zone_id === zoneId &&
      device.rain_gauge_enabled === 1 && Number((device as Device & Record<string, unknown>).device_mode ??
        (device as Device & Record<string, unknown>).lsn50_mode_code ?? 9) === 9);
  }
  private flowSourceForZone(zoneId: number): Device | undefined {
    return this.devices.find(device => device.type_id === 'DRAGINO_LSN50' && device.irrigation_zone_id === zoneId &&
      device.flow_meter_enabled === 1 && Number((device as Device & Record<string, unknown>).device_mode ?? (device as Device & Record<string, unknown>).lsn50_mode_code ?? 9) === 9);
  }
  private planRuntime(eui: string) {
    let runtime = this.state.valveSettings.get(eui);
    if (!runtime) {
      runtime = {schedulerStatus: 'ACTIVE', skipTodayDate: null, defaultOpenMinutes: this.state.defaultOpenMinutes, planGeneration: 0, deliveredGeneration: 0,
        planGenerationByDay: Array(7).fill(0), deliveredGenerationByDay: Array(7).fill(0),
        pushQueued: 0, pushAcked: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null, clockSyncQueued: false, planPushes: []};
      this.state.valveSettings.set(eui, runtime);
    }
    return runtime;
  }
  private valvePlanRows(eui: string): ValvePlan[] { return this.state.schedules.get(eui) ?? []; }
  private planSnapshot(eui: string) {
    const valve = deviceValve(this.devices, eui, fail);
    const plans = this.valvePlanRows(eui).filter(plan => !plan.deleted_at);
    const runtime = this.planRuntime(eui);
    const compiled = compilePlans(plans);
    const calibration = this.state.zoneCalibration.get(valve.irrigation_zone_id ?? -1);
    const valveFields = valve as Device & Record<string, unknown>;
    const hasFlowRateOverride = Object.prototype.hasOwnProperty.call(valveFields, 'flow_rate_lpm');
    const flowRate = hasFlowRateOverride ? valveFields.flow_rate_lpm : Number(calibration?.measuredFlowRateLpm ?? this.zones.find(zone => zone.id === valve.irrigation_zone_id)?.measured_flow_rate_lpm ?? 6);
    const flowRateSource = Object.prototype.hasOwnProperty.call(valveFields, 'flow_rate_source')
      ? valveFields.flow_rate_source : calibration ? 'measured' : 'estimated';
    return {schedules: plans.map(({deleted_at: _deleted, generation: _generation, ...plan}) => plan),
      compiled: {days: compiled.days.map(day => day.map(({startMin: _start, endMin: _end, ...window}) => window)), errors: compiled.errors},
      timezone: this.zones.find(zone => zone.id === valve.irrigation_zone_id)?.timezone ?? this.state.settings.gatewayTimezone,
      push_state: planPushState(this.planPort(), eui),
      scheduler_status: runtime.schedulerStatus,
      settings: {strega_generation: valveFields.strega_generation ?? 'GEN1', flow_rate_lpm: flowRate,
        flow_rate_source: flowRateSource, default_open_minutes: runtime.defaultOpenMinutes}};
  }
  startActuation(eui: string, duration: number, trigger: IrrigationActuation['trigger'], openDelayMs: number, autoClose: boolean, planId?: string): boolean {
    return startValveActuation(this.irrigationPort(), eui, duration, trigger, openDelayMs, autoClose, planId);
  }
  private valveSettings(eui: string, body: Body) {
    if (this.mode !== 'public') return fail(501, 'unsupported');
    return updateValveSettings(this.irrigationPort(), eui, body, fail);
  }
  private valveCommand(eui: string, body: Body) {
    return commandValve(this.irrigationPort(), eui, body, fail);
  }
  private cancelValve(eui: string, body: Body) {
    return cancelValveCommand(this.irrigationPort(), eui, body, fail);
  }
  private serviceCommand(eui: string, action: string, body: Body) {
    return executeStregaServiceCommand(this.irrigationPort(), eui, action, body, fail);
  }
  private irrigationPort(): IrrigationDomainPort {
    return {state: this.state, clock: this.clock, mode: this.mode, now: () => this.now, devices: this.devices, zones: this.zones,
      defaultOpenMinutes: eui => this.planRuntime(eui).defaultOpenMinutes,
      setDefaultOpenMinutes: (eui, value) => { this.planRuntime(eui).defaultOpenMinutes = value; }, outcomes: this.outcomes,
      flowRateForValve: valve => {
        const fields = valve as Device & Record<string, unknown>;
        const calibration = valve.irrigation_zone_id == null ? null : this.state.zoneCalibration.get(valve.irrigation_zone_id);
        const zone = this.zones.find(row => row.id === valve.irrigation_zone_id);
        return Number(fields.flow_rate_lpm ?? calibration?.measuredFlowRateLpm ?? zone?.measured_flow_rate_lpm ?? 6);
      },
      flowDeviceForZone: zoneId => zoneId == null ? undefined : this.flowSourceForZone(zoneId),
      markFlowStarted: (command, at) => {
        this.lastIntegratedAt.set(command.expectation_id, at);
        const zoneId = command.zone_id ?? null;
        const zone = this.zones.find(row => row.id === zoneId);
        const areaValue = zone?.area_m2, efficiencyValue = zone?.irrigation_efficiency_pct;
        const area = typeof areaValue === 'number' && Number.isFinite(areaValue) ? areaValue : null;
        const efficiencyPct = typeof efficiencyValue === 'number' && Number.isFinite(efficiencyValue) ? efficiencyValue : null;
        this.waterGeometryByCommand.set(command.expectation_id, {
          zoneId,
          areaM2: area !== null && area > 0 ? area : null,
          efficiency: efficiencyPct !== null && efficiencyPct >= 0 && efficiencyPct <= 100 ? efficiencyPct / 100 : null,
        });
      },
      afterActuationClosed: (command, valve) => this.afterActuationClosed(command, valve),
      recordPendingMutation: () => this.recordPublicPendingMutation(),
      startActuation: (eui, duration, trigger, delay, autoClose, planId) => startValveActuation(this.irrigationPort(), eui, duration, trigger, delay, autoClose, planId),
      close: (status, eui) => closeValveActuation(this.irrigationPort(), status, eui),
      cancelTimedCloseHold: eui => cancelTimedCloseHold(this.irrigationPort(), eui),
      integrateFlow: (command, until) => this.integrateFlow(command, until),
      finishServiceAction: (eui, action) => this.finishServiceAction(eui, action)};
  }
  private triggerPort(at: number): TriggerDomainPort {
    return {state: this.state, clock: this.clock, now: at, zones: this.zones, devices: this.devices, readings: this.readings,
      evaluations: this.state.triggerEvaluations,
      startActuation: (eui, duration, trigger, delay, autoClose, ruleId) => startValveActuation(this.irrigationPort(), eui, duration, trigger, delay, autoClose, ruleId),
      dendroCandidate: (zoneId, now) => {
        const evidence = this.dendroRecommendationEvidence(zoneId, now);
        return {recommendation: evidence.recommendation, stale: evidence.stale};
      }};
  }
  private dendroRecommendationEvidence(zoneId: number, now: number) {
    const zone = this.zones.find(item => item.id === zoneId);
    if (!zone) return {recommendation: null, stale: false, date: null as string | null};
    const selected = zoneRecommendationEvidence(zoneId, this.devices, this.readings, now, 14,
      zone.timezone ?? this.state.settings.gatewayTimezone, this.rainSourceForZone(zoneId), this.flowSourceForZone(zoneId));
    const row = selected.recommendation;
    if (!row || selected.latestMeasurementAt === null || selected.stale) return {recommendation: null, stale: selected.stale, date: null};
    const local: DendroRecommendation = {source: 'local', irrigation_action: row.irrigation_action,
      zone_stress_summary: row.zone_stress_summary, computed_at: iso(selected.latestMeasurementAt),
      action_reasoning: row.action_reasoning, rainfall_mm: row.rainfall_mm, water_delivered_liters: row.water_delivered_liters,
      rain_suppression_active: row.rain_suppression_active, recovery_verification_active: row.recovery_verification_active,
      low_confidence_tree_count: row.low_confidence_tree_count, zone_confidence_score: row.zone_confidence_score};
    return {recommendation: selectDendroRecommendation(null, local, now), stale: selected.stale, date: row.date};
  }
  private publicWaterAction(zoneId: number, summary: ReturnType<typeof buildEnvironmentSummary>) {
    const selected = this.dendroRecommendationEvidence(zoneId, this.now);
    const row = selected.recommendation;
    return resolveWaterAction(summary.water.todayDate ?? localCalendarDate(this.now,
      this.zones.find(zone => zone.id === zoneId)?.timezone ?? this.state.settings.gatewayTimezone),
    row ? {date: selected.date ?? undefined, irrigation_action: row.irrigation_action, action_reasoning: row.action_reasoning} : null,
    summary.water.balanceTodayMm, summary.water.next24hRainMm, summary.water.waterNeededTodayMm);
  }
  private finishServiceAction(eui: string, action: string) {
    const record = this.state.serviceActions.find(item => item.device_eui === eui && item.action === action && item.status === 'PENDING');
    if (record) Object.assign(record, {status: 'ACKED', acknowledged_at: iso(this.now)});
    if (action === 'interval') {
      const device = this.devices.find(row => row.deveui === eui);
      if (device) {
        this.clock.invalidate(`sampling:${eui}`);
        this.scheduleSample(eui, this.now + this.intervalFor(device));
      }
    }
  }
  private planRoute(method: string, path: string, body: Body) {
    const host = {
      planSnapshot: (eui: string) => this.planSnapshot(eui),
      createPlan: (eui: string, value: Body) => this.createPlan(eui, value),
      updatePlan: (eui: string, id: string, value: Body) => this.updatePlan(eui, id, value),
      deletePlan: (eui: string, id: string) => this.deletePlan(eui, id),
      resendPlan: (eui: string) => this.resendPlan(eui),
      setSchedulerStatus: (eui: string, status: unknown) => this.setSchedulerStatus(eui, status),
    };
    return handlePlanRoute(host, method, path, body);
  }
  private createPlan(eui: string, body: Body) {
    return createValvePlan(this.planPort(), eui, body);
  }
  private updatePlan(eui: string, id: string, body: Body) {
    return updateValvePlan(this.planPort(), eui, id, body);
  }
  private deletePlan(eui: string, id: string) {
    return deleteValvePlan(this.planPort(), eui, id);
  }
  private resendPlan(eui: string) {
    return resendValvePlan(this.planPort(), eui);
  }
  private setSchedulerStatus(eui: string, statusValue: unknown) {
    return setValveSchedulerStatus(this.planPort(), eui, statusValue);
  }
  private planPort(): PlanDomainPort {
    return {state: this.state, clock: this.clock, now: () => this.now, devices: this.devices, zones: this.zones,
      fail, outcomes: this.outcomes,
      startActuation: (eui, duration, trigger, delay, autoClose, planId) => startValveActuation(this.irrigationPort(), eui, duration, trigger, delay, autoClose, planId),
      close: (status, eui) => closeValveActuation(this.irrigationPort(), status, eui),
      planRuntime: eui => this.planRuntime(eui), planSnapshot: eui => this.planSnapshot(eui)};
  }
  request(method: string, path: string, body: unknown = {}): unknown {
    // Preserve the original data-only helper's JSON-string convenience. The real Axios
    // adapter already decodes JSON media types and must not parse text/plain a second time.
    const response = this.requestResponse(method, path, this.decodeJsonBody(body));
    if (response.status < 200 || response.status >= 300) {
      const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
      const code = typeof data.error === 'string' ? data.error : 'request_failed';
      throw new DemoError(response.status, code, response.data, response.headers);
    }
    return response.data;
  }
  requestResponse(method: string, path: string, body: unknown = {}): DemoResponse {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return fail(403, 'blocked');
    const url = new URL(path, 'http://demo.invalid');
    if (url.origin !== 'http://demo.invalid') return fail(403, 'blocked');
    this.clock.advanceTo(this.now);
    const wireMethod = method.toUpperCase();
    const trackMutation = this.mode === 'public' && !isDeferredDeviceConfig(wireMethod, url.pathname)
      && isCanonicalPendingMutation(wireMethod, url.pathname);
    const beforeMutation = trackMutation ? this.canonicalMutationSnapshot() : null;
    // Return snapshots: React/SWR must not hold references mutated by the model.
    try {
      const bodyObject = this.requireObjectBody(body);
      const historyRoute = this.mode === 'public' && url.pathname.startsWith('/api/history/')
        ? handleHistoryRoute(this.state.history, {zones: this.zones, devices: this.devices, ledger: this.readings,
          outcomes: this.outcomes, now: this.now,
          gatewayTimezone: this.state.settings.gatewayTimezone, environmentRecords: this.state.environmentRecords,
          gatewayStats: publicSystemStats(this.state.system, this.now) as unknown as Record<string, unknown>}, wireMethod, url, bodyObject)
        : {handled: false as const};
      const networkRoute = this.mode === 'public' && (url.pathname.startsWith('/api/network/') || /\/api\/devices\/[^/]+\/(?:installation-location|radio-configuration)/.test(url.pathname))
        ? handleNetworkRoute({devices: this.devices, ledger: this.readings, now: this.now, state: this.state.network}, wireMethod, url, bodyObject)
        : {handled: false as const};
      const data = structuredClone(historyRoute.handled ? historyRoute.value : networkRoute.handled ? networkRoute.value : this.dispatch(method.toUpperCase(), url, bodyObject));
      if (beforeMutation !== null && beforeMutation !== this.canonicalMutationSnapshot()) this.recordPublicPendingMutation();
      const status = historyRoute.handled && historyRoute.status ? historyRoute.status
        : networkRoute.handled && networkRoute.status ? networkRoute.status
        : wireMethod === 'POST' && (url.pathname === '/api/improvement-requests' || /\/api\/valves\/[^/]+\/schedules$/.test(url.pathname)
        || (this.mode === 'public' && ['/api/journal/entries','/api/journal/plots','/api/journal/plot-groups','/api/analysis/views'].includes(url.pathname))) ? 201
        : wireMethod === 'POST' && /\/api\/valves\/[^/]+\/(?:plan\/resend|scheduler-status)$/.test(url.pathname) ? 202 : 200;
      const exportType = url.pathname.endsWith('/export.csv') ? 'text/csv; charset=utf-8'
        : url.pathname.endsWith('/export.json') ? 'application/json; charset=utf-8'
          : url.pathname.endsWith('/export.package') ? 'application/zip' : null;
      const historyExport = historyRoute.handled && 'contentType' in historyRoute
        ? historyRoute as typeof historyRoute & {contentType: string; filename: string} : null;
      return {status,
        headers: historyExport ? {'content-type': historyExport.contentType, 'content-disposition': `attachment; filename="${historyExport.filename}"`}
          : exportType ? {'content-type': exportType, 'content-disposition': `attachment; filename="${url.pathname.endsWith('/export.csv') ? 'journal-export.csv' : url.pathname.endsWith('/export.json') ? 'journal-export.json' : 'journal-export.zip'}"`}
          : {'content-type': 'application/json'}, data};
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      const data = error.data ?? {error: error.code};
      return {status: error.status, headers: error.headers, data: structuredClone(data)};
    }
  }
  private decodeJsonBody(body: unknown): Body {
    if (body == null) return {};
    if (typeof body === 'string') {
      try {
        const value: unknown = JSON.parse(body);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Body;
      } catch { /* non-JSON text remains an invalid route body */ }
      return fail(400, 'invalid_body');
    }
    if (typeof body === 'object' && !Array.isArray(body) && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) return body as Body;
    return fail(415, 'unsupported_body');
  }
  private requireObjectBody(body: unknown): Body {
    if (body == null) return {};
    if (typeof body === 'object' && !Array.isArray(body) && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) return body as Body;
    return fail(415, 'unsupported_body');
  }
  private deviceRoute(method: string, device: Device, action: string, url: URL, body: Body): unknown {
    const d = device as Device & Record<string, unknown>;
    const bool = () => body.enabled;
    if (action === 'rain-history' && method === 'GET') {
      return dailyRainHistory(device, this.readings, this.now, Number(url.searchParams.get('days') ?? 7), this.rainTimezone(device),
        this.rainTimezoneBasis(device));
    }
    if (action === 'dendro-history' && method === 'GET') return dendroHistory(device, this.readings, this.now, Number(url.searchParams.get('hours') ?? 24));
    if (action === 'zone-assignments' && method === 'GET') return (this.state.weatherAssignments.get(device.deveui) ?? []).map(id => ({zone_id: id, zone_name: this.zones.find(z => z.id === id)?.name ?? null}));
    if (action === 'zone-assignments' && method === 'PUT') {
      if (!Array.isArray(body.zone_ids) || body.zone_ids.some(id => !this.zones.some(z => z.id === Number(id)))) return fail();
      this.state.weatherAssignments.set(device.deveui, [...new Set(body.zone_ids.map(Number))]); return {};
    }
    if (action === 'watermark/calibration') {
      const prior = this.state.watermarkCalibrations.get(device.deveui) ?? {deveui: device.deveui, sync_version: 0, calibration: null};
      if (method === 'GET') return prior;
      if (method === 'DELETE') {
        if (Number(url.searchParams.get('expected_sync_version')) !== prior.sync_version) return fail(409, 'sync_version_conflict');
        const next = {...prior, sync_version: prior.sync_version + 1, calibration: null}; this.state.watermarkCalibrations.set(device.deveui, next);
        this.readings.setWatermarkCalibration(device.deveui, null, false); return next;
      }
      if (method === 'PUT' && body.dry_run === true) {
        const sample = this.readings.latestSample(device.deveui);
        const values = Object.fromEntries(['pullup_1_ohm','pulldown_1_ohm','series_fwd_1_ohm','series_rev_1_ohm','pullup_2_ohm','pulldown_2_ohm','series_fwd_2_ohm','series_rev_2_ohm'].map(key => [key, Number(body[key])]));
        return {preview: sample ? {recorded_at: iso(sample.at), channels: [1, 2].map(channel => ({channel,
          ...convertWatermarkChannel(Number(sample.values[`watermark_fwd_${channel}`]), Number(sample.values[`watermark_rev_${channel}`]),
            Number(sample.values.watermark_temp_c), values, channel)}))} : null};
      }
      if (method === 'PUT') {
        if (Number(body.expected_sync_version) !== prior.sync_version) return fail(409, 'sync_version_conflict');
        const values = Object.fromEntries(['pullup_1_ohm','pulldown_1_ohm','series_fwd_1_ohm','series_rev_1_ohm','pullup_2_ohm','pulldown_2_ohm','series_fwd_2_ohm','series_rev_2_ohm'].map(key => [key, Number(body[key])]));
        if (Object.values(values).some(value => !Number.isFinite(value))) return fail();
        for (const channel of [1, 2]) if (values[`pullup_${channel}_ohm`]! < 25000 || values[`pullup_${channel}_ohm`]! > 65000 ||
          values[`pulldown_${channel}_ohm`]! < 25000 || values[`pulldown_${channel}_ohm`]! > 65000 ||
          values[`series_fwd_${channel}_ohm`]! < 0 || values[`series_fwd_${channel}_ohm`]! > 500 ||
          values[`series_rev_${channel}_ohm`]! < 0 || values[`series_rev_${channel}_ohm`]! > 500) return fail();
        const calibration = {...values, measured_at: body.measured_at ?? null, method: body.method ?? null,
          worst_residual_pct: null, notes: body.notes ?? null, updated_at: iso(this.now)};
        const next = {...prior, sync_version: prior.sync_version + 1, calibration}; this.state.watermarkCalibrations.set(device.deveui, next);
        const backfilled = this.readings.setWatermarkCalibration(device.deveui, values, true);
        const latest = this.readings.latestSample(device.deveui);
        if (latest) device.latest_data = {...latest.values, sampled_at: iso(latest.at)} as typeof device.latest_data;
        return {...next, backfilled};
      }
    }
    if (action === 'reference-tree' && method === 'PUT') { d.is_reference_tree = Number(body.is_reference_tree) === 1 ? 1 : 0; return {}; }
    if (action === 'soil-moisture-depths' && method === 'PUT') {
      const depths = body.soilMoistureProbeDepths;
      if (!depths || typeof depths !== 'object' || Array.isArray(depths) || Object.values(depths).some(value =>
        !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 1000)) return fail();
      Object.assign(device, {soil_moisture_probe_depths_json: {...depths as Record<string, number>}, soil_moisture_probe_depths_configured: 1});
      return device;
    }
    const flags: Record<string, string> = {dendro: 'dendro_enabled', temp: 'temp_enabled', 'rain-gauge': 'rain_gauge_enabled', 'flow-meter': 'flow_meter_enabled', chameleon: 'chameleon_enabled'};
    if (flags[action] && method === 'PUT') {
      if (typeof bool() !== 'boolean') return fail(422, 'invalid');
      this.applyDeviceConfig(device, action, {[flags[action]!]: bool() ? 1 : 0}); return {status: 'queued'};
    }
    if (action === 'kiwi/interval' && method === 'PUT' || action === 'lsn50/interval' && method === 'PUT') {
      const minutes = Number(body.minutes), maximum = action === 'kiwi/interval' ? MAX_KIWI_INTERVAL_MINUTES : MAX_LSN50_INTERVAL_MINUTES;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > maximum) return fail();
      d.requested_uplink_interval_minutes = minutes;
      this.applyDeviceConfig(device, 'uplink', {uplink_interval_minutes: minutes});
      return {status: 'queued'};
    }
    if (action === 'kiwi/temperature-humidity/enable' && method === 'POST') {
      const minutes = Number(body.minutes); if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_KIWI_INTERVAL_MINUTES) return fail();
      this.applyDeviceConfig(device, 'temperature-humidity', {temp_humidity_interval_minutes: minutes,
        uplink_interval_minutes: minutes, temp_humidity_enabled: 1}); return {status: 'queued'};
    }
    if (action === 'lsn50/mode' && method === 'PUT') {
      if (!['MOD0','MOD1','MOD2','MOD3','MOD4','MOD5','MOD6','MOD7','MOD8','MOD9'].includes(String(body.mode))) return fail();
      d.requested_lsn50_mode = body.mode;
      const latestData = {...device.latest_data} as Record<string, unknown>;
      if (body.mode !== 'MOD9') for (const key of ['rain_mm_delta','rain_mm_per_10min','rain_mm_today','flow_liters_delta','flow_liters_per_10min','flow_liters_today']) delete latestData[key];
      this.applyDeviceConfig(device, 'lsn50-mode', {lsn50_mode: body.mode, lsn50_mode_code: Number(String(body.mode).slice(3)),
        device_mode: Number(String(body.mode).slice(3)), lsn50_mode_observed_at: iso(this.now), latest_data: {...latestData,
          lsn50_mode_label: body.mode}});
      return {status: 'queued'};
    }
    if (action === 'lsn50/interrupt-mode' && method === 'PUT') { const mode = Number(body.mode); if (!Number.isInteger(mode) || mode < 0 || mode > 255) return fail(); this.applyDeviceConfig(device, 'interrupt-mode', {interrupt_mode: mode}); return {status: 'queued'}; }
    if (action === 'lsn50/5v-warmup' && method === 'PUT') { const ms = Number(body.milliseconds); if (!Number.isInteger(ms) || ms < 0 || ms > MAX_LSN50_5V_WARMUP_MS) return fail(); this.applyDeviceConfig(device, '5v-warmup', {five_volt_warmup_ms: ms}); return {status: 'queued'}; }
    if (action === 'chameleon/depth' && method === 'PUT') {
      const patch: Record<string, unknown> = {};
      for (const [key, field] of [['chameleonSwt1DepthCm','chameleon_swt1_depth_cm'],['chameleonSwt2DepthCm','chameleon_swt2_depth_cm'],['chameleonSwt3DepthCm','chameleon_swt3_depth_cm']]) if (key in body) {
        if (body[key] === null) patch[field] = null;
        else { const value = Number(body[key]); if (!Number.isFinite(value) || value <= 0 || value > 500) return fail(); patch[field] = value; }
      }
      this.applyDeviceConfig(device, 'chameleon-depth', patch); return {status: 'queued'};
    }
    if (action === 'chameleon/refresh-calibration' && method === 'POST') {
      const arrayId = String(device.latest_data.chameleon_array_id ?? d.chameleon_array_id ?? '');
      const fixture = chameleonFixture(arrayId);
      if (!fixture) return {status: 'unknown'};
      d.chameleon_calibration_status = 'pending'; device.calibration_status = 'pending';
      const entity = `device-config:${device.deveui}:chameleon-calibration`, generation = this.clock.invalidate(entity);
      this.clock.schedule(this.now + 5000, () => {
        const current = this.devices.find(row => row.deveui === device.deveui);
        if (current) {
          (current as Device & Record<string, unknown>).chameleon_calibration_status = 'calibrated';
          current.calibration_status = 'calibrated';
        }
      }, {id: `chameleon-calibration:${device.deveui}:${this.now}:${generation}`, meaningful: true, priority: 3, entity, generation});
      return {status: 'pending', source: 'fictional_seed', sensor_id: fixture.sensorId};
    }
    if (action === 'dendro-config' && method === 'PUT') {
      const patch: Record<string, unknown> = {};
      for (const [key, field] of [['dendroForceLegacy','dendro_force_legacy'],['dendroStrokeMm','dendro_stroke_mm'],['dendroRatioAtRetracted','dendro_ratio_at_retracted'],['dendroRatioAtExtended','dendro_ratio_at_extended']]) if (key in body) {
        if (key === 'dendroForceLegacy') {
          if (typeof body[key] !== 'boolean') return fail();
          patch[field] = body[key] ? 1 : 0;
        } else patch[field] = body[key] == null && (key === 'dendroRatioAtRetracted' || key === 'dendroRatioAtExtended')
          ? null : Number(body[key]);
      }
      if ('dendroStrokeMm' in body && !(Number(body.dendroStrokeMm) > 0 && Number(body.dendroStrokeMm) <= 100)) return fail();
      if ('dendroRatioAtRetracted' in body && !Number.isFinite(Number(body.dendroRatioAtRetracted))) return fail();
      if ('dendroRatioAtExtended' in body && !Number.isFinite(Number(body.dendroRatioAtExtended))) return fail();
      this.applyDeviceConfig(device, 'dendro-config', patch); return {status: 'queued'};
    }
    if (action === 'dendro-baseline/reset' && method === 'POST') {
      this.applyDeviceConfig(device, 'dendro-baseline', {dendro_baseline_pending: 0,
        dendro_baseline_position_mm: device.latest_data.dendro_position_mm ?? device.latest_data.dendro_position_raw_mm ?? null,
        dendro_baseline_at: iso(this.now)}); return {status: 'queued'};
    }
    if (action === 'sdi12/config' && method === 'PUT') {
      const profile = SDI12_PROFILES.find(item => item.id === body.probe_profile); if (!profile) return fail();
      if (body.probe_profile === 'SENTEK_ENVIROSCAN') {
        if (!Array.isArray(body.sensors) || body.sensors.length < 1 || body.sensors.length > 10 || !/^[0-9A-Za-z]$/.test(String(body.address ?? ''))) return fail();
        const seen = new Set<number>(), positions = new Set<number>(), depths = new Set<number>();
        for (const sensor of body.sensors as Array<Record<string, unknown>>) {
          const channel = Number(sensor.channel), position = Number(sensor.response_position), depth = Number(sensor.depth_cm);
          if (!Number.isInteger(channel) || channel < 1 || channel > 10 || seen.has(channel) ||
            !Number.isInteger(position) || position < 1 || position > body.sensors.length || positions.has(position) ||
            !Number.isInteger(depth) || depth < 1 || depth > 1000 || depths.has(depth) ||
            !['ENVIROSCAN','TRISCAN'].includes(String(sensor.type))) return fail();
          seen.add(channel); positions.add(position); depths.add(depth);
        }
        d.sdi12_channel_layout_json = {version: 1, address: String(body.address), sensors: structuredClone(body.sensors)};
      } else d.sdi12_channel_layout_json = null;
      const previousProfile = device.sdi12_probe_profile;
      const previousDepths: Record<string, unknown> = structuredClone((d.sdi12_depths_json as Record<string, unknown> | null) ?? {});
      const canonicalDepths = structuredClone(device.soil_moisture_probe_depths_json ?? {});
      d.sdi12_probe_profile = profile.id; d.sdi12_probe_status = 'manual'; d.sdi12_value_count = body.value_count == null ? profile.expectedValues : Number(body.value_count);
      d.sdi12_config_json = structuredClone(body);
      const submittedDepths = body.depths as Record<string, unknown> | undefined;
      const effectiveDepths: Record<string, unknown> = submittedDepths ?? (previousProfile === profile.id ? previousDepths : {});
      d.sdi12_depths_json = structuredClone(effectiveDepths);
      const normalizedDepths: Record<string, number> = {};
      if (profile.id === 'TENSIOMARK') {
        const submitted = effectiveDepths['1'] ?? effectiveDepths.swt_1;
        const depth = submitted === undefined && previousProfile === 'TENSIOMARK'
          ? Number(canonicalDepths.swt_1 ?? canonicalDepths.soil_temp_1) : Number(submitted);
        if (Number.isFinite(depth) && depth > 0) Object.assign(normalizedDepths, {swt_1: depth, soil_temp_1: depth});
      } else if (profile.id === 'SENTEK_ENVIROSCAN') {
        for (const sensor of (body.sensors as Array<{channel: number; depth_cm: number}> | undefined) ?? []) {
          if (Number.isFinite(sensor.depth_cm) && sensor.depth_cm > 0) normalizedDepths[`vwc_${sensor.channel}`] = sensor.depth_cm;
        }
      } else {
        for (const slot of profile.depthSlots ?? []) {
          const depth = Number(effectiveDepths[String(slot)] ?? effectiveDepths[`depth_${slot}`]);
          if (!Number.isFinite(depth) || depth <= 0) continue;
          for (const channel of profile.channels ?? []) if (channel.endsWith(`_${slot}`)) normalizedDepths[channel] = depth;
        }
      }
      d.soil_moisture_probe_depths_json = normalizedDepths;
      d.soil_moisture_probe_depths_configured = Object.keys(normalizedDepths).length ? 1 : 0;
      const currentValues = deviceValues(device, this.now);
      const latest = {...device.latest_data} as Record<string, unknown>;
      for (const key of Object.keys(latest)) if (/^(swt_|vwc_|soil_temp_|soil_ec_|soil_vic_)/.test(key) && !(key in currentValues)) delete latest[key];
      device.latest_data = latest as Device['latest_data'];
      return {};
    }
    if (action === 'sdi12/identify' && method === 'POST') { d.sdi12_probe_status = 'manual'; d.sdi12_identity = null; return {}; }
    if (action === 'sdi12/recipe/apply' && method === 'POST') {
      const previous = device.sdi12_recipe_deployment ?? null; d.sdi12_previous_recipe_deployment = previous;
      d.sdi12_previous_config = {sdi12_probe_profile: device.sdi12_probe_profile ?? null, sdi12_probe_status: device.sdi12_probe_status ?? null,
        sdi12_value_count: device.sdi12_value_count ?? null, sdi12_config_json: structuredClone(d.sdi12_config_json ?? null),
        sdi12_depths_json: structuredClone(d.sdi12_depths_json ?? null), soil_moisture_probe_depths_json: structuredClone(device.soil_moisture_probe_depths_json ?? null),
        soil_moisture_probe_depths_configured: device.soil_moisture_probe_depths_configured ?? null, sdi12_channel_layout_json: structuredClone(device.sdi12_channel_layout_json ?? null)};
      const next = {desired_version: Number(d.sdi12_recipe_version ?? 0) + 1, desired_layout_hash: 'fictional-layout', status: 'queueing', queued_at: iso(this.now), queue_drained_at: null, commissioning_deadline_at: null, last_observed_at: null, compatible_at: null, updated_at: iso(this.now), frame_count: null, compatible_available: true, last_error_code: null};
      d.sdi12_recipe_deployment = next as unknown as Sdi12RecipeDeployment; this.clock.schedule(this.now + 2000, () => { const current = this.devices.find(row => row.deveui === device.deveui); if (current?.sdi12_recipe_deployment) Object.assign(current.sdi12_recipe_deployment, {status: 'observed_compatible', queue_drained_at: iso(this.now), last_observed_at: iso(this.now), compatible_at: iso(this.now)}); }, {id: `sdi12-apply:${device.deveui}:${this.now}`, meaningful: true, priority: 3, entity: `device:${device.deveui}`, generation: this.clock.generation(`device:${device.deveui}`)});
      return next;
    }
    if (action === 'sdi12/recipe/rollback' && method === 'POST') {
      const previous = d.sdi12_previous_recipe_deployment as Device['sdi12_recipe_deployment']; if (!previous) return null;
      d.sdi12_recipe_deployment = structuredClone(previous);
      if (d.sdi12_previous_config && typeof d.sdi12_previous_config === 'object') Object.assign(d, structuredClone(d.sdi12_previous_config));
      const currentValues = deviceValues(device, this.now);
      const latest = {...device.latest_data} as Record<string, unknown>;
      for (const key of Object.keys(latest)) if (/^(swt_|vwc_|soil_temp_|soil_ec_|soil_vic_)/.test(key) && !(key in currentValues)) delete latest[key];
      device.latest_data = latest as Device['latest_data'];
      if (d.sdi12_previous_config && typeof d.sdi12_previous_config === 'object') delete d.sdi12_previous_config;
      return previous;
    }
    return fail(501, 'unsupported');
  }
  private dispatch(method: string, url: URL, body: Body): unknown {
    const path = url.pathname;
    if (this.mode === 'public' && path.startsWith('/api/analysis/')) {
      const result = handleAnalysisRoute(this.state.analysis, {devices: this.devices, zones: this.zones,
        ledger: this.readings, now: this.now, gatewayTimezone: this.state.settings.gatewayTimezone,
        environmentRecords: this.state.environmentRecords}, method, path, body);
      if (result.handled) return result.value;
    }
    if (this.mode === 'public' && path.startsWith('/api/journal/')) {
      return handleJournalRoute(this.journal, {now: this.now, owner: this.state.sessions.activeUserUuid ?? '00000000-0000-4000-8000-000000000001',
        gateway: '00000000000000D0', zones: this.zones, recordMutation: () => this.recordPublicPendingMutation()}, method, url, body);
    }
    const adminOperation = (path === '/api/users' && (method === 'GET' || method === 'POST'))
      || (method === 'POST' && /^\/api\/users\/[^/]+\/password-reset$/.test(path))
      || (method === 'PUT' && /^\/api\/users\/[^/]+\/(role|disabled)$/.test(path))
      || ((path === '/api/grants/zone' || path === '/api/grants/plot') && method === 'POST')
      || (method === 'DELETE' && /^\/api\/grants\/(zone|plot)\/[^/]+$/.test(path));
    if (this.mode === 'public' && adminOperation) return permissionDenied();
    if (this.mode === 'public' && method === 'POST' && path === '/auth/login') return loginLocal(this.state.sessions, body);
    if (this.mode === 'public' && method === 'POST' && path === '/auth/register') return registerLocal(this.state.sessions, body);
    if (method === 'GET') {
      if (path === '/api/me') return this.mode === 'public' ? sessionProfile(this.state.sessions)
        : {username: 'MUARIK · Demo', user_uuid: '00000000-0000-4000-8000-000000000001', role: 'researcher', zone_uuids: null, plot_uuids: null, features: {scoped_access: false}};
      if (path === '/api/system/settings') return readSystemSettings(this.state.settings);
      if (path === '/api/system/stats') return publicSystemStats(this.state.system, this.now);
      if (path === '/api/system/features') return this.mode === 'public' ? publicSystemFeatures() : {};
      if (path === '/api/improvement-requests') return listSupportRequests(this.state.system);
      if (path === '/api/improvement-requests/diagnostics-preview') return diagnosticsPreview(url.searchParams.get('route'), this.now,
        this.state.settings.gatewayTimezone, this.zones.length, this.devices.length);
      if (path === '/api/account-link/status') return this.mode === 'public' ? this.state.sessions.linked : {linked: false};
      if (this.mode === 'public' && path === '/api/sync/state') return syncSummary(this.state.sessions);
    if (path === '/api/devices') return this.devices.map(d => {
      const assignments = d.type_id === 'SENSECAP_S2120' ? (this.state.weatherAssignments.get(d.deveui) ?? []) : null;
      return {...d, ...(assignments ? {zone_ids: [...assignments], zone_names: assignments.map(id => this.zones.find(zone => zone.id === id)?.name ?? null)} : {}),
        active_valve_actuation: this.state.activeCommands.get(d.deveui) ?? null};
    });
      if (path === '/api/irrigation-zones') return this.zones.map(z => ({...z,
        schedule: z.schedule ? {...z.schedule, last_evaluation: this.state.triggerEvaluations.find(row => row.zoneId === z.id) ?? null,
          recent_evaluations: this.state.triggerEvaluations.filter(row => row.zoneId === z.id).slice(0, 10)} : null,
        device_count: this.devices.filter(d => d.irrigation_zone_id === z.id).length}));
      if (path === '/api/catalog') return this.mode === 'public' ? DEVICE_CATALOG : DEVICE_CATALOG.filter(item => item.id === 'KIWI_SENSOR');
      if (path === '/api/sdi12/probe-profiles') return {profiles: SDI12_PROFILES};
      if (path === '/api/irrigation/recent-actuations') return {generatedAt: iso(this.now), actuations: this.outcomes};
      if (path === '/api/valves') {
        const valves = this.mode === 'public' ? this.devices.filter(device => device.type_id === 'STREGA_VALVE') : [this.valve()].filter(Boolean);
        return {valves: valves.map(v => {
          const z = this.zones.find(zone => zone.id === v.irrigation_zone_id);
          const snapshot = this.mode === 'public' ? this.planSnapshot(v.deveui) as ReturnType<Simulator['planSnapshot']> : null;
          const runtime = this.mode === 'public' ? this.planRuntime(v.deveui) : null;
          const plans = this.mode === 'public' ? this.valvePlanRows(v.deveui).filter(plan => !plan.deleted_at) : [];
          const valveSettings = this.mode === 'public' ? snapshot!.settings as Record<string, unknown> : {};
          return {device_eui: v.deveui, name: v.name, zone_id: z?.id, zone_uuid: z?.zone_uuid, zone_name: z?.name,
            timezone: z?.timezone ?? this.state.settings.gatewayTimezone, current_state: v.current_state, target_state: v.target_state,
            strega_generation: (v as Device & {strega_generation?: string}).strega_generation ?? 'GEN1',
            flow_rate_lpm: valveSettings.flow_rate_lpm ?? null, flow_rate_source: valveSettings.flow_rate_source ?? null,
            default_open_minutes: valveSettings.default_open_minutes ?? this.defaultOpenMinutes, scheduler_status: runtime?.schedulerStatus ?? 'ACTIVE', skip_today_date: runtime?.skipTodayDate ?? null, last_uplink_at: v.last_seen,
            active_actuation: this.state.activeCommands.get(v.deveui) ?? null, recent_stale_state: null,
            next_run: nextPlanRun(plans, this.now, z?.timezone ?? this.state.settings.gatewayTimezone), schedule_count: plans.length,
            push_state: runtime ? planPushSummary(runtime) : {queued: 0, acked: 0, failed: 0, last_plan_queued_at: null, last_plan_acked_at: null}};
        })};
      }
      if (this.mode !== 'public' && path === `/api/valves/${VALVE_EUI}/schedules`) return {schedules: [], timezone: 'Africa/Kampala', push_state: {}, scheduler_status: 'ACTIVE'};
      const litersMatch = path.match(/^\/api\/v1\/devices\/([^/]+)\/today-liters$/);
      if (litersMatch) {
        const device = this.devices.find(item => item.deveui === litersMatch[1]!.toUpperCase());
        if (!device) return fail(404, 'missing');
        const zoneId = device.irrigation_zone_id;
        if (zoneId == null) return {liters: null, source: 'unknown'};
        const flow = this.flowSourceForZone(zoneId);
        const from = localDayStart(this.now, this.zones.find(zone => zone.id === zoneId)?.timezone ?? this.state.settings.gatewayTimezone);
        const observed = flow ? this.readings.aggregate(flow.deveui, 'flow_liters_delta', from, this.now) : this.flowByZone.get(zoneId) ?? null;
        return {liters: observed, source: flow ? 'measured_flow_meter' : observed == null ? 'unknown' : 'estimated_duration_flow_rate'};
      }
    }
    if (this.mode === 'public' && method === 'POST' && path === '/api/account-link') {
      return linkLocalAccount(this.state.sessions, body, this.now, this.devices.map(device => device.deveui));
    }
    if (this.mode === 'public' && method === 'DELETE' && path === '/api/account-link') {
      unlinkLocalAccount(this.state.sessions);
      return {};
    }
    if (this.mode === 'public' && method === 'POST' && path === '/api/sync/force') return forceLocalSync(this.state.sessions, this.now);
    if (path === '/api/system/settings' && method === 'PUT') return this.saveSystemSettings(body as unknown as UpdateSystemSettingsRequest);
    if (path === '/api/irrigation-zones/schedules/disable-all' && method === 'POST') {
      let disabledSchedules = 0;
      for (const zone of this.zones) {
        const deletedAt = (zone as IrrigationZone & {deleted_at?: string | null}).deleted_at;
        const schedule = zone.schedule as (IrrigationSchedule & {sync_version?: number}) | null;
        if (deletedAt || !schedule?.enabled) continue;
        const nextSchedule = {...schedule, enabled: false, sync_version: (schedule.sync_version ?? 0) + 1, updated_at: iso(this.now)} as IrrigationSchedule & {sync_version: number; updated_at: string};
        zone.schedule = nextSchedule;
        disabledSchedules++;
      }
      if (disabledSchedules > 0) this.refreshDailyTrigger();
      return {disabledSchedules};
    }
    if (path === '/api/improvement-requests' && method === 'POST') {
      try { return submitSupportRequest(this.state.system, body, this.now); }
      catch (error) {
        const code = String((error as {code?: string}).code ?? (error as Error).message ?? 'invalid_support_request');
        const detail = (error as {detail?: unknown}).detail;
        return fail(Number((error as {status?: number}).status ?? 400), code, {error: code, ...(detail === undefined ? {} : {detail})});
      }
    }
    if (path === '/api/system/fan' && method === 'POST') {
      try { setSimulatedFan(this.state.system, body.speed); return {}; }
      catch (error) {
        const status = Number((error as {status?: number}).status ?? 400);
        const message = String((error as Error).message);
        return fail(status, 'invalid_fan_speed', {error: message});
      }
    }
    if (this.mode === 'public' && path === '/api/system/reboot' && method === 'POST') { scheduleSimulatedRestart(this.state.system, this.clock, this.now); return {}; }
    if (path === '/api/irrigation-zones' && method === 'POST') {
      try {
        const zone = createZone(this.state, body);
        if (this.mode === 'public') seedCompletedEnvironmentRecords([zone], this.now, this.state.settings.gatewayTimezone, this.state.environmentRecords);
        return zone;
      }
      catch (error) { return fail(Number((error as {status?: number}).status ?? 422), (error as Error).message); }
    }
    const dendroMatch = path.match(/^\/api\/dendrometer\/([^/]+)\/(daily|readings)$/);
    if (dendroMatch && method === 'GET') {
      const device = this.devices.find(item => item.deveui === dendroMatch[1].toUpperCase());
      if (!device) return fail(404, 'missing');
      if (dendroMatch[2] === 'daily') return dendroDailyIndicators(device, this.readings, this.now, Number(url.searchParams.get('days') ?? 7), this.state.settings.gatewayTimezone);
      const from = Date.parse(url.searchParams.get('from') ?? '') || this.now - 24 * 3600000;
      const to = Date.parse(url.searchParams.get('to') ?? '') || this.now;
      if (to < from) return [];
      return dendroRawReadings(device, this.readings, from, to);
    }
    const zoneMatch = path.match(/^\/api\/irrigation-zones\/(\d+)(?:\/(.*))?$/);
    if (zoneMatch) {
      const id = Number(zoneMatch[1]), part = zoneMatch[2];
      const zone = this.zones.find(z => z.id === id); if (!zone) return fail(404, 'missing');
      if (!part && method === 'DELETE') {
        const valveEuis = this.devices.filter(device => device.type_id === 'STREGA_VALVE' && device.irrigation_zone_id === id).map(device => device.deveui);
        deleteZone(this.state, this.devices, id);
        this.refreshDailyTrigger();
        for (const [eui, assignments] of this.state.weatherAssignments) {
          const remaining = assignments.filter(zoneId => zoneId !== id);
          if (remaining.length) this.state.weatherAssignments.set(eui, remaining);
          else this.state.weatherAssignments.delete(eui);
        }
        for (const eui of valveEuis) rescheduleSkipTodayRollover(this.planPort(), eui);
        return {};
      }
      if (part === 'name' && method === 'PUT') {
        try { return renameZone(zone, body.name, this.now); }
        catch (error) { return fail(Number((error as {status?: number}).status ?? 400), (error as Error).message); }
      }
      if (part === 'config' && method === 'PUT') {
        try {
          if (this.mode === 'public') seedCompletedEnvironmentRecords([zone], this.now, this.state.settings.gatewayTimezone, this.state.environmentRecords);
          const result = configureZone(zone, body, this.now);
          for (const device of this.devices) if (device.type_id === 'STREGA_VALVE' && device.irrigation_zone_id === id) rescheduleSkipTodayRollover(this.planPort(), device.deveui);
          return result;
        }
        catch (error) { return fail(Number((error as {status?: number}).status ?? 422), (error as Error).message); }
      }
      if (part === 'calibration' && method === 'POST') {
        const rate = Number(body.measuredFlowRateLpm);
        if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) return fail();
        const calibration = {measuredFlowRateLpm: rate, measurementMethod: typeof body.measurementMethod === 'string' ? body.measurementMethod : null};
        this.state.zoneCalibration.set(id, calibration);
        Object.assign(zone, {measured_flow_rate_lpm: rate, measurement_method: calibration.measurementMethod, irrigation_calibration_updated_at: iso(this.now)});
        return {};
      }
      if (part === 'location' && method === 'PUT') {
        const latitude = Number(body.latitude), longitude = Number(body.longitude);
        if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return fail();
        zone.latitude = latitude; zone.longitude = longitude; return {};
      }
      if (part === 'environment-summary' && method === 'GET') {
        const weather = this.weatherStationForZone(id);
        const devices = this.devices.filter(d => d.irrigation_zone_id === id || d.deveui === weather?.deveui);
        const environmentDevices = this.mode === 'presentation' ? devices.map(device => ({...device,
          latest_data: {...device.latest_data, ...this.presentationWaterSeed.get(device.deveui)}})) : devices;
        const summary = this.mode === 'public'
          ? buildEnvironmentSummary(zone, devices, this.readings, this.now, zone.timezone ?? this.state.settings.gatewayTimezone,
            this.publicWaterDays(id, zone.timezone ?? this.state.settings.gatewayTimezone), this.state.environmentRecords)
          : environmentFixture(zone, environmentDevices);
        if (this.mode === 'public') {
          const today = summary.water.daily.find(day => day.date === localCalendarDate(this.now, zone.timezone ?? this.state.settings.gatewayTimezone));
          const rainToday = today?.rainMm ?? null;
          const flowToday = today?.measuredIrrigationLiters ?? null;
          summary.generatedAt = iso(this.now);
          summary.water.observedAt = devices.length ? iso(this.now) : null;
          summary.water.rainTodayMm = rainToday;
          summary.water.irrigationTodayLiters = flowToday;
          summary.water.irrigationTodayMeasuredLiters = flowToday;
          summary.water.irrigationTodayNetMm = flowToday == null ? null : Number((flowToday / Math.max(1, zone.area_m2 ?? 100) * ((zone.irrigation_efficiency_pct ?? 85) / 100)).toFixed(2));
          summary.water.areaM2 = zone.area_m2 ?? null;
          summary.water.irrigationEfficiencyPct = zone.irrigation_efficiency_pct ?? null;
          summary.location = {latitude: zone.latitude ?? null, longitude: zone.longitude ?? null,
            timezone: zone.timezone ?? this.state.settings.gatewayTimezone, source: hasValidWeatherLocation(zone) ? 'zone' : 'unavailable'};
          summary.water.measuredIrrigationNetMm = summary.water.irrigationTodayNetMm;
          summary.water.action = this.publicWaterAction(id, summary);
          // The public builder derives the shared synthetic forecast and demand on the same clock as readings.
        }
        return summary;
      }
      if (part === 'recommendations' && method === 'GET') {
        const rain = this.rainSourceForZone(id), flow = this.flowSourceForZone(id);
        return this.mode === 'public'
        ? zoneRecommendationEvidence(id, this.devices, this.readings, this.now, Number(url.searchParams.get('days') ?? 14),
          zone.timezone ?? this.state.settings.gatewayTimezone, rain, flow).recommendations
        : [];
      }
      if (part?.startsWith('devices/') && (method === 'PUT' || method === 'DELETE')) {
        const device = this.devices.find(d => d.deveui === part.slice(8).toUpperCase()); if (!device) return fail(404, 'missing');
        if (method === 'PUT' && device.irrigation_zone_id && device.irrigation_zone_id !== id) return fail(409, 'assigned');
        if (method === 'DELETE' && device.irrigation_zone_id !== id) return fail(409, 'assigned');
        device.irrigation_zone_id = method === 'PUT' ? id : null;
        if (device.type_id === 'STREGA_VALVE') rescheduleSkipTodayRollover(this.planPort(), device.deveui);
        return {};
      }
      if (part === 'schedule' && method === 'PUT') {
        const metricRaw = body.trigger_metric ?? body.triggerMetric ?? body.metric ?? body.metric_id;
        const metric = String(metricRaw ?? '').trim().toUpperCase();
        const allowed = ['SWT_WM1', 'SWT_WM2', 'SWT_AVG', 'SWT_1', 'SWT_2', 'SWT_3', 'DENDRO'];
        if (!allowed.includes(metric)) return fail(400, 'invalid_trigger_metric', {message: `Invalid trigger_metric. Allowed: ${allowed.join(', ')}`});
        const thresholdRaw = body.threshold_kpa ?? body.thresholdKpa ?? body.threshold ?? body.kpa;
        const threshold = Number(thresholdRaw);
        if (metric === 'DENDRO') {
          const parsed = Number.parseInt(String(thresholdRaw), 10);
          if (!Number.isInteger(threshold) || String(threshold) !== String(parsed) || ![1, 2, 3, 4].includes(parsed)) {
            return fail(400, 'invalid_dendro_threshold', {message: 'Invalid DENDRO threshold_kpa (allowed encoded levels: 1=mild, 2=moderate, 3=significant, 4=severe)'});
          }
        } else if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 300) {
          return fail(400, 'invalid_threshold', {message: 'Invalid threshold_kpa (0 < x ≤ 300)'});
        }
        const durationRaw = body.duration_minutes ?? body.durationMinutes ?? body.duration ?? body.minutes;
        let duration = durationRaw === undefined || durationRaw === null ? 20 : Number(durationRaw);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 240) return fail(400, 'invalid_duration', {message: 'Invalid duration_minutes (0 < x ≤ 240)'});
        duration = Math.round(duration);
        const responseMode = String(body.response_mode ?? body.responseMode ?? 'proportional').trim().toLowerCase();
        if (!['proportional', 'fixed', 'aggressive'].includes(responseMode)) {
          return fail(400, 'invalid_response_mode', {message: 'Invalid response_mode. Allowed: proportional, fixed, aggressive'});
        }
        const enabledRaw = body.enabled ?? body.is_enabled ?? body.isEnabled;
        const enabledString = String(enabledRaw ?? '').trim().toLowerCase();
        const enabled = enabledRaw === undefined || enabledRaw === null ? true : typeof enabledRaw === 'boolean' ? enabledRaw
          : ['0', 'false', 'no', 'off'].includes(enabledString) ? false : ['1', 'true', 'yes', 'on'].includes(enabledString) ? true : Boolean(enabledRaw);
        const previous = zone.schedule as (IrrigationSchedule & {sync_version?: number; last_applied_at?: string | null}) | null;
        zone.schedule = {irrigation_zone_id: id, trigger_metric: metric as IrrigationSchedule['trigger_metric'],
          enabled, threshold_kpa: threshold, duration_minutes: duration, response_mode: responseMode,
          last_triggered_at: previous?.last_triggered_at ?? null,
          sync_version: (previous?.sync_version ?? 0) + 1, last_applied_at: previous?.last_applied_at ?? null} as IrrigationSchedule;
        if (this.mode === 'public') this.refreshDailyTrigger();
        return zone.schedule;
      }
    }
    if (path === '/api/devices' && method === 'POST') {
      const eui = String(body.deveui).toUpperCase();
      // The local simulator accepts native 16-hex EUIs; AppKeys are validated then discarded.
      if (this.mode !== 'public' && (body.type_id !== 'KIWI_SENSOR' || body.appkey)) return fail(422, 'demo_device');
      if (!/^[0-9A-F]{16}$/.test(eui) || (body.appkey != null && !/^[0-9A-Fa-f]{32}$/.test(String(body.appkey)))) return fail(422, 'demo_device');
      if (this.devices.some(d => d.deveui === eui)) return fail(409, 'duplicate');
      const zoneId = body.zone_id == null ? null : Number(body.zone_id);
      if (zoneId !== null && !this.zones.some(z => z.id === zoneId)) return fail(404, 'missing');
      let device: Device;
      try { device = this.mode === 'public' ? createDevice(eui, body.name, body.type_id, zoneId, this.now, body.strega_generation) : makeDevice(eui, nameOf(body.name), zoneId); }
      catch (error) { return fail(Number((error as {status?: number}).status ?? 422), (error as Error).message); }
      this.devices.push(device);
      if (this.mode === 'public') {
        this.readings.seedNewDevice(device, this.now, this.rainTimezone(device), this.rainTimezoneBasis(device));
        this.scheduleSample(eui, this.now + sampleIntervalMs());
      }
      return device;
    }
    const removeDeviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
    if (removeDeviceMatch && method === 'DELETE') {
      const eui = removeDeviceMatch[1].toUpperCase();
      if (!this.devices.some(device => device.deveui === eui)) return fail(404, 'missing');
      this.removeDevice(eui); return {};
    }
    const deviceMatch = path.match(/^\/api\/devices\/([^/]+)\/(sensor-history|name|rain-history|dendro-history|dendro|temp|rain-gauge|flow-meter|chameleon|lsn50\/mode|lsn50\/interval|lsn50\/interrupt-mode|lsn50\/5v-warmup|dendro-config|dendro-baseline\/reset|chameleon\/refresh-calibration|chameleon\/depth|watermark\/calibration|sdi12\/config|sdi12\/identify|sdi12\/recipe\/apply|sdi12\/recipe\/rollback|kiwi\/interval|kiwi\/temperature-humidity\/enable|soil-moisture-depths|reference-tree|zone-assignments)$/);
    if (deviceMatch) {
      const d = this.devices.find(d => d.deveui === deviceMatch[1]); if (!d) return fail(404, 'missing');
      if (deviceMatch[2] === 'name' && method === 'PUT') {
        let name: string; try { name = normalizedName(body.name); } catch (error) { return fail(Number((error as {status?: number}).status ?? 400), (error as Error).message); }
        const changed = d.name !== name; if (changed) d.name = name;
        return {...d, changed, sync_version: changed ? 1 : 0, chirpstack: 'skipped'};
      }
      if (deviceMatch[2] === 'sensor-history' && method === 'GET') {
        const field = url.searchParams.get('field') ?? 'swt_1';
        if (this.mode === 'public') {
          const hours = Math.min(2160, Math.max(1, Number(url.searchParams.get('hours')) || 24));
          return ledgerSensorHistory(d, this.readings, this.now, field, hours);
        }
        return sensorHistory(d, field, Number(url.searchParams.get('hours')) || 24);
      }
      if (this.mode === 'public') return this.deviceRoute(method, d, deviceMatch[2], url, body);
    }
    const planRoute = this.mode === 'public' ? this.planRoute(method, path, body) : null;
    if (planRoute?.handled) return planRoute.value;
    const irrigationRoute = handleIrrigationRoute({devices: this.devices, defaultOpenMinutes: this.defaultOpenMinutes, fail,
      valveSettings: (eui, value) => this.valveSettings(eui, value), valveCommand: (eui, value) => this.valveCommand(eui, value),
      cancelValve: (eui, value) => this.cancelValve(eui, value), serviceCommand: (eui, action, value) => this.serviceCommand(eui, action, value)}, method, path, body);
    if (irrigationRoute?.handled) return irrigationRoute.value;
    return fail(501, 'unsupported');
  }
}
