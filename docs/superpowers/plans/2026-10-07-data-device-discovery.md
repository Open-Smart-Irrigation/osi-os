# Data-view device discovery implementation plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans to execute this plan task by task after implementation is requested. Steps use checkboxes for tracking.

**Goal:** Make every authorized active device discoverable in Data view, and expose
LoRain's existing rainfall and temperature readings without changing stored data.

**Architecture:** Discover devices independently of history cards. A small static
helper describes supported channel families; the catalogue returns explicit device
sources and existing channel entries. The GUI groups by source identity and
supports unassigned sources and specialized destinations.

**Tech stack:** Node.js CommonJS helpers, Node-RED function nodes, SQLite, React,
TypeScript, SWR, Node test runner and Vitest.

**Spec:** [Data-view device discovery correction](../specs/2026-10-07-data-device-discovery-design.md).

Status: ready after all three committee reviewers cleared the revision.
Implementation has not started.
Review: [findings and dispositions](../reviews/2026-10-07-data-device-discovery-review.md).
Public base: `06e691e850384b1d5ecbacbe24439a257a70c983`.

## Global constraints

- Preserve scoped account-wide reads and flag-off owner-only reads. Disabled users
  are refused. Saved views stay per-user. Preserve admin-only diagnostic gates.
- Enumerate sources without depending on the latest measurement or a chosen range.
- Null means no data; zero is a valid observed value.
- No migrations, database writes, sensor commands, or live deployment in this plan's
  preparation/review phase. Implementation requires no schema change.
- No full history scan per catalogue request and no queries per channel.
- Keep assigned series IDs stable; rename must not affect source identity.
- Both maintained Pi profiles are byte-identical. New shipped helper files appear
  in deploy.sh and offline bundle coverage.
- Public artifacts use synthetic IDs. Private branch history stays private.
- Preserve #456's timestamp normalization and the current WATERMARK evidence and
  weather-provider source behavior; these postdate parts of the private branch.
- Scope is Data view plus the LoRain omission in legacy history/export. Do not
  redesign the dashboard or create a general device plugin registry.

## Review focus

1. Configuration-only newest rows, real zeros, stale devices, and no readings must
   not remove a source (tasks 1, 2 and 4).
2. Flag-off ownership, scoped account-wide reads, disabled accounts, and stale
   saved selectors must not diverge between catalogue and series (task 3).
3. Two identically named devices, rename, and assignment changes must have explicit
   identity behavior without changing existing assigned IDs (tasks 2 and 4).
4. LSN50 rain/flow without temperature, valve enclosure data, unsupported probe
   fields, and specialized radio records must not gain false channels (task 2).
5. Branch drift, missing deploy files, mixed timestamp formats, and empty buckets
   must be caught before delivery (tasks 5 and 6).

## File map

Paths below use `P = conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red`.
For each changed P file, change its bcm2709 mirror in the same commit.

| File | Responsibility |
|---|---|
| `P/osi-history-helper/device-sources.js` (new) | Pure device source/family policy and stable source identity |
| `P/osi-history-helper/device-sources.test.js` (new) | Type/configuration/source coverage matrix |
| `P/osi-history-helper/index.js`, `index.test.js` | LoRain legacy card eligibility, helper injection and evidence reuse |
| `P/osi-history-helper/analysis.js`, `analysis.test.js` | Device enumeration, channel metadata, catalogue, series reading and saved selectors |
| `P/osi-history-router/index.js` | Delegate the second environment predicate to the history helper |
| `scripts/verify-channel-manifest-parity.js`, `scripts/verify-channel-manifest-parity.test.js` (new) | Preserve CHANNELS parity and verify the separate device-health subset |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Authenticated analysis options and explicit sources response projection |
| `scripts/test-analysis-device-discovery.js` (new) | Real database plus extracted router regression harness |
| `scripts/test-scoped-access-reads.js` | Scoped/flag-off/read policy regression |
| `scripts/verify-history-api-contract.js`, `.test.js` | Catalogue/source response and guard propagation contract |
| `web/react-gui/src/analysis/types.ts` | Sources DTO and nullable zone membership |
| `web/react-gui/src/components/analysis/AnalysisSeriesTray.tsx` | Source-first grouping, unassigned and specialized rows |
| `web/react-gui/src/pages/CrossZoneAnalysisPage.tsx` | Pass catalogue sources into the mounted source tree |
| `web/react-gui/src/analysis/csv.ts` and its tests | Explicit unassigned label with and without catalogue metadata |
| `web/react-gui/src/analysis/correlation.ts`, `echartsOptions.ts` and their tests | Distinct correlation group identities and ambiguous-pair handling |
| `web/react-gui/src/components/analysis/CorrelationPanel.tsx` and its tests | Group keys, labels and suppression reasons |
| `web/react-gui/src/components/analysis/MetricAcrossZonesPicker.tsx` and its tests | Restrict across-zone selection to assigned sources |
| `web/react-gui/src/components/analysis/__tests__/AnalysisSeriesTray.test.tsx` | Tree/grouping interactions |
| `web/react-gui/src/analysis/__tests__/analysisApi.test.ts` | Response compatibility and nullable zone contract |
| `web/react-gui/public/locales/*/common.json` | Labels in every shipped language |
| `deploy.sh`, `.github/workflows/migrations.yml` | Ship helper and run the new tests in CI |
| `docs/channel-manifest.md`, `AGENTS.md` | Explain discovery and add coverage verification to onboarding |

