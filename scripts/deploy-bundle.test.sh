#!/bin/sh
# Tests scripts/deploy-bundle.sh against the real repo tree (it is the same
# tree deploy-fetch-list.test.js already proves is drift-proof), only
# redirecting OUT_DIR/REACT_GUI_TARBALL so the test never writes into the
# working tree.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
# deploy-bundle.sh is a bash script (pipefail, BASH_SOURCE): run it with bash,
# not sh, which is dash on Debian and Ubuntu.
builder="$script_dir/deploy-bundle.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

out_dir="$work/dist"
gui_tar="$work/react_gui.tar.gz"

echo "fail without a react_gui.tar.gz..."
if REPO_ROOT="$repo_root" OUT_DIR="$out_dir" REACT_GUI_TARBALL="$work/does-not-exist.tar.gz" \
    bash "$builder" >"$work/no-gui.log" 2>&1; then
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
  bash "$builder" >"$work/build.log" 2>&1 || {
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
grep -qx './scripts/deploy-local-server.js' "$listing" || grep -qx 'scripts/deploy-local-server.js' "$listing" || {
  echo "bundle missing scripts/deploy-local-server.js (deploy-offline.sh execs it from inside the bundle)" >&2
  exit 1
}
grep -qx './conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-binding/canonicalization.js' "$listing" || \
grep -qx 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-binding/canonicalization.js' "$listing" || {
  echo "bundle missing the WATERMARK binding canonicalizer" >&2
  exit 1
}
grep -qx './conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js' "$listing" || \
grep -qx 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/commands.js' "$listing" || {
  echo "bundle missing the WATERMARK command receiver" >&2
  exit 1
}

for module in migration-manifest.js migrations-loader.js; do
  grep -qx "./lib/osi-migrate/$module" "$listing" || grep -qx "lib/osi-migrate/$module" "$listing" || {
    echo "bundle missing early manifest module $module" >&2
    exit 1
  }
done

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

# v0.8.2 review, S-6: with neither an argument nor REACT_GUI_TARBALL, the
# builder takes react_gui.tar.gz from the repository root, as its usage says.
# A tree of links to the real repository stands in for it, so the test never
# writes into the working tree.
echo "build with the default GUI path (no argument, no REACT_GUI_TARBALL)..."
link_root="$work/repo"
mkdir "$link_root"
for entry in "$repo_root"/* "$repo_root"/.[!.]*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  [ "$name" = react_gui.tar.gz ] && continue
  ln -s "$entry" "$link_root/$name"
done
printf 'stub default gui\n' | gzip > "$link_root/react_gui.tar.gz"
default_out="$work/dist-default"
if ! (unset REACT_GUI_TARBALL; REPO_ROOT="$link_root" OUT_DIR="$default_out" BUNDLE_TS="20260911T000001Z" \
    bash "$builder" >"$work/default.log" 2>&1); then
  echo "expected deploy-bundle.sh to use \$REPO_ROOT/react_gui.tar.gz without an argument" >&2
  cat "$work/default.log" >&2
  exit 1
fi
grep -q "GUI:    $link_root/react_gui.tar.gz" "$work/default.log" || {
  echo "expected the default GUI path in the build log" >&2
  cat "$work/default.log" >&2
  exit 1
}
find "$default_out" -name 'deploy-bundle-*.tar.gz' | grep -q . || {
  echo "no bundle produced with the default GUI path" >&2
  exit 1
}
echo "OK: the default GUI path builds a bundle"

echo "deploy-bundle.test: OK"
