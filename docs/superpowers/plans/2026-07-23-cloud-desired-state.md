# Cloud desired-state implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable OSI Server desired-state ledger that links cloud edits
to existing pending commands, converges only after ACK plus mirror evidence,
and exposes reusable zone and journal status UI.

**Architecture:** Keep `device_commands` as the transport and lease record.
Add a separate desired-state operation per user edit, linked to a command.
`DesiredStateService` owns creation, coalescing, ACK transitions, mirror
convergence, and expiry. Zone configuration is the first domain consumer;
journal and scoped-access controllers consume the same service later.

**Tech stack:** Java 17, Spring Boot, Spring Data JPA, PostgreSQL/Flyway,
JUnit 5, Mockito, Testcontainers, React, TypeScript, Axios, Vitest, Testing
Library.

## Global constraints

- The edge remains canonical.
- REST pending-command polling is the only cloud-to-edge command path.
- An operation becomes applied only after an `APPLIED` ACK and matching mirror
  event, in either order.
- `FAILED_RETRYABLE` keeps the same command ID, event UUID, and effect key.
- A leased command and every physical-effect command are immutable.
- Safe coalescing is limited to unleased `PENDING` or legacy `SENT`
  configuration commands with the same command type.
- Frontend response normalization stays in `frontend/src/services/api.ts`.
- Backend commands use `./gradlew ... --no-daemon --max-workers=2`.
- Frontend builds use `NODE_OPTIONS=--max-old-space-size=2048`.

---

## File structure

Create one backend package, `org.osi.server.desiredstate`:

- `DesiredStateOperation.java` — JPA persistence only.
- `DesiredStateStatus.java` and `DesiredStateMutationKind.java` — closed state
  vocabulary.
- `DesiredStateOperationRepository.java` — locked active-resource lookup,
  active-command lookup, creator lookup, and expiry scan.
- `DesiredStateService.java` — all transition rules and recursive subset
  comparison.
- `DesiredStateView.java` — stable API response.
- `DesiredStateController.java` — creator-authorized status read only.
- `DesiredStateExpiryJob.java` — scheduler adapter around deterministic service
  expiry.

Existing command, sync, and zone packages call the service. They do not
duplicate transition logic.

Frontend files:

- `frontend/src/types/desiredState.ts` — normalized client contract.
- `frontend/src/components/sync/PendingStateNotice.tsx` — reusable status UI.
- `frontend/src/services/api.ts` — response normalization.
- `frontend/src/types/farming.ts` and
  `frontend/src/components/farming/IrrigationZoneCard.tsx` — zone consumer.

---

### Task 1: Desired-state schema and persistence

**Files:**

- Create:
  `backend/src/main/resources/db/migration/V2026_07_23_001__desired_state_operations.sql`
- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateStatus.java`
- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateMutationKind.java`
- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateOperation.java`
- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateOperationRepository.java`
- Test:
  `backend/src/test/java/org/osi/server/desiredstate/DesiredStateMigrationIT.java`

**Interfaces:**

- Produces: JPA entity keyed by `operationUuid`, linked to
  `DeviceCommand command` and `User createdBy`.
- Produces:
  `lockActiveConfig(gatewayEui, resourceType, resourceId)` in newest-first
  order.
- Produces:
  `findFirstByCommandIdAndStatusInOrderByCreatedAtDesc(...)`.

- [ ] **Step 1: Write the failing migration integration test**

Create a PostgreSQL Testcontainers test that runs Flyway and asserts the table,
foreign keys, JSONB columns, and three indexes:

```java
assertThat(columns("desired_state_operations"))
        .contains("operation_uuid", "gateway_eui", "resource_type",
                "resource_id", "command_id", "status", "base_sync_version",
                "target_sync_version", "desired_json", "canonical_json",
                "expires_at", "superseded_by");
assertThat(indexes("desired_state_operations"))
        .contains("idx_desired_state_resource_latest",
                "idx_desired_state_command_active",
                "idx_desired_state_expiry_active");
```

- [ ] **Step 2: Run the test and verify red**

