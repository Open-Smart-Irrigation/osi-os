# SDI-12 recipe deployment design

**Date:** 2026-08-29  
**Status:** Draft for operator review  
**Scope:** OSI OS edge and React GUI  
**Related design:** `docs/superpowers/specs/2026-08-25-sentek-enviroscan-vwc-vic-design.md`

## Problem

The Sentek settings endpoint stores `sdi12_channel_layout_json`, but it does not
program the Dragino SDI-12-LB/LS command slots. The GUI can therefore show a
saved layout while the converter still runs an older address or recipe. The
Identify path has a second mismatch: `sdi12-identify-trigger-fn` always sends
`0I!`, even when the saved Sentek layout uses another address.

The field session on 2026-08-28 and 2026-08-29 separated these defects from the
live bus symptom. Raw tests against addresses `C`, `0`, and `L` each returned
`F1 00`, which is the Dragino framing for zero returned bytes. Layout parsing
cannot create that result because it occurs before normalization. The backend
defects still need repair so future commissioning state is represented honestly.

## Goals

- Identify a configured Sentek probe at the address stored in its canonical
  channel layout.
- Compile the bench-approved Sentek acquisition recipe on the edge. The browser
  cannot submit command strings, byte cuts, or arbitrary downlink bytes.
- Acquire VWC from all eight installed modules and VIC from the two installed
  TriSCAN modules at response positions 1 and 5.
- Make recipe application an explicit operator action after layout save.
- Record desired, queued, and observed recipe state in SQLite.
- Keep the switched 12 V window at 8000 ms and the ordinary 1200-second
  reporting interval during commissioning.
- Preserve the last observed-compatible recipe so an operator can reapply it.
- Treat missing or malformed sensor data as missing. Recipe deployment cannot
  manufacture zero-valued readings.

## Non-goals

- OSI does not modify Sentek calibration, normalization coefficients, module
  addresses, probe address, or configured depths over SDI-12. PConfig remains
  authoritative for probe-internal state.
- Recipe deployment state is local operational state. It is not copied into the
  edge-to-cloud farm resource contract.
- The first release does not apply recipes for nine or ten modules. Those layouts
  remain valid and saveable, but `D3!` framing needs a bench capture first.
- The workflow does not use continuous 12 V power.
- The workflow does not flush the ChirpStack device queue.

## Safety invariants

1. A layout save never claims that converter configuration was applied.
2. Only a server-side compiler can construct Dragino frames.
3. Every compiled command begins with the validated layout address.
4. The compiler owns command and cut slots 1 through 15 for a Sentek device.
   It overwrites active slots before clearing only the unused tail.
5. Configuration frames are idempotent. Retrying a partially queued deployment
   may repeat frames without changing their meaning.
6. `queued` means ChirpStack accepted every frame. It does not mean the Class A
   device received them.
7. Two consecutive complete readings matching the desired layout are required
   for `observed_compatible`.
8. A failed deployment leaves previous finite readings visible with their
   timestamps. It cannot rewrite them or substitute zeros.
9. Automated deployment never shortens the reporting interval. The final queued
   frame idempotently enforces `TDC=1200` seconds.
10. The 12 V configuration frame is always `07031F40` (`AT+12VT=8000`).

## Supported recipe shapes

The first compiler accepts these shapes:

| Layout | Apply support | Evidence |
|---|---:|---|
| 1–8 EnviroSCAN modules, no TriSCAN | yes | Five- and eight-value bench captures plus the Sentek three-values-per-data-response boundary |
| Eight modules with exactly two TriSCAN modules | yes | Complete 2026-08-28 VWC/VIC bench capture |
| Any layout with 9–10 modules | no | `D3!` response framing has not been captured |
| Mixed layout with one or more than two TriSCAN modules | no | Compact `M2!` cardinality has not been captured for those shapes |

An unsupported but valid layout returns HTTP 409 with
`recipe_shape_unverified`. It remains stored and usable for manual converter
commissioning.

## First field probe

The first field deployment targets the probe closed on the lab bench on
2026-08-28. Its SDI-12 address is the digit `0`, not the letter `o`. The saved
layout is:

