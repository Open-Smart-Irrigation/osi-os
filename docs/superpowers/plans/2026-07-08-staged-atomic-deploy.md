# Staged atomic payload deploy + auto-rollback (refactor-program 5.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Repo:** all changes in **osi-os** (`/home/phil/Repos/osi-os`). Branch `feat/53-staged-atomic-deploy`, PR, **do not merge**. Work in a worktree, not the root `main` checkout.
> **Execution notes:** (1) run every command from the worktree root; (2) the deploy orchestration is extracted to a **testable Node module** (`scripts/deploy-payload-swap.js`) that `deploy.sh` calls — the repo's script-with-`node --test` idiom (`scripts/*.test.js`); (3) `deploy.sh` is edited in ONE place only — its **flows-payload write region (lines ~535-537)** and a new **post-restart health-probe/rollback region** near the end (after line 647's `ensure_*` block, before the React GUI at line 681). **Do NOT touch the `ensure_dendro_schema`/`ensure_zone_irrigation_calibration_schema`/`ensure_analysis_views_schema`/`ensure_chameleon_schema`/`ensure_gateway_health_schema` functions or their invocation block (lines 129-511, 643-647)** — those are 1.B1's to retire; 5.3 leaves them intact; (4) Pis are BusyBox `ash` (POSIX sh, no bash) — `deploy.sh` is `#!/bin/sh`; keep shell edits POSIX; (5) the new JS test wires into `.github/workflows/migrations.yml` at the `node --test scripts/*.test.js` run (line 38).
> **Spec:** [`docs/superpowers/specs/2026-07-08-staged-atomic-deploy-design.md`](../specs/2026-07-08-staged-atomic-deploy-design.md) (recovered + verified; §A–§E references point there).

**Goal:** Make the payload swap in `deploy.sh` **atomic** and **auto-rolled-back on a failed post-check** (DD10). Instead of writing `flows.json` in place to `/srv/node-red/flows.json`, deploy writes each deploy's flows payload into a **versioned staging directory** (`/srv/node-red/payloads/<stamp>/`) and points `/srv/node-red/flows.json` at it via a **symlink flipped with a single atomic `ln -sfn`**. After the flip + Node-RED restart, deploy runs **0.2's `deploy-canary-gate.js` health probe** (N=5 consecutive healthy heartbeats); on probe FAIL or couldn't-judge it **flips the symlink back to the previous payload dir and restarts** — instantly, because the previous dir is retained (keep-N). The flip-back is automatic; a **DB migration restore is NOT** (that stays 1.B1's operator-invoked backup path — the item's central honesty).

**Architecture (spec §A–§E):** A Node module `scripts/deploy-payload-swap.js` owns the pure, testable filesystem logic: `stagePayload(root, stamp, srcFlows)` writes `payloads/<stamp>/flows.json`; `flipTo(root, stamp)` atomically re-points `flows.json` (via a temp-symlink + `rename`, the JS equivalent of `ln -sfn`); `currentTarget(root)` / `previousStamp(root)` read the layout; `prunePayloads(root, keepN)` retains the newest N dirs (the backup-rotation idiom); `rollback(root)` flips to the previous stamp. `deploy.sh` calls this module for the swap, then invokes 0.2's gate; on non-zero it calls `rollback` + restarts. The migrate-a-copy step (1.B1's writers-stopped/backup `applyPending`) runs BEFORE the flip and aborts the deploy on failure — the common bad-flows failure then rolls back via symlink with the DB untouched.

## CRITICAL: Composed deploy.sh ordering with 1.B1 (Fable review 2026-07-10)

**5.3 OWNS the re-ordering of deploy.sh's stage→migrate→flip sequence.** As written, 5.3 flips the symlink at :535 (the old flows-write region) and 1.B1's `run_schema_migration` runs at :643 (the old `ensure_*` slot). Composed order would be **flip→migrate→probe**, violating DD10's "migration fails → abort BEFORE the flip." On migration failure with `set -e`, the script aborts at :643 and 5.3's rollback block at :681 **never executes** — new payload live, restored old-schema DB, no rollback.

