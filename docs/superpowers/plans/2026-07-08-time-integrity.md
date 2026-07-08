# Time integrity — timestamp clamp, scheduler clock-jump safety, RTC health (refactor-program 5.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Repo:** all changes in **osi-os** (`/home/phil/Repos/osi-os`). Branch `feat/56-time-integrity`, PR, **do not merge**. Work in a worktree, not the root `main` checkout.
> **FLOWS MUTATION LAW (this item edits scheduler + ingest nodes — read `.claude/skills/osi-flows-json-editing/SKILL.md` first):** every `flows.json` edit is a **one-shot Node script in the scratchpad** with the **roundtrip byte-identity guard** (read → `JSON.parse` → `JSON.stringify(x,null,2)+'\n'` → `Buffer.compare` must be identical BEFORE and AFTER), writing **both** profile copies (bcm2712 canonical + bcm2709 mirror) — never a hand-edit, never a text-replacement tool, never a blind regex over a node body. Edits are **element-targeted** (find the node by id, mutate `.func`). The two scheduler/ingest nodes this item edits (`5f0d2b7e9b9b1b3a` "Decide + build actuator cmd + build DB logs" and `9b3afb405207302e` "Build SQL INSERT") are **NOT in `verify-sync-flow.js`'s `requiredFunctionNodes`** (verified — that gate covers 80 named nodes, none of these), so per batch-A's 4.3 lesson each edited node **must get a `vm.Script` compile check added** (uncovered nodes are a silent-corruption gap). This plan adds them to `requiredFunctionNodes`.
> **Execution notes:** (1) run every command from the worktree root; (2) **NO boot-node (`sync-init-fn`) change** — the scheduler guard is in the decision node, the RTC read is in `osi-health-helper`; (3) the new tests wire into `.github/workflows/migrations.yml` (`node --test scripts/*.test.js` at line 38, and `node --test scripts/test-health-helper.js` at line 40); (4) `node:sqlite`/`node:test` need Node >= 22.5 — CI pins `node-version: '22'` (line 32).
> **Spec:** [`docs/superpowers/specs/2026-07-08-time-integrity-design.md`](../specs/2026-07-08-time-integrity-design.md) (recovered + verified; §A–§D references point there).

**Goal:** Close three time-integrity hazards (DD18): (A) a **timestamp sanity clamp** at edge ingest so a device with a bad clock cannot write a 1970/2099 `recorded_at` that breaks range queries — clamp to `now` (log it) when outside `[2024-01-01, now+1h]`; (B) **scheduler clock-jump safety** — a forward jump never auto-fires a missed window (farmer safety), a backward jump never double-fires (a `last_triggered_at` debounce that is verified ABSENT today); (C) an **RTC presence/health field** in the heartbeat so a clock-drift-prone gateway is visible before it misbehaves. Both-profile parity for every flows edit; unit tests for the clamp, the scheduler guard, and the RTC read.

**Architecture (spec §A–§C):** The clamp (§A) is a self-contained pure function (`clampRecordedAt`) added inline to the primary `device_data` ingest node `Build SQL INSERT` (`9b3afb405207302e`), exactly where `recorded_at` is derived today (verified line 44: `const recordedAt = data.timestamp ? String(data.timestamp) : new Date().toISOString();`); a repo-level test executes the REAL node's `func` text (the `rehearse-devices-rebuild.js` run-real-function-text precedent) to unit-test the clamp. The scheduler backward-jump guard (§B) is a localized debounce in the decision node `Decide + build actuator cmd + build DB logs` (`5f0d2b7e9b9b1b3a`): before firing, if `last_triggered_at` falls in the current logical window (same UTC day for the daily `00 06 * * *` cron — verified crontab), skip + log; the forward-jump behavior is already correct (stateless daily cron never backfills) and is made explicit + logged. The RTC field (§C) adds `rtc_present`/`clock_health` to `osi-health-helper` (verified: already `require('node:child_process')`, already the heartbeat builder) via a fail-soft `/sys/class/rtc/rtc0` stat + optional `hwclock -r` (verified `CONFIG_BUSYBOX_DEFAULT_HWCLOCK=y` on both Pi profiles), surfaced in `Build Heartbeat` and asserted by `verify-heartbeat-health.js`.

**Tech Stack:** Node.js (`node:test`, `node:sqlite`, `node:child_process`, no new deps), Node-RED function nodes in `flows.json` (both profiles), GitHub Actions (`migrations.yml`).

## Global Constraints

- **osi-os only.** Branch `feat/56-time-integrity`; commit per task; PR; **do not merge**.
- **FLOWS LAW (above):** one-shot roundtrip-guarded script, both profiles byte-identical (`verify-profile-parity.js`), element-targeted edits, `vm.Script` compile check added for both edited scheduler/ingest nodes (they are not covered today).
- **NO `sync-init-fn` (boot node) change. NO NTP/chrony reconfiguration. NO server-side timestamp change** (the clamp is edge-ingest-only; the server keeps its own `recorded_at` logic). **NO missed-window catch-up feature** (the explicit farmer-safety decision is NOT to backfill).
- **The scheduler guard must NOT break the normal daily fire** — the critical regression check (normal tick, `last_triggered_at` = a prior window, soil dry ⇒ fires).
- **RTC read is fail-soft** — a read error → `rtc_present: null`, never a thrown heartbeat; must stay within `osi-health-helper`'s size ceiling (1.A1/1.A2 ratchet — a field-add, not a rewrite).
- **Documented constants, not per-call guesses:** clamp bounds are `FLOOR = 2024-01-01T00:00:00Z`, `SKEW = +1h`.
- CI (`migrations.yml`) green at every commit; full flows pre-commit checklist (roundtrip both profiles, `verify-profile-parity.js`, `verify-sync-flow.js`, `check-mqtt-topics.sh`, `test-flows-wiring.js`) run after each flows edit.

