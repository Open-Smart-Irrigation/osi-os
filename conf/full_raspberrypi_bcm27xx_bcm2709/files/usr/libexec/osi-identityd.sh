#!/bin/sh

umask 077

OSI_IDENTITY_RUN_DIR="${OSI_IDENTITY_RUN_DIR:-/var/run}"
OSI_IDENTITY_HELPER="${OSI_IDENTITY_HELPER:-/usr/libexec/osi-gateway-identity.sh}"
OSI_NODE_RED_SERVICE="${OSI_NODE_RED_SERVICE:-/etc/init.d/node-red}"
OSI_REGISTRATION_SCRIPT="${OSI_REGISTRATION_SCRIPT:-/usr/libexec/osi-register-gateway.sh}"
IDENTITYD_MAX_EPOCH=2147483647
IDENTITYD_COMPLETED_SENTINEL_SET=0
IDENTITYD_COMPLETED_SENTINEL_RAW=""

if [ ! -r "$OSI_IDENTITY_HELPER" ]; then
    printf 'osi-identityd: identity helper is not readable: %s\n' "$OSI_IDENTITY_HELPER" >&2
    exit 1
fi

. "$OSI_IDENTITY_HELPER"

identityd_refresh_paths() {
    IDENTITYD_CACHE_FILE="$OSI_IDENTITY_RUN_DIR/osi-gateway-identity.json"
    IDENTITYD_SENTINEL_FILE="$OSI_IDENTITY_RUN_DIR/osi-identity-restart.json"
    IDENTITYD_COMPLETION_FILE="$OSI_IDENTITY_RUN_DIR/osi-identity-restart-complete.json"
    IDENTITYD_REQUEST_DIR="$OSI_IDENTITY_RUN_DIR/osi-node-red-restart-requests"
    IDENTITYD_LOCK_DIR="$OSI_IDENTITY_RUN_DIR/osi-identityd.lock"
}

identityd_now_epoch() {
    date +%s
}

identityd_now_uptime() {
    local seconds remainder
    IFS='. ' read -r seconds remainder < /proc/uptime || return 1
    identityd_uint_valid "$seconds" "$IDENTITYD_MAX_EPOCH" || return 1
    printf '%s\n' "$seconds"
}

identityd_now_iso() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

identityd_format_epoch() {
    date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

identityd_reason_valid() {
    case "$1" in
        gateway_identity_change|chirpstack_bootstrap|account_link|account_unlink)
            return 0
            ;;
    esac
    return 1
}

identityd_confidence_normalize() {
    local value
    value="$(printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')"
    case "$value" in
        authoritative|persisted|provisional)
            printf '%s\n' "$value"
            return 0
            ;;
    esac
    return 1
}

identityd_source_normalize() {
    local value clean
    value="$1"
    clean="$(printf '%s' "$value" | tr -cd 'A-Za-z0-9:._/-')"
    [ -n "$clean" ] || return 1
    [ "$clean" = "$value" ] || return 1
    printf '%s\n' "$clean"
}

identityd_timestamp_normalize() {
    local value clean
    value="$1"
    [ -n "$value" ] || {
        printf '%s\n' ""
        return 0
    }
    clean="$(printf '%s' "$value" | tr -cd '0-9TZ:+.-')"
    [ "$clean" = "$value" ] || return 1
    printf '%s\n' "$clean"
}

identityd_uint_valid() {
    local value maximum
    value="$1"
    maximum="$2"
    case "$value" in
        ""|*[!0-9]*|0[0-9]*) return 1 ;;
    esac
    [ "${#value}" -le "${#maximum}" ] || return 1
    awk -v value="$value" -v maximum="$maximum" \
        'BEGIN { exit !((value + 0) <= (maximum + 0)) }' </dev/null
}

identityd_uci_get() {
    uci -q get "$1" 2>/dev/null || true
}

identityd_atomic_write() {
    local target content temporary
    target="$1"
    content="$2"
    IDENTITYD_ATOMIC_COUNTER=$((IDENTITYD_ATOMIC_COUNTER + 1))
    temporary="$target.tmp.$$.$IDENTITYD_ATOMIC_COUNTER"
    if ! printf '%s\n' "$content" > "$temporary"; then
        rm -f "$temporary"
        return 1
    fi
    chmod 600 "$temporary" 2>/dev/null || true
    if ! mv -f "$temporary" "$target"; then
        rm -f "$temporary"
        return 1
    fi
}

identityd_remove_sentinel() {
    rm -f "$IDENTITYD_SENTINEL_FILE"
}

identityd_remove_completion() {
    rm -f "$IDENTITYD_COMPLETION_FILE"
}

identityd_clear_completed_sentinel() {
    IDENTITYD_COMPLETED_SENTINEL_SET=0
    IDENTITYD_COMPLETED_SENTINEL_RAW=""
}

identityd_remember_completed_sentinel() {
    IDENTITYD_COMPLETED_SENTINEL_SET=1
    IDENTITYD_COMPLETED_SENTINEL_RAW="$1"
}

identityd_write_completion_marker() {
    identityd_atomic_write "$IDENTITYD_COMPLETION_FILE" "$1"
}

