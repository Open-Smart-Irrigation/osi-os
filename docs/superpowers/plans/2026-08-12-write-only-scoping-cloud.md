# Write-Only Scoping — Cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every cloud read account-wide for an enabled gateway member, keep every write gated on role plus owned ∪ granted zone scope, and give the zone card a two-path add-device affordance (assign an unassigned device, or register a new device straight into the zone).

**Architecture:** One scope resolver (`GatewayScopeService`) answers the owned ∪ granted question; `ZoneGatewayAccess` becomes a thin projection over it. A new `GatewayReadAccessService` is the single membership hub every widened read calls, so the disabled-account check (P1) has exactly one implementation. Read paths ask "is this actor an enabled member of the resource's gateway?"; write paths keep asking "is this zone in the actor's write scope?". Non-member gateways (flag-off: Silvan, kaba100, Uganda) fall back to today's ownership checks unchanged.

**Tech Stack:** Java/Spring Boot, JUnit, Flyway/Postgres, React+TypeScript frontend, vitest.

Implements the cloud half of [2026-08-12-write-only-scoping-device-add-design.md](../specs/2026-08-12-write-only-scoping-device-add-design.md), sections 3, 5 (P1, P2, P7–P10), 8, the cloud items of 9, and 10. The edge half is a separate plan.

**All implementation-task file paths in this plan are relative to the CLOUD checkout** `/home/phil/Repos/osi-server/.worktrees/agrolink` (branch `feat/journal-cloud-primary`). This plan file itself lives in the edge repo because plans for both repos live there.

No Flyway migration is required: `gateway_user_mirrors`, `user_zone_assignment_mirrors`, `user_plot_assignment_mirrors` and `linked_gateway_accounts` already carry everything this rework reads.

## Global Constraints

- All work happens in `/home/phil/Repos/osi-server/.worktrees/agrolink`. Never edit the main osi-server checkout.
- Backend tests: `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test`. Testcontainers ITs need `api.version=1.44` in `~/.docker-java.properties` (already present on this workstation); run `./gradlew --stop` after any Docker or environment change.
- Frontend unit tests: `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`. Never run bare `npx vitest run`, because `test:unit` runs both the `tsx --test` fence suite under `frontend/tests/` and the vitest suite under `frontend/src/`, and the fence suite catches locale and token regressions vitest cannot see. A single-file `npx vitest run --environment jsdom src/<path>` is allowed for iteration only, never as a pass gate.
- Never run two frontend builds concurrently, because this workstation OOMs (swap is zram, no disk fallback).
- Do NOT touch `EdgeOwnershipService`, the sync appliers (`ScopedAccessUserApplier`, `ScopedAccessZoneAssignmentApplier`, `ScopedAccessPlotAssignmentApplier`), or `EdgeSyncService`. The ownership-bootstrap gap is a separate work item.
- P1 is non-negotiable: every widened read still resolves membership, and a disabled membership (`gateway_user_mirrors.disabled_at IS NOT NULL`) is denied. A read that skips `GatewayReadAccessService` is a defect regardless of test colour.
- Lockstep: this plan merges and deploys together with the edge plan (spec W8). Do not merge alone.
- Each task commits separately, in the cloud worktree.

### Cross-repo contract (must match the edge plan)

`POST /api/v1/devices/register` accepts an optional numeric `zoneId` (the cloud zone id, matching `/api/v1/irrigation-zones/{zoneId}` paths). The `REGISTER_DEVICE` gateway command payload carries the resolved zone as **`zoneUuid`**, not `zone_id`. Spec P9 writes "`REGISTER_DEVICE` carries `zone_id`"; the cloud cannot know an edge-local integer id, and every existing cloud→edge zone command (`ASSIGN_DEVICE_TO_ZONE`, `REMOVE_DEVICE_FROM_ZONE`, `UPSERT_DEVICE`) already keys zones by `zoneUuid`. The edge plan's `REGISTER_DEVICE` applier must read `zoneUuid`. Reconcile this before either half merges.

### Must-preserve ledger (spec §5): where each row is enforced

| # | Boundary | Enforced by | Task |
|---|---|---|---|
| P1 | Disabled accounts denied on every read | `GatewayReadAccessService.isMember` → `GatewayScopeService.tryResolve` → `disabled_at` check | T4, asserted again in T5–T9 |
| P2 | Admin-only reads unchanged | `HistoryService.ownedGateway`, `ScopedAccessController.requireAdmin` untouched | T7 negative test |
| P3 | Workspaces stay `user_id = ?` | `HistoryService` workspace methods untouched | T7 negative test |
| P4 | Actuation dual-gate | `DeviceMutationService.authorizePhysicalCommand` untouched | T15 sweep |
| P7 | Assign precondition + 409 | `IrrigationZoneController.assignDevice` | T11 |
| P8 | Honest conflicts | 409 body names the current zone; registration denials are 403 | T10, T11 |
| P9 | Registration gate is role/mutation, not `claimedBy` | `DeviceController.registerDevice` | T10 |
| P10 | One scope resolver | `ZoneGatewayAccessAdapter` delegates to `GatewayScopeService` | T1, T2 |

P5, P6 and P11 are edge-side rows with no cloud counterpart.

---

## Task 1: Non-throwing `GatewayScopeService.tryResolve`

`GatewayScopeService` is about to become the only resolver, and `ZoneGatewayAccess.tryResolve` must keep its transaction-poisoning guarantee. The catch has to live inside `GatewayScopeService`'s own `@Transactional` method: catching one level up is too late, because the throwing method's proxy has already marked the participating transaction rollback-only (see the Javadoc on `ZoneGatewayAccess.tryResolve` and `DeviceMutationService.listSharedWeatherDevices`).

**Files**
- Modify: `backend/src/main/java/org/osi/server/scopedaccess/GatewayScopeService.java`
- Modify: `backend/src/test/java/org/osi/server/scopedaccess/GatewayScopeServiceTest.java`

**Interfaces**
- Produces: `@Transactional(readOnly = true) public Optional<GatewayScope> tryResolve(User cloudUser, String gatewayDeviceEui)`
- Produces (unchanged signature, body moved): `@Transactional(readOnly = true) public GatewayScope resolve(User cloudUser, String gatewayDeviceEui)`
- Consumes existing private state: `linkedAccountRepository`, `userMirrorRepository`, `zoneAssignmentRepository`, `plotAssignmentRepository`, `zoneRepository`, `deviceRepository`, `jdbc`

**Steps**
- [ ] Add to `GatewayScopeServiceTest`: `tryResolveReturnsScopeOnSuccess()` (stubs a researcher membership, asserts `service.tryResolve(cloudUser, GATEWAY_A)` is present and its `role()` is `RESEARCHER`) and `tryResolveReturnsEmptyInsteadOfThrowingOnDisabledMembership()` (reuses the `link(GATEWAY_A, "admin", Instant.parse("2026-07-23T12:00:00Z"))` helper, asserts `service.tryResolve(cloudUser, GATEWAY_A)` is empty and that no exception escapes).
- [ ] Add `tryResolveReturnsEmptyWhenGatewayIsNotLinked()`: no `linkedAccountRepository` stub for `GATEWAY_B`, assert empty.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.scopedaccess.GatewayScopeServiceTest"`. Expected failure: compilation error, `cannot find symbol: method tryResolve(User,String)`.
- [ ] Rename the current `resolve` body to `private GatewayScope doResolve(User cloudUser, String gatewayDeviceEui)` (drop its `@Transactional`).
- [ ] Add `resolve` as `@Transactional(readOnly = true)` delegating to `doResolve`.
- [ ] Add `tryResolve` as `@Transactional(readOnly = true)` wrapping `doResolve` in `try { return Optional.of(doResolve(...)); } catch (ResponseStatusException denied) { return Optional.empty(); }`. Copy the transaction-boundary rationale from `ZoneGatewayAccess.tryResolve`'s Javadoc onto this method, adapted to name `GatewayScopeService`.
- [ ] Run the same gradle command. Expect BUILD SUCCESSFUL.
- [ ] Run `./gradlew test --tests "org.osi.server.journal.*" --tests "org.osi.server.scopedaccess.*"`. Expect BUILD SUCCESSFUL (no journal caller changed).
- [ ] Commit: `git add -A && git commit -m "feat(scope): add non-throwing GatewayScopeService.tryResolve"`

