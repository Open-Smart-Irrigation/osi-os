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
const expectedHashes = {
  'cmd-type-registry': '1e0a812ac1e849b3e6411f9856879d9fc2d9bba3175381a9d66b0d62b92aa347',
  'reject-indefinite-open': 'c5c420cc05e55f58a0d4bbe19237f3a88fda5d3811fc40680b8b0d21739564e7',
  'write-strega-expectation': 'b04dfce7c2aa08b375bfe417cb37fdc5a1ea5c4978e7041d303172275314e5cb',
  'journal-command-apply-fn': 'ec1c31e4be6a2d4336fdf31b0564915fad30ed337dfdf4e1de2fea5d4ff1802b',
};
const marker =
  "    UPSERT_JOURNAL_PLOT_GROUP: { dispatch: 'journal_apply',             actuator: false,   requires_duration: false  },";
const rows = [
  "    UPSERT_SCOPED_USER:        { dispatch: 'scoped_access_apply',       actuator: false,   requires_duration: false  },",
  "    RESET_SCOPED_USER_PASSWORD: { dispatch: 'scoped_access_apply',      actuator: false,   requires_duration: false  },",
  "    UPSERT_USER_ZONE_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },",
  "    DELETE_USER_ZONE_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },",
  "    UPSERT_USER_PLOT_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },",
  "    DELETE_USER_PLOT_ASSIGNMENT: { dispatch: 'scoped_access_apply',     actuator: false,   requires_duration: false  },",
].join('\n');

const source = `return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('Scoped access command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('Scoped access command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  const scopedTypes = new Set([
    'UPSERT_SCOPED_USER',
    'RESET_SCOPED_USER_PASSWORD',
    'UPSERT_USER_ZONE_ASSIGNMENT',
    'DELETE_USER_ZONE_ASSIGNMENT',
    'UPSERT_USER_PLOT_ASSIGNMENT',
    'DELETE_USER_PLOT_ASSIGNMENT'
  ]);
  if (!scopedTypes.has(commandType)) return [msg, null];
  const dbLoad = osiLib.require('osi-db-helper');
  const accessLoad = osiLib.require('scoped-access-commands');
  const scopeLoad = osiLib.require('scope');
  if (!dbLoad.ok || !accessLoad.ok || !scopeLoad.ok) {
    const detail = [dbLoad, accessLoad, scopeLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Scoped access command helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new dbLoad.value.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await accessLoad.value.applyScopedAccessCommand(db, envelope, {
      gateway_device_eui: gatewayEui,
      command_type_recognized: msg._commandTypeRecognized === true,
      scope_helper: scopeLoad.value
    });
    if (!result.handled) return [msg, null];
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Scoped access command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Scoped access command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

function digest(node) {
  return crypto.createHash('sha256').update(JSON.stringify(node)).digest('hex');
}

function current(byId) {
  const node = byId.get('scoped-access-command-apply-fn');
  return !!node &&
    node.func === source &&
    JSON.stringify(node.libs) === JSON.stringify([{ var: 'osiLib', module: 'osi-lib' }]) &&
    JSON.stringify(node.wires) === JSON.stringify([['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']]) &&
    JSON.stringify(byId.get('journal-command-apply-fn').wires) ===
      JSON.stringify([['934bf2bc19a8ce22'], ['scoped-access-command-apply-fn']]) &&
    ['cmd-type-registry', 'reject-indefinite-open', 'write-strega-expectation']
      .every((id) => byId.get(id).func.includes('UPSERT_SCOPED_USER:'));
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  const byId = new Map(flows.filter((node) => node.id).map((node) => [node.id, node]));
  if (current(byId)) return buffer;
  if (byId.has('scoped-access-command-apply-fn')) {
    throw new Error('Refusing non-exact scoped access command node collision');
  }
  for (const [id, expected] of Object.entries(expectedHashes)) {
    const node = byId.get(id);
    if (!node || digest(node) !== expected) {
      throw new Error('Refusing drifted scoped access flow node: ' + id);
    }
  }
  for (const id of ['cmd-type-registry', 'reject-indefinite-open', 'write-strega-expectation']) {
    const node = byId.get(id);
    const first = node.func.indexOf(marker);
    if (first < 0 || node.func.indexOf(marker, first + marker.length) >= 0) {
      throw new Error('Expected one scoped access registry seam in ' + id);
    }
    node.func = node.func.slice(0, first) + marker + '\n' + rows +
      node.func.slice(first + marker.length);
  }
  byId.get('journal-command-apply-fn').wires =
    [['934bf2bc19a8ce22'], ['scoped-access-command-apply-fn']];
  flows.push({
    id: 'scoped-access-command-apply-fn',
    type: 'function',
    z: byId.get('journal-command-apply-fn').z,
    name: 'Apply Scoped Access Command',
    func: source,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [{ var: 'osiLib', module: 'osi-lib' }],
    x: 1720,
    y: 1100,
    wires: [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']],
  });
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n');
}

function run() {
  const before = flowPaths.map((file) => fs.readFileSync(file));
  if (!before[0].equals(before[1])) {
    throw new Error('Maintained flows are not byte-identical before migration');
  }
  const after = migrate(before[0]);
  if (!after.equals(migrate(after))) {
    throw new Error('Scoped access flow migration is not idempotent');
  }
  if (after.equals(before[0])) {
    process.stdout.write('migrate-flows-scoped-access-commands: already current\n');
    return;
  }
  for (const file of flowPaths) fs.writeFileSync(file, after);
  process.stdout.write('migrate-flows-scoped-access-commands: applied\n');
}

if (require.main === module) run();

module.exports = { migrate };
