#!/bin/sh
# Exercises deploy-offline.sh against a generated deploy.sh stub (the real
# deploy.sh assumes a live gateway: /etc/init.d, uci, opkg, sqlite3,
# identityd) and the real deploy-local-server.js on 127.0.0.1. No SSH,
# gateway or real deployment is involved.
#
# This is a POSIX sh test driver. CI runs it in two lanes whose /bin/sh is
# dash or BusyBox ash (.github/workflows/deploy-bundle-shells.yml); it starts
# deploy-offline.sh, and that script starts its detached watcher, with the
# lane's sh. Prerequisites: node, tar, sha256sum, wget, setsid, awk, df,
# tail, date, mktemp and ordinary shell utilities. Ports 18761-18764 on
# 127.0.0.1 must be free; an occupied port is a setup failure.
#
# DEPLOY_TEST_CLEANUP_MODE and DEPLOY_TEST_PREMARKER_CONTROL select the
# cleanup controls; ordinary runs leave both unset.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
offline="$script_dir/deploy-offline.sh"
server_js="$script_dir/deploy-local-server.js"

work=$(mktemp -d)
work=$(CDPATH= cd -- "$work" && pwd -P)
[ -z "${DEPLOY_TEST_WORK_FILE:-}" ] || printf '%s\n' "$work" > "$DEPLOY_TEST_WORK_FILE"
canary_pid=
retain_parent_work=0
cat > "$work/cleanup-owned.js" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2];
const work = path.resolve(process.argv[3]);
const prefix = `${work}/tmp/deploy-bundle-`;
const logPrefix = `${work}/data/deploy-`;
const errors = [];
let markerMissing = false;
const known = new Map();
if (!['cleanup', 'audit', 'pid', 'delay-live', 'delay-gone'].includes(mode) || !path.isAbsolute(process.argv[3])) process.exit(2);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function classify(args) {
  const exe = path.basename(args[0] || '');
  if (['node', 'nodejs'].includes(exe) && args.some(a => a.startsWith(prefix) && a.endsWith('/scripts/deploy-local-server.js'))) return 'server';
  if (['node', 'nodejs'].includes(exe) && args.some(a => a.startsWith(prefix) && a.endsWith('/scripts/fixture-delay.js'))) return 'delay';
  if (['sh', 'dash', 'ash', 'busybox', 'setsid'].includes(exe) && args.some(a => a.includes(prefix) && a.includes('/deploy.sh'))) return 'watcher-or-stub';
  if (exe === 'tail' && args.some(a => a.startsWith(logPrefix) && a.endsWith('.log'))) return 'log-tail';
  return null;
}
function read(pid, required = false) {
  if (!/^[1-9][0-9]*$/.test(String(pid))) return null;
  let args;
  try {
    args = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null;
    if (required) errors.push(`known PID ${pid}: cmdline: ${e.message}`);
    return null; // unreadable unrelated /proc entry is not an owned process
  }
  const kind = classify(args);
  if (!kind && !required) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const cut = stat.lastIndexOf(') ');
    if (cut < 0) throw new Error('bad proc stat');
    const state = stat.slice(cut + 2).trim().split(/\s+/)[0];
    if (state === 'Z' || state === 'X') return null; // exited, awaiting reaping
    const start = stat.slice(cut + 2).trim().split(/\s+/)[19]; // field 22
    if (!/^[0-9]+$/.test(start || '')) throw new Error('bad startticks');
    const statAgain = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const cutAgain = statAgain.lastIndexOf(') ');
    const startAgain = statAgain.slice(cutAgain + 2).trim().split(/\s+/)[19];
    if (start !== startAgain) throw new Error('PID changed during read');
    return { pid: Number(pid), start, args: args.join('\0'), kind };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null;
    errors.push(`known/identified PID ${pid}: stat: ${e.message}`);
    return null;
  }
}
function delayRecord(file, duringSweep = false) {
  if (!file) return null;
  try {
    if (file !== `${work}/data/cleanup-delay.json`) throw new Error(`marker outside owned work: ${file}`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = `${work}/tmp/deploy-bundle-cleanup/scripts/fixture-delay.js`;
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        !/^[0-9]+$/.test(record.start || '') || record.script !== expected) {
      throw new Error(`invalid delay marker: ${file}`);
    }
    return record;
  } catch (e) {
    if (!duringSweep) throw e;
    if (e.code === 'ENOENT') {
      markerMissing = true; // expected only in the deliberate pre-marker control
      return null;
    }
    const message = `delay marker uncertainty: ${file}: ${e.message}`;
    if (!errors.includes(message)) errors.push(message);
    return null; // unreadable/malformed marker is an additional ownership error
  }
}
function candidates() {
  let procEntries = [];
  try { procEntries = fs.readdirSync('/proc'); }
  catch (e) { errors.push(`/proc enumeration: ${e.message}`); }
  const ids = new Set([...procEntries.filter(x => /^[1-9][0-9]*$/.test(x)), ...known.keys()]);
  const required = new Set(known.keys());
  const tmp = `${work}/tmp`;
  let fixtureDirs = [];
  try { fixtureDirs = fs.readdirSync(tmp); }
  catch (e) { errors.push(`owned fixture directory ${tmp}: ${e.message}`); }
  for (const dir of fixtureDirs) {
    if (!dir.startsWith('deploy-bundle-')) continue;
    const extract = `${tmp}/${dir}`;
    let ownedFiles = [];
    try { ownedFiles = fs.readdirSync(extract); }
    catch (e) {
      errors.push(`owned fixture directory ${extract}: ${e.message}`);
      continue; // other fixtures and unique-path /proc candidates remain discoverable
    }
    if (!ownedFiles.includes('.local-server.pid')) continue;
    const file = `${extract}/.local-server.pid`;
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (/^[1-9][0-9]*$/.test(value)) { ids.add(value); required.add(value); }
      else errors.push(`owned PID file ${file}: invalid PID`);
    } catch (e) {
      errors.push(`owned PID file ${file}: ${e.message}`);
      // Never infer or signal a PID from this file; scan unique argv instead.
    }
  }
  const marker = delayRecord(process.argv[4], true);
  if (marker) { ids.add(String(marker.pid)); required.add(String(marker.pid)); }
  const found = [];
  for (const id of ids) {
    const item = read(id, required.has(id));
    const old = known.get(id);
    if (old && item && item.start === old.start &&
        (item.kind !== old.kind || item.args !== old.args)) errors.push(`known PID ${id}: identity changed`);
    if (marker && Number(id) === marker.pid && item && item.start === marker.start &&
        (item.kind !== 'delay' || !item.args.includes(marker.script))) errors.push(`delay PID ${id}: marker identity changed`);
    if (item && item.kind) { known.set(id, item); found.push(item); }
  }
  return found;
}
function signal(candidate, name) {
  const now = read(candidate.pid, true); // immediately before the signal
  if (!now) return;
  if (now.start !== candidate.start || now.args !== candidate.args || now.kind !== candidate.kind) {
    errors.push(`PID ${candidate.pid}: identity changed before ${name}`);
    return;
  }
  try {
    process.kill(candidate.pid, name);
    console.log(`fixture sweep: signaled ${candidate.pid}/${candidate.start}/${candidate.kind} ${name}`);
  }
  catch (e) { if (e.code !== 'ESRCH') errors.push(`PID ${candidate.pid}: ${name}: ${e.message}`); }
}
async function sweep() {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < 7000) {
    const live = candidates();
    if (live.length === 0) {
      quiet += 1;
      if (quiet === 3) break; // three scans 250 ms apart; catches watcher forks
    } else {
      quiet = 0;
      if (mode === 'cleanup') for (const item of live) signal(item, Date.now() - started < 2000 ? 'SIGTERM' : 'SIGKILL');
    }
    await pause(250);
  }
  const remaining = candidates();
  if (quiet < 3 || remaining.length) errors.push(`not quiescent: ${remaining.map(x => `${x.pid}/${x.start}/${x.kind}`).join(', ')}`);
  for (const error of errors) console.error(`fixture cleanup uncertainty: ${error}`);
  if (errors.length) process.exitCode = 1;
  else if (markerMissing) {
    console.error('fixture cleanup: missing marker only; quiescent');
    process.exitCode = 1;
  }
  else console.log(`fixture ${mode}: quiescent`);
}
if (mode === 'pid') {
  const file = process.argv[4];
  const expected = process.argv[5];
  const extract = path.dirname(path.dirname(expected));
  if (!extract.startsWith(prefix) || file !== `${extract}/.local-server.pid` || !fs.existsSync(file)) process.exit(1);
  const pid = fs.readFileSync(file, 'utf8').trim();
  if (!/^[1-9][0-9]*$/.test(pid)) process.exit(1);
  const live = read(pid, true);
  if (errors.length) { for (const error of errors) console.error(error); process.exit(1); }
  if (live && (live.kind !== 'server' || !live.args.includes(expected))) process.exit(1);
  console.log(`fixture PID ${pid}: ${live ? `server startticks ${live.start}` : 'already exited'}`);
} else if (mode === 'delay-live' || mode === 'delay-gone') {
  try {
    const marker = delayRecord(process.argv[4]);
    if (!marker) throw new Error('delay marker required');
    const live = read(marker.pid, true);
    if (errors.length) throw new Error(errors.join('; '));
    const same = live && live.start === marker.start && live.kind === 'delay' && live.args.includes(marker.script);
    if (live && live.start === marker.start && !same) throw new Error('known delay PID changed identity');
    if (mode === 'delay-live' && !same) throw new Error('marked delay not live');
    if (mode === 'delay-gone' && same) throw new Error('marked delay still live');
    console.log(`marked delay ${marker.pid}/${marker.start}: ${mode === 'delay-live' ? 'live' : 'gone'}`);
  } catch (e) { console.error(`fixture delay uncertainty: ${e.message}`); process.exitCode = 1; }
} else sweep().catch(e => { console.error(`fixture cleanup uncertainty: ${e.message}`); process.exitCode = 1; });
NODE
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ -n "$canary_pid" ]; then
    kill "$canary_pid" 2>/dev/null || :
    wait "$canary_pid" 2>/dev/null || :
  fi
  if node "$work/cleanup-owned.js" cleanup "$work" "${STUB_DELAY_MARKER:-}"; then
    case "${DEPLOY_TEST_CLEANUP_MODE:-}" in
      assertion|term|premarker) echo "fixture cleanup: quiescent; retained for parent: $work" ;;
      *)
        if [ "${DEPLOY_TEST_PREMARKER_CONTROL:-0}" = 1 ] || [ "$retain_parent_work" = 1 ]; then
          echo "test parent work retained: $work"
        else
          rm -rf "$work" || result=1
        fi
        ;;
    esac
  else
    echo "fixture cleanup failed; retained $work" >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_bundle() {
    exit_code="$1"
    bundle_out="$2"
    fixture="$work/fixture-$$-$RANDOM_SEED"
    RANDOM_SEED=$((RANDOM_SEED + 1))
    mkdir -p "$fixture/scripts"
    cp "$server_js" "$fixture/scripts/deploy-local-server.js"
    cat > "$fixture/deploy.sh" <<EOF
#!/bin/sh
set -eu
port="\$1"
base="http://127.0.0.1:\$port"
echo "stub deploy.sh starting against \$base"
: "\${STUB_REQUEST_TAG:?}"
wget -q -O /dev/null --spider "\$base/deploy.sh?fixture_stub=\$STUB_REQUEST_TAG"
echo "stub deploy.sh confirmed local server reachable"
if [ "\${STUB_DELAY_SECONDS:-0}" -gt 0 ]; then
    node "\$(dirname "\$0")/scripts/fixture-delay.js" "\$STUB_DELAY_SECONDS"
fi
exit $exit_code
EOF
    cat > "$fixture/scripts/fixture-delay.js" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const seconds = Number(process.argv[2]);
const marker = process.env.STUB_DELAY_MARKER;
if (seconds !== 20 || !marker || !path.isAbsolute(marker)) process.exit(2);
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const cut = stat.lastIndexOf(') ');
const start = stat.slice(cut + 2).trim().split(/\s+/)[19];
if (!/^[0-9]+$/.test(start || '')) process.exit(2);
const record = { pid: process.pid, start, script: path.resolve(process.argv[1]) };
if (process.env.STUB_DELAY_NO_MARKER === '1') {
  console.log('fixture delay running without marker');
} else {
  const temp = `${marker}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(record) + '\n');
  fs.renameSync(temp, marker);
}
setTimeout(() => {}, seconds * 1000);
NODE
    tar czf "$bundle_out" -C "$fixture" .
    sha256sum "$bundle_out" | awk '{print $1"  bundle.tar.gz"}' > "$bundle_out.sha256"
}

RANDOM_SEED=1

show_live_failure() {
  ts=$1
  output=$2
  if [ -f "$output" ]; then cat "$output" >&2 || echo "unreadable case output: $output" >&2
  else echo "missing case output: $output" >&2; fi
  server_log="$work/tmp/deploy-bundle-$ts/.local-server.log"
  if [ -f "$server_log" ]; then cat "$server_log" >&2 || echo "unreadable local server log: $server_log" >&2
  else echo "missing local server log: $server_log" >&2; fi
  deploy_log="$work/data/deploy-$ts.log"
  if [ -f "$deploy_log" ]; then cat "$deploy_log" >&2 || echo "unreadable deploy log: $deploy_log" >&2
  else echo "missing deploy log: $deploy_log" >&2; fi
}
fail_live() {
  failed_ts=$1
  failed_output=$2
  failed_reason=$3
  echo "$failed_reason" >&2
  show_live_failure "$failed_ts" "$failed_output"
  exit 1
}
case_output() {
  case "$1" in
    okwait) printf '%s\n' "$work/wait.out" ;;
    failwait) printf '%s\n' "$work/failwait.out" ;;
    async1) printf '%s\n' "$work/async.out" ;;
    cleanup) printf '%s\n' "$work/cleanup.out" ;;
    *) return 2 ;;
  esac
}
assert_own_server_ready() {
  ts=$1
  port=$2
  extract="$work/tmp/deploy-bundle-$ts"
  server_log="$extract/.local-server.log"
  pidfile="$extract/.local-server.pid"
  if [ ! -f "$server_log" ] ||
     ! grep -Fxq "READY http://127.0.0.1:$port root=$extract" "$server_log" ||
     ! grep -Eq '^200 (HEAD|GET) /deploy\.sh$' "$server_log" ||
     grep -Eq 'EADDRINUSE|ERROR:' "$server_log" ||
     ! node "$work/cleanup-owned.js" pid "$work" "$pidfile" "$extract/scripts/deploy-local-server.js"; then
    echo "own loopback readiness failed: $ts port $port" >&2
    show_live_failure "$ts" "$(case_output "$ts")"
    return 1
  fi
  echo "own loopback readiness: $ts READY on $port"
}
assert_stub_completed() {
  ts=$1
  port=$2
  server_log="$work/tmp/deploy-bundle-$ts/.local-server.log"
  deploy_log="$work/data/deploy-$ts.log"
  if [ ! -f "$server_log" ] ||
     ! grep -Eq "^200 (HEAD|GET) /deploy\\.sh\\?fixture_stub=$ts$" "$server_log" ||
     [ ! -f "$deploy_log" ] ||
     ! grep -Fq "stub deploy.sh starting against http://127.0.0.1:$port" "$deploy_log" ||
     ! grep -Fq 'stub deploy.sh confirmed local server reachable' "$deploy_log"; then
    echo "own tagged stub request proof failed: $ts port $port" >&2
    show_live_failure "$ts" "$(case_output "$ts")"
    return 1
  fi
  echo "own tagged stub request: $ts confirmed on owned server"
}

show_child_failure() {
  child_root=$1
  for child_file in "$child_root/cleanup.out" \
      "$child_root/tmp/deploy-bundle-cleanup/.local-server.log" \
      "$child_root/data/deploy-cleanup.log"; do
    if [ -f "$child_file" ]; then cat "$child_file" >&2 || echo "unreadable $child_file" >&2
    else echo "missing $child_file" >&2; fi
  done
}
cleanup_control() {
  mode=$1
  expected=$2
  pathfile="$work/$mode.path"
  if [ "$mode" = premarker ]; then sleep 40 & canary_pid=$!; fi
  if DEPLOY_TEST_PREMARKER_CONTROL=0 DEPLOY_TEST_CLEANUP_MODE="$mode" DEPLOY_TEST_WORK_FILE="$pathfile" \
      sh "$0" >"$work/$mode.out" 2>&1; then result=0; else result=$?; fi
  if [ ! -s "$pathfile" ]; then
    retain_parent_work=1
    echo "$mode work path missing; no owned PID may be inferred" >&2
    cat "$work/$mode.out" >&2 || echo "$mode output unreadable" >&2
    return 1
  fi
  child_work=$(cat "$pathfile")
  marker="$child_work/data/cleanup-delay.json"
  case "$child_work" in /*) : ;; *)
    retain_parent_work=1
    echo "$mode non-absolute child work path: $child_work" >&2
    return 1 ;;
  esac
  parent_ownership_error=0
  if [ "$mode" = premarker ]; then
    if [ -d "$child_work" ] && [ ! -L "$child_work" ]; then
      if ! mkdir -p "$child_work/tmp/deploy-bundle-canary" ||
         ! printf '%s\n' "$canary_pid" > "$child_work/tmp/deploy-bundle-canary/.local-server.pid"; then
        echo 'premarker canary PID-file setup failed; second cleanup still required' >&2
        retain_parent_work=1
        parent_ownership_error=1
      fi
    fi
  fi
  bad=0
  [ "$result" -eq "$expected" ] || bad=1
  [ -d "$child_work" ] || bad=1
  if [ "$mode" = premarker ]; then
    grep -Fq 'premarker delay running before forced marker timeout' "$work/$mode.out" || bad=1
    grep -Fq 'controlled premarker failure after handoff' "$work/$mode.out" || bad=1
    grep -Fxq 'fixture cleanup: missing marker only; quiescent' "$work/$mode.out" || bad=1
    [ ! -e "$marker" ] || bad=1
    bad=1 # the expected missing marker is still a failed ownership oracle
  else
    grep -Fq 'fixture cleanup: quiescent; retained for parent' "$work/$mode.out" || bad=1
    [ -s "$marker" ] || bad=1
    grep -Fq 'marked delay started before cleanup control' "$work/$mode.out" || bad=1
    if [ "$bad" -eq 0 ]; then
      node "$work/cleanup-owned.js" delay-gone "$child_work" "$marker" || bad=1
      node "$work/cleanup-owned.js" audit "$child_work" "$marker" || bad=1
      sleep 1 || bad=1
      node "$work/cleanup-owned.js" delay-gone "$child_work" "$marker" || bad=1
      node "$work/cleanup-owned.js" audit "$child_work" "$marker" || bad=1
    fi
  fi
  if [ "$bad" -ne 0 ]; then
    retain_parent_work=1
    echo "$mode child status=$result, expected=$expected; parent second cleanup: $child_work" >&2
    cat "$work/$mode.out" >&2 || echo "$mode output unreadable" >&2
    show_child_failure "$child_work"
    if node "$work/cleanup-owned.js" cleanup "$child_work" "$marker" >"$work/$mode.second-cleanup.out" 2>&1; then second_rc=0; else second_rc=$?; fi
    cat "$work/$mode.second-cleanup.out" >&2
    echo "$mode parent second cleanup exit=$second_rc" >&2
    if node "$work/cleanup-owned.js" audit "$child_work" >"$work/$mode.second-audit.out" 2>&1; then audit_rc=0; else audit_rc=$?; fi
    cat "$work/$mode.second-audit.out" >&2
    echo "$mode parent second audit exit=$audit_rc" >&2
    if [ "$mode" = premarker ]; then
      kill -0 "$canary_pid" || { echo 'premarker unrelated canary was killed' >&2; return 1; }
      echo 'premarker unrelated canary: OK'
      if ! kill "$canary_pid" 2>/dev/null; then
        echo 'premarker canary stop failed' >&2
        parent_ownership_error=1
      fi
      wait "$canary_pid" 2>/dev/null || :
      canary_pid=
      [ "$parent_ownership_error" -eq 0 ] && [ "$result" -eq 1 ] && [ ! -e "$marker" ] &&
        grep -Fxq 'fixture cleanup: missing marker only; quiescent' "$work/$mode.out" &&
        [ "$second_rc" -eq 1 ] &&
        grep -Fxq 'fixture cleanup: missing marker only; quiescent' "$work/$mode.second-cleanup.out" &&
        [ "$audit_rc" -eq 0 ] &&
        grep -Fxq 'fixture audit: quiescent' "$work/$mode.second-audit.out" &&
        grep -Eq 'fixture sweep: signaled [0-9]+/[0-9]+/delay SIGTERM' "$work/$mode.out" "$work/$mode.second-cleanup.out" || return 1
      echo "premarker cleanup control: expected uncertainty retained $child_work" >&2
      return 19
    fi
    echo "failed cleanup control retained $child_work" >&2
    return 1
  fi
  rm -rf "$child_work" || { echo "cannot remove verified $child_work" >&2; exit 1; }
  echo "$mode cleanup control: OK"
}

node - <<'NODE'
const net = require('node:net');
const ports = [18761, 18762, 18763, 18764];
function check() {
  const port = ports.shift();
  if (port === undefined) return;
  const server = net.createServer();
  server.once('error', error => {
    console.error(`port ${port} unavailable: ${error.code || error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => server.close(check));
}
check();
NODE

case "${DEPLOY_TEST_CLEANUP_MODE:-}" in
  assertion|term|premarker)
    STUB_DELAY_MARKER="$work/data/cleanup-delay.json"
    export STUB_DELAY_MARKER
    mkdir -p "$work/data"
    build_bundle 0 "$work/cleanup.tar.gz"
    no_marker=0
    [ "$DEPLOY_TEST_CLEANUP_MODE" != premarker ] || no_marker=1
    if STUB_DELAY_SECONDS=20 STUB_DELAY_NO_MARKER="$no_marker" STUB_REQUEST_TAG="cleanup" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
       DEPLOY_OFFLINE_LOG_DIR="$work/data" DEPLOY_OFFLINE_TS="cleanup" \
       sh "$offline" "$work/cleanup.tar.gz" --port 18764 >"$work/cleanup.out" 2>&1; then
      assert_own_server_ready cleanup 18764 || exit 1
    else
      show_live_failure cleanup "$work/cleanup.out"
      exit 1
    fi
    if [ "$DEPLOY_TEST_CLEANUP_MODE" = premarker ]; then
      waited=0
      while ! grep -Fq 'fixture delay running without marker' "$work/data/deploy-cleanup.log" 2>/dev/null; do
        waited=$((waited + 1))
        [ "$waited" -le 5 ] || fail_live cleanup "$work/cleanup.out" 'premarker delay did not start'
        sleep 1 || fail_live cleanup "$work/cleanup.out" 'premarker wait interrupted'
      done
      [ ! -e "$STUB_DELAY_MARKER" ] || fail_live cleanup "$work/cleanup.out" 'premarker marker unexpectedly exists'
      echo 'premarker delay running before forced marker timeout'
      fail_live cleanup "$work/cleanup.out" 'controlled premarker failure after handoff'
    fi
    waited=0
    while [ ! -s "$STUB_DELAY_MARKER" ]; do
      waited=$((waited + 1))
      [ "$waited" -le 5 ] || fail_live cleanup "$work/cleanup.out" 'marked delay never started'
      sleep 1 || fail_live cleanup "$work/cleanup.out" 'marked delay wait interrupted'
    done
    node "$work/cleanup-owned.js" delay-live "$work" "$STUB_DELAY_MARKER" ||
      fail_live cleanup "$work/cleanup.out" 'marked delay identity check failed'
    echo 'marked delay started before cleanup control'
    if [ "$DEPLOY_TEST_CLEANUP_MODE" = assertion ]; then exit 23; fi
    kill -TERM "$$"
    exit 99
    ;;
  '') ;;
  *) echo 'invalid DEPLOY_TEST_CLEANUP_MODE' >&2; exit 2 ;;