identityd_finish_completed_sentinel() {
    local reason
    reason="$1"
    if identityd_remove_sentinel; then
        identityd_remove_completion 2>/dev/null || true
        identityd_clear_completed_sentinel
        identityd_cache_after_restart "$reason" || true
    fi
    return 0
}

identityd_lock_owner_at() {
    local lock owner
    lock="$1"
    if [ -L "$lock" ]; then
        owner="$(readlink "$lock" 2>/dev/null)" || return 1
    elif [ -d "$lock" ]; then
        owner="$(cat "$lock/pid" 2>/dev/null)" || return 1
    else
        return 1
    fi
    identityd_uint_valid "$owner" "$IDENTITYD_MAX_EPOCH" || return 1
    [ "$owner" -gt 0 ] || return 1
    printf '%s\n' "$owner"
}

identityd_lock_owner() {
    identityd_lock_owner_at "$IDENTITYD_LOCK_DIR"
}

identityd_lock_owner_alive() {
    local owner
    owner="$(identityd_lock_owner)" || return 1
    kill -0 "$owner" 2>/dev/null
}

identityd_ready() {
    local owner
    identityd_refresh_paths
    [ -L "$IDENTITYD_LOCK_DIR" ] || return 1
    owner="$(readlink "$IDENTITYD_LOCK_DIR" 2>/dev/null)" || return 1
    identityd_uint_valid "$owner" "$IDENTITYD_MAX_EPOCH" || return 1
    [ "$owner" -gt 1 ] || return 1
    kill -0 "$owner" 2>/dev/null
}

identityd_lock_create() {
    ln -s "$$" "$IDENTITYD_LOCK_DIR" 2>/dev/null || return 1
    if [ ! -L "$IDENTITYD_LOCK_DIR" ] || [ "$(readlink "$IDENTITYD_LOCK_DIR" 2>/dev/null || true)" != "$$" ]; then
        if [ -d "$IDENTITYD_LOCK_DIR" ]; then
            rm -f "$IDENTITYD_LOCK_DIR/$$"
        fi
        return 1
    fi
    IDENTITYD_LOCK_HELD=1
}

identityd_lock_acquire() {
    local recovery_dir
    identityd_refresh_paths
    mkdir -p "$OSI_IDENTITY_RUN_DIR" || return 1
    if identityd_lock_create; then
        return 0
    fi
    if identityd_lock_owner_alive; then
        return 1
    fi

    recovery_dir="$IDENTITYD_LOCK_DIR.recover.$$"
    rm -rf "$recovery_dir"
    mv "$IDENTITYD_LOCK_DIR" "$recovery_dir" 2>/dev/null || return 1
    rm -rf "$recovery_dir"
    identityd_lock_create
}

identityd_lock_release() {
    local owner release_token
    [ "${IDENTITYD_LOCK_HELD:-0}" -eq 1 ] || return 0
    owner="$(identityd_lock_owner)" || return 1
    [ "$owner" = "$$" ] || return 1
    release_token="$IDENTITYD_LOCK_DIR.release.$$"
    rm -rf "$release_token"
    mv "$IDENTITYD_LOCK_DIR" "$release_token" 2>/dev/null || return 1
    owner="$(identityd_lock_owner_at "$release_token" || true)"
    if [ "$owner" != "$$" ]; then
        mv "$release_token" "$IDENTITYD_LOCK_DIR" 2>/dev/null || true
        return 1
    fi
    rm -rf "$release_token" || return 1
    IDENTITYD_LOCK_HELD=0
}

identityd_json_get() {
    jsonfilter -i "$1" -e "@.$2" 2>/dev/null
}

identityd_json_type() {
    jsonfilter -i "$1" -t "@.$2" 2>/dev/null
}

identityd_json_raw() {
    cat "$1" 2>/dev/null
}

identityd_read_linked() {
    local linked
    linked="$(normalize_gateway_eui "$(identityd_uci_get osi-server.cloud.link_gateway_device_eui)" || true)"
    printf '%s\n' "$linked"
}

identityd_write_cache() {
    local eui source confidence verified phase updated linked linked_json content
    eui="$(normalize_gateway_eui "$1" || true)"
    source="$(identityd_source_normalize "$2" || true)"
    confidence="$(identityd_confidence_normalize "$3" || true)"
    verified="$(identityd_timestamp_normalize "$4" || true)"
    phase="$5"
    case "$phase" in
        provisional|active|healing|restart_pending) ;;
        *) return 1 ;;
    esac
    [ -n "$eui" ] || return 1
    [ -n "$source" ] || return 1
    [ -n "$confidence" ] || return 1
    updated="$(identityd_now_iso)" || return 1
    linked="$(identityd_read_linked)"
    if [ -n "$linked" ]; then
        linked_json="\"$linked\""
    else
        linked_json="null"
    fi
    content="{\"deviceEui\":\"$eui\",\"source\":\"$source\",\"confidence\":\"$confidence\",\"lastVerifiedAt\":\"$verified\",\"linkGatewayDeviceEui\":$linked_json,\"phase\":\"$phase\",\"updatedAt\":\"$updated\"}"
    identityd_atomic_write "$IDENTITYD_CACHE_FILE" "$content"
}

