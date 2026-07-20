#!/bin/sh
# Test for scripts/detect-rpi-profile.sh — closed hardware-profile detector.
#
# Run with: sh scripts/detect-rpi-profile.test.sh
# (also runs cleanly under `busybox ash scripts/detect-rpi-profile.test.sh`)

set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DETECTOR="$REPO_ROOT/scripts/detect-rpi-profile.sh"

[ -f "$DETECTOR" ] || {
    printf 'FAIL: detector script missing: %s\n' "$DETECTOR" >&2
    exit 1
}

BOUNDARY="/tmp/osi-rpi-profile-tests-$(id -u)"
mkdir -p "$BOUNDARY"; chmod 700 "$BOUNDARY"
TEST_ROOT="$(mktemp -d "$BOUNDARY/case-XXXXXX")"
cleanup() {
    rm -rf "$TEST_ROOT"
}
trap cleanup 0 1 2 15

FAILURES=0

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    FAILURES=$((FAILURES + 1))
}

pass() {
    printf 'ok - %s\n' "$1"
}

# Writes $1 (model text, NUL-terminated) to $TEST_ROOT/model
write_model() {
    printf '%s' "$1" | tr -d '\n' > "$TEST_ROOT/model"
    printf '\0' >> "$TEST_ROOT/model"
}

# Writes NUL-separated compatible entries (args) to $TEST_ROOT/compatible
write_compatible() {
    : > "$TEST_ROOT/compatible"
    for entry in "$@"; do
        printf '%s\0' "$entry" >> "$TEST_ROOT/compatible"
    done
}

run_detector() {
    run_detector_paths "$TEST_ROOT/model" "$TEST_ROOT/compatible"
}

run_detector_paths() {
    detector_model_path="$1"
    detector_compatible_path="$2"
    OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test DETECT_MODEL_PATH="$detector_model_path" \
    DETECT_COMPATIBLE_PATH="$detector_compatible_path" \
        "$DETECTOR"
}

assert_accept() {
    label="$1"
    expected_profile="$2"
    out=""
    status=0
    out="$(run_detector 2>"$TEST_ROOT/stderr")" || status=$?
    if [ "$status" -ne 0 ]; then
        fail "$label: expected exit 0, got $status (stderr: $(cat "$TEST_ROOT/stderr"))"
        return
    fi
    if [ "$out" != "$expected_profile" ]; then
        fail "$label: expected stdout '$expected_profile', got '$out'"
        return
    fi
    pass "$label -> $expected_profile"
}

assert_reject() {
    label="$1"
    out=""
    status=0
    out="$(run_detector 2>"$TEST_ROOT/stderr")" || status=$?
    if [ "$status" -eq 0 ]; then
        fail "$label: expected nonzero exit, got 0 (stdout: '$out')"
        return
    fi
    if [ -n "$out" ]; then
        fail "$label: expected no stdout profile on rejection, got '$out'"
        return
    fi
    stderr_lines="$(wc -l < "$TEST_ROOT/stderr" | tr -d ' ')"
    if [ "$stderr_lines" -ne 1 ]; then
        fail "$label: expected exactly 1 bounded stderr line, got $stderr_lines: $(cat "$TEST_ROOT/stderr")"
        return
    fi
    pass "$label -> rejected (exit $status)"
}

assert_reject_paths() {
    label="$1"
    model_path="$2"
    compatible_path="$3"
    out=""
    status=0
    out="$(run_detector_paths "$model_path" "$compatible_path" 2>"$TEST_ROOT/stderr")" || status=$?
    if [ "$status" -eq 0 ]; then
        fail "$label: expected nonzero exit, got 0 (stdout: '$out')"
        return
    fi
    if [ -n "$out" ]; then
        fail "$label: expected no stdout profile on rejection, got '$out'"
        return
    fi
    stderr_lines="$(wc -l < "$TEST_ROOT/stderr" | tr -d ' ')"
    if [ "$stderr_lines" -ne 1 ]; then
        fail "$label: expected exactly 1 bounded stderr line, got $stderr_lines: $(cat "$TEST_ROOT/stderr")"
        return
    fi
    pass "$label -> rejected (exit $status)"
}

# --- Accept cases: mutually consistent evidence ---

write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712"
assert_accept "Pi 5" "bcm2712"

