// Preserve the legacy Function bodies directive mode.
// Extracted from the frozen X2 baseline; preserve error and refusal semantics.
const { routeNonValveCommand } = require('./command-routing');

function routeCommand(msg, { env, global, node, Date, Buffer, setTimeout }) {
var cmd = (typeof msg.payload === 'string') ? JSON.parse(msg.payload) : (msg.payload || {});
// Customer review R1 (Critical): a scoped gateway's cloud command carries the acting
// user in the payload (cmd.actor_user_uuid, per docs/contracts/sync-schema/commands.schema.json).
// Every branch below builds a brand-new msg.payload/_stregaExpectationCommand shape, and
// none of them copied that field onto the message itself, so write-strega-expectation's
// scope gate (msg._actorUserUuid) never saw it -- every scoped cloud-dispatched physical
// command was rejected scope_actor_required, including fully authorized ones. Copy it
// once here, uniformly, for every command type, before any branch runs.
msg._actorUserUuid = String(cmd.actor_user_uuid || cmd.actorUserUuid || '').trim() || null;
var commandType = String(cmd.commandType || cmd.command_type || cmd.action || '').trim().toUpperCase();
var piEui = env.get('DEVICE_EUI') || 'UNKNOWN';



if (commandType === 'OPEN_FOR_DURATION' || commandType === 'CLOSE') {
    var registryTargetEui = String(cmd.deviceEui || cmd.device_eui || cmd.devEui || '').trim().toUpperCase();
    var durationSeconds = Number(cmd.duration_seconds || (cmd.durationMinutes ? cmd.durationMinutes * 60 : 0) || (cmd.duration_minutes ? cmd.duration_minutes * 60 : 0));
    var durationMinutes = commandType === 'OPEN_FOR_DURATION' ? Math.ceil(durationSeconds / 60) : null;
    msg._stregaExpectationCommand = Object.assign({}, cmd, {
        command_type: commandType,
        device_eui: registryTargetEui,
        duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        duration_minutes: durationMinutes
    });
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: registryTargetEui },
        data: {
            action: commandType,
            duration_minutes: durationMinutes,
            reason: 'osi_server_command',
            commandId: cmd.commandId || cmd.command_id || null,
            eventUuid: cmd.eventUuid || cmd.event_uuid || null,
            aggregateType: cmd.aggregateType || cmd.aggregate_type || null,
            aggregateKey: cmd.aggregateKey || cmd.aggregate_key || null,
            appliedSyncVersion: cmd.appliedSyncVersion !== undefined && cmd.appliedSyncVersion !== null ? cmd.appliedSyncVersion : (cmd.applied_sync_version !== undefined && cmd.applied_sync_version !== null ? cmd.applied_sync_version : null),
            commandType: commandType,
            deviceEui: registryTargetEui,
            gatewayDeviceEui: String(cmd.gatewayDeviceEui || cmd.gateway_device_eui || piEui || '').trim().toUpperCase()
        }
    };
    return [msg, null, null, null, null];
}

if (commandType === 'VALVE_COMMAND') {
    var valveTargetEui = String(cmd.deviceEui || cmd.device_eui || cmd.devEui || '').trim().toUpperCase();
    var valveMinutes = Math.ceil(Number(cmd.duration_seconds || (cmd.durationMinutes ? cmd.durationMinutes * 60 : 0) || (cmd.duration_minutes ? cmd.duration_minutes * 60 : 0)) / 60);
    if (String(cmd.action || '').trim().toUpperCase() !== 'OPEN_FOR_DURATION' || !(valveMinutes >= 1 && valveMinutes <= 255)) {
        msg.topic = 'devices/' + piEui + '/command_ack';
        msg.payload = JSON.stringify({ commandId: cmd.commandId || cmd.command_id || null, eventUuid: cmd.eventUuid || null, aggregateType: cmd.aggregateType || null, aggregateKey: cmd.aggregateKey || null, commandType: commandType, deviceEui: valveTargetEui || null, result: 'REJECTED_PERMANENT', reason: 'valve_action_not_allowed', appliedSyncVersion: cmd.appliedSyncVersion == null ? null : cmd.appliedSyncVersion });
        msg.qos = 1;
        return [null, null, msg, null, null];
    }
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: valveTargetEui },
        data: {
            action: 'OPEN_FOR_DURATION',
            duration_minutes: valveMinutes,
            reason: 'osi_server_command',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion !== undefined && cmd.appliedSyncVersion !== null ? cmd.appliedSyncVersion : null,
            commandType: 'VALVE_COMMAND',
            deviceEui: valveTargetEui,
            gatewayDeviceEui: String(cmd.gatewayDeviceEui || cmd.gateway_device_eui || piEui || '').trim().toUpperCase()
        }
    };
    return [msg, null, null, null, null];
}