identityd_load_cache() {
    local raw canonical eui source confidence verified linked_type linked_token linked linked_json phase updated
    [ -f "$IDENTITYD_CACHE_FILE" ] || return 1
    raw="$(identityd_json_raw "$IDENTITYD_CACHE_FILE" || true)"
    eui="$(normalize_gateway_eui "$(identityd_json_get "$IDENTITYD_CACHE_FILE" deviceEui || true)" || true)"
    source="$(identityd_source_normalize "$(identityd_json_get "$IDENTITYD_CACHE_FILE" source || true)" || true)"
    confidence="$(identityd_confidence_normalize "$(identityd_json_get "$IDENTITYD_CACHE_FILE" confidence || true)" || true)"
    verified="$(identityd_timestamp_normalize "$(identityd_json_get "$IDENTITYD_CACHE_FILE" lastVerifiedAt || true)" || true)"
    linked_type="$(identityd_json_type "$IDENTITYD_CACHE_FILE" linkGatewayDeviceEui || true)"
    case "$linked_type" in
        null)
            linked=""
            linked_json="null"
            ;;
        string)
            linked_token="$(identityd_json_get "$IDENTITYD_CACHE_FILE" linkGatewayDeviceEui || true)"
            linked="$(normalize_gateway_eui "$linked_token" || true)"
            [ -n "$linked" ] || return 1
            linked_json="\"$linked\""
            ;;
        *)
            return 1
            ;;
    esac
    phase="$(identityd_json_get "$IDENTITYD_CACHE_FILE" phase || true)"
    case "$phase" in
        provisional|active|healing|restart_pending) ;;
        *) return 1 ;;
    esac
    updated="$(identityd_timestamp_normalize "$(identityd_json_get "$IDENTITYD_CACHE_FILE" updatedAt || true)" || true)"
    [ -n "$eui" ] || return 1
    [ -n "$source" ] || return 1
    [ -n "$confidence" ] || return 1
    [ -n "$updated" ] || return 1
    canonical="{\"deviceEui\":\"$eui\",\"source\":\"$source\",\"confidence\":\"$confidence\",\"lastVerifiedAt\":\"$verified\",\"linkGatewayDeviceEui\":$linked_json,\"phase\":\"$phase\",\"updatedAt\":\"$updated\"}"
    [ "$raw" = "$canonical" ] || return 1
    IDENTITYD_CACHE_DEVICE_EUI="$eui"
    IDENTITYD_CACHE_SOURCE="$source"
    IDENTITYD_CACHE_CONFIDENCE="$confidence"
    IDENTITYD_CACHE_VERIFIED="$verified"
    IDENTITYD_CACHE_LINKED="$linked"
    IDENTITYD_CACHE_PHASE="$phase"
    IDENTITYD_CACHE_UPDATED="$updated"
}

identityd_read_durable() {
    IDENTITYD_DURABLE_DEVICE_EUI_RAW="$(identityd_uci_get osi-server.cloud.device_eui)"
    IDENTITYD_DURABLE_CONFIDENCE_RAW="$(identityd_uci_get osi-server.cloud.device_eui_confidence)"
    IDENTITYD_DURABLE_DEVICE_EUI="$(normalize_gateway_eui "$IDENTITYD_DURABLE_DEVICE_EUI_RAW" || true)"
    IDENTITYD_DURABLE_CONFIDENCE="$(identityd_confidence_normalize "$IDENTITYD_DURABLE_CONFIDENCE_RAW" || true)"
    IDENTITYD_DURABLE_SOURCE="$(identityd_source_normalize "$(identityd_uci_get osi-server.cloud.device_eui_source)" || true)"
    IDENTITYD_DURABLE_VERIFIED="$(identityd_timestamp_normalize "$(identityd_uci_get osi-server.cloud.device_eui_last_verified_at)" || true)"
}

identityd_read_fresh() {
    gateway_identity_resolve || return 1
    IDENTITYD_FRESH_DEVICE_EUI="$(normalize_gateway_eui "$GATEWAY_IDENTITY_DEVICE_EUI" || true)"
    IDENTITYD_FRESH_SOURCE="$(identityd_source_normalize "$GATEWAY_IDENTITY_DEVICE_EUI_SOURCE" || true)"
    IDENTITYD_FRESH_CONFIDENCE="$(identityd_confidence_normalize "$GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE" || true)"
    IDENTITYD_FRESH_VERIFIED="$(identityd_timestamp_normalize "$GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT" || true)"
    [ -n "$IDENTITYD_FRESH_DEVICE_EUI" ] || return 1
    [ -n "$IDENTITYD_FRESH_SOURCE" ] || return 1
    [ -n "$IDENTITYD_FRESH_CONFIDENCE" ] || return 1
}

identityd_write_healing_sentinel() {
    local target requested content
    target="$(normalize_gateway_eui "$1" || true)"
    requested="$(identityd_timestamp_normalize "$2" || true)"
    [ -n "$target" ] || return 1
    [ -n "$requested" ] || return 1
    content="{\"phase\":\"healing\",\"restartAt\":null,\"restartAtEpoch\":null,\"restartNotBeforeUptime\":null,\"reason\":\"gateway_identity_change\",\"targetDeviceEui\":\"$target\",\"requestedAt\":\"$requested\"}"
    identityd_atomic_write "$IDENTITYD_SENTINEL_FILE" "$content"
}