write_model "Raspberry Pi 4 Model B Rev 1.4"
write_compatible "raspberrypi,4-model-b" "brcm,bcm2711"
assert_accept "Pi 4" "bcm2709"

write_model "Raspberry Pi 400 Rev 1.0"
write_compatible "raspberrypi,400" "brcm,bcm2711"
assert_accept "Pi 400" "bcm2709"

write_model "Raspberry Pi 3 Model B Rev 1.2"
write_compatible "raspberrypi,3-model-b" "brcm,bcm2837"
assert_accept "Pi 3" "bcm2709"

write_model "Raspberry Pi 2 Model B Rev 1.1"
write_compatible "raspberrypi,2-model-b" "brcm,bcm2836"
assert_accept "Pi 2" "bcm2709"

# Real device-tree format: compatible has more than two NUL-separated entries.
write_model "Raspberry Pi 3 Model B Plus Rev 1.0"
write_compatible "raspberrypi,3-model-b-plus" "raspberrypi,3-model-b" "brcm,bcm2837"
assert_accept "Pi 3 B+ (multi-entry compatible)" "bcm2709"

SHADOW_DIR="$TEST_ROOT/path-shadow"; SHADOW_SENTINEL="$TEST_ROOT/path-shadow-ran"
mkdir "$SHADOW_DIR"; chmod 700 "$SHADOW_DIR"
for tool in id stat readlink dirname od tr cut; do
    printf '%s\n' '#!/bin/sh' "printf '%s\\n' '$tool' >>'$SHADOW_SENTINEL'" \
        "exec /usr/bin/$tool \"\$@\"" >"$SHADOW_DIR/$tool"
    chmod 755 "$SHADOW_DIR/$tool"
done
write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712"
shadow_status=0
shadow_out="$(PATH="$SHADOW_DIR:$PATH" run_detector 2>"$TEST_ROOT/path-shadow.err")" || shadow_status=$?
if [ "$shadow_status" -ne 0 ] || [ "$shadow_out" != bcm2712 ] || [ -e "$SHADOW_SENTINEL" ]; then
    fail "detector executed a caller PATH shadow"
else
    pass "detector ignores caller PATH shadows"
fi

# --- Reject cases ---

write_model "Raspberry Pi Zero 2 W Rev 1.0"
write_compatible "raspberrypi,model-zero-2-w" "brcm,bcm2837"
assert_reject "Pi Zero 2 W (Zero family always rejected)"

write_model "Raspberry Pi Zero W Rev 1.1"
write_compatible "raspberrypi,model-zero-w" "brcm,bcm2835"
assert_reject "Pi Zero W / bcm2708 family"

write_model "Acme Widget Board Rev 3.1"
write_compatible "acme,widget" "acme,soc9"
assert_reject "unknown board"

# Conflicting pair: Pi 5 model text, but compatible facts consistent with the
# bcm2709 (Pi 4) family instead of bcm2712.
write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "raspberrypi,4-model-b" "brcm,bcm2711"
assert_reject "conflicting pair (Pi 5 model + bcm2709-family compatible)"

rm -f "$TEST_ROOT/model"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712"
assert_reject "missing model file"

write_model "Raspberry Pi 5 Model B Rev 1.0"
rm -f "$TEST_ROOT/compatible"
assert_reject "missing compatible file"

# NUL-separated multi-entry compatible with an internal conflict (two
# different recognized SoC families named in the same compatible list).
write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712" "brcm,bcm2711"
assert_reject "ambiguous multi-entry compatible (internal conflict)"

# SoC-only compatible: a matching brcm,bcm* entry alone is NOT sufficient
# evidence -- real Pi device trees always emit the raspberrypi,* board entry
# too, so its absence is inconsistent evidence and must reject.
write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "brcm,bcm2712"
assert_reject "SoC-only compatible (no raspberrypi,* board entry)"

write_model "Raspberry Pi 4 Model B Rev 1.4"
write_compatible "brcm,bcm2711"
assert_reject "SoC-only compatible (Pi 4 class)"

# Board-only compatible: a raspberrypi,* entry without the matching brcm,bcm*
# SoC entry is equally incomplete and must reject.
write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "raspberrypi,5-model-b"
assert_reject "board-only compatible (no brcm,bcm* SoC entry)"

# Board entry conflicting with the model class rejects even when the SoC
# entry agrees with the model.
write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "raspberrypi,4-model-b" "brcm,bcm2712"
assert_reject "board entry conflicts with model (SoC agrees)"

