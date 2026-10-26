# Issue 397: require a validated migration corpus at every runtime boundary

Status: historical design and gate record. Independent Sol code review approved implementation `36dc4b032ea40463f3e27fc829d3ebb6752f35c7`; the documentation-only hygiene repair requires a new independent Sol review before publication. Opus and hardware qualification remain separate. The original acceptance criteria and gate instructions below are retained.

## Base, evidence and scope

Implement against `63c7a70f8f3b373f162b33b0669b0df89b3763fa` (75 ordered migrations). The design checkout is `/home/phil/.t3/worktrees/osi-os/t3-682aae95`, branch `t3/issue-397-manifest-validation`. It started clean at `c37207b30b002fb79da8ae57253d78c04613b6a5`, advanced by `git merge --ff-only`, and fetched `origin/main` matches the requested base. No current-main drift was present at planning time. Re-fetch and report drift before execution; do not silently change the reviewed base.

Read the campaign `COORDINATION.md`, `PLAN.md`, repository `AGENTS.md`, engineering playbook, schema/common-pitfalls/verification/prose skills, fresh issue body and both comments, finder report, coordinator evidence, and the full Astra trust consultation. Campaign evidence is under `/home/phil/projects/osi-release-campaign-2026-10-25/reports/`:

- `issue-397-plan-issue-snapshot.json`: fresh read-only GitHub snapshot; issue OPEN, updated `2026-10-25T23:41:19Z`.
- `issue-397-plan-base-refresh.json`: exact fetch, fast-forward and drift results.
- `issue-397-plan-base-probe.cjs`, `issue-397-plan-base-check-0.log`: fresh synthetic real-runner reproduction, adapted from the preserved finder probe only to bind imports to this checkout.
- `issue-397-plan-base-checks.json`, `issue-397-plan-base-check-1.log`, `issue-397-plan-base-check-2.log`: original commands, exits and outputs. Amendment evidence is in `reports/issue-397-plan-amend-r1/`; its JSON files record exact argv/cwd/exits.
- `issue-397-plan-inventory-0.txt`, `issue-397-plan-inventory-1.txt`: repository caller searches.
- `issue-397-finder.md`, `issue-397-coordinator-evidence.md`, `issue-397-trust-consult.md`: attributed prior evidence and consultation.

The fresh probe exited 0 after asserting the existing defects: a manifest-listed missing middle file permits `[1,3]`, mismatching bytes permit `[1]`, and extra SQL permits `[1,2]`; `verifyHead` returns `{ok:true}` in each case. Restoring/removing the offending files after application makes head verification fail, proving that present disk entries currently define completeness. A complete matching sparse `[1,3]` is valid. The three refusal regressions below must fail on this base for those reasons. Their executable code was included in the historical inline patch and exercised in scratch; the reviewed implementation is now recoverable through the commit-bound reconstruction below.

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

The following fixture surfaces were audited. The reviewed implementation inventory below defines the historical write scope; other named files are verification-only. Update constructors and intentional mutations, not broad directory auto-repair:

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
| R3 | The historical inline patch supplied the complete executable edit, including caller implementations, fixture construction, imports, assertions, cleanup, staging CLI parsing, source identity comparison and shell/module packaging. The commit-bound reconstruction below now recovers the reviewed implementation diff without duplicating that historical payload. New caller tests define DB/backup fixtures and no-DB scaffolding; reference state uses immutable migration entries, corpus identity and runner-specific cache keys, with published-snapshot restoration on retry. ClearRepairRequired validates main only. |

The registry container has one compatibility distinction, proven by existing and new tests: a missing root or a child directory with neither `.sql` entries nor CHECKSUMS.json supplies no corpus and contributes nothing. An existing manifest, including an empty one, or any `.sql` entry requires strict validation. A symlink container is refused; other filesystem errors propagate. This preserves exact-main reconciliation without known foreign fixtures and never consumes manifest-free SQL. The new test contrasts missing/empty containers with the same directory after SQL appears. No loader, runtime flag or environment switch bypasses manifests.

The schema skill claim is limited to the paragraph immediately below “Ordered migrations: format and risk-class declaration” and its formerly optional-manifest sentence. The live-ops skill claim is limited to the paragraph below “Deploy runbook (reverse-tunnel flow)” and the single SSH command there, adding `-o ExitOnForwardFailure=yes`. Preserve #183's credential-file/permission and recovery guidance independently. Deploy ownership is limited to check_fetched_manifest/fetch_migration_runner/fetch_reconciliation_assets and their tests. Parent coordination must reconcile these narrow paragraphs/functions before implementation admission; this design task admits no implementation claim and does not edit the ledger.

