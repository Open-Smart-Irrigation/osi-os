# Rename zones and devices: design (2026-09-21)

Status: revision 2, after an external adversarial review on 2026-09-21. The
review returned eleven required changes; section 12 records what was done with
each. No code exists yet. Verified against osi-os `main` at `c37207b30` and
osi-server `main` at `07480478`. Both mains move daily, so the implementation
plans re-run the checks in section 2.

This document covers two repositories. osi-os owns the sync contract, so the
design lives here; the osi-server plans refer back to it.

## 1. Goal and scope

Users can change the name of an irrigation zone and of a device after creation,
on the edge dashboard and on the cloud dashboard. The edge stays the source of
truth for both names. A rename made in the cloud is a request that the gateway
applies, and the cloud shows it as waiting until the gateway has done so.

The work ships in three stages, each deployable alone:

| Stage | Repository | Content |
|---|---|---|
| 1 | osi-os | Name rule, rename routes and writers, ChirpStack name update, edge GUI, one receiver for the new commands `UPSERT_DEVICE_NAME` and `UPSERT_ZONE_NAME`, a new sync capability, the command contract |
| 2 | osi-server | Both renames issued through the new commands, pending state for devices, expiry and supersession, capability gate, request validation, cloud GUI, SMS zone lookup fix |
| 3 | osi-server frontend | One small clock icon replaces the banner, badge and pill treatments for the waiting states listed in section 7 |

Each stage gets its own implementation plan in its repository's
`docs/superpowers/plans/`. Section 11 lists what is excluded.

## 2. Current state

### 2.1 Summary

| | Edge API and GUI | Edge to cloud | Cloud to edge | Cloud GUI |
|---|---|---|---|---|
| Zone name | No rename. `POST /api/irrigation-zones` sets it; `PUT /api/irrigation-zones/:zone_id/config` returns `name` but never writes it | `trg_sync_zones_outbox_au` fires on a name change and emits `ZONE_UPSERTED` with `name` | `PUT /api/v1/irrigation-zones/by-uuid/{zoneUuid}/name` issues a whole-zone `UPSERT_ZONE`, which the edge applies on its legacy path (defect 6 below) | Inline rename on `IrrigationZoneCard.tsx`, strings hardcoded in English |
| Device name | No rename. Re-posting `POST /api/devices` for an existing DevEUI updates `name`, but needs `type_id` and a 32-hex `appkey` again and re-runs provisioning | `trg_sync_devices_outbox_au` fires on a name change and emits `DEVICE_FLAGS_UPDATED` with `name` | No command carries a device name for an existing device | No rename on device cards. `ClaimGatewayModal` renames the gateway record it has just claimed, through `PATCH /api/v1/devices/{deviceEui}`, which writes the cloud row only |

The cloud applies an incoming name in `EdgeSyncService.upsertZone` and
`EdgeSyncService.upsertDevice`, in both cases through
`EdgeStrings.fitFreeText(…, 100, …)`, which truncates past 100 characters.

### 2.2 Defects this design closes

1. `DeviceService.rename` in osi-server sets the name and increments
   `sync_version` on the cloud row. `EdgeSyncService.upsertDevice` then treats
   the next edge event as stale and returns early, which discards the whole
   device payload until the edge counter overtakes the cloud counter.
2. `DeviceService.registerDevice` does the same to an existing row: it sets
   `name` and increments `sync_version`, so a re-registration has the effect of
   defect 1.
3. `ensureDeviceProvisioned` in `osi-chirpstack-helper/index.js` sets the
   ChirpStack device name only when it creates the device. For an existing
   device it reconciles the profile and keys and leaves the name alone.
4. Name validation differs by path. Zone create checks non-empty after trim.
   `post-devices-auth` checks truthiness only; `post-devices-insert` trims
   before it writes. The `UPSERT_ZONE` applier allows 128 characters. The cloud
   column is `VARCHAR(100)`.
5. The legacy `UPSERT_ZONE` branch of function node `4f4a765f36cee6f3`
   ("Build UPDATE SQL") builds `s(cmd.name || 'Zone')` and ends in
   `ON CONFLICT(zone_uuid) DO UPDATE SET name=excluded.name, …`. A legacy-shaped
   command without a name renames an existing zone to `Zone`.
6. The cloud zone rename reaches that same legacy branch. `commandPayload` in
   `zonemutation/IrrigationZoneController.java` sends camelCase fields with
   `syncVersion`. The versioned applier in `osi-zone-commands` accepts a payload
   only when it carries one of `command_id`, `effect_key`, `base_sync_version`,
   `target_sync_version` or `zone` (`protectedCandidate`), so it passes the
   command on. The legacy statement then replaces every zone column and sets
   `sync_version=excluded.sync_version` without a guard. When the gateway holds
   edits the cloud has not received, a rename writes the cloud's older field
   values over them and can move the edge version backward; the cloud later
   discards the resulting event as stale and the two sides keep different names.
7. `SmsConsentService.resolveZoneId` in osi-server finds a zone by comparing
   display names. After a rename it returns `null` and the opt-in message row
   loses its zone; with two zones of the same name `findFirst()` can attach the
   message to the wrong one.
