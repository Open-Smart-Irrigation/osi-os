# osi-lib Loader + Fail-Visible Quarantine

**Status:** Draft
**Refactor-program item:** 1.A1 (DD2)
**Focus: osi-os**
**Role:** precondition for all seam extractions (DD2); interacts with item 0.1's deploy — the three bare-require nodes analyzed here are on undeployed `main` and must not ship as-is on 0.1's next deploy.
**Retires:** issue #99.

## Problem

Three function nodes in `flows.json` (both profiles, byte-identical) call a bare absolute-path `require(...)` instead of Node-RED's `libs` mechanism:

| Node | Path required | Guarded by try/catch? |
|---|---|---|
| `Build History Batch` (`sync-history-build`) | `/usr/share/node-red/osi-history-sync-helper` | No — `require` is the first statement in the async IIFE, before the node's own `try {`. |
| `Mark History Batch ACK` (`sync-history-mark`) | `/usr/share/node-red/osi-history-sync-helper` | No — same shape. |
| `Forward Agroscope Dendro` (`agroscope-forward-fn`) | `/srv/node-red/codecs/agroscope_uplink_transform` | Yes — `try { transform = require(...) } catch (error) { node.error(...); return null; }`. Not in issue #99, but the same bare-path anti-pattern the ratchet must still catch. |

`osi-history-sync-helper` is registered in none of the runtime `package.json`/`package-lock.json`, `98_osi_node_red_seed`'s module-copy loop, or `deploy.sh`'s `fetch_required` calls — it never reaches `/srv/node-red/` on any gateway. On the next deploy of current `main`, the two history nodes throw before they can build or mark a batch: the history-sync path ships dead. `agroscope_uplink_transform.js` *is* deliverable today (`codecs/` is copied/fetched wholesale), so `Forward Agroscope Dendro` isn't currently broken — but it's the same anti-pattern and the ratchet must not exempt it. Beyond these three, this item stands up the single choke point (`osi-lib`) every later strangler extraction (dendro, zone-env, history router) must load through per DD2, and closes the gap so the genus can't regrow.

## Verified ground truth

