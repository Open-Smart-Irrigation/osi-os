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

## Resource phasing

Most resources in `resources.schema.json` ship edge and cloud together. A
resource can also land in phases when the edge and cloud halves are separate
plans merged in lockstep:

| Resource | Op | Status |
|------|------|------|
| `VALVE_SCHEDULE` | `VALVE_SCHEDULE_UPSERTED` | Phase A: edge tables (`valve_schedules`) and REST API (`/api/valves*`) live, edge-only. Sync triggers and the cloud mirror ship with Phase B (lockstep merge). |

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

## Versioning

Contracts are versioned per file. Breaking changes require a new file (e.g. `effect-keys-v2.md`) with a deprecation period in both edge and cloud.
