#!/bin/sh

set -eu

HELPER="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh"

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

assert_contains() {
    local haystack needle label
    haystack="$1"
    needle="$2"
    label="$3"
    case "$haystack" in
        *"$needle"*)
            ;;
        *)
            fail "$label: missing '$needle'"
            ;;
    esac
}

. "$HELPER"

CALLS=""
gateway_identity_resolve() {
    CALLS="$CALLS resolve"
}
gateway_identity_repair_concentratord_config() {
    CALLS="$CALLS repair"
}
gateway_identity_persist() {
    CALLS="$CALLS persist"
}
gateway_identity_heal || fail "successful heal returned nonzero"
assert_eq " resolve repair resolve persist" "$CALLS" "successful heal call order"

CALLS=""
gateway_identity_resolve() {
    CALLS="$CALLS resolve"
    return 7
}
gateway_identity_repair_concentratord_config() {
    CALLS="$CALLS repair"
}
gateway_identity_persist() {
    CALLS="$CALLS persist"
}
if gateway_identity_heal; then
    fail "first-resolve failure returned zero"
else
    status=$?
fi
assert_eq "1" "$status" "first-resolve failure status"
assert_eq " resolve" "$CALLS" "first-resolve failure call order"

CALLS=""
gateway_identity_resolve() {
    CALLS="$CALLS resolve"
}
gateway_identity_repair_concentratord_config() {
    CALLS="$CALLS repair"
    return 8
}
gateway_identity_persist() {
    CALLS="$CALLS persist"
}
if gateway_identity_heal; then
    fail "repair failure returned zero"
else
    status=$?
fi
assert_eq "1" "$status" "repair failure status"
assert_eq " resolve repair" "$CALLS" "repair failure call order"

CALLS=""
RESOLVE_COUNT=0
gateway_identity_resolve() {
    RESOLVE_COUNT=$((RESOLVE_COUNT + 1))
    CALLS="$CALLS resolve"
    [ "$RESOLVE_COUNT" -lt 2 ]
}
gateway_identity_repair_concentratord_config() {
    CALLS="$CALLS repair"
}
gateway_identity_persist() {
    CALLS="$CALLS persist"
}
if gateway_identity_heal; then
    fail "second-resolve failure returned zero"
else
    status=$?
fi
assert_eq "1" "$status" "second-resolve failure status"
assert_eq " resolve repair resolve" "$CALLS" "second-resolve failure call order"

CALLS=""
gateway_identity_resolve() {
    CALLS="$CALLS resolve"
}
gateway_identity_repair_concentratord_config() {
    CALLS="$CALLS repair"
}
gateway_identity_persist() {
    CALLS="$CALLS persist"
    return 9
}
if gateway_identity_heal; then
    fail "persist failure returned zero"
else
    status=$?
fi
assert_eq "1" "$status" "persist failure status"
assert_eq " resolve repair resolve persist" "$CALLS" "persist failure call order"

# Reload the helper to restore the production repair function after the order stubs.
. "$HELPER"

UCI_WRITES=""
uci() {
    if [ "$1" = "-q" ] && [ "$2" = "get" ]; then
        case "$3" in
            'chirpstack-concentratord.@global[0].chipset')
                printf '%s\n' "sx1302"
                ;;
            'chirpstack-concentratord.@sx1302[0].gateway_id')
                printf '%s\n' "0011223344556677"
                ;;
            'chirpstack-concentratord.@sx1301[0].gateway_id')
                ;;
            *)
                return 1
                ;;
        esac
        return 0
    fi
    if [ "$1" = "-q" ] && [ "$2" = "set" ]; then
        UCI_WRITES="$UCI_WRITES $3"
        return 0
    fi
    if [ "$1" = "commit" ]; then
        UCI_WRITES="$UCI_WRITES commit:$2"
        return 0
    fi
    return 1
}

