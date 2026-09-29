# Weather in the Data View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Data tab lists, under each located zone, the stored provider hours, the hourly record of each assigned S2120 and the daily agronomy record beside the device sources, with period totals summed over zone-local days and marked when rows are missing; each zone gets a weather provider selector whose value the edge stores, emits to the cloud and accepts from both cloud command paths.

**Architecture:** `osi-history-helper/analysis.js` gains a `SOURCE_KINDS` table; the catalogue appends provider, station and daily agronomy entries per zone, and series resolution groups selections by kind and owner, turns rows into points up to a kind's native step and aggregates above it with a new `sum` statistic in `aggregateRows`. The zone's `weather_source` travels through migration 0063 (the boot-owned zone update trigger, changed in `scripts/sync-trigger-source.json` and rendered into `sync-init-fn` by the generator), the zone write route and list, both snapshot builders, the capability `zone_config_weather_source_v1`, the legacy "Build UPDATE SQL" node and `osi-zone-commands`. The GUI changes the tray label, the metric preset, the aggregation badge, the chart symbols and tooltip, the CSV date and the zone settings modal.

**Tech Stack:** Node.js 22 (`node:test`, `node:sqlite`), SQLite through the `osi-db-helper` facade, Node-RED function nodes edited by one-shot scripts, React + TypeScript + vitest + ECharts 5 + i18next (seven locales), JSON Schema draft-07 for the sync contract, Java/Gradle and vitest on the paired osi-server branch.

**Spec:** `docs/superpowers/specs/2026-09-27-weather-data-view-design.md`

> **Note.** This plan is the task brief as executed. The final review changed
> the `weather_source` payload rule after this plan was written: the key is
> omitted unless the stored value is not `auto`, or it changed in this
> update. The spec and the execution report describe that final behavior.

## Global Constraints

From the spec, verbatim:

- flows.json is edited only by a one-shot script that runs the roundtrip guard, writes both profiles, and leaves them byte-identical; the `sync-init-fn` region is written only by `generate-sync-trigger-source.js --write`.
- Schema changes only through ordered migrations; `sync-init-fn` stays frozen (its trigger text moves only through the canonical source); seeds are rebuilt by `build-seed-db.js`, never hand-copied.
- No GUI build on the workstation (it runs out of memory); `npm run typecheck` and `npm run test:unit` only.
- Tooltips only; seven locales, `lg` in English, keys listed in the locale tests and the Luganda document.
- The size ratchet carries exact measured allowances and the identity pins move with them.
- No new helper module, so the helper registration surfaces (package.json `file:` deps, lock file, seed copy loop, `deploy.sh` fetch lines, osi-lib registry) do not change; `verify-helper-registration.js` stays green. `osi-history-helper` requiring its sibling `../osi-weather-provider` resolves on the gateway (`/srv/node-red/<name>`, `deploy.sh` lines 1402–1452) and in the repo; `osi-weather-provider` requires nothing, so there is no cycle.
- No flow node gains an `osiLib.require` of a db-shaped module, so the caller-binding policies in `verify-osi-lib-db-caller-binding.js` do not change.
- Every file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` that changes is mirrored byte for byte under `bcm2709`.

Operational rules for this plan:

- Work only in the worktree `<osi-os>/.worktrees/weather-data-view` (branch `feat/weather-data-view`, stacked on `feat/daily-agronomy` @ `8531f1dd1`); every command below runs from its root unless a step says otherwise. Never `cd` into `<osi-os>`. Never bare `git stash`. Never push.
- The long suites (Task 5 Step 9 and Task 9 Step 3: `lib/osi-migrate/__tests__`, `reconcile-ledger-numbering.test.js`) write large temporary databases. `/tmp` is a 12 G tmpfs that other sessions fill (98 % during the plan review), so run them with `TMPDIR` on disk: `export TMPDIR=/var/tmp/osi-weather-data-view && mkdir -p "$TMPDIR"` in the same shell, and check `df -h "$TMPDIR"` first. An `ENOSPC` from a migration test is a disk problem, not a red gate.
- Task 10 is the only task that writes to osi-server, and only in `<osi-server>/.worktrees/weather-data-view`. Every other task reads osi-server with `git -C <osi-server> show origin/main:<path>` at most.
- `$SCRATCH` is the session scratchpad directory. One-shot scripts live there and are never committed.
- Commits use `git -c user.name=Project-OSI commit`.
- The deploy order in the spec ("Ownership and deploy order") binds the rollout, not this plan: nothing here deploys to a gateway.

## Review Focus

1. **The two clock-change days of a Zurich zone.** A daily provider total on 29 March 2026 (23 hours) is marked partial, and one on 25 October 2026 (25 hours) counts 25 of 24 without a mark, as the spec decides. Pinned in Task 3 ("the 23-hour spring day is marked partial and the 25-hour autumn day is not").
2. **A provider change after a view was saved.** The old provider series disappear from the view and are reported in `droppedSeriesIds`; device series stay. Pinned in Task 3 ("a saved view reports the provider series a provider change dropped").
3. **A zone timezone Intl does not know** (hand-edited or legacy value). Daily points, daily buckets and the CSV date fall back to UTC instead of throwing. Pinned in Task 3 ("an invalid zone timezone places daily points at UTC midnight") and Task 4 (the CSV test's `Not/AZone` case).
4. **Coordinates south of the equator or west of Greenwich** (the Uganda gateway sits near the equator). The provider source name prints the absolute value with `S` or `W`. Pinned in Task 3 ("a provider source south and west of zero names its hemispheres").
5. **A MeteoSwiss station re-resolved, and a zone with a blank name.** The series ids stay, the group takes the new station's name, and a blank zone name gives `Zone <id> daily agronomy`. Pinned in Task 3 ("a re-resolved MeteoSwiss station keeps the series ids and shows the new station").

## File Map

| File | Change | Task |
|---|---|---|
| `web/react-gui/src/channels/channels.json`, `docs/channel-manifest.md` | three channels, new SHA-256 | 1 |
| `web/react-gui/src/channels/registry.ts`, `src/channels/__tests__/registry.test.ts` | card channel lists skip a channel with neither an edge nor a server column | 1 |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js` | `CHANNELS`, `DEVICE_EXCLUDED_CHANNELS` (1); `SOURCE_KINDS`, catalogue, series (3) | 1, 3 |
| `.../osi-history-helper/index.js` | `VALID_EXPORT_CHANNEL_KEYS` (1); `sum` (2); deps (3) | 1, 2, 3 |
| `.../osi-history-helper/__fixtures__/weather-catalog.sql`, `analysis-device-catalog.json` | test fixture and pre-change device snapshot | 1 |
| `.../osi-history-helper/analysis.test.js`, `index.test.js` | tests | 1, 2, 3 |
| `scripts/test-history-helper.js`, `scripts/test-scoped-access-reads.js` | catalogue assertions | 3 |
| `web/react-gui/src/analysis/*`, `src/components/analysis/*`, `src/pages/CrossZoneAnalysisPage.tsx`, `public/locales/*/common.json` | analysis page | 4 |
| `scripts/sync-trigger-source.json`, `database/migrations/ordered/0063__zone_weather_source_sync.sql`, `database/seed-blank.sql`, seven bundled DBs, `CHECKSUMS.json` | zone trigger | 5 |
| `scripts/test-zone-weather-source.js` (new), `.github/workflows/verify-sync-flow.yml` | round-trip tests | 5, 6, 7 |
| both `flows.json` | `sync-init-fn` (5); zone route, list, snapshots, capability (6); "Build UPDATE SQL" (7) | 5, 6, 7 |
| `.../osi-zone-commands/index.js`, `scripts/test-zone-command-path.js` | protected path | 7 |
| `docs/contracts/sync-schema/resources.schema.json`, `scripts/test-contract-schemas.js` | contract | 7 |
| `web/react-gui/src/components/farming/ZoneConfigModal.tsx`, `src/types/farming.ts`, `src/services/api.ts`, `public/locales/*/devices.json` | zone selector | 8 |
| `AGENTS.md`, `docs/contracts/sync-schema/README.md`, `docs/i18n/pending-luganda-translations.md`, execution report | docs | 4, 8, 9 |
| osi-server `feat/weather-data-view`: both `channels.json`, three SHA pins, `docs/channel-manifest.md`, vendored `resources.schema.json`; `frontend/src/channels/registry.ts` and its test | paired copies; the same card-channel rule as the edge registry | 10 |

---
### Task 1: Channel manifest, the device exclusion, and the pre-change device snapshot

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/__fixtures__/weather-catalog.sql`, `.../osi-history-helper/__fixtures__/analysis-device-catalog.json` (generated from the pre-change code)
- Modify: `web/react-gui/src/channels/channels.json`, `.../osi-history-helper/analysis.js` (`CHANNELS`, `cardChannels`, exports), `.../osi-history-helper/index.js` (`VALID_EXPORT_CHANNEL_KEYS`), `.../osi-history-helper/analysis.test.js`, `.../osi-history-helper/index.test.js`, `web/react-gui/src/channels/__tests__/channels.test.ts`, `web/react-gui/src/channels/registry.ts` (`ChannelManifestEntry`, `cardChannelsForCard`), `web/react-gui/src/channels/__tests__/registry.test.ts`, `web/react-gui/src/analysis/__tests__/channelLabels.test.ts`, `docs/channel-manifest.md` (line 62)
- Mirror: the whole `osi-history-helper` directory to `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/`

In this task `.../` stands for `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`.

**Interfaces:**
- Produces: `analysis.js` exports `DEVICE_EXCLUDED_CHANNELS` (a `Set` of `'global_radiation_wm2'`, `'et0_mm'`, `'etc_mm'`); `CHANNELS` entries for the three keys (`cardType: 'environment'`, `edgeField: null`); the fixture `__fixtures__/weather-catalog.sql` (users 1 `grower` and 2 `other`; zones 1 North, 2 South, 3 Local, 4 Fresh, 5 Payerne, 6 Foreign; devices `A840410000000001` Kiwi North, `A840410000002120` demo-s2120, `A840410000002121` foreign-s2120; both S2120 assigned to zone 1; location rows `open_meteo:46.80:6.95` and `meteoswiss:46.81:6.94`), which Task 3 builds on; `__fixtures__/analysis-device-catalog.json`, the device catalogue of user 1 before any change; in the GUI registry, `cardChannels` and `cardChannelsForSource` leave out every manifest entry whose `edgeField` and `serverField` are both `null` (the three weather keys), so the environment card's export dialog (`HistoryCardDetailPage.tsx` lines 423–429) never offers a channel that exports nothing.

- [ ] **Step 0: Install GUI dependencies (no build)**

The branch is stacked on `feat/daily-agronomy` @ `8531f1dd1`, which already carries the ledger-test extension through 0062 (`6e0ea32cd`) and the `osi-agronomy-daily` frozen-snapshot fix; no rebase is needed.

```bash
(cd web/react-gui && npm ci)
```
Expected: `npm ci` exits 0. Never run `npm run build`.

- [ ] **Step 1: Write the catalogue fixture**

`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/__fixtures__/weather-catalog.sql`:
```sql
-- Fixture for osi-history-helper/analysis.test.js (spec
-- docs/superpowers/specs/2026-09-27-weather-data-view-design.md). Applied on
-- top of database/seed-blank.sql. Zones 1 and 2 share one Open-Meteo
-- location; zone 3 is 'local'; zone 4 has no location row yet; zone 5 is
-- MeteoSwiss; zone 6 belongs to another user.
INSERT INTO users (id, username, password_hash, created_at, user_uuid, role, sync_version) VALUES
  (1, 'grower', 'x', '2026-09-01T00:00:00Z', 'u-grower', 'admin', 1),
  (2, 'other', 'x', '2026-09-01T00:00:00Z', 'u-other', 'researcher', 1);
INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, timezone, latitude, longitude, weather_source, created_at, updated_at) VALUES
  (1, 'North', 1, 'z-north', 'Europe/Zurich', 46.8, 6.95, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (2, 'South', 1, 'z-south', 'Europe/Zurich', 46.8, 6.95, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (3, 'Local', 1, 'z-local', 'Europe/Zurich', 46.8, 6.95, 'local', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (4, 'Fresh', 1, 'z-fresh', 'Europe/Zurich', 47.0, 7.0, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (5, 'Payerne', 1, 'z-payerne', 'Europe/Zurich', 46.81, 6.94, 'meteoswiss', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  (6, 'Foreign', 2, 'z-foreign', 'Europe/Zurich', 46.8, 6.95, 'open_meteo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
  ('A840410000000001', 'Kiwi North', 'KIWI_SENSOR', 1, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('A840410000002120', 'demo-s2120', 'SENSECAP_S2120', 1, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ('A840410000002121', 'foreign-s2120', 'SENSECAP_S2120', 2, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO weather_station_zones (deveui, zone_id) VALUES
  ('A840410000002120', 1),
  ('A840410000002121', 1);
INSERT INTO weather_locations (location_key, provider, latitude, longitude, timezone, station_id, station_name, station_distance_km) VALUES
  ('open_meteo:46.80:6.95', 'open_meteo', 46.8, 6.95, 'Europe/Zurich', NULL, NULL, NULL),
  ('meteoswiss:46.81:6.94', 'meteoswiss', 46.81, 6.94, 'Europe/Zurich', 'PAY', 'Payerne', 12.4);
```

- [ ] **Step 2: Snapshot the device catalogue before any code change**

```bash
node -e "
const fs=require('fs');const {DatabaseSync}=require('node:sqlite');
const H='conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper';
const hh=require('./'+H+'/index.js');
const db=new DatabaseSync(':memory:');
db.exec(fs.readFileSync('database/seed-blank.sql','utf8'));
db.exec(fs.readFileSync(H+'/__fixtures__/weather-catalog.sql','utf8'));
const facade={all:(sql,params)=>Promise.resolve(db.prepare(sql).all(...(params||[])))};
hh.buildAnalysisCatalog(facade,{userId:1,deviceEui:'AA00000000000001'}).then((c)=>{fs.writeFileSync(H+'/__fixtures__/analysis-device-catalog.json',JSON.stringify(c.channels,null,2)+'\n');console.log('device entries',c.channels.length);});
"
```
Expected: `device entries 28` (5 Kiwi North channels, 23 demo-s2120 environment channels; foreign-s2120 belongs to user 2 and is filtered out). `git diff --stat` shows no source change; only the two new fixture files exist.

- [ ] **Step 3: Write the failing tests**

In `.../osi-history-helper/analysis.test.js`, replace the first six lines (`'use strict';` through `const analysisModule = require('./analysis.js');`) with:
```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const analysisModule = require('./analysis.js');
const hh = require('./index.js');

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO_ROOT, 'database/seed-blank.sql'), 'utf8');
const WEATHER_FIXTURE = fs.readFileSync(path.join(__dirname, '__fixtures__', 'weather-catalog.sql'), 'utf8');
const DEVICE_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'analysis-device-catalog.json'), 'utf8'));
const HUB = 'AA00000000000001';

function weatherDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  raw.exec(WEATHER_FIXTURE);
  return raw;
}

function facade(raw) {
  return { all: (sql, params) => Promise.resolve(raw.prepare(sql).all(...(params || []))) };
}
```
and append at the end of the file:
```js

test('device entries keep their pre-weather catalogue and never list a weather-only channel', async () => {
  const raw = weatherDb();
  try {
    const result = await hh.buildAnalysisCatalog(facade(raw), { userId: 1, deviceEui: HUB });
    assert.deepEqual(result.channels, DEVICE_SNAPSHOT);
    assert.deepEqual([...analysisModule.DEVICE_EXCLUDED_CHANNELS], ['global_radiation_wm2', 'et0_mm', 'etc_mm']);
    for (const c of result.channels) {
      assert.ok(!analysisModule.DEVICE_EXCLUDED_CHANNELS.has(c.channelKey), `device source lists ${c.channelKey}`);
    }
  } finally {
    raw.close();
  }
});
```

In `.../osi-history-helper/index.test.js`, insert before `test('aggregateRows requires at least one channel', () => {`:
```js
test('buildZoneExportCsv accepts et0_mm and writes no column for it (device_data has none)', async () => {
  const db = {
    all: async (sql) => {
      if (sql.includes('FROM irrigation_zones')) return [{ id: 12, name: 'Zone B', zone_uuid: 'zb', timezone: 'UTC' }];
      if (sql.includes('FROM devices')) return [{ deveui: 'AA00000000000001', name: 'Kiwi', type_id: 'KIWI_SENSOR', irrigation_zone_id: 12 }];
      return [];
    },
  };
  const result = await hh.buildZoneExportCsv(db, {
    zoneId: 12,
    from: '2026-06-01',
    to: '2026-06-01',
    granularity: 'raw',
    channels: 'et0_mm',
    nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
  });
  assert.deepEqual(result.columns, hh.RAW_CSV_COLUMNS);
  assert.deepEqual(result.rows, []);
});
```

In `web/react-gui/src/channels/__tests__/channels.test.ts`, change the line `      expect(typeof c.serverField).toBe('string');` to
```ts
      expect(c.serverField === null || typeof c.serverField === 'string').toBe(true);
```
and add, as the last test inside `describe('channel manifest', ...)`:
```ts

  it('keeps the weather-only channels off device_data and the cloud history columns', () => {
    for (const key of ['global_radiation_wm2', 'et0_mm', 'etc_mm']) {
      const entry = (manifest as any[]).find((c) => c.key === key);
      expect(entry).toMatchObject({ cardType: 'environment', category: 'weather', edgeField: null, serverField: null, exportable: true });
    }
  });
```

In `web/react-gui/src/analysis/__tests__/channelLabels.test.ts`, add as the last test inside `describe('axisQuantityLabel', ...)` (the file already imports `axisQuantityLabel` above that block):
```ts

  it('names the ET0 axis from the manifest with the series period unit', () => {
    expect(axisQuantityLabel('et0_mm', 'mm/d')).toBe('Reference evapotranspiration (mm/d)');
    expect(axisQuantityLabel('global_radiation_wm2', 'W/m²')).toBe('Global radiation (W/m²)');
  });
```

In `web/react-gui/src/channels/__tests__/registry.test.ts`, add as the last test inside `describe('channel registry', ...)`:
```ts

  it('leaves a channel with neither an edge nor a server column out of card channel lists', () => {
    for (const key of ['global_radiation_wm2', 'et0_mm', 'etc_mm']) {
      expect(cardChannels('environment')).not.toContain(key);
      expect(cardChannelsForSource('environment', { deviceType: 'SENSECAP_S2120' })).not.toContain(key);
    }
    // vwc has no edge column but a server one, so it stays.
    expect(cardChannels('soil')).toContain('vwc');
    const registry = createChannelRegistry([
      { key: 'stored', unit: 'mm', label: 'Stored', cardType: 'environment', edgeField: 'stored', serverField: 'stored' },
      { key: 'server_only', unit: 'mm', label: 'Server only', cardType: 'environment', edgeField: null, serverField: 'server_only' },
      { key: 'weather_only', unit: 'mm', label: 'Weather only', cardType: 'environment', edgeField: null, serverField: null },
    ]);
    expect(registry.cardChannels('environment')).toEqual(['stored', 'server_only']);
    expect(registry.cardChannelsForSource('environment', { deviceType: 'SENSECAP_S2120' })).toEqual(['stored', 'server_only']);
  });
```

- [ ] **Step 4: Run the tests to see them fail**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js
(cd web/react-gui && npx vitest run src/channels/__tests__/channels.test.ts src/channels/__tests__/registry.test.ts src/analysis/__tests__/channelLabels.test.ts)
node scripts/verify-channel-manifest-parity.js
```
Expected: `buildZoneExportCsv accepts et0_mm` fails with `unknown channel: et0_mm`; the device snapshot test fails with `analysisModule.DEVICE_EXCLUDED_CHANNELS is not iterable`; vitest fails `keeps the weather-only channels`, `names the ET0 axis` (label `et0_mm (mm/d)`) and `leaves a channel with neither an edge nor a server column out` (the synthetic registry also lists `weather_only`), everything else in the three files green; the parity verifier passes (nothing changed yet). The red run names the vitest files because `npm run test:unit` runs vitest only after the tsx runner passes.

- [ ] **Step 5: Add the three manifest entries**

```bash
node -e "
const fs=require('fs');const p='web/react-gui/src/channels/channels.json';
const before=fs.readFileSync(p,'utf8');const m=JSON.parse(before);
if (JSON.stringify(m,null,2)+'\n'!==before) throw new Error('channels.json does not round-trip');
if (m.some((c)=>['global_radiation_wm2','et0_mm','etc_mm'].includes(c.key))) throw new Error('already present');
const add=(key,unit,label,displayName)=>({key,unit,label,displayName,cardType:'environment',category:'weather',edgeField:null,serverField:null,exportable:true,deprecated:false,legacyAliases:[]});
m.push(add('global_radiation_wm2','W/m²','Global radiation','Global radiation'),add('et0_mm','mm','Reference ET (ET0)','Reference evapotranspiration'),add('etc_mm','mm','Crop water demand (ETc)','Crop water demand'));
fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');console.log(m.length,'entries');
"
sha256sum web/react-gui/src/channels/channels.json
```
Expected: `89 entries`; the tail of the file is the spec's JSON block (after `soil_vic_10`, in the order `global_radiation_wm2`, `et0_mm`, `etc_mm`); SHA-256 `7c3e70e64c9c79f95eb3f5eff96dd06c3810acc5ed9897af13edfd87c837f105`. If the hash differs, the file differs from the spec's block; stop and compare.

- [ ] **Step 6: Add the channels to `analysis.js` and see the device snapshot break**

In `.../osi-history-helper/analysis.js`, after the `pipe_pressure_kpa` entry of `CHANNELS` (before the closing `];`), add:
```js
  { key: 'global_radiation_wm2', unit: 'W/m²', label: 'Global radiation', cardType: 'environment', edgeField: null, exportable: true, deprecated: false },
  { key: 'et0_mm', unit: 'mm', label: 'Reference ET (ET0)', cardType: 'environment', edgeField: null, exportable: true, deprecated: false },
  { key: 'etc_mm', unit: 'mm', label: 'Crop water demand (ETc)', cardType: 'environment', edgeField: null, exportable: true, deprecated: false },
```
In `.../osi-history-helper/index.js`, `'pipe_pressure_kpa',` occurs twice: line 117 is inside `ALLOWED_DEVICE_DATA_CHANNELS` (lines 30–133) and stays as it is; the second occurrence, line 205, is inside `VALID_EXPORT_CHANNEL_KEYS` (lines 135–206). After that second occurrence add:
```js
  'global_radiation_wm2',
  'et0_mm',
  'etc_mm',
```
Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js`. Expected: the device snapshot test FAILS on `assert.deepEqual(result.channels, DEVICE_SNAPSHOT)` with three extra `demo-s2120` rows (`global_radiation_wm2`, `et0_mm`, `etc_mm`, availability `unsupported`). This is the regression the exclusion prevents.

- [ ] **Step 7: Exclude the three keys from device sources and from the GUI card channel lists**

In `.../osi-history-helper/analysis.js`, replace `function cardChannels(cardType) { … }` (lines 105–110 before Step 6) with:
```js
// Spec docs/superpowers/specs/2026-09-27-weather-data-view-design.md
// ("Catalogue entries"): these channels exist only in the weather tables, so
// no device source lists them. vwc (edgeField null) stays listed as an
// unsupported soil row, so the rule is this named set and not "edgeField".
const DEVICE_EXCLUDED_CHANNELS = new Set(['global_radiation_wm2', 'et0_mm', 'etc_mm']);

function cardChannels(cardType) {
  const normalized = normalizeCardType(cardType);
  return CHANNELS
    .filter((channel) => channel.cardType === normalized && channel.exportable !== false && channel.deprecated !== true)
    .filter((channel) => !DEVICE_EXCLUDED_CHANNELS.has(channel.key))
    .map((channel) => channel.key);
}
```
and change the file's `module.exports` to:
```js
module.exports = {
  ANALYSIS_VIEWS_SCHEMA,
  DEVICE_EXCLUDED_CHANNELS,
  analysisSeriesId,
  createAnalysis,
};
```

In `web/react-gui/src/channels/registry.ts`, `ChannelManifestEntry` gains two optional fields after `legacyAliases?: string[];`:
```ts
  edgeField?: string | null;
  serverField?: string | null;
```
after the interface `ChannelSourceContext` add:
```ts

// A manifest entry with neither an edge nor a server column (global_radiation_wm2,
// et0_mm and etc_mm live only in the weather tables) has nothing a card export can
// read, so no card channel list offers it. An entry without the fields (older
// callers, tests) counts as stored. Spec
// docs/superpowers/specs/2026-09-27-weather-data-view-design.md, plan review.
function hasStoredColumn(channel: ChannelManifestEntry): boolean {
  return !(channel.edgeField === null && channel.serverField === null);
}
```
and in `cardChannelsForCard` replace
```ts
        && (cardType !== 'soil' || legacySoilDefaults.has(channel.key)))
```
with
```ts
        && hasStoredColumn(channel)
        && (cardType !== 'soil' || legacySoilDefaults.has(channel.key)))
```
`cardChannelsForSource` falls back to `cardChannelsForCard` for the S2120 and every other source without its own branch, and `filterAvailable` reads the same list, so the one filter covers both exports. The `DRAGINO_SDI12` branch lists soil keys by name and needs nothing.

- [ ] **Step 8: Mirror, record the SHA, run the gates**

```bash
cp -r conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/. conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/
```
In `docs/channel-manifest.md`, replace line 62 (`` `aceaa8c2…  web/react-gui/src/channels/channels.json` ``, stale since before this branch) with:
```text
`7c3e70e64c9c79f95eb3f5eff96dd06c3810acc5ed9897af13edfd87c837f105  web/react-gui/src/channels/channels.json`
```
Then:
```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js
node scripts/verify-channel-manifest-parity.js
node scripts/test-history-helper.js
node scripts/verify-profile-parity.js
(cd web/react-gui && npm run test:unit && npm run typecheck)
```
Expected: node tests all pass; parity ends `Channel manifest parity verification passed` (analysis `CHANNELS` 73 channels, `edge-channels.json` unchanged at 85 entries); `test-history-helper.js` prints only `OK` lines; profile parity `All parity checks passed.`; `npm run test:unit` green (tsx runner and vitest, the new registry test included); typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add web/react-gui/src/channels docs/channel-manifest.md web/react-gui/src/analysis/__tests__/channelLabels.test.ts conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper
git -c user.name=Project-OSI commit -m "feat(analysis): global radiation, ET0 and ETc channels; device sources and card channel lists exclude them"
```
The osi-os CI job `migrations.yml` (DD5) compares `channels.json` with the same-named osi-server branch once that branch is pushed (Task 10); until then it compares with osi-server main and is red, as the spec's "Landing requirements" state.

---

### Task 2: `sum` in `aggregateRows`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js` (`statsForValues`, the empty-bucket object in `aggregateRows`), `.../osi-history-helper/index.test.js`
- Mirror: `osi-history-helper` to `bcm2709`

**Interfaces:**
- Produces: every non-empty bucket's `series[channelId]` carries `sum` (the total of the bucket's non-null values, `roundTo` three decimals, as `mean`); an empty bucket carries `sum: null`. Raw mode is unchanged. Task 3's `aggToPoints(aggregate, channelKey, { stat: 'sum', … })` reads `stats.sum`.

- [ ] **Step 1: Write the failing tests**

In `.../osi-history-helper/index.test.js`, in `test('aggregateRows bucketed mode returns per-bucket stats and coverage', …)` (line 259), add `sum: 30,` after `sampleCount: 2,` in the first expected object and `sum: 40,` after `sampleCount: 1,` in the second. Then insert before `test('aggregateRows requires at least one channel', () => {`:
```js
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

```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js`
Expected: three failures: the line-259 test (no `sum` key), `reports the bucket sum` (`undefined` for every sum), `ends a daily bucket at local midnight` (sums `undefined`).

- [ ] **Step 3: Implement**

In `statsForValues`, add `sum: roundTo(sum),` after `sampleCount: numeric.length,`:
```js
  return {
    min: roundTo(Math.min(...onlyValues)),
    max: roundTo(Math.max(...onlyValues)),
    mean: roundTo(sum / onlyValues.length),
    median: roundTo(median(onlyValues)),
    latest: roundTo(numeric[numeric.length - 1].value),
    sampleCount: numeric.length,
    sum: roundTo(sum),
  };
```
In `aggregateRows`, the empty-bucket object inside the bucket loop becomes:
```js
      bucket.series[channel.id] = stats ? { ...stats, unit: channel.unit || null } : {
        min: null,
        max: null,
        mean: null,
        median: null,
        latest: null,
        sampleCount: 0,
        sum: null,
        unit: channel.unit || null,
      };
```

- [ ] **Step 4: Run the tests and the consumers of the stats object**

```bash
cp -r conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/. conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js
node scripts/capture-history-router-vectors.js --verify
node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.test.js
node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js
node scripts/test-history-helper.js
node scripts/verify-profile-parity.js
```
Expected: all node tests pass; `[verify] 4/4 routes passed.` (the golden vectors and `history_channel_rollups` are unchanged: `buildSeriesFromAggregate`, the rollup writer and `osi-journal/context.js` copy named fields); the router and journal suites and `test-history-helper.js` pass; `All parity checks passed.`

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper
git -c user.name=Project-OSI commit -m "feat(history): bucket sum beside the mean in aggregateRows"
```

---

### Task 3: Weather source kinds in the catalogue and in series resolution

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js`, `.../osi-history-helper/index.js` (require and `createAnalysis` deps), `.../osi-history-helper/analysis.test.js` (whole file), `scripts/test-history-helper.js` (line 243), `scripts/test-scoped-access-reads.js` (the F7 viewer case)
- Mirror: `osi-history-helper` to `bcm2709`
- Unchanged, verified: the router node `analysis-api-router-fn` and its pinned strings (`scripts/verify-history-api-contract.js`)

**Interfaces:**
- Consumes: `aggregateRows` with `sum` (Task 2); `DEVICE_EXCLUDED_CHANNELS` and the fixture (Task 1); `zoneLocations(db, deploymentDefault)` from `osi-weather-provider` (returns `[{ zone: { id, timezone, … }, provider, locationKey, latitude, longitude, timezone }]`, awaits `db.all(sql, params)`).
- Produces (all in `analysis.js`): `SOURCE_KINDS` (exported), `createAnalysis(deps)` taking four more deps `zoneLocations`, `zoneDateStartIso(date, timezone)`, `normalizeTimezone(value)`, `localDateKey(value, timezone)`; `buildAnalysisCatalog(db, options)` with optional `options.weatherProviderDefault` (tests only; otherwise `process.env.OSI_WEATHER_PROVIDER_DEFAULT`); every catalogue entry gains `sourceKind: 'device' | 'weather_provider' | 'weather_station' | 'zone_daily_agronomy'`; every series gains `cadence: 'hourly' | 'daily'` and `timezone: string`; weather points are `{ t, value, count, expected, quality }` with `quality: 'partial' | null`; device points keep `{ t, value, count, quality }`. Source keys: `weather-src-<sha256(locationKey)[0:12]>`, `station-src-<sha256(normalizeDeveui(deveui))[0:12]>`, `agronomy-src-zone`. Task 4 reads `sourceKind`, `cadence`, `timezone`, `expected`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `.../osi-history-helper/analysis.test.js` with:
```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const analysisModule = require('./analysis.js');
const hh = require('./index.js');
const { zoneLocations } = require('../osi-weather-provider');

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(REPO_ROOT, 'database/seed-blank.sql'), 'utf8');
const WEATHER_FIXTURE = fs.readFileSync(path.join(__dirname, '__fixtures__', 'weather-catalog.sql'), 'utf8');
const DEVICE_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'analysis-device-catalog.json'), 'utf8'));
const HUB = 'AA00000000000001';
const HOUR = 3600000;
const OPEN_METEO_KEY = 'open_meteo:46.80:6.95';
const METEOSWISS_KEY = 'meteoswiss:46.81:6.94';
const STATION = 'A840410000002120';

