---
name: osi-sync-contract-awareness
description: Use when sync, outbox/inbox/cursor, contract schemas, paired edge/cloud mirrors, pending commands, command/event payloads, resource canonicalization, or osi-os/osi-server sync changes are involved.
---

# OSI Sync Contract Awareness

## Overview

Treat sync as an edge-authoritative contract, not a local implementation detail.
The edge writes canonical state first and emits outbox events; the cloud mirrors
and queues commands until the edge applies them.

Verified sources to re-check before changing behavior:

- `AGENTS.md` sync model, REST endpoint table, MQTT topic table, and production rules.
- `docs/contracts/sync-schema/README.md`.
- `docs/contracts/sync-schema/events.schema.json`.
- `docs/contracts/sync-schema/commands.schema.json`.
- `docs/contracts/sync-schema/resources.schema.json`.
- `docs/contracts/sync-schema/effect-keys.md`.
- `docs/contracts/sync-schema/canonicalization.md`.
- `scripts/verify-sync-contract.js`.
- `scripts/test-contract-schemas.js`.
- `scripts/verify-sync-op-parity.js`.
- `scripts/verify-sync-flow.js`.

## Contract Home

`docs/contracts/sync-schema/` in `osi-os` is the contract source of truth.
Mirror copies in `osi-server`, when present, must match byte-for-byte. From an
`osi-os/.worktrees/*` checkout, do not assume `../osi-server`; locate the real
sister repo first.

Contract files:

- `events.schema.json` - edge outbox event envelope and operation enum.
- `commands.schema.json` - cloud-to-edge pending command payloads.
- `resources.schema.json` - canonical resource shapes.
- `effect-keys.md` - physical-effect idempotency keys and authority.
- `canonicalization.md` - payload-hash canonicalization and golden vectors.

Versioning rule: a breaking semantic change gets a new file, such as
`canonicalization-v2.md`, and a deprecation period on both edge and cloud. Do
not edit v1 semantics in place and hope both runtimes update atomically.

## Transport Invariants

- REST is the only cloud-to-edge command path.
- The edge polls `/api/v1/sync/gateways/{eui}/pending-commands` every 30s.
- MQTT is edge-to-cloud telemetry, heartbeat/status, and command ACK only.
- The edge is not subscribed to the cloud broker.
- Cloud `MqttPublisherService` is deprecated; do not use it to "fix"
  cloud-to-edge commands.

## Authority Rules

- Edge writes local SQLite state first, then emits `sync_outbox` events.
- Cloud-originated edits are pending until the edge applies them.
- Cloud features must not directly mutate synced resource state as if the edge
  already accepted it; queue a pending command and represent pending/applied
  state honestly.
- `user_uuid`, `zone_uuid`, `gateway_device_eui`, and `sync_version` are
  contract identifiers. Tombstones use `deleted_at`, not hard deletes across
  the sync boundary.

## Idempotency Patterns

- `sync_outbox` is edge-to-cloud delivery state.
- `sync_inbox` deduplicates inbound command/event application.
- `sync_cursor` tracks progress for history/resource streams.
- `effect_key` deduplicates repeated physical effects across command replays.
- Result semantics must stay stable: `applied`, `already-applied`, `rejected`
  with a stable reason, and retryable failure metadata. Do not collapse
  protocol rejection into delivered success.
- Use UUID command/event keys plus `sync_version` to make retries harmless.

## Trigger Gotcha

The live `device_data -> sync_outbox` trigger fires on `INSERT`, not `UPDATE`.
Historical repairs that update old rows must explicitly enqueue corrected
`DEVICE_DATA_APPENDED` events or the cloud mirror remains stale.

## Canonicalization

Cross-runtime formulas and hashes live in `canonicalization.md`; do not invent
parallel formulas in JS, TS, or Java.

Examples to re-check:

- SWT pF: `pF = log10(kPa * 10)`; `NULL`, non-finite, and `<= 0` kPa derive
  `null`.
- Edge/GUI TS reference: `web/react-gui/src/utils/swt.ts`.
- Server Java reference: `osi-server/backend/src/main/java/org/osi/server/sync/SyncPayloadCanonicalizer.java`.
- Server vector tests: `osi-server/backend/src/test/java/org/osi/server/sync/SyncPayloadCanonicalizerTest.java`.

## Verification

Run the narrowest relevant set, then report real output and exit status:

```bash
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/verify-sync-flow.js
```

When an `osi-server` mirror or Java/cloud behavior changes too:

```bash
cd /home/phil/Repos/osi-server/backend && ./gradlew test
```

For mirror-byte checks, locate the server repo and compare the actual files
with `cmp` or `sha256sum`; do not rely on matching filenames in a stale branch.

## Cross-Repo PR Rule

Use paired branches/PRs for paired edge/cloud changes. Never cross-commit from
one repo into the other. Each PR must state:

- Contract files changed.
- Whether a mirror update is required.
- Where the paired PR/branch lands.
- Which edge and server verification commands were run.

## Common Mistakes

- Treating a server-side update as canonical before the edge applies it.
- Adding a cloud-to-edge MQTT path because it looks simpler than pending
  commands.
- Editing v1 contract semantics in place for a breaking change.
- Updating `device_data` history without explicit outbox backfill events.
- Changing pF, timestamp, UUID, EUI, or number canonicalization in one runtime
  only.
- Reporting `verify-sync-flow.js | tail` instead of the verifier's own exit
  status and relevant output.
