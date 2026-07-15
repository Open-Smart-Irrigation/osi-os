#!/bin/sh

set -eu

DAEMON="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh"

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

assert_eq() {
    local expected actual label
    expected="$1"
    actual="$2"
    label="$3"
    [ "$actual" = "$expected" ] || fail "$label: expected '$expected', got '$actual'"
}

assert_file_exists() {
    [ -f "$1" ] || fail "$2: missing $1"
}

assert_file_absent() {
    if [ -e "$1" ] || [ -L "$1" ]; then
        fail "$2: unexpected $1"
    fi
}

assert_contains() {
    local haystack needle label
    haystack="$1"
    needle="$2"
    label="$3"
    case "$haystack" in
        *"$needle"*) ;;
        *) fail "$label: missing '$needle'" ;;
    esac
}

json_value() {
    local file key
    file="$1"
    key="$2"
    node -e '
        const fs = require("fs");
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
        process.stdout.write(value === null ? "null" : String(value));
    ' "$file" "$key"
}

[ -f "$DAEMON" ] || fail "osi-identityd.sh is absent"
grep -qx 'CONFIG_PACKAGE_jsonfilter=y' openwrt/osi-os.config || \
    fail "firmware configuration does not include jsonfilter"

TEST_ROOT="$(mktemp -d)"
LOCK_HOLDER_PID=""
LOCK_CONTENDER_PID=""
cleanup() {
    if [ -n "$LOCK_HOLDER_PID" ]; then
        kill "$LOCK_HOLDER_PID" 2>/dev/null || true
        wait "$LOCK_HOLDER_PID" 2>/dev/null || true
    fi
    if [ -n "$LOCK_CONTENDER_PID" ]; then
        kill "$LOCK_CONTENDER_PID" 2>/dev/null || true
        wait "$LOCK_CONTENDER_PID" 2>/dev/null || true
    fi
    rm -rf "$TEST_ROOT"
}
trap cleanup 0 1 2 15

cat > "$TEST_ROOT/identity-helper.sh" <<'EOF'
#!/bin/sh

normalize_gateway_eui() {
    local raw
    raw="$(printf '%s' "$1" | tr -cd '0-9A-Fa-f' | tr 'abcdef' 'ABCDEF')"
    [ "${#raw}" -eq 16 ] || return 1
    [ "$raw" != "0101010101010101" ] || return 1
    printf '%s\n' "$raw"
}

gateway_identity_test_load() {
    local record
    record="$1"
    IFS='|' read -r \
        GATEWAY_IDENTITY_DEVICE_EUI \
        GATEWAY_IDENTITY_DEVICE_EUI_SOURCE \
        GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE \
        GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT < "$record"
}

gateway_identity_resolve() {
    printf '%s\n' "resolve" >> "$IDENTITYD_TEST_STATE_DIR/helper.log"
    [ -f "$IDENTITYD_TEST_STATE_DIR/resolve" ] || return 1
    gateway_identity_test_load "$IDENTITYD_TEST_STATE_DIR/resolve"
}

gateway_identity_heal() {
    printf '%s\n' "heal" >> "$IDENTITYD_TEST_STATE_DIR/helper.log"
    if [ -f "$OSI_IDENTITY_RUN_DIR/osi-identity-restart.json" ]; then
        cp "$OSI_IDENTITY_RUN_DIR/osi-identity-restart.json" \
            "$IDENTITYD_TEST_STATE_DIR/sentinel-at-heal"
    fi
    [ "$(cat "$IDENTITYD_TEST_STATE_DIR/heal-status")" -eq 0 ] || return 1
    gateway_identity_test_load "$IDENTITYD_TEST_STATE_DIR/heal-final"
    cp "$IDENTITYD_TEST_STATE_DIR/heal-persist-eui" "$IDENTITYD_TEST_STATE_DIR/uci-device-eui"
    cp "$IDENTITYD_TEST_STATE_DIR/heal-persist-confidence" "$IDENTITYD_TEST_STATE_DIR/uci-confidence"
    printf '%s\n' "$GATEWAY_IDENTITY_DEVICE_EUI_SOURCE" > "$IDENTITYD_TEST_STATE_DIR/uci-source"
    printf '%s\n' "$GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT" > "$IDENTITYD_TEST_STATE_DIR/uci-verified"
}
EOF

cat > "$TEST_ROOT/date" <<'EOF'
#!/bin/sh

printf '%s\n' "$*" >> "$IDENTITYD_TEST_STATE_DIR/date.log"
now="$(cat "$IDENTITYD_TEST_STATE_DIR/now")"
case "$*" in
    '+%s')
        printf '%s\n' "$now"
        ;;
    '-u +%Y-%m-%dT%H:%M:%SZ')
        /usr/bin/date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ
        ;;
    '-u -d @'*' +%Y-%m-%dT%H:%M:%SZ')
        epoch="${3#@}"
        /usr/bin/date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ
        ;;
    *)
        exit 2
        ;;
esac
EOF

cat > "$TEST_ROOT/uci" <<'EOF'
#!/bin/sh

[ "$1" = "-q" ] && shift
[ "$1" = "get" ] || exit 1
case "$2" in
    osi-server.cloud.device_eui)
        cat "$IDENTITYD_TEST_STATE_DIR/uci-device-eui"
        ;;
    osi-server.cloud.device_eui_source)
        cat "$IDENTITYD_TEST_STATE_DIR/uci-source"
        ;;
    osi-server.cloud.device_eui_confidence)
        cat "$IDENTITYD_TEST_STATE_DIR/uci-confidence"
        ;;
    osi-server.cloud.device_eui_last_verified_at)
        cat "$IDENTITYD_TEST_STATE_DIR/uci-verified"
        ;;
    osi-server.cloud.link_gateway_device_eui)
        cat "$IDENTITYD_TEST_STATE_DIR/uci-linked"
        ;;
    *)
        exit 1
        ;;
esac
EOF

cat > "$TEST_ROOT/jsonfilter" <<'EOF'
#!/bin/sh

