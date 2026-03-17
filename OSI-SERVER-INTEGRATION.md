# OSI Server Integration — Implementation Brief

> **Branch:** `feat/osi-server-integration`
> **Working directory:** `/home/phil/Repos/osi-os`
> **Target file:** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
> **Reference implementation:** `/home/phil/Repos/osi-server/mqtt/nodered-flows/osi-server-cloud-integration.json`

---

## Goal

Add a new Node-RED flow tab **"OSI-Server Cloud Integration"** to `flows.json` that connects the Pi bidirectionally to the OSI Server cloud backend over MQTT TLS (port 8883). The Pi operates fully offline-first — the cloud connection is optional and the Pi never waits for it.

Also fix two known bugs in the existing flows (see section 9).

---

## What Already Exists

A reference Node-RED flow JSON is at:
```
/home/phil/Repos/osi-server/mqtt/nodered-flows/osi-server-cloud-integration.json
```

**Read this file first** — it contains working implementations of heartbeat, telemetry, command receiver, and status/ACK flows. The task is to integrate and adapt these into `flows.json`, not write from scratch.

The OSI-OS flows.json already has these tabs (do not modify them, only add link nodes where specified):
- `auth-tab` — Authentication
- `device-api-tab` — Device Management REST API
- `c2b43a6c6e7d2c11` — Scheduler
- `49e87447205bb849` — Sensor_KIWI
- `8a18de184886c8a8` — Actuator_STREGA
- `a88bb648cac221ce` — Simulations (Dev)
- `a3f03829ad106e10` — Field testing
- `7d4f3e45f4b0d111` — Download Sensor Data

---

## MQTT Topics & Payloads

All topics use `{DEVICE_EUI}` from the Node-RED env var `DEVICE_EUI`.

### Pi → Cloud

**`devices/{EUI}/heartbeat`** (every 60s, QoS 1)
```json
{
  "deviceEui": "<DEVICE_EUI>",
  "deviceType": "<DEVICE_TYPE>",
  "firmwareVersion": "<FIRMWARE_VERSION>",
  "timestamp": "<ISO8601>",
  "ip": "<local-ip or null>"
}
```

**`devices/{EUI}/telemetry`** (on each sensor uplink, QoS 1)
```json
{
  "deviceEui": "<sensor-deveui>",
  "timestamp": "<ISO8601>",
  "swt_wm1": 45.2,
  "swt_wm2": 38.1,
  "light_lux": 25000,
  "ambient_temperature": 28.5,
  "relative_humidity": 65
}
```

**`devices/{EUI}/status`** (after valve ACK, QoS 1)
```json
{
  "state": "OPEN",
  "timestamp": "<ISO8601>"
}
```

**`devices/{EUI}/command_ack`** (after valve ACK, QoS 1)
```json
{
  "commandId": 123,
  "result": "SUCCESS",
  "state": "OPEN"
}
```

### Cloud → Pi

**`devices/{EUI}/commands`** (QoS 1, clean session: false so commands queue offline)

Valve command:
```json
{
  "commandId": 123,
  "commandType": "VALVE_COMMAND",
  "action": "OPEN_FOR_DURATION",
  "duration_minutes": 30
}
```

Schedule update command:
```json
{
  "commandId": 124,
  "commandType": "UPDATE_SCHEDULE",
  "zoneId": 5,
  "triggerMetric": "SWT_WM1",
  "thresholdKpa": 50.0,
  "durationMinutes": 30,
  "enabled": true
}
```

---

## MQTT Broker Config (Cloud Broker)

Add a new `mqtt-broker` config node to flows.json:
- **Host:** `${OSI_SERVER_HOST}` (env var)
- **Port:** `8883`
- **TLS:** enabled (accept self-signed / no CA verification in MVP, or configurable)
- **Client ID:** `device_${DEVICE_EUI}` (env var)
- **Username:** `device_${DEVICE_EUI}` (env var)
- **Password:** `${DEVICE_MQTT_PASSWORD}` (env var)
- **Protocol:** MQTT v5
- **Keep-alive:** 60
- **Clean session:** `false` (important — queues commands when offline)
- **Auto-reconnect:** enabled

