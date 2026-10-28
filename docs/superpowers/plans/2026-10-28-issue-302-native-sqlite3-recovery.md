# #302 native SQLite recovery: exact source plan (R6)

## Status and scope

This is the R6 amendment of the #302 recovery plan. Nothing in R6 has run. #302 remains open at provisional P1. Every statement below about an R6 test, mutant, apply mode or command result is a forecast. The R5 results quoted in "R5 execution and the R6 test corrections" are observations, and they are labelled as such.

R4 answered council round 1. A non-author source review of R4 then asked for one `should` correction, S1: a restore refused because its destination was occupied could be forgotten by the next run. R5 is R4 plus that correction, its tests and its mutants. Council round 2 approved the R5 plan commit R. Executing R found four defects in the test fixtures, none in the product text. R6 is R5 plus four test-fixture corrections. The deploy text, the seed text and the mutant preparer are byte-identical to R5. The apply script differs only in the report file names it reads in plan-only mode.

Pinned base P is `f6682ef6d0d90355bded9789fb4d423136ab02bb`. Round 1 reviewed plan commit Q `42eacb6465b658c704ee00a61e95adacdb7dde1d` (sole parent P, tree `f5508bc27a9153648e5f647565a5ff472892c22e`), whose plan blob `2ec04e6a1f0ed817e9a5d08b6a079a8e6333b53e` has SHA-256 `9425b2bb2a770da88f00f430d0841b2b5d47ba255891d136d9c9c4c9da5a8a40`. Round 2 reviewed plan commit R `ed13ab13577affc76db44e8283f71e53aba37192` (sole parent P, tree `4cf3399c3cd62baf4a3e792bbc2f4aa0f87a2f88`), whose plan blob `a37ca11b64e1a65e7d1899aaf3936514d95543c9` has SHA-256 `bfafb0d447b12585545e04c168fa1dab9bd042c71bcc3c979fd2d9e4768a319b`. Q and R stay as they are. R6 becomes a new plan-only commit on P, not an edit on top of R, so `git diff R <R6 plan commit>` shows the whole amendment.

The accepted BASE capture at P shows two failures and one control. A broken matching-version real `sqlite3` directory survives deploy materialisation. An absent firmware source makes the seed delete both installed SQLite entries. A working real directory loads. These JavaScript fixtures prove control flow and module resolution only. They prove nothing about native ABI compatibility, a built image, a full boot or a gateway.

The future change touches five paths: `deploy.sh`, `scripts/test-deploy-native-sqlite3.js`, the byte-identical bcm2712 and bcm2709 `files/etc/uci-defaults/98_osi_node_red_seed` scripts, and this plan at `docs/superpowers/plans/2026-10-28-issue-302-native-sqlite3-recovery.md`. There is no schema, flow, GUI, history, database or command-ledger change.

The five embedded files follow this report in the plan. Their SHA-256 values:

| Embedded file | SHA-256 |
|---|---|
| `issue-302-r6-deploy-source.txt` | `f391977b11ca21edc713cb278d03fdc07110373c12ea698899e9a92af86c7060` (equal to R5) |
| `issue-302-r6-seed-source.txt` | `54a67d6d9698cf08f72d2a6506738bda1509ea3e438c61f842fca8b3bf1fa953` (equal to R5) |
| `issue-302-r6-test-additions.js.txt` | `64586eff91ecce04948d029b203d7abb1583d31fb91b4395c8c168db64e2e550` (R5: `492fc3ee69b3e930eecab72128603e2db7cb91d7c340efba2ecca2d21249477b`) |
| `issue-302-r6-apply-proposal.py` | `9dbf4628147ac5fcdeac43279aba270d13b2e11fbe65551959f0b4ed97e0762f` (R5: `d557f928738fc57bab456e502efae0b598d9eb4dab92a398b117f04382b62daf`) |
| `issue-302-r6-mutants.py` | `537f2a1a60f93222c5418874f74269d339aacc81b25abaed09e35a68d0b1882b` (equal to R5) |

## R5 execution and the R6 test corrections

### What R5 execution observed

These are observations from executing R, not forecasts. Controls C1 and C2 refused as forecast and left the checkout clean. tests-first wrote the approved test file with 68 top-level tests. The two `R2 RED` tests failed on P's product with every forecast marker present. A test-only commit on R holds that file. product mode then wrote deploy and both seeds; the mirrors were byte-identical and `sh -n` accepted both scripts. The whole-file run did not finish, so R5 has no product GREEN result, no candidate commit, no verify-candidate result and no mutant result.

Three diagnostic runs on the unchanged product text then located four defects, all in the R5 test additions:

1. `R2 unknown destination file, FIFO and rollback marker types fail closed` never finishes. Its FIFO subcase makes `node_modules/sqlite3` a FIFO. `r2DeployCall` always runs `verify_native_sqlite3_after_npm` after materialisation, and that function's `require('sqlite3')` opens the FIFO and blocks with no writer. Run alone, the test reached its timeout (status 124).
2. `R2 deploy copy fault matches source-dot and stage-slash arguments` fails at its status assertion with `$3: unbound variable`. The `cp` hook expands `"$1:$2:$3"` under the harness's `set -eu`. The harness's own `fetch()` copies the lock fixture with a two-argument `cp`, so the shell exits during preflight, before the stage copy the hook is meant to fault.
3. `R2 deploy stage allocation fault never touches old real directory` fails at its `/STAGE_ALLOC_HOOK/` stderr assertion. The product allocates the stage with `mktemp -d ... 2>/dev/null`, which discards the hook's marker. The product did refuse: stderr held `ERROR: could not create sqlite3 stage`.
4. `R3 failing fallback-link probe preserves the old seed entry` fails at its `/LINK_PROBE_HOOK/` stderr assertion. The seed runs the probe as `seed_sqlite3_loads "$seed_candidate" >/dev/null 2>&1`, which discards the hook's marker. The product did refuse: the `SEED_RC` assertion passed and stderr held `ERROR: verified firmware-link fallback unavailable`.

With only the first test skipped, the file ran 67 tests: 64 passed and 3 failed (defects 2 to 4). That result is diagnostic. It is not a 68-test GREEN result and it is not mutant evidence. In each of the four tests only the assertions up to the first failure ran; the rest are unobserved. The two `R2 RED` tests passed in that run, so the product turns both RED tests green.

The R5 product redirections in defects 3 and 4 are approved product bytes and stay. Defect 1 does not show a product fault either: deploy.sh runs `materialize_native_sqlite3 || exit 1`, so the verifier never follows a refused materialisation in a real deploy.

### The four corrections

All four are changes to `issue-302-r6-test-additions.js.txt`. No assertion is removed, no test is skipped and no test is renamed.

1. **FIFO case.** `r2DeployCall` takes `verify: false`, which leaves out the verifier line and keeps every other line, including `AFTER_MATERIALIZE`. Without the option the generated shell text is byte-identical to R5, so every other caller is unchanged. The FIFO subcase passes `verify: false`; the regular-file subcase and the rollback-marker case keep the default. Both malformed-destination subcases now also assert status 0, a nonzero `PREFLIGHT_RC` with preflight's `unexpected sqlite3 destination type before deploy writes` message, a nonzero `MATERIALIZE_RC` with materialisation's `ERROR: unexpected sqlite3 destination type:` message, and `AFTER_MATERIALIZE`. The FIFO subcase asserts that no `VERIFY_RC` line was printed. The unchanged mode assertion still proves the destination was not replaced. The FIFO case stops where deploy.sh stops; a timeout does not count as a result.
2. **`cp` hook.** The hook expands `"${1-}:${2-}:${3-}"`, so a call with fewer arguments is safe under `set -u` and is forwarded by `command cp "$@"` like every other call that does not match. The case pattern for the stage copy is unchanged. The test keeps the `DEPLOY_CP_HOOK` stderr marker (the stage copy does not redirect stderr), the nonzero `MATERIALIZE_RC`, the old bytes and the stage-absent assertions, and adds the refusal message `ERROR: could not copy sqlite3 into stage`.
3. **`mktemp` hook.** The hook appends `STAGE_ALLOC_HOOK` to a marker file the test owns in the gateway fixture root, outside `node_modules`, and no longer writes to stderr. It also uses `${1-}:${2-}`; every product `mktemp` call passes two arguments, so this changes no current behaviour. The test asserts that the marker file is absent before the run and holds exactly one `STAGE_ALLOC_HOOK` line after it, then status 0, `ERROR: could not create sqlite3 stage`, a nonzero `MATERIALIZE_RC`, the old bytes and no stage.
4. **Fallback-link probe hook.** The hook appends `LINK_PROBE_HOOK` to a marker file in the gateway fixture root and no longer writes to stderr. The non-matching branch is unchanged. The test keeps status 0 and the nonzero `SEED_RC` in their R5 order, then asserts exactly one marker line, `ERROR: verified firmware-link fallback unavailable`, the old bytes, no seed rollback directory and, new, no seed stage. That message is printed only after `rm -rf` of the stage succeeded, so the stage assertion follows from the source.

No subprocess timeout is added. A future change that sent the FIFO case back to a blocking read would hang until the caller's timeout, and that timeout is a failure.

### What R6 keeps

The deploy text, the seed text, the mutant preparer, the product policy and every R5 behaviour named above stay as they are. The tests-first transformation of P's test file is unchanged; only the appended additions differ. The test count stays 68 (P's 25, minus the two that tests-first removes, plus 45 appended). The 64 tests outside the four corrected ones are byte-identical to R5. The mutant table below is unchanged except for the M06 note.

## Council round 1 and the responses

Round 1 reviewed Q with three members: Sol voted CHANGES 8/10, Claude Fable CHANGES 7/10 and DeepSeek V4 Pro APPROVE 9/10. The council has not approved. One round of the five-round cap is used. DeepSeek's approval does not settle the two members' `should` findings, so each is answered below against the actual source bytes.

| Finding | Disposition | Change and bounded oracle |
|---|---|---|
| Sol S1 (should): the R3 diagnostic `dangling sqlite3 symlink` breaks two retained P tests that expect `/dangling symlink/`. | Accepted. P's test file, lines 449 and 463, asserts that regex; R3 inserted `sqlite3` into the phrase. Claude's reading that every retained P expectation still holds missed this. | The materialiser prints `WARN: dangling symlink at <path>; it does not resolve to a sqlite3 module`. Both retained tests stay byte-identical. Their other expectations (link gone and module restored from firmware; link gone and `SKIP` when the firmware is absent) follow from the unchanged R3 control flow. |
| Sol S2 and Claude S2 (should): product mode imported deploy and seed text from mutable report copies with no comparison against the committed plan. The mutant preparer had no byte check either. | Accepted. | Every mode after plan-only reads its inputs only from the approved plan commit and refuses unless its own running bytes equal the copy embedded in that plan. See "Binding execution to the approved plan". |
| Claude S1 (should): a rollback directory holding only owner metadata beside an untouched final path is refused forever by deploy preflight and by every boot of the seed. | Accepted, with one correction to the proof in R4 and one exclusion added in R5. | A proven metadata-only rollback directory is cleared without touching the final path, and the run stops for a retry. Unsafe states stay refused. A rollback directory left by an occupied restore is now one of those unsafe states. See "Metadata-only rollback directories". |
| Claude N1 (nit): a seed refusal skips the helper refresh and final `chown`, and the defaults script reruns each boot. | Accepted as disclosure; placement unchanged. | See "Seed behaviour at boot". |
| Claude N2 (nit): a dangling installed symlink made preflight skip its version check. | Accepted. | Preflight again chooses the installed package only when `[ -e ]` holds, as at P. A dangling link falls through to the firmware version and an impossible mismatch is refused before any write. New test and mutant M14. |
| Claude N3, DeepSeek nits 1–2: stale governance text and campaign-host scaffolding in the committed plan. | Accepted. | Superseded statements are listed with their dates under "Review gates still required". This plan carries no host paths, process identifiers or resource thresholds; the coordinator keeps those outside the repository. |
| Claude N4 (nit): stage leftovers after refusals were not asserted. | Accepted. | Retention is an asserted property, with next-run behaviour. See "Stage leftovers". |
| Author finding A1: the R3 deploy and seed source files began with report-only comments ("report-owned", "no seed was run", insertion instructions), which product mode would have copied into `deploy.sh` and both seeds. | Fixed in R4. | The embedded deploy and seed texts begin with comments that describe the shipped behaviour. Insertion instructions live only in this report. |
| Author finding A2: recovery reads the scanner's classification, so the R3 replacement text for M10/M11 would stop at the incomplete-owner guard instead of reaching the second lock read it names. | Fixed in R4. | M10/M11 keep their anchors, tests and named assertions. Their replacement calls the scanner before the interrupted-recovery function, exactly as a fresh invocation does. |

## Source review of R4 and the R5 correction

### The finding

The R4 source review returned CHANGES with one `should`, S1, and no other open finding. Both restore helpers handle a destination that appears during the restore. `mv B/original D` without `-T` then moves the original into `D/original`. The helper sees that D's device/inode is not the original's, reports the mismatch, and keeps B with its metadata. The retained R3 occupied-restore tests assert exactly that state.

R4 lost that state on the next run. The scanner marks B metadata-only because `B/original` is absent. D carries no candidate marker, so the R4 clearing branch removed B's metadata and B itself. The run after that saw an unmarked, broken real directory at D. It moved the whole occupant, with `D/original` inside, into a new rollback directory, promoted a healthy firmware copy and deleted that rollback directory with `rm -rf`. The original module was gone. The seed had the same branches and the same outcome. The review traced this through the existing `R3 early deploy recovery refuses an occupied restore before ordinary writes` fixture across four invocations, with no new concurrency model. `rmdir B` protects an original still inside B, not one already under D. The review found no field-database, actuation or security loss, which is why the finding is a `should`.

### The correction

`native_sqlite3_recover_early` and `seed_sqlite3_recover` keep their R4 clearing branch, and inside it now check `D/original` with the "present" helper (`-e` or `-L`) before clearing anything. When it is present, the run prints

- deploy: `ERROR: <D>/original is present beside metadata-only rollback <B>; an earlier restore may have nested the old module there; preserving both for inspection`
- seed: `ERROR: <D>/original is present beside metadata-only seed rollback <B>; an earlier restore may have nested the old module there; preserving both for inspection`

then reports the types of B, D and `D/original`, and returns nonzero. It removes nothing and moves nothing. The retained B is the persistent record: every later preflight and every later seed scans it again, reaches the same branch and refuses again. Deploy materialisation also refuses while any B exists, so no ordinary write follows a refused preflight even in a harness that calls both.

The check is deliberately broad. It refuses any metadata-only B whose D has an `original` entry of any type, including a dangling link, and it follows a symlinked D into its target. A sqlite3 module has no top-level entry of that name, and the module fixtures in this test file have none (their sentinel is `original.txt`), so no healthy retry chain reaches the new refusal. A D that did hold such an entry beside a leftover B would be kept for inspection rather than cleared. That is the intended failure direction.

The other R4 retry chains are unchanged. After an ordinary failed old-path `mv` or an `exit 26` before the rename, D is the untouched original and has no `original` child. After a truncated owner write and a failed `rmdir`, D is again untouched. After a restore that succeeded but whose `rm -rf B` failed, D is the restored original itself. After an interrupted seed identity write, D is the existing module. Each of these still clears its B and becomes an eligible retry.

### What remains an operator state

A refused occupied restore now stays refused on every deploy and every boot until someone inspects it. The diagnostic names B, D and `D/original`. Deciding which module to keep is an operator decision; this plan adds no automatic route and no runbook step. The seed consequence is the persistent-refusal case under "Seed behaviour at boot": the defaults script exits 1 on every boot and skips the helper loop and final `chown`. Unlike a missing firmware module, a deploy does not repair this state, because deploy preflight refuses too.

## Metadata-only rollback directories

### Why clearing is safe, and the one exclusion

Both promoters write in a fixed order. They allocate the rollback directory B with `mktemp -d`, write its owner line, and the seed then writes `.candidate-id`. The deploy copy then receives its candidate marker. Only after that does the old final path D move into `B/original`, and only after that does the stage move to D.

So a B with no `original` child is in one of two histories. Either nothing was ever moved into it, or a restore moved its original out. Clearing B removes at most an owner line and a candidate identity. It never deletes module bytes by itself. What clearing does decide is that the next run is an ordinary attempt at D.

That decision is right when D is the untouched original, the restored original, or a remnant of the tool's own candidate. The last case corrects Claude's round-1 proof: when D was absent before the attempt, a final-load failure followed by a partial `rm -rf D` can leave part of the tool's candidate at D with its marker already gone. The next ordinary run treats the remnant like any broken real directory: it probes the load, repairs before npm, and refuses npm if the repair fails.

The decision is wrong when a restore found D occupied and nested the original under it. The next ordinary repair would move D, original included, into a new rollback directory and delete it after promotion. R5 therefore excludes a metadata-only B whose D has an `original` entry; see the previous section.

### What the scanners accept

The deploy scanner (`native_sqlite3_scan_backup`) and the seed scanner (`seed_sqlite3_scan_backup`) are unchanged from R4. They require exactly one real, non-symlink B with only the known children, each of the expected type, and classify it:

- A complete owner line, with or without `original`, is accepted.
- An absent owner line, or a regular file holding a strict prefix of it (an interrupted write), is accepted only when there is no `original`.
- For the seed, an incomplete owner line next to any `.candidate-id` is refused, because the identity is written after the owner line.
- A `.candidate-id` that is not a complete `dev:ino:mtime` line is accepted only when it is a strict prefix of one (digits and at most two colons, no newline) and there is no `original`. The R2 control with `unverified identity` text stays refused.
- Anything else stays refused: a symlinked B, a second B, unknown children, a foreign owner, or an incomplete owner or identity beside an `original`.

### What recovery does

When B holds no `original`, D is not B's own candidate (or D is absent), and D has no `original` entry, `native_sqlite3_recover_early` and `seed_sqlite3_recover` remove only the known metadata files with `rm -f`, then `rmdir B`. `rmdir` fails on a directory that gained any other entry after the scan, so even a classification bug cannot delete an `original` still inside B. The run prints `cleared metadata-only ... rollback; <D> was not touched` (or the older `cleared marker-only` message when D is absent) and returns nonzero. Deploy preflight therefore stops before any ordinary deploy write, and the seed exits 1. The next run is an ordinary attempt.

When D has an `original` entry, the run refuses with the R5 diagnostic and keeps everything, on this and every later run.

If `rm -f` or `rmdir` fails, the run reports the surviving paths and stops. Whatever is left (B without an owner line, or B with its metadata) is still a metadata-only B, so the following run clears it. This holds for an ordinary failed old-path `mv`, an interruption before that `mv`, a failed metadata write, and a rollback whose restore succeeded but whose cleanup of B failed.

A metadata-only B whose D does carry B's candidate marker or identity is an interrupted promotion into a previously empty path. It keeps the R3 handling: the final is validated against the pin and kept, or removed. An incomplete owner line in that state is refused, because the marker is written after the owner line. A B that still holds `original` keeps every R3 branch: restore into a vacant D with identity proof, refuse an unowned D, validate an owned D.

The serialisation model is unchanged: one deploy or one seed works on the module at a time. R5 adds no locking.

### Tests

- `R4 deploy metadata-only rollback after a failed or interrupted old-path rename clears and retries` covers both an ordinary `mv` status failure (27) and an `exit 26` at the old-path rename. The first run leaves B with only `.owner` and one stage. The second preflight returns nonzero, prints no ordinary-write marker, clears B, and keeps D's bytes and device/inode identity. The third full call removes the stage, repairs the broken directory before npm, and reaches `VERIFY_RC=0` with no rollback or stage left.
- `R4 deploy truncated owner metadata and a partial cleanup converge to an eligible retry` starts from a truncated owner line, makes `rmdir` fail once, then shows the emptied B cleared on the next preflight and an ordinary success after that.
- `R4 deploy leftover metadata after an already restored rollback clears without moving the restored module` forces a final-load failure whose restore succeeds and whose `rm -rf B` fails. The next preflight clears B and keeps the restored directory's identity and bytes. After the injected image fault is removed, the following run succeeds.
- `R4 seed metadata-only rollback after a failed or interrupted old-path rename clears and retries` is the seed equivalent. It also requires the `node-red-node-sqlite` peer bytes to stay unchanged through all three runs.
- `R4 seed partial candidate identity is metadata only and clears before an eligible retry` uses an empty and a truncated identity beside a working real directory. The run after clearing reports that the existing directory matches and loads, with no swap.
- `R4 seed stage with only an interrupted owner write is removed; a stage with payload and no owner is retained` covers the same interrupted-owner case for seed stages.
- `R4 deploy unsafe rollback states are retained, not cleared` and `R4 seed unsafe rollback states are retained, not cleared` require a nonzero result, no `cleared` message, an unchanged `node_modules` listing, unchanged rollback contents and an unchanged D identity for: an `original` beside an unowned D, a symlinked B (deploy), a foreign owner line, an incomplete owner beside an `original` or an identity, and a partial identity beside an `original`.
- New in R5, `R5 deploy occupied restore stays refused across fresh invocations` reaches the occupied-restore state two ways: a same-invocation final-load failure whose restore meets an occupant, and an `exit 26` after the old-path rename followed by a preflight whose restore meets an occupant. Both use an occupant hook of the same form as the R3 tests. The test then removes the injected image fault, so an ordinary repair would succeed, and runs a fresh preflight and then a fresh full deploy call. Each must return a nonzero preflight, print no ordinary-write marker and no `cleared` message, and print the R5 diagnostic. The full call must also refuse materialisation with `rollback appeared after preflight` and print no `OK: materialised`. After each run, a snapshot must equal the one taken after the refusal: the `node_modules` listing (B, D and any retained stage), B's children and their bytes (exactly `.owner` with `osi-sqlite3-deploy-v2`), D's device/inode and children (`occupant.txt` and `original`), the occupant bytes, and the nested original's device/inode, children and `original.txt` bytes.
- New in R5, `R5 seed occupied restore stays refused across fresh invocations` does the same for the seed, from a same-invocation final-load failure and from an `exit 26` after the old-path rename followed by an occupied restore on the next run. It then runs two more seeds with the image fault removed. Each must return nonzero, print no `OK: seeded` or `OK: existing` line and no `cleared` message, print the R5 diagnostic, leave the same snapshot (B holding exactly `.candidate-id` and `.owner` with `osi-sqlite3-seed-v2`), and keep the `node-red-node-sqlite` peer bytes.

