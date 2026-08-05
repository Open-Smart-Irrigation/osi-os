# AgroLink GUI Parity — Slice S2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the cloud device surface to cohesion parity with the edge GUI: the valve card becomes the first GUI consumer of the physical-command authorization shipped 2026-08-04 (actor-carrying `VALVE_COMMAND`/`SET_STREGA_TIMED_ACTION`), scope denials (both the immediate cloud 403 and the edge's asynchronous `scope_denied`/`scope_actor_required` rejections) surface in user-legible form, the deliberate device-LIST narrowing is resolved (shared-read weather devices appear for scoped members, matching edge), device-card write gating becomes fail-closed by construction (`readOnly` required, not defaulted open), and the claiming/registration modal moves onto ui-core with D3 gateway targeting.

**Architecture:** The cloud already ships substantial device implementations (matrix rows verified `partial`): six family cards behind `deviceRegistry.tsx`, a live `stregaAPI`/`devicesAPI` in `services/api.ts`, and a backend `DeviceController` whose physical-command sites (`POST /devices/{eui}/command`, `PUT …/strega/timed-action`) already authorize through `DeviceMutationService.authorizePhysicalCommand()` and embed `actor_user_uuid` so the edge re-enforces zone scope on application. S2 closes what is missing around that core. On the backend: the device LIST endpoint returns claimed rows only (`deviceService.getClaimedByUser`), so the C6 shared-read widening never reaches the list; scoped denials return a bare 403 with no machine-readable body; `CommandRequest` carries no duration, so the cloud cannot issue the edge's `OPEN_FOR_DURATION` pattern; `registerDevice` targets `gateways.get(0)` instead of a caller-chosen gateway. On the frontend: every card destructures `readOnly = false` (fail-open for any future unthreaded mount; S1 had to repair exactly this three times), `PendingStateNotice` prints `rejectionDetail` raw (a scoped user sees the literal string `scope_actor_required`) on a hardcoded light-only palette, the valve card still renders bare OPEN/CLOSE buttons the edge GUI dropped, and two ledgered error-token defects sit in `SenseCapWeatherCard`.

**Tech Stack:** React 18, TypeScript, Tailwind v3.4 (cloud, `presets`), Vite 5, Vitest + `tsx --test` runners, Spring Boot 3 + JUnit 5/Mockito (cloud backend), POSIX `sh` vendor verifiers.

**Working directories (both checkouts are on branch `AgroLink`):**
- Edge (canonical): `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep` — GUI at `web/react-gui/`; S2 modifies only `docs/` here (T10)
- Cloud (vendored): `/home/phil/Repos/osi-server/.worktrees/agrolink` — GUI at `frontend/`, backend at `backend/`
- Never touch `/home/phil/Repos/osi-server/.worktrees/terra-rehaul-*` or `/home/phil/Repos/osi-os/.worktrees/firmware-image-builder`.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md`; every task's requirements implicitly include these.

- S2 scope row: "Devices incl. valve control — First GUI consumer of the physical-command authorization shipped 2026-08-04 (actor-carrying commands); resolves the deliberate device-list narrowing (weather shared-read devices appear in the list for scoped members, matching edge)."
- "The edge stays canonical for farm state. Every cloud mutation rides the existing versioned-command and sync layer; this program adds no new sync surface." S2 adds no new command type: `VALVE_COMMAND`, `SET_STREGA_*` and `REGISTER_DEVICE` already exist on the pending-commands channel, and the edge dispatch already reads `cmd.duration_minutes` from `VALVE_COMMAND` params (`flows.json`, verified 2026-08-05).
- "Gateway context, not gateway chrome: one linked gateway means no selector anywhere; multiple linked gateways are switched on the Settings page" (D3).
- "Capability-gated rendering — A page renders only what the selected gateway's capability handshake advertises; older gateways get an explicit 'not available on this gateway' state, never a broken page" (D4).
- "Fail-closed scope UX ported from edge — The cloud pages adopt the edge `ScopeContext` pattern (deny-while-loading, closed scope on profile-fetch failure) mapped to the cloud's 403-on-dormant convention" (D5).
- "Cohesion beats replication: cloud pages may deviate slightly from the edge design where that produces a more cohesive look across the cloud app … Token and primitive parity (ui-core) still binds; the freedom is at page composition level" (D7).
- "`ui-core` canonical in osi-os, byte-mirrored to osi-server, CI-gated both sides" (D2). The vendor byte-parity gate (`scripts/verify-ui-core-vendor.sh`, both repos) must stay green after every task. S2 changes no ui-core file; if a task ever needs one, it lands canonical-first in osi-os and is re-vendored to osi-server **in the same task**, never split across tasks.
- "Eight primitives, no more" — "A primitive is admitted to `ui-core` only when both GUIs use it; single-sided components stay local." S2 adds **zero** new primitives.
- "This program works on the `AgroLink` branches only and does not modify Terra files; if a slice needs a file Terra also touches, the slice waits."
- "all GUI-parity work lands on the same pair of `AgroLink` branches, keeping the deploy-from-branch model intact".
- Matrix rule: rows may flip toward `parity` "only after a real side-by-side walkthrough against the edge GUI running on `agrolink-test-01`". This plan runs no walkthrough, so every row it touches ends at `partial (pending walkthrough)` with a dated provenance line.
- Spec: "Valve actuation (S2) additionally requires a live test against `agrolink-test-01` with a short `OPEN_FOR_DURATION` before the slice closes; STREGA rules apply (no bare CLOSE)." The test gateway is not yet linked, so the live test is **out of this plan's scope** and rides the walkthrough backfill; S2 ships unit/RTL coverage only, and the matrix rows say so.
- Suite baselines at the S1 heads, re-verified green 2026-08-05 on this machine: edge (`c7342362`) 107 node-runner tests + 1,689 Vitest across 169 files; cloud (`3e6b8ec1`) 62 node-runner tests + 394 Vitest across 95 files. Counts only grow during S2. The final task runs both builds and both vendor verifiers.

Plan-level readings of the spec, applied throughout (each is a resolved ambiguity):

1. **Device-card write authority is role-based, with no capability conjunction.** Physical and device commands (`VALVE_COMMAND`, `SET_STREGA_*`, `REGISTER_DEVICE`, `UNCLAIM`) predate the desired-state overlay and ride the pending-commands channel on every linked gateway, so D4's "not available on this gateway" state does not apply to device cards. That argument is owner-specific: for the owner account every device command works on every gateway generation, so an older gateway is not read-only for its owner. A scoped researcher whose linked gateway is *not* scoped-capable falls to the backend's legacy claimedBy check and is denied; T2 gives that denial the machine-readable `not_device_owner` body and T6 renders it as a translated sentence instead of axios' raw message, so the writable card degrades to a legible refusal, never a broken page. D5 still binds: deny while the gateway context is unresolved, `viewer` grants are read-only. S1's stop-gap threading (`!(writable && mutationsAvailable)`, which borrowed the *zone* capability flag) is replaced by two named helpers: `canWriteDevices` (role gate, T3) and `canOperateGateway` (owner-only gate for the hub card, whose fan/reboot/unclaim endpoints check gateway ownership server-side, so a scoped `researcher` or `admin` would only harvest 403s).
2. **`readOnly` fails closed at compile time.** `DeviceCardProps.readOnly` and the six family cards' props become **required** (no `= false` default). `frontend` runs `tsc` inside `npm run build`, so an unthreaded mount is a build error, which is stricter than a runtime default flip and cannot silently strip a working page. Vitest does not typecheck, so a node guard test additionally bans `readOnly?:`/`readOnly = false` from reappearing in the card sources (T4). Edge cards keep their optional prop: the edge threads `useScope()` at its single dashboard and its suite guards it; flipping the edge is churn with no un-threaded mount to close.
3. **Two denial paths, one vocabulary.** Immediate path: the cloud rejects the HTTP call; S2 standardizes both physical sites on `403 {"error": "scope_denied"}` (today `sendCommand` returns an empty 403 body and the GUI shows axios' "Request failed with status code 403"). Async path: the edge rejects an accepted command, and the ack lands as `rejectionCode: "edge_rejected"` with `rejectionDetail` carrying the edge's bare reason string (`scope_denied` | `scope_actor_required`; `DesiredStateService.observeAck`, verified 2026-08-05). T5 maps both reason strings to legible i18n messages inside `PendingStateNotice`; T6 maps the immediate path inside the valve card.
4. **Valve actuation adopts the edge pattern: `OPEN_FOR_DURATION` only.** The edge card ships a duration input (1–255 min) and no bare OPEN/CLOSE buttons (STREGA valves auto-close; a bare CLOSE is the documented operational hazard). The cloud card's OPEN/CLOSE grid is replaced with the duration control. No cancel button on cloud: the edge's cancel is an edge-local route (`POST /api/valve/{eui}/cancel`), no cloud→edge cancel command type exists, and inventing one is edge `flows.json` work outside this program's edge-change budget — recorded in the matrix as a deviation for the walkthrough.
5. **Weather shared-read list resolution is a backend merge plus device-level scoping.** `GET /api/v1/devices` returns claimed rows ∪ weather-shared-read rows (`SENSECAP_S2120`, `AQUASCOPE_LORAIN`; `DeviceType.WEATHER_SHARED_READ_TYPE_IDS`, which must keep matching the edge scope helper) on gateways where the actor is an enabled, confirmed member (T1). `DeviceResponse` already carries `gatewayDeviceEui`; the frontend `Device` type gains it (T8) so the Dashboard scopes devices by their own gateway EUI instead of only through zone membership. Weather shared-read rows that pass the gateway check are never dropped by the zone-visibility branches: they render into their visible zones when any, else into the unassigned section — so a member without a station's zone grant still sees the station, the realistic C6 case. A device on a non-active gateway is dropped even when zoneless (which also makes S1's "S2120 whose zones are all on other gateways" drop branch redundant for rows carrying `gatewayDeviceEui`), and rows with a null/absent gateway EUI (cloud-local) stay visible, mirroring S1 reading 7. Shared-read rows render `readOnly` for every scoped role — weather writes are owner-only (C6 "only widens reads"), so the affordance matches the authority.
6. **`ClaimGatewayModal` stays orphaned.** It was an admin-era direct-claim flow (mounted once in commit `be7ff428`, unmounted by later Dashboard rewrites); on AgroLink, accounts acquire gateways through the account-linking flow. S2 does not remount or delete it; the matrix records it as dead code for a cleanup sweep.
7. **`DeviceDetail` is cloud-only (D7 single-sided).** The edge has no per-device detail route; its drill-down is in-card `SensorMonitor`/`WindMonitor` overlays. S2 rethemes the page's hardcoded `red-50` error box and `bg-white` date inputs onto tokens (T7) and claims no parity row beyond that.
8. **New strings get 7-locale keys; existing hardcoded English stays.** Every string S2 introduces lands in all 7 locales with a node locale test (`lg` machine-draft pending the human-native gate). The pre-existing hardcoded English inside `SenseCapWeatherCard`/`StregaValveCard`/`AddDeviceModal` bodies (the cloud `devices.json` has no `addModal` namespace at all) is a stale-i18n debt that predates S2, recorded for the i18n follow-up bundle rather than silently expanded: S2 tasks must not add *new* untranslated literals.
9. **Ledgered retheme items.** M3 (`SenseCapWeatherCard.tsx:371` uses `text-[var(--error-bg)]` as a text color — invisible pale-on-pale since the S0 token fix) and the card's pale error border (`:195`, `border-[var(--error-bg)]`) are fixed in T7, which touches that file anyway. The second ledgered pale-border site, cloud `ScheduleSection.tsx:423`, is in no file S2 retheming touches (schedules are S1 territory), so per the ledger's own condition it stays open and is re-recorded in T10.

## Reference: device command surfaces and the denial contract (verified 2026-08-05)

Backend, all in `/home/phil/Repos/osi-server/.worktrees/agrolink/backend/src/main/java/org/osi/server/device/DeviceController.java`:

| Endpoint | Authorization today | Denial body today |
|---|---|---|
| `GET /api/v1/devices` | claimed-only list (`deviceService.getClaimedByUser`) | n/a — this is the S2-resolved narrowing |
| `POST /api/v1/devices/{eui}/command` → `VALVE_COMMAND` | `authorizePhysicalCommand` (scoped) else claimedBy; embeds `actor_user_uuid` | **empty** 403 body (scoped path) |
| `PUT …/strega/timed-action` → `SET_STREGA_TIMED_ACTION` | same as above (F1 twin site); embeds `actor_user_uuid` | 403 `{"error": "Device is not accessible to the current user"}` |
| `PUT …/strega/interval|model|magnet|partial-opening|flushing` | claimedBy only (config, not actuation) | 403 `{"error": "Device is not owned by the current user"}` |
| `POST /api/v1/devices/register` → `REGISTER_DEVICE` | any user with ≥1 claimed gateway; targets `gateways.get(0)` | 409 empty body when no gateway |
| `GET /devices/{eui}`, `…/history`, sensor/status history | `canReadDevice` = claimedBy ∪ `canReadSharedWeatherDevice` (C6) | empty 403 |

Async rejection flow: edge `write-strega-expectation` acks `result: 'REJECTED_PERMANENT', reason: 'scope_denied' | 'scope_actor_required'` → `CommandAckController` → `DesiredStateService.observeAck` stores `status=rejected`, `rejectionCode="edge_rejected"`, `rejectionDetail=<reason>`. Other stored codes: `edge_expired`, `base_version_conflict`. The frontend `normaliseDesiredState` (`services/api.ts:608`) already carries both fields into `DesiredStateOperation`.

Frontend device-card mount points (the complete set — T3/T4 make this the enforced closed list):

| # | Mount | Threads write authority today |
|---|---|---|
| 1 | `frontend/src/pages/Dashboard.tsx` Central-hubs row (`GatewayCard`) | yes (S1: `!(writable && mutationsAvailable)`) |
| 2 | `frontend/src/pages/Dashboard.tsx` unassigned-devices section (`DEVICE_SECTIONS.renderCard`) | yes (S1) |
| 3 | `frontend/src/components/farming/IrrigationZoneCard.tsx:462` devices-in-zone grid (`DEVICE_SECTIONS.renderCard`) | yes (S1: `!editable`) |
| 4 | `frontend/src/components/farming/deviceRegistry.tsx` `renderDeviceCard()` fallback | zero production callers; test-only |

Checked and confirmed card-free: `pages/DeviceDetail.tsx` (info panel + recharts, no card component, no mutation controls), `pages/admin/AdminDevices.tsx` (super-admin table, S5), `pages/JournalPage.tsx` (its `readOnly*` strings are journal gating copy), `components/farming/dendrometer/DendrometerSection.tsx` and both `DendrometerMonitor` variants (read-only analytics), `ClaimGatewayModal` (orphaned, reading 6).

## File map

| File | Repo / area | Task |
|---|---|---|
| `backend/src/main/java/org/osi/server/device/DeviceMutationService.java`, `DeviceController.java` (`getMyDevices`), `DeviceMutationServiceTest.java`, `DeviceControllerTest.java` | osi-server backend | T1 |
| `backend/src/main/java/org/osi/server/device/DeviceController.java` (`CommandRequest`, `sendCommand`, `setStregaTimedAction`, `registerDevice`), `DeviceControllerTest.java` | osi-server backend | T2 |
| `frontend/src/contexts/gatewayCapabilities.ts` + test, `pages/Dashboard.tsx`, `components/farming/IrrigationZoneCard.tsx`, `pages/__tests__/Dashboard.readOnlyPropagation.test.tsx` | osi-server frontend | T3 |
| `frontend/src/components/farming/deviceRegistry.tsx`, six `*Card.tsx`, `tests/deviceCardReadOnlyContract.test.ts`, five existing test files | osi-server frontend | T4 |
| `frontend/src/components/sync/PendingStateNotice.tsx` + test, 7× `public/locales/*/devices.json`, `tests/deviceDenialLocales.test.ts` | osi-server frontend | T5 |
| `frontend/src/components/farming/StregaValveCard.tsx`, `services/api.ts`, `types/farming.ts`, `__tests__/StregaValveCard.actuation.test.tsx`, `pages/__tests__/Dashboard.readOnlyPropagation.test.tsx`, 7× locales | osi-server frontend | T6 |
| `frontend/src/components/farming/SenseCapWeatherCard.tsx`, `pages/DeviceDetail.tsx`, `tests/errorTokenMisuse.test.ts` | osi-server frontend | T7 |
| `frontend/src/types/farming.ts`, `services/api.ts` (`normaliseDevice`), `contexts/gatewayCapabilities.ts` + test, `components/farming/deviceRegistry.tsx`, `components/farming/IrrigationZoneCard.tsx` + three tests, `pages/Dashboard.tsx`, `pages/__tests__/Dashboard.gatewayScope.test.tsx` | osi-server frontend | T8 |
| `frontend/src/components/farming/AddDeviceModal.tsx`, `services/api.ts` (`devicesAPI.register`), `components/DashboardHeader.tsx`, `pages/Dashboard.tsx`, `__tests__/AddDeviceModal.gateway.test.tsx`, 7× locales | osi-server frontend | T9 |
| `docs/superpowers/plans/agrolink-gui-parity-matrix.md` | osi-os | T10 |
| (verification only) | both | T11 |

---

### Task 1: Backend — shared-read weather devices join the device LIST

Resolves the S2 spec row's "deliberate device-list narrowing". C6 widened per-device reads (`canReadDevice`) but `GET /api/v1/devices` still returns `getClaimedByUser` rows only, so a scoped member with no zone grant sees the weather station on the edge GUI and nothing on cloud. The service gains a list twin of `canReadSharedWeatherDevice` reusing the same `ZoneGatewayAccess` membership check; the controller merges and dedupes.

**Files:**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceMutationService.java`, `backend/src/main/java/org/osi/server/device/DeviceController.java`
- Modify (tests): `backend/src/test/java/org/osi/server/device/DeviceMutationServiceTest.java`, `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java`

**Interfaces:**
- Consumes: `LinkedGatewayAccountRepository.findByUserIdOrderByGatewayDeviceEuiAsc`, `DeviceRepository.findByGatewayDeviceEuiAndDeletedAtIsNull`, `ZoneGatewayAccess.resolve`, `DeviceType.isWeatherSharedRead` (all existing).
- Produces: `public List<Device> listSharedWeatherDevices(User actor)` on `DeviceMutationService`; `GET /devices` returns the merged list. `DeviceResponse` already carries `gatewayDeviceEui`, `zoneIds`, `desiredState`; no mapper change.

- [ ] **Step 1: Write the failing service tests**

`DeviceMutationServiceTest` already declares an unused `@Mock private DeviceRepository deviceRepository;` (line 45). Append to the class:

```java
    @Test
    void listSharedWeatherDevices_returnsWeatherRowsOnMemberGateways() {
        // C6 list twin: enabled, confirmed membership is sufficient; no zone
        // grant required; non-weather rows on the same gateway are excluded.
        when(linkedAccountRepository.findByUserIdOrderByGatewayDeviceEuiAsc(7L))
                .thenReturn(List.of(LinkedGatewayAccount.builder()
                        .user(actor)
                        .gatewayDeviceEui(GATEWAY)
                        .localUserUuid(OWNER_UUID)
                        .scopedAccessSyncSupported(true)
                        .build()));
        when(gatewayAccess.resolve(actor, GATEWAY)).thenReturn(new ZoneGatewayAccess.Access(
                gateway, OWNER_UUID, false, Set.of()));
        Device weather = Device.builder()
                .id(21L).deviceEui("S2120AAAA0000001")
                .type(DeviceType.SENSECAP_S2120).gatewayDeviceEui(GATEWAY).build();
        Device valve = Device.builder()
                .id(22L).deviceEui("STREGAAAA0000001")
                .type(DeviceType.STREGA_VALVE).gatewayDeviceEui(GATEWAY).build();
        when(deviceRepository.findByGatewayDeviceEuiAndDeletedAtIsNull(GATEWAY))
                .thenReturn(List.of(weather, valve));

        assertThat(service.listSharedWeatherDevices(actor))
                .containsExactly(weather);
    }

    @Test
    void listSharedWeatherDevices_skipsGatewaysWhereMembershipResolutionFails() {
        when(linkedAccountRepository.findByUserIdOrderByGatewayDeviceEuiAsc(7L))
                .thenReturn(List.of(LinkedGatewayAccount.builder()
                        .user(actor)
                        .gatewayDeviceEui(GATEWAY)
                        .localUserUuid(OWNER_UUID)
                        .build()));
        when(gatewayAccess.resolve(actor, GATEWAY)).thenThrow(
                new org.springframework.web.server.ResponseStatusException(
                        org.springframework.http.HttpStatus.FORBIDDEN));

        assertThat(service.listSharedWeatherDevices(actor)).isEmpty();
        verify(deviceRepository, never()).findByGatewayDeviceEuiAndDeletedAtIsNull(any());
    }

    @Test
    void listSharedWeatherDevices_nullActorReturnsEmpty() {
        assertThat(service.listSharedWeatherDevices(null)).isEmpty();
    }
```

Then wire the mock into the constructor call in `setUp()` (this is also the compile fix for Step 2's new field):

```java
        service = new DeviceMutationService(
                gatewayAccess,
                linkedAccountRepository,
                desiredStateService,
                deviceRepository);
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.device.DeviceMutationServiceTest' 2>&1 | tail -20
```

Expected: compile FAILURE (constructor has three parameters, no `listSharedWeatherDevices`).

- [ ] **Step 2: Implement the service method**

In `DeviceMutationService.java`: add the field after `desiredStateService` (Lombok `@RequiredArgsConstructor` extends the constructor):

```java
    private final DeviceRepository deviceRepository;
```

Add `import java.util.ArrayList;` and `import java.util.List;` to the file's import block, and append after `canReadSharedWeatherDevice`:

```java
    /**
     * C6 list twin (S2): canReadSharedWeatherDevice widened per-device reads,
     * but GET /devices stayed claimed-only, so a scoped member never saw the
     * weather station in the cloud list that the edge GUI shows them.
     * Returns every non-deleted weather-shared-read device on gateways where
     * the actor is an enabled, confirmed member. Reads only — commands and
     * writes are unaffected.
     */
    @Transactional(readOnly = true)
    public List<Device> listSharedWeatherDevices(User actor) {
        if (actor == null || actor.getId() == null) {
            return List.of();
        }
        List<Device> shared = new ArrayList<>();
        for (var account
                : linkedAccountRepository.findByUserIdOrderByGatewayDeviceEuiAsc(actor.getId())) {
            String gatewayEui = normalizedGateway(account.getGatewayDeviceEui());
            try {
                gatewayAccess.resolve(actor, gatewayEui);
            } catch (org.springframework.web.server.ResponseStatusException notAuthorized) {
                continue;
            }
            deviceRepository.findByGatewayDeviceEuiAndDeletedAtIsNull(gatewayEui).stream()
                    .filter(device -> DeviceType.isWeatherSharedRead(device.getType()))
                    .forEach(shared::add);
        }
        return shared;
    }
