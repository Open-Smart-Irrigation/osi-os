# AgroLink walkthrough fix wave 1 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Review history

- **v1** — planner draft, 2026-08-18.
- **v2** — after Fable adversarial review, 2026-08-18. Applied, one line each:
  - **B-1** (A4 `no_response`): dropped the DB CHECK-violating status value and the periodic-sweep node entirely; "no response" is now derived client-side from `pending_identify` age, marked pending Phil confirmation.
  - **B-2/B-3** (A6 replan): rewrote around option (b) — a real additive `devices.sdi12_value_count` column, migration `0047`, and a corrected normalizer/fixture/runner design, marked pending Phil confirmation of (b) vs (c).
  - **B-4** (Wave D cloud deploy): replaced the invented bare `docker compose` command with the actual agro-link.ch production-VM git-bundle + `-p agrolink` + three-`-f` compose flow.
  - **B-5** (flows gate coverage): added the wire/silent-catch/stray-DDL/bare-require/MQTT-topic guard scripts to every `flows.json` task's gate, plus a before/after `outputs`/`wires` dump requirement for A4.
  - **R-1**: fixed A1's test-harness references (real path, `flowState` option key, real seed users, unexported helper duplication note).
  - **R-2**: fixed A3's button-label query (`Detect probe`, not `identify`) and switched the fix to the codebase's `getApiErrorMessage` helper.
  - **R-3**: fixed A5's test-file conventions (mock `services/api` + `react-i18next`, query the i18n key not the rendered string).
  - **R-4**: corrected B1's false claim that `TEKTELIC_CLOVER` is already a declared Java constant.
  - R-5: the A4 `datetime()` timeout-comparison bug — moot, the whole periodic-sweep step it lived in was deleted under B-1.
  - **R-6**: corrected B2's false claim that `SUPPORTED_FARM_DEVICE_TYPES` drives the add-device modal.
  - **R-7 / R-8**: fixed C1's guard test to import from `vitest` explicitly (no `globals: true` in the cloud config) and to assert the positive `max-w-[1600px]` pin, not just the negative `max-w-7xl` absence.
  - **R-9**: corrected Wave D's catalog post-deploy count (7, or 8 with B3 — not 6).
  - **R-10**: rewrote C2 around an exported `TAB_SIZING` constant, a relative-ordering assertion instead of a weakly-vacuous absolute one, and a corrected (role: `link`) cloud Settings query.
  - **R-11**: fixed A2's first test case, which 401ed and threw a `TypeError` in both pre- and post-fix code (not a real regression check).
  - **R-12**: added the A3→A4→A5 / A1-cloud serialization note to the parallelism guidance.
  - **D2 reframing**: replaced the false "no artifact anywhere" claim with the actual sync-contract evidence (`resources.schema.json` already lists `MILESIGHT_UC512`/`UC512_OPEN_FOR_DURATION`; the edge write path is fully wired) — the real gap is cloud `DeviceType`/applier support, not hardware provisioning.
  - **Advisory**: fixed a garbled paragraph in A1's D2-conditional bullet; added the "identify always ends `unmatched` on real hardware pre-`identityMatch`" note to A4 and Wave D's e2e checks.

**Goal:** Clear the six code-verified walkthrough findings (F1–F6) plus one housekeeping check (F7) found during the 2026-08-17/18 AgroLink walkthrough prep, so the two-account walkthrough has a working SDI-12 registration/identify path, a cloud catalog that isn't second-class for four of the edge's eight device types, and a header where the tabs read as the primary navigation.

**Architecture:** No new subsystems. Every task is a repair inside an existing surface: edge `flows.json` function nodes, one edge node-red library module (`osi-sdi12-normalize`), edge/cloud React components, and one cloud Spring controller + one cloud Java constants class. The one structural change is F6, which moves SDI-12 "expected value count" from a fixed profile constant to a per-device value learned at probe identification.

**Tech Stack:** Node-RED function nodes (Node.js, `node --test`), React + TypeScript + Vitest (both repos), Spring Boot + JUnit5/Mockito/AssertJ (cloud backend).

**Spec:** No standalone spec document exists for this wave — the six findings below (F1–F6, plus housekeeping F7) are the spec, each re-verified against current code by two read-only investigation passes on 2026-08-18. Where investigation found the original finding wording imprecise or wrong, this plan states the corrected version and flags the discrepancy explicitly.

**Repos:**
- Edge: `/home/phil/Repos/osi-os-agrolink`, branch `AgroLink`, HEAD `bbf71779` at plan-writing time (re-check `git log -1` before executing — this branch moves).
- Cloud: `/home/phil/Repos/osi-server/.worktrees/agrolink`, branch `feat/journal-cloud-primary`, HEAD `39a2abe4` at plan-writing time.

Edge task paths are relative to the edge repo root; cloud task paths relative to the cloud worktree root. This plan file lives in the edge repo (`docs/superpowers/plans/`) because AgroLink plans for both repos do.

---

## Global constraints

Carried forward from `docs/engineering-playbook.md` and the two repos' own conventions. Every task's requirements implicitly include this section.

**Both repos**

- Each task commits separately, TDD order (failing test → implementation → passing test), one commit per task.
- **At most one frontend build at a time, ever, on this workstation** (zram swap, no disk fallback — concurrent frontend builds OOM it). Every task below runs *tests* only, never `npm run build` / `vite build` / a bare `./gradlew build`. The one exception is Wave D's deploy stage, and even there only one build runs at a time, sequenced.
- No push, no deploy, no SSH to a gateway or a cloud host until Wave D, and Wave D itself only after every code-phase task is green and reviewed.
- Every check must be provable able to fail. Where a task's "run to see it fail" step is only "read the code and confirm the bug", that is because a fresh regression test is being added in the same task specifically to make the failure reproducible before the fix lands — never skip that step to save time.

**Edge (`osi-os-agrolink`)**

- **bcm2712 is the edit source; bcm2709 is a byte-identical mirror.** Any `flows.json` task edits both `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and the bcm2709 mirror at the same path under `..._bcm2709/...`. `scripts/verify-profile-parity.js` enforces byte-identity of payload files across the two profiles — run it after any edit that touches a mirrored path.
- **`flows.json` edits follow the `osi-flows-json-editing` skill** (`.claude/skills/osi-flows-json-editing/SKILL.md`). Load it before touching the file. Edits are a one-shot Node script in the scratchpad — parse, mutate with a `replaceOnce`-style exact-string swap, `JSON.stringify(flows, null, 2) + '\n'`, write both profile copies. Never an Edit-tool string replacement inside `flows.json` — the file is one JSON blob and function-node bodies are JSON-escaped single lines; a string-replace tool cannot safely target inside them.
- **Wire-alignment hazard.** A past wire off-by-one in a `flows.json` edit shipped a scoped-access bypass that reached production. Every task below that edits `flows.json` calls this out again individually and requires: (1) a byte-identical no-op roundtrip check before mutating (parse → stringify → diff against original must be empty), (2) `node scripts/verify-flows-fn-parse.js` after mutating (parses every function node's body as JS — a syntax error here is exactly the class of defect that shipped the bypass), (3) `node scripts/verify-sync-flow.js` (pins expected substrings inside named nodes — if it does not need updating for a task, its being green after your edit means you touched the node you meant to and no other), and (4) `node scripts/verify-scoped-access.js`. None of these tasks touch access-control wiring directly, but the hazard is generic to any flows.json edit — a stray comma or bracket can silently rewire a `wires` array.
- **The flows gate (v2, B-5 addition).** The four commands above are necessary but not sufficient — none of them catch a bare `require()` outside the sanctioned `osiLib.require()` shim, a silently swallowed `catch {}` newly introduced in a function node, an ad hoc DDL string, or a wiring change the wire-guard test suite itself is meant to exercise. Every task below that edits `flows.json` (A1, A2, A4, B3) runs the full nine-command **flows gate**, not just the four wire-alignment commands:
  ```bash
  node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js && \
  node scripts/verify-flows-size-ratchet.js && node scripts/verify-profile-parity.js && \
  node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && \
  node scripts/verify-no-stray-ddl.js && node scripts/flows-bare-require-scan.js && \
  sh scripts/check-mqtt-topics.sh
  ```
  (All nine scripts confirmed present in this checkout 2026-08-18; if a name has since changed, `ls scripts/` and use the real one — do not silently drop a check because a name doesn't match.) Every task below that says "run the flows gate" means this full nine-command set. For **Task A4 specifically**, additionally print a before/after `outputs`/`wires` dump for every touched node (`python3 -c "import json; ..."` printing each node's `outputs` count and `wires` array pre- and post-mutation) — A4 adds a genuinely new link-out, which is exactly the wiring-shape change class the production bypass came from, so the diff must be visually inspectable, not just gate-green.
- **The size ratchet is measure-and-raise, never regenerate wholesale.** `scripts/verify-flows-size-ratchet-allowances.json` pins an absolute `max_chars` per function node and a per-profile `max_total`. Any growth (comments included) fails `node scripts/verify-flows-size-ratchet.js` unless the ceiling is raised first. Measure with the `scripts/flows-size-scan` module (see the exact invocation in Task A1), set the new value, and append the reason to the node's existing `reason` string. A node that shrank gets its ceiling lowered, not left stale.
- Frontend tests: `cd web/react-gui && node_modules/.bin/vitest run <path>` for iteration; the pass gate is `cd web/react-gui && npm run test:unit` (never a bare `npx vitest run` — global `npx` lacks jsdom on this workstation and the command also skips the `tsx --test` half of the suite). Typecheck gate: `npm run typecheck`.
- i18n: `web/react-gui/public/locales/{de-CH,en,es,fr,it,lg,pt}/` — 7 locales, per-namespace JSON files. Any new GUI string needs all 7. `lg` (Luganda) entries in a new-string task are machine-drafted and must carry an inline `// TODO(lg): human-native review` style flag in the plan's evidence (the JSON files carry no comments — flag it in the commit message and this plan's checklist instead).
- Edge backend tests: `node --test scripts/<file>.js`.

**Cloud (`osi-server` agrolink worktree)**

- Backend, iterating and as the pass gate for a scoped `--tests` run: `cd backend && ./gradlew test --tests '<pattern>' -x buildFrontend -x buildTerraIntelligenceFrontend`. The two `-x` flags are not optional — a bare `./gradlew test` triggers two frontend builds (the concurrent-build OOM case). A full unscoped sweep is out of scope for this plan; each cloud task's gate is its own `--tests` pattern.
- `./gradlew --stop` after any Docker/environment change (Testcontainers ITs need `api.version=1.44` in `~/.docker-java.properties`, already present on this workstation per prior verification).
- Frontend: `cd frontend && npm run test:unit` as the pass gate; `node_modules/.bin/vitest run --environment jsdom src/<path>` for iteration only.
- Cloud i18n: `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/` — same 7 codes.
- Never edit the main (non-worktree) `osi-server` checkout.

---

## Decisions required (Phil — resolve before executing Wave B/C)

### D1 — `--primary` token (blocks nothing in Wave A; blocks Wave C task C2's full scope)

**Finding, confirmed in both repos byte-identically:** `ui-core/tokens.css:23` defines the light-theme `--primary: #2563EB;` (blue). Both `AppHeader.tsx` files also define a **dark-theme** `--primary: #2DD4BF;` (teal) at their own line 131. `--primary` drives both the chrome (Settings/Account buttons via `LIQUID_BUTTON`) and a large share of body content (links, focus rings, primary actions) — which is the seam Phil has already flagged: body-vs-chrome visually compete because they share one token doing two jobs.

This decision is **separate from Task C2** (tab-vs-chrome visual scale). C2 proceeds either way; do not let the executor fold this decision into C2's diff.

- **Option A — `--primary` becomes brand red.** One token, one meaning, changes everywhere it's used (chrome buttons, links, focus rings, primary actions) in one edit. Lowest engineering cost; highest risk of an surprising a body-content pattern nobody re-reviewed (e.g. a link color choice made when blue was assumed).
- **Option B — primary actions stop consuming `--primary`.** Introduce a second token (e.g. `--action` or `--cta`) for body primary-action buttons and links, leave `--primary` scoped to chrome only (or rename it `--chrome-accent`). Higher engineering cost (a grep-and-swap across every body-content consumer, both repos), but the chrome/body seam becomes structurally impossible to reintroduce later, since the two surfaces no longer share a token by construction.

**Recommendation:** Option B. The chrome-vs-body seam is a "one source of truth used for two facts" pattern — the exact class of bug `docs/engineering-playbook.md` §1 rule 4 warns drifts. Option A is a faster visual fix but leaves the same two-facts-one-token problem in place with a different color. This is Phil's call; no task in this plan implements either option — file it as a follow-up plan once decided.

### D2 — `MILESIGHT_UC512` support-or-drop for this wave

**The briefing's premise needs a second correction, found on re-review.** The plan's first pass claimed "no artifact anywhere in the cloud repo references `MILESIGHT_UC512`" — that is false. `backend/src/test/resources/sync-contract/resources.schema.json:149` already enumerates `MILESIGHT_UC512` in the `Device.type_id` enum (alongside `DRAGINO_SDI12`), and `commands.schema.json:81` already declares `UC512_OPEN_FOR_DURATION` as a valid command type. So the sync *contract* already treats `MILESIGHT_UC512` as a real, expected device type — the cloud repo is not silent on it.

What genuinely is missing, confirmed by direct search: no `DeviceType.MILESIGHT_UC512` Java constant, no `getCatalog()` entry, no `frontend/src/components/farming/deviceRegistry.tsx` entry — i.e. no `DeviceType`/applier support in the cloud's own device layer, even though the sync *contract surface* already expects the type to exist. Combined with the edge side — `post-devices-insert`'s `appMap`/`profileMap` already map `MILESIGHT_UC512` to `CHIRPSTACK_APP_ACTUATORS`/`CHIRPSTACK_PROFILE_UC512`, a full UC512 Normalize+Write node exists (`6b28e0d879808dd9`), a catalog-response entry, a ChirpStack bootstrap profile, and edge migration `0010` — the edge-side plumbing is essentially complete. The narrow-waist plan (`2026-07-12`, line 362) states explicitly that UC512 telemetry sync to the cloud was **intentionally deferred to phase 3.4's server applier** — this reads as a known, planned gap, not evidence of "historically unprovisionable" hardware.

Net: the gap this wave would be filling is **cloud `DeviceType`/applier support catching up to a sync contract that already expects the type**, not "bringing an unprovisionable device online." The "historically unprovisionable" claim in the original briefing still could not be traced to any code artifact — the one relevant hit remains a *different* device, `MCLIMATE_UC512` (MClimate T-Valve, per `frontend/src/components/farming/__tests__/deviceRegistry.parity.test.tsx:64-65`, which explicitly excludes `MCLIMATE_UC512` from `DEVICE_SECTIONS`) — a name collision with the briefing's "UC512," not the same device. **Confirm with Phil before this plan's Task B3 proceeds on either branch of this decision** — specifically, whether "unprovisionable" was ever a bench-verified hardware fact, or a mix-up with MClimate, or simply shorthand for "the phase-3.4 gap the narrow-waist plan already called out."

- **Option A — bring `MILESIGHT_UC512` to parity this wave.** Add the Java constant, catalog entry, frontend registry entry (registration-only is fine — no dedicated card component exists yet, matching the already-accepted deferred-GUI-surface precedent this plan sets for `DRAGINO_SDI12` in Task B2), and the missing edge `cs-reg-cloud-fn` appMap/profileMap/joinEuiMap entries. Task B3 as written executes.
- **Option B — drop it from this wave.** Leave the edge's existing (already-working) local-registration support as-is, do not touch the cloud side, and file a follow-up issue once the "unprovisionable" claim is either confirmed or refuted at the bench. Task B3 becomes N/A; skip it.

**Recommendation:** Option B, provisionally — the "unprovisionable" claim, if real, is a bench-verified hardware fact this plan's author cannot verify from source, and shipping cloud-catalog support for a device that cannot actually be provisioned would be worse than the current second-class status (it would fail visibly instead of being simply absent). If Phil confirms the claim was a mix-up with MClimate, switch to Option A — the edge-side plumbing is already 90% done, per the finding above.

