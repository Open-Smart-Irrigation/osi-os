'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { executeFunction, makeAuthHeader, profilePaths, seedScopedDb } = require('./lib/scoped-access-harness');
const { stageGx4Flows } = require('./fixtures/release-1.0/stage-gx4-flows');
const { removeRoutes, editFunction } = require('./fixtures/release-1.0/gx4-flows.patch.json');

const EUI = 'A840410000000001';
const GATEWAY = '0016C001F1000001';
const UC512 = 'MILESIGHT_UC512';
const SECRET = 'release-fixture-secret';
const env = {
  DEVICE_EUI: GATEWAY,
  AUTH_TOKEN_SECRET: SECRET,
  CHIRPSTACK_APP_ACTUATORS: 'fixture-actuators',
  CHIRPSTACK_PROFILE_UC512: 'fixture-profile',
};
const unavailable = /(?:\/history\/(?:workspaces(?:\/|$)|.*\/advanced$)|\/analysis\/views(?:\/|$))/i;
const uc512FlowRefs = new Set([
  'catalog-response', 'post-devices-auth', 'post-devices-insert', '934bf2bc19a8ce22',
  'cs-reg-cloud-fn', 'sync-init-fn', 'cmd-type-registry', 'reject-indefinite-open',
  'write-strega-expectation', 'c571729fb2943059', '6b28e0d879808dd9', 'a2fc996126ab0cdd',
]);

function request(method, url, params = {}, query = {}, payload) {
  const authorization = makeAuthHeader({ userId: 2, username: 'res1', secret: SECRET });
  return { _msgid: 'release-fixture', req: { method, path: url, params, query, headers: { authorization }, body: payload }, payload };
}

function requestHandler(flows, method, url) {
  const parts = url.split('/');
  const registrations = flows.filter((node) => {
    if (node.type !== 'http in' || node.d || node.method.toUpperCase() !== method) return false;
    const pattern = node.url.split('/');
    return pattern.length === parts.length && pattern.every((part, i) => part.startsWith(':') || part === parts[i]);
  });
  assert.ok(registrations.length <= 1, `${method} ${url}: duplicate registration`);
  if (registrations.length === 0) return null;
  const [registration] = registrations;
  assert.equal(registration.wires[0].length, 1, registration.id);
  const handler = flows.find((node) => node.id === registration.wires[0][0]);
  assert.equal(handler?.type, 'function', registration.id);
  return handler;
}

