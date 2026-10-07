#!/bin/sh
# node-red.init derives the cloud MQTT broker URL from the gateway's own
# configuration and exports it as OSI_CLOUD_BROKER_URL. flows.json carries
# "${OSI_CLOUD_BROKER_URL}" in the "OSI Cloud Broker" node and Node-RED
# substitutes it at start.
#
# Precedence: osi-server.cloud.mqtt_broker_url (written at account link),
# then wss://<osi-server.cloud.server_host>/mqtt, then the built-in default.
# The default must stay byte-identical to the URL flows.json carried before,
# so a gateway with neither key set behaves exactly as before.
#
# Run from the repository root: sh scripts/test-node-red-init-cloud-broker.sh

set -eu

INIT="feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init"
DEFAULT_URL="wss://server.opensmartirrigation.org/mqtt"
PLACEHOLDER='${OSI_CLOUD_BROKER_URL}'

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

assert_eq() {
    [ "$2" = "$1" ] || fail "$3: expected '$1', got '$2'"
}

[ -f "$INIT" ] || fail "run from the repository root ($INIT not found)"
# The node id start_service() patches, read from the init itself.
BROKER_NODE_ID="$(sed -n 's/^ *local cloud_broker_node_id="\([^"]*\)".*/\1/p' "$INIT")"
[ -n "$BROKER_NODE_ID" ] || fail "cloud_broker_node_id not found in $INIT"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/osi-cloud-broker-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT INT TERM

# Copy the init and move every absolute path it writes to into the sandbox.
sed \
    -e "s#/srv/#$SANDBOX/srv/#g" \
    -e "s#/data/#$SANDBOX/data/#g" \
    -e "s#/var/run/#$SANDBOX/var/run/#g" \
    -e "s#/usr/libexec/#$SANDBOX/usr/libexec/#g" \
    "$INIT" > "$SANDBOX/node-red.init"

# ---------------------------------------------------------------------------
# Part 1: the resolver on its own.
# ---------------------------------------------------------------------------
(
    . "$SANDBOX/node-red.init"
    logger() { :; }

    resolve_cloud_broker_url "" ""
    assert_eq "$DEFAULT_URL" "$CLOUD_BROKER_URL" "nothing configured: default URL"
    assert_eq "default" "$CLOUD_BROKER_URL_SOURCE" "nothing configured: source"

    resolve_cloud_broker_url "" "server.opensmartirrigation.org"
    assert_eq "$DEFAULT_URL" "$CLOUD_BROKER_URL" "default host configured: same URL as before"
    assert_eq "server_host" "$CLOUD_BROKER_URL_SOURCE" "default host configured: source"

    resolve_cloud_broker_url "" "cloud.example.org"
    assert_eq "wss://cloud.example.org/mqtt" "$CLOUD_BROKER_URL" "server_host derives wss://<host>/mqtt"
    assert_eq "server_host" "$CLOUD_BROKER_URL_SOURCE" "server_host: source"

    resolve_cloud_broker_url "" "cloud.example.org:8443"
    assert_eq "wss://cloud.example.org:8443/mqtt" "$CLOUD_BROKER_URL" "server_host with a port keeps the port"

    resolve_cloud_broker_url "wss://broker.example.net/mqtt" "cloud.example.org"
    assert_eq "wss://broker.example.net/mqtt" "$CLOUD_BROKER_URL" "mqtt_broker_url wins over server_host"
    assert_eq "mqtt_broker_url" "$CLOUD_BROKER_URL_SOURCE" "mqtt_broker_url: source"

    resolve_cloud_broker_url "ftp://broker.example.net/mqtt" "cloud.example.org"
    assert_eq "wss://cloud.example.org/mqtt" "$CLOUD_BROKER_URL" "unusable mqtt_broker_url falls through to server_host"

    resolve_cloud_broker_url "" "https://cloud.example.org/api"
    assert_eq "$DEFAULT_URL" "$CLOUD_BROKER_URL" "server_host that is not a bare host falls back to the default"
    assert_eq "default" "$CLOUD_BROKER_URL_SOURCE" "invalid server_host: source"

    resolve_cloud_broker_url "" "cloud example.org"
    assert_eq "$DEFAULT_URL" "$CLOUD_BROKER_URL" "server_host with a space falls back to the default"
) || exit 1

# ---------------------------------------------------------------------------
# Part 2: start_service() exports the derived URL and leaves the placeholder
# in flows.json alone; an older flows.json with a literal URL (a rollback
# payload) gets the derived URL written, as the init did before.
# ---------------------------------------------------------------------------
cat > "$SANDBOX/harness.sh" <<'HARNESS'
. "$INIT_PATH"

uci() {
    if [ "$1" = "-q" ] && [ "$2" = "get" ]; then
        case "$3" in
            osi-server.cloud.mqtt_broker_url)
                [ -n "$TEST_MQTT_BROKER_URL" ] || return 1
                printf '%s\n' "$TEST_MQTT_BROKER_URL"; return 0 ;;
            osi-server.cloud.server_host)
                [ -n "$TEST_SERVER_HOST" ] || return 1
                printf '%s\n' "$TEST_SERVER_HOST"; return 0 ;;
            *) return 1 ;;
        esac
    fi
    return 1
}
logger() { printf '%s\n' "$*" >> "$TEST_LOGGER_LOG"; }
gateway_identity_heal() { return 0; }
gateway_identity_resolve() { return 0; }
normalize_gateway_eui() { printf '%s' "$1"; }
procd_open_instance() { :; }
procd_close_instance() { :; }
procd_set_param() {
    if [ "$1" = "env" ]; then
        shift
        : > "$TEST_ENV_LOG"
        for kv in "$@"; do printf '%s\n' "$kv" >> "$TEST_ENV_LOG"; done
    fi
}

