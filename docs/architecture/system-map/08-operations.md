# 08 — Operations & Tooling

[← Cloud server](07-cloud-server.md) · [Index](README.md)

How firmware gets built, how changes reach live farms safely, and the safety
net of scripts and process that keeps a small team from breaking production
agriculture.

## Building the firmware

- Orientation guide: [docs/build/building-firmware.md](../../build/building-firmware.md);
  full release workflow (both Pi targets): [docs/build/rpi5-full-osi-image.md](../../build/rpi5-full-osi-image.md).
- `make init` (repo-root [Makefile](../../../Makefile)) initializes the OpenWrt
  submodule, feeds, symlinks, and quilt patch tooling; `make devshell` offers a
  Docker build environment. The build overlays the profile directory
  (chapter [02](02-edge-gateway.md)) onto OpenWrt 24.10 and produces a
  flashable SD-card image per target (Pi 5 `bcm2712`, Pi 4/2 `bcm2709`, both
  sized so the writable partition fits 16 GB cards, with a one-shot auto-grow).
- Release checklist: [docs/versioning-workflow.md](../../versioning-workflow.md)
  (version bumps, Chameleon calibration seed refresh via
  `scripts/refresh-chameleon-calibrations.js` +
  `scripts/apply-chameleon-calibration-seed.js`, verifier runs, image
  post-checks).

## Deploying to a live gateway: `deploy.sh`

[deploy.sh](../../../deploy.sh) is the one sanctioned way to update a
provisioned Pi in the field without touching its data. It is designed to be
**fetched and executed on the Pi** (typically through a reverse-SSH tunnel
serving the repo over HTTP). What it does, in order:

1. **Preflight**: verifies connectivity and the communication contract
   (`run_communication_preflight`).
2. **Payload swap**: fetches the new flow file, helper modules, codecs, and
   the built GUI bundle (`react_gui.tar.gz`), staging then atomically swapping
   them (`swap_call`, `same_fs_or_die`; logic tested by
   `scripts/deploy-payload-swap.js`).
3. **Database seeding, only if absent** (`seed_db_if_missing`): a live
   `farming.db` (or any of its journal sidecar files) is never overwritten.
   This is the number-one field-safety rule.
4. **Schema migration** (`run_schema_migration`, ~line 252): downloads the
   ordered migrations + runner, stops Node-RED, checkpoints the database,
   baselines first-time devices, applies pending migrations with backups under
   `/data/backups/migrate`, and restarts Node-RED (details in chapter
   [04](04-edge-database.md)).
5. **Post-checks**: GUI bundle hash changed, database preserved and fresh
   telemetry flowing, key routes healthy (an auth-gated route returning 401 is
   the *healthy* signal).

Around it: `scripts/pi/backup-pre-deploy.sh` / `restore-pre-deploy.sh`
(timestamped full backups before risky work), `scripts/deploy-canary-gate.js`
(the staged-rollout gate: demo gateways first, production only after the canary
passes; runbook in
[docs/operations/deploy-canary-gate-runbook.md](../../operations/deploy-canary-gate-runbook.md)),
and `scripts/pipeline/` (a Python driver that orchestrates
check-bundles → deploy → evidence collection → alerting → restore for
scripted rollouts). Live-operation procedures (per-gateway repair, Uganda
catch-up, LSN50 writer cutover, history retention) live in
[docs/operations/](../../operations).

## The verification safety net

Around a hundred scripts under [scripts/](../../../scripts) act as executable
guard rails. The most important families:

| Family | Representative scripts | What they protect |
|---|---|---|
| **Sync & contracts** | `verify-sync-flow.js` (flagship), `verify-sync-contract.js`, `verify-sync-op-parity.js`, `verify-communication-contract.js`, `test-contract-schemas.js` | The edge sync implementation and the cross-repo contract files. |
| **Schema & data safety** | `verify-migrations.js`, `verify-seed-replay.js`, `verify-db-schema-consistency.js`, `verify-runtime-schema-parity.js`, `verify-devices-rebuild-fence.js`, `rehearse-devices-rebuild.test.js`, `verify-no-stray-ddl.js` | Chapter [04](04-edge-database.md)'s invariants. |
| **Flow quality ratchets** | `test-flows-wiring.js` (pins critical node wiring), `verify-no-new-silent-catch.js` (no new swallowed errors), `verify-flows-size-ratchet.js` (embedded flow code may only shrink), `flows-bare-require-scan.js`, `verify-helper-registration.js`, `check-mqtt-topics.sh` | The flow file stays healthy and keeps shrinking toward helper modules. |
| **Device codecs** | `verify-lorain-codec.js`, `verify-s2120-codec.js`, `verify-strega-gen1.js`, `verify-lsn50-chameleon-*.js`, `verify-codec-robustness.js`, `verify-agroscope-uplink-transform.js`, `verify-chameleon-calibration.js` | Each payload decoder against golden payloads and hostile inputs. |
| **Extracted-module contracts** | `test-dendro-contract.js`, `verify-dendro-contract-mirror.js`, `capture-*-vectors.js`, `verify-history-api-contract.js`, `test-history-helper.js`, `verify-channel-manifest-parity.js` | The refactored helper modules still produce byte-identical outputs to their frozen golden vectors, on both repos. |
| **Ops & resilience** | `scripts/soak/` (a chaos rig replaying kill-9-during-migration, clock jumps, SD-card-full, outbox replay), `test-crash-loop-escalation.js`, `test-scheduler-clock-jump.js`, `test-timestamp-clamp.js`, `test-gateway-health-persistence.js`, `test-outbox-retention.js` | The gateway survives ugly real-world failure modes. |
| **Diagnosis helpers** | `diagnose-pi-communication.sh`, `diagnose-sensor-history-gap.js`, `audit-pi-db.js`, `download-farming-db.sh` | Field triage (see the debugging playbook skill). |

