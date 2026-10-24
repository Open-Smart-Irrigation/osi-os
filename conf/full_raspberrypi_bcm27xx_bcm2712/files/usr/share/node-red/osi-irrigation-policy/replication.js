'use strict';

// Conditional-irrigation replication is intentionally a small service layer.
// It owns durable peer context, projection persistence and the source-trigger
// compatibility boundary.  Flow nodes call these functions before/after their
// network work; this module never performs network I/O or holds a transaction
// across a request.

const crypto = require('node:crypto');
const canonical = require('../osi-journal-replication/canonicalization');
const valveStore = require('../osi-valve-control/store');

const CONDITIONAL_CAPABILITY = 'conditional_irrigation_v1';
const FRESHNESS_MS = 5 * 60 * 1000;
const TRUSTED_VALIDITY_MS = 7 * 60 * 1000;
const CONTEXT_KEYS = ['server_url', 'cloud_user_id', 'gateway_device_eui', 'installation_uuid'];
const PROJECTION_KINDS = new Set(['POLICY_RUNTIME', 'VALVE_RUNTIME', 'DECISION']);
const EVENT_TYPES = {
  POLICY_RUNTIME: 'IRRIGATION_POLICY_RUNTIME',
  VALVE_RUNTIME: 'IRRIGATION_POLICY_VALVE_RUNTIME',
  DECISION: 'IRRIGATION_POLICY_DECISION',
};
const EVENT_OPS = {
  POLICY_RUNTIME: 'IRRIGATION_POLICY_RUNTIME_CHANGED',
  VALVE_RUNTIME: 'IRRIGATION_POLICY_VALVE_RUNTIME_CHANGED',
  DECISION: 'IRRIGATION_POLICY_DECISION_UPSERTED',
};

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function stringValue(value) {
  return value == null ? null : String(value);
}

function canonicalEui(value) {
  const eui = stringValue(value);
  return eui && /^[0-9a-f]{16}$/i.test(eui) ? eui.toUpperCase() : eui;
}

function normalizeContext(value, fallback = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const result = {
    server_url: stringValue(input.server_url !== undefined ? input.server_url : (input.serverUrl !== undefined ? input.serverUrl : base.server_url)),
    cloud_user_id: stringValue(input.cloud_user_id !== undefined ? input.cloud_user_id : (input.cloudUserId !== undefined ? input.cloudUserId : base.cloud_user_id)),
    gateway_device_eui: canonicalEui(input.gateway_device_eui !== undefined ? input.gateway_device_eui : (input.gatewayDeviceEui !== undefined ? input.gatewayDeviceEui : base.gateway_device_eui)),
    installation_uuid: stringValue(input.installation_uuid !== undefined ? input.installation_uuid : (input.installationUuid !== undefined ? input.installationUuid : base.installation_uuid)),
  };
  return result;
}

function contextComplete(context) {
  return CONTEXT_KEYS.every((key) => typeof context[key] === 'string' && context[key].trim() !== '');
}

function sameContext(left, right) {
  if (!left || !right) return false;
  return CONTEXT_KEYS.every((key) => String(left[key] == null ? '' : left[key]) === String(right[key] == null ? '' : right[key]));
}

function processTimezone(value) {
  const candidate = value === undefined
    ? (Intl.DateTimeFormat().resolvedOptions().timeZone || null)
    : value;
  if (typeof candidate !== 'string' || !candidate || candidate.length > 64) return null;
  try {
    // Construction validates IANA names in the Node runtime.  Do not derive
    // this value from a browser, gateway setting, or policy timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
    return candidate;
  } catch (_) {
    return null;
  }
}

function instant(value, fallback = Date.now()) {
  const raw = value === undefined ? fallback : value;
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(ms)) throw new TypeError('replication timestamp is invalid');
  return new Date(ms).toISOString();
}

function clockValue(value) {
  const input = value && typeof value === 'object' ? value : {};
  return { trusted: input.trusted === true, reason: input.reason == null ? null : String(input.reason) };
}