## Non-goals (do not do these)

- No boot-node change; no NTP/chrony management; no server-side timestamp handling; no missed-window catch-up queue; no RTC hardware provisioning (reports presence/health only); no general scheduling rewrite (a localized debounce on the existing daily cron). This item DEFINES/BUILDS the scheduler behavior; **5.2's Scenario 2 REHEARSES it** (its regression net) — do not build the rig here.

## File Structure (all paths from the worktree root)

- Task 1 (clamp): edit node `9b3afb405207302e` in both `flows.json` copies (via one-shot script); create `scripts/test-timestamp-clamp.js`; add the node to `verify-sync-flow.js` `requiredFunctionNodes`.
- Task 2 (scheduler guard): edit node `5f0d2b7e9b9b1b3a` in both `flows.json` copies; create `scripts/test-scheduler-clock-jump.js`; add the node to `verify-sync-flow.js` `requiredFunctionNodes`.
- Task 3 (RTC health): modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/index.js` (+ bcm2709 mirror); edit `Build Heartbeat` (`062a0f9bf66d9789`) in both `flows.json` copies to surface the field; extend `scripts/test-health-helper.js` + `scripts/verify-heartbeat-health.js`.
- Task 4: CI wiring + PR.

---

### Task 0 (MANDATORY FIRST): verify the current scheduler guard state and record it

> The pre-ruling requires the FIRST action to VERIFY what guard actually exists, because the fix differs depending on it. Do this and record the finding in the PR body before writing any guard.

- [ ] **Step 0.1: Worktree + branch** — create a worktree of `main` at `feat/56-time-integrity`; `cd` into it.

- [ ] **Step 0.2: Read the actual scheduler nodes and confirm the spec §2 finding** —

```bash
# The daily cron:
node -e 'const f=require("./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"); const n=f.find(x=>x.id==="4b7b6d3b8d1f0d31"); console.log("Schedule time crontab:", n.crontab)'
# The zones query WHERE clause — does it debounce on last_triggered_at?
node -e 'const f=require("./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"); const n=f.find(x=>x.id==="a0a61f4b7dca1c2e"); console.log(/last_triggered_at\s*<|WHERE[\s\S]*last_triggered_at/.test(n.func) ? "zones query DOES debounce" : "zones query does NOT debounce on last_triggered_at")'
# The decision node — does it read last_triggered_at before deciding to fire?
node -e 'const f=require("./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"); const n=f.find(x=>x.id==="5f0d2b7e9b9b1b3a"); const writes=(n.func.match(/SET last_triggered_at/g)||[]).length; const guards=/if\s*\([^)]*last_triggered_at/.test(n.func); console.log("decision node last_triggered_at WRITE sites:", writes, "| reads as a fire-guard:", guards)'
```

Expected (confirming spec §2): crontab `00 06 * * *`; zones query does NOT debounce; decision node WRITES `last_triggered_at` at 2 sites (only when irrigating) but does NOT read it as a fire-guard. **Record verbatim in the PR body:** "Verified today: `last_triggered_at` is populated but NOT enforced as a same-window debounce; there is NO backward-jump double-fire guard active. This item adds the guard (decision-node debounce), it does not merely rely on an existing one." If the finding differs from the spec, STOP and re-scope.

---

### Task 1: Timestamp sanity clamp at edge ingest (spec §A)

**Files:**
- Edit (flows, both profiles): node `9b3afb405207302e` ("Build SQL INSERT")
- Create: `scripts/test-timestamp-clamp.js`
- Modify: `scripts/verify-sync-flow.js` (add the node to `requiredFunctionNodes`)

**Interfaces:** the edited node gains an inline `clampRecordedAt(raw, nowMs)` that returns `{ recordedAt, clamped }`; `recorded_at` is derived through it; a clamp logs one greppable `node.warn` line. Bounds are the documented constants `FLOOR = Date.parse('2024-01-01T00:00:00Z')`, `SKEW_MS = 3600000`.

- [ ] **Step 1.1: Write the failing test (red)** — the test executes the REAL node's `func` text (run-real-function-text precedent) and exercises the clamp. Create `scripts/test-timestamp-clamp.js` with exactly:

```js
'use strict';
// Unit-tests the timestamp clamp by executing the REAL `Build SQL INSERT` node
// func text (id 9b3afb405207302e) from flows.json — the rehearse-devices-rebuild.js
// run-real-function-text precedent. Refactor-program 5.6, spec §A.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS = path.resolve(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