esac

mkdir -p "$work/tmp/deploy-bundle-canary"
sleep 20 &
canary_pid=$!
printf '%s\n' "$canary_pid" > "$work/tmp/deploy-bundle-canary/.local-server.pid"
node "$work/cleanup-owned.js" audit "$work"
kill -0 "$canary_pid" || { echo 'cleanup killed unrelated canary' >&2; exit 1; }
echo 'unrelated-process canary: OK'
kill "$canary_pid" 2>/dev/null || :
wait "$canary_pid" 2>/dev/null || :
canary_pid=
rm -rf "$work/tmp/deploy-bundle-canary"

if [ "${DEPLOY_TEST_PREMARKER_CONTROL:-0}" = 1 ]; then cleanup_control premarker 1; exit 99; fi

echo "=== missing bundle fails clearly ==="
if sh "$offline" "$work/does-not-exist.tar.gz" 2>"$work/err.log"; then
    echo "expected failure for a missing bundle" >&2
    exit 1
fi
grep -qi 'not found' "$work/err.log"
echo "OK"

echo "=== sha256 mismatch is rejected ==="
build_bundle 0 "$work/bad.tar.gz"
printf 'deadbeef  bundle.tar.gz\n' > "$work/bad.tar.gz.sha256"
if sh "$offline" "$work/bad.tar.gz" 2>"$work/err.log"; then
    echo "expected sha256 mismatch to fail" >&2
    exit 1
