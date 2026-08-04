#!/bin/sh
set -eu

action="${1:-}"
all="${2:-}"
test "$all" = "-a"

if [ -n "${TOPDIR:-}" ]; then
  cd "$TOPDIR"
else
  cd "$(dirname "$0")/.."
fi

case "$action" in
  update)
    for feed in packages luci routing; do
      test -d "feeds/$feed/.git"
      git -C "feeds/$feed" submodule update --init --recursive --no-fetch
      git -C "feeds/$feed" submodule status --recursive
    done
    test -f feeds/packages/lang/rust/Makefile
    chirpstack_location="$(
      awk '
        $1 == "src-link" && $2 == "chirpstack" {
          if (NF != 3 || found) exit 64
          found = 1
          location = $3
        }
        END {
          if (found != 1) exit 64
          print location
        }
      ' feeds.conf.default
    )"
    test -n "$chirpstack_location"
    if [ -e .config ]; then
      printf 'CONFIG_REFRESH_CONFIG_MUTATED=y\n' >> .config
    fi
    ln -s "$chirpstack_location" feeds/chirpstack
    printf 'feeds:update\n' >> "$OSI_FIXTURE_LOG"
    ;;
  install)
    test -L feeds/chirpstack
    mkdir -p package/feeds/chirpstack
    for package in node-red node-red-contrib-chirpstack node-red-node-sqlite; do
      ln -s "../../../feeds/chirpstack/apps/$package" "package/feeds/chirpstack/$package"
    done
    ln -s ../../../feeds/chirpstack/chirpstack/chirpstack package/feeds/chirpstack/chirpstack
    printf 'feeds:install\n' >> "$OSI_FIXTURE_LOG"
    ;;
  *)
    exit 64
    ;;
esac