8. Cloud commands of a non-hardware type get no expiry.
   `CommandService.hardwareIntent` returns `null` for them, `expires_at` stays
   `NULL`, and `GatewayCommandExpirySweep` selects only rows with a due,
   non-null expiry. A command that a gateway drops stays waiting for good.

### 2.3 Facts the design relies on

- `irrigation_zones.name` and `devices.name` are `TEXT NOT NULL` with no
  uniqueness, length or check constraint (`database/seed-blank.sql`,
  `database/migrations/ordered/0001__baseline.sql`). No enabled flow looks up a
  zone or device by name. `sim-dendro-fn-setup` finds `Sim Zone A` by name, but
  it sits on the disabled tab "Simulations (Dev)" behind a manual inject.
- Writers increment `sync_version` themselves
  (`sync_version=COALESCE(sync_version,0)+1` in `zone-config-fn`). The outbox
  triggers only read it.
- Both outbox triggers are also inlined in the frozen boot node `sync-init-fn`.
  This design does not change them.
- An edge that receives an unknown `command_type` drops it in function node
  `reject-indefinite-open` with a `node.warn` and sends no acknowledgement.
  That node holds a fallback copy of the type list from `cmd-type-registry`.
- The edge reports a `syncCapabilities` list to the cloud. Three function nodes
  build it: `sync-bootstrap-build` (inject at start and every 21600 s),
  `al-link-build-req` and `sync-force-build`. The cloud reads it as
  `gatewayIdentity.syncCapabilities()` in `EdgeSyncService` and stores it with
  the linked gateway account.
- The narrow device commands `UPSERT_DEVICE_INSTALLATION_LOCATION` and
  `UPSERT_DEVICE_RADIO_CONFIGURATION` are applied by
  `osi-installation-location-helper/commands.js`: one transaction covers the
  duplicate check against `applied_commands`, the actor and scope checks, the
  write, the `applied_commands` row and the `command_ack_outbox` row. A
  transaction scope from `osi-db-helper` has no `transaction()` method of its
  own, so that helper passes a transaction-bound facade to its writer.
- With scoped access off, `assertFreshDeviceAccess` in `osi-scope-helper`
  returns a wildcard admin without looking at the device row.
- `deploy.sh` fetches Node-RED module files one by one (`fetch_required`); a
  file that is not listed does not reach a gateway.
- In osi-server, `projection/ResourceType.java` has the single member `ZONE`.
  `ProjectionService.confirm` retires a projection on a bare mirror version,
  `confirmByLatestCommand` on an acknowledgement alone, and `requestLocked`
  sets a new `latestCommandId` without cancelling the previous command.
  `upsertZone` reads its row with `findZoneForUpdate`; `upsertDevice` has no
  locked lookup. `CommandStatus` has a `CANCELLED` member.
- `DeviceController.gatewayForDevice` resolves a gateway by EUI equality with
  no type check, and gateway rows are bound to their own EUI, so
  `isEdgeBacked` is true for a gateway record.
- `POST /api/v1/devices/{deviceEui}/gateway-command` accepts any command type
  with any parameters from an admin who owns the gateway.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/` mirrors the bcm2712 payload
  byte for byte; `scripts/verify-profile-parity.js` enforces it.

## 3. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Two new narrow commands carry a cloud rename to the edge: `UPSERT_DEVICE_NAME` and `UPSERT_ZONE_NAME` | `main` handles devices with one small command per concern, and defect 6 shows what a whole-object command does to a rename |
| D2 | The name write is last-writer-wins by arrival at the edge, without a base-version check. Among cloud renames of one target, the later request wins (section 5.6) | A name is one scalar. A version check would reject a rename after any other edit of the same row |
| D3 | The edge updates the ChirpStack name on a best-effort basis | The OSI database is the source of truth. A ChirpStack outage must not block a label change or fail a cloud command |
| D4 | One name rule applies to rename and to create, on both sides | Otherwise create accepts names that rename rejects |
| D5 | No new sync event and no trigger change | The existing triggers and cloud appliers already carry the name |
| D6 | The v1 resource schema stays as it is. The 100-code-point limit is enforced by writers and by the command schema | Rows longer than 100 already exist legally and still travel in bootstrap and in unrelated events. The contract README requires a new file for a breaking change |
| D7 | The edge reports the capability `entity_name_commands_v1`. The cloud sends a name command only to a gateway that reported it. Without it, a device rename is refused with a clear message and a zone rename uses today's path | An old gateway drops unknown commands without an acknowledgement. Refusing keeps that from happening; the zone fallback keeps what works today |
| D8 | Name commands expire after 7 days | Long enough for a farm that is offline for days; finite, so a lost command ends as a visible failure |
| D9 | Customer branches receive the feature by re-cut onto `main`. Long-diverged legacy lines are not ported by hand | One implementation |
| D10 | A small clock icon marks waiting zone edits, zone and device renames, journal edits and the nine device-setting downlinks. Failed changes, valve actuation, device removal and gateway-access changes keep explicit wording | Decided by the product owner on 2026-09-21, the access table on the reviewer's advice. A failure needs a retry action, a farmer must be able to read whether water is moving, and a pending change to who may access a gateway deserves words |

## 4. Name rule

`normalize(raw)` either returns the stored form of a name or fails with one
reason code. It runs these steps in order:

1. `raw` must be a string of well-formed UTF-16. A lone high or low surrogate
   fails with `name_invalid_unicode`: JavaScript and Java can hold one, UTF-8
   storage in SQLite and PostgreSQL cannot.
2. Strip leading and trailing characters of the ECMAScript trim set, which is
   WhiteSpace plus LineTerminator: U+0009, U+000A, U+000B, U+000C, U+000D,
   U+0020, U+00A0, U+2028, U+2029, U+FEFF and every character of category Zs.
   Java's `trim()` and `strip()` use other sets, so the Java implementation
   spells this set out.
3. An empty result fails with `name_empty`.
4. More than 100 Unicode code points fails with `name_too_long`. Code points
   are counted, never UTF-16 units, so the limit matches `VARCHAR(100)`.
5. Any remaining character of category Cc, Zl or Zp fails with
   `name_control_characters`.

Names need not be unique.

Every implementation passes these vectors: the edge module, the TypeScript
helper in each GUI and the Java class.

| Input (JSON string) | Result |
|---|---|
| `"North block"` | `North block` |
| `"  North block \n"` | `North block` |
| `"\u00a0Bloc nord\u00a0"` | `Bloc nord` |
| `"\ufeffNorth"` | `North` |
| `"\u2028North\u2029"` | `North` |
| `""` | `name_empty` |
| `"   "` | `name_empty` |
| `"Row\t7"` | `name_control_characters` |
| `"Row\u00007"` | `name_control_characters` |
| `"A\u2028B"` | `name_control_characters` |
| `"\u0085North"` | `name_control_characters` (U+0085 is Cc and outside the trim set) |
| 100 × `"a"` | accepted unchanged |
| 101 × `"a"` | `name_too_long` |
| 100 × `"\ud83c\udf31"` (100 code points, 200 UTF-16 units) | accepted unchanged |
| `"\ud83c"` | `name_invalid_unicode` |
| `"\udf31x"` | `name_invalid_unicode` |

Rows that already break the rule stay as they are, keep syncing, and must
satisfy the rule the next time someone saves the name.

The rule covers zones and sensor or actuator devices. History labels hide a
device name that contains a 16-hex-digit token (`osi-history-helper/index.js`,
`src/history/sourceLabels.ts`); that behaviour is unchanged and the rename UI
does not warn about it.

## 5. Stage 1: edge (osi-os)

### 5.1 Module `osi-entity-name`

One new module under
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` holds
everything that writes a name to an existing row on request:

