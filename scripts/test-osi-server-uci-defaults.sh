#!/bin/sh
# Proves the LSN50_WRITER_DISABLE UCI kill-switch default (Train A, 2026-07-15
# plan Task 3) is absent-only: a rerun of the provisioning block must never
# reset an operator-enabled override, and a fresh/absent key gets exactly one
# default assignment to '0'. Extended by the later boundary-hardening plan
# for retention settings.

set -eu

REPO_ROOT="$(pwd)"
DEFAULTS_FILE="$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config"

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

assert_eq() {
    expected="$1"
    actual="$2"
    label="$3"
    [ "$actual" = "$expected" ] || fail "$label: expected '$expected', got '$actual'"
}

[ -f "$DEFAULTS_FILE" ] || fail "96_osi_server_config is absent at $DEFAULTS_FILE"

TEST_ROOT="$(mktemp -d)"
cleanup() {
    rm -rf "$TEST_ROOT"
}
trap cleanup 0 1 2 15

awk '
    /^# lsn50-writer-disable-default begin$/ { capture=1; next }
    /^# lsn50-writer-disable-default end$/ { exit }
    capture { print }
' "$DEFAULTS_FILE" > "$TEST_ROOT/lsn50-defaults-block.sh"
[ -s "$TEST_ROOT/lsn50-defaults-block.sh" ] || fail "lsn50-writer-disable-default block is missing or empty in 96_osi_server_config"

UCI_STATE="$TEST_ROOT/uci-state"
SET_CALL_LOG="$TEST_ROOT/uci-set-calls"
COMMIT_CALL_LOG="$TEST_ROOT/uci-commit-calls"
: > "$SET_CALL_LOG"
: > "$COMMIT_CALL_LOG"

# Minimal fake `uci` covering only the subcommands the extracted block uses:
# `uci -q get <key>` (exit-status probe), `uci set <key>=<value>`, and
# `uci commit <package>`. State persists in a flat "key=value" file so the
# same fake can be reused across the two scenarios below in the same process.
uci() {
    if [ "$1" = "-q" ]; then
        shift
        if [ "$1" = "get" ]; then
            key="$2"
            line=$(grep "^${key}=" "$UCI_STATE" 2>/dev/null | tail -n 1) || true
            [ -n "$line" ] || return 1
            printf '%s\n' "${line#*=}"
            return 0
        fi
        fail "fake uci: unsupported -q subcommand: $*"
    fi
    case "$1" in
        get)
            key="$2"
            line=$(grep "^${key}=" "$UCI_STATE" 2>/dev/null | tail -n 1) || true
            [ -n "$line" ] || return 1
            printf '%s\n' "${line#*=}"
            ;;
        set)
            kv="$2"
            key="${kv%%=*}"
            val="${kv#*=}"
            printf '%s=%s\n' "$key" "$val" >> "$SET_CALL_LOG"
            if [ -f "$UCI_STATE" ]; then
                grep -v "^${key}=" "$UCI_STATE" > "$UCI_STATE.tmp" 2>/dev/null || true
                mv "$UCI_STATE.tmp" "$UCI_STATE"
            fi
            printf '%s=%s\n' "$key" "$val" >> "$UCI_STATE"
            ;;
        commit)
            printf '%s\n' "$2" >> "$COMMIT_CALL_LOG"
            ;;
        *)
            fail "fake uci: unsupported subcommand: $*"
            ;;
    esac
}

get_state() {
    key="$1"
    line=$(grep "^${key}=" "$UCI_STATE" 2>/dev/null | tail -n 1) || true
    printf '%s' "${line#*=}"
}

set_count() {
    key="$1"
    grep -c "^${key}=" "$SET_CALL_LOG" 2>/dev/null || true
}

run_block() {
    # shellcheck disable=SC1090
    . "$TEST_ROOT/lsn50-defaults-block.sh"
}

# --- Scenario 1: an operator-enabled override must survive a rerun. ---
: > "$UCI_STATE"
: > "$SET_CALL_LOG"
: > "$COMMIT_CALL_LOG"
printf 'osi-server.cloud.lsn50_writer_disable=1\n' > "$UCI_STATE"

run_block
assert_eq '1' "$(get_state osi-server.cloud.lsn50_writer_disable)" \
    'first rerun of the defaults block must not reset an operator override'
assert_eq '0' "$(set_count osi-server.cloud.lsn50_writer_disable)" \
    'first rerun of the defaults block must not call uci set on an already-present key'

run_block
assert_eq '1' "$(get_state osi-server.cloud.lsn50_writer_disable)" \
    'second rerun of the defaults block must still not reset an operator override'
assert_eq '0' "$(set_count osi-server.cloud.lsn50_writer_disable)" \
    'second rerun of the defaults block must still not call uci set on an already-present key'

echo "OK operator override (lsn50_writer_disable=1) survives repeated reruns of the defaults block"

# --- Scenario 2: an absent key gets exactly one default assignment to '0'. ---
: > "$UCI_STATE"
: > "$SET_CALL_LOG"
: > "$COMMIT_CALL_LOG"

run_block
assert_eq '0' "$(get_state osi-server.cloud.lsn50_writer_disable)" \
    'an absent key must default to 0 after the defaults block runs'
assert_eq '1' "$(set_count osi-server.cloud.lsn50_writer_disable)" \
    'an absent key must receive exactly one default uci set call'

run_block
assert_eq '0' "$(get_state osi-server.cloud.lsn50_writer_disable)" \
    'a rerun after the default was applied must not change the value'
assert_eq '1' "$(set_count osi-server.cloud.lsn50_writer_disable)" \
    'a rerun after the default was applied must not call uci set again'

echo "OK absent key defaults to 0 with exactly one uci set call, idempotent on rerun"

echo "PASS: osi-server LSN50_WRITER_DISABLE UCI default is absent-only and idempotent"