**The fix (this plan owns it):** deploy.sh's sequence becomes:
1. **Stage** the new flows into `payloads/<stamp>/` at :535 (nothing live touched)
2. **Migrate** at :643 (1.B1's `run_schema_migration` — writers stopped, backup, restore-on-failure)
3. **Flip + restart + probe + auto-rollback** in the post-migrate block (where the old :681 "React GUI" region starts)

This means the `flipTo` call moves OUT of the :535 region and INTO the post-migrate block. The :535 region only stages; the flip happens after a successful migration (or after a no-op migration for additive-only deploys). A migration failure aborts before the flip — old payload still live, DB restored by 1.B1, exactly as DD10 requires.

**Whichever of 5.3/1.B1 merges second re-anchors its line references** — both plans anchor edits by line numbers that the other's merge will shift. Both plans include a re-anchor verification step.

**Trap interaction with 1.B1:** 1.B1's `run_schema_migration` sets `trap restart_node_red EXIT INT TERM`. This plan's rollback block must chain with 1.B1's trap, not replace it. The rollback block (Task 2, Step 2.3) is written so it runs AFTER Node-RED has been restarted by 1.B1's trap — the probe runs against the already-restarted Node-RED, and rollback flips the symlink then restarts again.

**Tech Stack:** POSIX `sh` (`deploy.sh`, BusyBox `ash` on the Pi), Node.js (`node:test`, `node:fs`, no new deps) for the swap module, GitHub Actions (`migrations.yml`).

## Rebase protocol (all plans anchoring on line numbers)

**Main has progressed since this plan was written** (2026-07-08). Line numbers cited below (e.g. `deploy.sh:535`, `:643`, `:681`) are verified against main as of that date but may drift as other PRs merge. **Before executing any task that references a line number:**

1. `git rebase main` (or merge main into the feature branch).
2. Re-verify every line reference: `grep -n '<anchor text>' deploy.sh` for each anchor cited in the task.
3. If a reference has shifted, update the step's line number in your working notes — do NOT edit this plan file (it is the reviewed plan of record; line shifts are expected and handled at execution time).
4. If the anchor text itself is GONE (not just shifted), STOP — another plan likely merged a conflicting change. Check git log for the commit that removed it and reconcile.

This protocol applies to 1.B1 as well — both plans edit `deploy.sh` and whichever merges second must re-anchor.

## Global Constraints

- **osi-os only.** Branch `feat/53-staged-atomic-deploy`; commit per task; PR; **do not merge**.
- **`deploy.sh` is the ONLY deploy file edited, and only its staging/swap + post-check regions.** Concretely: replace the direct flows.json `fetch_required` (lines 535-537) with a staged-write + `flipTo`, and add a post-restart probe + auto-rollback block near the end. **NEVER edit the `ensure_*` schema functions or their invocation (lines 129-511, 643-647)** — 1.B1 retires those; 5.3 must not touch them.
- **Consume, do not re-implement, 0.2 and 1.B1.** 0.2's `scripts/deploy-canary-gate.js` is the post-check (it does not exist yet — it is a consumed contract from `2026-07-07-deploy-canary-gate-design.md`; deploy.sh invokes it by path and branches on its exit code 0=PASS/1=FAIL/2=couldn't-judge). 1.B1's writers-stopped/backup `applyPending` (from `2026-07-08-option-b-stage1-deploy-runner-design.md`) is the migrate-a-copy step. **Cite both; never re-implement a health probe or a migration/backup path.**
- **NEVER auto-roll-back a DB migration** (DD10 / spec §C). Payload flip-back is automatic; a destructive-migration undo is 1.B1's operator-invoked backup restore. A flows-fail-after-successful-migration deploy leaves the migrated DB on the old flows, and the runbook tells the operator so.
- **Same-filesystem atomicity:** the staging dir and the `flows.json` symlink live under `/srv/node-red/`, same filesystem — so the symlink `rename` is atomic, not a cross-device copy. deploy.sh verifies same-fs placement before the first flip.
- **NEVER overwrite `/data/db/farming.db`** (the standing guardrail) — 5.3 changes only the flows payload path, not the DB seed logic (`seed_db_if_missing`, lines 104-127, is untouched).
- CI (`migrations.yml`) green at every commit.

## Known limitation: payload staging scope (Fable review 2026-07-10)

The spec §A defines the staged payload as "flows.json, settings.js, package.json, the GUI bundle reference." This plan stages **only `flows.json`** — `settings.js` is overwritten in place every deploy, and helper modules (`osi-history-sync-helper`, future `osi-zone-env`…) are fetched in place under `/srv/node-red/`. This is acceptable for Phase 0–2 (the only extracted module is `osi-history-helper`, which is flows-version-coupled). As DD4 extraction proceeds (Phases 2–4), the rollback unit and the behavior unit **diverge**: rolling back flows but not a module leaves old flows calling the new module API. `osiLib` quarantine (DD2/1.A1) makes this fail-visible (503 + `error_counts`), not fail-silent, which is the right degradation. **When the second extraction lands (2.4 or 4.2), revisit this plan to stage the full payload directory** (flows + settings.js + `osi-*` module tree), so rollback fidelity doesn't erode as the codebase matures.

