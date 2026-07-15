#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

// One-shot input-safety pins. Re-pinned 2026-07-14 against main @0f1361a3 after
// merging main into feat/field-journal-slice1: main's upsert-sync-versioning
// work changed sync-force-build, and main independently added
// UC512_OPEN_FOR_DURATION to the two fallback registries
// (reject-indefinite-open, write-strega-expectation). Every literal
// replaceOnce anchor was verified to still occur exactly once; only these
// safety hashes moved.
const expectedNodeHashes = {
  'sync-pending-split': 'b510b8f16e71eaf951a50c8035bbbaf6c990ed316b6631b59e361a83c53f6ba7',
  'sync-force-build': 'aa51c022a383b31add0926983980d4130ef39c26ab8f63aaf9abb7f0a7e9dbb2',
  'reject-indefinite-open': 'deb15cbe21e59f7b17c3ae11ff05bc9d1ae485a68fe044927fd8ab374cc841c9',
  'command-dedupe-dispatch': 'e6b37170bec7c98adc17cf6423df94f31693642ca7e92897c4aac47d13ec23dd',
  'cmd-type-registry': 'a5237108cf313821e2618a49f0beecab1299e15b4527bcd9ead93e9454aaba45',
  'write-strega-expectation': '73415c5511ca01dd53e1217290e8aeb368a4c55c7087886127c2a5b2213db9b2',
  'command-ack-queue-rest': '6b63484ab0b1b277a4357fc1ced7c5091d083a3966b6237732c7f93e235b06a2',
};

const journalRegistryRows = [
  "    UPSERT_JOURNAL_ENTRY:      { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },",
  "    VOID_JOURNAL_ENTRY:        { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },",
  "    UPSERT_JOURNAL_CUSTOM_VOCAB: { dispatch: 'journal_apply',           actuator: false,   requires_duration: false  },",
  "    UPSERT_JOURNAL_PLOT:       { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },",
  "    UPSERT_JOURNAL_PLOT_GROUP: { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },",
].join('\n');

const replayLoopPrefix = `for (const cmd of commands) {
  const rawPayload = cmd.payload && typeof cmd.payload === 'object' && !Array.isArray(cmd.payload)
    ? cmd.payload
    : {};
  const deliveryCommandId = cmd.commandId !== undefined && cmd.commandId !== null
    ? cmd.commandId
    : cmd.command_id;
  const trustedCommandType = String(cmd.commandType || cmd.command_type || '').trim().toUpperCase();
  const trustedEffectKey = cmd.effectKey || cmd.effect_key || rawPayload.effectKey || rawPayload.effect_key || null;
  const merged = Object.assign({}, rawPayload, {
    commandId: deliveryCommandId,
    commandType: trustedCommandType,
    command_type: trustedCommandType,
    eventUuid: cmd.eventUuid,
    aggregateType: cmd.aggregateType,
    aggregateKey: cmd.aggregateKey,
    appliedSyncVersion: cmd.appliedSyncVersion,
    leaseGrantedAt: cmd.leaseGrantedAt,
    leaseExpiresAt: cmd.leaseExpiresAt,
    leasedToGateway: cmd.leasedToGateway,
    effectKey: trustedEffectKey,
    _pendingCommandEnvelope: {
      commandId: deliveryCommandId,
      commandType: trustedCommandType,
      effectKey: trustedEffectKey,
      payload: rawPayload
    }
  });
  if (merged.command_id == null) merged.command_id = deliveryCommandId;`;