| File | Exports |
|---|---|
| `index.js` | `normalizeEntityName(raw)`; `renameZoneInTransaction(tx, …)`, `renameDeviceInTransaction(tx, …)`; the wrappers `renameZone(db, …)` and `renameDevice(db, …)`, which open the transaction; a lazy `applyNameCommand` that loads `commands.js` |
| `commands.js` | `applyNameCommand(db, envelope, runtime)`, the receiver for both command types |

`index.js` depends on nothing but the database handle it is given. The module
is registered in `osi-lib/index.js` as `entity-name`. Revision 1 placed the
writers in `osi-zone-commands` and `osi-device-commands`; a single receiver for
two command types makes one module the smaller design.

Callers of `normalizeEntityName`: the writers, the receiver, the `zone.name`
field of the versioned `UPSERT_ZONE` applier in `osi-zone-commands` (replacing
its 128-character bound), the legacy branch in 5.7, and the create paths
`post-zone-auth`, `scoped-zone-create-router`, `post-devices-auth` and
`cs-reg-cloud-fn`.

### 5.2 REST routes

| Route | Body | Success |
|---|---|---|
| `PUT /api/irrigation-zones/:id/name` | `{ "name": string }` | `200 { id, zone_uuid, name, sync_version, changed }` |
| `PUT /api/devices/:deveui/name` | `{ "name": string }` | `200 { deveui, name, sync_version, changed, chirpstack }` |

`changed` is `false` when the normalized name equals the stored one; the handler
then writes nothing. `chirpstack` is `updated`, `failed` or `skipped`
(`skipped` when nothing changed or provisioning is not configured).

Authentication is the existing HMAC bearer check. Authorization follows the
other zone and device writes:

- `OSI_SCOPED_ACCESS` unset: the row must belong to the caller
  (`user_id` match), otherwise `404`, as `zone-config-fn` does today.
- `OSI_SCOPED_ACCESS=1`: `scope.assertFreshRole`, `scope.canMutate(role)` and
  the per-zone or per-device access assertion run first. A role that cannot
  mutate gets `403`.

Errors: `400 { message, reason }` with a reason code from section 4, `401`,
`403`, `404`. `message` stays English, as on the other routes; the GUI
translates by `reason`.

### 5.3 Writers

Each in-transaction writer does three things:

1. Read the current row. A missing or deleted row raises a not-found error.
2. If the stored name equals the new one, return `{ changed: false }`.
3. Otherwise update `name`, `updated_at` and
   `sync_version = COALESCE(sync_version,0)+1` with bound parameters, and
   return `{ changed: true, sync_version }`.

The REST handlers call the wrappers. The receiver opens one transaction and
calls the in-transaction variants inside it, because a transaction scope cannot
open another.

Four older paths also write a name to an existing row, and they keep doing so:

| Path | Change here |
|---|---|
| Versioned `UPSERT_ZONE` applier in `osi-zone-commands` (replaces the whole zone by contract) | Uses the name rule instead of its 128-character bound |
| Legacy `UPSERT_ZONE` branch of node `4f4a765f36cee6f3` | Section 5.7 |
| Device re-claim in `post-devices-insert` | Name rule applied upstream in `post-devices-auth` |
| `REGISTER_DEVICE` in `cs-reg-cloud-fn`, which renames an existing row only with scoped access on | Applies the name rule; a name that breaks it falls back to the DevEUI, as a missing name does today, so a label never fails a registration |

### 5.4 Sync events

Nothing new. When the gateway is linked, the update in 5.3 fires
`trg_sync_zones_outbox_au` (`ZONE_UPSERTED`) or `trg_sync_devices_outbox_au`
(`DEVICE_FLAGS_UPDATED`), each with the new name and the new `sync_version`. A
`changed: false` result fires neither, because no row was written. There is no
migration, no `sync-init-fn` edit and no fingerprint restamp.

### 5.5 ChirpStack name

`osi-chirpstack-helper` gains `updateDeviceName(client, devEui)`. It takes no
name argument: it reads `devices.name` from the database at the moment it runs,
reads the ChirpStack device, returns `unchanged` if the names match, and
otherwise sends `UpdateDeviceRequest` under the existing gRPC deadline. Calls
are serialized per DevEUI inside the Node-RED process. Two renames in quick
succession therefore end with ChirpStack on the newer name, whichever gRPC call
is slower.

The REST handler and the command function node call it after the database
transaction has committed, never inside it. On failure they log with
`node.warn`, the REST response carries `chirpstack: "failed"`, and the command
acknowledgement stays `APPLIED`.

`ensureDeviceProvisioned` also reconciles the name of an existing device from
`devices.name`, so a missed update heals at the next provisioning. It never
uses the raw request value: with scoped access off, `REGISTER_DEVICE` does not
rename an existing row, and ChirpStack must not run ahead of the database.

### 5.6 Receiver for the name commands

`applyNameCommand` handles `UPSERT_DEVICE_NAME` and `UPSERT_ZONE_NAME`, modelled
on `osi-installation-location-helper/commands.js`. Payload:

| Field | Rule |
|---|---|
| `command_type` | One of the two types, equal to the envelope type |
| `command_id` | UUID. Payload identity only |
| `gateway_device_eui` | 16 upper-case hex digits |
| `device_eui` | `UPSERT_DEVICE_NAME` only: 16 upper-case hex digits |
| `zone_uuid` | `UPSERT_ZONE_NAME` only: UUID |
| `actor_user_uuid` | UUID of the acting user |
| `requested_at` | UTC timestamp with milliseconds, set by the cloud when the user asked |
| `values.name` | String; the receiver applies section 4 |

Two identifiers exist and must not be confused. The envelope's numeric
`commandId` is the delivery identity: it is the key in `applied_commands` and
the `commandId` in the acknowledgement, as in the precedent. The payload's UUID
`command_id` is carried for tracing only.

In one transaction the receiver:

1. returns the stored acknowledgement if `applied_commands` already has the
   envelope's `commandId`, and re-queues that acknowledgement;
2. rejects with `REJECTED_PERMANENT` when the payload is malformed or the name
   breaks the rule;
3. rejects with reason `gateway_mismatch` when `gateway_device_eui` differs
   from the runtime gateway EUI, or when the target row is bound to another
   gateway;
4. rejects when the target row is missing or deleted, or the actor is missing
   or disabled;
5. checks authorization. With scoped access on: the fresh device or zone access
   assertion, then `scope.canMutate`. With scoped access off: the actor's local
   user id must equal the row's `user_id`, which also rejects an unclaimed
   device. The wildcard that `assertFreshDeviceAccess` returns in this mode is
   not accepted as proof;
6. applies the fence: if `applied_commands` holds an `APPLIED` row of the same
   command type and target whose `requestedAt` is later than this command's,
   it rejects with reason `superseded` and writes nothing;
7. calls the in-transaction writer. An unchanged name still acknowledges
   `APPLIED`;
8. writes the `applied_commands` row and the `command_ack_outbox` row. The
   stored acknowledgement carries `target`, `requestedAt` and
   `appliedSyncVersion`, the row's `sync_version` after the write.

The commands carry no `effect_key` and no base version. `effect_key` binds a
physical effect, and the ledger treats a repeated key as a replay; a constant
key per target would make the second rename of a device look like a duplicate
of the first. The Stage 1 plan verifies that
`osi-command-ledger.deduplicatePendingCommand` passes a payload without an
`effect_key` on to the receiver.

The fence orders cloud renames among themselves, by one cloud clock. It does not
involve local renames: a rename typed at the gateway is not in
`applied_commands`, and a cloud rename that arrives after it wins (D2).

A new function node applies the commands in the pending-command chain, in the
same position and shape as `installation-revision-command-apply-fn`: it handles
its two types, passes every other message on, and emits the acknowledgement on
`devices/<gatewayEui>/command_ack`. After an `APPLIED` device rename it runs
5.5.

Both types are added to `cmd-type-registry` and to the fallback list in
`reject-indefinite-open`, with `actuator: false` and
`requires_duration: false`. The three `syncCapabilities` builders gain
`entity_name_commands_v1`.

### 5.7 Legacy `UPSERT_ZONE` branch

