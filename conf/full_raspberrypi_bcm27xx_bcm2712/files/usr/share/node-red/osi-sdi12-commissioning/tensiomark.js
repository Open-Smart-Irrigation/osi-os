'use strict';

function fail(statusCode, code) {
  const error = new Error('tensiomark_configuration_error');
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parseLayout(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_error) { return null; }
}

function hasTensiomarkLayout(row) {
  const layout = parseLayout(row && row.sdi12_channel_layout_json);
  return Boolean(layout && layout.kind === 'tensiomark');
}

async function saveTensiomarkLayout(db, input) {
  const deveui = String(input && input.deveui || '').trim().toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(deveui)) throw fail(400, 'invalid_deveui');
  const { validateTensiomarkLayout } = require('../osi-sdi12-normalize');
  const validated = validateTensiomarkLayout(input && input.layout);
  if (!validated.ok) throw fail(400, 'invalid_tensiomark_layout');
  const layoutJson = JSON.stringify(validated.layout);
  const depthsJson = JSON.stringify(validated.depths);
  return db.transaction(async (tx) => {
    const row = await tx.get('SELECT * FROM devices WHERE deveui = ?', [deveui]);
    if (!row) throw fail(404, 'device_not_found');
    if (row.type_id !== 'DRAGINO_SDI12') throw fail(409, 'wrong_device_type');
    const deployment = await tx.get('SELECT status FROM sdi12_recipe_deployments WHERE deveui = ?', [deveui]);
    if (deployment && ['queueing', 'queued'].includes(deployment.status)) throw fail(409, 'deployment_in_progress');
    const oldLayout = validateTensiomarkLayout(parseLayout(row.sdi12_channel_layout_json));
    const changed = row.sdi12_probe_profile !== 'TENSIOMARK' || !oldLayout.ok
      || oldLayout.configurationHash !== validated.configurationHash
      || row.soil_moisture_probe_depths_json !== depthsJson
      || row.sdi12_value_count !== null || row.sdi12_probe_status !== 'manual';
    if (changed) {
      await tx.run('UPDATE devices SET sdi12_probe_profile=?, sdi12_probe_status=?, sdi12_channel_layout_json=?, '
        + 'soil_moisture_probe_depths_json=?, soil_moisture_probe_depths_configured=?, sdi12_value_count=NULL, '
        + 'sync_version=COALESCE(sync_version,0)+1, updated_at=? WHERE deveui=?',
      ['TENSIOMARK','manual',layoutJson,depthsJson,Object.keys(validated.depths).length ? 1 : 0,new Date().toISOString(),deveui]);
    }
    await tx.run('DELETE FROM sdi12_identify_attempts WHERE deveui=?', [deveui]);
    return {profileId:'TENSIOMARK', status:'manual', layout:validated.layout, depths:validated.depths, valueCount:null, changed};
  });
}

function validateTensiomarkDepthMap(depths) {
  if (!depths || typeof depths !== 'object' || Array.isArray(depths)) throw fail(400, 'invalid_values');
  if (Object.keys(depths).some(key => !/^(swt|soil_temp)_[12]$/.test(key))) throw fail(400, 'invalid_values');
  for (const channel of [1, 2]) {
    const swt = 'swt_' + channel;
    const temp = 'soil_temp_' + channel;
    const hasSwt = Object.prototype.hasOwnProperty.call(depths, swt);
    const hasTemp = Object.prototype.hasOwnProperty.call(depths, temp);
    if (hasSwt !== hasTemp || (hasSwt && (depths[swt] !== depths[temp]
      || !Number.isInteger(depths[swt]) || depths[swt] < 1 || depths[swt] > 1000))) {
      throw fail(400, 'invalid_values');
    }
  }
}

// A depth edit derives the layout from the current edge row. It cannot replace
// probe identity, address, calibration qualification or measurement settings.
function projectTensiomarkDepths(row, depths) {
  const { validateTensiomarkLayout } = require('../osi-sdi12-normalize');
  const validated = validateTensiomarkLayout(row && row.sdi12_channel_layout_json);
  if (!row || row.type_id !== 'DRAGINO_SDI12' || row.sdi12_probe_profile !== 'TENSIOMARK' || !validated.ok) {
    throw fail(400, 'unsupported_device_type');
  }
  validateTensiomarkDepthMap(depths);
  const allowed = new Set();
  const sensors = validated.layout.sensors.map(sensor => {
    const swt = 'swt_' + sensor.channel;
    allowed.add(swt); allowed.add('soil_temp_' + sensor.channel);
    return { ...sensor, depth_cm: depths[swt] === undefined ? null : depths[swt] };
  });
  if (Object.keys(depths).some(key => !allowed.has(key))) throw fail(400, 'invalid_values');
  return validateTensiomarkLayout({ ...validated.layout, sensors });
}

