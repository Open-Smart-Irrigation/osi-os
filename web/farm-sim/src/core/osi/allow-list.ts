import {validatePlan} from '@osi-demo/model/plans';
import {DAY_MS, FARM_SITE, localDate, localDateStart, localDayStart} from '../time';
import type {Tier} from '../types';
import {FORECAST_LOOKAHEAD_DAYS} from '../weather';
import {METER_EUI, PLANS_PATH, PROBE_EUI, VALVE_EUI, VALVE_PATH, ZONE_PATH} from './farm-builder';

type Body = Record<string, unknown>;
export type Refusal = 'game_refused' | 'game_tier' | 'invalid';
type Result = {body: Body} | {code: Refusal};
type Rule = {tier: Tier; keys: readonly string[]; valid?: (body: Body) => boolean};
const planKeys = ['kind', 'weekdays_mask', 'start_time', 'fire_at', 'duration_minutes', 'label', 'enabled'];
const swtMetrics = ['SWT_1', 'SWT_2', 'SWT_AVG'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const zonedInstant = /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/;

const integer = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const positive = (value: unknown, max: number) =>
  typeof value === 'number' && value > 0 && value <= max;

function plainObject(value: unknown): value is Body {
  if (typeof value !== 'object' || value === null) return false;
  const proto: object | null = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  // The phone can pass a plain object created in another realm.
  const constructor: unknown = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
  return Object.getPrototypeOf(proto) === null && typeof constructor === 'function'
    && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
}

const rules = new Map<string, Rule>([
  ['PUT ' + ZONE_PATH + '/name', {tier: 1, keys: ['name'], valid: b => typeof b.name === 'string'}],
  ['POST /api/irrigation-zones/schedules/disable-all', {tier: 1, keys: []}],
  ['POST ' + VALVE_PATH, {tier: 3, keys: ['action', 'duration_seconds'],
    valid: b => b.action === 'CLOSE' ? !('duration_seconds' in b)
      : b.action === 'OPEN_FOR_DURATION' && integer(b.duration_seconds, 60, 15_300)}],
  ['POST ' + VALVE_PATH + '/cancel', {tier: 3, keys: ['reason'], valid: b => b.reason === 'operator_cancel'}],
  ['PUT ' + PLANS_PATH + '/settings', {tier: 3, keys: ['default_open_minutes'],
    valid: b => integer(b.default_open_minutes, 1, 255)}],
  ['POST ' + PLANS_PATH + '/schedules', {tier: 3, keys: planKeys, valid: b => validatePlan(b).ok}],
  ['POST ' + PLANS_PATH + '/plan/resend', {tier: 3, keys: []}],
  ['POST ' + PLANS_PATH + '/scheduler-status', {tier: 3, keys: ['status'],
    valid: b => b.status === 'ACTIVE' || b.status === 'SKIP_TODAY' || b.status === 'DEACTIVATED'}],
  ['PUT ' + ZONE_PATH + '/schedule', {tier: 4,
    keys: ['trigger_metric', 'threshold_kpa', 'enabled', 'duration_minutes'],
    valid: b => typeof b.enabled === 'boolean' && positive(b.threshold_kpa, 300)
      && (b.duration_minutes === undefined || positive(b.duration_minutes, 240))}],
]);

const deviceTiers = new Map<string, Tier>([[PROBE_EUI, 1], [METER_EUI, 2], [VALVE_EUI, 3]]);

function ruleFor(method: string, pathname: string): Rule | undefined {
  const device = /^\/api\/devices\/([^/]+)\/name$/.exec(pathname);
  if (method === 'PUT' && device) {
    const tier = deviceTiers.get(device[1]);
    return tier === undefined ? undefined : {tier, keys: ['name'], valid: b => typeof b.name === 'string'};
  }
  const prefix = PLANS_PATH + '/schedules/';
  if (pathname.startsWith(prefix) && uuid.test(pathname.slice(prefix.length))) {
    if (method === 'PUT') return {tier: 3, keys: planKeys};
    if (method === 'DELETE') return {tier: 3, keys: []};
  }
  return rules.get(method + ' ' + pathname);
}

export function normalizePath(path: string): URL | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  const url = new URL(path, 'http://demo.invalid');
  return url.origin === 'http://demo.invalid' && !url.pathname.startsWith('//') ? url : null;
}

