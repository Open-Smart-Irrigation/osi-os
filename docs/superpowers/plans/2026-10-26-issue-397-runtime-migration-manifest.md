# Issue 397: require a validated migration corpus at every runtime boundary

Status: amended after round-1 REQUEST CHANGES, awaiting a fresh independent plan review. Implementation is blocked on that review and the baseline condition recorded below. The plan author must not approve this plan or verify its eventual implementation.

## Base, evidence and scope

Implement against `63c7a70f8f3b373f162b33b0669b0df89b3763fa` (75 ordered migrations). The design checkout is `/home/phil/.t3/worktrees/osi-os/t3-682aae95`, branch `t3/issue-397-manifest-validation`. It started clean at `c37207b30b002fb79da8ae57253d78c04613b6a5`, advanced by `git merge --ff-only`, and fetched `origin/main` matches the requested base. No current-main drift was present at planning time. Re-fetch and report drift before execution; do not silently change the reviewed base.

Read the campaign `COORDINATION.md`, `PLAN.md`, repository `AGENTS.md`, engineering playbook, schema/common-pitfalls/verification/prose skills, fresh issue body and both comments, finder report, coordinator evidence, and the full Astra trust consultation. Campaign evidence is under `/home/phil/projects/osi-release-campaign-2026-10-25/reports/`:

- `issue-397-plan-issue-snapshot.json`: fresh read-only GitHub snapshot; issue OPEN, updated `2026-10-25T23:41:19Z`.
- `issue-397-plan-base-refresh.json`: exact fetch, fast-forward and drift results.
- `issue-397-plan-base-probe.cjs`, `issue-397-plan-base-check-0.log`: fresh synthetic real-runner reproduction, adapted from the preserved finder probe only to bind imports to this checkout.
- `issue-397-plan-base-checks.json`, `issue-397-plan-base-check-1.log`, `issue-397-plan-base-check-2.log`: original commands, exits and outputs. Amendment evidence is in `reports/issue-397-plan-amend-r1/`; its JSON files record exact argv/cwd/exits.
- `issue-397-plan-inventory-0.txt`, `issue-397-plan-inventory-1.txt`: repository caller searches.
- `issue-397-finder.md`, `issue-397-coordinator-evidence.md`, `issue-397-trust-consult.md`: attributed prior evidence and consultation.

The fresh probe exited 0 after asserting the existing defects: a manifest-listed missing middle file permits `[1,3]`, mismatching bytes permit `[1]`, and extra SQL permits `[1,2]`; `verifyHead` returns `{ok:true}` in each case. Restoring/removing the offending files after application makes head verification fail, proving that present disk entries currently define completeness. A complete matching sparse `[1,3]` is valid. The three refusal regressions below must fail on this base for those reasons. Their executable code is now included in the prospective patch below and was run in scratch; the product checkout remains unchanged.

Existing targeted tests passed 36/36 with no skips: `node --test lib/osi-migrate/__tests__/migrations-loader.test.js scripts/deploy-fetch-list.test.js scripts/test-deploy-migration-wiring.js`. `node scripts/verify-migrations.js` exited 0 with `verify-migrations: OK (75 migrations, checksum manifest OK, base immutability OK)`. These are baseline evidence, not proof of the planned behavior.

No SQL migration, migration number, existing manifest update, seed rewrite, boot-DDL edit, sync-contract change or cloud companion is required. Do not change applied migration bytes. Use synthetic databases only. No hardware qualification is established here.

## Explicit manifest trust decision

Adopt Astra's recommended boundary: the authorized operator selects and protects a stable checkout or provisioned payload; the existing authenticated SSH delivery or trusted installation process carries its authority to the gateway. Mandatory runtime validation proves that the manifest and the entire SQL corpus agree. Record this decision in maintained documentation, not only this plan or a handoff.

For tunnel deployment, the operator must select the intended checkout/revision, establish host-key and user authentication, own a free loopback serving/forwarding port, and confirm successful forwarding with `ExitOnForwardFailure=yes`. A response on `localhost` alone does not establish who owns the listener. Keep the source stable until delivery completes. Direct CLI and repair invocations have the same operator-selected, protected-source obligation. A directory argument supplies no independent provenance.

For offline deployment, approve the source before packaging; transfer the bundle, sidecar and executable tooling through the authorized SSH process. The SHA-256 sidecar detects damage relative to the operator's expected bundle. It does not authenticate an arbitrary bundle when both came from an untrusted sender. Bundle names and `BUNDLE_SHA` are labels, not proofs that the working bytes match a commit.

A coherently changed manifest and SQL corpus will pass these consistency checks if the operator supplies it. Test that limit explicitly. This work does not establish publisher authorization independent of the deploy operator, intended-release selection, freshness/rollback protection, semantic safety of SQL, secure boot, or resistance to a compromised workstation/gateway or hostile local replacement of executable code. No signing infrastructure or co-delivered self-authentication claim belongs in this change. If the maintainer requires independent publisher authorization, stop closure and obtain a revised design; this plan does not meet that stronger policy.

Hostile local writers, predictable deploy staging, archive reopen races and listener-identity enforcement remain outside this patch's security claim. Retained validated buffers address ordinary read consistency; they do not secure a replaceable runner. Never recommend fingerprint restamping or regenerating `CHECKSUMS.json` to repair a corrupt corpus.

## Required behavior

1. Every load requires a nonempty flat JSON object in a regular, nonsymlink `CHECKSUMS.json`. Keys must match the complete basename grammar `^[0-9]{4}__[a-z0-9_]+\.sql$`; values must be strings of exactly 64 lowercase hex characters. Reject malformed JSON, trailing input, nonobjects, arrays, null, nested values, duplicate decoded keys (including escaped equivalents), duplicate numeric versions, unsafe names, invalid UTF-8 manifest text and unsupported file types. Retain existing version semantics, including 0000 if otherwise valid; do not add a first-version or contiguity restriction.
2. Directory entries whose names end with the case-sensitive `.sql` suffix must equal manifest keys exactly. Reject missing, additional and malformed SQL names. Ignore unrelated non-SQL entries, as the existing directory contract does; `.SQL` is not executable input. Manifest-listed and actual SQL files must be regular nonsymlink files; refuse FIFO/device/socket/directory inputs before reading. The corpus root must be a real directory, not a symlink.
3. Hash raw SQL bytes once, derive SQL/risk from that same buffer, and retain those bytes privately for selections/references. Preserve BOM/CRLF/non-UTF-8 SQL hashing and existing risk-header grammar. The intentional additive compatibility rewrite still consumes the validated decoded source.
4. Validate the whole corpus before touching the target DB, ledger/fingerprint setup or restamp, backup creation/pruning, or migration writes. A corrupt last file must prevent every earlier migration. Invalid corpus input throws `ERR_MIGRATION_CORPUS` from loader/apply/bootstrap/head; head CLI exits 2 and never prints success. Valid corpus with an incomplete ledger still returns `{ok:false}` from head. A valid changed corpus conflicting with an applied ledger row retains `repair_required` behavior.
5. One operation uses one branded immutable snapshot for risk selection, SQL execution, reference construction and final self-check. Independent invocations load afresh. Callers may carry only a snapshot created by mandatory validation; arbitrary arrays/objects and directory-mismatched snapshots fail. No production optional-manifest flag, environment bypass or trusted-boolean shortcut is permitted. The snapshot option is an in-process operation context, never a CLI flag or environment setting. Top-level CLI/repair entry points load unconditionally; only nested work receives their context.
6. Detect ordinary changes during a load using descriptor/path metadata and a final exact-set check. After acceptance, execute retained content even if the source directory is replaced. A new invocation must validate the new directory. Document that filesystem metadata checks do not create an atomic directory snapshot against hostile writers.
7. Derived prefixes and renamed/composed synthetic lineage corpora require exact manifests. Copy only bytes retained by accepted parent snapshots, and preserve their accepted checksums under the selected output names. Never compute a new expected manifest by scanning arbitrary actual production files.

## Caller inventory and file claims

The coordinator must record these claims before admitting implementation. Do not edit campaign ledger state from this design task. Manifest and allowance files remain unclaimed for mutation; no new migration slot is reserved.

| File or surface | Required treatment |
| --- | --- |
| `lib/osi-migrate/migrations-loader.js` | Replace enumeration with mandatory corpus validation; preserve `loadMigrations(dir)` compatibility. Own snapshot and selection APIs. |
| `lib/osi-migrate/migration-manifest.js` (new) | Pure duplicate-aware flat parser, safe-name/hash validation, no Git/DB/module-load effects. |
| `lib/osi-migrate/runner.js`, `index.js` | Validate before any runner call; carry branded corpus through apply/bootstrap/head and boot-trigger grace. Index exports remain compatible; snapshot helper is imported from loader. |
| `scripts/migrate-cli.js` | One snapshot before all mutations, including prune-only. Risk selection and apply share it. |
| `scripts/restamp-fingerprints.test.js`, `scripts/verify-migrations.test.js` | Five explicit synthetic restamp buffers gain manifests; two verifier assertions intentionally adopt exact directional corpus-set diagnostics. Production restamp is unchanged. |
| `scripts/verify-head-cli.js` | Keep exit 2 for corpus exceptions; correct its inaccurate unconditional read-only comment because existing valid-corpus grace can restamp. |
| `scripts/baseline-existing-db.js` | Validate direct reference calls; cache by corpus identity; exact selected manifests and retained bytes; stamp checksums from same corpus. |
| `scripts/reconcile-ledger-numbering.js` | Validate main/lineage snapshots before `readLedgerRows`/ensureLedger; carry main snapshot through proofs, references, clear and self-check. |
| `scripts/ops/uganda-schema-audit.js`, `scripts/ops/generate-uganda-schema-rebuild-20260911.js` | Replace manifest-free `buildReference1` copies with validated selection; bind audit's selected migrationsDir through its reference construction. |
| `scripts/fixtures/earlier-lineage-gateway-db.js` | Compose selected main/lineage/raw foreign-tail bytes and expected manifest through the selection API. |
| `scripts/soak/scenario-kill9-migration.js` | Synthetic constructor writes an explicit manifest from its declared SQL buffers before forking `kill9-child.js`. Child needs no bypass or code change. |
| `deploy.sh` | Fetch parser/loader before interpreting names; use shared strict manifest-only parse and full validation, retain early guards, remove raw JSON key iteration. |
| `scripts/deploy-fetch-list.js`, `scripts/deploy-bundle.sh` | Validate source main/lineage corpora before path expansion; validate copied stage against accepted source identities before tar creation. |
| `.github/workflows/migrations.yml` | Register any new test files explicitly with the existing fail-on-missing runner. No CI rerun spam. |
| `docs/operations/migration-manifest-trust.md` (new), `docs/operations/deploying-over-a-flaky-link.md`, `.claude/skills/osi-schema-change-control/SKILL.md` | Maintain the trust decision, operator prerequisites, mandatory-manifest/reference contract and links. No AGENTS expansion needed. |

The following fixture surfaces were audited. The exact prospective file list below defines writes; named files without a patch are verification-only. Update constructors and intentional mutations, not broad directory auto-repair:

- `lib/osi-migrate/__tests__/migrations-loader.test.js`, `runner-additive.test.js`, `runner-atomicity.test.js`, `runner-data-risk.test.js`, `runner-destructive.test.js`, `runner-drift-preflight.test.js`, `runner-fingerprint-scheme-upgrade.test.js`, `runner-partial-batch-retry.test.js`, `verify-head-gap.test.js`, `add-column-compat.test.js`, `runner-boot-trigger-grace.test.js`, `fingerprints-sql-comments.test.js`.
- `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`: selected real prefix and later added migration must each have the corresponding selected manifest.
- `scripts/baseline-existing-db.test.js`, `scripts/migrate-cli.test.js`, `scripts/verify-head-cli.test.js`, `scripts/reconcile-ledger-numbering.test.js`, `scripts/restamp-fingerprints.test.js`, `scripts/verify-migrations.test.js`.
- `scripts/ops/uganda-schema-audit.test.js`, `scripts/ops/generate-uganda-schema-rebuild-20260911.test.js`, `scripts/rehearse-devices-type-migration.test.js`.
- `scripts/soak/scenario-kill9-migration.test.js`, `scripts/deploy-fetch-list.test.js`, `scripts/deploy-command-ledger-dependency.test.js`, `scripts/test-deploy-migration-wiring.js`, `scripts/deploy-bundle.test.sh`.

New tests: `lib/osi-migrate/__tests__/migration-manifest.test.js`, `runner-corpus.test.js`; new test helpers: `lib/osi-migrate/__tests__/helpers/migration-fixture.js` and `lib/osi-migrate/__tests__/helpers/manifest-vectors.js` (not production bypasses). Also add `scripts/migration-caller-corpus.test.js`, `scripts/ops/rebuild-corpus.test.js` and `scripts/deploy-corpus.test.js`. Register all five new test files with migrations CI and verify test inventory.

Audited consumers requiring strict loading but no expected production edit: `scripts/build-seed-db.js`, `verify-seed-replay.js`, `verify-seed-db-ledger.js`, `verify-sqlite-cli-limits.js`, `rehearse-ledger-cutover.js`; their full canonical corpus already has a manifest. `lib/osi-migrate/__tests__/helpers/boot-rehearsal.js`, `runner-boot-devices-rebuild-grace.test.js`, `fingerprints-boot-rewrite-rehearsal.test.js`, `seed-replay.test.js`, `scripts/rehearse-ledger-cutover.test.js`, `scripts/test-gateway-health-persistence.js`, `test-valve-settings-sync-triggers.js`, `test-valve-schedule-sync-triggers.js`, `test-valve-actuation-text-caps.js`, `test-valve-schedule-timestamp-wire-format.js` use that corpus or its reference builder. Rehearsal's earlier-lineage dependency is fixed at its constructor above. Keep their semantics and assertions.

Audit-only exclusions: `restamp-fingerprints.js` recomputes a confirmed live schema and does not load migrations; its five test constructors are claimed above, and production restamp gains no manifest dependency; it must not become corpus recovery. `generate-sync-trigger-source.js` uses snapshot/schema helpers, not loader execution. `test-journal-schema.js` executes explicit schema/SQL fixtures. `rehearse-watermark-cloud-parity-migration.test.js` directly replays selected canonical SQL using node:sqlite; it neither calls the loader nor supplies a runtime corpus. Journal catalog generation and CI `verify-migrations.js` are authoring/CI tools, not production manifest authority; do not import them into runtime or regenerate existing expected manifests. `generate-uganda-catchup-20260911.js` extracts named historical DDL and applies its explicit checked-in repair artifact, not an ordered migration corpus; preserve that separate sanctioned repair scope. `deploy-offline.sh`, `deploy-push-bundle.sh`, `deploy-local-server.js` handle transfer/extraction/serving and do not load SQL. Their trust assumptions must be documented; no broad deployment-hardening rewrite is authorized here. No flows/init/feeds caller currently invokes the ordered runner at boot.

## Round-1 response and execution contract

| Request | Exact amendment |
| --- | --- |
| R1 | The patch includes all five restamp constructors as `writeFixture(dir, {'0001__b.sql': Buffer.from(...)})`. The declared bytes are exactly `-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n`. All existing report hashes, nonzero refusal, default/--apply recovery assertions remain. Two verifier assertions now check the precise expected/actual name arrays in `migration corpus: file set mismatch`, retaining their nonzero status checks. Baseline's mismatch assertion becomes `migration corpus: checksum mismatch for 0001__x.sql`. Deploy wiring asserts validated `migration_names` and both early module fetches before manifest use. Restamp production is untouched. |
| R2 | `generate({corpus}={})` resolves the canonical corpus before extracting `baseline.sql`. Its same context reaches buildReference1. referenceCompare, preflightDriftSignature, dryRun, apply and verify resolve once at their top-level boundary and pass that context through every nested reference. The full patch contains all signatures/call sites and two source-replacement tests with stable/stale controls. The repair SQL artifact, FK toggles, transaction body, data guards and exit contract are unchanged. |
| R3 | The exact patch below is the complete executable edit, including caller implementations, fixture construction, imports, assertions, cleanup, staging CLI parsing, source identity comparison and shell/module packaging. It replaces the former narrative implementation steps. New caller tests define DB/backup fixtures and no-DB scaffolding; reference state uses immutable migration entries, corpus identity and runner-specific cache keys, with published-snapshot restoration on retry. ClearRepairRequired validates main only. |

The registry container has one compatibility distinction, proven by existing and new tests: a missing root or a child directory with neither `.sql` entries nor CHECKSUMS.json supplies no corpus and contributes nothing. An existing manifest, including an empty one, or any `.sql` entry requires strict validation. A symlink container is refused; other filesystem errors propagate. This preserves exact-main reconciliation without known foreign fixtures and never consumes manifest-free SQL. The new test contrasts missing/empty containers with the same directory after SQL appears. No loader, runtime flag or environment switch bypasses manifests.

The schema skill claim is limited to the paragraph immediately below “Ordered migrations: format and risk-class declaration” and its formerly optional-manifest sentence. The live-ops skill claim is limited to the paragraph below “Deploy runbook (reverse-tunnel flow)” and the single SSH command there, adding `-o ExitOnForwardFailure=yes`. Preserve #183's credential-file/permission and recovery guidance independently. Deploy ownership is limited to check_fetched_manifest/fetch_migration_runner/fetch_reconciliation_assets and their tests. Parent coordination must reconcile these narrow paragraphs/functions before implementation admission; this design task admits no implementation claim and does not edit the ledger.

### Stop conditions and baseline result

Read the full `issue-397-plan-review-r1.md`, its exact runner/generator bridge diffs, failing logs and probe code before review. The trust ruling accepts authorized protected source plus authenticated SSH/provisioning, with the limits above; no publisher-signing work was requested.

Twenty baseline commands were run on unchanged product source at the reviewed base, from this bound checkout, with `OSI_BASELINE_RUNNER=node-sqlite` recorded in every JSON command record. Nineteen exited 0, including the omitted 13 restamp/verifier tests, all schema/seed/DB/profile/boot/trigger gates, inventory, bundle and full `verify-sync-flow.js`. One command group exited 1: ops/rehearsal/soak reported 33/34 passing. The catchup test file's three assertions passed, but its imported verify function sets `process.exitCode=1` in the expected missing-object control (`generate-uganda-catchup-20260911.js`, verify's failure branch), so the file exits 1. This is red-on-base, not repaired here. Parent must disposition that surface separately before implementation. Do not hide it by resetting exitCode in this patch, dropping the test, or reporting the group green.

Expected new-test sensitivity is separate: the nine no-DB corpus regressions fail with the exact base runner; both generator regressions fail with the reviewer's builder-only bridge. They pass with the complete prospective edit. R1's five missing-manifest and two old-diagnostic failures remain preserved in the independent review's evidence. An unexpected refusal/result, missing file, red baseline or differing base SHA stops the affected execution step; amend and independently review rather than improvising.

