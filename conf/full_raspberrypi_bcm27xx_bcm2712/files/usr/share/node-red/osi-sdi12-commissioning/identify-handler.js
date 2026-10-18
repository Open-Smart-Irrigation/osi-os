'use strict';
const {hasTensiomarkLayout}=require('./tensiomark');

function handleIdentifyAction({msg,node,osiDb,osiLib,env,global,crypto}) {
function getAuthSecret() {
  var configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();
  if (configured) return configured;
  var fs = global.get('fs');
  var secretPaths = ['/data/db/osi_auth_token_secret', '/var/lib/node-red/.node-red/osi_auth_token_secret'];
  if (fs) {
    for (var i = 0; i < secretPaths.length; i++) {
      try {
        var existing = String(fs.readFileSync(secretPaths[i], 'utf8') || '').trim();
        if (existing) return existing;
      } catch (error) {
        node.warn('SDI12 identify auth secret read failed: ' + String(error && error.message ? error.message : error));
      }
    }
    var generated = crypto.randomBytes(48).toString('hex');
    for (var j = 0; j < secretPaths.length; j++) {
      try {
        fs.writeFileSync(secretPaths[j], generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('SDI12 identify auth secret write failed: ' + String(error && error.message ? error.message : error));
      }
    }
  }
  var err = new Error('AUTH_TOKEN_SECRET or JWT_SECRET must be configured');
  err.statusCode = 500;
  throw err;
}
function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(input) {
  var value = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return Buffer.from(value, 'base64');
}
function verifyBearer(authHeader) { delete msg._osiAuthFailure;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    var missing = new Error('Unauthorized');
    missing.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: 'sdi12-identify-action-fn' }; throw missing;
  }
  var token = authHeader.substring(7).trim();
  var parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    var invalid = new Error('Invalid token');
    invalid.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'sdi12-identify-action-fn' }; throw invalid;
  }
  var payloadB64 = parts[0];
  var sig = parts[1];
  var expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
  var sigBuf = Buffer.from(sig, 'utf8');
  var expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    var badSignature = new Error('Invalid token');
    badSignature.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'sdi12-identify-action-fn' }; throw badSignature;
  }
  var payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch (error) {
    var badPayload = new Error('Invalid token');
    badPayload.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'sdi12-identify-action-fn' }; throw badPayload;
  }
  var userId = Number(payload.userId);
  var username = String(payload.username || '').trim();
  var exp = Number(payload.exp || 0);
  if (!Number.isFinite(userId) || !username) {
    var incomplete = new Error('Invalid token');
    incomplete.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'sdi12-identify-action-fn' }; throw incomplete;
  }
  if (exp && Date.now() > exp) {
    var expired = new Error('Token expired');
    expired.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: 'sdi12-identify-action-fn' }; throw expired;
  }
  return { userId: userId, username: username };
}
return (async () => {
  var db = null;
  var scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  try {
    var userId = null;
    if (!scopedOn) {
      var auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);
      userId = auth.userId;
    }
    var deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(deveui)) {
      msg.statusCode = 400;
      msg.payload = { message: 'Invalid deveui' };
      return [null, msg];
    }
    db = new osiDb.Database('/data/db/farming.db');
    var row = userId === null
      ? await db.get(
        'SELECT deveui, type_id, chirpstack_app_id, sdi12_channel_layout_json FROM devices WHERE deveui = ? AND deleted_at IS NULL LIMIT 1',
        [deveui])
      : await db.get(
        'SELECT deveui, type_id, chirpstack_app_id, sdi12_channel_layout_json FROM devices WHERE deveui = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1',
        [deveui, userId]);
    if (!row) {
      msg.statusCode = 404;
      msg.payload = { message: 'Device not found' };
      return [null, msg];
    }
    if (String(row.type_id || '') !== 'DRAGINO_SDI12') {
      msg.statusCode = 409;
      msg.payload = { message: 'Device is not a DRAGINO_SDI12 soil node' };
      return [null, msg];
    }
    if (hasTensiomarkLayout(row)) { msg.statusCode=409; msg.payload={message:'Use the saved Tensiomark sensor mapping',code:'tensiomark_layout_configured'}; return [null,msg]; }
    var chirpstackAppId = String(row.chirpstack_app_id || '').trim();
    if (!chirpstackAppId) {
      var fallbackAppId = String(env.get('CHIRPSTACK_APP_SENSORS') || '').trim();
      if (fallbackAppId) {
        await db.run('UPDATE devices SET chirpstack_app_id = ? WHERE deveui = ?', [fallbackAppId, deveui]);
        chirpstackAppId = fallbackAppId;
      }
    }
    var rawLayout = row.sdi12_channel_layout_json == null ? '' : String(row.sdi12_channel_layout_json);
    var identifyPlan;
    if (!rawLayout.trim()) {
      identifyPlan = { stage: 'discovering', command: '?!', discoveredAddress: null, preserveAttempt: false };
    } else {
      var normalizeLoad = osiLib.require('sdi12-normalize');
      if (!normalizeLoad.ok) {
        node.warn('SDI12 identify: normalizer unavailable');
        throw Object.assign(new Error('identify unavailable'), { statusCode: 500 });
      }
      var validated = normalizeLoad.value.validateSentekLayout(rawLayout);
      if (!validated.ok) {
        msg.statusCode = 409; msg.payload = { message: 'Saved SDI-12 layout is malformed' }; return [null, msg];
      }
      identifyPlan = { stage: 'identifying', command: validated.layout.address + 'I!', discoveredAddress: null, preserveAttempt: false };
    }
    msg.deviceRow = {
      deveui: String(row.deveui || '').toUpperCase(),
      chirpstack_app_id: chirpstackAppId
    };
    msg.sdi12Identify = identifyPlan;
    msg._sdi12_identify_http = true;
    return [msg, null];
  } catch (error) {
    var rawStatus = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.statusCode = [400, 401, 403, 404, 409, 500].indexOf(rawStatus) >= 0 ? rawStatus : 500;
    msg.payload = { message: msg.statusCode >= 500 ? 'Unable to start SDI-12 Identify' : String(error && error.message ? error.message : error) };
    return [null, msg];
  } finally {
    if (db) {
      try {
        await db.close();
      } catch (closeError) {
        node.warn('SDI12 identify auth DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
      }
    }
  }
})();
}

