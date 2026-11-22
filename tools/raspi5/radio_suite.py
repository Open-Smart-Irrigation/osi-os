"""End-to-end radio acceptance against the disposable raspi5 guest."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import json
import re
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
JOIN_WINDOW = 40
# A late SX1302 TX trigger can wait a full 32-bit wrap at 32 MHz (~134 s).
JOIN_DRAIN_WINDOW = 150
JOIN_ATTEMPTS = 3
# Every injected uplink uses US915 channel 0. Concentratord prints bandwidth in
# Hz and the data rate as SFn, so the receipt compares those spellings.
UPLINK_FREQUENCY_HZ = 902300000
UPLINK_BANDWIDTH_HZ = 125000
UPLINK_SF = 7
CHIRPSTACK_DB = '/srv/chirpstack/chirpstack.sqlite'

PERSISTENT_LOGS = '''persistent_logs() {
    # Read the rotated file before the active file so a marker can span rotation.
    for file in /data/log/osi-system.log?* /data/log/osi-system.log; do
        if [ -r "$file" ]; then cat "$file"; fi
    done
}
'''


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
            self.sock.sendall(rf_frame(frame, UPLINK_FREQUENCY_HZ, sf=UPLINK_SF, request_id=request_id))
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


def _mark_attempt(vm):
    marker = secrets.token_hex(8)
    checked(vm, f'logger -t osi-radio-suite {marker}')
    return marker


@dataclass
class Frames:
    """Concentratord "Frame received" lines after one marker."""
    matched: list = field(default_factory=list)   # uplink IDs at the expected channel
    other: list = field(default_factory=list)     # (uplink ID, freq, bw, dr) elsewhere
    marked: bool = False
    ram_matched: int = 0                          # RAM ring fallback, diagnostic only
    error: str = ''


def _concentratord_frames(vm, marker, frequency=UPLINK_FREQUENCY_HZ,
                          bandwidth=UPLINK_BANDWIDTH_HZ, sf=UPLINK_SF):
    # Concentratord logs "Frame received" at INFO only after its CRC filter
    # (chirpstack-concentratord-sx1302 4.4.8, src/handler/uplink.rs), so with
    # disable_crc_filter=false each line is a CRC-valid frame. Both sinks use
    # five timestamp fields, then facility.level, tag and message. Only the
    # persistent log counts; the RAM ring is read for the failure message.
    code, output = vm.command(rf"""grep -Eq '^ *disable_crc_filter *= *false *$' /var/etc/chirpstack-concentratord/concentratord.toml || {{ echo crc-filter-off; exit 0; }}
{PERSISTENT_LOGS}
frames() {{
    awk -v marker='{marker}' -v freq='{frequency}' -v bw='{bandwidth}' -v dr='SF{sf}' '
    function value(key,    i, v) {{
        for (i = 8; i < NF; i++) if ($i == key) {{ v = $(i + 1); sub(/,$/, "", v); return v }}
        return ""
    }}
    $6 == "user.notice" && $7 == "osi-radio-suite:" && $8 == marker && NF == 8 {{ marked = seen = 1; next }}
    seen && $6 == "user.info" && $7 ~ /^chirpstack-concentratord-sx1302\[[0-9]+\]:$/ &&
        $8 == "Frame" && $9 == "received," && $10 == "uplink_id:" {{
            id = value("uplink_id:")
            if (id !~ /^[0-9]+$/ || id in uplinks) next
            uplinks[id] = 1
            if (value("freq:") == freq && value("bw:") == bw && value("dr:") == dr) print "match", id
            else print "other", id, value("freq:"), value("bw:"), value("dr:")
        }}
    END {{ print(marked ? "marked" : "unmarked") }}'
}}
persistent_logs | frames
printf 'ram %s\n' "$(logread 2>/dev/null | frames | grep -c '^match ')"
""")
    frames = Frames()
    if code:
        frames.error = 'persistent log unreadable'
        return frames
    for line in output.splitlines():
        words = line.split()
        if words == ['crc-filter-off']:
            frames.error = 'disable_crc_filter is not false, so a logged frame does not prove a valid CRC'
        elif words[:1] == ['match'] and len(words) == 2:
            frames.matched.append(words[1])
        elif words[:1] == ['other'] and len(words) >= 2:
            frames.other.append(tuple(words[1:]))
        elif words == ['marked']:
            frames.marked = True
        elif words[:1] == ['ram'] and len(words) == 2 and words[1].isdecimal():
            frames.ram_matched = int(words[1])
    return frames


def _frame_part(frames):
    """Return (receipt text, missing reason) for receipt part (a)."""
    expected = f'{UPLINK_FREQUENCY_HZ} Hz, {UPLINK_BANDWIDTH_HZ} Hz, SF{UPLINK_SF}'
    if frames.error:
        return None, frames.error
    if not frames.marked:
        return None, 'attempt marker absent from the persistent log'
    if frames.matched:
        return f'Concentratord uplink_id {frames.matched[0]} at {expected}', None
    if frames.other:
        uplink, *channel = frames.other[0]
        return None, (f'Concentratord uplink_id {uplink} at freq/bw/dr {"/".join(channel)}, '
                      f'expected {expected}')
    reason = 'no Concentratord "Frame received" line after the attempt marker in the persistent log'
    if frames.ram_matched:
        reason += f' (RAM ring has {frames.ram_matched})'
    return None, reason


def _chirpstack_join(vm, dev_eui, join_eui, devnonce):
    """Read ChirpStack's own record of a join for receipt part (b).

    The image runs ChirpStack at log level "warn", so it logs no line for a
    join. ChirpStack 4.12.1 (src/uplink/join.rs) stores the DevNonce only after
    the MIC check passes, and writes the device's DevAddr before it sends the
    join-accept. Returns (DevNonce recorded, DevAddr hex or None, error).
    """
    if not (re.fullmatch(r'[0-9A-Fa-f]{16}', dev_eui) and re.fullmatch(r'[0-9a-f]{16}', join_eui)
            and 0 <= devnonce <= 65535):
        raise ValueError('invalid join identifiers')
    code, output = vm.command(f"""sqlite3 -readonly -batch -bail -cmd '.timeout 5000' {CHIRPSTACK_DB} <<'SQL'
