'use strict';
// X3: preserve the legacy handler bodies, including compatibility SQL, cache
// policy, and caught failures. Behavioral changes belong to their later packages.
// All request state and runtime services are injected per invocation.
const runProjection = require('./run-projection');

function environmentSummary(msg, { db, ZE, osiLib, crypto, httpLib, httpsLib, env, node, global, Date = globalThis.Date }) {
return (async () => {
function getAuthSecret() {
  // Recomputed locally rather than reading the outer scopedOn const: this
  // node's bearer-auth call site runs before that const's declaration in
  // source order, so closing over it here would be a temporal-dead-zone
  // ReferenceError, not a scope violation.
  const scopedForSecret = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  if (scopedForSecret) {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      const error = new Error('Authentication scope helper unavailable');
      error.statusCode = 500;
      throw error;
    }
    return scopeLoad.value.resolveAuthSecret({
      configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
      fs: global.get('fs'),
      warn: (message) => node.warn(message),
    });
  }
  // Flag-off: pure passthrough, zero new dependencies -- this path must never
  // touch osiLib/the scope helper (design contract: byte-equivalent to the
  // pre-port route). Inlines the same secret-resolution logic
  // resolveAuthSecret() implements, for the flag-off case only.
  const configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();
  if (configured) return configured;
  const fsMod = global.get('fs');
  const secretPaths = ['/data/db/osi_auth_token_secret', '/var/lib/node-red/.node-red/osi_auth_token_secret'];
  if (fsMod) {
    for (const secretPath of secretPaths) {
      try {
        const existing = String(fsMod.readFileSync(secretPath, 'utf8') || '').trim();
        if (existing) return existing;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          node.warn('zone-env auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('zone-env auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
      }
    }
  }
  const err = new Error('AUTH_TOKEN_SECRET or JWT_SECRET must be configured');
  err.statusCode = 500;
  throw err;
}function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(input) {
  let value = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return Buffer.from(value, 'base64');
}
function verifyBearer(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const token = authHeader.substring(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    throw err;
  }
  const payloadB64 = parts[0];
  const sig = parts[1];
  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch (_) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    throw err;
  }
  const userId = Number(payload.userId);
  const username = String(payload.username || '').trim();
  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(userId) || !username) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    throw err;
  }
  if (exp && Date.now() > exp) {
    const err = new Error('Token expired');
    err.statusCode = 401;
    throw err;
  }
  return { userId, username };
}
const _db = db;
const q = (sql) => new Promise((res, rej) => _db.all(sql, (e, r) => e ? rej(e) : res(r || [])));
const run = (sql) => new Promise((res, rej) => _db.run(sql, (e) => e ? rej(e) : res(true)));
const close = () => new Promise((res) => _db.close(() => res()));
const _rainLoad = osiLib.require('rain');
if (!_rainLoad.ok) {
  msg.statusCode = 503;
  msg.payload = { error: 'module_unavailable', module: 'rain', message: _rainLoad.error };
  node.error('Zone Env Summary: rain module unavailable: ' + _rainLoad.error, msg);
  await close();
  return msg;
}
const R = _rainLoad.value;