---

## Task 2: Collapse the two resolvers (P10)

`GatewayScopeService` and `JdbcZoneGatewayAccess` run two near-identical queries for the same owned ∪ granted answer. Delete the second one and project the first. Pure refactor: no status code, no scope answer changes.

**Files**
- Create: `backend/src/main/java/org/osi/server/zone/ZoneGatewayAccessAdapter.java`
- Delete: `backend/src/main/java/org/osi/server/zone/JdbcZoneGatewayAccess.java`
- Create: `backend/src/test/java/org/osi/server/zone/ZoneGatewayAccessAdapterTest.java`
- Delete: `backend/src/test/java/org/osi/server/zone/JdbcZoneGatewayAccessTest.java`

**Interfaces**
- Consumes: `GatewayScopeService.resolve(User, String)`, `GatewayScopeService.tryResolve(User, String)`
- Produces: `@Service public class ZoneGatewayAccessAdapter implements ZoneGatewayAccess`
  - `@Override public ZoneGatewayAccess.Access resolve(User actor, String gatewayDeviceEui)`
  - `@Override public Optional<ZoneGatewayAccess.Access> tryResolve(User actor, String gatewayDeviceEui)`
  - `private static ZoneGatewayAccess.Access project(GatewayScope scope)` → `new Access(scope.gateway(), scope.localUserUuid(), scope.canMutate(), union of scope.ownedZoneUuids() and scope.grantedZoneUuids())`
- Unchanged: the `ZoneGatewayAccess` interface and its `Access` record; every injection site (`DeviceMutationService`, `ZoneMutationService`, `WeatherStationZoneMutationService`, `HistoryService`) injects by interface type and needs no edit.

**Steps**
- [ ] Write `ZoneGatewayAccessAdapterTest` with `@Mock GatewayScopeService scopeService` and these cases, ported one-for-one from `JdbcZoneGatewayAccessTest` so the behavioural assertions are identical: owned + granted zones are both readable and a foreign zone is not (the case at `JdbcZoneGatewayAccessTest.java:70-88`); `adminReadIsScopedToOwnedAndGrantedNotAllZones` (`:88-108`), ported under the name `adminScopeIsOwnedAndGrantedNotAllZones` since Task 3 renames the predicate it exercises; `viewerMembershipIsReadOnly` — `requireMutation()` throws with `403`; `tryResolveReturnsAccessWithoutThrowingOnSuccess`; `tryResolveReturnsEmptyInsteadOfThrowingOnDenial` (stub `scopeService.tryResolve` → `Optional.empty()`, assert the adapter returns empty and throws nothing); `resolvePropagatesDenialStatus` (stub `scopeService.resolve` → throws `ResponseStatusException(FORBIDDEN, ...)`, assert it propagates).
- [ ] Build `GatewayScope` fixtures in the test with the full 10-arg canonical constructor: `new GatewayScope(gateway, LOCAL_USER, GatewayScope.Role.RESEARCHER, Set.of("owned-zone"), Set.of("granted-zone"), Set.of(), Set.of(), false, null, null)`.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.zone.ZoneGatewayAccessAdapterTest"`. Expected failure: `cannot find symbol: class ZoneGatewayAccessAdapter`.
- [ ] Write `ZoneGatewayAccessAdapter` per the Interfaces block. Use `@RequiredArgsConstructor`. Do not add `@Transactional` to `tryResolve`, because `GatewayScopeService.tryResolve` already owns the boundary; add a one-line comment saying so and pointing at Task 1.
- [ ] Delete `JdbcZoneGatewayAccess.java` and `JdbcZoneGatewayAccessTest.java`.
- [ ] Run `./gradlew test --tests "org.osi.server.zone.ZoneGatewayAccessAdapterTest"`. Expect BUILD SUCCESSFUL.
- [ ] Run the full backend suite: `./gradlew test`. Expect BUILD SUCCESSFUL, with `DeviceMutationServiceTransactionIT` green, which is the regression net for the rollback-only hazard.
- [ ] Commit: `git add -A && git commit -m "refactor(scope): collapse JdbcZoneGatewayAccess into GatewayScopeService (P10)"`

---

## Task 3: Rename the write-scope predicates

`canReadZone` currently gates writes. The name is why the cloud grew a read patchwork around it, and after Task 5 onwards it would be actively wrong. Rename now, before any semantics move. Thrown statuses stay exactly as they are so the six mutation tests asserting `404` stay green.

**Files**
- Modify: `backend/src/main/java/org/osi/server/scopedaccess/GatewayScope.java`
- Modify: `backend/src/main/java/org/osi/server/zone/ZoneGatewayAccess.java`
- Modify: `backend/src/main/java/org/osi/server/zone/ZoneMutationService.java` (lines 280, 307, 321, 358)
- Modify: `backend/src/main/java/org/osi/server/device/DeviceMutationService.java` (lines 77, 188, 512)
- Modify: `backend/src/main/java/org/osi/server/device/WeatherStationZoneMutationService.java` (lines 140, 199)
- Modify: `backend/src/main/java/org/osi/server/history/HistoryService.java` (line 723)
- Modify: `backend/src/main/java/org/osi/server/journal/JournalAccessService.java` (`requireJournalPlot`, lines 185-192)
- Modify: `backend/src/test/java/org/osi/server/scopedaccess/GatewayScopeServiceTest.java`, `backend/src/test/java/org/osi/server/zone/ZoneGatewayAccessAdapterTest.java`, plus any other test the grep below finds

**Interfaces**
- `GatewayScope`: `canReadZone` → `canWriteZone(String zoneUuid)`; `requireZone` → `requireWriteZone(String zoneUuid)` (still throws `404 "Zone not found"`); `canReadPlot` → `canWritePlot(String plotUuid)`; `requirePlot` → `requireWritePlot(String plotUuid)` (still `404 "Plot not found"`)
- `ZoneGatewayAccess.Access`: `canReadZone` → `canWriteZone(String zoneUuid)`; `requireZone` → `requireWriteZone(String zoneUuid)` (still `404 "Zone not found"`); the record component `readableZoneUuids` → `writableZoneUuids`
- Unchanged: `canMutate()`, `requireMutation()`, `isAdmin()`, `requireAdmin()`, `mutationAllowed()`

