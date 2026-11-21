"""End-to-end radio acceptance against the disposable raspi5 guest."""
from __future__ import annotations

import json
import os
import secrets
import socket
import time
import urllib.error
import urllib.request

from lorawan import LoRaWAN10
from run import rf_frame
from upgrade_suite import checked, sql

VALVE = 'A840410000000001'
SENSOR = 'A840410000000002'
STREGA = bytes.fromhex('333630377423ffffffff23')
LSN50 = bytes.fromhex('A2030CE404E209290220080008000800080021FFFFFFFF08000800')


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


def _radio(vm):
    # The kernel limits AF_UNIX addresses to 108 bytes. QEMU binds a relative
    # name in the guest workspace and this short alias reaches the same socket.
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(20)
    try:
        directory = os.open(vm.work, os.O_RDONLY | os.O_DIRECTORY)
        try:
            sock.connect(f'/proc/self/fd/{directory}/radio')
        finally:
            os.close(directory)
    except BaseException:
        sock.close()
        raise
    return sock


def _receive(sock, timeout=20):
    sock.settimeout(timeout)
    def exact(n):
        data = bytearray()
        while len(data) < n:
            part = sock.recv(n-len(data))
            if not part:
                raise RuntimeError('radio disconnected')
            data.extend(part)
        return bytes(data)
    length, _, _ = exact(3)
    return exact(length)


def _send(sock, frame):
    sock.sendall(rf_frame(frame, 902300000))


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
for i in $(seq 1 90); do test -S /tmp/concentratord_command && wget -q -O /dev/null http://127.0.0.1:8080/ && break; sleep 2; done
test -S /tmp/concentratord_command
CS_PROFILE_STREGA_NAME="OSI STREGA US915" CS_PROFILE_LSN50_NAME="OSI LSN50 US915" CS_REGION=US915 node /usr/share/node-red/chirpstack-bootstrap.js >/dev/null
/etc/init.d/node-red restart
for i in $(seq 1 150); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:1880/api/me)" = 401 ] && exit 0; sleep 2; done
exit 1
""", 850)


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
    with _radio(vm) as sock:
        for eui,session in sessions.items():
            _send(sock,session.join_request())
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
                raise RuntimeError(f'{eui}: join-accept absent')
            _send(sock, session.uplink(STREGA if eui==VALVE else LSN50,1,fport=4 if eui==VALVE else 11))
            query = (f"SELECT EXISTS(SELECT 1 FROM device_data WHERE upper(deveui)='{eui}' AND bat_pct=100);" if eui==VALVE else
                     f"SELECT EXISTS(SELECT 1 FROM watermark_readings WHERE upper(deveui)='{eui}' AND soil_temp_c=12.5);")
            _wait_history(vm,query,'1')
    return sessions


def run_uplinks(vm,password):
    configure_gateway(vm)
    return inject(vm, register(vm,password))


def run_valve(vm,password,session,gui_open):
    if VALVE not in session:
        raise RuntimeError('no authenticated valve radio session')
    valve=session[VALVE]
    with _radio(vm) as sock:
        gui_open()
        try: _receive(sock,2)
        except TimeoutError: pass
        else: raise RuntimeError('valve downlink before receive window')
        _send(sock,valve.uplink(STREGA,2,fport=4))
        command=valve.downlink(_receive(sock,40))
        if command['fport'] != 2 or command['payload'] != bytes.fromhex('4101'):
            raise RuntimeError('timed-open downlink payload mismatch')
        opened=bytearray(STREGA)
        opened[4]=0x75
        _send(sock,valve.uplink(bytes(opened),3,fport=4))
        _wait_history(vm,f"SELECT current_state FROM devices WHERE upper(deveui)='{VALVE}';",'OPEN')
        _wait_history(vm,f"SELECT EXISTS(SELECT 1 FROM valve_actuation_expectations WHERE upper(device_eui)='{VALVE}' AND commanded_duration_seconds=60 AND (observed_open_at IS NOT NULL OR json_type(transport_json,'$.untrusted_report.open')='object'));",'1')
