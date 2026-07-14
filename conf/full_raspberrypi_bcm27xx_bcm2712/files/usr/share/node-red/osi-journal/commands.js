'use strict';

const { loadCatalog } = require('./catalog');
const lifecycle = require('./lifecycle');
const journalApi = require('./api');
const { aggregateHash } = require('./aggregate');
const ledger = require('../osi-command-ledger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

function trustedPrincipal(db, payload, runtime, type, deliveryId, intentHash) {
  const owner = payload.owner_user_uuid;
  const actor = payload.author_principal_uuid;
  const label = payload.author_label;
  const gateway = String(runtime && runtime.gateway_device_eui || '').trim().toUpperCase();
  if (!UUID.test(owner || '') || !UUID.test(actor || '') ||
      (label != null && (typeof label !== 'string' || Array.from(label).length > 120)) ||
      !EUI64.test(gateway)) {
    throw commandError('invalid_identity', 'Trusted journal command identity is malformed');
  }
  return db.get('SELECT id,user_uuid FROM users WHERE user_uuid=? LIMIT 1', [owner])
    .then(function(user) {
      if (!user) throw commandError('invalid_identity', 'Journal command owner is not linked on this edge');
      return {
        user_id: Number(user.id),
        owner_user_uuid: owner,
        author_principal_uuid: actor,
        author_label: label == null ? null : label,
        gateway_device_eui: gateway,
        origin: 'cloud-ui',
        command_id: String(deliveryId),
        delivery_command_id: deliveryId,
        command_type: type,
        effect_key: payload.effect_key,
        submitted_intent_hash: intentHash,
        lifecycle_hooks: runtime && runtime.lifecycle_hooks,
      };
    });
}

function localOccurrence(raw, timezone, expectedOffset, field) {
  if (typeof raw !== 'string' || !UTC_MILLISECONDS.test(raw)) {
    throw commandError('malformed_command', field + ' must be canonical UTC milliseconds');
  }
  const instant = new Date(raw);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== raw) {
    throw commandError('malformed_command', field + ' is not a real UTC instant');
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      calendar: 'iso8601',
      numberingSystem: 'latn',
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (cause) {
    const error = commandError('invalid_timezone', 'Journal occurrence timezone is unsupported');
    error.cause = cause;
    throw error;
  }
  const parts = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const wallEpoch = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
    instant.getUTCMilliseconds()
  );
  const offsetMinutes = Math.round((wallEpoch - instant.getTime()) / 60000);
  if (expectedOffset != null && expectedOffset !== offsetMinutes) {
    throw commandError('invalid_utc_offset', 'Journal occurrence offset does not match timezone and instant');
  }
  return {
    local: parts.year + '-' + parts.month + '-' + parts.day + 'T' +
      parts.hour + ':' + parts.minute + ':' + parts.second + '.' +
      String(instant.getUTCMilliseconds()).padStart(3, '0'),
    offset_minutes: offsetMinutes,
  };
}

