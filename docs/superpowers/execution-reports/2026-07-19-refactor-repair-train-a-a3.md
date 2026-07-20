# Refactor repair Train A local finalization

Date: 2026-07-19

Scope: local implementation and integration through Task A3. Task A3.5 and Tasks A4-A6 are excluded. No push, PR, deployment, SSH, gateway access, server access, or production-cloud access is permitted.

## Run state

- Base fetched and verified: `origin/main` at `f50950b1767a1aa6302ef2553d68a4e379b5b142`.
- Integration branch: `integration/refactor-repair-train-a-a3-20260719`.
- Integration worktree: `/home/phil/Repos/osi-os/.worktrees/refactor-repair-train-a-a3`.
- Program mode for source-slice workers: `OSI_REPAIR_PROGRAM_MODE=1`.
- Handoff inputs remain read-only in the main checkout because the prompt, plans, briefs, and reports are untracked or ignored there.

## Baseline gates

| Command | Exit | Pass signal |
|---|---:|---|
| `node scripts/verify-sync-flow.js` | 0 | `All parity checks passed.` |
| `node scripts/verify-profile-parity.js` | 0 | `All parity checks passed.` |
| `node scripts/verify-flows-size-ratchet.js` | 0 | `committed baseline not exceeded` |

## A2 environment preflight

- `web/react-gui/npm ci`: exit 0, 269 packages installed. npm reported 12 dependency-audit findings and blocked two unapproved install scripts; these are recorded separately from repository gate results.
- The host has no `apt-get`, no passwordless sudo, and no `busybox` on `PATH`. The existing executable `/usr/lib/initcpio/busybox` is BusyBox 1.36.1 and its `ash` passed a direct readiness probe. `/tmp/osi-train-a-tools/busybox` points to it for the local A2 shell gate; no system package or repository file was changed.

## Preflight adjudications

- The umbrella plan governs the prompt's ordering ambiguity. Pure protocol, audit, and dormant witnessed primitives may be prepared on isolated stacks before A0. Shared flow activation and integration wait until the complete A0 commit-4 boundary is integrated.
- Scratch branches are proposal vehicles. Their commits will be reconstructed into the plan-mandated green commit shapes; intentionally red or partial scratch commits will not enter integration history.
- The approval ledger from the main checkout will be reproduced deliberately in this worktree before the final documentation checkpoint. No main-checkout mutation is allowed.
- The pinned cumulative comparison base is `f50950b1767a1aa6302ef2553d68a4e379b5b142`. A2 and A3 use `git diff --check "$BASE_SHA...HEAD"`; a later movement of `origin/main` cannot change the review basis.
- Sync Tasks 3-4 own four ordered commits. Task 5 is a fifth, separate post-activation commit named `fix: fail sync readiness on missing triggers`.
- The A2 union includes the umbrella block plus `node --test scripts/factory-database-seed-cli.test.js` and `node scripts/generate-factory-image-provenance.js --refresh-bound-hashes --preserve-image-build-id --check` from the source plans.
- Before A2, install the React dependency tree with `npm ci` and provide a verified BusyBox `ash`. Missing tools are environment failures, not repository defects.
- A3 covers umbrella Tasks A0-A2, all five edge-side source plans, PR #146 lifecycle preservation, the hotspot ledger, and Train B non-foreclosure.
- Local documentation is part of Train A: sync Task 6 Steps 1-3, writer Task 5, ChirpStack Task 5 Steps 1-3, cross-repo Task 1 Step 5, A0 build/live-ops documentation, the plans, and this prompt. Live steps remain excluded.
- The main checkout's uncommitted `osi-config-and-flags` and `osi-live-ops-runbook` edits are user-owned. They are read-only conflict input: compatible hunks may be reconstructed deliberately, but no wholesale copy or main-checkout mutation is allowed.

## Reconstruction map

