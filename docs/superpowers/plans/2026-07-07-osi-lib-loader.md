# osi-lib Loader + Fail-Visible Quarantine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution notes:** (1) work inside a feature branch `feat/osi-lib-loader` (worktree recommended, not the root `main` checkout); (2) `flows.json` edits are made ONLY via the one-shot Node script in Task 4 per `.claude/skills/osi-flows-json-editing/SKILL.md` — never by hand, never by a text-replacement tool; the roundtrip guard runs before AND after the mutation; (3) every file under `conf/` changes in **both** profiles (`full_raspberrypi_bcm27xx_bcm2712` canonical, `full_raspberrypi_bcm27xx_bcm2709` mirror) in the same commit — `verify-profile-parity.js` parity-checks `files/usr/share/node-red` (whole dir), `files/etc/uci-defaults/98_osi_node_red_seed`, and `files/usr/share/flows.json`; (4) run every command from the repo/worktree root; (5) CI must stay green at every commit — **mind the Task 4 assertion-flip ordering** (see Task 4 header).
> **Spec:** [`docs/superpowers/specs/2026-07-07-osi-lib-loader-design.md`](../specs/2026-07-07-osi-lib-loader-design.md) (approved — this plan elaborates, it does not redesign). §A–§E references point there.
> **Charter:** [`docs/architecture/refactor-program-2026.md`](../../architecture/refactor-program-2026.md) — Phase 1 Track A, item 1.A1 (DD2), retires issue #99. Precondition for items 1.A3, 2.2, 2.4, 3.1, 4.2.

**Goal:** Ship the `osi-lib` single-choke-point loader (spec §B) as a `libs`-declared module in both profiles' Node-RED runtime trees; register `osi-history-sync-helper` (and `osi-lib` itself) in all three delivery surfaces (runtime `package.json`+`package-lock.json`, `98_osi_node_red_seed` module loop, `deploy.sh` helper-fetch section); migrate the three bare-require function nodes (`Build History Batch`, `Mark History Batch ACK`, `Forward Agroscope Dendro`) onto `osiLib.require(name)` via a one-shot flows mutation; add the §D2 registration-parity verifier and the §D bare-require ratchet with test vectors; wire everything into CI. Zero bare non-builtin `require(` calls remain in either profile's flows.json when done.

