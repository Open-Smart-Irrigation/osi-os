# SDI-12 multi-segment uplinks — execution report

- **Plan:** `docs/superpowers/plans/2026-08-19-sdi12-multi-segment-uplinks-plan.md`
- **Spec:** `docs/superpowers/specs/2026-08-19-sdi12-multi-segment-uplinks-design.md`
- **Repo/branch:** `/home/phil/Repos/osi-os-agrolink`, `AgroLink`
- **Range:** `19ca945e..f73df304` (starting head `fb7bfbe1`, a descendant of `19ca945e`)
- **Result:** Tasks 0–7 complete. Every gate in the plan's battery is green. No HALT condition was hit.

## Commits

| Task | Commit | Summary |
|---|---|---|
| 0 | `fb7bfbe1` (pre-existing) | Baseline verified green; spec/plan doc commit already present at HEAD |
| 1 | `86efeece` | Codec decodes payver-2 multi-segment header |
| 2 | `6e21d104` | `osi-sdi12-reassemble` state machine (new helper module) |
| 3 | `344a1c47` | `osi-device-writer` `quarantineOnly` export |
| 4 | `85d8ef14` | `sdi12-gate-fn` reassembly dispatch + `sdi12-write-fn` quarantine-only branch (flows.json, both profiles) |
| 5 | `b88181e5` | Golden vectors: complete 2-segment 8-value EnviroSCAN + incomplete 3-segment case |
| 6 | `f73df304` | `uplinkBudgetOk` + `dragino-sdi12.md` multi-segment section and EnviroSCAN recipe |

## Per-task gate evidence

### Task 0 — baseline

```
$ node scripts/verify-sdi12-codec.js
verify-sdi12-codec: PASS

$ (cd .../osi-sdi12-normalize && node --test)
# tests 19
# pass 19
# fail 0

$ node scripts/verify-device-integration.js 2>&1 | tail -3
# tests 28
# pass 28
# fail 0
```

`git log --oneline -1` was `fb7bfbe1`, a descendant of `19ca945e`; `git status -s` was clean apart from an untracked, empty, unrelated `node_modules/.vite` directory. The plan's Task 0 step 3 (commit the spec/plan doc) was already satisfied: `fb7bfbe1` is exactly that commit ("docs(sdi12): multi-segment uplink spec + plan (post-review)"), so no new commit was made for that step.

### Task 1 — codec payver-2 header

Failing-test confirmation before the implementation:

```
$ node scripts/verify-sdi12-codec.js
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
undefined !== 3
    at .../verify-sdi12-codec.js:63:8
```

After implementing the `payver` branch:

```
$ node scripts/verify-sdi12-codec.js
verify-sdi12-codec: PASS

$ node scripts/verify-profile-parity.js
All parity checks passed.

$ node scripts/verify-codec-robustness.js
Codec robustness verification passed
```

### Task 2 — `osi-sdi12-reassemble`

Failing-test confirmation (module did not exist yet):

```
$ node --test
not ok 1 - index.test.js
# fail 1
```

After implementation, all 10 unit tests (in-order, out-of-order, passthrough,
duplicate index, count mismatch, index-out-of-range, window timeout, device
isolation, invalid-shape rejection, status text):

```
$ node --test
# tests 10
# pass 10
# fail 0

$ node scripts/verify-helper-registration.js
All helper-registration checks passed.

$ node scripts/verify-profile-parity.js
All parity checks passed.
```

### Task 3 — writer `quarantineOnly`

Failing-test confirmation:

```
$ node --test
# tests 17
# pass 16
# fail 1
```

After implementation:

```
$ node --test
# tests 17
# pass 17
# fail 0
```

### Task 4 — flows.json gate/write wiring

Edited via a one-shot scratchpad script
(`/tmp/.../scratchpad/flows-edit-task4.js`) with the byte-identical roundtrip
guard run before and after the mutation on both profile copies, and an
explicit ordering check that all `sdi12*` node indices stay below the first
`journal-v2-replication-*` node index (680 vs 681, unchanged before/after).
The diff touched exactly two nodes (`sdi12-gate-fn`, `sdi12-write-fn`) plus
`sdi12-gate-fn`'s new `libs` entry; verified with `git diff --stat` (2 files,
10/2 lines) and a full content diff before committing.

```
$ node scripts/verify-flows-fn-parse.js
verify-flows-fn-parse: OK

$ node scripts/test-flows-wiring.js
PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed

$ node scripts/verify-no-new-silent-catch.js
verify-no-new-silent-catch: OK (89/89 baseline, both profiles)

$ node scripts/flows-bare-require-scan.js
(exit 0)
```

The size ratchet failed on the first run (measure step), then was raised with
appended reasons and passed:

```
$ node scripts/verify-flows-size-ratchet.js   # before raising
FAIL sdi12-gate-fn is 2963 chars, exceeding its committed ceiling of 1034 (+1929)
FAIL sdi12-write-fn is 4792 chars, exceeding its committed ceiling of 3830 (+962)
FAIL total embedded JS is 1293363 chars, exceeding the committed max_total of 1290472 (+2891)

$ node scripts/verify-flows-size-ratchet.js   # after raising
OK conf/.../bcm2712/.../flows.json (total 1293363 <= max_total 1293363)
OK conf/.../bcm2709/.../flows.json (total 1293363 <= max_total 1293363)
verify-flows-size-ratchet: OK
```

