# Issue 183: credential env-file mode safety

This plan repairs credential-file creation, replacement and already-provisioned deploys. It requires independent design approval before implementation. The parent lifted the heavy hold after `APPROVE resource-review-r3` and verified wrapper/sampler state. Subsequent bounded design checks use the campaign wrapper with saved outputs. No product implementation, install, live operation or GitHub write is authorized by this plan.

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

The mode defect can be delivered independently, but issue 183 must not be marked fully closed while its lifecycle comments have no accepted disposition. Parent owns GitHub and the ledger. Propose these separately tracked/deduplicated follow-ups before any closure wording:

1. Key lifecycle: reuse a still-authenticating existing env key in full bootstrap; define proof of bootstrap ownership and safe replacement/revocation; handle interruption after minting but before persistence. A shared `osi-nodered` name is not ownership proof. Do not list, revoke, rotate or delete any real key in this work.
2. Profile lifecycle: establish tenant ownership and all configured/device references, then design a dry-run cleanup with explicit operator acceptance. Current full provisioning already reuses an exact name within its chosen tenant. Counts alone do not prove each current repair creates duplicates. Do not delete profiles by name or guessed lack of use.
3. Profile customization: coordinate with existing issue 181 instead of creating a duplicate. Preserve that issue's full-replace versus read/modify/write decision for its own review. This plan does not alter `getOrCreateProfileWithCodec`, `ensureProfileCodec`, tenant selection, codec policy, or device repointing.
4. Directory ownership boundary: the package postinstall recursively assigns `/srv/node-red` to `node-red`, although procd currently runs Node-RED as root. Record this as an integrity/lifecycle hardening question for parent triage; do not silently change the service user or directory ownership here. File mode repair does not secure a compromised owner of the enclosing directory or a process already holding an old descriptor.

There are no new UCI settings, environment knobs, schema changes, npm dependencies, modules, registries or server companion. Two internal CLI operations proposed below are needed so deploy uses the same filesystem policy before its conditional provisioning and without loading gRPC dependencies. They are operations, not configurable policy switches. Independent review must explicitly approve that small interface addition and the Linux descriptor-path requirement.

## Source map and exact claims

Line numbers below refer to base `63c7a70f`; find the named function if they move.

| File/function/caller | Current behavior | Disposition |
|---|---|---|
| `scripts/chirpstack-bootstrap.js:326`, `writeEnvFile` | `writeFileSync(..., 'utf8')`: creation follows umask, replacement truncates and preserves mode; follows symlink. | Replace with merge plus the single safe publisher. |
| Same file:501, `readEnvFileText` | Reads path directly. | Read only through a checked descriptor after narrowing. |
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
| Both profiles' `files/etc/init.d/osi-bootstrap`, `start` | Prefers ROM script, fallback to `/srv`; stamp skips the writer on provisioned boots; only stamps on bootstrap success and then requests coordinated restart. | Read-only claim, no edits. Full bootstrap preflight protects actual invocations. Stamped old installations require the scoped deploy repair; do not claim boot alone repairs them. |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`, `load_chirpstack_env_value`/`start_service` | UCI first, env per-key fallback; procd command has no user switch. | Read-only claim. Root can read `0600`; retain path/precedence. |
| Same directory `settings.js`, `loadChirpstackEnvFile` | Fills missing non-identity keys for non-procd starts. | Read-only claim. Preserve protected identity keys and file format. Non-root manual starts need an operator decision, not wider credential access. |
| `scripts/prepare-pi-communication-config.sh`, `scripts/diagnose-pi-communication.sh` | Read env; first tool can write UCI, neither writes this file. | No edits or execution. |
| `scripts/deploy-bundle.sh`, `deploy-push-bundle.sh`, `deploy-offline.sh` | Transport the same deploy/script payload. | No separate env writer. Keep packaging unchanged; source-based fetch-list regression covers the moved fetch. |

Additional implementation claims: `scripts/test-chirpstack-env-file.js` (new), `scripts/test-chirpstack-bootstrap-clover.js`, `scripts/test-deploy-gateway-setup.js`, `.github/workflows/verify-sync-flow.yml`, `.claude/skills/osi-config-and-flags/SKILL.md`, `.claude/skills/osi-live-ops-runbook/SKILL.md`. The workflow is shared with other campaign tasks; request a narrow step claim through parent. No migration-number, flow-node, allowance, helper-registry or GUI claims.

