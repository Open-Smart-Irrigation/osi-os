'use strict';
const crypto = require('node:crypto');
const protectedBindingCanonicalization = require('../osi-watermark-binding/canonicalization');
// osi-command-ledger — the fleet-wide pending-command dedupe/ACK pipeline.
//
// Extracted from osi-journal/commands.js (2026-07-14): this pipeline (exact
// command-ID replay, effect-key duplicate detection, ACK classification and
// queueing) fails closed for EVERY command family (journal, irrigation
// scheduler/manual, config), not just journal commands, so it must not live
// inside — or depend on — the journal feature module. Any command family
// (UC512, MClimate, ...) can now depend on this module alone.
//
// Journal-specific knowledge (identity/effect-key binding rules for
// UPSERT_JOURNAL_ENTRY etc., and the intent-hash used to recognize a
// "compatible effect" duplicate under a different delivery command_id) stays
// in osi-journal and is injected here through the `opts` hook object accepted
// by deduplicatePendingCommand/validEffectBinding:
//   - opts.extraEffectBindingValidator(db, envelope, opts, type) — called only
//     when the command type looks like a journal type (see
//     isJournalCommandType below) and must return true/false.
//   - opts.extraSubmittedIntentHash(type, payload) — called only for journal
//     types, to compute the intent hash used for the identity-based duplicate
//     scan. When omitted, journal-type duplicate-by-effect-key detection is
//     skipped (falls through to "not a duplicate"); exact command-ID replay
//     (the primary/most common replay path) is unaffected either way.
// Non-journal command families never hit either hook: their effect-key
// grammar lives in validNonJournalEffectBinding below and their duplicate
// lookup is a plain effect_key+command_type match.

function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw commandError('malformed_command', field + ' must be an object');
  }
  return value;
}

function deliveryCommandId(envelope) {
  const value = envelope.commandId;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw commandError('malformed_command', 'Pending delivery commandId must be a positive integer');
  }
  return value;
}

function commandType(envelope) {
  const value = String(envelope.commandType || '').trim().toUpperCase();
  if (!value) throw commandError('malformed_command', 'Pending command type is required');
  return value;
}

function isJournalCommandType(type) {
  return /(?:^|_)JOURNAL(?:_|$)/.test(type);
}

// UPSERT_ZONE_CONFIG is deliberately excluded: that command type is owned
// end-to-end by the pre-existing Terra apply path (its own effect-key
// grammar and duplicate-detection, see osi-zone-commands' `validate`/
// `applyOnce`), which never routes through this generic dedupe pipeline.
function isZoneCommandType(type) {
  return [
    'UPSERT_ZONE',
    'DELETE_ZONE',
    'UPSERT_ZONE_LOCATION',
  ].includes(type);
}

const PROTECTED_CONFIGURATION_COMMANDS = new Set([
  'SET_WATERMARK_CALIBRATION',
  'DELETE_WATERMARK_CALIBRATION',
  'SET_CHAMELEON_CONFIG',
  'UPSERT_DEVICE_SOIL_DEPTHS',
]);

const PROTECTED_CONFIGURATION_SPECS = {
  SET_WATERMARK_CALIBRATION: { resourceType: 'WATERMARK_CALIBRATION', operation: 'set', prefix: 'watermark_calibration:set' },
  DELETE_WATERMARK_CALIBRATION: { resourceType: 'WATERMARK_CALIBRATION', operation: 'delete', prefix: 'watermark_calibration:delete' },
  SET_CHAMELEON_CONFIG: { resourceType: 'DEVICE', operation: 'set', prefix: 'chameleon_config:set' },
  UPSERT_DEVICE_SOIL_DEPTHS: { resourceType: 'DEVICE', operation: 'set', prefix: 'device_soil_depths:set' },
};