// The tz helpers a mocked catalogue needs; the fixture tests below use the
// real ones through index.js.
function utcDeps() {
  return {
    zoneLocations,
    zoneDateStartIso: (date) => `${date}T00:00:00.000Z`,
    normalizeTimezone: (value) => String(value || 'UTC').trim() || 'UTC',
    localDateKey: (value) => new Date(value).toISOString().slice(0, 10),
  };
}

function weatherDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  raw.exec(WEATHER_FIXTURE);
  return raw;
}

function facade(raw) {
  return { all: (sql, params) => Promise.resolve(raw.prepare(sql).all(...(params || []))) };
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// values(i) returns the row's measurements; { skip: true } leaves the hour out.
function insertProviderHours(raw, locationKey, fromIso, hours, values = () => ({})) {
  const insert = raw.prepare('INSERT INTO weather_provider_hours (location_key, hour_start, air_temperature_c, relative_humidity_pct, rain_mm, wind_speed_mps, global_radiation_wm2, et0_mm, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const start = Date.parse(fromIso);
  for (let i = 0; i < hours; i += 1) {
    const v = { temp: 10, rh: 80, rain: 0.5, wind: 2, radiation: 100, et0: 0.1, ...values(i) };
    if (v.skip) continue;
    insert.run(locationKey, stamp(start + i * HOUR), v.temp, v.rh, v.rain, v.wind, v.radiation, v.et0, '2026-09-26T00:00:00Z');
  }
}

function insertStationHours(raw, deveui, fromIso, hours, values = () => ({})) {
  const insert = raw.prepare('INSERT INTO weather_station_hours (deveui, hour_start, air_temperature_c, relative_humidity_pct, wind_speed_mps, pressure_hpa, light_lux, global_radiation_wm2, rain_mm, sample_count, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const start = Date.parse(fromIso);
  for (let i = 0; i < hours; i += 1) {
    const v = { temp: 12, rh: 70, wind: 1, pressure: 1000, lux: 12000, radiation: 100, rain: 0.2, ...values(i) };
    if (v.skip) continue;
    insert.run(deveui, stamp(start + i * HOUR), v.temp, v.rh, v.wind, v.pressure, v.lux, v.radiation, v.rain, 6, '2026-09-26T00:00:00Z');
  }
}

function insertAgronomyDays(raw, zoneId, days) {
  const insert = raw.prepare('INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, etc_mm, computed_at) VALUES (?, ?, ?, ?, ?)');
  for (const day of days) insert.run(zoneId, day.date, day.et0, day.etc, '2026-10-28T00:00:00Z');
}

async function catalog(raw, options = {}) {
  return hh.buildAnalysisCatalog(facade(raw), { userId: 1, deviceEui: HUB, weatherProviderDefault: 'open_meteo', ...options });
}

function entry(result, zoneId, sourceKind, channelKey) {
  const found = result.channels.find((c) => c.zoneId === zoneId && c.sourceKind === sourceKind && c.channelKey === channelKey);
  assert.ok(found, `no ${sourceKind} ${channelKey} entry in zone ${zoneId}`);
  return found;
}

async function series(raw, selected, range, aggregation, options = {}) {
  return hh.resolveAnalysisSeries(facade(raw), {
    userId: 1,
    deviceEui: HUB,
    weatherProviderDefault: 'open_meteo',
    selectors: selected.map((e) => ({ seriesId: e.seriesId })),
    range,
    aggregation,
    ...options,
  });
}

function sha12(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

test('analysisSeriesId is a deterministic sha256-based id', () => {
  const idA = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_1');
  const idB = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_1');
  assert.equal(idA, idB);
  assert.match(idA, /^[0-9a-f]{16}$/);

  const expected = crypto
    .createHash('sha256')
    .update('1|soil|soil-src-abc123|swt_1')
    .digest('hex')
    .slice(0, 16);
  assert.equal(idA, expected);

  const idDifferentChannel = analysisModule.analysisSeriesId(1, 'soil', 'soil-src-abc123', 'swt_2');
  assert.notEqual(idA, idDifferentChannel);

  const idDifferentZone = analysisModule.analysisSeriesId(2, 'soil', 'soil-src-abc123', 'swt_1');
  assert.notEqual(idA, idDifferentZone);
});

test('createAnalysis returns the expected API surface bound to injected deps', () => {
  const deps = {
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async () => [],
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
  };
  const analysis = analysisModule.createAnalysis(deps);

  assert.equal(typeof analysis.buildAnalysisCatalog, 'function');
  assert.equal(typeof analysis.resolveAnalysisSeries, 'function');
  assert.equal(typeof analysis.listAnalysisViews, 'function');
  assert.equal(typeof analysis.saveAnalysisView, 'function');
  assert.equal(analysis.analysisSeriesId, analysisModule.analysisSeriesId);
  assert.equal(analysis.ANALYSIS_VIEWS_SCHEMA, analysisModule.ANALYSIS_VIEWS_SCHEMA);
  assert.match(analysis.ANALYSIS_VIEWS_SCHEMA, /CREATE TABLE IF NOT EXISTS analysis_views/);
});

test('createAnalysis works without deps supplied (pure structural check)', () => {
  const analysis = analysisModule.createAnalysis();
  assert.equal(typeof analysis.buildAnalysisCatalog, 'function');
  assert.equal(typeof analysis.resolveAnalysisSeries, 'function');
  assert.equal(typeof analysis.listAnalysisViews, 'function');
  assert.equal(typeof analysis.saveAnalysisView, 'function');
});

test('buildAnalysisCatalog filters zones by supplied owned-plus-granted UUIDs', async () => {
  const calls = [];
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM irrigation_zones')) {
        return [{ id: 2, zone_uuid: 'z-granted', name: 'Granted' }];
      }
      return [];
    },
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
  });

  await analysis.buildAnalysisCatalog({}, {
    userId: 2,
    zoneUuids: ['z-owned', 'z-granted'],
  });

  assert.match(calls[0].sql, /zone_uuid IN \(\?,\?\)/);
  assert.deepEqual(calls[0].params, ['z-owned', 'z-granted']);
  // zoneLocations reads every live zone once, through the dbAll adapter.
  assert.match(calls[1].sql, /LEFT JOIN gateway_locations/);
  assert.doesNotMatch(calls[2].sql, /user_id = \?/);
  assert.deepEqual(calls[2].params, [2]);
  assert.match(calls[3].sql, /FROM weather_station_zones/);
  assert.doesNotMatch(calls[3].sql, /user_id = \?/);
  assert.deepEqual(calls[3].params, [2]);
});

test('buildAnalysisCatalog preserves the legacy owner filter without a scope list', async () => {
  const calls = [];
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql, params) => {
      calls.push({ sql, params });
      return [];
    },
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
  });

  await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.match(calls[0].sql, /user_id = \?/);
  assert.deepEqual(calls[0].params, [7]);
  assert.equal(calls.length, 1, 'no zone, so no location, device or station query');
});

// Station and location queries answer [] so only the device path and the
// daily agronomy source (always listed) remain.
function sentekLikeDbAll(zoneRow, device) {
  return async (_db, sql) => {
    if (sql.includes('FROM weather_station_zones') || sql.includes('FROM weather_locations')) return [];
    return sql.includes('FROM irrigation_zones') ? [zoneRow] : [device];
  };
}

test('buildAnalysisCatalog exposes only configured Sentek soil channels', async () => {
  const sentek = {
    deveui: '0011223344556677',
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    soil_moisture_probe_depths_json: JSON.stringify({ vwc_1: 0, vwc_8: 80 }),
  };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: sentekLikeDbAll({ id: 2, zone_uuid: 'zone-2', name: 'Sentek block' }, sentek),
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Sentek-01',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [sentek],
    sourceKeyForCsv: () => 'sentek-01',
    ...utcDeps(),
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), [
    'vwc_1',
    'vwc_8',
    'et0_mm',
    'etc_mm',
  ]);
  assert.ok(catalog.channels.every((entry) => !entry.channelKey.startsWith('swt_')));
});

test('buildAnalysisCatalog keeps explicit Chameleon SWT capability ahead of other configuration', async () => {
  const chameleon = {
    deveui: '8899AABBCCDDEEFF',
    type_id: 'KIWI_SENSOR',
    chameleon_enabled: 1,
    soil_moisture_probe_depths_json: JSON.stringify({ vwc_1: 12.5 }),
  };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: sentekLikeDbAll({ id: 3, zone_uuid: 'zone-3', name: 'Chameleon block' }, chameleon),
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Chameleon',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [chameleon],
    sourceKeyForCsv: () => 'chameleon',
    ...utcDeps(),
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), ['swt_1', 'swt_2', 'swt_3', 'et0_mm', 'etc_mm']);
});

test('buildAnalysisCatalog uses the two canonical Kiwi SWT channels without state', async () => {
  const kiwi = { deveui: '1020304050607080', type_id: 'KIWI_SENSOR' };
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: sentekLikeDbAll({ id: 4, zone_uuid: 'zone-4', name: 'Kiwi block' }, kiwi),
    deriveCardsForZone: () => [{ cardType: 'soil' }],
    displayDeviceName: () => 'Kiwi',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [kiwi],
    sourceKeyForCsv: () => 'kiwi',
    ...utcDeps(),
  });

  const catalog = await analysis.buildAnalysisCatalog({}, { userId: 7 });

  assert.deepEqual(catalog.channels.map((entry) => entry.channelKey), ['swt_1', 'swt_2', 'et0_mm', 'etc_mm']);
});

test('device entries keep their pre-weather catalogue and never list a weather-only channel', async () => {
  const raw = weatherDb();
  try {
    const result = await catalog(raw);
    const devices = result.channels.filter((c) => c.sourceKind === 'device').map(({ sourceKind, ...rest }) => rest);
    assert.deepEqual(devices, DEVICE_SNAPSHOT);
    for (const c of result.channels.filter((e) => e.sourceKind === 'device')) {
      assert.ok(!analysisModule.DEVICE_EXCLUDED_CHANNELS.has(c.channelKey), `device source lists ${c.channelKey}`);
    }
  } finally {
    raw.close();
  }
});

test('a located zone lists its provider, station and daily agronomy sources in order', async () => {
  const raw = weatherDb();
  try {
    const result = await catalog(raw);
    const north = result.channels.filter((c) => c.zoneId === 1 && c.sourceKind !== 'device');
    assert.deepEqual(north.map((c) => [c.sourceKind, c.sourceKey, c.deviceName, c.channelKey]), [
      ...['ambient_temperature', 'relative_humidity', 'rain_mm_per_hour', 'wind_speed_mps', 'global_radiation_wm2', 'et0_mm']
        .map((k) => ['weather_provider', `weather-src-${sha12(OPEN_METEO_KEY)}`, 'Open-Meteo 46.80°N 6.95°E', k]),
      ...['ambient_temperature', 'relative_humidity', 'wind_speed_mps', 'barometric_pressure_hpa', 'light_lux', 'global_radiation_wm2', 'rain_mm_per_hour']
        .map((k) => ['weather_station', `station-src-${sha12(STATION)}`, 'demo-s2120 (hourly)', k]),
      ['zone_daily_agronomy', 'agronomy-src-zone', 'North daily agronomy', 'et0_mm'],
      ['zone_daily_agronomy', 'agronomy-src-zone', 'North daily agronomy', 'etc_mm'],
    ]);
    for (const c of north) {
      assert.equal(c.cardType, 'environment');
      assert.equal(c.availability, 'available');
      assert.equal(c.depthCm, null);
      assert.equal(c.hubEui, HUB);
      assert.ok(c.displayName.startsWith(`${c.deviceName} - `), c.displayName);
      assert.equal(c.seriesId, analysisModule.analysisSeriesId(1, 'environment', c.sourceKey, c.channelKey));
    }
    assert.equal(entry(result, 1, 'zone_daily_agronomy', 'etc_mm').displayName, 'North daily agronomy - Crop water demand (ETc)');
    assert.equal(entry(result, 5, 'weather_provider', 'et0_mm').deviceName, 'MeteoSwiss PAY Payerne (12 km)');
    const firstWeather = result.channels.findIndex((c) => c.zoneId === 1 && c.sourceKind !== 'device');
    assert.ok(result.channels.slice(0, firstWeather).every((c) => c.zoneId === 1 && c.sourceKind === 'device'));
  } finally {
    raw.close();
  }
});

test('local zones and zones without a location row get no provider source', async () => {
  const raw = weatherDb();
  try {
    const result = await catalog(raw);
    for (const zoneId of [3, 4]) {
      assert.ok(!result.channels.some((c) => c.zoneId === zoneId && c.sourceKind === 'weather_provider'), `zone ${zoneId}`);
      assert.ok(result.channels.some((c) => c.zoneId === zoneId && c.sourceKind === 'zone_daily_agronomy'), `zone ${zoneId} agronomy`);
    }
    raw.prepare("UPDATE irrigation_zones SET latitude = NULL, longitude = NULL WHERE id = 2").run();
    const noCoordinates = await catalog(raw);
    assert.ok(!noCoordinates.channels.some((c) => c.zoneId === 2 && c.sourceKind === 'weather_provider'));
    assert.equal(entry(noCoordinates, 2, 'zone_daily_agronomy', 'et0_mm').deviceName, 'South daily agronomy');
  } finally {
    raw.close();
  }
});

test('two zones on one location get their own series ids and the same points', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-24T21:00:00Z', 6, (i) => ({ temp: 10 + i }));
    const result = await catalog(raw);
    const north = entry(result, 1, 'weather_provider', 'ambient_temperature');
    const south = entry(result, 2, 'weather_provider', 'ambient_temperature');
    assert.equal(north.sourceKey, south.sourceKey);
    assert.notEqual(north.seriesId, south.seriesId);
    const out = await series(raw, [north, south], { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T02:00:00.000Z' }, 'raw');
    assert.equal(out.series.length, 2);
    assert.deepEqual(out.series[0].points, out.series[1].points);
    assert.equal(out.series[0].points.length, 4);
  } finally {
    raw.close();
  }
});

test('raw provider points sit at hour_start, Open-Meteo readings one hour later, MeteoSwiss at hour_start', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-24T21:00:00Z', 5, (i) => ({ temp: 21 + i, rain: i }));
    insertProviderHours(raw, METEOSWISS_KEY, '2026-09-24T21:00:00Z', 5, (i) => ({ temp: 31 + i }));
    const result = await catalog(raw);
    const out = await series(raw, [
      entry(result, 1, 'weather_provider', 'rain_mm_per_hour'),
      entry(result, 1, 'weather_provider', 'ambient_temperature'),
      entry(result, 5, 'weather_provider', 'ambient_temperature'),
    ], { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T02:00:00.000Z' }, 'raw');
    const [rain, openMeteoTemp, meteoSwissTemp] = out.series;
    assert.deepEqual(rain.points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 1], ['2026-09-24T23:00:00.000Z', 2], ['2026-09-25T00:00:00.000Z', 3], ['2026-09-25T01:00:00.000Z', 4],
    ]);
    assert.deepEqual(rain.points[0], { t: '2026-09-24T22:00:00.000Z', value: 1, count: 1, expected: null, quality: null });
    assert.deepEqual(openMeteoTemp.points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 21], ['2026-09-24T23:00:00.000Z', 22], ['2026-09-25T00:00:00.000Z', 23], ['2026-09-25T01:00:00.000Z', 24],
    ]);
    assert.deepEqual(meteoSwissTemp.points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 32], ['2026-09-24T23:00:00.000Z', 33], ['2026-09-25T00:00:00.000Z', 34], ['2026-09-25T01:00:00.000Z', 35],
    ]);
    assert.equal(rain.unit, 'mm/h');
    assert.equal(rain.cadence, 'hourly');
    assert.equal(rain.timezone, 'Europe/Zurich');
    assert.equal(out.aggregation.applied, 'raw');
  } finally {
    raw.close();
  }
});

