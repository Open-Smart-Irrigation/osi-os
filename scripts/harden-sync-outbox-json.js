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

// postimageHash re-pinned 2026-09-17 (F81) for sync-bootstrap-build,
// sync-outbox-build and sync-force-build: normalizeIsoTimestamp gained a branch
// for SQLite's space-separated datetime('now') format (valve_schedules'
// created_at/updated_at/deleted_at), reformatted to exactly millisecond
// precision ('.000Z') per docs/contracts/sync-schema/resources.schema.json's
// NullableCanonicalUtcTimestamp pattern, and sync-outbox-build/sync-force-build
// gained a normalizeOutboxPayload() wrapper on the VALVE_SCHEDULE outbox event
// delivery mapping so an already-queued unconverted deleted_at is fixed at
// flush time too. Purely additive on top of the already-hardened source; no
// replaceOnce anchor in this file was touched.
const nodeContracts = {
  'sync-bootstrap-build': {
    name: 'Build Cloud Bootstrap',
    type: 'function',
    preimageHash: '30fd59f6f57519113752b7fb9728d086e10d51eabd9dbcc740cd1222d27bad49',
    postimageHash: '4b69bf8917c57135d9c3da05e5eeb026d2105d398351a7a76b5d743356fc31ce',
  },
  'sync-outbox-build': {
    name: 'Build Edge Event Batch',
    type: 'function',
    preimageHash: 'd655dda7815505cae6670607d901321938f13f0aed40ef277f931ebd9dd66f16',
    postimageHash: 'd50e5cfa41faf70c6a8bfb779d5e7d34154b712e85933f99406f153c34723374',
  },
  'sync-force-build': {
    name: 'Run Force Sync',
    type: 'function',
    preimageHash: 'b17b2801f706adebd6832f053133c12e4535e6e4a51240c7e641e98c60811a45',
    postimageHash: 'a0bffd7ccb8c0357ea06f9a852b02335b61be628d535e137652bdcbd34a540d8',
  },
  'write-strega-expectation': {
    name: 'Write STREGA Expectation',
    type: 'function',
    preimageHash: 'b2813630cecb860bc0a03429c58c068c56c3538379898deb0e455b0efa77a89a',
    postimageHash: 'c51de010940bdb799e2e40146523544c60bf51cab51ea0b733e2c2a515b87762',
  },
};

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

const gatewayRewriteSuffixByNode = {
  'sync-bootstrap-build':
    `      } catch (_) { node.warn('Bootstrap gateway-reference rewrite failed: ' + String(_ && _.message ? _.message : _)); }`,
  'sync-outbox-build': `      } catch (_) {}`,
  'sync-force-build':
    `      } catch (_) { node.warn('Force-sync optional operation failed: ' + String(_ && _.message ? _.message : _)); }`,
};

const strictGatewayRewriteSource = `    for (const row of outboxRows) {
      const payloadJson = JSON.stringify(rewriteGatewayReferences(parseJsonValue(row.payload_json, row.event_uuid), replacements));`;

const permissiveDeliverySource =
  `payload: (() => { try { return JSON.parse(r.payload_json || '{}'); } catch (_) { return {}; } })()`;
const strictDeliverySource = `payload: parseJsonValue(r.payload_json, r.event_uuid)`;

const calibrationReadSource = `    let calib = null;
    if (zoneId != null) {
        try {
            calib = await db.get('SELECT measured_flow_rate_lpm, measurement_method FROM zone_irrigation_calibration WHERE zone_id = ?', [zoneId]);
        } catch (_) {
            calib = null;
        }
    }`;

const calibrationHelperSource = `    async function loadZoneIrrigationCalibration(db, zoneId) {
        if (zoneId == null) return null;
        try {
            return await db.get('SELECT measured_flow_rate_lpm, measurement_method FROM zone_irrigation_calibration WHERE zone_id = ?', [zoneId]);
        } catch (error) {
            const detail = String(error && error.message ? error.message : error);
            if (/no such table:\\s*zone_irrigation_calibration\\b/i.test(detail)) {
                node.warn('STREGA calibration unavailable on this gateway: ' + detail);
                return null;
            }
            throw error;
        }
    }

    const db = new osiDb.Database('/data/db/farming.db');`;