| Final boundary | Proposal input | Reconstruction rule |
|---|---|---|
| A0 commit 1: deployment state and guard primitives | `sdd/deployment-state-core`, `sdd/deployment-state-guard`, `sdd/a0-detect-backup-helpers`, `sdd/dbhelper-primitives`, protocol-state skeleton | Consolidate the approved primitives and guards into one non-deployable commit. Exclude callers, flow activation, ratchet changes, and documentation. |
| A0 commit 2: factory provenance and baseline bootstrap | A0 image-provenance work plus the relevant protocol/factory initialization primitives | One non-deployable provenance/bootstrap commit with regenerated trust anchors and direct tests. |
| A0 commit 3: absolute flow-size ceilings | `sdd/a0-ratchet-absolute` | Fold its four proposal commits into exactly one reviewed commit. Replace scratch/delta reasons with exact absolute ceilings and exact node coverage. |
| A0 commit 4: runtime compatibility set | Remaining A0 machinery | First deployable A0 SHA. Integrate the compatibility CLI, artifact build/verify, staged npm wrapper, backup/restore, inhibitor, integrity/migration reports, deploy lock discipline, image guards, and staging/baseline verbs as one compatibility set. |
| Sync commits 1-3: dormant trust state | `sdd/protocol-state-witnessed` plus the protocol-verbs, audit/reconcile, and command-ledger proposal stacks | Reconstruct the three green dormant checkpoints. No flow/deploy callers. Preserve all four regenerated trust anchors whenever a bound byte changes. |
| Sync commit 4: activation | `sdd/sync-stoploss-harness` plus Tasks 3-4 final flow/wiring | Do not import the deliberately red scratch commit. Land tests and caller wiring together; this is the first deployable sync SHA. Apply empty-results batch semantics and durable beyond-window command dedupe. |
| Sync Task 5 | Post-activation boot-node gate | Separate commit after activation. Touch only trigger-readiness owners and their exact ratchet ceiling. |
| Writer | `sdd/writer-primitives` plus writer Tasks 3-5 | Land async primitives only with awaited live callers, fallback safety path, UCI/procd export, correlated ingest gate, and local documentation. |
| ChirpStack | `sdd/chirpstack-helper` plus Task 4 | Helper and both flow-owner rewires land together, including the intent-persisted external-effect boundary and every client close path. |
| Device API | `sdd/device-api-auth` plus Task 3 | Auth status repair and pipeline 401 enforcement remain a reviewed vertical slice. |
| Edge contract | Cross-repo Task 1 only | Generate after sync and ChirpStack graphs are final. No server-repo work. |
| Documentation and CI | Owner-union gates, source-plan documentation, plan records, then `AGENTS.md` | Preserve every named gate. Commit `AGENTS.md` alone at the final checkpoint. |

## Hotspot ledger

Pending extraction before the first shared-file integration.

Extraction completed against `f50950b1`. The pending line records the earlier run state; this table is the controlling ledger for integration.

| Hotspot | Owner order | Required preservation evidence |
|---|---|---|
| PR #146 identity lifecycle | Every slice | Keep the four guarded roles, six rc links, seven restart-sentinel readers, Node-RED-before-identityd recovery order, identityd-last activation, and the complete identity direct-gate bundle. |
| Both maintained `flows.json` files | A0, sync activation, sync readiness, writer, ChirpStack, Device API, edge contract | Edit bcm2712 first and mirror once. Run the full flow-owner union after each resolution. Preserve the seven sentinel readers byte-for-byte. |
| `verify-sync-flow.js`, `test-flows-wiring.js`, and workflow guards | Same order as the flow | Accumulate every sync, writer, ChirpStack, Device API, identity, migration, communication, profile, and flow-size assertion. A green exit that drops a named command is a failure. |
| Flow-size allowances | A0 commit 3, then each flow owner | Exact node-ID coverage and exact absolute ceilings; retain identity-owned reasons; remeasure only nodes changed by the current slice. |
| `deploy.sh` and deploy tests | A0, sync protocol extension, ChirpStack activation | Hold one deployment lock across an attempt, preserve the PR #146 stop/restore order, and run the real script under `/bin/sh` and BusyBox `ash`. |
| Artifact, backup, and restore surfaces | A0, then sync dependency extension | Preserve exact-commit input closure, delete-one controls, provenance, stopped-writer evidence, and the three purpose-specific database protocols. |
| `node-red.init`, `osi-bootstrap`, communication guard | A0, writer, ChirpStack | Startup authorization precedes behavior; preserve identity coordination; later work extends the same authority rather than adding a parallel path. |
| Pipeline config, bundles, checks, and tests | A0, writer, Device API | Keep correlation and bounded 401/500 enforcement together with the existing deployment/status checks. |
| Sync contract schemas and documentation | Sync, edge contract, final documentation checkpoint | Edge remains canonical; no ACK/status fallback broadening. Server-side plan tasks remain out of scope. |
| `AGENTS.md` | Orchestrator-only final checkpoint | Collect A0, sync, writer, ChirpStack, and edge-contract fragments; stage and commit `AGENTS.md` alone. |