function s(v) {
  return v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
}
function respond(data, code) {
  msg.statusCode = code || 200;
  msg.payload = data;
  msg.headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json'
  };
  return msg;
}
function buildFormBody(values) {
  return Object.keys(values || {}).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(values[key] == null ? '' : values[key])).join('&');
}
function requestJson(method, urlString, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const lib = urlString.startsWith('https:') ? httpsLib : httpLib;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000) || 10000);
    const req = lib.request(urlString, { method, headers: options.headers || {} }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const status = Number(res.statusCode || 0);
        if (status < 200 || status >= 300) {
          return reject(new Error('HTTP ' + status + (data ? ': ' + String(data).slice(0, 200) : '')));
        }
        if (!data) return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (options.body != null) req.write(options.body);
    req.end();
  });
}
async function getLinkedServerTarget(userId) {
  const rows = await q(
    'SELECT auth_mode,server_url,server_sync_token,server_sync_token_expires_at FROM users ' +
    'WHERE id=' + Number(userId) + ' LIMIT 1'
  );
  const row = rows[0];
  if (!row) return null;
  const authMode = String(row.auth_mode || '').trim().toLowerCase();
  const serverUrl = ZE.normalizeCloudServerUrl(row.server_url);
  const syncToken = ZE.trimToNull(row.server_sync_token);
  if (authMode !== 'server' || !serverUrl || !syncToken) return null;
  return {
    serverUrl,
    syncToken,
    syncTokenExpiresAt: ZE.toFiniteNumber(row.server_sync_token_expires_at)
  };
}
async function getCachedSharedBundle(zoneUuid) {
  const normalizedZoneUuid = ZE.trimToNull(zoneUuid);
  if (!normalizedZoneUuid) return null;
  const rows = await q(
    'SELECT summary_json,shared_generated_at,shared_observed_at,last_received_at FROM zone_shared_environment ' +
    'WHERE zone_uuid=' + s(normalizedZoneUuid) + ' LIMIT 1'
  );
  const row = rows[0];
  if (!row) return null;
  const summary = ZE.safeJsonParse(row.summary_json);
  if (!summary) return null;
  return {
    summary,
    sharedGeneratedAt: ZE.trimToNull(row.shared_generated_at),
    sharedObservedAt: ZE.trimToNull(row.shared_observed_at),
    lastReceivedAt: ZE.trimToNull(row.last_received_at)
  };
}
async function putSharedBundle(zone, summary, nowIso) {
  const zoneUuid = ZE.trimToNull(zone && zone.zone_uuid);
  if (!zoneUuid || !summary || typeof summary !== 'object') return;
  const display = summary.display && typeof summary.display === 'object' ? summary.display : {};
  const sharedGeneratedAt = ZE.trimToNull(display.sharedGeneratedAt) || ZE.trimToNull(summary.generatedAt) || nowIso;
  const sharedObservedAt =
    ZE.trimToNull(display.sharedObservedAt) ||
    ZE.trimToNull(summary && summary.water && summary.water.observedAt) ||
    ZE.trimToNull(summary && summary.online && summary.online.observedAt) ||
    ZE.trimToNull(summary && summary.local && summary.local.observedAt) ||
    null;
  await run(
    'INSERT INTO zone_shared_environment(zone_uuid,zone_id,gateway_device_eui,summary_json,shared_generated_at,shared_observed_at,last_received_at) VALUES(' +
    s(zoneUuid) + ',' + Number(zone.id) + ',' + s(zone.gateway_device_eui || null) + ',' + s(JSON.stringify(summary)) + ',' +
    s(sharedGeneratedAt) + ',' + s(sharedObservedAt) + ',' + s(nowIso) + ') ' +
    'ON CONFLICT(zone_uuid) DO UPDATE SET zone_id=excluded.zone_id,gateway_device_eui=excluded.gateway_device_eui,summary_json=excluded.summary_json,shared_generated_at=excluded.shared_generated_at,shared_observed_at=excluded.shared_observed_at,last_received_at=excluded.last_received_at'
  );
}
async function fetchSharedBundle(linkTarget, zone) {
  if (!linkTarget || !zone) return null;
  const zoneUuid = ZE.trimToNull(zone.zone_uuid);
  const gatewayDeviceEui = ZE.trimToNull(zone.gateway_device_eui);
  if (!zoneUuid || !gatewayDeviceEui) return null;
  const url = linkTarget.serverUrl +
    '/api/v1/sync/gateways/' + encodeURIComponent(String(gatewayDeviceEui).toUpperCase()) +
    '/environment-bundles?zoneUuid=' + encodeURIComponent(zoneUuid);
  const response = await requestJson('GET', url, {
    headers: {
      Authorization: 'Bearer ' + linkTarget.syncToken
    },
    timeoutMs: 5000
  });
  if (!Array.isArray(response) || !response.length) return null;
  const entry = response.find(item => ZE.trimToNull(item && item.zoneUuid) === zoneUuid) || response[0];
  return entry && entry.summary ? entry.summary : null;
}
async function fetchOpenAgriToken(baseUrl, bearerToken, username, password) {
  const staticToken = ZE.trimToNull(bearerToken);
  if (staticToken) return staticToken;
  const user = ZE.trimToNull(username);
  const pass = ZE.trimToNull(password);
  if (!baseUrl || !user || !pass) return null;
  const body = buildFormBody({ username: user, password: pass });
  const tokenResp = await requestJson('POST', baseUrl + '/api/v1/auth/token', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  });
  return ZE.trimToNull(tokenResp && tokenResp.jwt_token);
}
async function fetchOpenAgriCurrent(baseUrl, bearerToken, username, password, latitude, longitude) {
  if (!baseUrl) return null;
  const token = await fetchOpenAgriToken(baseUrl, bearerToken, username, password);
  if (!token) return null;
  const response = await requestJson('GET', baseUrl + '/api/data/weather/?lat=' + encodeURIComponent(latitude) + '&lon=' + encodeURIComponent(longitude), {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = response && response.data;
  const main = data && typeof data.main === 'object' ? data.main : null;
  if (!main) return null;
  const weather = Array.isArray(data.weather) ? data.weather : [];
  const wind = data && typeof data.wind === 'object' ? data.wind : null;
  return {
    source: 'openagri',
    observedAt: data && data.dt ? new Date(Number(data.dt) * 1000).toISOString() : new Date().toISOString(),
    description: weather[0] && weather[0].description ? String(weather[0].description) : null,
    airTemperatureC: ZE.round(main.temp, 2),
    relativeHumidityPct: ZE.round(main.humidity, 1),
    pressureHpa: ZE.round(main.pressure, 1),
    windSpeedMps: wind ? ZE.round(wind.speed, 2) : null,
    windDirectionDeg: wind ? ZE.round(wind.deg, 1) : null,
    cloudCoverPct: null,
    rainMm: null,
    precipitationProbabilityPct: null
  };
}
async function fetchOpenAgriForecast(baseUrl, bearerToken, username, password, latitude, longitude) {
  if (!baseUrl) return null;
  const token = await fetchOpenAgriToken(baseUrl, bearerToken, username, password);
  if (!token) return null;
  const response = await requestJson('GET', baseUrl + '/api/data/forecast5/?lat=' + encodeURIComponent(latitude) + '&lon=' + encodeURIComponent(longitude), {
    headers: { Authorization: 'Bearer ' + token }
  });
  return ZE.parseOpenAgriForecast(response, { observedAtMs: Date.now() });
}
async function fetchOpenMeteoCurrent(latitude, longitude, timezone) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(latitude) +
    '&longitude=' + encodeURIComponent(longitude) +
    '&current=temperature_2m,relative_humidity_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m' +
    '&timezone=' + encodeURIComponent(timezone || 'UTC') + '&timeformat=unixtime';
  const response = await requestJson('GET', url);
  const current = response && response.current;
  if (!current) return null;
  return {
    source: 'open_meteo',
    observedAt: ZE.openMeteoInstantIso(current.time, response.utc_offset_seconds) || new Date().toISOString(),
    description: null,
    airTemperatureC: ZE.round(current.temperature_2m, 2),
    relativeHumidityPct: ZE.round(current.relative_humidity_2m, 1),
    pressureHpa: ZE.round(current.pressure_msl, 1),
    windSpeedMps: ZE.round(current.wind_speed_10m, 2),
    windDirectionDeg: ZE.round(current.wind_direction_10m, 1),
    cloudCoverPct: ZE.round(current.cloud_cover, 1),
    rainMm: ZE.round(current.precipitation, 2),
    precipitationProbabilityPct: null
  };
}
async function fetchOpenMeteoForecast(latitude, longitude, timezone) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(latitude) +
    '&longitude=' + encodeURIComponent(longitude) +
    '&hourly=temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m' +
    '&daily=weather_code,precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration,temperature_2m_min,temperature_2m_max' +
    '&forecast_days=6' +
    '&timezone=' + encodeURIComponent(timezone || 'UTC') + '&timeformat=unixtime';
  const response = await requestJson('GET', url);
  return ZE.parseOpenMeteoForecast(response, { timezone: timezone || 'UTC' });
}
const loadEstimatedIrrigationByLocalDate = (zone, startIso, endIso) =>
  runProjection.loadEstimatedIrrigationByLocalDate(zone, startIso, endIso, { osiLib, node, q, ZE, s, Date });
