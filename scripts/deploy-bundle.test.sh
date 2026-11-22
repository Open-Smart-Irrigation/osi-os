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
mkdir "$work/gui"
printf 'stub gui bundle\n' > "$work/gui/index.html"
bash "$script_dir/package-deploy-gui.sh" "$work/gui" "$gui_tar"
REPO_ROOT="$repo_root" OUT_DIR="$out_dir" REACT_GUI_TARBALL="$gui_tar" SOURCE_DATE_EPOCH=0 BUNDLE_TS="20260911T000000Z" \
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
LC_ALL=C sort "$listing" > "$work/sorted-listing.txt"
cmp "$listing" "$work/sorted-listing.txt"
TZ=UTC0 tar --full-time --numeric-owner -tvzf "$bundle" > "$work/metadata.txt"
awk '$2 != "0/0" || $4 != "1970-01-01" || $5 != "00:00:00" { exit 1 }' "$work/metadata.txt" || {
  echo "bundle owners or mtimes were not normalized" >&2
  exit 1
}
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

echo "verify byte-identical builds across time and umask..."
sleep 2
(umask 077; REPO_ROOT="$repo_root" OUT_DIR="$work/second" REACT_GUI_TARBALL="$gui_tar" SOURCE_DATE_EPOCH=0 BUNDLE_TS="20260911T000000Z" \
  bash "$builder" >"$work/second.log" 2>&1)
second=$(find "$work/second" -name 'deploy-bundle-*.tar.gz' | head -1)
second_sha=$(sha256sum "$second" | cut -d ' ' -f1)
[ "$actual_sha" = "$second_sha" ] || {
  echo "repeatability failed: $actual_sha != $second_sha" >&2
  exit 1
}
tar xzf "$bundle" -C "$work" ./bundle-manifest.json
node - "$work/bundle-manifest.json" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const manifest = JSON.parse(fs.readFileSync(process.argv[2]));
assert.equal(manifest.schema, 'osi-deploy-bundle/1');
assert.match(manifest.files['deploy.sh'], /^[a-f0-9]{64}$/);
assert.match(manifest.files['react_gui.tar.gz'], /^[a-f0-9]{64}$/);
NODE

echo "verify no-argument invocation fails clearly with missing default GUI..."
REACT_GUI_TARBALL= REPO_ROOT="$work/noarg-repo" OUT_DIR="$work/noarg" bash "$builder" >"$work/noarg.log" 2>&1 && exit 1
grep -q 'react_gui.tar.gz not found' "$work/noarg.log"
! grep -q 'unbound variable' "$work/noarg.log"
echo "deploy-bundle.test: OK"