```bash
cd backend
./gradlew test \
  --tests org.osi.server.desiredstate.DesiredStateMigrationIT \
  --no-daemon --max-workers=2
```

Expected: failure because `desired_state_operations` does not exist.

- [ ] **Step 3: Add the migration**

Use `VARCHAR` checks instead of a PostgreSQL enum so later Flyway migrations
can extend status safely:

```sql
CREATE TABLE desired_state_operations (
    operation_uuid UUID PRIMARY KEY,
    gateway_eui VARCHAR(32) NOT NULL,
    resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(128) NOT NULL,
    command_type VARCHAR(64) NOT NULL,
    mutation_kind VARCHAR(32) NOT NULL
        CHECK (mutation_kind IN ('CONFIG', 'PHYSICAL_EFFECT')),
    status VARCHAR(32) NOT NULL
        CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'APPLIED',
                          'CONFLICTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
    base_sync_version BIGINT NOT NULL CHECK (base_sync_version >= 0),
    target_sync_version BIGINT NOT NULL CHECK (target_sync_version > 0),
    desired_json JSONB NOT NULL,
    canonical_json JSONB,
    command_id BIGINT NOT NULL REFERENCES device_commands(id),
    created_by BIGINT NOT NULL REFERENCES users(id),
    ack_result VARCHAR(32),
    acknowledged_at TIMESTAMPTZ,
    mirrored_sync_version BIGINT,
    mirrored_at TIMESTAMPTZ,
    rejection_code VARCHAR(64),
    rejection_detail VARCHAR(512),
    expires_at TIMESTAMPTZ,
    superseded_by UUID REFERENCES desired_state_operations(operation_uuid),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_desired_state_resource_latest
    ON desired_state_operations(
        gateway_eui, resource_type, resource_id, created_at DESC);
CREATE INDEX idx_desired_state_command_active
    ON desired_state_operations(command_id, created_at DESC)
    WHERE status IN ('PENDING', 'ACKNOWLEDGED', 'CONFLICTED');
CREATE INDEX idx_desired_state_expiry_active
    ON desired_state_operations(expires_at)
    WHERE mutation_kind = 'PHYSICAL_EFFECT'
      AND status IN ('PENDING', 'ACKNOWLEDGED');
```

- [ ] **Step 4: Add enums, entity, and repository**

The repository lock query must serialize configuration edits for one resource:

```java
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("""
    select o from DesiredStateOperation o
     where o.gatewayEui = :gatewayEui
       and o.resourceType = :resourceType
       and o.resourceId = :resourceId
       and o.mutationKind = :mutationKind
       and o.status in :statuses
     order by o.createdAt desc
    """)
List<DesiredStateOperation> lockActiveConfig(
        String gatewayEui,
        String resourceType,
        String resourceId,
        DesiredStateMutationKind mutationKind,
        Collection<DesiredStateStatus> statuses);
```

Use `@JdbcTypeCode(SqlTypes.JSON)` for both maps. Normalize the gateway and
resource type before persistence, and set UUID/timestamps in `@PrePersist`.

- [ ] **Step 5: Run migration and repository tests**

Run the Task 1 command again. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/resources/db/migration/V2026_07_23_001__desired_state_operations.sql \
  backend/src/main/java/org/osi/server/desiredstate \
  backend/src/test/java/org/osi/server/desiredstate/DesiredStateMigrationIT.java
git commit -m "feat(sync): add desired state ledger"
```

---

### Task 2: Request creation and safe supersession

**Files:**

- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateView.java`
- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateService.java`
- Modify:
  `backend/src/main/java/org/osi/server/command/CommandService.java`
- Test:
  `backend/src/test/java/org/osi/server/desiredstate/DesiredStateServiceTest.java`
- Modify:
  `backend/src/test/java/org/osi/server/command/CommandServiceTest.java`

**Interfaces:**

- Produces:

```java
DesiredStateView request(
    Device gateway,
    User actor,
    DesiredStateService.Request request);