async function readClock(options = {}) {
  let value = options.clockStatus;
  if (typeof value === 'function') value = await value(options);
  if (value === undefined && typeof options.clockProbe === 'function') value = await options.clockProbe(options);
  // Publication callers must provide the trusted runtime probe.  Failing
  // closed here keeps an absent marker from becoming fresh cloud state.
  return clockValue(value === undefined ? { trusted: false, reason: 'clock_untrusted' } : value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortedStrings(value) {
  return [...new Set(asArray(value).map(String))].sort();
}

function stableJson(value) {
  return canonical.canonicalize(value);
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function semanticPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...value };
  delete copy.projection_revision;
  delete copy.as_of;
  delete copy.valid_until;
  return copy;
}

function semanticallyEqual(left, right) {
  return stableJson(semanticPayload(left)) === stableJson(semanticPayload(right));
}

function dueForRefresh(previousPayload, asOf) {
  if (!previousPayload || !previousPayload.as_of) return true;
  const previous = Date.parse(previousPayload.as_of);
  const current = Date.parse(asOf);
  return !Number.isFinite(previous) || !Number.isFinite(current) || current - previous >= FRESHNESS_MS;
}

function rowPayload(row) {
  return row ? parseJson(row.payload_json, null) : null;
}

async function peerRowTx(tx, peerNode = 'cloud') {
  return tx.get(`
    SELECT s.*, i.installation_uuid AS identity_installation_uuid,
           i.current_gateway_device_eui AS identity_gateway_device_eui
      FROM sync_link_state s
      LEFT JOIN installation_identity i ON i.singleton_id=1
     WHERE s.peer_node=?
  `, [peerNode]);
}

function supportFromRow(row) {
  if (!row || Number(row.linked) !== 1) return false;
  const capabilities = parseJson(row.peer_capabilities_json, null);
  const context = parseJson(row.peer_capabilities_context_json, null);
  const current = normalizeContext({
    server_url: row.server_url,
    cloud_user_id: row.cloud_user_id,
    gateway_device_eui: row.gateway_device_eui,
    installation_uuid: row.installation_uuid,
  });
  const identityInstallation = stringValue(row.identity_installation_uuid);
  const identityGateway = canonicalEui(row.identity_gateway_device_eui);
  return contextComplete(current)
    && sameContext(current, normalizeContext(context))
    && identityInstallation != null && identityInstallation.trim() !== ''
    && identityGateway != null && identityGateway.trim() !== ''
    && current.installation_uuid === identityInstallation
    && current.gateway_device_eui === identityGateway
    && typeof row.peer_capabilities_request_id === 'string'
    && row.peer_capabilities_request_id.trim() !== ''
    && Array.isArray(capabilities)
    && capabilities.some((item) => item === CONDITIONAL_CAPABILITY);
}

async function readPeerContext(db, options = {}) {
  const row = await db.get(`
    SELECT s.*, i.installation_uuid AS identity_installation_uuid,
           i.current_gateway_device_eui AS identity_gateway_device_eui
      FROM sync_link_state s
      LEFT JOIN installation_identity i ON i.singleton_id=1
     WHERE s.peer_node=?
  `, [options.peerNode || 'cloud']);
  const current = normalizeContext({
    server_url: row && row.server_url,
    cloud_user_id: row && row.cloud_user_id,
    gateway_device_eui: row && row.gateway_device_eui,
    installation_uuid: row && row.installation_uuid,
  });
  const capabilities = parseJson(row && row.peer_capabilities_json, null);
  const captured = parseJson(row && row.peer_capabilities_context_json, null);
  return {
    row,
    linked: Boolean(row && Number(row.linked) === 1),
    context: current,
    peer_context: captured && typeof captured === 'object' && !Array.isArray(captured) ? normalizeContext(captured) : null,
    capabilities: Array.isArray(capabilities) ? capabilities : null,
    request_id: row && row.peer_capabilities_request_id || null,
    installation_uuid: row && row.identity_installation_uuid || null,
    gateway_device_eui: row && row.identity_gateway_device_eui || null,
    supported: supportFromRow(row),
  };
}

async function peerSupportsConditional(db, options = {}) {
  const state = await readPeerContext(db, options);
  if (!state.supported) return false;
  if (options.requestId != null && String(options.requestId) !== String(state.request_id)) return false;
  if (options.context && !sameContext(state.context, normalizeContext(options.context))) return false;
  return true;
}

function rowContext(row) {
  return normalizeContext({
    server_url: row && row.server_url,
    cloud_user_id: row && row.cloud_user_id,
    gateway_device_eui: row && row.gateway_device_eui,
    installation_uuid: row && row.installation_uuid,
  });
}

function identityContext(row) {
  return normalizeContext({
    gateway_device_eui: row && row.identity_gateway_device_eui,
    installation_uuid: row && row.identity_installation_uuid,
  });
}

function identityMatches(row, context) {
  const identity = identityContext(row);
  return context && identity.gateway_device_eui === context.gateway_device_eui
    && identity.installation_uuid === context.installation_uuid;
}

function responseCapabilities(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value.supportedSyncCapabilities || value.supported_sync_capabilities || value.capabilities)
    : value;
  return Array.isArray(input) ? sortedStrings(input) : null;
}

/**
 * Capture an authenticated background request without using the account-link
 * attempt fence. The existing peer context/request columns are the single
 * durable store: a newer capture replaces the nonce, while support for the
 * same context remains usable until the response is accepted or invalidated.
 */
async function beginPeerRequest(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  const peerNode = input.peerNode || 'cloud';
  return db.transaction(async (tx) => {
    const row = await peerRowTx(tx, peerNode);
    if (!row || Number(row.linked) !== 1) return { captured: false, reason: 'peer_unlinked' };
    const current = rowContext(row);
    const captured = normalizeContext(input.context, current);
    if (!contextComplete(current) || !sameContext(current, captured)) {
      return { captured: false, reason: 'stale_peer_context' };
    }
    const requestId = String(input.requestId || input.nonce || crypto.randomUUID());
    const priorCapabilities = parseJson(row.peer_capabilities_json, null);
    const priorContext = parseJson(row.peer_capabilities_context_json, null);
    const preserveSupport = Array.isArray(priorCapabilities)
      && sameContext(current, normalizeContext(priorContext, {}))
      && identityMatches(row, current);
    await tx.run(`
      UPDATE sync_link_state
         SET peer_capabilities_json=CASE WHEN ? THEN peer_capabilities_json ELSE NULL END,
             peer_capabilities_context_json=?, peer_capabilities_request_id=?, updated_at=?
       WHERE peer_node=?
    `, [preserveSupport ? 1 : 0, JSON.stringify(current), requestId, instant(input.now), peerNode]);
    return { captured: true, request_id: requestId, nonce: requestId, context: current };
  });
}

async function acceptPeerCapabilities(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  const peerNode = input.peerNode || 'cloud';
  return db.transaction(async (tx) => {
    const row = await peerRowTx(tx, peerNode);
    const requestId = input.requestId == null ? input.nonce : input.requestId;
    const captured = parseJson(row && row.peer_capabilities_context_json, null);
    const current = rowContext(row);
    const expected = normalizeContext(captured, {});
    if (!row || Number(row.linked) !== 1 || requestId == null
        || String(requestId) !== String(row.peer_capabilities_request_id || '')
        || !contextComplete(current) || !contextComplete(expected)
        || !sameContext(current, expected)
        || !identityMatches(row, expected)
        || (input.context && !sameContext(current, normalizeContext(input.context)))) {
      return { accepted: false, reason: 'stale_peer_request' };
    }
    const capabilities = responseCapabilities(input.capabilities !== undefined
      ? input.capabilities
      : input.response);
    if (!capabilities) {
      // A matching response with no capability list is an explicit
      // unsupported result. Clear prior support without touching a link
      // attempt or the basic linked state.
      await tx.run(`
        UPDATE sync_link_state
           SET peer_capabilities_json='[]', updated_at=?
         WHERE peer_node=? AND peer_capabilities_request_id=?
      `, [instant(input.now), peerNode, String(requestId)]);
      return { accepted: true, supported: false, capabilities: [] };
    }
    await tx.run(`
      UPDATE sync_link_state
         SET peer_capabilities_json=?, peer_capabilities_context_json=?,
             peer_capabilities_request_id=?, updated_at=?
       WHERE peer_node=? AND peer_capabilities_request_id=?
    `, [JSON.stringify(capabilities), JSON.stringify(current), String(requestId), instant(input.now), peerNode, String(requestId)]);
    return { accepted: true, supported: capabilities.includes(CONDITIONAL_CAPABILITY), capabilities, context: current, request_id: String(requestId) };
  });
}

