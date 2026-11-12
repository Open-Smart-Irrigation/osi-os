'use strict';

const crypto = require('crypto');

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


function requestAlLinkHandleAuth(input) {
// Preserve Node-RED 3.1.15's guarded URL fallback after extracting this code.
const URL = undefined;
const { msg, node, env, osiDb, osiLib } = input;
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
  } catch (_) {
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
  } catch (error) { node.warn('al-link-handle-auth: ' + String(error && error.message ? error.message : error)); }
  const match = text.match(new RegExp('^[a-z][a-z0-9+.-]*://([^/?#]+)', 'i'));
  return match ? String(match[1] || '').trim() : '';
}
if (!extractHostFromAbsoluteUrl(mqttBrokerUrl)) {
  msg.statusCode = 502;
  msg.payload = { message: 'Server authentication returned an invalid MQTT broker URL' };
  return [null, msg];
}

const localUsername = String(msg.link.local_username || '').trim();
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

msg.link.token = (syncToken);
msg.link.server_sync_token = (syncToken);
msg.link.server_sync_token_expires_at = (syncTokenExpiresAt);
msg.link.offline_verifier = (offlineVerifier);
msg.link.offline_verifier_version = (offlineVerifierVersion);
if (!legacyCloudNoInstallationIdentity) {
  msg.link.installation_uuid = (remoteInstallationUuid);
}
// Legacy cloud: persist nothing about the remote installation identity --
// keep the local installation UUID captured on this request.
msg.link.password_hash = (null);
msg.link.verified_server_username = (verifiedUsername);
msg.link.cloud_user_id = (cloudUserId);
msg.link.mqtt_password = (mqttPassword);
msg.link.mqtt_broker_url = (mqttBrokerUrl);
msg.link.server_password = (null);
msg.link.claimed = (claimed);
msg.link.skipped = (skipped);
return [msg, null];
})();
}

function requestAlLinkStoreMqtt(input) {
// Preserve Node-RED 3.1.15's guarded URL fallback after extracting this code.
const URL = undefined;
const { msg, node, global } = input;
const cp = global.get('cp');
if (!cp || typeof cp.execFileSync !== 'function') {
  msg.statusCode = 500;
  msg.payload = { message: 'child_process unavailable for MQTT config persistence' };
  return [null, msg];
}
const mqttPassword = String(msg.link.mqtt_password || '').trim();
if (!mqttPassword) {
  msg.statusCode = 502;
  msg.payload = { message: 'Linked account response is missing MQTT credentials' };
  return [null, msg];
}
const mqttBrokerUrl = String(msg.link.mqtt_broker_url || '').trim();
const serverUrl = String(msg.link.server_url || '').trim();
const linkGatewayDeviceEui = String(msg.link.gateway_device_eui || '').trim().toUpperCase();
function hostFromUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    if (typeof URL === 'function') {
      return new URL(text).host || '';
    }
  } catch (error) { node.warn('al-link-store-mqtt: ' + String(error && error.message ? error.message : error)); }
  const match = text.match(new RegExp('^[a-z][a-z0-9+.-]*://([^/?#]+)', 'i'));
  return match ? String(match[1] || '').trim() : '';
}
function shellQuote(value) {
  return "'" + String(value || '').replace(/'/g, "'\\''") + "'";
}
function readConfigValue(key) {
  try {
    return String(cp.execFileSync('/bin/sh', ['-lc', 'uci -q get ' + key + ' 2>/dev/null || true'], { encoding: 'utf8' }) || '').trim();
  } catch (_) {
    return '';
  }
}
function runBatch(lines) {
  const script = [
    "uci -q batch <<'EOF'",
    ...lines,
    'commit osi-server',
    'EOF'
  ].join('\n');
  cp.execFileSync('/bin/sh', ['-lc', script], { encoding: 'utf8' });
}
const serverHost = hostFromUrl(mqttBrokerUrl) || hostFromUrl(serverUrl);
if (!serverHost) {
  msg.statusCode = 502;
  msg.payload = { message: 'Linked account response is missing a usable MQTT/server host' };
  return [null, msg];
}
if (!linkGatewayDeviceEui) {
  msg.statusCode = 500;
  msg.payload = { message: 'Local gateway identity is missing during account-link finalization' };
  return [null, msg];
}
msg._mqttConfigBackup = {
  serverHost: readConfigValue('osi-server.cloud.server_host'),
  mqttPassword: readConfigValue('osi-server.cloud.mqtt_password'),
  mqttBrokerUrl: readConfigValue('osi-server.cloud.mqtt_broker_url'),
  linkGatewayDeviceEui: readConfigValue('osi-server.cloud.link_gateway_device_eui')
};
try {
  runBatch([
    'set osi-server.cloud.server_host=' + shellQuote(serverHost),
    'set osi-server.cloud.mqtt_password=' + shellQuote(mqttPassword),
    'set osi-server.cloud.mqtt_broker_url=' + shellQuote(mqttBrokerUrl),
    'set osi-server.cloud.link_gateway_device_eui=' + shellQuote(linkGatewayDeviceEui)
  ]);
  node.status({ fill: 'green', shape: 'dot', text: 'stored MQTT credentials' });
  return [msg, null];
} catch (error) {
  msg.statusCode = 500;
  msg.payload = { message: 'Unable to persist MQTT broker config', detail: String(error.message || error) };
  return [null, msg];
}
}

module.exports = { requestAlLinkHandleAuth, requestAlLinkStoreMqtt,
  normalizeInstallationUuid,
  newInstallationUuid,
  normalizeGatewayDeviceEui,
  mergeGatewayHistory,
  verifierVersion,
  verifierSubject,
  assertMatchingInstallation,
  canonicalWritesAllowed
};
