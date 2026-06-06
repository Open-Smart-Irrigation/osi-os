# History Loading And Label Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure and reduce OSI OS fullscreen history loading time, then fix the current mobile history label/title, soil series depth labels, and calendar month visibility issues.

**Architecture:** Edge-only. Measure first, then make small targeted changes in the Node-RED History API Router, `osi-history-helper`, and the React history detail UI. Keep the thematic card model intact: the card is still Soil, Dendro, Environment, Irrigation, or Gateway, but farmer-facing display text becomes cleaner and less crowded.

**Tech Stack:** Node-RED function code in `flows.json`, SQLite on the Pi, `osi-history-helper`, Vite + React 18 + TypeScript, SWR, Recharts, Vitest + Testing Library, `tsx --test`.

---

## Root-Cause Summary

### Performance

Current live kaba100 evidence:

- Zone B card summary API via local Node-RED: about 0.88 s.
- Zone B 24h soil line data via local Node-RED: about 0.95 s.
- Zone B 7D soil line data via local Node-RED: about 1.07 s.
- The raw indexed SQLite 7D two-device `device_data` query: about 0.01-0.02 s.
- `getLatestChameleonRows` current join shape: about 1.10 s.
- Per-device latest Chameleon query using `idx_chameleon_readings_deveui_time`: about 0.01 s.

Root issue: the main delay is not the raw history range scan. The Chameleon latest-row lookup is a strong candidate bottleneck, but the direct-query number and the full-request number were captured under different conditions, so they are not sufficient attribution by themselves. Phase timing must be added before rewriting the query so the plan can prove whether latest-row lookup, schema guard, context lookup, aggregation, response build, network, or frontend duplicate requests dominate the warm-cache path.

### Label Overlap And Title

Current code:

- `HistoryDetailHeader` renders `zoneName` as an eyebrow at [HistoryDetailHeader.tsx](/home/phil/Repos/osi-os/web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx:44).
- `HistoryCardDetailPage` renders a top-left absolute view pill at [HistoryCardDetailPage.tsx](/home/phil/Repos/osi-os/web/react-gui/src/pages/HistoryCardDetailPage.tsx:676).
- The backend card summary still returns `"Soil - Root Zone"` from the History API Router card config.

Root issue: zone context and view context are competing for the same top-left visual area. The farmer-facing card title also uses the older taxonomy label.

Target behavior:

- Header title reads `Soil Moisture Zone B` for Zone B soil history.
- Base soil card title is `Soil Moisture`, not `Soil - Root Zone`.
- Zone-scoped detail titles include the zone name for every thematic card, not only Soil. Examples: `Soil Moisture Zone B`, `Environment Zone A`. Gateway cards have no zone name and keep their base title.
- The small view pill remains only for view/range context, not zone identity.

### Soil Line Series Labels

Current code:

- `SoilLineChartView` labels lines from `series.label` or `swt_1`/`swt_2`/`swt_3` fallback at [SoilLineChartView.tsx](/home/phil/Repos/osi-os/web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx:83).
- `HistoryCardDataResponse.profiles` already carries `depthCm` at [types.ts](/home/phil/Repos/osi-os/web/react-gui/src/history/types.ts:235).
- Backend `buildSoilProfiles` derives depth from the selected source device at [flows.json History API Router](/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json).

Root issue: the line chart ignores the existing profile depth metadata, so the tooltip/series name falls back to generic `Soil 1`, `Soil 2`, `Soil 3`.

Target behavior:

- Use depth labels when available: `5 cm`, `10 cm`, `30 cm`.
- If no depth exists, use `Sensor 1`, `Sensor 2`, `Sensor 3`.
- Do not expose DevEUI, `swt_1`, or raw channel IDs in the normal line chart.

### Calendar Month Visibility

Current code:

- `HistoryMonthCalendarView` computes a month label and renders it inside the calendar section at [HistoryMonthCalendarView.tsx](/home/phil/Repos/osi-os/web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx:208).
- The fullscreen top-left pill shows only `Calendar` for calendar view because range text is suppressed at [HistoryCardDetailPage.tsx](/home/phil/Repos/osi-os/web/react-gui/src/pages/HistoryCardDetailPage.tsx:681).

Root issue: the month is present in component code, but the always-visible fullscreen context pill does not include it, and the in-grid month label can be visually lost in the compact fullscreen layout. This is a display architecture issue, not a calendar API issue unless measurement proves the API returns the wrong date set.