The two R3 occupied-restore tests and the R3 early deploy occupied test stay byte-identical, so M12 and M13 keep their named tests and first failing assertions.

## Seed behaviour at boot

The R1 placement is kept: the SQLite block runs after the broad `node_modules` copy and before the `osi-*` helper loop. It ends with `seed_native_sqlite3 || exit 1`. Every nonzero result exits the defaults script at that point. That covers a refusal (missing or mismatched firmware source, invalid image pin, load failure, ambiguous rollback, a retained occupied restore) and also a completed recovery step that asks for a retry (restore, metadata clear, verified interrupted promotion).

For that boot, the earlier steps have already run: the copy-if-absent of flows, settings, package and lock files, the overwrite of `edge-channels.json` and codecs, and the broad `node_modules` copy. The helper loop does not run, so the previous copies of the `osi-*` helpers in `/srv/node-red` and its `node_modules` stay. The final `chown -R` does not run either. Node-RED then starts from the existing `/srv/node-red` content, which after a sysupgrade is the previously deployed flows and helpers.

OpenWrt's boot defaults runner deletes a defaults script only when it exits 0. This is base-files behaviour and has not been checked on a built image in this plan. So the script reruns on every boot until it succeeds, repeating the broad copy and the SQLite checks. A retry-type result costs one extra boot. A persistent refusal repeats on every boot and keeps both installed SQLite entries. For an image without the firmware module, a deploy is the repair route. For a retained occupied restore, deploy refuses as well, and the state waits for operator inspection. Moving the block after the helper loop would change the seed's scope, and no council member asked for it.

## Preflight with a dangling symlink

At P, preflight used `[ -e ]`, so a dangling installed symlink fell through to the firmware module's version. R3 used the "present" helper, which is true for a dangling link, so preflight read an empty version through the link and skipped the check. The lockfile mismatch was then refused only later, during materialisation, after the ordinary fetches. R4 restored `[ -e ]` for this choice and kept the "present" helper for the unexpected-type check above it. `R4 dangling installed symlink still compares the firmware version before writes` requires a nonzero preflight that names firmware 5.1.7 and lock 5.1.8 on an armv7l+musl fixture without a toolchain, an unchanged link, and a pass when the lock pins 5.1.7. M14 reverts the choice and must fail the nonzero-status assertion.

## Stage leftovers

Stages that a refusal leaves behind are kept on purpose and removed by the next run, before any new stage is made:

- Deploy refusal on a copied ownership marker keeps its stage. The next materialisation removes it with `WARN: removing a staging directory left behind by an interrupted deploy: <path>` (the existing prefix-bounded scan, unchanged since P) before it makes a new one.
- Deploy refusal on the old-path rename keeps its stage, with its candidate marker naming the metadata-only B. Preflight clears B; the following materialisation removes the stage.
- The seed refusal on a copied ownership marker keeps a stage with its owner line and the copied candidate. A seed final-load failure keeps a stage holding only its owner line. The next seed run removes either one, and prints `WARN: removing seed stage left by an earlier attempt: <path>`.

The two R3 copied-marker tests and the R2 seed final-path test assert the retained stage, its contents where they are fixed, the removal message naming that exact path on the next run, and that only one stage exists afterwards.

One exception is new in R5 and is also asserted. While an occupied-restore B is retained, any stage left by the interrupted attempt stays too, because both recoveries refuse before their stage scans run. The R5 tests include every such stage in the `node_modules` listing that must not change.

## Binding execution to the approved plan

### Inputs and their derivation

The council approves one plan commit. Its SHA is recorded only after the plan-only commit exists, and the executor passes it to every later step as `--approved-plan-commit` (apply script) or as the last argument (mutant preparer). No future SHA appears in any embedded file.

The plan is this report followed by five sections, in a fixed order. Each section is a level-2 heading, a fenced block in the file's language, the exact file bytes, and a closing fence. The report holds the SHA-256 of the five files. No embedded file holds a hash of itself, of the report or of the plan, so there is no self-reference. The apply script splits a plan back into report and files. It requires each section heading exactly once, in order, and requires the pieces to reassemble to the identical text. plan-only performs that split on the text it is about to write and refuses if the split does not reproduce its inputs.

### Checks before any write

- **tests-first** checks that the approved commit has P as its sole parent and changes only the plan path. It requires that the running apply script equals the plan's embedded copy byte for byte, that HEAD is the approved commit, that the checkout is clean, and that the working plan and the four product and test files equal the approved plan and P. It then writes the test file from P plus the embedded test additions.
- **product** repeats the plan-commit and self checks. It also requires HEAD to be a single commit on the approved commit that changes only the plan and test. The committed and working test file must equal exactly what tests-first produces from P and the embedded additions, and deploy and both seeds must still equal P. It then writes deploy and both seeds from the embedded texts. The report copies are not read in either mode.
- **verify-candidate** (read-only) requires product → test-first → approved plan commit, exact changed-path sets for both later commits, a clean checkout, and committed bytes for all five paths equal to what the approved plan produces from P. It prints `CANDIDATE_MATCHES_APPROVED_PLAN` with the SHA-256 of each file.
- **the mutant preparer** requires the same three-commit chain and exact five-path scope. The candidate plan must be byte-identical to the approved commit's plan, and the running preparer must equal the plan's last section byte for byte. Only then does it copy anything.

Every apply mode prints a JSON receipt with the plan SHA-256 and each embedded file's SHA-256. The preparer's `MUTANT_READY` receipt carries the plan and preparer SHA-256. The execution record therefore holds the values actually used.

### Refusal controls

The execution order below includes three negative controls. Each is forecast to refuse before any write:

- C1: a copy of the apply script with one appended comment line runs tests-first against the approved commit → `PROPOSAL_REFUSED: running apply script differs from the approved plan copy`, exit 1, checkout unchanged.
- C2: the unmodified apply script runs tests-first with Q as the approved commit → `PROPOSAL_REFUSED: running apply script differs from the approved plan copy` (Q embeds the R3 apply script under the same five section headings), exit 1, checkout unchanged. Q is a real, different plan commit, so this control uses no invented SHA.
- C3: a copy of the mutant preparer with one appended comment line → `MUTANT_SETUP_REFUSED: running mutant preparer differs from the approved plan copy`, exit 1, no `mutant-MNN` directory created.

These controls show that an edited copy refuses. They do not defend against someone who removes the check; the approved plan commit and the recorded receipts are the root of trust.

## Retained decisions from R1–R4

- A broken real D is load-probed before any old real-directory return. A failed repair (source, pin, version, stage load, allocation or copy) returns nonzero before npm on both impossible and viable reinstall targets; npm leaves a matching-version real directory alone. An absent D or a symlink can still fall back to npm where the reinstall predicate allows it.
- P's version-mismatch preflight policy stays, including the dangling-link case.
- A marked B with an original and an absent D is restored in preflight before the ordinary deploy settings writes, and the attempt stops for a retry. A missing fetch cannot postpone this restore.
- Scanners keep exact owner and child-type checks. Dangling links count as occupied. Unknown destinations fail closed.
- An ordinary failed old-path `mv`, a failed status after a real rename, and an actual `exit 26` interruption after a real rename remain distinct oracles.
- Source, copied-stage and final `:memory:` load probes remain separate.
- The seed uses the shipped `$SRC/package-lock.json` pin, keeps the `node-red-node-sqlite` peer entry, validates before moving D, and probes its copied candidate or temporary firmware symlink under their different peer-resolution paths. A same-target replacement link cannot borrow the saved link identity.
- A no-B orphan marker is removed only after pin and final-load validation.
- Copied ownership markers are refused when present as a file, live symlink or dangling symlink. New markers are created with `O_CREAT|O_EXCL|O_NOFOLLOW` and re-read for exact bytes.
- A same-invocation final failure rolls back with the already validated pin and never fetches or reads the lock a second time.
- Restore requires a vacant D, records the original's device/inode, runs `mv` without `-T`, and compares the identity at D before B may be removed. An occupied D keeps B and reports the nested original. From R5, later runs keep that B as well.
- A proven metadata-only B is cleared without touching D, and the run stops for a retry (R4).
- Deploy stage cleanup keeps its original prefix boundary. A partial removal never counts as proof that bytes are intact.
- No database file, history row or other `node_modules` entry is touched.

## Literal mutation targets

The mutant preparer holds the exact old and new strings. Each mutant is prepared in a fresh copy of the four product and test files and tested alone; seed mutants change both mirrors identically. A setup error, missing test, timeout, wrapper refusal or surviving mutant stops the oracle; none counts as detection.

| ID | Literal change | Named test: first expected failing assertion |
|---|---|---|
| M01 | Return from the broken-real branch before repair. | `R2 RED broken matching-version real directory repairs before npm on impossible target`: `VERIFY_RC=0`. |
| M02 | Delete both installed entries before seed source validation. | `R2 RED absent seed source preserves both installed entries`: old sqlite3 and peer sentinel read. |
| M03 | Omit the copied-stage load probe in the seed. | `R2 copied seed stage uses installed peers and falls back to firmware link`: `SEED_RC=0`. |
| M04 | Ignore a deploy source version mismatch. | `R2 wrong firmware version and missing pin retain broken real bytes`: mismatch diagnostic. |
| M05 | Return before the same-invocation deploy rollback. | `R2 deploy final-path load fault restores old real directory`: old sentinel read. |
| M06 | Omit the fallback-link load probe. | `R3 failing fallback-link probe preserves the old seed entry`: nonzero `SEED_RC` (R6: the marker-file, refusal-message, old-bytes and stage assertions after it would also fail). |
| M07 | Skip the direct stale-stage glob. | `materialize_native_sqlite3 clears a staging directory left by a deploy killed mid-swap`: stale stage absent. |
| M08 | Remove the deploy copied-marker check and write through shell redirection. | `R3 copied deploy marker symlink cannot overwrite its target or the old module`: external target bytes. |
| M09 | The same unsafe marker write in the seed. | `R3 copied seed marker symlink cannot overwrite its target or the old module`: external seed target bytes. |
| M10 | Rescan and call interrupted deploy recovery on a same-invocation final failure. | `R3 deploy final failure restores old module without a second lock fetch`: old sentinel read. |
| M11 | Rescan and call interrupted seed recovery on a same-invocation final failure. | `R3 seed final failure restores old module after the source lock disappears`: old sentinel read. |
| M12 | Remove the deploy restored-identity comparison. | `R3 occupied deploy restore retains the marker and nested original for inspection`: retained rollback count. |
| M13 | Remove the seed restored-identity comparison. | `R3 occupied seed restore retains the marker and nested original for inspection`: retained rollback count. |
| M14 | Choose the installed package for a dangling link again. | `R4 dangling installed symlink still compares the firmware version before writes`: nonzero preflight status. |
| M15 | Refuse a metadata-only deploy rollback, as R3 did. | `R4 deploy metadata-only rollback after a failed or interrupted old-path rename clears and retries`: `cleared metadata-only` message. |
| M16 | Refuse a metadata-only seed rollback, as R3 did. | `R4 seed metadata-only rollback after a failed or interrupted old-path rename clears and retries`: `cleared metadata-only` message. |
| M17 | Classify every deploy rollback as metadata-only, ignoring a retained original. | `R4 deploy unsafe rollback states are retained, not cleared`: rollback contents unchanged. |
| M18 | The same misclassification in the seed. | `R4 seed unsafe rollback states are retained, not cleared`: rollback contents unchanged. |
| M19 | Remove the deploy nested-original exclusion, as in R4. | `R5 deploy occupied restore stays refused across fresh invocations`: no `cleared` message on the first fresh preflight. |
| M20 | Remove the seed nested-original exclusion, as in R4. | `R5 seed occupied restore stays refused across fresh invocations`: no `cleared` message on the next boot. |

M01–M09 and M12–M13 are unchanged from R3. M10 and M11 changed only their replacement text in R4 (author finding A2). M14–M18 each pair with an R4 test and are unchanged. M15's anchor is the clearing branch's `if` line, so its replacement skips the R5 check as well; its named test still fails on the missing `cleared metadata-only` message. M17 and M18 still reach the clearing step, because their fixture's D is a real module directory without an `original` entry; `rmdir` keeps the `original`, and the contents assertion detects the removed owner metadata. M19 and M20 restore the R4 behaviour exactly. The R5 check is the only difference, so under either mutant the clearing branch runs and prints its `cleared` message on the first fresh run.

R6 changes no mutant. In R5, M06's named test failed on the unmutated product at its stderr marker, so M06 could not have detected anything. R6 fixes that test and keeps the nonzero `SEED_RC` assertion first after the status check. Under M06 the seed promotes the firmware link without probing it, the final-path probe at D falls through the hook to a real load, which succeeds, and the seed returns 0. The first failing assertion is therefore still the nonzero `SEED_RC`, a product behaviour, not the fixture marker. The marker assertion after it would also fail, because the probe is never called. No mutant names any of the other three corrected tests.

## Execution order

Each step below is one command run on its own under the operator's resource wrapper. Record the direct status, the wrapper status and the full output of each. Whatever supervises a command must outlive the command's own timeout and its capture bound; in R5 the supervising shell stopped at the same length as the inner timeout and left a step with no exit status. `$OSI_302_REPO` is a fresh isolated checkout at P, never an author or main checkout. `$APPLY` and `$MUTANTS` are any byte-identical copies of the two embedded Python files; they verify themselves against the approved plan before acting.

1. **plan-only.** With `$OSI_302_REPO` clean at P, run `python3 -I "$APPLY" plan-only "$OSI_302_REPO"`. Expected: status 0, a `PROPOSED_PLAN_WRITTEN` receipt, and only the plan path new. Commit it alone with `git add` and `git commit -m 'docs: plan native sqlite3 recovery'`. Record the commit as `$PLAN_COMMIT` and the plan's blob and SHA-256.
2. **Council.** The three members review `$PLAN_COMMIT`. Nothing below runs until all three approve that exact commit with no open blocker or `should`.
3. **Refusal controls C1 and C2** against `$PLAN_COMMIT`, each expected to exit 1 with the checkout still clean.
4. **tests-first.** `python3 -I "$APPLY" tests-first "$OSI_302_REPO" --approved-plan-commit "$PLAN_COMMIT"`. Expected: status 0 and only the test file changed. Run `node --test --test-name-pattern='R2 RED' "$OSI_302_REPO/scripts/test-deploy-native-sqlite3.js"` under a timeout. Expected: nonzero, from the two named assertions reached with `PREFLIGHT_RC=0`, `MATERIALIZE_RC=0`, `VERIFY_RC=1`, `AFTER_MATERIALIZE`, `SEED_RC=0` and `AFTER_SEED` in their captures. A missing marker, a setup failure or a timeout does not count as RED. Commit only the test (`test: pin native sqlite3 recovery failures`) and record `$TEST_COMMIT`.
5. **product.** `python3 -I "$APPLY" product "$OSI_302_REPO" --approved-plan-commit "$PLAN_COMMIT"`. Expected: status 0 and `PROPOSED_PRODUCT_WRITTEN`. Run the whole file with `node --test` under a timeout. Expected: status 0 and 68 tests passing, none skipped. The 68 are P's 25 top-level tests minus the two that tests-first removes, plus the 45 appended (R2, R3, R4 and the two R5 tests). R5's 64-of-67 diagnostic is not a result for this step. Any deviation stops for an amended plan and a fresh review. Commit deploy and both seeds (`fix: recover native sqlite3 before npm and preserve seed entries`) and record `$CANDIDATE`.
6. **verify-candidate.** `python3 -I "$APPLY" verify-candidate "$OSI_302_REPO" --approved-plan-commit "$PLAN_COMMIT"`. Expected: `CANDIDATE_MATCHES_APPROVED_PLAN`.
7. **Mutants.** Make a fresh token root. Run control C3 first. Then, for each of M01–M20 in turn: `python3 -I "$MUTANTS" MNN "$OSI_302_REPO" "$TOKEN_ROOT" "$CANDIDATE" "$PLAN_COMMIT"`, expecting `MUTANT_READY`, followed by `node --test --test-name-pattern='<named test>' "$TOKEN_ROOT/mutant-MNN/scripts/test-deploy-native-sqlite3.js"` under a timeout, expecting nonzero from the named assertion with the test actually reached.
8. **Independent verification** at `$CANDIDATE`, each command run separately under its own timeout:
   - `node --test scripts/test-deploy-native-sqlite3.js` (the native suite, including its call-order assertions);
   - `node scripts/verify-profile-parity.js`;
   - `node --test scripts/test-deploy-migration-wiring.js`;
   - `node --test scripts/test-deploy-fresh-install.js`;
   - `git diff --check P..$CANDIDATE`;
   - the public-prose checks on the plan (`slop-check.js`, `verify-doc-hygiene.js`).

   The fresh-install harness extracts deploy's unchanged schema and ledger bodies and keeps its baseline tripwire. It is not a native-module or full-boot test. The seed helper loop is unchanged, so by source reading the seed consumer strings checked by `verify-sync-flow.js`, helper registration and heartbeat, and the binding-before-ledger order, are unaffected; none of this has run. No schema, flow, GUI or command-ledger pin gate applies to this scope.

The execution record keeps every attempt, including failed ones, and removes only scratch it owns after cleanup is confirmed.

## Review gates still required

These earlier statements are superseded: that #309 owned the executable lane, that an exact-head Opus review would follow candidate execution, and that the third council member was unresolved after a Gemini Argon tool-schema error. They were current on the morning of 2026-10-28. Later that day the maintainer named DeepSeek V4 Pro on OpenCode Go as the third council member in place of Gemini Argon. The maintainer also set independent Sol verification as the final review for new Opus-authored work, with no separate final Opus round. Three-provider councils remain required.

The non-author source review of R4 on 2026-10-28 returned CHANGES with the one `should` answered in R5. It consumed no council round.

Council round 2 reviewed R: Sol, Claude Fable and DeepSeek V4 Pro each voted APPROVE 9/10 with no blocker or `should`. Those votes approve R only. They do not approve R6 or any candidate. Two of the five rounds are used, and a source amendment does not reset the cap.

Before council round 3:

- A fresh non-author source acceptance of this R6 packet. The author's reading of the four corrections against the product text is not that review.
- Plan-only materialisation and commit of the exact R6 packet as a new sole child of P in a fresh checkout, with the public-prose checks (`slop-check.js`, `verify-doc-hygiene.js`) and `git diff --check` on the committed plan. The author did not run them, nor any test, syntax check or apply mode on the R6 files.

Then council round 3 on that exact plan commit: Sol, Claude Fable and DeepSeek V4 Pro, with the round-1 and round-2 results, the R5 execution findings and these corrections in the brief. All three must approve the same head with no open blocker or `should`. A plan-head approval does not approve the later candidate head. The candidate gets independent Sol verification after execution, and any behaviour change after that needs its own applicable review.

## Outside this plan

- **#343 runtime.** The Node 20.18.3 transitional target belongs to #343. The source relies on Linux `O_NOFOLLOW` and `O_EXCL` opens, BigInt `lstat` fields and `Buffer.subarray`; the tests use `fs.cpSync` and `replaceAll`. These exist on Node 20 and 22, but nothing here has run on 20.18.3, on BusyBox `sh`, against the native module, on a built image or on a gateway. #343's later `deploy.sh` edits land on the exact base that includes this change, in order. No runtime target upgrade is part of #302.
- **Durability.** No step calls `fsync`. Power-loss ordering beyond rename atomicity is not claimed.
- **Cross-tool leftovers.** Deploy and seed use different rollback prefixes, and neither scans the other's. If a seed is interrupted after its old-path rename and a deploy then installs a fresh module, the next boot's seed finds its original beside a final it does not own. It refuses on every boot and keeps both until an operator inspects them. R5 does not change this; it is listed for the council.
- **Occupied-restore inspection.** From R5, a refused occupied restore is also kept until an operator inspects it, on deploy and on every boot. The plan adds no automatic resolution.
- **Concurrency.** One deploy or seed at a time is assumed. R5 adds no lock.


## Deploy source replacement

