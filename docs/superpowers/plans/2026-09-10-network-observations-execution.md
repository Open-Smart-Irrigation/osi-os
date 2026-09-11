# Network observations execution checkpoint

The network observation implementation is deployed to the cloud test service and
to the designated pilot gateway. Functional checks pass for the deployed radio
path. Retained rejection history still prevents a healthy canary verdict.
Authenticated UI checks are separately pending.

## Implemented and reviewed

The edge implementation is based on `855aee17f` and ends at commit
`9f010325e`. Capture now runs independently of the disabled Field Testing tab,
and radio corrections follow deterministic protocol ordering. Cloud commit `93c7380e` includes bootstrap
installation identity repair for legacy links, multi-user ownership handling,
the MQTT binary alignment fix, and the dedicated per-zone-per-day
`ZONE_ENVIRONMENT` watermark with a stateful regression.

The cloud branch was rebased after main added its pending-projections migration.
The three unshipped network migrations were renumbered to
`2026.09.17.001–003`; the ordering gate passes.

## Verification

- Edge network, revision and API checks: 38 passed, zero skipped. Four
  normalization checks also passed.
- Cloud focused backend checks: 7 classes, 118 passed, zero skipped.
- Frontend checks: 81 script tests and 803 component tests passed.
- Rehearsal against a restored copy of the target database applied the staged
  migrations and validated 101 migrations. Counts for all 77 original tables
  were preserved.
- Device-data reading rows increased from 44,212 to 44,224 during the pilot. The
  target snapshot and rehearsal retained the original rows.

The first deployment runner stopped before connecting to the database because
the extracted libraries did not have permissions for the container user. The old
backend restarted with the original 85-row migration history. After permissions
were corrected and checked with a read-only probe under the deployment user, the
retry completed and the deployed migration set validated.

The first five real radio uplinks had equal parsed JSON metadata and normalized
timestamps on edge and cloud. The first two were quarantined for an unknown
installation and then retried unchanged from the existing dirty queue; no rows
remain quarantined. New weather versions 27 and 28 were accepted without
increasing the retained rejection tally.

## Deployment state

Phase 5 deployment functional checks are verified. Health and authenticated UI
acceptance remain pending.

The pilot runtime payload is `20260911T002237Z-radio`. Capture remains disabled
outside the designated pilot. No production host was accessed, and no passwords
were changed.

The retained legacy rejection tally is 17,959. The current rolling health result
reports `sync_rejected`; the schema fingerprint is correct and MQTT is
connected. Run the operator canary with `TZ=UTC`: the current cloud response
formats its UTC heartbeat timestamp without an offset, and a local-time parse
can falsely report `heartbeat_before_deploy`. One canary run exited with a transport/authentication error during
backend restart, and an earlier run failed its heartbeat/schema gate. The
evidence must remain available for diagnosis rather than being deleted,
acknowledged artificially, or hidden by a canary change.

The browser runtime was unavailable, so no signed-in UI smoke pass is claimed.
HTTP health, login, metrics, locale assets and unauthenticated access checks
were verified during the cloud deployment. Positive pilot gateway reads remain
the next authenticated API check.

## Remaining scope

Resolve the rolling sync rejection condition and rerun the canary with the
retained evidence intact. Then perform the authenticated pilot reads and browser
checks when the runtime is available.

Account projects, offline browser projects and simulation comparison remain
later phases. The paired implementation worktrees and recovery references retain
the reviewed changes.
