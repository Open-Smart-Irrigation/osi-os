// Design-sync preview provider: wraps every claude.ai/design preview card so
// components render outside the app shell. Uses an ISOLATED i18next instance
// via I18nextProvider — the app's own src/i18n/config.ts (pulled in by
// LanguageSwitcher's SUPPORTED_LANGUAGES import) initializes the global
// singleton with an HTTP backend that 404s in a static preview; the provider
// instance below shadows it for everything rendered inside the wrapper.
import React from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';

import common from '../public/locales/en/common.json';
import auth from '../public/locales/en/auth.json';
import dashboard from '../public/locales/en/dashboard.json';
import devices from '../public/locales/en/devices.json';
import accountLink from '../public/locales/en/accountLink.json';
import history from '../public/locales/en/history.json';
import support from '../public/locales/en/support.json';
import settings from '../public/locales/en/settings.json';

// Explicit re-export for a name the synthesized `export *` entry can't carry:
// ValveCancelButton is a default-only export, invisible to `export *`.
// (DendrometerMonitor's legacy farming/ duplicate is excluded from the synth
// set in the source-kit fork instead — a re-export here would collide with
// the synth entry's own star export and be dropped as ambiguous.)
export { default as ValveCancelButton } from './components/farming/ValveCancelButton';

const previewI18n = createInstance({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common', 'auth', 'dashboard', 'devices', 'accountLink', 'history', 'support', 'settings'],
  resources: {
    en: { common, auth, dashboard, devices, accountLink, history, support, settings },
  },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
previewI18n.init();

// ── Canned API for previews ────────────────────────────────────────────────
// Components fetch from the gateway's REST API on mount; in a static preview
// those calls 404 and paint red error banners. This XHR shim answers /api/*
// GETs with realistic canned data (or a clean 404 for unknown routes) and
// passes every non-/api request through untouched. Previews can extend the
// table by pushing [regex, dataOrFn] onto window.__dsApiRoutes before render.
type ApiRoute = [RegExp, unknown | ((m: RegExpMatchArray) => unknown)];

const nowIso = () => new Date().toISOString();
const zoneSchedule = (zoneId: number) => ({
  irrigation_zone_id: zoneId,
  trigger_metric: 'SWT_1',
  threshold_kpa: 30,
  enabled: true,
  duration_minutes: 20,
  last_triggered_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
  response_mode: null,
});
const cannedZones = [
  { id: 12, name: 'Orchard — Zone B', device_count: 2, created_at: '2026-01-01T00:00:00.000Z', updated_at: nowIso(), schedule: zoneSchedule(12) },
  { id: 13, name: 'Vineyard — Zone C', device_count: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: nowIso(), schedule: null },
];
const waterDay = (daysAgo: number, rainMm: number, liters: number) => ({
  date: new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10),
  rainMm,
  irrigationLiters: liters,
  irrigationNetMm: liters > 0 ? +(liters * 0.85 / 1200).toFixed(2) : 0,
  measuredIrrigationLiters: liters,
  estimatedIrrigationLiters: liters,
  measuredIrrigationNetMm: liters > 0 ? +(liters * 0.85 / 1200).toFixed(2) : 0,
  estimatedIrrigationNetMm: liters > 0 ? +(liters * 0.85 / 1200).toFixed(2) : 0,
  totalWaterMm: +(rainMm + liters * 0.85 / 1200).toFixed(2),
  estimatedTotalWaterMm: +(rainMm + liters * 0.85 / 1200).toFixed(2),
});
// WaterTab maps water.daily before its `available` guard — this fixture must
// always carry the full WaterEnvironment shape, arrays included.
const cannedEnvSummary = (m: RegExpMatchArray) => ({
  zoneId: Number(m[1]),
  zoneName: cannedZones.find((z) => z.id === Number(m[1]))?.name ?? 'Zone',
  generatedAt: nowIso(),
  location: { source: 'gateway', latitude: 46.94, longitude: 7.44, timezone: 'Europe/Zurich' },
  water: {
    available: true,
    observedAt: nowIso(),
    areaM2: 1200,
    irrigationEfficiencyPct: 85,
    rainTodayMm: 4.2,
    irrigationTodayLiters: 320,
    irrigationTodayNetMm: 0.23,
    irrigationTodayMeasuredLiters: 320,
    irrigationTodayEstimatedLiters: 300,
    measuredIrrigationNetMm: 0.23,
    estimatedIrrigationNetMm: 0.21,
    waterNeededTodayMm: 3.8,
    balanceTodayMm: 0.6,
    next24hRainMm: 1.5,
    action: { code: 'IRRIGATE_NORMAL', source: 'local', reasoning: 'Soil tension rising and little rain expected in the next 24 h.', recommendationDate: nowIso().slice(0, 10) },
    daily: [waterDay(6, 0, 480), waterDay(5, 2.1, 240), waterDay(4, 0, 360), waterDay(3, 8.4, 0), waterDay(2, 1.2, 120), waterDay(1, 0, 320), waterDay(0, 4.2, 320)],
    sensorHealth: { sensorCount: 2, freshSensorCount: 2, staleSensorCount: 0, rainGaugePresent: true, flowMeterPresent: false, warnings: [] },
  },
  local: { available: false, observedAt: null, sensorCount: 0, freshSensorCount: 0, staleSensorCount: 0, devices: [], metrics: [] },
  online: { available: false, observedAt: null },
  agronomic: { available: false },
  forecast: { available: false, days: [], daily: [] },
  display: null,
  drift: null,
});

const defaultApiRoutes: ApiRoute[] = [
  [/^\/api\/irrigation-zones$/, cannedZones],
  [/^\/api\/irrigation-zones\/(\d+)\/environment-summary$/, cannedEnvSummary],
  [/^\/api\/irrigation-zones\/(\d+)\/recommendations/, []],
  [/^\/api\/dendrometer\/[^/]+\/daily/, []],
  [/^\/api\/dendrometer\/[^/]+\/readings/, []],
  [/^\/api\/system\/features$/, { historyUxEnabled: true, historyComparisonEnabled: true, historyWorkspacesEnabled: true, historyAdvancedOverlaysEnabled: true, historyCloudAiEnabled: false }],
  [/^\/api\/system\/stats$/, { cpu_temp_c: 51.2, mem_total_mb: 8064, mem_used_mb: 2311, mem_free_mb: 5753, mem_percent: 28.7, load_1: 0.42, load_5: 0.35, load_15: 0.31, cpu_count: 4, fan_available: true, fan_mode: 'pwm', fan_value: 96, fan_max: 255 }],
  [/^\/api\/irrigation\/recent-actuations$/, () => ({ generatedAt: nowIso(), actuations: [] })],
];

function resolveApiRoute(method: string, url: string): unknown | undefined {
  if (method.toUpperCase() !== 'GET') return undefined;
  const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const custom = ((window as any).__dsApiRoutes ?? []) as ApiRoute[];
  for (const [rx, data] of [...custom, ...defaultApiRoutes]) {
    const m = path.match(rx);
    if (m) return typeof data === 'function' ? (data as (m: RegExpMatchArray) => unknown)(m) : data;
  }
  return undefined;
}

(() => {
  if (typeof window === 'undefined' || (window as any).__dsApiShimInstalled) return;
  (window as any).__dsApiShimInstalled = true;
  const RealXHR = window.XMLHttpRequest;

  class PreviewXHR {
    private real = new RealXHR();
    private fake = false;
    private fakeBody = '';
    // own response fields for the fake path
    readyState = 0;
    status = 0;
    statusText = '';
    response: unknown = '';
    responseText = '';
    responseType = '';
    timeout = 0;
    withCredentials = false;
    onreadystatechange: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;

    open(method: string, url: string) {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (path.startsWith('/api')) {
        this.fake = true;
        const data = resolveApiRoute(method, url);
        if (data !== undefined) {
          this.status = 200;
          this.statusText = 'OK';
          this.fakeBody = JSON.stringify(data);
        } else {
          this.status = 404;
          this.statusText = 'Not Found';
          this.fakeBody = JSON.stringify({ error: 'not available in preview' });
        }
      } else {
        this.real.open(method, url);
      }
    }
    setRequestHeader(k: string, v: string) { if (!this.fake) this.real.setRequestHeader(k, v); }
    getAllResponseHeaders() { return this.fake ? 'content-type: application/json\r\n' : this.real.getAllResponseHeaders(); }
    getResponseHeader(k: string) { return this.fake ? (k.toLowerCase() === 'content-type' ? 'application/json' : null) : this.real.getResponseHeader(k); }
    abort() { if (!this.fake) this.real.abort(); }
    addEventListener(type: string, fn: () => void) {
      if (this.fake) {
        const key = ('on' + type) as keyof PreviewXHR;
        if (key in this && (this as any)[key] === null) (this as any)[key] = fn;
      } else {
        this.real.addEventListener(type, fn);
      }
    }
    removeEventListener() { /* fake path never needs it */ }
    get upload() { return this.real.upload; }
    send(body?: unknown) {
      if (!this.fake) {
        // mirror real xhr state/events back onto this wrapper
        const mirror = () => {
          this.readyState = this.real.readyState;
          this.status = this.real.status;
          this.statusText = this.real.statusText;
          this.response = this.real.response;
          try { this.responseText = this.real.responseText; } catch { /* non-text responseType */ }
        };
        this.real.onreadystatechange = () => { mirror(); this.onreadystatechange?.(); };
        this.real.onloadend = () => { mirror(); this.onloadend?.(); };
        this.real.onload = () => { mirror(); this.onload?.(); };
        this.real.onerror = () => { mirror(); this.onerror?.(); };
        this.real.onabort = () => { mirror(); this.onabort?.(); };
        this.real.ontimeout = () => { mirror(); this.ontimeout?.(); };
        this.real.send(body as never);
        return;
      }
      setTimeout(() => {
        this.responseText = this.fakeBody;
        this.response = this.responseType === 'json' ? JSON.parse(this.fakeBody) : this.fakeBody;
        this.readyState = 4;
        this.onreadystatechange?.();
        this.onload?.();
        this.onloadend?.();
      }, 1);
    }
  }

  (window as any).XMLHttpRequest = PreviewXHR;
})();

// Seed a logged-in session so auth-aware chrome (header menu, logout) renders
// its real state instead of the anonymous fallback.
try {
  if (!window.localStorage.getItem('auth_token')) {
    window.localStorage.setItem('auth_token', 'ds-preview-token');
    window.localStorage.setItem('username', 'demo');
  }
} catch {
  // storage unavailable (sandboxed iframe) — components fall back to anonymous
}

export function DsPreviewProvider({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={previewI18n}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    </I18nextProvider>
  );
}