function isProtectedConfigurationCommand(type) {
  return PROTECTED_CONFIGURATION_COMMANDS.has(type);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function replayStatus(result) {
  if (result === 'APPLIED') return 'ACKED';
  if (result === 'CONFLICT') return 'CONFLICT';
  if (result === 'FAILED_RETRYABLE') return 'FAILED_RETRYABLE';
  return 'NACKED';
}

// F117/F120 (2026-09-17): a writer-level JSON cap on applied_commands.result_detail for
// OPEN_FOR_DURATION was tried here (#278/F96) and reverted (#279-follow-up/F120): it
// truncated the serialized ack JSON at 255 chars, and the ack envelope's OWN structural
// skeleton (commandId, eventUuid, aggregateType, aggregateKey, commandType, status,
// result, appliedAt, requestedSyncVersion, appliedSyncVersion, duplicate) already
// serializes to ~284-319 chars with reason/detail both null -- so EVERY OPEN_FOR_DURATION
// ack was truncated into invalid JSON, breaking `node --test
// scripts/test-scoped-access-writes.js` (SyntaxError: Unterminated string in JSON) and
// degrading replay (replayAck's JSON.parse-failure fallback loses eventUuid/
// aggregateType/aggregateKey/reason/detail on every replay of a capped row). The cloud's
// varchar(255) mirror column is already protected at the payload boundary
// (sync-bootstrap-build/sync-outbox-build/sync-force-build's capFreeTextFields(), see
// flows.json and scripts/test-valve-actuation-text-caps.js) and by the cloud's own
// EdgeStrings.fitFreeText (#136) -- this writer never needs to duplicate that cap, and
// doing so only corrupted the one column every command family's replay/dedup logic reads
// as JSON. applied_commands.result_detail is written as the full, untruncated
// JSON.stringify(initial) below, unconditionally, for every command type.

function parsedResultDetail(row) {
  let facts = {};
  if (typeof row.result_detail === 'string' && row.result_detail) {
    try {
      const parsed = JSON.parse(row.result_detail);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) facts = parsed;
      else facts = { storedResultDetail: parsed };
    } catch (_) {
      facts = { storedResultDetail: row.result_detail };
    }
  }
  return facts;
}

function replayAck(row, deliveryId, exactDelivery) {
  const facts = parsedResultDetail(row);
  const completeTerminalAck = hasOwn(facts, 'commandId') && hasOwn(facts, 'status') &&
    hasOwn(facts, 'result') && hasOwn(facts, 'duplicate');
  if (exactDelivery && completeTerminalAck) return Object.assign({}, facts);
  return Object.assign({}, facts, {
    commandId: deliveryId,
    commandType: facts.commandType || row.command_type,
    effectKey: facts.effectKey == null ? row.effect_key : facts.effectKey,
    appliedAt: facts.appliedAt || row.applied_at,
    status: replayStatus(row.result),
    result: row.result,
    duplicate: true,
  });
}

async function persistReplayAck(tx, row, deliveryId, exactDelivery) {
  const ack = replayAck(row, deliveryId, exactDelivery);
  const createdAt = new Date().toISOString();
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [String(deliveryId)]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox (command_id,payload_json,created_at) VALUES (?,?,?)',
    [String(deliveryId), JSON.stringify(ack), createdAt]
  );
  return ack;
}

