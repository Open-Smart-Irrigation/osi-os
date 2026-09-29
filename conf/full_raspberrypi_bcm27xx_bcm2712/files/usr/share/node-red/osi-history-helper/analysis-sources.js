'use strict';
// Weather-kind machinery for osi-history-helper/analysis.js (final fix A7,
// queue T3 advice: split out once the final fix wave's items pushed
// analysis.js past 800 lines). Everything here is reachable only through
// analysis.js's createAnalysis(); nothing is a flow node entry point.
//
// Spec docs/superpowers/specs/2026-09-27-weather-data-view-design.md
// ("Source kinds"): SOURCE_KINDS names each weather table, its owner and
// native-step column, and per channel the column, bucket statistic and
// Open-Meteo plot offset. Table and column names are constants; a request
// selects among them through a catalogue entry built in analysis.js and
// never names one directly. The key order of each channels object is the
// order of the catalogue entries. offsetHours is keyed by the
// weather_locations row's provider: Open-Meteo stamps its instantaneous
// values at the end of the hour sub-project 1 stores as hour_start, so they
// are plotted one hour later. timeColumn is not a field here: every reader
// names its time column literally ('hour_start' or 'date') where it builds
// SQL, so a timeColumn value would never be read (final review, queue T3 N1).
const SOURCE_KINDS = {
  device: {
    table: 'device_data', ownerColumn: 'deveui',
    nativeStep: null,
    channels: null,
  },
  weather_provider: {
    table: 'weather_provider_hours', ownerColumn: 'location_key',
    nativeStep: 'hour',
    channels: {
      ambient_temperature: { column: 'air_temperature_c', stat: 'mean', offsetHours: { open_meteo: 1 } },
      relative_humidity: { column: 'relative_humidity_pct', stat: 'mean', offsetHours: { open_meteo: 1 } },
      rain_mm_per_hour: { column: 'rain_mm', stat: 'sum' },
      wind_speed_mps: { column: 'wind_speed_mps', stat: 'mean', offsetHours: { open_meteo: 1 } },
      global_radiation_wm2: { column: 'global_radiation_wm2', stat: 'mean' },
      et0_mm: { column: 'et0_mm', stat: 'sum' },
    },
  },
  weather_station: {
    table: 'weather_station_hours', ownerColumn: 'deveui',
    nativeStep: 'hour',
    channels: {
      ambient_temperature: { column: 'air_temperature_c', stat: 'mean' },
      relative_humidity: { column: 'relative_humidity_pct', stat: 'mean' },
      wind_speed_mps: { column: 'wind_speed_mps', stat: 'mean' },
      barometric_pressure_hpa: { column: 'pressure_hpa', stat: 'mean' },
      light_lux: { column: 'light_lux', stat: 'mean' },
      global_radiation_wm2: { column: 'global_radiation_wm2', stat: 'mean' },
      rain_mm_per_hour: { column: 'rain_mm', stat: 'sum' },
    },
  },
  zone_daily_agronomy: {
    table: 'zone_daily_agronomy', ownerColumn: 'zone_id',
    nativeStep: 'day',
    channels: {
      et0_mm: { column: 'et0_mm', stat: 'sum' },
      etc_mm: { column: 'etc_mm', stat: 'sum' },
    },
  },
};

// zone_id is aliased because it names the catalogue's zone, not a devices
// column: joined against a batch of zone ids (final review, queue T3 N1),
// not one query per zone.
const STATION_SOURCES_SQL = "SELECT wsz.zone_id AS zone_id, d.* FROM weather_station_zones wsz JOIN devices d ON d.deveui = wsz.deveui WHERE d.deleted_at IS NULL AND d.type_id = 'SENSECAP_S2120'";

