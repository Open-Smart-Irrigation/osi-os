#!/bin/sh
# Tests scripts/deploy-bundle.sh against the real repo tree (it is the same
# tree deploy-fetch-list.test.js already proves is drift-proof), only
# redirecting OUT_DIR/REACT_GUI_TARBALL so the test never writes into the
# working tree.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
builder="$script_dir/deploy-bundle.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

out_dir="$work/dist"
gui_tar="$work/react_gui.tar.gz"

echo "fail without a react_gui.tar.gz..."
if REPO_ROOT="$repo_root" OUT_DIR="$out_dir" REACT_GUI_TARBALL="$work/does-not-exist.tar.gz" \
    sh "$builder" >"$work/no-gui.log" 2>&1; then
  echo "expected deploy-bundle.sh to fail when react_gui.tar.gz is absent" >&2
  cat "$work/no-gui.log" >&2
  exit 1
fi
grep -qi 'react_gui.tar.gz' "$work/no-gui.log" || {
  echo "expected a clear error mentioning react_gui.tar.gz" >&2
  cat "$work/no-gui.log" >&2
  exit 1
}
[ ! -d "$out_dir" ] && echo "OK: no dist/ written on failure" || {
  # deploy-bundle.sh may mkdir OUT_DIR before the GUI check; only object if
  # it left a bundle behind.
  find "$out_dir" -name 'deploy-bundle-*.tar.gz' | grep -q . && {
    echo "expected no bundle tarball on failure" >&2
    exit 1
  }
  true
}

echo "build a real bundle..."
printf 'stub gui bundle\n' | gzip > "$gui_tar"
REPO_ROOT="$repo_root" OUT_DIR="$out_dir" REACT_GUI_TARBALL="$gui_tar" BUNDLE_TS="20260911T000000Z" \
  sh "$builder" >"$work/build.log" 2>&1 || {
  echo "expected deploy-bundle.sh to succeed with a react_gui.tar.gz present" >&2
  cat "$work/build.log" >&2
  exit 1
}

bundle=$(find "$out_dir" -name 'deploy-bundle-*.tar.gz' | head -1)
[ -n "$bundle" ] || { echo "no bundle tarball produced" >&2; cat "$work/build.log" >&2; exit 1; }
sha_file="$bundle.sha256"
[ -f "$sha_file" ] || { echo "no .sha256 sidecar produced" >&2; exit 1; }

echo "verify sha256 sidecar matches..."
expected_sha=$(cut -d ' ' -f1 "$sha_file")
actual_sha=$(sha256sum "$bundle" | cut -d ' ' -f1)
[ "$expected_sha" = "$actual_sha" ] || {
  echo "sha256 sidecar does not match bundle contents" >&2
  exit 1
}

echo "verify bundle contains deploy.sh and react_gui.tar.gz..."
listing="$work/listing.txt"
tar tzf "$bundle" > "$listing"
grep -qx './deploy.sh' "$listing" || grep -qx 'deploy.sh' "$listing" || {
  echo "bundle missing deploy.sh" >&2
  exit 1
}
grep -qx './react_gui.tar.gz' "$listing" || grep -qx 'react_gui.tar.gz' "$listing" || {
  echo "bundle missing react_gui.tar.gz" >&2
  exit 1
}

echo "verify bundle is drift-proof against deploy-fetch-list.js..."
fetch_list="$work/fetch-list.txt"
node "$script_dir/deploy-fetch-list.js" "$repo_root" | sort > "$fetch_list"
# Every path deploy.sh could fetch must be present in the bundle listing
# (normalize the tar's leading "./").
sed -e 's#^\./##' "$listing" | sort > "$work/listing-normalized.txt"
missing=$(comm -23 "$fetch_list" "$work/listing-normalized.txt")
if [ -n "$missing" ]; then
  echo "bundle is missing paths deploy.sh would fetch:" >&2
  echo "$missing" >&2
  exit 1
fi

fetch_count=$(wc -l < "$fetch_list" | tr -d ' ')
echo "OK: bundle contains all $fetch_count deploy.sh-derived paths + deploy.sh + react_gui.tar.gz"

echo "deploy-bundle.test: OK"