input=""
expression=""
mode=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -i)
            input="$2"
            shift 2
            ;;
        -e)
            mode="value"
            expression="$2"
            shift 2
            ;;
        -t)
            mode="type"
            expression="$2"
            shift 2
            ;;
        *)
            exit 2
            ;;
    esac
done

node -e '
    const fs = require("fs");
    const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expression = process.argv[2];
    if (!expression.startsWith("@.")) process.exit(2);
    const key = expression.slice(2);
    if (!Object.prototype.hasOwnProperty.call(input, key)) process.exit(1);
    const value = input[key];
    if (process.argv[3] === "type") {
        let type;
        if (value === null) type = "null";
        else if (Array.isArray(value)) type = "array";
        else if (typeof value === "number") type = Number.isInteger(value) ? "int" : "double";
        else type = typeof value === "object" ? "object" : typeof value;
        process.stdout.write(type + "\n");
    } else if (value !== null) {
        if (["string", "number", "boolean"].includes(typeof value)) process.stdout.write(String(value) + "\n");
        else process.stdout.write(JSON.stringify(value) + "\n");
    }
' "$input" "$expression" "$mode"
EOF

cat > "$TEST_ROOT/node-red" <<'EOF'
#!/bin/sh

printf '%s\n' "$*" >> "$IDENTITYD_TEST_STATE_DIR/service.log"
exit "$(cat "$IDENTITYD_TEST_STATE_DIR/service-status")"
EOF

cat > "$TEST_ROOT/ln" <<'EOF'
#!/bin/sh

if [ "${IDENTITYD_TEST_PAUSE_LOCK_PUBLICATION:-0}" = "1" ] && [ "${1:-}" = "-s" ]; then
    : > "$IDENTITYD_TEST_STATE_DIR/lock-publication-paused"
    while [ ! -e "$IDENTITYD_TEST_STATE_DIR/release-lock-publication" ]; do
        sleep 1
    done
fi
exec /usr/bin/ln "$@"
EOF

cat > "$TEST_ROOT/registration" <<'EOF'
#!/bin/sh
printf '%s\n' "registration must not run in Task 2" >> "$IDENTITYD_TEST_STATE_DIR/registration.log"
exit 99
EOF

chmod 755 \
    "$TEST_ROOT/identity-helper.sh" \
    "$TEST_ROOT/date" \
    "$TEST_ROOT/jsonfilter" \
    "$TEST_ROOT/ln" \
    "$TEST_ROOT/uci" \
    "$TEST_ROOT/node-red" \
    "$TEST_ROOT/registration"

OSI_IDENTITY_HELPER="$TEST_ROOT/identity-helper.sh"
OSI_NODE_RED_SERVICE="$TEST_ROOT/node-red"
OSI_REGISTRATION_SCRIPT="$TEST_ROOT/registration"
PATH="$TEST_ROOT:$PATH"
export OSI_IDENTITY_HELPER OSI_NODE_RED_SERVICE OSI_REGISTRATION_SCRIPT PATH

. "$DAEMON"

identityd_now_uptime() {
    cat "$IDENTITYD_TEST_STATE_DIR/uptime"
}

FIXTURE_NUMBER=0
new_fixture() {
    FIXTURE_NUMBER=$((FIXTURE_NUMBER + 1))
    FIXTURE="$TEST_ROOT/fixture-$FIXTURE_NUMBER"
    IDENTITYD_TEST_STATE_DIR="$FIXTURE/state"
    OSI_IDENTITY_RUN_DIR="$FIXTURE/run"
    export IDENTITYD_TEST_STATE_DIR OSI_IDENTITY_RUN_DIR
    mkdir -p "$IDENTITYD_TEST_STATE_DIR" "$OSI_IDENTITY_RUN_DIR"
    : > "$IDENTITYD_TEST_STATE_DIR/helper.log"
    : > "$IDENTITYD_TEST_STATE_DIR/date.log"
    : > "$IDENTITYD_TEST_STATE_DIR/service.log"
    : > "$IDENTITYD_TEST_STATE_DIR/registration.log"
    : > "$IDENTITYD_TEST_STATE_DIR/uci-device-eui"
    : > "$IDENTITYD_TEST_STATE_DIR/uci-confidence"
    : > "$IDENTITYD_TEST_STATE_DIR/uci-source"
    : > "$IDENTITYD_TEST_STATE_DIR/uci-verified"
    : > "$IDENTITYD_TEST_STATE_DIR/uci-linked"
    printf '%s\n' "0" > "$IDENTITYD_TEST_STATE_DIR/heal-status"
    printf '%s\n' "0" > "$IDENTITYD_TEST_STATE_DIR/service-status"
    printf '%s\n' "1000" > "$IDENTITYD_TEST_STATE_DIR/now"
    printf '%s\n' "1000" > "$IDENTITYD_TEST_STATE_DIR/uptime"
    identityd_initialize
}

set_now() {
    printf '%s\n' "$1" > "$IDENTITYD_TEST_STATE_DIR/now"
    printf '%s\n' "$1" > "$IDENTITYD_TEST_STATE_DIR/uptime"
}

set_wall() {
    printf '%s\n' "$1" > "$IDENTITYD_TEST_STATE_DIR/now"
}

set_uptime() {
    printf '%s\n' "$1" > "$IDENTITYD_TEST_STATE_DIR/uptime"
}

set_uci_identity() {
    printf '%s\n' "$1" > "$IDENTITYD_TEST_STATE_DIR/uci-device-eui"
    printf '%s\n' "$2" > "$IDENTITYD_TEST_STATE_DIR/uci-confidence"
    printf '%s\n' "${3:-durable}" > "$IDENTITYD_TEST_STATE_DIR/uci-source"
    printf '%s\n' "${4:-2026-07-15T00:00:00Z}" > "$IDENTITYD_TEST_STATE_DIR/uci-verified"
}

set_linked_identity() {
    printf '%s\n' "$1" > "$IDENTITYD_TEST_STATE_DIR/uci-linked"
}

set_resolve() {
    printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" > "$IDENTITYD_TEST_STATE_DIR/resolve"
}