function handleIdentifyTrigger({msg,node,osiDb,osiLib,env,global,crypto}) {
var inputRow = msg.deviceRow || {};
var inputDevEui = String(inputRow.deveui || '').trim().toUpperCase();
return (async () => {
  var db = null;
  try {
    if (!/^[0-9A-F]{16}$/.test(inputDevEui)) {
      throw Object.assign(new Error('invalid device identity'), { statusCode: 409 });
    }
    var normalizeLoad = osiLib.require('sdi12-normalize');
    var recipeLoad = osiLib.require('sdi12-recipe');
    if (!normalizeLoad.ok || !recipeLoad.ok) {
      node.error('SDI12 identify trigger: helper unavailable', msg);
      throw Object.assign(new Error('identify unavailable'), { statusCode: 500 });
    }
    db = new osiDb.Database('/data/db/farming.db');
    var stored = await db.get(
      'SELECT type_id, chirpstack_app_id, sdi12_channel_layout_json FROM devices WHERE deveui = ? AND deleted_at IS NULL LIMIT 1',
      [inputDevEui]
    );
    if (!stored || stored.type_id !== 'DRAGINO_SDI12') {
      throw Object.assign(new Error('device is not available for Identify'), { statusCode: 409 });
    }
    if (hasTensiomarkLayout(stored)) throw Object.assign(new Error('Use the saved Tensiomark sensor mapping'),{statusCode:409,code:'tensiomark_layout_configured'});
    var appId = String(stored.chirpstack_app_id || inputRow.chirpstack_app_id || '').trim();
    if (!appId) {
      throw Object.assign(new Error('device is missing ChirpStack registration data; cannot identify'), { statusCode: 409 });
    }
    var plan = msg.sdi12Identify || null;
    var rawLayout = stored.sdi12_channel_layout_json == null ? '' : String(stored.sdi12_channel_layout_json);
    if (!plan) {
      if (!rawLayout.trim()) {
        plan = { stage: 'discovering', command: '?!', discoveredAddress: null, preserveAttempt: false };
      } else {
        var automaticLayout = normalizeLoad.value.validateSentekLayout(rawLayout);
        if (!automaticLayout.ok) {
          throw Object.assign(new Error('Saved SDI-12 layout is malformed'), { statusCode: 409 });
        }
        plan = { stage: 'identifying', command: automaticLayout.layout.address + 'I!', discoveredAddress: null, preserveAttempt: false };
      }
    }
    var discoveredAddress = plan.discoveredAddress == null ? null : String(plan.discoveredAddress);
    if ((plan.stage !== 'discovering' && plan.stage !== 'identifying')
      || (plan.stage === 'discovering' && (plan.command !== '?!' || discoveredAddress !== null))
      || (plan.stage === 'identifying' && !/^[0-9A-Za-z]I!$/.test(String(plan.command || '')))
      || (discoveredAddress !== null && !/^[0-9A-Za-z]$/.test(discoveredAddress))) {
      throw Object.assign(new Error('invalid Identify plan'), { statusCode: 409 });
    }
    if (plan.stage === 'discovering' && rawLayout.trim()) {
      throw Object.assign(new Error('saved layout changed before discovery'), { statusCode: 409 });
    }
    if (plan.stage === 'identifying' && discoveredAddress === null) {
      var currentLayout = normalizeLoad.value.validateSentekLayout(rawLayout);
      if (!currentLayout.ok || plan.command !== currentLayout.layout.address + 'I!') {
        throw Object.assign(new Error('saved layout changed before Identify'), { statusCode: 409 });
      }
    }
    if (plan.preserveAttempt) {
      var attempt = await db.get(
        'SELECT stage, discovered_address FROM sdi12_identify_attempts WHERE deveui = ?',
        [inputDevEui]
      );
      if (!attempt || attempt.stage !== 'identifying' || attempt.discovered_address !== discoveredAddress) {
        throw Object.assign(new Error('Identify attempt changed before downlink'), { statusCode: 409 });
      }
    }
    var rawBytes;
    try {
      rawBytes = recipeLoad.value.encodeIdentifyFrame(String(plan.command || ''));
    } catch (error) {
      throw Object.assign(new Error('invalid Identify command'), { statusCode: 409 });
    }
    var now = new Date().toISOString();
    await db.transaction(async function(tx) {
      var currentDevice = await tx.get('SELECT sdi12_channel_layout_json FROM devices WHERE deveui=?',[inputDevEui]);
      if (hasTensiomarkLayout(currentDevice)) throw Object.assign(new Error('Use the saved Tensiomark sensor mapping'),{statusCode:409,code:'tensiomark_layout_configured'});
      if (!plan.preserveAttempt) {
        await tx.run(
          'INSERT INTO sdi12_identify_attempts (deveui, stage, discovered_address, requested_at, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?) ON CONFLICT(deveui) DO UPDATE SET stage = excluded.stage, ' +
            'discovered_address = excluded.discovered_address, requested_at = excluded.requested_at, updated_at = excluded.updated_at',
          [inputDevEui, plan.stage, discoveredAddress, now, now]
        );
      }
      await tx.run(
        'UPDATE devices SET sdi12_probe_status = ?, updated_at = ? WHERE deveui = ?',
        ['pending_identify', now, inputDevEui]
      );
    });
    msg.sdi12Identify = plan;
    msg.downlink = {
      topic: 'application/' + appId + '/device/' + inputDevEui.toLowerCase() + '/command/down',
      payload: {
        devEui: inputDevEui.toLowerCase(), confirmed: false, fPort: 2, data: rawBytes.toString('base64')
      }
    };
    return [msg, null];
  } catch (error) {
    var rawStatus = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.statusCode = [400, 404, 409, 500].indexOf(rawStatus) >= 0 ? rawStatus : 500;
    msg.payload = { message: msg.statusCode >= 500 ? 'Unable to enqueue SDI-12 Identify' : String(error && error.message ? error.message : error) };
    if (error.code === 'tensiomark_layout_configured') msg.payload.code=error.code;
    return [null, msg];
  } finally {
    if (db) {
      try { await db.close(); } catch (closeError) { node.warn('SDI12 identify trigger DB close failed'); }
    }
  }
})();
}

