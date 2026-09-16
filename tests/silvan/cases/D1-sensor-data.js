'use strict';
// D1 — sensor ingest: no data, one sample, many samples, stale, out of range.
//
// All devices are simulated. Uplinks are published straight to the local broker
// on application/<app>/device/<EUI>/event/up, the same topic every `mqtt in`
// node subscribes to; each decoder self-filters on the profile id in the
// envelope, so no ChirpStack device object or radio is involved.
//
// The cardinal rule under test (engineering playbook, prime directive 3): a
// missing measurement must read as NULL, never as a plausible-looking default.

exports.title = 'Sensor data: none / one / many, stale, out-of-range, unit round-trip';

const state = { zones: [], devices: [] };

exports.run = async (ctx) => {
  const { rest, ssh, ev } = ctx;
  const tag = 'd1-' + Date.now().toString(36);
  // Fresh per run: this case asserts on an EMPTY history, and a "deleted"
  // device keeps its device_data rows (DELETE only unclaims).
  const kiwiEui = ctx.freshDeveui('D1-kiwi');
  const weatherEui = ctx.freshDeveui('D1-s2120');
  state.devices.push(kiwiEui, weatherEui);

  const zone = await rest.post('/api/irrigation-zones', { name: 'Sensor Zone ' + tag, timezone: 'Europe/Zurich' });
  ctx.expectStatus('a zone for the sensors is created', zone, 201);
  const zoneId = zone.body && zone.body.id;
  if (zoneId) state.zones.push(zoneId);

  // --- no data --------------------------------------------------------------
  const reg = await ctx.createSimDevice({ deveui: kiwiEui, name: 'Sim KIWI ' + tag, type_id: 'KIWI_SENSOR', zoneId });
  ctx.expectStatus('the simulated KIWI sensor registers', reg, [200, 201]);

  const beforeAny = await rest.get('/api/devices');
  const fresh = (beforeAny.body || []).find((d) => d.deveui === kiwiEui);
  ctx.expect('a sensor that has never reported is listed, not hidden', !!fresh, fresh && { deveui: fresh.deveui });
  ctx.expect('a sensor with no data reports empty readings, not zeros',
    !!fresh && (!fresh.latest_data || Object.keys(fresh.latest_data).length === 0 ||
      Object.values(fresh.latest_data).every((v) => v === null)),
    fresh && fresh.latest_data);
  const noRows = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + kiwiEui + "'");
  ctx.expect('SQLite: no device_data rows exist before the first uplink', Number(noRows) === 0, { rows: noRows });

  // --- one sample -----------------------------------------------------------
  // All simulated timestamps are in the PAST: rawLegacySensorHistory bounds its
  // query with `recorded_at < now`, so a future-dated sample is stored but never
  // appears in history (see the explicit check further down).
  const base = Date.now();
  const t1 = new Date(base - 10 * 60 * 1000).toISOString();
  ctx.publishSensorUplink(ctx.U.kiwiUplink(ctx.profiles, {
    deveui: kiwiEui, deviceName: 'Sim KIWI ' + tag,
    swt1Kpa: 35, swt2Kpa: 60, lightLux: 1200, temperatureC: 21.5, humidityPct: 48, time: t1,
  }));

  const firstRow = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT recorded_at, swt_1, swt_2, light_lux, ambient_temperature, relative_humidity " +
      "FROM device_data WHERE deveui = '" + kiwiEui + "' ORDER BY recorded_at DESC LIMIT 1"
    );
    return row || null;
  }, { timeoutMs: 20000, what: 'the first device_data row' }).catch(() => null);
  ctx.expect('SQLite: one uplink produces exactly one device_data row', !!firstRow, firstRow);

  // SWT is stored in kPa, positive, higher = drier. The flow converts the
  // watermark frequency itself, so a round-trip within 1 kPa proves the whole
  // decode path, not just the write.
  ctx.expect('SQLite: swt_1 round-trips to ~35 kPa (positive kPa, higher = drier)',
    !!firstRow && firstRow.swt_1 !== null && Math.abs(Number(firstRow.swt_1) - 35) <= 1.0,
    firstRow && { swt_1: firstRow.swt_1 });
  ctx.expect('SQLite: swt_2 round-trips to ~60 kPa',
    !!firstRow && firstRow.swt_2 !== null && Math.abs(Number(firstRow.swt_2) - 60) <= 1.5,
    firstRow && { swt_2: firstRow.swt_2 });
  ctx.expect('SQLite: temperature and humidity are stored in their native units (C, %RH)',
    !!firstRow && Math.abs(Number(firstRow.ambient_temperature) - 21.5) < 0.2 && Math.abs(Number(firstRow.relative_humidity) - 48) < 0.5,
    firstRow && { t: firstRow.ambient_temperature, rh: firstRow.relative_humidity });

  const afterOne = await rest.get('/api/devices');
  const oneDev = (afterOne.body || []).find((d) => d.deveui === kiwiEui);
  ctx.expect('the API surfaces the reading on the device',
    !!oneDev && oneDev.latest_data && oneDev.latest_data.swt_1 != null, oneDev && oneDev.latest_data);

  // pF is derived at read time, never stored: pF = log10(kPa * 10).
  const pfColumns = await ssh.sql("SELECT name FROM pragma_table_info('device_data') WHERE name LIKE '%pf%'");
  ctx.expect('SQLite: no pF column exists (pF is derived at display/export, never stored)',
    pfColumns.length === 0, pfColumns);

  // --- many samples ---------------------------------------------------------
  const kpas = [12, 18, 24, 41, 77];
  for (let i = 0; i < kpas.length; i++) {
    ctx.publishSensorUplink(ctx.U.kiwiUplink(ctx.profiles, {
      deveui: kiwiEui, swt1Kpa: kpas[i], swt2Kpa: kpas[i] + 5, temperatureC: 20 + i,
      time: new Date(base - (8 - i) * 60 * 1000).toISOString(),
    }));
    await ctx.sleep(300);
  }
  const many = await ctx.until(async () => {
    const n = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + kiwiEui + "'");
    return Number(n) >= 1 + kpas.length ? n : null;
  }, { timeoutMs: 25000, what: 'all uplinks to be ingested' }).catch(() => null);
  ctx.expect('SQLite: every uplink is stored as its own row (no silent coalescing)',
    Number(many) === 1 + kpas.length, { rows: many, expected: 1 + kpas.length });

  const noField = await rest.get('/api/devices/' + kiwiEui + '/sensor-history?hours=24');
  ctx.expectStatus('GET sensor-history without a field parameter is rejected with 400', noField, 400);

  const history = await rest.get('/api/devices/' + kiwiEui + '/sensor-history?hours=24&field=swt_1');
  ctx.expectStatus('GET sensor-history?field=swt_1 returns the series', history, 200);
  const points = Array.isArray(history.body) ? history.body : (history.body && (history.body.data || history.body.points)) || [];
  ctx.expect('sensor-history returns every ingested row',
    points.length === 1 + kpas.length, { points: points.length, ingested: 1 + kpas.length });
  ctx.expect('sensor-history points are ordered oldest first',
    points.every((p, i) => i === 0 || String(points[i - 1].t) <= String(p.t)), points.map((p) => p.t));

  // A device whose clock runs ahead of the gateway writes future-dated rows.
  // They are stored, but rawLegacySensorHistory bounds the query with
  // `recorded_at < now`, so they never appear in a chart.
  const futureEui = kiwiEui;
  ctx.publishSensorUplink(ctx.U.kiwiUplink(ctx.profiles, {
    deveui: futureEui, swt1Kpa: 99, swt2Kpa: 99, time: new Date(base + 3600 * 1000).toISOString(),
  }));
  await ctx.sleep(3000);
  const futureStored = await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + futureEui + "' AND recorded_at > '" + new Date(base + 60000).toISOString() + "'"
  );
  const historyAfterFuture = await rest.get('/api/devices/' + kiwiEui + '/sensor-history?hours=24&field=swt_1');
  const pointsAfterFuture = Array.isArray(historyAfterFuture.body) ? historyAfterFuture.body : [];
  ctx.expect('a future-dated uplink is stored in device_data', Number(futureStored) >= 1, { rows: futureStored });
  ctx.expect('a future-dated sample is excluded from sensor-history (history is bounded at "now")',
    pointsAfterFuture.length === points.length, { before: points.length, after: pointsAfterFuture.length });
  ev.note('A device whose clock runs ahead writes device_data rows that are stored but never charted: ' +
    'rawLegacySensorHistory bounds the window with recorded_at < now. The reading exists in the database ' +
    'and is invisible in the GUI, with nothing telling the operator why.');

  // --- out of range ---------------------------------------------------------
  // The flow's convertHzToKPa clamps to the calibration table: frequencies below
  // the table floor read 200 kPa, above the ceiling read 0. A value must never
  // land outside the storable kPa range.
  ctx.publishSensorUplink(ctx.U.envelope({
    deveui: kiwiEui,
    profileId: ctx.profiles.KIWI, profileName: 'OSI KIWI Sensor', fPort: 2,
    object: { watermark1_frequency: 1, watermark2_frequency: 999999, ambient_temperature: 21 },
    time: new Date(base - 90 * 1000).toISOString(),
  }));
  const extreme = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT swt_1, swt_2 FROM device_data WHERE deveui = '" + kiwiEui + "' ORDER BY recorded_at DESC LIMIT 1"
    );
    return row && row.swt_1 !== null ? row : null;
  }, { timeoutMs: 20000, what: 'the out-of-range sample' }).catch(() => null);
  ctx.expect('SQLite: an off-the-scale dry reading clamps to the table maximum rather than producing a wild number',
    !!extreme && Number(extreme.swt_1) >= 0 && Number(extreme.swt_1) <= 300, extreme);
  ctx.expect('SQLite: an off-the-scale wet reading clamps to 0 kPa, not a negative tension',
    !!extreme && Number(extreme.swt_2) >= 0, extreme);

  // --- missing fields must stay NULL ---------------------------------------
  ctx.publishSensorUplink(ctx.U.envelope({
    deveui: kiwiEui,
    profileId: ctx.profiles.KIWI, profileName: 'OSI KIWI Sensor', fPort: 2,
    object: { watermark1_frequency: 1500 },   // no temperature, no humidity, no light
    time: new Date(base - 30 * 1000).toISOString(),
  }));
  const sparse = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT swt_1, ambient_temperature, relative_humidity, light_lux FROM device_data " +
      "WHERE deveui = '" + kiwiEui + "' ORDER BY recorded_at DESC LIMIT 1"
    );
    return row && row.ambient_temperature === null ? row : null;
  }, { timeoutMs: 20000, what: 'the sparse sample' }).catch(() => null);
  ctx.expect('SQLite: fields the uplink did not carry are stored as NULL, never as 0 or a default',
    !!sparse && sparse.ambient_temperature === null && sparse.relative_humidity === null && sparse.light_lux === null,
    sparse || await ssh.sqlOne("SELECT swt_1, ambient_temperature, relative_humidity, light_lux FROM device_data WHERE deveui = '" + kiwiEui + "' ORDER BY recorded_at DESC LIMIT 1"));
  ctx.expect('SQLite: the field the sparse uplink DID carry is still stored',
    !!sparse && sparse.swt_1 !== null, sparse && { swt_1: sparse.swt_1 });

  // --- stale data -----------------------------------------------------------
  // An uplink timestamped well in the past must not be presented as the current
  // reading just because it arrived last.
  const staleTime = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  ctx.publishSensorUplink(ctx.U.kiwiUplink(ctx.profiles, {
    deveui: kiwiEui, swt1Kpa: 5, swt2Kpa: 5, temperatureC: -10, time: staleTime,
  }));
  await ctx.sleep(3000);
  const newest = await ssh.sqlOne(
    "SELECT recorded_at, swt_1 FROM device_data WHERE deveui = '" + kiwiEui + "' ORDER BY recorded_at DESC LIMIT 1"
  );
  ctx.expect('SQLite: a month-old uplink does not become the newest reading',
    !!newest && Date.parse(newest.recorded_at) > Date.now() - 24 * 3600 * 1000, newest);
  const staleStored = await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + kiwiEui + "' AND recorded_at < '" +
    new Date(Date.now() - 24 * 3600 * 1000).toISOString() + "'"
  );
  ctx.expect('SQLite: the back-dated sample is still stored at its own timestamp (history, not "now")',
    Number(staleStored) >= 1, { rows: staleStored });

  // --- an uplink from a device the gateway does not know -------------------
  const unknownEui = ctx.freshDeveui('D1-unknown');
  const beforeUnknown = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + unknownEui + "'");
  ctx.publishSensorUplink(ctx.U.kiwiUplink(ctx.profiles, { deveui: unknownEui, swt1Kpa: 30, swt2Kpa: 30 }));
  await ctx.sleep(3000);
  const afterUnknown = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + unknownEui + "'");
  const strayRows = Number(afterUnknown) - Number(beforeUnknown);
  ctx.expect('an uplink from an unregistered DevEUI is dropped rather than written to device_data',
    strayRows === 0, { rowsCreated: strayRows, deveui: unknownEui });
  ctx.expect('an unregistered uplink does not disturb the registered device',
    Number(await ssh.sqlScalar("SELECT COUNT(*) AS n FROM device_data WHERE deveui = '" + kiwiEui + "'")) > 0,
    { unknownRows: afterUnknown });

  // --- a second sensor type: weather station --------------------------------
  const wreg = await ctx.createSimDevice({ deveui: weatherEui, name: 'Sim S2120 ' + tag, type_id: 'SENSECAP_S2120', zoneId });
  ctx.expectStatus('the simulated weather station registers', wreg, [200, 201]);
  ctx.publishSensorUplink(ctx.U.s2120Uplink(ctx.profiles, {
    deveui: weatherEui,
    readings: {
      ambientTemperature: 19.4, relativeHumidity: 63, barometricPressureHpa: 1012.5,
      windSpeedMps: 3.2, windDirectionDeg: 210, uvIndex: 4, batPct: 88, rainGaugeCumulativeMm: 12.5,
    },
    time: new Date(base - 180 * 1000).toISOString(),
  }));
  const weatherRow = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT ambient_temperature, relative_humidity, barometric_pressure_hpa, rain_gauge_cumulative_mm, " +
      "rain_mm_delta, rain_delta_status, bat_pct FROM device_data WHERE deveui = '" + weatherEui + "' " +
      "ORDER BY recorded_at DESC LIMIT 1"
    );
    return row || null;
  }, { timeoutMs: 25000, what: 'the weather-station row' }).catch(() => null);
  ctx.expect('SQLite: the weather station writes its own columns', !!weatherRow, weatherRow);
  ctx.expect('SQLite: barometric pressure is normalised to hPa',
    !!weatherRow && Math.abs(Number(weatherRow.barometric_pressure_hpa) - 1012.5) < 0.6,
    weatherRow && weatherRow.barometric_pressure_hpa);
  // S2120 reports a CUMULATIVE rain counter; the edge derives the delta. The
  // first sample has no predecessor, so the delta must be absent, not 0.
  ctx.expect('SQLite: the first rain sample is flagged first_sample and derives no delta (no data != 0.0 mm)',
    !!weatherRow && weatherRow.rain_delta_status === 'first_sample' && weatherRow.rain_mm_delta === null,
    weatherRow && { status: weatherRow.rain_delta_status, delta: weatherRow.rain_mm_delta });

  ctx.publishSensorUplink(ctx.U.s2120Uplink(ctx.profiles, {
    deveui: weatherEui,
    readings: { ambientTemperature: 19.6, rainGaugeCumulativeMm: 14.0 },
    time: new Date(base - 120 * 1000).toISOString(),
  }));
  const rainDelta = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT rain_mm_delta, rain_delta_status FROM device_data WHERE deveui = '" + weatherEui + "' " +
      "ORDER BY recorded_at DESC LIMIT 1"
    );
    return row && row.rain_delta_status === 'ok' ? row : null;
  }, { timeoutMs: 25000, what: 'the derived rain delta' }).catch(() => null);
  ctx.expect('SQLite: the second cumulative sample derives a 1.5 mm delta',
    !!rainDelta && Math.abs(Number(rainDelta.rain_mm_delta) - 1.5) < 0.01, rainDelta);

  // A counter that goes backwards is a device reset, not negative rainfall.
  ctx.publishSensorUplink(ctx.U.s2120Uplink(ctx.profiles, {
    deveui: weatherEui,
    readings: { rainGaugeCumulativeMm: 0.5 },
    time: new Date(base - 60 * 1000).toISOString(),
  }));
  const reset = await ctx.until(async () => {
    const row = await ssh.sqlOne(
      "SELECT rain_mm_delta, rain_delta_status FROM device_data WHERE deveui = '" + weatherEui + "' " +
      "ORDER BY recorded_at DESC LIMIT 1"
    );
    return row && row.rain_delta_status === 'counter_reset' ? row : null;
  }, { timeoutMs: 25000, what: 'the counter_reset classification' }).catch(() => null);
  ctx.expect('SQLite: a rain counter that goes backwards is classified counter_reset with no negative delta',
    !!reset && reset.rain_mm_delta === null, reset || await ssh.sqlOne(
      "SELECT rain_mm_delta, rain_delta_status FROM device_data WHERE deveui = '" + weatherEui + "' ORDER BY recorded_at DESC LIMIT 1"));
};

exports.cleanup = async (ctx) => {
  for (const eui of state.devices.slice()) await ctx.deleteSimDevice(eui);
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.devices.length = 0;
  state.zones.length = 0;
};