```sh
# Native sqlite3 recovery. The preflight runs before the first deploy write.
# It may restore a scanner-validated interrupted swap or clear a rollback
# directory proven to hold only owner metadata; either way it stops before the
# ordinary deploy writes and the deploy has to be run again. A rollback
# directory left by a restore that found its destination occupied is kept,
# and every later deploy refuses until it is inspected. Materialisation
# repairs a broken real directory or a symlink from the firmware module before
# npm runs, keeps the old entry in a marked rollback directory until the new
# one passes the lockfile pin and opens :memory:, and refuses npm when a known
# broken directory could not be repaired.

native_sqlite3_report_paths() {
    for ns_report in "$@"; do
        if [ -L "$ns_report" ]; then ns_kind=symlink
        elif [ -d "$ns_report" ]; then ns_kind=directory
        elif [ -f "$ns_report" ]; then ns_kind=file
        elif [ -p "$ns_report" ]; then ns_kind=fifo
        elif [ -e "$ns_report" ]; then ns_kind=other
        else ns_kind=absent
        fi
        echo "STATE: $ns_kind $ns_report" >&2
    done
}

native_sqlite3_pkg_version() {
    node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || ""' "$1/package.json" 2>/dev/null || true
}

native_sqlite3_exact_file() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    node -e 'const f=require("fs"); const b=f.readFileSync(process.argv[1]); if (!b.equals(Buffer.from(process.argv[2]+"\n"))) process.exit(1)' "$1" "$2"
}

native_sqlite3_present() {
    [ -e "$1" ] || [ -L "$1" ]
}

native_sqlite3_id() {
    node -p 'const s=require("fs").lstatSync(process.argv[1],{bigint:true}); [s.dev,s.ino].join(":")' "$1" 2>/dev/null
}

native_sqlite3_new_exact_file() {
    native_new_path="$1"
    native_new_value="$2"
    native_sqlite3_present "$native_new_path" && return 1
    node -e 'const f=require("fs"),c=f.constants; const p=process.argv[1],v=process.argv[2]+"\n"; const fd=f.openSync(p,c.O_WRONLY|c.O_CREAT|c.O_EXCL|c.O_NOFOLLOW,0o600); try { f.writeFileSync(fd,v); } finally { f.closeSync(fd); }' "$native_new_path" "$native_new_value" || return 1
    native_sqlite3_exact_file "$native_new_path" "$native_new_value"
}

# True for a regular file holding a strict prefix (possibly empty) of the
# owner line: what an interrupted owner write leaves behind.
native_sqlite3_owner_prefix() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    node -e 'const b=require("fs").readFileSync(process.argv[1]); const w=Buffer.from(process.argv[2]+"\n"); if (!(b.length < w.length && b.equals(w.subarray(0, b.length)))) process.exit(1)' "$1" "$2"
}

native_sqlite3_restore_original() {
    native_restore_o="$1"
    native_restore_d="$2"
    if ! native_sqlite3_present "$native_restore_o" || native_sqlite3_present "$native_restore_d"; then
        echo "ERROR: sqlite3 restore needs an original and vacant destination" >&2
        native_sqlite3_report_paths "$native_restore_o" "$native_restore_d"
        return 1
    fi
    native_restore_id="$(native_sqlite3_id "$native_restore_o")"
    if [ -z "$native_restore_id" ]; then
        echo "ERROR: cannot identify sqlite3 original before restore: $native_restore_o" >&2
        return 1
    fi
    if ! mv "$native_restore_o" "$native_restore_d"; then
        echo "ERROR: sqlite3 restore command failed; inspect surviving paths" >&2
        native_sqlite3_report_paths "$native_restore_o" "$native_restore_d" "$native_restore_d/original"
        return 1
    fi
    if native_sqlite3_present "$native_restore_o" || ! native_sqlite3_present "$native_restore_d" ||
       [ "$(native_sqlite3_id "$native_restore_d")" != "$native_restore_id" ]; then
        echo "ERROR: sqlite3 restore identity differs; retained rollback marker for inspection" >&2
        native_sqlite3_report_paths "$native_restore_o" "$native_restore_d" "$native_restore_d/original"
        return 1
    fi
    return 0
}

# Sets NS_B to the single rollback directory, NS_B_EXACT=1 when its owner
# line is complete, and NS_B_META=1 when it holds no original.
native_sqlite3_scan_backup() {
    NS_B=''
    NS_B_META=0
    NS_B_EXACT=0
    ns_root="$NODE_RED_ROOT/node_modules"
    for ns_b in "$ns_root"/.osi-sqlite3-rollback.*; do
        native_sqlite3_present "$ns_b" || continue
        if [ -n "$NS_B" ] || [ ! -d "$ns_b" ] || [ -L "$ns_b" ]; then
            echo "ERROR: ambiguous sqlite3 rollback entry: $ns_b" >&2
            return 1
        fi
        for ns_child in "$ns_b"/* "$ns_b"/.[!.]* "$ns_b"/..?*; do
            native_sqlite3_present "$ns_child" || continue
            case "$ns_child" in
                "$ns_b/.owner")
                    if [ ! -f "$ns_child" ] || [ -L "$ns_child" ]; then
                        echo "ERROR: invalid sqlite3 rollback owner type: $ns_child" >&2
                        return 1
                    fi
                    ;;
                "$ns_b/original")
                    if [ ! -d "$ns_child" ] && [ ! -L "$ns_child" ]; then
                        echo "ERROR: invalid sqlite3 original type: $ns_child" >&2
                        return 1
                    fi
                    ;;
                *) echo "ERROR: unknown sqlite3 rollback child: $ns_child" >&2; return 1 ;;
            esac
        done
        ns_b_exact=0
        if native_sqlite3_exact_file "$ns_b/.owner" 'osi-sqlite3-deploy-v2'; then
            ns_b_exact=1
        elif native_sqlite3_present "$ns_b/original" ||
             { native_sqlite3_present "$ns_b/.owner" &&
               ! native_sqlite3_owner_prefix "$ns_b/.owner" 'osi-sqlite3-deploy-v2'; }; then
            # The owner line is complete before anything moves into the backup,
            # so only an absent or truncated owner beside no original is ours.
            echo "ERROR: unowned sqlite3 rollback entry: $ns_b" >&2
            return 1
        fi
        NS_B_EXACT="$ns_b_exact"
        NS_B_META=0
        if ! native_sqlite3_present "$ns_b/original"; then NS_B_META=1; fi
        NS_B="$ns_b"
    done
    return 0
}

# Removes a rollback directory the scan proved to hold at most owner metadata.
# rmdir refuses a directory that gained any other entry since that scan.
native_sqlite3_clear_metadata_backup() {
    if ! rm -f "$NS_B/.owner" || ! rmdir "$NS_B" || native_sqlite3_present "$NS_B"; then
        echo "ERROR: metadata-only sqlite3 rollback cleanup failed or was partial; inspect $NS_B" >&2
        native_sqlite3_report_paths "$NS_B" "$NS_B/.owner"
        return 1
    fi
    return 0
}

native_sqlite3_owned_final() {
    ns_final="$NODE_RED_ROOT/node_modules/sqlite3"
    [ -d "$ns_final" ] && [ ! -L "$ns_final" ] || return 1
    native_sqlite3_exact_file "$ns_final/.osi-sqlite3-candidate-owner" "$1"
}

native_sqlite3_recovery_lock() {
    NS_LOCKED=''
    ns_lock="$TMP_DIR/preflight-package-lock.json"
    if ! fetch 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json' "$ns_lock"; then
        echo 'ERROR: could not fetch the shipped package-lock.json for sqlite3 recovery' >&2
        return 1
    fi
    if ! NS_LOCKED="$(node -p 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const p=(l.packages&&l.packages["node_modules/sqlite3"])||{}; p.version||""' "$ns_lock" 2>/dev/null)"; then
        echo 'ERROR: shipped package-lock.json is not valid JSON during sqlite3 recovery' >&2
        return 1
    fi
    if [ -z "$NS_LOCKED" ]; then
        echo 'ERROR: shipped package-lock.json has no sqlite3 pin during recovery' >&2
        return 1
    fi
    return 0
}

native_sqlite3_recover_early() {
    ns_d="$NODE_RED_ROOT/node_modules/sqlite3"
    ns_o="$NS_B/original"
    if [ "$NS_B_META" = 1 ] && ! native_sqlite3_owned_final "$NS_B"; then
        # Nothing is left in this backup and the final path is not its
        # candidate: the old-path rename never ran, or an earlier rollback
        # already put the original back. Only owner metadata remains.
        # A restore into an occupied final path moves the original to
        # $ns_d/original instead. That backup stays as the record of the
        # refused restore: clearing it would let the next ordinary repair
        # move the occupant, with the original inside, into a new backup and
        # delete it.
        if native_sqlite3_present "$ns_d/original"; then
            echo "ERROR: $ns_d/original is present beside metadata-only rollback $NS_B; an earlier restore may have nested the old module there; preserving both for inspection" >&2
            native_sqlite3_report_paths "$NS_B" "$ns_d" "$ns_d/original"
            return 1
        fi
        native_sqlite3_clear_metadata_backup || return 1
        if native_sqlite3_present "$ns_d"; then
            echo "WARN: cleared metadata-only sqlite3 rollback; $ns_d was not touched; retry deploy" >&2
        else
            echo 'WARN: cleared marker-only sqlite3 rollback; retry deploy' >&2
        fi
        return 1
    fi
    if [ "$NS_B_EXACT" != 1 ]; then
        echo "ERROR: sqlite3 rollback owner metadata is incomplete beside an owned final: $NS_B" >&2
        return 1
    fi
    if native_sqlite3_present "$ns_o" && ! native_sqlite3_present "$ns_d"; then
        native_sqlite3_restore_original "$ns_o" "$ns_d" || return 1
        if ! rm -rf "$NS_B"; then
            echo "ERROR: sqlite3 rollback cleanup failed; inspect surviving paths in $NS_B" >&2
            return 1
        fi
        echo "WARN: restored interrupted sqlite3 swap at $ns_d; retry deploy" >&2
        return 1
    fi
    if ! native_sqlite3_present "$ns_d"; then
        echo "ERROR: sqlite3 rollback state is not recognised: $NS_B" >&2
        return 1
    fi
    if ! native_sqlite3_owned_final "$NS_B"; then
        echo "ERROR: sqlite3 final path is not owned by rollback $NS_B; preserving both" >&2
        return 1
    fi
    native_sqlite3_recovery_lock || return 1
    if [ "$(native_sqlite3_pkg_version "$ns_d")" = "$NS_LOCKED" ] && native_sqlite3_dir_loads "$ns_d" >/dev/null 2>&1; then
        if ! rm -rf "$NS_B"; then
            echo "ERROR: verified sqlite3 is installed but old backup cleanup partially failed; inspect $NS_B" >&2
            return 1
        fi
        if ! rm -f "$ns_d/.osi-sqlite3-candidate-owner"; then
            echo "ERROR: verified sqlite3 orphan marker cleanup failed: $ns_d" >&2
            return 1
        fi
        echo "WARN: verified interrupted sqlite3 promotion; retry deploy" >&2
        return 1
    fi
    if ! rm -rf "$ns_d" || native_sqlite3_present "$ns_d"; then
        echo "ERROR: promoted sqlite3 removal failed or was partial; inspect $ns_d and $NS_B" >&2
        return 1
    fi
    if native_sqlite3_present "$ns_o"; then
        native_sqlite3_restore_original "$ns_o" "$ns_d" || return 1
    fi
    if ! rm -rf "$NS_B"; then
        echo "ERROR: sqlite3 rollback cleanup may be partial; inspect $NS_B" >&2
        return 1
    fi
    echo "ERROR: invalid interrupted sqlite3 candidate rolled back; retry deploy" >&2
    return 1
}

native_sqlite3_rollback_failed_final() {
    native_failed_b="$1"
    native_failed_d="$NODE_RED_ROOT/node_modules/sqlite3"
    if [ -z "$NS_LOCKED" ] ||
       ! native_sqlite3_exact_file "$native_failed_b/.owner" 'osi-sqlite3-deploy-v2' ||
       ! native_sqlite3_owned_final "$native_failed_b"; then
        echo "ERROR: failed final sqlite3 is not owned by this validated attempt; inspect $native_failed_b and $native_failed_d" >&2
        return 1
    fi
    if ! rm -rf "$native_failed_d" || native_sqlite3_present "$native_failed_d"; then
        echo "ERROR: failed final sqlite3 removal may be partial; inspect $native_failed_d and $native_failed_b" >&2
        return 1
    fi
    if native_sqlite3_present "$native_failed_b/original"; then
        native_sqlite3_restore_original "$native_failed_b/original" "$native_failed_d" || return 1
    fi
    if ! rm -rf "$native_failed_b"; then
        echo "ERROR: sqlite3 rollback cleanup may be partial: $native_failed_b" >&2
        return 1
    fi
    echo 'ERROR: failed final sqlite3 rolled back using the validated attempt pin; retry deploy' >&2
    return 1
}

native_sqlite3_unrepaired() {
    echo "WARN: sqlite3 was not repaired: $1" >&2
    if [ "$2" = 1 ] || native_sqlite3_reinstall_impossible; then
        echo 'ERROR: refusing to continue to npm with an unrepaired sqlite3 path' >&2
        return 1
    fi
    echo 'SKIP: npm may replace or supply sqlite3; post-npm verification remains required'
    return 0
}

run_native_sqlite3_preflight() {
    echo '--- Native sqlite3 preflight ---'
    NS_LOCKED=''
    native_sqlite3_scan_backup || return 1
    if [ -n "$NS_B" ]; then
        # This is the only preflight path allowed to restore a module or clear
        # a rollback directory. It always stops before the ordinary deploy
        # writes and requires a retry.
        native_sqlite3_recover_early
        return 1
    fi
    nsp_installed="$NODE_RED_ROOT/node_modules/sqlite3"
    if native_sqlite3_present "$nsp_installed" &&
       [ ! -d "$nsp_installed" ] && [ ! -L "$nsp_installed" ]; then
        echo "ERROR: unexpected sqlite3 destination type before deploy writes: $nsp_installed" >&2
        return 1
    fi
    if [ -d "$nsp_installed" ] && [ ! -L "$nsp_installed" ] && native_sqlite3_present "$nsp_installed/.osi-sqlite3-candidate-owner"; then
        nsp_marker="$nsp_installed/.osi-sqlite3-candidate-owner"
        if [ ! -f "$nsp_marker" ] || [ -L "$nsp_marker" ]; then
            echo "ERROR: invalid orphan sqlite3 candidate marker: $nsp_marker" >&2
            return 1
        fi
        nsp_named="$(cat "$nsp_marker" 2>/dev/null || true)"
        case "$nsp_named" in "$NODE_RED_ROOT/node_modules"/.osi-sqlite3-rollback.*) ;; *) echo 'ERROR: invalid orphan sqlite3 backup name' >&2; return 1 ;; esac
        if native_sqlite3_present "$nsp_named" || ! native_sqlite3_exact_file "$nsp_marker" "$nsp_named"; then
            echo 'ERROR: orphan sqlite3 marker does not name an absent owned backup' >&2
            return 1
        fi
        native_sqlite3_recovery_lock || return 1
        if [ "$(native_sqlite3_pkg_version "$nsp_installed")" != "$NS_LOCKED" ] || ! native_sqlite3_dir_loads "$nsp_installed" >/dev/null 2>&1; then
            echo 'ERROR: orphan-marked sqlite3 failed pin/load validation; retaining it' >&2
            return 1
        fi
        if ! rm -f "$nsp_marker"; then
            echo "ERROR: could not remove verified orphan marker: $nsp_marker" >&2
            return 1
        fi
    fi
    nsp_which=installed
    nsp_pkg=''
    # A dangling symlink is not a module. As at P, it falls through to the
    # firmware version, which is the one materialisation would install.
    if [ -e "$nsp_installed" ]; then
        nsp_pkg="$nsp_installed/package.json"
    elif [ -d "$NATIVE_SQLITE3_FIRMWARE_DIR" ] && [ ! -L "$NATIVE_SQLITE3_FIRMWARE_DIR" ]; then
        nsp_which=firmware
        nsp_pkg="$NATIVE_SQLITE3_FIRMWARE_DIR/package.json"
    fi
    if [ -z "$nsp_pkg" ]; then
        echo 'SKIP: no sqlite3 module or firmware source; npm install will provide one'
        return 0
    fi
    nsp_lock="$TMP_DIR/preflight-package-lock.json"
    if ! fetch 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json' "$nsp_lock"; then
        echo 'ERROR: could not fetch the shipped package-lock.json for the sqlite3 preflight; refusing to start the deploy; nothing has been changed' >&2
        return 1
    fi
    if ! NS_LOCKED="$(node -p 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const p = (l.packages && l.packages["node_modules/sqlite3"]) || {}; p.version || ""' "$nsp_lock" 2>/dev/null)"; then
        echo 'ERROR: the shipped package-lock.json is not valid JSON; refusing to start the deploy; nothing has been changed' >&2
        return 1
    fi
    nsp_have="$(native_sqlite3_pkg_version "$(dirname "$nsp_pkg")")"
    if [ -z "$NS_LOCKED" ]; then
        echo 'WARN: the shipped package-lock.json pins no sqlite3 version; skipping the preflight'
        return 0
    fi
    if [ -z "$nsp_have" ]; then
        echo "WARN: could not read the $nsp_which sqlite3 version from $nsp_pkg; skipping the preflight"
        return 0
    fi
    if [ "$nsp_have" = "$NS_LOCKED" ]; then
        echo "OK: $nsp_which sqlite3 $nsp_have matches the shipped lockfile"
        return 0
    fi
    if native_sqlite3_reinstall_impossible; then
        echo "ERROR: this gateway's $nsp_which sqlite3 is $nsp_have but the shipped package-lock.json pins sqlite3 $NS_LOCKED." >&2
        echo "ERROR: npm would have to install sqlite3 itself, and on $NATIVE_ARCH + musl no sqlite3 prebuilt is published and this gateway has no build toolchain, so that can only fail." >&2
        echo "ERROR: refusing to start the deploy; nothing has been changed. Ship an image whose node-red-node-sqlite provides sqlite3 $NS_LOCKED, or pin the lockfile back to $nsp_have." >&2
        return 1
    fi
    echo "WARN: the $nsp_which sqlite3 $nsp_have differs from the locked $NS_LOCKED; npm will install it, which needs registry access and a prebuilt for this platform"
    return 0
}

materialize_native_sqlite3() {
    echo '--- Native sqlite3 module (materialise before npm) ---'
    mns_modules="$NODE_RED_ROOT/node_modules"
    mns_path="$mns_modules/sqlite3"
    native_sqlite3_scan_backup || return 1
    if [ -n "$NS_B" ]; then
        echo "ERROR: sqlite3 rollback appeared after preflight: $NS_B" >&2
        return 1
    fi
    for mns_stale in "$mns_modules"/.osi-sqlite3-stage.*; do
        native_sqlite3_present "$mns_stale" || continue
        if [ ! -d "$mns_stale" ] || [ -L "$mns_stale" ]; then
            echo "ERROR: unexpected sqlite3 stage type: $mns_stale" >&2
            return 1
        fi
        echo "WARN: removing a staging directory left behind by an interrupted deploy: $mns_stale" >&2
        if ! rm -rf "$mns_stale" || native_sqlite3_present "$mns_stale"; then
            echo "ERROR: sqlite3 stage cleanup failed or was partial: $mns_stale" >&2
            return 1
        fi
    done
    mns_broken_real=0
    mns_source=''
    if [ -L "$mns_path" ]; then
        mns_source="$(readlink -f "$mns_path" 2>/dev/null || true)"
        if [ -z "$mns_source" ] || [ ! -d "$mns_source" ]; then
            echo "WARN: dangling symlink at $mns_path; it does not resolve to a sqlite3 module" >&2
            mns_source=''
        elif [ "$mns_source" != "$NATIVE_SQLITE3_FIRMWARE_DIR" ]; then
            echo "NOTE: resolved sqlite3 symlink source is noncanonical: $mns_source" >&2
        fi
    elif [ -d "$mns_path" ]; then
        if native_sqlite3_dir_loads "$mns_path" >/dev/null 2>&1; then
            echo "OK: $mns_path is already a real directory and loads; nothing to do"
            return 0
        fi
        mns_broken_real=1
    elif native_sqlite3_present "$mns_path"; then
        echo "ERROR: unexpected sqlite3 destination type: $mns_path" >&2
        return 1
    fi
    if [ -z "$mns_source" ]; then
        mns_source="$NATIVE_SQLITE3_FIRMWARE_DIR"
    fi
    if [ ! -d "$mns_source" ] || [ -L "$mns_source" ]; then
        if [ -L "$mns_path" ] && [ "$mns_broken_real" = 0 ] && ! native_sqlite3_reinstall_impossible; then
            if ! rm -f "$mns_path" || native_sqlite3_present "$mns_path"; then
                echo 'ERROR: could not remove dangling sqlite3 symlink' >&2
                return 1
            fi
        fi
        native_sqlite3_unrepaired 'firmware source absent' "$mns_broken_real"
        return $?
    fi
    if [ -z "$NS_LOCKED" ] || [ "$(native_sqlite3_pkg_version "$mns_source")" != "$NS_LOCKED" ]; then
        native_sqlite3_unrepaired 'source pin missing or source version mismatch' "$mns_broken_real"
        return $?
    fi
    if ! native_sqlite3_dir_loads "$mns_source" 2>"$TMP_DIR/sqlite3-source-load.err"; then
        echo "WARN: source sqlite3 does not open :memory: at $mns_source" >&2
        tail -5 "$TMP_DIR/sqlite3-source-load.err" >&2 || true
        native_sqlite3_unrepaired 'source load failed' "$mns_broken_real"
        return $?
    fi
    mns_need_kb="$(du -sk "$mns_source" 2>/dev/null | awk '{print $1}')"
    case "$mns_need_kb" in ''|*[!0-9]*) mns_need_kb=0 ;; esac
    mns_avail_kb="$(df -k "$mns_modules" 2>/dev/null | tail -1 | awk '{print $4}')"
    case "$mns_avail_kb" in ''|*[!0-9]*) mns_avail_kb=0 ;; esac
    if [ "$mns_avail_kb" -gt 0 ] && [ "$mns_avail_kb" -lt $((mns_need_kb + 51200)) ]; then
        echo "ERROR: $mns_modules has ${mns_avail_kb}K free; materialising sqlite3 needs ${mns_need_kb}K plus 50M of headroom" >&2
        return 1
    fi
    mkdir -p "$mns_modules" || return 1
    mns_stage="$(mktemp -d "$mns_modules/.osi-sqlite3-stage.XXXXXX" 2>/dev/null || true)"
    if [ -z "$mns_stage" ] || [ ! -d "$mns_stage" ] || [ -L "$mns_stage" ]; then
        echo 'ERROR: could not create sqlite3 stage' >&2
        return 1
    fi
    if ! cp -a "$mns_source/." "$mns_stage/"; then
        if ! rm -rf "$mns_stage" || native_sqlite3_present "$mns_stage"; then
            echo "ERROR: sqlite3 copy failed and stage cleanup may be partial: $mns_stage" >&2
        else
            echo 'ERROR: could not copy sqlite3 into stage' >&2
        fi
        return 1
    fi
    if ! native_sqlite3_dir_loads "$mns_stage" 2>"$TMP_DIR/sqlite3-stage-load.err"; then
        if ! rm -rf "$mns_stage" || native_sqlite3_present "$mns_stage"; then
            echo "ERROR: staged sqlite3 failed load and cleanup may be partial: $mns_stage" >&2
            return 1
        fi
        tail -5 "$TMP_DIR/sqlite3-stage-load.err" >&2 || true
        native_sqlite3_unrepaired 'staged copy load failed under installed peers' "$mns_broken_real"
        return $?
    fi
    mns_marker="$mns_stage/.osi-sqlite3-candidate-owner"
    if native_sqlite3_present "$mns_marker"; then
        echo "ERROR: copied sqlite3 stage already contains an ownership marker: $mns_marker" >&2
        return 1
    fi
    mns_backup="$(mktemp -d "$mns_modules/.osi-sqlite3-rollback.XXXXXX" 2>/dev/null || true)"
    if [ -z "$mns_backup" ] || [ ! -d "$mns_backup" ] || [ -L "$mns_backup" ]; then
        echo "ERROR: could not allocate sqlite3 rollback; stage retained at $mns_stage" >&2
        return 1
    fi
    if ! printf '%s\n' 'osi-sqlite3-deploy-v2' > "$mns_backup/.owner" ||
       ! native_sqlite3_new_exact_file "$mns_marker" "$mns_backup"; then
        echo "ERROR: sqlite3 ownership marker failed; inspect $mns_backup and $mns_stage" >&2
        return 1
    fi
    if native_sqlite3_present "$mns_path"; then
        if [ ! -d "$mns_path" ] && [ ! -L "$mns_path" ]; then
            echo "ERROR: unexpected sqlite3 destination before swap: $mns_path" >&2
            return 1
        fi
        if ! mv "$mns_path" "$mns_backup/original"; then
            echo "ERROR: old sqlite3 rename reported failure; inspect $mns_path, $mns_backup/original and $mns_stage" >&2
            native_sqlite3_report_paths "$mns_path" "$mns_backup/original" "$mns_stage" "$mns_backup/.owner"
            return 1
        fi
        if native_sqlite3_present "$mns_path" || ! native_sqlite3_present "$mns_backup/original"; then
            echo "ERROR: old sqlite3 rename left ambiguous state: $mns_backup" >&2
            return 1
        fi
    fi
    if native_sqlite3_present "$mns_path"; then
        echo "ERROR: sqlite3 destination appeared before promotion: $mns_path" >&2
        return 1
    fi
    if ! mv "$mns_stage" "$mns_path"; then
        echo "ERROR: sqlite3 stage rename reported failure; inspect $mns_stage, $mns_path and $mns_backup" >&2
        native_sqlite3_report_paths "$mns_stage" "$mns_path" "$mns_backup/original" "$mns_backup/.owner"
        return 1
    fi
    if native_sqlite3_present "$mns_stage" || ! native_sqlite3_owned_final "$mns_backup"; then
        echo "ERROR: sqlite3 promotion left ambiguous state: $mns_backup" >&2
        return 1
    fi
    if [ "$(native_sqlite3_pkg_version "$mns_path")" != "$NS_LOCKED" ] ||
       ! native_sqlite3_dir_loads "$mns_path" >/dev/null 2>&1; then
        echo "ERROR: promoted sqlite3 failed final pin/load; rollback retained at $mns_backup" >&2
        native_sqlite3_rollback_failed_final "$mns_backup"
        return 1
    fi
    if ! rm -rf "$mns_backup"; then
        echo "ERROR: verified sqlite3 installed but rollback cleanup may be partial: $mns_backup" >&2
        return 1
    fi
    if ! rm -f "$mns_path/.osi-sqlite3-candidate-owner"; then
        echo "ERROR: verified sqlite3 installed but orphan marker removal failed: $mns_path" >&2
        return 1
    fi
    mns_owner="$(ls -ld "$mns_modules" 2>/dev/null | awk '{print $3 ":" $4}')"
    case "$mns_owner" in ''|:*|*:) ;; *) chown -R "$mns_owner" "$mns_path" 2>/dev/null || true ;; esac
    echo "OK: materialised $mns_path from $mns_source (${mns_need_kb}K); npm now leaves the native module alone"
    return 0
}

```


