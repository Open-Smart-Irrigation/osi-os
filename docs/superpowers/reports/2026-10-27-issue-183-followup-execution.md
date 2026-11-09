# Issue 183 follow-up execution

## Binding and history

The effective base is fresh `origin/main` `d4d7d66168e01b064efd3060de587f751edec1d5`, tree `358407a73b7eab3cf643b8b73fa19aac7e412f07`. The final fetch during this run confirmed that SHA had not moved. The accepted plan remains historical commit `537337d927cb652331bd3ccd97a70ecd601cf7c2`, blob `cdb0feb12cb58a33d1c0b44fee73cb55c3ef9cd2`; the rebased copy has the same blob.

The six prior candidate commits were replayed only with the reviewed `git rebase --onto d4d7d661... 8ec3ec3... t3/issue-183-followup-reconciliation` sequence. Their new SHAs, in order, are `54871275776aa05fd34ee633cff6a9de431fc700`, `a71a45b722cc76fb68840cd1d6bef8feb02b3687`, `8b74f62e74eb0d4055ba184e654b1992b1d6da7d`, `6473df31e7a89342d2e0e051cf01d778c4555c7d`, `6f67ec522052c8be5cf5f48144088481fe97de26`, and `8cf7f33e3ea07084d687de9053fd06e041eb1c0e`. The reviewed helper-oracle repair is a separate test-only commit, `34201e93381369f1fe793f53d5ed75e3100ef0f6`. This report is added as the evidence commit after the candidate gates.

The rebase had no conflicts. Fresh main's `deploy.sh`, `scripts/deploy-fetch-list.js`, migration loader/manifest, migration tests and fixtures remain unchanged in the candidate diff. The implementation diff before this report commit changed nine paths: `.github/workflows/verify-sync-flow.yml`; three `chirpstack-bootstrap.js` copies; two mirrored helper `index.test.js` files; the accepted plan; `scripts/test-chirpstack-bootstrap-clover.js`; and `scripts/test-chirpstack-env-file.js`. No deploy, helper product source, schema, flows, ledger, controller, or coordination file changed.

## Execution evidence

All builds, tests, checkers, fetches and Git mutations ran serially through `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py` from `/home/phil/.t3/worktrees/osi-os/t3-598166f9`. The wrapper commands returned their direct statuses; full output and sibling status files are in `/home/phil/projects/osi-release-campaign-2026-10-25/reports/issue-183-followup-implement-r3-evidence/`.

| Tree | Command | Status and result |
|---|---|---|
| Fresh base `d4d7d661` | Five-file focused Clover/deploy suite | 0; 111 passed, none failed/skipped/TODO/cancelled (`base-focused.tap.log`) |
| Fresh base `d4d7d661` | Deploy corpus, migration wiring and reconcile-probe tests | 0; 25 passed, none failed/skipped/TODO/cancelled (`base-deploy-corpus.tap.log`); `/usr/bin/sqlite3` was present before dispatch |
| Fresh base `d4d7d661` | Profile parity, communication contract, test inventory | Each 0; inventory reports 842 files, 687 workflow steps, 4 listed runners, 151 excluded with reasons (`base-*.log`) |
| Candidate `34201e93` | Mirrored helper metadata suites | 0; 90 passed, none failed/skipped/TODO/cancelled (`helper-metadata.tap.log`), including hidden string, symbol-keyed Buffer, non-invoked accessor and leaking-stack controls |
| Candidate `34201e93` | Five-file focused Clover/deploy suite | 0; 129 passed, none failed/skipped/TODO/cancelled (`candidate-focused.tap.log`) |
| Candidate `34201e93` | Deploy corpus, migration wiring and reconcile-probe tests | 0; 25 passed, none failed/skipped/TODO/cancelled (`candidate-deploy-corpus.tap.log`) |
| Candidate `34201e93` | Profile parity, communication contract, test inventory, sync-flow verifier | Each 0; parity ends `All parity checks passed.`; inventory reports 842 files and 688 workflow steps (`candidate-*.log`) |
| Candidate `34201e93` | JS syntax checks for bootstrap, Clover harness, root harness and both helper tests; `sh -n deploy.sh` | Each 0 (`syntax-*.log`) |
| Candidate `34201e93` | Direct byte comparisons for bootstrap copies and helper source/tests | 0; all four comparisons identical (`byte-parity.log`) |
| Candidate `34201e93` | `env OSI_DDL_BASE_REF=d4d7d66168e01b064efd3060de587f751edec1d5 node scripts/verify-no-stray-ddl.js` | 0; total 694 matches base (`candidate-no-stray-ddl.log`) |
| Candidate `34201e93` | `node scripts/verify-doc-hygiene.js` | 0; 398 files scanned with built-in patterns only, no private allowlist supplied (`candidate-doc-hygiene.log`) |
| Candidate `34201e93` | `git diff --check d4d7d66168e01b064efd3060de587f751edec1d5..HEAD` | 0 (`candidate-diff-check.log`) |

The exact current-head bindings, commit sequence, clean status, diff stat and changed-path list are in `final-binding.log`. The final fetch returned status 0 and confirmed the same `d4d7d661…` base (`final-fetch-main.log`). The helper amendment was attributed to Sol's bounded review in `issue-183-helper-red-review-r1.md`; the historical plan text and blob were not changed.

## Limits and handoff

The direct-root T7 child, new-head Linux G1/B3 root CI, native OpenWrt, physical interruption and fleet behavior remain unrun. No privilege was installed and no virtual-owner result is claimed. The prior root run and PR #527 checks bind only to historical trees. Fresh root CI and independent full-candidate review must bind to the final candidate SHA; no self-approval, PR creation, push, merge, deploy, live gateway or production action occurred.
