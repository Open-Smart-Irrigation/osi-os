'use strict';
function handleGate({msg,node,env,osiLib,flow,context}) {
// Output 1: FPort 2 periodic sensor payload -> config query chain.
// Output 2: FPort 100 identify echo -> identify handler.
// payver 2 (AT+DATAUP=1) frames are reassembled per device here, via
// osi-sdi12-reassemble + flow context; only complete sequences go on.
// Everything else (FPort 5 status, FPort 3 datalog, unknown ports/payvers)
// is dropped with a visible status, never written.
var data = msg.payload;
if (!data || !data.deviceInfo) return null;
var profileId = String(data.deviceInfo.deviceProfileId || '').trim();
var sdi12ProfileId = String(env.get('CHIRPSTACK_PROFILE_SDI12') || '').trim();
if (!sdi12ProfileId || profileId !== sdi12ProfileId) return null; // strict id match, no name fallback
var deveui = String(data.deviceInfo.devEui || '').toUpperCase();
// F83: idempotent ingest -- drop an MQTT/ChirpStack redelivery of the
// identical uplink instead of writing a second device_data row.
// Fails OPEN (F83-V1): a hostile identity field or a shape-drifted
// uplink-dedup module must never block this write, so the whole check
// is guarded by both a typeof probe and a try/catch.
var _dedupIsDup = false;
var _dedupRes = null;
try {
  _dedupRes = osiLib.require('uplink-dedup');
  if (_dedupRes.ok && typeof _dedupRes.value.isDuplicateUplink === 'function') {
    _dedupIsDup = !!_dedupRes.value.isDuplicateUplink({
      source: 'sdi12', deduplicationId: data.deduplicationId,
      devEui: deveui, fCnt: data.fCnt, receivedAtMs: Date.now()
    });
  }
} catch (_dedupErr) {
  _dedupIsDup = false;
}
if (_dedupIsDup) {
  if (_dedupRes && _dedupRes.ok && typeof _dedupRes.value.warnOncePerWindow === 'function') {
    _dedupRes.value.warnOncePerWindow(node, context, 'uplink-dedup-warn:sdi12:' + deveui, Date.now(), 600000,
      'duplicate uplink dropped (F83): ' + deveui + ' fCnt=' + data.fCnt);
  }
  return null;
}

var fPort = Number(data.fPort);
var decoded = data.object || {};
msg.sdi12 = { payloadBase64: typeof data.data === 'string' ? data.data : null, deveui: deveui, fPort: fPort, decoded: decoded, recordedAt: data.time || null };
if (fPort === 100) return [null, msg];
if (fPort === 2 && decoded.unsupported_payload !== undefined) {
  // Unknown/short payload version: durable evidence, never silent. A firmware
  // payver bump must not stop telemetry without a quarantine trail.
  node.status({ fill: 'yellow', shape: 'ring', text: 'unsupported payload ' + decoded.unsupported_payload + ' ' + deveui });
  msg.sdi12.quarantineOnly = { channel: 'sdi12_unsupported_payload', raw: String(decoded.unsupported_payload) };
  return [msg, null];
}
if (fPort !== 2 || decoded.unsupported_fport !== undefined) {
  node.status({ fill: 'grey', shape: 'ring', text: 'dropped fport ' + fPort + ' ' + deveui });
  return null;
}
if (decoded.Payver !== 2 || decoded.SegCount === undefined) {
  return [msg, null]; // payver 1: unchanged single-uplink path
}
var reRes = osiLib.require('sdi12-reassemble');
if (!reRes.ok) {
  node.error('SDI12 gate: reassemble module load failed: ' + reRes.error, msg);
  node.status({ fill: 'red', shape: 'dot', text: 'SDI12 REASSEMBLE_LOAD_FAILED' });
  return null;
}
var state = flow.get('sdi12_reassembly') || {};
var r;
try {
  r = reRes.value.step(state, deveui, {
    count: decoded.SegCount, index: decoded.SegIndex, ascii: String(decoded.data_sum || ''),
    batV: decoded.BatV, extiTrigger: decoded.EXTI_Trigger, recordedAt: data.time || null, nowMs: Date.now()
  });
} catch (e) {
  node.error('SDI12 gate: reassemble step failed: ' + (e && e.message), msg);
  node.status({ fill: 'red', shape: 'dot', text: 'SDI12 REASSEMBLE_STEP_FAILED' });
  return null;
}
flow.set('sdi12_reassembly', state);
node.status({ fill: r.action === 'reset' ? 'yellow' : 'blue', shape: r.action === 'complete' ? 'dot' : 'ring', text: r.status + ' ' + deveui });
if (r.action === 'buffered') return null;
if (r.action === 'reset') {
  msg.sdi12.quarantineOnly = r.quarantine;
  return [msg, null]; // write node records the dead-letter, no row
}
// complete or passthrough
var announced = flow.get('sdi12_reassembly_announced') || {};
if (r.action === 'complete' && !announced[deveui]) {
  announced[deveui] = true; flow.set('sdi12_reassembly_announced', announced);
  node.warn('sdi12 multi-segment reassembled: ' + deveui + ' ' + decoded.SegCount + ' segments, ' + r.message.data_sum.length + ' bytes');
}
msg.sdi12.decoded = r.message;
msg.sdi12.recordedAt = r.message.recordedAt || msg.sdi12.recordedAt;
return [msg, null];
}
module.exports={handleGate};