| Response position | Depth | Module |
|---:|---:|---|
| 1 | 10 cm | TriSCAN |
| 2 | 20 cm | EnviroSCAN |
| 3 | 30 cm | EnviroSCAN |
| 4 | 40 cm | EnviroSCAN |
| 5 | 50 cm | TriSCAN |
| 6 | 60 cm | EnviroSCAN |
| 7 | 80 cm | EnviroSCAN |
| 8 | 100 cm | EnviroSCAN |

The compiler must emit the captured mixed recipe for this layout:

```text
AT+COMMAND1=0M!,1,1,2
AT+COMMAND2=0D1!,0,0,2
AT+COMMAND3=0D2!,0,0,2
AT+COMMAND4=0M2!,1,1,2
AT+DATACUT1=30,2,2~28
AT+DATACUT2=30,2,2~28
AT+DATACUT3=21,2,2~19
AT+DATACUT4=21,2,2~19
```

The expected normalized shape is eight VWC values followed by two VIC values.
The first field apply remains operator-triggered after the physical probe swap
and saved-layout check. It cannot run merely because this target is present in
the design. Address `0` is a field-layout value, not a compiler constant or
default.

## Recipe compiler

The compiler is a focused CommonJS module named `osi-sdi12-recipe`. Node-RED
loads it through `osiLib.require('sdi12-recipe')`. Its public surface is:

```js
compileSentekRecipe(layout) -> {
  ok: true,
  recipe: {
    version: 1,
    profile: 'SENTEK_ENVIROSCAN',
    address: layout.address,
    layoutHash: '<sha256>',
    normalIntervalSeconds: 1200,
    powerWindowMs: 8000,
    slots: [{ slot, command, cut }],
    frames: [{ purpose, hex, base64 }]
  }
}

compileSentekRecipe(layout) -> {
  ok: false,
  code: 'recipe_shape_unverified' | 'invalid_layout',
  message: string
}

canonicalLayoutHash(layout) -> '<sha256>'
```

The module calls the existing `validateSentekLayout()` implementation before
compilation. It hashes canonical JSON produced from the validated layout; input
property order cannot change the hash.

### VWC commands and cuts

Sentek returns at most three VWC values per `D` response. For `N` configured
modules, the compiler partitions `N` into groups of at most three:

```text
group 1: address + M! with automatic D0 access
group 2: address + D1!
group 3: address + D2!
```

The first group uses `<address>M!,1,1,2`. Later groups use
`<address>D1!,0,0,2` and `<address>D2!,0,0,2`. A group containing `k` values
has a total response length of `3 + 9*k` bytes: one address byte, nine bytes per
signed value, then CR/LF. Its cut is:

```text
AT+DATACUTx=(3 + 9*k),2,2~(1 + 9*k)
```

This reproduces the bench values `30,2,2~28` for three readings and
`21,2,2~19` for two readings. The cut removes the address and CR/LF, preserving
the normalizer grammar.

### TriSCAN command and cut

For the supported mixed shape, slot 4 uses
`<address>M2!,1,1,2`. Two compact VIC values use the captured cut
`21,2,2~19`. The VWC slots are unchanged because every TriSCAN module also
contributes VWC to the ordinary `M!` group.

### Downlink frame order

The compiler emits frames in this order:

1. `07031F40` (`12VT=8000`).
2. `AB01` (`ALLDATAMOD=1`).
3. `AE02` (`PAYVER=2`).
4. `AD01` (`DATAUP=1`).
5. `A90D09` (default SDI-12 timing).
6. One `0xAF` command frame and one `0xAF` cut frame per active slot.
7. `09 <first-unused-slot> 0F` when at least one tail slot is unused.
8. `010004B0` (`TDC=1200`).

No frame sets a shorter TDC. At the normal 20-minute cadence, the largest
supported recipe needs at most fifteen Class A cycles, or about five hours.
This delay is preferable to a partial-enqueue failure that could strand a solar
node at a one-minute interval.

The `0xAF` encoder accepts only compiler-produced ASCII. Its frame is
`AF | slot | selector | length | ASCII bytes | 00`, where selector `01` writes
`AT+COMMANDx` and selector `02` writes `AT+DATACUTx`. The trailing `00` avoids
an extra uplink after each write.

The device executes its current recipe before receiving the next Class A
downlink. Intermediate cycles may therefore combine one new command with an old
cut, or vice versa. Exact cardinality and grammar checks quarantine those cycles.
The deployment state stays `queued` until a complete desired-shape reading
arrives.

