#!/bin/sh
# Runs ON THE PI. Given a bundle tarball built by deploy-bundle.sh, verifies
# it, extracts it, serves it from 127.0.0.1 via deploy-local-server.js, and
# runs deploy.sh against that local server -- all under `setsid` so a dropped
# Tailscale/SSH session cannot kill a deploy that is already mid-migration.
#
# Usage:
#   deploy-offline.sh <bundle.tar.gz> [--port N] [--wait]
#
# Without --wait, deploy-offline.sh hands the deploy off to a detached
# watcher and returns immediately, printing the log path and a tail -f hint.
# With --wait, it follows the log and exits with the final verdict's exit
# code (3 for an unverified start). The deploy runs detached: an SSH drop
# during --wait only stops the local `tail`, never the deploy.
#
# BusyBox ash compatible: no bashisms (no [[, no arrays, no `local`, no
# process substitution).
set -eu

BUNDLE=""
PORT="9876"
WAIT="0"

while [ $# -gt 0 ]; do
    case "$1" in
        --port)
            [ "$#" -ge 2 ] || { echo "ERROR: --port requires a value" >&2; exit 2; }
            PORT="$2"
            shift 2
            ;;
        --port=*)
            PORT="${1#--port=}"
            shift
            ;;
        --wait)
            WAIT="1"
            shift
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "ERROR: unknown option: $1" >&2
            exit 2
            ;;
        *)
            if [ -z "$BUNDLE" ]; then
                BUNDLE="$1"
            else
                echo "ERROR: unexpected extra argument: $1" >&2
                exit 2
            fi
            shift
            ;;
    esac
done

if [ -z "$BUNDLE" ]; then
    echo "Usage: deploy-offline.sh <bundle.tar.gz> [--port N] [--wait]" >&2
    exit 2
fi
if [ ! -f "$BUNDLE" ]; then
    echo "ERROR: bundle not found: $BUNDLE" >&2
    exit 1
fi

# A per-run result lives beside the log on persistent storage. A pending
# result after power loss is deliberately inconclusive, never success.
TS="${DEPLOY_OFFLINE_TS:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
TMP_ROOT="${DEPLOY_OFFLINE_TMP_ROOT:-/tmp}"
EXTRACT_DIR="$TMP_ROOT/deploy-bundle-$TS"
LOG_DIR="${DEPLOY_OFFLINE_LOG_DIR:-/data}"
LOGFILE="$LOG_DIR/deploy-$TS.log"
RESULTFILE="$LOG_DIR/deploy-$TS.result"
RCFILE="$EXTRACT_DIR/.deploy.rc"
SERVER_LOG="$EXTRACT_DIR/.local-server.log"
SERVER_PIDFILE="$EXTRACT_DIR/.local-server.pid"
case "$TS" in ''|*[!a-zA-Z0-9_-]*) echo "ERROR: invalid run stamp" >&2; exit 2 ;; esac
case "$PORT" in ''|*[!0-9]*) echo "ERROR: invalid port" >&2; exit 2 ;; esac
mkdir -p "$LOG_DIR" "$TMP_ROOT"
# Never reuse a run's result or extraction tree, even when a caller supplies TS.
if [ -e "$RESULTFILE" ] || [ -e "$EXTRACT_DIR" ]; then
    echo "ERROR: deploy run already exists: $TS; choose a new run stamp" >&2
    exit 1
fi
write_offline_result() {
    wor_state="$1" wor_code="$2" wor_verdict="$3" wor_reason="$4"
    {
        printf 'schema=osi-deploy-result/1\nstate=%s\nexit_code=%s\ndeploy_exit_code=%s\nverdict=%s\n' "$wor_state" "$wor_code" "${deploy_rc:-}" "$wor_verdict"
        printf 'payload_stamp=unknown\nactive_payload_stamp=unknown\nbundle_sha256=%s\nlog=%s\n' "${actual_sha:-unknown}" "$LOGFILE"
        printf 'reason=%s\n' "$(printf '%s' "$wor_reason" | tr '\n\r' '  ')"
    } > "$RESULTFILE.tmp-$$" && mv "$RESULTFILE.tmp-$$" "$RESULTFILE"
}
server_started=0
phase="bundle verification"
early_exit() {
    early_rc=$?
    trap - EXIT INT TERM HUP
    if [ "$server_started" = 1 ] && [ -f "$SERVER_PIDFILE" ]; then
        kill "$(cat "$SERVER_PIDFILE")" 2>/dev/null || true
    fi
    [ "$early_rc" -ne 0 ] || early_rc=1
    early_reason="$phase failed"
    if [ -f "$LOGFILE" ]; then
        early_detail="$(tail -n 1 "$LOGFILE")"
        [ -z "$early_detail" ] || early_reason="$early_reason: $early_detail"
    fi
    write_offline_result complete "$early_rc" refused "$early_reason" || early_rc=1
    echo "Read result: cat '$RESULTFILE'" >&2
    exit "$early_rc"
}
trap early_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
write_offline_result pending 125 pending "verification and launch have not completed"
echo "Read result: cat '$RESULTFILE'"
SHA_SIDECAR="${DEPLOY_OFFLINE_SHA256:-$BUNDLE.sha256}"
if [ ! -f "$SHA_SIDECAR" ]; then
    echo "ERROR: sha256 sidecar not found: $SHA_SIDECAR" >&2
    exit 1
