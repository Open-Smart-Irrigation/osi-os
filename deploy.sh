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

echo "--- node-red-node-sqlite ---"
cd /srv/node-red && npm install node-red-node-sqlite --save 2>&1 | tail -3

echo "--- React GUI ---"
mkdir -p /usr/lib/node-red/gui
curl -s "$BASE/react_gui.tar.gz" -o /tmp/react_gui.tar.gz \
    && tar xzf /tmp/react_gui.tar.gz -C /usr/lib/node-red/gui/ \
    && rm /tmp/react_gui.tar.gz \
    && echo "OK" || echo "FAIL (run 'npm run build' in web/react-gui first)"

echo ""
echo "=== Deploy complete. Restart Node-RED: ==="
echo "    /etc/init.d/node-red restart"