---

## Ledger — findings to tasks

| Finding | Tasks | Wave |
|---|---|---|
| F7 (housekeeping) | 0.1 | 0 |
| F5 (a, b persist + identify self-heal), F5 (d edge appMap gap) | A1, A2 | A |
| F5 (c modal error swallowing) | A3 | A |
| F5 (e auto-identify + honest-wait UX) | A4 | A |
| F4 (SDI-12 card missing remove) | A5 | A |
| F6 (Sentek/HydraScout/PR2 fixed-count) | A6 | A |
| F3 (cloud catalog, safe subset) | B1 | B |
| F3 + F5 (d cloud-visible DRAGINO_SDI12) | B2 | B |
| D2 (MILESIGHT_UC512), conditional | B3 | B |
| F1 (cloud container widths) | C1 | C |
| F2 (tab prominence) | C2 | C |
| — | Lockstep deploy + post-deploy verification | D |

Waves A, B, C are independent of each other and may run in parallel by repo/subsystem, **except**: Task B2 has a hard dependency on Task A1 (a cloud catalog entry for `DRAGINO_SDI12` is only safe to ship once the edge can actually provision one via the cloud command path — see B2's own note). Task C2 requires simultaneous, identical edits to both repos' `AppHeader.tsx` and is flagged as a cross-repo serialization point. Every other task is single-repo and can run in any order within its wave.

**R-12, added 2026-08-18 — within-Wave-A file-collision serialization.** A1's own test-harness dependency aside, A2-A5's parallelism claim needs one correction: A3 and A4 both edit `Sdi12SettingsModal.tsx`, and A4 and A5 both edit `Sdi12SoilCard.tsx` and all 7 `devices.json` locale files. Running any of these pairs as genuinely concurrent workers in the same checkout risks a merge collision or, worse, a silent partial-overwrite if both workers read-then-write the same file without re-reading each other's changes. **Serialize A3 → A4 → A5 in one checkout** (or, if using separate worktrees per the `superpowers:using-git-worktrees` skill, merge each one back before starting the next of that trio). A1, A2, and A6 do not share files with A3/A4/A5 and remain freely parallel with each other and with the A3→A4→A5 chain; A1 and A2 do share `sdi12-identify-action-fn`/`scripts/test-sdi12-registration.js`, so A2 should start after A1 lands (already implied by A2's own "builds on A1" framing) rather than run concurrently with it.

---

# Wave 0 — housekeeping

## Task 0.1 — F7 verification (no code change expected)

**Original claim:** a ChirpStack 4.12+ zero-key `verifyKeys` fix is live on gateway `agrolink-test-01` but uncommitted in the edge `feat/journal-cloud-primary` worktree, and needs porting onto the `AgroLink` branch before the next deploy reverts it.

**Verified 2026-08-18: the claim is stale. No porting task exists.**

Evidence:
```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep && git status && git diff --stat
# → "nothing to commit, working tree clean"; diff --stat empty.
```
The fix (`UNSET_KEY_ZEROS = '0'.repeat(32)`, `canonicalStoredKey()`, and the 4.12+ zero-readback handling) lives in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js` lines 327–339 and 660–662, in commit `7b75c4de` ("fix(chirpstack-helper): accept ChirpStack 4.12+ zero-key read-back in verifyKeys", 2026-08-12), which is a **common ancestor** of both `feat/journal-cloud-primary` and `AgroLink` — not something that landed on one branch and needs porting to the other. Confirm before executing:

```bash
cd /home/phil/Repos/osi-os-agrolink && git log --oneline | grep 7b75c4de
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep && git log --oneline | grep 7b75c4de
diff <(git -C /home/phil/Repos/osi-os-agrolink show bbf71779:conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js | sed -n '320,345p;655,665p') \
     <(git -C /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep show HEAD:conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js | sed -n '320,345p;655,665p')
# Expected: both git log greps print the commit; diff is empty.
```

**Task status: N/A. No steps, no commit.** If either repo's HEAD has since diverged and the diff above is non-empty, stop and re-scope this task before continuing to Wave A — that would mean the fix regressed on one branch, a different (higher-priority) problem than the one this plan was written to solve.

---

# Wave A — SDI-12 correctness cluster (edge)

All of Wave A is edge-only (`osi-os-agrolink`). Tasks A2–A5 build on A1 (chirpstack_app_id persistence); A6 is independent and can run in parallel with any of A1–A5.

## Task A1 — persist `chirpstack_app_id` on insert and update; add the two missing types to the cloud-command appMap

**Root cause, sharper than the original finding:** neither edge device-insert path ever writes the `chirpstack_app_id` column, even though both already **compute** the right ChirpStack application id in an `appMap` local variable and put it on `msg.deviceRegistration.applicationId` for the ChirpStack provisioning call itself. The column stays NULL forever except for the one node (`sdi12-post-reg-hook-fn`) that stages it only in-memory for an immediate post-registration identify — never to the DB. Consequence: `sdi12-identify-action-fn`'s `SELECT ... chirpstack_app_id FROM devices` is permanently NULL for every SDI-12 device after its very first (auto-triggered) identify, so **every subsequent identify request 409s deterministically** — this is the direct cause of F5.

Two nodes need the fix, because there are two insert paths:
1. `post-devices-insert` ("Insert or Claim Device") — local `POST /api/devices`. Its `appMap`/`profileMap` already have all 8 type_ids, including `DRAGINO_SDI12` and `MILESIGHT_UC512`.
2. `cs-reg-cloud-fn` ("CS Register (cloud cmd)") — the cloud-issued `REGISTER_DEVICE` command path. Its `appMap`/`profileMap`/`joinEuiMap` only have 6 entries — **missing `DRAGINO_SDI12` and `MILESIGHT_UC512`** (confirmed 2026-08-18; this is the real location of the briefing's "(d) CS Register (cloud cmd) appMap gap" — it is an edge flows.json node, not a cloud Java structure; no such Java appMap exists anywhere in the cloud repo).

**Files**
- Modify: both `flows.json` profiles, nodes `post-devices-insert` and `cs-reg-cloud-fn`.
- Create: `scripts/test-sdi12-registration.js` (new — no test currently exercises the registration→`chirpstack_app_id` round trip; closest existing coverage, `scripts/verify-device-integration.js`, only covers codec→normalizer→writer, not registration).
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`.

**Interfaces**
- Unchanged: `msg.deviceRegistration.applicationId`/`.deviceProfileId` (still computed from the same `appMap`/`profileMap`, still consumed by `chirpstack.createProvisioningClientFromEnv(env).ensureDeviceProvisioned(registration)`).
- Changed: both nodes' `INSERT`/`UPDATE` SQL strings gain a `chirpstack_app_id` column, set to `appMap[type_id]` (the same value already computed for `msg.deviceRegistration.applicationId`).
- Changed: `cs-reg-cloud-fn`'s `appMap`, `profileMap` gain `DRAGINO_SDI12` and `MILESIGHT_UC512` entries, mirroring `post-devices-insert`'s existing 8-entry maps exactly. **Decision D2 gates only the `MILESIGHT_UC512` half of this task, not `DRAGINO_SDI12`.** `post-devices-insert` is untouched by D2 either way — it already has all 8 entries today. Only `cs-reg-cloud-fn` is edited by this task: it always gains `DRAGINO_SDI12` (7 entries), and it additionally gains `MILESIGHT_UC512` (8 entries) only if D2 resolves to "bring to parity." If D2 resolves to "drop," omit the `MILESIGHT_UC512` lines below and leave `cs-reg-cloud-fn` at 7 entries.

**Steps**

- [ ] **Write the failing test.** Create `scripts/test-sdi12-registration.js`, following the fixture conventions of `scripts/test-scoped-access-writes.js`. **Corrected 2026-08-18 (R-1, verified against the real harness):** the shared harness lives at `scripts/lib/scoped-access-harness.js`, not a `./test-flow-harness` module — no such file exists. Its device-context option key is `flowState`, not `flowContext`. `seedScopedDb`'s seed users are `u-admin`, `u-res1`, `u-view1` — there is no `'seed-user-uuid'` row; use one of the real seed user uuids (`u-admin` for a REGISTER_DEVICE command test, matching the admin-issued-command precedent elsewhere in `test-scoped-access-writes.js`). The `REGISTER_ENV`/`applyRegister`/`fakeChirpstackLib` helpers this task needs already exist at `scripts/test-scoped-access-writes.js:2227-2323`, but that file does not export them — duplicate the exact same setup block into the new file rather than requiring it, and note in the new file's header comment that the two blocks must be kept in sync if the harness shape changes:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeFunction, loadNode, seedScopedDb } = require('./lib/scoped-access-harness');
// REGISTER_ENV / applyRegister / fakeChirpstackLib below are duplicated from
// scripts/test-scoped-access-writes.js:2227-2323 (not exported there) --
// keep in sync if that file's harness shape changes.

const ENV = { OSI_SCOPED_ACCESS: '1', DEVICE_EUI: '0016C001F1000001', CHIRPSTACK_APP_SENSORS: 'app-sensors-uuid', CHIRPSTACK_APP_ACTUATORS: 'app-actuators-uuid', CHIRPSTACK_PROFILE_SDI12: 'profile-sdi12-uuid' };

test('A1: post-devices-insert persists chirpstack_app_id on a fresh SDI-12 registration', async () => {
  const db = seedScopedDb();
  try {
    // Drive the node exactly as the local /api/devices POST handler chain does:
    // seed the flow-context values post-devices-insert reads instead of msg.payload.
    // (Read the node's source first -- it reads flow.get('new_device_*'), not msg.)
    // Fill in the exact flow.set(...) calls the upstream auth/validate node performs,
    // matching scripts/test-scoped-access-writes.js's existing device-registration tests.
    const response = await executeFunction(loadNode('post-devices-insert'), {
      msg: { payload: [] }, // no existing row
      env: ENV,
      db,
      flowState: {
        new_device_user_id: 1,
        new_device_deveui: 'A840410000000101',
        new_device_name: 'Bench SDI-12',
        new_device_type: 'DRAGINO_SDI12',
        new_device_appkey: '00000000000000000000000000000001',
      },
    });
    assert.equal(response.result[0].topic.includes('chirpstack_app_id'), true, 'INSERT SQL must set chirpstack_app_id');
    // Actually run the SQL against db and assert the persisted column, matching
    // the pattern scripts/test-scoped-access-writes.js uses for its own INSERT assertions.
    db.exec(response.result[0].topic);
    const row = db.prepare("SELECT chirpstack_app_id FROM devices WHERE deveui='A840410000000101'").get();
    assert.equal(row.chirpstack_app_id, 'app-sensors-uuid');
  } finally {
    db.close();
  }
});

test('A1: cs-reg-cloud-fn supports DRAGINO_SDI12 and persists chirpstack_app_id', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify({ commandType: 'REGISTER_DEVICE', params: { devEui: 'A840410000000102', name: 'Cloud SDI-12', deviceType: 'DRAGINO_SDI12', appKey: '00000000000000000000000000000002', userUuid: 'u-admin' } }) },
      env: ENV,
      db,
      libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => ({ ensureDeviceProvisioned: async () => ({}), close: () => {} }) } },
    });
    assert.equal(response.result[0].specialAck.result, 'SUCCESS', 'DRAGINO_SDI12 must no longer 503 as an unsupported type');
    const row = db.prepare("SELECT chirpstack_app_id FROM devices WHERE deveui='A840410000000102'").get();
    assert.equal(row.chirpstack_app_id, 'app-sensors-uuid');
  } finally {
    db.close();
  }
});
```

  **Executor note:** the exact shape of `executeFunction`'s options object (`flowState`, `libOverrides`, how `seedScopedDb` pre-populates the `users` table so `userUuid: 'u-admin'` resolves) must be copied from `scripts/test-scoped-access-writes.js`'s own REGISTER_DEVICE tests (search that file for `REGISTER_ENV`, `applyRegister`, `fakeChirpstackLib` at lines 2227-2323 — duplicate that exact setup block; the file does not export these helpers). Do not guess the harness shape — read the file before writing this test.

- [ ] **Run to see it fail:** `node --test scripts/test-sdi12-registration.js`
  Expected: `A1: post-devices-insert persists chirpstack_app_id...` fails because the INSERT string has no `chirpstack_app_id` column; `A1: cs-reg-cloud-fn supports DRAGINO_SDI12...` fails with `503`/`Unsupported device type or missing ChirpStack application/profile mapping` (the ACK's `result` is `FAILED`, not `SUCCESS`).

- [ ] **Load the `osi-flows-json-editing` skill**, then in the scratchpad write a one-shot Node script that:
  1. Reads both profile `flows.json` files, confirms they're byte-identical to each other before mutating (sanity check — if they've drifted, stop and investigate separately, don't paper over it).
  2. In `post-devices-insert`'s `func`, extends the INSERT and UPDATE SQL to carry `chirpstack_app_id`:

```js
// INSERT branch — column list gains chirpstack_app_id, values gains appMap[type_id]:
// before: "INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,current_state,target_state,gateway_device_eui,sync_version,deleted_at,created_at,updated_at,claimed_at) VALUES ('"
// after:  "INSERT INTO devices (deveui,name,type_id,user_id,irrigation_zone_id,current_state,target_state,gateway_device_eui,chirpstack_app_id,sync_version,deleted_at,created_at,updated_at,claimed_at) VALUES ('"
//         ... + effectiveGatewayDeviceEui + "','" + appMap[type_id].replace(/'/g, "''") + "',1,NULL,'" ...
```

  Do the same for the `existing` (UPDATE) branch: append `, chirpstack_app_id = '" + appMap[type_id].replace(/'/g, "''") + "'"` to the `SET` clause list (placed before `sync_version = `). Use `replaceOnce` against the exact current string (read the node's `func` first via `python3 -c "import json; ..."` or the flows-size-scan helper to get the byte-exact current text — do not hand-retype it, a single character mismatch means `replaceOnce` throws, which is the safety net, not a bug to work around).

  3. In `cs-reg-cloud-fn`'s `func`: add the two missing map entries (mirroring `post-devices-insert`'s existing values exactly) —

```js
// appMap gains (after AQUASCOPE_LORAIN):
  DRAGINO_SDI12: String(env.get('CHIRPSTACK_APP_SENSORS') || '').trim()
  // + MILESIGHT_UC512: String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim()  -- only if D2 = bring to parity
// profileMap gains:
  DRAGINO_SDI12: String(env.get('CHIRPSTACK_PROFILE_SDI12') || '').trim()
  // + MILESIGHT_UC512: String(env.get('CHIRPSTACK_PROFILE_UC512') || '').trim()  -- only if D2 = bring to parity