```

- `Request` contains `resourceType`, `resourceId`, `commandType`,
  `mutationKind`, `baseSyncVersion`, `desired`, `commandPayload`, `effectKey`,
  and `expiresAt`.
- Produces:

```java
DeviceCommand issueGatewayCommandRecord(
    Device device, String commandType, Map<String, Object> params, User actor,
    String aggregateType, String aggregateKey, Long targetSyncVersion,
    String eventUuid, String effectKey, Instant expiresAt);
```

- [ ] **Step 1: Write failing service tests**

Cover:

```java
requestCreatesPendingOperationAndCommand();
secondConfigEditReusesSafeUnleasedCommandAndSupersedesFirstOperation();
leasedConfigCommandIsNotRewrittenAndGetsANewCommand();
physicalEffectsNeverCoalesce();
physicalEffectRequiresFutureExpiryAndEffectKey();
negativeBaseVersionAndOversizedJsonAreRejected();
```

For coalescing, assert the new operation references the original command ID and
that `eventUuid`, `effectKey`, and command ID are unchanged while payload and
target version change.

- [ ] **Step 2: Run the focused tests and verify red**

```bash
cd backend
./gradlew test \
  --tests org.osi.server.desiredstate.DesiredStateServiceTest \
  --tests org.osi.server.command.CommandServiceTest \
  --no-daemon --max-workers=2
```

Expected: compilation failure because the service and record-returning command
method do not exist.

- [ ] **Step 3: Add the record-returning command seam**

Keep existing `Long` methods source-compatible by delegating to the new method:

```java
public Long issueGatewayCommand(/* existing arguments */) {
    return issueGatewayCommandRecord(/* existing arguments */,
            null, null).getId();
}
```

The record-returning method sets `effectKey` and `expiresAt` before the first
save. Existing valve validation and best-effort MQTT behavior remain intact.

- [ ] **Step 4: Implement request creation**

Inside one `@Transactional` method:

```java
long target = Math.addExact(request.baseSyncVersion(), 1L);
List<DesiredStateOperation> active =
        repository.lockActiveConfig(gatewayEui, resourceType, resourceId);
DesiredStateOperation prior = active.isEmpty() ? null : active.get(0);
DeviceCommand command = canRewrite(prior, request)
        ? rewriteCommand(prior.getCommand(), request, target)
        : issueCommand(gateway, actor, request, target);

DesiredStateOperation next = DesiredStateOperation.pending(
        gatewayEui, actor, command, request, target);
repository.save(next);
if (prior != null && request.mutationKind() == CONFIG) {
    prior.supersedeWith(next.getOperationUuid());
    repository.save(prior);
}
return DesiredStateView.from(next);
```

`canRewrite` requires same command type, `CONFIG`, status `PENDING` or `SENT`,
and all three lease fields null. Bound each JSON document to 64 KiB after
Jackson serialization and rejection detail to 512 characters.

- [ ] **Step 5: Run focused tests**

Expected: all Task 2 tests pass and existing command tests remain green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/command/CommandService.java \
  backend/src/main/java/org/osi/server/desiredstate \
  backend/src/test/java/org/osi/server/command/CommandServiceTest.java \
  backend/src/test/java/org/osi/server/desiredstate/DesiredStateServiceTest.java
git commit -m "feat(sync): persist desired state requests"
```

---

### Task 3: ACK transition integration

**Files:**

- Modify:
  `backend/src/main/java/org/osi/server/command/CommandAckController.java`
- Modify:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateService.java`
- Modify:
  `backend/src/test/java/org/osi/server/command/CommandAckControllerTest.java`
- Modify:
  `backend/src/test/java/org/osi/server/desiredstate/DesiredStateServiceTest.java`

**Interfaces:**

- Consumes:

```java
void observeAck(
    DeviceCommand command,
    String result,
    String detail,
    Instant acknowledgedAt,
    Long appliedSyncVersion);
```

- [ ] **Step 1: Add failing transition tests**

Test every result:

```java
appliedAckWaitsForMirrorAsAcknowledged();
retryableAckStaysPendingAndPreservesCommandIdentity();
permanentRejectionStoresStableReason();
expiredAckMarksOperationExpired();
conflictAckMarksOperationAndCommandConflicted();
ackForLegacyCommandWithoutOperationStillSucceeds();
ackForSupersededOperationDoesNotReopenIt();
```

Extend the controller fixture with `CONFLICT` and assert response status,
terminal flag, cleared lease, `ack_result='CONFLICT'`, and desired callback.

- [ ] **Step 2: Run focused tests and verify red**

```bash
cd backend
./gradlew test \
  --tests org.osi.server.command.CommandAckControllerTest \
  --tests org.osi.server.desiredstate.DesiredStateServiceTest \
  --no-daemon --max-workers=2
