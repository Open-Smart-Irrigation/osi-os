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

const nodeContracts = {
  'sync-bootstrap-build': {
    name: 'Build Cloud Bootstrap',
    type: 'function',
    preimageHash: 'a3dbfcc3563d882d6361c71b66ed3e17c02416e5d733061a6d5932a30bf6bd17',
    interimHash: 'e056e443c8db79322885b959b279477fb2f1f2a05c6514f71b1760d2342b2ec2',
    installedHash: '18cca753bf2afdc9ef85755b5a8dbab6b0227a130b4258dd78178e0c46d3c790',
  },
  'sync-force-build': {
    name: 'Run Force Sync',
    type: 'function',
    preimageHash: 'f3295a898438486f78c44815bc1f7b44e51884884b2eac37f9f27858cf71d50e',
    interimHash: '6f4b9482c457f136c4b60ed9363f4b6151d3e465bc9beb5de775cd0d1d1042be',
    installedHash: '6e1227eeac183740504ea7ea4effdb0f21993801a065702b5789c927982bfe61',
  },
  'history-api-router-fn': {
    name: 'History API Router',
    type: 'function',
    preimageHash: '16c728a66b472c961c9d0ef9001d3a1966c3a91c4c4e533fb7d7db5b8ba49c01',
    interimHash: '52b51062e2b85e2081ba976f78623eef4f93deab295e3467f611654a3248b001',
    installedHash: 'b12ad483f807672f6fbef6040b3e44eb612fb778fe00e6059a8ae0a4702212eb',
  },
};

const sanitizeSyncRowSource = `function sanitizeSyncRow(row) {
  const copy = Object.assign({}, row || {});
  for (const key of ['deleted_at', 'deletedAt', 'last_applied_at', 'lastAppliedAt', 'updated_at', 'updatedAt']) {
    if (Object.prototype.hasOwnProperty.call(copy, key)) copy[key] = normalizeIsoTimestamp(copy[key]);
  }
  return copy;
}`;

const journalAdvertisementSource = `async function loadJournalBootstrapAdvertisement() {
  try {
    const tableRows = await q(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('journal_catalog_state','journal_entries','journal_vocab')"
    );
    const tableNames = new Set(tableRows.map((row) => String(row.name || '')));
    if (!['journal_catalog_state', 'journal_entries', 'journal_vocab'].every((name) => tableNames.has(name))) {
      return null;
    }
    const stateRows = await q(
      'SELECT catalog_version, catalog_hash FROM journal_catalog_state WHERE id=1 LIMIT 1'
    );
    if (stateRows.length !== 1) return null;
    const version = Number(stateRows[0].catalog_version);
    const hash = String(stateRows[0].catalog_hash || '');
    if (!Number.isSafeInteger(version) || version <= 0 || !/^[0-9a-f]{64}$/.test(hash)) return null;
    const manifestRows = await q([
      'SELECT',
      "  (SELECT COUNT(*) FROM journal_entries WHERE status IN ('final','voided')) AS entries_count,",
      "  (SELECT COUNT(*) FROM journal_vocab WHERE scope='custom') AS custom_vocab_count,",
      "  COALESCE((SELECT SUM(sync_version) FROM journal_entries WHERE status IN ('final','voided')),0)",
      "    + COALESCE((SELECT SUM(sync_version) FROM journal_vocab WHERE scope='custom'),0) AS high_water_mark"
    ].join('\\n'));
    if (manifestRows.length !== 1) return null;
    const manifest = {
      entries_count: Number(manifestRows[0].entries_count),
      custom_vocab_count: Number(manifestRows[0].custom_vocab_count),
      high_water_mark: Number(manifestRows[0].high_water_mark)
    };
    if (!Object.values(manifest).every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
    return { version, hash, manifest };
  } catch (error) {
    const detail = String(error && error.message ? error.message : error).slice(0, 200);
    node.warn('Journal bootstrap advertisement unavailable: ' + detail);
    return null;
  }
}`;