async function buildWaterHistory(zone, todayIso, waterNeededTodayMm, todayAgronomic, rainGaugePresent) {
  const startIso = ZE.addUtcDays(todayIso, -6) || todayIso;
  const w = ' WHERE zone_id=' + Number(zone.id) + ' AND date >= ' + s(startIso) + ' AND date <= ' + s(todayIso);
  const envRows = await q('SELECT date,rainfall_mm,flow_liters,rain_source,rain_coverage,rain_policy_version,rain_received_mm FROM zone_daily_environment' + w + ' ORDER BY date ASC');
  const agronomyRows = await q('SELECT date,et0_mm,et0_source,et0_tier,et0_station_id,kc,kc_source,crop_type,phenological_stage,stage_overrun,etc_mm,hours_present,expected_hours,null_reason FROM zone_daily_agronomy' + w);
  const stationNames = {};
  for (const r of await q('SELECT deveui,name FROM devices WHERE deveui IN (SELECT et0_station_id FROM zone_daily_agronomy' + w + ')')) stationNames[r.deveui] = r.name;
  const estimatedByDate = await loadEstimatedIrrigationByLocalDate(zone, startIso, todayIso);
  return ZE.buildWaterDaily({ envRows, estimatedByDate, agronomyRows, zone, todayIso, waterNeededTodayMm, todayAgronomic, stationNames, rainGaugePresent });
}
async function buildWaterEnvironment(zone, deviceRows, local, agronomic, forecast, nowIso, forecastPayload) {
  const nowMs = new Date(nowIso).getTime();
  const todayIso = ZE.localDateIso(nowIso, zone && zone.timezone, nowMs) || nowIso.slice(0, 10);
  const todayEnvironmentRows = await q(
    'SELECT date,rainfall_mm,flow_liters,rain_source,computed_at FROM zone_daily_environment ' +
    'WHERE zone_id=' + Number(zone.id) + ' AND date=' + s(todayIso) + ' LIMIT 1'
  );
  const recommendationRows = await q(
    'SELECT date,irrigation_action,action_reasoning,computed_at FROM zone_daily_recommendations ' +
    'WHERE zone_id=' + Number(zone.id) + ' AND date=' + s(todayIso) + ' LIMIT 1'
  );
  const estimatedByDate = await loadEstimatedIrrigationByLocalDate(zone, todayIso, todayIso);
  const todayEnvironment = todayEnvironmentRows[0] || null;
  const todayRecommendation = recommendationRows[0] || null;
  const sensorHealth = ZE.buildSensorHealth(deviceRows, local);
  // Provider rain enters the existing four-step policy only as elapsed, source-supported evidence.
  const providerRain = ZE.providerRainToday(forecastPayload, zone && zone.timezone, todayIso, nowMs);
  const rainAdvice = await R.resolveAdviceRain(_db, zone.id, todayIso, providerRain, { nowMs, legacyRainMm: (row) => ZE.resolveRainTodayMm(row, sensorHealth.rainGaugePresent) });
  const rainTodayMm = rainAdvice.amountMm != null ? ZE.round(rainAdvice.amountMm, 2) : null;
  const irrigationTodayMeasuredLiters = ZE.round(todayEnvironment ? todayEnvironment.flow_liters : 0, 2) || 0;
  const irrigationTodayEstimatedLiters = ZE.round(estimatedByDate[todayIso] || 0, 2) || 0;
  const measuredIrrigationNetMm = ZE.toEffectiveIrrigationMm(irrigationTodayMeasuredLiters, zone && zone.area_m2, zone && zone.irrigation_efficiency_pct);
  const estimatedIrrigationNetMm = ZE.toEffectiveIrrigationMm(irrigationTodayEstimatedLiters, zone && zone.area_m2, zone && zone.irrigation_efficiency_pct);
  const irrigationTodayLiters = irrigationTodayMeasuredLiters;
  const irrigationTodayNetMm = measuredIrrigationNetMm;
  const waterNeededTodayMm = agronomic && agronomic.current ? ZE.toFiniteNumber(agronomic.current.etcMmDay) : null;
  const balanceTodayMm = rainTodayMm != null && measuredIrrigationNetMm != null && waterNeededTodayMm != null
    ? ZE.round(rainTodayMm + measuredIrrigationNetMm - waterNeededTodayMm, 2)
    : null;
  const next24hRainMm = forecast && forecast.rainFocus ? ZE.toFiniteNumber(forecast.rainFocus.totalNext24hMm) : null;
  return {
    available: !!todayEnvironment || irrigationTodayEstimatedLiters > 0 || !!(local && local.available) || !!(agronomic && agronomic.current) || !!(forecast && forecast.available),
    observedAt: ZE.maxInstant(
      ZE.maxInstant(ZE.maxInstant(local && local.observedAt, todayEnvironment && todayEnvironment.computed_at), todayRecommendation && todayRecommendation.computed_at),
      rainAdvice.amountMm != null && rainAdvice.source !== 'local_gauge' && forecastPayload ? forecastPayload.observedAt : null
    ),
    areaM2: ZE.toFiniteNumber(zone && zone.area_m2),
    irrigationEfficiencyPct: ZE.toFiniteNumber(zone && zone.irrigation_efficiency_pct),
    rainTodayMm,
    rainTodayStatus: rainTodayMm == null ? 'unknown' : 'observed',
    rainSource: rainTodayMm == null ? null : rainAdvice.source === 'local_gauge' ? 'gauge' : 'weather_service',
    rainTodayCoverage: rainAdvice.coverage,
    rainTodayReceivedMm: rainAdvice.lowerBoundMm,
    rainTodayReasons: rainAdvice.reasons,
    irrigationTodayLiters,
    irrigationTodayNetMm,
    irrigationTodayMeasuredLiters,
    irrigationTodayEstimatedLiters,
    measuredIrrigationNetMm,
    estimatedIrrigationNetMm,
    waterNeededTodayMm: waterNeededTodayMm != null ? ZE.round(waterNeededTodayMm, 2) : null,
    balanceTodayMm,
    next24hRainMm: next24hRainMm != null ? ZE.round(next24hRainMm, 2) : null,
    action: ZE.resolveWaterAction(todayIso, todayRecommendation, balanceTodayMm, next24hRainMm, waterNeededTodayMm, rainTodayMm != null, measuredIrrigationNetMm),
    todayDate: todayIso,
    daily: await buildWaterHistory(zone, todayIso, waterNeededTodayMm != null ? ZE.round(waterNeededTodayMm, 2) : null, agronomic && agronomic.current, sensorHealth.rainGaugePresent),
    sensorHealth
  };
}

