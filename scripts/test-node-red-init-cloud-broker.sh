#!/bin/sh
# node-red.init derives the cloud MQTT broker URL from the gateway's own
# configuration and exports it as OSI_CLOUD_BROKER_URL. flows.json carries
# "${OSI_CLOUD_BROKER_URL}" in the "OSI Cloud Broker" node and Node-RED
# substitutes it at start.
#
# Precedence for a linked gateway: osi-server.cloud.mqtt_broker_url (written
# at account link), then wss://<osi-server.cloud.server_host>/mqtt, then the
# built-in default, byte-identical to the URL flows.json carried before.
# An unlinked gateway (no mqtt_password) gets a name that never resolves, no
# cloud broker credentials and auto-connect off (#766).
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
# in flows.json alone. An older flows.json with a literal URL (a rollback
# payload) gets the derived URL written only when UCI supplied it; with
# nothing usable in UCI the literal stays, as on main before this change.
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
            osi-server.cloud.mqtt_password)
                [ -n "$TEST_MQTT_PASSWORD" ] || return 1
                printf '%s\n' "$TEST_MQTT_PASSWORD"; return 0 ;;
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
    printf '[{"id":"%s","type":"mqtt-broker","name":"OSI Cloud Broker","broker":"%s","port":"443","clientid":"device_${DEVICE_EUI}"},{"id":"fixture","type":"tab"},{"id":"route","type":"http in","z":"fixture","url":"/api/fixture","method":"get"}]\n' \
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
    TEST_MQTT_PASSWORD="${3-linked-secret}" \
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

CUSTOM_LITERAL="wss://custom.example.org/mqtt"
write_flows "$CUSTOM_LITERAL"
run_start "" ""
assert_eq "$CUSTOM_LITERAL" "$(broker_field)" "older flows.json with a custom literal, nothing configured: unchanged"

write_flows "$CUSTOM_LITERAL"
run_start "" "https://custom.example.org/api"
assert_eq "$CUSTOM_LITERAL" "$(broker_field)" "older flows.json with a custom literal, unusable server_host: unchanged"
assert_eq "$DEFAULT_URL" "$(exported_url)" "unusable server_host: exported default"
grep -q "WARN.*server_host.*has a URL scheme" "$SANDBOX/logger.log" \
    || fail "unusable server_host logs a WARN naming its shape: $(cat "$SANDBOX/logger.log")"
if grep -q "custom.example.org" "$SANDBOX/logger.log"; then
    fail "the WARN must not print the rejected server_host value: $(cat "$SANDBOX/logger.log")"
fi

write_flows "$CUSTOM_LITERAL"
run_start "" "cloud example.org"
grep -q "WARN.*server_host.*contains whitespace" "$SANDBOX/logger.log" \
    || fail "server_host with a space logs its shape: $(cat "$SANDBOX/logger.log")"

write_flows "$PLACEHOLDER"
run_start "wss://gwuser:s3cret@broker.example.net/mqtt" ""
assert_eq "wss://gwuser:s3cret@broker.example.net/mqtt" "$(exported_url)" "URL with userinfo is exported unchanged"
if grep -q "s3cret\|gwuser" "$SANDBOX/logger.log"; then
    fail "the start log must not print URL credentials: $(cat "$SANDBOX/logger.log")"
fi
grep -q "cloud MQTT broker wss://\*\*\*@broker.example.net/mqtt source=mqtt_broker_url" "$SANDBOX/logger.log" \
    || fail "the start log masks userinfo: $(cat "$SANDBOX/logger.log")"

# ---------------------------------------------------------------------------
# Part 3 (#766): an unlinked gateway gets no cloud broker. Its credentials
# leave flows_cred.json (other entries stay, mode 0600), the exported
# OSI_CLOUD_BROKER_AUTOCONNECT is false and the exported URL never resolves.
# Relinking restores all three. No start rewrites the shipped flows.json, so
# the payload keeps its recorded flows_sha256 and stays a rollback target.
# ---------------------------------------------------------------------------
UNLINKED_URL="wss://unlinked.invalid/mqtt"
AUTOCONNECT_PLACEHOLDER='${OSI_CLOUD_BROKER_AUTOCONNECT}'
CRED="$SANDBOX/srv/node-red/flows_cred.json"
SHIPPED_FLOWS="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"