## Mirrored seed operation

```sh
# Native sqlite must come from the OpenWrt package built for the target CPU.
# npm leaves a real directory at the locked version alone and retires a
# symlink, so the block below installs a verified real copy when it can and a
# verified firmware symlink only as a temporary fallback. It checks the
# firmware module against the image's package-lock pin before it replaces
# anything, keeps the old entry in a marked rollback directory until the
# replacement opens :memory:, and never removes the node-red-node-sqlite peer
# entry. A rollback directory left by a restore that found its destination
# occupied is kept and refused on every run until it is inspected.
# A refusal, or a recovery step that asks for a retry, exits 1: the
# rest of this script is skipped for this boot and OpenWrt keeps the defaults
# script, so it runs again on the next boot.
# BEGIN native sqlite3 seed
seed_sqlite3_report_paths() {
    for seed_report in "$@"; do
        if [ -L "$seed_report" ]; then seed_kind=symlink
        elif [ -d "$seed_report" ]; then seed_kind=directory
        elif [ -f "$seed_report" ]; then seed_kind=file
        elif [ -p "$seed_report" ]; then seed_kind=fifo
        elif [ -e "$seed_report" ]; then seed_kind=other
        else seed_kind=absent
        fi
        echo "STATE: $seed_kind $seed_report" >&2
    done
}
seed_sqlite3_present() { [ -e "$1" ] || [ -L "$1" ]; }
seed_sqlite3_new_exact_file() {
    seed_new_path="$1"
    seed_new_value="$2"
    seed_sqlite3_present "$seed_new_path" && return 1
    node -e 'const f=require("fs"),c=f.constants; const p=process.argv[1],v=process.argv[2]+"\n"; const fd=f.openSync(p,c.O_WRONLY|c.O_CREAT|c.O_EXCL|c.O_NOFOLLOW,0o600); try { f.writeFileSync(fd,v); } finally { f.closeSync(fd); }' "$seed_new_path" "$seed_new_value" || return 1
    seed_sqlite3_exact_file "$seed_new_path" "$seed_new_value"
}
seed_sqlite3_exact_file() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    node -e 'const f=require("fs"); const b=f.readFileSync(process.argv[1]); if (!b.equals(Buffer.from(process.argv[2]+"\n"))) process.exit(1)' "$1" "$2"
}
# A regular file holding a strict prefix (possibly empty) of an owner line:
# what an interrupted owner write leaves behind.
seed_sqlite3_owner_prefix() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    node -e 'const b=require("fs").readFileSync(process.argv[1]); const w=Buffer.from(process.argv[2]+"\n"); if (!(b.length < w.length && b.equals(w.subarray(0, b.length)))) process.exit(1)' "$1" "$2"
}
seed_sqlite3_id() {
    node -p 'const s=require("fs").lstatSync(process.argv[1],{bigint:true}); [s.dev,s.ino,s.mtimeNs].join(":")' "$1" 2>/dev/null
}
seed_sqlite3_restore_id() {
    node -p 'const s=require("fs").lstatSync(process.argv[1],{bigint:true}); [s.dev,s.ino].join(":")' "$1" 2>/dev/null
}
seed_sqlite3_restore_original() {
    seed_restore_o="$1"
    seed_restore_d="$2"
    if ! seed_sqlite3_present "$seed_restore_o" || seed_sqlite3_present "$seed_restore_d"; then
        echo 'ERROR: seed restore needs an original and vacant destination' >&2
        seed_sqlite3_report_paths "$seed_restore_o" "$seed_restore_d"
        return 1
    fi
    seed_restore_expected="$(seed_sqlite3_restore_id "$seed_restore_o")"
    if [ -z "$seed_restore_expected" ]; then
        echo "ERROR: cannot identify seed original before restore: $seed_restore_o" >&2
        return 1
    fi
    if ! mv "$seed_restore_o" "$seed_restore_d"; then
        echo 'ERROR: seed restore command failed; inspect surviving paths' >&2
        seed_sqlite3_report_paths "$seed_restore_o" "$seed_restore_d" "$seed_restore_d/original"
        return 1
    fi
    if seed_sqlite3_present "$seed_restore_o" || ! seed_sqlite3_present "$seed_restore_d" ||
       [ "$(seed_sqlite3_restore_id "$seed_restore_d")" != "$seed_restore_expected" ]; then
        echo 'ERROR: seed restore identity differs; retained rollback marker for inspection' >&2
        seed_sqlite3_report_paths "$seed_restore_o" "$seed_restore_d" "$seed_restore_d/original"
        return 1
    fi
    return 0
}
seed_sqlite3_exact_id_file() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    node -e 'const b=require("fs").readFileSync(process.argv[1]); if (!/^[0-9]+:[0-9]+:[0-9]+\n$/.test(b.toString("utf8")) || !b.equals(Buffer.from(b.toString("utf8")))) process.exit(1)' "$1"
}
# A regular file holding a strict prefix of a dev:ino:mtime identity line,
# without its newline: what an interrupted identity write leaves behind.
seed_sqlite3_id_prefix() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    node -e 'const s=require("fs").readFileSync(process.argv[1]).toString("latin1"); if (!/^[0-9]*(:[0-9]*){0,2}$/.test(s)) process.exit(1)' "$1"
}
seed_sqlite3_version() {
    node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version || ""' "$1/package.json" 2>/dev/null || true
}
seed_sqlite3_loads() {
    node -e '
      const sqlite3 = require(process.argv[1]);
      const db = new sqlite3.Database(":memory:", function (err) {
        if (err) { console.error("sqlite3 could not open :memory: -- " + (err && err.message ? err.message : err)); process.exit(1); }
        db.close(function () { process.exit(0); });
      });
    ' "$1" >/dev/null
}
seed_sqlite3_pin() {
    SEED_PIN=''
    if [ ! -f "$SRC/package-lock.json" ] || [ -L "$SRC/package-lock.json" ]; then
        echo 'ERROR: image sqlite3 lock missing' >&2
        return 1
    fi
    if ! SEED_PIN="$(node -p 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const p=(l.packages&&l.packages["node_modules/sqlite3"])||{}; p.version||""' "$SRC/package-lock.json" 2>/dev/null)"; then
        echo 'ERROR: image sqlite3 lock invalid JSON' >&2
        return 1
    fi
    if [ -z "$SEED_PIN" ]; then
        echo 'ERROR: image sqlite3 pin missing' >&2
        return 1
    fi
    return 0
}
# Sets SEED_B to the single rollback directory, SEED_B_EXACT=1 when its owner
# line is complete, and SEED_B_META=1 when it holds no original.
seed_sqlite3_scan_backup() {
    SEED_B=''
    SEED_B_META=0
    SEED_B_EXACT=0
    seed_modules="$DST/node_modules"
    for seed_b in "$seed_modules"/.osi-sqlite3-seed-rollback.*; do
        seed_sqlite3_present "$seed_b" || continue
        if [ -n "$SEED_B" ] || [ ! -d "$seed_b" ] || [ -L "$seed_b" ]; then
            echo "ERROR: ambiguous or unowned seed rollback: $seed_b" >&2
            return 1
        fi
        seed_b_id=0
        for seed_child in "$seed_b"/* "$seed_b"/.[!.]* "$seed_b"/..?*; do
            seed_sqlite3_present "$seed_child" || continue
            case "$seed_child" in
                "$seed_b/.owner")
                    if [ ! -f "$seed_child" ] || [ -L "$seed_child" ]; then
                        echo "ERROR: seed rollback metadata type: $seed_child" >&2
                        return 1
                    fi ;;
                "$seed_b/.candidate-id")
                    if [ ! -f "$seed_child" ] || [ -L "$seed_child" ]; then
                        echo "ERROR: seed rollback metadata type: $seed_child" >&2
                        return 1
                    fi
                    seed_b_id=1 ;;
                "$seed_b/original")
                    if [ ! -d "$seed_child" ] && [ ! -L "$seed_child" ]; then
                        echo "ERROR: seed original type: $seed_child" >&2
                        return 1
                    fi ;;
                *) echo "ERROR: unknown seed rollback child: $seed_child" >&2; return 1 ;;
            esac
        done
        seed_b_exact=0
        if seed_sqlite3_exact_file "$seed_b/.owner" 'osi-sqlite3-seed-v2'; then
            seed_b_exact=1
        elif seed_sqlite3_present "$seed_b/original" || [ "$seed_b_id" = 1 ] ||
             { seed_sqlite3_present "$seed_b/.owner" &&
               ! seed_sqlite3_owner_prefix "$seed_b/.owner" 'osi-sqlite3-seed-v2'; }; then
            # The owner line is written first, then the candidate identity;
            # only after both can anything move into the backup.
            echo "ERROR: ambiguous or unowned seed rollback: $seed_b" >&2
            return 1
        fi
        if [ "$seed_b_id" = 1 ] && ! seed_sqlite3_exact_id_file "$seed_b/.candidate-id"; then
            if seed_sqlite3_present "$seed_b/original" ||
               ! seed_sqlite3_id_prefix "$seed_b/.candidate-id"; then
                echo "ERROR: invalid seed candidate identity: $seed_b/.candidate-id" >&2
                return 1
            fi
        fi
        SEED_B_EXACT="$seed_b_exact"
        SEED_B_META=0
        if ! seed_sqlite3_present "$seed_b/original"; then SEED_B_META=1; fi
        SEED_B="$seed_b"
    done
    return 0
}
# Removes a rollback directory the scan proved to hold at most owner and
# identity metadata. rmdir refuses a directory that gained another entry.
seed_sqlite3_clear_metadata_backup() {
    if ! rm -f "$SEED_B/.candidate-id" "$SEED_B/.owner" || ! rmdir "$SEED_B" ||
       seed_sqlite3_present "$SEED_B"; then
        echo "ERROR: metadata-only seed rollback cleanup failed or was partial; inspect $SEED_B" >&2
        seed_sqlite3_report_paths "$SEED_B" "$SEED_B/.owner" "$SEED_B/.candidate-id"
        return 1
    fi
    return 0
}
seed_sqlite3_owned_final() {
    seed_d="$DST/node_modules/sqlite3"
    seed_sqlite3_exact_id_file "$1/.candidate-id" || return 1
    if [ -L "$seed_d" ]; then
        seed_expected="$(cat "$1/.candidate-id" 2>/dev/null || true)"
        [ -n "$seed_expected" ] && [ "$(seed_sqlite3_id "$seed_d" 2>/dev/null || true)" = "$seed_expected" ] || return 1
        [ "$(readlink "$seed_d" 2>/dev/null || true)" = "$SQLITE_SRC" ] || return 1
        return 0
    fi
    [ -d "$seed_d" ] && [ ! -L "$seed_d" ] || return 1
    seed_sqlite3_exact_file "$seed_d/.osi-sqlite3-candidate-owner" "$1"
}
seed_sqlite3_recover() {
    seed_d="$DST/node_modules/sqlite3"
    seed_o="$SEED_B/original"
    if [ "$SEED_B_META" = 1 ] && ! seed_sqlite3_owned_final "$SEED_B"; then
        # Nothing is left in this backup and the final path is not its
        # candidate: the old-path rename never ran, or an earlier rollback
        # already put the original back. Only metadata remains.
        # A restore into an occupied final path moves the original to
        # $seed_d/original instead. That backup stays as the record of the
        # refused restore: clearing it would let the next seed move the
        # occupant, with the original inside, into a new backup and delete it.
        if seed_sqlite3_present "$seed_d/original"; then
            echo "ERROR: $seed_d/original is present beside metadata-only seed rollback $SEED_B; an earlier restore may have nested the old module there; preserving both for inspection" >&2
            seed_sqlite3_report_paths "$SEED_B" "$seed_d" "$seed_d/original"
            return 1
        fi
        seed_sqlite3_clear_metadata_backup || return 1
        if seed_sqlite3_present "$seed_d"; then
            echo "WARN: cleared metadata-only seed rollback; $seed_d was not touched; retry seed" >&2
        else
            echo 'WARN: cleared marker-only seed backup; retry seed' >&2
        fi
        return 1
    fi
    if [ "$SEED_B_EXACT" != 1 ]; then
        echo "ERROR: seed rollback owner metadata is incomplete beside an owned final: $SEED_B" >&2
        return 1
    fi
    if seed_sqlite3_present "$seed_o" && ! seed_sqlite3_present "$seed_d"; then
        seed_sqlite3_restore_original "$seed_o" "$seed_d" || return 1
        if ! rm -rf "$SEED_B"; then
            echo "ERROR: seed backup cleanup may be partial: $SEED_B" >&2
            return 1
        fi
        echo 'WARN: restored interrupted seed swap; retry seed' >&2
        return 1
    fi
    if ! seed_sqlite3_present "$seed_d"; then
        echo "ERROR: seed rollback state is not recognised: $SEED_B" >&2
        return 1
    fi
    if ! seed_sqlite3_owned_final "$SEED_B"; then
        echo "ERROR: unowned final sqlite3 beside retained seed original: $SEED_B" >&2
        return 1
    fi
    seed_sqlite3_pin || return 1
    if [ "$(seed_sqlite3_version "$seed_d")" = "$SEED_PIN" ] && seed_sqlite3_loads "$seed_d" >/dev/null 2>&1; then
        if ! rm -rf "$SEED_B"; then
            echo "ERROR: verified seed final but backup cleanup may be partial: $SEED_B" >&2
            return 1
        fi
        if [ -d "$seed_d" ] && [ ! -L "$seed_d" ] &&
           ! rm -f "$seed_d/.osi-sqlite3-candidate-owner"; then
            echo "ERROR: seed orphan marker cleanup failed: $seed_d" >&2
            return 1
        fi
        echo 'WARN: verified interrupted seed promotion; retry seed' >&2
        return 1
    fi
    if ! rm -rf "$seed_d" || seed_sqlite3_present "$seed_d"; then
        echo "ERROR: seed candidate removal failed or was partial; inspect $seed_d and $SEED_B" >&2
        return 1
    fi
    if seed_sqlite3_present "$seed_o"; then
        seed_sqlite3_restore_original "$seed_o" "$seed_d" || return 1
    fi
    if ! rm -rf "$SEED_B"; then
        echo "ERROR: seed rollback cleanup may be partial: $SEED_B" >&2
        return 1
    fi
    echo 'ERROR: invalid seed candidate rolled back; retry seed' >&2
    return 1
}
seed_sqlite3_rollback_failed_final() {
    seed_failed_b="$1"
    seed_failed_d="$DST/node_modules/sqlite3"
    if [ -z "$SEED_PIN" ] ||
       ! seed_sqlite3_exact_file "$seed_failed_b/.owner" 'osi-sqlite3-seed-v2' ||
       ! seed_sqlite3_owned_final "$seed_failed_b"; then
        echo "ERROR: failed seed final is not owned by this validated attempt; inspect $seed_failed_b and $seed_failed_d" >&2
        return 1
    fi
    if ! rm -rf "$seed_failed_d" || seed_sqlite3_present "$seed_failed_d"; then
        echo "ERROR: failed seed final removal may be partial; inspect $seed_failed_d and $seed_failed_b" >&2
        return 1
    fi
    if seed_sqlite3_present "$seed_failed_b/original"; then
        seed_sqlite3_restore_original "$seed_failed_b/original" "$seed_failed_d" || return 1
    fi
    if ! rm -rf "$seed_failed_b"; then
        echo "ERROR: seed rollback cleanup may be partial: $seed_failed_b" >&2
        return 1
    fi
    echo 'ERROR: failed seed final rolled back using the validated attempt pin; retry seed' >&2
    return 1
}
# Removes stages left by an earlier attempt. A stage holding a candidate or
# link needs its complete owner line; a stage holding only an absent or
# truncated owner line is what an interrupted owner write leaves behind.
seed_sqlite3_scan_stage() {
    for seed_s in "$DST/node_modules"/.osi-sqlite3-seed-stage.*; do
        seed_sqlite3_present "$seed_s" || continue
        if [ ! -d "$seed_s" ] || [ -L "$seed_s" ]; then
            echo "ERROR: unowned seed stage: $seed_s" >&2
            return 1
        fi
        seed_s_payload=0
        for seed_child in "$seed_s"/* "$seed_s"/.[!.]* "$seed_s"/..?*; do
            seed_sqlite3_present "$seed_child" || continue
            case "$seed_child" in
                "$seed_s/.owner")
                    if [ ! -f "$seed_child" ] || [ -L "$seed_child" ]; then
                        echo "ERROR: seed stage metadata type: $seed_child" >&2
                        return 1
                    fi ;;
                "$seed_s/candidate")
                    if [ ! -d "$seed_child" ] || [ -L "$seed_child" ]; then
                        echo "ERROR: seed stage candidate type: $seed_child" >&2
                        return 1
                    fi
                    seed_s_payload=1 ;;
                "$seed_s/link")
                    if [ ! -L "$seed_child" ]; then
                        echo "ERROR: seed stage link type: $seed_child" >&2
                        return 1
                    fi
                    seed_s_payload=1 ;;
                *) echo "ERROR: unknown seed stage child: $seed_child" >&2; return 1 ;;
            esac
        done
        if ! seed_sqlite3_exact_file "$seed_s/.owner" 'osi-sqlite3-seed-stage-v2'; then
            if [ "$seed_s_payload" = 1 ] ||
               { seed_sqlite3_present "$seed_s/.owner" &&
                 ! seed_sqlite3_owner_prefix "$seed_s/.owner" 'osi-sqlite3-seed-stage-v2'; }; then
                echo "ERROR: unowned seed stage: $seed_s" >&2
                return 1
            fi
        fi
        echo "WARN: removing seed stage left by an earlier attempt: $seed_s" >&2
        if ! rm -rf "$seed_s" || seed_sqlite3_present "$seed_s"; then
            echo "ERROR: seed stage cleanup failed or was partial: $seed_s" >&2
            return 1
        fi
    done
    return 0
}

seed_native_sqlite3() {
    SQLITE_SRC=/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3
    seed_d="$DST/node_modules/sqlite3"
    seed_sqlite3_scan_backup || return 1
    if [ -n "$SEED_B" ]; then
        seed_sqlite3_recover
        return 1
    fi
    if [ -d "$seed_d" ] && [ ! -L "$seed_d" ] && seed_sqlite3_present "$seed_d/.osi-sqlite3-candidate-owner"; then
        seed_marker="$seed_d/.osi-sqlite3-candidate-owner"
        if [ ! -f "$seed_marker" ] || [ -L "$seed_marker" ]; then
            echo 'ERROR: invalid seed orphan marker type' >&2
            return 1
        fi
        seed_named="$(cat "$seed_marker" 2>/dev/null || true)"
        case "$seed_named" in "$DST/node_modules"/.osi-sqlite3-seed-rollback.*) ;; *) echo 'ERROR: invalid seed orphan backup name' >&2; return 1 ;; esac
        if seed_sqlite3_present "$seed_named" || ! seed_sqlite3_exact_file "$seed_marker" "$seed_named"; then
            echo 'ERROR: seed orphan marker does not name an absent backup' >&2
            return 1
        fi
        seed_sqlite3_pin || return 1
        if [ "$(seed_sqlite3_version "$seed_d")" != "$SEED_PIN" ] || ! seed_sqlite3_loads "$seed_d" >/dev/null 2>&1; then
            echo 'ERROR: seed orphan-marked final failed pin/load; retaining it' >&2
            return 1
        fi
        if ! rm -f "$seed_marker"; then
            echo 'ERROR: seed orphan marker cleanup failed' >&2
            return 1
        fi
    fi
    seed_sqlite3_scan_stage || return 1
    seed_sqlite3_pin || return 1
    if [ ! -d "$SQLITE_SRC" ] || [ -L "$SQLITE_SRC" ]; then
        echo 'ERROR: firmware sqlite3 source missing or not a real directory' >&2
        return 1
    fi
    if [ "$(seed_sqlite3_version "$SQLITE_SRC")" != "$SEED_PIN" ]; then
        echo 'ERROR: firmware sqlite3 source version mismatch' >&2
        return 1
    fi
    if ! seed_sqlite3_loads "$SQLITE_SRC" >/dev/null 2>&1; then
        echo 'ERROR: firmware sqlite3 source does not open :memory:' >&2
        return 1
    fi
    if [ -d "$seed_d" ] && [ ! -L "$seed_d" ]; then
        if [ "$(seed_sqlite3_version "$seed_d")" = "$SEED_PIN" ] && seed_sqlite3_loads "$seed_d" >/dev/null 2>&1; then
            echo 'OK: existing real sqlite3 matches image pin and loads'
            return 0
        fi
    elif seed_sqlite3_present "$seed_d" && [ ! -L "$seed_d" ]; then
        echo "ERROR: unexpected seed sqlite3 destination type: $seed_d" >&2
        return 1
    fi
    seed_s="$(mktemp -d "$DST/node_modules/.osi-sqlite3-seed-stage.XXXXXX" 2>/dev/null || true)"
    if [ -z "$seed_s" ] || [ ! -d "$seed_s" ] || [ -L "$seed_s" ]; then
        echo 'ERROR: could not allocate seed sqlite3 stage' >&2
        return 1
    fi
    if ! printf '%s\n' 'osi-sqlite3-seed-stage-v2' > "$seed_s/.owner"; then
        echo "ERROR: seed stage marker write failed: $seed_s" >&2
        return 1
    fi
    seed_candidate="$seed_s/candidate"
    seed_copy_ok=0
    if cp -a "$SQLITE_SRC" "$seed_candidate"; then seed_copy_ok=1; fi
    seed_marker="$seed_candidate/.osi-sqlite3-candidate-owner"
    if seed_sqlite3_present "$seed_marker"; then
        echo "ERROR: copied seed candidate already contains an ownership marker: $seed_marker" >&2
        return 1
    fi
    if [ "$seed_copy_ok" != 1 ] || ! seed_sqlite3_loads "$seed_candidate" >/dev/null 2>&1; then
        if seed_sqlite3_present "$seed_candidate" &&
           { ! rm -rf "$seed_candidate" || seed_sqlite3_present "$seed_candidate"; }; then
            echo "ERROR: seed copy/probe failed and candidate cleanup may be partial: $seed_candidate" >&2
            return 1
        fi
        seed_candidate="$seed_s/link"
        if ! ln -s "$SQLITE_SRC" "$seed_candidate" ||
           ! seed_sqlite3_loads "$seed_candidate" >/dev/null 2>&1; then
            if ! rm -rf "$seed_s" || seed_sqlite3_present "$seed_s"; then
                echo "ERROR: seed link failure and stage cleanup may be partial: $seed_s" >&2
            else
                echo 'ERROR: verified firmware-link fallback unavailable' >&2
            fi
            return 1
        fi
        echo 'WARN: seed copy failed or did not load under installed peers; verified firmware symlink is temporary and npm can retire it' >&2
    fi
    seed_b="$(mktemp -d "$DST/node_modules/.osi-sqlite3-seed-rollback.XXXXXX" 2>/dev/null || true)"
    if [ -z "$seed_b" ] || [ ! -d "$seed_b" ] || [ -L "$seed_b" ]; then
        echo "ERROR: could not allocate seed rollback; stage retained at $seed_s" >&2
        return 1
    fi
    if ! printf '%s\n' 'osi-sqlite3-seed-v2' > "$seed_b/.owner" ||
       ! seed_sqlite3_id "$seed_candidate" > "$seed_b/.candidate-id"; then
        echo "ERROR: seed ownership metadata failed; inspect $seed_b and $seed_s" >&2
        return 1
    fi
    if [ -d "$seed_candidate" ] && [ ! -L "$seed_candidate" ]; then
        if ! seed_sqlite3_new_exact_file "$seed_marker" "$seed_b"; then
            echo "ERROR: seed candidate marker failed; inspect $seed_b and $seed_s" >&2
            return 1
        fi
    fi
    if seed_sqlite3_present "$seed_d"; then
        if [ ! -d "$seed_d" ] && [ ! -L "$seed_d" ]; then
            echo "ERROR: unexpected seed destination before swap: $seed_d" >&2
            return 1
        fi
        if ! mv "$seed_d" "$seed_b/original"; then
            echo "ERROR: seed old-path rename reported failure; inspect $seed_d, $seed_b/original and $seed_s" >&2
            seed_sqlite3_report_paths "$seed_d" "$seed_b/original" "$seed_candidate" "$seed_b/.owner"
            return 1
        fi
        if seed_sqlite3_present "$seed_d" || ! seed_sqlite3_present "$seed_b/original"; then
            echo "ERROR: seed old-path rename left ambiguous state: $seed_b" >&2
            return 1
        fi
    fi
    if seed_sqlite3_present "$seed_d"; then
        echo "ERROR: seed destination appeared before promotion: $seed_d" >&2
        return 1
    fi
    if ! mv "$seed_candidate" "$seed_d"; then
        echo "ERROR: seed candidate rename reported failure; inspect $seed_candidate, $seed_d and $seed_b" >&2
        seed_sqlite3_report_paths "$seed_candidate" "$seed_d" "$seed_b/original" "$seed_b/.owner"
        return 1
    fi
    if seed_sqlite3_present "$seed_candidate" || ! seed_sqlite3_owned_final "$seed_b"; then
        echo "ERROR: seed promotion left ambiguous state: $seed_b" >&2
        return 1
    fi
    if [ "$(seed_sqlite3_version "$seed_d")" != "$SEED_PIN" ] ||
       ! seed_sqlite3_loads "$seed_d" >/dev/null 2>&1; then
        echo "ERROR: seed final pin/load failed; rollback retained at $seed_b" >&2
        seed_sqlite3_rollback_failed_final "$seed_b"
        return 1
    fi
    if ! rm -rf "$seed_s"; then
        echo "ERROR: seed stage cleanup may be partial: $seed_s" >&2
        return 1
    fi
    if ! rm -rf "$seed_b"; then
        echo "ERROR: verified seed final but backup cleanup may be partial: $seed_b" >&2
        return 1
    fi
    if [ -d "$seed_d" ] && [ ! -L "$seed_d" ] &&
       ! rm -f "$seed_d/.osi-sqlite3-candidate-owner"; then
        echo "ERROR: verified seed final but orphan marker cleanup failed: $seed_d" >&2
        return 1
    fi
    echo "OK: seeded verified sqlite3 at $seed_d"
    return 0
}
seed_native_sqlite3 || exit 1
# END native sqlite3 seed

```