**Steps**
- [ ] Run `grep -rn "canReadZone\|requireZone(\|canReadPlot\|requirePlot(\|readableZoneUuids" backend/src` and record every hit; that is the edit list. `HistoryService.requireZoneCard` is a different method; do not rename it.
- [ ] Rename the four methods on `GatewayScope` and the two on `ZoneGatewayAccess.Access`, plus the `Access` record component.
- [ ] Rewrite the Javadoc on `GatewayScope.canWriteZone` (currently `GatewayScope.java:41-43`) and `ZoneGatewayAccess.Access.canWriteZone` (currently `ZoneGatewayAccess.java:42-44`). Both assert the now-obsolete contract "admin is NOT a read-all bypass, it reads owned + granted like every role". Replace with: writes are owned ∪ granted for every role including admin; reads are account-wide and do not consult this method (spec W1).
- [ ] Update the class Javadoc on `GatewayScope.isAdmin()` usage sites if any comment still describes read scoping.
- [ ] Update every production call site from the grep list.
- [ ] Update `JournalAccessService.requireJournalPlot` to call `scope.canWritePlot(plotUuid)` instead of the inline `ownedPlotUuids().contains(...) || grantedPlotUuids().contains(...)`.
- [ ] Update the test call sites the grep found. Assertion values do not change, only method names.
- [ ] Rename `GatewayScopeServiceTest.adminZoneAndPlotReadIsScopedToOwnedAndGrantedNotGlobal` (`:130-166`) to `adminWriteScopeIsOwnedAndGrantedNotGlobal` and rewrite its inline comments, which still describe read scoping. Its assertions are correct as write-scope assertions and keep their values (spec §9 lists this test as one to invert; the inversion is that it now pins writes, not reads).
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test`. Expect BUILD SUCCESSFUL. If `ScheduleMutationServiceTest:228`, `WeatherStationZoneMutationServiceTest:151`, `DeviceMutationServiceTest:184`, `ZoneMutationServiceTest:246`, `IrrigationCalibrationMutationServiceTest:250` or `JournalAccessServiceTest` go red, a status changed. Revert it; this task is a rename only.
- [ ] Commit: `git add -A && git commit -m "refactor(scope): rename read predicates to write predicates"`

---

## Task 4: `GatewayReadAccessService`, the membership hub (P1)

Every widened read needs the same question answered: is this actor an enabled, edge-confirmed member of this gateway? One service answers it, so P1 has one implementation to audit.

**Files**
- Create: `backend/src/main/java/org/osi/server/scopedaccess/GatewayReadAccessService.java`
- Create: `backend/src/test/java/org/osi/server/scopedaccess/GatewayReadAccessServiceTest.java`

**Interfaces**
- Consumes: `GatewayScopeService.tryResolve(User, String)`, `LinkedGatewayAccountRepository.findByUserIdOrderByGatewayDeviceEuiAsc(Long userId)`
- Produces:
  - `public boolean isMember(User user, String gatewayDeviceEui)` — false for null/blank EUI, null user, unlinked gateway, unconfirmed membership, disabled membership. Never throws.
  - `public void requireMember(User user, String gatewayDeviceEui)` — throws `ResponseStatusException(HttpStatus.FORBIDDEN, "Gateway membership is required")` when `isMember` is false.
  - `public Set<String> memberGatewayEuis(User user)` — uppercase EUIs of every linked gateway where `isMember` holds, iteration-ordered; empty set for a null user.

**Steps**
- [ ] Write `GatewayReadAccessServiceTest` with `@Mock GatewayScopeService scopeService` and `@Mock LinkedGatewayAccountRepository linkedAccountRepository`: `memberOfLinkedGatewayIsAllowed()`; `disabledMembershipIsNotAMember()` (stub `tryResolve` → empty, assert `isMember` false and `requireMember` throws with `403`); `unlinkedGatewayIsNotAMember()`; `blankGatewayEuiIsNotAMember()` (assert no interaction with `scopeService`); `memberGatewayEuisSkipsDeniedGatewaysWithoutThrowing()` (two linked accounts, one `tryResolve` present and one empty, assert the returned set holds only the first and nothing throws).
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.scopedaccess.GatewayReadAccessServiceTest"`. Expected failure: `cannot find symbol: class GatewayReadAccessService`.
- [ ] Write the service with `@Service @RequiredArgsConstructor`. Normalize EUIs with `value.trim().toUpperCase(Locale.ROOT)`. Do not annotate the class `@Transactional`; `tryResolve` owns its boundary, and `memberGatewayEuis` must stay safe to call inside another request's transaction. Carry a short comment saying that, referencing Task 1.
- [ ] Run the same gradle command. Expect BUILD SUCCESSFUL.
- [ ] Commit: `git add -A && git commit -m "feat(scope): add GatewayReadAccessService membership hub (P1)"`

---

## Task 5: Zone reads widen to gateway membership

`GET /api/v1/irrigation-zones` returns owned zones plus zones granted through `user_zone_assignment_mirrors`; a member with no grant sees nothing. `GET /{zoneId}/environment-summary` is owner-only and 403s every granted researcher.

**Files**
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZoneService.java`
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java` (lines 82-97, 1691-1715)
- Modify: `backend/src/main/java/org/osi/server/zone/ZoneMutationService.java` (delete `readableZones`, lines 284-308; rename `findAccessible` → `findWritable`, line 266)
- Modify: `backend/src/test/java/org/osi/server/zone/IrrigationZoneControllerSyncTest.java` (lines 205-236)
- Create: `backend/src/test/java/org/osi/server/zone/IrrigationZoneServiceReadScopeTest.java`

**Interfaces**
- Produces `IrrigationZoneService.readableZones(User actor)` → `List<IrrigationZone>`: every non-deleted zone on every gateway in `gatewayReadAccess.memberGatewayEuis(actor)`, deduplicated by `zoneUuid`, ordered by gateway EUI then zone id
- Consumes: `GatewayReadAccessService.memberGatewayEuis(User)`, `IrrigationZoneRepository.findByGatewayDeviceEuiAndDeletedAtIsNull(String)`
- Produces `IrrigationZoneController.readableZone(User user, Long zoneId)` → `IrrigationZone` or null: owned, or on a gateway where `gatewayReadAccess.isMember` holds
- Renamed: `IrrigationZoneController.accessibleZone` → `writableZone` (same body, calls `zoneMutationService.findWritable`); `ZoneMutationService.findAccessible` → `findWritable`
- Deleted: both `ZoneMutationService.readableZones` overloads

**Steps**
- [ ] Write `IrrigationZoneServiceReadScopeTest`: `readableZonesReturnsEveryZoneOnMemberGateways()`: two gateways, actor a member of one, assert only that gateway's zones come back and that a zone owned by another user on the member gateway IS included; `readableZonesIsEmptyForNonMember()`; `readableZonesDeduplicatesByZoneUuid()`.
- [ ] Add to `IrrigationZoneControllerSyncTest` a case `getAllReturnsUngrantedZoneOnMemberGateway()` modelled on `getAllIncludesGrantedGatewayZone` (`:205-236`) but stubbing `zoneService.readableZones(researcher)` with a zone the researcher neither owns nor is granted, asserting `200` and the zone in the body.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.zone.IrrigationZoneServiceReadScopeTest" --tests "org.osi.server.zone.IrrigationZoneControllerSyncTest"`. Expected failure: `cannot find symbol: method readableZones(User)` on `IrrigationZoneService`.
- [ ] Add `private final GatewayReadAccessService gatewayReadAccess;` to `IrrigationZoneService` (it already uses `@RequiredArgsConstructor`) and implement `readableZones`.
- [ ] In `IrrigationZoneController.getAll`, replace `zoneMutationService.readableZones(user)` with `zoneService.readableZones(user)`. Keep the owned-zones merge and the pending-create synthesis block (lines 139-158) untouched.
- [ ] Add `private final GatewayReadAccessService gatewayReadAccess;` to `IrrigationZoneController`. Note that this class mixes constructor injection with `@Autowired` fields; follow the existing `@Autowired` field style used for `deviceMutationService`.
- [ ] Add `readableZone(User, Long)` and point `getEnvironmentSummary` (line 1696) at it instead of `ownedZone`.
- [ ] Rename `accessibleZone` → `writableZone` and `ZoneMutationService.findAccessible` → `findWritable`; update all five call sites (lines 168, 265, 398, 522, 731; all writes: PUT schedule, POST calibration, DELETE zone, PUT config, PUT location).
- [ ] Delete both `ZoneMutationService.readableZones` methods and any import left unused.
- [ ] Update `IrrigationZoneControllerSyncTest:205-236` to stub `zoneService.readableZones` instead of `zoneMutationService.readableZones`, and rename the case to `getAllIncludesZoneOnMemberGateway`.
- [ ] Run `./gradlew test --tests "org.osi.server.zone.*"`. Expect BUILD SUCCESSFUL.
- [ ] Commit: `git add -A && git commit -m "feat(zones): widen zone list and environment-summary reads to gateway membership"`

