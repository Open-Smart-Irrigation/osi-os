'use strict';

const { aggregateRows } = require('../osi-history-helper');

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MILLISECONDS = DAY_SECONDS * 1000;

// v1 rain source policy: the selected subject wins, then a direct zone gauge,
// then a shared weather_station_zones gauge. Native interval devices win within
// a tier, followed by canonical DevEUI for a stable final tie-break.
const RAIN_SOURCE_TIER = Object.freeze({ subject: 0, direct: 1, shared: 2 });
const RAIN_DEVICE_TYPE_PRIORITY = Object.freeze({
  AQUASCOPE_LORAIN: 0,
  SENSECAP_S2120: 1,
  OTHER: 2,
});

const POINT_CHANNELS = Object.freeze([
  {
    key: 'swt_1',
    unit: 'kPa',
    sourceKey: 'swt_1',
    select: 'swt_1,swt_wm1',
    predicate: '(swt_1 IS NOT NULL OR swt_wm1 IS NOT NULL)',
    expression: 'COALESCE(swt_1,swt_wm1)',
    value(row) { return firstFinite(row.swt_1, row.swt_wm1); },
    rowSourceKey() { return 'swt_1'; },
  },
  {
    key: 'swt_2',
    unit: 'kPa',
    sourceKey: 'swt_2',
    select: 'swt_2,swt_wm2',
    predicate: '(swt_2 IS NOT NULL OR swt_wm2 IS NOT NULL)',
    expression: 'COALESCE(swt_2,swt_wm2)',
    value(row) { return firstFinite(row.swt_2, row.swt_wm2); },
    rowSourceKey() { return 'swt_2'; },
  },
  numericPoint('swt_3', 'swt_3', 'kPa'),
  {
    key: 'temperature',
    unit: '°C',
    sourceKey: 'ambient_temperature',
    select: 'ambient_temperature,ext_temperature_c',
    predicate: '(ambient_temperature IS NOT NULL OR ext_temperature_c IS NOT NULL)',
    expression: 'COALESCE(ambient_temperature,ext_temperature_c)',
    value(row) { return firstFinite(row.ambient_temperature, row.ext_temperature_c); },
    rowSourceKey(row) {
      return finiteNumber(row.ambient_temperature) !== null
        ? 'ambient_temperature'
        : 'ext_temperature_c';
    },
  },
  numericPoint('relative_humidity', 'relative_humidity', '%'),
  numericPoint('wind_speed', 'wind_speed_mps', 'm/s'),
  numericPoint('wind_direction', 'wind_direction_deg', 'deg'),
  numericPoint('wind_gust', 'wind_gust_mps', 'm/s'),
]);

const CHANNEL_ORDER = Object.freeze([
  'swt_1',
  'swt_2',
  'swt_3',
  'rain_24h',
  'temperature',
  'relative_humidity',
  'wind_speed',
  'wind_direction',
  'wind_gust',
  'valve_state',
]);