function canonicalIntentHash(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce(function(out, key) {
        if (key !== 'command_id') out[key] = canonical(item[key]);
        return out;
      }, {});
    }
    return item;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function protectedContext(envelope, runtime, type) {
  if (!isProtectedConfigurationCommand(type)) return null;
  const payload = envelope && envelope.payload;
  const runtimeGateway = String(runtime && (runtime.gateway_device_eui || runtime.gatewayDeviceEui) || '');
  if (!/^[0-9A-F]{16}$/.test(runtimeGateway)) {
    throw commandError('protected_command_conflict', 'trusted gateway binding is required');
  }
  const suppliedContext = (runtime && (runtime.protected_context || runtime.protectedContext)) ||
    (envelope && (envelope.protected_context || envelope.protectedContext));
  const context = suppliedContext && typeof suppliedContext === 'object' && !Array.isArray(suppliedContext)
    ? suppliedContext : {};
  const payloadIntent = payload && payload.values && typeof payload.values === 'object' && !Array.isArray(payload.values)
    ? payload.values : {};
  const payloadClaim = payload && payload.normalized_intent && typeof payload.normalized_intent === 'object' &&
    !Array.isArray(payload.normalized_intent) ? payload.normalized_intent : null;
  const contextClaim = context.normalized_intent && typeof context.normalized_intent === 'object' &&
    !Array.isArray(context.normalized_intent) ? context.normalized_intent
    : (context.normalizedIntent && typeof context.normalizedIntent === 'object' &&
      !Array.isArray(context.normalizedIntent) ? context.normalizedIntent : null);
  if ((payloadClaim && protectedBindingCanonicalization.canonicalize(payloadIntent) !==
      protectedBindingCanonicalization.canonicalize(payloadClaim)) ||
      (contextClaim && protectedBindingCanonicalization.canonicalize(payloadIntent) !==
      protectedBindingCanonicalization.canonicalize(contextClaim))) {
    throw commandError('protected_command_conflict', 'WATERMARK command intent differs from trusted runtime context');
  }
  const trustedIntent = payloadIntent;
  const spec = PROTECTED_CONFIGURATION_SPECS[type];
  const values = {
    resource_type: context.resource_type || context.resourceType || spec.resourceType,
    resource_id: context.resource_id || context.resourceId || (payload && (payload.device_eui || payload.deviceEui)),
    gateway_device_eui: context.gateway_device_eui || context.gatewayDeviceEui || (payload && (payload.gateway_device_eui || payload.gatewayDeviceEui)),
    actor_user_uuid: context.actor_user_uuid || context.actorUserUuid || (payload && (payload.actor_user_uuid || payload.actorUserUuid)),
    base_sync_version: context.base_sync_version == null
      ? (context.baseSyncVersion == null ? payload && payload.base_sync_version : context.baseSyncVersion)
      : context.base_sync_version,
    operation: context.operation || (payload && payload.operation) || spec.operation,
  };
  if (values.resource_type !== spec.resourceType ||
      !/^[0-9A-F]{16}$/.test(String(values.resource_id || '')) ||
      !/^[0-9A-F]{16}$/.test(String(values.gateway_device_eui || '')) ||
      values.gateway_device_eui !== runtimeGateway ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(values.actor_user_uuid || '')) ||
      !Number.isSafeInteger(values.base_sync_version) || values.base_sync_version < 0 ||
      !['set', 'delete'].includes(values.operation) ||
      values.operation !== spec.operation) {
    throw commandError('protected_command_conflict', 'trusted WATERMARK command binding is invalid');
  }
  const effectKey = String((payload && (payload.effect_key || payload.effectKey)) || envelope.effectKey || '').trim();
  const expectedEffect = `${spec.prefix}:${values.gateway_device_eui}:${values.resource_id}:${values.base_sync_version}`;
  if (effectKey !== expectedEffect || !payload ||
      String(payload.device_eui || payload.deviceEui || '').trim() !== values.resource_id ||
      String(payload.gateway_device_eui || payload.gatewayDeviceEui || '').trim() !== values.gateway_device_eui ||
      String(payload.actor_user_uuid || payload.actorUserUuid || '').trim() !== values.actor_user_uuid ||
      payload.base_sync_version !== values.base_sync_version ||
      payload.operation !== values.operation) {
    throw commandError('protected_command_conflict', 'WATERMARK command semantic key does not match trusted binding');
  }
  const binding = {
    command_type: type,
    resource: values.resource_type,
    device_eui: values.resource_id,
    gateway_device_eui: values.gateway_device_eui,
    actor_user_uuid: values.actor_user_uuid,
    base_sync_version: values.base_sync_version,
    operation: values.operation,
    normalized_intent: trustedIntent,
  };
  values.intent_hash = protectedBindingCanonicalization.sha256(trustedIntent);
  values.binding_hash = protectedBindingCanonicalization.sha256(binding);
  if (context.command_type && context.command_type !== type ||
      context.commandType && context.commandType !== type ||
      context.resource && context.resource !== values.resource_type) {
    throw commandError('protected_command_conflict', 'trusted WATERMARK command type or resource conflicts');
  }
  return values;
}

function protectedBindingMatches(row, context) {
  return row && context &&
    row.binding_hash === context.binding_hash &&
    row.intent_hash === context.intent_hash &&
    row.resource_type === context.resource_type &&
    row.resource_id === context.resource_id &&
    row.gateway_device_eui === context.gateway_device_eui &&
    row.actor_user_uuid === context.actor_user_uuid &&
    Number(row.base_sync_version) === context.base_sync_version &&
    row.operation === context.operation;
}

