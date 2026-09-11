'use strict';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EUI = /^[0-9A-F]{16}$/;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function requiredUuid(value, name) {
  const result = text(value).toLowerCase();
  if (!UUID_V4.test(result)) throw new Error(name + ' must be a canonical UUID v4');
  return result;
}

function requiredEui(value, name) {
  const result = text(value).toUpperCase();
  if (!EUI.test(result)) throw new Error(name + ' must be an uppercase 16-hex DevEUI');
  return result;
}

function optionalText(value) { return value == null || text(value) === '' ? null : text(value); }

function numberOrNull(value, name, predicate) {
  if (value == null) return null;
  if (typeof value === 'boolean' || (typeof value === 'string' && value.trim() === '')) throw new Error(name + ' is invalid');
  const result = Number(value);
  if (!Number.isFinite(result) || (predicate && !predicate(result))) throw new Error(name + ' is invalid');
  return result;
}

function timestamp(value, name) {
  const result = text(value);
  if (!result || !Number.isFinite(Date.parse(result))) throw new Error(name + ' must be an ISO timestamp');
  return new Date(result).toISOString();
}

function validateCommon(input, now) {
  const values = input.values || {};
  const deviceEui = requiredEui(input.deviceEui, 'deviceEui');
  const installationUuid = requiredUuid(input.installationUuid, 'installationUuid');
  const revisionUuid = requiredUuid(input.revisionUuid, 'revisionUuid');
  const effectiveFrom = timestamp(values.effectiveFrom, 'effectiveFrom');
  const recordedAt = timestamp(values.recordedAt || now, 'recordedAt');
  return {
    revisionUuid, deviceEui, installationUuid,
    gatewayEui: requiredEui(input.gatewayEui, 'gatewayEui'),
    baseRevisionUuid: input.baseRevisionUuid == null || text(input.baseRevisionUuid) === '' ? null : requiredUuid(input.baseRevisionUuid, 'baseRevisionUuid'),
    actorUserUuid: input.actorUserUuid == null || text(input.actorUserUuid) === '' ? null : requiredUuid(input.actorUserUuid, 'actorUserUuid'),
    revisionNo: 0, effectiveFrom, recordedAt,
    now: timestamp(now, 'now')
  };
}

function locationValues(input, common) {
  const values = input.values || {};
  const latitude = numberOrNull(values.latitude, 'latitude', n => n >= -90 && n <= 90);
  const longitude = numberOrNull(values.longitude, 'longitude', n => n >= -180 && n <= 180);
  if (latitude == null || longitude == null) throw new Error('latitude and longitude are required');
  return Object.assign(common, {
    latitude, longitude,
    altitudeM: numberOrNull(values.altitudeM, 'altitudeM'),
    verticalReference: optionalText(values.verticalReference),
    accuracyM: numberOrNull(values.accuracyM, 'accuracyM', n => n >= 0),
    antennaHeightAglM: numberOrNull(values.antennaHeightAglM, 'antennaHeightAglM', n => n >= 0),
    coordinateSource: text(values.coordinateSource) || 'manual',
    supersedesRevisionUuid: values.supersedesRevisionUuid == null || text(values.supersedesRevisionUuid) === '' ? null : requiredUuid(values.supersedesRevisionUuid, 'supersedesRevisionUuid')
  });
}

function radioValues(input, common) {
  const values = input.values || {};
  return Object.assign(common, {
    txPowerDbm: numberOrNull(values.txPowerDbm, 'txPowerDbm'),
    antennaGainDbi: numberOrNull(values.antennaGainDbi, 'antennaGainDbi', n => n >= 0 && n <= 13),
    feederLossDb: numberOrNull(values.feederLossDb, 'feederLossDb', n => n >= 0),
    configurationSource: text(values.configurationSource) || 'unknown',
    supersedesRevisionUuid: values.supersedesRevisionUuid == null || text(values.supersedesRevisionUuid) === '' ? null : requiredUuid(values.supersedesRevisionUuid, 'supersedesRevisionUuid')
  });
}

