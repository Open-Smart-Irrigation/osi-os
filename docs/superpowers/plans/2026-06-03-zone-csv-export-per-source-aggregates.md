# Zone CSV Export — Per-Source Aggregates Enhancement

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Make the hourly/daily zone CSV export aggregate **per physical source device** (correct `source` + `depth_cm`), instead of reading the merged-card rollup which blends multiple sensors into `source="2 sources"` with blank depth.

**Architecture:** Change one helper function, `aggregateZoneExportRows`, to loop over each source device (like the existing `rawZoneExportRows` does) and aggregate that single device live via `aggregateDeviceData` with the source-filter flag (which bypasses the merged rollup). Raw export and the endpoint are unchanged.

**Tech Stack:** `osi-history-helper` (CommonJS), tested via `scripts/test-history-helper.js` against in-memory SQLite.

---

## Branch

Enhance the existing export branch:

```bash
cd /home/phil/Repos/osi-os
git switch feat/zone-csv-range-export
```

## Constraints

- Edge-only; mirror the helper change to the `bcm2709` profile; `node scripts/verify-sync-flow.js` must pass (profile parity).
- No raw DevEUI in output. Never replace `/data/db/farming.db`.
- Keep the range guard, raw export, endpoint, and frontend exactly as they are.

## Context (verified in the current branch)

- `rawZoneExportRows` already loops per source device: `sourceDevicesForCard(card, devices)` → `displayDeviceName(device, index)` for `source`, `soilDepthCm(device, channel.id)` for `depth_cm`.
- `aggregateZoneExportRows` currently does ONE merged call: `aggregateDeviceData({ device_euis: allDeveuis, logicalSourceKey, ... })`, then `exportSourceName(sourceDevices)` (= "2 sources") and `depthDevice = sourceDevices.length === 1 ? sourceDevices[0] : {}` (blank depth for multi).
- `aggregateDeviceData` skips the merged rollup when the source filter is active: `shouldUseRollups = !hasSourceFilter && …`. Passing `sourceFilterActive: true` forces per-device live aggregation.
- `csvRowsFromAggregate(aggregate, card, depthDevice, sourceName, channels)` already maps buckets → `AGG_CSV_COLUMNS` rows using `depthDevice` for `depth_cm` and `sourceName` for `source`.

---

## Task 1 — per-source aggregate export

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`
- Modify: `scripts/test-history-helper.js`

- [ ] **Step 1: Update the existing daily test** ("buildZoneExportCsv daily uses completed rollups plus today live") and add a multi-source assertion. Seed a Zone with **two** soil devices in one zone (a merged soil card), give each device distinct `swt_1` depths and values, then assert the daily export has **one row per (device, channel, bucket)** with the device's name and depth — and **no** `source === '2 sources'` and **no blank `depth_cm`** on soil rows:

```js
test('buildZoneExportCsv aggregate keeps per-source rows with depth for merged cards', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_swt1_depth_cm,created_at,updated_at) VALUES
        ('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z'),
        ('AA00000000000002','Chameleon 2','DRAGINO_LSN50',1,12,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.0),
        ('AA00000000000001','2026-06-01T09:00:00.000Z',6.4),
        ('AA00000000000002','2026-06-01T08:00:00.000Z',7.0),
        ('AA00000000000002','2026-06-01T09:00:00.000Z',7.4);
    `);
    const res = await helper.buildZoneExportCsv(db, { zoneId: 12, from: '2026-06-01', to: '2026-06-01', granularity: 'daily', nowMs: Date.parse('2026-06-03T00:00:00.000Z') });
    const swt1Rows = res.rows.filter((r) => r.variable === 'swt_1');
    const sources = new Set(swt1Rows.map((r) => r.source));
    assert.ok(sources.has('Chameleon 1') && sources.has('Chameleon 2'), 'both sources present');
    assert.ok(!sources.has('2 sources'), 'no blended source label');
    assert.ok(swt1Rows.every((r) => r.depth_cm === 5), 'each source row carries its depth');
    const c1 = swt1Rows.find((r) => r.source === 'Chameleon 1');
    assert.strictEqual(c1.mean, 6.2);   // (6.0 + 6.4) / 2, per device
  } finally { db.close(); }
});
```