function numericPoint(key, field, unit) {
  return {
    key,
    unit,
    sourceKey: field,
    select: field,
    predicate: field + ' IS NOT NULL',
    expression: field,
    value(row) { return finiteNumber(row[field]); },
    rowSourceKey() { return field; },
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFinite() {
  for (const value of arguments) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function rounded(value, digits) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const factor = Math.pow(10, digits == null ? 3 : digits);
  return Math.round(number * factor) / factor;
}

function canonicalEui(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function instant(value, name) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(name + ' must be an ISO-8601 instant');
  return new Date(milliseconds).toISOString();
}

function subtractDay(value) {
  return new Date(Date.parse(value) - DAY_MILLISECONDS).toISOString();
}

function ageSeconds(observedAt, referenceAt) {
  if (!observedAt) return null;
  return Math.max(0, Math.round((Date.parse(referenceAt) - Date.parse(observedAt)) / 1000));
}

function record(fields) {
  return {
    value: fields.value == null ? null : fields.value,
    unit: fields.unit == null ? null : fields.unit,
    source_device: fields.sourceDevice || null,
    source_key: fields.sourceKey || null,
    observed_at: fields.observedAt || null,
    statistic: fields.statistic || null,
    window_start: fields.windowStart || null,
    window_end: fields.windowEnd || null,
    sample_count: Number.isInteger(fields.sampleCount) ? fields.sampleCount : 0,
    coverage: fields.coverage == null ? null : fields.coverage,
    status: fields.status || 'unavailable',
    quality: fields.quality || 'unknown',
    freshness_threshold_s: fields.freshnessThresholdSeconds == null
      ? DAY_SECONDS
      : fields.freshnessThresholdSeconds,
    age_s: fields.ageSeconds == null ? null : fields.ageSeconds,
    reason: fields.reason || null,
  };
}

function missingRecord(definition, windowStart, windowEnd, options) {
  const details = options || {};
  return record({
    value: null,
    unit: definition.unit,
    sourceDevice: details.sourceDevice,
    sourceKey: details.sourceKey || definition.sourceKey,
    observedAt: details.observedAt,
    statistic: details.statistic || 'latest',
    windowStart,
    windowEnd,
    sampleCount: details.sampleCount || 0,
    coverage: details.coverage,
    status: 'unavailable',
    quality: details.quality || 'unknown',
    freshnessThresholdSeconds: DAY_SECONDS,
    ageSeconds: details.ageSeconds,
    reason: details.reason || 'no_data',
  });
}

function withFreshness(fields, referenceAt) {
  const age = ageSeconds(fields.observedAt, referenceAt);
  if (age !== null && age > DAY_SECONDS) {
    return record(Object.assign({}, fields, {
      value: null,
      status: 'unavailable',
      quality: 'stale',
      ageSeconds: age,
      reason: 'stale',
    }));
  }
  return record(Object.assign({}, fields, {
    status: 'available',
    ageSeconds: age,
    reason: null,
  }));
}

function placeholders(values) {
  return values.map(function() { return '?'; }).join(',');
}

async function loadSourceDevices(db, zone) {
  const rows = await db.all(
    'SELECT DISTINCT d.deveui,d.type_id,d.irrigation_zone_id,d.rain_gauge_enabled,' +
      'CASE WHEN d.irrigation_zone_id=? THEN 1 ELSE 0 END AS direct_assignment,' +
      'CASE WHEN wsz.deveui IS NULL THEN 0 ELSE 1 END AS shared_assignment ' +
    'FROM devices AS d ' +
    'LEFT JOIN weather_station_zones AS wsz ' +
      'ON wsz.deveui=d.deveui AND wsz.zone_id=? ' +
    'WHERE d.deleted_at IS NULL AND d.user_id=? AND d.gateway_device_eui=? ' +
      'AND (d.irrigation_zone_id=? OR wsz.deveui IS NOT NULL) ' +
    'ORDER BY UPPER(d.deveui)',
    [zone.zone_id, zone.zone_id, zone.user_id, zone.gateway_device_eui, zone.zone_id]
  );
  return rows.map(function(row) {
    return {
      deveui: canonicalEui(row.deveui),
      sqlDeveui: String(row.deveui),
      type_id: String(row.type_id || '').toUpperCase(),
      direct: Number(row.direct_assignment) === 1,
      shared: Number(row.shared_assignment) === 1,
      rainCapable: Number(row.rain_gauge_enabled) === 1 ||
        ['AQUASCOPE_LORAIN', 'SENSECAP_S2120'].includes(String(row.type_id || '').toUpperCase()),
    };
  }).filter(function(row) { return row.deveui; });
}

async function latestPointRecord(db, devices, definition, at) {
  const sourceEuis = devices.map(function(device) { return device.sqlDeveui; });
  const windowStart = subtractDay(at);
  if (sourceEuis.length === 0) {
    return missingRecord(definition, windowStart, at);
  }
  const rows = await db.all(
    'SELECT id,deveui,recorded_at,' + definition.select + ' FROM device_data ' +
    'WHERE deveui IN (' + placeholders(sourceEuis) + ') ' +
      'AND ' + definition.predicate + ' AND recorded_at<=? ' +
    'ORDER BY recorded_at DESC,deveui ASC,id DESC LIMIT 1',
    sourceEuis.concat([at])
  );
  const row = rows[0];
  const value = row ? definition.value(row) : null;
  if (!row || value === null) return missingRecord(definition, windowStart, at);
  const observedAt = instant(row.recorded_at, 'device_data.recorded_at');
  return withFreshness({
    value,
    unit: definition.unit,
    sourceDevice: canonicalEui(row.deveui),
    sourceKey: definition.rowSourceKey(row),
    observedAt,
    statistic: 'latest',
    windowStart,
    windowEnd: at,
    sampleCount: 1,
    coverage: null,
    quality: 'observed',
    freshnessThresholdSeconds: DAY_SECONDS,
  }, at);
}

function rainTypePriority(device) {
  return Object.prototype.hasOwnProperty.call(RAIN_DEVICE_TYPE_PRIORITY, device.type_id)
    ? RAIN_DEVICE_TYPE_PRIORITY[device.type_id]
    : RAIN_DEVICE_TYPE_PRIORITY.OTHER;
}

function rainTier(device, subjectDevice) {
  if (subjectDevice && device.deveui === subjectDevice) return RAIN_SOURCE_TIER.subject;
  if (device.direct) return RAIN_SOURCE_TIER.direct;
  return RAIN_SOURCE_TIER.shared;
}

function dedupeRainRows(rows) {
  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    const deveui = canonicalEui(row.deveui);
    const recordedAt = instant(row.recorded_at, 'rain recorded_at');
    const value = finiteNumber(row.rain_mm_delta);
    if (!deveui || value === null || value < 0) continue;
    const key = deveui + '\u0000' + recordedAt;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      id: row.id,
      deveui,
      recorded_at: recordedAt,
      rain_mm_delta: value,
    });
  }
  return deduped;
}