function validNonJournalEffectBinding(envelope, runtime) {
  if (!runtime || runtime.command_type_recognized !== true) return false;
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const effectKey = String(payload.effect_key || payload.effectKey || envelope.effectKey || '').trim();
  const type = commandType(envelope);
  if (isProtectedConfigurationCommand(type)) {
    try {
      protectedContext(envelope, runtime, type);
      return true;
    } catch (_) {
      return false;
    }
  }
  let match = /^irrigation:scheduler:(0|[1-9]\d*):(0|[1-9]\d*):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(effectKey);
  if (match) {
    const zoneId = payload.zone_id == null ? payload.zoneId : payload.zone_id;
    const scheduledFor = new Date(match[3]);
    return Number.isSafeInteger(Number(zoneId)) && String(Number(zoneId)) === match[1] &&
      Number.isFinite(scheduledFor.getTime()) && scheduledFor.toISOString() === match[3];
  }
  match = /^irrigation:manual:([0-9A-F]{16}):(cloud|edge):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(effectKey);
  if (match) {
    const deviceEui = String(payload.device_eui || payload.deviceEui || payload.devEui || '')
      .trim().toUpperCase();
    return deviceEui === match[1];
  }
  match = /^config:([0-9A-F]{16}):([a-z0-9_.-]+):(0|[1-9]\d*)$/.exec(effectKey);
  if (match) {
    const deviceEui = String(payload.device_eui || payload.deviceEui || payload.devEui || '')
      .trim().toUpperCase();
    return deviceEui === match[1];
  }
  if (isZoneCommandType(type)) {
    const zoneUuid = String(payload.zone_uuid || '').trim().toLowerCase();
    const base = payload.base_sync_version;
    const target = payload.target_sync_version;
    const zone = payload.zone;
    const runtimeGateway = String(
      runtime.gateway_device_eui || ''
    ).trim().toUpperCase();
    const payloadGateway = String(
      payload.gateway_device_eui || ''
    ).trim().toUpperCase();
    const zoneGateway = String(
      zone && zone.gateway_device_eui || ''
    ).trim().toUpperCase();
    if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(zoneUuid) ||
        !/^[0-9A-F]{16}$/.test(runtimeGateway) ||
        payloadGateway !== runtimeGateway ||
        zoneGateway !== runtimeGateway ||
        !Number.isSafeInteger(base) ||
        base < 0 ||
        !Number.isSafeInteger(target) ||
        target !== base + 1 ||
        !zone ||
        typeof zone !== 'object' ||
        Array.isArray(zone) ||
        String(zone.zone_uuid || '').trim().toLowerCase() !== zoneUuid ||
        zone.sync_version !== target) {
      return false;
    }
    const prefix = type === 'DELETE_ZONE' ? 'zone_delete' : 'zone';
    return effectKey === prefix + ':' + zoneUuid + ':' + base;
  }
  const scopedBindings = {
    UPSERT_SCOPED_USER: ['scoped_user', payload.user, 'user_uuid'],
    RESET_SCOPED_USER_PASSWORD: ['scoped_user_password', payload, 'user_uuid'],
    UPSERT_USER_ZONE_ASSIGNMENT: [
      'scoped_zone_assignment', payload.zone_assignment, 'assignment_uuid'
    ],
    DELETE_USER_ZONE_ASSIGNMENT: ['scoped_zone_assignment', payload, 'assignment_uuid'],
    UPSERT_USER_PLOT_ASSIGNMENT: [
      'scoped_plot_assignment', payload.plot_assignment, 'assignment_uuid'
    ],
    DELETE_USER_PLOT_ASSIGNMENT: ['scoped_plot_assignment', payload, 'assignment_uuid'],
  };
  const scoped = scopedBindings[commandType(envelope)];
  if (scoped) {
    const resource = scoped[1];
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
    const resourceUuid = String(resource[scoped[2]] || '').trim().toLowerCase();
    const base = resource.base_sync_version;
    return /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resourceUuid) &&
      Number.isSafeInteger(base) && base >= 0 &&
      effectKey === scoped[0] + ':' + resourceUuid + ':' + base;
  }
  return false;
}

function journalEffectProvenanceMatches(row, payload, gatewayDeviceEui, type, intentHash) {
  const facts = parsedResultDetail(row);
  return facts && typeof facts === 'object' && !Array.isArray(facts) &&
    typeof intentHash === 'string' && facts.submittedIntentHash === intentHash &&
    facts.commandType === type &&
    facts.ownerUserUuid === payload.owner_user_uuid &&
    facts.authorPrincipalUuid === payload.author_principal_uuid &&
    facts.authorLabel === (payload.author_label == null ? null : payload.author_label) &&
    facts.gatewayDeviceEui === gatewayDeviceEui &&
    String(row.device_eui || '').trim().toUpperCase() === gatewayDeviceEui;
}

