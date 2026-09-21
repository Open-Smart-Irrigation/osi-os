# Rename zones and devices: design (2026-09-21)

Status: design approved in conversation on 2026-09-21, awaiting written review.
No code exists yet. Verified against osi-os `main` at `c37207b30` and osi-server
`main` at `eed1b645`; section 2 lists what was checked. The implementation plan
must re-run those checks, because both mains move daily.

This document covers two repositories. osi-os owns the sync contract, so the
design lives here; the osi-server plan refers back to it.

## 1. Goal and scope

Users can change the name of an irrigation zone and of a device after creation,
on the edge dashboard and on the cloud dashboard. The edge stays the source of
truth for both names. A rename made in the cloud is a request that the gateway
applies, and the cloud shows it as waiting until the gateway has done so.

The work ships in three stages, each deployable alone:

| Stage | Repository | Content |
|---|---|---|
| 1 | osi-os | Rename routes, writers, ChirpStack name update, edge GUI, receiver for the new `UPSERT_DEVICE_NAME` command, contract changes |
| 2 | osi-server | Device rename through `UPSERT_DEVICE_NAME`, pending state for devices, cloud GUI, request validation, SMS zone lookup fix |
| 3 | osi-server frontend | One small clock icon replaces the banner, badge and pill treatments for setting changes that wait for the gateway |

Each stage gets its own implementation plan in its repository's
`docs/superpowers/plans/`. Section 11 lists what is excluded.

## 2. Current state

### 2.1 Summary

| | Edge API and GUI | Edge to cloud | Cloud to edge | Cloud GUI |
|---|---|---|---|---|
| Zone name | No rename. `POST /api/irrigation-zones` sets it; `PUT /api/irrigation-zones/:zone_id/config` returns `name` but never writes it | `trg_sync_zones_outbox_au` fires on a name change and emits `ZONE_UPSERTED` with `name` | `UPSERT_ZONE` carries `zone.name`; `osi-zone-commands` writes it | Inline rename on `IrrigationZoneCard.tsx`, strings hardcoded in English |
| Device name | No rename. Re-posting `POST /api/devices` for an existing DevEUI updates `name`, but needs `type_id` and a 32-hex `appkey` again and re-runs provisioning | `trg_sync_devices_outbox_au` fires on a name change and emits `DEVICE_FLAGS_UPDATED` with `name` | No command carries a device name for an existing device | No rename UI. `PATCH /api/v1/devices/{deviceEui}` exists and writes the cloud row only |

The cloud applies an incoming name in `EdgeSyncService.upsertZone` and
`EdgeSyncService.upsertDevice`, in both cases through
`EdgeStrings.fitFreeText(…, 100, …)`, which truncates past 100 characters.

### 2.2 Defects this design closes

1. `DeviceService.rename` in osi-server sets the name and increments
   `sync_version` on the cloud row. `EdgeSyncService.upsertDevice` then treats
   the next edge event as stale and returns early, which discards the whole
   device payload until the edge counter overtakes the cloud counter. The zone
   path documents the same trap in the `applyCloudOwnedFields` javadoc and
   avoids it.
2. `ensureDeviceProvisioned` in `osi-chirpstack-helper/index.js` sets the
   ChirpStack device name only when it creates the device. For an existing
   device it reconciles the profile and keys and leaves the name alone.
3. Name validation differs by path. Zone create checks non-empty after trim.
   Device create checks truthiness and does not trim. The `UPSERT_ZONE` applier
   allows 128 characters. The cloud column is `VARCHAR(100)`.
4. The legacy `UPSERT_ZONE` branch of function node `4f4a765f36cee6f3`
   ("Build UPDATE SQL") builds `s(cmd.name || 'Zone')` and ends in
   `ON CONFLICT(zone_uuid) DO UPDATE SET name=excluded.name`. A legacy-shaped
   command without a name renames an existing zone to `Zone`.