## Filesystem design

Implement local functions inside `scripts/chirpstack-bootstrap.js`, not a new helper package. The following is the complete operation contract, including order and failure handling. Use Node built-ins `fs` and existing `path`; retain existing external helper only for actual provisioning/repair.

### Descriptor and path operations

Add `withEnvDirectory(callback)`. Reject effective UID other than 0 before changing anything. Resolve the existing `ENV_FILE` override with `path.resolve`; do not add a new override. Do not create missing parent directories (the existing writer also needs its parent). Open `/` and walk each parent component using `fs.openSync('/proc/self/fd/' + parentFd + '/' + component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)`. `fstat` must report a directory. Close each previous directory fd after the next has opened; always close the final fd in `finally`. The callback receives `{ dirFd, dirPath: '/proc/self/fd/' + dirFd, name: path.basename(resolvedFile) }`.

Reject missing `O_NOFOLLOW`/`O_DIRECTORY` or unusable `/proc/self/fd` support; never retry with ordinary pathname opens. This is Linux/OpenWrt-specific by design. Walking descriptors prevents an intermediate symlink or a later ancestor rename from redirecting a credential operation. Permit the package's existing non-root-owned parent directory without chmod/chown changes to it. This does not confer integrity against a malicious directory owner replacing entries after this operation returns.

Add `secureExistingEnvFile(directory, name)` returning `null` for a missing entry or an open checked snapshot `{ fd, stat, text }`. The caller closes returned fds in `finally`.

1. `lstat` the final entry through `dirPath`; only `ENOENT` means missing. A dangling symlink is an entry and must fail. Reject anything except a regular file with link count 1.
2. Open `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then `fstat`. Require regular, link count 1, same `dev`/`ino` as the `lstat`. `O_NONBLOCK` prevents a raced FIFO from hanging before the type check.
3. If mode differs from `0600`, call `fchmodSync(fd, 0o600)` before reading any bytes. If UID/GID differ from 0/0, `fchownSync(fd, 0, 0)`, then ensure `fchmodSync(fd, 0o600)` again. A change of ownership must never cause a wider mode. Re-stat and require root:root, `mode & 0o7777 === 0o600`, regular, single link. If metadata changed, fsync this fd. A metadata error is fatal; do not continue to the API.
4. Recheck the directory entry still names the opened inode. Read text from the descriptor, not its original pathname. Capture post-read `dev`, `ino`, `size`, `mtimeMs`, `ctimeMs` and compare against the pre-read values to reject a concurrent content change. Return the post-narrowing snapshot.
5. On any exception, close the fd and propagate an error that names the operation/path but includes no file contents, credential value or raw RPC/CLI output.

Add `assertEnvSnapshot(directory, name, snapshot)` for the publisher's final check: require the same regular single-link root-owned `0600` entry and snapshot identity/timestamps/size, or require absence if snapshot is null. An observed change is an error, never an instruction to overwrite the newcomer. No retries that read a different file implicitly.

### Restrictive staging and publication

Add `publishEnvText(directory, name, text, snapshot, publication)` where `publication` is local-only `replace` or `create-only`.

1. Create a unique same-filesystem staging directory with `mkdtempSync(dirPath + '/.' + name + '.tmp-')`. If creation collides/fails, throw. Never fall back to `.soil-repair.tmp`, PID-only names, `/tmp`, or a shared deterministic file. Open the new directory with `O_DIRECTORY | O_NOFOLLOW`, record its inode, enforce root:root `0700` by fd, and use its own `/proc/self/fd/<fd>` path thereafter.
2. Open `env` inside that private directory using `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, initial mode `0600`. Require a regular single-link file. Set root:root and exact `0600` by fd before the first byte, so even umask `0777` produces a usable final file without an exposure interval. A pre-existing `env` entry or symlink is an error; do not truncate it.
3. `fs.writeFileSync(fd, text, 'utf8')` writes the complete string through the fd; use no single unchecked `writeSync` that could short-write. `fsyncSync(fd)` and verify metadata. Close the staging file before publishing. Do not include `text` in errors or logs.
4. Call `assertEnvSnapshot` immediately before publication. For an existing live file use `renameSync(stagingFdPath + '/env', dirPath + '/' + name)`; source/destination remain on the same filesystem. For a missing live file or a new backup, use `linkSync(stagingFdPath + '/env', dirPath + '/' + name)` as exclusive publication, then unlink the private staging link. `EEXIST` fails closed; it never overwrites a new entry or follows a symlink. This avoids the absent-file check/rename clobber race without a native renameat2 dependency.
5. Verify the published entry by no-follow descriptor: expected candidate inode, root:root, regular, `0600`, single link after removing the staging link, complete expected byte length. Fsync the parent directory before reporting success. Do not open it for rewriting or chmod the pathname after publication.
6. In `finally`, close all fds and unlink only the staging entry owned by this invocation through its pinned directory fd. Remove the staging directory by its saved parent/name only when its current inode still matches. Use no recursive deletion and never touch old `.soil-repair.tmp` or another invocation's files. A cleanup failure is visible and returns failure; distinguish `published=true` in the diagnostic so callers know a valid restrictive candidate may already be live. Do not roll back automatically after publication.