async function rainRecord(db, devices, subjectDevice, windowStart, windowEnd) {
  const subject = canonicalEui(subjectDevice);
  const candidates = devices.filter(function(device) {
    return device.rainCapable || (subject && device.deveui === subject);
  });
  const definition = { unit: 'mm', sourceKey: 'rain_mm_delta' };
  if (candidates.length === 0) {
    return missingRecord(definition, windowStart, windowEnd, { statistic: 'sum' });
  }
  const sourceEuis = candidates.map(function(device) { return device.sqlDeveui; });
  const rows = await db.all(
    'SELECT id,deveui,recorded_at,rain_mm_delta FROM device_data ' +
    'WHERE deveui IN (' + placeholders(sourceEuis) + ') ' +
      'AND recorded_at>=? AND recorded_at<? ' +
      "AND rain_delta_status='ok' AND rain_mm_delta IS NOT NULL AND rain_mm_delta>=0 " +
    'ORDER BY deveui,recorded_at,id',
    sourceEuis.concat([windowStart, windowEnd])
  );
  const deduped = dedupeRainRows(rows);
  const sourcesWithData = new Set(deduped.map(function(row) { return row.deveui; }));
  const selected = candidates.filter(function(device) {
    return sourcesWithData.has(device.deveui);
  }).sort(function(left, right) {
    return rainTier(left, subject) - rainTier(right, subject) ||
      rainTypePriority(left) - rainTypePriority(right) ||
      left.deveui.localeCompare(right.deveui);
  })[0];
  if (!selected) {
    return missingRecord(definition, windowStart, windowEnd, { statistic: 'sum' });
  }
  const selectedRows = deduped.filter(function(row) { return row.deveui === selected.deveui; });
  const latest = selectedRows[selectedRows.length - 1];
  const aggregation = aggregateRows(selectedRows, {
    aggregation: 'hourly',
    start: windowStart,
    end: windowEnd,
    channels: [{ id: 'rain_mm_delta', field: 'rain_mm_delta', unit: 'mm' }],
    sourceKeys: [selected.deveui],
    nowMs: Date.parse(windowEnd),
  });
  const sum = selectedRows.reduce(function(total, row) {
    return total + row.rain_mm_delta;
  }, 0);
  return record({
    value: rounded(sum),
    unit: 'mm',
    sourceDevice: selected.deveui,
    sourceKey: 'rain_mm_delta',
    observedAt: latest.recorded_at,
    statistic: 'sum',
    windowStart,
    windowEnd,
    sampleCount: selectedRows.length,
    coverage: aggregation.coveragePct,
    status: 'available',
    quality: 'valid',
    freshnessThresholdSeconds: DAY_SECONDS,
    ageSeconds: ageSeconds(latest.recorded_at, windowEnd),
    reason: null,
  });
}

