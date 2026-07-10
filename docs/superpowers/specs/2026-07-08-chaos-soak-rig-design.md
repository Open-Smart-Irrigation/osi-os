# Chaos / soak rig — local rehearsal harness (Stage 2 gate)

**Status:** Draft
**Refactor-program item:** 5.2 (the "rehearsal gate for 4.3 / Option B Stage 2"; the kill-9-mid-migration scenario is the named power-loss rehearsal that gates boot-DDL removal). Feeds the Risks-and-one-way-doors "power-loss-mid-migration rehearsed (5.2)" gate.
**Focus: osi-os edge.** Local rig only — no live gateways, no SSH, no cloud writes to production. May exercise a real server via Testcontainers / the 1.B4 harness for the outbox-replay scenario.
**Depends on:** the `rehearse-devices-rebuild.js` run-real-function-text pattern (the precedent) and `lib/osi-migrate`'s runner/backup/atomicity machinery (consumed, not modified).

## Problem

Option B Stage 2 (4.3 — remove the boot-node inline DDL) is a one-way door: a gateway that ends up on the wrong schema after boot-DDL removal is **field-unrecoverable**. The program map gates it on "two clean fleet deliveries + fleet-wide schema_sig convergence + **power-loss-mid-migration rehearsed (5.2)**." That rehearsal does not exist. More broadly, the failure modes that silently lose a farm — weeks-offline outbox replay, a clock jump, a kill-9 in the middle of a migration, an SD card filling up — have never been exercised against the real edge code in a controlled harness. They are discovered in the field, on a farm, which is the worst place.

There is a proven local-rehearsal pattern to build on: `scripts/rehearse-devices-rebuild.js` reads the **real `sync-init-fn` function text from flows.json** and runs it against a **real `node:sqlite` engine** through a facade shim that mirrors the `osi-db-helper` API the func expects. This is "run the actual edge code, not a re-implementation, against a real SQLite DB." 5.2 generalizes that into a chaos/soak rig covering the four failure scenarios, whose outputs become the rehearsal-evidence artifacts the runbooks cite.

## Verified ground truth