### Execute only after fresh independent plan review

All commands, including extraction, syntax, edits, checks and Git actions, must run under `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py COMMAND ARGS`. Check binaries with guarded Python first. Respect locks/holds and process ownership; no registration deletion or bypass cleanup. No installs, privileges, live access, children, paid fallback, pushes, PRs or GitHub writes are authorized by this plan-only assignment.

1. Parent arranges fresh review of this amended commit and resolves the baseline stop above. Refresh issue/comments and main drift before implementation; keep the reviewed base explicit. No reviewer may approve their own implementation.
2. Use the extraction program below in a new scratch copy first. It checks exact base bytes for the claimed paths and checks every hunk before writing. Zero-context hunks keep diff context blank lines from becoming trailing Markdown whitespace. For red regression evidence, run runner-corpus.test.js with the exact base runner (nine before-DB cases must fail) and rebuild-corpus.test.js with the retained review generator bridge (both tests must fail for the source split). Restore the prospective files in finally blocks, as the retained sensitivity driver did. The immutable base and controls are never edited.
3. After approval, the executor applies the exact patch in its isolated implementation checkout and runs the complete gates below. Do not regenerate CHECKSUMS.json or seeds. Commit the coherent result as `fix: require validated migration corpora throughout runtime callers`, including tests and maintained trust documentation. Product changes are not committed by this design task.
4. The independent Sol verifier reruns the complete set at the final candidate SHA, checks explicit base-to-head diffs and ordered-byte preservation, and reports limits. Opus review remains later. Neither author scratch validation nor this plan commit approves implementation, deployment or hardware qualification.

Save this extraction code as a scratch script using guarded Python and invoke it with the plan path and an output patch path. Its cwd must be the selected scratch or approved implementation checkout. Every added/changed file is in the patch; no external bridge file is needed for application.

```python
from pathlib import Path
import re, subprocess, sys
text = Path(sys.argv[1]).read_text()
match = re.search(r"^```diff\n(.*?)^```$", text, re.M | re.S)
if not match:
    raise SystemExit("missing executable patch")
patch = match.group(1)
out = Path(sys.argv[2])
out.write_text(patch)
paths = re.findall(r"^diff --git a/(\S+) b/\S+$", patch, re.M)
if len(paths) != 52:
    raise SystemExit("unexpected patch inventory")
subprocess.run(["git", "diff", "--exit-code", "63c7a70f8f3b373f162b33b0669b0df89b3763fa", "--", *paths], check=True)
subprocess.run(["git", "apply", "--check", "--unidiff-zero", str(out)], check=True)
subprocess.run(["git", "apply", "--unidiff-zero", str(out)], check=True)
```

The patch is the sole code specification. The earlier parser-only assertions are historical evidence and do not establish caller integration. Synthetic expected manifests come from explicitly declared buffers or accepted parent selections, never scans that bless arbitrary actual production files. Deliberate changed-corpus ledger tests update their synthetic expectation; stale-manifest tests keep it unchanged.

### Runnable counterfactual sensitivity driver

After extracting/applying the patch in a scratch tree under the campaign reports directory, run this Python driver there through run-heavy.py. It restores every swapped file in finally and records actual child argv/cwd/exits. Both child exits must be 1 with exactly nine and two failing regressions; any other result stops execution. The review's retained generator bridge is a control, never a proposed implementation.

```python
from pathlib import Path
import hashlib, json, re, subprocess, sys
scratch = Path(sys.argv[1]).resolve()
reports = Path('/home/phil/projects/osi-release-campaign-2026-10-25/reports').resolve()
assert scratch.is_relative_to(reports) and (scratch / '.git').is_dir()
base = '63c7a70f8f3b373f162b33b0669b0df89b3763fa'
bridge = Path('/home/phil/projects/osi-release-campaign-2026-10-25/reports/issue-397-plan-review-r1-evidence-20261026-t3-9db05712/prospective/scripts/ops/generate-uganda-schema-rebuild-20260911.js')
assert hashlib.sha256(bridge.read_bytes()).hexdigest() == '4c6b520735e6f9f163fac1d98a859acd16218166079e7bde15360d21cb01cdd6'
records = []
controls = [
    ('lib/osi-migrate/runner.js', subprocess.check_output(['git', 'show', base + ':lib/osi-migrate/runner.js']),
     ['node', '--test', '--test-name-pattern', 'before DB calls', 'lib/osi-migrate/__tests__/runner-corpus.test.js'], 9),
    ('scripts/ops/generate-uganda-schema-rebuild-20260911.js', bridge.read_bytes(),
     ['node', '--test', 'scripts/ops/rebuild-corpus.test.js'], 2),
]
for index, (name, control, argv, failures) in enumerate(controls):
    file = scratch / name
    accepted = file.read_bytes()
    try:
        file.write_bytes(control)
        result = subprocess.run(argv, cwd=scratch, text=True, capture_output=True)
        output = scratch.parent / ('sensitivity-' + str(index) + '.log')
        output.write_text(result.stdout + result.stderr)
        records.append({'argv': argv, 'cwd': str(scratch), 'exit': result.returncode, 'output': str(output)})
        assert result.returncode == 1
        assert re.search(r'^# fail ' + str(failures) + r'$', result.stdout, re.M)
    finally:
        file.write_bytes(accepted)
(scratch.parent / 'sensitivity.json').write_text(json.dumps(records, indent=2) + '\n')
```

### Complete baseline and final gates

Before implementation, use the existing-file forms of these commands for baseline evidence; omit only five not-yet-created new test files and the new trust doc. Final verification includes all commands without filters. Library tests use the existing fail-on-missing runner. `OSI_BASELINE_RUNNER=node-sqlite` is the documented reference backend, not a manifest bypass; record it, and additionally run `node --test scripts/migration-caller-corpus.test.js scripts/deploy-corpus.test.js` without that override for the default-CLI controls. Do not install missing prerequisites.

```text
node scripts/run-module-tests.js lib/osi-migrate/__tests__/migration-manifest.test.js lib/osi-migrate/__tests__/runner-corpus.test.js lib/osi-migrate/__tests__/migrations-loader.test.js lib/osi-migrate/__tests__/add-column-compat.test.js lib/osi-migrate/__tests__/runner-additive.test.js lib/osi-migrate/__tests__/runner-atomicity.test.js lib/osi-migrate/__tests__/runner-data-risk.test.js lib/osi-migrate/__tests__/runner-destructive.test.js lib/osi-migrate/__tests__/runner-drift-preflight.test.js lib/osi-migrate/__tests__/runner-fingerprint-scheme-upgrade.test.js lib/osi-migrate/__tests__/runner-partial-batch-retry.test.js lib/osi-migrate/__tests__/verify-head-gap.test.js lib/osi-migrate/__tests__/fingerprints-sql-comments.test.js lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js lib/osi-migrate/__tests__/runner-boot-trigger-grace.test.js lib/osi-migrate/__tests__/runner-boot-devices-rebuild-grace.test.js lib/osi-migrate/__tests__/fingerprints-boot-rewrite-rehearsal.test.js
node --test scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js
node --test scripts/migrate-cli.test.js scripts/verify-head-cli.test.js scripts/baseline-existing-db.test.js scripts/reconcile-ledger-numbering.test.js
node --test scripts/migration-caller-corpus.test.js scripts/ops/rebuild-corpus.test.js scripts/deploy-corpus.test.js
node --test scripts/ops/uganda-schema-audit.test.js scripts/ops/generate-uganda-schema-rebuild-20260911.test.js scripts/ops/generate-uganda-catchup-20260911.test.js scripts/rehearse-devices-type-migration.test.js scripts/rehearse-ledger-cutover.test.js scripts/soak/scenario-kill9-migration.test.js
node --test scripts/deploy-fetch-list.test.js scripts/deploy-command-ledger-dependency.test.js scripts/test-deploy-migration-wiring.js scripts/test-deploy-reconcile-probe.js scripts/test-deploy-fresh-install.js scripts/deploy-local-server.test.js
bash scripts/deploy-bundle.test.sh
node scripts/verify-test-inventory.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-sqlite-cli-limits.js
node scripts/verify-sync-flow.js
node scripts/verify-doc-hygiene.js
node .claude/skills/anti-slop-writing/slop-check.js docs/operations/migration-manifest-trust.md docs/operations/deploying-over-a-flaky-link.md .claude/skills/osi-schema-change-control/SKILL.md .claude/skills/osi-live-ops-runbook/SKILL.md
git diff --check
```

Also run `node --check` for every changed/new JavaScript file and `bash -n` for deploy.sh and changed shell files, using the patch's exact file list below. Run `git diff --check 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD`, `git diff --name-status 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD`, and `git diff --exit-code 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD -- database/migrations/ordered database/seed-blank.sql conf feeds` against the reviewed runtime SHA. Product source changes must match the patch; no migration, manifest, seed, flow or payload edit is allowed. Test inventory must account for all five new tests. Prose must pass with no tier-1 findings; inspect tier-2 warnings. Privacy uses the maintained list if supplied, otherwise report built-in-only coverage and unchecked allowlist staleness.

Expected final results are exit 0 with the actual current pass summaries. Runtime refusal tests assert ERR_MIGRATION_CORPUS and unchanged schema/data/ledger/fingerprints/backup files; head CLI exits 2 for corpus errors, while a valid incomplete ledger remains ok:false/exit 1. Sparse [1,3], both reference-gap policies, applied checksum repair_required, risk/backup/FK behavior and the separate repair-artifact contract stay intact. A coherent operator-supplied alternate corpus is accepted, with no publisher-authentication claim. A coherent altered stage differs from the accepted source identity and is rejected.

### Exact prospective file claims

Every file below is a future edit claim awaiting parent admission. Existing caller dispositions earlier in this plan remain read-only unless included here.

- `.claude/skills/osi-live-ops-runbook/SKILL.md`
- `.claude/skills/osi-schema-change-control/SKILL.md`
- `.github/workflows/migrations.yml`
- `deploy.sh`
- `docs/operations/deploying-over-a-flaky-link.md`
- `docs/operations/migration-manifest-trust.md`
- `lib/osi-migrate/__tests__/add-column-compat.test.js`
- `lib/osi-migrate/__tests__/fingerprints-sql-comments.test.js`
- `lib/osi-migrate/__tests__/helpers/manifest-vectors.js`
- `lib/osi-migrate/__tests__/helpers/migration-fixture.js`
- `lib/osi-migrate/__tests__/migration-manifest.test.js`
- `lib/osi-migrate/__tests__/migrations-loader.test.js`
- `lib/osi-migrate/__tests__/runner-additive.test.js`
- `lib/osi-migrate/__tests__/runner-atomicity.test.js`
- `lib/osi-migrate/__tests__/runner-boot-trigger-grace.test.js`
- `lib/osi-migrate/__tests__/runner-corpus.test.js`
- `lib/osi-migrate/__tests__/runner-data-risk.test.js`
- `lib/osi-migrate/__tests__/runner-destructive.test.js`
- `lib/osi-migrate/__tests__/runner-drift-preflight.test.js`
- `lib/osi-migrate/__tests__/runner-fingerprint-scheme-upgrade.test.js`
- `lib/osi-migrate/__tests__/runner-partial-batch-retry.test.js`
- `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`
- `lib/osi-migrate/__tests__/verify-head-gap.test.js`
- `lib/osi-migrate/migration-manifest.js`
- `lib/osi-migrate/migrations-loader.js`
- `lib/osi-migrate/runner.js`
- `scripts/baseline-existing-db.js`
- `scripts/baseline-existing-db.test.js`
- `scripts/deploy-bundle.sh`
- `scripts/deploy-bundle.test.sh`
- `scripts/deploy-command-ledger-dependency.test.js`
- `scripts/deploy-corpus.test.js`
- `scripts/deploy-fetch-list.js`
- `scripts/fixtures/earlier-lineage-gateway-db.js`
- `scripts/migrate-cli.js`
- `scripts/migrate-cli.test.js`
- `scripts/migration-caller-corpus.test.js`
- `scripts/ops/generate-uganda-schema-rebuild-20260911.js`
- `scripts/ops/generate-uganda-schema-rebuild-20260911.test.js`
- `scripts/ops/rebuild-corpus.test.js`
- `scripts/ops/uganda-schema-audit.js`
- `scripts/ops/uganda-schema-audit.test.js`
- `scripts/reconcile-ledger-numbering.js`
- `scripts/reconcile-ledger-numbering.test.js`
- `scripts/rehearse-devices-type-migration.test.js`
- `scripts/restamp-fingerprints.test.js`
- `scripts/soak/scenario-kill9-migration.js`
- `scripts/soak/scenario-kill9-migration.test.js`
- `scripts/test-deploy-migration-wiring.js`
- `scripts/verify-head-cli.js`
- `scripts/verify-head-cli.test.js`
- `scripts/verify-migrations.test.js`

## Executable prospective patch

This patch was authored and exercised only under campaign reports in scratch. It is design material for fresh review, not a product implementation applied to this worktree.

