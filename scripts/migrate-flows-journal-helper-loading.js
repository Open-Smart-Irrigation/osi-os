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
const osiLibOnly = [{ var: 'osiLib', module: 'osi-lib' }];

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

const priorApiRouterSource = `const dbLoad = osiLib.require('osi-db-helper');
const journalLoad = osiLib.require('osi-journal');
if (!dbLoad.ok || !journalLoad.ok) {
  const detail = [dbLoad, journalLoad]
    .filter(function(load) { return !load.ok; })
    .map(function(load) { return load.error; })
    .join('; ');
  node.error('Journal helpers unavailable: ' + detail, msg);
  msg.statusCode = 503;
  msg.payload = { error: 'journal_helpers_unavailable', message: detail };
  return msg;
}
const osiDb = dbLoad.value;
const osiJournal = journalLoad.value;
return osiJournal.handleHttpRequest({
  msg: msg,
  Database: osiDb.Database,
  environment: {
    authTokenSecret: env.get('AUTH_TOKEN_SECRET'),
    jwtSecret: env.get('JWT_SECRET'),
    deviceEui: env.get('DEVICE_EUI'),
    deviceEuiConfidence: env.get('DEVICE_EUI_CONFIDENCE'),
    deviceEuiSource: env.get('DEVICE_EUI_SOURCE'),
    edgeBuildVersion: env.get('FIRMWARE_VERSION'),
    edgeBuildCommit: env.get('FIRMWARE_COMMIT')
  },
  warn: function(message) { node.warn(message); }
});`;

const apiRouterSource = `const dbLoad = osiLib.require('osi-db-helper');
const journalLoad = osiLib.require('osi-journal');
const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
const scopeLoad = scopedOn ? osiLib.require('scope') : { ok: true, value: null };
if (!dbLoad.ok || !journalLoad.ok || !scopeLoad.ok) {
  const detail = [dbLoad, journalLoad, scopeLoad]
    .filter(function(load) { return !load.ok; })
    .map(function(load) { return load.error; })
    .join('; ');
  node.error('Journal helpers unavailable: ' + detail, msg);
  msg.statusCode = 503;
  msg.payload = { error: 'journal_helpers_unavailable', message: detail };
  return msg;
}
const osiDb = dbLoad.value;
const osiJournal = journalLoad.value;
return osiJournal.handleHttpRequest({
  msg: msg,
  Database: osiDb.Database,
  scope: scopeLoad.value,
  scopedMode: scopedOn,
  environment: {
    authTokenSecret: env.get('AUTH_TOKEN_SECRET'),
    jwtSecret: env.get('JWT_SECRET'),
    deviceEui: env.get('DEVICE_EUI'),
    deviceEuiConfidence: env.get('DEVICE_EUI_CONFIDENCE'),
    deviceEuiSource: env.get('DEVICE_EUI_SOURCE'),
    edgeBuildVersion: env.get('FIRMWARE_VERSION'),
    edgeBuildCommit: env.get('FIRMWARE_COMMIT')
  },
  warn: function(message) { node.warn(message); }
});`;

const PRIOR_CURRENT_HELPER_SURFACES = Object.freeze({
  'command-dedupe-dispatch': Object.freeze({ func: priorCurrentDedupeSource, libs: osiLibOnly }),
  'journal-command-apply-fn': Object.freeze({ func: priorCurrentJournalApplySource, libs: osiLibOnly }),
  'command-ack-queue-rest': Object.freeze({ func: queueAckSource, libs: osiLibOnly }),
  'journal-api-router-fn': Object.freeze({ func: priorApiRouterSource, libs: osiLibOnly }),
});

const targetSpecs = {
  'command-dedupe-dispatch': {
    beforeNodeHash: '014ce95de868e0cdfc61db295367117d09845ab1e5afd434fb590f3e4735ab06',
    shapeHash: 'cac813cf50ef6a3527e5e205ceb4330d4cf18cca15c79c89a86c4f63d867c609',
    func: dedupeSource,
  },
  'journal-command-apply-fn': {
    beforeNodeHash: '83043a6cc693904174353bc5f78b5044e6ed07b3507580723a650565a527bc62',
    shapeHash: '18e8af185bc218be8edfad11b1d7ef8a299c4509639151c6ab536b540744d967',
    func: journalApplySource,
  },
  'command-ack-queue-rest': {
    beforeNodeHash: '93319e04a5bdb1089690d817dd276f71d3dd3f523374a92f805a486e19632944',
    shapeHash: '28368a33749674b0bc1036143c42f98dea5ea10535c437735175e83cc670650e',
    func: queueAckSource,
  },
  'journal-api-router-fn': {
    beforeNodeHash: '1c2ab56183bb8147a07cc7a4228b1bb0052669b2a7b0dbb973b5747d3321c643',
    shapeHash: 'c0c2501a49b3ede32a2ee037fa57d00aad96f70abc34d09d6a0afa2d5323f53a',
    func: apiRouterSource,
  },
};

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function shapeDigest(node) {
  const shape = Object.assign({}, node);
  delete shape.func;
  delete shape.libs;
  return digest(shape);
}

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
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

