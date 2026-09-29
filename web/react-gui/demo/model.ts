import {sensorHistory} from './history';
import { normalizeEntityName } from '../src/utils/entityName';
import type { Device, IrrigationZone, IrrigationSchedule } from '../src/types/farming';
import type { IrrigationActuation } from '../src/services/api';
import { DEMO_EPOCH, VALVE_EUI, SPARE_EUI, seedDevices, zoneFixture, sensorFixture, environmentFixture, iso } from './fixtures';
export { DEMO_EPOCH, VALVE_EUI, SPARE_EUI };
export class DemoError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
type Body = Record<string, unknown>;
type ActiveActuation = { expectation_id: string; reconciliation_state: string; commanded_at: string; expected_close_at: string; duration_seconds: number; trigger: string };
const fail = (status = 422, code = 'invalid') => { throw new DemoError(status, code); };
function nameOf(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const result = normalizeEntityName(value);
  return result.ok ? result.name : fail(400, result.reason);
}
export class Simulator {
  now = DEMO_EPOCH;
  active = true;
  speed = 1;
  zones: IrrigationZone[] = [];
  devices: Device[] = [];
  actuation: ActiveActuation | null = null;
  outcomes: IrrigationActuation[] = [];
  private nextId = 3;
  private commandId = 0;
  defaultOpenMinutes = 1;
  constructor() { this.reset(); }
  reset() {
    this.now = DEMO_EPOCH; this.speed = 1; this.active = true;
    this.zones = [zoneFixture(1, 'Tomato plot'), zoneFixture(2, 'Demonstration bed')];
    this.devices = seedDevices(); this.actuation = null; this.outcomes = [];
    this.nextId = 3; this.commandId = 0; this.defaultOpenMinutes = 1;
  }
  advance(realMilliseconds: number): boolean {
    if (!this.active || !Number.isFinite(realMilliseconds) || realMilliseconds <= 0) return false;
    this.now += realMilliseconds * this.speed;
    if (!this.actuation) return false;
    if (this.now >= Date.parse(this.actuation.expected_close_at)) { this.close('COMPLETED'); return true; }
    if (this.actuation.reconciliation_state === 'PENDING_OBSERVATION' && this.now >= Date.parse(this.actuation.commanded_at) + 2000) {
      this.actuation.reconciliation_state = 'OBSERVED_RUNNING';
      this.valve().current_state = 'OPEN'; this.valve().last_seen = iso(this.now);
      Object.assign(this.outcomes[0], {status: 'RUNNING', reconciliationState: 'OBSERVED_RUNNING', observedOpenAt: iso(this.now), commandResult: 'ACK', commandAppliedAt: iso(this.now)});
      return true;
    }
    return false;
  }
  private valve() { return this.devices.find(d => d.deveui === VALVE_EUI)!; }
  private close(status: 'COMPLETED' | 'CANCELLED') {
    this.valve().current_state = 'CLOSED'; this.valve().target_state = 'CLOSED'; this.valve().last_seen = iso(this.now);
    if (this.actuation) Object.assign(this.outcomes[0], {status, reconciliationState: status, observedCloseAt: iso(this.now)});
    this.actuation = null;
  }
  request(method: string, path: string, body: Body = {}): unknown {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return fail(403, 'blocked');
    const url = new URL(path, 'http://demo.invalid');
    if (url.origin !== 'http://demo.invalid') return fail(403, 'blocked');
    // Return snapshots: React/SWR must not hold references mutated by the model.
    return structuredClone(this.dispatch(method.toUpperCase(), url, body));
  }
  private dispatch(method: string, url: URL, body: Body): unknown {
    const path = url.pathname;
    if (method === 'GET') {
      if (path === '/api/me') return {username: 'MUARIK · Demo', user_uuid: '00000000-0000-4000-8000-000000000001', role: 'researcher', zone_uuids: null, plot_uuids: null, features: {scoped_access: false}};
      if (path === '/api/system/settings') return {gatewayTimezone: 'Africa/Kampala', dataModuleEnabled: false, networkModuleEnabled: false, gatewayHubModuleEnabled: false, journalModuleEnabled: false};
      if (path === '/api/system/stats') return {restartPending: null};
      if (path === '/api/system/features') return {};
      if (path === '/api/account-link/status') return {linked: false};
      if (path === '/api/devices') return this.devices.map(d => ({...d, active_valve_actuation: d.deveui === VALVE_EUI ? this.actuation : null}));
      if (path === '/api/irrigation-zones') return this.zones.map(z => ({...z, device_count: this.devices.filter(d => d.irrigation_zone_id === z.id).length}));
      if (path === '/api/catalog') return [{id: 'KIWI_SENSOR', name: 'Kiwi'}];
      if (path === '/api/irrigation/recent-actuations') return {generatedAt: iso(this.now), actuations: this.outcomes};
      if (path === '/api/valves') {
        const v = this.valve(), z = this.zones.find(z => z.id === v.irrigation_zone_id);
        return {valves: [{device_eui: v.deveui, name: v.name, zone_id: z?.id, zone_uuid: z?.zone_uuid, zone_name: z?.name,
          timezone: 'Africa/Kampala', current_state: v.current_state, target_state: v.target_state, strega_generation: 'GEN1',
          default_open_minutes: this.defaultOpenMinutes, scheduler_status: 'ACTIVE', last_uplink_at: v.last_seen,
          active_actuation: this.actuation, recent_stale_state: null, next_run: null, schedule_count: 0, push_state: {}}]};
      }
      if (path === `/api/valves/${VALVE_EUI}/schedules`) return {schedules: [], timezone: 'Africa/Kampala', push_state: {}, scheduler_status: 'ACTIVE'};
      if (/^\/api\/v1\/devices\/[^/]+\/today-liters$/.test(path)) return {liters: null, source: 'unknown'};
    }
    if (path === '/api/irrigation-zones' && method === 'POST') {
      const zone = zoneFixture(this.nextId++, nameOf(body.name)); this.zones.push(zone); return zone;
    }
    const zoneMatch = path.match(/^\/api\/irrigation-zones\/(\d+)(?:\/(.*))?$/);
    if (zoneMatch) {
      const id = Number(zoneMatch[1]), part = zoneMatch[2];
      const zone = this.zones.find(z => z.id === id); if (!zone) return fail(404, 'missing');
      if (!part && method === 'DELETE') {
        if (id <= 2) return fail(409, 'protected');
        this.devices.forEach(d => { if (d.irrigation_zone_id === id) d.irrigation_zone_id = null; });
        this.zones = this.zones.filter(z => z.id !== id); return {};
      }
      if (part === 'name' && method === 'PUT') { zone.name = nameOf(body.name); return {...zone, changed: true, sync_version: 1}; }
      if (part === 'environment-summary' && method === 'GET') return environmentFixture(zone, this.devices.filter(d => d.irrigation_zone_id === id));
      if (part === 'recommendations' && method === 'GET') return [];
      if (part?.startsWith('devices/') && (method === 'PUT' || method === 'DELETE')) {
        const device = this.devices.find(d => d.deveui === part.slice(8)); if (!device) return fail(404, 'missing');
        if (method === 'PUT' && device.irrigation_zone_id && device.irrigation_zone_id !== id) return fail(409, 'assigned');
        if (method === 'DELETE' && device.irrigation_zone_id !== id) return fail(409, 'assigned');
        device.irrigation_zone_id = method === 'PUT' ? id : null; return {};
      }
      if (part === 'schedule' && method === 'PUT') {
        if (!['SWT_1', 'SWT_2', 'SWT_AVG'].includes(String(body.trigger_metric)) || typeof body.enabled !== 'boolean' ||
          !(Number(body.threshold_kpa) > 0 && Number(body.threshold_kpa) <= 300) ||
          !(Number.isInteger(body.duration_minutes) && Number(body.duration_minutes) >= 1 && Number(body.duration_minutes) <= 255)) return fail();
        zone.schedule = {irrigation_zone_id: id, trigger_metric: body.trigger_metric as IrrigationSchedule['trigger_metric'],
          enabled: body.enabled, threshold_kpa: Number(body.threshold_kpa), duration_minutes: Number(body.duration_minutes)};
        return zone.schedule;
      }
    }
    if (path === '/api/devices' && method === 'POST') {
      const eui = String(body.deveui).toUpperCase();
      // Restrict registration to the documented fictional identifier range; never retain AppKeys.
      if (!/^00000000000000[BC][0-9A-F]$/.test(eui) || body.appkey || body.type_id !== 'KIWI_SENSOR') return fail(422, 'demo_device');
      if (this.devices.some(d => d.deveui === eui)) return fail(409, 'duplicate');
      const zoneId = body.zone_id == null ? null : Number(body.zone_id);
      if (zoneId !== null && !this.zones.some(z => z.id === zoneId)) return fail(404, 'missing');
      const device = sensorFixture(eui, nameOf(body.name), zoneId); this.devices.push(device); return device;
    }
    const deviceMatch = path.match(/^\/api\/devices\/([^/]+)\/(sensor-history|name)$/);
    if (deviceMatch) {
      const d = this.devices.find(d => d.deveui === deviceMatch[1]); if (!d) return fail(404, 'missing');
      if (deviceMatch[2] === 'name' && method === 'PUT') {d.name = nameOf(body.name); return {...d, changed: true, sync_version: 1, chirpstack: 'skipped'};}
      if (deviceMatch[2] === 'sensor-history' && method === 'GET') {
        const field = url.searchParams.get('field') ?? 'swt_1';
        return sensorHistory(d, field, Number(url.searchParams.get('hours')) || 24);
      }
    }
    if (path === `/api/valves/${VALVE_EUI}/settings` && method === 'PUT') {
      if (Object.keys(body).some(key => key !== 'default_open_minutes')) return fail(501, 'unsupported');
      const minutes = Number(body.default_open_minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 255) return fail();
      this.defaultOpenMinutes = minutes; return {};
    }
    if (path === `/api/valve/${VALVE_EUI}/cancel` && method === 'POST') {this.close('CANCELLED'); return {};}
    if (path === `/api/valve/${VALVE_EUI}` && method === 'POST') {
      if (body.action === 'CLOSE') {this.close('CANCELLED'); return {status: 'acknowledged'};}
      const duration = Number(body.duration_seconds);
      if (body.action !== 'OPEN_FOR_DURATION' || !Number.isInteger(duration) || duration < 60 || duration > 15300) return fail();
      if (this.actuation) return fail(409, 'busy');
      const v = this.valve(); const id = `demo-command-${++this.commandId}`;
      this.actuation = {expectation_id: id, reconciliation_state: 'PENDING_OBSERVATION', commanded_at: iso(this.now), expected_close_at: iso(this.now + duration * 1000), duration_seconds: duration, trigger: 'manual'};
      v.target_state = 'OPEN';
      this.outcomes.unshift({expectationId: id, deviceEui: v.deveui, deviceName: v.name, zoneId: v.irrigation_zone_id ?? 1,
        zoneName: this.zones.find(z => z.id === v.irrigation_zone_id)?.name ?? null, commandId: id, commandedAt: iso(this.now),
        commandedDurationSeconds: duration, expectedCloseAt: this.actuation.expected_close_at, observedOpenAt: null, observedCloseAt: null,
        estimatedGrossLiters: null, flowRateLpm: null, reconciliationState: 'PENDING_OBSERVATION', cancelReason: null, trigger: 'manual',
        commandResult: null, commandResultDetail: null, commandAppliedAt: null, status: 'PENDING_OPEN'});
      return {status: 'queued'};
    }
    return fail(501, 'unsupported');
  }
}