```

  and extend both the `INSERT OR IGNORE` and `UPDATE` SQL strings the same way as `post-devices-insert` (add `chirpstack_app_id` to the column list / `SET` clause, value `appMap[type_id]`).

  4. Re-serialize with `JSON.stringify(flows, null, 2) + '\n'`, write both profile files, then diff each against its pre-mutation copy and confirm only the two targeted `func` strings changed (no other byte moved) — this is the wire-alignment guard from Global Constraints, applied concretely.

- [ ] **Run to see it pass:** `node --test scripts/test-sdi12-registration.js` → exit 0.

- [ ] **Run the existing scoped-access suites to confirm no regression:** `node --test scripts/test-scoped-access-reads.js scripts/test-scoped-access-writes.js scripts/test-scoped-access-command-path.js` → all exit 0 (these are the suites that already exercise `post-devices-insert` and `cs-reg-cloud-fn` for other reasons; a new column in their SQL must not break any existing assertion about row shape).

- [ ] **Measure and raise the size ceilings.** From the repo root:

```bash
node -e "
const {nodeSizes, totalChars} = require('./scripts/flows-size-scan');
const fs = require('fs');
const f = JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8'));
const m = nodeSizes(f);
for (const id of ['post-devices-insert','cs-reg-cloud-fn']) console.log(id, m.get(id).chars);
console.log('total', totalChars(f));
"
```

  Set the two nodes' `max_chars` in `scripts/verify-flows-size-ratchet-allowances.json` to the measured values (not a round number above them), and bump `total_allowance.max_total` by the same net delta. Append `"A1: persist chirpstack_app_id; cs-reg-cloud-fn gains DRAGINO_SDI12(+MILESIGHT_UC512 if D2)"` to each touched node's `reason` string.

- [ ] **Run the flows gate** (the full nine-command set defined in Global Constraints, B-5) → all exit 0.

- [ ] **Commit:**
```bash
git add scripts/test-sdi12-registration.js scripts/verify-flows-size-ratchet-allowances.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix(sdi12): persist chirpstack_app_id on registration; cs-reg-cloud-fn gains DRAGINO_SDI12"
```

---

## Task A2 — identify self-heals legacy null `chirpstack_app_id` rows

Task A1 stops the bug for every *new* registration. It does nothing for SDI-12 devices already registered before A1 lands — their `chirpstack_app_id` is permanently NULL in the live DB (agrolink-test-01, kaba100) and A1's fix never runs for them again. Those rows need a self-heal path: on the next identify attempt, if `chirpstack_app_id` is NULL, fall back to resolving it from `env.get('CHIRPSTACK_APP_SENSORS')` (SDI-12 devices only ever map to the sensors app — `DRAGINO_SDI12: CHIRPSTACK_APP_SENSORS` in both `appMap`s), validate it's non-empty, persist it, and proceed with identify instead of 409ing.

**Files**
- Modify: `flows.json` (both profiles), node `sdi12-identify-action-fn` ("Auth + Prepare SDI12 Identify").
- Modify: `scripts/test-sdi12-registration.js` (add the self-heal cases next to Task A1's tests).
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`.

**Interfaces**
- Consumes: `env.get('CHIRPSTACK_APP_SENSORS')` (already read elsewhere in the same file's other nodes, same access pattern).
- Changed: after the existing `SELECT deveui, type_id, chirpstack_app_id FROM devices ...` lookup, if `row.chirpstack_app_id` is falsy, resolve `fallbackAppId = String(env.get('CHIRPSTACK_APP_SENSORS') || '').trim()`; if empty, return the existing 409 unchanged (there is genuinely nothing to identify against — a missing env var is a runtime config problem this task does not paper over); if non-empty, `UPDATE devices SET chirpstack_app_id = ? WHERE deveui = ?` and use `fallbackAppId` as `msg.deviceRow.chirpstack_app_id` for the trigger node downstream.
- Unchanged: `sdi12-identify-trigger-fn`'s own 409 check stays as the final backstop — it still 409s if `msg.deviceRow.chirpstack_app_id` is empty after this node runs, which only happens now when `CHIRPSTACK_APP_SENSORS` itself is unset (a real runtime-config gap, not a stale-row bug).

**Steps**

- [ ] **Write the failing test.** Add to `scripts/test-sdi12-registration.js`:

**Corrected 2026-08-18 (R-11):** the original draft of the first test below set `OSI_SCOPED_ACCESS: '0'` with no `Authorization` header on `msg.req.headers`. Verified against `sdi12-identify-action-fn`'s actual auth branch: with scoped access off and no bearer token, the node returns a 401 and `response.result[0]` is `null` — so `response.result[0].deviceRow` throws a `TypeError`, in both the pre-fix and post-fix code. That is not a regression check on this task's change; it is a harness bug that would fail identically whether or not the self-heal exists. Use `OSI_SCOPED_ACCESS: '1'` instead (matching the second test's pattern below), which takes the scoped no-auth-required branch and actually exercises the self-heal logic:

```js
test('A2: identify self-heals a legacy row with NULL chirpstack_app_id', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, chirpstack_app_id, created_at, updated_at)
      VALUES ('A840410000000103', 'Legacy SDI-12', 'DRAGINO_SDI12', 1, NULL, '2026-01-01', '2026-01-01');
    `);
    const response = await executeFunction(loadNode('sdi12-identify-action-fn'), {
      msg: { req: { params: { deveui: 'A840410000000103' }, headers: {} } },
      env: Object.assign({}, ENV, { OSI_SCOPED_ACCESS: '1' }),
      db,
    });
    assert.equal(response.result[0].deviceRow.chirpstack_app_id, 'app-sensors-uuid');
    const row = db.prepare("SELECT chirpstack_app_id FROM devices WHERE deveui='A840410000000103'").get();
    assert.equal(row.chirpstack_app_id, 'app-sensors-uuid', 'the self-heal must persist, not just patch msg in flight');
  } finally {
    db.close();
  }
});

test('A2: identify still 409s when CHIRPSTACK_APP_SENSORS is unset (no fabricated fallback)', async () => {
  const db = seedScopedDb();
  try {
    db.exec(`
      INSERT INTO devices (deveui, name, type_id, user_id, chirpstack_app_id, created_at, updated_at)
      VALUES ('A840410000000104', 'Legacy SDI-12 2', 'DRAGINO_SDI12', 1, NULL, '2026-01-01', '2026-01-01');
    `);
    const response = await executeFunction(loadNode('sdi12-identify-action-fn'), {
      msg: { req: { params: { deveui: 'A840410000000104' }, headers: {} } },
      env: Object.assign({}, ENV, { OSI_SCOPED_ACCESS: '1', CHIRPSTACK_APP_SENSORS: '' }),
      db,
    });
    assert.equal(response.result[0].deviceRow.chirpstack_app_id, '');
    // sdi12-identify-trigger-fn is the node that actually 409s on empty appId;
    // this test only proves this node does not fabricate a value -- add a
    // second assertion chaining into loadNode('sdi12-identify-trigger-fn') with
    // this msg to prove the 409 still fires end to end.
  } finally {
    db.close();
  }
});
```

- [ ] **Run to see it fail:** `node --test scripts/test-sdi12-registration.js`
  Expected: `A2: identify self-heals...` fails with `chirpstack_app_id` equal to `''` or `undefined` instead of `'app-sensors-uuid'`, and the DB row is unchanged (still NULL).

- [ ] **Load the `osi-flows-json-editing` skill**, edit `sdi12-identify-action-fn`'s `func`: after the existing `row` lookup and the `type_id !== 'DRAGINO_SDI12'` check, insert the self-heal:

```js
var chirpstackAppId = String(row.chirpstack_app_id || '').trim();
if (!chirpstackAppId) {
  // Self-heal legacy rows: post-devices-insert/cs-reg-cloud-fn (before task A1)
  // never persisted this column. SDI-12 always maps to the sensors app -- never
  // fabricate a value when the env var itself is unset; the caller's 409 stays
  // the correct outcome for a genuine runtime-config gap.
  var fallbackAppId = String(env.get('CHIRPSTACK_APP_SENSORS') || '').trim();
  if (fallbackAppId) {
    await db.run("UPDATE devices SET chirpstack_app_id = ? WHERE deveui = ?", [fallbackAppId, deveui]);
    chirpstackAppId = fallbackAppId;
  }
}
msg.deviceRow = {
  deveui: String(row.deveui || '').toUpperCase(),
  chirpstack_app_id: chirpstackAppId
};
```

  replacing the existing unconditional `msg.deviceRow = { deveui: ..., chirpstack_app_id: String(row.chirpstack_app_id || '').trim() };` block. `replaceOnce` against the exact current text (byte-exact — pull it from the node before editing, do not retype from memory).

- [ ] **Run to see it pass:** `node --test scripts/test-sdi12-registration.js` → exit 0.

- [ ] **Measure, raise the ceiling for `sdi12-identify-action-fn` and `total_allowance.max_total`**, same procedure as A1, reason `"A2: self-heal legacy NULL chirpstack_app_id rows"`.

- [ ] **Run the flows gate** (the full nine-command set, as A1) → all exit 0.

- [ ] **Commit:**
```bash
git add scripts/test-sdi12-registration.js scripts/verify-flows-size-ratchet-allowances.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix(sdi12): self-heal legacy rows with NULL chirpstack_app_id on identify"
```

---

## Task A3 — surface the server's error message instead of a generic string

`Sdi12SettingsModal.tsx` has two bare `catch {}` blocks (`handleSave` line ~137, `handleIdentify` line ~153) that both discard whatever the server actually said and substitute a generic string — so the 409 from A1/A2's fix (or the DB save-failed / ChirpStack provisioning-failed messages from `cs-reg-cloud-fn`) never reaches the operator. Fix both in the same task; they're the identical anti-pattern in the same file.

**Files**
- Modify: `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx` (lines ~106-158).
- Modify/Create: `web/react-gui/src/components/farming/__tests__/Sdi12SettingsModal.test.tsx` (check first whether it exists; if so extend it, following its existing mock conventions for `putSdi12Config`/`postSdi12Identify`).

**Interfaces**
- Unchanged: `putSdi12Config(deveui, request)`, `postSdi12Identify(deveui)` — both already reject with an axios-shaped error whose `.response?.data?.message` carries the server's message.
- **Corrected 2026-08-18 (R-2):** the original draft cited `KiwiSensorCard.tsx:337`'s `err.response?.data?.message || t(...)` as the precedent to copy. Verified against the actual file: `getApiErrorMessage(error: unknown, fallback: string): string` already exists at `web/react-gui/src/services/api.ts:83` and is the newer, adopted pattern in this codebase (`LoRainGaugeCard.tsx`, `SenseCapWeatherCard.tsx`, `SettingsPage.tsx`, `pages/admin/{GrantsPage,UsersPage}.tsx` all use it) — it also checks `.detail`/`.error` and falls back to `error.message`, a strictly more robust read of the server response than the bare `err.response?.data?.message` the Kiwi-era code uses. Prefer `getApiErrorMessage` over the older pattern for this fix.

**Steps**

- [ ] **Write the failing test.** The existing `Sdi12SettingsModal.test.tsx` has no `renderModal()` helper — every test calls `render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />)` directly with the file's `device` fixture; follow that exact pattern, not a helper that doesn't exist. **The Identify button's accessible name is `'Detect probe'`, not `'Identify'`** (`Sdi12SettingsModal.tsx:251`, confirmed 2026-08-18 — the component's copy reads "Detect probe" / "Requesting…", and this file also has no `useTranslation` import at all: it is entirely hardcoded English, so no i18n mock is needed here, unlike Task A5's `Sdi12SoilCard`). Add to the test file:

**Executor note, found while writing this fix (not in the original review):** `getApiErrorMessage` gates its axios-shaped branch on `axios.isAxiosError(error)`, which checks a real `isAxiosError: true` flag axios stamps onto its own error instances — a plain mocked reject object without that flag makes `isAxiosError()` return `false`, silently falling through to the fallback string instead of the server message. No existing test in this codebase mocks an axios error with that flag set (`grep -rln "isAxiosError: true" web/react-gui/src` — zero hits) — do not copy a bare `{ response: { data: { message: ... } } }` mock verbatim from another card's test file, it will not exercise the intended branch here. Set `isAxiosError: true` explicitly on the mocked rejection:

```tsx
it('surfaces the server message on a failed identify request', async () => {
  vi.mocked(postSdi12Identify).mockRejectedValueOnce({
    isAxiosError: true,
    response: { data: { message: 'device is missing ChirpStack registration data; cannot identify' } },
  });
  render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Detect probe' }));
  await waitFor(() =>
    expect(screen.getByText('device is missing ChirpStack registration data; cannot identify')).toBeInTheDocument(),
  );
});