---

## Task 6: Device reads widen to gateway membership

`GET /api/v1/devices` returns devices claimed by the caller plus weather stations on member gateways. A freshly registered device has no claim row for a granted researcher and no zone, so it is invisible. That is the trigger bug. The weather-station carve-outs (`canReadSharedWeatherDevice`, `listSharedWeatherDevices`) exist only to punch holes in that filter and go away with it.

**Files**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java` (lines 60-77, 254, 268, 392-405, 1138, 1184, 1219, 1575-1580)
- Modify: `backend/src/main/java/org/osi/server/device/DeviceService.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceMutationService.java` (delete `canReadSharedWeatherDevice` lines 193-226 and `listSharedWeatherDevices` lines 228-280)
- Modify: `backend/src/test/java/org/osi/server/device/DeviceMutationServiceTransactionIT.java`
- Create: `backend/src/test/java/org/osi/server/device/DeviceControllerReadScopeTest.java`

**Interfaces**
- Produces `DeviceService.listOnGateways(Set<String> gatewayEuis)` → `List<Device>`: every non-deleted device whose `gateway_device_eui` matches, deduplicated by `deviceEui`
- Consumes: `DeviceRepository.findByGatewayDeviceEuiAndDeletedAtIsNull(String)`
- Changed: `DeviceController.canReadDevice(User user, Device device)` → true when the caller claimed the device, or when `gatewayReadAccess.isMember(user, gatewayEui)` for the device's gateway EUI (falling back to `device.getIrrigationZone().getGatewayDeviceEui()` when the device row carries none)
- Deleted: `DeviceMutationService.canReadSharedWeatherDevice`, `DeviceMutationService.listSharedWeatherDevices`
- Untouched: `DeviceType.isWeatherSharedRead` (still used elsewhere), `authorizePhysicalCommand` (P4), `upsert`/`assign`/`unassign`/`unclaim`

**Steps**
- [ ] Write `DeviceControllerReadScopeTest` with mocked collaborators: `deviceListIncludesUnassignedDeviceOnMemberGateway()`: a device with a gateway EUI, no zone, claimed by another user, asserted present in `getMyDevices`; `deviceListExcludesDevicesOnNonMemberGateways()`; `deviceListDeduplicatesClaimedAndGatewayDevices()`; `sensorHistoryIsReadableByMemberOfTheDevicesGateway()`: asserts `getSensorHistory(eui, "swt_1", 24, principal)` returns `200` for a non-claiming member; `sensorHistoryIsDeniedForNonMember()`: asserts `403`; `zoneAssignmentsReadableByMember()`: asserts `getWeatherStationZoneAssignments` returns `200` for a member who does not own the S2120.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.device.DeviceControllerReadScopeTest"`. Expected failure: the unassigned-device and non-owner cases fail with an empty list and `403`.
- [ ] Add `DeviceService.listOnGateways(Set<String>)`.
- [ ] Rewrite `DeviceController.getMyDevices` to merge `deviceService.getClaimedByUser(user.getId())` and `deviceService.listOnGateways(gatewayReadAccess.memberGatewayEuis(user))` into a `LinkedHashMap<String, Device>` keyed on `deviceEui`, claimed rows first.
- [ ] Add `private final GatewayReadAccessService gatewayReadAccess;` to `DeviceController`'s final-field list and rewrite `canReadDevice` per the Interfaces block. Replace its C6 Javadoc with a note that reads are account-wide for enabled members (spec W1) and that `claimedBy` remains the fallback for gateways with no membership (flag-off parity).
- [ ] Rewrite `getWeatherStationZoneAssignments` (lines 392-405): `Device device = deviceService.findByEui(deviceEui);` then `if (!canReadDevice(user, device)) return ResponseEntity.status(403).build();` then `return ResponseEntity.ok(weatherStationZoneService.getAssignmentsForDevice(device));`, keeping the existing `IllegalArgumentException` → 404 and `IllegalStateException` → 409 catches. Drop the `weatherStationZoneService.findOwnedS2120` call.
- [ ] Delete `canReadSharedWeatherDevice` and `listSharedWeatherDevices` from `DeviceMutationService`, and the `deviceRepository` field if nothing else uses it.
- [ ] Read `DeviceMutationServiceTransactionIT` and retarget it: its intent is that a denial inside a per-gateway loop must not poison the request's persistence context and must not throw `LazyInitializationException` when a lazily-loaded `irrigationZone` is read afterwards. Point it at `GatewayReadAccessService.memberGatewayEuis` plus `DeviceController.getMyDevices`. Move the long rollback-only Javadoc from the deleted `listSharedWeatherDevices` onto `GatewayReadAccessService.memberGatewayEuis`.
- [ ] Run `./gradlew test --tests "org.osi.server.device.*"`. Expect BUILD SUCCESSFUL including the IT.
- [ ] Commit: `git add -A && git commit -m "feat(devices): widen device list and device reads to gateway membership"`

---

## Task 7: Zone history reads widen; gateway history and workspaces stay

`HistoryService.ownedZone` allows owner or granted-zone member. A member with no grant gets `403`. Gateway-wide history (`ownedGateway`) and workspaces stay exactly as they are (P2 and P3).

**Files**
- Modify: `backend/src/main/java/org/osi/server/history/HistoryService.java` (lines 681-727)
- Modify: `backend/src/test/java/org/osi/server/history/HistoryServiceTest.java` (lines 655-712)

**Interfaces**
- Changed `private IrrigationZone ownedZone(User user, Long zoneId)` → `private IrrigationZone readableZone(User user, Long zoneId)`: 404 when missing, 403 when soft-deleted, otherwise allowed when the zone is owned or `gatewayReadAccess.isMember(user, zone.getGatewayDeviceEui())`
- Deleted: `private boolean canReadZoneViaScope(User, String, String)` (lines 704-727) and the `zoneGatewayAccess` field if no other method uses it
- Added `private final GatewayReadAccessService gatewayReadAccess;`: this class has hand-written constructors for older tests; add the dependency to every constructor and default it to null in the legacy ones, matching how `linkedGatewayAccountRepository` and `zoneGatewayAccess` are already handled, and treat null as "not a member"
- Untouched: `ownedGateway` (lines 735-748), `requireGatewayCard`, every workspace method

