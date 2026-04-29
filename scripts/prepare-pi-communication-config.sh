#!/bin/sh
set -eu

APPLY=0
FLOW_FILE="${FLOW_FILE:-/srv/node-red/flows.json}"
ENV_FILE="${ENV_FILE:-/srv/node-red/.chirpstack.env}"

case "${1:-}" in
    --apply) APPLY=1 ;;
    ""|--dry-run) APPLY=0 ;;
    *) echo "usage: $0 [--dry-run|--apply]" >&2; exit 2 ;;
esac

read_env_key() {
    key="$1"
    [ -f "$ENV_FILE" ] || return 0
    # Keep this parser aligned with node-red.init and diagnose-pi-communication.sh.
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
                gsub(/^["'\''"]|["'\''"]$/, "", line)
                print line
                exit
            }
        }
    ' "$ENV_FILE"
}

extract_from_legacy_flow() {
    key="$1"
    [ -f "$FLOW_FILE" ] || return 0
    command -v node >/dev/null 2>&1 || return 0
    FLOW_FILE="$FLOW_FILE" LEGACY_KEY="$key" node <<'NODE'
const fs = require('fs');

const flows = JSON.parse(fs.readFileSync(process.env.FLOW_FILE, 'utf8'));
const key = process.env.LEGACY_KEY;
const mqttTopics = flows
  .filter((node) => node.type === 'mqtt in')
  .map((node) => String(node.topic || ''));

function topicAppId(topic) {
  const match = topic.match(/^application\/([0-9a-f-]{36})\//i);
  return match ? match[1] : '';
}

if (key === 'CHIRPSTACK_APP_SENSORS') {
  const topic = mqttTopics.find((value) => /^application\/[0-9a-f-]{36}\/device\//i.test(value));
  console.log(topicAppId(topic || ''));
}

if (key === 'CHIRPSTACK_APP_FIELD_TESTER') {
  const topic = mqttTopics.find((value) => /^application\/[0-9a-f-]{36}\/#$/i.test(value));
  console.log(topicAppId(topic || ''));
}

if (key === 'CHIRPSTACK_APP_ACTUATORS') {
  const strega = flows.find((node) => String(node.func || '').includes('CHIRPSTACK_APP_ACTUATORS') || String(node.func || '').includes('FIXED_APP_ID'));
  const source = String(strega && strega.func || '');
  // Do not trust a bare const FIXED_APP_ID = "<uuid>" value here. That value is
  // the known stale default on mixed-version Pis and must not be migrated into UCI.
  const match = source.match(/CHIRPSTACK_APP_ACTUATORS'\)\s*\|\|\s*["']([0-9a-f-]{36})["']/i);
  console.log(match ? match[1] : '');
}
NODE
}

resolve_value() {
    uci_key="$1"
    env_key="$2"
    current="$(uci -q get "osi-server.cloud.$uci_key" 2>/dev/null || true)"
    [ -n "$current" ] && { echo "$current"; return 0; }
    env_value="$(read_env_key "$env_key" 2>/dev/null || true)"
    [ -n "$env_value" ] && { echo "$env_value"; return 0; }
    extract_from_legacy_flow "$env_key" 2>/dev/null || true
}

is_uuid() {
    printf '%s' "$1" | grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

set_if_missing() {
    uci_key="$1"
    env_key="$2"
    required="$3"
    value="$(resolve_value "$uci_key" "$env_key" | head -n 1)"
    current="$(uci -q get "osi-server.cloud.$uci_key" 2>/dev/null || true)"
    if [ -n "$current" ]; then
        echo "OK uci.$uci_key already set"
        return 0
    fi
    if [ -z "$value" ]; then
        echo "MISSING uci.$uci_key / env.$env_key"
        [ "$required" = "1" ] && missing_required=1
        return 0
    fi
    if ! is_uuid "$value"; then
        echo "INVALID uci.$uci_key / env.$env_key is not a ChirpStack UUID"
        [ "$required" = "1" ] && missing_required=1
        return 0
    fi
    if [ "$APPLY" = "1" ]; then
        uci set "osi-server.cloud.$uci_key=$value"
        echo "SET uci.$uci_key from fallback source"
    else
        echo "DRY-RUN would set uci.$uci_key from fallback source"
    fi
}

missing_required=0
set_if_missing chirpstack_app_sensors CHIRPSTACK_APP_SENSORS 1
set_if_missing chirpstack_app_actuators CHIRPSTACK_APP_ACTUATORS 1
set_if_missing chirpstack_app_field_tester CHIRPSTACK_APP_FIELD_TESTER 0
set_if_missing chirpstack_profile_kiwi CHIRPSTACK_PROFILE_KIWI 1
set_if_missing chirpstack_profile_strega CHIRPSTACK_PROFILE_STREGA 1
set_if_missing chirpstack_profile_lsn50 CHIRPSTACK_PROFILE_LSN50 1
set_if_missing chirpstack_profile_clover CHIRPSTACK_PROFILE_CLOVER 0
set_if_missing chirpstack_profile_rak10701 CHIRPSTACK_PROFILE_RAK10701 0
set_if_missing chirpstack_profile_s2120 CHIRPSTACK_PROFILE_S2120 0

if [ "$missing_required" = "1" ]; then
    echo "ERROR: required ChirpStack configuration is missing; do not deploy portable flow yet" >&2
    exit 1
fi

if [ "$APPLY" = "1" ]; then
    uci commit osi-server
    echo "OK committed osi-server ChirpStack config"
else
    echo "OK dry-run completed; rerun with --apply to write missing UCI keys"
fi
