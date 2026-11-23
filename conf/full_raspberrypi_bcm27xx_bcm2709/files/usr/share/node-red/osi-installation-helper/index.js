'use strict';

const crypto = require('crypto');
const cloudHttp = require('../osi-cloud-http');

function normalizeInstallationUuid(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)
    ? text
    : '';
}

function newInstallationUuid() {
  return crypto.randomUUID();
}

function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}

function mergeGatewayHistory(currentValue, previousValues, nextValue) {
  const current = normalizeGatewayDeviceEui(currentValue);
  const next = normalizeGatewayDeviceEui(nextValue);
  if (!next) throw new Error('current gateway identity is required');
  const history = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(previousValues) ? previousValues : []), current]) {
    const normalized = normalizeGatewayDeviceEui(value);
    if (!normalized || normalized === next || seen.has(normalized)) continue;
    seen.add(normalized);
    history.push(normalized);
  }
  return {
    currentGatewayDeviceEui: next,
    previousGatewayDeviceEuis: history
  };
}

function verifierVersion(capabilities, installationUuid) {
  const supported = Array.isArray(capabilities) &&
    capabilities.some((value) => String(value || '').trim().toLowerCase() === 'installation_recovery_v1');
  return supported && normalizeInstallationUuid(installationUuid) ? 2 : 1;
}

function verifierSubject(password, version, installationUuid, gatewayDeviceEui) {
  const secret = String(password || '');
  if (Number(version) >= 2) {
    const normalizedInstallation = normalizeInstallationUuid(installationUuid);
    if (!normalizedInstallation) throw new Error('installation identity is required for verifier v2');
    return secret + '::' + normalizedInstallation;
  }
  const normalizedGateway = normalizeGatewayDeviceEui(gatewayDeviceEui);
  if (!normalizedGateway) throw new Error('gateway identity is required for verifier v1');
  return secret + '::' + normalizedGateway;
}

function assertMatchingInstallation(localValue, remoteValue) {
  const local = normalizeInstallationUuid(localValue);
  const remote = normalizeInstallationUuid(remoteValue);
  if (!local || !remote || local !== remote) {
    throw new Error('installation identity mismatch');
  }
  return local;
}

function canonicalWritesAllowed(recoveryState) {
  return String(recoveryState || '').trim().toUpperCase() === 'ACTIVE';
}

// The capability list every edge reporter (link request, bootstrap upload,
// force sync) sends the cloud. Conditional capabilities are dropped when the
// module backing them cannot load: conditional_irrigation_v1 (owner decision
// 2026-10-22) and zone_apply_versioned_v1, which needs osi-zone-commands to
// expose the version-checked applyLegacyZoneCommand. Callers pass the osi-lib
// load RESULTS of literal osiLib.require(...) probes, so the caller-name
// audit in verify-helper-registration sees and validates every probe name.
const SYNC_CAPABILITY_BASE = [
  'linked_auth_sync_v1',
  'force_edge_sync_v1',
  'installation_recovery_v1',
  'installation_locations_v1',
  'entity_name_commands_v1',
  'zone_config_weather_source_v1',
  'zone_config_stage_started_on_v1',
  'watermark_v1',
  'chameleon_config_commands_v1',
  'device_soil_depth_commands_v1',
];

function reportedSyncCapabilities(loads) {
  const capabilities = SYNC_CAPABILITY_BASE.concat(['conditional_irrigation_v1', 'zone_apply_versioned_v1']);
  const drop = (name) => { const at = capabilities.indexOf(name); if (at >= 0) capabilities.splice(at, 1); };
  const conditional = loads && loads.conditionalIrrigation;
  if (!conditional || !conditional.ok) drop('conditional_irrigation_v1');
  const zoneCommands = loads && loads.zoneCommands;
  if (!zoneCommands || !zoneCommands.ok || typeof zoneCommands.value.applyLegacyZoneCommand !== 'function') drop('zone_apply_versioned_v1');
  return capabilities;
}

module.exports = {
  normalizeInstallationUuid,
  newInstallationUuid,
  normalizeGatewayDeviceEui,
  mergeGatewayHistory,
  verifierVersion,
  verifierSubject,
  assertMatchingInstallation,
  canonicalWritesAllowed,
  reportedSyncCapabilities
};