// validEffectBinding(envelope, opts): the generic effect-key/identity binding
// gate shared by every command family. For a type that looks like a journal
// type it defers entirely to opts.extraEffectBindingValidator (osi-journal's
// validJournalEffectBinding, injected by the caller); every other type is
// validated against the built-in irrigation:scheduler / irrigation:manual /
// config: grammar.
async function validEffectBinding(envelope, opts) {
  opts = opts || {};
  const type = commandType(envelope);
  if (isJournalCommandType(type)) {
    if (typeof opts.extraEffectBindingValidator !== 'function') return false;
    return opts.extraEffectBindingValidator(opts.db, envelope, opts, type);
  }
  return validNonJournalEffectBinding(envelope, opts);
}

async function deduplicatePendingCommandInTransaction(tx, envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const deliveryId = deliveryCommandId(envelope);
  const opts = runtime || {};
  return (async function() {
    const type = commandType(envelope);
    const protectedType = isProtectedConfigurationCommand(type);
    const trusted = protectedType ? protectedContext(envelope, opts, type) : null;
    let row = await tx.get(
      'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(deliveryId)]
    );
    if (row) {
      const storedProtected = isProtectedConfigurationCommand(String(row.command_type || '').toUpperCase()) ||
        row.binding_hash != null || row.intent_hash != null;
      if ((storedProtected || protectedType) && (!storedProtected || !protectedType ||
          row.command_type !== type || !trusted ||
          !protectedBindingMatches(row, trusted))) {
        throw commandError('protected_command_conflict', 'WATERMARK command replay binding conflicts with the terminal ledger');
      }
      return { handled: true, ack: await persistReplayAck(tx, row, deliveryId, true) };
    }
    const journalType = isJournalCommandType(type);
    const zoneType = isZoneCommandType(type);
    const validEffect = await validEffectBinding(envelope, Object.assign({}, opts, { db: tx }));
    if (!validEffect) {
      return { handled: false };
    }
    if (!envelope.payload || typeof envelope.payload !== 'object' ||
        Array.isArray(envelope.payload)) {
      return { handled: false };
    }
    const effectKey = String(
      envelope.payload.effect_key || envelope.payload.effectKey || envelope.effectKey || ''
    ).trim();
    const gateway = String(opts.gateway_device_eui || '').trim().toUpperCase();
    if (journalType) {
      const intentHash = typeof opts.extraSubmittedIntentHash === 'function'
        ? opts.extraSubmittedIntentHash(type, envelope.payload)
        : null;
      const candidates = await tx.all(
        'SELECT * FROM applied_commands WHERE effect_key=? AND command_type=? AND device_eui=? ' +
          'ORDER BY applied_at,command_id',
        [effectKey, type, gateway]
      );
      row = candidates.find(function(candidate) {
        return journalEffectProvenanceMatches(candidate, envelope.payload, gateway, type, intentHash);
      });
    } else if (zoneType) {
      const candidates = await tx.all(
        'SELECT * FROM applied_commands WHERE effect_key=? AND command_type=? AND device_eui=? ' +
          'ORDER BY applied_at,command_id',
        [effectKey, type, gateway]
      );
      const intentHash = canonicalIntentHash(envelope.payload);
      row = candidates.find(function(candidate) {
        const facts = parsedResultDetail(candidate);
        return facts && facts.payloadHash === intentHash;
      });
    } else if (protectedType) {
      const candidates = await tx.all(
        'SELECT * FROM applied_commands WHERE effect_key=? AND command_type=? ORDER BY applied_at,command_id',
        [effectKey, type]
      );
      if (candidates.length) {
        row = candidates.find((candidate) => protectedBindingMatches(candidate, trusted));
        if (!row) {
          throw commandError('protected_command_conflict', 'WATERMARK command effect binding conflicts with the terminal ledger');
        }
        const replay = replayAck(row, deliveryId, false);
        await tx.run(
          'INSERT INTO applied_commands (' +
            'command_id,effect_key,device_eui,command_type,result,applied_at,result_detail,originator,' +
            'binding_hash,intent_hash,resource_type,resource_id,gateway_device_eui,actor_user_uuid,base_sync_version,operation' +
          ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING',
          [String(deliveryId), row.effect_key, row.device_eui, row.command_type, row.result,
            new Date().toISOString(), JSON.stringify(replay), 'edge', trusted.binding_hash,
            trusted.intent_hash, trusted.resource_type, trusted.resource_id,
            trusted.gateway_device_eui, trusted.actor_user_uuid, trusted.base_sync_version,
            trusted.operation]
        );
        await persistReplayAck(tx, row, deliveryId, false);
        return { handled: true, ack: replay };
      }
    } else {
      row = await tx.get(
        'SELECT * FROM applied_commands WHERE effect_key=? AND command_type=? ' +
          'ORDER BY applied_at,command_id LIMIT 1',
        [effectKey, type]
      );
    }
    if (!row) return { handled: false };
    return { handled: true, ack: await persistReplayAck(tx, row, deliveryId, false) };
  })();
}

