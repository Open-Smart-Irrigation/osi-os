# Sync Schema Contracts

Cross-repo contract surface between `osi-os` (edge) and `osi-server` (cloud). Files here are the source of truth; any mirrored copies in `osi-server` must match bytewise.

## Files

| File | Purpose |
|------|---------|
| `effect-keys.md` | Effect-key format strings and authority rules |
| `canonicalization.md` | Payload-hash canonicalization rules |
| `commands.schema.json` | JSON Schema for command payloads |
| `events.schema.json` | JSON Schema for event payloads |
| `resources.schema.json` | JSON Schema for sync resources |
| `watermark-cloud-parity-v1.json` | Synthetic WATERMARK/cloud parity vectors and staged mutation contract |

## Resource phasing

Most resources in `resources.schema.json` ship edge and cloud together. A
resource can also land in phases when the edge and cloud halves are separate
plans merged in lockstep:

| Resource | Op | Status |
|------|------|------|
| `VALVE_SCHEDULE` | `VALVE_SCHEDULE_UPSERTED` | Phase A: edge tables (`valve_schedules`) and REST API (`/api/valves*`) live, edge-only. Sync triggers and the cloud mirror ship with Phase B (lockstep merge). |
| `WATERMARK_CALIBRATION` | `WATERMARK_CALIBRATION_UPSERTED` / `WATERMARK_CALIBRATION_DELETED` | Implemented with edge outbox events, retained tombstones, bootstrap and force-sync state, a cloud mirror, and pending-first exact-base commands. |

## WATERMARK cloud parity

`WATERMARK_CALIBRATION` is edge-authoritative and device-keyed. Its two events
are `WATERMARK_CALIBRATION_UPSERTED` and
`WATERMARK_CALIBRATION_DELETED`. The edge includes retained live rows and
tombstones in bootstrap and force-sync snapshots; the cloud applies events and
snapshots only in the authenticated gateway context that owns the device.

Four cloud-originated operations use protected pending commands:

| Capability | Command | Effect key |
|---|---|---|
| `watermark_v1` | `SET_WATERMARK_CALIBRATION` | `watermark_calibration:set:{gateway_eui}:{device_eui}:{base_sync_version}` |
| `watermark_v1` | `DELETE_WATERMARK_CALIBRATION` | `watermark_calibration:delete:{gateway_eui}:{device_eui}:{base_sync_version}` |
| `chameleon_config_commands_v1` | `SET_CHAMELEON_CONFIG` | `chameleon_config:set:{gateway_eui}:{device_eui}:{base_sync_version}` |
| `device_soil_depth_commands_v1` | `UPSERT_DEVICE_SOIL_DEPTHS` | `device_soil_depths:set:{gateway_eui}:{device_eui}:{base_sync_version}` |

All EUI segments are uppercase 16-hex strings, and the base is an unpadded
non-negative integer. The edge validates gateway, device, local actor, operation,
base, and normalized intent before replay lookup or mutation. A cloud request is
pending until the edge ACK and the authoritative mirror state converge.

The rollout is cloud-first. Deploy cloud schema, contract acceptance, event
appliers, pending-command support, and capability-aware UI before an edge begins
advertising these tokens or emitting the new events. Reconcile a pre-existing
edge calibration through bootstrap before allowing its first cloud edit. An
older gateway keeps ordinary device-data sync and receives none of these
commands.

FPort 11 publishes a contact-only MQTT envelope. Contact advances `lastSeen`;
an accepted canonical snapshot advances `currentStateRecordedAt`. A rejected
frame can advance contact without advancing measurement time, and neither
timestamp may move backwards.

Raw WATERMARK diagnostics never cross this contract. `watermark_readings`, raw
payloads, ADC codes, flags, resistance, offset, supply, die temperature,
per-reading calibration versions, and conversion versions are absent from
events, snapshots, and contact messages. Canonical SWT and external-temperature
values continue through ordinary device-data history sync.

Cloud parity does not change scheduler eligibility. The edge scheduler excludes
every `device_data` row linked to `watermark_readings`; no capability, command,
mirror row, or qualification record overrides that interlock.

## Entity name commands (`UPSERT_ZONE_NAME`, `UPSERT_DEVICE_NAME`)

Two boundary details apply to these commands:

- `zone_uuid`: the edge accepts both UUID spellings on zone commands — 32 hex
  digits without dashes, which is what a zone created on the gateway carries,
  and the hyphenated form a cloud-created zone carries. `osi-zone-commands`
  and the command schema accept both forms.
- `values.name`: `maxLength: 100` counts the raw string, while the receiver
  trims before it counts, so a padded 100-character name passes the receiver
  and fails the schema. The cloud normalizes the name before it sends the
  command (design section 6.6), so the two agree on every command that is
  actually issued.