identityd_write_pending_sentinel() {
    local reason target requested restart_epoch restart_uptime restart_at target_json content
    reason="$1"
    target="$2"
    requested="$(identityd_timestamp_normalize "$3" || true)"
    restart_epoch="$4"
    restart_uptime="$5"
    identityd_reason_valid "$reason" || return 1
    [ -n "$requested" ] || return 1
    identityd_uint_valid "$restart_epoch" "$IDENTITYD_MAX_EPOCH" || return 1
    identityd_uint_valid "$restart_uptime" "$IDENTITYD_MAX_EPOCH" || return 1
    if [ -n "$target" ]; then
        target="$(normalize_gateway_eui "$target" || true)"
        [ -n "$target" ] || return 1
        target_json="\"$target\""
    else
        target_json="null"
    fi
    restart_at="$(identityd_format_epoch "$restart_epoch")" || return 1
    content="{\"phase\":\"restart_pending\",\"restartAt\":\"$restart_at\",\"restartAtEpoch\":$restart_epoch,\"restartNotBeforeUptime\":$restart_uptime,\"reason\":\"$reason\",\"targetDeviceEui\":$target_json,\"requestedAt\":\"$requested\"}"
    identityd_atomic_write "$IDENTITYD_SENTINEL_FILE" "$content"
}

identityd_load_sentinel() {
    local raw canonical phase reason requested restart_token restart_uptime restart_at target_type target_token target target_json
    [ -f "$IDENTITYD_SENTINEL_FILE" ] || return 1
    raw="$(identityd_json_raw "$IDENTITYD_SENTINEL_FILE" || true)"
    phase="$(identityd_json_get "$IDENTITYD_SENTINEL_FILE" phase || true)"
    reason="$(identityd_json_get "$IDENTITYD_SENTINEL_FILE" reason || true)"
    requested="$(identityd_timestamp_normalize "$(identityd_json_get "$IDENTITYD_SENTINEL_FILE" requestedAt || true)" || true)"
    identityd_reason_valid "$reason" || return 2
    [ -n "$requested" ] || return 2
    target_type="$(identityd_json_type "$IDENTITYD_SENTINEL_FILE" targetDeviceEui || true)"
    case "$target_type" in
        null)
            target=""
            target_json="null"
            ;;
        string)
            target_token="$(identityd_json_get "$IDENTITYD_SENTINEL_FILE" targetDeviceEui || true)"
            target="$(normalize_gateway_eui "$target_token" || true)"
            [ -n "$target" ] || return 2
            target_json="\"$target\""
            ;;
        *)
            return 2
            ;;
    esac
    case "$phase" in
        healing)
            [ "$reason" = "gateway_identity_change" ] || return 2
            [ -n "$target" ] || return 2
            [ "$(identityd_json_type "$IDENTITYD_SENTINEL_FILE" restartAt || true)" = "null" ] || return 2
            [ "$(identityd_json_type "$IDENTITYD_SENTINEL_FILE" restartAtEpoch || true)" = "null" ] || return 2
            [ "$(identityd_json_type "$IDENTITYD_SENTINEL_FILE" restartNotBeforeUptime || true)" = "null" ] || return 2
            restart_at=""
            restart_token=""
            restart_uptime=""
            canonical="{\"phase\":\"healing\",\"restartAt\":null,\"restartAtEpoch\":null,\"restartNotBeforeUptime\":null,\"reason\":\"gateway_identity_change\",\"targetDeviceEui\":$target_json,\"requestedAt\":\"$requested\"}"
            ;;
        restart_pending)
            restart_token="$(identityd_json_get "$IDENTITYD_SENTINEL_FILE" restartAtEpoch || true)"
            restart_uptime="$(identityd_json_get "$IDENTITYD_SENTINEL_FILE" restartNotBeforeUptime || true)"
            restart_at="$(identityd_timestamp_normalize "$(identityd_json_get "$IDENTITYD_SENTINEL_FILE" restartAt || true)" || true)"
            identityd_uint_valid "$restart_token" "$IDENTITYD_MAX_EPOCH" || return 2
            identityd_uint_valid "$restart_uptime" "$IDENTITYD_MAX_EPOCH" || return 2
            [ -n "$restart_at" ] || return 2
            canonical="{\"phase\":\"restart_pending\",\"restartAt\":\"$restart_at\",\"restartAtEpoch\":$restart_token,\"restartNotBeforeUptime\":$restart_uptime,\"reason\":\"$reason\",\"targetDeviceEui\":$target_json,\"requestedAt\":\"$requested\"}"
            ;;
        *)
            return 2
            ;;
    esac
    [ "$raw" = "$canonical" ] || return 2
    IDENTITYD_SENTINEL_PHASE="$phase"
    IDENTITYD_SENTINEL_REASON="$reason"
    IDENTITYD_SENTINEL_REQUESTED="$requested"
    IDENTITYD_SENTINEL_TARGET="$target"
    IDENTITYD_SENTINEL_RESTART_EPOCH="$restart_token"
    IDENTITYD_SENTINEL_RESTART_UPTIME="$restart_uptime"
    IDENTITYD_SENTINEL_RESTART_AT="$restart_at"
}