async function deduplicatePendingCommand(db, envelope, runtime) {
  return db.transaction((tx) => deduplicatePendingCommandInTransaction(tx, envelope, runtime));
}

async function withProtectedCommandTransaction(db, envelope, runtime, mutation) {
  if (typeof mutation !== 'function') {
    throw commandError('malformed_command', 'protected command mutation callback is required');
  }
  return db.transaction(async (tx) => {
    const type = commandType(envelope);
    if (!isProtectedConfigurationCommand(type)) {
      throw commandError('malformed_command', 'protected transaction requires a WATERMARK command');
    }
    const context = protectedContext(envelope, runtime || {}, type);
    const duplicate = await deduplicatePendingCommandInTransaction(tx, envelope, runtime || {});
    if (duplicate.handled) return duplicate;
    const scoped = {
      tx,
      get: tx.get && tx.get.bind(tx),
      all: tx.all && tx.all.bind(tx),
      run: tx.run && tx.run.bind(tx),
      exec: tx.exec && tx.exec.bind(tx),
      context,
      terminalAck: (ack) => queueCommandAckInTransaction(tx, Object.assign({
        commandType: type,
        deviceEui: context.resource_id,
        gatewayDeviceEui: context.gateway_device_eui,
        actorUserUuid: context.actor_user_uuid,
        baseSyncVersion: context.base_sync_version,
        operation: context.operation,
        effectKey: envelope.payload.effect_key || envelope.payload.effectKey,
        payload: Object.assign({}, envelope.payload),
      }, ack || {}), Object.assign({}, runtime, { protected_context: context })),
    };
    return mutation(scoped);
  });
}

function classifyAckResult(result, errorText) {
  if (['SUCCESS', 'APPLIED', 'ACKED'].includes(result)) return 'APPLIED';
  if (result === 'EXPIRED') return 'EXPIRED';
  if (['FAILED_RETRYABLE', 'RETRYABLE_ERROR'].includes(result)) return 'FAILED_RETRYABLE';
  if (['REJECTED_PERMANENT', 'NACKED', 'CONFLICT'].includes(result)) return result;
  if (result === 'FAILED') {
    const detail = String(errorText || '').toLowerCase();
    if (detail.includes('invalid') || detail.includes('unsupported') ||
        detail.includes('missing valve deveui') || detail.includes('missing sensor deveui')) {
      return 'REJECTED_PERMANENT';
    }
  }
  return 'FAILED_RETRYABLE';
}

function queueCommandId(raw) {
  const value = raw && raw.commandId;
  if (Number.isSafeInteger(value) && value > 0) return { stored: String(value), ack: value };
  const text = String(value == null ? '' : value).trim();
  if (!text) throw commandError('invalid_command_id', 'Command ACK requires commandId');
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isSafeInteger(numeric) && numeric > 0) return { stored: text, ack: numeric };
  }
  return { stored: text, ack: text };
}

// F93 (2026-09-17): the cloud's CommandAckEntry.commandId is a Long -- a
// command that never came from the cloud (a manual GUI/harness valve action,
// queued through this same pipeline for its local ledger bookkeeping) mints
// its commandId as a UUID on the edge (write-strega-expectation's
// crypto.randomUUID() fallback / the manual-valve command builders), never a
// cloud-issued integer. queueCommandId() already tells the two apart: `.ack`
// is a number only when the raw commandId was itself numeric or an all-digit
// string (i.e. cloud-issued). Silvan's command_ack_outbox row 1 carried a
// UUID commandId, so the cloud answered every delivery attempt with HTTP 400
// (Cannot deserialize a String into java.lang.Long) and
// command-ack-mark-delivered classified every non-2xx as a transport
// failure, retrying the SAME batch every 30s forever and blocking every
// later ack behind it.
function isCloudOriginatedCommandId(queuedCommandId) {
  return typeof queuedCommandId.ack === 'number';
}