fi
grep -qi 'sha256 mismatch' "$work/err.log"
echo "OK"

echo "=== successful deploy, --wait mode, returns deploy.sh's exit code ==="
build_bundle 0 "$work/good.tar.gz"
if STUB_REQUEST_TAG="okwait" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" DEPLOY_OFFLINE_LOG_DIR="$work/data" \
   DEPLOY_OFFLINE_TS="okwait" sh "$offline" "$work/good.tar.gz" --port 18761 --wait \
   >"$work/wait.out" 2>&1; then rc=0; else rc=$?; fi
if [ "$rc" -ne 0 ]; then
  echo "expected exit 0, got $rc" >&2
  show_live_failure okwait "$work/wait.out"
  exit 1
fi
assert_own_server_ready okwait 18761 || exit 1
assert_stub_completed okwait 18761 || exit 1
[ -f "$work/data/deploy-okwait.log" ] || fail_live okwait "$work/wait.out" 'missing deploy log'
grep -Fq 'stub deploy.sh confirmed local server reachable' "$work/data/deploy-okwait.log" ||
  fail_live okwait "$work/wait.out" 'stub confirmation missing'
node "$work/cleanup-owned.js" audit "$work" || fail_live okwait "$work/wait.out" 'okwait cleanup audit failed'
sleep 1 || fail_live okwait "$work/wait.out" 'okwait shutdown wait interrupted'
if wget -q -O /dev/null --spider 'http://127.0.0.1:18761/deploy.sh' 2>/dev/null; then
  fail_live okwait "$work/wait.out" 'okwait server still answering'
