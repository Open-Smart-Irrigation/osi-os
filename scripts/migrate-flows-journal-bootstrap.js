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

// One-shot input-safety pins. Re-pinned 2026-07-14 against main @0f1361a3
// merged into feat/field-journal-slice1 with the Task 10/11 journal wiring
// re-applied: main's upsert-sync-versioning and DD8 follow-ups changed
// sync-bootstrap-build and sync-force-build (history-api-router-fn was
// untouched). Every replaceOnce anchor was verified to still occur exactly
// once before re-pinning; interim/installed/corrected hashes were recomputed
// by running this script's own staged verification.
const nodeContracts = {
  'sync-bootstrap-build': {
    name: 'Build Cloud Bootstrap',
    type: 'function',
    preimageHash: 'd7fd2a019cb3925e34f52fc0851816781bfc50da4c6c31d018c2723d7304cd81',
    interimHash: '15167b53b7103c4f99c5ab0a2de7912a4917ec799e07b1e5fb9ad67268da7649',
    installedHash: '55d7ea47694d8f6f0863e793c6a40bbfcf7a442e79b6a25d6d7be4fcd842b6c0',
    correctedHash: '30fd59f6f57519113752b7fb9728d086e10d51eabd9dbcc740cd1222d27bad49',
    hardenedHash: 'c1bfd92a13a8021757c390d15b764277522eae604a21e2985f2f1c9378985663',
  },
  'sync-force-build': {
    name: 'Run Force Sync',
    type: 'function',
    preimageHash: 'b037f8984b16e9a5d73dd85d5fdde89be1b426e6b102673630751d8d6d7a8254',
    interimHash: '54424af7aac4515582c7c9312c419580ea151a2fd48bdbf0be51eff78a241bcd',
    installedHash: 'e240ff936f17899b1414f8b1dd473462d53bceb842e4ca942ff7946f53b3482a',
    correctedHash: 'b17b2801f706adebd6832f053133c12e4535e6e4a51240c7e641e98c60811a45',
    hardenedHash: 'fb682aaef9ebf3f851f0f8c7ef6ee1602e2e7fe5281eaa2f7bf51576c919ec0c',
  },
  'history-api-router-fn': {
    name: 'History API Router',
    type: 'function',
    preimageHash: '16c728a66b472c961c9d0ef9001d3a1966c3a91c4c4e533fb7d7db5b8ba49c01',
    interimHash: '52b51062e2b85e2081ba976f78623eef4f93deab295e3467f611654a3248b001',
    installedHash: 'b12ad483f807672f6fbef6040b3e44eb612fb778fe00e6059a8ae0a4702212eb',
    correctedHash: 'b12ad483f807672f6fbef6040b3e44eb612fb778fe00e6059a8ae0a4702212eb',
    hardenedHash: 'b12ad483f807672f6fbef6040b3e44eb612fb778fe00e6059a8ae0a4702212eb',
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

const correctedJournalAdvertisementSource = `async function loadJournalBootstrapAdvertisement() {
  try {
    const requiredTables = [
      'journal_catalog_state',
      'journal_entries',
      'journal_entry_values',
      'journal_vocab',
      'journal_vocab_mappings',
      'journal_plots',
      'journal_plot_settings',
      'journal_plot_groups',
      'journal_plot_group_members',
      'journal_templates',
      'journal_layouts',
      'journal_products'
    ];
    const tableRows = await q(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" +
      requiredTables.map((name) => "'" + name + "'").join(',') + ')'
    );
    const tableNames = new Set(tableRows.map((row) => String(row.name || '')));
    if (!requiredTables.every((name) => tableNames.has(name))) return null;
    const stateRows = await q(
      'SELECT catalog_version, catalog_hash FROM journal_catalog_state WHERE id=1 LIMIT 1'
    );
    if (stateRows.length !== 1) return null;
    const version = Number(stateRows[0].catalog_version);
    const hash = String(stateRows[0].catalog_hash || '');
    if (!Number.isSafeInteger(version) || version <= 0 || !/^[0-9a-f]{64}$/.test(hash)) return null;
    const resourceRows = await q([
      "SELECT 'JOURNAL_ENTRY' AS aggregate_type, entry_uuid AS aggregate_key, sync_version",
      "FROM journal_entries WHERE status IN ('final','voided')",
      'UNION ALL',
      "SELECT 'JOURNAL_VOCAB', custom_field_uuid, sync_version",
      "FROM journal_vocab WHERE scope='custom'",
      'UNION ALL',
      "SELECT 'JOURNAL_PLOT', plot_uuid, sync_version FROM journal_plots",
      'UNION ALL',
      "SELECT 'JOURNAL_PLOT_GROUP', group_uuid, sync_version FROM journal_plot_groups"
    ].join('\\n'));
    const counts = {
      JOURNAL_ENTRY: 0,
      JOURNAL_VOCAB: 0,
      JOURNAL_PLOT: 0,
      JOURNAL_PLOT_GROUP: 0
    };
    const tuples = [];
    for (const row of resourceRows) {
      const aggregateType = String(row.aggregate_type || '');
      const aggregateKey = String(row.aggregate_key || '');
      const syncVersion = Number(row.sync_version);
      if (!Object.prototype.hasOwnProperty.call(counts, aggregateType) || !aggregateKey ||
          aggregateKey.includes('\\0') || !Number.isSafeInteger(syncVersion) || syncVersion < 0) {
        return null;
      }
      counts[aggregateType] += 1;
      tuples.push(aggregateType + '\\0' + aggregateKey + '\\0' + String(syncVersion));
    }
    tuples.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    const watermark = crypto.createHash('sha256');
    for (const tuple of tuples) watermark.update(tuple, 'utf8');
    const manifest = {
      version: 1,
      entries_count: counts.JOURNAL_ENTRY,
      custom_vocab_count: counts.JOURNAL_VOCAB,
      plots_count: counts.JOURNAL_PLOT,
      plot_groups_count: counts.JOURNAL_PLOT_GROUP,
      resource_watermark_hash: watermark.digest('hex'),
      hash_scope: 'sorted aggregate_type\\\\0aggregate_key\\\\0sync_version tuples'
    };
    if (![manifest.entries_count, manifest.custom_vocab_count, manifest.plots_count,
      manifest.plot_groups_count].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
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

const permissiveParserSource = `function parseJsonValue(raw, fallback) {
  try {
    return JSON.parse(raw || '{}');
  } catch (_) {
    return fallback;
  }
}`;
const strictParserSource = `function parseJsonValue(raw, eventUuid) {
  let value;
  try { value = JSON.parse(raw); } catch (cause) {
    const error = new Error('Malformed sync_outbox payload_json for ' + String(eventUuid));
    error.cause = cause;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sync_outbox payload_json must be an object for ' + String(eventUuid));
  }
  return value;
}`;
const bootstrapGatewayRewriteSource = `    for (const row of outboxRows) {
      let payloadJson = row.payload_json;
      try {
        payloadJson = JSON.stringify(rewriteGatewayReferences(parseJsonValue(row.payload_json, {}), replacements));
      } catch (_) { node.warn('Bootstrap gateway-reference rewrite failed: ' + String(_ && _.message ? _.message : _)); }`;
const forceGatewayRewriteSource = `    for (const row of outboxRows) {
      let payloadJson = row.payload_json;
      try {
        payloadJson = JSON.stringify(rewriteGatewayReferences(parseJsonValue(row.payload_json, {}), replacements));
      } catch (_) { node.warn('Force-sync optional operation failed: ' + String(_ && _.message ? _.message : _)); }`;
const strictGatewayRewriteSource = `    for (const row of outboxRows) {
      const payloadJson = JSON.stringify(rewriteGatewayReferences(parseJsonValue(row.payload_json, row.event_uuid), replacements));`;
const permissiveDeliverySource =
  `payload: (() => { try { return JSON.parse(r.payload_json || '{}'); } catch (_) { return {}; } })()`;
const strictDeliverySource = `payload: parseJsonValue(r.payload_json, r.event_uuid)`;

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

function hasCryptoLibrary(node) {
  const matches = (Array.isArray(node.libs) ? node.libs : []).filter((library) =>
    library && (library.var === 'crypto' || library.module === 'crypto')
  );
  return matches.length === 1 && matches[0].var === 'crypto' && matches[0].module === 'crypto';
}

function correctedLibrariesInstalled(byId) {
  return ['sync-bootstrap-build', 'sync-force-build'].every((id) => hasCryptoLibrary(byId.get(id)));
}

function ensureCryptoLibrary(node) {
  if (hasCryptoLibrary(node)) return;
  const libraries = Array.isArray(node.libs) ? node.libs : [];
  if (libraries.some((library) => library && (library.var === 'crypto' || library.module === 'crypto'))) {
    throw new Error('Refusing conflicting crypto function library on ' + node.id);
  }
  node.libs = [{ var: 'crypto', module: 'crypto' }].concat(libraries);
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

function hardenCorrectedOutboxJson(byId) {
  const normal = byId.get('sync-bootstrap-build');
  normal.func = replaceOnce(
    normal.func,
    permissiveParserSource,
    strictParserSource,
    'sync-bootstrap-build strict payload parser'
  );
  normal.func = replaceOnce(
    normal.func,
    bootstrapGatewayRewriteSource,
    strictGatewayRewriteSource,
    'sync-bootstrap-build rollback-propagating gateway rewrite'
  );

  const forced = byId.get('sync-force-build');
  forced.func = replaceOnce(
    forced.func,
    permissiveParserSource,
    strictParserSource,
    'sync-force-build strict payload parser'
  );
  forced.func = replaceOnce(
    forced.func,
    forceGatewayRewriteSource,
    strictGatewayRewriteSource,
    'sync-force-build rollback-propagating gateway rewrite'
  );
  forced.func = replaceOnce(
    forced.func,
    permissiveDeliverySource,
    strictDeliverySource,
    'sync-force-build strict event delivery parser'
  );
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  const byId = indexNodes(flows);
  const beforeHashes = currentHashes(byId);
  if (matchesState(beforeHashes, 'hardenedHash')) {
    if (!correctedLibrariesInstalled(byId)) {
      throw new Error('Refusing hardened Task 12 source without exact crypto libraries');
    }
    return buffer;
  }
  const fromPreimage = matchesState(beforeHashes, 'preimageHash');
  const fromInterim = matchesState(beforeHashes, 'interimHash');
  const fromInstalled = matchesState(beforeHashes, 'installedHash');
  const fromCorrected = matchesState(beforeHashes, 'correctedHash');
  if (!fromPreimage && !fromInterim && !fromInstalled && !fromCorrected) {
    throw new Error('Refusing unexpected Task 12 function source: ' + JSON.stringify(beforeHashes));
  }

  if (!fromCorrected && fromPreimage) {
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

  if (!fromCorrected && !fromInstalled) {
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
  }

  if (!fromCorrected) {
    const installedHashes = currentHashes(byId);
    if (!matchesState(installedHashes, 'installedHash')) {
      throw new Error('Task 12 installed hashes do not match pins: ' + JSON.stringify(installedHashes));
    }

    for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
      const node = byId.get(id);
      node.func = replaceOnce(
        node.func,
        journalAdvertisementSource,
        correctedJournalAdvertisementSource,
        id + ' corrected journal helper'
      );
      ensureCryptoLibrary(node);
    }

    const correctedHashes = currentHashes(byId);
    if (!matchesState(correctedHashes, 'correctedHash')) {
      throw new Error('Task 12 corrected hashes do not match pins: ' + JSON.stringify(correctedHashes));
    }
  }

  if (!correctedLibrariesInstalled(byId)) {
    throw new Error('Refusing corrected Task 12 source without exact crypto libraries');
  }
  hardenCorrectedOutboxJson(byId);
  const hardenedHashes = currentHashes(byId);
  if (!matchesState(hardenedHashes, 'hardenedHash')) {
    throw new Error('Task 12 hardened hashes do not match pins: ' + JSON.stringify(hardenedHashes));
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
