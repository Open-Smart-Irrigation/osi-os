'use strict';
const crypto = require('node:crypto');
const { lazyTransport } = require('./push');

function liveDeleteValveCleanup({ msg, node, env, chirpstack, osiLib }) {
// F104 / exploratory X-04: a device "delete" is an unclaim, and an unclaimed STREGA valve
// keeps executing the weekly plan held in its own firmware -- with the device gone from the
// GUI there is no surface left to remove it from. Clear that plan on the way out, through
// the same osi-valve-control path the explicit schedule delete uses. Everything else on this
// wire (both delete routes send their failures down it too) passes through untouched.
const eui = String((msg.payload && msg.payload.device_eui) || '').trim().toUpperCase();
if (Number(msg.statusCode) !== 200 || !/^[0-9A-F]{16}$/.test(eui)) return [msg, null];
const dbLoad = osiLib.require('osi-db-helper');
const vcLoad = osiLib.require('osi-valve-control');
if (!dbLoad.ok || !vcLoad.ok) {
  node.error('valve unclaim cleanup unavailable, the valve keeps its plan: ' + [dbLoad, vcLoad].filter(function (l) { return !l.ok; }).map(function (l) { return l.error; }).join('; '), msg);
  return [msg, null];
}
const VC = vcLoad.value;
const appId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
let flushQueue = null;
let transport = null;
function unavailableTransport() {
  const fail = function () { const e = new Error('chirpstack_transport_unavailable'); e.code = 'transport_unavailable'; return Promise.reject(e); };
  return { getDeviceQueue: fail, getQueue: fail, flushDeviceQueue: fail, enqueueDownlink: fail, enqueue: fail };
}
try {
  const client = chirpstack.createProvisioningClientFromEnv(env);
  transport = client;
  flushQueue = function (target) { return client.flushDeviceQueue(target); };
} catch (e) {
  transport = unavailableTransport();
  flushQueue = function (target) { return transport.flushDeviceQueue(target); };
  node.warn('valve unclaim cleanup: ChirpStack transport unavailable; STREGA writes fail closed: ' + (e && e.message ? e.message : e));
}
const db = new dbLoad.value.Database('/data/db/farming.db');
const closeDb = function () { return new Promise(function (resolve) { db.close(function () { resolve(); }); }); };
return VC.clearValveOnUnclaim({
  db: db, deviceEui: eui, appId: appId, flushQueue: flushQueue, transport: transport,
  warn: function (m) { node.warn(m); }
}).then(function (out) {
  if (out.transportFailure) {
    node.error('valve unclaim cleanup transport uncertain for ' + eui + ': ' + out.transportFailure.error, msg);
    msg.statusCode = out.transportFailure.phase === 'enqueue_rejected' ? 422 : 503;
    msg.payload = { error: out.transportFailure.error, phase: out.transportFailure.phase, device_eui: eui };
    return [msg, null];
  }
  if (out.cancelled && out.cancelled.ok === false) {
    node.error('valve unclaim actuation cancel failed for ' + eui + ': ' + (out.cancelled.error || 'transport_uncertain'), msg);
    msg.statusCode = 503;
    msg.payload = { error: 'transport_uncertain', device_eui: eui };
    return [msg, null];
  }
  if (out.applicable) {
    node.log('valve unclaim cleanup ' + eui + ': schedules_cleared=' + out.schedules_cleared + ' pushes_queued=' + out.pushes_queued + ' cancel=' + (out.cancelled && out.cancelled.ok ? 'ok' : ((out.cancelled && out.cancelled.error) || 'none')));
  }
  if (!appId && out.messages.length) node.warn('valve unclaim cleanup: CHIRPSTACK_APP_ACTUATORS missing; ' + out.messages.length + ' clearing downlink(s) not sent');
  const downlinks = appId ? out.messages.map(function (p) { return { topic: p.topic, payload: p.payload }; }) : [];
  return [msg, downlinks.length ? downlinks : null];
}).catch(function (e) {
  // The unclaim itself already succeeded and its response is already formatted: a cleanup
  // failure must be loud, but it must never swallow the reply (a route that answers nothing
  // is a silent hang). The pushes that were queued before the failure stay queued.
  node.error('valve unclaim cleanup failed for ' + eui + ': ' + ((e && e.stack) || e), msg);
  return [msg, null];
}).finally(function () { return closeDb(); });
}

