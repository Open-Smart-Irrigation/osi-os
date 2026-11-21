"""End-to-end radio acceptance against the disposable raspi5 guest."""
from __future__ import annotations

import json
import secrets
import time
import urllib.error
import urllib.request

from lorawan import LoRaWAN10
from run import RF_RECEIPT_CHANNEL, rf_frame
from upgrade_suite import checked, sql

VALVE = 'A840410000000001'
SENSOR = 'A840410000000002'
STREGA = bytes.fromhex('333630377423ffffffff23')
LSN50 = bytes.fromhex('A2030CE404E209290220080008000800080021FFFFFFFF08000800')
RECEIPT_TIMEOUT = 10


class LocalOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('unexpected redirect from local API')


def _api(vm, method, path, body=None, token=None):
    url = vm.url.rstrip('/') + path
    if not url.startswith(('http://127.0.0.1:', 'http://localhost:', 'https://127.0.0.1:', 'https://localhost:')):
        raise RuntimeError('VM API URL must use loopback')
    data = None if body is None else json.dumps(body).encode()
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalOnly())
        with opener.open(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'OSI API returned HTTP {exc.code}') from None


def _read_packet(sock, timeout):
    sock.settimeout(timeout)
    def exact(n):
        data = bytearray()
        while len(data) < n:
            part = sock.recv(n-len(data))
            if not part:
                raise ConnectionError('radio disconnected')
            data.extend(part)
        return bytes(data)
    length, channel, spreading_factor = exact(3)
    return channel, spreading_factor, exact(length)


def _receive(sock, timeout=20):
    channel, _, payload = _read_packet(sock, timeout)
    if channel not in (0, 1):
        raise RuntimeError('unexpected WM1302 downlink channel')
    return payload


def _send(sock, frame):
    try:
        sock.settimeout(RECEIPT_TIMEOUT)
        sock.sendall(rf_frame(frame, 902300000, receipt=True))
        channel, sf, receipt = _read_packet(sock, RECEIPT_TIMEOUT)
    except OSError as exc:
        raise RuntimeError('no WM1302 model delivery receipt (radio socket timed out or disconnected)') from exc
    if (channel, sf) != (RF_RECEIPT_CHANNEL, 0) or receipt not in (b'\x00', b'\x01'):
        raise RuntimeError('invalid WM1302 model delivery receipt')
    if receipt == b'\x00':
        raise RuntimeError('WM1302 model delivered zero frames (uplink rejected by RX FIFO)')
    return 1


def _mark_crc_window(vm):
    marker = secrets.token_hex(8)
    checked(vm, f'logger -t osi-radio-suite {marker}')
    return marker


def _radio_evidence(vm, marker, delivered):
    if delivered <= 0:
        raise RuntimeError('WM1302 model delivered zero frames')
    # Concentratord logs this line only after the CRC filter and protobuf
    # conversion. Verify the filter is enabled before counting those lines.
    code, count = vm.command(rf"""set -e
grep -Eq '^ *disable_crc_filter *= *false *$' /var/etc/chirpstack-concentratord/concentratord.toml
logs=$(logread)
printf '%s\n' "$logs" | awk -v marker='{marker}' '
/osi-radio-suite: / && $NF == marker {{ seen=1; next }}
seen && /chirpstack-concentratord-sx1302\[[0-9]+\]: Frame received, uplink_id:/ {{ count++ }}
END {{ if (!seen) exit 1; print count+0 }}'
""")
    if code or not count.isdecimal():
        raise RuntimeError(f'Concentratord CRC_OK count unavailable (model delivered {delivered})')
    if int(count) <= 0:
        raise RuntimeError(f'Concentratord CRC_OK=0 (model delivered {delivered})')
    return f'WM1302 model delivered={delivered}, Concentratord CRC_OK={count}'


def _wait_history(vm, query, expected):
    for _ in range(45):
        if sql(vm,query)==expected:
            return
        time.sleep(2)
    raise RuntimeError('decoded observation absent from gateway history')


