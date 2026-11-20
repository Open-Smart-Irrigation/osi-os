#!/bin/sh
# Exercise the image's own init script, configuration generator and IPC client.
set -eu
verify_forwarder() {
    # Run the shipped forwarder and a broker on guest loopback. The normal
    # gateway broker and its topics stay available to the OSI services.
    ip link set lo up
    mosquitto -p 18884 >/tmp/osi-broker.log 2>&1 &
    broker=$!
    cat >/tmp/osi-forwarder.toml <<'TOML'
[backend]
enabled = "concentratord"
[mqtt]
server = "tcp://127.0.0.1:18884"
topic_prefix = "us915_0"
json = true
TOML
    chirpstack-mqtt-forwarder -c /tmp/osi-forwarder.toml >/tmp/osi-forwarder.log 2>&1 &
    forwarder=$!
    trap 'kill "$forwarder" "$broker" 2>/dev/null || true' EXIT
    topic=us915_0/gateway/020000fffe000001
    mosquitto_sub -h 127.0.0.1 -p 18884 -t "$topic/state/conn" -C 1 -W 25 >/tmp/osi-conn
    mosquitto_sub -h 127.0.0.1 -p 18884 -t "$topic/event/up" -C 1 -W 20 >/tmp/osi-up &
    subscriber=$!
    sleep 1
    printf '%s%s\n' WM1302_SERVICE_ LISTENING
    wait "$subscriber"
    test "$(jsonfilter -i /tmp/osi-up -e '@.phyPayload')" = QAQDAgEAAQABqrsAAAAA
    test "$(jsonfilter -i /tmp/osi-up -e '@.txInfo.frequency')" = 902300000
    echo 'Factory MQTT forwarder delivered the WM1302 uplink at 902.3 MHz'
    mosquitto_sub -h 127.0.0.1 -p 18884 -t "$topic/event/ack" -C 1 -W 20 >/tmp/osi-ack &
    subscriber=$!
    sleep 1
    mosquitto_pub -h 127.0.0.1 -p 18884 -t "$topic/command/down" -s <<'JSON'
{
  "gatewayId": "020000fffe000001", "downlinkId": 17,
  "items": [{
    "phyPayload": "T1NJIGRvd25saW5r",
    "txInfo": {
      "frequency": 923300000, "power": 14,
      "modulation": {"lora": {"bandwidth": 500000, "spreadingFactor": 7,
                              "codeRate": "CR_4_5", "polarizationInversion": true}},
      "timing": {"immediately": {}}
    }
  }]
}
JSON
    wait "$subscriber"
    cat /tmp/osi-ack
    test "$(jsonfilter -i /tmp/osi-ack -e '@.downlinkId')" = 17
    test "$(jsonfilter -i /tmp/osi-ack -e '@.items[0].status')" = OK
    echo 'Concentratord acknowledged the MQTT downlink'
}
modprobe spidev
# The serial shell is available before boot has started logd.
if [ ! -S /dev/log ]; then
    /sbin/logd >/tmp/osi-radio-logd.log 2>&1 &
fi
uci set chirpstack-concentratord.@global[0].enabled=1
uci set chirpstack-concentratord.@global[0].chipset=sx1302
uci set chirpstack-concentratord.@sx1302[0].model=seeed_wm1302
uci set chirpstack-concentratord.@sx1302[0].usb=0
uci set chirpstack-concentratord.@sx1302[0].region=US915
uci set chirpstack-concentratord.@sx1302[0].channel_plan=us915_0
/etc/init.d/chirpstack-concentratord start
i=0
while [ "$i" -lt 45 ]; do
    if [ -S /tmp/concentratord_command ]; then
        id=$(gateway-id -c ipc:///tmp/concentratord_command || true)
        if [ "$id" = "020000fffe000001" ]; then
            echo "ChirpStack Concentratord returned the simulated WM1302 EUI"
            if [ "${1:-0}" = 1 ]; then verify_forwarder; fi
            exit 0
        fi
    fi
    i=$((i + 1))
    sleep 1
done
logread -e concentratord | tail -30
exit 1