A power interruption can leave a private `0700` stage containing `0600` data. In the create-only hard-link publication interval it can leave a second link; the next run intentionally rejects link count >1. Recovery requires inspection of synthetic rehearsal evidence and a separately authorized operator action, not an automatic wildcard cleanup. The retained `.pre-gen2` is never part of temp cleanup.

There is no atomic compare-and-rename in Node's standard API. A final recheck detects observed entry changes; rename itself cannot follow a final symlink. The design does not promise to defeat a hostile directory owner racing between that check and rename or replacing the file afterward. All supported root provisioning/deploy invocations must be serialized administratively. Independent approval must assess that boundary explicitly; if stronger concurrent hostile-owner protection is required, stop and amend this plan rather than adding a lock, native helper or ownership migration during execution.

### Shared writer integration

Add `secureEnvFiles()` using one directory session: secure/check `name` and `name + '.pre-gen2'` if present, close every fd, return presence metadata only. It must not create a live file when absent or read/log a secret for output. It may read through the checked function internally, but output contains only safe status/path metadata. A bad backup blocks the operation even if the live file was successfully narrowed first. Narrowing is deliberately not undone on a later failure.

Replace `readEnvFileText()` with a descriptor-session read using `secureExistingEnvFile`, returning null only for absence. This preserves its caller contract while removing path-following reads.

Replace `writeEnvFile(vars)` with a session that opens/narrows the current live file, reads its checked text, builds final text, and calls `publishEnvText` before closing the snapshot fd. For null/empty prior content, use the existing serialization `Object.entries(vars).map(([key,value]) => key + '=' + value).join('\n') + '\n'`. For nonempty content, apply existing `setEnvLine(text, key, value)` in `Object.entries(vars)` order. This updates all duplicate assignments of each managed key, retains every other line (comments, blank lines, CRLF on untouched lines, unknown assignments, duplicate unrelated keys, and a final unterminated unrelated line), and appends missing managed keys without concatenating assignments. Do not strip all `CHIRPSTACK_*`: only keys actually in `vars` are managed. Preserve stale identity lines as bytes; existing consumer protections, not this task, decide their runtime effect.

Replace `writeEnvFileAtomic(text)` with a session that obtains a fresh checked live snapshot and publishes text with the same `0600` policy. Require a live file for this soil adapter. At the `repairCloverProfile` call site, reject if current text differs from the `envText` read for this repair; pass that expected text into the adapter as its second argument. An unrelated concurrent edit must cause a retryable error instead of being lost. Keep the one-Clover-key `setEnvLine` call and all profile/UCI decisions unchanged.

Add `backupEnvFile()` using the same directory functions. Require live source; narrow/check both source and existing `.pre-gen2` before doing anything else. If backup exists, retain its bytes and inode and report retention (it may represent an older interrupted operation; do not claim it is a new snapshot). If missing, publish an exact byte copy of live text to `.pre-gen2` with create-only semantics. Success requires fsync and final mode/ownership verification. Failure leaves live bytes untouched and prevents full provisioning. Never replace a previous recovery copy or delete it after success.

### CLI and caller ordering

Keep existing `parseRepairArgs` behavior for no arguments, repair, and repoint options. At the start of `run(argv)` recognize exactly one argument `--secure-env-file` or `--backup-env-file`. Call the respective local operation and return. If either token occurs in any other argument list, reject the combination before any filesystem or API mutation; retain rejection of all other unknown flags. These operations perform no key CLI, gRPC, UCI, settings or flow work.