fi

echo "--- Verify bundle sha256 ---"
expected_sha="$(awk '{print $1}' "$SHA_SIDECAR")"
actual_sha="$(sha256sum "$BUNDLE" | awk '{print $1}')"
if [ "$expected_sha" != "$actual_sha" ]; then
    echo "ERROR: sha256 mismatch for $BUNDLE" >&2
    echo "  expected: $expected_sha" >&2
    echo "  actual:   $actual_sha" >&2
    exit 1
fi
echo "OK: $actual_sha"
phase="disk preflight"

echo "--- Disk preflight ---"
# BusyBox df wraps long device names onto their own line, pushing fields
# right by one -- Available is the 3rd-from-last field, not $4 (same
# wrap-safe idiom deploy.sh itself uses for its migration disk gate).
bundle_kb=$(( ($(wc -c < "$BUNDLE") + 1023) / 1024 ))
avail_kb=$(df -k "$TMP_ROOT" | tail -1 | awk '{print $(NF-2)}')
# Extracting roughly doubles the footprint (tarball + extracted tree) plus a
# safety margin for the server/log/rc scratch files.
req_kb=$(( bundle_kb * 3 + 4096 ))
case "$avail_kb" in
    ''|*[!0-9]*)
        echo "WARNING: could not parse available disk space for $TMP_ROOT; proceeding without a disk preflight gate" >&2
        ;;
    *)
        if [ "$avail_kb" -lt "$req_kb" ]; then
            echo "ERROR: insufficient disk for offline extraction under $TMP_ROOT: need ~${req_kb}KB, have ${avail_kb}KB" >&2
            exit 1
        fi
        ;;
esac
echo "OK"