## Non-goals (do not do these)

- No DB migration auto-rollback (DD10 / §C) — DB restore is 1.B1's operator path. No re-implementing the 0.2 health probe or the 1.B1 migration/backup machinery — 5.3 composes them. No A/B rootfs OTA (YAGNI; payload-level atomicity only). No fleet orchestration — 5.3 makes ONE gateway's deploy atomic + self-rolling-back (0.2 + the runbook drive the canary-gated fleet walk). No boot-node (`sync-init-fn`) change. No live-gateway rehearsal in this slice (that is a 5.2-rig / operator step). No touching the `ensure_*` functions.

## File Structure (all paths from the worktree root)

- Create: `scripts/deploy-payload-swap.js` + `scripts/deploy-payload-swap.test.js` (Task 1)
- Modify: `deploy.sh` — flows-payload write region + a new post-restart probe/rollback region (Task 2)
- Modify: `.github/workflows/migrations.yml` (add the new test) (Task 3)

---

### Task 1: `scripts/deploy-payload-swap.js` — atomic staging/flip/rollback/prune (TDD)

**Files:**
- Create: `scripts/deploy-payload-swap.test.js`
- Create: `scripts/deploy-payload-swap.js`

**Interfaces:**
- Produces:
  - `stagePayload(root, stamp, srcFlowsPath) → payloadDir` — creates `<root>/payloads/<stamp>/` and copies `srcFlowsPath` to `<payloadDir>/flows.json`.
  - `flipTo(root, stamp) → { flowsLink, target }` — atomically points `<root>/flows.json` at `payloads/<stamp>/flows.json` (temp symlink + `fs.renameSync`, atomic on the same fs — the JS `ln -sfn`).
  - `currentStamp(root) → stamp|null` — the stamp the `flows.json` symlink currently resolves to.
  - `previousStamp(root) → stamp|null` — the newest retained payload stamp that is NOT the current one (the rollback target).
  - `rollback(root) → { flippedTo }` — flips `flows.json` back to `previousStamp`; throws if none retained.
  - `prunePayloads(root, keepN) → { removed }` — deletes all but the newest `keepN` payload dirs, never removing the current target.
- These are pure filesystem ops (no network, no restart, no DB) — fully `node --test`-covered. `deploy.sh` supplies the restart + probe.

- [ ] **Step 1.1: Worktree + branch** — create a worktree of `main` at `feat/53-staged-atomic-deploy`; `cd` into it. Confirm the deploy.sh regions this plan will edit are where the plan says:

```bash
grep -n 'fetch_required "flows.json"' deploy.sh   # expect ~line 535
grep -n 'ensure_gateway_health_schema$' deploy.sh  # expect the invocation at ~line 647 — the LAST ensure_ call (do NOT touch)
grep -n 'React GUI' deploy.sh                       # expect ~line 681 — the probe/rollback block goes BEFORE this
```