Node `4f4a765f36cee6f3` runs `cmd.name` through the name rule. A valid name is
written as today. When the name is missing or breaks the rule, an existing row
keeps its stored name
(`name = CASE WHEN <valid name> THEN excluded.name ELSE irrigation_zones.name END`),
a first insert falls back to `Zone`, and the node logs a `node.warn` for the
invalid case. The unguarded `sync_version` and the whole-row overwrite of that
branch are outside this design (section 11).

### 5.8 Edge GUI

A shared component `EditableName` in
`web/react-gui/src/components/farming/shared/` renders the name, a pencil
button, and in edit mode a text input. Enter or blur saves, Escape cancels and
returns focus to the pencil, a blank or over-long value shows the translated
reason under the input without calling the API, and a server error shows the
translated `reason` or a generic failure text. Enter usually causes a blur as
edit mode closes, so the component keeps one in-flight save and ignores a second
trigger until it settles. The interaction matches the cloud zone card.

It replaces the plain name heading in `IrrigationZoneCard.tsx` and in the device
cards `KiwiSensorCard`, `StregaValveCard`, `DraginoTempCard`, `LoRainGaugeCard`,
`SenseCapWeatherCard`, `Sdi12SoilCard` and `valves/ValveTile`. The pencil
follows the permission signal that already hides the other zone and device edit
controls from a role that cannot mutate; the route in 5.2 enforces the rule
regardless.

`src/services/api.ts` gains `irrigationZonesAPI.rename(id, name)` and
`devicesAPI.rename(deveui, name)`. A TypeScript copy of the name rule lives in
`src/utils/entityName.ts` with the section 4 vectors. `AddDeviceModal`,
`ZoneDeviceModal` and `CreateZoneModal` use it and send trimmed names.

New strings go into the `devices` namespace of all seven locales (`en`, `de-CH`,
`fr`, `it`, `es`, `pt`, `lg`): rename zone, rename device, the two input labels,
the four reason texts and the generic failure. Existing Luganda strings are not
edited. New `lg` keys ship the English source text, never a machine
translation, and are listed in `docs/i18n/pending-luganda-translations.md` with
the matching test allowlist entry until a human Luganda pass supplies them.

### 5.9 Constraints on the edge change

- Every file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is copied to
  the bcm2709 profile.
- `deploy.sh` gains a `fetch_required` entry for each file of
  `osi-entity-name`. `scripts/verify-module-file-deploy-coverage.js` and
  `scripts/verify-helper-registration.js` must pass.
- `scripts/osi-lib-binding-audit.js` pins function nodes by SHA-256 and by
  binding list. Each edited or new function node needs its entry updated.
- The module is registered in the node-red `package.json`, the lockfile,
  `osi-lib/index.js` and `files/etc/uci-defaults/98_osi_node_red_seed`, as the
  existing helper modules are.
- `scripts/verify-sync-flow.js` pins GUI and flow files by path. New routes and
  API functions get assertions there, following the repository convention.
- New HTTP nodes use parameterised SQL. The string-concatenated SQL in
  `post-zone-insert` and `post-devices-insert` is not rewritten here.

## 6. Stage 2: cloud (osi-server)

### 6.1 Which devices a command can rename

A device is renamed through the edge when its type is not `GATEWAY` and its
gateway resolves to a row of type `GATEWAY` that is not deleted and is claimed
by the caller. A new resolver states this; `isEdgeBacked` is not reused for
rename, because it is true for a self-bound gateway record.

Everything else is cloud-only: the gateway record itself, and a device with no
gateway. For those, `PATCH /api/v1/devices/{deviceEui}` keeps the direct write,
without the `sync_version` increment. `ClaimGatewayModal` keeps working
unchanged.

### 6.2 Rename endpoints

`PATCH /api/v1/devices/{deviceEui}` and
`PUT /api/v1/irrigation-zones/by-uuid/{zoneUuid}/name` keep their paths and
bodies. For a target renamed through the edge, the controller:

1. normalizes the name (6.6);
2. reads the gateway's stored `syncCapabilities`. Without
   `entity_name_commands_v1`, the device endpoint answers
   `409 { code: "gateway_update_required" }` and issues nothing; the zone
   endpoint falls back to today's `UPSERT_ZONE` path, unchanged;
3. otherwise, under the projection aggregate lock, cancels an older name
   command for the same target that no gateway has collected yet (6.4), issues
   the name command with the payload from 5.6 and an `expires_at` seven days
   ahead (6.5), and stores the projection (6.3);
4. answers `202` with the projected name and the projection fields. It never
   touches `name` or `sync_version` on the mirror row.

A caller who does not own the device gets `403`. Today `assertOwner` throws
`IllegalStateException`, which `GlobalExceptionHandler` maps to `409`. Ownership
stays the write boundary; scoped members are not given rename rights here.

`DeviceService.registerDevice` stops writing `name` and stops incrementing
`sync_version` on an existing row that is renamed through the edge. The mirror
keeps the canonical name; `REGISTER_DEVICE` still carries the requested name to
the gateway.

`POST /api/v1/devices/{deviceEui}/gateway-command` refuses both name command
types with `400 { code: "command_type_not_allowed" }`. Without this, an admin
could issue a rename that names another user as the actor.

### 6.3 Pending state

