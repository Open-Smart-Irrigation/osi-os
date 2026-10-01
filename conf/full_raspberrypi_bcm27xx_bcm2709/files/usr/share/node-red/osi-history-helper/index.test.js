'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const hh = require('./index.js');

test('normalizeDeveui accepts valid hex EUIs and cleans separators', () => {
  assert.equal(hh.normalizeDeveui('0016c001f11715e2'), '0016C001F11715E2');
  assert.equal(hh.normalizeDeveui('00-16-C0-01-F1-17-15-E2'), '0016C001F11715E2');
  assert.equal(hh.normalizeDeveui('00:16:C0:01:F1:17:15:E2'), '0016C001F11715E2');
  assert.equal(hh.normalizeDeveui('not-a-valid-eui'), null);
  assert.equal(hh.normalizeDeveui('ABCD'), null);
  assert.equal(hh.normalizeDeveui(null), null);
  assert.equal(hh.normalizeDeveui(undefined), null);
  assert.equal(hh.normalizeDeveui('zz0016C001F11715E2zz'), '0016C001F11715E2');
  assert.equal(hh.normalizeDeveui('0016C001F11715E20016C001F11715E2'), null);
  assert.equal(hh.normalizeDeveui(12345), null);
});

test('kpaToPf converts positive kPa to pF and rejects non-positive/invalid input', () => {
  assert.equal(hh.kpaToPf(10), 2);
  assert.equal(hh.kpaToPf(1), 1);
  assert.equal(hh.kpaToPf(0), null);
  assert.equal(hh.kpaToPf(-5), null);
  assert.equal(hh.kpaToPf(null), null);
  assert.equal(hh.kpaToPf(NaN), null);
  assert.equal(hh.kpaToPf(Infinity), null);
  assert.equal(hh.kpaToPf('10'), 2);
  assert.equal(hh.kpaToPf(0.1), 0);
});

test('resolveAggregation honors explicit levels and rejects unsupported ones', () => {
  assert.deepEqual(hh.resolveAggregation({ aggregation: 'hourly' }), {
    requested: 'hourly',
    level: 'hourly',
    bucketSizeSeconds: 3600,
  });
  assert.deepEqual(hh.resolveAggregation({ aggregation: 'raw' }), {
    requested: 'raw',
    level: 'raw',
    bucketSizeSeconds: null,
  });
  assert.deepEqual(hh.resolveAggregation({ aggregation: 'daily' }), {
    requested: 'daily',
    level: 'daily',
    bucketSizeSeconds: 86400,
  });
  assert.throws(() => hh.resolveAggregation({ aggregation: 'bogus' }), /unsupported aggregation: bogus/);
});

