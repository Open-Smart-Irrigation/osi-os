import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'] as const;
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [320, 390, 1440] as const;
const LOCALE_LABELS: Record<(typeof LOCALES)[number], RegExp> = {
  en: /English|\bEN\b/i,
  'de-CH': /Deutsch|\bDE\b/i,
  fr: /Français|\bFR\b/i,
  it: /Italiano|\bIT\b/i,
  es: /Español|\bES\b/i,
  pt: /Português|\bPT\b/i,
  lg: /Luganda|\bLG\b/i,
};
const POLICY_OPEN_LABELS: Record<(typeof LOCALES)[number], RegExp> = {
  en: /Configure conditional irrigation/i,
  'de-CH': /Bedingte Bewässerung konfigurieren/i,
  fr: /Configurer l’irrigation conditionnelle/i,
  it: /Configura l’irrigazione condizionale/i,
  es: /Configurar riego condicional/i,
  pt: /Configurar irrigação condicional/i,
  lg: /Configure conditional irrigation/i,
};
const POLICY_TITLE_LABELS: Record<(typeof LOCALES)[number], RegExp> = {
  en: /Conditional irrigation/i,
  'de-CH': /Bedingte Bewässerung/i,
  fr: /Irrigation conditionnelle/i,
  it: /Irrigazione condizionale/i,
  es: /Riego condicional/i,
  pt: /Irrigação condicional/i,
  lg: /Conditional irrigation/i,
};
const WEEKDAY_LABELS: Record<(typeof LOCALES)[number], [string, string, string, string, string, string, string]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  'de-CH': ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  fr: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'],
  it: ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'],
  es: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'],
  pt: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'],
  lg: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};
const ZONE_UUID = '22222222-2222-4222-8222-222222222222';
const POLICY_UUID = '33333333-3333-4333-8333-333333333333';
const SCHEDULE_UUID = '44444444-4444-4444-8444-444444444444';
const GATEWAY_EUI = 'A84041FFFFFF0001';
const SOIL_EUI = '0016C001F1000003';
const VALVE_EUI = '0016C001F1000001';
const SECOND_VALVE_EUI = '0016C001F1000002';
const TARGET = (process.env.TASK9B_TARGET === 'cloud' ? 'cloud' : 'edge') as 'edge' | 'cloud';
const EVIDENCE = process.env.TASK9B_EVIDENCE
  ? path.resolve(process.env.TASK9B_EVIDENCE)
  : path.resolve(process.cwd(), 'test-results/conditional-irrigation/evidence');

type BrowserState = {
  unknownApi: string[];
  externalRequest: string[];
  writes: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  actions: Array<{ path: string; commandType: string; requestId: string | null; state: string; status: number }>;
  saveCount: number;
  conflictOnce: boolean;
  alwaysRejectOnce: boolean;
  actionRejectOnce: boolean;
  pendingResponse: boolean;
  pendingActions: Array<Record<string, unknown>>;
  peer: 'supported' | 'legacy';
};

const now = '2026-10-20T08:00:00Z';

function state(): BrowserState {
  return {
    unknownApi: [], externalRequest: [], writes: [], actions: [], saveCount: 0,
    conflictOnce: false, alwaysRejectOnce: true, actionRejectOnce: true,
    pendingResponse: false, pendingActions: [], peer: 'supported',
  };
}

function json(status: number, body: unknown) {
  return { status, body };
}

function edgeZone() {
  return {
    id: 1,
    zone_uuid: ZONE_UUID,
    name: 'North block',
    user_id: 1,
    device_count: 3,
    created_at: now,
    updated_at: now,
    timezone: 'UTC',
    gateway_device_eui: GATEWAY_EUI,
    devices: [],
    schedule: { trigger_metric: 'SWT_1', threshold_kpa: 30, enabled: true, duration_minutes: 20, response_mode: 'proportional' },
  };
}

function cloudZone() {
  return {
    id: 1,
    zoneUuid: ZONE_UUID,
    name: 'North block',
    userId: 1,
    deviceCount: 3,
    createdAt: now,
    updatedAt: now,
    timezone: 'UTC',
    gatewayDeviceEui: GATEWAY_EUI,
    devices: [],
    schedule: { triggerMetric: 'SWT_1', thresholdKpa: 30, enabled: true, durationMinutes: 20, responseMode: 'proportional' },
  };
}

function edgeDevices() {
  const valve = (deveui: string, name: string) => ({
    id: deveui === VALVE_EUI ? 1 : 2,
    deveui,
    name,
    type_id: 'STREGA_VALVE',
    irrigation_zone_id: 1,
    current_state: 'CLOSED',
    target_state: 'CLOSED',
    online: true,
    claimed: true,
    last_seen: now,
    latest_data: { bat_pct: 90, bat_v: 3.7 },
  });
  return [
    valve(VALVE_EUI, 'North valve'),
    valve(SECOND_VALVE_EUI, 'South valve'),
    {
      id: 3,
      deveui: SOIL_EUI,
      name: 'North soil',
      type_id: 'KIWI_SENSOR',
      irrigation_zone_id: 1,
      online: true,
      claimed: true,
      last_seen: now,
      soil_moisture_probe_depths_json: { swt_1: 30, swt_2: 60 },
      soil_moisture_probe_depths_configured: 1,
      latest_data: { swt_1: 36, swt_2: 28, vwc_1: 18 },
    },
  ];
}