async function queueCommandAckInTransaction(tx, rawAck, runtime) {
  const ack = object(rawAck, 'Command ACK');
  const commandId = queueCommandId(ack);
  const cloudOriginated = isCloudOriginatedCommandId(commandId);
  const incomingResult = String(ack.result || ack.status || '').trim().toUpperCase();
  const errorText = ack.error == null ? '' : String(ack.error);
  const result = classifyAckResult(incomingResult, errorText);
  const terminal = ['APPLIED', 'CONFLICT', 'REJECTED_PERMANENT', 'NACKED', 'EXPIRED'].includes(result);
  const appliedAt = String(ack.timestamp || ack.appliedAt || new Date().toISOString());
  const duplicate = ack.duplicate === true || String(ack.duplicate || '').toLowerCase() === 'true';
  const syncVersionCandidate = ack.appliedSyncVersion == null
    ? null
    : Number(ack.appliedSyncVersion);
  const appliedSyncVersion = Number.isSafeInteger(syncVersionCandidate) && syncVersionCandidate >= 0
    ? syncVersionCandidate
    : null;
  const requestedSyncVersionCandidate = ack.requestedSyncVersion == null
    ? ack.requested_sync_version
    : ack.requestedSyncVersion;
  const requestedSyncVersionNumber = Number(requestedSyncVersionCandidate);
  const requestedSyncVersion = Number.isSafeInteger(requestedSyncVersionNumber) && requestedSyncVersionNumber >= 0
    ? requestedSyncVersionNumber
    : appliedSyncVersion;
  const ackType = String(ack.commandType || '').trim().toUpperCase();
  let trusted = null;
  if (terminal && isProtectedConfigurationCommand(ackType)) {
    const suppliedContext = (runtime && (runtime.protected_context || runtime.protectedContext)) || ack.protected_context || {};
    const payload = ack.payload && typeof ack.payload === 'object' ? { ...ack.payload } : {
      effect_key: ack.effectKey || ack.effect_key,
      device_eui: ack.deviceEui || ack.devEui,
      gateway_device_eui: ack.gatewayDeviceEui || ack.gateway_device_eui,
      actor_user_uuid: ack.actorUserUuid || ack.actor_user_uuid,
      base_sync_version: ack.baseSyncVersion == null ? ack.base_sync_version : ack.baseSyncVersion,
      operation: ack.operation,
    };
    trusted = protectedContext({
      commandId: commandId.ack,
      commandType: ackType,
      effectKey: payload.effect_key,
      payload,
      protected_context: suppliedContext,
    }, runtime || {}, ackType);
  }
  const initial = {
    commandId: commandId.ack,
    eventUuid: ack.eventUuid == null ? null : ack.eventUuid,
    aggregateType: ack.aggregateType == null ? null : ack.aggregateType,
    aggregateKey: ack.aggregateKey == null ? null : ack.aggregateKey,
    commandType: String(ack.commandType || '').trim().toUpperCase() || null,
    status: replayStatus(result),
    result,
    appliedAt,
    requestedSyncVersion,
    appliedSyncVersion,
    duplicate,
    reason: errorText || ack.reason || null,
    detail: errorText || ack.reason || null,
  };
  if (terminal) {
      const existing = await tx.get(
        'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
        [commandId.stored]
      );
      if (existing) {
        const storedProtected = isProtectedConfigurationCommand(String(existing.command_type || '').toUpperCase()) ||
          existing.binding_hash != null || existing.intent_hash != null;
        if ((storedProtected || trusted) && (!storedProtected || !trusted ||
            ackType !== String(existing.command_type || '').toUpperCase() ||
            !protectedBindingMatches(existing, trusted))) {
          throw commandError('protected_command_conflict', 'WATERMARK terminal ACK binding conflicts with the terminal ledger');
        }
        // A local commandId never queues a cloud ack (see isCloudOriginatedCommandId
        // above) -- not even on replay. replayAck() is the pure, DB-write-free half of
        // persistReplayAck() and reproduces the exact same returned shape.
        if (!cloudOriginated) return replayAck(existing, commandId.ack, true);
        return persistReplayAck(tx, existing, commandId.ack, true);
      }
      await tx.run(
        'INSERT INTO applied_commands (' +
          'command_id,effect_key,device_eui,command_type,result,applied_at,result_detail,originator,' +
          'binding_hash,intent_hash,resource_type,resource_id,gateway_device_eui,actor_user_uuid,base_sync_version,operation' +
        ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING',
        [commandId.stored, String(ack.effectKey || ack.effect_key || '').trim() || null,
          String(ack.deviceEui || ack.devEui || '').trim().toUpperCase() || 'UNKNOWN',
          String(ack.commandType || '').trim().toUpperCase() || 'UNKNOWN', result, appliedAt,
          JSON.stringify(initial), 'edge', trusted && trusted.binding_hash, trusted && trusted.intent_hash,
          trusted && trusted.resource_type, trusted && trusted.resource_id,
          trusted && trusted.gateway_device_eui, trusted && trusted.actor_user_uuid,
          trusted && trusted.base_sync_version, trusted && trusted.operation]
      );
      const hooks = runtime && runtime.lifecycle_hooks;
      if (hooks && typeof hooks.afterCommandLedger === 'function') {
        await hooks.afterCommandLedger(initial);
      }
  }
  // A local action keeps its local ledger entry (the applied_commands write
    // above, when terminal) but must never produce a command_ack_outbox row:
    // the cloud has no way to accept a delivery whose commandId it cannot
    // parse as a Long, and queueing it anyway is exactly the F93 poison.
    if (!cloudOriginated) return initial;
    await tx.run(
      'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      [commandId.stored]
    );
    await tx.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      [commandId.stored, JSON.stringify(initial), new Date().toISOString()]
    );
  return initial;
}

