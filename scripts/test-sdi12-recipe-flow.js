#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  executeFunction,
  loadNode,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const MIRROR = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
const NORMALIZE = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize'
));

function nodesById(id) {
  return flows.filter((node) => node.id === id);
}

function nodeById(id, type) {
  const matches = nodesById(id);
  assert.equal(matches.length, 1, `${id} must exist exactly once`);
  if (type) assert.equal(matches[0].type, type, `${id} must be a ${type} node`);
  return matches[0];
}

function hasLib(node, variable, moduleName) {
  return (node.libs || []).some((lib) => lib.var === variable && lib.module === moduleName);
}

function requestPath(deveui, suffix) {
  return `/api/devices/${deveui}${suffix}`;
}

function insertDevice(db, {
  deveui,
  typeId = 'DRAGINO_SDI12',
  userId = 1,
  layout = null,
  appId = 'app-sensors-uuid',
  status = 'manual',
}) {
  db.prepare(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, chirpstack_app_id,
      sdi12_probe_status, sdi12_channel_layout_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')
  `).run(deveui, `Device ${deveui}`, typeId, userId, appId, status, layout);
}

function assertOneBoundedHttpResponse(execution, expectedStatus, label) {
  const explicit = Array.isArray(execution.result)
    ? execution.result.filter((message) => message !== null && message !== undefined)
    : (execution.result == null ? [] : [execution.result]);
  assert.equal(
    explicit.length + execution.errors.length,
    1,
    `${label} must emit exactly one explicit-or-Catch HTTP response`
  );
  assert.equal(
    execution.errors.length,
    0,
    `${label} must not send a handled HTTP message into the tab-wide Catch`
  );
  assert.equal(explicit.length, 1, `${label} must return one explicit response`);
  assert.equal(explicit[0].statusCode, expectedStatus, `${label} status`);
  assert.equal(typeof explicit[0].payload, 'object', `${label} payload must be an object`);
  assert.ok(JSON.stringify(explicit[0].payload).length <= 256, `${label} payload must stay bounded`);
}

test('maintained flow files retain canonical serialization and byte parity', () => {
  const canonical = fs.readFileSync(CANONICAL);
  const mirror = fs.readFileSync(MIRROR);
  assert.deepEqual(
    canonical,
    Buffer.from(`${JSON.stringify(JSON.parse(canonical), null, 2)}\n`),
    'canonical flow must use JSON.stringify(parsed, null, 2) plus final newline'
  );
  assert.deepEqual(mirror, canonical, 'bcm2709 must mirror bcm2712 byte-for-byte');
});

test('recipe Apply and Rollback routes share the scoped/authenticated SDI-12 path', () => {
  const apply = nodeById('sdi12-recipe-apply-http', 'http in');
  const rollback = nodeById('sdi12-recipe-rollback-http', 'http in');
  assert.equal(apply.method, 'post');
  assert.equal(apply.url, '/api/devices/:deveui/sdi12/recipe/apply');
  assert.deepEqual(apply.wires, [['scoped-device-config-guard']]);
  assert.equal(rollback.method, 'post');
  assert.equal(rollback.url, '/api/devices/:deveui/sdi12/recipe/rollback');
  assert.deepEqual(rollback.wires, [['scoped-device-config-guard']]);

  const guard = nodeById('scoped-device-config-guard', 'function');
  assert.equal(guard.outputs, 28);
  assert.equal(guard.wires.length, 28);
  assert.deepEqual(guard.wires[24], ['sdi12-config-auth-fn']);
  assert.deepEqual(guard.wires[25], ['sdi12-config-auth-fn']);
  assert.deepEqual(guard.wires[26], ['sdi12-config-auth-fn']);
  assert.deepEqual(guard.wires[27], ['device-response']);
  assert.match(guard.func, /"suffix":"\/sdi12\/recipe\/apply","index":25/);
  assert.match(guard.func, /"suffix":"\/sdi12\/recipe\/rollback","index":26/);

  const auth = nodeById('sdi12-config-auth-fn', 'function');
  assert.equal(auth.outputs, 4);
  assert.deepEqual(auth.wires, [
    ['sdi12-config-action-fn'],
    ['sdi12-recipe-apply-action-fn'],
    ['sdi12-recipe-rollback-action-fn'],
    ['device-response'],
  ]);
});

test('recipe Apply accepts zero-byte request bodies after Node-RED parsing', async () => {
  const db = seedScopedDb();
  const deveui = 'A840410000000132';
  try {
    insertDevice(db, { deveui });
    for (const body of ['', Buffer.alloc(0)]) {
      const execution = await executeFunction(loadNode('sdi12-config-auth-fn'), {
        msg: {
          req: {
            method: 'POST',
            path: requestPath(deveui, '/sdi12/recipe/apply'),
            params: { deveui },
            body,
          },
        },
        env: { OSI_SCOPED_ACCESS: '1' },
        db,
      });
      assert.equal(execution.result[1]?.deviceRow?.deveui, deveui);
      assert.equal(execution.result[3], null);
    }
  } finally {
    db.close();
  }
});

test('handled SDI-12 HTTP failures emit one bounded response without a Catch duplicate', async (t) => {
  const deveui = 'A840410000000131';
  const layout = JSON.stringify({
    version: 1,
    address: 'C',
    sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' }],
  });

  const scenarios = [
    {
      name: 'scoped route guard helper load',
      nodeId: 'scoped-device-config-guard',
      expectedStatus: 500,
      msg: {
        req: {
          method: 'PUT',
          path: requestPath(deveui, '/sdi12/config'),
          params: { deveui },
          headers: {},
        },
      },
      env: { OSI_SCOPED_ACCESS: '1' },
      libOverrides: {
        osiLib: { require: () => ({ ok: false, error: 'scope unavailable' }) },
      },
    },
    {
      name: 'Identify normalizer load',
      nodeId: 'sdi12-identify-action-fn',
      expectedStatus: 500,
      insertLayout: true,
      msg: {
        req: {
          method: 'POST',
          path: requestPath(deveui, '/sdi12/identify'),
          params: { deveui },
          headers: {},
        },
      },
      env: { OSI_SCOPED_ACCESS: '1' },
      libOverrides: {
        osiLib: { require: () => ({ ok: false, error: 'normalizer unavailable' }) },
      },
    },
    {
      name: 'config auth database failure',
      nodeId: 'sdi12-config-auth-fn',
      expectedStatus: 500,
      msg: {
        req: {
          method: 'PUT',
          path: requestPath(deveui, '/sdi12/config'),
          params: { deveui },
          headers: {},
          body: { probe_profile: 'TENSIOMARK' },
        },
      },
      env: { OSI_SCOPED_ACCESS: '1' },
      libOverrides: {
        osiDb: {
          Database: function Database() {
            return {
              get: async () => { throw new Error('database unavailable'); },
              close: async () => undefined,
            };
          },
        },
      },
    },
    {
      name: 'Sentek save helper load',
      nodeId: 'sdi12-config-action-fn',
      expectedStatus: 500,
      msg: {
        deviceRow: { deveui },
        req: {
          body: {
            probe_profile: 'SENTEK_ENVIROSCAN',
            address: 'C',
            sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' }],
          },
        },
      },
      libOverrides: {
        osiLib: {
          require: (name) => name === 'sdi12-normalize'
            ? { ok: true, value: NORMALIZE }
            : { ok: false, error: 'commissioning unavailable' },
        },
      },
    },
    {
      name: 'legacy config rollback failure',
      nodeId: 'sdi12-config-action-fn',
      expectedStatus: 500,
      msg: {
        deviceRow: { deveui },
        req: { body: { probe_profile: 'TENSIOMARK' } },
      },
      libOverrides: {
        osiDb: {
          Database: function Database() {
            return {
              get: async () => null,
              run: async (sql) => {
                if (sql === 'BEGIN IMMEDIATE') return undefined;
                if (sql === 'ROLLBACK') throw new Error('rollback unavailable');
                throw new Error('write unavailable');
              },
              close: async () => undefined,
            };
          },
        },
      },
    },
    ...[
      ['sdi12-recipe-apply-action-fn', 'Apply helper load'],
      ['sdi12-recipe-rollback-action-fn', 'Rollback helper load'],
    ].map(([nodeId, name]) => ({
      name,
      nodeId,
      expectedStatus: 500,
      msg: { deviceRow: { deveui }, req: { body: {} } },
      libOverrides: {
        osiLib: { require: () => ({ ok: false, error: 'deployment unavailable' }) },
      },
    })),
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const db = seedScopedDb();
      try {
        if (scenario.insertLayout) insertDevice(db, { deveui, layout });
        const execution = await executeFunction(loadNode(scenario.nodeId), {
          msg: scenario.msg,
          env: scenario.env || {},
          db,
          libOverrides: scenario.libOverrides || {},
        });
        assertOneBoundedHttpResponse(
          execution,
          scenario.expectedStatus,
          `${scenario.nodeId}/${scenario.name}`
        );
      } finally {
        db.close();
      }
    });
  }
});

test('deployment adapters use declared helpers, bound EUI data, and visible resource cleanup', () => {
  for (const [id, helperMethod] of [
    ['sdi12-recipe-apply-action-fn', 'applyDesiredRecipe'],
    ['sdi12-recipe-rollback-action-fn', 'rollbackCompatibleRecipe'],
  ]) {
    const node = nodeById(id, 'function');
    assert.equal(hasLib(node, 'osiLib', 'osi-lib'), true, `${id} must bind osiLib`);
    assert.equal(hasLib(node, 'osiDb', 'osi-db-helper'), true, `${id} must bind osiDb`);
    assert.match(node.func, /osiLib\.require\('sdi12-commissioning'\)/);
    assert.match(node.func, /osiLib\.require\('chirpstack'\)/);
    assert.match(node.func, new RegExp(`\\.${helperMethod}\\(`));
    assert.match(node.func, /createProvisioningClientFromEnv\(env\)/);
    assert.match(node.func, /client\.close\(\)/);
    assert.match(node.func, /db\.close\(/);
    assert.match(node.func, /finally/);
    assert.doesNotMatch(node.func, /flushDeviceQueue/);
    assert.doesNotMatch(node.func, /fPort\s*[:=]/);
  }

  const save = nodeById('sdi12-config-action-fn', 'function');
  assert.match(save.func, /saveSentekLayout\(/);
  assert.match(save.func, /Layout saved; acquisition configuration not applied\./);
});

test('the 60-second recipe poller is isolated and failure-visible', async () => {
  const inject = nodeById('sdi12-recipe-poll-inject', 'inject');
  const poll = nodeById('sdi12-recipe-poll-fn', 'function');
  assert.equal(inject.repeat, '60');
  assert.deepEqual(inject.wires, [['sdi12-recipe-poll-fn']]);
  assert.equal(hasLib(poll, 'osiLib', 'osi-lib'), true);
  assert.equal(hasLib(poll, 'osiDb', 'osi-db-helper'), true);
  assert.match(poll.func, /pollDeployments\(/);
  assert.match(poll.func, /node\.warn\(/);
  assert.match(poll.func, /client\.close\(\)/);
  assert.match(poll.func, /db\.close\(/);
  assert.deepEqual(poll.wires, [[]]);

  const db = seedScopedDb();
  let clientClosed = false;
  try {
    const response = await executeFunction(poll, {
      msg: { payload: Date.now() },
      env: {},
      db,
      osiLibModules: {
        'sdi12-commissioning': {
          pollDeployments: async () => {
            const error = new Error('bounded poll failure');
            error.code = 'chirpstack_unavailable';
            throw error;
          },
        },
        chirpstack: {
          createProvisioningClientFromEnv: () => ({
            close: () => { clientClosed = true; return []; },
          }),
        },
      },
    });
    assert.equal(response.result, null);
    assert.equal(clientClosed, true);
    assert.equal(response.warnings.some((warning) => warning.includes('recipe poll failed')), true);
  } finally {
    db.close();
  }
});

test('Identify compiles discovery/address frames and never carries a hardcoded address', () => {
  const action = nodeById('sdi12-identify-action-fn', 'function');
  const trigger = nodeById('sdi12-identify-trigger-fn', 'function');
  const response = nodeById('sdi12-identify-fn', 'function');

  assert.match(action.func, /sdi12_channel_layout_json/);
  assert.match(action.func, /validateSentekLayout/);
  assert.match(trigger.func, /encodeIdentifyFrame\(/);
  assert.doesNotMatch(trigger.func, /0x30\s*,\s*0x49\s*,\s*0x21/);
  assert.doesNotMatch(trigger.func, /\[0xA8/);
  assert.doesNotMatch(trigger.func, /['"]0I!['"]/);
  assert.match(response.func, /\bdiscovering\b/);
  assert.match(response.func, /\^\[0-9A-Za-z\]\$/);
  assert.match(response.func, /discovered_address/);
  assert.equal(response.outputs, 2);
  assert.deepEqual(response.wires, [['sdi12-debug'], ['sdi12-identify-trigger-fn']]);
});

test('Identify discovers one address, then enqueues the addressed I command', async () => {
  const db = seedScopedDb();
  const deveui = 'A840410000000121';
  try {
    insertDevice(db, { deveui, layout: null, status: null });
    const action = await executeFunction(loadNode('sdi12-identify-action-fn'), {
      msg: {
        req: {
          method: 'POST',
          path: requestPath(deveui, '/sdi12/identify'),
          params: { deveui },
          headers: {},
        },
      },
      env: { OSI_SCOPED_ACCESS: '1', CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid' },
      db,
    });
    assert.equal(action.result[1], null);
    assert.equal(action.result[0].sdi12Identify.command, '?!');
    assert.equal(action.result[0].sdi12Identify.stage, 'discovering');

    const discoveryDownlink = await executeFunction(loadNode('sdi12-identify-trigger-fn'), {
      msg: action.result[0],
      env: {},
      db,
    });
    assert.equal(
      Buffer.from(discoveryDownlink.result[0].downlink.payload.data, 'base64').toString('hex').toUpperCase(),
      'A8023F21010100'
    );
    assert.deepEqual(
      { ...db.prepare('SELECT stage, discovered_address FROM sdi12_identify_attempts WHERE deveui = ?').get(deveui) },
      { stage: 'discovering', discovered_address: null }
    );

    const discovered = await executeFunction(loadNode('sdi12-identify-fn'), {
      msg: { sdi12: { deveui, decoded: { datas_sum: 'C' }, recordedAt: '2026-08-29T12:00:00.000Z' } },
      env: {},
      db,
    });
    assert.equal(discovered.result[0], null);
    assert.equal(discovered.result[1].sdi12Identify.command, 'CI!');
    assert.equal(discovered.result[1].sdi12Identify.discoveredAddress, 'C');

    const identifyDownlink = await executeFunction(loadNode('sdi12-identify-trigger-fn'), {
      msg: discovered.result[1],
      env: {},
      db,
    });
    assert.equal(
      Buffer.from(identifyDownlink.result[0].downlink.payload.data, 'base64').toString('hex').toUpperCase(),
      'A803434921010100'
    );
    assert.deepEqual(
      { ...db.prepare('SELECT stage, discovered_address FROM sdi12_identify_attempts WHERE deveui = ?').get(deveui) },
      { stage: 'identifying', discovered_address: 'C' }
    );
  } finally {
    db.close();
  }
});

test('Identify rejects malformed saved layouts and ambiguous discovery replies without a downlink', async () => {
  const db = seedScopedDb();
  const malformedEui = 'A840410000000122';
  const discoveryEui = 'A840410000000123';
  try {
    insertDevice(db, { deveui: malformedEui, layout: '{bad' });
    insertDevice(db, { deveui: discoveryEui, layout: null });
    db.prepare(`
      INSERT INTO sdi12_identify_attempts (
        deveui, stage, discovered_address, requested_at, updated_at
      ) VALUES (?, 'discovering', NULL, ?, ?)
    `).run(discoveryEui, '2026-08-29T11:59:00.000Z', '2026-08-29T11:59:00.000Z');

    const malformed = await executeFunction(loadNode('sdi12-identify-action-fn'), {
      msg: {
        req: {
          method: 'POST',
          path: requestPath(malformedEui, '/sdi12/identify'),
          params: { deveui: malformedEui },
          headers: {},
        },
      },
      env: { OSI_SCOPED_ACCESS: '1' },
      db,
    });
    assert.equal(malformed.result[0], null);
    assert.equal(malformed.result[1].statusCode, 409);
    assert.equal(db.prepare('SELECT 1 FROM sdi12_identify_attempts WHERE deveui = ?').get(malformedEui), undefined);

    const ambiguous = await executeFunction(loadNode('sdi12-identify-fn'), {
      msg: { sdi12: { deveui: discoveryEui, decoded: { datas_sum: 'CC' }, recordedAt: '2026-08-29T12:00:00.000Z' } },
      env: {},
      db,
    });
    assert.equal(ambiguous.result[1], null);
    assert.equal(
      db.prepare('SELECT stage FROM sdi12_identify_attempts WHERE deveui = ?').get(discoveryEui).stage,
      'discovering'
    );
  } finally {
    db.close();
  }
});

test('SDI-12 acquisition query and writer carry exact best-effort observation outcomes', async () => {
  const query = nodeById('sdi12-config-sqlite', 'sqlite');
  const queryBuilder = nodeById('sdi12-config-query-fn', 'function');
  const writer = nodeById('sdi12-write-fn', 'function');
  assert.equal(query.sqlquery, 'prepared');
  assert.match(query.sql, /LEFT JOIN sdi12_recipe_deployments/);
  assert.match(query.sql, /queue_drained_at/);
  assert.match(query.sql, /last_observed_at/);
  assert.match(query.sql, /WHERE d\.deveui = \$deveui/);
  assert.match(queryBuilder.func, /\$deveui/);
  assert.match(writer.func, /observeAcquisition\(/);
  assert.match(writer.func, /writeFailed/);
  assert.match(writer.func, /quarantined/);

  const db = seedScopedDb();
  const observations = [];
  try {
    const normalizeResult = {
      channels: { vwc_1: 12.3 },
      unknown: {},
      recordedAt: '2026-08-29T12:01:00.000Z',
      noResponse: false,
    };
    const writeResult = { inserted: true, deadLettered: [], columns: ['deveui', 'recorded_at', 'vwc_1'] };
    const response = await executeFunction(writer, {
      msg: {
        sdi12: {
          deveui: 'A840410000000124',
          fPort: 2,
          decoded: { data_sum: '+12.3' },
          recordedAt: normalizeResult.recordedAt,
        },
        payload: [{
          sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
          sdi12_probe_status: 'manual',
          sdi12_channel_layout_json: JSON.stringify({
            version: 1,
            address: 'C',
            sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' }],
          }),
          sdi12_deployment_status: 'queued',
          sdi12_deployment_queue_drained_at: '2026-08-29T12:00:00.000Z',
          sdi12_deployment_last_observed_at: null,
          chirpstack_app_id: 'app-sensors-uuid',
        }],
      },
      env: {},
      db,
      globals: { fs: { readFileSync: () => '[]' } },
      osiLibModules: {
        'sdi12-normalize': { normalize: () => normalizeResult },
        'device-writer': {
          clampRecordedAt: (value) => ({ recordedAt: value, clamped: false }),
          writeDeviceData: async () => writeResult,
        },
        'sdi12-commissioning': {
          observeAcquisition: async (_db, input) => { observations.push(input); return null; },
        },
      },
    });
    assert.equal(response.result[0].payload, writeResult);
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0].normalization, normalizeResult);
    assert.deepEqual(observations[0].outcome, {
      inserted: true,
      deadLettered: [],
      quarantined: false,
      writeFailed: false,
    });
    assert.equal(observations[0].observedAt, normalizeResult.recordedAt);
  } finally {
    db.close();
  }
});

test('observation adapter preserves telemetry across pre-drain and failed acquisition classes', async (t) => {
  const deveui = 'A840410000000132';
  const observedAt = '2026-08-29T12:04:00.000Z';
  const layout = JSON.stringify({
    version: 1,
    address: 'C',
    sensors: [
      { channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' },
      { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
    ],
  });
  const cases = [
    {
      name: 'pre-drain telemetry suppresses observation',
      queueDrainedAt: null,
      normalization: {
        channels: { vwc_1: 20.1, vwc_2: 21.2 },
        unknown: {},
        recordedAt: observedAt,
        noResponse: false,
      },
      writeResult: {
        inserted: true,
        deadLettered: [],
        columns: ['deveui', 'recorded_at', 'vwc_1', 'vwc_2'],
      },
      observationCount: 0,
      outcome: null,
    },
    {
      name: 'noResponse carries no sensor columns',
      queueDrainedAt: '2026-08-29T12:00:00.000Z',
      normalization: {
        channels: {},
        unknown: {},
        recordedAt: observedAt,
        noResponse: true,
      },
      writeResult: {
        inserted: false,
        deadLettered: [],
        columns: ['deveui', 'recorded_at'],
      },
      observationCount: 1,
      outcome: {
        inserted: false,
        deadLettered: [],
        quarantined: false,
        writeFailed: false,
      },
    },
    {
      name: 'cardinality mismatch preserves only the observed channel',
      queueDrainedAt: '2026-08-29T12:00:00.000Z',
      normalization: {
        channels: { vwc_1: 20.1 },
        unknown: {},
        recordedAt: observedAt,
        noResponse: false,
      },
      writeResult: {
        inserted: true,
        deadLettered: [],
        columns: ['deveui', 'recorded_at', 'vwc_1'],
      },
      observationCount: 1,
      outcome: {
        inserted: true,
        deadLettered: [],
        quarantined: false,
        writeFailed: false,
      },
    },
    {
      name: 'unknown channel is reported as quarantined without a fabricated column',
      queueDrainedAt: '2026-08-29T12:00:00.000Z',
      normalization: {
        channels: { vwc_1: 20.1 },
        unknown: { sdi12_extra_2: '+99.9' },
        recordedAt: observedAt,
        noResponse: false,
      },
      writeResult: {
        inserted: true,
        deadLettered: [{ channel: 'sdi12_extra_2', reason: 'unknown_channel' }],
        columns: ['deveui', 'recorded_at', 'vwc_1'],
      },
      observationCount: 1,
      outcome: {
        inserted: true,
        deadLettered: [{ channel: 'sdi12_extra_2', reason: 'unknown_channel' }],
        quarantined: true,
        writeFailed: false,
      },
    },
    {
      name: 'writer dead letter preserves accepted telemetry and exact rejection',
      queueDrainedAt: '2026-08-29T12:00:00.000Z',
      normalization: {
        channels: { vwc_1: 20.1, vwc_2: 21.2 },
        unknown: {},
        recordedAt: observedAt,
        noResponse: false,
      },
      writeResult: {
        inserted: true,
        deadLettered: [{ channel: 'vwc_2', reason: 'manifest_denied' }],
        columns: ['deveui', 'recorded_at', 'vwc_1'],
      },
      observationCount: 1,
      outcome: {
        inserted: true,
        deadLettered: [{ channel: 'vwc_2', reason: 'manifest_denied' }],
        quarantined: true,
        writeFailed: false,
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const db = seedScopedDb();
      const observations = [];
      const writerInputs = [];
      try {
        const response = await executeFunction(loadNode('sdi12-write-fn'), {
          msg: {
            sdi12: { deveui, decoded: { data_sum: '+20.1+21.2' }, recordedAt: observedAt },
            payload: [{
              sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
              sdi12_probe_status: 'manual',
              sdi12_channel_layout_json: layout,
              sdi12_deployment_status: 'queued',
              sdi12_deployment_queue_drained_at: scenario.queueDrainedAt,
            }],
          },
          env: {},
          db,
          globals: { fs: { readFileSync: () => '[]' } },
          osiLibModules: {
            'sdi12-normalize': { normalize: () => scenario.normalization },
            'device-writer': {
              clampRecordedAt: (value) => ({ recordedAt: value, clamped: false }),
              writeDeviceData: async (_db, _manifest, normalization) => {
                writerInputs.push(normalization);
                return scenario.writeResult;
              },
            },
            'sdi12-commissioning': {
              observeAcquisition: async (_db, input) => { observations.push(input); return null; },
            },
          },
        });

        assert.deepEqual(writerInputs, [scenario.normalization], 'normalization must reach the writer unchanged');
        assert.deepEqual(response.result[0].payload, scenario.writeResult, 'writer telemetry outcome must be preserved');
        assert.deepEqual(
          response.result[0].payload.columns,
          scenario.writeResult.columns,
          'the adapter must not fabricate sensor columns'
        );
        assert.equal(observations.length, scenario.observationCount);
        if (scenario.observationCount === 1) {
          assert.deepEqual(observations[0], {
            deveui,
            observedAt,
            profileId: 'SENTEK_ENVIROSCAN',
            layout,
            normalization: scenario.normalization,
            outcome: scenario.outcome,
          });
        }
      } finally {
        db.close();
      }
    });
  }
});

test('incomplete reassembly and writer failure are observed without invented readings', async () => {
  const writer = nodeById('sdi12-write-fn', 'function');
  for (const scenario of ['incomplete', 'writer_failure']) {
    const db = seedScopedDb();
    const observations = [];
    try {
      const incomplete = scenario === 'incomplete';
      const response = await executeFunction(writer, {
        msg: {
          sdi12: {
            deveui: incomplete ? 'A840410000000125' : 'A840410000000126',
            fPort: 2,
            decoded: { data_sum: '+12.3' },
            recordedAt: '2026-08-29T12:02:00.000Z',
            quarantineOnly: incomplete ? { channel: 'sdi12_incomplete', raw: 'fragment' } : undefined,
          },
          payload: [{
            sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
            sdi12_probe_status: 'manual',
            sdi12_channel_layout_json: JSON.stringify({
              version: 1,
              address: 'C',
              sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' }],
            }),
            sdi12_deployment_status: 'queued',
            sdi12_deployment_queue_drained_at: '2026-08-29T12:00:00.000Z',
          }],
        },
        env: {},
        db,
        globals: { fs: { readFileSync: () => '[]' } },
        osiLibModules: {
          'sdi12-normalize': {
            normalize: () => ({
              channels: { vwc_1: 12.3 },
              unknown: {},
              recordedAt: '2026-08-29T12:02:00.000Z',
              noResponse: false,
            }),
          },
          'device-writer': {
            clampRecordedAt: (value) => ({ recordedAt: value, clamped: false }),
            quarantineOnly: async () => undefined,
            writeDeviceData: async () => { throw new Error('write failed'); },
          },
          'sdi12-commissioning': {
            observeAcquisition: async (_db, input) => { observations.push(input); return null; },
          },
        },
      });
      assert.equal(observations.length, 1, `${scenario} must report one failed acquisition`);
      assert.equal(observations[0].outcome.inserted, false);
      assert.equal(observations[0].outcome.writeFailed, !incomplete);
      assert.equal(observations[0].outcome.quarantined, incomplete);
      if (incomplete) {
        assert.equal(observations[0].normalization, null);
        assert.deepEqual(response.result, [null, null]);
      } else {
        assert.deepEqual(response.result, [null, null]);
      }
    } finally {
      db.close();
    }
  }
});

test('an observation-state failure warns without rejecting a valid telemetry write', async () => {
  const db = seedScopedDb();
  try {
    const normalizeResult = {
      channels: { vwc_1: 12.3 },
      unknown: {},
      recordedAt: '2026-08-29T12:03:00.000Z',
      noResponse: false,
    };
    const writeResult = { inserted: true, deadLettered: [], columns: ['vwc_1'] };
    const response = await executeFunction(loadNode('sdi12-write-fn'), {
      msg: {
        sdi12: { deveui: 'A840410000000127', decoded: {}, recordedAt: normalizeResult.recordedAt },
        payload: [{
          sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
          sdi12_probe_status: 'manual',
          sdi12_channel_layout_json: JSON.stringify({
            version: 1,
            address: 'C',
            sensors: [{ channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' }],
          }),
          sdi12_deployment_status: 'queued',
          sdi12_deployment_queue_drained_at: '2026-08-29T12:00:00.000Z',
        }],
      },
      env: {},
      db,
      globals: { fs: { readFileSync: () => '[]' } },
      osiLibModules: {
        'sdi12-normalize': { normalize: () => normalizeResult },
        'device-writer': {
          clampRecordedAt: (value) => ({ recordedAt: value, clamped: false }),
          writeDeviceData: async () => writeResult,
        },
        'sdi12-commissioning': {
          observeAcquisition: async () => { throw new Error('state unavailable'); },
        },
      },
    });
    assert.equal(response.result[0].payload, writeResult);
    assert.equal(response.warnings.some((warning) => warning.includes('observation failed')), true);
  } finally {
    db.close();
  }
});

test('device list exposes only the bounded deployment projection and a valid discovered address', async () => {
  const query = nodeById('get-devices-query', 'function');
  const sqlite = nodeById('get-devices-db', 'sqlite');
  const merge = nodeById('merge-device-data', 'function');
  assert.equal(sqlite.sqlquery, 'msg.topic');
  assert.match(query.func, /LEFT JOIN sdi12_recipe_deployments/);
  assert.match(query.func, /LEFT JOIN sdi12_identify_attempts/);
  assert.match(query.func, /msg\.payload = queryParams/);
  assert.doesNotMatch(query.func, /whereClause\s*=\s*'d\.user_id = '\s*\+/);
  assert.equal(hasLib(merge, 'osiLib', 'osi-lib'), true);
  assert.doesNotMatch(merge.func, /catch\s*\([^)]*\)\s*\{\s*\}/);

  const db = seedScopedDb();
  try {
    const built = await executeFunction(query, {
      msg: { payload: [{ id: 7 }] },
      env: { OSI_SCOPED_ACCESS: '0' },
      db,
    });
    assert.match(built.result[0].topic, /d\.user_id = \$userId/);
    assert.deepEqual(built.result[0].payload, [7]);

    const response = await executeFunction(merge, {
      msg: {
        devices_to_format: [
          {
            deveui: 'A840410000000128',
            name: 'SDI-12',
            type_id: 'DRAGINO_SDI12',
            sdi12_identify_discovered_address: 'C',
            sdi12_deployment_desired_version: 3,
            sdi12_deployment_desired_layout_hash: 'hash-3',
            sdi12_deployment_desired_recipe_json: JSON.stringify({ frames: [{}, {}] }),
            sdi12_deployment_status: 'queued',
            sdi12_deployment_queue_item_ids_json: '["secret-queue-id"]',
            sdi12_deployment_queued_at: '2026-08-29T10:00:00.000Z',
            sdi12_deployment_queue_drained_at: '2026-08-29T11:00:00.000Z',
            sdi12_deployment_commissioning_deadline_at: '2026-08-29T22:00:00.000Z',
            sdi12_deployment_last_observed_at: null,
            sdi12_deployment_compatible_recipe_json: null,
            sdi12_deployment_compatible_layout_json: null,
            sdi12_deployment_compatible_at: null,
            sdi12_deployment_updated_at: '2026-08-29T11:00:00.000Z',
            sdi12_deployment_last_error_code: null,
          },
          {
            deveui: 'A840410000000129',
            name: 'Not SDI-12',
            type_id: 'DRAGINO_LSN50',
            sdi12_identify_discovered_address: 'Z',
            sdi12_deployment_desired_version: 99,
          },
        ],
        payload: [],
      },
      env: {},
      db,
    });
    const sdi12 = response.result.payload[0];
    assert.equal(sdi12.sdi12_discovered_address, 'C');
    assert.deepEqual(sdi12.sdi12_recipe_deployment, {
      desired_version: 3,
      desired_layout_hash: 'hash-3',
      status: 'queued',
      queued_at: '2026-08-29T10:00:00.000Z',
      queue_drained_at: '2026-08-29T11:00:00.000Z',
      commissioning_deadline_at: '2026-08-29T22:00:00.000Z',
      last_observed_at: null,
      compatible_at: null,
      updated_at: '2026-08-29T11:00:00.000Z',
      frame_count: 2,
      compatible_available: false,
      last_error_code: null,
    });
    assert.equal(Object.hasOwn(sdi12, 'desired_recipe_json'), false);
    assert.equal(Object.hasOwn(sdi12, 'queue_item_ids_json'), false);
    assert.equal(JSON.stringify(sdi12).includes('secret-queue-id'), false);
    assert.equal(Object.hasOwn(response.result.payload[1], 'sdi12_recipe_deployment'), false);
    assert.equal(Object.hasOwn(response.result.payload[1], 'sdi12_discovered_address'), false);
  } finally {
    db.close();
  }
});

test('Apply and Rollback action nodes return 202 projections and map non-contract statuses to 500', async () => {
  for (const [id, helperMethod] of [
    ['sdi12-recipe-apply-action-fn', 'applyDesiredRecipe'],
    ['sdi12-recipe-rollback-action-fn', 'rollbackCompatibleRecipe'],
  ]) {
    const db = seedScopedDb();
    let clientClosed = false;
    const calls = [];
    try {
      const response = await executeFunction(loadNode(id), {
        msg: { deviceRow: { deveui: 'A840410000000130' }, req: { body: {} } },
        env: {},
        db,
        osiLibModules: {
          'sdi12-commissioning': {
            [helperMethod]: async (_db, _client, deveui, options) => {
              calls.push({ deveui, options });
              return { statusCode: 202, deployment: { desired_version: 4, status: 'queued' } };
            },
          },
          chirpstack: {
            createProvisioningClientFromEnv: () => ({
              close: () => { clientClosed = true; return []; },
            }),
          },
        },
      });
      assert.equal(response.result.statusCode, 202);
      assert.deepEqual(response.result.payload, { desired_version: 4, status: 'queued' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].deveui, 'A840410000000130');
      assert.equal(Number.isFinite(Date.parse(calls[0].options.now)), true);
      assert.equal(clientClosed, true);

      const failed = await executeFunction(loadNode(id), {
        msg: { deviceRow: { deveui: 'A840410000000130' }, req: { body: {} } },
        env: {},
        db,
        osiLibModules: {
          'sdi12-commissioning': {
            [helperMethod]: async () => {
              throw Object.assign(new Error('external detail must not leak'), {
                statusCode: 502,
                code: 'chirpstack_unavailable',
              });
            },
          },
          chirpstack: {
            createProvisioningClientFromEnv: () => ({ close: () => [] }),
          },
        },
      });
      assert.equal(failed.result.statusCode, 500);
      assert.equal(failed.result.payload.code, 'chirpstack_unavailable');
      assert.equal(JSON.stringify(failed.result.payload).includes('external detail'), false);
    } finally {
      db.close();
    }
  }
});