test('resolveAggregation auto mode derives level from range label and duration', () => {
  assert.equal(hh.resolveAggregation({ range: '7d' }).level, 'hourly');
  assert.equal(hh.resolveAggregation({ range: '30d' }).level, 'daily');
  assert.equal(
    hh.resolveAggregation({ range: 'season', start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' }).level,
    'daily'
  );
  assert.equal(
    hh.resolveAggregation({ range: 'season', start: '2026-01-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' }).level,
    'weekly'
  );

  const start = '2026-07-01T00:00:00.000Z';
  const addHours = (hours) => new Date(Date.parse(start) + hours * 60 * 60 * 1000).toISOString();
  assert.equal(hh.resolveAggregation({ start, end: addHours(12) }).level, 'raw');
  assert.equal(hh.resolveAggregation({ start, end: addHours(36) }).level, '15m');
  assert.equal(hh.resolveAggregation({ start, end: addHours(5 * 24) }).level, 'hourly');
  assert.equal(hh.resolveAggregation({ start, end: addHours(60 * 24) }).level, 'daily');
  assert.equal(hh.resolveAggregation({ start, end: addHours(200 * 24) }).level, 'weekly');
});

test('deriveExpectedCadenceSeconds prefers configured value, else derives from rows, else unknown', () => {
  assert.deepEqual(hh.deriveExpectedCadenceSeconds({ configuredCadenceSeconds: 300 }), {
    seconds: 300,
    confidence: 'configured',
  });

  const rows = [
    { recorded_at: '2026-07-10T00:00:00.000Z' },
    { recorded_at: '2026-07-10T00:05:00.000Z' },
    { recorded_at: '2026-07-10T00:10:00.000Z' },
    { recorded_at: '2026-07-10T00:15:00.000Z' },
  ];
  assert.deepEqual(hh.deriveExpectedCadenceSeconds({ rows }), { seconds: 300, confidence: 'derived' });

  assert.deepEqual(hh.deriveExpectedCadenceSeconds({ rows: [] }), { seconds: null, confidence: 'unknown' });
});

test('classifySoilStatus classifies dry/wet/optimal/no_data by kPa thresholds', () => {
  assert.deepEqual(hh.classifySoilStatus({ value: 60 }), {
    status: 'dry_stress',
    severity: 'warning',
    value: 60,
    thresholds: { wetKpa: 22, dryKpa: 50 },
  });
  assert.deepEqual(hh.classifySoilStatus({ value: 10 }), {
    status: 'wet_excess',
    severity: 'warning',
    value: 10,
    thresholds: { wetKpa: 22, dryKpa: 50 },
  });
  assert.deepEqual(hh.classifySoilStatus({ value: 30 }), {
    status: 'optimal',
    severity: 'normal',
    value: 30,
    thresholds: { wetKpa: 22, dryKpa: 50 },
  });
  assert.deepEqual(hh.classifySoilStatus({}), { status: 'no_data', severity: 'info', value: null });
  assert.equal(hh.classifySoilStatus({ value: 50 }).status, 'optimal');
  assert.equal(hh.classifySoilStatus({ value: 22 }).status, 'optimal');
});

test('classifyEnvironmentStatus classifies heat/cold/humidity/rain/normal/no_data', () => {
  assert.equal(hh.classifyEnvironmentStatus({ ambientTemperature: 36 }).status, 'heat_stress');
  assert.equal(hh.classifyEnvironmentStatus({ ambientTemperature: 2 }).status, 'cold_stress');
  assert.equal(hh.classifyEnvironmentStatus({ relativeHumidity: 95 }).status, 'high_humidity');
  assert.equal(hh.classifyEnvironmentStatus({ rainMm: 5 }).status, 'rain_day');
  assert.deepEqual(hh.classifyEnvironmentStatus({ ambientTemperature: 20 }), {
    status: 'normal',
    severity: 'normal',
    value: 20,
  });
  assert.deepEqual(hh.classifyEnvironmentStatus({}), { status: 'no_data', severity: 'info', value: null });
  assert.equal(hh.classifyEnvironmentStatus({ ambientTemperature: 35 }).status, 'heat_stress');
  assert.equal(hh.classifyEnvironmentStatus({ ambientTemperature: 5 }).status, 'cold_stress');
});

test('classifyDendroStatus classifies recovery/shrinkage/growth/no_data', () => {
  assert.equal(hh.classifyDendroStatus({ recoveryRatio: 0.3 }).status, 'incomplete_night_recovery');
  assert.equal(hh.classifyDendroStatus({ mdsUm: 450 }).status, 'high_shrinkage_stress');
  assert.equal(hh.classifyDendroStatus({ growthUm: -10 }).status, 'reduced_growth');
  assert.equal(hh.classifyDendroStatus({ growthUm: 50 }).status, 'normal_growth');
  assert.deepEqual(hh.classifyDendroStatus({}), { status: 'no_data', severity: 'info', value: null });
  assert.equal(hh.classifyDendroStatus({ growthUm: 0 }).status, 'reduced_growth');
});

test('classifyIrrigationStatus classifies manual override/frequency/events/no_data', () => {
  assert.equal(hh.classifyIrrigationStatus({ manualOverride: true }).status, 'manual_override');
  assert.equal(hh.classifyIrrigationStatus({ eventCount: 5 }).status, 'high_irrigation_frequency');
  assert.equal(hh.classifyIrrigationStatus({ eventCount: 1 }).status, 'irrigation_event');
  assert.deepEqual(hh.classifyIrrigationStatus({ eventCount: 0 }), {
    status: 'no_irrigation',
    severity: 'normal',
    eventCount: 0,
  });
  assert.deepEqual(hh.classifyIrrigationStatus({}), { status: 'no_data', severity: 'info', eventCount: null });
});

test('classifyGatewayStatus classifies offline/normal/no_data by staleness', () => {
  const generatedAt = '2026-07-11T00:20:00.000Z';
  assert.deepEqual(hh.classifyGatewayStatus({ generatedAt, lastSeenAt: '2026-07-11T00:00:00.000Z' }), {
    status: 'offline',
    severity: 'warning',
    lastSeenAt: '2026-07-11T00:00:00.000Z',
    ageSeconds: 1200,
  });
  assert.deepEqual(hh.classifyGatewayStatus({ generatedAt, lastSeenAt: '2026-07-11T00:19:00.000Z' }), {
    status: 'normal',
    severity: 'normal',
    lastSeenAt: '2026-07-11T00:19:00.000Z',
    ageSeconds: 60,
  });
  assert.deepEqual(hh.classifyGatewayStatus({}), { status: 'no_data', severity: 'info', lastSeenAt: null });
});

test('deriveCardId builds zone-scoped, gateway, and dendro card ids', () => {
  assert.equal(hh.deriveCardId({ zoneUuid: 'zone-1', cardType: 'soil' }), 'zone-1:soil:root-zone');
  assert.equal(hh.deriveCardId({ zoneUuid: 'zone-1', cardType: 'irrigation' }), 'zone-1:irrigation:zone-valves');
  assert.equal(hh.deriveCardId('zone-1', 'irrigation'), 'zone-1:irrigation:zone-valves');

  const deveui = '0016C001F11715E2';
  const expectedDendroKey = `dendro-src-${crypto.createHash('sha256').update(deveui).digest('hex').slice(0, 12)}`;
  assert.equal(hh.deriveCardId({ zoneUuid: 'zone-1', cardType: 'dendro', deveui }), `zone-1:dendro:${expectedDendroKey}`);

  assert.equal(
    hh.deriveCardId({ zoneUuid: 'GW1', cardType: 'gateway', gatewayEui: '0016c001f11715e2' }),
    '0016C001F11715E2:gateway:hub'
  );

  assert.equal(hh.deriveCardId({}), null);
  assert.equal(hh.deriveCardId({ cardType: 'gateway' }), null);
});

test('deriveGatewayCard builds a card for a valid EUI and null for invalid input', () => {
  assert.deepEqual(hh.deriveGatewayCard('0016c001f11715e2'), {
    id: '0016C001F11715E2:gateway:hub',
    cardType: 'gateway',
    logicalSourceKey: 'hub',
    gatewayEui: '0016C001F11715E2',
  });
  assert.equal(hh.deriveGatewayCard('not-valid'), null);
});

test('deriveCardsForZone derives soil/dendro/environment/irrigation cards for a mixed-device zone', () => {
  const zone = { id: 1, zone_uuid: 'zone-1' };
  const soilDevice = { deveui: '1111111111111111', type_id: 'GENERIC', irrigation_zone_id: 1, swt_1: 55 };
  const envDevice = { deveui: '2222222222222222', type_id: 'SENSECAP_S2120', irrigation_zone_id: 1 };
  const irrigationDevice = { deveui: '3333333333333333', type_id: 'STREGA_VALVE', irrigation_zone_id: 1 };
  const dendroDevice = { deveui: '4444444444444444', type_id: 'DRAGINO_LSN50', dendro_enabled: 1, irrigation_zone_id: 1 };
  const otherZoneDevice = { deveui: '5555555555555555', type_id: 'GENERIC', irrigation_zone_id: 2, swt_1: 10 };

  const cards = hh.deriveCardsForZone(zone, [soilDevice, envDevice, irrigationDevice, dendroDevice, otherZoneDevice]);
  const byType = Object.fromEntries(cards.map((card) => [card.cardType, card]));

  assert.equal(cards.length, 4);
  assert.deepEqual(Object.keys(byType).sort(), ['dendro', 'environment', 'irrigation', 'soil']);

  const srcKey = (prefix, deveui) => `${prefix}-src-${crypto.createHash('sha256').update(deveui).digest('hex').slice(0, 12)}`;

  assert.equal(byType.soil.id, 'zone-1:soil:root-zone');
  assert.equal(byType.soil.sourceDeviceCount, 2);
  assert.deepEqual(byType.soil.sourceDevices, [
    { name: 'Generic', typeId: 'GENERIC', role: 'soil', sourceKey: srcKey('soil', soilDevice.deveui) },
    { name: 'Dragino Lsn50', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: srcKey('soil', dendroDevice.deveui) },
  ]);

  assert.equal(byType.environment.id, 'zone-1:environment:microclimate');
  assert.deepEqual(byType.environment.sourceDevices, [
    { name: 'Sensecap S2120', typeId: 'SENSECAP_S2120', role: 'environment', sourceKey: srcKey('environment', envDevice.deveui) },
  ]);

  assert.equal(byType.irrigation.id, 'zone-1:irrigation:zone-valves');
  assert.deepEqual(byType.irrigation.sourceDevices, [
    { name: 'Strega Valve', typeId: 'STREGA_VALVE', role: 'irrigation', sourceKey: srcKey('irrigation', irrigationDevice.deveui) },
  ]);

  const expectedDendroSourceKey = `dendro-src-${crypto.createHash('sha256').update(dendroDevice.deveui).digest('hex').slice(0, 12)}`;
  assert.deepEqual(byType.dendro, {
    id: `zone-1:dendro:${expectedDendroSourceKey}`,
    cardType: 'dendro',
    logicalSourceKey: expectedDendroSourceKey,
    sourceDeviceCount: 1,
  });
});

test('deriveCardsForZone returns no cards for a zone with no matching devices', () => {
  assert.deepEqual(hh.deriveCardsForZone({ id: 1, zone_uuid: 'zone-1' }, []), []);
  assert.deepEqual(hh.deriveCardsForZone({ zone_uuid: '' }, []), []);
});

test('deriveCardsForZone treats every assigned LSN50 as a soil source', () => {
  const watermark = {
    deveui: '6666666666666666',
    type_id: 'DRAGINO_LSN50',
    chameleon_enabled: 0,
    irrigation_zone_id: 1,
  };

  const cards = hh.deriveCardsForZone({ id: 1, zone_uuid: 'zone-1' }, [watermark]);

  assert.deepEqual(cards.map((card) => card.cardType), ['soil']);
  assert.equal(cards[0].sourceDeviceCount, 1);
});

test('soilDepthCm uses generic SWT depths and only exposes LSN50 SWT3 for Chameleon', () => {
  const nonChameleon = {
    type_id: 'DRAGINO_LSN50',
    chameleon_enabled: 0,
    chameleon_swt3_depth_cm: 99,
    soil_moisture_probe_depths_json: JSON.stringify({ swt_1: 12, swt_2: 34, swt_3: 56 }),
  };
  assert.equal(hh.soilDepthCm(nonChameleon, 'swt_1'), 12);
  assert.equal(hh.soilDepthCm(nonChameleon, 'swt_2'), 34);
  assert.equal(hh.soilDepthCm(nonChameleon, 'swt_3'), null);
  assert.equal(hh.soilDepthCm({ ...nonChameleon, chameleon_enabled: 1 }, 'swt_3'), 99);
});

test('aggregateRows raw mode returns per-channel series of points', () => {
  const rows = [
    { recorded_at: '2026-07-10T00:00:00.000Z', swt_1: 30 },
    { recorded_at: '2026-07-10T00:05:00.000Z', swt_1: 32 },
  ];
  const result = hh.aggregateRows(rows, { aggregation: 'raw', channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }] });
  assert.equal(result.aggregation, 'raw');
  assert.equal(result.bucketSizeSeconds, null);
  assert.equal(result.source, 'device_data');
  assert.deepEqual(result.series.swt_1, {
    unit: 'kPa',
    points: [
      { recordedAt: '2026-07-10T00:00:00.000Z', value: 30 },
      { recordedAt: '2026-07-10T00:05:00.000Z', value: 32 },
    ],
  });
});

