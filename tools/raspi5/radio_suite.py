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


@dataclass(frozen=True)
class Channel:
    """Frequency, bandwidth and spreading factor the WM1302 model sends on.

    Concentratord prints bandwidth in Hz and the data rate as SFn, so the
    receipt compares those spellings.
    """
    frequency: int
    bandwidth: int
    sf: int

    def __str__(self):
        return f'{self.frequency} Hz, {self.bandwidth} Hz, SF{self.sf}'


# run.rf_frame bandwidth codes.
BANDWIDTH_CODES = {125000: 0}
# Every injected uplink uses US915 channel 0.
UPLINK = Channel(902300000, 125000, 7)
CHIRPSTACK_DB = '/srv/chirpstack/chirpstack.sqlite'
PERSISTENT_LOG = '/data/log/osi-system.log'
# US915 join-accept delays after the join-request (RX1, RX2), in count_us.
JOIN_ACCEPT_DELAYS = (5000000, 6000000)
# The SX1302 count_us counter is 32 bits wide; the HAL's packet counter has
# 27 bits before it adds its wrap bits.
COUNTER_WRAP = 1 << 32
HAL_COUNTER_WRAP = 1 << 27
# The HAL's legacy timestamp correction for a 125 kHz frame: about 0.46 ms at
# SF7 and 15.4 ms at SF12.
MAX_HAL_CORRECTION_US = 20000

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
        self.last_stamp = None   # 32 MHz timestamp of the last delivered frame

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

    def send(self, frame, channel=UPLINK):
        request_id = secrets.token_bytes(RF_REQUEST_ID_SIZE)
        deadline = time.monotonic() + RECEIPT_TIMEOUT
        try:
            self.sock.settimeout(RECEIPT_TIMEOUT)
            self.sock.sendall(rf_frame(frame, channel.frequency, BANDWIDTH_CODES[channel.bandwidth],
                                       sf=channel.sf, request_id=request_id))
            while True:
                channel, sf, payload = self._packet(deadline)
                if channel != RF_RECEIPT_CHANNEL:
                    self.downlinks.append(payload)
                    continue
                # Request ID, delivered count, then the big-endian 32 MHz
                # timestamp the model stamped on the frame.
                if sf != 0 or len(payload) != RF_REQUEST_ID_SIZE + 5:
                    raise RuntimeError('invalid WM1302 model delivery receipt (check the QEMU build)')
                if payload[:RF_REQUEST_ID_SIZE] != request_id:
                    continue
                count = payload[RF_REQUEST_ID_SIZE]
                if count == 0:
                    raise RuntimeError('WM1302 model delivered zero frames (uplink rejected by RX FIFO)')
                if count != 1:
                    raise RuntimeError('invalid WM1302 model delivery count')
                self.last_stamp = int.from_bytes(payload[RF_REQUEST_ID_SIZE + 1:], 'big')
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


@dataclass(frozen=True)
class Marker:
    """An attempt marker and where the persistent log stood just before it."""
    id: str
    inode: str      # active file's inode, or '-' when the file did not exist
    offset: int     # active file's size in bytes


def _mark_attempt(vm):
    """Snapshot the active persistent log, then write a syslog marker."""
    marker = secrets.token_hex(8)
    snapshot = checked(vm, f"""# attempt-marker
f={PERSISTENT_LOG}
if [ -e "$f" ]; then set -- $(ls -i "$f"); ino=$1; size=$(wc -c < "$f"); else ino=-; size=0; fi
logger -t osi-radio-suite {marker}
echo "$ino $size\"""").split()
    if len(snapshot) != 2 or not (snapshot[0] == '-' or snapshot[0].isdecimal()) or not snapshot[1].isdecimal():
        raise RuntimeError('persistent log snapshot unreadable at the attempt marker')
    return Marker(marker, snapshot[0], int(snapshot[1]))


@dataclass(frozen=True)
class Downlink:
    kind: str       # enqueue, tx, too-old or too-late
    id: str
    count: int      # the packet's scheduled concentrator count_us
    current: int | None


@dataclass
class Frames:
    """Concentratord lines inside one closed attempt window."""
    matched: list = field(default_factory=list)    # (uplink ID, count_us) at the sent channel
    other: list = field(default_factory=list)      # (uplink ID, freq, bw, dr) elsewhere
    downlinks: list = field(default_factory=list)  # Downlink entries
    marked: bool = False
    ram_matched: int = 0                           # RAM ring fallback, diagnostic only
    error: str = ''


