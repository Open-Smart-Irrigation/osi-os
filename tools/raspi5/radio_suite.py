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
from upgrade_suite import DB, checked, sql

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
VALVE_WINDOW = JOIN_WINDOW
VALVE_DRAIN_WINDOW = JOIN_DRAIN_WINDOW
VALVE_ATTEMPTS = JOIN_ATTEMPTS
OPEN_COMMAND = (2, '4101')
OPEN_SECONDS = 60


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
VALVE_STATE = f"SELECT upper(coalesce(current_state,'')) FROM devices WHERE upper(deveui)='{VALVE}';"

PERSISTENT_LOGS = '''persistent_logs() {
    # Read the rotated file before the active file so a marker can span rotation.
    for file in /data/log/osi-system.log?* /data/log/osi-system.log; do
        if [ -r "$file" ]; then cat "$file"; fi
    done
}
'''


# Guest.command hex-encodes a reply and Guest.expect keeps the last 2,000,000
# console bytes, so the selected radio lines stay below half of that.
RADIO_LOG_LIMIT = 900000
RADIO_LOG_TRUNCATED = 'osi-radio-log-truncated'
RADIO_LOG_READ_FAILED = 3


def _radio_log(limit=RADIO_LOG_LIMIT):
    """The guest script for the radio log: newest selected lines up to limit bytes.

    A persistent log that cannot be read in full makes the script exit
    RADIO_LOG_READ_FAILED and keeps what was read. When older lines are left
    out to fit, the last line names how many.
    """
    return r"""failed=/tmp/osi-radio-log-failed.$$
rm -f "$failed"
for file in /data/log/osi-system.log?* /data/log/osi-system.log; do
    if [ -r "$file" ]; then cat "$file" || echo "$file" >> "$failed"; fi
done | awk -v limit=""" + str(int(limit)) + r""" -v mark=""" + RADIO_LOG_TRUNCATED + r""" '
    BEGIN { n = 0; first = 0; total = 0 }
    $7 == "osi-radio-suite:" || $7 ~ /^chirpstack(-concentratord-sx1302|-mqtt-forwarder)?\[[0-9]+\]:$/ {
        line[n++] = $0; total += length($0) + 1
    }
    END {
        while (total > limit && first < n) { total -= length(line[first]) + 1; first++ }
        for (i = first; i < n; i++) print line[i]
        if (first) print mark, first
    }'
if [ -s "$failed" ]; then rm -f "$failed"; exit """ + str(RADIO_LOG_READ_FAILED) + r"""; fi
rm -f "$failed"
"""