if (commandType === 'SET_STREGA_INTERVAL') {
    var stregaTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var stregaClosedMinutes = Number(cmd.closedIntervalMinutes || cmd.intervalMinutes || cmd.minutes || 0);
    var stregaOpenMinutes = Number(cmd.openIntervalMinutes || 2);
    var stregaTamperDisabled = cmd.tamperDisabled === true || String(cmd.tamperDisabled || '').toLowerCase() === 'true';
    var stregaClosedBase = stregaTamperDisabled ? 0x01 : 0x00;
    var stregaFPort = Number(cmd.fPort || 11);
    var stregaPayloadHex = String(cmd.payloadHex || (stregaClosedBase.toString(16).padStart(2, '0') + stregaClosedMinutes.toString(16).padStart(2, '0') + '00' + stregaOpenMinutes.toString(16).padStart(2, '0'))).toUpperCase();
    var stregaUpdateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: stregaTargetEui,
            closedIntervalMinutes: stregaClosedMinutes,
            openIntervalMinutes: stregaOpenMinutes,
            tamperDisabled: stregaTamperDisabled,
            payloadHex: stregaPayloadHex,
            fPort: stregaFPort
        })
    };
    var stregaActuatorMsg = {
        payload: {
            type: 'actuator_command',
            device: { devEui: stregaTargetEui },
            data: {
                action: 'SET_INTERVAL',
                closed_interval_minutes: stregaClosedMinutes,
                open_interval_minutes: stregaOpenMinutes,
                tamper_disabled: stregaTamperDisabled,
                reason: 'osi_server_command',
                commandId: cmd.commandId || null,
                eventUuid: cmd.eventUuid || null,
                aggregateType: cmd.aggregateType || null,
                aggregateKey: cmd.aggregateKey || null,
                appliedSyncVersion: cmd.appliedSyncVersion || null,
                payloadHex: stregaPayloadHex,
                fPort: stregaFPort,
                commandType: 'SET_STREGA_INTERVAL'
            }
        }
    };
    return [stregaActuatorMsg, stregaUpdateMsg, null, null, null];
}

if (commandType === 'SET_STREGA_MODEL') {
    var stregaModelTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var stregaModel = String(cmd.stregaModel || cmd.model || '').trim().toUpperCase();
    msg.payload = Object.assign({}, cmd, {
        deviceEui: stregaModelTargetEui,
        stregaModel: stregaModel
    });
    return [null, msg, null, null, null];
}