const stagedProfiles = [];
for (const profile of ['bcm2712', 'bcm2709']) {
  const { flowsPath, nodeRedModules } = profilePaths(profile);
  const source = fs.readFileSync(flowsPath, 'utf8');
  const flows = JSON.parse(source);
  const run = (node, db, msg, overrides = {}) => executeFunction(node, { db, msg, env, nodeRedModules, ...overrides });
  const node = (id) => flows.find((candidate) => candidate.id === id);
  // The lead can remove the staging call after landing both rewired profiles.
  const staged = stageGx4Flows(source);
  stagedProfiles.push(JSON.stringify(staged));
  async function http(flow, db, msg) {
    const handler = requestHandler(flow, msg.req.method, msg.req.path);
    if (!handler) return { statusCode: 404 }; // No registered Node-RED HTTP input.
    const { result, errors } = await run(handler, db, msg);
    assert.deepEqual(errors, []);
    return Array.isArray(result) ? result[0] : result;
  }

  test(`${profile}: UC512 registers no outlet routes, executor or capability`, () => {
    for (const entry of flows) {
      if (entry.type === 'http in') assert.doesNotMatch(entry.url, /uc512|\/outlets?(?:\/|$)/i);
      const runtime = [entry.name, entry.topic, entry.func, entry.initialize, entry.finalize].join('\n');
      if (/uc512/i.test(runtime)) {
        assert.ok(uc512FlowRefs.has(entry.id), `${entry.id}: review new UC512 wiring (${entry.name})`);
      }
      assert.doesNotMatch(runtime, /uc512[^\n]{0,80}capabilit|capabilit[^\n]{0,80}uc512/i, entry.id);
    }
    // A UC512-specific runtime directory currently contains only the uplink
    // normalizer. Existing registration, history projection, and codec are shared.
    const dirs = fs.readdirSync(nodeRedModules).filter((name) => /uc512/i.test(name));
    assert.deepEqual(dirs, ['osi-uc512-normalize']);
    const inlet = flows.find((entry) => entry.type === 'mqtt in' && entry.name === 'UC512 IN');
    assert.equal(inlet.topic, 'application/+/device/+/event/up');
    const [writerId] = inlet.wires[0];
    assert.equal(node(writerId).name, 'UC512 Normalize + Write');
    assert.ok(node(writerId).wires.flat().every((id) => node(id).type === 'debug'));
  });

  test(`${profile}: timed UC512 pending command reaches permanent rejection only`, async () => {
    const db = seedScopedDb(EUI);
    try {
      db.prepare('UPDATE devices SET type_id = ? WHERE deveui = ?').run(UC512, EUI);
      const command = {
        commandType: 'UC512_OPEN_FOR_DURATION',
        commandId: '561',
        payload: { device_eui: EUI, actor_user_uuid: 'u-res1', duration_seconds: 600 },
      };
      const { result: replayed } = await run(node('sync-pending-split'), db, { statusCode: 200, payload: [command] });
      const msg = replayed[0][0];
      const registry = await run(node('cmd-type-registry'), db, {});
      assert.deepEqual(
        Object.keys(registry.flowState.command_types).filter((type) => type.startsWith('UC512_')),
        ['UC512_OPEN_FOR_DURATION'],
      );
      const { result: accepted } = await run(node('reject-indefinite-open'), db, msg, { flowState: registry.flowState });
      assert.equal(accepted._commandTypeRecognized, true);
      assert.equal(accepted.payload.duration_seconds, 600);
      const route = flows.find((entry) => entry.name === 'Route Command');
      const { result: output } = await run(route, db, accepted);
      assert.deepEqual(output.flatMap((item, index) => item ? route.wires[index] : []), [
        '9d5e3035c3d069c4', 'command-ack-queue-rest',
      ], 'only the ACK output is wired');
      const [ack] = output.filter(Boolean);
      assert.deepEqual(JSON.parse(ack.payload), {
        commandId: '561',
        eventUuid: null,
        aggregateType: null,
        aggregateKey: null,
        commandType: 'UC512_OPEN_FOR_DURATION',
        result: 'REJECTED_PERMANENT',
        reason: 'no_dispatcher_on_gateway',
        appliedSyncVersion: null,
      });
      const persisted = await run(node('command-ack-queue-rest'), db, ack);
      assert.deepEqual(persisted.errors, []);
      const durableAck = db.prepare('SELECT payload_json FROM command_ack_outbox WHERE command_id = ?').get('561');
      assert.equal(JSON.parse(durableAck.payload_json).result, 'REJECTED_PERMANENT');
      assert.equal(db.prepare('SELECT count(*) AS n FROM valve_actuation_expectations').get().n, 0);
    } finally {
      db.close();
    }
  });

  test(`${profile}: ordinary local valve control and schedules refuse a registered UC512`, async () => {
    const db = seedScopedDb(EUI);
    try {
      db.prepare('UPDATE devices SET type_id = ? WHERE deveui = ?').run(UC512, EUI);
      const valvePath = `/api/valve/${EUI}`;
      const handler = requestHandler(flows, 'POST', valvePath);
      const { result: [authorized] } = await run(handler, db, request('POST', valvePath, { deveui: EUI }, {}, {
        action: 'OPEN_FOR_DURATION', duration_minutes: 2,
      }));
      const userLookup = node(handler.wires[0][0]);
      authorized.payload = db.prepare(authorized.topic).all();
      const ownership = node(userLookup.wires[0][0]);
      const { result: [deviceQuery] } = await run(ownership, db, authorized);
      deviceQuery.payload = db.prepare(deviceQuery.topic).all();
      const deviceLookup = node(ownership.wires[0][0]);
      const { result: manual } = await run(node(deviceLookup.wires[0][0]), db, deviceQuery);
      assert.equal(manual[0], null, 'no actuator output');
      assert.match(manual[2].payload.message, /not a STREGA_VALVE/);

      const url = `/api/valves/${EUI}/schedules`;
      const schedules = requestHandler(flows, 'GET', url);
      const { result: [response, dispatch] } = await run(schedules, db, request('GET', url, { deveui: EUI }), {
        libOverrides: { chirpstack: { createProvisioningClientFromEnv: assert.fail } },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(dispatch?.length ?? 0, 0);
    } finally {
      db.close();
    }
  });

  test(`${profile}: UC512 registration and uplink keep their Actuators profile and six readings`, async () => {
    const db = seedScopedDb();
    try {
      const catalog = await run(node('catalog-response'), db, {});
      assert.match(JSON.stringify(catalog.result.payload), /MILESIGHT_UC512/);
      const body = { deveui: EUI, name: 'Valve fixture', type_id: UC512, appkey: 'A'.repeat(32) };
      const route = requestHandler(flows, 'POST', '/api/devices');
      const { result: [claim] } = await run(route, db, request('POST', '/api/devices', {}, {}, body));
      const { result: [userQuery], flowState } = await run(node(route.wires[0][0]), db, claim);
      const user = db.prepare(userQuery.topic).get();
      assert.equal(user.id, 2);
      const { result: [insert] } = await run(node('post-devices-insert'), db, { payload: [] }, {
        flowState: { ...flowState, new_device_user_id: user.id },
      });
      assert.equal(insert.deviceRegistration.applicationId, env.CHIRPSTACK_APP_ACTUATORS);
      assert.equal(insert.deviceRegistration.deviceProfileId, env.CHIRPSTACK_PROFILE_UC512);
      db.exec(insert.topic);
      const vector = require('./fixtures/device-integration/uc512/golden-vectors.json')[2];
      const codecSource = fs.readFileSync(path.join(nodeRedModules, 'codecs/milesight_uc512_decoder.js'), 'utf8');
      const codec = require('node:vm').runInNewContext(codecSource + '\n({ decodeUplink, encodeValveTask });');
      assert.equal(typeof codec.encodeValveTask, 'function');
      const { data } = codec.decodeUplink({ bytes: vector.bytes, fPort: 1 });
      const uplink = await run(node('6b28e0d879808dd9'), db, {
        payload: {
          deviceInfo: { devEui: EUI, deviceProfileId: env.CHIRPSTACK_PROFILE_UC512 },
          object: data,
          time: '2026-11-20T08:00:00.000Z',
          fCnt: 1,
        },
      }, { globals: { fs: { readFileSync: () => fs.readFileSync(path.join(nodeRedModules, 'edge-channels.json')) } } });
      assert.deepEqual(uplink.errors, []);
      const readings = db.prepare('SELECT bat_pct, valve_1_state, valve_2_state, valve_1_pulse, valve_2_pulse, pipe_pressure_kpa FROM device_data WHERE deveui = ?').get(EUI);
      assert.deepEqual(Object.values(readings), [92, 'close', 'open', 100, 200, 30]);
    } finally {
      db.close();
    }
  });

  test(`${profile}: staged GX4 cut refuses deferred HTTP requests and keeps the ordinary paths`, async () => {
    assert.equal(staged.find((entry) => entry.id === editFunction.id).type, 'function');
    for (const entry of staged.filter((candidate) => candidate.type === 'http in')) {
      assert.doesNotMatch(entry.url, unavailable);
    }
    const db = seedScopedDb(EUI);
    try {
      db.exec(`
        INSERT INTO history_workspaces (id, user_id, zone_id, name, workspace_json)
        VALUES (1, 2, 1, 'Existing workspace', '{"layout":"stacked"}');
        INSERT INTO analysis_views (id, user_id, name, view_json)
        VALUES (1, 2, 'Existing view', '{"mode":"correlation"}');
      `);
      for (const route of removeRoutes) {
        const url = route.url.replaceAll(/:[a-zA-Z]+/g, '1');
        const result = await http(staged, db, request(route.method.toUpperCase(), url, {}, {}, {
          name: 'Existing view', workspace: { layout: 'stacked' }, viewJson: { mode: 'correlation' },
        }));
        assert.equal(result.statusCode, 404, `${route.method} ${url}`);
      }
      assert.equal(db.prepare('SELECT workspace_json FROM history_workspaces WHERE id = 1').get().workspace_json, '{"layout":"stacked"}');
      assert.equal(db.prepare('SELECT view_json FROM analysis_views WHERE id = 1').get().view_json, '{"mode":"correlation"}');
      const card = { zoneId: '1', cardId: 'z-1:soil:root-zone' };
      const url = `/api/history/zones/1/cards/${card.cardId}/data`;
      const denied = await http(staged, db, request('GET', url, card, { view: ' advanced ' }));
      assert.equal(denied.statusCode, 404);
      assert.equal(denied.payload.error, 'Not found');
      const gatewayCard = { gatewayEui: GATEWAY, cardId: 'gateway-hub' };
      const gateway = `/api/history/gateways/${GATEWAY}/cards/${gatewayCard.cardId}/data`;
      const gatewayDenied = await http(staged, db, request('GET', gateway, gatewayCard, { view: 'advanced' }));
      assert.equal(gatewayDenied.statusCode, 404);
      assert.equal(gatewayDenied.payload.error, 'Not found');

      const cards = await http(staged, db, request('GET', '/api/history/zones/1/cards', { zoneId: '1' }));
      assert.equal(cards.statusCode, 200);
      assert.ok(cards.payload.cards.length);
      const basicCard = cards.payload.cards.find((entry) => entry.cardType === 'irrigation');
      const cardData = `/api/history/zones/1/cards/${basicCard.cardId}/data`;
      assert.equal((await http(staged, db, request('GET', cardData, { zoneId: '1', cardId: basicCard.cardId },
        { view: 'event-timeline', range: '24h' }))).statusCode, 200);

      const catalog = await http(staged, db, request('GET', '/api/analysis/channels'));
      assert.equal(catalog.statusCode, 200);
      assert.ok(Array.isArray(catalog.payload.channels));
      const series = await http(staged, db, request('POST', '/api/analysis/series', {}, {}, {
        selectors: [{ seriesId: catalog.payload.channels.find((entry) => entry.availability === 'available').seriesId }],
        range: { mode: 'relative', label: '24h', from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' }, aggregation: 'auto',
      }));
      assert.equal(series.statusCode, 200, JSON.stringify(series.payload));
      assert.equal(series.payload.series.length, 1);
      for (const exportUrl of ['/api/history/zones/1/export.csv', '/api/history/export.csv']) {
        const exported = await http(staged, db, request('GET', exportUrl, { zoneId: '1' }, {
          from: '2026-11-20', to: '2026-11-20', scope: 'allZones',
        }));
        assert.equal(exported.statusCode, 200, JSON.stringify(exported.payload));
        assert.match(exported.payload, /timestamp,site,zone/);
      }
    } finally {
      db.close();
    }
  });
}

test('the two staged flows remain byte-identical', () => {
  assert.equal(stagedProfiles[0], stagedProfiles[1]);
});