5. `SmsConsentService.resolveZoneId` in osi-server finds a zone by comparing
   display names. After a rename, or with two zones of the same name, it
   returns `null` and the opt-in message row loses its zone.

### 2.3 Facts the design relies on

- `irrigation_zones.name` and `devices.name` are `TEXT NOT NULL` with no
  uniqueness, length or check constraint (`database/seed-blank.sql`,
  `database/migrations/ordered/0001__baseline.sql`). No production code looks
  up a zone or device by name on the edge.
- Writers increment `sync_version` themselves
  (`sync_version=COALESCE(sync_version,0)+1` in `zone-config-fn`). The outbox
  triggers only read it.
- Both outbox triggers are also inlined in the frozen boot node `sync-init-fn`.
  This design does not change them.
- An edge that receives an unknown `command_type` drops it in function node
  `reject-indefinite-open` with a `node.warn` and sends no acknowledgement.
  That node holds a fallback copy of the type list from `cmd-type-registry`.
- The narrow device commands `UPSERT_DEVICE_INSTALLATION_LOCATION` and
  `UPSERT_DEVICE_RADIO_CONFIGURATION` are applied by
  `osi-installation-location-helper/commands.js`: one transaction covers the
  duplicate check against `applied_commands`, the actor and scope checks, the
  write, the `applied_commands` row and the `command_ack_outbox` row.
- `osi-device-commands/index.js` on `main` re-exports `weather.js` only. Its
  header forbids adding whole-device `UPSERT_DEVICE` handling without the
  matching migration, contract and test surface. osi-server vendors a command
  schema that lists `UPSERT_DEVICE`, but no Java code issues it.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/` mirrors the bcm2712 payload
  byte for byte; `scripts/verify-profile-parity.js` enforces it.
- In osi-server, `projection/ResourceType.java` has the single member `ZONE`.
  The table `pending_resource_projections` is keyed by
  `(gateway_device_eui, resource_type, resource_key)` and is otherwise generic.

## 3. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | A new narrow command `UPSERT_DEVICE_NAME` carries a cloud rename to the edge | `main` already handles devices with one small command per concern. A whole-device command would add a second writer for flags, depths and zone assignment, and a rename could be refused because an unrelated field changed |
| D2 | The name write is last-writer-wins, without a base-version check | A name is one scalar. A version check would reject a rename after any other device edit |
| D3 | The edge updates the ChirpStack name on a best-effort basis | The OSI database is the source of truth. A ChirpStack outage must not block a label change or fail a cloud command |
| D4 | One name rule applies to rename and to create, on both sides | Otherwise create accepts names that rename rejects, and the contract limit is violated at creation |
| D5 | No new sync event and no trigger change | The existing triggers and cloud appliers already carry the name |
| D6 | Customer branches receive the feature by re-cut onto `main`. Long-diverged legacy lines are not ported by hand | One implementation. Section 9 gives the deploy order |
| D7 | Waiting setting changes show a small clock icon. Failed changes and valve actuation keep explicit wording | Decided by the product owner on 2026-09-21. A failure needs a retry action, and a farmer must be able to read whether water is moving |

## 4. Name rule

A stored zone or device name satisfies all of:

1. It is a string with no leading or trailing white space. Input is trimmed
   before the other checks, using the ECMAScript `String.prototype.trim`
   character set (WhiteSpace plus LineTerminator).
2. Its length is 1 to 100 Unicode code points. Code points are counted, never
   UTF-16 units, so the limit matches PostgreSQL `VARCHAR(100)`.
3. It contains no character of general category Cc (U+0000 to U+001F and
   U+007F to U+009F).

Names need not be unique. Rejections use three reason codes: `name_empty`,
`name_too_long`, `name_control_characters`.

Every implementation passes these vectors. The edge module, the cloud validator
and both GUI helpers carry them as unit tests.

| Input (JSON string) | Result |
|---|---|
| `"North block"` | `North block` |
| `"  North block \n"` | `North block` |
| `" Bloc nord "` | `Bloc nord` |
| `""` | `name_empty` |
| `"   "` | `name_empty` |
| `"Row\t7"` | `name_control_characters` |
| 100 × `"a"` | accepted unchanged |
| 101 × `"a"` | `name_too_long` |
| 100 × `"🌱"` (100 code points, 200 UTF-16 units) | accepted unchanged |

Rows that already break the rule stay as they are. They must satisfy it the
next time someone saves the name.

The rule covers zones and sensor or actuator devices. History labels hide a
device name that contains a 16-hex-digit token (`osi-history-helper/index.js`,
`src/history/sourceLabels.ts`); that behaviour is unchanged and the rename UI
does not warn about it.

## 5. Stage 1: edge (osi-os)

### 5.1 Name module

New module `osi-entity-name` under
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`, exporting
`normalizeEntityName(raw)`. It returns the trimmed name or throws an error whose
`code` is one of the three reason codes. The module has no dependencies and is
registered in `osi-lib/index.js` as `entity-name`, so function nodes load it
with `osiLib.require('entity-name')`.