`ResourceType` gains `DEVICE`. A device rename stores one projection keyed by
gateway, `DEVICE` and the device EUI, holding the requested name. A zone rename
keeps using the zone's single projection. The read path overlays the projected
name and exposes `firstRequestedAt`, `projectionState` and
`projectionFailureDetail` for devices as it does for zones. A second rename
while one is waiting keeps the original `firstRequestedAt`, which
`ProjectionService` already does; the tooltip says since when something has
been unconfirmed.

A projection whose latest command is a name command retires by two signals:

| Rule | Statement |
|---|---|
| Eligible acknowledgement | Only the acknowledgement of the projection's `latestCommandId` counts. One for an older command changes nothing |
| Acknowledged version | Read from the terminal `DeviceCommand` row of that command: status and `appliedSyncVersion`. No projection migration |
| Retirement | The projection is deleted when that command is acknowledged `APPLIED` with version V and the mirror row's `sync_version` is at least V |
| Event before acknowledgement | Cannot retire the projection: no acknowledged version exists yet. The projected name stays visible |
| Acknowledgement before event | The projection stays, and the projected name with it, until the event lifts the mirror to V |
| One predicate, two triggers | Acknowledgement handling and edge event ingestion evaluate the same predicate. Both take the projection aggregate lock first and the mirror row lock second, the order `upsertZone` uses. `upsertDevice` gains the aggregate lock and a locked row lookup |
| Failure | `REJECTED_PERMANENT`, `CANCELLED` of the latest command, or expiry sets the state to `REJECTED` or `FAILED`. The response then shows the canonical mirror name; `desired_json` serves only the failure text and a retry |

`confirm` on a bare version and `confirmByLatestCommand` on an acknowledgement
alone stay as they are for every other zone command. The zone keeps one
projection: a rename issued while another zone edit waits replaces
`latestCommandId`, as any second zone edit does today.

### 6.4 Supersession

A second rename of the same target cancels the first command if its status
shows that no gateway has collected it, by setting `CANCELLED` under the
aggregate lock, so it is never delivered. A command that a gateway has already
collected cannot be recalled. Its acknowledgement is ignored (6.3), and if it
reaches the edge after the newer one, the fence in 5.6 rejects it as
`superseded`.

### 6.5 Expiry

Both name commands are persisted with `expires_at = now + 7 days`. The two
public `issueGatewayCommand` overloads derive an expiry only for hardware types,
so `CommandService` gains a way to give a non-hardware type an explicit
expiry. `GatewayCommandExpirySweep` then ends an unanswered command, and the
projection turns `FAILED` with a text that says the gateway did not confirm the
rename in time. Expiry is recovery for a lost command. The capability gate in
6.2, not expiry, is what keeps commands away from gateways that would drop
them.

### 6.6 Validation

One Java class, `EntityNames`, implements section 4 with the trim set spelled
out and carries the vector tests. A `@EntityName` constraint calls it to
reject; controllers and services call `EntityNames.normalize` to obtain the
value they store or send, because a validation annotation cannot replace a DTO
value. No path uses `String.trim()` on a name. The constraint annotates
`RenameRequest`, `RenameZoneRequest`, `CreateZoneRequest.name` and
`RegisterDeviceRequest.name`. `EdgeStrings.fitFreeText` stays as the ingest
guard for names that predate the rule.

### 6.7 Cloud GUI

An `EditableName` component with the behaviour of 5.8, including the single
in-flight save, replaces the inline rename code in
`frontend/src/components/farming/IrrigationZoneCard.tsx` and is added to the
device cards (`KiwiSensorCard`, `StregaValveCard`, `DraginoCard`,
`Sdi12SoilCard`, `SenseCapWeatherCard`) and to `pages/DeviceDetail.tsx`. It
calls the existing `devicesAPI.rename` and `irrigationZonesAPI.renameByUuid`
and applies the optimistic overlay the zone card already uses. A
`gateway_update_required` answer shows a translated message that the gateway
needs a software update before devices can be renamed from the cloud.

The hardcoded English strings in the zone card (`Rename zone`, `Zone name`,
`Zone name cannot be blank.`, `Failed to rename zone.`) move into the locale
files together with the new device strings, in all seven languages.
`localeParity.test.ts` and `missingKeyScan.test.ts` must pass.

### 6.8 SMS zone lookup

`SmsConsentService` receives the zone id from its caller and stops resolving a
zone by display name. `resolveZoneId` is removed. Messages already rendered and
stored in `sms_messages.body` keep the name they were rendered with.

## 7. Stage 3: waiting indicator (osi-server frontend)

The edge GUI is unaffected: its writes are local, and it has no waiting banner.

### 7.1 Component

`frontend/src/components/sync/PendingClock.tsx` renders a 16 px clock glyph as
inline SVG (the frontend has no icon library) in the tertiary text colour,
inside a button with an accessible label. Hover, focus or tap opens a tooltip;
Escape or an outside pointer press closes it. That interaction code exists in
`UnconfirmedChangeWarning.tsx` and moves into the new component. The tooltip
states what is waiting, since when, and the requested value where one exists.

The clock appears from the moment of the request. The one-hour threshold in
`shouldWarnUnconfirmed` is removed.

A failure renders a warning glyph of the same size in the warning colour, with
the failure detail in the tooltip. Red fill is no longer used for waiting.