// The four tables sub-project 1/2 add; buildAnalysisCatalog degrades to a
// device-only catalogue (final fix A4, queue T3 M1) when any is missing
// rather than answering 500, so a gateway can run this helper before its
// migration has landed.
const REQUIRED_WEATHER_TABLES = ['weather_locations', 'weather_provider_hours', 'weather_station_hours', 'zone_daily_agronomy'];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function unique(values) {
  return Array.from(new Set(values));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// weather_provider_hours and weather_station_hours store hour_start as
// 'YYYY-MM-DDTHH:MM:SSZ' (osi-station-hours/index.js header), so the SQL
// bounds use that form: string comparison then matches time order.
function storedHourStamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nextDateKey(date) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

// Rows are points when the bucket is no wider than the kind's native step.
// A hole longer than one step gets one null point at the previous point plus
// one step, so the line breaks there as it does at an empty bucket.
function rowsToPoints(rows, channelKey, { step, timezone, zoneDateStartIso }) {
  const points = [];
  let previous = null;
  for (const row of rows) {
    if (previous) {
      if (step === 'day') {
        const expectedDate = nextDateKey(previous.date);
        if (row.date !== expectedDate) {
          points.push({ t: zoneDateStartIso(expectedDate, timezone), value: null, count: 0, expected: null, quality: null });
        }
      } else if (Date.parse(row.recorded_at) - Date.parse(previous.recorded_at) > HOUR_MS) {
        points.push({ t: new Date(Date.parse(previous.recorded_at) + HOUR_MS).toISOString(), value: null, count: 0, expected: null, quality: null });
      }
    }
    const value = row[channelKey] ?? null;
    points.push({ t: row.recorded_at, value, count: value === null ? 0 : 1, expected: null, quality: null });
    previous = row;
  }
  return points;
}

const LEVEL_ORDER = ['raw', '15m', 'hourly', 'daily', 'weekly'];

function rowsArePoints(level, nativeStep) {
  const widest = nativeStep === 'day' ? 'daily' : 'hourly';
  return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(widest);
}

function expectedRows(nativeStep, level) {
  if (nativeStep === 'hour') return level === 'daily' ? 24 : level === 'weekly' ? 168 : null;
  if (nativeStep === 'day') return level === 'weekly' ? 7 : null;
  return null;
}

// 'daily' when each point stands for one zone-local day.
function seriesCadence(nativeStep, level) {
  if (nativeStep === 'day') return level === 'weekly' ? 'hourly' : 'daily';
  if (nativeStep === 'hour') return level === 'daily' ? 'daily' : 'hourly';
  return 'hourly';
}

// A summed series names the period of one point: mm/h, mm/d or mm/wk.
function periodUnit(manifestUnit, nativeStep, level) {
  const amount = String(manifestUnit || '').split('/')[0];
  if (level === 'weekly') return `${amount}/wk`;
  if (nativeStep === 'day' || level === 'daily') return `${amount}/d`;
  return `${amount}/h`;
}

function formatCoordinate(value, positive, negative) {
  const number = Number(value);
  return `${Math.abs(number).toFixed(2)}°${number < 0 ? negative : positive}`;
}

// Each known provider is named explicitly; a provider key the edge does not
// implement (a cloud-only value read back from weather_locations.provider)
// falls back to the raw key instead of being mislabelled Open-Meteo (final
// review, queue T3 N4).
function providerSourceName(row) {
  const coordinates = `${formatCoordinate(row.latitude, 'N', 'S')} ${formatCoordinate(row.longitude, 'E', 'W')}`;
  if (row.provider === 'meteoswiss') {
    const stationId = String(row.station_id || '').trim();
    if (!stationId) return `MeteoSwiss ${coordinates}`;
    const parts = ['MeteoSwiss', stationId];
    const stationName = String(row.station_name || '').trim();
    if (stationName) parts.push(stationName);
    const distance = numberOrNull(row.station_distance_km);
    if (distance !== null) parts.push(`(${Math.round(distance)} km)`);
    return parts.join(' ');
  }
  if (row.provider === 'open_meteo') return `Open-Meteo ${coordinates}`;
  const raw = String(row.provider || '').trim();
  return raw ? `${raw} ${coordinates}` : coordinates;
}

// Builds the weather-table readers analysis.js's createAnalysis() uses:
// table-presence, the location and station loaders, and the row-to-series
// resolver. Takes the subset of createAnalysis' deps these need, plus the
// two shared response builders (buildSeriesEnvelope, aggToPoints) analysis.js
// still owns because the device path uses them too.
function createWeatherSources(deps) {
  const { dbAll, zoneLocations, localDateKey, zoneDateStartIso, aggregateRows, buildSeriesEnvelope, aggToPoints } = deps || {};

  async function weatherTablesPresent(db) {
    const rows = await dbAll(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_WEATHER_TABLES.map(() => '?').join(', ')})`,
      REQUIRED_WEATHER_TABLES
    );
    return rows.length === REQUIRED_WEATHER_TABLES.length;
  }

  // zoneLocations awaits db.all(sql, params); the router hands this module an
  // osi-db-helper handle, which dbAll reads in both callback and promise form.
  async function loadZoneWeather(db, deploymentDefault) {
    const adapter = { all: (sql, params) => dbAll(db, sql, params) };
    const located = await zoneLocations(adapter, deploymentDefault);
    const byZoneId = new Map(located.map((item) => [Number(item.zone.id), item]));
    const keys = unique(located.map((item) => item.locationKey).filter(Boolean));
    const rowsByKey = new Map();
    if (keys.length) {
      const rows = await dbAll(
        db,
        `SELECT location_key, provider, latitude, longitude, station_id, station_name, station_distance_km FROM weather_locations WHERE location_key IN (${keys.map(() => '?').join(', ')})`,
        keys
      );
      for (const row of rows) rowsByKey.set(row.location_key, row);
    }
    return { byZoneId, rowsByKey };
  }

  // One query for every zone of the catalogue instead of one per zone (final
  // review, queue T3 N1); rows arrive ordered by zone then deveui, so
  // grouping them into a Map preserves the per-zone device order the single-
  // zone query gave through its own ORDER BY.
  async function loadZoneStations(db, zoneIds, userId, legacyMode) {
    const byZoneId = new Map();
    if (!zoneIds.length) return byZoneId;
    const placeholders = zoneIds.map(() => '?').join(', ');
    const rows = await dbAll(
      db,
      `${STATION_SOURCES_SQL} AND wsz.zone_id IN (${placeholders})${legacyMode ? ' AND d.user_id = ?' : ''} ORDER BY wsz.zone_id ASC, d.deveui ASC`,
      legacyMode ? [...zoneIds, userId] : zoneIds
    );
    for (const row of rows) {
      const zoneId = Number(row.zone_id);
      if (!byZoneId.has(zoneId)) byZoneId.set(zoneId, []);
      byZoneId.get(zoneId).push(row);
    }
    return byZoneId;
  }

  async function readWeatherRows(db, group, range, limit) {
    const kind = SOURCE_KINDS[group.kind];
    if (kind.nativeStep === 'day') {
      const timezone = group.entries[0].timezone;
      return dbAll(
        db,
        'SELECT date, et0_mm, etc_mm FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? AND date <= ? ORDER BY date ASC LIMIT ?',
        [group.owner, localDateKey(range.from, timezone), localDateKey(Date.parse(range.to) - 1, timezone), limit]
      );
    }
    const columns = unique(group.entries.map((entry) => kind.channels[entry.channelKey].column));
    // Only Open-Meteo plots any channel at hour_start + 1h (its three
    // instantaneous channels), so only its groups need the extra hour of
    // lookback to find the row that lands at range.from; a MeteoSwiss group
    // has no offset channel and reading one hour early finds nothing usable
    // (queue T3 N3).
    const isOpenMeteoGroup = group.kind === 'weather_provider' && group.entries[0].provider === 'open_meteo';
    const lowerMs = Math.floor(Date.parse(range.from) / 1000) * 1000 - (isOpenMeteoGroup ? HOUR_MS : 0);
    const upperMs = Math.ceil(Date.parse(range.to) / 1000) * 1000;
    return dbAll(
      db,
      `SELECT hour_start, ${columns.join(', ')} FROM ${kind.table} WHERE ${kind.ownerColumn} = ? AND hour_start >= ? AND hour_start < ? ORDER BY hour_start ASC LIMIT ?`,
      [group.owner, storedHourStamp(lowerMs), storedHourStamp(upperMs), limit]
    );
  }

  // Rows of one weather group become one channel's { recorded_at, value }
  // rows on the plotted instant, filtered to [from, to).
  function mapWeatherRows(entry, rows, range) {
    const kind = SOURCE_KINDS[entry.sourceKind];
    const channel = kind.channels[entry.channelKey];
    const fromMs = Date.parse(range.from);
    const toMs = Date.parse(range.to);
    const offsetMs = ((channel.offsetHours && channel.offsetHours[entry.provider]) || 0) * HOUR_MS;
    return rows
      .map((row) => (kind.nativeStep === 'day'
        ? { recorded_at: zoneDateStartIso(row.date, entry.timezone), date: row.date, [entry.channelKey]: numberOrNull(row[channel.column]) }
        : { recorded_at: new Date(Date.parse(row.hour_start) + offsetMs).toISOString(), [entry.channelKey]: numberOrNull(row[channel.column]) }))
      .filter((row) => {
        const ms = Date.parse(row.recorded_at);
        return ms >= fromMs && ms < toMs;
      });
  }

  function weatherSeries(entry, rows, range, aggregationInfo, bucketSkeletonCache) {
    const kind = SOURCE_KINDS[entry.sourceKind];
    const channel = kind.channels[entry.channelKey];
    const level = aggregationInfo.level;
    const mapped = mapWeatherRows(entry, rows, range);
    const points = rowsArePoints(level, kind.nativeStep)
      ? rowsToPoints(mapped, entry.channelKey, { step: kind.nativeStep, timezone: entry.timezone, zoneDateStartIso })
      : aggToPoints(
        aggregateRows(mapped, {
          aggregation: level,
          aggregationRequested: aggregationInfo.requested,
          channels: [{ id: entry.channelKey, field: entry.channelKey, unit: entry.unit }],
          from: range.from,
          to: range.to,
          timezone: entry.timezone,
          // Only the zone_daily_agronomy kind (native step 'day') ever
          // reaches aggregateRows at a level wider than its native step
          // other than 'weekly' -- rowsArePoints keeps raw..daily on the
          // rowsToPoints path -- so this only ever fires for its weekly
          // buckets, and steps them by seven local dates (final fix A2).
          localDaysPerBucket: kind.nativeStep === 'day' ? 7 : undefined,
          // One group (one zone/timezone/range/aggregation) resolves one
          // series per selected channel; the bucket geometry is identical
          // across them, so it is built once per group and cloned per
          // channel instead of recomputed per series (final fix A1).
          bucketSkeletonCache,
        }),
        entry.channelKey,
        { stat: channel.stat, expected: expectedRows(kind.nativeStep, level) }
      );
    return buildSeriesEnvelope(entry, {
      unit: channel.stat === 'sum' ? periodUnit(entry.unit, kind.nativeStep, level) : entry.unit,
      points,
      cadence: seriesCadence(kind.nativeStep, level),
    });
  }

  return {
    weatherTablesPresent,
    loadZoneWeather,
    loadZoneStations,
    readWeatherRows,
    weatherSeries,
  };
}

module.exports = {
  SOURCE_KINDS,
  REQUIRED_WEATHER_TABLES,
  providerSourceName,
  createWeatherSources,
};