Callers: both writers (5.3), the `UPSERT_DEVICE_NAME` receiver (5.6), the
`zone.name` field of the `UPSERT_ZONE` applier in `osi-zone-commands` (replacing
its 128-character bound), and the three create paths: `post-zone-auth`,
`scoped-zone-create-router` and `post-devices-auth`.

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

`renameZone(db, { zoneId, name })` lives in `osi-zone-commands`.
`renameDevice(db, { deveui, name })` lives in a new file
`osi-device-commands/name.js`, exported from that module's `index.js` next to
the weather functions. Each runs one transaction:

1. Read the current row. A missing row raises a not-found error.
2. If the stored name equals the new one, return `{ changed: false }`.
3. Otherwise update `name`, `updated_at` and
   `sync_version = COALESCE(sync_version,0)+1` with bound parameters, and
   return `{ changed: true, sync_version }`.

The REST handlers and the command receiver call these functions. Four older
paths also write a name to an existing row, and they keep doing so:

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

`osi-chirpstack-helper` gains `updateDeviceName(client, devEui, name)`: read
the device, return `unchanged` if the names match, otherwise set the name and
send `UpdateDeviceRequest` under the existing gRPC deadline.

The REST handler and the command function node call it after the database
transaction has committed, never inside it. On failure they log with
`node.warn`, the REST response carries `chirpstack: "failed"`, and the command
acknowledgement stays `APPLIED`.

`ensureDeviceProvisioned` also reconciles the name of an existing device, so a
missed update heals at the next provisioning. Callers pass the value stored in
`devices.name` after their own write, never the raw request value: with scoped
access off, `REGISTER_DEVICE` does not rename an existing row, and ChirpStack
must not run ahead of the database.

### 5.6 Receiver for `UPSERT_DEVICE_NAME`

`osi-device-commands/name.js` exports `applyDeviceNameCommand(db, envelope,
runtime)`, modelled on `osi-installation-location-helper/commands.js`. Payload:

| Field | Rule |
|---|---|
| `command_type` | `UPSERT_DEVICE_NAME`, equal to the envelope type |
| `command_id` | UUID |
| `device_eui` | 16 upper-case hex digits |
| `actor_user_uuid` | UUID of the acting user |
| `values.name` | string; the receiver applies section 4 |

In one transaction the receiver:

1. returns the stored acknowledgement if `applied_commands` already has the
   envelope's command id, and re-queues that acknowledgement;
2. rejects with `REJECTED_PERMANENT` when the payload is malformed, the name
   breaks the rule, the actor is missing or disabled, the device does not
   exist, or `scope.assertFreshDeviceAccess` with `scope.canMutate` refuses;
3. calls `renameDevice`; an unchanged name still acknowledges `APPLIED`;
4. writes the `applied_commands` row and the `command_ack_outbox` row with
   `appliedSyncVersion` set to the device's `sync_version`.