### 7.2 Where it applies

| Surface today | Change |
|---|---|
| `PendingStateNotice`, statuses `pending` and `acknowledged` (zone card, journal `EntryTable`, `JournalReferencePanel`) | No banner. A clock sits next to the resource name or row label |
| `PendingStateNotice`, statuses `conflicted`, `rejected`, `expired`, `superseded` | Unchanged: the notice, the proposal and the Retry button stay |
| `UnconfirmedChangeWarning` on the zone name | Replaced by the clock for `REQUESTED` and by the small warning glyph for `REJECTED` and `FAILED` |
| Device name (new in stage 2) | Same clock and warning glyph |
| `DownlinkPendingBadge` for settings: Kiwi interval and temperature or humidity enable; Dragino mode, interval, interrupt and 5 V warm-up; STREGA interval, model and magnet mode | Clock next to the control label. The tooltip includes the requested value |
| `DownlinkPendingBadge` for STREGA timed action, partial opening and flushing | Unchanged. These move water |
| Valve tile wording for a commanded, unconfirmed open or close | Unchanged |
| `RemoveSyncStatusNotice` | Unchanged. A device being removed says so in words |
| Gateway access admin table, all statuses | Unchanged. A pending change to who may access a gateway keeps its text |

A name shows at most one indicator. The zone card has two sources
(`zone.desiredState` and `zone.projectionState`); a wrapper shows the clock
when either one is waiting, and the warning glyph when `projectionState` has
failed.

Apply buttons stay disabled while `useDownlinkAction` reports `submitting` or
`pending`. The cards read that status directly, independently of
`DownlinkPendingBadge`, so removing the pill leaves the guard against duplicate
downlinks in place. A test pins this for each of the nine call sites.

## 8. Contract changes

All in `docs/contracts/sync-schema/` in osi-os.

| File | Change |
|---|---|
| `resources.schema.json` | None (D6) |
| `commands.schema.json` | `UPSERT_DEVICE_NAME` and `UPSERT_ZONE_NAME` join the `command_type` enum. One `allOf` branch per type requires `gateway_device_eui`, `actor_user_uuid`, `requested_at`, the target field (`device_eui` or `zone_uuid`) and `values` with the single required property `name` (`minLength: 1`, `maxLength: 100`). Properties the top-level list lacks are added to it |
| `scripts/test-contract-schemas.js` | A valid and an invalid instance of each command, and a resource instance with a 101-character name that must stay valid |

Because `resources.schema.json` does not change, stage 1 needs no mirror pull
request in osi-server. osi-server keeps its own staged `commands.schema.json`;
stage 2 adds the two commands there and records a capability entry in
`sync-contract-golden.json`. `effect-keys.md` and `canonicalization.md` do not
change.

## 9. Rollout

1. osi-os stage 1 merges to `main` and gateways are deployed from it. After its
   Node-RED restart a gateway reports `entity_name_commands_v1` in the
   bootstrap it sends at start.
2. osi-server stages 2 and 3 merge to `main` and deploy.

The capability gate makes either order safe. Deploying gateways first is still
the better order, because a cloud that runs stage 2 refuses device renames for
every gateway that has not reported the capability. The release checklist for an
instance lists its gateways and their reported capabilities before stage 2 goes
live there.

Stage 1 is safe against an older cloud. It emits only events that every
deployed cloud already applies, and an unknown capability string is ignored.

Customer branches in both repositories are thin overlays and are re-cut onto
the new `main` after each stage, under the customer-branch runbook.
Long-diverged legacy lines are not ported; they receive the feature when their
thin re-cut replaces them.

## 10. Testing

| Area | Tests |
|---|---|
| Name rule | Section 4 vectors in `osi-entity-name`, `entityName.ts` (both GUIs) and `EntityNames` |
| Writers | Changed, unchanged, missing and deleted row; `sync_version` increments once; with a linked gateway exactly one outbox row with the new name and the expected op; none when unchanged; the in-transaction variant inside a caller's transaction |
| Receiver | Both types: applied; replayed envelope id; malformed payload; rule violation; unknown target; wrong `gateway_device_eui`; row bound to another gateway; disabled actor; forged actor without access (scoped on); non-owner and unclaimed device (scoped off); unchanged name; a newer command applied first and then the older one arrives (`superseded`); two renames of one target in order |
| ChirpStack | Updated; unchanged; gRPC failure leaves the rename committed and the acknowledgement `APPLIED`; two renames whose gRPC calls finish in reverse order end on the newer name; `ensureDeviceProvisioned` reconciles an existing device's name from the database |
| Routes | Both routes with scoped access off (owner, stranger) and on (admin, researcher, viewer, no access); each reason code |
| Legacy `UPSERT_ZONE` | No name, an over-long name and a control character each keep the stored name; a first insert gets `Zone`; a valid name is written |
| Compatibility | A row with a 101-character name travels through bootstrap and through an unrelated `ZONE_UPSERTED` and `DEVICE_FLAGS_UPDATED` event, and the cloud ingests it as it does today |
| Edge GUI | `EditableName`: save on Enter and blur; Enter followed by blur, and a fast double click, make one API call; Escape restores focus; blank and over-long blocked client-side; server reason shown; pencil hidden without mutate rights; locale parity in seven languages |
| Cloud endpoints | `202` with projection for a device renamed through the edge; no `sync_version` change on the mirror row, so the next edge device event is applied; `409 gateway_update_required` without the capability; zone fallback to `UPSERT_ZONE` without it; `403` for a non-owner; a self-bound gateway record and a device without gateway rename directly; `registerDevice` on an existing row keeps name and version; the generic gateway-command route refuses both types |
| Projection | Event then acknowledgement; acknowledgement then event; stale event before the acknowledgement; event above the acknowledged version; concurrent event and rename request; acknowledgement of a non-latest command; rejection shows the mirror name |
| Supersession and expiry | An uncollected older command is cancelled; a collected one is left and its acknowledgement ignored; expiry after protocol-1 `SENT` and after protocol-2 lease and retry turns the latest projection `FAILED` |
| Cloud GUI | `EditableName` on zone and device cards; `PendingClock` states; the nine setting call sites show a clock and keep the button disabled; the three water-moving call sites keep the pill; failure notices keep Retry; the access table keeps its text |
| SMS | Opt-in message keeps its zone id after a rename and with two zones of the same name |