## Durable edge state

Ordered additive migration `0049__sdi12_recipe_deployments.sql` creates two
local-only tables. The first stores recipe state:

```sql
CREATE TABLE sdi12_recipe_deployments (
  deveui TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  desired_version INTEGER NOT NULL DEFAULT 0,
  desired_layout_hash TEXT,
  desired_recipe_json TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'not_applied','queueing','queued','observed_once',
    'observed_compatible','degraded'
  )),
  queue_item_ids_json TEXT,
  queued_at TEXT,
  queue_drained_at TEXT,
  commissioning_deadline_at TEXT,
  observed_count INTEGER NOT NULL DEFAULT 0,
  failed_observation_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at TEXT,
  last_error_code TEXT,
  compatible_recipe_json TEXT,
  compatible_at TEXT,
  updated_at TEXT NOT NULL
);
```

The second stores the two-stage address discovery and identity operation:

```sql
CREATE TABLE sdi12_identify_attempts (
  deveui TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('discovering','identifying')),
  discovered_address TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The migration updates `database/seed-blank.sql` and all bundled database copies.
It does not touch the frozen Node-RED boot DDL.

Saving a valid Sentek layout upserts `not_applied`, increments
`desired_version`, stores the new layout hash, resets observation fields, and
preserves `compatible_recipe_json`. The save and device update occur in one
SQLite transaction. The save returns HTTP 409 while the current deployment is
`queueing` or `queued`; an in-flight physical recipe cannot be relabelled with a
new logical layout.

## Apply endpoint

`POST /api/devices/:deveui/sdi12/recipe/apply` uses the existing authenticated,
device-scoped endpoint pattern. The request body is empty.

The handler:

1. Loads the canonical stored layout and device ChirpStack registration data.
2. Refuses malformed, absent, or unsupported layouts before any external effect.
3. Compiles the recipe and writes `queueing` in SQLite.
4. Verifies that the device queue is empty, then enqueues every frame through an
   extended `osi-chirpstack-helper` gRPC method.
5. Stores all returned queue-item IDs and changes the state to `queued`.
6. Returns HTTP 202 with the recipe version, layout hash, frame count, and state.

The helper adds `enqueueDeviceDownlink({ devEui, fPort, confirmed, data })` and
`listDeviceQueue(devEui)`. They use ChirpStack `DeviceService.Enqueue` and
`DeviceService.GetQueue`. Enqueue returns the queue-item ID. No caller can
select another device after the authenticated handler resolves the EUI.

A non-empty pre-existing queue returns HTTP 409 with
`device_queue_not_empty`. The recipe workflow never flushes or silently moves
another command. The transition into `queueing` uses `BEGIN IMMEDIATE` and a
compare-and-set on the current deployment state, so two apply requests cannot
both pass the active-state check. If the queue preflight then finds another
command, the row returns to `not_applied` and records
`device_queue_not_empty`.

If enqueue fails after some frames were accepted, the handler records
`degraded`, the accepted IDs, and a bounded `last_error_code`. It does not flush
the queue. Re-applying the same desired version is allowed because all frames
are idempotent.

An existing `queueing` or `queued` deployment for the same desired version
returns HTTP 409. This prevents two browser requests from interleaving recipe
frames. Other desired versions may be applied only after the prior attempt is
`degraded` or observed.

## Status projection

The existing device-list response adds an `sdi12_recipe_deployment` object for
local DRAGINO_SDI12 rows. It contains the desired version, layout hash, status,
queue and observation timestamps, frame count, and bounded error code. It does
not expose recipe command strings or queue-item IDs. The field is absent for
other device types and is not added to sync resource schemas.

## Rollback endpoint

`POST /api/devices/:deveui/sdi12/recipe/rollback` validates the stored recipe
version and enqueues the exact frames in `compatible_recipe_json`. It returns
HTTP 409 when no compatible recipe has been observed. Rollback is an explicit
reapplication; it does not claim that the converter exposes readable
command-slot state.

## Observation state machine

An edge-local 60-second worker polls `listDeviceQueue()` for active deployments.
When none of the stored recipe queue-item IDs remain, it records
`queue_drained_at`. This means ChirpStack no longer holds the frames; it does not
claim that an unconfirmed downlink was interpreted by the converter. A recipe
whose IDs remain queued beyond `commissioning_deadline_at` becomes `degraded`
with `queue_delivery_timeout`. The deadline is eight hours after enqueue, which
covers fifteen cycles at the normal 20-minute interval plus network delay.

The existing SDI-12 writer receives the deployment row alongside the device
configuration. Compatibility observation starts only after `queue_drained_at`
is set. After normal parsing and storage:

- A complete reading with the desired profile, layout hash, and exact VWC/VIC
  cardinality moves `queued` to `observed_once` and sets `observed_count=1`.
- The next consecutive matching reading moves the state to
  `observed_compatible`, copies `desired_recipe_json` into
  `compatible_recipe_json`, and records `compatible_at`.
- A no-response, incomplete segment set, parser quarantine, or cardinality
  mismatch resets `observed_count` to zero but does not delete readings.
- Three consecutive failed desired-shape acquisition cycles after the queue has
  drained move the state to `degraded` with a stable error code.

Observation updates are best-effort operational writes. A failure to update the
deployment table emits `node.warn` but does not block valid telemetry storage.

## Address-aware Identify

`sdi12-identify-action-fn` selects `sdi12_channel_layout_json`. When the stored
layout validates, it passes that address to `sdi12-identify-trigger-fn`, which
builds `<address>I!` and records stage `identifying`.

When no saved address exists, Identify records stage `discovering` and sends the
address-neutral SDI-12 query `?!` through the Dragino `0xA8` command. A valid
one-character discovery response is stored in `discovered_address`; the flow
then sends `<discovered_address>I!` and moves to stage `identifying`. The normal
identity response completes the existing profile match. Discovery rejects an
empty response, more than one returned address, or any byte outside the
one-character SDI-12 address grammar.

A malformed stored layout returns HTTP 409 instead of falling back to another
address. Saving a manual layout cancels an older discovery attempt. A pending
discovery never overrides the address in a newer saved layout.

Recipe addresses come only from `validateSentekLayout()`, whose accepted SDI-12
address grammar is one alphanumeric character. Identify addresses come from the
same validator or a valid `?!` response. No runtime path defaults to address
`0`, `L`, `C`, or another probe-specific value.

## GUI behavior

The Sentek settings modal keeps layout save and hardware application separate.
After save it shows `Layout saved; acquisition configuration not applied` and an
`Apply acquisition configuration` button.

For a device without a saved layout, the address input starts empty. A completed
discovery may prefill it, but the operator still saves the canonical layout
before recipe application.

Before enqueueing, the GUI confirms that commissioning can take about five
hours at the ordinary 20-minute interval. Each cycle uses an eight-second 12 V
window. The workflow never shortens the interval or offers continuous power.
Unsupported layouts explain which framing evidence is missing and leave the
apply button disabled.

The modal and soil card show these states: not applied, queueing, queued,
observed once, active, and degraded. Only `observed_compatible` is labelled
active. Existing readings retain their timestamps while another state is shown.

## Deployment and verification

Implementation uses test-first changes and a scripted `flows.json` mutation.
Both maintained Pi profiles remain byte-identical. Schema delivery uses the
ordered migration runner; `/data/db/farming.db` is never replaced.

Before live deployment:

- Unit-test the compiler against the captured eight-VWC and eight-VWC/two-VIC
  recipes, alternative addresses, unsupported shapes, and exact frame bytes.
- Test the ChirpStack helper against protobuf request construction and bounded
  partial failure.
- Test endpoint authentication, device scoping, idempotent retry, and state
  transitions.
- Test Identify with saved address `0`, an alternative valid address, no layout,
  and malformed layout.
- Run migration replay, all bundled-database consistency checks, flow parsing,
  profile parity, SDI-12 registration tests, normalizer vectors, and the React
  unit/build gates.

Live rollout to `100.121.141.64` requires a timestamped backup, migration with
Node-RED stopped, GUI and flow deployment, database integrity checks, and an
operator-triggered apply. The first field apply requires the saved digit-`0`
layout with TriSCAN at 10 and 50 cm. It does not infer configuration from the
failed `C`/`0`/`L` probes and must wait until the lab-tested probe is physically
installed.