const calibrationUseSource = `    const calib = await loadZoneIrrigationCalibration(db, zoneId);`;

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
    if (!node || node.name !== contract.name || node.type !== contract.type || typeof node.func !== 'string') {
      throw new Error('Refusing sync outbox hardening node identity drift: ' + id);
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

function gatewayRewriteSource(nodeId) {
  return [
    `    for (const row of outboxRows) {`,
    `      let payloadJson = row.payload_json;`,
    `      try {`,
    `        payloadJson = JSON.stringify(rewriteGatewayReferences(parseJsonValue(row.payload_json, {}), replacements));`,
    gatewayRewriteSuffixByNode[nodeId],
  ].join('\n');
}

function hardenSyncNode(node) {
  let next = replaceOnce(
    node.func,
    permissiveParserSource,
    strictParserSource,
    node.id + ' strict payload parser'
  );
  next = replaceOnce(
    next,
    gatewayRewriteSource(node.id),
    strictGatewayRewriteSource,
    node.id + ' rollback-propagating gateway rewrite'
  );
  if (node.id === 'sync-outbox-build' || node.id === 'sync-force-build') {
    next = replaceOnce(
      next,
      permissiveDeliverySource,
      strictDeliverySource,
      node.id + ' strict event delivery parser'
    );
  }
  if (node.id === 'sync-outbox-build') {
    next = replaceOnce(
      next,
      `    } catch (_) {}`,
      `    } catch (_) { node.warn('Sync outbox gateway migration rollback failed: ' + String(_ && _.message ? _.message : _)); }`,
      'sync-outbox-build visible migration rollback catch'
    );
    next = replaceOnce(
      next,
      `  try { await close(); } catch(_) {}`,
      `  try { await close(); } catch(_) { node.warn('Sync outbox DB close failed after error: ' + String(_ && _.message ? _.message : _)); }`,
      'sync-outbox-build visible DB close catch'
    );
  }
  node.func = next;
}

function hardenStregaNode(node) {
  let next = replaceOnce(
    node.func,
    `    const db = new osiDb.Database('/data/db/farming.db');`,
    calibrationHelperSource,
    'write-strega-expectation calibration helper'
  );
  next = replaceOnce(
    next,
    calibrationReadSource,
    calibrationUseSource,
    'write-strega-expectation calibration use'
  );
  node.func = next;
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  const byId = indexNodes(flows);
  const beforeHashes = currentHashes(byId);
  if (matchesState(beforeHashes, 'postimageHash')) return buffer;
  if (!matchesState(beforeHashes, 'preimageHash')) {
    throw new Error('Refusing unexpected sync outbox hardening source: ' + JSON.stringify(beforeHashes));
  }

  for (const id of ['sync-bootstrap-build', 'sync-outbox-build', 'sync-force-build']) {
    hardenSyncNode(byId.get(id));
  }
  hardenStregaNode(byId.get('write-strega-expectation'));

  const afterHashes = currentHashes(byId);
  if (!matchesState(afterHashes, 'postimageHash')) {
    throw new Error('Sync outbox hardening output hashes do not match pins: ' + JSON.stringify(afterHashes));
  }
  return serialize(flows);
}

function main() {
  const before = flowPaths.map((file) => fs.readFileSync(file));
  if (!before[0].equals(before[1])) {
    throw new Error('Maintained flows are not byte-identical before sync outbox hardening');
  }
  for (let index = 0; index < before.length; index += 1) {
    if (!before[index].equals(serialize(JSON.parse(before[index].toString('utf8'))))) {
      throw new Error('Flow input is not a byte-stable JSON roundtrip: ' + flowPaths[index]);
    }
  }

  const after = migrate(before[0]);
  if (!after.equals(migrate(after))) throw new Error('Sync outbox hardening is not idempotent');
  if (!after.equals(serialize(JSON.parse(after.toString('utf8'))))) {
    throw new Error('Sync outbox hardening output is not a byte-stable JSON roundtrip');
  }
  if (after.equals(before[0])) {
    process.stdout.write('harden-sync-outbox-json: already current\n');
    return;
  }
  for (const file of flowPaths) fs.writeFileSync(file, after);
  if (!fs.readFileSync(flowPaths[0]).equals(fs.readFileSync(flowPaths[1]))) {
    throw new Error('Maintained flows lost byte parity after sync outbox hardening');
  }
  process.stdout.write('harden-sync-outbox-json: applied exact fail-closed payload hardening\n');
}

if (require.main === module) main();

module.exports = { migrate };