```

- [ ] **Step 3: Implement `observeAck`**

Look up the newest non-superseded operation for the command. Use this mapping:

```java
switch (normalizedResult) {
    case "APPLIED", "ACKED" -> operation.acknowledge(appliedAt);
    case "FAILED_RETRYABLE" -> operation.retryableFailure(detail);
    case "REJECTED_PERMANENT", "NACKED" ->
            operation.reject("edge_rejected", detail, appliedAt);
    case "EXPIRED" -> operation.expire("edge_expired", detail, appliedAt);
    case "CONFLICT" -> operation.conflict("base_version_conflict", detail, appliedAt);
    default -> { return; }
}
applyIfConverged(operation);
```

`applyIfConverged` requires an applied ACK plus a stored matching mirror.

- [ ] **Step 4: Enable `CONFLICT` in the ACK controller**

Treat it as terminal, clear the lease, set command status `NACKED`, preserve
`ackResult="CONFLICT"`, and return:

```java
new CommandAckEntryResult(command.getId(), "CONFLICT", null, true, false)
```

Call `observeAck` after every recognized command transition. The controller
transaction must roll back if desired-state persistence fails.

- [ ] **Step 5: Run focused tests**

Expected: all ACK and desired-state tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/command/CommandAckController.java \
  backend/src/main/java/org/osi/server/desiredstate/DesiredStateService.java \
  backend/src/test/java/org/osi/server/command/CommandAckControllerTest.java \
  backend/src/test/java/org/osi/server/desiredstate/DesiredStateServiceTest.java
git commit -m "feat(sync): reconcile desired state from ACKs"
```

---

### Task 4: Mirror convergence and conflict detection

**Files:**

- Modify:
  `backend/src/main/java/org/osi/server/sync/SyncEventTxExecutor.java`
- Modify:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateService.java`
- Test:
  `backend/src/test/java/org/osi/server/desiredstate/DesiredStateConvergenceIT.java`
- Modify:
  `backend/src/test/java/org/osi/server/sync/SyncEventApplierTest.java`

**Interfaces:**

- Consumes:

```java
void observeMirror(
    String gatewayEui,
    String resourceType,
    String resourceId,
    long syncVersion,
    Map<String, Object> canonicalPayload);
```

- [ ] **Step 1: Write failing convergence tests**

Cover:

```java
ackThenMatchingMirrorApplies();
matchingMirrorThenAckApplies();
matchingMirrorWithoutAckRemainsPending();
newerDifferentMirrorConflictsAndStoresCanonical();
sameBaseMirrorDoesNotConflict();
rejectedAndSupersededOperationsIgnoreMirrorTransitions();
```

Add a sync-executor test proving rejected, duplicate, stale, and retryable
events never invoke `observeMirror`.

- [ ] **Step 2: Run focused tests and verify red**

```bash
cd backend
./gradlew test \
  --tests org.osi.server.desiredstate.DesiredStateConvergenceIT \
  --tests org.osi.server.sync.SyncEventApplierTest \
  --no-daemon --max-workers=2
```

- [ ] **Step 3: Implement recursive subset comparison**

Use Jackson nodes:

```java
boolean containsDesired(JsonNode canonical, JsonNode desired) {
    if (desired.isObject()) {
        Iterator<String> fields = desired.fieldNames();
        while (fields.hasNext()) {
            String field = fields.next();
            if (!canonical.has(field)
                    || !containsDesired(canonical.get(field), desired.get(field))) {
                return false;
            }
        }
        return true;
    }
    return canonical.equals(desired);
}
```

Store canonical evidence for every relevant accepted mirror. If
`syncVersion > baseSyncVersion` and the desired subset does not match, mark
`CONFLICTED`. If it matches, retain pending evidence or apply when the ACK is
already present.

- [ ] **Step 4: Add the post-watermark hook**

In `SyncEventTxExecutor.applyOne`, call `observeMirror` after the watermark
upsert and before the terminal inbox flush:

```java
desiredStateService.observeMirror(
        gatewayDeviceEui,
        resource.resourceType(),
        resource.resourceId(),
        incomingSyncVersion,
        SyncEventShapes.payloadWithOp(event));
