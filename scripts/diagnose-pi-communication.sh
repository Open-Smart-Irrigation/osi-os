#!/bin/sh
set -eu

FLOW_FILE="${FLOW_FILE:-/srv/node-red/flows.json}"
ENV_FILE="${ENV_FILE:-/srv/node-red/.chirpstack.env}"
DB_PATH="${DB_PATH:-/data/db/farming.db}"
INIT_FILE="${INIT_FILE:-/etc/init.d/node-red}"

redact_value() {
    key="$1"
    value="$2"
    case "$key" in
        *KEY*|*PASSWORD*|*TOKEN*|*SECRET*|*key*|*password*|*token*|*secret*) printf '<redacted>' ;;
        *) printf '%s' "$value" ;;
    esac
}

print_kv() {
    printf '%s=%s\n' "$1" "$2"
}

section() {
    printf '\n== %s ==\n' "$1"
}

read_env_key() {
    key="$1"
    [ -f "$ENV_FILE" ] || return 0
    # Keep this parser aligned with load_chirpstack_env_value() in node-red.init.
    awk -v wanted="$key" '
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        {
            line=$0
            sub(/^[[:space:]]*/, "", line)
            split(line, parts, "=")
            env_key=parts[1]
            sub(/[[:space:]]*$/, "", env_key)
            if (env_key == wanted) {
                sub(/^[^=]*=/, "", line)
                gsub(/^[[:space:]]*/, "", line)
                gsub(/[[:space:]]*$/, "", line)
                gsub(/^["'\'']|["'\'']$/, "", line)
                print line
                exit
            }
        }
    ' "$ENV_FILE"
}

section "Gateway identity"
if [ -x /usr/libexec/osi-gateway-identity.sh ]; then
    (
        set +e
        . /usr/libexec/osi-gateway-identity.sh
        gateway_identity_resolve
        print_kv DEVICE_EUI "${GATEWAY_IDENTITY_DEVICE_EUI:-}"
        print_kv DEVICE_EUI_SOURCE "${GATEWAY_IDENTITY_DEVICE_EUI_SOURCE:-}"
        print_kv DEVICE_EUI_CONFIDENCE "${GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE:-}"
    ) || print_kv gateway_identity "skipped: helper failed"
else
    print_kv helper "missing:/usr/libexec/osi-gateway-identity.sh"
fi

section "ChirpStack config"
for pair in \
    "chirpstack_app_sensors CHIRPSTACK_APP_SENSORS" \
    "chirpstack_app_actuators CHIRPSTACK_APP_ACTUATORS" \
    "chirpstack_app_field_tester CHIRPSTACK_APP_FIELD_TESTER" \
    "chirpstack_profile_kiwi CHIRPSTACK_PROFILE_KIWI" \
    "chirpstack_profile_strega CHIRPSTACK_PROFILE_STREGA" \
    "chirpstack_profile_lsn50 CHIRPSTACK_PROFILE_LSN50" \
    "chirpstack_profile_clover CHIRPSTACK_PROFILE_CLOVER" \
    "chirpstack_profile_rak10701 CHIRPSTACK_PROFILE_RAK10701" \
    "chirpstack_profile_s2120 CHIRPSTACK_PROFILE_S2120"
do
    uci_key="${pair% *}"
    env_key="${pair#* }"
    uci_value="$(uci -q get "osi-server.cloud.$uci_key" 2>/dev/null || true)"
    env_value="$(read_env_key "$env_key" 2>/dev/null || true)"
    print_kv "uci.$uci_key" "$(redact_value "$uci_key" "$uci_value")"
    print_kv "env.$env_key" "$(redact_value "$env_key" "$env_value")"
done

section "Node-RED files"
for file in "$FLOW_FILE" "$ENV_FILE" "$INIT_FILE" /srv/node-red/settings.js /srv/node-red/flows_cred.json; do
    if [ -e "$file" ]; then
        print_kv "$file" "present mtime=$(date -r "$file" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || echo unknown)"
    else
        print_kv "$file" "missing"
    fi
done

section "MQTT IN topics"
if [ -f "$FLOW_FILE" ] && command -v node >/dev/null 2>&1; then
    # Inline Node keeps this diagnostic deployable as one copied shell script.
    if ! FLOW_FILE="$FLOW_FILE" node <<'NODE'
const fs = require('fs');
const flowFile = process.env.FLOW_FILE;
const flows = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
for (const node of flows.filter((entry) => entry.type === 'mqtt in')) {
  console.log(`${node.id} ${node.name || ''} ${node.topic || ''}`.trim());
}
NODE
    then
        print_kv topics "skipped: flow parse failed"
    fi
else
    print_kv topics "skipped: node or flows.json unavailable"
fi

section "STREGA downlink"
if [ -f "$FLOW_FILE" ] && command -v node >/dev/null 2>&1; then
    # Inline Node keeps this diagnostic deployable as one copied shell script.
    if ! FLOW_FILE="$FLOW_FILE" node <<'NODE'
const fs = require('fs');
const flows = JSON.parse(fs.readFileSync(process.env.FLOW_FILE, 'utf8'));
const node = flows.find((entry) => entry.name === 'Build STREGA downlink + emit log ctx');
const source = String(node && node.func || '');
console.log('has_FIXED_APP_ID=' + source.includes('FIXED_APP_ID'));
console.log('uses_CHIRPSTACK_APP_ACTUATORS=' + source.includes("env.get('CHIRPSTACK_APP_ACTUATORS')"));
console.log('has_missing_app_guard=' + source.includes('Missing CHIRPSTACK_APP_ACTUATORS'));
NODE
    then
        print_kv strega "skipped: flow parse failed"
    fi
else
    print_kv strega "skipped: node or flows.json unavailable"
fi

section "SQLite state"
if [ ! -e "$DB_PATH" ]; then
    print_kv sqlite "skipped: database missing"
elif ! command -v sqlite3 >/dev/null 2>&1; then
    print_kv sqlite "skipped: sqlite3 unavailable"
else
    table_exists() {
        sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='$1';" 2>/dev/null | grep -qx "$1"
    }
    if table_exists device_data; then
        sqlite3 "$DB_PATH" "SELECT 'latest_device_data=' || COALESCE(MAX(recorded_at),'none') FROM device_data;" || true
    else
        print_kv latest_device_data "skipped: device_data table missing"
    fi
    if table_exists sync_outbox; then
        sqlite3 "$DB_PATH" "SELECT 'sync_outbox_pending=' || COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL;" || true
        sqlite3 "$DB_PATH" "SELECT 'sync_outbox_delivered=' || COUNT(*) FROM sync_outbox WHERE delivered_at IS NOT NULL;" || true
    else
        print_kv sync_outbox "skipped: sync_outbox table missing"
    fi
fi

section "Recent service logs"
if command -v logread >/dev/null 2>&1; then
    logread | grep -Ei 'node-red|chirpstack|mqtt|sync|strega' | tail -n 80 || true
else
    print_kv logs "skipped: logread unavailable"
fi
