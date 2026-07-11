# Worker Prompt — Refactor Program 2026 (Full Execution)

You are executing the OSI OS refactor program — a multi-phase modularity,
stability, and delivery-capability upgrade across two repos. Every item has a
reviewed spec + plan. Execute one item at a time in the order below. Each item
produces an unmerged PR; human review + merge is mandatory between items.

## System

- **osi-os** (edge): `/home/phil/Repos/osi-os` — OpenWrt firmware, Node-RED + SQLite
- **osi-server** (cloud): `/home/phil/Repos/osi-server` — Spring Boot + Postgres
- Primary target: Raspberry Pi 5 (`full_raspberrypi_bcm27xx_bcm2712`)

## Read first (program-level)

1. **AGENTS.md** — architecture, sync model, file locations, conventions
2. **`docs/engineering-playbook.md`** — the working loop: verify reality → plan → execute (TDD) → verify
3. **`docs/architecture/refactor-program-2026.md`** — program map, DD1–DD18, phases, YAGNI
4. **`docs/architecture/refactor-program-2026-open-decisions.md`** — all Fable review findings, the verified execution order, resolved decisions

## Hard rules (violation = STOP)

1. **NEVER touch a live gateway.** No SSH, no deploy, no production DB. Work in worktrees only.
2. **NEVER modify `sync-init-fn`** (frozen boot node) unless the item's spec explicitly names it as an in-scope sanctioned edit (only 3.1's `REQUIRED_TYPES` and 4.3's Stage 2 removal).
3. **NEVER overwrite `/data/db/farming.db`** on any device.
4. **Behavior-preserving extractions.** Golden vectors captured from OLD code prove the module is identical. A captured golden vector that reveals a latent bug is documented, not fixed (fix is a separate later PR).
5. **One item at a time.** Do not start item N+1 until item N's PR is merged. Do not batch items.
6. **Commit per task.** Each plan task gets its own commit. Never amend across task boundaries.
7. **Both profiles byte-identical** for every `conf/` file change. `verify-profile-parity.js` is the gate.
8. **Rebase before executing any line-anchored plan.** If the plan cites `deploy.sh:535`, run `grep -n '<anchor text>' deploy.sh` first. If the anchor moved, adjust in your working notes. If the anchor is GONE, STOP — another item merged a conflicting change.

## Skills to load

Load the relevant skill BEFORE touching the corresponding surface. Skills
contain mandatory procedures that override default behavior:

| Surface | Skill |
|---------|-------|
| Any `flows.json` edit | `osi-flows-json-editing` |
| Any edge SQLite schema/migration | `osi-schema-change-control` |
| Any sync/outbox/contract change | `osi-sync-contract-awareness` (when created) |
| Any UCI/env/flag change | `osi-config-and-flags` |
| Any `web/react-gui/` change | `osi-react-gui-patterns` (when created) |
| Any sensor/decoder question | `osi-agronomy-sensors-reference` |
| Bug-class request | `osi-debugging-playbook` |

## Verified execution order

Execute in this exact order. Each item's plan file has task-by-task instructions.

### Phase 0+1 — Foundation (execute sequentially, rebase between merges)

| Order | Item | Repo | Spec | Plan | Branch |
|-------|------|------|------|------|--------|
| **1** | **1.A1** osi-lib loader | osi-os | `specs/2026-07-07-osi-lib-loader-design.md` | `plans/2026-07-07-osi-lib-loader.md` | `feat/osi-lib-loader` |
| **2** | **0.2** Heartbeat canary gate | osi-os | `specs/2026-07-07-deploy-canary-gate-design.md` | `plans/2026-07-07-deploy-canary-gate.md` | `feat/deploy-canary-gate` |
| **3** | **0.3** Stage 0 canonicalization | osi-os | `specs/2026-07-07-option-b-stage0-canonicalization-design.md` | `plans/2026-07-07-option-b-stage0-canonicalization.md` | `feat/stage0-canonicalization` |
| **4** | **1.A2** Ratchet trio | osi-os | (inline in plan) | `plans/2026-07-08-ratchet-trio.md` | `feat/ratchet-trio` |
| **5** | **1.A5** Outbox retention + size cap | osi-os | `specs/2026-07-08-outbox-retention-size-cap-design.md` | `plans/2026-07-08-outbox-retention-size-cap.md` | `feat/outbox-retention` |
| **6** | **1.B3** osi-server CI + GHCR | osi-server | `specs/2026-07-07-osi-server-ci-ghcr-design.md` | `plans/2026-07-07-osi-server-ci-ghcr.md` | `feat/server-ci-ghcr` |
| **7** | **1.B4** Sync ingest hardening | osi-server | `specs/2026-07-07-sync-ingest-hardening-design.md` | `plans/2026-07-07-sync-ingest-hardening.md` | `feat/sync-ingest-hardening` |
| **8** | **1.B1** Deploy-time runner | osi-os | `specs/2026-07-08-option-b-stage1-deploy-runner-design.md` | `plans/2026-07-08-option-b-stage1-deploy-runner.md` | `feat/88-stage1-deploy-runner` |
| **9** | **5.3** Staged atomic deploy | osi-os | `specs/2026-07-08-staged-atomic-deploy-design.md` | `plans/2026-07-08-staged-atomic-deploy.md` | `feat/53-staged-atomic-deploy` |