set_heal() {
    printf '%s\n' "$1" > "$IDENTITYD_TEST_STATE_DIR/heal-status"
    printf '%s|%s|%s|%s\n' "$2" "$3" "$4" "$5" > "$IDENTITYD_TEST_STATE_DIR/heal-final"
    printf '%s\n' "$6" > "$IDENTITYD_TEST_STATE_DIR/heal-persist-eui"
    printf '%s\n' "$7" > "$IDENTITYD_TEST_STATE_DIR/heal-persist-confidence"
}

write_cache() {
    local eui source confidence verified linked phase updated
    eui="$1"
    source="$2"
    confidence="$3"
    verified="$4"
    linked="$5"
    phase="$6"
    updated="$7"
    printf '{"deviceEui":"%s","source":"%s","confidence":"%s","lastVerifiedAt":"%s","linkGatewayDeviceEui":%s,"phase":"%s","updatedAt":"%s"}\n' \
        "$eui" "$source" "$confidence" "$verified" "$linked" "$phase" "$updated" \
        > "$OSI_IDENTITY_RUN_DIR/osi-gateway-identity.json"
}

write_sentinel() {
    local phase restart_at restart_epoch restart_uptime reason target requested
    phase="$1"
    restart_at="$2"
    restart_epoch="$3"
    if [ "$restart_epoch" = "null" ]; then
        restart_uptime="null"
    else
        restart_uptime="$restart_epoch"
    fi
    reason="$4"
    target="$5"
    requested="$6"
    printf '{"phase":"%s","restartAt":%s,"restartAtEpoch":%s,"restartNotBeforeUptime":%s,"reason":"%s","targetDeviceEui":%s,"requestedAt":"%s"}\n' \
        "$phase" "$restart_at" "$restart_epoch" "$restart_uptime" "$reason" "$target" "$requested" \
        > "$OSI_IDENTITY_RUN_DIR/osi-identity-restart.json"
}

request_restart() {
    "$DAEMON" request-restart "$1" "$2"
}

CACHE_NAME="osi-gateway-identity.json"
SENTINEL_NAME="osi-identity-restart.json"
REQUEST_DIR_NAME="osi-node-red-restart-requests"
COMPLETION_NAME="osi-identity-restart-complete.json"

# Match the pinned OpenWrt jsonfilter contract for nullable fields, then prove
# every daemon-generated nullable artifact can be loaded again.
new_fixture
identityd_write_cache \
    "0011223344556677" \
    "concentratord-runtime" \
    "authoritative" \
    "2026-07-15T00:00:00Z" \
    active
assert_eq "" \
    "$(jsonfilter -i "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME" -e '@.linkGatewayDeviceEui')" \
    "jsonfilter null value output"
assert_eq "null" \
    "$(jsonfilter -i "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME" -t '@.linkGatewayDeviceEui')" \
    "jsonfilter null type output"
if jsonfilter -i "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME" -t '@.missing' >/dev/null 2>&1; then
    fail "jsonfilter stub matched a missing field"
fi
identityd_load_cache || fail "daemon-generated nullable cache did not reload"
assert_eq "" "$IDENTITYD_CACHE_LINKED" "daemon-generated nullable cache link"

new_fixture
identityd_write_healing_sentinel \
    "8899AABBCCDDEEFF" \
    "2026-07-15T00:00:01Z"
identityd_load_sentinel || fail "daemon-generated healing sentinel did not reload"
assert_eq "healing" "$IDENTITYD_SENTINEL_PHASE" "daemon-generated healing phase"
assert_eq "" "$IDENTITYD_SENTINEL_RESTART_EPOCH" "daemon-generated healing restart epoch"
assert_eq "" "$IDENTITYD_SENTINEL_RESTART_UPTIME" "daemon-generated healing restart uptime"

new_fixture
identityd_write_pending_sentinel \
    account_link \
    "" \
    "2026-07-15T00:00:02Z" \
    1010 \
    1010
identityd_load_sentinel || fail "daemon-generated generic sentinel did not reload"
assert_eq "restart_pending" "$IDENTITYD_SENTINEL_PHASE" "daemon-generated generic phase"
assert_eq "" "$IDENTITYD_SENTINEL_TARGET" "daemon-generated generic target"

new_fixture
write_cache \
    "0011223344556677" \
    "concentratord-runtime" \
    "authoritative" \
    "2026-07-15T00:00:00Z" \
    false \
    active \
    "2026-07-15T00:00:03Z"
if identityd_load_cache; then
    fail "nullable cache field accepted a wrong type"
fi
printf '%s\n' \
    '{"deviceEui":"0011223344556677","source":"concentratord-runtime","confidence":"authoritative","lastVerifiedAt":"2026-07-15T00:00:00Z","phase":"active","updatedAt":"2026-07-15T00:00:03Z"}' \
    > "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME"
if identityd_load_cache; then
    fail "nullable cache field accepted a missing value"
fi

new_fixture
write_sentinel \
    restart_pending \
    '"1970-01-01T00:16:50Z"' \
    1010 \
    account_link \
    false \
    "2026-07-15T00:00:02Z"
if identityd_load_sentinel; then
    fail "nullable sentinel target accepted a wrong type"
fi

# 1. Provisional identity is cached without a sentinel and uses 10 s resolution
# cadence for 600 s, then 300 s while it remains provisional.
new_fixture
set_resolve "0011223344556677" "mac:eth0" "provisional" "2026-07-15T00:00:00Z"
identityd_control_tick
assert_eq "provisional" "$(json_value "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME" phase)" "scenario 1 provisional phase"
assert_eq "0011223344556677" "$(json_value "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME" deviceEui)" "scenario 1 cached EUI"
assert_file_absent "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" "scenario 1 sentinel"
assert_eq "1010" "$IDENTITYD_NEXT_RESOLVE_UPTIME" "scenario 1 initial cadence"
assert_eq "1000" "$IDENTITYD_PROVISIONAL_SINCE_UPTIME" "scenario 1 provisional start"
set_now 1599
IDENTITYD_NEXT_RESOLVE_UPTIME=1599
identityd_control_tick
assert_eq "1609" "$IDENTITYD_NEXT_RESOLVE_UPTIME" "scenario 1 cadence before 600 s"
set_now 1600
IDENTITYD_NEXT_RESOLVE_UPTIME=1600
identityd_control_tick
assert_eq "1900" "$IDENTITYD_NEXT_RESOLVE_UPTIME" "scenario 1 cadence after 600 s"

