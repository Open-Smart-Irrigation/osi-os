'use strict';
const crypto = require('node:crypto');
const NOW = Date.parse('2026-05-10T06:05:00.000Z');
const ids = {
  zones: 'a0a61f4b7dca1c2e', mean: 'd0b2b1c1a937e16d', decide: '5f0d2b7e9b9b1b3a',
  decode: '70fcbea336401bd1', validate: '22cc64fa2a899cea', upsert: 'd7e5c762c820aa16',
};
const zone = { user_id: 1, zone_id: 2, trigger_metric: 'SWT_1', threshold_kpa: 30,
  duration_minutes: 20, valve_deveui: 'A840410000000001', enabled_scope_holders: 1 };
const rows = [{ mean_kpa: 30, n_points: 2, min_recorded_at: '2026-05-10T05:10:00Z', max_recorded_at: '2026-05-10T06:00:00Z' }];
function token(payload, secret = 'synthetic-x1-secret') {
  const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  return 'Bearer ' + data + '.' + crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
function cases() {
  const out = [];
  const add = (name, entry, msg, options = {}) => out.push({ name, entry, id: ids[entry], msg, ...options });
  const decide = (name, z = {}, r = rows, options = {}) => add(name, 'decide', { zone: { ...zone, ...z }, payload: r }, options);
  add('zones', 'zones', {});
  for (const metric of ['SWT_1', 'SWT_2', 'SWT_3', 'SWT_AVG', 'SWT_WM1', 'SWT_WM2', 'unknown', 'DENDRO']) {
    add('query-' + metric, 'mean', { payload: { ...zone, trigger_metric: metric } });
  }
  add('query-invalid-zone', 'mean', { payload: { zone_id: 'bad' } });
  add('query-absent-zone', 'mean', {});
  add('query-loader-error', 'mean', { payload: zone }, { failure: 'mean-load' });
  add('query-builder-error', 'mean', { payload: zone }, { failure: 'mean-build' });
  for (const value of [29, 30, 31, null, 0, NaN, Infinity, 'bad']) decide('swt-mean-' + String(value), {}, [{ mean_kpa: value, n_points: 2 }]);
  for (const value of [undefined, null, 0, NaN, Infinity, 'bad']) decide('swt-count-' + String(value), {}, [{ mean_kpa: 30, n_points: value }]);
  decide('swt-no-rows', {}, []);
  decide('downstream-refusal-swt', {}, rows, { dispatchRefused: true });
  decide('downstream-refusal-dendro', { trigger_metric: 'DENDRO' }, [{ irrigation_action: 'increase_10', analytics_computed_at: new Date(NOW).toISOString() }], { dispatchRefused: true });
  decide('swt-nonarray', {}, {});
  decide('swt-missing-zone', { user_id: undefined, zone_id: undefined });
  for (const field of ['user_id', 'zone_id']) for (const value of ['bad', null, 0, -1]) decide('invalid-' + field + '-' + value, { [field]: value });
  for (const valve of [undefined, '', 123, "valve'quoted"]) decide('valve-' + String(valve), { valve_deveui: valve });
  for (const value of [undefined, null, 0, -1, 'bad', Infinity, 1.5, 241]) decide('duration-' + String(value), { duration_minutes: value });
  decide('duration-nested', { duration_minutes: null, schedule: { duration_minutes: 33 } });
  for (const flag of ['0', '1']) for (const holders of [undefined, 0, 1, 2]) decide('scope-' + flag + '-' + holders, { enabled_scope_holders: holders }, rows, { env: { OSI_SCOPED_ACCESS: flag } });
  for (const last of [null, '', 'invalid', '2026-05-09T06:00:00Z', '2026-05-10T06:00:30Z', '2026-05-10T06:10:00Z', '2026-05-11T00:00:00Z']) decide('utc-' + last, { last_triggered_at: last });
  const rec = { irrigation_action: 'increase_10', action_reasoning: "tree's stress", zone_stress_summary: 'moderate', analytics_date: '2026-05-10', analytics_computed_at: new Date(NOW).toISOString(), recommendation_json: '{}' };
  const dendro = (name, z = {}, r = rec) => decide('dendro-' + name, { trigger_metric: 'DENDRO', ...z }, r === null ? [] : [r]);
  dendro('absent', {}, null);
  for (const age of [36 * 3600000 - 1, 36 * 3600000, 36 * 3600000 + 1, -1]) dendro('age-' + age, {}, { ...rec, analytics_computed_at: new Date(NOW - age).toISOString() });
  for (const t of [null, 'bad']) dendro('time-' + t, {}, { ...rec, analytics_computed_at: t });
  for (const action of ['decrease_20', 'decrease_10', 'maintain', 'maintain_rain_suppression', 'maintain_recovery_hold', 'increase_10', 'increase_20', 'emergency_irrigate', 'unsupported', '']) dendro('action-' + action, {}, { ...rec, irrigation_action: action });
  dendro('missing-valve', { valve_deveui: null });
  dendro('suppressed', { last_triggered_at: '2026-05-10T06:10:00Z' });
  dendro('duration-clamp', { duration_minutes: 240 });
  const bundle = { water: { action: { code: 'emergency_irrigate', source: 'dendro', reasoning: "server's advice", recommendationDate: '2026-05-10' } }, display: { sharedGeneratedAt: new Date(NOW).toISOString() }, drift: { serverActionCode: 'emergency_irrigate' } };
  for (const mode of ['local', 'server_preferred']) for (const age of [0, 6 * 3600000 - 1, 6 * 3600000, 6 * 3600000 + 1, -1]) dendro(mode + '-bundle-age-' + age, { scheduling_mode: mode, shared_environment_json: JSON.stringify(bundle), shared_environment_received_at: new Date(NOW - age).toISOString() });
  for (const raw of ['{bad', '{}', 'null', '']) dendro('malformed-' + raw, { scheduling_mode: 'server_preferred', shared_environment_json: raw });
  for (const action of ['unsupported', 'maintain']) dendro('server-action-' + action, { scheduling_mode: 'server_preferred', shared_environment_json: JSON.stringify({ ...bundle, water: { action: { code: action, source: 'dendro' } } }), shared_environment_received_at: new Date(NOW).toISOString() });
  dendro('wrong-source', { scheduling_mode: 'server_preferred', shared_environment_json: JSON.stringify({ ...bundle, water: { action: { code: 'maintain', source: 'swt' } } }), shared_environment_received_at: new Date(NOW).toISOString() });
  dendro('bad-bundle-time', { scheduling_mode: 'server_preferred', shared_environment_json: JSON.stringify(bundle), shared_environment_received_at: 'bad' });
  const body = { trigger_metric: 'SWT_1', threshold_kpa: 30, duration_minutes: 20 };
  const valid = { _msgid: 'x1-request', req: { params: { id: '2' } }, req_body: body, payload: [{ id: 1 }] };
  add('validate-save', 'validate', valid);
  add('validate-string', 'validate', { ...valid, req_body: JSON.stringify(body) });
  for (const payload of [[], {}, [{ id: 'bad' }]]) add('validate-user-' + JSON.stringify(payload), 'validate', { ...valid, payload });
  add('validate-zone', 'validate', { ...valid, req: { params: { id: 'bad' } } });
  for (const reqBody of ['{bad', null, {}, { ...body, metric: 'bad', trigger_metric: 'bad' }, { ...body, threshold_kpa: 0 }, { ...body, threshold_kpa: 301 }, { ...body, duration_minutes: 0 }, { ...body, duration_minutes: 241 }, { ...body, duration_minutes: 'bad' }, { ...body, response_mode: 'bad' }]) add('validate-body-' + JSON.stringify(reqBody), 'validate', { ...valid, req_body: reqBody });
  add('validate-no-request', 'validate', { ...valid, _msgid: '' });
  for (const threshold of [1, 2, 3, 4, 0, 1.1, '01', 'bad']) add('validate-dendro-' + threshold, 'validate', { ...valid, req_body: { ...body, trigger_metric: 'DENDRO', threshold_kpa: threshold } });
  for (const enabled of [undefined, false, true, 'off', 'on', 'no', 'yes', '0', '1', 'odd', 0, 2]) add('validate-enabled-' + typeof enabled + '-' + enabled, 'validate', { ...valid, req_body: { ...body, enabled } });
  add('validate-aliases', 'validate', { ...valid, req_body: { metric_id: 'swt_avg', kpa: 23, minutes: 22.6, isEnabled: false, responseMode: 'FIXED' } });
  add('validate-scoped-owner', 'validate', valid, { env: { OSI_SCOPED_ACCESS: '1' } });
  add('validate-scoped-actor-distinct', 'validate', { ...valid, payload: [{ id: 9 }] }, { env: { OSI_SCOPED_ACCESS: '1' } });
  for (const patch of [{ duration_minutes: undefined }, { duration_minutes: 0.4 }, { threshold_kpa: 300 }, { response_mode: 'aggressive' }]) add('validate-boundary-' + JSON.stringify(patch), 'validate', { ...valid, req_body: { ...body, ...patch } });
  add('validate-env-error', 'validate', valid, { failure: 'env' });
  const request = { v: 1, kind: 'zone_schedule_put', requestId: 'x1-request', actorId: 9, zoneId: 2, validatedPatch: { ...body, enabled: 1, response_mode: 'fixed' } };
  for (const version of [undefined, 0, 4]) for (const enabled of [0, 1]) add('upsert-version-' + version + '-enabled-' + enabled, 'upsert', { payload: [{ id: 2, user_id: 1, zone_uuid: 'synthetic-zone', schedule_sync_version: version, last_applied_at: null }], osi: { request: { ...request, validatedPatch: { ...request.validatedPatch, enabled } } }, syncAck: { existing: true } });
  add('upsert-missing-zone', 'upsert', { payload: [] });
  add('upsert-missing-context', 'upsert', { payload: [{ id: 2 }] });
  add('upsert-wrong-context', 'upsert', { payload: [{ id: 3 }], osi: { request } });
  const auth = { userId: 1, username: "actor's name", exp: NOW + 1000 };
  const decode = (name, header, options = {}, msg = {}) => add('auth-' + name, 'decode', { payload: body, req: { headers: { authorization: header }, params: { id: '2' } }, ...msg }, options);
  decode('valid', token(auth));
  decode('missing-request', undefined, {}, { req: undefined });
  for (const header of [undefined, 'Basic nope', 'Bearer nope', 'Bearer a.b', token('{bad'), token({ ...auth, userId: 'bad' }), token({ ...auth, username: '' }), token({ ...auth, exp: NOW - 1 }), token(auth, 'wrong')]) decode('invalid-' + header, header);
  decode('expiry-exact', token({ ...auth, exp: NOW }));
  decode('secret-missing', token(auth), { env: { AUTH_TOKEN_SECRET: '' } });
  for (const failure of ['scope-load', 'scope-load-second', 'db-open', 'db-get', 'actor', 'zone', 'access', 'role', 'db-close', 'scope-secret', 'none']) decode('scoped-' + failure, token(auth), { env: { OSI_SCOPED_ACCESS: '1' }, failure });
  decode('invalid-scoped-id', token(auth), { env: { OSI_SCOPED_ACCESS: '1' } }, { req: { headers: { authorization: token(auth) }, params: { id: '2.5' } } });
  for (const failure of ['fs-read', 'fs-write', 'fs-missing', 'fs-generate']) decode(failure, token(auth), { env: { AUTH_TOKEN_SECRET: '' }, failure });
  return out;
}
module.exports = { NOW, ids, zone, rows, cases };