mkdir "$EXTRACT_DIR"
phase="archive validation"
echo "--- Validate archive paths and file types ---"
# Refuse links, special files and traversal BEFORE tar can create anything.
# The builder emits only these portable names and regular files/directories.
tar tzf "$BUNDLE" > "$EXTRACT_DIR/.archive-list"
awk '
    $0 == "./" { next }
    {
        name=$0; sub(/^\.\//, "", name); sub(/\/$/, "", name)
        if (name !~ /^[a-zA-Z0-9_.\/-]+$/ || name ~ /^\//) exit 1
        n=split(name, parts, "/")
        for (i=1; i<=n; i++) if (parts[i] == ".." || parts[i] == "." || parts[i] == "") exit 1
        if (seen[name]++) exit 1
    }
' "$EXTRACT_DIR/.archive-list" || { echo "ERROR: unsafe archive path" >&2; exit 1; }
tar tvzf "$BUNDLE" > "$EXTRACT_DIR/.archive-types"
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { exit 1 }' "$EXTRACT_DIR/.archive-types" || {
    echo "ERROR: archive contains a link or special file" >&2; exit 1;
}
rm "$EXTRACT_DIR/.archive-list" "$EXTRACT_DIR/.archive-types"
phase="bundle manifest verification"
echo "--- Extract bundle and verify every file ---"
tar xzf "$BUNDLE" -C "$EXTRACT_DIR"
if [ ! -f "$EXTRACT_DIR/deploy.sh" ] || [ ! -f "$EXTRACT_DIR/scripts/deploy-bundle-manifest.js" ]; then
    echo "ERROR: bundle lacks deploy.sh or the manifest verifier" >&2
    exit 1
fi
if node "$EXTRACT_DIR/scripts/deploy-bundle-manifest.js" verify "$EXTRACT_DIR" > "$LOGFILE" 2>&1; then
    cat "$LOGFILE"
else
    cat "$LOGFILE" >&2
    exit 1
fi
echo "OK: extracted and verified $EXTRACT_DIR"
phase="local server startup"

echo "--- Start local server (setsid, port $PORT) ---"
DEPLOY_LOCAL_SERVER_PIDFILE="$SERVER_PIDFILE" \
    setsid node "$EXTRACT_DIR/scripts/deploy-local-server.js" "$PORT" "$EXTRACT_DIR" \
    >"$SERVER_LOG" 2>&1 &
server_started="1"

wait_attempts=0
server_ready="0"
while [ "$wait_attempts" -lt 30 ]; do
    if wget -q -O /dev/null --spider "http://127.0.0.1:$PORT/deploy.sh" 2>/dev/null; then
        server_ready="1"
        break
    fi
    wait_attempts=$((wait_attempts + 1))
    sleep 1
done
if [ "$server_ready" != "1" ]; then
    echo "ERROR: local server on 127.0.0.1:$PORT did not answer within 30s" >&2
    echo "--- local server log ---" >&2
    cat "$SERVER_LOG" >&2 2>/dev/null || true
    exit 1
fi
echo "OK: local server answering on 127.0.0.1:$PORT"

echo "--- Launch deploy.sh (setsid, detached) ---"
# This whole block, not just deploy.sh, runs under one setsid session: it
# waits for deploy.sh, THEN always stops the local server, unconditionally,
# whether deploy.sh succeeds, fails, or this deploy-offline.sh process (and
# the SSH session running it) is long gone by the time it finishes. Wrapping
# it this way -- rather than backgrounding deploy.sh directly -- is what
# makes "always stop the local server at the end" true even in the
# fire-and-forget (non --wait) path.
# Pass paths as positional arguments: quoting in a path cannot become code.
# The detached watcher publishes its final result before the completion marker.
write_offline_result running 125 pending "deploy is running; a final verdict is not available yet"
setsid sh -c '
    extract=$1 port=$2 log=$3 result=$4 rcfile=$5 pidfile=$6 bundle_sha=$7
    watcher_exit() {
        watcher_rc=$?
        trap - EXIT
        if [ -f "$pidfile" ]; then kill "$(cat "$pidfile")" 2>/dev/null || true; fi
        # Publish completion even if persisting the result failed: --wait must
        # return failure rather than wait forever on a failed reporter.
        printf "%s\n" "$watcher_rc" > "$rcfile.tmp-$$" && mv "$rcfile.tmp-$$" "$rcfile"
    }
    trap watcher_exit EXIT
    DEPLOY_OUTCOME_FILE="$result" DEPLOY_LOGFILE="$log" DEPLOY_BUNDLE_SHA256="$bundle_sha" \
        sh "$extract/deploy.sh" "$port" >"$log" 2>&1
    rc=$?
    if ! grep -qx "state=complete" "$result"; then
        # Older/missing reporting is never interpreted as a verified success.
        verdict=failed
        effective=$rc
        [ "$effective" -ne 0 ] || { effective=3; verdict=unverified; }
        reason=$(awk "/ERROR:|ALERT:|HELD:|UNVERIFIED:/ { last=\$0 } END { print last }" "$log")
        [ -n "$reason" ] || reason="deploy exited without a final lifecycle report; inspect the log"
        {
            printf "schema=osi-deploy-result/1\nstate=complete\nexit_code=%s\ndeploy_exit_code=%s\nverdict=%s\n" "$effective" "$rc" "$verdict"
            printf "payload_stamp=unknown\nactive_payload_stamp=unknown\nbundle_sha256=%s\nlog=%s\nreason=%s\n" "$bundle_sha" "$log" "$reason"
        } > "$result.tmp-$$" && mv "$result.tmp-$$" "$result" || exit 1
    fi
    effective=$(sed -n "s/^exit_code=//p" "$result")
    case "$effective" in ""|*[!0-9]*) effective=1 ;; esac
    # Even a broken report cannot hide a failing process exit.
    if [ "$rc" -ne 0 ] && [ "$effective" -eq 0 ]; then effective=$rc; fi
    exit "$effective"
' deploy-watcher "$EXTRACT_DIR" "$PORT" "$LOGFILE" "$RESULTFILE" "$RCFILE" "$SERVER_PIDFILE" "$actual_sha" \
    </dev/null >/dev/null 2>&1 &

# Handoff complete: the detached watcher above now owns the server's
# lifecycle. Disarm our own early-failure trap so it does not race the
# watcher by killing the server out from under a deploy that is still
# running.
trap - EXIT INT TERM HUP

echo ""
echo "=== Deploy launched (immune to this session dropping) ==="
echo "  Log:  $LOGFILE"
echo "  Read result: cat '$RESULTFILE'"
echo "  Launch accepted; the result is pending until state=complete."
echo "  Follow it with: tail -f $LOGFILE"
echo ""

if [ "$WAIT" != "1" ]; then
    exit 0
fi

echo "--- Waiting for deploy.sh to finish (--wait) ---"
touch "$LOGFILE" 2>/dev/null || true
tail -f "$LOGFILE" &
tail_pid=$!
stop_tail() {
    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
}
trap 'stop_tail; exit 130' INT
trap 'stop_tail; exit 143' TERM
trap 'stop_tail; exit 129' HUP
wait_deploy_attempts=0
while [ ! -f "$RCFILE" ]; do
    sleep 1
    wait_deploy_attempts=$((wait_deploy_attempts + 1))
done
stop_tail
trap - INT TERM HUP

rc="$(cat "$RCFILE")"
case "$rc" in
    ''|*[!0-9]*) rc=1 ;;
esac
echo ""
cat "$RESULTFILE"
echo "=== offline deploy finished with status $rc ==="
exit "$rc"
