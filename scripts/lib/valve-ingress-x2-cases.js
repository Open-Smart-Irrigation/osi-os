'use strict';
// Baseline cases are shared by the VM and real Function-node runtime runners.
const crypto = require('node:crypto');
const EUI = 'A840410000000001';
const GATEWAY = '0016C001F1000001';
const NOW = Date.parse('2026-11-20T06:00:00.000Z');
const SECRET = 'x2-fixture-secret';
const ROUTER = '934bf2bc19a8ce22';
const AUTH = '83bb4a452dd9ae37';
const CANCEL = 'cancel-strega-actuation-fn';
const ADVANCED = ['interval', 'model', 'timed', 'magnet', 'partial', 'flush'];
function token(payload = { userId: 1, username: 'grower', exp: NOW + 60000 }, raw) {
  const text = Buffer.from(raw === undefined ? JSON.stringify(payload) : raw).toString('base64url');
  return 'Bearer ' + text + '.' + crypto.createHmac('sha256', SECRET).update(text).digest('base64url');
}
function request(payload = {}, fields = {}) {
  return { _msgid: 'request-1', payload, req: { headers: { authorization: token() }, params: { deveui: EUI.toLowerCase() }, query: {} }, res: { marker: 'response' }, ...fields };
}
function cases() {
  const out = [];
  const add = (name, id, msg, options = {}) => out.push({ name, id, msg, options });
  const meta = { commandId: 'command-1', command_id: 'snake-command', eventUuid: 'event-1', aggregateType: 'device', aggregateKey: 'key-1', appliedSyncVersion: 0, actor_user_uuid: 'actor-1', deviceEui: EUI.toLowerCase() };
  const route = (name, commandType, fields = {}, options = {}) => {
    const payload = { ...meta, commandType, ...fields };
    add('route/' + name, ROUTER, { _msgid: 'cloud-1', payload }, options);
    add('route-string/' + name, ROUTER, { _msgid: 'cloud-1', payload: JSON.stringify(payload) }, options);
  };
  for (const [name, type, fields] of [
    ['open', 'OPEN_FOR_DURATION', { duration_seconds: 120 }], ['close', 'CLOSE', {}],
    ['duration-precedence', 'OPEN_FOR_DURATION', { duration_seconds: 61, durationMinutes: 4, duration_minutes: 5 }],
    ['minutes-camel', 'OPEN_FOR_DURATION', { durationMinutes: 3 }], ['minutes-snake', 'OPEN_FOR_DURATION', { duration_minutes: 4 }],
    ['non-finite', 'OPEN_FOR_DURATION', { duration_seconds: 'bad' }], ['no-duration', 'OPEN_FOR_DURATION', {}],
    ['indefinite-open', 'OPEN', {}], ['valve-allowed', 'VALVE_COMMAND', { action: 'OPEN_FOR_DURATION', duration_seconds: 1 }],
    ['valve-close-refused', 'VALVE_COMMAND', { action: 'CLOSE', duration_seconds: 120 }],
    ['valve-unbounded-refused', 'VALVE_COMMAND', { action: 'OPEN' }],
    ['valve-over-limit', 'VALVE_COMMAND', { action: 'OPEN_FOR_DURATION', duration_seconds: 15301 }],
    ['timed-open', 'SET_STREGA_TIMED_ACTION', { action: 'OPEN', duration_seconds: 120, payloadHex: 'BAD', fPort: 99 }],
    ['timed-close-refused', 'SET_STREGA_TIMED_ACTION', { action: 'CLOSE', duration_seconds: 120 }],
    ['timed-no-duration', 'SET_STREGA_TIMED_ACTION', { action: 'OPEN', unit: 'MINUTES', amount: 2 }],
    ['interval', 'SET_STREGA_INTERVAL', { closedIntervalMinutes: 10, openIntervalMinutes: 2, tamperDisabled: true }],
    ['model', 'SET_STREGA_MODEL', { model: 'motorized' }], ['magnet', 'SET_STREGA_MAGNET_MODE', { enabled: true }],
    ['magnet-false', 'SET_STREGA_MAGNET_MODE', { enabled: 'false' }],
    ...['OPEN', 'CLOSE'].flatMap(action => [
      ['partial-' + action, 'SET_STREGA_PARTIAL_OPENING', { action, percentage: 50 }],
      ['flushing-' + action, 'SET_STREGA_FLUSHING', { returnPosition: action, percentage: 25 }],
    ]),
    ['lsn-mode', 'SET_LSN50_MODE', { mode: 'MOD6' }], ['lsn-interval', 'SET_LSN50_INTERVAL', { intervalMinutes: 10 }],
    ['kiwi-interval', 'SET_KIWI_INTERVAL', { intervalMinutes: 2 }], ['kiwi-enable', 'ENABLE_KIWI_TEMP_HUMIDITY', { intervalMinutes: 4 }],
    ['identify', 'SET_SDI12_IDENTIFY', {}], ['interrupt', 'SET_LSN50_INTERRUPT_MODE', { interruptMode: 2 }],
    ['warmup', 'SET_LSN50_5V_WARMUP', { milliseconds: 500 }],
    ...['UPSERT_IRRIGATION_POLICY','PAUSE_IRRIGATION_POLICY','RETRY_IRRIGATION_VALVE','UPDATE_SCHEDULE','UPSERT_SCHEDULE','UPSERT_ZONE','DELETE_ZONE','UPSERT_ZONE_CONFIG','UPSERT_ZONE_LOCATION','ASSIGN_DEVICE_TO_ZONE','REMOVE_DEVICE_FROM_ZONE','UPSERT_DEVICE_FLAGS','UNCLAIM_DEVICE','UPSERT_VALVE_SCHEDULE','DELETE_VALVE_SCHEDULE','RESEND_VALVE_PLAN','SET_VALVE_SCHEDULER_STATUS','CANCEL_VALVE_ACTUATION','UPSERT_VALVE_SETTINGS','REGISTER_DEVICE','SYNC_LINKED_AUTH','FORCE_EDGE_SYNC','UC512_OPEN_FOR_DURATION','UNKNOWN'].map(type => [type, type, {}]),
    ['snake-fields', '', { commandType: undefined, command_type: ' open_for_duration ', deviceEui: undefined, device_eui: EUI, actor_user_uuid: undefined, actorUserUuid: ' actor-2 ', duration_minutes: 5 }],
    ['fan-hwmon', 'SET_FAN', { speed: 180 }], ['fan-auto', 'SET_FAN', { speed: 0 }], ['fan-clamp', 'SET_FAN', { speed: 300.4 }],
    ['reboot', 'REBOOT', {}],
  ]) route(name, type, fields);
  for (const mode of ['missing', 'pwm', 'pwm-existing', 'hwmon-write-error', 'hwmon-dir-error', 'hwmon-read-error', 'hwmon-enable-error', 'pwm-disable-error', 'pwm-duty-error', 'pwm-period-error', 'pwm-enable-error', 'pwm-export-error', 'pwm-read-error']) route('fan-' + mode, 'SET_FAN', { speed: 120 }, { fan: mode });
  route('reboot-schedule-error', 'REBOOT', {}, { timerError: true });
  route('reboot-process-error-after-ACK', 'REBOOT', {}, { execError: true });
  add('route/malformed-json', ROUTER, { payload: '{' });
  add('route/null', ROUTER, { payload: null });
  const validBodies = {
    [AUTH]: { action: 'OPEN_FOR_DURATION', duration_minutes: 2 },
    [CANCEL]: { expectation_id: 'expectation-1', reason: 'operator_cancel' },
    'put-strega-interval-auth-fn': { minutes: 10, openedMinutes: 2, tamperDisabled: true },
    'put-strega-model-auth-fn': { model: 'MOTORIZED' },
    'put-strega-timed-auth-fn': { action: 'CLOSE', unit: 'minutes', amount: 2 },
    'put-strega-magnet-auth-fn': { enabled: true },
    'put-strega-partial-auth-fn': { action: 'CLOSE', percentage: 50 },
    'put-strega-flush-auth-fn': { returnPosition: 'CLOSE', percentage: 50 },
  };
  for (const [id, body] of Object.entries(validBodies)) {
    const label = id === AUTH ? 'manual' : id === CANCEL ? 'cancel' : id.split('-')[2];
    const reqCase = (name, payload, options = {}, edit = () => {}) => { const msg = request(payload); edit(msg); add(label + '/' + name, id, msg, options); };
    reqCase('valid', body);
    for (const [name, authorization] of [
      ['missing-bearer', undefined], ['malformed-token', 'Bearer bad'], ['empty-token', 'Bearer .'],
      ['wrong-signature', token() + 'bad'], ['expired', token({ userId: 1, username: 'grower', exp: NOW - 1 })],
      ['exact-expiry', token({ userId: 1, username: 'grower', exp: NOW })],
      ['invalid-json', token({}, '{')], ['invalid-user', token({ userId: 'NaN', username: 'grower' })],
      ['missing-username', token({ userId: 1 })], ['null-token-payload', token({}, 'null')],
      ['nonfinite-expiry', token({ userId: 1, username: 'grower', exp: 'bad' })], ['no-expiry', token({ userId: 1, username: 'grower' })],
    ]) reqCase(name, body, {}, msg => { msg.req.headers.authorization = authorization; });
    reqCase('missing-request', body, {}, msg => { delete msg.req; });
    reqCase('missing-params', body, {}, msg => { delete msg.req.params; });
    reqCase('missing-eui', body, {}, msg => { msg.req.params.deveui = ''; });
    reqCase('quoted-eui', body, {}, msg => { msg.req.params.deveui = "a'bc"; });
    reqCase('invalid-body', {});
    reqCase('json-string-body', JSON.stringify(body));
    for (const mode of ['read', 'fallback-read', 'read-error', 'generate', 'write-error', 'no-fs', 'absent']) reqCase('secret-' + mode, body, { secret: mode });
    reqCase('scope-secret-unavailable', body, { scoped: true, scopeMissing: true });
    reqCase('scope-secret-throws', body, { scoped: true, scopeSecretError: true });
    reqCase('scoped-valid', body, { scoped: true });
    if ([AUTH, CANCEL, 'put-strega-timed-auth-fn'].includes(id)) {
      for (const mode of ['missing-actor', 'scope-403', 'scope-404', 'scope-500', 'viewer', 'db-error', 'db-open-error', 'close-error', 'scope-second-load-missing']) reqCase(mode, body, { scoped: true, mode });
    }
  }
  for (const [name, payload] of [
    ['indefinite', { action: 'OPEN' }], ['missing-action', {}], ['invalid-action', { action: 'dance' }],
    ['close', { action: 'closeValve' }], ['close-duration', { action: 'CLOSE_FOR', duration: 2 }],
    ['seconds-precedence', { action: 'OPEN', duration_seconds: 120, duration_minutes: 5 }],
    ['zero', { action: 'OPENFOR', duration_minutes: 0 }], ['fractional', { action: 'OPEN_FOR', duration_minutes: 1.5 }],
    ['seconds-fraction', { action: 'OPEN', duration_seconds: 61 }], ['seconds-zero', { action: 'OPEN', duration_seconds: 0 }],
    ['max', { action: 'OPEN_VALVE', duration_minutes: 255 }], ['over-max', { action: 'OPEN', duration_minutes: 256 }],
    ['bad-duration', { action: 'OPEN', duration_minutes: 'bad' }],
  ]) add('manual/' + name, AUTH, request(payload));
  const noId = request(validBodies[AUTH]); delete noId._msgid; add('manual/missing-id', AUTH, noId);
  const query = request({}); query.req.query = { action: 'OPENFOR', durationSeconds: 180 }; add('manual/query', AUTH, query);
  for (const [kind, bodies] of Object.entries({
    interval: [{ minutes: 0 }, { minutes: 256 }, { minutes: 1.5 }, { minutes: 10, openedMinutes: 0 }, { minutes: 10, openedMinutes: 256 }, { closedMinutes: 255, openedMinutes: 255 }, { minutes: 1 }],
    model: [{ model: 'STANDARD' }, { model: 'other' }],
    timed: ['OPEN','CLOSE'].flatMap(action => ['seconds','minutes','hours','invalid'].flatMap(unit => [0,1,255,256,1.5].map(amount => ({ action, unit, amount })))),
    magnet: [{ enabled: false }, { enabled: 'true' }, { enabled: 'false' }, { enabled: 0 }, { enabled: null }],
    partial: ['OPEN','CLOSE','INVALID'].flatMap(action => [0,1,100,101,1.5].map(percentage => ({ action, percentage }))),
    flush: ['OPEN','CLOSE','INVALID'].flatMap(returnPosition => [0,1,100,101,1.5].map(percentage => ({ returnPosition, percentage }))),
  })) bodies.forEach((body, i) => add(kind + '/boundary-' + i, 'put-strega-' + kind + '-auth-fn', request(body)));
  for (const [name, payload, fields] of [
    ['no-user', [], {}], ['valid', [{ id: 1 }], { osi: { request: { kind: 'valve_command', targetEui: EUI } } }],
    ['context-missing', [{ id: 1 }], {}],
  ]) add('ownership/' + name, '9ad895844533fb35', request(payload, fields));
  const row = { deveui: EUI, type_id: 'STREGA_VALVE', user_id: 1, irrigation_zone_id: 2 };
  for (const [name, rows, fields] of [
    ['valid', [row], {}], ['no-device', [], {}], ['other-owner', [{ ...row, user_id: 2 }], {}],
    ['unclaimed', [{ ...row, user_id: null }], {}], ['wrong-type', [{ ...row, type_id: 'MILESIGHT_UC512' }], {}],
    ['context-missing', [row], { osi: {} }], ['context-mismatch', [row], { osi: { request: { kind: 'valve_command', targetEui: 'OTHER' } } }],
    ['close', [row], { osi: { request: { kind: 'valve_command', targetEui: EUI, actorId: 1, action: 'CLOSE', durationMinutes: null } } }],
  ]) add('build/' + name, 'dde8e1ef265e96d7', request(rows, { osi: { request: { kind: 'valve_command', targetEui: EUI, actorId: 1, action: 'OPEN_FOR_DURATION', durationMinutes: 2 } }, actor_user_uuid: 'actor-1', ...fields }));
  for (const action of ['MODEL','TIMED_ACTION','MAGNET_MODE','PARTIAL_OPENING','FLUSHING','UNKNOWN']) {
    add('format/' + action, 'put-strega-advanced-format', request({}, { _strega_local_action: action, _strega_model: 'MOTORIZED', _strega_timed_action: 'CLOSE', _strega_timed_unit: 'MINUTES', _strega_timed_amount: 2, _strega_enabled: true, _strega_partial_action: 'CLOSE', _strega_percentage: 50, _strega_return_position: 'CLOSE', _strega_payload_hex: '3032', _strega_fport: 28 }));
    add('format-default/' + action, 'put-strega-advanced-format', request({}, { _strega_local_action: action }));
  }
  for (const [name, ctx] of [['missing', undefined], ['empty', {}], ['open', { devEui: EUI, action: 'OPEN_FOR_DURATION', duration_minutes: 2, zone_id: 2, reason: 'manual_gui', created_at: '2026-11-20T06:00:00.000Z' }], ['partial', { devEui: EUI, action: 'PARTIAL_OPENING', percentage: 50, returnPosition: 'CLOSE' }], ['quotes', { devEui: "a'b", action: "c'd", reason: "e'f", created_at: "g'h", zone_id: 'bad', duration_minutes: 'bad' }]]) add('log/' + name, '5c45136f382d501c', request({}, { _log_ctx: ctx }));
  for (const mode of ['not-found','wrong-type','other-owner','db-error','module-missing','client-error','cancel-error','shape-error','close-error']) add('cancel/legacy-' + mode, CANCEL, request(validBodies[CANCEL]), { mode });
  for (const error of ['ambiguous_actuation','actuation_not_active','no_active_actuation','not_found','not_a_valve','actuation_handed_off','transport_uncertain','unexpected']) {
    add('cancel/outcome-' + error, CANCEL, request(validBodies[CANCEL]), { cancelResult: { ok: false, error, outcome: error === 'actuation_handed_off' ? 'handed_off' : 'uncertain', uncertainty: 'flush_failed', collateral: [{ expectation_id: 'other', outcome: 'dropped' }], expectationId: 'expectation-1', droppedOpens: 2, queueScope: 'full_flush' } });
  }
  add('cancel/already-running', CANCEL, request(validBodies[CANCEL]), { cancelResult: { ok: false, error: 'actuation_handed_off', outcome: 'already_running' } });
  return out;
}
module.exports = { cases, EUI, GATEWAY, NOW, SECRET, ROUTER, AUTH, CANCEL, ADVANCED };