const forceQueueBefore = "          queuedCommands.push({ payload: Object.assign({ commandId: cmd.commandId, commandType: cmd.commandType, eventUuid: cmd.eventUuid, aggregateType: cmd.aggregateType, aggregateKey: cmd.aggregateKey, appliedSyncVersion: cmd.appliedSyncVersion, leaseGrantedAt: cmd.leaseGrantedAt, leaseExpiresAt: cmd.leaseExpiresAt, leasedToGateway: cmd.leasedToGateway, effectKey: cmd.effectKey || cmd.effect_key || (cmd.payload || {}).effectKey || (cmd.payload || {}).effect_key || null }, cmd.payload || {}) });";
const forceQueueAfter = `          const rawPayload = cmd.payload && typeof cmd.payload === 'object' && !Array.isArray(cmd.payload)
            ? cmd.payload
            : {};
          const deliveryCommandId = cmd.commandId !== undefined && cmd.commandId !== null
            ? cmd.commandId
            : cmd.command_id;
          const trustedCommandType = String(cmd.commandType || cmd.command_type || '').trim().toUpperCase();
          const trustedEffectKey = cmd.effectKey || cmd.effect_key || rawPayload.effectKey || rawPayload.effect_key || null;
          const flattened = Object.assign({}, rawPayload, {
            commandId: deliveryCommandId,
            commandType: trustedCommandType,
            command_type: trustedCommandType,
            eventUuid: cmd.eventUuid,
            aggregateType: cmd.aggregateType,
            aggregateKey: cmd.aggregateKey,
            appliedSyncVersion: cmd.appliedSyncVersion,
            leaseGrantedAt: cmd.leaseGrantedAt,
            leaseExpiresAt: cmd.leaseExpiresAt,
            leasedToGateway: cmd.leasedToGateway,
            effectKey: trustedEffectKey,
            _pendingCommandEnvelope: {
              commandId: deliveryCommandId,
              commandType: trustedCommandType,
              effectKey: trustedEffectKey,
              payload: rawPayload
            }
          });
          if (flattened.command_id == null) flattened.command_id = deliveryCommandId;
          queuedCommands.push({ payload: flattened });`;

