# AgroLink edge/cloud parity launch matrix

**Purpose:** Seed Task 0 with code-verified program boundaries and known gaps.
This is not the final route-by-route inventory. The executor must regenerate
that inventory at the launch head and replace assumptions with commands, tests,
and commit SHAs.

**Audited heads (2026-07-23):**

- OSI OS `design-sync/agrolink`: `f5ca4a1f`
- OSI Server `main`, source of `AgroLink`: `8cac33d`

## Status rules

| Status | Meaning |
|---|---|
| `parity` | Portable behavior exists on both sides and has current evidence |
| `cloud-missing` | Portable edge behavior has no complete server counterpart |
| `edge-missing` | Portable cloud behavior has no complete edge counterpart |
| `partial` | Both sides contain part of the workflow, but semantics or coverage differ |
| `edge-only` | Deliberately hardware-local or gateway-operational |
| `cloud-only` | Deliberately fleet-wide or server-operational |
| `deferred` | Explicitly postponed with a trigger or maintainer decision |

## Portable workflow seed

| Surface | Launch status | Evidence and gap | Owning task |
|---|---|---|---|
| Gateway identity and location mirror | `partial` | Live EUI resolution and `GatewayLocationApplier` exist; Task 0 must prove the complete create/update/replay path | Tasks 0 and 8 |
| Zones, zone configuration, and zone location | `partial` | Edge APIs, outbox operations, and pending command handlers exist; cloud optimistic desired-state and conflict behavior remain incomplete | Tasks 4 and 8 |
| Irrigation schedules | `partial` | Edge schedule mutations and cloud pending commands exist; current route, field, version, and conflict parity require inventory | Tasks 4 and 8 |
| Device provisioning and registration | `partial` | Bootstrap, registration, bulk claim, assignment, and command paths already exist; do not redesign provisioning | Tasks 0, 7, and 8 |
| Device assignment, flags, configuration, and unclaim | `partial` | Multiple pending command types exist; Task 0 must map device-family coverage and authorization | Tasks 7 and 8 |
| Journal entries | `cloud-missing` | Edge storage, UI, five event operations, and five command handlers exist; full server mirror/API/UI/issuer does not | Task 5 |
| Farm history mirror | `partial` | Legacy durable delivery remains; the new batch mapper covers `device_data` only | Task 9 |
| Analysis and recommendations | `partial` | Both repositories contain analysis surfaces; input, scope, missing-data, and result semantics need route-level comparison | Task 8 |
| Account scope and per-gateway grants | `partial` | Accepted Phase A patch material exists off target; Phases B-D and server enforcement remain open | Tasks 1, 3, 6, and 7 |
| Cloud access administration | `cloud-missing` | Product decision requires durable edge-approved commands; the old Phase E plan is superseded | Task 7 |
| Installation recovery | `cloud-missing` | No stable `installation_uuid` recovery model or encrypted recovery bundle exists | Task 10 |
| Optimistic zone and journal edits | `cloud-missing` | UX decision is immediate local desired state with background sync; durable state machine is not complete | Tasks 4 and 5 |

## Deliberate product split

| Surface | Status | Reason |
|---|---|---|
| ChirpStack bootstrap and local device-server administration | `edge-only` | Requires gateway hardware and local services |
| Local network and AgroLink network-drive transport | `edge-only` | Final design and plan are boundary inputs; future tables and imported readings do not enter sync |
| Fan, filesystem, database download, and firmware controls | `edge-only` | Gateway operations, not portable farm workflows |
| Fleet administration and server operations | `cloud-only` | Cross-installation operational scope |
| Encrypted recovery storage | `cloud-only` | Server custody; restored state still becomes edge-canonical |
| Incremental bootstrap snapshots | `deferred` | Existing plan defers until scale or measured load justifies the complexity |
| Schema-driven DTO generation | `deferred` | Superseded by the narrow schema/contract ownership ADR; do not execute |
| Legacy history-path removal | `deferred` | Requires maintainer approval after the durable batch path converges |

## Contract and catalog baseline

- The audited edge flow contains 17 active event operation strings.
- The edge seed and server operation mirror contain 18 operation strings.
- The governed event schema contains 23 operation strings.
- Five journal operations are intentionally staged but not enabled for cloud
  production until server acceptance is proven.
- The supported device baseline is KIWI, TEKTELIC CLOVER, DRAGINO LSN50,
  SENSECAP S2120, AQUASCOPE LORAIN, and STREGA.
- UC512 remains schema-compatible but hidden from the supported parity catalog.

Task 0 must derive these counts again, enumerate every HTTP and GUI route,
controller, event, command, resource schema, and capability, then add an
evidence column containing a test, verifier, or commit SHA for every `parity`
claim.