// Account-link lifecycle. Request credentials belong to one message; the
// shared flow context retains only non-secret runtime status.
async function accountLink_build({msg, node, flow, env, global, osiDb, osiLib}) {
return (async () => {
const installationLoad = osiLib.require('installation');
if (!installationLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'Installation identity helper is unavailable' };
  return [null, msg];
}
const installation = installationLoad.value;
// F4: linking never depends on the conditional irrigation helper; without it the link takes the
// legacy route, records no attempt (no policy write can race it) and omits the capability.
const replicationLoad = osiLib.require('osi-irrigation-policy');
if (!replicationLoad.ok) node.warn('Account link without conditional irrigation: ' + replicationLoad.error);
const serverUrl = String(flow.get('al_server_url') || '').trim();
const action = flow.get('al_action');
const username = flow.get('al_server_username');
const email = flow.get('al_server_email');
const password = flow.get('al_server_password');
const gatewayDeviceEui = String(flow.get('al_gateway_device_eui') || '').trim().toUpperCase();
const gatewayDeviceEuiConfidence = String(flow.get('al_gateway_device_eui_confidence') || '').trim().toLowerCase();
const localUserId = Number(msg.authUserId || flow.get('al_local_user_id') || 0);
const localUsername = String(msg.authUsername || flow.get('al_local_username') || '').trim();
const edgeBuildVersion = String(env.get('FIRMWARE_VERSION') || env.get('IMAGE_VERSION') || '').trim() || null;
const syncCapabilities = reportedSyncCapabilities({ conditionalIrrigation: replicationLoad, zoneCommands: osiLib.require('zone-commands') });
if (!serverUrl) {
  msg.statusCode = 400;
  msg.payload = { message: 'Server URL is not configured' };
  return [null, msg];
}
if (!gatewayDeviceEui) {
  msg.statusCode = 503;
  msg.payload = { message: 'Gateway identity is not configured yet' };
  return [null, msg];
}
if (gatewayDeviceEuiConfidence === 'provisional') {
  msg.statusCode = 503;
  msg.payload = { message: 'Gateway identity is not ready yet. Wait for ChirpStack gateway detection before linking.' };
  return [null, msg];
}
if (!Number.isFinite(localUserId) || !localUsername) {
  msg.statusCode = 401;
  msg.payload = { message: 'Local user context is missing' };
  return [null, msg];
}
claimAccountOperation(msg);
const db = new osiDb.Database('/data/db/farming.db');
const q = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => {
  if (error) {
    reject(error);
    return;
  }
  resolve(rows || []);
}));
const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
const close = () => new Promise((resolve) => db.close(() => resolve()));
try {
  const configIo = { fs: global.get('fs'), cp: global.get('cp'), warn: text => node.warn(text) };
  const recovery = await recoverAccountConfig(db, configIo);
  if (recovery.recovered && recovery.committed) {
    if (recovery.kind !== 'link' || recovery.username !== localUsername || recovery.serverUrl !== serverUrl || recovery.requestedUsername !== username) {
      throw accountRestartRetryError();
    }
    msg._alRecoveredReply = recovery.reply;
    msg._alRestartPublished = 'link';
    flow.set('account_linked', true);
    flow.set('history_sync_v1_confirmed', false);
    return [null, null, msg];
  }
  assertAccountRestartSettled(configIo);
  preflightAccountConfig(configIo);
  let installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1', []);
  if (installationRows.length === 0) {
    const createdInstallationUuid = installation.newInstallationUuid();
    const createdAt = new Date().toISOString();
    await run(
      "INSERT OR IGNORE INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, ?, '[]', 'ACTIVE', ?, ?)",
      [createdInstallationUuid, gatewayDeviceEui, createdAt, createdAt]
    );
    installationRows = await q('SELECT installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, recovery_operation_uuid FROM installation_identity WHERE singleton_id=1', []);
  }
  if (installationRows.length !== 1) throw new Error('Installation identity is missing');
  const installationUuid = installation.normalizeInstallationUuid(installationRows[0].installation_uuid);
  if (!installationUuid) throw new Error('Installation identity is invalid');
  let previousGatewayDeviceEuis = [];
  try {
    previousGatewayDeviceEuis = JSON.parse(installationRows[0].previous_gateway_device_euis_json || '[]');
  } catch (error) {
    node.warn('Account link installation EUI history is invalid: ' + String(error && error.message ? error.message : error));
    throw new Error('Installation gateway history is invalid');
  }
  const mergedInstallation = installation.mergeGatewayHistory(
    installationRows[0].current_gateway_device_eui,
    previousGatewayDeviceEuis,
    gatewayDeviceEui
  );
  await run(
    'UPDATE installation_identity SET current_gateway_device_eui=?, previous_gateway_device_euis_json=?, updated_at=? WHERE singleton_id=1',
    [mergedInstallation.currentGatewayDeviceEui, JSON.stringify(mergedInstallation.previousGatewayDeviceEuis), new Date().toISOString()]
  );
  flow.set('al_installation_uuid', installationUuid);
  const userRows = await q('SELECT id, user_uuid FROM users WHERE id = ? AND username = ?', [localUserId, localUsername]);
  if (!userRows || userRows.length === 0) {
    msg.statusCode = 404;
    msg.payload = { message: 'Local user not found' };
    return [null, msg];
  }
  const localUserUuid = String((userRows[0] && userRows[0].user_uuid) || '').trim();
  if (!localUserUuid) {
    msg.statusCode = 500;
    msg.payload = { message: 'Local user identity is missing' };
    return [null, msg];
  }
  flow.set('al_local_user_id', Number(userRows[0].id));
  const deviceRows = await q('SELECT deveui FROM devices WHERE user_id = ?', [localUserId]);
  const deviceEuis = deviceRows
    .map((row) => String((row && row.deveui) || '').trim().toUpperCase())
    .filter(Boolean);
  flow.set('al_device_euis', deviceEuis);
  const attempt = !replicationLoad.ok ? { nonce: null, route: 'legacy', request_id: null } : await replicationLoad.value.beginLinkAttempt(db, {
    recover: true,
    context: {
      cloud_user_id: null,
      server_url: serverUrl,
      gateway_device_eui: gatewayDeviceEui,
      installation_uuid: installationUuid,
    },
    now: new Date().toISOString(),
  });
  if (!attempt || (!attempt.nonce && replicationLoad.ok)) throw new Error('Unable to capture the account-link attempt');
  msg._alLinkUnfenced = !replicationLoad.ok;
  msg._alLinkAttemptNonce = attempt.nonce;
  msg._alLinkAttemptRoute = attempt.route;
  msg._alLinkRequestId = attempt.request_id || null;
  msg._alLinkContext = {
    server_url: serverUrl,
    cloud_user_id: attempt.context && attempt.context.cloud_user_id || null,
    gateway_device_eui: gatewayDeviceEui,
    installation_uuid: installationUuid,
  };
  msg.url = serverUrl + (attempt.route === 'conditional'
    ? '/auth/local-sync/conditional-irrigation-v1'
    : '/auth/local-sync');
  msg.method = 'POST';
  msg.headers = { 'Content-Type': 'application/json' };
  msg.payload = { action, username, email, password, gatewayDeviceEui, installationUuid, deviceEuis, localUserUuid, localUsernameSnapshot: localUsername, edgeBuildVersion, syncCapabilities };
  return [msg, null];
} catch (error) {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.payload = { message: 'Unable to read local account state', detail: String(error && error.message || error), reason: error && error.code || null };
  return [null, msg];
} finally {
  try { await close(); } catch (closeError) { node.warn('Account link DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError)); }
}
})();
}
async function accountLink_handle({msg, node, flow, env, global, osiDb, osiLib}) {
return (async () => {
const installationLoad = osiLib.require('installation');
if (!installationLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'Installation identity helper is unavailable' };
  return [null, msg];
}
const installation = installationLoad.value;
const guardedAttempt = String(msg._alLinkAttemptRoute || '').trim() === 'conditional';
const attemptContext = msg._alLinkContext && typeof msg._alLinkContext === 'object'
  ? msg._alLinkContext
  : null;
const attemptNonce = String(msg._alLinkAttemptNonce || '').trim();
if (!attemptContext || (!attemptNonce && msg._alLinkUnfenced !== true)) {
  msg.statusCode = 409;
  msg.payload = { message: 'Account-link response has no durable request context', reason: 'stale_link_attempt' };
  return [null, msg];
}
const statusCode = Number(msg.statusCode || 0);
msg._alLinkRemoteStatus = statusCode;
const data = msg.payload || {};
const remoteCode = String(data.code || '').trim();
const remoteMessage = String(data.message || data.detail || data.error || '').trim();
if (!statusCode || statusCode < 200 || statusCode >= 300) {
  let mappedStatus = 502;
  if (statusCode === 409) {
    mappedStatus = 409;
  } else if (statusCode >= 400 && statusCode < 500) {
    mappedStatus = 400;
  }
  const defaultMessage = mappedStatus === 409 ? 'Server rejected the gateway link request' : 'Server authentication failed';
  msg.statusCode = mappedStatus;
  msg.payload = { message: remoteMessage || defaultMessage, code: remoteCode || null };
  return [null, msg];
}

function decodeJwtExp(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  let value = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const exp = Number(payload.exp || 0);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch (error) {
    node.warn('Account-link token expiry decode failed');
    return null;
  }
}

const verifiedUsername = String(data.username || '').trim();
const syncToken = String(data.token || data.syncToken || data.sync_token || '').trim();
const offlineVerifier = String(data.offlineVerifier || data.offline_verifier || '').trim();
const offlineVerifierVersion = Number(data.offlineVerifierVersion || data.offline_verifier_version || 0);
const rawRemoteInstallationUuid = String(data.installationUuid || data.installation_uuid || '').trim();
const legacyCloudNoInstallationIdentity = !rawRemoteInstallationUuid;
const capturedInstallationUuid = installation.normalizeInstallationUuid(attemptContext.installation_uuid);
const remoteInstallationUuid = installation.normalizeInstallationUuid(rawRemoteInstallationUuid);
if (legacyCloudNoInstallationIdentity) {
  if (guardedAttempt) {
    msg.statusCode = 502;
    msg.payload = { message: 'Guarded server authentication returned no installation identity', reason: 'installation_identity_missing' };
    return [null, msg];
  }
  node.warn('Cloud did not report an installation identity (legacy cloud); skipping installation check');
} else {
  try {
    installation.assertMatchingInstallation(capturedInstallationUuid, remoteInstallationUuid);
  } catch (error) {
    msg.statusCode = 502;
    msg.payload = { message: 'Server authentication returned an installation identity mismatch', reason: 'installation_identity_mismatch' };
    return [null, msg];
  }
}
const syncTokenExpiresAt = Number(data.syncTokenExpiresAt || data.sync_token_expires_at || 0) || decodeJwtExp(syncToken) || null;
const mqttPassword = String(data.mqttPassword || data.mqtt_password || '').trim();
const mqttBrokerUrl = String(data.mqttBrokerUrl || data.mqtt_broker_url || '').trim();
const cloudUserId = Number(data.userId || data.user_id || 0);
const claimed = Array.isArray(data.claimed) ? data.claimed : (Array.isArray(data.claimedDevices) ? data.claimedDevices : []);
const skipped = Array.isArray(data.skipped) ? data.skipped : (Array.isArray(data.skippedDevices) ? data.skippedDevices : []);
const requiredFieldErrors = [];
if (!verifiedUsername) requiredFieldErrors.push('username');
if (!syncToken) requiredFieldErrors.push('sync token');
if (!offlineVerifier) requiredFieldErrors.push('offline verifier');
if (!Number.isFinite(offlineVerifierVersion) || offlineVerifierVersion < 1) requiredFieldErrors.push('offline verifier version');
if (!Number.isFinite(syncTokenExpiresAt) || syncTokenExpiresAt <= 0) requiredFieldErrors.push('sync token expiry');
if (!mqttPassword) requiredFieldErrors.push('MQTT password');
if (!mqttBrokerUrl) requiredFieldErrors.push('MQTT broker URL');
if (!Number.isFinite(cloudUserId) || cloudUserId <= 0) requiredFieldErrors.push('cloud user id');
if (requiredFieldErrors.length > 0) {
  msg.statusCode = 502;
  msg.payload = { message: 'Server authentication response is incomplete: missing ' + requiredFieldErrors.join(', ') };
  return [null, msg];
}
function extractHostFromAbsoluteUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    if (typeof URL === 'function') {
      return new URL(text).host || '';
    }
  } catch (error) { node.warn('Account-link broker URL parse failed'); }
  const match = text.match(new RegExp('^[a-z][a-z0-9+.-]*://([^/?#]+)', 'i'));
  return match ? String(match[1] || '').trim() : '';
}
if (!extractHostFromAbsoluteUrl(mqttBrokerUrl)) {
  msg.statusCode = 502;
  msg.payload = { message: 'Server authentication returned an invalid MQTT broker URL' };
  return [null, msg];
}