async function queueCommandAck(db, rawAck, runtime) {
  return db.transaction((tx) => queueCommandAckInTransaction(tx, rawAck, runtime));
}

// Protected semantic validation can fail before protectedContext() has enough
// trusted material to build a binding hash. Persist that terminal conflict or
// permanent rejection without rewriting an existing command row. The durable
// outbox record is still required so the cloud receives the decision.
async function recordProtectedDecision(db, envelope, result, reason) {
  return db.transaction(async (tx) => {
    const type = commandType(envelope);
    if (!isProtectedConfigurationCommand(type)) {
      throw commandError('malformed_command', 'protected decision requires a WATERMARK command');
    }
    const delivery = deliveryCommandId(envelope);
    const payload = envelope && envelope.payload && typeof envelope.payload === 'object'
      ? envelope.payload : {};
    const commandId = delivery;
    const storedId = String(commandId);
    const existing = await tx.get(
      'SELECT command_id FROM applied_commands WHERE command_id=? LIMIT 1',
      [storedId]
    );
    const ack = {
      commandId,
      commandType: type,
      status: result === 'CONFLICT' ? 'CONFLICT' : 'NACKED',
      result,
      reason: reason || (result === 'CONFLICT' ? 'binding_conflict' : 'rejected'),
      detail: reason || (result === 'CONFLICT' ? 'binding_conflict' : 'rejected'),
      appliedSyncVersion: null,
      duplicate: false,
    };
    if (!existing) {
      await tx.run(
        'INSERT INTO applied_commands (' +
          'command_id,effect_key,device_eui,command_type,result,applied_at,result_detail,originator,' +
          'binding_hash,intent_hash,resource_type,resource_id,gateway_device_eui,actor_user_uuid,base_sync_version,operation' +
        ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING',
        [storedId, String(envelope.effectKey || payload.effect_key || payload.effectKey || '').trim() || null,
          String(payload.device_eui || payload.deviceEui || '').trim().toUpperCase() || 'UNKNOWN',
          type, result, new Date().toISOString(), JSON.stringify(ack), 'edge',
          null, null, null, null, null, null, null, null]
      );
    }
    await tx.run('DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL', [storedId]);
    await tx.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      [storedId, JSON.stringify(ack), new Date().toISOString()]
    );
    return { handled: true, ack };
  });
}

module.exports = {
  deduplicatePendingCommand,
  withProtectedCommandTransaction,
  queueCommandAck,
  recordProtectedDecision,
  classifyAckResult,
  validEffectBinding,
};