function cloudDevices() {
  const valve = (deviceEui: string, name: string, id: number) => ({
    id,
    deviceEui,
    type: 'STREGA_VALVE',
    name,
    irrigationZoneId: 1,
    currentStateJson: { state: 'CLOSED' },
    lastSeen: now,
    gatewayDeviceEui: GATEWAY_EUI,
    online: true,
    claimed: true,
    latestData: { bat_pct: 90, bat_v: 3.7 },
  });
  return [
    valve(VALVE_EUI, 'North valve', 1),
    valve(SECOND_VALVE_EUI, 'South valve', 2),
    {
      id: 3,
      deviceEui: SOIL_EUI,
      type: 'KIWI_SENSOR',
      name: 'North soil',
      irrigationZoneId: 1,
      currentStateJson: { swt_1: 36, swt_2: 28, vwc_1: 18 },
      soilMoistureProbeDepthsJson: { swt_1: 30, swt_2: 60 },
      soilMoistureProbeDepthsConfigured: true,
      lastSeen: now,
      gatewayDeviceEui: GATEWAY_EUI,
      online: true,
      claimed: true,
    },
  ];
}

function edgeValve(deviceEui: string, name: string) {
  return {
    device_eui: deviceEui,
    name,
    zone_id: 1,
    zone_name: 'North block',
    zone_uuid: ZONE_UUID,
    current_state: 'CLOSED',
    target_state: 'CLOSED',
    last_uplink_at: now,
    gateway_device_eui: GATEWAY_EUI,
    strega_generation: 'GEN2',
    scheduler_status: 'ACTIVE',
    schedule_count: 1,
    push_state: null,
    flow_rate_lpm: 12,
    default_open_minutes: 20,
  };
}

function cloudValve(deviceEui: string, name: string) {
  return {
    deviceEui,
    name,
    zoneId: 1,
    zoneName: 'North block',
    zoneUuid: ZONE_UUID,
    currentState: 'CLOSED',
    targetState: 'CLOSED',
    lastSeen: now,
    gatewayDeviceEui: GATEWAY_EUI,
    stregaGeneration: 'GEN2',
    schedulerStatus: 'ACTIVE',
    scheduleCount: 1,
    pushState: null,
    flowRateLpm: 12,
    defaultOpenMinutes: 20,
  };
}

function schedules(deviceEui: string) {
  return {
    schedules: [{
      schedule_uuid: SCHEDULE_UUID,
      device_eui: deviceEui,
      kind: 'WEEKLY',
      label: 'North run',
      weekdays_mask: 127,
      start_time: '06:00',
      duration_minutes: 20,
      timezone: 'UTC',
      enabled: true,
      sync_version: 5,
      condition_policy_uuid: POLICY_UUID,
      execution: 'conditional',
    }],
    compiled: { days: [[], [], [], [], [], [], []], errors: [] },
    push_state: [],
    settings: { strega_generation: 'GEN2', flow_rate_lpm: 12, default_open_minutes: 20 },
  };
}

function runtime() {
  return {
    availability: 'fresh',
    as_of: now,
    valid_until: '2026-10-20T08:10:00Z',
    // This fixture exercises VWC conditions, so it turns the edge VWC gate on (default off, D18).
    vwc_condition_enabled: true,
    clock: { trusted: true, reason: null },
    qualification: { qualified: false, reason: 'fixture response only; hardware qualification is not asserted' },
    source_choices: {
      SWT: [
        { kind: 'SWT', device_eui: SOIL_EUI, channel: 'SWT_1', eligible: true, name: 'North soil', depth_cm: 30 },
        { kind: 'SWT', device_eui: SOIL_EUI, channel: 'SWT_2', eligible: false, reason: 'source_unavailable', name: 'North soil', depth_cm: 60 },
      ],
      VWC: [{ kind: 'VWC', device_eui: SOIL_EUI, channel: 'VWC_1', eligible: true, name: 'North soil', depth_cm: 30 }],
      DENDRO: { kind: 'DENDRO', eligible: false, reason: 'source_unavailable', sources: [] },
    },
    valves: [
      { device_eui: VALVE_EUI, availability: 'fresh', clock: { trusted: true }, update: { state: 'FAILED', ready: false, reason: 'fixture_flush_failed' }, incident: { state: 'FAILED', reason: 'fixture incident' } },
      { device_eui: SECOND_VALVE_EUI, availability: 'fresh', clock: { trusted: true }, update: { state: 'APPLIED', ready: true }, incident: null },
    ],
  };
}