There is no `effect_key` and no base version (D2). The command id deduplicates
replays, and a rename has no physical effect.

A new function node applies the command in the pending-command chain, in the
same position and shape as `installation-revision-command-apply-fn`: it handles
its own type, passes every other message on, and emits the acknowledgement on
`devices/<gatewayEui>/command_ack`. After an `APPLIED` result it runs 5.5.

`UPSERT_DEVICE_NAME` is added to `cmd-type-registry` and to the fallback list
in `reject-indefinite-open`, with `actuator: false` and
`requires_duration: false`.

### 5.7 Legacy `UPSERT_ZONE` name default

In node `4f4a765f36cee6f3`, the `ON CONFLICT` clause keeps the stored name when
the command carries no non-blank name:
`name = CASE WHEN <command has a name> THEN excluded.name ELSE irrigation_zones.name END`.
A first insert still falls back to `Zone`.

### 5.8 Edge GUI

A shared component `EditableName` in
`web/react-gui/src/components/farming/shared/` renders the name, a pencil
button, and in edit mode a text input. Enter or blur saves, Escape cancels and
returns focus to the pencil, a blank or over-long value shows the translated
reason under the input without calling the API, and a server error shows the
translated `reason` or a generic failure text. The interaction matches the
cloud zone card.

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
the three reason texts and the generic failure. Existing Luganda strings are not
edited. New `lg` keys ship the English source text, never a machine
translation, and are listed in `docs/i18n/pending-luganda-translations.md` with
the matching test allowlist entry until a human Luganda pass supplies them.

### 5.9 Constraints on the edge change

- Every file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is copied to
  the bcm2709 profile.
- `scripts/osi-lib-binding-audit.js` pins function nodes by SHA-256 and by
  binding list. Each edited or new function node needs its entry updated.
- A new Node-RED module is registered in the node-red `package.json`, the
  lockfile, `osi-lib/index.js` and
  `files/etc/uci-defaults/98_osi_node_red_seed`, as the existing helper modules
  are.
- `scripts/verify-sync-flow.js` pins GUI and flow files by path. New routes and
  API functions get assertions there, following the repository convention.
- New HTTP nodes use parameterised SQL. The string-concatenated SQL in
  `post-zone-insert` and `post-devices-insert` is not rewritten here.

## 6. Stage 2: cloud (osi-server)

### 6.1 Device rename endpoint

`PATCH /api/v1/devices/{deviceEui}` keeps its path and body. Its behaviour
splits on `isEdgeBacked(device)`:

- Edge-backed: the controller does not touch `name` or `sync_version`. It
  issues `UPSERT_DEVICE_NAME` through `commandService.issueGatewayCommand`
  with the payload from 5.6, stores a pending projection (6.2) and returns
  `202` with the device response carrying the projected name and the
  projection state.
- Cloud-only (no gateway, for example the gateway record itself): the direct
  write stays, without the `sync_version` increment.

A caller who does not own the device gets `403`. Today `assertOwner` throws
`IllegalStateException`, which `GlobalExceptionHandler` maps to `409`. Ownership
stays the write boundary; scoped members are not given rename rights here.

### 6.2 Pending state for devices

`ResourceType` gains `DEVICE`. A device rename stores one projection keyed by
gateway, `DEVICE` and the device EUI, holding the requested name and
`firstRequestedAt`. The device read path overlays the projected name and
exposes the same three fields the zone response has: `firstRequestedAt`,
`projectionState`, `projectionFailureDetail`.

The projection retires on the command's terminal state, never on a bare
`sync_version` comparison. The acknowledgement and the edge event travel on
different channels and can arrive in either order, so an `APPLIED`
acknowledgement alone does not delete the projection; otherwise the old name
would flash back until the event lands.