1. **Node-RED 3.1.15 sandbox** (`@node-red/nodes/core/function/10-function.js`, a built artifact under `openwrt/staging_dir/.../@node-red/nodes/core/function/` — not present under `conf/`, correcting the task's assumed path). The `vm.createContext(sandbox)` object exposes `console, util, Buffer, Date, RED, __node__, context, flow, global, env, setTimeout/…`. **`require` is not a sandbox key.** A bare `require(...)` throws `ReferenceError: require is not defined` — confirming #99's premise for this shipped version.
2. **Two distinct failure modes — not equally severe, correcting the assumption that both are "the same brick":**
   - **`libs`-array load failure** (`RED.import(module.module)`, lines 301–329): rejects → `node.error(...)` once → `throw`, caught only by the outer `.catch` at line 518, all inside the node's one-time construction `Promise.all`. `state` never leaves `RESOLVING`; `node.on("input", …)` (line 337) unconditionally queues every message into an array that is **never drained** because `processMessage` is never assigned. This is the true silent brick: no per-message error, no red dot, an unbounded live queue, two `node.error` lines logged once at construction.
   - **Bare `require()` inside function body**: fails per message at `node.script.runInContext(...)` (line 419), caught by `processMessage`'s own `.catch` (line 432), normalized and passed to `done(err)` — Node-RED's ordinary per-message error path (visible to Catch nodes / `node.error` counters / the existing "Record Error" function that feeds `global.error_counts`, `flows.json:10197`). Loud and repeats every message, but nothing queues forever — and this is the path today's three offenders actually hit.
   - **Correction:** the two history nodes' own outer `catch(e){ node.warn(...) }` uses `node.warn`, not `node.error` — invisible to `global.error_counts`. That, not a queued-forever node, is today's actual "quiet" failure. The queue-forever mode is reserved for what happens if `osi-lib` itself mis-declares its `libs` entry, which §A's design keeps at zero risk.
3. **Delivery surfaces, enumerated exactly.** Runtime `package.json` lists `osi-chameleon-helper, osi-chirpstack-helper, osi-cloud-http, osi-dendro-helper, osi-db-helper, osi-history-helper, osi-health-helper` as `file:` deps — `osi-history-sync-helper` absent. (`osi-history-helper`, var `osiHistory`, used by `History Rollup Tick`/`History API Router`, is a *different, already-registered* module — not touched or conflated here.) `98_osi_node_red_seed`'s copy loop enumerates the same seven, absent the eighth; separately it copies `codecs/` wholesale and top-level `settings.js`/`package.json`/`package-lock.json`/`flows.json` (first-boot-only guards). `deploy.sh` has an individual `fetch_required` pair per helper module and per codec file (including `agroscope_uplink_transform.js`) and fetches `settings.js` → `/srv/node-red/settings.js` **unconditionally on every deploy** (no first-boot guard) — no `osi-history-sync-helper` line exists anywhere in it. Conclusion: the Agroscope codec is fully deliverable today; `osi-history-sync-helper` is not deliverable through any existing surface.
4. **`settings.js` delivery (verification 2) — the hinted blocker does not hold.** `deploy.sh` delivers `settings.js` on every run, and it already sets `functionExternalModules: true` plus a non-empty `functionGlobalContext: { os, fs, cp }`. Adding one more key is a one-line, precedented change to a file `deploy.sh` actively ships. Option C (raw `functionGlobalContext` injection) is **not** gated on a missing delivery surface — that premise does not survive verification.
5. **Deployment state (verification 4).** The two history nodes were introduced by `0035a48e`/`b229e20e` (2026-06-28 17:12/17:15). The last recorded live deploy (`deployment-history.md`) is `ab4f5317` to kaba100 at 2026-06-28 15:59 — `git merge-base --is-ancestor 0035a48e ab4f5317` confirms it predates them. `Forward Agroscope Dendro` landed via `4d25937f` (2026-07-07, today, PR #110), newer than any recorded deploy. No repo/memory evidence places any of the three on a live gateway; this can't be fully proven without SSH (out of scope here) and is stated as the honest bound on the evidence, not certainty.

## Design

### A. Loading mechanism — resolving the #99-vs-DD2 tension

Issue #99 recommends plain `libs` conformance for the two history nodes. DD2/D1 recommends a `functionGlobalContext`-injected `osi-lib` choke point. Verification 4 clears settings.js delivery for both, so the decision is not about deliverability — it's which mechanism contains failure correctly for every current *and future* seam module.

**Decision: (b) `osi-lib` as itself a `libs`-declared module, exposing `osiLib.require(name)` with try/catch + quarantine inside it.** Not (a) plain `libs` per node, not (c) raw `functionGlobalContext` injection per module.

- **(a) rejected:** fixes today's three nodes but nothing else — each future seam repeats the three-surface registration dance with its own uncoordinated `RED.import`, and a load failure there is the queue-forever mode from §Verified-2. Solves #99 literally, leaves DD2's actual target (the mechanism gap) open.
- **(c) rejected:** deliverable, but pushes require/try-catch discipline onto every node author and every settings.js edit — the same "every call site re-implements the guard" problem Option A was rejected for, moved up one layer. Worse: `functionGlobalContext` values evaluate once, synchronously, when `settings.js` loads — an unguarded failure there fails Node-RED's own bootstrap, before any flow runs. Strictly worse blast radius than one bricked node.
- **(b) chosen:** `osi-lib` registers exactly like the 126 existing `libs` modules — one `package.json` entry, one seed-loop entry, one `deploy.sh` fetch pair, zero new plumbing. Every consuming node adds one `libs` entry (`{"var": "osiLib", "module": "osi-lib"}`). `osi-lib` itself is pure Node (no deps), so its own load can only fail from a packaging bug the registration-parity guard (§D2) catches pre-merge. `osiLib.require(name)` does the try/catch, caches success, returns a typed result — quarantine logic lives in exactly one file, reused by every future seam.

**Migration:**
- `Build History Batch` / `Mark History Batch ACK`: replace the bare `require('/usr/share/node-red/osi-history-sync-helper')` with `const helper = osiLib.require('history-sync');` (unwrap the `{ok, value}` result per §C) and add `{"var": "osiLib", "module": "osi-lib"}` to `libs` alongside the existing `osiDb` entry. Module content is untouched; only the load path changes — and the path change is itself a second fix: the old target was `/usr/share/node-red/…`, the read-only image tree that `deploy.sh` never writes (verified: all 25 of its node-red fetch targets are under `/srv/node-red`, zero under `/usr/share`), so even where the bare require "worked" it would pin the image-baked helper version forever, ignoring every subsequent deploy. `NAME_TO_PATH` resolving under `/srv/node-red` (the deploy-updated runtime tree, seeded from `/usr/share` at first boot) is a staleness fix as well as a loading-mechanism change.
- `Forward Agroscope Dendro`: replace its try/catch require block with `const r = osiLib.require('agroscope-uplink-transform'); if (!r.ok) { node.error('Agroscope transform unavailable: ' + r.error, msg); return null; }` and add `osiLib` to its currently-empty `libs`. Path resolves to the same `codecs/agroscope_uplink_transform` file, whose own wholesale-copy + `deploy.sh` fetch is unchanged.

**Packaging registration for `osi-history-sync-helper`** (closes the actual #99 gap, independent of which node loads it): add `"osi-history-sync-helper": "file:osi-history-sync-helper"` to both profiles' runtime `package.json`; add it to `98_osi_node_red_seed`'s module loop; add its `package.json`+`index.js` `fetch_required` pair to `deploy.sh` (mirroring `osi-history-helper`'s pattern). The module needs a new `package.json` (`{"name": "osi-history-sync-helper", "version": "1.0.0", "private": true, "main": "index.js"}`) — it has none today.

`osi-lib` is a new module directory, `.../usr/share/node-red/osi-lib/` (`index.js` + `package.json`), registered the same three ways, byte-identical across both profiles.

### B. `osi-lib`'s internal shape

```js
// osi-lib/index.js — pure Node, zero runtime deps, must never itself fail to load.
const path = require('path');
const BASE = process.env.OSI_LIB_BASE || '/srv/node-red';           // test override; Pi default
const COOLDOWN_MS = Number(process.env.OSI_LIB_COOLDOWN_MS || 30000); // test override
const NAME_TO_PATH = {
  'history-sync': 'osi-history-sync-helper',                         // helper module (§D2 three-surface check)
  'agroscope-uplink-transform': 'codecs/agroscope_uplink_transform', // codec (wholesale copy, §D2-exempt)
};
const cache = new Map();         // name -> loaded module (success only)
const cooldownUntil = new Map(); // name -> epoch ms of next retry attempt
function require_(name) {
  if (cache.has(name)) return { ok: true, value: cache.get(name) };
  const now = Date.now();
  if (now < (cooldownUntil.get(name) || 0)) return { ok: false, error: 'quarantined, retry after cooldown', quarantined: true };
  const rel = NAME_TO_PATH[name];
  if (!rel) return { ok: false, error: 'unknown osi-lib module: ' + name };
  try {
    const mod = require(path.join(BASE, rel)); // eslint-disable-line global-require
    cache.set(name, mod);
    cooldownUntil.delete(name);
    return { ok: true, value: mod };
  } catch (err) {
    cooldownUntil.set(name, now + COOLDOWN_MS);
    return { ok: false, error: String(err && err.message || err) };
  }
}
module.exports = { require: require_, NAME_TO_PATH }; // NAME_TO_PATH exported so §D2's verifier and tests enumerate seam modules without parsing source
```

Call sites: `const r = osiLib.require('history-sync'); if (!r.ok) { /* §C */ } const helper = r.value;` — a two-line change per site, within the ~2 KB thin-adapter ceiling later ratchets will enforce. The `OSI_LIB_BASE`/`OSI_LIB_COOLDOWN_MS` env overrides make `osi-lib` testable off-device (relative map entries resolve against a fixture directory instead of the Pi-only `/srv` tree; cooldown shrinks to milliseconds under test). A co-located `node --test` suite (`osi-lib/index.test.js`) covers: load success + cache hit, unknown name, load failure → `{ok:false}` with the error message → cooldown honored (second call returns `quarantined: true` without touching the fs) → retry succeeds after expiry, and the result-object shape (`ok`/`value`/`error`/`quarantined`). Wired into CI — `osi-lib` is the one module whose load-correctness every later seam leans on, so it does not ship untested.

### C. Quarantine semantics

- **HTTP-shaped call sites** (none of today's three, but the rule Phase 2/4's HTTP seams cite): on `!r.ok`, set `msg.statusCode = 503; msg.payload = { error: 'module_unavailable', module: name, message: r.error };`, `return [null, msg]` — matching the existing house pattern (e.g. device-provisioning's `msg.statusCode = 503` for an unmapped device type). Never a dead node.
- **Non-HTTP paths** (today's three): on `!r.ok`, call `node.error('<node> unavailable: ' + r.error, msg)` — deliberately `node.error`, not `node.warn` (the bug in the *existing* history nodes' outer catch), so the Catch-node → Record Error → `error_counts` chain sees it — then `return null`.
- **`error_counts` wiring:** `osi-lib` stays context-free (no Node-RED globals reachable from a plain `require`d file) and never calls `global.set` itself; the calling node's `node.error(...)` is what already feeds `global.error_counts.total`/`.last` via the existing Record Error function. Item 0.2's heartbeat reads `error_counts.total` into `errors_total` — no change needed here for that to keep working.
- **Per-module quarantine: 30 s cooldown, not permanent, not retry-every-call.** Node's own `require` never caches a throwing load, so without a cooldown every message re-pays the failure cost — cheap per call but unbounded under load, and a permanently-missing file would be probed forever for no benefit. 30 s bounds retry rate while still self-healing within one verification cycle if the cause (partial deploy, transient fs hiccup) clears. Not coupled to any other system constant; a one-line change if the field shows it's wrong.

### D. The ratchet — flip `verify-sync-flow.js`

**Replace** (not delete) the positive assertion at `scripts/verify-sync-flow.js:1455` with pins on the NEW sanctioned pattern — `osiLib.require('history-sync')` for `Build History Batch`, plus the matching pin for `Mark History Batch ACK`. A second, unenumerated positive assertion exists in `scripts/verify-agroscope-uplink-transform.js:120-123` (local-only, not wired into any CI workflow — landed with PR #110); it flips to a `libs`-entry assertion in the same commit to keep the local verifier honest. The ban itself: extend the `GUARDED_MODULE_VARS` scan area with a hard-ban check — factored into a requireable module (`scripts/flows-bare-require-scan.js`) invoked from inside `verify-sync-flow.js` (still that gate, no separate CI entry) so the mandated test vectors can import it; `osiLib` joins `GUARDED_MODULE_VARS`. A hard ban rather than a new baseline-file scoreboard: flows.json is already fully parsed node-by-node in this script, and "no bare non-builtin require" is a zero/nonzero fact, not a decreasing quantity DD3's baseline-file style (built for size ratchets) fits.

```js
// Ban bare require() of anything but a Node.js builtin in function-node bodies;
// the lookbehind exempts member-access calls (osiLib.require(...) — the sanctioned path).
const NODE_BUILTINS = new Set(require('module').builtinModules);
const BARE_REQUIRE_PATTERN = /(?<![\w$.])require\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const node of flows) {
  if (node.type !== 'function') continue;
  for (const m of String(node.func || '').matchAll(BARE_REQUIRE_PATTERN)) {
    if (NODE_BUILTINS.has(m[1])) continue; // require('crypto') etc. — already guarded above
    fail(`function node ${node.name || node.id} bare-requires '${m[1]}' — load via osi-lib.require(...) declared in libs`);
  }
}
console.log('OK no function node bare-requires a non-builtin module');
```

The lookbehind `(?<![\w$.])` is load-bearing: without it the substring `require('history-sync')` inside `osiLib.require('history-sync')` matches, and the ratchet fails the very nodes this item migrates. To pin that false-positive class (not just fix it), the ratchet ships with test vectors — house pattern `verify-no-stray-ddl.test.js`: a migrated-node body containing `osiLib.require('history-sync')` asserted to PASS, a synthetic bare `require('/srv/node-red/x')` body asserted to FAIL (CI runs Node ≥18; lookbehind supported). Today's three offenders are the entire baseline; this item's migration (§A) reduces that to zero in the same PR that adds the ratchet, so it ships already green.

### D2. Registration-parity guard — close #99's root-cause class, not just this instance

#99's root cause was "module exists in the tree but is unregistered in the delivery surfaces" — `osi-lib` converts that from a silent brick into a runtime quarantine, but it would still be a field-discovered failure. A new CI verifier, `scripts/verify-helper-registration.js`, makes it a merge-time failure instead: for **every `file:` dep in the runtime `package.json`** and **every `NAME_TO_PATH` entry that resolves outside `codecs/`** (helper modules need the three-surface registration; `codecs/*` entries ride the wholesale copy/fetch and are exempt from the loop/dep checks, though their `deploy.sh` fetch line is still asserted), assert: (1) present in both profiles' runtime `package.json` **and `package-lock.json`** (lockfileVersion 3 needs its per-helper entries — a surface #99 names that the round-1 spec omitted), (2) present in `98_osi_node_red_seed`'s module-copy loop, (3) present in `deploy.sh`'s `fetch_required` list, and (4) the module directory exists and contains a `package.json` plus its declared `main` file. Wired into CI alongside the existing verifiers. This makes the next seam module (Phase 2 dendro) unable to repeat #99 at merge time.

### E. Scope boundary

The 126 existing `libs`-declared nodes (`osiDb`, `bcryptjs`, `crypto`, …) are **not** migrated onto `osi-lib` — they already conform, carry no bare-require risk, and program governance is convert-on-touch; `osi-lib` is additive, not a replacement. **Rule for future seams** (Phase 2's Daily Dendrometer Analytics, Get Zone Environment Summary; Phase 4's History API Router): any newly extracted module MUST load via `osiLib.require(name)`, registered in `NAME_TO_PATH` and packaged through the three existing delivery surfaces — never a raw path `require` and never a direct `functionGlobalContext` entry. This is the rule those specs cite, not re-derive.

## Non-goals

- Migrating any of the 126 existing `libs`-declared nodes onto `osi-lib` (§E).
- Building DD3's ratchet trio (node-size ceiling, total-JS scoreboard, thin-node heuristic — program item 1.A2, separate spec).
- Backfilling `node --test` for `osi-history-helper` (item 1.A3, depends on this item, separate work).
- Changing `error_counts`'s schema, the heartbeat's `errors_total` field, or the canary gate (item 0.2) — this item only ensures failures flow into the existing chain unchanged.
- Changing `Forward Agroscope Dendro`'s feature flag, or rewriting `osi-history-sync-helper`'s / `agroscope_uplink_transform`'s internals — behavior-preserving load-path migration only.

## Definition of Done

- `osi-lib` module (`index.js` + `package.json`) under both profiles, registered in `package.json` + `package-lock.json`, `98_osi_node_red_seed`, `deploy.sh` — byte-identical across profiles.
- `osi-history-sync-helper` gets a `package.json` and registration in all surfaces (package.json + package-lock.json, seed loop, deploy.sh) — closes the actual #99 gap.
- All three nodes migrated to `osiLib.require(name)` with `osiLib` added to their `libs`; zero bare non-builtin `require(` remains in either profile's `flows.json`.
- `verify-sync-flow.js`'s line-1455 assertion replaced with `osiLib.require` positive pins (both history nodes); the Agroscope verifier's positive assertion flipped likewise; the bare-require-ban (§D, member-access lookbehind, requireable scan module) added, green with zero exceptions; ratchet test vectors (migrated-node body PASSES, synthetic bare-require body FAILS) in a co-located `.test.js` per the `verify-no-stray-ddl.test.js` house pattern.
- `scripts/verify-helper-registration.js` (§D2) added and wired into CI: every runtime `file:` dep and every non-codec `NAME_TO_PATH` entry verified against all three delivery surfaces + module-dir completeness, both profiles — green.
- `osi-lib/index.test.js` `node --test` suite (§B: success/cache, unknown name, failure→cooldown→retry-after-expiry, result shape) green in CI via the `OSI_LIB_BASE`/`OSI_LIB_COOLDOWN_MS` overrides.
- Both profiles byte-parity for every changed file. Frozen `sync-init-fn` untouched (no history-sync/Agroscope node is on that boot path).
- **This item merges before program item 0.1 deploys current `main` to any demo gateway.** Per verification 5, the history-sync path is undeployed today; if 0.1 ships first, it ships a known-dead path (loud-but-swallowed per-message failures, invisible to `error_counts` because of the existing `node.warn` bug) to a live gateway — a live-incident repair, not a pre-merge fix. Verification 5 is SSH-unconfirmed, so this is treated as a hard merge-order dependency rather than a gamble.

## Open decisions resolved inline

- **Mechanism: (b), `osi-lib` as a `libs`-declared module** — §A, over plain `libs`-per-node (doesn't generalize to Phase 2) and raw `functionGlobalContext` injection (an unguarded failure there fails Node-RED's own bootstrap).
- **`osi-history-sync-helper` packaging** — §A: register through the same three surfaces every other helper uses; add its missing `package.json`.
- **Quarantine cooldown: 30 s, in-process, resets on restart; env-overridable for tests (`OSI_LIB_BASE`/`OSI_LIB_COOLDOWN_MS`, §B)** — §C, bounds retry cost without permanently silencing a transient hiccup; the overrides make the `node --test` suite a DoD item, not an afterthought.
- **`error_counts` wiring: no new counter path** — §C; `osi-lib` stays context-free, calling nodes' `node.error(...)` feeds the pre-existing chain item 0.2 already reads.
- **Ratchet shape: extend the existing scan loop with a hard ban, not a new baseline-file scoreboard** — §D; this is a zero/nonzero fact, not a decreasing quantity. The regex carries a `(?<![\w$.])` lookbehind so `osiLib.require(...)` (the sanctioned pattern) never matches, pinned by test vectors.
- **Registration-parity guard: yes, as its own verifier (§D2)** — `osi-lib` turns #99's root cause (in-tree but unregistered) from a silent brick into a runtime quarantine, but only the CI guard turns it into a merge-time failure; codecs are exempt from the loop/dep checks because they ride the wholesale copy.
- **Rollout interaction: hard merge-order predecessor to 0.1** — DoD, based on verification 5's evidence (undeployed on all recorded gateways), with the explicit caveat that SSH confirmation was out of scope and the conclusion is a safe-assumption default.