Target behavior:

- Calendar view shows the active month in the persistent top-left context pill, for example `Calendar - June 2026`.
- The calendar grid still renders an accessible month heading.
- Month label derives from the same helper in both places to avoid drift.

## Quality Constraints

- Keep changes small and independently reviewable.
- Prefer direct fixes over new abstractions. Add a helper only when two call sites need the same formatting rule.
- Keep farmer-facing UI free of raw DevEUI/channel IDs outside Advanced View.
- Do not replace `/data/db/farming.db` on live Pis.
- If editing `conf/full_raspberrypi_bcm27xx_bcm2712/files/`, mirror the same runtime payload to bcm2709 and run profile parity verification.
- Do not edit `conf/full_raspberrypi_bcm27xx_bcm2708/files/` for this plan. That profile exists in the tree, but AGENTS.md and `scripts/verify-profile-parity.js` define `bcm2712` as canonical and `bcm2709` as the maintained mirror for current Pi images.
- Slices that edit `flows.json` must execute sequentially and pass review before the next `flows.json` slice starts.
- Ask for review after every slice. If review finds blockers, fix them and request review again before starting the next slice.

## Slice 1 - Measurement Harness, Phase Timing, And Baseline

**Purpose:** Create repeatable timing evidence and per-phase attribution before changing performance code.

**Files:**

- Create: `scripts/measure-history-api-performance.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `docs/ux/history-data-visualization-kaba100-issues.md`

- [ ] **Step 1: Create the measurement script.**

Create `scripts/measure-history-api-performance.js`:

```js
#!/usr/bin/env node
'use strict';

const { performance } = require('node:perf_hooks');

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