test('aggregateRows bucketed mode returns per-bucket stats and coverage', () => {
  const rows = [
    { recorded_at: '2026-07-10T00:10:00.000Z', swt_1: 10 },
    { recorded_at: '2026-07-10T00:40:00.000Z', swt_1: 20 },
    { recorded_at: '2026-07-10T01:15:00.000Z', swt_1: 40 },
  ];
  const result = hh.aggregateRows(rows, {
    aggregation: 'hourly',
    start: '2026-07-10T00:00:00.000Z',
    end: '2026-07-10T02:00:00.000Z',
    channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }],
    expectedCadenceSeconds: 1800,
  });

  assert.equal(result.aggregation, 'hourly');
  assert.equal(result.bucketSizeSeconds, 3600);
  assert.equal(result.buckets.length, 2);
  assert.deepEqual(result.buckets[0].series.swt_1, {
    min: 10,
    max: 20,
    mean: 15,
    median: 15,
    latest: 20,
    sampleCount: 2,
    sum: 30,
    unit: 'kPa',
  });
  assert.equal(result.buckets[0].coveragePct, 100);
  assert.equal(result.buckets[0].coverageConfidence, 'configured');
  assert.deepEqual(result.buckets[1].series.swt_1, {
    min: 40,
    max: 40,
    mean: 40,
    median: 40,
    latest: 40,
    sampleCount: 1,
    sum: 40,
    unit: 'kPa',
  });
  assert.equal(result.buckets[1].coveragePct, 50);
  assert.equal(result.coveragePct, 75);
  assert.equal(result.coverageConfidence, 'configured');
});