Replace eager `const chirpstack = loadChirpStackHelper()` with `let chirpstack;`. For normal full/soil modes: parse options first, call `secureEnvFiles()`, then assign `chirpstack = loadChirpStackHelper()`, then dispatch to `repairSoilProfiles(options)` or `main()`. This secures no-op/error soil paths and full bootstrap before minting a key. Keep final `run(...).catch(...)` exit 1; filesystem messages must be redacted as specified. Do not claim key-mint cleanup on a later non-filesystem failure.

## Deploy edits, in order

1. Move the existing `fetch_required "chirpstack-bootstrap.js" "scripts/chirpstack-bootstrap.js" "/srv/node-red/chirpstack-bootstrap.js"` to immediately before the ChirpStack bootstrap service fetch and `enable_osi_bootstrap` near base line 1874. Follow the fetch immediately with the fragment below. This runs before the first env-based provisioning/stamp check, before API provisioning and before this deploy's schema/restart paths. Keep the original required-fetch error policy; do not add a transport or payload file.

   ```sh
   if ! node /srv/node-red/chirpstack-bootstrap.js --secure-env-file; then
       echo "ERROR: ChirpStack credential env-file safety check failed; refusing deploy" >&2
       exit 1
   fi
   ```

2. Leave the Gen2 missing-profile condition and explicit existing-key environment input unchanged after the early safety check. Move the existing key extraction after successful backup validation. Replace `cp`, `cs_env_backup=""` fallback and its guard with this sequence inside the condition:

   ```sh
   cs_env_backup="/srv/node-red/.chirpstack.env.pre-gen2"
   if ! node /srv/node-red/chirpstack-bootstrap.js --backup-env-file; then
       echo "ERROR: secure ChirpStack recovery backup unavailable; refusing Gen2 provisioning" >&2
       exit 1
   fi
   cs_api_key="$(sed -n 's/^CHIRPSTACK_API_KEY=//p' /srv/node-red/.chirpstack.env | head -1 | tr -d '\r')"
   if CHIRPSTACK_API_KEY="$cs_api_key" node /srv/node-red/chirpstack-bootstrap.js; then
       echo "OK: Gen2 profile provisioned"
   else
       echo "WARN: Gen2 profile provisioning failed; valves will register on the Gen1 profile"
       echo "NOTE: pre-provisioning env backup kept at $cs_env_backup"
   fi
   if ! node /srv/node-red/chirpstack-bootstrap.js --secure-env-file; then
       echo "ERROR: ChirpStack credential env-file unsafe after provisioning; refusing deploy" >&2
       exit 1
   fi
   ```

   Remove the entire missing-key append loop and backup `chmod ... || true`. The full writer now preserves unrelated lines within the atomic publication itself, including after late UCI/flow-validation failure. The API failure remains a warning only when subsequent filesystem checks succeed. Backup creation/security failure becomes fatal because no safe recovery/provisioning path has been established.

3. Keep the soil repair invocation, deadline and closing-banner warning flag. Immediately after that conditional and before `materialize_native_sqlite3`, repeat the first file-security fragment. It must run even when the sensors application is absent or Gen2 already exists. It is not gated on any profile repair result. A filesystem failure is fatal; an API repair failure with safely retained credentials remains warn-only.
4. Remove the old late bootstrap fetch. Correct `print_bootstrap_note` from “CHIRPSTACK_* keys only” to “updates managed CHIRPSTACK_* keys and preserves other env lines.” Do not change the printed explicit-key service command or ROM/fallback preference.
5. Do not alter `run_schema_migration`, exit traps, payload flips, firmware stamping, identityd restart coordination, or rollback services. All new security failures occur before this deploy has stopped/restarted Node-RED or flipped its payload. The old running process may keep its existing credential in memory. No manual service restart is part of this patch.

## Test implementation specification

Add `scripts/test-chirpstack-env-file.js`, run under Node's built-in test runner. Use only synthetic strings and fresh temporary directories. Execute the real source with a fake ChirpStack helper and child-process module for full/soil paths; use the real filesystem for metadata, links and publication. Normal file-only CLI cases must not load any external helper. No network, real UCI, `chirpstack` CLI, service, `/srv`, `/data`, credential directory or live file may be touched. The harness must reject a side-effect path outside its temporary fixture before executing it.