function handleIdentifyReply({msg,node,osiDb,osiLib,env,global,crypto}) {
var info = msg.sdi12;
if (!info) return [null, null];
var normalizeLoad = osiLib.require('sdi12-normalize');
if (!normalizeLoad.ok) { node.error('SDI12 identify response: normalizer unavailable', msg); return [null, null]; }
var response = String((info.decoded && info.decoded.datas_sum) || '').trim();
return (async () => {
  var db = new osiDb.Database('/data/db/farming.db');
  try {
    var row = await db.get(
      'SELECT ia.stage, ia.discovered_address, d.chirpstack_app_id, d.sdi12_channel_layout_json ' +
        'FROM sdi12_identify_attempts ia INNER JOIN devices d ON d.deveui = ia.deveui WHERE ia.deveui = ?',
      [String(info.deveui || '').trim().toUpperCase()]
    );
    if (!row) {
      node.warn('sdi12 identify: response without a current attempt');
      return [msg, null];
    }
    if (hasTensiomarkLayout(row)) {
      await db.run('DELETE FROM sdi12_identify_attempts WHERE deveui=?',[String(info.deveui).trim().toUpperCase()]);
      return [msg,null];
    }
    var observedAt = new Date(info.recordedAt || Date.now()).toISOString();
    var deveui = String(info.deveui || '').trim().toUpperCase();
    if (row.stage === 'discovering') {
      if (!/^[0-9A-Za-z]$/.test(response)) {
        node.warn('sdi12 discovery: expected exactly one address for ' + deveui);
        node.status({ fill: 'yellow', shape: 'ring', text: deveui + ' discovery rejected' });
        return [msg, null];
      }
      var advanced = await db.transaction(async function(tx) {
        var current = await tx.get(
          'SELECT ia.stage, d.sdi12_channel_layout_json FROM sdi12_identify_attempts ia ' +
            'INNER JOIN devices d ON d.deveui = ia.deveui WHERE ia.deveui = ?',
          [deveui]
        );
        if (!current || current.stage !== 'discovering' || (current.sdi12_channel_layout_json != null && String(current.sdi12_channel_layout_json).trim())) return false;
        await tx.run(
          'UPDATE sdi12_identify_attempts SET stage = ?, discovered_address = ?, updated_at = ? WHERE deveui = ? AND stage = ?',
          ['identifying', response, observedAt, deveui, 'discovering']
        );
        var changed = await tx.get('SELECT changes() AS count', []);
        return Number(changed && changed.count || 0) === 1;
      });
      if (!advanced) {
        node.warn('sdi12 discovery: attempt changed before address persistence for ' + deveui);
        return [msg, null];
      }
      msg.deviceRow = { deveui: deveui, chirpstack_app_id: String(row.chirpstack_app_id || '').trim() };
      msg.sdi12Identify = {
        stage: 'identifying', command: response + 'I!', discoveredAddress: response, preserveAttempt: true
      };
      node.status({ fill: 'blue', shape: 'dot', text: deveui + ' address ' + response });
      return [null, msg];
    }
    var hit = normalizeLoad.value.matchProfile(response);
    await db.transaction(async function(tx) {
      var currentDevice = await tx.get('SELECT sdi12_channel_layout_json FROM devices WHERE deveui=?',[deveui]);
      if (hasTensiomarkLayout(currentDevice)) { await tx.run('DELETE FROM sdi12_identify_attempts WHERE deveui=?',[deveui]); return; }
      if (hit) {
        await tx.run(
          'UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = ?, sdi12_identity = ?, ' +
            'sync_version = COALESCE(sync_version, ?) + ?, updated_at = ? WHERE deveui = ? AND sdi12_probe_status = ?',
          [hit.profileId, 'identified', response, 0, 1, observedAt, deveui, 'pending_identify']
        );
      } else {
        await tx.run(
          'UPDATE devices SET sdi12_probe_status = ?, sdi12_identity = ?, updated_at = ? ' +
            'WHERE deveui = ? AND sdi12_probe_status = ?',
          ['unmatched', response, observedAt, deveui, 'pending_identify']
        );
      }
      await tx.run('UPDATE sdi12_identify_attempts SET updated_at = ? WHERE deveui = ? AND stage = ?', [observedAt, deveui, 'identifying']);
    });
    if (hit) {
      node.status({ fill: 'green', shape: 'dot', text: deveui + ' -> ' + hit.profileId });
    } else {
      node.warn('sdi12 identify: no profile match for ' + deveui);
      node.status({ fill: 'yellow', shape: 'dot', text: deveui + ' unmatched' });
    }
    return [msg, null];
  } catch (error) {
    node.error('SDI12 identify response failed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try { await db.close(); } catch (closeError) { node.warn('SDI12 identify response DB close failed'); }
  }
})();
}
module.exports={handleIdentifyAction,handleIdentifyTrigger,handleIdentifyReply};