The mounted page is CrossZoneAnalysisPage; analysis strings live in common.json.
Task 0 rechecks these paths if the execution base has moved.

## Task 0: Freeze the execution base and reproduce the omission

- [ ] Create an isolated implementation worktree from current `origin/main` using
  the worktree skill. Record the exact SHA. Compare this plan's touched surfaces
  with the pinned base; if interfaces changed, amend the plan before execution.
- [ ] Locate the mounted Data-view page and locale namespace:

```bash
rg -n 'AnalysisSeriesTray|useAnalysisCatalog' web/react-gui/src
rg -l '"analysis"' web/react-gui/public/locales/en/*.json
```

- [ ] Read AGENTS.md, engineering-playbook.md, the design, relevant schema, GUI and
  flow-editing skills. Record baseline results:

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js
node scripts/verify-history-api-contract.js
node --test scripts/test-scoped-access-reads.js
```

Planning baseline on the pinned public base: helper suites reported 65 passed,
0 failed, 1 skipped (the 399-day weather benchmark is opt-in via OSI_BENCH=1).
Scoped read tests passed 45/45 and the history API contract verifier passed. These
are baseline results, not proof of the correction. Re-run at execution time.

- [ ] Run this minimal regression probe. It currently prints an empty array:

```js
const h = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper');
console.log(h.deriveCardsForZone({ id: 1, zone_uuid: 'test-zone' }, [{
  deveui: '0011223344556677', name: 'Rain', type_id: 'AQUASCOPE_LORAIN',
  irrigation_zone_id: 1,
}]));
```

## Task 1: Repair LoRain history eligibility with a real catalogue regression

Files: `P/osi-history-helper/index.js`, `index.test.js`, `analysis.test.js`,
`P/osi-history-router/index.js`, mirrors, and scripts/test-history-all-zones-export.js.

Interfaces: preserve `deriveCardsForZone(zone, devices)` and existing card/source
IDs. This task produces an environment card for a configuration-only LoRain row.

- [ ] Add a failing helper test:

```js
test('LoRain configuration alone creates a history source', () => {
  const cards = hh.deriveCardsForZone({ id: 1, zone_uuid: 'test-zone' }, [{
    deveui: '0011223344556677', name: 'Rain', type_id: 'AQUASCOPE_LORAIN',
    irrigation_zone_id: 1,
  }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].cardType, 'environment');
  assert.equal(cards[0].sourceDevices[0].typeId, 'AQUASCOPE_LORAIN');
});
```

- [ ] Extend the seeded SQLite analysis fixture with the same device, an earlier
  row at `2026-10-01T10:00:00Z` containing temperature 25.2, voltage 2.9,
  rain_tips_delta 12, rain_mm_delta 6, rain_mm_today 6, and a newer row at
  `2026-10-01T10:05:00Z` with all measurements null. Assert the catalogue still
  contains Rain and the raw series returns 6, not zero or no source.
- [ ] Run the helper suites and confirm failure is the missing LoRain source.
- [ ] Add `AQUASCOPE_LORAIN` to the helper environment predicate. Make the separate
  router predicate delegate to `historyHelper.isEnvironmentSource` (export the
  existing helper function through module.exports), preserving
  every other classification. Add a direct router/card-data and all-zone CSV
  regression; a helper-only test cannot catch the duplicate filter.
- [ ] Add raw/hourly/daily LoRain export fixtures [0, 1.5, 6] with a newer null row.
  Raw retains all three; aggregated delta is 7.5, not 2.5. In csvRowsFromAggregate
  select sum for LoRain interval mm/tips, latest for today mm, mean for rates/temp.
  Use device type to limit this legacy change to LoRain. Leave generic stats.mean
  intact and preserve other devices' legacy CSV values.
- [ ] Keep LoRain aggregate CSV on range-bounded device_data (explicit
  useRollups:false at its aggregate call), and prove the same totals with stored
  rollups present. The rollup schema has no sum; do not invent one, multiply means
  as a workaround, or migrate the schema. Test nightly generated CSV as well as
  HTTP export, router eligibility and stored-rollup history card discovery.
- [ ] Run the tests and verify existing assigned IDs.
- [ ] Commit: `fix(history): recognize LoRain without latest-data enrichment`.

## Task 2: Make device discovery independent of history-card classification

Create `device-sources.js` and its test. Modify analysis.js and helper injection.

Interfaces:

```ts
type Family = 'soil' | 'environment' | 'dendro' | 'device_health';
type DeviceSource = {
  id: string;
  hubEui: string | null;
  zoneId: number | null;
  zoneName: string | null;
  name: string;
  typeId: string;
  channelIds: string[];
  presentation: 'timeseries' | 'specialized' | 'unsupported';
  destination: 'network' | null;
  limitation: 'valve_events' | 'unsupported_type' | null;
};
// CommonJS exports; uses declared channel keys, never SQL supplied by callers.
function deviceSourceId(device): string;
function describeDeviceSource(device): {
  families: Array<{ cardType: Family, channelKeys: string[] }>;
  currentChannelKeys: string[]; // Other declared keys remain historical candidates.
  presentation: DeviceSource['presentation'];
  destination: DeviceSource['destination'];
  limitation: DeviceSource['limitation'];
};
```

- [ ] Write a table-driven source coverage test with every device type in
  `DeviceType` and the seed CHECK. Each must produce a source identity and either
  declared channels or an explicit specialized destination. Compare against both
  catalogues so a newly added type fails the test rather than disappearing.
- [ ] For LoRain, assert the exact channel set:

```js
const expected = [
  'ambient_temperature', 'rain_tips_delta', 'rain_mm_delta', 'rain_mm_today',
  'rain_mm_per_hour', 'rain_mm_per_10min', 'bat_v',
].sort();
assert.deepEqual(lorain.families.flatMap(f => f.channelKeys).sort(), expected);
```

- [ ] Add configuration tests for LSN50 rain/flow with temp_enabled=0, Chameleon,
  WATERMARK, configured SDI12 layouts, and both STREGA generations. Valve enclosure
  channels are device health; Clover has no VWC. UC512 pressure/pulses/battery are
  numeric channels; textual valve states get no numeric encoding.
- [ ] Add identity tests for duplicate names, rename, lower-case DevEUI, and
  configuration-only/no-reading devices. Existing source and series IDs are golden
  fixtures. Emit configurationState=current or other_supported per channel.
- [ ] Preserve old selectors after each LSN50 flag turns off and SDI12 layouts
  shrink: the type policy declares a finite union of supported stored keys,
  independent of current enablement. Other-supported channels remain selectable
  under a collapsed section with a no-data-checked explanation. Use null depth for
  removed layout keys and qualify remaining depths as current layout. Do not
  relabel historical physical depths as known. Test reader evidence gating,
  especially SWT3, rather than interpreting a declared key as a valid reading.
- [ ] Join valve_settings once per device enumeration query, both zone-assigned
  and unassigned (LEFT JOIN, default GEN1) for STREGA generation. GEN2 enclosure keys are other_supported and still
  read earlier GEN1 samples. No latest-uplink heuristic or historical scan.
- [ ] Implement the source identity exactly:

```js
function deviceSourceId(device) {
  const eui = String(device.deveui || '').trim().toUpperCase();
  return 'device-' + crypto.createHash('sha256').update(eui).digest('hex').slice(0, 12);
}
```

Reject an empty EUI before emitting a source. Apply existing display-name sanitizing
and normalization helpers. Keep family source keys unchanged for assigned sources.

- [ ] Replace the device-path `deriveCardsForZone` loop in buildAnalysisCatalog
  with `describeDeviceSource`. Add each source before its channel loop, including
  specialized/unsupported sources. Keep the weather/provider path unchanged.
  Return `{ generatedAt, sources, channels, entriesById, weatherAvailable }`.
- [ ] Add `deviceSourceId` to device channel metadata AND resolved series; provider
  channels use null. Keep existing IDs. Add configurationState to channel metadata.
- [ ] Keep the manifest-derived CHANNELS array and its current parity assertion.
  Add a separately verified DEVICE_HEALTH_CHANNELS array: bat_v (V, mean), bat_pct
  (%, mean), valve_1_pulse and valve_2_pulse (count, latest). Verify each against its
  channels.json gateway entry; the exact four-key allowlist prevents accidental
  publication of other diagnostics. Union both sets into channelMeta and
  ANALYSIS_EDGE_FIELDS/sqlIdent. flow_pulses_delta already exists in CHANNELS.
- [ ] Keep global manifest exportable flags and legacy export allowlists unchanged.
  Device-health CSV is allowed only through Data-view export. STREGA enclosure
  keys reuse canonical ambient_temperature/relative_humidity metadata with a
  device_health source-family override. Do not duplicate channel keys.
- [ ] Add metadata coverage and catalogue bijection tests: every declared key has
  metadata and an allowed persisted field; each source.channelIds ID maps to one
  emitted device channel with its deviceSourceId; no device channel is orphaned.
- [ ] Restrict LoRain channel selection to its declared keys. For supported types,
  do not fall back to every environment channel. Reuse existing soil layout and
  WATERMARK evidence helpers, including recordedAtRangeSql.
- [ ] Ship device-sources.js through deploy.sh and mirror the helper/test files.
  Run helper, channel-parity and deploy-file coverage gates. Commit:
  `feat(analysis): discover device sources independently of history cards`.

## Task 3: Include unassigned devices under the existing read policy

Files: analysis.js, analysis-api-router-fn in both flows, scoped read tests and
new `scripts/test-analysis-device-discovery.js`.

Interface: all catalogue/series/view resolver options gain server-derived
`unassignedAccess: 'none' | 'owner' | 'account'`, default `none`.

- [ ] Add failing extracted-router/database tests covering this matrix:

| Mode and actor | Assigned data | Unassigned data | Saved views |
|---|---|---|---|
| Flag off, enabled user | Existing owner-only behavior | Devices owned by that user | That user's only |
| Scoped, enabled viewer/researcher/admin | Account-wide, as today | All claimed devices (user_id IS NOT NULL) | That user's only |
| Disabled scoped account | 403 | 403 | 403 |
| Missing/invalid bearer | 401 | 401 | 401 |
| Helper called with empty zoneUuids and default options | None | None | No hidden widening |

- [ ] Add an account with zero zones and an unassigned gauge. Verify the gauge
  appears and its series resolves. Exercise POST series with a foreign flag-off
  selector, a deleted device, and a formerly valid selector after reassignment.
  Query/body `unassignedAccess=account` must have no effect. Add an unclaimed
  unassigned row (user_id null): neither sources nor series may expose it. Keep a
  cloud-assigned/no-owner device in a readable live zone visible, matching today's
  account-wide read contract. These cases must also survive the private port.
- [ ] Use existing extracted-flow harness and real SQLite seed. Do not mock away
  authentication, deriveCardsForZone, source enumeration, or series resolution.
- [ ] Implement the unassigned query once per catalogue request:

```sql
SELECT * FROM devices
WHERE deleted_at IS NULL AND irrigation_zone_id IS NULL
  AND user_id = ?