async function ensureSchema() {
  const migrations = [
    'ALTER TABLE irrigation_zones ADD COLUMN timezone TEXT DEFAULT \'UTC\'',
    'ALTER TABLE irrigation_zones ADD COLUMN latitude REAL',
    'ALTER TABLE irrigation_zones ADD COLUMN longitude REAL',
    'ALTER TABLE irrigation_zones ADD COLUMN phenological_stage TEXT DEFAULT \'default\'',
    'ALTER TABLE irrigation_zones ADD COLUMN gateway_device_eui TEXT',
    'ALTER TABLE irrigation_zones ADD COLUMN area_m2 REAL',
    'ALTER TABLE irrigation_zones ADD COLUMN irrigation_efficiency_pct REAL',
    'ALTER TABLE irrigation_zones ADD COLUMN scheduling_mode TEXT DEFAULT \'local\'',
    'ALTER TABLE irrigation_zones ADD COLUMN deleted_at DATETIME',
    'ALTER TABLE devices ADD COLUMN deleted_at DATETIME',
    'CREATE TABLE IF NOT EXISTS zone_shared_environment(zone_uuid TEXT PRIMARY KEY,zone_id INTEGER,gateway_device_eui TEXT,summary_json TEXT NOT NULL,shared_generated_at TEXT,shared_observed_at TEXT,last_received_at TEXT NOT NULL,FOREIGN KEY(zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE)',
    'CREATE INDEX IF NOT EXISTS idx_zone_shared_environment_zone_id ON zone_shared_environment(zone_id)',
    'CREATE INDEX IF NOT EXISTS idx_zone_shared_environment_received_at ON zone_shared_environment(last_received_at)',
    'CREATE TABLE IF NOT EXISTS gateway_locations(gateway_device_eui TEXT PRIMARY KEY,latitude REAL,longitude REAL,altitude_m REAL,accuracy_m REAL,hdop REAL,satellites INTEGER,fix_mode INTEGER,status TEXT DEFAULT \'no_fix\',source TEXT DEFAULT \'gpsd\',native_concentratord_status TEXT,chirpstack_mirror_status TEXT,last_fix_at TEXT,last_good_fix_at TEXT,sync_version INTEGER DEFAULT 0,updated_at TEXT)',
    'CREATE TABLE IF NOT EXISTS zone_weather_cache(zone_id INTEGER NOT NULL,cache_key TEXT NOT NULL,source TEXT,payload_json TEXT NOT NULL,observed_at TEXT,fetched_at TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(zone_id,cache_key),FOREIGN KEY(zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE)',
    "CREATE TABLE IF NOT EXISTS valve_actuation_expectations(expectation_id TEXT PRIMARY KEY,device_eui TEXT NOT NULL,zone_id INTEGER,command_id TEXT,effect_key TEXT,commanded_at TEXT NOT NULL,commanded_duration_seconds INTEGER NOT NULL,expected_close_at TEXT NOT NULL,flow_rate_lpm REAL,flow_rate_source TEXT,estimated_gross_liters REAL,volume_source TEXT NOT NULL DEFAULT 'unknown',observed_open_at TEXT,observed_close_at TEXT,reconciliation_state TEXT NOT NULL DEFAULT 'PENDING_OBSERVATION',cancel_reason TEXT,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
  ];
  for (const sql of migrations) {
    try { await run(sql); } catch (error) {
      const expected = /^duplicate column name:/i.test(String(error && error.message || error)) && /^ALTER TABLE /.test(sql);
      node.warn('zone-env compatibility DDL ' + (expected ? 'already present: ' : 'failed: ') + sql + ': ' + String(error && error.message || error));
    }
  }
}
async function getCache(zoneId, cacheKey) {
  const rows = await q('SELECT payload_json,source,observed_at,fetched_at,expires_at FROM zone_weather_cache WHERE zone_id=' + Number(zoneId) + ' AND cache_key=' + s(cacheKey) + ' LIMIT 1');
  const row = rows[0];
  if (!row) return null;
  const payload = ZE.safeJsonParse(row.payload_json);
  if (!payload) return null;
  return {
    payload,
    source: row.source || null,
    observedAt: row.observed_at || null,
    fetchedAt: row.fetched_at || null,
    expiresAt: row.expires_at || null
  };
}
async function putCache(zoneId, cacheKey, payload, source, observedAt, expiresAt, nowIso) {
  const payloadJson = JSON.stringify(payload || {});
  await run(
    'INSERT INTO zone_weather_cache(zone_id,cache_key,source,payload_json,observed_at,fetched_at,expires_at) VALUES(' +
    Number(zoneId) + ',' + s(cacheKey) + ',' + s(source || null) + ',' + s(payloadJson) + ',' + s(observedAt || null) + ',' + s(nowIso) + ',' + s(expiresAt) + ') ' +
    'ON CONFLICT(zone_id,cache_key) DO UPDATE SET source=excluded.source,payload_json=excluded.payload_json,observed_at=excluded.observed_at,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at'
  );
}
async function resolveOnlineCurrent(zone, location, nowIso) {
  if (location.latitude == null || location.longitude == null) {
    return { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null };
  }
  // _v2: entries cached before Open-Meteo times were read as instants held
  // local times read as UTC; they are never served.
  const cacheKey = 'online_current_v2';
  const cached = await getCache(zone.id, cacheKey);
  if (cached && ZE.cacheStatus(nowIso, cached.expiresAt) === 'live') {
    return {
      available: true,
      source: cached.payload.source || cached.source || 'open_meteo',
      cacheStatus: 'live',
      observedAt: cached.payload.observedAt || cached.observedAt || null,
      expiresAt: cached.expiresAt,
      current: {
        description: cached.payload.description || null,
        airTemperatureC: cached.payload.airTemperatureC ?? null,
        relativeHumidityPct: cached.payload.relativeHumidityPct ?? null,
        pressureHpa: cached.payload.pressureHpa ?? null,
        windSpeedMps: cached.payload.windSpeedMps ?? null,
        windDirectionDeg: cached.payload.windDirectionDeg ?? null,
        cloudCoverPct: cached.payload.cloudCoverPct ?? null,
        rainMm: cached.payload.rainMm ?? null,
        precipitationProbabilityPct: cached.payload.precipitationProbabilityPct ?? null
      }
    };
  }
  const baseUrl = ZE.trimToNull(env.get('OPENAGRI_WEATHER_URL'));
  const bearerToken = ZE.trimToNull(env.get('OPENAGRI_WEATHER_BEARER_TOKEN'));
  const username = ZE.trimToNull(env.get('OPENAGRI_WEATHER_USERNAME'));
  const password = ZE.trimToNull(env.get('OPENAGRI_WEATHER_PASSWORD'));
  const ttlMinutes = Math.max(5, parseInt(env.get('OPENAGRI_WEATHER_CURRENT_CACHE_MINUTES') || '30', 10) || 30);
  let payload = null;
  try {
    payload = await fetchOpenAgriCurrent(baseUrl, bearerToken, username, password, location.latitude, location.longitude);
  } catch (error) { node.warn('zone-env OpenAgri current failed: ' + String(error && error.message || error)); }
  if (!payload) {
    try {
      payload = await fetchOpenMeteoCurrent(location.latitude, location.longitude, location.timezone);
    } catch (error) { node.warn('zone-env Open-Meteo current failed: ' + String(error && error.message || error)); }
  }
  if (payload) {
    const expiresAt = new Date(new Date(nowIso).getTime() + ttlMinutes * 60000).toISOString();
    await putCache(zone.id, cacheKey, payload, payload.source, payload.observedAt, expiresAt, nowIso);
    return {
      available: true,
      source: payload.source || 'open_meteo',
      cacheStatus: 'live',
      observedAt: payload.observedAt || nowIso,
      expiresAt,
      current: {
        description: payload.description || null,
        airTemperatureC: payload.airTemperatureC ?? null,
        relativeHumidityPct: payload.relativeHumidityPct ?? null,
        pressureHpa: payload.pressureHpa ?? null,
        windSpeedMps: payload.windSpeedMps ?? null,
        windDirectionDeg: payload.windDirectionDeg ?? null,
        cloudCoverPct: payload.cloudCoverPct ?? null,
        rainMm: payload.rainMm ?? null,
        precipitationProbabilityPct: payload.precipitationProbabilityPct ?? null
      }
    };
  }
  if (cached) {
    return {
      available: true,
      source: cached.payload.source || cached.source || 'open_meteo',
      cacheStatus: 'stale',
      observedAt: cached.payload.observedAt || cached.observedAt || null,
      expiresAt: cached.expiresAt || null,
      current: {
        description: cached.payload.description || null,
        airTemperatureC: cached.payload.airTemperatureC ?? null,
        relativeHumidityPct: cached.payload.relativeHumidityPct ?? null,
        pressureHpa: cached.payload.pressureHpa ?? null,
        windSpeedMps: cached.payload.windSpeedMps ?? null,
        windDirectionDeg: cached.payload.windDirectionDeg ?? null,
        cloudCoverPct: cached.payload.cloudCoverPct ?? null,
        rainMm: cached.payload.rainMm ?? null,
        precipitationProbabilityPct: cached.payload.precipitationProbabilityPct ?? null
      }
    };
  }
  return { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, current: null };
}
async function resolveForecast(zone, location, crop, nowIso) {
  if (location.latitude == null || location.longitude == null) {
    return { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null };
  }
  const cacheKey = 'forecast_v2'; // _v2: see online_current_v2
  const cached = await getCache(zone.id, cacheKey);
  if (cached && ZE.cacheStatus(nowIso, cached.expiresAt) === 'live') {
    return ZE.buildForecastSection(cached.payload, 'live', cached.expiresAt, crop, nowIso);
  }
  const baseUrl = ZE.trimToNull(env.get('OPENAGRI_WEATHER_URL'));
  const bearerToken = ZE.trimToNull(env.get('OPENAGRI_WEATHER_BEARER_TOKEN'));
  const username = ZE.trimToNull(env.get('OPENAGRI_WEATHER_USERNAME'));
  const password = ZE.trimToNull(env.get('OPENAGRI_WEATHER_PASSWORD'));
  const ttlMinutes = Math.max(10, parseInt(env.get('OPENAGRI_WEATHER_FORECAST_CACHE_MINUTES') || '120', 10) || 120);
  let primary = null;
  let supplement = null;
  try {
    primary = await fetchOpenAgriForecast(baseUrl, bearerToken, username, password, location.latitude, location.longitude);
  } catch (error) { node.warn('zone-env OpenAgri forecast failed: ' + String(error && error.message || error)); }
  try {
    supplement = await fetchOpenMeteoForecast(location.latitude, location.longitude, location.timezone);
  } catch (error) { node.warn('zone-env Open-Meteo forecast failed: ' + String(error && error.message || error)); }
  const merged = ZE.mergeForecasts(primary, supplement, { nowMs: Date.now() });
  if (merged) {
    const expiresAt = new Date(new Date(nowIso).getTime() + ttlMinutes * 60000).toISOString();
    await putCache(zone.id, cacheKey, merged, merged.source, merged.observedAt, expiresAt, nowIso);
    return ZE.buildForecastSection(merged, 'live', expiresAt, crop, nowIso);
  }
  if (cached) {
    return ZE.buildForecastSection(cached.payload, 'stale', cached.expiresAt, crop, nowIso);
  }
  return { available: false, source: 'unavailable', cacheStatus: 'miss', observedAt: null, expiresAt: null, rainFocus: null };
}

