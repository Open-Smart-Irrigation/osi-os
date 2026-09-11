# Network observations execution checkpoint

The network observation implementation is deployed to the cloud test service and
to the designated Silvan pilot gateway. Functional checks pass for the deployed
radio path. The rolling sync health gate remains red because the canary still
contains retained legacy rejections and new rejection evidence is still being
monitored.

## Implemented and reviewed

Edge commit `9f010325e` includes the capture-disabled table fix and the numeric,
deterministic radio result correction. Cloud commit `93c7380e` includes bootstrap
installation identity repair for legacy links, multi-user ownership handling,
the MQTT binary alignment fix, and the dedicated per-zone-per-day
`ZONE_ENVIRONMENT` watermark with a stateful regression.

The cloud branch was rebased after main added its pending-projections migration.
The three unshipped network migrations were renumbered to
`2026.09.17.001–003`; the ordering gate passes.

## Verification

- Edge network, revision, API and four normalization checks: 42 passed, zero
  skipped. The parent also ran the 38-test network/revision/API suite.
- Cloud focused backend checks: 7 classes, 118 passed, zero skipped.
- Frontend checks: 81 script tests and 803 component tests passed.
- Fresh-database rehearsal applied the staged migrations and validated 101
  migrations. Counts for all 77 original tables were preserved.
- The live database increased from 44212 to 44224 rows in the checked history
  tables. The target snapshot and rehearsal retained the original rows.

The first deployment runner stopped before connecting to the database because
the extracted libraries did not have permissions for the container user. The old
backend restarted with the original 85-row migration history. After permissions
were corrected and checked with a read-only probe under the deployment user, the
retry completed and the deployed migration set validated.

The first five real radio uplinks matched the edge and cloud byte-for-byte,
including receiver metadata and timestamps. No radio rows entered quarantine.
The new weather version 27 was accepted. The latest rejection at 00:19 predates
the final cloud fix at 00:22.

## Deployment state

The pilot runtime payload is `20260911T002237Z-radio`. Capture remains disabled
outside the designated pilot. No production host was accessed, and no passwords
were changed.

The retained legacy rejection tally is 17959. The rolling 24-hour canary still
reports `sync_rejected`, although the schema fingerprint is correct and MQTT is
connected. This is a pending health gate; the evidence must remain available for
diagnosis rather than being deleted, acknowledged artificially, or hidden by a
canary change.

The browser runtime was unavailable, so no signed-in UI smoke pass is claimed.
HTTP health, login, metrics, locale assets and the unauthenticated access
checks were verified during the cloud deployment. Positive pilot gateway reads
remain the next authenticated API check.

## Remaining scope

Resolve the rolling sync rejection condition and rerun the canary with the
retained evidence intact. Then perform the authenticated pilot reads and browser
checks when the runtime is available.

Account projects, offline browser projects and simulation comparison remain
later phases. The paired implementation worktrees and recovery references retain
the reviewed changes.