function entryInput(payload, principal) {
  const entry = object(payload.entry, 'entry');
  if (entry.owner_user_uuid !== principal.owner_user_uuid ||
      entry.author_principal_uuid !== principal.author_principal_uuid ||
      entry.author_label !== principal.author_label ||
      entry.gateway_device_eui !== principal.gateway_device_eui) {
    throw commandError('invalid_identity', 'Journal entry identity does not match trusted command metadata');
  }
  if (entry.status !== 'final') {
    throw commandError('validation_failed', 'Cloud journal entry commands must be final');
  }
  lifecycle.assertJournalEntryEffectKey(
    payload.effect_key,
    entry.entry_uuid,
    Number(entry.base_sync_version) + 1
  );
  const start = localOccurrence(
    entry.occurred_start,
    entry.occurred_timezone,
    entry.occurred_utc_offset_minutes,
    'occurred_start'
  );
  const end = entry.occurred_end == null
    ? null
    : localOccurrence(entry.occurred_end, entry.occurred_timezone, null, 'occurred_end');
  return {
    entry_uuid: entry.entry_uuid,
    base_sync_version: entry.base_sync_version,
    activity_code: entry.activity_code,
    template_code: entry.template_code,
    template_version: entry.template_version,
    layout_code: entry.layout_code,
    layout_version: entry.layout_version,
    plot_uuid: entry.plot_uuid,
    device_eui: entry.device_eui,
    campaign_uuid: entry.campaign_uuid,
    protocol_code: entry.protocol_code,
    protocol_version: entry.protocol_version,
    observation_unit_code: entry.observation_unit_code,
    pass_uuid: entry.pass_uuid,
    batch_uuid: entry.batch_uuid,
    occurred_start_local: start.local,
    occurred_end_local: end && end.local,
    occurred_timezone: entry.occurred_timezone,
    occurred_utc_offset_minutes: start.offset_minutes,
    occurred_end_utc_offset_minutes: end && end.offset_minutes,
    season_crop: entry.season_crop,
    season_variety: entry.season_variety,
    note: entry.note,
    values: entry.values,
    duplicate_guard_ack_entry_uuid: payload.duplicate_guard_ack_entry_uuid,
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertDuplicateGuardControl(type, payload) {
  const present = hasOwn(payload, 'duplicate_guard_ack_entry_uuid');
  if (!present) return;
  if (type !== 'UPSERT_JOURNAL_ENTRY' ||
      !UUID.test(payload.duplicate_guard_ack_entry_uuid || '')) {
    throw commandError(
      'malformed_command',
      'duplicate_guard_ack_entry_uuid is valid only for journal entry upserts'
    );
  }
}

function submittedIntent(type, payload) {
  const intent = {
    command_type: type,
    owner_user_uuid: payload.owner_user_uuid,
    author_principal_uuid: payload.author_principal_uuid,
    author_label: payload.author_label == null ? null : payload.author_label,
  };
  if (type === 'UPSERT_JOURNAL_ENTRY') intent.entry = payload.entry;
  else if (type === 'VOID_JOURNAL_ENTRY') {
    intent.void_entry = {
      entry_uuid: payload.entry_uuid,
      base_sync_version: payload.base_sync_version,
      reason: payload.reason,
    };
  } else if (type === 'UPSERT_JOURNAL_CUSTOM_VOCAB') {
    intent.custom_vocab = payload.custom_vocab;
  } else if (type === 'UPSERT_JOURNAL_PLOT') intent.plot = payload.plot;
  else if (type === 'UPSERT_JOURNAL_PLOT_GROUP') intent.plot_group = payload.plot_group;
  else return null;
  if (hasOwn(payload, 'duplicate_guard_ack_entry_uuid')) {
    intent.duplicate_guard_ack_entry_uuid = payload.duplicate_guard_ack_entry_uuid;
  }
  return intent;
}

function submittedIntentHash(type, payload) {
  try {
    const intent = submittedIntent(type, payload);
    return intent ? aggregateHash(intent) : null;
  } catch (_) {
    return null;
  }
}

function assertResourceBinding(payload, principal, resource, keyField, prefix) {
  resource = object(resource, keyField.replace('_uuid', ''));
  if (resource.owner_user_uuid !== principal.owner_user_uuid ||
      resource.gateway_device_eui !== principal.gateway_device_eui) {
    throw commandError('invalid_identity', 'Journal resource identity does not match trusted command metadata');
  }
  const key = resource[keyField];
  const baseVersion = resource.base_sync_version;
  if (!UUID.test(key || '') || !Number.isInteger(baseVersion) || baseVersion < 0 ||
      payload.effect_key !== prefix + ':' + key + ':' + baseVersion) {
    throw commandError('invalid_effect_key', 'Command effect key does not match the journal resource');
  }
  return resource;
}

function vocabInput(payload, principal) {
  const source = assertResourceBinding(
    payload,
    principal,
    payload.custom_vocab,
    'custom_field_uuid',
    'journal_vocab'
  );
  return {
    custom_field_uuid: source.custom_field_uuid,
    base_sync_version: source.base_sync_version,
    code: source.code,
    kind: source.kind,
    parent_code: source.parent_code,
    value_type: source.value_type,
    quantity_kind: source.quantity_kind,
    basis: source.basis,
    default_unit_code: source.default_unit_code,
    labels_json: source.labels_json,
    icon_key: source.icon_key,
    constraints_json: source.constraints_json,
    agrovoc_uri: source.agrovoc_uri,
    icasa_code: source.icasa_code,
    adapt_code: source.adapt_code,
    active: source.active,
    sort_order: source.sort_order,
    mappings: source.mappings,
  };
}

function plotInput(payload, principal) {
  const source = assertResourceBinding(
    payload,
    principal,
    payload.plot,
    'plot_uuid',
    'journal_plot'
  );
  const settings = object(source.settings, 'plot.settings');
  return {
    plot_uuid: source.plot_uuid,
    base_sync_version: source.base_sync_version,
    plot_code: source.plot_code,
    name: source.name,
    zone_uuid: source.zone_uuid,
    station_code: source.station_code,
    crop_hint: source.crop_hint,
    area_m2: source.area_m2,
    active: source.active,
    layout_code: settings.layout_code,
  };
}

function plotGroupInput(payload, principal) {
  const source = assertResourceBinding(
    payload,
    principal,
    payload.plot_group,
    'group_uuid',
    'journal_plot_group'
  );
  return {
    group_uuid: source.group_uuid,
    base_sync_version: source.base_sync_version,
    label: source.label,
    resolved: source.resolved_at != null,
    members: source.members,
  };
}

async function persistedAck(db, deliveryId) {
  const ackRow = await db.get(
    'SELECT payload_json FROM command_ack_outbox WHERE command_id=? ORDER BY id DESC LIMIT 1',
    [String(deliveryId)]
  );
  if (!ackRow) throw commandError('ack_persistence_failed', 'Journal command ACK was not persisted');
  return JSON.parse(ackRow.payload_json);
}

function resourceReference(type, payload) {
  if (type === 'UPSERT_JOURNAL_ENTRY') {
    return { aggregate_type: 'JOURNAL_ENTRY', key: payload.entry && payload.entry.entry_uuid,
      table: 'journal_entries', key_column: 'entry_uuid' };
  }
  if (type === 'VOID_JOURNAL_ENTRY') {
    return { aggregate_type: 'JOURNAL_ENTRY', key: payload.entry_uuid,
      table: 'journal_entries', key_column: 'entry_uuid' };
  }
  if (type === 'UPSERT_JOURNAL_CUSTOM_VOCAB') {
    return { aggregate_type: 'JOURNAL_VOCAB',
      key: payload.custom_vocab && payload.custom_vocab.custom_field_uuid,
      table: 'journal_vocab', key_column: 'custom_field_uuid' };
  }
  if (type === 'UPSERT_JOURNAL_PLOT') {
    return { aggregate_type: 'JOURNAL_PLOT', key: payload.plot && payload.plot.plot_uuid,
      table: 'journal_plots', key_column: 'plot_uuid' };
  }
  return { aggregate_type: 'JOURNAL_PLOT_GROUP',
    key: payload.plot_group && payload.plot_group.group_uuid,
    table: 'journal_plot_groups', key_column: 'group_uuid' };
}

async function currentResourceFacts(db, type, payload, owner, gateway) {
  const reference = resourceReference(type, payload);
  if (!UUID.test(reference.key || '') || !UUID.test(owner || '') || !EUI64.test(gateway || '')) {
    return { currentSyncVersion: null, currentPayloadHash: null };
  }
  const aggregate = await journalApi.loadCurrentAggregate(db, type, reference.key, {
    owner_user_uuid: owner,
    gateway_device_eui: gateway,
  });
  if (!aggregate) return { currentSyncVersion: null, currentPayloadHash: null };
  return {
    currentSyncVersion: Number(aggregate.sync_version),
    currentPayloadHash: aggregateHash(aggregate),
  };
}

function classification(error, type, payload) {
  const code = String(error && error.code || '').trim();
  if (code === 'parent_not_found' || code === 'missing_custom_dependency' ||
      code === 'stale_catalog' || code === 'invalid_catalog' ||
      /^SQLITE_(?:BUSY|LOCKED|IOERR|FULL|CANTOPEN|PROTOCOL)/.test(code)) {
    return { result: 'FAILED_RETRYABLE', terminal: false, reason: code || 'transient_failure' };
  }
  if (code && !/^SQLITE_/.test(code)) {
    const failure = { result: 'REJECTED_PERMANENT', terminal: true, reason: code };
    const candidate = error && error.details && error.details.duplicateCandidate;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      failure.duplicateCandidate = {
        entryUuid: candidate.entryUuid,
        occurredStart: candidate.occurredStart,
        activityCode: candidate.activityCode,
        plotUuid: candidate.plotUuid,
      };
    }
    return failure;
  }
  return null;
}

// replayStatus/parsedResultDetail/replayAck/journalEffectProvenanceMatches and
// the generic dedupe/ACK pipeline now live in osi-command-ledger (they fail
// closed for every command family, not just journal commands). This module
// keeps only the journal-specific effect-key binding rule below, injected
// into the ledger through deduplicatePendingCommand's opts hook.
async function validJournalEffectBinding(db, envelope, runtime, type) {
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.command_type !== type || !UUID.test(payload.command_id || '') ||
      !UUID.test(payload.owner_user_uuid || '') ||
      !UUID.test(payload.author_principal_uuid || '') ||
      (payload.author_label != null &&
        (typeof payload.author_label !== 'string' || Array.from(payload.author_label).length > 120))) {
    return false;
  }
  try {
    assertDuplicateGuardControl(type, payload);
  } catch (_) {
    return false;
  }
  const gateway = String(runtime && runtime.gateway_device_eui || '').trim().toUpperCase();
  if (!EUI64.test(gateway)) return false;
  const user = await db.get(
    'SELECT 1 AS linked FROM users WHERE user_uuid=? LIMIT 1',
    [payload.owner_user_uuid]
  );
  if (!user) return false;
  let resource;
  let key;
  let baseVersion;
  let prefix;
  if (type === 'UPSERT_JOURNAL_ENTRY') {
    resource = payload.entry;
    key = resource && resource.entry_uuid;
    baseVersion = resource && resource.base_sync_version;
    prefix = 'journal_entry';
    if (!resource || resource.owner_user_uuid !== payload.owner_user_uuid ||
        resource.author_principal_uuid !== payload.author_principal_uuid ||
        resource.author_label !== payload.author_label ||
        resource.gateway_device_eui !== gateway) return false;
  } else if (type === 'VOID_JOURNAL_ENTRY') {
    key = payload.entry_uuid;
    baseVersion = payload.base_sync_version;
    prefix = 'journal_entry';
  } else if (type === 'UPSERT_JOURNAL_CUSTOM_VOCAB') {
    resource = payload.custom_vocab;
    key = resource && resource.custom_field_uuid;
    baseVersion = resource && resource.base_sync_version;
    prefix = 'journal_vocab';
  } else if (type === 'UPSERT_JOURNAL_PLOT') {
    resource = payload.plot;
    key = resource && resource.plot_uuid;
    baseVersion = resource && resource.base_sync_version;
    prefix = 'journal_plot';
  } else if (type === 'UPSERT_JOURNAL_PLOT_GROUP') {
    resource = payload.plot_group;
    key = resource && resource.group_uuid;
    baseVersion = resource && resource.base_sync_version;
    prefix = 'journal_plot_group';
  } else {
    return false;
  }
  if (resource && type !== 'UPSERT_JOURNAL_ENTRY' &&
      (resource.owner_user_uuid !== payload.owner_user_uuid ||
        resource.gateway_device_eui !== gateway)) return false;
  return UUID.test(key || '') && Number.isInteger(baseVersion) && baseVersion >= 0 &&
    payload.effect_key === prefix + ':' + key + ':' + baseVersion;
}

