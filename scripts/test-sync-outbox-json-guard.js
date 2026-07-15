#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);

function loadFlows(filePath) {
  const raw = fs.readFileSync(filePath);
  const roundtrip = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2) + '\n');
  assert.ok(raw.equals(roundtrip), filePath + ' must be a byte-stable pretty-printed JSON roundtrip');
  return { raw, flows: JSON.parse(raw.toString('utf8')) };
}

function requiredNode(byId, id) {
  const node = byId.get(id);
  assert.ok(node && node.type === 'function' && typeof node.func === 'string', 'missing function node ' + id);
  return node;
}

function extractDeclaration(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, label + ' start marker missing');
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, label + ' end marker missing');
  return source.slice(start, end);
}

function loadStrictParser(source, nodeId) {
  const declaration = extractDeclaration(
    source,
    'function parseJsonValue(raw, eventUuid) {',
    '\nfunction rewriteGatewayReferences',
    nodeId + ' parseJsonValue'
  );
  return Function(declaration + '\nreturn parseJsonValue;')();
}

function assertStrictParser(source, nodeId) {
  const parseJsonValue = loadStrictParser(source, nodeId);
  assert.deepEqual(
    parseJsonValue('{"nested":{"ok":true}}', 'event-valid-' + nodeId),
    { nested: { ok: true } },
    nodeId + ' must accept JSON objects'
  );

  const invalidInputs = [
    ['malformed JSON', '{not-json'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON string', '"scalar"'],
    ['JSON number', '42'],
    ['JSON boolean', 'false'],
  ];
  for (const [label, raw] of invalidInputs) {
    const eventUuid = 'event-' + nodeId + '-' + label.replace(/\s+/g, '-');
    assert.throws(
      () => parseJsonValue(raw, eventUuid),
      (error) => error instanceof Error && error.message.includes(eventUuid),
      nodeId + ' must reject ' + label + ' with the event UUID'
    );
  }
}

function assertGatewayRewriteRollsBack(source, nodeId) {
  const loopStart = source.indexOf('    for (const row of outboxRows) {');
  assert.notEqual(loopStart, -1, nodeId + ' gateway rewrite loop missing');
  const loopEnd = source.indexOf('      const aggregateType =', loopStart);
  assert.notEqual(loopEnd, -1, nodeId + ' gateway rewrite aggregate seam missing');
  const rewritePrefix = source.slice(loopStart, loopEnd);
  assert.match(
    rewritePrefix,
    /parseJsonValue\(row\.payload_json, row\.event_uuid\)/,
    nodeId + ' gateway rewrite must identify malformed rows by event_uuid'
  );
  assert.doesNotMatch(
    rewritePrefix,
    /\btry\s*\{/,
    nodeId + ' gateway rewrite must let parser failures reach transaction rollback'
  );
  assert.doesNotMatch(
    rewritePrefix,
    /\{\}/,
    nodeId + ' gateway rewrite must not substitute an empty object'
  );

  const migrationCatch = source.slice(
    source.indexOf('  } catch (error) {', loopStart),
    source.indexOf('\n}\nfunction normalizeCloudServerUrl', loopStart)
  );
  assert.match(migrationCatch, /await run\('ROLLBACK'\)/, nodeId + ' migration catch must roll back');
  assert.match(migrationCatch, /throw error;/, nodeId + ' migration catch must propagate the parser failure');
}

function assertDeliveryMapping(source, nodeId) {
  assert.match(
    source,
    /payload:\s*parseJsonValue\(r\.payload_json, r\.event_uuid\)/,
    nodeId + ' delivery mapping must call the strict parser'
  );
  assert.doesNotMatch(
    source,
    /JSON\.parse\(r\.payload_json\s*\|\|\s*'\{\}'\)/,
    nodeId + ' delivery mapping must not default malformed payloads to {}'
  );
  assert.doesNotMatch(
    source,
    /payload:\s*\(\(\)\s*=>\s*\{\s*try\s*\{[\s\S]*?return\s*\{\};/,
    nodeId + ' delivery mapping must not catch and substitute {}'
  );
}

async function assertCalibrationFallback(source) {
  const declaration = extractDeclaration(
    source,
    'async function loadZoneIrrigationCalibration(db, zoneId) {',
    '\n\n    const db = new osiDb.Database',
    'write-strega-expectation calibration helper'
  );
  const warnings = [];
  const loadCalibration = Function(
    'node',
    declaration + '\nreturn loadZoneIrrigationCalibration;'
  )({ warn: (message) => warnings.push(String(message)) });

  const calibration = { measured_flow_rate_lpm: 12, measurement_method: 'bucket' };
  assert.equal(await loadCalibration({ get: async () => calibration }, 7), calibration);
  assert.equal(await loadCalibration({ get: async () => calibration }, null), null);

  const missing = new Error('SQLITE_ERROR: no such table: zone_irrigation_calibration');
  assert.equal(await loadCalibration({ get: async () => { throw missing; } }, 7), null);
  assert.equal(warnings.length, 1, 'missing calibration table must emit exactly one visible warning');
  assert.match(warnings[0], /zone_irrigation_calibration/);

  for (const failure of [
    new Error('SQLITE_BUSY: database is locked'),
    new Error('SQLITE_ERROR: no such table: unrelated_table'),
  ]) {
    await assert.rejects(
      loadCalibration({ get: async () => { throw failure; } }, 7),
      (error) => error === failure,
      'non-calibration database failures must propagate unchanged'
    );
  }
  assert.equal(warnings.length, 1, 'non-missing-table errors must not be downgraded to warnings');
  assert.match(
    source,
    /const calib = await loadZoneIrrigationCalibration\(db, zoneId\);/,
    'STREGA expectation path must use the guarded calibration helper'
  );
}

async function main() {
  const canonical = loadFlows(canonicalPath);
  const mirror = loadFlows(mirrorPath);
  assert.ok(canonical.raw.equals(mirror.raw), 'maintained flows must be byte-identical');

  const bootstrapMigration = require('./migrate-flows-journal-bootstrap');
  assert.ok(
    canonical.raw.equals(bootstrapMigration.migrate(canonical.raw)),
    'journal bootstrap migration must preserve the current fail-closed flow source'
  );
  const hardeningMigration = require('./harden-sync-outbox-json');
  assert.ok(
    canonical.raw.equals(hardeningMigration.migrate(canonical.raw)),
    'sync outbox hardening must be a no-op on the installed source'
  );

  const byId = new Map(canonical.flows.map((node) => [node.id, node]));
  for (const id of ['sync-bootstrap-build', 'sync-outbox-build', 'sync-force-build']) {
    const source = requiredNode(byId, id).func;
    assertStrictParser(source, id);
    assertGatewayRewriteRollsBack(source, id);
  }
  assertDeliveryMapping(requiredNode(byId, 'sync-outbox-build').func, 'sync-outbox-build');
  assertDeliveryMapping(requiredNode(byId, 'sync-force-build').func, 'sync-force-build');
  await assertCalibrationFallback(requiredNode(byId, 'write-strega-expectation').func);

  console.log('PASS: sync outbox JSON is object-only and STREGA calibration fallback is missing-table-only');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