**After order 3 merges:** per-gateway deploy windows become possible.
Operator runs `repair-sync-outbox-v2.js` → deploy 0.1 → baseline → (later) Stage 1.

**Items 6+7 (osi-server) can run in parallel with items 4+5 (osi-os)** — different repos, no shared state. But 7 depends on 6 for CI.

### OPERATOR GATE — live deploy window

After items 1–9 are merged:
- **0.1** Deploy merged flows to demo gateways (operator runbook, not a code item)
- **1.B2** Deliver migration 0004 to demos via Stage 1 + canary hold (operator runbook)

These are operator-executed, not worker-executed. STOP here and report readiness.

### Phase 2 — Extractions (after demos are healthy)

| Order | Item | Repo | Spec | Plan | Branch |
|-------|------|------|------|------|--------|
| **10** | **2.2** Extract Daily Dendro Analytics | osi-os | `specs/2026-07-08-extract-daily-dendro-analytics-design.md` | `plans/2026-07-08-extract-daily-dendro-analytics.md` | `feat/extract-dendro-analytics` |
| **11** | **2.3** Dendro cross-repo contract | both | `specs/2026-07-08-dendro-cross-repo-golden-vector-contract-design.md` | `plans/2026-07-08-dendro-cross-repo-golden-vector-contract.md` | `feat/dendro-contract` |
| **12** | **2.4** Extract Zone Env Summary | osi-os | `specs/2026-07-08-extract-zone-env-summary-design.md` | `plans/2026-07-08-extract-zone-env-summary.md` | `feat/extract-zone-env` |

### OPERATOR GATE — Uganda catch-up

After items 10–12 are merged AND 1.B4 is deployed to the cloud:
- **2.1** Uganda catch-up + baseline (operator runbook: `docs/operations/uganda-catchup-runbook.md`)

### Phase 3 — Narrow-waist ingest (after UC512 datasheet is available)

| Order | Item | Repo | Spec | Plan | Branch |
|-------|------|------|------|------|--------|
| **13** | **3.0** Actuator safety gate | osi-os | (inline in plan) | `plans/2026-07-08-actuator-safety-gate.md` | `feat/actuator-safety-gate` |
| **14** | **3.1** UC512 narrow-waist writer | osi-os | `specs/2026-07-08-mclimate-narrow-waist-design.md` (NEEDS REWRITE for UC512) | `plans/2026-07-08-mclimate-narrow-waist.md` (NEEDS REWRITE) | `feat/uc512-narrow-waist` |
| **15** | **3.4** Server-side applier split | osi-server | `specs/2026-07-08-edge-sync-applier-split-design.md` | `plans/2026-07-08-edge-sync-applier-split.md` | `feat/sync-applier-split` |

**3.1 spec is currently MClimate-shaped.** ~80% architecture is reusable; ~20% needs rewriting for UC512 (codec, normalizer, ChirpStack profile, type_id). The **two-channel valve model** is a critical design delta — see the UC512 rewrite note in the spec header.

### Phase 4 — Cutover + hard node (heavily gated)

| Order | Item | Repo | Spec | Plan |
|-------|------|------|------|------|
| **16** | **4.2** Extract History API Router | osi-os | `specs/2026-07-08-extract-history-api-router-design.md` | `plans/2026-07-08-extract-history-api-router.md` |
| **17** | **5.2** Chaos/soak rig | osi-os | `specs/2026-07-08-chaos-soak-rig-design.md` | `plans/2026-07-08-chaos-soak-rig.md` |
| **18** | **4.3** Stage 2 boot-DDL removal | osi-os | `specs/2026-07-08-option-b-stage2-boot-ddl-removal-design.md` | `plans/2026-07-08-option-b-stage2-boot-ddl-removal.md` |

**4.3 is the most heavily gated item.** Do NOT execute until:
- Two clean fleet deliveries including Uganda
- Fleet-wide `schema_sig` convergence for a sustained window
- 5.2's kill-9 matrix with ≥1 mid-apply hit + destructive migration exercised

### Phase 5 — Durability (interleave as capacity allows)

| Order | Item | Repo | Spec | Plan |
|-------|------|------|------|------|
| any | **5.1** SD durability integrity check | osi-os | `specs/2026-07-08-sd-durability-integrity-check-design.md` | `plans/2026-07-08-sd-durability-integrity-check.md` |
| any | **5.6** Time integrity | osi-os | `specs/2026-07-08-time-integrity-design.md` | `plans/2026-07-08-time-integrity.md` |

**5.6 requires a ratchet growth allowance** (see §Executor notes below).

## Per-item execution protocol

For EACH item in order:

