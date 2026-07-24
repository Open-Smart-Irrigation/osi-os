# AgroLink Device Assignment and Configuration Parity Plan

> **Execution:** Use `superpowers:executing-plans`, test-first changes, explicit
> commit file lists, separate edge/server commits, and a self-review before
> every push.

**Goal:** Implement the accepted row-3 device parity design without moving
canonical state away from OSI OS.

**Worktrees:**

- Edge:
  `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep`
- Server: `/home/phil/Repos/osi-server/.worktrees/agrolink`

Do not touch `/home/phil/Repos/osi-os-agrolink`, production, a live gateway,
`osicloud.ch`, an external key service, or an AgroLink SMB share.

## Global gates

Before each heavyweight command, record:

```bash
free -m
awk '/pswpin|pswpout/ {print}' /proc/vmstat
ps -eo pid,comm,rss --sort=-rss | head -n 13
```

Do not start below 4,096 MiB available. Run Gradle from `backend/` with:

```bash
NODE_OPTIONS=--max-old-space-size=2048 \
./gradlew test --no-daemon --max-workers=2
```

Run full frontend tests and builds with a 2,048 MiB Node heap. Edit
`flows.json` only through pinned one-shot Node transformers and mirror every
maintained runtime file to bcm2709.

## Task 1: Specify the protected device aggregate

**Edge files:**

- `docs/contracts/sync-schema/resources.schema.json`
- `docs/contracts/sync-schema/commands.schema.json`
- `docs/contracts/sync-schema/effect-keys.md`
- `docs/contracts/sync-schema/canonicalization.md`
- `docs/contracts/sync-schema/sync-contract-golden.json`
- `scripts/fixtures/sync-contract-staging.json`
- `scripts/test-contract-schemas.js`
- `scripts/verify-sync-contract.js`

- [ ] Add failing schema tests for strict `UPSERT_DEVICE` and protected
      `UNCLAIM_DEVICE` forms.
- [ ] Define `DeviceDesiredState` with the portable field allow-list from the
      accepted design.
- [ ] Bind `UPSERT_DEVICE` to
      `device:<device_eui>:<base_sync_version>`.
- [ ] Bind protected `UNCLAIM_DEVICE` to
      `device_unclaim:<device_eui>:<base_sync_version>`.
- [ ] Reject local observations, numeric zone IDs, unknown fields, wrong
      family-specific fields, noncanonical timestamps, nonfinite depths, and
      `target != base + 1`.
- [ ] Keep every legacy device command form accepted.
- [ ] Stage `UPSERT_DEVICE`; do not enable its issuer.
- [ ] Run contract tests and commit:
      `feat(contract): stage protected device aggregate`.

## Task 2: Implement the protected edge device applier

**Edge files:**

- New paired runtime module:
  `osi-device-commands/index.js`, `index.test.js`, and `package.json`
- Both `osi-command-ledger` copies and tests
- Both `osi-lib/index.js` copies
- Both Node-RED package manifests and locks
- `deploy.sh`
- New `scripts/test-device-command-path.js`
- `scripts/verify-sync-flow.js`

- [ ] Write failing tests for assign, unassign, rename, flags, Kiwi/Clover
      depths, Chameleon depths, STREGA model, and unclaim.
- [ ] Cover replay, same-effect changed intent, stale base, wrong gateway,
      inaccessible owner, type mismatch, missing zone, and rollback.
- [ ] Apply the complete aggregate with bound SQL parameters in one command
      ledger transaction.
- [ ] Store the terminal ACK and returning outbox event atomically.
- [ ] Preserve device type and EUI; never write current/target state or
      hardware observations.
- [ ] Register the helper through `osiLib.require`.
- [ ] Run helper, ledger, deploy, contract, and profile tests.
- [ ] Commit: `feat(sync): apply protected device aggregate`.

## Task 3: Route the protected device commands and capability

**Edge files:**

