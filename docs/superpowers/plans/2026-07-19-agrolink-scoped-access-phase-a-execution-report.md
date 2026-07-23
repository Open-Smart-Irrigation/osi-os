# AgroLink scoped-access Phase A — execution report

Status: **ACCEPTED**. Plan: `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-a.md`.
Worktree: `.worktrees/agrolink-phase-a`, branch `feat/agrolink-scoped-access-phase-a`, rebased onto `8f73306f`.
Head at final gate: `9e7da38af5deac4efa2c02459e656dc85db3ea89` (`docs: phase-c write paths carry the sync_version bump contract`).

Task 12's brief command list (17 commands) passed on the first run at `d6fe2328`. A cross-check
against the `osi-verification-commands` skill's surface-selection table for "edge schema, seed,
bundled DBs, migrations" added two gates the brief omits: `verify-trigger-body-parity.js` and
`verify-boot-ddl-interpolation.js`. The second failed on that run. A fix wave landed the correction;
all 19 commands are green at the current head. Details in "Blocker and resolution" below.

## Blocker and resolution

**First run (head `d6fe2328`):** all 17 brief commands passed. The two skill-added gates found
`verify-trigger-body-parity.js` green and `verify-boot-ddl-interpolation.js` red on both flow
profiles:

```
FAIL conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (60 boot statements executed):
  - trg_dp_users_outbox_uuid_au: op *_UPSERTED passes literal 0 as sync_version (issue #10 terminal rejection)
  - trg_dp_users_outbox_ai: op *_UPSERTED passes literal 0 as sync_version (issue #10 terminal rejection)
  - trg_dp_users_outbox_role_au: op *_UPSERTED passes literal 0 as sync_version (issue #10 terminal rejection)
FAIL conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (60 boot statements executed):
  - trg_dp_users_outbox_uuid_au: op *_UPSERTED passes literal 0 as sync_version (issue #10 terminal rejection)
  - trg_dp_users_outbox_ai: op *_UPSERTED passes literal 0 as sync_version (issue #10 terminal rejection)
  - trg_dp_users_outbox_role_au: op *_UPSERTED passes literal 0 as sync_version (issue #10 terminal rejection)
verify-boot-ddl-interpolation: FAIL
```

`verify-boot-ddl-interpolation.js` seeds a scratch DB from `database/seed-blank.sql`, replays the
frozen boot node's (`sync-init-fn`) DDL rewrite statements on top, then scans every `trg_dp_%`
trigger in the result for an op ending in `_UPSERTED` that passes a literal `0` for `sync_version`,
the shape of a previously shipped defect the script calls "issue #10 terminal rejection" (the
cloud watermark rejects every recompute at equal version via `equal_version_payload_conflict`).
It does not distinguish boot-owned triggers from migration-owned ones. The three USER-aggregate
triggers migration 0022 added (`33b94e02`) share that naming and op convention and did pass a
literal `0`. That literal had already been flagged in the Task 1-5 review as a Minor
("sync_version hardcoded 0 (plan-mandated)"), but that review's gate list did not include
`verify-boot-ddl-interpolation.js`, so the regression guard never ran against it before this
final gate.

I confirmed the failure was not inherited: running the identical command against the branch's
merge-base (`8f73306f`), with `flows.json` and `seed-blank.sql` extracted from that commit,
exited 0. The regression was introduced by migration 0022 (`33b94e02`), and I reported BLOCKED
per the run rules rather than fixing it myself.

**Consult verdict and fix.** The coordinator's follow-up identified the root cause precisely: the
shipped `SyncEventTxExecutor` applies an unconditional per-resource watermark before handler
dispatch, so after the first `USER_UPSERTED` at version 0, any later `role`/`disabled_at` change
would hash differently at the same version 0 and be rejected as `equal_version_payload_conflict`,
so a disabled user's cloud access would never actually revoke. The fix (commit `101d1f2f`,
`fix(schema): users.sync_version + versioned USER emission (boot-ddl gate)`) gives `users` its
own `sync_version INTEGER NOT NULL DEFAULT 0` column, matching every sibling aggregate table; the
three triggers now read `NEW.sync_version` instead of the literal `0`, in both the outbox column
and the JSON payload. The commit updated `CHECKSUMS.json`, `seed-blank.sql`, all 7 bundled
`farming.db` copies, and `verify-db-schema-consistency.js`'s `users` column contract to match, and
extended the rehearsal test with a red-first case (test 4: payload `sync_version` `undefined !==
0` against the unfixed triggers) before applying the schema fix. A second commit (`9e7da38a`)
corrected `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-c.md` so its write-path
SQL states the writer-bumped `sync_version` contract explicitly (spec now v7).