const localUsername = String(flow.get('al_local_username') || '').trim();
const serverUrl = String(attemptContext.server_url || '').trim();
if (!localUsername || !serverUrl) {
  msg.statusCode = 500;
  msg.payload = { message: 'Local account-link state is incomplete' };
  return [null, msg];
}
const supportedSyncCapabilities = Array.isArray(data.supportedSyncCapabilities)
  ? data.supportedSyncCapabilities
  : (Array.isArray(data.supported_sync_capabilities) ? data.supported_sync_capabilities :
    (Array.isArray(data.capabilities) ? data.capabilities : []));
const responseContext = {
  server_url: serverUrl,
  cloud_user_id: String(cloudUserId),
  gateway_device_eui: String(attemptContext.gateway_device_eui || '').trim().toUpperCase(),
  installation_uuid: capturedInstallationUuid,
};
const replicationLoad = osiLib.require('osi-irrigation-policy');
const unfenced = msg._alLinkUnfenced === true;
// F4: an unfenced link (no conditional helper) is valid only while the helper is still absent.
if (unfenced === replicationLoad.ok) {
  msg.statusCode = 409;
  msg.payload = { message: 'Account-link response is stale or no longer matches the gateway', reason: 'stale_link_attempt' };
  return [null, msg];
}
if (unfenced) {
  msg._alLinkCapabilities = supportedSyncCapabilities;
  msg._alLinkValidatedContext = responseContext;
}
const validationDb = unfenced ? null : new osiDb.Database('/data/db/farming.db');
try {
  if (!unfenced) {
  const validation = await replicationLoad.value.validateLinkAttempt(validationDb, {
    requestId: msg._alLinkRequestId || undefined,
    nonce: attemptNonce,
    context: responseContext,
    capabilities: supportedSyncCapabilities,
  });
  if (!validation.valid) {
    msg.statusCode = validation.reason === 'conditional_capability_missing' ? 503 : 409;
    msg.payload = {
      message: validation.reason === 'conditional_capability_missing'
        ? 'Server does not support conditional irrigation replication'
        : 'Account-link response is stale or no longer matches the gateway',
      reason: validation.reason,
    };
    return [null, msg];
  }
  msg._alLinkCapabilities = validation.capabilities;
  msg._alLinkValidatedContext = validation.context;
  msg._alLinkRequestId = validation.request_id;
  msg._alLinkAttemptRoute = validation.route;
  }
} catch (error) {
  msg.statusCode = 409;
  msg.payload = { message: 'Unable to validate account-link response', reason: error && error.code || 'stale_link_attempt' };
  return [null, msg];
} finally {
  if (validationDb) try { await validationDb.close(); } catch (closeError) { node.warn('Account-link response validation DB close failed: ' + String(closeError && closeError.message || closeError)); }
}