```
1. Read the spec (full). Read the plan (full). Read AGENTS.md.
2. Load the relevant skills (see table above).
3. Create the feature branch from current main:
   git checkout main && git pull --ff-only
   git checkout -b <branch-name>
4. If the plan cites line numbers, verify them:
   grep -n '<anchor text>' <file>
   If shifted, note the new line numbers. If gone, STOP.
5. Execute tasks in plan order. For each task:
   a. Write the failing test first (TDD where the plan says so)
   b. Implement
   c. Run the task's verification command
   d. Commit with the plan's suggested commit message
6. After all tasks: run the plan's full verification checklist.
7. Push and open a draft PR. Do NOT merge.
8. Report completion with: branch name, PR URL, verification output.
```

## Executor attention notes (from Fable reviews)

These are findings "noted for executor" — things the plan doesn't fully spell
out that you must handle during execution:

### Item 0.2 (canary gate)
- `--expect-schema-sig` override: when the reported sig matches the expected
  one, suppress `schema_sig_not_accepted` as a verdict reason.
- Error-delta baseline: re-capture on each failed-poll reset (judge "still
  rising" not "ever rose").

### Item 0.3 (Stage 0)
- Comparator must include `PRAGMA foreign_key_list` (FK comparison).
- `repair-sync-outbox-v2.js` is a pre-step of EACH 0.1 per-gateway deploy.

### Item 1.A2 (ratchet trio)
- The plan includes a **growth-allowance mechanism** (`allowances.json`). This
  is load-bearing — without it, items 3.1 and 5.6 are unlandable.
- DD3 scoreboard baseline is stale (1,017,468 → 1,039,554 as of plan-write;
  re-measure from current main at execution time).

### Item 1.A5 (outbox retention)
- **Batch the eviction DELETE** in a LIMIT 1000 loop — a single DELETE of
  10K+ rows holds the write lock beyond `busy_timeout=5000`, dropping
  concurrent sensor INSERTs.
- Add `idx_sync_outbox_eviction` index.

### Item 1.B1 (deploy runner)
- Backup dir is `/data/backups/migrate` (persistent), NOT `$TMP_DIR` (tmpfs).
- Trap must CHAIN with deploy.sh's cleanup trap, not replace it.
- The rc=3 path must restore the old cleanup trap, not cancel all traps.

### Item 1.B3 (server CI)
- Flyway rollback caveat: if the deploy included Flyway migrations, rollback
  requires PG dump restore, not just image repoint.
- ArchUnit `FreezingArchRule` determinism: run twice and verify the store
  doesn't churn on intra-SCC dependency shuffling.

### Item 1.B4 (sync hardening)
- FK-violation classifier: SQLState **23503 → RETRYABLE** (not permanent).
  23505/23502/23514 → permanent `integrity_violation`.
- In-method `IllegalArgumentException("Zone not found")` → distinguish
  `parent_missing` (RETRYABLE) from `malformed_payload` (permanent).
- Add a test variant: parent transient at k, dependent child at k+1, assert
  child is RETRYABLE and applies on the next cycle.

### Item 5.3 (staged deploy)
- The symlink flip happens in the POST-MIGRATE block, NOT at :535. Stage-only
  at :535; flip after successful migration.
- The probe is a LOCAL self-check (Node-RED alive + /gui reachable), NOT the
  cloud admin gate. The operator runs 0.2's gate from their workstation.

### Item 2.3 (dendro contract)
- Fixture constraints: stepwise-only, integer µm inputs, all-eligible, no
  growth cap (`maxGrowthUmPerDay: null`).
- Plan Task 1.1 must use the spec's `DailyPoint` shape, NOT 2.2's E2E shape.

### Item 2.4 (zone env extraction)
- Add three module-level constants to the mover list: `LOCAL_METRICS`,
  `DEVICE_ONLY_METRICS`, `KC_BY_STAGE`. Without them → `ReferenceError`.

### Item 3.1 (narrow-waist — when UC512 spec is ready)
- UC512 is a two-channel valve controller. Per-channel command addressing
  must be designed.
- `channels.json` has zero valve channels today — UC512 adds the first.
- Confirm device-side auto-close from Milesight datasheet before downlink code.

### Item 4.3 (Stage 2 — when gates pass)
- Request-path DDL is **10 CREATEs across 5 nodes**, not 2. Sub-step 2a must
  cover all 10.
- Plan Step 0.2 expects `devices_new: 7`; live count is 5. Re-verify.

### Item 5.2 (chaos rig)
- ≥1 mid-apply SIGKILL observation is a HARD pass criterion.
- Fixture MUST include a destructive-class (0004-shaped) migration.
- Scenario 2 asserts only behaviors 5.6 actually builds.

### Item 5.6 (time integrity)
- Requires a ratchet growth allowance in `allowances.json` (item 1.A2).
- Timestamp clamp covers only one node — audit all `recorded_at` derivation
  paths in the other per-device sql-fns.

## Reporting

After each item, report:
- Branch name and PR URL
- Full verification output (paste real commands + output, not summaries)
- Any findings or deviations from the plan
- Whether the next item's dependencies are met

Do NOT claim completion without running every verification command in the
plan's checklist and pasting the output.
