#!/bin/sh
# Builds the GUI at <baseline-ref> and at the working tree, then proves the
# bundles match modulo 8-char Vite hashes; CSS may differ only in the
# allowlisted --error token atoms (css-rule-diff.mjs).
set -eu

baseline_ref=${1:?usage: verify-bundle-parity.sh <baseline-ref>}
gui_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$gui_dir/../.." && pwd)
work=$(mktemp -d)
cleanup() {
  git -C "$repo_root" worktree remove --force "$work/baseline" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

git -C "$repo_root" worktree add --detach "$work/baseline" "$baseline_ref" >/dev/null
(cd "$work/baseline/web/react-gui" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
(cd "$gui_dir" && npm run build >/dev/null)

normalize_tree() {
  src_dir=$1
  out_dir=$2
  (cd "$src_dir" && find . -type f | sort) | while read -r rel; do
    norm_rel=$(printf '%s' "$rel" | sed -E 's/-[A-Za-z0-9_-]{8}\.(js|css)/.HASH.\1/g')
    mkdir -p "$out_dir/$(dirname "$norm_rel")"
    case "$rel" in
      *.js|*.css|*.html)
        sed -E 's/-[A-Za-z0-9_-]{8}\.(js|css)/.HASH.\1/g' "$src_dir/$rel" > "$out_dir/$norm_rel" ;;
      *)
        cp "$src_dir/$rel" "$out_dir/$norm_rel" ;;
    esac
  done
}
normalize_tree "$work/baseline/web/react-gui/build" "$work/before"
normalize_tree "$gui_dir/build" "$work/after"

if ! diff -r --exclude='*.css' "$work/before" "$work/after"; then
  echo "verify-bundle-parity: FAILED — non-CSS assets differ" >&2
  exit 1
fi

for css in $(cd "$work/after" && find . -name '*.css' | sort); do
  node "$gui_dir/scripts/css-rule-diff.mjs" "$work/before/$css" "$work/after/$css"
done

echo "verify-bundle-parity: OK"