async function invalidatePeerRequest(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  const peerNode = input.peerNode || 'cloud';
  return db.transaction(async (tx) => {
    const row = await peerRowTx(tx, peerNode);
    const requestId = input.requestId == null ? input.nonce : input.requestId;
    if (!row) return { invalidated: false, reason: 'peer_missing' };
    if (requestId == null || String(requestId) !== String(row.peer_capabilities_request_id || '')) {
      return { invalidated: false, reason: 'stale_peer_request' };
    }
    const current = rowContext(row);
    if (input.context && !sameContext(current, normalizeContext(input.context))) {
      return { invalidated: false, reason: 'stale_peer_context' };
    }
    await tx.run(`
      UPDATE sync_link_state
         SET peer_capabilities_json=NULL, peer_capabilities_context_json=NULL,
             peer_capabilities_request_id=NULL, updated_at=?
       WHERE peer_node=? AND peer_capabilities_request_id=?
    `, [instant(input.now), peerNode, String(requestId)]);
    return { invalidated: true, request_id: String(requestId) };
  });
}

function attemptFromRow(row) {
  const value = parseJson(row && row.link_attempt_json, null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function beginLinkAttempt(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  const peerNode = input.peerNode || 'cloud';
  return db.transaction(async (tx) => {
    let row = await peerRowTx(tx, peerNode);
    const now = instant(input.now);
    if (!row) {
      await tx.run("INSERT INTO sync_link_state(peer_node,linked,updated_at) VALUES (?,0,?)", [peerNode, now]);
      row = await peerRowTx(tx, peerNode);
    }
    const existing = attemptFromRow(row);
    if (existing && !input.supersede && !input.recover) {
      const error = new Error('gateway account linking is in progress');
      error.code = 'link_in_progress'; error.statusCode = 409;
      throw error;
    }
    const current = normalizeContext({
      server_url: row.server_url,
      cloud_user_id: row.cloud_user_id,
      gateway_device_eui: row.gateway_device_eui,
      installation_uuid: row.installation_uuid,
    });
    const identity = normalizeContext({
      gateway_device_eui: row.identity_gateway_device_eui,
      installation_uuid: row.identity_installation_uuid,
    });
    const context = normalizeContext(input.context, {
      ...current,
      installation_uuid: current.installation_uuid || identity.installation_uuid,
      gateway_device_eui: current.gateway_device_eui || identity.gateway_device_eui,
    });
    const nonce = String(input.nonce || crypto.randomUUID());
    const requestId = input.requestId == null ? null : String(input.requestId);
    // Route selection is part of the fenced snapshot.  A caller-provided
    // route or snapshot is advisory only and can never bypass a live paused
    // policy discovered in this same transaction.
    const count = await tx.get("SELECT COUNT(*) AS n FROM irrigation_policies WHERE deleted_at IS NULL");
    const livePolicyCount = Number(count && count.n) || 0;
    const policySnapshot = { live: livePolicyCount > 0, live_policy_count: livePolicyCount };
    const attempt = {
      version: 1,
      nonce,
      request_id: requestId,
      route: policySnapshot.live ? 'conditional' : 'legacy',
      context,
      baseline_context: current,
      policy_snapshot: policySnapshot || null,
      started_at: now,
    };
    const capturedSupportContext = row.peer_capabilities_context_json
      ? normalizeContext(parseJson(row.peer_capabilities_context_json, {}))
      : null;
    const contextChanged = Boolean(capturedSupportContext)
      && (!sameContext(current, capturedSupportContext) || !sameContext(context, capturedSupportContext));
    await tx.run(`
      UPDATE sync_link_state
         SET link_attempt_json=?,
             peer_capabilities_json=CASE WHEN ? THEN NULL ELSE peer_capabilities_json END,
             peer_capabilities_context_json=CASE WHEN ? THEN NULL ELSE peer_capabilities_context_json END,
             peer_capabilities_request_id=CASE WHEN ? THEN NULL ELSE peer_capabilities_request_id END,
             updated_at=?
       WHERE peer_node=?
    `, [JSON.stringify(attempt), contextChanged ? 1 : 0, contextChanged ? 1 : 0, contextChanged ? 1 : 0, now, peerNode]);
    return attempt;
  });
}

async function clearLinkAttempt(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  return db.transaction(async (tx) => {
    const row = await peerRowTx(tx, input.peerNode || 'cloud');
    const attempt = attemptFromRow(row);
    if (!attempt) return { cleared: false, reason: 'no_attempt' };
    if (input.nonce == null) return { cleared: false, reason: 'nonce_required' };
    if (String(input.nonce) !== String(attempt.nonce)) return { cleared: false, reason: 'stale_nonce' };
    await tx.run("UPDATE sync_link_state SET link_attempt_json=NULL,updated_at=? WHERE peer_node=?", [instant(input.now), input.peerNode || 'cloud']);
    return { cleared: true, nonce: attempt.nonce };
  });
}

async function validateLinkAttemptTx(tx, input = {}) {
  const peerNode = input.peerNode || 'cloud';
  const row = await peerRowTx(tx, peerNode);
  const attempt = attemptFromRow(row);
  if (!row || !attempt || String(input.nonce || '') !== String(attempt.nonce)
      || (attempt.request_id != null && String(input.requestId || '') !== String(attempt.request_id))) {
    return { valid: false, reason: 'stale_link_attempt' };
  }
  const current = normalizeContext({
    server_url: row.server_url,
    cloud_user_id: row.cloud_user_id,
    gateway_device_eui: row.gateway_device_eui,
    installation_uuid: row.installation_uuid,
  });
  const baseline = normalizeContext(attempt.baseline_context || {});
  const expected = normalizeContext(input.context || attempt.context);
  const attemptContext = normalizeContext(attempt.context || {});
  const identity = normalizeContext({
    gateway_device_eui: row.identity_gateway_device_eui,
    installation_uuid: row.identity_installation_uuid,
  });
  const firstLinkCloudIdentity = !baseline.cloud_user_id && !attemptContext.cloud_user_id && !current.cloud_user_id;
  const expectedMatchesAttempt = CONTEXT_KEYS.every((key) => {
    if (key === 'cloud_user_id' && firstLinkCloudIdentity) return Boolean(expected.cloud_user_id);
    return expected[key] === attemptContext[key];
  });
  if (!sameContext(current, baseline)
      || !contextComplete(expected)
      || !expectedMatchesAttempt
      || expected.gateway_device_eui !== identity.gateway_device_eui
      || expected.installation_uuid !== identity.installation_uuid) {
    return { valid: false, reason: 'stale_peer_context' };
  }
  const capabilitiesInput = input.capabilities && typeof input.capabilities === 'object' && !Array.isArray(input.capabilities)
    ? (input.capabilities.supportedSyncCapabilities || input.capabilities.capabilities)
    : input.capabilities;
  const capabilities = Array.isArray(capabilitiesInput) ? sortedStrings(capabilitiesInput) : [];
  const guarded = attempt.route === 'conditional';
  if (guarded && !capabilities.includes(CONDITIONAL_CAPABILITY)) {
    return { valid: false, reason: 'conditional_capability_missing', capabilities };
  }
  return {
    valid: true,
    route: attempt.route,
    capabilities,
    context: expected,
    request_id: input.requestId == null ? (attempt.request_id || attempt.nonce) : String(input.requestId),
  };
}

async function validateLinkAttempt(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  return db.transaction((tx) => validateLinkAttemptTx(tx, options || {}));
}

async function finalizePeerContextTx(tx, input = {}) {
  const peerNode = input.peerNode || 'cloud';
  const validation = await validateLinkAttemptTx(tx, input);
  if (!validation.valid && validation.reason !== 'conditional_capability_missing') return { finalized: false, reason: validation.reason };
  const row = await peerRowTx(tx, peerNode);
  const attempt = attemptFromRow(row);
  const expected = validation.context;
  const capabilities = validation.capabilities || [];
  if (!validation.valid && validation.reason === 'conditional_capability_missing') {
    await tx.run(`
      UPDATE sync_link_state
         SET peer_capabilities_json=NULL, peer_capabilities_context_json=NULL,
             peer_capabilities_request_id=NULL, link_attempt_json=NULL, updated_at=?
       WHERE peer_node=?
    `, [instant(input.now), peerNode]);
    return { finalized: false, reason: 'conditional_capability_missing', capabilities };
  }
  // A legacy route does not require conditional support, but it may still
  // advertise that capability. Preserve genuinely advertised support so a
  // subsequent guarded delivery can use the same accepted context.
  const acceptedCapabilities = capabilities;
  const acceptedRequestId = acceptedCapabilities.length
    ? String(validation.request_id || input.requestId || attempt.request_id || attempt.nonce)
    : null;
  await tx.run(`
      UPDATE sync_link_state
         SET linked=1, server_url=?, cloud_user_id=?, gateway_device_eui=?, installation_uuid=?,
             peer_capabilities_json=?, peer_capabilities_context_json=?, peer_capabilities_request_id=?,
             link_attempt_json=NULL, updated_at=?
       WHERE peer_node=?
    `, [expected.server_url, expected.cloud_user_id, expected.gateway_device_eui, expected.installation_uuid,
      acceptedCapabilities.length ? JSON.stringify(acceptedCapabilities) : null,
      acceptedCapabilities.length ? JSON.stringify(expected) : null,
      acceptedRequestId,
      instant(input.now), peerNode]);
    return { finalized: true, route: attempt.route, capabilities: acceptedCapabilities, context: expected, request_id: acceptedRequestId };
}

async function finalizePeerContext(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  return db.transaction((tx) => finalizePeerContextTx(tx, options || {}));
}

async function invalidatePeerContext(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  return db.transaction(async (tx) => {
    const peerNode = input.peerNode || 'cloud';
    const row = await peerRowTx(tx, peerNode);
    if (!row) return { invalidated: false, reason: 'peer_missing' };
    const currentAttempt = attemptFromRow(row);
    if (input.attemptNonce != null
        && (!currentAttempt || String(input.attemptNonce) !== String(currentAttempt.nonce))) {
      return { invalidated: false, reason: 'stale_attempt' };
    }
    const current = normalizeContext({ server_url: row.server_url, cloud_user_id: row.cloud_user_id, gateway_device_eui: row.gateway_device_eui, installation_uuid: row.installation_uuid });
    if (input.context && !sameContext(current, normalizeContext(input.context))) return { invalidated: false, reason: 'stale_peer_context' };
    if (input.requestId != null && String(input.requestId) !== String(row.peer_capabilities_request_id || '')) return { invalidated: false, reason: 'stale_request' };
    await tx.run(`
      UPDATE sync_link_state
         SET peer_capabilities_json=NULL, peer_capabilities_context_json=NULL,
             peer_capabilities_request_id=NULL, link_attempt_json=NULL, updated_at=?
       WHERE peer_node=?
    `, [instant(input.now), peerNode]);
    return { invalidated: true };
  });
}

function normalizeDbOptions(dbOrOptions, maybeOptions) {
  if (dbOrOptions && dbOrOptions.db) return { db: dbOrOptions.db, options: dbOrOptions };
  return { db: dbOrOptions, options: maybeOptions || {} };
}

function cleanChoice(value, kind) {
  const source = value || {};
  if (kind === 'DENDRO') {
    return {
      kind: 'DENDRO',
      eligible: Boolean(source.eligible),
      state: stringValue(source.state) || 'unavailable',
      reason: source.reason == null ? null : String(source.reason),
      sources: asArray(source.sources).map((item) => ({
        device_eui: canonicalEui(item && item.device_eui),
        channel: item && item.channel == null ? null : String(item.channel),
      })).filter((item) => item.device_eui && item.channel !== null),
    };
  }
  return {
    kind: kind || String(source.kind || '').toUpperCase(),
    device_eui: canonicalEui(source.device_eui),
    channel: stringValue(source.channel),
    type_id: source.type_id == null ? null : String(source.type_id),
    eligible: Boolean(source.eligible),
    reason: source.reason == null ? null : String(source.reason),
  };
}

function cleanLastResult(value) {
  if (!value) return null;
  let decisionKey = value.decision_key || (value.schedule_uuid && value.local_date && value.local_time
    ? `${value.schedule_uuid}|${value.local_date}|${value.local_time}` : null);
  if (decisionKey && value.zone_uuid && String(decisionKey).split('|').length === 3) {
    decisionKey = `${value.zone_uuid}|${decisionKey}`;
  } else if (!decisionKey && value.zone_uuid && value.schedule_uuid && value.local_date && value.local_time) {
    decisionKey = `${value.zone_uuid}|${value.schedule_uuid}|${value.local_date}|${value.local_time}`;
  }
  return {
    decision_key: decisionKey == null ? null : String(decisionKey),
    decision: value.decision == null ? null : String(value.decision),
    decision_reason: value.decision_reason == null ? null : String(value.decision_reason),
    due_at: value.due_at == null ? null : String(value.due_at),
    state: value.state == null ? null : String(value.state),
    decision_at: value.decision_at == null ? null : String(value.decision_at),
    requested_duration_minutes: value.requested_duration_minutes == null ? null : Number(value.requested_duration_minutes),
    effective_duration_minutes: value.effective_duration_minutes == null ? null : Number(value.effective_duration_minutes),
  };
}

function clockPayload(status, asOf) {
  return {
    clock: clockValue(status),
    valid_until: status && status.trusted === true ? new Date(Date.parse(asOf) + TRUSTED_VALIDITY_MS).toISOString() : null,
  };
}

async function zoneRuntimeTx(tx, key, asOf, status, timezone, qualificationProvider) {
  const zone = await tx.get('SELECT * FROM irrigation_zones WHERE zone_uuid=? AND deleted_at IS NULL', [String(key)]);
  const baseClock = clockPayload(status, asOf);
  if (!zone) {
    return {
      gateway_device_eui: null,
      payload: {
        contract_version: 1, projection_revision: 1, zone_uuid: String(key), policy_uuid: null,
        eligible_sources: [], source_choices: { SWT: [], VWC: [], DENDRO: [] }, qualification: null,
        next_check: null, last_result: null, ...baseClock, as_of: asOf,
        legacy_process_timezone: timezone, deleted_at: asOf,
      },
    };
  }
  const livePolicy = await tx.get('SELECT policy_uuid FROM irrigation_policies WHERE zone_uuid=? AND deleted_at IS NULL', [String(key)]);
  if (!livePolicy) {
    return {
      gateway_device_eui: canonicalEui(zone.gateway_device_eui),
      payload: {
        contract_version: 1, projection_revision: 1, zone_uuid: String(zone.zone_uuid), policy_uuid: null,
        eligible_sources: [], source_choices: { SWT: [], VWC: [], DENDRO: [] }, qualification: null,
        next_check: null, last_result: null, ...baseClock, as_of: asOf,
        legacy_process_timezone: timezone, deleted_at: asOf,
      },
    };
  }
  // Lazy require avoids an index/api cycle.  readPolicy itself only reads when
  // skipValveReadiness is set; its source resolver remains the canonical view.
  const api = require('./api');
  const view = await api.readPolicy({
    db: tx,
    zone: String(key),
    now: asOf,
    skipValveReadiness: true,
    qualificationProvider,
    validatedProcessTimezone: timezone,
  });
  const sourceChoices = view.source_choices || { SWT: [], VWC: [], DENDRO: [] };
  const choices = {
    SWT: asArray(sourceChoices.SWT).map((item) => cleanChoice(item, 'SWT')),
    VWC: asArray(sourceChoices.VWC).map((item) => cleanChoice(item, 'VWC')),
    DENDRO: asArray(sourceChoices.DENDRO).map((item) => cleanChoice(item, 'DENDRO')),
  };
  const eligible = asArray(view.eligible_sources)
    .filter((item) => ['SWT', 'VWC'].includes(String(item && item.kind || '').toUpperCase()))
    .map((item) => cleanChoice(item, String(item.kind).toUpperCase()));
  const qualification = view.qualification == null ? null : {
    qualified: Boolean(view.qualification.qualified),
    reason: view.qualification.reason == null ? null : String(view.qualification.reason),
  };
  const gateway = zone.gateway_device_eui ? canonicalEui(zone.gateway_device_eui)
    : (await tx.get("SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'"));
  return {
    gateway_device_eui: typeof gateway === 'object' ? canonicalEui(gateway && gateway.gateway_device_eui) : canonicalEui(gateway),
    payload: {
      contract_version: 1,
      projection_revision: 1,
      zone_uuid: String(zone.zone_uuid),
      policy_uuid: view.policy && view.policy.policy_uuid || null,
      eligible_sources: eligible,
      source_choices: choices,
      qualification,
      next_check: view.next_check == null ? null : String(view.next_check),
      last_result: cleanLastResult(view.last_result),
      ...baseClock,
      as_of: asOf,
      legacy_process_timezone: timezone,
      deleted_at: null,
    },
  };
}

async function valveReadinessTx(tx, eui, control) {
  const revision = control && control.desired_revision || null;
  const required = asArray(control && control.required_push_ids);
  if (!revision || !required.length) return { state: 'PENDING', ready: false, reason: 'no_current_revision' };
  const settings = await valveStore.getSettings(tx, eui);
  if (control.generation && control.generation !== settings.strega_generation) return { state: 'PENDING', ready: false, reason: 'generation_mismatch' };
  const rows = await tx.all(`SELECT push_id,state FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND push_id IN (${required.map(() => '?').join(',')})`, [eui].concat(required));
  if (rows.length !== required.length) return { state: 'PENDING', ready: false, reason: 'invalid_required_push_set' };
  const ready = required.every((id) => rows.some((row) => row.push_id === id && row.state === 'ACKED'));
  return ready ? { state: 'READY', ready: true, reason: 'all_current_clear_acked' } : { state: 'PENDING', ready: false, reason: 'awaiting_clear_ack' };
}

function cleanIncident(value) {
  if (!value) return null;
  return {
    incident_id: value.incident_id == null ? null : String(value.incident_id),
    state: value.state == null ? null : String(value.state),
    ended_at: value.ended_at == null ? null : String(value.ended_at),
    reconciled_at: value.reconciled_at == null ? null : String(value.reconciled_at),
    retry_pending: value.retry_revision != null || value.retry_pending === true,
  };
}

async function valveRuntimeTx(tx, key, asOf, status) {
  const eui = canonicalEui(key);
  const row = await tx.get(`
    SELECT vs.condition_policy_uuid, d.irrigation_zone_id, z.zone_uuid,
           p.policy_uuid AS live_policy_uuid
      FROM valve_schedules vs
      JOIN devices d ON UPPER(d.deveui)=UPPER(vs.device_eui)
      JOIN irrigation_zones z ON z.id=d.irrigation_zone_id AND z.deleted_at IS NULL
      LEFT JOIN irrigation_policies p
        ON p.policy_uuid=vs.condition_policy_uuid
       AND p.zone_uuid=z.zone_uuid
       AND p.deleted_at IS NULL
     WHERE UPPER(vs.device_eui)=UPPER(?)
       AND vs.deleted_at IS NULL
       AND (vs.condition_policy_uuid IS NOT NULL OR vs.effective_from IS NOT NULL)
       AND d.deleted_at IS NULL
       AND d.type_id='STREGA_VALVE'
       AND (vs.condition_policy_uuid IS NULL OR p.policy_uuid IS NOT NULL)
     ORDER BY CASE WHEN vs.condition_policy_uuid IS NOT NULL THEN 0 ELSE 1 END, vs.updated_at DESC
     LIMIT 1
  `, [eui]);
  const policy = row && row.live_policy_uuid ? { policy_uuid: row.live_policy_uuid } : null;
  let control = null;
  try { control = await valveStore.conditionalControl(tx, eui); } catch (_) { control = null; }
  const readiness = control ? await valveReadinessTx(tx, eui, control) : { state: 'PENDING', ready: false, reason: 'no_current_revision' };
  const settings = await tx.get('SELECT gateway_device_eui FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [eui]);
  const baseClock = clockPayload(status, asOf);
  return {
    gateway_device_eui: canonicalEui(settings && settings.gateway_device_eui),
    payload: {
      contract_version: 1, projection_revision: 1, device_eui: eui,
      policy_uuid: policy && policy.policy_uuid || null, zone_uuid: row && row.zone_uuid || null,
      update: { state: readiness.state, ready: readiness.ready, reason: readiness.reason },
      incident: cleanIncident(control && control.incident),
      ...baseClock, as_of: asOf, deleted_at: row ? null : asOf,
    },
  };
}

function cleanEvidenceCondition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = String(value.kind || '').toUpperCase();
  const sources = asArray(value.sources).map((source) => ({ device_eui: canonicalEui(source && source.device_eui), channel: stringValue(source && source.channel) })).filter((source) => source.device_eui && source.channel);
  if (kind === 'SWT') return { kind, threshold_kpa: value.threshold_kpa == null ? null : Number(value.threshold_kpa), sources };
  if (kind === 'VWC') return { kind, threshold_percent: value.threshold_percent == null ? null : Number(value.threshold_percent), sources };
  if (kind === 'DENDRO') return { kind, minimum_stress: value.minimum_stress == null ? null : String(value.minimum_stress), response_mode: value.response_mode == null ? null : String(value.response_mode) };
  return null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function timestampOrNull(value) {
  if (value == null || value === '') return null;
  const milliseconds = Date.parse(String(value));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function sampleSummary(source) {
  const samples = asArray(source && source.samples);
  const times = samples.map((sample) => timestampOrNull(sample && (sample.at || sample.recorded_at))).filter(Boolean);
  return {
    sample_count: source && source.sample_count != null ? integerOrNull(source.sample_count) : times.length,
    first_sample_at: timestampOrNull(source && source.first_sample_at) || times[0] || null,
    last_sample_at: timestampOrNull(source && source.last_sample_at) || times[times.length - 1] || null,
    latest_sample_at: timestampOrNull(source && source.latest_sample_at) || times[times.length - 1] || null,
  };
}

function cleanEvidenceEvaluationSource(source, conditionKind) {
  const raw = source && typeof source === 'object' ? source : {};
  const analysis = raw.analysis && typeof raw.analysis === 'object' ? raw.analysis : raw;
  const inferredKind = String(raw.kind || (analysis === raw ? conditionKind : 'DENDRO') || '').toUpperCase();
  const kind = inferredKind === 'DENDRO' ? 'DENDRO' : inferredKind;
  const clean = {
    kind,
    device_eui: canonicalEui(raw.device_eui),
    channel: stringValue(raw.channel),
  };
  if (kind === 'DENDRO') {
    clean.device_eui = canonicalEui(raw.device_eui || analysis.device_eui);
    clean.channel = stringValue(raw.channel || analysis.channel);
    clean.computed_at = timestampOrNull(raw.computed_at || analysis.computed_at || analysis.computedAt);
    clean.stress = raw.stress == null ? (analysis.stress == null ? null : String(analysis.stress)) : String(raw.stress);
    clean.action = raw.action == null ? (analysis.action == null ? null : String(analysis.action)) : String(raw.action);
    clean.usable_tree_count = raw.usable_tree_count == null
      ? integerOrNull(analysis.usable_tree_count)
      : integerOrNull(raw.usable_tree_count);
    return clean;
  }
  // Soil evidence must retain a strict identity. A malformed source is
  // dropped so one bad raw row cannot make the whole accepted Decision DTO
  // invalid or leak an untrusted placeholder identity.
  if (!clean.device_eui || !clean.channel) return null;
  const summary = sampleSummary(raw);
  clean.mean = finiteNumber(raw.mean);
  clean.threshold = finiteNumber(raw.threshold);
  clean.sample_count = summary.sample_count;
  clean.first_sample_at = summary.first_sample_at;
  clean.last_sample_at = summary.last_sample_at;
  clean.computed_at = timestampOrNull(raw.computed_at);
  return clean;
}

function cleanEvidenceObservationSource(source, conditionKind) {
  const raw = source && typeof source === 'object' ? source : {};
  const inferredKind = String(raw.kind || conditionKind || '').toUpperCase();
  const clean = {
    kind: inferredKind,
    device_eui: canonicalEui(raw.device_eui),
    channel: stringValue(raw.channel),
  };
  if (inferredKind !== 'DENDRO' && (!clean.device_eui || !clean.channel)) return null;
  const summary = sampleSummary(raw);
  clean.eligible = raw.eligible == null ? null : Boolean(raw.eligible);
  clean.reason = raw.reason == null ? null : String(raw.reason);
  clean.sample_count = summary.sample_count;
  clean.latest_sample_at = summary.latest_sample_at;
  clean.computed_at = timestampOrNull(raw.computed_at);
  return clean;
}

function cleanEvidence(value) {
  const raw = parseJson(value, value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const conditionKind = raw.condition && typeof raw.condition === 'object'
    ? String(raw.condition.kind || '').toUpperCase()
    : null;
  const evaluation = raw.evaluation && typeof raw.evaluation === 'object' ? {
    status: String(raw.evaluation.status || 'UNKNOWN'), reason: raw.evaluation.reason == null ? null : String(raw.evaluation.reason),
    // DENDRO's aggregate value is a stress label, while the accepted schema
    // reserves evaluation.value for numeric soil aggregates. Keep the label in
    // its typed source summary instead of producing NaN via Number(stress).
    value: typeof raw.evaluation.value === 'number' && Number.isFinite(raw.evaluation.value) ? raw.evaluation.value : null,
    unit: raw.evaluation.unit == null ? null : String(raw.evaluation.unit),
    sources: asArray(raw.evaluation.sources).map((source) => cleanEvidenceEvaluationSource(source, conditionKind)).filter(Boolean),
  } : null;
  const observation = raw.observation && typeof raw.observation === 'object' ? {
    reason: raw.observation.reason == null ? null : String(raw.observation.reason),
    sources: asArray(raw.observation.sources).map((source) => cleanEvidenceObservationSource(source, conditionKind)).filter(Boolean),
  } : null;
  const result = {
    timezone: String(raw.timezone || 'UTC'), reason: raw.reason == null ? null : String(raw.reason), selected_at: timestampOrNull(raw.selected_at),
    requested_duration_minutes: raw.requested_duration_minutes == null ? null : integerOrNull(raw.requested_duration_minutes),
    condition: cleanEvidenceCondition(raw.condition), evaluation, observation,
  };
  if (raw.readiness !== undefined) result.readiness = raw.readiness == null ? null : { state: raw.readiness.state == null ? null : String(raw.readiness.state), ready: raw.readiness.ready == null ? null : Boolean(raw.readiness.ready), reason: raw.readiness.reason == null ? null : String(raw.readiness.reason) };
  if (raw.qualification !== undefined) result.qualification = raw.qualification == null ? null : { qualified: Boolean(raw.qualification.qualified), reason: raw.qualification.reason == null ? null : String(raw.qualification.reason) };
  return result;
}

function parseDecisionKey(key) {
  const parts = String(key).split('|');
  if (parts.length !== 4 || parts.some((part) => !part)) throw new TypeError('decision projection key must be zone_uuid|schedule_uuid|local_date|local_time');
  return { zoneUuid: parts[0], scheduleUuid: parts[1], localDate: parts[2], localTime: parts[3] };
}

async function decisionTx(tx, key, asOf) {
  const { zoneUuid, scheduleUuid, localDate, localTime } = parseDecisionKey(key);
  const row = await tx.get('SELECT * FROM irrigation_occurrences WHERE zone_uuid=? AND schedule_uuid=? AND local_date=? AND local_time=? AND decision_at IS NOT NULL', [zoneUuid, scheduleUuid, localDate, localTime]);
  if (!row) {
    return {
      gateway_device_eui: null,
      payload: {
        contract_version: 1, projection_revision: 1, decision_key: String(key), zone_uuid: zoneUuid, state: 'DELETED',
        effective_duration_minutes: null, requested_duration_minutes: null, schedule_sync_version: 0, policy_sync_version: 0,
        local_time: localTime, local_date: localDate, schedule_uuid: scheduleUuid, policy_uuid: null, device_eui: null,
        due_at: asOf, decision: 'DELETED', decision_reason: 'source_deleted', decision_at: asOf,
        evidence: { timezone: 'UTC', reason: 'source_deleted', selected_at: asOf, requested_duration_minutes: null, condition: null, evaluation: null, observation: null },
        deleted_at: asOf,
      },
    };
  }
  return {
    gateway_device_eui: canonicalEui((await tx.get('SELECT gateway_device_eui FROM devices WHERE UPPER(deveui)=UPPER(?)', [row.device_eui]))?.gateway_device_eui),
    payload: {
      contract_version: 1, projection_revision: 1,
      decision_key: `${row.zone_uuid}|${row.schedule_uuid}|${row.local_date}|${row.local_time}`,
      zone_uuid: row.zone_uuid || '', state: row.state, effective_duration_minutes: row.effective_duration_minutes == null ? null : Number(row.effective_duration_minutes),
      requested_duration_minutes: row.requested_duration_minutes == null ? null : Number(row.requested_duration_minutes), schedule_sync_version: Number(row.schedule_sync_version || 0), policy_sync_version: Number(row.policy_sync_version || 0),
      local_time: row.local_time, local_date: row.local_date, schedule_uuid: row.schedule_uuid, policy_uuid: row.policy_uuid || null, device_eui: canonicalEui(row.device_eui),
      due_at: row.due_at, decision: row.decision, decision_reason: row.decision_reason || null, decision_at: row.decision_at, evidence: cleanEvidence(row.decision_evidence_json),
    },
  };
}

async function buildPayloadTx(tx, kind, key, asOf, status, timezone, qualificationProvider) {
  if (kind === 'POLICY_RUNTIME') return zoneRuntimeTx(tx, key, asOf, status, timezone, qualificationProvider);
  if (kind === 'VALVE_RUNTIME') return valveRuntimeTx(tx, key, asOf, status);
  return decisionTx(tx, key, asOf, status);
}

async function peerSupportsConditionalTx(tx) {
  return supportFromRow(await peerRowTx(tx, 'cloud'));
}

async function authoritativeGatewayTx(tx, fallback = null) {
  const row = await tx.get(`
    SELECT i.current_gateway_device_eui AS identity_eui,
           s.gateway_device_eui AS linked_eui
      FROM sync_link_state s
      LEFT JOIN installation_identity i ON i.singleton_id=1
     WHERE s.peer_node='cloud'
  `);
  return canonicalEui(
    row && (row.identity_eui || row.linked_eui) || fallback || null
  );
}

async function publishProjection(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  const kind = String(input.kind || '').toUpperCase();
  if (!PROJECTION_KINDS.has(kind)) throw new TypeError(`unknown projection kind: ${kind}`);
  if (input.key == null || String(input.key) === '') throw new TypeError('projection key is required');
  const key = String(input.key);
  const asOf = instant(input.now);
  const timezone = processTimezone();
  const status = await readClock(input);
  return db.transaction(async (tx) => {
    const source = await buildPayloadTx(tx, kind, key, asOf, status, timezone, input.qualificationProvider);
    const previous = await tx.get('SELECT * FROM conditional_irrigation_sync_projections WHERE projection_kind=? AND projection_key=?', [kind, key]);
    const previousPayload = rowPayload(previous);
    const stableSourcePayload = source.payload.deleted_at && previousPayload
      ? {
        ...previousPayload,
        ...(kind === 'DECISION' ? {} : { ...clockPayload(status, asOf), as_of: asOf }),
        deleted_at: previousPayload.deleted_at || asOf,
      }
      : source.payload;
    const support = await peerSupportsConditionalTx(tx);
    const eventGateway = await authoritativeGatewayTx(tx, source.gateway_device_eui);
    const refreshDue = kind !== 'DECISION' && dueForRefresh(previousPayload, asOf);
    if (previous && semanticallyEqual(previousPayload, stableSourcePayload) && !refreshDue) {
      return { changed: false, emitted: false, projection: previous };
    }
    const revision = previous ? Number(previous.projection_revision) + 1 : 1;
    // Tombstones retain the last typed identity and evidence.  Rebuilding a
    // null-shaped payload would make an unlink/reassignment look like a new
    // resource and would lose the receiver's ability to retire it safely.
    const payloadBase = stableSourcePayload;
    const payload = { ...payloadBase, projection_revision: revision };
    const payloadJson = stableJson(payload);
    const payloadHash = hashPayload(payload);
    await tx.run(`
      INSERT INTO conditional_irrigation_sync_projections(projection_kind,projection_key,projection_revision,payload_hash,payload_json)
      VALUES (?,?,?,?,?)
      ON CONFLICT(projection_kind,projection_key) DO UPDATE SET
        projection_revision=excluded.projection_revision,
        payload_hash=excluded.payload_hash,
        payload_json=excluded.payload_json
    `, [kind, key, revision, payloadHash, payloadJson]);
    const projection = await tx.get('SELECT * FROM conditional_irrigation_sync_projections WHERE projection_kind=? AND projection_key=?', [kind, key]);
    if (support) await insertProjectionEventTx(tx, kind, key, projection, eventGateway, asOf);
    return { changed: true, emitted: support, projection };
  });
}

async function insertProjectionEventTx(tx, kind, key, projection, gatewayDeviceEui, occurredAt) {
  const payload = rowPayload(projection) || {};
  await tx.run(`
    INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui)
    VALUES (?,?,?,?,?,?,?,?)
  `, [crypto.randomUUID().replace(/-/g, ''), EVENT_TYPES[kind], key, EVENT_OPS[kind], projection.payload_json, projection.projection_revision, occurredAt || payload.as_of || instant(), canonicalEui(gatewayDeviceEui)]);
}

async function readProjection(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const kind = String(options.kind || '').toUpperCase();
  return db.get('SELECT * FROM conditional_irrigation_sync_projections WHERE projection_kind=? AND projection_key=?', [kind, String(options.key)]);
}

async function projectionKeys(db, kind) {
  if (kind === 'POLICY_RUNTIME') return db.all(`SELECT zone_uuid AS key FROM irrigation_policies WHERE deleted_at IS NULL UNION SELECT projection_key AS key FROM conditional_irrigation_sync_projections WHERE projection_kind=?`, [kind]);
  if (kind === 'VALVE_RUNTIME') return db.all(`SELECT DISTINCT device_eui AS key FROM valve_schedules WHERE (condition_policy_uuid IS NOT NULL OR effective_from IS NOT NULL) AND deleted_at IS NULL UNION SELECT projection_key AS key FROM conditional_irrigation_sync_projections WHERE projection_kind=?`, [kind]);
  return db.all(`SELECT zone_uuid || '|' || schedule_uuid || '|' || local_date || '|' || local_time AS key FROM irrigation_occurrences WHERE zone_uuid IS NOT NULL AND decision_at IS NOT NULL UNION SELECT projection_key AS key FROM conditional_irrigation_sync_projections WHERE projection_kind=?`, [kind]);
}

async function reconcileProjections(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const kinds = options.kind ? [String(options.kind).toUpperCase()] : [...PROJECTION_KINDS];
  const results = [];
  for (const kind of kinds) {
    for (const row of await projectionKeys(db, kind)) {
      results.push(await publishProjection(db, { ...options, kind, key: row.key }));
    }
  }
  return results;
}

// Mutation adapters pass identifiers only.  Each publisher transaction rereads
// the canonical source rows, so a stale response or a partially populated
// notification can never become projection state.  The periodic reconciler
// remains the recovery path for a missed notification.
async function notifyProjectionKeys(dbOrOptions, maybeOptions) {
  const { db, options } = normalizeDbOptions(dbOrOptions, maybeOptions);
  const input = options || {};
  const keys = (value) => {
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    return [...new Set(list.map((item) => String(item == null ? '' : item).trim()).filter(Boolean))];
  };
  const common = {};
  for (const key of ['now', 'clockStatus', 'clockProbe', 'qualificationProvider']) {
    if (input[key] !== undefined) common[key] = input[key];
  }
  const results = [];
  for (const key of keys(input.policyKeys || input.policy_keys || input.zoneUuid || input.zone_uuid)) {
    results.push(await publishProjection(db, { ...common, kind: 'POLICY_RUNTIME', key }));
  }
  for (const key of keys(input.valveKeys || input.valve_keys || input.valveEuis || input.valve_euis || input.deviceEui || input.device_eui)) {
    results.push(await publishProjection(db, { ...common, kind: 'VALVE_RUNTIME', key }));
  }
  for (const key of keys(input.decisionKeys || input.decision_keys)) {
    results.push(await publishProjection(db, { ...common, kind: 'DECISION', key }));
  }
  return results;
}

module.exports = {
  CONDITIONAL_CAPABILITY,
  readPeerContext,
  peerSupportsConditional,
  beginPeerRequest,
  capturePeerRequest: beginPeerRequest,
  acceptPeerCapabilities,
  invalidatePeerRequest,
  beginLinkAttempt,
  validateLinkAttempt,
  finalizePeerContext,
  finalizePeerContextTx,
  clearLinkAttempt,
  invalidatePeerContext,
  reconcileLinkAttempt: clearLinkAttempt,
  publishProjection,
  reconcileProjections,
  notifyProjectionKeys,
  readProjection,
  processTimezone,
  canonicalizeProjection: stableJson,
  hashProjection: hashPayload,
};