**Steps**
- [ ] In `HistoryServiceTest`, rename `nonGrantedMemberCannotReadZoneHistoryOnScopedGateway` (`:688-712`) to `memberWithoutZoneGrantReadsZoneHistory` and invert it: stub membership present, assert `service.getZoneCards(outsider, 11L)` returns `200` with `zoneId() == 11L`. Replace the `zoneGatewayAccess.resolve` stub with a `gatewayReadAccess.isMember` stub returning true.
- [ ] Broaden `grantedResearcherReadsGrantedZoneHistoryOnScopedGateway` (`:655-687`) to `memberReadsZoneHistoryOnScopedGateway` and drop its zone-grant stub — membership alone must suffice.
- [ ] Add `nonMemberCannotReadZoneHistory()`: `isMember` false, no ownership, expect `403`.
- [ ] Add `gatewayHistoryStaysOwnerOnlyForMembers()` (P2): a member of the gateway who does not own the gateway device gets `403` from `getGatewayCards`.
- [ ] Add `workspaceReadStaysUserScoped()` (P3): asserting the workspace query still filters on the requesting user id; model it on whichever workspace test already exists in this file.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.history.HistoryServiceTest"`. Expected failure: the inverted case fails with `403` where `200` is asserted.
- [ ] Implement `readableZone`, delete `canReadZoneViaScope`, rename all internal call sites (`requireZoneCard` and any other caller of `ownedZone`).
- [ ] Run the same gradle command, then `./gradlew test --tests "org.osi.server.history.*"`. Expect BUILD SUCCESSFUL.
- [ ] Commit: `git add -A && git commit -m "feat(history): widen zone history reads to gateway membership; keep gateway history owner-only"`

---

## Task 8: Prediction and Terra endpoints split into reads and writes

All 14 zone-scoped endpoints on `PredictionController` route through `ownedZone`, which 403s anyone but the zone owner. Reads become membership-wide; writes get the same write-scope gate the other mutation services use.

**Files**
- Modify: `backend/src/main/java/org/osi/server/prediction/PredictionController.java`
- Create: `backend/src/test/java/org/osi/server/prediction/PredictionControllerScopeTest.java`

**Interfaces**
- Consumes: `GatewayReadAccessService.isMember(User, String)`, `ZoneGatewayAccess.resolve(User, String)` → `Access.mutationAllowed()`, `Access.canWriteZone(String)`
- Produces `private IrrigationZone readableZone(Long zoneId, UserDetails userDetails)`: 403 when the zone is missing, soft-deleted, or the caller neither owns it nor is a member of its gateway
- Produces `private IrrigationZone writableZone(Long zoneId, UserDetails userDetails)`: starts from `readableZone`; when the caller does not own the zone, requires `access.mutationAllowed()` and `access.canWriteZone(zone.getZoneUuid())`, else 403
- Deleted: `private IrrigationZone ownedZone(Long, UserDetails)`

**Steps**
- [ ] Write `PredictionControllerScopeTest`: `memberReadsForeignZonePredictionSummary()` → `200`; `nonMemberIsDeniedPredictionSummary()` → `403`; `grantedResearcherWritesPredictionConfig()` → `200`; `memberWithoutZoneGrantCannotWritePredictionConfig()` → `403`; `viewerCannotRecomputePrediction()` → `403`; `ownerKeepsFullAccessOnFlagOffGateway()`: no membership stubbed, owner reads and writes both succeed.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.prediction.PredictionControllerScopeTest"`. Expected failure: the member-read and granted-write cases fail with `403`.
- [ ] Add `private final GatewayReadAccessService gatewayReadAccess;` and `private final ZoneGatewayAccess zoneGatewayAccess;` to the `@RequiredArgsConstructor` field list.
- [ ] Implement `readableZone` and `writableZone`; delete `ownedZone`.
- [ ] Point the 9 read endpoints at `readableZone`: `getPredictionConfig` (line 46), `getPredictionSummary` (61), `getPredictionTrajectory` (69), `getPredictionComparison` (76), `getPredictionRun` (83), `getSoilProfile` (97), `getFieldGeometry` (111), `getSensorAnchors` (126), `getPredictionFieldState` (141).
- [ ] Point the 5 write endpoints at `writableZone`: `putPredictionConfig` (54), `recomputePrediction` (90), `refreshSoilProfile` (104), `putFieldGeometry` (119), `putSensorAnchors` (134).
- [ ] Leave `getCatalog` (line 36-40) as-is; it takes no zone.
- [ ] Run the same gradle command, then `./gradlew test --tests "org.osi.server.prediction.*"`. Expect BUILD SUCCESSFUL.
- [ ] Commit: `git add -A && git commit -m "feat(prediction): membership reads and write-scope writes on zone-scoped endpoints"`

---

## Task 9: Journal reads go account-wide; journal writes keep plot scope (W2)

`JournalQueryService.scopedQuery` filters every read by `owner_user_uuid = ? OR plot_uuid IN (…)` and redacts plot-group members. W2 removes read privacy. The same query service also backs `JournalAccessService.authorizeMutation`, so the write path needs its own scope-restricted lookup or the write gate widens by accident.

**Files**
- Modify: `backend/src/main/java/org/osi/server/journal/JournalQueryService.java`
- Modify: `backend/src/main/java/org/osi/server/journal/JournalAccessService.java` (lines 80-82, 173-175)
- Modify: `backend/src/test/java/org/osi/server/journal/JournalQueryServiceTest.java` (lines 100-131)

**Interfaces**
- Produces: `public enum Visibility { ACCOUNT_WIDE, WRITE_SCOPE }` on `JournalQueryService`
- Changed `public List<Map<String, Object>> list(JournalResourceKind kind, GatewayScope scope, boolean includeDeleted)`: now `ACCOUNT_WIDE`, no member redaction
- Changed `public Optional<Map<String, Object>> find(JournalResourceKind kind, GatewayScope scope, String resourceId)`: now `ACCOUNT_WIDE`
- Produces `public Optional<Map<String, Object>> findWithinWriteScope(JournalResourceKind kind, GatewayScope scope, String resourceId)`: `WRITE_SCOPE`, the exact predicate `find` uses today
- Changed `private Query scopedQuery(Table table, GatewayScope scope, Visibility visibility, boolean includeDeleted, String resourceId)`: the `redactGroupMembers` parameter is deleted
- Deleted `private String scopedProjection(...)`: the projection is always `aggregate_json::text`
- Changed `private String visibilityPredicate(Table table, GatewayScope scope, Visibility visibility, Set<String> writablePlots, List<Object> params)`: returns `""` for `ACCOUNT_WIDE` on `ENTRY`, `PLOT` and `PLOT_GROUP`; keeps `owner_user_uuid = ?` for `CUSTOM_VOCAB` in both modes
- Changed: `JournalAccessService.authorizeMutation` and `resolveReferencedPlotOwner` call `findWithinWriteScope` instead of `find`
- Unchanged: `exists(...)`, `JournalAccessService.require(...)`, `requireJournalPlot`, the C9 plot-group ownership gate, every `JournalController` route

`CUSTOM_VOCAB` stays owner-only in both modes. It is a personal vocabulary, not journal data, the same category as history workspaces under P3. W2 names entries, notes, photos and exports; it does not name vocabularies. Flag this in the rollout walkthrough if the maintainer wants it widened too.

