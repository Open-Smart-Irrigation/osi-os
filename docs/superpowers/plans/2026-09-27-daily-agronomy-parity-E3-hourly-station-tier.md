# Daily Agronomy Parity E3: Hourly Station Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daily writer's station tier (`et0_tier = 'station_fao56'`) becomes the day's sum of hourly FAO-56 Penman-Monteith values (equation 53) over the local weather station's hours, with `et0_source = 'fao56_hourly'`; an hour counts only with its mean temperature, humidity, wind and radiation and at least three uplinks; a zone without a longitude falls to the provider tier.

**Architecture:** `osi-agronomy-daily/index.js` keeps its tier order and its plausibility check. `stationDayInputs` judges hour completeness by the hourly rule and returns the day's hours in the shape `fao56Et0HourlyDay` takes (plan E1); `resolveDay` calls that function with the previous evening's carry ratio (`priorRsRso`) taken from the same station's cached hours; the hour cache reads two more columns. No schema, flow or GUI change.

**Tech Stack:** Node.js 22 (`node:test`, `node:sqlite`), the `osi-db-helper` facade, FAO-56 equations 28-33, 37-40, 45-47, 53.

**Spec:** `docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md` (B4 "Station tier" and "`priorRsRso`", A2 station-tier statement, the vector line of B4, E row "E3", Decisions "Complete station hour" and "Station tier naming").

**Prerequisites (check before Task 1):**