RESOLVE_COUNT=0
gateway_identity_resolve() {
    RESOLVE_COUNT=$((RESOLVE_COUNT + 1))
    GATEWAY_IDENTITY_DEVICE_EUI="AABBCCDDEEFF0011"
    GATEWAY_IDENTITY_DEVICE_EUI_SOURCE="test-resolve-$RESOLVE_COUNT"
    GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="authoritative"
    GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT="2026-07-15T00:00:00Z"
}
gateway_identity_persist() {
    return 0
}
gateway_identity_heal || fail "authoritative state-propagation heal returned nonzero"
assert_eq \
    " chirpstack-concentratord.@sx1302[0].gateway_id=AABBCCDDEEFF0011 commit:chirpstack-concentratord" \
    "$UCI_WRITES" \
    "authoritative first-resolve state reaches production repair"

UCI_WRITES=""
RESOLVE_COUNT=0
gateway_identity_resolve() {
    RESOLVE_COUNT=$((RESOLVE_COUNT + 1))
    GATEWAY_IDENTITY_DEVICE_EUI="AABBCCDDEEFF0011"
    GATEWAY_IDENTITY_DEVICE_EUI_SOURCE="test-resolve-$RESOLVE_COUNT"
    GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="provisional"
    GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT=""
}
gateway_identity_persist() {
    return 0
}
gateway_identity_heal || fail "provisional state-propagation heal returned nonzero"
assert_eq "" "$UCI_WRITES" "provisional identity must not repair concentratord UCI"

CLI_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$CLI_TMP_DIR"' 0 1 2 15
CLI_HELPER="$CLI_TMP_DIR/osi-gateway-identity.sh"
CLI_UCI_LOG="$CLI_TMP_DIR/uci.log"
cp "$HELPER" "$CLI_HELPER"

cat > "$CLI_TMP_DIR/sh" <<'EOF'
#!/bin/sh
exit 1
EOF

cat > "$CLI_TMP_DIR/uci" <<'EOF'
#!/bin/sh

printf '%s\n' "$*" >> "$GATEWAY_IDENTITY_TEST_UCI_LOG"

if [ "$1" = "-q" ]; then
    shift
fi

case "$1:$2" in
    'get:chirpstack-concentratord.@global[0].chipset')
        printf '%s\n' "sx1302"
        ;;
    'get:chirpstack-concentratord.@sx1302[0].gateway_id')
        printf '%s\n' "AABBCCDDEEFF0011"
        ;;
    'get:chirpstack-concentratord.@sx1301[0].gateway_id')
        ;;
    set:*|delete:*|commit:*)
        ;;
    *)
        exit 1
        ;;
esac
EOF

chmod 755 "$CLI_HELPER" "$CLI_TMP_DIR/sh" "$CLI_TMP_DIR/uci"
if ! CLI_OUTPUT="$(
    GATEWAY_IDENTITY_TEST_UCI_LOG="$CLI_UCI_LOG" \
    PATH="$CLI_TMP_DIR:$PATH" \
    "$CLI_HELPER" heal
)"; then
    fail "CLI heal dispatch returned nonzero"
fi

assert_contains "$CLI_OUTPUT" "DEVICE_EUI=AABBCCDDEEFF0011" "CLI heal emits the resolved EUI"
assert_contains "$CLI_OUTPUT" "DEVICE_EUI_SOURCE=concentratord-uci-sx1302" "CLI heal emits the resolved source"
assert_contains "$CLI_OUTPUT" "DEVICE_EUI_CONFIDENCE=authoritative" "CLI heal emits authoritative confidence"
assert_contains "$CLI_OUTPUT" "DEVICE_EUI_LAST_VERIFIED_AT=" "CLI heal emits the verification timestamp field"

ACTIVE_GATEWAY_READS="$(awk '
    $0 == "-q get chirpstack-concentratord.@sx1302[0].gateway_id" { count += 1 }
    END { print count + 0 }
' "$CLI_UCI_LOG")"
assert_eq "3" "$ACTIVE_GATEWAY_READS" "CLI heal executes resolve, repair, then resolve"
assert_contains "$(cat "$CLI_UCI_LOG")" \
    "-q set osi-server.cloud.device_eui=AABBCCDDEEFF0011" \
    "CLI heal persists the resolved EUI"

printf '%s\n' "PASS: gateway identity heal ordering and state propagation"
