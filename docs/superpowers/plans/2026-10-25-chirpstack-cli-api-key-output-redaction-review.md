# Adversarial plan review: Open-Smart-Irrigation/osi-os #522

- Reviewer: independent context `/root/osi_plan_review` (`gpt-6-luna`)
- Date: 2026-10-25
- Plan: `docs/superpowers/plans/2026-10-25-chirpstack-cli-api-key-output-redaction.md`
- Scope: source behavior, test harness, failure and success coverage, mirror parity, workflow commands, contribution procedure, and push target.

## Initial review

### Required findings and disposition

1. **Push target was underspecified.** The checkout had only `origin`, pointing to upstream.
   **Applied:** verify GitHub login `dannyward630`; verify whether the fork exists; require exact fork owner and parent metadata; use an exact `user-fork` URL; push only the feature branch; compare the remote branch SHA; never push to upstream `origin`.
2. **Success path was not covered.** Existing tests did not exercise CLI API-key creation.
   **Applied:** add a full-bootstrap success case that uses a synthetic token, asserts one CLI call, captures the API key passed to the fake ChirpStack client, and asserts persistence.

### Optional finding and disposition

- **Assert the parsed key reaches the fake client.** Applied with `clientApiKeys` capture and equality to the synthetic token.
- Initial final re-review: **PASS; no required findings**. The test sequencing, focused filter, full-file gate, and pre-fix red expectation were consistent.

## Incremental plan reviews

1. The first focused test exposed the Windows CRLF shebang issue. The plan changed the test source-loader regex to accept LF or CRLF. Reviewer: **PASS; no required findings**.
2. The full bootstrap test exposed three codec fixture comparisons where production normalizes CRLF to LF but the expected test fixture did not. The plan normalizes only the expected fixture. Reviewer: **PASS; no required findings**.
3. The sync-flow verifier first lacked `sqlite3.exe`. The plan obtains official SQLite tools in TEMP, verifies the published digest/version, and guards cleanup by containment and reparse checks. Reviewer: **PASS; no required findings**.
4. The verifier skipped its durable migration leg because the clone was shallow. The plan verifies upstream `origin`, fetches full `main` history with blob filtering, then checks the pinned baseline commit. Reviewer: **PASS; no required findings**.
5. The first full-history run failed an unrelated raw-byte fixture assertion. The initial plan preserved all six planned paths, disabled autocrlf in the temporary clone, restored indexed content, and reapplied the patch. Reviewer: **PASS**. Execution then showed that `checkout-index --force --all` did not normalize two unchanged CRLF files; a recovery stanza was added to verify the stash SHA/path set and restore only the four planned tracked edits. A review required checking the full tracked stash path set; that was applied. A follow-up caught Node 24's required `execFileSync` encoding options object; applied. Reviewers: **PASS**.
6. A path-scoped `git checkout-index --force` also returned success without rewriting the two known CRLF worktree files. The plan switched to writing exact index blobs only after proving index equals HEAD and worktree differs solely by CRLF. Reviewer found a **required safety gap**: reads/writes could follow a symlink or reparse point, and a hardlink could redirect a write. **Applied:** canonical realpath must equal the lexical in-repository path; `lstat` must report a regular non-symlink file; `nlink` must equal 1; index must equal HEAD; pre- and post-write bytes are compared. Reviewer: **PASS; no required or optional findings**.
7. Writing the two index blobs succeeded, but `git update-index --really-refresh` returned nonzero while reporting the planned modified files as needing update. The plan removed that command and used direct byte equality, scoped diff, EOL output, and status instead. Reviewer: **PASS**.
8. The next sync-flow run passed the JSON fixture assertion but found a CRLF-only difference in the paired `edge-selection-v1.sha256`. The plan added that exact sidecar to the allowlist and made the procedure idempotent: already index-identical files are not rewritten; only CRLF-only differences may be written. Reviewer: **PASS; no required findings**.
9. After writing the sidecar, byte comparisons showed all three files equal HEAD/index and `git ls-files --eol` showed LF, but Git status still marked the sidecar modified due stale stat data. A path-scoped `git update-index --refresh` was added and reviewed: **PASS**. Execution showed that command also returned nonzero with `needs update` messages for the modified source files and sidecar. The latest plan revision replaces it with `git add` on only the three byte-verified paths, then checks both cached and unstaged diffs and final status. Reviewer confirmed this refreshes metadata for only those identical paths; the immediate cached and unstaged diff checks ensure it stages no content. Final re-review: **PASS; no findings**.

