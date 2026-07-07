# Deploy Canary Gate — Heartbeat-Verified Staged Rollout

**Status:** Draft — refactor-program item 0.2 (DD10, gate half)
**Focus:** osi-os (operator tooling + one small flows addition); one possible additive pass-through in osi-server
**Written:** Fable-direct (design core), plan elaboration delegated; facts verified 2026-07-07.

## Problem

Deploys are manual, per-Pi, and unverified: after `deploy.sh` runs there is no machine-checked confirmation that the gateway came back healthy before the operator moves to the next device. The refactor program's Track B (deliver migration 0004 → demos → Uganda) and every future flows/schema rollout need a gate: **refuse to advance the rollout until the just-deployed gateway reports N consecutive healthy heartbeats.** The raw material exists — heartbeat #100 ships `health.schema_sig` and `health.disk_free_pct` at 60 s cadence, and osi-server's `SyncHealthService` already computes a per-gateway verdict with machine-readable reasons (e.g. `schema_sig_not_accepted`, backed by an accepted-signature allowlist) served at `GET /api/v1/admin/sync-health` — but nothing consumes it as a deploy gate.

**Verified gap:** the edge `error_counts` global (from #102's `Record Error` node) is **not** in the heartbeat payload — `Build Heartbeat` reads `global.get('edge_health')` (with a 180 s freshness guard) and no flows node writes `errors_total` into it. This was #102's explicitly deferred DoD line ("when #1 is present"); #100 is present, so this item absorbs that 2-line slice.

## Design

### A. The gate is a server-verdict consumer, not new health logic

`scripts/deploy-canary-gate.js` (osi-os, Node, `node --test`-able) polls `GET /api/v1/admin/sync-health` and evaluates ONE gateway against the criteria in §C. It computes nothing the server doesn't already know except deltas (§C.4) and consecutiveness. Rationale: the server verdict is the single health authority (heartbeats already flow edge→cloud); duplicating verdict logic in a script recreates the drift class this program keeps killing. Auth: admin JWT via `OSI_ADMIN_TOKEN` env — the exact precedent of `scripts/refresh-chameleon-calibrations.js`.

### B. Edge slice: wire `errors_total` into the heartbeat (the #102 leftover)

The assembling node is **`Gather Edge Health`** (id `2a4f142e3e9b6d80`) — it merges `osiHealth.gatherEdgeHealth(db)` into `global.set('edge_health', ...)`; it adds `errors_total` and `errors_last_at` from `global.get('error_counts')` directly (not via the DB-backed helper). `Build Heartbeat` (id `062a0f9bf66d9789`) is **not** a generic pass-through — its `healthValue` mapping is a closed allowlist with fresh/stale branches, so both branches gain the two keys explicitly. The CI verifier `scripts/verify-heartbeat-health.js` hard-gates the exact key list (`REQUIRED_HEALTH_KEYS`, 7 → 9) and must be updated in the same commit. Both profiles, byte-parity, no frozen-node contact.

Server side (verified, needed): `SyncHealthService` is closed at **two** layers — the SQL extracts exactly five named `#>>` JSON paths and `edgeHealth()` maps exactly those five — so the two fields are added symmetrically (two SQL columns + two Java `put()` calls, reusing the existing nullable helpers). Additive only; no new verdict `reasons` — the gate, not the server, judges error deltas (a rising counter is diagnostic, per #102's design).

### C. Gate criteria (all must hold; each is CLI-tunable with these defaults)

1. **Freshness + liveness:** latest heartbeat for the EUI is ≤ 120 s old, and its timestamp is **after** `--since <deploy-ts>` (the gate never passes on pre-deploy heartbeats).
2. **Server verdict:** the sync-health entry for the EUI reports no failure reasons. If `--expect-schema-sig <sig>` is given (schema-changing deploys — Stage 1/0004 delivery), the reported `schemaSig` must equal it exactly; otherwise `schema_sig_not_accepted` absence suffices.
3. **Disk:** `disk_free_pct ≥ 10` (default; matches the heartbeat's existing field).
4. **Error delta:** `errors_total` did not increase across the observation window. The gate records the first post-deploy value as its own baseline — no pre-deploy capture step, no persistence; a crash-looping or brick-quarantined node shows up as a rising counter within the window.
5. **Consecutiveness:** criteria 1–4 hold for **N = 5 consecutive polls** (60 s apart, matching heartbeat cadence — ≈5 min green window). Any failing poll resets the count. `--timeout 900` (15 min) total budget; on expiry the gate FAILS with the last-seen reasons.

Exit contract: `0` = PASS (advance the rollout); `1` = FAIL with a reason summary on stderr (do not advance; investigate or roll back per runbook); `2` = usage/auth/transport errors (the gate itself couldn't judge — treat as FAIL for rollout purposes).

### D. Rollout runbook shape (documented, not automated)

`deploy kaba100 → gate kaba100 → deploy Silvan → gate Silvan` — Uganda only inside its #87 window with this same gate as the final verification step (the heartbeat is the only remote post-migration signal Uganda has, per the Option B plan). The gate does not deploy, does not roll back (payload atomicity/rollback is item 5.3), and does not orchestrate the fleet — it is the go/no-go check between manual steps. Its first live validation is item 0.1's own deploy of the merged flows to the demo gateways.

## Non-goals

- No automatic rollback (5.3), no fleet orchestration/parallel rollout, no Pi-side agent or SSH from the gate (server-verdict only — works from any operator machine that can reach the cloud).
- No server verdict changes: error-delta judgment lives in the gate by design; `schema_sig` acceptance stays the server's existing allowlist mechanism (re-harvesting accepted sigs after a schema deploy is the existing #100 operational step, referenced not changed).
- No fix for #107 (`schema_sig` CHECK-blindness) — the gate consumes whatever signature mechanism exists; Stage 0's shared normalization is that fix's seam.

## Definition of Done

- `scripts/deploy-canary-gate.js` + `node --test` suite (mocked sync-health HTTP fixture: pass path, each criterion failing, consecutiveness reset, timeout, `--expect-schema-sig` mismatch, auth failure → exit 2), wired into an existing osi-os CI workflow.
- `errors_total`/`errors_last_at` present in live heartbeat payloads (both profiles byte-identical; `verify-profile-parity.js` green) and visible in the sync-health response (with the osi-server pass-through if needed).
- Runbook section (in `docs/operations/`, or appended to the deploy docs) covering §D, including the Uganda note.
- Gate exercised once for real: item 0.1's demo-gateway deploy uses it and its PASS output is recorded as evidence.
- Program doc phase table updated (0.2 outcome + PR link).
