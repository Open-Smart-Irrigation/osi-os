# Issue 390 bundle shell CI plan

Status: committed execution plan only. Every test, workflow and inventory
outcome below is **UNRUN** or a forecast. The source design was accepted
after five independent review rounds against immutable campaign base
`63c7a70f8f3b373f162b33b0669b0df89b3763fa`. This plan reconciles it to
`origin/main` at `0eaa6d87892708c66f5a004bf121656c5a52b17e` (W), fetched
on 2026-10-30. The four scripts this change tests or edits are byte-identical
at those two commits:

| Path | SHA-256 at both commits |
|---|---|
| `scripts/deploy-push-bundle.sh` | `8e8b080324e0c3c58d23fe8e189538a73877206c5de9fb98e6b768918eecbba4` |
| `scripts/deploy-push-bundle.test.sh` | `9dc9518f59f07acf037d3cf3df49483480eb0465b6e8c79ba460ff360934f810` |
| `scripts/deploy-offline.sh` | `e3b087a01db14f969d65ed32569486093d9204c11072851ede2a66a6f678ea8d` |
| `scripts/deploy-offline.test.sh` | `3a603e0319e40a8c36711f6877474990173dd25ce12d0b56f0db7b07f7ea45a3` |

`scripts/deploy-local-server.js` is also unchanged
(`94f89ccb1339067db751f931ea5e92c22cc0695e73be9c17c77697ad0c227850`).
`scripts/verify-test-inventory.json` at W has SHA-256
`6550885b736f2bcf0a3e1a37730226012f2b63c43327710ed4be723763202441`. Recheck
these hashes before execution; any difference stops the work for a plan
amendment.

## Claim and evidence limit

#390 is open at P1 with no comments (read 2026-10-30T22:31Z). The uploader
test is a `#!/bin/sh` driver, yet four call sites start the uploader with
`sh "$pusher"`: the `push` function and three direct cases. The uploader
declares Bash and uses `set -o pipefail`, `BASH_SOURCE` and arrays. Starting
the driver with Bash leaves those nested calls unchanged. Both test files are
excluded from the inventory with #390 reasons, and no workflow file at W
names either path.

The evidence is limited. On a workstation whose `sh` resolves to Bash, the
unchanged uploader test passed all six cases at W with a local SSH stub that
runs commands in a scratch directory. Dash and BusyBox were absent there, so
no dash or ash result exists. The offline test has never run for this issue:
its deployer starts `setsid` descendants outside the caller's process group.
A passing Bash run is not a reproduction of the wrong-interpreter defect.

## Scope and owned paths

Change exactly four paths in one commit:

- `scripts/deploy-push-bundle.test.sh`
- `scripts/deploy-offline.test.sh`
- `.github/workflows/deploy-bundle-shells.yml` (new)
- `scripts/verify-test-inventory.json` (delete the two #390 objects only)

The uploader, deployer, local server, inventory verifier, other workflows,
SSH configuration and every gateway remain untouched. The workflow references
and the two deletions land together: the verifier rejects a workflow-run test
that is still excluded, and an unclassified test file.

Two open draft PRs touch neighbours. #551 (#391) deletes the two adjacent
`slow (#391)` objects from the same JSON array; if it merges first, this
plan's inventory diff context no longer applies and the deletion must be
re-derived against the new base and re-reviewed. #550 (#395) rewrites the
verifier's shell-script model. Read against its head
`87a797b732ec7542599b4308e271cb2f3b7daab8`, the two direct `sh` calls in each
lane stay countable because they precede the first command substitution and
the first `exit`. Keep that order. Neither PR is a dependency of this one.

## Execution order and stop gates

1. An independent reviewer checks this plan commit against W, the five
   source-review rounds and the four owned paths. A required correction stops
   execution until a revised plan is reviewed.
2. The executor confirms the base hashes above, then runs the baseline gates
   below. A red baseline gate is `red-on-base`: stop and report.
3. Apply the inventory and workflow diffs separately and confirm each half
   alone fails the inventory verifier for the stated structural reason. Then
   apply both and confirm the verifier passes.
4. Apply the uploader diff. Run its local gates, including the deliberate
   non-target-shell failure. Apply the offline diff and run only its static
   gates. Do not run the offline fixture locally through the campaign
   heavy-command wrapper, whose process-group ownership the `setsid`
   descendants would leave.
5. Commit the four paths together. An independent reviewer approves the exact
   head's source, diff and local evidence before the parent publishes a
   pending draft PR. That draft exists to obtain the two scoped
   `pull_request` jobs; it is not a review claim.
6. A fresh independent reviewer reads both CI job logs at the exact head and
   checks every oracle in "CI qualification". A changed head invalidates the
   affected review and CI evidence.

No `workflow_dispatch`, broad rerun, ready-for-review flag, merge, release,
deployment, real SSH or issue closure belongs to this plan. If any shell
diagnostic, tool prerequisite or cleanup behaviour differs from this plan,
stop and report rather than adapting the test.

## Exact edits

### Uploader test

Replace exactly the four `sh "$pusher"` dispatches with `bash "$pusher"`.
Keep the SSH stub's `sh -c "$1"`, which emulates the remote shell. A guard
fails with 127 when `bash` is missing. The new wrong-interpreter control runs
only when `DEPLOY_TEST_EXPECT_SH` is `dash` or `ash`. It deliberately starts
the uploader with the lane's `sh` against the real fixture bundle and sidecar.
It requires a nonzero exit, a parse or option diagnostic and no uploaded
bundle. An unexpected value of the variable exits 2. The existing exit-0 and
exit-9 comparisons stay the exit-code oracle.

````diff
--- a/scripts/deploy-push-bundle.test.sh
+++ b/scripts/deploy-push-bundle.test.sh
@@ -7,6 +7,11 @@

 script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
 pusher="$script_dir/deploy-push-bundle.sh"
+# The test driver is POSIX sh; the workstation uploader requires Bash.
+command -v bash >/dev/null 2>&1 || {
+  echo 'deploy-push-bundle.test: bash is required for the uploader' >&2
+  exit 127
+}

 work=$(mktemp -d)
 trap 'rm -rf "$work"' EXIT INT TERM
@@ -41,9 +46,31 @@
 sha256sum "$bundle" | cut -d ' ' -f1 > "$work/sha.txt"
 printf '%s  %s\n' "$(cat "$work/sha.txt")" "$(basename "$bundle")" > "$bundle.sha256"

+case "${DEPLOY_TEST_EXPECT_SH:-}" in
+  dash|ash)
+    if SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
+        sh "$pusher" test-host "$bundle" >"$work/wrong-shell.out" 2>&1; then
+      echo 'wrong-interpreter control unexpectedly passed' >&2
+      exit 1
+    fi
+    grep -Eqi 'syntax error|unexpected|bad substitution|pipefail' "$work/wrong-shell.out" || {
+      echo 'wrong-interpreter failure did not identify the shell boundary' >&2
+      cat "$work/wrong-shell.out" >&2
+      exit 1
+    }
+    [ ! -e "$remote_tmp/$(basename "$bundle")" ] || {
+      echo 'wrong-interpreter control reached the upload stub' >&2
+      exit 1
+    }
+    echo 'wrong-interpreter control: OK'
+    ;;
+  '') ;;
+  *) echo 'DEPLOY_TEST_EXPECT_SH must be dash or ash' >&2; exit 2 ;;
+esac
+
 push() {
   SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
-    sh "$pusher" "test-host" "$bundle" "$@"
+    bash "$pusher" "test-host" "$bundle" "$@"
 }

 echo "=== fresh upload streams the whole bundle and invokes deploy-offline.sh ==="