Give this suite the existing test-only `OSI_BOOTSTRAP_UNDER_TEST` source override and a test-only `OSI_DEPLOY_UNDER_TEST` source override. Those are harness inputs, never product knobs. Shell fixtures extract only named source functions/marked credential fragments and substitute fixture paths, following `test-deploy-gateway-setup.js`; never execute deploy.sh whole. Stub every service/API/key command and assert no calls in file-only paths. Run env/umask cases in isolated child processes, not by changing the runner's shared umask. Use event traces from narrow fs wrappers to inspect permissions at the first write and immediately before publication, so a write-then-chmod implementation fails even if final stat passes.

| Test | Exact cases and assertions |
|---|---|
| T1 creation | Full writer with absent file under umasks `022`, `077`, `000`, `0777`. At first secret write staging mode is `0600`, owner 0/0; at publication content is complete. Final live file regular, link count 1, root:root `0600`. No secret in stdout/stderr. |
| T2 existing-file narrowing | Start `0644`, `0666`, `0600`, `0400`, special mode bits; also non-root-owned regular fixture when root test support is available. Before read/key/API/copy, descriptor is root:root exact `0600`. Bytes survive pure secure mode. Second secure call leaves inode/content and metadata unchanged when already correct. Missing live file is not created; existing backup is still narrowed. Non-root invocation fails without changes. |
| T3 full content compatibility | Synthetic API key, all generated profile/app assignments, unknown `CHIRPSTACK_EXTRA`, `AGROSCOPE_*`, `LOG_*`, `DEVICE_EUI*`, comments, blanks, quoted values, spaces, equals in values, CRLF, unrelated duplicate lines, unterminated last line. All unrelated bytes remain; managed duplicates all get one consistent new value; no joined assignments. Parse with actual consumer functions and prove expected token/profile values and protected identity precedence. |
| T4 soil paths | Actual repair changes Clover from alias: only Clover assignment bytes change, `0644` becomes `0600`. Already-correct Clover: no content or RPC/UCI writes, old mode still narrowed. Missing token, missing codec and failed RPC: narrowing happens first, no full-provision fallback or key creation. Expected-env snapshot mismatch fails rather than discarding operator edits. |
| T5 backup | Absent `.pre-gen2`: exact live snapshot appears only after complete `0600` staging. Existing backup `0644`: narrow but preserve bytes/inode even if current live differs. Second invocation retains it. Never unlink after successful provisioning. Missing live source refuses backup; no bootstrap invocation. |
| T6 hostile entries | Both live and backup: symlink to sentinel, dangling symlink, directory, FIFO, socket where supported, hard link to sentinel; unsafe parent-component symlink; missing no-follow constant or descriptor-path capability. Require nonzero result, no read of sentinel, unchanged sentinel bytes/mode, no API/key/UCI/service calls. An old `.soil-repair.tmp` sentinel/symlink remains untouched. Force unique staging creation collision and force `env` exclusive-open collision inside the private stage; refuse without truncation or fallback. |
| T7 actual deploy fragments | Secure gate precedes `enable_osi_bootstrap` env read and all provisioning. Gen2 present still repairs `0644`; absent live file is not manufactured. Gen2 missing: safe backup before fake bootstrap, existing key reused, unknown lines retained on success and injected late bootstrap failure. Backup failure/symlink blocks fake bootstrap; security failure blocks migration/restart/payload markers. Soil RPC failure stays warn-only after final file check; unsafe file is fatal. `.pre-gen2` remains exact `0600` before every simulated restart marker. |
| T8 faults and cleanup | Inject open, chmod, chown, partial-write/write error, file-fsync, rename/link, unlink, directory-fsync and close/cleanup faults. Before publication: old live bytes remain, already-narrowed mode persists, private owned stage cleaned when possible, backup retained. After publication: complete restrictive file remains, result nonzero, diagnostic identifies publication state without secret. Forced destination replacement immediately before final validation is refused. A collided staging entry is not removed by cleanup. |
| T9 interruption | In a bounded synthetic child, pause before publish and after publish, terminate it and inspect fixture. Before: old full file; after: new full `0600` file; no partial live file. Backup preserved. Kill between create-only link and private unlink: next invocation refuses nlink >1; no automatic deletion. Do not describe SIGKILL as a physical power-loss/fsync proof. |
| T10 mirrors/callers | All three script bytes identical. Both init scripts still use existing stamp/ROM/fallback and coordinated-restart contract; writer failure produces no stamp/restart in fake service fixture. No service-user change, new config, API operation or database edit in diff. |