def _concentratord_frames(vm, marker, channel=UPLINK):
    # Concentratord logs "Frame received" at INFO only after its CRC filter
    # (chirpstack-concentratord-sx1302 4.4.8, src/handler/uplink.rs), so with
    # disable_crc_filter=false each line is a CRC-valid frame. Its JIT queue
    # (libconcentratord/src/jitqueue.rs) logs each downlink it enqueues, sends
    # or drops. Both sinks use five timestamp fields, then facility.level, tag
    # and message.
    #
    # The window opens at the attempt marker and closes at an end marker
    # written now. The read starts at the snapshot taken before the marker and
    # follows that file across a rotation into the active file; a rotation
    # during the read repeats it. The read waits up to 10 s for the end marker
    # to reach the file. Only the persistent log counts; the RAM ring is read
    # for the failure message.
    code, output = vm.command(rf"""grep -Eq '^ *disable_crc_filter *= *false *$' /var/etc/chirpstack-concentratord/concentratord.toml || {{ echo crc-filter-off; exit 0; }}
inode() {{ if [ -e "$1" ]; then set -- $(ls -i "$1"); echo "$1"; fi; }}
window_logs() {{
    started=0
    [ '{marker.inode}' = - ] && started=1
    for file in {PERSISTENT_LOG}?* {PERSISTENT_LOG}; do
        [ -r "$file" ] || continue
        if [ "$started" = 1 ]; then
            cat "$file" || return 3
        elif [ "$(inode "$file")" = '{marker.inode}' ]; then
            started=1
            tail -c +{marker.offset + 1} "$file" || return 3
        fi
    done
    [ "$started" = 1 ]
}}
layout() {{ echo "$(inode {PERSISTENT_LOG}.old) $(inode {PERSISTENT_LOG})"; }}
# 0: complete read of a stable layout; 1: a stable layout lost the tracked
# inode; 2: the layout changed during every read; 3: a file read failed.
collect() {{
    for try in 1 2 3; do
        before=$(layout)
        logs=$(window_logs); rc=$?
        [ "$before" = "$(layout)" ] && return $rc
    done
    return 2
}}
frames() {{
    awk -v marker='{marker.id}' -v freq='{channel.frequency}' -v bw='{channel.bandwidth}' -v dr='SF{channel.sf}' '
    function value(key,    i, v) {{
        for (i = 8; i < NF; i++) if ($i == key) {{ v = $(i + 1); sub(/,$/, "", v); return v }}
        return "-"
    }}
    $6 == "user.notice" && $7 == "osi-radio-suite:" && NF == 8 {{
        if ($8 == marker) marked = seen = 1
        else {{ if ($8 == marker "-end") closed = 1; seen = 0 }}
        next
    }}
    !seen || $7 !~ /^chirpstack-concentratord-sx1302\[[0-9]+\]:$/ {{ next }}
    $6 == "user.info" && $8 == "Frame" && $9 == "received," && $10 == "uplink_id:" {{
        id = value("uplink_id:")
        if (id !~ /^[0-9]+$/ || id in uplinks) next
        uplinks[id] = 1
        if (value("freq:") == freq && value("bw:") == bw && value("dr:") == dr) print "match", id, value("count_us:")
        else print "other", id, value("freq:"), value("bw:"), value("dr:")
        next
    }}
    $8 == "Enqueueing" && $9 == "timestamped" {{ print "dl enqueue", value("downlink_id:"), value("counter_us:"), value("current_counter_us:"); next }}
    $8 == "Scheduled" && $9 == "packet" && $10 == "for" {{ print "dl tx", value("downlink_id:"), value("count_us:"), "-"; next }}
    $8 == "Scheduled" && $9 == "packet" && $10 == "is" && $11 == "too" && $12 == "old," {{ print "dl too-old -", value("count_us:"), value("current_counter_us:"); next }}
    $8 == "Too" && $9 == "late" && $10 == "to" && $11 == "enqueue" {{ print "dl too-late", value("downlink_id:"), value("counter_us:"), value("current_counter_us:") }}
    END {{ print(marked ? "marked" : "unmarked"); if (closed) print "closed" }}'
}}
logger -t osi-radio-suite {marker.id}-end
for i in 1 2 3 4 5 6 7 8 9 10; do
    collect; rc=$?
    [ "$rc" = 1 ] && {{ echo rotated-away; exit 0; }}
    [ "$rc" = 3 ] && {{ echo read-failed; exit 0; }}
    [ "$rc" = 0 ] && printf '%s\n' "$logs" | grep -q ' osi-radio-suite: {marker.id}-end$' && break
    sleep 1
done
[ "$rc" = 2 ] && {{ echo rotating; exit 0; }}
printf '%s\n' "$logs" | frames
printf 'ram %s\n' "$(logread 2>/dev/null | frames | grep -c '^match ')"
""")
    frames = Frames()
    if code:
        frames.error = 'persistent log unreadable'
        return frames
    closed = False
    for line in output.splitlines():
        words = line.split()
        if words == ['crc-filter-off']:
            frames.error = 'disable_crc_filter is not false, so a logged frame does not prove a valid CRC'
        elif words == ['rotated-away']:
            frames.error = 'persistent log rotated past the attempt marker before the evidence was read'
        elif words == ['rotating']:
            frames.error = 'persistent log rotated during every read'
        elif words == ['read-failed']:
            frames.error = 'persistent log read failed'
        elif words[:1] == ['match'] and len(words) == 3 and words[2].isdecimal():
            frames.matched.append((words[1], int(words[2])))
        elif words[:1] == ['other'] and len(words) >= 2:
            frames.other.append(tuple(words[1:]))
        elif words[:1] == ['dl'] and len(words) == 5 and words[3].isdecimal():
            frames.downlinks.append(Downlink(words[1], words[2], int(words[3]),
                                             int(words[4]) if words[4].isdecimal() else None))
        elif words == ['marked']:
            frames.marked = True
        elif words == ['closed']:
            closed = True
        elif words[:1] == ['ram'] and len(words) == 2 and words[1].isdecimal():
            frames.ram_matched = int(words[1])
    if not frames.error and frames.marked and not closed:
        frames.error = 'end marker did not reach the persistent log within 10 s'
    return frames