test('daily provider buckets are Zurich days: rain and ET0 summed, temperature averaged', async () => {
  const raw = weatherDb();
  try {
    // 2026-09-24T22:00Z is 00:00 on 25 September in Zurich (CEST).
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-23T21:00:00Z', 49, (i) => ({ rain: i === 25 ? 1 : 0 }));
    const result = await catalog(raw);
    const out = await series(raw, [
      entry(result, 1, 'weather_provider', 'rain_mm_per_hour'),
      entry(result, 1, 'weather_provider', 'et0_mm'),
      entry(result, 1, 'weather_provider', 'ambient_temperature'),
    ], { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    const [rain, et0, temp] = out.series;
    assert.deepEqual(rain.points.map((p) => [p.t, p.value, p.count, p.expected, p.quality]), [
      ['2026-09-23T22:00:00.000Z', 0, 24, 24, null],
      ['2026-09-24T22:00:00.000Z', 1, 24, 24, null],
    ]);
    assert.deepEqual(et0.points.map((p) => p.value), [2.4, 2.4]);
    assert.deepEqual(temp.points.map((p) => [p.value, p.expected, p.quality]), [[10, null, null], [10, null, null]]);
    assert.equal(rain.unit, 'mm/d');
    assert.equal(temp.unit, '°C');
    assert.equal(rain.cadence, 'daily');
  } finally {
    raw.close();
  }
});

test('series units name the period and device series keep theirs', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-11T21:00:00Z', 14 * 24 + 1);
    const result = await catalog(raw);
    const rain = entry(result, 1, 'weather_provider', 'rain_mm_per_hour');
    const deviceRain = result.channels.find((c) => c.zoneId === 1 && c.sourceKind === 'device' && c.deviceName === 'demo-s2120' && c.channelKey === 'rain_mm_per_hour');
    const twoDays = { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' };
    const hourly = await series(raw, [rain, deviceRain], twoDays, 'hourly');
    assert.deepEqual(hourly.series.map((s) => [s.unit, s.cadence]), [['mm/h', 'hourly'], ['mm/h', 'hourly']]);
    const daily = await series(raw, [rain, deviceRain], twoDays, 'daily');
    assert.deepEqual(daily.series.map((s) => [s.unit, s.cadence]), [['mm/d', 'daily'], ['mm/h', 'hourly']]);
    const weekly = await series(raw, [rain], { from: '2026-09-11T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'weekly');
    assert.equal(weekly.series[0].unit, 'mm/wk');
    assert.equal(weekly.series[0].cadence, 'hourly');
    assert.deepEqual(weekly.series[0].points.map((p) => [p.value, p.count, p.expected, p.quality]), [[84, 168, 168, null], [84, 168, 168, null]]);
    assert.equal(daily.series[1].points[0].expected, undefined, 'device points carry no expected key');
  } finally {
    raw.close();
  }
});

test('summed buckets with missing rows are partial', async () => {
  const raw = weatherDb();
  try {
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-09-23T21:00:00Z', 49, (i) => (i === 6 ? { skip: true } : {}));
    const result = await catalog(raw);
    const et0 = entry(result, 1, 'weather_provider', 'et0_mm');
    const daily = await series(raw, [et0], { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    assert.deepEqual(daily.series[0].points.map((p) => [p.value, p.count, p.expected, p.quality]), [
      [2.3, 23, 24, 'partial'],
      [2.4, 24, 24, null],
    ]);
    // A range starting at 06:00 local: its first day has 18 hours.
    const late = await series(raw, [et0], { from: '2026-09-24T04:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    assert.deepEqual(late.series[0].points.map((p) => [p.t, p.count, p.quality]), [
      ['2026-09-24T04:00:00.000Z', 18, 'partial'],
      ['2026-09-24T22:00:00.000Z', 24, null],
    ]);

    insertAgronomyDays(raw, 1, Array.from({ length: 14 }, (_, i) => {
      const date = `2026-09-${String(14 + i).padStart(2, '0')}`;
      return { date, et0: date === '2026-09-16' ? null : 1, etc: 1 };
    }));
    const agronomy = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-09-13T22:00:00.000Z', to: '2026-09-27T22:00:00.000Z' }, 'weekly');
    assert.deepEqual(agronomy.series[0].points.map((p) => [p.value, p.count, p.expected, p.quality]), [
      [6, 6, 7, 'partial'],
      [7, 7, 7, null],
    ]);
    assert.equal(agronomy.series[0].unit, 'mm/wk');
  } finally {
    raw.close();
  }
});

test('station hours: a five-hour hole breaks the raw line once; rain summed, pressure averaged', async () => {
  const raw = weatherDb();
  try {
    insertStationHours(raw, STATION, '2026-09-24T22:00:00Z', 9, (i) => (i >= 2 && i <= 6 ? { skip: true } : { temp: 10 + i }));
    const result = await catalog(raw);
    const temp = entry(result, 1, 'weather_station', 'ambient_temperature');
    const rawOut = await series(raw, [temp], { from: '2026-09-24T22:00:00.000Z', to: '2026-09-25T07:00:00.000Z' }, 'raw');
    assert.deepEqual(rawOut.series[0].points.map((p) => [p.t, p.value]), [
      ['2026-09-24T22:00:00.000Z', 10],
      ['2026-09-24T23:00:00.000Z', 11],
      ['2026-09-25T00:00:00.000Z', null],
      ['2026-09-25T05:00:00.000Z', 17],
      ['2026-09-25T06:00:00.000Z', 18],
    ]);

    raw.prepare('DELETE FROM weather_station_hours').run();
    insertStationHours(raw, STATION, '2026-09-23T22:00:00Z', 48, (i) => ({ pressure: i % 2 ? 1010 : 1000 }));
    const daily = await series(raw, [
      entry(result, 1, 'weather_station', 'rain_mm_per_hour'),
      entry(result, 1, 'weather_station', 'barometric_pressure_hpa'),
    ], { from: '2026-09-23T22:00:00.000Z', to: '2026-09-25T22:00:00.000Z' }, 'daily');
    assert.deepEqual(daily.series[0].points.map((p) => p.value), [4.8, 4.8]);
    assert.deepEqual(daily.series[1].points.map((p) => p.value), [1005, 1005]);
    assert.equal(daily.series[1].unit, 'hPa');
  } finally {
    raw.close();
  }
});

test('daily agronomy points sit at Zurich midnight across the October clock change', async () => {
  const raw = weatherDb();
  try {
    insertAgronomyDays(raw, 1, [
      { date: '2026-10-23', et0: 1.2, etc: 0.9 },
      { date: '2026-10-24', et0: null, etc: null },
      { date: '2026-10-25', et0: 1.1, etc: 0.8 },
      { date: '2026-10-27', et0: 0.9, etc: 0.7 },
    ]);
    const result = await catalog(raw);
    const out = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-10-22T22:00:00.000Z', to: '2026-10-27T23:00:00.000Z' }, 'daily');
    assert.deepEqual(out.series[0].points, [
      { t: '2026-10-22T22:00:00.000Z', value: 1.2, count: 1, expected: null, quality: null },
      { t: '2026-10-23T22:00:00.000Z', value: null, count: 0, expected: null, quality: null },
      { t: '2026-10-24T22:00:00.000Z', value: 1.1, count: 1, expected: null, quality: null },
      { t: '2026-10-25T23:00:00.000Z', value: null, count: 0, expected: null, quality: null },
      { t: '2026-10-26T23:00:00.000Z', value: 0.9, count: 1, expected: null, quality: null },
    ]);
    assert.equal(out.series[0].unit, 'mm/d');
    assert.equal(out.series[0].cadence, 'daily');
  } finally {
    raw.close();
  }
});

test('scope: listed zones bound the weather entries; legacy mode filters the station by owner', async () => {
  const raw = weatherDb();
  try {
    const scoped = await catalog(raw, { zoneUuids: ['z-south'] });
    assert.deepEqual([...new Set(scoped.channels.map((c) => c.zoneId))], [2]);
    assert.ok(scoped.channels.some((c) => c.sourceKind === 'weather_provider'));
    const scopedNorth = await catalog(raw, { zoneUuids: ['z-north'] });
    assert.deepEqual([...new Set(scopedNorth.channels.filter((c) => c.sourceKind === 'weather_station').map((c) => c.deviceName))], ['demo-s2120 (hourly)', 'foreign-s2120 (hourly)']);
    const legacy = await catalog(raw);
    assert.deepEqual([...new Set(legacy.channels.filter((c) => c.sourceKind === 'weather_station').map((c) => c.deviceName))], ['demo-s2120 (hourly)']);
    assert.ok(!legacy.channels.some((c) => c.zoneId === 6), 'the other user\'s zone stays out');
  } finally {
    raw.close();
  }
});

test('the 30 000-row cap counts provider, station and device rows together', async () => {
  const raw = weatherDb();
  try {
    const from = '2025-08-22T00:00:00.000Z';
    const to = '2026-09-26T00:00:00.000Z';
    raw.exec('BEGIN');
    insertProviderHours(raw, OPEN_METEO_KEY, from, 9600);
    insertStationHours(raw, STATION, from, 9600);
    const insert = raw.prepare('INSERT INTO device_data (deveui, recorded_at, rain_mm_per_hour) VALUES (?, ?, ?)');
    for (let i = 0; i < 12000; i += 1) insert.run(STATION, new Date(Date.parse(from) + i * 48 * 60000).toISOString(), 0);
    raw.exec('COMMIT');
    const result = await catalog(raw);
    const provider = entry(result, 1, 'weather_provider', 'rain_mm_per_hour');
    const station = entry(result, 1, 'weather_station', 'rain_mm_per_hour');
    const device = result.channels.find((c) => c.zoneId === 1 && c.sourceKind === 'device' && c.deviceName === 'demo-s2120' && c.channelKey === 'rain_mm_per_hour');
    const under = await series(raw, [provider, station], { from, to }, 'weekly');
    assert.equal(under.series.length, 2);
    await assert.rejects(
      series(raw, [provider, station, device], { from, to }, 'weekly'),
      (error) => error.statusCode === 413 && error.suggestion === 'Narrow the date range or pick a coarser granularity.'
    );
  } finally {
    raw.close();
  }
});

test('a failing zoneLocations makes the catalogue reject with its error', async () => {
  const analysis = analysisModule.createAnalysis({
    aggregateRows: () => ({ series: {}, buckets: [] }),
    dbAll: async (_db, sql) => (sql.includes('FROM irrigation_zones') ? [{ id: 1, zone_uuid: 'z-1', name: 'North' }] : []),
    deriveCardsForZone: () => [],
    displayDeviceName: () => 'Device',
    normalizeDeveui: (value) => value,
    resolveAggregation: () => ({ requested: 'raw', level: 'raw', bucketSizeSeconds: null }),
    soilDepthCm: () => null,
    sourceDevicesForCard: () => [],
    sourceKeyForCsv: () => 'source-key',
    ...utcDeps(),
    zoneLocations: async () => { throw new Error('weather store broken'); },
  });
  await assert.rejects(analysis.buildAnalysisCatalog({}, { userId: 1 }), /weather store broken/);
});

// The router hands buildAnalysisCatalog an osi-db-helper handle; this run
// binds the real facade (sqlite3 swapped for node:sqlite, as in
// ../osi-weather-provider/facade-contract.test.js) so the zoneLocations
// adapter is exercised as the router exercises it.
const DB_HELPER_PATH = path.join(__dirname, '..', 'osi-db-helper', 'index.js');
// BEGIN copied verbatim from ../osi-weather-provider/facade-contract.test.js lines 31-103
function sqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }

    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const rows = this.native.prepare(sql).all(...(params || []));
        callback.call(this, null, rows);
      } catch (error) {
        callback.call(this, error);
      }
    }

    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes) }, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    exec(sql, callback) {
      try {
        this.native.exec(sql);
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    close(callback) {
      try {
        this.native.close();
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function loadOsiDbHelper() {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) {
      return sqlite3Adapter();
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(DB_HELPER_PATH)];
    return require(DB_HELPER_PATH);
  } finally {
    Module._load = original;
  }
}
// END copied

test('the catalogue reads weather sources through a real osi-db-helper handle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-facade-'));
  const dbPath = path.join(dir, 'farming.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec(SEED);
  seed.exec(WEATHER_FIXTURE);
  seed.close();
  const osiDb = loadOsiDbHelper();
  const db = new osiDb.Database(dbPath);
  try {
    const result = await hh.buildAnalysisCatalog(db, { userId: 1, deviceEui: HUB, weatherProviderDefault: 'open_meteo' });
    assert.equal(entry(result, 1, 'weather_provider', 'et0_mm').deviceName, 'Open-Meteo 46.80°N 6.95°E');
    assert.equal(entry(result, 1, 'weather_station', 'light_lux').deviceName, 'demo-s2120 (hourly)');
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Review Focus 1: the clock-change days of a Zurich zone.
test('the 23-hour spring day is marked partial and the 25-hour autumn day is not', async () => {
  const raw = weatherDb();
  try {
    // 29 March 2026 runs 28T23:00Z..29T22:00Z (23 h); 25 October 2026 runs 24T22:00Z..25T23:00Z (25 h).
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-03-28T22:00:00Z', 25);
    insertProviderHours(raw, OPEN_METEO_KEY, '2026-10-24T21:00:00Z', 27);
    const result = await catalog(raw);
    const et0 = entry(result, 1, 'weather_provider', 'et0_mm');
    const spring = await series(raw, [et0], { from: '2026-03-28T23:00:00.000Z', to: '2026-03-29T22:00:00.000Z' }, 'daily');
    assert.deepEqual(spring.series[0].points.map((p) => [p.t, p.count, p.expected, p.quality]), [['2026-03-28T23:00:00.000Z', 23, 24, 'partial']]);
    const autumn = await series(raw, [et0], { from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' }, 'daily');
    assert.deepEqual(autumn.series[0].points.map((p) => [p.t, p.count, p.expected, p.quality]), [['2026-10-24T22:00:00.000Z', 25, 24, null]]);
  } finally {
    raw.close();
  }
});

// Review Focus 2: a provider change drops the old provider series from a saved view.
test('a saved view reports the provider series a provider change dropped', async () => {
  const raw = weatherDb();
  try {
    const before = await catalog(raw);
    const oldRain = entry(before, 1, 'weather_provider', 'rain_mm_per_hour');
    const kept = before.channels.find((c) => c.zoneId === 1 && c.sourceKind === 'device');
    raw.exec(analysisModule.ANALYSIS_VIEWS_SCHEMA);
    raw.prepare('INSERT INTO analysis_views (user_id, name, view_json) VALUES (1, ?, ?)')
      .run('weather-acceptance', JSON.stringify({ schemaVersion: 1, name: 'weather-acceptance', selectors: [{ seriesId: oldRain.seriesId }, { seriesId: kept.seriesId }] }));
    raw.prepare("UPDATE irrigation_zones SET weather_source = 'meteoswiss' WHERE id = 1").run();
    raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude) VALUES ('meteoswiss:46.80:6.95', 'meteoswiss', 46.8, 6.95)").run();
    const [view] = await hh.listAnalysisViews(facade(raw), { userId: 1, deviceEui: HUB, weatherProviderDefault: 'open_meteo' });
    assert.deepEqual(view.droppedSeriesIds, [oldRain.seriesId]);
    assert.deepEqual(view.selectors.map((s) => s.seriesId), [kept.seriesId]);
    const after = await catalog(raw);
    assert.equal(entry(after, 1, 'weather_provider', 'rain_mm_per_hour').deviceName, 'MeteoSwiss 46.80°N 6.95°E');
  } finally {
    raw.close();
  }
});

// Review Focus 3: a zone timezone Intl does not know falls back to UTC.
test('an invalid zone timezone places daily points at UTC midnight', async () => {
  const raw = weatherDb();
  try {
    raw.prepare("UPDATE irrigation_zones SET timezone = 'Mars/Olympus' WHERE id = 1").run();
    insertAgronomyDays(raw, 1, [{ date: '2026-09-24', et0: 2, etc: 1.5 }, { date: '2026-09-25', et0: 3, etc: 2 }]);
    const result = await catalog(raw);
    const out = await series(raw, [entry(result, 1, 'zone_daily_agronomy', 'et0_mm')], { from: '2026-09-24T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' }, 'daily');
    assert.equal(out.series[0].timezone, 'UTC');
    assert.deepEqual(out.series[0].points.map((p) => [p.t, p.value]), [['2026-09-24T00:00:00.000Z', 2], ['2026-09-25T00:00:00.000Z', 3]]);
  } finally {
    raw.close();
  }
});

// Review Focus 4: coordinates south of the equator and west of Greenwich.
test('a provider source south and west of zero names its hemispheres', async () => {
  const raw = weatherDb();
  try {
    raw.prepare('UPDATE irrigation_zones SET latitude = -1.2833, longitude = -36.8167 WHERE id = 2').run();
    raw.prepare("INSERT INTO weather_locations (location_key, provider, latitude, longitude) VALUES ('open_meteo:-1.28:-36.82', 'open_meteo', -1.28, -36.82)").run();
    const result = await catalog(raw);
    assert.equal(entry(result, 2, 'weather_provider', 'et0_mm').deviceName, 'Open-Meteo 1.28°S 36.82°W');
  } finally {
    raw.close();
  }
});

// Review Focus 5: a re-resolved MeteoSwiss station keeps the series and takes the new name.
test('a re-resolved MeteoSwiss station keeps the series ids and shows the new station', async () => {
  const raw = weatherDb();
  try {
    const before = entry(await catalog(raw), 5, 'weather_provider', 'rain_mm_per_hour');
    raw.prepare("UPDATE weather_locations SET station_id = 'MAH', station_name = 'Mathod', station_distance_km = NULL WHERE location_key = ?").run(METEOSWISS_KEY);
    const after = entry(await catalog(raw), 5, 'weather_provider', 'rain_mm_per_hour');
    assert.equal(after.seriesId, before.seriesId);
    assert.equal(after.deviceName, 'MeteoSwiss MAH Mathod');
    raw.prepare("UPDATE irrigation_zones SET name = '  ' WHERE id = 5").run();
    assert.equal(entry(await catalog(raw), 5, 'zone_daily_agronomy', 'et0_mm').deviceName, 'Zone 5 daily agronomy');
  } finally {
    raw.close();
  }
});
```

In `scripts/test-history-helper.js`, test `buildAnalysisCatalog scopes zones and devices to the authenticated user` (line 238), replace the `deviceNames` line and the two asserts after it with:
```js
    const deviceNames = Array.from(new Set(channels.filter((entry) => entry.sourceKind === 'device').map((entry) => entry.deviceName))).sort();
    assert.deepStrictEqual(zoneNames, ['User One Zone']);
    assert.deepStrictEqual(deviceNames, ['Kiwi One']);
    assert.ok(channels.some((entry) => entry.sourceKind === 'zone_daily_agronomy' && entry.deviceName === 'User One Zone daily agronomy'));
```

In `scripts/test-scoped-access-reads.js`, test `F7: scoped analysis catalog uses an explicit account-wide array`, add after `seedAnalysisDevices(db);`:
```js
    // Both zones resolve to one Open-Meteo location (weather data view spec).
    db.exec(`
      UPDATE irrigation_zones SET latitude = 46.8, longitude = 6.95, weather_source = 'open_meteo';
      INSERT INTO weather_locations (location_key, provider, latitude, longitude)
        VALUES ('open_meteo:46.80:6.95', 'open_meteo', 46.8, 6.95);
    `);
```
and after `assert.ok(zoneIds.has('2'), 'zone 2 channels must be present for a viewer (W1)');`:
```js
    for (const zoneId of [1, 2]) {
      assert.ok(
        (response.result.payload.channels || []).some((channel) => channel.zoneId === zoneId
          && channel.sourceKind === 'weather_provider'
          && channel.deviceName === 'Open-Meteo 46.80°N 6.95°E'),
        `zone ${zoneId} lists the provider source`
      );
    }
```

- [ ] **Step 2: Run the tests to see them fail**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js
node scripts/test-history-helper.js
node --test scripts/test-scoped-access-reads.js
```
Expected: most new catalogue and series tests fail (`sourceKind` undefined, no weather entries, `SOURCE_KINDS` undefined); the mocked catalogue tests fail on the call order (no `zoneLocations` query) and on the expected channel lists (no `et0_mm`, `etc_mm`); `test-history-helper.js` fails `buildAnalysisCatalog scopes zones and devices to the authenticated user` (no entry has `sourceKind`); the scoped-access F7 case fails on `zone 1 lists the provider source`.

- [ ] **Step 3: Add `SOURCE_KINDS` and the helpers to `analysis.js`**

Insert after `const MAX_VIEW_NAME_LENGTH = 120;`:
```js

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Spec docs/superpowers/specs/2026-09-27-weather-data-view-design.md
// ("Source kinds"). Table and column names are constants; a request selects
// among them through a catalogue entry and never names one. The key order of
// each channels object is the order of the catalogue entries. offsetHours is
// keyed by the weather_locations row's provider: Open-Meteo stamps its
// instantaneous values at the end of the hour sub-project 1 stores as
// hour_start, so they are plotted one hour later.
const SOURCE_KINDS = {
  device: {
    table: 'device_data', ownerColumn: 'deveui', timeColumn: 'recorded_at',
    nativeStep: null,
    channels: null,
  },
  weather_provider: {
    table: 'weather_provider_hours', ownerColumn: 'location_key', timeColumn: 'hour_start',
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
    table: 'weather_station_hours', ownerColumn: 'deveui', timeColumn: 'hour_start',
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
    table: 'zone_daily_agronomy', ownerColumn: 'zone_id', timeColumn: 'date',
    nativeStep: 'day',
    channels: {
      et0_mm: { column: 'et0_mm', stat: 'sum' },
      etc_mm: { column: 'etc_mm', stat: 'sum' },
    },
  },
};

const STATION_SOURCES_SQL = "SELECT d.* FROM weather_station_zones wsz JOIN devices d ON d.deveui = wsz.deveui WHERE wsz.zone_id = ? AND d.deleted_at IS NULL AND d.type_id = 'SENSECAP_S2120'";
```

Replace `function aggToPoints(aggregate, channelKey) { … }` (the whole function, up to the blank line before `function userIdFor`) with:
```js
// Without `spec` this is the device path, unchanged: the bucket mean, the
// bucket's sample count and the cadence confidence. With `spec` (the weather
// kinds) a 'sum' channel reports the bucket total and marks a bucket that
// holds fewer rows than `expected` as partial.
function aggToPoints(aggregate, channelKey, spec) {
  const rawPoints = aggregate && aggregate.series && aggregate.series[channelKey] && aggregate.series[channelKey].points;
  if (Array.isArray(rawPoints)) {
    return rawPoints.map((point) => ({
      t: point.recordedAt,
      value: point.value,
      count: 1,
      quality: null,
    }));
  }
  return (aggregate && aggregate.buckets || []).map((bucket) => {
    const stats = bucket.series && bucket.series[channelKey] || {};
    if (!spec) {
      return {
        t: bucket.bucketStart,
        value: stats.mean ?? null,
        count: Number(stats.sampleCount || 0),
        quality: bucket.coverageConfidence || null,
      };
    }
    const count = Number(stats.sampleCount || 0);
    const expected = spec.stat === 'sum' && Number.isInteger(spec.expected) ? spec.expected : null;
    return {
      t: bucket.bucketStart,
      value: (spec.stat === 'sum' ? stats.sum : stats.mean) ?? null,
      count,
      expected,
      quality: expected !== null && count > 0 && count < expected ? 'partial' : null,
    };
  });
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

function providerSourceName(row) {
  const coordinates = `${formatCoordinate(row.latitude, 'N', 'S')} ${formatCoordinate(row.longitude, 'E', 'W')}`;
  if (row.provider !== 'meteoswiss') return `Open-Meteo ${coordinates}`;
  const stationId = String(row.station_id || '').trim();
  if (!stationId) return `MeteoSwiss ${coordinates}`;
  const parts = ['MeteoSwiss', stationId];
  const stationName = String(row.station_name || '').trim();
  if (stationName) parts.push(stationName);
  const distance = numberOrNull(row.station_distance_km);
  if (distance !== null) parts.push(`(${Math.round(distance)} km)`);
  return parts.join(' ');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
```

- [ ] **Step 4: Rewrite the catalogue and series resolution**

Replace everything from `function createAnalysis(deps) {` down to, and not including, the line `  async function listAnalysisViews(db, user = {}) {` with:
```js
function createAnalysis(deps) {
  const {
    aggregateRows,
    dbAll,
    deriveCardsForZone,
    displayDeviceName,
    localDateKey,
    normalizeDeveui,
    normalizeTimezone,
    resolveAggregation,
    soilDepthCm,
    sourceDevicesForCard,
    sourceKeyForCsv,
    zoneDateStartIso,
    zoneLocations,
  } = deps || {};

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

  async function buildAnalysisCatalog(db, options = {}) {
    const hubEui = String(options.deviceEui || options.device_eui || '').trim().toUpperCase();
    const userId = userIdFor(options);
    const zoneUuids = Array.isArray(options.zoneUuids) ? options.zoneUuids : null;
    const zones = zoneUuids === null
      ? await dbAll(
        db,
        'SELECT * FROM irrigation_zones WHERE deleted_at IS NULL AND user_id = ? ORDER BY id ASC',
        [userId]
      )
      : zoneUuids.length
        ? await dbAll(
          db,
          `SELECT * FROM irrigation_zones WHERE deleted_at IS NULL AND zone_uuid IN (${zoneUuids.map(() => '?').join(',')}) ORDER BY id ASC`,
          zoneUuids
        )
        : [];
    const channels = [];
    const entriesById = new Map();
    const deploymentDefault = options.weatherProviderDefault !== undefined
      ? options.weatherProviderDefault
      : process.env.OSI_WEATHER_PROVIDER_DEFAULT;
    const weather = zones.length
      ? await loadZoneWeather(db, deploymentDefault)
      : { byZoneId: new Map(), rowsByKey: new Map() };

    for (const zone of zones) {
      const timezone = normalizeTimezone(zone.timezone);
      const devices = zoneUuids === null
        ? await dbAll(
          db,
          'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? AND user_id = ? ORDER BY deveui ASC',
          [zone.id, userId]
        )
        : await dbAll(
          db,
          'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? ORDER BY deveui ASC',
          [zone.id]
        );
      const cards = deriveCardsForZone(zone, devices);
      for (const card of cards) {
        const sourceDevices = sourceDevicesForCard(card, devices)
          .slice()
          .sort((left, right) =>
            String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
          );
        sourceDevices.forEach((device, index) => {
          const deveui = normalizeDeveui(device.deveui || device.device_eui || device.deviceEui);
          const sourceKey = sourceKeyForCsv(card, device);
          if (!deveui || !sourceKey) return;
          const deviceName = displayDeviceName(device, index);
          for (const channelKey of cardChannelsForSource(card.cardType, displaySafeDeviceContext(device))) {
            const meta = channelMeta(channelKey);
            const seriesId = analysisSeriesId(zone.id, card.cardType, sourceKey, channelKey);
            const entry = {
              seriesId,
              hubEui,
              zoneId: zone.id,
              zoneName: zone.name || null,
              cardType: card.cardType,
              sourceKey,
              channelKey,
              displayName: [deviceName, meta.label].filter(Boolean).join(' - '),
              unit: meta.unit,
              availability: meta.edgeField ? 'available' : 'unsupported',
              deviceName,
              depthCm: soilDepthCm(device, channelKey),
              sourceKind: 'device',
            };
            channels.push(entry);
            entriesById.set(seriesId, { ...entry, deveui, owner: deveui, timezone, provider: null });
          }
        });
      }

      const stations = await dbAll(
        db,
        `${STATION_SOURCES_SQL}${zoneUuids === null ? ' AND d.user_id = ?' : ''} ORDER BY d.deveui ASC`,
        zoneUuids === null ? [zone.id, userId] : [zone.id]
      );
      const addWeatherSource = (sourceKind, sourceKey, deviceName, owner, provider) => {
        for (const channelKey of Object.keys(SOURCE_KINDS[sourceKind].channels)) {
          const meta = channelMeta(channelKey);
          const seriesId = analysisSeriesId(zone.id, 'environment', sourceKey, channelKey);
          const entry = {
            seriesId,
            hubEui,
            zoneId: zone.id,
            zoneName: zone.name || null,
            cardType: 'environment',
            sourceKey,
            channelKey,
            displayName: [deviceName, meta.label].filter(Boolean).join(' - '),
            unit: meta.unit,
            availability: 'available',
            deviceName,
            depthCm: null,
            sourceKind,
          };
          channels.push(entry);
          entriesById.set(seriesId, { ...entry, owner, timezone, provider });
        }
      };

      const located = weather.byZoneId.get(Number(zone.id));
      const locationRow = located && located.locationKey ? weather.rowsByKey.get(located.locationKey) : null;
      if (locationRow) {
        addWeatherSource(
          'weather_provider',
          `weather-src-${sha256Hex(located.locationKey).slice(0, 12)}`,
          providerSourceName(locationRow),
          located.locationKey,
          locationRow.provider
        );
      }
      stations.forEach((device, index) => {
        addWeatherSource(
          'weather_station',
          `station-src-${sha256Hex(normalizeDeveui(device.deveui)).slice(0, 12)}`,
          `${displayDeviceName(device, index)} (hourly)`,
          device.deveui,
          null
        );
      });
      const zoneName = String(zone.name || '').trim();
      addWeatherSource(
        'zone_daily_agronomy',
        'agronomy-src-zone',
        `${zoneName || `Zone ${zone.id}`} daily agronomy`,
        zone.id,
        null
      );
    }

    return { generatedAt: new Date().toISOString(), channels, entriesById };
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
    const lowerMs = Math.floor(Date.parse(range.from) / 1000) * 1000 - (group.kind === 'weather_provider' ? HOUR_MS : 0);
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

  function weatherSeries(entry, rows, range, aggregationInfo) {
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
        }),
        entry.channelKey,
        { stat: channel.stat, expected: channel.stat === 'sum' ? expectedRows(kind.nativeStep, level) : null }
      );
    return {
      seriesId: entry.seriesId,
      resolved: {
        hubEui: entry.hubEui,
        zoneId: entry.zoneId,
        cardType: entry.cardType,
        sourceKey: entry.sourceKey,
        channelKey: entry.channelKey,
      },
      label: entry.displayName,
      unit: channel.stat === 'sum' ? periodUnit(entry.unit, kind.nativeStep, level) : entry.unit,
      points,
      truncated: false,
      cadence: seriesCadence(kind.nativeStep, level),
      timezone: entry.timezone,
    };
  }

  async function resolveAnalysisSeries(db, options = {}) {
    const ids = (Array.isArray(options.selectors) ? options.selectors : [])
      .map((selector) => selector && selector.seriesId)
      .filter(Boolean);
    if (ids.length > MAX_SELECTED_SERIES) {
      throw tooLarge('too many selected series', 'Select fewer series.');
    }

    const range = normalizeRange(options.range || options);
    const aggregationInfo = resolveAggregation({
      aggregation: options.aggregation,
      from: range.from,
      to: range.to,
    });
    const { entriesById } = await buildAnalysisCatalog(db, options);
    const series = [];
    const dropped = [];
    const groups = new Map();

    for (const id of ids) {
      const entry = entriesById.get(id);
      if (!entry) {
        dropped.push({ seriesId: id, reason: 'unknown' });
        continue;
      }
      const kind = entry.sourceKind || 'device';
      const meta = channelMeta(entry.channelKey);
      if (kind === 'device' && !meta.edgeField) {
        dropped.push({ seriesId: id, reason: 'unsupported' });
        continue;
      }
      const key = `${kind}|${entry.owner}`;
      if (!groups.has(key)) groups.set(key, { kind, owner: entry.owner, entries: [] });
      groups.get(key).entries.push({ entry, meta });
    }

    let rawRowsScanned = 0;
    for (const group of groups.values()) {
      const remaining = MAX_RAW_ROWS - rawRowsScanned;
      if (remaining <= 0) {
        throw tooLarge('range too large', 'Narrow the date range or pick a coarser granularity.');
      }
      const rows = group.kind === 'device'
        ? await dbAll(
          db,
          `SELECT deveui, recorded_at, ${unique(group.entries.map(({ meta }) => meta.edgeField)).map(sqlIdent).join(', ')} FROM device_data WHERE deveui = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC LIMIT ?`,
          [group.owner, range.from, range.to, remaining + 1]
        )
        : await readWeatherRows(db, { kind: group.kind, owner: group.owner, entries: group.entries.map(({ entry }) => entry) }, range, remaining + 1);
      if (rows.length > remaining) {
        throw tooLarge('range too large', 'Narrow the date range or pick a coarser granularity.');
      }
      rawRowsScanned += rows.length;
      for (const { entry, meta } of group.entries) {
        if (group.kind !== 'device') {
          series.push(weatherSeries(entry, rows, range, aggregationInfo));
          continue;
        }
        const aggregate = aggregateRows(rows, {
          aggregation: options.aggregation,
          aggregationRequested: aggregationInfo.requested,
          channels: [{ id: entry.channelKey, field: meta.edgeField, unit: entry.unit }],
          from: range.from,
          to: range.to,
        });
        series.push({
          seriesId: entry.seriesId,
          resolved: {
            hubEui: entry.hubEui,
            zoneId: entry.zoneId,
            cardType: entry.cardType,
            sourceKey: entry.sourceKey,
            channelKey: entry.channelKey,
          },
          label: entry.displayName,
          unit: entry.unit,
          points: aggToPoints(aggregate, entry.channelKey),
          truncated: false,
          cadence: 'hourly',
          timezone: entry.timezone,
        });
      }
    }

    return {
      range,
      aggregation: { requested: aggregationInfo.requested, applied: aggregationInfo.level },
      series,
      dropped,
    };
  }

```
`listAnalysisViews` and `saveAnalysisView` stay as they are (`listAnalysisViews` calls `buildAnalysisCatalog(db, user)`, so saved views now keep weather selectors too). Change `module.exports` to:
```js
module.exports = {
  ANALYSIS_VIEWS_SCHEMA,
  DEVICE_EXCLUDED_CHANNELS,
  SOURCE_KINDS,
  analysisSeriesId,
  createAnalysis,
};
```

- [ ] **Step 5: Wire the four dependencies in `index.js`**

After `const { createAnalysis } = require('./analysis');` add:
```js
// The sibling module resolves the same way on the gateway (/srv/node-red/<name>)
// as in the repo; osi-weather-provider requires nothing back, so there is no cycle.
const { zoneLocations } = require('../osi-weather-provider');
```
and replace the `createAnalysis({ … })` call near the end of the file with:
```js
const analysis = createAnalysis({
  aggregateRows,
  dbAll,
  deriveCardsForZone,
  displayDeviceName,
  localDateKey,
  normalizeDeveui,
  normalizeTimezone,
  resolveAggregation,
  soilDepthCm,
  sourceDevicesForCard,
  sourceKeyForCsv,
  zoneDateStartIso,
  zoneLocations,
});
```
`analysis-api-router-fn` keeps calling `osiHistory.buildAnalysisCatalog(db, { deviceEui: deviceEui, userId: auth.userId, zoneUuids: scopeZoneUuids })`; flows.json does not change in this task.

- [ ] **Step 6: Run the tests and the router-level gates**

```bash
cp -r conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/. conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js
node scripts/test-history-helper.js
node --test scripts/test-scoped-access-reads.js
node scripts/verify-history-api-contract.js
node scripts/capture-history-router-vectors.js --verify
node scripts/verify-channel-manifest-parity.js
node scripts/verify-helper-registration.js
node scripts/verify-module-file-deploy-coverage.js
node scripts/flows-bare-require-scan.js
node scripts/verify-osi-lib-db-caller-binding.js
node scripts/verify-profile-parity.js
```
Expected: `analysis.test.js` 27 tests pass (the 30 000-row test takes about half a second), `index.test.js` passes; `test-history-helper.js` only `OK` lines; scoped-access reads all pass; the history API contract verifier passes with the router untouched; `[verify] 4/4 routes passed.`; manifest parity passes; helper registration, deploy coverage (`__fixtures__` holds no top-level runtime file), bare-require scan and caller binding pass unchanged; `All parity checks passed.`

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper scripts/test-history-helper.js scripts/test-scoped-access-reads.js
git -c user.name=Project-OSI commit -m "feat(analysis): provider hours, station hours and the daily agronomy record as data view sources"
```

---

### Task 4: Analysis page (GUI)

**Files:**
- Modify: `web/react-gui/src/analysis/types.ts`, `src/analysis/csv.ts`, `src/analysis/echartsOptions.ts`, `src/components/analysis/AnalysisSeriesTray.tsx`, `src/components/analysis/MetricAcrossZonesPicker.tsx`, `src/components/analysis/AnalysisChartPanel.tsx`, `src/pages/CrossZoneAnalysisPage.tsx`, the seven `public/locales/*/common.json`, `docs/i18n/pending-luganda-translations.md`
- Tests: `src/components/analysis/__tests__/AnalysisSeriesTray.test.tsx`, `MetricAcrossZonesPicker.test.tsx`, `AnalysisChartPanel.test.tsx`, `src/pages/__tests__/CrossZoneAnalysisPage.test.tsx`, `src/analysis/__tests__/echartsOptions.test.ts`, `unitGrouping.test.ts`, `csv.test.ts`, `tests/analysis-locales.test.ts`; fixture fields in the files listed in Step 2
- Scratch: `$SCRATCH/analysis-fixture-fields.js`, `$SCRATCH/analysis-locales.js`

All file paths below are relative to `web/react-gui/` unless they start with `docs/`. Commands state their directory: the two `$SCRATCH` locale scripts write `web/react-gui/public/...` and run from the repository root.

**Interfaces:**
- Consumes: the Task 3 response shapes (`sourceKind` on entries; `cadence`, `timezone` on series; `expected` on weather points; period units `mm/h`, `mm/d`, `mm/wk`).
- Produces: `DAILY_AGRONOMY_SOURCE_KEY = 'agronomy-src-zone'` in `src/analysis/types.ts`; `AnalysisCatalogEntry.sourceKind: string`; `AnalysisSeries.cadence: 'hourly' | 'daily'` and `AnalysisSeries.timezone: string | null`; `AnalysisPoint.expected?: number | null`; `export type PartialFormatter = (point: AnalysisPoint, series: AnalysisSeries) => string` in `echartsOptions.ts`; `TimeSeriesOptionInput.formatPartial?: PartialFormatter`; `buildSmallMultiplesOption(series, normalize, resolveAxisLabel?, formatPartial?)`; locale keys `analysis.aggregation.helpLabel`, `analysis.aggregation.help`, `analysis.tooltip.partialHours`, `analysis.tooltip.partialDays`.

- [ ] **Step 1: Extend the types**

In `src/analysis/types.ts`:
- `AnalysisCatalogEntry`: after `depthCm: number | null;` add
```ts
  /** 'device', 'weather_provider', 'weather_station' or 'zone_daily_agronomy'. */
  sourceKind: string;
```
- `AnalysisPoint`: after `count: number;` add
```ts
  /** Rows a summed weather bucket should hold (24, 168 or 7); absent on device points. */
  expected?: number | null;
```
- `AnalysisSeries`: after `truncated: boolean;` add
```ts
  /** 'daily' when each point stands for one zone-local day. */
  cadence: 'hourly' | 'daily';
  timezone: string | null;
```
- at the end of the file:
```ts

/**
 * sourceKey of every zone's daily agronomy series (osi-history-helper/analysis.js,
 * SOURCE_KINDS.zone_daily_agronomy). A weekly bucket of this kind counts days, not
 * hours, and `cadence` cannot tell it apart (weekly spans are 'hourly' for every kind).
 */
export const DAILY_AGRONOMY_SOURCE_KEY = 'agronomy-src-zone';
```

- [ ] **Step 2: Give the existing test fixtures the new required fields**

`$SCRATCH/analysis-fixture-fields.js`:
```js
// One-shot: give the analysis test fixtures the fields Step 1 makes required.
const fs = require('fs');
const SERIES_FILES = [
  'src/analysis/__tests__/correlation.test.ts',
  'src/analysis/__tests__/correlation.zonePairs.test.ts',
  'src/analysis/__tests__/csv.test.ts',
  'src/analysis/__tests__/echartsOptions.smallMultiples.test.ts',
  'src/analysis/__tests__/echartsOptions.test.ts',
  'src/analysis/__tests__/labelOverrides.test.ts',
  'src/analysis/__tests__/types.test.ts',
  'src/analysis/__tests__/unitGrouping.test.ts',
  'src/components/analysis/__tests__/AnalysisChartPanel.test.tsx',
  'src/components/analysis/__tests__/AnalysisExportMenu.test.tsx',
  'src/components/analysis/__tests__/CorrelationPanel.test.tsx',
];
const ENTRY_FILES = [
  'src/analysis/__tests__/csv.test.ts',
  'src/analysis/__tests__/types.test.ts',
  'src/analysis/__tests__/workspaceMigration.test.ts',
  'src/components/analysis/__tests__/AnalysisSeriesTray.test.tsx',
  'src/components/analysis/__tests__/MetricAcrossZonesPicker.test.tsx',
  'src/pages/__tests__/CrossZoneAnalysisPage.test.tsx',
];
for (const file of SERIES_FILES) {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/truncated: false,/g, "truncated: false, cadence: 'hourly', timezone: null,");
  if (after === before) throw new Error('no series literal in ' + file);
  fs.writeFileSync(file, after);
}
for (const file of ENTRY_FILES) {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/depthCm: ([^,}\n]+?)(\s*)(,|\})/g, (_m, value, space, end) => `depthCm: ${value}, sourceKind: 'device'${end === '}' ? ' }' : ','}`);
  if (after === before) throw new Error('no catalogue literal in ' + file);
  fs.writeFileSync(file, after);
}
console.log('fixtures updated');
```
Run: `(cd web/react-gui && node $SCRATCH/analysis-fixture-fields.js && npm run typecheck)`. Expected: `fixtures updated`, typecheck exit 0 (the literals in these files are the only ones `tsc` rejects once Step 1 lands; `channelLabels.test.ts` and `CrossZoneAnalysisPage.labels.test.tsx` cast or type their literals differently and stay untouched).

- [ ] **Step 3: Write the failing tests**

In `src/components/analysis/__tests__/AnalysisSeriesTray.test.tsx`, change the testing-library import to `import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';` and append inside the last `describe` (before its closing `});`):
```tsx

  it('shows the channel name, not the source name, on each button of a weather source', () => {
    const agronomy: AnalysisCatalogEntry = {
      seriesId: 'a1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'agronomy-src-zone',
      channelKey: 'etc_mm', displayName: 'North daily agronomy - Crop water demand (ETc)', unit: 'mm', availability: 'available',
      deviceName: 'North daily agronomy', depthCm: null, sourceKind: 'zone_daily_agronomy',
    };
    render(<AnalysisSeriesTray channels={[agronomy]} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Crop water demand (ETc)')).toBeInTheDocument();
    expect(screen.queryByText('North daily agronomy - Crop water demand (ETc)')).not.toBeInTheDocument();
    expect(screen.getByText('North daily agronomy')).toBeInTheDocument();
  });

  it('lists a provider source as its own group under the zone', () => {
    const entries: AnalysisCatalogEntry[] = [
      { seriesId: 'd1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'soil', sourceKey: 'soil-src-d1506631a773', channelKey: 'swt_1', displayName: 'Kiwi North - Soil tension (S1)', unit: 'kPa', availability: 'available', deviceName: 'Kiwi North', depthCm: null, sourceKind: 'device' },
      { seriesId: 'p1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey: 'et0_mm', displayName: 'Open-Meteo 46.80°N 6.95°E - Reference ET (ET0)', unit: 'mm', availability: 'available', deviceName: 'Open-Meteo 46.80°N 6.95°E', depthCm: null, sourceKind: 'weather_provider' },
    ];
    render(<AnalysisSeriesTray channels={entries} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Kiwi North')).toBeInTheDocument();
    expect(screen.getByText('Open-Meteo 46.80°N 6.95°E')).toBeInTheDocument();
    expect(screen.getByText('Soil tension (S1)')).toBeInTheDocument();
    expect(screen.getByText('Reference ET (ET0)')).toBeInTheDocument();
  });

  it('names each source group, so buttons with one channel label stay apart for a screen reader', () => {
    const temperature = (seriesId: string, sourceKey: string, deviceName: string, sourceKind: string): AnalysisCatalogEntry => ({
      seriesId, hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey, channelKey: 'ambient_temperature',
      displayName: `${deviceName} - Air temperature`, unit: '°C', availability: 'available', deviceName, depthCm: null, sourceKind,
    });
    const entries = [
      temperature('s1', 'env-src-0123456789ab', 'demo-s2120', 'device'),
      temperature('p1', 'weather-src-0123456789ab', 'Open-Meteo 46.80°N 6.95°E', 'weather_provider'),
    ];
    render(<AnalysisSeriesTray channels={entries} selectedIds={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    const device = screen.getByRole('group', { name: 'demo-s2120' });
    const provider = screen.getByRole('group', { name: 'Open-Meteo 46.80°N 6.95°E' });
    expect(within(device).getByRole('button', { name: /Air temperature/ })).toBeInTheDocument();
    expect(within(provider).getByRole('button', { name: /Air temperature/ })).toBeInTheDocument();
  });
```