const capabilitySource = `const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1'];
  const journalAdvertisement = await loadJournalBootstrapAdvertisement();
  if (journalAdvertisement) syncCapabilities.push('field_journal_v1');
  const bootstrapGatewayIdentity = {
    previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis,
    edgeBuildVersion,
    syncCapabilities
  };
  if (journalAdvertisement) {
    bootstrapGatewayIdentity.journal_catalog_version = journalAdvertisement.version;
    bootstrapGatewayIdentity.journal_catalog_hash = journalAdvertisement.hash;
    bootstrapGatewayIdentity.journal_manifest = journalAdvertisement.manifest;
  }`;

const sqliteCloseWrapperSource =
  `const close = () => new Promise(res => _db.close(() => res()));`;
const rejectingSqliteCloseWrapperSource =
  `const close = () => new Promise((resolve, reject) => _db.close((error) => error ? reject(error) : resolve()));`;
const historyCloseWrapperSource =
  `return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();`;
const rejectingHistoryCloseWrapperSource =
  `return db ? new Promise(function(resolve, reject) { db.close(function(error) { if (error) reject(error); else resolve(); }); }) : Promise.resolve();`;

function digest(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('Expected exactly one ' + label + ' seam');
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function indexNodes(flows) {
  const byId = new Map();
  for (const node of flows) {
    if (!node.id) continue;
    if (byId.has(node.id)) throw new Error('Duplicate flow node id: ' + node.id);
    byId.set(node.id, node);
  }
  for (const [id, contract] of Object.entries(nodeContracts)) {
    const node = byId.get(id);
    if (!node || node.id !== id || node.name !== contract.name || node.type !== contract.type ||
        typeof node.func !== 'string') {
      throw new Error('Refusing Task 12 node identity drift: ' + id);
    }
  }
  return byId;
}

function currentHashes(byId) {
  return Object.fromEntries(Object.keys(nodeContracts).map((id) => [id, digest(byId.get(id).func)]));
}

function matchesState(hashes, key) {
  return Object.entries(nodeContracts).every(([id, contract]) => hashes[id] === contract[key]);
}

function exposeNormalBootstrapCatches(source) {
  let next = replaceOnce(
    source,
    `      } catch (_) {}`,
    `      } catch (_) { node.warn('Bootstrap gateway-reference rewrite failed: ' + String(_ && _.message ? _.message : _)); }`,
    'bootstrap gateway-reference catch'
  );
  next = replaceOnce(
    next,
    `    } catch (_) {}`,
    `    } catch (_) { node.warn('Bootstrap gateway migration rollback failed: ' + String(_ && _.message ? _.message : _)); }`,
    'bootstrap migration rollback catch'
  );
  return replaceOnce(
    next,
    `  try { await close(); } catch(_) {}`,
    `  try { await close(); } catch(_) { node.warn('Bootstrap DB close failed after error: ' + String(_ && _.message ? _.message : _)); }`,
    'bootstrap close catch'
  );
}

function exposeHistoryCatches(source) {
  let next = replaceOnce(
    source,
    `      try {
        const existing = String(fs.readFileSync(secretPath, 'utf8') || '').trim();
        if (existing) return existing;
      } catch (_) {}`,
    `      try {
        const existing = String(fs.readFileSync(secretPath, 'utf8') || '').trim();
        if (existing) return existing;
      } catch (_) {
        if (!_ || _.code !== 'ENOENT') {
          node.warn('History auth secret read failed for ' + secretPath + ': ' + String(_ && _.message ? _.message : _));
        }
      }`,
    'history auth secret read catch'
  );
  next = replaceOnce(
    next,
    `      try {
        fs.writeFileSync(secretPath, generated + '\\n', { mode: 0o600 });
        return generated;
      } catch (_) {}`,
    `      try {
        fs.writeFileSync(secretPath, generated + '\\n', { mode: 0o600 });
        return generated;
      } catch (_) { node.warn('History auth secret write failed for ' + secretPath + ': ' + String(_ && _.message ? _.message : _)); }`,
    'history auth secret write catch'
  );
  return replaceOnce(
    next,
    `  try { await closeDb(); } catch (_) {}`,
    `  try { await closeDb(); } catch (_) { node.warn('History API DB close failed: ' + String(_ && _.message ? _.message : _)); }`,
    'history DB close catch'
  );
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  const byId = indexNodes(flows);
  const beforeHashes = currentHashes(byId);
  if (matchesState(beforeHashes, 'installedHash')) return buffer;
  const fromPreimage = matchesState(beforeHashes, 'preimageHash');
  const fromInterim = matchesState(beforeHashes, 'interimHash');
  if (!fromPreimage && !fromInterim) {
    throw new Error('Refusing unexpected Task 12 function source: ' + JSON.stringify(beforeHashes));
  }

  if (fromPreimage) {
    for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
      const node = byId.get(id);
      node.func = replaceOnce(
        node.func,
        sanitizeSyncRowSource,
        sanitizeSyncRowSource + '\n' + journalAdvertisementSource,
        id + ' journal helper'
      );
      node.func = replaceOnce(
        node.func,
        "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1'];",
        capabilitySource,
        id + ' capability advertisement'
      );
    }

    const normal = byId.get('sync-bootstrap-build');
    normal.func = replaceOnce(
      normal.func,
      `    gatewayIdentity: {
      previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis,
      edgeBuildVersion,
      syncCapabilities
    },`,
      `    gatewayIdentity: bootstrapGatewayIdentity,`,
      'normal bootstrap gateway identity'
    );

    normal.func = exposeNormalBootstrapCatches(normal.func);

    const forced = byId.get('sync-force-build');
    forced.func = replaceOnce(
      forced.func,
      `      gatewayIdentity: {
        previousGatewayDeviceEuis: migration.previousGatewayDeviceEuis,
        edgeBuildVersion,
        syncCapabilities
      },`,
      `      gatewayIdentity: bootstrapGatewayIdentity,`,
      'forced bootstrap gateway identity'
    );

    const history = byId.get('history-api-router-fn');
    history.func = replaceOnce(
      history.func,
      `        historyCloudAiEnabled: false`,
      `        historyCloudAiEnabled: false,
        fieldJournalUxEnabled: false`,
      'history feature flag'
    );
    history.func = exposeHistoryCatches(history.func);
  }

  const interimHashes = currentHashes(byId);
  if (!matchesState(interimHashes, 'interimHash')) {
    throw new Error('Task 12 interim hashes do not match pins: ' + JSON.stringify(interimHashes));
  }

  for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
    const node = byId.get(id);
    node.func = replaceOnce(
      node.func,
      sqliteCloseWrapperSource,
      rejectingSqliteCloseWrapperSource,
      id + ' rejecting DB close wrapper'
    );
  }
  const history = byId.get('history-api-router-fn');
  history.func = replaceOnce(
    history.func,
    historyCloseWrapperSource,
    rejectingHistoryCloseWrapperSource,
    'history rejecting DB close wrapper'
  );

  const afterHashes = currentHashes(byId);
  if (!matchesState(afterHashes, 'installedHash')) {
    throw new Error('Task 12 installed hashes do not match pins: ' + JSON.stringify(afterHashes));
  }
  return serialize(flows);
}

