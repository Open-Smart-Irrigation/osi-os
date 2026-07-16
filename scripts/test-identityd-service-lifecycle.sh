#!/bin/sh

set -eu

REPO_ROOT="$(pwd)"
DEPLOY="$REPO_ROOT/deploy.sh"
DAEMON="$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh"
TEST_ROOT="$(mktemp -d)"
RUN_DIR="$TEST_ROOT/run"
STATE_LOG="$TEST_ROOT/state.log"
HELPER="$TEST_ROOT/identity-helper.sh"

cleanup_test() {
    rm -rf "$TEST_ROOT"
}
trap cleanup_test 0 1 2 15

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

awk '
    /^# identityd deploy lifecycle begin$/ { capture=1; next }
    /^# identityd deploy lifecycle end$/ { exit }
    capture { print }
' "$DEPLOY" > "$TEST_ROOT/lifecycle.sh"
[ -s "$TEST_ROOT/lifecycle.sh" ] || fail "deploy lifecycle block is missing"

: > "$HELPER"
chmod 755 "$HELPER"

cleanup() {
    printf '%s\n' cleanup >> "$STATE_LOG"
}

restart_node_red() {
    if [ "${node_red_restart_needed:-0}" != 1 ]; then
        return 0
    fi
    printf '%s\n' node-red-start >> "$STATE_LOG"
    if [ "${NODE_RED_START_OK:-1}" != 1 ]; then
        return 1
    fi
    node_red_restart_needed=0
}

. "$TEST_ROOT/lifecycle.sh"

IDENTITYD_LOCK_PATH="$RUN_DIR/osi-identityd.lock"

identityd_sleep() {
    :
}

identityd_service() {
    action="$1"
    case "$action" in
        running)
            [ "$SERVICE_RUNNING" = 1 ]
            ;;
        stop)
            printf '%s\n' identityd-stop >> "$STATE_LOG"
            SERVICE_RUNNING=0
            SERVICE_READY=0
            if [ "$STOP_RELEASES_LOCK" = 1 ]; then
                rm -rf "$IDENTITYD_LOCK_PATH"
            fi
            ;;
        start)
            printf '%s\n' identityd-start >> "$STATE_LOG"
            if [ "$STARTS_RUNNING" = 1 ]; then
                SERVICE_RUNNING=1
            fi
            if [ "$START_BECOMES_READY" = 1 ]; then
                SERVICE_READY=1
                rm -rf "$IDENTITYD_LOCK_PATH"
                ln -s "$$" "$IDENTITYD_LOCK_PATH"
            fi
            ;;
        ready)
            [ "$SERVICE_RUNNING" = 1 ] || return 1
            [ "$SERVICE_READY" = 1 ] || return 1
            OSI_IDENTITY_RUN_DIR="$RUN_DIR" \
                OSI_IDENTITY_HELPER="$HELPER" \
                "$DAEMON" ready >/dev/null 2>&1
            ;;
        enable)
            return 0
            ;;
        *)
            fail "unexpected identityd service action: $action"
            ;;
    esac
}

reset_fixture() {
    prior_running="$1"
    rm -rf "$RUN_DIR"
    mkdir -p "$RUN_DIR/osi-node-red-restart-requests"
    printf '%s\n' queued > "$RUN_DIR/osi-node-red-restart-requests/request.json"
    printf '%s\n' sentinel > "$RUN_DIR/osi-identity-restart.json"
    : > "$STATE_LOG"
    SERVICE_RUNNING="$prior_running"
    SERVICE_READY="$prior_running"
    STOP_RELEASES_LOCK=1
    STARTS_RUNNING=1
    START_BECOMES_READY=1
    NODE_RED_START_OK=1
    node_red_restart_needed=0
    identityd_deploy_state="untouched"
    if [ "$prior_running" = 1 ]; then
        ln -s "$$" "$IDENTITYD_LOCK_PATH"
    fi
}

assert_tmpfs_state_preserved() {
    [ -f "$RUN_DIR/osi-node-red-restart-requests/request.json" ] || fail "queued restart request was removed"
    [ -f "$RUN_DIR/osi-identity-restart.json" ] || fail "restart sentinel was removed"
}