identityd_cache_with_phase() {
    local phase
    phase="$1"
    if identityd_load_cache; then
        identityd_write_cache \
            "$IDENTITYD_CACHE_DEVICE_EUI" \
            "$IDENTITYD_CACHE_SOURCE" \
            "$IDENTITYD_CACHE_CONFIDENCE" \
            "$IDENTITYD_CACHE_VERIFIED" \
            "$phase"
        return $?
    fi
    identityd_read_durable
    [ -n "$IDENTITYD_DURABLE_DEVICE_EUI" ] || return 0
    [ -n "$IDENTITYD_DURABLE_CONFIDENCE" ] || return 0
    [ -n "$IDENTITYD_DURABLE_SOURCE" ] || IDENTITYD_DURABLE_SOURCE="persisted"
    identityd_write_cache \
        "$IDENTITYD_DURABLE_DEVICE_EUI" \
        "$IDENTITYD_DURABLE_SOURCE" \
        "$IDENTITYD_DURABLE_CONFIDENCE" \
        "$IDENTITYD_DURABLE_VERIFIED" \
        "$phase"
}

identityd_resume_heal() {
    local now target requested final_eui final_source final_confidence final_verified
    now="$1"
    target="$IDENTITYD_SENTINEL_TARGET"
    requested="$IDENTITYD_SENTINEL_REQUESTED"
    if ! gateway_identity_heal; then
        identityd_cache_with_phase healing || true
        IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 10))
        return 1
    fi

    final_eui="$(normalize_gateway_eui "$GATEWAY_IDENTITY_DEVICE_EUI" || true)"
    final_source="$(identityd_source_normalize "$GATEWAY_IDENTITY_DEVICE_EUI_SOURCE" || true)"
    final_confidence="$(identityd_confidence_normalize "$GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE" || true)"
    final_verified="$(identityd_timestamp_normalize "$GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT" || true)"
    if [ -z "$final_eui" ] || [ -z "$final_source" ] || [ -z "$final_confidence" ] || [ "$final_confidence" = "provisional" ]; then
        if [ -n "$final_eui" ] && [ -n "$final_source" ] && [ -n "$final_confidence" ]; then
            identityd_write_cache "$final_eui" "$final_source" "$final_confidence" "$final_verified" healing || true
        else
            identityd_cache_with_phase healing || true
        fi
        IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 10))
        return 1
    fi

    identityd_read_durable
    if [ "$IDENTITYD_DURABLE_DEVICE_EUI_RAW" != "$final_eui" ] || [ "$IDENTITYD_DURABLE_CONFIDENCE_RAW" != "$final_confidence" ]; then
        identityd_write_cache "$final_eui" "$final_source" "$final_confidence" "$final_verified" healing || true
        IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 10))
        return 1
    fi

    if [ "$final_eui" != "$target" ]; then
        identityd_write_healing_sentinel "$final_eui" "$requested" || return 1
    fi
    identityd_write_pending_sentinel \
        gateway_identity_change \
        "$final_eui" \
        "$requested" \
        "$((now + 60))" \
        "$((IDENTITYD_NOW_UPTIME + 60))" || return 1
    identityd_write_cache "$final_eui" "$final_source" "$final_confidence" "$final_verified" restart_pending || true
    IDENTITYD_PROVISIONAL_SINCE_UPTIME=""
    IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 300))
}

identityd_start_transition() {
    local now requested
    now="$1"
    requested="$(identityd_now_iso)" || return 1
    identityd_write_healing_sentinel "$IDENTITYD_FRESH_DEVICE_EUI" "$requested" || return 1
    identityd_write_cache \
        "$IDENTITYD_FRESH_DEVICE_EUI" \
        "$IDENTITYD_FRESH_SOURCE" \
        "$IDENTITYD_FRESH_CONFIDENCE" \
        "$IDENTITYD_FRESH_VERIFIED" \
        healing || true
    identityd_load_sentinel || return 1
    identityd_resume_heal "$now"
}

identityd_resolve_tick() {
    local now phase
    now="$1"
    if ! identityd_read_fresh; then
        IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 10))
        return 1
    fi
    identityd_read_durable
    if [ "$IDENTITYD_FRESH_CONFIDENCE" != "provisional" ] && {
        [ "$IDENTITYD_FRESH_DEVICE_EUI" != "$IDENTITYD_DURABLE_DEVICE_EUI" ] ||
        [ -z "$IDENTITYD_DURABLE_CONFIDENCE" ] ||
        [ "$IDENTITYD_DURABLE_CONFIDENCE" = "provisional" ] ||
        [ "$IDENTITYD_DURABLE_DEVICE_EUI_RAW" != "$IDENTITYD_DURABLE_DEVICE_EUI" ] ||
        [ "$IDENTITYD_DURABLE_CONFIDENCE_RAW" != "$IDENTITYD_DURABLE_CONFIDENCE" ];
    }; then
        identityd_start_transition "$now"
        return $?
    fi

    if [ "$IDENTITYD_FRESH_CONFIDENCE" = "provisional" ]; then
        phase="provisional"
        if [ -z "$IDENTITYD_PROVISIONAL_SINCE_UPTIME" ]; then
            IDENTITYD_PROVISIONAL_SINCE_UPTIME="$IDENTITYD_NOW_UPTIME"
        fi
        if [ $((IDENTITYD_NOW_UPTIME - IDENTITYD_PROVISIONAL_SINCE_UPTIME)) -lt 600 ]; then
            IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 10))
        else
            IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 300))
        fi
    else
        phase="active"
        IDENTITYD_PROVISIONAL_SINCE_UPTIME=""
        IDENTITYD_NEXT_RESOLVE_UPTIME=$((IDENTITYD_NOW_UPTIME + 300))
    fi
    identityd_write_cache \
        "$IDENTITYD_FRESH_DEVICE_EUI" \
        "$IDENTITYD_FRESH_SOURCE" \
        "$IDENTITYD_FRESH_CONFIDENCE" \
        "$IDENTITYD_FRESH_VERIFIED" \
        "$phase"
}

