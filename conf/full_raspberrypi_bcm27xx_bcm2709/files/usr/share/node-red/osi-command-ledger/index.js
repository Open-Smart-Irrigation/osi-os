'use strict';
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function replayStatus(result) {
  if (result === 'APPLIED') return 'ACKED';
  if (result === 'FAILED_RETRYABLE') return 'FAILED_RETRYABLE';
  return 'NACKED';
}

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

function validNonJournalEffectBinding(envelope, runtime) {
  if (!runtime || runtime.command_type_recognized !== true) return false;
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const effectKey = String(payload.effect_key || payload.effectKey || envelope.effectKey || '').trim();
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

async function deduplicatePendingCommand(db, envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const deliveryId = deliveryCommandId(envelope);
  const opts = runtime || {};
  return db.transaction(async function(tx) {
    let row = await tx.get(
      'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(deliveryId)]
    );
    if (row) {
      return { handled: true, ack: await persistReplayAck(tx, row, deliveryId, true) };
    }
    const type = commandType(envelope);
    const journalType = isJournalCommandType(type);
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
    } else {
      row = await tx.get(
        'SELECT * FROM applied_commands WHERE effect_key=? AND command_type=? ' +
          'ORDER BY applied_at,command_id LIMIT 1',
        [effectKey, type]
      );
    }
    if (!row) return { handled: false };
    return { handled: true, ack: await persistReplayAck(tx, row, deliveryId, false) };
  });
}

function classifyAckResult(result, errorText) {
  if (['SUCCESS', 'APPLIED', 'ACKED'].includes(result)) return 'APPLIED';
  if (result === 'EXPIRED') return 'EXPIRED';
  if (['FAILED_RETRYABLE', 'RETRYABLE_ERROR'].includes(result)) return 'FAILED_RETRYABLE';
  if (['REJECTED_PERMANENT', 'NACKED'].includes(result)) return result;
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

async function queueCommandAck(db, rawAck, runtime) {
  const ack = object(rawAck, 'Command ACK');
  const commandId = queueCommandId(ack);
  const incomingResult = String(ack.result || ack.status || '').trim().toUpperCase();
  const errorText = ack.error == null ? '' : String(ack.error);
  const result = classifyAckResult(incomingResult, errorText);
  const terminal = ['APPLIED', 'REJECTED_PERMANENT', 'NACKED', 'EXPIRED'].includes(result);
  const appliedAt = String(ack.timestamp || ack.appliedAt || new Date().toISOString());
  const duplicate = ack.duplicate === true || String(ack.duplicate || '').toLowerCase() === 'true';
  const syncVersionCandidate = ack.appliedSyncVersion == null
    ? null
    : Number(ack.appliedSyncVersion);
  const appliedSyncVersion = Number.isSafeInteger(syncVersionCandidate) && syncVersionCandidate >= 0
    ? syncVersionCandidate
    : null;
  const initial = {
    commandId: commandId.ack,
    status: replayStatus(result),
    result,
    appliedAt,
    appliedSyncVersion,
    duplicate,
    reason: errorText || ack.reason || null,
    detail: errorText || ack.reason || null,
  };
  return db.transaction(async function(tx) {
    if (terminal) {
      const existing = await tx.get(
        'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
        [commandId.stored]
      );
      if (existing) return persistReplayAck(tx, existing, commandId.ack, true);
      await tx.run(
        'INSERT INTO applied_commands (' +
          'command_id,effect_key,device_eui,command_type,result,applied_at,result_detail,originator' +
        ') VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING',
        [commandId.stored, String(ack.effectKey || ack.effect_key || '').trim() || null,
          String(ack.deviceEui || ack.devEui || '').trim().toUpperCase() || 'UNKNOWN',
          String(ack.commandType || '').trim().toUpperCase() || 'UNKNOWN', result, appliedAt,
          JSON.stringify(initial), 'edge']
      );
      const hooks = runtime && runtime.lifecycle_hooks;
      if (hooks && typeof hooks.afterCommandLedger === 'function') {
        await hooks.afterCommandLedger(initial);
      }
    }
    await tx.run(
      'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      [commandId.stored]
    );
    await tx.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      [commandId.stored, JSON.stringify(initial), new Date().toISOString()]
    );
    return initial;
  });
}

module.exports = {
  deduplicatePendingCommand,
  queueCommandAck,
  classifyAckResult,
  validEffectBinding,
};