- [ ] **Step 1.2: Write the failing test (red)** — create `scripts/deploy-payload-swap.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  stagePayload, flipTo, currentStamp, previousStamp, rollback, prunePayloads,
} = require('./deploy-payload-swap');

function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-node-red-'));
  return root;
}
function fakeFlowsSrc(dir, marker) {
  const p = path.join(dir, 'flows-src.json');
  fs.writeFileSync(p, JSON.stringify([{ id: 'x', marker }]));
  return p;
}

test('stagePayload writes payloads/<stamp>/flows.json without touching the live symlink', () => {
  const root = fakeRoot();
  const src = fakeFlowsSrc(root, 'v1');
  const dir = stagePayload(root, '20260508T100000Z', src);
  assert.equal(dir, path.join(root, 'payloads', '20260508T100000Z'));
  assert.ok(fs.existsSync(path.join(dir, 'flows.json')));
  assert.equal(currentStamp(root), null, 'no flip yet — nothing live');
});

test('flipTo atomically points flows.json at the staged payload; currentStamp reads it back', () => {
  const root = fakeRoot();
  const src = fakeFlowsSrc(root, 'v1');
  stagePayload(root, 'stampA', src);
  const { target } = flipTo(root, 'stampA');
  const link = path.join(root, 'flows.json');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(link), fs.realpathSync(target));
  assert.equal(currentStamp(root), 'stampA');
  // Node-RED reading through the symlink sees the payload content.
  assert.match(fs.readFileSync(link, 'utf8'), /v1/);
});

test('flipTo over an existing symlink is atomic replacement (re-point, not stack)', () => {
  const root = fakeRoot();
  stagePayload(root, 'stampA', fakeFlowsSrc(root, 'v1'));
  stagePayload(root, 'stampB', fakeFlowsSrc(root, 'v2'));
  flipTo(root, 'stampA');
  flipTo(root, 'stampB');
  assert.equal(currentStamp(root), 'stampB');
  assert.match(fs.readFileSync(path.join(root, 'flows.json'), 'utf8'), /v2/);
});

test('flipTo migrates an in-place regular flows.json file to the symlink layout', () => {
  const root = fakeRoot();
  // Simulate the FIRST deploy under this scheme: a pre-existing regular file.
  fs.writeFileSync(path.join(root, 'flows.json'), JSON.stringify([{ id: 'legacy' }]));
  stagePayload(root, 'stampA', fakeFlowsSrc(root, 'v1'));
  flipTo(root, 'stampA');
  assert.ok(fs.lstatSync(path.join(root, 'flows.json')).isSymbolicLink(), 'regular file replaced by symlink');
  assert.equal(currentStamp(root), 'stampA');
});

test('previousStamp returns the newest retained non-current stamp (the rollback target)', () => {
  const root = fakeRoot();
  stagePayload(root, '20260501T000000Z', fakeFlowsSrc(root, 'old'));
  stagePayload(root, '20260502T000000Z', fakeFlowsSrc(root, 'new'));
  flipTo(root, '20260501T000000Z');
  flipTo(root, '20260502T000000Z'); // current = new
  assert.equal(previousStamp(root), '20260501T000000Z');
});

test('rollback flips back to the previous payload (instant, no re-fetch)', () => {
  const root = fakeRoot();
  stagePayload(root, 'good', fakeFlowsSrc(root, 'GOOD'));
  stagePayload(root, 'bad', fakeFlowsSrc(root, 'BAD'));
  flipTo(root, 'good');
  flipTo(root, 'bad');
  const { flippedTo } = rollback(root);
  assert.equal(flippedTo, 'good');
  assert.equal(currentStamp(root), 'good');
  assert.match(fs.readFileSync(path.join(root, 'flows.json'), 'utf8'), /GOOD/);
});

test('rollback throws when there is no previous payload to fall back to', () => {
  const root = fakeRoot();
  stagePayload(root, 'only', fakeFlowsSrc(root, 'ONLY'));
  flipTo(root, 'only');
  assert.throws(() => rollback(root), /no previous payload/i);
});

test('prunePayloads keeps the newest N and never removes the current target', () => {
  const root = fakeRoot();
  for (const s of ['20260501', '20260502', '20260503', '20260504']) {
    stagePayload(root, s, fakeFlowsSrc(root, s));
  }
  flipTo(root, '20260501'); // current is the OLDEST — must be protected even though it sorts first
  const { removed } = prunePayloads(root, 2);
  const remaining = fs.readdirSync(path.join(root, 'payloads')).sort();
  assert.ok(remaining.includes('20260501'), 'current target is never pruned');
  assert.ok(remaining.includes('20260504'), 'newest is retained');
  assert.ok(remaining.length <= 3, `keepN=2 plus protected current: got ${remaining.join(',')}`);
  assert.ok(removed.length >= 1);
});
```

- [ ] **Step 1.3: Run it (red)**

Run: `node --test scripts/deploy-payload-swap.test.js`
Expected: FAIL — `Cannot find module './deploy-payload-swap'`.