```

Run the Step 1 command again. Expected: PASS.

- [ ] **Step 3: Write the failing controller test**

Append to `DeviceControllerTest` (reuse the file's existing `userDetails`/`user` fixture idiom — copy the setup lines from `getDevice_scopedMemberWithNoGrantReadsWeatherStationDevice`, line 442):

```java
    @Test
    void getMyDevices_mergesSharedWeatherRowsWithoutDuplicatingClaimedOnes() {
        User user = User.builder().id(7L).build();
        UserDetails userDetails = org.springframework.security.core.userdetails.User
                .withUsername("amina").password("x")
                .authorities(new SimpleGrantedAuthority("ROLE_USER")).build();
        when(userService.findByUsername("amina")).thenReturn(user);

        Device claimedWeather = Device.builder().id(1L)
                .deviceEui("S2120AAAA0000001").type(DeviceType.SENSECAP_S2120).build();
        Device claimedValve = Device.builder().id(2L)
                .deviceEui("STREGAAAA0000001").type(DeviceType.STREGA_VALVE).build();
        Device sharedWeather = Device.builder().id(3L)
                .deviceEui("S2120BBBB0000002").type(DeviceType.SENSECAP_S2120).build();
        when(deviceService.getClaimedByUser(7L))
                .thenReturn(List.of(claimedWeather, claimedValve));
        when(deviceMutationService.listSharedWeatherDevices(user))
                .thenReturn(List.of(claimedWeather, sharedWeather));

        ArgumentCaptor<List<Device>> sent = ArgumentCaptor.forClass((Class) List.class);
        when(deviceResponseMapper.toResponses(sent.capture())).thenReturn(List.of());

        controller.getMyDevices(userDetails);

        assertThat(sent.getValue())
                .containsExactly(claimedWeather, claimedValve, sharedWeather);
    }
```

Run:

```bash
./gradlew test --tests 'org.osi.server.device.DeviceControllerTest' 2>&1 | tail -20
```

Expected: FAIL — the merged list contains only the two claimed rows.

- [ ] **Step 4: Implement the controller merge**

Replace the body of `getMyDevices` in `DeviceController.java` (add imports `java.util.ArrayList`, `java.util.HashSet`, `java.util.Set` as needed):

```java
    @GetMapping("/devices")
    public ResponseEntity<List<DeviceResponse>> getMyDevices(
            @AuthenticationPrincipal UserDetails userDetails) {
        User user = userService.findByUsername(userDetails.getUsername());
        List<Device> devices = new ArrayList<>(deviceService.getClaimedByUser(user.getId()));
        Set<Long> seen = new HashSet<>();
        for (Device device : devices) {
            seen.add(device.getId());
        }
        // S2: shared-read weather rows (C6) join the list so scoped members
        // see the same device inventory as the edge GUI. Reads only.
        for (Device shared : deviceMutationService.listSharedWeatherDevices(user)) {
            if (seen.add(shared.getId())) {
                devices.add(shared);
            }
        }
        return ResponseEntity.ok(deviceResponseMapper.toResponses(devices));
    }
```

- [ ] **Step 5: Run both device test classes**

```bash
./gradlew test --tests 'org.osi.server.device.*' 2>&1 | tail -20
```

Expected: BUILD SUCCESSFUL, no failures anywhere in the device package.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add backend/src/main/java/org/osi/server/device/DeviceMutationService.java backend/src/main/java/org/osi/server/device/DeviceController.java backend/src/test/java/org/osi/server/device/DeviceMutationServiceTest.java backend/src/test/java/org/osi/server/device/DeviceControllerTest.java
git commit -m "feat: device list includes shared-read weather rows for scoped members (S2, C6 list twin)"
```

---

### Task 2: Backend — physical-command contract: duration, machine-readable denials, register targeting

Three request/response gaps the GUI tasks depend on. (a) `CommandRequest` is `{action}` only, so the cloud cannot issue the edge's `OPEN_FOR_DURATION`: the edge dispatch already forwards `cmd.duration_minutes` into its STREGA timed-open path, the cloud just never sends it. (b) The scoped denial on `sendCommand` is an empty 403 and on `setStregaTimedAction` an English sentence; both become `{"error": "scope_denied"}`, and the legacy claimedBy denial gains `{"error": "not_device_owner"}`, so the GUI can map every denial (reading 3). (c) `registerDevice` targets `gateways.get(0)`; with several claimed gateways that is an arbitrary pick, so the request gains an optional `gatewayDeviceEui` validated against the caller's own gateways (D3).

**Files:**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java`
- Modify (tests): `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java`

**Interfaces:**
- Consumes: nothing new.
- Produces (T6/T9 depend on these exact shapes):

```java
public record CommandRequest(@NotBlank String action, Integer durationMinutes) {}
public record RegisterDeviceRequest(
        @NotBlank String deviceEui, @NotBlank String deviceType,
        @NotBlank String name, String appKey, String gatewayDeviceEui) {}
