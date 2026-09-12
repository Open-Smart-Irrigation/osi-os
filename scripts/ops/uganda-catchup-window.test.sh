#!/bin/sh
# Exercises uganda-catchup-window.sh's flows-flip precondition (issue #222 /
# F4: the Uganda 2026-09-12 incident) without a live gateway. Two things are
# under test:
#
#   1. The precondition check itself: a mismatch between the currently-
#      flipped flows.json and the migration target must REFUSE-AND-HOLD
#      (rc=1) BEFORE Node-RED is ever stopped; a match must let the script
#      proceed past the check.
#   2. The exit trap's restart gate: it must restart Node-RED only when the
#      precondition held, regardless of why NODE_RED_RESTART_NEEDED got set,
#      by sourcing the script (UGANDA_CATCHUP_WINDOW_TEST_SOURCE=1) to reach
#      its on_exit() function directly without running the on-device body.
#
# Requires only sh + sqlite3 + node + sha256sum (no live /etc/init.d, since
# UGANDA_CATCHUP_STUB_NODE_RED=1 replaces the Node-RED calls with no-ops).
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
window="$script_dir/uganda-catchup-window.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

sha_of() {
    sha256sum "$1" | awk '{print $1}'
}

fresh_env() {
    # A minimal payload + live-flows fixture, reset before each scenario.
    rm -rf "$work/env"
    mkdir -p "$work/env/payload/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share" \
             "$work/env/payload/database/migrations/ordered"
    printf '{"nodes":"new-release-flows"}\n' > "$work/env/payload/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"
    printf '{}\n' > "$work/env/payload/database/migrations/ordered/CHECKSUMS.json"
    : > "$work/env/farming.db"
    printf '{"nodes":"live-flows"}\n' > "$work/env/live-flows.json"
}

run_window() {
    # Runs with Node-RED stop/start stubbed, all state under $work/env, and
    # the disk-space preflight satisfied trivially (df is real, /tmp always
    # has room). Captures combined stdout+stderr to $work/env/out.log and
    # the exit code to $work/env/rc.
    ( \
        cd "$work/env" && \
        UGANDA_CATCHUP_STUB_NODE_RED=1 \
        UGANDA_DB_PATH="$work/env/farming.db" \
        UGANDA_CATCHUP_BACKUP_DIR="$work/env/backups" \
        UGANDA_LIVE_FLOWS_PATH="$work/env/live-flows.json" \
        sh "$window" "$work/env/payload" "$@" \
    ) >"$work/env/out.log" 2>&1
    echo "$?" > "$work/env/rc"
}

echo "=== mismatched --expected-flows-sha REFUSES before touching Node-RED ==="
fresh_env
set +e
run_window --expected-flows-sha "deadbeef0000000000000000000000000000000000000000000000000000"
set -e
rc=$(cat "$work/env/rc")
[ "$rc" = "1" ] || { echo "expected rc=1, got $rc" >&2; cat "$work/env/out.log" >&2; exit 1; }
grep -qi 'REFUSE-AND-HOLD' "$work/env/out.log"
grep -qi 'issue #222' "$work/env/out.log"
if grep -q 'STUB: node-red' "$work/env/out.log"; then
    echo "expected Node-RED to never be touched on a precondition refusal" >&2
    cat "$work/env/out.log" >&2
    exit 1
fi
echo "OK"

echo "=== matching --expected-flows-sha passes the gate and proceeds to stop Node-RED ==="
fresh_env
live_sha=$(sha_of "$work/env/live-flows.json")
set +e
run_window --expected-flows-sha "$live_sha"
set -e
grep -qi 'flows-flip precondition ok' "$work/env/out.log"
grep -q 'STUB: node-red stop' "$work/env/out.log"
echo "OK"

echo "=== with no --expected-flows-sha, falls back to the staged bundle's flows.json ==="
fresh_env
# Point the live flows at the SAME content as the staged bundle's flows.json.
cp "$work/env/payload/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" "$work/env/live-flows.json"
set +e
run_window
set -e
grep -qi 'flows-flip precondition ok' "$work/env/out.log"
grep -q 'staged bundle' "$work/env/out.log"
grep -q 'STUB: node-red stop' "$work/env/out.log"
echo "OK"

echo "=== bundle-fallback mismatch also REFUSES before touching Node-RED ==="
fresh_env
# live-flows.json (from fresh_env) deliberately differs from the bundle's.
set +e
run_window
set -e
rc=$(cat "$work/env/rc")
[ "$rc" = "1" ] || { echo "expected rc=1, got $rc" >&2; cat "$work/env/out.log" >&2; exit 1; }
grep -qi 'REFUSE-AND-HOLD' "$work/env/out.log"
if grep -q 'STUB: node-red' "$work/env/out.log"; then
    echo "expected Node-RED to never be touched on a precondition refusal" >&2
    exit 1
fi
echo "OK"

echo "=== neither --expected-flows-sha nor a staged bundle flows.json REFUSES ==="
fresh_env
rm "$work/env/payload/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"
set +e
run_window
set -e
rc=$(cat "$work/env/rc")
[ "$rc" = "1" ] || { echo "expected rc=1, got $rc" >&2; cat "$work/env/out.log" >&2; exit 1; }
grep -qi 'REFUSE-AND-HOLD' "$work/env/out.log"
echo "OK"

echo "=== trap: restarts Node-RED only when the precondition held (sourced unit test) ==="
trap_out="$work/trap-ok.log"
set +e
( \
    UGANDA_CATCHUP_STUB_NODE_RED=1 UGANDA_CATCHUP_WINDOW_TEST_SOURCE=1 . "$window" dummy-payload-dir
    NODE_RED_RESTART_NEEDED=1
    FLOWS_PRECONDITION_OK=1
    exit 0
) >"$trap_out" 2>&1
set -e
grep -q 'STUB: node-red start' "$trap_out"
grep -q 'trap: Node-RED restarted OK' "$trap_out"
echo "OK"

echo "=== trap: refuses to restart Node-RED when the precondition did NOT hold ==="
trap_out="$work/trap-refuse.log"
set +e
( \
    UGANDA_CATCHUP_STUB_NODE_RED=1 UGANDA_CATCHUP_WINDOW_TEST_SOURCE=1 . "$window" dummy-payload-dir
    NODE_RED_RESTART_NEEDED=1
    FLOWS_PRECONDITION_OK=0
    exit 1
) >"$trap_out" 2>&1
set -e
if grep -q 'STUB: node-red start' "$trap_out"; then
    echo "expected the trap NOT to start Node-RED when the precondition failed" >&2
    cat "$trap_out" >&2
    exit 1
fi
grep -qi 'REFUSE-TO-RESTART' "$trap_out"
grep -qi 'issue #222' "$trap_out"
grep -qi 'RECOVERY' "$trap_out"
echo "OK"

echo "uganda-catchup-window.test: OK"
