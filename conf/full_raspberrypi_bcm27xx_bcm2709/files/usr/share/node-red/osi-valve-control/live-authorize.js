'use strict';

function liveSimulationCommand({ msg }) {
msg.payload = {
  type: "actuator_command",
  device: { devEui: "0004a30b00e95c44" },
  data: {
    action: "OPEN_FOR_DURATION",
    duration_minutes: 10,
    commandId: "simulation-open-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    commandType: "OPEN_FOR_DURATION",
    reason: "manual_gui"
  }
};
msg._systemActuation = true; msg._stregaInternalSource = "simulation"; return msg;

}

function liveIntervalAuthorize({ msg }) {
const row = Array.isArray(msg.payload) && msg.payload[0];
if (!row) {
  msg.statusCode = 404;
  msg.payload = { message: 'Strega valve not found' };
  return [null, null, msg];
}
if (String(row.type_id || '') !== 'STREGA_VALVE') {
  msg.statusCode = 409;
  msg.payload = { message: 'Device is not a Strega valve' };
  return [null, null, msg];
}
const deveui = String(msg._strega_deveui || row.deveui || '').trim().toUpperCase();
const responseMsg = Object.assign({}, msg, {
  topic: 'SELECT 1 AS ok'
});
const actuatorMsg = {
  payload: {
    type: 'actuator_command',
    device: { devEui: deveui },
    data: {
      action: 'SET_INTERVAL',
      closed_interval_minutes: Number(msg._strega_closed_interval_minutes || 0) || null,
      open_interval_minutes: Number(msg._strega_open_interval_minutes || 0) || 2,
      tamper_disabled: msg._strega_tamper_disabled === true,
      reason: 'local_interval_config',
      payloadHex: msg._strega_payload_hex || null,
      fPort: Number(msg._strega_fport || 0) || 11,
      commandType: 'SET_STREGA_INTERVAL'
    }
  }
};
responseMsg.statusCode = 202;
responseMsg.payload = {
  status: 'PENDING',
  confirmation: 'downlink_queued',
  minutes: Number(msg._strega_closed_interval_minutes || 0) || null,
  open_interval_minutes: Number(msg._strega_open_interval_minutes || 0) || 2,
  tamper_disabled: msg._strega_tamper_disabled === true,
  payload_hex: msg._strega_payload_hex || null,
  f_port: Number(msg._strega_fport || 0) || 11
};
actuatorMsg._stregaHttpResponse = responseMsg;
return [null, actuatorMsg, null];
}