Gates for stage 1, all from the repository root: `verify-sync-flow.js`,
`verify-sync-contract.js`, `test-contract-schemas.js`,
`verify-sync-op-parity.js`, `verify-profile-parity.js`,
`osi-lib-binding-audit.js`, `verify-module-file-deploy-coverage.js`,
`verify-helper-registration.js`, `verify-flows-fn-parse.js`,
`test-flows-wiring.js`, `verify-no-new-silent-catch.js`,
`flows-bare-require-scan.js`, `verify-flows-size-ratchet.js` and
`verify-communication-contract.js` under `scripts/`, then the GUI typecheck,
unit tests and a production build.

Gates for stages 2 and 3: the full backend suite with `./gradlew test`, then
`tsc --noEmit`, `npm run test:unit` and a production build in `frontend/`.
Frontend builds run one at a time on the development workstation.

A bench check on a test gateway closes stage 1: rename a zone and a device in
the edge GUI, confirm both names in the linked cloud and the device name in the
ChirpStack UI, then stop ChirpStack, rename again and confirm the rename
succeeds with `chirpstack: "failed"`. ChirpStack gRPC behaviour and browser
interaction were checked in source only during design and review, so this bench
check is their first real test.

## 11. Out of scope

- Porting the whole-device `UPSERT_DEVICE` command to `main`.
- The rest of defect 6. Every other cloud zone edit that travels as a legacy
  `UPSERT_ZONE` keeps the whole-row overwrite and the unguarded `sync_version`.
  This design moves only the rename off that path. The defect needs an issue of
  its own in both repositories.
- Unique names, per user or per gateway.
- Rename rights for scoped members in the cloud.
- Renaming the gateway on the edge.
- Rewriting names inside synced `DEVICE_DATA_APPENDED` events,
  `field_tester_uplinks.device_name`, stored SMS bodies or downloaded CSV files.
- Making the edge acknowledge unknown command types with a rejection.
- Removing the dangling `$ref`s that the staged osi-server `commands.schema.json`
  holds toward definitions absent from `resources.schema.json`.
- The disabled simulator tab, which would create a second `Sim Zone A` if a
  developer renamed the first and ran the setup again.

## 12. Review record

External adversarial review of revision 1, 2026-09-21, verdict "needs
revision". Each finding was checked against the code before it was accepted.

| # | Finding | Outcome |
|---|---|---|
| 1 | Cloud zone rename takes the legacy whole-zone path | Confirmed (defect 6). `UPSERT_ZONE_NAME` added: D1, 5.6, 6.2 |
| 2 | Device projection needs two signals, locking and a persistence source | Confirmed. 6.3 |
| 3 | No real supersession of rapid renames | Confirmed. Cloud cancellation in 6.4, edge fence in 5.6 |
| 4 | Name commands never expire; rollout gate not enforceable | Confirmed (defect 8). 7-day expiry in 6.5. The gate is the existing `syncCapabilities` report, which the review had not found: D7, 6.2, 9. The suggested public overload with `expiresAt` does not exist; `CommandService` needs a small addition |
| 5 | `registerDevice` and gateway classification | Confirmed (defect 2). 6.1, 6.2 |
| 6 | Authorization gaps at issue and at receipt | Confirmed. 5.6 steps 3 and 5, 6.2 |
| 7 | Name rule not identical across runtimes | Confirmed. Section 4 rewritten, 6.6 |
| 8 | `maxLength` would break the v1 resource schema | Confirmed. D6, section 8 |
| 9 | Legacy writer rule; simulator lookup by name | First half confirmed: 5.7. Second half corrected in 2.3 without a design change: the node is on a disabled developer tab |
| 10 | Transaction composition, deploy coverage, missing gates | Confirmed. 5.1, 5.3, 5.9, 10 |
| 11 | Stage 3 wider than the product decision | Split. Journal edits were part of the product decision, which D7 of revision 1 worded too narrowly. The gateway access table was not, and is removed: D10, 7.2 |
| O1–O3 | Save-once guard, ChirpStack ordering, command identities and `firstRequestedAt` | Taken: 5.8, 5.5, 5.6, 6.3 |

The review's five corrections to section 2 of revision 1 were all confirmed and
are in 2.1 to 2.3.