| Command outcome | Projection | What the user sees |
|---|---|---|
| `APPLIED` acknowledgement | Records the acknowledgement's `appliedSyncVersion` and is deleted once the device mirror row has reached that version, at once if it already has | New name throughout; the clock disappears when the mirror catches up |
| `REJECTED_PERMANENT` | State `REJECTED` with the reason | Edge name again, failure indicator with the reason |
| Expired by `GatewayCommandExpirySweep` | State `FAILED` | Edge name again, failure indicator with the text from 6.6 |

A second rename while one is waiting replaces the projection and supersedes the
older command.

### 6.3 Validation

A `@EntityName` constraint implements section 4, counting code points, and
carries the vector tests. It annotates `RenameRequest`, `RenameZoneRequest`,
`CreateZoneRequest.name` and `RegisterDeviceRequest.name`. Controllers trim
before storing or issuing. `EdgeStrings.fitFreeText` stays as the ingest guard
for older gateways.

### 6.4 Cloud GUI

An `EditableName` component with the behaviour of 5.8 replaces the inline
rename code in `frontend/src/components/farming/IrrigationZoneCard.tsx` and is
added to the device cards (`KiwiSensorCard`, `StregaValveCard`, `DraginoCard`,
`Sdi12SoilCard`, `SenseCapWeatherCard`) and to `pages/DeviceDetail.tsx`. It
calls the existing `devicesAPI.rename` and `irrigationZonesAPI.renameByUuid`
and applies the optimistic overlay the zone card already uses.

The hardcoded English strings in the zone card (`Rename zone`, `Zone name`,
`Zone name cannot be blank.`, `Failed to rename zone.`) move into the locale
files together with the new device strings, in all seven languages.
`localeParity.test.ts` and `missingKeyScan.test.ts` must pass.

### 6.5 SMS zone lookup

`SmsConsentService` receives the zone id from its caller and stops resolving a
zone by display name. `resolveZoneId` is removed. Messages already rendered and
stored in `sms_messages.body` keep the name they were rendered with.

### 6.6 Gateways without the receiver

Such a gateway drops the command without an acknowledgement (2.3). The cloud
does not negotiate capabilities. Rollout order (section 9) keeps this case rare,
and when it happens the command expires, the projection turns `FAILED`, and the
indicator text says that the gateway did not confirm the rename and may need a
software update.

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
| Gateway access admin table, statuses `pending` and `acknowledged` | Clock in the status cell with the existing text as tooltip. Other statuses keep their text |

A name shows at most one indicator. The zone card has two sources
(`zone.desiredState` and `zone.projectionState`); a wrapper shows the clock
when either one is waiting, and the warning glyph when `projectionState` has
failed.

Apply buttons stay disabled while `useDownlinkAction` reports `submitting` or
`pending`. That guard, added after duplicate downlinks were found in
`applied_commands` on a production gateway, does not depend on the pill and must
survive its removal.

## 8. Contract changes

All in `docs/contracts/sync-schema/` in osi-os.

| File | Change |
|---|---|
| `resources.schema.json` | `Zone.name` and `Device.name` gain `maxLength: 100`. `Device.name` stays nullable |
| `commands.schema.json` | `UPSERT_DEVICE_NAME` joins the `command_type` enum; a new `allOf` branch requires `device_eui`, `actor_user_uuid` and `values` with the single required property `name` (`minLength: 1`, `maxLength: 100`) |
| `scripts/test-contract-schemas.js` | A valid and an invalid instance of the new command |

`resources.schema.json` is mirrored byte for byte in
`osi-server/backend/src/test/resources/sync-contract/`, and osi-server CI
compares it. The mirror update is a paired osi-server pull request that merges
together with stage 1. osi-server keeps its own staged `commands.schema.json`;
stage 2 adds the new command there and records a `device_name_v1` capability in
`sync-contract-golden.json`.

`maxLength` tightens a field without changing the meaning of any valid value,
so it stays in the v1 files. `effect-keys.md` and `canonicalization.md` do not
change.

## 9. Rollout

1. osi-os stage 1 merges to `main`, together with the osi-server contract
   mirror pull request.
