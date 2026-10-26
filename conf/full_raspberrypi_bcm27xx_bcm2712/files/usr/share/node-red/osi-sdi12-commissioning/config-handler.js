'use strict';

async function handleConfig({msg,node,osiLib,osiDb}) {
var body = msg.req.body || {};
var normRes = osiLib.require('sdi12-normalize');
if (!normRes.ok) { msg.statusCode = 500; msg.payload = { message: 'profile registry unavailable' }; return msg; }
var profileId = String(body.probe_profile || '').trim();
var profile = normRes.value.getProfile(profileId);
if (!profile) { msg.statusCode = 400; msg.payload = { message: 'Unknown probe_profile' }; return msg; }

var hasTensiomark = Object.prototype.hasOwnProperty.call(body, 'tensiomark_layout');
if (hasTensiomark) {
  if (profileId !== 'TENSIOMARK' || Object.keys(body).some(function (key) { return key !== 'probe_profile' && key !== 'tensiomark_layout'; })) {
    msg.statusCode = 400; msg.payload = { message: 'Tensiomark layout cannot be combined with other configuration fields', code: 'invalid_tensiomark_config' }; return msg;
  }
  var tdb = new osiDb.Database('/data/db/farming.db');
  try {
    var savedTensiomark = await require('./tensiomark').saveTensiomarkLayout(tdb, { deveui: msg.deviceRow.deveui, layout: body.tensiomark_layout });
    msg.payload = { probe_profile: savedTensiomark.profileId, status: savedTensiomark.status, layout: savedTensiomark.layout, depths: savedTensiomark.depths, value_count: null, layout_status: 'configured', changed: savedTensiomark.changed };
    return msg;
  } catch (error) {
    msg.statusCode = [400,404,409].includes(error.statusCode) ? error.statusCode : 500;
    var tensiomarkCode = String(error && error.code || 'layout_save_failed');
    msg.payload = { message: 'Unable to save Tensiomark layout', code: /^[a-z0-9_]{1,64}$/.test(tensiomarkCode) ? tensiomarkCode : 'layout_save_failed' };
    return msg;
  } finally { await tdb.close(); }
}
// The legacy body path below clears sdi12_channel_layout_json. For Tensiomark
// that would erase the validated layout and quarantine every later reading,
// so a Tensiomark profile is only accepted together with its layout.
if (profileId === 'TENSIOMARK') {
  msg.statusCode = 400; msg.payload = { message: 'Tensiomark configuration requires tensiomark_layout', code: 'tensiomark_layout_required' }; return msg;
}

var hasSensors = Object.prototype.hasOwnProperty.call(body, 'sensors');
var hasAddress = Object.prototype.hasOwnProperty.call(body, 'address');
var hasLegacyDepths = Object.prototype.hasOwnProperty.call(body, 'depths');
var hasLegacyCount = Object.prototype.hasOwnProperty.call(body, 'value_count');
if ((hasSensors || hasAddress) && (hasLegacyDepths || hasLegacyCount)) {
  msg.statusCode = 400; msg.payload = { message: 'sensors/address cannot be combined with depths/value_count' }; return msg;
}
if ((hasSensors || hasAddress) && profileId !== 'SENTEK_ENVIROSCAN') {
  msg.statusCode = 400; msg.payload = { message: 'channel layout is only supported for SENTEK_ENVIROSCAN' }; return msg;
}
var sentekLayout = null;
if (hasSensors || hasAddress) {
  if (!hasSensors || !hasAddress) { msg.statusCode = 400; msg.payload = { message: 'address and sensors are required together' }; return msg; }
  sentekLayout = normRes.value.validateSentekLayout({ version: 1, address: body.address, sensors: body.sensors });
  if (!sentekLayout.ok) { msg.statusCode = 400; msg.payload = { message: 'invalid Sentek layout: ' + sentekLayout.error }; return msg; }
}
var slotDepths = body.depths;
var depthsByChannel = null;
if (slotDepths !== undefined) {
  if (typeof slotDepths !== 'object' || slotDepths === null || Array.isArray(slotDepths)) {
    msg.statusCode = 400; msg.payload = { message: 'depths must be an object of depthSlot->cm' }; return msg;
  }
  var validSlots = {};
  profile.values.forEach(function (v) { if (v.depthSlot) validSlots[v.depthSlot] = true; });
  depthsByChannel = {};
  for (var slot in slotDepths) {
    if (!Object.prototype.hasOwnProperty.call(slotDepths, slot)) continue;
    var cm = slotDepths[slot];
    if (!validSlots[Number(slot)] || !Number.isFinite(cm) || cm < 0 || cm > 500) {
      msg.statusCode = 400; msg.payload = { message: 'invalid depth entry for slot ' + slot }; return msg;
    }
    profile.values.forEach(function (v) { if (v.depthSlot === Number(slot)) depthsByChannel[v.channel] = cm; });
  }
}
var valueCountInput = body.value_count;
if (hasLegacyCount && valueCountInput !== null && (!Number.isInteger(valueCountInput) || valueCountInput < 1 || valueCountInput > 8)) {
  msg.statusCode = 400; msg.payload = { message: 'value_count must be an integer between 1 and 8, or null' }; return msg;
}
var deveui = String(msg.deviceRow.deveui || '').toUpperCase();
return (async () => {
  var db = new osiDb.Database('/data/db/farming.db');
  var transactionStarted = false;
  try {
    if (sentekLayout) {
      var commissioningLoad = osiLib.require('sdi12-commissioning');
      if (!commissioningLoad.ok) {
        node.warn('sdi12 config: commissioning helper unavailable');
        msg.statusCode = 500; msg.payload = { message: 'commissioning helper unavailable' }; return msg;
      }
      try {
        var saved = await commissioningLoad.value.saveSentekLayout(db, {
          deveui: deveui, profileId: profileId, layout: sentekLayout.layout, depths: sentekLayout.depths
        });
        msg.payload = {
          probe_profile: saved.profileId, status: saved.status, layout: saved.layout, depths: saved.depths,
          value_count: saved.valueCount, layout_status: 'configured', deployment_status: 'not_applied',
          message: 'Layout saved; acquisition configuration not applied.'
        };
        return msg;
      } catch (error) {
        var helperStatus = Number(error && (error.statusCode || error.status) || 500) || 500;
        msg.statusCode = [400, 404, 409, 500].indexOf(helperStatus) >= 0 ? helperStatus : 500;
        var helperCode = String(error && error.code || 'layout_save_failed');
        msg.payload = { message: 'Unable to save SDI-12 layout', code: /^[a-z0-9_]{1,64}$/.test(helperCode) ? helperCode : 'layout_save_failed' };
        return msg;
      }
    }
    await db.run('BEGIN IMMEDIATE');
    transactionStarted = true;
    var profileIsFixedShape = profile.expectedValues != null;
    var resolvedValueCount;
    if (profileIsFixedShape) resolvedValueCount = null;
    else if (hasLegacyCount) resolvedValueCount = valueCountInput;
    else {
      var existingCount = await db.get('SELECT sdi12_value_count FROM devices WHERE deveui=?', [deveui]);
      resolvedValueCount = existingCount ? existingCount.sdi12_value_count : null;
    }
    var existingDepths = {};
    if (depthsByChannel === null) {
      var existingDepthRow = await db.get('SELECT soil_moisture_probe_depths_json FROM devices WHERE deveui=?', [deveui]);
      if (existingDepthRow && existingDepthRow.soil_moisture_probe_depths_json) {
        try {
          var parsedDepths = JSON.parse(existingDepthRow.soil_moisture_probe_depths_json);
          if (parsedDepths && typeof parsedDepths === 'object' && !Array.isArray(parsedDepths)) existingDepths = parsedDepths;
        } catch (error) { node.warn('sdi12 config: invalid stored depth map: ' + String(error && error.message ? error.message : error)); }
      }
      depthsByChannel = {};
      profile.values.forEach(function (v) {
        if (Object.prototype.hasOwnProperty.call(existingDepths, v.channel)) depthsByChannel[v.channel] = existingDepths[v.channel];
      });
    }
    await db.run(
      "UPDATE devices SET sdi12_probe_profile=?, sdi12_probe_status='manual', sdi12_channel_layout_json=NULL, " +
      "soil_moisture_probe_depths_json=?, soil_moisture_probe_depths_configured=?, sdi12_value_count=?, " +
      "sync_version=COALESCE(sync_version,0)+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui=?",
      [profileId, JSON.stringify(depthsByChannel), Object.keys(depthsByChannel).length ? 1 : 0, resolvedValueCount, deveui]);
    await db.run('COMMIT');
    transactionStarted = false;
    msg.payload = { probe_profile: profileId, status: 'manual', depths: depthsByChannel, value_count: resolvedValueCount,
      layout_status: profileId === 'SENTEK_ENVIROSCAN' ? 'legacy_count' : null };
    return msg;
  } catch (error) {
    if (transactionStarted) {
      try { await db.run('ROLLBACK'); } catch (rollbackError) { node.warn('sdi12 config rollback failed'); }
    }
    msg.statusCode = 500;
    msg.payload = { message: 'Unable to save SDI-12 config' };
    return msg;
  } finally {
    try { await db.close(); } catch (closeError) { node.warn('sdi12 config DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError)); }
  }
})();
}
module.exports = { handleConfig };