```
$ node --test scripts/migrate-flows-journal-v2-replication.test.js
# tests 4 / pass 4

$ node scripts/verify-live-gateway-identity.js
Live gateway identity verification passed.   # no hash-pin mismatch (not a HALT)

$ node scripts/verify-profile-parity.js
All parity checks passed.

$ node scripts/verify-sync-flow.js
All parity checks passed.
```

### Task 5 — golden vectors

Failing-test confirmation (runner did not yet understand `vector.segments`):

```
not ok 14 - round-trip: Sentek EnviroSCAN 8 values over 2 segments (payver 2)
  null !== 0.1   (SDI-12 column vwc_1 must match the golden vector)
not ok 15 - round-trip: 3 segments, middle missing -> incomplete, quarantine only
  TypeError: Cannot read properties of undefined (reading 'swt_1')
```

After the runner extension:

```
$ node scripts/verify-device-integration.js
ok 14 - round-trip: Sentek EnviroSCAN 8 values over 2 segments (payver 2)
ok 15 - round-trip: 3 segments, middle missing -> incomplete, quarantine only
# tests 30 / pass 30 / fail 0
```

The reassembly-then-normalize round-trip and the forced-window reset were
each spot-verified independently against the fixture's byte arrays before
being wired into the runner (`node -e ...` one-liners loading the codec,
`osi-sdi12-reassemble`, and `osi-sdi12-normalize` directly), confirming the
expected 8 `vwc_N` values and the `3:[0,2]` quarantine raw string.

### Task 6 — normalizer budget + docs

```
$ node --test   # osi-sdi12-normalize
# tests 20 / pass 20 / fail 0   (19 pre-existing + 1 new uplinkBudgetOk test)

$ node scripts/verify-device-integration.js
# tests 30 / pass 30 / fail 0

$ node scripts/verify-profile-parity.js
All parity checks passed.

$ node /home/phil/Repos/osi-os/.claude/skills/anti-slop-writing/slop-check.js docs/devices/dragino-sdi12.md
slop-check: PASS (no tier-1 findings)
```

## Task 7 — full battery (final run, all commands from the plan)

```
node scripts/verify-sdi12-codec.js                              -> PASS
node scripts/verify-codec-robustness.js                          -> Codec robustness verification passed
(osi-sdi12-reassemble)  node --test                               -> tests 10, pass 10, fail 0
(osi-sdi12-normalize)   node --test                               -> tests 20, pass 20, fail 0
(osi-device-writer)     node --test                               -> tests 17, pass 17, fail 0
node scripts/verify-device-integration.js                        -> tests 30, pass 30, fail 0
node scripts/verify-helper-registration.js                       -> All helper-registration checks passed.
node scripts/verify-flows-fn-parse.js                             -> verify-flows-fn-parse: OK
node scripts/test-flows-wiring.js                                 -> PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed
node scripts/verify-no-new-silent-catch.js                        -> OK (89/89 baseline, both profiles)
node scripts/flows-bare-require-scan.js                           -> exit 0
node scripts/verify-flows-size-ratchet.js                         -> OK (total 1293363 <= max_total 1293363, both profiles)
node --test scripts/migrate-flows-journal-v2-replication.test.js  -> tests 4, pass 4, fail 0
node scripts/verify-live-gateway-identity.js                      -> Live gateway identity verification passed.
node scripts/verify-profile-parity.js                             -> All parity checks passed.
node scripts/verify-sync-flow.js                                  -> All parity checks passed.
bash scripts/check-mqtt-topics.sh                                 -> OK x3 (bcm2712, bcm2709, bcm2708)
```

All 17 commands green. No frontend build was run (no GUI change, per the
plan). No push, deploy, or SSH occurred.

Final `git status -s`: clean apart from an untracked, empty, unrelated
`node_modules/.vite` directory that predates this work and was never touched.

## Deviations from the plan text

1. **Task 0 — docs commit already existed.** The plan's Task 0 step 3 asks to
   commit the spec/plan docs. They were already committed at HEAD (`fb7bfbe1`,
   "docs(sdi12): multi-segment uplink spec + plan (post-review)"), a
   descendant of the plan's stated `19ca945e` baseline. No new commit was
   needed or made for that step; this is recorded as a pre-satisfied
   precondition, not a fix-forward.
2. **Task 4 — `sdi12-gate-fn`'s `libs` field anchor.** The plan states
   `sdi12-gate-fn`'s `libs` is "currently `null`". The actual node had no
   `libs` key at all (`'libs' in gate` was `false`), not a `null` value. This
   is a cosmetic drift in the plan's description of the anchor, not a
   contradiction of intent: the required end state (`libs: [{"var":
   "osiLib","module":"osi-lib"}]`) was applied exactly as specified, and
   `test-flows-wiring.js`'s "function node helper globals all declare
   matching libs entries" check confirms it registered correctly. No fix
   was needed beyond adding the key.
3. **Task 1 — robustness table.** The `sdi12` entry in
   `scripts/verify-codec-robustness.js` is single-`representativeFrame`-only
   (no multi-frame schema), so per the plan's own conditional instruction no
   payver-2 frame was added there; the fuzz pass and
   `scripts/verify-sdi12-codec.js`'s explicit payver-2 assertions cover the
   branch instead.

No design-level contradictions were found. No previously-green gate went red
for reasons other than the change that gate was meant to catch (the flows
size ratchet failures in Task 4 were the expected measure-and-raise signal,
not a regression). `verify-live-gateway-identity.js` reported no hash-pin
change on any protected function node.