ORDER BY deveui ASC
```

For authenticated account-wide reads replace it with `user_id IS NOT NULL`; for
`none` skip the query. Reject unknown access enum values. Do not turn a dangling/deleted
zone reference into unassigned ownership.

- [ ] Emit null zoneId/zoneName, UTC timezone for unassigned time-series bucketing,
  and `analysisSeriesId('unassigned', cardType, sourceKey, channelKey)` for new IDs.
  Preserve numeric-zone hashes for existing assigned series. No fake zone record.
- [ ] Pass the option from the router on all catalogue/series/view-list paths.
  The router chooses it after bearer/account validation. Keep auth code and
  write authorization unchanged, and keep db.close in finally.
- [ ] Update GET /api/analysis/channels' explicit response projection to include
  sources alongside generatedAt/channels. Add an extracted-router response test
  and extend verify-history-api-contract; helper-return tests alone are insufficient.
  Assert no entriesById/internal context leaks into the response.
- [ ] Verify stale saved selectors return the existing dropped indication without
  deleting stored views, relabeling historical data, or exposing another owner.
- [ ] Run the router regression and scoped gates. Commit:
  `fix(analysis): include authorized devices without zone assignments`.

## Task 4: Render source identity and unassigned groups in Data view

Files: analysis/types.ts, mounted Analysis page, AnalysisSeriesTray.tsx, csv.ts,
related tests and every locale's analysis strings.

Interfaces: `AnalysisCatalogResponse.sources?: DeviceSource[]`;
`AnalysisCatalogEntry.deviceSourceId?: string | null` and matching AnalysisResolved field;
`AnalysisCatalogEntry.configurationState?: 'current' | 'other_supported'`;
`AnalysisCatalogEntry.zoneId` and `AnalysisResolved.zoneId` become number|null;
zoneName becomes string|null wherever the catalogue can return it.

- [ ] Add failing UI tests for a LoRain source, two gauges with the same name,
  unassigned sources, a RAK source with zero chart channels, network module off,
  and an old backend response without sources. Confirm the actual Data page passes
  sources to the tree; a component-only test does not prove reachability.
- [ ] Build the tree from sources, attach channels by deviceSourceId, then retain
  non-device weather groups. For old responses derive groups from existing channel
  sourceKey/cardType rather than names. Render translated “Unassigned devices”.
- [ ] Keep the source visible with an empty-state explanation if it has no chart
  channels. CrossZoneAnalysisPage calls useGatewayModules and passes its nullable
  flags to the tray. RAK offers `/network` only if modules?.network === true,
  exactly as FieldTesterCard does. Test enabled, disabled, loading and hook-error
  fallback. Never read raw radio records or device_data to decide RAK visibility.
  Existing Network API device-read and admin raw-download guards remain intact.
- [ ] Limit destination to network|null; no speculative irrigation deep link.
  STREGA/UC512 display the translated valve_events limitation beside their numeric
  channels. Unknown types display unsupported_type. Add tests for null destination.
  Other-supported channels are selectable under a collapsed, translated section;
  current configuration is not evidence of recorded samples.
- [ ] Update CSV so null zone membership is an explicit unassigned label, not
  `null`, `0`, or a made-up zone. Use the stable CSV value `Unassigned devices`
  whenever resolved.zoneId is null, even if catalogById has no entry. Assigned
  missing-entry rows retain the numeric zone fallback. Test both catalogue cases,
  null samples and the raw LoRain 6 mm value. UI labels remain translated.
- [ ] Update correlation.ts groupByZone/ZonePairs/CorrelationGroup, chart series
  identities in echartsOptions, and CorrelationPanel React keys to use groupId.
  Assigned groupId=zone:<id>; unassigned=device:<deviceSourceId>; pooled=pooled.
  Keep assigned cross-device X/Y pairing only if exactly one candidate per axis
  exists. Multiple candidates suppress the group with an ambiguity explanation;
  never pick the last series. Unassigned pairing requires the same deviceSourceId.
  Null zone is never a pooled key. Pool only valid, unambiguous pairs.
- [ ] Test two same-name unassigned devices with identical channel keys, separate
  device series sharing null zone, ambiguous assigned pairs, existing unambiguous
  cross-device assigned pairs, and pooled output. Older assigned responses use
  existing zone behavior; unassigned responses missing deviceSourceId are suppressed
  explicitly. The metric-across-zones picker excludes null-zone entries; timeline
  and source-tree selection still support them.
- [ ] Test save/reload and timeline for unassigned channels. Confirm rename
  preserves selection and assignment changes surface a dropped selector.
- [ ] Add all translated keys and execute GUI typecheck, both unit-test runners,
  and build. Commit: `feat(gui): show all discovered data sources`.

## Task 5: Verify measurement values, deployment and coverage in CI

Files: analysis.js and tests, new router discovery test, CI workflow, docs.

- [ ] Add real SQLite fixtures for rain deltas [0, 1.5, 6], a configuration-only
  row, a stale gauge, and mixed SQLite/ISO/offset timestamps. Raw values must be
  [0, 1.5, 6] at their normalized times; an hourly bucket covering them is 7.5 mm.
  An empty bucket is null. Rates/temperatures/voltage use means; cumulative and
  daily-running totals must not be summed.
- [ ] For the Data-view device reader pass channel-specific statistic metadata to
  aggToPoints: sum for rain_mm_delta/rain_tips_delta/flow_liters_delta and pulse
  deltas, mean for instantaneous measurements, last observation for counters.
  Add the explicit latest branch to aggToPoints (currently only sum vs mean).
  Test counters at out-of-order/mixed-format timestamps and day resets; choose the
  final finite observation, never a maximum or sum. Preserve weather-source
  aggregation and legacy history statistic meanings; Task 1 separately selects the
  correct statistic for LoRain legacy CSV.
- [ ] Add a catalogue query-count assertion: increasing declared channel count
  must not increase database calls. Guard against reads of all device_data history.
- [ ] Add the new tests to CI and add the source-coverage check to the onboarding
  checklist. Register only files that are shipped; new internal modules must pass
  verify-module-file-deploy-coverage. The offline bundle is generated from
  deploy.sh's fetch list, so no separate manifest edit is required. No npm
  dependency or schema addition.
- [ ] Run these gates from the repo root, capturing each exit code:

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/device-sources.test.js
node --test scripts/test-analysis-device-discovery.js scripts/test-scoped-access-reads.js scripts/test-history-recorded-at-formats.js scripts/test-history-all-zones-export.js
node scripts/verify-history-api-contract.js
node --test scripts/verify-history-api-contract.test.js
node scripts/verify-channel-manifest-parity.js
node --test scripts/verify-channel-manifest-parity.test.js
node scripts/verify-module-file-deploy-coverage.js
node scripts/verify-profile-parity.js
node scripts/verify-scoped-access.js
node scripts/verify-no-new-silent-catch.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-sync-flow.js
```