if (commandType === 'SET_STREGA_TIMED_ACTION') {
    var stregaTimedTargetEui = String(cmd.deviceEui || cmd.device_eui || cmd.devEui || '').trim().toUpperCase();
    var stregaTimedSeconds = Number(cmd.duration_seconds);
    var stregaTimedMinutes = Math.ceil(stregaTimedSeconds / 60);
    if (String(cmd.action || cmd.valveAction || '').trim().toUpperCase() !== 'OPEN' || !(stregaTimedMinutes >= 1 && stregaTimedMinutes <= 255)) {
        msg.topic = 'devices/' + piEui + '/command_ack';
        msg.payload = JSON.stringify({ commandId: cmd.commandId || cmd.command_id || null, eventUuid: cmd.eventUuid || null, aggregateType: cmd.aggregateType || null, aggregateKey: cmd.aggregateKey || null, commandType: commandType, deviceEui: stregaTimedTargetEui || null, result: 'REJECTED_PERMANENT', reason: 'valve_action_not_allowed', appliedSyncVersion: cmd.appliedSyncVersion == null ? null : cmd.appliedSyncVersion });
        msg.qos = 1;
        return [null, null, msg, null, null];
    }
    msg._stregaExpectationCommand = Object.assign({}, cmd, {
        command_type: commandType,
        device_eui: stregaTimedTargetEui,
        duration_seconds: stregaTimedSeconds,
        duration_minutes: stregaTimedMinutes
    });
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: stregaTimedTargetEui },
        data: {
            action: 'OPEN_FOR_DURATION',
            duration_minutes: stregaTimedMinutes,
            reason: 'osi_server_command',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            commandType: 'SET_STREGA_TIMED_ACTION',
            effectKey: cmd.effectKey || cmd.effect_key || null,
            deviceEui: stregaTimedTargetEui
        }
    };
    return [msg, null, null, null, null];
}

if (commandType === 'SET_STREGA_MAGNET_MODE') {
    var stregaMagnetTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var stregaMagnetEnabled = cmd.enabled === true || String(cmd.enabled || '').toLowerCase() === 'true';
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: stregaMagnetTargetEui },
        data: {
            action: 'SET_MAGNET_MODE',
            enabled: stregaMagnetEnabled,
            reason: 'osi_server_command',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            payloadHex: String(cmd.payloadHex || '').toUpperCase() || null,
            fPort: Number(cmd.fPort || 22) || 22,
            commandType: 'SET_STREGA_MAGNET_MODE'
        }
    };
    return [msg, null, null, null, null];
}

if (commandType === 'SET_STREGA_PARTIAL_OPENING') {
    var stregaPartialTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var stregaPartialAction = String(cmd.action || cmd.valveAction || '').trim().toUpperCase();
    var stregaPartialPercentage = Number(cmd.percentage || 0);
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: stregaPartialTargetEui },
        data: {
            action: 'SET_PARTIAL_OPENING',
            valve_action: stregaPartialAction,
            percentage: stregaPartialPercentage,
            reason: 'osi_server_command',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            payloadHex: String(cmd.payloadHex || '').toUpperCase() || null,
            fPort: 27,
            commandType: 'SET_STREGA_PARTIAL_OPENING',
            effectKey: cmd.effectKey || cmd.effect_key || null
        }
    };
    return [msg, null, null, null, null];
}

if (commandType === 'SET_STREGA_FLUSHING') {
    var stregaFlushTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var stregaReturnPosition = String(cmd.returnPosition || '').trim().toUpperCase();
    var stregaFlushPercentage = Number(cmd.percentage || 0);
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: stregaFlushTargetEui },
        data: {
            action: 'SET_FLUSHING',
            return_position: stregaReturnPosition,
            percentage: stregaFlushPercentage,
            reason: 'osi_server_command',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            payloadHex: String(cmd.payloadHex || '').toUpperCase() || null,
            fPort: 28,
            commandType: 'SET_STREGA_FLUSHING',
            effectKey: cmd.effectKey || cmd.effect_key || null
        }
    };
    return [msg, null, null, null, null];
}

if (commandType === 'UC512_OPEN_FOR_DURATION') {
    msg.topic = 'devices/' + piEui + '/command_ack';
    msg.payload = JSON.stringify({ commandId: cmd.commandId || cmd.command_id || null, eventUuid: cmd.eventUuid || null, aggregateType: cmd.aggregateType || null, aggregateKey: cmd.aggregateKey || null, commandType: commandType, result: 'REJECTED_PERMANENT', reason: 'no_dispatcher_on_gateway', appliedSyncVersion: cmd.appliedSyncVersion == null ? null : cmd.appliedSyncVersion });
    msg.qos = 1;
    return [null, null, msg, null, null];
}
return routeNonValveCommand(msg, { cmd, commandType, piEui, env, global, setTimeout });
}

module.exports = { routeCommand };