it('surfaces the server message on a failed save', async () => {
  vi.mocked(putSdi12Config).mockRejectedValueOnce({
    isAxiosError: true,
    response: { data: { message: 'Depths must be whole centimeters between 0 and 500.' } },
  });
  render(<Sdi12SettingsModal device={device} onClose={vi.fn()} onUpdate={vi.fn()} />);
  await screen.findByRole('option', { name: /ecoTech Tensiomark.*unverified/i });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.getByText('Depths must be whole centimeters between 0 and 500.')).toBeInTheDocument(),
  );
});
```

- [ ] **Run to see it fail:** `cd web/react-gui && node_modules/.bin/vitest run src/components/farming/__tests__/Sdi12SettingsModal.test.tsx`
  Expected: both new cases fail — the generic hardcoded string (`'Failed to request SDI-12 probe identification.'` / `'Failed to save SDI-12 configuration.'`) is asserted-against-absent text instead.

- [ ] **Fix both catch blocks.** Add the `getApiErrorMessage` import, then replace:

```tsx
    } catch {
      setError('Failed to save SDI-12 configuration.');
    } finally {
```

  with

```tsx
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, 'Failed to save SDI-12 configuration.'));
    } finally {
```

  and identically for `handleIdentify`'s catch (message fallback: `'Failed to request SDI-12 probe identification.'`). Add `getApiErrorMessage` to the existing `../../services/api` import list at the top of the file.

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit && npm run typecheck` → both exit 0.

- [ ] **Commit:**
```bash
git add web/react-gui/src/components/farming/Sdi12SettingsModal.tsx web/react-gui/src/components/farming/__tests__/Sdi12SettingsModal.test.tsx
git commit -m "fix(sdi12): surface the server's error message instead of a generic string"
```

---

## Task A4 — auto-identify on registration and first join; honest-wait UX

**Scope, precisely.** Today `sdi12-post-reg-hook-fn` already auto-triggers one identify attempt at registration time (it stages `msg.deviceRow` and link-outs to `sdi12-identify-trigger-fn`) — but only for the `post-devices-insert` local-registration path (it reads `msg.deviceRegistration`, which only that node and `cs-reg-cloud-fn` populate; confirm which of the two currently wires into this hook before writing code — read the node's `wires` array). Phil's acceptance criteria (from the briefing) add: (1) the cloud-command registration path gets the same auto-trigger if it doesn't already, (2) a "first join" trigger — if a device was registered but its first uplink arrives before identify ever ran (e.g. auto-trigger failed transiently), identify fires once on that first uplink instead of waiting for a manual click, (3) the manual "Identify" button becomes "Re-check" framing once an identify has ever been attempted, (4) an honest-wait UX: an ETA derived from last-seen + the device's TX interval, a Dragino-specific "press the ACT button" hint, and a pending-state that expires to an explicit "no response" state instead of spinning forever.

**Files**
- Modify: `flows.json` (both profiles), nodes `sdi12-post-reg-hook-fn`, and (new) a first-join trigger hooked into the SDI-12 uplink-processing path (locate the existing SDI-12 uplink normalize/write node — grep `osi-sdi12-normalize` usage in `flows.json` — and add a lightweight link-out when `sdi12_probe_status` is `NULL`/unset on the device row at write time).
- Modify: `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx` (button label logic, ETA display).
- Modify: `web/react-gui/src/components/farming/Sdi12SoilCard.tsx` (pending-state display, if the card shows probe status inline — it already renders `status === 'pending_identify'` at line 116).
- Modify: 7 locale files under `public/locales/*/devices.json` (new strings: re-check label, ETA text, ACT-button hint, no-response state).
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`.

**Interfaces**
- **Corrected 2026-08-18 (B-1, BLOCKING — was a live bug in the original draft).** `devices.sdi12_probe_status` has a hard SQLite `CHECK(sdi12_probe_status IN ('pending_identify','identified','unmatched','manual'))` (`database/seed-blank.sql:140`, migration `0045`). The original draft's `UPDATE devices SET sdi12_probe_status = 'no_response' ...` would fail that CHECK on every attempt — not a style nit, a guaranteed runtime error, and `no_response` is not an additive change either (it would need a `destructive`-class table-rebuild migration, per `osi-schema-change-control`, for one cosmetic UI state). **Fix: no schema change, no new DB status, no periodic-sweep node.** "No response" is derived **client-side only**: `device.sdi12_probe_status === 'pending_identify' && ageMinutes(device.updated_at) > SDI12_IDENTIFY_TIMEOUT_MINUTES` renders the explicit no-response state in `Sdi12SoilCard`/`Sdi12SettingsModal`, with remediation copy ("check the probe's wiring, or press the ACT button on the Dragino unit to force an uplink"). The DB row stays `pending_identify` forever until the next successful identify actually transitions it — that is correct and intended; the timeout only changes what the *UI* says, not what's stored. **Pending Phil confirmation:** this changes the acceptance criteria from "a `no_response` status" to "a `no_response`-*presentation*" — confirm this reframing is acceptable before executing this task; if Phil wants the state persisted (e.g. for server-side reporting), that is a `destructive`-class CHECK-rebuild migration and a materially bigger task than this wave budgets for.
  - `SDI12_IDENTIFY_TIMEOUT_MINUTES = 15` as a named constant (module-scope in whichever file computes it) — larger than the device's slowest plausible TX interval; `Sdi12SettingsModal.tsx`'s existing `pendingAgeLabel()` (lines 42-48) already computes `minutes = Math.floor((Date.now() - timestamp) / 60000)` from `device.updated_at` for its "Identification pending for N minutes" copy — extend that same function/call site with the threshold rather than inventing a second age computation.
- New: an ETA field the frontend can render, derived client-side from `device.last_seen` + a TX-interval field already on the device row (check `device.sdi12_probe_status`'s sibling columns — likely `chirpstack_app_id`, `sdi12_probe_profile`; if no TX-interval column exists on `devices` for SDI-12, this sub-feature is out of scope for this task and should be filed as its own follow-up rather than invented here — **executor: verify column existence before implementing; if absent, implement the ACT-button hint and no-response expiry only, and note the ETA sub-feature as descoped in the commit message**).
- **Advisory, real-hardware expectation:** every `PROFILES[i].identityMatch` in `osi-sdi12-normalize/index.js` is `null` today (no bench-verified identity strings yet), so `sdi12-identify-fn`'s `matchProfile()` call always falls through to `unmatched` on real hardware — a successful identify request never actually reaches `identified` pre-bench-capture. The "Re-check" framing and honest-wait UX in this task must not imply `identified` is achievable yet; word the UI copy and this task's manual walkthrough expectation around ending at `unmatched` (a real response, not a failure) rather than `identified`.

**Files, corrected:** `Sdi12SettingsModal.tsx` has **no `useTranslation` import at all today** (confirmed 2026-08-18, grepped — the whole file is hardcoded English, same finding as Task A5's `Sdi12SoilCard`). The `t('sdi12.reCheck')` etc. calls below assume `useTranslation` is already wired in; it is not. Add `import { useTranslation } from 'react-i18next';` and `const { t } = useTranslation('devices');` to `Sdi12SettingsModal.tsx` as part of this task's frontend step, the same way Task A5 adds it to `Sdi12SoilCard.tsx` (if A5 lands first per the serialization order below, this import may already exist in `Sdi12SoilCard.tsx` but *not* in `Sdi12SettingsModal.tsx` — they are different files, both need it independently).

**Steps**

- [ ] **Read `sdi12-post-reg-hook-fn`'s wiring first.** `python3 -c "import json; f=json.load(open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json')); [print(n) for n in f if n.get('id')=='sdi12-post-reg-hook-fn']"` and cross-reference which upstream node's `wires` array points at it. If only `post-devices-insert`'s success path wires into it, `cs-reg-cloud-fn`'s success path needs the same link-out added (a new `link out` node paired with the existing `link in`, or a direct wire if they're `z`-local — check the existing pattern for `post-devices-insert`'s wiring exactly and mirror it). **Print a before dump of every node this task will touch** (`id`, `outputs`, `wires`) before mutating anything — this is the B-5 wire-alignment requirement for this task specifically, since it adds a genuinely new link-out.

- [ ] **Write the failing test** for the cloud-path auto-trigger gap, in `scripts/test-sdi12-registration.js`:

```js
test('A4: a cloud-registered SDI-12 device also gets an auto-identify trigger', async () => {
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('cs-reg-cloud-fn'), {
      msg: { payload: JSON.stringify({ commandType: 'REGISTER_DEVICE', params: { devEui: 'A840410000000105', name: 'Cloud SDI-12 auto', deviceType: 'DRAGINO_SDI12', appKey: '00000000000000000000000000000005', userUuid: 'u-admin' } }) },
      env: ENV, db,
      libOverrides: { chirpstack: { createProvisioningClientFromEnv: () => ({ ensureDeviceProvisioned: async () => ({}), close: () => {} }) } },
    });
    // Feed the success msg (response.result[0]) into sdi12-post-reg-hook-fn exactly
    // as the flow wiring will once this task adds the missing link -- prove the
    // hook actually recognizes a cloud-path deviceRegistration, not just the
    // local-path one.
    const hookOut = await executeFunction(loadNode('sdi12-post-reg-hook-fn'), { msg: response.result[0], env: ENV, db });
    assert.ok(hookOut.result[0] && hookOut.result[0].deviceRow, 'cloud-path registration must also stage an identify trigger');
  } finally {
    db.close();
  }
});
```

- [ ] **Run to see it fail:** `node --test scripts/test-sdi12-registration.js`
  Expected: fails only if `cs-reg-cloud-fn`'s success message doesn't populate `msg.deviceRegistration` in the shape `sdi12-post-reg-hook-fn` expects — read `cs-reg-cloud-fn`'s success return (`buildAck('SUCCESS', successExtras)`) and confirm whether `deviceRegistration` is present on that message at all; if the wiring gap is real, this test fails with `hookOut.result[0]` being `null` (the hook's `if (!msg.deviceRegistration || ...) return null;` guard). **If `cs-reg-cloud-fn`'s ACK message never carried `deviceRegistration` to begin with, the fix is to add it to `successExtras` alongside the existing zone fields, gated the same way the zone fields are gated by `scopedOn` if that gating applies here too — check E5's precedent in the branch history (`cs-reg-cloud-fn`'s existing `scopedOn` gate for zone fields) before deciding whether this new field needs the same flag guard.**

- [ ] **Implement the missing wiring**, following whatever the read-first step found (either a new link-out from `cs-reg-cloud-fn`'s success path, or adding `deviceRegistration` to its ACK payload so the existing `sdi12-post-reg-hook-fn` picks it up unchanged — prefer the smaller diff once you know which is missing).

- [ ] **Implement the first-join trigger.** Find the SDI-12 uplink write node (grep `sdi12_probe_status` writes in `flows.json` — the write path that persists decoded readings). Add: if the device's *pre-write* `sdi12_probe_status` is NULL (never attempted), link out to `sdi12-identify-trigger-fn` the same way `sdi12-post-reg-hook-fn` does, after the normal write completes (do not block the telemetry write on the identify trigger's own DB call — fire-and-forget via the existing link-node pattern).

- [ ] **No server-side no-response timeout node.** Per the B-1 correction above, this task adds **no** periodic-sweep inject node and **no** `UPDATE ... SET sdi12_probe_status = 'no_response'` anywhere — that status value does not exist and would violate the `devices.sdi12_probe_status` CHECK constraint. The no-response state is computed entirely in the frontend from `pending_identify` + age (next step). Skip straight to the frontend step.

- [ ] **Frontend: re-check label, ACT-button hint, client-derived no-response state.** First add `useTranslation` to `Sdi12SettingsModal.tsx` (it has none today — see the Files correction above). Add a module-scope `const SDI12_IDENTIFY_TIMEOUT_MINUTES = 15;` near `pendingAgeLabel()`. Change the Identify button's label logic to read `t('sdi12.reCheck')` when `device.sdi12_probe_status` is not `null`/`undefined` (i.e. an attempt has happened before), else `t('sdi12.identify')`. Add a hint line under the button: `t('sdi12.actButtonHint')`. Extend `pendingAgeLabel()` (or its call site) so that once `minutes > SDI12_IDENTIFY_TIMEOUT_MINUTES`, it renders `t('sdi12.noResponse')` (with the ACT-button remediation copy) instead of "Identification pending for N minutes." In `Sdi12SoilCard.tsx`, extend the existing `status === 'pending_identify'` block with the same age check (needs `device.updated_at`, already on the `Device` type) — past the timeout, render `t('sdi12.noResponse')` in the same warn-styled `<p>` instead of the perpetual pending copy. Word `sdi12.noResponse`'s copy around "the probe hasn't answered yet" rather than "identification failed" — per the advisory note above, `unmatched` (not `identified`) is the expected end state on real hardware pre-bench-capture, and `noResponse` is a distinct, narrower case (no reply at all).

- [ ] **Add the 4 new i18n keys** (`sdi12.reCheck`, `sdi12.identify`, `sdi12.actButtonHint`, `sdi12.noResponse`) to `devices.json` in all 7 locales. English source text:
  - `identify`: "Identify probe"
  - `reCheck`: "Re-check probe"
  - `actButtonHint`: "If the probe doesn't respond, press the ACT button on the Dragino unit, then try again."
  - `noResponse`: "Probe did not respond to identification"

  Translate de-CH/es/fr/it/pt directly (these are short, unambiguous UI strings — a competent bilingual pass is sufficient, matching the register this file's other short strings use, e.g. `kiwiSensor.removing`'s tone). For `lg`, machine-draft the four strings and flag them explicitly in the commit message as `lg: machine-drafted, needs human-native review` — do not silently mix a drafted `lg` string into the commit without that flag, per the i18n global constraint.

- [ ] **Run the frontend tests:** `cd web/react-gui && npm run test:unit && npm run typecheck` → exit 0. Add/extend a `Sdi12SettingsModal.test.tsx` case asserting the button label flips from "Detect probe" to "Re-check probe" once `device.sdi12_probe_status` is non-null, and a case in both `Sdi12SettingsModal.test.tsx` and `Sdi12SoilCard.test.tsx` asserting the client-derived no-response copy renders when `device.sdi12_probe_status === 'pending_identify'` and `device.updated_at` is older than `SDI12_IDENTIFY_TIMEOUT_MINUTES` (mock the clock or pass a fixed old timestamp — do not assert against a real `Date.now()`-based race).

- [ ] **Run the edge backend suites:** `node --test scripts/test-sdi12-registration.js scripts/test-scoped-access-writes.js` → exit 0.

- [ ] **Measure, raise ceilings** for every touched flows.json node, same procedure as A1/A2, reason `"A4: auto-identify wiring (cloud path + first-join)"`.

- [ ] **Print the after dump** of every node touched (same `id`/`outputs`/`wires` shape as the before dump) and diff it against the before dump from the first step — confirm only the intended link(s) changed.

- [ ] **Run the flows gate** (the full nine-command set, as A1) → all exit 0.

- [ ] **Commit:**
```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-sdi12-registration.js scripts/verify-flows-size-ratchet-allowances.json web/react-gui/src/components/farming/Sdi12SettingsModal.tsx web/react-gui/src/components/farming/Sdi12SoilCard.tsx web/react-gui/src/components/farming/__tests__ web/react-gui/public/locales
git commit -m "feat(sdi12): auto-identify on cloud registration + first join; honest-wait UX"
```

  **This is the largest task in the plan and the one most likely to need re-scoping mid-execution** (the TX-interval/ETA sub-feature is explicitly conditional on a column that may not exist). If the executor hits a divergence between this plan's assumptions and the actual flow wiring, stop per the playbook's "stop on divergence" rule and report — do not improvise a different fix.

---

## Task A5 — F4: Sdi12SoilCard gets a working remove button

**Confirmed, with one correction to the original finding.** `Sdi12SoilCard.tsx:10` declares `onRemove?: () => void` but the destructured props (line 66-70) drop it, and there is no remove UI at all. **Two call sites need fixing, not one**: `IrrigationZoneCard.tsx:530-535` already passes `onRemove={() => handleRemoveDevice(device.deveui)}`, but `FarmingDashboard.tsx:305-311` (the unassigned-devices section) passes **no** `onRemove` at all — every sibling card there (`KiwiSensorCard`, `StregaValveCard`, `DraginoTempCard`) passes `onRemove={handleUpdate}`.

**Files**
- Modify: `web/react-gui/src/components/farming/Sdi12SoilCard.tsx`.
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx` (lines 305-311).
- Modify: `web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx`.
- Modify: 7 locale files under `public/locales/*/devices.json` (new `sdi12Soil.*` block).

**Interfaces**
- New props consumed: `onRemove` (already declared, now used).
- Template, byte-for-byte pattern to replicate from `KiwiSensorCard.tsx` lines 324-340 (state) and 386-432 (UI) — `isRemoving`/`showConfirm`/`error` state, `handleRemove` calling `devicesAPI.remove(device.deveui)` then `onRemove?.()`, a `✕` button opening an inline warn-styled confirm panel.

**Steps**

- [ ] **Write the failing test.** **Corrected 2026-08-18 (R-3):** the existing `Sdi12SoilCard.test.tsx` has **no** `vi.mock('../../../services/api', ...)` and **no** `vi.mock('react-i18next', ...)` today (grepped, zero hits — its three current tests never call the API and the component itself has no `useTranslation` import yet) — there is no existing stub to "match," both mocks are new additions this task introduces. This codebase's convention (`CreateZoneModal.uicore.test.tsx`, `ValveCard.test.tsx`, `ZoneConfigModal.test.tsx`, `SenseCapWeatherCard.test.tsx`) is `vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))` — `t()` returns the **key itself**, not the translated English string, so assertions query the key (`'sdi12Soil.yesRemove'`), not rendered prose. `devicesAPI` is mocked as a named export object, matching `KiwiSensorCard.test.tsx:8-9`: `vi.mock('../../../services/api', () => ({ devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) } }))`. `getByTitle('Remove device')` is fine as written — that title attribute is hardcoded English in `KiwiSensorCard` too, not translated, so it is a safe literal-string query:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { devicesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it('removes the device when the operator confirms', async () => {
  const onRemove = vi.fn();
  vi.mocked(devicesAPI.remove).mockResolvedValueOnce(undefined as never);
  render(<Sdi12SoilCard device={mockDevice} onRemove={onRemove} />);

  fireEvent.click(screen.getByTitle('Remove device'));
  fireEvent.click(screen.getByText('sdi12Soil.yesRemove'));

  await waitFor(() => expect(devicesAPI.remove).toHaveBeenCalledWith(mockDevice.deveui));
  await waitFor(() => expect(onRemove).toHaveBeenCalled());
});

it('does not render a remove button in readOnly mode', () => {
  render(<Sdi12SoilCard device={mockDevice} readOnly />);
  expect(screen.queryByTitle('Remove device')).not.toBeInTheDocument();
});
```

  **Executor note:** the existing file uses a `makeDevice()` fixture helper, not a bare `mockDevice` constant — use `makeDevice({...})` for the two new tests' device props, matching the file's existing three tests, and add the two `vi.mock(...)` calls above the `describe` block alongside the existing imports.

- [ ] **Run to see it fail:** `cd web/react-gui && node_modules/.bin/vitest run src/components/farming/__tests__/Sdi12SoilCard.test.tsx`
  Expected: `getByTitle('Remove device')` throws — no such element exists.

- [ ] **Implement, mirroring `KiwiSensorCard.tsx` exactly** (state block after line 83's `minutesAgo`, UI block inside the header `<div className="flex items-center gap-1.5 shrink-0">` next to the existing settings button, confirm panel after the existing `{status === 'pending_identify' && (...)}` block or before it — match `KiwiSensorCard`'s placement, confirm-panel-before-content, exactly):

```tsx
import { useState } from 'react';
import { devicesAPI } from '../../services/api';
// ... existing imports

