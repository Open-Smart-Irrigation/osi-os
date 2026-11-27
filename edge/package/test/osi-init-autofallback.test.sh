#!/bin/sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PACKAGE="$HERE/.."
REPO=$(cd "$HERE/../../.." && pwd)
SCRATCH="${OSI_TEST_SCRATCH:?set OSI_TEST_SCRATCH to an existing directory}"
root=$(mktemp -d "$SCRATCH/osi-init-autofallback.XXXXXX")
trap 'rm -rf "$root"' EXIT
mkdir "$root/bin"
export PATH="$root/bin:$PATH" OSI_BACKEND_WAIT_SECONDS=2
BIN="$PACKAGE/files/usr/sbin/osi-backend"
REAL_NODE=$(command -v node)

cat > "$root/bin/logger" <<'STUB'
#!/bin/sh
if [ "$#" -eq 2 ]; then cat; else printf '%s\n' "$*"; fi >> "$CASE_ROOT/log"
STUB
cat > "$root/bin/node" <<'STUB'
#!/bin/sh
echo runner >> "$CASE_ROOT/calls"
case "$RUNNER_MODE" in
    refuse) exit 2 ;;
    crash) kill -TERM "$$" ;;
    timeout) exec sleep 15 ;;
esac
STUB
chmod +x "$root/bin/logger" "$root/bin/node"

for RUNNER_MODE in refuse crash timeout failed-start; do
    CASE_ROOT="$root/$RUNNER_MODE"
    export CASE_ROOT RUNNER_MODE OSI_BACKEND_ROOT="$CASE_ROOT" OSI_BACKEND_RUNNING_DIR="$CASE_ROOT/run"
    mkdir -p "$CASE_ROOT/etc/init.d" "$CASE_ROOT/var/run" "$CASE_ROOT/var/lock" "$CASE_ROOT/run"
    echo edge > "$CASE_ROOT/etc/osi-backend"
    # Model an existing Go process with both broker sessions open.
    touch "$CASE_ROOT/run/edge" "$CASE_ROOT/edge.enabled"
    sed -e "s|/etc/osi-backend|$CASE_ROOT/etc/osi-backend|g" \
        -e "s|/var/|$CASE_ROOT/var/|g" \
        -e "s|/data/db/|$CASE_ROOT/data/db/|g" \
        -e "s|/usr/libexec/osi-gateway-identity.sh|$CASE_ROOT/missing-identity-helper|g" \
        -e "s|/usr/sbin/osi-backend|$BIN|g" \
        "$PACKAGE/files/etc/init.d/osi-edge" > "$CASE_ROOT/init"
    cat > "$CASE_ROOT/etc/init.d/osi-edge" <<'STUB'
#!/bin/sh
uci() { case "$*" in *edge_boot_timeout_seconds) echo 1 ;; *) return 1 ;; esac; }
pgrep() { [ -e "$CASE_ROOT/run/node-red" ]; }
procd_open_instance() { touch "$CASE_ROOT/run/edge"; }
procd_set_param() { :; }
procd_close_instance() { :; }
. "$CASE_ROOT/init"
case "$1" in
    start) start_service ;;
    stop) rm -f "$CASE_ROOT/run/edge" ;;
    enable) touch "$CASE_ROOT/edge.enabled" ;;
    disable) rm -f "$CASE_ROOT/edge.enabled" ;;
esac
STUB
    cat > "$CASE_ROOT/etc/init.d/node-red" <<'STUB'
#!/bin/sh
case "$1" in
    start)
        echo node-red-start >> "$CASE_ROOT/calls"
        [ ! -e "$CASE_ROOT/run/edge" ] || exit 99
        if [ -e "$CASE_ROOT/fail-start" ]; then exit 0; fi
        touch "$CASE_ROOT/run/node-red"
        ;;
    stop) rm -f "$CASE_ROOT/run/node-red" ;;
    enable) touch "$CASE_ROOT/node-red.enabled" ;;
    disable) rm -f "$CASE_ROOT/node-red.enabled" ;;
