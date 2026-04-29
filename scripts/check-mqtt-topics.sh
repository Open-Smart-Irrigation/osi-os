#!/bin/bash
# check-mqtt-topics.sh — Ensure no MQTT IN node has a per-Pi UUID in its topic.
# All MQTT IN nodes should use application/+/device/+/event/up
set -euo pipefail

FLOWS=(
    conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
    conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
    conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json
)

UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
EXPECTED_TOPIC='application/+/device/+/event/up'
FAIL=0

for flow in "${FLOWS[@]}"; do
    if [ ! -f "$flow" ]; then
        echo "MISSING: $flow"
        FAIL=1
        continue
    fi

    # Check for per-Pi UUIDs in MQTT IN topics
    UUID_TOPICS=$(python3 -c "
import json, re
with open('$flow') as f:
    flows = json.load(f)
uuid_re = re.compile(r'$UUID_RE', re.IGNORECASE)
bad = [n for n in flows if n.get('type') == 'mqtt in' and uuid_re.search(n.get('topic', ''))]
for n in bad:
    print(f'{n.get(\"name\", n[\"id\"])}: {n[\"topic\"]}')
")

    if [ -n "$UUID_TOPICS" ]; then
        echo "FAIL: $flow has MQTT IN nodes with per-Pi UUID topics:"
        echo "$UUID_TOPICS"
        FAIL=1
    else
        echo "OK: $flow — no UUID patterns in MQTT IN topics"
    fi

    # Check all MQTT IN topics use the expected wildcard pattern
    NON_WILDCARD=$(python3 -c "
import json
with open('$flow') as f:
    flows = json.load(f)
mqtt_ins = [n for n in flows if n.get('type') == 'mqtt in']
for m in mqtt_ins:
    topic = m.get('topic', '')
    if topic != '$EXPECTED_TOPIC':
        print(f'{m.get(\"name\", m[\"id\"])}: {topic}')
")

    if [ -n "$NON_WILDCARD" ]; then
        echo "FAIL: $flow has MQTT IN nodes not using expected wildcard pattern:"
        echo "$NON_WILDCARD"
        FAIL=1
    fi
done

exit $FAIL