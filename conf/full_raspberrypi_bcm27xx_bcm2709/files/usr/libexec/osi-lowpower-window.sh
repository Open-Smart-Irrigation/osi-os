#!/bin/sh

CONFIG="osi-lowpower.main"

get_opt() {
    local key="$1"
    local default="$2"
    local value
    value="$(uci -q get "$CONFIG.$key" 2>/dev/null || true)"
    [ -n "$value" ] && printf '%s' "$value" || printf '%s' "$default"
}

log_msg() {
    logger -t osi-lowpower "$*"
}

state_file() {
    get_opt state_file "/var/run/osi-lowpower/window.env"
}

enabled() {
    [ "$(get_opt enabled 0)" = "1" ]
}

iso_now() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

epoch_to_iso() {
    local epoch="$1"
    date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || iso_now
}

to_int() {
    local value="${1:-0}"
    while [ "${value#0}" != "$value" ]; do
        value="${value#0}"
    done
    [ -n "$value" ] || value=0
    printf '%s' "$value"
}

ensure_state_dir() {
    mkdir -p "$(dirname "$(state_file)")"
}

read_state_value() {
    local key="$1"
    local file
    file="$(state_file)"
    [ -f "$file" ] || return 1
    sed -n "s/^${key}=//p" "$file" | head -n 1
}

current_state() {
    local value
    value="$(read_state_value OSI_LOWPOWER_WINDOW_STATE 2>/dev/null || true)"
    [ -n "$value" ] && printf '%s' "$value" || printf 'missing'
}

write_state() {
    local state="$1"
    local reason="$2"
    local opened_at="${3:-$(iso_now)}"
    local closes_at="${4:-$opened_at}"
    local file
    file="$(state_file)"
    ensure_state_dir
    {
        printf 'OSI_LOWPOWER_ENABLED=%s\n' "$(get_opt enabled 0)"
        printf 'OSI_LOWPOWER_WINDOW_STATE=%s\n' "$state"
        printf 'OSI_LOWPOWER_WINDOW_OPENED_AT=%s\n' "$opened_at"
        printf 'OSI_LOWPOWER_WINDOW_CLOSES_AT=%s\n' "$closes_at"
        printf 'OSI_LOWPOWER_REASON=%s\n' "$reason"
    } > "$file"
}

apply_wifi() {
    local txpower current
    txpower="$(get_opt wifi_txpower '')"
    [ -n "$txpower" ] || return 0
    current="$(uci -q get wireless.radio0.txpower 2>/dev/null || true)"
    [ "$current" = "$txpower" ] && return 0
    uci -q set wireless.radio0.txpower="$txpower" 2>/dev/null || return 0
    uci -q commit wireless 2>/dev/null || true
    wifi reload >/dev/null 2>&1 || true
}

set_usb_power() {
    local action="$1"
    local hubs hub
    [ "$(get_opt usb_control 0)" = "1" ] || return 0
    hubs="$(get_opt usb_hubs '')"
    [ -n "$hubs" ] || return 0
    for hub in $hubs; do
        if ! uhubctl -l "$hub" -a "$action" >/dev/null 2>&1; then
            log_msg "uhubctl failed for hub $hub action $action"
        fi
    done
}

set_eth() {
    local action="$1"
    local ifname
    [ "$(get_opt eth_control 0)" = "1" ] || return 0
    ifname="$(get_opt eth_ifname eth0)"
    ip link set "$ifname" "$action" >/dev/null 2>&1 || log_msg "ip link $action failed for $ifname"
}

wait_for_route() {
    local waited=0
    local health_url
    health_url="$(get_opt health_url '')"
    while [ "$waited" -lt 180 ]; do
        if [ -n "$health_url" ] && wget -q -T 5 -O /dev/null "$health_url" >/dev/null 2>&1; then
            return 0
        fi
        if ip route show default 2>/dev/null | grep -q .; then
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
    done
    return 1
}

route_present() {
    ip route show default 2>/dev/null | grep -q .
}

open_window() {
    local opened_at closes_at duration now_epoch previous_state reason
    enabled || {
        write_state disabled "low-power disabled"
        return 0
    }
    previous_state="$(current_state)"
    opened_at="$(iso_now)"
    duration="$(get_opt window_duration_minutes 60)"
    now_epoch="$(date -u '+%s')"
    closes_at="$(epoch_to_iso $((now_epoch + duration * 60)))"

    if [ "$previous_state" = "open" ]; then
        if route_present; then
            reason="scheduled"
        else
            reason="open_no_route"
        fi
        write_state open "$reason" "$opened_at" "$closes_at"
        return 0
    fi

    apply_wifi
    set_usb_power 1
    set_eth up
    if wait_for_route; then
        write_state open "scheduled" "$opened_at" "$closes_at"
    else
        write_state open "open_no_route" "$opened_at" "$closes_at"
    fi
}

close_window() {
    local now previous_state
    enabled || {
        write_state disabled "low-power disabled"
        return 0
    }
    previous_state="$(current_state)"
    if [ "$previous_state" = "closed" ]; then
        now="$(iso_now)"
        write_state closed "scheduled" "$now" "$now"
        return 0
    fi
    now="$(iso_now)"
    write_state closing "scheduled" "$now" "$now"
    set_eth down
    set_usb_power 0
    now="$(iso_now)"
    write_state closed "scheduled" "$now" "$now"
}

minutes_from_hhmm() {
    local value="$1"
    local hh mm
    hh="${value%%:*}"
    mm="${value#*:}"
    hh="$(to_int "$hh")"
    mm="$(to_int "$mm")"
    printf '%s' $((hh * 60 + mm))
}

inside_window() {
    local start duration now end now_hh now_mm
    start="$(minutes_from_hhmm "$(get_opt window_start 02:00)")"
    duration="$(get_opt window_duration_minutes 60)"
    now_hh="$(to_int "$(date '+%H')")"
    now_mm="$(to_int "$(date '+%M')")"
    now=$((now_hh * 60 + now_mm))
    end=$(((start + duration) % 1440))
    if [ "$duration" -ge 1440 ]; then
        return 0
    fi
    if [ "$start" -le "$end" ]; then
        [ "$now" -ge "$start" ] && [ "$now" -lt "$end" ]
        return $?
    fi
    [ "$now" -ge "$start" ] || [ "$now" -lt "$end" ]
}

reconcile() {
    enabled || {
        apply_wifi
        write_state disabled "low-power disabled"
        return 0
    }
    if inside_window; then
        open_window
    else
        close_window
    fi
}

status_cmd() {
    local file
    file="$(state_file)"
    if [ -f "$file" ]; then
        cat "$file"
        return 0
    fi
    printf 'OSI_LOWPOWER_ENABLED=%s\n' "$(get_opt enabled 0)"
    printf 'OSI_LOWPOWER_WINDOW_STATE=missing\n'
    printf 'OSI_LOWPOWER_REASON=state file missing\n'
}

case "$1" in
    status) status_cmd ;;
    open) open_window ;;
    close) close_window ;;
    reconcile) reconcile ;;
    apply-wifi) apply_wifi ;;
    *) echo "Usage: $0 {status|open|close|reconcile|apply-wifi}" >&2; exit 2 ;;
esac