Run `npm run typecheck`, `npm run test:unit`, `npm run build` in web/react-gui.
Run `git diff --check` and the prose checker on changed docs. Pin stack-base
variables only when the branch actually uses a different reviewed base.

- [ ] Use the browser skill to check the mounted Data view at desktop and mobile
  sizes, two same-name devices, search, selecting rain, source-only rows, saved
  views and CSV. Verify real zero and unavailable states separately.
- [ ] Commit: `test(analysis): enforce device discovery and rain value contracts`.

## Task 6: Private-branch adaptation and independent verification

- [ ] Freeze the private branch base and active payload fingerprints before porting.
  Deployed helpers can contain fixes beyond that branch tip. Compare the exact
  deployed helper functions with the proposed target before preparing a deploy.
- [ ] Apply the generic fix in a separate private worktree. Preserve its scoped
  access policy, branding, existing WATERMARK changes and timestamps. Do not copy
  public main's unrelated weather/schema stack into the private branch.
- [ ] Run the same relevant gates there. When a named public test is absent, port
  the targeted regression with the implementation; do not silently omit it.
  Omit only features absent from that branch's device catalogue, with an explicit
  coverage matrix proving every device it does support is still covered.
- [ ] Have a fresh verifier re-run tests and inspect the complete catalogue ->
  selection -> series -> CSV/saved-view path. Review the diff against this plan.
- [ ] Prepare a deploy bundle and rollback description only after implementation
  verification. A live deployment is a separate user-authorized operation.
- [ ] After authorized deployment, inspect the affected account: Rain must appear,
  the historical 6 mm point must be selectable/exportable, and unassigned sources
  must appear. Record actual hashes and observations; do not claim these checks
  from unit tests. No sensor downlinks or database repair are needed.

## Completion evidence

The implementation report records each task's test failure before the fix and
pass afterward, the source-coverage matrix, source/series ID compatibility,
negative read-policy cases, browser evidence, profile parity, and each branch's
base and final SHA. Required committee findings must be resolved before execution.