The existing local ChirpStack broker node ID is `b0b19352dac3fb34` (localhost:1883, no auth) — **do not modify it**.

---

## Environment Variables

Node-RED reads these from the process environment (set by UCI config + init script):

| Variable | Source | Example |
|---|---|---|
| `DEVICE_EUI` | UCI `osi-server.cloud.device_eui` | `AABBCCDDEEFF0011` |
| `DEVICE_TYPE` | UCI `osi-server.cloud.device_type` | `GATEWAY` |
| `DEVICE_MQTT_PASSWORD` | UCI `osi-server.cloud.mqtt_password` | `<random>` |
| `OSI_SERVER_HOST` | UCI `osi-server.cloud.server_host` | `cloud.example.com` |
| `FIRMWARE_VERSION` | UCI `osi-server.cloud.firmware_version` | `0.5.0` |

In Node-RED function nodes, read them as: `env.get('DEVICE_EUI')`

---

## New Flow Tab: "OSI-Server Cloud Integration"

### Sequence 1 — Heartbeat (60s)
```
inject(60s repeat) → [function: Build Heartbeat] → mqtt out (cloud broker, topic: devices/{EUI}/heartbeat, QoS 1)
```

Build Heartbeat function:
```javascript
var eui = env.get('DEVICE_EUI') || 'UNKNOWN';
var deviceType = env.get('DEVICE_TYPE') || 'GATEWAY';
var fw = env.get('FIRMWARE_VERSION') || '0.5.0';
msg.topic = 'devices/' + eui + '/heartbeat';
msg.payload = JSON.stringify({
    deviceEui: eui,
    deviceType: deviceType,
    firmwareVersion: fw,
    timestamp: new Date().toISOString(),
    ip: null
});
msg.qos = 1;
return msg;
```

### Sequence 2 — Telemetry Forward

Subscribe to local ChirpStack sensor uplinks and forward decoded data to cloud.

```
mqtt in (local broker, topic: application/+/device/+/event/up)
  → [function: Build Telemetry]
  → mqtt out (cloud broker, topic: devices/{EUI}/telemetry, QoS 1)
```

Build Telemetry function:
```javascript
var data = msg.payload;
var obj = data.object || {};
var eui = env.get('DEVICE_EUI') || 'UNKNOWN';
// Only forward if this device belongs to this gateway
// (filter by checking devEui matches known sensors or pass all through)
msg.topic = 'devices/' + eui + '/telemetry';
msg.payload = JSON.stringify({
    deviceEui: (data.deviceInfo && data.deviceInfo.devEui) || eui,
    timestamp: data.time || new Date().toISOString(),
    swt_wm1: obj.swt_wm1 || null,
    swt_wm2: obj.swt_wm2 || null,
    light_lux: obj.light_intensity || obj.light_lux || null,
    ambient_temperature: obj.ambient_temperature || null,
    relative_humidity: obj.relative_humidity || null
});
msg.qos = 1;
return msg;
```

### Sequence 3 — Command Receiver

```
mqtt in (cloud broker, topic: devices/{EUI}/commands, QoS 1)
  → [function: Route Command]
  → (if VALVE_COMMAND) → link out to Actuator_STREGA tab
  → (if UPDATE_SCHEDULE) → [function: Build UPDATE SQL] → sqlite node
```

Route Command function:
```javascript
var cmd = (typeof msg.payload === 'string') ? JSON.parse(msg.payload) : msg.payload;
flow.set('lastCommandId', cmd.commandId);
flow.set('lastCommand', cmd);

if (cmd.commandType === 'VALVE_COMMAND') {
    // Build actuator_command compatible with Actuator_STREGA tab
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: cmd.devEui || '' },
        data: {
            action: cmd.action,
            duration_minutes: cmd.duration_minutes || 0,
            reason: 'osi_server_command',
            commandId: cmd.commandId
        }
    };
    return [msg, null]; // output 1: valve, output 2: schedule (null)
} else if (cmd.commandType === 'UPDATE_SCHEDULE') {
    msg.payload = cmd;
    return [null, msg]; // output 1: valve (null), output 2: schedule
}
return null;
```