The umbrella table understated A0's first ownership of `node-red.init`, pipeline files, `osi-bootstrap`, and `verify-communication-contract.js`; the controlling order above corrects those rows. Pipeline provider/evidence/rehearsal modules remain Train B-only and have no Train A mutation owner. Train B may extend the state, receipt, artifact, and lifecycle authorities, but Train A must not create a second authority that Train B would have to reconcile.

## Slice evidence

### A0 commit 3 proposal reconstruction

- Branch/head: `sdd/finalize-a0-commit3-20260719` at `4a2a12c48dde5b4353d7e93844cfc768cb848d8d`.
- Commit: `fix: migrate the flow-size ratchet to absolute ceilings`.
- TDD evidence: the final test suite failed against the old ratchet and profile-parity implementations; mutation controls then failed at 28/30 when per-node comparison was disabled and 29/30 when zero-length coverage was broken.
- Orchestrator rerun: ratchet 30/30; scanner 8/8; identity ownership 6/6; profile parity 12/12; direct ratchet, live-identity, profile-parity, and sync-flow verifiers all exited 0.
- Measured boundary: both profiles have 240 measured and 240 configured node IDs, no missing/extra/mismatched IDs, and exact total `1069245`.
- Diff boundary: eight allocated files only; no flow, runtime, deploy, workflow, pipeline, or `AGENTS.md` change. Independent spec/quality review is pending.
- Independent review 1: spec `FAIL`, quality `NEEDS FIXES`; no Critical findings. Three Important bypasses were reproduced: same-target valid-versus-broken symlink parity, lossy/unsafe JSON numeric ceilings, and a duplicate-key scan confused by braces inside a reason string. Corrective TDD and an amended single commit are in progress; the original head is not approved for integration.
- Corrected head: `d970b64ced95ca9f701b04436ceb48b921158853`, still exactly one commit with the required subject/eight-file boundary. The expanded orchestrator rerun is green: ratchet 36/36, scanner 8/8, identity ownership 6/6, profile parity 12/12, and all direct verifiers. Independent re-review is pending.
- Final approved head: `27241bff167b76ea2382062a452150d97e2f98c6`. Three corrective review loops closed unsafe/lossy number tokens, string-confused duplicate detection, broken/intermediate/final symlink escapes, missing chains, cycles, and special targets. Final independent verdicts: spec `PASS`, quality `APPROVED`, no Critical or Important findings. Ratchet 36/36, profile parity 19/19, identity ownership 6/6, scanner 8/8, and all direct gates are green. This proposal remains unintegrated until A0 commits 1 and 2 precede it.

### A0 commit 1 proposal reconstruction

