# S2120 Weather History Completion (issue #33) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work on a feature branch / worktree (superpowers:using-git-worktrees), never directly on `main`.

**Goal:** Close [osi-os#33](https://github.com/Open-Smart-Irrigation/osi-os/issues/33) — "S2120 card: no history/chart for wind, UV, barometric pressure, rain" — by (a) giving rain a *truthful* history view (daily-total bars + interval bars in a dedicated `RainMonitor` modal, backed by a new SUM-per-local-day edge endpoint) and (b) locking the already-shipped wind/UV/pressure/temperature/humidity history wiring in place with focused regression tests so the issue can be closed with evidence.

**Architecture:** A new pure helper `legacyRainDailyHistory` in `osi-history-helper` runs `SUM(rain_mm_delta) GROUP BY date(recorded_at, '<tz-offset> minutes')` against `device_data` and is exposed via a new Node-RED endpoint `GET /api/devices/:deveui/rain-history` (same auth + wiring pattern as the existing `sensor-history` endpoint). The GUI gets a `RainMonitor` modal (mirrors `WindMonitor`): 12 h/24 h windows show raw interval-delta bars via the existing `sensor-history` endpoint (≤ 24 h is guaranteed raw), 7 d/30 d/90 d windows show daily-total bars from the new endpoint, zero-filled client-side by pure, unit-tested helpers in `src/utils/rain.ts`. The S2120 card's "Rain Today" tile switches from the generic `SensorMonitor` line chart to `RainMonitor`.

**Tech Stack:** Node-RED function nodes (`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`), CommonJS helper (`osi-history-helper/index.js`), SQLite (`device_data`), React + TypeScript + recharts (`web/react-gui`), Vitest, `scripts/test-history-helper.js` harness.

## Verified baseline (read before coding — this corrects the issue text)

Verified on `main` (2026-07-05):

- The card `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx` **already** opens history views for every tile: temperature (`ambient_temperature`), humidity (`relative_humidity`), pressure (`barometric_pressure_hpa`), UV (`uv_index`), light (`light_lux`) via `SensorMonitor`; wind speed/direction via `WindMonitor` (speed+gust time series + wind rose, merged in `9f4a73c5`); rain via `SensorMonitor` with `rain_mm_delta` / `rain_mm_per_10min` series.
- The backend whitelist `LEGACY_SENSOR_HISTORY_FIELDS` in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js` (line ~59) already covers all S2120 channels including `wind_direction_deg`, `uv_index`, `barometric_pressure_hpa`, and all `rain_*` fields.
- **The real remaining gap is rain.** `legacySensorHistory` for `hours > 24` aggregates via `resolveDeviceFieldRollupKey` → `flattenLegacyAggregate`, which reduces each bucket to `stats.latest ?? stats.mean` (`statsForValues` computes no `sum`). For interval deltas like `rain_mm_delta` that silently *under-reports* rainfall (a 30 d window shows "the last delta of each day", not daily totals). Rain also has no cumulative/daily presentation, which is the form farmers actually need. Note: `resolveDeviceFieldRollupKey` INNER JOINs on `devices.irrigation_zone_id`, so this `latest ?? mean` collapse only fires for long windows on devices that have a zone assignment via that column; default S2120s (assigned only through the `weather_station_zones` join table, with `irrigation_zone_id` left null) instead hit the raw fallback path. In other words this is a misleading *line-chart presentation* bug for zone-assigned devices, not a "wrong numbers for all S2120s" bug — the fix (dedicated daily-totals endpoint + RainMonitor) is unchanged either way.

## Design decisions (scope rationale)

1. **Rain → daily bars + interval bars in a dedicated `RainMonitor`** (WindMonitor pattern). Daily totals are the canonical rain history form; a smoothed area line of deltas is misleading.
2. **New endpoint** `GET /api/devices/:deveui/rain-history?days&tz_offset_min` instead of teaching the shared rollup machinery `sum` semantics: SQL `SUM ... GROUP BY local day` is exact, tiny (≤ 366 rows), avoids the 30 000-row raw cap, and touches nothing shared. No other consumer needs summed rollups today.
3. **Local-day bucketing via a client-supplied UTC offset** (`-new Date().getTimezoneOffset()`): S2120s are assigned to zones via `weather_station_zones`, not `devices.irrigation_zone_id`, so zone timezone is not reliably resolvable. A fixed offset misbuckets only samples inside a DST transition hour twice a year — accepted and documented.
4. **UV / pressure / wind speed / temperature / humidity keep their existing forms** (SensorMonitor line charts; WindMonitor time series + rose). No rework — only regression tests, so a future whitelist or wiring change cannot silently reopen #33.
5. **Interval windows (12 h/24 h) reuse `sensorAPI.getHistory('rain_mm_delta', hours≤24)`** — verified raw path (`legacySensorHistory` short-circuits to `rawLegacySensorHistory` for `hours <= 24`). The old `rain_mm_per_10min` series option is dropped: at the S2120's ~10-min uplink cadence the interval-delta bars carry the same information.
6. **`samples === 0` days must read as "no data," never as measured dry days.** Ingest writes `rain_mm_delta = 0.0` on every valid dry uplink, so a filled (zero-fill) day with `samples === 0` means the station produced no valid uplink that day (offline / gap), not that it measured zero rain. `RainMonitor` must render such days with a "no data" tooltip (not "0.0 mm"), give them a visually distinct/omitted bar, and exclude them from RAINY DAYS/window-total/wettest-day summaries as measured-dry days. This is the same "do not invent history values" constraint as the issue brief — it applies to *presenting* a real gap as a measured zero, not only to fabricating numbers outright.
7. **Out of scope:** `rain_gauge_*` channels — including `rain_gauge_cumulative_mm`, which *is* an S2120-stored `device_data` column (the raw rain-tip counter cumulative that `rain_mm_delta`/`rain_mm_per_10min`/`rain_mm_today` are derived from) — deferred because it is redundant with the daily totals this plan already delivers, not because it belongs to a different device. LoRain card reuse of `RainMonitor` (follow-up), zone-level rain history cards, any analytics (ET, intensity classes), schema changes are also out of scope.

## Global Constraints

- **Never touch:** `database/seed-blank.sql`, any bundled `farming.db`, the frozen "Sync Init Schema + Triggers" node in flows.json, `openwrt/build_dir/**` (build artifacts contain stale copies of flows.json/helper — ignore them), `.worktrees/**`.
- **Profile parity:** `conf/full_raspberrypi_bcm27xx_bcm2712/files/**` is canonical; every change there must be copied byte-for-byte to `conf/full_raspberrypi_bcm27xx_bcm2709/files/**` **in the same commit** (`scripts/verify-profile-parity.js` fails CI otherwise; it is chained from `verify-sync-flow.js`).
- **Gates (all must pass before the branch is done):** `node scripts/test-history-helper.js` (exit 0), `node scripts/verify-sync-flow.js` (exit 0, ends `All parity checks passed.`), and from `web/react-gui/`: `npm run typecheck`, `npm run test:unit`, `npm run build`.
- flows.json is `JSON.stringify(flows, null, 2) + '\n'` (verified roundtrip-identical), so programmatic insertion produces a minimal diff.
- Repo-root commands run from `/home/phil/Repos/osi-os`; GUI commands from `/home/phil/Repos/osi-os/web/react-gui`.
- TypeScript work must respect the repo overlays `/home/phil/Repos/osi-os/RULES.yaml` + `architect.yaml` (notably: narrow unknown JSON inside the service layer, no broad exported `any`).

---

### Task 1: `legacyRainDailyHistory` in osi-history-helper (backend aggregation, TDD)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Modify: `scripts/test-history-helper.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js` (byte copy)

**Interface produced (later tasks depend on these exact names):**

```js
// helper export
async function legacyRainDailyHistory(db, options)
// options: { deveui, days, tzOffsetMin, userId, nowMs }
// returns: Array<{ day: 'YYYY-MM-DD', total_mm: number, samples: number }>, ascending by day
```

- [ ] **Step 1: Write the failing test**

In `/home/phil/Repos/osi-os/scripts/test-history-helper.js`:

1. In the `expectedExports` array (starts line ~24), find the line `  'legacySensorHistory',` and insert directly below it:

```js
  'legacyRainDailyHistory',
```

2. Find the line `test('legacySensorHistory keeps dendro history response fields stable', async () => {` (~line 1737) and insert the following complete test block **above** it:

```js
test('legacyRainDailyHistory sums rain deltas per local day with a tz offset', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at)
        VALUES('AA00000000000002','Weather','SENSECAP_S2120',1,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,rain_mm_delta) VALUES
        ('AA00000000000002','2026-06-20T12:00:00.000Z',9.9),
        ('AA00000000000002','2026-06-30T22:30:00.000Z',1.2),
        ('AA00000000000002','2026-07-01T05:00:00.000Z',0.4),
        ('AA00000000000002','2026-07-01T23:00:00.000Z',2.0),
        ('AA00000000000002','2026-07-02T10:00:00.000Z',0),
        ('AA00000000000002','2026-07-02T11:00:00.000Z',NULL);
    `);

    // At UTC+2: 06-30T22:30Z and 07-01T05:00Z land on local 2026-07-01;
    // 07-01T23:00Z and 07-02T10:00Z land on local 2026-07-02.
    // NULL deltas are excluded; the 06-20 row is outside the 7-day window
    // (window start = 2026-06-25T22:00:00Z for now=07-02T12:00Z, tz +120).
    const week = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 7,
      tzOffsetMin: 120,
      userId: 1,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(week, [
      { day: '2026-07-01', total_mm: 1.6, samples: 2 },
      { day: '2026-07-02', total_mm: 2, samples: 2 },
    ]);

    const today = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 1,
      tzOffsetMin: 120,
      userId: 1,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(today, [{ day: '2026-07-02', total_mm: 2, samples: 2 }]);

    const otherUser = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 7,
      tzOffsetMin: 120,
      userId: 999,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.deepStrictEqual(otherUser, []);

    // Clamping: days -> 366, tz offset -> +840 minutes; start param proves both.
    const clamped = await helper.legacyRainDailyHistory(db, {
      deveui: 'AA00000000000002',
      days: 99999,
      tzOffsetMin: 99999,
      userId: 1,
      nowMs: Date.parse('2026-07-02T12:00:00.000Z'),
    });
    assert.ok(Array.isArray(clamped));
    assert.strictEqual(db.lastQuery.params[0], '840 minutes');
    assert.strictEqual(db.lastQuery.params[3], '2025-07-02T10:00:00.000Z');
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os && node scripts/test-history-helper.js 2>&1 | grep -E "legacyRainDailyHistory|FAIL"
```

Expected: `FAIL exports the history helper contract` (its stack shows `legacyRainDailyHistory export`) and `FAIL legacyRainDailyHistory sums rain deltas per local day with a tz offset` (TypeError: `helper.legacyRainDailyHistory is not a function`). Exit code 1.

- [ ] **Step 3: Implement the helper**

In `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`, find the line `function csvCell(value) {` (~line 1547, immediately after `legacySensorHistory` ends) and insert the following block **above** it:

```js
const RAIN_HISTORY_MAX_DAYS = 366;
const RAIN_HISTORY_MAX_TZ_OFFSET_MIN = 840;
const RAIN_DAY_MS = 24 * 60 * 60 * 1000;

// Daily rainfall totals for one device, bucketed by *local* calendar day.
// tzOffsetMin = minutes to ADD to UTC to get local wall time (JS convention:
// -new Date().getTimezoneOffset()). Uses SUM over rain_mm_delta because the
// generic rollup path (statsForValues) has no sum statistic and its
// latest-per-bucket reduction under-reports interval deltas.
async function legacyRainDailyHistory(db, options = {}) {
  const normalizedDeveui = normalizeDeveui(options.deveui || options.deviceEui || options.device_eui);
  if (!normalizedDeveui) return [];
  const daysRaw = toFiniteNumber(options.days);
  const days = Math.max(1, Math.min(RAIN_HISTORY_MAX_DAYS, Math.round(daysRaw === null ? 7 : daysRaw)));
  const offsetRaw = toFiniteNumber(options.tzOffsetMin ?? options.tz_offset_min);
  const tzOffsetMin = Math.max(
    -RAIN_HISTORY_MAX_TZ_OFFSET_MIN,
    Math.min(RAIN_HISTORY_MAX_TZ_OFFSET_MIN, Math.round(offsetRaw === null ? 0 : offsetRaw))
  );
  const nowMs = options.nowMs ?? Date.now();
  const offsetMs = tzOffsetMin * 60 * 1000;
  // Start of the local day (days - 1) days back, converted back to UTC.
  const localTodayStartMs = Math.floor((nowMs + offsetMs) / RAIN_DAY_MS) * RAIN_DAY_MS - offsetMs;
  const start = new Date(localTodayStartMs - (days - 1) * RAIN_DAY_MS).toISOString();
  const end = new Date(nowMs).toISOString();
  const ownerFilter = optionalUserFilter(options, 'dv');
  const rows = await dbAll(db, `
    SELECT
      date(dd.recorded_at, ?) AS day,
      SUM(dd.rain_mm_delta) AS total_mm,
      COUNT(*) AS samples
    FROM device_data dd
    JOIN devices dv ON dv.deveui = dd.deveui
    WHERE dd.deveui = ?
      ${ownerFilter.sql}
      AND dd.rain_mm_delta IS NOT NULL
      AND dd.recorded_at >= ?
      AND dd.recorded_at < ?
    GROUP BY day
    ORDER BY day ASC
  `, [`${tzOffsetMin} minutes`, normalizedDeveui].concat(ownerFilter.params, [start, end]));
  return rows.map((row) => ({
    day: String(row.day),
    total_mm: roundTo(row.total_mm, 3) ?? 0,
    samples: Number(row.samples || 0) || 0,
  }));
}
```

Then, in `module.exports = {` (~line 2502), find the line `  legacySensorHistory,` and insert directly below it:

```js
  legacyRainDailyHistory,
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/phil/Repos/osi-os && node scripts/test-history-helper.js 2>&1 | grep -E "legacyRainDailyHistory|FAIL"; node scripts/test-history-helper.js > /dev/null 2>&1; echo "exit=$?"
```

Expected: `OK legacyRainDailyHistory sums rain deltas per local day with a tz offset`, no `FAIL` lines, `exit=0`.

- [ ] **Step 5: Mirror the helper to the Pi 4 profile and check parity**

```bash
cd /home/phil/Repos/osi-os
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js
node scripts/verify-profile-parity.js
```

Expected: `OK:` lines for each payload path, ending `All parity checks passed.` Exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-os
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js \
        scripts/test-history-helper.js
git commit -m "feat(rain): add legacyRainDailyHistory daily-total aggregation to osi-history-helper"
```

---

### Task 2: `GET /api/devices/:deveui/rain-history` endpoint in flows.json (both profiles)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (insert 2 nodes)
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (byte copy)
- Temp (created in the session scratchpad, run, left there — never copied into the repo, so no pre-commit cleanup is needed): `/tmp/claude-1000/-home-phil-Repos-osi-os/c878876a-e679-404b-a220-5c1ba0b92baa/scratchpad/tmp-rain-history-fn.func.txt`, `/tmp/claude-1000/-home-phil-Repos-osi-os/c878876a-e679-404b-a220-5c1ba0b92baa/scratchpad/tmp-add-rain-history-endpoint.mjs`

**Wiring:** `rain-history-http` (http in) → `rain-history-fn` (function, libs `osiDb`/`osiHistory`/`crypto`) → existing `device-response` (http response) — identical topology to the `sensor-history-*` nodes on tab `device-api-tab`. The auth boilerplate is copied verbatim from the shipped `sensor-history-fn` node ("Auth + Build SQL"). This endpoint URL does not start with `/api/history` or `/api/analysis`, so `verify-history-api-contract.js` does not flag it.

- [ ] **Step 1: Create the function-node source file**

Create `/tmp/claude-1000/-home-phil-Repos-osi-os/c878876a-e679-404b-a220-5c1ba0b92baa/scratchpad/tmp-rain-history-fn.func.txt` with exactly this content (plain text — it becomes the `func` string of the new node):

```js
return (async () => {
function getAuthSecret() {
  const configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();
  if (configured) return configured;
  const fs = global.get('fs');
  const secretPaths = ['/data/db/osi_auth_token_secret', '/var/lib/node-red/.node-red/osi_auth_token_secret'];
  if (fs) {
    for (const secretPath of secretPaths) {
      try {
        const existing = String(fs.readFileSync(secretPath, 'utf8') || '').trim();
        if (existing) return existing;
      } catch (_) {}
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fs.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (_) {}
    }
  }
  const err = new Error('AUTH_TOKEN_SECRET or JWT_SECRET must be configured');
  err.statusCode = 500;
  throw err;
}
function toBase64Url(input) {
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
function respond(statusCode, payload) {
  msg.statusCode = statusCode;
  msg.payload = payload;
  return msg;
}
function normalizeDeveuiParam() {
  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();
  if (!deveui) {
    const err = new Error('Missing deveui');
    err.statusCode = 400;
    throw err;
  }
  return deveui;
}
function parseDays() {
  const daysRaw = Number(msg.req && msg.req.query && msg.req.query.days);
  return Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 7;
}
function parseTzOffsetMin() {
  const offsetRaw = Number(msg.req && msg.req.query && msg.req.query.tz_offset_min);
  return Number.isFinite(offsetRaw) ? offsetRaw : 0;
}

  let db = null;
  const closeDb = function() {
    return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();
  };
  try {
    const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);
    const deveui = normalizeDeveuiParam();
    db = new osiDb.Database('/data/db/farming.db');
    const points = await osiHistory.legacyRainDailyHistory(db, {
      deveui: deveui,
      days: parseDays(),
      tzOffsetMin: parseTzOffsetMin(),
      userId: auth.userId,
      nowMs: Date.now(),
    });
    return respond(200, points);
  } catch (error) {
    const statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    return respond(statusCode, { message: error && error.message ? error.message : 'Unable to load rain history' });
  } finally {
    try { await closeDb(); } catch (_) {}
  }
})();
```

- [ ] **Step 2: Create the insertion script**

Create `/tmp/claude-1000/-home-phil-Repos-osi-os/c878876a-e679-404b-a220-5c1ba0b92baa/scratchpad/tmp-add-rain-history-endpoint.mjs`:

```js
import fs from 'node:fs';

const SCRATCH = '/tmp/claude-1000/-home-phil-Repos-osi-os/c878876a-e679-404b-a220-5c1ba0b92baa/scratchpad';
const FLOWS = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const FUNC = fs.readFileSync(`${SCRATCH}/tmp-rain-history-fn.func.txt`, 'utf8');

const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
if (flows.some((node) => node.id === 'rain-history-http' || node.id === 'rain-history-fn')) {
  console.log('rain-history nodes already present; nothing to do');
  process.exit(0);
}
const anchor = flows.findIndex((node) => node.id === 'sensor-history-format');
if (anchor < 0) throw new Error('anchor node sensor-history-format not found');

const httpNode = {
  id: 'rain-history-http',
  type: 'http in',
  z: 'device-api-tab',
  name: 'GET /api/devices/:deveui/rain-history',
  url: '/api/devices/:deveui/rain-history',
  method: 'get',
  x: 160,
  y: 2160,
  wires: [['rain-history-fn']],
};

const fnNode = {
  id: 'rain-history-fn',
  type: 'function',
  z: 'device-api-tab',
  name: 'Auth + Daily Rain History',
  func: FUNC,
  outputs: 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiHistory', module: 'osi-history-helper' },
    { var: 'crypto', module: 'crypto' },
  ],
  x: 440,
  y: 2160,
  wires: [['device-response']],
};

flows.splice(anchor + 1, 0, httpNode, fnNode);
fs.writeFileSync(FLOWS, JSON.stringify(flows, null, 2) + '\n');
console.log('inserted rain-history-http + rain-history-fn after sensor-history-format');
```

- [ ] **Step 3: Run it and verify the inserted nodes**

```bash
cd /home/phil/Repos/osi-os
node /tmp/claude-1000/-home-phil-Repos-osi-os/c878876a-e679-404b-a220-5c1ba0b92baa/scratchpad/tmp-add-rain-history-endpoint.mjs
node -e "
const flows = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const http = flows.find((n) => n.id === 'rain-history-http');
const fn = flows.find((n) => n.id === 'rain-history-fn');
if (!http || !fn) throw new Error('nodes missing');
if (http.wires[0][0] !== 'rain-history-fn') throw new Error('http wiring wrong');
if (fn.wires[0][0] !== 'device-response') throw new Error('fn wiring wrong');
if (!fn.func.includes('legacyRainDailyHistory')) throw new Error('fn body wrong');
new Function('msg', 'env', 'global', 'osiDb', 'osiHistory', 'crypto', 'node', fn.func); // syntax check
console.log('rain-history nodes OK; func length', fn.func.length);
"
git diff --stat conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
```

Expected: `inserted rain-history-http + rain-history-fn after sensor-history-format`, then `rain-history nodes OK; func length` ≈ 3900–4600, and a diff stat showing a single-block insertion (roughly +60 lines, no deletions).

- [ ] **Step 4: Mirror to Pi 4 profile**

The temp scripts live outside the repo (session scratchpad), so there is nothing to clean up before committing.

```bash
cd /home/phil/Repos/osi-os
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
```

- [ ] **Step 5: Run the full flow verifier**

```bash
cd /home/phil/Repos/osi-os && node scripts/verify-sync-flow.js; echo "exit=$?"
```

Expected: many `OK ...` lines, ends with `All parity checks passed.` and `exit=0`. If `verify-history-api-contract` complains about the new endpoint, the URL was typed wrong (it must be `/api/devices/:deveui/rain-history`, which is outside that contract's route space).

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-os
git status --short   # confirm ONLY the two flows.json files are modified (temp scripts live in the scratchpad, outside the repo)
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(rain): add GET /api/devices/:deveui/rain-history daily-totals endpoint (both profiles)"
```

---

### Task 3: Pure rain helpers in the GUI (`src/utils/rain.ts`, TDD)

**Files:**
- Create: `web/react-gui/src/utils/rain.ts`
- Create: `web/react-gui/src/utils/__tests__/rain.test.ts`

**Interface produced (Tasks 4–5 rely on these exact names/types):**

```ts
export interface RainDay { day: string; total_mm: number; samples: number }
export interface RainIntervalPoint { t: string; value: number | null }
export interface RainDailySummary { totalMm: number; rainyDays: number; wettestDay: RainDay | null }
export interface RainIntervalSummary { totalMm: number; peakMm: number | null; wetIntervals: number }
export function localTzOffsetMinutes(date?: Date): number;
export function localDayIso(date?: Date): string;
export function addDaysIso(day: string, delta: number): string;
export function fillMissingRainDays(days: RainDay[], windowDays: number, lastDay: string): RainDay[];
export function summarizeRainDays(days: RainDay[]): RainDailySummary;
export function summarizeRainIntervals(points: RainIntervalPoint[]): RainIntervalSummary;
```

- [ ] **Step 1: Write the failing tests**

Create `web/react-gui/src/utils/__tests__/rain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  fillMissingRainDays,
  localDayIso,
  localTzOffsetMinutes,
  summarizeRainDays,
  summarizeRainIntervals,
  type RainDay,
} from '../rain';

describe('addDaysIso', () => {
  it('adds days across month boundaries', () => {
    expect(addDaysIso('2026-06-30', 1)).toBe('2026-07-01');
  });

  it('subtracts days across year boundaries', () => {
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('localDayIso / localTzOffsetMinutes', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(localDayIso(new Date(2026, 6, 4, 12, 0, 0))).toBe('2026-07-04');
  });

  it('is the negation of getTimezoneOffset', () => {
    const now = new Date();
    expect(localTzOffsetMinutes(now)).toBe(-now.getTimezoneOffset());
  });
});

describe('fillMissingRainDays', () => {
  const rows: RainDay[] = [
    { day: '2026-07-02', total_mm: 3.4, samples: 12 },
    { day: '2026-07-04', total_mm: 1.2, samples: 6 },
  ];

  it('zero-fills a full window ending at lastDay, in ascending order', () => {
    const filled = fillMissingRainDays(rows, 4, '2026-07-04');
    expect(filled.map((entry) => entry.day)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
    ]);
    expect(filled[0]).toEqual({ day: '2026-07-01', total_mm: 0, samples: 0 });
    expect(filled[1]).toEqual(rows[0]);
    expect(filled[3]).toEqual(rows[1]);
  });

  it('drops rows outside the window', () => {
    const filled = fillMissingRainDays(rows, 2, '2026-07-04');
    expect(filled.map((entry) => entry.day)).toEqual(['2026-07-03', '2026-07-04']);
    expect(filled[0].total_mm).toBe(0);
    expect(filled[1].total_mm).toBe(1.2);
  });
});

describe('summarizeRainDays', () => {
  it('sums totals, counts rainy days, and finds the wettest day', () => {
    const summary = summarizeRainDays([
      { day: '2026-07-01', total_mm: 0, samples: 10 },
      { day: '2026-07-02', total_mm: 3.4, samples: 12 },
      { day: '2026-07-03', total_mm: 1.2, samples: 6 },
    ]);
    expect(summary.totalMm).toBeCloseTo(4.6);
    expect(summary.rainyDays).toBe(2);
    expect(summary.wettestDay?.day).toBe('2026-07-02');
  });

  it('returns the zero/null shape for empty input', () => {
    expect(summarizeRainDays([])).toEqual({ totalMm: 0, rainyDays: 0, wettestDay: null });
  });

  it('excludes samples === 0 (no-data) days from totals, rainy-day count, and wettest day', () => {
    // A day with samples === 0 is a filled/zero-fill placeholder for a gap
    // (station offline, no valid uplinks) — it must NOT be treated as a
    // measured-dry day, unlike a day with samples > 0 and total_mm === 0
    // (station reported, genuinely no rain).
    const summary = summarizeRainDays([
      { day: '2026-07-01', total_mm: 0, samples: 0 }, // no data — excluded entirely
      { day: '2026-07-02', total_mm: 0, samples: 8 }, // measured dry — counted, not rainy
      { day: '2026-07-03', total_mm: 2.1, samples: 9 }, // measured wet
    ]);
    expect(summary.totalMm).toBeCloseTo(2.1);
    expect(summary.rainyDays).toBe(1);
    expect(summary.wettestDay?.day).toBe('2026-07-03');
  });
});

describe('summarizeRainIntervals', () => {
  it('ignores null values and computes total, peak, and wet-interval count', () => {
    const summary = summarizeRainIntervals([
      { t: '2026-07-04T08:00:00Z', value: 0.5 },
      { t: '2026-07-04T08:10:00Z', value: null },
      { t: '2026-07-04T08:20:00Z', value: 0 },
      { t: '2026-07-04T08:30:00Z', value: 1.5 },
    ]);
    expect(summary.totalMm).toBeCloseTo(2.0);
    expect(summary.peakMm).toBeCloseTo(1.5);
    expect(summary.wetIntervals).toBe(2);
  });

  it('returns null peak for empty input', () => {
    expect(summarizeRainIntervals([])).toEqual({ totalMm: 0, peakMm: null, wetIntervals: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/phil/Repos/osi-os/web/react-gui && npx vitest run src/utils/__tests__/rain.test.ts
```

Expected: FAIL — cannot resolve `../rain`.

- [ ] **Step 3: Implement the helpers**

Create `web/react-gui/src/utils/rain.ts`:

```ts
// Pure helpers for the S2120 rain history views (RainMonitor).
// RainDay mirrors the edge payload of GET /api/devices/:deveui/rain-history.

export interface RainDay {
  day: string; // 'YYYY-MM-DD' local calendar day (as bucketed by the edge)
  total_mm: number;
  samples: number;
}

export interface RainIntervalPoint {
  t: string;
  value: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Minutes to ADD to UTC to get local wall time (JS getTimezoneOffset is inverted).
export function localTzOffsetMinutes(date: Date = new Date()): number {
  return -date.getTimezoneOffset();
}

export function localDayIso(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDaysIso(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + delta * DAY_MS).toISOString().slice(0, 10);
}

// Produce exactly windowDays entries ending at lastDay, ascending, with
// zero-total placeholders for days the endpoint returned no row.
// Rows outside the window are dropped defensively.
export function fillMissingRainDays(days: RainDay[], windowDays: number, lastDay: string): RainDay[] {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const filled: RainDay[] = [];
  for (let back = windowDays - 1; back >= 0; back -= 1) {
    const day = addDaysIso(lastDay, -back);
    filled.push(byDay.get(day) ?? { day, total_mm: 0, samples: 0 });
  }
  return filled;
}

export interface RainDailySummary {
  totalMm: number;
  rainyDays: number;
  wettestDay: RainDay | null;
}

// A day with samples === 0 is a "no data" placeholder (zero-filled gap: the
// station reported no valid uplink that day), NOT a measured-dry day — ingest
// writes rain_mm_delta = 0.0 on every valid dry uplink, so a real dry day has
// samples > 0. Do not invent history values: no-data days are excluded from
// the total, the rainy-day count, and wettest-day selection.
export function summarizeRainDays(days: RainDay[]): RainDailySummary {
  let totalMm = 0;
  let rainyDays = 0;
  let wettestDay: RainDay | null = null;
  for (const entry of days) {
    if (entry.samples === 0) continue;
    if (!Number.isFinite(entry.total_mm)) continue;
    totalMm += entry.total_mm;
    if (entry.total_mm > 0) {
      rainyDays += 1;
      if (!wettestDay || entry.total_mm > wettestDay.total_mm) {
        wettestDay = entry;
      }
    }
  }
  return { totalMm, rainyDays, wettestDay };
}

export interface RainIntervalSummary {
  totalMm: number;
  peakMm: number | null;
  wetIntervals: number;
}

export function summarizeRainIntervals(points: RainIntervalPoint[]): RainIntervalSummary {
  let totalMm = 0;
  let peakMm: number | null = null;
  let wetIntervals = 0;
  for (const point of points) {
    const value = point.value;
    if (value == null || !Number.isFinite(value)) continue;
    totalMm += value;
    if (peakMm === null || value > peakMm) peakMm = value;
    if (value > 0) wetIntervals += 1;
  }
  return { totalMm, peakMm, wetIntervals };
}
```

- [ ] **Step 4: Run the tests to verify they pass, then typecheck**

```bash
cd /home/phil/Repos/osi-os/web/react-gui && npx vitest run src/utils/__tests__/rain.test.ts && npm run typecheck
```

Expected: 11 tests PASS; typecheck silent (exit 0).

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/utils/rain.ts web/react-gui/src/utils/__tests__/rain.test.ts
git commit -m "feat(rain): pure daily-rain helpers for the S2120 rain history view"
```

---

### Task 4: `sensorAPI.getDailyRainHistory` + `RainMonitor` modal (TDD)

**Files:**
- Modify: `web/react-gui/src/services/api.ts`
- Create: `web/react-gui/src/components/farming/RainMonitor.tsx`
- Create: `web/react-gui/src/components/farming/__tests__/RainMonitor.test.tsx`

- [ ] **Step 1: Add the API client method**

In `web/react-gui/src/services/api.ts`, add near the top with the other type imports (any position among the existing imports is fine):

```ts
import type { RainDay } from '../utils/rain';
```

Then replace the existing block (~line 914):

```ts
export const sensorAPI = {
  getHistory: async (deveui: string, field: string, hours = 24): Promise<SensorHistoryPoint[]> => {
    const response = await api.get<SensorHistoryPoint[]>(
      `/api/devices/${deveui}/sensor-history`,
      { params: { field, hours } }
    );
    return response.data;
  },
};
```

with:

```ts
export const sensorAPI = {
  getHistory: async (deveui: string, field: string, hours = 24): Promise<SensorHistoryPoint[]> => {
    const response = await api.get<SensorHistoryPoint[]>(
      `/api/devices/${deveui}/sensor-history`,
      { params: { field, hours } }
    );
    return response.data;
  },
  // Daily rainfall totals bucketed by local calendar day on the edge.
  // tzOffsetMin: minutes east of UTC (use localTzOffsetMinutes()).
  getDailyRainHistory: async (deveui: string, days: number, tzOffsetMin: number): Promise<RainDay[]> => {
    const response = await api.get<unknown>(
      `/api/devices/${deveui}/rain-history`,
      { params: { days, tz_offset_min: tzOffsetMin } }
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.flatMap((row): RainDay[] => {
      if (typeof row !== 'object' || row === null) return [];
      const record = row as Record<string, unknown>;
      const day = String(record.day ?? '');
      const totalMm = Number(record.total_mm);
      const samples = Number(record.samples);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(totalMm)) return [];
      return [{ day, total_mm: totalMm, samples: Number.isFinite(samples) ? samples : 0 }];
    });
  },
};
```

- [ ] **Step 2: Write the failing component tests**

Create `web/react-gui/src/components/farming/__tests__/RainMonitor.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sensorAPI, type SensorHistoryPoint } from '../../../services/api';
import { addDaysIso, localDayIso, type RainDay } from '../../../utils/rain';
import { RainMonitor } from '../RainMonitor';

vi.mock('../../../services/api', () => ({
  sensorAPI: {
    getHistory: vi.fn(),
    getDailyRainHistory: vi.fn(),
  },
}));

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Leaf = () => null;
  return {
    Bar: Leaf,
    BarChart: () => <div data-testid="rain-bar-chart" />,
    CartesianGrid: Leaf,
    ResponsiveContainer: Container,
    Tooltip: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
  };
});

const INTERVAL_ROWS: SensorHistoryPoint[] = [
  { t: '2026-07-04T08:00:00Z', value: 0.5 },
  { t: '2026-07-04T08:10:00Z', value: 0 },
  { t: '2026-07-04T08:20:00Z', value: 1.5 },
];

function dailyRows(): RainDay[] {
  const today = localDayIso();
  return [
    { day: addDaysIso(today, -1), total_mm: 3.4, samples: 12 },
    { day: today, total_mm: 1.2, samples: 6 },
  ];
}

describe('RainMonitor', () => {
  beforeEach(() => {
    vi.mocked(sensorAPI.getHistory).mockReset();
    vi.mocked(sensorAPI.getDailyRainHistory).mockReset();
    vi.mocked(sensorAPI.getHistory).mockResolvedValue(INTERVAL_ROWS);
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue(dailyRows());
  });

  it('loads 24 h interval deltas by default and summarizes them', async () => {
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);

    expect(await screen.findByText('2.0 mm')).toBeInTheDocument(); // window total
    expect(screen.getByText('1.5 mm')).toBeInTheDocument(); // peak interval
    expect(screen.getByText('WET INTERVALS')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByTestId('rain-bar-chart')).toBeInTheDocument();
    expect(sensorAPI.getHistory).toHaveBeenCalledWith('2CF7F1C0612345AB', 'rain_mm_delta', 24);
    expect(sensorAPI.getDailyRainHistory).not.toHaveBeenCalled();
  });

  it('switches to daily totals for the 7 d window and zero-fills the window', async () => {
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);
    await screen.findByText('2.0 mm');

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    expect(await screen.findByText('4.6 mm')).toBeInTheDocument(); // window total
    expect(screen.getByText('3.4 mm')).toBeInTheDocument(); // wettest day
    expect(screen.getByText('RAINY DAYS')).toBeInTheDocument();
    expect(screen.getByText(/7 days · daily totals/)).toBeInTheDocument();
    expect(sensorAPI.getDailyRainHistory).toHaveBeenCalledWith('2CF7F1C0612345AB', 7, expect.any(Number));
  });

  it('shows an empty state when no daily rainfall rows exist', async () => {
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue([]);
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);
    await screen.findByText('2.0 mm');

    fireEvent.click(screen.getByRole('button', { name: '30 d' }));

    expect(await screen.findByText('No rainfall recorded in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('rain-bar-chart')).not.toBeInTheDocument();
  });

  it('surfaces fetch errors', async () => {
    vi.mocked(sensorAPI.getHistory).mockRejectedValue(new Error('boom'));
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('excludes a samples === 0 (no-data) day from the daily summary tiles', async () => {
    // Same wettest-day total (3.4mm) as dailyRows(), plus one extra day that
    // has samples === 0 (station offline / no valid uplinks that day) and a
    // real measured-dry day (samples > 0, total_mm 0) mixed in. The no-data
    // day must not inflate RAINY DAYS or the window total, and must not win
    // wettest-day selection by virtue of being a "0.0 mm" entry.
    const today = localDayIso();
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue([
      { day: addDaysIso(today, -2), total_mm: 0, samples: 0 }, // no data
      { day: addDaysIso(today, -1), total_mm: 3.4, samples: 12 }, // wettest
      { day: today, total_mm: 0, samples: 6 }, // measured dry
    ]);
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);
    await screen.findByText('2.0 mm');

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    expect(await screen.findByText('3.4 mm')).toBeInTheDocument(); // window total == wettest day only
    expect(screen.getByText('RAINY DAYS')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // only the wettest day counts as rainy
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/web/react-gui && npx vitest run src/components/farming/__tests__/RainMonitor.test.tsx
```

Expected: FAIL — cannot resolve `../RainMonitor`.

- [ ] **Step 4: Implement `RainMonitor`**

Create `web/react-gui/src/components/farming/RainMonitor.tsx`:

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { sensorAPI, type SensorHistoryPoint } from '../../services/api';
import {
  fillMissingRainDays,
  localDayIso,
  localTzOffsetMinutes,
  summarizeRainDays,
  summarizeRainIntervals,
  type RainDay,
} from '../../utils/rain';

interface Props {
  deveui: string;
  deviceName: string;
  onClose: () => void;
}

type RainWindow =
  | { label: string; mode: 'interval'; hours: number }
  | { label: string; mode: 'daily'; days: number };

// Bar-chart row for the daily view: total_mm is nulled out for no-data
// (samples === 0) days so recharts omits the bar instead of drawing a
// misleading 0.0 mm bar.
type RainChartDay = Omit<RainDay, 'total_mm'> & { total_mm: number | null };

const TIME_WINDOWS: RainWindow[] = [
  { label: '12 h', mode: 'interval', hours: 12 },
  { label: '24 h', mode: 'interval', hours: 24 },
  { label: '7 d', mode: 'daily', days: 7 },
  { label: '30 d', mode: 'daily', days: 30 },
  { label: '90 d', mode: 'daily', days: 90 },
];

const DEFAULT_WINDOW_INDEX = 1; // '24 h'
const RAIN_COLOR = '#2563eb';

function fmtIntervalTick(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' })
    : iso;
}

function fmtDayTick(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : day;
}

function fmtMm(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(1)} mm` : '—';
}

const IntervalTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-xl">
      <p className="mb-1 text-[var(--text-tertiary)]">{fmtIntervalTick(label)}</p>
      <p className="font-bold text-[var(--text)]">{fmtMm(payload[0]?.value ?? null)}</p>
    </div>
  );
};

// A day with samples === 0 is a zero-filled "no data" placeholder (station
// offline / no valid uplinks that day) — never present it as a measured
// "0.0 mm" day. samples > 0 with total_mm === 0 is a genuine measured-dry day.
const DailyTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const row: RainChartDay | undefined = payload[0]?.payload;
  const noData = row?.samples === 0;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-xl">
      <p className="mb-1 text-[var(--text-tertiary)]">{fmtDayTick(label)}</p>
      <p className="font-bold text-[var(--text)]">
        {noData ? 'no data' : fmtMm(row?.total_mm ?? null)}
      </p>
    </div>
  );
};

export const RainMonitor: React.FC<Props> = ({ deveui, deviceName, onClose }) => {
  const [windowIndex, setWindowIndex] = useState(DEFAULT_WINDOW_INDEX);
  const [intervalData, setIntervalData] = useState<SensorHistoryPoint[]>([]);
  const [dailyData, setDailyData] = useState<RainDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedWindow = TIME_WINDOWS[windowIndex];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const selected = TIME_WINDOWS[windowIndex];
    const request =
      selected.mode === 'interval'
        ? sensorAPI.getHistory(deveui, 'rain_mm_delta', selected.hours).then((rows) => {
            if (!cancelled) {
              setIntervalData(rows);
              setDailyData([]);
            }
          })
        : sensorAPI.getDailyRainHistory(deveui, selected.days, localTzOffsetMinutes()).then((rows) => {
            if (!cancelled) {
              setDailyData(rows);
              setIntervalData([]);
            }
          });
    request
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error && err.message ? err.message : 'Failed to load');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deveui, windowIndex]);

  const filledDays = useMemo(
    () =>
      selectedWindow.mode === 'daily'
        ? fillMissingRainDays(dailyData, selectedWindow.days, localDayIso())
        : [],
    [dailyData, selectedWindow],
  );
  const dailySummary = useMemo(() => summarizeRainDays(filledDays), [filledDays]);
  // Bar chart input: no-data days (samples === 0) get a null bar value so
  // recharts omits the bar entirely, instead of drawing a misleading 0.0 mm
  // bar indistinguishable from a genuinely measured dry day. `samples` is
  // preserved on each row for DailyTooltip to detect the no-data case.
  const chartDays = useMemo(
    () => filledDays.map((entry) => ({ ...entry, total_mm: entry.samples === 0 ? null : entry.total_mm })),
    [filledDays],
  );
  const intervalSummary = useMemo(() => summarizeRainIntervals(intervalData), [intervalData]);
  const intervalTicks = useMemo(() => {
    if (!intervalData.length) return [];
    const step = Math.max(1, Math.floor(intervalData.length / 8));
    return intervalData.filter((_, index) => index % step === 0).map((point) => point.t);
  }, [intervalData]);

  const hasData =
    selectedWindow.mode === 'interval'
      ? intervalData.some((point) => point.value != null)
      : dailyData.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-[var(--bg)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-[var(--header-bg)] px-6 py-4">
          <div>
            <h2 className="high-contrast-text text-2xl font-bold text-[var(--header-text)]">Rainfall</h2>
            <p className="mt-0.5 text-sm text-[var(--header-subtext)]">{deviceName} · {deveui}</p>
          </div>
          <button onClick={onClose} className="px-2 text-3xl font-light leading-none text-[var(--header-text)] hover:text-white">×</button>
        </div>

        <div className="flex flex-wrap gap-2 px-6 pt-4">
          {TIME_WINDOWS.map((option, index) => (
            <button
              key={option.label}
              onClick={() => setWindowIndex(index)}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
                windowIndex === index
                  ? 'bg-[var(--primary)] text-white'
                  : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--border)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {!loading && !error && hasData && (
          <div className="grid grid-cols-3 gap-3 px-6 pt-4">
            {selectedWindow.mode === 'interval' ? (
              <>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WINDOW TOTAL</p>
                  <p className="text-xl font-bold text-[var(--text)]">{fmtMm(intervalSummary.totalMm)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">PEAK INTERVAL</p>
                  <p className="text-xl font-bold text-[var(--text)]">{fmtMm(intervalSummary.peakMm)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WET INTERVALS</p>
                  <p className="text-xl font-bold text-[var(--text)]">{String(intervalSummary.wetIntervals)}</p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WINDOW TOTAL</p>
                  <p className="text-xl font-bold text-[var(--text)]">{fmtMm(dailySummary.totalMm)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">RAINY DAYS</p>
                  <p className="text-xl font-bold text-[var(--text)]">{String(dailySummary.rainyDays)}</p>
                </div>
                <div className="rounded-lg bg-[var(--card)] p-3 text-center">
                  <p className="text-xs font-semibold text-[var(--text-tertiary)]">WETTEST DAY</p>
                  <p className="text-xl font-bold text-[var(--text)]">
                    {dailySummary.wettestDay ? fmtMm(dailySummary.wettestDay.total_mm) : '—'}
                  </p>
                  {dailySummary.wettestDay && (
                    <p className="text-xs text-[var(--text-tertiary)]">{fmtDayTick(dailySummary.wettestDay.day)}</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex flex-1 flex-col gap-6 px-6 py-4">
          {loading && (
            <div className="flex flex-1 items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--primary)] border-t-transparent" />
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-[var(--error-bg)] p-4 text-center text-[var(--error-text)]">{error}</div>
          )}
          {!loading && !error && !hasData && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-lg text-[var(--text-tertiary)]">
                {selectedWindow.mode === 'interval'
                  ? `No rainfall recorded in the last ${selectedWindow.hours} hours.`
                  : 'No rainfall recorded in this window.'}
              </p>
            </div>
          )}
          {!loading && !error && hasData && selectedWindow.mode === 'interval' && (
            <>
              <div>
                <h3 className="mb-3 font-bold text-[var(--text)]">Rainfall per interval (mm)</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={intervalData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      ticks={intervalTicks}
                      tickFormatter={fmtIntervalTick}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 'auto']}
                      tickFormatter={(value: number) => value.toFixed(1)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip content={<IntervalTooltip />} />
                    <Bar dataKey="value" fill={RAIN_COLOR} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="pb-2 text-center text-xs text-[var(--text-tertiary)]">
                {intervalData.length} readings · last {selectedWindow.hours} h
              </p>
            </>
          )}
          {!loading && !error && hasData && selectedWindow.mode === 'daily' && (
            <>
              <div>
                <h3 className="mb-3 font-bold text-[var(--text)]">Daily rainfall (mm)</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={chartDays} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="day"
                      tickFormatter={fmtDayTick}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 'auto']}
                      tickFormatter={(value: number) => value.toFixed(1)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip content={<DailyTooltip />} />
                    <Bar dataKey="total_mm" fill={RAIN_COLOR} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="pb-2 text-center text-xs text-[var(--text-tertiary)]">
                {filledDays.length} days · daily totals (local time)
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 5: Run the tests to verify they pass, then typecheck**

```bash
cd /home/phil/Repos/osi-os/web/react-gui && npx vitest run src/components/farming/__tests__/RainMonitor.test.tsx && npm run typecheck
```

Expected: 5 tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/services/api.ts \
        web/react-gui/src/components/farming/RainMonitor.tsx \
        web/react-gui/src/components/farming/__tests__/RainMonitor.test.tsx
git commit -m "feat(rain): RainMonitor modal with interval and daily rainfall bars"
```

---

### Task 5: Wire the card + regression tests for every S2120 history tile

**Files:**
- Modify: `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx`
- Create: `web/react-gui/src/components/farming/__tests__/SenseCapWeatherCard.test.tsx`

- [ ] **Step 1: Write the failing card tests**

Create `web/react-gui/src/components/farming/__tests__/SenseCapWeatherCard.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { SenseCapWeatherCard } from '../SenseCapWeatherCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
  s2120API: { setZoneAssignments: vi.fn().mockResolvedValue(undefined) },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

vi.mock('../SensorMonitor', () => ({
  SensorMonitor: ({ field }: { field: string }) => <div data-testid="sensor-monitor">{field}</div>,
}));

vi.mock('../WindMonitor', () => ({
  WindMonitor: () => <div data-testid="wind-monitor" />,
}));

vi.mock('../RainMonitor', () => ({
  RainMonitor: () => <div data-testid="rain-monitor" />,
}));

const s2120Device: Device = {
  id: 7,
  deveui: '2CF7F1C0612345AB',
  name: 'Orchard weather station',
  type_id: 'SENSECAP_S2120',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  irrigation_zone_id: null,
  last_seen: '2026-07-04T12:00:00Z',
  latest_data: {
    ambient_temperature: 18.4,
    relative_humidity: 56,
    wind_speed_mps: 3.2,
    wind_gust_mps: 5.6,
    wind_direction_deg: 45,
    rain_mm_today: 4.2,
    rain_mm_delta: 0.2,
    rain_mm_per_10min: 0.2,
    rain_mm_per_hour: 1.2,
    barometric_pressure_hpa: 1013,
    light_lux: 5400,
    uv_index: 5.1,
    bat_pct: 88,
    counter_interval_seconds: 600,
  },
} as unknown as Device;

describe('SenseCapWeatherCard history wiring (issue #33 regression net)', () => {
  it.each([
    ['18.4 °C', 'ambient_temperature'],
    ['56 %', 'relative_humidity'],
    ['1013 hPa', 'barometric_pressure_hpa'],
    ['5.4k lux', 'light_lux'],
    ['5.1 UVI', 'uv_index'],
  ])('opens SensorMonitor for the %s tile with field %s', (buttonName, field) => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    expect(screen.getByTestId('sensor-monitor')).toHaveTextContent(field);
  });

  it('opens WindMonitor from the wind speed tile', () => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: '3.2 m/s' }));
    expect(screen.getByTestId('wind-monitor')).toBeInTheDocument();
  });

  it('opens WindMonitor from the wind direction tile', () => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: 'NE 45°' }));
    expect(screen.getByTestId('wind-monitor')).toBeInTheDocument();
  });

  it('opens RainMonitor (not SensorMonitor) from the Rain Today tile', () => {
    render(<SenseCapWeatherCard device={s2120Device} />);
    fireEvent.click(screen.getByRole('button', { name: '4.2 mm' }));
    expect(screen.getByTestId('rain-monitor')).toBeInTheDocument();
    expect(screen.queryByTestId('sensor-monitor')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/web/react-gui && npx vitest run src/components/farming/__tests__/SenseCapWeatherCard.test.tsx
```

Expected: FAIL — `Cannot find module '../RainMonitor'`-style mock resolution error is NOT acceptable here (RainMonitor exists since Task 4); the actual expected failure is the last test: the Rain Today tile still opens `sensor-monitor` (`rain-monitor` test id not found). The five SensorMonitor cases and the two WindMonitor cases should already PASS — that is the point of the regression net.

- [ ] **Step 3: Wire `RainMonitor` into the card**

In `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx`:

1. Add the import (directly above the `SensorMonitor` import, line 7):

```tsx
import { RainMonitor } from './RainMonitor';
```

2. Add state, directly below `const [showWindMonitor, setShowWindMonitor] = useState(false);` (line 161):

```tsx
const [showRainMonitor, setShowRainMonitor] = useState(false);
```

3. Replace the Rain Today tile's onClick block (lines ~313–325):

```tsx
            onClick={() => setSensorMonitor({
              field: 'rain_mm_delta',
              initialField: 'rain_mm_delta',
              label: 'Rainfall',
              unit: 'mm',
              color: '#2563eb',
              decimals: 1,
              seriesOptions: [
                { field: 'rain_mm_delta', label: 'This interval', unit: 'mm', color: '#2563eb', decimals: 1 },
                { field: 'rain_mm_per_10min', label: 'Per 10 min (rate)', unit: 'mm', color: '#1d4ed8', decimals: 1 },
              ],
            })}
```

with:

```tsx
            onClick={() => setShowRainMonitor(true)}
```

4. Render the modal — directly below the existing `showWindMonitor` block (lines ~406–412), add:

```tsx
      {showRainMonitor && (
        <RainMonitor
          deveui={device.deveui}
          deviceName={device.name}
          onClose={() => setShowRainMonitor(false)}
        />
      )}
```

- [ ] **Step 4: Run the card tests to verify they pass, then the full suite + typecheck**

```bash
cd /home/phil/Repos/osi-os/web/react-gui && npx vitest run src/components/farming/__tests__/SenseCapWeatherCard.test.tsx && npm run typecheck && npm run test:unit
```

Expected: 8 card tests PASS; typecheck clean; full `test:unit` green (tsx-runner suite + all vitest folders).

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/farming/SenseCapWeatherCard.tsx \
        web/react-gui/src/components/farming/__tests__/SenseCapWeatherCard.test.tsx
git commit -m "feat(rain): open RainMonitor from S2120 Rain Today tile + tile history regression tests"
```

---

### Task 6: Full verification gates + manual smoke

- [ ] **Step 1: Repo gates**

```bash
cd /home/phil/Repos/osi-os
node scripts/test-history-helper.js > /dev/null 2>&1; echo "helper=$?"
node scripts/verify-sync-flow.js > /tmp/vsf.log 2>&1; echo "syncflow=$?"; tail -2 /tmp/vsf.log
git diff --check
```

Expected: `helper=0`, `syncflow=0` with `All parity checks passed.`, no whitespace errors.

- [ ] **Step 2: GUI gates**

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run typecheck && npm run test:unit && npm run build
```

Expected: all exit 0; build emits the bundle without new warnings about chunk composition (RainMonitor uses recharts, which is already in the main bundle via SensorMonitor/WindMonitor — no lazy boundary needed).

- [ ] **Step 3: Confirm no stray files**

```bash
cd /home/phil/Repos/osi-os && git status --short
```

Expected: clean (in particular: no leftover temp scripts in the repo — they live in the scratchpad, outside `git status`'s view — no `openwrt/build_dir` or `.worktrees` changes, no `database/` or `farming.db` changes).

- [ ] **Step 4 (manual, dev): visual smoke**

```bash
cd /home/phil/Repos/osi-os/web/react-gui && npm run dev
```

Open the dashboard, S2120 card → tap "Rain Today". Confirm: modal titled "Rainfall"; 12 h/24 h show interval bars; 7 d/30 d/90 d show daily bars ending today with zero-filled dry days; tiles show WINDOW TOTAL / RAINY DAYS / WETTEST DAY; every other tile still opens its existing history view. (Without a live backend the modal will show the error state — that only proves wiring; full data check is Step 5.)

- [ ] **Step 5 (manual, post-deploy only — optional but recommended before closing #33):**

After the next normal deploy to a demo Pi (safe deploy flow per AGENTS.md — this plan does NOT deploy), verify the endpoint end-to-end from the workstation (values below use Silvan, `100.81.220.8`; substitute the Pi that hosts an S2120):

```bash
TOKEN=$(curl -s -X POST http://100.81.220.8:1880/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<gui-username>","password":"<gui-password>"}' | node -e "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
curl -s "http://100.81.220.8:1880/api/devices/<S2120-DEVEUI>/rain-history?days=7&tz_offset_min=120" \
  -H "Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w '%{http_code}\n' "http://100.81.220.8:1880/api/devices/<S2120-DEVEUI>/rain-history?days=7"
```

Expected: first curl returns a JSON array of `{"day":"YYYY-MM-DD","total_mm":N,"samples":N}` (empty array is valid for a dry week); second returns `401` (auth-gated = healthy). Cross-check one day's `total_mm` against the card's "Rain Today" for today.

- [ ] **Step 6: Close out**

Open a PR referencing `Closes #33`, summarizing: rain daily-totals endpoint + RainMonitor; regression tests locking existing wind/UV/pressure/temp/humidity history wiring; both profiles updated.

---

## Self-Review

**Issue #33 coverage:**
- Wind speed/direction history → already shipped (`WindMonitor` + wind rose, commit `9f4a73c5`); locked by two card regression tests (Task 5). ✓
- UV index history → already shipped (`SensorMonitor`, field `uv_index`, whitelisted); locked by regression test. ✓
- Barometric pressure history → already shipped (`barometric_pressure_hpa`); locked by regression test. ✓
- Rain history → **new**: correct daily totals endpoint (Tasks 1–2), RainMonitor daily + interval bars (Tasks 3–5), replacing the misleading delta line chart. ✓
- Temperature/humidity no-regression → regression tests (Task 5). ✓
- "Do not invent history values when a channel is missing" (issue brief) → zero-fill only marks *days*, endpoint returns only observed rows; empty states rendered. This also covers *presentation*: a filled day with `samples === 0` (no valid uplinks — station offline/gap) is never shown or counted as a measured "0.0 mm" day — `summarizeRainDays` excludes it from totals/RAINY DAYS/wettest-day, `DailyTooltip` renders "no data", and its bar is nulled out of the chart (Task 3/4, regression-tested). ✓

**Placeholder scan:** No TBD/TODO; all code complete; all commands have expected output. The only `<angle-bracket>` values are live credentials/EUIs in the optional post-deploy smoke (Step 5, environment-specific by nature, per credential policy never written into the repo). ✓

**Type consistency:** `RainDay { day, total_mm, samples }` is identical in helper output (Task 1), endpoint payload (Task 2), `utils/rain.ts` (Task 3), `sensorAPI.getDailyRainHistory` (Task 4), and both test files. `RainChartDay` (Task 4, `RainMonitor.tsx` only) is `RainDay` with `total_mm` widened to `number | null`, used solely as the `Bar` chart's local data shape so no-data days null out their bar — it never crosses a module boundary. `SensorHistoryPoint { t, value }` reused unchanged for intervals; `RainIntervalPoint` is a structural subset so `summarizeRainIntervals(intervalData)` typechecks. `tzOffsetMin` is "minutes east of UTC" at every layer (`localTzOffsetMinutes` ↔ `tz_offset_min` query ↔ SQLite `'N minutes'` modifier — behavior verified against sqlite3 CLI). ✓

**Gate coverage:** helper tests (Task 1/6), `verify-sync-flow.js` incl. profile parity + history API contract (Tasks 2/6), typecheck + unit tests + build (Tasks 3–6). Boot-DDL node, schema, and seed DBs untouched. ✓

## Notes / follow-ups (out of scope)

- Reuse `RainMonitor` from `LoRainGaugeCard` (`AQUASCOPE_LORAIN` shares `rain_mm_delta`) — small follow-up once this ships.
- Zone-level rain in the history card system (`rain_mm_delta` already a channel of the environment card) would need `sum` bucket statistics in `statsForValues` — deliberately not done here.
- The legacy `sensor-history` long-window `latest ?? mean` reduction also mis-serves `rain_mm_per_hour`/`flow_*` deltas for other cards; unchanged here, worth its own issue.
- i18n (#47): RainMonitor labels are English, consistent with WindMonitor/SensorMonitor; migrate together.
