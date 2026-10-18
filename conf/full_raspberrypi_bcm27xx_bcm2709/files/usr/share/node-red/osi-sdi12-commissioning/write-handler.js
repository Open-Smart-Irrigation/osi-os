'use strict';

function handleWrite({msg,node,osiLib,osiDb,global,context}) {
var info = msg.sdi12;
if (!info) return null;
var row = Array.isArray(msg.payload) && msg.payload.length ? msg.payload[0] : {};

function reportFailure(stage) {
  var codes = {
    normalizer_load: 'NORMALIZER_LOAD_FAILED', writer_load: 'WRITER_LOAD_FAILED',
    manifest_load: 'MANIFEST_LOAD_FAILED', normalize_run: 'NORMALIZE_RUN_FAILED',
    db_open: 'DB_OPEN_FAILED', writer_run: 'WRITER_RUN_FAILED', db_close: 'DB_CLOSE_FAILED'
  };
  if (!Object.prototype.hasOwnProperty.call(codes, stage)) throw new Error('sdi12 write: unknown failure stage ' + stage);
  node.error('SDI12 write failed [' + stage + '] code=' + codes[stage], msg);
  node.status({ fill: 'red', shape: 'dot', text: 'SDI12 ' + codes[stage] });
  return [null, null];
}
function shouldObserve() {
  return (row.sdi12_deployment_status === 'queued' || row.sdi12_deployment_status === 'observed_once')
    && Boolean(row.sdi12_deployment_queue_drained_at);
}
function boundedObservationCode(error) {
  var code = String(error && error.code || 'unknown');
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown';
}
return (async () => {
  var normRes = osiLib.require('sdi12-normalize');
  if (!normRes.ok) return reportFailure('normalizer_load');
  var writerRes = osiLib.require('device-writer');
  if (!writerRes.ok) return reportFailure('writer_load');
  var commissioningRes = osiLib.require('sdi12-commissioning');
  var tensiomarkLayout = row.sdi12_probe_profile === 'TENSIOMARK'
    ? normRes.value.validateTensiomarkLayout(row.sdi12_channel_layout_json) : null;
  var configuredTensiomark = tensiomarkLayout && tensiomarkLayout.ok;
  async function observeBestEffort(db, normalization, outcome, observedAt) {
    if (!shouldObserve()) return;
    if (!commissioningRes.ok) {
      node.warn('SDI12 recipe observation failed code=helper_unavailable');
      return;
    }
    try {
      await commissioningRes.value.observeAcquisition(db, {
        deveui: info.deveui, observedAt: observedAt, profileId: row.sdi12_probe_profile || null,
        layout: row.sdi12_channel_layout_json, normalization: normalization, outcome: outcome
      });
    } catch (error) {
      node.warn('SDI12 recipe observation failed code=' + boundedObservationCode(error));
    }
  }
  if (info.quarantineOnly && !configuredTensiomark) {
    var qdb = null;
    var quarantineWritten = false;
    var quarantineNow = Date.now();
    var quarantineObservedAt = info.recordedAt || new Date(quarantineNow).toISOString();
    if (typeof writerRes.value.clampRecordedAt === 'function') {
      quarantineObservedAt = writerRes.value.clampRecordedAt(info.recordedAt, quarantineNow).recordedAt;
    }
    try {
      qdb = new osiDb.Database('/data/db/farming.db');
      await writerRes.value.quarantineOnly(qdb, info.deveui, info.quarantineOnly.channel, info.quarantineOnly.raw);
      quarantineWritten = true;
      node.status({ fill: 'yellow', shape: 'ring', text: 'SDI12 segments incomplete ' + info.deveui });
    } catch (error) {
      reportFailure(qdb ? 'writer_run' : 'db_open');
    } finally {
      if (qdb) {
        await observeBestEffort(qdb, null, {
          inserted: false,
          deadLettered: quarantineWritten ? [{ channel: info.quarantineOnly.channel, reason: 'unknown_channel' }] : null,
          quarantined: true, writeFailed: !quarantineWritten
        }, quarantineObservedAt);
        try { await qdb.close(); } catch (closeError) { reportFailure('db_close'); }
      }
    }
    return [null, null];
  }
  var fs = global.get('fs');
  var edgeManifest;
  try {
    edgeManifest = JSON.parse(fs.readFileSync('/srv/node-red/edge-channels.json', 'utf8'));
  } catch (error) {
    return reportFailure('manifest_load');
  }
  var result;
  try {
    result = configuredTensiomark ? normRes.value.normalizeTensiomarkUplink(
      info, tensiomarkLayout, { recordedAt: info.recordedAt }
    ) : normRes.value.normalize(
      info.decoded,
      { probeProfile: row.sdi12_probe_profile || null, sdi12ValueCount: row.sdi12_value_count, sdi12ChannelLayout: row.sdi12_channel_layout_json },
      { recordedAt: info.recordedAt }
    );
  } catch (error) {
    return reportFailure('normalize_run');
  }
  if (result.noResponse) node.warn('sdi12 ' + info.deveui + ': probe returned NULL (no response)');
  var db = null;
  try {
    db = new osiDb.Database('/data/db/farming.db');
  } catch (error) {
    return reportFailure('db_open');
  }
  var writerFailed = false;
  var writeResult = null;
  var writeNow = Date.now();
  var observedAt = result.recordedAt || info.recordedAt || new Date(writeNow).toISOString();
  if (typeof writerRes.value.clampRecordedAt === 'function') {
    observedAt = writerRes.value.clampRecordedAt(result.recordedAt || info.recordedAt, writeNow).recordedAt;
  }
  try {
    if (result.tensiomarkObservation) {
      writeResult = await require('./tensiomark').writeTensiomarkObservation(
        db, edgeManifest, result, {deveui:info.deveui,payloadBase64:info.payloadBase64}, {node:node,msg:msg,nowMs:writeNow});
    } else {
      writeResult = await writerRes.value.writeDeviceData(
      db, edgeManifest, result, { deveui: info.deveui }, { node: node, msg: msg, nowMs: writeNow });
    }
    if (writeResult.deadLettered.length > 0) {
      var warnDevice = String(info.deveui || '').trim().toUpperCase() || 'UNKNOWN';
      var warnKey = 'sdi12-dead-letter-warn:' + warnDevice;
      var nowMs = Date.now();
      var lastWarnAt = Number(context.get(warnKey) || 0);
      if (!Number.isFinite(lastWarnAt) || lastWarnAt <= 0 || nowMs - lastWarnAt >= 10 * 60 * 1000) {
        context.set(warnKey, nowMs);
        node.warn('sdi12 dead-lettered ' + writeResult.deadLettered.length + ' channels for ' + info.deveui);
      }
      node.status({ fill: 'yellow', shape: 'dot', text: info.deveui + ' cols=' + writeResult.columns.length + ' dead=' + writeResult.deadLettered.length });
    } else {
      node.status({ fill: 'green', shape: 'dot', text: info.deveui + ' cols=' + writeResult.columns.length });
    }
    msg.payload = writeResult;
  } catch (error) {
    writerFailed = true;
    reportFailure('writer_run');
  }
  await observeBestEffort(db, result, {
    inserted: Boolean(writeResult && writeResult.inserted === true),
    deadLettered: writeResult ? writeResult.deadLettered : null,
    quarantined: writeResult ? writeResult.deadLettered.length > 0 : Object.keys(result.unknown || {}).length > 0,
    writeFailed: writerFailed
  }, observedAt);
  try {
    await db.close();
  } catch (closeError) {
    reportFailure('db_close');
  }
  var firstJoinMsg = null;
  if (!writerFailed && !row.sdi12_probe_status && !row.sdi12_channel_layout_json && row.sdi12_probe_profile === 'SENTEK_ENVIROSCAN') {
    var firstJoinAppId = String(row.chirpstack_app_id || '').trim();
    if (firstJoinAppId) {
      firstJoinMsg = { deviceRow: { deveui: String(info.deveui || '').toUpperCase(), chirpstack_app_id: firstJoinAppId } };
    }
  }
  return writerFailed ? [null, null] : [msg, firstJoinMsg];
})();
}
module.exports = { handleWrite };