// scoped physical denial, both sites: 403 {"error": "scope_denied"}
// legacy claimedBy denial on sendCommand: 403 {"error": "not_device_owner"}
// every VALVE_COMMAND requires durationMinutes (1–255) and forwards it as
// "duration_minutes" — the edge registry marks VALVE_COMMAND
// requires_duration for all actions, so the boundary rejects what the edge
// would reject asynchronously
```

- [ ] **Step 1: Write the failing controller tests**

Append to `DeviceControllerTest`:

```java
    @Test
    void sendCommand_openForDurationForwardsDurationMinutes() {
        User actor = User.builder().id(7L).username("alice").build();
        Device gateway = Device.builder().deviceEui("GW-1234").type("GATEWAY").claimedBy(actor).build();
        Device valve = Device.builder()
                .id(22L).deviceEui("VALVE-1").type("STREGA_VALVE")
                .claimedBy(actor).gatewayDeviceEui("GW-1234").build();
        UserDetails principal = new org.springframework.security.core.userdetails.User(
                "alice", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        when(userService.findByUsername("alice")).thenReturn(actor);
        when(deviceService.findByEui("VALVE-1")).thenReturn(valve);
        when(deviceService.findAll()).thenReturn(List.of(gateway, valve));
        when(deviceMutationService.authorizePhysicalCommand(actor, valve))
                .thenReturn(new DeviceMutationService.PhysicalCommandAuthorization(false, false, null));
        when(commandService.issueGatewayCommand(
                org.mockito.ArgumentMatchers.eq(gateway),
                org.mockito.ArgumentMatchers.eq("VALVE_COMMAND"),
                org.mockito.ArgumentMatchers.argThat(params ->
                        "OPEN_FOR_DURATION".equals(params.get("action"))
                                && Integer.valueOf(5).equals(params.get("duration_minutes"))),
                org.mockito.ArgumentMatchers.eq(actor),
                org.mockito.ArgumentMatchers.eq("DEVICE"),
                org.mockito.ArgumentMatchers.eq("VALVE-1"),
                org.mockito.ArgumentMatchers.isNull(),
                org.mockito.ArgumentMatchers.anyString())).thenReturn(81L);

        var response = controller.sendCommand("VALVE-1", principal,
                new DeviceController.CommandRequest("OPEN_FOR_DURATION", 5));

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).containsEntry("commandId", 81L);
    }

    @Test
    void sendCommand_openForDurationWithoutDurationIsBadRequest() {
        User actor = User.builder().id(7L).username("alice").build();
        Device valve = Device.builder()
                .id(22L).deviceEui("VALVE-1").type("STREGA_VALVE")
                .claimedBy(actor).gatewayDeviceEui("GW-1234").build();
        UserDetails principal = new org.springframework.security.core.userdetails.User(
                "alice", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        when(userService.findByUsername("alice")).thenReturn(actor);
        when(deviceService.findByEui("VALVE-1")).thenReturn(valve);
        when(deviceMutationService.authorizePhysicalCommand(actor, valve))
                .thenReturn(new DeviceMutationService.PhysicalCommandAuthorization(false, false, null));

        var response = controller.sendCommand("VALVE-1", principal,
                new DeviceController.CommandRequest("OPEN_FOR_DURATION", null));

        assertThat(response.getStatusCode().value()).isEqualTo(400);
        org.mockito.Mockito.verifyNoInteractions(commandService);
    }

    @Test
    void sendCommand_scopedDenialCarriesMachineReadableBody() {
        User claimer = User.builder().id(7L).username("alice").build();
        Device valve = Device.builder()
                .id(22L).deviceEui("VALVE-1").type("STREGA_VALVE")
                .claimedBy(claimer).gatewayDeviceEui("GW-1234").build();
        UserDetails principal = new org.springframework.security.core.userdetails.User(
                "alice", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        when(userService.findByUsername("alice")).thenReturn(claimer);
        when(deviceService.findByEui("VALVE-1")).thenReturn(valve);
        when(deviceMutationService.authorizePhysicalCommand(claimer, valve))
                .thenReturn(new DeviceMutationService.PhysicalCommandAuthorization(true, false, null));

        var response = controller.sendCommand("VALVE-1", principal,
                new DeviceController.CommandRequest("OPEN_FOR_DURATION", 5));

        assertThat(response.getStatusCode().value()).isEqualTo(403);
        assertThat(response.getBody()).isEqualTo(Map.of("error", "scope_denied"));
        org.mockito.Mockito.verifyNoInteractions(commandService);
    }

    @Test
    void sendCommand_legacyNonOwnerDenialCarriesMachineReadableBody() {
        User owner = User.builder().id(7L).username("alice").build();
        User stranger = User.builder().id(9L).username("mallory").build();
        Device valve = Device.builder()
                .id(22L).deviceEui("VALVE-1").type("STREGA_VALVE")
                .claimedBy(owner).gatewayDeviceEui("GW-1234").build();
        UserDetails principal = new org.springframework.security.core.userdetails.User(
                "mallory", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        when(userService.findByUsername("mallory")).thenReturn(stranger);
        when(deviceService.findByEui("VALVE-1")).thenReturn(valve);
        when(deviceMutationService.authorizePhysicalCommand(stranger, valve))
                .thenReturn(new DeviceMutationService.PhysicalCommandAuthorization(false, false, null));

        var response = controller.sendCommand("VALVE-1", principal,
                new DeviceController.CommandRequest("OPEN_FOR_DURATION", 5));

        assertThat(response.getStatusCode().value()).isEqualTo(403);
        assertThat(response.getBody()).isEqualTo(Map.of("error", "not_device_owner"));
        org.mockito.Mockito.verifyNoInteractions(commandService);
    }

    @Test
    void registerDevice_targetsTheRequestedOwnedGateway() {
        User actor = User.builder().id(7L).username("alice").userUuid("user-7").build();
        Device gatewayA = Device.builder().id(10L).deviceEui("GW-AAAA").type("GATEWAY").claimedBy(actor).build();
        Device gatewayB = Device.builder().id(11L).deviceEui("GW-BBBB").type("GATEWAY").claimedBy(actor).build();
        Device device = Device.builder()
                .id(21L).deviceEui("AABBCCDDEEFF0011").name("North Sensor")
                .type("KIWI_SENSOR").claimedBy(actor).syncVersion(3L).build();
        UserDetails principal = new org.springframework.security.core.userdetails.User(
                "alice", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        when(userService.findByUsername("alice")).thenReturn(actor);
        when(deviceService.getGatewaysForUser(7L)).thenReturn(List.of(gatewayA, gatewayB));
        when(deviceService.registerDevice("AABBCCDDEEFF0011", "KIWI_SENSOR", "North Sensor", actor)).thenReturn(device);
        when(deviceResponseMapper.toResponse(device)).thenReturn(
                DeviceController.DeviceResponse.from(device, "PENDING_EDGE_PROVISIONING", true));

        // Lowercase EUI on purpose: the controller must normalize before matching.
        var response = controller.registerDevice(
                new DeviceController.RegisterDeviceRequest(
                        "AABBCCDDEEFF0011", "KIWI_SENSOR", "North Sensor", null, "gw-bbbb"),
                principal);

        assertThat(response.getStatusCode().value()).isEqualTo(201);
        verify(commandService).issueGatewayCommand(
                org.mockito.ArgumentMatchers.eq(gatewayB),
                org.mockito.ArgumentMatchers.eq("REGISTER_DEVICE"),
                org.mockito.ArgumentMatchers.anyMap(),
                org.mockito.ArgumentMatchers.eq(actor),
                org.mockito.ArgumentMatchers.eq("DEVICE"),
                org.mockito.ArgumentMatchers.eq("AABBCCDDEEFF0011"),
                org.mockito.ArgumentMatchers.eq(3L),
                org.mockito.ArgumentMatchers.anyString());
    }

    @Test
    void registerDevice_rejectsGatewayTheCallerDoesNotOwn() {
        User actor = User.builder().id(7L).username("alice").userUuid("user-7").build();
        Device gatewayA = Device.builder().id(10L).deviceEui("GW-AAAA").type("GATEWAY").claimedBy(actor).build();
        UserDetails principal = new org.springframework.security.core.userdetails.User(
                "alice", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        when(userService.findByUsername("alice")).thenReturn(actor);
        when(deviceService.getGatewaysForUser(7L)).thenReturn(List.of(gatewayA));

        var response = controller.registerDevice(
                new DeviceController.RegisterDeviceRequest(
                        "AABBCCDDEEFF0011", "KIWI_SENSOR", "North Sensor", null, "GW-OTHER"),
                principal);

        assertThat(response.getStatusCode().value()).isEqualTo(409);
        verify(deviceService, never()).registerDevice(
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any());
        org.mockito.Mockito.verifyNoInteractions(commandService);
    }
```

(Fixture idiom copied from `sendCommand_queuesGatewayValveCommandForOwnedEdgeBackedDevice` (line 167) and `registerDevice_returnsPendingEdgeProvisioningAndPublishesGatewayCommandWithSyncContext` (line 516): `gatewayForDevice` resolves through the stubbed `deviceService.findAll()`, and the register test leaves `issueGatewayCommand` unstubbed because its return value is unused there.) All five tests must exist and fail (or fail to compile) before Step 2.

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.device.DeviceControllerTest' 2>&1 | tail -20
```

Expected: compile FAILURE (`CommandRequest` has one parameter).

- [ ] **Step 2: Implement**

In `DeviceController.java`:

1. The two records (`CommandRequest` at line 1359, `RegisterDeviceRequest` at 1361) change to the shapes in **Interfaces** above.

2. In `sendCommand`, after the authorization block and before `gatewayForDevice`, validate the action and normalize denials:

```java
        String action = request.action().trim().toUpperCase();
        if (!Set.of("OPEN", "CLOSE", "OPEN_FOR_DURATION").contains(action)) {
            return ResponseEntity.badRequest().body(Map.of("error", "Unsupported valve action"));
        }
        Integer durationMinutes = request.durationMinutes();
        if (durationMinutes == null || durationMinutes < 1 || durationMinutes > 255) {
            // The edge registry marks VALVE_COMMAND requires_duration for
            // every action; rejecting here beats an async edge rejection.
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "Valve commands require durationMinutes between 1 and 255"));
        }
```

   and in the params block, replace `params.put("action", request.action());` with:

```java
        params.put("action", action);
        params.put("duration_minutes", durationMinutes);
```

   The scoped denial (line 185) becomes:

```java
            if (!authorization.authorized()) {
                return ResponseEntity.status(403).body(Map.of("error", "scope_denied"));
            }
```

   (The return type is already `ResponseEntity<Map<String, Object>>`.) The legacy claimedBy denial two lines below drops its bare `.build()` for the same machine-readable treatment:

```java
        } else if (device.getClaimedBy() == null || !device.getClaimedBy().getId().equals(user.getId())) {
            return ResponseEntity.status(403).body(Map.of("error", "not_device_owner"));
        }
```

3. In `setStregaTimedAction`, the scoped denial body (line 849) changes from the English sentence to `Map.of("error", "scope_denied")`. If an existing test pins the old sentence, update that assertion in the same commit.

4. In `registerDevice`, replace the `gateways.get(0)` selection. The resolution runs directly after the empty-list check and **before** `deviceService.registerDevice`, so a request naming a foreign gateway creates no server device row (the last Step 1 test pins this):

```java
        List<Device> gateways = deviceService.getGatewaysForUser(user.getId());
        if (gateways.isEmpty()) {
            return ResponseEntity.status(409).build();
        }
        Device targetGateway = gateways.get(0);
        if (request.gatewayDeviceEui() != null && !request.gatewayDeviceEui().isBlank()) {
            String requested = request.gatewayDeviceEui().trim().toUpperCase();
            targetGateway = gateways.stream()
                    .filter(gw -> requested.equals(
                            String.valueOf(gw.getDeviceEui()).trim().toUpperCase()))
                    .findFirst()
                    .orElse(null);
            if (targetGateway == null) {
                return ResponseEntity.status(409).build();
            }
        }
```

   and pass `targetGateway` (instead of `gateways.get(0)`) to `commandService.issueGatewayCommand`.

- [ ] **Step 3: Run the device package**

```bash
./gradlew test --tests 'org.osi.server.device.*' 2>&1 | tail -20
```

Expected: BUILD SUCCESSFUL. Two mechanical test fallouts from the record changes, fixed in this commit: existing `new CommandRequest("OPEN")` constructions become `new CommandRequest("OPEN", 5)` (the boundary now requires a duration for every valve action; the tests' `argThat` predicates check `action` and keep passing), and existing 4-argument `new RegisterDeviceRequest(…)` constructions gain a trailing `null`. Behavior assertions stay untouched.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add backend/src/main/java/org/osi/server/device/DeviceController.java backend/src/test/java/org/osi/server/device/DeviceControllerTest.java
git commit -m "feat: valve command duration + scope_denied bodies + register gateway targeting (S2)"
```

---
### Task 3: Cloud device-authority helpers and systematic threading

Plan-level reading 1 lands here. Two named helpers join `gatewayCapabilities.ts`; the three production mount points thread them. The behavioral deltas against S1's stop-gap: an owner on a gateway without `zoneDesiredStateSupported` regains device controls (commands ride pending-commands regardless of the zone overlay), and a scoped `researcher`/`admin` **loses** the hub card's fan/reboot/unclaim buttons (which today render and then 403, a fail-open UI).

**Files:**
- Modify: `frontend/src/contexts/gatewayCapabilities.ts`, `frontend/src/contexts/__tests__/gatewayCapabilities.test.ts`, `frontend/src/pages/Dashboard.tsx`, `frontend/src/components/farming/IrrigationZoneCard.tsx`, `frontend/src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx`, `frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx`, `IrrigationZoneCard.removeDevice.test.tsx`, `IrrigationZoneCardData.test.tsx`

**Interfaces:**
- Consumes: `GatewayScopeState` (S1 T4).
- Produces (T4/T6/T8/T9 depend on these exact names):

```ts
export function canWriteDevices(state: GatewayScopeState): boolean;
export function canOperateGateway(state: GatewayScopeState): boolean;
// IrrigationZoneCard: canWrite and mutationsSupported become REQUIRED props
```

- [ ] **Step 1: Extend the helper test (fails first)**

Append to `frontend/src/contexts/__tests__/gatewayCapabilities.test.ts` (reusing its `summary`/`state` fixtures):

```ts
import { canOperateGateway, canWriteDevices } from '../gatewayCapabilities';

describe('canWriteDevices (D5, reading 1)', () => {
  it('denies while unresolved and for viewer grants', () => {
    expect(canWriteDevices(state([], { loading: true }))).toBe(false);
    expect(canWriteDevices(state([], { error: 'linked_gateways_unavailable' }))).toBe(false);
    expect(canWriteDevices(state([summary({ gatewayRole: 'viewer' })]))).toBe(false);
  });
  it('allows owner and researcher regardless of the zone capability flag', () => {
    expect(canWriteDevices(state([summary({ zoneDesiredStateSupported: false })]))).toBe(true);
    expect(canWriteDevices(state([summary({ gatewayRole: 'researcher' })]))).toBe(true);
  });
  it('allows cloud-local accounts with zero linked gateways', () => {
    expect(canWriteDevices(state([]))).toBe(true);
  });
});

describe('canOperateGateway (hub card, owner-only)', () => {
  it('allows only the owner account', () => {
    expect(canOperateGateway(state([summary()]))).toBe(true);
    expect(canOperateGateway(state([summary({ gatewayRole: 'admin' })]))).toBe(false);
    expect(canOperateGateway(state([summary({ gatewayRole: 'researcher' })]))).toBe(false);
    expect(canOperateGateway(state([summary({ gatewayRole: 'viewer' })]))).toBe(false);
  });
  it('denies while unresolved; cloud-local accounts pass', () => {
    expect(canOperateGateway(state([summary()], { loading: true }))).toBe(false);
    expect(canOperateGateway(state([]))).toBe(true);
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/contexts/__tests__/gatewayCapabilities.test.ts
```

Expected: FAIL — the module has no such exports.

- [ ] **Step 2: Implement the helpers**

Append to `frontend/src/contexts/gatewayCapabilities.ts`:

```ts
/**
 * Write authority for device cards (D5): the same fail-closed resolution
 * rules as canWriteZones, and deliberately no capability conjunction —
 * device and physical commands (VALVE_COMMAND, SET_STREGA_*, REGISTER_DEVICE)
 * predate the desired-state overlay and ride pending-commands on every
 * linked gateway, so an older gateway is not read-only for its owner.
 *
 * The body is byte-identical to canWriteZones today; they stay separate
 * because they answer different questions and diverge independently (zones
 * gate on the desired-state capability at the call site, devices do not).
 * The zone card's device grid threads THIS semantic via its canWrite prop.
 */
export function canWriteDevices(state: GatewayScopeState): boolean {
  if (state.loading || state.error !== null) return false;
  if (state.gateways.length === 0) return true;
  if (!state.activeGateway) return false;
  return state.activeGateway.gatewayRole !== 'viewer';
}

/**
 * Gateway hub controls (fan, reboot, unclaim) are owner-only server-side
 * (/gateway-command checks gateway ownership), so every scoped role —
 * researcher and admin included — gets a read-only hub card instead of
 * buttons that can only 403.
 */
export function canOperateGateway(state: GatewayScopeState): boolean {
  if (state.loading || state.error !== null) return false;
  if (state.gateways.length === 0) return true;
  if (!state.activeGateway) return false;
  return state.activeGateway.gatewayRole == null;
}
```

Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Thread the helpers at the three mount points**

In `frontend/src/pages/Dashboard.tsx`:

1. Extend the existing helper import:

```ts
import { canOperateGateway, canWriteDevices, canWriteZones, visibleOnActiveGateway, zoneMutationsSupported } from '../contexts/gatewayCapabilities';
```

2. Next to the existing `writable`/`mutationsAvailable` consts:

```ts
  const deviceWritable = canWriteDevices(gatewayScope);
  const gatewayOperable = canOperateGateway(gatewayScope);
```

3. Central-hubs row: `readOnly={!(writable && mutationsAvailable)}` → `readOnly={!gatewayOperable}`.

4. Unassigned-devices section: `readOnly: !(writable && mutationsAvailable)` → `readOnly: !deviceWritable`.

In `frontend/src/components/farming/IrrigationZoneCard.tsx`:

1. Devices-in-zone grid (line 478): `readOnly: !editable` → `readOnly: !canWrite`. The zone card's own header/schedule/modal gating keeps `editable` (zone mutations do ride the overlay; D4 stays for zones).
2. No fail-open default one level up either: `canWrite?: boolean` / `mutationsSupported?: boolean` become **required** (`canWrite: boolean; mutationsSupported: boolean;`), and the destructuring drops the `= true` defaults. `Dashboard.tsx` already passes both. Test call sites gain explicit values, preserving each test's semantics: `IrrigationZoneCard.capabilities.test.tsx`'s `renderCard` base gets `canWrite={true} mutationsSupported={true}` before its `{...props}` spread; `IrrigationZoneCard.removeDevice.test.tsx` and `IrrigationZoneCardData.test.tsx` add `canWrite mutationsSupported` to their renders. If `tsc` (run in T4's build, and in this task's suite via the capabilities test) reports further sites, fix them the same way.

- [ ] **Step 4: Update the S1 propagation suite to the new semantics**

In `frontend/src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx`, extend rather than weaken: the existing viewer test and default-writable test stay green as-is (viewer denies both helpers; zero-gateway allows both). Add the case S1 could not distinguish:

```tsx
  it('scoped researcher: device cards writable, hub card read-only', async () => {
    vi.mocked(devicesAPI.getAll).mockResolvedValue([gatewayDevice, stregaDevice]);
    const gateways = [gateway('0016C001F11766E7', { gatewayRole: 'researcher' })];
    vi.mocked(useGateway).mockReturnValue({
      loading: false,
      error: null,
      gateways,
      activeGateway: gateways[0],
      hasMultipleGateways: false,
      selectGateway: vi.fn(),
      retry: vi.fn(),
    });

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText('Central Hub')).toBeInTheDocument());
    // Hub controls are owner-only: hidden for the researcher.
    expect(screen.queryByRole('button', { name: 'gateway.unclaim' })).not.toBeInTheDocument();
    // Device actuation is grant-checked server-side; the card stays writable.
    expect(screen.getByRole('button', { name: 'stregaValve.open' })).toBeInTheDocument();
  });
```

(T6 later renames the STREGA open button; it updates this assertion in the same commit that changes the card.)

- [ ] **Step 5: Run the touched suites and the full cloud suite**

```bash
npx vitest run --environment jsdom src/contexts/__tests__/gatewayCapabilities.test.ts src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx src/pages/__tests__/Dashboard.gatewayScope.test.tsx src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx src/components/farming/__tests__/IrrigationZoneCard.removeDevice.test.tsx
npm run test:unit
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/contexts/gatewayCapabilities.ts frontend/src/contexts/__tests__/gatewayCapabilities.test.ts frontend/src/pages/Dashboard.tsx frontend/src/components/farming/IrrigationZoneCard.tsx frontend/src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx frontend/src/components/farming/__tests__/IrrigationZoneCard.removeDevice.test.tsx frontend/src/components/farming/__tests__/IrrigationZoneCardData.test.tsx
git commit -m "feat: device-card authority helpers; role-gated cards, owner-gated hub (S2 D5)"
```

---

### Task 4: `readOnly` becomes a required prop — the compile-time fail-closed flip

Plan-level reading 2. Today every card destructures `readOnly = false`: any future mount that forgets the prop renders writable, which is how S1's C1 fail-open happened. After this task an unthreaded mount is a `tsc` error (`npm run build` runs `tsc && vite build`), and a node guard test keeps the pattern from creeping back in (Vitest transpiles without typechecking and would not catch it).

**Files:**
- Modify: `frontend/src/components/farming/deviceRegistry.tsx`, `KiwiSensorCard.tsx`, `StregaValveCard.tsx`, `DraginoCard.tsx`, `GatewayCard.tsx`, `SenseCapWeatherCard.tsx`, `LoRainCard.tsx`
- Modify (tests): `frontend/src/components/farming/__tests__/deviceRegistry.parity.test.tsx`, `KiwiSensorCard.smoke.test.tsx`, `StregaValveCard.smoke.test.tsx`, `DraginoCard.modeAction.test.tsx`, `LoRainCard.test.tsx`
- Create: `frontend/tests/deviceCardReadOnlyContract.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DeviceCardProps.readOnly: boolean` (required); each card's props interface likewise; `renderDeviceCard`'s `Omit<DeviceCardProps, 'device'>` therefore requires it too.

- [ ] **Step 1: Write the failing guard test**

Create `frontend/tests/deviceCardReadOnlyContract.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const farmingRoot = path.resolve(import.meta.dirname, '../src/components/farming');
const CARD_FILES = [
  'deviceRegistry.tsx',
  'KiwiSensorCard.tsx',
  'StregaValveCard.tsx',
  'DraginoCard.tsx',
  'GatewayCard.tsx',
  'SenseCapWeatherCard.tsx',
  'LoRainCard.tsx',
];

// Reading 2: readOnly must stay a required prop. An optional prop or a
// `= false` default makes any unthreaded future mount silently writable —
// the S1 C1 fail-open class. tsc enforces call sites; this test enforces
// the declarations themselves.
test('device cards declare readOnly as required with no fail-open default', () => {
  for (const file of CARD_FILES) {
    const source = fs.readFileSync(path.join(farmingRoot, file), 'utf8');
    assert.ok(!/readOnly\?\s*:/.test(source), `${file}: optional readOnly?`);
    assert.ok(!/readOnly\s*=\s*false/.test(source), `${file}: readOnly = false default`);
    assert.ok(/readOnly\s*:/.test(source), `${file}: readOnly prop missing entirely`);
  }
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/deviceCardReadOnlyContract.test.ts
```

Expected: FAIL on all seven files.

- [ ] **Step 2: Flip the declarations**

Mechanical, per file:

1. `deviceRegistry.tsx`: `readOnly?: boolean;` → `readOnly: boolean;` in `DeviceCardProps`. The `renderCard` lambdas already forward `readOnly` — unchanged. In the `renderDeviceCard` fallback line, `readOnly={props.readOnly}` already type-checks.
2. Each of the six cards: in the props interface, `readOnly?: boolean` → `readOnly: boolean`; in the destructuring, `readOnly = false` → `readOnly`.

- [ ] **Step 3: Repair the type-broken test call sites**

`npm run build` (Step 4) fails on every card render that omits the prop. The known sites, all mechanical:

| File | Change |
|---|---|
| `__tests__/deviceRegistry.parity.test.tsx:76` | `renderDeviceCard(device(type), {})` → `renderDeviceCard(device(type), { readOnly: false })` |
| `__tests__/KiwiSensorCard.smoke.test.tsx` (three renders) | add `readOnly={false}` |
| `__tests__/StregaValveCard.smoke.test.tsx:57` | add `readOnly={false}` |
| `__tests__/DraginoCard.modeAction.test.tsx:61` | add `readOnly={false}` |
| `__tests__/LoRainCard.test.tsx:45` | add `readOnly={false}` |

If `tsc` reports further sites, fix them the same way — passing `readOnly={false}` preserves each test's existing writable-path semantics. Do not add defaults back.

- [ ] **Step 4: Guard, typecheck-via-build, full suite**

```bash
npx tsx --test tests/deviceCardReadOnlyContract.test.ts
npm run build
npm run test:unit
```

Expected: guard PASS; `tsc` clean (proving every mount in `src/` threads the prop — the enforced closure of the mount-point table above); full suite green.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/farming/deviceRegistry.tsx frontend/src/components/farming/KiwiSensorCard.tsx frontend/src/components/farming/StregaValveCard.tsx frontend/src/components/farming/DraginoCard.tsx frontend/src/components/farming/GatewayCard.tsx frontend/src/components/farming/SenseCapWeatherCard.tsx frontend/src/components/farming/LoRainCard.tsx frontend/tests/deviceCardReadOnlyContract.test.ts frontend/src/components/farming/__tests__/deviceRegistry.parity.test.tsx frontend/src/components/farming/__tests__/KiwiSensorCard.smoke.test.tsx frontend/src/components/farming/__tests__/StregaValveCard.smoke.test.tsx frontend/src/components/farming/__tests__/DraginoCard.modeAction.test.tsx frontend/src/components/farming/__tests__/LoRainCard.test.tsx
git commit -m "feat: readOnly is a required device-card prop; unthreaded mounts fail the build (S2)"
```

---

### Task 5: `PendingStateNotice` — legible rejection reasons on ui-core tokens

Reading 3's async path. Today a scoped user whose valve command the edge rejects reads the literal string `scope_actor_required` under a `border-red-300 bg-red-50` box that ignores the theme. The notice gains a reason map (`scope_denied`, `scope_actor_required` → i18n) with raw-detail fallback for unknown reasons, and its `PRESENTATION` palette moves onto tokens. The component stays cloud-local (S1 reading 8 — one consumer side); every existing consumer (zones, schedules, calibration, devices) inherits both fixes.

**Files:**
- Modify: `frontend/src/components/sync/PendingStateNotice.tsx`, `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json`
- Create: `frontend/src/components/sync/__tests__/PendingStateNotice.rejection.test.tsx`, `frontend/tests/deviceDenialLocales.test.ts`

**Interfaces:**
- Consumes: `DesiredStateOperation.rejectionCode/rejectionDetail` (already normalised).
- Produces: locale keys `devices:desiredState.rejection.scopeDenied` and `devices:desiredState.rejection.scopeActorRequired`; token-based tones.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/components/sync/__tests__/PendingStateNotice.rejection.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesiredStateOperation } from '../../../types/desiredState';
import { PendingStateNotice } from '../PendingStateNotice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function rejected(detail: string | null): DesiredStateOperation {
  return {
    operationUuid: 'op-1',
    status: 'rejected',
    resourceType: 'DEVICE',
    resourceId: 'STREGAAAA0000001',
    commandId: 9,
    commandUuid: 'cmd-1',
    effectKey: null,
    baseSyncVersion: 3,
    targetSyncVersion: 4,
    desired: {},
    canonical: null,
    rejectionCode: 'edge_rejected',
    rejectionDetail: detail,
  };
}

describe('PendingStateNotice rejection surfacing (S2 reading 3)', () => {
  afterEach(cleanup);

  it('maps the edge scope reasons to legible messages', () => {
    render(<PendingStateNotice operation={rejected('scope_denied')} resourceLabel="valve" />);
    expect(screen.getByRole('alert')).toHaveTextContent('desiredState.rejection.scopeDenied');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/scope_denied/);
    cleanup();
    render(<PendingStateNotice operation={rejected('scope_actor_required')} resourceLabel="valve" />);
    expect(screen.getByRole('alert')).toHaveTextContent('desiredState.rejection.scopeActorRequired');
  });

  it('falls back to the raw detail for unknown reasons', () => {
    render(<PendingStateNotice operation={rejected('flash_storage_full')} resourceLabel="valve" />);
    expect(screen.getByRole('alert')).toHaveTextContent('flash_storage_full');
  });

  it('paints the rejected tone from error tokens, not a hardcoded palette', () => {
    render(<PendingStateNotice operation={rejected('scope_denied')} resourceLabel="valve" />);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-[var(--error-bg)]');
    expect(alert.className).not.toContain('bg-red-50');
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/components/sync/__tests__/PendingStateNotice.rejection.test.tsx
```

Expected: FAIL on all three tests.

- [ ] **Step 2: Implement the mapping and the token retheme**

In `frontend/src/components/sync/PendingStateNotice.tsx`:

1. Replace the `PRESENTATION` classes (roles/icons unchanged):

```ts
const PRESENTATION = {
  pending: {
    icon: '↻',
    role: 'status' as const,
    classes: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
  },
  acknowledged: {
    icon: '✓',
    role: 'status' as const,
    classes: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
  },
  conflicted: {
    icon: '!',
    role: 'alert' as const,
    classes: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-text)]',
  },
  rejected: {
    icon: '×',
    role: 'alert' as const,
    classes: 'border-[var(--danger-fg)] bg-[var(--error-bg)] text-[var(--error-text)]',
  },
  expired: {
    icon: '○',
    role: 'alert' as const,
    classes: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)]',
  },
  superseded: {
    icon: '↪',
    role: 'status' as const,
    classes: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)]',
  },
};

// Edge scope-rejection reasons arrive verbatim in rejectionDetail
// (DesiredStateService stores rejectionCode="edge_rejected",
// rejectionDetail=<edge reason>). Known reasons render as translated
// sentences; anything else falls back to the raw detail string.
const REJECTION_REASON_KEYS: Record<string, string> = {
  scope_denied: 'desiredState.rejection.scopeDenied',
  scope_actor_required: 'desiredState.rejection.scopeActorRequired',
};
```

2. Replace the detail paragraph:

```tsx
        {operation.rejectionDetail && (
          <p className="mt-0.5 break-words text-xs opacity-80">
            {(() => {
              const reasonKey = REJECTION_REASON_KEYS[operation.rejectionDetail.trim()];
              return reasonKey ? t(reasonKey) : operation.rejectionDetail;
            })()}
          </p>
        )}
```

3. The proposal box `bg-white/50` → `bg-[var(--surface)]/60` (its `border-current/20` stays), and the retry button's `hover:bg-white/60` → `hover:bg-[var(--surface)]/80`. `pending`/`acknowledged` deliberately sit on `--surface`, not `--card`: the notice mounts inside `--card`-filled card bodies, where a `--card` fill would be invisible.

Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Locale keys + locale test**

Create `frontend/tests/deviceDenialLocales.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];

test('every locale carries the scope-rejection reason keys', () => {
  for (const locale of LOCALES) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/devices.json`), 'utf8'),
    );
    for (const key of ['scopeDenied', 'scopeActorRequired', 'notDeviceOwner']) {
      assert.equal(typeof devices.desiredState?.rejection?.[key], 'string', `${locale} devices.desiredState.rejection.${key}`);
      assert.notEqual(devices.desiredState.rejection[key].trim(), '', `${locale} devices.desiredState.rejection.${key}`);
    }
  }
});
```

Run `npx tsx --test tests/deviceDenialLocales.test.ts` (expected: FAIL). Then add a `rejection` object inside each locale's existing `desiredState` object in `devices.json` (`lg` machine draft pending the human-native gate):

| Locale | rejection.scopeDenied | rejection.scopeActorRequired |
|---|---|---|
| en | The gateway refused this command: your access does not cover this device's zone. | The gateway refused this command: it arrived without an authorized user identity. Sign out and in, then retry. |
| de-CH | Das Gateway hat diesen Befehl abgelehnt: Ihr Zugriff umfasst die Zone dieses Geräts nicht. | Das Gateway hat diesen Befehl abgelehnt: Er kam ohne autorisierte Benutzeridentität an. Melden Sie sich ab und wieder an, dann versuchen Sie es erneut. |
| fr | Le gateway a refusé cette commande : votre accès ne couvre pas la zone de cet appareil. | Le gateway a refusé cette commande : elle est arrivée sans identité d'utilisateur autorisée. Déconnectez-vous puis reconnectez-vous, et réessayez. |
| it | Il gateway ha rifiutato questo comando: il tuo accesso non copre la zona di questo dispositivo. | Il gateway ha rifiutato questo comando: è arrivato senza un'identità utente autorizzata. Esci e rientra, poi riprova. |
| es | El gateway rechazó este comando: tu acceso no cubre la zona de este dispositivo. | El gateway rechazó este comando: llegó sin una identidad de usuario autorizada. Cierra sesión, vuelve a entrar y reintenta. |
| pt | O gateway recusou este comando: o seu acesso não cobre a zona deste dispositivo. | O gateway recusou este comando: chegou sem uma identidade de utilizador autorizada. Termine a sessão, volte a entrar e tente novamente. |
| lg | Gateway yagaanye ekiragiro kino: obuyinza bwo tebutuuka ku kitundu ky'ekyuma kino. | Gateway yagaanye ekiragiro kino: kyatuuse nga tekiriimu ndagamuntu ya mukozesa akkirizibwa. Fuluma, oyingire nate, olyoke ogezeeko nate. |

A third key in the same `rejection` object, `notDeviceOwner`, is consumed only by T6's immediate-403 path (the edge never acks it, so `PendingStateNotice`'s reason map stays two entries):

| Locale | rejection.notDeviceOwner |
|---|---|
| en | Only the account that claimed this device can control it. |
| de-CH | Nur das Konto, das dieses Gerät beansprucht hat, kann es steuern. |
| fr | Seul le compte ayant réclamé cet appareil peut le commander. |
| it | Solo l'account che ha rivendicato questo dispositivo può controllarlo. |
| es | Solo la cuenta que reclamó este dispositivo puede controlarlo. |
| pt | Só a conta que reivindicou este dispositivo o pode controlar. |
| lg | Akawunti eyeddiza ekyuma kino y'yokka esobola okukifuga. |

- [ ] **Step 4: Run the task tests and the cloud suite**

```bash
npx vitest run --environment jsdom src/components/sync/__tests__/PendingStateNotice.rejection.test.tsx src/components/farming/__tests__/ScheduleSection.desiredState.test.tsx
npx tsx --test tests/deviceDenialLocales.test.ts
npm run test:unit
```

Expected: all PASS. If `ScheduleSection.desiredState.test.tsx` pins any of the old palette classes, update those assertions to the token classes in this commit.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/sync/PendingStateNotice.tsx frontend/src/components/sync/__tests__/PendingStateNotice.rejection.test.tsx frontend/tests/deviceDenialLocales.test.ts frontend/public/locales/de-CH/devices.json frontend/public/locales/en/devices.json frontend/public/locales/es/devices.json frontend/public/locales/fr/devices.json frontend/public/locales/it/devices.json frontend/public/locales/lg/devices.json frontend/public/locales/pt/devices.json
git commit -m "feat: PendingStateNotice maps edge scope rejections to legible text on tokens (S2)"
```

---
### Task 6: Cloud `StregaValveCard` — `OPEN_FOR_DURATION` actuation with legible denials

Reading 4 plus reading 3's immediate path. The cloud card's OPEN/CLOSE grid becomes the edge's duration control (1–255 min, no bare CLOSE; STREGA valves auto-close, and the edge GUI dropped these buttons for the same operational reason the fleet rule exists). The 403 bodies from T2 (`scope_denied`, and `not_device_owner` on legacy gateways) render as the translated sentences T5 added, both on the main open action and on the ConfigPanel's timed action. This is the first GUI consumer of the actor-carrying command path end to end: cloud authorizes and embeds `actor_user_uuid`, edge re-enforces, and both denial directions now read as sentences instead of status codes. Unit/RTL coverage only — the live `OPEN_FOR_DURATION` against `agrolink-test-01` stays out of scope until the gateway is linked (walkthrough backfill).

**Files:**
- Modify: `frontend/src/components/farming/StregaValveCard.tsx`, `frontend/src/services/api.ts`, `frontend/src/types/farming.ts`, `frontend/src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx`, `frontend/src/components/farming/__tests__/StregaValveCard.smoke.test.tsx`, `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json`
- Create: `frontend/src/components/farming/__tests__/StregaValveCard.actuation.test.tsx`

**Interfaces:**
- Consumes: T2's request contract; T5's `desiredState.rejection.scopeDenied` key.
- Produces:

```ts
// types/farming.ts
export interface ValveActionRequest {
  action: 'OPEN' | 'CLOSE' | 'OPEN_FOR_DURATION';
  durationMinutes?: number;
}
// services/api.ts — returns the devices-namespace i18n key for a known
// physical-command 403 body, null otherwise
export function physicalCommandDenialKey(error: unknown): string | null;
```

plus locale keys `devices:stregaValve.durationMin`, `stregaValve.openForMinutes`, `stregaValve.invalidOpenDuration` (the denial sentences themselves live under `desiredState.rejection.*`, T5).

- [ ] **Step 1: Write the failing actuation test**

Create `frontend/src/components/farming/__tests__/StregaValveCard.actuation.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '../../../types/farming';
import { devicesAPI } from '../../../services/api';
import { StregaValveCard } from '../StregaValveCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) =>
    opts && 'minutes' in opts ? `${key}:${opts.minutes}` : key }),
}));
vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>();
  return {
    ...actual,
    devicesAPI: { ...actual.devicesAPI, controlValve: vi.fn() },
    stregaAPI: {
      setUplinkInterval: vi.fn(), setModel: vi.fn(), setTimedAction: vi.fn(),
      setMagnetEnabled: vi.fn(), setPartialOpening: vi.fn(), setFlushing: vi.fn(),
    },
  };
});