# 2. A same-EUI promotion from durable provisional state enters healing before
# the helper can make its first UCI mutation.
new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "0011223344556677" "concentratord-runtime" "authoritative" "2026-07-15T00:01:00Z"
set_heal 1 "0011223344556677" "concentratord-runtime" "authoritative" "2026-07-15T00:01:00Z" "0011223344556677" "authoritative"
identityd_control_tick
assert_file_exists "$IDENTITYD_TEST_STATE_DIR/sentinel-at-heal" "scenario 2 pre-heal sentinel"
assert_eq "healing" "$(json_value "$IDENTITYD_TEST_STATE_DIR/sentinel-at-heal" phase)" "scenario 2 pre-heal phase"
assert_eq "0011223344556677" "$(json_value "$IDENTITYD_TEST_STATE_DIR/sentinel-at-heal" targetDeviceEui)" "scenario 2 target"

# 3. A different authoritative EUI starts the same healing transition.
new_fixture
set_uci_identity "0011223344556677" "authoritative"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:02:00Z"
set_heal 1 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:02:00Z" "8899AABBCCDDEEFF" "authoritative"
identityd_control_tick
assert_eq "healing" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" "scenario 3 healing phase"
assert_eq "8899AABBCCDDEEFF" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" targetDeviceEui)" "scenario 3 target"

# 4. A failed heal keeps a deadline-free healing sentinel, schedules a 10 s
# retry, and does not restart Node-RED.
new_fixture
set_uci_identity "0011223344556677" "authoritative"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:03:00Z"
set_heal 1 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:03:00Z" "8899AABBCCDDEEFF" "authoritative"
identityd_control_tick
assert_eq "healing" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" "scenario 4 phase"
assert_eq "null" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAt)" "scenario 4 restart timestamp"
assert_eq "null" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 4 restart epoch"
assert_eq "1010" "$IDENTITYD_NEXT_RESOLVE_UPTIME" "scenario 4 retry cadence"
assert_eq "" "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" "scenario 4 restart log"

# 5. Heal exit 0 with a provisional final identity remains healing.
new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:04:00Z"
set_heal 0 "8899AABBCCDDEEFF" "mac:eth0" "provisional" "2026-07-15T00:04:01Z" "8899AABBCCDDEEFF" "provisional"
identityd_control_tick
assert_eq "healing" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" "scenario 5 phase"
assert_eq "null" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 5 deadline"
assert_eq "1010" "$IDENTITYD_NEXT_RESOLVE_UPTIME" "scenario 5 retry cadence"
assert_eq "" "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" "scenario 5 restart log"

# 6. Heal exit 0 with an exact durable readback mismatch remains healing.
new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:05:00Z"
set_heal 0 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:05:01Z" "0011223344556677" "authoritative"
identityd_control_tick
assert_eq "healing" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" "scenario 6 phase"
assert_eq "null" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 6 deadline"
assert_eq "1010" "$IDENTITYD_NEXT_RESOLVE_UPTIME" "scenario 6 retry cadence"

new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:05:02Z"
set_heal 0 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:05:03Z" "8899AABBCCDDEEFF" "Authoritative"
identityd_control_tick
assert_eq "healing" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" "scenario 6 exact confidence readback"
assert_eq "null" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 6 confidence deadline"

# Semantically equal but noncanonical durable UCI values still require a heal
# so the exact durable representation becomes uppercase/lowercase canonical.
new_fixture
set_uci_identity "88:99:aa:bb:cc:dd:ee:ff" "Authoritative"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:05:04Z"
set_heal 0 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:05:05Z" "8899AABBCCDDEEFF" "authoritative"
identityd_control_tick
assert_file_exists \
    "$IDENTITYD_TEST_STATE_DIR/sentinel-at-heal" \
    "noncanonical durable identity starts healing"
assert_eq "8899AABBCCDDEEFF" \
    "$(cat "$IDENTITYD_TEST_STATE_DIR/uci-device-eui")" \
    "healed durable EUI is canonical"
assert_eq "authoritative" \
    "$(cat "$IDENTITYD_TEST_STATE_DIR/uci-confidence")" \
    "healed durable confidence is canonical"
assert_eq "restart_pending" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" \
    "canonicalized identity restart phase"

# 7. A valid authoritative final EUI that differs from the detected target
# retargets the sentinel and schedules the final EUI.
new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "8899AABBCCDDEEFF" "concentratord-uci-sx1302" "authoritative" "2026-07-15T00:06:00Z"
set_heal 0 "AABBCCDDEEFF0011" "concentratord-runtime" "authoritative" "2026-07-15T00:06:01Z" "AABBCCDDEEFF0011" "authoritative"
identityd_control_tick
assert_eq "restart_pending" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" "scenario 7 phase"
assert_eq "AABBCCDDEEFF0011" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" targetDeviceEui)" "scenario 7 retarget"
assert_eq "1060" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 7 deadline"

# 8. A validated heal schedules now+60 and formats the deadline through
# `date -u -d @epoch`.
new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:07:00Z"
set_heal 0 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:07:01Z" "8899AABBCCDDEEFF" "authoritative"
identityd_control_tick
assert_eq "1060" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 8 epoch"
assert_eq "1970-01-01T00:17:40Z" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAt)" "scenario 8 timestamp"
assert_contains "$(cat "$IDENTITYD_TEST_STATE_DIR/date.log")" "-u -d @1060 +%Y-%m-%dT%H:%M:%SZ" "scenario 8 date invocation"

# 9. Startup with a deadline-free healing sentinel resumes heal and validation
# even when durable UCI already matches its target.
new_fixture
set_uci_identity "8899AABBCCDDEEFF" "authoritative"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:08:00Z"
set_heal 0 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:08:01Z" "8899AABBCCDDEEFF" "authoritative"
write_sentinel "healing" "null" "null" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:08:00Z"
identityd_initialize
identityd_control_tick
assert_contains "$(cat "$IDENTITYD_TEST_STATE_DIR/helper.log")" "heal" "scenario 9 resumed heal"
assert_eq "restart_pending" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" phase)" "scenario 9 phase"

