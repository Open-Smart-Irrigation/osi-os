#!/usr/bin/env bash
# Package existing GUI build bytes with fixed metadata. GNU tar is required.
set -euo pipefail
export LC_ALL=C
unset TAR_OPTIONS GZIP
if [ "$#" -ne 2 ]; then
  echo "Usage: package-deploy-gui.sh <build-directory> <output.tar.gz>" >&2
  exit 2
fi
case "${SOURCE_DATE_EPOCH:-0}" in ''|*[!0-9]*) echo 'ERROR: invalid SOURCE_DATE_EPOCH' >&2; exit 2 ;; esac
stage=$(mktemp -d "${TMPDIR:-/tmp}/deploy-gui.XXXXXX")
trap 'rm -rf "$stage"' EXIT INT TERM
cp -R "$1/." "$stage/"
if [ -n "$(find "$stage" ! -type d ! -type f -print -quit)" ]; then
  echo 'ERROR: GUI input contains a link or special file' >&2
  exit 1
fi
find "$stage" -type d -exec chmod 755 {} +
find "$stage" -type f -exec chmod 644 {} +
tar --sort=name --format=gnu --mtime="@${SOURCE_DATE_EPOCH:-0}" \
  --owner=0 --group=0 --numeric-owner --mode='a=rX,u+w,a-s' \
  -cf - -C "$stage" . | gzip -n > "$2"
