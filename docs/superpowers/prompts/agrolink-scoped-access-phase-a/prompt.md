# Codex Task: AgroLink scoped access, Phase A (edge foundation)

## Orchestrator instructions

You are the orchestrator. You plan, dispatch, verify, and loop. Spawn a cheap execution worker per slice and an independent reviewer (spec compliance + code quality, two verdicts) after each. Never accept a worker's claim unverified: rerun the slice's gates yourself, then dispatch the reviewer with the diff. On findings, write a corrective worker prompt, re-dispatch, re-review until approved. TDD is mandatory: red captured first, test + fix committed together, no deliberately red commit on the working branch. Append one ledger line per slice to `.superpowers/sdd/progress.md`.

**Hard boundaries.** Stop at the end of the Phase A plan's Task 12 and report back. No deployment, no SSH to any gateway or server, no `osicloud.ch` under any circumstances, no push and no PR; the user authorizes those separately. Work only in a fresh worktree you create; do not touch the main checkout at `/home/phil/Repos/osi-os`. Never edit merged migrations `0001`–`0021` (checksum enforcement will reject the run). Never set `scoped_access_emit.enabled=1` anywhere; Phase E owns that flip, and any test or node that sets it is a defect. `flows.json` changes go only through one-shot guarded mutation scripts with the roundtrip byte-identity proof run before and after, bcm2712 first, mirror once; never hand edits, never string patching. Load the repo skills before the matching work: `osi-schema-change-control` for Tasks 1–5, `osi-flows-json-editing` for Tasks 9–11, `osi-common-pitfalls` and `osi-verification-commands` always, `anti-slop-writing` before any prose (run its `slop-check.js` on every doc you touch).

## Plans of record

Read these fully before dispatching anything; a worker gets the relevant task text, never a paraphrase:

- `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-a.md` — the 12 tasks, with complete code and per-task gates. This is the plan of record.
- `docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md` (v5), the design authority; §5 (data model + trigger constraint), §8 (enforcement + identifier bridge), §10 (bootstrap), bind implementation.
- `docs/adr/2026-07-19-scoped-multiuser-access-model.md` — the decision record.
- `docs/engineering-playbook.md` — definition of done.

## State at handover (verify before starting)

Branch: `docs/skill-audit-harness-parity`. The full spec/plan package is committed (`3c424d28` tip at writing; confirm with `git log --oneline -8`). No Phase A code exists yet: no migration 0022/0023, no `osi-scope-helper`, no `/api/me`. Verify the baseline is green before the first slice:

```bash
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && \
node scripts/verify-runtime-schema-parity.js && node scripts/verify-profile-parity.js
```

If any baseline gate is red, stop and report; do not build on a red baseline.

## Binding design decisions (four external review rounds — not optional, not to be redesigned)

1. **USER aggregate has exactly three trigger arms** (plan Task 2): `AFTER UPDATE OF user_uuid`, guarded `AFTER INSERT WHEN NEW.user_uuid IS NOT NULL`, `AFTER UPDATE OF role, disabled_at`. A bare INSERT arm emits a null uuid: sibling-trigger UPDATEs are invisible to other AFTER INSERT triggers (reproduced against SQLite; rehearsal test must cover it).
2. **All 7 new triggers are migration-owned**: registered in `scripts/verify-runtime-schema-parity.js` `MIGRATION_OWNED_TRIGGERS`, present in seed and bundled DBs, never referenced by the frozen `sync-init-fn` boot node. The boot-survival test (Task 6) pins the drop-list at 30.
3. **Emission is gated** by the single-row `scoped_access_emit` table, default 0, baked into every trigger's WHEN clause. Phase A installs schema only.
4. **Bootstrap is one conditional write** (`INSERT … SELECT 'admin' … WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`), counting admins in any state; the follow-up SELECT only shapes the 403 message. Registration closes after the first admin in scoped mode.
5. **Scope = owned ∪ granted**, resolved via the `users.user_uuid → users.id` bridge (zone/device ownership is the integer id; grants and journal are the text uuid). Null `user_uuid` is a hard error, never an empty scope. Migration 0023 backfills legacy null uuids.
6. **Thin-node rule**: flow logic lives in the seam module loaded via `osiLib.require('scope')`; new flow nodes stay within `verify-flows-size-ratchet.js`, and every intentional growth gets an allowance entry with a real reason and measured delta. Do not buy green with unexplained allowances.
7. The `osi-scope-helper` is db-handle-injectable (osi-journal pattern), cached 30 s for reads with explicit `invalidateScope`, and exports exactly the interface in plan Task 7 Step 3.

## Slice order (plan Tasks → worker slices)

1. **Migration core** (Tasks 1–3): rehearsal test red → 0022 → 0023 → green. The rehearsal drives everything; the three-arm USER trigger and emit gate must be proven here, not later.
2. **Parity surfaces** (Tasks 4–5): CHECKSUMS.json, seed-blank.sql, 7 bundled DBs + mirror, `MIGRATION_OWNED_TRIGGERS`, consistency contract, full migration gate set.
3. **Boot survival** (Task 6): static guard test against shipped `sync-init-fn` text.
4. **Scope helper** (Tasks 7–8): TDD the module, then all registration surfaces (osi-lib map, package.json, node_modules symlinks, deploy.sh fetch lines, bcm2709 mirror, `verify-helper-registration.js`).
5. **Endpoint trio** (Tasks 9–11): `/api/me`, scoped bootstrap in `auth-db-insert`, `scoped_access` in `/api/system/features` — guarded mutation scripts, allowances with measured deltas, full flow pre-commit checklist per task.
6. **Final gate** (Task 12): full verifier sweep + Phase A acceptance against spec §15.

## Integration and gates

Each slice commits with the plan's message shape (`feat(schema):`, `feat(scope):`, `feat(api):`, `test:` prefixes). The final gate is the plan's Task 12 command list run in full — every command with real output and exit codes in the execution report. The independent reviewer compares the integrated diff against the spec v5 for silently broadened behavior (especially: anything that edits an existing trigger body, anything that sets the emit gate, any flow node that bypasses `osiLib.require`, any allowance without a measured delta).

Report back with: branch name and head SHA, the Task 12 gate transcript, reviewer verdicts per slice, the deviations log (node ids, auth-stash variants, allowance deltas), and the open items list for Phase B. Branches stay local; nothing is pushed, merged, deployed, or accessed live.