reset_fixture 1
quiesce_identityd_for_deploy || fail "prior-running quiescence failed"
assert_eq restore_running "$identityd_deploy_state" "prior-running restore mode"
assert_eq 0 "$SERVICE_RUNNING" "prior-running service stopped"
[ ! -e "$IDENTITYD_LOCK_PATH" ] && [ ! -L "$IDENTITYD_LOCK_PATH" ] || fail "prior-running lock remained"
assert_tmpfs_state_preserved
restore_identityd_prior_state || fail "prior-running restoration failed"
assert_eq 1 "$SERVICE_RUNNING" "prior-running service restored"
assert_eq disarmed "$identityd_deploy_state" "prior-running restore disarmed"
identityd_service ready || fail "prior-running restore is not ready"

reset_fixture 0
quiesce_identityd_for_deploy || fail "prior-stopped quiescence failed"
assert_eq restore_stopped "$identityd_deploy_state" "prior-stopped restore mode"
identityd_service start
identityd_service ready || fail "partial activation fixture did not become ready"
restore_identityd_prior_state || fail "prior-stopped restoration failed"
assert_eq 0 "$SERVICE_RUNNING" "prior-stopped service was left running"
[ ! -e "$IDENTITYD_LOCK_PATH" ] && [ ! -L "$IDENTITYD_LOCK_PATH" ] || fail "prior-stopped lock remained"
assert_tmpfs_state_preserved

reset_fixture 1
quiesce_identityd_for_deploy || fail "fatal-hold quiescence failed"
identityd_deploy_state="fatal_hold"
restore_identityd_prior_state || fail "fatal hold returned failure"
assert_eq 0 "$SERVICE_RUNNING" "fatal hold restarted identityd"
[ ! -e "$IDENTITYD_LOCK_PATH" ] && [ ! -L "$IDENTITYD_LOCK_PATH" ] || fail "fatal hold recreated lock"

reset_fixture 0
mkdir "$IDENTITYD_LOCK_PATH"
printf '%s\n' "$$" > "$IDENTITYD_LOCK_PATH/pid"
if identityd_service ready; then
    fail "ready accepted a legacy directory lock"
fi

reset_fixture 1
STOP_RELEASES_LOCK=0
if quiesce_identityd_for_deploy; then
    fail "quiescence accepted a retained lock"
fi
assert_eq restore_running "$identityd_deploy_state" "failed-quiescence restore mode"
assert_tmpfs_state_preserved

reset_fixture 1
quiesce_identityd_for_deploy || fail "trap-order quiescence failed"
node_red_restart_needed=1
if (deploy_exit_handler 23); then
    fail "exit handler discarded the original nonzero status"
else
    handler_status=$?
fi
assert_eq 23 "$handler_status" "exit handler status preservation"
node_red_line="$(grep -n '^node-red-start$' "$STATE_LOG" | tail -1 | cut -d: -f1)"
identityd_line="$(grep -n '^identityd-start$' "$STATE_LOG" | tail -1 | cut -d: -f1)"
[ "$node_red_line" -lt "$identityd_line" ] || fail "identityd restored before Node-RED"

reset_fixture 1
quiesce_identityd_for_deploy || fail "restore-failure quiescence failed"
START_BECOMES_READY=0
stops_before="$(grep -c '^identityd-stop$' "$STATE_LOG" || true)"
if (deploy_exit_handler 0); then
    fail "exit handler hid an identityd restoration failure"
else
    handler_status=$?
fi
assert_eq 1 "$handler_status" "restoration failure status"
stops_after="$(grep -c '^identityd-stop$' "$STATE_LOG" || true)"
assert_eq "$((stops_before + 1))" "$stops_after" "failed restoration stopped running-but-unready identityd"
[ ! -e "$IDENTITYD_LOCK_PATH" ] && [ ! -L "$IDENTITYD_LOCK_PATH" ] || fail "failed restoration left an identityd lock"

printf '%s\n' "PASS: identityd deploy lifecycle and readiness"