## Zone `weather_source`

`Zone.weather_source` is the zone's weather provider key: `auto`, `open_meteo`,
`meteoswiss` or `local` on the edge, and keys only the cloud implements
(`openagri`, `agromonitoring`). The schema checks the shape (`^[a-z_]{1,20}$`; the
cloud column is `VARCHAR(20)`), not a set of values. The edge stores the field from
`UPSERT_ZONE_CONFIG`, legacy `UPSERT_ZONE` and protected `UPSERT_ZONE`, and reports
`zone_config_weather_source_v1`.

On this branch (final review `final-review-fable.md` finding I1) the edge never
pushes its default over a value the cloud already chose: the zone update event and
the bootstrap and force-sync snapshots carry the `weather_source` key only when the
stored value is not `auto`, or, for the update event only, when the value changed
in that update (so a reset to `auto` is sent exactly once). Otherwise the key is
absent from the payload, never `null`. From sub-project 4 on, once the cloud makes
the field edge-owned and sends cloud edits as capability-gated commands, the cloud
will send the field only to a gateway that reported the token, and a gateway
without it will reject a protected `UPSERT_ZONE` that carries the field. Until that
cloud change is live, a provider chosen on the cloud stays a cloud value — cloud
main removes the field from every command today.

**Deploy order.** The bootstrap and force-sync snapshots run unattended (the
bootstrap endpoint on a roughly six-hour cadence per AGENTS.md); this omission
rule is the only edge-side guard against overwriting a cloud-chosen provider.
Deploy the cloud side of sub-project 4 before any edge carrying this migration
reaches a cloud-linked gateway; see "Ownership and deploy order" in the design
spec for the full reasoning and the cost if the order is reversed.

## Zone `stage_started_on`

`Zone.stage_started_on` is the date the zone's current growth stage began
(`YYYY-MM-DD`, or null), the start of the FAO-56 Kc curve
(`docs/contracts/agronomy/README.md`). The schema checks a real calendar date
(`"format": "date"`). The edge stores the field from the zone route,
`UPSERT_ZONE_CONFIG`, legacy `UPSERT_ZONE` and protected `UPSERT_ZONE`, emits it
in every zone update event and in the bootstrap and force-sync snapshots, and
reports `zone_config_stage_started_on_v1`. Unlike `weather_source` above, the key
is always present, null when unset: an ordinary zone field with no default that
could stand in for a value. Both servers apply the same rules to a
write that carries a stage: a change to unset clears the date, a change to another
set stage without a date sets the zone-local today, the same stage keeps it, and a
supplied date wins. The cloud sends the field only to a gateway that reported the
token: a gateway without it rejects a protected `UPSERT_ZONE` that carries the
field.

Limit: the legacy `UPSERT_ZONE_CONFIG` path builds its default date from the
command's own `timezone` field, falling back to UTC when the command names
none — never from the zone's stored timezone. It builds the UPDATE statement
without reading the row first, and SQLite carries no timezone data of its own,
so there is no cheap exact fix. A zone far from UTC (for example
`Africa/Kampala`, UTC+3) whose stage changes near local midnight without a
timezone in the command can get the previous or next calendar day instead of
the zone's own. This is reachable only from a cloud older than this
sub-project's stage-date support; every current write path (the zone route,
protected `UPSERT_ZONE`, and Terra) reads the zone's stored timezone and does
not have this limit.

Known difference, parked: the protected `UPSERT_ZONE` takes the stage-date
default from the zone's stored timezone even when the same command also
changes `timezone`, while the zone route and the legacy node take the
command's own `timezone` field instead; this shows only when a command
changes both together around local midnight, and costs at most a start date
one day off.

## `ZONE_AGRONOMY_UPSERTED`

One event per insert of a `zone_daily_agronomy` row and per change of its
`sync_version`, emitted by the migration-owned triggers of
`0067__zone_daily_agronomy_sync.sql` while the gateway is linked and the zone is
live with a UUID. The aggregate key is the composite `zone_uuid|date`, which no
single payload path holds, so `x-semantic-bindings` binds only
`payload.sync_version` (`test-contract-schemas.js` and `verify-sync-contract.js`
pin the same entry). Rows are never deleted: a row written ahead of the clock is
retracted by an update with null values, `null_reason = 'retracted'` and the next
version. The scheduled bootstrap repeats the last 30 days of each zone in
`zoneAgronomy` (at most 1,000 rows); a force sync does not.

## Versioning

Contracts are versioned per file. Breaking changes require a new file (e.g. `effect-keys-v2.md`) with a deprecation period in both edge and cloud.