**Re-run.** All 19 commands were re-run against head `9e7da38a`; all exit 0. See the gate
transcript below, including the rehearsal test's new 7th case and
`verify-boot-ddl-interpolation.js`'s now-passing output.

## Per-task summary

Source: `.superpowers/sdd/progress.md`, plan section `agrolink-scoped-access-phase-a`. All 11
implementation tasks are complete and Fable-reviewed; the fix wave above is a post-Task-12
correction, not a renumbered task.

| Task | Commits | Review verdict |
|---|---|---|
| 1: rehearsal test (red) | `c35aaea2` | — (TDD red step) |
| 2-4: migrations 0022-0023, boot-survival prep | `f6b60a1f`, `6adc0b5b`, `33b94e02`, `7084dcb1` | Fable: spec COMPLIANT / quality APPROVED. One Important fix landed at `7084dcb1`, re-approved. |
| 5 (Slice 1+2, Tasks 1-5 as reviewed): migration core + parity surfaces | rebased range `c35aaea2..33b94e02` | Controller re-ran `verify-migrations`/`verify-seed-replay`/`verify-runtime-schema-parity`/`verify-profile-parity`/`verify-db-schema-consistency` PASS, rehearsal 5/5; reviewer also ran `verify-no-stray-ddl` OK. |
| 6 (Slice 3): boot-survival guard | `141ca267`, CI wiring `a5adcc77` | Sonnet review: spec COMPLIANT / quality APPROVED. 30-drop pin independently re-derived. |
| 7 (Slice 4): `osi-scope-helper` seam module | `651d1a24` | Fable: spec COMPLIANT / quality APPROVED. 7/7 unit tests. `profile-parity`/`sync-flow` red by design until Task 8 mirrors it. |
| 8 (Slice 4): registration surfaces | `0f8ab88b` | Sonnet: spec COMPLIANT / quality APPROVED, zero findings. Both mirrors 7/7. |
| 9 (Slice 5): `/api/me` | `ad1c8cc9` | Fable: spec COMPLIANT / quality APPROVED. Behavioral harness 7/7 red-to-green, zero allowances. |
| 10 (Slice 5): scoped bootstrap | `3c900d24` | Fable: spec PASS / quality APPROVED. Behavioral 13/13, rehearsal extended to 6/6. |
| 11 (Slice 5): features flag | `d6fe2328` | Sonnet: spec EXACT-MATCH / quality APPROVED. 55/55 contract tests. |
| Fix wave (post-Task-12): `users.sync_version` + versioned USER emission | `101d1f2f`, `9e7da38a` | Dispatched by the coordinator after the boot-ddl blocker; rehearsal extended 6/6 -> 7/7; `verify-boot-ddl-interpolation.js` now green both profiles. |

Full commit range `8f73306f..9e7da38a`, 14 commits, in order: `c35aaea2`, `f6b60a1f`,
`6adc0b5b`, `33b94e02`, `7084dcb1`, `141ca267`, `a5adcc77`, `651d1a24`, `0f8ab88b`, `ad1c8cc9`,
`3c900d24`, `d6fe2328`, `101d1f2f`, `9e7da38a`.

## Gate transcript (final run, head `9e7da38a`)

### Brief's Step 1 command list (17 commands, run in the order given)