def configure_gateway(vm):
    checked(vm, """set -e
modprobe spidev
uci set chirpstack-concentratord.@global[0].enabled=1
uci set chirpstack-concentratord.@global[0].chipset=sx1302
uci set chirpstack-concentratord.@sx1302[0].model=seeed_wm1302
uci set chirpstack-concentratord.@sx1302[0].usb=0
uci set chirpstack-concentratord.@sx1302[0].region=US915
uci set chirpstack-concentratord.@sx1302[0].channel_plan=us915_0
uci set chirpstack-mqtt-forwarder.@mqtt[0].topic_prefix=us915_0
uci -q delete chirpstack.@network[0].enabled_regions || true
uci add_list chirpstack.@network[0].enabled_regions=us915_0
uci commit
/etc/init.d/chirpstack restart
/etc/init.d/chirpstack-concentratord restart
/etc/init.d/chirpstack-mqtt-forwarder restart
for i in $(seq 1 90); do wget -q -T 2 -O /dev/null http://127.0.0.1:8080/ && break; sleep 2; done
wget -q -T 2 -O /dev/null http://127.0.0.1:8080/
CS_PROFILE_STREGA_NAME="OSI STREGA US915" CS_PROFILE_LSN50_NAME="OSI LSN50 US915" CS_REGION=US915 node /usr/share/node-red/chirpstack-bootstrap.js >/dev/null
/etc/init.d/node-red restart
for i in $(seq 1 150); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:1880/api/me)" = 401 ] && exit 0; sleep 2; done
exit 1
""", 850)
    code, _ = vm.command("""for i in $(seq 1 30); do
    if gateway-id -c ipc:///tmp/concentratord_command | grep -Eq '^[0-9a-f]{16}$'; then
        exit 0
    fi
    sleep 1
done
exit 1""", 60)
    if code:
        raise RuntimeError('WM1302 Concentratord did not answer the gateway-ID readiness probe')


def register(vm,password):
    token=_api(vm,'POST','/auth/login',{'username':'emulator-admin','password':password})['token']
    sessions={}
    for eui,kind,name in [(VALVE,'STREGA_VALVE','Emulated valve'),(SENSOR,'DRAGINO_LSN50','Emulated soil sensor')]:
        key=secrets.token_bytes(16)
        config=dict(deveui=eui,type_id=kind,name=name,appkey=key.hex())
        if eui==VALVE: config['strega_generation']='GEN1'
        _api(vm,'POST','/api/devices',config,token)
        sessions[eui]=LoRaWAN10(bytes(8),bytes.fromhex(eui),key,devnonce=1)
    devices=_api(vm,'GET','/api/devices',token=token)
    rows=devices if isinstance(devices,list) else devices['devices']
    if not set(sessions).issubset({x['deveui'].upper() for x in rows}):
        raise RuntimeError('registered devices absent from OSI list')
    return sessions


def inject(vm,sessions):
    sock = vm.radio
    marker = _mark_crc_window(vm)
    delivered = 0
    for eui,session in sessions.items():
        delivered += _send(sock,session.join_request())
        deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            try:
                reply=_receive(sock,max(0.1,deadline-time.monotonic()))
            except TimeoutError:
                break
            if reply[:1]==b'\x20':
                session.accept_join(reply)
                break
        if session.devaddr is None:
            evidence = _radio_evidence(vm, marker, delivered)
            raise RuntimeError(f'{eui}: join-accept absent ({evidence})')
        delivered += _send(sock, session.uplink(STREGA if eui==VALVE else LSN50,1,fport=4 if eui==VALVE else 11))
        query = (f"SELECT EXISTS(SELECT 1 FROM device_data WHERE upper(deveui)='{eui}' AND bat_pct=100);" if eui==VALVE else
                 f"SELECT EXISTS(SELECT 1 FROM watermark_readings WHERE upper(deveui)='{eui}' AND soil_temp_c=12.5);")
        _wait_history(vm,query,'1')
    return _radio_evidence(vm, marker, delivered)


def run_uplinks(vm,password):
    configure_gateway(vm)
    sessions = register(vm, password)
    return sessions, inject(vm, sessions)


def run_valve(vm, session, gui_open):
    if VALVE not in session:
        raise RuntimeError('no authenticated valve radio session')
    valve=session[VALVE]
    sock = vm.radio
    marker = _mark_crc_window(vm)
    gui_open()
    try: _receive(sock,2)
    except TimeoutError: pass
    else: raise RuntimeError('valve downlink before receive window')
    delivered = _send(sock,valve.uplink(STREGA,2,fport=4))
    command=valve.downlink(_receive(sock,40))
    if command['fport'] != 2 or command['payload'] != bytes.fromhex('4101'):
        raise RuntimeError('timed-open downlink payload mismatch')
    opened=bytearray(STREGA)
    opened[4]=0x75
    delivered += _send(sock,valve.uplink(bytes(opened),3,fport=4))
    _wait_history(vm,f"SELECT current_state FROM devices WHERE upper(deveui)='{VALVE}';",'OPEN')
    _wait_history(vm,f"SELECT EXISTS(SELECT 1 FROM valve_actuation_expectations WHERE upper(device_eui)='{VALVE}' AND commanded_duration_seconds=60 AND (observed_open_at IS NOT NULL OR json_type(transport_json,'$.untrusted_report.open')='object'));",'1')
    return _radio_evidence(vm, marker, delivered)