fi
echo "OK"

echo "=== failing deploy.sh propagates a nonzero exit code under --wait ==="
build_bundle 7 "$work/fail.tar.gz"
if STUB_REQUEST_TAG="failwait" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" DEPLOY_OFFLINE_LOG_DIR="$work/data" \
   DEPLOY_OFFLINE_TS="failwait" sh "$offline" "$work/fail.tar.gz" --port 18762 --wait \
   >"$work/failwait.out" 2>&1; then rc=0; else rc=$?; fi
if [ "$rc" -ne 7 ]; then
  echo "expected exit 7, got $rc" >&2
  show_live_failure failwait "$work/failwait.out"
  exit 1
fi
assert_own_server_ready failwait 18762 || exit 1
assert_stub_completed failwait 18762 || exit 1
node "$work/cleanup-owned.js" audit "$work" || fail_live failwait "$work/failwait.out" 'failwait cleanup audit failed'
sleep 1 || fail_live failwait "$work/failwait.out" 'failwait shutdown wait interrupted'
if wget -q -O /dev/null --spider 'http://127.0.0.1:18762/deploy.sh' 2>/dev/null; then
  fail_live failwait "$work/failwait.out" 'failwait server still answering'
fi
echo "OK"

echo "=== fire-and-forget mode returns immediately, deploy finishes async, server stops ==="
build_bundle 0 "$work/async.tar.gz"
start_ts=$(date +%s) || fail_live async1 "$work/async.out" 'async start clock failed'
if STUB_REQUEST_TAG="async1" DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" DEPLOY_OFFLINE_LOG_DIR="$work/data" \
   DEPLOY_OFFLINE_TS="async1" sh "$offline" "$work/async.tar.gz" --port 18763 \
   >"$work/async.out" 2>&1; then rc=0; else rc=$?; fi
