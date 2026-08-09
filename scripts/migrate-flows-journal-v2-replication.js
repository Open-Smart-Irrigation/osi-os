#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
);
const MIRROR = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
);
const SCHEMA_FINGERPRINT = crypto.createHash('sha256').update(fs.readFileSync(path.join(
  ROOT,
  'docs/contracts/sync-schema/journal-v2.schema.json',
))).digest('hex');
const PRIOR_WORKER_SHA256 = 'cc3f55c7212b2d0a7ea3c5f0d058978f9902a6166d161de8713990ac51042918';

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function parseExact(buffer, label) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (!serialize(parsed).equals(buffer)) {
    throw new Error(label + ': no-op roundtrip is not byte-identical; refusing mutation');
  }
  return parsed;
}

const WORKER_SOURCE = `return (async () => {
const helperLoad = osiLib.require('journal-replication');
if (!helperLoad.ok) {
  node.error('Journal V2 replication helper unavailable: ' + helperLoad.error, msg);
  return null;
}
const replication = helperLoad.value;
const fs = global.get('fs');
if (!fs) {
  node.error('Journal V2 replication fs global is unavailable', msg);
  return null;
}
const identityStatePath = '/var/run/osi-identity-restart.json';
let identityBlock = null;
try {
  if (fs.existsSync(identityStatePath)) {
    JSON.parse(fs.readFileSync(identityStatePath, 'utf8'));
    identityBlock = 'gateway identity restart is pending';
  }
} catch (cause) {
  identityBlock = 'gateway identity restart state is unreadable: ' +
    String(cause && cause.message ? cause.message : cause);
}
if (identityBlock) {
  node.warn('Journal V2 replication blocked: ' + identityBlock);
  return null;
}
const db = new osiDb.Database('/data/db/farming.db');
const q = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (cause, rows) => cause ? reject(cause) : resolve(rows || [])));
const close = () => new Promise((resolve) => db.close((cause) => {
  if (cause) node.warn('Journal V2 replication DB close failed: ' + String(cause.message || cause));
  resolve();
}));
try {
  const gatewayDeviceEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const linked = await q("SELECT server_url,server_sync_token FROM users WHERE auth_mode='server' AND server_url IS NOT NULL AND server_sync_token IS NOT NULL ORDER BY server_linked_at DESC,id DESC LIMIT 1", []);
  if (linked.length !== 1 || !gatewayDeviceEui) {
    node.warn('Journal V2 replication waiting for a linked cloud account and stable gateway identity');
    return null;
  }
  const result = await replication.runReplicationTick(db, {
    requestJsonIpv4: osiCloudHttp.requestJsonIpv4
  }, fs, {
    gateway_device_eui: gatewayDeviceEui,
    server_url: linked[0].server_url,
    sync_token: linked[0].server_sync_token,
    release_id: String(env.get('FIRMWARE_VERSION') || 'unknown'),
    schema_fingerprint: '${SCHEMA_FINGERPRINT}',
    photo_cache_bytes: env.get('JOURNAL_PHOTO_CACHE_BYTES'),
    min_free_bytes: env.get('JOURNAL_MIN_FREE_BYTES'),
    media_root: env.get('JOURNAL_MEDIA_ROOT')
  });
  msg.payload = result;
  return msg;
} catch (cause) {
  const detail = String(cause && cause.message ? cause.message : cause);
  if (cause && cause.retryable) {
    node.warn('Journal V2 replication transient retry: ' + detail);
    return null;
  }
  node.error('Journal V2 replication rejected malformed authority or envelope data: ' + detail, msg);
  return null;
} finally {
  await close();
}
})();`;