const device = {
  id: 40,
  deveui: 'A84041AAAA0STRGA',
  deviceEui: 'A84041AAAA0STRGA',
  type: 'STREGA_VALVE',
  name: 'Valve A',
  online: true,
  claimed: true,
  createdAt: '2026-08-01T00:00:00Z',
  currentValveState: 'CLOSED',
  latest_data: {},
} as unknown as Device;

function renderCard(readOnly = false) {
  return render(
    <StregaValveCard device={device} onUpdate={vi.fn()} onRemove={vi.fn()} readOnly={readOnly} />,
  );
}

describe('StregaValveCard duration actuation (S2 readings 3/4)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens for a duration and never offers a bare CLOSE', async () => {
    vi.mocked(devicesAPI.controlValve).mockResolvedValue(undefined);
    renderCard();
    expect(screen.queryByRole('button', { name: 'stregaValve.closed' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('stregaValve.durationMin'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'stregaValve.openForMinutes:7' }));
    await waitFor(() => expect(devicesAPI.controlValve).toHaveBeenCalledWith(
      'A84041AAAA0STRGA',
      { action: 'OPEN_FOR_DURATION', durationMinutes: 7 },
    ));
  });

  it('rejects an out-of-range duration client-side', async () => {
    renderCard();
    fireEvent.change(screen.getByLabelText('stregaValve.durationMin'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'stregaValve.openForMinutes:300' }));
    expect(await screen.findByText('stregaValve.invalidOpenDuration')).toBeInTheDocument();
    expect(devicesAPI.controlValve).not.toHaveBeenCalled();
  });

  it('renders the scope denial as the translated sentence, not a status code', async () => {
    vi.mocked(devicesAPI.controlValve).mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: 'scope_denied' } },
    });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'stregaValve.openForMinutes:5' }));
    expect(await screen.findByText('desiredState.rejection.scopeDenied')).toBeInTheDocument();
  });

  it('renders the legacy owner-only denial legibly too', async () => {
    vi.mocked(devicesAPI.controlValve).mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: 'not_device_owner' } },
    });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'stregaValve.openForMinutes:5' }));
    expect(await screen.findByText('desiredState.rejection.notDeviceOwner')).toBeInTheDocument();
  });

  it('hides all actuation for readOnly', () => {
    renderCard(true);
    expect(screen.queryByLabelText('stregaValve.durationMin')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /openForMinutes/ })).not.toBeInTheDocument();
  });
});
```

(The denial tests build plain objects with `isAxiosError: true`, which `axios.isAxiosError` accepts; if a future axios version tightens the check, set `error.name = 'AxiosError'` in the mocks rather than weakening the helper.)

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/components/farming/__tests__/StregaValveCard.actuation.test.tsx
```

