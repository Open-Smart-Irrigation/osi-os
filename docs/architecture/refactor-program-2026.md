# OSI System Refactor Program 2026 — Modularity, Stability, Performance, Flexibility

**Status:** Adopted roadmap — 2026-07-07
**Scope:** Both repos (osi-os edge + osi-server cloud)
**Inputs:** Three independent expert reviews (IoT edge systems, cloud backend, software architecture) against a shared factual briefing, plus a cross-examination round resolving conflicts. Full provenance in [`analysis/refactor-program-2026/`](../../analysis/refactor-program-2026/) (briefing, three reports, cross-examination ruling).
**Governing ADRs (hard constraints):** [static in-repo device plugins](../adr/2026-05-28-static-device-plugin-registry.md) · [schema & contract ownership](../adr/2026-06-30-schema-and-contract-ownership.md) (no shared DDL codegen; ordered migrations own edge DDL; contracts own cross-repo compatibility; consumed-or-deleted invariant for generated artifacts).

## How to use this document

This is the **program map**, not a spec. Each item below is a charter line: goal, repo, dependency, size (S/M/L), and whether it needs its own **brainstorm → spec → adversarial review → implementation plan** cycle (`spec+plan`) or can go straight to a PR (`direct`) or is a live-ops runbook execution (`runbook`). Work items are executed one at a time by worker agents against written plans, per [`docs/engineering-playbook.md`](../engineering-playbook.md). Every phase leaves both repos shippable and the fleet strictly safer than before.

## Ground truth the program is built on (verified 2026-07-07, correcting earlier framing)