### Stop conditions and baseline result

Read the full `issue-397-plan-review-r1.md`, its exact runner/generator bridge diffs, failing logs and probe code before review. The trust ruling accepts authorized protected source plus authenticated SSH/provisioning, with the limits above; no publisher-signing work was requested.

Twenty baseline commands were run on unchanged product source at the reviewed base, from this bound checkout, with `OSI_BASELINE_RUNNER=node-sqlite` recorded in every JSON command record. Nineteen exited 0, including the omitted 13 restamp/verifier tests, all schema/seed/DB/profile/boot/trigger gates, inventory, bundle and full `verify-sync-flow.js`. One command group exited 1: ops/rehearsal/soak reported 33/34 passing. The catchup test file's three assertions passed, but its imported verify function sets `process.exitCode=1` in the expected missing-object control (`generate-uganda-catchup-20260911.js`, verify's failure branch), so the file exits 1. This is red-on-base, not repaired here. Parent must disposition that surface separately before implementation. Do not hide it by resetting exitCode in this patch, dropping the test, or reporting the group green.

That paragraph records the original baseline stop. The independently reviewed catchup repair `b3a22d08def19a1e51cc99a041c550c18e8e1d05` resolves that dependency and is included before the pinned implementation parent. The later code review records passing combined gates at the reviewed implementation SHA; this documentation repair neither removes that dependency nor reruns or waives its tests.

Expected new-test sensitivity is separate: the nine no-DB corpus regressions fail with the exact base runner; both generator regressions fail with the reviewer's builder-only bridge. They pass with the complete prospective edit. R1's five missing-manifest and two old-diagnostic failures remain preserved in the independent review's evidence. An unexpected refusal/result, missing file, red baseline or differing base SHA stops the affected execution step; amend and independently review rather than improvising.

### Execute only after fresh independent plan review

All commands, including extraction, syntax, edits, checks and Git actions, must run under `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py COMMAND ARGS`. Check binaries with guarded Python first. Respect locks/holds and process ownership; no registration deletion or bypass cleanup. No installs, privileges, live access, children, paid fallback, pushes, PRs or GitHub writes are authorized by this plan-only assignment.

1. Parent arranges fresh review of this amended commit and resolves the baseline stop above. Refresh issue/comments and main drift before implementation; keep the reviewed base explicit. No reviewer may approve their own implementation.
2. Use the reconstruction program below first. It reconstructs the reviewed implementation diff from its pinned parent and compares all 52 resulting files in scratch. Its formatting digest is distinct from the original inline patch digest. For red regression evidence, run runner-corpus.test.js with the exact base runner (nine before-DB cases must fail) and rebuild-corpus.test.js with the retained review generator bridge (both tests must fail for the source split). Restore the prospective files in finally blocks, as the retained sensitivity driver did. The immutable base and controls are never edited.
3. The historical implementation step applies the reviewed changes in an isolated checkout and runs the complete gates below; reconstruction now uses the pinned pre-implementation parent. Do not regenerate CHECKSUMS.json or seeds. Commit the coherent result as `fix: require validated migration corpora throughout runtime callers`, including tests and maintained trust documentation. Product changes are not committed by this design task.
4. The independent Sol verifier reruns the complete set at the final candidate SHA, checks explicit base-to-head diffs and ordered-byte preservation, and reports limits. Opus review remains later. Neither author scratch validation nor this plan commit approves implementation, deployment or hardware qualification.

Save this reconstruction program as a scratch Python file through the campaign wrapper. Run `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py python3 /absolute/path/to/reconstruct.py /absolute/path/to/new-output-directory` from any checkout containing the pinned Git objects. The output directory must not exist. It writes the reconstructed patch and its 52-file inventory, verifies both digests separately, then checks application in a temporary archive of the correct parent. It does not alter the invoking checkout.