10. Native Windows sync-flow passed the database, schema, history, fixture, and Terra tests, then failed two unrelated recovery-adapter tests because they assume POSIX absolute paths. Ubuntu WSL was found and validated: Node v22.22.1 supports the required built-in SQLite module, explicit GIT_DIR/GIT_WORK_TREE lets Git inspect this linked worktree, and the official SQLite 3.54.1 Windows binary runs through WSL interop. The first WSL plan review found two required issues: WSL may not execute an extensionless symlink to a Windows executable, and the cleanup target misspelled `djwar`. **Applied:** replace the symlink with an extensionless Linux shell wrapper that explicitly execs the verified `.exe` path, and correct the cleanup path. The reviewer must re-review the wrapper and exact cleanup before resuming verification.

11. The wrapper re-review found the shell here-document body and SH terminator had one literal leading space after Markdown unindentation, so Bash would not close the here-document and the shebang would not start at byte zero. Applied: align the cat command, body, and delimiter with the code-block indentation so the copied bash -lc input has a column-zero heredoc delimiter and exact wrapper bytes. This final formatting amendment is awaiting review; do not run the WSL setup until approved.

The reviewer confirmed that Markdown removes exactly the code block's five-space indentation, leaving the WSL heredoc command/body/SH terminator correctly aligned and the generated wrapper contents exactly matching cleanup validation. The cleanup content comparison and nonrecursive removal are sound. Final re-review: PASS; no required findings.

12. The first WSL setup attempt failed before creating anything: PowerShell passed the multiline here-string to native WSL without one-argument quoting, so the Bash script did not receive the intended tool assignment; a read-only check confirmed the unique /tmp path remains absent. Applied: invoke each multiline setup, verifier, and cleanup string as bash -lc "$variable" so PowerShell passes it as one argument. A harmless WSL printf probe confirmed quoted command strings execute. This invocation correction is awaiting review; do not retry setup until approved.

The reviewer confirmed all three WSL invocations pass their multiline scripts as one bash -c argument and that the PowerShell/native-WSL quoting matches the successful harmless probe. Final re-review: PASS; no required findings.

13. The second setup attempt still passed an empty tool variable despite the quoted multiline argument; no WSL temp directory was created. **Applied:** replace multiline bash -lc argument passing with one LF-only PowerShell-created script in TEMP, invoked by its single mounted path. It has run and cleanup modes, creates/verifies the Linux wrapper, sets Git paths, and runs sync-flow; PowerShell verifies exact script bytes and TEMP containment before removal. This revised transport and cleanup are awaiting review; do not run it yet.

14. The independent plan review found that cleanup executed the temporary WSL script before checking its TEMP containment, reparse status, and exact contents. **Applied:** move those guards before invoking cleanup mode, then repeat them before deleting the script. The shell cleanup remains limited to checking and removing the exact wrapper plus an empty directory. This order correction is awaiting review; do not execute cleanup until approved.

The reviewer confirmed the WSL cleanup script is checked for TEMP containment, reparse status, and exact bytes before WSL executes cleanup, with the checks repeated before deletion. The setup file is read back before execution, and WSL receives one script-path argument. Final re-review: PASS; no required findings.

15. Before executing the WSL runner, I added a final PowerShell reparse-point check after writing and reading back its exact LF bytes, in addition to the existing TEMP containment check. This makes the setup execution boundary explicit; the added guard is awaiting review.

The reviewer approved the added pre-execution reparse check and cleanup sequence. Optional precision: PowerShell ReadAllText compares decoded content, while WriteAllText with UTF8Encoding(false) writes without BOM; the plan's failure text now says script text rather than exact bytes.

Final WSL runner review: the reviewer confirmed the PowerShell char-based CRLF/LF conversion and no-BOM write. The runner's exact text, path, and reparse checks precede execution; cleanup checks precede WSL cleanup and repeat before removing the script. Final plan review: PASS.

17. The reviewed WSL SQLite wrapper failed during database integrity because
the Windows sqlite3.exe could not open the WSL /mnt/c database path. The
verification plan now downloads the official SQLite 3.54.1 Linux x64 archive,
verifies its published SHA3-256, extracts only its regular sqlite3 member into
a unique WSL /tmp directory, verifies the extracted hash/version, and runs the
sync-flow verifier with native Linux SQLite. The plan stops for amendment and
re-review if the mounted repository still cannot be opened. The runner and its
cleanup guards are awaiting adversarial review; do not execute it until approved.