Expected: FAIL — no duration control, no `physicalCommandDenialKey` export.

- [ ] **Step 2: Implement the API/type changes**

In `frontend/src/types/farming.ts`, `ValveActionRequest` (line 435) becomes the shape in **Interfaces**.

In `frontend/src/services/api.ts`, next to `getApiErrorMessage`:

```ts
/**
 * T2 standardized physical-command denials on 403 {"error": <code>}:
 * scope_denied on scoped gateways, not_device_owner on the legacy
 * claimedBy path. Returns the devices-namespace i18n key for a known
 * code (the same sentences the async edge rejection path uses), null
 * for anything else.
 */
const PHYSICAL_DENIAL_KEYS: Record<string, string> = {
  scope_denied: 'desiredState.rejection.scopeDenied',
  not_device_owner: 'desiredState.rejection.notDeviceOwner',
};

export function physicalCommandDenialKey(error: unknown): string | null {
  if (!axios.isAxiosError<ApiErrorPayload>(error) || error.response?.status !== 403) {
    return null;
  }
  const code = (error.response.data as { error?: string } | undefined)?.error;
  return (code && PHYSICAL_DENIAL_KEYS[code]) || null;
}
```

`devicesAPI.controlValve` already posts the whole `action` object; no change needed there beyond the type.