```

- [ ] **Step 5: Run focused and watermark tests**

Also run:

```bash
./gradlew test \
  --tests org.osi.server.sync.SyncResourceWatermarkRepositoryTest \
  --no-daemon --max-workers=2
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/sync/SyncEventTxExecutor.java \
  backend/src/main/java/org/osi/server/desiredstate/DesiredStateService.java \
  backend/src/test/java/org/osi/server/desiredstate/DesiredStateConvergenceIT.java \
  backend/src/test/java/org/osi/server/sync
git commit -m "feat(sync): converge desired state from edge mirrors"
```

---

### Task 5: Expiry and lease safety

**Files:**

- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateExpiryJob.java`
- Modify:
  `backend/src/main/java/org/osi/server/command/DeviceCommandRepository.java`
- Modify:
  `backend/src/main/java/org/osi/server/command/CommandLeaseService.java`
- Test:
  `backend/src/test/java/org/osi/server/desiredstate/DesiredStateExpiryJobTest.java`
- Modify:
  `backend/src/test/java/org/osi/server/command/DeviceCommandRepositoryDbTest.java`
- Modify:
  `backend/src/test/java/org/osi/server/command/CommandLeaseServiceTest.java`

**Interfaces:**

- Produces: `int expireDue(Instant now)`.
- Scheduled adapter calls it every 60 seconds.

- [ ] **Step 1: Write failing expiry tests**

Assert:

- overdue physical effects become `EXPIRED`;
- their `PENDING` or `LEASED` commands become `EXPIRED` with leases cleared;
- configuration operations are not expired by the physical-effect scan;
- lease candidates exclude commands with `expires_at <= now`;
- retry lease reclamation retains command ID, event UUID, and effect key.

- [ ] **Step 2: Run focused tests and verify red**

```bash
cd backend
./gradlew test \
  --tests org.osi.server.desiredstate.DesiredStateExpiryJobTest \
  --tests org.osi.server.command.DeviceCommandRepositoryDbTest \
  --tests org.osi.server.command.CommandLeaseServiceTest \
  --no-daemon --max-workers=2
```

- [ ] **Step 3: Implement deterministic expiry**

The job is only an adapter:

```java
@Scheduled(fixedDelayString = "${osi.desired-state.expiry-ms:60000}")
public void expire() {
    service.expireDue(Instant.now());
}
```

The service locks due rows, changes operation and command in one transaction,
and returns the number expired.

- [ ] **Step 4: Fence lease candidates**

Add this predicate to the native candidate query:

```sql
AND (c.expires_at IS NULL OR c.expires_at > :now)
```

- [ ] **Step 5: Run focused tests**

Expected: all expiry, repository, and lease tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/desiredstate \
  backend/src/main/java/org/osi/server/command \
  backend/src/test/java/org/osi/server/desiredstate \
  backend/src/test/java/org/osi/server/command
git commit -m "feat(sync): expire overdue desired effects"
```

---

### Task 6: Zone API proof and operation-status API

**Files:**

- Create:
  `backend/src/main/java/org/osi/server/desiredstate/DesiredStateController.java`
- Modify:
  `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java`
- Test:
  `backend/src/test/java/org/osi/server/desiredstate/DesiredStateControllerTest.java`
- Modify or create:
  `backend/src/test/java/org/osi/server/zone/IrrigationZoneDesiredStateTest.java`

**Interfaces:**

- Produces:
  `GET /api/v1/desired-state/operations/{operationUuid}`.
- Zone config `202` and zone list responses add nullable `desiredState`.

- [ ] **Step 1: Write failing controller tests**

Assert:

- an edge-backed zone config edit returns desired fields plus
  `desiredState.status == "pending"`;
- the request uses the zone's current `syncVersion` as base;
- a later zone list overlays active desired fields;
- another user cannot read the operation;
- terminal applied operations do not replace canonical zone fields;
- conflict responses retain desired and canonical maps.

- [ ] **Step 2: Run focused tests and verify red**

```bash
cd backend
./gradlew test \
  --tests org.osi.server.desiredstate.DesiredStateControllerTest \
  --tests org.osi.server.zone.IrrigationZoneDesiredStateTest \
  --no-daemon --max-workers=2