async function loadValveExpectations(db, zone, at) {
  return db.all(
    'WITH assigned AS (' +
      'SELECT deveui,COUNT(*) AS assignment_count,MIN(valve_channel) AS only_channel ' +
      'FROM zone_valve_assignments WHERE zone_id=? GROUP BY deveui' +
    ') ' +
    'SELECT vae.*,' +
      'CASE WHEN vae.valve_channel IS NOT NULL THEN vae.valve_channel ' +
        'WHEN assigned.assignment_count=1 THEN assigned.only_channel ELSE NULL END ' +
        'AS resolved_valve_channel,' +
      'CASE WHEN vae.valve_channel IS NULL AND assigned.assignment_count>1 ' +
        'THEN 1 ELSE 0 END AS ambiguous_valve_channel ' +
    'FROM valve_actuation_expectations AS vae ' +
    'JOIN devices AS d ON d.deveui=vae.device_eui ' +
    'LEFT JOIN assigned ON assigned.deveui=vae.device_eui ' +
    'WHERE d.deleted_at IS NULL AND d.user_id=? AND d.gateway_device_eui=? ' +
      'AND vae.commanded_at<=? AND (' +
        'vae.zone_id=? OR EXISTS (' +
          'SELECT 1 FROM zone_valve_assignments AS match_assignment ' +
          'WHERE match_assignment.zone_id=? ' +
            'AND match_assignment.deveui=vae.device_eui ' +
            'AND (vae.valve_channel IS NULL ' +
              'OR match_assignment.valve_channel=vae.valve_channel)' +
        ')' +
      ') ' +
    'ORDER BY vae.commanded_at DESC,vae.expectation_id DESC',
    [zone.zone_id, zone.user_id, zone.gateway_device_eui, at, zone.zone_id, zone.zone_id]
  );
}

function valveSourceKey(row) {
  const channel = finiteNumber(row.resolved_valve_channel);
  return 'valve_actuation_expectations' + (channel === null ? '' : ':' + Math.round(channel));
}

function valveUnknownRecord(row, at) {
  return missingRecord(
    { unit: 'state', sourceKey: valveSourceKey(row) },
    subtractDay(at),
    at,
    {
      sourceDevice: canonicalEui(row.device_eui),
      sourceKey: valveSourceKey(row),
      statistic: 'historical_state',
      sampleCount: 1,
      quality: 'unknown',
      reason: 'unknown',
    }
  );
}

function valveValueRecord(row, at, value, observedAt, quality) {
  return withFreshness({
    value,
    unit: 'state',
    sourceDevice: canonicalEui(row.device_eui),
    sourceKey: valveSourceKey(row),
    observedAt,
    statistic: 'historical_state',
    windowStart: subtractDay(at),
    windowEnd: at,
    sampleCount: 1,
    coverage: null,
    quality,
    freshnessThresholdSeconds: DAY_SECONDS,
  }, at);
}

function stateFromExpectation(row, at) {
  const reference = Date.parse(at);
  const commandedAt = instant(row.commanded_at, 'commanded_at');
  const expectedCloseAt = instant(row.expected_close_at, 'expected_close_at');
  const observedOpenAt = row.observed_open_at
    ? instant(row.observed_open_at, 'observed_open_at')
    : null;
  const observedCloseAt = row.observed_close_at
    ? instant(row.observed_close_at, 'observed_close_at')
    : null;

  if (Number(row.ambiguous_valve_channel) === 1) return valveUnknownRecord(row, at);

  if (observedCloseAt && Date.parse(observedCloseAt) <= reference) {
    return valveValueRecord(row, at, 'CLOSED', observedCloseAt, 'observed');
  }
  if (observedOpenAt && Date.parse(observedOpenAt) <= reference) {
    if (observedCloseAt && reference < Date.parse(observedCloseAt)) {
      return valveValueRecord(row, at, 'OPEN', observedOpenAt, 'observed');
    }
    if (!observedCloseAt && row.reconciliation_state === 'OBSERVED_RUNNING' &&
        reference < Date.parse(expectedCloseAt)) {
      return valveValueRecord(row, at, 'OPEN', observedOpenAt, 'observed');
    }
  }
  if (row.reconciliation_state === 'CANCELLED') return valveUnknownRecord(row, at);
  if (reference < Date.parse(expectedCloseAt)) {
    return valveValueRecord(row, at, 'OPEN', commandedAt, 'expected');
  }
  return valveUnknownRecord(row, at);
}

