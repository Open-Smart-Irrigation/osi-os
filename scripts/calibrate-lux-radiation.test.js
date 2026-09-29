'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, 'calibrate-lux-radiation.js');
const REPO = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(REPO, 'database', 'seed-blank.sql'), 'utf8');

const calibrate = require('./calibrate-lux-radiation');

const DEVEUI = 'S2120CAL0000AAAA';
const LOCATION_KEY = 'open_meteo:46.80:6.95';
// 8 UTC days; the most recent (25th) is always dropped as "may still be
// accumulating", leaving exactly the 7 days the script reports on.
const DAYS = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
const STATION_WM2 = 200;
const PROVIDER_WM2 = 180;
const MS_KEY = 'meteoswiss:46.80:6.95';
const MS_PROVIDER_WM2 = 250;
// 21 matched hours on this day: below the 22-hour minimum, so it is skipped.
const SHORT_DAY = '2026-09-17';

function hourStarts(day, count = 24) {
  return Array.from({ length: count }, (_, h) => day + 'T' + String(h).padStart(2, '0') + ':00:00Z');
}

// Every station hour stores global_radiation_wm2 = 999: the script must
// recompute radiation from light_lux / luxPerWm2 instead of reading it.
function seedDb(dbPath, { meteoswiss = false, latitude = 46.8, longitude = 6.95 } = {}) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(SEED);
  raw.exec("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', '2026-09-25T00:00:00Z')");
  raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, weather_source, zone_uuid) VALUES (1, 1, 'Z1', ?, ?, 'Europe/Zurich', 'open_meteo', '00000000-0000-4000-8000-000000000001')").run(latitude, longitude);
  raw.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, 'S2120 test', 'SENSECAP_S2120', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')").run(DEVEUI);
  raw.prepare('INSERT INTO weather_station_zones (deveui, zone_id) VALUES (?, 1)').run(DEVEUI);
  const key = locationKeyFor('open_meteo', latitude, longitude);
  raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone) VALUES (?, 'open_meteo', ?, ?, 'Europe/Zurich')").run(key, latitude, longitude);
  const insertStationHour = raw.prepare('INSERT INTO weather_station_hours (deveui, hour_start, light_lux, global_radiation_wm2, sample_count, computed_at) VALUES (?, ?, ?, 999, 6, ?)');
  const insertProviderHour = raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, global_radiation_wm2, station_id, fetched_at) VALUES (?, ?, ?, ?, ?)");
  for (const [day, count] of [[SHORT_DAY, 21], ...DAYS.map((d) => [d, 24])]) {
    for (const hourStart of hourStarts(day, count)) {
      insertStationHour.run(DEVEUI, hourStart, STATION_WM2 * 120, hourStart);
      insertProviderHour.run(key, hourStart, PROVIDER_WM2, null, hourStart);
    }
  }
  if (meteoswiss) {
    // A second zone on the same station, on MeteoSwiss (Payerne).
    raw.prepare("INSERT INTO irrigation_zones (id, user_id, name, latitude, longitude, timezone, weather_source, zone_uuid) VALUES (2, 1, 'Z2', 46.8, 6.95, 'Europe/Zurich', 'meteoswiss', '00000000-0000-4000-8000-000000000002')").run();
    raw.prepare('INSERT INTO weather_station_zones (deveui, zone_id) VALUES (?, 2)').run(DEVEUI);
    raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone, station_id) VALUES (?, 'meteoswiss', 46.8, 6.95, 'Europe/Zurich', 'PAY')").run(MS_KEY);
    for (const day of DAYS) for (const hourStart of hourStarts(day)) insertProviderHour.run(MS_KEY, hourStart, MS_PROVIDER_WM2, 'PAY', hourStart);
  }
  raw.close();
}

function locationKeyFor(provider, latitude, longitude) {
  return provider + ':' + latitude.toFixed(2) + ':' + longitude.toFixed(2);
}

function run(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status,
      stdout: error.stdout ? error.stdout.toString() : '',
      stderr: error.stderr ? error.stderr.toString() : '',
    };
  }
}

test('median: odd count is the middle value, even count averages the two middle values, empty is null', () => {
  assert.equal(calibrate.median([1, 3, 2]), 2);
  assert.equal(calibrate.median([1, 2, 3, 4]), 2.5);
  assert.equal(calibrate.median([5]), 5);
  assert.equal(calibrate.median([]), null);
});

test('isLivePath: refuses /data/db/farming.db and any path under /data/, allows everything else', () => {
  assert.equal(calibrate.isLivePath('/data/db/farming.db'), true);
  assert.equal(calibrate.isLivePath('/data/anything.db'), true);
  assert.equal(calibrate.isLivePath('/data'), true);
  assert.equal(calibrate.isLivePath('/tmp/farming.db'), false);
  assert.equal(calibrate.isLivePath('./farming-copy.db'), false);
});