@@ -94,7 +121,7 @@
 : > "$run_log"
 set +e
 STUB_DEPLOY_OFFLINE_EXIT=0 SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
-  sh "$pusher" "test-host" "$bundle" >/dev/null 2>&1
+  bash "$pusher" "test-host" "$bundle" >/dev/null 2>&1
 rc_zero=$?
 set -e
 [ "$rc_zero" = "0" ] || { echo "expected exit 0 to propagate" >&2; exit 1; }
@@ -102,7 +129,7 @@
 rm -f "$remote_bundle" "$remote_bundle.sha256"
 set +e
 STUB_DEPLOY_OFFLINE_EXIT=9 SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
-  sh "$pusher" "test-host" "$bundle" >/dev/null 2>&1
+  bash "$pusher" "test-host" "$bundle" >/dev/null 2>&1
 rc_nine=$?
 set -e
 [ "$rc_nine" = "9" ] || { echo "expected exit 9 to propagate, got $rc_nine" >&2; exit 1; }
@@ -110,7 +137,7 @@

 echo "=== missing bundle fails clearly ==="
 if push_missing=$(SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
-    sh "$pusher" "test-host" "$work/nope.tar.gz" 2>&1); then
+    bash "$pusher" "test-host" "$work/nope.tar.gz" 2>&1); then
   echo "expected failure for a missing bundle" >&2
   exit 1
 fi
````

### Offline test

The header now names the generated stub, the real loopback server and the
prerequisites. The test canonicalizes its work directory and generates a
test-only Node helper, `cleanup-owned.js`, which identifies fixture processes
by the unique work path in their command line and by `/proc/<pid>/stat`
start ticks. It rechecks PID, start ticks, argv and kind immediately before
each TERM or KILL. It sweeps until three quiet scans 250 ms apart or a
seven-second bound. An owned PID file, marker or fixture directory that
cannot be read is a sticky error; an unreadable unrelated `/proc` entry is
ignored. A missing delay marker is tracked apart from every other error and
still fails. The EXIT trap keeps the work directory whenever ownership is
uncertain.

Each live case captures the deployer's direct status (0 for `okwait`, 7 for
`failwait`, 0 for the `async1` handoff) and then proves its own server: the
exact `READY` line for its extraction root, an untagged readiness request, no
bind error and a PID-file identity check. The generated stub requests
`/deploy.sh?fixture_stub=<case>`, so a tagged line in the server log, plus the
stub's confirmation in its deploy log, proves the stub reached that server.
Every failure path prints the case output, the server log and the deploy log.

A stale-PID canary must survive an audit. Two marked controls exit 23 (an
assertion) and 143 (TERM) while a unique-path Node delay is live; the parent
checks that delay is gone and the work is quiescent, twice, before removing the
child's work. The pre-marker control, selected by
`DEPLOY_TEST_PREMARKER_CONTROL=1`, starts that delay without its marker,
fails after the handoff and returns 19 only when the child cleanup, the
parent's second cleanup and its audit print the exact marker-only and
quiescent lines and an unrelated canary survives. Any other ownership error
vetoes 19 and keeps both work directories.

````diff
--- a/scripts/deploy-offline.test.sh
+++ b/scripts/deploy-offline.test.sh
@@ -1,10 +1,18 @@
 #!/bin/sh
-# Exercises deploy-offline.sh with deploy.sh stubbed out (the real deploy.sh
-# assumes a live gateway: /etc/init.d, uci, opkg, sqlite3, identityd -- none
-# of which exist in a generic test environment). Requires BusyBox ash + node
-# + tar + sha256sum + wget + setsid: run it under a busybox/node image, e.g.
-#   docker run --rm -v "$PWD":/repo -w /repo node:22-alpine sh scripts/deploy-offline.test.sh
-# (this workstation has neither busybox nor dash installed natively).
+# Exercises deploy-offline.sh against a generated deploy.sh stub (the real
+# deploy.sh assumes a live gateway: /etc/init.d, uci, opkg, sqlite3,
+# identityd) and the real deploy-local-server.js on 127.0.0.1. No SSH,
+# gateway or real deployment is involved.
+#
+# This is a POSIX sh test driver. CI runs it in two lanes whose /bin/sh is
+# dash or BusyBox ash (.github/workflows/deploy-bundle-shells.yml); it starts
+# deploy-offline.sh, and that script starts its detached watcher, with the
+# lane's sh. Prerequisites: node, tar, sha256sum, wget, setsid, awk, df,
+# tail, date, mktemp and ordinary shell utilities. Ports 18761-18764 on
+# 127.0.0.1 must be free; an occupied port is a setup failure.
+#
+# DEPLOY_TEST_CLEANUP_MODE and DEPLOY_TEST_PREMARKER_CONTROL select the
+# cleanup controls; ordinary runs leave both unset.
 set -eu

 script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
@@ -12,7 +20,217 @@
 server_js="$script_dir/deploy-local-server.js"

 work=$(mktemp -d)