(Confirm the soil depth column name with `grep -n "soilDepthCm\|chameleon_swt1_depth_cm\|swt1_depth" index.js` and match the seed insert to it.)

- [ ] **Step 2: Run, confirm fail.** `node scripts/test-history-helper.js` → the new test fails (current code emits `source: '2 sources'`, blank depth, blended mean).

- [ ] **Step 3: Rewrite `aggregateZoneExportRows`** to loop per source device. Replace the single merged `aggregateDeviceData` call with:

```js
async function aggregateZoneExportRows(db, scope) {
  const rows = [];
  const zoneName = String(scope.zone.name || scope.zone.zone_uuid || scope.zone.id);
  for (const card of scope.cards) {
    const channels = channelsForCard(card);
    const sourceDevices = sourceDevicesForCard(card, scope.devices)
      .slice()
      .sort((left, right) =>
        String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || '')));
    if (!channels.length || !sourceDevices.length) continue;

    let index = 0;
    for (const device of sourceDevices) {
      const deveui = normalizeDeveui(device.deveui || device.device_eui);
      const sourceName = displayDeviceName(device, index);
      index += 1;
      if (!deveui) continue;
      const aggregate = await aggregateDeviceData(db, {
        zoneId: scope.zone.id,
        cardType: card.cardType,
        logicalSourceKey: card.logicalSourceKey,
        device_euis: [deveui],
        sourceFilterActive: true,            // force per-source live aggregation (bypass merged rollup)
        start: scope.start,
        end: scope.end,
        aggregation: scope.granularity,
        channels,
        timezone: scope.timezone,
        nowMs: scope.nowMs,
      });
      rows.push(...csvRowsFromAggregate(aggregate, card, device, sourceName, channels).map((row) => ({
        ...row,
        timezone: scope.timezone,
        zone: zoneName,
      })));
    }
  }
  rows.sort((left, right) => String(left.bucket_start).localeCompare(String(right.bucket_start))
    || String(left.card).localeCompare(String(right.card))
    || String(left.source).localeCompare(String(right.source))
    || String(left.variable).localeCompare(String(right.variable)));
  return rows;
}
```

- [ ] **Step 4: Mirror the edit to the bcm2709 helper** (byte-for-content).

- [ ] **Step 5: Run, confirm pass + no regressions + parity.**

```bash
node scripts/test-history-helper.js
node scripts/verify-sync-flow.js
diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js && echo PARITY
```

Expected: all helper tests pass (including the new per-source one); verify-sync-flow OK; helpers identical.

- [ ] **Step 6: Commit.**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js scripts/test-history-helper.js
git commit -m "feat(export): aggregate zone CSV per source device with correct depth"
```

(If `exportSourceName` is now unused, remove it to avoid dead code.)

---

## Task 2 — live verification

- [ ] **Step 1: Deploy** the updated helper to `/srv/node-red/osi-history-helper/index.js` on kaba100 (`ssh "cat > …"`; never touch `/data/db/farming.db`); restart Node-RED (`/etc/init.d/node-red restart`); confirm HTTP 200 on `/gui/`.
- [ ] **Step 2: Verify** (temp user as in prior rounds; **restore after**): `GET /api/history/zones/12/export.csv?from=2026-06-01&to=2026-06-02&granularity=daily` → the CSV has **separate `Chameleon 1` and `Chameleon 2`** rows per `variable`, each with a numeric `depth_cm`, and **no `2 sources`** row and **no blank depth** on soil rows. Raw export still per-source. Range guard + headers unchanged.
- [ ] **Step 3: Record** a sample of the per-source daily rows in `docs/ux/history-data-visualization-kaba100-issues.md`; final `node scripts/test-history-helper.js && node scripts/verify-sync-flow.js`.

```bash
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(export): record per-source aggregate export verification"
```

## Acceptance criteria

- Hourly/daily zone CSV exports emit one row per (physical source device, channel, bucket) with the device's display-safe `source` and its own `depth_cm`; merged-card zones no longer produce `source="2 sources"` or blank soil depth.
- Raw export, range guard, endpoint, and frontend unchanged; all helper tests + `verify-sync-flow` pass; profile parity holds; live kaba100 confirms per-source daily rows.