2. Every gateway of an instance is deployed from a build that contains stage 1.
3. osi-server stages 2 and 3 merge to `main` and deploy to that instance.

Step 2 before step 3 is the reverse of the usual cloud-first order. That order
exists because a cloud without an applier rejects new edge events for good.
This feature adds no event; it adds a command, so the receiver has to exist
before the sender.

Customer branches in both repositories are thin overlays and are re-cut onto
the new `main` after each stage, under the customer-branch runbook. The same
gateway-first order holds per customer instance. Long-diverged legacy lines are
not ported; they receive the feature when their thin re-cut replaces them.

Stage 1 is safe against an older cloud. It emits only events that every
deployed cloud already applies.

## 10. Testing

| Area | Tests |
|---|---|
| Name rule | Section 4 vectors in `osi-entity-name`, `entityName.ts` (both GUIs) and the Java constraint |
| Writers | Changed, unchanged and missing row; `sync_version` increments once; with a linked gateway exactly one outbox row with the new name and the expected op; none when unchanged |
| Receiver | Applied, replayed command id, malformed payload, rule violation, unknown device, disabled actor, actor without access, unchanged name |
| ChirpStack | Updated, unchanged, gRPC failure leaves the rename committed and the acknowledgement `APPLIED`; `ensureDeviceProvisioned` reconciles an existing device's name |
| Routes | Both routes with scoped access off (owner, stranger) and on (admin, researcher, viewer, no access); each reason code |
| Legacy `UPSERT_ZONE` | A command without a name keeps the stored name; a first insert still gets `Zone` |
| Edge GUI | `EditableName`: save on Enter and blur, Escape restores focus, blank and over-long blocked client-side, server reason shown, pencil hidden without mutate rights; locale parity in seven languages |
| Cloud backend | `202` with projection for an edge-backed device; no `sync_version` change on the device row, so the next edge device event is applied and not discarded as stale; an `APPLIED` acknowledgement that arrives before the edge event keeps the projected name visible; retirement on `APPLIED`, `REJECTED_PERMANENT` and expiry; `403` for a non-owner; cloud-only device still renames directly |
| Cloud GUI | `EditableName` on zone and device cards; `PendingClock` states; the nine setting call sites show a clock and keep the button disabled; the three water-moving call sites keep the pill; failure notices keep Retry |
| SMS | Opt-in message keeps its zone id after a rename and with two zones of the same name |

Gates for stage 1: `node scripts/verify-sync-flow.js`,
`node scripts/verify-sync-contract.js`, `node scripts/test-contract-schemas.js`,
`node scripts/verify-sync-op-parity.js`, `node scripts/verify-profile-parity.js`,
`node scripts/osi-lib-binding-audit.js`, and the GUI typecheck and unit tests.
Gates for stages 2 and 3: the full backend suite with `./gradlew test`, and
`npm run test:unit` plus `tsc --noEmit` in `frontend/`. Frontend builds run one
at a time on the development workstation.

A bench check on a test gateway closes stage 1: rename a zone and a device in
the edge GUI, confirm both names in the linked cloud and the device name in the
ChirpStack UI, then stop ChirpStack, rename again and confirm the rename
succeeds with `chirpstack: "failed"`.

## 11. Out of scope

- Porting the whole-device `UPSERT_DEVICE` command to `main`.
- Unique names, per user or per gateway.
- Rename rights for scoped members in the cloud.
- Renaming the gateway on the edge.
- Rewriting names inside synced `DEVICE_DATA_APPENDED` events,
  `field_tester_uplinks.device_name`, stored SMS bodies or downloaded CSV files.
- Making the edge acknowledge unknown command types with a rejection. Worth an
  issue of its own: it would let a cloud tell "gateway too old" from "gateway
  offline".
- Removing the dangling `$ref`s that the staged osi-server `commands.schema.json`
  holds toward definitions absent from `resources.schema.json`.