SELECT (SELECT count(*) FROM device_keys k, json_each(k.dev_nonces) j, json_each(j.value) n
        WHERE k.dev_eui = x'{dev_eui}' AND lower(j.key) = '{join_eui}' AND n.value = {devnonce})
       || ' ' || coalesce((SELECT nullif(hex(dev_addr), '') FROM device WHERE dev_eui = x'{dev_eui}'), '-');
SQL""")
    words = output.split()
    if code or len(words) != 2 or not words[0].isdecimal():
        return False, None, 'ChirpStack database unreadable'
    return int(words[0]) > 0, None if words[1] == '-' else words[1].upper(), None


def _chirpstack_part(record, dev_eui, devnonce, accepted_addr):
    """Return (receipt text, missing reason) for receipt part (b)."""
    recorded, dev_addr, error = record
    if error:
        return None, error
    if not recorded:
        return None, f'ChirpStack has no DevNonce {devnonce} recorded for {dev_eui}'
    if accepted_addr is not None and dev_addr != accepted_addr:
        return None, f'ChirpStack DevAddr {dev_addr or "unset"} differs from join-accept DevAddr {accepted_addr}'
    return f'ChirpStack DevNonce {devnonce} recorded, DevAddr {dev_addr or "unset"}', None


def _radio_evidence(vm, marker, delivered):
    if delivered <= 0:
        raise RuntimeError('WM1302 model delivered zero frames')
    frames = _concentratord_frames(vm, marker)
    text, missing = _frame_part(frames)
    if missing:
        raise RuntimeError(f'Concentratord frames received=0 (model delivered {delivered}): {missing}')
    return f'WM1302 model delivered={delivered}, Concentratord frames received={len(frames.matched)}'


def radio_diagnostics(vm):
    # Write fixed labels, counts and process IDs only. Application logs can
    # contain credentials; the ChirpStack query never selects key columns.
    _, counts = vm.command(PERSISTENT_LOGS + r'''count_messages() {
    awk 'BEGIN {
        n = split("Frame received, uplink_id:|Received uplink frame|Enqueueing timestamped packet|Scheduled packet for TX|Too late|TX_ACK|chirpstack[|invalid MIC|unknown device|region mismatch", needles, "[|]")
        for (i = 1; i <= n; i++) patterns[i] = tolower(needles[i])
    }
    { line = tolower($0); for (i = 1; i <= n; i++) if (index(line, patterns[i])) counts[i]++ }
    END { for (i = 1; i <= n; i++) print needles[i], counts[i] + 0 }'
}
# Concentratord resets its counters after each stats publish (every 30 s), so
# one stats line covers one window. Sum the windows per process instead.
stats() {
    awk '$7 ~ /^chirpstack-concentratord-sx1302\[[0-9]+\]:$/ && $8 == "Publishing" && $9 == "stats" {
        pid = $7; sub(/^[^[]*\[/, "", pid); sub(/\].*$/, "", pid)
        rx = ""
        for (i = 10; i < NF; i++) if ($i == "rx_received:") { rx = $(i + 1); sub(/,$/, "", rx) }
        if (rx !~ /^[0-9]+$/) next
        if (!(pid in events)) order[++n] = pid
        events[pid]++; total[pid] += rx; last[pid] = rx
    }
    END { for (i = 1; i <= n; i++) { p = order[i]; print "concentratord pid " p " stats windows " events[p] " rx_received total " total[p] " last window " last[p] } }'
}
echo 'persistent /data/log/osi-system.log*'
persistent_logs | count_messages
persistent_logs | stats
echo 'logread'
logread | count_messages
echo 'chirpstack database'
sqlite3 -readonly -batch -cmd '.timeout 5000' ''' + CHIRPSTACK_DB + r''' <<'SQL' || echo 'unreadable'
SELECT 'device ' || hex(d.dev_eui) || ' devnonces '
       || (SELECT count(*) FROM device_keys k, json_each(k.dev_nonces) j, json_each(j.value) WHERE k.dev_eui = d.dev_eui)
       || ' dev_addr ' || CASE WHEN d.dev_addr IS NULL THEN 'unset' ELSE 'set' END
FROM device d ORDER BY d.dev_eui;
SQL
for svc in chirpstack chirpstack-mqtt-forwarder chirpstack-concentratord-sx1302; do
    if pidof "$svc" >/dev/null; then echo "$svc running"; fi
done''')
    (vm.receipts/'radio-diagnostics.log').write_text(counts + '\n')


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


def _join(vm, air, eui, session, log):
    """Join one device; return (frames the model delivered, receipt line).

    An attempt counts as received only with all three receipt parts: (a) a
    Concentratord "Frame received" line after the attempt marker at the
    injected channel, (b) ChirpStack's record of the attempt's DevNonce with
    the DevAddr the join-accept carries, (c) the join-accept at the emulated
    device inside the join window. Only a late or absent join-accept is
    retried, with a fresh DevNonce: a counter wrap can delay it (#736). A
    join-accept without (a) or (b) contradicts the receipt and fails at once.
    """
    def is_join_accept(packet):
        return packet[:1] == b'\x20'

    delivered = 0
    for attempt in range(1, JOIN_ATTEMPTS + 1):
        if attempt > 1:
            session.devnonce += 1
        devnonce = session.devnonce
        marker = _mark_attempt(vm)
        frame = session.join_request()
        sent = time.monotonic()
        delivered += air.send(frame)
        accept = accept_missing = accepted_addr = None
        retry = False
        try:
            reply = air.receive(max(0, sent + JOIN_WINDOW - time.monotonic()), is_join_accept)
        except TimeoutError:
            # Drain a wrapped join-accept before sending a fresh DevNonce.
            retry = True
            try:
                air.receive(max(0, sent + JOIN_DRAIN_WINDOW - time.monotonic()), is_join_accept)
                accept_missing = f'join-accept late after {time.monotonic() - sent:.2f} s (drained)'
            except TimeoutError:
                accept_missing = f'join-accept absent after {time.monotonic() - sent:.2f} s'
        else:
            delay = time.monotonic() - sent
            if delay > JOIN_WINDOW:
                retry = True
                accept_missing = f'join-accept late after {delay:.2f} s (drained)'
            else:
                try:
                    accepted_addr = f'{session.accept_join(reply)["devaddr"]:08X}'
                    accept = f'join-accept after {delay:.2f} s'
                except ValueError as exc:
                    accept_missing = f'join-accept after {delay:.2f} s failed verification: {exc}'

        frame_text, frame_missing = _frame_part(_concentratord_frames(vm, marker))
        record = _chirpstack_join(vm, eui, session.app_eui.hex(), devnonce)
        chirpstack_text, chirpstack_missing = _chirpstack_part(record, eui, devnonce, accepted_addr)
        parts = [('frame', frame_text, frame_missing), ('chirpstack', chirpstack_text, chirpstack_missing),
                 ('join-accept', accept, accept_missing)]
        missing = [name for name, _, reason in parts if reason]
        verdict = 'received' if not missing else 'missing ' + ', '.join(missing)
        details = '; '.join(f'{name}: {text}' if text else f'{name}: MISSING ({reason})'
                            for name, text, reason in parts)
        line = f'{eui} join attempt {attempt}/{JOIN_ATTEMPTS} (DevNonce {devnonce}): {verdict} | {details}'
        log(line)
        if not missing:
            return delivered, line
        if not retry:
            raise RuntimeError(f'{eui}: incomplete join receipt: {line}')
    raise RuntimeError(f'{eui}: join-accept absent after {JOIN_ATTEMPTS} attempts')


def inject(vm, air, sessions, *, log=print):
    air.begin_case()
    delivered = joins = 0
    for eui,session in sessions.items():
        join_delivered, _ = _join(vm, air, eui, session, log)
        delivered += join_delivered
        joins += 1
        delivered += air.send(session.uplink(STREGA if eui==VALVE else LSN50,1,fport=4 if eui==VALVE else 11))
        query = (f"SELECT EXISTS(SELECT 1 FROM device_data WHERE upper(deveui)='{eui}' AND bat_pct=100);" if eui==VALVE else
                 f"SELECT EXISTS(SELECT 1 FROM watermark_readings WHERE upper(deveui)='{eui}' AND soil_temp_c=12.5);")
        _wait_history(vm,query,'1')
    if not delivered:
        raise RuntimeError('WM1302 model delivered zero frames')
    return (f'WM1302 model delivered={delivered}, complete join receipts={joins} '
            '(Concentratord frame, ChirpStack DevNonce, join-accept)')


def run_uplinks(vm, air, password, *, log=print):
    configure_gateway(vm)
    sessions = register(vm, password)
    return sessions, inject(vm, air, sessions, log=log)


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
    marker = _mark_attempt(vm)
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
