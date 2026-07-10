# EdgeSyncService per-resource applier split — first applier (pattern proof)

**Status:** Draft
**Refactor-program item:** 3.4 (DD12)
**Focus: osi-server**
**Depends on:** 1.B4 (`SyncEventTxExecutor.applyOne` — the transaction boundary this applier slots inside) and 1.B3 (CI + `./gradlew test` + Testcontainers slice). Both must have landed; this item consumes their contracts verbatim and does not re-open either.
**Repo split:** every code change is in `/home/phil/Repos/osi-server`. Zero osi-os file changes.

## Problem

`EdgeSyncService` is a 93 KB / 1817-line god-file (verified: `EdgeSyncService.java` is 93412 bytes, 1817 lines). Its op-dispatch is a single `switch (event.op())` in the private `applyEvent(gatewayDeviceEui, event, dryRun)` method (`EdgeSyncService.java:431-486`): **12 `case` labels covering 17 distinct op strings** (several cases are multi-op — e.g. the three `ZONE_*` ops share one case, the four device-lifecycle ops share one) over **12 helpers** (`upsertSensorData`, `upsertDendroReading`, `upsertChameleonReading`, `upsertDendroDaily`, `upsertZoneRecommendation`, `upsertZoneEnvironment`, `upsertGatewayLocation`, `upsertIrrigationEvent`, `upsertZone`, `softDeleteZone`, `upsertSchedule`, `upsertDevice`, spanning ~lines 732–1213), plus a `default` that calls no helper. Adding a device or resource means editing the god-file's switch, editing a helper near ~15 unrelated others, and there is no way to unit-test one resource's apply logic without constructing the whole service and its ~10 collaborators.

DD12 rules the fix: **split `EdgeSyncService` into per-resource appliers** (`SyncEventApplier` keyed by op; the orchestration loop stays thin), **convert-on-touch starting with the next device's resource**. This item does **not** migrate all 13 cases. It extracts **one** applier as the proof-of-pattern — the interface, the registry/dispatch wiring, the Testcontainers slice test that exercises an applier in isolation — so that every subsequent resource (and every new device) migrates by copying an established, tested shape rather than inventing one. The rest stay in the switch and migrate when next touched.

## Verified ground truth

Read directly in `EdgeSyncService.java` at spec time (line numbers are load-bearing; re-verify at implementation time — a concurrent merge may shift them):