async function updateTensiomarkDepthsTx(tx, row, depths, expectedVersion) {
  if (Number(row.sync_version || 0) !== expectedVersion) throw fail(409, 'stale_sync_version');
  const projected = projectTensiomarkDepths(row, depths);
  const deployment = await tx.get('SELECT status FROM sdi12_recipe_deployments WHERE deveui=?', [row.deveui]);
  if (deployment && ['queueing', 'queued'].includes(deployment.status)) throw fail(409, 'deployment_in_progress');
  await tx.run('UPDATE devices SET sdi12_channel_layout_json=?, soil_moisture_probe_depths_json=?, '
    + 'soil_moisture_probe_depths_configured=1, sync_version=COALESCE(sync_version,0)+1, '
    + "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui=? AND COALESCE(sync_version,0)=?",
  [JSON.stringify(projected.layout), JSON.stringify(projected.depths), row.deveui, expectedVersion]);
  const changed = await tx.get('SELECT changes() AS count');
  if (!changed || Number(changed.count) !== 1) throw fail(409, 'stale_sync_version');
  return projected;
}

async function saveTensiomarkDepths(db, input) {
  return db.transaction(async tx => {
    const row = await tx.get('SELECT * FROM devices WHERE deveui=? AND deleted_at IS NULL', [input.deveui]);
    if (!row || (!input.scoped && Number(row.user_id) !== Number(input.userId))) throw fail(404, 'device_not_found');
    return updateTensiomarkDepthsTx(tx, row, input.depths, Number(row.sync_version || 0));
  });
}

async function writeTensiomarkObservation(db, manifest, result, meta, options = {}) {
  const writer = require('../osi-device-writer');
  const evidence = result && result.tensiomarkObservation;
  if (!evidence || options.shadow) throw fail(500, 'observation_required');
  if (Object.keys(result.unknown || {}).length) throw fail(500, 'unexpected_unknown_channel');
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const recordedAt = writer.clampRecordedAt(result.recordedAt || meta.recordedAt, nowMs).recordedAt;
  return db.transaction(async (tx) => {
    const before = await tx.get('SELECT COALESCE(MAX(rowid),0) AS high FROM sync_outbox');
    const written = await writer.writeDeviceData(tx, manifest, {...result, recordedAt}, meta, {...options, nowMs});
    if (!written.inserted || !Number.isSafeInteger(written.deviceDataId) || written.deadLettered.length) {
      throw fail(500, 'canonical_observation_write_failed');
    }
    // SQLite json_object shortens some REAL values. Rebuild only this insert's
    // new event with JS round-trippable numbers before the transaction commits.
    const aggregateKey = String(meta.deveui).trim().toUpperCase() + '|' + recordedAt;
    const events = await tx.all("SELECT event_uuid,payload_json FROM sync_outbox WHERE rowid>? AND aggregate_type='DEVICE_DATA' AND op='DEVICE_DATA_APPENDED' AND aggregate_key=?", [before.high, aggregateKey]);
    if (events.length > 1) throw fail(500, 'ambiguous_observation_event');
    for (const event of events) {
      const payload = Object.assign(JSON.parse(event.payload_json), result.channels);
      await tx.run('UPDATE sync_outbox SET payload_json=? WHERE event_uuid=?', [JSON.stringify(payload), event.event_uuid]);
    }
    await tx.run('INSERT INTO tensiomark_observations ('
      + 'device_data_id,deveui,recorded_at,received_at,raw_response,payload_base64,'
      + 'configuration_hash,configuration_json,disposition,normalized_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [written.deviceDataId,String(meta.deveui).trim().toUpperCase(),recordedAt,new Date(nowMs).toISOString(),
      evidence.rawResponse,typeof meta.payloadBase64 === 'string' ? meta.payloadBase64 : null,
      evidence.configurationHash,evidence.configurationJson,evidence.disposition,
      JSON.stringify({normalization_version:2,conversion:'matric-potential-hpa-v1',native_pf:result.nativePf || evidence.nativePf || {},channels:result.channels,disposition:evidence.disposition})]);
    return written;
  });
}

module.exports = { saveTensiomarkLayout, hasTensiomarkLayout, validateTensiomarkDepthMap, projectTensiomarkDepths, updateTensiomarkDepthsTx, saveTensiomarkDepths, writeTensiomarkObservation };