function liveEncoder({ msg, node, env, osiLib, chirpstack }) {
return (async () => {
let db = null;
const closeDb = function () { return db ? new Promise(function (resolve) { db.close(function () { resolve(); }); }) : Promise.resolve(); };
try {
const actuatorsAppId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
const dbLoad = osiLib.require('osi-db-helper');
const valveLoad = osiLib.require('osi-valve-control');
if (!dbLoad.ok || !valveLoad.ok) node.warn('STREGA dispatch helpers unavailable: ' + [dbLoad, valveLoad].filter(function (x) { return !x.ok; }).map(function (x) { return x.error; }).join('; '));
const VC = valveLoad.ok ? valveLoad.value : null;

function clampByte(x) {
  let v = Number(x ?? 0);
  if (!Number.isFinite(v) || v <= 0) v = 1;
  if (v > 255) v = 255;
  return v;
}

if (!msg.payload || msg.payload.type !== 'actuator_command') {
  node.status({ fill: 'yellow', shape: 'ring', text: 'Not an actuator_command' });
  return null;
}

const devEui = msg.payload.device && msg.payload.device.devEui ? String(msg.payload.device.devEui).trim().toUpperCase() : null;
const zoneId = msg.payload.device && msg.payload.device.zone_id !== undefined && msg.payload.device.zone_id !== null ? Number(msg.payload.device.zone_id) : null;
const data = msg.payload.data || {};
const action = data.action ? String(data.action).trim().toUpperCase() : null;
const reason = data.reason !== undefined && data.reason !== null ? String(data.reason) : null;
const durationMinutes = data.duration_minutes !== undefined && data.duration_minutes !== null ? Number(data.duration_minutes) : null;
const closedIntervalMinutes = data.closed_interval_minutes !== undefined && data.closed_interval_minutes !== null ? Number(data.closed_interval_minutes) : (data.closedIntervalMinutes !== undefined && data.closedIntervalMinutes !== null ? Number(data.closedIntervalMinutes) : null);
const openIntervalMinutes = data.open_interval_minutes !== undefined && data.open_interval_minutes !== null ? Number(data.open_interval_minutes) : (data.openIntervalMinutes !== undefined && data.openIntervalMinutes !== null ? Number(data.openIntervalMinutes) : 2);
const tamperDisabled = data.tamper_disabled === true || String(data.tamper_disabled || data.tamperDisabled || '').toLowerCase() === 'true';
const valveAction = String(data.valve_action || data.valveAction || '').trim().toUpperCase();
const unit = String(data.unit || '').trim().toUpperCase();
const amount = Number(data.amount || 0);
const enabled = data.enabled === true || String(data.enabled || '').toLowerCase() === 'true';
const percentage = Number(data.percentage || 0);
const returnPosition = String(data.return_position || data.returnPosition || '').trim().toUpperCase();
const gatewayDeviceEui = String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase();

function inferAckState() {
  if (action === 'TIMED_ACTION' || action === 'SET_PARTIAL_OPENING') {
    if (valveAction === 'OPEN') return 'OPEN';
    if (valveAction === 'CLOSE') return 'CLOSED';
  }
  if (action === 'SET_FLUSHING') {
    if (returnPosition === 'OPEN') return 'OPEN';
    if (returnPosition === 'CLOSE') return 'CLOSED';
  }
  return null;
}

function completeFailure(error, message, statusCode, result) {
  const localResponse = msg._stregaHttpResponse ? Object.assign({}, msg._stregaHttpResponse, {
    statusCode: Number(statusCode) || 503,
    payload: { error: error, message: message }
  }) : null;
  return [null, null, msg._stregaHttpResponse ? null : ack(result || 'FAILED', message), localResponse];
}

function ack(result, error, extra) {
  if (!data.commandId) return null;
  return {
    topic: 'devices/' + String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase() + '/command_ack',
    payload: JSON.stringify(Object.assign({
      commandId: data.commandId || null,
      eventUuid: data.eventUuid || null,
      aggregateType: data.aggregateType || null,
      aggregateKey: data.aggregateKey || null,
      effectKey: data.effectKey || null,
      deviceEui: devEui,
      gatewayDeviceEui: gatewayDeviceEui,
      result: result,
      state: inferAckState(),
      status: 'APPLIED',
      commandType: String(data.commandType || 'SET_STREGA_INTERVAL').trim().toUpperCase(),
      appliedSyncVersion: data.appliedSyncVersion !== undefined && data.appliedSyncVersion !== null ? data.appliedSyncVersion : null,
      error: error || null,
      timestamp: new Date().toISOString()
    }, extra || {})),
    qos: 1
  };
}

// STREGA writes use the provisioning gRPC transport. The legacy Actuators
// application ID is not a transport selector and must never route a valve payload to MQTT.
let transportResult = null;
if (!actuatorsAppId) {
  const error = 'Missing CHIRPSTACK_APP_ACTUATORS; refusing STREGA downlink';
  node.status({ fill: 'red', shape: 'ring', text: 'missing Actuators app ID' });
  node.error(error, msg);
  return completeFailure('transport_unavailable', error, 503);
}

if (!devEui) {
  node.status({ fill: 'red', shape: 'ring', text: 'Missing valve devEui' });
  node.warn({ where: 'strega_downlink', error: 'Missing devEui', payload: msg.payload });
  return completeFailure('invalid_device', 'Missing valve devEui', 422);
}
if (!action) {
  node.status({ fill: 'red', shape: 'ring', text: 'Missing action' });
  node.warn({ where: 'strega_downlink', error: 'Missing action', payload: msg.payload });
  return completeFailure('invalid_action', 'Missing action', 422);
}

if (msg._stregaDispatchError) {
  const dispatchError = msg._stregaDispatchError;
  const localFailure = msg._stregaHttpResponse ? Object.assign({}, msg._stregaHttpResponse, { statusCode: Number(dispatchError.statusCode) || (dispatchError.code === 'valve_busy' ? 409 : 503), payload: { error: dispatchError.code, message: dispatchError.message || dispatchError.code } }) : null;
  const terminal = dispatchError.code === 'valve_busy' || dispatchError.code === 'scope_actor_required' || dispatchError.code === 'scope_denied' || dispatchError.code === 'missing_or_invalid_expectation_duration';
  return [null, null, msg._stregaHttpResponse ? null : ack(terminal ? 'REJECTED_PERMANENT' : 'FAILED', dispatchError.code, { transportPhase: 'REJECTED' }), localFailure];
}

let fPort;
let rawBytes;
let logMsg = null;
let ackMsg = null;
let label = action;

switch (action) {
  case 'OPEN_FOR_DURATION': {
    const minutes = clampByte(durationMinutes);
    rawBytes = [0x41, minutes];
    fPort = 2;
    label = 'OPEN_FOR_DURATION(' + minutes + 'm)';
    break;
  }
  case 'CLOSE_FOR_DURATION': {
    const minutes = clampByte(durationMinutes);
    rawBytes = [0x40, minutes];
    fPort = 2;
    label = 'CLOSE_FOR_DURATION(' + minutes + 'm)';
    break;
  }
  case 'CLOSE': {
    rawBytes = [0x30];
    fPort = 1;
    label = 'CLOSE';
    break;
  }
  case 'SET_INTERVAL': {
    if (!(Number.isInteger(closedIntervalMinutes) && closedIntervalMinutes >= 1 && closedIntervalMinutes <= 255)) {
      node.status({ fill: 'red', shape: 'ring', text: 'Invalid closed interval' });
      return completeFailure('invalid_interval', 'Invalid STREGA closed interval', 422);
    }
    if (!(Number.isInteger(openIntervalMinutes) && openIntervalMinutes >= 1 && openIntervalMinutes <= 255)) {
      node.status({ fill: 'red', shape: 'ring', text: 'Invalid open interval' });
      return completeFailure('invalid_interval', 'Invalid STREGA open interval', 422);
    }
    rawBytes = [tamperDisabled ? 0x01 : 0x00, closedIntervalMinutes & 0xFF, 0x00, openIntervalMinutes & 0xFF];
    fPort = Number(data.fPort || 11) || 11;
    ackMsg = ack('SUCCESS', null, { intervalMinutes: closedIntervalMinutes, openIntervalMinutes: openIntervalMinutes, tamperDisabled: tamperDisabled });
    label = 'SET_INTERVAL(' + closedIntervalMinutes + 'm/' + openIntervalMinutes + 'm' + (tamperDisabled ? ',tamper-off' : '') + ')';
    break;
  }
  case 'TIMED_ACTION': {
    if (!((valveAction === 'OPEN' || valveAction === 'CLOSE') && (unit === 'SECONDS' || unit === 'MINUTES' || unit === 'HOURS') && Number.isInteger(amount) && amount >= 1 && amount <= 255)) {
      node.status({ fill: 'red', shape: 'ring', text: 'Invalid timed action' });
      return completeFailure('invalid_timed_action', 'Invalid STREGA timed action', 422);
    }
    const opcode = unit === 'SECONDS'
      ? (valveAction === 'OPEN' ? 0x21 : 0x20)
      : (unit === 'MINUTES' ? (valveAction === 'OPEN' ? 0x41 : 0x40) : (valveAction === 'OPEN' ? 0x81 : 0x80));
    rawBytes = [opcode, amount & 0xFF];
    fPort = Number(data.fPort || 2) || 2;
    ackMsg = ack('SUCCESS', null, { action: valveAction, unit: unit, amount: amount });
    label = valveAction + ' ' + amount + ' ' + unit;
    break;
  }
  case 'SET_MAGNET_MODE': {
    rawBytes = [enabled ? 0x31 : 0x30];
    fPort = Number(data.fPort || 22) || 22;
    ackMsg = ack('SUCCESS', null, { enabled: enabled });
    label = 'MAGNET ' + (enabled ? 'ON' : 'OFF');
    break;
  }
  case 'SET_PARTIAL_OPENING': {
    if (!((valveAction === 'OPEN' || valveAction === 'CLOSE') && Number.isInteger(percentage) && percentage >= 1 && percentage <= 100)) {
      node.status({ fill: 'red', shape: 'ring', text: 'Invalid partial opening' });
      return completeFailure('invalid_partial_opening', 'Invalid STREGA partial opening', 422);
    }
    rawBytes = [valveAction === 'OPEN' ? 0x31 : 0x30, percentage & 0xFF];
    fPort = Number(data.fPort || 27) || 27;
    ackMsg = ack('SUCCESS', null, { action: valveAction, percentage: percentage });
    label = 'PARTIAL ' + valveAction + ' ' + percentage + '%';
    break;
  }
  case 'SET_FLUSHING': {
    if (!((returnPosition === 'OPEN' || returnPosition === 'CLOSE') && Number.isInteger(percentage) && percentage >= 1 && percentage <= 100)) {
      node.status({ fill: 'red', shape: 'ring', text: 'Invalid flushing' });
      return completeFailure('invalid_flushing', 'Invalid STREGA flushing', 422);
    }
    rawBytes = [returnPosition === 'OPEN' ? 0x31 : 0x30, percentage & 0xFF];
    fPort = Number(data.fPort || 28) || 28;
    ackMsg = ack('SUCCESS', null, { returnPosition: returnPosition, percentage: percentage });
    label = 'FLUSH ' + percentage + '% -> ' + returnPosition;
    break;
  }
  default: {
    node.status({ fill: 'yellow', shape: 'ring', text: 'Unsupported action: ' + action });
    node.warn({ where: 'strega_downlink', error: 'Unsupported action', action: action, devEui: devEui });
    return completeFailure('unsupported_action', 'Unsupported STREGA action', 422);
  }
}

const base64Data = Buffer.from(rawBytes).toString('base64');
try {
  const client = chirpstack.createProvisioningClientFromEnv(env);
  const timedOpen = action === 'OPEN_FOR_DURATION' || (action === 'TIMED_ACTION' && valveAction === 'OPEN');
  const permanentClose = action === 'CLOSE';
  db = new dbLoad.value.Database('/data/db/farming.db');
  const frame = {
    fPort: fPort, data: base64Data, confirmed: false, encrypted: false,
    provenance: permanentClose ? { source: 'local_encoder' } : { source: 'local_encoder', encoder: 'strega-v1' },
  };
  if (timedOpen || permanentClose) {
    const normalized = msg._stregaDispatchCommand || Object.assign({}, data, {
      device_eui: devEui, command_id: data.commandId || data.command_id || ('close:' + crypto.randomUUID()),
      action: permanentClose ? 'CLOSE' : 'OPEN_FOR_DURATION', duration_minutes: durationMinutes,
    });
    if (timedOpen && msg._stregaDispatchCommand) {
      const encodedSeconds = action === 'OPEN_FOR_DURATION'
        ? Number(durationMinutes) * 60
        : (unit === 'HOURS' ? amount * 3600 : (unit === 'MINUTES' ? amount * 60 : amount));
      const authorizedSeconds = Number(normalized.duration_seconds != null
        ? normalized.duration_seconds : Number(normalized.duration_minutes) * 60);
      if (!Number.isFinite(encodedSeconds) || !Number.isFinite(authorizedSeconds) || encodedSeconds !== authorizedSeconds) {
        const changed = new Error('authorized STREGA command no longer matches the encoded frame');
        changed.code = 'command_mutated';
        throw changed;
      }
    }
    // A cloud open is tracked under its command id as text, the id a cancel names (the
    // contract main's write-strega-expectation keeps: expectation_id = String(commandId)).
    const tracked = timedOpen && normalized.expectation_id == null && normalized.expectationId == null
      && normalized.command_id != null && String(normalized.command_id) !== ''
      ? Object.assign({}, normalized, { expectation_id: String(normalized.command_id) })
      : normalized;
    transportResult = await VC.executeValveAttempt({
      db: db, deviceEui: devEui, command: tracked, frame: frame,
      transport: client, now: new Date(),
    });
  } else {
    const ownerId = String(data.commandId || data.command_id || ('strega-config:' + Date.now() + ':' + Math.random()));
    transportResult = await VC.enqueueValveCommand({
      db: db, deviceEui: devEui, owner: { type: 'opaque', id: ownerId, device_eui: devEui },
      item: { fPort: fPort, data: base64Data, confirmed: false, encrypted: false, provenance: { source: 'local_encoder' } },
      transport: client, now: new Date(),
    });
  }
} catch (error) {
  transportResult = { accepted: false, phase: error && error.code ? error.code : 'UNKNOWN', error: error };
}
if (data.commandId && db) {
  const ledgerRow = await db.get('SELECT result_detail FROM applied_commands WHERE command_id=?', [String(data.commandId)]);
  if (ledgerRow) {
    let detail = {};
    try { detail = ledgerRow.result_detail ? JSON.parse(ledgerRow.result_detail) : {}; } catch (_) { detail = {}; }
    const phase = transportResult && transportResult.phase || 'UNKNOWN';
    const ledgerResult = phase === 'ACCEPTED' ? 'APPLIED' : (phase === 'enqueue_rejected' || phase === 'enqueue_failed_before_acceptance' ? 'REJECTED_PERMANENT' : 'UNKNOWN');
    detail.result = ledgerResult;
    detail.status = ledgerResult === 'APPLIED' ? 'ACKED' : (ledgerResult === 'UNKNOWN' ? 'UNKNOWN' : 'NACKED');
    detail.transportPhase = phase;
    detail.error = transportResult && transportResult.error ? String(transportResult.error.message || transportResult.error) : null;
    await db.run('UPDATE applied_commands SET result=?, result_detail=?, last_error=? WHERE command_id=?', [ledgerResult, JSON.stringify(detail), detail.error, String(data.commandId)]);
  }
}
if (!transportResult || transportResult.phase !== 'ACCEPTED') {
  const detail = transportResult && transportResult.error ? String(transportResult.error.message || transportResult.error) : 'STREGA transport did not accept the command';
  node.warn('STREGA downlink not accepted for ' + devEui + ': ' + detail);
  ackMsg = ack('FAILED', detail, { transportPhase: transportResult && transportResult.phase || 'UNKNOWN' });
} else if (!ackMsg && data.commandId) {
  ackMsg = ack('SUCCESS', null, { transportPhase: transportResult.phase, queueId: transportResult.queue_id || null });
}

if (action && transportResult && transportResult.phase === 'ACCEPTED' && transportResult.replayed !== true) {
  logMsg = {
    _log_ctx: {
      devEui,
      zone_id: Number.isFinite(zoneId) ? zoneId : null,
      action: action,
      duration_minutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
      reason,
      commandId: data.commandId || null,
      eventUuid: data.eventUuid || null,
      aggregateType: data.aggregateType || null,
      aggregateKey: data.aggregateKey || null,
      effectKey: data.effectKey || null,
      appliedSyncVersion: data.appliedSyncVersion !== undefined && data.appliedSyncVersion !== null ? data.appliedSyncVersion : null,
      commandType: String(data.commandType || '').trim().toUpperCase() || null,
      gatewayDeviceEui,
      created_at: new Date().toISOString(),
      // (Task 4 / E2) carry the percentage the encoder already computed through to the
      // log write instead of dropping it. returnPosition is flushing-only (partial
      // opening has no return leg). Both stay null for every other command type.
      percentage: (action === 'SET_PARTIAL_OPENING' || action === 'SET_FLUSHING') && Number.isFinite(percentage) && percentage > 0 ? percentage : null,
      returnPosition: action === 'SET_FLUSHING' && returnPosition ? returnPosition : null,
      extra_json: JSON.stringify({
        valve_action: valveAction || null,
        unit: unit || null,
        amount: Number.isFinite(amount) ? amount : null,
        percentage: Number.isFinite(percentage) ? percentage : null,
        return_position: returnPosition || null
      })
    }
  };
}

let localResponse = null;
if (msg._stregaHttpResponse) {
  localResponse = Object.assign({}, msg._stregaHttpResponse);
  if (transportResult && transportResult.phase === 'ACCEPTED') {
    localResponse.statusCode = 202;
    localResponse.payload = Object.assign({}, localResponse.payload || {}, { status: 'queued', transportPhase: 'ACCEPTED', queue_id: transportResult.queue_id || null });
  } else {
    localResponse.statusCode = transportResult && transportResult.phase === 'enqueue_rejected' ? 422 : 503;
    localResponse.payload = { error: transportResult && transportResult.phase || 'UNKNOWN', message: 'STREGA transport did not accept the command' };
  }
}
node.status({ fill: 'green', shape: 'dot', text: label + ' FPort=' + fPort + ' ' + devEui });
return [null, logMsg, ackMsg, localResponse];
} finally { await closeDb(); }
})().catch((error) => {
  node.error('STREGA dispatch failed: ' + String(error && error.message ? error.message : error), msg);
  const localResponse = msg._stregaHttpResponse ? Object.assign({}, msg._stregaHttpResponse, { statusCode: 503, payload: { error: error && error.code ? error.code : 'write_failed', message: String(error && error.message ? error.message : error) } }) : null;
  const errorMessage = String(error && error.message ? error.message : error);
  const errorData = msg.payload && msg.payload.data ? msg.payload.data : {};
  const cloudAck = !msg._stregaHttpResponse && errorData.commandId ? {
    topic: 'devices/' + String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase() + '/command_ack',
    payload: JSON.stringify({
      commandId: errorData.commandId,
      eventUuid: errorData.eventUuid || null,
      aggregateType: errorData.aggregateType || null,
      aggregateKey: errorData.aggregateKey || null,
      effectKey: errorData.effectKey || null,
      deviceEui: msg.payload.device && msg.payload.device.devEui ? String(msg.payload.device.devEui).trim().toUpperCase() : null,
      gatewayDeviceEui: String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase(),
      result: 'FAILED',
      state: null,
      status: 'APPLIED',
      commandType: String(errorData.commandType || 'SET_STREGA_INTERVAL').trim().toUpperCase(),
      appliedSyncVersion: errorData.appliedSyncVersion == null ? null : errorData.appliedSyncVersion,
      error: errorMessage,
      transportPhase: 'UNKNOWN',
      timestamp: new Date().toISOString()
    }),
    qos: 1
  } : null;
  return [null, null, cloudAck, localResponse];
});
}

