#!/usr/bin/env bash
# Fetch the upstream fixture and its firmware terms to a new external directory.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=tools/raspi5/fetch-source.sh
source "$here/fetch-source.sh"

if [[ $# != 1 ]]; then
    echo 'usage: fetch-eeprom.sh NEW_DIRECTORY_OUTSIDE_GIT' >&2
    exit 2
fi
parent=$(cd "$(dirname "$1")" && pwd -P)
if git -C "$parent" rev-parse --git-dir >/dev/null 2>&1; then
    echo 'Choose an output directory outside Git.' >&2
    exit 2
fi
output="$parent/$(basename "$1")"
mkdir "$output"
trap 'rm -rf -- "$output"' EXIT
trap 'exit 1' HUP INT TERM

revision=439fc2e934737cb6b718b837ec0870ac85bf7409
upstream="https://raw.githubusercontent.com/raspberrypi/rpi-eeprom/$revision"
image=pieeprom-2026-05-26.bin
image_sha=fee8bee6a738a1a61004f0770f15534de7a48a2a199dc4c7af7ed73ab04f18dd
license_sha=594b7565fd3ccf8acd4711a2ec1b199181aafbc3426d0bacaa50ef40edbf7c4a
fetch_verified "$upstream/LICENSE" "$license_sha" "$output/LICENSE"
fetch_verified "$upstream/firmware-2712/default/$image" "$image_sha" "$output/$image"
printf '%s  %s\n' "$image_sha" "$image" "$license_sha" LICENSE > "$output/SHA256SUMS"
trap - EXIT HUP INT TERM