```python
from pathlib import Path
import hashlib, json, re, subprocess, sys, tarfile, tempfile
PARENT = 'ffa4fe0dfe44b602231f083793e5aa00c819c08d'
IMPLEMENTATION = '36dc4b032ea40463f3e27fc829d3ebb6752f35c7'
DEPENDENCY = 'b3a22d08def19a1e51cc99a041c550c18e8e1d05'
HISTORICAL_PLAN = 'd040674eae02a48ce9cb8841f39938f59c5d5263'
PLAN_PATH = 'docs/superpowers/plans/2026-10-26-issue-397-runtime-migration-manifest.md'
PLAN_SHA256 = 'ab2f986c5f2134812cc1a040f90333b73d2bcd1e4365bb551b03381ba305e596'
ORIGINAL_PATCH_SHA256 = '3c78651bb7cbf48bd8c022d6a467be8123e0c635cfef02c5554674e50388f68b'
RECONSTRUCTED_SHA256 = 'a3d4a247d382b34cf589f568571d7debd7108463f323c398e68fd54846d80a7c'
def git(*args):
    return subprocess.check_output(['git', *args])
def digest(raw):
    return hashlib.sha256(raw).hexdigest()
assert git('rev-parse', IMPLEMENTATION + '^').decode().strip() == PARENT
subprocess.run(['git', 'merge-base', '--is-ancestor', DEPENDENCY, PARENT], check=True)
historical = git('show', PARENT + ':' + PLAN_PATH)
assert git('rev-parse', PARENT + ':' + PLAN_PATH).decode().strip() == 'd018e140a56d9cd2e78fc3bcb46803d0879fe4c3'
assert digest(historical) == PLAN_SHA256
original = re.search(rb'^```diff\n(.*?)^```$', historical, re.M | re.S)
assert original and digest(original.group(1)) == ORIGINAL_PATCH_SHA256
argv = ['git', '-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv',
        '--no-color', '--binary', '--full-index', '--no-renames', '--no-relative',
        '--diff-algorithm=myers', '--no-indent-heuristic', '--src-prefix=a/',
        '--dst-prefix=b/', '--unified=3', '-O/dev/null', PARENT, IMPLEMENTATION, '--']
patch = subprocess.check_output(argv)
assert digest(patch) == RECONSTRUCTED_SHA256
paths = [p.decode() for p in git('diff', '--name-only', '--no-renames', '-z', PARENT, IMPLEMENTATION, '--').split(b'\0') if p]
assert len(paths) == 52 and PLAN_PATH not in paths
out = Path(sys.argv[1]).resolve()
out.mkdir(mode=0o700)
patch_file = out / 'reviewed-implementation.patch'
patch_file.write_bytes(patch)
results = []
with tempfile.TemporaryDirectory(prefix='reconstruct-', dir=out) as temporary:
    temporary = Path(temporary)
    archive = temporary / 'parent.tar'
    with archive.open('wb') as stream:
        subprocess.run(['git', 'archive', '--format=tar', PARENT], stdout=stream, check=True)
    scratch = temporary / 'tree'
    scratch.mkdir()
    with tarfile.open(archive) as source:
        source.extractall(scratch, filter='data')
    subprocess.run(['git', 'init', '--quiet', str(scratch)], check=True)
    subprocess.run(['git', 'apply', '--check', str(patch_file)], cwd=scratch, check=True)
    subprocess.run(['git', 'apply', str(patch_file)], cwd=scratch, check=True)
    for name in paths:
        row = git('ls-tree', IMPLEMENTATION, '--', name).split(b'\t', 1)[0].split()
        mode, kind, oid = row
        assert kind == b'blob' and mode in (b'100644', b'100755')
        file = scratch / name
        expected = git('cat-file', 'blob', oid.decode())
        assert file.is_file() and not file.is_symlink() and file.read_bytes() == expected
        assert bool(file.stat().st_mode & 0o111) == (mode == b'100755')
        results.append({'path': name, 'blob': oid.decode(), 'mode': mode.decode(), 'sha256': digest(expected)})
(out / 'inventory.json').write_text(json.dumps({
    'parent': PARENT, 'implementation': IMPLEMENTATION, 'dependency': DEPENDENCY,
    'historicalPlan': HISTORICAL_PLAN, 'historicalPlanSha256': PLAN_SHA256,
    'originalInlinePatchSha256': ORIGINAL_PATCH_SHA256,
    'reconstructedPatchSha256': RECONSTRUCTED_SHA256, 'diffArgv': argv,
    'fileCount': len(results), 'files': results,
}, indent=2) + '\n')
print('reconstruction: PASS (52 reviewed files; bytes and executable modes match)')
```

The reviewed implementation tree is the code specification; the original inline patch remains historical evidence at its pinned plan commit. The earlier parser-only assertions are historical evidence and do not establish caller integration. Synthetic expected manifests come from explicitly declared buffers or accepted parent selections, never scans that bless arbitrary actual production files. Deliberate changed-corpus ledger tests update their synthetic expectation; stale-manifest tests keep it unchanged.

### Runnable counterfactual sensitivity driver

The reconstruction program removes its temporary verification tree. Prepare a separate scratch checkout at the pinned implementation commit before using this preserved driver or the runtime gates; this documentation repair does not run them.