function liveValveApiRouter({ msg, node, env, context, chirpstack, osiLib }) {
const dbLoad = osiLib.require('osi-db-helper');
const vcLoad = osiLib.require('osi-valve-control');
if (!dbLoad.ok || !vcLoad.ok) {
  const detail = [dbLoad, vcLoad].filter(function(l) { return !l.ok; }).map(function(l) { return l.error; }).join('; ');
  node.error('Valve control helpers unavailable: ' + detail, msg);
  msg.statusCode = 503; msg.payload = { error: 'valve_control_unavailable', message: detail };
  return [msg, null];
}
const dbHelper = dbLoad.value; const VC = vcLoad.value;
const appId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
// (osi-os #470) The ChirpStack client is built lazily, on the first transport call. The valve
// API makes that call only after the session and valve authorization checks pass, so a
// rejected or read-only request builds no client. The finally handler below closes it once
// the API promise, including every awaited enqueue and queue flush, has settled. A client
// that cannot be built fails STREGA writes closed, as before (warned once per node context).
const transportFactory = function () {
  try { return chirpstack.createProvisioningClientFromEnv(env); }
  catch (e) {
    if (!context.get('csWarned')) {
      node.warn('valve-api: chirpstack client unavailable, plan pushes will not flush the queue: ' + (e && e.message ? e.message : e));
      context.set('csWarned', true);
    }
    throw e;
  }
};
const transport = lazyTransport(transportFactory, function(m) { node.warn(m); });
const flushQueue = function(eui) { return transport.flushDeviceQueue(eui); };
return Promise.resolve().then(function() {
  return VC.handleHttpRequest({
    msg: msg, Database: dbHelper.Database, appId: appId, flushQueue: flushQueue, transport: transport,
    environment: { authTokenSecret: env.get('AUTH_TOKEN_SECRET'), jwtSecret: env.get('JWT_SECRET'), deviceEui: env.get('DEVICE_EUI') },
    warn: function(m) { node.warn(m); }
  });
}).then(function(out) {
  const pushes = Array.isArray(out.valvePushMessages) ? out.valvePushMessages : [];
  delete out.valvePushMessages;
  if (!appId && pushes.length) node.warn('valve-api: CHIRPSTACK_APP_ACTUATORS missing; ' + pushes.length + ' downlink(s) not sent');
  const downlinks = appId ? pushes.map(function(p) { return { topic: p.topic, payload: p.payload }; }) : [];
  return [out, downlinks];
}).catch(function(e) {
  node.error('valve-api: ' + (e && e.message ? e.message : e), msg);
  return [Object.assign(msg, { statusCode: 500, payload: { error: 'internal_error', message: 'Valve request failed' } }), null];
}).finally(function() {
  if (!transport.built()) return;
  try {
    const errors = transport.close();
    for (const error of (Array.isArray(errors) ? errors : [])) node.warn('valve-api: chirpstack client close failed: ' + (error && error.message ? error.message : error));
  } catch (error) {
    node.warn('valve-api: chirpstack client close failed: ' + (error && error.message ? error.message : error));
  }
});
}

