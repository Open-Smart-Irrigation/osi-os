#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test "$(id -u)" -ge 0
"$SCRIPT_DIR/osi-image-publish" --version >/dev/null
"$SCRIPT_DIR/osi-image-publish" --self-test >/dev/null
