// Preserve the legacy Function bodies directive mode.
// Verbatim non-valve branches of the legacy command router.
// Callers inject OS adapters and the timer; this module does no implicit IO.
function routeNonValveCommand(msg, { cmd, commandType, piEui, env, global, node, setTimeout }) {
if (commandType === 'SET_LSN50_MODE') {
    var targetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var modeText = String(cmd.mode || '').trim().toUpperCase();
    var match = modeText.match(/^MOD(\d+)$/);
    var modeCode = Number(cmd.modeCode || (match ? Number(match[1]) : 0));
    var normalizedMode = modeText || (modeCode ? ('MOD' + modeCode) : '');
    var fPort = Number(cmd.fPort || env.get('LSN50_COMMAND_FPORT') || 2);
    var payloadHex = String(cmd.payloadHex || (modeCode ? ('0A' + modeCode.toString(16).padStart(2, '0')) : '')).toUpperCase();
    var updateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: targetEui,
            mode: normalizedMode,
            modeCode: modeCode,
            payloadHex: payloadHex,
            fPort: fPort
        })
    };
    var downlinkMsg = {
        payload: {
            commandType: 'SET_LSN50_MODE',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            deviceEui: targetEui,
            mode: normalizedMode,
            modeCode: modeCode,
            payloadHex: payloadHex,
            fPort: fPort
        }
    };
    return [null, updateMsg, null, null, downlinkMsg];
}

if (commandType === 'SET_LSN50_INTERVAL') {
    var intervalTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var intervalMinutes = Number(cmd.intervalMinutes || cmd.minutes || 0);
    var intervalSeconds = Number(cmd.intervalSeconds || (Number.isFinite(intervalMinutes) ? Math.round(intervalMinutes * 60) : 0));
    var intervalFPort = Number(cmd.fPort || env.get('LSN50_COMMAND_FPORT') || 2);
    var intervalPayloadHex = String(cmd.payloadHex || (intervalSeconds > 0 ? ('01' + intervalSeconds.toString(16).padStart(6, '0')) : '')).toUpperCase();
    var intervalUpdateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: intervalTargetEui,
            intervalMinutes: intervalMinutes,
            intervalSeconds: intervalSeconds,
            payloadHex: intervalPayloadHex,
            fPort: intervalFPort
        })
    };
    var intervalDownlinkMsg = {
        payload: {
            commandType: 'SET_LSN50_INTERVAL',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            deviceEui: intervalTargetEui,
            intervalMinutes: intervalMinutes,
            intervalSeconds: intervalSeconds,
            payloadHex: intervalPayloadHex,
            fPort: intervalFPort
        }
    };
    return [null, intervalUpdateMsg, null, null, intervalDownlinkMsg];
}

if (commandType === 'SET_KIWI_INTERVAL') {
    var kiwiTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var kiwiIntervalMinutes = Number(cmd.intervalMinutes || cmd.minutes || 0);
    var kiwiIntervalSeconds = Number(cmd.intervalSeconds || (Number.isFinite(kiwiIntervalMinutes) ? Math.round(kiwiIntervalMinutes * 60) : 0));
    var kiwiFPort = Number(cmd.fPort || 100);
    var kiwiPayloadHex = String(cmd.payloadHex || (kiwiIntervalSeconds > 0 ? ('A0' + kiwiIntervalSeconds.toString(16).padStart(8, '0')) : '')).toUpperCase();
    var kiwiUpdateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: kiwiTargetEui,
            intervalMinutes: kiwiIntervalMinutes,
            intervalSeconds: kiwiIntervalSeconds,
            payloadHex: kiwiPayloadHex,
            fPort: kiwiFPort
        })
    };
    var kiwiDownlinkMsg = {
        payload: {
            commandType: 'SET_KIWI_INTERVAL',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            deviceEui: kiwiTargetEui,
            intervalMinutes: kiwiIntervalMinutes,
            intervalSeconds: kiwiIntervalSeconds,
            payloadHex: kiwiPayloadHex,
            fPort: kiwiFPort
        }
    };
    return [null, kiwiUpdateMsg, null, null, kiwiDownlinkMsg];
}