test('buildZoneExportCsv accepts et0_mm but never queries it and exports no rows for it', async () => {
  const queries = [];
  const db = {
    all: async (sql) => {
      queries.push(sql);
      if (sql.includes('FROM irrigation_zones')) return [{ id: 12, name: 'Zone B', zone_uuid: 'zb', timezone: 'UTC' }];
      if (sql.includes('FROM devices')) return [{ deveui: 'AA00000000000001', name: 'Kiwi', type_id: 'KIWI_SENSOR', irrigation_zone_id: 12 }];
      if (sql.includes('FROM device_data')) {
        return [{ deveui: 'AA00000000000001', recorded_at: '2026-06-01T06:00:00.000Z', swt_1: 12.5 }];
      }
      return [];
    },
  };
  const result = await hh.buildZoneExportCsv(db, {
    zoneId: 12,
    from: '2026-06-01',
    to: '2026-06-01',
    granularity: 'raw',
    // et0_mm has no edgeField (weather-only channel); swt_1 alongside it
    // forces a real device_data query to run, so "no SQL names et0_mm"
    // below is a meaningful check, not vacuously true because the query
    // never ran (final fix A5, review T1 nit).
    channels: 'et0_mm,swt_1',
    nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
  });
  assert.deepEqual(result.columns, hh.RAW_CSV_COLUMNS);
  assert.ok(result.rows.some((row) => row.channel_key === 'swt_1' && row.value === 12.5));
  assert.ok(!result.rows.some((row) => row.channel_key === 'et0_mm'));
  const deviceDataQueries = queries.filter((sql) => sql.includes('FROM device_data'));
  assert.ok(deviceDataQueries.length > 0, 'a real device_data query ran, not skipped entirely');
  assert.deepEqual(queries.filter((sql) => /et0_mm/.test(sql)), []);
});