# 10. A future identity restart deadline is retained without a second
# transition.
new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:09:00Z"
write_sentinel "restart_pending" '"1970-01-01T00:20:00Z"' "1200" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:09:00Z"
identityd_initialize
before="$(cat "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME")"
identityd_control_tick
assert_eq "$before" "$(cat "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME")" "scenario 10 retained sentinel"
assert_eq "" "$(cat "$IDENTITYD_TEST_STATE_DIR/helper.log")" "scenario 10 helper calls"

# 11. A due or overdue deadline restarts Node-RED on the next 1 s tick.
new_fixture
set_uci_identity "8899AABBCCDDEEFF" "authoritative" "concentratord-runtime" "2026-07-15T00:10:00Z"
write_cache "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:10:00Z" "null" "restart_pending" "2026-07-15T00:10:00Z"
write_sentinel "restart_pending" '"1970-01-01T00:16:39Z"' "999" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:10:00Z"
identityd_initialize
identityd_control_tick
assert_eq "restart" "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" "scenario 11 restart call"

# 12. Successful identity restart removes the sentinel and writes active;
# successful generic bootstrap restart may restore a provisional cache.
assert_file_absent "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" "scenario 12 identity sentinel"
assert_eq "active" "$(json_value "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME" phase)" "scenario 12 identity cache phase"

new_fixture
set_uci_identity "0011223344556677" "provisional" "mac:eth0" "2026-07-15T00:11:00Z"
write_cache "0011223344556677" "mac:eth0" "provisional" "2026-07-15T00:11:00Z" "null" "restart_pending" "2026-07-15T00:11:00Z"
write_sentinel "restart_pending" '"1970-01-01T00:16:39Z"' "999" "chirpstack_bootstrap" "null" "2026-07-15T00:11:00Z"
identityd_initialize
identityd_control_tick
assert_file_absent "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" "scenario 12 generic sentinel"
assert_eq "provisional" "$(json_value "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME" phase)" "scenario 12 generic cache phase"

# 13. Restart failure retains the sentinel, reschedules now+30, and creates no
# success stamp.
new_fixture
printf '%s\n' "1" > "$IDENTITYD_TEST_STATE_DIR/service-status"
set_uci_identity "8899AABBCCDDEEFF" "authoritative"
write_cache "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:12:00Z" "null" "restart_pending" "2026-07-15T00:12:00Z"
write_sentinel "restart_pending" '"1970-01-01T00:16:39Z"' "999" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:12:00Z"
identityd_initialize
identityd_control_tick
assert_file_exists "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" "scenario 13 retained sentinel"
assert_eq "1030" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 13 retry deadline"
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identity-restart-complete" "scenario 13 success stamp"
assert_file_absent "$OSI_IDENTITY_RUN_DIR/$COMPLETION_NAME" "scenario 13 completion marker"

new_fixture
set_uci_identity "8899AABBCCDDEEFF" "authoritative" "concentratord-runtime" "2026-07-15T00:12:10Z"
write_cache "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:12:10Z" "null" "restart_pending" "2026-07-15T00:12:10Z"
write_sentinel "restart_pending" '"1970-01-01T00:16:39Z"' "999" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:12:10Z"
identityd_initialize
identityd_remove_sentinel() {
    return 1
}
identityd_control_tick
assert_eq "1" \
    "$(grep -c '^restart$' "$IDENTITYD_TEST_STATE_DIR/service.log")" \
    "restart succeeds once before removal failure"
assert_file_exists "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" "sentinel retained after removal failure"
assert_file_exists "$OSI_IDENTITY_RUN_DIR/$COMPLETION_NAME" "completion marker after removal failure"
cmp \
    "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" \
    "$OSI_IDENTITY_RUN_DIR/$COMPLETION_NAME" || \
    fail "completion marker does not match the exact sentinel"
set_now 1001
identityd_control_tick
assert_eq "1" \
    "$(grep -c '^restart$' "$IDENTITYD_TEST_STATE_DIR/service.log")" \
    "completion marker suppresses repeated restart"
. "$DAEMON"
identityd_now_uptime() {
    cat "$IDENTITYD_TEST_STATE_DIR/uptime"
}
set_now 1002
identityd_control_tick
assert_eq "1" \
    "$(grep -c '^restart$' "$IDENTITYD_TEST_STATE_DIR/service.log")" \
    "completion recovery avoids a second restart"
assert_file_absent "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" "completion recovery removes sentinel"
assert_file_absent "$OSI_IDENTITY_RUN_DIR/$COMPLETION_NAME" "completion recovery removes marker"

# 14. Bootstrap, link, and unlink requests cannot shorten a pending identity
# deadline.
new_fixture
write_sentinel "restart_pending" '"1970-01-01T00:18:20Z"' "1100" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:13:00Z"
identityd_initialize
request_restart chirpstack_bootstrap 1
request_restart account_link 2
request_restart account_unlink 3
identityd_control_tick
assert_eq "1100" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 14 identity deadline"
assert_eq "gateway_identity_change" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" reason)" "scenario 14 reason"

# 15. A later real identity transition supersedes a generic request and gets a
# fresh 60 s deadline from detection.
new_fixture
set_uci_identity "0011223344556677" "provisional"
set_resolve "0011223344556677" "mac:eth0" "provisional" "2026-07-15T00:14:00Z"
request_restart chirpstack_bootstrap 10
identityd_control_tick
assert_eq "1010" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 15 generic deadline"
set_now 1001
set_resolve "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:14:01Z"
set_heal 0 "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:14:02Z" "8899AABBCCDDEEFF" "authoritative"
IDENTITYD_NEXT_RESOLVE_UPTIME=1001
identityd_control_tick
assert_eq "gateway_identity_change" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" reason)" "scenario 15 superseding reason"
assert_eq "1061" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 15 full identity delay"