Append inside the `describe` of `src/components/analysis/__tests__/MetricAcrossZonesPicker.test.tsx`:
```tsx

  it('offers device channels only, so weather sources add no button', () => {
    const withWeather: AnalysisCatalogEntry[] = [
      ...channels,
      { seriesId: 'p1', hubEui: 'HUB-1', zoneId: 1, zoneName: 'North', cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey: 'et0_mm', displayName: 'Open-Meteo 46.80°N 6.95°E - Reference ET (ET0)', unit: 'mm', availability: 'available', deviceName: 'Open-Meteo 46.80°N 6.95°E', depthCm: null, sourceKind: 'weather_provider' },
      { seriesId: 'p2', hubEui: 'HUB-1', zoneId: 2, zoneName: 'South', cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey: 'wind_speed_mps', displayName: 'Open-Meteo 46.80°N 6.95°E - Wind speed', unit: 'm/s', availability: 'available', deviceName: 'Open-Meteo 46.80°N 6.95°E', depthCm: null, sourceKind: 'weather_provider' },
    ];
    render(<MetricAcrossZonesPicker channels={withWeather} onApply={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Reference ET/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Wind speed/ })).not.toBeInTheDocument();
  });
```

Append inside the `describe` of `src/pages/__tests__/CrossZoneAnalysisPage.test.tsx`:
```tsx

  it('selects device series only when two zones on one location list provider temperatures', () => {
    const base = loadedCatalogState();
    const provider = (seriesId: string, zoneId: number, zoneName: string, channelKey: string, unit: string): AnalysisCatalogEntry => ({
      seriesId, hubEui: 'HUB-1', zoneId, zoneName, cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey,
      displayName: `Open-Meteo 46.80°N 6.95°E - ${channelKey}`, unit, availability: 'available',
      deviceName: 'Open-Meteo 46.80°N 6.95°E', depthCm: null, sourceKind: 'weather_provider',
    });
    catalogState = {
      ...base,
      catalog: {
        generatedAt: 'now',
        channels: [
          ...base.catalog.channels,
          provider('p1', 1, 'North', 'ambient_temperature', '°C'),
          provider('p2', 2, 'South', 'ambient_temperature', '°C'),
          provider('p3', 1, 'North', 'et0_mm', 'mm'),
        ],
      },
    };
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByRole('button', { name: 'analysis.layout.overlaid' }));
    const preset = screen.getByRole('region', { name: 'analysis.preset.metricLabel' });
    expect(within(preset).queryByRole('button', { name: /et0_mm/ })).not.toBeInTheDocument();
    fireEvent.click(within(preset).getByRole('button', { name: /^Air temperature/ }));
    expect(getSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectors: [{ seriesId: ambientTemperatureSeriesId }] }),
    );
  });

  it('explains the aggregation in a HelpTip beside the badge', () => {
    catalogState = loadedCatalogState();
    render(<CrossZoneAnalysisPage />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByText('SWT 1'));
    expect(screen.queryByText('analysis.aggregation.help')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'analysis.aggregation.helpLabel' }));
    expect(screen.getByText('analysis.aggregation.help')).toBeInTheDocument();
  });
```

Append inside the `describe` of `src/analysis/__tests__/unitGrouping.test.ts`:
```ts

  it('keeps daily totals and hourly rain on separate panels', () => {
    const panels = groupByUnit([s('daily-rain', 'mm/d'), s('hourly-rain', 'mm/h')]);
    expect(panels.map((p) => p.unit)).toEqual(['mm/d', 'mm/h']);
    expect(isOverlay(panels)).toBe(false);
  });
```

Append inside the `describe` of `src/analysis/__tests__/csv.test.ts`:
```ts

  it('writes the zone-local date for a daily series and the instant for an hourly weather series', () => {
    const daily: AnalysisSeries = {
      seriesId: 'et0',
      resolved: { hubEui: 'HUB-1', zoneId: 1, cardType: 'environment', sourceKey: 'agronomy-src-zone', channelKey: 'et0_mm' },
      label: 'North daily agronomy - Reference ET (ET0)', unit: 'mm/d', coveragePct: null,
      points: [{ t: '2026-09-24T22:00:00.000Z', value: 3.1, count: 1, expected: null, quality: null }],
      truncated: false, cadence: 'daily', timezone: 'Europe/Zurich',
    };
    const provider: AnalysisSeries = {
      seriesId: 'rain',
      resolved: { hubEui: 'HUB-1', zoneId: 1, cardType: 'environment', sourceKey: 'weather-src-0123456789ab', channelKey: 'rain_mm_per_hour' },
      label: 'Open-Meteo 46.80°N 6.95°E - Rain rate', unit: 'mm/h', coveragePct: null,
      points: [{ t: '2026-09-24T22:00:00.000Z', value: 0.4, count: 1, expected: null, quality: null }],
      truncated: false, cadence: 'hourly', timezone: 'Europe/Zurich',
    };
    const lines = toTidyCsv([daily, provider], new Map()).split('\n');
    expect(lines[1]).toBe('2026-09-25,HUB-1,1,North daily agronomy - Reference ET (ET0),environment,agronomy-src-zone,et0_mm,,,mm/d,3.1');
    expect(lines[2]).toBe('2026-09-24T22:00:00.000Z,HUB-1,1,Open-Meteo 46.80°N 6.95°E - Rain rate,environment,weather-src-0123456789ab,rain_mm_per_hour,,,mm/h,0.4');
    const invalidZone = toTidyCsv([{ ...daily, timezone: 'Not/AZone' }], new Map()).split('\n');
    expect(invalidZone[1].startsWith('2026-09-24,')).toBe(true);
  });
```

In `src/analysis/__tests__/echartsOptions.test.ts`, change the type import to `import type { AnalysisPoint, AnalysisSeries } from '../types';` and append at the end of the file:
```ts

describe('weather series', () => {
  const hoursPartial = (point: AnalysisPoint) => (point.quality === 'partial' ? ` (${point.count} of ${point.expected} h)` : '');
  const tooltipFormatter = (option: Record<string, unknown>) => (option.tooltip as { formatter: (params: unknown) => string }).formatter;
  const visibleText = (html: string) => html.replace(/<[^>]*>/g, '');

  it('draws symbols for a daily-cadence series so a lone valid day stays visible', () => {
    const daily: AnalysisSeries = { ...series('et0', 'mm/d', [null, 1.2, null]), cadence: 'daily' };
    const hourly = series('rain', 'mm/h', [0.1, 0.2, 0.3]);
    const option = buildTimeSeriesOption({ panels: groupByUnit([daily, hourly]), series: [daily, hourly], normalize: false, multiAxis: false });
    const drawn = option.series as Array<{ name: string; showSymbol: boolean; symbolSize?: number }>;
    expect(drawn.find((s) => s.name === 'et0')).toMatchObject({ showSymbol: true, symbolSize: 4 });
    expect(drawn.find((s) => s.name === 'rain')?.showSymbol).toBe(false);
    const multiples = buildSmallMultiplesOption([daily], false);
    expect((multiples.series as Array<{ showSymbol: boolean }>)[0].showSymbol).toBe(true);
  });

  it('ends the tooltip row of a partial point with its count, in the default tooltip layout', () => {
    const rain: AnalysisSeries = { ...series('rain', 'mm/d', [4.2, 3.1]), cadence: 'daily' };
    rain.points[0] = { ...rain.points[0], count: 23, expected: 24, quality: 'partial' };
    const option = buildTimeSeriesOption({ panels: groupByUnit([rain]), series: [rain], normalize: false, multiAxis: false, formatPartial: hoursPartial });
    const formatter = tooltipFormatter(option);
    const partial = formatter([{ seriesIndex: 0, dataIndex: 0, marker: '', seriesName: 'rain', value: [rain.points[0].t, 4.2], axisValueLabel: '2026-06-18 00:00' }]);
    expect(visibleText(partial)).toBe('2026-06-18 00:00rain4.2 (23 of 24 h)');
    expect(partial).toContain('float:right');
    expect(partial).toContain('font-weight:900');
    expect(visibleText(formatter([{ seriesIndex: 0, dataIndex: 1, marker: '', seriesName: 'rain', value: [rain.points[1].t, 3.1] }]))).toBe('rain3.1');
    const escaped = formatter([{ seriesIndex: 0, dataIndex: 1, marker: '', seriesName: '<b>x</b>', value: [rain.points[1].t, 3.1] }]);
    expect(escaped).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(escaped).not.toContain('<b>');
  });

  it('finds the hovered point in ECharts series order in the stacked layout', () => {
    // Stacked is the workspace default; ECharts draws the panels' series in
    // panel order, [a, c, b] here, not in the order of `series`.
    const a = series('a', 'kPa', [10, 11]);
    const b: AnalysisSeries = { ...series('b', 'mm/d', [4.2, 3.1]), cadence: 'daily' };
    b.points[0] = { ...b.points[0], count: 23, expected: 24, quality: 'partial' };
    const c = series('c', 'kPa', [12, 13]);
    const input = [a, b, c];
    const option = buildTimeSeriesOption({ panels: groupByUnit(input), series: input, normalize: false, multiAxis: false, formatPartial: hoursPartial });
    expect((option.series as Array<{ name: string }>).map((s) => s.name)).toEqual(['a', 'c', 'b']);
    const formatter = tooltipFormatter(option);
    const hover = (seriesIndex: number, seriesName: string, value: number) => visibleText(
      formatter([{ seriesIndex, dataIndex: 0, marker: '', seriesName, value: ['2026-06-18T00:00:00Z', value] }]),
    );
    expect(hover(2, 'b', 4.2)).toBe('b4.2 (23 of 24 h)');
    expect(hover(1, 'c', 12)).toBe('c12.0');
  });
});
```

In `src/components/analysis/__tests__/AnalysisChartPanel.test.tsx`, the test `routes small-multiples layout to the small-multiples builder with normalize` now expects the fourth argument:
```tsx
    expect(buildSmallMultiplesOption).toHaveBeenCalledWith(series, true, expect.any(Function), expect.any(Function));
```
and append inside its `describe`:
```tsx

  it('hands the builders a partial formatter that counts hours, or days for daily agronomy', () => {
    const rain: AnalysisSeries = { ...s('rain', 'mm/d'), cadence: 'daily' };
    render(<AnalysisChartPanel series={[rain]} mode="timeline" layout="stacked" toggles={{ normalize: false }} channelMeta={new Map()} />);
    const { formatPartial } = vi.mocked(buildTimeSeriesOption).mock.calls[0][0];
    const partial = { t: '2026-09-24T22:00:00.000Z', value: 2.3, count: 23, expected: 24, quality: 'partial' };
    expect(formatPartial?.(partial, rain)).toBe('analysis.tooltip.partialHours');
    const agronomy: AnalysisSeries = { ...rain, resolved: { ...rain.resolved, sourceKey: 'agronomy-src-zone' } };
    expect(formatPartial?.({ ...partial, count: 6, expected: 7 }, agronomy)).toBe('analysis.tooltip.partialDays');
    expect(formatPartial?.({ ...partial, quality: null }, rain)).toBe('');
  });
```

