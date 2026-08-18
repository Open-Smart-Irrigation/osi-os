#!/bin/sh
set -eu

ID=/usr/bin/id
STAT=/usr/bin/stat
READLINK=/usr/bin/readlink
DIRNAME=/usr/bin/dirname
SHA256SUM=/usr/bin/sha256sum
NODE=/usr/bin/node

[ "${1:-}" = snapshot ] || {
    printf '%s\n' 'backup-pre-deploy: expected exact snapshot verb and flags; legacy positional mode is removed' >&2
    exit 2
}

EXPECTED_HELPER_SHA256='b5e699b2d966c9baf159abf723411e092b32fef21fa6307eafac105a5f7f14f7'
HELPER='/usr/libexec/osi-pre-deploy-database-helper.js'
if [ -n "${OSI_PREDEPLOY_WRAPPER_TEST_ROOT:-}" ]; then
    BOUNDARY="/tmp/osi-predeploy-tests-$($ID -u)"
    TEST_ROOT="$OSI_PREDEPLOY_WRAPPER_TEST_ROOT"
    [ "${OSI_REPAIR_PROGRAM_MODE:-}" = 1 ] && [ "${OSI_DEPLOY_ARTIFACT_MODE:-}" = test ] || {
        printf '%s\n' 'backup-pre-deploy: helper test root requires repair/test artifact mode' >&2
        exit 2
    }
    case "$TEST_ROOT" in
        */../*|*/..) printf '%s\n' 'backup-pre-deploy: helper test root contains dot-dot traversal' >&2; exit 2 ;;
    esac
    case "$TEST_ROOT" in
        "$BOUNDARY"/*) ;;
        *) printf '%s\n' 'backup-pre-deploy: helper test root is outside the fixed boundary' >&2; exit 2 ;;
    esac
    CANONICAL_TEST_ROOT=$($READLINK -f "$TEST_ROOT") || {
        printf '%s\n' 'backup-pre-deploy: helper test root cannot be canonicalized' >&2
        exit 2
    }
    [ "$CANONICAL_TEST_ROOT" = "$TEST_ROOT" ] || {
        printf '%s\n' 'backup-pre-deploy: helper test root has a symlink or alias ancestor' >&2
        exit 2
    }
    CURRENT_UID=$($ID -u)
    directory="$TEST_ROOT"
    while :; do
        [ -d "$directory" ] && [ ! -L "$directory" ] \
            && [ "$($STAT -c '%u' "$directory")" = "$CURRENT_UID" ] \
            && [ "$($STAT -c '%a' "$directory")" = 700 ] || {
            printf '%s\n' 'backup-pre-deploy: unsafe helper test-root directory' >&2
            exit 2
        }
        [ "$directory" = "$BOUNDARY" ] && break
        directory=$($DIRNAME "$directory")
        case "$directory" in
            "$BOUNDARY"|"$BOUNDARY"/*) ;;
            *) printf '%s\n' 'backup-pre-deploy: helper test-root ancestor escaped the boundary' >&2; exit 2 ;;
        esac
    done
    for directory in "$TEST_ROOT/usr" "$TEST_ROOT/usr/libexec"; do
        [ -d "$directory" ] && [ ! -L "$directory" ] \
            && [ "$($STAT -c '%u' "$directory")" = "$CURRENT_UID" ] \
            && [ "$($STAT -c '%a' "$directory")" = 700 ] || {
            printf '%s\n' 'backup-pre-deploy: unsafe helper test-root directory' >&2
            exit 2
        }
    done
    HELPER="$TEST_ROOT/usr/libexec/osi-pre-deploy-database-helper.js"
fi
[ -f "$HELPER" ] && [ ! -L "$HELPER" ] \
    && [ "$($STAT -c '%u' "$HELPER")" = "$($ID -u)" ] \
    && [ "$($STAT -c '%a' "$HELPER")" = 755 ] || {
    printf '%s\n' 'backup-pre-deploy: exact shipped helper is missing or unsafe' >&2
    exit 2
}
ACTUAL_HELPER_SHA256=$($SHA256SUM "$HELPER")
ACTUAL_HELPER_SHA256=${ACTUAL_HELPER_SHA256%% *}
[ "$ACTUAL_HELPER_SHA256" = "$EXPECTED_HELPER_SHA256" ] || {
    printf '%s\n' 'backup-pre-deploy: exact shipped helper hash mismatch' >&2
    exit 2
}
exec "$NODE" "$HELPER" "$@"