function policyView(stateValue: BrowserState) {
  const pending = stateValue.pendingResponse
    ? {
      policy_edit: {
        command_id: 'fixture-command-9b',
        event_uuid: 'fixture-event-policy-9b',
        command_type: 'UPSERT_IRRIGATION_POLICY',
        state: 'QUEUED',
        requested_at: now,
        request: { request_id: 'fixture-policy-request-9b', zone_uuid: ZONE_UUID, policy_uuid: POLICY_UUID },
      },
      actions: stateValue.pendingActions,
    }
    : { policy_edit: null, actions: stateValue.pendingActions };
  return {
    zone: { id: 1, zone_uuid: ZONE_UUID, name: 'North block', timezone: 'UTC' },
    policy: {
      policy_uuid: POLICY_UUID,
      zone_uuid: ZONE_UUID,
      condition: { kind: 'SWT', threshold_kpa: 30, sources: [{ device_eui: SOIL_EUI, channel: 'SWT_1' }] },
      timezone: 'UTC',
      enabled: true,
      observation_window_minutes: 60,
      min_interval_minutes: 60,
      max_daily_minutes: 240,
      delivery_settings: { [VALVE_EUI]: { delivery_interval_minutes: 10 } },
      sync_version: 4,
    },
    schedules: [
      { schedule_uuid: SCHEDULE_UUID, sync_version: 5, device_eui: VALVE_EUI, kind: 'WEEKLY', weekdays_mask: 127, start_time: '06:00', duration_minutes: 20, timezone: 'UTC', enabled: true, execution: 'conditional', condition_policy_uuid: POLICY_UUID, label: 'North run' },
    ],
    pending,
    runtime: runtime(),
  };
}

function environmentSummary() {
  return {
    zoneId: 1,
    zoneName: 'North block',
    generatedAt: now,
    location: { latitude: null, longitude: null, timezone: 'UTC', source: 'unavailable' },
    water: { available: false, observedAt: null, areaM2: null, irrigationEfficiencyPct: null, rainTodayMm: null, irrigationTodayLiters: null, irrigationTodayNetMm: null, waterNeededTodayMm: null, balanceTodayMm: null, next24hRainMm: null, action: null, daily: [], sensorHealth: { sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, rainGaugePresent: false, flowMeterPresent: false, warnings: [] } },
    local: { available: false, observedAt: null, sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, metrics: [], devices: [] },
    online: { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null },
    agronomic: { preferredSource: 'unavailable', current: null },
    forecast: { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null },
  };
}

function cloudLinkedGateway(peer: 'supported' | 'legacy') {
  const supported = peer !== 'legacy';
  return {
    gatewayDeviceEui: GATEWAY_EUI,
    localUserUuid: '11111111-1111-4111-8111-111111111111',
    localUsernameSnapshot: 'browser',
    serverUsernameSnapshot: 'browser',
    offlineVerifierVersion: 1,
    authSyncStatus: supported ? 'SYNCED' : 'LEGACY_UNSUPPORTED',
    linkedAuthSyncSupported: supported,
    forceEdgeSyncSupported: supported,
    fieldJournalSupported: true,
    scopedAccessSyncSupported: supported,
    scopedAccessCommandsSupported: supported,
    zoneDesiredStateSupported: supported,
    gatewayRole: 'admin',
    gatewayDisabledAt: null,
    gatewayLastSeen: now,
  };
}