# Board entry conflicting with the SoC entry rejects even when the board
# entry agrees with the model.
write_model "Raspberry Pi 4 Model B Rev 1.4"
write_compatible "raspberrypi,4-model-b" "brcm,bcm2712"
assert_reject "SoC entry conflicts with board+model class"

# Raw device-tree properties are closed binary records, not merely text with
# NUL bytes removed. Model must contain one nonempty string and one trailing
# NUL; compatible must contain nonempty entries separated and terminated by
# exactly one NUL at each boundary.
printf '%s' 'Raspberry Pi 5 Model B Rev 1.0' > "$TEST_ROOT/model"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712"
assert_reject "model property missing NUL terminator"

printf 'Raspberry Pi 5 Model B Rev 1.0\0Raspberry Pi 4 Model B Rev 1.4\0' > "$TEST_ROOT/model"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712"
assert_reject "model property contains concatenated strings"

write_model "Raspberry Pi 5 Model B Rev 1.0"
printf 'raspberrypi,5-model-b\0brcm,bcm2712' > "$TEST_ROOT/compatible"
assert_reject "compatible property missing final NUL terminator"

write_model "Raspberry Pi 5 Model B Rev 1.0"
printf '\0raspberrypi,5-model-b\0brcm,bcm2712\0' > "$TEST_ROOT/compatible"
assert_reject "compatible property has leading empty entry"

write_model "Raspberry Pi 5 Model B Rev 1.0"
printf 'raspberrypi,5-model-b\0\0brcm,bcm2712\0' > "$TEST_ROOT/compatible"
assert_reject "compatible property has interior empty entry"

write_model "Raspberry Pi 5 Model B Rev 1.0"
printf '\0' > "$TEST_ROOT/compatible"
assert_reject "compatible property contains only an empty entry"

printf 'Raspberry Pi 5\nModel B Rev 1.0\0' > "$TEST_ROOT/model"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712"
assert_reject "model property contains embedded newline"

write_model "Raspberry Pi 5 Model B Rev 1.0"
printf 'raspberrypi,5-model-b\nforeign-entry\0brcm,bcm2712\0' > "$TEST_ROOT/compatible"
assert_reject "compatible entry contains embedded newline"

write_model "Raspberry Pi 5 Model B Rev 1.0"
printf 'raspberrypi,5-model-b\001\0brcm,bcm2712\0' > "$TEST_ROOT/compatible"
assert_reject "compatible entry contains an embedded control byte"

# Test-only path adapters are a security boundary: lexical containment is not
# enough. Dot-dot traversal, final symlinks, symlink ancestors, and writable
# fixture ancestors must all reject before either device-tree file is read.
write_model "Raspberry Pi 5 Model B Rev 1.0"
write_compatible "raspberrypi,5-model-b" "brcm,bcm2712"
assert_reject_paths "adapter path containing dot-dot" \
    "$TEST_ROOT/../$(basename "$TEST_ROOT")/model" "$TEST_ROOT/compatible"

ln -s "$TEST_ROOT/model" "$TEST_ROOT/model-link"
assert_reject_paths "adapter final symlink" "$TEST_ROOT/model-link" "$TEST_ROOT/compatible"

mkdir "$TEST_ROOT/real-parent"
cp "$TEST_ROOT/model" "$TEST_ROOT/real-parent/model"
cp "$TEST_ROOT/compatible" "$TEST_ROOT/real-parent/compatible"
ln -s "$TEST_ROOT/real-parent" "$TEST_ROOT/linked-parent"
assert_reject_paths "adapter symlink ancestor" \
    "$TEST_ROOT/linked-parent/model" "$TEST_ROOT/linked-parent/compatible"

mkdir "$TEST_ROOT/unsafe-parent"
cp "$TEST_ROOT/model" "$TEST_ROOT/unsafe-parent/model"
cp "$TEST_ROOT/compatible" "$TEST_ROOT/unsafe-parent/compatible"
chmod 0777 "$TEST_ROOT/unsafe-parent"
assert_reject_paths "adapter writable ancestor" \
    "$TEST_ROOT/unsafe-parent/model" "$TEST_ROOT/unsafe-parent/compatible"

echo "----"
if [ "$FAILURES" -eq 0 ]; then
    echo "ALL PASS"
    exit 0
else
    echo "$FAILURES FAILURE(S)"
    exit 1
fi