Append to `tests/analysis-locales.test.ts`:
```ts

test('the weather data view keys resolve in all seven locales with matching placeholders', () => {
  const keys = ['aggregation.helpLabel', 'aggregation.help', 'tooltip.partialHours', 'tooltip.partialDays'];
  // lg ships the English text until a human pass; a translated key leaves this
  // set and docs/i18n/pending-luganda-translations.md in the same change.
  const PENDING_HUMAN_LUGANDA = new Set(keys);
  const pick = (tree: unknown, key: string) => key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  const analysisOf = (language: string) => JSON.parse(readFileSync(join(localesRoot, language, 'common.json'), 'utf8')).analysis;
  const english = analysisOf('en');
  for (const language of ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
    const analysis = analysisOf(language);
    for (const key of keys) {
      const value = pick(analysis, key);
      assert.equal(typeof value, 'string', `${language} analysis.${key} is missing`);
      assert.equal(placeholders(value as string), placeholders(pick(english, key) as string), `${language} analysis.${key} placeholders`);
      if (language === 'lg' && PENDING_HUMAN_LUGANDA.has(key)) {
        assert.equal(value, pick(english, key), `lg analysis.${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`);
      }
      if (language === 'de-CH') assert.ok(!(value as string).includes('ß'), `de-CH analysis.${key} uses ß`);
    }
  }
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run the two halves of `test:unit` separately, so a tsx-runner failure does not hide the vitest ones (`npm run test:unit` joins them with `&&`):
```bash
(cd web/react-gui && npx tsx --test tests/analysis-locales.test.ts)
(cd web/react-gui && npx vitest run src/components/analysis/__tests__/AnalysisSeriesTray.test.tsx src/components/analysis/__tests__/MetricAcrossZonesPicker.test.tsx src/components/analysis/__tests__/AnalysisChartPanel.test.tsx src/pages/__tests__/CrossZoneAnalysisPage.test.tsx src/analysis/__tests__/echartsOptions.test.ts src/analysis/__tests__/unitGrouping.test.ts src/analysis/__tests__/csv.test.ts)
```
Expected: the tsx runner fails the new locale test (keys missing). Vitest fails the first two new tray tests (button text is the full display name) and the group test (no `group` role), the picker test (four buttons), the page preset test (`p1`, `p2` selected) and HelpTip test (no button), the CSV test (instant instead of `2026-09-25`), the three echarts tests (`showSymbol` false, no `formatter`), both chart panel tests (no fourth argument, no `formatPartial`). The unit grouping test passes already (units are grouped as given); it is a regression pin, not a red test. Every other test in these files stays green.

- [ ] **Step 5: Implement the tray label, the preset filter and the HelpTip**

`src/components/analysis/AnalysisSeriesTray.tsx`, replace `function channelLabel(channel: AnalysisCatalogEntry): string { … }` with:
```tsx
// The backend joins source and channel as `${deviceName} - ${label}`
// (osi-history-helper/analysis.js); the source is the group heading, so the
// button shows the channel alone.
function channelLabel(channel: AnalysisCatalogEntry): string {
  if (!channel.deviceName) return channel.displayName;
  for (const separator of [' - ', ': ']) {
    const prefix = `${channel.deviceName}${separator}`;
    if (channel.displayName.startsWith(prefix)) return channel.displayName.slice(prefix.length);
  }
  return channel.displayName;
}
```
With the source gone from the button, several buttons of one zone can read "Air temperature" (the S2120, the provider, the station hours). Each source group therefore becomes a named group, so a screen reader announces the source before the buttons; the visible text is unchanged:
- the React import becomes `import { useId, useMemo, useState } from 'react';`, and after `const [query, setQuery] = useState('');` add `  const trayId = useId();`;
- `{groups.map((group) => (` becomes `{groups.map((group, groupIndex) => (`;
- replace
```tsx
            {group.devices.map((deviceGroup) => (
              <div key={deviceGroup.key} className="mb-2 last:mb-0">
                {deviceGroup.deviceName ? (
                  <div className="mb-1 px-1 text-xs font-semibold text-[var(--text)]">{deviceGroup.deviceName}</div>
                ) : null}
```
with
```tsx
            {group.devices.map((deviceGroup, deviceIndex) => {
              // Buttons show the channel alone; the group name carries the source.
              const headingId = `${trayId}-source-${groupIndex}-${deviceIndex}`;
              return (
              <div
                key={deviceGroup.key}
                className="mb-2 last:mb-0"
                role={deviceGroup.deviceName ? 'group' : undefined}
                aria-labelledby={deviceGroup.deviceName ? headingId : undefined}
              >
                {deviceGroup.deviceName ? (
                  <div id={headingId} className="mb-1 px-1 text-xs font-semibold text-[var(--text)]">{deviceGroup.deviceName}</div>
                ) : null}
```
- and replace the end of that map
```tsx
                </ul>
              </div>
            ))}
```
with
```tsx
                </ul>
              </div>
              );
            })}
```

`src/components/analysis/MetricAcrossZonesPicker.tsx`, in `availableMetricOptions` replace `    if (channel.availability !== 'available') continue;` with:
```tsx
    // Weather sources would add identical series for zones on one location.
    if (channel.sourceKind !== 'device' || channel.availability !== 'available') continue;
```

`src/pages/CrossZoneAnalysisPage.tsx`:
- after `import { AppHeader } from '../components/AppHeader';` add `import { HelpTip } from '../components/farming/shared/HelpTip';`
- in `applyMetricPreset`, the filter becomes
```tsx
      .filter((channel) => (
        channel.sourceKind === 'device'
        && channel.availability === 'available'
        && canonicalize(channel.channelKey) === canonicalChannelKey
      ))
```
- the aggregation badge block becomes
```tsx
              {data?.aggregation.applied ? (
                <div className="flex max-w-xl flex-wrap items-center gap-1.5">
                  <div className="inline-flex w-fit items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                    <span className="font-medium">{t('analysis.aggregation.label')}</span>
                    <span>
                      {aggregationLabel(data.aggregation.applied)}
                    </span>
                  </div>
                  <HelpTip label={t('analysis.aggregation.helpLabel')}>
                    {t('analysis.aggregation.help')}
                  </HelpTip>
                </div>
              ) : null}
```
The wrapper is `flex-wrap`, so the HelpTip panel (`basis-full`) drops onto its own line under the badge.

- [ ] **Step 6: Implement symbols, the partial tooltip and the CSV date**

`src/analysis/echartsOptions.ts`:
- import line: `import type { AnalysisPoint, AnalysisSeries } from './types';`
- in `TimeSeriesOptionInput`, after `resolveAxisLabel?: …;` add `  formatPartial?: PartialFormatter;`, and after the interface add
```ts

/** Text appended to a tooltip value, e.g. " (23 of 24 h)" for a partial sum; '' for none. */
export type PartialFormatter = (point: AnalysisPoint, series: AnalysisSeries) => string;
```
- after `const Y_AXIS_GRID_LEFT = 80;` add
```ts

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The markup of ECharts 5.6's default axis tooltip (component/tooltip/tooltipMarkup.js
// with the default text style): a grey header, then per series the marker, the name
// on the left and the value in bold on the right. The formatter below replaces that
// default for every series of a chart that passes formatPartial, device series
// included, so it rebuilds the same rows.
const TOOLTIP_NAME_STYLE = 'font-size:12px;color:#6e7079;font-weight:400';
const TOOLTIP_VALUE_STYLE = 'font-size:14px;color:#464646;font-weight:900';

function tooltipBlock(content: string, topGap: number): string {
  return `<div style="margin: ${topGap}px 0 0;line-height:1;">${content}<div style="clear:both"></div></div>`;
}

function tooltipRow(marker: string, name: string, value: string, topGap: number): string {
  return tooltipBlock(
    `${marker}<span style="${TOOLTIP_NAME_STYLE};margin-left:2px">${escapeHtml(name)}</span>`
      + `<span style="float:right;margin-left:20px;${TOOLTIP_VALUE_STYLE}">${escapeHtml(value)}</span>`,
    topGap,
  );
}

interface AxisTooltipParam {
  seriesIndex?: number;
  dataIndex?: number;
  marker?: string;
  seriesName?: string;
  value?: unknown;
  axisValueLabel?: string;
}

// `drawn` lists the series in ECharts series order, so a hovered
// (seriesIndex, dataIndex) finds its AnalysisPoint and the partial marker.
function axisTooltip(drawn: AnalysisSeries[], formatPartial?: PartialFormatter): Record<string, unknown> {
  // Callers without formatPartial (the builder tests) keep ECharts' own tooltip.
  if (!formatPartial) return { trigger: 'axis', valueFormatter: tooltipValueFormatter };
  return {
    trigger: 'axis',
    valueFormatter: tooltipValueFormatter,
    formatter: (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as AxisTooltipParam[];
      const rows = list.map((param, index) => {
        const item = drawn[param.seriesIndex ?? -1];
        const point = item?.points[param.dataIndex ?? -1];
        const raw = Array.isArray(param.value) ? param.value[1] : param.value;
        const text = tooltipValueFormatter(typeof raw === 'number' ? raw : null);
        const suffix = item && point ? formatPartial(point, item) : '';
        return tooltipRow(param.marker ?? '', param.seriesName ?? '', `${text}${suffix}`, index > 0 ? 10 : 0);
      }).join('');
      const header = list[0]?.axisValueLabel;
      return header
        ? tooltipBlock(`<div style="${TOOLTIP_NAME_STYLE};line-height:1;">${escapeHtml(header)}</div>${tooltipBlock(rows, 10)}`, 0)
        : tooltipBlock(rows, 0);
    },
  };
}

// A daily point between two null days has no line to either side; its symbol
// keeps it visible. Hourly and device series keep today's plain line.
function symbolSpec(s: AnalysisSeries): Record<string, unknown> {
  return s.cadence === 'daily' ? { showSymbol: true, symbolSize: 4 } : { showSymbol: false };
}
```
- in `lineSeries` and in the `echSeries` map of `buildSmallMultiplesOption`, replace `showSymbol: false,` with `...symbolSpec(s),`;
- in `buildTimeSeriesOption`, the single-grid return uses `tooltip: axisTooltip(series, input.formatPartial),`; in the stacked branch add `  const drawn = panels.flatMap((panel) => panel.seriesIds.map((id) => byId.get(id) as AnalysisSeries));` before its `return {` and use `tooltip: axisTooltip(drawn, input.formatPartial),`;
- `buildSmallMultiplesOption` gains the parameter `formatPartial?: PartialFormatter,` after `resolveAxisLabel` and returns `tooltip: axisTooltip(series, formatPartial),`. The correlation option is unchanged.

`AnalysisChartPanel` always passes `formatPartial`, so on the analysis page this formatter replaces ECharts' default axis tooltip for every series, device series included; the plan review accepted that. The rows copy the default layout, so a device series looks as it does today and a partial weather point gains its suffix. ECharts renders a function formatter's output as HTML and `src/i18n/config.ts` sets `escapeValue: false`, so the header, every series name and the translated suffix go through `escapeHtml`; the marker is ECharts' own HTML.

`src/components/analysis/AnalysisChartPanel.tsx`:
- `import { lazy, Suspense, useCallback, useMemo, useState, type Ref } from 'react';` and `import { DAILY_AGRONOMY_SOURCE_KEY, type AnalysisPoint, type AnalysisSeries, type AnalysisWorkspaceMode, type TimelineLayout } from '../../analysis/types';`
- before `const timeSeriesPanels = useMemo(() => {` add
```tsx
  // A summed weather bucket with missing rows: " (23 of 24 h)", or days for
  // a weekly bucket of daily agronomy.
  const formatPartial = useCallback((point: AnalysisPoint, item: AnalysisSeries) => {
    if (point.quality !== 'partial' || point.expected == null) return '';
    const key = item.resolved.sourceKey === DAILY_AGRONOMY_SOURCE_KEY ? 'analysis.tooltip.partialDays' : 'analysis.tooltip.partialHours';
    return t(key, { count: point.count, expected: point.expected });
  }, [t]);

```
- pass `formatPartial` to both `buildTimeSeriesOption` calls (after `resolveAxisLabel,`) and as the fourth argument of `buildSmallMultiplesOption`, and add `formatPartial` to both `useMemo` dependency arrays.

`src/analysis/csv.ts`: insert before `function escape(value: string): string {`
```ts
// A daily-cadence point stands for one zone-local day, so its row carries
// that date; an invalid zone timezone falls back to UTC as the backend does.
function localDate(t: string, timeZone: string | null): string {
  const format = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(t));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}

```
and in `toTidyCsv` make the first cell of each row
```ts
        item.cadence === 'daily' ? localDate(point.t, item.timezone) : point.t,
```
Do not run `npm run typecheck` between this step and Step 7: `src/types/i18next.d.ts` types the `common` keys, so `t('analysis.aggregation.helpLabel')` compiles only once Step 7 writes the English bundle. Step 8 typechecks.

- [ ] **Step 7: Locale keys (seven bundles, `lg` in English)**

`$SCRATCH/analysis-locales.js`:
```js
// One-shot: the four analysis.* keys of the weather data view in all seven
// common.json bundles. lg carries the English text (edge lg policy).
const fs = require('fs');
const EN_HELP = 'Raw points sit at the reading\'s time; at 15-minute, hourly, daily and weekly aggregation each point sits at the start of its period, and for weather sources a day is the zone\'s local day. Rain, ET0 and ETc from a weather provider, a station\'s hourly record or daily agronomy are totals for that period, and other values are means. Open-Meteo hourly temperature, humidity and wind are values at the time shown. Weather sources show no finer detail than one hour, or one day for daily agronomy.';
const TEXT = {
  en: ['About aggregation', EN_HELP, ' ({{count}} of {{expected}} h)', ' ({{count}} of {{expected}} d)'],
  lg: ['About aggregation', EN_HELP, ' ({{count}} of {{expected}} h)', ' ({{count}} of {{expected}} d)'],
  'de-CH': [
    'Über die Aggregation',
    'Ohne Aggregation (Rohdaten) liegt jeder Punkt beim Zeitpunkt der Messung; bei 15-Minuten-, stündlicher, täglicher und wöchentlicher Aggregation liegt er am Anfang seines Zeitraums, und bei Wetterquellen ist ein Tag der lokale Tag der Zone. Regen, ET0 und ETc von einem Wetteranbieter, aus den Stundenwerten einer Station oder aus «daily agronomy» sind Summen für diesen Zeitraum, alle anderen Werte sind Mittelwerte. Stündliche Temperatur, Luftfeuchtigkeit und Wind von Open-Meteo sind Werte zum angezeigten Zeitpunkt. Wetterquellen sind höchstens stündlich aufgelöst, «daily agronomy» täglich.',
    ' ({{count}} von {{expected}} h)',
    ' ({{count}} von {{expected}} Tagen)',
  ],
  fr: [
    'À propos de l\'agrégation',
    'En agrégation brute, chaque point est à l\'heure de la mesure ; en agrégation de 15 minutes, horaire, quotidienne ou hebdomadaire, il est au début de sa période, et pour les sources météo un jour est le jour local de la zone. La pluie, l\'ET0 et l\'ETc d\'un fournisseur météo, des valeurs horaires d\'une station ou de « daily agronomy » sont des totaux pour cette période ; les autres valeurs sont des moyennes. La température, l\'humidité et le vent horaires d\'Open-Meteo sont des valeurs à l\'heure affichée. Les sources météo ont une résolution d\'une heure au mieux, d\'un jour pour « daily agronomy ».',
    ' ({{count}} sur {{expected}} h)',
    ' ({{count}} sur {{expected}} j)',
  ],
  it: [
    'Informazioni sull\'aggregazione',
    'Nell\'aggregazione grezza ogni punto sta all\'ora della misura; nell\'aggregazione di 15 minuti, oraria, giornaliera o settimanale sta all\'inizio del suo periodo, e per le fonti meteo un giorno è il giorno locale della zona. Pioggia, ET0 ed ETc di un fornitore meteo, dei valori orari di una stazione o di «daily agronomy» sono totali del periodo; gli altri valori sono medie. Temperatura, umidità e vento orari di Open-Meteo sono valori all\'ora indicata. Le fonti meteo hanno al massimo una risoluzione oraria, «daily agronomy» giornaliera.',
    ' ({{count}} di {{expected}} h)',
    ' ({{count}} di {{expected}} g)',
  ],
  es: [
    'Acerca de la agregación',
    'Sin agregación, cada punto está en la hora de la medición; con agregación de 15 minutos, por hora, diaria o semanal, está al inicio de su periodo, y para las fuentes meteorológicas un día es el día local de la zona. La lluvia, la ET0 y la ETc de un proveedor meteorológico, de los valores horarios de una estación o de «daily agronomy» son totales del periodo; los demás valores son medias. La temperatura, la humedad y el viento horarios de Open-Meteo son valores a la hora indicada. Las fuentes meteorológicas tienen como máximo una resolución horaria, y «daily agronomy» diaria.',
    ' ({{count}} de {{expected}} h)',
    ' ({{count}} de {{expected}} d)',
  ],
  pt: [
    'Sobre a agregação',
    'Sem agregação, cada ponto fica à hora da medição; com agregação de 15 minutos, horária, diária ou semanal, fica no início do seu período, e para as fontes meteorológicas um dia é o dia local da zona. A chuva, a ET0 e a ETc de um fornecedor meteorológico, dos valores horários de uma estação ou de «daily agronomy» são totais do período; os restantes valores são médias. A temperatura, a humidade e o vento horários do Open-Meteo são valores à hora indicada. As fontes meteorológicas têm no máximo uma resolução horária, e «daily agronomy» diária.',
    ' ({{count}} de {{expected}} h)',
    ' ({{count}} de {{expected}} d)',
  ],
};
for (const [locale, [helpLabel, help, partialHours, partialDays]] of Object.entries(TEXT)) {
  const file = `web/react-gui/public/locales/${locale}/common.json`;
  const before = fs.readFileSync(file, 'utf8');
  const bundle = JSON.parse(before);
  if (JSON.stringify(bundle, null, 2) + '\n' !== before) throw new Error(`${file} does not round-trip`);
  Object.assign(bundle.analysis.aggregation, { helpLabel, help });
  bundle.analysis.tooltip = { partialHours, partialDays };
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
}
console.log('analysis keys written to 7 bundles');
```
Run (from the repository root): `node $SCRATCH/analysis-locales.js`. Expected: `analysis keys written to 7 bundles`. The English help text is the spec's ("Analysis page (GUI)", "Aggregation badge") byte for byte. The tray names the daily agronomy group in English in every language (`<zone> daily agronomy`, built by the backend), so the translations quote that name as «daily agronomy» (« daily agronomy » in fr). Model output is called values (Werte, valeurs, valori, valores), never readings; the raw level describes a device reading's time.

In `docs/i18n/pending-luganda-translations.md`, add before `## Related keys not listed here`:
```markdown
## `common.json` — weather data view

| Keys | Reason |
|---|---|
| `analysis.aggregation.helpLabel`, `analysis.aggregation.help`, `analysis.tooltip.partialHours`, `analysis.tooltip.partialDays` (4 keys in `common.json`) | Added by the weather data view (the Data tab's aggregation tip and the partial-sum marker, 2026-09-27). No human Luganda pass yet, so `lg` ships the English source text. The keys are listed in `analysis-locales.test.ts`. |

Tracked in code at `web/react-gui/tests/analysis-locales.test.ts`, which
asserts each key's `lg` value is still byte-identical to `en`. A human Luganda
pass must drop the key from that test's `PENDING_HUMAN_LUGANDA` set and from
the table above in the same change.

```

- [ ] **Step 8: Run the gates**

```bash
(cd web/react-gui && npm run test:unit && npm run typecheck)
node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md
```
Expected: `test:unit` green (tsx runner `# fail 0`, vitest all files passed); typecheck exit 0; `slop-check: PASS`.

- [ ] **Step 9: Commit**

```bash
git add web/react-gui/src web/react-gui/tests web/react-gui/public/locales docs/i18n/pending-luganda-translations.md
git -c user.name=Project-OSI commit -m "feat(gui): weather sources on the analysis page: channel labels, device-only preset, aggregation tip, partial marks, daily CSV dates"
```

---

### Task 5: Migration 0063 and the zone trigger artefacts

**Files:**
- Create: `database/migrations/ordered/0063__zone_weather_source_sync.sql` (written from the canonical source by the Step 3 script), `scripts/test-zone-weather-source.js`
- Modify: `scripts/sync-trigger-source.json` (entry `trg_sync_zones_outbox_au`), both `flows.json` (`sync-init-fn` generated region only, by `generate-sync-trigger-source.js --write`), `database/seed-blank.sql` (the trigger at lines 2267–2352), `database/migrations/ordered/CHECKSUMS.json`, the seven bundled DBs (by `scripts/build-seed-db.js`), `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` (lines 62, 77), `scripts/reconcile-ledger-numbering.test.js` (the two lineage tests), `scripts/fixtures/terra-edge-selection/edge-selection-v1.json` and `.sha256` (regenerated), `scripts/verify-sync-flow.js`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`, `.github/workflows/verify-sync-flow.yml`
- Unchanged by design: `MIGRATION_OWNED_TRIGGERS` (`verify-runtime-schema-parity.js`), `MIGRATION_OWNED_TRIGGER_NAMES` (`verify-trigger-body-parity.js`), the `owners` statement lists in `sync-trigger-source.json`, `trg_sync_zones_outbox_ai`
- Scratch: `$SCRATCH/trigger-0063.js`, `$SCRATCH/seed-0063.js`, `$SCRATCH/ratchet.js` (shared with Tasks 6 and 7)

**Interfaces:**
- Produces: every `ZONE` outbox payload carries `'weather_source'` (`COALESCE(NEW.weather_source, 'auto')`); a change of `weather_source` alone emits `ZONE_CONFIG_UPSERTED`; the ACK `payloadHash` of `osi-zone-commands` (a hash of that payload) changes accordingly, which is why the Terra fixture is regenerated here. Tasks 6 and 7 append to `scripts/test-zone-weather-source.js` and re-measure the same ratchet entries.

- [ ] **Step 1: Write the failing test and put it in CI**

`scripts/test-zone-weather-source.js`:
```js
#!/usr/bin/env node
'use strict';

// weather_source round trip on the edge (spec
// docs/superpowers/specs/2026-09-27-weather-data-view-design.md): the zone
// update trigger of migration 0063 on every bundled database, the zone write
// route and zone list, and the legacy "Build UPDATE SQL" command path. The
// route and command tests run the shipped function-node source through
// scripts/lib/scoped-access-harness.js; the trigger tests run on copies of
// the bundled databases, as scripts/test-zone-update-sync-version.js does.
//
// Run: node --test scripts/test-zone-weather-source.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode, makeAuthHeader } = require('./lib/scoped-access-harness');
const { SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = 'AA00000000000001';
const ZONE_UUID = '306fa8ef-20f8-4911-b9c4-f99f60252579';
const USER_UUID = '55555555-5555-4555-8555-555555555555';
const SECRET = 'zone-weather-source-secret';

function bundledCopy(t, relativePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(path.join(ROOT, relativePath), dbPath);
  const db = new DatabaseSync(dbPath);
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', datetime('now'))");
  db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, created_at, updated_at) '
    + `VALUES (11, 'North', 7, '${ZONE_UUID}', '${GATEWAY}', 1, 'UTC', datetime('now'), datetime('now'))`);
  return db;
}

function link(db) {
  db.exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) "
    + `VALUES ('cloud', 1, '${GATEWAY}', datetime('now'))`);
}

function zoneEvents(db) {
  return db.prepare("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE' ORDER BY rowid").all()
    .map((row) => ({ op: row.op, syncVersion: Number(row.sync_version), payload: JSON.parse(row.payload_json) }));
}

for (const relativePath of SEED_DB_RELATIVE_PATHS) {
  test(`[${relativePath}] 0063: a provider change alone emits one ZONE_CONFIG_UPSERTED carrying the value`, (t) => {
    const db = bundledCopy(t, relativePath);
    link(db);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET weather_source = 'meteoswiss', sync_version = 2 WHERE id = 11");
    const events = zoneEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_CONFIG_UPSERTED');
    assert.equal(events[0].payload.weather_source, 'meteoswiss');
    assert.equal(events[0].syncVersion, 2);
  });

  test(`[${relativePath}] 0063: a rename carries the unchanged weather_source; nothing changed emits nothing`, (t) => {
    const db = bundledCopy(t, relativePath);
    link(db);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET name = 'North block', sync_version = 2 WHERE id = 11");
    const events = zoneEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_UPSERTED');
    assert.equal(events[0].payload.weather_source, 'auto');
    db.exec('DELETE FROM sync_outbox');
    db.exec('UPDATE irrigation_zones SET name = name WHERE id = 11');
    assert.deepEqual(zoneEvents(db), []);
  });

  test(`[${relativePath}] 0063: an unlinked gateway emits nothing`, (t) => {
    const db = bundledCopy(t, relativePath);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET weather_source = 'local', sync_version = 2 WHERE id = 11");
    assert.deepEqual(zoneEvents(db), []);
  });
}
```

In `.github/workflows/verify-sync-flow.yml`, after the step `Zone write routes emit at a new sync version` (its `run: node --test scripts/test-zone-update-sync-version.js` line), add:
```yaml
      # Weather data view: the zone weather_source round trip -- the 0063 zone
      # trigger on the seven bundled databases, the zone route and list, and the
      # legacy command path, each against the shipped source.
      - name: Zone weather provider round trip
        run: node --test scripts/test-zone-weather-source.js
```

Run: `node --test scripts/test-zone-weather-source.js`. Expected: 14 failures (two per bundled DB: the op is `ZONE_UPSERTED` and `payload.weather_source` is `undefined`); the seven "unlinked" tests pass.

- [ ] **Step 2: Pin the new trigger text in `verify-sync-flow.js`**

After the line `expectIncludes('Sync Init Schema + Triggers', 'COALESCE(NEW.prediction_card_enabled,0) <> COALESCE(OLD.prediction_card_enabled,0)', 'queues outbox events when the prediction-card flag changes');` add:
```js
expectIncludes('Sync Init Schema + Triggers', "'weather_source', COALESCE(NEW.weather_source, 'auto')", 'carries the zone weather provider in every zone update event (0063)');
expectIncludes('Sync Init Schema + Triggers', "COALESCE(NEW.weather_source,'auto') <> COALESCE(OLD.weather_source,'auto')", 'queues a zone config event when only the weather provider changes (0063)');
```
The trigger-name loop below it (`trg_sync_zones_outbox_au`, … `trg_gateway_locations_outbox_au`) stays as it is.

- [ ] **Step 3: Change the canonical trigger and write 0063 from it**

`$SCRATCH/trigger-0063.js`:
```js
// One-shot (Task 5): the zone update trigger carries weather_source.
// Rewrites the canonical source entry and writes migration 0063 from it, so
// the migration's CREATE TRIGGER is byte-identical to the canonical SQL.
'use strict';
const fs = require('fs');
const SOURCE = 'scripts/sync-trigger-source.json';
const MIGRATION = 'database/migrations/ordered/0063__zone_weather_source_sync.sql';
const before = fs.readFileSync(SOURCE, 'utf8');
const source = JSON.parse(before);
if (JSON.stringify(source, null, 2) + '\n' !== before) throw new Error(`${SOURCE} does not round-trip`);
const entry = source.triggers.find((t) => t.name === 'trg_sync_zones_outbox_au');
if (!entry) throw new Error('trg_sync_zones_outbox_au not in the canonical source');
const CHANGE = "COALESCE(NEW.weather_source,'auto') <> COALESCE(OLD.weather_source,'auto')";
if (entry.sql.includes(CHANGE)) throw new Error('already applied');
const swaps = [
  // 1. the WHEN list
  ["COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') OR COALESCE(NEW.deleted_at,'')",
    `COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') OR ${CHANGE} OR COALESCE(NEW.deleted_at,'')`],
  // 2. the CASE branch that yields ZONE_CONFIG_UPSERTED
  ["COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') THEN 'ZONE_CONFIG_UPSERTED'",
    `COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') OR ${CHANGE} THEN 'ZONE_CONFIG_UPSERTED'`],
  // 3. the payload
  ["'notes', NEW.notes, ", "'notes', NEW.notes, 'weather_source', COALESCE(NEW.weather_source, 'auto'), "],
];
let sql = entry.sql;
for (const [from, to] of swaps) {
  if (sql.split(from).length !== 2) throw new Error(`expected exactly one match for: ${from}`);
  sql = sql.replace(from, to);
}
entry.sql = sql;
fs.writeFileSync(SOURCE, JSON.stringify(source, null, 2) + '\n');
fs.writeFileSync(MIGRATION, [
  '-- risk: additive',
  '-- 0063: the zone update trigger carries weather_source (spec',
  '-- docs/superpowers/specs/2026-09-27-weather-data-view-design.md). A provider',
  '-- change alone emits ZONE_CONFIG_UPSERTED, and every zone update payload',
  "-- carries 'weather_source'. The 0046 insert trigger is unchanged: the create",
  '-- event omits the field and the zone\'s first update emits it.',
  '-- sync-init-fn recreates this trigger at every boot from',
  '-- scripts/sync-trigger-source.json; the CREATE below is byte-identical to that',
  '-- entry, so the boot body and the migrated body agree.',
  'DROP TRIGGER IF EXISTS trg_sync_zones_outbox_au;',
  sql,
  '',
].join('\n'));
console.log('canonical entry and 0063 written; trigger SQL', sql.length, 'chars');
```
```bash
node $SCRATCH/trigger-0063.js
node scripts/generate-sync-trigger-source.js --write
```
Expected: `canonical entry and 0063 written; trigger SQL 4137 chars`; `generated ordered trigger regions in both profiles (31 SQL definitions)`. The json_object grows from 42 to 44 arguments (limit 127). `head -c 200 database/migrations/ordered/0063__zone_weather_source_sync.sql` starts with `-- risk: additive`.

- [ ] **Step 4: The same body in `seed-blank.sql`, pretty-printed**

`$SCRATCH/seed-0063.js`:
```js
// One-shot (Task 5): the same trigger change in seed-blank.sql's pretty form.
'use strict';
const fs = require('fs');
const FILE = 'database/seed-blank.sql';
const text = fs.readFileSync(FILE, 'utf8');
const start = text.indexOf('CREATE TRIGGER trg_sync_zones_outbox_au');
const end = text.indexOf('\nEND;', start);
if (start < 0 || end < 0) throw new Error('trg_sync_zones_outbox_au block not found');
let block = text.slice(start, end);
const swaps = [
  ["    COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') OR\n    COALESCE(NEW.deleted_at,'')",
    "    COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') OR\n    COALESCE(NEW.weather_source,'auto') <> COALESCE(OLD.weather_source,'auto') OR\n    COALESCE(NEW.deleted_at,'')"],
  ["           COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') THEN 'ZONE_CONFIG_UPSERTED'",
    "           COALESCE(NEW.notes,'') <> COALESCE(OLD.notes,'') OR\n           COALESCE(NEW.weather_source,'auto') <> COALESCE(OLD.weather_source,'auto') THEN 'ZONE_CONFIG_UPSERTED'"],
  ["      'notes',                    NEW.notes,\n",
    "      'notes',                    NEW.notes,\n      'weather_source',           COALESCE(NEW.weather_source,'auto'),\n"],
];
for (const [from, to] of swaps) {
  if (block.split(from).length !== 2) throw new Error(`expected exactly one match for: ${from}`);
  block = block.replace(from, to);
}
fs.writeFileSync(FILE, text.slice(0, start) + block + text.slice(end));
console.log('seed-blank.sql trigger updated');
```
```bash
node $SCRATCH/seed-0063.js
node scripts/generate-sync-trigger-source.js --check
```
Expected: `seed-blank.sql trigger updated`; `sync trigger source check passed (31 SQL definitions)` (canonical source = both boot-node regions = seed body, after whitespace normalisation).

- [ ] **Step 5: Checksums and the seven bundled databases**

```bash
node -e "
const fs=require('fs'),crypto=require('crypto'),p='database/migrations/ordered/';
const m={};for(const f of fs.readdirSync(p).filter(f=>f.endsWith('.sql')).sort()){m[f]=crypto.createHash('sha256').update(fs.readFileSync(p+f)).digest('hex');}
fs.writeFileSync(p+'CHECKSUMS.json',JSON.stringify(m,null,2)+'\n');console.log(Object.keys(m).length,'entries');"
node scripts/build-seed-db.js
```
Run the second command with a 10-minute timeout; it takes about 160 s. Expected: `63 entries`; seven `wrote …/farming.db` lines and `build-seed-db: OK (7 image(s), …)`.

- [ ] **Step 6: Bump the migration corpus pins**

`lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`: the title becomes `'affected gateway ledger applies original pending migrations through 0063'` and the assertion becomes
```js
  assert.deepEqual(result.applied, [22, 23, 24, 25, 30, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);
```
`scripts/reconcile-ledger-numbering.test.js` (as extended through 0062 by `6e0ea32cd`, which the branch base carries):
- The 49-version lineage fixture (the comment at line 546, `// past this device fixture's throughVersion (49): 0054-0062 (network`): the comment reads `0054-0063 (network coverage v1, land/network-observations-v1, weather provider store, daily agronomy, zone weather_source sync) are also genuinely new to this device, so pending is {22,23,24,25,54,...,63}.`, and both `assert.deepEqual(pending, …)` and `assert.deepEqual(carryRes.applied, …)` end `…, 58, 59, 60, 61, 62, 63]`;
- The 25-version lineage fixture (the comment at line 597, `// plus 0054-0062 (network coverage v1, land/network-observations-v1,`): the comment's list reads `0054-0063 (network coverage v1, land/network-observations-v1, durable valve dispatch intents, weather provider store, daily agronomy, zone weather_source sync)`, and `assert.deepEqual(pending, [...Array.from({ length: 53 - 26 + 1 }, (_, i) => 26 + i), 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]);`.

- [ ] **Step 7: Regenerate the Terra fixture**

The fixture holds zone trigger payloads and the ACK `payloadHash`, both of which now carry `weather_source`:
```bash
TERRA_EDGE_FIXTURE_OUT=scripts/fixtures/terra-edge-selection/edge-selection-v1.json node --test scripts/test-terra-selection-edge-acceptance.js
node --test scripts/test-terra-selection-edge-acceptance.js
git diff --stat scripts/fixtures/terra-edge-selection
```
Expected: both runs `# fail 0`; the diff touches `edge-selection-v1.json` (the zone payloads gain `"weather_source":"auto"`) and `edge-selection-v1.sha256`. The osi-server copy pins an older osi-os commit and stays green; sub-project 4 refreshes it.

- [ ] **Step 8: Size ratchet and identity pin**

`$SCRATCH/ratchet.js` (Tasks 6 and 7 run the same script with their node ids):
```js
#!/usr/bin/env node
// Shared by Tasks 5, 6 and 7. Measures the node ids given on the command line and
// the per-profile total against origin/main and writes the exact allowances
// verify-flows-size-ratchet reads. Usage: node $SCRATCH/ratchet.js <node id>...
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nodeSizes, totalChars } = require(path.join(process.cwd(), 'scripts/flows-size-scan'));
const REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const FILE = 'scripts/verify-flows-size-ratchet-allowances.json';
const head = JSON.parse(fs.readFileSync(REL, 'utf8'));
const base = JSON.parse(execFileSync('git', ['show', 'origin/main:' + REL], { maxBuffer: 64 * 1024 * 1024 }).toString());
const h = nodeSizes(head);
const b = nodeSizes(base);
const before = fs.readFileSync(FILE, 'utf8');
const allowances = JSON.parse(before);
if (JSON.stringify(allowances, null, 2) + '\n' !== before) throw new Error(FILE + ' does not round-trip');
const SENTINEL = ' The live identity restart sentinel (Option C Slice 1) provenance that verify-live-gateway-identity.js pins for this node id is carried forward.';
const WHY = 'Weather data view (spec docs/superpowers/specs/2026-09-27-weather-data-view-design.md), measured with verify-flows-size-ratchet nodeSizes over both byte-identical profiles: ';
const SUPERSEDES = 'Supersedes the prior entry, whose growth origin/main already carries.';
// In the order the total's reason lists them.
const REASONS = {
  'sync-init-fn': (m) => `${WHY}${m}. ${SUPERSEDES} Only the generated trigger region changed: trg_sync_zones_outbox_au carries weather_source (migration 0063, written by generate-sync-trigger-source.js --write).`,
  'zone-config-fn': (m) => `${WHY}${m}. ${SUPERSEDES} PUT /api/irrigation-zones/:id/config validates and stores weatherSource / weather_source and returns weather_source and weather_source_default.`,
  'get-zones-query': (m) => `${WHY}${m}. ${SUPERSEDES} The zone list SELECT reads iz.weather_source.`,
  'get-zones-response': (m) => `${WHY}${m}. First entry: the zone list returns weather_source and weather_source_default.`,
  'sync-bootstrap-build': (m) => `${WHY}${m}. ${SUPERSEDES} The bootstrap zone snapshot carries weather_source and syncCapabilities gains zone_config_weather_source_v1.${SENTINEL}`,
  'sync-force-build': (m) => `${WHY}${m}. ${SUPERSEDES} The force-sync zone snapshot carries weather_source and syncCapabilities gains zone_config_weather_source_v1.${SENTINEL}`,
  'al-link-build-req': (m) => `${WHY}${m}. ${SUPERSEDES} syncCapabilities gains zone_config_weather_source_v1.${SENTINEL}`,
  '4f4a765f36cee6f3': (m) => `${WHY}${m}. ${SUPERSEDES} Legacy UPSERT_ZONE_CONFIG and UPSERT_ZONE store weather_source; an invalid value is ignored with one warning.`,
};
const ids = process.argv.slice(2);
if (!ids.length || ids.some((id) => !REASONS[id])) throw new Error('usage: ratchet.js <node id>... with ids from ' + Object.keys(REASONS).join(', '));
for (const id of ids) {
  const delta = h.get(id).chars - b.get(id).chars;
  const measured = `origin/main ${b.get(id).chars} -> HEAD ${h.get(id).chars} = +${delta}`;
  allowances.node_allowances[id] = { delta, reason: REASONS[id](measured) };
  console.log(id, measured);
}
// Every node this branch has measured so far (this run and the earlier tasks).
const grown = Object.keys(REASONS).filter((id) => String(allowances.node_allowances[id]?.reason || '').startsWith(WHY));
const thisBranch = grown.length === 1
  ? `${grown[0]} grew by the delta of its node entry`
  : `${grown.slice(0, -1).join(', ')} and ${grown[grown.length - 1]} grew by the deltas of their node entries`;
const totalDelta = totalChars(head) - totalChars(base);
allowances.total_allowance = {
  delta: totalDelta,
  reason: `Branch feat/weather-data-view, stacked on feat/daily-agronomy (the weather provider store, the daily agronomy record and the weather data view, all unmerged to origin/main), measured with verify-flows-size-ratchet totalChars over both byte-identical profiles: origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}. Carried from feat/daily-agronomy: +4138 (weather-provider-tick 0, weather-provider-fn 1467, station-hours-fn 1525, agronomy-daily-fn 1515, zone-env-fn -369). This branch: ${thisBranch}. When the earlier branches merge to origin/main their share moves into the base total and this entry drops by it.`,
};
console.log('total', `origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}`);
fs.writeFileSync(FILE, JSON.stringify(allowances, null, 2) + '\n');
```
```bash
node $SCRATCH/ratchet.js sync-init-fn
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `sync-init-fn origin/main 81736 -> HEAD 81948 = +212`; `total origin/main 1580418 -> HEAD 1584768 = +4350`; the ratchet ends `verify-flows-size-ratchet: OK (…)`. If `origin/main` has moved, the numbers move with it; use the printed ones below.

In `scripts/verify-live-gateway-identity.js`, replace
```js
  expectCondition(sizeAllowances.total_allowance?.delta === 4138,
    'size total allowance: exact cumulative delta 4138',
    'size total allowance: expected exact cumulative delta 4138');
```
with
```js
  // 4350: weather data view (sub-project 3) Task 5, stacked on the daily agronomy branch
  // whose +4138 above is still unmerged and carried forward. sync-init-fn grows by the
  // generated trg_sync_zones_outbox_au body of migration 0063 (81736 -> 81948, +212).
  // verify-flows-size-ratchet totalChars over both byte-identical profiles: origin/main
  // 1580418 -> HEAD 1584768 = +4350 (4138 + 212).
  expectCondition(sizeAllowances.total_allowance?.delta === 4350,
    'size total allowance: exact cumulative delta 4350',
    'size total allowance: expected exact cumulative delta 4350');
```
and after the line `expectIncludes('size total allowance', …, 'zone-env-fn', 'declares the daily-agronomy Task 9 zone-env-fn shrink within the re-measured total');` add:
```js
  for (const nodeId of ['sync-init-fn']) {
    expectIncludes('size total allowance', String(sizeAllowances.total_allowance?.reason || ''), nodeId, `declares the weather data view growth of ${nodeId} within the re-measured total`);
  }
```
The `sync-init-fn` hash pin masks the generated trigger region and does not move.

- [ ] **Step 9: Run the gates**

```bash
node --test scripts/test-zone-weather-source.js scripts/test-zone-update-sync-version.js scripts/test-zone-command-path.js scripts/test-terra-zone-config-command-flow.js
node --test scripts/test-sync-trigger-source.js scripts/verify-trigger-body-parity.test.js
node scripts/generate-sync-trigger-source.js --check
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-trigger-body-parity.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-seed-db-ledger.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js && node scripts/test-journal-schema.js
node scripts/verify-flows-fn-parse.js && node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
export TMPDIR=/var/tmp/osi-weather-data-view && mkdir -p "$TMPDIR" && df -h "$TMPDIR"
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/reconcile-ledger-numbering.test.js
```
Expected: `test-zone-weather-source.js` 21 pass; the other suites `# fail 0`; `sync trigger source check passed (31 SQL definitions)`; `verify-migrations: OK (63 migrations, checksum manifest OK, base immutability OK)`, `verify-seed-replay: OK`, `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)`, `verify-trigger-body-parity: OK`, `DB schema consistency verification passed`, `verify-seed-db-ledger: OK (7 images stamped at migration head 63)`, `verify-no-stray-ddl: OK (…)`, `All parity checks passed.`, `test-journal-schema: OK (…)`; `verify-flows-fn-parse: OK`, ratchet OK, `Live gateway identity verification passed.`, verify-sync-flow ends `All parity checks passed.`; the migration suite passes (`runner-preexisting-add-column-real` 2/2 in about 90 s; `runner-boot-devices-rebuild-grace` replays every migration and takes several minutes, run with a 30-minute timeout); `reconcile-ledger-numbering.test.js` 34 pass in about 13 minutes.

- [ ] **Step 10: Commit**

```bash
git add database lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js scripts/reconcile-ledger-numbering.test.js scripts/sync-trigger-source.json scripts/test-zone-weather-source.js scripts/fixtures/terra-edge-selection scripts/verify-sync-flow.js scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js .github/workflows/verify-sync-flow.yml conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json $(node -e "console.log(require('./scripts/seed-db-paths.js').SEED_DB_RELATIVE_PATHS.join(' '))")
git -c user.name=Project-OSI commit -m "feat(sync): zone events carry weather_source (migration 0063, canonical trigger source, seeds)"
git status --short
```
`git status --short` lists none of the seven bundled databases.

---

### Task 6: Zone write route, zone list, snapshots and the capability

**Files:**
- Modify (by one-shot script): both `flows.json`, nodes `zone-config-fn`, `get-zones-query`, `get-zones-response`, `sync-bootstrap-build`, `sync-force-build`, `al-link-build-req`
- Modify: `scripts/test-zone-weather-source.js` (append), `scripts/verify-sync-flow.js`, `scripts/test-entity-name-command-path.js` (the capability regex), `scripts/test-journal-bootstrap.js` (`EXPECTED_CAPABILITIES`), `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`
- Scratch: `$SCRATCH/flows-zone-weather-source.js`; the shared `$SCRATCH/ratchet.js` (Task 5)

**Interfaces:**
- Consumes: the 0063 trigger (Task 5), which emits the new value once `zone-config-fn` bumps `sync_version`.
- Produces: `PUT /api/irrigation-zones/:zone_id/config` accepts `weatherSource` or `weather_source` (`null` or blank → `'auto'`; otherwise trimmed, lower-cased, `^[a-z_]{1,20}$`, else `400 {error: 'Weather provider must be 1 to 20 lower-case letters or underscores'}`) and answers with `weather_source` and `weather_source_default`; `GET /api/irrigation-zones` rows carry `weather_source` (`'auto'` when empty) and `weather_source_default` (`'meteoswiss'` when `OSI_WEATHER_PROVIDER_DEFAULT` is `meteoswiss`, else `'open_meteo'`); both snapshots' zones carry `weather_source`; `syncCapabilities` in the three builders ends `'entity_name_commands_v1', 'zone_config_weather_source_v1'` (then `field_journal_v1` when the journal is on). Task 8's GUI reads `weather_source` and `weather_source_default`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-zone-weather-source.js`:
```js

function seededMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
    + `VALUES (7, 'grower', 'x', '2026-01-01', '${USER_UUID}', 'admin', 1)`);
  db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, created_at, updated_at) '
    + `VALUES (11, 'North', 7, '${ZONE_UUID}', '${GATEWAY}', 3, 'UTC', '2026-01-01', '2026-01-01')`);
  return db;
}

async function putConfig(db, body, env = {}) {
  const run = await executeFunction(loadNode('zone-config-fn'), {
    msg: {
      req: {
        headers: { authorization: makeAuthHeader({ userId: 7, username: 'grower', secret: SECRET }) },
        params: { zone_id: '11' },
        body,
      },
      payload: {},
    },
    env: { AUTH_TOKEN_SECRET: SECRET, ...env },
    db,
  });
  return run.result;
}

function stored(db) {
  return { ...db.prepare('SELECT weather_source, sync_version FROM irrigation_zones WHERE id = 11').get() };
}

test('zone-config-fn stores a valid provider, lower-cased, and bumps sync_version', async () => {
  const db = seededMemory();
  try {
    const response = await putConfig(db, { weatherSource: ' MeteoSwiss ' }, { OSI_WEATHER_PROVIDER_DEFAULT: 'meteoswiss' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(stored(db), { weather_source: 'meteoswiss', sync_version: 4 });
    assert.equal(response.payload.weather_source, 'meteoswiss');
    assert.equal(response.payload.weather_source_default, 'meteoswiss');
    const snake = await putConfig(db, { weather_source: 'open_meteo' });
    assert.equal(snake.statusCode, 200);
    assert.equal(stored(db).weather_source, 'open_meteo');
    assert.equal(snake.payload.weather_source_default, 'open_meteo');
  } finally {
    db.close();
  }
});

test('zone-config-fn stores auto for null and rejects a malformed provider', async () => {
  const db = seededMemory();
  try {
    db.exec("UPDATE irrigation_zones SET weather_source = 'local' WHERE id = 11");
    assert.equal((await putConfig(db, { weatherSource: null })).statusCode, 200);
    assert.equal(stored(db).weather_source, 'auto');
    for (const bad of ['open-meteo!', 'a'.repeat(21)]) {
      const response = await putConfig(db, { weatherSource: bad });
      assert.equal(response.statusCode, 400, bad);
      assert.deepEqual(response.payload, { error: 'Weather provider must be 1 to 20 lower-case letters or underscores' });
    }
    assert.equal(stored(db).weather_source, 'auto');
    assert.equal((await putConfig(db, { notes: 'x' })).payload.weather_source, 'auto', 'a save of other fields keeps the value');
  } finally {
    db.close();
  }
});

async function zoneList(db, env) {
  const query = await executeFunction(loadNode('get-zones-query'), {
    msg: { payload: [{ id: 7 }] },
    env,
    db,
  });
  const rowsMsg = query.result[0];
  const response = await executeFunction(loadNode('get-zones-response'), { msg: rowsMsg, env, db });
  return response.result.payload;
}

test('the zone list returns weather_source and the gateway default', async () => {
  const db = seededMemory();
  try {
    db.exec("UPDATE irrigation_zones SET weather_source = 'openagri' WHERE id = 11");
    const [swiss] = await zoneList(db, { OSI_WEATHER_PROVIDER_DEFAULT: 'meteoswiss' });
    assert.equal(swiss.weather_source, 'openagri');
    assert.equal(swiss.weather_source_default, 'meteoswiss');
    assert.equal((await zoneList(db, {}))[0].weather_source_default, 'open_meteo');
    assert.equal((await zoneList(db, { OSI_WEATHER_PROVIDER_DEFAULT: 'bogus' }))[0].weather_source_default, 'open_meteo');
  } finally {
    db.close();
  }
});
```

In `scripts/verify-sync-flow.js`, add after the two 0063 pins from Task 5:
```js
expectIncludesById('get-zones-query', 'iz.weather_source', 'the zone list reads the zone weather provider');
expectIncludesById('get-zones-response', "weather_source: r.weather_source || 'auto'", 'the zone list returns the zone weather provider');
expectIncludesById('get-zones-response', 'weather_source_default: weatherSourceDefault', 'the zone list returns the provider auto resolves to on this gateway');
```
after `expectIncludes('Build Cloud Bootstrap', 'COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled', 'includes the prediction-card flag in bootstrap snapshots');`:
```js
expectIncludes('Build Cloud Bootstrap', 'iz.weather_source', 'includes the zone weather provider in bootstrap snapshots');
```
after `expectIncludes('Build Cloud Bootstrap', 'prediction_card_enabled: !!Number(z.prediction_card_enabled || 0)', 'exports the prediction-card flag in bootstrap payloads');`:
```js
expectIncludes('Build Cloud Bootstrap', "weather_source: z.weather_source || 'auto'", 'exports the zone weather provider in bootstrap payloads');
```
after `expectIncludes('Run Force Sync', 'COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled', 'includes the prediction-card flag in force-sync snapshots');`:
```js
expectIncludes('Run Force Sync', 'iz.weather_source', 'includes the zone weather provider in force-sync snapshots');
```
after `expectIncludes('Run Force Sync', 'prediction_card_enabled: !!Number(z.prediction_card_enabled || 0)', 'exports the prediction-card flag in forced bootstrap payloads');`:
```js
expectIncludes('Run Force Sync', "weather_source: z.weather_source || 'auto'", 'exports the zone weather provider in forced bootstrap payloads');
```
and after the `expectIncludesForEach` block for `"'entity_name_commands_v1'"`:
```js
expectIncludesForEach(
  ['Build Cloud Bootstrap', 'Build server auth request', 'Run Force Sync'],
  "'zone_config_weather_source_v1'",
  'advertises that zone commands may carry weather_source'
);
```

In `scripts/test-entity-name-command-path.js`, the test title becomes `'all three capability builders advertise entity_name_commands_v1 and zone_config_weather_source_v1, on both profiles'` and its regex becomes:
```js
        /const syncCapabilities = \['linked_auth_sync_v1', 'force_edge_sync_v1', 'installation_recovery_v1', 'installation_locations_v1', 'entity_name_commands_v1', 'zone_config_weather_source_v1'\];/,
```
In `scripts/test-journal-bootstrap.js`, `EXPECTED_CAPABILITIES` gains `'zone_config_weather_source_v1',` between `'entity_name_commands_v1',` and `'field_journal_v1',`, and the journal-off assertion becomes `assert.deepEqual(payload.gatewayIdentity.syncCapabilities, EXPECTED_CAPABILITIES.slice(0, 6));`.

- [ ] **Step 2: Run the tests to see them fail**

```bash
node --test scripts/test-zone-weather-source.js scripts/test-entity-name-command-path.js
node scripts/test-journal-bootstrap.js
node scripts/verify-sync-flow.js
```
Expected: the three route and list tests fail (the node ignores `weatherSource`, returns no `weather_source`); the capability regex test fails; `test-journal-bootstrap.js` fails its capability assertions; `verify-sync-flow.js` reports each new pin as missing.

- [ ] **Step 3: The one-shot flows edit**

`$SCRATCH/flows-zone-weather-source.js`:
```js
#!/usr/bin/env node
// One-shot (Task 6): weather_source on the zone write route, the zone list,
// both snapshots, and the zone_config_weather_source_v1 capability.
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) throw new Error('profiles differ before the edit');
function edit(id, swaps) {
  const node = flows.find((n) => n.id === id);
  if (!node) throw new Error('node not found: ' + id);
  for (const [from, to] of swaps) {
    const count = node.func.split(from).length - 1;
    if (count !== 1) throw new Error(`${id}: expected one match, found ${count}: ${from.slice(0, 80)}`);
    node.func = node.func.replace(from, to);
  }
}
const DEFAULT_EXPR = "String(env.get('OSI_WEATHER_PROVIDER_DEFAULT') || '').trim().toLowerCase() === 'meteoswiss' ? 'meteoswiss' : 'open_meteo'";

edit('zone-config-fn', [
  ["const predictionCardEnabled = b.predictionCardEnabled !== undefined ? b.predictionCardEnabled : b.prediction_card_enabled;\n",
    "const predictionCardEnabled = b.predictionCardEnabled !== undefined ? b.predictionCardEnabled : b.prediction_card_enabled;\n" +
    "const weatherSourceInput = b.weatherSource !== undefined ? b.weatherSource : b.weather_source;\n"],
  ["if(b.notes!==undefined)           sets.push(\"notes=\"+s(b.notes));\n",
    "if(weatherSourceInput!==undefined){\n" +
    "  const weatherSource = weatherSourceInput === null ? '' : String(weatherSourceInput).trim().toLowerCase();\n" +
    "  if (weatherSource && !/^[a-z_]{1,20}$/.test(weatherSource)) { await close(); return respond({error:'Weather provider must be 1 to 20 lower-case letters or underscores'},400); }\n" +
    "  sets.push(\"weather_source=\" + s(weatherSource || 'auto'));\n" +
    "}\n" +
    "if(b.notes!==undefined)           sets.push(\"notes=\"+s(b.notes));\n"],
  ["COALESCE(prediction_card_enabled, 0) AS prediction_card_enabled,notes FROM irrigation_zones WHERE id=",
    "COALESCE(prediction_card_enabled, 0) AS prediction_card_enabled,notes,weather_source FROM irrigation_zones WHERE id="],
  ["const z=rows[0];\nreturn respond({",
    "const z=rows[0];\nconst weatherSourceDefault = " + DEFAULT_EXPR + ";\nreturn respond({"],
  ["prediction_card_enabled:Boolean(Number(z.prediction_card_enabled || 0)),notes:z.notes\n});",
    "prediction_card_enabled:Boolean(Number(z.prediction_card_enabled || 0)),notes:z.notes,\n  weather_source:z.weather_source || 'auto',weather_source_default:weatherSourceDefault\n});"],
]);

edit('get-zones-query', [
  ["COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled, iz.notes,\n",
    "COALESCE(iz.prediction_card_enabled, 0) AS prediction_card_enabled, iz.notes, iz.weather_source,\n"],
]);

edit('get-zones-response', [
  ["const rows = msg.payload || [];\n",
    "const rows = msg.payload || [];\n// The provider 'auto' resolves to on this gateway (osi-weather-provider resolveProvider).\nconst weatherSourceDefault = " + DEFAULT_EXPR + ";\n"],
  ["  notes: r.notes || null,\n",
    "  notes: r.notes || null,\n  weather_source: r.weather_source || 'auto',\n  weather_source_default: weatherSourceDefault,\n"],
]);

for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
  edit(id, [
    ["iz.notes, iz.sync_version, iz.deleted_at, u.user_uuid", "iz.notes, iz.weather_source, iz.sync_version, iz.deleted_at, u.user_uuid"],
    ["prediction_card_enabled: !!Number(z.prediction_card_enabled || 0), notes: z.notes,",
      "prediction_card_enabled: !!Number(z.prediction_card_enabled || 0), weather_source: z.weather_source || 'auto', notes: z.notes,"],
  ]);
}
for (const id of ['al-link-build-req', 'sync-bootstrap-build', 'sync-force-build']) {
  edit(id, [["'entity_name_commands_v1'];", "'entity_name_commands_v1', 'zone_config_weather_source_v1'];"]]);
}

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('edited zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build, sync-force-build, al-link-build-req in both profiles');
```
Before running, confirm the roundtrip guard on both profiles (the script throws otherwise), then:
```bash
node $SCRATCH/flows-zone-weather-source.js
node scripts/verify-flows-fn-parse.js
```
Expected: `edited zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build, sync-force-build, al-link-build-req in both profiles`; `verify-flows-fn-parse: OK`. `zone-config-fn` gains no `ALTER` (the column comes from 0060); its ownership SELECT (`id,name`) is unchanged.

- [ ] **Step 4: Size ratchet and identity pins**

The shared `$SCRATCH/ratchet.js` from Task 5 Step 8 measures the six nodes and rewrites the total; its reasons for `sync-bootstrap-build`, `sync-force-build` and `al-link-build-req` carry the identity sentinel.
```bash
node $SCRATCH/ratchet.js zone-config-fn get-zones-query get-zones-response sync-bootstrap-build sync-force-build al-link-build-req
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `zone-config-fn origin/main 9706 -> HEAD 10443 = +737`, `get-zones-query … 4958 -> HEAD 4977 = +19`, `get-zones-response … 1807 -> HEAD 2144 = +337`, `sync-bootstrap-build … 44956 -> HEAD 45052 = +96`, `sync-force-build … 68992 -> HEAD 69088 = +96`, `al-link-build-req … 6709 -> HEAD 6742 = +33`, `total origin/main 1580418 -> HEAD 1586086 = +5668`; ratchet OK. The `sync-init-fn` entry from Task 5 stays.

In `scripts/verify-live-gateway-identity.js`, `expectedGrowth`:
- `'sync-bootstrap-build': 1373,` becomes (keep the comment above it and add these lines before the entry)
```js
    // Weather data view: re-pinned from 1373 to +96. The 1373 is baked into origin/main
    // (44956 chars); this branch adds iz.weather_source to the zone SELECT, weather_source
    // to the zone map and zone_config_weather_source_v1 to syncCapabilities. Re-measured
    // fresh: origin/main 44956 -> HEAD 45052 = +96.
    'sync-bootstrap-build': 96,
```
- `'sync-force-build': 3265,` becomes
```js
    // Weather data view: re-pinned from 3265 to +96 (the 3265 is baked into origin/main,
    // 68992 chars); the same three additions as sync-bootstrap-build. Re-measured fresh:
    // origin/main 68992 -> HEAD 69088 = +96.
    'sync-force-build': 96,
```
- `'al-link-build-req': 2511,` becomes
```js
    // Weather data view: re-pinned from 2511 to +33 (the 2511 is baked into origin/main,
    // 6709 chars); syncCapabilities gains zone_config_weather_source_v1. Re-measured fresh:
    // origin/main 6709 -> HEAD 6742 = +33.
    'al-link-build-req': 33,
```
The reasons written by `ratchet.js` for these three nodes contain `live identity restart sentinel (Option C Slice 1)`, which the loop after `expectedGrowth` requires.

The total pin from Task 5 becomes:
```js
  // 5668: weather data view Task 6 adds zone-config-fn (+737), get-zones-query (+19),
  // get-zones-response (+337), sync-bootstrap-build (+96), sync-force-build (+96) and
  // al-link-build-req (+33) to Task 5's 4350. verify-flows-size-ratchet totalChars over both
  // byte-identical profiles: origin/main 1580418 -> HEAD 1586086 = +5668.
  expectCondition(sizeAllowances.total_allowance?.delta === 5668,
    'size total allowance: exact cumulative delta 5668',
    'size total allowance: expected exact cumulative delta 5668');
```
(keep Task 5's 4350 comment above it), and the node-id loop's array becomes `['sync-init-fn', 'zone-config-fn', 'get-zones-query', 'get-zones-response', 'sync-bootstrap-build', 'sync-force-build', 'al-link-build-req']`.

- [ ] **Step 5: Run the gates**

```bash
node --test scripts/test-zone-weather-source.js scripts/test-entity-name-command-path.js scripts/test-scoped-access-reads.js scripts/test-scoped-access-writes.js scripts/test-zone-update-sync-version.js scripts/test-terra-selection-edge-acceptance.js
node scripts/test-journal-bootstrap.js
node scripts/verify-profile-parity.js && node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-osi-lib-db-caller-binding.js
node scripts/generate-sync-trigger-source.js --check
bash scripts/check-mqtt-topics.sh
node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
node --test scripts/verify-auth-flag-off-hermetic.test.js
```
Expected: `test-zone-weather-source.js` 24 pass, the other suites `# fail 0`; `test-journal-bootstrap.js` 62 pass; parity, parse, bare-require, wiring (`PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`), silent-catch, stray-DDL and caller binding pass; trigger check passes; three `OK:` MQTT lines; ratchet OK, `Live gateway identity verification passed.`, verify-sync-flow ends `All parity checks passed.`; the auth hermetic test passes (`zone-config-fn`'s auth block is untouched).

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-zone-weather-source.js scripts/verify-sync-flow.js scripts/test-entity-name-command-path.js scripts/test-journal-bootstrap.js scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git -c user.name=Project-OSI commit -m "feat(flows): zone weather_source on the config route, the zone list, both snapshots; capability zone_config_weather_source_v1"
```

---

### Task 7: Cloud-to-edge command paths and the contract

**Files:**
- Modify (by one-shot script): both `flows.json`, node `4f4a765f36cee6f3` ("Build UPDATE SQL")
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js` (`normalizedZone`, `insertZone`, `updateFullZone`) and its `bcm2709` mirror, `scripts/test-zone-command-path.js`, `scripts/test-zone-weather-source.js` (append), `scripts/verify-sync-flow.js`, `docs/contracts/sync-schema/resources.schema.json` (definition `Zone`), `scripts/test-contract-schemas.js`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`
- Unchanged: the Terra `UPSERT_ZONE_CONFIG` field set (`terraConfigurationOperation === true`, `osi-zone-commands` lines 84–172); `updateLocation`; `events.schema.json`
- Scratch: `$SCRATCH/flows-build-update-sql.js`; the shared `$SCRATCH/ratchet.js` (Task 5)

**Interfaces:**
- Consumes: the 0063 trigger (Task 5): an applied protected command emits one `ZONE` event whose payload, and so the ACK `payloadHash`, carries `weather_source`.
- Produces: legacy `UPSERT_ZONE_CONFIG` stores `weatherSource` / `weather_source` (`null` or blank → `'auto'`; invalid → ignored with one `node.warn` naming the zone UUID); legacy `UPSERT_ZONE` inserts the valid value or `'auto'` and on conflict writes `weather_source=excluded.weather_source` only for a valid value, else keeps `irrigation_zones.weather_source`; protected `UPSERT_ZONE` / `UPSERT_ZONE_LOCATION` accept an optional `zone.weather_source` (`null` or blank = absent; otherwise `^[a-z_]{1,20}$` after trim and lower-casing, else `malformed_command` → `REJECTED_PERMANENT`); `insertZone` writes the value or `'auto'`; `updateFullZone` writes it only when present. `resources.schema.json` `Zone.weather_source`: `{"type": "string", "minLength": 1, "maxLength": 20, "pattern": "^[a-z_]{1,20}$"}`, not required. Task 10 copies this file byte for byte.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-zone-weather-source.js`:
```js

async function legacyCommand(db, cmd) {
  const run = await executeFunction(loadNode('4f4a765f36cee6f3'), {
    msg: { payload: { zoneUuid: ZONE_UUID, syncVersion: 9, ...cmd } },
    env: { DEVICE_EUI: GATEWAY },
    db,
  });
  assert.equal(typeof run.result.topic, 'string', 'the node must build a statement');
  db.exec(run.result.topic);
  return run;
}

test('Build UPDATE SQL: UPSERT_ZONE_CONFIG stores weatherSource or weather_source, null as auto', async () => {
  const db = seededMemory();
  try {
    await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weatherSource: 'MeteoSwiss' });
    assert.equal(stored(db).weather_source, 'meteoswiss');
    await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weather_source: 'openagri' });
    assert.equal(stored(db).weather_source, 'openagri');
    await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weatherSource: null });
    assert.equal(stored(db).weather_source, 'auto');
  } finally {
    db.close();
  }
});

test('Build UPDATE SQL: an invalid provider leaves the column, warns once, and applies the rest', async () => {
  const db = seededMemory();
  try {
    db.exec("UPDATE irrigation_zones SET weather_source = 'meteoswiss' WHERE id = 11");
    const run = await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', weatherSource: 'Meteo-Blue!', notes: 'kept going' });
    assert.equal(stored(db).weather_source, 'meteoswiss');
    assert.equal(db.prepare('SELECT notes FROM irrigation_zones WHERE id = 11').get().notes, 'kept going');
    assert.equal(run.warnings.length, 1);
    assert.match(run.warnings[0], new RegExp(ZONE_UUID));
    const quiet = await legacyCommand(db, { commandType: 'UPSERT_ZONE_CONFIG', notes: 'no provider' });
    assert.deepEqual(quiet.warnings, []);
  } finally {
    db.close();
  }
});

test('Build UPDATE SQL: legacy UPSERT_ZONE inserts auto when absent and keeps the stored value on conflict', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SEED);
    db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
      + `VALUES (7, 'grower', 'x', '2026-01-01', '${USER_UUID}', 'admin', 1)`);
    const upsert = { commandType: 'UPSERT_ZONE', name: 'North', gatewayDeviceEui: GATEWAY, user: { userUuid: USER_UUID } };
    await legacyCommand(db, upsert);
    assert.equal(db.prepare('SELECT weather_source FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID).weather_source, 'auto');
    await legacyCommand(db, { ...upsert, weatherSource: 'meteoswiss', syncVersion: 10 });
    assert.equal(db.prepare('SELECT weather_source FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID).weather_source, 'meteoswiss');
    await legacyCommand(db, { ...upsert, syncVersion: 11 });
    assert.equal(db.prepare('SELECT weather_source FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID).weather_source, 'meteoswiss');
  } finally {
    db.close();
  }
});
```

In `scripts/test-zone-command-path.js`, test `missing owner, wrong gateway, malformed numeric fields, and shape drift reject permanently`: replace the `cloudOnlyField` block (the `envelope(12, 'UPSERT_ZONE', 0, { weather_source: 'meteoblue' })` command, its `REJECTED_PERMANENT` assertion and the zero-row assertion after it) with:
```js
    const malformedProvider = envelope(12, 'UPSERT_ZONE', 0, {
      weather_source: 'Meteo-Blue!',
    });
    assert.equal(
      (
        await commands.applyZoneCommand(
          db.facade,
          malformedProvider,
          runtime()
        )
      ).ack.result,
      'REJECTED_PERMANENT'
    );
    assert.equal(
      db.raw.prepare(
        'SELECT COUNT(*) AS n FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).n,
      0
    );

    // A provider only the cloud implements is stored as sent (zone
    // weather_source is edge-owned after sub-project 4; the capability
    // zone_config_weather_source_v1 tells the cloud this gateway accepts it).
    const cloudOnlyProvider = envelope(13, 'UPSERT_ZONE', 0, {
      weather_source: 'meteoblue',
    });
    assert.equal(
      (
        await commands.applyZoneCommand(
          db.facade,
          cloudOnlyProvider,
          runtime()
        )
      ).ack.result,
      'APPLIED'
    );
    assert.equal(
      db.raw.prepare(
        'SELECT weather_source FROM irrigation_zones WHERE zone_uuid=?'
      ).get(ZONE_UUID).weather_source,
      'meteoblue'
    );
```
and insert before `test('database failure rolls back the canonical row and terminal ledger', async () => {`:
```js
test('a full UPSERT_ZONE without weather_source keeps the stored provider', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare(
      "UPDATE irrigation_zones SET weather_source='meteoswiss' WHERE zone_uuid=?"
    ).run(ZONE_UUID);
    db.raw.exec('DELETE FROM sync_outbox');
    const full = await commands.applyZoneCommand(
      db.facade,
      envelope(14, 'UPSERT_ZONE', 1, { name: 'North orchard' }),
      runtime()
    );
    assert.equal(full.ack.result, 'APPLIED');
    const zone = db.raw.prepare(
      'SELECT name, weather_source FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.name, 'North orchard');
    assert.equal(zone.weather_source, 'meteoswiss');
    const event = JSON.parse(db.raw.prepare(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='ZONE' ORDER BY rowid DESC LIMIT 1"
    ).get().payload_json);
    assert.equal(event.weather_source, 'meteoswiss');
  } finally {
    db.raw.close();
  }
});

test('a full UPSERT_ZONE writes a present weather_source, null keeps it, and UPSERT_ZONE_LOCATION ignores it', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.exec('DELETE FROM sync_outbox');
    const provider = () => db.raw.prepare(
      'SELECT weather_source FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID).weather_source;

    // Present: trimmed, lower-cased and written by updateFullZone.
    const written = await commands.applyZoneCommand(
      db.facade,
      envelope(15, 'UPSERT_ZONE', 1, { weather_source: ' MeteoSwiss ' }),
      runtime()
    );
    assert.equal(written.ack.result, 'APPLIED');
    assert.equal(provider(), 'meteoswiss');
    const event = JSON.parse(db.raw.prepare(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='ZONE' ORDER BY rowid DESC LIMIT 1"
    ).get().payload_json);
    assert.equal(event.weather_source, 'meteoswiss');

    // null means absent: the stored provider stays.
    const cleared = await commands.applyZoneCommand(
      db.facade,
      envelope(16, 'UPSERT_ZONE', 2, { weather_source: null }),
      runtime()
    );
    assert.equal(cleared.ack.result, 'APPLIED');
    assert.equal(provider(), 'meteoswiss');

    // A location command parses the field (a malformed value fails closed) and
    // updateLocation does not write it.
    const location = await commands.applyZoneCommand(
      db.facade,
      envelope(17, 'UPSERT_ZONE_LOCATION', 3, {
        latitude: 46.9,
        longitude: 7.4,
        weather_source: 'local',
      }),
      runtime()
    );
    assert.equal(location.ack.result, 'APPLIED');
    const zone = db.raw.prepare(
      'SELECT latitude, weather_source FROM irrigation_zones WHERE zone_uuid=?'
    ).get(ZONE_UUID);
    assert.equal(zone.latitude, 46.9);
    assert.equal(zone.weather_source, 'meteoswiss');
  } finally {
    db.raw.close();
  }
});

```

In `scripts/test-contract-schemas.js`, insert before `if (!ok) process.exit(1);` (the last lines of the file):
```js
// Weather data view: a zone may carry the provider key; the cloud's set is
// wider than the edge's, so the contract checks the shape, not an enum.
expectValid(
    'a Zone resource with a cloud-only weather_source stays valid',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'North', weather_source: 'agromonitoring' },
    resourcesSchema
);
expectInvalid(
    'a Zone resource with a malformed weather_source',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'North', weather_source: 'Meteo-Blue!' },
    /does not match/,
    resourcesSchema
);
expectInvalid(
    'a Zone resource with a 21-character weather_source',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'North', weather_source: 'a'.repeat(21) },
    null,
    resourcesSchema
);
```

In `scripts/verify-sync-flow.js`, after `expectIncludesById('4f4a765f36cee6f3', 'keeping the stored zone name', 'warns instead of silently discarding an invalid legacy zone name');` add:
```js
expectIncludesById('4f4a765f36cee6f3', "sets.push('weather_source = '", 'stores weather_source from a legacy UPSERT_ZONE_CONFIG');
expectIncludesById('4f4a765f36cee6f3', 'weather_source=excluded.weather_source', 'stores weather_source from a legacy UPSERT_ZONE and keeps the stored value when absent');
```

- [ ] **Step 2: Run the tests to see them fail**

```bash
node --test scripts/test-zone-weather-source.js scripts/test-zone-command-path.js
node scripts/test-contract-schemas.js
```
Expected: the three `Build UPDATE SQL` tests fail (the column keeps its value); `test-zone-command-path.js` fails twice: the shape-drift test on `meteoblue` and the new write test on `' MeteoSwiss '` (both `REJECTED_PERMANENT`, shape mismatch `extra=weather_source`). The new keep test passes already: it sends no `weather_source`, and `updateFullZone` never touched the column; it pins Step 4's "absent keeps the stored value" branch. The contract script fails the two rejection checks (`weather_source` is not declared, so nothing constrains it).

- [ ] **Step 3: Legacy path, one-shot flows edit**

`$SCRATCH/flows-build-update-sql.js`:
```js
#!/usr/bin/env node
// One-shot (Task 7): the legacy "Build UPDATE SQL" node (4f4a765f36cee6f3)
// stores weather_source from UPSERT_ZONE_CONFIG and legacy UPSERT_ZONE.
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) throw new Error('profiles differ before the edit');
const node = flows.find((n) => n.id === '4f4a765f36cee6f3');
if (!node) throw new Error('4f4a765f36cee6f3 not found');
const swaps = [
  // Legacy UPSERT_ZONE: decide the provider in JavaScript, as the name is decided.
  ["  var conflictName = zoneName === null ? 'irrigation_zones.name' : 'excluded.name';\n",
    "  var conflictName = zoneName === null ? 'irrigation_zones.name' : 'excluded.name';\n" +
    "  var zoneWeatherSource = null;\n" +
    "  if (cmd.weatherSource !== undefined || cmd.weather_source !== undefined) {\n" +
    "    var rawZoneWeatherSource = cmd.weatherSource !== undefined ? cmd.weatherSource : cmd.weather_source;\n" +
    "    var trimmedZoneWeatherSource = rawZoneWeatherSource === null ? '' : String(rawZoneWeatherSource).trim().toLowerCase();\n" +
    "    if (/^[a-z_]{1,20}$/.test(trimmedZoneWeatherSource)) zoneWeatherSource = trimmedZoneWeatherSource;\n" +
    "    else if (trimmedZoneWeatherSource) node.warn('Build UPDATE SQL: legacy UPSERT_ZONE carried an invalid weather_source for ' + String(zoneUuid) + '; keeping the stored provider');\n" +
    "  }\n" +
    "  var conflictWeatherSource = zoneWeatherSource === null ? 'weather_source=irrigation_zones.weather_source' : 'weather_source=excluded.weather_source';\n"],
  ["scheduling_mode, prediction_card_enabled, notes, sync_version, deleted_at) \" +",
    "scheduling_mode, prediction_card_enabled, notes, sync_version, deleted_at, weather_source) \" +"],
  ["\", \" + s(cmd.deletedAt || cmd.deleted_at) + \" FROM users WHERE \"",
    "\", \" + s(cmd.deletedAt || cmd.deleted_at) + \", \" + s(zoneWeatherSource || 'auto') + \" FROM users WHERE \""],
  ["notes=excluded.notes, sync_version=excluded.sync_version, deleted_at=excluded.deleted_at\";",
    "notes=excluded.notes, sync_version=excluded.sync_version, deleted_at=excluded.deleted_at, \" + conflictWeatherSource;"],
  // UPSERT_ZONE_CONFIG: null or empty stores 'auto'; an invalid string is ignored with a warning.
  ["    sets.push('prediction_card_enabled = ' + b(predictionCardEnabled, false));\n  }\n  sets.push('updated_at = ' + s(now));",
    "    sets.push('prediction_card_enabled = ' + b(predictionCardEnabled, false));\n  }\n" +
    "  if (cmd.weatherSource !== undefined || cmd.weather_source !== undefined) {\n" +
    "    var ws = cmd.weatherSource !== undefined ? cmd.weatherSource : cmd.weather_source;\n" +
    "    var normalizedWeatherSource = ws === null ? '' : String(ws).trim().toLowerCase();\n" +
    "    if (!normalizedWeatherSource) sets.push('weather_source = ' + s('auto'));\n" +
    "    else if (/^[a-z_]{1,20}$/.test(normalizedWeatherSource)) sets.push('weather_source = ' + s(normalizedWeatherSource));\n" +
    "    else node.warn('Build UPDATE SQL: UPSERT_ZONE_CONFIG carried an invalid weather_source for ' + String(cmd.zoneUuid || cmd.zone_uuid) + '; keeping the stored provider');\n" +
    "  }\n" +
    "  sets.push('updated_at = ' + s(now));"],
];
for (const [from, to] of swaps) {
  const count = node.func.split(from).length - 1;
  if (count !== 1) throw new Error(`expected one match, found ${count}: ${from.slice(0, 80)}`);
  node.func = node.func.replace(from, to);
}
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('edited 4f4a765f36cee6f3 in both profiles');
```
```bash
node $SCRATCH/flows-build-update-sql.js
node scripts/verify-flows-fn-parse.js
```
Expected: `edited 4f4a765f36cee6f3 in both profiles`; `verify-flows-fn-parse: OK`.

- [ ] **Step 4: Protected path in `osi-zone-commands`**

In `normalizedZone`, the `exactObject` call becomes:
```js
  // weather_source is optional: a cloud that has not adopted the field sends
  // the full zone object without it (spec 2026-09-27-weather-data-view-design).
  const zone = exactObject(
    input,
    'zone',
    type === 'DELETE_ZONE' ? common : common.concat(portable),
    type === 'DELETE_ZONE' ? [] : ['weather_source']
  );
```
and after `result.notes = nullableText(zone.notes, 'zone.notes', 4096);` add:
```js
    // null or empty means absent: updateFullZone then keeps the stored value.
    result.weatherSource = null;
    if (zone.weather_source != null) {
      const weatherSource = String(zone.weather_source).trim().toLowerCase();
      if (weatherSource && !/^[a-z_]{1,20}$/.test(weatherSource)) {
        throw commandError(
          'malformed_command',
          'zone.weather_source must be 1 to 20 lower-case letters or underscores'
        );
      }
      result.weatherSource = weatherSource || null;
    }
```
In `insertZone`, the column list ends `'prediction_card_enabled,notes,sync_version,deleted_at,created_at,updated_at,' + 'weather_source' +`, the placeholder list gains one `?` (23 in total), and the value list ends with `zone.weatherSource || 'auto',` after the second `now,`:
```js
  await tx.run(
    'INSERT INTO irrigation_zones (' +
      'name,user_id,zone_uuid,gateway_device_eui,timezone,latitude,longitude,' +
      'phenological_stage,calibration_key,crop_type,variety,soil_type,' +
      'irrigation_method,area_m2,irrigation_efficiency_pct,scheduling_mode,' +
      'prediction_card_enabled,notes,sync_version,deleted_at,created_at,updated_at,' +
      'weather_source' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
```
`updateFullZone` becomes:
```js
async function updateFullZone(tx, command, current, zone) {
  await assertExistingOwner(tx, current, zone);
  // A command without weather_source keeps the stored provider.
  const weatherSource = zone.weatherSource === null ? [] : [zone.weatherSource];
  await tx.run(
    'UPDATE irrigation_zones SET ' +
      'name=?,timezone=?,latitude=?,longitude=?,phenological_stage=?,' +
      'calibration_key=?,crop_type=?,variety=?,soil_type=?,irrigation_method=?,' +
      'area_m2=?,irrigation_efficiency_pct=?,scheduling_mode=?,' +
      'prediction_card_enabled=?,notes=?,' +
      (weatherSource.length ? 'weather_source=?,' : '') +
      'sync_version=?,updated_at=? ' +
      'WHERE zone_uuid=?',
    [
      zone.name,
      zone.timezone,
      zone.latitude,
      zone.longitude,
      zone.phenologicalStage,
      zone.calibrationKey,
      zone.cropType,
      zone.variety,
      zone.soilType,
      zone.irrigationMethod,
      zone.areaM2,
      zone.irrigationEfficiencyPct,
      zone.schedulingMode,
      zone.predictionCardEnabled,
      zone.notes,
      ...weatherSource,
      command.target,
      new Date().toISOString(),
      command.zoneUuid,
    ]
  );
}
```
Mirror: `cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-commands/index.js`.

- [ ] **Step 5: The contract**

In `docs/contracts/sync-schema/resources.schema.json`, definition `Zone`, insert between the `prediction_card` and `deleted_at` lines (same 16-space indent):
```json
                "weather_source": {"type": "string", "minLength": 1, "maxLength": 20, "pattern": "^[a-z_]{1,20}$"},
```
`required` stays `["zone_id", "name"]`; the file keeps its version.

- [ ] **Step 6: Size ratchet and identity pin**

The shared `$SCRATCH/ratchet.js` from Task 5 Step 8 measures the node and rewrites the total:
```bash
node $SCRATCH/ratchet.js 4f4a765f36cee6f3
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `4f4a765f36cee6f3 origin/main 19386 -> HEAD 20873 = +1487`; `total origin/main 1580418 -> HEAD 1587573 = +7155`; ratchet OK.

In `scripts/verify-live-gateway-identity.js`, the total pin from Task 6 becomes:
```js
  // 7155: weather data view Task 7 adds 4f4a765f36cee6f3 (+1487, legacy UPSERT_ZONE_CONFIG
  // and UPSERT_ZONE store weather_source) to Task 6's 5668. verify-flows-size-ratchet
  // totalChars over both byte-identical profiles: origin/main 1580418 -> HEAD 1587573 = +7155.
  expectCondition(sizeAllowances.total_allowance?.delta === 7155,
    'size total allowance: exact cumulative delta 7155',
    'size total allowance: expected exact cumulative delta 7155');
```
(keep the 4350 and 5668 comments above it), and the node-id loop's array gains `'4f4a765f36cee6f3'`.

- [ ] **Step 7: Run the gates**

```bash
node --test scripts/test-zone-weather-source.js scripts/test-zone-command-path.js scripts/test-legacy-upsert-zone-name.js scripts/test-entity-name-command-path.js scripts/test-terra-selection-edge-acceptance.js scripts/test-terra-zone-config-command-flow.js scripts/test-scoped-access-command-path.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
node scripts/verify-profile-parity.js && node scripts/verify-flows-fn-parse.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
```
Expected: `test-zone-weather-source.js` 27 pass, `test-zone-command-path.js` 12 pass, the rest `# fail 0` (the Terra fixture from Task 5 stays valid: the Terra path does not send the field); `PASS: contract schema checks pass`; `verify-sync-contract: OK`; parity, parse, wiring, silent-catch and stray-DDL pass; ratchet OK; `Live gateway identity verification passed.`; verify-sync-flow ends `All parity checks passed.`

- [ ] **Step 8: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-commands/index.js scripts/test-zone-command-path.js scripts/test-zone-weather-source.js scripts/test-contract-schemas.js scripts/verify-sync-flow.js docs/contracts/sync-schema/resources.schema.json scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git -c user.name=Project-OSI commit -m "feat(sync): cloud zone commands carry weather_source on both paths; Zone contract gains weather_source"
```

---

### Task 8: Zone settings weather provider selector (GUI)

**Files:**
- Modify: `web/react-gui/src/types/farming.ts` (`IrrigationZone`), `src/services/api.ts` (`RawIrrigationZone`, `normaliseZone`, `updateConfig` payload type), `src/components/farming/ZoneConfigModal.tsx`, the seven `public/locales/*/devices.json`, `tests/zoneFormLocales.test.ts`, `docs/i18n/pending-luganda-translations.md`
- Tests: `src/components/farming/__tests__/ZoneConfigModal.test.tsx`, `src/services/__tests__/irrigationZonesApi.test.ts`
- Not changed (spec decision): `AdvancedScheduleDrawer.tsx`
- Scratch: `$SCRATCH/zone-weather-locales.js`

File paths below are relative to `web/react-gui/` unless they start with `docs/`. Commands state their directory: the `$SCRATCH` locale script writes `web/react-gui/public/...` and runs from the repository root.

**Interfaces:**
- Consumes: `weather_source` and `weather_source_default` on `GET /api/irrigation-zones` rows and `PUT …/config` accepting `weatherSource` (Task 6).
- Produces: `IrrigationZone.weather_source?`, `weatherSource?: string | null`, `weatherSourceDefault?: 'open_meteo' | 'meteoswiss' | null`; `normaliseZone` maps `weatherSource: z.weatherSource ?? z.weather_source ?? 'auto'` and `weatherSourceDefault: z.weatherSourceDefault ?? z.weather_source_default ?? 'open_meteo'`; `irrigationZonesAPI.updateConfig` payload gains `weatherSource?: string`; eight `zoneConfig.*` keys.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe` of `src/components/farming/__tests__/ZoneConfigModal.test.tsx`, and change its testing-library import to `import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';`:
```tsx

  it('offers four weather providers and names the gateway default in the auto option', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, weatherSourceDefault: 'meteoswiss' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const provider = screen.getByLabelText('Weather provider') as HTMLSelectElement;
    expect([...provider.options].map((o) => [o.value, o.textContent])).toEqual([
      ['auto', 'Gateway default (MeteoSwiss)'],
      ['open_meteo', 'Open-Meteo'],
      ['meteoswiss', 'MeteoSwiss'],
      ['local', 'Local weather station only'],
    ]);
    expect(provider.value).toBe('auto');
    expect(screen.queryByText(/downloads no weather history/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About the weather provider' }));
    expect(screen.getByText(/downloads no weather history/)).toBeInTheDocument();
  });

  it('sends the chosen provider, and nothing when the selection is unchanged', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.change(screen.getByLabelText('Weather provider'), { target: { value: 'meteoswiss' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { weatherSource: 'meteoswiss' }));

    vi.clearAllMocks();
    cleanup();
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, weatherSource: 'open_meteo' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'x' }));
  });

  it('shows a cloud-only provider as a disabled selected option and keeps it on a crop save', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, weatherSource: 'openagri' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const provider = screen.getByLabelText('Weather provider') as HTMLSelectElement;
    expect(provider.value).toBe('openagri');
    expect(provider.selectedOptions[0].textContent).toBe('openagri (cloud provider)');
    expect(provider.selectedOptions[0].disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Crop'), { target: { value: 'maize' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { cropType: 'maize' }));
  });

  it('places the provider after the Device GPS panel and before Notes', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone, onClose: vi.fn(), onSaved: vi.fn() }));
    const gps = screen.getByText('Device GPS');
    const provider = screen.getByLabelText('Weather provider');
    const notes = screen.getByLabelText('Notes');
    expect(gps.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(provider.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
```

Append at the end of `src/services/__tests__/irrigationZonesApi.test.ts`:
```ts

describe('irrigationZonesAPI weather provider fields', () => {
  it('maps the edge snake_case fields and defaults a missing value to auto / open_meteo', async () => {
    get.mockResolvedValue({
      data: [
        { ...baseZone, weather_source: 'meteoswiss', weather_source_default: 'meteoswiss' },
        { ...baseZone, id: 8 },
      ],
    });
    const [chosen, legacy] = await irrigationZonesAPI.getAll();
    expect(chosen.weatherSource).toBe('meteoswiss');
    expect(chosen.weatherSourceDefault).toBe('meteoswiss');
    expect(legacy.weatherSource).toBe('auto');
    expect(legacy.weatherSourceDefault).toBe('open_meteo');
  });
});
```

In `tests/zoneFormLocales.test.ts`, append to `KEYS` (after `'environment.agronomic.kcHelp',`):
```ts
  'zoneConfig.weatherProvider',
  'zoneConfig.weatherProviderHelpLabel',
  'zoneConfig.weatherProviderHelp',
  'zoneConfig.weatherProviderOption.auto',
  'zoneConfig.weatherProviderOption.open_meteo',
  'zoneConfig.weatherProviderOption.meteoswiss',
  'zoneConfig.weatherProviderOption.local',
  'zoneConfig.weatherProviderCloud',
```
and to `REVIEWED_IDENTICAL` (after `'pt:zoneConfig.longitude',`):
```ts
  // Product and agency names: Open-Meteo everywhere, MeteoSwiss in es and pt.
  'de-CH:zoneConfig.weatherProviderOption.open_meteo',
  'es:zoneConfig.weatherProviderOption.open_meteo',
  'fr:zoneConfig.weatherProviderOption.open_meteo',
  'it:zoneConfig.weatherProviderOption.open_meteo',
  'pt:zoneConfig.weatherProviderOption.open_meteo',
  'es:zoneConfig.weatherProviderOption.meteoswiss',
  'pt:zoneConfig.weatherProviderOption.meteoswiss',
```

- [ ] **Step 2: Run the tests to see them fail**

Run the two halves of `test:unit` separately, so the locale failure does not hide the vitest ones:
```bash
(cd web/react-gui && npx tsx --test tests/zoneFormLocales.test.ts)
(cd web/react-gui && npx vitest run src/components/farming/__tests__/ZoneConfigModal.test.tsx src/services/__tests__/irrigationZonesApi.test.ts)
```
Expected: the tsx runner fails four of the five `zoneFormLocales` tests (the eight keys missing in every locale; the Luganda test passes vacuously). Vitest fails the four modal tests (no `Weather provider` control) and the API test (`weatherSource` undefined); every other test in the two files stays green.

- [ ] **Step 3: Types and the API normaliser**

`src/types/farming.ts`, `IrrigationZone`: after `prediction_card_enabled?: boolean | null;` add
```ts
  /** 'auto' | 'open_meteo' | 'meteoswiss' | 'local', or a provider only the cloud implements. */
  weather_source?: string | null;
```
and directly under the comment `// Compat aliases (server uses camelCase)` add
```ts
  weatherSource?: string | null;
  /** The provider 'auto' resolves to on this gateway (GET /api/irrigation-zones). */
  weatherSourceDefault?: 'open_meteo' | 'meteoswiss' | null;
```
`src/services/api.ts`: `RawIrrigationZone` gains `weather_source_default?: 'open_meteo' | 'meteoswiss' | null;` after `variety_compat?: string | null;`; `normaliseZone` gains, after the `calibrationKey:` line,
```ts
    weatherSource:     z.weatherSource     ?? z.weather_source     ?? 'auto',
    weatherSourceDefault: z.weatherSourceDefault ?? z.weather_source_default ?? 'open_meteo',
```
and the `updateConfig` payload type gains `weatherSource?: string;` after `predictionCardEnabled?: boolean;`.

- [ ] **Step 4: The selector in `ZoneConfigModal.tsx`**

Before `/** A variant sits under its default crop, indented and marked with an en dash. */` add:
```tsx
/** The providers the edge implements (osi-weather-provider resolveProvider). */
const WEATHER_SOURCES = ['auto', 'open_meteo', 'meteoswiss', 'local'];
const WEATHER_SOURCE_FALLBACK: Record<string, string> = {
  open_meteo: 'Open-Meteo',
  meteoswiss: 'MeteoSwiss',
  local: 'Local weather station only',
};

```
State: after `const [calibrationKey, setCalibrationKey] = useState(zone.calibrationKey ?? 'default');` add `  const [weatherSource, setWeatherSource] = useState(zone.weatherSource ?? 'auto');`, and in the `useEffect` that re-syncs on `zone`, after `setCalibrationKey(zone.calibrationKey ?? 'default');` add `    setWeatherSource(zone.weatherSource ?? 'auto');`.

`buildConfigPayload`: the payload type gains `      weatherSource?: string;` after `calibrationKey?: string | null;`, and after the `calibrationKey` comparison add
```tsx
    // Sent only when the user picked another provider, so a save of other
    // fields never rewrites a stored value, including a cloud-only one.
    if ((zone.weatherSource ?? 'auto') !== weatherSource) payload.weatherSource = weatherSource;
```
Before `const canRequestDeviceLocation = Boolean(` add
```tsx
  const storedWeatherSource = zone.weatherSource ?? 'auto';
  const weatherSourceLabel = (value: string) => t(`zoneConfig.weatherProviderOption.${value}`, { defaultValue: WEATHER_SOURCE_FALLBACK[value] ?? value });
  const weatherSourceOptionLabel = (value: string) => (value === 'auto'
    ? t('zoneConfig.weatherProviderOption.auto', {
      provider: weatherSourceLabel(zone.weatherSourceDefault === 'meteoswiss' ? 'meteoswiss' : 'open_meteo'),
      defaultValue: 'Gateway default ({{provider}})',
    })
    : weatherSourceLabel(value));

```
Between the closing `</div>` of the Device GPS panel (right after `{deviceLocationError && (…)}`) and `<hr className="border-[var(--border)]" />`, insert:
```tsx

          {/* Weather provider */}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor={id('weatherSource')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                {t('zoneConfig.weatherProvider', { defaultValue: 'Weather provider' })}
              </label>
              <HelpTip label={t('zoneConfig.weatherProviderHelpLabel', { defaultValue: 'About the weather provider' })}>
                {t('zoneConfig.weatherProviderHelp', {
                  defaultValue: 'Sets where this zone\'s hourly weather history comes from, and its daily ET0 unless an assigned weather station has a complete day, which takes precedence. MeteoSwiss covers Switzerland. With Local weather station only, the gateway downloads no weather history for this zone, so without an assigned station it gets no ET0. The weather forecast does not change.',
                })}
              </HelpTip>
            </div>
            <select
              id={id('weatherSource')}
              value={weatherSource}
              onChange={e => setWeatherSource(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm"
            >
              {WEATHER_SOURCES.map(value => (
                <option key={value} value={value}>{weatherSourceOptionLabel(value)}</option>
              ))}
              {/* A value only the cloud implements stays visible and selected;
                  once the user picks another it cannot be chosen again here. */}
              {!WEATHER_SOURCES.includes(storedWeatherSource) && (
                <option value={storedWeatherSource} disabled>
                  {t('zoneConfig.weatherProviderCloud', { value: storedWeatherSource, defaultValue: '{{value}} (cloud provider)' })}
                </option>
              )}
            </select>
          </div>
```
The field is laid out like the stage field: a label row with a `HelpTip`, then a native `<select>`. No caption, note or banner.

- [ ] **Step 5: Locale keys**

`$SCRATCH/zone-weather-locales.js`:
```js
// One-shot: the eight zoneConfig weather-provider keys in all seven
// devices.json bundles. lg carries the English text (edge lg policy).
const fs = require('fs');
const EN = {
  weatherProvider: 'Weather provider',
  weatherProviderHelpLabel: 'About the weather provider',
  weatherProviderHelp: 'Sets where this zone\'s hourly weather history comes from, and its daily ET0 unless an assigned weather station has a complete day, which takes precedence. MeteoSwiss covers Switzerland. With Local weather station only, the gateway downloads no weather history for this zone, so without an assigned station it gets no ET0. The weather forecast does not change.',
  weatherProviderOption: { auto: 'Gateway default ({{provider}})', open_meteo: 'Open-Meteo', meteoswiss: 'MeteoSwiss', local: 'Local weather station only' },
  weatherProviderCloud: '{{value}} (cloud provider)',
};
const TEXT = {
  en: EN,
  lg: EN,
  'de-CH': {
    weatherProvider: 'Wetteranbieter',
    weatherProviderHelpLabel: 'Über den Wetteranbieter',
    weatherProviderHelp: 'Legt fest, woher der stündliche Wetterverlauf dieser Zone kommt und damit ihre tägliche ET0, es sei denn, eine zugewiesene Wetterstation hat einen vollständigen Tag; dieser hat Vorrang. MeteoSchweiz deckt die Schweiz ab. Mit «Nur lokale Wetterstation» lädt das Gateway für diese Zone keinen Wetterverlauf herunter; ohne zugewiesene Station erhält sie dann keine ET0. Die Wetterprognose ändert sich nicht.',
    weatherProviderOption: { auto: 'Gateway-Standard ({{provider}})', open_meteo: 'Open-Meteo', meteoswiss: 'MeteoSchweiz', local: 'Nur lokale Wetterstation' },
    weatherProviderCloud: '{{value}} (Cloud-Anbieter)',
  },
  fr: {
    weatherProvider: 'Fournisseur météo',
    weatherProviderHelpLabel: 'À propos du fournisseur météo',
    weatherProviderHelp: 'Définit la provenance de l\'historique météo horaire de cette zone, et donc de son ET0 journalière, sauf si une station météo attribuée dispose d\'une journée complète, qui est alors prioritaire. MétéoSuisse couvre la Suisse. Avec « Station météo locale uniquement », la passerelle ne télécharge aucun historique météo pour cette zone ; sans station attribuée, elle n\'obtient donc aucune ET0. Les prévisions météo ne changent pas.',
    weatherProviderOption: { auto: 'Par défaut de la passerelle ({{provider}})', open_meteo: 'Open-Meteo', meteoswiss: 'MétéoSuisse', local: 'Station météo locale uniquement' },
    weatherProviderCloud: '{{value}} (fournisseur cloud)',
  },
  it: {
    weatherProvider: 'Fornitore meteo',
    weatherProviderHelpLabel: 'Informazioni sul fornitore meteo',
    weatherProviderHelp: 'Stabilisce da dove proviene lo storico meteo orario di questa zona, e quindi la sua ET0 giornaliera, a meno che una stazione meteo assegnata abbia una giornata completa, che ha la precedenza. MeteoSvizzera copre la Svizzera. Con «Solo stazione meteo locale» il gateway non scarica alcuno storico meteo per questa zona; senza una stazione assegnata la zona non ottiene quindi alcuna ET0. Le previsioni meteo non cambiano.',
    weatherProviderOption: { auto: 'Predefinito del gateway ({{provider}})', open_meteo: 'Open-Meteo', meteoswiss: 'MeteoSvizzera', local: 'Solo stazione meteo locale' },
    weatherProviderCloud: '{{value}} (fornitore cloud)',
  },
  es: {
    weatherProvider: 'Proveedor meteorológico',
    weatherProviderHelpLabel: 'Acerca del proveedor meteorológico',
    weatherProviderHelp: 'Define de dónde procede el historial meteorológico horario de esta zona y, con él, su ET0 diaria, salvo que una estación meteorológica asignada tenga un día completo, que entonces tiene prioridad. MeteoSwiss cubre Suiza. Con «Solo estación meteorológica local», el gateway no descarga ningún historial meteorológico para esta zona; sin una estación asignada, no obtiene ninguna ET0. El pronóstico del tiempo no cambia.',
    weatherProviderOption: { auto: 'Predeterminado del gateway ({{provider}})', open_meteo: 'Open-Meteo', meteoswiss: 'MeteoSwiss', local: 'Solo estación meteorológica local' },
    weatherProviderCloud: '{{value}} (proveedor en la nube)',
  },
  pt: {
    weatherProvider: 'Fornecedor meteorológico',
    weatherProviderHelpLabel: 'Sobre o fornecedor meteorológico',
    weatherProviderHelp: 'Define de onde vem o histórico meteorológico horário desta zona e, com ele, a sua ET0 diária, exceto se uma estação meteorológica atribuída tiver um dia completo, que passa então a ter prioridade. A MeteoSwiss cobre a Suíça. Com «Apenas estação meteorológica local», o gateway não descarrega nenhum histórico meteorológico para esta zona; sem uma estação atribuída, não obtém nenhuma ET0. A previsão do tempo não muda.',
    weatherProviderOption: { auto: 'Predefinição do gateway ({{provider}})', open_meteo: 'Open-Meteo', meteoswiss: 'MeteoSwiss', local: 'Apenas estação meteorológica local' },
    weatherProviderCloud: '{{value}} (fornecedor na nuvem)',
  },
};
for (const [locale, keys] of Object.entries(TEXT)) {
  const file = `web/react-gui/public/locales/${locale}/devices.json`;
  const before = fs.readFileSync(file, 'utf8');
  const bundle = JSON.parse(before);
  if (JSON.stringify(bundle, null, 2) + '\n' !== before) throw new Error(`${file} does not round-trip`);
  Object.assign(bundle.zoneConfig, JSON.parse(JSON.stringify(keys)));
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
}
console.log('zoneConfig weather provider keys written to 7 bundles');
```
Run (from the repository root): `node $SCRATCH/zone-weather-locales.js`. Expected: `zoneConfig weather provider keys written to 7 bundles`. The de-CH copy has no ß (the rule the locale test enforces); MeteoSchweiz, MétéoSuisse and MeteoSvizzera are the agency's names in de-CH, fr and it. The fr and es "Gateway default" labels are short enough for the closed select on a 360 px phone (about 280 px wide).

In `docs/i18n/pending-luganda-translations.md`, the heading added in Task 4 becomes `` ## `devices.json` and `common.json` — weather data view `` (the order of the row below), and the row becomes:
```markdown
| `zoneConfig.weatherProvider`, `weatherProviderHelpLabel`, `weatherProviderHelp`, `weatherProviderOption.auto`, `open_meteo`, `meteoswiss`, `local`, `weatherProviderCloud` (8 keys in `devices.json`); `analysis.aggregation.helpLabel`, `analysis.aggregation.help`, `analysis.tooltip.partialHours`, `analysis.tooltip.partialDays` (4 keys in `common.json`) | Added by the weather data view (the zone weather provider selector, the Data tab's aggregation tip and the partial-sum marker, 2026-09-27). No human Luganda pass yet, so `lg` ships the English source text. The `zoneConfig.*` keys are listed in `zoneFormLocales.test.ts`, the `analysis.*` keys in `analysis-locales.test.ts`. |
```
and the paragraph under the table names both tests:
```markdown
Tracked in code at `web/react-gui/tests/zoneFormLocales.test.ts` and
`web/react-gui/tests/analysis-locales.test.ts`, which assert each key's `lg`
value is still byte-identical to `en`. A human Luganda pass must drop the key
from the test's list (`KEYS` in `zoneFormLocales.test.ts`,
`PENDING_HUMAN_LUGANDA` in `analysis-locales.test.ts`) and from the table above
in the same change.
```

- [ ] **Step 6: Run the gates**

```bash
(cd web/react-gui && npm run test:unit && npm run typecheck)
node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md
```
Expected: `test:unit` green (including `zoneFormLocales` 5 tests and the 31 modal and API tests); typecheck exit 0; `slop-check: PASS`.

- [ ] **Step 7: Commit**

```bash
git add web/react-gui/src web/react-gui/tests web/react-gui/public/locales docs/i18n/pending-luganda-translations.md
git -c user.name=Project-OSI commit -m "feat(gui): weather provider selector in zone settings"
```

---

### Task 9: Docs, whole-branch gates, execution report

**Files:**
- Modify: `AGENTS.md` (the capability list, lines 72–77; the provider weather store paragraph, line 205), `docs/contracts/sync-schema/README.md` (new section)
- Create: `docs/superpowers/plans/2026-09-27-weather-data-view-execution-report.md`

- [ ] **Step 1: `AGENTS.md`**

Replace the paragraph that starts `**Sync capabilities the edge reports**` with:
```markdown
**Sync capabilities the edge reports** (built identically by `sync-bootstrap-build`,
`al-link-build-req` and `sync-force-build`): `linked_auth_sync_v1`,
`force_edge_sync_v1`, `installation_recovery_v1`, `installation_locations_v1`,
`entity_name_commands_v1`, `zone_config_weather_source_v1`, and `field_journal_v1`
when the journal is enabled. The cloud reads the list as
`gatewayIdentity.syncCapabilities()` and sends a name command only to a gateway that
reported `entity_name_commands_v1`. It sends `weather_source` in zone commands only
to a gateway that reported `zone_config_weather_source_v1`.
```
In the paragraph that starts `**Provider weather store:**`, replace ``unless a zone's `weather_source` overrides it; nothing syncs (each side fetches for itself).`` with:
```markdown
unless a zone's `weather_source` overrides it. The hourly tables do not sync and each side fetches for itself; a zone's `weather_source` travels in the zone events and snapshots, and after sub-project 4 the edge owns it.
```

- [ ] **Step 2: Contract README**

In `docs/contracts/sync-schema/README.md`, insert before `## Versioning`:
```markdown
## Zone `weather_source`

`Zone.weather_source` is the zone's weather provider key: `auto`, `open_meteo`,
`meteoswiss` or `local` on the edge, and keys only the cloud implements
(`openagri`, `agromonitoring`). The schema checks the shape (`^[a-z_]{1,20}$`; the
cloud column is `VARCHAR(20)`), not a set of values. The edge stores the field from
`UPSERT_ZONE_CONFIG`, legacy `UPSERT_ZONE` and protected `UPSERT_ZONE`, emits it in
every zone update event and in the bootstrap and force-sync snapshots, and reports
`zone_config_weather_source_v1`. The cloud sends the field only to a gateway that
reported the token: a gateway without it rejects a protected `UPSERT_ZONE` that
carries the field.

```

- [ ] **Step 3: Whole-branch gates**

```bash
P=conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
# The gates that read osi-server take the paired worktree explicitly; without the
# variables test-rejection-recovery-contract.js falls back to the main osi-server
# checkout, which sits on another branch.
OSI_SERVER=<osi-server>/.worktrees/weather-data-view
export OSI_SERVER_REJECTION_RECOVERY_CONTRACT=$OSI_SERVER/backend/src/test/resources/sync-contract/rejection-recovery-v1.json
export OSI_SERVER_EDGE_SYNC_SERVICE=$OSI_SERVER/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java
export TMPDIR=/var/tmp/osi-weather-data-view && mkdir -p "$TMPDIR" && df -h "$TMPDIR"
node --test $P/osi-history-helper/index.test.js $P/osi-history-helper/analysis.test.js $P/osi-weather-provider/index.test.js $P/osi-weather-provider/facade-contract.test.js $P/osi-station-hours/index.test.js $P/osi-agronomy-daily/index.test.js $P/osi-lib/index.test.js $P/osi-entity-name/*.test.js
node $P/osi-history-router/index.test.js && node $P/osi-journal/index.test.js
node scripts/test-history-helper.js && node scripts/capture-history-router-vectors.js --verify && node scripts/capture-zone-env-vectors.js --verify && node scripts/verify-history-api-contract.js
node scripts/verify-channel-manifest-parity.js
node --test scripts/test-zone-weather-source.js scripts/test-zone-command-path.js scripts/test-zone-update-sync-version.js scripts/test-legacy-upsert-zone-name.js scripts/test-entity-name-command-path.js scripts/test-scoped-access-reads.js scripts/test-scoped-access-writes.js scripts/test-scoped-access-command-path.js scripts/test-terra-selection-edge-acceptance.js scripts/test-terra-zone-config-command-flow.js scripts/test-sync-trigger-source.js scripts/verify-trigger-body-parity.test.js scripts/verify-sync-op-parity.test.js
node scripts/test-journal-bootstrap.js && node scripts/test-contract-schemas.js && node scripts/verify-sync-contract.js && node scripts/test-rejection-recovery-contract.js
node scripts/generate-sync-trigger-source.js --check
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-trigger-body-parity.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-seed-db-ledger.js && node scripts/verify-no-stray-ddl.js && node scripts/test-journal-schema.js
node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-osi-lib-db-caller-binding.js && node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-flows-size-ratchet.js && bash scripts/check-mqtt-topics.sh
node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/reconcile-ledger-numbering.test.js
(cd web/react-gui && npm run test:unit && npm run typecheck)
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md docs/contracts/sync-schema/README.md docs/i18n/pending-luganda-translations.md docs/channel-manifest.md docs/superpowers/plans/2026-09-27-weather-data-view.md docs/superpowers/specs/2026-09-27-weather-data-view-design.md
```
Expected: every line passes; `osi-agronomy-daily/index.test.js` 27 pass (it reads the weather tables and the zone rows this branch touches). `test-rejection-recovery-contract.js` and `verify-sync-op-parity.test.js` read the files the two `OSI_SERVER_*` variables name; `test-rejection-recovery-contract.js` prints `OK` against the paired worktree and fails `edge and osi-server rejection recovery contracts must be byte-identical` against the main osi-server checkout. `osi-valve-control` timing tests can fail once under heavy parallel load; rerun them alone before calling them red.

- [ ] **Step 4: Execution report**

`docs/superpowers/plans/2026-09-27-weather-data-view-execution-report.md`, with exactly these seven sections, filled from the actual run (this list is the binding shape; the daily agronomy report's sections differ):
1. **What was built**, one paragraph per task with its commit hash (`git log --oneline feat/daily-agronomy..HEAD`).
2. **Gates**, a table of every command of Step 3 with its verbatim pass line, plus the Task 5 migration suite durations.
3. **Ratchet numbers**: each node entry (`sync-init-fn`, `zone-config-fn`, `get-zones-query`, `get-zones-response`, `sync-bootstrap-build`, `sync-force-build`, `al-link-build-req`, `4f4a765f36cee6f3`) as `origin/main X -> HEAD Y = +Z`, the total, and the three `expectedGrowth` re-pins.
4. **Deviations from the spec**, each with its reason: no rebase was needed (the base `8531f1dd1` already carries `6e0ea32cd` and the frozen-snapshot fix); both GUI channel registries (edge Task 1, cloud Task 10) leave a manifest channel with neither an edge nor a server column out of card channel lists (plan review; the spec's exclusion covered only the analysis device catalogue); the analysis chart's tooltip formatter replaces ECharts' default for every series, with the default layout copied (plan review); `test-entity-name-command-path.js` and `test-journal-bootstrap.js` capability pins updated (not named in the spec); `channels.test.ts` accepts a null `serverField` (the spec's entries carry `null`); the Terra fixture regenerated in Task 5, where the payload changes; the osi-server frontend parity test's SHA pin (Task 10, not named in the spec).
5. **Known red not owned here**: none, unless the run finds one; name each with the failing test, the message and the base commit where it already fails.
6. **Follow-ups**: storing Open-Meteo's instantaneous values at their own instant; provider weather in the zone CSV endpoint if a user asks; the sub-project 4 items of the spec ("Paired cloud changes"), including the Terra fixture refresh on osi-server.
7. **Acceptance**: not run. It waits for the merge order of the RAK branch and the three weather branches and for the sub-project 4 cloud change on each gateway's cloud (spec "Ownership and deploy order"); copy the spec's eight acceptance steps as an unticked checklist.

- [ ] **Step 5: Slop check and commit**

```bash
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-09-27-weather-data-view-execution-report.md AGENTS.md docs/contracts/sync-schema/README.md
git add AGENTS.md docs/contracts/sync-schema/README.md docs/superpowers/plans/2026-09-27-weather-data-view-execution-report.md
git -c user.name=Project-OSI commit -m "docs(weather): data view, capability and contract notes; execution report"
```
Expected: `slop-check: PASS`.

---

### Task 10: Paired osi-server copies (cloud, same-named branch)

This task runs in the osi-server worktree `<osi-server>/.worktrees/weather-data-view` (branch `feat/weather-data-view`, at `cce3e8b6`, nothing on it yet) and only after Tasks 1 and 7 are committed on the osi-os branch. It makes the copies the two repos' CI byte-compares, and gives the cloud GUI registry the edge's card-channel rule from Task 1: `cardChannels` (the export channel list of `HistoryMobileShell.tsx`, lines 70–72) leaves out a manifest entry whose `edgeField` and `serverField` are both `null`, so the three weather keys never appear there. The cloud's raw history query already skips a null `serverField` (`JdbcHistoryRawQueryRepository.java` line 354). Pushing the branch is Phil's call; the osi-os PR's CI stays red on the DD5 compare until it is pushed, and the two branches merge in lockstep.

**Files (osi-server):**
- Modify: `frontend/src/channels/channels.json`, `backend/src/main/resources/channels.json` (byte copies of osi-os `web/react-gui/src/channels/channels.json`)
- Modify: `backend/src/test/java/org/osi/server/channels/ChannelManifestTest.java` (`EXPECTED_SHA256`), `frontend/src/channels/__tests__/channels.parity.test.ts` (`EXPECTED_SHA256`), `scripts/verify-channel-manifest-sync.js` (`EXPECTED_SHA256`), `docs/channel-manifest.md` (the recorded SHA)
- Modify: `backend/src/test/resources/sync-contract/resources.schema.json` (byte copy of osi-os `docs/contracts/sync-schema/resources.schema.json`)
- Modify: `frontend/src/channels/registry.ts` (`ChannelManifestEntry`, `cardChannelsForCard`), `frontend/src/channels/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: osi-os `channels.json` with SHA-256 `7c3e70e64c9c79f95eb3f5eff96dd06c3810acc5ed9897af13edfd87c837f105` (Task 1) and `resources.schema.json` with `Zone.weather_source` (Task 7).
- Produces: the same-named osi-server branch that osi-os `migrations.yml` (lines 25–40, 185–210) and osi-server `backend-ci.yml` (lines 66–103) compare against.

- [ ] **Step 1: Install the frontend dependencies and copy the three files**

```bash
cd <osi-server>/.worktrees/weather-data-view
EDGE=<osi-os>/.worktrees/weather-data-view
git status --short
(cd frontend && npm ci)
cp $EDGE/web/react-gui/src/channels/channels.json frontend/src/channels/channels.json
cp $EDGE/web/react-gui/src/channels/channels.json backend/src/main/resources/channels.json
cp $EDGE/docs/contracts/sync-schema/resources.schema.json backend/src/test/resources/sync-contract/resources.schema.json
sha256sum frontend/src/channels/channels.json backend/src/main/resources/channels.json
```
Expected: `git status --short` empty before the copies; `npm ci` exits 0 (the worktree has no `frontend/node_modules`; never run a build); both hashes `7c3e70e64c9c79f95eb3f5eff96dd06c3810acc5ed9897af13edfd87c837f105`.

- [ ] **Step 2: Write the registry test and run the pins to see them fail**

In `frontend/src/channels/__tests__/registry.test.ts`, add as the last test inside `describe('channel registry', ...)` the same test as the edge's (Task 1 Step 3):
```ts

  it('leaves a channel with neither an edge nor a server column out of card channel lists', () => {
    for (const key of ['global_radiation_wm2', 'et0_mm', 'etc_mm']) {
      expect(cardChannels('environment')).not.toContain(key);
      expect(cardChannelsForSource('environment', { deviceType: 'SENSECAP_S2120' })).not.toContain(key);
    }
    // vwc has no edge column but a server one, so it stays.
    expect(cardChannels('soil')).toContain('vwc');
    const registry = createChannelRegistry([
      { key: 'stored', unit: 'mm', label: 'Stored', cardType: 'environment', edgeField: 'stored', serverField: 'stored' },
      { key: 'server_only', unit: 'mm', label: 'Server only', cardType: 'environment', edgeField: null, serverField: 'server_only' },
      { key: 'weather_only', unit: 'mm', label: 'Weather only', cardType: 'environment', edgeField: null, serverField: null },
    ]);
    expect(registry.cardChannels('environment')).toEqual(['stored', 'server_only']);
    expect(registry.cardChannelsForSource('environment', { deviceType: 'SENSECAP_S2120' })).toEqual(['stored', 'server_only']);
  });
```
```bash
OSI_OS_REPO=<osi-os>/.worktrees/weather-data-view node scripts/verify-channel-manifest-sync.js
(cd frontend && npm run test:unit -- channels)
```
Expected: the verifier reports the three copies at the new hash against its expected `3a44492e…` and exits non-zero; the frontend parity test fails on the SHA, and the new registry test fails (the copied manifest now lists the three weather keys, and the synthetic registry lists `weather_only`). The tsx half of `test:unit` runs first and is untouched by this task.

- [ ] **Step 3: Move the SHA pins and add the registry rule**

```bash
OLD=3a44492e41e5c8e986bdce504dcf17a4366ffdf67c2f4952b7bb46e8bbc24dd2
NEW=7c3e70e64c9c79f95eb3f5eff96dd06c3810acc5ed9897af13edfd87c837f105
sed -i "s/$OLD/$NEW/" backend/src/test/java/org/osi/server/channels/ChannelManifestTest.java frontend/src/channels/__tests__/channels.parity.test.ts scripts/verify-channel-manifest-sync.js
grep -rn "$OLD" backend/src frontend/src scripts
```
Expected: the last `grep` prints nothing. (`docs/superpowers/plans/2026-09-03-sdi12-cloud-port-notes.md` keeps its historical mention.)

In `frontend/src/channels/registry.ts`, `ChannelManifestEntry` gains after `legacyAliases?: string[];`
```ts
  edgeField?: string | null;
  serverField?: string | null;
```
after the interface `ChannelSourceContext` add the edge's helper (Task 1 Step 7):
```ts

// A manifest entry with neither an edge nor a server column (global_radiation_wm2,
// et0_mm and etc_mm live only in the edge weather tables) has nothing a card export
// can read, so no card channel list offers it. An entry without the fields counts as
// stored. Same rule as osi-os web/react-gui/src/channels/registry.ts.
function hasStoredColumn(channel: ChannelManifestEntry): boolean {
  return !(channel.edgeField === null && channel.serverField === null);
}
```
and in `cardChannelsForCard` replace
```ts
      .filter((channel) => channel.cardType === cardType && channel.exportable !== false && channel.deprecated !== true)
```
with
```ts
      .filter((channel) => channel.cardType === cardType
        && channel.exportable !== false
        && channel.deprecated !== true
        && hasStoredColumn(channel))
```
`channelKeys()` stays as it is: `deviceHistoryModel.ts` plots only keys that have values in a device's history, and the three keys have none.

In `docs/channel-manifest.md`, replace
````markdown
The canonical SHA-256 for the Phase A manifest is:

```text
66b99314dd9505b8c51da503ed6dd1e687c3f466056e298bf259292b79dd6f59
```
````
with
````markdown
The canonical SHA-256 of the manifest (osi-os `feat/weather-data-view`: `global_radiation_wm2`, `et0_mm` and `etc_mm` added, with a null `serverField`) is:

```text
7c3e70e64c9c79f95eb3f5eff96dd06c3810acc5ed9897af13edfd87c837f105
```
````

- [ ] **Step 4: Run the checks**

```bash
OSI_OS_REPO=<osi-os>/.worktrees/weather-data-view node scripts/verify-channel-manifest-sync.js
EDGE_CONTRACT_ROOT=<osi-os>/.worktrees/weather-data-view sh scripts/verify-edge-sync-contract-vendor.sh
sh scripts/verify-edge-sync-contract-vendor.test.sh
(cd frontend && npm run test:unit -- channels)
(cd backend && ./gradlew test --tests 'org.osi.server.channels.ChannelManifestTest' --tests 'org.osi.server.sync.SyncContractVendorTest')
node <osi-os>/.worktrees/weather-data-view/.claude/skills/anti-slop-writing/slop-check.js docs/channel-manifest.md
```
Expected: the manifest verifier reports all three copies equal at the new hash; `verify-edge-sync-contract-vendor: OK`; the vendor self-test passes; the frontend channel tests pass, the new registry test included (`npm run test:unit`, never a bare `npx vitest run`, never a build); Gradle `BUILD SUCCESSFUL` with both test classes green; `slop-check: PASS`.

- [ ] **Step 5: Commit (no push)**

```bash
git add frontend/src/channels/channels.json backend/src/main/resources/channels.json backend/src/test/java/org/osi/server/channels/ChannelManifestTest.java frontend/src/channels/__tests__/channels.parity.test.ts frontend/src/channels/registry.ts frontend/src/channels/__tests__/registry.test.ts scripts/verify-channel-manifest-sync.js docs/channel-manifest.md backend/src/test/resources/sync-contract/resources.schema.json
git -c user.name=Project-OSI commit -m "chore(contract): channel manifest and Zone contract copies for the edge weather data view; card channel lists skip unstored channels"
git log --oneline -2
```
Report the commit hash to the controller; the push waits for Phil.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Decisions: scope, source model, bucket statistic, partial sums, daily buckets, period unit, plot time, catalogue, new channels | 1, 2, 3 |
| Decisions: metric preset, CSV, GUI copy | 4 |
| Decisions: zone selector, round trip, capability, trigger ownership, contract | 5, 6, 7, 8 |
| Decisions: cloud (the same-named branch copies) | 10 |
| Source kinds; catalogue entries (dependencies, provider location, station hours, daily agronomy, bookkeeping, device entries, scope) | 3 (`DEVICE_EXCLUDED_CHANNELS` in 1) |
| Series resolution (grouping, SQL bounds, row mapping, points, `sum`, series response, time semantics) | 2, 3 |
| Channel manifest (`channels.json`, `CHANNELS`, `VALID_EXPORT_CHANNEL_KEYS`, `docs/channel-manifest.md` line 62, the export pin) | 1 |
| Card channel lists skip the three weather keys (plan review: edge and cloud `channels/registry.ts`) | 1, 10 |
| Analysis page (tray labels, preset, badge HelpTip, partial marker, symbols, CSV, types) | 4 |
| Zone provider selector (options, labels, unknown-value rule, GUI types, locales, Luganda row) | 8 (analysis keys of the row: 4) |
| Edge write path, zone list, size ratchet | 6 (ratchet also 5 and 7) |
| Snapshots and capability, `verify-sync-flow.js` pins, AGENTS.md | 6, 9 |
| Ownership and deploy order | 9 (AGENTS.md, contract README, execution report); nothing is deployed |
| Migration 0063 and the trigger artefacts (canonical source, generator, seed, seven DBs, checksums, owned-trigger lists unchanged, pins, runner and ledger tests, Terra fixture) | 5 |
| Cloud to edge command paths (legacy and protected, `test-zone-command-path.js`) | 7 |
| Contract change | 7, copied in 10 |
| Landing requirements | 10 |
| Verifiers and gates | per task; the full list in 9 |
| Error handling | 3 (catalogue and series cases), 6 and 7 (invalid values) |
| Testing | 1–8 as listed per task |
| Acceptance | 9 (unticked checklist in the execution report) |
