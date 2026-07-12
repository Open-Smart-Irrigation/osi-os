---
name: osi-common-pitfalls
description: Use when starting or reviewing OSI OS edge work, writing execution plans, checking generated patches, or preparing execution reports where known cross-cutting repo pitfalls could invalidate a small-looking change.
---

# OSI Common Pitfalls

## Overview

This is the short cross-cutting hazard card. Use the owning skill for depth;
use this card to catch the repeated mistakes before committing or reporting.

## Pitfalls

1. **Unfenced FK rebuild wipes children.** Rebuilding parent tables without
   `PRAGMA foreign_keys=OFF` across the drop/rename swap can cascade-delete
   `device_data` and `chameleon_readings`. Depth: `osi-schema-change-control`.

2. **Empty catch blocks are ratcheted.** In touched flow nodes, convert
   `catch (_) {}` / `catch (e) {}` / `catch {}` to visible `node.warn(...)`.
   Verify with `node scripts/verify-no-new-silent-catch.js`.

3. **bcm2712 mirrors to bcm2709.** Payload files under
   `conf/...bcm2712/files/` must be byte-identical in the bcm2709 mirror.
   Verify with `node scripts/verify-profile-parity.js`.

4. **Missing data must look missing.** Do not invent plausible defaults for
   absent sensor, weather, or agronomy data. Propagate `null` end to end.

5. **`flows.json` is script-edited only.** Parse, mutate, stringify, and guard
   roundtrip first; update both profiles. Depth: `osi-flows-json-editing`.

6. **Function-node npm modules need `libs`.** `functionExternalModules: true`
   only enables binding; missing `libs` for `osiDb`, `osiCloudHttp`,
   `chameleon`, or `dendro` can hang async handlers silently.

7. **`const`/`let` inside `try {}` is block-scoped.** If referenced after the
   block, it becomes a silent `ReferenceError` path in async function nodes.
   Declare defaults outside, assign inside.

8. **Never hardcode ChirpStack UUIDs.** MQTT IN topic is always
   `application/+/device/+/event/up`; discriminate device type downstream.

9. **`device_data` sync trigger is INSERT-only.** Historical repairs through
   `UPDATE` need explicit `DEVICE_DATA_APPENDED` outbox events or cloud stays
   stale.

10. **STREGA normal operation is `OPEN_FOR_DURATION`.** A bare `CLOSE` is not
    the normal close path, even in tests; use cancel for operator cancellation.

11. **`export.csv` 401 can be healthy.** Auth-gated exports should return 401
    without a token. Treat 404 or 500 as broken route/server behavior.

12. **Guard tests pin contracts.** If the intended contract changes, update
    the pin in the same commit and state why; do not weaken guards silently.

13. **One source of truth per fact.** Duplicated schema, constants, or protocol
    maps need a verifier that fails on divergence, or they will drift.

14. **Do not assert success through a pipe.** `cmd | tail` reports `tail`'s
    status. Check the real command's exit code directly and paste real output.

15. **Use `osiLib.require()`, not bare `require()`.** Function nodes that need
    a shared helper module must use the `osiLib.require('<seam>')` loader, not
    Node.js `require()`. Bare `require` bypasses the registry and breaks on the
    Pi's OpenWrt layout. Enforced by `node scripts/flows-bare-require-scan.js`.

## Common Mistakes

- Using this card instead of the owning skill for a schema, flow, live-ops, or
  sensor-semantics change.
- Reporting "green" from a remembered pass signal instead of the command's
  current output and exit code.
- Fixing one profile, one schema copy, or one duplicated constant and trusting
  CI to discover the sibling drift later.