## Test additions

```js
// Native sqlite3 recovery cases. The deploy cases run the actual deploy.sh
// helper text; the seed cases run the exact BEGIN/END block of the mirrored
// 98_osi_node_red_seed script, without its broad copy, helper loop or chown.
function r2Quote(s) { return "'" + s.replaceAll("'", "'\\''") + "'"; }
function r2OptionalDeployHelpers() {
  return ['native_sqlite3_report_paths', 'native_sqlite3_pkg_version', 'native_sqlite3_exact_file',
    'native_sqlite3_present', 'native_sqlite3_id', 'native_sqlite3_new_exact_file',
    'native_sqlite3_restore_original', 'native_sqlite3_scan_backup',
    'native_sqlite3_owned_final', 'native_sqlite3_recovery_lock',
    'native_sqlite3_recover_early', 'native_sqlite3_rollback_failed_final',
    'native_sqlite3_unrepaired', 'native_sqlite3_owner_prefix',
    'native_sqlite3_clear_metadata_backup']
    .filter(n => new RegExp('^' + n + '\\(\\) \\{', 'm').test(DEPLOY))
    .map(extractFunction);
}
function r2SeedHarness(gw, opts = {}) {
  const rel = p => path.join(REPO, 'conf', p,
    'files/etc/uci-defaults/98_osi_node_red_seed');
  const a = fs.readFileSync(rel('full_raspberrypi_bcm27xx_bcm2712'), 'utf8');
  const b = fs.readFileSync(rel('full_raspberrypi_bcm27xx_bcm2709'), 'utf8');
  assert.equal(a, b, 'seed profile bytes differ');
  const sourceLine = 'SQLITE_SRC=/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3';
  const oldRemove = 'rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"';
  const oldSource = [sourceLine, 'if [ -d "$SQLITE_SRC" ]; then',
    '    if ! cp -a "$SQLITE_SRC" "$DST/node_modules/sqlite3"; then',
    '        rm -rf "$DST/node_modules/sqlite3"',
    '        ln -s "$SQLITE_SRC" "$DST/node_modules/sqlite3"',
    '    fi', 'fi'].join('\n');
  let body;
  const begin = '# BEGIN native sqlite3 seed';
  const end = '# END native sqlite3 seed';
  if (a.includes(begin) || a.includes(end)) {
    assert.equal(a.split(begin).length, 2, 'candidate seed BEGIN count');
    assert.equal(a.split(end).length, 2, 'candidate seed END count');
    const segment = a.slice(a.indexOf(begin) + begin.length, a.indexOf(end)).trim();
    assert.match(segment, /seed_native_sqlite3\(\) \{/);
    assert.match(segment, /\nseed_native_sqlite3 \|\| exit 1$/);
    body = segment.replace(/\nseed_native_sqlite3 \|\| exit 1$/, '');
  } else {
    assert.ok(a.includes('\n' + oldRemove + '\n'), 'BASE deletion bytes changed');
    assert.ok(a.includes('\n' + oldSource + '\n'), 'BASE source block bytes changed');
    body = 'seed_native_sqlite3() {\n' + oldRemove + '\n' + oldSource + '\n}';
  }
  const src = path.join(gw.root, 'share', 'node-red');
  const sqliteSrc = opts.firmware === false
    ? path.join(gw.root, 'firmware-that-was-removed', 'sqlite3') : gw.fwSqlite;
  fs.mkdirSync(src, { recursive: true });
  const lock = opts.sourceLock || writeLockFixture(gw, LOCKED_VERSION);
  fs.copyFileSync(lock, path.join(src, 'package-lock.json'));
  assert.equal(body.split(sourceLine).length, 2, 'firmware assignment count');
  body = body.replace(sourceLine, 'SQLITE_SRC=' + r2Quote(sqliteSrc));
  const script = ['set -eu', 'SRC=' + r2Quote(src),
    'DST=' + r2Quote(gw.proj), body, ...(opts.shellHooks || []),
    'if seed_native_sqlite3; then echo SEED_RC=0; else echo SEED_RC=$?; fi',
    'echo AFTER_SEED'].join('\n');
  return spawnSync('sh', ['-c', script], { encoding: 'utf8' });
}
function r2DeployCall(gw, opts = {}) {
  // deploy.sh runs `materialize_native_sqlite3 || exit 1`, so the post-npm
  // verifier never follows a refused materialisation. `verify: false` stops
  // at the same point for a case that must refuse; every other case verifies.
  const verify = opts.verify === false ? []
    : ['if verify_native_sqlite3_after_npm; then echo VERIFY_RC=0; else echo VERIFY_RC=$?; fi'];
  const body = [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; else echo PREFLIGHT_RC=$?; fi',
    'if materialize_native_sqlite3; then echo MATERIALIZE_RC=0; else echo MATERIALIZE_RC=$?; fi',
    ...verify,
    'echo AFTER_MATERIALIZE',
  ].join('\n');
  return shellHarness(gw, body, {
    lockFixture: opts.lockFixture || writeLockFixture(gw, LOCKED_VERSION),
    arch: opts.arch || 'armv7l', muslGlob: opts.muslGlob || muslPresent(gw),
    toolchain: opts.toolchain === undefined ? false : opts.toolchain,
    shellHooks: opts.shellHooks || [], firmware: opts.firmware,
  });
}
function r2Names(gw, prefix) {
  return fs.readdirSync(path.join(gw.proj, 'node_modules'))
    .filter(n => n.startsWith(prefix)).sort();
}
function r2OldBytes(gw) {
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  fs.writeFileSync(path.join(d, 'original.txt'), 'old bytes\n');
  return { d, original: fs.readFileSync(path.join(d, 'original.txt')) };
}

test('R2 RED broken matching-version real directory repairs before npm on impossible target', () => {
  const gw = makeGateway('real-without-binary');
  const { d } = r2OldBytes(gw);
  const r = r2DeployCall(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.match(r.stdout, /MATERIALIZE_RC=0/);
  assert.match(r.stdout, /VERIFY_RC=0/); // P predicts VERIFY_RC=1
  assert.match(r.stdout, /AFTER_MATERIALIZE/);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  assert.equal(fs.existsSync(path.join(d, 'original.txt')), false);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R2 RED absent seed source preserves both installed entries', () => {
  const gw = makeGateway('real-with-binary');
  const { d, original } = r2OldBytes(gw);
  const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
  fs.mkdirSync(peer, { recursive: true });
  fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
  const r = r2SeedHarness(gw, { firmware: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/); // P predicts SEED_RC=0
  assert.match(r.stdout, /AFTER_SEED/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
});
test('R2 broken matching-version real directory refuses a failed repair even when reinstall is viable', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const peer = path.join(gw.proj, 'node_modules', 'fixture-peer');
  fs.rmSync(peer, { recursive: true, force: true }); // source peer remains
  const r = r2DeployCall(gw, { arch: 'aarch64' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.match(r.stdout, /AFTER_MATERIALIZE/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R2 deploy copy fault matches source-dot and stage-slash arguments', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  // `${n-}` keeps the hook safe under `set -u` for the harness's own
  // two-argument fetch copy; every call that does not match is forwarded.
  const hook = 'cp() { case "${1-}:${2-}:${3-}" in "-a:$NATIVE_SQLITE3_FIRMWARE_DIR/.:"*/.osi-sqlite3-stage.*/)' +
    ' echo DEPLOY_CP_HOOK >&2; return 23 ;; esac; command cp "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /DEPLOY_CP_HOOK/);
  assert.match(r.stderr, /ERROR: could not copy sqlite3 into stage/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
});
test('R2 deploy ordinary old-path mv failure before rename retains old path', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' echo MV_BEFORE >&2; return 27 ;; esac; command mv "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /MV_BEFORE/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
});
test('R2 deploy bounded interruption after real old-path rename restores before ordinary write', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' command mv "$@" || return $?; echo INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_AFTER_OLD/);
  assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
  assert.equal(fs.existsSync(d), false);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
  const second = shellHarness(gw, [
    'fetch() { return 22; }', // lock unavailable; restoration must precede it
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'test -f "$NODE_RED_ROOT/node_modules/sqlite3/original.txt" || exit 29',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.match(second.stdout, /AFTER_PREFLIGHT/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
});
test('R2 deploy status failure after old rename is distinct from interruption', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' command mv "$@" || return $?; echo MV_AFTER_STATUS >&2; return 28 ;; esac; command mv "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /MV_AFTER_STATUS/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.equal(fs.existsSync(d), false);
  const b = path.join(gw.proj, 'node_modules', r2Names(gw, '.osi-sqlite3-rollback.')[0]);
  assert.deepEqual(fs.readFileSync(path.join(b, 'original', 'original.txt')), original);
});
test('R2 seed copy fault matches source and candidate arguments; verified link is fallback', () => {
  const gw = makeGateway('real-without-binary');
  const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
  fs.mkdirSync(peer, { recursive: true });
  fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
  const hook = 'cp() { case "$1:$2:$3" in "-a:$SQLITE_SRC:"*/.osi-sqlite3-seed-stage.*/candidate)' +
    ' echo SEED_CP_HOOK >&2; return 23 ;; esac; command cp "$@"; }';
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SEED_CP_HOOK/);
  assert.match(r.stdout, /SEED_RC=0/);
  assert.equal(fs.lstatSync(path.join(gw.proj, 'node_modules', 'sqlite3')).isSymbolicLink(), true);
  assert.equal(requireSqlite3Through(gw), 0);
  assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
});
test('R2 seed same-target replacement symlink cannot borrow promotion identity', () => {
  const gw = makeGateway('real-without-binary');
  r2OldBytes(gw);
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  const hook = 'mv() { case "$1:$2" in */.osi-sqlite3-seed-stage.*/link:"$DST/node_modules/sqlite3")' +
    ' command mv "$@" || return $?; echo INTERRUPT_AFTER_LINK >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_AFTER_LINK/);
  assert.doesNotMatch(first.stdout, /AFTER_SEED/);
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  assert.equal(fs.lstatSync(d).isSymbolicLink(), true);
  fs.unlinkSync(d);
  fs.symlinkSync(gw.fwSqlite, d); // same target text, different symlink inode
  const second = r2SeedHarness(gw);
  assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.lstatSync(d).isSymbolicLink(), true);
  assert.equal(r2Names(gw, '.osi-sqlite3-seed-rollback.').length, 1);
});
test('R2 seed orphan real marker validates pin and load before removal', () => {
  const gw = makeGateway('real-with-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const missingB = path.join(gw.proj, 'node_modules', '.osi-sqlite3-seed-rollback.missing');
  fs.writeFileSync(path.join(d, '.osi-sqlite3-candidate-owner'), missingB + '\n');
  const r = r2SeedHarness(gw);
  assert.match(r.stdout, /SEED_RC=0/);
  assert.equal(fs.existsSync(path.join(d, '.osi-sqlite3-candidate-owner')), false);
});
test('R2 unknown destination file, FIFO and rollback marker types fail closed', () => {
  for (const kind of ['file', 'fifo']) {
    const gw = makeGateway('absent');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    if (kind === 'file') fs.writeFileSync(d, 'unrelated\n');
    else assert.equal(spawnSync('mkfifo', [d]).status, 0);
    const before = fs.lstatSync(d).mode;
    // require('sqlite3') opens a FIFO at the final path and blocks with no
    // writer, so the FIFO case stops after the refused materialisation.
    const r = r2DeployCall(gw, { verify: kind !== 'fifo' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /unexpected sqlite3 destination type before deploy writes/);
    assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /ERROR: unexpected sqlite3 destination type: /);
    if (kind === 'fifo') assert.doesNotMatch(r.stdout, /VERIFY_RC=/);
    assert.match(r.stdout, /AFTER_MATERIALIZE/);
    assert.equal(fs.lstatSync(d).mode, before);
  }
  const gw = makeGateway('real-without-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-rollback.unknown');
  fs.mkdirSync(b);
  fs.symlinkSync(d, path.join(b, '.owner'));
  const before = fs.readdirSync(path.join(gw.proj, 'node_modules')).sort();
  const r = r2DeployCall(gw);
  assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules')).sort(), before);
});
test('R2 seed rejects file, FIFO and malformed candidate identity without deleting entries', () => {
  for (const kind of ['file', 'fifo']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    fs.rmSync(d, { recursive: true, force: true });
    if (kind === 'file') fs.writeFileSync(d, 'unrelated\n');
    else assert.equal(spawnSync('mkfifo', [d]).status, 0);
    const before = fs.lstatSync(d).mode;
    const r = r2SeedHarness(gw);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.equal(fs.lstatSync(d).mode, before);
  }
  const gw = makeGateway('real-with-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-seed-rollback.bad-id');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, '.owner'), 'osi-sqlite3-seed-v2\n');
  fs.writeFileSync(path.join(b, '.candidate-id'), 'unverified identity\n');
  const before = fs.readdirSync(path.dirname(d)).sort();
  const r = r2SeedHarness(gw);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readdirSync(path.dirname(d)).sort(), before);
  assert.equal(fs.lstatSync(d).isDirectory(), true);
});
test('R2 wrong firmware version and missing pin retain broken real bytes', () => {
  for (const fault of ['wrong-source-version', 'missing-pin']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    let lock = writeLockFixture(gw, LOCKED_VERSION);
    if (fault === 'wrong-source-version') {
      const pkg = path.join(gw.fwSqlite, 'package.json');
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      parsed.version = '5.1.8';
      fs.writeFileSync(pkg, JSON.stringify(parsed));
    } else {
      lock = path.join(gw.root, 'missing-pin.json');
      fs.writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    }
    const r = r2DeployCall(gw, { lockFixture: lock });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    if (fault === 'wrong-source-version')
      assert.match(r.stderr, /source pin missing or source version mismatch/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
  }
});
test('R2 seed source mismatch and invalid image pins preserve both entries', () => {
  for (const fault of ['wrong-source-version', 'malformed-lock', 'missing-pin']) {
    const gw = makeGateway('real-with-binary');
    const { d, original } = r2OldBytes(gw);
    const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
    let lock = writeLockFixture(gw, LOCKED_VERSION);
    if (fault === 'wrong-source-version') {
      const pkg = path.join(gw.fwSqlite, 'package.json');
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      parsed.version = '5.1.8';
      fs.writeFileSync(pkg, JSON.stringify(parsed));
    } else if (fault === 'malformed-lock') {
      lock = path.join(gw.root, 'malformed-lock.json');
      fs.writeFileSync(lock, '{"packages":{"node_modules/sqlite3":');
    } else {
      lock = path.join(gw.root, 'missing-pin.json');
      fs.writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    }
    const r = r2SeedHarness(gw, { sourceLock: lock });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
  }
});
test('R2 copied seed stage uses installed peers and falls back to firmware link', () => {
  const gw = makeGateway('real-without-binary');
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  const r = r2SeedHarness(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=0/);
  assert.match(r.stderr, /temporary and npm can retire/);
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  assert.equal(fs.lstatSync(d).isSymbolicLink(), true);
  assert.equal(requireSqlite3Through(gw), 0);
});
test('R2 failed seed fallback link retains the old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  const hook = 'ln() { case "$1:$2:$3" in "-s:$SQLITE_SRC:"*/.osi-sqlite3-seed-stage.*/link)' +
    ' echo SEED_LN_HOOK >&2; return 25 ;; esac; command ln "$@"; }';
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SEED_LN_HOOK/);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
});
test('R2 seed successful copied real directory repeats without swapping', () => {
  const gw = makeGateway('real-without-binary');
  const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
  fs.mkdirSync(peer, { recursive: true });
  fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
  const first = r2SeedHarness(gw);
  assert.match(first.stdout, /SEED_RC=0/);
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  assert.equal(fs.lstatSync(d).isDirectory(), true);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  fs.writeFileSync(path.join(d, 'repeat.txt'), 'repeat bytes\n');
  const second = r2SeedHarness(gw);
  assert.match(second.stdout, /SEED_RC=0/);
  assert.equal(fs.readFileSync(path.join(d, 'repeat.txt'), 'utf8'), 'repeat bytes\n');
  assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
});
test('R2 deploy final-path load fault restores old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final-path failure");\n');
  const r = r2DeployCall(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R2 seed final-path load fault restores old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected seed final-path failure");\n');
  const r = r2SeedHarness(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
  // The emptied stage is retained with its owner line; the next run removes it.
  const stages = r2Names(gw, '.osi-sqlite3-seed-stage.');
  assert.equal(stages.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', stages[0])), ['.owner']);
  const again = r2SeedHarness(gw);
  assert.match(again.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.ok(again.stderr.includes('removing seed stage left by an earlier attempt: ' +
    path.join(gw.proj, 'node_modules', stages[0])), again.stderr);
  assert.equal(r2Names(gw, '.osi-sqlite3-seed-stage.').length, 1);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
});
test('R2 partial promoted-candidate removal retains backup and reports surviving paths', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final-path failure");\n');
  const hook = 'rm() { case "$1:$2" in "-rf:$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' command rm -f "$2/index.js"; echo PARTIAL_RM_HOOK >&2; return 30 ;; esac; command rm "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /PARTIAL_RM_HOOK/);
  assert.match(r.stderr, /may be partial/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  const names = r2Names(gw, '.osi-sqlite3-rollback.');
  assert.equal(names.length, 1);
  const b = path.join(gw.proj, 'node_modules', names[0]);
  assert.deepEqual(fs.readFileSync(path.join(b, 'original', 'original.txt')), original);
  assert.equal(fs.existsSync(path.join(d, 'index.js')), false);
});
test('R2 deploy orphan real marker requires pin and load before cleanup', () => {
  const gw = makeGateway('real-with-binary');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const missingB = path.join(gw.proj, 'node_modules', '.osi-sqlite3-rollback.missing');
  fs.writeFileSync(path.join(d, '.osi-sqlite3-candidate-owner'), missingB + '\n');
  const r = r2DeployCall(gw);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.equal(fs.existsSync(path.join(d, '.osi-sqlite3-candidate-owner')), false);
});
test('R2 deploy stage allocation fault never touches old real directory', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  // deploy.sh discards mktemp's stderr, so the hook records its call in a
  // file the fixture owns, outside node_modules.
  const marker = path.join(gw.root, 'stage-alloc-hook.marker');
  assert.equal(fs.existsSync(marker), false);
  const hook = 'mktemp() { case "${1-}:${2-}" in "-d:"*/.osi-sqlite3-stage.*)' +
    ' printf "STAGE_ALLOC_HOOK\\n" >> ' + r2Quote(marker) + '; return 24 ;; esac; command mktemp "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'STAGE_ALLOC_HOOK\n');
  assert.match(r.stderr, /ERROR: could not create sqlite3 stage/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
});
test('R2 multiple or unknown-child rollback entries retain destination', () => {
  for (const fault of ['multiple', 'unknown-child']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    const mods = path.dirname(d);
    const b1 = path.join(mods, '.osi-sqlite3-rollback.first');
    fs.mkdirSync(b1);
    fs.writeFileSync(path.join(b1, '.owner'), 'osi-sqlite3-deploy-v2\n');
    if (fault === 'multiple') {
      const b2 = path.join(mods, '.osi-sqlite3-rollback.second');
      fs.mkdirSync(b2);
      fs.writeFileSync(path.join(b2, '.owner'), 'osi-sqlite3-deploy-v2\n');
    } else fs.writeFileSync(path.join(b1, 'unknown'), 'keep\n');
    const before = fs.readdirSync(mods).sort();
    const r = r2DeployCall(gw);
    assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
    assert.deepEqual(fs.readdirSync(mods).sort(), before);
    assert.equal(fs.lstatSync(d).isDirectory(), true);
  }
});
test('R2 no installed or firmware module remains an npm fallback only when reinstall is viable', () => {
  const gw = makeGateway('absent');
  const r = shellHarness(gw,
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; else echo PREFLIGHT_RC=$?; fi',
    { firmware: false, arch: 'aarch64', toolchain: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREFLIGHT_RC=0/);
  assert.match(r.stdout, /SKIP/);
});
test('R2 deploy bounded interruption after stage promotion validates final before ordinary write', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/".osi-sqlite3-stage.*:"$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' command mv "$@" || return $?; echo INTERRUPT_AFTER_FINAL >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_AFTER_FINAL/);
  assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  const names = r2Names(gw, '.osi-sqlite3-rollback.');
  assert.equal(names.length, 1);
  const b = path.join(gw.proj, 'node_modules', names[0]);
  assert.deepEqual(fs.readFileSync(path.join(b, 'original', 'original.txt')), original);
  const second = shellHarness(gw, [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { lockFixture: writeLockFixture(gw, LOCKED_VERSION),
    arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.equal(requireSqlite3(gw.proj).status, 0);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
  assert.equal(fs.existsSync(path.join(d, '.osi-sqlite3-candidate-owner')), false);
});
test('R2 seed bounded interruption after old rename restores existing entry', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const hook = 'mv() { case "$1:$2" in "$DST/node_modules/sqlite3:"*/.osi-sqlite3-seed-rollback.*/original)' +
    ' command mv "$@" || return $?; echo SEED_INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /SEED_INTERRUPT_AFTER_OLD/);
  assert.doesNotMatch(first.stdout, /AFTER_SEED/);
  assert.equal(fs.existsSync(d), false);
  const second = r2SeedHarness(gw);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
});

test('R3 copied deploy marker symlink cannot overwrite its target or the old module', () => {
  for (const present of [true, false]) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const target = path.join(gw.root, present ? 'external-marker.txt' : 'dangling-marker.txt');
    if (present) fs.writeFileSync(target, 'external bytes\n');
    fs.symlinkSync(target, path.join(gw.fwSqlite, '.osi-sqlite3-candidate-owner'));
    const r = r2DeployCall(gw);
    assert.equal(r.status, 0, r.stderr);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external bytes\n');
    else assert.equal(fs.existsSync(target), false);
    assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /already contains an ownership marker/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
    // The refused stage is retained; the next materialise removes it first.
    const stages = r2Names(gw, '.osi-sqlite3-stage.');
    assert.equal(stages.length, 1);
    const again = r2DeployCall(gw);
    assert.ok(again.stderr.includes('left behind by an interrupted deploy: ' +
      path.join(gw.proj, 'node_modules', stages[0])), again.stderr);
    assert.match(again.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    assert.equal(r2Names(gw, '.osi-sqlite3-stage.').length, 1);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external bytes\n');
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  }
});
test('R3 copied seed marker symlink cannot overwrite its target or the old module', () => {
  for (const present of [true, false]) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const target = path.join(gw.root, present ? 'external-seed-marker.txt' : 'dangling-seed-marker.txt');
    if (present) fs.writeFileSync(target, 'external seed bytes\n');
    fs.symlinkSync(target, path.join(gw.fwSqlite, '.osi-sqlite3-candidate-owner'));
    const r = r2SeedHarness(gw);
    assert.equal(r.status, 0, r.stderr);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external seed bytes\n');
    else assert.equal(fs.existsSync(target), false);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.match(r.stderr, /already contains an ownership marker/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
    // The refused stage keeps its owner line and copied candidate; the next
    // run removes it before trying again.
    const stages = r2Names(gw, '.osi-sqlite3-seed-stage.');
    assert.equal(stages.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', stages[0])).sort(),
      ['.owner', 'candidate']);
    const again = r2SeedHarness(gw);
    assert.ok(again.stderr.includes('removing seed stage left by an earlier attempt: ' +
      path.join(gw.proj, 'node_modules', stages[0])), again.stderr);
    assert.match(again.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.equal(r2Names(gw, '.osi-sqlite3-seed-stage.').length, 1);
    if (present) assert.equal(fs.readFileSync(target, 'utf8'), 'external seed bytes\n');
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  }
});
test('R3 deploy final failure restores old module without a second lock fetch', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const lock = writeLockFixture(gw, LOCKED_VERSION);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final failure before lock reread");\n');
  const hook = 'fetch() { if [ -f "$TMP_DIR/first-fetch" ]; then echo SECOND_LOCK_READ >&2; return 22; fi; : > "$TMP_DIR/first-fetch"; command cp ' +
    r2Quote(lock) + ' "$2"; }';
  const r = r2DeployCall(gw, { lockFixture: lock, shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.doesNotMatch(r.stderr, /SECOND_LOCK_READ/);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R3 seed final failure restores old module after the source lock disappears', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const sourceLock = path.join(gw.root, 'share', 'node-red', 'package-lock.json');
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') { require("fs").unlinkSync(' + JSON.stringify(sourceLock) +
    '); throw new Error("injected seed final failure after lock removal"); }\n');
  const r = r2SeedHarness(gw);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.existsSync(sourceLock), false);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
});
test('R3 occupied deploy restore retains the marker and nested original for inspection', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected deploy final failure for occupied restore");\n');
  const hook = 'mv() { case "$1:$2" in */.osi-sqlite3-rollback.*/original:"$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo OCCUPIED_DEPLOY_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
  const r = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /OCCUPIED_DEPLOY_RESTORE/);
  assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  assert.equal(fs.readFileSync(path.join(d, 'occupant.txt'), 'utf8'), 'occupant bytes\n');
  assert.deepEqual(fs.readFileSync(path.join(d, 'original', 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
  assert.match(r.stderr, /restore identity differs/);
});
test('R3 occupied seed restore retains the marker and nested original for inspection', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.appendFileSync(path.join(gw.fwSqlite, 'index.js'),
    '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected seed final failure for occupied restore");\n');
  const hook = 'mv() { case "$1:$2" in */.osi-sqlite3-seed-rollback.*/original:"$DST/node_modules/sqlite3")' +
    ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo OCCUPIED_SEED_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /OCCUPIED_SEED_RESTORE/);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.readFileSync(path.join(d, 'occupant.txt'), 'utf8'), 'occupant bytes\n');
  assert.deepEqual(fs.readFileSync(path.join(d, 'original', 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-seed-rollback.').length, 1);
  assert.match(r.stderr, /restore identity differs/);
});
test('R3 early deploy recovery refuses an occupied restore before ordinary writes', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const interrupt = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
    ' command mv "$@" || return $?; echo INTERRUPT_EARLY_RESTORE >&2; exit 26 ;; esac; command mv "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [interrupt] });
  assert.equal(first.status, 26, first.stderr);
  assert.match(first.stderr, /INTERRUPT_EARLY_RESTORE/);
  assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
  const occupy = 'mv() { case "$1:$2" in */.osi-sqlite3-rollback.*/original:"$NODE_RED_ROOT/node_modules/sqlite3")' +
    ' mkdir -p "$2"; printf "new occupant\\n" > "$2/new.txt"; command mv "$@" || return $?; echo OCCUPIED_EARLY_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
  const second = shellHarness(gw, [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { shellHooks: [occupy], fetchFails: true });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /OCCUPIED_EARLY_RESTORE/);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.equal(fs.readFileSync(path.join(d, 'new.txt'), 'utf8'), 'new occupant\n');
  assert.deepEqual(fs.readFileSync(path.join(d, 'original', 'original.txt')), original);
  assert.equal(r2Names(gw, '.osi-sqlite3-rollback.').length, 1);
});
test('R3 failing fallback-link probe preserves the old seed entry', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  fs.rmSync(path.join(gw.proj, 'node_modules', 'fixture-peer'), { recursive: true, force: true });
  // The seed discards the probe's output, so the hook records its call in a
  // file the fixture owns, outside node_modules.
  const marker = path.join(gw.root, 'link-probe-hook.marker');
  assert.equal(fs.existsSync(marker), false);
  const hook = `seed_sqlite3_loads() {
    case "$1" in */.osi-sqlite3-seed-stage.*/link) printf 'LINK_PROBE_HOOK\\n' >> ${r2Quote(marker)}; return 17 ;; esac
    node -e '
      const sqlite3 = require(process.argv[1]);
      const db = new sqlite3.Database(":memory:", function (err) {
        if (err) { console.error("sqlite3 could not open :memory: -- " + (err && err.message ? err.message : err)); process.exit(1); }
        db.close(function () { process.exit(0); });
      });
    ' "$1" >/dev/null
  }`;
  const r = r2SeedHarness(gw, { shellHooks: [hook] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'LINK_PROBE_HOOK\n');
  assert.match(r.stderr, /ERROR: verified firmware-link fallback unavailable/);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-stage.'), []);
});

// R4: a rollback directory that never received the original, or whose
// original was already put back, holds only owner metadata. The next run
// clears it without touching the final path and stops; the run after that is
// an ordinary eligible attempt. Directories that still hold an original, have
// a foreign owner, or are symlinks stay exactly as they were.
function r4Id(p) {
  const s = fs.lstatSync(p, { bigint: true });
  return `${s.dev}:${s.ino}`;
}
function r4Preflight(gw, opts = {}) {
  return shellHarness(gw, [
    'if run_native_sqlite3_preflight; then echo PREFLIGHT_RC=0; echo ORDINARY_WRITE; else echo PREFLIGHT_RC=$?; fi',
    'echo AFTER_PREFLIGHT',
  ].join('\n'), { lockFixture: writeLockFixture(gw, LOCKED_VERSION),
    arch: 'armv7l', muslGlob: muslPresent(gw), toolchain: false,
    shellHooks: opts.shellHooks || [] });
}
test('R4 dangling installed symlink still compares the firmware version before writes', () => {
  const gw = makeGateway('dangling-symlink');
  const d = path.join(gw.proj, 'node_modules', 'sqlite3');
  const link = fs.readlinkSync(d);
  const bad = shellHarness(gw, PREFLIGHT_IN_CONDITION, {
    lockFixture: writeLockFixture(gw, '5.1.8'), arch: 'armv7l',
    muslGlob: muslPresent(gw), toolchain: false });
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /PREFLIGHT-RC=[1-9]/, `${bad.stdout}${bad.stderr}`);
  assert.match(bad.stderr, /firmware sqlite3 is 5\.1\.7/);
  assert.match(bad.stderr, /5\.1\.8/);
  assert.equal(fs.readlinkSync(d), link);
  const good = shellHarness(gw, PREFLIGHT_IN_CONDITION, {
    lockFixture: writeLockFixture(gw, LOCKED_VERSION), arch: 'armv7l',
    muslGlob: muslPresent(gw), toolchain: false });
  assert.match(good.stdout, /PREFLIGHT-RC=0/, `${good.stdout}${good.stderr}`);
  assert.match(good.stdout, /firmware sqlite3 5\.1\.7 matches the shipped lockfile/);
});
test('R4 deploy metadata-only rollback after a failed or interrupted old-path rename clears and retries', () => {
  for (const fault of ['status', 'interrupt']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const before = r4Id(d);
    const action = fault === 'status'
      ? 'echo OLD_MV_STATUS >&2; return 27' : 'echo OLD_MV_INTERRUPT >&2; exit 26';
    const hook = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
      ' ' + action + ' ;; esac; command mv "$@"; }';
    const first = r2DeployCall(gw, { shellHooks: [hook] });
    if (fault === 'status') {
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stderr, /OLD_MV_STATUS/);
      assert.match(first.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
    } else {
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /OLD_MV_INTERRUPT/);
      assert.doesNotMatch(first.stdout, /AFTER_MATERIALIZE/);
    }
    const names = r2Names(gw, '.osi-sqlite3-rollback.');
    assert.equal(names.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', names[0])), ['.owner']);
    assert.equal(r2Names(gw, '.osi-sqlite3-stage.').length, 1);
    assert.equal(r4Id(d), before);
    const second = r4Preflight(gw);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
    assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
    assert.match(second.stderr, /cleared metadata-only sqlite3 rollback/);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
    assert.equal(r4Id(d), before);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    const third = r2DeployCall(gw);
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /PREFLIGHT_RC=0/);
    assert.match(third.stdout, /MATERIALIZE_RC=0/);
    assert.match(third.stdout, /VERIFY_RC=0/);
    assert.match(third.stderr, /interrupted deploy/);
    assert.equal(requireSqlite3(gw.proj).status, 0);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-stage.'), []);
  }
});
test('R4 deploy truncated owner metadata and a partial cleanup converge to an eligible retry', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const before = r4Id(d);
  const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-rollback.partial');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, '.owner'), 'osi-sqlite3-dep'); // interrupted owner write
  const rmdirHook = 'rmdir() { case "$1" in */.osi-sqlite3-rollback.*) echo RMDIR_HOOK >&2; return 31 ;; esac; command rmdir "$@"; }';
  const first = r4Preflight(gw, { shellHooks: [rmdirHook] });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /RMDIR_HOOK/);
  assert.match(first.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(first.stdout, /ORDINARY_WRITE/);
  assert.match(first.stderr, /cleanup failed or was partial/);
  assert.deepEqual(fs.readdirSync(b), []);
  const second = r4Preflight(gw);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.match(second.stderr, /cleared metadata-only sqlite3 rollback/);
  assert.equal(fs.existsSync(b), false);
  assert.equal(r4Id(d), before);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  const third = r2DeployCall(gw);
  assert.match(third.stdout, /PREFLIGHT_RC=0/);
  assert.match(third.stdout, /MATERIALIZE_RC=0/);
  assert.match(third.stdout, /VERIFY_RC=0/);
});
test('R4 deploy leftover metadata after an already restored rollback clears without moving the restored module', () => {
  const gw = makeGateway('real-without-binary');
  const { d, original } = r2OldBytes(gw);
  const index = path.join(gw.fwSqlite, 'index.js');
  const cleanIndex = fs.readFileSync(index);
  fs.appendFileSync(index, '\nif (__dirname === ' + JSON.stringify(d) +
    ') throw new Error("injected final failure before rollback cleanup");\n');
  const hook = 'rm() { case "$1:$2" in "-rf:"*/.osi-sqlite3-rollback.*)' +
    ' echo RM_BACKUP_HOOK >&2; return 32 ;; esac; command rm "$@"; }';
  const first = r2DeployCall(gw, { shellHooks: [hook] });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /RM_BACKUP_HOOK/);
  assert.match(first.stdout, /MATERIALIZE_RC=[1-9][0-9]*/);
  const names = r2Names(gw, '.osi-sqlite3-rollback.');
  assert.equal(names.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', names[0])), ['.owner']);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  const restored = r4Id(d);
  const second = r4Preflight(gw);
  assert.match(second.stdout, /PREFLIGHT_RC=[1-9][0-9]*/);
  assert.doesNotMatch(second.stdout, /ORDINARY_WRITE/);
  assert.match(second.stderr, /cleared metadata-only sqlite3 rollback/);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
  assert.equal(r4Id(d), restored);
  assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
  fs.writeFileSync(index, cleanIndex); // the image fault is gone before the retry
  const third = r2DeployCall(gw);
  assert.match(third.stdout, /MATERIALIZE_RC=0/);
  assert.match(third.stdout, /VERIFY_RC=0/);
  assert.deepEqual(r2Names(gw, '.osi-sqlite3-rollback.'), []);
});
test('R4 deploy unsafe rollback states are retained, not cleared', () => {
  for (const fault of ['original-beside-unowned', 'symlink-backup', 'foreign-owner', 'truncated-owner-with-original']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    const mods = path.dirname(d);
    const b = path.join(mods, '.osi-sqlite3-rollback.unsafe');
    const target = path.join(gw.root, 'symlinked-backup');
    if (fault === 'symlink-backup') {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, '.owner'), 'osi-sqlite3-deploy-v2\n');
      fs.symlinkSync(target, b);
    } else {
      fs.mkdirSync(b);
      fs.writeFileSync(path.join(b, '.owner'), {
        'original-beside-unowned': 'osi-sqlite3-deploy-v2\n',
        'foreign-owner': 'someone-else\n',
        'truncated-owner-with-original': 'osi-sqlite3',
      }[fault]);
      if (fault !== 'foreign-owner') {
        fs.mkdirSync(path.join(b, 'original'));
        fs.writeFileSync(path.join(b, 'original', 'kept.txt'), 'kept bytes\n');
      }
    }
    const before = fs.readdirSync(mods).sort();
    const bBefore = fs.readdirSync(b).sort();
    const dId = r4Id(d);
    const r = r4Preflight(gw);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, fault);
    assert.doesNotMatch(r.stdout, /ORDINARY_WRITE/, fault);
    assert.doesNotMatch(r.stderr, /cleared/, fault);
    assert.deepEqual(fs.readdirSync(mods).sort(), before, fault);
    assert.deepEqual(fs.readdirSync(b).sort(), bBefore, fault);
    assert.equal(r4Id(d), dId, fault);
    if (fault === 'symlink-backup') assert.equal(fs.lstatSync(b).isSymbolicLink(), true);
    if (fault === 'original-beside-unowned' || fault === 'truncated-owner-with-original')
      assert.equal(fs.readFileSync(path.join(b, 'original', 'kept.txt'), 'utf8'), 'kept bytes\n');
  }
});
test('R4 seed metadata-only rollback after a failed or interrupted old-path rename clears and retries', () => {
  for (const fault of ['status', 'interrupt']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
    const before = r4Id(d);
    const action = fault === 'status'
      ? 'echo SEED_OLD_MV_STATUS >&2; return 27' : 'echo SEED_OLD_MV_INTERRUPT >&2; exit 26';
    const hook = 'mv() { case "$1:$2" in "$DST/node_modules/sqlite3:"*/.osi-sqlite3-seed-rollback.*/original)' +
      ' ' + action + ' ;; esac; command mv "$@"; }';
    const first = r2SeedHarness(gw, { shellHooks: [hook] });
    if (fault === 'status') {
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stderr, /SEED_OLD_MV_STATUS/);
      assert.match(first.stdout, /SEED_RC=[1-9][0-9]*/);
    } else {
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /SEED_OLD_MV_INTERRUPT/);
      assert.doesNotMatch(first.stdout, /AFTER_SEED/);
    }
    const names = r2Names(gw, '.osi-sqlite3-seed-rollback.');
    assert.equal(names.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(gw.proj, 'node_modules', names[0])).sort(),
      ['.candidate-id', '.owner']);
    assert.equal(r2Names(gw, '.osi-sqlite3-seed-stage.').length, 1);
    assert.equal(r4Id(d), before);
    const second = r2SeedHarness(gw);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/);
    assert.match(second.stderr, /cleared metadata-only seed rollback/);
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-rollback.'), []);
    assert.equal(r4Id(d), before);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
    const third = r2SeedHarness(gw);
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /SEED_RC=0/);
    assert.equal(requireSqlite3(gw.proj).status, 0);
    assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n');
    assert.deepEqual(r2Names(gw, '.osi-sqlite3-seed-'), []);
  }
});
test('R4 seed partial candidate identity is metadata only and clears before an eligible retry', () => {
  for (const id of ['', '2049:1234']) {
    const gw = makeGateway('real-with-binary');
    const { d, original } = r2OldBytes(gw);
    const before = r4Id(d);
    const b = path.join(gw.proj, 'node_modules', '.osi-sqlite3-seed-rollback.partial');
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, '.owner'), 'osi-sqlite3-seed-v2\n');
    fs.writeFileSync(path.join(b, '.candidate-id'), id); // interrupted identity write
    const second = r2SeedHarness(gw);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /SEED_RC=[1-9][0-9]*/, JSON.stringify(id));
    assert.match(second.stderr, /cleared metadata-only seed rollback/);
    assert.equal(fs.existsSync(b), false);
    assert.equal(r4Id(d), before);
    const third = r2SeedHarness(gw);
    assert.match(third.stdout, /SEED_RC=0/);
    assert.match(third.stdout, /existing real sqlite3 matches image pin and loads/);
    assert.deepEqual(fs.readFileSync(path.join(d, 'original.txt')), original);
    assert.equal(r4Id(d), before);
  }
});
test('R4 seed stage with only an interrupted owner write is removed; a stage with payload and no owner is retained', () => {
  const gw = makeGateway('real-with-binary');
  const mods = path.join(gw.proj, 'node_modules');
  const partial = path.join(mods, '.osi-sqlite3-seed-stage.partial');
  fs.mkdirSync(partial);
  fs.writeFileSync(path.join(partial, '.owner'), 'osi-sqlite3-seed-st');
  const r = r2SeedHarness(gw);
  assert.match(r.stdout, /SEED_RC=0/, r.stderr);
  assert.equal(fs.existsSync(partial), false);
  const unowned = path.join(mods, '.osi-sqlite3-seed-stage.unowned');
  fs.mkdirSync(path.join(unowned, 'candidate'), { recursive: true });
  fs.writeFileSync(path.join(unowned, 'candidate', 'kept.txt'), 'kept bytes\n');
  const refused = r2SeedHarness(gw);
  assert.match(refused.stdout, /SEED_RC=[1-9][0-9]*/);
  assert.match(refused.stderr, /unowned seed stage/);
  assert.equal(fs.readFileSync(path.join(unowned, 'candidate', 'kept.txt'), 'utf8'), 'kept bytes\n');
});
test('R4 seed unsafe rollback states are retained, not cleared', () => {
  for (const fault of ['original-beside-unowned', 'foreign-owner', 'identity-beside-truncated-owner', 'partial-identity-with-original']) {
    const gw = makeGateway('real-with-binary');
    const d = path.join(gw.proj, 'node_modules', 'sqlite3');
    const mods = path.dirname(d);
    const b = path.join(mods, '.osi-sqlite3-seed-rollback.unsafe');
    fs.mkdirSync(b);
    const files = {
      'original-beside-unowned': { '.owner': 'osi-sqlite3-seed-v2\n', '.candidate-id': '1:2:3\n' },
      'foreign-owner': { '.owner': 'someone-else\n' },
      'identity-beside-truncated-owner': { '.owner': 'osi-sqlite3', '.candidate-id': '1:2:3\n' },
      'partial-identity-with-original': { '.owner': 'osi-sqlite3-seed-v2\n', '.candidate-id': '1:2' },
    }[fault];
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(b, name), value);
    if (fault === 'original-beside-unowned' || fault === 'partial-identity-with-original') {
      fs.mkdirSync(path.join(b, 'original'));
      fs.writeFileSync(path.join(b, 'original', 'kept.txt'), 'kept bytes\n');
    }
    const before = fs.readdirSync(mods).sort();
    const bBefore = fs.readdirSync(b).sort();
    const dId = r4Id(d);
    const r = r2SeedHarness(gw);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/, fault);
    assert.doesNotMatch(r.stderr, /cleared/, fault);
    assert.deepEqual(fs.readdirSync(mods).sort(), before, fault);
    assert.deepEqual(fs.readdirSync(b).sort(), bBefore, fault);
    assert.equal(r4Id(d), dId, fault);
    if (fault === 'original-beside-unowned' || fault === 'partial-identity-with-original')
      assert.equal(fs.readFileSync(path.join(b, 'original', 'kept.txt'), 'utf8'), 'kept bytes\n');
  }
});

// R5: a restore that found the final path occupied moved the original to
// <final>/original and kept its rollback directory, which now holds only
// metadata. Every later run must keep refusing. Clearing that directory would
// let the next ordinary repair move the occupant, with the original inside it,
// into a new rollback directory and delete it after a successful promotion.
// The image fault is removed first, so such a repair would succeed.
function r5Snapshot(gw, prefix) {
  const mods = path.join(gw.proj, 'node_modules');
  const d = path.join(mods, 'sqlite3');
  const nested = path.join(d, 'original');
  const backups = r2Names(gw, prefix);
  assert.equal(backups.length, 1);
  const b = path.join(mods, backups[0]);
  return {
    modules: fs.readdirSync(mods).sort(),
    backup: fs.readdirSync(b).sort().map(n => [n, fs.readFileSync(path.join(b, n), 'latin1')]),
    finalId: r4Id(d),
    finalChildren: fs.readdirSync(d).sort(),
    occupant: fs.readFileSync(path.join(d, 'occupant.txt'), 'latin1'),
    nestedId: r4Id(nested),
    nestedChildren: fs.readdirSync(nested).sort(),
    nestedOriginal: fs.readFileSync(path.join(nested, 'original.txt'), 'latin1'),
  };
}
test('R5 deploy occupied restore stays refused across fresh invocations', () => {
  for (const origin of ['final-failure', 'early']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const index = path.join(gw.fwSqlite, 'index.js');
    const cleanIndex = fs.readFileSync(index);
    const occupy = 'mv() { case "$1:$2" in */.osi-sqlite3-rollback.*/original:"$NODE_RED_ROOT/node_modules/sqlite3")' +
      ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo R5_OCCUPIED_DEPLOY_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
    let refused;
    if (origin === 'final-failure') {
      fs.appendFileSync(index, '\nif (__dirname === ' + JSON.stringify(d) +
        ') throw new Error("injected deploy final failure for occupied restore");\n');
      refused = r2DeployCall(gw, { shellHooks: [occupy] });
      assert.match(refused.stdout, /MATERIALIZE_RC=[1-9][0-9]*/, origin);
    } else {
      const interrupt = 'mv() { case "$1:$2" in "$NODE_RED_ROOT/node_modules/sqlite3:"*/.osi-sqlite3-rollback.*/original)' +
        ' command mv "$@" || return $?; echo R5_DEPLOY_INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
      const first = r2DeployCall(gw, { shellHooks: [interrupt] });
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /R5_DEPLOY_INTERRUPT_AFTER_OLD/);
      refused = r4Preflight(gw, { shellHooks: [occupy] });
      assert.match(refused.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, origin);
      assert.doesNotMatch(refused.stdout, /ORDINARY_WRITE/, origin);
    }
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stderr, /R5_OCCUPIED_DEPLOY_RESTORE/, origin);
    assert.match(refused.stderr, /restore identity differs/, origin);
    fs.writeFileSync(index, cleanIndex); // an ordinary repair would now succeed
    const snapshot = r5Snapshot(gw, '.osi-sqlite3-rollback.');
    assert.deepEqual(snapshot.backup, [['.owner', 'osi-sqlite3-deploy-v2\n']], origin);
    assert.deepEqual(snapshot.finalChildren, ['occupant.txt', 'original'], origin);
    assert.equal(snapshot.occupant, 'occupant bytes\n', origin);
    assert.equal(snapshot.nestedOriginal, original.toString('latin1'), origin);
    for (const run of ['preflight', 'full deploy']) {
      const r = run === 'preflight' ? r4Preflight(gw) : r2DeployCall(gw);
      const label = `${origin}: ${run}`;
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /PREFLIGHT_RC=[1-9][0-9]*/, label);
      assert.doesNotMatch(r.stdout, /ORDINARY_WRITE/, label);
      assert.doesNotMatch(r.stderr, /cleared/, label);
      assert.match(r.stderr, /original is present beside metadata-only rollback/, label);
      if (run === 'full deploy') {
        assert.match(r.stdout, /MATERIALIZE_RC=[1-9][0-9]*/, label);
        assert.match(r.stderr, /rollback appeared after preflight/, label);
        assert.doesNotMatch(r.stdout, /OK: materialised/, label);
      }
      assert.deepEqual(r5Snapshot(gw, '.osi-sqlite3-rollback.'), snapshot, label);
    }
  }
});
test('R5 seed occupied restore stays refused across fresh invocations', () => {
  for (const origin of ['final-failure', 'early']) {
    const gw = makeGateway('real-without-binary');
    const { d, original } = r2OldBytes(gw);
    const peer = path.join(gw.proj, 'node_modules', 'node-red-node-sqlite');
    fs.mkdirSync(peer, { recursive: true });
    fs.writeFileSync(path.join(peer, 'peer.txt'), 'peer bytes\n');
    const index = path.join(gw.fwSqlite, 'index.js');
    const cleanIndex = fs.readFileSync(index);
    const occupy = 'mv() { case "$1:$2" in */.osi-sqlite3-seed-rollback.*/original:"$DST/node_modules/sqlite3")' +
      ' mkdir -p "$2"; printf "occupant bytes\\n" > "$2/occupant.txt"; command mv "$@" || return $?; echo R5_OCCUPIED_SEED_RESTORE >&2; return 0 ;; esac; command mv "$@"; }';
    if (origin === 'final-failure') {
      fs.appendFileSync(index, '\nif (__dirname === ' + JSON.stringify(d) +
        ') throw new Error("injected seed final failure for occupied restore");\n');
    } else {
      const interrupt = 'mv() { case "$1:$2" in "$DST/node_modules/sqlite3:"*/.osi-sqlite3-seed-rollback.*/original)' +
        ' command mv "$@" || return $?; echo R5_SEED_INTERRUPT_AFTER_OLD >&2; exit 26 ;; esac; command mv "$@"; }';
      const first = r2SeedHarness(gw, { shellHooks: [interrupt] });
      assert.equal(first.status, 26, first.stderr);
      assert.match(first.stderr, /R5_SEED_INTERRUPT_AFTER_OLD/);
    }
    const refused = r2SeedHarness(gw, { shellHooks: [occupy] });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stdout, /SEED_RC=[1-9][0-9]*/, origin);
    assert.match(refused.stderr, /R5_OCCUPIED_SEED_RESTORE/, origin);
    assert.match(refused.stderr, /restore identity differs/, origin);
    fs.writeFileSync(index, cleanIndex); // an ordinary seed would now succeed
    const snapshot = r5Snapshot(gw, '.osi-sqlite3-seed-rollback.');
    assert.deepEqual(snapshot.backup.map(([n]) => n), ['.candidate-id', '.owner'], origin);
    assert.equal(snapshot.backup[1][1], 'osi-sqlite3-seed-v2\n', origin);
    assert.deepEqual(snapshot.finalChildren, ['occupant.txt', 'original'], origin);
    assert.equal(snapshot.occupant, 'occupant bytes\n', origin);
    assert.equal(snapshot.nestedOriginal, original.toString('latin1'), origin);
    for (const boot of ['next boot', 'boot after that']) {
      const r = r2SeedHarness(gw);
      const label = `${origin}: ${boot}`;
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /SEED_RC=[1-9][0-9]*/, label);
      assert.doesNotMatch(r.stdout, /OK: (seeded|existing)/, label);
      assert.doesNotMatch(r.stderr, /cleared/, label);
      assert.match(r.stderr, /original is present beside metadata-only seed rollback/, label);
      assert.deepEqual(r5Snapshot(gw, '.osi-sqlite3-seed-rollback.'), snapshot, label);
      assert.equal(fs.readFileSync(path.join(peer, 'peer.txt'), 'utf8'), 'peer bytes\n', label);
    }
  }
});

```