**Steps**
- [ ] In `JournalQueryServiceTest`, rewrite `researcherCannotReadForeignUngrantedResources` (`:117-131`) as `researcherReadsForeignUngrantedResourcesAccountWide`: same zero-grant scope, now asserting `list(PLOT, …)`, `list(ENTRY, …)` and `list(PLOT_GROUP, …)` are non-empty and that `find(PLOT, scope, FOREIGN_PLOT)` is present.
- [ ] Add `customVocabStaysOwnerScoped()`: zero-grant scope, assert `list(CUSTOM_VOCAB, scope, false)` excludes another user's vocabulary row.
- [ ] Add `findWithinWriteScopeStillHidesForeignUngrantedResources()`: the assertions the old test made, now against `findWithinWriteScope`.
- [ ] Adapt `scopedFindKeepsAllGroupMembersForMutationAuthorization` (`:100-116`) to call `findWithinWriteScope`, and add `listReturnsAllPlotGroupMembersWithoutRedaction()` for the read path.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.journal.JournalQueryServiceTest"`. Expected failure: the account-wide list assertions fail with empty results, and `findWithinWriteScope` does not compile.
- [ ] Implement the `Visibility` enum, the new `findWithinWriteScope`, the `scopedQuery` signature change, the `visibilityPredicate` change, and delete `scopedProjection` plus the `redactGroupMembers` plumbing.
- [ ] Switch `JournalAccessService.authorizeMutation` (line 82) and `resolveReferencedPlotOwner` (line 174) to `findWithinWriteScope`.
- [ ] Run `./gradlew test --tests "org.osi.server.journal.*"`. Expect BUILD SUCCESSFUL, and `JournalAccessServiceTest`, `JournalControllerTest` and `JournalControllerCatalogWebMvcTest` must all stay green, which is the proof the write gates did not move.
- [ ] Commit: `git add -A && git commit -m "feat(journal): account-wide journal reads, write scope preserved (W2)"`

---

## Task 10: Registration re-gated on membership, with an optional target zone (P9, W3, W5)

`POST /api/v1/devices/register` requires the caller to have personally claimed a gateway (`deviceService.getGatewaysForUser`), so a granted researcher gets `409` with no explanation. Re-gate on membership plus mutation role, and accept an optional target zone.

**Files**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java` (lines 1241-1284, record at 1458-1464)
- Modify: `backend/src/main/java/org/osi/server/device/DeviceService.java`
- Create: `backend/src/test/java/org/osi/server/device/DeviceRegistrationScopeTest.java`

**Interfaces**
- Changed: `public record RegisterDeviceRequest(@NotBlank String deviceEui, @NotBlank String deviceType, @NotBlank String name, String appKey, String gatewayDeviceEui, Long zoneId)`
- Produces `DeviceService.findGatewayByEui(String gatewayDeviceEui)` → `Optional<Device>`: non-deleted, type `GATEWAY`, EUI trimmed and uppercased
- Produces `private List<Device> registrationGateways(User user)` on `DeviceController`: personally claimed gateways merged with `gatewayReadAccess.memberGatewayEuis(user)` resolved through `findGatewayByEui`, deduplicated by uppercase EUI, claimed first
- Consumes: `ZoneGatewayAccess.resolve(User, String)` → `mutationAllowed()`, `canWriteZone(String)`; `IrrigationZoneRepository.findById(Long)`; `CommandService.issueGatewayCommand(Device, String, Map<String,Object>, User, String, String, Long, String)`
- Produces: `REGISTER_DEVICE` params gain `zoneUuid` (see the cross-repo contract block) when `zoneId` resolves

**Gate order** (each denial is its own status, P8):
1. No candidate gateway at all → `409` (unchanged).
2. `gatewayDeviceEui` given but not a candidate → `409` (unchanged).
3. Target gateway has a membership for this user and `!access.mutationAllowed()` → `403`. A gateway with no membership (flag-off) keeps today's claimed-gateway behaviour.
4. `zoneId` given: zone missing, soft-deleted, or on a different gateway → `403`. Zone on a scoped gateway not in `access.canWriteZone` → `403`. Zone on a flag-off gateway not owned by the caller → `403`.
5. `zoneId` absent → register unassigned, any write role (W3).

**Steps**
- [ ] Write `DeviceRegistrationScopeTest`: `researcherOnMemberGatewayRegistersWithoutClaimingIt()` → `201` and one `REGISTER_DEVICE` command captured; `viewerCannotRegister()` → `403`; `registrationWithoutZoneIdLeavesDeviceUnassigned()` → command params contain no `zoneUuid`; `registrationWithGrantedZoneIdCarriesZoneUuid()` → captured params contain `zoneUuid` equal to the zone's UUID; `registrationWithOutOfScopeZoneIdIsForbidden()` → `403` and no command issued; `registrationWithZoneOnAnotherGatewayIsForbidden()` → `403`; `ownerOnFlagOffGatewayStillRegisters()` → `201` with no membership stubbed. Capture commands with `ArgumentCaptor<Map<String, Object>>` on `commandService.issueGatewayCommand`.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.device.DeviceRegistrationScopeTest"`. Expected failure: `RegisterDeviceRequest` has no `zoneId` component, so the test does not compile.
- [ ] Add `zoneId` to `RegisterDeviceRequest` and `DeviceService.findGatewayByEui`.
- [ ] Add `registrationGateways(User)` to `DeviceController` and replace `deviceService.getGatewaysForUser(user.getId())` at line 1246 with it.
- [ ] Implement the five gate steps above, then `params.put("zoneUuid", zone.getZoneUuid())` when a zone resolved. Leave `deviceService.registerDevice(...)` unchanged — the cloud device row picks up its zone from the edge mirror on the next sync, exactly like `ASSIGN_DEVICE_TO_ZONE` does today. Add a comment saying so.
- [ ] Add `private final IrrigationZoneRepository irrigationZoneRepository;` and `private final ZoneGatewayAccess zoneGatewayAccess;` to `DeviceController` if not already present.
- [ ] Run the same gradle command, then `./gradlew test --tests "org.osi.server.device.*"`. Expect BUILD SUCCESSFUL.
- [ ] Commit: `git add -A && git commit -m "feat(devices): re-gate registration on gateway membership and accept a target zone (P9)"`

---

## Task 11: Zone assign and unassign move to write scope, with the P7 precondition

`PUT /api/v1/irrigation-zones/{zoneId}/devices/{deviceEui}` requires the caller to own the zone AND to have claimed the device. Both are ownership tests standing in for write scope. Assign also silently moves an already-assigned device out of a colleague's zone.

**Files**
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java` (lines 425-514, and delete `ownedZone` at 1701-1706 once unused)
- Create: `backend/src/test/java/org/osi/server/zone/IrrigationZoneDeviceAssignmentScopeTest.java`

**Interfaces**
- Changed: `assignDevice` and `removeDevice` resolve the zone through `writableZone(user, zoneId)` (Task 5) instead of `ownedZone(user.getId(), zoneId)`
- Deleted: the `device.getClaimedBy()` 403 branches at lines 438-440 and 484-486
- Produces: assign returns `409` with body `Map.of("message", …, "current_zone_id", currentZone.getId(), "current_zone_name", currentZone.getName())` when the device is already assigned to a different zone (P7, P8)
- Unchanged: the `gatewayMismatch` 409 with `X-Sync-Error`, the `deviceMutationService.supports` desired-state branch, the legacy `ASSIGN_DEVICE_TO_ZONE` / `REMOVE_DEVICE_FROM_ZONE` command branch, and `removeDevice`'s "assigned to a different zone" 409

The cloud's precondition reads `device.getIrrigationZone()` from the mirror, so it is advisory: the edge's conditional `UPDATE devices … WHERE irrigation_zone_id IS NULL` is the authoritative race-free check (P7, P11, edge plan). Say so in a comment above the check.

**Steps**
- [ ] Write `IrrigationZoneDeviceAssignmentScopeTest`: `grantedResearcherAssignsUnassignedDevice()` → `202`; `memberWithoutZoneGrantCannotAssign()` → `403`; `viewerCannotAssign()` → `403`; `assigningAnAlreadyAssignedDeviceReturnsConflictNamingTheZone()` → `409`, body `current_zone_id` and `current_zone_name` match the holding zone; `reassigningToTheSameZoneIsAccepted()` → `202` (idempotent, not a conflict); `assignmentAcrossGatewaysStillConflicts()` → `409` with the `X-Sync-Error` header; `unassignRequiresZoneWriteScope()` → `403` for a member with no grant; `deviceClaimedByAnotherUserIsAssignableWithinScope()` → `202`.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests "org.osi.server.zone.IrrigationZoneDeviceAssignmentScopeTest"`. Expected failure: the granted-researcher and foreign-claim cases fail with `403`; the already-assigned case returns `202`.
- [ ] Swap `ownedZone` → `writableZone` in both routes and delete the two `claimedBy` 403 branches.
- [ ] Insert the P7 precondition in `assignDevice` after the `gatewayMismatch` check and before the `deviceMutationService.supports` branch, so both the desired-state and legacy-command paths are covered.
- [ ] Delete the now-unused `ownedZone` helper.
- [ ] Run the same gradle command, then `./gradlew test --tests "org.osi.server.zone.*"`. Expect BUILD SUCCESSFUL.
- [ ] Commit: `git add -A && git commit -m "feat(zones): write-scope device assignment with an unassigned precondition (P7, P8)"`

