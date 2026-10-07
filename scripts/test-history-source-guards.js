#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  executeFunction,
  facadeDb,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
const CHANNELS = [
  { id: 'swt_1', field: 'swt_1', unit: 'kPa' },
  { id: 'swt_2', field: 'swt_2', unit: 'kPa' },
  { id: 'swt_3', field: 'swt_3', unit: 'kPa' },
];
const PLAIN = { deveui: 'A840410000000001', type_id: 'DRAGINO_LSN50', temp_enabled: 0, soil_moisture_probe_depths_json: '[10,20,30]' };
const CHAMELEON = { deveui: 'A840410000000002', type_id: 'DRAGINO_LSN50', chameleon_enabled: 1, chameleon_swt1_depth_cm: 15, chameleon_swt2_depth_cm: 35, chameleon_swt3_depth_cm: 55 };
const AUTH_SECRET = 'scoped-access-test-secret';
const ENV = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' };

function historyRequest(userId, username, method, requestPath, params, query = {}) {
  return {
    req: {
      method,
      path: requestPath,
      params,
      query,
      headers: { authorization: makeAuthHeader({ userId, username, secret: AUTH_SECRET }) },
    },
    payload: {},
  };
}

function historyProfile(profile) {
  const profileRoot = path.join(ROOT, 'conf', profile, 'files/usr/share/node-red');
  return {
    helper: require(path.join(profileRoot, 'osi-history-helper')),
    router: require(path.join(profileRoot, 'osi-history-router')),
    node: loadNode('history-api-router-fn', path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json')),
  };
}

function seedMixedSourceData(db) {
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, temp_enabled,
      chameleon_enabled, chameleon_swt1_depth_cm, chameleon_swt3_depth_cm,
      created_at, updated_at
    ) VALUES
      ('A840410000000011', 'Plain LSN50', 'DRAGINO_LSN50', 2, 1, 0, 0, NULL, NULL, '2026-01-01', '2026-01-01'),
      ('A840410000000012', 'Chameleon LSN50', 'DRAGINO_LSN50', 2, 1, 0, 1, 15, 55, '2026-01-01', '2026-01-01'),
      ('A840410000000013', 'LoRain', 'AQUASCOPE_LORAIN', 2, 1, 0, 0, NULL, NULL, '2026-01-01', '2026-01-01'),
      ('A840410000000014', 'Other environment', 'SENSECAP_S2120', 2, 1, 0, 0, NULL, NULL, '2026-01-01', '2026-01-01');
    INSERT INTO device_data (deveui, recorded_at, swt_1, swt_3, rain_tips_delta, ambient_temperature)
    VALUES
      ('A840410000000011', '2026-01-02T08:00:00.000Z', NULL, 99, NULL, NULL),
      ('A840410000000012', '2026-01-02T08:00:00.000Z', 12, 0, NULL, NULL),
      ('A840410000000013', '2026-01-02T08:00:00.000Z', NULL, NULL, 0, NULL),
      ('A840410000000013', '2026-01-02T08:30:00.000Z', NULL, NULL, 2, NULL),
      ('A840410000000014', '2026-01-02T08:00:00.000Z', NULL, NULL, NULL, 21);
  `);
}

function sourceKey(cardType, deveui) {
  return `${cardType}-src-${crypto.createHash('sha256').update(deveui).digest('hex').slice(0, 12)}`;
}

for (const profile of PROFILES) {
  const helper = require(path.join(ROOT, 'conf', profile, 'files/usr/share/node-red/osi-history-helper'));
  const router = require(path.join(ROOT, 'conf', profile, 'files/usr/share/node-red/osi-history-router'));

  test(`${profile}: history API wrapper delegates WATERMARK evidence, card rollup gating and all-zones export`, () => {
    const flows = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json'), 'utf8'));
    const source = flows.find((entry) => entry.id === 'history-api-router-fn').func;
    assert.match(source, /osiHistory\.annotateWatermarkEvidence\(db/);
    // shouldUseCardRollups applies the range/aggregation rule itself and forces
    // raw reads for a soil card that has an SWT3-ineligible LSN50 source.
    assert.match(source, /HR\.shouldUseCardRollups\(card, allSourceDevices, scopeContext, range\.label, aggregationRequested\)/);
    // The all-zones export runs in the history router's portable adapter.
    const routerSource = fs.readFileSync(path.join(ROOT, 'conf', profile, 'files/usr/share/node-red/osi-history-router/index.js'), 'utf8');
    assert.match(routerSource, /history\.buildAllZonesExportCsv\(db/);
  });

  test(`${profile}: source guards keep WATERMARK evidence, Chameleon SWT3 and the raw fallback`, async () => {
    const db = {
      all(sql, params, callback) {
        assert.match(sql, /watermark_calibrations/);
        assert.deepEqual(params, [PLAIN.deveui, 'A840410000000003', 'A840410000000004']);
        callback(null, [{ eui: PLAIN.deveui }, { eui: 'A840410000000003' }]);
      },
    };
    const annotated = await helper.annotateWatermarkEvidence(db, [PLAIN, { deveui: 'A840410000000003', type_id: 'DRAGINO_LSN50', temp_enabled: 1 }, { deveui: 'A840410000000004', type_id: 'DRAGINO_LSN50', temp_enabled: 1 }]);
    assert.equal(annotated[0].watermark_evidence, 1);
    assert.equal(annotated[1].watermark_evidence, 1);
    assert.equal(annotated[2].watermark_evidence, 0);
    assert.equal(helper.isSoilSource(annotated[0]), true);
    assert.equal(helper.isSoilSource(annotated[1]), true);
    assert.equal(helper.isSoilSource(annotated[2]), false);
    assert.equal(helper.isSoilSource({ ...PLAIN, dendro_enabled: 1, watermark_evidence: 1 }), false);
    assert.equal(helper.isSoilSource(CHAMELEON), true);

    const rows = [
      { deveui: PLAIN.deveui, recorded_at: '2025-10-01 00:00:00', swt_1: 10, swt_2: 20, swt_3: 30 },
      { deveui: CHAMELEON.deveui, recorded_at: '2025-10-01T00:20:00.000Z', swt_1: 11, swt_2: 21, swt_3: 31 },
    ];
    const aggregate = helper.aggregateRows(rows, {
      channels: CHANNELS,
      sourceDevices: [PLAIN, CHAMELEON],
      aggregation: 'raw',
      start: '2025-10-01T00:00:00.000Z',
      end: '2025-10-01T01:00:00.000Z',
    });
    assert.deepEqual(aggregate.series.swt_3.points, [{ recordedAt: '2025-10-01T00:20:00.000Z', value: 31 }]);
    assert.equal(aggregate.channelSourceKeys.swt_3, CHAMELEON.deveui);

    const plainCard = { cardType: 'soil' };
    const rawSeries = router.buildSeriesFromAggregate(plainCard, {
      aggregation: 'raw',
      coverageConfidence: 'unknown',
      channelSourceKeys: { swt_1: PLAIN.deveui, swt_2: PLAIN.deveui },
      series: {
        swt_1: { points: [{ recordedAt: '2025-10-01T00:00:00.000Z', value: 10 }] },
        swt_2: { points: [{ recordedAt: '2025-10-01T00:00:00.000Z', value: 20 }] },
        swt_3: { points: [{ recordedAt: '2025-10-01T00:00:00.000Z', value: 30 }] },
      },
    }, [PLAIN], {});
    assert.deepEqual(rawSeries.map((series) => series.id), ['swt_1', 'swt_2']);
    assert.deepEqual(rawSeries.map((series) => series.depthCm), [10, 20]);
    assert.equal(router.shouldUseCardRollups(plainCard, [PLAIN], { scope: 'zone' }, '30d', 'auto'), false);

    const chameleonSeries = router.buildSeriesFromAggregate(plainCard, {
      aggregation: 'raw',
      coverageConfidence: 'unknown',
      channelSourceKeys: { swt_1: CHAMELEON.deveui, swt_2: CHAMELEON.deveui, swt_3: CHAMELEON.deveui },
      series: {
        swt_1: { points: [{ recordedAt: '2025-10-01T00:00:00.000Z', value: 10 }] },
        swt_2: { points: [{ recordedAt: '2025-10-01T00:00:00.000Z', value: 20 }] },
        swt_3: { points: [{ recordedAt: '2025-10-01T00:00:00.000Z', value: 30 }] },
      },
    }, [CHAMELEON], {});
    assert.deepEqual(chameleonSeries.map((series) => series.id), ['swt_1', 'swt_2', 'swt_3']);
    assert.deepEqual(chameleonSeries.map((series) => series.depthCm), [15, 35, 55]);
    assert.equal(router.shouldUseCardRollups(plainCard, [CHAMELEON], { scope: 'zone' }, '30d', 'auto'), true);
  });

  test(`${profile}: extracted history route returns soil profile depth and value`, async () => {
    const { helper, router, node } = historyProfile(profile);
    const db = seedScopedDb();
    seedMixedSourceData(db);
    try {
      const cardId = helper.deriveCardId({ zoneUuid: 'z-1', cardType: 'soil' });
      const response = await executeFunction(node, {
        msg: historyRequest(2, 'res1', 'GET', `/api/history/zones/1/cards/${cardId}/data`, { zoneId: '1', cardId }, { range: '24h' }),
        env: ENV,
        db,
        libOverrides: { osiHistory: helper, HR: router },
      });
      assert.equal(response.result && response.result.statusCode, 200, JSON.stringify(response.result && response.result.payload));
      const payload = response.result.payload;
      assert.equal(payload.cardId, cardId);
      const swt1 = payload.profiles.find((profileEntry) => profileEntry.id === 'swt_1');
      assert.ok(swt1, 'soil profile SWT1 is present');
      assert.equal(swt1.depthCm, 15);
      assert.equal(swt1.value, 12);
    } finally {
      db.close();
    }
  });

  test(`${profile}: mixed-device filtered exports preserve supported soil and LoRain rows`, async () => {
    const { helper, router, node } = historyProfile(profile);
    const db = seedScopedDb();
    seedMixedSourceData(db);
    try {
      for (const [channel, expectedSource, expectedValue] of [
        ['swt_3', sourceKey('soil', 'A840410000000012'), 0],
        ['rain_tips_delta', sourceKey('environment', 'A840410000000013'), 0],
      ]) {
        for (const granularity of ['raw', 'hourly', 'daily']) {
          const result = await helper.buildZoneExportCsv(facadeDb(db), {
            zoneId: 1,
            from: '2026-01-02',
            to: '2026-01-02',
            granularity,
            channels: channel,
            site: 'TEST',
            nowMs: Date.parse('2026-01-03T00:00:00.000Z'),
          });
          const rows = result.rows.filter((row) => row.channel_key === channel);
          const expected = channel === 'rain_tips_delta' && granularity !== 'raw' ? 2 : expectedValue;
          assert.ok(rows.some((row) => row.source_key && row.value === expected), `${granularity} ${channel} keeps expected value: ${JSON.stringify(rows)}`);
          assert.ok(rows.every((row) => row.source_key === expectedSource), `${granularity} ${channel} excludes unsupported devices: ${JSON.stringify(rows)}`);
        }
      }

      const routeMsg = historyRequest(2, 'res1', 'GET', '/api/history/zones/1/export.csv', { zoneId: '1' }, {
        from: '2026-01-02',
        to: '2026-01-02',
        granularity: 'hourly',
        channels: 'swt_3',
      });
      const routeResponse = await executeFunction(node, {
        msg: routeMsg,
        env: ENV,
        db,
        libOverrides: { osiHistory: helper, HR: router },
      });
      assert.equal(routeResponse.result && routeResponse.result.statusCode, 200, JSON.stringify(routeResponse.result && routeResponse.result.payload));
      assert.match(routeResponse.result.payload, /swt_3/);
      assert.match(routeResponse.result.payload, new RegExp(sourceKey('soil', 'A840410000000012')));
      assert.doesNotMatch(routeResponse.result.payload, new RegExp(sourceKey('soil', 'A840410000000011')));
    } finally {
      db.close();
    }
  });
}
