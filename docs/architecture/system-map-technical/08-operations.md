# 08 — Operations

[← Cloud server](07-cloud-server.md) · [Index](README.md)

## Firmware build

[docs/build/building-firmware.md](../../build/building-firmware.md) is the
orientation guide; [docs/build/rpi5-full-osi-image.md](../../build/rpi5-full-osi-image.md)
is the release workflow for both targets (Pi 5 `bcm2712/rpi-5`, Pi 4/2
`bcm2709/rpi-2`). `make init` initializes the OpenWrt submodule, feed
config, symlinks, and quilt; `make devshell` provides a Docker build
environment. Images ship with `CONFIG_TARGET_ROOTFS_PARTSIZE=14336` plus the
first-boot rootfs grow. Release steps, including the Chameleon calibration
seed refresh (`scripts/refresh-chameleon-calibrations.js` then
`scripts/apply-chameleon-calibration-seed.js`, which updates every bundled
DB and fails on an empty snapshot), are listed in
[docs/versioning-workflow.md](../../versioning-workflow.md).

## Live deploy

[deploy.sh](../../../deploy.sh) updates a provisioned Pi in place. It is
fetched onto the device (repo served over a reverse-SSH tunnel) and runs:

1. `run_communication_preflight()` — connectivity and contract checks.
2. Payload staging and atomic swap (`fetch_required`, `same_fs_or_die`,
   `swap_call`): flows.json, helper modules, codecs, GUI bundle
   (`react_gui.tar.gz`). Wiring covered by
   `scripts/test-deploy-atomic-payload-wiring.js` and
   `scripts/deploy-payload-swap.test.js`.
3. `seed_db_if_missing()` — seeds only when `/data/db/farming.db` and all
   WAL/SHM/journal sidecars are absent; otherwise it refuses. This is the
   primary data-safety gate.
4. `run_schema_migration()` (~line 252) — deploy-time migration delivery
   (mechanics in chapter [04](04-edge-database.md)); backups under
   `/data/backups/migrate`; on restore-integrity failure (rc=3) Node-RED
   stays stopped for operator intervention.
5. Post-checks: GUI bundle hash changed, DB size/data preserved, fresh
   telemetry, `:1880/gui` reachable, `export.csv` returns 401 (auth-gated
   healthy), ChirpStack profiles present.

Supporting tooling: `scripts/pi/backup-pre-deploy.sh` /
`restore-pre-deploy.sh` (timestamped `/data/db/backups/osi-os-<ts>` covering
DB, `/srv/node-red/`, GUI), `scripts/deploy-canary-gate.js` (demo gateways
first; runbook
[docs/operations/deploy-canary-gate-runbook.md](../../operations/deploy-canary-gate-runbook.md)),
and `scripts/pipeline/` (Python orchestrator: `controller.py`, `checks/`,
`deploy.py`, `evidence.py`, `alert.py`, `restore.py`, with `bundles.json`
defining check bundles). Live-fleet procedures live under
[docs/operations/](../../operations) (Uganda catch-up, LSN50 writer cutover,
history retention, I2C outage analysis).

## Verifier taxonomy

The `scripts/` directory holds the executable invariants. Families, with
representatives:

| Family | Scripts | Scope |
|---|---|---|
| Sync/contract | `verify-sync-flow.js`, `verify-sync-contract.js`, `verify-sync-op-parity.js`, `verify-communication-contract.js`, `test-contract-schemas.js`, `check-sync-parity.js` | Chapter [06](06-edge-cloud-sync.md) invariants, edge and cross-repo. |
| Schema | `verify-migrations.js`, `verify-seed-replay.js`, `verify-db-schema-consistency.js`, `verify-runtime-schema-parity.js`, `verify-devices-rebuild-fence.js`, `rehearse-devices-rebuild.test.js`, `verify-no-stray-ddl.js` | Chapter [04](04-edge-database.md) invariants. |
| Flow quality ratchets | `test-flows-wiring.js` (pins STREGA wiring, DB-close audit, `libs` audit, WS2/WS3 invariants), `verify-no-new-silent-catch.js`, `verify-flows-size-ratchet.js` (no node grows, new nodes ≤ 4 KB, total embedded JS must not increase), `flows-bare-require-scan.js`, `verify-helper-registration.js`, `check-mqtt-topics.sh` | flows.json health; ratchets are git-anchored against `origin/main`. |
| Codecs | `verify-lorain-codec.js`, `verify-s2120-codec.js`, `verify-strega-gen1.js`, `verify-lsn50-chameleon-{codec,persistence,swt}.js`, `verify-codec-robustness.js`, `verify-agroscope-uplink-transform.js`, `verify-chameleon-calibration.js` | Decoder behavior against golden payloads and malformed input. |
| Extracted-module contracts | `test-dendro-contract.js`, `verify-dendro-contract-mirror.js`, `capture-{dendro-analytics,history-router,zone-env}-vectors.js`, `verify-history-api-contract.js`, `test-history-helper.js`, `verify-channel-manifest-parity.js` | Refactored helpers reproduce frozen golden vectors on both repos. |
| Resilience | `scripts/soak/` (chaos rig: kill-9 during migration, clock jump, SD-full, outbox replay scenarios with tests), `test-crash-loop-escalation.js`, `test-scheduler-clock-jump.js`, `test-timestamp-clamp.js`, `test-gateway-health-persistence.js`, `test-outbox-retention.js` | Failure-mode behavior. |
| Diagnosis | `diagnose-pi-communication.sh`, `diagnose-sensor-history-gap.js`, `audit-pi-db.js`, `download-farming-db.sh` | Field triage; selection guidance in the `osi-debugging-playbook` skill. |

## Continuous integration

osi-os [.github/workflows/](../../../.github/workflows): `verify-sync-flow.yml`
(sync + chained schema consistency + profile parity), `migrations.yml`
(migration/seed/boot-node gates incl. the rebuild rehearsal), `codecs.yml`,
`history-router.yml`, `typecheck.yml` (GUI). osi-server
`.github/workflows/`: `backend-ci.yml` (Gradle build + tests + frontends),
`prediction-ci.yml` (pytest), `ghcr-publish.yml` (prebuilt images so the VPS
never builds on-host).

## Process

[docs/engineering-playbook.md](../../engineering-playbook.md) defines the
change loop: verify reality, written plan, adversarial review, exact
execution, independent verification; §8 is the definition of done. Plans and
specs archive under [docs/superpowers/plans/](../../superpowers/plans) and
[docs/superpowers/specs/](../../superpowers/specs); decisions with long
half-life go to [docs/adr/](../../adr).
[docs/architecture/refactor-program-2026.md](../refactor-program-2026.md)
holds the program map this snapshot closes.

Agent field manuals live in `.claude/skills/` (14 at the snapshot, indexed in
[AGENTS.md](../../../AGENTS.md)): flows editing, schema change control,
live-ops runbook, debugging playbook, sensor domain reference, config
catalog, sync contract awareness, verification-command selection, common
pitfalls, GUI patterns, server patterns, forge boundaries, and the
anti-slop writing floor used for this document set. `.agents/skills` is a
committed symlink for non-Claude tools.

## Feedback-to-PR pipeline

- Stage 0, shipped: the GUI's support page posts to
  `/api/improvement-requests`; rows persist locally with a diagnostics
  preview and deliver to the cloud every 300 s. The cloud's `workrequest`
  package redacts and pseudonymizes, rate-limits, scans public artifacts for
  secrets, files a GitHub issue, and notifies status back to the gateway.
  Reference: [docs/operations/field-work-requests-stage0.md](../../operations/field-work-requests-stage0.md).
- Stage 1, shipped for osi-os: Forge, an issue-to-draft-PR agent pipeline.
  Service code in **(osi-server)** `forge/` (`controller.py`, `pipeline.py`,
  `gates.py`, `github_pr.py`, `skill_index.py`, `prompts/` with plan/review
  schemas); cloud API in `workrequest/ForgeController.java`; execution
  boundaries and allowed verification commands in the osi-os skills
  `osi-forge-boundaries` and `osi-verification-commands`. Stage 1 indexes
  osi-os only.

## Fleet rules

Three live gateways at the snapshot: two demo units and one production farm
(Uganda). Addresses and credentials stay in private runbooks. Standing
constraints: never overwrite a live `farming.db`; never hand-edit
`schema_migrations` or `schema_object_fingerprints`; production cloud access
(`osicloud.ch`) requires an explicit per-session request; production
rollouts run demo-first behind the canary gate; `scripts/session-closeout.sh`
runs the end-of-session checklist.