1. **The dispatch site is `applyEvent(String gatewayDeviceEui, SyncEventRecord event, boolean dryRun)` (`:423-487`).** It is called two ways: as a **dry-run** (`applyEvent(gatewayDeviceEui, event, true)`) from `applyEventV2`'s support-gate — the op-switch `default` returns `false` in dry-run instead of throwing, which is how "unknown_op" is detected (this is the mechanism 1.B4 §"Verified ground truth" #1 documented: there is no `SUPPORTED_OPS` constant, the case list *is* the gate); and as a **live apply** (`applyEvent(gatewayDeviceEui, event, false)` via the package `applyEvent(eui, event)` overload at `:419`). The split must preserve both call shapes exactly.
2. **Post-1.B4, `applyEvent` is invoked from inside `SyncEventTxExecutor.applyOne`** (per the 1.B4 plan, the op-dispatch stays in `EdgeSyncService` and reaches the executor as a per-batch callback `SyncOpDispatcher` — `dispatcher.supports(event)` is the dry-run gate, `dispatcher.apply(event)` is the live apply). **This is the seam DD12 replaces.** The 1.B4 spec §Non-goals states verbatim: "The `SyncEventTxExecutor` extraction in §A is shaped so that split slots inside `applyOne` later without touching the transaction boundary again." This item is that slot-in. The transaction boundary (`applyOne`'s `REQUIRES_NEW`, the loop-level classifier, `recordRejection`, `finalizeBatch`) is **not touched**.
3. **The private `applyEvent` switch is the extraction point; the executor is untouched.** 1.B4's `SyncOpDispatcher` has `boolean supports(SyncEventRecord)` and `void apply(SyncEventRecord)`; `applyEventsV2` passes an anonymous implementation that delegates to `EdgeSyncService.applyEvent(eui, event, dryRun)`. **This item does not touch the anonymous `SyncOpDispatcher`** — it rewrites the private `applyEvent(gatewayDeviceEui, event, dryRun)` method (§C) to consult the applier registry before the switch. Because the anonymous dispatcher delegates *into* `applyEvent`, the net effect is identical: `supports` (dry-run) and `apply` (live) route through the registry for extracted ops, and the executor never learns anything changed.
4. **`EventResourceRef.from(event)`** (the record spans `:1608-1677`; `from` at `:1609-1613`; `resourceIdForType` follows) already derives `(resourceType, resourceId)` per op — the applier does not re-derive ownership keys; ownership/watermark/dead-letter handling stays entirely in `applyOne` (1.B4), which calls the dispatcher only for the domain mutation. An applier is **only** the `upsert*` body, nothing else.
5. **Candidate resources for the first applier — verified boundaries:**
   - `GATEWAY_LOCATION_UPSERTED` → `upsertGatewayLocation(payload, fallbackGatewayDeviceEui)` (`:1178-1213`). **One op, one repository (`gatewayLocationRepository`), one aggregate type (`GATEWAY`), self-contained stale-version guard, no telemetry-device resolution, no cross-table side effects, no soft-delete branch.** Its only external dependency is `gatewayLocationRepository` plus the shared `str/num*/parseNullableInstant` helpers.
   - `DEVICE_DATA_APPENDED` → `upsertSensorData(payload)` (`:934-963`) pulls in `resolveTelemetryDevice` (which can `deviceService.upsertFromHeartbeat`), `persistCanonicalStateIfNewer`, `IncorrectResultSizeDataAccessException` duplicate-row recovery, and `sensorDataRepository` — a wider blast radius and three collaborators.

## Decision: the first applier is `GATEWAY_LOCATION_UPSERTED`

**Rationale (this is the pre-ruled "pick the resource with the clearest boundary; justify choice" — justified):**
- **Narrowest dependency set** — one repository, zero services. The applier can be unit/slice-tested against a real `GatewayLocationRepository` with no device seeding, no `deviceService` mock, no canonical-state machinery. `DEVICE_DATA_APPENDED` would require standing up a `Device` and mocking `deviceService`/`persistCanonicalState` — noise that obscures the pattern.
- **Single op, single case** — the switch case (`:456-459`) is exactly one op, unlike `ZONE_UPSERTED/ZONE_CONFIG_UPSERTED/ZONE_LOCATION_UPSERTED` (three ops, one helper) or the device-lifecycle case (four ops). A one-op applier is the minimal honest unit and the cleanest `supports()` predicate.
- **Already the 1.B4 test's chosen op** — the 1.B4 poison-batch IT (`PoisonBatchIT`) uses `GATEWAY_LOCATION_UPSERTED` precisely because it is a "real repository path (`gateway_locations`, PK = gateway EUI, no FK on devices), minimal payload, no domain seeding needed." Reusing the same op keeps this item's test infrastructure aligned with the already-landed 1.B4 harness and lets the applier test reuse `PostgresSyncTestBase`.
- **Self-contained stale guard** — `upsertGatewayLocation` already carries its own `isStale(incomingSyncVersion, location.getSyncVersion())` check and sync-version bookkeeping. This is redundant with `applyOne`'s watermark check (an honest observation, not a change target): the applier moves the helper **verbatim**, preserving the belt-and-braces guard; harmonizing the two version checks is a separate behavior-change PR, explicitly out of scope (extraction is behavior-preserving by program mandate).

Against `DEVICE_DATA_APPENDED`: it is the highest-value resource to migrate *eventually* (it's the hottest write path), but as the **pattern proof** its collaborators make the test murkier and raise the behavior-preservation risk. The program says "convert-on-touch"; the next device or the next `sensor_data` change is the natural trigger to migrate it onto the now-proven pattern.

## Design

### A. The `SyncEventApplier` interface

New package-private interface in `org.osi.server.sync`:

```java
interface SyncEventApplier {
    /** The op strings this applier owns — the case labels it lifts out of the switch. */
    Set<String> supportedOps();

    /**
     * Apply the domain mutation for one already-validated event. Called ONLY on the
     * live path (never dry-run — dry-run is answered by supportedOps().contains(op)).
     * Runs inside SyncEventTxExecutor.applyOne's REQUIRES_NEW transaction (1.B4):
     * ownership, watermark, dedup, and dead-letter are handled by the caller — an
     * applier is exactly the former upsert* body, nothing more. May throw
     * IllegalArgumentException for payload-validation faults (classified in-method by
     * applyOne) or let repository/JPA exceptions propagate (classified at the loop
     * boundary). Behavior identical to the switch case it replaces.
     */
    void apply(String gatewayDeviceEui, EdgeSyncService.SyncEventRecord event);
}
```

**Keyed by op, not by resource type**, matching DD12's wording ("`SyncEventApplier` keyed by op") and the switch's own structure (cases are op strings). `supportedOps()` returns a `Set<String>` so a future multi-op applier (e.g. the three `ZONE_*` ops on one helper) fits without interface change — `GatewayLocationApplier` returns `Set.of("GATEWAY_LOCATION_UPSERTED")`.

**Why the applier takes `gatewayDeviceEui`:** `upsertGatewayLocation` needs the fallback EUI (`:1178`, `fallbackGatewayDeviceEui`) when the payload omits `gateway_device_eui`. The signature mirrors the existing helper's two arguments exactly.

### B. `GatewayLocationApplier` — the first applier

New `@Component` package-private class:

```java
@Component
@RequiredArgsConstructor
class GatewayLocationApplier implements SyncEventApplier {
    private final GatewayLocationRepository gatewayLocationRepository;

    @Override public Set<String> supportedOps() { return Set.of("GATEWAY_LOCATION_UPSERTED"); }

    @Override public void apply(String gatewayDeviceEui, EdgeSyncService.SyncEventRecord event) {
        // body = today's upsertGatewayLocation(payloadWithOp(event), gatewayDeviceEui), moved verbatim.
    }
}
```

- **The body is `upsertGatewayLocation` moved, not rewritten.** The payload it receives is `payloadWithOp(event)` (the same map today's switch passes at `:430,457`). The `SyncEventShapes.payloadWithOp` helper (introduced in 1.B4) is the canonical way to build it — the applier calls `SyncEventShapes.payloadWithOp(event)` so it needs no `EdgeSyncService` reference. 1.B4's `SyncEventShapes` already provides `payloadWithOp`, `eventSyncVersion`, `eventContractVersion`, `parseInstantOrNull`, and the `str`/`nullableStr`/`numLong` primitives. **The moved `upsertGatewayLocation` body calls primitives 1.B4's `SyncEventShapes` does NOT yet have — verified in the body (`:1178-1213`): `normalizeGatewayDeviceEui` (produces the primary key — mandatory), `str`, `numDoubleObj`, `numIntegerObj`, `nullableStr`, the 2-arg `parseNullableInstant(payload, keys...)` AND the 3-arg `parseNullableInstant(payload, String[] keys, Instant default)` overload (`:1206`), and `isStale`.** Each of these is **added to `SyncEventShapes` as a static package-private helper**, a deliberate small duplicate of `EdgeSyncService`'s instance method (which stays for its ~100 other call sites) — the exact precedent 1.B4 set for `str`/`nullableStr`/`numLong` and its stated rationale ("the alternative is a circular `EdgeSyncService` ↔ applier bean dependency"). Re-derive the exact call list at implementation time from the live body; the list above is the verified-at-spec-time set. (Note: `EdgeSyncService.numLong` returns boxed `Long` while 1.B4's `SyncEventShapes.numLong` returns primitive `long`; the moved body's `Optional.ofNullable(numLong(...)).orElse(0L)` wrapper at `:1187` is a harmless auto-box against the primitive — expect the IDE to flag it, it compiles and behaves identically.)
- **`isStale` and the sync-version bookkeeping move verbatim.** Redundant with the watermark check as noted in §Decision — preserved unchanged; not harmonized here.
- **`upsertGatewayLocation` has a SECOND caller — `applyBootstrap` (`:157`) — so the private method is NOT deleted.** Verified: `upsertGatewayLocation` is called from both the op-switch (`:457`, the caller that moves to the applier) and the bootstrap loop (`:157`, `applyBootstrap`). The applier holds a **moved copy** of the body; `EdgeSyncService.upsertGatewayLocation` **stays** for `applyBootstrap`'s use. This is deliberate, bounded duplication: routing `applyBootstrap` through the applier is a bootstrap-path change (5.5 territory / a different blast radius) and is explicitly out of scope. Convert-on-touch resolves the duplication when `applyBootstrap` is next touched. Do not delete the private method; do not refactor bootstrap here.
- **Return type dropped.** `upsertGatewayLocation` returns `GatewayLocation`; nothing consumes the return value at the call site (the switch case discards it — `:457` is a statement, not an assignment), so `apply` is `void`. The moved body drops its `return location` / `return gatewayLocationRepository.save(location)` to a bare `gatewayLocationRepository.save(location)` (still called for its persistence side effect).

### C. Dispatch wiring — the registry

`EdgeSyncService` gains an injected `List<SyncEventApplier>` (Spring collects all beans implementing the interface) folded once into a `Map<String, SyncEventApplier>` at construction:

```java
// in EdgeSyncService — initialized empty, populated in @PostConstruct:
private final List<SyncEventApplier> syncEventAppliers;       // Lombok includes this (uninitialized final)
private final Map<String, SyncEventApplier> appliersByOp = new HashMap<>();  // Lombok SKIPS this (has initializer)
```

**Why the initializer matters (Lombok `@RequiredArgsConstructor` rule):** Lombok generates constructor parameters only for **uninitialized** `final` fields. `syncEventAppliers` (no initializer) gets a constructor parameter — Spring injects all `SyncEventApplier` beans into it. `appliersByOp` (has `= new HashMap<>()` initializer) is excluded — it starts as an empty map, populated by the `@PostConstruct` fold below. Without the initializer, Lombok would add `appliersByOp` to the constructor and Spring would try to inject a `Map<String, SyncEventApplier>` bean, which doesn't exist.

Built via `@PostConstruct` with a **duplicate-op guard**: if two appliers claim the same op, fail fast at startup (`IllegalStateException`) — a wiring bug must not silently shadow. **Lombok interaction (verified):** `EdgeSyncService` is `@Service @RequiredArgsConstructor`; keep that annotation, add `private final List<SyncEventApplier> appliers` (Lombok includes it in the generated constructor), and fold it to the `Map` in a `@PostConstruct` method — not in a constructor body, which `@RequiredArgsConstructor` owns. **Convention note:** Spring `List<T>` multi-bean collection injection + a fold-to-`Map` is a standard Spring idiom but is **new to this repo** (verified: no existing multi-bean `List<T>` collection injection and no `Collectors.toMap`/`@PostConstruct` fold in `src/main` — the only `List<T>` fields are hand-parsed config lists like `RateLimitFilter.trustedProxyMatchers`). It is not "the house pattern"; it is a standard idiom introduced here. Verify at implementation time that no newer `Map<String, ...>` bean-collection convention exists — if one does, prefer it.

**`applyEvent(gatewayDeviceEui, event, dryRun)` becomes** (the switch shrinks by exactly one case; everything else is unchanged):

```java
private boolean applyEvent(String gatewayDeviceEui, SyncEventRecord event, boolean dryRun) {
    if (event.op() == null) { if (dryRun) return false; throw new IllegalArgumentException("unknown_op"); }
    SyncEventApplier applier = appliersByOp.get(event.op());
    if (applier != null) {                       // extracted op
        if (!dryRun) applier.apply(gatewayDeviceEui, event);
        return true;                             // supports() == true, dry-run or applied
    }
    Map<String, Object> payload = dryRun ? null : payloadWithOp(event);
    switch (event.op()) {                        // NOT-YET-extracted ops stay here, verbatim
        // ... all cases EXCEPT GATEWAY_LOCATION_UPSERTED, unchanged ...
        default -> { if (dryRun) return false; throw new IllegalArgumentException("unknown_op"); }
    }
}
```

- **The registry is consulted before the switch.** An extracted op never reaches the switch; the `GATEWAY_LOCATION_UPSERTED` case is deleted from the switch. Dry-run for an extracted op returns `true` from the registry branch (op is supported), matching the old case's `return true` — so 1.B4's `SyncOpDispatcher.supports` (which calls this with `dryRun=true`) keeps answering identically.
- **Unknown ops** still fall through the (now shorter) switch to `default` → `false` in dry-run / throw live. Identical behavior; the dead-letter `unknown_op` path in `applyOne` (1.B4) is untouched.
- **This is the DD12 seam done right:** the switch is now a fold-in point. Migrating the next resource is: create its applier `@Component`, delete its case from the switch, add its slice test. No dispatch-shape change ever again.

### D. What explicitly does NOT move (behavior-preservation fences)

- **Ownership, watermark, dedup, dead-letter, `recordRejection`, `finalizeBatch`, the exception classifier, the batch loop** — all 1.B4 machinery, untouched. An applier is downstream of every one of those checks.
- **The dry-run gate mechanism** — still "is this op known?", now answered by `appliersByOp.containsKey(op) || <switch has a case>`. The registry-first shape preserves the exact `true`/`false` contract.
- **The other 11 helpers and their switch cases** — stay in `EdgeSyncService`, called exactly as today (the switch drops from 12 cases to 11). Note `upsertGatewayLocation` itself also *stays* (as a private method) because `applyBootstrap` still calls it — see §B; the applier holds a moved copy, and only the switch *case* is deleted.
- **`EventResourceRef`, `resourceTypeFromOp`, `resourceIdForType`** — ownership-key derivation, owned by `applyOne`, not the applier.
- **`isStale`/sync-version harmonization, canonical-state refactors, any logic change** — separate PRs. This item is byte-for-byte behavior-preserving on the `GATEWAY_LOCATION_UPSERTED` path.

## Testing

Per the 1.B4 / DD15 slice strategy (Testcontainers Postgres 16, single reused container via `PostgresSyncTestBase`; `@DataJpaTest` + `@AutoConfigureTestDatabase(replace = NONE)` + `@Import` + `@MockBean`s — **not** `@SpringBootTest`, which fails on `DataInitializer` without super-admin bootstrap). Every IT class uses its own unique gateway EUI / uuid prefix (shared DB, per the base-class contract).

1. **`GatewayLocationApplierIT`** — the pattern-proof test, the whole point of the item: constructs/`@Autowired`s the applier with a real `GatewayLocationRepository` against the container, calls `apply(eui, event)` directly (no `EdgeSyncService`, no executor, no ownership), asserts the `gateway_locations` row is upserted with the payload's fields, the stale-version guard no-ops a lower `sync_version`, and a fresh insert sets `sync_version = 1` when the payload omits it. **This is the deliverable's headline: an applier is testable in isolation** — the capability DD12 exists to create.
2. **`supportedOps()` unit test** — asserts `Set.of("GATEWAY_LOCATION_UPSERTED")` (a plain JUnit test, no container).
3. **Dispatch-parity slice test** — through `EdgeSyncService.applyEventsV2` (reusing the 1.B4 `PoisonBatchIT` shape and its `GATEWAY_LOCATION_UPSERTED` events), assert a `GATEWAY_LOCATION_UPSERTED` batch applies identically post-split: `APPLIED` result, row present, watermark advanced — proving the registry-through-`applyOne` path is behavior-identical to the pre-split switch. The 1.B4 `PoisonBatchIT` itself, unchanged, is the regression net (it already drives `GATEWAY_LOCATION_UPSERTED` through the full loop); this item must keep it green.
4. **Registry duplicate-op guard test** — a throwaway second applier claiming the same op makes context startup fail (or a direct unit test of the fold function) — proves the fail-fast.
5. **Behavior-preservation evidence** — because this is an extraction, the standard is golden: the pre-split `PoisonBatchIT` assertions on the `GATEWAY_LOCATION_UPSERTED` path are the captured golden behavior; they must pass unchanged against the post-split code. No new behavior is asserted beyond isol-testability.

**Run path:** `./gradlew test` locally (Docker required for Testcontainers), per 1.B3's wiring. No CI change is this item's job.

## Non-goals

- **Migrating any op other than `GATEWAY_LOCATION_UPSERTED`.** The other 12 stay in the switch; convert-on-touch.
- **Touching the 1.B4 transaction boundary** (`SyncEventTxExecutor`, the loop classifier, `recordRejection`, `finalizeBatch`, `SyncOpDispatcher`'s shape). The applier slots inside `applyOne` via the existing dispatcher callback; that contract is consumed, not changed.
- **Harmonizing `upsertGatewayLocation`'s `isStale` guard with the watermark check** — a behavior change, separate PR.
- **Any `sensor_data`/`DEVICE_DATA_APPENDED` work** — the natural but wider-blast-radius next resource; deferred to its own convert-on-touch trigger.
- **A `SyncEventApplier` for actuators / new device types** — this is the pattern *proof*; MClimate (3.1) or the next device supplies the second applier and validates the abstraction under a genuinely new resource.
- **CI workflow / GHCR / deploy** (1.B3). **Bootstrap snapshot** (5.5, `applyBootstrap` — a different path). **Any osi-os change.**

## Definition of Done

- `SyncEventApplier` interface (`supportedOps()` + `apply(gatewayDeviceEui, event)`) in `org.osi.server.sync`.
- `GatewayLocationApplier` `@Component` implementing it, body = `upsertGatewayLocation` moved verbatim (return dropped to `void`), depending only on `GatewayLocationRepository` + `SyncEventShapes` static helpers (any newly-needed primitive added to `SyncEventShapes` per the 1.B4 duplication precedent).
- `EdgeSyncService` injects `List<SyncEventApplier>`, folds to `Map<String, SyncEventApplier>` with a duplicate-op fail-fast; `applyEvent` consults the registry before the switch; the `GATEWAY_LOCATION_UPSERTED` case is deleted from the switch. Both dry-run and live call shapes preserved.
- `GatewayLocationApplierIT` (isolated applier test against real Postgres via `PostgresSyncTestBase`), `supportedOps()` unit test, dispatch-parity slice test, duplicate-op guard test — all green via `./gradlew test`.
- 1.B4's `PoisonBatchIT` and all existing sync tests still green (behavior-preservation net).
- No change to the 1.B4 transaction boundary, to `applyBootstrap`, to any other op's behavior, or to any osi-os file.
- "Open decisions" shows none outstanding.

## Open decisions

None outstanding.

- First applier: **`GATEWAY_LOCATION_UPSERTED`**, decided in §Decision — narrowest dependency (one repo, zero services), single op, already the 1.B4 test op, self-contained stale guard; `DEVICE_DATA_APPENDED` is the higher-value but wider-blast-radius next resource, deferred to convert-on-touch.
- Interface keying: **by op (`Set<String> supportedOps()`)**, decided in §A — matches DD12's wording and the switch's own case-by-op structure; the Set accommodates a future multi-op applier without interface change.
- Extraction seam: **the `SyncOpDispatcher` callback / `applyEvent` switch, not the executor**, decided in §Design ground-truth #2/#3 — 1.B4 explicitly shaped `applyOne` so the split slots inside it untouched; the registry replaces the switch case, the executor never learns.
- Behavior preservation: **body moved verbatim, `isStale` redundancy preserved, return dropped to void**, decided in §B/§D — extraction PRs are behavior-preserving by program mandate; the watermark/`isStale` harmonization is a named separate PR.
- Applier dependencies avoid a circular bean: **`SyncEventShapes` static helpers, adding primitives there as needed**, decided in §B — the exact precedent 1.B4 set to keep the executor free of an `EdgeSyncService` reference.
