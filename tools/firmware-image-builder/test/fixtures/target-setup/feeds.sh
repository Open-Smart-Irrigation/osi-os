#!/bin/sh
set -eu

action="${1:-}"
all="${2:-}"
test "$all" = "-a"

case "$action" in
  update)
    for feed in packages luci routing; do
      test -d "openwrt/feeds/$feed/.git"
      git -C "openwrt/feeds/$feed" submodule update --init --recursive --no-fetch
      git -C "openwrt/feeds/$feed" submodule status --recursive
    done
    test -f openwrt/feeds/packages/lang/rust/Makefile
    ln -s ../../feeds/chirpstack-openwrt-feed openwrt/feeds/chirpstack
    printf 'feeds:update\n' >> "$OSI_FIXTURE_LOG"
    ;;
  install)
    test -L openwrt/feeds/chirpstack
    mkdir -p openwrt/package/feeds/chirpstack
    for package in node-red node-red-contrib-chirpstack node-red-node-sqlite; do
      ln -s "../../../feeds/chirpstack/apps/$package" "openwrt/package/feeds/chirpstack/$package"
    done
    ln -s ../../../feeds/chirpstack/chirpstack/chirpstack openwrt/package/feeds/chirpstack/chirpstack
    printf 'feeds:install\n' >> "$OSI_FIXTURE_LOG"
    ;;
  *)
    exit 64
    ;;
esac
