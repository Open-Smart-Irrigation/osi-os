#!/bin/sh
# detect-rpi-profile.sh — closed-authority Raspberry Pi hardware profile
# detector.
#
# Reads /proc/device-tree/model (a single NUL-terminated string) and
# /proc/device-tree/compatible (a NUL-separated list of strings, the real
# device-tree wire format) and, on stdout, prints exactly one of:
#
#   bcm2712   Raspberry Pi 5
#   bcm2709   Raspberry Pi 2 / 3 / 4 / 400
#
# with exit status 0 — but ONLY when the model text and the compatible list
# independently agree on the same profile. There is no default/fallback
# profile: any missing input file, any unrecognized hardware (including the
# Pi Zero / bcm2708 family, which is not a supported profile), or any
# model-vs-compatible conflict causes a nonzero exit, one bounded line on
# stderr, and nothing on stdout.
#
# POSIX sh only (BusyBox ash compatible): no arrays, no [[ ]], no process
# substitution.
#
# Paths are injectable for testing:
#   DETECT_MODEL_PATH        default /proc/device-tree/model
#   DETECT_COMPATIBLE_PATH   default /proc/device-tree/compatible

set -eu

ID=/usr/bin/id
STAT=/usr/bin/stat
READLINK=/usr/bin/readlink
DIRNAME=/usr/bin/dirname
OD=/usr/bin/od
TR=/usr/bin/tr
CUT=/usr/bin/cut