18. The independent re-review found a required ownership race: the exit trap
was installed before mkdir, so a failed mkdir could trigger cleanup against a
directory created by another process. Applied: create the unique Linux /tmp
directory with mode 0700 first, set an ownership flag only after mkdir succeeds,
and install the cleanup trap afterward. This amended runner is awaiting
independent re-review; do not execute it until approved.
19. The reviewer passed the ownership-order revision. Optional feedback noted
that Windows TEMP runner cleanup is planned after independent verification,
and recommended a second SHA3 check in WSL to close the interval between
PowerShell validation and extraction. Applied: the WSL runner now verifies
Node v22.22.1 and recomputes the official archive SHA3 immediately before
opening the zip for member extraction. The amended runner awaits final review.
20. The reviewer identified that a standalone WSL SHA3 check was separated
from zip member hashing and extraction by further archive reads, leaving a
replacement window, and asked for concrete guarded Windows TEMP cleanup
commands. Applied: WSL Python now verifies SHA3 and hashes the member from an
in-memory archive buffer during preflight, then re-reads the archive and
verifies SHA3 again over the same in-memory bytes used for extraction.
The plan now includes exact path, reparse, content, and published-hash guards
before removing the runner and downloaded SQLite tools. These revisions await
final independent review; do not run the verifier yet.

21. Independent review found two required cleanup errors: a doubled backslash
in the TEMP prefix and a comparison of the extracted Windows executable to the
Windows zip's digest; it also noted Step 4 and Step 8 duplicated removal of the
same tools directory. Applied: Step 4 now defers cleanup to Step 8. Step 8 uses
one backslash, verifies both archive hashes, checks the created tools folder
contains only the four known executables and verified Linux zip, rejects
reparse points, removes each known file once, and removes the empty folder.
Final review: PASS, no findings.

22. Final review confirmed that the WSL preflight and extraction each verify
the official archive SHA3 over the bytes they use, the extracted sqlite3 hash
matches the verified member, and the ownership-aware trap remains safe. Step 8
checks the single-backslash TEMP prefix, runner text, exact tools-directory
contents, absence of reparse points, and both archive digests before removing
each temporary file once. The earlier optional runner-cleanup recommendation
is covered by these guarded commands. Final plan re-review: PASS; no findings.

23. The native Linux SQLite run against the /mnt/c checkout reached the
later sync-flow checks, then failed because Windows Git symlink placeholders
were exposed as regular text files to Linux Node; the osi-history-helper
placeholder caused a JavaScript parse error, osi-db-helper was unavailable,
and two migration-generator assertions also failed in that checkout view.
The Git index records 53 symlinks. Applied: the plan no longer runs the suite
against the mounted worktree. The guarded runner now creates a Linux-native
checkout from the current Git index with core.symlinks=true, overlays only
the four modified tracked files and two untracked plan records, verifies the
indexed symlink count, checks overlay bytes, and runs all five gates there.
The native copy is kept for independent verification and PR creation, then
removed by an exact-root, owner, mode, source-file, and no-.git guarded find
cleanup after the PR. This verification amendment awaits adversarial review.

24. The reviewer found that native-copy reuse checked the six overlays and
symlink count but did not detect unrelated tracked-file drift or a substituted
symlink target. Applied: after the overlay loop, both fresh and reused copies
must have an empty staged diff, exactly the four planned tracked changes, and
exactly the two plan records as untracked files. The optional expected symlink
count is pinned to 53 in addition to the materialization comparison. This
integrity revision received final independent review: PASS, no findings.
The reviewer confirmed the allowlists run after overlay for both new and reused
copies, the core.symlinks checkout is correctly scoped, all five gates use the
native copy, and the post-PR cleanup does not follow symlink targets. Final
plan re-review: PASS.

25. The first native-copy verification run fixed the WSL symlink failures and
passed the focused test, profile parity, test inventory, and the earlier
sync-flow subchecks, then failed nine live-gateway identity mode assertions:
tracked executable files were mode 700 instead of expected 755 because the
runner used umask 077 during checkout-index. Applied: keep the private checkout
root at mode 700, use umask 022 while checkout-index materializes files, force
checkout tracked entries again on each run to repair an existing copy, and
assert the root remains mode 700. Final re-review: PASS, no findings. The
reviewer confirmed that checkout-index repairs modes on reuse while preserving
the private root, and that the six overlays, staged/tracked/untracked
allowlists, 53-symlink check, five gates, and guarded cleanup remain correct.

26. A final acceptance-criteria audit found that the test combined stdout and
stderr when asserting marker absence and did not make the process-error stdout
fixture token-shaped. Applied: check each stream independently and put a
synthetic `token:` value in captured stdout for the failed command. Updated
the plan's test example to match. The focused Node test passed 22/22 on the
current checkout. The plan reviewer confirmed that the example matches the
test and satisfies the issue's malformed-output, token-shaped failed-output,
separate stdout/stderr, and bounded-status requirements: PASS, no findings.
The five-gate WSL runner passed before this test-only strengthening; the
production scripts did not change. An independent current-checkout focused
rerun passed 22/22, and the three production mirrors remained byte-identical.
