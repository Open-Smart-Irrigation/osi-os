#!/bin/sh
# OSI OS - Remote deploy script
# Runs ON THE PI. Downloads OSI OS components from a local HTTP server
# tunnelled through the SSH connection.
#
# Usage (from your dev machine):
#   ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -fsS http://localhost:9876/deploy.sh | sh'
#
# Safety invariant: this script must never overwrite /data/db/farming.db.
# The edge database is live user data and osi-os is the operational source of
# truth. The bundled seed database is only copied when the target DB is absent.

set -eu

PORT="${1:-9876}"
BASE="http://localhost:$PORT"
DB_DIR="/data/db"
DB_PATH="$DB_DIR/farming.db"
SEED_DB_REL="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db"
TMP_DIR="/tmp/osi-os-deploy.$$"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP_DIR" /srv/node-red "$DB_DIR"

fetch() {
    src="$1"
    dest="$2"
    mkdir -p "$(dirname "$dest")"
    curl -fsSLo "$dest" "$BASE/$src"
}

fetch_required() {
    label="$1"
    src="$2"
    dest="$3"
    echo "--- $label ---"
    fetch "$src" "$dest"
    echo "OK"
}

seed_db_if_missing() {
    echo "--- farming.db ---"
    if [ -e "$DB_PATH" ]; then
        echo "SKIP: existing live database preserved at $DB_PATH"
        return 0
    fi
    if [ -e "$DB_PATH-wal" ] || [ -e "$DB_PATH-shm" ] || [ -e "$DB_PATH-journal" ]; then
        echo "ERROR: $DB_PATH is missing but SQLite sidecar files exist." >&2
        echo "Refusing to seed; inspect $DB_DIR before continuing." >&2
        return 1
    fi

    seed_tmp="$TMP_DIR/farming.db"
    fetch "$SEED_DB_REL" "$seed_tmp"
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$seed_tmp" "PRAGMA integrity_check;" | grep -qx "ok"
    fi
    if [ -e "$DB_PATH" ]; then
        echo "SKIP: existing live database appeared during deploy and was preserved at $DB_PATH"
        return 0
    fi
    mv "$seed_tmp" "$DB_PATH"
    echo "OK: seeded new database at $DB_PATH"
}

echo "=== OSI OS Deploy ==="
echo "Source: $BASE"

fetch_required "Node-RED settings.js" \
    "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js" \
    "/srv/node-red/settings.js"

fetch_required "flows.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" \
    "/srv/node-red/flows.json"

seed_db_if_missing

fetch_required "Node-RED runtime package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json" \
    "/srv/node-red/package.json"

fetch_required "Node-RED runtime package-lock.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json" \
    "/srv/node-red/package-lock.json"

fetch_required "osi-chirpstack-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/package.json" \
    "/srv/node-red/osi-chirpstack-helper/package.json"

fetch_required "osi-chirpstack-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js" \
    "/srv/node-red/osi-chirpstack-helper/index.js"

fetch_required "osi-db-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/package.json" \
    "/srv/node-red/osi-db-helper/package.json"

fetch_required "osi-db-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js" \
    "/srv/node-red/osi-db-helper/index.js"

fetch_required "chirpstack-bootstrap.js" \
    "scripts/chirpstack-bootstrap.js" \
    "/srv/node-red/chirpstack-bootstrap.js"

fetch_required "S2120 codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js" \
    "/srv/node-red/codecs/sensecap_s2120_decoder.js"

echo "--- Node-RED runtime dependencies ---"
npm_log="$TMP_DIR/npm-install.log"
if cd /srv/node-red && npm install --omit=dev --no-fund --no-audit >"$npm_log" 2>&1; then
    tail -20 "$npm_log"
else
    tail -80 "$npm_log" >&2
    echo "ERROR: npm install failed" >&2
    exit 1
fi

echo "--- React GUI ---"
fetch "react_gui.tar.gz" "$TMP_DIR/react_gui.tar.gz"
mkdir -p /usr/lib/node-red/gui
tar xzf "$TMP_DIR/react_gui.tar.gz" -C /usr/lib/node-red/gui/
echo "OK"

echo ""
echo "=== Deploy complete. Next steps: ==="
echo "  1. Restart Node-RED:         /etc/init.d/node-red restart"
echo "  2. Run ChirpStack bootstrap: node /srv/node-red/chirpstack-bootstrap.js"
echo "  3. Restart Node-RED again:   /etc/init.d/node-red restart"
echo "  4. Open the UI:              http://<device-ip>:1880/gui"