# 16. A burst consumes every request file and keeps the earliest generic
# deadline.
new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
request_restart chirpstack_bootstrap 30
request_restart account_link 5
request_restart account_unlink 20
identityd_control_tick
remaining="$(find "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME" -type f 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "0" "$remaining" "scenario 16 consumed requests"
assert_eq "1005" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 16 earliest deadline"
assert_eq "account_link" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" reason)" "scenario 16 earliest reason"

# A publication temp file is outside the consumer contract until its atomic
# rename gives it the final .json suffix.
new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
request_restart account_link 5
printf '%s\n' '{"reason":"account_unlink"' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/manual.json.tmp"
identityd_control_tick
assert_file_exists \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/manual.json.tmp" \
    "request publication temp retained"
assert_eq "1005" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" \
    "final request consumed beside temp"
printf '%s\n' '{"reason":"account_unlink","delaySeconds":20,"requestedAtEpoch":1000}' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/manual.json.tmp"
mv \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/manual.json.tmp" \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/manual.json"
identityd_control_tick
assert_file_absent \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/manual.json" \
    "finalized request consumed on next tick"

# Node-RED publishes only the three request contract fields. The daemon derives
# both ISO and restart timestamps while consuming the file.
new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
printf '%s\n' \
    '{"reason":"account_unlink","delaySeconds":7,"requestedAtEpoch":1000}' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/node-red.json"
identityd_control_tick
assert_file_absent \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/node-red.json" \
    "minimal Node-RED request consumed"
assert_file_exists \
    "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" \
    "minimal Node-RED request scheduled"
assert_eq "1007" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" \
    "minimal Node-RED request deadline"
assert_eq "1970-01-01T00:16:40Z" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" requestedAt)" \
    "minimal Node-RED request timestamp"

# Producer wall time is request metadata only. Forward or backward NTP changes
# before consumption still schedule the full delay from the consumer tick.
new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
printf '%s\n' \
    '{"reason":"account_link","delaySeconds":7,"requestedAtEpoch":1000}' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/forward-jump.json"
set_wall 5000
set_uptime 1005
identityd_control_tick
assert_eq "" \
    "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" \
    "queued request forward wall jump does not restart immediately"
assert_eq "5007" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" \
    "queued request forward wall deadline"
assert_eq "1012" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartNotBeforeUptime)" \
    "queued request forward monotonic deadline"
assert_eq "1970-01-01T00:16:40Z" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" requestedAt)" \
    "queued request forward original metadata"

new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
printf '%s\n' \
    '{"reason":"account_unlink","delaySeconds":7,"requestedAtEpoch":1000}' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/backward-jump.json"
set_wall 500
set_uptime 1005
identityd_control_tick
assert_eq "507" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" \
    "queued request backward wall deadline"
assert_eq "1012" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartNotBeforeUptime)" \
    "queued request backward monotonic deadline"
assert_eq "1970-01-01T00:16:40Z" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" requestedAt)" \
    "queued request backward original metadata"

new_fixture
request_restart account_link 5
published_request="$(find "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME" -type f -name '*.json')"
assert_eq \
    '{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":1000}' \
    "$(cat "$published_request")" \
    "request-restart publication contract"

# 17. Request consumption runs every tick even when the next identity resolve
# is 300 s away.
new_fixture
set_uci_identity "0011223344556677" "authoritative"
set_resolve "0011223344556677" "concentratord-runtime" "authoritative" "2026-07-15T00:15:00Z"
identityd_control_tick
assert_eq "1300" "$IDENTITYD_NEXT_RESOLVE_UPTIME" "scenario 17 non-provisional cadence"
resolve_count_before="$(grep -c '^resolve$' "$IDENTITYD_TEST_STATE_DIR/helper.log")"
set_now 1001
request_restart account_link 5
identityd_control_tick
resolve_count_after="$(grep -c '^resolve$' "$IDENTITYD_TEST_STATE_DIR/helper.log")"
assert_eq "$resolve_count_before" "$resolve_count_after" "scenario 17 no early identity resolve"
assert_eq "1006" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "scenario 17 request deadline"

# Restart warnings and resolution cadence use monotonic uptime. Wall-clock
# jumps only rebase GUI metadata to the monotonic remaining duration.
new_fixture
set_uci_identity "8899AABBCCDDEEFF" "authoritative" "concentratord-runtime" "2026-07-15T00:20:00Z"
write_cache "8899AABBCCDDEEFF" "concentratord-runtime" "authoritative" "2026-07-15T00:20:00Z" "null" "restart_pending" "2026-07-15T00:20:00Z"
write_sentinel "restart_pending" '"1970-01-01T00:17:40Z"' "1060" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:20:00Z"
identityd_initialize
set_wall 5000
set_uptime 1010
identityd_control_tick
assert_eq "" "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" "identity forward wall jump does not shorten warning"
assert_eq "5050" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "identity forward jump rebases wall deadline"
set_wall 5050
set_uptime 1060
identityd_control_tick
assert_eq "restart" "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" "identity warning expires by uptime"

new_fixture
write_cache "0011223344556677" "mac:eth0" "provisional" "2026-07-15T00:21:00Z" "null" "restart_pending" "2026-07-15T00:21:00Z"
write_sentinel "restart_pending" '"1970-01-01T00:17:40Z"' "1060" "account_link" "null" "2026-07-15T00:21:00Z"
identityd_initialize
set_wall 500
set_uptime 1010
identityd_control_tick
assert_eq "550" "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" "generic backward jump rebases wall deadline"
set_wall 510
set_uptime 1060
identityd_control_tick
assert_eq "restart" "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" "generic backward jump does not defer restart"

new_fixture
set_resolve "0011223344556677" "mac:eth0" "provisional" "2026-07-15T00:22:00Z"
identityd_control_tick
resolve_count_before="$(grep -c '^resolve$' "$IDENTITYD_TEST_STATE_DIR/helper.log")"
set_wall 5000
set_uptime 1001
identityd_control_tick
resolve_count_after="$(grep -c '^resolve$' "$IDENTITYD_TEST_STATE_DIR/helper.log")"
assert_eq "$resolve_count_before" "$resolve_count_after" "forward wall jump does not shorten resolve cadence"
set_wall 100
set_uptime 1010
identityd_control_tick
assert_eq "$((resolve_count_before + 1))" \
    "$(grep -c '^resolve$' "$IDENTITYD_TEST_STATE_DIR/helper.log")" \
    "backward wall jump does not defer resolve cadence"