## Continuous integration

- **osi-os** [.github/workflows/](../../../.github/workflows):
  `verify-sync-flow.yml` (sync + schema-consistency + profile parity),
  `migrations.yml` (migration/seed/boot-node gates), `codecs.yml` (decoder
  suites), `history-router.yml` (history/analysis module tests),
  `typecheck.yml` (GUI type/tests).
- **osi-server** `.github/workflows/`: `backend-ci.yml` (Gradle build + tests +
  frontends), `prediction-ci.yml` (pytest), `ghcr-publish.yml` (container
  images to GitHub Container Registry, so the VPS never has to build on-host).

## How the team works (process as architecture)

- [docs/engineering-playbook.md](../../engineering-playbook.md): the working
  loop every non-trivial change follows: verify reality → written plan →
  adversarial review → exact execution → independent verification; plus the
  failure modes the repo has already paid for. Plans/specs from this loop are
  archived under [docs/superpowers/plans/](../../superpowers/plans) and
  [docs/superpowers/specs/](../../superpowers/specs), a searchable design
  history of every major change.
- [docs/adr/](../../adr): long-lived architecture decision records.
- `.claude/skills/`: fourteen "field manuals" that encode repo-specific
  know-how for AI-assisted work (flows editing rules, schema change control,
  live-ops runbook, debugging playbook, sensor domain reference, config
  catalog, verification command selection, common pitfalls, forge boundaries…).
  `.agents/skills` is a committed symlink for other agent tools.
- [docs/architecture/refactor-program-2026.md](../refactor-program-2026.md):
  the program map this snapshot concludes: phased plan, adjudicated design
  decisions, YAGNI list, and stop conditions.

## The feedback → pull-request pipeline

The system's newest subsystem turns farmer feedback into reviewed code changes:

- **Stage 0: field work requests (shipped).** A farmer files a report in the
  gateway GUI (`SupportRequests` page → `/api/improvement-requests`, stored in
  `improvement_requests` with diagnostics preview). The gateway delivers it to
  the cloud (5-minute worker); the cloud's `workrequest` package redacts,
  pseudonymizes, rate-limits, and files it as a **GitHub issue**, then pushes
  status updates back down to the farmer's gateway. Design:
  [docs/operations/field-work-requests-stage0.md](../../operations/field-work-requests-stage0.md).
- **Stage 1: Forge (shipped for osi-os).** An agent pipeline that takes such
  an issue to a draft PR under strict guard rails: **(osi-server)** `forge/`
  (`controller.py`, `pipeline.py`, `gates.py` with the verification gates it must
  pass, `github_pr.py`, `skill_index.py`, `prompts/`), with its cloud API in
  `workrequest/ForgeController.java` and its boundary rules in the osi-os
  skills `osi-forge-boundaries` and `osi-verification-commands`.

## The live fleet & access rules

Three live gateways at the snapshot date: two demo units (Silvan, kaba100) and
one production farm (Uganda). Operational identities and addresses are kept in
the private memory/runbooks, not in repo docs. Standing rules:

- Never overwrite a live `farming.db`; never hand-edit ledger tables.
- `osicloud.ch` (production cloud) is restricted: no SSH, file inspection, or
  secret copying unless explicitly requested per session; use the test server
  instead.
- Production rollouts are demo-first behind the canary gate; Uganda (the
  production farm) is additionally gated by program-level decisions.
- Session hygiene: `scripts/session-closeout.sh` runs the end-of-session
  checklist (docs/memory reconciliation, temp-file review).