- [ ] **Step 1.4: Implement** — create `scripts/deploy-payload-swap.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Staged atomic payload swap + rollback (refactor-program 5.3, DD10), spec §A/§B:
//   docs/superpowers/specs/2026-07-08-staged-atomic-deploy-design.md
// Pure filesystem logic: stage a versioned payload dir, flip the flows.json symlink
// atomically (ln -sfn equivalent), roll back by re-pointing at the retained previous
// dir, prune keep-N. deploy.sh supplies the restart + 0.2 health probe around these.
//
// The atomic unit is the FLOWS payload (the behavior). The DB migration is coupled
// but rolled back differently (1.B1's operator backup restore) — NOT here.
const fs = require('node:fs');
const path = require('node:path');

function payloadsRoot(root) { return path.join(root, 'payloads'); }
function payloadDir(root, stamp) { return path.join(payloadsRoot(root), stamp); }
function flowsLink(root) { return path.join(root, 'flows.json'); }

function stagePayload(root, stamp, srcFlowsPath) {
  const dir = payloadDir(root, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(srcFlowsPath, path.join(dir, 'flows.json'));
  return dir;
}

// Atomic re-point of flows.json -> payloads/<stamp>/flows.json.
// symlink(tmp) + rename(tmp, flows.json) is atomic on the same filesystem, and
// replaces either an existing symlink OR a pre-existing regular file (the first-deploy
// migration case) — rename over a target is atomic; no window where flows.json is absent.
function flipTo(root, stamp) {
  const target = path.join(payloadDir(root, stamp), 'flows.json');
  if (!fs.existsSync(target)) throw new Error(`flipTo: staged payload missing: ${target}`);
  const link = flowsLink(root);
  const rel = path.relative(root, target); // relative link keeps the layout portable
  const tmp = path.join(root, `.flows.json.flip-${process.pid}-${Date.now()}`);
  try { fs.unlinkSync(tmp); } catch (_) {}
  fs.symlinkSync(rel, tmp);
  fs.renameSync(tmp, link); // atomic replace of symlink OR regular file
  return { flowsLink: link, target };
}

function currentStamp(root) {
  const link = flowsLink(root);
  let lst;
  try { lst = fs.lstatSync(link); } catch (_) { return null; }
  if (!lst.isSymbolicLink()) return null;
  const resolved = fs.realpathSync(link); // .../payloads/<stamp>/flows.json
  const dir = path.dirname(resolved);
  if (path.dirname(dir) !== fs.realpathSync(payloadsRoot(root))) return null;
  return path.basename(dir);
}

function listStamps(root) {
  try { return fs.readdirSync(payloadsRoot(root)).sort(); } catch (_) { return []; }
}

function previousStamp(root) {
  const cur = currentStamp(root);
  const others = listStamps(root).filter((s) => s !== cur);
  return others.length ? others[others.length - 1] : null; // newest non-current (ISO stamps sort chronologically)
}

function rollback(root) {
  const prev = previousStamp(root);
  if (!prev) throw new Error('rollback: no previous payload retained to fall back to');
  flipTo(root, prev);
  return { flippedTo: prev };
}

function prunePayloads(root, keepN) {
  const cur = currentStamp(root);
  const all = listStamps(root);
  // Keep the newest keepN, always keep the current target, never touch the current.
  const keep = new Set(all.slice(Math.max(0, all.length - keepN)));
  if (cur) keep.add(cur);
  const removed = [];
  for (const s of all) {
    if (keep.has(s)) continue;
    fs.rmSync(payloadDir(root, s), { recursive: true, force: true });
    removed.push(s);
  }
  return { removed };
}

module.exports = { stagePayload, flipTo, currentStamp, previousStamp, rollback, prunePayloads };
```

- [ ] **Step 1.5: Run it (green)**

Run: `node --test scripts/deploy-payload-swap.test.js`
Expected: all 8 tests pass, exit 0.

- [ ] **Step 1.6: Commit**

```bash
git add scripts/deploy-payload-swap.js scripts/deploy-payload-swap.test.js
git commit -m "feat(deploy): staged-payload atomic symlink swap + rollback/prune module (5.3, DD10)"
```

---

### Task 2: `deploy.sh` — stage-write the flows payload, flip, probe, auto-rollback

**Files:**
- Modify: `deploy.sh`

**Interfaces:** deploy.sh now stages flows into `payloads/<stamp>/`, flips the symlink, restarts Node-RED, runs 0.2's gate, and auto-rolls-back on failure. The `ensure_*` block and DB seed logic are untouched.

> **Verified layout interaction (load-bearing, from `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` lines 122-206 and `settings.js` lines 39-40):** Node-RED reads `flowFile: "flows.json"` from `userDir: /srv/node-red`, i.e. `/srv/node-red/flows.json`. `node-red.init` at start does `fs.writeFileSync('/srv/node-red/flows.json', ...)` to inject MQTT broker creds/clientid. **`fs.writeFileSync` on a symlink follows the link and rewrites the TARGET file in place — it does NOT replace the symlink.** So after the flip, node-red.init's cred injection writes into `payloads/<stamp>/flows.json` (the resolved target), leaving the symlink intact and the payload correct. This is fine: each payload dir gets its runtime creds injected on start. Rolling back to a previous payload dir (whose flows.json may already carry injected creds) is still correct. **Do not "fix" node-red.init to write-through-atomically — it already behaves correctly with the symlink.**

- [ ] **Step 2.1: Add the payload-stamp + same-fs check near the top** — after the `TMP_DIR` / `mkdir -p` block (lines 43-50), add a POSIX block that computes a deploy stamp and the payload root, and fetches the swap module + a helper to invoke it. Insert after line 50 (`mkdir -p "$TMP_DIR" /srv/node-red "$DB_DIR"`):