test('aggregateRows reports the bucket sum beside the mean, null for an empty bucket', () => {
  const rows = [
    { recorded_at: '2026-07-10T00:00:00.000Z', rain: 0.1 },
    { recorded_at: '2026-07-10T00:30:00.000Z', rain: 0.2 },
    { recorded_at: '2026-07-10T01:00:00.000Z', rain: 0.4 },
  ];
  const hourly = hh.aggregateRows(rows, {
    aggregation: 'hourly',
    start: '2026-07-10T00:00:00.000Z',
    end: '2026-07-10T03:00:00.000Z',
    channels: [{ id: 'rain', field: 'rain', unit: 'mm' }],
  });
  assert.deepEqual(hourly.buckets.map((bucket) => [bucket.series.rain.sum, bucket.series.rain.mean]), [
    [0.3, 0.15],
    [0.4, 0.4],
    [null, null],
  ]);
  const daily = hh.aggregateRows(rows, {
    aggregation: 'daily',
    start: '2026-07-10T00:00:00.000Z',
    end: '2026-07-11T00:00:00.000Z',
    channels: [{ id: 'rain', field: 'rain', unit: 'mm' }],
  });
  assert.equal(daily.buckets[0].series.rain.sum, 0.7);
});

test('aggregateRows with a timezone ends a daily bucket at local midnight', () => {
  const result = hh.aggregateRows([
    { recorded_at: '2026-09-24T21:30:00.000Z', rain: 1 },
    { recorded_at: '2026-09-24T22:30:00.000Z', rain: 2 },
  ], {
    aggregation: 'daily',
    start: '2026-09-24T00:00:00.000Z',
    end: '2026-09-26T00:00:00.000Z',
    timezone: 'Europe/Zurich',
    channels: [{ id: 'rain', field: 'rain', unit: 'mm' }],
  });
  assert.equal(result.buckets[0].bucketEnd, '2026-09-24T22:00:00.000Z');
  assert.deepEqual(result.buckets.map((bucket) => bucket.series.rain.sum), [1, 2, null]);
});