Build UPDATE SQL function (for UPDATE_SCHEDULE):
```javascript
var cmd = msg.payload;
var zoneId = cmd.zoneId;
var metric = (cmd.triggerMetric || 'SWT_WM1').replace(/'/g, "''");
var threshold = parseFloat(cmd.thresholdKpa) || 0;
var duration = parseInt(cmd.durationMinutes) || 0;
var enabled = cmd.enabled ? 1 : 0;

msg.topic = 'UPDATE irrigation_schedules SET ' +
    'trigger_metric = \'' + metric + '\', ' +
    'threshold_kpa = ' + threshold + ', ' +
    'duration_minutes = ' + duration + ', ' +
    'enabled = ' + enabled + ' ' +
    'WHERE irrigation_zone_id = ' + zoneId;
msg.payload = [];
return msg;
```
→ sqlite node (existing DB config from other tabs)
→ After sqlite: send command_ack to cloud

### Sequence 4 — Status + Command ACK (after valve execution)

Add a **link out** node at the end of the successful valve execution path in the **Actuator_STREGA** tab, and receive it here.

```
link in (from Actuator_STREGA, carries valve result)
  → [function: Build Status + ACK]
  → [switch: split into 2 messages]
  → mqtt out 1 (cloud broker, topic: devices/{EUI}/status, QoS 1)
  → mqtt out 2 (cloud broker, topic: devices/{EUI}/command_ack, QoS 1)
```

Build Status + ACK function:
```javascript
var eui = env.get('DEVICE_EUI') || 'UNKNOWN';
var commandId = flow.get('lastCommandId');
var action = msg.payload && msg.payload.data && msg.payload.data.action;
var state = (action === 'OPEN' || action === 'OPEN_FOR_DURATION') ? 'OPEN' : 'CLOSED';
var ts = new Date().toISOString();

var status = {
    topic: 'devices/' + eui + '/status',
    payload: JSON.stringify({ state: state, timestamp: ts }),
    qos: 1
};
var ack = {
    topic: 'devices/' + eui + '/command_ack',
    payload: JSON.stringify({
        commandId: commandId || null,
        result: 'SUCCESS',
        state: state
    }),
    qos: 1
};
return [status, ack]; // two outputs, each goes to its own mqtt out node
```

---

## Changes to Existing Tabs

### Actuator_STREGA tab

1. Add a **link out** node at the end of the successful MQTT publish path (after the actuator_log INSERT succeeds), forwarding the actuator_command message so the OSI Server Sync tab can send status + ACK to cloud.

   Find the node that currently ends the valve execution chain (after `actuator_log` INSERT) and add:
   ```json
   { "type": "link out", "name": "to OSI Server ACK", "links": ["<link-in-id-in-osi-server-tab>"] }
   ```

2. **Bug fix — column name:** In the `Build actuator_command + DB writes` function node, change `duration_open` → `duration_minutes` in the INSERT INTO actuator_log SQL string.

---

## UCI Config & Init Script

### Create `/etc/uci-defaults/96_osi_server_config`
```bash
#!/bin/sh
# Only run if not already configured
[ -n "$(uci -q get osi-server.cloud.device_eui 2>/dev/null)" ] && exit 0

# Derive device EUI from Ethernet MAC
ETH_MAC=$(ip link show eth0 2>/dev/null | awk '/ether/{print $2}' | tr -d ':' | tr 'a-f' 'A-F')
[ -z "$ETH_MAC" ] && ETH_MAC=$(ip link show wlan0 2>/dev/null | awk '/ether/{print $2}' | tr -d ':' | tr 'a-f' 'A-F')

uci -q batch <<EOF
set osi-server.cloud=osi_server
set osi-server.cloud.enabled=0
set osi-server.cloud.device_eui=$ETH_MAC
set osi-server.cloud.device_type=GATEWAY
set osi-server.cloud.firmware_version=0.5.0
set osi-server.cloud.server_host=
set osi-server.cloud.mqtt_password=
commit osi-server
EOF
exit 0
```

