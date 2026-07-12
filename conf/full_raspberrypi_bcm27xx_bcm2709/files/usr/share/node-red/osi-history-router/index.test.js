#!/usr/bin/env node
'use strict';
const assert = require('assert');
const HR = require('./index.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
  }
}

test('safeFilenamePart replaces non-alnum chars', function() {
  assert.strictEqual(HR.safeFilenamePart('hello/world'), 'hello-world');
  assert.strictEqual(HR.safeFilenamePart(''), undefined);
  assert.strictEqual(HR.safeFilenamePart('', 'fallback'), 'fallback');
  assert.strictEqual(HR.safeFilenamePart('clean'), 'clean');
});

test('httpError throws with statusCode', function() {
  assert.throws(function() { HR.httpError(404, 'Not found'); },
    function(err) { return err.statusCode === 404 && err.message === 'Not found'; });
  assert.throws(function() { HR.httpError(400, 'Bad', 'detail'); },
    function(err) { return err.statusCode === 400 && err.detail === 'detail'; });
});

test('parseZoneId valid', function() {
  assert.strictEqual(HR.parseZoneId('42'), 42);
  assert.strictEqual(HR.parseZoneId('1'), 1);
  assert.strictEqual(HR.parseZoneId('0'), 0);
});

test('parseZoneId invalid throws', function() {
  assert.throws(function() { HR.parseZoneId('abc'); });
  assert.throws(function() { HR.parseZoneId(null); });
});

test('boolValue', function() {
  assert.strictEqual(HR.boolValue('true'), true);
  assert.strictEqual(HR.boolValue('1'), true);
  assert.strictEqual(HR.boolValue(true), true);
  assert.strictEqual(HR.boolValue('false'), false);
  assert.strictEqual(HR.boolValue('0'), false);
  assert.strictEqual(HR.boolValue(0), false);
  assert.strictEqual(HR.boolValue(false), false);
  assert.strictEqual(HR.boolValue(undefined, true), true);
  assert.strictEqual(HR.boolValue(undefined, false), false);
});

test('numberOrNull', function() {
  assert.strictEqual(HR.numberOrNull('3.14'), 3.14);
  assert.strictEqual(HR.numberOrNull(42), 42);
  assert.strictEqual(HR.numberOrNull('nope'), null);
  assert.strictEqual(HR.numberOrNull(null), null);
  assert.strictEqual(HR.numberOrNull(undefined), null);
  assert.strictEqual(HR.numberOrNull(NaN), null);
});