```

- [ ] **Step 3: Convert edge-backed zone config**

Build a complete expected zone-config subset using edge event snake_case keys,
merge request changes into it, and issue:

```java
DesiredStateView operation = desiredStateService.request(
        gateway.get(),
        user,
        new DesiredStateService.Request(
                "ZONE",
                zone.getZoneUuid(),
                "UPSERT_ZONE_CONFIG",
                CONFIG,
                zone.getSyncVersion(),
                desiredCanonical,
                commandPayload,
                "zone_config:" + zone.getZoneUuid() + ":" + zone.getSyncVersion(),
                null));
```

Return the existing pending representation with `operation` appended. For zone
list responses, query the latest visible `UPSERT_ZONE_CONFIG` operation and
overlay its desired fields while status is pending, acknowledged, conflicted,
rejected, or expired.

- [ ] **Step 4: Add creator-authorized status read**

Resolve the authenticated user and call:

```java
service.findForCreator(operationUuid, user.getId())
        .map(ResponseEntity::ok)
        .orElseGet(() -> ResponseEntity.notFound().build());
```

Return 404 for another user's operation.

- [ ] **Step 5: Run focused tests**

Expected: all controller tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/desiredstate/DesiredStateController.java \
  backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java \
  backend/src/test/java/org/osi/server/desiredstate/DesiredStateControllerTest.java \
  backend/src/test/java/org/osi/server/zone/IrrigationZoneDesiredStateTest.java
git commit -m "feat(zones): expose durable desired state"
```

---

### Task 7: Frontend normalization and reusable status UI

**Files:**

- Create: `frontend/src/types/desiredState.ts`
- Create: `frontend/src/components/sync/PendingStateNotice.tsx`
- Create:
  `frontend/src/components/sync/__tests__/PendingStateNotice.test.tsx`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types/farming.ts`
- Modify: `frontend/src/components/farming/IrrigationZoneCard.tsx`
- Create or modify:
  `frontend/src/services/__tests__/api.desiredState.test.ts`

**Interfaces:**

- Produces:

```ts
export type DesiredStateStatus =
  | 'pending' | 'acknowledged' | 'applied' | 'conflicted'
  | 'rejected' | 'expired' | 'superseded';

export interface DesiredStateOperation {
  operationUuid: string;
  status: DesiredStateStatus;
  resourceType: string;
  resourceId: string;
  commandId: number;
  commandUuid: string;
  effectKey: string | null;
  baseSyncVersion: number;
  targetSyncVersion: number;
  desired: Record<string, unknown>;
  canonical: Record<string, unknown> | null;
  rejectionCode: string | null;
  rejectionDetail: string | null;
}
```

- `PendingStateNotice` accepts `operation`, `resourceLabel`, and optional
  `onRetry`.

- [ ] **Step 1: Write failing normalization and component tests**

Cover camelCase and snake_case responses. Render assertions:

```tsx
expect(screen.getByText('Zone change is waiting for the hub')).toBeVisible();
expect(screen.getByText('Hub state differs from this edit')).toBeVisible();
expect(screen.getByRole('button', { name: 'Retry edit' })).toBeEnabled();
expect(screen.queryByRole('status')).not.toBeInTheDocument(); // applied
```

Also assert rejection details are rendered as text and never injected as HTML.

- [ ] **Step 2: Run tests and verify red**

```bash
cd frontend
npx vitest run \
  src/services/__tests__/api.desiredState.test.ts \
  src/components/sync/__tests__/PendingStateNotice.test.tsx
