# AgroLink fix wave Round 3 execution report

Date: 2026-08-13  
Edge worktree: `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep`  
Cloud worktree: `/home/phil/Repos/osi-server/.worktrees/agrolink`

N1–N4 and the residual-red dispositions were executed as local commits. No
push, deploy, live gateway, or production-cloud access was used. The cloud
worktree's pre-existing untracked prompt files were preserved.

## Task commits

| Task | Repository | Commit | Result |
|---|---|---|---|
| N1 | edge | `6ffc7a07` | Hoisted the cross-owner and type-conflict fences out of the scoped-mode conjunct. Flag-off conflicts now return the legacy terminal FAILED ACK before any ChirpStack call; scoped-only ACK detail remains gated. |
| N2 | edge | `d4364f67` | Resolves the claimant by command `userUuid` first, then `cloud_user_id`; unknown principals return terminal `FAILED/UNKNOWN_PRINCIPAL` without mutation or provisioning. `UPSERT_SCOPED_USER` persists `user_uuid`; no new schema column was added. |
| N3 | cloud | `f05b92be` | Refuses cross-owner reassignment in the real `DeviceService`, returns an honest 409 conflict envelope, and preserves `zoneWarning` plus `ALREADY_CLAIMED` in registration sync status. The commit also includes the required ArchUnit refreeze. |
| N4 | edge | `e58077b0` | Wires the resolved server source through parity verification, errors when its golden is absent or differs, and adds the migrations workflow byte-compare. |
| residual (a) | edge | `a4ec878a` | Supplies the real `osiLib` to the journal and device-auth harnesses, repoints the ENOENT assertion to `osi-scope-helper/index.js:36`, and records the N2 flow-size ceiling. |
| residual (b) | edge | `6c761be7` | Selects the Record Error link-out explicitly while preserving the X8 authentication HTTP-response branch. |
| residual (c) | edge | `718fd5a9` | Retires the completed journal-bootstrap and sync-outbox one-shot generators and removes their stale activated-state hash guards from the test harness. |
| residual (d) | edge | `3479ab41` | Deletes the obsolete `verify-lsn50-chameleon-swt.js`; no workflow reference remained. The calibration and persistence replacements pass. |
| corrections | edge | `74fa2655` | Corrects the Round 2 report: R6 includes approximately three new device-to-zone edges inside existing frozen cycles, and R7 weather-station filtering remains non-vacuously untested and deferred to R14. |

## N1/N2 mutation and probe evidence

The five new N1/N2 probes were red before their fixes and pass now:

- N1 flag-off cross-owner claim: terminal legacy FAILED ACK, owner unchanged,
  zero ChirpStack calls.
- N1 flag-off type conflict: terminal conflict before provisioning.
- N2 stable UUID claim: `userUuid=u-res1` selects local user 2 even with an
  unmapped `cloudUserId=9999`.
- N2 unknown principal: `FAILED/UNKNOWN_PRINCIPAL`, unchanged row, zero
  provisioning calls.
- N2 unknown principal against user 1's device: it is not treated as user 1
  and cannot bypass the owner fence.

Mutation checks were also run after implementation. Restoring the scoped-only
guard made both N1 tests fail with SUCCESS instead of FAILED. Restoring the
old user-1 fallback made the UUID probe select the wrong owner and made both
unknown-principal probes proceed instead of NACKing. Undoing each mutation
returned the suite to green. The N1/N2-focused run reports 75 tests passed,
including the five named probes.

## Other verification evidence

- R4 residual seam: `test-journal-bootstrap.js` is 62/62 and
  `test-device-api-auth-status.js` is 79/79. `capture-history-router-vectors.js
  --verify` is 4/4, and `verify-strega-gen1.js` exits 0. The STREGA Gen1
  `osiLib` red was pre-existing before this wave.
- Residual generator guard: `test-sync-outbox-json-guard.js` passes after
  retiring the applied one-shot generators. The four `activatedPostimageHash`
  pins in `harden-sync-outbox-json.js` and the corresponding historical
  activated pins in `migrate-flows-journal-bootstrap.js` were retired rather
  than re-pinned because both generators are already applied and later flow
  edits make those historical postimages invalid replay targets.
- N4 parity: the explicit edge-to-cloud run passes, and the parity test suite
  reports 51/51. The edge and cloud golden files are byte-identical.
- ArchUnit: the frozen store was deleted, recreated with both creation and
  update flags temporarily enabled, and both flags were restored to `false`.
  The full cloud run is green. The refrozen evidence is the identical
  1,402-cycle set with zero added or removed cycle violations; review also
  identified approximately three new device-to-zone edges inside existing
  frozen cycles, plus constructor-signature churn.

## Verification gates

Required edge verifiers and command-path suites pass, including profile parity,
MQTT topic checks, silent-catch and flow-size ratchets, schema/runtime parity,
migrations, sync-contract/parity checks, history contracts, device integration,
scoped reads/writes, scoped command paths, and device, irrigation-config, and
zone command paths. The combined scoped/device/zone command-path run reports
132/132 tests passed.

Frontend and cloud results:

- Edge `web/react-gui`: 1,721 Vitest tests and 128 TSX-runner tests passed.
- Cloud `frontend`: unit suite passed, including 715 Vitest tests.
- Cloud `backend`: `./gradlew test --no-daemon` passed 1,613 tests with one
  skipped `JournalScannerBridgeIT` ClamAV EICAR integration test.

Additional paired verifiers pass when supplied their required local checkout
paths: dendro mirror, prediction catalog, journal catalog vendor, UI-core
vendor, and the Chameleon V1.5 database check. The ordinary factory-image
provenance verifier passes. The built-factory-image provenance verifier was
not runnable because this workspace has no built rootfs/profile; this is the
single permitted environmental gate exception.

The operational `check-sync-parity.js` probe was not counted as a repository
gate because it defaults to `/data/db/farming.db`, which is absent in this
non-live workspace. It correctly exits unhealthy without a live host. A
blanket all-script aggregate was also stopped after its environment-oriented
`baseline-existing-db.test.js` child made no progress for more than six
minutes; the explicit required verifier and command-path inventory above was
completed independently.

## Deferred work

N5 remains deferred: replay must not clobber local device renames, the type
conflict must not precede the ownership fence, and `MILESIGHT_UC512` must be
covered by the cloud registration type map.

R9–R14 remain deferred:

- R9: runtime-gate calibration and weather-station trigger families, or
  document cloud-first rollout as the sole guard.
- R10: pin destination-plot authorization and enforce ownership for plotless
  journal voids.
- R11: complete cloud aggregate-key/EUI consistency, first-writer claiming,
  ownerless mirror, and journal ownership coverage.
- R12: resolve NULL gateway-EUI assignment messaging, E6 ignored-zone
  semantics, and C6 mismatch-modal coverage.
- R13: wire the remaining CI suites, strengthen cross-repo pinning, mirror
  command tests, and repair provenance concurrency coverage.
- R14: add non-vacuous weather-station filter coverage, retain the corrected
  report numbers, add remaining HistoryDashboard and Uganda-language coverage,
  and correct `lg` hexadecimal rendering.