export const Sdi12SoilCard: React.FC<Sdi12SoilCardProps> = ({
  device,
  onOpenSettings,
  onRemove,
  readOnly = false,
}) => {
  // ... existing derived values ...
  const [isRemoving, setIsRemoving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleRemove = async () => {
    setIsRemoving(true);
    setRemoveError(null);
    try {
      await devicesAPI.remove(device.deveui);
      onRemove?.();
    } catch (err: any) {
      setRemoveError(err.response?.data?.message || 'Failed to remove device');
      setIsRemoving(false);
    }
  };

  return (
    // ... header div unchanged except:
    //   add, next to the existing settings button, inside the same shrink-0 row:
    //   {!readOnly && <button onClick={() => setShowConfirm(true)} disabled={isRemoving}
    //      className="p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
    //      title="Remove device">✕</button>}
    // ... then, mirroring KiwiSensorCard's placement, before the "rows.length > 0" block:
    //   {removeError && <div className="bg-[var(--error-bg)] ... ">{removeError}</div>}
    //   {!readOnly && showConfirm && ( ... same confirm panel structure as KiwiSensorCard,
    //      using the new sdi12Soil.* i18n keys instead of kiwiSensor.* ... )}
  );
};
```

  Copy `KiwiSensorCard.tsx`'s confirm-panel JSX (lines 404-432) verbatim, swapping `t('kiwiSensor.removeConfirm')` → `t('sdi12Soil.removeConfirm')` etc. **Note:** `Sdi12SoilCard` currently has no `useTranslation` import at all — the rest of the component is hardcoded English (pre-existing debt, out of scope for this task; file it as a follow-up rather than fixing it here). Import `useTranslation` and call `const { t } = useTranslation('devices');` for the new remove-flow strings only.

- [ ] **In `FarmingDashboard.tsx` line ~309**, add the missing prop:

```tsx
                          <Sdi12SoilCard
                            key={device.deveui}
                            device={device}
                            onOpenSettings={() => setSdi12SettingsDevice(device)}
                            onRemove={handleUpdate}
                            readOnly={!canWrite}
                          />
```

- [ ] **Add the `sdi12Soil` block to `devices.json` in all 7 locales** — reuse the exact translated strings already present under `kiwiSensor.*` for the equivalent generic device-remove copy (they are device-agnostic text: "Remove this device?" / "This will unlink the device from your account." / etc. — confirmed identical register in all 5 already-translated locales), so no fresh translation work is needed:

| Locale | removeConfirm | removeSubtitle | yesRemove | removing | failedToRemove |
|---|---|---|---|---|---|
| en | Remove this device? | This will unlink the device from your account. | Yes, Remove | Removing... | Failed to remove device |
| de-CH | Dieses Gerät entfernen? | Das Gerät wird von Ihrem Konto getrennt. | Ja, entfernen | Wird entfernt... | Gerät konnte nicht entfernt werden |
| es | ¿Eliminar este dispositivo? | El dispositivo se desvinculará de tu cuenta. | Sí, eliminar | Eliminando... | Error al eliminar el dispositivo |
| fr | Supprimer cet appareil ? | L'appareil sera dissocié de votre compte. | Oui, supprimer | Suppression en cours... | Impossible de supprimer l'appareil |
| it | Rimuovere questo dispositivo? | Il dispositivo verrà scollegato dal tuo account. | Sì, rimuovi | Rimozione in corso... | Impossibile rimuovere il dispositivo |
| lg | Ggyawo ekyuma kino? | Ekyuma kiggyibwako ku akawunti yo. | Yee, Ggyawo | Tikuggyawo... | Okuggyawo ekyuma kugaanye |
| pt | Remover este dispositivo? | O dispositivo será desvinculado da sua conta. | Sim, remover | A remover... | Falha ao remover dispositivo |

  These are direct copies of already-shipped, already-reviewed translations (`kiwiSensor.*`), not new drafts — no `lg` machine-draft flag needed here, unlike Task A4's genuinely new strings.

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit && npm run typecheck` → both exit 0.

- [ ] **Commit:**
```bash
git add web/react-gui/src/components/farming/Sdi12SoilCard.tsx web/react-gui/src/pages/FarmingDashboard.tsx web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx web/react-gui/public/locales
git commit -m "fix(gui): wire remove into Sdi12SoilCard and FarmingDashboard's unassigned section"
```

---

## Task A6 — F6: variable-count SDI-12 profiles, per-device depths, corrected byte budget

**Replanned 2026-08-18 (B-2/B-3, BLOCKING in the original draft).** Verified: **no `aC9!`/value-count identification path exists anywhere in `flows.json`** — only `0I!` (FPort 100 → `sdi12-identify-fn` → `matchProfile`), and every `PROFILES[i].identityMatch` is `null`, so identify always ends `unmatched`. `sdi12-write-fn` passes only `{ probeProfile: row.sdi12_probe_profile || null }` into `normalize()` (confirmed by direct read of the node's `func`). The original draft's fixtures set `deviceConfig.sdi12ValueCount` as if some identification flow already populated it — no production caller can ever set that field, so the original tests would pass in isolation while the real bench-Sentek-truncation bug stayed exactly as broken as before. Additionally, the original draft's `verify-device-integration.js` fixture schema was wrong (real fields are `name`/`fPort`/`probeProfile`/`bytes`/`expected`/`expectedQuarantine`/`expectedNoResponse`, not `profileId`/`rawFrame`/`expectedChannels` — confirmed by reading `scripts/fixtures/device-integration/sdi12/golden-vectors.json` and `scripts/verify-device-integration.js:175-200`), and the runner hardcodes `{ probeProfile: vector.probeProfile }` as `deviceConfig` — it must change to pass a full per-vector `deviceConfig`, which the plan's first draft claimed needed no code change.

**Rewritten around option (b): a real, manually-set `devices.sdi12_value_count` column — pending Phil confirmation of (b) vs (c).** (b) is a small operator-facing settings field ("how many readings does your probe report?"), populated once at setup time, versus (c) which would drop the atomic-rejection guarantee for Sentek-family profiles entirely and accept whatever count shows up. (b) preserves the existing atomic-quarantine behavior (a corrupted/truncated frame still gets rejected, not partially written) while letting an operator tell the system the real count instead of a wrong hardcoded one. **If Phil prefers (c) instead**, see the fallback paragraph at the end of this task — it drops steps 2-4 and 6 below and keeps only 1, 5 (variable branch), 7.

**Files**
- New: `database/migrations/ordered/0047__sdi12_value_count.sql` (additive; next contiguous version after `0046`, confirmed via `ls database/migrations/ordered/`).
- Modify: `database/seed-blank.sql`, all 7 bundled `farming.db` copies, `database/migrations/ordered/CHECKSUMS.json` (regenerated, not hand-edited — see the `osi-schema-change-control` skill's walkthrough).
- Modify: `scripts/verify-db-schema-consistency.js` (`schemaContract` array, next to `sdi12_probe_profile`/`sdi12_probe_status` at lines 61-62).
- Modify: `database/seed-blank.sql`'s `trg_sync_devices_outbox_au` trigger (watched-column list + `payload_json`) — see the sync-contract decision below.
- Modify (cloud): `backend/src/test/resources/sync-contract/resources.schema.json` — see the sync-contract decision below.
- Modify: both `flows.json` profiles, nodes `sdi12-config-action-fn` ("Save SDI-12 Config"), `sdi12-config-sqlite` ("Read SDI12 Config"), `sdi12-write-fn` ("SDI12 Normalize + Write").
- Modify: `conf/.../osi-sdi12-normalize/index.js` **and its byte-identical bcm2709 mirror** — confirmed already covered by `scripts/verify-profile-parity.js`'s `CANONICAL_PAYLOAD` list as a whole-directory entry (`'files/usr/share/node-red'`, line 46) — no file-list edit needed there, the original draft's uncertainty on this point is resolved: it's already covered.
- Modify: `scripts/fixtures/device-integration/sdi12/golden-vectors.json`, `scripts/verify-device-integration.js` (runner must build a per-vector `deviceConfig`, not the hardcoded `{ probeProfile }`).
- Modify: `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx` (value-count field), its test file, all 7 `devices.json` locales.
- Also run: `conf/.../osi-sdi12-normalize/index.test.js` (mirror unit test, not currently run by this plan's original draft).

**Sync-contract decision (must be stated, not skipped).** `sdi12_probe_profile` and `soil_moisture_probe_depths_json` — the two existing per-device SDI-12 config columns — are both already watched columns in `trg_sync_devices_outbox_au` (`seed-blank.sql:2025-2026`) and both already appear in the cloud's `resources.schema.json` Device schema (`sdi12_probe_profile` at lines 156/189). `sdi12_value_count` is the same category of fact (per-device SDI-12 config, operator-set, not derived from telemetry) — **it must sync**, for the same reason its two siblings do: a cloud-side view of a device's SDI-12 configuration that's missing the value count is incomplete in the same way it would be if `sdi12_probe_profile` didn't sync. This is a **cross-repo sync-contract change**: add `sdi12_value_count` to `trg_sync_devices_outbox_au`'s `WHEN` clause and `payload_json` (mirroring `sdi12_probe_profile`'s exact treatment) on the edge, and add `"sdi12_value_count": {"type": ["integer", "null"]}` next to the existing `sdi12_probe_profile` entries in the cloud's `resources.schema.json` (both Device schema occurrences, lines ~156 and ~189) as a separate cloud-side task/commit. Cross-reference this task and the cloud commit in each other's message.

**Interfaces**
- `PROFILES[i].expectedValues` — for `SENTEK_ENVIROSCAN`, `DELTAT_PR2_4`, and `DELTAT_PR2_6` (all three have a **homogeneous** `values: seq('vwc', n)` array today — verified by reading `index.js` lines 52-77), `expectedValues` becomes `null` and `values` becomes `seq('vwc', 8)`, matching the existing `GENERIC_VWC` precedent (variable-count, no atomic rejection pre-identification, values map sequentially up to 8 and any reading beyond the profile's declared slots is simply not captured — the existing, already-shipped behavior for `GENERIC_VWC`). `defaultDepthsCm` becomes `[]` for these three, since depths are now purely per-device.
- **Deviation from the literal adjudication, with evidence (flagged per this task's own review instructions).** `HYDRASCOUT` is explicitly **excluded** from this `expectedValues: null` / `values: seq('vwc', 8)` conversion. Its `values` array (`index.js` lines 103-118) is **not** homogeneous — it's an interleaved `vwc_1, soil_temp_1, soil_ec_1, vwc_2, soil_temp_2, soil_ec_2` layout (VWC, temperature, and EC per depth). Swapping it for `seq('vwc', 8)` would silently relabel every temperature and EC reading as a VWC channel — a data-corruption regression, not a refactor, and exactly the kind of unverified-capability change §1 rule 3 of the playbook warns against (HydraScout was never bench-proven variable-count in the first place; only Sentek was). `HYDRASCOUT` keeps its fixed `expectedValues: 6`, its interleaved `values` array, and its `defaultDepthsCm: [15, 30]` unchanged — only its byte-budget comment gets the 7→9 correction below. If a HydraScout probe is later bench-confirmed variable-count, that is a follow-up task with its own bench evidence, not something to fold into this one by analogy to Sentek.
- Add `resolveCount(profile, deviceConfig)` in `index.js`: `deviceConfig && Number.isInteger(deviceConfig.sdi12ValueCount) ? deviceConfig.sdi12ValueCount : (profile ? profile.expectedValues : null)`, then **clamp**: if the resolved count is non-null and outside `1..8`, treat it as if no count were learned (fall back to `profile.expectedValues`) — this is what stops a corrupted/invalid persisted `sdi12_value_count` (which should never exist once the migration's `CHECK` and the config-save validation are both in place, but normalize() must not silently trust a value that bypassed both) from disabling atomic rejection. For `SENTEK_ENVIROSCAN`/`DELTAT_PR2_4`/`DELTAT_PR2_6` specifically, when a valid `deviceConfig.sdi12ValueCount` is present, the value-mapping entries are `seq('vwc', resolvedCount)` (computed inside `normalize()`, not at module-load time — per-device counts vary per call); for `HYDRASCOUT` and every other profile, value-mapping entries stay `profile.values` regardless of `sdi12ValueCount` (the count only affects the cardinality check for those profiles, never the channel labeling).
- `WORST_CHARS_PER_VALUE` changes from `7` to `9` (bench-measured: Sentek values are 9 ASCII chars each); `worstCaseUplinkBytes()`'s formula is unchanged, only the constant moves. Recompute **every** profile's byte-budget comment that cites the old arithmetic (`SENTEK_ENVIROSCAN`'s `8*7+3 > 51` → `8*9+3 > 51`; `HYDRASCOUT`'s equivalent comment) — still exceeds the 51-byte DR0 budget either way, so the phase-2-gated 8-depth note stays valid, just with corrected arithmetic.
- `sdi12-config-action-fn` PUT (`Sdi12SettingsModal.tsx`'s `putSdi12Config`) accepts an optional `value_count` field: validate it is an integer 1-8 or `null`/absent (reject with 400 otherwise, mirroring the existing `depths` validation style in the same function), persist it in the same `UPDATE devices SET ...` statement alongside `sdi12_probe_profile`.
- `sdi12-config-sqlite`'s `SELECT` gains `sdi12_value_count` (currently `SELECT sdi12_probe_profile, sdi12_probe_status, soil_moisture_probe_depths_json FROM devices WHERE deveui = $deveui`).
- `sdi12-write-fn` passes `deviceConfig.sdi12ValueCount = row.sdi12_value_count` alongside the existing `probeProfile: row.sdi12_probe_profile || null` into `normalize()`.
- Modal: a value-count field, shown **only** when `selectedProfile.expectedValues == null` (i.e. `SENTEK_ENVIROSCAN`, `DELTAT_PR2_4`, `DELTAT_PR2_6`, `GENERIC_VWC` — the profiles this task or the pre-existing `GENERIC_VWC` design made variable) — not for fixed-shape profiles like `HYDRASCOUT`, `TENSIOMARK`, `IMKO_PICO64`, where a value count isn't a meaningful per-device fact.

**Steps**

- [ ] **Write the migration.** `database/migrations/ordered/0047__sdi12_value_count.sql`:
```sql
-- risk: additive
-- 0047: Per-device learned SDI-12 reading count (task A6, wave-1 fix). Verified
-- SQLite 3.53 accepts a column-level CHECK on ALTER TABLE ADD COLUMN for a
-- single-column, non-foreign-key constraint (confirmed against this checkout's
-- sqlite3 CLI before writing this file); no prior precedent for this pattern
-- in the existing migration set, so this comment records the verification.
ALTER TABLE devices ADD COLUMN sdi12_value_count INTEGER
  CHECK(sdi12_value_count IS NULL OR (sdi12_value_count BETWEEN 1 AND 8));
```
  Apply the same `ALTER TABLE` to `database/seed-blank.sql` (append after the existing `sdi12_identity` column), then regenerate all 7 bundled `farming.db` copies and the `bcm2709` mirror per the `osi-schema-change-control` skill's walkthrough (`sqlite3 -bail <db> < 0047__sdi12_value_count.sql` against each of the 6 non-mirrored copies, then `cp` the `bcm2712` full-profile DB over the `bcm2709` mirror). `CHECKSUMS.json` is SHA-256-per-file and machine-generated — do not hand-edit it; regenerate via whatever mechanism the existing entries were produced with (check `scripts/migrate-cli.js`/loader for a checksum-writing helper, or compute `sha256sum` directly and append the exact key/value pair the loader expects).

- [ ] **Extend `trg_sync_devices_outbox_au`** in `seed-blank.sql`: add `COALESCE(NEW.sdi12_value_count,-1) <> COALESCE(OLD.sdi12_value_count,-1) OR` to the `WHEN` clause (mirroring the numeric-column pattern used for `chameleon_swt1_depth_cm` etc., not the string pattern used for `sdi12_probe_profile`, since this is an integer column), and add `'sdi12_value_count', NEW.sdi12_value_count,` to `payload_json` next to `'sdi12_probe_profile'`. Extend `scripts/verify-db-schema-consistency.js`'s `schemaContract` array with `'sdi12_value_count'` next to `'sdi12_probe_profile'`/`'sdi12_probe_status'` (lines 61-62).

- [ ] **Cloud sync-contract mirror (separate commit, cloud repo).** Add `"sdi12_value_count": {"type": ["integer", "null"]}` next to both existing `sdi12_probe_profile` entries in `backend/src/test/resources/sync-contract/resources.schema.json` (lines ~156, ~189). Cross-reference this edge task in the cloud commit message and vice versa.

- [ ] **Run the schema gate:**
```bash
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && \
node scripts/verify-db-schema-consistency.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js
```
  All must print their `OK`/`passed` line — this is additive (no `devices` CHECK/rebuild involved), so `verify-devices-rebuild-fence.js`/`rehearse-devices-rebuild.test.js` are not required for this migration specifically, but re-run them anyway if anything else in this task touched `sync-init-fn` (it should not).

- [ ] **Write the failing golden-vector tests.** Add to `scripts/fixtures/device-integration/sdi12/golden-vectors.json`, matching the file's **real** schema (`name`/`fPort`/`probeProfile`/`bytes`/`expected`/`expectedQuarantine`, plus this task's new optional `deviceConfig` field for cases needing more than `probeProfile`). `bytes` is `[batV_hi, batV_lo, payloadVersion, ...ASCII char codes of the SDI-12 response string]` per `dragino_sdi12_decoder.js` — build it programmatically rather than hand-transcribing ASCII codes, e.g. `const toBytes = (s) => [12, 228, 1, ...Array.from(s).map(c => c.charCodeAt(0))];` (bytes `[12,228,1]` = 3300 mV battery + payload version 1, matching every other fixture in this file):

```json
{
  "name": "Sentek 5-of-8 variable count (per-device identified)",
  "fPort": 2,
  "probeProfile": "SENTEK_ENVIROSCAN",
  "deviceConfig": { "probeProfile": "SENTEK_ENVIROSCAN", "sdi12ValueCount": 5 },
  "bytes": [12, 228, 1, /* ASCII for "+12.3+14.1+18.7+22.0+9.5" via toBytes() */],
  "expected": { "vwc_1": 12.3, "vwc_2": 14.1, "vwc_3": 18.7, "vwc_4": 22.0, "vwc_5": 9.5, "bat_v": 3.3 },
  "expectedQuarantine": []
},
{
  "name": "Sentek 8-of-8 variable count",
  "fPort": 2,
  "probeProfile": "SENTEK_ENVIROSCAN",
  "deviceConfig": { "probeProfile": "SENTEK_ENVIROSCAN", "sdi12ValueCount": 8 },
  "bytes": [12, 228, 1, /* ASCII for "+12.3+14.1+18.7+22.0+9.5+11.0+13.2+15.8" via toBytes() */],
  "expected": { "vwc_1": 12.3, "vwc_2": 14.1, "vwc_3": 18.7, "vwc_4": 22.0, "vwc_5": 9.5, "vwc_6": 11.0, "vwc_7": 13.2, "vwc_8": 15.8, "bat_v": 3.3 },
  "expectedQuarantine": []
},
{
  "name": "Sentek 1-of-8 variable count",
  "fPort": 2,
  "probeProfile": "SENTEK_ENVIROSCAN",
  "deviceConfig": { "probeProfile": "SENTEK_ENVIROSCAN", "sdi12ValueCount": 1 },
  "bytes": [12, 228, 1, /* ASCII for "+12.3" via toBytes() */],
  "expected": { "vwc_1": 12.3, "bat_v": 3.3 },
  "expectedQuarantine": []
},
{
  "name": "Sentek pre-identification, no sdi12ValueCount set: variable, no atomic rejection",
  "fPort": 2,
  "probeProfile": "SENTEK_ENVIROSCAN",
  "bytes": [12, 228, 1, /* ASCII for "+12.3+14.1+18.7+22.0+9.5+11.0" via toBytes() */],
  "expected": { "vwc_1": 12.3, "vwc_2": 14.1, "vwc_3": 18.7, "vwc_4": 22.0, "vwc_5": 9.5, "vwc_6": 11.0, "bat_v": 3.3 },
  "expectedQuarantine": []
},
{
  "name": "Sentek learned-count mismatch is rejected atomically",
  "fPort": 2,
  "probeProfile": "SENTEK_ENVIROSCAN",
  "deviceConfig": { "probeProfile": "SENTEK_ENVIROSCAN", "sdi12ValueCount": 5 },
  "bytes": [12, 228, 1, /* ASCII for a 4-value frame, e.g. "+12.3+14.1+18.7+22.0" via toBytes() */],
  "expected": { "bat_v": 3.3 },
  "expectedQuarantine": [{ "channel": "sdi12_value_count", "reason": "unknown_channel" }]
},
{
  "name": "Sentek learned count of 9 is clamped, falls back to variable (not accepted as literal 9)",
  "fPort": 2,
  "probeProfile": "SENTEK_ENVIROSCAN",
  "deviceConfig": { "probeProfile": "SENTEK_ENVIROSCAN", "sdi12ValueCount": 9 },
  "bytes": [12, 228, 1, /* ASCII for an 8-value frame via toBytes() */],
  "expected": { "vwc_1": "...", "vwc_2": "...", "vwc_3": "...", "vwc_4": "...", "vwc_5": "...", "vwc_6": "...", "vwc_7": "...", "vwc_8": "...", "bat_v": 3.3 },
  "expectedQuarantine": []
},
{
  "name": "HydraScout stays fixed-shape (regression guard: not swept into variable-count treatment)",
  "fPort": 2,
  "probeProfile": "HYDRASCOUT",
  "bytes": [12, 228, 1, /* ASCII for the existing 6-value interleaved frame */],
  "expected": { "vwc_1": "...", "soil_temp_1": "...", "soil_ec_1": "...", "vwc_2": "...", "soil_temp_2": "...", "soil_ec_2": "...", "bat_v": 3.3 },
  "expectedQuarantine": []
}
```
  Fill in the placeholder `"..."` values from a real bench-plausible HydraScout frame or the profile's existing pre-A6 test coverage if any exists; the point of this fixture is that HydraScout's interleaved labels must be unchanged by this task, not the specific numbers.

- [ ] **Update the runner.** `scripts/verify-device-integration.js:185-189` currently hardcodes `normalizer.normalize(decoded.data, { probeProfile: vector.probeProfile }, ...)`. Change it to `normalizer.normalize(decoded.data, vector.deviceConfig ?? { probeProfile: vector.probeProfile }, ...)` so vectors that need `sdi12ValueCount` (or any other future `deviceConfig` field) can supply the full object, while vectors that only need a profile keep working unchanged.

- [ ] **Run to see it fail:** `node scripts/verify-device-integration.js` → the new Sentek vectors fail (current code hard-generates exactly 6 `vwc_*` channels via `seq('vwc', 6)` regardless of `deviceConfig`, and `deviceConfig.sdi12ValueCount` is read nowhere).

- [ ] **Implement in `index.js`:** the `WORST_CHARS_PER_VALUE` correction, the `SENTEK_ENVIROSCAN`/`DELTAT_PR2_4`/`DELTAT_PR2_6` profile edits (`expectedValues: null`, `values: seq('vwc', 8)`, `defaultDepthsCm: []`), the `HYDRASCOUT` comment-only correction (explicitly **not** touching its `values`/`expectedValues`/`defaultDepthsCm`), and the `resolveCount`/clamp/`resolvedValueEntries` logic in `normalize()` exactly as described in Interfaces above. Also correct `worstCaseUplinkBytes()`'s doc comment if it cites the old constant.

- [ ] **Run to see it pass:** `node scripts/verify-device-integration.js` → all vectors pass, including the pre-existing TENSIOMARK/GENERIC_VWC/HYDRASCOUT ones (must stay green — proves the fix didn't touch unrelated or intentionally-excluded profiles). Also run the mirror unit test: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js`.

- [ ] **Confirm bcm2709 mirror parity:** `node scripts/verify-profile-parity.js` (already covers this directory per the Files note above).

- [ ] **Implement `sdi12-config-action-fn`, `sdi12-config-sqlite`, `sdi12-write-fn`** per Interfaces above, following the `osi-flows-json-editing` skill's edit procedure (byte-identical no-op roundtrip, `replaceOnce` against the exact current text, re-stringify, write both profiles).

- [ ] **Implement the modal field.** Add a "Value count" number input to `Sdi12SettingsModal.tsx`, rendered only when `selectedProfile.expectedValues == null`, wired into the existing `handleSave`'s `putSdi12Config` request as `value_count`. Add a Vitest case covering both visibility (shown for `SENTEK_ENVIROSCAN`/hidden for `TENSIOMARK`) and the save payload.

- [ ] **Run the frontend gate:** `cd web/react-gui && npm run test:unit && npm run typecheck` → exit 0.

- [ ] **Run the edge backend suites and flows gate** (the full nine-command set from Global Constraints) → all exit 0.

- [ ] **Commit** (edge, schema + normalize + flow + frontend can be one commit or split by the executor's judgment, but keep the cloud `resources.schema.json` mirror as its own cross-repo commit):
```bash
git add database/migrations/ordered/0047__sdi12_value_count.sql database/seed-blank.sql database/migrations/ordered/CHECKSUMS.json \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db database/farming.db web/react-gui/farming.db \
  scripts/verify-db-schema-consistency.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sdi12-normalize/index.js \
  scripts/fixtures/device-integration/sdi12/golden-vectors.json scripts/verify-device-integration.js \
  web/react-gui/src/components/farming/Sdi12SettingsModal.tsx web/react-gui/src/components/farming/__tests__/Sdi12SettingsModal.test.tsx web/react-gui/public/locales
git commit -m "feat(sdi12): per-device learned value count (option b), correct 9-char budget, HydraScout excluded from variable-count treatment"
```

**(c) fallback paragraph, if Phil picks (c) instead of (b):** option (c) — accept whatever count the frame actually has, no operator-set field, no atomic rejection for the variable profiles — drops steps 2 (config-action validation), 3 (config-sqlite SELECT), 4 (write-fn passthrough), and 6 (modal field) above entirely; only steps 1 (comment/budget correction), 5 restricted to the "variable" branch (no `sdi12ValueCount`-driven `resolvedCount`, `resolvedCount` is always `null` for the three affected profiles, so the cardinality check never fires), and 7 (fixtures minus the learned-count/clamp cases) remain. This also means the migration (`0047`) and its sync-contract mirror are dropped entirely — no new column, no cross-repo change. **Knowingly dropped under (c):** the truncation guard for Sentek — a genuinely truncated or corrupted frame (fewer readings than the probe actually has) would no longer be atomically rejected; it would simply be recorded as however many values happened to arrive, with no signal that something was cut short. This is the same tradeoff `GENERIC_VWC` already accepts today, extended to three more profiles.

---

# Wave B — cloud device catalog (cloud, with one cross-repo dependency)

## Task B1 — cloud catalog gains `TEKTELIC_CLOVER` and `AQUASCOPE_LORAIN` (no edge dependency)

**Confirmed with one correction (R-4).** `DeviceController.java:1237-1245`'s `getCatalog()` returns 4 types. The original draft claimed all 6 of the cloud's types (including `TEKTELIC_CLOVER`) are "already-`DeviceType`-declared" — **false for `TEKTELIC_CLOVER`**: `DeviceType.java` (confirmed by direct read, 2026-08-18) declares only `KIWI_SENSOR`, `STREGA_VALVE`, `DRAGINO_LSN50`, `SENSECAP_S2120`, `AQUASCOPE_LORAIN`, `DRAGINO_SDI12`, `GATEWAY` — no `TEKTELIC_CLOVER` constant exists anywhere in the cloud Java code. This does not block this task, though: `getCatalog()`'s existing four entries are all raw string literals (`Map.of("typeId", "KIWI_SENSOR", ...)`), not `DeviceType.KIWI_SENSOR` references — the method has never used the Java constants, so adding `"TEKTELIC_CLOVER"` as a literal string below is consistent with the method's existing style and does not require adding the missing constant first. (`AQUASCOPE_LORAIN` *is* correctly declared in `DeviceType.java`, and the frontend `deviceRegistry.tsx` already carries card wiring for both — that part of the original claim holds.)

**Files**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java` (lines 1237-1245).
- Modify/Create: `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java` (new test near the existing `@InjectMocks private DeviceController controller;` field — no MockMvc needed, `getCatalog()` takes no args and touches no mocks).

**Interfaces**
- Unchanged: `GET /api/devices/catalog` → `List<Map<String,String>>`, each entry `{typeId, name, description}`.

**Steps**

- [ ] **Write the failing test.** Add to `DeviceControllerTest.java`:

```java
@Test
void getCatalog_includesTektelicCloverAndAquascopeLorain() {
    ResponseEntity<List<Map<String, String>>> response = controller.getCatalog();

    List<String> typeIds = response.getBody().stream().map(entry -> entry.get("typeId")).toList();

    assertThat(typeIds).contains("TEKTELIC_CLOVER", "AQUASCOPE_LORAIN");
}
```

- [ ] **Run to see it fail:** `cd backend && ./gradlew test --tests 'org.osi.server.device.DeviceControllerTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
  Expected: `getCatalog_includesTektelicCloverAndAquascopeLorain` FAILS — `typeIds` is `[KIWI_SENSOR, STREGA_VALVE, DRAGINO_LSN50, SENSECAP_S2120]`, missing both asserted values.

- [ ] **Implement.** Replace:

```java
    @GetMapping("/catalog")
    public ResponseEntity<List<Map<String, String>>> getCatalog() {
        return ResponseEntity.ok(List.of(
                Map.of("typeId", "KIWI_SENSOR",      "name", "Kiwi Soil Sensor",           "description", "LoRa soil moisture & temperature sensor"),
                Map.of("typeId", "STREGA_VALVE",     "name", "Strega Valve",                "description", "LoRa smart irrigation valve"),
                Map.of("typeId", "DRAGINO_LSN50",    "name", "Dragino LSN50 Sensor Node",   "description", "LoRa temperature & dendrometer ADC node"),
                Map.of("typeId", "SENSECAP_S2120",   "name", "SenseCap S2120 Weather Station", "description", "LoRa 8-in-1 weather station")
        ));
    }
```

  with:

```java
    @GetMapping("/catalog")
    public ResponseEntity<List<Map<String, String>>> getCatalog() {
        return ResponseEntity.ok(List.of(
                Map.of("typeId", "KIWI_SENSOR",      "name", "Kiwi Soil Sensor",           "description", "LoRa soil moisture & temperature sensor"),
                Map.of("typeId", "STREGA_VALVE",     "name", "Strega Valve",                "description", "LoRa smart irrigation valve"),
                Map.of("typeId", "DRAGINO_LSN50",    "name", "Dragino LSN50 Sensor Node",   "description", "LoRa temperature & dendrometer ADC node"),
                Map.of("typeId", "SENSECAP_S2120",   "name", "SenseCap S2120 Weather Station", "description", "LoRa 8-in-1 weather station"),
                Map.of("typeId", "TEKTELIC_CLOVER",  "name", "Tektelic Clover",             "description", "LoRa soil moisture & temperature sensor"),
                Map.of("typeId", "AQUASCOPE_LORAIN", "name", "Aquascope LoRain",            "description", "LoRa tipping-bucket rain gauge")
        ));
    }
```

  (Name/description text: match the edge's `Return Catalog` node's own labels for these two types if it carries display names — check `flows.json` node `catalog-response` first and copy its exact wording rather than inventing new copy, so cloud and edge don't drift on device naming.)

- [ ] **Run to see it pass:** `cd backend && ./gradlew test --tests 'org.osi.server.device.DeviceControllerTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
  Expected: PASS. (Baseline from investigation: this class runs 89/89 green today; expect 90/90 after this addition. The scoped `--tests` pattern also runs an unrelated `ArchitectureTest.noNewPackageCycles` failure in this environment — a pre-existing ArchUnit `freeze.store` config issue, not attributable to this change; do not treat it as a regression, but do confirm it's still the *only* other failure, not a new one.)

- [ ] **Commit:**
```bash
git add backend/src/main/java/org/osi/server/device/DeviceController.java backend/src/test/java/org/osi/server/device/DeviceControllerTest.java
git commit -m "feat(device): expose TEKTELIC_CLOVER and AQUASCOPE_LORAIN in the cloud catalog"
```

---

## Task B2 — cloud catalog gains `DRAGINO_SDI12` (depends on Task A1)

**This task has a real dependency on Wave A, not just a suggested ordering.** `DeviceType.DRAGINO_SDI12` already exists in the cloud Java constants (`DeviceType.java:12`), but until Task A1 lands and deploys, a cloud-issued `REGISTER_DEVICE` command for `DRAGINO_SDI12` fails on the edge with `503 Unsupported device type or missing ChirpStack application/profile mapping` (`cs-reg-cloud-fn`'s `appMap`/`profileMap` gap). Do not merge this task's cloud-catalog widening ahead of A1's edge fix being deployed — the rollout law in Wave D governs the actual sequencing; this task itself can be *written and committed* independently, but its catalog entry must not go live before A1 does.

**Scope boundary, restated from the briefing:** this task exposes `DRAGINO_SDI12` for *registration* only. There is no cloud-side SDI-12 card component (`frontend/src/components/farming/deviceRegistry.tsx` has no `renderCard` for it), no history-card surface, no `ALLOWED_SENSOR_FIELDS` entry. A cloud-registered SDI-12 device will appear in whatever the cloud frontend's fallback rendering is for a device type with no `DEVICE_SECTIONS` entry — verify what that fallback actually renders (probably: the device is silently absent from the farming dashboard's grouped sections, since `DEVICE_SECTIONS` drives what's rendered) and confirm that's an acceptable "registers successfully, invisible in the cloud GUI until a future GUI-surface task" outcome before shipping. That full GUI surface is explicitly deferred, per the briefing.

**Files**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java` (`getCatalog()`, same method as B1 — if B1 and B2 are executed by different workers, whichever lands second must re-read the method's current state rather than assume B1's diff, since both touch the same lines).
- Modify: `frontend/src/components/farming/deviceRegistry.tsx` (`SUPPORTED_FARM_DEVICE_TYPES`, line 31-38) — add `'DRAGINO_SDI12'`. **Corrected 2026-08-18 (R-6):** the original draft claimed this is "so the add-device modal offers it" — verified false. `SUPPORTED_FARM_DEVICE_TYPES` is consumed only by `deviceRegistry.tsx` itself and its own tests; `AddDeviceModal` calls `devicesAPI.getCatalog()` directly and renders whatever the backend returns, independent of this frontend constant. The catalog entry from this task's backend change is what actually makes the add-device modal offer `DRAGINO_SDI12` — this frontend array edit is still correct and still required (it drives `deviceRegistry.parity.test.tsx`'s contract and whatever else keys off `SUPPORTED_FARM_DEVICE_TYPES`), it just isn't the thing that changes the modal's rendered options. Do not restate the false causal claim in the commit message.
- Modify: `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java`.
- Modify: `frontend/src/components/farming/__tests__/deviceRegistry.parity.test.tsx` (this file already has a precedent test excluding `MCLIMATE_UC512` from `DEVICE_SECTIONS` — follow its exact pattern for `DRAGINO_SDI12`: present in `SUPPORTED_FARM_DEVICE_TYPES`, absent from `DEVICE_SECTIONS`, and add a comment explaining why, citing this task).

**Interfaces**
- Unchanged shapes; additive catalog entry and additive registry-array entry only.

**Steps**

- [ ] **Write the failing tests.**

Backend (`DeviceControllerTest.java`):
```java
@Test
void getCatalog_includesDraginoSdi12() {
    ResponseEntity<List<Map<String, String>>> response = controller.getCatalog();

    assertThat(response.getBody().stream().map(entry -> entry.get("typeId")))
        .contains("DRAGINO_SDI12");
}
```

Frontend (`deviceRegistry.parity.test.tsx`, mirroring its existing `MCLIMATE_UC512` exclusion test):
```tsx
it('offers DRAGINO_SDI12 for registration but has no dedicated card yet (deferred GUI surface, task B2)', () => {
  expect(SUPPORTED_FARM_DEVICE_TYPES).toContain('DRAGINO_SDI12');
  expect(DEVICE_SECTIONS.map((section) => section.type)).not.toContain('DRAGINO_SDI12');
});
```

- [ ] **Run to see it fail:**
```bash
cd backend && ./gradlew test --tests 'org.osi.server.device.DeviceControllerTest' -x buildFrontend -x buildTerraIntelligenceFrontend
cd ../frontend && node_modules/.bin/vitest run --environment jsdom src/components/farming/__tests__/deviceRegistry.parity.test.tsx
```
  Expected: backend test fails (`DRAGINO_SDI12` absent from catalog); frontend test's first assertion fails (`SUPPORTED_FARM_DEVICE_TYPES` doesn't contain it yet — the second assertion trivially passes today since neither the type nor its absence is wired, which is not the same as proving the intended state, so don't stop at "one assertion failed" — read which one).

- [ ] **Implement.** Add `Map.of("typeId", "DRAGINO_SDI12", "name", "Dragino SDI-12 Soil Node", "description", "SDI-12 soil probe interface, up to 8 depths")` to `getCatalog()`'s list. Add `'DRAGINO_SDI12'` to `SUPPORTED_FARM_DEVICE_TYPES` in `deviceRegistry.tsx`.

- [ ] **Run to see it pass:** same two commands as above → both PASS.

- [ ] **Run the frontend's full parity/registry suite** to confirm no other test assumed a closed 6-type list: `cd frontend && npm run test:unit` (this is the pass gate, not the scoped vitest — run it once here since this touches a shared registry file many tests may import).

- [ ] **Commit, with the dependency called out explicitly:**
```bash
git add backend/src/main/java/org/osi/server/device/DeviceController.java backend/src/test/java/org/osi/server/device/DeviceControllerTest.java frontend/src/components/farming/deviceRegistry.tsx frontend/src/components/farming/__tests__/deviceRegistry.parity.test.tsx
git commit -m "feat(device): expose DRAGINO_SDI12 for cloud registration (deferred: no card yet)

Depends on edge task A1 (cs-reg-cloud-fn appMap gap) being deployed before
this catalog entry goes live -- see Wave D rollout law."
```

---

## Task B3 — `MILESIGHT_UC512` cloud parity (conditional on Decision D2 = "bring to parity")

**Do not execute this task if D2 resolved to "drop".** If dropped, mark this task N/A in the execution report with a one-line pointer back to D2's resolution; no commit.

If D2 = bring to parity:

**Files**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceType.java` (add `public static final String MILESIGHT_UC512 = "MILESIGHT_UC512";`).
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java` (`getCatalog()`).
- Modify: `frontend/src/components/farming/deviceRegistry.tsx` (`SUPPORTED_FARM_DEVICE_TYPES`; no `DEVICE_SECTIONS` entry, same deferred-GUI pattern as B2's `DRAGINO_SDI12`).
- Modify: `flows.json` (both profiles), node `cs-reg-cloud-fn` — add `MILESIGHT_UC512` to `appMap`/`profileMap`/consider `joinEuiMap` (check whether Milesight UC512 needs a non-default join EUI the way `AQUASCOPE_LORAIN` does — if unknown, leave `joinEuiMap` unchanged and note the open question rather than guessing a value that would silently mis-provision hardware).
- Tests mirroring B1/B2's exact pattern in both repos.

**Steps** — follow B1's Java test-first pattern for the catalog entry, B2's frontend parity-test pattern for the deferred-card assertion, and Task A1's flows.json edit procedure (wire-alignment guard, size-ratchet measure-and-raise, flows gate) for the `cs-reg-cloud-fn` map additions. Do not duplicate the full step-by-step here — the three tasks above are the exact templates; the only novel decision is the `joinEuiMap` question, which must be resolved (or explicitly left as a follow-up, never guessed) before commit.

- [ ] Confirm with Phil, before writing any code, whether Milesight UC512 needs a non-default LoRaWAN Join EUI (check the device's datasheet or existing bench notes — this plan's author could not verify this from source, per D2's own finding).
- [ ] Apply B1's pattern to `DeviceController.java` + its test.
- [ ] Apply B2's pattern to `deviceRegistry.tsx` + its parity test.
- [ ] Apply Task A1's flows.json edit procedure to `cs-reg-cloud-fn`.
- [ ] Commit each repo's half separately, cross-referencing this task and D2 in both commit messages.

---

# Wave C — design/cohesion (F1 cloud-only, F2 both repos)

## Task C1 — F1: cloud tab-view container widths and padding

**Confirmed, with the exact padding deltas the original finding didn't capture.**

| File:line | Current | Target |
|---|---|---|
| `frontend/src/pages/Dashboard.tsx:162` | `max-w-7xl mx-auto px-4 py-8` | `max-w-[1600px] mx-auto px-4 py-4` |
| `frontend/src/pages/JournalPage.tsx:508` | `mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 md:flex-row md:items-end md:justify-between` | `mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-4 md:flex-row md:items-end md:justify-between` |
| `frontend/src/pages/JournalPage.tsx:530` | `mx-auto max-w-7xl px-4 py-6` | `mx-auto max-w-[1600px] px-4 py-4` |

`HistoryDashboard.tsx:161` (`max-w-[1600px] px-4 py-4`) and `CrossZoneAnalysisPage.tsx:167,178` (`max-w-[1600px] ... px-4 py-4`) are already correct — they are the normalization target, not files to change. `py-4` is the chosen default (matching those two already-correct files) rather than inventing a fourth value; this is a judgment call the executor is authorized to make without a separate Phil decision, since it's purely cosmetic and reversible.

No guard test pins these classes in either repo (`grep -rn "max-w-" --include="*.test.tsx"` returns zero hits in both) — this is a free change with no test-blast-radius to manage.

**Files**
- Modify: `frontend/src/pages/Dashboard.tsx` (line 162).
- Modify: `frontend/src/pages/JournalPage.tsx` (lines 508, 530).
- Create: `frontend/src/pages/__tests__/tabContainerWidths.test.tsx` — a new guard test, since none exists, pinning the now-uniform width so a future edit can't silently reintroduce the split (per the playbook's "guard tests pin contracts" rule — this finding shipped unnoticed for exactly this reason).

**Steps**

- [ ] **Write the failing test.** This is a static-source guard, not a rendered-DOM assertion (simpler, and avoids needing to mount three full pages with their data dependencies just to check a className). **Corrected 2026-08-18 (R-7/R-8):** the cloud `frontend/vitest.config.*` does not set `globals: true` — `describe`/`it`/`expect` must be imported explicitly from `'vitest'`, unlike some other-repo test files that rely on injected globals. Also, the original draft only asserted the *negative* (`max-w-7xl` absent) — a weakly-vacuous guard that would also pass if a file used neither class, or some unrelated third width. Assert the **positive** pin (`max-w-[1600px]` present) too, so the guard actually proves convergence, not just an absence:

```tsx
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('tab-view container widths stay uniform (F1 guard)', () => {
  const files = ['Dashboard.tsx', 'JournalPage.tsx', 'HistoryDashboard.tsx', 'CrossZoneAnalysisPage.tsx'];

  it('every tab-view page container uses max-w-[1600px], not max-w-7xl', () => {
    for (const file of files) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(source, `${file} must not use max-w-7xl for its tab-view container`).not.toMatch(/max-w-7xl/);
      expect(source, `${file} must use max-w-[1600px] for its tab-view container`).toMatch(/max-w-\[1600px\]/);
    }
  });
});
```

- [ ] **Run to see it fail:** `cd frontend && node_modules/.bin/vitest run --environment jsdom src/pages/__tests__/tabContainerWidths.test.tsx`
  Expected: fails on `Dashboard.tsx` and `JournalPage.tsx` both containing `max-w-7xl`.

- [ ] **Implement** the three className edits from the table above (exact string replace on each line — verify the surrounding className string byte-for-byte before editing, Tailwind class lists are order-sensitive to read but not to functionality, so preserve the existing class order and only swap `max-w-7xl` → `max-w-[1600px]` and `py-8`/`py-5`/`py-6` → `py-4`).

- [ ] **Run to see it pass:** `cd frontend && node_modules/.bin/vitest run --environment jsdom src/pages/__tests__/tabContainerWidths.test.tsx` → PASS.

- [ ] **Run the pages' own existing tests** to confirm no snapshot or rendered-layout assertion broke: `cd frontend && npm run test:unit` (full pass gate — this task touches widely-imported page files).

- [ ] **Commit:**
```bash
git add frontend/src/pages/Dashboard.tsx frontend/src/pages/JournalPage.tsx frontend/src/pages/__tests__/tabContainerWidths.test.tsx
git commit -m "fix(gui): normalize tab-view container width and padding to match HistoryDashboard/CrossZoneAnalysisPage"
```

---

## Task C2 — F2: tab prominence inversion (BOTH repos, cross-repo serialization point)

**Confirmed identical in both repos, byte-for-byte** — this is not a cloud-only regression, it is a shared design defect that shipped the same way on both sides:

- `LIQUID_SIZING = 'px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg'` — cloud `AppHeader.tsx:31`, edge `AppHeader.tsx:33`. Consumed by `LIQUID_BUTTON`/`LIQUID_MENU_TRIGGER` (Settings/Account/Language chrome), both add `font-bold`.
- Tab pill: `` `glass-tab px-5 py-2 text-[15px] font-semibold ${...}` `` — cloud `AppHeader.tsx:111`, edge `AppHeader.tsx:99`.

Measured: tab 39px tall inside a 49px pill vs. chrome buttons 54px vs. zone-card actions 56px. Phil's directive: **invert** the hierarchy — tabs become the visually dominant navigation, not merely equal to chrome. **This task does not touch `--primary`** (that's Decision D1, separate, resolve independently).

**Replanned 2026-08-18 (R-10).** The original draft's proposed tab classes (`px-5 py-3 text-base sm:px-7 sm:py-3.5 sm:text-lg font-bold`) used the **same text-size tokens as chrome** (`LIQUID_SIZING` is `text-base sm:text-lg`) — only the padding grew. That does not achieve "invert the hierarchy, tabs become dominant" — it makes tabs merely *equal* to chrome at the text-size level a reader actually perceives first, with `font-bold` added on both sides already (chrome already has `font-bold` via `LIQUID_BUTTON`/`LIQUID_MENU_TRIGGER`, so that part of the original test's `toContain('font-bold')` assertion would trivially pass even with no real inversion — a weakly-vacuous guard). Corrected: **step the tab text size one token past chrome at every breakpoint** — `text-lg sm:text-xl` (chrome stays `text-base sm:text-lg`) — so `lg > base` and `xl > lg` hold at both breakpoints, a genuine, testable size inversion, not just heavier padding around the same font size.

**One vertical scale, applied identically in both repos, exported as a named constant.** Add `const TAB_SIZING = 'px-5 py-3 text-lg sm:px-7 sm:py-3.5 sm:text-xl';` next to `LIQUID_SIZING` in both `AppHeader.tsx` files (`export`ed so the test file can import it directly and assert the actual token, not a regex re-derivation of it). Chrome (`LIQUID_SIZING` itself) is left completely unchanged — the simplest inversion is asymmetric: raise the tabs, don't lower the chrome (lowering Settings/Account risks a tap-target regression on buttons already sized for icon-only content).

**Files**
- Modify: `frontend/src/components/AppHeader.tsx` (cloud) — add `TAB_SIZING`, apply it to the `glass-tab` template literal, ~line 111.
- Modify: `web/react-gui/src/components/AppHeader.tsx` (edge) — same, ~line 99.
- Create: `web/react-gui/src/components/__tests__/AppHeader.test.tsx` (edge has **no** AppHeader test file at all today — this task adds a minimal one, mirroring cloud's existing `frontend/src/components/__tests__/AppHeader.test.tsx`).
- Modify: `frontend/src/components/__tests__/AppHeader.test.tsx` (cloud) if it asserts anything about the current padding/size classes (investigation found it asserts `.glass-tab` presence and tab count, lines 70/75-76, **not** the size classes — so it should NOT need changing, but re-check before assuming).

**Interfaces**
- Unchanged: `LIQUID_SIZING`, `LIQUID_BUTTON`, `LIQUID_MENU_TRIGGER` — this task does not touch chrome sizing, and does not touch `--primary` (Decision D1 is separate — see D1 above; leave that token alone).
- New, exported: `TAB_SIZING`, in both repos, same value.
- Changed: the `glass-tab` pill's own Tailwind classes, in both repos, to consume `TAB_SIZING`.

**A stale-comment note found during investigation, not part of this task's scope:** cloud `AppHeader.tsx:86-88` has a comment referencing a `chromeTokens.test.ts` PALETTE regex guard that does not exist in either repo (grepped, zero hits) — it is not a real blast-radius constraint on this task, but is worth a one-line cleanup commit separately; do not let it block or scope-creep this task.

**Wrap sanity note (advisory, both repos):** the header row is `flex-wrap`; growing the tab pill at `sm` widens the wrap band roughly 640-830px (tablet widths) — not a break, but visually check the header at 390px (small phone) and across 640-830px in a real browser or devtools after implementing, since jsdom cannot catch a wrap regression.

**Steps**

- [ ] **Write the failing test in the cloud repo first** (it already has a header test file to extend). **Corrected 2026-08-18 (R-10):** the original draft queried `screen.getByRole('button', { name: /settings/i })` — verified false: Settings renders as a `<Link>` (`role: 'link'`), not a button, in both repos' `AppHeader.tsx`. Also, asserting `toMatch(/text-lg|text-base/)` + `toContain('font-bold')` on the tab alone proves nothing about *inversion* — it would pass even if tabs and chrome were identically sized (both already have `font-bold`, and `text-base` matches chrome's own size). Assert **relative ordering** against the actual `LIQUID_SIZING`/`TAB_SIZING` tokens instead — that tabs rank strictly larger than chrome at both the base and `sm:` breakpoints:

```tsx
import { describe, it, expect } from 'vitest';
import { LIQUID_SIZING, TAB_SIZING } from '../AppHeader';

const TEXT_SIZE_RANK: Record<string, number> = { sm: 1, base: 2, lg: 3, xl: 4, '2xl': 5 };

function sizeTokens(sizing: string): { base: number; sm: number } {
  const baseMatch = sizing.match(/(?:^|\s)text-(sm|base|lg|xl|2xl)(?:\s|$)/);
  const smMatch = sizing.match(/sm:text-(sm|base|lg|xl|2xl)/);
  if (!baseMatch || !smMatch) throw new Error(`could not parse text-size tokens from "${sizing}"`);
  return { base: TEXT_SIZE_RANK[baseMatch[1]], sm: TEXT_SIZE_RANK[smMatch[1]] };
}

it('tab text size ranks strictly above chrome text size at every breakpoint (F2)', () => {
  const chrome = sizeTokens(LIQUID_SIZING);
  const tab = sizeTokens(TAB_SIZING);
  expect(tab.base, 'base breakpoint: tab text size must exceed chrome').toBeGreaterThan(chrome.base);
  expect(tab.sm, 'sm breakpoint: tab text size must exceed chrome').toBeGreaterThan(chrome.sm);
});

it('tab pill renders with the current TAB_SIZING classes and role="link" Settings chrome (F2)', () => {
  const { container } = render(<AppHeader {...defaultProps} />);
  const tab = container.querySelector('.glass-tab');
  const settingsLink = screen.getByRole('link', { name: /settings/i });

  expect(tab?.className).toContain(TAB_SIZING);
  expect(settingsLink).toBeInTheDocument();
});
```

  **Executor note:** jsdom does not compute real layout, so a pixel-height assertion is not meaningful here — the tests above assert on the actual exported constants and className tokens, not rendered geometry. Adjust `defaultProps`/`render` calls to match this file's existing setup exactly.

- [ ] **Write the equivalent failing test in the edge repo** (new file, following the same render/props conventions as the edge's other component tests — e.g. `ZoneDeviceModal.test.tsx`'s `// @vitest-environment jsdom` header and mock conventions):

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AppHeader, LIQUID_SIZING, TAB_SIZING } from '../AppHeader';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const TEXT_SIZE_RANK: Record<string, number> = { sm: 1, base: 2, lg: 3, xl: 4, '2xl': 5 };

function sizeTokens(sizing: string): { base: number; sm: number } {
  const baseMatch = sizing.match(/(?:^|\s)text-(sm|base|lg|xl|2xl)(?:\s|$)/);
  const smMatch = sizing.match(/sm:text-(sm|base|lg|xl|2xl)/);
  if (!baseMatch || !smMatch) throw new Error(`could not parse text-size tokens from "${sizing}"`);
  return { base: TEXT_SIZE_RANK[baseMatch[1]], sm: TEXT_SIZE_RANK[smMatch[1]] };
}

describe('AppHeader tab prominence (F2)', () => {
  it('tab text size ranks strictly above chrome text size at every breakpoint', () => {
    const chrome = sizeTokens(LIQUID_SIZING);
    const tab = sizeTokens(TAB_SIZING);
    expect(tab.base).toBeGreaterThan(chrome.base);
    expect(tab.sm).toBeGreaterThan(chrome.sm);
  });

  it('tab pill renders with the current TAB_SIZING classes', () => {
    // Fill in whatever minimal props AppHeader requires -- read the component's
    // props interface first, this is the file's first-ever test so there is no
    // existing render helper to copy.
    const { container } = render(<AppHeader /* ...required props... */ />);
    const tab = container.querySelector('.glass-tab');
    expect(tab?.className).toContain(TAB_SIZING);
  });
});
```

- [ ] **Run both to see them fail:**
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && node_modules/.bin/vitest run --environment jsdom src/components/__tests__/AppHeader.test.tsx
cd /home/phil/Repos/osi-os-agrolink/web/react-gui && node_modules/.bin/vitest run --environment jsdom src/components/__tests__/AppHeader.test.tsx
```
  Expected: both fail — `TAB_SIZING` does not exist yet (import error / undefined), and the current tab class is `text-[15px] font-semibold`.

- [ ] **Implement identically in both repos.** `LIQUID_SIZING` is currently a module-private `const` in both files (not exported) — the tests above import it, so this task must also add `export` to the existing `LIQUID_SIZING` declaration (`const LIQUID_SIZING` → `export const LIQUID_SIZING`), a one-word change with no behavior impact, alongside adding the new exported constant next to it:

```tsx
export const LIQUID_SIZING = 'px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg';
// ...
export const TAB_SIZING = 'px-5 py-3 text-lg sm:px-7 sm:py-3.5 sm:text-xl';
```

  Replace:

```tsx
`glass-tab px-5 py-2 text-[15px] font-semibold ${...}`
```

  with:

```tsx
`glass-tab ${TAB_SIZING} font-bold ${...}`
```

  Apply this exact pair of edits to both `AppHeader.tsx` files. **This is the cross-repo serialization point**: if two different executors take Wave C's edge and cloud halves in parallel, they must use this identical `TAB_SIZING` string, not independently-derived-but-similar ones — copy it verbatim into both diffs rather than having each side reinvent it.

- [ ] **Run both to see them pass**, then each repo's full test:unit pass gate:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit
cd /home/phil/Repos/osi-os-agrolink/web/react-gui && npm run test:unit && npm run typecheck
```

- [ ] **Commit each repo separately, cross-referencing the other:**

Cloud:
```bash
git add frontend/src/components/AppHeader.tsx frontend/src/components/__tests__/AppHeader.test.tsx
git commit -m "fix(header): tabs read as the primary navigation over chrome buttons (F2, paired with osi-os-agrolink)"
```

Edge:
```bash
git add web/react-gui/src/components/AppHeader.tsx web/react-gui/src/components/__tests__/AppHeader.test.tsx
git commit -m "fix(header): tabs read as the primary navigation over chrome buttons (F2, paired with osi-server)"
```

---

# Wave D — lockstep deploy and post-deploy verification

Do not start Wave D until: every task above (except any Wave B task N/A'd by Decision D2) is committed and green in its own repo, and a reviewer (not the task's author) has re-run each task's own gate commands fresh per `docs/engineering-playbook.md` §2's independent-verification stage. This plan does not itself constitute that review.

**Rollout order — cloud before edge, always**, per the standing rollout law this branch line already follows (see the 2026-08-13 fix-wave plan's "Rollout law" section for the precedent): a cloud-issued `REGISTER_DEVICE` for a type the edge doesn't yet support (Task B2's `DRAGINO_SDI12`, and B3's `MILESIGHT_UC512` if executed) must never reach a gateway before that gateway has A1's fix. Concretely:

- [ ] **1. Deploy cloud first.** **Corrected 2026-08-18 (B-4, BLOCKING in the original draft).** The original draft's `docker compose build backend && docker compose up -d --no-deps backend` was the plain production `osi-server` invocation, written from memory — it does not match how AgroLink actually runs. `agro-link.ch` is a **separate compose project (`agrolink`)** running on the **production VM** (`osicloud.ch` host) at `/home/rocky/docker/agrolink/osi-server`, alongside — not instead of — the main `osi-server`/Vaultwarden production stack. Source arrives by git bundle, not a git pull, and the compose invocation needs the project flag plus three `-f` files, one of which (`docker-compose.agrolink.yml`) is **untracked on the VM and must never be overwritten**:
  ```bash
  # From this workstation: bundle the range that needs shipping (adjust the base
  # ref to whatever the VM's current HEAD actually is -- check first, don't guess):
  git bundle create /tmp/agrolink-deploy.bundle <last-known-VM-HEAD>..feat/journal-cloud-primary
  scp -i ~/.ssh/osicloud_rsa -o HostKeyAlias=osicloud.ch -o HostKeyAlgorithms=ecdsa-sha2-nistp256 \
    /tmp/agrolink-deploy.bundle rocky@agro-link.ch:/tmp/agrolink-deploy.bundle

  # On the VM (same SSH alias form as the rest of this branch's precedent):
  ssh -i ~/.ssh/osicloud_rsa -o HostKeyAlias=osicloud.ch -o HostKeyAlgorithms=ecdsa-sha2-nistp256 rocky@agro-link.ch
  cd /home/rocky/docker/agrolink/osi-server
  git fetch /tmp/agrolink-deploy.bundle feat/journal-cloud-primary
  git merge --ff-only FETCH_HEAD
  # Postgres dump before touching anything:
  docker exec <agrolink-postgres-container> pg_dump -U osiserver osiserver > /home/rocky/backups/agrolink-pre-wave1-$(date +%Y%m%d%H%M%S).sql
  docker compose -p agrolink -f docker-compose.yml -f docker-compose.dev-build.yml -f docker-compose.agrolink.yml build backend
  docker compose -p agrolink -f docker-compose.yml -f docker-compose.dev-build.yml -f docker-compose.agrolink.yml up -d --no-deps backend
  ```
  **Hard gate: this step runs against a production host (`osicloud.ch`). It requires Phil's explicit go in the same turn — do not proceed on a loaded key/alias or a prior approval alone.** Never `git pull`/overwrite `docker-compose.agrolink.yml` on the VM — it is untracked there by design and this workflow's whole point is layering on top of it without disturbing it.

- [ ] **2. Post-cloud-deploy check:** hit `GET /api/devices/catalog` against the deployed backend and confirm the response now lists the corrected count. **Corrected 2026-08-18 (R-9):** the original draft said "6 (or 7, if B3 executed)" — the actual arithmetic is 4 (existing) + 2 (B1: `TEKTELIC_CLOVER`, `AQUASCOPE_LORAIN`) + 1 (B2: `DRAGINO_SDI12`) = **7**, or **8** if B3 (`MILESIGHT_UC512`) also executed.

- [ ] **3. Deploy edge, one gateway at a time, starting with the test gateway.** Follow the documented safe flow (not the wrapper): build the edge GUI once (`cd web/react-gui && npm run build` — the one frontend build this plan permits, and only one at a time even across gateways), `tar czf react_gui.tar.gz -C web/react-gui/build .`, serve the repo root locally (`python3 -m http.server 9876 --bind 127.0.0.1`), then per gateway: `ssh -R 9876:localhost:9876 root@<pi> 'curl -fsS http://localhost:9876/deploy.sh | sh'` followed by `/etc/init.d/node-red restart`. ChirpStack reprovisions automatically on restart (osi-bootstrap START=99). Order: `agrolink-test-01` first, `kaba100` second — never both concurrently, and never Silvan/Uganda as part of this wave (they are flag-off production gateways this plan's changes should not affect, but confirm nothing in Wave A/C touched a flag-off code path in a way that needs re-verifying against them specifically before considering this wave fully closed).

- [ ] **4. Post-edge-deploy checks, per gateway, in this order (do not skip any):**
  - GUI bundle hash changed (compare the served `index.html`'s asset hash before/after).
  - `farming.db` preserved: `ssh root@<pi> 'ls -la /data/db/farming.db'` shows the same file (pre-existing size/mtime lineage, not a fresh-seeded file) and fresh telemetry is still arriving (`sqlite3 /data/db/farming.db "SELECT MAX(created_at) FROM device_data;"` is recent, not stale).
  - `…/export.csv` still returns 401 unauthenticated (auth-gated = healthy, not a regression to open access).
  - ChirpStack still shows `RAK10701` + `S2120` present (the two always-expected device types on a demo/test gateway).
  - **[N/A this deploy — A6 NOT shipped (pending Q1)] Migration `0047` applied.** Task A6's schema change is delivered by `deploy.sh`'s `run_schema_migration()` automatically during the deploy flow above (per `osi-schema-change-control`) — no separate manual step, but confirm it actually ran: `sqlite3 /data/db/farming.db "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;"` should show `47`, and `sqlite3 /data/db/farming.db ".schema devices" | grep sdi12_value_count` should show the column.
  - **Task A1/A2 e2e check, the walkthrough's actual purpose:** register a fresh SDI-12 device (or use the existing fixture device `A840410000000101` on `agrolink-test-01` if it's already registered — check first, don't double-register) and confirm identify succeeds without a 409:
    ```bash
    curl -s -X POST https://<gateway-or-tunnel>/api/devices/A840410000000101/sdi12/identify -H "Authorization: Bearer <token>"
    ```
    Expected: `202`, not `409`. **Advisory, real-hardware expectation (see Task A4's Interfaces):** a `202` means the request was accepted, not that identification succeeds — every `PROFILES[i].identityMatch` is still `null` pre-bench-capture, so the device's `sdi12_probe_status` will land on `unmatched` after the next uplink, not `identified`. This e2e check must assert `202` at request time and `unmatched|identified` (not a bare success/failure binary) at the settle-check — treat `unmatched` as a pass, not a regression. Then confirm `chirpstack_app_id` is non-null for that row: `sqlite3 /data/db/farming.db "SELECT chirpstack_app_id FROM devices WHERE deveui='A840410000000101';"`.
  - **[N/A this deploy — A6 NOT shipped (pending Q1)] Task A6 e2e check** (if bench hardware is available for this walkthrough session — if not, this check is deferred to the next bench session and the walkthrough proceeds without it, noted explicitly as an open item, not silently skipped): set a `sdi12_value_count` on a live Sentek device via the settings modal, then confirm a probe reporting fewer than 8 readings now reports correctly instead of quarantining to `unknown.sdi12_value_count`, and that a HydraScout device's temperature/EC channels are still labeled correctly (unaffected by this task).
  - **SF-1 observation (from the final branch review): fresh-hardware auto-identify.** The registration-time hook enqueues `0I!` before the device has joined, and ChirpStack v4 flushes the device queue on OTAA join; the trigger already set `pending_identify`, so the first-join guard in `sdi12-write-fn` will not re-fire. Expected symptom on a brand-new probe: status stays `pending_identify`, then the client shows the no-response state at 15 min until a manual **Re-check probe**. Observe on the test-01 fixture / next bench probe whether status leaves `pending_identify` without a manual re-check; if it does not, this is the wave-2 fix (also fire first-join when status is `pending_identify` and the device has no prior `device_data` row).
  - **Task B2 e2e check:** from the cloud UI, register a new `DRAGINO_SDI12` device against the test gateway and confirm the `REGISTER_DEVICE` command ACKs `SUCCESS`, not the pre-A1 `503`.

- [ ] **5. Only after every check in step 4 passes on `agrolink-test-01`**, repeat steps 3-4 for `kaba100`.

- [ ] **6. Record.** Update this plan's own ledger table (or a short execution-report companion file, per this branch's existing convention — see `2026-08-13-dragino-sdi12-execution-report.md` for the precedent format) with what actually shipped vs. what was deferred: Decision D1 unresolved = no Wave C `--primary` follow-up filed yet; Decision D2's outcome; whether Task A6 executed as option (b) or the (c) fallback, and Phil's confirmation of which; Task A4's B-1 reframing (no `no_response` DB status, client-derived only) confirmed accepted or revisited; any Task A4 sub-feature descoped for a missing TX-interval column. File follow-up issues for anything chosen not to do, per the playbook's definition-of-done — do not leave them as silence.
