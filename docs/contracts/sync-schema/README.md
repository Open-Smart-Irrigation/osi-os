# Sync Schema Contracts

This directory pins the cross-repo contract surface between `osi-os` (edge) and `osi-server` (cloud). Files here are the source of truth; any mirrored copies in `osi-server` must match bytewise.

## Files

- `effect-keys.md` — effect-key format strings and authority rules (WS1, WS3)
- `canonicalization.md` — payload-hash canonicalization rules (Phase 0, lands with WS2 plan)
- `commands.schema.json` — JSON Schema for command payloads (Phase 3)
- `events.schema.json` — JSON Schema for event payloads (Phase 3)
- `resources.schema.json` — JSON Schema for sync resources (Phase 3)

## Versioning

Contracts are versioned by file. Breaking changes require a new file (`effect-keys-v2.md`) and a deprecation period in both edge and cloud.
