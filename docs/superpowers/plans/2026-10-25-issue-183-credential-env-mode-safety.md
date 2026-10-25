# Issue 183: credential env-file mode safety

This plan repairs credential-file creation, replacement and already-provisioned deploys. It requires independent design approval before implementation. The parent lifted the heavy hold after `APPROVE resource-review-r3` and verified wrapper/sampler state. Subsequent bounded design checks use the campaign wrapper with saved outputs. No product implementation, install, live operation or GitHub write is authorized by this plan.

Independent review round 1 requested changes to plan commit `0936f2f8ad55593ccc635ea8673bb29d43714b9a`. This amendment responds to the complete campaign `reports/issue-183-plan-review-r1.md`, including its four synthetic counterexamples and acceptance/test/gate audits. R1 binds every deploy invocation to the canonical file. R2 defines fatal credential-filesystem status 74 through cleanup and both deploy callers. R3 makes snapshots/backups byte-exact and refuses lossy text input before API/config mutations. These are author responses awaiting a NEW independent plan review, not approval of the amended design.

## Binding and evidence

The clean T3 binding is `/home/phil/.t3/worktrees/osi-os/t3-97ed5eed`, branch `t3/credential-env-mode-safety`. It started at stale parent `c37207b30b002fb79da8ae57253d78c04613b6a5`. After verifying the clean separate binding, `git fetch --no-tags origin main` and `git merge --ff-only origin/main` advanced only this branch to `63c7a70f8f3b373f162b33b0669b0df89b3763fa`. Fetched `origin/main` and the immutable campaign base have that same SHA: there is no base delta to reconcile. The user's root checkout stayed on its existing branch/commit. The campaign `base` checkout was read only.

Inputs read: `AGENTS.md`, `docs/engineering-playbook.md`, `docs/superpowers/README.md`, the pitfalls/config/verification/prose/schema-change/live-ops skills, campaign `COORDINATION.md`, `reports/issue-183-finder.md`, `reports/issue-183-coordinator-evidence.md`, and the wrapper source `run-heavy.py`. The relevant deploy guidance forbids reseeding a provisioned database and separates payload rollback from committed schema changes. This task needs no schema work.

Fresh GitHub reads on October 25, 2026:

