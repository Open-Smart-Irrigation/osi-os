#!/bin/sh
# Tests osi-backend against a scratch root with stub init scripts.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BIN="$HERE/../files/usr/sbin/osi-backend"
SCRATCH="${OSI_TEST_SCRATCH:?set OSI_TEST_SCRATCH to a scratch directory}"
fail() { echo "FAIL: $*"; exit 1; }
setup() {
    R="$SCRATCH/root.$1"; rm -rf "$R"; mkdir -p "$R/etc/init.d" "$R/var/lock" "$R/run"
    for svc in node-red osi-edge; do
        name=$svc; [ "$svc" = osi-edge ] && name=edge
        cat > "$R/etc/init.d/$svc" <<STUB
#!/bin/sh
echo "\$1 $svc" >> "$R/calls"
case "\$1" in
  tls_check) [ -e "$R/tls-fail" ] && { echo "osi-edge tls-check: cloud broker cloud.example.test:443 failed: certificate not signed by a trusted root"; exit 1; }; exit 0 ;;
  start) touch "$R/run/$name" ;;
  stop) [ -e "$R/run/$name.stuck" ] || rm -f "$R/run/$name" ;;
esac
STUB
        chmod +x "$R/etc/init.d/$svc"
    done
    touch "$R/run/node-red"
    export OSI_BACKEND_ROOT="$R" OSI_BACKEND_RUNNING_DIR="$R/run" OSI_BACKEND_WAIT_SECONDS=2
}
# 1. default is node-red; switching to edge stops+disables node-red before enabling+starting edge
setup 1
[ "$("$BIN" status | head -n1)" = node-red ] || fail "default choice"
"$BIN" use edge 2>/dev/null
[ "$(cat "$R/etc/osi-backend")" = edge ] || fail "choice not recorded"
[ "$(tr '\n' ' ' < "$R/calls")" = "tls_check osi-edge stop node-red disable node-red enable osi-edge start osi-edge " ] || fail "order: $(cat "$R/calls")"
[ -e "$R/run/edge" ] && [ ! -e "$R/run/node-red" ] || fail "end state"
# 2. and back
: > "$R/calls"; "$BIN" use node-red 2>/dev/null
[ "$(tr '\n' ' ' < "$R/calls")" = "stop osi-edge disable osi-edge enable node-red start node-red " ] || fail "rollback order: $(cat "$R/calls")"
# 3. a backend that does not stop blocks the start of the other one
setup 3; touch "$R/run/node-red.stuck"
if "$BIN" use edge 2>/dev/null; then fail "started while node-red still runs"; fi
grep -q "start osi-edge" "$R/calls" && fail "edge started"
[ "$(cat "$R/etc/osi-backend")" = edge ] || fail "choice should still be recorded for the next attempt"
# 4. unknown backend and a missing init script change nothing
setup 4
if "$BIN" use rust 2>/dev/null; then fail "unknown accepted"; fi
rm "$R/etc/init.d/osi-edge"
if "$BIN" use edge 2>/dev/null; then fail "missing init accepted"; fi
[ ! -e "$R/etc/osi-backend" ] && [ ! -e "$R/calls" ] || fail "changed something"
# 5. a concurrent run is refused
setup 5; exec 8>"$R/var/lock/osi-backend.lock"; flock -n 8
set +e; "$BIN" use edge 2>/dev/null; rc=$?; set -e
[ "$rc" = 75 ] || fail "lock not honoured (rc=$rc)"
# 6. a failed cloud broker TLS verification refuses the switch: the choice
#    file and both services stay untouched; the switch back needs no check
setup 6; touch "$R/tls-fail"; echo node-red > "$R/etc/osi-backend"
set +e; msg=$("$BIN" use edge 2>&1); rc=$?; set -e
[ "$rc" = 1 ] || fail "TLS failure not refused (rc=$rc)"
[ "$(cat "$R/etc/osi-backend")" = node-red ] || fail "choice file changed"
[ "$(cat "$R/calls")" = "tls_check osi-edge" ] || fail "services touched: $(cat "$R/calls")"
[ -e "$R/run/node-red" ] && [ ! -e "$R/run/edge" ] || fail "running state changed"
[ "$(printf '%s\n' "$msg" | wc -l)" = 1 ] || fail "message is not one line: $msg"
case "$msg" in *"edge refused: cloud broker TLS verification failed"*"still on node-red"*) ;; *) fail "message: $msg" ;; esac
: > "$R/calls"; rm "$R/run/node-red"; touch "$R/run/edge"; echo edge > "$R/etc/osi-backend"
"$BIN" use node-red 2>/dev/null
grep -q tls_check "$R/calls" && fail "the switch to node-red ran the check"
# The runner can hold the database before an edge process is visible.
setup 7
rm "$R/run/node-red"
echo edge > "$R/etc/osi-backend"
(
    exec 7>"$R/var/lock/osi-edge-boot.lock"
    flock -n 7
    if OSI_BACKEND_WAIT_SECONDS=0 "$BIN" use node-red 2>"$R/switch-log"; then
        fail "Node-RED started during the edge boot runner"
    fi
    grep -Fq 'edge boot runner still holds the database' "$R/switch-log"
    [ ! -e "$R/run/node-red" ] || fail "Node-RED process marker exists"
)
"$BIN" use node-red 2>/dev/null
[ -e "$R/run/node-red" ] || fail "switch retry after the boot runner"
echo "osi-backend tests: PASS"