async function save(db, table, input, now, makeValues) {
  const common = validateCommon(input, now);
  const row = makeValues(input, common);
  return db.transaction(async tx => {
    const device = await tx.get('SELECT deveui, gateway_device_eui FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1', [row.deviceEui]);
    if (!device) throw new Error('device does not exist');
    if (row.gatewayEui && device.gateway_device_eui && row.gatewayEui !== device.gateway_device_eui) throw new Error('device gateway assignment mismatch');
    const identity = await tx.get("SELECT installation_uuid FROM installation_identity WHERE singleton_id=1 AND recovery_state='ACTIVE' LIMIT 1");
    if (!identity || identity.installation_uuid !== row.installationUuid) throw new Error('installation identity mismatch');
    const existing = await tx.get('SELECT * FROM ' + table + ' WHERE revision_uuid=? LIMIT 1', [row.revisionUuid]);
    if (existing) {
      if (!input.values || input.values.recordedAt == null) row.recordedAt = existing.recorded_at;
      const comparable = table === 'device_installation_location_revisions'
        ? [existing.device_eui, existing.installation_uuid, existing.source_gateway_device_eui, existing.base_revision_uuid, existing.latitude, existing.longitude, existing.altitude_m, existing.vertical_reference, existing.accuracy_m, existing.antenna_height_agl_m, existing.coordinate_source, existing.effective_from, existing.recorded_at, existing.actor_user_uuid, existing.supersedes_revision_uuid]
        : [existing.device_eui, existing.installation_uuid, existing.source_gateway_device_eui, existing.base_revision_uuid, existing.tx_power_dbm, existing.antenna_gain_dbi, existing.feeder_loss_db, existing.configuration_source, existing.effective_from, existing.recorded_at, existing.actor_user_uuid, existing.supersedes_revision_uuid];
      const incoming = table === 'device_installation_location_revisions'
        ? [row.deviceEui, row.installationUuid, row.gatewayEui, row.baseRevisionUuid, row.latitude, row.longitude, row.altitudeM, row.verticalReference, row.accuracyM, row.antennaHeightAglM, row.coordinateSource, row.effectiveFrom, row.recordedAt, row.actorUserUuid, row.supersedesRevisionUuid]
        : [row.deviceEui, row.installationUuid, row.gatewayEui, row.baseRevisionUuid, row.txPowerDbm, row.antennaGainDbi, row.feederLossDb, row.configurationSource, row.effectiveFrom, row.recordedAt, row.actorUserUuid, row.supersedesRevisionUuid];
      if (JSON.stringify(comparable) !== JSON.stringify(incoming)) throw new Error('revision UUID payload mismatch');
      return Object.assign({}, existing, { revisionNo: existing.revision_no, replayed: true });
    }
    const head = await tx.get(
      'SELECT revision_uuid, revision_no FROM ' + table + ' WHERE device_eui=? AND installation_uuid=? AND revision_uuid NOT IN (SELECT supersedes_revision_uuid FROM ' + table + ' WHERE supersedes_revision_uuid IS NOT NULL) ORDER BY revision_no DESC LIMIT 1',
      [row.deviceEui, row.installationUuid]
    );
    if (head) {
      if (row.baseRevisionUuid !== head.revision_uuid) throw new Error('stale base revision');
      row.revisionNo = Number(head.revision_no) + 1;
    } else if (row.baseRevisionUuid !== null) {
      throw new Error('base revision does not exist');
    } else {
      row.revisionNo = 1;
    }
    const highest = await tx.get('SELECT COALESCE(MAX(revision_no),0) AS revision_no FROM ' + table + ' WHERE device_eui=?', [row.deviceEui]);
    row.revisionNo = Number(highest.revision_no) + 1;
    if (row.supersedesRevisionUuid && row.supersedesRevisionUuid === row.revisionUuid) throw new Error('revision cannot supersede itself');
    if (row.supersedesRevisionUuid) {
      const prior = await tx.get('SELECT device_eui, installation_uuid, effective_from FROM ' + table + ' WHERE revision_uuid=? LIMIT 1', [row.supersedesRevisionUuid]);
      if (!prior || prior.device_eui !== row.deviceEui || prior.installation_uuid !== row.installationUuid) throw new Error('superseded revision belongs to another device or installation');
      if (prior.effective_from !== row.effectiveFrom) throw new Error('correction must retain effective time');
    }
    const columns = table === 'device_installation_location_revisions'
      ? ['revision_uuid','device_eui','installation_uuid','source_gateway_device_eui','base_revision_uuid','revision_no','latitude','longitude','altitude_m','vertical_reference','accuracy_m','antenna_height_agl_m','coordinate_source','effective_from','recorded_at','actor_user_uuid','supersedes_revision_uuid','sync_version','created_at']
      : ['revision_uuid','device_eui','installation_uuid','source_gateway_device_eui','base_revision_uuid','revision_no','tx_power_dbm','antenna_gain_dbi','feeder_loss_db','configuration_source','effective_from','recorded_at','actor_user_uuid','supersedes_revision_uuid','sync_version','created_at'];
    const values = table === 'device_installation_location_revisions'
      ? [row.revisionUuid,row.deviceEui,row.installationUuid,row.gatewayEui,row.baseRevisionUuid,row.revisionNo,row.latitude,row.longitude,row.altitudeM,row.verticalReference,row.accuracyM,row.antennaHeightAglM,row.coordinateSource,row.effectiveFrom,row.recordedAt,row.actorUserUuid,row.supersedesRevisionUuid,row.revisionNo,row.now]
      : [row.revisionUuid,row.deviceEui,row.installationUuid,row.gatewayEui,row.baseRevisionUuid,row.revisionNo,row.txPowerDbm,row.antennaGainDbi,row.feederLossDb,row.configurationSource,row.effectiveFrom,row.recordedAt,row.actorUserUuid,row.supersedesRevisionUuid,row.revisionNo,row.now];
    await tx.run('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')', values);
    return Object.assign({}, row);
  });
}