exported_autoconnect() {
    sed -n 's/^OSI_CLOUD_BROKER_AUTOCONNECT=//p' "$SANDBOX/env.log"
}
shipped_autoconnect() {
    node -e '
const flows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const node = flows.find((n) => n && n.id === process.argv[2]);
process.stdout.write(node ? String(node.autoConnect) : "<missing>");
' "$SHIPPED_FLOWS" "$BROKER_NODE_ID"
}
flows_hash() {
    sha256sum "$SANDBOX/srv/node-red/flows.json" | cut -d' ' -f1
}
cred_keys() {
    node -e '
const creds = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(Object.keys(creds).sort().map((k) => k + "{" + Object.keys(creds[k]).sort().join(",") + "}").join(" "));
' "$CRED"
}
cred_mode() {
    stat -c '%a' "$CRED"
}
write_creds() {
    printf '{"%s":{"user":"0016C001F1000001","password":"old-secret"},"agroscope-mqtt-broker":{"user":"a","password":"b"}}' "$BROKER_NODE_ID" > "$CRED"
    chmod 644 "$CRED"
}

assert_eq "$AUTOCONNECT_PLACEHOLDER" "$(shipped_autoconnect)" "shipped flows.json reads auto-connect from the environment"

# The shipped flows.json, after its first start on this gateway (which
# settles the client id), is what a deploy records in flows_sha256.
mkdir -p "$SANDBOX/srv/node-red"
cp "$SHIPPED_FLOWS" "$SANDBOX/srv/node-red/flows.json"
run_start "wss://broker.example.net/mqtt" "cloud.example.org" "linked-secret"
assert_eq "true" "$(exported_autoconnect)" "linked: auto-connect exported true"
RECORDED="$(flows_hash)"

write_creds
run_start "wss://broker.example.net/mqtt" "cloud.example.org" ""
assert_eq "$UNLINKED_URL" "$(exported_url)" "unlinked: exports the name that never resolves, not the default cloud"
grep -q "cloud MQTT broker $UNLINKED_URL source=unlinked" "$SANDBOX/logger.log" \
    || fail "unlinked start logs source=unlinked: $(cat "$SANDBOX/logger.log")"
assert_eq "false" "$(exported_autoconnect)" "unlinked: auto-connect exported false"
assert_eq "agroscope-mqtt-broker{password,user}" "$(cred_keys)" "unlinked: cloud broker credentials removed, other entries kept"
assert_eq "600" "$(cred_mode)" "unlinked: credential file mode 0600"
grep -q "^DEVICE_MQTT_PASSWORD=$" "$SANDBOX/env.log" || fail "unlinked: DEVICE_MQTT_PASSWORD exported empty"
if grep -q "old-secret" "$SANDBOX/logger.log" "$SANDBOX/env.log"; then fail "the old password must not appear in logs or env"; fi
assert_eq "$RECORDED" "$(flows_hash)" "unlink leaves the flows.json bytes unchanged"

# A blank password counts as unlinked, as in osi-cloud-http.
run_start "" "" "   "
assert_eq "false" "$(exported_autoconnect)" "blank password: unlinked"
assert_eq "$UNLINKED_URL" "$(exported_url)" "blank password: unlinked URL"

# A restart while still unlinked changes nothing.
cp "$CRED" "$SANDBOX/cred.before"
run_start "" "" ""
cmp -s "$CRED" "$SANDBOX/cred.before" || fail "unlinked restart rewrites flows_cred.json"
assert_eq "$RECORDED" "$(flows_hash)" "unlinked restart leaves the flows.json bytes unchanged"

# A deploy may restore an old credential file; the next start removes it again.
write_creds
run_start "" "" ""
assert_eq "agroscope-mqtt-broker{password,user}" "$(cred_keys)" "unlinked after a deploy: cloud credentials removed again"
assert_eq "$RECORDED" "$(flows_hash)" "unlinked after a deploy: flows.json bytes unchanged"

# Relink: credentials, auto-connect and the broker URL come back.
run_start "wss://broker.example.net/mqtt" "cloud.example.org" "new-secret"
assert_eq "wss://broker.example.net/mqtt" "$(exported_url)" "relinked: exports the linked broker URL"
assert_eq "true" "$(exported_autoconnect)" "relinked: auto-connect exported true"
assert_eq "agroscope-mqtt-broker{password,user} $BROKER_NODE_ID{password,user}" "$(cred_keys)" "relinked: cloud broker credentials written"
node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
if (c.password !== "new-secret" || c.user !== "0016C001F1000001") process.exit(1);
' "$CRED" "$BROKER_NODE_ID" || fail "relinked: credentials carry the new password"
assert_eq "$RECORDED" "$(flows_hash)" "relink leaves the flows.json bytes unchanged"

# An older flows.json (a rollback payload) with the default literal is not
# rewritten while unlinked; the guard and the removed credentials cover it.
write_flows "$DEFAULT_URL"
run_start "" "" "linked-secret"
OLDER="$(flows_hash)"
run_start "" "" ""
assert_eq "$DEFAULT_URL" "$(broker_field)" "unlinked, older flows.json literal: left as it is"
assert_eq "$OLDER" "$(flows_hash)" "unlinked, older flows.json: bytes unchanged"

printf 'PASS: node-red.init cloud broker URL resolution and export\n'
