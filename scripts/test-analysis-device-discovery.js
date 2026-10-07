#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  executeFunction,
  facadeDb,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');
const hh = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper');
const scopeHelper = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper');

const SECRET = 'scoped-access-test-secret';
const SCOPED = { AUTH_TOKEN_SECRET: SECRET, OSI_SCOPED_ACCESS: '1', DEVICE_EUI: '0016C001F1000002' };
const FLAG_OFF = { AUTH_TOKEN_SECRET: SECRET, OSI_SCOPED_ACCESS: '0', DEVICE_EUI: '0016C001F1000002' };

function request(userId, username, method, path, body = {}, query = {}) {
  return {
    req: {
      method,
      path,
      query,
      params: {},
      body,
      headers: { authorization: makeAuthHeader({ userId, username, secret: SECRET }) },
    },
    payload: {},
  };
}

async function route(db, userId, username, method, path, env, body = {}, query = {}) {
  return executeFunction(loadNode('analysis-api-router-fn'), {
    msg: request(userId, username, method, path, body, query),
    env,
    db,
  });
}

function addDiscoveryRows(db) {
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
    VALUES
      ('A8404100000000D1', 'Owner unassigned', 'KIWI_SENSOR', 2, NULL, '2026-01-01', '2026-01-01'),
      ('A8404100000000D2', 'Foreign unassigned', 'KIWI_SENSOR', 1, NULL, '2026-01-01', '2026-01-01'),
      ('A8404100000000D3', 'Unclaimed', 'KIWI_SENSOR', NULL, NULL, '2026-01-01', '2026-01-01'),
      ('A8404100000000D4', 'Cloud assigned', 'KIWI_SENSOR', NULL, 1, '2026-01-01', '2026-01-01'),
      ('A8404100000000D5', 'Deleted unassigned', 'KIWI_SENSOR', 2, NULL, '2026-01-01', '2026-01-01'),
      ('A8404100000000D6', 'Reassigned unassigned', 'KIWI_SENSOR', 2, NULL, '2026-01-01', '2026-01-01');
    UPDATE devices SET deleted_at = '2026-01-03T00:00:00.000Z' WHERE deveui = 'A8404100000000D5';
    INSERT INTO device_data (deveui, recorded_at, swt_1) VALUES
      ('A8404100000000D1', '2026-01-02T08:00:00.000Z', 12),
      ('A8404100000000D2', '2026-01-02T08:00:00.000Z', 13),
      ('A8404100000000D3', '2026-01-02T08:00:00.000Z', 14);
  `);
}

function channelByDevice(payload, name) {
  return (payload.channels || []).find((entry) => entry.deviceName === name && entry.channelKey === 'swt_1');
}

test('flag-off analysis discovers only the authenticated owner unassigned device', async () => {
  const db = seedScopedDb();
  addDiscoveryRows(db);
  try {
    const response = await route(db, 2, 'res1', 'GET', '/api/analysis/channels', FLAG_OFF);
    assert.equal(response.result.statusCode, 200);
    assert.ok(channelByDevice(response.result.payload, 'Owner unassigned'));
    assert.equal(channelByDevice(response.result.payload, 'Foreign unassigned'), undefined);
    assert.equal(channelByDevice(response.result.payload, 'Unclaimed'), undefined);
    assert.equal(channelByDevice(response.result.payload, 'Deleted unassigned'), undefined);
    assert.equal(channelByDevice(response.result.payload, 'Owner unassigned').zoneId, null);
  } finally {
    db.close();
  }
});

test('scoped analysis discovers all claimed unassigned devices and keeps cloud-assigned live zones', async () => {
  const db = seedScopedDb();
  addDiscoveryRows(db);
  try {
    const response = await route(db, 3, 'view1', 'GET', '/api/analysis/channels', SCOPED);
    assert.equal(response.result.statusCode, 200);
    for (const name of ['Owner unassigned', 'Foreign unassigned']) assert.ok(channelByDevice(response.result.payload, name), name);
    assert.equal(channelByDevice(response.result.payload, 'Unclaimed'), undefined);
    assert.equal(channelByDevice(response.result.payload, 'Deleted unassigned'), undefined);
    assert.ok(channelByDevice(response.result.payload, 'Cloud assigned'));
    assert.equal(channelByDevice(response.result.payload, 'Owner unassigned').zoneId, null);
  } finally {
    db.close();
  }
});

test('scoped zero-zone account resolves an unassigned series in UTC', async () => {
  const db = seedScopedDb();
  db.exec('DELETE FROM irrigation_zones');
  db.exec(`
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
    VALUES ('A8404100000000DA', 'Zero zone gauge', 'KIWI_SENSOR', 3, NULL, '2026-01-01', '2026-01-01');
    INSERT INTO device_data (deveui, recorded_at, swt_1)
    VALUES ('A8404100000000DA', '2026-01-02T08:00:00.000Z', 21);
  `);
  try {
    const catalog = await route(db, 3, 'view1', 'GET', '/api/analysis/channels', SCOPED);
    assert.equal(catalog.result.statusCode, 200);
    const channel = channelByDevice(catalog.result.payload, 'Zero zone gauge');
    assert.ok(channel);
    assert.equal(channel.zoneId, null);
    assert.equal(channel.zoneName, null);
    assert.equal(channel.seriesId, hh.analysisSeriesId('unassigned', channel.cardType, channel.sourceKey, channel.channelKey));
    const series = await route(db, 3, 'view1', 'POST', '/api/analysis/series', SCOPED, {
      selectors: [{ seriesId: channel.seriesId }],
      range: { from: '2026-01-02T07:00:00.000Z', to: '2026-01-02T09:00:00.000Z' },
      aggregation: 'raw',
      unassignedAccess: 'none',
    });
    assert.equal(series.result.statusCode, 200);
    assert.equal(series.result.payload.series.length, 1);
    assert.equal(series.result.payload.series[0].resolved.zoneId, null);
    assert.equal(series.result.payload.series[0].timezone, 'UTC');
  } finally {
    db.close();
  }
});

test('analysis channels projects sources explicitly without private catalogue context', async () => {
  const db = seedScopedDb();
  addDiscoveryRows(db);
  try {
    const response = await route(db, 3, 'view1', 'GET', '/api/analysis/channels', SCOPED);
    assert.equal(response.result.statusCode, 200);
    assert.ok(Array.isArray(response.result.payload.sources));
    assert.equal(Object.prototype.hasOwnProperty.call(response.result.payload, 'entriesById'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(response.result.payload, 'entriesById'), false);
  } finally {
    db.close();
  }
});

test('analysis authentication rejects missing and forged bearer tokens', async () => {
  const db = seedScopedDb();
  try {
    const missing = await executeFunction(loadNode('analysis-api-router-fn'), {
      msg: { req: { method: 'GET', path: '/api/analysis/channels', headers: {}, query: {} }, payload: {} },
      env: SCOPED,
      db,
    });
    assert.equal(missing.result.statusCode, 401);
    const forged = await route(db, 3, 'view1', 'GET', '/api/analysis/channels', {
      ...SCOPED,
      AUTH_TOKEN_SECRET: 'wrong-secret',
    });
    assert.equal(forged.result.statusCode, 401);
  } finally {
    db.close();
  }
});

test('disabled scoped accounts receive 403 for analysis channels, series, and views', async () => {
  const db = seedScopedDb();
  db.prepare("UPDATE users SET disabled_at = '2026-01-03T00:00:00.000Z' WHERE id = 3").run();
  scopeHelper._resetForTests();
  try {
    for (const [method, path, body] of [
      ['GET', '/api/analysis/channels', {}],
      ['POST', '/api/analysis/series', {
        selectors: [{ seriesId: 'unknown' }],
        range: { from: '2026-01-02T07:00:00.000Z', to: '2026-01-02T09:00:00.000Z' },
      }],
      ['GET', '/api/analysis/views', {}],
    ]) {
      const response = await route(db, 3, 'view1', method, path, SCOPED, body);
      assert.equal(response.result.statusCode, 403, `${method} ${path}`);
    }
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});

test('default helper options and an empty zone UUID list do not widen to unassigned devices', async () => {
  const db = seedScopedDb();
  addDiscoveryRows(db);
  try {
    const defaultCatalog = await hh.buildAnalysisCatalog(facadeDb(db), { userId: 2, deviceEui: SCOPED.DEVICE_EUI });
    assert.equal(defaultCatalog.channels.some((entry) => entry.deviceName === 'Owner unassigned'), false);
    const emptyScoped = await hh.buildAnalysisCatalog(facadeDb(db), {
      userId: 2,
      deviceEui: SCOPED.DEVICE_EUI,
      zoneUuids: [],
    });
    assert.equal(emptyScoped.channels.some((entry) => entry.deviceName === 'Owner unassigned'), false);
  } finally {
    db.close();
  }
});

test('flag-off selector and request options cannot forge another owner unassigned source', async () => {
  const db = seedScopedDb();
  addDiscoveryRows(db);
  try {
    const accountCatalog = await hh.buildAnalysisCatalog(facadeDb(db), {
      userId: 2,
      deviceEui: SCOPED.DEVICE_EUI,
      unassignedAccess: 'account',
    });
    const foreign = accountCatalog.channels.find((entry) => entry.deviceName === 'Foreign unassigned' && entry.channelKey === 'swt_1');
    assert.ok(foreign);
    const catalog = await route(db, 2, 'res1', 'GET', '/api/analysis/channels', FLAG_OFF, { unassignedAccess: 'account' }, { unassignedAccess: 'account' });
    assert.equal(catalog.result.statusCode, 200);
    assert.equal(channelByDevice(catalog.result.payload, 'Foreign unassigned'), undefined);
    const series = await route(db, 2, 'res1', 'POST', '/api/analysis/series', FLAG_OFF, {
      selectors: [{ seriesId: foreign.seriesId }],
      range: { from: '2026-01-02T07:00:00.000Z', to: '2026-01-02T09:00:00.000Z' },
      unassignedAccess: 'account',
    });
    assert.equal(series.result.statusCode, 200);
    assert.deepEqual(series.result.payload.series, []);
    assert.deepEqual(series.result.payload.dropped, [{ seriesId: foreign.seriesId, reason: 'unknown' }]);
  } finally {
    db.close();
  }
});

test('saved unassigned selectors become dropped after reassignment and remain stored', async () => {
  const db = seedScopedDb();
  addDiscoveryRows(db);
  try {
    const catalog = await route(db, 2, 'res1', 'GET', '/api/analysis/channels', FLAG_OFF);
    const original = channelByDevice(catalog.result.payload, 'Owner unassigned');
    assert.ok(original);
    const saved = await route(db, 2, 'res1', 'POST', '/api/analysis/views', FLAG_OFF, {
      name: 'Unassigned selector',
      selectors: [{ seriesId: original.seriesId }],
    });
    assert.equal(saved.result.statusCode, 200);
    const viewId = saved.result.payload.view.id;
    db.prepare('UPDATE devices SET irrigation_zone_id = 1, user_id = 1 WHERE deveui = ?').run('A8404100000000D1');
    const listed = await route(db, 2, 'res1', 'GET', '/api/analysis/views', FLAG_OFF);
    assert.equal(listed.result.statusCode, 200);
    assert.deepEqual(listed.result.payload.views[0].selectors, []);
    assert.deepEqual(listed.result.payload.views[0].droppedSeriesIds, [original.seriesId]);
    assert.equal(listed.result.payload.views[0].id, viewId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analysis_views').get().n, 1);
  } finally {
    db.close();
  }
});

test('fresh series and view resolution drop selectors after soft deletion, and series drops after reassignment', async () => {
  const db = seedScopedDb();
  addDiscoveryRows(db);
  try {
    const catalog = await route(db, 2, 'res1', 'GET', '/api/analysis/channels', FLAG_OFF);
    const deleted = channelByDevice(catalog.result.payload, 'Owner unassigned');
    const reassigned = channelByDevice(catalog.result.payload, 'Reassigned unassigned');
    assert.ok(deleted);
    assert.ok(reassigned);

    const save = await route(db, 2, 'res1', 'POST', '/api/analysis/views', FLAG_OFF, {
      name: 'Deleted selector',
      selectors: [{ seriesId: deleted.seriesId }],
    });
    assert.equal(save.result.statusCode, 200);

    db.prepare("UPDATE devices SET deleted_at = '2026-01-03T00:00:00.000Z' WHERE deveui = 'A8404100000000D1'").run();
    const deletedSeries = await route(db, 2, 'res1', 'POST', '/api/analysis/series', FLAG_OFF, {
      selectors: [{ seriesId: deleted.seriesId }],
      range: { from: '2026-01-02T07:00:00.000Z', to: '2026-01-02T09:00:00.000Z' },
    });
    assert.deepEqual(deletedSeries.result.payload.series, []);
    assert.deepEqual(deletedSeries.result.payload.dropped, [{ seriesId: deleted.seriesId, reason: 'unknown' }]);
    const deletedViews = await route(db, 2, 'res1', 'GET', '/api/analysis/views', FLAG_OFF);
    assert.deepEqual(deletedViews.result.payload.views[0].selectors, []);
    assert.deepEqual(deletedViews.result.payload.views[0].droppedSeriesIds, [deleted.seriesId]);

    db.prepare('UPDATE devices SET irrigation_zone_id = 1, user_id = 1 WHERE deveui = ?').run('A8404100000000D6');
    const reassignedSeries = await route(db, 2, 'res1', 'POST', '/api/analysis/series', FLAG_OFF, {
      selectors: [{ seriesId: reassigned.seriesId }],
      range: { from: '2026-01-02T07:00:00.000Z', to: '2026-01-02T09:00:00.000Z' },
    });
    assert.deepEqual(reassignedSeries.result.payload.series, []);
    assert.deepEqual(reassignedSeries.result.payload.dropped, [{ seriesId: reassigned.seriesId, reason: 'unknown' }]);
  } finally {
    db.close();
  }
});

test('unknown unassigned access is rejected by helper resolver options', async () => {
  const db = seedScopedDb();
  try {
    await assert.rejects(
      hh.buildAnalysisCatalog(facadeDb(db), { userId: 2, unassignedAccess: 'all' }),
      (error) => error && error.statusCode === 400 && /unassignedAccess/.test(error.message)
    );
  } finally {
    db.close();
  }
});