function resolveQuery(table, deviceEui, at, installationUuid) {
  const args = [requiredEui(deviceEui, 'deviceEui'), installationUuid];
  args.push(timestamp(at == null ? new Date().toISOString() : at, 'at'));
  const time = ' AND effective_from <= ?';
  return { sql: 'SELECT * FROM ' + table + ' WHERE device_eui=? AND installation_uuid=?' + time + ' AND revision_uuid NOT IN (SELECT supersedes_revision_uuid FROM ' + table + ' WHERE supersedes_revision_uuid IS NOT NULL) ORDER BY effective_from DESC, revision_no DESC LIMIT 1', args };
}

async function resolve(db, table, deviceEui, at, map) {
  const identity = await db.get("SELECT installation_uuid FROM installation_identity WHERE singleton_id=1 AND recovery_state='ACTIVE'");
  if (!identity) return null;
  const query = resolveQuery(table, deviceEui, at, identity.installation_uuid);
  const row = await db.get(query.sql, query.args);
  return row ? map(row) : null;
}

function saveLocation(db, input) { return save(db, 'device_installation_location_revisions', input, input.now || new Date().toISOString(), locationValues); }
function saveRadioConfiguration(db, input) { return save(db, 'device_radio_configuration_revisions', input, input.now || new Date().toISOString(), radioValues); }
function mapLocation(row) { return Object.assign({}, row, { deviceEui: row.device_eui, installationUuid: row.installation_uuid, gatewayEui: row.source_gateway_device_eui, revisionUuid: row.revision_uuid, revisionNo: row.revision_no }); }
function mapRadio(row) { return Object.assign({}, row, { deviceEui: row.device_eui, installationUuid: row.installation_uuid, revisionUuid: row.revision_uuid, revisionNo: row.revision_no }); }
function resolveLocation(db, deviceEui, at) { return resolve(db, 'device_installation_location_revisions', deviceEui, at, mapLocation); }
function resolveRadioConfiguration(db, deviceEui, at) { return resolve(db, 'device_radio_configuration_revisions', deviceEui, at, mapRadio); }

module.exports = { applyCommand: (...args) => require('./commands').applyCommand(...args), saveLocation, resolveLocation, saveRadioConfiguration, resolveRadioConfiguration };