function unavailableOnlineSection() {
  return {
    available: false,
    source: 'unavailable',
    cacheStatus: 'miss',
    observedAt: null,
    expiresAt: null,
    current: null,
    warnings: ['weather_provider_unavailable']
  };
}
function unavailableForecastSection() {
  return {
    available: false,
    source: 'unavailable',
    cacheStatus: 'miss',
    observedAt: null,
    expiresAt: null,
    rainFocus: null,
    warnings: ['weather_provider_unavailable']
  };
}
async function safeResolveOnlineCurrent(zone, location, nowIso) {
  try {
    return await resolveOnlineCurrent(zone, location, nowIso);
  } catch (error) {
    node.warn('environment online weather unavailable: ' + (error && error.message ? error.message : error));
    return unavailableOnlineSection();
  }
}
async function safeResolveForecast(zone, location, crop, nowIso) {
  try {
    return await resolveForecast(zone, location, crop, nowIso);
  } catch (error) {
    node.warn('environment forecast unavailable: ' + (error && error.message ? error.message : error));
    return unavailableForecastSection();
  }
}

try {
  const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);
  const zoneId = parseInt(msg.req && msg.req.params && msg.req.params.zone_id, 10);
  if (!Number.isFinite(zoneId)) {
    await close();
    return respond({ error: 'Invalid zone ID' }, 400);
  }

  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  if (scopedOn) {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      node.error('zone-read: scope module unavailable: ' + scopeLoad.error, msg);
      throw error;
    }
    const user = await _db.get(
      'SELECT user_uuid FROM users WHERE id = ? AND username = ?',
      [auth.userId, auth.username]
    );
    if (!user || !user.user_uuid) {
      const error = new Error('forbidden');
      error.statusCode = 403;
      throw error;
    }
    // Write-only scoping (W1): zone reads are account-wide. The zone-existence
    // 404 stays honest (P8) and the enabled-account check is the only gate (P1).
    const zoneUuid = await scopeLoad.value.resolveZoneUuidById(_db, zoneId);
    if (!zoneUuid) {
      const error = new Error('zone not found');
      error.statusCode = 404;
      throw error;
    }
    await scopeLoad.value.assertEnabledAccount(
      _db,
      user.user_uuid,
      { scopedMode: true }
    );
  }

  await ensureSchema();

  const zones = await q(
    'SELECT iz.id,iz.name,iz.zone_uuid,iz.timezone,iz.latitude,iz.longitude,iz.gateway_device_eui,iz.phenological_stage,iz.stage_started_on,iz.crop_type,iz.area_m2,iz.irrigation_efficiency_pct,COALESCE(iz.scheduling_mode,\'local\') AS scheduling_mode,' +
    '(SELECT trigger_metric FROM irrigation_schedules WHERE irrigation_zone_id = iz.id ORDER BY id DESC LIMIT 1) AS schedule_trigger_metric,' +
    'gl.latitude AS gateway_latitude,gl.longitude AS gateway_longitude ' +
    'FROM irrigation_zones iz ' +
    'LEFT JOIN gateway_locations gl ON gl.gateway_device_eui = iz.gateway_device_eui ' +
    'WHERE iz.id=' + zoneId + (scopedOn ? '' : ' AND iz.user_id=' + auth.userId) + ' AND iz.deleted_at IS NULL LIMIT 1'
  );
  const zone = zones[0];
  if (!zone) {
    await close();
    return respond({ error: 'Zone not found' }, 404);
  }

  let deviceRows = await q(
    'SELECT d.deveui,d.name,d.type_id,d.rain_gauge_enabled,d.flow_meter_enabled,latest.recorded_at,latest.* ' +
    'FROM devices d ' +
    'LEFT JOIN (' +
      'SELECT dd1.* FROM device_data dd1 ' +
      'JOIN (' +
        'SELECT deveui,MAX(recorded_at) AS max_time FROM device_data GROUP BY deveui' +
      ') latest ON dd1.deveui = latest.deveui AND dd1.recorded_at = latest.max_time' +
    ') latest ON latest.deveui = d.deveui ' +
    'WHERE d.irrigation_zone_id=' + zoneId + (scopedOn ? '' : ' AND d.user_id=' + auth.userId) + ' AND d.deleted_at IS NULL ' +
    'ORDER BY d.created_at ASC'
  );
  // Also include S2120 weather stations assigned to this zone via weather_station_zones
  const s2120EuiRows = await q('SELECT deveui FROM weather_station_zones WHERE zone_id=' + zoneId);
  if (s2120EuiRows.length > 0) {
    const euiList = s2120EuiRows.map(r => "'" + r.deveui.replace(/'/g, "''") + "'").join(',');
    const s2120DevRows = await q(
      'SELECT d.deveui,d.name,d.type_id,d.rain_gauge_enabled,d.flow_meter_enabled,latest.recorded_at,latest.* ' +
      'FROM devices d ' +
      'LEFT JOIN (' +
        'SELECT dd1.* FROM device_data dd1 ' +
        'JOIN (' +
          'SELECT deveui,MAX(recorded_at) AS max_time FROM device_data GROUP BY deveui' +
        ') latest ON dd1.deveui = latest.deveui AND dd1.recorded_at = latest.max_time' +
      ') latest ON latest.deveui = d.deveui ' +
      'WHERE d.deveui IN (' + euiList + ') AND d.deleted_at IS NULL'
    );
    deviceRows = [...deviceRows, ...s2120DevRows];
  }

  const nowIso = new Date().toISOString();
  const location = ZE.resolveLocation(zone);
  const local = ZE.buildLocalEnvironment(deviceRows, nowIso);
  const localOnline = await safeResolveOnlineCurrent(zone, location, nowIso);
  const crop = { cropType: zone.crop_type, phenologicalStage: zone.phenological_stage, stageStartedOn: zone.stage_started_on };
  const localForecast = await safeResolveForecast(zone, location, crop, nowIso);
  const fc = await getCache(zone.id, 'forecast_v2');
  const localAgronomic = ZE.buildAgronomic(local, localOnline, localForecast, { ...crop, todayIso: ZE.localDateIso(nowIso, zone.timezone, Date.now()) || nowIso.slice(0, 10), forecastFetchedAt: fc ? fc.fetchedAt : null, timezone: zone.timezone });
  const water = await buildWaterEnvironment(zone, deviceRows, local, localAgronomic, localForecast, nowIso, fc && fc.payload);
  const schedulingMode = ZE.normalizeSchedulingMode(zone.scheduling_mode);
  const linkTarget = await getLinkedServerTarget(auth.userId);
  const cachedShared = await getCachedSharedBundle(zone.zone_uuid);
  const cachedBundleFresh = cachedShared && ZE.bundleAgeMinutes(cachedShared.lastReceivedAt, nowIso) <= 5;
  let sharedSummary = cachedBundleFresh ? cachedShared.summary : null;
  let sharedBundleLastReceivedAt = cachedShared ? cachedShared.lastReceivedAt : null;
  let displayMode = linkTarget && ZE.trimToNull(zone.gateway_device_eui) ? 'local_fallback' : 'unlinked_local';
  let displayFallbackReason = null;

  if (!sharedSummary && linkTarget && ZE.trimToNull(zone.gateway_device_eui) && ZE.trimToNull(zone.zone_uuid)) {
    try {
      sharedSummary = await fetchSharedBundle(linkTarget, zone);
      if (sharedSummary) {
        await putSharedBundle(zone, sharedSummary, nowIso);
        sharedBundleLastReceivedAt = nowIso;
      }
    } catch (error) {
      if (cachedShared && ZE.bundleAgeMinutes(cachedShared.lastReceivedAt, nowIso) <= 180) {
        sharedSummary = cachedShared.summary;
        sharedBundleLastReceivedAt = cachedShared.lastReceivedAt;
        displayMode = 'shared_server_stale';
        displayFallbackReason = 'Using last synced OSI Server values.';
      } else {
        displayMode = 'local_fallback';
        displayFallbackReason = 'Using local fallback because the OSI Server bundle is unavailable.';
      }
    }
  }

  if (sharedSummary && displayMode !== 'shared_server_stale') {
    displayMode = 'shared_server';
  }

  let summary;
  if (sharedSummary && typeof sharedSummary === 'object') {
    const sharedDisplay = sharedSummary.display && typeof sharedSummary.display === 'object' ? sharedSummary.display : {};
    const displayWater = ZE.overlayLocalWaterIrrigationSplit(sharedSummary.water, water, water.todayDate);
    summary = {
      zoneId: Number(sharedSummary.zoneId != null ? sharedSummary.zoneId : zone.id),
      zoneName: sharedSummary.zoneName || zone.name || null,
      generatedAt: nowIso,
      location: sharedSummary.location || {
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: location.timezone,
        source: location.source
      },
      water: displayWater,
      local,
      online: sharedSummary.online || localOnline,
      agronomic: sharedSummary.agronomic || localAgronomic,
      forecast: sharedSummary.forecast || localForecast,
      display: ZE.buildDisplayStatus(
        displayMode,
        schedulingMode,
        displayMode === 'shared_server' || displayMode === 'shared_server_stale' ? 'OSI Server' : 'Local fallback',
        ZE.trimToNull(sharedDisplay.sharedGeneratedAt) || ZE.trimToNull(sharedSummary.generatedAt) || cachedShared && cachedShared.sharedGeneratedAt || nowIso,
        ZE.trimToNull(sharedDisplay.sharedObservedAt) || cachedShared && cachedShared.sharedObservedAt || (sharedSummary.water && sharedSummary.water.observedAt) || null,
        sharedBundleLastReceivedAt || ZE.trimToNull(sharedDisplay.lastReceivedAt) || nowIso,
        displayFallbackReason || ZE.trimToNull(sharedDisplay.fallbackReason)
      ),
      drift: ZE.computeRecommendationDrift(zone, water, sharedSummary.water || null, schedulingMode)
    };
  } else {
    summary = {
      zoneId: Number(zone.id),
      zoneName: zone.name || null,
      generatedAt: nowIso,
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: location.timezone,
        source: location.source
      },
      water,
      local,
      online: localOnline,
      agronomic: localAgronomic,
      forecast: localForecast,
      display: ZE.buildDisplayStatus(
        displayMode,
        schedulingMode,
        displayMode === 'unlinked_local' ? 'Local environment' : 'Local fallback',
        null,
        water && water.observedAt,
        sharedBundleLastReceivedAt,
        displayFallbackReason
      ),
      drift: null
    };
  }

  await close();
  return respond(summary, 200);
} catch (error) {
  try { await close(); } catch (error) { node.warn('zone-env error-path close failed: ' + String(error && error.message || error)); }
  return respond({ error: error.message }, error.statusCode || 500);
}
})();

}

module.exports = { environmentSummary };
