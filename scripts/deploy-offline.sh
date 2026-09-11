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
# With --wait, it follows the log itself and exits with deploy.sh's own exit
# code (still safe: the underlying deploy already runs detached, so an SSH
# drop during --wait only stops the local `tail`, never the deploy).
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

TS="${DEPLOY_OFFLINE_TS:-$(date -u +%Y%m%dT%H%M%SZ)}"
TMP_ROOT="${DEPLOY_OFFLINE_TMP_ROOT:-/tmp}"
EXTRACT_DIR="$TMP_ROOT/deploy-bundle-$TS"
LOG_DIR="${DEPLOY_OFFLINE_LOG_DIR:-/data}"
LOGFILE="$LOG_DIR/deploy-$TS.log"
RCFILE="$EXTRACT_DIR/.deploy.rc"
SERVER_LOG="$EXTRACT_DIR/.local-server.log"
SERVER_PIDFILE="$EXTRACT_DIR/.local-server.pid"

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

mkdir -p "$EXTRACT_DIR" "$LOG_DIR"

server_started="0"
cleanup_on_early_failure() {
    # Only fires if we fail BEFORE handing off to the detached watcher; once
    # handed off, the watcher owns stopping the server (see below), and this
    # trap is disarmed.
    if [ "$server_started" = "1" ] && [ -f "$SERVER_PIDFILE" ]; then
        kill "$(cat "$SERVER_PIDFILE")" 2>/dev/null || true
    fi
}
trap cleanup_on_early_failure EXIT INT TERM

echo "--- Extract bundle ---"
tar xzf "$BUNDLE" -C "$EXTRACT_DIR"
if [ ! -f "$EXTRACT_DIR/deploy.sh" ]; then
    echo "ERROR: bundle did not contain deploy.sh" >&2
    exit 1
fi
echo "OK: extracted to $EXTRACT_DIR"

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
setsid sh -c '
    sh "'"$EXTRACT_DIR"'/deploy.sh" "'"$PORT"'" >"'"$LOGFILE"'" 2>&1
    rc=$?
    echo "$rc" > "'"$RCFILE"'"
    if [ -f "'"$SERVER_PIDFILE"'" ]; then
        kill "$(cat "'"$SERVER_PIDFILE"'")" 2>/dev/null || true
    fi
    exit "$rc"
' </dev/null >/dev/null 2>&1 &

# Handoff complete: the detached watcher above now owns the server's
# lifecycle. Disarm our own early-failure trap so it does not race the
# watcher by killing the server out from under a deploy that is still
# running.
trap - EXIT INT TERM

echo ""
echo "=== Deploy launched (immune to this session dropping) ==="
echo "  Log:  $LOGFILE"
echo "  Follow it with: tail -f $LOGFILE"
echo ""

if [ "$WAIT" != "1" ]; then
    exit 0
fi

echo "--- Waiting for deploy.sh to finish (--wait) ---"
touch "$LOGFILE" 2>/dev/null || true
tail -f "$LOGFILE" &
tail_pid=$!
wait_deploy_attempts=0
while [ ! -f "$RCFILE" ]; do
    sleep 1
    wait_deploy_attempts=$((wait_deploy_attempts + 1))
done
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

rc="$(cat "$RCFILE")"
case "$rc" in
    ''|*[!0-9]*) rc=1 ;;
esac
echo ""
echo "=== deploy.sh exited with status $rc ==="
exit "$rc"