function main() {
  const before = flowPaths.map((file) => fs.readFileSync(file));
  if (!before[0].equals(before[1])) {
    throw new Error('Maintained flows are not byte-identical before Task 12 migration');
  }
  for (let index = 0; index < before.length; index += 1) {
    if (!before[index].equals(serialize(JSON.parse(before[index].toString('utf8'))))) {
      throw new Error('Flow input is not a byte-stable JSON roundtrip: ' + flowPaths[index]);
    }
  }

  const after = migrate(before[0]);
  if (!after.equals(migrate(after))) throw new Error('Task 12 flow migration is not idempotent');
  if (!after.equals(serialize(JSON.parse(after.toString('utf8'))))) {
    throw new Error('Task 12 output is not a byte-stable JSON roundtrip');
  }
  if (after.equals(before[0])) {
    process.stdout.write('migrate-flows-journal-bootstrap: already current\n');
    return;
  }
  for (const file of flowPaths) fs.writeFileSync(file, after);
  if (!fs.readFileSync(flowPaths[0]).equals(fs.readFileSync(flowPaths[1]))) {
    throw new Error('Maintained flows lost byte parity after Task 12 migration');
  }
  process.stdout.write('migrate-flows-journal-bootstrap: applied exact Task 12 bootstrap advertisement\n');
}

if (require.main === module) main();

module.exports = { migrate };