1. **The strangler extraction has already started, without guardrails.** `conf/.../node-red/osi-history-helper/` is a real extracted module (~105 KB + 18.7 KB) loaded from function nodes via a **bare absolute `require`** — which is exactly the silent-brick risk of issue #99, live in production paths, with **no co-located tests**. The program is "ratchet + test what exists, then extend," not "start extracting."
2. **The channel manifest already exists.** `web/react-gui/src/channels/channels.json` (key/unit/edgeField/serverField/legacyAliases/exportable/deprecated) is CI-parity-checked by `verify-channel-manifest-parity.js`. The narrow-waist writer's backbone is built; what's missing is the writer and the round-trip verifier.
3. **flows.json:** 572 nodes, 235 function nodes, **1,064,794 func-chars/profile embedded JS** (scoreboard baseline measured at `origin/main` `5e04b8a2`, 2026-07-10). Largest: History API Router 76,225 chars, Sync Init 73,162 chars (frozen), Zone Env Summary 67,317 chars, Daily Dendro 57,047 chars, Run Force Sync 45,590 chars.
4. **A destructive migration is merged and undeliverable.** `0004` (fixes farmer-facing #92) cannot reach live gateways: `deploy.sh`'s migration hook is gated to `-- risk: additive` only. This satisfied the ownership ADR's stated promotion trigger for Option B (issue #88).
5. **osi-server has zero CI** (`.github/` holds only a PR template). Tests are Mockito-only; **no test runs against Postgres or Flyway** — the code mutating farm-mirror data (sync apply) is untested against a real database.
6. **A poison-pill batch hazard is live in sync ingest.** `EdgeSyncService.applyEventsV2` (93 KB god-file) wraps the whole batch in one `@Transactional`; one poison event marks it rollback-only and the batch fails repeatedly, losing dedup rows for events that succeeded. A weeks-stale gateway replaying backlog — i.e. **the Uganda catch-up (#87)** — is the trigger scenario.
7. **Dead-lettered events vanish untraceably** (the real #89 residual): `SyncInboxEvent` has no status/reason/payload columns; a rejected event is byte-identical to an applied one and its payload is gone.
8. **The VPS compiles its own images** (compose `build:` runs Gradle + two Vite builds on the 4 CPU/4 GB host next to farm-mirror data) — the documented cause of production unresponsiveness.
9. **Edge robustness gaps:** procd runs Node-RED with `respawn 3600 5 -1` (infinite respawn — a crash-looping gateway looks alive); `sync_outbox` has **no delivered-row pruning** (unbounded SD growth under weeks-offline).

## Design decision record (adjudicated across the three experts)

| # | Decision | Rationale (short) |
|---|---|---|
| DD1 | **Keep Node-RED as the edge runtime; strangler-extract, never rewrite.** | Pi 5 footprint is a non-issue; the liability is untested JS-in-JSON, not the runtime. A rewrite throws away field-proven logic for no farmer value. Unanimous. |
| DD2 | **Single-choke-point `osi-lib` loader with fail-visible quarantine** for all extracted modules (settings.js `functionGlobalContext` injection; load failure → typed error + `error_counts` + defined 503, never a dead node). Retires #99. **Precondition for every extraction.** | The bare-`require` brick is the failure that turns an improvement into a field outage. |
| DD3 | **Three CI ratchets** (baseline-file style, like the existing silent-catch/stray-DDL ratchets): per-node size ceiling (no node may grow; new ≤4 KB), total-embedded-JS scoreboard (may only decrease; measured baseline 1,064,794 func-chars/profile @ `5e04b8a2`, 2026-07-10; the earlier 1,017,468 and plan-write 1,039,554 figures predated current node growth), new-node-must-be-thin heuristic. | Converts extraction from aspiration into a merge gate — the highest-leverage, lowest-cost item in the program. |
| DD4 | **Extraction order: Daily Dendro Analytics → Zone Env Summary → History API Router; sync nodes only inside Option B.** "Done" per seam = pure module + co-located `node --test` green in CI + adapter <~2 KB + golden vectors captured **before** extraction + loads via DD2. For I/O-heavy seams (daily batch / HTTP-shaped), the adapter-size bar means zero inline compute/business logic remains; residual DDL + SQL + HTTP orchestration may exceed 2 KB. | Start where the harness is cheapest and blast radius smallest; prove the pattern twice before the HTTP-shaped monster. |
| DD5 | **Dendro duplication: contract, don't deduplicate.** Shared golden-vector fixtures in `docs/contracts/`; both repos run them in their own frameworks. `channels.json` becomes the single field-name truth consumed by both builds. | Edge (live, offline JS) and server (forecast Python) legitimately differ; one implementation couples release cadences and breaks offline-first. Divergence should be *detected*, not *prevented*. |
| DD6 | **Narrow-waist ingest:** pure `normalize(decoded, meta) → {channels}` per device + ONE manifest-driven writer with a **closed allow-list** (unknown channels → dead-letter/quarantine, never dropped, never auto-DDL) + `verify-device-integration.js` asserting the full codec→normalize→write round trip in CI. **MClimate T-Valve (#18) is the second consumer that justifies the abstraction — build it there first.** | The manifest is a new blast-radius surface; the allow-list + CI type-check against the real schema contains it. |
| DD7 | **Existing-device retrofit: shadow-parity evidence, not calendar time.** Generic writer runs in shadow on demos (old path writes; new path diffs). Cutover bar: ≥14 days or ≥500 live LSN50 uplinks/gateway, zero row diffs, zero dead-letters. Rest of fleet: convert-on-touch only; two writers coexisting is acceptable. | Measures actual payload variance instead of waiting a season; never risks live devices on an unproven abstraction. |
| DD8 | **No feature-flag framework.** Canary-gated per-gateway deploys ARE staging. One temporary UCI kill-switch for the LSN50 cutover, deleted after convergence. | Consumed-or-deleted, per the ownership ADR's invariant. |
| DD9 | **Destructive schema delivery = deploy-time runner** (Option B Stage 1): writers stopped, `PRAGMA integrity_check` preflight, byte-verified backup fsync'd before the first destructive statement, restore-on-failure actually invoked by the script, ledger-recorded. Never boot-time (crash-loop path + worst power-loss timing). | Reuses the tested `lib/osi-migrate`; the missing pieces are the gate lift + restore path + rehearsal. |
| DD10 | **Fleet updates: payload-level atomicity + canary cohorts; defer rootfs A/B OTA.** Staged dir → migrate copy → health-probe → symlink flip → auto-rollback on failed post-check. Canary gate consumes existing heartbeat fields (schema_sig, error_count, disk_free) server/operator-side. | The payload (flows + DB migration) is where the risk lives, not the rootfs. |
| DD11 | **osi-server: ArchUnit boundary test, not Spring Modulith / Gradle modules.** *Corrected by the 1.B3 spec's verification (2026-07-08):* the cyclic core is a **12-package SCC** (15 mutually-importing pairs; only `chameleon`/`channels`/`config` are cycle-free) and `sync` imports 13 `analytics` classes today, so the rule set is: no **new** cycle edges via ArchUnit `FreezingArchRule` + committed baseline store (the DD3 ratchet pattern), `analytics ↛ sync` (the direction that is actually true and matters for DD12), controllers-in-`*Controller`. Lock what exists; don't assert aspiration. | One deployable, 20 sane packages, one god-file — boundaries need enforcement, not restructuring. |
| DD12 | **Split `EdgeSyncService` into per-resource appliers** (`SyncEventApplier` keyed by op; orchestration loop stays thin), convert-on-touch starting with the next device's resource. | Mirrors the edge narrow waist: new device = one applier + one contract entry, testable alone. |
| DD13 | **`sync_dead_letter` table** (status/reason/payload/contract_version; separate from the hot inbox row) + per-event transaction boundary + batch-size cap + gateway-scoped rate limit. Runtime JSON-Schema validation at ingest → dead-letter on violation. | Closes #89 for real; the forensic surface for a slowly, unevenly upgrading fleet; defuses the poison-pill. |
| DD14 | **Contract generation: fixtures, not types.** Golden payloads per op validated against the JSON Schemas in both repos' CI. Java records only if map-parsing ever stops — and deleted the day they're unconsumed. | Honest under the ADR kill-switch; generated types would be dead code today. |
| DD15 | **Testcontainers Postgres 16 scoped to the sync/Flyway path** (single reused container); Mockito stays for logic. Flyway migrations get clean-migrate + migrate-from-prod-snapshot tests. | The untested surface is exactly the surface touching farm-mirror data. H2 ≠ Postgres. |
| DD16 | **Deploys: CI-built image → GHCR → `docker compose pull && up -d --no-deps backend`** with layered bootJar; the VPS never compiles again. | A safety change: builds move off the box that mirrors irreplaceable farm history. |
| DD17 | **Actuator safety invariant as CI:** every actuator command path must be duration-bounded at the device firmware (STREGA `OPEN_FOR_DURATION` model), asserted by extending `verify-command-safety.js`; entry gate for any new actuator (MClimate). | A valve stuck open during a Node-RED crash-loop is crop damage; the device firmware must be the failsafe. |
| DD18 | **Edge durability first-class:** `sync_outbox` delivered-row pruning + size cap with per-aggregate drop policy (telemetry may downsample; `irrigation_events` never drop); crash-loop escalation state in heartbeat; timestamp sanity + defined scheduler behavior on clock jumps. | These are the failure modes that lose a farm silently. |

## The phases

> Week numbers are indicative, not commitments. Tracks within a phase are parallel workstreams (different files, different failure domains). Items marked **spec+plan** get their own brainstorm → spec → plan cycle before any code.

### Phase 0 — Ship what's merged, gate what ships (weeks 1–2)

| Item | Repo | Size | Depends on | Mode |
|---|---|---|---|---|
| 0.1 Deploy merged flows (error counter, contract_version) to both demo gateways | osi-os live-ops | S | — | runbook |
| 0.2 Heartbeat canary gate: deploy tooling refuses to advance until target gateway reports N healthy heartbeats (schema_sig = target, error_count flat, disk_free OK) | osi-os tooling | M | heartbeat #100 (done) | spec+plan - done: `scripts/deploy-canary-gate.js` + runbook, PR #118; companion osi-server sync-health pass-through PR #57 |
| 0.3 **Option B Stage 0**: canonicalize fleet schema — fold `ensure_*`/repair drift into seed + ordered migrations, retire the `writable_schema` surgery (#93), establish the canonical reference such that replay == live-after-repair | osi-os | L | — | spec+plan (start from [`2026-07-05-option-b-boot-path-cutover.md`](../superpowers/plans/2026-07-05-option-b-boot-path-cutover.md)) |

### Phase 1 — Guardrails ∥ Delivery (weeks 2–6, two parallel tracks)

**Track A — extraction guardrails (osi-os):**

| Item | Size | Depends on | Mode |
|---|---|---|---|
| 1.A1 `osi-lib` single-choke-point loader + quarantine (DD2); migrate `osi-history-helper`'s bare require onto it — **kills #99** — done: osi-lib loader + quarantine, 3 nodes migrated, verify-helper-registration + bare-require ratchet, PR #117 | M | — | spec+plan |
| 1.A2 Ratchet trio (DD3): node-size ceiling, total-JS scoreboard, thin-node rule — done: `verify-flows-size-ratchet` (per-node ceiling + total scoreboard + thin-node heuristic), git-anchored, both profiles, PR #121 | S | — | direct |
| 1.A3 Backfill `node --test` for the existing `osi-history-helper` (pattern proof for DD4's "done") | M | 1.A1 | direct |
| 1.A4 Crash-loop escalation: distinct heartbeat health state + persistent local flag after N respawns | S | — | direct |
| 1.A5 `sync_outbox` retention/prune + size cap with per-aggregate drop policy (DD18) | M | — | spec+plan (drop policy is a data decision) |

**Track B — delivery capability + cloud hardening:**

| Item | Repo | Size | Depends on | Mode |
|---|---|---|---|---|
| 1.B1 **Option B Stage 1**: deploy-time runner invocation per DD9 (lift additive-only gate for ledger-driven migrations; restore-on-failure; rehearsed on gateway DB copies) | osi-os | L | 0.3 | spec+plan |
| 1.B2 Deliver migration 0004 to both demo gateways via 1.B1 + canary hold (0.2) | osi-os live-ops | M | 1.B1, 0.2 | runbook |
| 1.B3 osi-server CI (build + test + cross-repo op-parity) + ArchUnit boundary test (DD11) + Micrometer/actuator metrics endpoint + GHCR image publish + pull-only VPS deploy (DD16) | osi-server | M | — | spec+plan |
| 1.B4 Per-event tx boundary + `sync_dead_letter` + batch cap + rate limit (DD13), with a Testcontainers test reproducing the poison-batch replay (DD15) — **hard gate for Uganda** | osi-server | M | 1.B3 | spec+plan |

### Phase 2 — Uganda + prove the strangler on pure seams (weeks 6–10)

| Item | Repo | Size | Depends on | Mode |
|---|---|---|---|---|
| 2.1 Uganda catch-up (#87): full deploy + schema baseline, rehearsed on a Uganda DB copy first | osi-os live-ops | M | 1.B4 + 1.B1 proven on demos | runbook |
| 2.2 Extract Daily Dendrometer Analytics → tested module + thin adapter (DD4 "done" definition) — done: `osi-dendro-analytics` extracted (compute core), golden-vectored, scoreboard decreased, PR #125 | osi-os | M | 1.A1, 1.A2 | spec+plan |
| 2.3 Dendro cross-repo golden-vector contract (DD5) | both | M | 2.2 | spec+plan |
| 2.4 Extract Get Zone Environment Summary | osi-os | L | 2.2 pattern | spec+plan |
| 2.5 `channels.json` exported as shared field-name truth into the osi-server build (DD5) | both | S | 1.B3 | direct |

### Phase 3 — Narrow-waist ingest via the MClimate pilot (weeks 10–15)

| Item | Repo | Size | Depends on | Mode |
|---|---|---|---|---|
| 3.0 **Entry gate:** actuator duration-bound CI assertion (DD17, extend `verify-command-safety.js`) — merges before any MClimate downlink code | osi-os | S | — | direct |
| 3.1 MClimate T-Valve (#18): codec + normalizer + generic manifest-driven writer with closed allow-list & ingest dead-letter (DD6) — the abstraction's second consumer | osi-os | L | 1.A1 | spec+plan |
| 3.2 `verify-device-integration.js`: full round-trip CI gate (codec output → normalize → write → manifest-declared columns and nothing else) | osi-os | M | 3.1 | spec+plan |
| 3.3 LSN50 shadow mode on demo gateways (DD7: old path writes, new path diffs) | osi-os | M | 3.1 | direct |
| 3.4 Server-side: first `SyncEventApplier` extraction for the MClimate resource (DD12) | osi-server | M | 1.B3, 1.B4 | spec+plan |

### Phase 4 — Cutover + the hard node + boot-DDL removal (weeks 15–20)

| Item | Repo | Size | Depends on | Mode |
|---|---|---|---|---|
| 4.1 LSN50 writer cutover on the DD7 evidence bar, with temporary UCI kill-switch (DD8), demos → production | osi-os | M | 3.3 evidence | runbook + direct |
| 4.2 Extract History API Router → tested module (the HTTP-shaped seam, after the pattern is proven twice) | osi-os | L | 2.2, 2.4 | spec+plan |
| 4.3 **Option B Stage 2**: remove boot-node inline DDL — only after two clean fleet deliveries including Uganda, schema_sig converged fleet-wide for a sustained window | osi-os | M | 1.B1 ×2 proven, 2.1 | spec+plan |

### Phase 5 — Durability & scale hygiene (ongoing, interleave as capacity allows)

| Item | Repo | Size | Depends on | Mode |
|---|---|---|---|---|
| 5.1 SD durability: boot-time `PRAGMA quick_check` + quarantine/restore-from-local-backup path (couples with #56) | osi-os | M | — | spec+plan |
| 5.2 Chaos/soak rig: weeks-offline outbox replay, clock jump, power-loss-mid-migration (rehearsal gate for 4.3) | osi-os | M | — | spec+plan |
| 5.3 Staged atomic payload deploy + auto-rollback (DD10) | osi-os | M | 0.2 | spec+plan |
| 5.4 Postgres care: hot-path index audit, retention/partition-or-BRIN decision for `sensor_data`, autovacuum tuning, bootstrap jitter | osi-server | M | 1.B3 | spec+plan |
| 5.5 Incremental bootstrap snapshots (watermark-delta; full snapshot only on cursor gap) — defer until ~10+ gateways | osi-server | M | 5.4 | spec+plan |
| 5.6 Time integrity: timestamp sanity clamp + defined scheduler behavior on clock jumps (DD18) | osi-os | M | — | spec+plan |

## Risks & one-way doors

- **First destructive migration on the production farm (0004 → Uganda)** is irreversible except via restore. The backup+restore path must be *exercised on a real gateway DB copy* before it runs live — rehearsal is a gate, not a nicety.
- **Option B Stage 2 (boot-DDL removal)** — a gateway on the wrong schema becomes field-unrecoverable. Gate: two clean fleet deliveries + fleet-wide schema_sig convergence + power-loss-mid-migration rehearsed (5.2).
- **Uganda catch-up before the poison-pill fix** would convert a schema catch-up into a cloud outage (batch-wide rollback loop). Hard-gated on 1.B4.
- **Behavior-change-during-extraction is the classic killer, and AI agents make it more likely.** Playbook gate: every extraction PR is behavior-preserving, proven by golden vectors captured from the OLD node before extraction; behavior changes are separate later PRs.
- **Abstraction-before-second-consumer** on the generic writer: MClimate *is* the risk control. If the manifest can't express what an actuator needs, the abstraction is wrong — learn it there, not after retrofitting six devices.
- **Retrofitting live devices onto the writer** without the DD7 evidence bar — a manifest bug regresses all devices at once (worse blast radius than today's per-device builders).
- **Flyway migrations are one-way doors on production Postgres**: every migration gets clean-migrate + migrate-from-prod-snapshot tests in CI before touching `osicloud.ch`.
- **GHCR cutover**: rehearse pull-based deploy + rollback-to-previous-tag on the test server before removing the on-host build path.
- **Silent bricking / crash-loop invisibility**: DD2 quarantine and 1.A4 escalation exist precisely so a broken gateway cannot look alive.

## YAGNI (consolidated — do not build at this scale)

Full rootfs A/B OTA (payload atomicity covers the real risk; revisit at ~100 gateways) · plugin registry / dynamic device loading (ADR-locked) · shared SQLite↔Postgres DDL codegen (ADR-rejected) · MQTT cloud→edge commands (REST polling is the offline-correct choice) · Kafka/RabbitMQ/event bus (outbox+REST survives weeks offline; a broker doesn't) · Spring Modulith / multi-module Gradle (ArchUnit suffices) · full JSON-Schema→type codegen (fixtures only, per kill-switch) · unifying edge+server dendro implementations (contract instead) · full E2E test DB for the whole monolith (sync path only) · per-gateway config server / fleet console (UCI + heartbeat + canary covers 100) · Postgres HA/read replicas · event sourcing/CQRS ceremony · distributed tracing (one process) · sub-minute telemetry cadence (burns SD + VPS for nothing) · feature-flag framework (DD8).

## Where it breaks at scale (and the cheap durable fix)

| Scale | First break | Cheap fix that survives 100× |
|---|---|---|
| ~10× (30 gw) | Cloud, not edge: whole-batch tx + unbounded batches under backlog replay | 1.B4 (per-event tx, cap, dead-letter, rate limit) |
| ~10–30× | `sensor_data` growth, missing hot-path indexes, autovacuum stalls | 5.4 (index audit, retention, BRIN/partition decision made *before* 100) |
| ~30–100× | 6 h full bootstrap snapshots × N in lockstep (thundering herd) | jitter now; 5.5 incremental snapshots via existing watermarks |
| Any | VPS on-host builds next to farm-mirror data | 1.B3 (GHCR pull-only) |
| Edge | `sync_outbox` unbounded on SD under weeks offline | 1.A5 (retention + cap) |
| Edge fleet ops | Manual per-Pi ssh deploys past ~10 gateways | 0.2 + 5.3 (canary gate + staged atomic deploy) are the seed of fleet rollout |

Non-bottlenecks at any realistic scale: Pi 5 CPU/RAM, per-gateway SQLite throughput, LoRaWAN uplink rate. Don't spend there.

## Stop condition (the good-enough end state)

The program stops when: the flows.json total-JS scoreboard is ratcheting down and the four named seams (dendro, zone env, history router, sync-under-Option-B) are extracted and tested · adding a device is a CI-gated round trip (codec + normalizer + manifest row + card) · boot-node DDL is gone (Stage 2) · osi-server has CI with Testcontainers over the sync path and pull-only deploys · the fleet has a canary-gated, rehearsed delivery path for both additive and destructive schema. **Resist scaling ambition beyond this until a real second-party plugin or the ~10th gateway forces the next decision.**

## Program governance

- One item in flight per track; each `spec+plan` item runs the full playbook loop (brainstorm → spec → adversarial review → plan → worker execution → independent verification).
- Extraction PRs are behavior-preserving by mandate (golden vectors first); any improvement is a follow-up PR.
- Every phase ends with: verifiers green in CI, demo gateways healthy for a defined window, and this document's phase table updated with outcomes (date + PR links) so the map stays honest.