function liveValveOnce({ msg, node, env, chirpstack, osiLib }) {
const d=osiLib.require('osi-db-helper'),v=osiLib.require('osi-valve-control');
if(!d.ok||!v.ok){const e=[d,v].filter(x=>!x.ok).map(x=>x.error).join('; ');node.error('Valve control helpers unavailable: '+e,msg);msg.statusCode=503;msg.payload={error:'valve_control_unavailable',message:e};return null;}
// (W29 F1) The ChirpStack client is built lazily by runOnceTickLazy, only when a one-time open is
// dispatched, and closed before it returns; a client that cannot be built fails closed.
const transportFactory=function(){return chirpstack.createProvisioningClientFromEnv(env);};
return (async()=>{const db=new d.value.Database('/data/db/farming.db');try{const r=await v.value.runOnceTickLazy({db,now:new Date(),transportFactory,warn:m=>node.warn(m),onError:e=>node.error('valve-once dispatch failed: '+(e&&e.message||e),msg)});if(r.transportFailures && r.transportFailures.length){ node.status({fill:'red',shape:'ring',text:'transport uncertain '+r.transportFailures.length}); node.error('valve-once transport result was not accepted',msg); }
else if(r.fired.length||r.skipped.length)node.status({fill:'green',shape:'dot',text:'fired '+r.fired.length+' skipped '+r.skipped.length});}catch(e){node.error('valve-once: '+(e&&e.message||e),msg);}finally{await new Promise(res=>db.close(()=>res()));}})();
}

