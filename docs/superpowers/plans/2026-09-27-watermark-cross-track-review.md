# WATERMARK cross-track plan review

**Date:** 2026-09-27
**Scope:** phase 1 implementation, the Chameleon command prerequisite, WATERMARK
phase 2, WATERMARK phase 3, and the dry-down bench gate. This is a plan review;
it does not authorize deployment, production access, or field use.

**Status update (2026-09-29).** Step 1 of the landing order below is done:
phase 1 is on main as `ca08dcc13` (#366). It shipped with migration
`0061__watermark_lsn50.sql`, because the RAK10701 field-tester migration took
`0060` first, so phase 2 and phase 3 move to `0062` and `0063`. The phase 3 E1
analyzer is implemented. The Chameleon prerequisite, phase 2 and phase 3 E2+
are still plans only. The review text below is kept as written on 2026-09-27
apart from neutral EUIs; its "phase 1 head" is the pre-merge branch head.

## Outcome

Phase 1 remains the only implementation-ready track. The three later plans are
not ready for execution:

1. the Chameleon prerequisite violates edge authority and lacks a mixed-fleet
   capability gate, effect-key binding, and an exact-base compare-and-set;
2. phase 2 has metadata, numeric-type, desired-state rewrite, and bootstrap
   convergence defects;
3. phase 3's detailed tasks still implement the rejected
   `devices.watermark_enabled` design, and its analyzer sketch can pass invalid
   bench data.

The plan files now carry binding amendments and an explicit non-executable
status. No application code was changed.

## Confirmed decisions

- Phase 2 P2-1 through P2-7 are accepted: calibration-existence indicator,
  `base_sync_version`, metadata sync, device-level history classification until
  raw sync exists, calibration bootstrap, owner/admin access for unzoned bench
  devices, and MQTT liveness from WATERMARK ingest.
- Phase 3 OD-1 through OD-8 are accepted: current-calibration enable proof,
  automatic scheduler exclusion after calibration change, symmetric Chameleon
  exclusion, all raw rows, 365-day cloud retention, an edge-versioned unsettled
  rule, `watermark_scheduler_v1`, and a procedural field-use gate.
- OD-9 uses a calibration-bound admission resource. WATERMARK does not add a
  scheduler flag to `devices`.

## Blocking findings

### B1. Chameleon cloud mutation bypasses edge authority

The current prerequisite plan calls `DeviceService.setChameleonEnabled` before
queueing the gateway command. The current service writes the cloud
`devices.chameleon_enabled` mirror and increments its `sync_version`; the
controller then returns `200` with that mutated device. The gateway may still
drop the command, so the response and mirror can claim a state the edge never
accepted.

Required correction:

- validate and queue through `DesiredStateService` without writing the mirror;
- return `202` pending state;
- let the edge DEVICE event be the only mirror writer and convergence signal;
- advertise and require `chameleon_config_commands_v1`, so old gateways never
  receive the newly supported command;
- use `chameleon_config:<EUI>:<base>` because
  `DesiredStateService.validate` requires a nonblank effect key; bind its EUI
  and base in `effect-keys.md`, `commands.schema.json`, both contract
  validators, the cloud command/desired-state rows, and the edge terminal
  ledger;
- apply only when the edge DEVICE version equals the quoted base. The generic
  `sync_version <= target` SQL can overwrite an independent edge edit already
  at `base + 1`. Command replay returns the durable terminal result without a
  second write.

This also changes rollout from "either order is safe" to cloud first, then an
edge that advertises the capability.

### B2. Phase 2 metadata-only commands can converge before application

P2-3 syncs `measured_at`, `method`, `worst_residual_pct`, and `notes`, and the
cloud form sends all four. The original C4 sketch excluded those fields from
the desired value. A request that changed only notes therefore matched the old
mirror immediately and could appear APPLIED without an edge event carrying the
new notes.

Required correction: desired-state comparison includes all eight resistor
values and all four explicit metadata fields, including nulls. C4 needs a
metadata-only convergence test. Its `wireNumber` helper must use explicit
`if`/`return`: Java promotes the `Integer` and `Double` arms of the proposed
conditional expression to `Double`, recreating the `IntNode`/`DoubleNode`
conflict it was meant to avoid.

### B3. Phase 3 detailed tasks encode the rejected storage model

The original phase 3 plan adds `devices.watermark_enabled`, regenerates the
frozen boot node's `DEVICES_COLUMNS`, decorates DEVICE events, and targets the
DEVICE resource in desired state. Besides conflicting with OD-9, the plan
admits that an unrelated device update can produce `mirror_diverged` while the
edge later applies the WATERMARK command.

Required correction: use `watermark_scheduler_admissions` with its own version
and accepted calibration version. Sync it as
`WATERMARK_SCHEDULER_ADMISSION_UPSERTED`; target that resource in desired state;
bootstrap it separately. `SET_WATERMARK_CONFIG` uses
`watermark_scheduler_admission:<EUI>:<base>` with contract and ledger binding.
No `devices` column or boot-node edit is required.

The detailed E2-E9 and C1/C3/C5/C6 sketches must be rewritten. A name-only
replacement would miss transaction, event-ordering, bootstrap, D7, and desired
state changes.

### B4. The shared desired-state rewrite can detach payload from effect key

`DesiredStateService.canRewrite` currently reuses an unleased same-type command
without comparing the new base or effect key. The rewrite changes payload and
target version but not `device_commands.effect_key`; the edge ACK then carries
the new payload key and the cloud rejects it against the old persisted key.

Required correction: reuse only when base and effect key both match. A changed
binding issues a new command and supersedes the prior operation. Add the shared
service regression before either Chameleon or WATERMARK starts using the
ledger. Reclaimed leases remain non-rewritable because their lease timestamps
are retained.

### B5. Bootstrap bypasses desired-state convergence observation

Phase 2 C3 calls the calibration applier directly for synthetic bootstrap rows,
outside `SyncEventTxExecutor.observeMirror`. An APPLIED ACK followed only by
bootstrap can therefore remain ACKNOWLEDGED forever. Phase 3 admission
bootstrap has the same risk.

Required correction: after successful bootstrap apply, reload the retained
newest mirror and call `DesiredStateService.observeMirror` with that row. If an
older incoming item lost to a newer stored version, notify with the stored
version and payload, not the stale input.

### B6. The phase 3 bench gate is not executable

The dry-down protocol still mixed the historical EUI (`<previous-device-eui>`)
with the now connected and registered one (`<device-eui>`). The new EUI must be bound to
the same physical board, firmware image, and calibration record before any
coefficients or database query move to it.

The E1 analyzer sketch also has four acceptance defects: P1 checks only
nonempty files rather than both channels times four resistors before and after;
P6 drops unmatched temperature references; `deriveEnvelope` can select a
candidate with no rows actually below it; and P5 is evaluated under per-probe
envelopes instead of the final deployed global envelope. Each old behavior
needs a failing regression fixture before the bench run.

## Required invariants in the rewrite

1. Calibration update and its admission-version advance commit in one SQLite
   transaction. Write the calibration first and admission second so their
   local outbox rows record the causal order; cloud ingest must still tolerate
   reordered delivery.
2. Calibration delete and admission disable commit in one transaction.
3. Scheduler input requires the admission, live calibration, and raw reading to
   name the same calibration version.
4. The two mutual-exclusion writers check and mutate within their respective
   write transactions. UI disabling is explanatory, not the safety boundary.
5. An admission command fences both the admission base version and the
   calibration version the person accepted; the two conflicts have distinct
   reason codes.
6. Edge events/bootstrap are the only cloud-mirror writers. User requests only
   create desired-state operations.
7. Cloud support lands before any edge emits the new admission or raw-reading
   event.
8. An enabled admission row must explicitly require a non-null calibration
   version; SQLite accepts NULL-valued CHECK expressions.
9. Every newly accepted admission command advances from exact base to
   `base + 1` and emits a mirror event, even for the same values, so ACK plus
   mirror can reach APPLIED. Redelivery of the same command ID performs no
   second write.
10. Cloud admission ingest tolerates calibration/admission reordering. It may
    retain the admission observation, but effective state stays disabled until
    the calibration version matches. Ordering alone is never a terminal dead
    letter.

## Accepted limitations and follow-ups

- Until phase 3 raw provenance lands, phase 2 classifies historical LSN50 rows
  by current calibration state. Pre-reflash history can therefore carry the
  wrong WATERMARK/Chameleon label. This was accepted as the least invasive
  phase 2 behavior.
- A WATERMARK board without a calibration is not identifiable in the phase 2
  cloud mirror. The capability-gated calibration form remains available for
  LSN50 devices.
- Raw reading events are droppable telemetry. A pruned event is not healed by
  history sync v1. The edge remains the full local diagnostic history.
- Phase 1 can report `backfill_incomplete`; automatic resume and timeout
  handling remain follow-up work.
- Terra/prediction inputs do not use scheduler admission in these phases.
- No unsettled-reading relaxation or field scheduling ships unless the bench
  protocol passes all six criteria.

## Exact rewrite checklist

**Chameleon prerequisite**

- Replace Task 1's mirror mutation and `200 DeviceResponse` with a
  capability-gated `DesiredStateService.Request` and `202` operation response.
- Add `base_sync_version`, `chameleon_config:<EUI>:<base>`, contract semantic
  binding, an exact-base edge applier, and durable replay.
- Replace Task 2's generic `sync_version <= target` route and every claim that
  either deploy order is safe.

**Phase 2**

- C3 reloads the retained calibration mirror after bootstrap apply and calls
  `observeMirror`; test newer-retained/older-incoming behavior.
- C4 adds all four metadata keys to desired state, replaces the promoted
  numeric ternary with explicit returns, and tests runtime number classes.
- Before C4, restrict shared command rewrite to the same base/effect binding
  and add the regression to `DesiredStateServiceTest`.

**Phase 3**

- E1 replaces the P1, P5, P6, and envelope-selection tests named in B6. The
  bench protocol stays blocked until physical-board identity is recorded.
- E2-E4 create and own `watermark_scheduler_admissions`; the CHECK includes
  explicit non-null calibration binding, and calibration/admission transitions
  share one edge transaction.
- E3/E6/C5 bind `watermark_scheduler_admission:<EUI>:<base>` through both
  contracts, both ledgers, exact-base apply, same-value version advance, and
  replay-without-rewrite tests.
- C1/C3 store admission independently, tolerate calibration reordering, notify
  desired-state convergence from the retained bootstrap mirror, and compute
  effective enabled state fail-closed.
- E5/E7/E8/E9/C6 read the admission resource instead of `Device`; remove every
  boot-node, DEVICE decorator, and `watermark_enabled` instruction.

## Revised landing order

1. Merge phase 1 after its existing verification evidence is refreshed on the
   final base.
2. Land the shared desired-state rewrite guard and its regression on the cloud
   base used by all three tracks.
3. Rewrite and implement the Chameleon prerequisite, including its command
   contract. Deploy cloud support and capability handling first, then the edge
   applier/capability.
4. Rebase phase 2 onto phase 1 plus the Chameleon pair. Rewrite C3/C4 for
   bootstrap observation, metadata convergence, and number types, then
   implement. Deploy osi-server before osi-os.
5. Rewrite E1 and pass the identity preflight. The dry-down can run alongside
   phase 2 only after both gates are green.
6. Rebase phase 3 onto the completed phase 2 branches. Rewrite every task named
   in B3, implement cloud support first, then edge. Do not enable field
   scheduling until the bench gate passes.

The read-only merge-tree check found no textual conflict between the current
phase 1 and Chameleon plan branches, so landing the already implemented phase 1
first minimizes rework. Both later branches still require semantic rebasing and
full gates; a conflict-free rebase is not verification.

## Review evidence

- Phase 1 head: `238e855a5` (`feat/watermark-lsn50`), later squash-merged to
  main as `ca08dcc13`.
- Chameleon plan head: `5caf24131` (`feat/chameleon-enabled-cmd-fix`).
- Phase 2 plan head before this review: `8d35fa4ca`
  (`feat/watermark-phase2`).
- Phase 3 plan head before this review: `8a175a97e`
  (`feat/watermark-phase3`).
- osi-server evidence: `DeviceController#setChameleonEnabled` calls
  `DeviceService.setChameleonEnabled`; that service writes
  `chameleon_enabled` and increments `sync_version` before
  `SET_CHAMELEON_ENABLED` is queued.
- `DesiredStateService.validate` calls `requireText(request.effectKey(),
  "effectKey", 255)` for every mutation kind. `canRewrite` compares command
  type and lease state but not base/effect binding; `CommandService` rewrites
  payload and applied version without changing the persisted effect key.
- `SyncEventTxExecutor` calls `DesiredStateService.observeMirror` after a normal
  event apply. Direct bootstrap-applier calls bypass that convergence hook.
- `MqttMessageRouter.handleTelemetry` returns after `heartbeatDevice` for
  gateway-forwarded non-STREGA sensors; P2-7 restores auto-create and
  `last_seen`, not `current_state`.

No phase 2, phase 3, or Chameleon implementation tests were run because those
tracks contain plans only and this review deliberately made no application-code
changes.