identityd_load_request() {
    local file raw canonical reason requested requested_epoch delay
    file="$1"
    raw="$(identityd_json_raw "$file" || true)"
    reason="$(identityd_json_get "$file" reason || true)"
    requested_epoch="$(identityd_json_get "$file" requestedAtEpoch || true)"
    delay="$(identityd_json_get "$file" delaySeconds || true)"
    identityd_reason_valid "$reason" || return 1
    identityd_uint_valid "$delay" 300 || return 1
    [ "$delay" -ge 1 ] && [ "$delay" -le 300 ] || return 1
    identityd_uint_valid "$requested_epoch" "$IDENTITYD_MAX_EPOCH" || return 1
    canonical="{\"reason\":\"$reason\",\"delaySeconds\":$delay,\"requestedAtEpoch\":$requested_epoch}"
    [ "$raw" = "$canonical" ] || return 1
    requested="$(identityd_format_epoch "$requested_epoch")" || return 1
    IDENTITYD_REQUEST_REASON="$reason"
    IDENTITYD_REQUEST_REQUESTED="$requested"
    IDENTITYD_REQUEST_DELAY="$delay"
}

identityd_schedule_request() {
    local reason requested delay maximum_start restart_epoch restart_uptime existing_status
    reason="$1"
    requested="$2"
    delay="$3"
    identityd_uint_valid "$delay" 300 || return 1
    [ "$delay" -ge 1 ] || return 1
    maximum_start=$((IDENTITYD_MAX_EPOCH - delay))
    identityd_uint_valid "$IDENTITYD_NOW_EPOCH" "$maximum_start" || return 1
    identityd_uint_valid "$IDENTITYD_NOW_UPTIME" "$maximum_start" || return 1
    restart_epoch=$((IDENTITYD_NOW_EPOCH + delay))
    restart_uptime=$((IDENTITYD_NOW_UPTIME + delay))
    existing_status=1
    if [ -f "$IDENTITYD_SENTINEL_FILE" ]; then
        identityd_load_sentinel
        existing_status=$?
        [ "$existing_status" -eq 0 ] || return 1
        if [ "$IDENTITYD_SENTINEL_PHASE" = "healing" ]; then
            return 0
        fi
        if [ "$IDENTITYD_SENTINEL_REASON" = "gateway_identity_change" ]; then
            return 0
        fi
        if [ "$reason" != "gateway_identity_change" ] && [ "$IDENTITYD_SENTINEL_RESTART_UPTIME" -le "$restart_uptime" ]; then
            return 0
        fi
    fi
    identityd_write_pending_sentinel "$reason" "" "$requested" "$restart_epoch" "$restart_uptime" || return 1
    identityd_cache_with_phase restart_pending || true
}

identityd_process_requests() {
    local request
    [ -d "$IDENTITYD_REQUEST_DIR" ] || return 0
    for request in "$IDENTITYD_REQUEST_DIR"/*.json; do
        [ -f "$request" ] || continue
        if identityd_load_request "$request"; then
            if identityd_schedule_request \
                "$IDENTITYD_REQUEST_REASON" \
                "$IDENTITYD_REQUEST_REQUESTED" \
                "$IDENTITYD_REQUEST_DELAY"; then
                rm -f "$request"
            fi
        else
            printf '%s\n' "osi-identityd: removing invalid restart request: ${request##*/}" >&2
            rm -f "$request"
        fi
    done
}

identityd_cache_after_restart() {
    local reason phase
    reason="$1"
    if [ "$reason" = "gateway_identity_change" ]; then
        identityd_read_durable
        [ -n "$IDENTITYD_DURABLE_DEVICE_EUI" ] || return 1
        [ -n "$IDENTITYD_DURABLE_CONFIDENCE" ] || return 1
        [ "$IDENTITYD_DURABLE_CONFIDENCE" != "provisional" ] || return 1
        [ -n "$IDENTITYD_DURABLE_SOURCE" ] || IDENTITYD_DURABLE_SOURCE="persisted"
        identityd_write_cache \
            "$IDENTITYD_DURABLE_DEVICE_EUI" \
            "$IDENTITYD_DURABLE_SOURCE" \
            "$IDENTITYD_DURABLE_CONFIDENCE" \
            "$IDENTITYD_DURABLE_VERIFIED" \
            active
        return $?
    fi
    if identityd_load_cache; then
        if [ "$IDENTITYD_CACHE_CONFIDENCE" = "provisional" ]; then
            phase="provisional"
        else
            phase="active"
        fi
        identityd_write_cache \
            "$IDENTITYD_CACHE_DEVICE_EUI" \
            "$IDENTITYD_CACHE_SOURCE" \
            "$IDENTITYD_CACHE_CONFIDENCE" \
            "$IDENTITYD_CACHE_VERIFIED" \
            "$phase"
    fi
}