if (commandType === 'ENABLE_KIWI_TEMP_HUMIDITY') {
    var kiwiEnableTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var kiwiEnableMinutes = Number(cmd.intervalMinutes || cmd.minutes || 0);
    var kiwiEnableSeconds = Number(cmd.intervalSeconds || (Number.isFinite(kiwiEnableMinutes) ? Math.round(kiwiEnableMinutes * 60) : 0));
    var kiwiEnableFPort = Number(cmd.fPort || 100);
    var kiwiEnablePayloadHex = String(cmd.payloadHex || (kiwiEnableSeconds > 0 ? ('A0' + kiwiEnableSeconds.toString(16).padStart(8, '0') + 'A20001A30001') : '')).toUpperCase();
    var kiwiEnableUpdateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: kiwiEnableTargetEui,
            intervalMinutes: kiwiEnableMinutes,
            intervalSeconds: kiwiEnableSeconds,
            payloadHex: kiwiEnablePayloadHex,
            fPort: kiwiEnableFPort
        })
    };
    var kiwiEnableDownlinkMsg = {
        payload: {
            commandType: 'ENABLE_KIWI_TEMP_HUMIDITY',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            deviceEui: kiwiEnableTargetEui,
            intervalMinutes: kiwiEnableMinutes,
            intervalSeconds: kiwiEnableSeconds,
            payloadHex: kiwiEnablePayloadHex,
            fPort: kiwiEnableFPort
        }
    };
    return [null, kiwiEnableUpdateMsg, null, null, kiwiEnableDownlinkMsg];
}

if (commandType === 'SET_SDI12_IDENTIFY') {
    var sdi12IdentifyTargetEui = String(cmd.deviceEui || cmd.device_eui || cmd.devEui || '').trim().toUpperCase();
    var sdi12IdentifyUpdateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: sdi12IdentifyTargetEui
        })
    };
    var sdi12IdentifyTriggerMsg = {
        deviceRow: { deveui: sdi12IdentifyTargetEui }
    };
    return [null, sdi12IdentifyUpdateMsg, null, null, null, null, sdi12IdentifyTriggerMsg];
}

if (commandType === 'SET_LSN50_INTERRUPT_MODE') {
    var lsn50InterruptTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var lsn50InterruptMode = Number(cmd.interruptMode || cmd.mode || 0);
    var lsn50InterruptFPort = Number(cmd.fPort || env.get('LSN50_COMMAND_FPORT') || 2);
    var lsn50InterruptPayloadHex = String(cmd.payloadHex || ('060000' + lsn50InterruptMode.toString(16).padStart(2, '0'))).toUpperCase();
    var lsn50InterruptUpdateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: lsn50InterruptTargetEui,
            interruptMode: lsn50InterruptMode,
            payloadHex: lsn50InterruptPayloadHex,
            fPort: lsn50InterruptFPort
        })
    };
    var lsn50InterruptDownlinkMsg = {
        payload: {
            commandType: 'SET_LSN50_INTERRUPT_MODE',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            deviceEui: lsn50InterruptTargetEui,
            interruptMode: lsn50InterruptMode,
            payloadHex: lsn50InterruptPayloadHex,
            fPort: lsn50InterruptFPort
        }
    };
    return [null, lsn50InterruptUpdateMsg, null, null, lsn50InterruptDownlinkMsg];
}

if (commandType === 'SET_LSN50_5V_WARMUP') {
    var lsn50WarmupTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    var lsn50WarmupMilliseconds = Number(cmd.milliseconds || 0);
    var lsn50WarmupFPort = Number(cmd.fPort || env.get('LSN50_COMMAND_FPORT') || 2);
    var lsn50WarmupPayloadHex = String(cmd.payloadHex || ('07' + lsn50WarmupMilliseconds.toString(16).padStart(4, '0'))).toUpperCase();
    var lsn50WarmupUpdateMsg = {
        payload: Object.assign({}, cmd, {
            deviceEui: lsn50WarmupTargetEui,
            milliseconds: lsn50WarmupMilliseconds,
            payloadHex: lsn50WarmupPayloadHex,
            fPort: lsn50WarmupFPort
        })
    };
    var lsn50WarmupDownlinkMsg = {
        payload: {
            commandType: 'SET_LSN50_5V_WARMUP',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion || null,
            deviceEui: lsn50WarmupTargetEui,
            milliseconds: lsn50WarmupMilliseconds,
            payloadHex: lsn50WarmupPayloadHex,
            fPort: lsn50WarmupFPort
        }
    };
    return [null, lsn50WarmupUpdateMsg, null, null, lsn50WarmupDownlinkMsg];
}

if (['UPSERT_IRRIGATION_POLICY', 'PAUSE_IRRIGATION_POLICY', 'RETRY_IRRIGATION_VALVE'].includes(commandType)) {
    msg.payload = cmd;
    return [null, msg, null, null, null, null, null];
}

if ([
    'UPDATE_SCHEDULE',
    'UPSERT_SCHEDULE',
    'UPSERT_ZONE',
    'DELETE_ZONE',
    'UPSERT_ZONE_CONFIG',
    'UPSERT_ZONE_LOCATION',
    'ASSIGN_DEVICE_TO_ZONE',
    'REMOVE_DEVICE_FROM_ZONE',
    'UPSERT_DEVICE_FLAGS',
    'UNCLAIM_DEVICE'
].includes(commandType)) {
    msg.payload = cmd;
    return [null, msg, null, null, null];
}