- [ ] **Step 3: Replace the actuation grid in the card**

In `frontend/src/components/farming/StregaValveCard.tsx` (main component, line 617 on):

1. State: `useState<'OPEN' | 'CLOSE' | null>` → `useState<'OPEN' | null>`; add `const [openDurationMin, setOpenDurationMin] = useState('5');`.
2. Replace `handleAction` with:

```tsx
  const handleOpen = async () => {
    const durationMinutes = Number(openDurationMin);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 255) {
      setError(t('stregaValve.invalidOpenDuration'));
      return;
    }
    setLoading('OPEN');
    setError(null);
    try {
      await devicesAPI.controlValve(deveui, { action: 'OPEN_FOR_DURATION', durationMinutes });
      onUpdate();
    } catch (error) {
      const denialKey = physicalCommandDenialKey(error);
      setError(denialKey
        ? t(denialKey)
        : getApiErrorMessage(error, t('stregaValve.failedToOpen')));
    } finally {
      setLoading(null);
    }
  };
```

   and add `physicalCommandDenialKey` to the `services/api` import.

3. Replace the whole `{!readOnly && (<div className="grid grid-cols-2 gap-3"> … </div>)}` OPEN/CLOSE block (lines 767–794) with the edge's duration pattern on the cloud card's own classes (D7 keeps the cloud button treatment):

```tsx
      {!readOnly && (
        <div>
          <label
            htmlFor={`strega-duration-${deveui}`}
            className="text-xs text-[var(--text-secondary)]"
          >
            {t('stregaValve.durationMin')}
          </label>
          <input
            id={`strega-duration-${deveui}`}
            type="number"
            min={1}
            max={255}
            step={1}
            inputMode="numeric"
            value={openDurationMin}
            disabled={loading !== null}
            onChange={(event) => setOpenDurationMin(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          />
          <button
            onClick={handleOpen}
            disabled={loading !== null}
            className="mt-1 w-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--secondary-bg)] disabled:text-[var(--text-disabled)] text-white font-bold text-base py-3 touch-target rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading === 'OPEN' ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                {t('stregaValve.opening')}
              </>
            ) : t('stregaValve.openForMinutes', { minutes: openDurationMin })}
          </button>
        </div>
      )}
```

4. In the `ConfigPanel`'s `applyTimedAction` catch (its timed OPEN is also a physical command under C1/F1), wrap the same way:

```tsx
    } catch (error) {
      const denialKey = physicalCommandDenialKey(error);
      setError(denialKey
        ? t(denialKey)
        : getApiErrorMessage(error, t('stregaValve.failedTimedAction', { defaultValue: 'Failed to queue the timed valve action' })));
    }
```

- [ ] **Step 4: Locale keys**

Add inside each locale's existing `stregaValve` object in `devices.json` (`lg` machine draft pending the human gate):

| Locale | durationMin | openForMinutes | invalidOpenDuration |
|---|---|---|---|
| en | Duration (min) | Open {{minutes}} min | Enter an open duration between 1 and 255 minutes. |
| de-CH | Dauer (Min) | {{minutes}} Min öffnen | Geben Sie eine Öffnungsdauer zwischen 1 und 255 Minuten ein. |
| fr | Durée (min) | Ouvrir {{minutes}} min | Saisissez une durée d'ouverture entre 1 et 255 minutes. |
| it | Durata (min) | Apri {{minutes}} min | Inserisci una durata di apertura tra 1 e 255 minuti. |
| es | Duración (min) | Abrir {{minutes}} min | Introduce una duración de apertura entre 1 y 255 minutos. |
| pt | Duração (min) | Abrir {{minutes}} min | Introduza uma duração de abertura entre 1 e 255 minutos. |
| lg | Obudde (ddakiika) | Ggulawo ddakiika {{minutes}} | Teeka obudde bw'okuggulawo wakati wa ddakiika 1 ne 255. |

Extend `frontend/tests/deviceDenialLocales.test.ts` (T5) with a second test in the same file:

```ts
test('every locale carries the valve duration-actuation keys', () => {
  for (const locale of LOCALES) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/devices.json`), 'utf8'),
    );
    for (const key of ['durationMin', 'openForMinutes', 'invalidOpenDuration']) {
      assert.equal(typeof devices.stregaValve?.[key], 'string', `${locale} devices.stregaValve.${key}`);
      assert.notEqual(devices.stregaValve[key].trim(), '', `${locale} devices.stregaValve.${key}`);
    }
  }
});
```

- [ ] **Step 5: Update the assertions the grid removal breaks**

Two known suites pin the old OPEN/CLOSE buttons; update them in this commit, keeping their intent:

- `frontend/src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx`: `name: 'stregaValve.open'` → `name: /stregaValve\.openForMinutes/`; the `stregaValve.closed`-button assertions become "not present in any session" or are dropped where the read-only case already asserts absence via the duration control (`screen.queryByLabelText('stregaValve.durationMin')`).
- `frontend/src/components/farming/__tests__/StregaValveCard.smoke.test.tsx`: same rename for the open control; any CLOSE-button expectation is deleted (the control no longer exists by design).

If `npm run test:unit` surfaces further pinned assertions, update them the same way — the new contract is: one duration-open control, no bare CLOSE.

- [ ] **Step 6: Run the task tests and the cloud suite**

```bash
npx vitest run --environment jsdom src/components/farming/__tests__/StregaValveCard.actuation.test.tsx src/components/farming/__tests__/StregaValveCard.smoke.test.tsx src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx
npx tsx --test tests/deviceDenialLocales.test.ts
npm run test:unit && npm run build
```

Expected: all PASS; build clean.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/farming/StregaValveCard.tsx frontend/src/services/api.ts frontend/src/types/farming.ts frontend/src/components/farming/__tests__/StregaValveCard.actuation.test.tsx frontend/src/components/farming/__tests__/StregaValveCard.smoke.test.tsx frontend/src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx frontend/tests/deviceDenialLocales.test.ts frontend/public/locales/de-CH/devices.json frontend/public/locales/en/devices.json frontend/public/locales/es/devices.json frontend/public/locales/fr/devices.json frontend/public/locales/it/devices.json frontend/public/locales/lg/devices.json frontend/public/locales/pt/devices.json
git commit -m "feat: valve card opens for a duration; scope denials render legibly (S2)"
```

---

### Task 7: Ledgered error-token fixes — `SenseCapWeatherCard` M3 + pale border, `DeviceDetail` retheme

Reading 9 plus reading 7. Since the S0 token fix made `--error-bg` a pale wash, `text-[var(--error-bg)]` (M3, `SenseCapWeatherCard.tsx:371`) renders zone-editor errors pale-on-pale, and `border-[var(--error-bg)]` (`:195`) draws an invisible border around the card error. `DeviceDetail.tsx` still paints a `red-50` error box and `bg-white` date inputs that ignore the theme. A node guard bans the text-misuse class from returning.

**Files:**
- Modify: `frontend/src/components/farming/SenseCapWeatherCard.tsx`, `frontend/src/pages/DeviceDetail.tsx`
- Create: `frontend/tests/errorTokenMisuse.test.ts`

**Interfaces:** none — class-string changes only.

- [ ] **Step 1: Write the failing guard test**

Create `frontend/tests/errorTokenMisuse.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// M3 defect class: --error-bg is a background wash since the S0 token fix;
// as a TEXT color it renders pale-on-pale. Use --error-text for text.
test('no source file uses text-[var(--error-bg)]', () => {
  const offenders: string[] = [];
  for (const filePath of listSourceFiles(srcRoot)) {
    if (fs.readFileSync(filePath, 'utf8').includes('text-[var(--error-bg)]')) {
      offenders.push(path.relative(srcRoot, filePath));
    }
  }
  assert.deepEqual(offenders, []);
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/errorTokenMisuse.test.ts
```

Expected: FAIL listing `components/farming/SenseCapWeatherCard.tsx`.

- [ ] **Step 2: Fix the three class strings**

In `frontend/src/components/farming/SenseCapWeatherCard.tsx`:

```
- :371  {zoneError && <p className="text-xs text-[var(--error-bg)] mb-2">{zoneError}</p>}
+       {zoneError && <p className="text-xs text-[var(--error-text)] mb-2">{zoneError}</p>}
```

```
- :195  <div className="mb-3 rounded-lg border border-[var(--error-bg)] bg-[var(--error-bg)]/10 px-3 py-2 text-sm text-[var(--error-text)]">
+       <div className="mb-3 rounded-lg border border-[var(--danger-fg)] bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
```

(`--danger-fg` bordering an `--error-bg` wash is the S1 Dashboard error-box pattern.)

In `frontend/src/pages/DeviceDetail.tsx`:

```
- :89   <div className="bg-red-50 border-2 border-red-300 text-red-800 px-6 py-4 rounded-lg">
+       <div className="bg-[var(--error-bg)] border-2 border-[var(--danger-fg)] text-[var(--error-text)] px-6 py-4 rounded-lg">
```

and both `datetime-local` inputs:

```
- className="bg-white border border-[var(--border)] text-[var(--text)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--focus)]"
+ className="bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--focus)]"
```

- [ ] **Step 3: Run the guard and the suite**

```bash
npx tsx --test tests/errorTokenMisuse.test.ts
npm run test:unit
```

Expected: guard PASS; suite green (these strings are pinned by no test).

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/farming/SenseCapWeatherCard.tsx frontend/src/pages/DeviceDetail.tsx frontend/tests/errorTokenMisuse.test.ts
git commit -m "fix: error-token misuse on weather card + DeviceDetail retheme (S2 ledger M3)"
```

---
### Task 8: Dashboard scopes devices by their own gateway EUI; shared-read weather rows render

Reading 5's frontend half. T1 put shared-read weather rows on the wire; without this task the Dashboard still mishandles them: a station with zero zone assignments lands in "unassigned" regardless of gateway, and a zone-assigned station whose zone the member cannot see is dropped entirely. `Device` gains the `gatewayDeviceEui` the response already carries; the grouping memo checks it first (a device on a non-active gateway is dropped even when zoneless, a null-EUI cloud-local row stays visible), and weather shared-read rows that pass the gateway check are exempt from the zone-visibility drops — visible zones when any, else unassigned. Shared-read rows also render `readOnly` for every scoped role, because weather writes (remove, zone assignment) are owner-only; the card affordance then matches the backend authority.

**Files:**
- Modify: `frontend/src/types/farming.ts`, `frontend/src/services/api.ts` (`normaliseDevice`), `frontend/src/contexts/gatewayCapabilities.ts` + `__tests__/gatewayCapabilities.test.ts`, `frontend/src/components/farming/deviceRegistry.tsx`, `frontend/src/components/farming/IrrigationZoneCard.tsx` + its three test files (T3 list), `frontend/src/pages/Dashboard.tsx`, `frontend/src/pages/__tests__/Dashboard.gatewayScope.test.tsx`

**Interfaces:**
- Consumes: `visibleOnActiveGateway` (S1 T4) — already null-safe in exactly the way reading 5 needs.
- Produces:

```ts
// types/farming.ts
Device.gatewayDeviceEui?: string | null;   // normalised, uppercase source value passed through
// deviceRegistry.tsx — mirrors backend DeviceType.WEATHER_SHARED_READ_TYPE_IDS
export const WEATHER_SHARED_READ_TYPES: ReadonlySet<string>;
// gatewayCapabilities.ts
export function weatherRowsReadOnly(state: GatewayScopeState): boolean;
// IrrigationZoneCard: new REQUIRED prop weatherReadOnly: boolean
```

- [ ] **Step 1: Extend the failing page test**

In `frontend/src/pages/__tests__/Dashboard.gatewayScope.test.tsx`, add to the mocked `devicesAPI.getAll` fixture set and append a test (reusing the file's `gateway()` fixture and mock wiring):

```tsx
  it('shows shared-read weather rows on the active gateway and drops other-gateway devices', async () => {
    const gateways = [gateway('EUI-A', { gatewayRole: 'researcher' }), gateway('EUI-B')];
    vi.mocked(useGateway).mockReturnValue({
      loading: false,
      error: null,
      gateways,
      activeGateway: gateways[0],
      hasMultipleGateways: true,
      selectGateway: vi.fn(),
      retry: vi.fn(),
    });
    vi.mocked(devicesAPI.getAll).mockResolvedValue([
      // Shared-read station, no zone assignments, on the active gateway: visible.
      { id: 10, deviceEui: 'S2120-SHARED', name: 'SharedWeather', type: 'SENSECAP_S2120',
        online: true, claimed: true, createdAt: '', gatewayDeviceEui: 'EUI-A' },
      // B2: shared-read station assigned to a zone the member CANNOT see —
      // must render anyway (unassigned section), never be zone-dropped.
      { id: 13, deviceEui: 'S2120-ZONED', name: 'ZonedWeather', type: 'SENSECAP_S2120',
        online: true, claimed: true, createdAt: '', gatewayDeviceEui: 'EUI-A', zone_ids: [99] },
      // Zoneless valve on the OTHER gateway: dropped.
      { id: 11, deviceEui: 'VALVE-B', name: 'OtherValve', type: 'STREGA_VALVE',
        online: true, claimed: true, createdAt: '', gatewayDeviceEui: 'EUI-B' },
      // Cloud-local row without a gateway EUI: stays visible.
      { id: 12, deviceEui: 'KIWI-LOCAL', name: 'LocalKiwi', type: 'KIWI_SENSOR',
        online: true, claimed: true, createdAt: '', gatewayDeviceEui: null },
    ] as any);

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByTestId('device-S2120-SHARED')).toBeInTheDocument());
    expect(screen.getByTestId('device-S2120-ZONED')).toBeInTheDocument();
    expect(screen.getByTestId('device-KIWI-LOCAL')).toBeInTheDocument();
    expect(screen.queryByTestId('device-VALVE-B')).not.toBeInTheDocument();
    // Item 7: shared-read weather rows are read-only for scoped roles,
    // non-weather rows keep the researcher's write affordance.
    expect(screen.getByTestId('device-S2120-SHARED')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByTestId('device-S2120-ZONED')).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByTestId('device-KIWI-LOCAL')).toHaveAttribute('data-readonly', 'false');
  });