test('parseJsonObject valid', function() {
  assert.deepStrictEqual(HR.parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(HR.parseJsonObject({ b: 2 }), { b: 2 });
});

test('sortIsoDesc', function() {
  assert.deepStrictEqual(
    HR.sortIsoDesc(['2026-01-01', '2026-06-01', '2026-03-01']),
    ['2026-06-01', '2026-03-01', '2026-01-01']
  );
  assert.deepStrictEqual(HR.sortIsoDesc([]), []);
});

test('latestIso', function() {
  assert.strictEqual(HR.latestIso(['2026-01-01', '2026-06-01', '2026-03-01']), '2026-06-01');
  assert.strictEqual(HR.latestIso([]), null);
});

test('supportedRangesForCard', function() {
  const config = { supportedRanges: ['12h', '24h', '7d', '30d', 'season'] };
  const ranges = HR.supportedRangesForCard(config, null);
  assert.ok(ranges.indexOf('12h') >= 0);
  assert.ok(ranges.indexOf('24h') >= 0);
});

test('validateView valid', function() {
  assert.strictEqual(HR.validateView('soil', 'line-chart'), 'line-chart');
  assert.strictEqual(HR.validateView('soil', 'soil-profile'), 'soil-profile');
  assert.strictEqual(HR.validateView('dendro', 'growth-timeline'), 'growth-timeline');
});

test('validateView invalid throws', function() {
  assert.throws(function() { HR.validateView('soil', 'invalid-view'); });
});

test('validateAggregation valid', function() {
  assert.strictEqual(HR.validateAggregation('hourly'), 'hourly');
  assert.strictEqual(HR.validateAggregation('auto'), 'auto');
  assert.strictEqual(HR.validateAggregation('raw'), 'raw');
  assert.strictEqual(HR.validateAggregation('daily'), 'daily');
});

test('validateAggregation invalid throws', function() {
  assert.throws(function() { HR.validateAggregation('invalid'); });
});

test('isSoilSource', function() {
  assert.strictEqual(HR.isSoilSource({ type_id: 'KIWI_SENSOR' }), true);
  assert.strictEqual(HR.isSoilSource({ type_id: 'STREGA_VALVE' }), false);
  assert.strictEqual(HR.isSoilSource(null), false);
});

test('isEnvironmentSource', function() {
  assert.strictEqual(HR.isEnvironmentSource({ type_id: 'SENSECAP_S2120' }), true);
  assert.strictEqual(HR.isEnvironmentSource({ type_id: 'KIWI_SENSOR' }), true);
  assert.strictEqual(HR.isEnvironmentSource({ type_id: 'STREGA_VALVE' }), false);
});

test('isIrrigationSource', function() {
  assert.strictEqual(HR.isIrrigationSource({ type_id: 'STREGA_VALVE' }), true);
  assert.strictEqual(HR.isIrrigationSource({ type_id: 'KIWI_SENSOR' }), false);
});

test('isDendroSource', function() {
  assert.strictEqual(HR.isDendroSource({ type_id: 'DRAGINO_LSN50', dendro_enabled: 1 }), true);
  assert.strictEqual(HR.isDendroSource({ type_id: 'DRAGINO_LSN50', dendro_enabled: 0 }), false);
  assert.strictEqual(HR.isDendroSource({ type_id: 'KIWI_SENSOR' }), false);
});

test('pointQuality', function() {
  assert.strictEqual(HR.pointQuality(100), 'ok');
  assert.strictEqual(HR.pointQuality(90), 'ok');
  assert.strictEqual(HR.pointQuality(89), 'partial');
  assert.strictEqual(HR.pointQuality(50), 'partial');
  assert.strictEqual(HR.pointQuality(49), 'gap');
  assert.strictEqual(HR.pointQuality(0), 'gap');
  assert.strictEqual(HR.pointQuality(null), 'unknown');
  assert.strictEqual(HR.pointQuality(undefined), 'unknown');
});

test('soilChannelDepths from device', function() {
  const depths = HR.soilChannelDepths([{ chameleon_swt1_depth_cm: 15, chameleon_swt2_depth_cm: 30, chameleon_swt3_depth_cm: 45 }]);
  assert.strictEqual(depths.swt_1, 15);
  assert.strictEqual(depths.swt_2, 30);
  assert.strictEqual(depths.swt_3, 45);
});

test('soilChannelDepths empty', function() {
  const depths = HR.soilChannelDepths([]);
  assert.strictEqual(depths.swt_1, null);
});

test('seriesWithDepth attaches depth', function() {
  const s = HR.seriesWithDepth({ id: 'swt_1', points: [] }, { swt_1: 15 }, 'swt_1');
  assert.strictEqual(s.depthCm, 15);
  assert.deepStrictEqual(s.points, []);
});

test('seriesWithDepth null depths', function() {
  const s = HR.seriesWithDepth({ id: 'swt_1', points: [] }, null, 'swt_1');
  assert.strictEqual(s.id, 'swt_1');
});

test('buildSeriesFromAggregate raw with statusForCardValue', function() {
  var mockStatus = function(ct, ch, v) { return v > 20 ? 'warning' : 'ok'; };
  var result = HR.buildSeriesFromAggregate(
    { cardType: 'soil' },
    { aggregation: 'raw', series: { swt_1: { points: [{ recordedAt: '2026-01-01', value: 15 }] } } },
    [],
    { statusForCardValue: mockStatus }
  );
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'swt_1');
  assert.strictEqual(result[0].points[0].dominantStatus, 'ok');
});

test('buildSeriesFromAggregate raw without opts defaults to null', function() {
  var result = HR.buildSeriesFromAggregate(
    { cardType: 'soil' },
    { aggregation: 'raw', series: { swt_1: { points: [{ recordedAt: '2026-01-01', value: 15 }] } } },
    []
  );
  assert.strictEqual(result[0].points[0].dominantStatus, null);
});

test('buildSeriesFromAggregate bucketed', function() {
  var mockStatus = function(ct, ch, v) { return v > 20 ? 'warning' : 'ok'; };
  var result = HR.buildSeriesFromAggregate(
    { cardType: 'soil' },
    {
      aggregation: 'hourly',
      buckets: [{
        bucketStart: '2026-01-01T00:00:00Z',
        bucketEnd: '2026-01-01T01:00:00Z',
        coveragePct: 100,
        series: { swt_1: { latest: 25, min: 20, max: 30, mean: 25, median: 25, sampleCount: 4 } }
      }]
    },
    [],
    { statusForCardValue: mockStatus }
  );
  assert.strictEqual(result[0].points[0].dominantStatus, 'warning');
  assert.strictEqual(result[0].points[0].quality, 'ok');
  assert.strictEqual(result[0].points[0].value, 25);
});