- Both maintained `flows.json` files
- New pinned flow migration and structural tests
- Existing capability and bootstrap tests
- `scripts/test-flows-wiring.js`
- `scripts/test-scoped-access-writes.js`
- `scripts/verify-sync-flow.js`

- [ ] Add a failing route test before changing the flow.
- [ ] Route `UPSERT_DEVICE` and strict `UNCLAIM_DEVICE` to the protected
      helper before the legacy SQL builder.
- [ ] Keep existing commands on their prior branches.
- [ ] Make local flag, assignment, depth, and name responses return the
      resulting aggregate version.
- [ ] Advertise `device_desired_state_v1` in link, bootstrap, and force-sync
      payloads only after the protected route exists.
- [ ] Run the migration twice and require byte-identical output on the second
      run.
- [ ] Run flow parsing, wiring, scoped access, silent-catch, contract, sync,
      and profile gates.
- [ ] Commit: `feat(sync): advertise protected device state`.

## Task 4: Add versioned S2120 multi-zone assignments

**Edge files:**

- Next two free ordered migrations and `CHECKSUMS.json`
- `database/seed-blank.sql` and all bundled database copies
- Runtime/DB/trigger parity verifiers
- New weather-assignment migration rehearsal
- Contract schemas, golden fixture, staging manifest, and tests
- Protected device helper and tests
- Both flows and a pinned flow migration

- [ ] Re-enumerate ordered migrations before choosing numbers.
- [ ] Add an independent per-device assignment version without rebuilding
      `devices`.
- [ ] Backfill current S2120 assignment sets idempotently.
- [ ] Emit `WEATHER_STATION_ZONES_REPLACED` with sorted zone UUIDs.
- [ ] Define and stage `REPLACE_WEATHER_STATION_ZONES` with
      `weather_station_zones:<device_eui>:<base>`.
- [ ] Apply replacement transactionally after validating device type,
      gateway, every zone UUID, and exact version.
- [ ] Advertise `weather_station_zones_desired_state_v1`.
- [ ] Run migration, seed, schema, trigger, helper, flow, sync, and profile
      gates.
- [ ] Commit schema and runtime changes separately:
      `feat(sync): version weather station zones` and
      `feat(sync): apply weather station zone commands`.

## Task 5: Persist server capabilities and canonical mirrors

**Server files:**

- `LinkedGatewayAccount`, service, and sync tests
- Next free Flyway migration
- `EdgeSyncService` and focused tests
- Device and weather-assignment entities/repositories as required

- [ ] Add failing bootstrap/link tests for both capabilities.
- [ ] Allocate the next Flyway versions after listing the directory.
- [ ] Persist both capability bits with safe defaults.
- [ ] Accept and watermark `UPSERT_DEVICE`-compatible device events without
      changing the existing four event operation names.
- [ ] Mirror `WEATHER_STATION_ZONES_REPLACED` with exact-version conflict
      handling.
- [ ] Keep edge-confirmed values separate from desired state.
- [ ] Run focused migration, capability, applier, ownership, watermark, and
      bootstrap tests.
- [ ] Commit: `feat(sync): mirror protected device state`.

## Task 6: Produce durable device desired state

**Server files:**

- New `DeviceMutationService` and tests
- Device and irrigation-zone controllers and tests
- Desired-state service/repository tests
- Response mapper and DTO tests

- [ ] Write failing tests proving no canonical mirror write occurs when a
      command is queued.
- [ ] Authorize through selected gateway membership and resource scope.
- [ ] Queue full `UPSERT_DEVICE` aggregates for rename, primary assignment,
      unassignment, flags, depths, Chameleon depths, and STREGA model metadata.
- [ ] Queue protected unclaim separately.
- [ ] Serialize safe edits per device; never coalesce unclaim.
- [ ] Preserve legacy command fallback without pre-writing the mirror.
- [ ] Reconcile ACK and returning device events; cover conflict, rejection,
      expiry, replay, and retry.