- Branch/head: `sdd/finalize-a0-commit1-20260719` at `b74587b0eb344c377d29d30dda2b1038cef29aed`.
- Commit: `feat: add deployment state and guard primitives`; exactly one commit above the design-record base and no caller/runtime/workflow/`AGENTS.md` edits.
- Orchestrator rerun: deployment-state/guard 282/282; launcher 3/3; compatibility set 3/3; detector 18/18; ChirpStack backup 23/23; staged npm, inhibitor, and profile parity pass; factory seed, command-audit skeleton, and protocol skeleton 2/2 each; resident/caller guard 3/3.
- Disclosed scope tensions under review: legacy backup/restore helpers and direct tests were omitted; the audit/protocol surfaces are dormant skeletons; commit-1 residents are checked by a direct guard but do not enter the general profile-parity inventory until commit 3. The worker's interpretation is not accepted until independent spec and quality verdicts complete.
- Independent review 1: spec `FAIL`, quality `NEEDS FIXES`. Four Critical and seven Important findings were reproduced despite green direct tests. Critical: incomplete/fail-open startup authority, launcher-orphan behavior, factory-seed no-replace race, and factory-zero eligibility without trust inputs. Important: incomplete file allocation, wrong lineage union, incomplete compatibility protocol, incomplete lineage verification, unproved npm jail isolation, ChirpStack destination/source gaps, and non-durable inhibitor unlink. A full corrective TDD loop is in progress; `b74587b0` is not approved for integration.
- Corrective head `8df630b13bfee4d181054a14071b6c4c72a5f3f8` closed the first review's launcher, no-replace, lineage, missing-evidence, fsync, and allocation failures; the orchestrator direct union passed. Independent review 2 still returned spec `FAIL` / quality `NEEDS FIXES`: three Critical findings (mount authority, stable stopped-writer factory audit, broken inhibitor init) and seven Important findings (exact backup/restore protocols, compatibility bindings, real ujail boundary, ChirpStack crash resume/adapter fencing, launcher child binding, seed crash resume, resident allocation). A second corrective loop is active; `8df630b1` is not approved.
- Corrective head `81494bf8fcbe777f4d59a5d7d47fb6643a534f1b` passed the complete orchestrator union and classified syntax/diff checks. Independent review 3 still returned spec `FAIL` / quality `NEEDS FIXES`. Confirmed blockers include self-issued recovery topology authority, incomplete inhibitor quarantine after a durability error, torn immutable-file publication, an unusable live-root compatibility path, operation-ID path escape, legacy database backup/restore authority, staged-npm path and symlink gaps, non-resumable backup publication prefixes, incomplete persistent-overlay authority, production-visible test overrides, and incomplete factory-zero root/link/process proof. A third corrective TDD loop is active; `81494bf8` is not approved.
- Corrective head `0c4a62460f0320c736414d3236b4288c7886d242` passed the complete orchestrator union, 290 deployment-state tests, resident parity, and classified syntax/diff checks. Independent review 4 still returned spec `FAIL` / quality `NEEDS FIXES`. Production-path checks exposed an invalid `/var/lock` validator, an `arm` crash dead-end, an incompatible pinned-`ujail` argv, topology receipts without post-restore proof, inconsistent overlay authority, unreleasable recovered locks, unsafe auxiliary authority paths/modes, an invented database-restore contract, nobody-writable staging evidence, stale stopped-role proof, and fragmented final-path JSON publication. A fourth corrective TDD loop is active; `0c4a6246` is not approved.
- Corrective head `6c4f4945e9f5536af427ac77ece9333515d5b6f0` passed the full orchestrator union, the hermetic environment-unset run, classified syntax, scope, and diff checks. Independent review 5 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Critical gaps remain in claim-bound arming, mandatory recovery health and mutation-free audit evidence, current-topology startup authorization, active-recovery startup exclusion, compatibility restoration after safety installation, stable mount identity, and concurrent immutable publication. Important gaps cover the pinned `ujail` contract, complete live-control binding, race-free attempt-lock reuse, fail-closed staged ownership, the missing production role-state adapter, canonical factory-database binding, ChirpStack post-backup validation, snapshot copy binding, and strict boot identity. A fifth corrective TDD loop is active; `6c4f4945` is not approved.
- Corrective head `5eef790b0bfa39cd268a86e1e3112d98959068ea` passed the complete post-amend orchestrator union and hermetic audit. Independent review 6 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Critical findings cover the arm-versus-abandon atomic boundary, no-follow root ownership, mutation-lock exclusion, predecessor authority, fresh terminal topology proof, and reboot-stable mount identity. Important crash and TOCTOU gaps remain in compatibility capture/resume, staged npm resume, factory database ancestry, ChirpStack source/destination resume checks, and monotonic role-generation evidence. A sixth corrective TDD loop is active; `5eef790b` is not approved. The next review uses a separate immutable worktree so corrective edits cannot contaminate review state.
- Corrective head `15bc6cc0f8d84515770f0b2b2b4f602277a8f71f` passed the complete orchestrator union, including 313 deployment-state tests, 393 combined Node tests, shell gates, parity, and hermetic checks. Independent immutable-worktree review 7 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Critical findings cover full-root bind shadows, factory mount and publication ancestry, guarded-launcher CLI/runtime binding, pre-validation staged-root mutation, pinned-`ujail` identity resolution, early recovery-health permits, and exact-existing publication durability. Important gaps cover complete topology stabilization, jailed-process liveness, mutation-ticket PID reuse, second-pass link auditing, factory directory durability, malformed device-tree properties, and ambient backup-helper shadowing. A seventh corrective TDD loop is split across three isolated workers; `15bc6cc0` is not approved.
- Corrective head `55e59a8c474f6aec81241549e6a69ab99c5b83fc` passed the complete orchestrator union, explicit POSIX and BusyBox gates, and the hermetic audit. Independent immutable-worktree review 8 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Critical findings cover the factory link-before-authority crash window, terminal S01 safety revalidation, and privileged ambient-tool resolution. Important gaps cover attempt-lock release and PID reuse, stable shared topology collection, compatibility inventory completeness, staged authority-root ownership, overlay full-root aliases, persistent permit and claim confinement, strict device-tree entries, and the old pipeline wrapper interface that commit 4 must update. An eighth corrective TDD loop is split across three isolated workers; `55e59a8c` is not approved.
- Corrective head `4b5b25a77b579a5268c4bc6f34453d2d4daa6c55` passed every plan-listed direct command separately, POSIX and BusyBox gates, repository verifiers, and the hermetic audit. Independent immutable-worktree review 9 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Critical findings cover factory pre-link-intent retry, stale guard claim and abandonment evidence, and terminal startup's dependency on a released volatile lock. Important gaps cover complete guard role-generation facts, staged-npm supervisor journal recovery, and preservation of prefix-bound ChirpStack partials. A ninth corrective TDD loop is split across three isolated workers; `4b5b25a7` is not approved.
- Corrective head `ce242acf33f011c20f65d00ffd46544343150927` passed the full separate-command union, POSIX and BusyBox suites, repository verifiers, and the hermetic audit. Independent immutable-worktree review 10 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Critical findings cover unverified inhibitor CLI execution, safety residents incorrectly restored as predecessor topology, recovery lock-owner handoff, and the permit-consumed-before-launch crash window. Important gaps cover pre-mutation role restoration, six-link prior-role evidence, pre-terminal durable release intent, factory temporary-alias cleanup, and the fixed ChirpStack watchdog. A tenth corrective TDD loop is split across primary state and isolated I/O workers; `ce242acf` is not approved.
- Corrective head `cdb663e2dff59ff348bf94eba4d00ca1c124e165` passed the affected state and I/O unions, remaining repository commands, parity, and the corrected audit/current-role contract. Independent immutable-worktree review 11 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Critical findings cover quarantine-versus-predecessor terminal authority, mutation evidence lost across epochs or before the phase append, and child execution before durable supervisor authority. Important gaps cover independent readiness, terminal-to-new-recovery release state, and lifecycle publication debris. An eleventh corrective TDD loop is split across state, role, and launcher workers; `cdb663e2` is not approved.
- Frozen head `cce1945ae27d03b4644e1f3f31c8f357256452d1` passed the affected state and I/O unions, remaining repository commands, parity, and the corrected audit/current-role contract. Independent review 12 still returned spec `FAIL` / quality `CHANGES REQUIRED`. Spec-critical gaps cover cross-epoch mutation-snapshot rebinding, stale role/link evidence at a new epoch boundary, an untracked token-bearing launcher spawner after supervisor death, and pre-link role-state publication debris. Quality-critical review additionally found that repeat recovery trusts caller-supplied receipt hashes stored in mutable state without verifying the immutable deployment/acceptance and recovery/topology receipt files. Important gaps remain in independent readiness and terminal-to-new recovery lifecycle handling. A twelfth corrective TDD loop is required; `cce1945a` is not approved.

