#!/bin/sh

normalize_gateway_eui() {
    local raw
    raw="$(printf '%s' "$1" | tr -cd '0-9A-Fa-f' | tr 'abcdef' 'ABCDEF')"
    case "${#raw}" in
        16)
            [ "$raw" = "0101010101010101" ] && return 1
            printf '%s\n' "$raw"
            ;;
        12)
            printf '%sFFFE%s\n' "${raw%??????}" "${raw#??????}"
            ;;
        *)
            return 1
            ;;
    esac
}

gateway_identity_now() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

gateway_identity_matches_local_mac_fallback() {
    local candidate iface raw_mac resolved
    candidate="$(normalize_gateway_eui "$1" || true)"
    [ -n "$candidate" ] || return 1
    for iface in eth0 br-lan wlan0; do
        [ -r "/sys/class/net/$iface/address" ] || continue
        raw_mac="$(cat "/sys/class/net/$iface/address" 2>/dev/null || true)"
        resolved="$(normalize_gateway_eui "$raw_mac" || true)"
        [ -n "$resolved" ] || continue
        [ "$resolved" = "$candidate" ] && return 0
    done
    return 1
}

gateway_identity_try_command() {
    local source="$1"
    local command="$2"
    local candidate resolved
    candidate="$(/bin/sh -c "$command" 2>/dev/null | head -n 1 | tr -d '\r\n' || true)"
    resolved="$(normalize_gateway_eui "$candidate" || true)"
    [ -n "$resolved" ] || return 1
    GATEWAY_IDENTITY_DEVICE_EUI="$resolved"
    GATEWAY_IDENTITY_DEVICE_EUI_SOURCE="$source"
    if [ "$source" != "concentratord-runtime" ] && gateway_identity_matches_local_mac_fallback "$resolved"; then
        GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="provisional"
    else
        GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="authoritative"
    fi
    GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT="$(gateway_identity_now)"
    return 0
}

gateway_identity_read_persisted() {
    local stored stored_source stored_confidence stored_verified
    stored="$(normalize_gateway_eui "$(uci -q get osi-server.cloud.device_eui 2>/dev/null || true)" || true)"
    stored_source="$(uci -q get osi-server.cloud.device_eui_source 2>/dev/null || true)"
    stored_confidence="$(printf '%s' "$(uci -q get osi-server.cloud.device_eui_confidence 2>/dev/null || true)" | tr '[:upper:]' '[:lower:]')"
    stored_verified="$(uci -q get osi-server.cloud.device_eui_last_verified_at 2>/dev/null || true)"
    [ -n "$stored" ] || return 1
    case "$stored_confidence" in
        ""|"authoritative"|"persisted")
            GATEWAY_IDENTITY_DEVICE_EUI="$stored"
            GATEWAY_IDENTITY_DEVICE_EUI_SOURCE="${stored_source:-persisted}"
            GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="persisted"
            GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT="$stored_verified"
            return 0
            ;;
    esac
    return 1
}

gateway_identity_read_linked() {
    local linked
    linked="$(normalize_gateway_eui "$(uci -q get osi-server.cloud.link_gateway_device_eui 2>/dev/null || true)" || true)"
    [ -n "$linked" ] || return 1
    GATEWAY_IDENTITY_DEVICE_EUI="$linked"
    GATEWAY_IDENTITY_DEVICE_EUI_SOURCE="linked"
    GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="persisted"
    GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT="$(uci -q get osi-server.cloud.device_eui_last_verified_at 2>/dev/null || true)"
    return 0
}

gateway_identity_read_provisional() {
    local iface raw_mac resolved
    for iface in eth0 br-lan wlan0; do
        [ -r "/sys/class/net/$iface/address" ] || continue
        raw_mac="$(cat "/sys/class/net/$iface/address" 2>/dev/null || true)"
        resolved="$(normalize_gateway_eui "$raw_mac" || true)"
        [ -n "$resolved" ] || continue
        GATEWAY_IDENTITY_DEVICE_EUI="$resolved"
        GATEWAY_IDENTITY_DEVICE_EUI_SOURCE="mac:$iface"
        GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE="provisional"
        GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT="$(uci -q get osi-server.cloud.device_eui_last_verified_at 2>/dev/null || true)"
        return 0
    done
    return 1
}

gateway_identity_resolve() {
    GATEWAY_IDENTITY_DEVICE_EUI=""
    GATEWAY_IDENTITY_DEVICE_EUI_SOURCE=""
    GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE=""
    GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT=""

    gateway_identity_try_command "concentratord-runtime" \
        "sh /usr/bin/gateway-id.sh 2>/dev/null | grep -oE '[0-9A-Fa-f]{16}' | head -n 1" && return 0
    gateway_identity_try_command "concentratord-uci-sx1302" \
        "uci -q get chirpstack-concentratord.@sx1302[0].gateway_id 2>/dev/null || true" && return 0
    gateway_identity_try_command "concentratord-uci-sx1301" \
        "uci -q get chirpstack-concentratord.@sx1301[0].gateway_id 2>/dev/null || true" && return 0
    gateway_identity_try_command "concentratord-toml" \
        "grep -h -m1 -oE 'gateway_id\\s*=\\s*\\\"[0-9A-Fa-f]{16}\\\"' /etc/chirpstack-concentratord/sx1302/*.toml /etc/chirpstack-concentratord/sx1301/*.toml /var/etc/chirpstack-concentratord/*.toml 2>/dev/null | sed -E 's/.*\\\"([0-9A-Fa-f]{16})\\\"/\\1/'" && return 0
    gateway_identity_read_linked && return 0
    gateway_identity_read_persisted && return 0
    gateway_identity_read_provisional && return 0
    return 1
}

gateway_identity_persist() {
    local eui source confidence verified
    eui="$GATEWAY_IDENTITY_DEVICE_EUI"
    source="$GATEWAY_IDENTITY_DEVICE_EUI_SOURCE"
    confidence="$GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE"
    verified="$GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT"
    [ -n "$eui" ] || return 1
    uci -q set osi-server.cloud.device_eui="$eui"
    uci -q set osi-server.cloud.device_eui_source="$source"
    uci -q set osi-server.cloud.device_eui_confidence="$confidence"
    if [ -n "$verified" ]; then
        uci -q set osi-server.cloud.device_eui_last_verified_at="$verified"
    else
        uci -q delete osi-server.cloud.device_eui_last_verified_at 2>/dev/null || true
    fi
    uci commit osi-server
}

gateway_identity_emit_shell() {
    printf 'DEVICE_EUI=%s\n' "$GATEWAY_IDENTITY_DEVICE_EUI"
    printf 'DEVICE_EUI_SOURCE=%s\n' "$GATEWAY_IDENTITY_DEVICE_EUI_SOURCE"
    printf 'DEVICE_EUI_CONFIDENCE=%s\n' "$GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE"
    printf 'DEVICE_EUI_LAST_VERIFIED_AT=%s\n' "$GATEWAY_IDENTITY_DEVICE_EUI_LAST_VERIFIED_AT"
}

if [ "${0##*/}" = "osi-gateway-identity.sh" ] || [ "${0##*/}" = "osi-gateway-identity" ]; then
    case "$1" in
        resolve)
            gateway_identity_resolve || exit 1
            gateway_identity_emit_shell
            ;;
        persist)
            gateway_identity_resolve || exit 1
            gateway_identity_persist || exit 1
            gateway_identity_emit_shell
            ;;
    esac
fi