// Extract the clampRecordedAt function source from the real node body and eval it
// in isolation (proving the shipped node contains a correct, self-contained clamp).
function loadClampFromNode() {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === '9b3afb405207302e');
  assert.ok(node, 'node 9b3afb405207302e (Build SQL INSERT) must exist');
  const m = node.func.match(/function clampRecordedAt[\s\S]*?\n}/);
  assert.ok(m, 'Build SQL INSERT must define clampRecordedAt (the ingest clamp)');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return clampRecordedAt;`)();
}

const NOW = Date.parse('2026-06-01T12:00:00Z');

test('a plausible device timestamp passes through unchanged', () => {
  const clamp = loadClampFromNode();
  const iso = '2026-05-30T09:00:00Z';
  const r = clamp(iso, NOW);
  assert.equal(r.clamped, false);
  assert.equal(r.recordedAt, iso);
});

test('a 1970/epoch timestamp is clamped to now and flagged', () => {
  const clamp = loadClampFromNode();
  const r = clamp('1970-01-01T00:00:00Z', NOW);
  assert.equal(r.clamped, true);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});

test('a 2099 far-future timestamp (beyond now+1h) is clamped to now', () => {
  const clamp = loadClampFromNode();
  const r = clamp('2099-01-01T00:00:00Z', NOW);
  assert.equal(r.clamped, true);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});

test('a timestamp just below the 2024-01-01 FLOOR is clamped', () => {
  const clamp = loadClampFromNode();
  const r = clamp('2023-12-31T23:59:59Z', NOW);
  assert.equal(r.clamped, true);
});

test('the FLOOR boundary (2024-01-01T00:00:00Z) is accepted', () => {
  const clamp = loadClampFromNode();
  const r = clamp('2024-01-01T00:00:00Z', NOW);
  assert.equal(r.clamped, false);
});

test('a timestamp within +1h skew is accepted; beyond +1h is clamped', () => {
  const clamp = loadClampFromNode();
  assert.equal(clamp(new Date(NOW + 59 * 60 * 1000).toISOString(), NOW).clamped, false);
  assert.equal(clamp(new Date(NOW + 61 * 60 * 1000).toISOString(), NOW).clamped, true);
});

test('an empty/missing timestamp falls back to now (not clamped, no crash)', () => {
  const clamp = loadClampFromNode();
  const r = clamp('', NOW);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});

test('a garbage/unparseable timestamp is clamped to now', () => {
  const clamp = loadClampFromNode();
  const r = clamp('not-a-date', NOW);
  assert.equal(r.clamped, true);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});
```

- [ ] **Step 1.2: Run it (red)**

Run: `node --test scripts/test-timestamp-clamp.js`
Expected: FAIL — `Build SQL INSERT must define clampRecordedAt` (the node has no clamp yet).

- [ ] **Step 1.3: Edit the node via a one-shot roundtrip-guarded script (both profiles)** — write `flows-edit-clamp.js` in the scratchpad (NOT the repo), adapting the SKILL skeleton. It (a) roundtrip-guards both profiles, (b) finds node `9b3afb405207302e`, (c) replaces the single line `const recordedAt = data.timestamp ? String(data.timestamp) : new Date().toISOString();` with the clamp-defining block below, (d) writes both profiles, (e) re-guards. The replacement inserts, immediately before the original `recorded_at` line, this self-contained clamp and rewrites the derivation:

```js
// --- timestamp sanity clamp (refactor-program 5.6 / DD18, spec §A) ---
// Bounds are documented constants: no real reading predates the project (FLOOR),
// device-vs-gateway skew tolerated up to +1h (SKEW). Outside => clamp to now + log,
// so a device with a bad clock cannot write a 1970/2099 row that breaks range queries.
function clampRecordedAt(raw, nowMs) {
  const FLOOR = Date.parse('2024-01-01T00:00:00Z');
  const SKEW_MS = 3600000;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(now).toISOString();
  if (raw === undefined || raw === null || raw === '') return { recordedAt: nowIso, clamped: false };
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t) || t < FLOOR || t > now + SKEW_MS) {
    return { recordedAt: nowIso, clamped: true };
  }
  return { recordedAt: String(raw), clamped: false };
}
const __clampResult = clampRecordedAt(data.timestamp, Date.now());
const recordedAt = __clampResult.recordedAt;
if (__clampResult.clamped) {
  node.warn(`timestamp_clamped: implausible device timestamp '${data.timestamp}' for ${devEui} clamped to ${recordedAt}`);
}
```

> The `node.warn` references `devEui`, which the node derives ABOVE line 44 (verified: `const devEui = String(devEuiRaw).toUpperCase().trim();` precedes the recorded_at line) — so it is in scope. The one-shot script must place the clamp AFTER the `devEui` derivation and remove the old single-line derivation. Verify placement in the script by asserting the old line is present exactly once before replacing.

- [ ] **Step 1.4: Add the node to the compile gate** — in `scripts/verify-sync-flow.js`, add `'Build SQL INSERT'` to the `requiredFunctionNodes` array (line ~196). **Caveat:** three nodes share the name "Build SQL INSERT" (`9b3afb405207302e`, `lsn50-sql-fn`, `s2120-sql-fn` — verified via a name grep). The `requiredFunctionNodes` gate compiles by NAME (`flows.find(n => n.name === name)`), which finds only the first. Confirm the gate's lookup and, if it compiles only the first match, compile-check all three by id instead — see Step 1.5.

- [ ] **Step 1.5: Verify the compile gate reaches the edited node** — inspect how `requiredFunctionNodes` are resolved:

```bash
node -e 'const src=require("fs").readFileSync("scripts/verify-sync-flow.js","utf8"); const m=src.match(/for \(const name of requiredFunctionNodes\)[\s\S]{0,400}/); console.log(m && m[0])'
```

If the loop resolves by `name` and multiple nodes share "Build SQL INSERT", the name-based entry will not deterministically compile `9b3afb405207302e`. In that case, add an explicit id-based compile assertion instead: append a small block to `verify-sync-flow.js` after the `requiredFunctionNodes` loop:

```js
// Compile-check the time-integrity-edited ingest/scheduler nodes by id (5.6):
// these are not uniquely name-addressable, so pin them explicitly (batch-A 4.3 lesson).
for (const id of ['9b3afb405207302e', '5f0d2b7e9b9b1b3a']) {
  const n = flows.find((x) => x.id === id);
  if (!n) fail(`time-integrity node ${id} missing`);
  try {
    new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${n.func}\n})`);
    console.log(`OK compile ${id} (${n.name})`);
  } catch (error) {
    fail(`function node ${id} (${n.name}) does not compile: ${error.message}`);
  }
}
```

(Use `vm` — already `require`d in `verify-sync-flow.js`, verified at line 759/1181. Do NOT also add the shared name to `requiredFunctionNodes` if that would ambiguously compile a different node; the id-based block is the reliable gate. Decide by the Step 1.4 grep and record which mechanism you used.)

- [ ] **Step 1.6: Run the flows pre-commit checklist + the clamp test (green)**

```bash
node --test scripts/test-timestamp-clamp.js
node scripts/verify-sync-flow.js          # includes the new compile check + chains profile parity
node scripts/verify-profile-parity.js
node scripts/test-flows-wiring.js
bash scripts/check-mqtt-topics.sh
```

Expected: clamp test green; `OK compile 9b3afb405207302e (Build SQL INSERT)`; `Sync flow verification passed` → `All parity checks passed.`; wiring guards `PASS`; MQTT topics three `OK:`.

- [ ] **Step 1.7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-timestamp-clamp.js scripts/verify-sync-flow.js
git commit -m "feat(time): clamp implausible device timestamps at ingest to [2024-01-01, now+1h] (5.6, DD18)"
```

---

### Task 2: Scheduler clock-jump guard — backward-jump debounce + explicit forward-jump skip (spec §B)

**Files:**
- Edit (flows, both profiles): node `5f0d2b7e9b9b1b3a` ("Decide + build actuator cmd + build DB logs")
- Create: `scripts/test-scheduler-clock-jump.js`
- Modify: `scripts/verify-sync-flow.js` (the id-based compile block from Task 1.5 already covers `5f0d2b7e9b9b1b3a`)

**Interfaces:** the decision node gains a self-contained `sameLogicalWindow(nowMs, lastTriggeredIso)` (same UTC day for the daily 06:00 cron) and, immediately before each IRRIGATE fire path, a guard: if `last_triggered_at` is in the current window, skip + log `clock_jump_backward_suppressed` instead of firing. The test executes the guard function from the real node text.

- [ ] **Step 2.1: Write the failing test (red)** — create `scripts/test-scheduler-clock-jump.js` with exactly:

```js
'use strict';
// Executes the REAL `Decide + build actuator cmd` node (id 5f0d2b7e9b9b1b3a) guard
// function from flows.json (run-real-function-text precedent). Refactor-program 5.6, spec §B.
// Proves: backward jump suppressed, normal fire preserved (the critical regression check).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS = path.resolve(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

function loadSameWindowFromNode() {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === '5f0d2b7e9b9b1b3a');
  assert.ok(node, 'node 5f0d2b7e9b9b1b3a (Decide + build actuator cmd) must exist');
  const m = node.func.match(/function sameLogicalWindow[\s\S]*?\n}/);
  assert.ok(m, 'decision node must define sameLogicalWindow (the backward-jump debounce)');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return sameLogicalWindow;`)();
}

const WINDOW = Date.parse('2026-05-10T06:05:00Z'); // just after the 06:00 daily window
const DAY = 24 * 3600 * 1000;

test('a last_triggered_at earlier today is the SAME logical window (backward-jump debounce fires)', () => {
  const same = loadSameWindowFromNode();
  assert.equal(same(WINDOW, '2026-05-10T06:00:30Z'), true);
});

test('a last_triggered_at yesterday is a DIFFERENT window (normal daily fire preserved)', () => {
  const same = loadSameWindowFromNode();
  assert.equal(same(WINDOW, new Date(WINDOW - DAY).toISOString()), false);
});

test('a null/absent last_triggered_at is not the same window (first-ever fire allowed)', () => {
  const same = loadSameWindowFromNode();
  assert.equal(same(WINDOW, null), false);
  assert.equal(same(WINDOW, ''), false);
});