start_service
HARNESS

write_flows() {
    mkdir -p "$SANDBOX/srv/node-red"
    printf '[{"id":"%s","type":"mqtt-broker","name":"OSI Cloud Broker","broker":"%s","port":"443","clientid":"device_${DEVICE_EUI}"}]\n' \
        "$BROKER_NODE_ID" "$1" > "$SANDBOX/srv/node-red/flows.json"
}

broker_field() {
    node -e '
const flows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const node = flows.find((n) => n && n.id === process.argv[2]);
process.stdout.write(node ? String(node.broker) : "<missing>");
' "$SANDBOX/srv/node-red/flows.json" "$BROKER_NODE_ID"
}

run_start() {
    : > "$SANDBOX/env.log"
    : > "$SANDBOX/logger.log"
    INIT_PATH="$SANDBOX/node-red.init" \
    TEST_MQTT_BROKER_URL="$1" \
    TEST_SERVER_HOST="$2" \
    TEST_ENV_LOG="$SANDBOX/env.log" \
    TEST_LOGGER_LOG="$SANDBOX/logger.log" \
    GATEWAY_IDENTITY_DEVICE_EUI="0016C001F1000001" \
        sh "$SANDBOX/harness.sh" >/dev/null 2>"$SANDBOX/stderr.log" \
        || fail "start_service exited nonzero: $(cat "$SANDBOX/stderr.log")"
}

exported_url() {
    sed -n 's/^OSI_CLOUD_BROKER_URL=//p' "$SANDBOX/env.log"
}

write_flows "$PLACEHOLDER"
run_start "" ""
assert_eq "$DEFAULT_URL" "$(exported_url)" "start_service, nothing configured: exported default"
assert_eq "$PLACEHOLDER" "$(broker_field)" "start_service keeps the placeholder in flows.json"
grep -q "cloud MQTT broker $DEFAULT_URL source=default" "$SANDBOX/logger.log" \
    || fail "start_service logs the broker URL and its source: $(cat "$SANDBOX/logger.log")"

write_flows "$PLACEHOLDER"
run_start "" "cloud.example.org"
assert_eq "wss://cloud.example.org/mqtt" "$(exported_url)" "start_service exports the URL derived from server_host"
assert_eq "$PLACEHOLDER" "$(broker_field)" "start_service with server_host keeps the placeholder"

write_flows "$PLACEHOLDER"
run_start "wss://broker.example.net/mqtt" "cloud.example.org"
assert_eq "wss://broker.example.net/mqtt" "$(exported_url)" "start_service exports mqtt_broker_url first"
assert_eq "$PLACEHOLDER" "$(broker_field)" "start_service with mqtt_broker_url keeps the placeholder"

write_flows "$DEFAULT_URL"
run_start "" "cloud.example.org"
assert_eq "wss://cloud.example.org/mqtt" "$(broker_field)" "older flows.json with a literal URL gets the derived URL"

write_flows "$DEFAULT_URL"
run_start "" ""
assert_eq "$DEFAULT_URL" "$(broker_field)" "older flows.json, nothing configured: unchanged"

printf 'PASS: node-red.init cloud broker URL resolution and export\n'