```

- [ ] **Step 3: Add normalization**

Keep the function in `api.ts`:

```ts
function normaliseDesiredState(raw: any): DesiredStateOperation | null {
  if (!raw) return null;
  return {
    operationUuid: String(raw.operationUuid ?? raw.operation_uuid),
    status: String(raw.status).toLowerCase() as DesiredStateStatus,
    resourceType: String(raw.resourceType ?? raw.resource_type),
    resourceId: String(raw.resourceId ?? raw.resource_id),
    commandId: Number(raw.commandId ?? raw.command_id),
    commandUuid: String(raw.commandUuid ?? raw.command_uuid),
    effectKey: raw.effectKey ?? raw.effect_key ?? null,
    baseSyncVersion: Number(raw.baseSyncVersion ?? raw.base_sync_version),
    targetSyncVersion: Number(raw.targetSyncVersion ?? raw.target_sync_version),
    desired: raw.desired ?? raw.desired_json ?? {},
    canonical: raw.canonical ?? raw.canonical_json ?? null,
    rejectionCode: raw.rejectionCode ?? raw.rejection_code ?? null,
    rejectionDetail: raw.rejectionDetail ?? raw.rejection_detail ?? null,
  };
}
```

Call it only from response normalizers. Do not normalize in React components.

- [ ] **Step 4: Implement and consume `PendingStateNotice`**

Return `null` for applied and superseded. Use `role="status"` for pending and
`role="alert"` for conflicted, rejected, and expired. Render it near the top of
`IrrigationZoneCard`.

- [ ] **Step 5: Run focused and complete frontend gates**

```bash
cd frontend
npm run test:unit
NODE_OPTIONS=--max-old-space-size=2048 npm run build
```

Expected: all tests pass and the production build exits zero.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/desiredState.ts \
  frontend/src/components/sync \
  frontend/src/services/api.ts \
  frontend/src/services/__tests__/api.desiredState.test.ts \
  frontend/src/types/farming.ts \
  frontend/src/components/farming/IrrigationZoneCard.tsx
git commit -m "feat(ui): show desired state convergence"
```

---

### Task 8: Full integration and acceptance

**Files:**

- Modify tests found deficient by the full run, but do not widen behavior.
- Modify the execution report in OSI OS after the server SHA is fixed.

**Interfaces:**

- Consumes all prior Task 4 interfaces.
- Produces the server commit recorded in the parity execution report.

- [ ] **Step 1: Run focused desired-state integration**

```bash
cd backend
./gradlew test \
  --tests 'org.osi.server.desiredstate.*' \
  --tests org.osi.server.command.CommandAckControllerTest \
  --tests org.osi.server.command.CommandLeaseServiceTest \
  --tests org.osi.server.sync.SyncEventApplierTest \
  --tests org.osi.server.zone.IrrigationZoneDesiredStateTest \
  --no-daemon --max-workers=2
```

Expected: command creation, ACK, mirror convergence, conflict, supersession,
retry, and expiry all pass.

- [ ] **Step 2: Run the full backend suite**

Sample memory first, then:

```bash
cd backend
NODE_OPTIONS=--max-old-space-size=2048 \
  ./gradlew test --no-daemon --max-workers=2
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Run complete frontend gates**

```bash
cd frontend
npm run test:unit
NODE_OPTIONS=--max-old-space-size=2048 npm run build
```

Expected: all Vitest files pass and the build exits zero.

- [ ] **Step 4: Review the cumulative server diff**

Verify:

- no production configuration or credentials changed;
- no direct cloud mutation claims edge success;
- every recognized ACK updates command and desired state atomically;
- leased and physical-effect commands are never rewritten;
- retries keep command ID, event UUID, and effect key;
- mirror callbacks run only for accepted events;
- frontend normalization remains in `api.ts`;
- the new migration is the next free Flyway version.

- [ ] **Step 5: Commit any final test-only corrections, push, and record**

```bash
git status --short --branch
git diff --check
git push origin AgroLink
```

Update
`docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-execution-report.md`
with the server SHA, transition evidence, memory samples, and any repaired
baseline defect. Run the anti-slop checker, commit, and push
`design-sync/agrolink`.