test('the guard string clock_jump_backward_suppressed is present in the node (skip+log path exists)', () => {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === '5f0d2b7e9b9b1b3a');
  assert.match(node.func, /clock_jump_backward_suppressed/);
});
```

- [ ] **Step 2.2: Run it (red)**

Run: `node --test scripts/test-scheduler-clock-jump.js`
Expected: FAIL — `decision node must define sameLogicalWindow`.

- [ ] **Step 2.3: Edit the decision node via a one-shot roundtrip-guarded script (both profiles)** — write `flows-edit-scheduler-guard.js` in the scratchpad. It roundtrip-guards both profiles, finds node `5f0d2b7e9b9b1b3a`, and makes two element-targeted mutations to `.func`:

  (a) **Add the helper** immediately after the existing `const nowIso = new Date().toISOString();` line (verified present, near the top of the func):

```js
// --- scheduler clock-jump safety (refactor-program 5.6 / DD18, spec §B) ---
// Same UTC calendar day == same logical window for the daily "00 06 * * *" cron.
// A backward clock jump that re-hits 06:00 the same day must NOT re-fire.
function sameLogicalWindow(nowMs, lastTriggeredIso) {
  if (!lastTriggeredIso) return false;
  const t = Date.parse(String(lastTriggeredIso));
  if (!Number.isFinite(t)) return false;
  const a = new Date(nowMs);
  const b = new Date(t);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}