flow.set('al_token', syncToken);
flow.set('al_server_sync_token', syncToken);
flow.set('al_server_sync_token_expires_at', syncTokenExpiresAt);
flow.set('al_offline_verifier', offlineVerifier);
flow.set('al_offline_verifier_version', offlineVerifierVersion);
if (!legacyCloudNoInstallationIdentity) {
  flow.set('al_installation_uuid', remoteInstallationUuid);
}
// Legacy cloud: persist nothing about the remote installation identity --
// keep whatever local installation uuid was already in flow context.
flow.set('al_password_hash', null);
flow.set('al_verified_server_username', verifiedUsername);
flow.set('al_cloud_user_id', cloudUserId);
flow.set('al_mqtt_password', mqttPassword);
flow.set('al_mqtt_broker_url', mqttBrokerUrl);
flow.set('al_server_password', null);
flow.set('al_claimed', claimed);
flow.set('al_skipped', skipped);
return [msg, null];
})();
}
async function accountLink_finalize({msg, node, flow, env, global, osiDb, osiLib}) {
return (async () => {
const installationLoad = osiLib.require('installation');
if (!installationLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'Installation identity helper is unavailable' };
  return [null, msg];
}
const installation = installationLoad.value;
const replicationLoad = osiLib.require('osi-irrigation-policy');
// F4: a link made without the conditional helper (no attempt) finalizes without it.
const unfenced = msg._alLinkUnfenced === true;
if (unfenced === replicationLoad.ok) {
  msg.statusCode = unfenced ? 409 : 503;
  msg.payload = { message: unfenced ? 'Account-link response is stale or no longer matches the gateway' : 'Conditional irrigation replication helper is unavailable' };
  return [null, msg];
}
const localUsername = String(flow.get('al_local_username') || '').trim();
const verifiedUsername = String(flow.get('al_verified_server_username') || '').trim();
const offlineVerifier = String(flow.get('al_offline_verifier') || '').trim();
const offlineVerifierVersion = Number(flow.get('al_offline_verifier_version') || 0);
const serverUrl = String(flow.get('al_server_url') || '').trim();
const syncToken = String(flow.get('al_server_sync_token') || flow.get('al_token') || '').trim();
const syncTokenExpiresAt = Number(flow.get('al_server_sync_token_expires_at') || 0) || null;
const cloudUserId = Number(flow.get('al_cloud_user_id') || 0);
const installationUuid = installation.normalizeInstallationUuid(flow.get('al_installation_uuid'));
function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}
const gatewayDeviceEui = normalizeGatewayDeviceEui(flow.get('al_gateway_device_eui') || env.get('DEVICE_EUI'));
const attemptNonce = String(msg._alLinkAttemptNonce || '').trim();
const validatedContext = msg._alLinkValidatedContext && typeof msg._alLinkValidatedContext === 'object'
  ? msg._alLinkValidatedContext
  : null;
const capabilities = Array.isArray(msg._alLinkCapabilities) ? msg._alLinkCapabilities : null;
if (!localUsername || !verifiedUsername || !offlineVerifier || !Number.isFinite(offlineVerifierVersion) || offlineVerifierVersion <= 0 || !serverUrl || !syncToken || !Number.isFinite(cloudUserId) || cloudUserId <= 0 || !gatewayDeviceEui || !installationUuid || (!attemptNonce && !unfenced) || !validatedContext || !capabilities) {
  msg.statusCode = 500;
  msg.payload = { message: 'Local linked-account finalization state is incomplete' };
  return [null, msg];
}
// The durable validation result is the authority for the response identity.
// Shared flow keys still provide credentials, but they cannot replace the
// captured server/account/gateway/installation context after validation.
const finalServerUrl = String(validatedContext.server_url || '').trim();
const finalCloudUserId = Number(validatedContext.cloud_user_id || 0);
const finalGatewayDeviceEui = normalizeGatewayDeviceEui(validatedContext.gateway_device_eui);
const finalInstallationUuid = installation.normalizeInstallationUuid(validatedContext.installation_uuid);
if (!finalServerUrl || !Number.isSafeInteger(finalCloudUserId) || finalCloudUserId <= 0 || !finalGatewayDeviceEui || !finalInstallationUuid) {
  msg.statusCode = 409;
  msg.payload = { message: 'Account-link response identity is incomplete', reason: 'stale_peer_context' };
  return [null, msg];
}
const now = new Date().toISOString();
const db = new osiDb.Database('/data/db/farming.db');
const close = () => new Promise((resolve) => db.close(() => resolve()));
try {
  await accountConfigTransaction(db, {
      fs: global.get('fs'), cp: global.get('cp'),
      desired: linkMqttConfig(flow),
      marker: { kind: 'link', username: localUsername, token: syncToken, context: validatedContext, request_username: flow.get('al_server_username'),
        reply: { serverUsername: verifiedUsername, claimedDevices: flow.get('al_claimed') || [], skippedDevices: flow.get('al_skipped') || [] } },
    }, async (tx) => {
    const local = await tx.get('SELECT id FROM users WHERE id=? AND username=?', [Number(flow.get('al_local_user_id')), localUsername]);
    if (!local) throw new Error('Local linked account no longer exists');
    await tx.run(
      'UPDATE users SET server_username = ?, server_offline_verifier = ?, server_offline_verifier_version = ?, server_password_hash = NULL, server_linked_at = ?, auth_mode = ?, server_url = ?, server_sync_token = ?, server_sync_token_expires_at = ?, cloud_user_id = ?, last_auth_sync_at = ?, last_auth_sync_status = ?, last_auth_sync_error = NULL WHERE username = ?',
      [verifiedUsername, offlineVerifier, offlineVerifierVersion, now, 'server', finalServerUrl, syncToken, syncTokenExpiresAt, finalCloudUserId, now, 'up_to_date', localUsername]
    );
    if (unfenced) await tx.run(
      "INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at, installation_uuid) VALUES('cloud', 1, ?, ?, ?, ?, ?) ON CONFLICT(peer_node) DO UPDATE SET linked=1, server_url=excluded.server_url, cloud_user_id=excluded.cloud_user_id, gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at, installation_uuid=excluded.installation_uuid",
      [finalServerUrl, String(finalCloudUserId), finalGatewayDeviceEui, now, finalInstallationUuid]
    );
    const peerResult = unfenced ? { finalized: true } : await replicationLoad.value.finalizePeerContextTx(tx, {
      requestId: msg._alLinkRequestId || undefined,
      nonce: attemptNonce,
      context: {
        server_url: finalServerUrl,
        cloud_user_id: String(finalCloudUserId),
        gateway_device_eui: finalGatewayDeviceEui,
        installation_uuid: finalInstallationUuid,
      },
      capabilities,
      now,
    });
    if (!peerResult.finalized) {
      const peerError = new Error('Account-link finalization rejected the captured response');
      peerError.code = peerResult.reason || 'stale_link_attempt';
      peerError.statusCode = peerResult.reason === 'conditional_capability_missing' ? 503 : 409;
      throw peerError;
    }
    await tx.run(
      "UPDATE devices SET gateway_device_eui = ? WHERE gateway_device_eui IS NULL OR trim(gateway_device_eui) = ''",
      [finalGatewayDeviceEui]
    );
    await tx.run(
      "UPDATE irrigation_zones SET gateway_device_eui = ? WHERE gateway_device_eui IS NULL OR trim(gateway_device_eui) = ''",
      [finalGatewayDeviceEui]
    );
    // Events written while the gateway was unlinked have no canonical key yet.
    // Link finalization supplies the identity and mints the key; the existing
    // AFTER UPDATE trigger then enqueues the durable event.
    await tx.run(
      "UPDATE irrigation_events SET event_uuid = 'irrig-' || ? || '-' || printf('%015d', id) WHERE (event_uuid IS NULL OR event_uuid = '') AND irrigation_zone_id IN (SELECT id FROM irrigation_zones WHERE gateway_device_eui = ?)",
      [finalGatewayDeviceEui, finalGatewayDeviceEui]
    );
  });
  flow.set('account_linked', true);
  flow.set('history_sync_v1_confirmed', false);
  await close();
  return [msg, null];
} catch (error) {
  try { await close(); } catch (closeError) { node.warn('Linked account finalization DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError)); }
  msg.statusCode = Number(error && (error.statusCode || error.status)) || 500;
  msg.payload = { message: 'Unable to complete linked account state', detail: String(error.message || error), reason: error.code || null, applied: error.applied === true };
  return [null, msg];
}
})();
}
async function accountLink_clear({msg, node, flow, env, global, osiDb, osiLib}) {
return (async () => {
const attemptNonce = String(msg._alLinkAttemptNonce || '').trim();
const guardedRemoteFailure = String(msg._alLinkAttemptRoute || '').trim() === 'conditional'
  && [404, 503].includes(Number(msg._alLinkRemoteStatus || msg.statusCode));
if ((attemptNonce || guardedRemoteFailure) && typeof osiDb !== 'undefined' && typeof osiLib !== 'undefined') {
  let db = null;
  try {
    const policyLoad = osiLib.require('osi-irrigation-policy');
    if (policyLoad.ok) {
      db = new osiDb.Database('/data/db/farming.db');
      const now = new Date().toISOString();
      if (guardedRemoteFailure && typeof policyLoad.value.invalidatePeerContext === 'function') {
        await policyLoad.value.invalidatePeerContext(db, {
          attemptNonce,
          requestId: msg._alLinkRequestId == null ? undefined : msg._alLinkRequestId,
          // The nonce alone fences the failed attempt, including an unknown target ID.
          now,
        });
      }
      if (attemptNonce) await policyLoad.value.clearLinkAttempt(db, { nonce: attemptNonce, now });
    }
  } catch (error) {
    node.warn('Account-link attempt cleanup failed: ' + String(error && error.message || error));
  } finally {
    if (db) {
      try { await db.close(); } catch (closeError) { node.warn('Account-link cleanup DB close failed: ' + String(closeError && closeError.message || closeError)); }
    }
  }
}
for (const key of [
  'al_local_username',
  'al_local_user_id',
  'al_server_url',
  'al_action',
  'al_server_username',
  'al_server_email',
  'al_server_password',
  'al_gateway_device_eui',
  'al_gateway_device_eui_source',
  'al_gateway_device_eui_confidence',
  'al_gateway_device_eui_last_verified_at',
  'al_token',
  'al_server_sync_token',
  'al_server_sync_token_expires_at',
  'al_offline_verifier',
  'al_offline_verifier_version',
  'al_password_hash',
  'al_verified_server_username',
  'al_cloud_user_id',
  'al_mqtt_password',
  'al_mqtt_broker_url',
  'al_claimed',
  'al_skipped',
  'al_device_euis',
  'al_installation_uuid'
]) {
  flow.set(key, null);
}
return null;
})();
}
async function accountLink_disconnect({msg, node, flow, env, global, osiDb, osiLib}) {
return (async () => {
const auth = msg._unlinkAuth || {};
if (!Number.isFinite(Number(auth.userId)) || !String(auth.username || '').trim()) {
  msg.statusCode = 401;
  msg.payload = { message: 'Unauthorized' };
  return [null, msg];
}
const db = new osiDb.Database('/data/db/farming.db');
const close = () => db.close();
try {
  claimAccountOperation(msg);
  const recovery = await recoverAccountConfig(db, { fs: global.get('fs'), cp: global.get('cp') });
  if (recovery.recovered && recovery.committed) {
    if (recovery.kind !== 'disconnect' || recovery.username !== auth.username) throw accountRestartRetryError();
    msg._alRestartPublished = 'disconnect';
    flow.set('account_linked', false);
    flow.set('history_sync_v1_confirmed', false);
    await close();
    return [msg, null];
  }
  // Who may unlink: see unlinkPermitted(). With OSI_SCOPED_ACCESS on, the
  // route's admin guard decides through the scope helper. With it off, this
  // check reads the caller's row and the admin count, so no flag-off path
  // needs the scope helper, and it fails closed.
  const scoped = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  const caller = scoped ? null : await db.get(UNLINK_CALLER_SQL, [Number(auth.userId), String(auth.username).trim()]);
  if (!scoped && !unlinkPermitted(caller)) {
    releaseAccountOperation(msg);
    await close();
    msg.statusCode = 403;
    msg.payload = { message: 'Forbidden', code: 'forbidden' };
    return [null, msg];
  }
  await accountConfigTransaction(db, {
    fs: global.get('fs'), cp: global.get('cp'), desired: emptyMqttConfig(),
    marker: { kind: 'disconnect', username: auth.username },
  }, async (tx) => {
  const local = await tx.get('SELECT id FROM users WHERE id=? AND username=?', [Number(auth.userId), auth.username]);
  if (!local) throw new Error('Local account no longer exists');
  // The link belongs to the gateway, not to one local account (#766): the REST
  // sync nodes send for any account row that still holds a cloud address, so
  // every row gives up its link. Each keeps its own local password.
  await tx.run(
    "UPDATE users SET auth_mode = 'local', server_username = NULL, server_password_hash = NULL, server_offline_verifier = NULL, server_offline_verifier_version = 0, server_linked_at = NULL, server_url = NULL, server_sync_token = NULL, server_sync_token_expires_at = NULL, cloud_user_id = NULL, last_auth_sync_at = NULL, last_auth_sync_status = NULL, last_auth_sync_error = NULL WHERE auth_mode <> 'local' OR server_url IS NOT NULL OR server_sync_token IS NOT NULL OR server_username IS NOT NULL OR server_linked_at IS NOT NULL OR cloud_user_id IS NOT NULL OR server_offline_verifier IS NOT NULL",
    []
  );
  await tx.run("UPDATE sync_link_state SET linked=0, server_url=NULL, cloud_user_id=NULL, gateway_device_eui=NULL, peer_capabilities_json=NULL, peer_capabilities_context_json=NULL, peer_capabilities_request_id=NULL, link_attempt_json=NULL, updated_at=? WHERE peer_node='cloud'", [new Date().toISOString()]);
  await tx.run("DELETE FROM sync_history_dirty_keys WHERE peer_node='cloud'", []);
  });
  flow.set('account_linked', false);
  flow.set('history_sync_v1_confirmed', false);
  await close();
  return [msg, null];
} catch (error) {
  try { await close(); } catch (closeError) { node.warn('Unlink DB close failed: ' + String(closeError.message || closeError)); }
  msg.statusCode = error.statusCode || 500;
  msg.payload = { message: String(error.message || error), reason: error.code || null, applied: error.applied === true };
  return [null, msg];
}
})();
}
async function accountLink_success({msg, node, flow, env, global, osiDb, osiLib}) {
if (msg._alRecoveredReply) {
  msg.statusCode = 200;
  msg.payload = { success: true, ...msg._alRecoveredReply, restartRecovered: true };
  return msg;
}
const serverUsername = flow.get('al_verified_server_username');
const claimed = flow.get('al_claimed') || [];
const skipped = flow.get('al_skipped') || [];
msg.statusCode = 200;
msg.payload = {
  success: true,
  serverUsername: serverUsername,
  claimedDevices: claimed,
  skippedDevices: skipped
};
return msg;
}

