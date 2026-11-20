#!/usr/bin/env bash
# Builds a self-contained deploy payload tarball: every file deploy.sh could
# fetch from $BASE, plus deploy.sh itself, packed into one archive so an
# offline gateway (see deploy-offline.sh) never needs a live tunnel back to
# this workstation.
#
# Usage:
#   scripts/deploy-bundle.sh [path/to/react_gui.tar.gz]
#
# The GUI bundle is never built here (frontend builds OOM this workstation --
# see AGENTS.md); pass an already-built react_gui.tar.gz, or set
# REACT_GUI_TARBALL. deploy-bundle.sh fails fast and clearly if it is absent.
#
# Env overrides (mainly for scripts/deploy-bundle.test.sh):
#   REPO_ROOT           repo checkout to bundle (default: this script's repo)
#   REACT_GUI_TARBALL   path to a pre-built react_gui.tar.gz
#   OUT_DIR             where to write the bundle (default: $REPO_ROOT/dist)
#   BUNDLE_SHA          override the git-sha segment of the output filename
#   BUNDLE_TS           optional legacy filename suffix (never stored inside)
#   SOURCE_DATE_EPOCH   fixed archive mtime (default: 0)
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$script_dir/.." && pwd)}"
REACT_GUI_TARBALL="${REACT_GUI_TARBALL:-${1:-}}"
REACT_GUI_TARBALL="${REACT_GUI_TARBALL:-$REPO_ROOT/react_gui.tar.gz}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"

if [ ! -f "$REACT_GUI_TARBALL" ]; then
  echo "ERROR: react_gui.tar.gz not found at $REACT_GUI_TARBALL" >&2
  echo "This workstation does not build the GUI here (OOM risk -- see AGENTS.md)." >&2
  echo "Build it elsewhere (or on a machine with headroom) and pass its path:" >&2
  echo "  scripts/deploy-bundle.sh /path/to/react_gui.tar.gz" >&2
  echo "or set REACT_GUI_TARBALL=/path/to/react_gui.tar.gz" >&2
  exit 1
fi

BUNDLE_SHA="${BUNDLE_SHA:-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo nogit)}"
BUNDLE_TS="${BUNDLE_TS:-}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
export LC_ALL=C
unset TAR_OPTIONS GZIP
case "$BUNDLE_TS" in *[!a-zA-Z0-9_-]*) echo "ERROR: invalid BUNDLE_TS" >&2; exit 2 ;; esac
case "$SOURCE_DATE_EPOCH" in ''|*[!0-9]*) echo "ERROR: invalid SOURCE_DATE_EPOCH" >&2; exit 2 ;; esac

mkdir -p "$OUT_DIR"

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/deploy-bundle-stage.XXXXXX")"
cleanup() {
  rm -rf "$stage_dir"
}
trap cleanup EXIT INT TERM

echo "=== OSI OS offline deploy bundle ==="
echo "Repo:   $REPO_ROOT"
echo "GUI:    $REACT_GUI_TARBALL"

fetch_list_file="$stage_dir/.fetch-list.txt"
node "$REPO_ROOT/scripts/deploy-fetch-list.js" "$REPO_ROOT" --corpus-identities-out "$stage_dir/.corpus-identities.json" > "$fetch_list_file"

path_count=0
while IFS= read -r rel_path; do
  [ -n "$rel_path" ] || continue
  # react_gui.tar.gz is a build artifact, never checked into the repo; it is
  # staged separately below from REACT_GUI_TARBALL.
  [ "$rel_path" = "react_gui.tar.gz" ] && continue
  src="$REPO_ROOT/$rel_path"
  if [ ! -f "$src" ]; then
    echo "ERROR: deploy.sh would fetch '$rel_path' but it does not exist at $src" >&2
    exit 1
  fi
  dest="$stage_dir/$rel_path"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  path_count=$((path_count + 1))
done < "$fetch_list_file"

# deploy.sh itself: not part of computeFetchList's output (deploy.sh never
# fetches itself; the tunnel flow curls it BEFORE running it), but
# deploy-offline.sh needs it on disk to run locally.
cp "$REPO_ROOT/deploy.sh" "$stage_dir/deploy.sh"

# deploy-local-server.js: also not part of computeFetchList's output (it is
# offline-deploy tooling, not something deploy.sh itself fetches), but
# deploy-offline.sh execs it from inside the extracted bundle
# ($EXTRACT_DIR/scripts/deploy-local-server.js), so it must travel with the
# bundle too.
mkdir -p "$stage_dir/scripts"
cp "$REPO_ROOT/scripts/deploy-local-server.js" "$stage_dir/scripts/deploy-local-server.js"
cp "$REPO_ROOT/scripts/deploy-bundle-manifest.js" "$stage_dir/scripts/deploy-bundle-manifest.js"

# The built GUI bundle, served at the bundle root to match deploy.sh's
# `fetch "react_gui.tar.gz" ...` request.
cp "$REACT_GUI_TARBALL" "$stage_dir/react_gui.tar.gz"

node "$REPO_ROOT/scripts/deploy-fetch-list.js" "$stage_dir" --verify-corpus-identities "$stage_dir/.corpus-identities.json"
rm -f "$fetch_list_file" "$stage_dir/.corpus-identities.json"

find "$stage_dir" -type d -exec chmod 755 {} +
find "$stage_dir" -type f -exec chmod 644 {} +
node "$REPO_ROOT/scripts/deploy-bundle-manifest.js" create "$stage_dir" "$BUNDLE_SHA"

bundle_name="deploy-bundle-${BUNDLE_SHA}${BUNDLE_TS:+-$BUNDLE_TS}.tar.gz"
bundle_path="$OUT_DIR/$bundle_name"

# Normalize directories and files as well as archive metadata: the staging
# umask, source permissions, owner names and build directory never enter it.
# GNU format avoids PAX atime/ctime and extended-header host metadata.
# A temporary output prevents a failed build publishing a partial bundle.
bundle_tmp="$bundle_path.tmp-$$"
trap 'rm -f "$bundle_tmp"; cleanup' EXIT INT TERM
node "$REPO_ROOT/scripts/deploy-bundle-manifest.js" list "$stage_dir" | \
  tar -C "$stage_dir" --null --no-recursion --files-from=- --format=gnu --mtime="@$SOURCE_DATE_EPOCH" \
    --owner=0 --group=0 --numeric-owner --mode='a=rX,u+w,a-s' \
    -cf - | gzip -n > "$bundle_tmp"
mv "$bundle_tmp" "$bundle_path"

sha256sum "$bundle_path" > "$bundle_path.sha256"
# sha256sum writes the staged tarball's absolute path; rewrite to the bundle
# basename so the sidecar is portable across machines/paths.
sha_only="$(cut -d ' ' -f1 "$bundle_path.sha256")"
printf '%s  %s\n' "$sha_only" "$bundle_name" > "$bundle_path.sha256"

bundle_bytes="$(wc -c < "$bundle_path" | tr -d ' ')"

echo "OK: staged $path_count deploy.sh-fetchable files + deploy.sh + react_gui.tar.gz"
echo "Bundle:  $bundle_path ($bundle_bytes bytes)"
echo "SHA256:  $sha_only"
echo "Sidecar: $bundle_path.sha256"
