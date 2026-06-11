# History Rollups + Nightly CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the `history_channel_rollups` cache nightly, serve long-range history from rollups + a live "today" bucket, export per-zone tidy CSV, and retrofit the legacy device-card history endpoints to consume the same aggregates.

**Architecture:** Edge-only. A nightly Node-RED inject calls a new `runRollupJob` in `osi-history-helper` that computes hourly/daily/weekly buckets per zone/card/source/channel (zone-local boundaries), upserts them into `history_channel_rollups`, and writes per-zone CSV files. The card-data read path (`aggregateDeviceData`) merges completed rollup buckets with a live trailing bucket. Legacy `sensor-history`/`dendro-history` map `deveui+field` to a rollup key and reuse the same read path, preserving their `[{t,value}]` contract.

**Tech Stack:** Node.js (Node-RED function nodes + `osi-history-helper` CommonJS module), SQLite (`/data/db/farming.db`), `fs` for CSV, `node:test`-style assertions in `scripts/test-history-helper.js` against in-memory SQLite seeded from `database/seed-blank.sql`.

---

## Source documents

- Spec: `docs/superpowers/specs/2026-06-02-history-rollups-and-csv-export-design.md`
- `AGENTS.md`, `RULES.yaml`

## Constraints

- Edge-only; no `osi-server`, no frontend, no MQTT/topic changes.
- Every change under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` mirrors byte-for-content to the `bcm27xx_bcm2709` path and must pass `node scripts/verify-sync-flow.js` (chains profile parity).
- Never replace `/data/db/farming.db`. The rollup table + UNIQUE index already exist (`idx_history_rollups_unique_bucket`) — no schema migration needed.
- Keep raw `device_data` forever (no pruning).

## Branch

```bash
cd /home/phil/Repos/osi-os
git status --short --branch
git switch -c feat/history-rollups-csv
```

## Common verification

```bash
cd /home/phil/Repos/osi-os
node scripts/test-history-helper.js
node scripts/verify-sync-flow.js
node scripts/verify-db-schema-consistency.js
```

## Helper facts (verified, for reference)

- Exports live at `osi-history-helper/index.js` `module.exports = { … }` (~line 1362).
- Reusable: `deriveCardsForZone(zone, devices)`, `aggregateRows(rows, options)`, `statsForValues(values)`, `normalizeTimezone(tz)`, `localDateKey(value, tz)`, `aggregateDeviceData(db, query)`.
- A card from `deriveCardsForZone` carries: `id` (cardId), `cardType`, `logicalSourceKey`, `sourceDevices` (with `deveui`, depth fields), `sourceDeviceCount`.
- `aggregateRows` buckets `device_data` rows into `{ buckets:[{bucketStart,bucketEnd,series:{channelId:{min,max,mean,median,latest,sampleCount,unit}},coveragePct,coverageConfidence}], … }`.
- Test harness: `createCliSqliteDb()` returns `{ runSql, all, close }` with the full schema loaded; `dbAll(db, sql, params)` is the helper's promisified query.

---

## Slice 1 — Zone-local day boundary + rollup compute/upsert

**Purpose:** Pure building blocks: a zone-local "start of today" helper, computing completed buckets for one scope/level, and an idempotent upsert.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`
- Modify: `scripts/test-history-helper.js`

### Task 1.1 — `startOfLocalDayMs`

- [ ] **Step 1: Add the test** to `scripts/test-history-helper.js`:

```js
test('startOfLocalDayMs returns the UTC instant of zone-local midnight', () => {
  // 2026-06-02T10:00:00Z is 12:00 local in Europe/Zurich (UTC+2) -> local midnight = 2026-06-01T22:00:00Z
  const ms = helper.startOfLocalDayMs(Date.parse('2026-06-02T10:00:00Z'), 'Europe/Zurich');
  assert.strictEqual(new Date(ms).toISOString(), '2026-06-01T22:00:00.000Z');
  // UTC zone -> midnight is 00:00Z
  const utc = helper.startOfLocalDayMs(Date.parse('2026-06-02T10:00:00Z'), 'UTC');
  assert.strictEqual(new Date(utc).toISOString(), '2026-06-02T00:00:00.000Z');
});
```