| Evidence | Finding and limit |
|---|---|
| [Issue 183](https://github.com/Open-Smart-Irrigation/osi-os/issues/183) | Open, `priority:P0`; concerns a global-admin credential. Fleet modes and compromise were not independently inspected. |
| [Comment 6020038316](https://github.com/Open-Smart-Irrigation/osi-os/issues/183#issuecomment-6020038316) | Reports two rehearsal files at `0644`, repair preserving their modes, and historical key accumulation. |
| [Comment 6054156575](https://github.com/Open-Smart-Irrigation/osi-os/issues/183#issuecomment-6054156575) | Reports key/profile counts and requests reuse/cleanup. Also says that particular deploy changed none of those tables. Counts are reported observations, not measurements by this author. |
| [Issue 181](https://github.com/Open-Smart-Irrigation/osi-os/issues/181) | Open, no comments at this read; full provisioning can replace custom profile fields. Keep this separate. |
| [PR 423](https://github.com/Open-Smart-Irrigation/osi-os/pull/423) | Merged at `e61140b01a0732093dee515b35b3b0fbe08c8226`, head `69c7aba2625c190384254a9b3e475f038c6df528`. Its bootstrap patch added the soil repair and mode-preserving atomic writer. Existing approval/test claims do not validate this proposed change. |

P0 is justified by the secret-bearing writer and the coordinator's prior synthetic reproduction under umask `022`. That reproduction extracted the exact old `writeEnvFile`, wrote only a synthetic placeholder, observed `0644`, exited 0 and removed its temporary directory. It was performed before this design assignment and is separate from the new probe below. Current source independently confirms the unsafe defaults. Actual deployed ownership/modes remain unverified.

After the hold release, this author separately reproduced the same old-writer defect and checked the proposed Linux publication primitives. `artifacts/issue-183/design-probe.js` and its `.log`/`.status` are saved in the campaign directory. The wrapper command exited 0 at base `63c7a70f`, cwd this isolated worktree. It observed old full-writer creation and replacement at `0644`, verified descriptor-based narrowing/fsync, same-filesystem rename, exclusive hard-link publication (`EEXIST` on collision), parent-directory fsync, and no-follow symlink refusal with an unchanged sentinel. All data was synthetic and the temporary directory was removed. It ran as UID/GID 1000; it proves neither root ownership nor OpenWrt behavior nor a candidate writer's correctness.

The existing bootstrap/Clover and deploy gateway-setup suites also ran through the wrapper with a 60-second timeout on unchanged product source: 51 tests passed, 0 failed/skipped/cancelled, exit 0. Logs/status are `artifacts/issue-183/design-base-regressions.log` and `.status`. This establishes a usable baseline for those two suites; the other proposed candidate gates remain pending.

## Acceptance contract and scope dispositions

| ID | Required behavior | Planned evidence |
|---|---|---|
| A1 | Every newly published live env file is a regular root:root file, exactly `0600`, with complete content. No secret bytes enter a permissive staging file. | T1, T3, T8 |
| A2 | Existing regular files are narrowed before reads, API/key creation, backup, or content mutation. Repair includes no-op soil repair and deploys that already have Gen2. | T2, T4, T7 |
| A3 | Full provisioning updates its managed assignments and retains unrelated lines; soil repair retains its one-key content contract. | T3, T4, T7 |
| A4 | `.pre-gen2` remains available, root:root `0600`, and is not overwritten or deleted on success, failure, or rollback. | T5, T7, T8 |
| A5 | Symlinks (including dangling links), nonregular files, hard links, unsupported no-follow primitives, and unexpected temp collisions fail closed. Unrelated targets remain byte- and mode-identical. | T6, T8 |
| A6 | Failure before publication leaves prior live bytes intact and narrowed. Failure after publication is reported without restoring an unsafe mode or guessing credential ownership. | T8, T9 |
| A7 | Root service consumers keep the same file path, line format and precedence; all three bootstrap copies match. | T3, T4, G2, G3, G4 |
| A8 | Parent approves a fresh independent plan review, then obtains independent execution verification at the final candidate SHA. | Review records, no author self-approval |

These acceptance criteria are unchanged. A3's byte-preservation obligation means malformed UTF-8 blocks full/soil text mutation while preserving the raw file and narrowed mode; mode-only repair and raw backup still work. A5 applies under administrative serialization and the trusted-directory-writer assumption throughout the operation, including stage creation/opening. It does not promise integrity against a malicious enclosing-directory owner.

The mode defect can be delivered independently, but issue 183 must not be marked fully closed while its lifecycle comments have no accepted disposition. Parent owns GitHub and the ledger. Propose these separately tracked/deduplicated follow-ups before any closure wording:

1. Key lifecycle: reuse a still-authenticating existing env key in full bootstrap; define proof of bootstrap ownership and safe replacement/revocation; handle interruption after minting but before persistence. A shared `osi-nodered` name is not ownership proof. Do not list, revoke, rotate or delete any real key in this work.
2. Profile lifecycle: establish tenant ownership and all configured/device references, then design a dry-run cleanup with explicit operator acceptance. Current full provisioning already reuses an exact name within its chosen tenant. Counts alone do not prove each current repair creates duplicates. Do not delete profiles by name or guessed lack of use.
3. Profile customization: coordinate with existing issue 181 instead of creating a duplicate. Preserve that issue's full-replace versus read/modify/write decision for its own review. This plan does not alter `getOrCreateProfileWithCodec`, `ensureProfileCodec`, tenant selection, codec policy, or device repointing.
4. Directory ownership boundary: the package postinstall recursively assigns `/srv/node-red` to `node-red`, although procd currently runs Node-RED as root. Record this as an integrity/lifecycle hardening question for parent triage; do not silently change the service user or directory ownership here. File mode repair does not secure a compromised owner of the enclosing directory or a process already holding an old descriptor.
5. CLI-output disclosure is tracked separately as [P1 issue 522](https://github.com/Open-Smart-Irrigation/osi-os/issues/522). Parent independently confirmed propagation of synthetic unexpected CLI output and a synthetic exec error through unchanged `createApiKeyViaCLI`, searched for duplicates and published that issue. This plan does not redact or otherwise change that function or the legacy non-credential error output. New credential-filesystem/usage diagnostics must not expose bytes or raw exception messages; that is not a blanket claim about existing bootstrap errors. Neither report used a real key/CLI or established a deployed incident.

There are no new UCI settings, environment knobs, schema changes, npm dependencies, modules, registries or server companion. Two internal CLI operations proposed below are needed so deploy uses the same filesystem policy before its conditional provisioning and without loading gRPC dependencies. They are operations, not configurable policy switches. Independent review must explicitly approve that small interface addition and the Linux descriptor-path requirement.

## Source map and exact claims

Line numbers below refer to base `63c7a70f`; find the named function if they move.

| File/function/caller | Current behavior | Disposition |
|---|---|---|
| `scripts/chirpstack-bootstrap.js:326`, `writeEnvFile` | `writeFileSync(..., 'utf8')`: creation follows umask, replacement truncates and preserves mode; follows symlink. | Replace with merge plus the single safe publisher. |
| Same file:501, `readEnvFileText` | Reads path directly and decodes UTF-8 without validation. | Replace with `readEnvFileForMutation`: checked raw Buffer snapshot, then lossless decoding before API/config effects. |
| Same file:542, `writeEnvFileAtomic` | Copies old mode, opens predictable `.soil-repair.tmp` with `w`, fsyncs then renames; failure can leave temp. | Replace implementation, keep this function as the soil caller's adapter. |
| Same file:640/664, `repairCloverProfile` | Calls writer only when Clover env value changes. | Keep profile logic; pass current text to safe publisher with a checked snapshot. |
| Same file:708, `repairSoilProfiles` | Reads/reuses env key, can fail or finish without env rewrite. | Preflight narrows even these paths. No new API behavior. |
| Same file:735/807, `main` | Can mint key and mutate ChirpStack before env write; then writes UCI, optionally patches settings, validates flows. | Filesystem preflight before any key/API action; keep later ordering. |
| Same file:841, `run`/`parseRepairArgs`; top-level `loadChirpStackHelper()` | Eager gRPC helper load; repair options only. | Dispatch file-only operations first, then load helper lazily for normal modes. |
| `deploy.sh:2492` bootstrap fetch | Installs `/srv/node-red/chirpstack-bootstrap.js` late. | Move this exact fetch earlier, before `enable_osi_bootstrap` and its env read at ~1878. Delete the old duplicate fetch. |
| `deploy.sh:2532–2573` Gen2 sequence | Reads key, `cp`s fixed backup, bootstraps, appends missing lines directly, chmods backup only. | Secure early, create exclusive safe recovery backup, remove `cp` and append loop, check live file after both full-bootstrap outcomes. |
| `deploy.sh:2585` soil caller | Warn-only API repair when sensors app is configured. | Keep API warning policy, bracket with file-security checks that are fatal. |
| `deploy.sh:512`, `print_bootstrap_note` | Says full rewrite drops other keys. | Correct this prose; keep its service-based explicit key-reuse command. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js` | Shipped first-boot script. | Byte-copy the changed canonical script. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js` | Other maintained profile. | Byte-copy the same script in the same commit. |
| Both profiles' `files/etc/init.d/osi-bootstrap`, `start` | Prefers ROM script, fallback to `/srv`; stamp skips the writer on provisioned boots; only stamps on bootstrap success and then requests coordinated restart. | Read-only claim, no edits. Only invocations of an updated script have the new preflight. Deploy updates the fallback, not an older installed ROM script. Stamped boots skip it; repair comes from the new deploy gates or a new image. |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`, `load_chirpstack_env_value`/`start_service` | UCI first, env per-key fallback; procd command has no user switch. | Read-only claim. Root can read `0600`; retain path/precedence. |
| Same directory `settings.js`, `loadChirpstackEnvFile` | Fills missing non-identity keys for non-procd starts. | Read-only claim. Preserve protected identity keys and file format. Non-root manual starts need an operator decision, not wider credential access. |
| `scripts/prepare-pi-communication-config.sh`, `scripts/diagnose-pi-communication.sh` | Read env; first tool can write UCI, neither writes this file. | No edits or execution. |
| `scripts/deploy-bundle.sh`, `deploy-push-bundle.sh`, `deploy-offline.sh` | Transport the same deploy/script payload. | No separate env writer. Keep packaging unchanged; source-based fetch-list regression covers the moved fetch. |

Additional implementation claims: `scripts/test-chirpstack-env-file.js` (new), `scripts/test-chirpstack-bootstrap-clover.js`, `scripts/test-deploy-gateway-setup.js`, `.github/workflows/verify-sync-flow.yml`, `.claude/skills/osi-config-and-flags/SKILL.md`, `.claude/skills/osi-live-ops-runbook/SKILL.md`. Issue 470 candidate `4e3ffeb28934be91fafaa35e7327d6b73275bdda` also changes that workflow. Parent must grant the narrow adjacent-step claim, reconcile both steps in isolation, and require inventory/affected checks and review at the resulting final SHA. Do not overwrite its wiring or edit a shared checkout. No migration-number, flow-node, allowance, helper-registry or GUI claims.

## Filesystem design

Implement local functions inside `scripts/chirpstack-bootstrap.js`, not a new helper package. The following is the complete operation contract, including order and failure handling. Use Node built-ins `fs` and existing `path`; retain existing external helper only for actual provisioning/repair.

### Credential-filesystem errors and CLI statuses

Add `CredentialEnvError extends Error`, with fixed message `Credential env-file operation failed`, fixed `exitStatus = 74` and safe fields `operation`, `phase`, `reason`, `published`, `publication` (`null`, `rename`, or `link`), plus a list of safe cleanup failures. `operation` is the enclosing local function's fixed name; `phase` is one of `validate`, `metadata`, `read`, `decode`, `encode`, `stage`, `publish`, `flush`, `verify`, `cleanup`. Guard reasons are `ROOT_REQUIRED`, `PRIMITIVE_UNAVAILABLE`, `UNSAFE_ENTRY`, `REQUIRED_FILE_MISSING`, `SNAPSHOT_CHANGED`, `NON_LOSSLESS_UTF8`, `CONTENT_TYPE_INVALID`, `BYTE_COUNT_MISMATCH`, `BYTE_CONTENT_MISMATCH`, `STAGE_CHANGED`; syscall failures use `OS_ERROR`. `osCode` may copy only `EACCES`, `EPERM`, `ENOENT`, `ELOOP`, `EEXIST`, `ENOTDIR`, `EISDIR`, `EMFILE`, `ENFILE`, `ENOMEM`, `ENOSPC`, `EDQUOT`, `EROFS`, `EIO`, `EBADF`, `EINVAL`, `ENOTEMPTY`, `EXDEV`, `EINTR`, `ENOSYS`, or else `IO_FAILED`. Print only this safe diagnostic and fixed context. Never copy raw message, stack, arbitrary properties, bytes, decoded text, tokens, RPC/CLI output or raw arguments into it. Format/encoding and non-root refusals belong to this class as well as OS errors.

Every path validation, required-file check, metadata correction, snapshot/read/compare, decoding/encoding, staging, publication, fsync, descriptor close and owned-temp cleanup failure in these local functions must become this class. A deliberate optional-file `ENOENT` remains success only where the function contract allows absence. Do not wrap an existing `CredentialEnvError` in an ordinary `Error` while adding context. Append safe context and preserve its type/status. Unsupported primitives, detected replacement, unsafe entry and snapshot mismatch also return 74.

Each top-level credential filesystem operation creates one mutable state `{ published: false, publication: null }` in `withEnvDirectory`; the directory context exposes that SAME state reference to every nested helper and cleanup scope. Never create a new false state for a nested scope. Set `published=true` immediately after a successful rename or create-only link, before any unlink, verification, directory fsync or close. An outer directory-close/cleanup failure after a successful publisher return therefore still sees the shared true state. On error, OR it into the diagnostic's publication state. A later separate metadata-only operation cannot erase the earlier CLI failure or establish its durability.

Do not throw directly out of cleanup in `finally`. Save the primary result/error, then attempt every owned cleanup separately, capturing safe credential-error records. If cleanup succeeds, return the result or rethrow the same primary error with its publication state. If any cleanup fails, throw one `CredentialEnvError` with status 74: retain a credential primary's original safe operation/phase/reason, append cleanup records, and OR all publication states. If the primary was non-credential, record only `NON_CREDENTIAL_FAILURE` as its safe prior category; cleanup failure still makes the result 74. Never overwrite an earlier `published=true` with a cleanup scope's default false. No cleanup error may become exit 1 or a successful return.

Add a distinct usage-error type/status 2 for unknown/mixed flags, with a fixed safe usage diagnostic. At the final `run(...).catch(...)`, branch in this order: `CredentialEnvError` prints only its safe diagnostic and calls `process.exit(74)`; usage error prints fixed usage context and calls `process.exit(2)`; other existing bootstrap/API/profile errors retain the current legacy message and `process.exit(1)`. The latter output has the separate issue 522 limitation. This preserves current process termination behavior while making the new failure category observable to shell callers. Tests must cover nested context and combined primary/cleanup failures, not only a direct throw.

### Descriptor and path operations

Add `withEnvDirectory(callback)`. Reject effective UID other than 0 before changing anything. Resolve the existing `ENV_FILE` override with `path.resolve`; do not add a new override. Do not create missing parent directories (the existing writer also needs its parent). Open `/` and walk each parent component using `fs.openSync('/proc/self/fd/' + parentFd + '/' + component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)`. `fstat` must report a directory. Close each previous fd after the next has opened; always attempt final close under the error-preserving cleanup policy, not a throwing `finally`. The callback receives `{ dirFd, dirPath: '/proc/self/fd/' + dirFd, name: path.basename(resolvedFile), state }`, sharing the operation's state reference with all nested helpers.

Reject missing `O_NOFOLLOW`/`O_DIRECTORY` or unusable `/proc/self/fd` support with status 74; never retry with ordinary pathname opens. This is Linux/OpenWrt-specific by design. Walking descriptors rejects observed intermediate symlinks and pins an opened directory across ancestor renames. Permit the package's existing non-root-owned parent directory without chmod/chown changes to it. A trusted-directory-writer assumption applies before and throughout traversal, staging and publication; it is not limited to the period after return.

Add `secureExistingEnvFile(directory, name)` returning `null` for an allowed missing entry or an open checked snapshot `{ fd, stat, bytes }`, where `bytes` is a raw Buffer. Callers close returned fds through the error-preserving cleanup policy above.

1. `lstat` the final entry through `dirPath`; only `ENOENT` means missing. A dangling symlink is an entry and must fail. Reject anything except a regular file with link count 1.
2. Open `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then `fstat`. Require regular, link count 1, same `dev`/`ino` as the `lstat`. `O_NONBLOCK` prevents a raced FIFO from hanging before the type check.
3. If mode differs from `0600`, call `fchmodSync(fd, 0o600)` before reading any bytes. If UID/GID differ from 0/0, `fchownSync(fd, 0, 0)`, then ensure `fchmodSync(fd, 0o600)` again. A change of ownership must never cause a wider mode. Re-stat and require root:root, `mode & 0o7777 === 0o600`, regular, single link. If metadata changed, fsync this fd. A metadata error is fatal; do not continue to the API.
4. Recheck the directory entry still names the opened inode. Read raw bytes with `fs.readFileSync(fd)` with no encoding argument. Capture post-read `dev`, `ino`, `size`, `mtimeMs`, `ctimeMs` and compare against the pre-read values to reject a concurrent content change; require `bytes.length === stat.size`. Return the post-narrowing snapshot without decoding, normalizing newlines or substituting bytes.
5. On any exception, close the fd under the scope cleanup policy and propagate `CredentialEnvError` status 74 with safe context. No file contents, credential value or raw exception message enters its diagnostic.

Add `assertEnvSnapshot(directory, name, snapshot)` for the publisher's final check: require the same regular single-link root-owned `0600` entry and snapshot identity/timestamps/size, or require absence if snapshot is null. An observed change is an error, never an instruction to overwrite the newcomer. No retries that read a different file implicitly.

### Restrictive staging and publication

Add `decodeEnvUtf8(bytes)`: require a Buffer, decode with `bytes.toString('utf8')`, and require `Buffer.from(text, 'utf8').equals(bytes)`. A mismatch throws `CredentialEnvError` with reason `NON_LOSSLESS_UTF8`, status 74, before any key creation, API call or UCI/config mutation. Do not include offending bytes in the error. Mode-only checks and backups do not call this function and therefore still accept malformed UTF-8 in an otherwise safe regular file.

Add `publishEnvContent(directory, name, content, snapshot, publication)` where `publication` is local-only `replace` or `create-only`. Its input contract is Buffer or string only: a Buffer is copied with `Buffer.from(content)` without decoding; a string is encoded once with `Buffer.from(content, 'utf8')` and must decode back to the identical string, rejecting lone surrogate/replacement loss with status 74. Other types fail with status 74. The owned result is `candidateBytes`; all size checks use `candidateBytes.length`, never string code-unit length. Backup callers always pass a Buffer, while full/soil callers pass validated text.

1. Create a unique same-filesystem staging directory with `mkdtempSync(dirPath + '/.' + name + '.tmp-')`. If creation collides/fails, throw status 74. Never fall back to `.soil-repair.tmp`, PID-only names, `/tmp`, or a shared deterministic file. Open the new directory with `O_DIRECTORY | O_NOFOLLOW`, compare its fd identity with the observed directory entry, record its inode, enforce root:root `0700` by fd, and use its own `/proc/self/fd/<fd>` path thereafter. Reject a detected substituted entry. `mkdtemp` returns a pathname, not an inode capability: the gap between creation and opening still relies on trusted directory writers, even if later checks agree.
2. Open `env` inside that private directory using `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, initial mode `0600`. Require a regular single-link file. Set root:root and exact `0600` by fd before the first byte, so even umask `0777` produces a usable final file without an exposure interval. A pre-existing `env` entry or symlink is an error; do not truncate it.
3. `fs.writeFileSync(fd, candidateBytes)` writes the complete Buffer through the fd; use no single unchecked `writeSync` that could short-write. Require staged size equal to `candidateBytes.length`, then `fsyncSync(fd)` and verify metadata. Close the staging file before publishing. Every failure returns 74; bytes never enter diagnostics.
4. Call `assertEnvSnapshot` immediately before publication. For an existing live file use `renameSync(stagingFdPath + '/env', dirPath + '/' + name)`; source/destination remain on the same filesystem. Mark scope state `{ published: true, publication: 'rename' }` immediately after it succeeds. For a missing live file or new backup, use `linkSync(stagingFdPath + '/env', dirPath + '/' + name)` as exclusive publication, immediately mark `{ published: true, publication: 'link' }`, then unlink the private staging link. `EEXIST` fails closed with 74; it never overwrites a new entry or follows a symlink. This avoids the absent-file check/rename clobber race without a native renameat2 dependency.
5. Verify the published entry by no-follow descriptor: expected candidate inode, root:root, regular, `0600`, single link after removing the staging link, `stat.size === candidateBytes.length`, and `fs.readFileSync(publishedFd).equals(candidateBytes)`. Fsync the parent directory before reporting success. A verification/fsync error is status 74 with `published=true`. Do not open it for rewriting or chmod the pathname after publication.
6. Close all fds and unlink only the staging entry owned by this invocation through its pinned directory fd, using the error-preserving cleanup policy. Remove the staging directory by its saved parent/name only when its current inode still matches. Use no recursive deletion and never touch old `.soil-repair.tmp` or another invocation's files. A cleanup failure returns 74, preserving primary context and `published=true` once set. Do not roll back automatically after publication.

A power interruption can leave a private `0700` stage containing `0600` data. In the create-only hard-link publication interval it can leave a second link; the next run intentionally rejects link count >1. Recovery requires inspection of synthetic rehearsal evidence and a separately authorized operator action, not an automatic wildcard cleanup. The retained `.pre-gen2` is never part of temp cleanup.

There is no atomic compare-and-rename in Node's standard API. A final recheck detects observed entry changes; rename itself cannot follow a final symlink. The design does not promise to defeat a hostile directory owner during the creation/opening gap, traversal or final check/rename interval, or after return. All supported root provisioning/deploy invocations must be serialized administratively, with other writers of the enclosing directories trusted for the entire operation. Existing owners may also retain old descriptors. Independent approval must assess this boundary explicitly; if stronger hostile-owner protection is required, stop and amend this plan rather than adding a lock, native helper or ownership migration during execution.

### Shared writer integration

Add `secureEnvFiles()` using one directory session: secure/check `name` and `name + '.pre-gen2'` if present, close every fd, return presence metadata only. It must not create a live file when absent or read/log a secret for output. It may read through the checked function internally, but output contains only safe status/path metadata. A bad backup blocks the operation even if the live file was successfully narrowed first. Narrowing is deliberately not undone on a later failure.

Replace `readEnvFileText()` with `readEnvFileForMutation()`: use a descriptor session to obtain the raw checked snapshot, close its fd under the scope policy, then return `{ bytes, text: decodeEnvUtf8(bytes) }`, or null for allowed absence. Normal full/soil dispatch calls this before helper loading/key creation/API/config mutations. This is an internal return-type change; product consumers still read the same file/format.

Replace `writeEnvFile(vars)` with a session that opens/narrows the current live file, decodes its raw snapshot with `decodeEnvUtf8`, builds final text, and calls `publishEnvContent` before closing the snapshot fd. Input present at normal dispatch has already passed lossless decoding before API effects; revalidate the current snapshot here too. For null/empty prior content, use the existing serialization `Object.entries(vars).map(([key,value]) => key + '=' + value).join('\n') + '\n'`. For nonempty valid content, apply existing `setEnvLine(text, key, value)` in `Object.entries(vars)` order. This updates all duplicate assignments of each managed key, retains every other line (comments, blank lines, CRLF on untouched lines, valid non-ASCII UTF-8, unknown assignments, duplicate unrelated keys, and a final unterminated unrelated line), and appends missing managed keys without concatenating assignments. Do not strip all `CHIRPSTACK_*`: only keys actually in `vars` are managed. Preserve stale identity lines as bytes; existing consumer protections, not this task, decide their runtime effect. Malformed original input is refused before provisioning; do not transcode it. The trusted-writer assumption does not authorize ignoring a later detected change.

Replace `writeEnvFileAtomic(text)` with `writeEnvFileAtomic(text, expectedBytes)`. Require a Buffer for `expectedBytes` and a live raw snapshot; losslessly decode the current bytes and require `snapshot.bytes.equals(expectedBytes)` before publication. A mismatch returns 74 without discarding operator edits. Pass validated text to `publishEnvContent`. Change `repairSoilProfiles(options)` to accept the vetted `envInput` from normal dispatch; parse `envInput.text` and pass its raw `envInput.bytes` as a final argument to `repairCloverProfile`. That function still uses the one-Clover-key `setEnvLine`, now calling the adapter with expected raw bytes. Keep profile/UCI decisions unchanged; input decoding happens before any of them. Later filesystem failure may follow earlier API/UCI writes and must remain fatal to deploy.

Add `backupEnvFile()` using the same directory functions. Require live source; narrow/check both source and existing `.pre-gen2` before doing anything else. If backup exists, retain its raw bytes and inode and report retention (it may represent an older interrupted operation; do not claim it is a new snapshot). If missing, pass the source Buffer directly to `publishEnvContent` with create-only semantics. No decode/encode step is allowed, including for malformed UTF-8. Success requires Buffer equality, byte length, fsync and final mode/ownership verification. Any failure returns 74, leaves live bytes untouched and prevents full provisioning. Never replace a previous recovery copy or delete it after success.

### CLI and caller ordering

Keep existing `parseRepairArgs` behavior for no arguments, repair, and repoint options, using the new usage-error type for argument rejection. At the start of `run(argv)` recognize exactly one argument `--secure-env-file` or `--backup-env-file`. Call the respective raw-byte local operation and return. If either token occurs in any other argument list, including repetition, values or mixing with repair/repoint/unknown flags, reject with status 2 before any filesystem or API mutation. These operations perform no text decode, key CLI, gRPC, UCI, settings or flow work. Direct CLI calls continue to honor their deliberate `ENV_FILE` override.

Replace eager `const chirpstack = loadChirpStackHelper()` with `let chirpstack;`. For normal full/soil modes: parse options first, call `secureEnvFiles()`, then `const envInput = readEnvFileForMutation()`. A missing file is allowed for full bootstrap; soil requires it and otherwise throws credential status 74. Only after this input check assign `chirpstack = loadChirpStackHelper()` and dispatch to `repairSoilProfiles(options, envInput)` or `main()`. This secures no-op/error soil paths and rejects malformed input before minting a key or mutating API/config state. Use the final 74/2/1 handler above. Do not claim key-mint cleanup on a later non-filesystem failure.

## Deploy edits, in order

Every deploy invocation of this script, including early/final secure, backup, full and soil, MUST set `ENV_FILE="$CHIRPSTACK_ENV_FILE"`. Deploy's existing `CHIRPSTACK_ENV_FILE` assignment remains the canonical `/srv/node-red/.chirpstack.env`; it is not a new override. All predicates, backup derivation and key extraction below use that same variable. An inherited `ENV_FILE` is deliberately ignored by deploy, while direct CLI use retains its override. Capture the original status in each `else` immediately; do not use `if !` and then read its negated status.

1. Move the existing `fetch_required "chirpstack-bootstrap.js" "scripts/chirpstack-bootstrap.js" "/srv/node-red/chirpstack-bootstrap.js"` to immediately before the ChirpStack bootstrap service fetch and `enable_osi_bootstrap` near base line 1874. Follow the fetch immediately with this exact marked fragment. It runs before the first env-based provisioning/stamp check, API provisioning and this deploy's schema/restart paths. Keep the required-fetch error policy; add no transport or payload file.

   ```sh
   # issue-183 early secure begin
   if ENV_FILE="$CHIRPSTACK_ENV_FILE" node /srv/node-red/chirpstack-bootstrap.js --secure-env-file; then
       :
   else
       cs_env_rc=$?
       echo "ERROR: ChirpStack credential env-file safety check failed; refusing deploy" >&2
       exit "$cs_env_rc"
   fi
   # issue-183 early secure end
   ```

2. Replace the complete Gen2 conditional with this exact marked fragment. The same missing-profile predicate and explicit existing-key input remain; key extraction follows safe backup validation. Filesystem status 74 is fatal immediately. Status 1 retains the intended API/profile warning policy, conditional on the subsequent secure check succeeding. Other statuses, including usage 2, executable failure and signals, are fatal unexpected failures; do not label them API warnings.

   ```sh
   # issue-183 Gen2 begin
   if [ -f "$CHIRPSTACK_ENV_FILE" ] && \
      ! grep -q 'CHIRPSTACK_PROFILE_STREGA_GEN2=' "$CHIRPSTACK_ENV_FILE" 2>/dev/null; then
       echo "--- Provisioning STREGA Gen2 device profile (one-time) ---"
       cs_env_backup="${CHIRPSTACK_ENV_FILE}.pre-gen2"
       if ENV_FILE="$CHIRPSTACK_ENV_FILE" node /srv/node-red/chirpstack-bootstrap.js --backup-env-file; then
           :
       else
           cs_env_rc=$?
           echo "ERROR: secure ChirpStack recovery backup unavailable; refusing Gen2 provisioning" >&2
           exit "$cs_env_rc"
       fi
       cs_api_key="$(sed -n 's/^CHIRPSTACK_API_KEY=//p' "$CHIRPSTACK_ENV_FILE" | head -1 | tr -d '\r')"
       if ENV_FILE="$CHIRPSTACK_ENV_FILE" CHIRPSTACK_API_KEY="$cs_api_key" node /srv/node-red/chirpstack-bootstrap.js; then
           echo "OK: Gen2 profile provisioned"
       else
           cs_bootstrap_rc=$?
           case "$cs_bootstrap_rc" in
               1)
                   echo "WARN: Gen2 profile provisioning failed; valves will register on the Gen1 profile"
                   echo "NOTE: pre-provisioning env backup kept at $cs_env_backup"
                   ;;
               74)
                   echo "ERROR: Gen2 credential env-file operation failed; refusing deploy; recovery backup retained" >&2
                   exit 74
                   ;;
               *)
                   echo "ERROR: Gen2 bootstrap exited unexpectedly ($cs_bootstrap_rc); refusing deploy" >&2
                   exit "$cs_bootstrap_rc"
                   ;;
           esac
       fi
       if ENV_FILE="$CHIRPSTACK_ENV_FILE" node /srv/node-red/chirpstack-bootstrap.js --secure-env-file; then
           :
       else
           cs_env_rc=$?
           echo "ERROR: ChirpStack credential env-file unsafe after provisioning; refusing deploy" >&2
           exit "$cs_env_rc"
       fi
   fi
   # issue-183 Gen2 end
   ```

   Remove the old `cp`, missing-key append loop and backup `chmod ... || true`. The full writer preserves valid unrelated text within its atomic publication, including after late UCI/flow-validation failure; malformed input is refused before API work. A failed publisher returns 74 and exits before the following secure check, even if that check would succeed. Backup failure is always fatal.

3. Replace the soil conditional with this exact marked block, retaining the existing deadline and closing-banner flag. The final check runs even when soil/Gen2 predicates are false. Status 74 from the real soil publisher is fatal before that final check; a successful later metadata check cannot clear it.

   ```sh
   # issue-183 soil begin
   soil_profile_repair_failed=0
   if grep -q 'CHIRPSTACK_APP_SENSORS=[0-9a-f]\{8\}-' "$CHIRPSTACK_ENV_FILE" 2>/dev/null; then
       echo "--- Kiwi and Clover device profiles (codec and Clover profile id) ---"
       if ENV_FILE="$CHIRPSTACK_ENV_FILE" OSI_CHIRPSTACK_GRPC_DEADLINE_MS=20000 node /srv/node-red/chirpstack-bootstrap.js --repair-soil-profiles; then
           echo "OK: Kiwi and Clover device profiles checked"
       else
           cs_soil_rc=$?
           case "$cs_soil_rc" in
               1)
                   soil_profile_repair_failed=1
                   echo "WARN: Kiwi/Clover profile repair failed; their uplinks may stay undecoded until it succeeds"
                   echo "NOTE: rerun exactly: node /srv/node-red/chirpstack-bootstrap.js --repair-soil-profiles"
                   echo "NOTE: never the /usr/share/node-red copy: an older image ignores the flag and re-provisions ChirpStack fully"
                   ;;
               74)
                   echo "ERROR: soil-profile credential env-file operation failed; refusing deploy; recovery backup retained" >&2
                   exit 74
                   ;;
               *)
                   echo "ERROR: soil-profile repair exited unexpectedly ($cs_soil_rc); refusing deploy" >&2
                   exit "$cs_soil_rc"
                   ;;
           esac
       fi
   fi
   # issue-183 soil end
   # issue-183 final secure begin
   if ENV_FILE="$CHIRPSTACK_ENV_FILE" node /srv/node-red/chirpstack-bootstrap.js --secure-env-file; then
       :
   else
       cs_env_rc=$?
       echo "ERROR: ChirpStack credential env-file final safety check failed; refusing deploy" >&2
       exit "$cs_env_rc"
   fi
   # issue-183 final secure end
   ```

4. Remove the old late bootstrap fetch. In `print_bootstrap_note`, replace the two echo lines that currently say `the existing API key ($pbn_script; it rewrites` and `$CHIRPSTACK_ENV_FILE with the CHIRPSTACK_* keys only):` with one exact shell line: `echo "        the existing API key (service-selected script: $pbn_script):"`. Keep the surrounding service advice, explicit-key `printf` command and ROM/fallback preference. Before the provisioned/unprovisioned condition, add these three literal banner lines with `echo`: `NOTE: this deploy secures the canonical env file using the /srv/node-red bootstrap copy.`, `NOTE: the updated /srv/node-red script updates managed CHIRPSTACK_* keys and preserves other valid UTF-8 env lines.`, and `NOTE: osi-bootstrap may still prefer an older ROM script; this deploy does not replace it.` Do not infer the selected ROM's writer policy or add a version detector. Documentation/T10 must say an old-ROM re-provision can still use its old writer; repair is delivered by new deploy gates or a new image.
5. Do not alter `run_schema_migration`, exit traps, payload flips, firmware stamping, identityd restart coordination, or rollback services. All new security failures occur before this deploy has stopped/restarted Node-RED or flipped its payload. The old running process may keep its existing credential in memory. No manual service restart is part of this patch.

## Test implementation specification

Add `scripts/test-chirpstack-env-file.js`, run under Node's built-in test runner. Use only synthetic strings and fresh temporary directories. Execute the real source with a fake ChirpStack helper and child-process module for full/soil paths; use the real filesystem for metadata, links and publication. Normal file-only CLI cases must not load any external helper. No network, real UCI, `chirpstack` CLI, service, `/srv`, `/data`, credential directory or live file may be touched. The harness must reject a side-effect path outside its temporary fixture before executing it.

Give this suite the existing test-only `OSI_BOOTSTRAP_UNDER_TEST` source override and a test-only `OSI_DEPLOY_UNDER_TEST` source override. Those are harness inputs, never product knobs. Shell fixtures extract the actual marked credential fragments from candidate `deploy.sh`, set `CHIRPSTACK_ENV_FILE` to their canonical fixture and substitute only the bootstrap executable path. Extract all four blocks above in their real order; never execute deploy.sh whole. Stub unrelated service/API/key effects. Include both status-only stubs for exhaustive shell branches and the real candidate publisher with narrow injected fs faults, so a stub cannot masquerade as publisher/error-class proof. Run env/umask cases in isolated children. Use narrow fs event traces at the first write and immediately before publication, so write-then-chmod fails even if final stat passes.

| Test | Exact cases and assertions |
|---|---|
| T1 creation | Real full writer with absent file under umasks `022`, `077`, `000`, `0777`. At first secret write staging mode is `0600`, owner 0/0; at publication content is complete. Final live file regular, link count 1, root:root `0600`. Success output and NEW filesystem diagnostics contain no synthetic secret. The unchanged CLI error-output gap is issue 522; do not claim its failure paths pass this assertion. |
| T2 existing-file narrowing | Start `0644`, `0666`, `0600`, `0400`, special mode bits; also non-root-owned regular fixture when root test support is available. Before read/key/API/copy, descriptor is root:root exact `0600`. Bytes survive pure secure mode. Second secure call leaves inode/content and metadata unchanged when already correct. Missing live file is not created; existing backup is still narrowed. Non-root invocation fails without changes. |
| T3 full content compatibility | Synthetic API key, managed assignments, unknown `CHIRPSTACK_EXTRA`, `AGROSCOPE_*`, `LOG_*`, `DEVICE_EUI*`, comments/blanks, quoted values, spaces, equals in values, unrelated duplicates and unterminated final line. Cover valid non-ASCII UTF-8 (including multibyte/astral text), CRLF and mixed newlines: compare untouched line Buffers, and require published size equal to UTF-8 byte count rather than string length. Malformed UTF-8 such as a lone `0xE9` in an unrelated assignment returns 74 before helper/key/API/UCI/config effects, retaining original Buffer and narrowed mode. Test invalid surrogate string publication refusal separately. Parse valid results with actual consumer functions, retaining protected identity precedence. |
| T4 soil paths | Actual repair changes Clover from alias: only Clover assignment bytes change, `0644` becomes `0600`. Valid non-ASCII/CRLF untouched lines compare as Buffers. Already-correct Clover performs no content or RPC/UCI writes but narrows mode. Malformed UTF-8 returns 74 before profile reads/writes, key creation or UCI; pure secure still succeeds on those bytes. Missing token/codec and failed RPC keep no-full-fallback behavior. Expected raw Buffer mismatch returns 74 instead of losing an operator edit. Real soil publisher fsync/cleanup faults return 74 even after an earlier API/UCI write. |
| T5 backup | Absent `.pre-gen2`: raw source Buffer appears only after complete `0600` staging; assert `backupBytes.equals(sourceBytes)` and equal byte lengths for malformed UTF-8, valid non-ASCII UTF-8 and CRLF fixtures. Existing backup `0644`: narrow but preserve Buffer/inode even if live differs. Second invocation retains it. Never unlink after success. Missing live source returns 74 and blocks bootstrap. Backup never uses the text decoder. |
| T6 hostile entries and CLI | Live/backup symlink, dangling link, directory, FIFO, supported socket, sentinel hard link, parent symlink, unsupported constants/descriptor path: status 74, no sentinel read, unchanged bytes/mode and no API/key/UCI/service effects. Preserve old `.soil-repair.tmp` sentinel/link. Force stage creation/open collisions: 74 without truncation or deleting the collided entry. Run the ACTUAL CLI process in file-only modes with external helper resolution unavailable and assert zero helper-load attempts; invalid mixed/repeated/valued/unknown flags return 2 before any fs mutation or helper load. Direct file-only `ENV_FILE` override still selects its deliberate fixture. These checks do not promise hostile-directory-writer race resistance. |
| T7 actual deploy fragments | Extract real marked early/Gen2/soil/final blocks, run under `set -eu` with fixture-only paths and append migration/payload/restart markers. Inherit `ENV_FILE` pointing to (a) regular decoy `0644`, (b) absent file; cross both with Gen2 present/no-op soil and Gen2 absent/provisioning. Every secure/backup/full/soil child must log canonical `ENV_FILE`; canonical becomes `0600`, decoy bytes/mode/inode stay unchanged, absent override stays absent. Cover no-sensors skip and absent canonical too. Status stubs 0/1/74/2 prove branches: only 1 can warn and continue after safe checks; 74/2 and any early/backup/final failure prevent all subsequent markers. Then inject REAL full/soil publisher failures before rename/link and after successful rename/link (parent fsync, private unlink, published-fd close and cleanup). Require CLI 74 and no next marker, even though a separately run metadata-only secure call succeeds on the retained safe file. Retain safe backup and existing key-input behavior. |
| T8 faults and cleanup | Real candidate publisher: open/chmod/chown, read/snapshot/encoding, partial-write/write, staged fsync/close, pre-rename/pre-link failure, successful rename/link followed by verification/parent-fsync/unlink/close/rmdir fault. Every case returns credential CLI status 74 with safe phase/context, no raw exception text or synthetic secret. Before publication `published=false` and old raw bytes/narrowed mode remain. After successful rename/link `published=true` survives every enclosing context and cleanup error; complete restrictive bytes remain, backup retained. Combine primary credential error with cleanup failure, and synthetic non-credential primary with cleanup failure: both are 74, original safe credential context retained when present, no success/exit-1 downgrade. Feed these real failures through T7, not just an exit-74 stub. Detected entry changes fail; collided entries are not removed. |
| T9 interruption | In a bounded synthetic child, pause before publish and after publish, terminate it and inspect fixture. Before: old full file; after: new full `0600` file; no partial live file. Backup preserved. Kill between create-only link and private unlink: next invocation refuses nlink >1; no automatic deletion. Do not describe SIGKILL as a physical power-loss/fsync proof. |
| T10 mirrors/callers | All three script bytes identical. Both init scripts retain stamp/ROM/fallback and coordinated restart. Failure from an UPDATED selected writer produces no stamp/restart in the fake service fixture. A distinct old-ROM fixture is still preferred over the updated fallback: assert the selection and banner limit, never infer it gained the new writer. Stamped boots skip invocation. No service-user, schema, API lifecycle or profile-customization change in diff. |

For T7's independent metadata-only success assertion, use retained single-link cases: a pre-publication rename/link failure or a post-publication parent-fsync/close/directory-cleanup failure after the private link was removed. A failure removing the private link after create-only publication can leave link count 2; that separate case must make the next secure check fail 74 too. Do not demand metadata-only success for a deliberately unsafe two-link state.

T8 must also inject failure closing the outer directory fd AFTER the publisher returned successfully. The CLI must still report 74 with `published=true` and the correct publication method from the shared state, preventing a false pre-publication diagnostic at a later scope. Preserve the fixed primary reason when a second cleanup error is appended.

Update `scripts/test-chirpstack-bootstrap-clover.js` fakes so they model the new real fs contracts: constants, directory descriptors/path aliases, lstat/fstat identity and type, UID/GID/link count, fchmod/fchown, mkdtemp, exclusive opens, descriptor reads/writes, directory/file fsync, link/rename/unlink/rmdir, and close behavior. Add fake effective UID 0 and a real `getuid`/`geteuid` contract. Unsupported methods must fail loudly. Preserve existing API/UCI write-count assertions. Update the final mode assertion from “keeps its mode” to “enforces 0600”; replace the exact-one-fsync assertion with ordering checks for staged-file flush before publish and parent-directory flush after. Retain no-content-write idempotence; security metadata correction is now explicitly allowed on unsafe fixtures.

Update `scripts/test-deploy-gateway-setup.js` expectations for the corrected banner and early file-only invocation using a stub. Add the new init-failure case without editing the init scripts. Existing tests for stamp/restart behavior must keep their meaning. Add this explicit named CI step adjacent to the existing bootstrap step, which remains unchanged:

```yaml
- name: ChirpStack credential env-file safety
  run: node --test --test-concurrency=1 scripts/test-chirpstack-env-file.js
```

The inventory verifier recognizes a leading `node` command, not a `sudo` prefix. Keep the workflow command above and implement privilege handling inside the new test file: when effective UID is not 0, register one enclosing test that synchronously runs `sudo -n env -i PATH=/usr/bin:/bin`, the explicit test-only source overrides if set, `process.execPath`, `--test`, `--test-concurrency=1`, and this test file's absolute path. Set a 45-second timeout and a 2 MiB output bound. Print the child TAP through test diagnostics and assert child exit 0, no timeout/signal, all required inner test names present, and no skipped/cancelled cases. The root branch registers T1–T10 directly and makes no sudo call. Do not inherit arbitrary environment variables or secrets. Never run the whole deploy with sudo. This needs no inventory-parser change, exclusion or new runner file.

For actual no-helper CLI tests, copy the real candidate script into a fresh fixture and spawn it as an executable Node CLI, not through the permissive fake-helper harness. A test-only preload may reject and trace non-built-in module loads (allow only the exact main script and built-ins); it must not provide a fake helper. Run a separate positive control showing that the guard detects an attempted external load. Correct file-only dispatch makes zero such attempts. At non-root UID a real file-only invocation must reach the safe status-74 root refusal rather than helper resolution; successful metadata/backup CLI paths require the pending root facility. Invalid flag combinations must exit 2 before that root check and before any side effect.

The new real-filesystem suite requires Linux root privileges to prove root:root ownership. Review R1 already tried local `sudo -n /usr/bin/id -u` after authorized wrapper recovery: exit 1, `sudo: a password is required`. That facility is unavailable locally. Do not retry credentials, install a runtime, grant privileges or skip ownership assertions into green. Root-kernel G1 and corresponding B3 red evidence are explicitly infrastructure-pending.

The existing future remote facility is `.github/workflows/verify-sync-flow.yml`, job `verify-sync-flow`, `runs-on: ubuntu-latest`, Node 22. Its current sqlite3 step already specifies noninteractive sudo. This source configuration identifies an intended facility, not evidence that the new security suite ran or that a future runner grants root. After fresh plan approval, implementation and parent-authorized draft-PR preparation, the added explicit Node step above can attempt the exact synthetic suite there using its bounded test-only sudo re-entry. Parent must preserve runner/job/run URL, final candidate SHA, complete inner test names/TAP and real status before crediting root evidence. A refusal remains pending/failing; do not seek a paid runner or broaden permissions. This assignment triggers no workflow or PR. Shell syntax checks do not prove BusyBox ash behavior; Node 22 Linux evidence does not prove OpenWrt or physical power-loss behavior.

## Commit and execution order after approval

This assignment commits this plan only. The implementation author later starts from the recorded base (or records a reviewed rebase), never from the user's root checkout. Stop on a mismatch with the planned functions/call sites; report it instead of forcing a replacement design.

1. Independent reviewer inspects this plan, current issue discussions and source. Required objections must be resolved in a new plan commit before code. Parent records narrow shared-file claims. The parent has explicitly released the heavy hold; any subsequent hold must stop executable validation again. Resource availability or wrapper admission alone cannot release a hold.
2. Prepare the new synthetic suite, expanded existing fakes and CI wiring in the isolated implementation worktree. Save a base source snapshot and run the new suite against it through the campaign wrapper. Expected red: A1 `0644` creation and A2 permissive existing mode; file-only options do not exist on base. A missing fixture/dependency, no tests collected or harness crash is not defect reproduction. Keep exact failure names/output.
3. Implement local filesystem functions, CLI dispatch, full merge and soil adapter; mirror the script into both profiles. Commit with tests as `fix: secure ChirpStack credential env-file writes`. This commit owns no deploy caller changes. Run focused bootstrap cases and parity before committing if the hold has been released.
4. Implement canonical `ENV_FILE` bindings on EVERY deploy invocation, exact 74/1/other status branches, safe retained backup, removal of append/copy/chmod paths, final gate and banner; update real extracted-fragment cases. Commit `fix: repair credential env-file modes before deploy provisioning`. Real publisher faults must carry 74 through both full and soil callers; a final secure success must not clear them.
5. Update only the relevant paragraphs in `.claude/skills/osi-config-and-flags/SKILL.md` §3 and `.claude/skills/osi-live-ops-runbook/SKILL.md` provisioning/deploy descriptions: root:root `0600`, canonical deploy binding/direct override distinction, raw backups, lossless UTF-8 mutation, no-op repair, status 74 versus API warning, retained backup and old-ROM limit. Reference separate issue 522 when constraining new diagnostics claims. Commit `docs: record ChirpStack env-file safety and recovery`. No new live steps or permission grants.
6. Independent non-author verifier checks the explicit base-to-final diff and reruns applicable local gates at the final candidate SHA. Record unavailable local G1/B3 as pending. Parent alone may prepare the scoped draft PR to obtain required remote root evidence through the existing CI facility, then commission exact-head independent verification of that evidence before acceptance. Campaign `COORDINATION.md` requires fresh Opus review after independent Sol verification. Opus is currently rate-limited: queue its stage, use subscription only and no fallback. Any repair invalidates affected evidence/approval; parent owns GitHub actions. This amended plan first needs a NEW independent review; the author cannot approve it.

## Exact pending validation commands and evidence

Candidate commands in this section remain proposed and unexecuted. The separate design probe above is complete; plan-only prose/whitespace results belong in the handoff. If another heavy hold starts, stop syntax, prose and extraction checks as well. Use `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py` for each executable verification, with stdout, stderr and real status saved. No unwrapped fallback and no indefinite polling after admission refusal.

Use the implementation worktree as cwd; base is `63c7a70f8f3b373f162b33b0669b0df89b3763fa`. Save logs under campaign `artifacts/issue-183/`. Author/verifier use separate prefixes and record candidate SHA, cwd, source overrides and command. Wrapper admission exit 75 means refused/pending, not a test result; product credential status is separately 74. Permitted amendment probes extract plan shell blocks/real source CFG and use unprivileged synthetic fixtures/status stubs; their limits are recorded in the handoff. They do not execute an unimplemented publisher.

After hold release, create the evidence directory. Run these invocations separately, recording `$?` immediately to the matching `.status` file; redirect both stdout and stderr to the matching `.log`. Do not pipe through `tail`, `tee` or `grep` to decide pass. The red run intentionally has nonzero status; the evidence runner must preserve it without stopping before saving the status.

| Gate | Command passed to `python3 CAMPAIGN/run-heavy.py` | Expected result |
|---|---|---|
| B1 baseline snapshot | `git show 63c7a70f8f3b373f162b33b0669b0df89b3763fa:scripts/chirpstack-bootstrap.js` (stdout to `base-chirpstack-bootstrap.js`) | Exit 0, saved exact base source; extraction is pending. |
| B2 deploy snapshot | `git show 63c7a70f8f3b373f162b33b0669b0df89b3763fa:deploy.sh` (stdout to `base-deploy.sh`) | Exit 0, saved exact base source. |
| B3 red security suite | `env OSI_BOOTSTRAP_UNDER_TEST=/home/phil/projects/osi-release-campaign-2026-10-25/artifacts/issue-183/base-chirpstack-bootstrap.js OSI_DEPLOY_UNDER_TEST=/home/phil/projects/osi-release-campaign-2026-10-25/artifacts/issue-183/base-deploy.sh node --test --test-concurrency=1 scripts/test-chirpstack-env-file.js` | Locally pending: known sudo refusal is infrastructure, not expected red. On a future authorized root-capable CI runner, require named defect failures with the new harness against saved base sources and no real services. |
| G1 candidate security | `node --test --test-concurrency=1 scripts/test-chirpstack-env-file.js` | Locally pending; future authorized CI must show complete inner root suite, exit 0, no ownership skips. An unprivileged stub/primitive pass cannot satisfy G1. |
| G2 bootstrap/deploy regressions | `node --test scripts/test-chirpstack-bootstrap-clover.js scripts/test-deploy-gateway-setup.js scripts/deploy-fetch-list.test.js scripts/deploy-payload-lifecycle.test.js scripts/test-deploy-atomic-payload-wiring.js` | Exit 0 with each suite collected. Tests run fake fragments, never deploy.sh whole. |
| G3 profile parity | `node scripts/verify-profile-parity.js` | `All parity checks passed.`, exit 0. Also assert scripts source equals both shipped copies in T10. |
| G4 communication compatibility | `node scripts/verify-communication-contract.js` | Exit 0; consumer path/precedence contract preserved. |
| G5 shell syntax | `sh -n deploy.sh` | Exit 0. No deployment occurs. |
| G6 JS syntax | `node --check scripts/chirpstack-bootstrap.js` | Exit 0. Mirrored bytes covered by T10/G3. |
| G7 CI test coverage | `node scripts/verify-test-inventory.js` | Exit 0; new tracked suite explicitly wired, no new exclusion. Run after staging/commit so inventory can see new tracked files. |
| G8 DDL boundary | `env OSI_DDL_BASE_REF=63c7a70f8f3b373f162b33b0669b0df89b3763fa node scripts/verify-no-stray-ddl.js` | Exit 0; deploy change introduces no schema behavior. |
| G9 prose | `node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-25-issue-183-credential-env-mode-safety.md .claude/skills/osi-config-and-flags/SKILL.md .claude/skills/osi-live-ops-runbook/SKILL.md` | `slop-check: PASS (no tier-1 findings)`, exit 0; review tier-2 warnings individually. |
| G10 whitespace | `git diff --check 63c7a70f8f3b373f162b33b0669b0df89b3763fa..HEAD` | No output, exit 0; explicit committed range. |
| G11 public documentation hygiene | `node scripts/verify-doc-hygiene.js` | Exit 0 and `verify-doc-hygiene: OK (...)`. If private name terms are not configured, record built-in-pattern coverage only; do not read credentials or private operational files to obtain them. |

Concrete invocation shape, to be used only after the hold is released:

```sh
python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py \
  sh -n deploy.sh \
  > /home/phil/projects/osi-release-campaign-2026-10-25/artifacts/issue-183/author-G5.log 2>&1
issue183_status=$?
printf '%s\n' "$issue183_status" > /home/phil/projects/osi-release-campaign-2026-10-25/artifacts/issue-183/author-G5.status
```

For the plan-only commit, G9 is limited to the plan file and the campaign handoff report; G10 uses the plan commit range. These checks can run now that the parent has released the hold. Their exact results are recorded in the campaign handoff; they do not validate an unimplemented candidate.

Run existing G2/G3/G4/G7/G8/G11 on the base as well using the immutable base as read-only cwd, output outside it. A red base gate stops the affected surface and returns `red-on-base` to parent; do not repair unrelated baseline code. B3 instead uses the new candidate harness against saved old source. No npm install is needed for the new filesystem suite; if existing regression dependencies are unavailable, record pending and ask parent to admit dependency work separately.

Schema replay, seed regeneration, database rehearsals, whole GUI tests/build, codec verification, full sync behavioral suite, live mode inspection and cloud canary are outside the touched behavior. Do not launch them as extra proof. Existing CI may run its normal scoped-PR workflow later, under parent control; this design assignment creates no PR and triggers no CI.

## Failure and rollback rules

An unsafe path, failed narrowing, unsupported primitive or malformed text at INITIAL preflight returns credential status 74 before key/API/config effects. A later staging/publication/fsync/cleanup failure also returns 74, although previous API/UCI writes may already have occurred. Both deploy callers abort immediately on 74 before any subsequent credential step, migration, payload flip or restart; only status 1 can follow the stated warning path. Do not unlink a symlink to “repair” it, chmod through it, follow it to a different file, or hide this category in an API warning. No fallback to the old writer is permitted.

Before publication, retain prior bytes; permissions already narrowed remain narrowed. After publication, retain the complete restrictive candidate and `.pre-gen2`, report the failed durability/cleanup/post-step, and stop where specified. A late API/UCI failure may already have changed remote or canonical profile state; this file-mode task neither reverses those changes nor mints/revokes credentials to recover them. Retrying must not replace the retained backup.

Reverting code is not permission to restore `0644` or an old permissive backup. Payload rollback must keep safe env ownership/modes. Recovery from `.pre-gen2` is a separate explicitly authorized operator action: use the same checked restrictive publisher, preserve the backup, validate needed managed configuration against the intended environment, and never copy the database. No such recovery is authorized or performed by this plan.

Delivery remains `planning / pending independent approval and validation`. Parent must record each lifecycle disposition and the lack of deployed-mode evidence; a passing synthetic gate proves the local mode/write contract, not fleet rollout or full issue closure.