-trap 'rm -rf "$work"' EXIT INT TERM
+work=$(CDPATH= cd -- "$work" && pwd -P)
+[ -z "${DEPLOY_TEST_WORK_FILE:-}" ] || printf '%s\n' "$work" > "$DEPLOY_TEST_WORK_FILE"
+canary_pid=
+retain_parent_work=0
+cat > "$work/cleanup-owned.js" <<'NODE'
+'use strict';
+const fs = require('node:fs');
+const path = require('node:path');
+const mode = process.argv[2];
+const work = path.resolve(process.argv[3]);
+const prefix = `${work}/tmp/deploy-bundle-`;
+const logPrefix = `${work}/data/deploy-`;
+const errors = [];
+let markerMissing = false;
+const known = new Map();
+if (!['cleanup', 'audit', 'pid', 'delay-live', 'delay-gone'].includes(mode) || !path.isAbsolute(process.argv[3])) process.exit(2);
+const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
+function classify(args) {
+  const exe = path.basename(args[0] || '');
+  if (['node', 'nodejs'].includes(exe) && args.some(a => a.startsWith(prefix) && a.endsWith('/scripts/deploy-local-server.js'))) return 'server';
+  if (['node', 'nodejs'].includes(exe) && args.some(a => a.startsWith(prefix) && a.endsWith('/scripts/fixture-delay.js'))) return 'delay';
+  if (['sh', 'dash', 'ash', 'busybox', 'setsid'].includes(exe) && args.some(a => a.includes(prefix) && a.includes('/deploy.sh'))) return 'watcher-or-stub';
+  if (exe === 'tail' && args.some(a => a.startsWith(logPrefix) && a.endsWith('.log'))) return 'log-tail';
+  return null;
+}
+function read(pid, required = false) {
+  if (!/^[1-9][0-9]*$/.test(String(pid))) return null;
+  let args;
+  try {
+    args = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
+  } catch (e) {
+    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null;
+    if (required) errors.push(`known PID ${pid}: cmdline: ${e.message}`);
+    return null; // unreadable unrelated /proc entry is not an owned process
+  }
+  const kind = classify(args);
+  if (!kind && !required) return null;
+  try {
+    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
+    const cut = stat.lastIndexOf(') ');
+    if (cut < 0) throw new Error('bad proc stat');
+    const state = stat.slice(cut + 2).trim().split(/\s+/)[0];
+    if (state === 'Z' || state === 'X') return null; // exited, awaiting reaping
+    const start = stat.slice(cut + 2).trim().split(/\s+/)[19]; // field 22
+    if (!/^[0-9]+$/.test(start || '')) throw new Error('bad startticks');
+    const statAgain = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
+    const cutAgain = statAgain.lastIndexOf(') ');
+    const startAgain = statAgain.slice(cutAgain + 2).trim().split(/\s+/)[19];
+    if (start !== startAgain) throw new Error('PID changed during read');
+    return { pid: Number(pid), start, args: args.join('\0'), kind };
+  } catch (e) {
+    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null;
+    errors.push(`known/identified PID ${pid}: stat: ${e.message}`);
+    return null;
+  }
+}
+function delayRecord(file, duringSweep = false) {
+  if (!file) return null;
+  try {
+    if (file !== `${work}/data/cleanup-delay.json`) throw new Error(`marker outside owned work: ${file}`);
+    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
+    const expected = `${work}/tmp/deploy-bundle-cleanup/scripts/fixture-delay.js`;
+    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 ||
+        !/^[0-9]+$/.test(record.start || '') || record.script !== expected) {
+      throw new Error(`invalid delay marker: ${file}`);
+    }
+    return record;
+  } catch (e) {
+    if (!duringSweep) throw e;
+    if (e.code === 'ENOENT') {
+      markerMissing = true; // expected only in the deliberate pre-marker control
+      return null;
+    }
+    const message = `delay marker uncertainty: ${file}: ${e.message}`;
+    if (!errors.includes(message)) errors.push(message);
+    return null; // unreadable/malformed marker is an additional ownership error
+  }
+}
+function candidates() {
+  let procEntries = [];
+  try { procEntries = fs.readdirSync('/proc'); }
+  catch (e) { errors.push(`/proc enumeration: ${e.message}`); }
+  const ids = new Set([...procEntries.filter(x => /^[1-9][0-9]*$/.test(x)), ...known.keys()]);
+  const required = new Set(known.keys());
+  const tmp = `${work}/tmp`;
+  let fixtureDirs = [];
+  try { fixtureDirs = fs.readdirSync(tmp); }
+  catch (e) { errors.push(`owned fixture directory ${tmp}: ${e.message}`); }
+  for (const dir of fixtureDirs) {
+    if (!dir.startsWith('deploy-bundle-')) continue;
+    const extract = `${tmp}/${dir}`;
+    let ownedFiles = [];
+    try { ownedFiles = fs.readdirSync(extract); }
+    catch (e) {
+      errors.push(`owned fixture directory ${extract}: ${e.message}`);
+      continue; // other fixtures and unique-path /proc candidates remain discoverable
+    }
+    if (!ownedFiles.includes('.local-server.pid')) continue;
+    const file = `${extract}/.local-server.pid`;
+    try {
+      const value = fs.readFileSync(file, 'utf8').trim();
+      if (/^[1-9][0-9]*$/.test(value)) { ids.add(value); required.add(value); }
+      else errors.push(`owned PID file ${file}: invalid PID`);
+    } catch (e) {
+      errors.push(`owned PID file ${file}: ${e.message}`);
+      // Never infer or signal a PID from this file; scan unique argv instead.
+    }
+  }
+  const marker = delayRecord(process.argv[4], true);
+  if (marker) { ids.add(String(marker.pid)); required.add(String(marker.pid)); }
+  const found = [];
+  for (const id of ids) {
+    const item = read(id, required.has(id));
+    const old = known.get(id);
+    if (old && item && item.start === old.start &&
+        (item.kind !== old.kind || item.args !== old.args)) errors.push(`known PID ${id}: identity changed`);
+    if (marker && Number(id) === marker.pid && item && item.start === marker.start &&
+        (item.kind !== 'delay' || !item.args.includes(marker.script))) errors.push(`delay PID ${id}: marker identity changed`);
+    if (item && item.kind) { known.set(id, item); found.push(item); }
+  }
+  return found;
+}
+function signal(candidate, name) {
+  const now = read(candidate.pid, true); // immediately before the signal
+  if (!now) return;
+  if (now.start !== candidate.start || now.args !== candidate.args || now.kind !== candidate.kind) {
+    errors.push(`PID ${candidate.pid}: identity changed before ${name}`);
+    return;
+  }
+  try {
+    process.kill(candidate.pid, name);
+    console.log(`fixture sweep: signaled ${candidate.pid}/${candidate.start}/${candidate.kind} ${name}`);
+  }
+  catch (e) { if (e.code !== 'ESRCH') errors.push(`PID ${candidate.pid}: ${name}: ${e.message}`); }
+}
+async function sweep() {
+  const started = Date.now();
+  let quiet = 0;
+  while (Date.now() - started < 7000) {
+    const live = candidates();
+    if (live.length === 0) {
+      quiet += 1;
+      if (quiet === 3) break; // three scans 250 ms apart; catches watcher forks
+    } else {
+      quiet = 0;
+      if (mode === 'cleanup') for (const item of live) signal(item, Date.now() - started < 2000 ? 'SIGTERM' : 'SIGKILL');
+    }
+    await pause(250);
+  }
+  const remaining = candidates();
+  if (quiet < 3 || remaining.length) errors.push(`not quiescent: ${remaining.map(x => `${x.pid}/${x.start}/${x.kind}`).join(', ')}`);
+  for (const error of errors) console.error(`fixture cleanup uncertainty: ${error}`);
+  if (errors.length) process.exitCode = 1;
+  else if (markerMissing) {
+    console.error('fixture cleanup: missing marker only; quiescent');
+    process.exitCode = 1;
+  }
+  else console.log(`fixture ${mode}: quiescent`);
+}
+if (mode === 'pid') {
+  const file = process.argv[4];
+  const expected = process.argv[5];
+  const extract = path.dirname(path.dirname(expected));
+  if (!extract.startsWith(prefix) || file !== `${extract}/.local-server.pid` || !fs.existsSync(file)) process.exit(1);
+  const pid = fs.readFileSync(file, 'utf8').trim();
+  if (!/^[1-9][0-9]*$/.test(pid)) process.exit(1);
+  const live = read(pid, true);
+  if (errors.length) { for (const error of errors) console.error(error); process.exit(1); }
+  if (live && (live.kind !== 'server' || !live.args.includes(expected))) process.exit(1);
+  console.log(`fixture PID ${pid}: ${live ? `server startticks ${live.start}` : 'already exited'}`);
+} else if (mode === 'delay-live' || mode === 'delay-gone') {
+  try {
+    const marker = delayRecord(process.argv[4]);
+    if (!marker) throw new Error('delay marker required');
+    const live = read(marker.pid, true);
+    if (errors.length) throw new Error(errors.join('; '));
+    const same = live && live.start === marker.start && live.kind === 'delay' && live.args.includes(marker.script);
+    if (live && live.start === marker.start && !same) throw new Error('known delay PID changed identity');
+    if (mode === 'delay-live' && !same) throw new Error('marked delay not live');
+    if (mode === 'delay-gone' && same) throw new Error('marked delay still live');
+    console.log(`marked delay ${marker.pid}/${marker.start}: ${mode === 'delay-live' ? 'live' : 'gone'}`);
+  } catch (e) { console.error(`fixture delay uncertainty: ${e.message}`); process.exitCode = 1; }
+} else sweep().catch(e => { console.error(`fixture cleanup uncertainty: ${e.message}`); process.exitCode = 1; });
+NODE
+cleanup() {
+  result=$?
+  trap - EXIT INT TERM
+  if [ -n "$canary_pid" ]; then
+    kill "$canary_pid" 2>/dev/null || :
+    wait "$canary_pid" 2>/dev/null || :
+  fi
+  if node "$work/cleanup-owned.js" cleanup "$work" "${STUB_DELAY_MARKER:-}"; then
+    case "${DEPLOY_TEST_CLEANUP_MODE:-}" in
+      assertion|term|premarker) echo "fixture cleanup: quiescent; retained for parent: $work" ;;
+      *)
+        if [ "${DEPLOY_TEST_PREMARKER_CONTROL:-0}" = 1 ] || [ "$retain_parent_work" = 1 ]; then
+          echo "test parent work retained: $work"
+        else
+          rm -rf "$work" || result=1
+        fi
+        ;;
+    esac
+  else
+    echo "fixture cleanup failed; retained $work" >&2
+    result=1
+  fi
+  exit "$result"
+}
+trap cleanup EXIT
+trap 'exit 130' INT
+trap 'exit 143' TERM

 build_bundle() {
     exit_code="$1"
@@ -27,16 +245,276 @@
 port="\$1"
 base="http://127.0.0.1:\$port"
 echo "stub deploy.sh starting against \$base"
-wget -q -O /dev/null --spider "\$base/deploy.sh"
+: "\${STUB_REQUEST_TAG:?}"
+wget -q -O /dev/null --spider "\$base/deploy.sh?fixture_stub=\$STUB_REQUEST_TAG"
 echo "stub deploy.sh confirmed local server reachable"
+if [ "\${STUB_DELAY_SECONDS:-0}" -gt 0 ]; then
+    node "\$(dirname "\$0")/scripts/fixture-delay.js" "\$STUB_DELAY_SECONDS"
+fi
 exit $exit_code
 EOF
+    cat > "$fixture/scripts/fixture-delay.js" <<'NODE'
+'use strict';
+const fs = require('node:fs');
+const path = require('node:path');
+const seconds = Number(process.argv[2]);
+const marker = process.env.STUB_DELAY_MARKER;
+if (seconds !== 20 || !marker || !path.isAbsolute(marker)) process.exit(2);
+const stat = fs.readFileSync('/proc/self/stat', 'utf8');
+const cut = stat.lastIndexOf(') ');
+const start = stat.slice(cut + 2).trim().split(/\s+/)[19];
+if (!/^[0-9]+$/.test(start || '')) process.exit(2);
+const record = { pid: process.pid, start, script: path.resolve(process.argv[1]) };
+if (process.env.STUB_DELAY_NO_MARKER === '1') {
+  console.log('fixture delay running without marker');
+} else {
+  const temp = `${marker}.tmp-${process.pid}`;
+  fs.writeFileSync(temp, JSON.stringify(record) + '\n');
+  fs.renameSync(temp, marker);
+}
+setTimeout(() => {}, seconds * 1000);
+NODE
     tar czf "$bundle_out" -C "$fixture" .
     sha256sum "$bundle_out" | awk '{print $1"  bundle.tar.gz"}' > "$bundle_out.sha256"
 }

 RANDOM_SEED=1