---

## Task 12: Dashboard gates on role, not gateway ownership

`Dashboard.tsx:154-156` computes `canAddDevice` from `canOperateGateway`, which is `canWriteDevices(state) && isDeviceOwner(device, identity)` — the frontend twin of the P9 backend gate. A granted researcher never sees the Add Device item. The bucket loop also shunts weather devices into the unassigned bucket when their zone is not visible; with account-wide reads those branches are dead.

**Files**
- Modify: `frontend/src/pages/Dashboard.tsx` (lines 85-146, 154-156)
- Modify: `frontend/src/contexts/gatewayCapabilities.ts` (review only — see below)
- Modify: `frontend/src/pages/__tests__/Dashboard.gatewayScope.test.tsx`
- Modify: `frontend/src/contexts/__tests__/gatewayCapabilities.test.ts`

**Interfaces**
- Changed `const canAddDevice = canWriteDevices(gatewayScope);`: `canWriteDevices` already returns `true` when `state.gateways.length === 0`, which is the cloud-local branch the old ternary hand-rolled
- Deleted from the bucket loop: the `weatherSharedRead` shunt in the S2120 branch and in the `device.irrigationZoneId` branch; a device whose zone is not in `visibleZoneIds` falls through to `unassigned`
- Unchanged: `visibleOnActiveGateway` filtering (gateway selection in a star topology, not read scoping), `canWriteZones`, `zoneMutationsSupported`, `canWriteDevices`, `weatherRowsReadOnly`, `weatherRowReadOnly`, `isDeviceOwner`, `canOperateGateway` (still correct for hub fan/reboot/unclaim)

`gatewayCapabilities.ts` needs no rework: every export except `visibleOnActiveGateway` already gates mutations only, and `visibleOnActiveGateway` is gateway selection. Confirm this by reading the file and leave it unchanged if it holds.

**Steps**
- [ ] Add to `Dashboard.gatewayScope.test.tsx`: `researcherWithoutGatewayClaimSeesAddDevice()`: scope with `gatewayRole: 'researcher'` and a gateway device claimed by someone else, assert the `DashboardHeader` receives `canAddDevice` true; `viewerDoesNotSeeAddDevice()`: `gatewayRole: 'viewer'`, assert false; `unassignedDeviceOfAnyTypeLandsInTheUnassignedBucket()`: a `DRAGINO_LSN50` with a gateway EUI, no zone, rendered in the unassigned section.
- [ ] Add to `gatewayCapabilities.test.ts`: `canWriteDevicesIsTrueForResearcherRegardlessOfDeviceOwnership()`.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`. Expected failure: the researcher case asserts `true` and receives `false`.
- [ ] Replace the `canAddDevice` expression and delete the two `weatherSharedRead` shunts. Remove the `weatherSharedRead` const if nothing else in the loop uses it.
- [ ] Read `gatewayCapabilities.ts` and confirm no export read-gates; record the confirmation in the commit message body if unchanged.
- [ ] Run `npm run test:unit`. Expect both suites green.
- [ ] Commit: `git add -A && git commit -m "fix(dashboard): gate add-device on write role, not gateway ownership"`

---

## Task 13: Two-tab zone device modal

The zone card's assign flow is a single picker over already-claimed unassigned devices, hand-rolled outside ui-core, with no 409 handling and no test. Rebuild it as the two-tab modal from spec §7: tab one assigns an existing unassigned device, tab two registers a new device straight into the zone.

**Files**
- Modify: `frontend/src/services/api.ts` (`devicesAPI.register`, lines 576-591)
- Modify: `frontend/src/components/farming/AssignDeviceModal.tsx` (full rewrite)
- Create: `frontend/src/components/farming/__tests__/AssignDeviceModal.test.tsx`
- Modify: `frontend/src/services/__tests__/api.deviceParity.test.ts`

**Interfaces**
- Changed `register: async (deviceEui: string, deviceType: string, name: string, appKey?: string, gatewayDeviceEui?: string, zoneId?: number): Promise<Device>`: body gains `...(zoneId != null ? { zoneId } : {})`
- Changed props: `interface AssignDeviceModalProps { isOpen: boolean; onClose: () => void; onDeviceAssigned: () => void; zoneId: number; zoneName: string; availableDevices: Device[]; }` — unchanged shape, so `IrrigationZoneCard`'s existing mount keeps compiling
- Consumes: `irrigationZonesAPI.assignDevice(zoneId, deviceEui)`, `devicesAPI.register(...)`, `devicesAPI.getCatalog()`, `useGateway()`, `canWriteDevices` from `../../contexts/gatewayCapabilities`, `{ Button, FormField, INPUT_CLASS, Modal }` from `../../ui-core`

Build it against `frontend/src/components/farming/CreateZoneModal.tsx` as the ui-core exemplar. The edge builds the same component under the same filename; if the edge lands first, port that file verbatim rather than keeping two designs, because these are mirrored components.

**Behaviour**
- Tab "Assign existing": today's picker over `availableDevices`, plus 409 handling — on `error.response?.status === 409`, show `error.response.data.message` and call `onDeviceAssigned()` so the parent refetches and the stale device drops out of the picker.
- Tab "New device": DevEUI (`/^[0-9A-Fa-f]{16}$/`), type from `devicesAPI.getCatalog()`, name, optional AppKey (`/^[0-9A-Fa-f]{32}$/`), submitting `devicesAPI.register(eui, type, name, appKey, activeGateway?.gatewayDeviceEui, zoneId)`. The zone is fixed and displayed, never selectable.
- Both tabs disable submit while `gatewayScope.loading` or `!canWriteDevices(gatewayScope)`.
- Errors render through ui-core tokens (`var(--error-bg)` / `var(--error-text)`), not `bg-red-50` — `frontend/tests/errorTokenMisuse.test.ts` fails on the current hardcoded classes.

**Steps**
- [ ] Write `AssignDeviceModal.test.tsx` following the `AddDeviceModal.gateway.test.tsx` conventions (`// @vitest-environment jsdom` header, `vi.mock('react-i18next', …)`, `vi.mock('../../../services/api', …)`, `vi.mock('../../../contexts/GatewayContext', () => ({ useGateway: vi.fn() }))`, local `gateway()`/`scope()` builders): `assignTabPostsSelectedDevice()`; `assignTabSurfacesConflictAndRefreshes()`: mock a rejection with `{ response: { status: 409, data: { message: 'Device is already assigned to zone North', current_zone_id: 4, current_zone_name: 'North' } } }`, assert the message renders and `onDeviceAssigned` was called; `newDeviceTabRegistersWithZoneId()`: assert `devicesAPI.register` received the zone id as its sixth argument; `newDeviceTabRejectsMalformedDevEui()`; `viewerCannotSubmitEitherTab()`.
- [ ] Add to `api.deviceParity.test.ts` a case asserting `devicesAPI.register` sends `zoneId` when supplied and omits the key when not.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`. Expected failure: `register` takes five parameters, and `AssignDeviceModal` renders no tabs.
- [ ] Add the `zoneId` parameter to `devicesAPI.register`.
- [ ] Rewrite `AssignDeviceModal.tsx` per the Behaviour block, on `Modal`/`Button`/`FormField`/`INPUT_CLASS`. Remember `Button` defaults to `type="button"`; the submit buttons need `type="submit"`.
- [ ] Run `npm run test:unit`. Expect both suites green — including `frontend/tests/errorTokenMisuse.test.ts`, `modalBackdropDims.test.ts` and `uiCoreTokensAdoption.test.ts`, which the old hand-rolled backdrop and red classes would have tripped.
- [ ] Commit: `git add -A && git commit -m "feat(farming): two-tab zone device modal with 409 handling"`

---

## Task 14: Zone card wiring, header modal, and locale keys

The zone card has two entry points into the modal (header action row and the empty state) and both must open it. The `tsx --test` fence suite fails the build if any of the seven locales lacks a new key.

**Files**
- Modify: `frontend/src/components/farming/IrrigationZoneCard.tsx` (lines 250-255, 520-525, 533-541)
- Modify: `frontend/src/components/farming/AddDeviceModal.tsx`
- Modify: `frontend/src/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json` (confirm the exact directory layout before editing)
- Modify: `frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx`
- Modify: `frontend/tests/addDeviceModalLocales.test.ts`

**Interfaces**
- Unchanged: `IrrigationZoneCardProps`, the `editable = canWrite && mutationsSupported` gate, and the `isOpen={editable && showAssignModal}` mount pattern
- Changed: the header action-row button label moves from `t('zone.assignDevice')` to `t('zone.addDevice')` since the modal now offers both paths; the empty-state button keeps `t('zone.assignFirst')`
- New locale keys under `devices.json`: `assignModal.tabAssign`, `assignModal.tabRegister`, `assignModal.conflictTitle`, `assignModal.registerSubmit`, `assignModal.zoneFixed`, `zone.addDevice`
- `AddDeviceModal` (header flow) keeps registering unassigned — no `zoneId` argument. It is already on ui-core; confirm and leave the behaviour alone.

**Steps**
- [ ] Add to `IrrigationZoneCard.capabilities.test.tsx`: `addDeviceButtonOpensTheTwoTabModal()`: click the header button, assert both tab labels render; `emptyStateButtonOpensTheSameModal()`; `viewerSeesNoAddDeviceButton()`.
- [ ] Extend `frontend/tests/addDeviceModalLocales.test.ts` (or add a sibling fence) to require the six new keys in all seven locales `['de-CH','en','es','fr','it','lg','pt']`.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`. Expected failure: the locale fence lists missing keys for all seven locales, and the card test cannot find the tab labels.
- [ ] Add the six keys to all seven locale files. Translate; do not leave English placeholders. `lg` (Luganda) is the Uganda ship gate — if you cannot produce a real translation, add the key with the English string AND note it in the commit body as a draft awaiting the native pass.
- [ ] Rename the header button label key and confirm both mount points pass `zoneName={zone.name}` and `zoneId={zone.id}`.
- [ ] Confirm `AddDeviceModal` still calls `devicesAPI.register` with five arguments and no zone.
- [ ] Run `npm run test:unit`. Expect both suites green.
- [ ] Commit: `git add -A && git commit -m "feat(farming): wire the two-tab device modal into the zone card"`