### Protocol-verbs proposal

- Branch/head: `sdd/finalize-protocol-verbs-20260719` at `72ba27271e7e000aae3e2ee61a66dc52fde62b40`, one commit above witnessed-protocol head `be7bfe77`.
- Orchestrator rerun: both maintained protocol suites 157/157; CLI 24/24; profile parity, helper registration/tests, sync-flow, and diff checks exited 0.
- Worker-disclosed residuals: all-root-absence integrity authority, non-disposition crash-prefix completion, positive spawned CLI coverage for seven verbs, and final A0 envelope/artifact/provenance coupling. The slice is not approved or integrated; independent spec/quality review remains mandatory.
- Independent review 1: spec `FAIL`, quality `NEEDS FIXES`; no Critical findings because the slice is dormant. Seven Important gaps: incomplete authority gate, parsed-but-unused evidence, missing non-disposition crash resume, same-operation replay without unchanged-authority comparison, under-typed permanent receipts, absent all-root integrity initialization, and incomplete CLI/fault coverage. Deployment-only verbs were also exposed through the public helper index. A corrective TDD loop is in progress; `72ba2727` is not approved.
- Corrective checkpoint: `b279c9504503aa89b488236f2ffa264ab6c2a73c`, still one clean commit over `be7bfe77`. Both maintained suites 164/164 and CLI 25/25 are green. Committed-replay byte comparison and runtime-index exposure are closed; crash recovery, receipt validation, and CLI coverage are partial. Exact A0 authority/evidence codecs and the all-root integrity branch remain sequential dependencies, so this proposal is parked unapproved until A0 is complete and it can be rebased and finished.