# CLI validation rejects unsupported reasons and delay values without creating
# request files.
new_fixture
if request_restart unsupported 10; then
    fail "request validation accepted an unsupported reason"
fi
if request_restart account_link 0; then
    fail "request validation accepted delay 0"
fi
if request_restart account_link 301; then
    fail "request validation accepted delay 301"
fi
if request_restart account_link '1;reboot'; then
    fail "request validation accepted a non-integer delay"
fi
if request_restart account_link 08; then
    fail "request validation accepted a leading-zero delay"
fi
request_count="$(find "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME" -type f 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "0" "$request_count" "request validation files"

for invalid_numeric_request in \
    '{"reason":"account_link","delaySeconds":08,"requestedAtEpoch":1000}' \
    '{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":999999999999999999999999}' \
    '{"reason":"account_link","delaySeconds":"five","requestedAtEpoch":1000}' \
    '{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":"1000"}'
do
    new_fixture
    IDENTITYD_NEXT_RESOLVE_UPTIME=1300
    printf '%s\n' "$invalid_numeric_request" \
        > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/invalid-number.json"
    identityd_control_tick 2> "$IDENTITYD_TEST_STATE_DIR/invalid-number.log"
    assert_file_absent \
        "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" \
        "invalid numeric request must not schedule"
    assert_file_absent \
        "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/invalid-number.json" \
        "invalid numeric request removed"
done

new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=2147483647
printf '%s\n' \
    '{"reason":"account_link","delaySeconds":300,"requestedAtEpoch":2147483347}' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/max-boundary.json"
set_now 2147483347
identityd_control_tick
assert_eq "2147483647" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" restartAtEpoch)" \
    "maximum safe request deadline"

new_fixture
unset IDENTITYD_ATOMIC_COUNTER
identityd_request_restart account_link 5
published_request="$(find "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME" -type f -name '*.json')"
assert_file_exists "$published_request" "set-u request publication"

# Valid finalized requests remain queued until scheduling is explicitly
# accepted or coalesced.
new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
printf '%s\n' \
    '{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":1000}' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/retry-write.json"
identityd_atomic_write() {
    return 1
}
identityd_control_tick
assert_file_exists \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/retry-write.json" \
    "request retained after sentinel publication failure"
assert_file_absent \
    "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" \
    "failed sentinel publication"
. "$DAEMON"
identityd_now_uptime() {
    cat "$IDENTITYD_TEST_STATE_DIR/uptime"
}
identityd_control_tick
assert_file_absent \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/retry-write.json" \
    "request consumed after sentinel publication recovers"
assert_file_exists \
    "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" \
    "sentinel published after recovery"

new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
printf '%s\n' '{malformed' > "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
printf '%s\n' \
    '{"reason":"account_unlink","delaySeconds":5,"requestedAtEpoch":1000}' \
    > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/retry-blocked.json"
identityd_control_tick 2> "$IDENTITYD_TEST_STATE_DIR/retry-blocked.log"
assert_file_exists \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/retry-blocked.json" \
    "request retained behind malformed sentinel"
rm -f "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
identityd_control_tick
assert_file_absent \
    "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/retry-blocked.json" \
    "blocked request consumed after sentinel recovery"
assert_eq "account_unlink" \
    "$(json_value "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" reason)" \
    "recovered request reason"

# Strict JSON schemas reject files that regex field extraction could
# misinterpret as trusted state.
for hostile_request in \
    '{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":1000} trailing' \
    '{"wrapper":{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":1000}}' \
    '{"reason":"unsupported","reason":"account_link","delaySeconds":5,"requestedAtEpoch":1000}' \
    '{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":1000,"unknown":true}'
do
    new_fixture
    IDENTITYD_NEXT_RESOLVE_UPTIME=1300
    printf '%s\n' "$hostile_request" \
        > "$OSI_IDENTITY_RUN_DIR/$REQUEST_DIR_NAME/hostile.json"
    identityd_control_tick 2> "$IDENTITYD_TEST_STATE_DIR/hostile.log"
    assert_file_absent \
        "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" \
        "strict request JSON must not schedule"
    assert_eq "" \
        "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" \
        "strict request JSON must not restart"
done

new_fixture
set_uci_identity "8899AABBCCDDEEFF" "authoritative"
write_sentinel "restart_pending" '"1970-01-01T00:16:39Z"' "999" "gateway_identity_change" '"8899AABBCCDDEEFF"' "2026-07-15T00:10:00Z"
printf '%s\n' ' trailing' >> "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
identityd_control_tick 2> "$IDENTITYD_TEST_STATE_DIR/hostile.log"
assert_eq "" \
    "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" \
    "strict sentinel JSON must not restart"

new_fixture
write_cache "0011223344556677" "mac:eth0" "provisional" "2026-07-15T00:00:00Z" "null" "provisional" "2026-07-15T00:00:00Z"
cache_content="$(cat "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME")"
printf '%s\n' "${cache_content%?},\"unknown\":true}" > "$OSI_IDENTITY_RUN_DIR/$CACHE_NAME"
if identityd_load_cache; then
    fail "strict cache JSON accepted an unknown field"
fi

new_fixture
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
printf '%s\n' '{malformed-one' > "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
: > "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log"
identityd_control_tick 2>> "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log"
set_now 1001
identityd_control_tick 2>> "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log"
set_now 1002
identityd_control_tick 2>> "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log"
assert_eq "1" \
    "$(grep -c 'retaining malformed restart sentinel' "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log")" \
    "unchanged malformed sentinel warning rate"
printf '%s\n' '{malformed-two' > "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
set_now 1003
identityd_control_tick 2>> "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log"
assert_eq "2" \
    "$(grep -c 'retaining malformed restart sentinel' "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log")" \
    "changed malformed sentinel warning reset"
rm -f "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
set_now 1004
identityd_control_tick 2>> "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log"
printf '%s\n' '{malformed-two' > "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
set_now 1005
identityd_control_tick 2>> "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log"
assert_eq "3" \
    "$(grep -c 'retaining malformed restart sentinel' "$IDENTITYD_TEST_STATE_DIR/malformed-rate.log")" \
    "recovered malformed sentinel warning reset"