**Architecture:** `osi-lib` is a pure-Node module (no deps) at `conf/<profile>/files/usr/share/node-red/osi-lib/`, loaded by function nodes through the existing `libs` mechanism (`{"var":"osiLib","module":"osi-lib"}`) exactly like `osi-db-helper`'s 126-node precedent. It resolves seam modules by short name through `NAME_TO_PATH` (relative entries joined to `OSI_LIB_BASE`, default `/srv/node-red`), caches successes, quarantines failures behind a 30 s cooldown, and returns `{ok, value}` / `{ok:false, error, quarantined?}` — never throws into the flow. Calling nodes handle `!ok` per spec §C (non-HTTP: `node.error(...)` + `return null`; the `node.error` feeds the existing Catch → Record Error → `global.error_counts` chain unchanged). The ratchet is a pure scan function in its own requireable module, *invoked from inside* `verify-sync-flow.js`'s existing run (spec §D's intent: part of the same gate, no baseline file) so it is unit-testable.

**Tech Stack:** Node.js only (`node --test`, zero new dependencies). CI: `.github/workflows/migrations.yml` (runs the `node --test` suites and the verifier scripts) and `.github/workflows/verify-sync-flow.yml` (runs `verify-sync-flow.js`, which chains profile parity). Both workflows run Node 22 (regex lookbehind fine).

## Global Constraints

- **Both profiles byte-parity for every changed file under `conf/`.** Verified 2026-07-07: the two profiles' `node-red` trees and seed scripts are currently byte-identical (`diff -rq` clean), and `flows.json`, runtime `package.json`, and `package-lock.json` all round-trip byte-identically through `JSON.stringify(x, null, 2) + '\n'` — scripted edits are safe; the roundtrip guard enforces it.
- **Frozen `sync-init-fn` untouched.** None of the three migrated nodes is on the frozen boot path; the mutation script asserts it touches exactly three node ids.
- **No SSH, no live gateways, no production hosts.** All tests run locally/CI against fixtures.
- **`deploy.sh` edits are scoped to the helper-fetch section only** (the `fetch_required` block between the settings.js fetch and the `npm install` step). The `ensure_*` schema functions, `seed_db_if_missing`, and everything else in `deploy.sh` are untouchable in this item.
- **Each commit leaves CI green.** The critical ordering: `scripts/verify-sync-flow.js:1455` positively asserts the bare-require string, and `scripts/verify-agroscope-uplink-transform.js:120-123` positively asserts the Agroscope bare-require string (finding #2 below) — **both flips land in the same commit as the flows migration (Task 4)**, or `verify-sync-flow.yml`/`migrations.yml` go red mid-task.
- Branch `feat/osi-lib-loader`, commit per task, open a PR at the end, **do not merge it**.

## Non-goals (do not do these)

- No migration of the 126 existing `libs`-declared nodes onto `osi-lib` (spec §E — convert-on-touch).
- No DD3 ratchet trio (item 1.A2), no `node --test` backfill for `osi-history-helper` (item 1.A3).
- No change to `Record Error` / `error_counts` / heartbeat `errors_total` (item 0.2 owns that surface).
- No change to `Forward Agroscope Dendro`'s feature-flag gating or the transform's logic; no rewrite of `osi-history-sync-helper` internals — load path only, behavior-preserving.
- No `settings.js` / `functionGlobalContext` change — the chosen mechanism (spec §A option b) does not need one.

## Verification findings (spec-vs-repo checks made while writing this plan)

Reported as findings, not silently patched into the spec:

1. **The spec's DoD omits `package-lock.json`.** Issue #99 names the lock file as a runtime surface, and the lock (`lockfileVersion: 3`) carries three entries per `file:` helper (root `packages[""].dependencies`, `packages["node_modules/<name>"]` link entry, `packages["<name>"]` version entry). Registering a module in `package.json` alone leaves the lock inconsistent; `deploy.sh` runs `npm install --omit=dev` against it on every deploy. Task 2 adds the lock entries (scripted, roundtrip-guarded) and Task 3's verifier checks the lock alongside the other surfaces — a strengthening elaboration, not a contradiction.
2. **A second positive bare-require assertion exists that the spec did not enumerate:** `scripts/verify-agroscope-uplink-transform.js:120-123` asserts `forwardFn.func.includes("require('/srv/node-red/codecs/agroscope_uplink_transform')")`. It is **not wired into any CI workflow** (grep across `.github/workflows/` and chained scripts: nothing runs it — it landed with PR #110 today, local-only), so CI cannot go red from it, but it must flip in Task 4's commit to keep the local verifier honest. The spec's "flip the verifier" section only names `verify-sync-flow.js:1455`.
3. **Spec §D says the ratchet extends "the same file" (`verify-sync-flow.js`); this plan puts the scan function in a small requireable module (`scripts/flows-bare-require-scan.js`) invoked from `verify-sync-flow.js`.** Reason: `verify-sync-flow.js` executes top-to-bottom at require time and cannot be imported by a test without running the whole gate — but the spec *also* mandates test vectors for the false-positive class. The assertion still runs inside the `verify-sync-flow` gate (spec intent — no new baseline-file verifier, no separate CI entry for the scan itself); only the function's home differs, for testability.
4. **`NAME_TO_PATH` must be exported** (spec §B exports only `{ require }`) so Task 3's verifier and the tests can enumerate registered seam modules without regex-parsing source. Behavior unchanged; export widened to `{ require, NAME_TO_PATH }`.
5. **Positive pins are replaced, not just deleted.** The spec says line 1455 "is deleted"; this plan *replaces* it with the equivalent positive assertion of the new pattern (`osiLib.require('history-sync')`) so the migration itself stays pinned, and does the same in the Agroscope verifier (plus a `libs`-entry assertion). Strictly additive to the spec's intent.
6. Current-state facts pinned for the mutation script: both flows copies are 572 nodes / 1,291,698 bytes and roundtrip byte-identical (re-verified 2026-07-10 on `origin/main` @ `eed4f57b`, after PRs #113 settings + #114 field-to-pr merged; the +8 nodes vs the 2026-07-07 `590aef03` baseline of 564 are unrelated Settings/field-request nodes — the mutation is ID-based and unaffected: the 3 target node bodies are byte-unchanged, still exactly 3 bare-require offenders total, and the `verify-sync-flow.js:1455` assertion is intact). The two history nodes carry `libs: [{"var":"osiDb","module":"osi-db-helper"}]`; the Agroscope node carries `libs: []`; `scripts/test-flows-wiring.js` has no assertions touching the three nodes; the wiring audit's module list (`osiDb`, `osiCloudHttp`, `chameleon`, `dendro`) does not include `osiLib` (Task 5 adds it only to `verify-sync-flow.js`'s `GUARDED_MODULE_VARS`).

## File Structure (all changes)

- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-lib/{index.js,package.json,index.test.js}` (T1)
- Create (both profiles): `conf/<profile>/files/usr/share/node-red/osi-history-sync-helper/package.json` (T2)
- Modify (both profiles): `conf/<profile>/files/usr/share/node-red/package.json`, `.../package-lock.json`, `conf/<profile>/files/etc/uci-defaults/98_osi_node_red_seed` (T2)
- Modify: `deploy.sh` (helper-fetch section only: two new `fetch_required` pairs) (T2)
- Create: `scripts/verify-helper-registration.js` + `scripts/verify-helper-registration.test.js` (T3)
- Modify (both profiles): `conf/<profile>/files/usr/share/flows.json` — nodes `sync-history-build`, `sync-history-mark`, `agroscope-forward-fn` only (T4)
- Modify: `scripts/verify-sync-flow.js` (line-1455 assertion flip in T4; ratchet call + `GUARDED_MODULE_VARS` in T5), `scripts/verify-agroscope-uplink-transform.js` (assertion flip, T4)
- Create: `scripts/flows-bare-require-scan.js` + `scripts/flows-bare-require-scan.test.js` (T5)
- Modify: `.github/workflows/migrations.yml` (T5), `docs/architecture/refactor-program-2026.md` (T6)

---

### Task 1: `osi-lib` module + co-located `node --test` suite

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js` (first), then `index.js`, `package.json`; copy dir to bcm2709.

**Interfaces:**
- Produces: `require('osi-lib')` → `{ require(name) → {ok:true,value} | {ok:false,error,quarantined?}, NAME_TO_PATH }`. Env overrides `OSI_LIB_BASE` (default `/srv/node-red`) and `OSI_LIB_COOLDOWN_MS` (default `30000`), read once at module load.
- Consumed by: the three migrated nodes (T4), every future seam extraction (spec §E), `verify-helper-registration.js` (T3, reads `NAME_TO_PATH`).

- [ ] **Step 1.1: Write the failing test suite** — create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js` with exactly:

```js
'use strict';
// Co-located tests for osi-lib (refactor-program 1.A1, spec §B).
// Env overrides MUST be set before the module is first required —
// BASE/COOLDOWN_MS are read once at load.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const FIXTURE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-lib-test-'));
process.env.OSI_LIB_BASE = FIXTURE_BASE;
process.env.OSI_LIB_COOLDOWN_MS = '80';

const osiLib = require('./index');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test('NAME_TO_PATH is exported and lists the two launch entries', () => {
  assert.deepEqual(Object.keys(osiLib.NAME_TO_PATH).sort(), [
    'agroscope-uplink-transform',
    'history-sync',
  ]);
  assert.equal(osiLib.NAME_TO_PATH['history-sync'], 'osi-history-sync-helper');
  assert.equal(osiLib.NAME_TO_PATH['agroscope-uplink-transform'], 'codecs/agroscope_uplink_transform');
});

test('unknown name returns a typed failure, never throws', () => {
  const r = osiLib.require('no-such-module');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown osi-lib module: no-such-module/);
});

test('load success returns the module and caches it', () => {
  fs.writeFileSync(path.join(FIXTURE_BASE, 'osi-history-sync-helper.js'),
    "module.exports = { marker: 'v1' };\n");
  const first = osiLib.require('history-sync');
  assert.equal(first.ok, true);
  assert.equal(first.value.marker, 'v1');
  // Overwrite on disk; the cached module must keep serving (success is cached).
  fs.writeFileSync(path.join(FIXTURE_BASE, 'osi-history-sync-helper.js'),
    "module.exports = { marker: 'v2' };\n");
  const second = osiLib.require('history-sync');
  assert.equal(second.ok, true);
  assert.equal(second.value.marker, 'v1');
});

test('load failure -> cooldown quarantine -> retry succeeds after expiry', async () => {
  // codecs/agroscope_uplink_transform does not exist yet in the fixture base.
  const first = osiLib.require('agroscope-uplink-transform');
  assert.equal(first.ok, false);
  assert.equal(first.quarantined, undefined); // a real load attempt, not a cooldown skip
  assert.match(first.error, /Cannot find module/);
  // Immediately again: cooldown must answer without re-attempting the fs load.
  const during = osiLib.require('agroscope-uplink-transform');
  assert.equal(during.ok, false);
  assert.equal(during.quarantined, true);
  assert.match(during.error, /quarantined, retry after cooldown/);
  // Fix the underlying cause, wait out the 80 ms test cooldown, retry succeeds.
  fs.mkdirSync(path.join(FIXTURE_BASE, 'codecs'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_BASE, 'codecs', 'agroscope_uplink_transform.js'),
    "module.exports = { toAgroscopeUplink: () => null };\n");
  await sleep(120);
  const after = osiLib.require('agroscope-uplink-transform');
  assert.equal(after.ok, true);
  assert.equal(typeof after.value.toAgroscopeUplink, 'function');
});

test('result-object shape: success has ok+value only; failure has ok+error', () => {
  const ok = osiLib.require('history-sync');
  assert.deepEqual(Object.keys(ok).sort(), ['ok', 'value']);
  const bad = osiLib.require('no-such-module');
  assert.deepEqual(Object.keys(bad).sort(), ['error', 'ok']);
});
```

- [ ] **Step 1.2: Run it — expect FAIL** (module does not exist yet):

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
```
Expected: `Cannot find module './index'` — every test errors, exit non-zero.

- [ ] **Step 1.3: Implement** — create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js` with exactly:

```js
'use strict';
// osi-lib — single-choke-point loader for extracted seam modules with
// fail-visible quarantine (refactor-program item 1.A1, DD2; retires #99).
// Spec: docs/superpowers/specs/2026-07-07-osi-lib-loader-design.md (§B, §C).
// Pure Node, zero runtime deps: this module must never itself fail to load.
const path = require('path');

const BASE = process.env.OSI_LIB_BASE || '/srv/node-red'; // test override; Pi default
const COOLDOWN_MS = Number(process.env.OSI_LIB_COOLDOWN_MS || 30000); // test override

// Registered seam modules. Helper-module entries (no 'codecs/' prefix) need the
// three-surface registration checked by scripts/verify-helper-registration.js;
// codec entries ride the wholesale codecs copy/fetch.
const NAME_TO_PATH = {
  'history-sync': 'osi-history-sync-helper',
  'agroscope-uplink-transform': 'codecs/agroscope_uplink_transform',
};

const cache = new Map();         // name -> loaded module (success only)
const cooldownUntil = new Map(); // name -> epoch ms of next retry attempt

function osiRequire(name) {
  if (cache.has(name)) return { ok: true, value: cache.get(name) };
  const now = Date.now();
  if (now < (cooldownUntil.get(name) || 0)) {
    return { ok: false, error: 'quarantined, retry after cooldown', quarantined: true };
  }
  const rel = NAME_TO_PATH[name];
  if (!rel) return { ok: false, error: 'unknown osi-lib module: ' + name };
  try {
    const mod = require(path.join(BASE, rel)); // eslint-disable-line global-require
    cache.set(name, mod);
    cooldownUntil.delete(name);
    return { ok: true, value: mod };
  } catch (err) {
    cooldownUntil.set(name, now + COOLDOWN_MS);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { require: osiRequire, NAME_TO_PATH };
```

and `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/package.json`:

```json
{
  "name": "osi-lib",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```

- [ ] **Step 1.4: Run the suite — expect PASS** (same command as 1.2; all 5 tests pass, exit 0).

- [ ] **Step 1.5: Mirror to bcm2709 and parity-check:**

```bash
cp -a conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib
node scripts/verify-profile-parity.js
```
Expected: ends `All parity checks passed.`, exit 0.

- [ ] **Step 1.6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib
git commit -m "feat(edge): osi-lib single-choke-point loader with quarantine + tests (refactor-program 1.A1, spec §B)"
```

---

### Task 2: Packaging registrations — `osi-lib` + `osi-history-sync-helper` across all delivery surfaces

**Files:**
- Create (both profiles): `.../node-red/osi-history-sync-helper/package.json`
- Modify (both profiles): `.../node-red/package.json`, `.../node-red/package-lock.json`, `files/etc/uci-defaults/98_osi_node_red_seed`
- Modify: `deploy.sh` (helper-fetch section ONLY)

- [ ] **Step 2.1: `osi-history-sync-helper/package.json`** — create in the bcm2712 profile with exactly:

```json
{
  "name": "osi-history-sync-helper",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```

- [ ] **Step 2.2: Runtime `package.json` + `package-lock.json` (scripted, roundtrip-guarded).** Both files round-trip byte-identically through `JSON.stringify(x, null, 2) + '\n'` (verified 2026-07-07), so a scripted JSON edit is safe. Save to scratchpad as `register-modules.js` and run from the repo root:

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const NEW_MODULES = ['osi-history-sync-helper', 'osi-lib'];
const PROFILE = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red';

function editJson(file, mutate) {
  const orig = fs.readFileSync(file);
  const parsed = JSON.parse(orig.toString('utf8'));
  const reser = Buffer.from(JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  if (Buffer.compare(orig, reser) !== 0) throw new Error('roundtrip guard failed: ' + file);
  mutate(parsed);
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
}

editJson(path.join(PROFILE, 'package.json'), (pkg) => {
  for (const name of NEW_MODULES) {
    if (pkg.dependencies[name]) throw new Error(name + ' already registered');
    pkg.dependencies[name] = 'file:' + name;
  }
});

editJson(path.join(PROFILE, 'package-lock.json'), (lock) => {
  for (const name of NEW_MODULES) {
    if (lock.packages[name]) throw new Error(name + ' already in lock');
    lock.packages[''].dependencies[name] = 'file:' + name;
    lock.packages['node_modules/' + name] = { resolved: name, link: true };
    lock.packages[name] = { version: '1.0.0' };
  }
});
console.log('package.json + package-lock.json updated (canonical profile).');
```

Expected output: the final `console.log` line, exit 0. (New keys append at the end of each JSON object — npm does not require sorted keys, and `npm install` on the Pi reconciles by name.)

- [ ] **Step 2.3: Seed script.** In `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed`, extend the module-copy loop (currently line 38). Change:

```sh
for module in osi-chameleon-helper osi-chirpstack-helper osi-cloud-http osi-db-helper osi-dendro-helper osi-history-helper osi-health-helper; do
```
to:
```sh
for module in osi-chameleon-helper osi-chirpstack-helper osi-cloud-http osi-db-helper osi-dendro-helper osi-history-helper osi-history-sync-helper osi-health-helper osi-lib; do
```

- [ ] **Step 2.4: `deploy.sh` — two `fetch_required` pairs, helper-fetch section only.** Immediately after the `osi-history-helper analysis.js` block (`fetch_required "osi-history-helper analysis.js" ...`), insert:

```bash
fetch_required "osi-history-sync-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/package.json" \
    "/srv/node-red/osi-history-sync-helper/package.json"

fetch_required "osi-history-sync-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js" \
    "/srv/node-red/osi-history-sync-helper/index.js"
```

Immediately after the `osi-cloud-http index.js` block, insert:

```bash
fetch_required "osi-lib package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/package.json" \
    "/srv/node-red/osi-lib/package.json"

fetch_required "osi-lib index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js" \
    "/srv/node-red/osi-lib/index.js"
```

Do NOT touch anything outside the helper-fetch section (no `ensure_*`, no `seed_db_if_missing`, no npm-install step).

- [ ] **Step 2.5: Mirror all bcm2712 changes to bcm2709:**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package.json
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package-lock.json
mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/package.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-sync-helper/package.json
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed
```

- [ ] **Step 2.6: Verify + commit:**

```bash
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json','utf8')); console.log('lock parses')"
node scripts/verify-profile-parity.js   # expect: All parity checks passed.
node scripts/verify-sync-flow.js        # expect: unchanged, ends All parity checks passed.
git add -A conf deploy.sh
git commit -m "feat(edge): register osi-lib + osi-history-sync-helper in package.json/lock, seed loop, deploy.sh (refactor-program 1.A1, spec §A; closes the #99 delivery gap)"
```

---

### Task 3: `scripts/verify-helper-registration.js` (§D2) — root-cause-class gate

Written now — before the flows migration — so it gates Task 2's completeness: if any surface was missed, this goes red here, not in the field.

**Files:**
- Create: `scripts/verify-helper-registration.test.js` (first), then `scripts/verify-helper-registration.js`.

**Interfaces:**
- Exports (pure, for tests): `collectHelperNames({packageJson, nameToPath}) → string[]`; `checkSurfaces({name, packageJson, packageLock, seedSource, deploySource, moduleDir}) → issues[]`; `checkCodecs({nameToPath, deploySource, codecsDir}) → issues[]`.
- CLI (`require.main`): scans both profiles + `deploy.sh`; prints `OK`/`FAIL` lines; exit 0 iff no issues.

- [ ] **Step 3.1: Write the failing test** — create `scripts/verify-helper-registration.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectHelperNames, checkSurfaces, checkCodecs } = require('./verify-helper-registration');

const NAME_TO_PATH = {
  'history-sync': 'osi-history-sync-helper',
  'agroscope-uplink-transform': 'codecs/agroscope_uplink_transform',
};

function fixtures(overrides = {}) {
  return {
    name: 'osi-history-sync-helper',
    packageJson: { dependencies: { 'osi-history-sync-helper': 'file:osi-history-sync-helper' } },
    packageLock: { packages: {
      '': { dependencies: { 'osi-history-sync-helper': 'file:osi-history-sync-helper' } },
      'node_modules/osi-history-sync-helper': { resolved: 'osi-history-sync-helper', link: true },
      'osi-history-sync-helper': { version: '1.0.0' },
    } },
    seedSource: 'for module in osi-db-helper osi-history-sync-helper osi-lib; do\n',
    deploySource: [
      '"/srv/node-red/osi-history-sync-helper/package.json"',
      '"/srv/node-red/osi-history-sync-helper/index.js"',
    ].join('\n'),
    moduleDir: { hasDir: true, hasPackageJson: true, hasMain: true, mainName: 'index.js' },
    ...overrides,
  };
}

test('collectHelperNames: unions file: deps with non-codec NAME_TO_PATH values', () => {
  const names = collectHelperNames({
    packageJson: { dependencies: { bcryptjs: '3.0.3', 'osi-db-helper': 'file:osi-db-helper' } },
    nameToPath: NAME_TO_PATH,
  });
  assert.deepEqual(names, ['osi-db-helper', 'osi-history-sync-helper']); // codec entry excluded
});

test('checkSurfaces: fully registered helper produces no issues', () => {
  assert.deepEqual(checkSurfaces(fixtures()), []);
});

test('checkSurfaces: each missing surface is reported', () => {
  assert.match(checkSurfaces(fixtures({ packageJson: { dependencies: {} } })).join(' '), /runtime package\.json/);
  assert.match(checkSurfaces(fixtures({ packageLock: { packages: { '': { dependencies: {} } } } })).join(' '), /package-lock\.json/);
  assert.match(checkSurfaces(fixtures({ seedSource: 'for module in osi-db-helper; do\n' })).join(' '), /98_osi_node_red_seed/);
  assert.match(checkSurfaces(fixtures({ deploySource: '' })).join(' '), /deploy\.sh/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: false } })).join(' '), /directory missing/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: true, hasPackageJson: false, hasMain: true, mainName: 'index.js' } })).join(' '), /package\.json missing/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: true, hasPackageJson: true, hasMain: false, mainName: 'index.js' } })).join(' '), /main file/);
});

test('checkCodecs: codec entries need a deploy.sh fetch line + the file on disk', () => {
  const issues = checkCodecs({ nameToPath: NAME_TO_PATH, deploySource: '', codecsDir: '/nonexistent' });
  assert.equal(issues.length, 2);
  assert.match(issues[0], /agroscope_uplink_transform\.js.*deploy\.sh/);
  assert.match(issues[1], /agroscope_uplink_transform\.js.*missing under/);
});
```

- [ ] **Step 3.2: Run — expect FAIL** (`Cannot find module './verify-helper-registration'`):

```bash
node --test scripts/verify-helper-registration.test.js
```

- [ ] **Step 3.3: Implement** — create `scripts/verify-helper-registration.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// verify-helper-registration — refactor-program 1.A1, spec §D2.
// Closes issue #99's root-cause CLASS at merge time: a helper module that exists
// in the tree but is unregistered in any delivery surface fails CI here, so the
// next seam module cannot repeat #99. Helper modules (runtime package.json
// `file:` deps ∪ non-codec osi-lib NAME_TO_PATH entries) need all three surfaces;
// codec NAME_TO_PATH entries ride the wholesale codecs copy and only need their
// deploy.sh fetch line + the file on disk.
const fs = require('fs');
const path = require('path');

const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712',
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];

function collectHelperNames({ packageJson, nameToPath }) {
  const names = new Set();
  for (const [dep, spec] of Object.entries(packageJson.dependencies || {})) {
    if (String(spec).startsWith('file:')) names.add(dep);
  }
  for (const rel of Object.values(nameToPath)) {
    if (!rel.startsWith('codecs/')) names.add(rel);
  }
  return [...names].sort();
}

function checkSurfaces({ name, packageJson, packageLock, seedSource, deploySource, moduleDir }) {
  const issues = [];
  if ((packageJson.dependencies || {})[name] !== 'file:' + name) {
    issues.push(name + ': missing "file:' + name + '" dep in runtime package.json');
  }
  const pkgs = (packageLock.packages || {});
  if (!(((pkgs[''] || {}).dependencies || {})[name])) {
    issues.push(name + ': missing root dependency entry in package-lock.json');
  }
  if (!pkgs['node_modules/' + name]) {
    issues.push(name + ': missing node_modules link entry in package-lock.json');
  }
  const loop = seedSource.match(/^for module in (.+); do$/m);
  if (!loop || !loop[1].split(/\s+/).includes(name)) {
    issues.push(name + ': missing from 98_osi_node_red_seed module-copy loop');
  }
  if (!deploySource.includes('/srv/node-red/' + name + '/package.json')) {
    issues.push(name + ': missing package.json fetch_required in deploy.sh');
  }
  if (!deploySource.includes('/srv/node-red/' + name + '/index.js')) {
    issues.push(name + ': missing index.js fetch_required in deploy.sh');
  }
  if (!moduleDir.hasDir) {
    issues.push(name + ': module directory missing');
    return issues;
  }
  if (!moduleDir.hasPackageJson) issues.push(name + ': module package.json missing');
  if (!moduleDir.hasMain) issues.push(name + ': declared main file (' + moduleDir.mainName + ') missing');
  return issues;
}

function checkCodecs({ nameToPath, deploySource, codecsDir }) {
  const issues = [];
  for (const rel of Object.values(nameToPath)) {
    if (!rel.startsWith('codecs/')) continue;
    const file = rel.slice('codecs/'.length) + '.js';
    if (!deploySource.includes('/srv/node-red/codecs/' + file)) {
      issues.push('codec ' + file + ': missing fetch_required in deploy.sh');
    }
    if (!fs.existsSync(path.join(codecsDir, file))) {
      issues.push('codec ' + file + ': missing under ' + codecsDir);
    }
  }
  return issues;
}

function inspectModuleDir(nodeRedDir, name) {
  const dir = path.join(nodeRedDir, name);
  if (!fs.existsSync(dir)) return { hasDir: false };
  let mainName = 'index.js';
  let hasPackageJson = false;
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    hasPackageJson = true;
    try { mainName = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main || 'index.js'; } catch (_) {}
  }
  return { hasDir: true, hasPackageJson, hasMain: fs.existsSync(path.join(dir, mainName)), mainName };
}

function run() {
  const repo = path.resolve(__dirname, '..');
  const deploySource = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const nameToPath = require(path.join(repo, PROFILES[0], 'files/usr/share/node-red/osi-lib')).NAME_TO_PATH;
  const failures = [];
  for (const profile of PROFILES) {
    const nodeRedDir = path.join(repo, profile, 'files/usr/share/node-red');
    const packageJson = JSON.parse(fs.readFileSync(path.join(nodeRedDir, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(nodeRedDir, 'package-lock.json'), 'utf8'));
    const seedSource = fs.readFileSync(path.join(repo, profile, 'files/etc/uci-defaults/98_osi_node_red_seed'), 'utf8');
    for (const name of collectHelperNames({ packageJson, nameToPath })) {
      const issues = checkSurfaces({
        name, packageJson, packageLock, seedSource, deploySource,
        moduleDir: inspectModuleDir(nodeRedDir, name),
      });
      if (issues.length) failures.push(...issues.map((i) => '[' + profile + '] ' + i));
      else console.log('OK [' + profile + '] ' + name);
    }
    const codecIssues = checkCodecs({ nameToPath, deploySource, codecsDir: path.join(nodeRedDir, 'codecs') });
    if (codecIssues.length) failures.push(...codecIssues.map((i) => '[' + profile + '] ' + i));
    else console.log('OK [' + profile + '] codec NAME_TO_PATH entries');
  }
  if (failures.length) {
    for (const f of failures) console.error('FAIL ' + f);
    process.exit(1);
  }
  console.log('All helper-registration checks passed.');
}

if (require.main === module) run();
module.exports = { collectHelperNames, checkSurfaces, checkCodecs };
```

- [ ] **Step 3.4: Run — expect PASS on both fronts:**

```bash
node --test scripts/verify-helper-registration.test.js   # all tests pass
node scripts/verify-helper-registration.js               # per-helper OK lines for BOTH profiles
                                                          # (9 helpers × 2 profiles + 2 codec lines),
                                                          # ends: All helper-registration checks passed.
```
If the CLI run is red, Task 2 missed a surface — fix Task 2, do not weaken the verifier.

- [ ] **Step 3.5: Commit**

```bash
git add scripts/verify-helper-registration.js scripts/verify-helper-registration.test.js
git commit -m "feat(ci): verify-helper-registration gate — three-surface parity for helper modules (refactor-program 1.A1, spec §D2)"
```

---

### Task 4: Flows migration — the three bare-require nodes onto `osiLib.require`

**Files:**
- Modify (via mutation script, both profiles): `conf/<profile>/files/usr/share/flows.json` — exactly nodes `sync-history-build`, `sync-history-mark`, `agroscope-forward-fn`.
- Modify (same commit — CI ordering): `scripts/verify-sync-flow.js` (the line-1455 positive assertion flips to the new pattern), `scripts/verify-agroscope-uplink-transform.js` (lines 120–123 assertion flips; finding #2).

**Commit boundary decision:** the flows mutation and both verifier assertion flips land in ONE commit. `verify-sync-flow.js:1455` currently asserts the bare-require string is PRESENT — migrating the nodes without flipping it turns `verify-sync-flow.yml` and `migrations.yml` red; flipping it first without the migration is equally red. There is no green two-commit ordering, so they are atomic by necessity.

- [ ] **Step 4.1: Write the mutation script** — save to the scratchpad (NOT the repo) as `migrate-bare-requires.js`, complete content:

```js
#!/usr/bin/env node
// One-shot flows.json migration: three bare-require nodes -> osiLib.require
// (refactor-program 1.A1, spec §A migration). Run from the repo root.
// Follows .claude/skills/osi-flows-json-editing/SKILL.md: roundtrip guard
// before AND after, both profiles written in the same run.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}
function assertRoundtripByteIdentical(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) {
    throw new Error('Roundtrip guard failed for ' + filePath + ' — STOP, formatting drifted.');
  }
  return parsed;
}
function byId(flows, id) {
  const n = flows.find((x) => x && x.id === id);
  if (!n) throw new Error('missing node ' + id);
  return n;
}
function replaceOnce(node, from, to) {
  const count = node.func.split(from).length - 1;
  if (count !== 1) throw new Error('expected exactly 1 occurrence of the target block in "' + node.name + '", found ' + count);
  node.func = node.func.replace(from, to);
}
function addOsiLibEntry(node) {
  node.libs = Array.isArray(node.libs) ? node.libs : [];
  if (node.libs.some((l) => l && l.var === 'osiLib')) throw new Error(node.name + ' already declares osiLib');
  node.libs.push({ var: 'osiLib', module: 'osi-lib' });
}

const flows = assertRoundtripByteIdentical(CANONICAL);
console.log('Roundtrip guard OK. Node count:', flows.length);

// --- 1+2: Build History Batch / Mark History Batch ACK -----------------------
// Old line is the first statement inside the async IIFE, before the node's try{.
const HISTORY_OLD = "const helper = require('/usr/share/node-red/osi-history-sync-helper');";
for (const [id, label] of [
  ['sync-history-build', 'Build History Batch'],
  ['sync-history-mark', 'Mark History Batch ACK'],
]) {
  const node = byId(flows, id);
  if (node.name !== label) throw new Error(id + ' name drifted: ' + node.name);
  replaceOnce(node, HISTORY_OLD, [
    "const helperLoad = osiLib.require('history-sync');",
    'if (!helperLoad.ok) {',
    "  node.error('" + label + " helper unavailable: ' + helperLoad.error, msg);",
    '  return null;',
    '}',
    'const helper = helperLoad.value;',
  ].join('\n'));
  addOsiLibEntry(node); // alongside the existing osiDb entry
}

// --- 3: Forward Agroscope Dendro ---------------------------------------------
const AGRO_OLD = [
  'let transform;',
  'try {',
  "  transform = require('/srv/node-red/codecs/agroscope_uplink_transform');",
  '} catch (error) {',
  "  node.error('Agroscope transform unavailable: ' + error.message, msg);",
  '  return null;',
  '}',
].join('\n');
const AGRO_NEW = [
  "const transformLoad = osiLib.require('agroscope-uplink-transform');",
  'if (!transformLoad.ok) {',
  "  node.error('Agroscope transform unavailable: ' + transformLoad.error, msg);",
  '  return null;',
  '}',
  'const transform = transformLoad.value;',
].join('\n');
const agro = byId(flows, 'agroscope-forward-fn');
if (agro.name !== 'Forward Agroscope Dendro') throw new Error('agroscope-forward-fn name drifted');
replaceOnce(agro, AGRO_OLD, AGRO_NEW);
addOsiLibEntry(agro); // libs was []

// --- Postconditions -----------------------------------------------------------
// (a) zero bare non-builtin requires remain anywhere in the flows
const NODE_BUILTINS = new Set(require('module').builtinModules);
const BARE = /(?<![\w$.])require\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const n of flows) {
  if (n.type !== 'function') continue;
  for (const m of String(n.func || '').matchAll(BARE)) {
    if (!NODE_BUILTINS.has(m[1])) {
      throw new Error('bare require survives in "' + n.name + '": ' + m[1]);
    }
  }
}
// (b) frozen boot node untouched (defence in depth: we never selected it)
const syncInit = byId(flows, 'sync-init-fn');
if (JSON.stringify(syncInit).includes('osiLib')) throw new Error('sync-init-fn was modified');

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtripByteIdentical(CANONICAL);
assertRoundtripByteIdentical(MIRROR);
console.log('Migrated 3 nodes; wrote canonical + mirror; post-write roundtrip OK.');
```

- [ ] **Step 4.2: Run it:**

```bash
node /tmp/claude-*/…/scratchpad/migrate-bare-requires.js   # use the actual scratchpad path
```
Expected: `Roundtrip guard OK. Node count: 572` (the printed count is informational, not asserted — it will differ if the flows grew again; only a *thrown* error indicates real drift) then `Migrated 3 nodes; wrote canonical + mirror; post-write roundtrip OK.` Any thrown error = a pinned assumption drifted (a target node id/name/body changed, or the target block occurs ≠1 time); STOP and re-verify against the spec, do not force.

- [ ] **Step 4.3: Flip the two positive assertions (same commit).**

In `scripts/verify-sync-flow.js`, line 1455 — change:

```js
expectIncludes('Build History Batch', "require('/usr/share/node-red/osi-history-sync-helper')", 'loads history sync helper');
```
to:
```js
expectIncludes('Build History Batch', "osiLib.require('history-sync')", 'loads history sync helper via osi-lib');
expectIncludes('Mark History Batch ACK', "osiLib.require('history-sync')", 'marks history batches via the osi-lib-loaded helper');
```

In `scripts/verify-agroscope-uplink-transform.js`, lines 120–123 — change:

```js
assert.ok(
  forwardFn.func.includes("require('/srv/node-red/codecs/agroscope_uplink_transform')"),
  'forward branch loads the pure transform'
);
```
to:
```js
assert.ok(
  forwardFn.func.includes("osiLib.require('agroscope-uplink-transform')"),
  'forward branch loads the pure transform via osi-lib'
);
assert.ok(
  (forwardFn.libs || []).some((lib) => lib && lib.var === 'osiLib' && lib.module === 'osi-lib'),
  'forward node declares osiLib in libs'
);
```

- [ ] **Step 4.4: Full flows pre-commit checklist** (per the skill; all from repo root):

```bash
node scripts/verify-profile-parity.js        # All parity checks passed.
node scripts/verify-sync-flow.js             # green incl. the flipped assertions; ends All parity checks passed.
bash scripts/check-mqtt-topics.sh            # three OK lines (MQTT IN nodes untouched)
node scripts/test-flows-wiring.js            # PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed
node scripts/verify-no-new-silent-catch.js   # green (the removed Agroscope try/catch contained node.error — not a silent catch; removal cannot add one)
node scripts/verify-agroscope-uplink-transform.js   # green with the flipped assertion (local-only verifier, not in CI — finding #2)
git status --short                           # BOTH flows.json paths + the two verifier scripts, nothing else
```

- [ ] **Step 4.5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js scripts/verify-agroscope-uplink-transform.js
git commit -m "fix(edge): migrate 3 bare-require nodes onto osiLib.require; flip positive require assertions (refactor-program 1.A1, spec §A/§C; fixes #99 dead history-sync path)"
```

---

### Task 5: Bare-require ratchet (§D) + CI wiring

**Files:**
- Create: `scripts/flows-bare-require-scan.test.js` (first), then `scripts/flows-bare-require-scan.js`.
- Modify: `scripts/verify-sync-flow.js` (invoke the scan; add `osiLib` to `GUARDED_MODULE_VARS`), `.github/workflows/migrations.yml`.

- [ ] **Step 5.1: Write the failing test-vector suite** — create `scripts/flows-bare-require-scan.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanFunctionNodes } = require('./flows-bare-require-scan');

const fn = (name, func) => ({ id: name, type: 'function', name, func });

test('migrated node body (osiLib.require) PASSES — the false-positive class stays pinned', () => {
  const flows = [fn('Build History Batch',
    "return (async()=>{\nconst helperLoad = osiLib.require('history-sync');\nif (!helperLoad.ok) { node.error('x: ' + helperLoad.error, msg); return null; }\nconst helper = helperLoad.value;\n})();")];
  assert.deepEqual(scanFunctionNodes(flows), []);
});

test('synthetic bare-require body FAILS', () => {
  const flows = [fn('Bad Node', "const helper = require('/srv/node-red/x');\nreturn msg;")];
  assert.deepEqual(scanFunctionNodes(flows), [{ node: 'Bad Node', spec: '/srv/node-red/x' }]);
});

test('Node builtins are exempt', () => {
  const flows = [fn('Crypto Node', "const crypto = require('crypto');\nconst path = require('node:path');\nreturn msg;")];
  assert.deepEqual(scanFunctionNodes(flows), []);
});

test('member-access and identifier-suffix calls never match', () => {
  const flows = [fn('Edge Cases', "module.require('x'); myrequire('y'); a.b.require('z');")];
  assert.deepEqual(scanFunctionNodes(flows), []);
});

test('non-function nodes and empty funcs are skipped', () => {
  assert.deepEqual(scanFunctionNodes([{ id: 't', type: 'tab' }, fn('Empty', '')]), []);
});

test('multiple offenders in one body are all reported', () => {
  const flows = [fn('Two Bads', "require('/a'); require('/b');")];
  assert.equal(scanFunctionNodes(flows).length, 2);
});
```

- [ ] **Step 5.2: Run — expect FAIL** (`Cannot find module './flows-bare-require-scan'`):

```bash
node --test scripts/flows-bare-require-scan.test.js
```

- [ ] **Step 5.3: Implement** — create `scripts/flows-bare-require-scan.js` with exactly:

```js
'use strict';
// Bare-require ratchet for flows.json function nodes (refactor-program 1.A1, spec §D).
// osi-lib (libs-declared) is the only sanctioned path to an in-repo module; a bare
// require() of anything but a Node.js builtin is the #99 failure class and fails CI.
// The (?<![\w$.]) lookbehind is load-bearing: without it, the substring
// require('history-sync') inside osiLib.require('history-sync') would match and the
// ratchet would fail the very nodes item 1.A1 migrated. Pinned by the co-located tests.
// Invoked from verify-sync-flow.js (part of that gate — deliberately not a separate
// baseline-file verifier; spec §D). Baseline at introduction: zero offenders.
const { builtinModules } = require('module');

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => 'node:' + m)]);
const BARE_REQUIRE_PATTERN = /(?<![\w$.])require\(\s*['"]([^'"]+)['"]\s*\)/g;

function scanFunctionNodes(flows) {
  const findings = [];
  for (const node of flows) {
    if (!node || node.type !== 'function') continue;
    for (const m of String(node.func || '').matchAll(BARE_REQUIRE_PATTERN)) {
      if (NODE_BUILTINS.has(m[1])) continue;
      findings.push({ node: node.name || node.id, spec: m[1] });
    }
  }
  return findings;
}

module.exports = { scanFunctionNodes };
```

- [ ] **Step 5.4: Run — expect PASS** (same command as 5.2; all 6 tests pass).

- [ ] **Step 5.5: Wire into `verify-sync-flow.js`.** Two edits:

(a) Immediately after the `GUARDED_MODULE_VARS` loop's closing `console.log('OK every function node that uses a guarded module has it bound');` (~line 1229), insert:

```js
// Bare-require ratchet (refactor-program 1.A1, spec §D): no function node may
// bare-require a non-builtin. Scan logic + test vectors live in
// scripts/flows-bare-require-scan.js; canonical flows only (profile parity
// guarantees the mirror is byte-identical).
const { scanFunctionNodes } = require('./flows-bare-require-scan');
for (const finding of scanFunctionNodes(flows)) {
  fail(`function node ${finding.node} bare-requires '${finding.spec}' — load via osiLib.require(...) declared in libs (see docs/superpowers/specs/2026-07-07-osi-lib-loader-design.md)`);
}
console.log('OK no function node bare-requires a non-builtin module');
```

(b) In `GUARDED_MODULE_VARS` (~line 1210), extend the project-helpers line:

```js
  'osiDb', 'osiCloudHttp', 'chameleon', 'dendro', 'chirpstack', 'bcrypt', 'sqlite3', 'osiLib',
```
(so any node calling `osiLib.require(...)` without declaring `osiLib` in `libs` fails the existing guard — the exact `get-actuations-auth` failure class, now covered for the loader itself).

- [ ] **Step 5.6: Wire the new tests/verifiers into CI.** In `.github/workflows/migrations.yml`: extend the existing multi-file `node --test` line with the two new test files, and add two run lines after `- run: node scripts/verify-heartbeat-health.js`:

```yaml
      - run: node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js scripts/verify-no-stray-ddl.test.js scripts/verify-no-new-silent-catch.test.js scripts/test-error-recording-flow.js scripts/flows-bare-require-scan.test.js scripts/verify-helper-registration.test.js
```
```yaml
      - run: node scripts/verify-helper-registration.js
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
```
(The bare-require scan itself needs no CI entry — it runs inside `verify-sync-flow.js`, already in both workflows. The osi-lib suite runs against the canonical profile only; parity guarantees the mirror.)

- [ ] **Step 5.7: Verify + commit:**

```bash
node scripts/verify-sync-flow.js    # green: new "OK no function node bare-requires..." line appears; ends All parity checks passed.
node --test scripts/flows-bare-require-scan.test.js scripts/verify-helper-registration.test.js
git add scripts/flows-bare-require-scan.js scripts/flows-bare-require-scan.test.js scripts/verify-sync-flow.js .github/workflows/migrations.yml
git commit -m "feat(ci): bare-require ratchet + osiLib libs-guard + CI wiring for 1.A1 suites (refactor-program 1.A1, spec §D)"
```

---

### Task 6: Full gate, program-doc update, PR

- [ ] **Step 6.1: Full local CI-equivalent run** (every command must be green):

```bash
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js scripts/verify-no-stray-ddl.test.js scripts/verify-no-new-silent-catch.test.js scripts/test-error-recording-flow.js scripts/flows-bare-require-scan.test.js scripts/verify-helper-registration.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node scripts/test-history-helper.js && node --test scripts/test-health-helper.js
node scripts/verify-migrations.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-seed-replay.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-devices-rebuild-fence.js && node scripts/verify-heartbeat-health.js
node scripts/verify-helper-registration.js
node scripts/verify-agroscope-uplink-transform.js
bash scripts/check-mqtt-topics.sh && node scripts/test-flows-wiring.js
```

- [ ] **Step 6.2: Update the program doc.** In `docs/architecture/refactor-program-2026.md`, Phase 1 Track A row for 1.A1, append the outcome: `— done: osi-lib loader + quarantine, 3 nodes migrated, verify-helper-registration + bare-require ratchet, PR #<FILL IN AT PR TIME>` (fill the real number once the PR exists).

```bash
git add docs/architecture/refactor-program-2026.md
git commit -m "docs(program): record 1.A1 outcome (osi-lib loader shipped)"
```

- [ ] **Step 6.3: Open the PR (do not merge):**

```bash
git push -u origin feat/osi-lib-loader
gh pr create --title "osi-lib loader + fail-visible quarantine; retire #99 (refactor-program 1.A1)" --body "$(cat <<'EOF'
## Summary
- `osi-lib` single-choke-point loader (libs-declared, `{ok,value}` result contract, 30s failure quarantine, env-injectable for tests) + co-located `node --test` suite — the DD2 mechanism every future seam extraction loads through.
- `osi-history-sync-helper` registered in ALL delivery surfaces (runtime package.json + package-lock.json, `98_osi_node_red_seed` module loop, `deploy.sh` fetch pairs) — the #99 packaging gap, closed.
- 3 bare-require nodes migrated → 0 remaining: `Build History Batch`, `Mark History Batch ACK` (were dead-on-next-deploy — helper never reached `/srv/node-red`, and the old `/usr/share` path would have pinned the image-baked version forever), `Forward Agroscope Dendro` (worked but same anti-pattern).
- Root-cause class gated: `scripts/verify-helper-registration.js` fails CI if any helper module misses any delivery surface — the next seam module cannot repeat #99 at merge time.
- Bare-require ratchet inside `verify-sync-flow.js` (scan module + test vectors pinning the `osiLib.require` false-positive class); `osiLib` added to the libs-declaration guard; positive assertions flipped (`verify-sync-flow.js:1455`, `verify-agroscope-uplink-transform.js`).

## ⚠️ Hard merge-order rule
**This PR merges BEFORE program item 0.1 deploys current `main` to any gateway.** The two history-sync nodes are on undeployed main (verified: introduced 2026-06-28 17:12, after the last recorded deploy `ab4f5317` @ 15:59); deploying main without this PR ships a dead history-sync path whose failures are `node.warn`-swallowed and invisible to `error_counts`.

## Evidence
- `node --test .../osi-lib/index.test.js` — success/cache, unknown name, failure→quarantine→retry-after-cooldown, result shape: all passing.
- `node scripts/verify-helper-registration.js` — 9 helpers × 2 profiles + codec entries, all OK.
- `node scripts/verify-sync-flow.js` — green incl. new `OK no function node bare-requires a non-builtin module`; ends `All parity checks passed.`
- Full local CI-equivalent sequence (plan Task 6 Step 6.1) — all green.

Part of refactor-program item 1.A1 (DD2). Closes #99.

## Test plan
- [ ] CI green on this PR
- [ ] Reviewer spot-check: `git diff main -- conf/*/files/usr/share/flows.json` touches exactly 3 nodes' `func`/`libs`
- [ ] Item 0.1's deploy waits for this merge (merge-order rule above)
EOF
)"
```

---

## Follow-ups (not tasks in this plan)

- **Item 1.A3** backfills `node --test` for `osi-history-helper` using the co-located-test pattern T1 establishes.
- **Item 0.1's deploy** is the first live validation of the migrated history-sync path (watch `sync_history_cursors` progress + `sync_state.lastHistorySyncError` post-deploy, per the live-ops runbook).
- The skill doc `.claude/skills/osi-flows-json-editing/SKILL.md` records stale provenance figures (529 nodes / 1,245,761 bytes, 2026-07-06; now 564 / 1,263,362) — worth a one-line refresh next time the skill is touched, not part of this item.