RADIO_LOG = _radio_log()


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
    commands: list = field(default_factory=list)  # IDs of the ChirpStack downlink commands the forwarder logged
    acks: list = field(default_factory=list)      # (ack items, downlink ID) the forwarder logged
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
# The stamp binding assumes the HAL's legacy timestamp correction; fine
# timestamps select another one (sx1302_hal loragw_sx1302_timestamp.c).
awk '/^[[:space:]]*\[/ {{ section = $0; gsub(/[[:space:]]/, "", section); next }}
     section == "[gateway.fine_timestamp]" && /^[[:space:]]*enable[[:space:]]*=[[:space:]]*true[[:space:]]*(#.*)?$/ {{ on = 1 }}
     END {{ exit on ? 1 : 0 }}' /var/etc/chirpstack-concentratord/concentratord.toml || {{ echo fine-timestamp-on; exit 0; }}
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
    !seen {{ next }}
    $7 ~ /^chirpstack-mqtt-forwarder\[[0-9]+\]:$/ {{
        if ($8 == "Received" && $9 == "downlink" && $10 == "command,") print "dl command", value("downlink_id:")
        else if ($8 == "Received" && $9 == "ack,") {{
            items = ""
            for (i = 10; i < NF; i++) {{ if ($i == "downlink_id:") break; items = items (items ? " " : "") $i }}
            print "dl ack", items, value("downlink_id:")
        }}
        next
    }}
    $7 !~ /^chirpstack-concentratord-sx1302\[[0-9]+\]:$/ {{ next }}
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
        elif words == ['fine-timestamp-on']:
            frames.error = ('fine timestamps are enabled ([gateway.fine_timestamp] enable = true); '
                            'the receipt assumes legacy timestamps')
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
        elif words[:2] == ['dl', 'command'] and len(words) == 3 and words[2].isdecimal():
            frames.commands.append(words[2])
        elif words[:2] == ['dl', 'ack'] and len(words) >= 4 and words[-1].isdecimal():
            frames.acks.append((' '.join(words[2:-1]).removeprefix('items: ').rstrip(','), words[-1]))
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


def _uplink_frame(frames, stamp, channel=UPLINK):
    """Find the Concentratord frame of one injection, for receipt part (a).

    The frame must be at the sent channel and carry the count_us the HAL
    derived from the model's timestamp for this request. Returns (text,
    missing reason, count_us or None).
    """
    missing = _window_part(frames)
    if missing:
        return None, missing, None
    if stamp is None:
        return None, 'the WM1302 model receipt carried no timestamp', None
    for uplink, count in frames.matched:
        if _bound_to_stamp(count, stamp):
            return f'Concentratord uplink_id {uplink} (count_us {count}) at {channel}, model stamp {stamp}', None, count
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


def _join_frame(frames, stamp, channel=UPLINK):
    """Find the frame of this join-request for receipt part (a).

    The frame must be at the sent channel and carry the count_us the HAL
    derived from the model's timestamp for this request. A downlink that
    Concentratord enqueued, sent or dropped JOIN_ACCEPT_DELAYS after it
    (RX1, then RX2) corroborates it. Returns (text, missing reason, scheduled
    count_us of the corroborating downlink or None).
    """
    text, missing, count = _uplink_frame(frames, stamp, channel)
    if missing:
        return None, missing, None
    for delay in JOIN_ACCEPT_DELAYS:
        scheduled = (count + delay) % COUNTER_WRAP
        if any(d.count == scheduled for d in frames.downlinks):
            return f'{text}, join-accept scheduled +{delay // 1000000} s', None, scheduled
    return f'{text}, no join-accept downlink logged', None, None


def _signed_us(value):
    """Interpret a 32-bit counter difference as signed microseconds."""
    value %= COUNTER_WRAP
    return value - COUNTER_WRAP if value >= COUNTER_WRAP // 2 else value


def _downlink_fate(frames, scheduled, subject, *, lead=False):
    """Say what Concentratord did with a downlink scheduled at this count_us, or None.

    With lead, a downlink it scheduled also reports how far ahead of, or past,
    its TX time Concentratord took it.
    """
    events = [d for d in frames.downlinks if d.count == scheduled]
    for event in events:
        if event.kind == 'too-old' and event.current is not None:
            late = _signed_us(event.current - scheduled) / 1000
            return f'{subject} dropped by concentratord: too old, {late:.1f} ms after its TX time'
        if event.kind == 'too-late' and event.current is not None:
            margin = _signed_us(scheduled - event.current) / 1000
            if margin < 0:
                return (f'{subject} refused by concentratord at enqueue: too late, '
                        f'{-margin:.1f} ms past its TX time')
            return (f'{subject} refused by concentratord at enqueue: too late, '
                    f'only {margin:.1f} ms lead time')
    sent = [d for d in events if d.kind == 'tx']
    if not sent:
        return None
    text = f'Concentratord scheduled the {subject} for TX (downlink_id {sent[0].id})'
    if lead:
        enqueued = [d for d in events if d.kind == 'enqueue' and d.id == sent[0].id and d.current is not None]
        if enqueued:
            margin = _signed_us(scheduled - enqueued[0].current) / 1000
            text += (f' with {margin:.1f} ms lead at enqueue' if margin >= 0
                     else f' with {-margin:.1f} ms past its TX time at enqueue')
    return text


def _join_accept_fate(frames, scheduled):
    """Say what Concentratord did with this join's downlink, or None."""
    return _downlink_fate(frames, scheduled, 'join-accept')


def rx_delays(session):
    """US915 class A receive slots after an uplink, in count_us.

    RX1 opens RXDelay1 seconds after the uplink, as the join-accept told the
    device (0 means 1 s); RX2 opens one second later. A session without that
    value cannot place its slots.
    """
    delay = getattr(session, 'rx_delay', None)
    if isinstance(delay, bool) or not isinstance(delay, int) or delay < 0:
        raise ValueError(f'the session carries no RXDelay1 (rx_delay {delay!r}), so its receive slots cannot be placed')
    delay = delay or 1
    return delay * 1000000, (delay + 1) * 1000000


@dataclass(frozen=True)
class Binding:
    """How the attempt's queue item, ChirpStack's downlink and Concentratord's handling were tied together."""

    text: str
    creditable: bool           # one ChirpStack downlink, taken in a receive slot of this uplink, with a decision on it, and the queue after in agreement with the gateway's ack
    ack_ok: bool | None = None       # the gateway acked that downlink OK; None when no ack was logged


def _bind_downlink(frames, count, delays, queue_id, kept):
    """Tie the attempt's queue item to the Concentratord downlink that carried it.

    ChirpStack answers an uplink with at most one downlink, built from the
    first usable queue item (chirpstack 4.12.1, downlink/data.rs,
    _handle_response); the check before the uplink made sure that item is the
    attempt's. The MQTT forwarder logs each downlink command with its
    downlink_id, then the gateway's ack items for it. Concentratord logs the
    downlink it took under the same ID, at which counter, and what it did with
    it. ChirpStack deletes an unconfirmed item only on an OK ack
    (downlink/tx_ack.rs), so the queue after the attempt must agree with that
    ack. A decision is credited only when every step names one and the same
    downlink ID: a TX counts only in the slot where that ID was enqueued, and
    a "too old" drop, whose line names no downlink ID, never counts.

    kept is the attempt's queue item as it stands after the attempt, or None
    once ChirpStack let go of it. ChirpStack writes f_cnt_down on an
    unencrypted item each time it builds a downlink from it (downlink/data.rs,
    update_device_queue_item), so an item still queued without one was never
    the source of a downlink. That proves this window's downlink came from the
    item only on a fresh attempt, where the item carried no f_cnt_down before
    the uplink (_valve_queued). On a re-send the counter predates the attempt,
    and the tie rests on the exact receive slot of this uplink and on
    ChirpStack building the downlink from the head of the queue; run_valve
    therefore never retries after a re-send that missed.
    """
    holds = kept is not None
    logged = sorted({event.id for event in frames.downlinks if event.id != '-'})
    if not frames.commands:
        if not logged:
            return Binding('no open-command downlink logged', False)
        return Binding(f'no ChirpStack downlink command in the window; Concentratord logged downlink IDs '
                       f'{", ".join(logged)}, none bound to queue item {queue_id}', False)
    if len(frames.commands) != 1:
        return Binding(f'{len(frames.commands)} ChirpStack downlink commands in the window '
                       f'({", ".join(frames.commands)}); none can be bound to queue item {queue_id}', False)
    downlink = frames.commands[0]
    ack = next((items for items, identifier in frames.acks if identifier == downlink), None)
    ack_ok = None if ack is None else 'OK' in re.findall(r'[A-Z_]+', ack)
    head = f'ChirpStack downlink {downlink}, ack {ack or "not logged"}'
    if count is None:
        return Binding(f'{head}: no Concentratord frame to place the receive slots', False, ack_ok)
    slots = {(count + delay) % COUNTER_WRAP: (slot, delay // 1000000)
             for slot, delay in zip(('RX1', 'RX2'), delays)}
    others = sorted(set(logged) - {downlink})
    taken = [event for event in frames.downlinks if event.id == downlink and event.kind in ('enqueue', 'too-late')]
    if not taken:
        return Binding(f'{head}: Concentratord logged no enqueue for it in RX1 +{delays[0] // 1000000} s or '
                       f'RX2 +{delays[1] // 1000000} s'
                       + (f'; its decisions are for downlink IDs {", ".join(others)}' if others else ''),
                       False, ack_ok)
    if not any(event.count in slots for event in taken):
        offsets = ', '.join(f'+{_signed_us(event.count - count) / 1000000:g} s' for event in taken)
        return Binding(f'{head}: Concentratord took it {offsets} after the frame, outside this session\'s '
                       f'RX1 at +{delays[0] // 1000000} s and RX2 at +{delays[1] // 1000000} s '
                       '(unsupported or unknown RX timing)', False, ack_ok)
    handling, decided = [], False
    enqueued = {event.count for event in taken if event.kind == 'enqueue'}
    for scheduled, (slot, seconds) in slots.items():
        for event in (event for event in frames.downlinks if event.count == scheduled):
            if event.kind == 'too-late' and event.id == downlink and event.current is not None:
                margin = _signed_us(scheduled - event.current) / 1000
                handling.append(f'Concentratord refused it at {slot} +{seconds} s: too late, ' + (
                    f'only {margin:.1f} ms lead time' if margin >= 0 else f'{-margin:.1f} ms past its TX time'))
                decided = True
            elif event.kind == 'enqueue' and event.id == downlink:
                lead = (f' with {_signed_us(scheduled - event.current) / 1000:.1f} ms lead at enqueue'
                        if event.current is not None else '')
                handling.append(f'Concentratord took it at {slot} +{seconds} s{lead}')
            elif event.kind == 'tx' and event.id == downlink:
                if scheduled in enqueued:
                    handling.append('Scheduled packet for TX')
                    decided = True
                else:
                    handling.append(f'Scheduled packet for TX at {slot} +{seconds} s, where it was not enqueued')
            elif event.kind == 'too-old' and event.current is not None:
                handling.append(f'Concentratord dropped a packet at {slot} +{seconds} s as too old, '
                                f'{_signed_us(event.current - scheduled) / 1000:.1f} ms after its TX time; '
                                'the line names no downlink ID, so it is no decision for this one')
    problems = []
    if not decided:
        problems.append('no TX or refusal logged for it')
    if holds and not kept.f_cnt:
        problems.append(f'ChirpStack still holds queue item {queue_id} with no f_cnt_down, so it built no downlink from it')
    if ack_ok and holds:
        problems.append(f'the gateway acked OK but ChirpStack still holds queue item {queue_id}')
    if ack_ok is not True and not holds:
        problems.append(f'queue item {queue_id} left ChirpStack\'s queue without an OK ack')
    return Binding(f'{head}: ' + '; '.join(handling + problems), not problems, ack_ok)

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


@dataclass(frozen=True)
class QueueItem:
    """One device_queue_item row of ChirpStack 4.12.1.

    Fields as stored: ID, FPort, payload in hex, is_pending, is_encrypted, and
    the downlink frame counter ChirpStack used for the item ('' until it built
    a downlink for it).
    """
    id: str
    f_port: str
    data: str
    pending: str
    encrypted: str
    f_cnt: str


@dataclass(frozen=True)
class QueueState:
    items: tuple = ()
    error: str = ''


@dataclass(frozen=True)
class Expectation:
    """One valve_actuation_expectations row with what its transport_json says about the queued open."""

    id: str
    state: str
    queue_id: str | None = None
    phase: str | None = None
    accepted_at: str | None = None
    f_port: str | None = None        # effect_snapshot.fPort
    payload: str | None = None       # effect_snapshot.bytes_hex, upper-cased
    seconds: int | None = None       # effect_snapshot.encoded_duration_seconds
    open_at: str = ''                # observed_open_at, as stored
    close_at: str = ''               # observed_close_at, as stored
    report: str = ''                 # untrusted_report as canonical JSON, '' when none

    def _reported(self, kind):
        report = json.loads(self.report) if self.report else None
        return isinstance(report, dict) and isinstance(report.get(kind), dict)

    @property
    def open_evidence(self):
        """An OPEN report, trusted or not, is attached."""
        return bool(self.open_at) or self._reported('open')

    @property
    def close_evidence(self):
        """A CLOSED report, trusted or not, is attached."""
        return bool(self.close_at) or self._reported('closed')


@dataclass(frozen=True)
class EdgeState:
    rows: tuple = ()
    error: str = ''


def _chirpstack_queue(vm, dev_eui):
    """Read ChirpStack's device queue for one DevEUI, oldest item first.

    The edge stores the ID ChirpStack returns for an accepted enqueue as the
    expectation's transport_json queue_id, so that ID names the row here.
    ChirpStack 4.12.1 removes an unconfirmed item once the gateway acked its
    downlink, and writes the frame counter on the item when it builds the
    downlink. Whether a refused item stays is read here, not assumed. Never
    selects key columns.
    """
    if not re.fullmatch(r'[0-9A-Fa-f]{16}', dev_eui):
        raise ValueError('invalid device identifier')
    code, output = vm.command(f"""sqlite3 -readonly -batch -bail -cmd '.timeout 5000' {CHIRPSTACK_DB} <<'SQL'
SELECT id, f_port, hex(data), is_pending, is_encrypted, coalesce(f_cnt_down, '') FROM device_queue_item WHERE dev_eui = x'{dev_eui}' ORDER BY created_at;
SQL""")
    try:
        if code:
            raise ValueError
        rows = [line.split('|') for line in output.splitlines()]
        if not all(len(row) == 6 and all(row[:5]) for row in rows):
            raise ValueError
    except ValueError:
        return QueueState(error='ChirpStack database unreadable')
    return QueueState(tuple(QueueItem(*row) for row in rows))


def _expectation(identifier, state, opened, closed, transport):
    """Build one Expectation from a hex-encoded transport_json.

    A transport_json that is not a JSON object yields the row's state and
    report times only. The times are kept as stored, so that a later read can
    be compared with this one value for value.
    """
    try:
        transport = json.loads(bytes.fromhex(transport) or b'null')
    except ValueError:
        transport = None
    if not isinstance(transport, dict):
        return Expectation(identifier, state, open_at=opened, close_at=closed)
    snapshot = transport.get('effect_snapshot')
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    report = transport.get('untrusted_report')
    report = report if isinstance(report, dict) else None
    seconds = snapshot.get('encoded_duration_seconds')
    return Expectation(
        identifier, state, transport.get('queue_id'), transport.get('phase'), transport.get('accepted_at'),
        None if snapshot.get('fPort') is None else str(snapshot['fPort']),
        None if snapshot.get('bytes_hex') is None else str(snapshot['bytes_hex']).upper(),
        seconds if isinstance(seconds, int) and not isinstance(seconds, bool) else None,
        opened, closed, json.dumps(report, sort_keys=True) if report is not None else '')


def _edge_expectations(vm, eui):
    """Read the edge's valve expectations for one DevEUI from its own database.

    transport_json travels hex-encoded, so nothing inside it can split a row.
    """
    if not re.fullmatch(r'[0-9A-Fa-f]{16}', eui):
        raise ValueError('invalid device identifier')
    code, output = vm.command(f"""sqlite3 -readonly -batch -bail -cmd '.timeout 5000' {DB} <<'SQL'
SELECT expectation_id, reconciliation_state, coalesce(observed_open_at, ''), coalesce(observed_close_at, ''),
       hex(coalesce(transport_json, '')) FROM valve_actuation_expectations WHERE upper(device_eui) = '{eui}' ORDER BY rowid;
SQL""")
    try:
        if code:
            raise ValueError
        rows = [_expectation(*line.split('|')) for line in output.splitlines()]
    except (ValueError, TypeError):
        return EdgeState(error='edge database unreadable')
    return EdgeState(tuple(rows))


def _claim(expectation):
    """The command the edge says it queued for this open: FPort and payload, as its effect snapshot records them."""
    return expectation.f_port, expectation.payload


def _valve_edge(edge, before, carried=None):
    """Name the expectation an attempt's open belongs to, or why it cannot be named.

    An attempt that issued an open takes the newest expectation the read before
    the issue did not hold. A re-send takes the expectation that carries its
    queue item. The expectation must name an accepted queue item that holds the
    timed open. Returns (text, missing reason, the Expectation or None).
    """
    if edge.error:
        return None, edge.error, None
    known = {row.id for row in before.rows}
    rows = ([row for row in edge.rows if row.queue_id == carried] if carried is not None else
            [row for row in edge.rows if row.id not in known])
    if not rows:
        return None, (f'the edge no longer records queue item {carried}' if carried is not None else
                      'the edge recorded no new valve expectation for the open'), None
    row = rows[-1]
    if row.phase != 'ACCEPTED' or not row.queue_id:
        return None, f'the edge transport phase is {row.phase} with no queue item', row
    if row.f_port is None or not row.payload:
        return None, (f'the edge recorded no FPort and payload in the effect snapshot of queue item {row.queue_id}, '
                      'so the command it queued is unknown'), row
    claim = _claim(row)
    if claim != (str(OPEN_COMMAND[0]), OPEN_COMMAND[1]):
        return None, (f'the edge queued FPort {claim[0]} payload {claim[1]} for the one-minute open, '
                      f'not FPort {OPEN_COMMAND[0]} payload {OPEN_COMMAND[1]}'), row
    return f'queue item {row.queue_id} {row.phase} at {row.accepted_at}, FPort {claim[0]} payload {claim[1]}', None, row


def _queue_item_text(item, named=True):
    """One queue item as stored; named as the receipts quote it inside a sentence."""
    return (f'{"item " if named else ""}{item.id} FPort {item.f_port} data {item.data} is_pending {item.pending} '
            f'is_encrypted {item.encrypted}' + (f' f_cnt_down {item.f_cnt}' if item.f_cnt else ''))


def _queue_items(queue):
    return '; '.join(_queue_item_text(item) for item in queue.items) or 'empty'


def _valve_queued(queue, queue_id, claim, fresh=False):
    """Say whether ChirpStack's queue holds the attempt's command, as the next item to go out.

    Returns (text, missing reason, the frame counter ChirpStack recorded for
    the item or ''). ChirpStack sends the first usable queue item, and the
    edge enqueues the timed open unencrypted, so its plaintext is comparable.
    On a fresh attempt the item must carry no f_cnt_down yet, so that one
    written during the window shows ChirpStack built this window's downlink
    from it (_bind_downlink).
    """
    if queue.error:
        return None, queue.error, ''
    held = [item for item in queue.items if item.id == queue_id]
    if not held:
        return None, f'ChirpStack does not hold queue item {queue_id} before the receive window: {_queue_items(queue)}', ''
    item = held[0]
    if item.encrypted != '0':
        return None, (f'ChirpStack holds queue item {queue_id} encrypted (is_encrypted {item.encrypted}), '
                      'so its plaintext cannot be checked'), item.f_cnt
    seen = (item.f_port, item.data.upper())
    if seen != claim:
        return None, (f'ChirpStack holds queue item {queue_id} as FPort {seen[0]} payload {seen[1]}, '
                      f'not the queued FPort {claim[0]} payload {claim[1]}'), item.f_cnt
    if item.pending != '0':
        return None, f'ChirpStack holds queue item {queue_id} pending an earlier transmission (is_pending {item.pending})', item.f_cnt
    if queue.items[0].id != queue_id:
        return None, (f'ChirpStack holds queue item {queue_id}, but queue item {queue.items[0].id} is next '
                      'for the device, and ChirpStack sends the first item of the queue'), item.f_cnt
    if fresh and item.f_cnt:
        return None, (f'ChirpStack holds the fresh queue item {queue_id} with f_cnt_down {item.f_cnt} already '
                      'written, so a downlink built from it in this window could not be told from an earlier one'), \
            item.f_cnt
    return (f'ChirpStack holds queue item {queue_id} next before the receive window: '
            f'FPort {seen[0]} payload {seen[1]} is_pending {item.pending} is_encrypted {item.encrypted}'
            + (f' f_cnt_down {item.f_cnt}' if item.f_cnt else '')), None, item.f_cnt


def _valve_queue(queue, queue_id):
    """Describe ChirpStack's device queue after an attempt; return the edge's item while it still holds it, else None."""
    if queue.error:
        return None, queue.error, None
    return f'ChirpStack queue after the attempt: {_queue_items(queue)}', None, next(
        (item for item in queue.items if item.id == queue_id), None)

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


def _captured(read, label, problems):
    """Run one evidence read. One that fails, or answers with an error, returns its state or None and adds a problem."""
    try:
        state = read()
    except Exception as error:
        problems.append(f'{label} database unreadable: {error!r}')
        return None
    if state.error:
        problems.append(state.error)
    return state


def _section(log, title, label, read, render, problems):
    """Write one evidence section: its title first, then its rows, or the marker of a read that failed."""
    log.write(title + '\n')
    log.flush()
    mark = len(problems)
    state = _captured(read, label, problems)
    failed = problems[mark:]
    if failed:
        text = '\n'.join(f'[incomplete] {problem}' for problem in failed)
    else:
        text = '\n'.join(render(state)) or 'empty'
    log.write(text + '\n')
    log.flush()


def valve_diagnostics(vm, eui=VALVE):
    """Save the guest's radio log and both queue states, each as soon as it is read.

    Returns what could not be read. Each failure is also written into its file
    as an `[incomplete]` line and noted in harness-events.log, so a pass keeps
    its verdict and still shows the gap.

    The radio log holds every Concentratord and MQTT forwarder line and every
    harness marker of the persistent logs, in order across a rotation. Node-RED
    lines and the device-profile import are left out: application logs can
    contain credentials, and the import floods the log after each Node-RED start.
    """
    problems = []
    try:
        code, radio = vm.command(RADIO_LOG)
        problem = ('a persistent log could not be read in full' if code == RADIO_LOG_READ_FAILED else
                   f'radio log read exited {code}' if code else '')
    except Exception as error:
        radio, problem = '', f'radio log unreadable: {error!r}'
    if problem:
        problems.append(problem)
    lines = radio.rstrip('\n').split('\n')
    if lines[-1].startswith(RADIO_LOG_TRUNCATED + ' '):
        radio = '\n'.join(lines[:-1])
        problems.append(f'radio log truncated: the oldest {lines[-1].split()[-1]} radio lines were left out to fit '
                        'the console reply')
        problem = '; '.join(filter(None, (problem, problems[-1])))
    (vm.receipts/'valve-radio.log').write_text(radio.rstrip('\n') + '\n' + (f'[incomplete] {problem}\n' if problem else ''))
    with (vm.receipts/'valve-queue.log').open('w') as log:
        _section(log, f'edge valve_actuation_expectations for {eui}:', 'edge',
                lambda: _edge_expectations(vm, eui),
                lambda state: [f'{row.id} {row.state} queue item {row.queue_id or "-"} {row.phase or "-"} '
                               f'at {row.accepted_at or "-"}'
                               + (' OPEN evidence' if row.open_evidence else '')
                               + (' CLOSED evidence' if row.close_evidence else '') for row in state.rows],
                problems)
        _section(log, f'ChirpStack device_queue_item for {eui}:', 'ChirpStack',
                lambda: _chirpstack_queue(vm, eui),
                lambda state: [_queue_item_text(item, named=False) for item in state.items],
                problems)
    if problems:
        try:
            vm.note(f'valve diagnostics incomplete: {", ".join(problems)}')
        except Exception:
            pass
    return problems


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


OPENED = STREGA[:4] + b'\x75' + STREGA[5:]


def _valve_data(devaddr):
    """Match a downlink for this valve that carries an application port.

    A MAC-only frame and an FPort 0 frame carry network-server commands, not
    the queued command, so they are left alone.
    """
    address = devaddr.to_bytes(4, 'little')

    def matches(packet):
        if len(packet) < 13 or packet[0] >> 5 not in (3, 5) or packet[1:5] != address:
            return False
        port_offset = 8 + (packet[5] & 15)
        return port_offset < len(packet) - 4 and packet[port_offset] != 0

    return matches


def _decode(valve, packet, claim):
    """Decode one downlink against the queued command. Returns (text, missing reason, FCnt)."""
    try:
        command = valve.downlink(packet)
    except ValueError as error:
        return None, f'a downlink that failed verification ({error})', None
    seen = (str(command['fport']), command['payload'].hex().upper())
    text = f'FPort {seen[0]} payload {seen[1]}'
    return text, None if seen == claim else f'{text} is not the queued command FPort {claim[0]} payload {claim[1]}', \
        command['fcnt']


def _frame_counter(recorded, fcnt, queue_id):
    """Whether a delivered frame carries the counter ChirpStack recorded for its queue item.

    ChirpStack writes the downlink frame counter on the item when it builds the
    downlink for it (downlink/data.rs, update_device_queue_item) and advances
    the counter only on an OK ack (downlink/tx_ack.rs), so an item that stayed
    queued after a refusal carries the counter of its next delivery. The wire
    carries the low 16 bits.
    """
    if recorded and fcnt != int(recorded) % 65536:
        return (f"the delivered frame's FCnt {fcnt} is not f_cnt_down {recorded}, which ChirpStack "
                f'recorded for queue item {queue_id}')
    return None


@dataclass
class Receipt:
    """The parts of one valve attempt, logged whatever its outcome."""

    number: int
    kind: str                       # open or resend
    queue_id: str | None = None
    parts: dict = field(default_factory=dict)
    failure: str = ''

    def add(self, name, text, missing=None):
        self.parts[name] = (text, missing)

    def missing(self):
        return [name for name, (_, reason) in self.parts.items() if reason]

    def line(self):
        missing = self.missing()
        verdict = (f'failed: {self.failure}' if self.failure else
                   'received' if not missing else 'missing ' + ', '.join(missing))
        details = '; '.join(f'{name}: {text}' if text else f'{name}: MISSING ({reason})'
                            for name, (text, reason) in self.parts.items())
        return (f'{VALVE} valve open attempt {self.number}/{VALVE_ATTEMPTS} ({self.kind}, '
                f'queue item {self.queue_id or "-"}): {verdict}' + (f' | {details}' if details else ''))


@dataclass(frozen=True)
class Attempt:
    """How one valve attempt ended."""

    number: int
    outcome: str               # received, late or absent
    reason: str                # the delivery part when the command did not arrive in its window
    decision: str              # how the queue item, ChirpStack's downlink and Concentratord's handling were tied together
    holds: bool                # ChirpStack's queue still holds the edge's item
    expectation: Expectation
    frames: int                # Concentratord frames bound in the attempt's window
    arrival: float | None = None   # monotonic time of the first late delivery


def _expectation_evidence(identifier, kind, seconds=None):
    """A query answering 'yes' while one expectation holds its OPEN or CLOSED report, trusted or not."""
    if not re.fullmatch(r'[A-Za-z0-9-]+', identifier):
        raise ValueError('invalid expectation identifier')
    column = 'observed_open_at' if kind == 'open' else 'observed_close_at'
    duration = '' if seconds is None else f' AND commanded_duration_seconds={int(seconds)}'
    return (f"SELECT CASE WHEN {column} IS NOT NULL OR (CASE WHEN json_valid(transport_json) THEN "
            f"json_type(transport_json, '$.untrusted_report.{kind}') END) = 'object' THEN 'yes' ELSE '' END "
            f"FROM valve_actuation_expectations WHERE expectation_id='{identifier}' "
            f"AND upper(device_eui)='{VALVE}'{duration};")


def _await(vm, query, expected, failure):
    """Wait for one gateway query; name what was awaited when it does not arrive."""
    try:
        _wait_history(vm, query, expected)
    except RuntimeError:
        raise RuntimeError(f'{VALVE}: {failure}') from None


def _valve_attempt(vm, air, valve, gui_open, uplink, receipt, *, carried, before):
    """Run one attempt to deliver the queued open; return how it ended, or raise.

    Nothing is sent until the edge names an accepted queue item for this
    attempt and ChirpStack's queue holds that item, as the timed open, next in
    line. Every downlink for the valve that carries an application port is
    decoded, on time or late, and must be that command. The attempt counts,
    as a delivery or as grounds for a retry, only when Concentratord's decision
    is tied to the downlink ChirpStack built for that item; see
    _bind_downlink. Any other outcome fails the case on that attempt.
    """
    try:
        delays = rx_delays(valve)
    except ValueError as error:
        receipt.failure = f'session: {error}'
        raise RuntimeError(f'{VALVE}: {error}') from None
    data = _valve_data(valve.devaddr)
    marker = _mark_attempt(vm)
    if carried is None:
        opened = time.monotonic()
        try:
            gui_open()
        except RuntimeError as error:
            receipt.failure = f'gui: {error}'
            raise RuntimeError(f'open attempt {receipt.number}/{VALVE_ATTEMPTS}: {error}') from None
        try:
            early = air.receive(EARLY_WINDOW_TIMEOUT, data)
        except TimeoutError:
            pass
        else:
            text, mismatch, _ = _decode(valve, early, (str(OPEN_COMMAND[0]), OPEN_COMMAND[1]))
            receipt.failure = 'downlink before receive window'
            receipt.add('downlink', None, f'{text or "an undecodable downlink"} received '
                                           f'{time.monotonic() - opened:.2f} s after the GUI open, before the receive window'
                                           + (f'; {mismatch}' if mismatch else ''))
            raise RuntimeError(f'valve downlink before receive window: {receipt.parts["downlink"][1]}')
    edge_text, edge_missing, row = _valve_edge(_edge_expectations(vm, VALVE), before, carried)
    receipt.queue_id = row.queue_id if row is not None else None
    receipt.add('edge', edge_text, edge_missing)
    if edge_missing:
        raise RuntimeError(f'{VALVE}: {edge_missing}; no uplink was sent')
    claim = _claim(row)
    queued_text, queued_missing, recorded = _valve_queued(_chirpstack_queue(vm, VALVE), row.queue_id, claim,
                                                          fresh=carried is None)
    receipt.add('queued', queued_text, queued_missing)
    if queued_missing:
        raise RuntimeError(f'{VALVE}: {queued_missing}; no uplink was sent')
    sent = time.monotonic()
    try:
        delivered = uplink(STREGA)
    except RuntimeError as error:
        receipt.failure = f'model: {error}'
        receipt.add('model', None, str(error))
        raise
    receipt.add('model', f'WM1302 model delivered={delivered}')
    stamp = air.last_stamp
    packet, late, arrival = None, [], None
    try:
        packet = air.receive(max(0, sent + VALVE_WINDOW - time.monotonic()), data)
    except TimeoutError:
        while True:
            try:
                late.append(air.receive(max(0, sent + VALVE_DRAIN_WINDOW - time.monotonic()), data))
            except TimeoutError:
                break
            arrival = time.monotonic() if arrival is None else arrival

    def checked_frame(copy):
        """Decode one delivered frame against the queued command.

        Returns (what fails, 'payload' or 'counter' or None, the failure text,
        the decoded text, the FCnt).
        """
        text, mismatch, fcnt = _decode(valve, copy, claim)
        if mismatch:
            return 'payload', mismatch, text, fcnt
        counter = _frame_counter(recorded, fcnt, row.queue_id)
        return ('counter' if counter else None), counter, text, fcnt

    if packet is not None:
        delay = time.monotonic() - sent
        fails, reason, text, fcnt = checked_frame(packet)
        if fails:
            receipt.failure = f'downlink: {reason}'
            receipt.add('downlink', None, f'{reason}, received {delay:.2f} s after the uplink')
            raise RuntimeError(f'timed-open downlink {"frame counter" if fails == "counter" else "payload"} '
                               f'mismatch: {reason}, received {delay:.2f} s after the uplink')
        receipt.add('downlink', f'open command {text} FCnt {fcnt} received after {delay:.2f} s')
    else:
        for position, copy in enumerate(late, 1):
            fails, reason, _, _ = checked_frame(copy)
            if reason:
                receipt.failure = f'late downlink: {reason}'
                receipt.add('downlink', None, f'{reason}, drained as late copy {position}')
                raise RuntimeError(f'late open command failed verification: {reason}, drained as late copy {position}')
        reason = (f'open command late after {arrival - sent:.2f} s (drained' +
                  (f' with {len(late) - 1} later copy)' if len(late) > 1 else ')') if late else
                  f'open command absent after {time.monotonic() - sent:.2f} s')
        receipt.add('downlink', None, reason)
    frames = _concentratord_frames(vm, marker)
    frame_text, frame_missing, count = _uplink_frame(frames, stamp)
    receipt.add('frame', frame_text, frame_missing)
    queue_after = _chirpstack_queue(vm, VALVE)
    after_text, after_missing, kept = _valve_queue(queue_after, row.queue_id)
    holds = kept is not None
    binding = _bind_downlink(frames, count, delays, row.queue_id, kept)
    receipt.add('concentratord', binding.text)
    receipt.add('queue after', after_text, after_missing)
    if missing := [(name, reason) for name, (_, reason) in receipt.parts.items() if reason and name != 'downlink']:
        raise RuntimeError(f'{VALVE}: incomplete valve receipt: ' + '; '.join(f'{name}: {reason}' for name, reason in missing))
    if not binding.creditable:
        raise RuntimeError(f'{VALVE}: {binding.text}; the attempt is not credited')
    if (packet is not None or late) and (
            extra := [item for item in queue_after.items if item.id != row.queue_id]):
        raise RuntimeError(f'{VALVE}: the open was delivered, but ChirpStack still holds '
                           f'{"; ".join(_queue_item_text(item) for item in extra)} for the valve, which the '
                           'next uplink would deliver')
    if packet is not None:
        if holds:
            raise RuntimeError(f'{VALVE}: the open was delivered on time, but ChirpStack still holds queue item '
                               f'{row.queue_id}, which the next uplink would deliver again: {binding.text}')
        return Attempt(receipt.number, 'received', '', binding.text, holds, row, len(frames.matched))
    if late and holds:
        # Concentratord transmits only a packet it enqueued and acks it OK, and
        # ChirpStack deletes an unconfirmed item on that ack, so a copy that
        # reached the model while the item is still queued has no consistent
        # record; re-sending it would deliver the same open twice.
        raise RuntimeError(f'{VALVE}: a late copy of the open arrived, but ChirpStack still holds queue item '
                           f'{row.queue_id}: {binding.text}')
    if not late and not holds:
        raise RuntimeError(f'{VALVE}: open command lost: {binding.text}; it never reached the model and '
                           'ChirpStack has consumed it, so its expectation stays pending and a second open '
                           'could not be attributed')
    return Attempt(receipt.number, 'late' if late else 'absent', receipt.parts['downlink'][1],
                   binding.text, holds, row, len(frames.matched), arrival)


def _close_out_earlier(vm, air, valve, uplink, attempt, log):
    """Report an open that arrived late as a run that has ended, before another open is issued.

    With the clock not synchronised, the edge attaches an OPEN report to the one
    pending open that has no report, and to none when two are pending
    (workers.js, attachUntrustedReportTx). An open issued while the earlier one
    is still pending would leave the valve's next OPEN report unattributed. The
    valve did get that open, late: it reports what it did, opened and closed
    once the timed open ended, and the edge holds the earlier expectation
    closed to later reports. Returns that expectation as it then stands.
    """
    row = attempt.expectation
    seconds = row.seconds if row.seconds else OPEN_SECONDS
    marker = _mark_attempt(vm)
    uplink(OPENED)
    stamps = [air.last_stamp]
    _await(vm, _expectation_evidence(row.id, 'open'), 'yes',
           f'the earlier open {row.id} is not reported over: its OPEN report was not attached to it')
    time.sleep(max(0, attempt.arrival + seconds - time.monotonic()))
    uplink(STREGA)
    stamps.append(air.last_stamp)
    _await(vm, _expectation_evidence(row.id, 'closed'), 'yes',
           f'the earlier open {row.id} is not reported over: its CLOSED report was not attached to it')
    _await(vm, VALVE_STATE, 'CLOSED', f'the valve did not report closed after the earlier open {row.id} ended')
    frames = _concentratord_frames(vm, marker)
    texts = []
    for stamp in stamps:
        text, missing, _ = _uplink_frame(frames, stamp)
        if missing:
            raise RuntimeError(f'{VALVE}: incomplete receipt for the reports of the earlier open {row.id}: {missing}')
        texts.append(text)
    log(f'{VALVE} earlier open {row.id}, delivered late on attempt {attempt.number}: reported open, '
        f'closed after {seconds} s | ' + '; '.join(f'report {n}: {text}' for n, text in enumerate(texts, 1)))
    standing = next((r for r in _edge_expectations(vm, VALVE).rows if r.id == row.id), None)
    if standing is None or not (standing.open_evidence and standing.close_evidence):
        raise RuntimeError(f'{VALVE}: the earlier open {row.id} does not hold both reports after they were sent')
    return standing


REPORT_VALUES = ('open_at', 'close_at', 'report')


def _changed(was, now):
    """Name each report value of an expectation that differs between two reads.

    The trusted observed times and the untrusted report are compared as
    stored. The reconciliation state and transport phase are left out: the
    edge may move them on its own schedule once both reports are attached.
    """
    if now is None:
        return 'its row is gone'
    changed = [f'{name}: {getattr(was, name)!r} -> {getattr(now, name)!r}'
               for name in REPORT_VALUES if getattr(was, name) != getattr(now, name)]
    return '; '.join(changed) or 'no difference'


def run_valve(vm, air, session, gui_open, *, log=print):
    """Open the valve from the GUI and check the outcome the edge reports.

    Each attempt issues the one-minute open, or re-sends the queue item
    ChirpStack still holds, then sends one uplink and waits VALVE_WINDOW for
    the open command at the model. On a miss it drains late deliveries until
    VALVE_DRAIN_WINDOW after the uplink, as for a join-accept (#736). At most
    VALVE_ATTEMPTS run. An attempt counts only when its frame and queue state
    were read and Concentratord's decision is tied to the ChirpStack downlink
    of the attempt's own queue item (_bind_downlink); that holds for a delivery
    on time as much as for a miss. A credited fresh open leads to another
    attempt when the command was late or absent; a re-send leads to another
    only when the command reached the model late, and a re-send that missed
    fails the case. A delivered attempt fails while ChirpStack still holds any
    other item for the valve. Every attempt logs a receipt whatever its
    outcome.

    A retry re-sends while ChirpStack's queue holds the edge's item. Once
    ChirpStack has consumed the item and the valve got the command late, the
    valve first reports that run over, so the edge can attribute the next OPEN
    report to the next open; see _close_out_earlier. A command that never
    reached the model after ChirpStack consumed it is a loss and fails the
    case.

    The outcome is bound to the successful attempt: the valve must report
    CLOSED before that attempt's OPEN report and OPEN after it, the
    expectation of that attempt must hold the OPEN report, and every earlier
    expectation must keep its report times and report as they stood before the
    re-issue. The result of a pass on a later attempt names the retries and why
    each earlier attempt failed.
    """
    if VALVE not in session:
        raise RuntimeError('no authenticated valve radio session')
    valve = session[VALVE]
    delivered, counter = [0], (n for n in range(2, 1 << 16))

    def uplink(payload):
        count = air.send(valve.uplink(payload, next(counter), fport=4))
        delivered[0] += count
        return count

    frames_received, failures, earlier = 0, [], []
    carried = None
    for attempt in range(1, VALVE_ATTEMPTS + 1):
        receipt = Receipt(attempt, 'resend' if carried else 'open')
        try:
            air.begin_case()
            before = EdgeState() if carried else _edge_expectations(vm, VALVE)
            if before.error:
                receipt.add('edge before', None, before.error)
                raise RuntimeError(f'{VALVE}: the edge\'s expectations could not be read before the open '
                                   f'({before.error}); no uplink was sent')
            result = _valve_attempt(vm, air, valve, gui_open, uplink, receipt, carried=carried, before=before)
        except Exception as error:
            if not receipt.failure and not receipt.missing():
                receipt.failure = f'{type(error).__name__}: {error}'
            raise
        finally:
            log(receipt.line())
        frames_received += result.frames
        if result.outcome == 'received':
            break
        if carried and result.outcome == 'absent':
            raise RuntimeError(f'{VALVE}: the re-send of queue item {carried} on attempt {attempt} missed: '
                               f'{result.reason}; {result.decision}. A miss on a re-send is no ground for '
                               'another attempt')
        failures.append(f'attempt {attempt}: {result.reason}; {result.decision}')
        if result.holds:
            carried = result.expectation.queue_id
            continue
        earlier.append(_close_out_earlier(vm, air, valve, uplink, result, log))
        carried = None
    else:
        raise RuntimeError(f'{VALVE}: open command not received after {VALVE_ATTEMPTS} attempts')
    row = result.expectation
    report_marker = _mark_attempt(vm)
    prior = sql(vm, VALVE_STATE)
    if prior != 'CLOSED':
        raise RuntimeError(f'{VALVE}: the valve reported {prior or "no state"} before the open report of attempt {attempt}')
    uplink(OPENED)
    _await(vm, VALVE_STATE, 'OPEN', f'the valve did not report open after attempt {attempt}')
    _await(vm, _expectation_evidence(row.id, 'open', row.seconds), 'yes',
           f'the expectation of attempt {attempt} ({row.id}) holds no OPEN report')
    if earlier:
        standing = _edge_expectations(vm, VALVE)
        if standing.error:
            raise RuntimeError(f'{VALVE}: incomplete valve receipt: {standing.error}')
        rows = {standing_row.id: standing_row for standing_row in standing.rows}
        for was in earlier:
            difference = _changed(was, rows.get(was.id))
            if difference != 'no difference':
                raise RuntimeError(f'{VALVE}: the earlier open {was.id} changed while attempt {attempt} '
                                   f'was reported: {difference}')
    report_text, report_missing, _ = _uplink_frame(_concentratord_frames(vm, report_marker), air.last_stamp)
    if report_missing:
        raise RuntimeError(f'{VALVE}: incomplete open report receipt: {report_missing}')
    log(f'{VALVE} valve open report of attempt {attempt} (expectation {row.id}, sent {UPLINK}): {report_text}')
    frames_received += 2 * len(earlier) + 1
    evidence = f'WM1302 model delivered={delivered[0]}, Concentratord frames received={frames_received}'
    if failures:
        evidence += (f'; passed on attempt {attempt}/{VALVE_ATTEMPTS} after {len(failures)} '
                     f'retr{"ies" if len(failures) > 1 else "y"} ({"; ".join(failures)})')
    if earlier:
        evidence += f'; {len(earlier)} late open{"s" if len(earlier) > 1 else ""} reported over before a re-issue'
    return evidence