| # | Command | Exit | Key output |
|---|---|---|---|
| 1 | `node scripts/verify-migrations.js` | 0 | `verify-migrations: OK (23 migrations, checksum manifest OK, base immutability OK)` |
| 2 | `node scripts/verify-seed-replay.js` | 0 | `verify-seed-replay: OK` |
| 3 | `node scripts/verify-runtime-schema-parity.js` | 0 | `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)` |
| 4 | `node scripts/verify-db-schema-consistency.js` | 0 | `OK` for all 7 bundled `farming.db` copies; `DB schema consistency verification passed` |
| 5 | `node scripts/verify-no-stray-ddl.js` | 0 | `verify-no-stray-ddl: OK (HEAD total 702 <= origin/main total 702; committed baseline matches HEAD total 702)` |
| 6 | `node scripts/verify-profile-parity.js` | 0 | 19 `OK:` rows + 5 `OK: absent:` rows; `All parity checks passed.` |
| 7 | `node scripts/verify-sync-flow.js` | 0 | Runs the full contract + consistency + parity chain; ends `Sync flow verification passed` then a second `All parity checks passed.` block for the chained profile-parity pass |
| 8 | `node scripts/verify-helper-registration.js` | 0 | `OK` for 18 modules x 2 profiles including `osi-scope-helper`; `All helper-registration checks passed.` |
| 9 | `node scripts/verify-no-new-silent-catch.js` | 0 | `verify-no-new-silent-catch: OK` — 224/224 empty catches on both profiles, matches baseline |
| 10 | `node scripts/verify-flows-size-ratchet.js` | 0 | `verify-flows-size-ratchet: OK (HEAD total 2117070 <= origin/main total 2138490; committed baseline not exceeded)` |
| 11 | `node scripts/flows-bare-require-scan.js` | 0 | No output; clean pass |
| 12 | `node scripts/verify-flows-fn-parse.js` | 0 | `verify-flows-fn-parse: OK` — 242/242 (bcm2712), 242/242 (bcm2709), 64/64 (bcm2708) |
| 13 | `node scripts/test-flows-wiring.js` | 0 | 24 `OK` rows; `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed` |
| 14 | `scripts/check-mqtt-topics.sh` | 0 | `OK:` for all 3 flow copies — no UUID patterns in MQTT IN topics |
| 15 | `node --test scripts/rehearse-scoped-access-migration.test.js` | 0 | `# tests 7 / # pass 7 / # fail 0` — new test 4, `USER trigger arms emit users.sync_version, not literal 0 (issue #10 boot-ddl gate)`, passes |
| 16 | `node --test scripts/rehearse-scoped-trigger-boot-survival.test.js` | 0 | `# tests 2 / # pass 2 / # fail 0` |
| 17 | `node --test .../node-red/osi-scope-helper/index.test.js` | 0 | `# tests 7 / # pass 7 / # fail 0` |

All 17 exit 0.

### Cross-check addition against the `osi-verification-commands` skill

| # | Command | Exit | Key output |
|---|---|---|---|
| 18 | `node scripts/verify-trigger-body-parity.js` | 0 | `OK` for both profiles — `all boot-managed trigger bodies match seed-blank.sql after canonicalization`; `verify-trigger-body-parity: OK` |
| 19 | `node scripts/verify-boot-ddl-interpolation.js` | 0 | `OK` for both profiles — `60 boot statements; no gatewaySql leak; versioned outbox triggers pass NEW.sync_version`; `verify-boot-ddl-interpolation: OK` |

All 19 commands exit 0 at head `9e7da38a`.

## Spec §15 Phase A gate — acceptance checklist

| Criterion | Evidence | Status |
|---|---|---|
| Migration + parity verifiers green | Gates 1-6, 8-10 above, all exit 0 | Met |
| Fresh-image rehearsal: zero-users 0023 no-op + conditional bootstrap producing exactly one admin | `rehearse-scoped-access-migration.test.js` tests 6 and 7 (gate 15), both pass | Met |
| In-place rehearsal: 0023 uuid backfill + lowest-id promotion | Same test file, test 6 (gate 15), passes | Met |
| Restart-reversion | `rehearse-scoped-trigger-boot-survival.test.js` (gate 16), 2/2 pass | Met |
| No unexpected regression on the shipped boot node's own DDL-replay behavior | `verify-boot-ddl-interpolation.js` (gate 19) | Met — green both profiles after fix commit `101d1f2f` |

All five criteria are met at head `9e7da38a`. Phase A is accepted.

## Deviations log

Adjudicated deviations carried in `progress.md` for this plan (`agrolink-scoped-access-phase-a`
section), reproduced here for the record:

- **No-op uuid `UPDATE` emits a duplicate `USER_UPSERTED`.** Flagged Task 1-5 review as a Minor;
  awareness item for Phase E (the emit gate is off in Phase A, so no current effect).
- **`sync_version` hardcoded `0` on the three USER outbox triggers — RESOLVED.** Flagged Task 1-5
  review as "plan-mandated"; the run of `verify-boot-ddl-interpolation.js` at this final gate
  showed it was a real regression against the shipped `SyncEventTxExecutor`'s watermark check,
  not an acceptable design choice. Fixed by `101d1f2f`: `users` gained its own `sync_version`
  column, the three triggers read `NEW.sync_version`. See "Blocker and resolution" above.
- **Duplicate commit titles** across `f6b60a1f`/`33b94e02` (both titled `feat(schema): scoped
  access migrations 0022-0023 with migration-owned triggers`). Cosmetic, no functional effect.
- **`profile-parity`/`sync-flow` red by design** between Task 7 (`651d1a24`) and Task 8
  (`0f8ab88b`): Task 7 lands the seam module on `bcm2712` only; Task 8 mirrors it to `bcm2709`
  in the same slice. Both gates are green at current head (Gates 6-7 above).
- **`osi-scope-helper` split-cache risk.** Task 7 review carried an Important note forward:
  every consumer must load the scope helper through the single `osiLib` tree, never a bare
  `require`, so the module-local cache stays a single instance. Task 8 pinned this as a comment
  at `NAME_TO_PATH` in both profile mirrors. Gate 11 (`flows-bare-require-scan.js`) confirms no
  bare-require regression at head.
- **`/api/me` Minors carried forward** (Task 9 review): auth tail collapses a secret-misconfiguration
  500 into a 401; scoped-ON admin response body shape has no direct test (relevant to Phase B's
  GUI); node IDs are lowercase-hex slugs rather than the brief's literal hex pattern; a token
  pair-check present in the precedent node was dropped. None block Phase A; carried to Phase B/D.
- **Scoped bootstrap Minors carried forward** (Task 10 review): the winner-`SELECT` step
  conflates same-username concurrent bootstrap attempts into a plain 400 rather than the 403
  bootstrap-closed message (upstream behavior, plan-mandated shape); the `close()` catch path is
  effectively unreachable; the rehearsal's SQL literal duplicates the flow node's string instead
  of importing it; a pre-existing `flow.get('register_password')` read upstream of this node is
  noted for later cleanup, out of Task 10's scope.
- **Features-flag allowance bookkeeping** (Task 11 review): the `history-api-router-fn` allowance
  reason lists prior contributions already baked into `origin/main`, making the stated delta
  stale bookkeeping rather than a live discrepancy. Cosmetic.

## Open items for Phase B

1. Wire `verify-boot-ddl-interpolation.js` and `verify-trigger-body-parity.js` into whichever
   gate list future scoped-access slices reuse — they were absent from the Task 1-5 review's run
   list and from this plan's own Task 12 brief, and both are relevant whenever a migration adds
   or edits a `seed-blank.sql` trigger. Their absence let the `sync_version` literal-0 regression
   reach this final gate before being caught.
2. Duplicate `USER_UPSERTED` on no-op uuid `UPDATE` (see deviations log) — resolve before Phase E
   enables producers, since it will double-emit once the emit gate flips.
3. `osi-scope-helper` split-cache discipline (single `osiLib.require('scope')` load path) has no
   automated enforcement beyond the `flows-bare-require-scan.js` bare-`require` check; a future
   slice introducing scope checks in new flow nodes should re-verify this by hand until a
   dedicated guard exists.
4. `/api/me` and scoped-bootstrap Minors above (auth-tail 500-to-401 collapse, scoped-ON admin
   body shape untested, winner-`SELECT` 400-vs-403 conflation) are candidates for Phase B/C
   pickup once read- and write-path enforcement land and exercise these paths under load.
5. Spec is now v7 after `9e7da38a` corrected the Phase C plan's write-path SQL to state the
   writer-bumped `sync_version` contract explicitly — any Phase B/C work referencing the older
   write-path SQL text should diff against the current plan file before reuse.