function liveAdvancedAuthorize({ msg }) {
function s(v) { return (v === null || v === undefined) ? 'NULL' : ("'" + String(v).replace(/'/g, "''") + "'"); }
function normalizeModel(value) {
  const raw = String(value || '').trim().toUpperCase();
  return raw === 'STANDARD' || raw === 'MOTORIZED' ? raw : null;
}
function recognizedModel(row) {
  const explicit = normalizeModel(row && row.strega_model);
  if (explicit) return explicit;
  const name = String((row && row.name) || '').toLowerCase();
  if (name.indexOf('motor') >= 0) return 'MOTORIZED';
  if (name.indexOf('solenoid') >= 0 || name.indexOf('lite') >= 0 || name.indexOf('standard') >= 0) return 'STANDARD';
  return 'UNKNOWN';
}
const row = Array.isArray(msg.payload) && msg.payload[0];
if (!row) {
  msg.statusCode = 404;
  msg.payload = { message: 'Strega valve not found' };
  return [null, null, null, msg];
}
if (String(row.type_id || '') !== 'STREGA_VALVE') {
  msg.statusCode = 409;
  msg.payload = { message: 'Device is not a Strega valve' };
  return [null, null, null, msg];
}
const deveui = String(msg._strega_deveui || row.deveui || '').trim().toUpperCase();
const responseMsg = Object.assign({}, msg);
if (msg._strega_local_action === 'PARTIAL_OPENING' || msg._strega_local_action === 'FLUSHING') {
  if (recognizedModel(row) !== 'MOTORIZED') {
    msg.statusCode = 409;
    msg.payload = { message: msg._strega_local_action === 'PARTIAL_OPENING' ? 'Partial opening is only supported for motorized Strega valves' : 'Flushing is only supported for motorized Strega valves' };
    return [null, null, null, msg];
  }
}
if (msg._strega_local_action === 'MODEL') {
  responseMsg.topic = 'UPDATE devices SET strega_model = ' + s(msg._strega_model || null) + ' WHERE deveui = ' + s(deveui);
  return [responseMsg, null, null, null];
}
let actuatorMsg;
if (msg._strega_local_action === 'TIMED_ACTION') {
  actuatorMsg = {
    payload: {
      type: 'actuator_command',
      device: { devEui: deveui },
      data: {
        action: 'TIMED_ACTION',
        valve_action: msg._strega_timed_action || null,
        unit: msg._strega_timed_unit || null,
        amount: Number(msg._strega_timed_amount || 0) || null,
        reason: 'local_timed_action',
        payloadHex: msg._strega_payload_hex || null,
        fPort: Number(msg._strega_fport || 0) || 2,
        commandType: 'SET_STREGA_TIMED_ACTION'
      }
    },
    // AgroLink review X2: carry the bearer-verified actor forward so
    // write-strega-expectation's scope gate (TIMED_ACTION + valve_action==='OPEN' is a
    // PHYSICAL command) sees it instead of rejecting scope_actor_required.
    actor_user_uuid: msg.actor_user_uuid || null,
    _actorUserUuid: msg.actor_user_uuid || null
  };
} else if (msg._strega_local_action === 'MAGNET_MODE') {
  actuatorMsg = {
    payload: {
      type: 'actuator_command',
      device: { devEui: deveui },
      data: {
        action: 'SET_MAGNET_MODE',
        enabled: msg._strega_enabled === true,
        reason: 'local_magnet_config',
        payloadHex: msg._strega_payload_hex || null,
        fPort: Number(msg._strega_fport || 0) || 22,
        commandType: 'SET_STREGA_MAGNET_MODE'
      }
    },
    actor_user_uuid: msg.actor_user_uuid || null,
    _actorUserUuid: msg.actor_user_uuid || null
  };
} else if (msg._strega_local_action === 'PARTIAL_OPENING') {
  actuatorMsg = {
    payload: {
      type: 'actuator_command',
      device: { devEui: deveui },
      data: {
        action: 'SET_PARTIAL_OPENING',
        valve_action: msg._strega_partial_action || null,
        percentage: Number(msg._strega_percentage || 0) || null,
        reason: 'local_partial_opening',
        payloadHex: msg._strega_payload_hex || null,
        fPort: Number(msg._strega_fport || 0) || 27,
        commandType: 'SET_STREGA_PARTIAL_OPENING'
      }
    },
    actor_user_uuid: msg.actor_user_uuid || null,
    _actorUserUuid: msg.actor_user_uuid || null
  };
} else if (msg._strega_local_action === 'FLUSHING') {
  actuatorMsg = {
    payload: {
      type: 'actuator_command',
      device: { devEui: deveui },
      data: {
        action: 'SET_FLUSHING',
        return_position: msg._strega_return_position || null,
        percentage: Number(msg._strega_percentage || 0) || null,
        reason: 'local_flushing',
        payloadHex: msg._strega_payload_hex || null,
        fPort: Number(msg._strega_fport || 0) || 28,
        commandType: 'SET_STREGA_FLUSHING'
      }
    },
    actor_user_uuid: msg.actor_user_uuid || null,
    _actorUserUuid: msg.actor_user_uuid || null
  };
} else {
  msg.statusCode = 500;
  msg.payload = { message: 'Unsupported local STREGA action' };
  return [null, null, null, msg];
}
responseMsg.statusCode = 202;
responseMsg.payload = { status: 'PENDING', confirmation: 'downlink_queued' };
if (msg._strega_local_action === 'TIMED_ACTION') {
  responseMsg.payload.action = msg._strega_timed_action || null;
  responseMsg.payload.unit = msg._strega_timed_unit || null;
  responseMsg.payload.amount = Number(msg._strega_timed_amount || 0) || null;
  responseMsg.payload.payload_hex = msg._strega_payload_hex || null;
  responseMsg.payload.f_port = Number(msg._strega_fport || 0) || 2;
} else if (msg._strega_local_action === 'MAGNET_MODE') {
  responseMsg.payload.enabled = msg._strega_enabled === true;
  responseMsg.payload.payload_hex = msg._strega_payload_hex || null;
  responseMsg.payload.f_port = Number(msg._strega_fport || 0) || 22;
} else if (msg._strega_local_action === 'PARTIAL_OPENING') {
  responseMsg.payload.action = msg._strega_partial_action || null;
  responseMsg.payload.percentage = Number(msg._strega_percentage || 0) || null;
  responseMsg.payload.payload_hex = msg._strega_payload_hex || null;
  responseMsg.payload.f_port = Number(msg._strega_fport || 0) || 27;
} else if (msg._strega_local_action === 'FLUSHING') {
  responseMsg.payload.return_position = msg._strega_return_position || null;
  responseMsg.payload.percentage = Number(msg._strega_percentage || 0) || null;
  responseMsg.payload.payload_hex = msg._strega_payload_hex || null;
  responseMsg.payload.f_port = Number(msg._strega_fport || 0) || 28;
}
actuatorMsg._stregaHttpResponse = responseMsg;
return [null, actuatorMsg, null, null];
}

function liveWriteExpectation({ msg, node, env, flow, osiDb, crypto, osiLib }) {
// Write STREGA Expectation
// Persist a valve_actuation_expectations row for every accepted timed STREGA command.
// Volume source is labeled explicitly. Measured and estimated are never mixed.
return (async () => {
    const payload = msg.payload || {};
    const data = payload.data || {};
    const raw = msg._stregaExpectationCommand || msg.payload || {};
    const COMMAND_TYPES_FALLBACK = {
    OPEN_FOR_DURATION:         { dispatch: 'strega_timed_open',         actuator: true,    requires_duration: true  },
    SET_STREGA_TIMED_ACTION:   { dispatch: 'strega_timed_open',         actuator: true,    requires_duration: true  },
    CLOSE:                     { dispatch: 'strega_explicit_close',     actuator: true,    requires_duration: false  },
    VALVE_COMMAND:             { dispatch: 'strega_timed_open',         actuator: true,    requires_duration: true  },
    SET_STREGA_INTERVAL:       { dispatch: 'strega_config',             actuator: false,   requires_duration: false  },
    SET_STREGA_MODEL:          { dispatch: 'strega_config',             actuator: false,   requires_duration: false  },
    SET_STREGA_MAGNET_MODE:    { dispatch: 'strega_config',             actuator: false,   requires_duration: false  },
    SET_STREGA_PARTIAL_OPENING: { dispatch: 'strega_config',             actuator: false,   requires_duration: false  },
    SET_STREGA_FLUSHING:       { dispatch: 'strega_config',             actuator: false,   requires_duration: false  },
    SET_LSN50_MODE:            { dispatch: 'lsn50_config',              actuator: false,   requires_duration: false  },
    SET_LSN50_INTERVAL:        { dispatch: 'lsn50_config',              actuator: false,   requires_duration: false  },
    SET_SDI12_IDENTIFY:         { dispatch: 'sdi12_identify',              actuator: false,   requires_duration: false  },
    SET_LSN50_INTERRUPT_MODE:  { dispatch: 'lsn50_config',              actuator: false,   requires_duration: false  },
    SET_LSN50_5V_WARMUP:       { dispatch: 'lsn50_config',              actuator: false,   requires_duration: false  },
    SET_KIWI_INTERVAL:         { dispatch: 'kiwi_config',               actuator: false,   requires_duration: false  },
    UPSERT_JOURNAL_ENTRY:      { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },
    VOID_JOURNAL_ENTRY:        { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },
    UPSERT_JOURNAL_CUSTOM_VOCAB: { dispatch: 'journal_apply',           actuator: false,   requires_duration: false  },
    UPSERT_JOURNAL_PLOT:       { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },
    UPSERT_JOURNAL_PLOT_GROUP: { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },
    UPSERT_SCOPED_USER:        { dispatch: 'scoped_access_apply',       actuator: false,   requires_duration: false  },
    RESET_SCOPED_USER_PASSWORD: { dispatch: 'scoped_access_apply',      actuator: false,   requires_duration: false  },
    UPSERT_USER_ZONE_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },
    DELETE_USER_ZONE_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },
    UPSERT_USER_PLOT_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },
    DELETE_USER_PLOT_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },
    UC512_OPEN_FOR_DURATION:    { dispatch: 'uc512_timed_open',         actuator: true,    requires_duration: true  },
    ENABLE_KIWI_TEMP_HUMIDITY: { dispatch: 'kiwi_config',               actuator: false,   requires_duration: false  },
    SET_CHAMELEON_CONFIG:      { dispatch: 'watermark_config_apply',    actuator: false,   requires_duration: false  },
    REGISTER_DEVICE:           { dispatch: 'device_register',           actuator: false,   requires_duration: false  },
    REBOOT:                    { dispatch: 'device_reboot',             actuator: false,   requires_duration: false  },
    REBOOT_DEVICE:             { dispatch: 'device_reboot',             actuator: false,   requires_duration: false  },
    REMOVE_DEVICE_FROM_ZONE:   { dispatch: 'device_zone_detach',        actuator: false,   requires_duration: false  },
    UNCLAIM_DEVICE:            { dispatch: 'device_unclaim',            actuator: false,   requires_duration: false  },
    SET_FAN:                   { dispatch: 'local_fan',                 actuator: false,   requires_duration: false  },
    FORCE_EDGE_SYNC:           { dispatch: 'local_sync',                actuator: false,   requires_duration: false  },
    SYNC_LINKED_AUTH:          { dispatch: 'local_auth_sync',           actuator: false,   requires_duration: false  },
    UPSERT_ZONE:               { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  },
    DELETE_ZONE:               { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  },
    UPSERT_ZONE_CONFIG:        { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  },
    UPSERT_ZONE_LOCATION:      { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  },
    ASSIGN_DEVICE_TO_ZONE:     { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  },
    UPSERT_DEVICE_FLAGS:       { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  },
    UPSERT_DEVICE_SOIL_DEPTHS: { dispatch: 'watermark_config_apply',    actuator: false,   requires_duration: false  },
    UPDATE_SCHEDULE:           { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  },
    UPSERT_SCHEDULE:           { dispatch: 'sync_apply',                actuator: false,   requires_duration: false  }
}
const types = flow.get('command_types') || COMMAND_TYPES_FALLBACK;
    const commandType = String(raw.command_type || raw.commandType || data.commandType || data.action || '').trim().toUpperCase();
    const entry = types[commandType] || {};
    if (!entry.actuator || !entry.requires_duration) {
        return msg; // not a timed actuator command; pass through unchanged
    }

    const valveAction = String(raw.action || raw.valveAction || data.valve_action || data.valveAction || '').trim().toUpperCase();
    const isTimedOpen = commandType === 'OPEN_FOR_DURATION'
        || data.action === 'OPEN_FOR_DURATION'
        || (data.action === 'TIMED_ACTION' && valveAction === 'OPEN');
    if (!isTimedOpen) {
        return msg;
    }

    // Customer review R3: deviceEui/zoneId are resolved here (ahead of duration parsing)
    // because the scope/actor gate below needs only deviceEui + commandType, not a valid
    // duration. Duration parsing moved after that gate -- see the R3 comment further down
    // for why: a malformed/absent duration used to return early here, before the gate ever
    // ran, letting that exact shape (a real cloud VALVE_COMMAND commonly carries no
    // duration at all) skip scope enforcement entirely.
    const deviceEui = String(raw.device_eui || raw.deviceEui || data.deviceEui || (payload.device && payload.device.devEui) || '').trim().toUpperCase();
    const zoneId = raw.zone_id || raw.zoneId || data.zone_id || data.zoneId || (payload.device && payload.device.zone_id) || null;
    const DOWNLINK_LATENCY_BUDGET_SEC = 120;
    function localDispatchFailure(code, message, statusCode) {
        msg._stregaDispatchError = { code: code, message: message, statusCode: statusCode };
        if (msg._stregaHttpResponse) {
            msg._stregaHttpResponse.statusCode = Number(statusCode) || 503;
            msg._stregaHttpResponse.payload = { error: code, message: message };
        }
    }

    async function loadZoneIrrigationCalibration(db, zoneId) {
        if (zoneId == null) return null;
        try {
            return await db.get('SELECT measured_flow_rate_lpm, measurement_method FROM zone_irrigation_calibration WHERE zone_id = ?', [zoneId]);
        } catch (error) {
            const detail = String(error && error.message ? error.message : error);
            if (/no such table:\s*zone_irrigation_calibration\b/i.test(detail)) {
                node.warn('STREGA calibration unavailable on this gateway: ' + detail);
                return null;
            }
            throw error;
        }
    }

    const db = new osiDb.Database('/data/db/farming.db');
const __close = () => new Promise((res) => db.close(() => res()));
try {
    // Customer review R1: raw.actor_user_uuid covers a dispatch path that embeds the actor
    // in the command payload (e.g. via _stregaExpectationCommand's Object.assign(cmd, ...))
    // without also copying it to a message-level property -- Route Command is fixed to do
    // that copy too, but this is defense in depth, not a substitute for it.
    const actorUuid = String(
        msg._actorUserUuid || msg.actor_user_uuid || raw.actor_user_uuid || raw.actorUserUuid || ''
    ).trim() || null;
    const commandId = raw.command_id || raw.commandId || data.commandId || null;
    const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
    // Customer review R2: the irrigation scheduler dispatches OPEN_FOR_DURATION with no
    // actor at all (it is not a user action) -- without an exemption, every automated
    // irrigation decision is silently dropped once scoped access is on. The scheduler sets
    // this exact message-level property immediately before dispatch. Only a strict
    // message-level msg._systemActuation === true counts: message-level msg properties
    // cannot be injected from an HTTP request body or a cloud command payload -- the cloud
    // path (Route Command) always builds a brand-new msg object from the wire payload, and
    // every GUI path is bearer-authenticated and never copies arbitrary client-supplied msg
    // properties onto the outgoing msg -- so a payload-embedded claim of this flag (an
    // attacker trying to smuggle system-actuation status through msg.payload/req.body) is
    // never honored; only the scheduler's own wire ever sets it.
    const systemActuation = msg._systemActuation === true && (msg._stregaInternalSource === 'scheduler' || msg._stregaInternalSource === 'simulation');
    if (scopedOn && !actorUuid && !systemActuation) {
        // Fail-closed: OSI_SCOPED_ACCESS=1 requires every PHYSICAL device command to carry
        // an actor. A cloud-dispatched command that arrives without one used to skip the
        // scope check entirely and actuate anyway -- a user whose zone grant was just
        // revoked could still open a valve via the cloud path, which never carried an
        // actor at all. Never actuate here; queue a terminal rejection the same way the
        // existing unknown_command_type rejectionAck does, just via the command ledger
        // directly since this node has a single output wired straight to the downlink
        // builder (see test-flows-wiring.js C5), not a second ack-output wire.
        node.warn({ rejected: 'scope_actor_required', command_type: commandType, command_id: commandId, device_eui: deviceEui });
        localDispatchFailure('scope_actor_required', 'STREGA command requires an authenticated actor', 403);
        if (commandId) {
            const ledgerLoad = osiLib.require('osi-command-ledger');
            if (ledgerLoad.ok) {
                await ledgerLoad.value.queueCommandAck(db, {
                    commandId: commandId,
                    commandType: commandType,
                    effectKey: raw.effect_key || raw.effectKey || null,
                    deviceEui: deviceEui,
                    result: 'REJECTED_PERMANENT',
                    reason: 'scope_actor_required',
                    timestamp: new Date().toISOString()
                });
            } else {
                node.error('write-strega-expectation: command ledger unavailable to queue scope_actor_required rejection: ' + ledgerLoad.error, msg);
            }
        }
        return msg;
    }
    if (scopedOn && actorUuid) {
        const scopeLoad = osiLib.require('scope');
        if (!scopeLoad.ok) {
            throw new Error('scope module unavailable at enqueue: ' + scopeLoad.error);
        }
        try {
            const actorScope = await scopeLoad.value.assertFreshDeviceAccess(
                db,
                actorUuid,
                deviceEui,
                { scopedMode: true }
            );
            if (!scopeLoad.value.canMutate(actorScope.role)) {
                throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
            }
        } catch (scopeError) {
            // Customer review X1: only a deliberate scope decision (assertFreshDeviceAccess's
            // httpError sets .statusCode for 403/404 denials; the canMutate throw just below
            // sets it the same way) should ever become an irreversible REJECTED_PERMANENT ack.
            // A transient infra failure (e.g. SQLITE_BUSY on the scope SELECTs) is a plain
            // Error with no .statusCode -- rethrow it to the generic outer catch so the
            // command stays non-terminal and retryable instead of being permanently denied
            // for a legitimate actor because of a momentary DB contention.
            if (!scopeError.statusCode) throw scopeError;
            // Customer review R4: an actor was present but denied (a revoked grant from
            // assertFreshDeviceAccess, or a non-mutating role from canMutate). Before this,
            // this threw straight to the generic outer catch, which logs and returns null
            // with no ack queued -- the cloud command was left non-terminal and would be
            // redelivered until it eventually expired instead of being told 'no' now. Queue
            // the same kind of terminal rejection the actor-required branch above does.
            node.warn({ rejected: 'scope_denied', command_type: commandType, command_id: commandId, device_eui: deviceEui, detail: String(scopeError && scopeError.message ? scopeError.message : scopeError) });
            localDispatchFailure('scope_denied', String(scopeError && scopeError.message ? scopeError.message : 'Forbidden'), Number(scopeError.statusCode) || 403);
            if (commandId) {
                const ledgerLoad = osiLib.require('osi-command-ledger');
                if (ledgerLoad.ok) {
                    await ledgerLoad.value.queueCommandAck(db, {
                        commandId: commandId,
                        commandType: commandType,
                        effectKey: raw.effect_key || raw.effectKey || null,
                        deviceEui: deviceEui,
                        result: 'REJECTED_PERMANENT',
                        reason: 'scope_denied',
                        timestamp: new Date().toISOString()
                    });
                } else {
                    node.error('write-strega-expectation: command ledger unavailable to queue scope_denied rejection: ' + ledgerLoad.error, msg);
                }
            }
            return msg;
        }
    }
    let seconds = Number(raw.duration_seconds || (raw.duration_minutes ? raw.duration_minutes * 60 : 0));
    if (!Number.isFinite(seconds) || seconds <= 0) {
        if (data.action === 'OPEN_FOR_DURATION') {
            seconds = Number(data.duration_minutes || 0) * 60;
        } else if (data.action === 'TIMED_ACTION' && valveAction === 'OPEN') {
            const amount = Number(data.amount || 0);
            const unit = String(data.unit || '').toUpperCase();
            seconds = unit === 'HOURS' ? amount * 3600 : (unit === 'MINUTES' ? amount * 60 : amount);
        }
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
        node.warn({ rejected: 'missing_or_invalid_expectation_duration', command_type: commandType, command_id: commandId });
        localDispatchFailure('missing_or_invalid_expectation_duration', 'Missing or invalid STREGA duration', 422);
        if (scopedOn) {
            // R3: fail closed under scope instead of the legacy pass-through below -- a
            // malformed/absent duration must not reach the downlink builder once scope is
            // on, actor or not.
            if (commandId) {
                const ledgerLoad = osiLib.require('osi-command-ledger');
                if (ledgerLoad.ok) {
                    await ledgerLoad.value.queueCommandAck(db, {
                        commandId: commandId,
                        commandType: commandType,
                        effectKey: raw.effect_key || raw.effectKey || null,
                        deviceEui: deviceEui,
                        result: 'REJECTED_PERMANENT',
                        reason: 'missing_or_invalid_expectation_duration',
                        timestamp: new Date().toISOString()
                    });
                } else {
                    node.error('write-strega-expectation: command ledger unavailable to queue missing_or_invalid_expectation_duration rejection: ' + ledgerLoad.error, msg);
                }
            }
            return msg;
        }
        return msg;
    }
    const commandedAt = new Date().toISOString();
    const expectedCloseAt = new Date(Date.now() + (seconds + DOWNLINK_LATENCY_BUDGET_SEC) * 1000).toISOString();

    // Defensive read: zone_irrigation_calibration is a WS1 table that older Pis
    // may not have yet. Treat a missing-table error as "no calibration available"
    // so the actuation row still gets inserted with estimatedLiters=null.
    const calib = await loadZoneIrrigationCalibration(db, zoneId);

    let estimatedLiters = null;
    let flowRateLpm = null;
    let flowRateSource = 'none';
    let volumeSource = 'unknown';

    const hasFlowMeter = !!(raw.zone_has_healthy_flow_meter || raw.zoneHasHealthyFlowMeter || data.zone_has_healthy_flow_meter || data.zoneHasHealthyFlowMeter);
    if (hasFlowMeter) {
        volumeSource = 'measured_flow_meter';
    } else if (calib && Number(calib.measured_flow_rate_lpm) > 0) {
        flowRateLpm = Number(calib.measured_flow_rate_lpm);
        flowRateSource = calib.measurement_method || 'calibrated';
        estimatedLiters = (seconds / 60) * flowRateLpm;
        volumeSource = 'estimated_duration_flow_rate';
    }

    const expectationCommandId = commandId != null && commandId !== '' ? String(commandId) : crypto.randomUUID();
    const trigger = raw.trigger || data.trigger || null;
    const requestedMinutes = Math.ceil(seconds / 60);
    // Authorization, normalization and calibration stay here. The final encoder
    // owns the sole writer reservation, immutable frame snapshot and claim.
    msg._stregaDispatchCommand = Object.assign({}, raw, {
        device_eui: deviceEui,
        command_id: expectationCommandId,
        action: 'OPEN_FOR_DURATION',
        duration_minutes: requestedMinutes,
        duration_seconds: (data.action === 'TIMED_ACTION' && valveAction === 'OPEN') ? Math.round(seconds) : undefined,
        zone_id: zoneId,
        trigger: trigger,
        flow_rate_lpm: flowRateLpm,
        flow_rate_source: flowRateSource,
        estimated_gross_liters: estimatedLiters,
        volume_source: volumeSource,
        actor_user_uuid: actorUuid,
        ledger: actorUuid && commandId ? {
            command_id: String(commandId), command_type: commandType,
            effect_key: raw.effect_key || raw.effectKey || null, originator: actorUuid,
        } : null,
    });
    msg.expectation = {
        expectation_id: null,
        volume_source: volumeSource,
        estimated_gross_liters: estimatedLiters,
    };
    return msg;

} finally { try { await __close(); } catch (_) { node.warn('write-strega-expectation ignored operation failed: ' + String(_ && _.message ? _.message : _)); } }
})().catch((error) => {
    if (error && error.code === 'valve_busy') {
        msg._stregaDispatchError = { code: 'valve_busy', message: String(error.message || 'Valve is busy') };
        return msg;
    }
    node.error('Write STREGA expectation failed: ' + String(error && error.message ? error.message : error), msg);
    msg._stregaDispatchError = { code: error && error.code ? error.code : 'write_failed', message: String(error && error.message ? error.message : error), statusCode: 503 };
    if (msg._stregaHttpResponse) { msg._stregaHttpResponse.statusCode = 503; msg._stregaHttpResponse.payload = { error: msg._stregaDispatchError.code, message: msg._stregaDispatchError.message }; }
    return msg;
});
}

module.exports = {
  liveSimulationCommand,
  liveIntervalAuthorize,
  liveAdvancedAuthorize,
  liveWriteExpectation
};