1. Plan E1 is done: `et0.js` exports `fao56HourlyTerms`, `fao56Et0Hourly`, `fao56Et0HourlyDay`, and `docs/contracts/agronomy/et0-vectors.json` has the group `fao56HourlyDays` with `payerne_synthetic_2026_07_19` (`et0Mm` 4.85). Check: `node -e "const v = require('./docs/contracts/agronomy/et0-vectors.json'); console.log(v.fao56HourlyDays[0].name, v.fao56HourlyDays[0].et0Mm)"` prints `payerne_synthetic_2026_07_19 4.85`.
2. Plan E2a is done (the rows carry `stage_started_on`, `kc_stage_day`, `stage_overrun`; its Task 4 changed `snapshotFor`, `ROW_COLUMNS` and the zone query of this file). E3's edits touch other lines of `index.js` and `index.test.js`, so the order E2a then E3 matters only for the anchors staying unique, which the one-shot scripts check. Plan E2b touches no file of this plan.
3. `osi-station-hours` needs no change: `hourlyAggregate` already stores `air_temperature_c` (the hour's mean) and `sample_count` (every uplink of the hour), the two values the hourly rule reads.

## Global Constraints

From the spec, verbatim:

- "For each station day whose every hour is complete, the tier calls `fao56Et0HourlyDay` with one element per hour: `hourStartUtc = hour_start`, `tMeanC = air_temperature_c`, `rhPct = relative_humidity_pct`, `windSpeedMs = wind_speed_mps` at `catalogue.stationWindHeightM`, `solarRadMjM2h = global_radiation_wm2 × 0.0036`; elevation as today (gateway altitude, else from mean pressure, else null); latitude and longitude from the zone; `dayOfYear` of the local date."
- "An hour is complete for this tier when those four fields are non-null, radiation is ≥ 0 and `sample_count ≥ 3` (ruling R8; the hourly path needs the hour's mean temperature, not its minimum and maximum)."
- "The plausibility check (0.06 × Ra for the day, zero in a daylight hour) is unchanged."
- "A zone without a longitude cannot run the hourly tier and falls to the provider tier (spec decision; hourly Ra needs the longitude)."
- "The row gets `et0_tier = 'station_fao56'`, `et0_source = 'fao56_hourly'`. Tier 3 (Hargreaves) keeps its minimum and maximum temperature inputs."
- "`priorRsRso`: From the same station's cached hours in the 24 hours before the day's first hour, the writer takes the latest complete hour for which `fao56HourlyTerms(...).carryCandidate` is true and passes its `rsRso` term. No such hour: `priorRsRso` is null and the day's leading night hours use 0.5 (the hour cache already spans 94 days, so no new query)."
- Decisions: "`et0_tier` stays `station_fao56`; `et0_source` becomes `fao56_hourly`." "Rows written before the change keep `station_fao56` as source; readers must not treat the source as the tier."
- "The first run after the E3 deploy recomputes the last seven station days (their `et0_mm` and `et0_source` change)".
- Hour-level: `sumMm` is signed, the day is clamped at 0 once (ruling R3; plan E1's `fao56Et0HourlyDay` does both).

Operational rules:

- Work only in `<osi-os>/.worktrees/daily-agronomy-parity`; run every command from its root. Never `cd` into `<osi-os>` or `<osi-server>`. Never bare `git stash`. Never push. Commits use `git -c user.name=Project-OSI commit`.
- `$SCRATCH` is the session scratchpad; one-shot scripts live there and are never committed.
- Every file changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is mirrored byte for byte under `bcm2709`.
- Prose passes `node .claude/skills/anti-slop-writing/slop-check.js`.

## Review Focus

1. **A station on a slow uplink interval whose hours have one or two samples.** Such an hour is not complete, the station tier rejects the day and the provider tier (or Hargreaves, then `partial_day`) takes it; it must never be summed from thinly sampled hours. Pinned in Task 1 ("an hour without its mean temperature or with two uplinks fails the tier; the provider takes the day").
2. **An S2120 that reports minimum and maximum temperature but no mean for an hour** (an older aggregate, or a frame without the field). The hourly tier needs the mean; the day falls to the next tier while Hargreaves still uses the minimum and maximum. Pinned in Task 1 (same test, the `air_temperature_c: null` case) and the unchanged Hargreaves tests.
3. **A night that starts before the day's first carry hour.** The first six hours of a Zurich summer day take the previous evening's ratio from the same station when those hours are stored, else 0.5, and the result differs (4.79 against 4.85 mm on the synthetic day). Pinned in Task 1 ("the previous evening's carry hour sets the ratio of the day's first night hours").
4. **A zone whose located entry has no longitude.** The hourly tier must not run with an undefined longitude (it would place the sun wrongly or return NaN); the provider tier takes the day. Pinned in Task 1 ("resolveDay: without a longitude the hourly tier cannot run …").
5. **A covered or failing light sensor.** The daily plausibility check still rejects the day before the hourly sum runs, exactly as before. Pinned by the unchanged test "radiation plausibility: a covered sensor at 20 lux all day and a sensor dead from noon fall to tier 2/3; the healthy day stays tier 1", which Task 1 keeps green with the new fixtures.

---

### Task 1: The station tier sums hourly FAO-56 ET0

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js`, `.../osi-agronomy-daily/index.test.js` (both profiles)
- Scratch: `$SCRATCH/tests-fixture.py`, `$SCRATCH/hourly-tier.py`

**Interfaces:**
- Consumes: `et0.fao56HourlyTerms(input)` and `et0.fao56Et0HourlyDay({ hours, windHeightM, elevationM, latDeg, lonDeg, dayOfYear, priorRsRso })` (plan E1); `catalogue.stationWindHeightM` (2).
- Produces: `stationDayInputs(rows, hourStarts, sun)` judges an hour complete by `MANDATORY = ['air_temperature_c', 'relative_humidity_pct', 'wind_speed_mps', 'global_radiation_wm2']`, radiation ≥ 0 and `sample_count >= 3`, and on a complete day also returns `hours` (`[{ hourStartUtc, tMeanC, rhPct, windSpeedMs, solarRadMjM2h }]`); `resolveDay({ …, stationPriorHours })` takes a `Map` from deveui to the rows of the 24 hours before the day's first hour; a station day's row carries `et0_source = 'fao56_hourly'`. Exports are unchanged. Plan E4 changes the upsert and the retraction of this file, not these functions.

- [ ] **Step 1: Station fixtures for the hourly rule**

The existing station tests seed hours without a mean temperature and compute the expected value with the daily equation. `$SCRATCH/tests-fixture.py` gives `stationHour` a mean of 17 °C and four uplinks, stores both columns, and computes the expected station value as the hourly sum:
```python
# One-shot (plan E3, Task 1): the station fixtures carry the hour's mean
# temperature and sample count, and tier 1 expects the hourly sum.
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("""// A clear day: 12 lit hours at 500 W/m² (21.6 MJ/m²), min 12 °C, max 22 °C, 70 %, 1.5 m/s, 955 hPa.
function stationHour(i) {
  const lit = i >= 6 && i < 18;
  return { air_temperature_min_c: 12, air_temperature_max_c: 22, relative_humidity_pct: 70, wind_speed_mps: 1.5, global_radiation_wm2: lit ? 500 : 0, pressure_hpa: 955 };
}""", """// A clear day: 12 lit hours at 500 W/m² (21.6 MJ/m²), mean 17 °C (min 12, max 22), 70 %, 1.5 m/s, 955 hPa, 4 uplinks an hour.
function stationHour(i) {
  const lit = i >= 6 && i < 18;
  return { air_temperature_c: 17, air_temperature_min_c: 12, air_temperature_max_c: 22, relative_humidity_pct: 70, wind_speed_mps: 1.5, global_radiation_wm2: lit ? 500 : 0, pressure_hpa: 955, sample_count: 4 };
}""")
swap("""  const insert = db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 4, '2026-09-26T05:00:00Z')");
  ad.localDayWindow(date, TZ).hourStarts.forEach((h, i) => {
    if (skip(h, i)) return;
    const r = row(i);
    insert.run(deveui, h, r.air_temperature_min_c, r.air_temperature_max_c, r.relative_humidity_pct, r.wind_speed_mps, r.global_radiation_wm2, r.pressure_hpa);
  });""", """  const insert = db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-26T05:00:00Z')");
  ad.localDayWindow(date, TZ).hourStarts.forEach((h, i) => {
    if (skip(h, i)) return;
    const r = row(i);
    insert.run(deveui, h, r.air_temperature_c, r.air_temperature_min_c, r.air_temperature_max_c, r.relative_humidity_pct, r.wind_speed_mps, r.global_radiation_wm2, r.pressure_hpa, r.sample_count);
  });""")
swap("""const STATION_INPUTS = { tMinC: 12, tMaxC: 22, meanRhPct: 70, windSpeedMs: 1.5, windHeightM: 2, solarRadMjM2: 21.6, latDeg: 46.8, dayOfYear: 268 };""",
"""// The station tier's expected value: the hourly sum over stationHour's day (contract v2, A7).
function stationDayEt0(date, elevationM) {
  const hours = ad.localDayWindow(date, TZ).hourStarts.map((h, i) => ({ hourStartUtc: h, tMeanC: stationHour(i).air_temperature_c, rhPct: 70, windSpeedMs: 1.5, solarRadMjM2h: stationHour(i).global_radiation_wm2 * 0.0036 }));
  return et0.fao56Et0HourlyDay({ hours, windHeightM: 2, elevationM, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 268, priorRsRso: null }).et0Mm;
}""")
swap("""  assert.deepEqual([r.et0_tier, r.et0_source, r.et0_station_id, r.location_key], ['station_fao56', 'station_fao56', 'S2120AAAA00000001', null]);
  assert.equal(r.et0_mm, et0.fao56Et0({ ...STATION_INPUTS, elevationM: 490 }));
  db.raw.prepare('DELETE FROM gateway_locations').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_mm, et0.fao56Et0({ ...STATION_INPUTS, elevationM: et0.elevationFromPressure(95.5) }));""",
"""  assert.deepEqual([r.et0_tier, r.et0_source, r.et0_station_id, r.location_key], ['station_fao56', 'fao56_hourly', 'S2120AAAA00000001', null]);
  assert.equal(r.et0_mm, stationDayEt0('2026-09-25', 490));
  db.raw.prepare('DELETE FROM gateway_locations').run();
  db.raw.prepare('DELETE FROM zone_daily_agronomy').run();
  await run(db);
  assert.equal(row(db, '2026-09-25').et0_mm, stationDayEt0('2026-09-25', et0.elevationFromPressure(95.5)));""")
p.write_text(s, encoding="utf-8")
print("index.test.js: station fixtures for the hourly tier")
```
Run: `python3 "$SCRATCH/tests-fixture.py"`. Expected: `index.test.js: station fixtures for the hourly tier`.

- [ ] **Step 2: Write the failing tests**

Append to `.../osi-agronomy-daily/index.test.js`:
```js

// Contract v2 station tier: the day is the sum of hourly FAO-56 ET0 (spec
// 2026-09-27-daily-agronomy-parity A7, A9, B4). The synthetic Payerne day of
// et0-vectors.json, stored as station hours with six uplinks each.
const HOURLY_DAY = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contracts/agronomy/et0-vectors.json'), 'utf8')).fao56HourlyDays[0];
function seedSyntheticStationDay(db, deveui, { shiftDays = 0, row = (r) => r } = {}) {
  const insert = db.raw.prepare("INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 955, ?, '2026-07-20T05:00:00Z')");
  HOURLY_DAY.input.hours.forEach((h, i) => {
    const r = row({ hour_start: new Date(Date.parse(h.hourStartUtc) + shiftDays * 86400000).toISOString().replace('.000Z', 'Z'), air_temperature_c: h.tMeanC, relative_humidity_pct: h.rhPct, wind_speed_mps: h.windSpeedMs, global_radiation_wm2: h.solarRadMjM2h / 0.0036, sample_count: 6 }, i);
    insert.run(deveui, r.hour_start, r.air_temperature_c, r.air_temperature_c == null ? null : r.air_temperature_c - 1, r.air_temperature_c == null ? null : r.air_temperature_c + 1, r.relative_humidity_pct, r.wind_speed_mps, r.global_radiation_wm2, r.sample_count);
  });
}
const JULY_NOW = '2026-07-20T06:00:00Z'; // local 08:00 on 20 July; the latest completed day is 2026-07-19

test('station tier: the synthetic Payerne day sums its hours to 4.85 mm with source fao56_hourly', async () => {
  const db = scratchDb();
  seedZone(db, { gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedSyntheticStationDay(db, 'S2120AAAA00000001');
  await run(db, JULY_NOW);
  const r = row(db, '2026-07-19');
  assert.deepEqual([r.et0_mm, r.et0_tier, r.et0_source, r.et0_station_id, r.hours_present, r.expected_hours], [4.85, 'station_fao56', 'fao56_hourly', 'S2120AAAA00000001', 24, 24]);
  assert.equal(r.et0_mm, HOURLY_DAY.et0Mm);
});

test('station tier: the previous evening\'s carry hour sets the ratio of the day\'s first night hours', async () => {
  const db = scratchDb();
  seedZone(db, { gatewayEui: 'GW1' });
  seedGateway(db, 'GW1', 490);
  seedStation(db, 'S2120AAAA00000001', 1);
  seedSyntheticStationDay(db, 'S2120AAAA00000001', { shiftDays: -1 });
  seedSyntheticStationDay(db, 'S2120AAAA00000001');
  await run(db, JULY_NOW);
  const previousCarry = HOURLY_DAY.input.hours
    .map((h) => ({ ...h, hourStartUtc: new Date(Date.parse(h.hourStartUtc) - 86400000).toISOString() }))
    .map((h) => et0.fao56HourlyTerms({ ...h, windHeightM: 2, elevationM: 490, latDeg: 46.8, lonDeg: 6.95, dayOfYear: 199 }))
    .filter((t) => t.carryCandidate);
  assert.equal(previousCarry.length, 1);
  const expected = et0.fao56Et0HourlyDay({ ...HOURLY_DAY.input, priorRsRso: previousCarry[0].rsRso }).et0Mm;
  assert.equal(expected, 4.79);
  assert.equal(row(db, '2026-07-19').et0_mm, expected);
});

test('station tier: an hour without its mean temperature or with two uplinks fails the tier; the provider takes the day', async () => {
  for (const [label, broken] of [['no mean temperature', { air_temperature_c: null }], ['two uplinks', { sample_count: 2 }]]) {
    const db = scratchDb();
    seedZone(db, { gatewayEui: 'GW1' });
    seedGateway(db, 'GW1', 490);
    seedStation(db, 'S2120AAAA00000001', 1);
    seedSyntheticStationDay(db, 'S2120AAAA00000001', { row: (r, i) => (i === 12 ? { ...r, ...broken } : r) });
    seedProviderDay(db, OM, '2026-07-19');
    await run(db, JULY_NOW);
    const r = row(db, '2026-07-19');
    assert.deepEqual([r.et0_tier, r.et0_source], ['provider_hourly_sum', 'open_meteo_hourly_sum'], label);
  }
});

test('resolveDay: without a longitude the hourly tier cannot run and the provider tier takes the day', () => {
  const hourStarts = ad.localDayWindow('2026-07-19', TZ).hourStarts;
  const stationRows = HOURLY_DAY.input.hours.map((h) => ({ hour_start: h.hourStartUtc, air_temperature_c: h.tMeanC, air_temperature_min_c: h.tMeanC - 1, air_temperature_max_c: h.tMeanC + 1, relative_humidity_pct: h.rhPct, wind_speed_mps: h.windSpeedMs, global_radiation_wm2: h.solarRadMjM2h / 0.0036, pressure_hpa: 955, sample_count: 6 }));
  const providerRows = hourStarts.map((h) => ({ hour_start: h, et0_mm: 0.2, station_id: null }));
  const args = { date: '2026-07-19', hourStarts, latitude: 46.8, provider: 'open_meteo', locationKey: OM, stations: ['S2120AAAA00000001'], stationHours: new Map([['S2120AAAA00000001', stationRows]]), stationPriorHours: new Map(), providerRows, gatewayAltitudeM: 490, nowMs: Date.parse(JULY_NOW) };
  assert.deepEqual([ad.resolveDay({ ...args, longitude: 6.95 }).et0Source, ad.resolveDay({ ...args, longitude: 6.95 }).et0Mm], ['fao56_hourly', 4.85]);
  const noLongitude = ad.resolveDay({ ...args, longitude: null });
  assert.deepEqual([noLongitude.et0Tier, noLongitude.et0Mm], ['provider_hourly_sum', 4.8]);
});
```

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js`
Expected: fails "station tier wins over the provider …" (`et0_source` is `station_fao56`, the value the daily equation's), the synthetic-day test (`4.85` expected, the daily equation's value found), the carry test, the completeness test (the daily path needs no mean temperature and ignores `sample_count`) and the `resolveDay` longitude test (`fao56_hourly` expected): five failures, `# pass 29`.

- [ ] **Step 3: The hourly tier**

`$SCRATCH/hourly-tier.py`:
```python
# One-shot (plan E3, Task 1): the station tier sums hourly FAO-56 ET0 (eq. 53).
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("""const MANDATORY = ['air_temperature_min_c', 'air_temperature_max_c', 'relative_humidity_pct', 'wind_speed_mps', 'global_radiation_wm2'];
// A negative radiation hour is not a measurement (luxToWm2 passes negative
// lux through), so it fails tier 1 like a missing one.
function fullHour(r) { return MANDATORY.every((k) => r[k] != null) && Number.isFinite(r.global_radiation_wm2) && r.global_radiation_wm2 >= 0; }""",
"""// Tier 1 sums hourly FAO-56 ET0 (contract v2, spec
// 2026-09-27-daily-agronomy-parity A7 and B4): an hour counts when its mean
// temperature, humidity, wind and radiation are present, the radiation is not
// negative (luxToWm2 passes negative lux through), and at least three uplinks
// fed it (ruling R8). The hourly path needs no minimum or maximum temperature.
const MANDATORY = ['air_temperature_c', 'relative_humidity_pct', 'wind_speed_mps', 'global_radiation_wm2'];
const MIN_SAMPLES_PER_HOUR = 3;
const WM2_TO_MJ_PER_HOUR = 0.0036;
function fullHour(r) {
  return MANDATORY.every((k) => r[k] != null) && Number.isFinite(r.global_radiation_wm2) && r.global_radiation_wm2 >= 0
    && Number(r.sample_count) >= MIN_SAMPLES_PER_HOUR;
}
function hourInput(r) {
  return { hourStartUtc: r.hour_start, tMeanC: r.air_temperature_c, rhPct: r.relative_humidity_pct, windSpeedMs: r.wind_speed_mps, solarRadMjM2h: r.global_radiation_wm2 * WM2_TO_MJ_PER_HOUR };
}""")
swap("""  return { ...out, complete: true, meanRhPct: mean(full.map((r) => r.relative_humidity_pct)), windSpeedMs: mean(full.map((r) => r.wind_speed_mps)), solarRadMjM2: solar };
}""", """  return { ...out, complete: true, meanRhPct: mean(full.map((r) => r.relative_humidity_pct)), windSpeedMs: mean(full.map((r) => r.wind_speed_mps)), solarRadMjM2: solar, hours: full.map(hourInput) };
}

// FAO-56 ch. 4 night rule: the day's leading night hours take the Rs/Rso of
// the latest complete hour 2-3 h before sunset in the 24 hours before the
// day's first hour (the previous evening), else 0.5 (fao56Et0HourlyDay).
function priorRsRsoFor(priorRows, { latDeg, lonDeg, dayOfYear, elevationM }) {
  let prior = null;
  for (const r of priorRows || []) {
    if (!fullHour(r)) continue;
    const terms = et0.fao56HourlyTerms({ ...hourInput(r), windHeightM: catalogue.stationWindHeightM, elevationM, latDeg, lonDeg, dayOfYear });
    if (terms && terms.carryCandidate) prior = terms.rsRso;
  }
  return prior;
}""")
swap("""function resolveDay({ date, hourStarts, latitude, longitude, provider, locationKey, stations, stationHours, providerRows, gatewayAltitudeM, nowMs }) {""",
     """function resolveDay({ date, hourStarts, latitude, longitude, provider, locationKey, stations, stationHours, stationPriorHours, providerRows, gatewayAltitudeM, nowMs }) {""")
swap("""  if (stations.length) {
    const best = pickStation(stations, stationHours, hourStarts, 'hoursPresent', 'complete', sun);
    anyHours = anyHours || best.inputs.anyHours > 0;
    lastPresent = best.inputs.hoursPresent;
    if (best.inputs.complete) {
      const elevationM = gatewayAltitudeM != null && Number.isFinite(Number(gatewayAltitudeM)) ? Number(gatewayAltitudeM) : et0.elevationFromPressure(best.inputs.meanPressureKpa);
      const value = et0.fao56Et0({ tMinC: best.inputs.tMinC, tMaxC: best.inputs.tMaxC, meanRhPct: best.inputs.meanRhPct, windSpeedMs: best.inputs.windSpeedMs, windHeightM: catalogue.stationWindHeightM, solarRadMjM2: best.inputs.solarRadMjM2, elevationM, latDeg: latitude, dayOfYear: doy });
      if (value != null) return { ...base, et0Mm: value, et0Source: 'station_fao56', et0Tier: 'station_fao56', et0StationId: best.deveui, hoursPresent: best.inputs.hoursPresent };
    }
  }""", """  if (stations.length) {
    const best = pickStation(stations, stationHours, hourStarts, 'hoursPresent', 'complete', sun);
    anyHours = anyHours || best.inputs.anyHours > 0;
    lastPresent = best.inputs.hoursPresent;
    // Hourly Ra needs the longitude: without one the provider tier runs.
    if (best.inputs.complete && Number.isFinite(sun.lonDeg)) {
      const elevationM = gatewayAltitudeM != null && Number.isFinite(Number(gatewayAltitudeM)) ? Number(gatewayAltitudeM) : et0.elevationFromPressure(best.inputs.meanPressureKpa);
      const priorRsRso = priorRsRsoFor((stationPriorHours && stationPriorHours.get(best.deveui)) || [], { latDeg: latitude, lonDeg: sun.lonDeg, dayOfYear: dayOfYear(addDays(date, -1)), elevationM });
      const day = et0.fao56Et0HourlyDay({ hours: best.inputs.hours, windHeightM: catalogue.stationWindHeightM, elevationM, latDeg: latitude, lonDeg: sun.lonDeg, dayOfYear: doy, priorRsRso });
      if (day) return { ...base, et0Mm: day.et0Mm, et0Source: 'fao56_hourly', et0Tier: 'station_fao56', et0StationId: best.deveui, hoursPresent: best.inputs.hoursPresent };
    }
  }""")
swap("""        const list = await db.all('SELECT deveui, hour_start, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa FROM weather_station_hours WHERE deveui IN (""",
     """        const list = await db.all('SELECT deveui, hour_start, air_temperature_c, air_temperature_min_c, air_temperature_max_c, relative_humidity_pct, wind_speed_mps, global_radiation_wm2, pressure_hpa, sample_count FROM weather_station_hours WHERE deveui IN (""")
swap("""        const { hourStarts } = localDayWindow(date, tz, memo);
        const stationHours = new Map(stations.map((deveui) => [deveui, dayRows(hours.stationHours.get(deveui) || new Map(), hourStarts)]));
        return { date, computed: resolveDay({ date, hourStarts, latitude: entry ? entry.latitude : null, longitude: entry ? entry.longitude : null, provider: entry ? entry.provider : null, locationKey: entry ? entry.locationKey : null, stations, stationHours, providerRows: dayRows(hours.providerByHour, hourStarts), gatewayAltitudeM: zone.altitude_m, nowMs }) };""",
"""        const { hourStarts } = localDayWindow(date, tz, memo);
        const stationHours = new Map(stations.map((deveui) => [deveui, dayRows(hours.stationHours.get(deveui) || new Map(), hourStarts)]));
        // The 24 hours before the day's first hour, for the night rule's carried ratio.
        const firstMs = Date.parse(hourStarts[0]);
        const priorStarts = Array.from({ length: 24 }, (_, i) => hourStartIso(new Date(firstMs - (24 - i) * HOUR_MS)));
        const stationPriorHours = new Map(stations.map((deveui) => [deveui, dayRows(hours.stationHours.get(deveui) || new Map(), priorStarts)]));
        return { date, computed: resolveDay({ date, hourStarts, latitude: entry ? entry.latitude : null, longitude: entry ? entry.longitude : null, provider: entry ? entry.provider : null, locationKey: entry ? entry.locationKey : null, stations, stationHours, stationPriorHours, providerRows: dayRows(hours.providerByHour, hourStarts), gatewayAltitudeM: zone.altitude_m, nowMs }) };""")
p.write_text(s, encoding="utf-8")
print("osi-agronomy-daily: hourly station tier")
```
```bash
python3 "$SCRATCH/hourly-tier.py"
for f in index.js index.test.js; do cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/$f conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily/$f; done
```
Expected: `osi-agronomy-daily: hourly station tier`.

The prior hours are the 24 hour starts before the day's first hour, cut from the hour cache the run already holds (`hoursFor` reads 94 days), so there is no new query. Their `dayOfYear` is the previous local date's, as spec A7 fixes the day of year per local day.

- [ ] **Step 4: Run the gates**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/facade-contract.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/facade-contract.test.js
node scripts/verify-agronomy-contract.js
node scripts/capture-zone-env-vectors.js --verify
node scripts/verify-profile-parity.js
```
Expected: every suite `# fail 0` (the index suite `# pass 34`: sub-project 2's 27, E2a's 3, these 4; pin what the runner prints); the verifier OK; the zone-env vectors verify unchanged (they seed stored rows, they do not run the writer); `All parity checks passed.`

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily
git -c user.name=Project-OSI commit -m "feat(agronomy-daily): the station tier sums hourly FAO-56 ET0 (fao56_hourly), three uplinks per hour"
```

---

### Task 2: The README statement and the whole-branch gates

**Files:**
- Modify: `docs/contracts/agronomy/README.md`
- Scratch: `$SCRATCH/readme-station-tier.py`

**Interfaces:**
- Produces: the README paragraph the spec's A2 asks for ("`et0_tier = 'station_fao56'` is an hourly sum since contract v2, with `et0_source = 'fao56_hourly'`"), inserted before the Example 19 paragraph plan E1 wrote.

- [ ] **Step 1: The statement**

`$SCRATCH/readme-station-tier.py`:
```python
# One-shot (plan E3, Task 2): the README states what the station tier is since contract v2.
import pathlib
p = pathlib.Path("docs/contracts/agronomy/README.md")
s = p.read_text(encoding="utf-8")
anchor = "FAO-56 Example 19 (N'Diaye, Senegal, 1 October) is the golden vector:"
if s.count(anchor) != 1:
    raise SystemExit("expected one Example 19 paragraph (plan E1 writes it)")
s = s.replace(anchor, """Since contract version 2 the edge's station tier (`et0_tier = 'station_fao56'`) is this hourly sum over the assigned station's hours, with `et0_source = 'fao56_hourly'`. An hour counts when its mean temperature, humidity, wind and radiation are present, the radiation is not negative and at least three uplinks fed it; the station's radiation in W/m² times 0.0036 gives Rs in MJ/m² for the hour. A zone without a longitude cannot place the sun for an hour and falls to the provider tier. The leading night hours take the carried ratio of the previous evening's hour 2 to 3 hours before sunset from the same station's stored hours, else 0.5. The radiation plausibility check of the daily path (0.06 × Ra for the day, no zero in a daylight hour) still decides whether the day is a measurement. Rows written before the change keep `et0_source = 'station_fao56'`: read the tier from `et0_tier`, never from the source.

""" + anchor)
p.write_text(s, encoding="utf-8")
print("README: the station tier since contract v2")
```
```bash
python3 "$SCRATCH/readme-station-tier.py"
node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/agronomy/README.md
```
Expected: `README: the station tier since contract v2`; `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 2: Run the gates**

```bash
node scripts/verify-agronomy-contract.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/*.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/*.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js
node scripts/verify-profile-parity.js && node scripts/verify-helper-registration.js && node scripts/verify-osi-lib-db-caller-binding.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
```
Expected: every line OK or `# fail 0`. The flows gates are unchanged from E2a (E3 touches no flow node).

- [ ] **Step 3: Commit**

```bash
git add docs/contracts/agronomy/README.md
git -c user.name=Project-OSI commit -m "docs(agronomy): the station tier is an hourly FAO-56 sum since contract v2"
```

- [ ] **Step 4: What a deploy does (record in the PR body, no code)**

The first run after the deploy recomputes the last seven station days: their `et0_mm` moves to the hourly sum and `et0_source` to `fao56_hourly`; their Kc snapshot stays frozen, so `etc_mm` follows the new ET0. Older station days keep the daily equation's values and `station_fao56` as source. On a gateway that runs plan E4 as well, each changed row emits one `ZONE_AGRONOMY_UPSERTED`.

Whether a station keeps the hourly tier depends on how many uplinks feed each of its hours (`sample_count` ≥ 3, ruling R8), and nothing in the repository or the notes records any station's uplink interval (plan review E1-E3 I2). So before the PR body, the execution report or acceptance 4 says anything about a particular station, read that station's distribution on its gateway. The query only reads (`-readonly`); it runs on a test gateway, and only after Phil's go for gateway access in that session:
```bash
sqlite3 -readonly /data/db/farming.db "SELECT deveui, sample_count, COUNT(*) AS hours FROM weather_station_hours WHERE hour_start >= strftime('%Y-%m-%dT%H:00:00Z', 'now', '-7 days') GROUP BY deveui, sample_count ORDER BY deveui, sample_count;"
```
Hours with `sample_count` 3 or more feed the hourly tier. A station whose hours mostly show 1 or 2 sends every day to the provider tier (then Hargreaves, then `partial_day`), and acceptance 4 (`et0_source = 'fao56_hourly'`) must then run on a station that reports at least three uplinks an hour. The PR body and the report (plan E4 Task 4, E3 section) quote the counts the query printed, not an uplink interval; until the query has run they say the distribution is unknown.

---

## Spec coverage

| Spec item | Task |
|---|---|
| B4 station tier: the call, the hour shape, elevation, latitude and longitude, `dayOfYear`, completeness with `sample_count ≥ 3`, the hour-cache columns, plausibility unchanged, the longitude rule, `station_fao56`/`fao56_hourly`, Hargreaves unchanged | 1 |
| B4 `priorRsRso` from the previous 24 cached hours | 1 |
| B4 vector line: a station day from the A9 inputs with `sample_count = 6` gives 4.85 | 1 |
| A2 station-tier statement | 2 |
| Testing row `osi-agronomy-daily/index.test.js`: `fao56_hourly`, the missing `air_temperature_c` and `sample_count = 2` hours, no longitude, `priorRsRso` | 1 |
| `osi-station-hours` sample-count rule "if needed" | not needed (prerequisite 3) |
