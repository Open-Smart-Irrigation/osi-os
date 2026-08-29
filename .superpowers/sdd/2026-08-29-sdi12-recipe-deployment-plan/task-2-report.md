# Task 2 report: Sentek recipe compiler

## Result

Created `osi-sdi12-recipe`, a pure CommonJS compiler for valid one-to-ten-module Sentek layouts. It calls `validateSentekLayout()` from `osi-sdi12-normalize`, hashes that validator's canonical layout, compiles VWC before TriSCAN VIC slots, emits the approved global, AF, tail-clear, and TDC frames, and encodes discovery or addressed identify commands.

The compiler has no default sensor address. Every command address comes from the validated layout. The fixed leading `0` in a DATACUT string is the Dragino cut configuration field, not an SDI-12 address.

## RED and GREEN evidence

RED command:

```text
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js
```

Initial result: exit 1. Node reported `Error: Cannot find module './index.js'` from the new test, before any compiler implementation existed.

GREEN command:

```text
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js
```

Final result: exit 0, 7 tests passed. The generated test executed all 2,046 masks: `sum(2^n, n=1..10) = 2046`.

The suite covers canonical object and sensor ordering, bounded invalid-layout results, VWC and VIC boundaries at 3/4/6/7/9/10 values, the eight-position field fixture, global frame ordering, active-slot command/cut pairs, unused-tail clearing, and `?!`, `0I!`, and `CI!` identify encodings.

The exact field fixture includes the required AF bytes:

```text
AF010109304D212C312C312C3200
AF02010B304431212C302C302C3200
```

The approved D-response AF fixture uses `0B` as its length byte although the visible `0D1!,0,0,2` ASCII contains ten bytes. The compiler preserves that bench-approved byte sequence; command frames other than D responses use the ordinary ASCII length.

## Runtime delivery registration

Registered `sdi12-recipe -> osi-sdi12-recipe` in both `osi-lib` copies. Both runtime package manifests and lockfiles include the local dependency, both seed scripts copy the module, and `deploy.sh` fetches the package and index beside the existing SDI-12 helpers. `verify-helper-registration.js` now also compares the two profile registries, so a mirror-only alias omission fails the verifier.

## Verification

Commands run from the repository root, all exit 0:

```text
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js
  7 passed, 0 failed; exhaustive count 2,046.

node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
  6 passed, 0 failed.

node scripts/verify-helper-registration.test.js
  6 passed, 0 failed.

node scripts/verify-helper-registration.js
  All helper-registration checks passed.

node scripts/verify-profile-parity.js
  All parity checks passed.

git diff --check
  No output; exit 0.
```

## Changed files

- Both profile copies of `osi-sdi12-recipe/{package.json,index.js,index.test.js}`.
- Both profile copies of `osi-lib/index.js`, `osi-lib/index.test.js`, Node-RED `package.json`, `package-lock.json`, and `98_osi_node_red_seed`.
- `deploy.sh`.
- `scripts/verify-helper-registration.js` and `scripts/verify-helper-registration.test.js`.

## Staging treatment

`deploy.sh` already contained user-owned changes before this task. The Task 2 fetch hunk at the existing SDI-12 helper block is staged separately. The pre-existing dependency-installer and health-probe hunks remain unstaged.

## Self-review and concerns

The review checked that the compiler does not reimplement layout validation, cannot emit more than eight slots, does not clear active slots, emits no broad reset, and derives every SDI-12 command address from the layout. The only protocol concern is the D-response AF length-byte exception described above; it follows the task's exact required fixture and needs no further implementation change.