```sh
# --- Staged atomic payload layout (refactor-program 5.3 / DD10) ---
PAYLOADS_ROOT="/srv/node-red/payloads"
DEPLOY_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PAYLOAD_KEEP_N=5
mkdir -p "$PAYLOADS_ROOT"

# The payload swap logic lives in a tested Node module fetched alongside the payload.
SWAP_JS="$TMP_DIR/deploy-payload-swap.js"
fetch "scripts/deploy-payload-swap.js" "$SWAP_JS"

# Same-filesystem guard: the symlink rename is only atomic within one filesystem.
# /srv/node-red/flows.json and /srv/node-red/payloads/ must share a device.
same_fs_or_die() {
    dev_a="$(stat -c %d /srv/node-red 2>/dev/null || echo A)"
    dev_b="$(stat -c %d "$PAYLOADS_ROOT" 2>/dev/null || echo B)"
    if [ "$dev_a" != "$dev_b" ]; then
        echo "ERROR: $PAYLOADS_ROOT is on a different filesystem than /srv/node-red; symlink flip would not be atomic." >&2
        exit 1
    fi
}
same_fs_or_die

# Invoke a named export of the swap module: swap_call <fn> [args...]
# Prints scalar (string/null) returns AND object returns — currentStamp/previousStamp
# return a STRING (or null), which the shell captures via "$(swap_call ...)"; an
# object-only print would silently drop those (breaking PREV_STAMP capture + rollback).
swap_call() {
    node -e '
      const m = require(process.argv[1]);
      const fn = process.argv[2];
      const args = process.argv.slice(3);
      const out = m[fn]("/srv/node-red", ...args);
      if (out === null || out === undefined) process.exit(0);
      if (typeof out === "object") process.stdout.write(JSON.stringify(out));
      else process.stdout.write(String(out));
    ' "$SWAP_JS" "$@"
}
```

- [ ] **Step 2.2: Replace the in-place flows.json write with a STAGE-ONLY write (NO flip yet)** — replace the block at lines 535-537:

```sh
fetch_required "flows.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" \
    "/srv/node-red/flows.json"
```

with the stage-only form:

```sh
echo "--- flows.json (staged payload — flip deferred to post-migrate) ---"
STAGED_FLOWS="$TMP_DIR/flows.json"
fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" "$STAGED_FLOWS"
# Stage into payloads/<stamp>/ — NOTHING LIVE IS TOUCHED YET.
# The symlink flip happens AFTER the schema migration succeeds (Step 2.3),
# so a migration failure leaves the old payload live and the DB restored (DD10).
swap_call stagePayload "$DEPLOY_STAMP" "$STAGED_FLOWS" >/dev/null
PREV_STAMP="$(swap_call currentStamp || true)"
echo "OK: staged payloads/$DEPLOY_STAMP (current: ${PREV_STAMP:-none}; flip deferred)"
```

**The flip is NOT here.** It moves to Step 2.3 (the post-migrate block), after 1.B1's `run_schema_migration` at :643 succeeds. This is the load-bearing re-ordering from the Fable review: stage→migrate→flip, not flip→migrate→probe. A migration failure now aborts before the flip — old payload still live, DB restored by 1.B1, exactly as DD10 requires.

- [ ] **Step 2.3: Add the post-migrate FLIP + probe + auto-rollback block** — immediately BEFORE the `echo "--- React GUI ---"` line (currently line 681), insert. **This is where the symlink flip happens — AFTER the migration at :643 succeeded (or was a no-op).** The DD10 sequence is now: stage (:535) → migrate (:643) → flip+restart+probe (here):