test('aggregateRows requires at least one channel', () => {
  assert.throws(() => hh.aggregateRows([], { aggregation: 'raw', channels: [] }), /requires at least one channel/);
});

test('buildCalendar classifies soil days and derives basic structure', () => {
  const rows = [
    { recorded_at: '2026-07-10T05:00:00.000Z', value: 60 },
    { recorded_at: '2026-07-11T05:00:00.000Z', value: 10 },
  ];
  const result = hh.buildCalendar({
    cardType: 'soil',
    timezone: 'UTC',
    range: { from: '2026-07-10T00:00:00.000Z', to: '2026-07-12T00:00:00.000Z' },
    rows,
  });

  assert.equal(result.timezone, 'UTC');
  assert.equal(result.days.length, 2);
  assert.deepEqual(result.days[0], {
    date: '2026-07-10',
    state: 'dry_stress',
    coveragePct: null,
    coverageConfidence: 'unknown',
    summary: { key: 'history.calendar.summary.soil.dry_stress', params: { sampleCount: 1, eventCount: 0 } },
    metrics: { sampleCount: 1, eventCount: 0 },
    markers: [
      {
        type: 'state',
        severity: 'warning',
        labelKey: 'history.calendar.marker.soil.dry_stress',
        params: { sampleCount: 1, eventCount: 0 },
      },
    ],
  });
  assert.deepEqual(result.days[1], {
    date: '2026-07-11',
    state: 'wet_excess',
    coveragePct: null,
    coverageConfidence: 'unknown',
    summary: { key: 'history.calendar.summary.soil.wet_excess', params: { sampleCount: 1, eventCount: 0 } },
    metrics: { sampleCount: 1, eventCount: 0 },
    markers: [
      {
        type: 'state',
        severity: 'warning',
        labelKey: 'history.calendar.marker.soil.wet_excess',
        params: { sampleCount: 1, eventCount: 0 },
      },
    ],
  });
});

test('buildCalendar returns no_data days when there are no rows in range', () => {
  const result = hh.buildCalendar({
    cardType: 'soil',
    timezone: 'UTC',
    range: { from: '2026-07-10T00:00:00.000Z', to: '2026-07-11T00:00:00.000Z' },
    rows: [],
  });
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].state, 'no_data');
  assert.deepEqual(result.days[0].markers, []);
});