export function checkWrite(tier: Tier, method: string, pathname: string, input: unknown): Result {
  const rule = ruleFor(method, pathname);
  if (!rule) return {code: 'game_refused'};
  if (tier < rule.tier) return {code: 'game_tier'};
  const body = input ?? {};
  if (!plainObject(body)) return {code: 'invalid'};
  const keys = Reflect.ownKeys(body);
  if (keys.some(key => typeof key !== 'string' || !rule.keys.includes(key))) return {code: 'game_refused'};
  // Copy the flat wire fields into this realm before dispatch or logging.
  const clean: Body = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(body, key);
    if (typeof key !== 'string' || !property || !('value' in property)) return {code: 'invalid'};
    const value: unknown = property.value;
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
      && !(typeof value === 'number' && Number.isFinite(value))) return {code: 'invalid'};
    clean[key] = value;
  }
  if (pathname === ZONE_PATH + '/schedule' && !swtMetrics.includes(String(clean.trigger_metric))) {
    return {code: 'game_refused'};
  }
  if ('fire_at' in clean) {
    const value = clean.fire_at;
    const at = typeof value === 'string' && zonedInstant.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) return {code: 'invalid'};
    clean.fire_at = new Date(at).toISOString();
  }
  if (rule.keys === planKeys && (
    ('enabled' in clean && typeof clean.enabled !== 'boolean') ||
    ('label' in clean && clean.label !== null && (typeof clean.label !== 'string' || clean.label.length > 80)) ||
    ('duration_minutes' in clean && !integer(clean.duration_minutes, 1, 1439)) ||
    ('weekdays_mask' in clean && !integer(clean.weekdays_mask, 1, 127))
  )) return {code: 'invalid'};
  if (rule.valid && !rule.valid(clean)) return {code: 'invalid'};
  return {body: clean};
}

export function checkRead(tier: Tier, url: URL, now: number): Refusal | null {
  const path = url.pathname;
  if (/^\/(?:api\/)?(?:network|journal|analysis)(?:\/|$)/.test(path)
    || /^\/api\/history\/gateways(?:\/|$)/.test(path)
    || /(?:^|\/)export(?:[./]|$)/.test(path)
    || /\/irrigation-policy(?:\/|$)/.test(path)
    || /\/devices\/[^/]+\/(installation-location|radio-configuration)(?:\/|$)/.test(path)
    || path === '/auth/login' || path === '/auth/register') return 'game_refused';
  const zone = /^\/api\/(?:history\/zones|irrigation-zones)\/(\d+)(?:\/|$)/.exec(path);
  if (zone && zone[1] !== '1') return 'game_refused';
  const device = /^\/api\/(devices|v1\/devices|valves?|dendrometer)\/([^/]+)(?:\/|$)/.exec(path);
  if (device) {
    const minimum = deviceTiers.get(device[2]);
    if (minimum === undefined || (device[1].startsWith('valve') && device[2] !== VALVE_EUI)) return 'game_refused';
    if (tier < minimum) return 'game_tier';
  }
  if (path.startsWith('/api/history/')) {
    const timezone = url.searchParams.get('timezone');
    if (timezone && timezone !== FARM_SITE.timezone) return 'game_refused';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (from === null && to === null) return null;
    const start = from && zonedInstant.test(from) ? Date.parse(from) : NaN;
    const end = to && zonedInstant.test(to) ? Date.parse(to) : NaN;
    const today = localDayStart(now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < today - 92 * DAY_MS || start >= end) return 'game_refused';
    const hasForecast = tier >= 2 && /(?:%3a|:)environment(?:%3a|:)microclimate\/(?:data|advanced)$/i.test(path);
    const latest = hasForecast ? today + (FORECAST_LOOKAHEAD_DAYS + 1) * DAY_MS : now;
    if (end <= latest) return null;

    // The phone requests the whole current month to show future dates as empty calendar cells.
    if (url.searchParams.get('view') === 'calendar') {
      const monthStart = localDateStart(localDate(now).slice(0, 7) + '-01');
      const nextMonth = localDateStart(localDate(monthStart + 31 * DAY_MS).slice(0, 7) + '-01');
      if (start === monthStart && end === nextMonth - 1) return null;
    }
    return 'game_refused';
  }
  return null;
}