```sh
echo "--- Flip payload + health probe + auto-rollback (5.3 / DD10) ---"
# The migration at :643 succeeded (or was a no-op). NOW flip the symlink to the
# new payload. If the migration had failed, set -e would have aborted the script
# before reaching this point — old payload still live, DB restored by 1.B1.
swap_call flipTo "$DEPLOY_STAMP" >/dev/null
echo "OK: flipped /srv/node-red/flows.json -> payloads/$DEPLOY_STAMP"

# Restart Node-RED onto the newly-flipped payload, then run 0.2's canary gate.
# NOTE: if 1.B1's run_schema_migration ran, its trap already restarted Node-RED.
# A second restart is harmless and ensures we're running the flipped payload.
/etc/init.d/node-red restart || true

# 0.2's health probe is the post-check (N=5 consecutive healthy heartbeats, server
# verdict, disk, error-delta). It is a CONSUMED contract — deploy does not re-implement it.
# exit 0 = PASS, 1 = FAIL, 2 = couldn't-judge (treated as fail for a self-rolling deploy).
#
# IMPORTANT: the probe runs OPERATOR-SIDE (see 0.2 spec). On the Pi, we run a
# LOCAL health self-check only — heartbeat freshness + Node-RED process alive +
# /gui returns 301. The cloud-verdict gate (schema_sig, error-delta) is the
# OPERATOR's responsibility after deploy exits (via 0.2's gate from their machine).
PROBE_OK=1
if pgrep -f 'node-red' >/dev/null 2>&1; then
    # Give Node-RED a few seconds to start its HTTP listener
    sleep 5
    if wget -q -O /dev/null --spider "http://127.0.0.1:1880/gui" 2>/dev/null; then
        echo "OK: local health self-check PASSED (Node-RED alive, /gui reachable)"
        PROBE_OK=0
    else
        echo "WARN: Node-RED process alive but /gui not reachable after 5s" >&2
    fi
else
    echo "ALERT: Node-RED process not found after restart" >&2
fi

if [ "$PROBE_OK" = "0" ]; then
    echo "OK: committing payload $DEPLOY_STAMP"
    swap_call prunePayloads "$PAYLOAD_KEEP_N" >/dev/null
else
    echo "ALERT: local health self-check FAILED — AUTO-ROLLING-BACK the flows payload" >&2
    if [ -n "${PREV_STAMP:-}" ]; then
        swap_call flipTo "$PREV_STAMP" >/dev/null
        /etc/init.d/node-red restart || true
        echo "ROLLED BACK: flows.json -> payloads/$PREV_STAMP; Node-RED restarted on last-known-good payload" >&2
        echo "NOTE: any DB migration that already committed is NOT auto-undone (DD10) — restore is an operator call via 1.B1's backup." >&2
        echo "NOTE: run 0.2's deploy-canary-gate.js from your operator machine to get the full cloud verdict." >&2
        exit 1
    else
        echo "ERROR: no previous payload to roll back to (first deploy under staged scheme). Payload $DEPLOY_STAMP left live; investigate." >&2
        exit 1
    fi
fi
```

**Three design changes from the original plan (Fable review 2026-07-10):**
1. **The flip is HERE, not at :535.** Stage→migrate→flip, per DD10.
2. **The probe is a LOCAL self-check, not 0.2's cloud gate.** The 0.2 spec is explicit: the cloud admin gate runs operator-side with an admin JWT (`OSI_ADMIN_TOKEN`), not on the Pi. Shipping admin credentials to every gateway violates the credential policy. The on-Pi self-check is: Node-RED process alive + `/gui` returns a response. The full cloud verdict (schema_sig, error-delta, server health) runs from the operator's machine after deploy exits.
3. **No `deploy-canary-gate.js` fetch onto the Pi.** The operator runs `node scripts/deploy-canary-gate.js --gateway-eui <EUI>` from their workstation after deploy exits successfully. The Pi only does the local smoke test.

- [ ] **Step 2.4: Update the final "Next steps" note** — the trailing echo block (lines 691-694) tells the operator to restart Node-RED manually; with the probe now restarting it, adjust the wording. Change:

```sh
echo "=== Deploy complete. Next steps: ==="
echo "  1. Restart Node-RED:  /etc/init.d/node-red restart"
echo "  2. Open the UI:       http://<device-ip>:1880/gui"
```

to:

```sh
echo "=== Deploy complete. ==="
echo "  Payload:  /srv/node-red/payloads/$DEPLOY_STAMP (flipped + health-probed)"
echo "  UI:       http://<device-ip>:1880/gui"
echo "  Rollback: automatic on a failed post-check; a committed DB migration is restored via 1.B1's backup path (operator), NOT auto."
```

- [ ] **Step 2.5: Lint the shell (POSIX/BusyBox-safe)** — verify no bashisms were introduced and the script still parses:

```bash
sh -n deploy.sh && echo "deploy.sh parses under POSIX sh"
# Optional stricter check if shellcheck is available:
command -v shellcheck >/dev/null 2>&1 && shellcheck -s sh deploy.sh || echo "(shellcheck not installed; sh -n passed)"
```

Expected: `deploy.sh parses under POSIX sh` (exit 0). Confirm with `git diff deploy.sh` that the `ensure_*` functions (lines 129-511) and their invocation block (643-647) and `seed_db_if_missing` (104-127) are **unchanged**.

- [ ] **Step 2.6: Commit**

```bash
git add deploy.sh
git commit -m "feat(deploy): stage flows payload + atomic symlink flip + 0.2 probe + auto-rollback (5.3, DD10)"
```

---

### Task 3: CI wiring, rollback-asymmetry runbook note, PR

**Files:**
- Modify: `.github/workflows/migrations.yml`

