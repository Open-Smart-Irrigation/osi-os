#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=tools/raspi5/fetch-source.sh
source "$here/fetch-source.sh"
build_dir=${1:?usage: build-probe.sh NEW_BUILD_DIRECTORY}
mkdir "$build_dir"
cd "$build_dir"
fetch_tree https://codeload.github.com/brocaar/sx1302_hal/tar.gz/587f4c28ecab91a96e65ac3b2686101a2b768727 \
    f5c9c61e844ddd1b31456a631100b867b5577a6dc39a9a07371c96a3fd30a48a hal
prefix=${CROSS_COMPILE:-aarch64-linux-gnu-}
make -C hal/libtools CROSS_COMPILE="$prefix"
make -C hal/libloragw CROSS_COMPILE="$prefix" libloragw.a
"${prefix}gcc" -static -Os -s -Ihal/libloragw/inc "$here/probe-wm1302.c" \
    hal/libloragw/libloragw.a -Lhal/libtools -ltinymt32 -lm -o probe-wm1302