Store this at: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config`

### Update Node-RED init script
File: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`

In the `start_service()` function, export UCI values as env vars before starting Node-RED:
```bash
start_service() {
    mkdir -p /srv/$PACKAGE_NAME

    # OSI Server cloud integration env vars (from UCI)
    local device_eui=$(uci -q get osi-server.cloud.device_eui 2>/dev/null || echo "")
    local device_type=$(uci -q get osi-server.cloud.device_type 2>/dev/null || echo "GATEWAY")
    local mqtt_password=$(uci -q get osi-server.cloud.mqtt_password 2>/dev/null || echo "")
    local server_host=$(uci -q get osi-server.cloud.server_host 2>/dev/null || echo "")
    local fw_version=$(uci -q get osi-server.cloud.firmware_version 2>/dev/null || echo "0.5.0")

    procd_open_instance
    procd_set_param command node /usr/lib/node/$PACKAGE_NAME/red.js --userDir /srv/$PACKAGE_NAME
    procd_set_param env \
        DEVICE_EUI="$device_eui" \
        DEVICE_TYPE="$device_type" \
        DEVICE_MQTT_PASSWORD="$mqtt_password" \
        OSI_SERVER_HOST="$server_host" \
        FIRMWARE_VERSION="$fw_version"
    procd_set_param respawn 3600 5 -1
    procd_close_instance
}
```

---

## Implementation Steps

1. **Read** `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` — understand full structure and locate node IDs for Actuator_STREGA completion path.

2. **Read** `/home/phil/Repos/osi-server/mqtt/nodered-flows/osi-server-cloud-integration.json` — copy/adapt the cloud MQTT broker config node and the four flow sequences.

3. **Construct** the new "OSI-Server Cloud Integration" tab JSON with:
   - New tab node
   - Cloud MQTT broker config node (separate from local broker)
   - Heartbeat flow (inject + function + mqtt out)
   - Telemetry flow (mqtt in local + function + mqtt out cloud)
   - Command receiver (mqtt in cloud + route function + 2 outputs: link out to Actuator_STREGA + sqlite for schedule updates)
   - Status/ACK flow (link in + function + 2x mqtt out)

4. **Patch** the Actuator_STREGA tab:
   - Fix `duration_open` → `duration_minutes` bug in the actuator_log INSERT SQL
   - Add link out node at the end of the successful execution chain

5. **Create** `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config`

6. **Update** `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` with env var exports

7. **Write** all changes and commit to branch `feat/osi-server-integration`

---

## Important Conventions

- All Node-RED node IDs must be unique 16-char hex strings (generate with e.g. `openssl rand -hex 8`)
- DevEUI is always `UPPER()` — enforce in all SQL and JS
- SQL uses string interpolation with `replace(/'/g, "''")` — no parameterized queries (sqlite node limitation)
- The cloud MQTT broker node must be a **separate** node from the local broker (`b0b19352dac3fb34`)
- The new tab should be `disabled: false` but the cloud MQTT broker node should gracefully handle connection failure (offline-first: Pi works without cloud)
- All function nodes must handle `null`/`undefined` env vars gracefully (cloud may not be configured)

---

## Known Bugs to Fix (in Actuator_STREGA tab)

### Bug 1: Valve error on open/close
**Location:** Function node "Build actuator_command + DB writes" in the `8a18de184886c8a8` (Actuator_STREGA) tab
**Fix:** In the INSERT INTO actuator_log SQL, change column name `duration_open` → `duration_minutes`

### Bug 2: Valve "last seen" wrong timestamp
**Location:** Device Management tab, in the "Merge Data" function that combines device rows with device_data
**Partial fix in this PR:** Not blocking, defer to separate PR

---

## Files to Change

| File | Action |
|---|---|
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Add OSI Server tab, patch Actuator_STREGA bug |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` | Add env var exports from UCI |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` | New file — UCI default config |