const __scheduleDebounce = sameLogicalWindow(Date.now(), zone.last_triggered_at);
```

  (b) **Guard the IRRIGATE fire path.** The irrigate branch is gated by `const irrigate = (meanKpa >= threshold);` (verified line 310). Insert the debounce into that condition so a same-window re-hit skips instead of firing. The one-shot script rewrites the single line `const irrigate = (meanKpa >= threshold);` to:

```js
const __wouldIrrigate = (meanKpa >= threshold);
if (__wouldIrrigate && __scheduleDebounce) {
  node.warn(`clock_jump_backward_suppressed: zone ${zoneId} already fired for today's window (last_triggered_at=${zone.last_triggered_at}); skipping re-fire`);
}
const irrigate = (__wouldIrrigate && !__scheduleDebounce);
```

> This is a localized change: the existing SKIP/below-threshold log path (verified: an `irrigation_events` SKIP row with reason `below_threshold`) already handles `irrigate === false`, so a suppressed fire logs a SKIP and writes NO actuator command and NO `last_triggered_at` — exactly the no-double-fire property. **Do not** add a `last_triggered_at` predicate to the zones query (spec §B prefers the decision-node guard — the query already `SELECT`s `last_triggered_at`, verified). The forward-jump case needs no code change: the stateless daily cron never backfills (verified — it evaluates current soil state, not a missed-window queue); §B's `clock_jump_forward` heartbeat visibility is delivered by Task 3's RTC/clock-health field, not a scheduler edit.

  (c) **Guard the SECOND (DENDRO) IRRIGATE path.** The decision node has TWO independent fire paths (verified): the threshold path just guarded (line 310+), and a **DENDRO branch** (`if (triggerMetric === "DENDRO") {` at line 95) that builds its own actuator `cmd`, an `IRRIGATE` `irrigation_events` row, and an `UPDATE ... SET last_triggered_at` (`updateSql`), then `return [{ payload: cmd }, { topic: insertSql }, { topic: updateSql }];` at line 258 — **before** the threshold path. Without a guard here, a backward jump re-fires a dendro zone (the exact §B double-fire). The DENDRO IRRIGATE is reached only after the `if (!recommendationAction) { ... return ...; }` SKIP guard, at `const effectiveAction = recommendationAction;` (verified line 196). The one-shot script inserts, immediately AFTER that `const effectiveAction = recommendationAction;` line, this same-window debounce that short-circuits to a SKIP triple (no actuator, no `last_triggered_at` write) instead of firing:

```js
  if (__scheduleDebounce) {
    node.warn(`clock_jump_backward_suppressed: dendro zone ${zoneId} already fired for today's window (last_triggered_at=${zone.last_triggered_at}); skipping re-fire`);
    const __suppressPayloadJson = {
      zone_id: zoneId, action: "SKIP", reason: "clock_jump_backward_suppressed",
      trigger_metric: triggerMetric, threshold_kpa: threshold
    };
    const __suppressSql = `
      INSERT INTO irrigation_events
        (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
      VALUES
        (${userId}, ${zoneId}, 'SKIP', 'clock_jump_backward_suppressed', NULL, ${threshold}, ${durationMinutes}, ${valveOk ? `'${escapeSqlString(valveDevEui)}'` : 'NULL'}, '${escapeSqlString(JSON.stringify(__suppressPayloadJson))}');
    `.trim();
    return [null, { topic: __suppressSql }, null];
  }
```

> The SKIP triple `[null, { topic: __suppressSql }, null]` mirrors the DENDRO branch's existing `missing_valve` SKIP shape (verified line 193: `return [null, { topic: insertSql }, null];`) — output 0 (actuator) null, output 1 (event log) the SKIP INSERT, output 2 (`last_triggered_at` UPDATE) null. `__scheduleDebounce` is in scope (inserted after line 22, before the DENDRO branch); `userId`/`zoneId`/`threshold`/`durationMinutes`/`triggerMetric`/`valveOk`/`valveDevEui`/`escapeSqlString` are all derived above the DENDRO branch (verified). This closes both fire paths; the Task-2 test's 4th assertion (`clock_jump_backward_suppressed` string present) now genuinely covers both.

- [ ] **Step 2.4: Run the flows pre-commit checklist + the guard test (green)**

```bash
node --test scripts/test-scheduler-clock-jump.js
node scripts/verify-sync-flow.js          # id-based compile block now checks 5f0d2b7e9b9b1b3a too
node scripts/verify-profile-parity.js
node scripts/test-flows-wiring.js
```

Expected: guard test green; `OK compile 5f0d2b7e9b9b1b3a (Decide + build actuator cmd + build DB logs)`; parity + wiring pass.

- [ ] **Step 2.5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-scheduler-clock-jump.js
git commit -m "feat(time): scheduler backward-jump debounce via last_triggered_at (verified absent) — no double-fire (5.6, DD18)"
```

---

### Task 3: RTC presence/health in the heartbeat (spec §C)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/index.js` (+ byte-identical bcm2709 mirror)
- Edit (flows, both profiles): node `062a0f9bf66d9789` ("Build Heartbeat") to surface the field
- Modify: `scripts/test-health-helper.js`, `scripts/verify-heartbeat-health.js`

**Interfaces:** `osi-health-helper` gains a fail-soft `rtcHealth({ rtcSysfsPath, hwclockRunner }) → { rtc_present: boolean|null, clock_source: string|null }` and includes `rtc_present`/`clock_source` in `gatherEdgeHealth`'s output; `Build Heartbeat` copies the field into `payload.health`; the verifiers assert the new keys.

> **CRITICAL shape-lock update (verified):** `test-health-helper.js` defines `PUBLIC_HEALTH_KEYS` (line 25) and derives `ALL_NULL_HEALTH = Object.fromEntries(PUBLIC_HEALTH_KEYS.map(k => [k, null]))` (line 35). `assertPublicHealthShape` does an **exact-key-set** `deepStrictEqual(Object.keys(health).sort(), PUBLIC_HEALTH_KEYS.slice().sort())` (line 38, called by tests at 157/185/220/246), and two tests do `deepStrictEqual(health, ALL_NULL_HEALTH)` (lines 367/405). Adding `rtc_present`/`clock_source` to `allNullHealth()` therefore BREAKS all 6 of those existing tests unless `PUBLIC_HEALTH_KEYS` is extended. So the FIRST edit in this step is: add `'rtc_present'` and `'clock_source'` to the `PUBLIC_HEALTH_KEYS` array (line 25) — this flows through to `ALL_NULL_HEALTH` and `assertPublicHealthShape` automatically, keeping the existing 11 tests green after the helper change. **Trailing-comma trap (verified):** the array's current last entry `'disk_free_pct'` has NO trailing comma; add the comma to it before inserting `'rtc_present',\n  'clock_source',` (otherwise two adjacent string literals = SyntaxError — the same trap as `Build Heartbeat`). **This whole plan was dry-run: after these helper + test edits, `node --test scripts/test-health-helper.js` reports `# pass 16` (11 original + 5 RTC), all green.**

- [ ] **Step 3.1: Write the failing test (red)** — extend `scripts/test-health-helper.js` (it is a `node:test` file). (1) Add `'rtc_present', 'clock_source'` to `PUBLIC_HEALTH_KEYS` (line 25) — the shape-lock update above. (2) Add `rtcHealth` to the require destructure. (3) Append these tests (do NOT rewrite the file — append to it; the exact insertion after the existing `gatherEdgeHealth` tests):

```js
// --- RTC health (refactor-program 5.6 / DD18, spec §C) ---
const { rtcHealth } = requireHealthHelperFresh();

test('rtcHealth reports present when the sysfs rtc node exists and reads', () => {
  const dir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'rtc-'));
  const node = require('node:path').join(dir, 'rtc0');
  fs.mkdirSync(node);
  fs.writeFileSync(require('node:path').join(node, 'since_epoch'), '1700000000\n');
  const r = rtcHealth({ rtcSysfsPath: node, hwclockRunner: () => 'ok' });
  assert.strictEqual(r.rtc_present, true);
});

test('rtcHealth reports absent when the sysfs rtc node does not exist', () => {
  const r = rtcHealth({ rtcSysfsPath: '/nonexistent/rtc0', hwclockRunner: () => { throw new Error('no hwclock'); } });
  assert.strictEqual(r.rtc_present, false);
});

test('rtcHealth is fail-soft: no sysfs path and no probe yields rtc_present null, never throws', () => {
  let r;
  assert.doesNotThrow(() => {
    r = rtcHealth({ rtcSysfsPath: null });
  });
  assert.strictEqual(r.rtc_present, null);
});

test('rtcHealth: injected hwclock probe succeeds => present (the optional test-seam arm)', () => {
  const r = rtcHealth({ rtcSysfsPath: '/nonexistent/rtc0', hwclockRunner: () => 'ok' });
  assert.strictEqual(r.rtc_present, true);
});

test('gatherEdgeHealth includes rtc_present in its output shape', async () => {
  // VERIFIED call form: gatherEdgeHealth(db, opts) takes an OPEN db handle/shim, NOT a
  // path — the existing tests pass makeFacadeShim() (a DatabaseSync-backed shim). Reuse it.
  const db = makeFacadeShim();
  const health = await gatherEdgeHealth(db, { timeoutMs: 2000, diskPath: os.tmpdir() });
  assert.ok(Object.prototype.hasOwnProperty.call(health, 'rtc_present'));
});
```

> `makeFacadeShim()` is the existing helper in `scripts/test-health-helper.js` (verified line 47) — it builds a `DatabaseSync(':memory:')`-backed shim and is what every existing `gatherEdgeHealth(db, ...)` call passes (verified lines 155/183/218/244). The RTC tests are APPENDED to that file, so `makeFacadeShim`, `os`, `fs`, `DatabaseSync` are already in scope — do not re-import or pass a path.

- [ ] **Step 3.2: Run it (red)**

Run: `node --test scripts/test-health-helper.js`
Expected: FAIL — `rtcHealth` is not exported / `rtc_present` absent from output.

- [ ] **Step 3.3: Implement `rtcHealth` in `osi-health-helper/index.js`** — add the function and wire it into `gatherWork`/`allNullHealth`/exports. **CRITICAL — no `execFileSync`:** `test-health-helper.js` line 422 asserts `assert.doesNotMatch(source, /\bexecFileSync\b/)` (the helper must never use the sync subprocess API — verified; `df` uses async `childProcess.execFile`, line 115). So `rtcHealth` is **sysfs-only and synchronous — NO subprocess in production** (satisfies spec §C's "read `/sys/class/rtc/rtc0` existence ... and/or `hwclock -r`" via the sysfs arm alone; the injectable `hwclockRunner` is exercised ONLY when a caller/test supplies one, and is never `execFileSync`). Place `rtcHealth` near the other small readers (e.g. after `diskFreePct`):

```js
// RTC presence/health (refactor-program 5.6 / DD18, spec §C). Fail-soft: any read
// error => rtc_present null, never throws. Sysfs-only in production (NO subprocess —
// osi-health-helper is banned from execFileSync by its own test); the optional
// hwclockRunner is a test seam only, never the sync subprocess API.
function rtcHealth({ rtcSysfsPath = '/sys/class/rtc/rtc0', hwclockRunner } = {}) {
  try {
    if (rtcSysfsPath && fs.existsSync(rtcSysfsPath)) {
      return { rtc_present: true, clock_source: 'rtc' };
    }
    // Optional injected fallback (tests only): a caller-supplied hwclock probe.
    if (typeof hwclockRunner === 'function') {
      try { hwclockRunner(); return { rtc_present: true, clock_source: 'rtc' }; }
      catch (_) { return { rtc_present: false, clock_source: null }; }
    }
    if (rtcSysfsPath) return { rtc_present: false, clock_source: null };
    return { rtc_present: null, clock_source: null };
  } catch (_) {
    return { rtc_present: null, clock_source: null };
  }
}
```

Then extend `allNullHealth()` to include `rtc_present: null, clock_source: null`, add to `gatherWork` a fail-soft block:

```js
  try {
    const rtc = rtcHealth({});
    health.rtc_present = rtc.rtc_present;
    health.clock_source = rtc.clock_source;
  } catch (_) {}
```

and add `rtcHealth` to `module.exports`.

- [ ] **Step 3.4: Mirror the helper to bcm2709 byte-identically**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-health-helper/index.js
diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/index.js \
     conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-health-helper/index.js && echo "helper mirror identical"
```

- [ ] **Step 3.5: Surface the field in `Build Heartbeat` (both profiles) via a one-shot roundtrip-guarded script** — write `flows-edit-heartbeat-rtc.js` in the scratchpad. It roundtrip-guards both profiles, finds node `062a0f9bf66d9789`, and (verified: the func builds `payload.health` via `healthValue(_h, 'schema_sig')` etc. at lines ~63-81) adds two lines inside the `health:` object literal — one in the populated branch and one in the all-null branch:

```js
        rtc_present: healthValue(_h, 'rtc_present'),
        clock_source: healthValue(_h, 'clock_source'),
```

(mirroring the existing `disk_free_pct: healthValue(_h, 'disk_free_pct')` entry) and, in the all-null fallback object, `rtc_present: null, clock_source: null`. **Trailing-comma detail (verified):** the existing `disk_free_pct: healthValue(_h, 'disk_free_pct')` line has **NO trailing comma** (it is the last property before the object closes at line ~73), and `disk_free_pct: null` similarly closes the all-null block (line ~81). The one-shot script must therefore append a comma to the existing `disk_free_pct` line when inserting the two new properties after it (or insert the new properties BEFORE `disk_free_pct`, keeping `disk_free_pct` last) — either produces valid JS; do it in-memory on the parsed node, never by regex. Because `Build Heartbeat` is a FROZEN/hot cluster node (per the SKILL), the script must be strictly additive to the `health` object literal — no other change — and re-run the roundtrip guard + wiring checks after.

- [ ] **Step 3.6: Update the heartbeat health-key verifiers** — in `scripts/verify-heartbeat-health.js`, add `'rtc_present'` and `'clock_source'` to `REQUIRED_HEALTH_KEYS` (verified array at lines 13-21). This keeps the both-profile heartbeat-shape assertion honest.

- [ ] **Step 3.7: Run the full gate (green)**

```bash
node --test scripts/test-health-helper.js
node scripts/verify-heartbeat-health.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
node scripts/test-flows-wiring.js
```

Expected: health-helper tests green (incl. the RTC ones); `verify-heartbeat-health` passes with the new keys on both profiles; sync-flow + parity + wiring green.

- [ ] **Step 3.8: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/index.js \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-health-helper/index.js \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-health-helper.js scripts/verify-heartbeat-health.js
git commit -m "feat(time): rtc_present/clock_source in heartbeat via osi-health-helper (fail-soft, both profiles) (5.6, DD18)"
```

---

### Task 4: CI wiring + PR

**Files:**
- Modify: `.github/workflows/migrations.yml`

- [ ] **Step 4.1: Wire the new tests into CI** — in `.github/workflows/migrations.yml`, append the two new repo-level tests to the `node --test scripts/...test.js` run at line 38: `scripts/test-timestamp-clamp.js scripts/test-scheduler-clock-jump.js`. (`scripts/test-health-helper.js` is already run at line 40; `verify-heartbeat-health.js` at line 48; `verify-sync-flow.js` at line 44 — no new lines needed for those.)

```yaml
      - run: node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js scripts/verify-no-stray-ddl.test.js scripts/verify-no-new-silent-catch.test.js scripts/test-error-recording-flow.js scripts/test-timestamp-clamp.js scripts/test-scheduler-clock-jump.js
```

- [ ] **Step 4.2: Run the whole local gate once more (green)**

```bash
node --test scripts/test-timestamp-clamp.js scripts/test-scheduler-clock-jump.js scripts/test-health-helper.js
node scripts/verify-sync-flow.js
node scripts/verify-heartbeat-health.js
node scripts/test-flows-wiring.js
bash scripts/check-mqtt-topics.sh
```

Expected: all green.

- [ ] **Step 4.3: Record the Task-0 finding + 5.2 coupling in the PR body:**
  - The verified §2 state: "`last_triggered_at` populated but NOT enforced as a debounce; NO backward-jump guard active today — this item adds the decision-node debounce."
  - The forward-jump decision: never backfill (farmer safety); the stateless daily cron already doesn't backfill, this is made explicit and the skip is visible via the heartbeat clock/RTC field.
  - The RTC caveat (spec §C): CI has no `/sys/class/rtc/rtc0`; the on-Pi RTC read is verified in the 5.2 rig / operator rehearsal, not CI. `/sys/class/rtc/rtc0` is the standard Pi 5 node but the RV3028 overlay/driver must be present — the field reports `false` (or `null` on error) if absent, per §C's "if unavailable, reports no RTC."
  - **5.2 coupling:** Scenario 2 of the chaos/soak rig (5.2) is this item's clock-jump regression rehearsal — 5.6 builds the behavior, 5.2 proves it.

- [ ] **Step 4.4: Push + open PR (do not merge)**

```bash
git push -u origin feat/56-time-integrity
gh pr create --title "feat(time): timestamp clamp + scheduler clock-jump safety + RTC health (5.6, DD18)" \
  --body "Refactor-program 5.6 (DD18). (A) Edge-ingest timestamp clamp to [2024-01-01, now+1h] with clamp-and-log (node Build SQL INSERT). (B) Scheduler backward-jump debounce via last_triggered_at (VERIFIED ABSENT today — this adds the guard, in the decision node) preventing double-fire, with the normal daily fire preserved (regression check); forward jump never backfills (farmer safety, stateless daily cron). (C) rtc_present/clock_source in the heartbeat via osi-health-helper (fail-soft, both profiles). Every flows edit is roundtrip-guarded, both-profile byte-identical, and the two edited uncovered scheduler/ingest nodes get vm.Script compile checks in verify-sync-flow.js. No boot-node change, no NTP reconfig, no missed-window catch-up. 5.2 Scenario 2 is the clock-jump regression net. Do not merge without review." --draft
```

---

## Verification checklist (before marking done)

- [ ] Task 0 done FIRST: the current scheduler guard state verified + recorded (last_triggered_at populated, NOT enforced; no backward-jump guard active).
- [ ] Clamp: implausible device timestamps (1970/2099/epoch/garbage/beyond +1h/below FLOOR) clamped to `now` + logged; plausible + FLOOR-boundary + within-skew pass; `node --test scripts/test-timestamp-clamp.js` green against the REAL node text.
- [ ] Scheduler backward-jump: `sameLogicalWindow` debounce in the decision node suppresses a same-day re-fire (no actuator cmd, no `last_triggered_at` write, SKIP logged) and does NOT break the normal daily fire (yesterday's `last_triggered_at` still fires) — the regression check passes.
- [ ] Forward jump: no code path backfills a missed window (stateless cron); skip visible via the heartbeat clock/RTC field, not a silent catch-up.
- [ ] RTC: `rtc_present`/`clock_source` in `osi-health-helper` (fail-soft, injectable path/runner), surfaced in `Build Heartbeat`, asserted by `verify-heartbeat-health.js`; helper + flows both-profile parity.
- [ ] FLOWS LAW honored: every edit via a one-shot roundtrip-guarded script, both profiles byte-identical (`verify-profile-parity.js`), element-targeted; both edited scheduler/ingest nodes (`9b3afb405207302e`, `5f0d2b7e9b9b1b3a`) get `vm.Script` compile checks in `verify-sync-flow.js`.
- [ ] `verify-sync-flow.js` / `test-flows-wiring.js` / `check-mqtt-topics.sh` all green after each flows edit; new tests wired into `migrations.yml`.
- [ ] No boot-node change, no NTP reconfig, no missed-window catch-up, no server-side change; PR open, not merged. 5.2 coupling recorded.