- [ ] **Step 3.1: Wire the swap-module test into CI** — in `.github/workflows/migrations.yml`, append `scripts/deploy-payload-swap.test.js` to the existing `node --test scripts/...test.js` run at line 38 (the `check-sync-parity.test.js ...` line). Add it to that space-separated file list:

```yaml
      - run: node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js scripts/verify-no-stray-ddl.test.js scripts/verify-no-new-silent-catch.test.js scripts/test-error-recording-flow.js scripts/deploy-payload-swap.test.js
```

Run locally: `node --test scripts/deploy-payload-swap.test.js` (green).

- [ ] **Step 3.2: Record the rollback asymmetry + consumed contracts in the PR body** (spec §C/§D) — the PR must state plainly:
  - **Payload (flows) rollback is automatic** — a symlink flip-back + restart, always available because the previous payload dir is retained (keep-N).
  - **DB migration rollback is NOT automatic** — a committed destructive migration is undone only by restoring 1.B1's byte-verified pre-migration backup, an operator-gated action. A schema-and-flows deploy whose flows fail the probe leaves the migrated DB on the old flows; the operator is told and the DB-restore is their explicit call.
  - **Consumed, not re-implemented:** 0.2's `deploy-canary-gate.js` (health probe) and 1.B1's writers-stopped/backup `applyPending` (migrate-a-copy). The probe fetch is fail-open until 0.2 is deployed.
  - **5.3 + 0.2 seed the fleet canary walk** (`deploy(atomic, self-rollback) → gate(0.2) → next gateway`); 5.3 is one gateway's unit, not a fleet controller.

- [ ] **Step 3.3: Record the 5.2/operator rehearsal follow-up** in the PR body: the live "bad flows → probe fails → auto-rollback → gateway healthy on old payload" cycle is a **5.2-rig / operator rehearsal** against a throwaway Node-RED instance; CI covers the deterministic symlink/prune/rollback logic (Task 1); the rollout runbook cites the rehearsal artifact.

- [ ] **Step 3.4: Push + open PR (do not merge)**

```bash
git push -u origin feat/53-staged-atomic-deploy
gh pr create --title "feat(deploy): staged atomic payload swap + auto-rollback (5.3, DD10)" \
  --body "Refactor-program 5.3 (DD10). deploy.sh stages flows into payloads/<stamp>/, flips /srv/node-red/flows.json via an atomic ln -sfn (tested JS module scripts/deploy-payload-swap.js), restarts Node-RED, runs 0.2's canary gate, and AUTO-ROLLS-BACK the symlink (flip to retained previous dir + restart) on probe FAIL/couldn't-judge. Rollback asymmetry (honest, DD10): payload flip-back is automatic; a committed DB migration is restored via 1.B1's operator backup path, NEVER auto. Consumes 0.2 (probe, fail-open until deployed) + 1.B1 (migrate-a-copy) — not re-implemented. Only deploy.sh's flows-write + post-check regions touched; ensure_* schema functions untouched (1.B1 retires those). Live bad-flows->rollback cycle is a 5.2/operator rehearsal. Do not merge without review." --draft
```

---

## Verification checklist (before marking done)

- [ ] `scripts/deploy-payload-swap.js` provides `stagePayload`/`flipTo`/`currentStamp`/`previousStamp`/`rollback`/`prunePayloads`; all 8 `node --test` cases pass (atomic flip, in-place-file migration, rollback, keep-N-protecting-current).
- [ ] `deploy.sh` stages flows into `payloads/<stamp>/` and flips via the atomic symlink rename; the in-place `fetch_required "flows.json"` write is gone.
- [ ] Post-restart block runs 0.2's `deploy-canary-gate.js` and, on non-zero, flips back to `PREV_STAMP` + restarts + logs loudly; fail-open when 0.2's gate is not yet on the source.
- [ ] Same-filesystem guard present before the first flip; keep-N prune on success, protecting the current target.
- [ ] **No DB auto-rollback** — the block explicitly notes a committed migration is 1.B1's operator restore; `seed_db_if_missing` + the `ensure_*` functions + their invocation (lines 104-127, 129-511, 643-647) are UNCHANGED (`git diff` confirms).
- [ ] `sh -n deploy.sh` passes (POSIX/BusyBox-safe; no bashisms).
- [ ] node-red.init symlink write-through interaction documented (writeFileSync follows the symlink, rewrites the target, symlink intact — correct behavior, no fix needed).
- [ ] Swap-module test wired into `migrations.yml`; rollback asymmetry + consumed-contracts + 5.2-rehearsal noted in PR body.
- [ ] No boot-node change; no fleet controller; no live gateway; PR open, not merged.