### A0 commit 1 Review 13

- Review candidate: `1826941e` on `sdd/review-a0-commit1-r13-20260719`, assembled from frozen `cce1945a` plus the role, state, and launcher corrections. The candidate is a temporary three-commit review stack, not an integration result.
- Orchestrator bounded checks: current-role 15/15; guarded launcher 12/12; selected state/recovery checks 31/32 because the existing positive repeat-recovery fixture still lacked immutable receipt files; resident/syntax/diff checks were run separately. The full CLI suite was not accepted as a gate because the harness stalled after approximately 35 tests in bounded reviewer runs.
- Independent quality review: `CHANGES REQUIRED`. Critical findings: an identity-less token-bearing spawner can survive supervisor death before `launch-spawner.json` publication and evade immediate retry cleanup; a discovered `spawner` process phase is rejected by the abort-receipt schema; Important finding: terminal receipt verification does not cross-bind `operationId` to the parent deployment ID.
- Independent specification review found an additional Critical authority mismatch: after a cross-epoch abandon, `authorize-topology-activation` reselects the latest epoch snapshot instead of consuming the first-unresolved snapshot/facts recorded by abandon. The review is still being finalized; the candidate remains unapproved and unintegrated.
- Review 13 final specification verdict: `FAIL`. The cross-epoch abandon-to-authorize deadlock and the guarded-launcher pre-identity/post-spawn watchdog window are both Critical. The quality verdict remains `CHANGES REQUIRED`; no source was integrated.

### A0 commit 1 Review 14

- Frozen candidate: `9d4c17b5` after the r13 state and launcher corrections plus refreshed state residents.
- Orchestrator/reviewer evidence: current-role 15/15, launcher 13/13, resident parity 6/6, G1-G3 97/97, G4 52/53, and the full CLI 377/378. The only failure was the pre-existing no-quarantined-topology test contract, which expected its diagnostic before the new mutation-authority guard.
- Independent specification and quality verdicts: `FAIL` / `CHANGES REQUIRED`, solely for that red test contract. No new authority, receipt, launcher, TOCTOU, role, parity, or simplification findings were raised.
- Correction `9a3faa45` reorders only the fail-closed diagnostic path and passes the previously failing test plus G4 16/16. A fresh Review 15 is required; no source is integrated.

### A0 commit 1 Review 15

- Frozen candidate: `c9a48a44` after the r14 diagnostic correction and refreshed state residents.
- Independent specification verdict: `PASS`. Independent quality verdict: `APPROVED`, with no Critical or Important findings.
- Verification: deployment-state CLI 378/378; current-role 15/15; guarded launcher 13/13; resident parity 6/6; G1-G4 focused union 110/110; launch/process authority and crash-resume selection 19/19; profile parity, source/resident byte comparison, JS syntax, shell syntax, and diff checks passed. One quality reviewer intentionally skipped another broad memory-heavy run after prior 378/378 evidence; the spec reviewer completed 378/378 serially.
- Closed authorities: cross-epoch restoration and abandon facts, immutable receipt operation IDs, pre-identity/pre-watchdog launcher crashes and immediate spawner retry, typed spawner abort, role temp recovery, and both maintained profile mirrors. The candidate is approved for reconstruction into the required single A0 commit-1 source shape; it is not yet integrated.

### A0 commit 1 reconstruction and final gate transcript