esac
STUB
    chmod +x "$CASE_ROOT/etc/init.d/"*
    scenario=$RUNNER_MODE
    if [ "$scenario" = failed-start ]; then
        touch "$CASE_ROOT/fail-start"
        export RUNNER_MODE=refuse
    fi
    start=$(date +%s)
    if "$CASE_ROOT/etc/init.d/osi-edge" start; then
        echo "FAIL: $scenario allowed Go startup" >&2
        exit 1
    fi
    # One-second runner deadline, one-second worker polling and two seconds
    # for stub readiness, with remaining time for process scheduling and sync.
    until grep -Eq 'now node-red|automatic Node-RED fallback failed' "$CASE_ROOT/log"; do
        if [ "$(($(date +%s) - start))" -ge 8 ]; then
            cat "$CASE_ROOT/log" >&2
            echo "FAIL: $scenario exceeded eight seconds" >&2
            exit 1
        fi
        sleep 0.1
    done
    [ "$(cat "$CASE_ROOT/etc/osi-backend")" = node-red ]
    [ ! -e "$CASE_ROOT/run/edge" ]
    [ "$(grep -cx node-red-start "$CASE_ROOT/calls")" -eq 1 ]
    status=$("$BIN" status)
    case "$scenario" in
        refuse|failed-start) exit_code=2 ;;
        crash) exit_code=143 ;;
        timeout) exit_code=137 ;;
    esac
    printf '%s\n' "$status" | grep -Eq "^[0-9T:Z-]+ runner_exit=$exit_code reason=boot-runner previous=edge detail="
    if [ "$scenario" = failed-start ]; then
        grep -Fq 'Node-RED did not come up' "$CASE_ROOT/log"
        sleep 2
        [ "$(grep -cx node-red-start "$CASE_ROOT/calls")" -eq 1 ]
        [ ! -e "$CASE_ROOT/run/node-red" ]
        [ ! -e "$CASE_ROOT/run/edge" ]
    else
        [ -e "$CASE_ROOT/run/node-red" ]
        # Reboot loses process state and /var/run, but preserves the choice.
        rm "$CASE_ROOT/run/node-red" "$CASE_ROOT/var/run/osi-edge-boot.failed"
        [ ! -e "$CASE_ROOT/edge.enabled" ]
        [ -e "$CASE_ROOT/node-red.enabled" ]
        "$CASE_ROOT/etc/init.d/node-red" start
        "$CASE_ROOT/etc/init.d/osi-edge" start
        [ "$(grep -cx runner "$CASE_ROOT/calls")" -eq 1 ]
        [ ! -e "$CASE_ROOT/run/edge" ]
        [ -e "$CASE_ROOT/run/node-red" ]
        export RUNNER_MODE=ok
        "$BIN" use edge
        [ -e "$CASE_ROOT/run/edge" ]
        [ ! -e "$CASE_ROOT/run/node-red" ]
        [ ! -e "$CASE_ROOT/data/osi-backend/fallback.log" ]
        [ -s "$CASE_ROOT/data/osi-backend/fallback.log.previous" ]
    fi
    echo "$scenario: PASS (eight-second bound)"
done

"$REAL_NODE" - "$REPO" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const root = process.argv[2];
const read = path => fs.readFileSync(root + '/' + path, 'utf8');
for (const profile of ['bcm2709', 'bcm2712']) {
    const flows = JSON.parse(read(`conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`));
    for (const [id, version] of [['nodered', '4'], ['device_${DEVICE_EUI}', '5']]) {
        const broker = flows.find(node => node.type === 'mqtt-broker' && node.clientid === id);
        assert.equal(broker.protocolVersion, version);
        assert.equal(broker.cleansession, false);
    }
}
assert.match(read('edge/go/cmd/osi-edge/main.go'), /ingest\.Start\(ctx, broker, "nodered",/);
assert.match(read('edge/go/internal/ingest/ingest.go'), /SetProtocolVersion\(4\)\.SetCleanSession\(false\)/);
assert.match(read('edge/go/cmd/osi-edge/cloud_connect.go'), /next\.ClientID = "device_" \+ eui/);
assert.match(read('edge/go/cmd/osi-edge/main.go'), /cloudmqtt\.Start\(ctx, beforeDial, broker, connect\.ClientID, connect\.User, connect\.Password,/);
assert.match(read('edge/go/internal/cloudmqtt/client.go'), /ClientID:\s*clientID,/);
// The cloud client uses the MQTT 5 autopaho defaults pinned by its wire test.
assert.match(read('edge/go/internal/cloudmqtt/wire_test.go'), /c.ProtocolVersion != 5 \|\| c.CleanStart/);
JS
echo 'init autofallback tests: PASS (process handoff and MQTT client settings)'