## Proposal apply script

```python
#!/usr/bin/env python3
"""Unexecuted, report-owned #302 R6 proposal. Run each mode as one wrapped command.

plan-only assembles the in-repo plan from the six report files beside this
script. tests-first, product and verify-candidate never read those report
files: they take every input from the approved plan commit named on the
command line, and they refuse unless this running file is byte-identical to
the apply script embedded in that commit's plan.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

P = "f6682ef6d0d90355bded9789fb4d423136ab02bb"
SELF = Path(__file__).resolve()
HERE = SELF.parent
DEPLOY = "deploy.sh"
SEED = "conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed"
MIRROR = "conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed"
TEST = "scripts/test-deploy-native-sqlite3.js"
PLAN = "docs/superpowers/plans/2026-10-28-issue-302-native-sqlite3-recovery.md"
REPORT = "issue-302-exact-recovery-plan-r6.md"
SECTIONS = (
    ("Deploy source replacement", "issue-302-r6-deploy-source.txt", "sh"),
    ("Mirrored seed operation", "issue-302-r6-seed-source.txt", "sh"),
    ("Test additions", "issue-302-r6-test-additions.js.txt", "js"),
    ("Proposal apply script", "issue-302-r6-apply-proposal.py", "python"),
    ("One-at-a-time mutant preparer", "issue-302-r6-mutants.py", "python"),
)
APPLY_INDEX = 3
FENCE_END = "\n```\n"