function envNumber(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive number`);
    process.exit(2);
  }
  return parsed;
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function makeUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function requestJson(url, token) {
  const startedAt = performance.now();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  const durationMs = performance.now() - startedAt;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    url: String(url),
    status: response.status,
    durationMs,
    bytes: Buffer.byteLength(text),
    json,
  };
}

function summarize(samples) {
  const sorted = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] || 0;
  return {
    count: samples.length,
    minMs: Math.round(sorted[0] || 0),
    p50Ms: Math.round(pick(0.5)),
    p95Ms: Math.round(pick(0.95)),
    maxMs: Math.round(sorted[sorted.length - 1] || 0),
    bytes: samples[0] ? samples[0].bytes : 0,
    status: samples[0] ? samples[0].status : 0,
  };
}

async function measureEndpoint(name, url, token, repeats) {
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    samples.push(await requestJson(url, token));
  }
  return { name, ...summarize(samples), samples };
}

async function main() {
  const baseUrl = requiredEnv('OSI_HISTORY_BASE_URL');
  const token = requiredEnv('OSI_HISTORY_TOKEN');
  const zoneId = requiredEnv('OSI_HISTORY_ZONE_ID');
  const repeats = envNumber('OSI_HISTORY_REPEATS', 5);
  const timezone = process.env.OSI_HISTORY_TIMEZONE || 'Europe/Zurich';

  const cards = await requestJson(makeUrl(baseUrl, `/api/history/zones/${zoneId}/cards`), token);
  if (cards.status !== 200 || !cards.json || !Array.isArray(cards.json.cards)) {
    console.error(JSON.stringify({ error: 'cards request failed', status: cards.status, body: cards.json }, null, 2));
    process.exit(1);
  }

  const soilCard = cards.json.cards.find((card) => card.cardType === 'soil');
  if (!soilCard) {
    console.error('No soil card found');
    process.exit(1);
  }

  const cardId = encodeURIComponent(soilCard.cardId);
  const now = new Date().toISOString();
  const endpoints = [
    {
      name: 'zone-cards',
      url: makeUrl(baseUrl, `/api/history/zones/${zoneId}/cards`),
    },
    {
      name: 'soil-profile-24h',
      url: makeUrl(baseUrl, `/api/history/zones/${zoneId}/cards/${cardId}/data`, {
        view: 'soil-profile',
        range: '24h',
        timezone,
        aggregation: 'auto',
        from: isoHoursAgo(24),
        to: now,
      }),
    },
    {
      name: 'soil-line-24h',
      url: makeUrl(baseUrl, `/api/history/zones/${zoneId}/cards/${cardId}/data`, {
        view: 'line-chart',
        range: '24h',
        timezone,
        aggregation: 'auto',
        from: isoHoursAgo(24),
        to: now,
      }),
    },
    {
      name: 'soil-line-7d',
      url: makeUrl(baseUrl, `/api/history/zones/${zoneId}/cards/${cardId}/data`, {
        view: 'line-chart',
        range: '7d',
        timezone,
        aggregation: 'auto',
        from: isoHoursAgo(24 * 7),
        to: now,
      }),
    },
    {
      name: 'soil-calendar-30d',
      url: makeUrl(baseUrl, `/api/history/zones/${zoneId}/cards/${cardId}/data`, {
        view: 'calendar',
        range: '30d',
        timezone,
        aggregation: 'auto',
        from: isoHoursAgo(24 * 30),
        to: now,
      }),
    },
  ];

  const results = [];
  for (const endpoint of endpoints) {
    results.push(await measureEndpoint(endpoint.name, endpoint.url, token, repeats));
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseUrl,
    zoneId,
    soilCardId: soilCard.cardId,
    repeats,
    results: results.map(({ samples, ...summary }) => summary),
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
```

- [ ] **Step 2: Run script help-failure check.**

Run:

```bash
node scripts/measure-history-api-performance.js
```

Expected: exits `2` and prints `OSI_HISTORY_BASE_URL is required`.

- [ ] **Step 3: Add phase timing before any query rewrite.**

Target the Node-RED function node by ID, not broad text search:

```bash
jq -r '.[] | select(.id=="history-api-router-fn") | .name, .type' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
```

Expected:

```text
History API Router
function
```

In the `history-api-router-fn` function body in both maintained profiles, add phase timing around:

- auth token verification
- DB open
- schema guard
- zone/gateway context lookup
- latest device rows
- latest Chameleon rows
- aggregation
- response payload build
- response close/log

The existing `[history-api]` log should become:

```js
node.log('[history-api] ' + logLabel
  + ' aggregation=' + logAggregation
  + ' source=' + logSource
  + ' durationMs=' + String(durationMs)
  + ' phaseMs=' + phaseSummary(historyPhases));
```

Use a small local helper in the router function:

```js
const historyPhases = {};
function markPhase(name, startedAt) {
  historyPhases[name] = Date.now() - startedAt;
}
function phaseSummary(phases) {
  return Object.keys(phases).sort().map(function(key) {
    return key + ':' + String(phases[key]);
  }).join(',');
}
```

Do not add per-row logs. Keep the phase names stable because later slices use them for before/after comparison.

- [ ] **Step 4: Add a phase-timing verifier.**

In `scripts/verify-sync-flow.js`, extract only node `history-api-router-fn` and assert the function body contains:

```js
phaseMs=
markPhase(
phaseSummary(
```

Expected failure before implementation: `History API Router phase timing missing`.

- [ ] **Step 5: Verify profile parity and router checks.**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: PASS, including profile parity.

- [ ] **Step 6: Run live kaba100 baseline.**

Use a valid local token from the Pi. Example:

```bash
# Kaba100-specific token minting. Do not copy the hardcoded userId/username
# to other Pis without first checking their local users table.
TOKEN="$(SSH_AUTH_SOCK=/home/phil/.ssh/agent/s.dUaIkoc630.agent.Cs3Bf1Nutw ssh root@100.93.68.86 'node -e '\''const fs=require("fs"),crypto=require("crypto"); const secret=fs.readFileSync("/data/db/osi_auth_token_secret","utf8").trim(); function b64(x){return Buffer.from(x).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");} const now=Date.now(); const p=b64(JSON.stringify({userId:2,username:"admin",iat:now,exp:now+3600000})); const sig=b64(crypto.createHmac("sha256",secret).update(p).digest()); console.log(p+"."+sig);'\''')"
OSI_HISTORY_BASE_URL=http://100.93.68.86:1880 \
OSI_HISTORY_TOKEN="$TOKEN" \
OSI_HISTORY_ZONE_ID=12 \
OSI_HISTORY_REPEATS=5 \
node scripts/measure-history-api-performance.js | tee /tmp/osi-history-baseline.json
```

Expected: JSON with `zone-cards`, `soil-profile-24h`, `soil-line-24h`, `soil-line-7d`, and `soil-calendar-30d`.

- [ ] **Step 7: Capture the matching phase logs.**

Run:

```bash
SSH_AUTH_SOCK=/home/phil/.ssh/agent/s.dUaIkoc630.agent.Cs3Bf1Nutw ssh root@100.93.68.86 \
  'logread | grep "\\[history-api\\]" | tail -n 20'
```

Expected: each history line includes `phaseMs=` and enough detail to identify whether latest-row lookup is actually a dominant phase.

- [ ] **Step 8: Add the baseline numbers to the issue document.**

Append the script output summary to `docs/ux/history-data-visualization-kaba100-issues.md` under the 2026-06-07 section.

- [ ] **Step 9: Commit.**

```bash
git add scripts/measure-history-api-performance.js \
  scripts/verify-sync-flow.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "chore(history): add API loading measurement harness"
```

Review gate: request review of the baseline and phase timing. Do not start Slice 2 unless the latest-row phase is a meaningful contributor or the reviewer explicitly accepts the query rewrite as a low-risk cleanup.

## Slice 2 - Backend Latest-Row Query Fix

**Purpose:** Remove the confirmed or phase-timing-supported slow Chameleon latest-row query from soil card summaries and data responses.

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Test: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add a failing verification assertion.**

Extend the History API Router verification in `scripts/verify-sync-flow.js` by extracting only the function node with ID `history-api-router-fn`. Assert that the `getLatestChameleonRows` function in that node no longer contains:

```js
JOIN (SELECT deveui, MAX(id) AS max_id FROM chameleon_readings
```

Expected failure before implementation: `History API Router still uses MAX(id) chameleon latest-row lookup`.

- [ ] **Step 2: Rewrite `getLatestChameleonRows`.**

In both profile `flows.json` files, replace the current single join query with per-device indexed latest reads:

```js
async function getLatestChameleonRows(q, deveuis) {
  const ids = uniqueDeveuis(deveuis);
  const rows = [];
  for (const deveui of ids) {
    const latest = await q(
      'SELECT * FROM chameleon_readings WHERE deveui = ? ORDER BY recorded_at DESC, id DESC LIMIT 1',
      [deveui]
    );
    if (latest[0]) rows.push(latest[0]);
  }
  rows.sort(function(left, right) {
    return String(left.deveui || '').localeCompare(String(right.deveui || ''));
  });
  return rows;
}
```

Reason: live kaba100 proved this query shape uses `idx_chameleon_readings_deveui_time` and drops from about 1.10 s to about 0.01 s for Zone B direct SQL. `ORDER BY recorded_at DESC, id DESC` preserves deterministic behavior if two rows share the same timestamp and makes the semantic shift from "highest rowid" to "latest recorded time" explicit. The loop performs one indexed query per DevEUI; this is acceptable for current soil cards with one or two source devices, but this function must not be reused for large many-device paths without batching or parallelization.

- [ ] **Step 3: Verify profile parity and router checks.**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: PASS, including profile parity.

- [ ] **Step 4: Re-run live timing.**

Run the Slice 1 measurement command and compare `zone-cards`, `soil-profile-24h`, and `soil-line-24h` against baseline.

Expected: the phase timing shows the Chameleon latest-row phase drops materially. End-to-end p50 should improve if that phase was dominant. If the latest-row phase was not dominant, keep the change only if review accepts it as low-risk cleanup; otherwise revert the slice and move to the next measured bottleneck.

- [ ] **Step 5: Commit.**

```bash
git add scripts/verify-sync-flow.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix(history): speed up chameleon latest-row lookup"
```

Review gate: request review of the query plan and timing delta.

## Slice 3 - Helper Query And Request De-Duplication

**Purpose:** Remove avoidable backend sorting and frontend duplicate refetches.

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`
- Modify: `scripts/test-history-helper.js`
- Modify: `web/react-gui/src/history/useHistoryCardData.ts`
- Modify: `web/react-gui/src/history/useHistoryCardAdvancedData.ts`
- Test: `web/react-gui/src/components/history/__tests__/useHistoryCardData.test.tsx`

- [ ] **Step 1: Add helper SQL expectation.**

In `scripts/test-history-helper.js`, add an assertion around `aggregateDeviceData` that the raw device query orders by `deveui ASC, recorded_at ASC` or has no `ORDER BY recorded_at ASC` alone.

Expected failure: current SQL contains `ORDER BY recorded_at ASC`.

- [ ] **Step 2: Verify the composite index precondition.**

Run:

```bash
node scripts/verify-db-schema-consistency.js
```

Expected: PASS, including `idx_device_data_deveui_recorded_at`. Do not proceed with the SQL ordering change if this index is missing from bundled DBs or repair scripts.

- [ ] **Step 3: Change raw device data SQL.**

In both helper files, change:

```js
ORDER BY recorded_at ASC
```

to:

```js
ORDER BY deveui ASC, recorded_at ASC
```

Reason: live `EXPLAIN QUERY PLAN` showed `ORDER BY recorded_at ASC` creates a temporary B-tree for multi-DevEUI cards, while `ORDER BY deveui ASC, recorded_at ASC` keeps the composite index plan. The helper still sorts rows by timestamp before rendering.

- [ ] **Step 4: Canonicalize SWR history data keys.**

In `useHistoryCardData.ts`, add a small local helper:

```ts
function canonicalIsoMinute(value: string | null | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}
```

Use it for `range.from` and `range.to` inside `getHistoryCardDataKey`. Keep the request body unchanged so the backend still receives the exact viewport when the user pinches or pans.

- [ ] **Step 5: Add SWR de-duplication options.**

`web/react-gui/package.json` uses `swr` `^2.3.7`, and `keepPreviousData` is already present in `useHistoryCardData.ts`. Keep it and add the options that reduce duplicate local refreshes:

```ts
{
  keepPreviousData: true,
  revalidateOnFocus: false,
  dedupingInterval: 1_500,
}
```

Apply the same `revalidateOnFocus: false` and `dedupingInterval: 1_500` pattern to `useHistoryCardAdvancedData.ts`.

- [ ] **Step 6: Add tests for key stability.**

In `useHistoryCardData.test.tsx`, add a test that rerenders with `range.from` and `range.to` differing only by seconds within the same minute and expects a single API fetch.

- [ ] **Step 7: Verify.**

Run:

```bash
node scripts/test-history-helper.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit
```

Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git add scripts/test-history-helper.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js \
  web/react-gui/src/history/useHistoryCardData.ts \
  web/react-gui/src/history/useHistoryCardAdvancedData.ts \
  web/react-gui/src/components/history/__tests__/useHistoryCardData.test.tsx
git commit -m "fix(history): reduce duplicate loads and indexed sort cost"
```

Review gate: request review of SWR behavior and helper SQL.

## Slice 4 - One-Time Schema Guard

**Purpose:** Avoid repeated schema guard overhead after phase timing has shown whether schema checks contribute meaningful request latency.

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add verification for versioned schema guard.**

In `scripts/verify-sync-flow.js`, assert the History API Router contains:

```js
const HISTORY_SCHEMA_GUARD_VERSION =
```

and:

```js
global.get('historySchemaGuardVersion')
```

Expected failure before implementation: schema guard version marker missing.

- [ ] **Step 2: Add one-time guard in the router.**

In both profile `flows.json` files, add near router constants:

```js
const HISTORY_SCHEMA_GUARD_VERSION = '2026-06-07-history-loading-v1';
```

Replace unconditional:

```js
await ensureHistoryTables(run);
```

with:

```js
if (global.get('historySchemaGuardVersion') !== HISTORY_SCHEMA_GUARD_VERSION) {
  await ensureHistoryTables(run);
  global.set('historySchemaGuardVersion', HISTORY_SCHEMA_GUARD_VERSION);
}
```

Reason: deploys that change history schema still bump the version and run the guard once; normal requests skip repeated `CREATE TABLE/INDEX IF NOT EXISTS` statements. Node-RED global context may be memory-only on the Pi; that is acceptable because a Node-RED restart simply reruns the idempotent schema guard once.

- [ ] **Step 3: Verify.**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: PASS.

- [ ] **Step 4: Re-run live timing and inspect logs.**

Run measurement, then on kaba100:

```bash
SSH_AUTH_SOCK=/home/phil/.ssh/agent/s.dUaIkoc630.agent.Cs3Bf1Nutw ssh root@100.93.68.86 \
  'logread | grep "\\[history-api\\]" | tail -n 20'
```

Expected: `phaseMs.schema` or the equivalent schema phase drops after the first request in a Node-RED process.

- [ ] **Step 5: Commit.**

```bash
git add scripts/verify-sync-flow.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix(history): cache schema guard"
```

Review gate: request review of runtime guard safety and timing output.

## Slice 5 - Farmer-Facing Card Title And Header Layout

**Purpose:** Remove the Zone B/top-left label clutter and rename the Soil Card to Soil Moisture.

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx`

- [ ] **Step 1: Update tests first.**

Change detail-page expectations from:

```ts
await screen.findByRole('heading', { level: 1, name: 'Soil - Root Zone' });
```

to:

```ts
await screen.findByRole('heading', { level: 1, name: 'Soil Moisture Zone B' });
```

Add one assertion that the separate eyebrow text `Zone B` is not rendered in the header:

```ts
const heading = await screen.findByRole('heading', { level: 1, name: 'Soil Moisture Zone B' });
expect(heading.closest('header')).not.toHaveTextContent(/^Zone B$/);
```

Update mobile overview tests to expect `Soil Moisture`.

- [ ] **Step 2: Rename backend card summary title.**

In both profile `flows.json` History API Router `CARD_CONFIG.soil`, change:

```js
title: 'Soil - Root Zone',
subtitle: 'Root-zone tension',
```

to:

```js
title: 'Soil Moisture',
subtitle: 'Root-zone tension',
```

- [ ] **Step 3: Confirm frontend title source.**

Do not edit locale files for this rename in this slice. Current `history.json` files do not contain `history.card.soil.title`; the detail header reads the backend card summary title. Keep `history.cardType.soil` as the generic type label `Soil`. If a later slice changes the UI to render `HistoryI18nKeys.card.soil.title`, add that full locale key set in a dedicated i18n change.

- [ ] **Step 4: Compose the detail header title.**

In `HistoryCardDetailPage.tsx`, add:

```ts
function detailCardTitle(card: HistoryCardSummary, zoneName: string | null): string {
  const baseTitle = String(card.title || '').trim();
  const zone = String(zoneName || '').trim();
  if (!zone) return baseTitle;
  if (baseTitle.toLowerCase().endsWith(zone.toLowerCase())) return baseTitle;
  return `${baseTitle} ${zone}`;
}
```

Pass `title={detailCardTitle(displayCard, resolvedZone?.name ?? null)}` to `HistoryDetailHeader`. This intentionally applies to every zone-scoped thematic card because the separate zone eyebrow is removed. Gateway cards pass `null` for `zoneName` and keep their base title.

- [ ] **Step 5: Simplify `HistoryDetailHeader`.**

Change props so `HistoryDetailHeader` accepts `title: string` instead of rendering a separate `zoneName` eyebrow. Render only:

```tsx
<h1 className={`truncate font-bold text-[var(--text)] ${compact ? 'text-base leading-tight' : 'text-xl'}`}>
  {title}
</h1>
```

Keep the source popover and settings button.

- [ ] **Step 6: Verify.**

Run:

```bash
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit
```

Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx \
  web/react-gui/src/pages/HistoryCardDetailPage.tsx \
  web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx \
  web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx
git commit -m "fix(history): show zone in card title"
```

Review gate: request review with a mobile screenshot of Zone B line chart.

## Slice 6 - Soil Line Depth Labels

**Purpose:** Label soil line series by depth when available, otherwise by generic sensor number.

**Files:**

- Modify: `web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx`
- Test: `web/react-gui/src/components/history/__tests__/SoilLineChartView.test.tsx`

- [ ] **Step 1: Add tests for depth and fallback labels.**

In `SoilLineChartView.test.tsx`, add a test where `data.profiles` contains:

```ts
profiles: [
  { id: 'swt_1', label: 'Soil 1', depthCm: 5, value: 6.2, unit: 'kPa', status: 'optimal' },
  { id: 'swt_2', label: 'Soil 2', depthCm: 10, value: 8.1, unit: 'kPa', status: 'optimal' },
]
```

Assert that tooltip/line names use `5 cm` and `10 cm`. Because Recharts tooltip text is not always rendered until interaction, export the real pure formatter from `SoilLineChartView.tsx` and have the component call the same function:

```ts
expect(soilSeriesDisplayLabel(data, { id: 'swt_1', label: 'SWT 1' }, 0)).toBe('5 cm');
expect(soilSeriesDisplayLabel(data, { id: 'swt_2', label: 'SWT 2' }, 1)).toBe('10 cm');
```

Add a fallback assertion:

```ts
expect(soilSeriesDisplayLabel(soilData({ profiles: [] }), { id: 'swt_3', label: 'SWT 3' }, 2)).toBe('Sensor 3');
```

Add a duplicate-depth assertion:

```ts
expect(soilSeriesDisplayLabel(duplicateDepthData, { id: 'swt_1', label: 'SWT 1' }, 0)).toBe('5 cm - Sensor 1');
expect(soilSeriesDisplayLabel(duplicateDepthData, { id: 'swt_2', label: 'SWT 2' }, 1)).toBe('5 cm - Sensor 2');
```

- [ ] **Step 2: Implement depth-aware labels.**

In `SoilLineChartView.tsx`, export:

```ts
export function soilSeriesDisplayLabel(
  data: Pick<HistoryCardDataResponse, 'profiles'> | undefined,
  series: Pick<HistorySeries, 'id' | 'label'>,
  index: number,
): string
```

Resolve the channel id with this exact algorithm:

1. Normalize `series.id` and `series.label` to lowercase strings.
2. Check exact equality for `swt_1`, `swt_2`, `swt_3`.
3. Check separator-delimited patterns only: `/(^|[^a-z0-9])swt[_ -]?([123])([^a-z0-9]|$)/i`.
4. Check display-label pattern only: `/^swt\\s*([123])(?:\\b|\\s)/i`.
5. Do not match arbitrary digits in DevEUI, device names, or source labels.

Use this priority:

1. If matching profile has finite `depthCm` and no other visible profile uses the same depth, return `${depthCm} cm`.
2. If matching profile has finite `depthCm` but another visible profile uses the same depth, return `${depthCm} cm - Sensor ${index + 1}`.
3. Otherwise return `Sensor ${index + 1}`.

Do not return raw series labels that contain DevEUI, underscores, or `swt_*`.

- [ ] **Step 3: Verify.**

Run:

```bash
cd web/react-gui && npm run test:unit:vitest -- SoilLineChartView
cd web/react-gui && npm run test:unit
```

Expected: all pass.

- [ ] **Step 4: Commit.**

```bash
git add web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx \
  web/react-gui/src/components/history/__tests__/SoilLineChartView.test.tsx
git commit -m "fix(history): label soil lines by depth"
```

Review gate: request review with a Zone B line-chart screenshot and tooltip check.

## Slice 7 - Calendar Month Context

**Purpose:** Make the active calendar month visible in fullscreen history.

**Files:**

- Create: `web/react-gui/src/history/calendarMonth.ts`
- Modify: `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx`

- [ ] **Step 1: Create a shared month helper test.**

Add tests through the existing component tests that prove:

```ts
expect(formatHistoryCalendarMonthLabel(calendarWithJuneDays)).toMatch(/June 2026/);
expect(formatHistoryCalendarMonthLabel(calendarSpanningMayAndJune)).toMatch(/June 2026/);
expect(formatHistoryCalendarMonthLabel(null)).toBeNull();
expect(formatHistoryCalendarMonthLabel(calendarWithPacificKiritimatiTimezone)).toMatch(/June 2026/);
```

- [ ] **Step 2: Implement `calendarMonth.ts`.**

Create:

```ts
import type { HistoryCalendar } from './types';

export function latestCalendarMonth(calendar: HistoryCalendar | null | undefined): { year: number; month: number } | null {
  const days = Array.isArray(calendar?.days) ? calendar.days : [];
  let latest: { date: string; year: number; month: number } | null = null;
  for (const day of days) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day.date);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month)) continue;
    if (!latest || day.date > latest.date) latest = { date: day.date, year, month };
  }
  return latest ? { year: latest.year, month: latest.month } : null;
}

export function formatHistoryCalendarMonthLabel(calendar: HistoryCalendar | null | undefined): string | null {
  const month = latestCalendarMonth(calendar);
  if (!calendar || !month) return null;
  const timezone = calendar.timezone || 'UTC';
  const monthDate = new Date(Date.UTC(month.year, month.month - 1, 15, 12));
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(monthDate);
}
```

The mid-month UTC anchor is intentional. It keeps the formatted month stable even for timezones near the International Date Line. Cover `Pacific/Kiritimati` in tests.

- [ ] **Step 3: Use the helper in `HistoryMonthCalendarView`.**

Remove the local duplicated month-label logic and call `latestCalendarMonth` plus `formatHistoryCalendarMonthLabel`.

- [ ] **Step 4: Show month in the top-left pill for calendar view.**

In `HistoryCardDetailPage.tsx`, avoid nested ternaries and add a small local helper:

```ts
function detailViewModeLabel(
  t: HistoryTranslate,
  selectedView: HistoryViewMode,
  visibleRangeLabel: string,
  calendarMonthLabel: string | null,
): string {
  const viewLabel = formatViewLabel(t, selectedView);
  if (selectedView === 'calendar') {
    return calendarMonthLabel ? `${viewLabel} - ${calendarMonthLabel}` : viewLabel;
  }
  return `${viewLabel} - ${visibleRangeLabel}`;
}
```

Render `viewModeLabel` in the top-left pill.

- [ ] **Step 5: Verify.**

Run:

```bash
cd web/react-gui && npm run test:unit:vitest -- HistoryMonthCalendarView HistoryCardDetailPage
cd web/react-gui && npm run test:unit
```

Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add web/react-gui/src/history/calendarMonth.ts \
  web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx \
  web/react-gui/src/pages/HistoryCardDetailPage.tsx \
  web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx \
  web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx
git commit -m "fix(history): show calendar month context"
```

Review gate: request review with a calendar screenshot showing the month in the persistent context pill.

## Slice 8 - Final Verification And Live Deploy

**Purpose:** Prove the optimization and label fixes work locally and on kaba100.

**Files:**

- Modify: `docs/ux/history-data-visualization-kaba100-issues.md`

- [ ] **Step 1: Run full local verification.**

Run:

```bash
node scripts/test-history-helper.js
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
```

Expected: all pass.

- [ ] **Step 2: Deploy to kaba100 using GUI-only or full runtime as appropriate.**

If only frontend slices changed since last deploy, deploy GUI-only. If any `flows.json` or helper files changed, deploy the runtime safely under the AGENTS.md live-deploy rules:

- Never overwrite `/data/db/farming.db` on a running or previously provisioned Pi.
- Before a runtime deploy, create a timestamped backup under `/data/db/backups/osi-os-<timestamp>` covering `/data/db/`, `/srv/node-red/`, `/usr/lib/node-red/gui/`, `flows.json`, and `settings.js`.
- Schema changes must be idempotent SQL or migrations, never DB replacement.

- [ ] **Step 3: Run post-deploy measurements.**

Run the Slice 1 measurement script against kaba100.

Expected targets:

- `zone-cards` p50 under 400 ms.
- `soil-line-24h` p50 under 600 ms.
- `soil-line-7d` p50 under 700 ms.
- `soil-calendar-30d` p50 under 700 ms.

These are optimization targets, not automatic release blockers. If the targets are not met, use the Slice 1 `phaseMs` logs to identify the next bottleneck before further changes. If the dominant phase is outside this plan's scope, record the evidence and ask for a scope decision instead of adding speculative fixes.

- [ ] **Step 4: Run live UI checks.**

Verify on mobile browser:

- Header reads `Soil Moisture Zone B`.
- No separate `Zone B` eyebrow competes with the chart label.
- Soil line chart tooltip/series names show depth labels when available, otherwise `Sensor N`.
- Calendar view shows the month in the persistent top-left context pill.
- Pinch zoom still works and the x-axis remains visible.

- [ ] **Step 5: Update issue document.**

Record:

- baseline timing
- post-fix timing
- deployed commit
- served asset hash
- remaining risks

- [ ] **Step 6: Commit docs if updated after deploy.**

```bash
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(history): record loading and label verification"
```

## Self-Review Checklist

- [ ] Performance changes are measured before and after.
- [ ] Every backend runtime payload change is mirrored to bcm2709.
- [ ] Soil Card title is `Soil Moisture`.
- [ ] Detail title includes the zone, for example `Soil Moisture Zone B`.
- [ ] Normal UI does not reveal raw DevEUI or `swt_*` labels.
- [ ] Soil line labels use depths or `Sensor N`.
- [ ] Calendar month is visible in fullscreen.
- [ ] Existing pinch, pan, and x-axis behavior remain intact.
- [ ] `npm run test:unit`, `npm run build`, and profile verification pass before deploy.
