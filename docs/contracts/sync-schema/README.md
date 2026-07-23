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
| `sync-contract-golden.json` | Closed operation sets, command ACK results, and capability rollout state |

## Ownership and vendoring

OSI OS owns these six files. OSI Server vendors byte-identical copies under
`backend/src/test/resources/sync-contract/`; those copies are test inputs, not
an alternate contract authority. Server CI checks out the canonical edge
contract and rejects any missing, empty, or byte-different vendor file.

Contract rollout has three independent facts:

- `schemaAccepted` means the receiver can parse and validate the shape.
- `edgeProducerEnabled` means the edge may emit that capability's events or
  results.
- `cloudIssuerEnabled` means the cloud may issue its commands.

Schema acceptance must land before either enablement flag becomes true. An
accepted but disabled capability is staged, not active. Journal and scoped
access remain staged until their dedicated parity slices prove server handlers
and edge application.

## Versioning

Contracts are versioned per file. Breaking changes require a new file (e.g. `effect-keys-v2.md`) with a deprecation period in both edge and cloud.