```

The file mocks `deviceRegistry` with `DEVICE_SECTIONS: []`; for this test the mock must render identifiable cards instead. Change that mock (top of file) to:

```tsx
vi.mock('../../components/farming/deviceRegistry', () => ({
  DEVICE_SECTIONS: ['KIWI_SENSOR', 'STREGA_VALVE', 'SENSECAP_S2120'].map((type) => ({
    type,
    label: type,
    labelKey: type,
    renderCard: ({ device, readOnly }: any) => (
      <div data-testid={`device-${device.deviceEui}`} data-readonly={String(readOnly)} />
    ),
  })),
  WEATHER_SHARED_READ_TYPES: new Set(['SENSECAP_S2120', 'AQUASCOPE_LORAIN']),
}));
```

(The pre-existing tests in this file keep passing: they assert zone visibility and zone-card props, not device-section internals; re-run and adjust only if one asserted the empty-sections rendering.)

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/pages/__tests__/Dashboard.gatewayScope.test.tsx
```

Expected: the new test FAILS — `VALVE-B` renders (no gateway check) and the shared station renders only accidentally; the dropped-device assertion is the load-bearing failure.

- [ ] **Step 2: Type + normaliser**

In `frontend/src/types/farming.ts`, add to `Device` after `irrigationZoneUuid`:

```ts
  gatewayDeviceEui?: string | null;
```

In `frontend/src/services/api.ts` `normaliseDevice`, add alongside the `zone_ids` mapping in the returned object:

```ts
    gatewayDeviceEui: raw.gatewayDeviceEui ?? raw.gateway_device_eui ?? null,
```

- [ ] **Step 3: Gate the grouping memo on the device's own gateway**

In `frontend/src/components/farming/deviceRegistry.tsx`, export the type set (a comment must point at the backend twin it mirrors):

```ts
/** Mirrors backend DeviceType.WEATHER_SHARED_READ_TYPE_IDS (C6). */
export const WEATHER_SHARED_READ_TYPES: ReadonlySet<string> = new Set([
  'SENSECAP_S2120',
  'AQUASCOPE_LORAIN',
]);
```

In `frontend/src/pages/Dashboard.tsx`, inside the `devicesByZone` memo's `devices.forEach`, insert a device-level gateway check between the `GATEWAY` branch and the S2120 zone logic, and exempt weather shared-read rows from the zone-visibility drops:

```ts
      if (device.type === 'GATEWAY') {
        if (visibleOnActiveGateway(gatewayScope, device.deviceEui)) {
          gateways.push(device);
        }
        return;
      }
      // S2 reading 5: scope by the device's own gateway first. Cloud-local
      // rows (null EUI) pass; rows on a non-active gateway are dropped even
      // when zoneless.
      if (!visibleOnActiveGateway(gatewayScope, device.gatewayDeviceEui ?? null)) {
        return;
      }
      const weatherSharedRead = WEATHER_SHARED_READ_TYPES.has(device.type);
```

then convert the remaining `else if` chain to plain `if`/`return` statements so the early `return`s compose, with one behavioral change per branch class:

- S2120 zone branch: rows with visible zones keep their per-zone push. The old "zone-scoped but every zone invisible → drop" branch becomes `if (weatherSharedRead) { unassigned.push(device); return; }` — a shared-read station whose zones the member cannot see still renders (B2). (For rows carrying `gatewayDeviceEui` the old drop was doing the gateway check's job; the EUI check above now owns that.)
- `irrigationZoneId` branch: an invisible zone likewise falls through to `unassigned` for `weatherSharedRead` rows instead of dropping.
- Everything else keeps its existing order and body, ending in `unassigned.push(device)`.

- [ ] **Step 4: Shared-read weather rows render read-only for scoped roles**

Append to `frontend/src/contexts/gatewayCapabilities.ts`:

```ts
/**
 * Shared-read weather rows (C6) are readable by every enabled member but
 * writable only by the owner account — remove and zone assignment are
 * claimedBy-gated, and C6 "only widens reads". Any scoped role therefore
 * gets a read-only weather card, so the affordance matches the authority.
 */
export function weatherRowsReadOnly(state: GatewayScopeState): boolean {
  if (state.gateways.length === 0) return false;
  return state.activeGateway?.gatewayRole != null;
}
```

with matching cases in `gatewayCapabilities.test.ts` (owner and cloud-local `false`; `viewer`/`researcher`/`admin` `true`).

Thread it at both card-grid sites:

1. `Dashboard.tsx`: `const weatherReadOnly = weatherRowsReadOnly(gatewayScope);`; the unassigned-section render becomes

```ts
                              {renderCard({
                                device,
                                onRemove: handleUpdate,
                                onUpdate: handleUpdate,
                                readOnly: !deviceWritable
                                  || (weatherReadOnly && WEATHER_SHARED_READ_TYPES.has(device.type)),
                              })}
```

   and the zone-card mounts pass the new prop: `weatherReadOnly={weatherReadOnly}`.

2. `IrrigationZoneCard.tsx` gains the **required** prop `weatherReadOnly: boolean` (same no-default rule as T3), and its device grid becomes

```ts
                          {renderCard({
                            device,
                            removeDevice: removeDeviceFromZone,
                            onRemove: onUpdate,
                            onUpdate,
                            readOnly: !canWrite
                              || (weatherReadOnly && WEATHER_SHARED_READ_TYPES.has(device.type)),
                          })}
```

   The three zone-card test files from T3 add `weatherReadOnly={false}` to their renders (their existing semantics are owner sessions).

- [ ] **Step 5: Run the page tests and the cloud suite**

```bash
npx vitest run --environment jsdom src/pages/__tests__/Dashboard.gatewayScope.test.tsx src/pages/__tests__/Dashboard.readOnlyPropagation.test.tsx src/contexts/__tests__/gatewayCapabilities.test.ts
npm run test:unit && npm run build
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/types/farming.ts frontend/src/services/api.ts frontend/src/contexts/gatewayCapabilities.ts frontend/src/contexts/__tests__/gatewayCapabilities.test.ts frontend/src/components/farming/deviceRegistry.tsx frontend/src/components/farming/IrrigationZoneCard.tsx frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx frontend/src/components/farming/__tests__/IrrigationZoneCard.removeDevice.test.tsx frontend/src/components/farming/__tests__/IrrigationZoneCardData.test.tsx frontend/src/pages/Dashboard.tsx frontend/src/pages/__tests__/Dashboard.gatewayScope.test.tsx
git commit -m "feat: dashboard scopes devices by gateway EUI; shared-read weather rows render read-only (S2)"
```

---

### Task 9: `AddDeviceModal` — ui-core shell, D3 gateway targeting, fail-closed registration

The registration modal is the S2 claiming flow (reading 6 keeps `ClaimGatewayModal` orphaned; account linking owns gateway acquisition). Today the modal is a hand-rolled overlay with `red-50`/`blue-50` palettes and `bg-white` inputs, registers against whatever gateway the backend picks first, and opens writable for anyone. It moves onto ui-core `Modal`/`FormField`/`INPUT_CLASS`/`Button` (mirroring S1 T8's `CreateZoneModal` treatment), names the active gateway as the registration target (T2's `gatewayDeviceEui`), points multi-gateway users at the Settings switcher, and fails closed: registration is a gateway-owner operation (`REGISTER_DEVICE` targets the caller's *claimed* gateways; a scoped member has none and today only harvests a 409), so the submit gate is `canOperateGateway`.

**Files:**
- Modify: `frontend/src/components/farming/AddDeviceModal.tsx` (full rewrite), `frontend/src/services/api.ts` (`devicesAPI.register`), `frontend/src/components/DashboardHeader.tsx`, `frontend/src/pages/Dashboard.tsx`, `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json`
- Create: `frontend/src/components/farming/__tests__/AddDeviceModal.gateway.test.tsx`, `frontend/tests/addDeviceModalLocales.test.ts`

**Interfaces:**
- Consumes: `useGateway()`, `canOperateGateway` (T3), `Button`/`FormField`/`INPUT_CLASS`/`Modal` from `../../ui-core`, T2's `RegisterDeviceRequest.gatewayDeviceEui`.
- Produces: same component props (`isOpen`, `onClose`, `onDeviceAdded`); `devicesAPI.register(deviceEui, deviceType, name, appKey?, gatewayDeviceEui?)`; `DashboardHeader` prop `canAddDevice: boolean`; locale keys `devices:addModal.targetGateway`, `addModal.switchOnSettings`, `addModal.notAvailableForRole`.

The cloud `devices.json` has no `addModal` namespace; the component's existing strings ride `t(key, 'default')` fallbacks and render English in every locale. Reading 8: this task adds real keys only for its three **new** strings and leaves the pre-existing fallback pattern untouched — the full `addModal` translation belongs to the i18n follow-up bundle.

- [ ] **Step 1: Write the failing modal test**

Create `frontend/src/components/farming/__tests__/AddDeviceModal.gateway.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkedGatewaySummary } from '../../../types/farming';
import { devicesAPI } from '../../../services/api';
import { useGateway } from '../../../contexts/GatewayContext';
import { AddDeviceModal } from '../AddDeviceModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) =>
    typeof fallback === 'string' ? fallback : key }),
}));
vi.mock('../../../services/api', () => ({
  devicesAPI: {
    getCatalog: vi.fn().mockResolvedValue([
      { typeId: 'KIWI_SENSOR', id: 'KIWI_SENSOR', name: 'KIWI Sensor', description: '' },
    ]),
    register: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../../../contexts/GatewayContext', () => ({ useGateway: vi.fn() }));

function gateway(eui: string, overrides: Partial<LinkedGatewaySummary> = {}): LinkedGatewaySummary {
  return {
    gatewayDeviceEui: eui,
    offlineVerifierVersion: 1,
    authSyncStatus: 'SYNCED',
    linkedAuthSyncSupported: true,
    forceEdgeSyncSupported: true,
    fieldJournalSupported: true,
    scopedAccessSyncSupported: true,
    scopedAccessCommandsSupported: true,
    zoneDesiredStateSupported: true,
    ...overrides,
  };
}

function scope(gateways: LinkedGatewaySummary[], overrides = {}) {
  return {
    loading: false,
    error: null as string | null,
    gateways,
    activeGateway: gateways[0] ?? null,
    hasMultipleGateways: gateways.length > 1,
    selectGateway: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Device Name'), { target: { value: 'North Kiwi' } });
  fireEvent.change(screen.getByLabelText('DevEUI'), { target: { value: 'AABBCC1122334455' } });
  fireEvent.click(screen.getByRole('button', { name: 'Register Device' }));
}

describe('AddDeviceModal gateway targeting (S2 D3/D5)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('registers on the active gateway and shows the target read-only', async () => {
    vi.mocked(useGateway).mockReturnValue(scope([gateway('EUI-A'), gateway('EUI-B')]));
    render(<AddDeviceModal isOpen onClose={() => {}} onDeviceAdded={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('EUI-A')).toBeInTheDocument();
    expect(screen.getByText('addModal.switchOnSettings')).toBeInTheDocument();
    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());
    await fillAndSubmit();
    await waitFor(() => expect(devicesAPI.register).toHaveBeenCalledWith(
      'AABBCC1122334455', 'KIWI_SENSOR', 'North Kiwi', undefined, 'EUI-A',
    ));
  });

  it('registers without a gateway EUI for cloud-local accounts', async () => {
    vi.mocked(useGateway).mockReturnValue(scope([]));
    render(<AddDeviceModal isOpen onClose={() => {}} onDeviceAdded={() => {}} />);
    await waitFor(() => expect(devicesAPI.getCatalog).toHaveBeenCalled());
    await fillAndSubmit();
    await waitFor(() => expect(devicesAPI.register).toHaveBeenCalledWith(
      'AABBCC1122334455', 'KIWI_SENSOR', 'North Kiwi', undefined, undefined,
    ));
  });

  it('fails closed for scoped roles and unresolved context', () => {
    vi.mocked(useGateway).mockReturnValue(
      scope([gateway('EUI-A', { gatewayRole: 'researcher' })]),
    );
    render(<AddDeviceModal isOpen onClose={() => {}} onDeviceAdded={() => {}} />);
    expect(screen.getByText('addModal.notAvailableForRole')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register Device' })).toBeDisabled();
    cleanup();
    vi.mocked(useGateway).mockReturnValue(scope([], { loading: true }));
    render(<AddDeviceModal isOpen onClose={() => {}} onDeviceAdded={() => {}} />);
    expect(screen.getByRole('button', { name: 'Register Device' })).toBeDisabled();
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/components/farming/__tests__/AddDeviceModal.gateway.test.tsx
```

Expected: FAIL — no dialog role, no gateway targeting, nothing disabled.

- [ ] **Step 2: Extend `devicesAPI.register`**

In `frontend/src/services/api.ts`:

```ts
  register: async (
    deviceEui: string,
    deviceType: string,
    name: string,
    appKey?: string,
    gatewayDeviceEui?: string,
  ): Promise<Device> => {
    const response = await api.post<Device>('/api/v1/devices/register', {
      deviceEui: deviceEui.toUpperCase(),
      deviceType,
      name,
      ...(appKey ? { appKey: appKey.toUpperCase() } : {}),
      ...(gatewayDeviceEui ? { gatewayDeviceEui } : {}),
    });
    return normaliseDevice(response.data);
  },
```

- [ ] **Step 3: Rewrite the modal**

Replace `frontend/src/components/farming/AddDeviceModal.tsx`, keeping the existing catalog load, validation regexes, submit flow and `t(key, 'fallback')` strings, with these structural changes:

1. Imports: `import { Button, FormField, INPUT_CLASS, Modal } from '../../ui-core';`, `import { useGateway } from '../../contexts/GatewayContext';`. (T3 amendment: `canOperateGateway` is now `(state, device, identity)` and the modal holds no device row — ownership is computed in Dashboard and arrives as the required `operable: boolean` prop below.)
2. Shell: the hand-rolled `fixed inset-0 … bg-black/50` overlay becomes `<Modal isOpen={isOpen} title={t('addModal.title', 'Register Device')} onClose={onClose}>`; each labeled field moves onto `FormField` (ids `add-device-type`, `add-device-name`, `add-device-eui`, `add-device-appkey`) with `INPUT_CLASS` on the `input`/`select` elements; the footer buttons become ui-core `Button` (`variant="secondary"` cancel / submit), matching S1 T9's edge `CreateZoneModal` structure. The device-name field splits its inline "(optional)" suffix into `FormField`'s hint slot — exactly `label={t('addModal.deviceName', 'Device Name')}` and `hint={t('addModal.optional', '(optional)')}` — so `getByLabelText('Device Name')` resolves cleanly.
3. Error box: `bg-red-50 border border-red-200 text-red-800` → `bg-[var(--error-bg)] border border-[var(--danger-fg)] text-[var(--error-text)]`; the blue gateway-hint box → `border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]`.
4. Gateway targeting and gating:

```tsx
  const gatewayScope = useGateway();
  // T3 amendment: `operable` is a new REQUIRED prop on AddDeviceModalProps,
  // computed by Dashboard (which holds both the hub device rows and the auth
  // identity) — see the Dashboard wiring in item 5.
  const targetGatewayEui = gatewayScope.gateways.length > 0
    ? gatewayScope.activeGateway?.gatewayDeviceEui ?? null
    : null;
```

   Below the device-type field, when `targetGatewayEui` is set, render a read-only target block:

```tsx
          <FormField id="add-device-gateway" label={t('addModal.targetGateway')}>
            <p id="add-device-gateway" className="font-mono text-sm text-[var(--text)]">
              {targetGatewayEui}
            </p>
          </FormField>
          {gatewayScope.hasMultipleGateways && (
            <p className="text-sm text-[var(--text-tertiary)]">{t('addModal.switchOnSettings')}</p>
          )}
```

   When gateways exist but the caller is not operable (`!operable && gatewayScope.gateways.length > 0`), render `{t('addModal.notAvailableForRole')}` in the hint box. (T3 amendment: do NOT derive this from `gatewayRole != null` — a scoped-hub owner carries `gatewayRole: 'admin'` and must remain operable; ownership is the signal, and it lives in the `operable` prop.) Submit button: `disabled={loading || gatewayScope.loading || !operable || !selectedType || …existing length checks}`. Submit call: `devicesAPI.register(deviceEui, selectedType, deviceName.trim() || deviceEui, appKey || undefined, targetGatewayEui ?? undefined)`.

5. Header entry point (M5, amended per T3's identity reshape): registration is owner-only. `Dashboard.tsx` computes the single source of truth:

```tsx
  const canAddDevice = gatewayScope.gateways.length === 0
    ? deviceWritable
    : gatewayDevices.some((device) => canOperateGateway(gatewayScope, device, identity));
```

   (`gatewayDevices` is already filtered to the active gateway; a non-owner has no operable hub row and correctly resolves false; zero-gateway cloud-local accounts keep registration per the standing adjudication.) `frontend/src/components/DashboardHeader.tsx` gains a `canAddDevice: boolean` prop; its `addMenuItems` includes the device entry only when `canAddDevice`, the zone entry stays on `canMutate`. `Dashboard.tsx` passes `canAddDevice={canAddDevice}` and threads the same value into `<AddDeviceModal operable={canAddDevice} …>` (new required prop). Update the header's mocked props in any Dashboard test that pins them, and the empty-state Add-device button gains the same `canAddDevice` condition.

Run the Step 1 command. Expected: PASS (3 tests).

- [ ] **Step 4: Locale keys + locale test**

Create `frontend/tests/addDeviceModalLocales.test.ts` with the standard shape (same skeleton as `deviceDenialLocales.test.ts`) asserting `devices.addModal.targetGateway`, `addModal.switchOnSettings` and `addModal.notAvailableForRole` in all 7 locales; run it (FAIL), then add to each `devices.json` a new top-level `addModal` object (`lg` machine draft pending the human gate):

| Locale | targetGateway | switchOnSettings | notAvailableForRole |
|---|---|---|---|
| en | Target gateway | Devices are registered on the active gateway. You can switch it on the Settings page. | Device registration is only available to the gateway owner account. |
| de-CH | Ziel-Gateway | Geräte werden auf dem aktiven Gateway registriert. Sie können es auf der Einstellungsseite wechseln. | Die Geräteregistrierung steht nur dem Gateway-Besitzerkonto zur Verfügung. |
| fr | Gateway cible | Les appareils sont enregistrés sur le gateway actif. Vous pouvez en changer sur la page des réglages. | L'enregistrement d'appareils n'est disponible que pour le compte propriétaire du gateway. |
| it | Gateway di destinazione | I dispositivi vengono registrati sul gateway attivo. Puoi cambiarlo nella pagina delle impostazioni. | La registrazione dei dispositivi è disponibile solo per l'account proprietario del gateway. |
| es | Gateway de destino | Los dispositivos se registran en el gateway activo. Puedes cambiarlo en la página de ajustes. | El registro de dispositivos solo está disponible para la cuenta propietaria del gateway. |
| pt | Gateway de destino | Os dispositivos são registados no gateway ativo. Pode mudá-lo na página de definições. | O registo de dispositivos só está disponível para a conta proprietária do gateway. |
| lg | Gateway egendererwako | Ebyuma biwandiikibwa ku gateway ekozesebwa. Osobola okugikyusa ku lupapula lw'enteekateeka. | Okuwandiisa ebyuma kusoboka kwokka ku akawunti nannyini gateway. |

- [ ] **Step 5: Run the task tests and the cloud suite**

```bash
npx vitest run --environment jsdom src/components/farming/__tests__/AddDeviceModal.gateway.test.tsx
npx tsx --test tests/addDeviceModalLocales.test.ts
npm run test:unit && npm run build
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/farming/AddDeviceModal.tsx frontend/src/services/api.ts frontend/src/components/DashboardHeader.tsx frontend/src/pages/Dashboard.tsx frontend/src/components/farming/__tests__/AddDeviceModal.gateway.test.tsx frontend/tests/addDeviceModalLocales.test.ts frontend/public/locales/de-CH/devices.json frontend/public/locales/en/devices.json frontend/public/locales/es/devices.json frontend/public/locales/fr/devices.json frontend/public/locales/it/devices.json frontend/public/locales/lg/devices.json frontend/public/locales/pt/devices.json
git commit -m "feat: AddDeviceModal targets the active gateway on ui-core shell (S2 D3/D5)"
```

---

### Task 10: Update the GUI-parity matrix (S2 rows)

Per the matrix rules: only touched rows change, each touched row gets today's provenance date, and nothing flips to `parity` — S2 ran no `agrolink-test-01` walkthrough and the mandated live `OPEN_FOR_DURATION` is explicitly pending. All edits in `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (osi-os).

**Files:**
- Modify: `docs/superpowers/plans/agrolink-gui-parity-matrix.md`

- [ ] **Step 1: Edit the four existing rows**

Replace the "Valve card (STREGA)" row with:

```markdown
| Valve card (STREGA) | `web/react-gui/src/components/farming/StregaValveCard.tsx` (867 lines) | partial (pending walkthrough): cloud card actuates via `OPEN_FOR_DURATION` with a 1–255 min duration control, no bare CLOSE (S2 T6, matching edge + STREGA rules); actor-carrying `VALVE_COMMAND` denials render legibly on both paths — immediate 403 `scope_denied` (S2 T2) and async edge `scope_denied`/`scope_actor_required` via `PendingStateNotice` (S2 T5); `readOnly` required (S2 T4). Deviations: no cancel-queued-open button (edge cancel is an edge-local route; no cloud→edge cancel command exists) and no today-liters line. Live `OPEN_FOR_DURATION` against `agrolink-test-01` still required before this row may flip (spec S2 gate) | pending | 2026-08-05 verified (S2) |
```

Replace the "Weather card (S2120)" row with:

```markdown
| Weather card (S2120) | `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx` (420 lines) | partial (pending walkthrough): shared-read stations now appear in the cloud device list for scoped members (S2 T1 backend merge + T8 gateway-EUI scoping, matching the edge C6 behavior); ledger M3 (`text-[var(--error-bg)]` as text) and the pale error border fixed (S2 T7); card body still hardcodes English strings (i18n follow-up). Shared-read rows render read-only for every scoped role (weather writes are owner-only), so the card affordance matches the backend authority (S2 T8) | pending | 2026-08-05 verified (S2) |
```

Replace the "Farming dashboard" row with:

```markdown
| Farming dashboard | `web/react-gui/src/pages/FarmingDashboard.tsx` (367 lines) | partial (pending walkthrough): cloud `pages/Dashboard.tsx` scopes zones by active gateway (S1) and now devices by their own `gatewayDeviceEui` (S2 T8); device-card write authority threads role-based `canWriteDevices` and owner-only `canOperateGateway` helpers (S2 T3), `readOnly` is a required card prop enforced by `tsc` (S2 T4); page composition still thinner than the edge page | pending | 2026-08-05 verified (S2) |
```

Replace the "Zone / device modals" row with:

```markdown
| Zone / device modals | `web/react-gui/src/components/farming/CreateZoneModal.tsx` (on ui-core since S1 T9), `AddDeviceModal.tsx` (196 lines) | partial (pending walkthrough): cloud `CreateZoneModal` on ui-core targeting the active gateway (S1 T8); cloud `AddDeviceModal` likewise on the ui-core `Modal`/`FormField`/`Button` shell, registers on the active gateway with a Settings-switcher pointer, owner-gated fail-closed (S2 T9); cloud `ClaimGatewayModal.tsx` is orphaned dead code (admin-era direct claim, unmounted since the Dashboard rewrites — account linking owns gateway acquisition) | pending | 2026-08-05 verified (S2) |
```

- [ ] **Step 2: Append one S2 row to the "Edge screens and widgets" table**

```markdown
| Device detail page | n/a — the edge has no per-device detail route; drill-down is in-card `SensorMonitor`/`WindMonitor` overlays | partial: cloud-only page (D7 single-sided), `frontend/src/pages/DeviceDetail.tsx` at `/devices/:deviceEui`; S2 T7 rethemed its error box and date inputs onto tokens; read paths cover shared-read weather devices via the backend `canReadDevice` widening; recharts chart chrome still hardcodes light-theme hex colors | pending | 2026-08-05 verified (S2) |
```

- [ ] **Step 3: Append the open-ledger section after "Using this matrix"**

```markdown
## Open retheme ledger (not tied to a single row)

- Cloud `ScheduleSection.tsx:423` still pairs `border-[var(--error-bg)]` with the error wash (pale border). Ledgered by S1; S2 touched no schedule file, so per the ledger condition it stays open for the slice that next touches `ScheduleSection`.
- Cloud `ClaimGatewayModal.tsx` + its `devices:claimGatewayModal.*` locale keys are dead code (see the Zone / device modals row) — cleanup sweep candidate.
- Full `devices:addModal.*` translation: S2 added the three new keys only; the modal's pre-existing strings still ride `t(key, 'English fallback')` (i18n follow-up bundle).
- ui-core `INPUT_CLASS` (`FormField.tsx`) carries a hardcoded `bg-white` input fill — light-only, inherited verbatim from the edge modals at S0 extraction. A token pass on it is canonical-first ui-core work (D2 re-vendor in the same change), out of S2 scope.
```

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add docs/superpowers/plans/agrolink-gui-parity-matrix.md
git commit -m "docs: matrix S2 rows — devices/valve control partial pending walkthrough"
```

---

### Task 11: Full verification, both repos

No code changes. Every gate S2 could have disturbed runs once, from clean state.

- [ ] **Step 1: Cloud backend**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.device.*' --tests 'org.osi.server.command.*' --tests 'org.osi.server.desiredstate.*' 2>&1 | tail -10
```

Expected: BUILD SUCCESSFUL. (Unit tests only — Mockito, no Testcontainers, so the docker-java quirk on this machine is not in play.)

- [ ] **Step 2: Cloud frontend suite, build and vendor parity**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npm run test:unit && npm run build
cd /home/phil/Repos/osi-server/.worktrees/agrolink
sh scripts/verify-ui-core-vendor.test.sh
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
```

Expected: node-runner grows from 62 by the three new `tests/*.test.ts` files (`deviceCardReadOnlyContract`, `errorTokenMisuse`, `addDeviceModalLocales`) plus the tests added inside `deviceDenialLocales`; Vitest grows from 394/95 files by the three new `__tests__` files (`PendingStateNotice.rejection`, `StregaValveCard.actuation`, `AddDeviceModal.gateway`) plus in-file additions; build succeeds (this is also the required-prop proof, reading 2); both verifier outputs `OK` — S2 changed no ui-core file, so byte parity is unchanged from S1.

- [ ] **Step 3: Edge repo (docs-only slice)**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
git status --short
```

Expected: `verify-ui-core-vendor: OK`; the only S2 edge commits touch `docs/superpowers/plans/` (this plan + the matrix). The edge GUI suite is not re-run: no edge source file changed.

- [ ] **Step 4: Scope audit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git log --oneline -12 -- frontend backend
git status --short
```

Expected: only the files named in this plan's File map appear in the S2 commits; no `terra-intelligence` or Terra composition-root paths; both worktrees clean. If anything else shows up, stop and report before proceeding.

