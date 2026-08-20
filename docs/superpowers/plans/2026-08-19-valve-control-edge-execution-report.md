# Valve control (edge, Phase A): execution report

Date: 2026-08-19 → 2026-08-20 (overnight autonomous session). Branch
`feat/valve-control`, 36 commits from `69772499` to `79d306dd`. Plan:
`docs/superpowers/plans/2026-08-19-valve-control-edge.md`; spec:
`docs/superpowers/specs/2026-08-19-valve-control-design.md`.

## Outcome in one paragraph

All 15 plan tasks are implemented, each with an independent review and a
scoped re-review; the final whole-branch review returned GO with no blocker
and its fix wave is merged and re-reviewed. Every local gate is green. The
Silvan deploy did NOT land: `deploy.sh`'s migration step hit the Stage 0
semantic baseline refusal (`NO VERSION MATCHES`) and aborted the rest of the
deploy — silently, with exit 0. Investigation shows Silvan has been in this
state since at least 2026-07-12: its live `flows.json` is a plain file dated
July 7, the ledger is empty, and every deploy since then no-oped at the same
point while reporting success. The farm is healthy and unchanged. Separately,
no gateway in the fleet currently has a registered STREGA valve, so hardware
gates 1–3 could not have run tonight anywhere.

## Local gate evidence (fresh, 2026-08-20, HEAD 79d306dd)

- `node --test conf/full_*/files/usr/share/node-red/osi-valve-control/*.test.js`: 88/88 on both profiles.
- Schema: verify-migrations (22, checksums OK), verify-seed-replay OK,
  verify-runtime-schema-parity OK, verify-db-schema-consistency (7 DBs) OK,
  verify-no-stray-ddl OK, test-journal-schema OK.
- Flows: verify-profile-parity OK, verify-sync-flow OK, check-mqtt-topics OK
  (3 profiles), test-flows-wiring PASS (incl. new valve pins),
  verify-no-new-silent-catch 225=baseline, verify-flows-size-ratchet OK
  (2 122 424 ≤ 2 138 490), flows-bare-require-scan OK, verify-flows-fn-parse
  245/245, verify-strega-gen1 OK (with new ACK fixtures).
- Contract: verify-sync-contract OK, test-contract-schemas OK.
- GUI: `npm run typecheck` clean; `npm run test:unit` node:test 85/85 +
  vitest 104 files / 596 tests; `npm run build` succeeds.
- Helper registration: OK on both profiles; bcm2709 module dir byte-identical.

## The Silvan finding (operational, pre-existing, high priority)

`deploy.sh` output (log preserved in the session scratchpad):

- `[baseline] NO VERSION MATCHES - refusing to stamp.` — `baseline-existing-db.js`
  compared Silvan's live schema against seed+N for N=22…1 and every candidate
  fails. Best fit (N=3) still has 12 semantic diffs: the #153 boot-node
  trigger rewrites plus real drift (missing `device_data` FK, `chameleon_enabled`
  nullability, `volume_source`/`created_at` defaults, a missing index).
- After the refusal the script printed `--- Restart Node-RED after schema
  migration ---` then `OK` and terminated: no payload flip, no GUI extract,
  no `Deploy complete` banner, exit code 0. The payload was staged
  (`payloads/20260820T131348Z`) but never flipped.
- `/srv/node-red/flows.json` on Silvan is a REGULAR FILE dated Jul 7 — the
  2026-07-12 deploy also staged (`payloads/20260712T131154Z`) and never
  flipped. Silvan has silently missed every flows/GUI deploy since early July.
- kaba100 for contrast: payload symlink flipped 2026-08-20 06:37, ledger 47
  rows — its deploy path is healthy. The condition is Silvan-specific
  (never-baselined DB), not fleet-wide.

Two defects to file:
1. **deploy.sh silent abort:** a Stage 0 baseline refusal must fail the deploy
   loudly (non-zero exit, ALERT line), not restart Node-RED and exit 0 with
   the flip silently skipped. This hid six weeks of no-op deploys.
2. **Silvan needs the #153/#157 baseline repair** (or a supervised manual
   reconciliation) before any migration-bearing deploy can land there. No
   override was attempted tonight: `baseline-existing-db.js` refuses by
   design, and hand-stamping the ledger or hand-flipping the payload around a
   refusing gate is exactly what change control forbids on a live farm.

Post-attempt health checks on Silvan (all healthy): `/gui` 301, export.csv
401, `device_data` count grew 37 917 → 37 918 with fresh S2120 telemetry,
`gateway_health_samples` fresh, `sync_outbox` has 0 `VALVE_SCHEDULE` rows.
Side effect left in place: steps 3–7 of deploy.sh ran, so Silvan carries the
new node-red helper modules, package.json, settings.js, and codecs. The
July flows reference none of the new modules; verified harmless (Node-RED
restarted clean, telemetry flowing). Pre-deploy full backup:
`/data/db/backups/pre-valve-control-20260820-131312`.

## Hardware gates

Not run. Silvan and kaba100 both have zero registered `STREGA_VALVE` devices
(checked live). Gates 1–4 (plan Task 15) need a physical STREGA joined to a
migrated gateway. Additional gate from review: write a plan to a NON-today
weekday to pin the FPort 14=Sunday mapping before declaring GEN1 done.

## What is deployable now

The branch is merge-candidate pending: (a) hardware gates on a gateway with
a valve, (b) the deferred-minor follow-ups in the SDD ledger (i18n literal
batch already fixed; remaining: WEEKLY-DELETE recompile test, panel
SWR-error test, unused spare i18n key), (c) Phase B (osi-server mirror +
sync triggers via migration 0023, lockstep).

## Follow-ups (ordered)

1. Fix deploy.sh: baseline refusal → loud failure (new issue).
2. Decide the Silvan baseline repair path (#153/#157 program).
3. Register a STREGA valve on a migrated gateway (kaba100 is the healthy
   candidate) and run hardware gates 1–4.
4. Ask STREGA whether SV2 firmware can report its scheduler after a BLE edit
   (spec §13).
5. Phase B plan (osi-server): `VALVE_SCHEDULE` mirror, commands, AgroLink
   panel, edge migration 0023 + `MIGRATION_OWNED_TRIGGERS` entries.
6. i18n programme: lg placeholder copies of `valves.json` + the flagged
   `settings.json` key need the native pass (Uganda gate).