function isCurrentNode(node, spec) {
  return !!node && shapeDigest(node) === spec.shapeHash &&
    node.func === spec.func && same(node.libs, osiLibOnly);
}

function matchesPriorCurrentNode(node, id, spec) {
  const prior = PRIOR_CURRENT_HELPER_SURFACES[id];
  return !!node && !!prior && shapeDigest(node) === spec.shapeHash &&
    node.func === prior.func && same(node.libs, prior.libs);
}

function assertOnlyTargetChanges(before, after) {
  if (before.length !== after.length) throw new Error('Helper loading migration changed the flow node count');
  for (let index = 0; index < before.length; index += 1) {
    const oldNode = before[index];
    const newNode = after[index];
    if (!targetSpecs[oldNode.id]) {
      if (!same(oldNode, newNode)) throw new Error('Unexpected non-target flow change: ' + String(oldNode.id));
      continue;
    }
    if (oldNode.id !== newNode.id || shapeDigest(oldNode) !== shapeDigest(newNode)) {
      throw new Error('Helper loading migration changed non-source fields: ' + oldNode.id);
    }
  }
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  assertUnique(flows);
  const byId = new Map(flows.filter((node) => node.id).map((node) => [node.id, node]));
  const entries = Object.entries(targetSpecs);
  if (entries.every(([id, spec]) => isCurrentNode(byId.get(id), spec))) return buffer;

  const exactPriorCurrent = entries.every(([id, spec]) =>
    matchesPriorCurrentNode(byId.get(id), id, spec));
  const exactDirectHelper = entries.every(([id, spec]) => {
    const node = byId.get(id);
    return !!node && digest(node) === spec.beforeNodeHash;
  });
  if (!exactPriorCurrent && !exactDirectHelper) {
    throw new Error('Refusing drifted Task 9 helper-loading node set');
  }

  const before = JSON.parse(buffer.toString('utf8'));
  for (const [id, spec] of entries) {
    const node = byId.get(id);
    node.func = spec.func;
    node.libs = osiLibOnly;
  }
  assertOnlyTargetChanges(before, flows);
  for (const id of ['journal-command-apply-fn', 'journal-api-router-fn']) {
    if (Buffer.byteLength(byId.get(id).func, 'utf8') > 4096) {
      throw new Error('New journal flow node exceeds fixed 4096-character ceiling: ' + id);
    }
  }
  return serialize(flows);
}

function run() {
  const before = flowPaths.map((file) => fs.readFileSync(file));
  if (!before[0].equals(before[1])) throw new Error('Maintained flows are not byte-identical before migration');
  for (let index = 0; index < before.length; index += 1) {
    const roundTrip = serialize(JSON.parse(before[index].toString('utf8')));
    if (!before[index].equals(roundTrip)) {
      throw new Error('Maintained flow input is not a byte-stable JSON round-trip: ' + flowPaths[index]);
    }
  }

  const after = migrate(before[0]);
  if (!after.equals(migrate(after))) throw new Error('Journal helper-loading migration is not idempotent');
  if (!after.equals(serialize(JSON.parse(after.toString('utf8'))))) {
    throw new Error('Journal helper-loading output is not a byte-stable JSON round-trip');
  }
  if (after.equals(before[0])) {
    process.stdout.write('migrate-flows-journal-helper-loading: already current\n');
    return;
  }
  for (const file of flowPaths) fs.writeFileSync(file, after);
  if (!fs.readFileSync(flowPaths[0]).equals(fs.readFileSync(flowPaths[1]))) {
    throw new Error('Maintained flows lost byte parity after helper-loading migration');
  }
  for (const file of flowPaths) {
    const written = fs.readFileSync(file);
    if (!written.equals(serialize(JSON.parse(written.toString('utf8'))))) {
      throw new Error('Written flow lost byte-stable JSON formatting: ' + file);
    }
  }
  process.stdout.write('migrate-flows-journal-helper-loading: applied exact four-node helper loading\n');
}

if (require.main === module) run();

module.exports = {
  PRIOR_CURRENT_HELPER_SURFACES,
  migrate,
};