async function valveRecord(db, zone, at) {
  const rows = await loadValveExpectations(db, zone, at);
  if (rows.length === 0) {
    return missingRecord(
      { unit: 'state', sourceKey: 'valve_actuation_expectations' },
      subtractDay(at),
      at,
      { statistic: 'historical_state' }
    );
  }
  return stateFromExpectation(rows[0], at);
}

async function snapshotAt(db, zone, devices, subjectDevice, at) {
  const channels = {};
  const pointRecords = await Promise.all(POINT_CHANNELS.map(function(definition) {
    return latestPointRecord(db, devices, definition, at);
  }));
  for (let index = 0; index < POINT_CHANNELS.length; index += 1) {
    channels[POINT_CHANNELS[index].key] = pointRecords[index];
  }
  channels.rain_24h = await rainRecord(db, devices, subjectDevice, subtractDay(at), at);
  channels.valve_state = await valveRecord(db, zone, at);
  const ordered = {};
  for (const key of CHANNEL_ORDER) ordered[key] = channels[key];
  return ordered;
}

function aggregationForWindow(start, end) {
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  if (seconds <= 15 * 60) return '15m';
  if (seconds <= 60 * 60) return 'hourly';
  return 'weekly';
}

function circularMeanDegrees(values) {
  if (!values.length) return null;
  let sine = 0;
  let cosine = 0;
  for (const value of values) {
    const radians = value * Math.PI / 180;
    sine += Math.sin(radians);
    cosine += Math.cos(radians);
  }
  if (Math.abs(sine) < 1e-12 && Math.abs(cosine) < 1e-12) return null;
  const degrees = Math.atan2(sine, cosine) * 180 / Math.PI;
  return rounded((degrees + 360) % 360);
}

async function operationPointRecord(db, devices, definition, sourceRecord, start, end) {
  const sourceDevice = canonicalEui(sourceRecord && sourceRecord.source_device);
  const sourceKey = sourceRecord && sourceRecord.source_key || definition.sourceKey;
  if (!sourceDevice) {
    return missingRecord(definition, start, end, {
      sourceKey,
      statistic: definition.key === 'wind_direction' ? 'circular_mean' : 'mean',
    });
  }
  const source = devices.find(function(device) { return device.deveui === sourceDevice; });
  if (!source) {
    return missingRecord(definition, start, end, {
      sourceDevice,
      sourceKey,
      statistic: definition.key === 'wind_direction' ? 'circular_mean' : 'mean',
    });
  }
  let expression = definition.expression;
  if (definition.key === 'temperature' && sourceKey === 'ext_temperature_c') {
    expression = 'ext_temperature_c';
  } else if (definition.key === 'temperature') {
    expression = 'ambient_temperature';
  }
  const rows = await db.all(
    'SELECT deveui,recorded_at,' + expression + ' AS value FROM device_data ' +
    'WHERE deveui=? AND recorded_at>=? AND recorded_at<? ' +
      'AND ' + expression + ' IS NOT NULL ORDER BY recorded_at,id',
    [source.sqlDeveui, start, end]
  );
  const validRows = rows.map(function(row) {
    return {
      deveui: canonicalEui(row.deveui),
      recorded_at: instant(row.recorded_at, 'operation recorded_at'),
      value: finiteNumber(row.value),
    };
  }).filter(function(row) { return row.value !== null; });
  if (validRows.length === 0) {
    return missingRecord(definition, start, end, {
      sourceDevice,
      sourceKey,
      statistic: definition.key === 'wind_direction' ? 'circular_mean' : 'mean',
    });
  }
  const aggregation = aggregateRows(validRows, {
    aggregation: aggregationForWindow(start, end),
    start,
    end,
    channels: [{ id: definition.key, field: 'value', unit: definition.unit }],
    sourceKeys: [sourceDevice],
    nowMs: Date.parse(end),
  });
  const buckets = aggregation.buckets || [];
  const statistics = buckets.map(function(bucket) {
    return bucket.series && bucket.series[definition.key];
  }).filter(Boolean);
  const sampleCount = statistics.reduce(function(total, stats) {
    return total + Number(stats.sampleCount || 0);
  }, 0);
  let value = null;
  let reason = null;
  let statistic = 'mean';
  if (definition.key === 'wind_direction') {
    value = circularMeanDegrees(validRows.map(function(row) { return row.value; }));
    statistic = 'circular_mean';
    if (value === null) reason = 'indeterminate_direction';
  } else {
    const weighted = statistics.reduce(function(total, stats) {
      const mean = finiteNumber(stats.mean);
      const count = Number(stats.sampleCount || 0);
      return mean === null ? total : total + mean * count;
    }, 0);
    value = sampleCount > 0 ? rounded(weighted / sampleCount) : null;
    if (value === null) reason = 'no_data';
  }
  const latest = validRows[validRows.length - 1];
  return record({
    value,
    unit: definition.unit,
    sourceDevice,
    sourceKey,
    observedAt: latest.recorded_at,
    statistic,
    windowStart: start,
    windowEnd: end,
    sampleCount,
    coverage: aggregation.coveragePct,
    status: value === null ? 'unavailable' : 'available',
    quality: aggregation.coverageConfidence || 'unknown',
    freshnessThresholdSeconds: DAY_SECONDS,
    ageSeconds: ageSeconds(latest.recorded_at, end),
    reason,
  });
}