MODEL_PATH="${DETECT_MODEL_PATH:-/proc/device-tree/model}"
COMPATIBLE_PATH="${DETECT_COMPATIBLE_PATH:-/proc/device-tree/compatible}"
if [ -n "${DETECT_MODEL_PATH:-}${DETECT_COMPATIBLE_PATH:-}" ]; then
    BOUNDARY="/tmp/osi-rpi-profile-tests-$($ID -u)"
    CURRENT_UID="$($ID -u)"
    adapter_fail() {
        printf 'detect-rpi-profile: %s\n' "$1" >&2
        exit 1
    }
    require_private_fixture_directory() {
        fixture_dir="$1"
        fixture_label="$2"
        [ ! -L "$fixture_dir" ] && [ -d "$fixture_dir" ] || adapter_fail "$fixture_label must be a real directory"
        [ "$($STAT -c '%u' "$fixture_dir")" = "$CURRENT_UID" ] || adapter_fail "$fixture_label owner mismatch"
        [ "$($STAT -c '%a' "$fixture_dir")" = 700 ] || adapter_fail "$fixture_label must be mode 0700"
    }
    validate_fixture_path() {
        fixture_path="$1"
        fixture_label="$2"
        case "$fixture_path" in
            */../*|*/..) adapter_fail "$fixture_label adapter contains dot-dot traversal" ;;
        esac
        case "$fixture_path" in
            "$BOUNDARY"/*) ;;
            *) adapter_fail "$fixture_label adapter is outside the fixed test boundary" ;;
        esac
        [ ! -L "$fixture_path" ] && [ -f "$fixture_path" ] || adapter_fail "$fixture_label adapter must be a regular nonsymlink file"
        canonical_path="$($READLINK -f "$fixture_path")" || adapter_fail "$fixture_label adapter cannot be canonicalized"
        case "$canonical_path" in
            "$BOUNDARY"/*) ;;
            *) adapter_fail "$fixture_label adapter canonical path escapes the fixed test boundary" ;;
        esac
        [ "$($STAT -c '%u' "$fixture_path")" = "$CURRENT_UID" ] || adapter_fail "$fixture_label adapter owner mismatch"
        fixture_parent="$($DIRNAME "$fixture_path")"
        while [ "$fixture_parent" != "$BOUNDARY" ]; do
            case "$fixture_parent" in
                "$BOUNDARY"/*) ;;
                *) adapter_fail "$fixture_label adapter ancestor escapes the fixed test boundary" ;;
            esac
            require_private_fixture_directory "$fixture_parent" "$fixture_label adapter ancestor"
            next_parent="$($DIRNAME "$fixture_parent")"
            [ "$next_parent" != "$fixture_parent" ] || adapter_fail "$fixture_label adapter ancestor walk did not reach the boundary"
            fixture_parent="$next_parent"
        done
        printf '%s\n' "$canonical_path"
    }
    [ "${OSI_REPAIR_PROGRAM_MODE:-}" = 1 ] && [ "${OSI_DEPLOY_ARTIFACT_MODE:-}" = test ] || {
        printf '%s\n' 'detect-rpi-profile: detector path adapters require repair/test artifact mode' >&2
        exit 1
    }
    require_private_fixture_directory "$BOUNDARY" 'detector test boundary'
    MODEL_PATH="$(validate_fixture_path "$MODEL_PATH" model)"
    COMPATIBLE_PATH="$(validate_fixture_path "$COMPATIBLE_PATH" compatible)"
fi

# Emits exactly one bounded stderr line and exits nonzero. Never called with
# untrusted content long/weird enough to risk more than one line: callers
# route free-form text through bound_text first.
fail() {
    printf 'detect-rpi-profile: %s\n' "$1" >&2
    exit 1
}

# Collapses newlines and truncates so a pathological input can never turn a
# rejection into more than the one allowed stderr line.
bound_text() {
    printf '%s' "$1" | "$TR" '\n\t' '  ' | "$CUT" -c1-160
}

[ -r "$MODEL_PATH" ] || fail "model file unreadable: $(bound_text "$MODEL_PATH")"
[ -r "$COMPATIBLE_PATH" ] || fail "compatible file unreadable: $(bound_text "$COMPATIBLE_PATH")"

validate_model_property() {
    payload_bytes=0
    terminated=0
    for octet in $("$OD" -An -v -t u1 "$MODEL_PATH"); do
        if [ "$terminated" -eq 1 ]; then
            fail "model property contains bytes after its NUL terminator"
        fi
        if [ "$octet" -eq 0 ]; then
            [ "$payload_bytes" -gt 0 ] || fail "model property contains an empty string"
            terminated=1
        else
            [ "$octet" -ge 32 ] && [ "$octet" -ne 127 ] || \
                fail "model property contains an embedded control byte"
            payload_bytes=$((payload_bytes + 1))
        fi
    done
    [ "$terminated" -eq 1 ] || fail "model property is missing its NUL terminator"
}

validate_compatible_property() {
    entry_bytes=0
    entry_count=0
    terminated=0
    for octet in $("$OD" -An -v -t u1 "$COMPATIBLE_PATH"); do
        if [ "$octet" -eq 0 ]; then
            [ "$entry_bytes" -gt 0 ] || fail "compatible property contains an empty entry"
            entry_count=$((entry_count + 1))
            entry_bytes=0
            terminated=1
        else
            [ "$octet" -ge 32 ] && [ "$octet" -ne 127 ] || \
                fail "compatible property contains an embedded control byte"
            entry_bytes=$((entry_bytes + 1))
            terminated=0
        fi
    done
    [ "$entry_count" -gt 0 ] || fail "compatible property has no entries"
    [ "$terminated" -eq 1 ] || fail "compatible property is missing its final NUL terminator"
}

validate_model_property
validate_compatible_property

# The device-tree model property is a single NUL-terminated string; strip all
# NULs (validated above as exactly one, trailing) rather than relying on shell
# command substitution to hold an embedded NUL byte, which POSIX shells do
# not guarantee.
MODEL="$("$TR" -d '\0' < "$MODEL_PATH")"
[ -n "$MODEL" ] || fail "model file is empty: $(bound_text "$MODEL_PATH")"

model_profile=""
case "$MODEL" in
    *"Raspberry Pi 5"*)
        model_profile="bcm2712"
        ;;
    *"Raspberry Pi Zero"*)
        fail "unsupported hardware (Pi Zero/bcm2708 family): $(bound_text "$MODEL")"
        ;;
    *"Raspberry Pi 4"*|*"Raspberry Pi 400"*|*"Raspberry Pi 3"*|*"Raspberry Pi 2"*)
        model_profile="bcm2709"
        ;;
    *)
        fail "unrecognized model: $(bound_text "$MODEL")"
        ;;
esac

# The compatible property is a NUL-separated list of strings (the real
# device-tree wire format, e.g. "raspberrypi,5-model-b\0brcm,bcm2712\0").
# Convert NULs to newlines *before* the shell captures the output — by that
# point tr has already removed every NUL byte, so the result is an ordinary
# newline-separated string that command substitution and `read` handle
# correctly. This is the NUL-safe pattern; parsing raw NUL bytes directly out
# of a shell variable is not portable (BusyBox ash and bash both silently
# drop them).
#
# Real Pi device trees always emit BOTH a raspberrypi,* board entry and a
# brcm,bcm* SoC entry. Each is classified independently; acceptance requires
# both authorities present, internally conflict-free, and in agreement with
# each other and with the model text. A SoC-only or board-only compatible
# list is incomplete evidence and rejects.
COMPATIBLE_LINES="$("$TR" '\0' '\n' < "$COMPATIBLE_PATH")"
[ -n "$COMPATIBLE_LINES" ] || fail "compatible file is empty: $(bound_text "$COMPATIBLE_PATH")"

board_profile=""
board_conflict=0
soc_profile=""
soc_conflict=0
while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in
        raspberrypi,model-zero*)
            entry_profile="unsupported"
            authority="board"
            ;;
        raspberrypi,5-*)
            entry_profile="bcm2712"
            authority="board"
            ;;
        raspberrypi,400|raspberrypi,4-*|raspberrypi,3-*|raspberrypi,2-*)
            entry_profile="bcm2709"
            authority="board"
            ;;
        brcm,bcm2712)
            entry_profile="bcm2712"
            authority="soc"
            ;;
        brcm,bcm2711|brcm,bcm2837|brcm,bcm2836|brcm,bcm2709)
            entry_profile="bcm2709"
            authority="soc"
            ;;
        brcm,bcm2835|brcm,bcm2708)
            entry_profile="unsupported"
            authority="soc"
            ;;
        *)
            continue
            ;;
    esac
    if [ "$authority" = "board" ]; then
        if [ -z "$board_profile" ]; then
            board_profile="$entry_profile"
        elif [ "$board_profile" != "$entry_profile" ]; then
            board_conflict=1
        fi
    else
        if [ -z "$soc_profile" ]; then
            soc_profile="$entry_profile"
        elif [ "$soc_profile" != "$entry_profile" ]; then
            soc_conflict=1
        fi
    fi
done <<EOF_COMPATIBLE_ENTRIES
$COMPATIBLE_LINES
EOF_COMPATIBLE_ENTRIES

[ "$board_conflict" -eq 0 ] || \
    fail "ambiguous compatible: multiple conflicting raspberrypi,* board entries"
[ "$soc_conflict" -eq 0 ] || \
    fail "ambiguous compatible: multiple conflicting hardware families named"
[ -n "$board_profile" ] || \
    fail "incomplete compatible: no recognized raspberrypi,* board entry"
[ -n "$soc_profile" ] || \
    fail "incomplete compatible: no recognized brcm,bcm* SoC entry"
[ "$board_profile" != "unsupported" ] && [ "$soc_profile" != "unsupported" ] || \
    fail "unsupported hardware (Pi Zero/bcm2708 family) per compatible"
[ "$board_profile" = "$soc_profile" ] || \
    fail "conflicting compatible: board entry implies $board_profile, SoC entry implies $soc_profile"

[ "$model_profile" = "$board_profile" ] || \
    fail "conflicting evidence: model implies $model_profile, compatible implies $board_profile"

printf '%s\n' "$model_profile"