const ACCOUNT_CONFIG_JOURNAL = '/data/db/osi-account-link-config.json';
const MQTT_KEYS = ['server_host', 'mqtt_password', 'mqtt_broker_url', 'link_gateway_device_eui'];
let activeAccountOperation = null;

function claimAccountOperation(msg) {
  if (activeAccountOperation && activeAccountOperation !== msg._alOperationId) {
    const error = new Error('Gateway account linking or disconnect is in progress');
    error.code = 'link_in_progress'; error.statusCode = 409;
    throw error;
  }
  if (!msg._alOperationId) msg._alOperationId = crypto.randomUUID();
  activeAccountOperation = msg._alOperationId;
}

function releaseAccountOperation(msg) {
  if (msg._alOperationId && activeAccountOperation === msg._alOperationId) activeAccountOperation = null;
}

function requestAccountState(msg, shared) {
  // Compatibility with internal callers that start at the builder. HTTP callers
  // already captured state synchronously in al-link-validate.
  if (!msg._alState) msg._alState = Object.fromEntries(['al_local_username', 'al_local_user_id', 'al_server_url', 'al_action', 'al_server_username', 'al_server_email', 'al_server_password', 'al_gateway_device_eui', 'al_gateway_device_eui_source', 'al_gateway_device_eui_confidence', 'al_gateway_device_eui_last_verified_at', 'al_token', 'al_server_sync_token', 'al_server_sync_token_expires_at', 'al_offline_verifier', 'al_offline_verifier_version', 'al_password_hash', 'al_verified_server_username', 'al_cloud_user_id', 'al_mqtt_password', 'al_mqtt_broker_url', 'al_claimed', 'al_skipped', 'al_device_euis', 'al_installation_uuid'].map(key => [key, shared.get(key)]));
  const state = msg._alState;
  return {
    get(key) {
      if (!key.startsWith('al_')) return shared.get(key);
      return state[key];
    },
    set(key, value) {
      if (key.startsWith('al_')) state[key] = value;
      else shared.set(key, value);
    },
  };
}

function emptyMqttConfig() {
  return Object.fromEntries(MQTT_KEYS.map(key => [key, '']));
}