identityd_process_restart_deadline() {
    local now reason target requested remaining rebased_epoch rebased_at malformed completed_sentinel current_sentinel
    now="$1"
    if [ ! -f "$IDENTITYD_SENTINEL_FILE" ]; then
        identityd_remove_completion 2>/dev/null || true
        identityd_clear_completed_sentinel
        IDENTITYD_LAST_MALFORMED_SENTINEL=""
        IDENTITYD_LAST_MALFORMED_SENTINEL_SET=0
        return 0
    fi
    if [ "$IDENTITYD_COMPLETED_SENTINEL_SET" -eq 1 ]; then
        current_sentinel="$(identityd_json_raw "$IDENTITYD_SENTINEL_FILE" 2>/dev/null || true)"
        if [ "$current_sentinel" = "$IDENTITYD_COMPLETED_SENTINEL_RAW" ]; then
            if identityd_load_sentinel; then
                identityd_finish_completed_sentinel "$IDENTITYD_SENTINEL_REASON"
            fi
            return 0
        fi
        identityd_clear_completed_sentinel
    fi
    if [ -f "$IDENTITYD_COMPLETION_FILE" ]; then
        if cmp -s "$IDENTITYD_SENTINEL_FILE" "$IDENTITYD_COMPLETION_FILE"; then
            if identityd_load_sentinel; then
                identityd_finish_completed_sentinel "$IDENTITYD_SENTINEL_REASON"
            fi
            return 0
        fi
        identityd_remove_completion || return 1
    fi
    if ! identityd_load_sentinel; then
        malformed="$(identityd_json_raw "$IDENTITYD_SENTINEL_FILE" || true)"
        if [ "$IDENTITYD_LAST_MALFORMED_SENTINEL_SET" -ne 1 ] || [ "$malformed" != "$IDENTITYD_LAST_MALFORMED_SENTINEL" ]; then
            printf '%s\n' "osi-identityd: retaining malformed restart sentinel" >&2
            IDENTITYD_LAST_MALFORMED_SENTINEL="$malformed"
            IDENTITYD_LAST_MALFORMED_SENTINEL_SET=1
        fi
        return 0
    fi
    IDENTITYD_LAST_MALFORMED_SENTINEL=""
    IDENTITYD_LAST_MALFORMED_SENTINEL_SET=0
    [ "$IDENTITYD_SENTINEL_PHASE" = "restart_pending" ] || return 0
    remaining=$((IDENTITYD_SENTINEL_RESTART_UPTIME - IDENTITYD_NOW_UPTIME))
    [ "$remaining" -ge 0 ] || remaining=0
    rebased_epoch=$((now + remaining))
    rebased_at="$(identityd_format_epoch "$rebased_epoch")" || return 1
    if [ "$IDENTITYD_SENTINEL_RESTART_EPOCH" != "$rebased_epoch" ] || [ "$IDENTITYD_SENTINEL_RESTART_AT" != "$rebased_at" ]; then
        identityd_write_pending_sentinel \
            "$IDENTITYD_SENTINEL_REASON" \
            "$IDENTITYD_SENTINEL_TARGET" \
            "$IDENTITYD_SENTINEL_REQUESTED" \
            "$rebased_epoch" \
            "$IDENTITYD_SENTINEL_RESTART_UPTIME" || return 1
        IDENTITYD_SENTINEL_RESTART_EPOCH="$rebased_epoch"
        IDENTITYD_SENTINEL_RESTART_AT="$rebased_at"
    fi
    [ "$IDENTITYD_SENTINEL_RESTART_UPTIME" -le "$IDENTITYD_NOW_UPTIME" ] || return 0
    reason="$IDENTITYD_SENTINEL_REASON"
    target="$IDENTITYD_SENTINEL_TARGET"
    requested="$IDENTITYD_SENTINEL_REQUESTED"
    if "$OSI_NODE_RED_SERVICE" restart; then
        completed_sentinel="$(identityd_json_raw "$IDENTITYD_SENTINEL_FILE")" || return 1
        identityd_remember_completed_sentinel "$completed_sentinel"
        if ! identityd_write_completion_marker "$completed_sentinel"; then
            printf '%s\n' "osi-identityd: Node-RED restart succeeded but completion marker write failed; suppressing repeated restart" >&2
            identityd_finish_completed_sentinel "$reason"
            return 0
        fi
        identityd_finish_completed_sentinel "$reason"
        return 0
    fi
    identityd_write_pending_sentinel "$reason" "$target" "$requested" "$((now + 30))" "$((IDENTITYD_NOW_UPTIME + 30))"
}