// Thin, signature-identical wrappers over osi-command-ledger's generic
// pipeline. They inject the two pieces of journal-specific knowledge the
// ledger cannot have on its own: the identity/effect-key binding rule above,
// and the intent-hash used to recognize a "compatible effect" duplicate
// arriving under a different delivery command_id. Existing callers of
// osiJournal.deduplicatePendingCommand/queueCommandAck (flows.json's journal
// applier node, scripts/test-journal-command-path.js) keep working unchanged.
function deduplicatePendingCommand(db, envelope, runtime) {
  return ledger.deduplicatePendingCommand(db, envelope, Object.assign({}, runtime, {
    extraEffectBindingValidator: validJournalEffectBinding,
    extraSubmittedIntentHash: submittedIntentHash,
  }));
}

function queueCommandAck(db, rawAck, runtime) {
  return ledger.queueCommandAck(db, rawAck, runtime);
}

async function persistFailure(db, envelope, payload, runtime, type, deliveryId, failure, intentHash) {
  const gateway = String(runtime && runtime.gateway_device_eui || '').trim().toUpperCase();
  const owner = typeof payload.owner_user_uuid === 'string' ? payload.owner_user_uuid : null;
  const current = await currentResourceFacts(db, type, payload, owner, gateway);
  const appliedAt = new Date().toISOString();
  const facts = {
    commandType: type,
    effectKey: typeof payload.effect_key === 'string' ? payload.effect_key : null,
    payloadHash: null,
    submittedIntentHash: intentHash || submittedIntentHash(type, payload),
    currentSyncVersion: current.currentSyncVersion,
    currentPayloadHash: current.currentPayloadHash,
    gatewayDeviceEui: EUI64.test(gateway) ? gateway : null,
    appliedAt,
    reason: failure.reason,
  };
  if (UUID.test(owner || '')) {
    facts.ownerUserUuid = owner;
    facts.authorPrincipalUuid = UUID.test(payload.author_principal_uuid || '')
      ? payload.author_principal_uuid
      : null;
    facts.authorLabel = payload.author_label == null ? null : payload.author_label;
  }
  if (failure.duplicateCandidate) facts.duplicateCandidate = failure.duplicateCandidate;
  const ack = Object.assign({
    commandId: deliveryId,
    status: failure.terminal ? 'NACKED' : 'FAILED_RETRYABLE',
    result: failure.result,
    appliedSyncVersion: current.currentSyncVersion,
    duplicate: false,
  }, facts);
  await db.transaction(async function(tx) {
    if (failure.terminal) {
      await tx.run(
        'INSERT INTO applied_commands (' +
          'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
        ') VALUES (?,?,?,?,?,?,?,?)',
        [String(deliveryId), EUI64.test(gateway) ? gateway : 'UNKNOWN', type,
          facts.effectKey, appliedAt, failure.result, JSON.stringify(ack), 'edge']
      );
      const hooks = runtime && runtime.lifecycle_hooks;
      if (hooks && typeof hooks.afterCommandLedger === 'function') {
        await hooks.afterCommandLedger(facts);
      }
    }
    await tx.run(
      'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      [String(deliveryId)]
    );
    await tx.run(
      'INSERT INTO command_ack_outbox (command_id,payload_json,created_at) VALUES (?,?,?)',
      [String(deliveryId), JSON.stringify(ack), appliedAt]
    );
  });
  return { handled: true, ack };
}