function linkMqttConfig(state) {
  const mqttPassword = String(state.get('al_mqtt_password') || '').trim();
  const mqttBrokerUrl = String(state.get('al_mqtt_broker_url') || '').trim();
  const gateway = normalizeGatewayDeviceEui(state.get('al_gateway_device_eui'));
  if (!mqttPassword || !gateway) throw new Error('Linked account response is missing MQTT credentials or gateway identity');
  const broker = new URL(mqttBrokerUrl);
  if (!broker.host || !['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(broker.protocol)) throw new Error('Invalid MQTT broker URL');
  return { server_host: broker.host, mqtt_password: mqttPassword, mqtt_broker_url: mqttBrokerUrl, link_gateway_device_eui: gateway };
}

function requireConfigIo({fs, cp}) {
  if (!fs || !cp || typeof cp.execFileSync !== 'function') throw new Error('Account-link configuration persistence is unavailable');
}

function preflightAccountConfig(io) {
  requireConfigIo(io);
  readMqttConfig(io.cp);
  const path = ACCOUNT_CONFIG_JOURNAL + '.' + crypto.randomUUID() + '.probe';
  let fd;
  try {
    fd = io.fs.openSync(path, 'wx', 0o600);
    io.fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) io.fs.closeSync(fd);
    try { io.fs.unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readMqttConfig(cp) {
  const result = {};
  for (const key of MQTT_KEYS) {
    try { result[key] = String(cp.execFileSync('uci', ['-q', 'get', 'osi-server.cloud.' + key], { encoding: 'utf8' })).replace(/\r?\n$/, ''); }
    catch (error) {
      // UCI reports a missing option with status 1. Other errors must abort
      // before the first write; an unreadable backup is never an empty value.
      if (error.status !== 1) throw new Error('Unable to read prior MQTT configuration');
      result[key] = null;
    }
  }
  return result;
}

function writeMqttConfig(cp, config) {
  try {
  for (const key of MQTT_KEYS) {
    try { cp.execFileSync('uci', ['-q', 'revert', 'osi-server.cloud.' + key]); }
    catch (error) { if (error.status !== 1) throw error; }
  }
  for (const key of MQTT_KEYS) {
    const value = config[key];
    if (value == null) {
      try { cp.execFileSync('uci', ['-q', 'delete', 'osi-server.cloud.' + key]); }
      catch (error) { if (error.status !== 1) throw new Error('Unable to clear MQTT configuration'); }
    } else {
      cp.execFileSync('uci', ['set', 'osi-server.cloud.' + key + '=' + String(value)]);
    }
  }
  cp.execFileSync('uci', ['commit', 'osi-server']);
  const stored = readMqttConfig(cp);
  if (MQTT_KEYS.some(key => stored[key] !== config[key])) throw new Error('MQTT configuration readback failed');
  } catch (error) { throw new Error('Unable to persist or verify MQTT configuration'); }
}

function syncAccountDirectory(fs) {
  const fd = fs.openSync('/data/db', 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// The shared DB uses WAL + synchronous=NORMAL. Flush the committed database
// and WAL before deleting the independently durable config recovery receipt.
function syncAccountDatabase(fs) {
  for (const path of ['/data/db/farming.db', '/data/db/farming.db-wal']) {
    if (path.endsWith('-wal') && !fs.existsSync(path)) continue;
    const fd = fs.openSync(path, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

function writeAccountJournal(fs, journal) {
  const temporary = ACCOUNT_CONFIG_JOURNAL + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(journal), { encoding: 'utf8' });
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, ACCOUNT_CONFIG_JOURNAL);
    syncAccountDirectory(fs);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function removeAccountJournal(fs) {
  fs.unlinkSync(ACCOUNT_CONFIG_JOURNAL);
  syncAccountDirectory(fs);
}

async function configCommitMatches(tx, marker) {
  const user = await tx.get('SELECT auth_mode,server_sync_token,cloud_user_id,server_url FROM users WHERE username=?', [marker.username]);
  const peer = await tx.get("SELECT linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid FROM sync_link_state WHERE peer_node='cloud'");
  if (marker.kind === 'disconnect') return user && user.auth_mode === 'local' && (!peer || Number(peer.linked) === 0);
  const context = marker.context || {};
  return user && user.auth_mode === 'server' && user.server_sync_token === marker.token
    && String(user.cloud_user_id) === String(context.cloud_user_id) && user.server_url === context.server_url
    && peer && Number(peer.linked) === 1
    && ['server_url','cloud_user_id','gateway_device_eui','installation_uuid'].every(key => String(peer[key]) === String(context[key]));
}

function accountRestartRetryError(applied = true) {
  const error = new Error('A gateway restart is pending; retry after the restart');
  error.code = 'account_restart_queued'; error.statusCode = 503; error.applied = applied;
  return error;
}

function assertAccountRestartSettled({fs, warn = console.warn}) {
  // Recovery must run first so a matching committed retry can return its saved
  // reply. New operations cannot use credentials from the previous boot.
  if (gatewayWorkBlocked({fs, warn, accountConfig: false})) throw accountRestartRetryError(false);
}

function publishAccountRestart({fs, requestId, kind, warn = console.warn}) {
  const id = String(requestId || '').trim();
  const requestIdBytes = Buffer.from(id, 'utf8');
  if (!id || requestIdBytes.length > 64) throw new Error('Account restart request identity is missing or too long');
  if (!fs) throw new Error('Account restart publication requires the fs global');
  if (!['link', 'disconnect'].includes(kind)) throw new Error('Invalid account restart kind');
  const requestDir = '/var/run/osi-node-red-restart-requests';
  const reason = kind === 'link' ? 'account_link' : 'account_unlink';
  const delaySeconds = kind === 'link' ? 10 : 2;
  const safeRequestId = requestIdBytes.toString('hex');
  const finalPath = requestDir + '/' + reason + '-' + safeRequestId + '.json';
  let tempPath = '';
  try {
    fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
    tempPath = finalPath + '.' + crypto.randomUUID() + '.tmp';
    const request = { reason, delaySeconds, requestedAtEpoch: Math.floor(Date.now() / 1000) };
    fs.writeFileSync(tempPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, finalPath);
  } catch (error) {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); }
      catch (cleanupError) { if (cleanupError.code !== 'ENOENT') warn('Account restart temporary-file cleanup failed'); }
    }
    // Never surface command arguments or private journal contents.
    const pending = new Error('Account change is applied but its daemon restart request could not be published');
    pending.code = 'account_restart_pending'; pending.statusCode = 503; pending.applied = true;
    throw pending;
  }
}

async function recoverAccountConfig(db, io) {
  if (!io.fs) throw new Error('Account-link configuration recovery requires the fs global');
  if (!io.fs.existsSync(ACCOUNT_CONFIG_JOURNAL)) return { recovered: false };
  requireConfigIo(io);
  return db.transaction(async tx => {
    let journal;
    try { journal = JSON.parse(io.fs.readFileSync(ACCOUNT_CONFIG_JOURNAL, 'utf8')); }
    catch (error) { throw new Error('Unable to read the account-link recovery journal'); }
    if (journal.version !== 1 || !journal.marker || !journal.before || !journal.after) throw new Error('Invalid account-link recovery journal');
    const committed = await configCommitMatches(tx, journal.marker);
    if (journal.restart_pending === true && !committed) throw new Error('Account restart recovery context changed; keeping its receipt');
    writeMqttConfig(io.cp, committed ? journal.after : journal.before);
    syncAccountDatabase(io.fs);
    // Only a transaction known to have rolled back in this running process
    // can remove its receipt without a restart. Boot recovery also reloads a
    // restored prior configuration, because its boot snapshot may differ.
    if (committed || !io.rollbackOnly) publishAccountRestart({fs: io.fs, requestId: journal.operation_id || 'recovery', kind: journal.marker.kind, warn: io.warn});
    const user = await tx.get('SELECT server_username FROM users WHERE username=?', [journal.marker.username]);
    const result = { recovered: true, committed, kind: journal.marker.kind,
      username: journal.marker.username, serverUrl: journal.marker.context && journal.marker.context.server_url,
      reply: journal.marker.reply || {serverUsername: user && user.server_username || null, claimedDevices: null, skippedDevices: null} };
    result.requestedUsername = journal.marker.request_username || result.reply.serverUsername;
    removeAccountJournal(io.fs);
    return result;
  });
}

async function accountConfigTransaction(db, options, mutate) {
  requireConfigIo(options);
  const prior = await recoverAccountConfig(db, options);
  if (prior.recovered && prior.committed) throw accountRestartRetryError();
  assertAccountRestartSettled(options);
  let journal = null;
  let committed = false;
  try {
    await db.transaction(async tx => {
      journal = { version: 1, operation_id: crypto.randomUUID(), marker: options.marker,
        before: readMqttConfig(options.cp), after: options.desired };
      writeAccountJournal(options.fs, journal);
      await mutate(tx);
      writeMqttConfig(options.cp, options.desired);
    });
    committed = true;
    syncAccountDatabase(options.fs);
    // This stamp is written only after SQLite is durable. A process dying
    // before the stamp is still recoverable through the original marker.
    journal.restart_pending = true;
    writeAccountJournal(options.fs, journal);
    // Normal finalization leaves the obligation for the downstream publisher.
  } catch (error) {
    if (committed) {
      const pending = new Error('Account change is applied; restart recovery remains pending');
      pending.code = 'account_restart_pending'; pending.statusCode = 503; pending.applied = true;
      throw pending;
    }
    if (journal) {
      try { await recoverAccountConfig(db, {...options, rollbackOnly: true}); }
      catch (recoveryError) {
        const blocked = new Error('Account-link configuration recovery is required; retry the operation');
        blocked.code = 'link_recovery_required'; blocked.statusCode = 503;
        throw blocked;
      }
    }
    throw error;
  }
}

async function accountLink_restart(deps, kind) {
  const {msg, node, global, osiDb} = deps;
  if (msg._alRestartPublished === kind) return [msg, null];
  const db = new osiDb.Database('/data/db/farming.db');
  try {
    const result = await recoverAccountConfig(db, {fs: global.get('fs'), cp: global.get('cp'), warn: text => node.warn(text)});
    if (!result.recovered || !result.committed || result.kind !== kind) throw new Error('Account restart recovery receipt is unavailable');
    msg._alRestartPublished = kind;
    node.status({fill:'green', shape:'dot', text:'scheduled account restart'});
    return [msg, null];
  } catch (error) {
    node.warn('Account restart publication remains pending');
    msg.statusCode = 503;
    msg.payload = {success:false, applied:true, reason:'account_restart_pending', message:'Account change is applied; retry to publish the daemon restart request'};
    return [null, msg];
  } finally { await db.close(); }
}
async function accountLink_restartLink(deps) { return accountLink_restart(deps, 'link'); }
async function accountLink_restartDisconnect(deps) { return accountLink_restart(deps, 'disconnect'); }

async function accountLinkStage(stage, deps) {
  const handlers = { restartLink: accountLink_restartLink, restartDisconnect: accountLink_restartDisconnect, refreshBuild: accountLink_refreshBuild, refreshMark: accountLink_refreshMark, build: accountLink_build, handle: accountLink_handle, finalize: accountLink_finalize,
    disconnect: accountLink_disconnect, clear: accountLink_clear, success: accountLink_success };
  const handler = handlers[stage];
  if (!handler) throw new Error('Unknown account-link stage');
  const scoped = { ...deps, flow: requestAccountState(deps.msg, deps.flow) };
  try {
    if (['handle','finalize'].includes(stage)) {
      if (!deps.msg._alOperationId || activeAccountOperation !== deps.msg._alOperationId) {
        const stale = new Error('Account-link request is no longer active');
        stale.code = 'stale_link_attempt'; stale.statusCode = 409; throw stale;
      }
      if (gatewayWorkBlocked({ fs: deps.global.get('fs'), warn: text => deps.node.warn(text), accountConfig: false })) {
        const blocked = new Error('Gateway identity is being applied');
        blocked.code = 'identity_restart_pending'; blocked.statusCode = 503; throw blocked;
      }
    }
    const result = await handler(scoped);
    if (stage === 'finalize' || stage === 'disconnect' || stage === 'clear' || (Array.isArray(result) && !result[0])) releaseAccountOperation(deps.msg);
    return result;
  } catch (error) {
    releaseAccountOperation(deps.msg);
    deps.node.warn('Account-link stage failed: ' + stage);
    deps.msg.statusCode = Number(error.statusCode) || 500;
    deps.msg.payload = { message: 'Account-link operation failed', reason: error.code || null };
    if (stage === 'clear' || stage.startsWith('refresh')) return null;
    return stage === 'success' ? deps.msg : [null, deps.msg];
  }
}

module.exports.accountLinkStage = accountLinkStage;
module.exports.accountConfigTransaction = accountConfigTransaction;
module.exports.recoverAccountConfig = recoverAccountConfig;

// Both normal finalization and startup use the same receipt/publication rule.
async function recoverAccountConfigOnStart({osiDb, fs, cp, warn}) {
  if (fs && fs.existsSync(ACCOUNT_CONFIG_JOURNAL)) {
    const db = new osiDb.Database('/data/db/farming.db');
    try { await recoverAccountConfig(db, {fs, cp, warn}); }
    catch (error) { warn('Account-link configuration recovery is pending; retry link or disconnect'); }
    finally { await db.close(); }
  }
  await warnLinkWithoutPassword({osiDb, fs, warn});
}

// #766: a process without an MQTT password reports nothing to the cloud. If
// the database still records the cloud peer as linked, say so once at start:
// the account page would show a link that no longer reports. Stale users rows
// left by an older unlink do not trigger this; only the peer record does.
async function warnLinkWithoutPassword({osiDb, fs, warn}) {
  if (cloudHttp.gatewayLinked() || (fs && fs.existsSync(ACCOUNT_CONFIG_JOURNAL))) return;
  let db = null;
  try {
    db = new osiDb.Database('/data/db/farming.db');
    const peer = await db.get("SELECT linked FROM sync_link_state WHERE peer_node='cloud' LIMIT 1", []);
    if (peer && Number(peer.linked) === 1) {
      warn('The database records a cloud link, but no MQTT password is in UCI; cloud reporting stays off until the gateway is linked again');
    }
  } catch (error) {
    warn('Cloud link check at start failed: ' + String(error && error.message ? error.message : error));
  } finally {
    if (db) {
      try { await db.close(); } catch (error) { warn('Cloud link check DB close failed: ' + String(error && error.message ? error.message : error)); }
    }
  }
}
module.exports.publishAccountRestart = publishAccountRestart;
module.exports.recoverAccountConfigOnStart = recoverAccountConfigOnStart;

function gatewayWorkBlocked({fs, warn, accountConfig = true}) {
  try {
    if (!fs) throw new Error('fs global is unavailable');
    // Read in handoff order: publication precedes journal removal, and identityd
    // writes its sentinel before consuming a queued request. Reversing these
    // reads could miss both sides of either transition.
    if (accountConfig && fs.existsSync(ACCOUNT_CONFIG_JOURNAL)) return true;
    let requests;
    try { requests = fs.readdirSync('/var/run/osi-node-red-restart-requests'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; requests = []; }
    if (requests.some(name => /^account_(?:link|unlink)-.+\.json$/.test(name))) return true;
    // Only existence matters. Never adopt the daemon cache's candidate EUI.
    if (fs.existsSync('/var/run/osi-identity-restart.json')) {
      try { JSON.parse(fs.readFileSync('/var/run/osi-identity-restart.json', 'utf8')); }
      catch (error) { warn('Gateway identity restart state is unreadable; blocking identity-sensitive work'); }
      return true;
    }
    return accountConfig && activeAccountOperation !== null;
  } catch (error) {
    warn('Gateway identity or account configuration is unreadable; blocking identity-sensitive work');
    return true;
  }
}
module.exports.gatewayWorkBlocked = gatewayWorkBlocked;

// Token refresh captures the bearer it is replacing. A response may mutate
// only that still-current credential, never a later link on the same server.
async function accountLink_refreshBuild({msg,node,flow,env,global,osiDb}) {
return (async()=>{
if (gatewayWorkBlocked({ fs: global.get('fs'), warn: text => node.warn(text) })) return null;
const _db = new osiDb.Database('/data/db/farming.db');
const q = (sql) => new Promise((res,rej) => _db.all(sql, (e,r) => e?rej(e):res(r||[])));
const close = () => new Promise(res => _db.close(() => res()));
function normalizeCloudServerUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}
// F130 (2026-08-31 outage): decode the token's own 'iat' (no signature check
// needed -- this only gates a local refresh-or-skip decision) so the refresh
// window scales with the token's real lifetime instead of a fixed 24h cutoff.
// A gateway offline across most of a long-lived token's life must still
// refresh well before expiry.
function decodeJwtIatMs(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  let value = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const iat = Number(payload.iat || 0);
    return Number.isFinite(iat) && iat > 0 ? iat * 1000 : null;
  } catch (_) {
    return null;
  }
}
try {
  const rows = await q("SELECT server_url, server_sync_token, server_sync_token_expires_at FROM users WHERE auth_mode = 'server' AND server_url IS NOT NULL AND server_url <> '' ORDER BY server_linked_at DESC, id DESC LIMIT 1");
  if (!rows.length) { await close(); return null; }
  const serverUrl = normalizeCloudServerUrl(rows[0].server_url);
  const syncToken = String(rows[0].server_sync_token || env.get('CLOUD_SYNC_TOKEN') || env.get('SYNC_TOKEN') || '').trim();
  const syncTokenExpiresAt = Number(rows[0].server_sync_token_expires_at || 0) || 0;
  if (!serverUrl || !syncToken) { await close(); return null; }
  const fallbackThresholdMs = 3.5 * 24 * 60 * 60 * 1000;
  if (syncTokenExpiresAt) {
    const iatMs = decodeJwtIatMs(syncToken);
    if (iatMs && syncTokenExpiresAt > iatMs) {
      const lifetimeMs = syncTokenExpiresAt - iatMs;
      const remainingMs = syncTokenExpiresAt - Date.now();
      if (remainingMs > lifetimeMs / 2) { await close(); return null; }
    } else if (syncTokenExpiresAt > (Date.now() + fallbackThresholdMs)) {
      await close();
      return null;
    }
  }
  msg.url = serverUrl + '/auth/refresh-sync';
  msg.method = 'POST';
  msg.headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + syncToken };
  msg.payload = {};
  msg._refreshServerUrl = serverUrl;
  msg._refreshPriorToken = syncToken;
  await close();
  return msg;
} catch (e) {
  try { await close(); } catch (error) { node.warn('Sync token refresh DB close failed'); }
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, { lastError: { at: new Date().toISOString(), source: 'sync-token-refresh', message: String(e.message || e), statusCode: null } }));
  node.warn('Sync token refresh build failed: ' + e.message);
  return null;
}
})();
}
async function accountLink_refreshMark({msg,node,flow,env,global,osiDb}) {
return (async()=>{
function setSyncState(patch) {
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, patch));
}
function decodeJwtExp(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  let value = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const exp = Number(payload.exp || 0);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch (_) {
    return null;
  }
}
if (msg.statusCode && (msg.statusCode < 200 || msg.statusCode >= 300)) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'sync-token-refresh',
      message: 'Sync token refresh failed',
      statusCode: Number(msg.statusCode)
    }
  });
  return null;
}
const token = String((msg.payload || {}).token || (msg.payload || {}).syncToken || '').trim();
if (!token) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'sync-token-refresh',
      message: 'Sync token refresh returned no token',
      statusCode: null
    }
  });
  return null;
}
const expiresAt = Number((msg.payload || {}).syncTokenExpiresAt || 0) || decodeJwtExp(token) || null;
const _db = new osiDb.Database('/data/db/farming.db');
const run = (sql, params) => new Promise((res,rej) => _db.run(sql, params, e => e?rej(e):res()));
const close = () => new Promise(res => _db.close(() => res()));
try {
  if (!msg._refreshPriorToken) { await close(); return null; }
  await run('UPDATE users SET server_sync_token=?, server_sync_token_expires_at=? WHERE auth_mode=? AND server_url=? AND server_sync_token=?',
    [token, expiresAt, 'server', msg._refreshServerUrl || '', msg._refreshPriorToken]);
  const now = new Date().toISOString();
  const currentState = flow.get('sync_state') || {};
  const patch = {
    lastSyncTokenRefreshAt: now,
    updatedAt: now
  };
  if (currentState.lastError && currentState.lastError.source === 'sync-token-refresh') patch.lastError = null;
  setSyncState(patch);
  await close();
  node.log('Sync token refreshed; new expiry ' + (Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : 'unknown'));
  return null;
} catch (e) {
  try { await close(); } catch (error) { node.warn('Sync token refresh DB close failed'); }
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'sync-token-refresh',
      message: String(e.message || e),
      statusCode: null
    }
  });
  node.warn('Sync token refresh store failed: ' + e.message);
  return null;
}
})();
}