const EXPECTED_NODES = [
  {
    id: 'journal-v2-replication-tab',
    type: 'tab',
    label: 'Journal V2 Replication',
    disabled: false,
    info: '',
    env: [],
  },
  {
    id: 'journal-v2-replication-tick',
    type: 'inject',
    z: 'journal-v2-replication-tab',
    name: 'Journal V2 replication tick',
    props: [{ p: 'payload' }],
    repeat: '30',
    crontab: '',
    once: true,
    onceDelay: 15,
    topic: '',
    payload: '',
    payloadType: 'date',
    x: 180,
    y: 120,
    wires: [['journal-v2-replication-worker']],
  },
  {
    id: 'journal-v2-replication-worker',
    type: 'function',
    z: 'journal-v2-replication-tab',
    name: 'Journal V2 replication worker',
    func: WORKER_SOURCE,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [
      { var: 'osiLib', module: 'osi-lib' },
      { var: 'osiDb', module: 'osi-db-helper' },
      { var: 'osiCloudHttp', module: 'osi-cloud-http' },
    ],
    x: 440,
    y: 120,
    wires: [['journal-v2-replication-success-status']],
  },
  {
    id: 'journal-v2-replication-success-status',
    type: 'function',
    z: 'journal-v2-replication-tab',
    name: 'Journal V2 replication success',
    func: "node.status({fill:'green',shape:'dot',text:'replication committed'});\nreturn null;",
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 730,
    y: 120,
    wires: [[]],
  },
  {
    id: 'journal-v2-replication-error-catch',
    type: 'catch',
    z: 'journal-v2-replication-tab',
    name: 'Journal V2 replication errors',
    scope: ['journal-v2-replication-worker'],
    uncaught: false,
    x: 190,
    y: 200,
    wires: [['journal-v2-replication-error-status']],
  },
  {
    id: 'journal-v2-replication-error-status',
    type: 'function',
    z: 'journal-v2-replication-tab',
    name: 'Journal V2 replication error status',
    func: "const detail = String(msg && msg.error && msg.error.message ? msg.error.message : 'replication failed');\nnode.status({fill:'red',shape:'ring',text:detail.slice(0,48)});\nnode.warn('Journal V2 replication error path: ' + detail);\nreturn null;",
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 470,
    y: 200,
    wires: [[]],
  },
];

function migrate(buffer) {
  const flows = parseExact(buffer, 'flows.json');
  const expectedById = new Map(EXPECTED_NODES.map((node) => [node.id, node]));
  const present = flows.filter((node) => expectedById.has(node.id));
  if (present.length > 0) {
    if (present.length !== EXPECTED_NODES.length) {
      throw new Error('Refusing partial Journal V2 replication node collision');
    }
    let priorWorkerIndex = -1;
    for (const node of present) {
      const expected = expectedById.get(node.id);
      if (JSON.stringify(node) === JSON.stringify(expected)) continue;
      const upgraded = Object.assign({}, node, { func: expected.func });
      const priorWorker = node.id === 'journal-v2-replication-worker' &&
        crypto.createHash('sha256').update(String(node.func || '')).digest('hex') ===
          PRIOR_WORKER_SHA256 &&
        JSON.stringify(upgraded) === JSON.stringify(expected);
      if (!priorWorker) {
        throw new Error('Refusing non-exact Journal V2 replication node collision: ' + node.id);
      }
      priorWorkerIndex = flows.indexOf(node);
    }
    if (priorWorkerIndex >= 0) {
      flows[priorWorkerIndex] = expectedById.get('journal-v2-replication-worker');
      return serialize(flows);
    }
    return buffer;
  }
  flows.push(...EXPECTED_NODES);
  return serialize(flows);
}

function main() {
  const canonical = fs.readFileSync(CANONICAL);
  const mirror = fs.readFileSync(MIRROR);
  parseExact(canonical, CANONICAL);
  parseExact(mirror, MIRROR);
  if (!canonical.equals(mirror)) throw new Error('Maintained flow profiles differ before migration');
  const output = migrate(canonical);
  fs.writeFileSync(CANONICAL, output);
  fs.writeFileSync(MIRROR, output);
  parseExact(fs.readFileSync(CANONICAL), CANONICAL);
  parseExact(fs.readFileSync(MIRROR), MIRROR);
  process.stdout.write(output.equals(canonical)
    ? 'migrate-flows-journal-v2-replication: already current\n'
    : 'migrate-flows-journal-v2-replication: applied\n');
}

if (require.main === module) main();

module.exports = {
  EXPECTED_NODES,
  PRIOR_WORKER_SHA256,
  SCHEMA_FINGERPRINT,
  WORKER_SOURCE,
  migrate,
};
