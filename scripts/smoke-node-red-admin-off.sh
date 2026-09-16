#!/bin/sh
# smoke-node-red-admin-off.sh — operator smoke check for the Node-RED
# editor/admin API closure (httpAdminRoot: false; see
# feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js and
# scripts/test-node-red-admin-root-off.js for the static guard).
#
# Run this ON the gateway, from loopback, AFTER `/etc/init.d/node-red
# restart` has completed (deploy.sh already restarts Node-RED itself; do not
# restart it again by hand — see AGENTS.md / osi-live-ops-runbook). It makes
# no writes and touches no database; it is a read-only HTTP probe.
#
# Expected result once httpAdminRoot: false is live:
#   GET /gui       -> 200 or 301  (farmer dashboard still served)
#   GET /flows     -> 404         (admin API closed)
#   GET /settings  -> 404         (admin API closed; NOT the product
#                                  /api/system/settings route)
#
# This script is NOT run as part of any CI or repo gate: there is no live
# Node-RED runtime in this repo or its test worktrees. It is for a human
# operator to run against a real gateway after a deploy or restart.
#
# BusyBox ash compatible (no bashisms): the Pi shell is BusyBox ash, not bash.
set -eu

HOST="${1:-127.0.0.1}"
PORT="${2:-1880}"
BASE="http://$HOST:$PORT"

FAIL=0

check() {
    path="$1"
    shift
    # remaining args: acceptable HTTP status codes
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path" 2>/dev/null || echo "000")
    ok=0
    for want in "$@"; do
        if [ "$code" = "$want" ]; then
            ok=1
        fi
    done
    if [ "$ok" = "1" ]; then
        echo "OK: GET $path -> $code"
    else
        echo "FAIL: GET $path -> $code (expected one of: $*)" >&2
        FAIL=1
    fi
}

echo "Probing Node-RED admin-boundary closure at $BASE ..."
check /gui 200 301
check /flows 404
check /settings 404

if [ "$FAIL" = "0" ]; then
    echo "PASS: Node-RED editor/admin API closed; /gui still reachable"
    exit 0
else
    echo "FAIL: one or more admin-boundary checks did not match the expected result" >&2
    echo "If /flows or /settings did NOT return 404, httpAdminRoot: false is not live" >&2
    echo "(check /srv/node-red/settings.js on the gateway and confirm node-red was restarted)." >&2
    exit 1
fi