- Approved source commit: `50f2c7ed6bcb810418616bf6bc13d798a83aca6b`, parent `6611163071680468a1fcb94cd9716068d6a286b2`, subject `feat: add deployment state and guard primitives`. It is exactly one commit above the design-record base, with no flow, deploy, workflow, pipeline, documentation, or `AGENTS.md` changes.
- Commit boundary: 62 files, including the original A0 commit-1 allocation plus the reviewed role/state/launcher corrections and both maintained profile mirrors. The source candidate worktree is clean.
- Final gates on the amended source commit:
  - `node --test --test-concurrency=1 scripts/deployment-state-cli.test.js` — exit 0, 378/378.
  - `node --test --test-concurrency=1 scripts/current-role-state.test.js` — exit 0, 15/15.
  - `node --test --test-concurrency=1 scripts/node-red-guarded-launch.test.js` — exit 0, 13/13.
  - `node --test --test-concurrency=1 scripts/a0-commit1-resident-copies.test.js` — exit 0, 6/6.
  - `node scripts/verify-profile-parity.js` — exit 0, all parity checks passed.
  - `node --check scripts/deployment-state-cli.js`, `node --check scripts/lib/deployment-state.js`, `sh -n scripts/node-red-guarded-launch.js`, and `git diff --check` — exit 0.
  - Supplemental union — exit 0: deploy compatibility 19/19; ChirpStack backup 37/37; profile detector all pass; backup/restore deferred-purpose checks pass; staged-npm wrapper pass; deployment inhibitor pass; factory seed 22/22; factory-zero audit 6/6; protocol skeleton 2/2; role-start 2/2.
- Independent Review 15 specification `PASS` and quality `APPROVED`; no Critical or Important findings remain. A0 commit 1 is approved for integration.

## A0 commit 2 approval

Source candidate `3e741e746ad130c2b2134f15d8e4dbbfe6d01f49` (`fix: align factory bootstrap contracts`) passed independent specification and quality review after corrective loops for path/argv binding, image identity, mode enforcement, deterministic baseline IDs, one-use verification-result handling, generator refresh semantics, and resident authority no-follow checks. It is intentionally non-deployable until the later image-baseline state-verb checkpoint.

Final serial gates: provenance CLI 7/7; generator 4/4; built-rootfs verifier 6/6; source verifier 4/4; factory-baseline envelope 3/3; factory seed 22/22; factory-zero audit 6/6; resident-copy guard 6/6; bootstrap shell PASS; `verify-sync-flow.js`, generator check, source verifier, profile parity, and `git diff --check` exit 0; deployment-state CLI 378/378. The exact-SHA reviews are specification `PASS` and quality `APPROVED`, with no Critical or Important findings. Anchor-mutating tests are recorded as serial-only because default parallel execution can race on tracked JSON fixtures.

## Safe local handoff after constrained finalization

Integration branch: `integration/refactor-repair-train-a-a3-20260719`, final head `ef8937a6` (safe functional handoff state `c8c8f0b4` plus this documentation checkpoint). Main checkout remained untouched; no live host, SSH, push, PR, or deployment was used.

Retained and rechecked: A0 commits 1–3; sync delivery stop-loss Tasks 1–2 (`16/16` delivery cases, including the present-but-empty `results[]` batch error); Device API auth Tasks 1–2 (`75/75`); absolute flow ceilings (`verify-flows-size-ratchet`); profile parity; `verify-sync-flow`; and `git diff --check`.

Removed before handoff because their required companion wiring was not complete: the protocol-verb candidate, async writer primitive activation, and ChirpStack helper contract change. Their review evidence and corrective findings remain in the handoff branches/reports and must be reimplemented, reviewed, and integrated as complete slices.

Remaining blockers: protocol verbs need ROM-resident CLI copies and runtime path resolution, exact phase/operation/evidence binding, four-root separation, immutable factory/activity anchors, absent-root integrity recovery, replay/quarantine state guards, and lock-spanned factory ordering; protocol audit/reconcile/baseline CLIs and command-activity witnessed integration remain; LSN50 writer Task 3 still needs awaited consumers, fallback/quarantine nodes, UCI flag, init export, close-error handling, and correlation gates; ChirpStack Task 4 flow rewiring remains; A0 deployment integration and workflow/CI union remain; final A2 transcript and independent A3 review remain. A3.5/A4 live prerequisites are intentionally untouched.

Safe-handoff gates: `node scripts/verify-profile-parity.js` exit 0; `node scripts/verify-sync-flow.js` exit 0; `node scripts/verify-flows-size-ratchet.js` exit 0; `git diff --check` exit 0. This is not a deployable release.