```diff
diff --git a/.claude/skills/osi-live-ops-runbook/SKILL.md b/.claude/skills/osi-live-ops-runbook/SKILL.md
index 24c6483f..ce5ab10f 100644
--- a/.claude/skills/osi-live-ops-runbook/SKILL.md
+++ b/.claude/skills/osi-live-ops-runbook/SKILL.md
@@ -201,0 +202,2 @@ an unknown credential.
+The [migration source and SSH prerequisites](../../../docs/operations/migration-manifest-trust.md#required-deployment-prerequisites) are mandatory: select and protect a stable source, authenticate the host/user, own the loopback listener and forwarding port, and confirm forwarding succeeded.
+
@@ -231 +233 @@ dev workstation unless noted.
-   ssh -R 9876:localhost:9876 root@<pi-ip> \
+   ssh -o ExitOnForwardFailure=yes -R 9876:localhost:9876 root@<pi-ip> \
diff --git a/.claude/skills/osi-schema-change-control/SKILL.md b/.claude/skills/osi-schema-change-control/SKILL.md
index b5e1861d..6783c379 100644
--- a/.claude/skills/osi-schema-change-control/SKILL.md
+++ b/.claude/skills/osi-schema-change-control/SKILL.md
@@ -112,0 +113,2 @@ by the ADR but was never committed to the repo — do not go looking for it.)
+Every runtime corpus requires a strict CHECKSUMS.json, including selected references and synthetic fixtures. Preserve the accepted parent checksums when constructing a prefix. Operator authority and corruption recovery are defined in [migration manifest authority](../../../docs/operations/migration-manifest-trust.md); never regenerate expected hashes from suspect files.
+
@@ -121,3 +123 @@ Use the next contiguous four-digit version after the highest `NNNN` present; do
-not copy an example version from this skill. If `CHECKSUMS.json` is present in
-that directory, keep it in mind when interpreting `verify-migrations.js` output
-and do not edit already-recorded migration bytes casually.
+not copy an example version from this skill. `CHECKSUMS.json` is mandatory for runtime loading. Keep it consistent when authoring a new migration; never edit already-recorded migration bytes or regenerate expected hashes from suspect files.
diff --git a/.github/workflows/migrations.yml b/.github/workflows/migrations.yml
index 10a0f7c3..fd057d55 100644
--- a/.github/workflows/migrations.yml
+++ b/.github/workflows/migrations.yml
@@ -71,0 +72,2 @@ jobs:
+            lib/osi-migrate/__tests__/migration-manifest.test.js \
+            lib/osi-migrate/__tests__/runner-corpus.test.js \
@@ -101,0 +104 @@ jobs:
+      - run: node --test scripts/migration-caller-corpus.test.js scripts/ops/rebuild-corpus.test.js scripts/deploy-corpus.test.js
diff --git a/deploy.sh b/deploy.sh
index 51f3dc65..78a42444 100644
--- a/deploy.sh
+++ b/deploy.sh
@@ -1354,5 +1354 @@ check_fetched_manifest() {
-        const crypto = require("crypto");
-        const fs = require("fs");
-        const path = require("path");
-        const [mode, dir, label] = process.argv.slice(1);
-        let manifest;
+        const [modulePath, mode, dir, label] = process.argv.slice(1);
@@ -1360 +1356,6 @@ check_fetched_manifest() {
-            manifest = JSON.parse(fs.readFileSync(path.join(dir, "CHECKSUMS.json"), "utf8"));
+            const loader = require(modulePath);
+            if (mode === "manifest") {
+                for (const entry of loader.readMigrationManifest(dir)) console.log(entry.name);
+            } else if (mode === "files") {
+                loader.loadMigrationCorpus(dir);
+            } else { throw new Error("unknown manifest validation mode"); }
@@ -1362,7 +1363 @@ check_fetched_manifest() {
-            console.error("ERROR: " + label + "/CHECKSUMS.json is missing, empty or not valid JSON: " + error.message);
-            process.exit(1);
-        }
-        const names = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? Object.keys(manifest).sort() : [];
-        const malformed = names.filter((name) => name.includes("/") || !/^[0-9a-f]{64}$/.test(String(manifest[name])));
-        if (names.length === 0 || malformed.length > 0) {
-            console.error("ERROR: " + label + "/CHECKSUMS.json names no files or has malformed entries " + malformed.join(" "));
+            console.error("ERROR: " + label + ": " + error.message);
@@ -1371,24 +1366 @@ check_fetched_manifest() {
-        if (mode !== "files") process.exit(0);
-        let failed = false;
-        for (const name of names) {
-            let actual;
-            try {
-                actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
-            } catch (error) {
-                console.error("ERROR: " + label + "/" + name + " is named in CHECKSUMS.json but missing (" + (error.code || error.message) + ")");
-                failed = true;
-                continue;
-            }
-            if (actual !== manifest[name]) {
-                console.error("ERROR: " + label + "/" + name + " does not match its SHA-256 in CHECKSUMS.json (truncated or altered download)");
-                failed = true;
-            }
-        }
-        for (const name of fs.readdirSync(dir)) {
-            if (name.endsWith(".sql") && !Object.prototype.hasOwnProperty.call(manifest, name)) {
-                console.error("ERROR: " + label + "/" + name + " is not named in CHECKSUMS.json");
-                failed = true;
-            }
-        }
-        process.exit(failed ? 1 : 0);
-    ' "$1" "$2" "$3"
+    ' "$TMP_DIR/lib/osi-migrate/migrations-loader.js" "$1" "$2" "$3"
@@ -1435,0 +1408,8 @@ fetch_migration_runner() {
+    fetch_required "Migration manifest parser" \
+        "lib/osi-migrate/migration-manifest.js" \
+        "$TMP_DIR/lib/osi-migrate/migration-manifest.js" || return 1
+    fetch_required "Migration corpus loader" \
+        "lib/osi-migrate/migrations-loader.js" \
+        "$TMP_DIR/lib/osi-migrate/migrations-loader.js" || return 1
+    check_fetched_js_files "$TMP_DIR/lib/osi-migrate/migration-manifest.js" "$TMP_DIR/lib/osi-migrate/migrations-loader.js" || return 1
+
@@ -1439 +1419 @@ fetch_migration_runner() {
-    check_fetched_manifest manifest "$migrations_dir" database/migrations/ordered || return 1
+    migration_names="$(check_fetched_manifest manifest "$migrations_dir" database/migrations/ordered)" || return 1
@@ -1441 +1421 @@ fetch_migration_runner() {
-    for migration in $(node -e "const fs=require('fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); for (const name of Object.keys(manifest).sort()) console.log(name);" "$migrations_dir/CHECKSUMS.json"); do
+    for migration in $migration_names; do
@@ -1446,3 +1426 @@ fetch_migration_runner() {
-    # migrate-cli.js and verify-head-cli.js read this directory, not
-    # CHECKSUMS.json: a migration missing here would be skipped without an
-    # error, so the fetched set must be exactly the manifest's.
+    # Keep the early transfer guard; runtime independently validates the same corpus.
@@ -1474 +1451,0 @@ fetch_migration_runner() {
-        migrations-loader.js \
@@ -1503,2 +1480,2 @@ fetch_reconciliation_assets() {
-        check_fetched_manifest manifest "$lineage_fixtures_dir/$lineage" "scripts/fixtures/lineages/$lineage" || return 1
-        for fixture in $(node -e "const fs=require('fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); for (const name of Object.keys(manifest).sort()) console.log(name);" "$lineage_fixtures_dir/$lineage/CHECKSUMS.json"); do
+        fixture_names="$(check_fetched_manifest manifest "$lineage_fixtures_dir/$lineage" "scripts/fixtures/lineages/$lineage")" || return 1
+        for fixture in $fixture_names; do
diff --git a/docs/operations/deploying-over-a-flaky-link.md b/docs/operations/deploying-over-a-flaky-link.md
index b36bbe97..a4e7942c 100644
--- a/docs/operations/deploying-over-a-flaky-link.md
+++ b/docs/operations/deploying-over-a-flaky-link.md
@@ -2,0 +3,2 @@
+Follow the mandatory [migration source and SSH prerequisites](migration-manifest-trust.md#required-deployment-prerequisites) before either tunnel or offline delivery.
+
diff --git a/docs/operations/migration-manifest-trust.md b/docs/operations/migration-manifest-trust.md
new file mode 100644
index 00000000..21ac613c
--- /dev/null
+++ b/docs/operations/migration-manifest-trust.md
@@ -0,0 +1,17 @@
+# Migration manifest authority
+
+The authorized deploy operator selects and protects the source checkout or installed payload. Authenticated SSH delivery or trusted provisioning carries that authority to the gateway. Runtime validation requires an exact migration file set and SHA-256 agreement with CHECKSUMS.json before bookkeeping, backup pruning or SQL execution. Complete sparse version sets are valid.
+
+## Required deployment prerequisites
+
+Select the intended checkout/revision and keep it stable through packaging or transfer. Verify the SSH host key and authorized user. Own the loopback HTTP listener and a free forwarding port; use ExitOnForwardFailure=yes and confirm forwarding succeeded. A localhost response alone does not identify its listener. Protect local staging and executable tooling.
+
+For offline delivery, approve the source before packaging and transfer the bundle, sidecar and tooling through the authorized process. The sidecar detects damage relative to that expectation; a co-delivered digest does not independently authenticate its sender. Bundle names and BUNDLE_SHA are labels.
+
+Direct migration and repair callers have the same protected-source obligation. A directory argument is not provenance. Every corpus, including reference prefixes and synthetic fixtures, requires a manifest. One operation retains accepted bytes; a new top-level invocation validates again. During-load descriptor/path checks detect ordinary replacements but do not create an atomic directory snapshot against hostile writers.
+
+## Limits and recovery
+
+A coherently altered manifest and SQL corpus supplied by the authorized operator can pass. These checks do not prove independent publisher authorization, intended revision, freshness, rollback protection or SQL semantics, and do not secure compromised workstations, gateways or replaceable verifier code. Independent publisher authorization would require a separately reviewed trust design.
+
+On a corpus error, restore the complete approved payload before retrying. Never regenerate expected hashes from suspect actual files or restamp the database to cure a missing file or hash mismatch. Fingerprint restamping remains a distinct operator recovery for a confirmed live schema.
diff --git a/lib/osi-migrate/__tests__/add-column-compat.test.js b/lib/osi-migrate/__tests__/add-column-compat.test.js
index 042466ac..012144f0 100644
--- a/lib/osi-migrate/__tests__/add-column-compat.test.js
+++ b/lib/osi-migrate/__tests__/add-column-compat.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -21 +22 @@ function fixture(files) {
-  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
+  for (const [name, sql] of Object.entries(files)) fixtureWrite(path.join(dir, name), sql);
diff --git a/lib/osi-migrate/__tests__/fingerprints-sql-comments.test.js b/lib/osi-migrate/__tests__/fingerprints-sql-comments.test.js
index 4dac8818..29644e84 100644
--- a/lib/osi-migrate/__tests__/fingerprints-sql-comments.test.js
+++ b/lib/osi-migrate/__tests__/fingerprints-sql-comments.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
diff --git a/lib/osi-migrate/__tests__/helpers/manifest-vectors.js b/lib/osi-migrate/__tests__/helpers/manifest-vectors.js
new file mode 100644
index 00000000..7401c4de
--- /dev/null
+++ b/lib/osi-migrate/__tests__/helpers/manifest-vectors.js
@@ -0,0 +1,15 @@
+'use strict';
+const hash = 'a'.repeat(64), valid = JSON.stringify({ '0001__a.sql': hash });
+const vectors = [
+  ['valid', valid, true], ['sparse', JSON.stringify({ '0001__a.sql': hash, '0003__c.sql': hash }), true],
+  ['zero', JSON.stringify({ '0000__zero.sql': hash }), true], ['escaped', '{"0001__\\u0061.sql":"'+hash+'"}', true],
+  ...['', '{}', 'null', '[]', '42', valid+'x', valid.slice(0,-1)+',}', '\ufeff'+valid,
+    '{"0001__a.sql":"'+hash+'","0001__a.sql":"'+hash+'"}',
+    '{"0001__a.sql":"'+hash+'","0001__\\u0061.sql":"'+hash+'"}',
+    JSON.stringify({'0001__a.sql':hash,'0001__b.sql':hash}),
+    JSON.stringify({'0001__a.sql':[hash]}), JSON.stringify({'0001__a.sql':{}}),
+    '{"0001__\\q.sql":"'+hash+'"}', Buffer.from([255])].map((raw,i)=>['structure-'+i,raw,false]),
+  ...['../a.sql','/a.sql','0001__a b.sql','0001__a\n.sql','0001__a*.sql','0001__a%2f.sql','0001__A.sql','__proto__','0001__a.sql\n','0001__a\\b.sql'].map((name,i)=>['name-'+i,JSON.stringify({[name]:hash}),false]),
+  ...[hash.toUpperCase(),hash.slice(1),hash+'a',hash.slice(1)+'g',hash+'\n',1,true,null].map((v,i)=>['hash-'+i,JSON.stringify({'0001__a.sql':v}),false]),
+].map(([name,raw,valid])=>({name,raw:Buffer.isBuffer(raw)?raw:Buffer.from(raw),valid}));
+module.exports = { vectors };
diff --git a/lib/osi-migrate/__tests__/helpers/migration-fixture.js b/lib/osi-migrate/__tests__/helpers/migration-fixture.js
new file mode 100644
index 00000000..bee2379b
--- /dev/null
+++ b/lib/osi-migrate/__tests__/helpers/migration-fixture.js
@@ -0,0 +1,38 @@
+'use strict';
+const fs = require('node:fs');
+const path = require('node:path');
+const os = require('node:os');
+const crypto = require('node:crypto');
+function expectedEntry(dir, name, checksum) {
+  const file = path.join(dir, 'CHECKSUMS.json');
+  const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
+  manifest[name] = checksum;
+  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
+}
+// Test-only: expected values come from explicit declared buffers, never a disk scan.
+function fixtureWrite(file, body, ...options) {
+  fs.writeFileSync(file, body, ...options);
+  if (typeof file === 'string' && file.endsWith('.sql')) {
+    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, typeof options[0] === 'string' ? options[0] : 'utf8');
+    expectedEntry(path.dirname(file), path.basename(file), crypto.createHash('sha256').update(raw).digest('hex'));
+  }
+}
+function writeFixture(dir, files) {
+  for (const [name, bytes] of Object.entries(files)) fixtureWrite(path.join(dir, name), bytes);
+  return dir;
+}
+function fixtureCopy(source, dest, ...options) {
+  if (typeof source !== 'string' || typeof dest !== 'string' || !source.endsWith('.sql') || !dest.endsWith('.sql')) return fs.copyFileSync(source, dest, ...options);
+  const { loadMigrationCorpus, materializeMigrations } = require('../../migrations-loader');
+  const corpus = loadMigrationCorpus(path.dirname(source));
+  const entry = corpus.migrations.find((m) => m.name === path.basename(source));
+  if (!entry) throw new Error('fixture source absent');
+  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-fixture-select-'));
+  try {
+    const selected = path.join(root, 'selected');
+    materializeMigrations(selected, [{ corpus, name: entry.name, asName: path.basename(dest) }]);
+    fs.copyFileSync(path.join(selected, path.basename(dest)), dest, ...options);
+    expectedEntry(path.dirname(dest), path.basename(dest), entry.checksum);
+  } finally { fs.rmSync(root, { recursive: true, force: true }); }
+}
+module.exports = { writeFixture, fixtureWrite, fixtureCopy };
diff --git a/lib/osi-migrate/__tests__/migration-manifest.test.js b/lib/osi-migrate/__tests__/migration-manifest.test.js
new file mode 100644
index 00000000..e0f23250
--- /dev/null
+++ b/lib/osi-migrate/__tests__/migration-manifest.test.js
@@ -0,0 +1,8 @@
+'use strict';
+const test=require('node:test'), assert=require('node:assert/strict');
+const {parseManifest}=require('../migration-manifest');
+const {vectors}=require('./helpers/manifest-vectors');
+for(const v of vectors) test(v.name,()=>{
+  if(v.valid) assert.ok(parseManifest(v.raw).length);
+  else assert.throws(()=>parseManifest(v.raw),{code:'ERR_MIGRATION_CORPUS'});
+});
diff --git a/lib/osi-migrate/__tests__/migrations-loader.test.js b/lib/osi-migrate/__tests__/migrations-loader.test.js
index 86542df0..9780e3ae 100644
--- a/lib/osi-migrate/__tests__/migrations-loader.test.js
+++ b/lib/osi-migrate/__tests__/migrations-loader.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -12 +13 @@ function dirWith(files) {
-  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
+  for (const [name, body] of Object.entries(files)) fixtureWrite(path.join(d, name), body);
@@ -60,0 +62,21 @@ test('rejects risk directives that are not in the file header', () => {
+
+
+test('corpus refuses symlinks, directories and FIFO without reading them', () => {
+  const { execFileSync } = require('node:child_process');
+  const { loadMigrationCorpus } = require('../migrations-loader');
+  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi397-types-'));
+  try {
+    for (const kind of ['manifest-link', 'sql-link', 'directory', 'fifo', 'root-link']) {
+      const dir = path.join(root, kind); fs.mkdirSync(dir);
+      require('./helpers/migration-fixture').writeFixture(dir, { '0001__a.sql': '-- risk: additive\nCREATE TABLE a(id);\n' });
+      let target = dir;
+      if (kind === 'root-link') { target = dir + '-link'; fs.symlinkSync(dir, target); }
+      else {
+        const file = path.join(dir, kind === 'manifest-link' ? 'CHECKSUMS.json' : '0001__a.sql');
+        if (kind.endsWith('-link')) { fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file); }
+        else { fs.unlinkSync(file); if (kind === 'directory') fs.mkdirSync(file); else execFileSync('mkfifo', [file]); }
+      }
+      execFileSync(process.execPath, ['-e', `const assert=require('node:assert/strict');assert.throws(()=>require(${JSON.stringify(require.resolve('../migrations-loader'))}).loadMigrationCorpus(${JSON.stringify(target)}),{code:'ERR_MIGRATION_CORPUS'});`], { timeout: 3000 });
+    }
+  } finally { fs.rmSync(root, { recursive: true, force: true }); }
+});
diff --git a/lib/osi-migrate/__tests__/runner-additive.test.js b/lib/osi-migrate/__tests__/runner-additive.test.js
index 9393633a..6faa0768 100644
--- a/lib/osi-migrate/__tests__/runner-additive.test.js
+++ b/lib/osi-migrate/__tests__/runner-additive.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -12 +13 @@ function fixture(files) {
-  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
+  for (const [n, b] of Object.entries(files)) fixtureWrite(path.join(dir, n), b);
@@ -44 +45 @@ test('checksum mismatch on an applied version throws repair_required', async ()
-  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER, z INTEGER);\n');
+  fixtureWrite(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER, z INTEGER);\n');
diff --git a/lib/osi-migrate/__tests__/runner-atomicity.test.js b/lib/osi-migrate/__tests__/runner-atomicity.test.js
index 047c119d..c5a36b2a 100644
--- a/lib/osi-migrate/__tests__/runner-atomicity.test.js
+++ b/lib/osi-migrate/__tests__/runner-atomicity.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -11 +12 @@ function fixture(files) {
-  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
+  for (const [n, b] of Object.entries(files)) fixtureWrite(path.join(dir, n), b);
@@ -43 +44 @@ test('a pre-commit (rolled-back) failure records status=failed and is retryable'
-  fs.writeFileSync(path.join(dir, '0002__boom.sql'), '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n');
+  fixtureWrite(path.join(dir, '0002__boom.sql'), '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n');
diff --git a/lib/osi-migrate/__tests__/runner-boot-trigger-grace.test.js b/lib/osi-migrate/__tests__/runner-boot-trigger-grace.test.js
index 9e1f5b64..03fc1c1f 100644
--- a/lib/osi-migrate/__tests__/runner-boot-trigger-grace.test.js
+++ b/lib/osi-migrate/__tests__/runner-boot-trigger-grace.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -35 +36 @@ function fixture() {
-  fs.writeFileSync(path.join(dir, '0001__a.sql'),
+  fixtureWrite(path.join(dir, '0001__a.sql'),
@@ -118 +119 @@ test('(i) a byte-copy of the live kaba100 farming.db (pre-restamp, v2-stamped, b
-  fs.copyFileSync(fixturePath, work);
+  fixtureCopy(fixturePath, work);
diff --git a/lib/osi-migrate/__tests__/runner-corpus.test.js b/lib/osi-migrate/__tests__/runner-corpus.test.js
new file mode 100644
index 00000000..14a205e0
--- /dev/null
+++ b/lib/osi-migrate/__tests__/runner-corpus.test.js
@@ -0,0 +1,16 @@
+'use strict';
+const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
+const {applyPending,bootstrapFresh,verifyHead}=require('../index');
+const {cliRunner}=require('../runner-iface');
+const {loadMigrationCorpus,materializeMigrations,resolveCorpus}=require('../migrations-loader');
+const {writeFixture}=require('./helpers/migration-fixture');
+const sql=t=>`-- risk: additive\nCREATE TABLE ${t}(id INTEGER PRIMARY KEY);\n`;
+const files={'0001__a.sql':sql('a'),'0002__b.sql':sql('b'),'0003__c.sql':sql('c')};
+const corruptions={missing:d=>fs.unlinkSync(path.join(d,'0003__c.sql')),mismatch:d=>fs.appendFileSync(path.join(d,'0003__c.sql'),'-- changed\n'),extra:d=>fs.writeFileSync(path.join(d,'0004__d.sql'),sql('d'))};
+function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'osi397-test-'));const dir=path.join(root,'m');fs.mkdirSync(dir);writeFixture(dir,files);return{root,dir,db:path.join(root,'t.db')};}
+async function dump(r){const schema=await r.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");const tables={};for(const x of schema.filter(x=>x.type==='table'))tables[x.name]=await r.all(`SELECT * FROM "${x.name}" ORDER BY rowid`);return{schema,tables};}
+for(const[kind,corrupt]of Object.entries(corruptions))for(const fn of [applyPending,bootstrapFresh,verifyHead])test(`${fn.name} refuses ${kind} before DB calls`,async()=>{const{root,dir,db}=fixture();try{corrupt(dir);let calls=0;const r={dbPath:db,all:async()=>{calls++;assert.fail('DB touched')},exec:async()=>{calls++;assert.fail('DB touched')}};await assert.rejects(()=>fn(r,{migrationsDir:dir,appVersion:'test'}),{code:'ERR_MIGRATION_CORPUS'});assert.equal(calls,0);assert.equal(fs.existsSync(db),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
+for(const[kind,corrupt]of Object.entries(corruptions))for(const populated of [false,true])test(`real ${kind} preserves ${populated?'populated':'empty'} DB`,async()=>{const{root,dir,db}=fixture();try{const r=cliRunner(db);await r.exec('PRAGMA user_version=0;');if(populated){await applyPending(r,{migrationsDir:dir,appVersion:'test'});await r.exec('INSERT INTO a(id) VALUES(123);');}const before=await dump(r),bytes=fs.readFileSync(db);corrupt(dir);for(const fn of [applyPending,verifyHead])await assert.rejects(()=>fn(r,{migrationsDir:dir,appVersion:'test'}),{code:'ERR_MIGRATION_CORPUS'});assert.deepEqual(await dump(r),before);assert.deepEqual(fs.readFileSync(db),bytes);}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('sparse [1,3] bootstrap and changed valid corpus preserve ledger conflict',async()=>{const{root,dir,db}=fixture();try{fs.unlinkSync(path.join(dir,'0002__b.sql'));fs.writeFileSync(path.join(dir,'CHECKSUMS.json'),JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(dir,'CHECKSUMS.json'),'utf8'))).filter(([n])=>n!=='0002__b.sql'))));const r=cliRunner(db);assert.deepEqual((await bootstrapFresh(r,{migrationsDir:dir,appVersion:'test'})).applied,[1,3]);assert.deepEqual(await verifyHead(r,{migrationsDir:dir}),{ok:true});fs.appendFileSync(path.join(dir,'0001__a.sql'),'-- changed\n');await assert.rejects(()=>applyPending(r,{migrationsDir:dir}),{code:'ERR_MIGRATION_CORPUS'});assert.equal((await r.all('SELECT status FROM schema_migrations WHERE version=1'))[0].status,'applied');writeFixture(dir,{'0001__a.sql':sql('a')+'-- changed\n'});await assert.rejects(()=>applyPending(r,{migrationsDir:dir}),/repair_required/);assert.equal((await r.all('SELECT status FROM schema_migrations WHERE version=1'))[0].status,'repair_required');}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('accepted content survives replacement; fresh load and forged context refuse',async()=>{const{root,dir,db}=fixture();try{const corpus=loadMigrationCorpus(dir);fs.appendFileSync(path.join(dir,'0001__a.sql'),'-- bad');assert.throws(()=>loadMigrationCorpus(dir),{code:'ERR_MIGRATION_CORPUS'});assert.throws(()=>resolveCorpus(dir,{...corpus}),{code:'ERR_MIGRATION_CORPUS'});assert.throws(()=>resolveCorpus(root,corpus),{code:'ERR_MIGRATION_CORPUS'});const selected=materializeMigrations(path.join(root,'selected'),[{corpus,name:'0001__a.sql',asName:'0003__renamed.sql'}]);assert.equal(selected.migrations[0].checksum,corpus.migrations[0].checksum);assert.equal(selected.migrations[0].sql,files['0001__a.sql']);await applyPending(cliRunner(db),{migrationsDir:dir,corpus,appVersion:'test'});assert.deepEqual(await verifyHead(cliRunner(db),{migrationsDir:dir,corpus}),{ok:true});}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('deterministic during-read and final-set replacements refuse',()=>{const{root,dir}=fixture();const read=fs.readFileSync,list=fs.readdirSync;try{let count=0;fs.readFileSync=function(...args){const b=read.apply(this,args);if(typeof args[0]==='number'&&++count===2)fs.appendFileSync(path.join(dir,'0001__a.sql'),'-- changed');return b;};assert.throws(()=>loadMigrationCorpus(dir),{code:'ERR_MIGRATION_CORPUS'});fs.readFileSync=read;writeFixture(dir,files);let lists=0;fs.readdirSync=function(...args){if(args[0]===dir&&++lists===2)fs.writeFileSync(path.join(dir,'0004__d.sql'),sql('d'));return list.apply(this,args);};assert.throws(()=>loadMigrationCorpus(dir),{code:'ERR_MIGRATION_CORPUS'});}finally{fs.readFileSync=read;fs.readdirSync=list;fs.rmSync(root,{recursive:true,force:true});}});
diff --git a/lib/osi-migrate/__tests__/runner-data-risk.test.js b/lib/osi-migrate/__tests__/runner-data-risk.test.js
index 5a1df4ea..1eb56733 100644
--- a/lib/osi-migrate/__tests__/runner-data-risk.test.js
+++ b/lib/osi-migrate/__tests__/runner-data-risk.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -11 +12 @@ test('a data-risk migration takes a backup and applies without writers stopped',
-  fs.writeFileSync(path.join(dir, '0001__seed.sql'),
+  fixtureWrite(path.join(dir, '0001__seed.sql'),
@@ -13 +14 @@ test('a data-risk migration takes a backup and applies without writers stopped',
-  fs.writeFileSync(path.join(dir, '0002__backfill.sql'),
+  fixtureWrite(path.join(dir, '0002__backfill.sql'),
diff --git a/lib/osi-migrate/__tests__/runner-destructive.test.js b/lib/osi-migrate/__tests__/runner-destructive.test.js
index a84ef403..3e686834 100644
--- a/lib/osi-migrate/__tests__/runner-destructive.test.js
+++ b/lib/osi-migrate/__tests__/runner-destructive.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -11 +12 @@ function fixture(files) {
-  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
+  for (const [n, b] of Object.entries(files)) fixtureWrite(path.join(dir, n), b);
@@ -43 +44 @@ test('destructive migration preserves child rows (FK fence effective) when write
-  fs.writeFileSync(path.join(dir, '0002__rebuild.sql'), DESTRUCTIVE);
+  fixtureWrite(path.join(dir, '0002__rebuild.sql'), DESTRUCTIVE);
diff --git a/lib/osi-migrate/__tests__/runner-drift-preflight.test.js b/lib/osi-migrate/__tests__/runner-drift-preflight.test.js
index 3c84acd7..6f55b88e 100644
--- a/lib/osi-migrate/__tests__/runner-drift-preflight.test.js
+++ b/lib/osi-migrate/__tests__/runner-drift-preflight.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -14 +15 @@ function tmpMigrations() {
-  fs.writeFileSync(path.join(dir, '0001__b.sql'),
+  fixtureWrite(path.join(dir, '0001__b.sql'),
@@ -55 +56 @@ test('out-of-band drift with a PENDING migration refuses and leaves it unapplied
-  fs.writeFileSync(path.join(dir, '0002__c.sql'),
+  fixtureWrite(path.join(dir, '0002__c.sql'),
diff --git a/lib/osi-migrate/__tests__/runner-fingerprint-scheme-upgrade.test.js b/lib/osi-migrate/__tests__/runner-fingerprint-scheme-upgrade.test.js
index 46a0caca..3309024d 100644
--- a/lib/osi-migrate/__tests__/runner-fingerprint-scheme-upgrade.test.js
+++ b/lib/osi-migrate/__tests__/runner-fingerprint-scheme-upgrade.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -35 +36 @@ function fixture() {
-  fs.writeFileSync(path.join(dir, '0001__a.sql'),
+  fixtureWrite(path.join(dir, '0001__a.sql'),
@@ -78 +79 @@ test('pure scheme upgrade: unchanged live schema, stored under v2 -> verifyHead
-  fs.writeFileSync(path.join(dir, '0002__b.sql'), '-- risk: additive\nCREATE TABLE t2 (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0002__b.sql'), '-- risk: additive\nCREATE TABLE t2 (id INTEGER PRIMARY KEY);\n');
diff --git a/lib/osi-migrate/__tests__/runner-partial-batch-retry.test.js b/lib/osi-migrate/__tests__/runner-partial-batch-retry.test.js
index 6ba3425f..d9f63397 100644
--- a/lib/osi-migrate/__tests__/runner-partial-batch-retry.test.js
+++ b/lib/osi-migrate/__tests__/runner-partial-batch-retry.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -22 +23 @@ test('partial-batch failure leaves committed migrations stamped; retry is not bl
-  fs.writeFileSync(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
@@ -27,2 +28,2 @@ test('partial-batch failure leaves committed migrations stamped; retry is not bl
-  fs.writeFileSync(path.join(dir, '0002__b.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\n');
-  fs.writeFileSync(path.join(dir, '0003__bad.sql'), '-- risk: additive\nCREATE TABLE c (id INTEGER PRIMARY KEY);\nNOT VALID SQL;\n');
+  fixtureWrite(path.join(dir, '0002__b.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0003__bad.sql'), '-- risk: additive\nCREATE TABLE c (id INTEGER PRIMARY KEY);\nNOT VALID SQL;\n');
@@ -38 +39 @@ test('partial-batch failure leaves committed migrations stamped; retry is not bl
-  fs.writeFileSync(path.join(dir, '0003__bad.sql'), '-- risk: additive\nCREATE TABLE c (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0003__bad.sql'), '-- risk: additive\nCREATE TABLE c (id INTEGER PRIMARY KEY);\n');
diff --git a/lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js b/lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js
index ad3e85f3..d86a8a35 100644
--- a/lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js
+++ b/lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -36 +37 @@ async function affectedGatewayFixture() {
-    fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(selectedDir, name));
+    fixtureCopy(path.join(MIGRATIONS_DIR, name), path.join(selectedDir, name));
diff --git a/lib/osi-migrate/__tests__/verify-head-gap.test.js b/lib/osi-migrate/__tests__/verify-head-gap.test.js
index 9d841149..48ad88f9 100644
--- a/lib/osi-migrate/__tests__/verify-head-gap.test.js
+++ b/lib/osi-migrate/__tests__/verify-head-gap.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
@@ -11 +12 @@ function fixture(files) {
-  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
+  for (const [n, b] of Object.entries(files)) fixtureWrite(path.join(dir, n), b);
@@ -43 +44 @@ test('applyPending persists repair_required before throwing on changed applied m
-  fs.writeFileSync(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY, changed TEXT);\n');
+  fixtureWrite(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY, changed TEXT);\n');
diff --git a/lib/osi-migrate/migration-manifest.js b/lib/osi-migrate/migration-manifest.js
new file mode 100644
index 00000000..6473fbc9
--- /dev/null
+++ b/lib/osi-migrate/migration-manifest.js
@@ -0,0 +1,57 @@
+'use strict';
+const { TextDecoder } = require('node:util');
+const NAME_RE = /^([0-9]{4})__([a-z0-9_]+)\.sql$/;
+function corpusError(message) {
+  const e = new Error(`migration corpus: ${message}`);
+  e.code = 'ERR_MIGRATION_CORPUS';
+  return e;
+}
+function migrationName(name) {
+  const m = typeof name === 'string' && NAME_RE.exec(name);
+  if (!m || m[0] !== name) throw corpusError(`bad migration filename: ${JSON.stringify(name)}`);
+  return { version: Number(m[1]), slug: m[2] };
+}
+function parseManifest(raw) {
+  let text;
+  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
+  catch (e) { throw corpusError(`invalid manifest UTF-8: ${e.message}`); }
+  let i = 0;
+  const white = () => { while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; };
+  const expect = (ch) => { white(); if (text[i++] !== ch) throw corpusError(`expected ${ch} in CHECKSUMS.json`); };
+  const string = () => {
+    white();
+    if (text[i] !== '"') throw corpusError('manifest keys and hashes must be strings');
+    const start = i++;
+    while (i < text.length) {
+      const ch = text[i++];
+      if (ch === '\\') { i++; continue; }
+      if (ch === '"') {
+        try { return JSON.parse(text.slice(start, i)); }
+        catch (e) { throw corpusError(`invalid JSON string: ${e.message}`); }
+      }
+    }
+    throw corpusError('unterminated JSON string');
+  };
+  expect('{'); white();
+  if (text[i] === '}') throw corpusError('empty manifest');
+  const names = new Set(), versions = new Set(), entries = [];
+  while (true) {
+    const name = string();
+    if (names.has(name)) throw corpusError(`duplicate manifest key: ${name}`);
+    names.add(name);
+    const { version, slug } = migrationName(name);
+    if (versions.has(version)) throw corpusError(`duplicate migration version: ${version}`);
+    versions.add(version);
+    expect(':');
+    const checksum = string();
+    if (checksum.length !== 64 || !/^[0-9a-f]+$/.test(checksum)) throw corpusError(`malformed SHA-256 for ${name}`);
+    entries.push(Object.freeze({ name, version, slug, checksum }));
+    white();
+    if (text[i] === '}') { i++; break; }
+    expect(',');
+  }
+  white();
+  if (i !== text.length) throw corpusError('trailing manifest input');
+  return Object.freeze(entries.sort((a, b) => a.version - b.version));
+}
+module.exports = { parseManifest, migrationName, corpusError };
diff --git a/lib/osi-migrate/migrations-loader.js b/lib/osi-migrate/migrations-loader.js
index d3d4af95..ad633567 100644
--- a/lib/osi-migrate/migrations-loader.js
+++ b/lib/osi-migrate/migrations-loader.js
@@ -5,2 +5 @@ const crypto = require('node:crypto');
-
-const NAME_RE = /^(\d{4})__([a-z0-9_]+)\.sql$/;
+const { parseManifest, migrationName, corpusError } = require('./migration-manifest');
@@ -8,23 +7,77 @@ const RISK_RE = /^(?:\uFEFF)?(?:[ \t]*\r?\n)*--\s*risk:\s*(additive|destructive|
-
-function loadMigrations(dir) {
-  const out = [];
-  const seen = new Set();
-  for (const file of fs.readdirSync(dir).sort()) {
-    if (!file.endsWith('.sql')) continue;
-    const match = NAME_RE.exec(file);
-    if (!match) throw new Error(`bad migration filename: ${file} (expected NNNN__slug.sql)`);
-    const version = Number(match[1]);
-    if (seen.has(version)) throw new Error(`duplicate migration version: ${version}`);
-    seen.add(version);
-    const raw = fs.readFileSync(path.join(dir, file));
-    const sql = raw.toString('utf8');
-    const risk = RISK_RE.exec(sql);
-    if (!risk) throw new Error(`migration ${file} missing '-- risk: additive|destructive|data' header`);
-    out.push({
-      version,
-      name: file,
-      slug: match[2],
-      risk: risk[1],
-      sql,
-      checksum: crypto.createHash('sha256').update(raw).digest('hex'),
-    });
+const snapshots = new WeakMap();
+const stableFields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
+const sameStat = (a, b) => stableFields.every((k) => a[k] === b[k]);
+function regularRead(file) {
+  let fd;
+  try {
+    const before = fs.lstatSync(file, { bigint: true });
+    if (!before.isFile() || before.isSymbolicLink()) throw corpusError(`not a regular file: ${file}`);
+    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
+    const opened = fs.fstatSync(fd, { bigint: true });
+    if (!opened.isFile() || !sameStat(before, opened)) throw corpusError(`file changed before read: ${file}`);
+    const raw = fs.readFileSync(fd);
+    const after = fs.fstatSync(fd, { bigint: true });
+    if (!sameStat(opened, after) || BigInt(raw.length) !== after.size) throw corpusError(`file changed during read: ${file}`);
+    return { file, raw, stat: after };
+  } finally { if (fd !== undefined) fs.closeSync(fd); }
+}
+function sqlNames(dir) { return fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort(); }
+function readMigrationManifest(dir) {
+  try { return parseManifest(regularRead(path.join(dir, 'CHECKSUMS.json')).raw); }
+  catch (e) { throw corpusError(`CHECKSUMS.json: ${e.message.replace(/^migration corpus: /, '')}`); }
+}
+function loadMigrationCorpus(dir) {
+  const resolved = path.resolve(dir);
+  try {
+    const root = fs.lstatSync(resolved, { bigint: true });
+    if (!root.isDirectory() || root.isSymbolicLink()) throw corpusError('migration root must be a nonsymlink directory');
+    const manifestFile = regularRead(path.join(resolved, 'CHECKSUMS.json'));
+    const entries = parseManifest(manifestFile.raw);
+    const expected = entries.map((e) => e.name).sort();
+    const actual = sqlNames(resolved);
+    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw corpusError(`file set mismatch: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
+    const reads = [manifestFile], rawByName = new Map(), migrations = [];
+    for (const e of entries) {
+      const read = regularRead(path.join(resolved, e.name));
+      reads.push(read);
+      const checksum = crypto.createHash('sha256').update(read.raw).digest('hex');
+      if (checksum !== e.checksum) throw corpusError(`checksum mismatch for ${e.name}`);
+      const sql = read.raw.toString('utf8');
+      const risk = RISK_RE.exec(sql);
+      if (!risk) throw corpusError(`migration ${e.name} missing '-- risk: additive|destructive|data' header`);
+      rawByName.set(e.name, read.raw);
+      migrations.push(Object.freeze({ ...e, sql, risk: risk[1] }));
+    }
+    for (const read of reads) {
+      const now = fs.lstatSync(read.file, { bigint: true });
+      if (!now.isFile() || !sameStat(read.stat, now)) throw corpusError(`file changed during corpus load: ${read.file}`);
+    }
+    const endRoot = fs.lstatSync(resolved, { bigint: true });
+    if (!endRoot.isDirectory() || endRoot.isSymbolicLink() || root.dev !== endRoot.dev || root.ino !== endRoot.ino || JSON.stringify(sqlNames(resolved)) !== JSON.stringify(actual)) throw corpusError('directory changed during corpus load');
+    const identity = crypto.createHash('sha256').update(manifestFile.raw).digest('hex');
+    const corpus = Object.freeze({ dir: resolved, identity, migrations: Object.freeze(migrations) });
+    snapshots.set(corpus, rawByName);
+    return corpus;
+  } catch (e) {
+    if (e.code === 'ERR_MIGRATION_CORPUS') throw e;
+    throw corpusError(`${resolved}: ${e.message}`);
+  }
+}
+function resolveCorpus(dir, corpus) {
+  if (corpus === undefined) return loadMigrationCorpus(dir);
+  if (!snapshots.has(corpus) || corpus.dir !== path.resolve(dir)) throw corpusError('invalid or directory-mismatched snapshot');
+  return corpus;
+}
+function loadMigrations(dir) { return loadMigrationCorpus(dir).migrations; }
+function materializeMigrations(dest, selections) {
+  if (!selections.length) throw corpusError('empty migration selection');
+  const output = [], seenNames = new Set(), seenVersions = new Set();
+  for (const s of selections) {
+    if (!snapshots.has(s.corpus)) throw corpusError('selection requires a validated snapshot');
+    const source = s.corpus.migrations.find((m) => m.name === s.name);
+    if (!source) throw corpusError(`selection source absent: ${s.name}`);
+    const name = s.asName === undefined ? s.name : s.asName;
+    const { version } = migrationName(name);
+    if (seenNames.has(name) || seenVersions.has(version)) throw corpusError('duplicate selected name/version');
+    seenNames.add(name); seenVersions.add(version);
+    output.push({ name, checksum: source.checksum, raw: snapshots.get(s.corpus).get(s.name) });
@@ -32 +85,5 @@ function loadMigrations(dir) {
-  return out.sort((a, b) => a.version - b.version);
+  fs.mkdirSync(dest, { mode: 0o700 }); // parent exists; destination must be new
+  for (const e of output) fs.writeFileSync(path.join(dest, e.name), e.raw, { flag: 'wx' });
+  const manifest = Object.fromEntries(output.map((e) => [e.name, e.checksum]));
+  fs.writeFileSync(path.join(dest, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
+  return loadMigrationCorpus(dest);
@@ -34,2 +91 @@ function loadMigrations(dir) {
-
-module.exports = { loadMigrations };
+module.exports = { loadMigrations, loadMigrationCorpus, resolveCorpus, readMigrationManifest, materializeMigrations };
diff --git a/lib/osi-migrate/runner.js b/lib/osi-migrate/runner.js
index 8b39c00e..3f21be6d 100644
--- a/lib/osi-migrate/runner.js
+++ b/lib/osi-migrate/runner.js
@@ -3 +3 @@ const path = require('node:path');
-const { loadMigrations } = require('./migrations-loader');
+const { resolveCorpus } = require('./migrations-loader');
@@ -91 +91,2 @@ async function isPureNormalizerSchemeUpgrade(runner, storedFps) {
-async function isBootOwnedTriggerBodyDrift(runner, migrationsDir, appliedHeadVersion, { bootOwnedTriggerNames } = {}) {
+async function isBootOwnedTriggerBodyDrift(runner, migrationsDir, appliedHeadVersion, { bootOwnedTriggerNames, corpus } = {}) {
+  corpus = resolveCorpus(migrationsDir, corpus);
@@ -108 +109 @@ async function isBootOwnedTriggerBodyDrift(runner, migrationsDir, appliedHeadVer
-    refDbPath = await buildReference(migrationsDir, appliedHeadVersion, scratchRoot);
+    refDbPath = await buildReference(migrationsDir, appliedHeadVersion, scratchRoot, { corpus });
@@ -171 +172,3 @@ function maxAppliedVersion(appliedRows) {
-async function applyPending(runner, { migrationsDir, appVersion, writersStopped = false }) {
+async function applyPending(runner, { migrationsDir, appVersion, writersStopped = false, corpus }) {
+  corpus = resolveCorpus(migrationsDir, corpus);
+  const migrations = corpus.migrations;
@@ -189 +192 @@ async function applyPending(runner, { migrationsDir, appVersion, writersStopped
-      } else if (await isBootOwnedTriggerBodyDrift(runner, migrationsDir, maxAppliedVersion(applied))) {
+      } else if (await isBootOwnedTriggerBodyDrift(runner, migrationsDir, maxAppliedVersion(applied), { corpus })) {
@@ -202 +204,0 @@ async function applyPending(runner, { migrationsDir, appVersion, writersStopped
-  const migrations = loadMigrations(migrationsDir);
@@ -282,0 +285 @@ async function bootstrapFresh(runner, opts) {
+  const corpus = resolveCorpus(opts.migrationsDir, opts.corpus);
@@ -284 +287 @@ async function bootstrapFresh(runner, opts) {
-  return applyPending(runner, { ...opts, writersStopped: true });
+  return applyPending(runner, { ...opts, corpus, writersStopped: true });
@@ -321,2 +324,3 @@ async function readStoredFingerprints(runner) {
-async function verifyHead(runner, { migrationsDir }) {
-  const { loadMigrations } = require('./migrations-loader');
+async function verifyHead(runner, { migrationsDir, corpus }) {
+  corpus = resolveCorpus(migrationsDir, corpus);
+  const expected = corpus.migrations;
@@ -326 +329,0 @@ async function verifyHead(runner, { migrationsDir }) {
-  const expected = loadMigrations(migrationsDir);
@@ -342 +345 @@ async function verifyHead(runner, { migrationsDir }) {
-    if (await isBootOwnedTriggerBodyDrift(runner, migrationsDir, maxAppliedVersion(appliedRows))) {
+    if (await isBootOwnedTriggerBodyDrift(runner, migrationsDir, maxAppliedVersion(appliedRows), { corpus })) {
diff --git a/scripts/baseline-existing-db.js b/scripts/baseline-existing-db.js
index bf771a9f..5ecca31b 100644
--- a/scripts/baseline-existing-db.js
+++ b/scripts/baseline-existing-db.js
@@ -18 +18 @@ const { ensureLedger, successInsertSql } = require('../lib/osi-migrate/ledger');
-const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
+const { loadMigrationCorpus, resolveCorpus, materializeMigrations } = require('../lib/osi-migrate/migrations-loader');
@@ -67,0 +68 @@ function getChainState(migrationsDir, scratchRoot, runnerOptions = {}) {
+  const corpus = resolveCorpus(migrationsDir, runnerOptions.corpus);
@@ -69 +70 @@ function getChainState(migrationsDir, scratchRoot, runnerOptions = {}) {
-  const key = `${path.resolve(migrationsDir)}\0${runner.key}`;
+  const key = `${corpus.dir}\0${corpus.identity}\0${runner.key}`;
@@ -73,16 +74,3 @@ function getChainState(migrationsDir, scratchRoot, runnerOptions = {}) {
-    const subset = path.join(dir, 'migrations');
-    fs.mkdirSync(subset);
-    state = {
-      dir,
-      subset,
-      workingDb: path.join(dir, 'working.db'),
-      files: fs.readdirSync(migrationsDir)
-        .filter((f) => /^\d{4}__[a-z0-9_]+\.sql$/.test(f))
-        .sort(),
-      bootstrapped: false,
-      nextIdx: 0,
-      byVersion: new Map(), // version -> { dbPath, snap }
-      runner: null,
-      runnerFactory: runner.factory,
-      chain: Promise.resolve(),
-    };
+    state = { dir, corpus, entries: corpus.migrations, workingDb: path.join(dir, 'working.db'),
+      bootstrapped: false, nextIdx: 0, byVersion: new Map(), runner: null,
+      runnerFactory: runner.factory, chain: Promise.resolve() };
@@ -94,6 +82 @@ function getChainState(migrationsDir, scratchRoot, runnerOptions = {}) {
-// Extends the shared chain to cover every migration <= n that isn't already
-// built, applying only the newly-reached ones. Serialized on state.chain so
-// concurrent callers for the same migrationsDir and runner mode can't race the
-// one working DB.
-function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {}) {
-  const state = getChainState(migrationsDir, scratchRoot, runnerOptions);
+function ensureReferenceUpTo(state, n) {
@@ -102,14 +85,12 @@ function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {})
-    const runner = state.runner;
-    while (state.nextIdx < state.files.length) {
-      const f = state.files[state.nextIdx];
-      const version = Number(f.slice(0, 4));
-      if (version > n) break;
-      fs.copyFileSync(path.join(migrationsDir, f), path.join(state.subset, f));
-      if (!state.bootstrapped) {
-        await bootstrapFresh(runner, { migrationsDir: state.subset, appVersion: 'stage0-reference' });
-        state.bootstrapped = true;
-      } else {
-        await applyPending(runner, { migrationsDir: state.subset, appVersion: 'stage0-reference', writersStopped: true });
-      }
-      const snap = await snapshotSchema(runner);
-      const savedPath = path.join(state.dir, `ref-${f.slice(0, 4)}.db`);
+    while (state.nextIdx < state.entries.length) {
+      const entry = state.entries[state.nextIdx];
+      if (entry.version > n) break;
+      const stepRoot = fs.mkdtempSync(path.join(state.dir, 'subset-'));
+      const subset = path.join(stepRoot, 'migrations');
+      const corpus = materializeMigrations(subset, state.entries.slice(0, state.nextIdx + 1)
+        .map((m) => ({ corpus: state.corpus, name: m.name })));
+      const opts = { migrationsDir: subset, corpus, appVersion: 'stage0-reference', writersStopped: true };
+      if (!state.bootstrapped) { await bootstrapFresh(state.runner, opts); state.bootstrapped = true; }
+      else await applyPending(state.runner, opts);
+      const snap = await snapshotSchema(state.runner);
+      const savedPath = path.join(state.dir, `ref-${String(entry.version).padStart(4, '0')}.db`);
@@ -117,2 +98,2 @@ function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {})
-      state.byVersion.set(version, { dbPath: savedPath, snap });
-      state.nextIdx += 1;
+      state.byVersion.set(entry.version, { dbPath: savedPath, snap });
+      state.nextIdx++;
@@ -121,3 +101,0 @@ function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {})
-  // Keep the serialization chain usable after a failed attempt. The caller
-  // still receives the rejection, while the next call starts from the last
-  // published snapshot with a fresh connection.
@@ -125,2 +102,0 @@ function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {})
-    // nodeSqliteRunner closes on exec failure, rolling back any open
-    // transaction. Do not reuse a failed handle on the next retry.
@@ -129,12 +105,2 @@ function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {})
-    // A failed first migration leaves recordFailure's metadata tables behind,
-    // while a later failure leaves the working DB one step past the last
-    // published snapshot. Restore the exact published file before retrying so
-    // bootstrapFresh/applyPending see the same state as a fresh attempt.
-    for (const suffix of ['', '-wal', '-shm']) {
-      const target = state.workingDb + suffix;
-      if (fs.existsSync(target)) fs.unlinkSync(target);
-    }
-    if (state.nextIdx > 0) {
-      const prior = state.byVersion.get(Number(state.files[state.nextIdx - 1].slice(0, 4))).dbPath;
-      fs.copyFileSync(prior, state.workingDb);
-    }
+    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(state.workingDb + suffix, { force: true });
+    if (state.nextIdx > 0) fs.copyFileSync(state.byVersion.get(state.entries[state.nextIdx - 1].version).dbPath, state.workingDb);
@@ -142 +107,0 @@ function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {})
-    return undefined;
@@ -147,41 +111,0 @@ function ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions = {})
-// "reference(n)" means "a DB with every migration whose version <= n
-// applied" (see bb3bda079, which fixed the same class of bug on reconcile's
-// side) - NOT "the migration file literally numbered n". On a tree with a
-// version gap (e.g. this branch's own missing 0059, renumbered to 0060
-// because main owns 0059, #351) there is no file at version n itself, so
-// byVersion - keyed only by versions that exist as files - has no entry for
-// n.
-//
-// referenceSnapshot()/buildReference() do NOT resolve n down to the nearest
-// present version themselves - they stay STRICT and throw (via
-// byVersion.get(n) being undefined) for any n with no migration file,
-// whether an interior gap or n > the last present version. That strictness
-// is load-bearing for a THIRD caller neither bb3bda079 nor 5c8470e94 (which
-// added gap resolution here and then removed it again, see git history)
-// accounted for: lib/osi-migrate/runner.js's isBootOwnedTriggerBodyDrift
-// (reached from the live runner's drift-grace path in applyPending and
-// verifyHead) calls buildReference with the DEVICE's highest *applied*
-// ledger version, not a version this tree's migration files necessarily
-// have - a gap on this branch, or n > head on a downgrade/rollback (on main
-// too), both throw a plain TypeError before this comment's fix, which that
-// caller's try/catch turns into a safe refusal (fail closed on an
-// unprovable state - a version the device ran but this reference chain
-// cannot build is not proof the live schema is safe to bless). Resolving
-// the gap down here would instead silently compare the live schema against
-// a reference that is missing a migration the device actually applied.
-//
-// Callers that legitimately need "the highest present version <= n" must
-// resolve it themselves, at the call site, before calling in:
-// - reconcile-ledger-numbering.js's buildReferenceAt (bb3bda079): n there is
-//   target.version-1, a tree-relative offset, not a device-applied version -
-//   resolving down to the nearest present file is exactly correct there.
-// - runBaseline() below: the default candidate scan only ever walks real
-//   migration-file versions (5c8470e94), and an explicit --version is
-//   validated against the migration list before it ever reaches here (see
-//   runBaseline's version checks) - so runBaseline never passes a gap
-//   version in the first place.
-//
-// On a contiguous tree (main) every version has a file, so none of this
-// changes behaviour there either way.
-
-// Reference(N) snapshot, built (or reused) via the shared incremental chain.
@@ -189,22 +113,4 @@ async function referenceSnapshot(migrationsDir, n, scratchRoot, runnerOptions =
-  await ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions);
-  return getChainState(migrationsDir, scratchRoot, runnerOptions).byVersion.get(n).snap;
-}
-
-function loadManifest(migrationsDir) {
-  const p = path.join(migrationsDir, 'CHECKSUMS.json');
-  if (!fs.existsSync(p)) throw new Error(`checksum manifest missing: ${p}`);
-  return JSON.parse(fs.readFileSync(p, 'utf8'));
-}
-
-function assertManifestMatchesDisk(migrations, manifest) {
-  const migrationNames = new Set(migrations.map((m) => m.name));
-  for (const m of migrations) {
-    if (manifest[m.name] !== m.checksum) {
-      throw new Error(`checksum manifest mismatch for ${m.name}: this checkout's migration files diverge from CHECKSUMS.json - refusing to baseline anything`);
-    }
-  }
-  for (const filename of Object.keys(manifest)) {
-    if (!migrationNames.has(filename)) {
-      throw new Error(`checksum manifest has no migration file for ${filename} - refusing to baseline anything`);
-    }
-  }
+  const state = getChainState(migrationsDir, scratchRoot, runnerOptions);
+  if (!state.entries.some((m) => m.version === n)) throw new TypeError(`reference version ${n} has no migration file`);
+  await ensureReferenceUpTo(state, n);
+  return state.byVersion.get(n).snap;
@@ -230,2 +136,4 @@ async function buildReference(migrationsDir, n, scratchRoot, runnerOptions = {})
-  await ensureReferenceUpTo(migrationsDir, n, scratchRoot, runnerOptions);
-  return getChainState(migrationsDir, scratchRoot, runnerOptions).byVersion.get(n).dbPath;
+  const state = getChainState(migrationsDir, scratchRoot, runnerOptions);
+  if (!state.entries.some((m) => m.version === n)) throw new TypeError(`reference version ${n} has no migration file`);
+  await ensureReferenceUpTo(state, n);
+  return state.byVersion.get(n).dbPath;
@@ -243 +151 @@ function printDiffs(log, label, diffs) {
-async function stamp(dbPath, migrations, manifest, n) {
+async function stamp(dbPath, migrations, n) {
@@ -251 +159 @@ async function stamp(dbPath, migrations, manifest, n) {
-      checksum: manifest[m.name],
+      checksum: m.checksum,
@@ -264,4 +172,2 @@ async function runBaseline({ dbPath, version = null, report = false, migrationsD
-  const migrations = loadMigrations(migrationsDir);
-  if (migrations.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);
-  const manifest = loadManifest(migrationsDir);
-  assertManifestMatchesDisk(migrations, manifest);
+  const corpus = loadMigrationCorpus(migrationsDir);
+  const migrations = corpus.migrations;
@@ -283 +189 @@ async function runBaseline({ dbPath, version = null, report = false, migrationsD
-  const runnerOptions = { runnerFactory };
+  const runnerOptions = { runnerFactory, corpus };
@@ -326 +232 @@ async function runBaseline({ dbPath, version = null, report = false, migrationsD
-  await stamp(dbPath, migrations, manifest, matched);
+  await stamp(dbPath, migrations, matched);
diff --git a/scripts/baseline-existing-db.test.js b/scripts/baseline-existing-db.test.js
index 1f2852a5..8591ee8d 100644
--- a/scripts/baseline-existing-db.test.js
+++ b/scripts/baseline-existing-db.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -60 +61 @@ async function makePreLedgerDeviceAt(n, extraSql = '') {
-  fs.copyFileSync(refDb, db);
+  fixtureCopy(refDb, db);
@@ -118,2 +119,2 @@ test('checksum manifest divergence from disk refuses before comparing', async ()
-  fs.writeFileSync(path.join(dir, '0001__x.sql'), '-- risk: additive\nCREATE TABLE a (x TEXT);\n');
-  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), JSON.stringify({ '0001__x.sql': 'f'.repeat(64) }, null, 2));
+  fixtureWrite(path.join(dir, '0001__x.sql'), '-- risk: additive\nCREATE TABLE a (x TEXT);\n');
+  fixtureWrite(path.join(dir, 'CHECKSUMS.json'), JSON.stringify({ '0001__x.sql': 'f'.repeat(64) }, null, 2));
@@ -124 +125 @@ test('checksum manifest divergence from disk refuses before comparing', async ()
-    /manifest mismatch/
+    /migration corpus: checksum mismatch for 0001__x\.sql/
@@ -135,2 +136,2 @@ test('reference chain retry rebuilds from the last published snapshot after a mi
-  fs.writeFileSync(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
-  fs.writeFileSync(path.join(dir, '0002__bad.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\nNOT VALID SQL;\n');
+  fixtureWrite(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0002__bad.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\nNOT VALID SQL;\n');
@@ -138 +139 @@ test('reference chain retry rebuilds from the last published snapshot after a mi
-  fs.writeFileSync(path.join(dir, '0002__bad.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0002__bad.sql'), '-- risk: additive\nCREATE TABLE b (id INTEGER PRIMARY KEY);\n');
@@ -150 +151 @@ test('reference chain uses the persistent adapter without spawning sqlite3', ()
-    fs.writeFileSync(path.join(dir, `000${version}__a${version}.sql`),
+    fixtureWrite(path.join(dir, `000${version}__a${version}.sql`),
@@ -173 +174 @@ test('reference chain defaults to cliRunner when no persistent runner opt-in is
-  fs.writeFileSync(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0001__a.sql'), '-- risk: additive\nCREATE TABLE a (id INTEGER PRIMARY KEY);\n');
@@ -220,2 +221,2 @@ test('candidate scan across a migrations-dir version gap matches at the highest
-  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
-  fs.writeFileSync(path.join(dir, '0002__widget.sql'), '-- risk: additive\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);\n');
+  fixtureWrite(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0002__widget.sql'), '-- risk: additive\nCREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT);\n');
@@ -223 +224 @@ test('candidate scan across a migrations-dir version gap matches at the highest
-  fs.writeFileSync(path.join(dir, '0004__gadget.sql'), '-- risk: additive\nCREATE TABLE gadget (id INTEGER PRIMARY KEY, kind TEXT);\n');
+  fixtureWrite(path.join(dir, '0004__gadget.sql'), '-- risk: additive\nCREATE TABLE gadget (id INTEGER PRIMARY KEY, kind TEXT);\n');
@@ -226 +227 @@ test('candidate scan across a migrations-dir version gap matches at the highest
-  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), JSON.stringify(manifest));
+  fixtureWrite(path.join(dir, 'CHECKSUMS.json'), JSON.stringify(manifest));
@@ -232 +233 @@ test('candidate scan across a migrations-dir version gap matches at the highest
-  fs.copyFileSync(refDb2, db);
+  fixtureCopy(refDb2, db);
diff --git a/scripts/deploy-bundle.sh b/scripts/deploy-bundle.sh
index 6babfbe2..ef3ebf99 100755
--- a/scripts/deploy-bundle.sh
+++ b/scripts/deploy-bundle.sh
@@ -53 +53 @@ fetch_list_file="$stage_dir/.fetch-list.txt"
-node "$REPO_ROOT/scripts/deploy-fetch-list.js" "$REPO_ROOT" > "$fetch_list_file"
+node "$REPO_ROOT/scripts/deploy-fetch-list.js" "$REPO_ROOT" --corpus-identities-out "$stage_dir/.corpus-identities.json" > "$fetch_list_file"
@@ -89 +89,2 @@ cp "$REACT_GUI_TARBALL" "$stage_dir/react_gui.tar.gz"
-rm -f "$fetch_list_file"
+node "$REPO_ROOT/scripts/deploy-fetch-list.js" "$stage_dir" --verify-corpus-identities "$stage_dir/.corpus-identities.json"
+rm -f "$fetch_list_file" "$stage_dir/.corpus-identities.json"
diff --git a/scripts/deploy-bundle.test.sh b/scripts/deploy-bundle.test.sh
index 781f27ed..2721051e 100755
--- a/scripts/deploy-bundle.test.sh
+++ b/scripts/deploy-bundle.test.sh
@@ -89,0 +90,7 @@ grep -qx 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-wat
+for module in migration-manifest.js migrations-loader.js; do
+  grep -qx "./lib/osi-migrate/$module" "$listing" || grep -qx "lib/osi-migrate/$module" "$listing" || {
+    echo "bundle missing early manifest module $module" >&2
+    exit 1
+  }
+done
+
diff --git a/scripts/deploy-command-ledger-dependency.test.js b/scripts/deploy-command-ledger-dependency.test.js
index b03444e4..27985f8d 100644
--- a/scripts/deploy-command-ledger-dependency.test.js
+++ b/scripts/deploy-command-ledger-dependency.test.js
@@ -1083,0 +1084,2 @@ const RUNNER_FETCH_TARGETS = [
+  ['lib/osi-migrate/migration-manifest.js', 'migration-manifest.js'],
+  ['lib/osi-migrate/migrations-loader.js', 'migrations-loader.js'],
diff --git a/scripts/deploy-corpus.test.js b/scripts/deploy-corpus.test.js
new file mode 100644
index 00000000..a904a716
--- /dev/null
+++ b/scripts/deploy-corpus.test.js
@@ -0,0 +1,12 @@
+'use strict';
+const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
+const {spawnSync}=require('node:child_process');
+const {writeFixture}=require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
+const {collectCorpusIdentities,computeFetchList}=require('./deploy-fetch-list');
+const {vectors}=require('../lib/osi-migrate/__tests__/helpers/manifest-vectors');
+const repo=path.resolve(__dirname,'..'),deploy=fs.readFileSync(path.join(repo,'deploy.sh'),'utf8');
+const sql=t=>`-- risk: additive\nCREATE TABLE ${t}(id);\n`;
+function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'osi397-stage-'));fs.writeFileSync(path.join(root,'deploy.sh'),deploy);for(const dir of ['database/migrations/ordered','scripts/fixtures/lineages/agrolink','scripts/fixtures/lineages/bovey']){const p=path.join(root,dir);fs.mkdirSync(p,{recursive:true});writeFixture(p,{'0001__a.sql':sql('a'),'0003__c.sql':sql('c')});}fs.mkdirSync(path.join(root,'lib/osi-migrate'),{recursive:true});for(const name of ['migration-manifest.js','migrations-loader.js'])fs.copyFileSync(path.join(repo,'lib/osi-migrate',name),path.join(root,'lib/osi-migrate',name));return root;}
+const guard=deploy.slice(deploy.indexOf('check_fetched_manifest() {'),deploy.indexOf('\n# Fails, naming the file'));
+test('deploy manifest mode shares parser vectors before returning names',()=>{const root=fixture();try{const dir=path.join(root,'database/migrations/ordered');for(const v of vectors){fs.writeFileSync(path.join(dir,'CHECKSUMS.json'),v.raw);const p=spawnSync('sh',['-c',guard+'\ncheck_fetched_manifest manifest "$1" test-label','sh',dir],{env:{...process.env,TMP_DIR:root},encoding:'utf8'});assert.equal(p.status,v.valid?0:1,v.name+': '+p.stderr);if(!v.valid)assert.equal(p.stdout,'');}}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('source exact set and staged identity reject omitted and coherent replacements',()=>{const root=fixture(),stage=path.join(root,'stage');try{const original=collectCorpusIdentities(root);assert.ok(computeFetchList(root).includes('lib/osi-migrate/migration-manifest.js'));const dir=path.join(root,'database/migrations/ordered');fs.writeFileSync(path.join(dir,'0004__extra.sql'),sql('extra'));assert.throws(()=>computeFetchList(root),{code:'ERR_MIGRATION_CORPUS'});fs.unlinkSync(path.join(dir,'0004__extra.sql'));fs.mkdirSync(stage);for(const p of ['deploy.sh','database','scripts','lib'])fs.cpSync(path.join(root,p),path.join(stage,p),{recursive:true});const expected=path.join(root,'expected.json');fs.writeFileSync(expected,JSON.stringify(original));const cli=path.join(__dirname,'deploy-fetch-list.js');let p=spawnSync(process.execPath,[cli,stage,'--verify-corpus-identities',expected],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);writeFixture(path.join(stage,'database/migrations/ordered'),{'0001__a.sql':sql('coherent_changed')});p=spawnSync(process.execPath,[cli,stage,'--verify-corpus-identities',expected],{encoding:'utf8'});assert.equal(p.status,1);assert.match(p.stderr,/differs from accepted source/);assert.equal(p.stdout,'');}finally{fs.rmSync(root,{recursive:true,force:true});}});
diff --git a/scripts/deploy-fetch-list.js b/scripts/deploy-fetch-list.js
index fd57e169..7cfc6ed6 100644
--- a/scripts/deploy-fetch-list.js
+++ b/scripts/deploy-fetch-list.js
@@ -25,0 +26 @@ const path = require('node:path');
+const { loadMigrationCorpus } = require('../lib/osi-migrate/migrations-loader');
@@ -51,3 +52 @@ function findLineageFixtures(repoRoot, lineage) {
-  const checksumsPath = path.join(repoRoot, 'scripts/fixtures/lineages', lineage, 'CHECKSUMS.json');
-  const manifest = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
-  return Object.keys(manifest).sort();
+  return loadMigrationCorpus(path.join(repoRoot, 'scripts/fixtures/lineages', lineage)).migrations.map((m) => m.name);
@@ -75,5 +74 @@ function findMigrationFiles(repoRoot) {
-  const checksumsPath = path.join(repoRoot, 'database/migrations/ordered/CHECKSUMS.json');
-  const manifest = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
-  return Object.keys(manifest)
-    .sort()
-    .map((name) => `database/migrations/ordered/${name}`);
+  return loadMigrationCorpus(path.join(repoRoot, 'database/migrations/ordered')).migrations.map((m) => `database/migrations/ordered/${m.name}`);
@@ -196,2 +191,33 @@ function computeFetchList(repoRoot) {
-module.exports = { computeFetchList, extractCallSites, countCallSiteTokens };
-
+function collectCorpusIdentities(repoRoot) {
+  const text = fs.readFileSync(path.join(repoRoot, 'deploy.sh'), 'utf8');
+  const dirs = ['database/migrations/ordered', ...findForLoopList(text, 'lineage').map((n) => `scripts/fixtures/lineages/${n}`)];
+  return Object.fromEntries(dirs.sort().map((dir) => [dir, loadMigrationCorpus(path.join(repoRoot, dir)).identity]));
+}
+function parseCli(argv) {
+  const repoRoot = argv.length && !argv[0].startsWith('--') ? path.resolve(argv.shift()) : path.resolve(__dirname, '..');
+  const opts = { repoRoot, identitiesOut: null, verify: null };
+  while (argv.length) {
+    const flag = argv.shift(), value = argv.shift();
+    if (!value || value.startsWith('--')) throw new Error('missing value for ' + flag);
+    if (flag === '--corpus-identities-out' && !opts.identitiesOut) opts.identitiesOut = value;
+    else if (flag === '--verify-corpus-identities' && !opts.verify) opts.verify = value;
+    else throw new Error('unknown or repeated option: ' + flag);
+  }
+  if (opts.identitiesOut && opts.verify) throw new Error('choose one identity mode');
+  return opts;
+}
+function runCli(argv) {
+  const opts = parseCli([...argv]);
+  const identities = collectCorpusIdentities(opts.repoRoot);
+  if (opts.verify) {
+    const expected = JSON.parse(fs.readFileSync(opts.verify, 'utf8'));
+    if (!expected || Array.isArray(expected) || typeof expected !== 'object') throw new Error('invalid source identities');
+    const sorted = Object.fromEntries(Object.keys(expected).sort().map((k) => [k, expected[k]]));
+    if (JSON.stringify(sorted) !== JSON.stringify(identities)) throw new Error('staged migration corpus differs from accepted source identities');
+    return;
+  }
+  const list = computeFetchList(opts.repoRoot);
+  if (opts.identitiesOut) fs.writeFileSync(opts.identitiesOut, JSON.stringify(identities, null, 2) + '\n');
+  for (const name of list) console.log(name);
+}
+module.exports = { computeFetchList, extractCallSites, countCallSiteTokens, collectCorpusIdentities, parseCli, runCli };
@@ -199,3 +225,2 @@ if (require.main === module) {
-  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
-  const list = computeFetchList(repoRoot);
-  for (const p of list) console.log(p);
+  try { runCli(process.argv.slice(2)); }
+  catch (e) { console.error('deploy-fetch-list: ' + e.message); process.exit(1); }
diff --git a/scripts/fixtures/earlier-lineage-gateway-db.js b/scripts/fixtures/earlier-lineage-gateway-db.js
index 19f18cc0..62f6fd0f 100644
--- a/scripts/fixtures/earlier-lineage-gateway-db.js
+++ b/scripts/fixtures/earlier-lineage-gateway-db.js
@@ -41,12 +41,7 @@ function buildMigrationsDir(dir) {
-  const { loadMigrations } = require('../../lib/osi-migrate/migrations-loader');
-  fs.mkdirSync(dir, { recursive: true });
-  for (const m of loadMigrations(MAIN_MIGRATIONS_DIR)) {
-    if (m.version <= 21) fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(dir, m.name));
-  }
-  const lineageDir = lineageReaching49();
-  for (const name of fs.readdirSync(lineageDir).filter((f) => f.endsWith('.sql'))) {
-    if (Number(name.slice(0, 4)) <= 49) fs.copyFileSync(path.join(lineageDir, name), path.join(dir, name));
-  }
-  for (const [foreignName, mainName] of Object.entries(FOREIGN_TAIL)) {
-    fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, mainName), path.join(dir, foreignName));
-  }
+  const { loadMigrationCorpus, materializeMigrations } = require('../../lib/osi-migrate/migrations-loader');
+  const main = loadMigrationCorpus(MAIN_MIGRATIONS_DIR);
+  const lineage = loadMigrationCorpus(lineageReaching49());
+  const selections = main.migrations.filter((m) => m.version <= 21).map((m) => ({ corpus: main, name: m.name }));
+  selections.push(...lineage.migrations.filter((m) => m.version <= 49).map((m) => ({ corpus: lineage, name: m.name })));
+  selections.push(...Object.entries(FOREIGN_TAIL).map(([asName, name]) => ({ corpus: main, name, asName })));
+  materializeMigrations(dir, selections);
diff --git a/scripts/migrate-cli.js b/scripts/migrate-cli.js
index 96323b13..0c3e286f 100644
--- a/scripts/migrate-cli.js
+++ b/scripts/migrate-cli.js
@@ -11 +11 @@ const { applyPending } = require('../lib/osi-migrate');
-const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
+const { loadMigrationCorpus, resolveCorpus } = require('../lib/osi-migrate/migrations-loader');
@@ -43 +43,2 @@ function offDeviceBackup(dbPath, backupDir) {
-async function pendingRisksAfterApplied(dbPath, migrationsDir) {
+async function pendingRisksAfterApplied(dbPath, migrationsDir, corpus) {
+  corpus = resolveCorpus(migrationsDir, corpus);
@@ -49 +50 @@ async function pendingRisksAfterApplied(dbPath, migrationsDir) {
-  return loadMigrations(migrationsDir)
+  return corpus.migrations
@@ -101,0 +103 @@ async function runMigrateCli({
+  const corpus = loadMigrationCorpus(migrationsDir);
@@ -120 +122 @@ async function runMigrateCli({
-  const risks = await pendingRisksAfterApplied(dbPath, migrationsDir);
+  const risks = await pendingRisksAfterApplied(dbPath, migrationsDir, corpus);
@@ -137,0 +140 @@ async function runMigrateCli({
+      corpus,
diff --git a/scripts/migrate-cli.test.js b/scripts/migrate-cli.test.js
index 090996f2..91f53168 100644
--- a/scripts/migrate-cli.test.js
+++ b/scripts/migrate-cli.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -48 +49 @@ async function deviceAtVersion(dir, version) {
-      fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(sub, f));
+      fixtureCopy(path.join(MIGRATIONS_DIR, f), path.join(sub, f));
@@ -99 +100 @@ test('injected migration failure: byte-image restored, DB unchanged', async () =
-    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(poisoned, f));
+    fixtureCopy(path.join(MIGRATIONS_DIR, f), path.join(poisoned, f));
@@ -103 +104 @@ test('injected migration failure: byte-image restored, DB unchanged', async () =
-  fs.writeFileSync(path.join(poisoned, '0008__bad.sql'), bad);
+  fixtureWrite(path.join(poisoned, '0008__bad.sql'), bad);
@@ -109 +110 @@ test('injected migration failure: byte-image restored, DB unchanged', async () =
-  fs.writeFileSync(path.join(poisoned, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n');
+  fixtureWrite(path.join(poisoned, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n');
@@ -145 +146 @@ function writeStalePremigrateFiles(backupDir, dbBasename, stamps) {
-    fs.writeFileSync(path.join(backupDir, `${dbBasename}.premigrate-2020-01-${s}`), 'stale');
+    fixtureWrite(path.join(backupDir, `${dbBasename}.premigrate-2020-01-${s}`), 'stale');
@@ -163,2 +164,2 @@ async function deviceWithPendingDataMigration(dir) {
-  fs.writeFileSync(path.join(migDir, '0001__baseline.sql'), baseline);
-  fs.writeFileSync(path.join(migDir, '0002__addcol.sql'), pending);
+  fixtureWrite(path.join(migDir, '0001__baseline.sql'), baseline);
+  fixtureWrite(path.join(migDir, '0002__addcol.sql'), pending);
@@ -169 +170 @@ async function deviceWithPendingDataMigration(dir) {
-  fs.writeFileSync(path.join(migDir, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n');
+  fixtureWrite(path.join(migDir, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n');
@@ -173,2 +174,2 @@ async function deviceWithPendingDataMigration(dir) {
-  fs.copyFileSync(path.join(migDir, '0001__baseline.sql'), path.join(sub, '0001__baseline.sql'));
-  fs.writeFileSync(
+  fixtureCopy(path.join(migDir, '0001__baseline.sql'), path.join(sub, '0001__baseline.sql'));
+  fixtureWrite(
@@ -229,2 +230,2 @@ test('retention: runs on the !needsBackup (additive-only) path too, with no new
-  fs.writeFileSync(path.join(migDir, '0001__baseline.sql'), baseline);
-  fs.writeFileSync(
+  fixtureWrite(path.join(migDir, '0001__baseline.sql'), baseline);
+  fixtureWrite(
@@ -291 +292 @@ test('deploy prune step: side files do not count as backups (default keep 3)', (
-  fs.writeFileSync(db, 'live');
+  fixtureWrite(db, 'live');
@@ -298 +299 @@ test('deploy prune step: side files do not count as backups (default keep 3)', (
-  for (const n of names) fs.writeFileSync(path.join(backupDir, n), 'b');
+  for (const n of names) fixtureWrite(path.join(backupDir, n), 'b');
@@ -313 +314 @@ test('deploy prune step: side files do not count as backups (default keep 3)', (
-  fs.writeFileSync(path.join(backupDir, fourth), 'b');
+  fixtureWrite(path.join(backupDir, fourth), 'b');
diff --git a/scripts/migration-caller-corpus.test.js b/scripts/migration-caller-corpus.test.js
new file mode 100644
index 00000000..e989bd28
--- /dev/null
+++ b/scripts/migration-caller-corpus.test.js
@@ -0,0 +1,17 @@
+'use strict';
+const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
+const {writeFixture}=require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
+const {loadMigrationCorpus}=require('../lib/osi-migrate/migrations-loader');
+const {cliRunner}=require('../lib/osi-migrate/runner-iface');
+const {buildReference,runBaseline}=require('./baseline-existing-db');
+const {runMigrateCli}=require('./migrate-cli');
+const {runReconcile,clearRepairRequired,verifyReconciliationConsistency}=require('./reconcile-ledger-numbering');
+const sql=t=>`-- risk: additive\nCREATE TABLE ${t}(id INTEGER PRIMARY KEY);\n`;
+function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'osi397-callers-')),dir=path.join(root,'m');fs.mkdirSync(dir);writeFixture(dir,{'0001__a.sql':sql('a'),'0003__c.sql':sql('c')});return{root,dir,db:path.join(root,'t.db'),backupDir:path.join(root,'backups')};}
+test('direct reference cache validates whole corpus and keys valid replacements',async()=>{const{root,dir}=fixture();try{const one=await buildReference(dir,1,root);assert.equal((await cliRunner(one).all("SELECT name FROM sqlite_master WHERE name='a'")).length,1);await assert.rejects(()=>buildReference(dir,2,root),/no migration file/);fs.appendFileSync(path.join(dir,'0003__c.sql'),'-- stale');await assert.rejects(()=>buildReference(dir,1,root),{code:'ERR_MIGRATION_CORPUS'});writeFixture(dir,{'0003__c.sql':sql('c'),'0001__a.sql':sql('replacement')});const two=await buildReference(dir,1,root);assert.notEqual(two,one);assert.equal((await cliRunner(two).all("SELECT name FROM sqlite_master WHERE name='replacement'")).length,1);}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('reference chain retry restores published DB under the same corpus',async()=>{const{root,dir}=fixture();try{let failed=false;const factory=db=>{const r=cliRunner(db),exec=r.exec.bind(r);r.exec=async text=>{if(!failed&&text.includes('CREATE TABLE c(')){failed=true;throw new Error('transient-test-failure');}return exec(text);};return r;};await buildReference(dir,1,root,{runnerFactory:factory});await assert.rejects(()=>buildReference(dir,3,root,{runnerFactory:factory}),/transient-test-failure/);const final=await buildReference(dir,3,root,{runnerFactory:factory});assert.equal((await cliRunner(final).all("SELECT name FROM sqlite_master WHERE name='c'")).length,1);}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('CLI accepted risk decision and apply share bytes; invalid prune does nothing',async()=>{const{root,dir,db,backupDir}=fixture();try{await cliRunner(db).exec('PRAGMA user_version=0;');let changed=false;const result=await runMigrateCli({dbPath:db,migrationsDir:dir,backupDir,log:()=>{if(!changed){changed=true;writeFixture(dir,{'0003__c.sql':'-- risk: data\nCREATE TABLE changed(id);\n'});}}});assert.equal(result.offDeviceBackup,null);assert.equal((await cliRunner(db).all("SELECT name FROM sqlite_master WHERE name='c'")).length,1);assert.equal((await cliRunner(db).all("SELECT name FROM sqlite_master WHERE name='changed'")).length,0);const marker=path.join(backupDir,'t.db.premigrate-2000');fs.writeFileSync(marker,'keep');fs.appendFileSync(path.join(dir,'0001__a.sql'),'-- stale');await assert.rejects(()=>runMigrateCli({dbPath:db,migrationsDir:dir,backupDir,pruneOnly:true}),{code:'ERR_MIGRATION_CORPUS'});assert.equal(fs.readFileSync(marker,'utf8'),'keep');}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('invalid main blocks baseline, reconciliation and clear before bookkeeping',async()=>{const{root,dir,db,backupDir}=fixture();try{await cliRunner(db).exec('PRAGMA user_version=0;');const bytes=fs.readFileSync(db);fs.unlinkSync(path.join(dir,'0003__c.sql'));for(const fn of [()=>runBaseline({dbPath:db,migrationsDir:dir}),()=>runReconcile({dbPath:db,migrationsDir:dir,fixturesDir:root,backupDir,apply:true,writersStopped:true}),()=>clearRepairRequired({dbPath:db,migrationsDir:dir,backupDir,writersStopped:true}),()=>verifyReconciliationConsistency({all:async()=>assert.fail('DB touched')},{migrationsDir:dir})])await assert.rejects(fn,{code:'ERR_MIGRATION_CORPUS'});assert.deepEqual(fs.readFileSync(db),bytes);assert.equal(fs.existsSync(backupDir),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
+test('clear consumes main only; invalid lineage blocks reconcile without touching target',async()=>{const{root,dir,db}=fixture();try{const R=require('../lib/osi-migrate');await R.bootstrapFresh(cliRunner(db),{migrationsDir:dir,appVersion:'test'});assert.deepEqual(await clearRepairRequired({dbPath:db,migrationsDir:dir,log:()=>{}}),{cleared:0,stillWedged:[]});const fixtures=path.join(root,'lineages');fs.mkdirSync(fixtures);fs.mkdirSync(path.join(fixtures,'bad'));fs.writeFileSync(path.join(fixtures,'bad','0099__bad.sql'),sql('bad'));const bytes=fs.readFileSync(db);await assert.rejects(()=>runReconcile({dbPath:db,migrationsDir:dir,fixturesDir:fixtures}),{code:'ERR_MIGRATION_CORPUS'});assert.deepEqual(fs.readFileSync(db),bytes);}finally{fs.rmSync(root,{recursive:true,force:true});}});
+
+test('empty registry containers consume no corpus; SQL without manifest still refuses',()=>{const{root}=fixture();try{const{buildLineageRegistry}=require('./reconcile-ledger-numbering');assert.equal(buildLineageRegistry(path.join(root,'missing')).byChecksum.size,0);const dir=path.join(root,'registry');fs.mkdirSync(dir);fs.mkdirSync(path.join(dir,'empty'));assert.equal(buildLineageRegistry(dir).byChecksum.size,0);fs.writeFileSync(path.join(dir,'empty','0001__a.sql'),sql('a'));assert.throws(()=>buildLineageRegistry(dir),{code:'ERR_MIGRATION_CORPUS'});}finally{fs.rmSync(root,{recursive:true,force:true});}});
diff --git a/scripts/ops/generate-uganda-schema-rebuild-20260911.js b/scripts/ops/generate-uganda-schema-rebuild-20260911.js
index 8ed7ead3..d4e77e85 100644
--- a/scripts/ops/generate-uganda-schema-rebuild-20260911.js
+++ b/scripts/ops/generate-uganda-schema-rebuild-20260911.js
@@ -41,0 +42 @@ const { bootstrapFresh } = require('../../lib/osi-migrate');
+const { resolveCorpus, materializeMigrations } = require('../../lib/osi-migrate/migrations-loader');
@@ -127 +128,2 @@ function renameCreateTable(createSql, oldName, newName) {
-async function buildReference1(scratchRoot) {
+async function buildReference1(scratchRoot, corpus) {
+  corpus = resolveCorpus(path.dirname(SOURCE_MIGRATION), corpus);
@@ -130,2 +132 @@ async function buildReference1(scratchRoot) {
-  fs.mkdirSync(subset);
-  fs.copyFileSync(SOURCE_MIGRATION, path.join(subset, path.basename(SOURCE_MIGRATION)));
+  const selected = materializeMigrations(subset, [{ corpus, name: '0001__baseline.sql' }]);
@@ -133 +134 @@ async function buildReference1(scratchRoot) {
-  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, appVersion: 'uganda-rebuild-ref1' });
+  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, corpus: selected, appVersion: 'uganda-rebuild-ref1' });
@@ -175,2 +176,5 @@ function buildRebuildBlock({
-async function generate() {
-  const src = fs.readFileSync(SOURCE_MIGRATION, 'utf8');
+async function generate({ corpus } = {}) {
+  corpus = resolveCorpus(path.dirname(SOURCE_MIGRATION), corpus);
+  const baseline = corpus.migrations.find((m) => m.name === '0001__baseline.sql');
+  if (!baseline) throw new Error('rebuild source requires 0001__baseline.sql');
+  const src = baseline.sql;
@@ -194 +198 @@ async function generate() {
-  const ref1Path = await buildReference1(scratchRoot);
+  const ref1Path = await buildReference1(scratchRoot, corpus);
@@ -355 +359,2 @@ async function generate() {
-async function referenceCompare(dbPath) {
+async function referenceCompare(dbPath, corpus) {
+  corpus = resolveCorpus(path.dirname(SOURCE_MIGRATION), corpus);
@@ -357 +362 @@ async function referenceCompare(dbPath) {
-  const ref1Path = await buildReference1(scratchRoot);
+  const ref1Path = await buildReference1(scratchRoot, corpus);
@@ -404 +409,2 @@ function scopedFailingDiffs(cmp, relatedNames) {
-async function preflightDriftSignature(dbPath, log) {
+async function preflightDriftSignature(dbPath, log = console.error, corpus) {
+  corpus = resolveCorpus(path.dirname(SOURCE_MIGRATION), corpus);
@@ -406 +412 @@ async function preflightDriftSignature(dbPath, log) {
-  const ref1Path = await buildReference1(scratchRoot);
+  const ref1Path = await buildReference1(scratchRoot, corpus);
@@ -410 +416 @@ async function preflightDriftSignature(dbPath, log) {
-  const cmp = await referenceCompare(dbPath);
+  const cmp = await referenceCompare(dbPath, corpus);
@@ -492 +498,2 @@ function parseArtifactBlocks(sql) {
-async function dryRun(dbPath, log = console.error) {
+async function dryRun(dbPath, log = console.error, corpus) {
+  corpus = resolveCorpus(path.dirname(SOURCE_MIGRATION), corpus);
@@ -495 +502 @@ async function dryRun(dbPath, log = console.error) {
-  const { scoped } = await preflightDriftSignature(dbPath, log);
+  const { scoped } = await preflightDriftSignature(dbPath, log, corpus);
@@ -507 +514,2 @@ async function dryRun(dbPath, log = console.error) {
-async function apply(dbPath, log = console.error) {
+async function apply(dbPath, log = console.error, corpus) {
+  corpus = resolveCorpus(path.dirname(SOURCE_MIGRATION), corpus);
@@ -510 +518 @@ async function apply(dbPath, log = console.error) {
-  const { scoped } = await preflightDriftSignature(dbPath, log);
+  const { scoped } = await preflightDriftSignature(dbPath, log, corpus);
@@ -575 +583,2 @@ async function apply(dbPath, log = console.error) {
-async function verify(dbPath, log = console.error) {
+async function verify(dbPath, log = console.error, corpus) {
+  corpus = resolveCorpus(path.dirname(SOURCE_MIGRATION), corpus);
@@ -578 +587 @@ async function verify(dbPath, log = console.error) {
-  const ref1Path = await buildReference1(scratchRoot);
+  const ref1Path = await buildReference1(scratchRoot, corpus);
@@ -581 +590 @@ async function verify(dbPath, log = console.error) {
-  const cmp = await referenceCompare(dbPath);
+  const cmp = await referenceCompare(dbPath, corpus);
diff --git a/scripts/ops/generate-uganda-schema-rebuild-20260911.test.js b/scripts/ops/generate-uganda-schema-rebuild-20260911.test.js
index c473ffab..e5f5e0a6 100644
--- a/scripts/ops/generate-uganda-schema-rebuild-20260911.test.js
+++ b/scripts/ops/generate-uganda-schema-rebuild-20260911.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('../../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -39 +40 @@ function ref1MigrationsDir() {
-  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001__baseline.sql'), path.join(dir, '0001__baseline.sql'));
+  fixtureCopy(path.join(MIGRATIONS_DIR, '0001__baseline.sql'), path.join(dir, '0001__baseline.sql'));
diff --git a/scripts/ops/rebuild-corpus.test.js b/scripts/ops/rebuild-corpus.test.js
new file mode 100644
index 00000000..e2ab82be
--- /dev/null
+++ b/scripts/ops/rebuild-corpus.test.js
@@ -0,0 +1,8 @@
+'use strict';
+const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
+const {loadMigrationCorpus,materializeMigrations}=require('../../lib/osi-migrate/migrations-loader');
+const repo=path.resolve(__dirname,'../..');
+const oldDefault='chameleon_enabled                     INTEGER DEFAULT 0,',changedDefault='chameleon_enabled                     INTEGER DEFAULT 1,';
+function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'osi397-generator-'));fs.cpSync(path.join(repo,'lib'),path.join(root,'lib'),{recursive:true});fs.mkdirSync(path.join(root,'scripts/ops'),{recursive:true});for(const name of ['semantic-schema-compare.js'])fs.copyFileSync(path.join(repo,'scripts',name),path.join(root,'scripts',name));fs.copyFileSync(path.join(__dirname,'generate-uganda-schema-rebuild-20260911.js'),path.join(root,'scripts/ops/generate-uganda-schema-rebuild-20260911.js'));const dir=path.join(root,'database/migrations/ordered');fs.mkdirSync(path.dirname(dir),{recursive:true});const parent=loadMigrationCorpus(path.join(repo,'database/migrations/ordered'));materializeMigrations(dir,[{corpus:parent,name:'0001__baseline.sql'}]);const file=path.join(dir,'0001__baseline.sql'),raw=fs.readFileSync(file);assert.ok(raw.toString().includes(oldDefault));const G=require(path.join(root,'scripts/ops/generate-uganda-schema-rebuild-20260911'));const L=require(path.join(root,'lib/osi-migrate/migrations-loader'));return{root,dir,file,raw,G,L};}
+test('generator rejects prevalidation bytes even if a legacy path-read hook restores source',async()=>{const{root,file,raw,G,L,dir}=fixture();const read=fs.readFileSync;try{await G.generate();const stable=fs.readFileSync(G.ARTIFACT_PATH);assert.ok(stable.toString().includes(oldDefault));fs.writeFileSync(file,raw.toString().replace(oldDefault,changedDefault));assert.throws(()=>L.loadMigrationCorpus(dir),{code:'ERR_MIGRATION_CORPUS'});let hooked=false;fs.readFileSync=function(...args){const bytes=read.apply(this,args);if(args[0]===file&&args[1]==='utf8'){hooked=true;fs.writeFileSync(file,raw);}return bytes;};await assert.rejects(()=>G.generate(),{code:'ERR_MIGRATION_CORPUS'});assert.equal(hooked,false,'extraction must never reopen SOURCE_MIGRATION');assert.deepEqual(read(G.ARTIFACT_PATH),stable);}finally{fs.readFileSync=read;fs.rmSync(root,{recursive:true,force:true});}});
+test('generate and repeated verification references retain the accepted source',async()=>{const{root,file,raw,G,L,dir}=fixture();const mk=fs.mkdtempSync;try{let changed=false;fs.mkdtempSync=function(...args){const p=mk.apply(this,args);if(!changed&&String(args[0]).includes('uganda-rebuild-gen-')){changed=true;fs.writeFileSync(file,raw.toString().replace(oldDefault,changedDefault));}return p;};await G.generate();assert.equal(changed,true);assert.ok(fs.readFileSync(G.ARTIFACT_PATH,'utf8').includes(oldDefault));assert.throws(()=>L.loadMigrationCorpus(dir),{code:'ERR_MIGRATION_CORPUS'});fs.mkdtempSync=mk;fs.writeFileSync(file,raw);const corpus=L.loadMigrationCorpus(dir),db=path.join(root,'valid.db');await require(path.join(root,'lib/osi-migrate')).bootstrapFresh(require(path.join(root,'lib/osi-migrate/runner-iface')).cliRunner(db),{migrationsDir:dir,corpus,appVersion:'generator-test'});let switched=false;fs.mkdtempSync=function(...args){const p=mk.apply(this,args);if(!switched&&String(args[0]).includes('uganda-rebuild-cmp-')){switched=true;fs.writeFileSync(file,raw.toString().replace(oldDefault,changedDefault));}return p;};assert.equal(await G.verify(db,()=>{}),true);assert.equal(switched,true);fs.mkdtempSync=mk;fs.writeFileSync(file,raw);assert.deepEqual((await G.preflightDriftSignature(db,()=>{})).scoped,[]);await G.dryRun(db,()=>{});assert.deepEqual(await G.apply(db,()=>{}),{ran:[]});}finally{fs.mkdtempSync=mk;fs.rmSync(root,{recursive:true,force:true});}});
diff --git a/scripts/ops/uganda-schema-audit.js b/scripts/ops/uganda-schema-audit.js
index f812e207..177531ec 100644
--- a/scripts/ops/uganda-schema-audit.js
+++ b/scripts/ops/uganda-schema-audit.js
@@ -23,0 +24 @@ const { bootstrapFresh } = require('../../lib/osi-migrate');
+const { resolveCorpus, loadMigrationCorpus, materializeMigrations } = require('../../lib/osi-migrate/migrations-loader');
@@ -89 +90,2 @@ function sha256File(p) {
-async function buildReference1(scratchRoot) {
+async function buildReference1(scratchRoot, migrationsDir, corpus) {
+  corpus = resolveCorpus(migrationsDir, corpus);
@@ -92,2 +94 @@ async function buildReference1(scratchRoot) {
-  fs.mkdirSync(subset);
-  fs.copyFileSync(SOURCE_MIGRATION, path.join(subset, path.basename(SOURCE_MIGRATION)));
+  const selected = materializeMigrations(subset, [{ corpus, name: '0001__baseline.sql' }]);
@@ -95 +96 @@ async function buildReference1(scratchRoot) {
-  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, appVersion: 'uganda-audit-ref1' });
+  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, corpus: selected, appVersion: 'uganda-audit-ref1' });
@@ -154,0 +156 @@ async function runAudit({ dbPath, migrationsDir = DEFAULT_MIGRATIONS_DIR, log =
+  const corpus = loadMigrationCorpus(migrationsDir);
@@ -158 +160 @@ async function runAudit({ dbPath, migrationsDir = DEFAULT_MIGRATIONS_DIR, log =
-  const ref1Path = await buildReference1(scratchRoot);
+  const ref1Path = await buildReference1(scratchRoot, migrationsDir, corpus);
@@ -207 +209 @@ async function runAudit({ dbPath, migrationsDir = DEFAULT_MIGRATIONS_DIR, log =
-    referenceMigration: path.relative(REPO, SOURCE_MIGRATION),
+    referenceMigration: path.relative(REPO, path.join(corpus.dir, '0001__baseline.sql')),
diff --git a/scripts/ops/uganda-schema-audit.test.js b/scripts/ops/uganda-schema-audit.test.js
index c4f30d25..e0d0c7f5 100644
--- a/scripts/ops/uganda-schema-audit.test.js
+++ b/scripts/ops/uganda-schema-audit.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('../../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -28 +29 @@ function ref1MigrationsDir() {
-  fs.copyFileSync(path.join(MIGRATIONS_DIR, '0001__baseline.sql'), path.join(dir, '0001__baseline.sql'));
+  fixtureCopy(path.join(MIGRATIONS_DIR, '0001__baseline.sql'), path.join(dir, '0001__baseline.sql'));
diff --git a/scripts/reconcile-ledger-numbering.js b/scripts/reconcile-ledger-numbering.js
index e2eaf7ad..4bd4a890 100644
--- a/scripts/reconcile-ledger-numbering.js
+++ b/scripts/reconcile-ledger-numbering.js
@@ -78 +78 @@ const { cliRunner } = require('../lib/osi-migrate/runner-iface');
-const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
+const { resolveCorpus, loadMigrationCorpus } = require('../lib/osi-migrate/migrations-loader');
@@ -114,2 +114,3 @@ function headerStrippedChecksum(sql) {
-function buildMainIndex(migrationsDir) {
-  const migrations = loadMigrations(migrationsDir);
+function buildMainIndex(migrationsDir, corpus) {
+  corpus = resolveCorpus(migrationsDir, corpus);
+  const migrations = corpus.migrations;
@@ -127 +128 @@ function buildMainIndex(migrationsDir) {
-  return { migrations, byChecksum, byVersion, byHeaderStrippedChecksum };
+  return { corpus, migrations, byChecksum, byVersion, byHeaderStrippedChecksum };
@@ -137,3 +138,5 @@ function buildLineageRegistry(fixturesDir) {
-  const byChecksum = new Map();
-  const lineages = {};
-  if (!fs.existsSync(fixturesDir)) return { byChecksum, lineages };
+  const byChecksum = new Map(), lineages = {}, corpora = new Map();
+  let root;
+  try { root = fs.lstatSync(fixturesDir); }
+  catch (e) { if (e.code === 'ENOENT') return { byChecksum, lineages, corpora }; throw e; }
+  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('lineage root must be a nonsymlink directory');
@@ -141,20 +144,11 @@ function buildLineageRegistry(fixturesDir) {
-    const dir = path.join(fixturesDir, lineage);
-    if (!fs.statSync(dir).isDirectory()) continue;
-    const manifestPath = path.join(dir, 'CHECKSUMS.json');
-    if (!fs.existsSync(manifestPath)) continue;
-    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
-    const migrations = loadMigrations(dir);
-    for (const m of migrations) {
-      if (manifest[m.name] !== m.checksum) {
-        throw new Error(
-          `lineage fixture drift: ${lineage}/${m.name} does not match ${lineage}/CHECKSUMS.json — refusing to build the lineage registry`
-        );
-      }
-      byChecksum.set(m.checksum, { ...m, lineage });
-    }
-    for (const filename of Object.keys(manifest)) {
-      if (!migrations.some((m) => m.name === filename)) {
-        throw new Error(`lineage fixture manifest ${lineage}/CHECKSUMS.json names ${filename}, which is missing on disk`);
-      }
-    }
-    lineages[lineage] = migrations.map((m) => m.name);
+    const dir = path.join(fixturesDir, lineage), stat = fs.lstatSync(dir);
+    if (stat.isSymbolicLink()) throw new Error('lineage symlink refused: ' + lineage);
+    if (!stat.isDirectory()) continue;
+    const names = fs.readdirSync(dir);
+    // A missing/empty registry container supplies no corpus. Any SQL or
+    // manifest makes this a consumed corpus and requires strict loading.
+    if (!names.includes('CHECKSUMS.json') && !names.some((n) => n.endsWith('.sql'))) continue;
+    const corpus = loadMigrationCorpus(dir);
+    corpora.set(lineage, corpus);
+    for (const m of corpus.migrations) byChecksum.set(m.checksum, { ...m, lineage });
+    lineages[lineage] = corpus.migrations.map((m) => m.name);
@@ -162 +156 @@ function buildLineageRegistry(fixturesDir) {
-  return { byChecksum, lineages };
+  return { byChecksum, lineages, corpora };
@@ -165,2 +158,0 @@ function buildLineageRegistry(fixturesDir) {
-// --- ledger read ---------------------------------------------------------
-
@@ -315 +307,2 @@ function getReferenceScratchRoot() {
-async function buildReferenceAt(migrationsDir, n) {
+async function buildReferenceAt(migrationsDir, n, corpus) {
+  corpus = resolveCorpus(migrationsDir, corpus);
@@ -322 +315 @@ async function buildReferenceAt(migrationsDir, n) {
-  const presentAtOrBelow = loadMigrations(migrationsDir)
+  const presentAtOrBelow = corpus.migrations
@@ -331 +324 @@ async function buildReferenceAt(migrationsDir, n) {
-  return buildReference(migrationsDir, resolvedN, refRoot);
+  return buildReference(migrationsDir, resolvedN, refRoot, { corpus });
@@ -340 +333,2 @@ async function buildReferenceAt(migrationsDir, n) {
-async function resolveStructuralProofs(rows, { migrationsDir, scratchRoot }) {
+async function resolveStructuralProofs(rows, { migrationsDir, scratchRoot, corpus }) {
+  corpus = resolveCorpus(migrationsDir, corpus);
@@ -343 +337 @@ async function resolveStructuralProofs(rows, { migrationsDir, scratchRoot }) {
-    const refDbPath = await buildReferenceAt(migrationsDir, r.target.version - 1);
+    const refDbPath = await buildReferenceAt(migrationsDir, r.target.version - 1, corpus);
@@ -376 +370 @@ async function classifyLedger(ledgerRows, { mainIndex, lineageRegistry, migratio
-  rows = await resolveStructuralProofs(rows, { migrationsDir, scratchRoot });
+  rows = await resolveStructuralProofs(rows, { migrationsDir, scratchRoot, corpus: mainIndex.corpus });
@@ -415 +409,2 @@ async function classifyLedger(ledgerRows, { mainIndex, lineageRegistry, migratio
-async function verifyReconciliationConsistency(runner, { migrationsDir }) {
+async function verifyReconciliationConsistency(runner, { migrationsDir, corpus }) {
+  const mainByVersion = buildMainIndex(migrationsDir, corpus).byVersion;
@@ -417 +411,0 @@ async function verifyReconciliationConsistency(runner, { migrationsDir }) {
-  const mainByVersion = buildMainIndex(migrationsDir).byVersion;
@@ -487,2 +480,0 @@ async function runReconcile({
-    const runner = cliRunner(dbPath);
-    const ledgerRows = await readLedgerRows(runner);
@@ -490,0 +483,2 @@ async function runReconcile({
+    const runner = cliRunner(dbPath);
+    const ledgerRows = await readLedgerRows(runner);
@@ -524 +518 @@ async function runReconcile({
-    const check = await verifyReconciliationConsistency(runner, { migrationsDir });
+    const check = await verifyReconciliationConsistency(runner, { migrationsDir, corpus: mainIndex.corpus });
@@ -563,0 +558 @@ async function clearRepairRequired({
+  const mainIndex = buildMainIndex(migrationsDir);
@@ -566 +560,0 @@ async function clearRepairRequired({
-  const mainIndex = buildMainIndex(migrationsDir);
@@ -600 +594 @@ async function clearRepairRequired({
-  const check = await verifyReconciliationConsistency(runner, { migrationsDir });
+  const check = await verifyReconciliationConsistency(runner, { migrationsDir, corpus: mainIndex.corpus });
diff --git a/scripts/reconcile-ledger-numbering.test.js b/scripts/reconcile-ledger-numbering.test.js
index 7cafa924..ac8749be 100644
--- a/scripts/reconcile-ledger-numbering.test.js
+++ b/scripts/reconcile-ledger-numbering.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -36 +37 @@ function writeMigration(dir, filename, body) {
-  fs.writeFileSync(path.join(dir, filename), body);
+  fixtureWrite(path.join(dir, filename), body);
@@ -92 +93 @@ test('buildLineageRegistry loads a vendored fixture dir and tags entries by line
-  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify({ '0099__acme_thing.sql': sha(Buffer.from(body)) }));
+  fixtureWrite(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify({ '0099__acme_thing.sql': sha(Buffer.from(body)) }));
@@ -107 +108 @@ test('buildLineageRegistry refuses (throws) when a vendored file has drifted fro
-  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify({ '0099__acme_thing.sql': 'f'.repeat(64) }));
+  fixtureWrite(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify({ '0099__acme_thing.sql': 'f'.repeat(64) }));
@@ -109 +110 @@ test('buildLineageRegistry refuses (throws) when a vendored file has drifted fro
-  assert.throws(() => buildLineageRegistry(fixturesDir), /drift/);
+  assert.throws(() => buildLineageRegistry(fixturesDir), /migration corpus: checksum mismatch for 0099__acme_thing\.sql/);
@@ -272 +273 @@ test('structural proof: a mutated header-only candidate with a differing DDL bod
-  fs.writeFileSync(path.join(lineageDir, '0099__widget.sql'), mutatedSql);
+  fixtureWrite(path.join(lineageDir, '0099__widget.sql'), mutatedSql);
@@ -274 +275 @@ test('structural proof: a mutated header-only candidate with a differing DDL bod
-  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));
+  fixtureWrite(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));
@@ -302 +303 @@ test('structural proof: identical schema effect from the same pre-state passes a
-  fs.writeFileSync(path.join(lineageDir, '0077__gadget.sql'), foreignSql);
+  fixtureWrite(path.join(lineageDir, '0077__gadget.sql'), foreignSql);
@@ -304 +305 @@ test('structural proof: identical schema effect from the same pre-state passes a
-  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));
+  fixtureWrite(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));
@@ -347 +348 @@ test('reconcile across a migrations-dir version gap: header-stripped match, stru
-  fs.writeFileSync(path.join(lineageDir, '0003__gadget.sql'), oldHeaderSql);
+  fixtureWrite(path.join(lineageDir, '0003__gadget.sql'), oldHeaderSql);
@@ -349 +350 @@ test('reconcile across a migrations-dir version gap: header-stripped match, stru
-  fs.writeFileSync(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));
+  fixtureWrite(path.join(lineageDir, 'CHECKSUMS.json'), JSON.stringify(manifest));
@@ -357,2 +358,2 @@ test('reconcile across a migrations-dir version gap: header-stripped match, stru
-  fs.copyFileSync(path.join(dir, '0001__base.sql'), path.join(deviceDir, '0001__base.sql'));
-  fs.copyFileSync(path.join(dir, '0002__widget.sql'), path.join(deviceDir, '0002__widget.sql'));
+  fixtureCopy(path.join(dir, '0001__base.sql'), path.join(deviceDir, '0001__base.sql'));
+  fixtureCopy(path.join(dir, '0002__widget.sql'), path.join(deviceDir, '0002__widget.sql'));
@@ -592 +593 @@ function buildDeviceMigrationsDir(root, lineage, throughVersion, extra = {}) {
-    if (m.version <= 21) fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(dir, m.name));
+    if (m.version <= 21) fixtureCopy(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(dir, m.name));
@@ -597 +598 @@ function buildDeviceMigrationsDir(root, lineage, throughVersion, extra = {}) {
-    if (version <= throughVersion) fs.copyFileSync(path.join(lineageDir, name), path.join(dir, name));
+    if (version <= throughVersion) fixtureCopy(path.join(lineageDir, name), path.join(dir, name));
@@ -600 +601 @@ function buildDeviceMigrationsDir(root, lineage, throughVersion, extra = {}) {
-    fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, mainName), path.join(dir, foreignName));
+    fixtureCopy(path.join(MAIN_MIGRATIONS_DIR, mainName), path.join(dir, foreignName));
@@ -843 +844 @@ test('main-numbered device: reconcile is an all-match no-op report (fast path pr
-    if (m.version <= 25) fs.copyFileSync(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(partialDir, m.name));
+    if (m.version <= 25) fixtureCopy(path.join(MAIN_MIGRATIONS_DIR, m.name), path.join(partialDir, m.name));
diff --git a/scripts/rehearse-devices-type-migration.test.js b/scripts/rehearse-devices-type-migration.test.js
index d49918ab..d8706eaf 100644
--- a/scripts/rehearse-devices-type-migration.test.js
+++ b/scripts/rehearse-devices-type-migration.test.js
@@ -2,0 +3 @@
+const { fixtureWrite, fixtureCopy } = require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -166 +167 @@ function subsetDir(upTo, scratch) {
-      fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
+      fixtureCopy(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
diff --git a/scripts/restamp-fingerprints.test.js b/scripts/restamp-fingerprints.test.js
index 1fbae01c..cbede897 100644
--- a/scripts/restamp-fingerprints.test.js
+++ b/scripts/restamp-fingerprints.test.js
@@ -1,0 +2 @@
+const { writeFixture } = require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -20 +21 @@ test('restamp-fingerprints re-baselines a stale stamp', async () => {
-  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
+  writeFixture(dir, { '0001__b.sql': Buffer.from('-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n') });
@@ -52 +53 @@ test('restamp-fingerprints --report: no diffs -> exit 0, never writes', async ()
-  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
+  writeFixture(dir, { '0001__b.sql': Buffer.from('-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n') });
@@ -67 +68 @@ test('restamp-fingerprints --report: real drift -> exit non-zero, never writes',
-  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
+  writeFixture(dir, { '0001__b.sql': Buffer.from('-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n') });
@@ -87 +88 @@ test('restamp-fingerprints --report: pure normalizer-scheme bump only -> exit 0,
-  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
+  writeFixture(dir, { '0001__b.sql': Buffer.from('-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n') });
@@ -108 +109 @@ test('restamp-fingerprints default (no flags) and --apply both remain backward-c
-  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
+  writeFixture(dir, { '0001__b.sql': Buffer.from('-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n') });
diff --git a/scripts/soak/scenario-kill9-migration.js b/scripts/soak/scenario-kill9-migration.js
index 20e92ab4..fcc9baf1 100644
--- a/scripts/soak/scenario-kill9-migration.js
+++ b/scripts/soak/scenario-kill9-migration.js
@@ -8,0 +9 @@ const { applyPending, verifyHead } = require('../../lib/osi-migrate');
+const crypto = require('node:crypto');
@@ -12,2 +13,10 @@ function seedMigrationsDir(dir) {
-  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
-  fs.writeFileSync(path.join(dir, '0002__addcol.sql'), '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n');
+  const files = {
+    '0001__base.sql': Buffer.from('-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n'),
+    '0002__addcol.sql': Buffer.from('-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n'),
+  };
+  const expected = {};
+  for (const [name, raw] of Object.entries(files)) {
+    fs.writeFileSync(path.join(dir, name), raw);
+    expected[name] = crypto.createHash('sha256').update(raw).digest('hex');
+  }
+  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), JSON.stringify(expected) + '\n');
diff --git a/scripts/soak/scenario-kill9-migration.test.js b/scripts/soak/scenario-kill9-migration.test.js
index bc51012d..0a55a8af 100644
--- a/scripts/soak/scenario-kill9-migration.test.js
+++ b/scripts/soak/scenario-kill9-migration.test.js
@@ -1,0 +2 @@
+const { fixtureWrite } = require('../../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -18 +19 @@ async function buildKilledCopy() {
-  fs.writeFileSync(path.join(dir, '0001__base.sql'), MIG_0001);
+  fixtureWrite(path.join(dir, '0001__base.sql'), MIG_0001);
@@ -20 +21 @@ async function buildKilledCopy() {
-  fs.writeFileSync(db, '');
+  fixtureWrite(db, '');
@@ -22 +23 @@ async function buildKilledCopy() {
-  fs.writeFileSync(path.join(dir, '0002__addcol.sql'), MIG_0002);
+  fixtureWrite(path.join(dir, '0002__addcol.sql'), MIG_0002);
@@ -28 +29 @@ test('recover-from-backup path: a good backup passes integrity_check and restore
-  fs.writeFileSync(path.join(dir, '0001__base.sql'), MIG_0001);
+  fixtureWrite(path.join(dir, '0001__base.sql'), MIG_0001);
@@ -30 +31 @@ test('recover-from-backup path: a good backup passes integrity_check and restore
-  fs.writeFileSync(db, '');
+  fixtureWrite(db, '');
diff --git a/scripts/test-deploy-migration-wiring.js b/scripts/test-deploy-migration-wiring.js
index e856df50..93cf18bd 100644
--- a/scripts/test-deploy-migration-wiring.js
+++ b/scripts/test-deploy-migration-wiring.js
@@ -30 +30,4 @@ test('deploy migration wiring fetches the ordered migration corpus from CHECKSUM
-  assert.match(deploy, /Object\.keys\(manifest\)\.sort\(\)/);
+  assert.match(deploy, /migration_names="\$\(check_fetched_manifest manifest/);
+  assert.match(deploy, /for migration in \$migration_names; do/);
+  assert.ok(indexOf('"lib/osi-migrate/migration-manifest.js"') < indexOf('"database/migrations/ordered/CHECKSUMS.json"'));
+  assert.ok(indexOf('"lib/osi-migrate/migrations-loader.js"') < indexOf('"database/migrations/ordered/CHECKSUMS.json"'));
diff --git a/scripts/verify-head-cli.js b/scripts/verify-head-cli.js
index 71df54cf..1258614b 100644
--- a/scripts/verify-head-cli.js
+++ b/scripts/verify-head-cli.js
@@ -5 +5 @@
-// usage/fatal error. Read-only: never mutates the database.
+// usage/fatal error. Valid-corpus fingerprint grace may restamp; corpus errors never mutate.
diff --git a/scripts/verify-head-cli.test.js b/scripts/verify-head-cli.test.js
index 83c91359..4db7f964 100644
--- a/scripts/verify-head-cli.test.js
+++ b/scripts/verify-head-cli.test.js
@@ -1,0 +2 @@
+const { fixtureWrite, fixtureCopy } = require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
@@ -16 +17 @@ function tinyMigrationsDir(root) {
-  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
@@ -35 +36 @@ test('exits 1 and prints ok:false for a DB with pending migrations', async () =>
-  fs.writeFileSync(path.join(dir, '0002__c.sql'), '-- risk: additive\nCREATE TABLE t2 (id INTEGER PRIMARY KEY);\n');
+  fixtureWrite(path.join(dir, '0002__c.sql'), '-- risk: additive\nCREATE TABLE t2 (id INTEGER PRIMARY KEY);\n');
diff --git a/scripts/verify-migrations.test.js b/scripts/verify-migrations.test.js
index 1e09188d..aefe773b 100644
--- a/scripts/verify-migrations.test.js
+++ b/scripts/verify-migrations.test.js
@@ -96 +96 @@ test('verify-migrations rejects migration files missing from the checksum manife
-  assert.match(result.stderr, /missing checksum manifest entry for 0002__later\.sql/);
+  assert.match(result.stderr, /migration corpus: file set mismatch: expected=\["0001__baseline\.sql"\], actual=\["0001__baseline\.sql","0002__later\.sql"\]/);
@@ -112 +112 @@ test('verify-migrations rejects checksum manifest entries without migration file
-  assert.match(result.stderr, /checksum manifest entry has no migration file: 0002__stale\.sql/);
+  assert.match(result.stderr, /migration corpus: file set mismatch: expected=\["0001__baseline\.sql","0002__stale\.sql"\], actual=\["0001__baseline\.sql"\]/);
```

## Amendment validation actually performed

All evidence below is author scratch validation, not independent approval. Exact argv, cwd, environment overrides, exits and output paths are retained under `reports/issue-397-plan-amend-r1/`. The actual product checkout still contains only this plan change.

| Evidence | Actual outcome |
| --- | --- |
| `baseline-commands.json` | 20 commands, 19 exit 0 and one ops/rehearsal/soak group exit 1 (33/34); full sync and omitted restamp/verifier suites passed. The red catchup condition remains a stop. |
| `prospective-short-commands.json` | 49/49 existing restamp/verifier/loader/wiring/fetch-list checks passed. |
| `prospective-regressions-first.json` | 62/62 parser, real runner, caller and generator checks passed in node-sqlite reference mode. |
| `sensitivity-commands.json` | Default-CLI caller/staging 7/7 passed; exact base runner failed all 9 no-DB regressions; review builder-only generator failed both source-replacement regressions. |
| `prospective-integration.json` | Library group 110/110 passed. Next group exposed two omitted soak test constructors (23/25); both were converted and `prospective-integration-r2.json` records 25/25 afterward. |
| `prospective-integration-r2.json` and `prospective-reconcile-repair.json` | The intended negative test filter matched the file ancestor and ran 37 reconciliation cases, yielding 30 pass and 7 failures. The scope was not the intended filtered subset. After fixing the empty-container policy and exact drift diagnostic, a positive-name-pattern rerun passed all 9 affected registry/runReconcile cases. Full reconciliation has not been rerun on the final patch; its independent final gate remains required. |
| `extraction-checks.json` | Entire Markdown patch applied to fresh scratch; all 52 files equal the prospective tree, 47 JS/shell syntax checks passed, protected ordered/seed/payload bytes unchanged. |
| `extracted-final-commands.json` | Final extracted code passed deployment 88/88 and bundle packaging (295 fetch-derived paths). Initial inventory failed because git apply left five new test files untracked in scratch. |
| `extracted-final-r2-commands.json` | After scratch-only git add -N, inventory passed (821 files, 244 steps, 11 workflows); final extracted code passed 85/85 parser/runner/loader/caller/generator/staging/restamp/verifier tests with no environment overrides. |

A prior delivery attempt passed 87/88 and exposed a truncated-manifest error missing the filename; readMigrationManifest now preserves the CHECKSUMS.json context, and the final 88-case run passed. A scratch edit guard also exited 1 on a mismatched variable-name needle before its remaining edits ran; the corrected edit and subsequent extraction/syntax tests succeeded. No resource fault or registration cleanup was attempted. Earlier failed logs remain preserved.

The product's full migration/CLI/reference/reconcile/ops/soak/schema gate set has not been run on an implementation candidate. Selected earlier prospective results precede narrow repairs; the final extracted 85-case and 88-case runs bind to the final patch. Baseline gates describe unchanged runtime source. Hardware, live deployment, independent Sol and Opus evidence remain absent. Parent arranges a fresh independent plan review.

Prose and privacy results, reviewed warning dispositions and final document checks are recorded in the SHA-bound handoff. Patch context was reduced without changing resulting files; exact base-byte validation precedes zero-context application.
