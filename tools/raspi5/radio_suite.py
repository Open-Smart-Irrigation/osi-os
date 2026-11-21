"""End-to-end radio acceptance against the disposable raspi5 guest."""
from __future__ import annotations

from collections import deque
import json
import secrets
import time
import urllib.error
import urllib.request

from lorawan import LoRaWAN10
from run import RF_RECEIPT_CHANNEL, RF_REQUEST_ID_SIZE, rf_frame
from upgrade_suite import checked, sql

VALVE = 'A840410000000001'
SENSOR = 'A840410000000002'
STREGA = bytes.fromhex('333630377423ffffffff23')
LSN50 = bytes.fromhex('A2030CE404E209290220080008000800080021FFFFFFFF08000800')
RECEIPT_TIMEOUT = 10
EARLY_WINDOW_TIMEOUT = 2


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


class Radio:
    def __init__(self, sock):
        self.sock = sock
        self.buffer = bytearray()
        self.downlinks = deque()

    def _packet(self, deadline=None):
        while True:
            remaining = 0 if deadline is None else deadline - time.monotonic()
            if deadline is not None and remaining <= 0:
                raise TimeoutError('radio receive deadline expired')
            if len(self.buffer) >= 3 and len(self.buffer) >= 3 + self.buffer[0]:
                length, channel, sf = self.buffer[:3]
                payload = bytes(self.buffer[3:3 + length])
                del self.buffer[:3 + length]
                if channel not in (0, 1, RF_RECEIPT_CHANNEL):
                    raise RuntimeError('unexpected WM1302 packet channel')
                return channel, sf, payload
            self.sock.settimeout(remaining)
            part = self.sock.recv(4096)
            if not part:
                raise ConnectionError('radio disconnected')
            self.buffer.extend(part)

    def begin_case(self):
        self.downlinks.clear()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            try:
                self._packet()
            except BlockingIOError:
                if not self.buffer:
                    return
                # Complete a partially read pre-case packet so its tail
                # cannot be mistaken for a new header.
                try:
                    self._packet(deadline)
                except TimeoutError as exc:
                    raise RuntimeError('incomplete WM1302 packet at the case boundary') from exc
        raise RuntimeError('could not drain pending WM1302 packets before the case')

    def send(self, frame):
        request_id = secrets.token_bytes(RF_REQUEST_ID_SIZE)
        deadline = time.monotonic() + RECEIPT_TIMEOUT
        try:
            self.sock.settimeout(RECEIPT_TIMEOUT)
            self.sock.sendall(rf_frame(frame, 902300000, request_id=request_id))
            while True:
                channel, sf, payload = self._packet(deadline)
                if channel != RF_RECEIPT_CHANNEL:
                    self.downlinks.append(payload)
                    continue
                if sf != 0 or len(payload) != RF_REQUEST_ID_SIZE + 1:
                    raise RuntimeError('invalid WM1302 model delivery receipt (check the QEMU build)')
                if payload[:-1] != request_id:
                    continue
                if payload[-1] == 0:
                    raise RuntimeError('WM1302 model delivered zero frames (uplink rejected by RX FIFO)')
                if payload[-1] != 1:
                    raise RuntimeError('invalid WM1302 model delivery count')
                return 1
        except OSError as exc:
            raise RuntimeError('no matching WM1302 model delivery receipt (radio socket timed out or disconnected)') from exc

    def receive(self, timeout, matches):
        deadline = time.monotonic() + timeout
        while self.downlinks:
            payload = self.downlinks.popleft()
            if matches(payload):
                return payload
        while True:
            channel, _, payload = self._packet(deadline)
            if channel != RF_RECEIPT_CHANNEL and matches(payload):
                return payload


def _mark_crc_window(vm):
    marker = secrets.token_hex(8)
    checked(vm, f'logger -t osi-radio-suite {marker}')
    return marker


def _radio_evidence(vm, marker, delivered):
    if delivered <= 0:
        raise RuntimeError('WM1302 model delivered zero frames')
    # logread emits five timestamp fields, then facility.level, tag and
    # message. Concentratord emits this message after the CRC filter.
    code, count = vm.command(rf"""set -e
grep -Eq '^ *disable_crc_filter *= *false *$' /var/etc/chirpstack-concentratord/concentratord.toml
logs=$(logread)
printf '%s\n' "$logs" | awk -v marker='{marker}' '
$6 == "user.notice" && $7 == "osi-radio-suite:" && $8 == marker && NF == 8 {{ seen=1; next }}
seen && $6 == "user.info" && $7 ~ /^chirpstack-concentratord-sx1302\[[0-9]+\]:$/ &&
    $8 == "Frame" && $9 == "received," && $10 == "uplink_id:" {{ count++ }}
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


def inject(vm, air, sessions):
    air.begin_case()
    marker = _mark_crc_window(vm)
    delivered = 0
    for eui,session in sessions.items():
        delivered += air.send(session.join_request())
        try:
            reply = air.receive(40, lambda packet: packet[:1] == b'\x20')
        except TimeoutError:
            evidence = _radio_evidence(vm, marker, delivered)
            raise RuntimeError(f'{eui}: join-accept absent ({evidence})')
        session.accept_join(reply)
        delivered += air.send(session.uplink(STREGA if eui==VALVE else LSN50,1,fport=4 if eui==VALVE else 11))
        query = (f"SELECT EXISTS(SELECT 1 FROM device_data WHERE upper(deveui)='{eui}' AND bat_pct=100);" if eui==VALVE else
                 f"SELECT EXISTS(SELECT 1 FROM watermark_readings WHERE upper(deveui)='{eui}' AND soil_temp_c=12.5);")
        _wait_history(vm,query,'1')
    return _radio_evidence(vm, marker, delivered)


def run_uplinks(vm, air, password):
    configure_gateway(vm)
    sessions = register(vm, password)
    return sessions, inject(vm, air, sessions)


def run_valve(vm, air, session, gui_open):
    if VALVE not in session:
        raise RuntimeError('no authenticated valve radio session')
    valve=session[VALVE]
    valve_addr = valve.devaddr.to_bytes(4, 'little')

    def valve_command(packet):
        if len(packet) < 13 or packet[0] >> 5 not in (3, 5) or packet[1:5] != valve_addr:
            return False
        port_offset = 8 + (packet[5] & 15)
        return port_offset < len(packet) - 4 and packet[port_offset] == 2

    air.begin_case()
    marker = _mark_crc_window(vm)
    gui_open()
    try: air.receive(EARLY_WINDOW_TIMEOUT, valve_command)
    except TimeoutError: pass
    else: raise RuntimeError('valve downlink before receive window')
    delivered = air.send(valve.uplink(STREGA,2,fport=4))
    command=valve.downlink(air.receive(40, valve_command))
    if command['payload'] != bytes.fromhex('4101'):
        raise RuntimeError('timed-open downlink payload mismatch')
    opened=bytearray(STREGA)
    opened[4]=0x75
    delivered += air.send(valve.uplink(bytes(opened),3,fport=4))
    _wait_history(vm,f"SELECT current_state FROM devices WHERE upper(deveui)='{VALVE}';",'OPEN')
    _wait_history(vm,f"SELECT EXISTS(SELECT 1 FROM valve_actuation_expectations WHERE upper(device_eui)='{VALVE}' AND commanded_duration_seconds=60 AND (observed_open_at IS NOT NULL OR json_type(transport_json,'$.untrusted_report.open')='object'));",'1')
    return _radio_evidence(vm, marker, delivered)