function requestBody(request: { postData(): string | null }): Record<string, unknown> {
  const raw = request.postData();
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cloudAction(stateValue: BrowserState, commandType: string, body: Record<string, unknown>) {
  const requestId = typeof body.request_id === 'string' ? body.request_id : null;
  const rejected = commandType === 'PAUSE_IRRIGATION_POLICY' && stateValue.actionRejectOnce;
  stateValue.actionRejectOnce = rejected ? false : stateValue.actionRejectOnce;
  const action: Record<string, unknown> = {
    command_id: 40 + stateValue.actions.length,
    event_uuid: `fixture-event-action-${stateValue.actions.length + 1}`,
    command_type: commandType,
    state: rejected ? 'REJECTED' : 'QUEUED',
    requested_at: now,
    request: { request_id: requestId, device_eui: VALVE_EUI },
  };
  if (rejected) action.rejection_reason = 'fixture policy version changed';
  stateValue.pendingActions = [action];
  stateValue.actions.push({
    path: commandType === 'PAUSE_IRRIGATION_POLICY' ? 'pause' : 'retry-valve',
    commandType,
    requestId,
    state: String(action.state),
    status: 202,
  });
  return policyView(stateValue);
}

function isAlwaysConversion(body: Record<string, unknown>): boolean {
  return Array.isArray(body.schedules)
    && body.schedules.length > 0
    && body.schedules.every(item => item && typeof item === 'object' && (item as Record<string, unknown>).execution === 'always');
}

function fixtureResponse(request: { method(): string; url(): string }, target: 'edge' | 'cloud', stateValue: BrowserState) {
  const url = new URL(request.url());
  const method = request.method().toUpperCase();
  const p = url.pathname;
  if (target === 'edge') {
    if (method === 'GET' && p === '/api/me') return json(200, { username: 'browser', user_uuid: '11111111-1111-4111-8111-111111111111', role: 'admin', zone_uuids: null, plot_uuids: null, features: { scoped_access: false } });
    if (method === 'GET' && p === '/api/system/settings') return json(200, { gatewayTimezone: 'UTC', dataModuleEnabled: false, networkModuleEnabled: false, gatewayHubModuleEnabled: false, journalModuleEnabled: false, moduleDefaults: { dataModuleEnabled: false, networkModuleEnabled: false, gatewayHubModuleEnabled: false, journalModuleEnabled: false } });
    if (method === 'GET' && p === '/api/system/stats') return json(200, { cpu_temp_c: 40, mem_total_mb: 1000, mem_used_mb: 400, mem_free_mb: 600, mem_percent: 40, load_1: 0.2, load_5: 0.1, load_15: 0.1, cpu_count: 4, fan_available: false, fan_mode: 'none', fan_value: null, fan_max: null, restartPending: null });
    if (method === 'GET' && p === '/api/system/features') return json(200, {});
    if (method === 'GET' && p === '/api/devices') return json(200, edgeDevices());
    if (method === 'GET' && p === '/api/irrigation-zones') return json(200, [edgeZone()]);
    if (method === 'GET' && p === '/api/irrigation/recent-actuations') return json(200, { generatedAt: now, actuations: [] });
    if (method === 'GET' && /^\/api\/v1\/devices\/[0-9A-F]+\/today-liters$/i.test(p)) return json(200, { liters: null, source: 'unavailable' });
    if (method === 'GET' && p === '/api/valves') return json(200, { valves: [edgeValve(VALVE_EUI, 'North valve'), edgeValve(SECOND_VALVE_EUI, 'South valve')] });
    if (method === 'GET' && /^\/api\/valves\/[0-9A-F]+\/schedules$/i.test(p)) return json(200, schedules(p.split('/')[3].toUpperCase()));
    if (method === 'GET' && /^\/api\/irrigation-zones\/\d+\/environment-summary$/.test(p)) return json(200, environmentSummary());
    if (/^\/api\/irrigation-zones\/[^/]+\/irrigation-policy$/.test(p) && method === 'GET') {
      if (stateValue.pendingResponse && stateValue.saveCount > 0) stateValue.pendingResponse = false;
      return json(stateValue.peer === 'legacy' ? 404 : 200, stateValue.peer === 'legacy' ? { message: 'unsupported' } : policyView(stateValue));
    }
    if (/^\/api\/irrigation-zones\/[^/]+\/irrigation-policy$/.test(p) && method === 'PUT') {
      stateValue.saveCount += 1;
      const body = requestBody(request as unknown as { postData(): string | null });
      stateValue.writes.push({ method, path: p, body });
      if (stateValue.conflictOnce) { stateValue.conflictOnce = false; return json(409, { message: 'schedule_conflict', affected_ids: [SCHEDULE_UUID] }); }
      if (isAlwaysConversion(body) && stateValue.alwaysRejectOnce) {
        stateValue.alwaysRejectOnce = false;
        return json(422, { message: 'conversion_rejected', affected_ids: [SCHEDULE_UUID] });
      }
      stateValue.pendingResponse = true;
      return json(202, policyView(stateValue));
    }
    if (/^\/api\/irrigation-zones\/[^/]+\/irrigation-policy\/pause$/.test(p) && method === 'POST') {
      const body = requestBody(request as unknown as { postData(): string | null });
      stateValue.writes.push({ method, path: p, body });
      stateValue.actions.push({ path: 'pause', commandType: 'PAUSE_IRRIGATION_POLICY', requestId: null, state: 'QUEUED', status: 202 });
      return json(202, {
        status: 202,
        policy: { policy_uuid: POLICY_UUID, zone_uuid: ZONE_UUID, sync_version: 5, enabled: false },
        cancellations: [{ device_eui: VALVE_EUI, pending: true }],
        activeExpectations: [],
      });
    }
    if (/^\/api\/irrigation-zones\/[^/]+\/irrigation-policy\/retry-valve$/.test(p) && method === 'POST') {
      const body = requestBody(request as unknown as { postData(): string | null });
      stateValue.writes.push({ method, path: p, body });
      stateValue.actions.push({ path: 'retry-valve', commandType: 'RETRY_IRRIGATION_VALVE', requestId: null, state: 'QUEUED', status: 202 });
      return json(202, {
        status: 202,
        device_eui: typeof body.device_eui === 'string' ? body.device_eui : VALVE_EUI,
        revision: { revision_id: 'fixture-retry-revision-9b' },
        send: { pending: true },
      });
    }
  } else {
    if (method === 'GET' && p === '/api/v1/users/me') return json(200, { id: 1, username: 'browser', email: 'browser@example.test', role: 'USER', enabled: true, dataRetentionDays: 365, createdAt: now });
    if (method === 'GET' && p === '/api/v1/users/me/linked-gateways') return json(200, [cloudLinkedGateway(stateValue.peer)]);
    if (method === 'GET' && p === '/api/v1/user/module-preferences') return json(200, { modules: {} });
    if (method === 'GET' && p === '/api/v1/access/write-scope') return json(200, { scopedAccessEnabled: false, userId: 1, canAddDevice: true, gateways: [] });
    if (method === 'GET' && p === '/api/v1/system/features') return json(200, { historyUxEnabled: false });
    if (method === 'GET' && p === '/api/v1/devices') return json(200, cloudDevices());
    if (method === 'GET' && p === '/api/v1/irrigation-zones') return json(200, [cloudZone()]);
    if (method === 'GET' && p === '/api/v1/valves') return json(200, [cloudValve(VALVE_EUI, 'North valve'), cloudValve(SECOND_VALVE_EUI, 'South valve')]);
    if (method === 'GET' && /^\/api\/v1\/valves\/[0-9A-F]+\/schedules$/i.test(p)) return json(200, schedules(p.split('/')[4].toUpperCase()).schedules);
    if (method === 'GET' && p === '/api/v1/valves/recent-actuations') return json(200, { generatedAt: now, actuations: [] });
    if (method === 'GET' && p === '/api/v1/valves/recent-irrigations') return json(200, { recordingSince: now, irrigations: [] });
    if (method === 'GET' && /^\/api\/v1\/irrigation-zones\/[^/]+\/environment-summary$/.test(p)) return json(200, environmentSummary());
    if (/^\/api\/v1\/irrigation-zones\/by-uuid\/[^/]+\/irrigation-policy$/.test(p) && method === 'GET') {
      if (stateValue.pendingResponse && stateValue.saveCount > 0) stateValue.pendingResponse = false;
      return json(stateValue.peer === 'legacy' ? 404 : 200, stateValue.peer === 'legacy' ? { message: 'unsupported' } : policyView(stateValue));
    }
    if (/^\/api\/v1\/irrigation-zones\/by-uuid\/[^/]+\/irrigation-policy$/.test(p) && method === 'PUT') {
      stateValue.saveCount += 1;
      const body = requestBody(request as unknown as { postData(): string | null });
      stateValue.writes.push({ method, path: p, body });
      if (stateValue.conflictOnce) { stateValue.conflictOnce = false; return json(409, { message: 'schedule_conflict', affected_ids: [SCHEDULE_UUID] }); }
      if (isAlwaysConversion(body) && stateValue.alwaysRejectOnce) {
        stateValue.alwaysRejectOnce = false;
        return json(422, { message: 'conversion_rejected', affected_ids: [SCHEDULE_UUID] });
      }
      stateValue.pendingResponse = true;
      return json(202, policyView(stateValue));
    }
    if (/^\/api\/v1\/irrigation-zones\/by-uuid\/[^/]+\/irrigation-policy\/(pause|retry-valve)$/.test(p) && method === 'POST') {
      const body = requestBody(request as unknown as { postData(): string | null });
      stateValue.writes.push({ method, path: p, body });
      const commandType = p.endsWith('/pause') ? 'PAUSE_IRRIGATION_POLICY' : 'RETRY_IRRIGATION_VALVE';
      return json(202, cloudAction(stateValue, commandType, body));
    }
  }
  return undefined;
}

async function installBoundary(page: Page, target: 'edge' | 'cloud', locale: string, theme: string, stateValue: BrowserState) {
  const origin = target === 'edge' ? 'http://127.0.0.1:4181' : 'http://127.0.0.1:4182';
  await page.addInitScript(({ target: app, locale: language, theme: mode }) => {
    localStorage.setItem('auth_token', 'browser-token');
    localStorage.setItem('username', 'browser');
    if (app === 'cloud') localStorage.setItem('role', 'USER');
    localStorage.setItem('i18n_language', language);
    localStorage.setItem('i18nextLng', language);
    localStorage.setItem('osi.display.theme', mode);
    if (app === 'edge') {
      for (const key of ['predictionAdvisory', 'environment', 'waterCard', 'schedulerUi', 'valveControl']) localStorage.setItem(`osi.modules.${key}`, 'true');
    }
    (window as unknown as { global: Window }).global = window;
    class ClosedSocket extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readonly readyState = 3; readonly url = '';
      send() {}
      close() { this.dispatchEvent(new Event('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true, value: ClosedSocket });
  }, { target, locale, theme });
  page.on('request', request => {
    const requestOrigin = new URL(request.url()).origin;
    if (requestOrigin !== origin && !request.url().startsWith('data:')) stateValue.externalRequest.push(`${request.method()} ${request.url()}`);
  });
  page.on('websocket', socket => socket.close());
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { await route.abort(); return; }
    if (url.pathname.startsWith('/ws')) { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'fixture websocket closed' }) }); return; }
    if (url.pathname.startsWith('/api/')) {
      const result = fixtureResponse(request, target, stateValue);
      if (!result) {
        stateValue.unknownApi.push(`${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 599, contentType: 'application/json', body: JSON.stringify({ error: 'unknown fixture API', path: url.pathname }) });
        return;
      }
      await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
      return;
    }
    await route.continue();
  });
}

function evidencePath(name: string) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  return path.join(EVIDENCE, name);
}

async function assertBoundary(stateValue: BrowserState) {
  expect(stateValue.externalRequest, `non-local requests: ${stateValue.externalRequest.join(', ')}`).toEqual([]);
  expect(stateValue.unknownApi, `unknown API calls: ${stateValue.unknownApi.join(', ')}`).toEqual([]);
}

async function openDashboard(page: Page, target: 'edge' | 'cloud') {
  await page.goto(target === 'edge' ? '/gui/#/dashboard' : '/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByText('North block', { exact: true }).first()).toBeVisible();
}

async function assertAppearance(page: Page, target: 'edge' | 'cloud', locale: (typeof LOCALES)[number], theme: (typeof THEMES)[number]) {
  await expect(page.getByRole('button', { name: LOCALE_LABELS[locale] }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  if (target === 'cloud') await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(locale);
}

async function expandSchedule(page: Page, target: 'edge' | 'cloud' = TARGET) {
  const zone = target === 'edge'
    ? page.locator('#irrigation-zone-1')
    : page.getByRole('heading', { name: 'North block', level: 3 }).locator('..').locator('..');
  const zoneToggle = zone.locator('button[aria-expanded]').first();
  if (await zoneToggle.getAttribute('aria-expanded') === 'false') await zoneToggle.click();
  const scheduleToggle = zone.locator('button[aria-expanded]').last();
  if (await scheduleToggle.getAttribute('aria-expanded') === 'false') await scheduleToggle.click();
}

async function openPolicy(page: Page, target: 'edge' | 'cloud', entry: 'zone' | 'valve' = 'zone', locale: (typeof LOCALES)[number] = 'en') {
  if (entry === 'zone' && target === 'edge') await expandSchedule(page, target);
  if (entry === 'zone' && target === 'cloud') {
    // The cloud dashboard's always-visible plan is the stable scoped entry when the
    // per-zone scheduler module is hidden by server-side module preferences.
    const days = WEEKDAY_LABELS[locale];
    const planSchedule = page.getByRole('button', { name: new RegExp(`${days[1]}.*${days[2]}.*${days[3]}.*${days[4]}.*${days[5]}.*${days[6]}.*${days[0]}`) }).first();
    await expect(planSchedule).toBeVisible();
    await planSchedule.click();
  }
  if (entry === 'valve' && target === 'cloud') {
    await page.getByRole('button', { name: 'Schedule', exact: true }).first().click();
    const scheduleDialog = page.getByRole('dialog').last();
    await expect(scheduleDialog.getByRole('button', { name: POLICY_OPEN_LABELS[locale] })).toBeVisible();
    await scheduleDialog.getByRole('button', { name: POLICY_OPEN_LABELS[locale] }).click();
  }
  const buttons = page.getByRole('button', { name: POLICY_OPEN_LABELS[locale] });
  if (!(target === 'cloud' && (entry === 'zone' || entry === 'valve'))) {
    const button = entry === 'valve' ? buttons.last() : buttons.first();
    await expect(button).toBeVisible();
    await button.click();
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function exerciseHelp(page: Page, dialog: Locator) {
  const helpButtons = dialog.getByRole('button', { name: /^About /i });
  const helpCount = await helpButtons.count();
  expect(helpCount).toBeGreaterThan(0);
  for (let index = 0; index < helpCount; index += 1) {
    const button = helpButtons.nth(index);
    await expect(button).toBeVisible();
    const size = await button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(size.width, `help target ${index} width`).toBeGreaterThanOrEqual(44);
    expect(size.height, `help target ${index} height`).toBeGreaterThanOrEqual(44);
    const controls = await button.getAttribute('aria-controls');
    expect(controls, `help target ${index} aria-controls`).toBeTruthy();
    await expect(dialog.locator(`[id="${controls}"]`)).toHaveCount(1);
  }

  const help = dialog.getByRole('button', { name: /about conditions/i }).first();
  const controls = await help.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  const panel = dialog.locator(`[id="${controls}"]`);
  const selected = dialog.getByRole('button', { name: /SWT|soil water tension/i }).first();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  const selectedBefore = await selected.getAttribute('aria-pressed');
  const form = dialog.locator('fieldset').first();
  const formBefore = await form.boundingBox();
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  await expect(selected).toHaveAttribute('aria-pressed', selectedBefore || 'true');
  const formAfterKeyboard = await form.boundingBox();
  expect(formAfterKeyboard && formBefore && Math.abs(formAfterKeyboard.x - formBefore.x)).toBeLessThan(1);
  expect(formAfterKeyboard && formBefore && Math.abs(formAfterKeyboard.y - formBefore.y)).toBeLessThan(1);
  await dialog.getByRole('heading', { name: 'Condition', exact: true }).click();
  await expect(panel).toBeHidden();

  await help.tap();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  await expect(selected).toHaveAttribute('aria-pressed', selectedBefore || 'true');
  const formAfterTouch = await form.boundingBox();
  expect(formAfterTouch && formBefore && Math.abs(formAfterTouch.x - formBefore.x)).toBeLessThan(1);
  expect(formAfterTouch && formBefore && Math.abs(formAfterTouch.y - formBefore.y)).toBeLessThan(1);
  await dialog.getByRole('heading', { name: 'Condition', exact: true }).click();
  await expect(panel).toBeHidden();

  const moistHelp = dialog.getByRole('button', { name: 'About Moist', exact: true });
  const moistControls = await moistHelp.getAttribute('aria-controls');
  expect(moistControls).toBeTruthy();
  const moistPanel = dialog.locator(`[id="${moistControls}"]`);
  const visibleRegions = dialog.locator('[role="region"]:visible');
  await expect(visibleRegions.filter({ hasText: 'Recommended.' })).toHaveCount(0);
  await moistHelp.tap();
  await expect(moistPanel).toBeVisible();
  await expect(moistPanel).toContainText('Recommended.');
  await expect(selected).toHaveAttribute('aria-pressed', selectedBefore || 'true');
  const wetHelp = dialog.getByRole('button', { name: 'About Wet', exact: true });
  const wetControls = await wetHelp.getAttribute('aria-controls');
  expect(wetControls).toBeTruthy();
  await expect(dialog.locator(`[id="${wetControls}"]`)).toBeHidden();
  await dialog.getByRole('heading', { name: 'Condition', exact: true }).click();
  await expect(moistPanel).toBeHidden();

  await page.keyboard.press('Escape');
  // The real dialog's Escape handler closes the editor after the help disclosure has
  // received the same key. Keep this assertion explicit: it is useful evidence for the
  // operator review and avoids treating a missing tooltip button as a passed check.
  await expect(dialog).toBeHidden();
}

test.describe(`Task 9b ${TARGET} actual route`, () => {
  for (const locale of LOCALES) for (const theme of THEMES) for (const width of WIDTHS) {
    test(`${locale} ${theme} ${width}px dashboard route`, async ({ page }) => {
      const fixture = state();
      await page.setViewportSize({ width, height: 900 });
      await installBoundary(page, TARGET, locale, theme, fixture);
      await openDashboard(page, TARGET);
      await assertAppearance(page, TARGET, locale, theme);
      if (TARGET === 'edge') await expandSchedule(page, TARGET);
      const dialog = await openPolicy(page, TARGET, 'zone', locale);
      await expect(dialog.getByRole('heading', { name: POLICY_TITLE_LABELS[locale] })).toBeVisible();
      await page.screenshot({ path: evidencePath(`${TARGET}-policy-${locale}-${theme}-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await assertBoundary(fixture);
    });
  }

  test('supports real zone editor help, source, target, timing, conversion and retry paths', async ({ page }) => {
    const fixture = state(); fixture.conflictOnce = true;
    await page.setViewportSize({ width: 390, height: 900 });
    await installBoundary(page, TARGET, 'en', 'light', fixture);
    await openDashboard(page, TARGET);
    await assertAppearance(page, TARGET, 'en', 'light');
    let dialog = await openPolicy(page, TARGET);
    await exerciseHelp(page, dialog);
    dialog = await openPolicy(page, TARGET);
    const unavailableOption = dialog.locator('option').filter({ hasText: /unavailable/i }).first();
    if (await unavailableOption.count()) {
      await expect(unavailableOption).toBeAttached();
    } else {
      await expect(dialog.getByRole('checkbox', { name: /unavailable/i }).first()).toBeAttached();
    }
    await dialog.getByRole('button', { name: /VWC/i }).click();
    const numberInput = dialog.locator('input[type="number"]').first();
    await numberInput.fill('22');
    const vwcCheckbox = dialog.getByRole('checkbox', { name: /North soil.*VWC/i }).first();
    if (await vwcCheckbox.count()) {
      await vwcCheckbox.check();
    } else {
      const selects = dialog.locator('select');
      const selectCount = await selects.count();
      for (let index = 0; index < selectCount; index += 1) {
        const select = selects.nth(index);
        const option = select.locator('option').filter({ hasText: /North soil.*VWC/i }).first();
        if (await option.count()) {
          const value = await option.getAttribute('value');
          if (value) { await select.selectOption(value); break; }
        }
      }
    }
    await dialog.getByRole('radio', { name: /selected days/i }).check();
    const startTime = dialog.locator('input[type="time"]').first();
    await expect(startTime).toBeVisible();
    await startTime.fill('07:15');
    const scheduleDuration = dialog.locator('input[type="number"]').nth(1);
    await scheduleDuration.fill('31');
    await dialog.getByRole('checkbox', { name: /\bMon$/i }).first().uncheck();
    await dialog.getByText(/Advanced settings/i, { exact: true }).click();
    const deliveryInterval = dialog.locator('label').filter({ hasText: /Delivery interval/i }).locator('input[type="number"]').first();
    await expect(deliveryInterval).toBeVisible();
    await deliveryInterval.fill('17');
    await dialog.getByRole('button', { name: /Save policy/i }).click();
    await expect(dialog.getByText(/schedule_conflict|conflict/i)).toBeVisible();
    const firstSave = fixture.writes.find(write => write.method === 'PUT');
    expect(firstSave).toBeDefined();
    const firstSchedule = Array.isArray(firstSave?.body.schedules)
      ? firstSave.body.schedules.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).schedule_uuid === SCHEDULE_UUID) as Record<string, unknown> | undefined
      : undefined;
    expect(firstSchedule).toEqual(expect.objectContaining({ schedule_uuid: SCHEDULE_UUID, start_time: '07:15', duration_minutes: 31, weekdays_mask: 125 }));
    expect(firstSave?.body.delivery_settings).toEqual(expect.objectContaining({ [VALVE_EUI]: { delivery_interval_minutes: 17 } }));
    // The first 409 is a schedule conflict. A second save proves the same draft can
    // be accepted and observed as a pending policy edit before the action checks.
    if (TARGET === 'cloud') {
      await dialog.getByRole('button', { name: /Save policy/i }).click();
      await expect(dialog.getByText(/Pending policy edit: QUEUED/i)).toBeVisible();
    }
    await dialog.getByRole('checkbox', { name: /South valve/i }).check();
    await expect(dialog.getByRole('button', { name: /Retry update/i })).toBeVisible();
    await dialog.getByRole('button', { name: /Retry update/i }).click();
    await expect(dialog.getByRole('status').filter({ hasText: /Action status/i })).toContainText(/retry/i);
    if (TARGET === 'cloud') await expect(dialog.getByRole('status').filter({ hasText: /Action status/i })).toContainText(/QUEUED/i);
    else await expect(dialog.getByRole('status').filter({ hasText: /Action status/i })).toContainText(/202/i);
    await dialog.getByRole('button', { name: /Pause/i }).click();
    await expect(dialog.getByRole('status').filter({ hasText: /Action status/i })).toContainText(/pause/i);
    if (TARGET === 'cloud') {
      await expect(dialog.getByRole('status').filter({ hasText: /Action status/i })).toContainText(/REJECTED/i);
      await expect(dialog.getByRole('alert')).toContainText(/REJECTED/i);
    } else {
      await expect(dialog.getByRole('status').filter({ hasText: /Action status/i })).toContainText(/202/i);
    }
    expect(fixture.actions.map(action => ({ commandType: action.commandType, state: action.state, status: action.status }))).toEqual(
      TARGET === 'cloud'
        ? [
          { commandType: 'RETRY_IRRIGATION_VALVE', state: 'QUEUED', status: 202 },
          { commandType: 'PAUSE_IRRIGATION_POLICY', state: 'REJECTED', status: 202 },
        ]
        : [
          { commandType: 'RETRY_IRRIGATION_VALVE', state: 'QUEUED', status: 202 },
          { commandType: 'PAUSE_IRRIGATION_POLICY', state: 'QUEUED', status: 202 },
        ],
    );
    await page.screenshot({ path: evidencePath(`${TARGET}-policy-editor-en-light-390.png`), fullPage: true });
    const convert = dialog.getByRole('button', { name: /Convert to Always/i });
    await convert.click();
    await expect(dialog.getByRole('alert')).toContainText(/conversion_rejected/i);
    await expect(dialog.locator('input[type="time"]').first()).toHaveValue('07:15');
    await expect(dialog.locator('input[type="number"]').nth(1)).toHaveValue('31');
    // The failed conversion leaves the edited draft mounted. Retrying the same
    // control sends an explicit execution=always row and then closes on 202.
    await convert.click();
    await expect.poll(() => fixture.writes.filter(write => write.method === 'PUT').length).toBeGreaterThan(TARGET === 'cloud' ? 3 : 2);
    const conversionWrites = fixture.writes.filter(write => write.method === 'PUT' && isAlwaysConversion(write.body));
    expect(conversionWrites.length).toBe(2);
    await expect(page.getByRole('dialog')).toBeHidden();
    await openPolicy(page, TARGET, 'valve');
    await expect(page.getByRole('dialog')).toBeVisible();
    if (TARGET === 'cloud') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openDashboard(page, TARGET);
      const reapplied = await openPolicy(page, TARGET, 'zone');
      await expect(reapplied.getByText(/Pending policy edit:/i)).toHaveCount(0);
    }
    await assertBoundary(fixture);
  });

  test('keeps old peer response unsupported and does not use a legacy fallback endpoint', async ({ page }) => {
    const fixture = state(); fixture.peer = 'legacy';
    await installBoundary(page, TARGET, 'en', 'light', fixture);
    await openDashboard(page, TARGET);
    await assertAppearance(page, TARGET, 'en', 'light');
    const dialog = await openPolicy(page, TARGET);
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(fixture.writes).toEqual([]);
    await assertBoundary(fixture);
  });
});