// The MQTT connection keeps boot-time credentials until identityd restarts it.
// Stop new cloud publications while an account operation/receipt is unresolved,
// and in a process that started unlinked (#766).
let unlinkedDropReported = false;
function accountCloudMessage({msg, node, global}) {
  if (!cloudHttp.gatewayLinked()) {
    if (!unlinkedDropReported) {
      unlinkedDropReported = true;
      node.warn('No MQTT password in UCI: the gateway is not linked, so cloud MQTT messages are dropped');
    }
    return null;
  }
  return gatewayWorkBlocked({fs: global.get('fs'), warn: text => node.warn(text)}) ? null : msg;
}
module.exports.accountCloudMessage = accountCloudMessage;

// Unlinking stops the whole gateway's cloud reporting, a gateway system
// command (#766). The edge holds no proof of the cloud gateway owner
// (authority contract K1, "Gateway owner"), so an enabled admin may unlink;
// on a gateway with no enabled admin, the enabled, currently linked account
// stands in for the owner, unless it is a viewer. A disabled account never
// may. row: role, disabled_at, auth_mode, server_url, enabled_admins.
function unlinkPermitted(row) {
  if (!row || row.disabled_at) return false;
  if (row.role === 'admin') return true;
  const linked = row.auth_mode === 'server' && String(row.server_url || '').trim() !== '';
  return Number(row.enabled_admins) === 0 && linked && row.role !== 'viewer';
}
const ENABLED_ADMINS_SQL = "(SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL) AS enabled_admins";
// Whether the gateway itself is linked (the cloud peer record), whichever
// account linked it: an admin whose own row is local may still unlink it.
const GATEWAY_LINKED_SQL = "COALESCE((SELECT MAX(linked) FROM sync_link_state WHERE peer_node = 'cloud'), 0) AS gateway_linked";
const UNLINK_CALLER_SQL = 'SELECT role, disabled_at, auth_mode, server_url, ' + ENABLED_ADMINS_SQL +
  ' FROM users WHERE id = ? AND username = ? LIMIT 1';
