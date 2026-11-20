#!/usr/bin/env bash
# Sourced by the emulator build scripts. Verify archives before extraction.
set -euo pipefail

fetch_verified() {
    local url=$1 digest=$2 destination=$3
    curl --fail --location --silent --show-error --retry 2 --proto '=https' \
        --proto-redir '=https' --output "$destination.part" "$url"
    printf '%s  %s\n' "$digest" "$destination.part" | sha256sum --check -
    mv "$destination.part" "$destination"
}

fetch_tree() {
    local url=$1 digest=$2 directory=$3
    fetch_verified "$url" "$digest" "$directory.tar"
    mkdir "$directory"
    tar --extract --file="$directory.tar" --directory="$directory" --strip-components=1
}
