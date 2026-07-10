# Refactor Execution Engine — Automated Build-Review-Deploy-Verify Pipeline

**Status:** Draft
**Date:** 2026-07-10
**Scope:** The orchestration system that executes the refactor program's 18 items
fully unattended, with automated verification gates and a kill switch. Produces
tagged checkpoints; the AgroLink deployment forks from whichever checkpoint has
soaked long enough.

## Problem

The refactor program has 18 items across 5 phases, all specced and Fable-reviewed.
A worker has already executed 8 items producing PRs. But the execution model —
human-directed, one item at a time, manual review between each — is too slow for
the timeline: AgroLink installs at Agroscope Reckenholz next week, and the refactor
IS the path to a stable AgroLink base.

The execution needs to be fully automated: build, review, fix, merge, deploy,
verify — no human direction required. A failed verification halts the pipeline and
pages the operator. The operator only intervenes on red.

## Decisions (from brainstorm)

1. **Hybrid branch model.** Short-lived bundle branches (days, not months) that
   merge to main after kaba100 verification passes. Tagged checkpoints
   (`agrolink-checkpoint-N`) after each green bundle. No long-lived divergent
   branch — flows.json merge conflicts make that untenable.
2. **Fully unattended with kill switch.** Everything automated including deploys.
   A failed verification halts the pipeline and pages the operator. Zero
   interactions if everything is green.
3. **Aggressive AgroLink scope.** Whatever passes the 7-day soak bar by install
   time ships as the AgroLink base. Could include Phase 2 extractions if they're
   green by then.

## Architecture

```
main (production baseline, tagged checkpoints)
  |
  +-- bundle/phase0-tooling (short-lived, days)
  |     Codex worker builds items → PRs to this branch
  |     Automated review: Codex + Fable + CodeRabbit
  |     Codex fixes until green → auto-merge to bundle branch
  |     Deploy bundle branch to kaba100
  |     Automated verification protocol
  |     Green → merge to main, tag agrolink-checkpoint-N, delete branch
  |     Red → halt, page operator, do NOT merge
  |
  +-- bundle/phase1-delivery (next short-lived branch from new main)
  |     ...same cycle...
  |
  +-- AgroLink forks from the checkpoint that passed the 7-day soak
```

**Silvan stays on the last known-good checkpoint as a control gateway.**
Only kaba100 runs the moving line. If kaba100 breaks, Silvan proves the
last checkpoint was good. Uganda is untouched until item 2.1's explicit window.

## Bundle structure (tiered by blast radius)