if ([
    'UPSERT_VALVE_SCHEDULE',
    'DELETE_VALVE_SCHEDULE',
    'RESEND_VALVE_PLAN',
    'SET_VALVE_SCHEDULER_STATUS',
    'CANCEL_VALVE_ACTUATION',
    'UPSERT_VALVE_SETTINGS'
].includes(commandType)) {
    msg.payload = cmd;
    return [null, null, null, null, null, msg];
}

if (commandType === 'SET_FAN') {
    var fs = global.get('fs');
    var speed = (typeof cmd.speed === 'number') ? Math.max(0, Math.min(255, Math.round(cmd.speed))) : 0;
    var result = 'SUCCESS';
    try {
        function findFanCtrl(fs) {
            try {
                var dirs = fs.readdirSync('/sys/class/hwmon');
                for (var fi = 0; fi < dirs.length; fi++) {
                    try {
                        var n = fs.readFileSync('/sys/class/hwmon/' + dirs[fi] + '/name', 'utf8').trim();
                        if (n === 'pwmfan') return { type: 'hwmon', path: '/sys/class/hwmon/' + dirs[fi] };
                    } catch(e2) { node.warn('X2 fan hwmon name: ' + String(e2 && e2.message || e2)); }
                }
            } catch(e3) { node.warn('X2 fan hwmon list: ' + String(e3 && e3.message || e3)); }
            try { fs.accessSync('/sys/class/pwm/pwmchip2'); return { type: 'pwm', path: '/sys/class/pwm/pwmchip2' }; } catch(e4) { node.warn('X2 fan PWM detection: ' + String(e4 && e4.message || e4)); }
            return null;
        }
        var fanCtrl = findFanCtrl(fs);
        if (!fanCtrl) throw new Error('fan hardware not found');
        if (fanCtrl.type === 'hwmon') {
            if (speed === 0) {
                fs.writeFileSync(fanCtrl.path + '/pwm1_enable', '2');
            } else {
                fs.writeFileSync(fanCtrl.path + '/pwm1_enable', '1');
                fs.writeFileSync(fanCtrl.path + '/pwm1', String(speed));
            }
        } else {
            var PWM_CHAN = fanCtrl.path + '/pwm3';
            var PWM_PERIOD = 41566;
            try { fs.accessSync(PWM_CHAN); } catch(e5) { fs.writeFileSync(fanCtrl.path + '/export', '3'); }
            var curPeriod = 0;
            try { curPeriod = parseInt(fs.readFileSync(PWM_CHAN + '/period', 'utf8').trim()); } catch(e6) { node.warn('X2 fan PWM period: ' + String(e6 && e6.message || e6)); }
            if (curPeriod !== PWM_PERIOD) {
                try { fs.writeFileSync(PWM_CHAN + '/enable', '0'); } catch(e7) { node.warn('X2 fan PWM disable: ' + String(e7 && e7.message || e7)); }
                fs.writeFileSync(PWM_CHAN + '/period', String(PWM_PERIOD));
            }
            var duty = Math.round((1 - speed / 255) * PWM_PERIOD);
            fs.writeFileSync(PWM_CHAN + '/duty_cycle', String(duty));
            fs.writeFileSync(PWM_CHAN + '/enable', '1');
        }
    } catch(e) { result = 'FAILED'; msg.commandError = e.message; }
    msg.topic = 'devices/' + piEui + '/command_ack';
    msg.payload = JSON.stringify({ commandId: cmd.commandId, eventUuid: cmd.eventUuid, aggregateType: cmd.aggregateType, aggregateKey: cmd.aggregateKey, result: result, commandType: commandType, appliedSyncVersion: cmd.appliedSyncVersion || null, error: msg.commandError || null });
    msg.qos = 1;
    return [null, null, msg, null, null];
}

if (commandType === 'REBOOT') {
    var cp = global.get('cp');
    var result = 'SUCCESS';
    try { setTimeout(function() { cp.exec('reboot'); }, 3000); } catch(e) { result = 'FAILED'; msg.commandError = e.message; }
    msg.topic = 'devices/' + piEui + '/command_ack';
    msg.payload = JSON.stringify({ commandId: cmd.commandId, eventUuid: cmd.eventUuid, aggregateType: cmd.aggregateType, aggregateKey: cmd.aggregateKey, result: result, commandType: commandType, appliedSyncVersion: cmd.appliedSyncVersion || null, error: msg.commandError || null });
    msg.qos = 1;
    return [null, null, msg, null, null];
}

if (commandType === 'REGISTER_DEVICE' || commandType === 'SYNC_LINKED_AUTH' || commandType === 'FORCE_EDGE_SYNC') {
    msg.payload = cmd;
    return [null, null, null, msg, null];
}
return null;
}
module.exports = { routeNonValveCommand };