function liveValveClock({ msg, node, env, chirpstack, osiLib }) {
const dbLoad = osiLib.require('osi-db-helper');
const vcLoad = osiLib.require('osi-valve-control');
if (!dbLoad.ok || !vcLoad.ok) {
  const detail = [dbLoad, vcLoad].filter(function(l) { return !l.ok; }).map(function(l) { return l.error; }).join('; ');
  node.error('Valve control helpers unavailable: ' + detail, msg);
  msg.statusCode = 503; msg.payload = { error: 'valve_control_unavailable', message: detail };
  return null;
}
const dbHelper = dbLoad.value; const VC = vcLoad.value;
const appId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
// (CMD-04 PR0 2758ca709 T1-T3) The ChirpStack client is built lazily by VC.runValveTick, only
// when a plan snapshot, a clock sync or a decommission sweep is about to be sent, and closed
// before the tick returns (the tick runs every 60 s; each client owns gRPC channels). A client
// that cannot be built fails STREGA writes closed (warned once per runtime). runValveTick runs
// runHousekeeping (snapshots first) then runClockTick, and skips a tick that overlaps a slow one.
const transportFactory = function () { return chirpstack.createProvisioningClientFromEnv(env); };
return (async () => {
  const db = new dbHelper.Database('/data/db/farming.db');
  try {
    const t = await VC.runValveTick({ db: db, now: new Date(), appId: appId, transportFactory: transportFactory, warn: function(m) { node.warn(m); } });
    if (t.skipped) { node.status({ fill: 'yellow', shape: 'ring', text: 'previous tick still running' }); return []; }
    const all = t.messages;
    const failures = t.transportFailures || [];
    if (failures.length) node.error('valve-clock transport result was not accepted for ' + failures.map(function(f) { return f.device_eui + ':' + f.phase; }).join(','), msg);
    if (!appId && all.length) {
      node.warn('valve-clock: CHIRPSTACK_APP_ACTUATORS missing; ' + all.length + ' downlink(s) not sent');
      node.status({ fill: 'yellow', shape: 'ring', text: 'missing Actuators app ID' });
    } else if (all.length) {
      node.status({ fill: 'green', shape: 'dot', text: 'clock/housekeeping pushes ' + all.length });
    }
    return appId ? all.map(function(m) { return { topic: m.topic, payload: m.payload }; }) : [];
  } catch (e) { node.error('valve-clock: ' + (e && e.message ? e.message : e)); return []; }
  finally { await new Promise(function(res) { db.close(function() { res(); }); }); }
})().then(function(msgs) { return msgs.length ? [msgs] : null; });
}