async function operationWindow(db, zone, devices, subjectDevice, startChannels, endChannels, start, end) {
  const channels = {};
  for (const definition of POINT_CHANNELS) {
    const sourceRecord = endChannels[definition.key].source_device
      ? endChannels[definition.key]
      : startChannels[definition.key];
    channels[definition.key] = await operationPointRecord(
      db,
      devices,
      definition,
      sourceRecord,
      start,
      end
    );
  }
  channels.rain_24h = await rainRecord(db, devices, subjectDevice, start, end);
  const endValve = endChannels.valve_state;
  channels.valve_state = record({
    value: endValve.value,
    unit: endValve.unit,
    sourceDevice: endValve.source_device,
    sourceKey: endValve.source_key,
    observedAt: endValve.observed_at,
    statistic: 'historical_state',
    windowStart: start,
    windowEnd: end,
    sampleCount: endValve.sample_count,
    coverage: endValve.coverage,
    status: endValve.status,
    quality: endValve.quality,
    freshnessThresholdSeconds: endValve.freshness_threshold_s,
    ageSeconds: endValve.age_s,
    reason: endValve.reason,
  });
  const ordered = {};
  for (const key of CHANNEL_ORDER) ordered[key] = channels[key];
  return ordered;
}

async function buildContext(db, zoneRow, occurredStartUtc, occurredEndUtc) {
  if (!zoneRow || zoneRow.zone_id == null || !zoneRow.zone_uuid) return null;
  if (!db || typeof db.all !== 'function') throw new Error('buildContext requires db.all');
  const start = instant(occurredStartUtc, 'occurredStartUtc');
  const end = occurredEndUtc == null ? null : instant(occurredEndUtc, 'occurredEndUtc');
  if (end && Date.parse(end) < Date.parse(start)) {
    throw new Error('occurredEndUtc must not be before occurredStartUtc');
  }
  const zone = {
    zone_id: Number(zoneRow.zone_id),
    zone_uuid: zoneRow.zone_uuid,
    user_id: Number(zoneRow.user_id),
    gateway_device_eui: canonicalEui(zoneRow.gateway_device_eui),
  };
  const subjectDevice = canonicalEui(
    zoneRow.subject_device || zoneRow.subject_device_eui || zoneRow.device_eui
  ) || null;
  const devices = await loadSourceDevices(db, zone);
  const channels = await snapshotAt(db, zone, devices, subjectDevice, start);
  let duration = null;
  if (end && end !== start) {
    const endChannels = await snapshotAt(db, zone, devices, subjectDevice, end);
    duration = {
      end_channels: endChannels,
      operation_window: await operationWindow(
        db,
        zone,
        devices,
        subjectDevice,
        channels,
        endChannels,
        start,
        end
      ),
    };
  }
  return {
    schema_version: 1,
    plot_uuid: zoneRow.plot_uuid || null,
    zone_uuid: zone.zone_uuid,
    subject_device: subjectDevice,
    occurred_start: start,
    occurred_end: end,
    channels,
    duration,
  };
}

module.exports = {
  buildContext,
};