const legacyDedupeSource = `return (async () => {
  const cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object') {
    node.error('Pending command has no protected delivery envelope', msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await osiCommandLedger.deduplicatePendingCommand(db, envelope, {
      gateway_device_eui: gatewayEui,
      command_type_recognized: msg._commandTypeRecognized === true,
      extraEffectBindingValidator: osiJournal.validJournalEffectBinding,
      extraSubmittedIntentHash: osiJournal.submittedIntentHash
    });
    if (!result.handled) return [msg, null];
    node.status({ fill: 'blue', shape: 'ring', text: 'duplicate command ' + String(result.ack.commandId) });
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Command dedupe failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Command dedupe DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const dedupeSource = `return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('Pending command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('Pending command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  if (!commandType) {
    node.error('Pending command has no protected delivery command type', msg);
    return [null, null];
  }
  const journalType = /(?:^|_)JOURNAL(?:_|$)/.test(commandType);
  const dbLoad = osiLib.require('osi-db-helper');
  const commandLedgerLoad = osiLib.require('osi-command-ledger');
  if (!dbLoad.ok || !commandLedgerLoad.ok) {
    const detail = [dbLoad, commandLedgerLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Command helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const osiDb = dbLoad.value;
  const osiCommandLedger = commandLedgerLoad.value;
  const runtime = {
    gateway_device_eui: String(env.get('DEVICE_EUI') || '').trim().toUpperCase(),
    command_type_recognized: msg._commandTypeRecognized === true
  };
  if (journalType) {
    const journalLoad = osiLib.require('osi-journal');
    if (journalLoad.ok) {
      runtime.extraEffectBindingValidator = journalLoad.value.validJournalEffectBinding;
      runtime.extraSubmittedIntentHash = journalLoad.value.submittedIntentHash;
    } else {
      node.warn('Journal dedupe hooks unavailable: ' + String(journalLoad.error || 'unknown loader error'));
    }
  }
  const gatewayEui = runtime.gateway_device_eui;
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await osiCommandLedger.deduplicatePendingCommand(db, envelope, runtime);
    if (!result.handled) return [msg, null];
    node.status({ fill: 'blue', shape: 'ring', text: 'duplicate command ' + String(result.ack.commandId) });
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Command dedupe failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Command dedupe DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const legacyJournalApplySource = `return (async () => {
  const cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object') {
    node.error('Journal command has no protected delivery envelope', msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await osiJournal.applyJournalCommand(db, envelope, {
      gateway_device_eui: gatewayEui
    });
    if (!result.handled) return [msg, null];
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Journal command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Journal command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const journalApplySource = `return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('Journal command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('Journal command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  if (!commandType) {
    node.error('Journal command has no protected delivery command type', msg);
    return [null, null];
  }
  const journalType = /(?:^|_)JOURNAL(?:_|$)/.test(commandType);
  if (!journalType) return [msg, null];
  const dbLoad = osiLib.require('osi-db-helper');
  const journalLoad = osiLib.require('osi-journal');
  if (!dbLoad.ok || !journalLoad.ok) {
    const detail = [dbLoad, journalLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Journal helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const osiDb = dbLoad.value;
  const osiJournal = journalLoad.value;
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await osiJournal.applyJournalCommand(db, envelope, {
      gateway_device_eui: gatewayEui
    });
    if (!result.handled) return [msg, null];
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Journal command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Journal command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const priorCurrentDedupeSource = `return (async () => {
  const dbLoad = osiLib.require('osi-db-helper');
  const journalLoad = osiLib.require('osi-journal');
  const commandLedgerLoad = osiLib.require('osi-command-ledger');
  if (!dbLoad.ok || !journalLoad.ok || !commandLedgerLoad.ok) {
    const detail = [dbLoad, journalLoad, commandLedgerLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Journal helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const osiDb = dbLoad.value;
  const osiJournal = journalLoad.value;
  const osiCommandLedger = commandLedgerLoad.value;
  const cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object') {
    node.error('Pending command has no protected delivery envelope', msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await osiCommandLedger.deduplicatePendingCommand(db, envelope, {
      gateway_device_eui: gatewayEui,
      command_type_recognized: msg._commandTypeRecognized === true,
      extraEffectBindingValidator: osiJournal.validJournalEffectBinding,
      extraSubmittedIntentHash: osiJournal.submittedIntentHash
    });
    if (!result.handled) return [msg, null];
    node.status({ fill: 'blue', shape: 'ring', text: 'duplicate command ' + String(result.ack.commandId) });
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Command dedupe failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Command dedupe DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const priorCurrentJournalApplySource = `return (async () => {
  const dbLoad = osiLib.require('osi-db-helper');
  const journalLoad = osiLib.require('osi-journal');
  if (!dbLoad.ok || !journalLoad.ok) {
    const detail = [dbLoad, journalLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Journal helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const osiDb = dbLoad.value;
  const osiJournal = journalLoad.value;
  const cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object') {
    node.error('Journal command has no protected delivery envelope', msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await osiJournal.applyJournalCommand(db, envelope, {
      gateway_device_eui: gatewayEui
    });
    if (!result.handled) return [msg, null];
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Journal command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Journal command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const legacyQueueAckSource = `return (async () => {
  let ack;
  try {
    ack = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.warn('Command ACK payload parse failed: ' + String(parseError && parseError.message ? parseError.message : parseError));
    return null;
  }
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const queued = await osiCommandLedger.queueCommandAck(db, ack);
    msg.payload = JSON.stringify(queued);
    return msg;
  } catch (error) {
    node.error('Failed to queue durable command ACK: ' + String(error && error.message ? error.message : error), msg);
    return null;
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Command ACK queue DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const queueAckSource = `return (async () => {
  const dbLoad = osiLib.require('osi-db-helper');
  const commandLedgerLoad = osiLib.require('osi-command-ledger');
  if (!dbLoad.ok || !commandLedgerLoad.ok) {
    const detail = [dbLoad, commandLedgerLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Journal helpers unavailable: ' + detail, msg);
    return null;
  }
  const osiDb = dbLoad.value;
  const osiCommandLedger = commandLedgerLoad.value;
  let ack;
  try {
    ack = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.warn('Command ACK payload parse failed: ' + String(parseError && parseError.message ? parseError.message : parseError));
    return null;
  }
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const queued = await osiCommandLedger.queueCommandAck(db, ack);
    msg.payload = JSON.stringify(queued);
    return msg;
  } catch (error) {
    node.error('Failed to queue durable command ACK: ' + String(error && error.message ? error.message : error), msg);
    return null;
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Command ACK queue DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

const osiLibOnly = [{ var: 'osiLib', module: 'osi-lib' }];
const legacyDedupeLibs = [
  { var: 'osiDb', module: 'osi-db-helper' },
  { var: 'osiJournal', module: 'osi-journal' },
  { var: 'osiCommandLedger', module: 'osi-command-ledger' },
];
const legacyApplyLibs = [
  { var: 'osiDb', module: 'osi-db-helper' },
  { var: 'osiJournal', module: 'osi-journal' },
];
const legacyQueueLibs = [
  { var: 'osiDb', module: 'osi-db-helper' },
  { var: 'osiCommandLedger', module: 'osi-command-ledger' },
];
const LEGACY_COMMAND_SURFACES = {
  'command-dedupe-dispatch': { func: legacyDedupeSource, libs: legacyDedupeLibs },
  'journal-command-apply-fn': { func: legacyJournalApplySource, libs: legacyApplyLibs },
  'command-ack-queue-rest': { func: legacyQueueAckSource, libs: legacyQueueLibs },
};
const PRIOR_CURRENT_COMMAND_SURFACES = Object.freeze({
  'command-dedupe-dispatch': Object.freeze({ func: priorCurrentDedupeSource, libs: osiLibOnly }),
  'journal-command-apply-fn': Object.freeze({ func: priorCurrentJournalApplySource, libs: osiLibOnly }),
  'command-ack-queue-rest': Object.freeze({ func: queueAckSource, libs: osiLibOnly }),
});
const expectedCommandShapeHashes = {
  'command-dedupe-dispatch': 'cac813cf50ef6a3527e5e205ceb4330d4cf18cca15c79c89a86c4f63d867c609',
  'journal-command-apply-fn': 'ede833ad182c0a3056d2ed1420b407c513e1f14d6ca24c72f55ee0c0c9b41de3',
  'command-ack-queue-rest': '28368a33749674b0bc1036143c42f98dea5ea10535c437735175e83cc670650e',
};

function digest(node) {
  return crypto.createHash('sha256').update(JSON.stringify(node)).digest('hex');
}

function commandShapeDigest(node) {
  if (!node) return null;
  const shape = Object.assign({}, node);
  delete shape.func;
  delete shape.libs;
  return digest(shape);
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('Expected exactly one ' + label + ' replacement seam');
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function exposeEmptyCatches(source, label) {
  return source.replace(/catch\s*\(([^)]+)\)\s*\{\s*\}/g, function(_match, binding) {
    const variable = String(binding).trim();
    return "catch (" + variable + ") { node.warn('" + label + ": ' + String(" + variable +
      " && " + variable + ".message ? " + variable + ".message : " + variable + ")); }";
  });
}

function assertUnique(flows) {
  const ids = new Set();
  for (const node of flows) {
    if (!node.id) continue;
    if (ids.has(node.id)) throw new Error('Duplicate flow node id: ' + node.id);
    ids.add(node.id);
  }
}

function same(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function commandScaffoldingIsCurrent(byId) {
  const handler = byId.get('journal-command-apply-fn');
  return !!handler && Object.entries(expectedCommandShapeHashes).every(([id, expected]) =>
    commandShapeDigest(byId.get(id)) === expected) &&
    byId.get('sync-pending-split').func.includes('_pendingCommandEnvelope') &&
    !byId.get('sync-pending-split').func.includes('cmd.command_type || rawPayload.command_type') &&
    byId.get('sync-force-build').func.includes('_pendingCommandEnvelope') &&
    !byId.get('sync-force-build').func.includes('cmd.command_type || rawPayload.command_type') &&
    byId.get('cmd-type-registry').func.includes('UPSERT_JOURNAL_PLOT_GROUP:') &&
    byId.get('reject-indefinite-open').func.includes('UC512_OPEN_FOR_DURATION:') &&
    byId.get('write-strega-expectation').func.includes('UC512_OPEN_FOR_DURATION:');
}

function isCurrent(byId) {
  if (!commandScaffoldingIsCurrent(byId)) return false;
  const handler = byId.get('journal-command-apply-fn');
  const dedupe = byId.get('command-dedupe-dispatch');
  const queue = byId.get('command-ack-queue-rest');
  return handler.func === journalApplySource && same(handler.libs, osiLibOnly) &&
    dedupe.func === dedupeSource && same(dedupe.libs, osiLibOnly) &&
    queue.func === queueAckSource && same(queue.libs, osiLibOnly);
}

function isLegacyDirectHelperState(byId) {
  if (!commandScaffoldingIsCurrent(byId)) return false;
  const handler = byId.get('journal-command-apply-fn');
  const dedupe = byId.get('command-dedupe-dispatch');
  const queue = byId.get('command-ack-queue-rest');
  return handler.func === legacyJournalApplySource && same(handler.libs, legacyApplyLibs) &&
    dedupe.func === legacyDedupeSource && same(dedupe.libs, legacyDedupeLibs) &&
    queue.func === legacyQueueAckSource && same(queue.libs, legacyQueueLibs);
}

function isPriorCurrentState(byId) {
  if (!commandScaffoldingIsCurrent(byId)) return false;
  return Object.entries(PRIOR_CURRENT_COMMAND_SURFACES).every(([id, surface]) => {
    const node = byId.get(id);
    return !!node && node.func === surface.func && same(node.libs, surface.libs);
  });
}

function addCommandRows(source, marker, includeUc512) {
  const rows = (includeUc512
    ? "    UC512_OPEN_FOR_DURATION:   { dispatch: 'uc512_timed_open',         actuator: true,    requires_duration: true  },\n"
    : '') + journalRegistryRows;
  return replaceOnce(source, marker, marker + '\n' + rows, 'command registry rows');
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  assertUnique(flows);
  const byId = new Map(flows.filter((node) => node.id).map((node) => [node.id, node]));
  if (isCurrent(byId)) return buffer;
  if (byId.has('journal-command-apply-fn')) {
    if (!isLegacyDirectHelperState(byId) && !isPriorCurrentState(byId)) {
      throw new Error('Refusing non-exact journal command handler collision');
    }
    const handler = byId.get('journal-command-apply-fn');
    const dedupe = byId.get('command-dedupe-dispatch');
    const queue = byId.get('command-ack-queue-rest');
    handler.func = journalApplySource;
    handler.libs = osiLibOnly;
    dedupe.func = dedupeSource;
    dedupe.libs = osiLibOnly;
    queue.func = queueAckSource;
    queue.libs = osiLibOnly;
    return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
  }
  for (const [id, expected] of Object.entries(expectedNodeHashes)) {
    const node = byId.get(id);
    if (!node || digest(node) !== expected) {
      throw new Error('Refusing drifted Task 11 flow node: ' + id);
    }
  }

  const replay = byId.get('sync-pending-split');
  const loopStart = replay.func.indexOf('for (const cmd of commands) {');
  const commandTypeLine = "  const commandType = String(merged.command_type || merged.commandType || merged.action || '').trim().toUpperCase();";
  const loopEnd = replay.func.indexOf(commandTypeLine, loopStart);
  if (loopStart < 0 || loopEnd < 0) throw new Error('Replay Pending Commands merge seam is missing');
  replay.func = replay.func.slice(0, loopStart) + replayLoopPrefix + '\n' + replay.func.slice(loopEnd);

  const force = byId.get('sync-force-build');
  force.func = replaceOnce(force.func, forceQueueBefore, forceQueueAfter, 'force-sync command queue');
  force.func = exposeEmptyCatches(force.func, 'Force-sync optional operation failed');

  const registry = byId.get('cmd-type-registry');
  const registryMarker = "    SET_KIWI_INTERVAL:         { dispatch: 'kiwi_config',               actuator: false,   requires_duration: false  },";
  registry.func = addCommandRows(registry.func, registryMarker, false);

  for (const id of ['reject-indefinite-open', 'write-strega-expectation']) {
    const node = byId.get(id);
    const fallbackMarker = "    SET_KIWI_INTERVAL:         { dispatch: 'kiwi_config',               actuator: false,   requires_duration: false  },";
    // Main added UC512_OPEN_FOR_DURATION to these fallback registries after
    // this script was written; only insert it where it is still missing so a
    // re-application onto main never duplicates the row.
    node.func = addCommandRows(node.func, fallbackMarker, !node.func.includes('UC512_OPEN_FOR_DURATION'));
    node.func = exposeEmptyCatches(node.func, id + ' ignored operation failed');
  }
  const guard = byId.get('reject-indefinite-open');
  guard.func = replaceOnce(
    guard.func,
    "if (!entry) {\n    node.warn({ rejected: 'unknown_command_type', command_type: cmd.command_type, command_id: cmd.command_id || cmd.commandId });\n    return null;\n}",
    "if (!entry) {\n    if (/(?:^|_)JOURNAL(?:_|$)/.test(cmd.command_type)) return msg;\n    node.warn({ rejected: 'unknown_command_type', command_type: cmd.command_type, command_id: cmd.command_id || cmd.commandId });\n    return null;\n}\nmsg._commandTypeRecognized = true;",
    'unknown journal guard'
  );

  const dedupe = byId.get('command-dedupe-dispatch');
  dedupe.func = dedupeSource;
  dedupe.libs = osiLibOnly;
  dedupe.wires = [['journal-command-apply-fn'], ['9d5e3035c3d069c4']];

  const queue = byId.get('command-ack-queue-rest');
  queue.func = queueAckSource;
  queue.libs = osiLibOnly;

  flows.push({
    id: 'journal-command-apply-fn',
    type: 'function',
    z: dedupe.z,
    name: 'Apply Journal Command',
    func: journalApplySource,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: osiLibOnly,
    x: 1470,
    y: 1060,
    wires: [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']],
  });
  assertUnique(flows);
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function run() {
  const before = flowPaths.map((file) => fs.readFileSync(file));
  if (!before[0].equals(before[1])) throw new Error('Maintained flows are not byte-identical before migration');
  for (let index = 0; index < before.length; index += 1) {
    const roundTrip = Buffer.from(JSON.stringify(JSON.parse(before[index].toString('utf8')), null, 2) + '\n');
    if (!before[index].equals(roundTrip)) throw new Error('Flow input is not a byte-stable JSON round-trip');
  }
  const after = migrate(before[0]);
  if (!after.equals(migrate(after))) throw new Error('Task 11 flow migration is not idempotent');
  if (after.equals(before[0])) {
    process.stdout.write('migrate-flows-journal-commands: already current\n');
    return;
  }
  for (const file of flowPaths) fs.writeFileSync(file, after);
  if (!fs.readFileSync(flowPaths[0]).equals(fs.readFileSync(flowPaths[1]))) {
    throw new Error('Maintained flows lost byte parity after migration');
  }
  process.stdout.write('migrate-flows-journal-commands: applied exact Task 11 command path\n');
}

if (require.main === module) run();

module.exports = {
  LEGACY_COMMAND_SURFACES,
  PRIOR_CURRENT_COMMAND_SURFACES,
  migrate,
};