def git(repo, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_OPTIONAL_LOCKS="0")
    return subprocess.check_output(["git", *args], cwd=repo, env=env)


def head(repo):
    return git(repo, "rev-parse", "HEAD").decode().strip()


def parents(repo, commit):
    return git(repo, "rev-list", "--parents", "-n", "1", commit).decode().split()[1:]


def changed_paths(repo, commit):
    return sorted(git(repo, "diff", "--name-only", P, commit).decode().splitlines())


def require_clean(repo, label):
    if git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise RuntimeError(f"{label} requires a clean isolated checkout")


def exact_base(repo, rel):
    return git(repo, "show", f"{P}:{rel}")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def once(text, old, new, label):
    if text.count(old) != 1:
        raise RuntimeError(f"{label}: expected exactly one pinned anchor, found {text.count(old)}")
    return text.replace(old, new, 1)


def header(title, language):
    return f"\n\n## {title}\n\n```{language}\n"


def assemble(report, parts):
    body = report
    for (title, _name, language), text in zip(SECTIONS, parts):
        body += header(title, language) + text + FENCE_END
    return body


def decompose(plan):
    """Split an assembled plan into its report and five embedded files.

    Every section header must occur exactly once and in order, and the pieces
    must reassemble to the same text. Anything else is refused."""
    found = []
    for title, _name, language in SECTIONS:
        h = header(title, language)
        if plan.count(h) != 1:
            raise RuntimeError(f"plan section header for {title!r} occurs {plan.count(h)} times")
        found.append((plan.index(h), len(h)))
    if [start for start, _ in found] != sorted(start for start, _ in found):
        raise RuntimeError("plan sections are out of order")
    parts = []
    for i, (start, length) in enumerate(found):
        end = found[i + 1][0] if i + 1 < len(found) else len(plan)
        chunk = plan[start + length:end]
        if not chunk.endswith(FENCE_END):
            raise RuntimeError(f"plan section {SECTIONS[i][0]!r} lacks its closing fence")
        parts.append(chunk[:-len(FENCE_END)])
    report = plan[:found[0][0]]
    if assemble(report, parts) != plan:
        raise RuntimeError("plan does not reassemble from its sections")
    return report, parts


def receipt(marker, plan_bytes, parts, **extra):
    names = [name for _title, name, _language in SECTIONS]
    print(json.dumps({"marker": marker, "plan_sha256": sha(plan_bytes),
                      "sections_sha256": {n: sha(t.encode("utf-8")) for n, t in zip(names, parts)},
                      **extra}, sort_keys=True))


def approved_packet(repo, plan_commit):
    """Bind this run to the approved plan commit and return its plan bytes and files."""
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", plan_commit or ""):
        raise RuntimeError("--approved-plan-commit must be a full object id")
    if git(repo, "rev-parse", "--verify", plan_commit + "^{commit}").decode().strip() != plan_commit:
        raise RuntimeError("approved plan commit does not resolve to itself")
    if parents(repo, plan_commit) != [P]:
        raise RuntimeError("approved plan commit must have P as its sole parent")
    if changed_paths(repo, plan_commit) != [PLAN]:
        raise RuntimeError("approved plan commit must add only the plan path")
    plan_bytes = git(repo, "show", f"{plan_commit}:{PLAN}")
    _report, parts = decompose(plan_bytes.decode("utf-8"))
    if SELF.read_bytes() != parts[APPLY_INDEX].encode("utf-8"):
        raise RuntimeError("running apply script differs from the approved plan copy")
    return plan_bytes, parts