test('buildSeriesFromAggregate no-channel card returns empty', function() {
  var result = HR.buildSeriesFromAggregate(
    { cardType: 'irrigation' },
    { aggregation: 'raw', series: {} },
    []
  );
  assert.deepStrictEqual(result, []);
});

test('truncateSeries clips long series', function() {
  var longSeries = [{ id: 'x', points: new Array(2500).fill({ t: '', value: 0 }) }];
  var result = HR.truncateSeries(longSeries);
  assert.ok(result.series[0].points.length <= 2000);
  assert.strictEqual(result.truncated, true);
});

test('truncateSeries passes short series unchanged', function() {
  var shortSeries = [{ id: 'x', points: [{ t: '', value: 0 }] }];
  var result = HR.truncateSeries(shortSeries);
  assert.strictEqual(result.series[0].points.length, 1);
  assert.strictEqual(result.truncated, false);
});

test('displayDeviceName with human name', function() {
  assert.strictEqual(HR.displayDeviceName({ name: 'My Sensor' }, 0), 'My Sensor');
});

test('displayDeviceName falls back to type_id', function() {
  assert.strictEqual(HR.displayDeviceName({ name: '', type_id: 'KIWI_SENSOR' }, 0), 'Kiwi Sensor');
});

test('displayDeviceName falls back to index', function() {
  assert.strictEqual(HR.displayDeviceName({}, 2), 'Source 3');
});

test('displayDeviceName skips EUI-like hex names', function() {
  assert.strictEqual(HR.displayDeviceName({ name: 'A1B2C3D4E5F6A7B8', type_id: 'KIWI_SENSOR' }, 0), 'Kiwi Sensor');
});

test('displaySourceLabels', function() {
  assert.deepStrictEqual(HR.displaySourceLabels([{ name: 'Sensor A' }, { name: 'Sensor B' }]), ['Sensor A', 'Sensor B']);
});

test('displaySourceLabels null-safe', function() {
  assert.deepStrictEqual(HR.displaySourceLabels(null), []);
});

test('normalizeWorkspaceRow', function() {
  var row = HR.normalizeWorkspaceRow({
    id: 1, user_id: 1, owner_user_uuid: 'u1', zone_id: 1,
    name: 'ws', is_default: 1, workspace_json: '{"layout":"stacked"}',
    created_at: '2026-01-01', updated_at: '2026-01-01'
  });
  assert.strictEqual(row.name, 'ws');
  assert.strictEqual(row.isDefault, true);
  assert.deepStrictEqual(row.workspace, { layout: 'stacked' });
});

test('buildPreferenceMap', function() {
  var map = HR.buildPreferenceMap([
    { card_id: 'soil', pinned: true, manual_order: 1 },
    { card_id: 'dendro', pinned: false, manual_order: null }
  ]);
  assert.strictEqual(map.soil.pinned, true);
  assert.strictEqual(map.dendro.pinned, false);
});

test('lastOpenedRankMap', function() {
  var prefMap = {
    soil: { last_opened_at: '2026-07-10' },
    dendro: { last_opened_at: '2026-07-09' }
  };
  var map = HR.lastOpenedRankMap(prefMap);
  assert.strictEqual(map.soil, 1);
  assert.strictEqual(map.dendro, 2);
});

// --- S1 fixes: correct signatures; S2: edge-case coverage ---

test('summaryScore uses open_count + criticalAlert', function() {
  assert.strictEqual(HR.summaryScore({ open_count: 5 }, false), 5);
  assert.strictEqual(HR.summaryScore({ open_count: 5 }, true), 6);
  assert.strictEqual(HR.summaryScore(null, false), 0);
  assert.strictEqual(HR.summaryScore({}, true), 1);
});

test('shouldUseHistoryRollups with scopeContext', function() {
  var ctx = { scope: 'zone' };
  assert.strictEqual(HR.shouldUseHistoryRollups(ctx, '30d', 'auto'), true);
  assert.strictEqual(HR.shouldUseHistoryRollups(ctx, 'season', 'auto'), true);
  assert.strictEqual(HR.shouldUseHistoryRollups(ctx, '24h', 'raw'), false);
  assert.strictEqual(HR.shouldUseHistoryRollups(null, '30d', 'auto'), false);
  assert.strictEqual(HR.shouldUseHistoryRollups({ scope: 'gateway' }, '30d', 'auto'), false);
});