---

## Task 15: Full sweep and ledger verification

**Files**
- No production changes. Fix whatever the sweep turns red, in the task that owns it.

**Steps**
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew --stop && ./gradlew test`. Expect BUILD SUCCESSFUL. Testcontainers ITs (`DeviceMutationServiceTransactionIT`, `ScopedAccessMigrationIT`, `IrrigationConfigMigrationIT`) must be green, not skipped — check the report at `backend/build/reports/tests/test/index.html` for skip counts.
- [ ] Run `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`. Expect both suites green.
- [ ] Confirm these suites are green without having been edited, which is what proves the write gates did not move: `DeviceMutationServiceTest`, `ZoneMutationServiceTest`, `ScheduleMutationServiceTest`, `IrrigationCalibrationMutationServiceTest`, `WeatherStationZoneMutationServiceTest`, `ScopedAccessMutationServiceTest`, `ScopedAccessControllerTest`, `JournalAccessServiceTest`, `JournalControllerTest`. Run `git log --stat` over this branch's commits and confirm none of them appear.
- [ ] Grep for stragglers: `grep -rn "canReadZone\|canReadPlot\|listSharedWeatherDevices\|canReadSharedWeatherDevice\|JdbcZoneGatewayAccess\|findAccessible" backend/src frontend/src` must return nothing.
- [ ] Grep for read paths that bypass the hub: `grep -rn "getClaimedByUser\|getZonesByUser" backend/src/main` — every remaining hit must be a write path, an admin path, or the owned-first branch of a widened read. List them in the commit body.
- [ ] Walk the must-preserve ledger table at the top of this plan and name the test that pins each of P1, P2, P3, P4, P7, P8, P9, P10. A row with no named test is unfinished work, not a passing row.
- [ ] Commit: `git add -A && git commit -m "test: full sweep for write-only scoping"`

---

## Rollout (spec §10)

Cloud and edge merge and deploy together. The vendored-contract CI has never run for AgroLink branches, so verification is manual on `agro-link.ch` plus `agrolink-test-01`, with a granted researcher account and a viewer account:

- Device list shows the unassigned LSN50 `A840412D385E7D00` for both accounts.
- Both modal tabs work from the zone card; the register tab lands the device in the zone after the next sync.
- Assigning an already-assigned device returns the 409 naming its current zone.
- A foreign zone's history renders for both accounts; a journal entry from another account is readable.
- The viewer is denied one write per surface (zone config, device flag, assign) and the researcher is denied a write on an ungranted zone.
- Gateway history, `/api/sync/state`, `/api/users` still reject the non-admin accounts (P2).
- Silvan, kaba100 and Uganda behave exactly as before — they have no `gateway_user_mirrors` rows, so every read falls back to ownership.

## Deferred

- Write-scope denials still return `404 "Zone not found"` rather than a `403` naming the reason. P8 argues for the honest status, but six mutation tests pin `404` and the brief keeps mutation tests untouched. Worth a follow-up once the read rework is live.
- `CUSTOM_VOCAB` journal reads stay owner-scoped (Task 9 rationale). Raise it in the rollout walkthrough.
- `GatewayScopeService` now runs two extra queries (plots, and zone entities rather than a projection) on every zone-write authorization, because `ZoneGatewayAccessAdapter` projects the full scope. Measure before optimising.
- The cloud's P7 precondition is advisory; the race-free check is the edge's conditional `UPDATE`. If the cloud ever becomes canonical for assignment, this needs a real conditional write.