Update `scripts/test-chirpstack-bootstrap-clover.js` fakes so they model the new real fs contracts: constants, directory descriptors/path aliases, lstat/fstat identity and type, UID/GID/link count, fchmod/fchown, mkdtemp, exclusive opens, descriptor reads/writes, directory/file fsync, link/rename/unlink/rmdir, and close behavior. Add fake effective UID 0 and a real `getuid`/`geteuid` contract. Unsupported methods must fail loudly. Preserve existing API/UCI write-count assertions. Update the final mode assertion from “keeps its mode” to “enforces 0600”; replace the exact-one-fsync assertion with ordering checks for staged-file flush before publish and parent-directory flush after. Retain no-content-write idempotence; security metadata correction is now explicitly allowed on unsafe fixtures.

Update `scripts/test-deploy-gateway-setup.js` expectations for the corrected banner and early file-only invocation using a stub. Add the new init-failure case without editing the init scripts. Existing tests for stamp/restart behavior must keep their meaning. Add this explicit named CI step adjacent to the existing bootstrap step, which remains unchanged:

```yaml
- name: ChirpStack credential env-file safety
  run: node --test --test-concurrency=1 scripts/test-chirpstack-env-file.js
```

The inventory verifier recognizes a leading `node` command, not a `sudo` prefix. Keep the workflow command above and implement privilege handling inside the new test file: when effective UID is not 0, register one enclosing test that synchronously runs `sudo -n env -i PATH=/usr/bin:/bin`, the explicit test-only source overrides if set, `process.execPath`, `--test`, `--test-concurrency=1`, and this test file's absolute path. Set a 45-second timeout and a 2 MiB output bound. Print the child TAP through test diagnostics and assert child exit 0, no timeout/signal, all required inner test names present, and no skipped/cancelled cases. The root branch registers T1–T10 directly and makes no sudo call. Do not inherit arbitrary environment variables or secrets. Never run the whole deploy with sudo. This needs no inventory-parser change, exclusion or new runner file.

The new real-filesystem suite requires Linux root privileges to prove root:root ownership. It should fail clearly if those are unavailable, rather than skip ownership assertions and claim green. The fake suite alone cannot prove kernel ownership. Do not install a container runtime or grant new privileges to satisfy it; parent must record that gate pending on a host without existing noninteractive fixture-only sudo.

## Commit and execution order after approval

This assignment commits this plan only. The implementation author later starts from the recorded base (or records a reviewed rebase), never from the user's root checkout. Stop on a mismatch with the planned functions/call sites; report it instead of forcing a replacement design.

1. Independent reviewer inspects this plan, current issue discussions and source. Required objections must be resolved in a new plan commit before code. Parent records narrow shared-file claims. The parent has explicitly released the heavy hold; any subsequent hold must stop executable validation again. Resource availability or wrapper admission alone cannot release a hold.
2. Prepare the new synthetic suite, expanded existing fakes and CI wiring in the isolated implementation worktree. Save a base source snapshot and run the new suite against it through the campaign wrapper. Expected red: A1 `0644` creation and A2 permissive existing mode; file-only options do not exist on base. A missing fixture/dependency, no tests collected or harness crash is not defect reproduction. Keep exact failure names/output.
3. Implement local filesystem functions, CLI dispatch, full merge and soil adapter; mirror the script into both profiles. Commit with tests as `fix: secure ChirpStack credential env-file writes`. This commit owns no deploy caller changes. Run focused bootstrap cases and parity before committing if the hold has been released.
4. Implement early deploy gate, safe retained backup, remove append/copy/chmod paths, final gate and banner; update fake deployment cases. Commit `fix: repair credential env-file modes before deploy provisioning`. Keep API warning semantics separate from filesystem safety errors.
5. Update only the relevant paragraphs in `.claude/skills/osi-config-and-flags/SKILL.md` §3 and `.claude/skills/osi-live-ops-runbook/SKILL.md` provisioning/deploy descriptions: root:root `0600`, preservation of unrelated lines, mode-only repair even when profile repair is a no-op, internal file-only operations, retained recovery backup, fatal filesystem failure versus warning API failure. Commit `docs: record ChirpStack env-file safety and recovery`. No new live execution steps or permission grants.
6. Independent non-author verifier checks the explicit base-to-final diff and reruns all applicable gates at the final candidate SHA. Parent supplies issue/acceptance/plan/diff/evidence to a fresh review context. Campaign `COORDINATION.md` requires fresh Opus review from October 26 Europe/Zurich after independent Sol verification; use subscription only, queue if unavailable. Any repair invalidates affected evidence and approval. Parent owns subsequent PR and GitHub actions.