test('rowHasSoilProfileValue', function() {
  assert.strictEqual(HR.rowHasSoilProfileValue({ swt_1: 25 }), true);
  assert.strictEqual(HR.rowHasSoilProfileValue({ swt_1: null, swt_2: null, swt_3: null }), false);
  assert.strictEqual(HR.rowHasSoilProfileValue({ swt_2: 0 }), true);
  assert.strictEqual(HR.rowHasSoilProfileValue({}), false);
});

test('phaseSummary formats key:value pairs', function() {
  assert.strictEqual(HR.phaseSummary({}), '');
  var result = HR.phaseSummary({ build: 'done', test: 'pending' });
  assert.ok(result.includes('build:done'));
  assert.ok(result.includes('test:pending'));
});

test('parseRangeSelection 24h with nowMs', function() {
  var config = { defaultRange: '24h', supportedRanges: ['12h', '24h', '7d', '30d', 'season'] };
  var range = HR.parseRangeSelection({ range: '24h' }, config, { timezone: 'UTC' }, { nowMs: 1720612800000 });
  assert.ok(range.from);
  assert.ok(range.to);
  assert.strictEqual(range.label, '24h');
  assert.strictEqual(range.timezone, 'UTC');
});

test('parseRangeSelection custom from/to', function() {
  var config = { defaultRange: '24h', supportedRanges: ['12h', '24h', '7d', '30d', 'season', 'custom'] };
  var range = HR.parseRangeSelection(
    { range: 'custom', from: '2026-07-01T00:00:00Z', to: '2026-07-05T00:00:00Z' },
    config, { timezone: 'UTC' }
  );
  assert.strictEqual(range.label, 'custom');
  assert.ok(range.from);
  assert.ok(range.to);
});

test('parseRangeSelection unsupported range throws', function() {
  var config = { defaultRange: '24h', supportedRanges: ['24h'] };
  assert.throws(function() {
    HR.parseRangeSelection({ range: 'season' }, config, { timezone: 'UTC' });
  });
});

test('seasonBoundaryIso start of day', function() {
  assert.strictEqual(HR.seasonBoundaryIso('2026-03-15', false), '2026-03-15T00:00:00.000Z');
});

test('seasonBoundaryIso end of day', function() {
  assert.strictEqual(HR.seasonBoundaryIso('2026-10-31', true), '2026-10-31T23:59:59.999Z');
});

test('seasonBoundaryIso empty/null returns null', function() {
  assert.strictEqual(HR.seasonBoundaryIso('', false), null);
  assert.strictEqual(HR.seasonBoundaryIso(null, false), null);
});

test('seasonRangeForContext with valid season', function() {
  var ctx = { activeSeason: { starts_on: '2026-03-01', ends_on: '2026-10-31' } };
  var range = HR.seasonRangeForContext(ctx);
  assert.strictEqual(range.label, 'season');
  assert.strictEqual(range.from, '2026-03-01T00:00:00.000Z');
  assert.strictEqual(range.to, '2026-10-31T23:59:59.999Z');
});

test('seasonRangeForContext without season throws', function() {
  assert.throws(function() { HR.seasonRangeForContext({}); });
  assert.throws(function() { HR.seasonRangeForContext(null); });
});

test('latestPointTimestamp extracts latest t', function() {
  var series = [
    { id: 'swt_1', points: [{ t: '2026-07-01' }, { t: '2026-07-10' }] },
    { id: 'swt_2', points: [{ t: '2026-07-05' }] }
  ];
  assert.strictEqual(HR.latestPointTimestamp(series), '2026-07-10');
});

test('latestPointTimestamp empty returns null', function() {
  assert.strictEqual(HR.latestPointTimestamp([]), null);
  assert.strictEqual(HR.latestPointTimestamp(null), null);
});

test('latestValueBySeries finds by seriesId', function() {
  var series = [
    { id: 'swt_1', points: [{ t: '2026-07-01', value: 10 }, { t: '2026-07-10', value: 25 }] },
    { id: 'swt_2', points: [{ t: '2026-07-05', value: 30 }] }
  ];
  var val = HR.latestValueBySeries(series, 'swt_2');
  assert.strictEqual(val, 30);
});

test('latestValueBySeries missing id returns null', function() {
  assert.strictEqual(HR.latestValueBySeries([], 'swt_1'), null);
  assert.strictEqual(HR.latestValueBySeries(null, 'swt_1'), null);
});