+show_live_failure() {
+  ts=$1
+  output=$2
+  if [ -f "$output" ]; then cat "$output" >&2 || echo "unreadable case output: $output" >&2
+  else echo "missing case output: $output" >&2; fi
+  server_log="$work/tmp/deploy-bundle-$ts/.local-server.log"
+  if [ -f "$server_log" ]; then cat "$server_log" >&2 || echo "unreadable local server log: $server_log" >&2
+  else echo "missing local server log: $server_log" >&2; fi
+  deploy_log="$work/data/deploy-$ts.log"
+  if [ -f "$deploy_log" ]; then cat "$deploy_log" >&2 || echo "unreadable deploy log: $deploy_log" >&2
+  else echo "missing deploy log: $deploy_log" >&2; fi
+}
+fail_live() {
+  failed_ts=$1
+  failed_output=$2
+  failed_reason=$3
+  echo "$failed_reason" >&2
+  show_live_failure "$failed_ts" "$failed_output"
+  exit 1
+}
+case_output() {
+  case "$1" in
+    okwait) printf '%s\n' "$work/wait.out" ;;
+    failwait) printf '%s\n' "$work/failwait.out" ;;
+    async1) printf '%s\n' "$work/async.out" ;;
+    cleanup) printf '%s\n' "$work/cleanup.out" ;;
+    *) return 2 ;;
+  esac
+}
+assert_own_server_ready() {
+  ts=$1
+  port=$2
+  extract="$work/tmp/deploy-bundle-$ts"
+  server_log="$extract/.local-server.log"
+  pidfile="$extract/.local-server.pid"
+  if [ ! -f "$server_log" ] ||
+     ! grep -Fxq "READY http://127.0.0.1:$port root=$extract" "$server_log" ||
+     ! grep -Eq '^200 (HEAD|GET) /deploy\.sh$' "$server_log" ||
+     grep -Eq 'EADDRINUSE|ERROR:' "$server_log" ||
+     ! node "$work/cleanup-owned.js" pid "$work" "$pidfile" "$extract/scripts/deploy-local-server.js"; then
+    echo "own loopback readiness failed: $ts port $port" >&2
+    show_live_failure "$ts" "$(case_output "$ts")"
+    return 1
+  fi
+  echo "own loopback readiness: $ts READY on $port"
+}
+assert_stub_completed() {
+  ts=$1
+  port=$2
+  server_log="$work/tmp/deploy-bundle-$ts/.local-server.log"
+  deploy_log="$work/data/deploy-$ts.log"
+  if [ ! -f "$server_log" ] ||
+     ! grep -Eq "^200 (HEAD|GET) /deploy\\.sh\\?fixture_stub=$ts$" "$server_log" ||
+     [ ! -f "$deploy_log" ] ||
+     ! grep -Fq "stub deploy.sh starting against http://127.0.0.1:$port" "$deploy_log" ||
+     ! grep -Fq 'stub deploy.sh confirmed local server reachable' "$deploy_log"; then
+    echo "own tagged stub request proof failed: $ts port $port" >&2
+    show_live_failure "$ts" "$(case_output "$ts")"
+    return 1
+  fi
+  echo "own tagged stub request: $ts confirmed on owned server"
+}
+
+show_child_failure() {
+  child_root=$1
+  for child_file in "$child_root/cleanup.out" \
+      "$child_root/tmp/deploy-bundle-cleanup/.local-server.log" \
+      "$child_root/data/deploy-cleanup.log"; do
+    if [ -f "$child_file" ]; then cat "$child_file" >&2 || echo "unreadable $child_file" >&2
+    else echo "missing $child_file" >&2; fi
+  done
+}
+cleanup_control() {
+  mode=$1
+  expected=$2
+  pathfile="$work/$mode.path"
+  if [ "$mode" = premarker ]; then sleep 40 & canary_pid=$!; fi
+  if DEPLOY_TEST_PREMARKER_CONTROL=0 DEPLOY_TEST_CLEANUP_MODE="$mode" DEPLOY_TEST_WORK_FILE="$pathfile" \
+      sh "$0" >"$work/$mode.out" 2>&1; then result=0; else result=$?; fi
+  if [ ! -s "$pathfile" ]; then
+    retain_parent_work=1
+    echo "$mode work path missing; no owned PID may be inferred" >&2
+    cat "$work/$mode.out" >&2 || echo "$mode output unreadable" >&2
+    return 1
+  fi
+  child_work=$(cat "$pathfile")
+  marker="$child_work/data/cleanup-delay.json"
+  case "$child_work" in /*) : ;; *)
+    retain_parent_work=1
+    echo "$mode non-absolute child work path: $child_work" >&2
+    return 1 ;;
+  esac
+  parent_ownership_error=0
+  if [ "$mode" = premarker ]; then
+    if [ -d "$child_work" ] && [ ! -L "$child_work" ]; then
+      if ! mkdir -p "$child_work/tmp/deploy-bundle-canary" ||
+         ! printf '%s\n' "$canary_pid" > "$child_work/tmp/deploy-bundle-canary/.local-server.pid"; then
+        echo 'premarker canary PID-file setup failed; second cleanup still required' >&2
+        retain_parent_work=1
+        parent_ownership_error=1
+      fi
+    fi
+  fi
+  bad=0
+  [ "$result" -eq "$expected" ] || bad=1
+  [ -d "$child_work" ] || bad=1
+  if [ "$mode" = premarker ]; then
+    grep -Fq 'premarker delay running before forced marker timeout' "$work/$mode.out" || bad=1
+    grep -Fq 'controlled premarker failure after handoff' "$work/$mode.out" || bad=1
+    grep -Fxq 'fixture cleanup: missing marker only; quiescent' "$work/$mode.out" || bad=1
+    [ ! -e "$marker" ] || bad=1
+    bad=1 # the expected missing marker is still a failed ownership oracle
+  else
+    grep -Fq 'fixture cleanup: quiescent; retained for parent' "$work/$mode.out" || bad=1
+    [ -s "$marker" ] || bad=1
+    grep -Fq 'marked delay started before cleanup control' "$work/$mode.out" || bad=1
+    if [ "$bad" -eq 0 ]; then
+      node "$work/cleanup-owned.js" delay-gone "$child_work" "$marker" || bad=1
+      node "$work/cleanup-owned.js" audit "$child_work" "$marker" || bad=1
+      sleep 1 || bad=1
+      node "$work/cleanup-owned.js" delay-gone "$child_work" "$marker" || bad=1
+      node "$work/cleanup-owned.js" audit "$child_work" "$marker" || bad=1
+    fi
+  fi
+  if [ "$bad" -ne 0 ]; then
+    retain_parent_work=1
+    echo "$mode child status=$result, expected=$expected; parent second cleanup: $child_work" >&2
+    cat "$work/$mode.out" >&2 || echo "$mode output unreadable" >&2
+    show_child_failure "$child_work"
+    if node "$work/cleanup-owned.js" cleanup "$child_work" "$marker" >"$work/$mode.second-cleanup.out" 2>&1; then second_rc=0; else second_rc=$?; fi
+    cat "$work/$mode.second-cleanup.out" >&2
+    echo "$mode parent second cleanup exit=$second_rc" >&2
+    if node "$work/cleanup-owned.js" audit "$child_work" >"$work/$mode.second-audit.out" 2>&1; then audit_rc=0; else audit_rc=$?; fi
+    cat "$work/$mode.second-audit.out" >&2
+    echo "$mode parent second audit exit=$audit_rc" >&2
+    if [ "$mode" = premarker ]; then
+      kill -0 "$canary_pid" || { echo 'premarker unrelated canary was killed' >&2; return 1; }
+      echo 'premarker unrelated canary: OK'
+      if ! kill "$canary_pid" 2>/dev/null; then
+        echo 'premarker canary stop failed' >&2
+        parent_ownership_error=1
+      fi
+      wait "$canary_pid" 2>/dev/null || :
+      canary_pid=
+      [ "$parent_ownership_error" -eq 0 ] && [ "$result" -eq 1 ] && [ ! -e "$marker" ] &&
+        grep -Fxq 'fixture cleanup: missing marker only; quiescent' "$work/$mode.out" &&
+        [ "$second_rc" -eq 1 ] &&
+        grep -Fxq 'fixture cleanup: missing marker only; quiescent' "$work/$mode.second-cleanup.out" &&
+        [ "$audit_rc" -eq 0 ] &&
+        grep -Fxq 'fixture audit: quiescent' "$work/$mode.second-audit.out" &&
+        grep -Eq 'fixture sweep: signaled [0-9]+/[0-9]+/delay SIGTERM' "$work/$mode.out" "$work/$mode.second-cleanup.out" || return 1
+      echo "premarker cleanup control: expected uncertainty retained $child_work" >&2
+      return 19
+    fi
+    echo "failed cleanup control retained $child_work" >&2
+    return 1
+  fi
+  rm -rf "$child_work" || { echo "cannot remove verified $child_work" >&2; exit 1; }
+  echo "$mode cleanup control: OK"
+}
+
+node - <<'NODE'
+const net = require('node:net');
+const ports = [18761, 18762, 18763, 18764];
+function check() {
+  const port = ports.shift();
+  if (port === undefined) return;
+  const server = net.createServer();
+  server.once('error', error => {
+    console.error(`port ${port} unavailable: ${error.code || error.message}`);
+    process.exitCode = 1;
+  });
+  server.listen(port, '127.0.0.1', () => server.close(check));
+}
+check();
+NODE
+
+case "${DEPLOY_TEST_CLEANUP_MODE:-}" in
+  assertion|term|premarker)
+    STUB_DELAY_MARKER="$work/data/cleanup-delay.json"
+    export STUB_DELAY_MARKER
+    mkdir -p "$work/data"
+    build_bundle 0 "$work/cleanup.tar.gz"
+    no_marker=0
+    [ "$DEPLOY_TEST_CLEANUP_MODE" != premarker ] || no_marker=1
+    if STUB_DELAY_SECONDS=20 STUB_DELAY_NO_MARKER="$no_marker" STUB_REQUEST_TAG="cleanup" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
+       DEPLOY_OFFLINE_LOG_DIR="$work/data" DEPLOY_OFFLINE_TS="cleanup" \
+       sh "$offline" "$work/cleanup.tar.gz" --port 18764 >"$work/cleanup.out" 2>&1; then
+      assert_own_server_ready cleanup 18764 || exit 1
+    else
+      show_live_failure cleanup "$work/cleanup.out"
+      exit 1
+    fi
+    if [ "$DEPLOY_TEST_CLEANUP_MODE" = premarker ]; then
+      waited=0
+      while ! grep -Fq 'fixture delay running without marker' "$work/data/deploy-cleanup.log" 2>/dev/null; do
+        waited=$((waited + 1))
+        [ "$waited" -le 5 ] || fail_live cleanup "$work/cleanup.out" 'premarker delay did not start'
+        sleep 1 || fail_live cleanup "$work/cleanup.out" 'premarker wait interrupted'
+      done
+      [ ! -e "$STUB_DELAY_MARKER" ] || fail_live cleanup "$work/cleanup.out" 'premarker marker unexpectedly exists'
+      echo 'premarker delay running before forced marker timeout'
+      fail_live cleanup "$work/cleanup.out" 'controlled premarker failure after handoff'
+    fi
+    waited=0
+    while [ ! -s "$STUB_DELAY_MARKER" ]; do
+      waited=$((waited + 1))
+      [ "$waited" -le 5 ] || fail_live cleanup "$work/cleanup.out" 'marked delay never started'
+      sleep 1 || fail_live cleanup "$work/cleanup.out" 'marked delay wait interrupted'
+    done
+    node "$work/cleanup-owned.js" delay-live "$work" "$STUB_DELAY_MARKER" ||
+      fail_live cleanup "$work/cleanup.out" 'marked delay identity check failed'
+    echo 'marked delay started before cleanup control'
+    if [ "$DEPLOY_TEST_CLEANUP_MODE" = assertion ]; then exit 23; fi
+    kill -TERM "$$"
+    exit 99
+    ;;
+  '') ;;
+  *) echo 'invalid DEPLOY_TEST_CLEANUP_MODE' >&2; exit 2 ;;
+esac
+
+mkdir -p "$work/tmp/deploy-bundle-canary"
+sleep 20 &
+canary_pid=$!
+printf '%s\n' "$canary_pid" > "$work/tmp/deploy-bundle-canary/.local-server.pid"
+node "$work/cleanup-owned.js" audit "$work"
+kill -0 "$canary_pid" || { echo 'cleanup killed unrelated canary' >&2; exit 1; }
+echo 'unrelated-process canary: OK'
+kill "$canary_pid" 2>/dev/null || :
+wait "$canary_pid" 2>/dev/null || :
+canary_pid=
+rm -rf "$work/tmp/deploy-bundle-canary"
+
+if [ "${DEPLOY_TEST_PREMARKER_CONTROL:-0}" = 1 ]; then cleanup_control premarker 1; exit 99; fi
+
 echo "=== missing bundle fails clearly ==="
 if sh "$offline" "$work/does-not-exist.tar.gz" 2>"$work/err.log"; then
     echo "expected failure for a missing bundle" >&2
@@ -57,63 +535,79 @@

 echo "=== successful deploy, --wait mode, returns deploy.sh's exit code ==="
 build_bundle 0 "$work/good.tar.gz"
-DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
-DEPLOY_OFFLINE_LOG_DIR="$work/data" \
-DEPLOY_OFFLINE_TS="okwait" \
-    sh "$offline" "$work/good.tar.gz" --port 18761 --wait > "$work/wait.out" 2>&1
-rc=$?
-[ "$rc" = "0" ] || { echo "expected exit 0, got $rc" >&2; cat "$work/wait.out" >&2; exit 1; }
-[ -f "$work/data/deploy-okwait.log" ] || { echo "missing deploy log" >&2; exit 1; }
-grep -q "stub deploy.sh confirmed local server reachable" "$work/data/deploy-okwait.log"
-echo "OK"
-
-echo "=== local server is stopped after --wait completes ==="
-sleep 1
-if wget -q -O /dev/null --spider "http://127.0.0.1:18761/deploy.sh" 2>/dev/null; then
-    echo "expected local server to be stopped after deploy.sh finished" >&2
-    exit 1
+if STUB_REQUEST_TAG="okwait" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" DEPLOY_OFFLINE_LOG_DIR="$work/data" \
+   DEPLOY_OFFLINE_TS="okwait" sh "$offline" "$work/good.tar.gz" --port 18761 --wait \
+   >"$work/wait.out" 2>&1; then rc=0; else rc=$?; fi
+if [ "$rc" -ne 0 ]; then
+  echo "expected exit 0, got $rc" >&2
+  show_live_failure okwait "$work/wait.out"
+  exit 1
+fi
+assert_own_server_ready okwait 18761 || exit 1
+assert_stub_completed okwait 18761 || exit 1
+[ -f "$work/data/deploy-okwait.log" ] || fail_live okwait "$work/wait.out" 'missing deploy log'
+grep -Fq 'stub deploy.sh confirmed local server reachable' "$work/data/deploy-okwait.log" ||
+  fail_live okwait "$work/wait.out" 'stub confirmation missing'
+node "$work/cleanup-owned.js" audit "$work" || fail_live okwait "$work/wait.out" 'okwait cleanup audit failed'
+sleep 1 || fail_live okwait "$work/wait.out" 'okwait shutdown wait interrupted'
+if wget -q -O /dev/null --spider 'http://127.0.0.1:18761/deploy.sh' 2>/dev/null; then
+  fail_live okwait "$work/wait.out" 'okwait server still answering'
 fi
 echo "OK"

 echo "=== failing deploy.sh propagates a nonzero exit code under --wait ==="
 build_bundle 7 "$work/fail.tar.gz"
-set +e
-DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
-DEPLOY_OFFLINE_LOG_DIR="$work/data" \
-DEPLOY_OFFLINE_TS="failwait" \
-    sh "$offline" "$work/fail.tar.gz" --port 18762 --wait > "$work/failwait.out" 2>&1
-rc=$?
-set -e
-[ "$rc" = "7" ] || { echo "expected exit 7, got $rc" >&2; cat "$work/failwait.out" >&2; exit 1; }
+if STUB_REQUEST_TAG="failwait" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" DEPLOY_OFFLINE_LOG_DIR="$work/data" \
+   DEPLOY_OFFLINE_TS="failwait" sh "$offline" "$work/fail.tar.gz" --port 18762 --wait \
+   >"$work/failwait.out" 2>&1; then rc=0; else rc=$?; fi
+if [ "$rc" -ne 7 ]; then
+  echo "expected exit 7, got $rc" >&2
+  show_live_failure failwait "$work/failwait.out"
+  exit 1
+fi
+assert_own_server_ready failwait 18762 || exit 1
+assert_stub_completed failwait 18762 || exit 1
+node "$work/cleanup-owned.js" audit "$work" || fail_live failwait "$work/failwait.out" 'failwait cleanup audit failed'
+sleep 1 || fail_live failwait "$work/failwait.out" 'failwait shutdown wait interrupted'
+if wget -q -O /dev/null --spider 'http://127.0.0.1:18762/deploy.sh' 2>/dev/null; then
+  fail_live failwait "$work/failwait.out" 'failwait server still answering'
+fi
 echo "OK"

 echo "=== fire-and-forget mode returns immediately, deploy finishes async, server stops ==="
 build_bundle 0 "$work/async.tar.gz"
-start_ts=$(date +%s)
-DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
-DEPLOY_OFFLINE_LOG_DIR="$work/data" \
-DEPLOY_OFFLINE_TS="async1" \
-    sh "$offline" "$work/async.tar.gz" --port 18763 > "$work/async.out" 2>&1
-rc=$?
-end_ts=$(date +%s)
-[ "$rc" = "0" ] || { echo "expected fire-and-forget hand-off to exit 0, got $rc" >&2; cat "$work/async.out" >&2; exit 1; }
+start_ts=$(date +%s) || fail_live async1 "$work/async.out" 'async start clock failed'
+if STUB_REQUEST_TAG="async1" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" DEPLOY_OFFLINE_LOG_DIR="$work/data" \
+   DEPLOY_OFFLINE_TS="async1" sh "$offline" "$work/async.tar.gz" --port 18763 \
+   >"$work/async.out" 2>&1; then rc=0; else rc=$?; fi
+end_ts=$(date +%s) || fail_live async1 "$work/async.out" 'async end clock failed'
+if [ "$rc" -ne 0 ]; then
+  echo "expected async handoff exit 0, got $rc" >&2
+  show_live_failure async1 "$work/async.out"
+  exit 1
+fi
+assert_own_server_ready async1 18763 || exit 1
 elapsed=$((end_ts - start_ts))
-[ "$elapsed" -lt 10 ] || { echo "fire-and-forget mode took too long ($elapsed s); should return immediately after hand-off" >&2; exit 1; }
-grep -q 'Follow it with: tail -f' "$work/async.out"
-echo "OK: returned in ${elapsed}s"
-
-echo "waiting for the detached deploy to finish..."
+[ "$elapsed" -lt 10 ] || fail_live async1 "$work/async.out" "async handoff took ${elapsed}s"
+grep -Fq 'Follow it with: tail -f' "$work/async.out" ||
+  fail_live async1 "$work/async.out" 'async handoff hint missing'
 waited=0
-while [ ! -f "$work/data/deploy-async1.log" ] || ! grep -q 'confirmed local server reachable' "$work/data/deploy-async1.log" 2>/dev/null; do
-    waited=$((waited + 1))
-    [ "$waited" -lt 20 ] || { echo "detached deploy never completed" >&2; exit 1; }
-    sleep 1
+while [ ! -f "$work/data/deploy-async1.log" ] ||
+      ! grep -Fq 'stub deploy.sh confirmed local server reachable' "$work/data/deploy-async1.log" 2>/dev/null; do
+  waited=$((waited + 1))
+  [ "$waited" -lt 20 ] || fail_live async1 "$work/async.out" 'async stub completion timed out'
+  sleep 1 || fail_live async1 "$work/async.out" 'async completion wait interrupted'
 done
-sleep 1
-if wget -q -O /dev/null --spider "http://127.0.0.1:18763/deploy.sh" 2>/dev/null; then
-    echo "expected local server to be stopped once the detached deploy finished" >&2
-    exit 1
+assert_stub_completed async1 18763 || exit 1
+sleep 1 || fail_live async1 "$work/async.out" 'async shutdown wait interrupted'
+if wget -q -O /dev/null --spider 'http://127.0.0.1:18763/deploy.sh' 2>/dev/null; then
+  fail_live async1 "$work/async.out" 'async server still answering'
 fi
+echo 'offline direct exits: wait=0 failwait=7 async=0'
+node "$work/cleanup-owned.js" audit "$work" || fail_live async1 "$work/async.out" 'async cleanup audit failed'
 echo "OK"

+cleanup_control assertion 23
+cleanup_control term 143
+
 echo "deploy-offline.test: OK"
````

### Workflow

Two independent jobs run on every pull request to `main` or `master`, each
with a five-minute limit and read-only contents permission. The dash lane uses
the Ubuntu runner; the ash lane uses the `node:22-alpine` container and
installs its tools before checkout so `git` is present. Each lane proves
`/bin/sh` is its target shell, prints every tool path, then runs both tests
directly and the pre-marker control. All mappings are block mappings and no
step uses `sh -c`, because the inventory parser rejects both.

````diff
--- /dev/null
+++ b/.github/workflows/deploy-bundle-shells.yml
@@ -0,0 +1,104 @@
+name: Deploy bundle shell fixtures
+on:
+  pull_request:
+    branches: [main, master]
+jobs:
+  dash:
+    runs-on: ubuntu-latest
+    timeout-minutes: 5
+    permissions:
+      contents: read
+    steps:
+      - uses: actions/checkout@v4
+        with:
+          persist-credentials: false
+      - uses: actions/setup-node@v4
+        with:
+          node-version: '22'
+      - name: Check dash fixture prerequisites
+        run: |
+          set -eu
+          test "$(readlink -f /bin/sh)" = "$(command -v dash)"
+          echo "/bin/sh -> $(readlink -f /bin/sh)"
+          for tool in bash node tar sha256sum wget setsid awk df tail date mktemp cmp grep cut head wc tr seq stat sleep; do
+            tool_path=$(command -v "$tool") || { echo "missing $tool" >&2; exit 127; }
+            echo "$tool=$tool_path"
+          done
+          node --version
+      - name: Bundle upload and offline fixtures under dash
+        env:
+          DEPLOY_TEST_EXPECT_SH: dash
+        run: |
+          set -eu
+          sh scripts/deploy-push-bundle.test.sh
+          sh scripts/deploy-offline.test.sh
+          premarker_log=$(mktemp)
+          if DEPLOY_TEST_PREMARKER_CONTROL=1 sh scripts/deploy-offline.test.sh >"$premarker_log" 2>&1; then
+            cat "$premarker_log"
+            echo 'premarker control unexpectedly passed' >&2
+            exit 1
+          else
+            premarker_rc=$?
+          fi
+          cat "$premarker_log"
+          [ "$premarker_rc" -eq 19 ] || exit 1
+          grep -Fq 'premarker delay running before forced marker timeout' "$premarker_log"
+          grep -Fq 'premarker child status=1, expected=1' "$premarker_log"
+          [ "$(grep -Fxc 'fixture cleanup: missing marker only; quiescent' "$premarker_log")" -eq 2 ] || exit 1
+          grep -Fq 'premarker parent second cleanup exit=1' "$premarker_log"
+          grep -Fq 'premarker parent second audit exit=0' "$premarker_log"
+          grep -Fxq 'fixture audit: quiescent' "$premarker_log"
+          grep -Eq 'fixture sweep: signaled [0-9]+/[0-9]+/delay SIGTERM' "$premarker_log"
+          grep -Fq 'premarker unrelated canary: OK' "$premarker_log"
+          grep -Fq 'premarker cleanup control: expected uncertainty retained' "$premarker_log"
+          rm -f "$premarker_log"
+  ash:
+    runs-on: ubuntu-latest
+    container: node:22-alpine
+    timeout-minutes: 5
+    permissions:
+      contents: read
+    steps:
+      - name: Install fixture prerequisites
+        run: apk add --no-cache bash coreutils util-linux wget tar git
+      - uses: actions/checkout@v4
+        with:
+          persist-credentials: false
+      - name: Check ash fixture prerequisites
+        run: |
+          set -eu
+          busybox --list | grep -qx ash
+          test "$(readlink -f /bin/sh)" = "$(command -v busybox)"
+          echo "/bin/sh -> $(readlink -f /bin/sh)"
+          for tool in bash node tar sha256sum wget setsid awk df tail date mktemp cmp grep cut head wc tr seq stat sleep; do
+            tool_path=$(command -v "$tool") || { echo "missing $tool" >&2; exit 127; }
+            echo "$tool=$tool_path"
+          done
+          node --version
+      - name: Bundle upload and offline fixtures under ash
+        env:
+          DEPLOY_TEST_EXPECT_SH: ash
+        run: |
+          set -eu
+          sh scripts/deploy-push-bundle.test.sh
+          sh scripts/deploy-offline.test.sh
+          premarker_log=$(mktemp)
+          if DEPLOY_TEST_PREMARKER_CONTROL=1 sh scripts/deploy-offline.test.sh >"$premarker_log" 2>&1; then
+            cat "$premarker_log"
+            echo 'premarker control unexpectedly passed' >&2
+            exit 1
+          else
+            premarker_rc=$?
+          fi
+          cat "$premarker_log"
+          [ "$premarker_rc" -eq 19 ] || exit 1
+          grep -Fq 'premarker delay running before forced marker timeout' "$premarker_log"
+          grep -Fq 'premarker child status=1, expected=1' "$premarker_log"
+          [ "$(grep -Fxc 'fixture cleanup: missing marker only; quiescent' "$premarker_log")" -eq 2 ] || exit 1
+          grep -Fq 'premarker parent second cleanup exit=1' "$premarker_log"
+          grep -Fq 'premarker parent second audit exit=0' "$premarker_log"
+          grep -Fxq 'fixture audit: quiescent' "$premarker_log"
+          grep -Eq 'fixture sweep: signaled [0-9]+/[0-9]+/delay SIGTERM' "$premarker_log"
+          grep -Fq 'premarker unrelated canary: OK' "$premarker_log"
+          grep -Fq 'premarker cleanup control: expected uncertainty retained' "$premarker_log"
+          rm -f "$premarker_log"
````

### Inventory

Delete exactly the two #390 objects. Every other object, including the two
`slow (#391)` objects, stays byte-identical.

````diff
--- a/scripts/verify-test-inventory.json
+++ b/scripts/verify-test-inventory.json
@@ -78,14 +78,6 @@
       "reason": "needs a production GUI build (web/react-gui/build/index.html); all 16 tests fail without one, and CI builds no GUI"
     },
     {
-      "path": "scripts/deploy-push-bundle.test.sh",
-      "reason": "fails on main under CI's /bin/sh (dash) (#390): the test starts the bash script deploy-push-bundle.sh with sh, which stops at its first array (Syntax error: \"(\" unexpected); passes only where sh is bash"
-    },
-    {
-      "path": "scripts/deploy-offline.test.sh",
-      "reason": "needs BusyBox ash, wget and setsid as on the gateway (#390; run it in a node:22-alpine container, see its header); fails under dash"
-    },
-    {
       "path": "scripts/test-valve-schedule-timestamp-wire-format.js",
       "reason": "slow (#391): passes (32/32) but took about 17 minutes locally, a full migration replay per case through the sqlite3 CLI; too slow for a per-pull-request gate until it gets a faster fixture or a decided lane"
     },
````

After all four diffs, the files have these SHA-256 values:

| Path | After |
|---|---|
| `scripts/deploy-push-bundle.test.sh` | `085c2191922cdbd3d18c05594be214f5d6d4de3f406c20a43571067527b3d82e` |
| `scripts/deploy-offline.test.sh` | `318b527093e9501caf0c8af704a1ab951a08c39c5b519aaa4b8fdcf702edb6a7` |
| `.github/workflows/deploy-bundle-shells.yml` | `4b1c2ea1f51d41698a2f56805e6b54e64e17cd6467657dbd055db54d97733735` |
| `scripts/verify-test-inventory.json` | `dada014ee67d6b89a8f5c0d4bdd6205f86a8c93ba7e5f93a1949ad1267a6bb4a` |

## Placement choices

The accepted design gave literal code for every block but left some ordering
in prose. This plan fixes it as follows. The stale-PID canary runs after the
special cleanup-mode branch and before the pre-marker dispatch. The canary
leaves `$work/tmp` in place, and the parent's own EXIT-trap sweep records an
error when that directory is missing. With any other order, the pre-marker
parent would end with status 1 instead of the expected 19.

The offline test keeps its three live-case headers, an `OK` line after each
case and the final sentinel. The base lines `=== local server is stopped
after --wait completes ===`, `OK: returned in ${elapsed}s` and `waiting for
the detached deploy to finish...` are gone, because the reviewed blocks that
replace those checks stay contiguous. No oracle reads those lines.

## Local gates

Run every command from the repository root of an isolated worktree. Record
the command, the direct exit status and complete output. "Structural" means
a deliberate failure that proves a gate is live; "setup" means a missing
prerequisite, which is neither a pass nor a product failure.

| Step | Command | Expected |
|---|---|---|
| Baseline inventory | `node scripts/verify-test-inventory.js` | Exit 0, `verify-test-inventory: OK (926 test files: 751 run by workflow steps, 6 run through a listed runner, 169 excluded with a reason; 260 steps in 11 workflows)` (measured at W) |
| Baseline inventory tests | `node --test scripts/verify-test-inventory.test.js scripts/run-module-tests.test.js` | Exit 0 |
| Baseline uploader | `sh scripts/deploy-push-bundle.test.sh` | Where `sh` is Bash: exit 0 and `deploy-push-bundle.test: OK`; not a reproduction |
| Target shells | `command -v dash`, `command -v busybox` | If both are absent, record a setup refusal and run no shell-specific red step |
| Inventory half (deletion only) | apply the inventory diff, run the verifier | Structural: exit 1, `FAIL (2 problems)`, one `no workflow runs this test` line for each of the two paths |
| Workflow half (workflow only) | restore the JSON, apply the workflow diff, run the verifier | Structural: exit 1, `FAIL (2 problems)`, one `excluded but a workflow runs it` line for each path |
| Both halves | apply both, run the verifier | Exit 0, `OK (926 test files: 753 run by workflow steps, 6 run through a listed runner, 167 excluded with a reason; 268 steps in 12 workflows)` (forecast) |
| Inventory tests | `node --test scripts/verify-test-inventory.test.js scripts/run-module-tests.test.js` | Exit 0 |
| Uploader | `sh scripts/deploy-push-bundle.test.sh` | Exit 0, sentinel, no `wrong-interpreter control` line |
| Non-target shell | `env DEPLOY_TEST_EXPECT_SH=dash sh scripts/deploy-push-bundle.test.sh` | Where `sh` is Bash, structural: exit 1, `wrong-interpreter control unexpectedly passed` |
| Bad selector | `env DEPLOY_TEST_EXPECT_SH=zsh sh scripts/deploy-push-bundle.test.sh` | Structural: exit 2, `DEPLOY_TEST_EXPECT_SH must be dash or ash` |
| Offline parse | `sh -n scripts/deploy-offline.test.sh` | Exit 0; parse only |
| Helper syntax | extract both heredoc bodies, `node --check` each | SHA-256 of the extracted helper body `60bdd3a82aa07177783d15e6621169d964c5702817836344602e49886462acfb` and delay body `449c1dd225a00d1db62d1a90e1d5afa2d4177533631abe992ce09fc54bd7cca5`; exit 0 |
| Hygiene | `git diff --check`, `node scripts/verify-doc-hygiene.js` | Exit 0 |

The forecast counts assume the base is still W. A merged #551 adds two run
tests and removes two exclusions; recompute rather than reuse these numbers.

Where dash or BusyBox exists locally, a behavioural red step is possible
before the uploader diff: put a directory whose `sh` links to that shell first
in `PATH` and run the unchanged uploader test. It should fail at the first
normal upload with the shell's diagnostic. Without such a shell, the CI
wrong-interpreter control is the first reproduction: at the candidate head it
starts the uploader with the lane's `sh`, which is the old dispatch.

## CI qualification

Both jobs must exit 0 at the exact candidate SHA, and each job log must show:

- a `/bin/sh ->` line naming dash (dash lane) or busybox (ash lane), a path
  for every listed tool and the Node version;
- `wrong-interpreter control: OK`, then the six uploader sections, each
  ending in `OK`, and `deploy-push-bundle.test: OK`;
- `unrelated-process canary: OK`, before the missing-bundle and SHA-mismatch
  `OK` lines;
- `own loopback readiness` and `own tagged stub request` lines for `okwait`,
  `failwait` and `async1`, then `offline direct exits: wait=0 failwait=7
  async=0`;
- `assertion cleanup control: OK`, `term cleanup control: OK` and
  `deploy-offline.test: OK`;
- for the pre-marker run, status 19 and every line the workflow step greps.

Record the runner image, the container image digest the log reports, and the
shell versions. Neither image is pinned here, so a later run may use different
shells. A bind failure on a fixed port is a setup failure, not a product
result. A hard KILL bypasses the shell traps; runner teardown and the job
limit are that boundary.

## Unresolved qualification

- The wrong-interpreter regex is a forecast for both shells. Dash without
  `pipefail` support stops at the `set` line; a dash with it, or BusyBox ash,
  is expected to stop at `BASH_SOURCE[0]` or the first array.
- Alpine package names, BusyBox applets, the GNU or BusyBox `wget` request
  method and the readiness log line are unqualified.
- Process cleanup behaviour, including watcher forks, zombie handling under a
  container's PID 1 and the seven-second bound, is a source design until CI
  logs show it.
- The issue stays open until the exact head passes both lanes, the inventory
  gates and independent review.