end_ts=$(date +%s) || fail_live async1 "$work/async.out" 'async end clock failed'
if [ "$rc" -ne 0 ]; then
  echo "expected async handoff exit 0, got $rc" >&2
  show_live_failure async1 "$work/async.out"
  exit 1
fi
assert_own_server_ready async1 18763 || exit 1
elapsed=$((end_ts - start_ts))
[ "$elapsed" -lt 10 ] || fail_live async1 "$work/async.out" "async handoff took ${elapsed}s"
grep -Fq 'Follow it with: tail -f' "$work/async.out" ||
  fail_live async1 "$work/async.out" 'async handoff hint missing'
waited=0
while [ ! -f "$work/data/deploy-async1.log" ] ||
      ! grep -Fq 'stub deploy.sh confirmed local server reachable' "$work/data/deploy-async1.log" 2>/dev/null; do
  waited=$((waited + 1))
  [ "$waited" -lt 20 ] || fail_live async1 "$work/async.out" 'async stub completion timed out'
  sleep 1 || fail_live async1 "$work/async.out" 'async completion wait interrupted'
done
assert_stub_completed async1 18763 || exit 1
sleep 1 || fail_live async1 "$work/async.out" 'async shutdown wait interrupted'
if wget -q -O /dev/null --spider 'http://127.0.0.1:18763/deploy.sh' 2>/dev/null; then
  fail_live async1 "$work/async.out" 'async server still answering'
fi
echo 'offline direct exits: wait=0 failwait=7 async=0'
node "$work/cleanup-owned.js" audit "$work" || fail_live async1 "$work/async.out" 'async cleanup audit failed'
echo "OK"

cleanup_control assertion 23
cleanup_control term 143

echo "deploy-offline.test: OK"