| Bundle                  | Items                             | Deploy?              | Soak     | Gate                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0: Canary gate**     | 0.2                               | Yes (solo)           | 24h      | Pre-deploy: run `repair-sync-outbox-v2.js` on kaba100 (Fable CRITICAL — current main's sync drain queries columns kaba100 lacks). First use of the gate itself.                                                                                   |
| **B1: Schema tooling**  | 0.3                               | Yes (solo)           | 48h      | Schema baseline on kaba100 copy                                                                                                                                                                                                                   |
| **B2: CI guardrails**   | 1.A2, 1.A3                        | No                   | CI-only  | Ratchets green. (1.A4 moved to B3 — it's runtime edge code, not CI-only.)                                                                                                                                                                         |
| **B3: Edge durability** | 1.A4, 1.A5                        | Yes                  | 24h      | Crash-loop heartbeat state (1.A4) + outbox prune runs without dropped readings (1.A5)                                                                                                                                                             |
| **B4: Deploy rewrite**  | 1.B1                              | Yes (solo)           | 48h      | Full deploy+migrate cycle on kaba100                                                                                                                                                                                                              |
| **B5: Staged deploy**   | 5.3                               | Yes (solo)           | 48h      | Symlink swap + rollback exercised                                                                                                                                                                                                                 |
| **B6: Server CI**       | 1.B3                              | Server-only          | CI green | No Pi deploy                                                                                                                                                                                                                                      |
| **B7: Sync hardening**  | 1.B4                              | **TEST SERVER ONLY** | 48h      | Poison-batch test on real sync. **NEVER auto-deploy to osicloud.ch** — kaba100 syncs to production; auto-deploying 1.B4 there violates the production gate. Deploy to `server.opensmartirrigation.org` only. Production deploy is operator-gated. |
| **B8: Extraction 1**    | 2.2                               | Yes                  | 24h      | Golden vectors match, scoreboard drops                                                                                                                                                                                                            |
| **B9: Contract**        | 2.3                               | Both repos           | CI       | Cross-repo fixture parity                                                                                                                                                                                                                         |
| **B10: Extraction 2**   | 2.4                               | Yes                  | 24h      | Same pattern as B8                                                                                                                                                                                                                                |
| **BA: Agroscope**       | Agroscope MQTT forward + branding | Yes                  | 24h      | AgroLink-specific: the forward to Agroscope IoT broker + theming. Must be in the AgroLink checkpoint. Bundle separately from the refactor items — different blast radius.                                                                         |

B4 and B5 are never bundled together — both touch the deploy path, and a
failure would be unattributable.

## Automated verification protocol (per deploy bundle)

### Pre-deploy

```
1. BACKUP:  Stop Node-RED on kaba100 FIRST, then sqlite3 .backup farming.db
            to /data/backups/pre-deploy-<timestamp>.db ON THE PI (not over
            the tunnel — a network drop mid-copy = torn backup).
            PRAGMA integrity_check the backup copy. Only proceed if ok.
            Record: DB size, row counts for device_data/irrigation_schedules.
            Restart Node-RED after backup.
            (Fable review: file-copy of a live WAL DB is unsafe; .backup is
            the only consistent method.)
2. RECORD:  GUI bundle hash, heartbeat baseline, error_count,
            sync_outbox pending count, schema_sig
3. CONTROL: Record Silvan's current state as the control baseline
```

### Deploy

```
4. Build GUI: npm run build in web/react-gui/
5. Package: tar czf react_gui.tar.gz -C web/react-gui/build .
6. Deploy via the standard reverse-tunnel flow:
   ssh -R 9876:localhost:9876 root@kaba100 'curl -fsS http://localhost:9876/deploy.sh | sh'
7. Wait for Node-RED restart (poll :1880/gui for 301, timeout 120s)
```

### Post-deploy verification (the kill-switch triggers)

```
 8. BOOT:    Node-RED process alive, :1880/gui → 301
 9. ROUTES:  Sweep ALL REST endpoints including any extracted-module endpoints
             (the all-routes-404 failure mode is known):
             /api/zones, /api/devices, /api/system/features, /api/catalog,
             /api/history/*, /export.csv
             Each must return 200 or 401 (auth-gated = healthy), never 404/500.
             After extraction bundles (B8/B10): also check the osiLib quarantine
             — a 503 from an extracted endpoint means the module failed to load.
10. SCHEMA:  schema_sig matches target (derived from the bundle's migration head)
11. INGEST:  Wait for a real uplink (poll device_data for a row with
             recorded_at > deploy_time, timeout 15min — one uplink interval).
             ALSO: compare the new row's non-null column set against pre-deploy
             rows for the same device — a broken normalizer writing all-nulls
             passes the "row exists" check but fails the "values are correct" check.
12. SYNC:    sync_outbox pending count not growing (3 consecutive 30s polls).
             ALSO: check cloud-side receipt — query the test server's sync-health
             endpoint for this gateway's last-applied event timestamp; it must
             advance post-deploy (proves the server actually applied events,
             not just that the edge queued them).
             If 0.2 is deployed: run deploy-canary-gate.js --expect-schema-sig <sig>
13. GUI:     Headless browser (Playwright): login → dashboard renders →
             24h history chart has data → export.csv returns 200 with auth
14. DB:      farming.db size >= pre-deploy size (no data loss)
             PRAGMA integrity_check = ok
             PRAGMA foreign_key_check = zero rows
             device_data row count >= pre-deploy count (monotone)
15. ERRORS:  error_count delta ≤ 0 over 5-minute observation window
16. CANARY:  If 0.2 deployed: N=5 consecutive healthy heartbeats via the gate
17. DAILY:   After extraction bundles (B8/B10): if the daily analytics job
             (dendro-compute-fn) fires during the soak, verify dendrometer_daily
             got new rows. If the soak is too short for the daily tick, run a
             forced golden-vector replay against the live module as a substitute.
```

### Verdict

```
GREEN: all 17 checks pass → merge bundle to main, tag checkpoint, continue
RED:   any check fails →
  1. SSH to kaba100 and run the RESIDENT restore script (see below)
     — restore uses the ON-PI backup, never crosses the network
  2. Restore previous flows payload:
     - Pre-B5: re-deploy from the prior checkpoint ref via deploy.sh
     - Post-B5: symlink rollback (5.3's mechanism)
  3. Restart Node-RED on restored state
  4. Verify kaba100 is back to pre-deploy state (re-run checks 8-15)
  5. HALT pipeline
  6. Page operator with: which check failed, the bundle contents, the evidence
  7. Do NOT auto-retry. Do NOT continue to next bundle.
  8. Operator investigates and either fixes + re-runs the bundle, or skips it
```

### Resident restore script (ON THE PI)

The pipeline deploys a small `restore-pre-deploy.sh` to `/data/backups/` on
kaba100 as part of the pre-deploy step. It:

- Stops Node-RED
- Copies `/data/backups/pre-deploy-<timestamp>.db` back to `/data/db/farming.db`
  (removes WAL/SHM sidecars first)
- Runs `PRAGMA integrity_check` on the restored DB
- Restarts Node-RED

This script runs ON the Pi via a single SSH command — it does NOT depend on the
reverse tunnel or the serving side. If the tunnel dies mid-deploy, the restore
still works via direct SSH.

**Sync-state caveat after restore:** if the soak ran for hours/days before
RED, the edge may have synced new-schema rows to the cloud. Restoring the
48h-old backup rolls back sync cursors. The cloud has events the edge no
longer knows about. This is acceptable for kaba100 (demo, rebuildable) —
the next sync cycle re-sends from the restored cursor and the server's
dedup (inbox `existsById`) handles the overlap. For production gateways
(Uganda), restore-after-soak is NOT automated — it's operator-judged.

### Pipeline heartbeat (Fable review)

The controller emits a "pipeline alive" heartbeat every 30 minutes during
soaks. If the operator's monitoring sees no heartbeat for >1 hour, the
pipeline controller itself is dead (VPS restart, OOM, etc.) — the soak is
unmonitored. This is distinct from a RED: the gateway may be fine, but
nobody is watching. Alert on missing pipeline heartbeat.

### Distinguishing failure modes

```
GATEWAY_UNREACHABLE: SSH timeout / Node-RED won't start / :1880 unreachable
  → This is WORSE than a check failure — the verification instrument is blind.
  → Treat as RED + escalated alert. Never assume "it'll come back."

CHECK_FAILED: A specific check returned unexpected results
  → Standard RED path above.

DEPLOY_FAILED: deploy.sh exited non-zero
  → The deploy itself failed. kaba100 may be in a mixed state.
  → Restore backup FIRST, then RED path.
```

## AgroLink checkpoint bar

A checkpoint is AgroLink-eligible when:

- **7-day soak on kaba100:** error_count flat, zero Node-RED restarts,
  sync green (outbox draining, no dead-letter growth), canary criteria held
  continuously
- **Silvan control:** Silvan on the previous checkpoint shows no regression
  (proves the checkpoint, not the soak period, is what's healthy)
- **All CI verifiers green:** the full suite (`verify-sync-flow.js`,
  `verify-profile-parity.js`, `verify-migrations.js`, `verify-seed-replay.js`,
  `verify-db-schema-consistency.js`, `verify-runtime-schema-parity.js`,
  `verify-no-stray-ddl.js`, `verify-flows-size-ratchet.js`)

The AgroLink deployment is a fresh Pi seeded from `seed-blank.sql` (not a
migrated existing DB), so migration machinery (1.B1) is nice-to-have but not
required. The canonical schema from 0.3 IS required — AgroLink must seed from
the authoritative reference.

## Kill switch

The pipeline halts on ANY of:

- A verification check fails (RED path)
- Gateway unreachable during verification
- A Fable/CodeRabbit review flags a CRITICAL finding that isn't auto-fixable
- The Codex fix loop exceeds 3 iterations on the same finding
- Token/cost budget exceeded for a bundle ($50 ceiling per bundle)

On halt: the operator gets a structured alert with the failure context and
can resume, skip, or abort the bundle.

## The pipeline controller

A scheduled Claude Code routine (or a simple Python script on the test VPS)
that orchestrates the cycle:

```
while items_remaining:
    bundle = next_bundle()
    branch = create_bundle_branch(main, bundle.name)

    for item in bundle.items:
        worker_builds(item, branch)        # Codex worker executes the plan
        reviews = run_reviews(branch)       # Fable + CodeRabbit
        if reviews.has_findings:
            worker_fixes(reviews, branch)   # Codex fixes
            re_review(branch)               # Second pass
            if still_has_findings:
                halt("unfixable review findings")

    if bundle.needs_deploy:
        pre_deploy_backup(kaba100)
        deploy(branch, kaba100)
        evidence = verify(kaba100)
        if evidence.is_red:
            restore(kaba100)
            halt(evidence)
        soak(bundle.soak_hours)
        evidence_after_soak = verify(kaba100)
        if evidence_after_soak.is_red:
            restore(kaba100)
            halt(evidence_after_soak)

    merge_to_main(branch)
    tag_checkpoint(next_checkpoint_number)
    delete_branch(branch)
```

## Bootstrapping: the already-executed PRs

8 items are already code-complete as open PRs (#118–#124 + #117 merged). The
first pipeline pass is NOT a build-from-scratch pass — it is a
**fix→review→merge→verify** pass over existing work:

1. Commit the Fable-review spec/plan fixes (currently uncommitted on main)
2. Apply the two implementation fixes (1.A2 allowance, 1.A5 index)
3. Merge the PRs in the verified order, running the verification protocol
   after each deploy bundle
4. The pipeline switches to build-from-scratch mode only for items the worker
   hasn't started yet (Phase 2+ extractions)

For existing PRs: retarget each to the current bundle branch, rebase, verify
CI green, then merge to the bundle branch (not directly to main).

## Soak parallelism

During a deploy bundle's soak period, **CI-only bundles can run in parallel**
on a separate branch. The soak is wall-clock time on kaba100; CI work doesn't
touch the gateway. So B2 (CI guardrails) can overlap with B1's soak, and B6
(server CI) can overlap with B3/B4/B5 soaks.

The pipeline controller tracks this as two lanes:

- **Pi lane:** sequential deploy→verify→soak, one at a time
- **CI lane:** parallel work that doesn't touch a gateway

## Timeline reality

AgroLink installs "next week" but the first deployment is not full production —
there are a few weeks to stabilize. The 7-day soak bar is for the
**AgroLink-eligible checkpoint**, not for the install itself. Realistically:

- **Week 1 (now):** Merge B0–B3 (tooling + guardrails). Deploy to kaba100.
  Start soak clock on `agrolink-checkpoint-1`.
- **Week 2 (install week):** If checkpoint-1 soaked clean, AgroLink deploys
  from it (tooling + canonical schema, but NOT deploy rewrite or staged deploy).
  Meanwhile B4–B7 continue on kaba100.
- **Weeks 3–4 (stabilization):** B4–B7 soak. If green, AgroLink upgrades to
  a later checkpoint. Phase 2 extractions begin.

The AgroLink install doesn't need to wait for the full refactor. It deploys
from whichever checkpoint is green. The aggressive scope means it COULD ship
Phase 2 extractions if they soak in time — but it doesn't NEED them.

## What this spec does NOT cover

- The Codex worker prompt (already written: `docs/superpowers/prompts/refactor-program-2026/prompt.md`)
- The individual item specs/plans (already written and Fable-reviewed)
- The Forge controller (separate spec: `2026-07-10-forge-controller-stage1-design.md`)
- AgroLink branding/theming (separate)
- Uganda catch-up (item 2.1, operator-gated, explicitly excluded from automation)

## Open decisions (Fable recommendations noted)

1. **Where does the pipeline controller run?** Fable recommends: **Python
   script on the test VPS** — deterministic, forge-runner + Tailscale exist,
   survives workstation sleep. The workstation alternative means the pipeline
   dies when the laptop sleeps.
2. **Headless browser for GUI verification:** Fable recommends: **Playwright
   headless on the same VPS.** No display server needed — Playwright runs
   headless by default.
3. **Alert mechanism on halt:** Fable recommends: **Push notification
   (ntfy.sh or Slack webhook) PLUS periodic "pipeline alive" heartbeat** — a
   log file fails the unattended premise. The operator must be paged on RED,
   not discover it hours later.

## Rebase hazard: flows.json conflicts (Fable review)

The 8 existing PRs were built in parallel against the same main. Serializing
them onto bundle branches will cause flows.json merge conflicts (it's a 1MB
single JSON blob). **After any rebase that touches flows.json, re-run Fable
review on the rebased diff** — conflict resolutions are new code the original
PASS review never saw. The pipeline must detect flows.json conflicts in the
rebase step and, if manual resolution was needed, flag the resolution for
re-review before proceeding.