- [ ] **Step 2: Run, confirm fail.** `node scripts/test-history-helper.js` → FAIL (not a function).

- [ ] **Step 3: Implement** in `index.js` (near `localDateKey`):

```js
function startOfLocalDayMs(nowMs, timezone) {
  const tz = normalizeTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(nowMs)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  // local wall-clock now, in ms since epoch if it were UTC
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offsetMs = asUtc - nowMs;            // tz offset at this instant
  const localMidnightAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, 0, 0, 0);
  return localMidnightAsUtc - offsetMs;      // real UTC instant of local midnight
}
```

Add `startOfLocalDayMs` to `module.exports`. Apply the identical edit to the bcm2709 mirror.

- [ ] **Step 4: Run, confirm pass.** `node scripts/test-history-helper.js`.

- [ ] **Step 5: Commit.**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js scripts/test-history-helper.js
git commit -m "feat(history): add zone-local start-of-day helper"
```

### Task 1.2 — `computeRollupBuckets(db, scope, level, windowMs, nowMs)`

- [ ] **Step 1: Add the test** (insert two soil rows in one hour, request hourly):

```js
test('computeRollupBuckets returns completed buckets for a scope/level', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Z',1,'zu','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('AA01','Soil','KIWI_SENSOR',1,7,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA01','2026-06-01T08:10:00.000Z',10),
        ('AA01','2026-06-01T08:40:00.000Z',20);
    `);
    const scope = { zoneId: 7, cardType: 'soil', logicalSourceKey: 'root-zone',
      channels: [{ id: 'swt_1', field: 'swt_1', unit: 'kPa' }], deveuis: ['AA01'], timezone: 'UTC' };
    const nowMs = Date.parse('2026-06-02T00:00:00.000Z');
    const rows = await helper.computeRollupBuckets(db, scope, 'hourly', 24 * 3600 * 1000, nowMs);
    const hour = rows.find(r => r.channel_id === 'swt_1' && r.bucket_start === '2026-06-01T08:00:00.000Z');
    assert.ok(hour, 'has the 08:00 bucket');
    assert.strictEqual(hour.mean_value, 15);
    assert.strictEqual(hour.bucket_level, 'hourly');
    // no current-day partial buckets (nowMs day = 2026-06-02, none on that day here)
    assert.ok(rows.every(r => r.bucket_end <= new Date(helper.startOfLocalDayMs(nowMs,'UTC')).toISOString()));
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `computeRollupBuckets`:

```js
async function computeRollupBuckets(db, scope, level, windowMs, nowMs) {
  const todayStartMs = startOfLocalDayMs(nowMs, scope.timezone);
  const startMs = todayStartMs - windowMs;
  const start = new Date(startMs).toISOString();
  const end = new Date(todayStartMs).toISOString();              // only completed buckets
  const placeholders = scope.deveuis.map(() => '?').join(',');
  const fields = Array.from(new Set(scope.channels.map((c) => c.field)));
  const sql = `SELECT deveui, recorded_at, ${fields.join(', ')} FROM device_data
               WHERE deveui IN (${placeholders}) AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC`;
  const rows = await dbAll(db, sql, scope.deveuis.concat([start, end]));
  const agg = aggregateRows(rows, { aggregation: level, channels: scope.channels, start, end });
  const out = [];
  for (const bucket of agg.buckets || []) {
    for (const channel of scope.channels) {
      const stats = bucket.series[channel.id];
      if (!stats || stats.sampleCount === 0) continue;
      out.push({
        zone_id: scope.zoneId, card_type: scope.cardType, logical_source_key: scope.logicalSourceKey,
        channel_id: channel.id, bucket_level: level,
        bucket_start: bucket.bucketStart, bucket_end: bucket.bucketEnd,
        min_value: stats.min, max_value: stats.max, mean_value: stats.mean,
        median_value: stats.median, latest_value: stats.latest,
        dominant_status: stats.dominantStatus || null,
        coverage_pct: bucket.coveragePct ?? null, coverage_confidence: bucket.coverageConfidence || 'unknown',
        sample_count: stats.sampleCount, event_count: 0, threshold_crossing_count: 0,
        unit: channel.unit || stats.unit || null,
      });
    }
  }
  return out;
}
```

Export it; mirror to bcm2709.

- [ ] **Step 4: Run, confirm pass.**

### Task 1.3 — `upsertRollups(db, rows)` (idempotent)

- [ ] **Step 1: Add the test** (upsert twice, expect one row, updated value):

```js
test('upsertRollups is idempotent on the unique bucket key', async () => {
  const db = createCliSqliteDb();
  try {
    const base = { zone_id: 7, card_type: 'soil', logical_source_key: 'root-zone', channel_id: 'swt_1',
      bucket_level: 'hourly', bucket_start: '2026-06-01T08:00:00.000Z', bucket_end: '2026-06-01T09:00:00.000Z',
      min_value: 10, max_value: 20, mean_value: 15, median_value: 15, latest_value: 20,
      dominant_status: null, coverage_pct: 100, coverage_confidence: 'derived', sample_count: 2,
      event_count: 0, threshold_crossing_count: 0, unit: 'kPa' };
    await helper.upsertRollups(db, [base]);
    await helper.upsertRollups(db, [{ ...base, mean_value: 16, sample_count: 3 }]);
    const rows = await new Promise((res, rej) => db.all('SELECT mean_value, sample_count FROM history_channel_rollups', [], (e, r) => e ? rej(e) : res(r)));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].mean_value, 16);
    assert.strictEqual(rows[0].sample_count, 3);
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `upsertRollups` using `ON CONFLICT` on the existing unique index:

```js
async function upsertRollups(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const cols = ['zone_id','card_type','logical_source_key','channel_id','bucket_level','bucket_start','bucket_end',
    'min_value','max_value','mean_value','median_value','latest_value','dominant_status','coverage_pct',
    'coverage_confidence','sample_count','event_count','threshold_crossing_count','unit'];
  const updateCols = cols.filter((c) => !['zone_id','card_type','logical_source_key','channel_id','bucket_level','bucket_start'].includes(c));
  const sql = `INSERT INTO history_channel_rollups (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
    ON CONFLICT(zone_id,card_type,logical_source_key,channel_id,bucket_level,bucket_start)
    DO UPDATE SET ${updateCols.map((c) => `${c}=excluded.${c}`).join(', ')}`;
  for (const row of rows) {
    await new Promise((res, rej) => db.run(sql, cols.map((c) => row[c] ?? null), (e) => e ? rej(e) : res()));
  }
  return rows.length;
}
```

(Confirm the helper's db handle exposes `.run`; the Node-RED sqlite node and the CLI test db both do. If the CLI test db lacks `.run`, add a `runSql`-based shim in the test harness.)

- [ ] **Step 4: Run, confirm pass; commit Slice 1.**

```bash
git add conf/.../osi-history-helper/index.js (both) scripts/test-history-helper.js
git commit -m "feat(history): compute and upsert rollup buckets"
```

---

## Slice 2 — `runRollupJob` orchestrator

**Purpose:** Iterate all zones/cards/sources/channels and persist hourly/daily/weekly rollups.

**Files:** helper (both profiles), `scripts/test-history-helper.js`.

### Task 2.1 — `runRollupJob(db, options)`

- [ ] **Step 1: Add the test** (one zone, one soil device, 3 days of hourly data → rollups exist for daily + hourly):

```js
test('runRollupJob populates hourly and daily rollups for a zone', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Z',1,'zu','UTC','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('AA01','Soil','KIWI_SENSOR',1,7,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
    `);
    // hourly readings across 2 prior days
    let sql = '';
    for (let d = 1; d <= 2; d++) for (let h = 0; h < 24; h++) {
      const ts = `2026-06-0${d}T${String(h).padStart(2,'0')}:30:00.000Z`;
      sql += `INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES('AA01','${ts}',${10 + h});\n`;
    }
    db.runSql(sql);
    const summary = await helper.runRollupJob(db, { nowMs: Date.parse('2026-06-03T02:00:00.000Z') });
    assert.ok(summary.bucketsUpserted > 0);
    const daily = await new Promise((res, rej) => db.all("SELECT * FROM history_channel_rollups WHERE bucket_level='daily'", [], (e, r) => e ? rej(e) : res(r)));
    assert.ok(daily.length >= 2, 'has daily buckets for the two days');
    const hourly = await new Promise((res, rej) => db.all("SELECT * FROM history_channel_rollups WHERE bucket_level='hourly'", [], (e, r) => e ? rej(e) : res(r)));
    assert.ok(hourly.length >= 24);
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `runRollupJob`:

```js
const ROLLUP_WINDOWS = { hourly: 8 * 24 * 3600 * 1000, daily: 120 * 24 * 3600 * 1000, weekly: 370 * 24 * 3600 * 1000 };

async function runRollupJob(db, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const zones = await dbAll(db, 'SELECT id, name, zone_uuid, timezone FROM irrigation_zones WHERE deleted_at IS NULL', []);
  let bucketsUpserted = 0; const errors = [];
  for (const zone of zones) {
    try {
      const devices = await dbAll(db, 'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ?', [zone.id]);
      const cards = deriveCardsForZone(zone, devices);
      for (const card of cards) {
        if (card.cardType === 'gateway') continue;
        const channels = channelsForCard(card);                 // existing channel mapping per card type
        const deveuis = uniqueDeveuis(card.sourceDevices || []);
        if (deveuis.length === 0 || channels.length === 0) continue;
        const scope = { zoneId: zone.id, cardType: card.cardType, logicalSourceKey: card.logicalSourceKey,
          channels, deveuis, timezone: zone.timezone || 'UTC' };
        for (const level of ['hourly', 'daily', 'weekly']) {
          const rows = await computeRollupBuckets(db, scope, level, ROLLUP_WINDOWS[level], nowMs);
          bucketsUpserted += await upsertRollups(db, rows);
        }
      }
    } catch (err) { errors.push({ zoneId: zone.id, message: String(err && err.message || err) }); }
  }
  return { zones: zones.length, bucketsUpserted, errors };
}
```

Reuse existing `channelsForCard`/channel-group helpers and `uniqueDeveuis` (confirm exact names with `grep -n "channelsForCard\|uniqueDeveuis\|channelGroupsFor" index.js`; adapt to the real symbols). Export `runRollupJob`; mirror to bcm2709.

- [ ] **Step 4: Run, confirm pass; commit.**

```bash
git add conf/.../osi-history-helper/index.js (both) scripts/test-history-helper.js
git commit -m "feat(history): nightly rollup job orchestrator"
```

---

## Slice 3 — Hybrid read (rollups + live trailing bucket)

**Purpose:** Replace the all-or-nothing rollup read in `aggregateDeviceData` with a per-bucket merge so completed buckets come from rollups and today comes live.

**Files:** helper (both profiles), `scripts/test-history-helper.js`.

### Task 3.1 — merge read

- [ ] **Step 1: Add the test** (daily rollup for yesterday + raw rows for today → merged result has both, tagged `rollups+live`):

```js
test('aggregateDeviceData merges completed rollups with a live trailing bucket', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO history_channel_rollups (zone_id,card_type,logical_source_key,channel_id,bucket_level,bucket_start,bucket_end,mean_value,latest_value,min_value,max_value,median_value,sample_count,coverage_confidence,unit)
      VALUES (7,'soil','root-zone','swt_1','daily','2026-06-01T00:00:00.000Z','2026-06-02T00:00:00.000Z',30,30,28,32,30,12,'derived','kPa');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES ('AA01','2026-06-02T09:00:00.000Z',40);
    `);
    const result = await helper.aggregateDeviceData(db, {
      zoneId: 7, cardType: 'soil', logicalSourceKey: 'root-zone', device_euis: ['AA01'],
      start: '2026-06-01T00:00:00.000Z', end: '2026-06-03T00:00:00.000Z', range: '30d',
      aggregation: 'daily', channels: ['swt_1'], timezone: 'UTC', nowMs: Date.parse('2026-06-02T12:00:00.000Z'),
    });
    assert.strictEqual(result.source, 'rollups+live');
    const days = result.buckets.map(b => b.bucketStart);
    assert.ok(days.includes('2026-06-01T00:00:00.000Z'), 'rollup day present');
    assert.ok(days.includes('2026-06-02T00:00:00.000Z'), 'live today present');
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Edit `aggregateDeviceData`** — replace the current `if (shouldUseRollups) { … }` block with a split-and-merge:

```js
if (shouldUseRollups) {
  const nowMs = query.nowMs ?? Date.now();
  const todayStartIso = new Date(startOfLocalDayMs(nowMs, query.timezone || 'UTC')).toISOString();
  const splitIso = todayStartIso < start ? start : (todayStartIso > end ? end : todayStartIso);
  const channelIds = channels.map((c) => c.id);
  const ph = channelIds.map(() => '?').join(',');
  const rollupRows = await dbAll(db,
    `SELECT * FROM history_channel_rollups WHERE zone_id=? AND card_type=? AND logical_source_key=? AND bucket_level=? AND bucket_start>=? AND bucket_start<? AND channel_id IN (${ph}) ORDER BY bucket_start ASC, channel_id ASC`,
    [zoneId, cardType, logicalSourceKey, aggregation, start, splitIso].concat(channelIds));
  const completed = rollupRowsToResult(rollupRows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested }, channels);
  let merged = completed;
  if (splitIso < end && deveuis.length > 0) {
    const liveRows = await dbAll(db,
      `SELECT deveui, recorded_at, ${Array.from(new Set(channels.map((c) => c.field))).join(', ')} FROM device_data WHERE deveui IN (${deveuis.map(() => '?').join(',')}) AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at ASC`,
      deveuis.concat([splitIso, end]));
    const live = aggregateRows(liveRows, { ...query, aggregation, aggregationRequested: aggregationInfo.requested, channels, start: splitIso, end });
    merged = {
      ...completed,
      buckets: [...(completed.buckets || []), ...(live.buckets || [])],
      source: rollupRows.length ? 'rollups+live' : 'device_data',
    };
  } else {
    merged = { ...completed, source: rollupRows.length ? 'rollups' : 'device_data' };
  }
  if (merged.buckets && merged.buckets.length) return merged;
  // else fall through to full live below
}
```

Keep the existing full-live path below as the final fallback (when no rollups and no identity). Mirror to bcm2709.

- [ ] **Step 4: Run, confirm pass; also run the existing fallback test to ensure no regression; commit.**

```bash
node scripts/test-history-helper.js
git add conf/.../osi-history-helper/index.js (both) scripts/test-history-helper.js
git commit -m "feat(history): hybrid rollup + live trailing-bucket read"
```

---

## Slice 4 — Per-zone tidy CSV export

**Purpose:** Write raw/hourly/daily CSV in long/tidy format and rotate.

**Files:** helper (both profiles), `scripts/test-history-helper.js`.

### Task 4.1 — `toCsv(rows, columns)` and `writeZoneCsv`

- [ ] **Step 1: Add the test** (write to a tmp dir, read back, assert tidy header + a soil row with depth):

```js
test('writeZoneCsv emits tidy long-format raw and daily files with depth', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-csv-'));
  const zone = { id: 7, name: 'Zone B', zone_uuid: 'zu', timezone: 'Europe/Zurich' };
  const rawRows = [{ timestamp: '2026-06-02T14:03:21.000Z', source: 'Chameleon 1', card: 'soil', variable: 'swt_1', depth_cm: 5, value: 6.24, unit: 'kPa' }];
  const dailyRows = [{ bucket_start: '2026-06-02T00:00:00.000Z', bucket_end: '2026-06-03T00:00:00.000Z', source: 'Chameleon 1', card: 'soil', variable: 'swt_1', depth_cm: 5, unit: 'kPa', n: 96, coverage_pct: 100, mean: 6.3, min: 6.1, max: 6.5, median: 6.3, latest: 6.24 }];
  await helper.writeZoneCsv({ exportDir: dir, zone, day: '2026-06-02', rawRows, dailyRows });
  const raw = fs.readFileSync(path.join(dir, 'zu', 'raw', '2026-06-02.csv'), 'utf8').trim().split('\n');
  assert.strictEqual(raw[0], 'timestamp,timezone,zone,card,source,variable,depth_cm,value,unit');
  assert.match(raw[1], /Europe\/Zurich,Zone B,soil,Chameleon 1,swt_1,5,6.24,kPa/);
  const daily = fs.readFileSync(path.join(dir, 'zu', 'daily.csv'), 'utf8').trim().split('\n');
  assert.strictEqual(daily[0], 'bucket_start,bucket_end,timezone,zone,card,source,variable,depth_cm,unit,n,coverage_pct,mean,min,max,median,latest');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** a minimal RFC-4180 serializer + writers:

```js
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(columns, rows) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}
const RAW_COLS = ['timestamp','timezone','zone','card','source','variable','depth_cm','value','unit'];
const AGG_COLS = ['bucket_start','bucket_end','timezone','zone','card','source','variable','depth_cm','unit','n','coverage_pct','mean','min','max','median','latest'];

async function writeZoneCsv({ exportDir, zone, day, rawRows = [], hourlyRows = [], dailyRows = [] }) {
  const fs = require('fs'); const path = require('path');
  const base = path.join(exportDir, zone.zone_uuid);
  const tz = normalizeTimezone(zone.timezone);
  const stamp = (r) => ({ ...r, timezone: tz, zone: zone.name });
  fs.mkdirSync(path.join(base, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(base, 'hourly'), { recursive: true });
  fs.writeFileSync(path.join(base, 'raw', `${day}.csv`), toCsv(RAW_COLS, rawRows.map(stamp)));
  fs.writeFileSync(path.join(base, 'hourly', `${day}.csv`), toCsv(AGG_COLS, hourlyRows.map(stamp)));
  // idempotent daily append: drop existing rows for `day`, then append
  const dailyPath = path.join(base, 'daily.csv');
  const newDaily = dailyRows.map(stamp);
  let kept = [];
  if (fs.existsSync(dailyPath)) {
    const lines = fs.readFileSync(dailyPath, 'utf8').trim().split('\n');
    kept = lines.slice(1).filter((l) => l && !l.startsWith(`${day}`));   // bucket_start begins with the day
  }
  const body = [AGG_COLS.join(','), ...kept, ...newDaily.map((r) => AGG_COLS.map((c) => csvCell(r[c])).join(','))];
  fs.writeFileSync(dailyPath, body.join('\n') + '\n');
}
```

Export `writeZoneCsv` (and `toCsv` for tests). Mirror to bcm2709.

- [ ] **Step 4: Run, confirm pass.**

### Task 4.2 — `rotateZoneCsv` + wire CSV into `runRollupJob`

- [ ] **Step 1: Add a rotation test** (create old + new files, rotate with 90-day window, assert old raw/hourly deleted, daily kept).

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `rotateZoneCsv({ exportDir, zone, nowMs, retentionDays })` deleting `raw/*.csv` and `hourly/*.csv` whose date in the filename is older than `nowMs - retentionDays`; leave `daily.csv`. Then extend `runRollupJob` to also gather raw + hourly + daily rows for the just-completed day per zone, call `writeZoneCsv`, then `rotateZoneCsv`, using `options.exportDir` (default `/data/exports`) and `options.retentionDays` (default `Number(env HISTORY_CSV_RAW_RETENTION_DAYS) || 90`). The `depth_cm` per soil channel comes from the source device fields (`chameleon_swt1_depth_cm`/`swt2`/`swt3`, kiwi depths); `source` is the display-safe name; `card` is `cardType`; `variable` is `channel.id`.

- [ ] **Step 4: Run, confirm pass; commit Slice 4.**

```bash
git add conf/.../osi-history-helper/index.js (both) scripts/test-history-helper.js
git commit -m "feat(history): per-zone tidy CSV export with rotation"
```

---

## Slice 5 — Nightly tick + manual run endpoint (flows)

**Purpose:** Schedule the job nightly and allow a manual trigger for verification.

**Files:** `flows.json` (both profiles), `scripts/verify-sync-flow.js`.

### Task 5.1 — inject + function node

- [ ] **Step 1: Add a verifier assertion** to `scripts/verify-sync-flow.js`:

```js
expectIncludes('History Rollup Tick', 'osiHistory.runRollupJob', 'nightly rollup tick calls the helper job');
```

(Use the existing `expectIncludes(nodeName, snippet, description)` pattern.)

- [ ] **Step 2: Run, confirm fail.** `node scripts/verify-sync-flow.js`.

- [ ] **Step 3: Add nodes** to `flows.json` (bcm2712), mirrored to bcm2709:
  - An `inject` node "History Rollup Schedule" with `crontab: "0 2 * * *"`.
  - A `function` node "History Rollup Tick" that opens the DB and calls the helper:

```js
const osiHistory = global.get('osiHistory');           // or require path used by other history nodes
const db = global.get('historyDb') /* existing sqlite handle pattern */;
const summary = await osiHistory.runRollupJob(db, { exportDir: '/data/exports' });
node.log('history rollup: ' + JSON.stringify(summary));
return null;
```

  Wire `inject -> function`. Follow the exact DB-handle acquisition the other history function nodes use (check `History API Router`).
  - Add an authenticated `http in` `POST /api/history/rollups/run` → the same function (manual trigger) for verification, gated by the existing JWT middleware pattern.

- [ ] **Step 4: Mirror to bcm2709; run verification.**

```bash
node scripts/verify-sync-flow.js && scripts/check-mqtt-topics.sh
```

- [ ] **Step 5: Commit.**

```bash
git add conf/.../flows.json (both) scripts/verify-sync-flow.js
git commit -m "feat(history): schedule nightly rollup tick + manual run endpoint"
```

---

## Slice 6 — Legacy device-card endpoints consume rollups

**Purpose:** Map `deveui+field` to a rollup key and serve aggregated points for long ranges, preserving `[{t,value}]`.

**Files:** helper (both profiles), `flows.json` legacy `sensor-history`/`dendro-history` nodes (both profiles), `scripts/test-history-helper.js`.

### Task 6.1 — `resolveDeviceFieldRollupKey`

- [ ] **Step 1: Add the test** (a soil device + field `swt_1` resolves to its zone/card/source/channel):

```js
test('resolveDeviceFieldRollupKey maps a device field to a rollup scope', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(7,'Z',1,'zu','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('AA01','Soil','KIWI_SENSOR',1,7,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
    `);
    const key = await helper.resolveDeviceFieldRollupKey(db, 'AA01', 'swt_1');
    assert.strictEqual(key.zoneId, 7);
    assert.strictEqual(key.cardType, 'soil');
    assert.strictEqual(key.channelId, 'swt_1');
    assert.ok(Array.isArray(key.deveuis) && key.deveuis.includes('AA01'));
    assert.strictEqual(key.timezone, 'UTC');
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `resolveDeviceFieldRollupKey(db, deveui, field)`: load the device + its zone, `deriveCardsForZone`, pick the card whose channels include `field` and whose sources include `deveui`, return `{ zoneId, cardType, logicalSourceKey, channelId: field, deveuis, timezone }`, or `null` if unmappable. Export; mirror.

- [ ] **Step 4: Run, confirm pass.**

### Task 6.2 — reroute legacy endpoints

- [ ] **Step 1: Add a helper test** `legacySensorHistory(db, { deveui, field, hours, nowMs })` returns `[{t,value}]`: raw for `hours<=24`, daily-ish aggregated for `hours=720`, value = `latest ?? mean`:

```js
test('legacySensorHistory returns aggregated points beyond 24h in {t,value} shape', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`... zone 7, device AA01, history_channel_rollups daily row for swt_1 ...`);
    const points = await helper.legacySensorHistory(db, { deveui: 'AA01', field: 'swt_1', hours: 720, nowMs: Date.parse('2026-06-03T00:00:00.000Z') });
    assert.ok(points.length > 0);
    assert.ok('t' in points[0] && 'value' in points[0]);
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `legacySensorHistory`: resolve the key; compute `start/end` from `hours`; call `aggregateDeviceData` with the resolved identity + duration→level; flatten buckets/series for the single channel to `[{ t: bucketStart||recordedAt, value: latest ?? mean ?? value }]`; if the key is null, fall back to the existing raw query. Export; mirror.

- [ ] **Step 4: Reroute the `sensor-history` and `dendro-history` function nodes** in `flows.json` (both profiles) to call `osiHistory.legacySensorHistory(...)` and return its array unchanged. Add a `verify-sync-flow` assertion that the `sensor-history` node references `legacySensorHistory`.

- [ ] **Step 5: Run all verification; commit Slice 6.**

```bash
node scripts/test-history-helper.js && node scripts/verify-sync-flow.js
git add conf/.../osi-history-helper/index.js (both) conf/.../flows.json (both) scripts/test-history-helper.js scripts/verify-sync-flow.js
git commit -m "feat(history): legacy device-card history consumes rollups"
```

---

## Slice 7 — Live verification on kaba100

**Purpose:** Prove it works end-to-end on real data and measure the job cost.

**Files:** `docs/ux/history-data-visualization-kaba100-issues.md` (append results).

- [ ] **Step 1: Deploy** helper + flows to kaba100 (tar-pipe to `/usr/share/node-red/` paths actually used at runtime — confirm the runtime path; the GUI deploy pattern is separate). Restart Node-RED. Never overwrite `/data/db/farming.db`.
- [ ] **Step 2: Trigger** `POST /api/history/rollups/run` (auth) or wait for the tick; time it. Then:

```bash
ssh root@100.93.68.86 "sqlite3 /data/db/farming.db 'SELECT bucket_level, COUNT(*) FROM history_channel_rollups GROUP BY bucket_level;'"
ssh root@100.93.68.86 "ls -R /data/exports | head -40"
```

  Confirm hourly/daily/weekly rows exist and `/data/exports/<zoneUuid>/{raw,hourly}/<date>.csv` + `daily.csv` are present and tidy.
- [ ] **Step 3: Verify reads:** a 30D card-data request returns `source: rollups+live`; a fresh reading today still appears (live trailing bucket); `sensor-history?field=swt_1&hours=720` returns aggregated points and `hours=24` returns raw; the legacy device-card modal renders unchanged.
- [ ] **Step 4: Record** counts, job duration, and a sample CSV in the issues doc; final `node scripts/test-history-helper.js && node scripts/verify-sync-flow.js`.

```bash
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(history): record rollups + CSV export verification"
```

---

## Self-review (coverage map)

- Persist rollups nightly (spec §1.1, §4.2) → Slices 1–2, 5.
- Hybrid read keeps today fresh (§1.2, §4.3) → Slice 3.
- Tidy/long CSV with depth + R conventions (§4.4) → Slice 4.
- Rotation + serving (§4.4.2) → Slice 4 (rotation) + Slice 5 (manual endpoint; download serving via existing pattern noted).
- Legacy endpoints consume rollups, unchanged contract (§4.5) → Slice 6.
- Zone-local boundaries (§4.2) → Task 1.1 + used throughout.
- No schema migration (unique index exists) → confirmed; no migration task.
- Profile parity, offline-first, never replace DB (§6) → mirror steps + verify-sync-flow each slice.
- Verification (§8) → per-slice helper tests + Slice 7 live.

## Acceptance criteria

- `runRollupJob` populates hourly/daily/weekly rollups idempotently, zone-local, completed buckets only.
- 7d/30d/Season card-data reads return `rollups+live` (or `rollups`/`device_data`) and include today.
- Per-zone tidy CSV (`raw/`, `hourly/`, `daily.csv`) with the exact §4.4 columns, depth on soil rows, 90-day rotation of raw/hourly.
- Legacy `sensor-history`/`dendro-history` return aggregated points beyond 24h and raw within, in the unchanged `[{t,value}]` shape; unmapped device/field falls back to raw.
- `node scripts/test-history-helper.js`, `node scripts/verify-sync-flow.js`, `node scripts/verify-db-schema-consistency.js` all pass; profile parity holds; live kaba100 verified.