1. **The run-real-function-text precedent exists and works** (`scripts/rehearse-devices-rebuild.js`, verified): `funcText()` = `JSON.parse(flows).find(n => n.id === 'sync-init-fn').func`; `makeFacadeShim(dbPath)` wraps `node:sqlite`'s `DatabaseSync` with `run/all/get/exec` (promise + node-callback), `transaction` (BEGIN IMMEDIATE/COMMIT/ROLLBACK), `close` — the exact `osi-db-helper` surface. This is the rig's foundation: any flows function node can be executed this way against a real DB.
2. **The migration engine has a kill-9/power-loss test precedent** (`lib/osi-migrate/__tests__/runner-atomicity.test.js`, verified): it proves that a post-commit postflight failure marks `repair_required` (schema + ledger row commit together; `foreign_key_check` catches the violation after), and a pre-commit failure records `status='failed'` and is retryable. This is the atomicity contract the kill-9 scenario stresses — the rig extends it from "postflight fails" to "process is killed mid-apply."
3. **`lib/osi-migrate/backup.js`** provides the byte-verified `.backup` + `integrity_check` + keep-5 rotation the kill-9 scenario needs (migrate a COPY, kill mid-apply, assert the backup + ledger let it recover) — the same machinery DD9/Stage 1 and 5.1 use.
4. **The outbox drain contract is verified** (from the 1.B4 spec's edge-side facts): `sync_outbox` drains at `LIMIT 100` every 30 s; delivered rows set `delivered_at`, rejected set `rejected_at`+`rejection_reason`, retryable writes nothing (re-selected next tick). A weeks-offline backlog is a large `delivered_at IS NULL` set — the outbox-replay scenario synthesizes exactly this.
5. **Node is on the image and in CI** (`node --test` runs in `migrations.yml`); `node:sqlite` (`DatabaseSync`) is the real engine `rehearse-devices-rebuild.js` already uses in CI. So the rig is CI-runnable for the deterministic scenarios; the genuinely-destructive ones (kill-9, SD-full) run as local operator rehearsals with captured artifacts.

## Design

### A. Rig shape — local, real-code, artifact-producing

A rig under `scripts/` (e.g. `scripts/chaos-rig/` or `scripts/chaos-soak-rig.js` + per-scenario modules) that:
- **Runs real edge code, not re-implementations** — the `rehearse-devices-rebuild.js` facade-shim pattern for any flows function node it needs (outbox drain builder, scheduler decision, boot node), and the real `lib/osi-migrate` runner for migration scenarios.
- **Operates only on synthetic or copied DBs** in a scratch dir — never a live file (the 5.1/Stage-1 invariant). Where a scenario needs "a real gateway shape," it seeds from `seed-blank.sql` / `reference(N)` (the Stage 0 machinery) or a supplied read-only fixture COPY, and asserts the source fixture's hash is unchanged after.
- **Emits a machine-readable evidence artifact per run** (JSON: scenario, inputs, pass/fail, row-count invariants, timings) — these artifacts are what the Stage-1/Stage-2 runbooks and 5.1/5.3 cite as "rehearsed." The rig's outputs are the gate's evidence, not just console noise.
- **Is feasible from the repo's existing tooling** (pre-ruled: "verify what's feasible"): plain-process Node + `node:sqlite` + `sqlite3` CLI on the dev machine — no Docker/QEMU required for the edge-only scenarios; the outbox-replay-into-real-server scenario uses the 1.B4 Testcontainers harness (Docker) or the 1.B4 slice, since that's where a real Postgres already stands up.

### B. Scenario 1 — weeks-offline outbox replay (synthetic backlog → real server)

- **Synthesize a weeks-offline backlog:** seed `sync_outbox` with a large `delivered_at IS NULL` set (thousands to low-tens-of-thousands of rows across resources, mirroring a stale gateway — the Uganda-shaped #87 case), including a small **poison mix** (malformed/constraint-violating rows, 1-in-500 per the 1.B4 backlog-drain test).
- **Drive the real drain:** run the actual `Build Edge Event Batch` / drain query (`LIMIT 100`, the verified batching) against the synthetic outbox, POSTing to a **real server** (the 1.B4 Testcontainers Postgres + `applyEventsV2`, or the 1.B4 harness) — proving the edge→server replay end-to-end under backlog.
- **Assert:** the backlog drains to zero `delivered_at IS NULL` (minus terminally-rejected rows); no poison event wedges the batch (this is the 1.B4 per-event-tx property, exercised from the edge side); reconciliation of applied+rejected+retryable+duplicate = input; wall-clock stays within a sane bound ("hours not days" pacing, the 1.B4 arithmetic). This is the edge-side companion to 1.B4's server-side backlog-drain test — same scenario, driven through the real outbox drain.

### C. Scenario 2 — clock jump

- **Inject a forward and a backward wall-clock jump** into the rig's time source (an injectable `now`, mirroring how the scheduler and freshness checks read `Date.now()`), then run the real scheduler decision node and the real outbox freshness logic.
- **Assert the 5.6 contract** (this rig is where 5.6's scheduler behavior is *proven*, not just specified): a forward jump does NOT auto-fire missed irrigation windows (farmer safety); a backward jump does not double-fire (the `last_triggered_at` guard 5.6 introduces); timestamp-sanity clamps reject implausible times. 5.2 and 5.6 couple here — 5.6 defines the behavior, 5.2's clock-jump scenario is its regression rehearsal.

### D. Scenario 3 — kill-9 mid-migration on a DB copy (the Stage 2 gate)

- **The headline scenario.** Take a COPY of a seeded/fixture DB, begin a real `lib/osi-migrate` `applyPending` of a destructive-class migration (0004-shaped — the CHECK-widening rebuild), and **kill the process (SIGKILL) at controlled points**: before the backup completes, after backup but mid-DDL, after DDL commit but before the ledger row, after the ledger row but before postflight. For each kill point, re-run `applyPending` on the killed DB and assert recovery:
  - the byte-verified backup exists and passes `integrity_check` (DD9);
  - the ledger is in a consistent state (`applied` / `failed` / `repair_required` per `runner-atomicity.test.js`'s contract), never a half-applied schema with an `applied` ledger row;
  - re-run either completes the migration or halts on `repair_required` (never silently retries non-idempotent DDL — the exact bug `runner-atomicity.test.js` guards);
  - restore-from-backup yields a DB that passes `integrity_check` and `verifyHead`.
- **This is the power-loss-mid-migration rehearsal the program gates Stage 2 on.** Its artifact (kill-point matrix × recovery outcome) is cited directly by 4.3's entry gate. Kill-9 is a genuine SIGKILL of a child process (real, not simulated) — run as a local operator rehearsal with the captured matrix as evidence; the deterministic subset (postflight-fail, rolled-back-fail) is already in `runner-atomicity.test.js` and stays in CI.

**Strengthened pass criteria (Fable review HIGH 2026-07-10):**
1. **≥1 `drift_halt` or mid-apply observation is a HARD pass requirement.** A matrix where every SIGKILL landed pre-start or post-finish is a vacuous green — it didn't test the dangerous window. The evidence artifact must record which kill points hit the mid-apply window (between backup-complete and ledger-written), and at least one must have been exercised. If the timing-based kill consistently misses this window, widen the delay range or add a deterministic injection point (a test hook in the runner that pauses after the DDL COMMIT but before the ledger write — the exact window `runner-atomicity.test.js` already models).
2. **The fixture MUST include a destructive-class (0004-shaped) migration with backup**, not just trivial additive migrations. The backup-under-kill path — the thing power loss actually threatens — is the point of the rehearsal. A kill-9 during a trivial `ADD COLUMN IF NOT EXISTS` exercises none of the destructive-class recovery logic (table rebuild, FK fence, the `repair_required` ↔ `backup_path` interplay). Use the real `0004__widen_schedule_trigger_metric_check.sql` or a synthetic destructive migration of equivalent complexity.
3. **Scenario 2 (clock jump) must assert behavior that 5.6 actually builds.** The current spec asserts a `clock_jump_forward` event that 5.6's plan does not emit — either 5.6 must add the forward-jump flag, or Scenario 2 must assert only the behaviors 5.6 actually implements (the backward-jump `last_triggered_at` guard and the timestamp clamp).

### E. Scenario 4 — SD-full simulation

- **Simulate a full SD** (write into a size-capped tmpfs/loopback mount, or a scratch dir on a constrained filesystem, so `ENOSPC` fires on real writes) and run: a migration `applyPending` (does the backup fail-closed? does a failed backup correctly abort the migration per DD9 rather than proceeding?), an outbox insert (does the writer degrade gracefully?), and the 5.1 integrity-check backup (does the opportunistic backup handle `ENOSPC` without corrupting the pool?).
- **Assert:** no scenario corrupts the DB or the backup pool under `ENOSPC`; the migration refuses to proceed without a good backup (DD9 fail-closed); errors surface (not silently swallowed). Couples with 1.A5 (`sync_outbox` retention/cap — the drop policy that prevents SD-full from outbox growth in the first place) and 5.1 (backup under `ENOSPC`).

### F. Evidence artifacts + runbook citation

- Each scenario emits a timestamped JSON artifact (under a rig-outputs dir, gitignored or committed as sample evidence — decide at implementation; committed samples double as fixtures). The artifact schema: `{scenario, timestamp, inputs, invariants: {rowCountsBefore/After, ...}, outcome: 'pass'|'fail', timingsMs, notes}`.
- **Runbooks cite these** (pre-ruled: "rig outputs are rehearsal evidence artifacts the runbooks cite"): the Stage 1 runbook (1.B1/1.B2) cites the kill-9 + SD-full artifacts as "backup/restore rehearsed"; the Stage 2 gate (4.3) cites the kill-9 kill-point matrix; #87's Uganda catch-up cites the outbox-replay artifact; 5.6 cites the clock-jump artifact.

### G. CI vs operator split

Mirroring the `rehearse-devices-rebuild.test.js` CI-automated vs production-copy-rehearsal split (per `osi-schema-change-control`):
- **CI (`node --test`, deterministic):** outbox-replay against Testcontainers/harness, clock-jump (injectable `now`, fully deterministic), the SD-full subset that can be forced via a size-capped scratch mount in CI, and the deterministic kill-recovery cases already in `runner-atomicity.test.js`.
- **Operator rehearsal (local, artifact-capturing):** the genuine SIGKILL kill-point matrix (a real process kill is awkward-but-doable in CI; keep the full matrix as an operator rehearsal with committed artifacts, run the 2–3 most load-bearing kill points in CI if feasible), and any scenario needing a real constrained filesystem. Same split the repo already uses for rebuild rehearsals.

## Non-goals

- **No live gateways, no SSH, no production cloud writes.** Testcontainers/local only.
- **No QEMU/full-image boot** unless the repo already has it (verify: it does not today) — plain-process Node + `node:sqlite` + `sqlite3` is the feasible tooling; a full-image rig is over-engineering for these scenarios.
- **Not a load/perf benchmark** — the timings are sanity bounds ("hours not days," "under 60 s for 10k"), not SLAs.
- **Does not modify `lib/osi-migrate`, the boot node, or any flows** — it *runs* them as-is (the whole point is real code).
- **Does not implement 5.6's scheduler behavior** — Scenario 2 *rehearses* it; 5.6 *builds* it. The rig is the regression net.
- **Does not fix 1.A5's outbox retention** — Scenario 4 *exercises* the SD-full failure mode 1.A5 addresses.

## Definition of Done

- A local rig (`scripts/chaos-rig/` or equivalent) running the four scenarios against real edge code (the `rehearse-devices-rebuild.js` facade-shim pattern) + the real `lib/osi-migrate` runner, on synthetic/copied DBs only.
- Scenario 1 (outbox replay): synthetic weeks-offline backlog + poison mix drained through the real drain query into a real server (1.B4 Testcontainers/harness); reconciliation + no-wedge + pacing asserted.
- Scenario 2 (clock jump): forward (no missed-window auto-fire) + backward (no double-fire) via injectable time, running the real scheduler node — the regression net for 5.6.
- Scenario 3 (kill-9 mid-migration): SIGKILL kill-point matrix on DB copies; each point's recovery (backup passes `integrity_check`, ledger consistent, re-run completes-or-halts-on-`repair_required`, restore yields `verifyHead` ok) — the Stage 2 power-loss rehearsal artifact.
- Scenario 4 (SD-full): `ENOSPC` forced; migration fail-closed (no good backup → refuse), no pool/DB corruption, errors surfaced.
- Per-scenario JSON evidence artifacts; the CI-vs-operator split wired (deterministic scenarios in `migrations.yml` `node --test`; the genuine-SIGKILL matrix + constrained-FS cases as operator rehearsals with committed artifacts).
- Runbook-citation note: which artifact gates which downstream item (Stage 1, Stage 2/4.3, #87, 5.6).
- No live/SSH/production; no modification of the code it exercises.
- "Open decisions" shows none outstanding.

## Open decisions

None outstanding.

- Rig tooling: **plain-process Node + `node:sqlite` + `sqlite3` CLI (edge scenarios) + the 1.B4 Testcontainers harness (outbox→server)**, decided in §A/§B — feasible from existing repo tooling, no Docker/QEMU for edge-only scenarios; verified the run-real-function-text precedent exists.
- Real code, not re-implementations: **the `rehearse-devices-rebuild.js` facade-shim over `node:sqlite` + the real `lib/osi-migrate` runner**, decided in §A — the whole value is exercising the actual edge code.
- Kill-9 realism: **genuine SIGKILL of a child mid-`applyPending`, kill-point matrix on DB copies**, decided in §D — the deterministic recovery subset is already in `runner-atomicity.test.js`; the full matrix is the operator-rehearsal artifact 4.3 cites.
- CI vs operator split: **deterministic scenarios in CI `node --test`; genuine-SIGKILL matrix + constrained-FS as operator rehearsals with committed artifacts**, decided in §G — mirrors the existing rebuild-rehearsal split.
- Coupling: **Scenario 2 is 5.6's regression net; Scenario 4 exercises 1.A5's failure mode; Scenario 3 is 4.3's Stage 2 gate; Scenario 1 is #87's edge-side companion to 1.B4** — decided across §B–§E; the rig proves, it does not build, those items.