let journalApplyTail = Promise.resolve();

function enqueueJournalApply(work) {
  const scheduled = journalApplyTail.then(work, work);
  journalApplyTail = scheduled.then(function() {}, function() {});
  return scheduled;
}

async function applyJournalCommandOnce(db, envelope, runtime, recheckReplay) {
  envelope = object(envelope, 'Pending command envelope');
  const type = commandType(envelope);
  const supported = new Set([
    'UPSERT_JOURNAL_ENTRY',
    'VOID_JOURNAL_ENTRY',
    'UPSERT_JOURNAL_CUSTOM_VOCAB',
    'UPSERT_JOURNAL_PLOT',
    'UPSERT_JOURNAL_PLOT_GROUP',
  ]);
  const deliveryId = deliveryCommandId(envelope);
  if (recheckReplay) {
    const replay = await deduplicatePendingCommand(db, envelope, runtime);
    if (replay.handled) return replay;
  }
  if (!supported.has(type)) {
    if (!isJournalCommandType(type)) return { handled: false };
    const unsupportedPayload = envelope.payload && typeof envelope.payload === 'object' &&
      !Array.isArray(envelope.payload) ? envelope.payload : {};
    return persistFailure(db, envelope, unsupportedPayload, runtime, type, deliveryId, {
      result: 'REJECTED_PERMANENT',
      terminal: true,
      reason: 'unsupported_command_type',
    }, submittedIntentHash(type, unsupportedPayload));
  }
  let payload = envelope.payload;
  let intentHash = null;
  try {
    payload = object(payload, 'Pending command payload');
    if (payload.command_type !== type) {
      throw commandError('invalid_command_type', 'Payload command type does not match the trusted envelope');
    }
    if (!UUID.test(payload.command_id || '')) {
      throw commandError('malformed_command', 'Logical command_id must be a canonical UUID');
    }
    assertDuplicateGuardControl(type, payload);
    intentHash = submittedIntentHash(type, payload);
    const principal = await trustedPrincipal(db, payload, runtime, type, deliveryId, intentHash);
    if (type === 'UPSERT_JOURNAL_ENTRY') {
      const catalog = await loadCatalog(db, principal);
      await lifecycle.finalize(db, catalog, entryInput(payload, principal), principal);
    } else if (type === 'VOID_JOURNAL_ENTRY') {
      if (!UUID.test(payload.entry_uuid || '') || !Number.isInteger(payload.base_sync_version) ||
          payload.base_sync_version < 0) {
        throw commandError('malformed_command', 'Void target and base version are malformed');
      }
      lifecycle.assertJournalEntryEffectKey(
        payload.effect_key,
        payload.entry_uuid,
        payload.base_sync_version + 1
      );
      await lifecycle.void_(
        db,
        null,
        payload.entry_uuid,
        payload.base_sync_version,
        payload.reason,
        principal
      );
    } else if (type === 'UPSERT_JOURNAL_CUSTOM_VOCAB') {
      await journalApi.upsertCustomVocab(db, vocabInput(payload, principal), principal, null);
    } else if (type === 'UPSERT_JOURNAL_PLOT') {
      await journalApi.upsertPlot(db, plotInput(payload, principal), principal, null);
    } else {
      await journalApi.upsertPlotGroup(db, plotGroupInput(payload, principal), principal, null);
    }
    return { handled: true, ack: await persistedAck(db, deliveryId) };
  } catch (error) {
    const failure = classification(error, type, payload && typeof payload === 'object' ? payload : {});
    if (!failure) throw error;
    return persistFailure(
      db,
      envelope,
      payload && typeof payload === 'object' ? payload : {},
      runtime,
      type,
      deliveryId,
      failure,
      intentHash
    );
  }
}

async function applyJournalCommand(db, envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const type = commandType(envelope);
  if (!isJournalCommandType(type)) {
    return applyJournalCommandOnce(db, envelope, runtime, false);
  }
  return enqueueJournalApply(function() {
    return applyJournalCommandOnce(db, envelope, runtime, true);
  });
}

module.exports = {
  applyJournalCommand,
  deduplicatePendingCommand,
  queueCommandAck,
  validJournalEffectBinding,
  submittedIntentHash,
};