def tests_first_text(p_test, additions):
    start = "test('materialize_native_sqlite3 does not touch a real directory that has no binary', () => {"
    end = "test('verify_native_sqlite3_after_npm passes on a working module', () => {"
    if p_test.count(start) != 1 or p_test.count(end) != 1:
        raise RuntimeError("old broken-real test anchors changed")
    left = p_test.index(start)
    right = p_test.index(end, left)
    text = p_test[:left] + p_test[right:]
    seed_start = "test('the firmware seed scripts hand npm a real sqlite3 directory, identically on both profiles', () => {"
    seed_end = "test('materialize_native_sqlite3 does not abort a gateway that has no node_modules at all', () => {"
    if text.count(seed_start) != 1 or text.count(seed_end) != 1:
        raise RuntimeError("old seed string-only test anchors changed")
    left = text.index(seed_start)
    right = text.index(seed_end, left)
    text = text[:left] + text[right:]
    text = once(text,
        "    extractFunction('native_sqlite3_reinstall_impossible'),\n",
        "    extractFunction('native_sqlite3_reinstall_impossible'),\n"
        "    ...r2OptionalDeployHelpers(),\n", "optional helper extraction")
    text = once(text,
        "    `TMP_DIR=${JSON.stringify(tmp)}`,\n",
        "    `TMP_DIR=${JSON.stringify(tmp)}`,\n"
        "    'NS_LOCKED=5.1.7',\n", "test harness pin")
    text = once(text, "    body,\n  ].join('\\n');",
        "    ...(opts.shellHooks || []),\n    body,\n  ].join('\\n');",
        "test shell hooks")
    return text + "\n" + additions


def product_texts(p_deploy, p_seed, deploy_src, seed_src):
    start = "# Runs before the first write of the deploy. The one state nothing downstream"
    end = "verify_native_sqlite3_after_npm() {"
    if p_deploy.count(start) != 1 or p_deploy.count(end) != 1:
        raise RuntimeError("deploy helper anchors changed")
    left = p_deploy.index(start)
    right = p_deploy.index(end, left)
    deploy = p_deploy[:left] + deploy_src + "\n" + p_deploy[right:]
    old_intro = ('# Native sqlite must come from the OpenWrt package built for the target CPU.\n'
                 'rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"\n')
    seed = once(p_seed, old_intro, seed_src, "seed deletion")
    old_tail_start = "# A COPY, not a symlink. npm's arborist reads the tree off disk on every"
    old_tail_end = "\nchown -R node-red:node-red \"$DST\" 2>/dev/null || true"
    if seed.count(old_tail_start) != 1 or seed.count(old_tail_end) != 1:
        raise RuntimeError("seed old source/copy anchors changed")
    left = seed.index(old_tail_start)
    right = seed.index(old_tail_end, left)
    return deploy, seed[:left] + seed[right:]


def base_texts(repo):
    p_test = exact_base(repo, TEST).decode("utf-8")
    p_deploy = exact_base(repo, DEPLOY).decode("utf-8")
    p_seed = exact_base(repo, SEED).decode("utf-8")
    if exact_base(repo, MIRROR).decode("utf-8") != p_seed:
        raise RuntimeError("seed profiles differ at P")
    return p_test, p_deploy, p_seed


def require_working(repo, rel, expected, label):
    if not (repo / rel).is_file() or (repo / rel).is_symlink() or (repo / rel).read_bytes() != expected:
        raise RuntimeError(f"{label}: {rel}")


def plan_only(repo):
    if head(repo) != P:
        raise RuntimeError(f"plan-only requires exact P, found {head(repo)}")
    require_clean(repo, "plan-only")
    for rel in (DEPLOY, TEST, SEED, MIRROR):
        require_working(repo, rel, exact_base(repo, rel), "working source differs from P")
    if os.path.lexists(repo / PLAN):
        raise RuntimeError(f"plan path already exists: {repo / PLAN}")
    report = (HERE / REPORT).read_bytes().decode("utf-8")
    parts = [(HERE / name).read_bytes().decode("utf-8") for _title, name, _language in SECTIONS]
    if SELF.read_bytes() != parts[APPLY_INDEX].encode("utf-8"):
        raise RuntimeError("running apply script differs from its report copy")
    plan = assemble(report, parts)
    if decompose(plan) != (report, parts):
        raise RuntimeError("assembled plan does not decompose to its inputs")
    plan_bytes = plan.encode("utf-8")
    (repo / PLAN).parent.mkdir(parents=True, exist_ok=True)
    (repo / PLAN).write_bytes(plan_bytes)
    receipt("PROPOSED_PLAN_WRITTEN", plan_bytes, parts, report_sha256=sha(report.encode("utf-8")))


def tests_first(repo, plan_commit):
    plan_bytes, parts = approved_packet(repo, plan_commit)
    if head(repo) != plan_commit:
        raise RuntimeError("tests-first requires HEAD to be the approved plan commit")
    require_clean(repo, "tests-first")
    require_working(repo, PLAN, plan_bytes, "working plan differs from the approved plan")
    for rel in (DEPLOY, TEST, SEED, MIRROR):
        require_working(repo, rel, exact_base(repo, rel), "working source differs from P")
    p_test, _p_deploy, _p_seed = base_texts(repo)
    text = tests_first_text(p_test, parts[2]).encode("utf-8")
    (repo / TEST).write_bytes(text)
    receipt("PROPOSED_TESTS_FIRST_WRITTEN", plan_bytes, parts, test_sha256=sha(text))


def product(repo, plan_commit):
    plan_bytes, parts = approved_packet(repo, plan_commit)
    current = head(repo)
    if parents(repo, current) != [plan_commit]:
        raise RuntimeError("product requires a single test-first commit on the approved plan commit")
    if changed_paths(repo, current) != sorted((PLAN, TEST)):
        raise RuntimeError("product requires only the plan and test changed from P")
    require_clean(repo, "product")
    p_test, p_deploy, p_seed = base_texts(repo)
    expected_test = tests_first_text(p_test, parts[2]).encode("utf-8")
    if git(repo, "show", f"HEAD:{PLAN}") != plan_bytes:
        raise RuntimeError("committed plan differs from the approved plan")
    if git(repo, "show", f"HEAD:{TEST}") != expected_test:
        raise RuntimeError("committed test differs from the approved test-first text")
    require_working(repo, PLAN, plan_bytes, "working plan differs from the approved plan")
    require_working(repo, TEST, expected_test, "working test differs from the approved test-first text")
    for rel in (DEPLOY, SEED, MIRROR):
        require_working(repo, rel, exact_base(repo, rel), "product source differs from P")
    deploy, seed = product_texts(p_deploy, p_seed, parts[0], parts[1])
    (repo / DEPLOY).write_bytes(deploy.encode("utf-8"))
    (repo / SEED).write_bytes(seed.encode("utf-8"))
    (repo / MIRROR).write_bytes(seed.encode("utf-8"))
    receipt("PROPOSED_PRODUCT_WRITTEN", plan_bytes, parts,
            deploy_sha256=sha(deploy.encode("utf-8")), seed_sha256=sha(seed.encode("utf-8")))


def verify_candidate(repo, plan_commit):
    plan_bytes, parts = approved_packet(repo, plan_commit)
    current = head(repo)
    test_commit = parents(repo, current)
    if len(test_commit) != 1 or parents(repo, test_commit[0]) != [plan_commit]:
        raise RuntimeError("candidate must be product -> test-first -> approved plan commit")
    if changed_paths(repo, test_commit[0]) != sorted((PLAN, TEST)):
        raise RuntimeError("test-first commit changes paths outside the plan and test")
    if changed_paths(repo, current) != sorted((PLAN, TEST, DEPLOY, SEED, MIRROR)):
        raise RuntimeError("candidate changes paths outside the reviewed scope")
    require_clean(repo, "verify-candidate")
    p_test, p_deploy, p_seed = base_texts(repo)
    deploy, seed = product_texts(p_deploy, p_seed, parts[0], parts[1])
    expected = {
        PLAN: plan_bytes,
        TEST: tests_first_text(p_test, parts[2]).encode("utf-8"),
        DEPLOY: deploy.encode("utf-8"),
        SEED: seed.encode("utf-8"),
        MIRROR: seed.encode("utf-8"),
    }
    if git(repo, "show", f"{test_commit[0]}:{TEST}") != expected[TEST]:
        raise RuntimeError("test-first commit differs from the approved test-first text")
    for rel, data in expected.items():
        if git(repo, "show", f"HEAD:{rel}") != data:
            raise RuntimeError(f"committed candidate differs from the approved plan: {rel}")
    receipt("CANDIDATE_MATCHES_APPROVED_PLAN", plan_bytes, parts, candidate_head=current,
            files_sha256={rel: sha(data) for rel, data in expected.items()})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["plan-only", "tests-first", "product", "verify-candidate"])
    parser.add_argument("repo", type=Path)
    parser.add_argument("--approved-plan-commit")
    args = parser.parse_args()
    repo = args.repo.resolve(strict=True)
    if args.mode == "plan-only":
        if args.approved_plan_commit is not None:
            raise RuntimeError("plan-only takes no approved plan commit")
        plan_only(repo)
    elif args.mode == "tests-first":
        tests_first(repo, args.approved_plan_commit)
    elif args.mode == "product":
        product(repo, args.approved_plan_commit)
    else:
        verify_candidate(repo, args.approved_plan_commit)


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnicodeDecodeError, subprocess.CalledProcessError, RuntimeError) as exc:
        print(f"PROPOSAL_REFUSED: {exc}", file=sys.stderr)
        raise SystemExit(1)

```


## One-at-a-time mutant preparer

```python
#!/usr/bin/env python3
"""Unexecuted R5 mutant preparer. Invoke one mutant per wrapped command.

Before it copies anything, the preparer proves that the candidate descends
from the approved plan commit through exactly one test-first commit and one
product commit, and that this running file is byte-identical to the copy
embedded in that approved plan.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

P = "f6682ef6d0d90355bded9789fb4d423136ab02bb"
SELF = Path(__file__).resolve()
DEPLOY = "deploy.sh"
TEST = "scripts/test-deploy-native-sqlite3.js"
SEED = "conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed"
MIRROR = "conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed"
PLAN = "docs/superpowers/plans/2026-10-28-issue-302-native-sqlite3-recovery.md"
FILES = (DEPLOY, TEST, SEED, MIRROR)
SECTION_HEADER = "\n\n## One-at-a-time mutant preparer\n\n```python\n"
FENCE_END = "\n```\n"

# Every replacement is literal and must occur exactly once in the reviewed
# candidate. Seed changes are applied identically to both profile mirrors.
MUTANTS = {
    "M01": ("deploy", [(r'''        mns_broken_real=1''', r'''        echo 'MUTANT: broken real early return'
        return 0''')],
        "R2 RED broken matching-version real directory repairs before npm on impossible target",
        "VERIFY_RC=0 assertion"),
    "M02": ("seed", [(r'''    seed_d="$DST/node_modules/sqlite3"
    seed_sqlite3_scan_backup || return 1''', r'''    seed_d="$DST/node_modules/sqlite3"
    rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"
    seed_sqlite3_scan_backup || return 1''')],
        "R2 RED absent seed source preserves both installed entries",
        "old sqlite3 and peer sentinel read"),
    "M03": ("seed", [(r'''    if [ "$seed_copy_ok" != 1 ] || ! seed_sqlite3_loads "$seed_candidate" >/dev/null 2>&1; then''',
        r'''    if [ "$seed_copy_ok" != 1 ]; then''')],
        "R2 copied seed stage uses installed peers and falls back to firmware link",
        "SEED_RC=0 assertion"),
    "M04": ("deploy", [(r'''    if [ -z "$NS_LOCKED" ] || [ "$(native_sqlite3_pkg_version "$mns_source")" != "$NS_LOCKED" ]; then''',
        r'''    if [ -z "$NS_LOCKED" ]; then''')],
        "R2 wrong firmware version and missing pin retain broken real bytes",
        "source-version-mismatch diagnostic assertion"),
    "M05": ("deploy", [(r'''        native_sqlite3_rollback_failed_final "$mns_backup"''',
        r'''        return 1 # MUTANT: skip same-invocation rollback''')],
        "R2 deploy final-path load fault restores old real directory",
        "old sentinel read after final failure"),
    "M06": ("seed", [(r'''        if ! ln -s "$SQLITE_SRC" "$seed_candidate" ||
           ! seed_sqlite3_loads "$seed_candidate" >/dev/null 2>&1; then''',
        r'''        if ! ln -s "$SQLITE_SRC" "$seed_candidate"; then''')],
        "R3 failing fallback-link probe preserves the old seed entry",
        "SEED_RC nonzero assertion"),
    "M07": ("deploy", [(r'''    for mns_stale in "$mns_modules"/.osi-sqlite3-stage.*; do''',
        r'''    for mns_stale in "$mns_modules"/.osi-sqlite3-stage.NO_MATCH; do''')],
        "materialize_native_sqlite3 clears a staging directory left by a deploy killed mid-swap",
        "stale stage absent assertion"),
    "M08": ("deploy", [
        (r'''    if native_sqlite3_present "$mns_marker"; then
        echo "ERROR: copied sqlite3 stage already contains an ownership marker: $mns_marker" >&2
        return 1
    fi''', r'''    : # MUTANT: skip copied-marker presence check'''),
        (r'''       ! native_sqlite3_new_exact_file "$mns_marker" "$mns_backup"; then''',
         r'''       ! printf '%s\n' "$mns_backup" > "$mns_marker"; then'''),
    ], "R3 copied deploy marker symlink cannot overwrite its target or the old module",
        "external target bytes unchanged assertion"),
    "M09": ("seed", [
        (r'''    if seed_sqlite3_present "$seed_marker"; then
        echo "ERROR: copied seed candidate already contains an ownership marker: $seed_marker" >&2
        return 1
    fi''', r'''    : # MUTANT: skip copied-marker presence check'''),
        (r'''        if ! seed_sqlite3_new_exact_file "$seed_marker" "$seed_b"; then''',
         r'''        if ! printf '%s\n' "$seed_b" > "$seed_marker"; then'''),
    ], "R3 copied seed marker symlink cannot overwrite its target or the old module",
        "external seed target bytes unchanged assertion"),
    # R4 keeps the M10/M11 anchors, tests and assertions. The replacement now
    # rescans first, exactly as a fresh invocation does, because R4 recovery
    # reads the classification the scanner sets.
    "M10": ("deploy", [(r'''        native_sqlite3_rollback_failed_final "$mns_backup"''',
        r'''        native_sqlite3_scan_backup || return 1
        native_sqlite3_recover_early''')],
        "R3 deploy final failure restores old module without a second lock fetch",
        "old sentinel read after failed second fetch"),
    "M11": ("seed", [(r'''        seed_sqlite3_rollback_failed_final "$seed_b"''',
        r'''        seed_sqlite3_scan_backup || return 1
        seed_sqlite3_recover''')],
        "R3 seed final failure restores old module after the source lock disappears",
        "old sentinel read after failed second pin read"),
    "M12": ("deploy", [(r'''       [ "$(native_sqlite3_id "$native_restore_d")" != "$native_restore_id" ]; then''',
        r'''       [ 0 -ne 0 ]; then''')],
        "R3 occupied deploy restore retains the marker and nested original for inspection",
        "retained rollback marker count assertion"),
    "M13": ("seed", [(r'''       [ "$(seed_sqlite3_restore_id "$seed_restore_d")" != "$seed_restore_expected" ]; then''',
        r'''       [ 0 -ne 0 ]; then''')],
        "R3 occupied seed restore retains the marker and nested original for inspection",
        "retained rollback marker count assertion"),
    "M14": ("deploy", [(r'''    if [ -e "$nsp_installed" ]; then''',
        r'''    if native_sqlite3_present "$nsp_installed"; then''')],
        "R4 dangling installed symlink still compares the firmware version before writes",
        "nonzero preflight status assertion"),
    "M15": ("deploy", [(r'''    if [ "$NS_B_META" = 1 ] && ! native_sqlite3_owned_final "$NS_B"; then''',
        r'''    if false; then # MUTANT: refuse a metadata-only rollback''')],
        "R4 deploy metadata-only rollback after a failed or interrupted old-path rename clears and retries",
        "cleared metadata-only message assertion"),
    "M16": ("seed", [(r'''    if [ "$SEED_B_META" = 1 ] && ! seed_sqlite3_owned_final "$SEED_B"; then''',
        r'''    if false; then # MUTANT: refuse a metadata-only rollback''')],
        "R4 seed metadata-only rollback after a failed or interrupted old-path rename clears and retries",
        "cleared metadata-only message assertion"),
    "M17": ("deploy", [(r'''        if ! native_sqlite3_present "$ns_b/original"; then NS_B_META=1; fi''',
        r'''        NS_B_META=1 # MUTANT: ignore a retained original''')],
        "R4 deploy unsafe rollback states are retained, not cleared",
        "rollback contents unchanged assertion"),
    "M18": ("seed", [(r'''        if ! seed_sqlite3_present "$seed_b/original"; then SEED_B_META=1; fi''',
        r'''        SEED_B_META=1 # MUTANT: ignore a retained original''')],
        "R4 seed unsafe rollback states are retained, not cleared",
        "rollback contents unchanged assertion"),
    # R5: drop the nested-original exclusion, so a metadata-only rollback left
    # by an occupied restore is cleared on the next run, as in R4.
    "M19": ("deploy", [(r'''        if native_sqlite3_present "$ns_d/original"; then
            echo "ERROR: $ns_d/original is present beside metadata-only rollback $NS_B; an earlier restore may have nested the old module there; preserving both for inspection" >&2
            native_sqlite3_report_paths "$NS_B" "$ns_d" "$ns_d/original"
            return 1
        fi''', r'''        : # MUTANT: clear despite a nested original at the final path''')],
        "R5 deploy occupied restore stays refused across fresh invocations",
        "no cleared message assertion on the first fresh preflight"),
    "M20": ("seed", [(r'''        if seed_sqlite3_present "$seed_d/original"; then
            echo "ERROR: $seed_d/original is present beside metadata-only seed rollback $SEED_B; an earlier restore may have nested the old module there; preserving both for inspection" >&2
            seed_sqlite3_report_paths "$SEED_B" "$seed_d" "$seed_d/original"
            return 1
        fi''', r'''        : # MUTANT: clear despite a nested original at the final path''')],
        "R5 seed occupied restore stays refused across fresh invocations",
        "no cleared message assertion on the next boot"),
}


def git(repo, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_OPTIONAL_LOCKS="0")
    return subprocess.check_output(["git", *args], cwd=repo, env=env)


def parents(repo, commit):
    return git(repo, "rev-list", "--parents", "-n", "1", commit).decode().split()[1:]


def changed_paths(repo, commit):
    return sorted(git(repo, "diff", "--name-only", P, commit).decode().splitlines())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def embedded_preparer(plan):
    if plan.count(SECTION_HEADER) != 1 or not plan.endswith(FENCE_END):
        raise ValueError("approved plan does not end with exactly one mutant preparer section")
    return plan[plan.index(SECTION_HEADER) + len(SECTION_HEADER):-len(FENCE_END)]


def main():
    if len(sys.argv) != 6 or sys.argv[1] not in MUTANTS:
        raise ValueError("usage: mutants.py M01..M20 candidate_repo token_root "
                         "expected_candidate_head approved_plan_commit")
    mid, repo_arg, token_arg, expected_head, plan_commit = sys.argv[1:]
    for label, value in (("candidate head", expected_head), ("approved plan commit", plan_commit)):
        if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value):
            raise ValueError(f"{label} must be a full object id")
    repo = Path(repo_arg).resolve(strict=True)
    token_root = Path(token_arg).resolve(strict=True)
    if not token_root.is_dir() or token_root == repo or repo in token_root.parents:
        raise ValueError("token root must be an existing separate directory")
    if git(repo, "rev-parse", "HEAD").decode().strip() != expected_head:
        raise ValueError("candidate head changed")
    if git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("candidate checkout is not clean")
    if parents(repo, plan_commit) != [P]:
        raise ValueError("approved plan commit must have P as its sole parent")
    test_commit = parents(repo, expected_head)
    if len(test_commit) != 1 or parents(repo, test_commit[0]) != [plan_commit]:
        raise ValueError("candidate must be product -> test-first -> approved plan commit")
    if changed_paths(repo, expected_head) != sorted((PLAN, *FILES)):
        raise ValueError("candidate changes paths outside the reviewed scope")
    plan = git(repo, "show", f"{plan_commit}:{PLAN}")
    if git(repo, "show", f"HEAD:{PLAN}") != plan:
        raise ValueError("candidate plan differs from the approved plan commit")
    if SELF.read_bytes() != embedded_preparer(plan.decode("utf-8")).encode("utf-8"):
        raise ValueError("running mutant preparer differs from the approved plan copy")
    if (repo / SEED).read_bytes() != (repo / MIRROR).read_bytes():
        raise ValueError("candidate seed mirrors differ")
    attempt = token_root / ("mutant-" + mid)
    if os.path.lexists(attempt):
        raise ValueError("immutable mutant attempt already exists")
    for rel in FILES:
        dst = attempt / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / rel, dst)
    surface, edits, test_name, assertion = MUTANTS[mid]
    targets = (DEPLOY,) if surface == "deploy" else (SEED, MIRROR)
    for rel in targets:
        p = attempt / rel
        original = p.read_bytes().decode("utf-8")
        changed = original
        for old, new in edits:
            if changed.count(old) != 1:
                raise ValueError(f"{mid}: expected one exact anchor in {rel}, found {changed.count(old)}")
            changed = changed.replace(old, new, 1)
        p.write_bytes(changed.encode("utf-8"))
        print(json.dumps({"mutant": mid, "path": rel, "original_sha256": sha(original.encode("utf-8")),
                          "mutant_sha256": sha(changed.encode("utf-8"))}, sort_keys=True))
    print(json.dumps({"marker": "MUTANT_READY", "mutant": mid, "candidate_head": expected_head,
                      "approved_plan_commit": plan_commit, "plan_sha256": sha(plan),
                      "preparer_sha256": sha(SELF.read_bytes()), "attempt": str(attempt),
                      "test_name": test_name, "expected_failed_assertion": assertion}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnicodeDecodeError, subprocess.CalledProcessError, ValueError) as exc:
        print(f"MUTANT_SETUP_REFUSED: {exc}", file=sys.stderr)
        raise SystemExit(1)

```