identityd_control_tick() {
    local now uptime sentinel_status
    now="$(identityd_now_epoch)" || return 1
    identityd_uint_valid "$now" "$IDENTITYD_MAX_EPOCH" || return 1
    uptime="$(identityd_now_uptime)" || return 1
    identityd_uint_valid "$uptime" "$IDENTITYD_MAX_EPOCH" || return 1
    IDENTITYD_NOW_EPOCH="$now"
    IDENTITYD_NOW_UPTIME="$uptime"

    identityd_process_requests
    identityd_process_restart_deadline "$now"

    if [ "$IDENTITYD_NEXT_RESOLVE_UPTIME" -gt "$uptime" ]; then
        return 0
    fi

    if [ -f "$IDENTITYD_SENTINEL_FILE" ]; then
        sentinel_status=0
        identityd_load_sentinel || sentinel_status=$?
        if [ "$sentinel_status" -ne 0 ]; then
            return 0
        fi
        if [ "$IDENTITYD_SENTINEL_PHASE" = "healing" ]; then
            identityd_resume_heal "$now" || true
            return 0
        fi
        if [ "$IDENTITYD_SENTINEL_REASON" = "gateway_identity_change" ]; then
            IDENTITYD_NEXT_RESOLVE_UPTIME=$((uptime + 300))
            return 0
        fi
    fi

    identityd_resolve_tick "$now" || true
}

identityd_request_restart() {
    local reason delay now_epoch maximum_requested_epoch request_file temporary content
    reason="$1"
    delay="$2"
    identityd_reason_valid "$reason" || return 2
    identityd_uint_valid "$delay" 300 || return 2
    [ "$delay" -ge 1 ] && [ "$delay" -le 300 ] || return 2
    identityd_refresh_paths
    mkdir -p "$OSI_IDENTITY_RUN_DIR" "$IDENTITYD_REQUEST_DIR" || return 1
    chmod 700 "$IDENTITYD_REQUEST_DIR" 2>/dev/null || true
    now_epoch="$(identityd_now_epoch)" || return 1
    maximum_requested_epoch=$((IDENTITYD_MAX_EPOCH - delay))
    identityd_uint_valid "$now_epoch" "$maximum_requested_epoch" || return 1
    IDENTITYD_ATOMIC_COUNTER="${IDENTITYD_ATOMIC_COUNTER:-0}"
    IDENTITYD_ATOMIC_COUNTER=$((IDENTITYD_ATOMIC_COUNTER + 1))
    request_file="$IDENTITYD_REQUEST_DIR/$now_epoch-$$-$IDENTITYD_ATOMIC_COUNTER.json"
    while [ -e "$request_file" ]; do
        IDENTITYD_ATOMIC_COUNTER=$((IDENTITYD_ATOMIC_COUNTER + 1))
        request_file="$IDENTITYD_REQUEST_DIR/$now_epoch-$$-$IDENTITYD_ATOMIC_COUNTER.json"
    done
    temporary="$request_file.tmp"
    content="{\"reason\":\"$reason\",\"delaySeconds\":$delay,\"requestedAtEpoch\":$now_epoch}"
    if ! printf '%s\n' "$content" > "$temporary"; then
        rm -f "$temporary"
        return 1
    fi
    chmod 600 "$temporary" 2>/dev/null || true
    if ! mv "$temporary" "$request_file"; then
        rm -f "$temporary"
        return 1
    fi
}

identityd_initialize() {
    identityd_refresh_paths
    IDENTITYD_ATOMIC_COUNTER=0
    IDENTITYD_PROVISIONAL_SINCE_UPTIME=""
    IDENTITYD_NEXT_RESOLVE_UPTIME=0
    IDENTITYD_LAST_MALFORMED_SENTINEL=""
    IDENTITYD_LAST_MALFORMED_SENTINEL_SET=0
    IDENTITYD_LOCK_HELD=0
    mkdir -p "$OSI_IDENTITY_RUN_DIR" "$IDENTITYD_REQUEST_DIR" || return 1
    chmod 700 "$IDENTITYD_REQUEST_DIR" 2>/dev/null || true
}

identityd_start() {
    identityd_initialize || return 1
    if ! identityd_lock_acquire; then
        printf '%s\n' "osi-identityd: another consumer owns $IDENTITYD_LOCK_DIR" >&2
        return 1
    fi
    trap 'identityd_lock_release' 0
    trap 'exit 1' 1 2 15
    while :; do
        identityd_control_tick || true
        sleep 1
    done
}

identityd_run_once() {
    local status
    identityd_initialize || return 1
    if ! identityd_lock_acquire; then
        printf '%s\n' "osi-identityd: another consumer owns $IDENTITYD_LOCK_DIR" >&2
        return 1
    fi
    trap 'identityd_lock_release' 0
    trap 'exit 1' 1 2 15
    status=0
    identityd_control_tick || status=$?
    identityd_lock_release || status=1
    trap - 0 1 2 15
    return "$status"
}

identityd_main() {
    case "${1:-}" in
        start)
            [ "$#" -eq 1 ] || return 2
            identityd_start
            ;;
        run-once)
            [ "$#" -eq 1 ] || return 2
            identityd_run_once
            ;;
        ready)
            [ "$#" -eq 1 ] || return 2
            identityd_ready
            ;;
        request-restart)
            [ "$#" -eq 3 ] || return 2
            identityd_request_restart "$2" "$3"
            ;;
        *)
            printf '%s\n' "usage: osi-identityd.sh {start|run-once|ready|request-restart REASON DELAY}" >&2
            return 2
            ;;
    esac
}

case "${0##*/}" in
    osi-identityd.sh|osi-identityd)
        identityd_main "$@"
        exit $?
        ;;
esac
