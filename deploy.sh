#!/bin/sh
# OSI OS — Remote deploy script
# Runs ON THE PI. Downloads all OSI OS components from a local HTTP server
# tunnelled through the SSH connection.
#
# Usage (from your dev machine):
#   ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -s http://localhost:9876/deploy.sh | sh'
#
# See README.md — "Device Setup" for the full workflow.

PORT="${1:-9876}"
BASE="http://localhost:$PORT"

echo "=== OSI OS Deploy ==="

echo "--- Node-RED settings.js ---"
curl -s "$BASE/feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js" \
    -o /srv/node-red/settings.js && echo "OK" || echo "FAIL"

echo "--- flows.json ---"
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" \
    -o /srv/node-red/flows.json && echo "OK" || echo "FAIL"

echo "--- farming.db ---"
mkdir -p /data/db
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db" \
    -o /data/db/farming.db && echo "OK" || echo "FAIL"

echo "--- Node-RED runtime package.json ---"
mkdir -p /srv/node-red
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json" \
    -o /srv/node-red/package.json && echo "OK" || echo "FAIL"

echo "--- Node-RED runtime package-lock.json ---"
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json" \
    -o /srv/node-red/package-lock.json && echo "OK" || echo "FAIL"

echo "--- osi-chirpstack-helper ---"
mkdir -p /srv/node-red/osi-chirpstack-helper
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/package.json" \
    -o /srv/node-red/osi-chirpstack-helper/package.json && echo "package OK" || echo "package FAIL"
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js" \
    -o /srv/node-red/osi-chirpstack-helper/index.js && echo "index OK" || echo "index FAIL"

echo "--- osi-db-helper ---"
mkdir -p /srv/node-red/osi-db-helper
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/package.json" \
    -o /srv/node-red/osi-db-helper/package.json && echo "package OK" || echo "package FAIL"
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js" \
    -o /srv/node-red/osi-db-helper/index.js && echo "index OK" || echo "index FAIL"

echo "--- chirpstack-bootstrap.js ---"
curl -s "$BASE/scripts/chirpstack-bootstrap.js" \
    -o /srv/node-red/chirpstack-bootstrap.js && echo "OK" || echo "FAIL"

echo "--- S2120 codec ---"
mkdir -p /srv/node-red/codecs
curl -s "$BASE/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js" \
    -o /srv/node-red/codecs/sensecap_s2120_decoder.js && echo "OK" || echo "FAIL"

echo "--- Node-RED runtime dependencies ---"
cd /srv/node-red && npm install --omit=dev --no-fund --no-audit 2>&1 | tail -20

echo "--- React GUI ---"
mkdir -p /usr/lib/node-red/gui
curl -s "$BASE/react_gui.tar.gz" -o /tmp/react_gui.tar.gz \
    && tar xzf /tmp/react_gui.tar.gz -C /usr/lib/node-red/gui/ \
    && rm /tmp/react_gui.tar.gz \
    && echo "OK" || echo "FAIL (run 'npm run build' in web/react-gui first)"

echo ""
echo "=== Deploy complete. Next steps: ==="
echo "  1. Restart Node-RED:         /etc/init.d/node-red restart"
echo "  2. Run ChirpStack bootstrap: node /srv/node-red/chirpstack-bootstrap.js"
echo "  3. Restart Node-RED again:   /etc/init.d/node-red restart"
echo "  4. Open the UI:              http://<device-ip>:1880/gui"