- [ ] Return desired aggregate plus operation from mutation endpoints.
- [ ] Commit: `feat: protect device mutations`.

## Task 7: Produce S2120 assignment desired state

**Server files:**

- Weather-station assignment entity/repository/service
- Device controller and tests
- Desired-state tests

- [ ] Add failing tests for sorted UUID payloads, authorization of every zone,
      wrong gateway, stale base, and no canonical pre-write.
- [ ] Queue `REPLACE_WEATHER_STATION_ZONES` only for capable gateways.
- [ ] Return a capability conflict for legacy gateways instead of changing
      the server junction table.
- [ ] Overlay desired assignments in reads and settle them only after ACK and
      mirror convergence.
- [ ] Commit: `feat: protect weather station assignments`.

## Task 8: Close six-family cloud UI parity

**Server frontend files:**

- Device types and API normalization/tests
- Device registry and dashboard tests
- New LoRain card and tests
- Existing device cards where pending state is displayed
- Maintained locale files

- [ ] Write failing tests showing unassigned Clover and LoRain devices render.
- [ ] Register Clover with the Kiwi presentation and only its supported
      controls.
- [ ] Add a LoRain rain-gauge card with interval-rain semantics and no
      soil-sensor controls.
- [ ] Keep UC512 out of the supported registry.
- [ ] Overlay pending device fields and assignments in API normalization.
- [ ] Show pending/conflict/rejected notices on affected device cards.
- [ ] Keep physical configuration action status separate from canonical
      desired values.
- [ ] Test family-specific control visibility for all six supported types.
- [ ] Run focused tests, `npx tsc --noEmit`, full unit tests, locale parsing,
      and the production build.
- [ ] Commit: `feat: complete supported device parity`.

## Task 9: Audit existing hardware configuration commands

**Both repositories:**

- Existing device configuration controller tests
- Edge command registry, safety tests, and route tests
- Cloud device card action tests

- [ ] Map every cloud configuration action to its canonical edge route and
      command type.
- [ ] Confirm configuration commands are durable and timed physical actions
      retain short expiry.
- [ ] Confirm effect keys distinguish config versions and intentional timed
      actions.
- [ ] Reject caller-controlled payload hex, FPort, gateway EUI, or device
      family mismatch.
- [ ] Verify LSN50, Kiwi, and STREGA bounds match on both sides.
- [ ] Confirm unsupported families never render the control.
- [ ] Keep Chameleon refresh and dendrometer calibration edge-local.
- [ ] Add only tests or narrow fixes needed by the audit.
- [ ] Commit each repository only if its code changes.

## Task 10: Activate and verify row 3

- [ ] Vendor the six staged edge contract files into OSI Server and pass the
      byte-identity gates.
- [ ] Run focused edge and server consumers before activation.
- [ ] Move `UPSERT_DEVICE`, `WEATHER_STATION_ZONES_REPLACED`, and
      `REPLACE_WEATHER_STATION_ZONES` out of staging.
- [ ] Set both capability axes true only after both directions pass.
- [ ] Re-vendor activated bytes and rerun vendor tests.
- [ ] Run the complete edge sync/schema/profile/scoped-access gates.
- [ ] Run the complete server backend and frontend suites after memory
      preflight.
- [ ] Self-review authority, effect families, expiry, type validation, bound
      SQL, legacy behavior, profile parity, and staged files.
- [ ] Mark matrix row 3 `parity` only after assignment, unassignment, flags,
      depths, weather assignments, unclaim, hardware actions, conflict, replay,
      authorization, legacy fallback, and six-family UI evidence are green.
- [ ] Update the matrix and execution report, run anti-slop and
      `git diff --check`, commit, push, and verify both remote SHAs.

Do not start Task 8 row 4 until every row-3 commit is pushed and both
integration worktrees are clean.