function liveCloudCommand({ msg, node, env, chirpstack, osiLib }) {
// Applies the cloud valve commands (schedules, settings, CANCEL_VALVE_ACTUATION) through
// osi-valve-control applyCloudCommand, as the REST routes do. They carry only a
// device_eui, the trust boundary of every Route Command dispatch.
return (async () => {
  const dbLoad = osiLib.require('osi-db-helper');
  const vcLoad = osiLib.require('osi-valve-control');
  const piEui = env.get('DEVICE_EUI') || 'UNKNOWN';
  const cmd = (typeof msg.payload === 'string') ? JSON.parse(msg.payload) : (msg.payload || {});
  const commandType = String(cmd.commandType || cmd.command_type || '').trim().toUpperCase();
  function ackMsg(result, error, detail) {
    const m = {};
    m.topic = 'devices/' + piEui + '/command_ack';
    m.payload = JSON.stringify({
      commandId: cmd.commandId || cmd.command_id || null,
      eventUuid: cmd.eventUuid || cmd.event_uuid || null,
      aggregateType: cmd.aggregateType || cmd.aggregate_type || null,
      aggregateKey: cmd.aggregateKey || cmd.aggregate_key || null,
      appliedSyncVersion: (cmd.appliedSyncVersion !== undefined && cmd.appliedSyncVersion !== null) ? cmd.appliedSyncVersion : ((cmd.applied_sync_version !== undefined && cmd.applied_sync_version !== null) ? cmd.applied_sync_version : null),
      commandType: commandType,
      result: result,
      error: error || null,
      reason: detail || null
    });
    m.qos = 1;
    return m;
  }
  if (!dbLoad.ok || !vcLoad.ok) {
    const detail = [dbLoad, vcLoad].filter(function (l) { return !l.ok; }).map(function (l) { return l.error; }).join('; ');
    node.error('Valve cloud command helpers unavailable: ' + detail, msg);
    return [ackMsg('FAILED', detail), null];
  }
  const dbHelper = dbLoad.value;
  const VC = vcLoad.value;
  const appId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
  let flushQueue = null;
  let queueClient = null;
  let transport = null;
  function unavailableTransport() {
  const fail = function () { const e = new Error('chirpstack_transport_unavailable'); e.code = 'transport_unavailable'; return Promise.reject(e); };
  return { getDeviceQueue: fail, getQueue: fail, flushDeviceQueue: fail, enqueueDownlink: fail, enqueue: fail };
}
  try {
    const client = chirpstack.createProvisioningClientFromEnv(env);
    flushQueue = function (eui) { return client.flushDeviceQueue(eui); };
    queueClient = client;
    transport = client;
  } catch (e) {
    transport = unavailableTransport();
    flushQueue = function (eui) { return transport.flushDeviceQueue(eui); };
    queueClient = transport;
    node.warn('valve-cloud-command: ChirpStack transport unavailable; STREGA writes fail closed: ' + (e && e.message ? e.message : e));
  }
  const db = new dbHelper.Database('/data/db/farming.db');
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  let out = { ok: false, error: 'internal_error', downlinks: [] };
  try {
    out = await VC.applyCloudCommand({ db: db, cmd: cmd, appId: appId, flushQueue: flushQueue, queueClient: queueClient, transport: transport, warn: function (m2) { node.warn(m2); } });
  } catch (error) {
    out = { ok: false, error: String(error && error.message ? error.message : error), downlinks: [] };
    node.error('valve-cloud-command: ' + commandType + ' failed: ' + out.error, msg);
  } finally {
    try { await close(); } catch (closeError) { node.warn('valve-cloud-command: DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError)); }
  }
  const downlinks = Array.isArray(out.downlinks) ? out.downlinks : [];
  if (!appId && downlinks.length) node.warn('valve-cloud-command: CHIRPSTACK_APP_ACTUATORS missing; ' + downlinks.length + ' downlink(s) not sent');
  const outDownlinks = appId ? downlinks.map(function (p) { return { topic: p.topic, payload: p.payload }; }) : [];
  // A permanent refusal (e.g. a cancel that names no actuation while two are active) is final.
  return [ackMsg(out.ok ? 'SUCCESS' : (out.permanent ? 'REJECTED_PERMANENT' : 'FAILED'), out.ok ? null : out.error, out.detail), outDownlinks];
})().catch((error) => {
  node.error('valve-cloud-command: unexpected failure: ' + String(error && error.message ? error.message : error), msg);
  return null;
});
}

module.exports = {
  liveDeleteValveCleanup,
  liveEncoder,
  liveValveApiRouter,
  liveValveOnce,
  liveValveClock,
  liveCloudCommand
};