test('stationRadiationRatios: sums MJ/m^2 per UTC day, drops the most recent day, and computes the median ratio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-lux-'));
  const dbPath = path.join(dir, 'farming.db');
  seedDb(dbPath);
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const results = await calibrate.stationRadiationRatios(raw);
    assert.equal(results.length, 1);
    const [result] = results;
    assert.equal(result.deveui, DEVEUI);
    assert.equal(result.locationKey, LOCATION_KEY);
    // 24 x 200 x 0.0036 = 17.28 MJ/m^2 station (from 24000 lux / 120, not the
    // stored 999), 24 x 180 x 0.0036 = 15.552 -> 15.55 MJ/m^2 provider.
    assert.equal(result.days.length, 7);
    assert.deepEqual(result.days.map((d) => d.date), DAYS.slice(0, 7));
    for (const day of result.days) {
      assert.equal(day.hours, 24);
      assert.equal(day.stationMj, 17.28);
      assert.equal(day.providerMj, 15.55);
      assert.equal(day.ratio, 1.111);
    }
    assert.deepEqual(result.skippedDays, [{ date: SHORT_DAY, hours: 21 }]);
    assert.equal(result.provider, 'open_meteo');
    assert.match(result.reference, /^Open-Meteo model \(modelled; at Payerne 0\.75 to 0\.91/);
    assert.match(result.advice, /weather_source is meteoswiss/);
    assert.equal(result.medianRatio, 1.111);
    assert.equal(result.currentLuxPerWm2, 120);
    assert.equal(result.suggestedLuxPerWm2, 133.3);
  } finally {
    raw.close();
  }
});

test('CLI: prints the per-day sums, the median ratio and the suggested luxPerWm2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-lux-cli-'));
  const dbPath = path.join(dir, 'farming.db');
  seedDb(dbPath);
  const { status, stdout } = run([dbPath]);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp('Station ' + DEVEUI + ' vs ' + LOCATION_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'));
  assert.match(stdout, /reference: Open-Meteo model \(modelled; at Payerne 0\.75 to 0\.91 of the station measurement on 24–25 Sept 2026\)/);
  assert.match(stdout, /advice: This location is inside MeteoSwiss coverage: calibrate against a zone whose weather_source is meteoswiss/);
  assert.match(stdout, /2026-09-17\s+skipped: 21 matched hours \(need 22\)/);
  assert.match(stdout, /2026-09-24\s+hours=24\s+station=17\.28 MJ\/m\^2\s+provider=15\.55 MJ\/m\^2\s+ratio=1\.111/);
  assert.ok(!stdout.includes('2026-09-25'), 'the most recent matched day must be excluded from the printed window');
  assert.match(stdout, /median ratio \(last 7 days\): 1\.111/);
  assert.match(stdout, /luxPerWm2 that would make the median 1\.0 \(current 120\): 133\.3/);
});

test('CLI: refuses /data/db/farming.db without ever trying to open it', () => {
  const { status, stderr } = run(['/data/db/farming.db']);
  assert.equal(status, 1);
  assert.match(stderr, /refusing .*\/data\/db\/farming\.db/);
  assert.match(stderr, /live gateway/);
});

test('CLI: refuses any other path under /data/', () => {
  const { status, stderr } = run(['/data/some-copy.db']);
  assert.equal(status, 1);
  assert.match(stderr, /refusing/);
});

test('CLI: --help prints usage and exits 0; no arguments prints usage and exits 1', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/calibrate-lux-radiation\.js/);
  const bare = run([]);
  assert.equal(bare.status, 1);
  assert.match(bare.stdout, /Usage: node scripts\/calibrate-lux-radiation\.js/);
});

test('a MeteoSwiss location is named as the measured reference; an Open-Meteo location outside Swiss coverage gets no advice', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-lux-ms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const swissPath = path.join(dir, 'swiss.db');
  seedDb(swissPath, { meteoswiss: true });
  const swiss = new DatabaseSync(swissPath, { readOnly: true });
  const results = await calibrate.stationRadiationRatios(swiss);
  swiss.close();
  const ms = results.find((r) => r.locationKey === MS_KEY);
  assert.equal(ms.reference, 'MeteoSwiss station PAY (measured global radiation)');
  assert.equal(ms.advice, null);
  // 200 / 250 = 0.8: the station reads low against the measurement.
  assert.equal(ms.medianRatio, 0.8);
  assert.equal(ms.suggestedLuxPerWm2, 96);
  const kampalaPath = path.join(dir, 'kampala.db');
  seedDb(kampalaPath, { latitude: 0.33, longitude: 32.58 });
  const kampala = new DatabaseSync(kampalaPath, { readOnly: true });
  const [om] = await calibrate.stationRadiationRatios(kampala);
  kampala.close();
  assert.equal(om.provider, 'open_meteo');
  assert.equal(om.advice, null);
});