// The account-link status query (al-status-decode): named columns only, no
// password hash, verifier or token; the verifier is reported as present or not.
const ACCOUNT_LINK_STATUS_SQL = 'SELECT server_username, server_linked_at, server_url, auth_mode, ' +
  "CASE WHEN TRIM(COALESCE(server_offline_verifier, '')) <> '' THEN 1 ELSE 0 END AS has_offline_verifier, " +
  'COALESCE(server_offline_verifier_version, 0) AS server_offline_verifier_version, ' +
  'last_auth_sync_at, last_auth_sync_status, last_auth_sync_error, role, disabled_at, ' +
  ENABLED_ADMINS_SQL + ', ' + GATEWAY_LINKED_SQL + ' FROM users WHERE id = ? AND username = ?';
module.exports.unlinkPermitted = unlinkPermitted;
module.exports.ACCOUNT_LINK_STATUS_SQL = ACCOUNT_LINK_STATUS_SQL;

// GET /api/account-link/status response from the row ACCOUNT_LINK_STATUS_SQL
// selects. canUnlink follows the unlink rule: the route guard's admin check
// with scoped access on, unlinkPermitted() with it off.
function accountLinkStatusResponse({msg, env}) {
  const result = msg.payload;
  if (!Array.isArray(result) || result.length === 0) {
    msg.statusCode = 401;
    msg.payload = { message: 'User not found' };
    return msg;
  }
  const user = result[0];
  const scoped = String((env && env.get('OSI_SCOPED_ACCESS')) || '') === '1';
  const linked = user.auth_mode === 'server';
  const hasOfflineVerifier = Number(user.has_offline_verifier) === 1;
  const offlineVerifierVersion = Number(user.server_offline_verifier_version || 0) || 0;
  const linkedAuthPackageValid = linked && hasOfflineVerifier && offlineVerifierVersion >= 1;
  const linkedAuthRepairRequired = linked && !linkedAuthPackageValid;
  msg.statusCode = 200;
  msg.payload = {
    linked: linked,
    serverUsername: user.server_username || null,
    linkedAt: user.server_linked_at || null,
    serverUrl: user.server_url || null,
    linkedAuthPackageValid: linkedAuthPackageValid,
    linkedAuthRepairRequired: linkedAuthRepairRequired,
    linkedAuthSyncStatus: linkedAuthRepairRequired ? 'repair_required' : (user.last_auth_sync_status || null),
    offlineVerifierVersion: linked ? offlineVerifierVersion : 0,
    lastAuthSyncAt: user.last_auth_sync_at || null,
    lastAuthSyncError: user.last_auth_sync_error || null,
    gatewayLinked: Number(user.gateway_linked) === 1,
    canUnlink: scoped ? (user.role === 'admin' && !user.disabled_at) : unlinkPermitted(user),
  };
  return msg;
}
module.exports.accountLinkStatusResponse = accountLinkStatusResponse;