test('buildLocalInterpretations flags root-zone dry stress', () => {
  const items = hh.buildLocalInterpretations({
    cardType: 'soil',
    status: 'dry_stress',
    statusSince: '2026-07-10T00:00:00.000Z',
    generatedAt: '2026-07-10T05:00:00.000Z',
    coveragePct: 95,
    coverageConfidence: 'configured',
  });
  assert.deepEqual(items, [
    {
      ruleId: 'root-zone-dry',
      severity: 'warning',
      titleKey: 'history.interpretation.rootZoneDry.title',
      bodyKey: 'history.interpretation.rootZoneDry.body',
      params: { hoursDry: 5 },
      evidence: [{ type: 'status', status: 'dry_stress', since: '2026-07-10T00:00:00.000Z' }],
      source: 'local-rule',
    },
  ]);
});

test('buildLocalInterpretations flags a data coverage gap', () => {
  const lowCoverage = hh.buildLocalInterpretations({ coveragePct: 50, coverageConfidence: 'derived' });
  assert.equal(lowCoverage.length, 1);
  assert.equal(lowCoverage[0].ruleId, 'data-coverage-gap');
  assert.equal(lowCoverage[0].severity, 'warning');

  const unknownConfidence = hh.buildLocalInterpretations({ coverageConfidence: 'unknown' });
  assert.equal(unknownConfidence.length, 1);
  assert.equal(unknownConfidence[0].ruleId, 'data-coverage-gap');
  assert.equal(unknownConfidence[0].severity, 'info');

  const healthy = hh.buildLocalInterpretations({ coveragePct: 95, coverageConfidence: 'configured' });
  assert.deepEqual(healthy, []);
});

test('toCsv generates rows and escapes commas, quotes, and formula-injection prefixes', () => {
  const csv = hh.toCsv(
    ['a', 'b'],
    [
      { a: 'plain', b: 'text' },
      { a: 'has,comma', b: 'has"quote' },
      { a: '=cmd', b: null },
    ]
  );
  assert.equal(csv, 'a,b\nplain,text\n"has,comma","has""quote"\n\'=cmd,\n');
});

test('toCsv handles empty rows and non-array input defensively', () => {
  assert.equal(hh.toCsv(['a', 'b'], []), 'a,b\n');
  assert.equal(hh.toCsv(['a'], null), 'a\n');
});

test('buildAdvancedDiagnostics reports structure and availability for a soil card with source devices', () => {
  const result = hh.buildAdvancedDiagnostics({
    cardType: 'soil',
    generatedAt: '2026-07-10T00:00:00.000Z',
    rowCount: 10,
    latestRows: [{ recorded_at: '2026-07-10T00:00:00.000Z', rssi: -80, bat_pct: 55 }],
    sourceDevices: [{ deveui: '1111111111111111', type_id: 'GENERIC' }],
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.fields.sourceDeviceCount.value, 1);
  assert.equal(result.fields.rawRowCount.value, 10);
  assert.equal(result.fields.rawRowCount.availability, 'collected');
  assert.deepEqual(result.fields.rssi, { field: 'rssi', value: -80, unit: 'dBm', availability: 'collected' });
  assert.deepEqual(result.fields.batteryPct, { field: 'batteryPct', value: 55, unit: '%', availability: 'collected' });
  assert.equal(result.fields.snr.availability, 'not_collected_at_time');
  assert.equal(result.fields.primaryDeveui.value, '1111111111111111');
  assert.equal(result.fields.pendingCommands.availability, 'unsupported');
  assert.equal(result.fields.calibrationStatus.availability, 'unknown_now');

  assert.equal(result.placeholder.cardType, 'soil');
  assert.equal(result.placeholder.sourceDevices.length, 1);
  assert.equal(result.placeholder.sourceDevices[0].deveui, '1111111111111111');
  assert.deepEqual(
    result.placeholder.sections.map((section) => section.id),
    ['source-devices', 'radio-diagnostics', 'raw-payloads']
  );
});
