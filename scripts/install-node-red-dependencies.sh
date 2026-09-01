#!/bin/sh
set -eu

NODE_RED_DIR="${NODE_RED_DIR:-/srv/node-red}"
SYSTEM_SQLITE3_DIR="${SYSTEM_SQLITE3_DIR:-/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3}"
NPM_BIN="${NPM_BIN:-npm}"
NODE_BIN="${NODE_BIN:-node}"

case "$NODE_RED_DIR" in
    ''|/) echo "ERROR: unsafe Node-RED directory: '$NODE_RED_DIR'" >&2; exit 1 ;;
esac

if [ ! -f "$NODE_RED_DIR/package-lock.json" ]; then
    echo "ERROR: missing Node-RED package lock: $NODE_RED_DIR/package-lock.json" >&2
    exit 1
fi
if [ ! -d "$SYSTEM_SQLITE3_DIR" ]; then
    echo "ERROR: OpenWrt sqlite3 module is missing: $SYSTEM_SQLITE3_DIR" >&2
    exit 1
fi

PACKAGE_LOCK="$NODE_RED_DIR/package-lock.json" "$NODE_BIN" -e '
const lock = require(process.env.PACKAGE_LOCK);
const allowed = new Set(["node_modules/protobufjs", "node_modules/sqlite3"]);
const unexpected = Object.entries(lock.packages || {})
  .filter(([, value]) => value && value.hasInstallScript)
  .map(([name]) => name)
  .filter((name) => !allowed.has(name));
if (unexpected.length) {
  console.error("ERROR: unreviewed npm lifecycle scripts: " + unexpected.join(", "));
  process.exit(1);
}
'

SYSTEM_SQLITE3_DIR="$SYSTEM_SQLITE3_DIR" "$NODE_BIN" -e \
    'require(process.env.SYSTEM_SQLITE3_DIR)'

mkdir -p "$NODE_RED_DIR/node_modules"

restore_openwrt_sqlite() {
    rm -rf "$NODE_RED_DIR/node_modules/sqlite3"
    ln -s "$SYSTEM_SQLITE3_DIR" "$NODE_RED_DIR/node_modules/sqlite3"
}

# npm must not compile sqlite3 on the target. The image already carries the
# native ARM/musl module in the node-red-node-sqlite OpenWrt package.
trap 'restore_openwrt_sqlite' 0 1 2 15
cd "$NODE_RED_DIR"
"$NPM_BIN" install --ignore-scripts --omit=dev --no-fund --no-audit
restore_openwrt_sqlite

# protobufjs is the only reviewed non-native lifecycle script in the lock.
"$NPM_BIN" rebuild protobufjs --no-fund --no-audit
restore_openwrt_sqlite

NODE_RED_DIR="$NODE_RED_DIR" "$NODE_BIN" -e \
    'require(process.env.NODE_RED_DIR + "/node_modules/sqlite3")'
trap - 0 1 2 15