After reconstructing the reviewed implementation in a scratch tree under the campaign reports directory, run this Python driver there through run-heavy.py. It restores every swapped file in finally and records actual child argv/cwd/exits. Both child exits must be 1 with exactly nine and two failing regressions; any other result stops execution. The review's retained generator bridge is a control, never a proposed implementation.

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

Also run `node --check` for every changed/new JavaScript file and `bash -n` for deploy.sh and changed shell files, using the 52-file inventory below and the reconstructed inventory.json. Run `git diff --check 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD`, `git diff --name-status 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD`, and `git diff --exit-code 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD -- database/migrations/ordered database/seed-blank.sql conf feeds` against the reviewed runtime SHA. Product source changes must match the reviewed implementation tree; no migration, manifest, seed, flow or payload edit is allowed. Test inventory must account for all five new tests. Prose must pass with no tier-1 findings; inspect tier-2 warnings. Privacy uses the maintained list if supplied, otherwise report built-in-only coverage and unchecked allowlist staleness.

Expected final results are exit 0 with the actual current pass summaries. Runtime refusal tests assert ERR_MIGRATION_CORPUS and unchanged schema/data/ledger/fingerprints/backup files; head CLI exits 2 for corpus errors, while a valid incomplete ledger remains ok:false/exit 1. Sparse [1,3], both reference-gap policies, applied checksum repair_required, risk/backup/FK behavior and the separate repair-artifact contract stay intact. A coherent operator-supplied alternate corpus is accepted, with no publisher-authentication claim. A coherent altered stage differs from the accepted source identity and is rejected.

### Exact implementation file inventory

These are the 52 reviewed implementation paths. The earlier design claims are historical; this hygiene repair authorizes only the plan document change.

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

## Reviewed implementation provenance

The historical inline payload is retained in the reviewed plan commit `d040674eae02a48ce9cb8841f39938f59c5d5263` at this same plan path. The pre-implementation parent stores the same historical plan blob, so verification needs no separately fetched plan-author branch. This document now records commit-bound reconstruction instead of duplicating source and fixture literals in public prose. Runtime, tests and workflow files are unchanged by this documentation repair.

| Artifact | Immutable identity |
| --- | --- |
| Reviewed historical plan commit | `d040674eae02a48ce9cb8841f39938f59c5d5263` |
| Historical plan Git blob | `d018e140a56d9cd2e78fc3bcb46803d0879fe4c3` |
| Historical plan SHA-256 | `ab2f986c5f2134812cc1a040f90333b73d2bcd1e4365bb551b03381ba305e596` |
| Original inline patch SHA-256 | `3c78651bb7cbf48bd8c022d6a467be8123e0c635cfef02c5554674e50388f68b` |
| Pre-implementation parent | `ffa4fe0dfe44b602231f083793e5aa00c819c08d` |
| Independently reviewed implementation | `36dc4b032ea40463f3e27fc829d3ebb6752f35c7` |
| Reconstructed Git diff SHA-256, using the exact options above | `a3d4a247d382b34cf589f568571d7debd7108463f323c398e68fd54846d80a7c` |

The original zero-context formatting digest and reconstructed full-index, three-context Git diff digest identify different byte streams. Both yield the same 52 reviewed implementation files. The implementation tree is the authority for those files; this repair does not claim that a newly formatted patch has the original approved patch bytes. The reconstruction program verifies the historical artifact separately and compares every resulting implementation file's bytes and executable mode with the reviewed commit.

The parent already contains the independently reviewed catchup dependency `b3a22d08def19a1e51cc99a041c550c18e8e1d05`. Reconstruct against the pinned parent, not the earlier runtime baseline. Application and comparisons occur only in temporary scratch created from that parent; the current checkout is not a patch target.


## Amendment validation actually performed

The evidence below is the historical plan-author scratch record, not independent approval. Exact argv, cwd, environment overrides, exits and output paths remain under `reports/issue-397-plan-amend-r1/`. Later independent code review is recorded in `reports/issue-397-code-review-r1.md` at the pinned implementation SHA.

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

At that plan-authoring checkpoint, the full migration/CLI/reference/reconcile/ops/soak/schema gate set had not yet been run on an implementation candidate. Selected earlier prospective results precede narrow repairs; the final extracted 85-case and 88-case runs bind to the final patch. Baseline gates describe unchanged runtime source. Hardware and live-deployment evidence were not supplied by those scratch runs. Later Sol code review approved the pinned implementation with combined gates; this documentation repair still needs fresh independent review, and Opus remains pending.

Prose and privacy results, reviewed warning dispositions and final document checks are recorded in the SHA-bound handoff. The historical scratch patch used reduced context; the reconstructed Git diff has its own formatting digest and is checked against the pinned implementation tree.