test('latestBatteryMetric extracts bat_v from latest row', function() {
  var rows = [
    { recorded_at: '2026-07-01', bat_v: 3.6 },
    { recorded_at: '2026-07-10', bat_v: 3.2 }
  ];
  var metric = HR.latestBatteryMetric(rows);
  assert.ok(metric);
  assert.strictEqual(metric.latest, 3.2);
});

test('latestBatteryMetric empty returns status unknown', function() {
  var metric = HR.latestBatteryMetric([]);
  assert.deepStrictEqual(metric, { status: 'unknown' });
});

test('pointValueForCalendar extracts value', function() {
  assert.strictEqual(HR.pointValueForCalendar({ value: 25 }), 25);
  assert.strictEqual(HR.pointValueForCalendar({ latest: 30 }), 30);
  assert.strictEqual(HR.pointValueForCalendar(null), null);
  assert.strictEqual(HR.pointValueForCalendar({}), null);
});

test('calendarRowsFromSeries groups by time', function() {
  var series = [{ id: 'swt_1', points: [
    { t: '2026-07-01T00:00:00Z', value: 15 },
    { t: '2026-07-02T00:00:00Z', value: 20 }
  ] }];
  var rows = HR.calendarRowsFromSeries(series);
  assert.ok(typeof rows === 'object');
  assert.ok(Object.keys(rows).length >= 2);
});

test('calendarRowsFromSeries empty', function() {
  assert.deepStrictEqual(HR.calendarRowsFromSeries([]), []);
  assert.deepStrictEqual(HR.calendarRowsFromSeries(null), []);
});

test('latestCalendarState finds last non-no_data state', function() {
  var calendar = { days: [
    { state: 'optimal' },
    { state: 'no_data' },
    { state: 'dry_stress' }
  ] };
  assert.strictEqual(HR.latestCalendarState(calendar), 'dry_stress');
});

test('latestCalendarState fallback returns no_data', function() {
  assert.strictEqual(HR.latestCalendarState(null), 'no_data');
  assert.strictEqual(HR.latestCalendarState({ days: [] }), 'no_data');
});

test('advancedField builds field object', function() {
  var field = HR.advancedField('temperature', 25.3, 'C', 'collected');
  assert.strictEqual(field.field, 'temperature');
  assert.strictEqual(field.value, 25.3);
  assert.strictEqual(field.unit, 'C');
  assert.strictEqual(field.availability, 'collected');
});

test('advancedField handles undefined/null', function() {
  var field = HR.advancedField('test', undefined, undefined, 'unknown');
  assert.strictEqual(field.value, null);
  assert.strictEqual(field.unit, null);
});

test('knownAvailableFields extracts non-metadata keys', function() {
  var rows = [{ id: 1, deveui: 'abc', recorded_at: '2026-01-01', swt_1: 25, bat_v: 3.6 }];
  var fields = HR.knownAvailableFields(rows);
  assert.ok(fields instanceof Set || Array.isArray(fields) || typeof fields === 'object');
  var arr = fields instanceof Set ? Array.from(fields) : (Array.isArray(fields) ? fields : Object.keys(fields));
  assert.ok(arr.includes('swt_1'));
  assert.ok(arr.includes('bat_v'));
  assert.ok(!arr.includes('id'));
  assert.ok(!arr.includes('deveui'));
  assert.ok(!arr.includes('recorded_at'));
});

test('latestSeriesPoint finds by channelId', function() {
  var series = [
    { id: 'swt_1', points: [{ t: '2026-07-01', value: 10 }, { t: '2026-07-10', value: 25 }] }
  ];
  var point = HR.latestSeriesPoint(series, 'swt_1');
  assert.ok(point);
  assert.strictEqual(point.value, 25);
});

test('latestSeriesPoint missing returns null', function() {
  assert.strictEqual(HR.latestSeriesPoint([], 'swt_1'), null);
  assert.strictEqual(HR.latestSeriesPoint(null, 'swt_1'), null);
});

test('normalizeWorkspaceRow handles invalid workspace_json', function() {
  var row = HR.normalizeWorkspaceRow({
    id: 1, user_id: 1, owner_user_uuid: null, zone_id: null,
    name: 'ws', is_default: 0, workspace_json: 'not-json',
    created_at: '2026-01-01', updated_at: '2026-01-01'
  });
  assert.deepStrictEqual(row.workspace, {});
  assert.strictEqual(row.zoneId, null);
  assert.strictEqual(row.isDefault, false);
});

console.log('\n=== osi-history-router index.test.js ===');
if (failures.length) {
  for (var f of failures) console.log('FAIL:', f.name, '-', f.error);
}
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
console.log('PASS');