# Only one state-machine consumer may run. A live owner blocks another daemon,
# a dead owner is recovered, and normal exit removes the lock. Producers never
# acquire the consumer lock.
new_fixture
if ! command -v identityd_lock_acquire >/dev/null 2>&1; then
    fail "single-consumer lock function is missing"
fi
identityd_lock_acquire || fail "atomic consumer lock was not acquired"
if [ ! -L "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" ]; then
    fail "consumer lock was published without an atomic PID token"
fi
assert_eq "$$" \
    "$(readlink "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock")" \
    "atomic consumer lock owner"
identityd_lock_release

# Pause one contender before its atomic link publication. The other contender
# wins the token, and the paused contender must then observe the live owner.
IDENTITYD_TEST_PAUSE_LOCK_PUBLICATION=1 sh -c '
    . "$1"
    identityd_initialize || exit 1
    if identityd_lock_acquire; then
        printf "%s\n" acquired > "$IDENTITYD_TEST_STATE_DIR/first-lock-result"
        identityd_lock_release
    else
        printf "%s\n" rejected > "$IDENTITYD_TEST_STATE_DIR/first-lock-result"
    fi
' sh "$DAEMON" &
LOCK_HOLDER_PID=$!
lock_wait=0
while [ ! -e "$IDENTITYD_TEST_STATE_DIR/lock-publication-paused" ]; do
    lock_wait=$((lock_wait + 1))
    [ "$lock_wait" -le 50 ] || fail "atomic lock publication hook was not reached"
    sleep 0.1
done
sh -c '
    . "$1"
    identityd_initialize || exit 1
    if identityd_lock_acquire; then
        printf "%s\n" acquired > "$IDENTITYD_TEST_STATE_DIR/second-lock-result"
        : > "$IDENTITYD_TEST_STATE_DIR/second-lock-held"
        while [ ! -e "$IDENTITYD_TEST_STATE_DIR/release-second-lock" ]; do
            sleep 1
        done
        identityd_lock_release
    else
        printf "%s\n" rejected > "$IDENTITYD_TEST_STATE_DIR/second-lock-result"
    fi
' sh "$DAEMON" &
LOCK_CONTENDER_PID=$!
lock_wait=0
while [ ! -e "$IDENTITYD_TEST_STATE_DIR/second-lock-held" ]; do
    lock_wait=$((lock_wait + 1))
    [ "$lock_wait" -le 50 ] || fail "second lock contender did not acquire"
    sleep 0.1
done
: > "$IDENTITYD_TEST_STATE_DIR/release-lock-publication"
wait "$LOCK_HOLDER_PID"
LOCK_HOLDER_PID=""
assert_eq "rejected" \
    "$(cat "$IDENTITYD_TEST_STATE_DIR/first-lock-result")" \
    "paused lock contender result"
assert_eq "acquired" \
    "$(cat "$IDENTITYD_TEST_STATE_DIR/second-lock-result")" \
    "winning lock contender result"
: > "$IDENTITYD_TEST_STATE_DIR/release-second-lock"
wait "$LOCK_CONTENDER_PID"
LOCK_CONTENDER_PID=""
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" "interleaved lock release"

sh -c '
    . "$1"
    identityd_initialize || exit 1
    identityd_lock_acquire || exit 1
    : > "$IDENTITYD_TEST_STATE_DIR/lock-held"
    while [ ! -e "$IDENTITYD_TEST_STATE_DIR/release-lock" ]; do
        sleep 1
    done
    identityd_lock_release
' sh "$DAEMON" &
LOCK_HOLDER_PID=$!
lock_wait=0
while [ ! -e "$IDENTITYD_TEST_STATE_DIR/lock-held" ]; do
    lock_wait=$((lock_wait + 1))
    [ "$lock_wait" -le 50 ] || fail "lock holder did not start"
    sleep 0.1
done
if "$DAEMON" run-once >/dev/null 2>&1; then
    fail "second consumer acquired a live daemon lock"
fi
: > "$IDENTITYD_TEST_STATE_DIR/release-lock"
wait "$LOCK_HOLDER_PID"
LOCK_HOLDER_PID=""
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" "normal lock release"

ln -s "999999" "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock"
identityd_lock_acquire || fail "stale PID token was not recovered"
identityd_lock_release
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" "stale PID token release"

mkdir "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock"
printf '%s\n' "999999" > "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock/pid"
identityd_lock_acquire || fail "stale consumer lock was not recovered"
identityd_lock_release
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" "stale lock recovery release"

printf '%s\n' "malformed" > "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock"
identityd_lock_acquire || fail "malformed consumer lock was not recovered"
identityd_lock_release
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" "malformed lock recovery release"

request_restart "account_link" 10
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" "request producer lock isolation"

# A malformed sentinel fails safe: it is retained and never triggers a
# restart. `run-once` still exits cleanly so procd does not hot-loop.
printf '%s\n' '{malformed' > "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME"
IDENTITYD_NEXT_RESOLVE_UPTIME=1300
identityd_control_tick 2> "$IDENTITYD_TEST_STATE_DIR/malformed.log"
assert_eq "" "$(cat "$IDENTITYD_TEST_STATE_DIR/service.log")" "malformed sentinel restart log"
assert_file_exists "$OSI_IDENTITY_RUN_DIR/$SENTINEL_NAME" "malformed sentinel retained"
assert_contains "$(cat "$IDENTITYD_TEST_STATE_DIR/malformed.log")" "retaining malformed restart sentinel" "malformed sentinel warning"
"$DAEMON" run-once 2>> "$IDENTITYD_TEST_STATE_DIR/malformed.log"
assert_file_absent "$OSI_IDENTITY_RUN_DIR/osi-identityd.lock" "run-once lock release"
assert_eq "" "$(cat "$IDENTITYD_TEST_STATE_DIR/registration.log")" "Task 2 registration scope"

printf '%s\n' "PASS: osi-identityd state machine (17 scenarios)"