def _window_part(frames):
    """Return the missing reason shared by every receipt read from one window."""
    if frames.error:
        return frames.error
    if not frames.marked:
        return 'attempt marker absent from the persistent log'
    return None


def _bound_to_stamp(count, stamp):
    """Whether a logged count_us comes from the frame the model stamped.

    The HAL takes the model's 32 MHz timestamp / 32 as a 27-bit microsecond
    count, adds its own wrap bits and subtracts a decoding delay
    (sx1302_hal 2.1.0 loragw_sx1302.c, legacy_timestamp_correction).
    """
    return (stamp // 32 - count) % HAL_COUNTER_WRAP <= MAX_HAL_CORRECTION_US


def _join_frame(frames, stamp, channel=UPLINK):
    """Find the frame of this join-request for receipt part (a).

    The frame must be at the sent channel and carry the count_us the HAL
    derived from the model's timestamp for this request. A downlink that
    Concentratord enqueued, sent or dropped JOIN_ACCEPT_DELAYS after it
    (RX1, then RX2) corroborates it. Returns (text, missing reason, scheduled
    count_us of the corroborating downlink or None).
    """
    missing = _window_part(frames)
    if missing:
        return None, missing, None
    if stamp is None:
        return None, 'the WM1302 model receipt carried no timestamp', None
    for uplink, count in frames.matched:
        if not _bound_to_stamp(count, stamp):
            continue
        text = f'Concentratord uplink_id {uplink} (count_us {count}) at {channel}, model stamp {stamp}'
        for delay in JOIN_ACCEPT_DELAYS:
            scheduled = (count + delay) % COUNTER_WRAP
            if any(d.count == scheduled for d in frames.downlinks):
                return f'{text}, join-accept scheduled +{delay // 1000000} s', None, scheduled
        return f'{text}, no join-accept downlink logged', None, None
    if frames.matched:
        uplinks = ', '.join(f'{uplink} (count_us {count})' for uplink, count in frames.matched)
        return None, (f'no Concentratord frame carries the model stamp {stamp} '
                      f'(count_us {stamp // 32 % HAL_COUNTER_WRAP} mod 2^27, less up to '
                      f'{MAX_HAL_CORRECTION_US} us); frames at {channel}: uplink_id {uplinks}'), None
    if frames.other:
        uplink, *seen = frames.other[0]
        return None, f'Concentratord uplink_id {uplink} at freq/bw/dr {"/".join(seen)}, expected {channel}', None
    reason = 'no Concentratord "Frame received" line in the attempt window of the persistent log'
    if frames.ram_matched:
        reason += f' (RAM ring has {frames.ram_matched})'
    return None, reason, None


def _signed_us(value):
    """Interpret a 32-bit counter difference as signed microseconds."""
    value %= COUNTER_WRAP
    return value - COUNTER_WRAP if value >= COUNTER_WRAP // 2 else value


def _join_accept_fate(frames, scheduled):
    """Say what Concentratord did with this join's downlink, or None."""
    events = [d for d in frames.downlinks if d.count == scheduled]
    for event in events:
        if event.kind == 'too-old' and event.current is not None:
            late = _signed_us(event.current - scheduled) / 1000
            return f'join-accept dropped by concentratord: too old, {late:.1f} ms after its TX time'
        if event.kind == 'too-late' and event.current is not None:
            lead = _signed_us(scheduled - event.current) / 1000
            if lead < 0:
                return (f'join-accept refused by concentratord at enqueue: too late, '
                        f'{-lead:.1f} ms past its TX time')
            return (f'join-accept refused by concentratord at enqueue: too late, '
                    f'only {lead:.1f} ms lead time')
    sent = [d for d in events if d.kind == 'tx']
    if sent:
        return f'Concentratord scheduled the join-accept for TX (downlink_id {sent[0].id})'
    return None


@dataclass(frozen=True)
class ChirpStackState:
    nonces: tuple = ()          # DevNonces recorded for this DevEUI and JoinEUI
    dev_addr: str | None = None
    join_nonce: int | None = None
    error: str = ''


def _chirpstack_state(vm, dev_eui, join_eui):
    """Read ChirpStack's join state for one DevEUI for receipt part (b).

    ChirpStack 4.12.1 writes no log line in these images, so the receipt reads
    its database. Its join handler (src/uplink/join.rs) stores the DevNonce and
    increments the JoinNonce only after the MIC check, and writes the DevAddr
    before it sends the join-accept. Never selects key columns.
    """
    if not (re.fullmatch(r'[0-9A-Fa-f]{16}', dev_eui) and re.fullmatch(r'[0-9a-f]{16}', join_eui)):
        raise ValueError('invalid join identifiers')
    code, output = vm.command(f"""sqlite3 -readonly -batch -bail -cmd '.timeout 5000' {CHIRPSTACK_DB} <<'SQL'
SELECT coalesce((SELECT j.value FROM device_keys k, json_each(k.dev_nonces) j
                 WHERE k.dev_eui = x'{dev_eui}' AND lower(j.key) = '{join_eui}'), '[]')
       || ' ' || coalesce((SELECT nullif(hex(dev_addr), '') FROM device WHERE dev_eui = x'{dev_eui}'), '-')
       || ' ' || coalesce((SELECT join_nonce FROM device_keys WHERE dev_eui = x'{dev_eui}'), '-');
SQL""")
    words = output.split()
    try:
        if code or len(words) != 3:
            raise ValueError
        nonces = json.loads(words[0])
        if not isinstance(nonces, list) or not all(isinstance(n, int) for n in nonces):
            raise ValueError
    except ValueError:
        return ChirpStackState(error='ChirpStack database unreadable')
    return ChirpStackState(tuple(nonces), None if words[1] == '-' else words[1].upper(),
                           int(words[2]) if words[2].isdecimal() else None)


def _chirpstack_part(before, after, dev_eui, devnonce, accept):
    """Return (receipt text, missing reason) for receipt part (b).

    before and after are ChirpStack states read just before the send and when
    the evidence is collected. accept is the verified join-accept's (DevAddr
    hex, JoinNonce) or None.
    """
    if before.error or after.error:
        return None, before.error or after.error
    if devnonce in before.nonces:
        return None, f'ChirpStack already had DevNonce {devnonce} for {dev_eui} before the send'
    if devnonce not in after.nonces:
        return None, f'ChirpStack recorded no DevNonce {devnonce} for {dev_eui} after the send'
    if before.join_nonce is None or after.join_nonce != before.join_nonce + 1:
        return None, f'ChirpStack JoinNonce did not advance by one (before {before.join_nonce}, after {after.join_nonce})'
    if after.dev_addr is None or after.dev_addr == before.dev_addr:
        return None, f'ChirpStack DevAddr did not change (before {before.dev_addr}, after {after.dev_addr})'
    if accept is not None:
        dev_addr, join_nonce = accept
        if after.dev_addr != dev_addr:
            return None, f'ChirpStack DevAddr {after.dev_addr} differs from join-accept DevAddr {dev_addr}'
        # ChirpStack 4.12.1 stores the incremented JoinNonce and sends the
        # stored value minus one (src/uplink/join.rs), the pre-send value.
        if join_nonce != before.join_nonce:
            return None, (f'join-accept JoinNonce {join_nonce} differs from ChirpStack\'s pre-send '
                          f'JoinNonce {before.join_nonce}')
    return (f'ChirpStack DevNonce {devnonce} new, JoinNonce {before.join_nonce}->{after.join_nonce}, '
            f'DevAddr {before.dev_addr or "unset"}->{after.dev_addr}'), None


def _radio_evidence(vm, marker, delivered):
    if delivered <= 0:
        raise RuntimeError('WM1302 model delivered zero frames')
    frames = _concentratord_frames(vm, marker)
    missing = _window_part(frames) or (None if frames.matched else
                                       f'no Concentratord "Frame received" line at {UPLINK} in the window')
    if missing:
        raise RuntimeError(f'Concentratord frames received=0 (model delivered {delivered}): {missing}')
    return f'WM1302 model delivered={delivered}, Concentratord frames received={len(frames.matched)}'


def radio_diagnostics(vm):
    # Write fixed labels, counts and process IDs only. Application logs can
    # contain credentials; the ChirpStack query never selects key columns.
    _, counts = vm.command(PERSISTENT_LOGS + r'''count_messages() {
    awk 'BEGIN {
        n = split("Frame received, uplink_id:|Received uplink frame|Enqueueing timestamped packet|Scheduled packet for TX|Scheduled packet is too old|Too late|TX_ACK|chirpstack[|invalid MIC|unknown device|region mismatch", needles, "[|]")
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


def _join(vm, air, eui, session, log, channel=UPLINK):
    """Join one device; return (frames the model delivered, receipt line).

    Every attempt needs its own receipt: (a) a Concentratord "Frame received"
    line in the attempt's closed window at the channel the model sent, with
    the count_us derived from the model's timestamp for this request, with
    this join's downlink 5 s (RX1) or 6 s (RX2) later as corroboration; (b)
    the change in ChirpStack's state across the send: the new DevNonce, the
    stored JoinNonce advanced by one and a new DevAddr, with the join-accept
    carrying that DevAddr and the pre-send JoinNonce; (c) the join-accept at the emulated device inside the join
    window. An attempt with (a) and (b) whose join-accept is late, absent or
    dropped by Concentratord is retried with a fresh DevNonce (#736). Any
    other missing part fails the case at once.
    """
    def is_join_accept(packet):
        return packet[:1] == b'\x20'

    delivered = 0
    join_eui = session.app_eui.hex()
    for attempt in range(1, JOIN_ATTEMPTS + 1):
        if attempt > 1:
            session.devnonce += 1
        devnonce = session.devnonce
        before = _chirpstack_state(vm, eui, join_eui)
        marker = _mark_attempt(vm)
        frame = session.join_request()
        sent = time.monotonic()
        delivered += air.send(frame, channel)
        stamp = air.last_stamp
        accept = accept_missing = accepted = None
        retryable = False
        try:
            reply = air.receive(max(0, sent + JOIN_WINDOW - time.monotonic()), is_join_accept)
        except TimeoutError:
            # Drain a wrapped join-accept before sending a fresh DevNonce.
            retryable = True
            try:
                air.receive(max(0, sent + JOIN_DRAIN_WINDOW - time.monotonic()), is_join_accept)
                accept_missing = f'join-accept late after {time.monotonic() - sent:.2f} s (drained)'
            except TimeoutError:
                accept_missing = f'join-accept absent after {time.monotonic() - sent:.2f} s'
        else:
            delay = time.monotonic() - sent
            if delay > JOIN_WINDOW:
                retryable = True
                accept_missing = f'join-accept late after {delay:.2f} s (drained)'
            else:
                try:
                    fields = session.accept_join(reply)
                    accepted = (f'{fields["devaddr"]:08X}', int.from_bytes(fields['appnonce'], 'little'))
                    accept = f'join-accept after {delay:.2f} s'
                except ValueError as exc:
                    accept_missing = f'join-accept after {delay:.2f} s failed verification: {exc}'

        frames = _concentratord_frames(vm, marker, channel)
        frame_text, frame_missing, scheduled = _join_frame(frames, stamp, channel)
        if accept_missing and scheduled is not None:
            fate = _join_accept_fate(frames, scheduled)
            if fate:
                accept_missing = f'{fate}; {accept_missing}'
        after = _chirpstack_state(vm, eui, join_eui)
        chirpstack_text, chirpstack_missing = _chirpstack_part(before, after, eui, devnonce, accepted)
        parts = [('frame', frame_text, frame_missing), ('chirpstack', chirpstack_text, chirpstack_missing),
                 ('join-accept', accept, accept_missing)]
        missing = [name for name, _, reason in parts if reason]
        verdict = 'received' if not missing else 'missing ' + ', '.join(missing)
        details = '; '.join(f'{name}: {text}' if text else f'{name}: MISSING ({reason})'
                            for name, text, reason in parts)
        line = (f'{eui} join attempt {attempt}/{JOIN_ATTEMPTS} (DevNonce {devnonce}, sent {channel}): '
                f'{verdict} | {details}')
        log(line)
        if not missing:
            return delivered, line
        if missing != ['join-accept'] or not retryable:
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