## Exact pending validation commands and evidence

Candidate commands in this section remain proposed and unexecuted. The separate design probe above is complete; plan-only prose/whitespace results belong in the handoff. If another heavy hold starts, stop syntax, prose and extraction checks as well. Use `python3 /home/phil/projects/osi-release-campaign-2026-10-25/run-heavy.py` for each executable verification, with stdout, stderr and real status saved. No unwrapped fallback and no indefinite polling after admission refusal.

Use the implementation worktree as cwd; base is `63c7a70f8f3b373f162b33b0669b0df89b3763fa`. Save logs under campaign `artifacts/issue-183/`. Author/verifier use separate `author-` and `verifier-` names and record their candidate SHA, exact cwd, source overrides and command. `run-heavy.py` exit 75 means refused/pending, not a test result. No executable source extraction is performed during this design assignment.

After hold release, create the evidence directory. Run these invocations separately, recording `$?` immediately to the matching `.status` file; redirect both stdout and stderr to the matching `.log`. Do not pipe through `tail`, `tee` or `grep` to decide pass. The red run intentionally has nonzero status; the evidence runner must preserve it without stopping before saving the status.

| Gate | Command passed to `python3 CAMPAIGN/run-heavy.py` | Expected result |
|---|---|---|
| B1 baseline snapshot | `git show 63c7a70f8f3b373f162b33b0669b0df89b3763fa:scripts/chirpstack-bootstrap.js` (stdout to `base-chirpstack-bootstrap.js`) | Exit 0, saved exact base source; extraction is pending. |
| B2 deploy snapshot | `git show 63c7a70f8f3b373f162b33b0669b0df89b3763fa:deploy.sh` (stdout to `base-deploy.sh`) | Exit 0, saved exact base source. |
| B3 red security suite | `sudo -n env OSI_BOOTSTRAP_UNDER_TEST=/home/phil/projects/osi-release-campaign-2026-10-25/artifacts/issue-183/base-chirpstack-bootstrap.js OSI_DEPLOY_UNDER_TEST=/home/phil/projects/osi-release-campaign-2026-10-25/artifacts/issue-183/base-deploy.sh node --test --test-concurrency=1 scripts/test-chirpstack-env-file.js` | Named defect failures, no real services; inspect output. Record missing sudo/Node as pending infrastructure, not expected red. Resolve Node's absolute executable once for sudo if PATH differs. |
| G1 candidate security | `sudo -n node --test --test-concurrency=1 scripts/test-chirpstack-env-file.js` | Exit 0, all named tests collected/passed, no skips for ownership. |
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

An unsafe path, failed narrowing, backup failure or unsupported primitive returns failure before credential creation or profile mutation in direct bootstrap, and before provisioning/schema/restart in deploy. Do not unlink a symlink to “repair” it, chmod through it, follow it to a different credential file, or hide a filesystem failure in the soil warning banner. No automatic fallback to old writer behavior is permitted.

Before publication, retain prior bytes; permissions already narrowed remain narrowed. After publication, retain the complete restrictive candidate and `.pre-gen2`, report the failed durability/cleanup/post-step, and stop where specified. A late API/UCI failure may already have changed remote or canonical profile state; this file-mode task neither reverses those changes nor mints/revokes credentials to recover them. Retrying must not replace the retained backup.

Reverting code is not permission to restore `0644` or an old permissive backup. Payload rollback must keep safe env ownership/modes. Recovery from `.pre-gen2` is a separate explicitly authorized operator action: use the same checked restrictive publisher, preserve the backup, validate needed managed configuration against the intended environment, and never copy the database. No such recovery is authorized or performed by this plan.

Delivery remains `planning / pending independent approval and validation`. Parent must record each lifecycle disposition and the lack of deployed-mode evidence; a passing synthetic gate proves the local mode/write contract, not fleet rollout or full issue closure.
